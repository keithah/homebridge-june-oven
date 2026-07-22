import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildShownCode, calculateAssociationDelay, damm, JunePairingSession, modPow, PairingManager, SrpServer } from './pairing';

afterEach(() => vi.useRealTimers());

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

function fakeSession(status: { id: string; state: 'starting' | 'waiting-for-oven' | 'paired' }) {
  const emitter = new EventEmitter() as EventEmitter & Record<string, any>;
  emitter.begin = vi.fn(async () => status);
  emitter.currentStatus = vi.fn(() => status);
  emitter.destroy = vi.fn();
  emitter.status = status;
  return emitter;
}
