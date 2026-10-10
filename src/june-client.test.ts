import { readFileSync } from 'node:fs';
import { afterEach, describe, it, expect, vi } from 'vitest';

vi.mock('undici', () => ({
  Agent: class {
    constructor(public readonly options: unknown) {}
  },
  fetch: (input: string, init: unknown) => globalThis.fetch(input, init as RequestInit),
}));

import fixtures from './fixtures/rest-status.json';
import { JuneClient, parseProbeTelemetry, parseCameraFrame, type JuneTelemetry } from './june-client';

const TEST_CA = readFileSync('src/fixtures/test-ca.crt', 'utf8').trim();
const silent = { debug() {}, warn() {}, error() {} };

function ovenClient(extra: Record<string, unknown> = {}): JuneClient {
  return new JuneClient({
    ovenId: 'oven', deviceId: 'd', deviceName: 'n', password: 'p', ed25519SeedHex: 'ab', accessToken: 'access', ...extra,
  }, silent);
}

async function statusTelemetry(body: unknown, extra: Record<string, unknown> = {}) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body)));
  vi.stubGlobal('fetch', fetch);
  const client = ovenClient(extra);
  let telemetry: JuneTelemetry = {};
  client.on('telemetry', update => { telemetry = { ...telemetry, ...update }; });
  await client.fetchStatus();
  return { telemetry, fetch };
}

afterEach(() => vi.unstubAllGlobals());

describe('parseProbeTelemetry', () => {
  it('reads the probe temperature from the probe array (milli-C into Celsius)', () => {
    const out = parseProbeTelemetry({ sensor_data: { cavity: 61100, probe: [{ id: 'left', value: 60000 }] } });
    expect(out).toEqual({ probeC: 60, probePresent: true });
  });

  it('reads the value regardless of the probe id label', () => {
    const out = parseProbeTelemetry({ sensor_data: { probe: [{ id: 'left', value: 18200 }] } });
    expect(out.probeC).toBeCloseTo(18.2);
    expect(out.probePresent).toBe(true);
  });

  it('returns empty object when the probe field is absent', () => {
    expect(parseProbeTelemetry({ sensor_data: { cavity: 150000 } })).toEqual({});
  });
});

describe('parseCameraFrame', () => {
  it('prefers image_url and reports the JPEG content type', () => {
    const out = parseCameraFrame({
      video_id: 'v1', ts: 123,
      image_url: 'https://api.junelife.com/media/img.jpe?X-Amz-x',
      signed_url: 'https://june-api.s3.amazonaws.com/media/img.jpe?X-Amz-y',
      content_type: 'image/jpeg', image_size: 20436,
    });
    expect(out).toEqual({ url: 'https://api.junelife.com/media/img.jpe?X-Amz-x', contentType: 'image/jpeg' });
  });

  it('falls back to the trusted signed_url when image_url is absent', () => {
    const out = parseCameraFrame({ signed_url: 'https://june-api.s3.amazonaws.com/media/img.jpe' });
    expect(out?.url).toBe('https://june-api.s3.amazonaws.com/media/img.jpe');
  });

  it('rejects untrusted or non-HTTPS snapshot URLs', () => {
    expect(parseCameraFrame({ image_url: 'http://api.junelife.com/media/img.jpe' })).toBeNull();
    expect(parseCameraFrame({ image_url: 'https://127.0.0.1/admin' })).toBeNull();
    expect(parseCameraFrame({ signed_url: 'file:///etc/passwd' })).toBeNull();
  });

  it('uses a trusted signed_url when image_url is untrusted', () => {
    const out = parseCameraFrame({
      image_url: 'https://127.0.0.1/admin',
      signed_url: 'https://june-api.s3.amazonaws.com/media/img.jpe',
    });
    expect(out?.url).toBe('https://june-api.s3.amazonaws.com/media/img.jpe');
  });

  it('returns null when no url is present', () => {
    expect(parseCameraFrame({ video_id: 'v', ts: 1 })).toBeNull();
  });

  it('re-homes media URLs onto a local endpoint instead of trusting June hosts', () => {
    const frame = { image_url: 'https://api.junelife.com/media/prod/images/a.jpg?X-Amz-Signature=s', content_type: 'image/jpeg' };
    expect(parseCameraFrame(frame, 'https://192.168.1.75'))
      .toEqual({ url: 'https://192.168.1.75/media/prod/images/a.jpg?X-Amz-Signature=s', contentType: 'image/jpeg' });
    expect(parseCameraFrame({ image_url: 'https://api.junelife.com/admin' }, 'https://192.168.1.75')).toBeNull();
    expect(parseCameraFrame({ image_url: 'https://evil.example/media/a.jpg' }, 'https://192.168.1.75')?.url)
      .toBe('https://192.168.1.75/media/a.jpg');
  });
});

describe('REST status parsing', () => {
  it('parses the June cloud status shape as before', async () => {
    const { telemetry, fetch } = await statusTelemetry(fixtures.cloud_active);

    expect(fetch).toHaveBeenCalledWith('https://messaging.junelife.com/1/messaging/device/oven/status', expect.anything());
    expect(telemetry).toMatchObject({ active: true, connectionState: 'online' });
    expect(telemetry.targetTempC).toBeCloseTo(26.667);
  });

  it('reads the june-local aliases from the oven', async () => {
    const { telemetry, fetch } = await statusTelemetry(fixtures.june_local_active, { endpoint: '192.168.1.75' });

    expect(fetch).toHaveBeenCalledWith('https://192.168.1.75/1/messaging/device/oven/status', expect.anything());
    expect(telemetry).toMatchObject({ active: true, connectionState: 'online' });
    expect(telemetry.targetTempC).toBeCloseTo(26.667);
  });

  it('reports an idle june-local oven as online and idle', async () => {
    const { telemetry } = await statusTelemetry(fixtures.june_local_idle, { endpoint: '192.168.1.75' });

    expect(telemetry).toMatchObject({ active: false, connectionState: 'online', targetTempC: undefined });
  });

  it('ignores the last plan june-local keeps serving after a cook ends', async () => {
    const stale = { ...fixtures.june_local_idle, cook_plan: fixtures.june_local_active.cook_plan, cook_plan_data: fixtures.june_local_active.cook_plan_data };
    const { telemetry } = await statusTelemetry(stale, { endpoint: '192.168.1.75' });

    expect(telemetry).toMatchObject({ active: false, targetTempC: undefined });
  });

  it('still applies a June cloud plan whatever the device state, as before', async () => {
    const idle = { ...fixtures.cloud_active, device_state: { data: { state: 'idle' } } };
    const { telemetry } = await statusTelemetry(idle);

    expect(telemetry.active).toBe(false);
    expect(telemetry.targetTempC).toBeCloseTo(26.667);
  });

  it('prefers ha_connection_state and maps connected/disconnected', async () => {
    expect((await statusTelemetry({ ha_connection_state: 'offline', connection_state: 'connected' })).telemetry.connectionState).toBe('offline');
    expect((await statusTelemetry({ connection_state: 'disconnected' })).telemetry.connectionState).toBe('offline');
    expect((await statusTelemetry({ connection_state: 'connected' })).telemetry.connectionState).toBe('online');
    expect((await statusTelemetry({ connection_state: 'offline' })).telemetry.connectionState).toBe('offline');
  });

  it('sends REST calls to the local server with its CA', async () => {
    const { fetch } = await statusTelemetry(fixtures.june_local_idle, { endpoint: 'june-oven.local', caCert: TEST_CA });
    const init = (fetch.mock.calls[0] as unknown[])[1] as { dispatcher?: { options: unknown } };

    expect(init.dispatcher?.options).toEqual({ connect: { ca: TEST_CA, rejectUnauthorized: true } });
  });

  it('keeps June cloud requests free of TLS overrides', async () => {
    const { fetch } = await statusTelemetry(fixtures.cloud_active, { caCert: TEST_CA, verifySsl: false });
    const init = (fetch.mock.calls[0] as unknown[])[1] as Record<string, unknown>;

    expect('dispatcher' in init).toBe(false);
    expect('tls' in init).toBe(false);
  });
});

describe('camera frames', () => {
  const frame = JSON.stringify({ message_code: 10011, data: { image_url: 'https://api.junelife.com/media/prod/images/a.jpg?sig=1' } });

  it('keeps June cloud camera URLs for a cloud oven', () => {
    const client = ovenClient() as any;
    client.handleMessage(frame);
    expect(client.latestSnapshot?.url).toBe('https://api.junelife.com/media/prod/images/a.jpg?sig=1');
  });

  it('fetches camera frames from the local server for a june-local oven', () => {
    const client = ovenClient({ endpoint: 'http://192.168.1.75' }) as any;
    client.handleMessage(frame);
    expect(client.latestSnapshot?.url).toBe('http://192.168.1.75:8080/media/prod/images/a.jpg?sig=1');
  });
});

describe('startMode', () => {
  it('exists as a method', () => {
    const client = new JuneClient({
      ovenId: 'o', deviceId: 'd', deviceName: 'n', password: 'p', ed25519SeedHex: 'ab',
    }, { debug() {}, warn() {}, error() {} });
    expect(typeof client.startMode).toBe('function');
  });
});
