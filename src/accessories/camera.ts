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
import { fetchWithTimeout, readResponseBuffer } from '../http';

const MAX_CAMERA_FRAME_BYTES = 10 * 1024 * 1024;

// A 1x1 grey JPEG served when the oven has not pushed a camera frame yet
// (i.e. no active cook). Base64 of a minimal valid JPEG.
const PLACEHOLDER_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AfwD/2Q==',
  'base64',
);

interface Session {
  socket?: Socket;
  ffmpeg?: ChildProcess;
  pump?: ReturnType<typeof setInterval>;
  frameFetch?: AbortController;
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
      const response = await fetchWithTimeout(snapshot.url, {}, 5000);
      if (!response.ok) {
        throw new Error(`snapshot fetch ${response.status}`);
      }
      callback(undefined, await readResponseBuffer(response, MAX_CAMERA_FRAME_BYTES));
    } catch (error) {
      this.platform.log.warn(`June camera snapshot failed: ${(error as Error).message}`);
      callback(undefined, PLACEHOLDER_JPEG);
    }
  }

  public prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): void {
    const socket = createSocket(request.addressVersion === 'ipv6' ? 'udp6' : 'udp4');
    let prepared = false;
    socket.once('error', error => {
      this.platform.log.warn(`June camera RTCP socket error: ${error.message}`);
      if (!prepared) {
        prepared = true;
        try { socket.close(); } catch { /* already closed */ }
        callback(error);
      } else {
        this.stopSession(request.sessionID);
      }
    });
    socket.bind(() => {
      if (prepared) {
        return;
      }
      prepared = true;
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
    if (!session) {
      callback(new Error('No prepared session'));
      return;
    }
    if (!this.client.latestSnapshot) {
      this.platform.log.warn('June camera has no frame yet (no active cook) — cannot start live stream.');
      this.stopSession(request.sessionID);
      callback(new Error('No camera frame available'));
      return;
    }
    const { video } = request;
    // The source is a ~1 fps still feed; encode at a modest rate.
    const fps = Math.min(video.fps && video.fps > 0 ? video.fps : 2, 5);
    const args = [
      '-loglevel', 'error',
      '-f', 'image2pipe', '-vcodec', 'mjpeg', '-framerate', String(fps), '-i', 'pipe:0',
      '-an', '-sn', '-dn',
      '-codec:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'baseline',
      '-preset', 'ultrafast', '-tune', 'zerolatency',
      '-r', String(fps),
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
      this.stopSession(request.sessionID);
      callback(new Error('ffmpeg not available'));
      return;
    }
    session.ffmpeg = proc;
    let started = false;
    proc.once('error', error => {
      this.platform.log.error(`June camera ffmpeg error: ${error.message} (is ffmpeg installed at "${ffmpegPath}"?)`);
      this.stopSession(request.sessionID);
      if (!started) {
        callback(new Error('ffmpeg not available'));
      }
    });
    proc.stdin?.on('error', () => { /* ignore EPIPE once ffmpeg exits */ });
    proc.stderr?.on('data', data => this.platform.log.debug(`[june-camera ffmpeg] ${data}`));
    proc.on('exit', (code, signal) => {
      if (code !== null && code !== 0 && signal !== 'SIGKILL') {
        this.platform.log.warn(`June camera ffmpeg exited with code ${code}`);
      }
      this.stopSession(request.sessionID);
    });

    // Pump the oven's latest still into ffmpeg at ~fps, refetching only when the
    // WebSocket delivers a new frame (10011 updates the URL ~1/s during a cook).
    // This is what makes the live view actually advance instead of freezing on
    // the frame that was current when the stream started.
    let lastUrl: string | undefined;
    let lastFrame: Buffer | undefined;
    let fetching = false;
    const pump = async () => {
      const snap = this.client.latestSnapshot;
      if (snap && snap.url !== lastUrl && !fetching) {
        fetching = true;
        lastUrl = snap.url;
        try {
          session.frameFetch?.abort();
          session.frameFetch = new AbortController();
          const response = await fetchWithTimeout(snap.url, { signal: session.frameFetch.signal }, 5000);
          if (response.ok) {
            lastFrame = await readResponseBuffer(response, MAX_CAMERA_FRAME_BYTES);
          }
        } catch {
          // keep the previous frame on a transient fetch failure
        } finally {
          fetching = false;
        }
      }
      if (lastFrame && proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.write(lastFrame);
      }
    };
    proc.once('spawn', () => {
      started = true;
      session.pump = setInterval(() => { void pump(); }, Math.round(1000 / fps));
      void pump();
      callback();
    });
  }

  private stopSession(sessionID: string): void {
    const session = this.sessions.get(sessionID);
    if (!session) {
      return;
    }
    if (session.pump) {
      clearInterval(session.pump);
    }
    session.frameFetch?.abort();
    if (session.ffmpeg?.stdin && !session.ffmpeg.stdin.destroyed) {
      try {
        session.ffmpeg.stdin.end();
      } catch {
        // stdin may already be closed
      }
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
