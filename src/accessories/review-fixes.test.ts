import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { JuneDoorbellAccessory } from './doorbell';
import { JuneModeSwitchAccessory } from './mode-switch';
import { JuneProbeSensorAccessory } from './probe-sensor';

class FakeCharacteristic {
  public setHandler?: (value: boolean) => Promise<void>;
  public readonly setProps = vi.fn();

  public onSet(handler: (value: boolean) => Promise<void>): this {
    this.setHandler = handler;
    return this;
  }
}

class FakeService {
  public readonly updateCharacteristic = vi.fn();
  public readonly setCharacteristic = vi.fn(() => this);
  public readonly characteristic = new FakeCharacteristic();

  public getCharacteristic(): FakeCharacteristic {
    return this.characteristic;
  }
}

class FakeClient extends EventEmitter {
  public readonly startMode = vi.fn<() => Promise<string | null>>();
  public readonly cancel = vi.fn<() => Promise<string | null>>();

  constructor(public readonly config: any) {
    super();
  }
}

function fakePlatform() {
  return {
    Characteristic: {
      CurrentTemperature: 'CurrentTemperature',
      Name: 'Name',
      On: 'On',
      ProgrammableSwitchEvent: { SINGLE_PRESS: 0 },
    },
    Service: {
      Doorbell: 'Doorbell',
      Switch: 'Switch',
      TemperatureSensor: 'TemperatureSensor',
    },
    log: { warn: vi.fn() },
  };
}

describe('JuneDoorbellAccessory', () => {
  it('rings once for a sustained ready state and again after ready resets', () => {
    const service = new FakeService();
    const client = new FakeClient({ doorbell: { name: 'Oven', triggers: { done: false, ready: true } } });
    const accessory = {
      getService: vi.fn(() => service),
      addService: vi.fn(() => service),
    };
    new JuneDoorbellAccessory(fakePlatform() as never, accessory as never, client as never);

    client.emit('telemetry', { ready: true });
    client.emit('telemetry', { ready: true });
    client.emit('telemetry', { currentTempC: 175, ready: true });
    expect(service.updateCharacteristic).toHaveBeenCalledTimes(1);

    client.emit('telemetry', { ready: false });
    client.emit('telemetry', { ready: true });
    expect(service.updateCharacteristic).toHaveBeenCalledTimes(2);
  });
});

describe('JuneModeSwitchAccessory', () => {
  it('ignores stale inactive telemetry while a start command is in flight', async () => {
    const service = new FakeService();
    let resolveStart!: (status: string) => void;
    const client = new FakeClient({ modes: [{ label: 'Bake', primitiveType: 'bake', tempF: 350 }] });
    client.startMode.mockReturnValue(new Promise(resolve => { resolveStart = resolve; }));
    const accessory = {
      services: [],
      getServiceById: vi.fn(() => service),
      addService: vi.fn(() => service),
      removeService: vi.fn(),
    };
    new JuneModeSwitchAccessory(fakePlatform() as never, accessory as never, client as never);

    const setting = service.characteristic.setHandler?.(true);
    client.emit('telemetry', { active: false });
    expect(service.updateCharacteristic).not.toHaveBeenCalledWith('On', false);

    resolveStart('success');
    await setting;
    expect(service.updateCharacteristic).not.toHaveBeenCalledWith('On', false);
  });

  it('keeps telemetry guarded until queued mode commands have both settled', async () => {
    const bake = new FakeService();
    const roast = new FakeService();
    const resolvers: Array<(status: string) => void> = [];
    const client = new FakeClient({ modes: [
      { label: 'Bake', primitiveType: 'bake', tempF: 350 },
      { label: 'Roast', primitiveType: 'roast', tempF: 400 },
    ] });
    client.startMode.mockImplementation(() => new Promise(resolve => resolvers.push(resolve)));
    const accessory = {
      services: [],
      getServiceById: vi.fn((_type, subtype) => subtype === 'mode-bake' ? bake : roast),
      addService: vi.fn(),
      removeService: vi.fn(),
    };
    new JuneModeSwitchAccessory(fakePlatform() as never, accessory as never, client as never);

    const first = bake.characteristic.setHandler?.(true);
    const second = roast.characteristic.setHandler?.(true);
    await Promise.resolve();
    const firstResolver = resolvers.shift();
    firstResolver?.('success');
    await first;
    bake.updateCharacteristic.mockClear();
    roast.updateCharacteristic.mockClear();

    client.emit('telemetry', { active: false });
    expect(bake.updateCharacteristic).not.toHaveBeenCalledWith('On', false);
    expect(roast.updateCharacteristic).not.toHaveBeenCalledWith('On', false);

    await Promise.resolve();
    const secondResolver = resolvers.shift();
    secondResolver?.('success');
    await second;
  });
});

describe('JuneProbeSensorAccessory', () => {
  it('widens the HomeKit temperature range for food and cavity-air readings', () => {
    const service = new FakeService();
    const client = new FakeClient({ probeSensors: { name: 'Food Probe' } });
    const accessory = {
      getServiceById: vi.fn(() => undefined),
      removeService: vi.fn(),
      getService: vi.fn(() => service),
      addService: vi.fn(() => service),
    };
    new JuneProbeSensorAccessory(fakePlatform() as never, accessory as never, client as never);

    expect(service.characteristic.setProps).toHaveBeenCalledWith({ minValue: -20, maxValue: 300 });
  });
});
