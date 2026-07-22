import type { PlatformAccessory, Service } from 'homebridge';
import type { JuneClient, JuneTelemetry } from '../june-client';
import type { JunePlatform } from '../platform';

export class JuneOccupancySensorAccessory {
  private readonly service: Service;
  private resetTimer?: NodeJS.Timeout;
  private lastValue = false;

  constructor(
    private readonly platform: JunePlatform,
    accessory: PlatformAccessory,
    private readonly client: JuneClient,
    private readonly kind: 'ready' | 'done',
  ) {
    const { Service, Characteristic } = this.platform;
    this.service = accessory.getService(Service.OccupancySensor) || accessory.addService(Service.OccupancySensor);
    this.service.setCharacteristic(Characteristic.Name, accessory.displayName);
    this.service.updateCharacteristic(Characteristic.OccupancyDetected, Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    this.client.on('telemetry', telemetry => this.update(telemetry));
  }

  private update(telemetry: JuneTelemetry): void {
    const value = this.kind === 'ready' ? telemetry.ready : telemetry.done;
    if (value === true && !this.lastValue) {
      this.trip();
    }
    if (typeof value === 'boolean') {
      this.lastValue = value;
    }
    if (this.kind === 'ready' && telemetry.active === true) {
      this.reset();
    }
  }

  private trip(): void {
    this.service.updateCharacteristic(this.platform.Characteristic.OccupancyDetected, this.platform.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED);
    clearTimeout(this.resetTimer);
    this.resetTimer = setTimeout(() => this.reset(), 30_000);
    this.resetTimer.unref?.();
  }

  private reset(): void {
    clearTimeout(this.resetTimer);
    this.resetTimer = undefined;
    this.service.updateCharacteristic(this.platform.Characteristic.OccupancyDetected, this.platform.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
  }
}
