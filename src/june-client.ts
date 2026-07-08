import { EventEmitter } from 'events';
import WebSocket from 'ws';
import {
  JUNE_APP_VERSION,
  JUNE_PLATFORM_VERSION,
  JUNE_USER_AGENT,
} from './settings';
import {
  fahrenheitToMilliC,
  MC_CANCEL,
  MC_KEEPALIVE,
  MC_PREHEAT,
  MC_TEMP,
  milliCToCelsius,
  normalizeOvenConfig,
  NormalizedJuneConfig,
  JuneOvenConfig,
  signedFrame,
} from './protocol';

export interface JuneTelemetry {
  currentTempC?: number;
  targetTempC?: number;
  active?: boolean;
  ready?: boolean;
  done?: boolean;
  connectionState?: string;
}

export interface JuneClientEvents {
  telemetry: [JuneTelemetry];
  token: [{ accessToken: string; refreshToken: string }];
  warning: [string];
}

export declare interface JuneClient {
  on<U extends keyof JuneClientEvents>(event: U, listener: (...args: JuneClientEvents[U]) => void): this;
  emit<U extends keyof JuneClientEvents>(event: U, ...args: JuneClientEvents[U]): boolean;
}

export class JuneClient extends EventEmitter {
  public readonly config: NormalizedJuneConfig;
  private ws?: WebSocket;
  private keepalive?: NodeJS.Timeout;
  private reconnect?: NodeJS.Timeout;
  private statusPoll?: NodeJS.Timeout;
  private readonly pending = new Map<number, (status: string | null) => void>();
  private lastActive = false;
  private lastCancelled = false;
  private lastTargetTempC?: number;

  constructor(config: JuneOvenConfig, private readonly log: Pick<Console, 'debug' | 'warn' | 'error'> = console) {
    super();
    this.config = normalizeOvenConfig(config);
  }

  public async start(): Promise<void> {
    await this.refreshToken();
    await this.fetchStatus().catch(error => this.warn(`Initial status failed: ${error.message}`));
    this.connect();
    this.statusPoll = setInterval(() => {
      this.fetchStatus().catch(error => this.warn(`Status poll failed: ${error.message}`));
    }, 60_000);
  }

  public stop(): void {
    clearInterval(this.keepalive);
    clearInterval(this.statusPoll);
    clearTimeout(this.reconnect);
    this.ws?.close();
  }

  public async preheat(mode = this.config.defaultMode, tempF = this.config.defaultTempF): Promise<string | null> {
    this.lastCancelled = false;
    return this.sendCommand(MC_PREHEAT, { primitive_type: mode, temperature_cavity: fahrenheitToMilliC(tempF) });
  }

  public async setTemperatureC(tempC: number): Promise<string | null> {
    this.lastTargetTempC = tempC;
    return this.sendCommand(MC_TEMP, { plan_id: 0, temperature_cavity: Math.round(tempC * 1000) });
  }

  public async cancel(): Promise<string | null> {
    this.lastCancelled = true;
    return this.sendCommand(MC_CANCEL, { plan_id: 0 });
  }

  public async refreshToken(): Promise<void> {
    const response = await fetch(`${this.config.baseUrl}/2/devices/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': JUNE_USER_AGENT },
      body: JSON.stringify({
        password: this.config.password,
        device_id: this.config.deviceId,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        device_type: 'companion',
        device_name: this.config.deviceName,
        platform: 'android',
        version: JUNE_APP_VERSION,
        platform_version: JUNE_PLATFORM_VERSION,
      }),
    });
    if (!response.ok) {
      throw new Error(`Token refresh failed: ${response.status}`);
    }
    const body = await response.json() as { token: { access_token: string; refresh_token?: string } };
    this.config.accessToken = body.token.access_token;
    this.config.refreshToken = body.token.refresh_token || this.config.refreshToken;
    this.emit('token', { accessToken: this.config.accessToken, refreshToken: this.config.refreshToken });
  }

  public async fetchStatus(autoRefresh = true): Promise<void> {
    const response = await fetch(`${this.config.messagingUrl}/1/messaging/device/${this.config.ovenId}/status`, {
      headers: { Authorization: `Bearer ${this.config.accessToken}` },
    });
    if (response.status === 401 && autoRefresh) {
      await this.refreshToken();
      return this.fetchStatus(false);
    }
    if (!response.ok) {
      throw new Error(`Status failed: ${response.status}`);
    }
    const status = await response.json() as {
      connection_state?: string;
      device_state?: { data?: { state?: string } };
      cook_plan?: { data?: { food?: { plan?: { steps?: Array<{ temperature_cavity?: number }> } } } };
    };
    const active = status.device_state?.data?.state === 'active';
    const targetMilliC = status.cook_plan?.data?.food?.plan?.steps?.find(step => typeof step.temperature_cavity === 'number')?.temperature_cavity;
    this.applyTelemetry({
      active,
      targetTempC: typeof targetMilliC === 'number' ? milliCToCelsius(targetMilliC) : undefined,
      connectionState: status.connection_state,
    });
  }

  private connect(): void {
    this.ws = new WebSocket(this.config.wsUrl, {
      headers: { Authorization: `Bearer ${this.config.accessToken}`, 'User-Agent': JUNE_USER_AGENT },
      perMessageDeflate: false,
    });
    this.ws.on('open', () => {
      this.sendKeepalive().catch(error => this.warn(`Keepalive failed: ${error.message}`));
      this.keepalive = setInterval(() => this.sendKeepalive().catch(error => this.warn(`Keepalive failed: ${error.message}`)), 7000);
    });
    this.ws.on('message', message => this.handleMessage(message.toString()));
    this.ws.on('close', () => this.scheduleReconnect());
    this.ws.on('error', error => this.warn(`WebSocket error: ${error.message}`));
  }

  private scheduleReconnect(): void {
    clearInterval(this.keepalive);
    if (this.reconnect) {
      return;
    }
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined;
      this.connect();
    }, 10_000);
  }

  private async sendKeepalive(): Promise<void> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return;
    }
    const { frame } = await signedFrame(this.config, MC_KEEPALIVE, {});
    this.ws.send(frame);
  }

  private async sendCommand(code: number, data: Record<string, unknown>): Promise<string | null> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.connect();
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw new Error('June messaging socket is not connected.');
    }
    const { frame, order } = await signedFrame(this.config, code, data);
    const ack = new Promise<string | null>(resolve => {
      this.pending.set(order, resolve);
      setTimeout(() => {
        if (this.pending.delete(order)) {
          resolve(null);
        }
      }, 6000);
    });
    this.ws.send(frame);
    return ack;
  }

  private handleMessage(message: string): void {
    let frame: { message_code?: number; data?: any };
    try {
      frame = JSON.parse(message);
    } catch {
      return;
    }
    const data = frame.data || {};
    if (frame.message_code === 10020 && typeof data.request_order === 'number') {
      const resolve = this.pending.get(data.request_order);
      if (resolve) {
        this.pending.delete(data.request_order);
        resolve(typeof data.status === 'string' ? data.status : null);
      }
      return;
    }
    if (frame.message_code === 10013) {
      this.applyTelemetry({
        currentTempC: typeof data.sensor_data?.cavity === 'number' ? milliCToCelsius(data.sensor_data.cavity) : undefined,
        ready: typeof data.cook_state_data?.progress === 'number' && data.cook_state_data.progress >= 0.995,
      });
      return;
    }
    if (frame.message_code === 10015 || frame.message_code === 10016) {
      const target = data.temperature_cavity ?? data.food?.plan?.steps?.find?.((step: { temperature_cavity?: number }) => typeof step.temperature_cavity === 'number')?.temperature_cavity;
      this.applyTelemetry({ targetTempC: typeof target === 'number' ? milliCToCelsius(target) : undefined });
      return;
    }
    if (frame.message_code === 10017 && data.type === 'cancelled') {
      this.lastCancelled = true;
      return;
    }
    if (frame.message_code === 10018) {
      this.applyTelemetry({ active: data.state === 'active' });
    }
  }

  private applyTelemetry(update: JuneTelemetry): void {
    if (typeof update.targetTempC === 'number') {
      this.lastTargetTempC = update.targetTempC;
    }
    if (typeof update.active === 'boolean') {
      update.done = this.lastActive && !update.active && !this.lastCancelled;
      this.lastActive = update.active;
      if (update.active) {
        this.lastCancelled = false;
      }
    }
    if (typeof update.ready === 'boolean' && update.ready && typeof update.currentTempC === 'number' && typeof this.lastTargetTempC === 'number') {
      update.ready = update.currentTempC + 1 >= this.lastTargetTempC;
    }
    this.emit('telemetry', update);
  }

  private warn(message: string): void {
    this.log.warn(message);
    this.emit('warning', message);
  }
}
