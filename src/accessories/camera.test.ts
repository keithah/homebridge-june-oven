import { EventEmitter } from 'events';
import { createSocket } from 'dgram';
import { spawn } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('dgram', () => ({ createSocket: vi.fn() }));
vi.mock('child_process', () => ({ spawn: vi.fn() }));

import { JuneCameraSource } from './camera';

class FakeSocket extends EventEmitter {
  public readonly close = vi.fn();
  public bindBehavior: (callback: () => void) => void = callback => callback();

  public bind(callback: () => void): void {
    this.bindBehavior(callback);
  }

  public address(): { port: number } {
    return { port: 50123 };
  }
}

class FakeProcess extends EventEmitter {
  public readonly kill = vi.fn();
  public readonly stdin = Object.assign(new EventEmitter(), {
    destroyed: false,
    end: vi.fn(),
    write: vi.fn(),
  });
  public readonly stderr = new EventEmitter();
}

function harness(snapshot: { url: string } | undefined = { url: 'https://api.junelife.com/media/image.jpe' }) {
  const shutdownHandlers: Array<() => void> = [];
  let controller: InstanceType<typeof CameraController>;
  class CameraController {
    public readonly forceStopStreamingSession = vi.fn();

    public static generateSynchronisationSource(): number {
      return 1234;
    }

    constructor(_options: unknown) {
      controller = this;
    }
  }
  const platform = {
    api: {
      on: (event: string, handler: () => void) => {
        if (event === 'shutdown') {
          shutdownHandlers.push(handler);
        }
      },
      hap: {
        CameraController,
        H264Level: { LEVEL3_1: 1, LEVEL3_2: 2, LEVEL4_0: 3 },
        H264Profile: { BASELINE: 1, MAIN: 2, HIGH: 3 },
        SRTPCryptoSuites: { AES_CM_128_HMAC_SHA1_80: 1 },
        StreamRequestTypes: { START: 0, STOP: 1, RECONFIGURE: 2 },
      },
    },
    log: { debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
  };
  const client = {
    config: { camera: { ffmpegPath: 'ffmpeg' } },
    latestSnapshot: snapshot,
  };
  return {
    source: new JuneCameraSource(platform as never, client as never),
    get controller() { return controller; },
    shutdown: () => shutdownHandlers.forEach(handler => handler()),
  };
}

function prepare(source: JuneCameraSource, sessionID = 'session'): Promise<Error | undefined> {
  return new Promise(resolve => {
    source.prepareStream({
      addressVersion: 'ipv4',
      sessionID,
      targetAddress: '127.0.0.1',
      video: { port: 5000, srtp_key: Buffer.alloc(16), srtp_salt: Buffer.alloc(14) },
    } as never, error => resolve(error));
  });
}

function start(source: JuneCameraSource, sessionID = 'session'): Promise<Error | undefined> {
  return new Promise(resolve => {
    source.handleStreamRequest({
      type: 0,
      sessionID,
      video: { fps: 2, width: 640, height: 480, max_bit_rate: 300, pt: 99 },
    } as never, error => resolve(error));
  });
}

describe('JuneCameraSource session lifecycle', () => {
  beforeEach(() => {
    vi.mocked(createSocket).mockReset();
    vi.mocked(spawn).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports a socket bind error exactly once', async () => {
    const socket = new FakeSocket();
    socket.bindBehavior = () => socket.emit('error', new Error('bind failed'));
    vi.mocked(createSocket).mockReturnValue(socket as never);
    const { source, controller } = harness();
    const callback = vi.fn();

    source.prepareStream({ addressVersion: 'ipv4', sessionID: 'session' } as never, callback);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0]).toEqual(expect.objectContaining({ message: expect.stringContaining('bind failed') }));
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it('cleans up the prepared socket when no frame is available at start', async () => {
    const socket = new FakeSocket();
    vi.mocked(createSocket).mockReturnValue(socket as never);
    const { source } = harness(null as never);
    await prepare(source);

    expect(await start(source)).toEqual(expect.objectContaining({ message: 'No camera frame available' }));
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it('cleans up the session when ffmpeg emits an asynchronous error', async () => {
    const socket = new FakeSocket();
    const process = new FakeProcess();
    vi.mocked(createSocket).mockReturnValue(socket as never);
    vi.mocked(spawn).mockReturnValue(process as never);
    const { source, controller } = harness();
    await prepare(source);
    const starting = start(source);
    process.emit('spawn');
    await starting;

    process.emit('error', new Error('ENOENT'));

    expect(socket.close).toHaveBeenCalledOnce();
    expect(controller.forceStopStreamingSession).toHaveBeenCalledWith('session');
  });

  it('settles a pending start when the session stops before ffmpeg spawns', async () => {
    const socket = new FakeSocket();
    const process = new FakeProcess();
    vi.mocked(createSocket).mockReturnValue(socket as never);
    vi.mocked(spawn).mockReturnValue(process as never);
    const { source } = harness();
    await prepare(source);
    const startCallback = vi.fn();

    source.handleStreamRequest({
      type: 0,
      sessionID: 'session',
      video: { fps: 2, width: 640, height: 480, max_bit_rate: 300, pt: 99 },
    } as never, startCallback);
    source.handleStreamRequest({ type: 1, sessionID: 'session' } as never, vi.fn());

    expect(startCallback).toHaveBeenCalledOnce();
    expect(startCallback.mock.calls[0][0]).toEqual(expect.objectContaining({
      message: 'Streaming session stopped before ffmpeg started',
    }));

    process.emit('spawn');
    expect(startCallback).toHaveBeenCalledOnce();
  });

  it('disables automatic redirects when fetching a camera frame', async () => {
    const socket = new FakeSocket();
    vi.mocked(createSocket).mockReturnValue(socket as never);
    const fetch = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) });
    vi.stubGlobal('fetch', fetch);
    const { source } = harness();

    await source.handleSnapshotRequest({} as never, vi.fn());

    expect(fetch).toHaveBeenCalledWith('https://api.junelife.com/media/image.jpe', expect.objectContaining({ redirect: 'error' }));
  });

  it('shares one in-flight frame fetch across concurrent snapshot requests', async () => {
    let release!: (response: unknown) => void;
    const response = new Promise(resolve => { release = resolve; });
    const fetch = vi.fn(() => response);
    vi.stubGlobal('fetch', fetch);
    const { source } = harness();
    const first = vi.fn();
    const second = vi.fn();

    const firstRequest = source.handleSnapshotRequest({} as never, first);
    const secondRequest = source.handleSnapshotRequest({} as never, second);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    release({ ok: true, body: null });
    await Promise.all([firstRequest, secondRequest]);

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it('cleans up all prepared sessions during platform shutdown', async () => {
    const socket = new FakeSocket();
    vi.mocked(createSocket).mockReturnValue(socket as never);
    const { source, shutdown } = harness();
    await prepare(source);

    shutdown();

    expect(socket.close).toHaveBeenCalledOnce();
  });
});
