import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JuneHttpError } from './http';

vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  const instances = ((globalThis as any).__juneTestSockets ??= []);
  class FakeWebSocket extends EventEmitter {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    public readyState = FakeWebSocket.CONNECTING;
    public send = vi.fn();

    constructor() {
      super();
      instances.push(this);
    }

    open(): void {
      this.readyState = FakeWebSocket.OPEN;
      this.emit('open');
    }

    close(): void {
      this.readyState = FakeWebSocket.CLOSED;
      this.emit('close');
    }
  }
  return { default: FakeWebSocket };
});

import { calculateRetryDelay, JuneClient } from './june-client';

function sockets(): any[] {
  return (globalThis as any).__juneTestSockets;
}

function client(): JuneClient {
  return new JuneClient({
    ovenId: 'oven', deviceId: 'device', deviceName: 'Homebridge', password: 'password',
    ed25519SeedHex: 'ab'.repeat(32),
  }, { debug() {}, warn() {}, error() {} });
}

beforeEach(() => {
  sockets().length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('JuneClient lifecycle', () => {
  it('calculates bounded jittered retry delays', () => {
    expect(calculateRetryDelay(1, () => 0)).toBe(500);
    expect(calculateRetryDelay(3, () => 0.5)).toBe(4_000);
    expect(calculateRetryDelay(20, () => 1)).toBe(120_000);
  });

  it('shares one socket while a connection is in progress', () => {
    const june = client();

    void (june as any).connect();
    void (june as any).connect();

    expect(sockets()).toHaveLength(1);
  });

  it('does not reconnect after an intentional stop', async () => {
    vi.useFakeTimers();
    const june = client();
    void (june as any).connect();
    sockets()[0].open();

    june.stop();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sockets()).toHaveLength(1);
  });

  it('schedules a reconnect when connection establishment errors', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const june = client();
    const connection = (june as any).connect();

    sockets()[0].emit('error', new Error('handshake failed'));
    await expect(connection).rejects.toThrow('handshake failed');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sockets()).toHaveLength(2);
  });

  it('retries startup after a transient token refresh failure', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const june = client() as any;
    june.refreshToken = vi.fn()
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValue(undefined);
    june.fetchStatus = vi.fn().mockResolvedValue(undefined);
    june.connect = vi.fn().mockResolvedValue(undefined);

    await expect(june.start()).rejects.toThrow('network unavailable');
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(june.refreshToken).toHaveBeenCalledTimes(2));
    expect(june.connect).toHaveBeenCalledOnce();
  });

  it('does not run a queued startup retry after stop', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const june = client() as any;
    june.refreshToken = vi.fn().mockRejectedValue(new Error('network unavailable'));

    await expect(june.start()).rejects.toThrow('network unavailable');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    june.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    clearTimeoutSpy.mockRestore();

    expect(june.refreshToken).toHaveBeenCalledOnce();
  });

  it('does not retry startup for permanent HTTP authentication failures', async () => {
    vi.useFakeTimers();
    const june = client() as any;
    june.refreshToken = vi.fn().mockRejectedValue(new JuneHttpError('Token refresh failed', 401));

    await expect(june.start()).rejects.toThrow('Token refresh failed: 401');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(june.refreshToken).toHaveBeenCalledOnce();
  });

  it('shares one token refresh between concurrent callers', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetchMock = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify({ token: { access_token: 'access', refresh_token: 'refresh' } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const june = client();

    const first = june.refreshToken();
    const second = june.refreshToken();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    release();
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('tolerates a null refresh_token when the access token is valid', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ token: { access_token: 'access', refresh_token: null } }))));
    const june = client();

    await expect(june.refreshToken()).resolves.toBeUndefined();
  });

  it('rejects a malformed successful status response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(['not', 'a', 'status']))));

    await expect(client().fetchStatus()).rejects.toThrow(/status response/i);
  });

  it('clears command acknowledgement timers when an ack arrives', () => {
    vi.useFakeTimers();
    const june = client() as any;
    const resolve = vi.fn();
    const timer = setTimeout(() => resolve(null), 6_000);
    june.pending.set(42, { resolve, timer });

    june.handleMessage(JSON.stringify({ message_code: 10020, data: { request_order: 42, status: 'success' } }));

    expect(resolve).toHaveBeenCalledWith('success');
    expect(vi.getTimerCount()).toBe(0);
  });
});
