import { describe, expect, it, vi } from 'vitest';
import { JuneCameraSource } from './camera';

describe('JuneCameraSource cleanup', () => {
  it('removes the prepared session when streaming starts without a frame', () => {
    const socket = { close: vi.fn() };
    const source = new JuneCameraSource(fakePlatform() as never, {
      config: { camera: { ffmpegPath: 'ffmpeg' } },
      latestSnapshot: undefined,
    } as never);
    (source as any).sessions.set('session', {
      socket,
      targetAddress: '127.0.0.1', videoPort: 1234, videoSsrc: 1, videoSrtp: 'key',
    });
    const callback = vi.fn();

    source.handleStreamRequest({ type: 'start', sessionID: 'session' } as never, callback);

    expect(callback).toHaveBeenCalledWith(expect.any(Error));
    expect((source as any).sessions.size).toBe(0);
    expect(socket.close).toHaveBeenCalledOnce();
  });
});

function fakePlatform() {
  class CameraController {
    static generateSynchronisationSource(): number { return 1; }
    constructor(_options: unknown) {}
  }
  return {
    api: {
      hap: {
        CameraController,
        SRTPCryptoSuites: { AES_CM_128_HMAC_SHA1_80: 0 },
        H264Profile: { BASELINE: 0, MAIN: 1, HIGH: 2 },
        H264Level: { LEVEL3_1: 0, LEVEL3_2: 1, LEVEL4_0: 2 },
        StreamRequestTypes: { START: 'start', STOP: 'stop' },
      },
    },
    log: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}
