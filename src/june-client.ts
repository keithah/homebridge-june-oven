import { EventEmitter } from 'events';
import WebSocket from 'ws';
import {
  JUNE_APP_VERSION,
  JUNE_PLATFORM_VERSION,
  JUNE_USER_AGENT,
} from './settings';
import {
  fahrenheitToMilliC,
  MC_CANCEL,
  MC_KEEPALIVE,
  MC_PREHEAT,
  milliCToCelsius,
  normalizeOvenConfig,
  NormalizedJuneConfig,
  JuneOvenConfig,
  signedFrame,
} from './protocol';
import { fetchWithTimeout } from './http';

export interface JuneTelemetry {
  currentTempC?: number;
  targetTempC?: number;
  active?: boolean;
  ready?: boolean;
  done?: boolean;
  connectionState?: string;
  probeC?: number;
  probePresent?: boolean;
}

export interface JuneSnapshot {
  url: string;
  contentType: string;
}

// A 10011 camera frame carries a pre-signed still-JPEG URL (image_url = CDN,
// signed_url = direct S3), valid ~300 s, pushed ~1/s during a cook.
export function parseCameraFrame(data: any): JuneSnapshot | null {
  const url = typeof data?.image_url === 'string' ? data.image_url
    : typeof data?.signed_url === 'string' ? data.signed_url : undefined;
  if (!url) {
    return null;
  }
  return { url, contentType: typeof data?.content_type === 'string' ? data.content_type : 'image/jpeg' };
}

// Confirmed live (2026-07-08): 10013 sensor_data.probe is an array of
// { id: "left", value: <milli-C> } entries. The June oven has a single food
// probe, so we read the first reporting entry; probe presence is inferred from
// the array having entries (there is no food_present field).
export function parseProbeTelemetry(data: any): Pick<JuneTelemetry, 'probeC' | 'probePresent'> {
  const probes = Array.isArray(data?.sensor_data?.probe) ? data.sensor_data.probe : undefined;
  const out: Pick<JuneTelemetry, 'probeC' | 'probePresent'> = {};
  if (!probes) {
    return out;
  }
  const entry = probes.find((p: any) => p && typeof p.value === 'number');
  if (entry) {
    out.probeC = milliCToCelsius(entry.value);
  }
  out.probePresent = probes.length > 0;
  return out;
}

export interface JuneClientEvents {
  telemetry: [JuneTelemetry];
  token: [{ accessToken: string; refreshToken: string }];
  warning: [string];
}

export declare interface JuneClient {
  on<U extends keyof JuneClientEvents>(event: U, listener: (...args: JuneClientEvents[U]) => void): this;
  emit<U extends keyof JuneClientEvents>(event: U, ...args: JuneClientEvents[U]): boolean;
}

export class JuneClient extends EventEmitter {
  public readonly config: NormalizedJuneConfig;
  private ws?: WebSocket;
  private keepalive?: NodeJS.Timeout;
  private reconnect?: NodeJS.Timeout;
  private statusPoll?: NodeJS.Timeout;
  private connectPromise?: Promise<void>;
  private refreshPromise?: Promise<void>;
  private statusPromise?: Promise<void>;
  private stopped = false;
  private readonly pending = new Map<number, (status: string | null) => void>();
  private lastActive = false;
  private lastCancelled = false;
  private lastTargetTempC?: number;
  private snapshot?: JuneSnapshot;

  public get latestSnapshot(): JuneSnapshot | undefined {
    return this.snapshot;
  }

  constructor(config: JuneOvenConfig, private readonly log: Pick<Console, 'debug' | 'warn' | 'error'> = console) {
    super();
    this.config = normalizeOvenConfig(config);
  }

  public async start(): Promise<void> {
    this.stopped = false;
    await this.refreshToken();
    await this.fetchStatus().catch(error => this.warn(`Initial status failed: ${error.message}`));
    void this.connect().catch(error => this.warn(`WebSocket connection failed: ${error.message}`));
    this.statusPoll = setInterval(() => {
      this.fetchStatus().catch(error => this.warn(`Status poll failed: ${error.message}`));
    }, 60_000);
  }

  public stop(): void {
    this.stopped = true;
    clearInterval(this.keepalive);
    clearInterval(this.statusPoll);
    clearTimeout(this.reconnect);
    this.reconnect = undefined;
    const socket = this.ws;
    this.ws = undefined;
    socket?.close();
    for (const resolve of this.pending.values()) {
      resolve(null);
    }
    this.pending.clear();
  }

  public async preheat(mode = this.config.defaultMode, tempF = this.config.defaultTempF): Promise<string | null> {
    this.lastCancelled = false;
    return this.sendCommand(MC_PREHEAT, { primitive_type: mode, temperature_cavity: fahrenheitToMilliC(tempF) });
  }

  public async startMode(primitiveType: string, tempF: number): Promise<string | null> {
    this.lastCancelled = false;
    return this.sendCommand(MC_PREHEAT, { primitive_type: primitiveType, temperature_cavity: fahrenheitToMilliC(tempF) });
  }

  public async cancel(): Promise<string | null> {
    this.lastCancelled = true;
    return this.sendCommand(MC_CANCEL, { plan_id: 0 });
  }

  public async refreshToken(): Promise<void> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    const refresh = this.performRefreshToken();
    this.refreshPromise = refresh;
    try {
      await refresh;
    } finally {
      if (this.refreshPromise === refresh) {
        this.refreshPromise = undefined;
      }
    }
  }

  private async performRefreshToken(): Promise<void> {
    const response = await fetchWithTimeout(`${this.config.baseUrl}/2/devices/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': JUNE_USER_AGENT },
      body: JSON.stringify({
        password: this.config.password,
        device_id: this.config.deviceId,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        device_type: 'companion',
        device_name: this.config.deviceName,
        platform: 'android',
        version: JUNE_APP_VERSION,
        platform_version: JUNE_PLATFORM_VERSION,
      }),
    });
    if (!response.ok) {
      throw new Error(`Token refresh failed: ${response.status}`);
    }
    const body = await response.json() as unknown;
    const token = parseTokenResponse(body);
    this.config.accessToken = token.accessToken;
    this.config.refreshToken = token.refreshToken || this.config.refreshToken;
    this.emit('token', { accessToken: this.config.accessToken, refreshToken: this.config.refreshToken });
  }

  public async fetchStatus(): Promise<void> {
    if (this.statusPromise) {
      return this.statusPromise;
    }
    const status = this.performFetchStatus(true);
    this.statusPromise = status;
    try {
      await status;
    } finally {
      if (this.statusPromise === status) {
        this.statusPromise = undefined;
      }
    }
  }

  private async performFetchStatus(autoRefresh: boolean): Promise<void> {
    const response = await fetchWithTimeout(`${this.config.messagingUrl}/1/messaging/device/${this.config.ovenId}/status`, {
      headers: { Authorization: `Bearer ${this.config.accessToken}` },
    });
    if (response.status === 401 && autoRefresh) {
      await this.refreshToken();
      return this.performFetchStatus(false);
    }
    if (!response.ok) {
      throw new Error(`Status failed: ${response.status}`);
    }
    const statusValue = await response.json() as unknown;
    if (!statusValue || typeof statusValue !== 'object' || Array.isArray(statusValue)) {
      throw new Error('Invalid June status response.');
    }
    const status = statusValue as {
      connection_state?: string;
      device_state?: { data?: { state?: string } };
      cook_plan?: { data?: { food?: { plan?: { steps?: Array<{ temperature_cavity?: number }> } } } };
    };
    const active = status.device_state?.data?.state === 'active';
    const targetMilliC = status.cook_plan?.data?.food?.plan?.steps?.find(step => typeof step.temperature_cavity === 'number')?.temperature_cavity;
    this.applyTelemetry({
      active,
      targetTempC: typeof targetMilliC === 'number' ? milliCToCelsius(targetMilliC) : undefined,
      connectionState: status.connection_state,
    });
  }

  private connect(): Promise<void> {
    if (this.stopped) {
      return Promise.reject(new Error('June client is stopped.'));
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    const socket = new WebSocket(this.config.wsUrl, {
      headers: { Authorization: `Bearer ${this.config.accessToken}`, 'User-Agent': JUNE_USER_AGENT },
      perMessageDeflate: false,
    });
    this.ws = socket;
    const connecting = new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('close', () => reject(new Error('June messaging socket closed before connecting.')));
      socket.once('error', reject);
    });
    this.connectPromise = connecting;
    socket.on('open', () => {
      if (this.ws !== socket || this.stopped) {
        return;
      }
      clearInterval(this.keepalive);
      this.sendKeepalive().catch(error => this.warn(`Keepalive failed: ${error.message}`));
      this.keepalive = setInterval(() => this.sendKeepalive().catch(error => this.warn(`Keepalive failed: ${error.message}`)), 7000);
    });
    socket.on('message', message => this.handleMessage(message.toString()));
    socket.on('close', () => {
      if (this.ws === socket) {
        this.ws = undefined;
        this.scheduleReconnect();
      }
    });
    socket.on('error', error => {
      this.warn(`WebSocket error: ${error.message}`);
      if (this.ws === socket && socket.readyState !== WebSocket.OPEN) {
        this.ws = undefined;
        socket.close();
        this.scheduleReconnect();
      }
    });
    void connecting.finally(() => {
      if (this.connectPromise === connecting) {
        this.connectPromise = undefined;
      }
    }).catch(() => undefined);
    return connecting;
  }

  private scheduleReconnect(): void {
    clearInterval(this.keepalive);
    if (this.stopped) {
      return;
    }
    if (this.reconnect) {
      return;
    }
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined;
      void this.connect().catch(error => this.warn(`WebSocket reconnect failed: ${error.message}`));
    }, 10_000);
  }

  private async sendKeepalive(): Promise<void> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return;
    }
    const { frame } = await signedFrame(this.config, MC_KEEPALIVE, {});
    this.ws.send(frame);
  }

  private async sendCommand(code: number, data: Record<string, unknown>): Promise<string | null> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      await this.connect();
    }
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw new Error('June messaging socket is not connected.');
    }
    const { frame, order } = await signedFrame(this.config, code, data);
    const ack = new Promise<string | null>(resolve => {
      this.pending.set(order, resolve);
      setTimeout(() => {
        if (this.pending.delete(order)) {
          resolve(null);
        }
      }, 6000);
    });
    this.ws.send(frame);
    return ack;
  }

  private handleMessage(message: string): void {
    let frame: { message_code?: number; data?: any };
    try {
      frame = JSON.parse(message);
    } catch {
      return;
    }
    const data = frame.data || {};
    if (frame.message_code === 10020 && typeof data.request_order === 'number') {
      const resolve = this.pending.get(data.request_order);
      if (resolve) {
        this.pending.delete(data.request_order);
        resolve(typeof data.status === 'string' ? data.status : null);
      }
      return;
    }
    if (frame.message_code === 10013) {
      this.applyTelemetry({
        currentTempC: typeof data.sensor_data?.cavity === 'number' ? milliCToCelsius(data.sensor_data.cavity) : undefined,
        ready: typeof data.cook_state_data?.progress === 'number' && data.cook_state_data.progress >= 0.995,
        ...parseProbeTelemetry(data),
      });
      return;
    }
    if (frame.message_code === 10011) {
      const snapshot = parseCameraFrame(data);
      if (snapshot) {
        this.snapshot = snapshot;
      }
      return;
    }
    if (frame.message_code === 10015 || frame.message_code === 10016) {
      const target = data.temperature_cavity ?? data.food?.plan?.steps?.find?.((step: { temperature_cavity?: number }) => typeof step.temperature_cavity === 'number')?.temperature_cavity;
      this.applyTelemetry({ targetTempC: typeof target === 'number' ? milliCToCelsius(target) : undefined });
      return;
    }
    if (frame.message_code === 10017 && data.type === 'cancelled') {
      this.lastCancelled = true;
      return;
    }
    if (frame.message_code === 10018) {
      this.applyTelemetry({ active: data.state === 'active' });
    }
  }

  private applyTelemetry(update: JuneTelemetry): void {
    if (typeof update.targetTempC === 'number') {
      this.lastTargetTempC = update.targetTempC;
    }
    if (typeof update.active === 'boolean') {
      update.done = this.lastActive && !update.active && !this.lastCancelled;
      this.lastActive = update.active;
      if (update.active) {
        this.lastCancelled = false;
      }
    }
    if (typeof update.ready === 'boolean' && update.ready && typeof update.currentTempC === 'number' && typeof this.lastTargetTempC === 'number') {
      update.ready = update.currentTempC + 1 >= this.lastTargetTempC;
    }
    this.emit('telemetry', update);
  }

  private warn(message: string): void {
    this.log.warn(message);
    this.emit('warning', message);
  }
}

function parseTokenResponse(value: unknown): { accessToken: string; refreshToken?: string } {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid June token response.');
  }
  const token = (value as { token?: unknown }).token;
  if (!token || typeof token !== 'object') {
    throw new Error('Invalid June token response.');
  }
  const accessToken = (token as { access_token?: unknown }).access_token;
  const refreshToken = (token as { refresh_token?: unknown }).refresh_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0 ||
      (refreshToken !== undefined && typeof refreshToken !== 'string')) {
    throw new Error('Invalid June token response.');
  }
  return { accessToken, refreshToken };
}
