import { describe, expect, it } from 'vitest';
import sodium from 'libsodium-wrappers';
import { buildFrame, fahrenheitToMilliC, milliCToCelsius, milliCToFahrenheit, normalizeOvenConfig, parseJuneTokenResponse, signFrame } from './protocol';

describe('temperature conversion', () => {
  it('matches the June milli-Celsius wire units', () => {
    expect(fahrenheitToMilliC(350)).toBe(176667);
    expect(fahrenheitToMilliC(375)).toBe(190556);
    expect(milliCToFahrenheit(176667)).toBe(350);
    expect(milliCToCelsius(52000)).toBe(52);
  });
});

describe('normalizeOvenConfig new options', () => {
  const base = {
    ovenId: 'o', deviceId: 'd', deviceName: 'n', password: 'p', ed25519SeedHex: 'ab',
  };

  it('defaults doorbell to disabled with all triggers off', () => {
    const n = normalizeOvenConfig(base);
    expect(n.doorbell).toEqual({
      enabled: false,
      name: 'June Doorbell',
      triggers: { done: false, ready: false },
    });
  });

  it('defaults modes to an empty array and probeSensors to disabled', () => {
    const n = normalizeOvenConfig(base);
    expect(n.modes).toEqual([]);
    expect(n.probeSensors).toEqual({ enabled: false, name: 'Food Probe' });
  });

  it('passes through configured modes and supported doorbell triggers', () => {
    const n = normalizeOvenConfig({
      ...base,
      doorbell: { enabled: true, triggers: { done: true, doorOpen: true } as never },
      modes: [{ label: 'Broil', primitiveType: 'broil', tempF: 500 }],
      probeSensors: { enabled: true, name: 'Roast Probe' },
    });
    expect(n.doorbell.enabled).toBe(true);
    expect(n.doorbell.triggers).toEqual({ done: true, ready: false });
    expect('doorOpen' in n.doorbell.triggers).toBe(false);
    expect(n.modes).toEqual([{ label: 'Broil', primitiveType: 'broil', tempF: 500 }]);
    expect(n.probeSensors).toEqual({ enabled: true, name: 'Roast Probe' });
  });

  it('defaults camera to disabled with a default ffmpeg path', () => {
    const n = normalizeOvenConfig(base);
    expect(n.camera).toEqual({ enabled: false, name: 'June Camera', ffmpegPath: 'ffmpeg' });
  });

  it('drops mode entries missing a primitiveType and defaults label/temp', () => {
    const n = normalizeOvenConfig({
      ...base,
      modes: [
        { primitiveType: 'toast' },
        { label: '', primitiveType: '' },
        { label: 'Broken' } as never,
      ],
    });
    expect(n.modes).toEqual([{ label: 'toast', primitiveType: 'toast', tempF: 350 }]);
  });

  it('normalizes invalid mode temperatures to 350°F', () => {
    const n = normalizeOvenConfig({
      ...base,
      modes: [
        { primitiveType: 'low', tempF: 99 },
        { primitiveType: 'high', tempF: 551 },
        { primitiveType: 'infinite', tempF: Number.POSITIVE_INFINITY },
        { primitiveType: 'nan', tempF: Number.NaN },
        { primitiveType: 'minimum', tempF: 100 },
        { primitiveType: 'maximum', tempF: 550 },
      ],
    });

    expect(n.modes.map(mode => mode.tempF)).toEqual([350, 350, 350, 350, 100, 550]);
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

describe('June token decoding', () => {
  it('accepts a valid access token when refresh_token is null', () => {
    expect(parseJuneTokenResponse({ token: { access_token: 'access', refresh_token: null } }))
      .toEqual({ accessToken: 'access', refreshToken: undefined });
  });
});
