import { createHash, randomBytes, randomInt } from 'crypto';
import { EventEmitter } from 'events';
import sodium from 'libsodium-wrappers';
import WebSocket from 'ws';
import { fetchWithTimeout } from './http';
import {
  JUNE_API_URL,
  JUNE_APP_VERSION,
  JUNE_CLIENT_ID,
  JUNE_CLIENT_SECRET,
  JUNE_PLATFORM_VERSION,
  JUNE_USER_AGENT,
  JUNE_WS_URL,
  SRP_G,
  SRP_N_HEX,
} from './settings';

const SRP_N = BigInt(`0x${SRP_N_HEX}`);
const PAD_LEN = (SRP_N.toString(2).length + 7) >> 3;
const DAMM = [
  [0, 3, 1, 7, 5, 9, 8, 6, 4, 2],
  [7, 0, 9, 2, 1, 5, 4, 8, 6, 3],
  [4, 2, 0, 6, 8, 7, 1, 3, 5, 9],
  [1, 7, 5, 0, 9, 8, 3, 4, 2, 6],
  [6, 1, 2, 3, 0, 4, 5, 9, 7, 8],
  [3, 6, 7, 4, 2, 0, 9, 5, 8, 1],
  [5, 8, 6, 9, 7, 2, 0, 1, 3, 4],
  [8, 9, 4, 5, 3, 6, 2, 0, 1, 7],
  [9, 4, 3, 8, 6, 1, 7, 2, 0, 5],
  [2, 5, 8, 1, 4, 3, 6, 7, 9, 0],
];

export type PairingState = 'starting' | 'waiting-for-oven' | 'posting-companion' | 'waiting-for-associated' | 'paired' | 'failed';

export interface PairingStatus {
  id: string;
  state: PairingState;
  shownCode?: string;
  error?: string;
  oven?: PairedOvenIdentity;
}

export interface PairedOvenIdentity {
  name: string;
  preheatSwitchName: string;
  readySensor: boolean;
  doneSensor: boolean;
  defaultMode: string;
  defaultTempF: number;
  tempUnit: 'F' | 'C';
  ovenId: string;
  deviceId: string;
  deviceName: string;
  password: string;
  ed25519SeedHex: string;
  accessToken: string;
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}

export function damm(input: string): number {
  let state = 0;
  for (const char of input) {
    state = DAMM[state][Number(char)];
  }
  return state;
}

export function buildShownCode(serverCode: string, twoDigits = randomInt(0, 100)): string {
  const base = `${serverCode}${twoDigits.toString().padStart(2, '0')}`;
  return `${base}${damm(base)}`;
}

export function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) {
      result = (result * b) % modulus;
    }
    e >>= 1n;
    b = (b * b) % modulus;
  }
  return result;
}

function sha1(...chunks: Buffer[]): Buffer {
  const hash = createHash('sha1');
  chunks.forEach(chunk => hash.update(chunk));
  return hash.digest();
}

function pad(value: bigint): Buffer {
  return bigintToBuffer(value, PAD_LEN);
}

function bigintToBuffer(value: bigint, minLength = 0): Buffer {
  if (value === 0n) {
    return Buffer.alloc(Math.max(1, minLength));
  }
  let hex = value.toString(16);
  if (hex.length % 2) {
    hex = `0${hex}`;
  }
  const raw = Buffer.from(hex, 'hex');
  if (raw.length >= minLength) {
    return raw;
  }
  return Buffer.concat([Buffer.alloc(minLength - raw.length), raw]);
}

export class SrpServer {
  public readonly salt: Buffer;
  public readonly B: bigint;
  private readonly verifier: bigint;
  private readonly multiplier: bigint;
  private readonly secretB: bigint;

  constructor(password: string, salt = randomBytes(16), secretB = BigInt(`0x${randomBytes(32).toString('hex')}`) % SRP_N) {
    this.salt = salt;
    const identityHash = sha1(Buffer.from(`user:${password}`, 'utf8'));
    const x = BigInt(`0x${sha1(this.salt, identityHash).toString('hex')}`);
    this.verifier = modPow(SRP_G, x, SRP_N);
    this.multiplier = BigInt(`0x${sha1(pad(SRP_N), pad(SRP_G)).toString('hex')}`);
    this.secretB = secretB;
    this.B = (this.multiplier * this.verifier + modPow(SRP_G, this.secretB, SRP_N)) % SRP_N;
  }

  public secret(A: bigint): Buffer {
    const u = BigInt(`0x${sha1(pad(A), pad(this.B)).toString('hex')}`);
    const S = modPow((A * modPow(this.verifier, u, SRP_N)) % SRP_N, this.secretB, SRP_N);
    return bigintToBuffer(S);
  }

  public saltBase64(): string {
    return this.salt.toString('base64');
  }

  public publicBase64(): string {
    return bigintToBuffer(this.B).toString('base64');
  }
}

interface DeviceRegistration {
  deviceId: string;
  password: string;
  accessToken: string;
  refreshToken: string;
}

export class JunePairingSession extends EventEmitter {
  private readonly status: PairingStatus;
  private ws?: WebSocket;
  private srp?: SrpServer;
  private serverCode = '';
  private registration?: DeviceRegistration;
  private signingSeedHex = '';
  private signingPublic?: Uint8Array;
  private encryptionPublic?: Uint8Array;
  private deadline?: NodeJS.Timeout;

  constructor(private readonly id: string, private readonly deviceName = 'Homebridge June') {
    super();
    this.status = { id, state: 'starting' };
  }

  public currentStatus(): PairingStatus {
    return { ...this.status };
  }

  public async begin(): Promise<PairingStatus> {
    this.deadline = setTimeout(() => this.fail(new Error('Pairing session timed out.')), 5 * 60_000);
    this.deadline.unref?.();
    try {
      await sodium.ready;
      this.registration = await this.registerDevice();
      const signingKey = sodium.crypto_sign_keypair();
      const boxKey = sodium.crypto_box_keypair();
      this.signingSeedHex = Buffer.from(signingKey.privateKey.slice(0, 32)).toString('hex');
      this.signingPublic = signingKey.publicKey;
      this.encryptionPublic = boxKey.publicKey;
      this.openSocket(this.registration.accessToken);
      const pin = await this.requestPairingCode(this.registration.accessToken);
      this.serverCode = pin.code;
      this.status.shownCode = buildShownCode(pin.code);
      this.srp = new SrpServer(this.status.shownCode);
      this.setState('waiting-for-oven');
      return this.currentStatus();
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  public close(): void {
    clearTimeout(this.deadline);
    this.deadline = undefined;
    this.ws?.close();
    this.ws = undefined;
  }

  public destroy(): void {
    this.close();
    this.registration = undefined;
    this.signingSeedHex = '';
    this.signingPublic = undefined;
    this.encryptionPublic = undefined;
    this.srp = undefined;
    this.serverCode = '';
    this.status.shownCode = undefined;
    this.status.oven = undefined;
  }

  private setState(state: PairingState, error?: string): void {
    this.status.state = state;
    this.status.error = error;
    this.emit('status', this.currentStatus());
  }

  private async registerDevice(): Promise<DeviceRegistration> {
    const deviceId = randomBytes(16).toString('hex');
    const password = randomBytes(16).toString('hex');
    const response = await fetchWithTimeout(`${JUNE_API_URL}/2/devices/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': JUNE_USER_AGENT },
      body: JSON.stringify({
        password,
        device_id: deviceId,
        client_id: JUNE_CLIENT_ID,
        client_secret: JUNE_CLIENT_SECRET,
        device_type: 'companion',
        device_name: this.deviceName,
        platform: 'android',
        version: JUNE_APP_VERSION,
        platform_version: JUNE_PLATFORM_VERSION,
      }),
    });
    if (!response.ok) {
      throw new Error(`Device registration failed: ${response.status}`);
    }
    const body = await response.json() as unknown;
    const token = parsePairingToken(body);
    return { deviceId, password, accessToken: token.accessToken, refreshToken: token.refreshToken || '' };
  }

  private async requestPairingCode(accessToken: string): Promise<{ code: string }> {
    const response = await fetchWithTimeout(`${JUNE_API_URL}/2/devices/pairing`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': JUNE_USER_AGENT },
    });
    if (!response.ok) {
      throw new Error(`Pairing code request failed: ${response.status}`);
    }
    const body = await response.json() as unknown;
    if (!body || typeof body !== 'object' ||
        typeof (body as { pin?: { code?: unknown } }).pin?.code !== 'string') {
      throw new Error('Invalid June pairing-code response.');
    }
    return { code: (body as { pin: { code: string } }).pin.code };
  }

  private openSocket(accessToken: string): void {
    this.ws = new WebSocket(JUNE_WS_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': JUNE_USER_AGENT },
      perMessageDeflate: false,
    });
    this.ws.on('message', message => this.handleSocketMessage(message.toString()).catch(error => this.fail(error)));
    this.ws.on('error', error => this.fail(error));
  }

  private async handleSocketMessage(message: string): Promise<void> {
    const parsed = JSON.parse(message) as { message_code?: number; data?: unknown };
    if (parsed.message_code === 10027) {
      this.fail(new Error('PairingSessionInvalidated: make sure the oven is idle, closed, and online, then retry.'));
      return;
    }
    if (parsed.message_code !== 10026 || this.status.state !== 'waiting-for-oven') {
      return;
    }
    const A = findLongBase64(JSON.stringify(parsed.data));
    if (!A) {
      return;
    }
    await this.postCompanion(A);
  }

  private async postCompanion(A64: string): Promise<void> {
    if (!this.registration || !this.srp || !this.signingPublic || !this.encryptionPublic) {
      throw new Error('Pairing session is not initialized.');
    }
    this.setState('posting-companion');
    const A = BigInt(`0x${Buffer.from(A64, 'base64').toString('hex')}`);
    const secret = this.srp.secret(A);
    const key = sodium.crypto_generichash(32, secret);
    const companionInfo = {
      companion_id: this.registration.deviceId,
      companion_name: this.deviceName,
      public_signing_key: Buffer.from(this.signingPublic).toString('base64'),
      public_encryption_key: Buffer.from(this.encryptionPublic).toString('base64'),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      platform: 'Android',
    };
    const nonce = randomBytes(24);
    const encrypted = sodium.crypto_secretbox_easy(Buffer.from(JSON.stringify(companionInfo)), nonce, key);
    const response = await fetchWithTimeout(`${JUNE_API_URL}/2/devices/pairing/${this.serverCode}/companion`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.registration.accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': JUNE_USER_AGENT,
      },
      body: JSON.stringify({
        key_info: {
          salt: this.srp.saltBase64(),
          B: this.srp.publicBase64(),
          companion_info: Buffer.concat([nonce, Buffer.from(encrypted)]).toString('base64'),
        },
      }),
    });
    if (!response.ok) {
      throw new Error(`Posting companion key failed: ${response.status}`);
    }
    this.setState('waiting-for-associated');
    await this.waitForAssociation();
  }

  private async waitForAssociation(): Promise<void> {
    if (!this.registration) {
      throw new Error('Pairing session is not initialized.');
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      const response = await fetchWithTimeout(`${JUNE_API_URL}/2/devices/${this.registration.deviceId}/associated`, {
        headers: { Authorization: `Bearer ${this.registration.accessToken}`, 'User-Agent': JUNE_USER_AGENT },
      });
      if (!response.ok) {
        continue;
      }
      const bodyValue = await response.json() as unknown;
      if (!bodyValue || typeof bodyValue !== 'object' || Array.isArray(bodyValue)) {
        throw new Error('Invalid June association response.');
      }
      const body = bodyValue as { devices?: Array<{ oven_id?: string; name?: string; device_name?: string }> };
      if (body.devices !== undefined && !Array.isArray(body.devices)) {
        throw new Error('Invalid June association response.');
      }
      const oven = body.devices?.find(device => device.oven_id);
      if (!oven?.oven_id) {
        continue;
      }
      this.status.oven = {
        name: oven.name || 'June',
        preheatSwitchName: 'June Preheat',
        readySensor: true,
        doneSensor: true,
        defaultMode: 'bake',
        defaultTempF: 350,
        tempUnit: 'F',
        ovenId: oven.oven_id,
        deviceId: this.registration.deviceId,
        deviceName: this.deviceName,
        password: this.registration.password,
        ed25519SeedHex: this.signingSeedHex,
        accessToken: this.registration.accessToken,
        refreshToken: this.registration.refreshToken,
        clientId: JUNE_CLIENT_ID,
        clientSecret: JUNE_CLIENT_SECRET,
      };
      this.setState('paired');
      this.close();
      return;
    }
    throw new Error('Timed out waiting for the oven to finish pairing.');
  }

  private fail(error: unknown): void {
    this.setState('failed', error instanceof Error ? error.message : String(error));
    this.close();
  }
}

export class PairingManager {
  private readonly sessions = new Map<string, JunePairingSession>();
  private readonly evictionTimers = new Map<string, NodeJS.Timeout>();
  private readonly sessionFactory: (id: string, deviceName?: string) => JunePairingSession;
  private readonly terminalTtlMs: number;
  private readonly maxActiveSessions: number;

  constructor(options: {
    sessionFactory?: (id: string, deviceName?: string) => JunePairingSession;
    terminalTtlMs?: number;
    maxActiveSessions?: number;
  } = {}) {
    this.sessionFactory = options.sessionFactory ?? ((id, deviceName) => new JunePairingSession(id, deviceName));
    this.terminalTtlMs = options.terminalTtlMs ?? 5 * 60_000;
    this.maxActiveSessions = options.maxActiveSessions ?? 1;
  }

  public async begin(deviceName?: string): Promise<PairingStatus> {
    const active = [...this.sessions.values()].filter(session =>
      !isTerminal(session.currentStatus().state)).length;
    if (active >= this.maxActiveSessions) {
      throw new Error('A June pairing session is already active.');
    }
    const id = randomBytes(8).toString('hex');
    const session = this.sessionFactory(id, deviceName);
    this.sessions.set(id, session);
    session.on('status', status => {
      if (isTerminal(status.state)) {
        this.scheduleEviction(id, session);
      }
    });
    try {
      const status = await session.begin();
      if (isTerminal(status.state)) {
        this.scheduleEviction(id, session);
      }
      return status;
    } catch (error) {
      this.remove(id, session);
      throw error;
    }
  }

  public status(id: string): PairingStatus {
    const session = this.sessions.get(id);
    if (!session) {
      return { id, state: 'failed', error: 'Pairing session not found.' };
    }
    return session.currentStatus();
  }

  public cancel(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      this.remove(id, session);
    }
  }

  private scheduleEviction(id: string, session: JunePairingSession): void {
    if (this.evictionTimers.has(id)) {
      return;
    }
    const timer = setTimeout(() => this.remove(id, session), this.terminalTtlMs);
    timer.unref?.();
    this.evictionTimers.set(id, timer);
  }

  private remove(id: string, session: JunePairingSession): void {
    if (this.sessions.get(id) !== session) {
      return;
    }
    const timer = this.evictionTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.evictionTimers.delete(id);
    }
    this.sessions.delete(id);
    session.destroy();
  }
}

function isTerminal(state: PairingState): boolean {
  return state === 'paired' || state === 'failed';
}

function parsePairingToken(value: unknown): { accessToken: string; refreshToken?: string } {
  const token = value && typeof value === 'object' ? (value as { token?: unknown }).token : undefined;
  if (!token || typeof token !== 'object') {
    throw new Error('Invalid June registration response.');
  }
  const accessToken = (token as { access_token?: unknown }).access_token;
  const refreshToken = (token as { refresh_token?: unknown }).refresh_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0 ||
      (refreshToken !== undefined && typeof refreshToken !== 'string')) {
    throw new Error('Invalid June registration response.');
  }
  return { accessToken, refreshToken };
}

function findLongBase64(input: string): string | undefined {
  return input.match(/"([A-Za-z0-9+/=]{300,})"/)?.[1];
}
