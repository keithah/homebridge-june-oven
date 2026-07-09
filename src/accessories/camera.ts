import { createSocket, Socket } from 'dgram';
import { spawn, ChildProcess } from 'child_process';
import type {
  CameraController,
  CameraStreamingDelegate,
  PlatformAccessory,
  PrepareStreamCallback,
  PrepareStreamRequest,
  SnapshotRequest,
  SnapshotRequestCallback,
  StartStreamRequest,
  StreamingRequest,
  StreamRequestCallback,
} from 'homebridge';
import type { JuneClient } from '../june-client';
import type { JunePlatform } from '../platform';

// A 1x1 grey JPEG served when the oven has not pushed a camera frame yet
// (i.e. no active cook). Base64 of a minimal valid JPEG.
const PLACEHOLDER_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AfwD/2Q==',
  'base64',
);

interface Session {
  socket?: Socket;
  ffmpeg?: ChildProcess;
  targetAddress: string;
  videoPort: number;
  videoSsrc: number;
  videoSrtp: string; // base64(key + salt)
}

/**
 * HomeKit camera backed by the oven's ~1fps interior still feed (10011).
 * - Snapshots (tile + doorbell notification): always work; fetch the latest
 *   pre-signed JPEG the client cached from the WebSocket.
 * - Live streaming (tap-to-view): spawns system ffmpeg to encode the current
 *   still as H.264/SRTP. Requires ffmpeg on the host (config `camera.ffmpegPath`);
 *   if it is missing, snapshots still work and streaming logs a warning.
 *
 * NOTE: the SRTP streaming path is verified by build/type-check only — confirming
 * it end-to-end needs a real Home hub + iOS device to tap into the live view.
 */
export class JuneCameraSource implements CameraStreamingDelegate {
  public readonly controller: CameraController;
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly platform: JunePlatform,
    private readonly client: JuneClient,
  ) {
    const hap = this.platform.api.hap;
    this.controller = new hap.CameraController({
      cameraStreamCount: 2,
      delegate: this,
      streamingOptions: {
        supportedCryptoSuites: [hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          resolutions: [
            [640, 480, 15],
            [640, 480, 2],
            [320, 240, 15],
          ],
          codec: {
            profiles: [hap.H264Profile.BASELINE, hap.H264Profile.MAIN, hap.H264Profile.HIGH],
            levels: [hap.H264Level.LEVEL3_1, hap.H264Level.LEVEL3_2, hap.H264Level.LEVEL4_0],
          },
        },
        // No audio: the oven's interior camera is a video-only still feed. Advertising
        // an audio codec would require prepareStream to return an audio SRTP block, and
        // omitting it crashes the stream ("Audio was enabled but not supplied"). audio is
        // optional in CameraStreamingOptions, so we leave it out.
      },
    });
  }

  public async handleSnapshotRequest(_request: SnapshotRequest, callback: SnapshotRequestCallback): Promise<void> {
    const snapshot = this.client.latestSnapshot;
    if (!snapshot) {
      callback(undefined, PLACEHOLDER_JPEG);
      return;
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(snapshot.url, { signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) {
        throw new Error(`snapshot fetch ${response.status}`);
      }
      callback(undefined, Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      this.platform.log.warn(`June camera snapshot failed: ${(error as Error).message}`);
      callback(undefined, PLACEHOLDER_JPEG);
    }
  }

  public prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): void {
    const socket = createSocket(request.addressVersion === 'ipv6' ? 'udp6' : 'udp4');
    socket.on('error', error => this.platform.log.warn(`June camera RTCP socket error: ${error.message}`));
    socket.bind(() => {
      const localPort = socket.address().port;
      const ssrc = this.platform.api.hap.CameraController.generateSynchronisationSource();
      this.sessions.set(request.sessionID, {
        socket,
        targetAddress: request.targetAddress,
        videoPort: request.video.port,
        videoSsrc: ssrc,
        videoSrtp: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]).toString('base64'),
      });
      callback(undefined, {
        video: {
          port: localPort,
          ssrc,
          srtp_key: request.video.srtp_key,
          srtp_salt: request.video.srtp_salt,
        },
      });
    });
  }

  public handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    const { StreamRequestTypes } = this.platform.api.hap;
    if (request.type === StreamRequestTypes.START) {
      this.startStream(request, callback);
      return;
    }
    if (request.type === StreamRequestTypes.STOP) {
      this.stopSession(request.sessionID);
    }
    // RECONFIGURE is a no-op for a still-based source.
    callback();
  }

  private startStream(request: StartStreamRequest, callback: StreamRequestCallback): void {
    const session = this.sessions.get(request.sessionID);
    const snapshot = this.client.latestSnapshot;
    if (!session) {
      callback(new Error('No prepared session'));
      return;
    }
    if (!snapshot) {
      this.platform.log.warn('June camera has no frame yet (no active cook) — cannot start live stream.');
      callback(new Error('No camera frame available'));
      return;
    }
    const { video } = request;
    const args = [
      '-loglevel', 'error',
      '-loop', '1', '-re', '-i', snapshot.url,
      '-an', '-sn', '-dn',
      '-codec:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'baseline',
      '-preset', 'ultrafast', '-tune', 'zerolatency',
      '-r', String(video.fps),
      '-vf', `scale=${video.width}:${video.height}`,
      '-b:v', `${video.max_bit_rate}k`, '-bufsize', `${2 * video.max_bit_rate}k`, '-maxrate', `${video.max_bit_rate}k`,
      '-payload_type', String(video.pt),
      '-ssrc', String(session.videoSsrc),
      '-f', 'rtp',
      '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
      '-srtp_out_params', session.videoSrtp,
      `srtp://${session.targetAddress}:${session.videoPort}?rtcpport=${session.videoPort}&pkt_size=1316`,
    ];

    const ffmpegPath = this.client.config.camera.ffmpegPath;
    let proc: ChildProcess;
    try {
      proc = spawn(ffmpegPath, args, { env: process.env });
    } catch (error) {
      this.platform.log.error(`June camera: failed to spawn ffmpeg ("${ffmpegPath}"): ${(error as Error).message}`);
      callback(new Error('ffmpeg not available'));
      return;
    }
    session.ffmpeg = proc;
    proc.on('error', error =>
      this.platform.log.error(`June camera ffmpeg error: ${error.message} (is ffmpeg installed at "${ffmpegPath}"?)`),
    );
    proc.stderr?.on('data', data => this.platform.log.debug(`[june-camera ffmpeg] ${data}`));
    proc.on('exit', (code, signal) => {
      if (code !== null && code !== 0 && signal !== 'SIGKILL') {
        this.platform.log.warn(`June camera ffmpeg exited with code ${code}`);
      }
    });
    callback();
  }

  private stopSession(sessionID: string): void {
    const session = this.sessions.get(sessionID);
    if (!session) {
      return;
    }
    session.ffmpeg?.kill('SIGKILL');
    try {
      session.socket?.close();
    } catch {
      // socket may already be closed
    }
    this.sessions.delete(sessionID);
  }
}

export function attachCamera(platform: JunePlatform, accessory: PlatformAccessory, client: JuneClient): void {
  const source = new JuneCameraSource(platform, client);
  accessory.configureController(source.controller);
}
