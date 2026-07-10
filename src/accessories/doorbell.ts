import type { PlatformAccessory, Service } from 'homebridge';
import type { JuneClient, JuneTelemetry } from '../june-client';
import type { JunePlatform } from '../platform';

/**
 * Plain HomeKit Doorbell that "rings" on configured cook events (done/ready).
 * Structured so a Camera service can be attached later to promote this into a
 * Video Doorbell whose notification carries the interior snapshot.
 */
export class JuneDoorbellAccessory {
  private readonly service: Service;

  constructor(
    private readonly platform: JunePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly client: JuneClient,
  ) {
    const { Service, Characteristic } = this.platform;
    this.service = accessory.getService(Service.Doorbell) || accessory.addService(Service.Doorbell);
    this.service.setCharacteristic(Characteristic.Name, this.client.config.doorbell.name);
    this.client.on('telemetry', telemetry => this.update(telemetry));
  }

  private update(telemetry: JuneTelemetry): void {
    const triggers = this.client.config.doorbell.triggers;
    if ((triggers.done && telemetry.done) || (triggers.ready && telemetry.ready)) {
      this.press();
    }
  }

  private press(): void {
    this.service.updateCharacteristic(
      this.platform.Characteristic.ProgrammableSwitchEvent,
      this.platform.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
    );
  }
}
