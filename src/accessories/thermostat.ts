import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { JuneClient, JuneTelemetry } from '../june-client';
import type { JunePlatform } from '../platform';

export class JuneThermostatAccessory {
  private readonly service: Service;
  private targetTempC: number;
  private active = false;

  constructor(
    private readonly platform: JunePlatform,
    accessory: PlatformAccessory,
    private readonly client: JuneClient,
  ) {
    const { Service, Characteristic } = this.platform;
    this.targetTempC = (this.client.config.defaultTempF - 32) * 5 / 9;
    accessory.getService(Service.AccessoryInformation)
      ?.setCharacteristic(Characteristic.Manufacturer, 'June')
      .setCharacteristic(Characteristic.Model, 'June Oven');
    this.service = accessory.getService(Service.Thermostat) || accessory.addService(Service.Thermostat);
    this.service.setCharacteristic(Characteristic.Name, this.client.config.name);
    this.service.getCharacteristic(Characteristic.CurrentTemperature).setProps({ minValue: 0, maxValue: 300 });
    this.service.getCharacteristic(Characteristic.TargetTemperature).setProps({ minValue: 10, maxValue: 260, minStep: 1 });
    this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({
      validValues: [Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.HEAT],
    });
    this.service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .updateValue(this.client.config.tempUnit === 'F' ? Characteristic.TemperatureDisplayUnits.FAHRENHEIT : Characteristic.TemperatureDisplayUnits.CELSIUS);
    this.service.getCharacteristic(Characteristic.TargetTemperature)
      .onSet(value => this.setTargetTemperature(Number(value)));
    this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .onSet(value => this.setHeatingState(value));
    this.client.on('telemetry', telemetry => this.update(telemetry));
  }

  public update(telemetry: JuneTelemetry): void {
    const { Characteristic } = this.platform;
    if (typeof telemetry.currentTempC === 'number') {
      this.service.updateCharacteristic(Characteristic.CurrentTemperature, telemetry.currentTempC);
    }
    if (typeof telemetry.targetTempC === 'number') {
      this.targetTempC = telemetry.targetTempC;
      this.service.updateCharacteristic(Characteristic.TargetTemperature, telemetry.targetTempC);
    }
    if (typeof telemetry.active === 'boolean') {
      this.active = telemetry.active;
      this.service.updateCharacteristic(
        Characteristic.CurrentHeatingCoolingState,
        telemetry.active ? Characteristic.CurrentHeatingCoolingState.HEAT : Characteristic.CurrentHeatingCoolingState.OFF,
      );
      this.service.updateCharacteristic(
        Characteristic.TargetHeatingCoolingState,
        telemetry.active ? Characteristic.TargetHeatingCoolingState.HEAT : Characteristic.TargetHeatingCoolingState.OFF,
      );
    }
  }

  private async setTargetTemperature(value: number): Promise<void> {
    const previous = this.targetTempC;
    this.targetTempC = value;
    if (!this.active) {
      return;
    }
    // June rejects (or silently ignores) changing an already-active cook's
    // target temperature directly — confirmed live: re-issuing preheat()
    // while active gets acked "not-allowed", and the old MC_TEMP primitive
    // acks "success" without actually changing the oven's target. Cancelling
    // first and then preheating at the new temperature is what actually
    // works, verified by polling fetchStatus() afterward.
    const tempF = Math.round(value * 9 / 5 + 32);
    await this.client.cancel();
    const status = await this.client.preheat(this.client.config.defaultMode, tempF);
    if (status !== 'success') {
      this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, previous);
      this.platform.log.warn(`June rejected target temperature change: ${status || 'no ack'}`);
    }
  }

  private async setHeatingState(value: CharacteristicValue): Promise<void> {
    const { Characteristic } = this.platform;
    const status = Number(value) === Characteristic.TargetHeatingCoolingState.OFF
      ? await this.client.cancel()
      : await this.client.preheat(this.client.config.defaultMode, Math.round(this.targetTempC * 9 / 5 + 32));
    if (status !== 'success') {
      this.service.updateCharacteristic(Characteristic.TargetHeatingCoolingState, this.active ? Characteristic.TargetHeatingCoolingState.HEAT : Characteristic.TargetHeatingCoolingState.OFF);
      this.platform.log.warn(`June rejected thermostat command: ${status || 'no ack'}`);
    }
  }
}
