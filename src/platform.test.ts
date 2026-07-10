import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./june-client', async () => {
  const { EventEmitter } = await import('events');

  class FakeJuneClient extends EventEmitter {
    public readonly config: any;

    constructor(config: any) {
      super();
      this.config = {
        ...config,
        name: config.name || 'June',
        defaultMode: config.defaultMode || 'bake',
        defaultTempF: config.defaultTempF ?? 350,
        tempUnit: config.tempUnit || 'F',
        preheatSwitchName: config.preheatSwitchName ?? 'June Preheat',
        doorbell: {
          enabled: config.doorbell?.enabled ?? false,
          name: config.doorbell?.name || 'June Doorbell',
          triggers: {
            done: config.doorbell?.triggers?.done ?? false,
            ready: config.doorbell?.triggers?.ready ?? false,
          },
        },
        camera: {
          enabled: config.camera?.enabled ?? false,
          name: config.camera?.name || 'June Camera',
          ffmpegPath: config.camera?.ffmpegPath || 'ffmpeg',
        },
        modes: config.modes || [],
        probeSensors: {
          enabled: config.probeSensors?.enabled ?? false,
          name: config.probeSensors?.name || 'Food Probe',
        },
      };
    }

    public start(): Promise<void> {
      return Promise.resolve();
    }
  }

  return { JuneClient: FakeJuneClient };
});

type FakeServiceType = {
  new(name?: string, subtype?: string): FakeService;
};

class FakeService {
  public readonly characteristics = new Map<unknown, unknown>();

  constructor(
    public readonly name?: string,
    public readonly subtype?: string,
  ) {}

  public setCharacteristic(characteristic: unknown, value: unknown): this {
    this.characteristics.set(characteristic, value);
    return this;
  }

  public updateCharacteristic(characteristic: unknown, value: unknown): this {
    this.characteristics.set(characteristic, value);
    return this;
  }

  public getCharacteristic(characteristic: unknown) {
    return {
      setProps: (_props: unknown) => this,
      updateValue: (value: unknown) => {
        this.characteristics.set(characteristic, value);
        return this;
      },
      onGet: (_callback: unknown) => this,
      onSet: (_callback: unknown) => this,
    };
  }
}

function serviceType(name: string): FakeServiceType {
  return class extends FakeService {
    constructor(_displayName?: string, subtype?: string) {
      super(name, subtype);
    }
  };
}

class FakeAccessory {
  public context: Record<string, unknown> = {};
  public displayName: string;
  private readonly services: FakeService[] = [];

  constructor(name: string, public readonly UUID: string) {
    this.displayName = name;
  }

  public getService(type: FakeServiceType): FakeService | undefined {
    return this.services.find(service => service.name === new type().name);
  }

  public addService(type: FakeServiceType, _name?: string, subtype?: string): FakeService {
    const service = new type(undefined, subtype);
    this.services.push(service);
    return service;
  }

  public getServiceById(type: FakeServiceType, subtype: string): FakeService | undefined {
    return this.services.find(service => service.name === new type().name && service.subtype === subtype);
  }

  public removeService(service: FakeService): void {
    const index = this.services.indexOf(service);
    if (index >= 0) {
      this.services.splice(index, 1);
    }
  }
}

function createApi() {
  const launchCallbacks: Array<() => void> = [];
  const registered: FakeAccessory[] = [];
  const unregistered: FakeAccessory[] = [];
  const Service = {
    AccessoryInformation: serviceType('AccessoryInformation'),
    CameraRTPStreamManagement: serviceType('CameraRTPStreamManagement'),
    Doorbell: serviceType('Doorbell'),
    OccupancySensor: serviceType('OccupancySensor'),
    Switch: serviceType('Switch'),
    TemperatureSensor: serviceType('TemperatureSensor'),
    Thermostat: serviceType('Thermostat'),
  };
  const Characteristic = {
    CurrentTemperature: 'CurrentTemperature',
    CurrentHeatingCoolingState: { OFF: 0, HEAT: 1 },
    CurrentHeatingCoolingStateKey: 'CurrentHeatingCoolingState',
    Manufacturer: 'Manufacturer',
    Model: 'Model',
    Name: 'Name',
    On: 'On',
    OccupancyDetected: { OCCUPANCY_DETECTED: 1, OCCUPANCY_NOT_DETECTED: 0 },
    ProgrammableSwitchEvent: { SINGLE_PRESS: 0 },
    TargetHeatingCoolingState: { OFF: 0, HEAT: 1 },
    TargetTemperature: 'TargetTemperature',
    TemperatureDisplayUnits: { CELSIUS: 0, FAHRENHEIT: 1 },
  };

  return {
    api: {
      hap: {
        Characteristic,
        Service,
        uuid: { generate: (input: string) => `uuid:${input}` },
      },
      on: (event: string, callback: () => void) => {
        if (event === 'didFinishLaunching') {
          launchCallbacks.push(callback);
        }
      },
      platformAccessory: FakeAccessory,
      registerPlatformAccessories: (_plugin: string, _platform: string, accessories: FakeAccessory[]) => registered.push(...accessories),
      unregisterPlatformAccessories: (_plugin: string, _platform: string, accessories: FakeAccessory[]) => unregistered.push(...accessories),
    },
    launch: () => launchCallbacks.forEach(callback => callback()),
    registered,
    unregistered,
  };
}

describe('JunePlatform probe accessory registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers a singular probe accessory name', async () => {
    const { JunePlatform } = await import('./platform');
    const { api, launch, registered } = createApi();
    new JunePlatform(console, {
      platform: 'JuneOven',
      ovens: [{
        ovenId: 'oven-1',
        deviceId: 'device',
        deviceName: 'Homebridge',
        password: 'password',
        ed25519SeedHex: 'ab',
        name: 'Kitchen',
        preheatSwitchName: '',
        readySensor: false,
        doneSensor: false,
        probeSensors: { enabled: true },
      }],
    }, api as never);

    launch();

    expect(registered.map(accessory => accessory.displayName)).toContain('Kitchen Probe');
    expect(registered.map(accessory => accessory.displayName)).not.toContain('Kitchen Probes');
  });

  it('unregisters the legacy plural probe accessory UUID', async () => {
    const { JunePlatform } = await import('./platform');
    const { api, launch, unregistered } = createApi();
    const platform = new JunePlatform(console, {
      platform: 'JuneOven',
      ovens: [{
        ovenId: 'oven-1',
        deviceId: 'device',
        deviceName: 'Homebridge',
        password: 'password',
        ed25519SeedHex: 'ab',
        name: 'Kitchen',
        preheatSwitchName: '',
        readySensor: false,
        doneSensor: false,
        probeSensors: { enabled: true },
      }],
    }, api as never);
    const legacy = new FakeAccessory('Kitchen Probes', 'uuid:oven-1:probes');
    platform.configureAccessory(legacy as never);

    launch();

    expect(unregistered).toContain(legacy);
  });
});
