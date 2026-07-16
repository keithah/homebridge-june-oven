import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { JuneOvenConfig } from './protocol';
import { JuneClient } from './june-client';
import { JuneThermostatAccessory } from './accessories/thermostat';
import { JunePreheatSwitchAccessory } from './accessories/preheat-switch';
import { JuneOccupancySensorAccessory } from './accessories/sensors';
import { JuneDoorbellAccessory } from './accessories/doorbell';
import { JuneModeSwitchAccessory } from './accessories/mode-switch';
import { JuneProbeSensorAccessory } from './accessories/probe-sensor';
import { attachCamera } from './accessories/camera';

export interface JunePlatformConfig extends PlatformConfig {
  name?: string;
  ovens?: JuneOvenConfig[];
}

type AccessoryKind = 'thermostat' | 'preheat' | 'ready' | 'done' | 'doorbell' | 'modes' | 'probe' | 'camera';

export class JunePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  private readonly accessories = new Map<string, PlatformAccessory>();
  private readonly clients: JuneClient[] = [];

  constructor(
    public readonly log: Logging,
    public readonly config: JunePlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.api.on('didFinishLaunching', () => this.discover());
    this.api.on('shutdown', () => {
      for (const client of this.clients) {
        client.stop();
      }
      this.clients.length = 0;
    });
  }

  public configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.set(accessory.UUID, accessory);
  }

  private discover(): void {
    const ovens = this.config.ovens || [];
    const wanted = new Set<string>();
    for (const oven of ovens) {
      if (!oven.ovenId || !oven.deviceId || !oven.ed25519SeedHex) {
        this.log.warn(`Skipping ${oven.name || 'June'} because it is missing pairing identity fields.`);
        continue;
      }
      const client = new JuneClient(oven, this.log);
      this.clients.push(client);
      client.on('token', token => {
        oven.accessToken = token.accessToken;
        oven.refreshToken = token.refreshToken;
      });
      this.bindAccessory(client, 'thermostat', oven.name || 'June', wanted);
      if (oven.preheatSwitchName !== '') {
        this.bindAccessory(client, 'preheat', oven.preheatSwitchName || 'June Preheat', wanted);
      }
      if (oven.readySensor !== false) {
        this.bindAccessory(client, 'ready', `${oven.name || 'June'} Ready`, wanted);
      }
      if (oven.doneSensor !== false) {
        this.bindAccessory(client, 'done', `${oven.name || 'June'} Done`, wanted);
      }
      if (client.config.doorbell.enabled) {
        // Camera (if enabled) attaches to this same accessory → Video Doorbell.
        this.bindAccessory(client, 'doorbell', client.config.doorbell.name, wanted);
      } else if (client.config.camera.enabled) {
        this.bindAccessory(client, 'camera', client.config.camera.name, wanted);
      }
      if (client.config.modes.length > 0) {
        this.bindAccessory(client, 'modes', `${oven.name || 'June'} Modes`, wanted);
      }
      if (client.config.probeSensors.enabled) {
        this.bindAccessory(client, 'probe', `${oven.name || 'June'} Probe`, wanted);
      }
      client.start().catch(error => this.log.error(`Failed to start ${oven.name || oven.ovenId}: ${error.message}`));
    }
    const stale = [...this.accessories.values()].filter(accessory => !wanted.has(accessory.UUID));
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }

  private bindAccessory(client: JuneClient, kind: AccessoryKind, name: string, wanted: Set<string>): void {
    const uuid = this.api.hap.uuid.generate(`${client.config.ovenId}:${kind}`);
    wanted.add(uuid);
    let accessory = this.accessories.get(uuid);
    if (!accessory) {
      accessory = new this.api.platformAccessory(name, uuid);
      accessory.context.ovenId = client.config.ovenId;
      accessory.context.kind = kind;
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(uuid, accessory);
    }
    accessory.displayName = name;
    if (kind === 'thermostat') {
      new JuneThermostatAccessory(this, accessory, client);
    } else if (kind === 'preheat') {
      new JunePreheatSwitchAccessory(this, accessory, client);
    } else if (kind === 'doorbell') {
      new JuneDoorbellAccessory(this, accessory, client);
      if (client.config.camera.enabled) {
        attachCamera(this, accessory, client);
      }
    } else if (kind === 'camera') {
      attachCamera(this, accessory, client);
    } else if (kind === 'modes') {
      new JuneModeSwitchAccessory(this, accessory, client);
    } else if (kind === 'probe') {
      new JuneProbeSensorAccessory(this, accessory, client);
    } else {
      new JuneOccupancySensorAccessory(this, accessory, client, kind);
    }
  }
}
