import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { JuneClient, JuneTelemetry } from '../june-client';
import type { JunePlatform } from '../platform';

export class JunePreheatSwitchAccessory {
  private readonly service: Service;
  private active = false;

  constructor(
    private readonly platform: JunePlatform,
    accessory: PlatformAccessory,
    private readonly client: JuneClient,
  ) {
    const { Service, Characteristic } = this.platform;
    this.service = accessory.getService(Service.Switch) || accessory.addService(Service.Switch);
    this.service.setCharacteristic(Characteristic.Name, this.client.config.preheatSwitchName || 'June Preheat');
    this.service.getCharacteristic(Characteristic.On).onSet(value => this.setOn(value));
    this.client.on('telemetry', telemetry => this.update(telemetry));
  }

  public update(telemetry: JuneTelemetry): void {
    if (typeof telemetry.active === 'boolean') {
      this.active = telemetry.active;
      this.service.updateCharacteristic(this.platform.Characteristic.On, telemetry.active);
    }
  }

  private async setOn(value: CharacteristicValue): Promise<void> {
    const status = value
      ? await this.client.preheat(this.client.config.defaultMode, this.client.config.defaultTempF)
      : await this.client.cancel();
    if (status !== 'success') {
      this.service.updateCharacteristic(this.platform.Characteristic.On, this.active);
      this.platform.log.warn(`June rejected preheat switch command: ${status || 'no ack'}`);
    }
  }
}
