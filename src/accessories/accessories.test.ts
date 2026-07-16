import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JuneDoorbellAccessory } from './doorbell';
import { JuneModeSwitchAccessory } from './mode-switch';
import { JuneOccupancySensorAccessory } from './sensors';

afterEach(() => vi.useRealTimers());

class FakeService {
  public readonly updateCharacteristic = vi.fn(() => this);
  public readonly setCharacteristic = vi.fn(() => this);
  public readonly getCharacteristic = vi.fn(() => ({ onSet: vi.fn() }));
  constructor(public readonly subtype?: string) {}
}

describe('June event accessories', () => {
  it('rings the ready doorbell only on a false-to-true edge', () => {
    const service = new FakeService();
    const client = new EventEmitter() as any;
    client.config = { doorbell: { name: 'June', triggers: { ready: true, done: false } } };
    const platform = fakePlatform();
    const accessory = { getService: () => service, addService: () => service };
    new JuneDoorbellAccessory(platform as never, accessory as never, client);

    client.emit('telemetry', { ready: false });
    client.emit('telemetry', { ready: true });
    client.emit('telemetry', { ready: true });

    expect(service.updateCharacteristic).toHaveBeenCalledTimes(1);
  });

  it('removes cached mode services that are no longer configured', () => {
    const stale = new FakeService('mode-toast');
    const current = new FakeService('mode-bake');
    const services = [stale, current];
    const removeService = vi.fn((service: FakeService) => services.splice(services.indexOf(service), 1));
    const accessory = {
      services,
      getServiceById: (_type: unknown, subtype: string) => services.find(service => service.subtype === subtype),
      addService: (_type: unknown, _name: string, subtype: string) => {
        const service = new FakeService(subtype);
        services.push(service);
        return service;
      },
      removeService,
    };
    const client = new EventEmitter() as any;
    client.config = { modes: [{ label: 'Bake', primitiveType: 'bake', tempF: 350 }] };

    new JuneModeSwitchAccessory(fakePlatform() as never, accessory as never, client);

    expect(removeService).toHaveBeenCalledWith(stale);
  });

  it('does not retrigger a ready sensor until telemetry returns false', async () => {
    vi.useFakeTimers();
    const service = new FakeService();
    const client = new EventEmitter() as any;
    const platform = fakePlatform();
    const accessory = { displayName: 'Ready', getService: () => service, addService: () => service };
    new JuneOccupancySensorAccessory(platform as never, accessory as never, client, 'ready');

    client.emit('telemetry', { ready: true });
    await vi.advanceTimersByTimeAsync(30_000);
    client.emit('telemetry', { ready: true });

    const detected = service.updateCharacteristic.mock.calls.filter(([, value]) => value === 1);
    expect(detected).toHaveLength(1);
  });
});

function fakePlatform() {
  class Switch {}
  return {
    Service: { Doorbell: class Doorbell {}, OccupancySensor: class OccupancySensor {}, Switch },
    Characteristic: {
      Name: 'Name', On: 'On', ProgrammableSwitchEvent: { SINGLE_PRESS: 0 },
      OccupancyDetected: { OCCUPANCY_DETECTED: 1, OCCUPANCY_NOT_DETECTED: 0 },
    },
    log: { warn: vi.fn() },
  };
}
