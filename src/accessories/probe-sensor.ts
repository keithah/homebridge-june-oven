import type { PlatformAccessory, Service } from 'homebridge';
import type { JuneClient, JuneTelemetry } from '../june-client';
import type { JunePlatform } from '../platform';

/**
 * Exposes the oven's single food probe as a HomeKit Temperature Sensor, so
 * users can automate on "probe reached X". Retains its last reading between
 * telemetry updates.
 */
export class JuneProbeSensorAccessory {
  private readonly service: Service;

  constructor(
    private readonly platform: JunePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly client: JuneClient,
  ) {
    const { Service, Characteristic } = this.platform;
    const cfg = this.client.config.probeSensors;
    // Remove legacy dual-probe services from earlier builds that created
    // 'probe-left'/'probe-right' subtyped sensors before we confirmed the oven
    // has a single probe. Otherwise a stale "Right Probe" tile lingers.
    for (const subtype of ['probe-left', 'probe-right']) {
      const stale = this.accessory.getServiceById(Service.TemperatureSensor, subtype);
      if (stale) {
        this.accessory.removeService(stale);
      }
    }
    this.service = this.accessory.getService(Service.TemperatureSensor) || this.accessory.addService(Service.TemperatureSensor);
    this.service.setCharacteristic(Characteristic.Name, cfg.name);
    this.service.getCharacteristic(Characteristic.CurrentTemperature).setProps({ minValue: -20, maxValue: 300 });
    this.client.on('telemetry', telemetry => this.update(telemetry));
  }

  private update(telemetry: JuneTelemetry): void {
    if (typeof telemetry.probeC === 'number') {
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, telemetry.probeC);
    } else if (telemetry.probePresent === false) {
      // The probe was unplugged: drop the last (possibly hot) reading to 0 °C so
      // automations don't stay latched on a value the oven is no longer reporting.
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, 0);
    }
  }
}
