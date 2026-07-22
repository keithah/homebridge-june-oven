import { milliCToCelsius } from './protocol';

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

export function parseCameraFrame(data: unknown): JuneSnapshot | null {
  const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const url = [record.image_url, record.signed_url].find(isTrustedCameraUrl);
  if (!url) {
    return null;
  }
  return { url, contentType: typeof record.content_type === 'string' ? record.content_type : 'image/jpeg' };
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
