import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildEndpoints,
  checkLocalServer,
  JuneServerError,
  localMediaUrl,
  localTlsOptions,
  normalizeCaCert,
  normalizeEndpoint,
  resolveServerSettings,
} from './local-server';

const TEST_CA = readFileSync('src/fixtures/test-ca.crt', 'utf8');

afterEach(() => vi.unstubAllGlobals());

describe('normalizeEndpoint', () => {
  it.each([
    ['', ''],
    ['   ', ''],
    ['192.168.1.75', 'https://192.168.1.75'],
    ['  192.168.1.75  ', 'https://192.168.1.75'],
    ['192.168.1.75:443', 'https://192.168.1.75'],
    ['192.168.1.75:8443', 'https://192.168.1.75:8443'],
    ['https://192.168.1.75/', 'https://192.168.1.75'],
    ['HTTPS://June-Oven.Local', 'https://june-oven.local'],
    ['june-oven.local.', 'https://june-oven.local'],
    ['http://192.168.1.75', 'http://192.168.1.75:8080'],
    ['http://june-oven.local:80', 'http://june-oven.local:80'],
    ['http://192.168.1.75:8080', 'http://192.168.1.75:8080'],
    ['fe80::1', 'https://[fe80::1]'],
    ['[2001:db8:0:0:0:0:0:1]:8443', 'https://[2001:db8::1]:8443'],
    ['http://[::1]', 'http://[::1]:8080'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeEndpoint(input)).toBe(expected);
  });

  it.each([
    'ftp://192.168.1.75',
    'https://user:pass@192.168.1.75',
    'https://192.168.1.75/api',
    'https://192.168.1.75?x=1',
    'https://192.168.1.75:0',
    'https://192.168.1.75:65536',
    'https://192.168.1.75:http',
    'https://[not-ipv6]',
    'https://under_score.local',
    'https://-oven.local',
    'https://',
    'june oven',
  ])('rejects %j', input => {
    expect(() => normalizeEndpoint(input)).toThrow(JuneServerError);
    expect(() => normalizeEndpoint(input)).toThrow(/Invalid oven address/);
  });
});

describe('buildEndpoints', () => {
  it('uses June cloud URLs without an endpoint', () => {
    expect(buildEndpoints('')).toEqual({
      apiUrl: 'https://api.junelife.com',
      messagingUrl: 'https://messaging.junelife.com',
      wsUrl: 'wss://messaging.junelife.com/1/messaging/websocket/companion',
      local: false,
    });
  });

  it('collapses every service onto a local HTTPS endpoint', () => {
    expect(buildEndpoints('192.168.1.75')).toEqual({
      apiUrl: 'https://192.168.1.75',
      messagingUrl: 'https://192.168.1.75',
      wsUrl: 'wss://192.168.1.75/1/messaging/websocket/companion',
      local: true,
    });
  });

  it('uses a plain WebSocket for the HTTP listener', () => {
    expect(buildEndpoints('http://[::1]').wsUrl).toBe('ws://[::1]:8080/1/messaging/websocket/companion');
  });
});

describe('server TLS settings', () => {
  it('accepts a PEM certificate and rejects anything else', () => {
    expect(normalizeCaCert(`\n${TEST_CA}\n`)).toBe(TEST_CA.trim());
    expect(normalizeCaCert('')).toBe('');
    expect(normalizeCaCert(undefined)).toBe('');
    expect(() => normalizeCaCert('not a certificate')).toThrow(/Invalid CA certificate/);
    expect(() => normalizeCaCert('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----')).toThrow(/Invalid CA certificate/);
  });

  it('only customizes TLS for a local HTTPS endpoint', () => {
    expect(localTlsOptions('', TEST_CA, false)).toBeUndefined();
    expect(localTlsOptions('http://192.168.1.75:8080', TEST_CA, false)).toBeUndefined();
    expect(localTlsOptions('https://192.168.1.75', '', true)).toBeUndefined();
    expect(localTlsOptions('https://192.168.1.75', TEST_CA, true)).toEqual({ ca: TEST_CA, rejectUnauthorized: true });
    expect(localTlsOptions('https://192.168.1.75', TEST_CA, false)).toEqual({ rejectUnauthorized: false });
  });

  it('ignores the CA and verification settings for June cloud', () => {
    expect(resolveServerSettings({ caCert: 'not a certificate', verifySsl: false })).toMatchObject({
      endpoint: '',
      caCert: '',
      endpoints: { local: false },
      tls: undefined,
    });
  });

  it('resolves a local endpoint with its CA', () => {
    expect(resolveServerSettings({ endpoint: 'june-oven.local', caCert: TEST_CA })).toMatchObject({
      endpoint: 'https://june-oven.local',
      caCert: TEST_CA.trim(),
      verifySsl: true,
      endpoints: { apiUrl: 'https://june-oven.local', local: true },
      tls: { ca: TEST_CA.trim(), rejectUnauthorized: true },
    });
    expect(() => resolveServerSettings({ endpoint: 'june-oven.local', caCert: 'nope' }))
      .toThrow(expect.objectContaining({ kind: 'invalid-ca' }));
  });
});

describe('localMediaUrl', () => {
  const endpoint = 'https://192.168.1.75';

  it('re-homes a media path and query onto the configured server', () => {
    expect(localMediaUrl(endpoint, 'https://api.junelife.com/media/prod/images/a.jpg?X-Amz-Signature=abc'))
      .toBe('https://192.168.1.75/media/prod/images/a.jpg?X-Amz-Signature=abc');
    expect(localMediaUrl('http://192.168.1.75:8080', 'http://media.example/media/a.jpg'))
      .toBe('http://192.168.1.75:8080/media/a.jpg');
  });

  it('rejects anything outside /media/', () => {
    expect(localMediaUrl(endpoint, 'https://api.junelife.com/admin')).toBeUndefined();
    expect(localMediaUrl(endpoint, 'https://api.junelife.com/media/../admin')).toBeUndefined();
    expect(localMediaUrl(endpoint, 'https://api.junelife.com/media/%2e%2e/admin')).toBeUndefined();
    expect(localMediaUrl(endpoint, 'not a url')).toBeUndefined();
    expect(localMediaUrl(endpoint, 42)).toBeUndefined();
    expect(localMediaUrl('', 'https://api.junelife.com/media/a.jpg')).toBeUndefined();
  });
});

describe('checkLocalServer', () => {
  it('accepts a june-local status response', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ server: 'june-local', version: '1' })));
    vi.stubGlobal('fetch', fetch);

    await expect(checkLocalServer('https://192.168.1.75')).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith('https://192.168.1.75/local/status', expect.anything());
  });

  it.each([
    ['another server', () => new Response(JSON.stringify({ server: 'nginx' }))],
    ['an HTTP error', () => new Response('missing', { status: 404 })],
    ['invalid JSON', () => new Response('<html></html>')],
  ])('reports %s as not a june-local server', async (_label, respond) => {
    vi.stubGlobal('fetch', vi.fn(async () => respond()));

    await expect(checkLocalServer('https://192.168.1.75'))
      .rejects.toMatchObject({ kind: 'not-local-server', message: expect.stringMatching(/not a Project July june-local server/) });
  });

  it('reports an untrusted certificate', async () => {
    const cause = Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed', { cause }); }));

    await expect(checkLocalServer('https://192.168.1.75'))
      .rejects.toMatchObject({ kind: 'certificate', message: expect.stringMatching(/not trusted \(unable to verify the first certificate\)/) });
  });

  it('reports an unreachable server', async () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 192.168.1.75:443'), { code: 'ECONNREFUSED' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed', { cause }); }));

    await expect(checkLocalServer('https://192.168.1.75'))
      .rejects.toMatchObject({ kind: 'cannot-connect', message: expect.stringMatching(/Could not connect to https:\/\/192\.168\.1\.75 \(connect ECONNREFUSED/) });
  });
});
