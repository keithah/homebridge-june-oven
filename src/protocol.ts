import sodium from 'libsodium-wrappers';
import {
  JUNE_API_URL,
  JUNE_CLIENT_ID,
  JUNE_CLIENT_SECRET,
  JUNE_MESSAGING_URL,
  JUNE_WS_URL,
} from './settings';

export const MC_PREHEAT = 11002;
export const MC_TEMP = 11005;
export const MC_CANCEL = 11004;
export const MC_KEEPALIVE = 11011;

export interface JuneModeConfig {
  label: string;
  primitiveType: string;
  tempF: number;
}

export interface JuneModeInput {
  primitiveType: string;
  label?: string;
  tempF?: number;
}

export interface JuneDoorbellConfig {
  enabled: boolean;
  name: string;
  triggers: { done: boolean; ready: boolean };
}

export interface JuneProbeSensorsConfig {
  enabled: boolean;
  name: string;
}

export interface JuneCameraConfig {
  enabled: boolean;
  name: string;
  ffmpegPath: string;
}

export interface JuneOvenConfig {
  name?: string;
  preheatSwitchName?: string;
  readySensor?: boolean;
  doneSensor?: boolean;
  defaultMode?: string;
  defaultTempF?: number;
  tempUnit?: 'F' | 'C';
  doorbell?: Partial<Omit<JuneDoorbellConfig, 'triggers'>> & { triggers?: Partial<JuneDoorbellConfig['triggers']> };
  modes?: JuneModeInput[];
  probeSensors?: Partial<JuneProbeSensorsConfig>;
  camera?: Partial<JuneCameraConfig>;
  ovenId: string;
  deviceId: string;
  deviceName: string;
  password: string;
  ed25519SeedHex: string;
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  baseUrl?: string;
  messagingUrl?: string;
  wsUrl?: string;
}

export interface NormalizedJuneConfig extends JuneOvenConfig {
  name: string;
  defaultMode: string;
  defaultTempF: number;
  tempUnit: 'F' | 'C';
  doorbell: JuneDoorbellConfig;
  modes: JuneModeConfig[];
  probeSensors: JuneProbeSensorsConfig;
  camera: JuneCameraConfig;
  accessToken: string;
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  messagingUrl: string;
  wsUrl: string;
}

export interface JuneFrame {
  v: 2;
  message_code: number;
  order: number;
  time: number;
  signature: string;
  device_name: string;
  device_id: string;
  data: Record<string, unknown>;
  target: { id: string };
}

let lastOrder = 0;

export function normalizeOvenConfig(config: JuneOvenConfig): NormalizedJuneConfig {
  return {
    ...config,
    name: config.name || 'June',
    defaultMode: config.defaultMode || 'bake',
    defaultTempF: config.defaultTempF ?? 350,
    tempUnit: config.tempUnit || 'F',
    accessToken: config.accessToken || '',
    refreshToken: config.refreshToken || '',
    clientId: config.clientId || JUNE_CLIENT_ID,
    clientSecret: config.clientSecret || JUNE_CLIENT_SECRET,
    baseUrl: config.baseUrl || JUNE_API_URL,
    messagingUrl: config.messagingUrl || JUNE_MESSAGING_URL,
    wsUrl: config.wsUrl || JUNE_WS_URL,
    doorbell: {
      enabled: config.doorbell?.enabled ?? false,
      name: config.doorbell?.name || 'June Doorbell',
      triggers: {
        done: config.doorbell?.triggers?.done ?? false,
        ready: config.doorbell?.triggers?.ready ?? false,
      },
    },
    modes: (config.modes ?? [])
      .filter(m => m && typeof m.primitiveType === 'string' && m.primitiveType.length > 0)
      .map(m => ({ label: m.label || m.primitiveType, primitiveType: m.primitiveType, tempF: m.tempF ?? 350 })),
    probeSensors: {
      enabled: config.probeSensors?.enabled ?? false,
      name: config.probeSensors?.name || 'Food Probe',
    },
    camera: {
      enabled: config.camera?.enabled ?? false,
      name: config.camera?.name || 'June Camera',
      ffmpegPath: config.camera?.ffmpegPath || 'ffmpeg',
    },
  };
}

export function fahrenheitToMilliC(fahrenheit: number): number {
  return Math.round((fahrenheit - 32) * 5 / 9 * 1000);
}

export function celsiusToMilliC(celsius: number): number {
  return Math.round(celsius * 1000);
}

export function milliCToFahrenheit(milliC: number): number {
  return Math.round(milliC / 1000 * 9 / 5 + 32);
}

export function milliCToCelsius(milliC: number): number {
  return milliC / 1000;
}

export function nextOrder(now = Date.now()): number {
  let order = now & 0x7fffffff;
  if (order <= lastOrder) {
    order = lastOrder + 1;
  }
  lastOrder = order;
  return order;
}

export function buildFrame(config: NormalizedJuneConfig, messageCode: number, data: Record<string, unknown>): JuneFrame {
  return {
    v: 2,
    message_code: messageCode,
    order: nextOrder(),
    time: Date.now(),
    signature: '',
    device_name: config.deviceName,
    device_id: config.deviceId,
    data,
    target: { id: config.ovenId },
  };
}

export function serializeFrame(frame: JuneFrame): string {
  return JSON.stringify(frame);
}

export async function signFrame(config: NormalizedJuneConfig, frame: JuneFrame): Promise<string> {
  await sodium.ready;
  frame.signature = '';
  const payload = Buffer.from(serializeFrame(frame), 'utf8');
  const keyPair = sodium.crypto_sign_seed_keypair(Buffer.from(config.ed25519SeedHex, 'hex'));
  const fingerprint = sodium.crypto_generichash(8, keyPair.publicKey);
  const signature = sodium.crypto_sign_detached(payload, keyPair.privateKey);
  frame.signature = Buffer.concat([Buffer.from(fingerprint), Buffer.from(signature)]).toString('base64');
  return serializeFrame(frame);
}

export async function signedFrame(config: NormalizedJuneConfig, messageCode: number, data: Record<string, unknown>): Promise<{ frame: string; order: number }> {
  const unsigned = buildFrame(config, messageCode, data);
  const order = unsigned.order;
  return { frame: await signFrame(config, unsigned), order };
}
