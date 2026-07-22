import { describe, it, expect } from 'vitest';
import { JuneClient, parseProbeTelemetry, parseCameraFrame } from './june-client';

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
});

describe('startMode', () => {
  it('exists as a method', () => {
    const client = new JuneClient({
      ovenId: 'o', deviceId: 'd', deviceName: 'n', password: 'p', ed25519SeedHex: 'ab',
    }, { debug() {}, warn() {}, error() {} });
    expect(typeof client.startMode).toBe('function');
  });
});
