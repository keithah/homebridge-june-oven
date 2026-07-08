import type { PlatformAccessory, Service } from 'homebridge';
import type { JuneClient, JuneTelemetry } from '../june-client';
import type { JunePlatform } from '../platform';

/**
 * Exposes the oven's food-probe temperature(s) as HomeKit Temperature Sensors,
 * so users can automate on "probe reached X". Two probes (left/right) are
 * supported; each retains its last reading between telemetry updates.
 */
export class JuneProbeSensorAccessory {
  private readonly left: Service;
  private readonly right: Service;

  constructor(
    private readonly platform: JunePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly client: JuneClient,
  ) {
    const { Service, Characteristic } = this.platform;
    const cfg = this.client.config.probeSensors;
    this.left = this.accessory.getServiceById(Service.TemperatureSensor, 'probe-left')
      || this.accessory.addService(Service.TemperatureSensor, cfg.leftName, 'probe-left');
    this.left.setCharacteristic(Characteristic.Name, cfg.leftName);
    this.right = this.accessory.getServiceById(Service.TemperatureSensor, 'probe-right')
      || this.accessory.addService(Service.TemperatureSensor, cfg.rightName, 'probe-right');
    this.right.setCharacteristic(Characteristic.Name, cfg.rightName);
    this.client.on('telemetry', telemetry => this.update(telemetry));
  }

  private update(telemetry: JuneTelemetry): void {
    const { Characteristic } = this.platform;
    if (typeof telemetry.probeLeftC === 'number') {
      this.left.updateCharacteristic(Characteristic.CurrentTemperature, telemetry.probeLeftC);
    }
    if (typeof telemetry.probeRightC === 'number') {
      this.right.updateCharacteristic(Characteristic.CurrentTemperature, telemetry.probeRightC);
    }
  }
}
