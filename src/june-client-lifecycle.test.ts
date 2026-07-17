import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { JuneClient } from './june-client';

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
    const june = client();
    const connection = (june as any).connect();

    sockets()[0].emit('error', new Error('handshake failed'));
    await expect(connection).rejects.toThrow('handshake failed');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sockets()).toHaveLength(2);
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
});
