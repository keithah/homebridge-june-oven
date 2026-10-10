import { milliCToCelsius } from './protocol';
import { localMediaUrl } from './local-server';

export interface JuneSnapshot {
  url: string;
  contentType: string;
}

export interface ProbeTelemetry {
  probeC?: number;
  probePresent?: boolean;
}

const CAMERA_HOSTS = new Set(['api.junelife.com', 'june-api.s3.amazonaws.com']);

function isTrustedCameraUrl(candidate: unknown): candidate is string {
  if (typeof candidate !== 'string') {
    return false;
  }
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' && CAMERA_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Read a 10011 camera frame. With a local endpoint, the frame's URL is
 * re-homed onto that server; otherwise only trusted June HTTPS hosts pass.
 */
export function parseCameraFrame(data: unknown, localEndpoint = ''): JuneSnapshot | null {
  const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const url = localEndpoint
    ? [record.image_url, record.signed_url].map(candidate => localMediaUrl(localEndpoint, candidate)).find(Boolean)
    : [record.image_url, record.signed_url].find(isTrustedCameraUrl);
  if (!url) {
    return null;
  }
  return { url, contentType: typeof record.content_type === 'string' ? record.content_type : 'image/jpeg' };
}

export interface JuneStatus {
  connectionState?: string;
  active: boolean;
  targetMilliC?: number;
}

/** Map a connection state to online (true), offline (false), or unknown. */
export function connectionOnline(value: unknown): boolean | undefined {
  if (value === 'online' || value === 'connected') {
    return true;
  }
  if (value === 'offline' || value === 'disconnected') {
    return false;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function unwrap(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  return asRecord(record?.data) ?? record;
}

function planTargetMilliC(plan: Record<string, unknown> | undefined): number | undefined {
  const steps = asRecord(asRecord(plan?.food)?.plan)?.steps;
  if (!Array.isArray(steps)) {
    return undefined;
  }
  const target = steps.map(step => asRecord(step)?.temperature_cavity).find(value => typeof value === 'number');
  return typeof target === 'number' ? target : undefined;
}

/**
 * Parse `/1/messaging/device/{id}/status`.
 *
 * June's cloud sends `connection_state` "online"/"offline" with
 * `{"data": ...}`-wrapped `device_state` and `cook_plan`. june-local adds
 * `ha_connection_state` "online"/"offline" beside `connection_state`
 * "connected"/"disconnected", and serves bare `device_state`/`cook_plan` beside
 * wrapped `device_state_data`/`cook_plan_data` copies. The `ha_` and `_data`
 * fields win; any field may be wrapped or bare.
 */
export function parseJuneStatus(status: Record<string, unknown>): JuneStatus {
  const online = connectionOnline(status.ha_connection_state) ?? connectionOnline(status.connection_state);
  let state: unknown;
  for (const key of ['device_state_data', 'device_state']) {
    state = unwrap(status[key])?.state;
    if (typeof state === 'string' && state) {
      break;
    }
  }
  return {
    connectionState: online === undefined ? status.connection_state as string | undefined : online ? 'online' : 'offline',
    active: state === 'active',
    targetMilliC: planTargetMilliC(unwrap(status.cook_plan_data)) ?? planTargetMilliC(unwrap(status.cook_plan)),
  };
}

export function parseProbeTelemetry(data: unknown): ProbeTelemetry {
  const record = data && typeof data === 'object' ? data as { sensor_data?: unknown } : {};
  const sensorData = record.sensor_data && typeof record.sensor_data === 'object'
    ? record.sensor_data as { probe?: unknown }
    : {};
  const probes = Array.isArray(sensorData.probe) ? sensorData.probe : undefined;
  const out: ProbeTelemetry = {};
  if (!probes) {
    return out;
  }
  const entry = probes.find((p: unknown): p is { value: number } =>
    Boolean(p) && typeof p === 'object' && typeof (p as { value?: unknown }).value === 'number');
  if (entry) {
    out.probeC = milliCToCelsius(entry.value);
  }
  out.probePresent = probes.length > 0;
  return out;
}
