import type { PlatformAccessory, Service } from 'homebridge';
import type { JuneClient, JuneTelemetry } from '../june-client';
import type { JunePlatform } from '../platform';

/**
 * Rings `press` on the rising edge of a configured cook event (done/ready).
 * Shared by the plain Doorbell accessory and the video-doorbell path (which
 * rings the DoorbellController instead of a bare Doorbell service).
 */
export function watchDoorbellTriggers(client: JuneClient, press: () => void): void {
  let ready = false;
  let done = false;
  client.on('telemetry', (telemetry: JuneTelemetry) => {
    const triggers = client.config.doorbell.triggers;
    const readyEdge = telemetry.ready === true && !ready;
    const doneEdge = telemetry.done === true && !done;
    if (typeof telemetry.ready === 'boolean') {
      ready = telemetry.ready;
    }
    if (typeof telemetry.done === 'boolean') {
      done = telemetry.done;
    }
    if ((triggers.done && doneEdge) || (triggers.ready && readyEdge)) {
      press();
    }
  });
}

/**
 * Plain HomeKit Doorbell (no camera) that "rings" on configured cook events.
 * When a camera is also enabled the platform uses a DoorbellController instead,
 * so this bare Doorbell service is only used for the camera-less case.
 */
export class JuneDoorbellAccessory {
  private readonly service: Service;

  constructor(
    private readonly platform: JunePlatform,
    accessory: PlatformAccessory,
    private readonly client: JuneClient,
  ) {
    const { Service, Characteristic } = this.platform;
    this.service = accessory.getService(Service.Doorbell) || accessory.addService(Service.Doorbell);
    this.service.setCharacteristic(Characteristic.Name, this.client.config.doorbell.name);
    watchDoorbellTriggers(this.client, () => this.press());
  }

  private press(): void {
    this.service.updateCharacteristic(
      this.platform.Characteristic.ProgrammableSwitchEvent,
      this.platform.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
    );
  }
}
