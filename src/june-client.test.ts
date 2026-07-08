import { describe, it, expect } from 'vitest';
import { JuneClient, parseProbeTelemetry, parseCameraFrame } from './june-client';

describe('parseProbeTelemetry', () => {
  it('reads left/right probe milli-C into Celsius', () => {
    const out = parseProbeTelemetry({ sensor_data: { left_probe: 60000, right_probe: 62500 }, food_present: true });
    expect(out).toEqual({ probeLeftC: 60, probeRightC: 62.5, probePresent: true });
  });

  it('falls back to single probe_temperature as the left probe', () => {
    const out = parseProbeTelemetry({ sensor_data: { probe_temperature: 71000 } });
    expect(out.probeLeftC).toBe(71);
    expect(out.probeRightC).toBeUndefined();
  });

  it('returns empty object when no probe data present', () => {
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

  it('falls back to signed_url when image_url is absent', () => {
    const out = parseCameraFrame({ signed_url: 'https://s3/img.jpe' });
    expect(out?.url).toBe('https://s3/img.jpe');
  });

  it('returns null when no url is present', () => {
    expect(parseCameraFrame({ video_id: 'v', ts: 1 })).toBeNull();
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
