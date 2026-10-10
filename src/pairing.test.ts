import { EventEmitter } from 'events';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const sockets = vi.hoisted(() => [] as Array<{ url: string; options: Record<string, unknown> }>);
vi.mock('ws', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class FakeWebSocket extends Emitter {
    constructor(public readonly url: string, public readonly options: Record<string, unknown>) {
      super();
      sockets.push(this);
    }

    close(): void {
      this.emit('close');
    }
  }
  return { default: FakeWebSocket };
});
vi.mock('undici', () => ({
  Agent: class {
    constructor(public readonly options: unknown) {}
  },
  fetch: (input: string, init: unknown) => globalThis.fetch(input, init as RequestInit),
}));

import { resolveServerSettings } from './local-server';
import { buildShownCode, calculateAssociationDelay, damm, JunePairingSession, modPow, PairingManager, SrpServer } from './pairing';

const TEST_CA = readFileSync('src/fixtures/test-ca.crt', 'utf8').trim();

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sockets.length = 0;
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function pairingServer(status: () => Response = () => json({ server: 'june-local' })) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith('/local/status')) {
      return status();
    }
    if (url.endsWith('/2/devices/register')) {
      return json({ token: { access_token: 'access', refresh_token: 'refresh' } });
    }
    if (url.endsWith('/2/devices/pairing')) {
      return json({ pin: { code: '46605' } });
    }
    return new Response(null, { status: 404 });
  });
}

describe('Damm PIN construction', () => {
  it('appends a check digit that validates to zero', () => {
    const shown = buildShownCode('46605', 3);

    expect(shown).toMatch(/^\d{8}$/);
    expect(shown).toBe('46605037');
    expect(damm(shown)).toBe(0);
  });
});

describe('pairing retry scheduling', () => {
  it('uses bounded jittered association delays', () => {
    expect(calculateAssociationDelay(0, () => 0)).toBe(2_250);
    expect(calculateAssociationDelay(2, () => 0.5)).toBe(12_000);
    expect(calculateAssociationDelay(20, () => 1)).toBe(30_000);
  });
});

describe('SRP server', () => {
  it('produces deterministic B and shared secret for fixed inputs', () => {
    const server = new SrpServer('46605037', Buffer.alloc(16, 1), 5n);
    const A = modPow(19n, 7n, BigInt(`0x${'f'.repeat(16)}`));
    const secret = server.secret(A);

    expect(server.saltBase64()).toBe('AQEBAQEBAQEBAQEBAQEBAQ==');
    expect(server.publicBase64().length).toBeGreaterThan(1000);
    expect(secret.length).toBeGreaterThan(0);
  });
});

describe('PairingManager lifecycle', () => {
  it('destroys a session whose startup fails', async () => {
    const session = fakeSession({ id: 'session', state: 'starting' });
    session.begin.mockRejectedValueOnce(new Error('pairing failed'));
    const manager = new PairingManager({ sessionFactory: () => session as never });

    await expect(manager.begin()).rejects.toThrow('pairing failed');

    expect(session.destroy).toHaveBeenCalledOnce();
  });

  it('evicts and destroys terminal sessions after the configured lifetime', async () => {
    vi.useFakeTimers();
    const session = fakeSession({ id: 'session', state: 'paired' });
    const manager = new PairingManager({
      sessionFactory: id => {
        session.status.id = id;
        return session as never;
      },
      terminalTtlMs: 100,
    });
    const status = await manager.begin();

    await vi.advanceTimersByTimeAsync(100);

    expect(manager.status(status.id)).toMatchObject({ state: 'failed', error: 'Pairing session not found.' });
    expect(session.destroy).toHaveBeenCalledOnce();
  });

  it('supersedes a lingering active session so pairing can be retried', async () => {
    const first = fakeSession({ id: 'first', state: 'waiting-for-oven' });
    const second = fakeSession({ id: 'second', state: 'waiting-for-oven' });
    const created = [first, second];
    const manager = new PairingManager({
      sessionFactory: () => created.shift() as never,
      maxActiveSessions: 1,
    });
    await manager.begin();

    await expect(manager.begin()).resolves.toMatchObject({ state: 'waiting-for-oven' });
    expect(first.destroy).toHaveBeenCalledOnce();
    expect(second.destroy).not.toHaveBeenCalled();
  });

  it('ignores terminal events emitted after a session is canceled', async () => {
    const session = fakeSession({ id: 'session', state: 'waiting-for-oven' });
    const manager = new PairingManager({
      sessionFactory: id => {
        session.status.id = id;
        return session as never;
      },
      terminalTtlMs: 100,
    });
    const status = await manager.begin();

    manager.cancel(status.id);
    session.emit('status', { ...status, state: 'failed' });

    expect((manager as any).evictionTimers.size).toBe(0);
  });
});

describe('JunePairingSession startup lifecycle', () => {
  it('gives association polling a fresh session deadline', async () => {
    vi.useFakeTimers();
    const session = new JunePairingSession('session') as any;
    session.registration = { deviceId: 'device', accessToken: 'access', password: 'password' };
    session.deadline = setTimeout(() => session.fail(new Error('Pairing session timed out.')), 100);

    const waiting = session.waitForAssociation();
    await vi.advanceTimersByTimeAsync(100);

    expect(session.currentStatus().state).not.toBe('failed');
    session.destroy();
    const rejected = expect(waiting).rejects.toThrow('Pairing session was superseded.');
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
  });

  it('fails association polling immediately on permanent HTTP errors', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })));
    const session = new JunePairingSession('session') as any;
    session.registration = { deviceId: 'device', accessToken: 'access', password: 'password' };
    session.deadline = setTimeout(() => undefined, 300_000);

    const waiting = session.waitForAssociation();
    const rejected = expect(waiting).rejects.toThrow('June association request failed: 401');
    await vi.advanceTimersByTimeAsync(3_000);

    await rejected;
    session.destroy();
  });

  it('does not open a socket when destroyed during device registration', async () => {
    let finishRegistration!: (registration: unknown) => void;
    const registration = new Promise(resolve => { finishRegistration = resolve; });
    const session = new JunePairingSession('session') as any;
    vi.spyOn(session, 'registerDevice').mockReturnValue(registration);
    const openSocket = vi.spyOn(session, 'openSocket').mockImplementation(() => undefined);

    const beginning = session.begin();
    await vi.waitFor(() => expect(session.registerDevice).toHaveBeenCalledOnce());
    session.destroy();
    finishRegistration({ deviceId: 'device', password: 'password', accessToken: 'access', refreshToken: 'refresh' });

    await expect(beginning).rejects.toThrow('Pairing session was superseded.');
    expect(openSocket).not.toHaveBeenCalled();
  });

  it('does not report success when destroyed during pairing-code request', async () => {
    let finishCodeRequest!: (pin: unknown) => void;
    const codeRequest = new Promise(resolve => { finishCodeRequest = resolve; });
    const session = new JunePairingSession('session') as any;
    vi.spyOn(session, 'registerDevice').mockResolvedValue({
      deviceId: 'device', password: 'password', accessToken: 'access', refreshToken: 'refresh',
    });
    vi.spyOn(session, 'openSocket').mockImplementation(() => undefined);
    vi.spyOn(session, 'requestPairingCode').mockReturnValue(codeRequest);

    const beginning = session.begin();
    await vi.waitFor(() => expect(session.requestPairingCode).toHaveBeenCalledOnce());
    session.destroy();
    finishCodeRequest({ code: '46605' });

    await expect(beginning).rejects.toThrow('Pairing session was superseded.');
  });
});

describe('pairing through a server', () => {
  it('keeps pairing through June cloud when no endpoint is given', async () => {
    const fetch = pairingServer();
    vi.stubGlobal('fetch', fetch);
    const manager = new PairingManager();

    const status = await manager.begin('Homebridge June');

    expect(status.state).toBe('waiting-for-oven');
    expect(fetch.mock.calls.map(call => call[0])).toEqual([
      'https://api.junelife.com/2/devices/register',
      'https://api.junelife.com/2/devices/pairing',
    ]);
    expect(fetch.mock.calls.every(call => !('dispatcher' in (call[1] ?? {})))).toBe(true);
    expect(sockets[0].url).toBe('wss://messaging.junelife.com/1/messaging/websocket/companion');
    expect(Object.keys(sockets[0].options).sort()).toEqual(['headers', 'perMessageDeflate']);
    manager.cancel(status.id);
  });

  it('checks a june-local server, then pairs through it with its CA', async () => {
    const fetch = pairingServer();
    vi.stubGlobal('fetch', fetch);
    const manager = new PairingManager();

    const status = await manager.begin('Homebridge June', { endpoint: 'june-oven.local', caCert: TEST_CA });

    expect(status.state).toBe('waiting-for-oven');
    expect(fetch.mock.calls.map(call => call[0])).toEqual([
      'https://june-oven.local/local/status',
      'https://june-oven.local/2/devices/register',
      'https://june-oven.local/2/devices/pairing',
    ]);
    for (const call of fetch.mock.calls) {
      expect((call[1] as unknown as { dispatcher: { options: unknown } }).dispatcher.options)
        .toEqual({ connect: { ca: TEST_CA, rejectUnauthorized: true } });
    }
    expect(sockets[0].url).toBe('wss://june-oven.local/1/messaging/websocket/companion');
    expect(sockets[0].options).toMatchObject({ ca: TEST_CA, rejectUnauthorized: true, perMessageDeflate: false });
    manager.cancel(status.id);
  });

  it('pairs through the plain HTTP listener without TLS settings', async () => {
    const fetch = pairingServer();
    vi.stubGlobal('fetch', fetch);
    const manager = new PairingManager();

    const status = await manager.begin('Homebridge June', { endpoint: 'http://192.168.1.75', caCert: TEST_CA, verifySsl: false });

    expect(fetch.mock.calls[0][0]).toBe('http://192.168.1.75:8080/local/status');
    expect(sockets[0].url).toBe('ws://192.168.1.75:8080/1/messaging/websocket/companion');
    expect(Object.keys(sockets[0].options).sort()).toEqual(['headers', 'perMessageDeflate']);
    manager.cancel(status.id);
  });

  it('stops before registering when the endpoint is not a june-local server', async () => {
    const fetch = pairingServer(() => json({ server: 'something-else' }));
    vi.stubGlobal('fetch', fetch);

    await expect(new PairingManager().begin('Homebridge June', { endpoint: '192.168.1.75' }))
      .rejects.toMatchObject({ kind: 'not-local-server' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(sockets).toHaveLength(0);
  });

  it('reports a server certificate it cannot trust', async () => {
    const cause = Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed', { cause }); }));

    await expect(new PairingManager().begin('Homebridge June', { endpoint: '192.168.1.75' }))
      .rejects.toMatchObject({ kind: 'certificate', message: expect.stringMatching(/not trusted/) });
  });

  it('reports a server it cannot reach', async () => {
    const cause = Object.assign(new Error('connect EHOSTUNREACH 192.168.1.75:443'), { code: 'EHOSTUNREACH' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed', { cause }); }));

    await expect(new PairingManager().begin('Homebridge June', { endpoint: '192.168.1.75' }))
      .rejects.toMatchObject({ kind: 'cannot-connect', message: expect.stringMatching(/Could not connect/) });
  });

  it('rejects invalid server settings without replacing an active session', async () => {
    const active = fakeSession({ id: 'active', state: 'waiting-for-oven' });
    const factory = vi.fn(() => active as never);
    const manager = new PairingManager({ sessionFactory: factory });
    await manager.begin();

    await expect(manager.begin('Homebridge June', { endpoint: 'ftp://oven' })).rejects.toMatchObject({ kind: 'invalid-endpoint' });
    await expect(manager.begin('Homebridge June', { endpoint: 'oven.local', caCert: 'not a certificate' }))
      .rejects.toMatchObject({ kind: 'invalid-ca' });

    expect(factory).toHaveBeenCalledOnce();
    expect(active.destroy).not.toHaveBeenCalled();
  });

  it.each([
    ['saves the june-local settings with the paired oven', { endpoint: '192.168.1.75', caCert: TEST_CA, verifySsl: false },
      'https://192.168.1.75', { endpoint: 'https://192.168.1.75', caCert: TEST_CA, verifySsl: false }],
    ['adds no server settings to a June cloud pairing', {}, 'https://api.junelife.com', {}],
  ])('%s', async (_label, settings, apiUrl, expected) => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => json({ devices: [{ oven_id: 'oven-1', name: 'Kitchen' }] }));
    vi.stubGlobal('fetch', fetch);
    const session = new JunePairingSession('session', 'Homebridge June', resolveServerSettings(settings)) as any;
    session.registration = { deviceId: 'device', accessToken: 'access', password: 'password', refreshToken: 'refresh' };
    session.deadline = setTimeout(() => undefined, 300_000);

    const waiting = session.waitForAssociation();
    await vi.advanceTimersByTimeAsync(3_000);
    await waiting;

    const oven = session.currentStatus().oven;
    expect(fetch.mock.calls[0][0]).toBe(`${apiUrl}/2/devices/device/associated`);
    expect(oven).toMatchObject({ ovenId: 'oven-1', name: 'Kitchen', ...expected });
    expect(Object.keys(oven).filter(key => ['endpoint', 'caCert', 'verifySsl'].includes(key)))
      .toEqual(Object.keys(expected));
  });
});

function fakeSession(status: { id: string; state: 'starting' | 'waiting-for-oven' | 'paired' }) {
  const emitter = new EventEmitter() as EventEmitter & Record<string, any>;
  emitter.begin = vi.fn(async () => status);
  emitter.currentStatus = vi.fn(() => status);
  emitter.destroy = vi.fn();
  emitter.status = status;
  return emitter;
}
