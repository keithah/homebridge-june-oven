import { describe, expect, it } from 'vitest';
import sodium from 'libsodium-wrappers';
import { buildFrame, fahrenheitToMilliC, milliCToCelsius, milliCToFahrenheit, normalizeOvenConfig, signFrame } from './protocol';

describe('temperature conversion', () => {
  it('matches the June milli-Celsius wire units', () => {
    expect(fahrenheitToMilliC(350)).toBe(176667);
    expect(fahrenheitToMilliC(375)).toBe(190556);
    expect(milliCToFahrenheit(176667)).toBe(350);
    expect(milliCToCelsius(52000)).toBe(52);
  });
});

describe('signed frames', () => {
  it('uses the 72-byte fingerprint plus Ed25519 signature format', async () => {
    await sodium.ready;
    const seed = Buffer.alloc(32, 7).toString('hex');
    const config = normalizeOvenConfig({
      ovenId: 'oven',
      deviceId: 'device',
      deviceName: 'Homebridge',
      password: 'password',
      ed25519SeedHex: seed,
    });
    const frame = buildFrame(config, 11011, {});
    const signed = JSON.parse(await signFrame(config, frame));
    const signature = Buffer.from(signed.signature, 'base64');

    expect(signature).toHaveLength(72);
    expect(Object.keys(signed)).toEqual(['v', 'message_code', 'order', 'time', 'signature', 'device_name', 'device_id', 'data', 'target']);
  });
});
