import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildShownCode, damm, modPow, PairingManager, SrpServer } from './pairing';

afterEach(() => vi.useRealTimers());

describe('Damm PIN construction', () => {
  it('appends a check digit that validates to zero', () => {
    const shown = buildShownCode('46605', 3);

    expect(shown).toMatch(/^\d{8}$/);
    expect(shown).toBe('46605037');
    expect(damm(shown)).toBe(0);
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
});

function fakeSession(status: { id: string; state: 'starting' | 'waiting-for-oven' | 'paired' }) {
  const emitter = new EventEmitter() as EventEmitter & Record<string, any>;
  emitter.begin = vi.fn(async () => status);
  emitter.currentStatus = vi.fn(() => status);
  emitter.destroy = vi.fn();
  emitter.status = status;
  return emitter;
}
