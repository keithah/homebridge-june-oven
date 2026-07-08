import type { PlatformAccessory, Service } from 'homebridge';
import type { JuneClient, JuneTelemetry } from '../june-client';
import type { JunePlatform } from '../platform';

export class JuneOccupancySensorAccessory {
  private readonly service: Service;

  constructor(
    private readonly platform: JunePlatform,
    private readonly accessory: PlatformAccessory,
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
    if ((this.kind === 'ready' && telemetry.ready) || (this.kind === 'done' && telemetry.done)) {
      this.trip();
    }
    if (this.kind === 'ready' && telemetry.active === true) {
      this.reset();
    }
  }

  private trip(): void {
    this.service.updateCharacteristic(this.platform.Characteristic.OccupancyDetected, this.platform.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED);
    setTimeout(() => this.reset(), 30_000);
  }

  private reset(): void {
    this.service.updateCharacteristic(this.platform.Characteristic.OccupancyDetected, this.platform.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
  }
}
