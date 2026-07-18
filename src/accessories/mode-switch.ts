import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { JuneClient, JuneTelemetry } from '../june-client';
import type { JunePlatform } from '../platform';
import type { JuneModeConfig } from '../protocol';

/**
 * One accessory hosting a Switch service per user-configured cook mode. Modes
 * are mutually exclusive: turning one on starts that cook and turns the others
 * off; turning one off cancels the cook. Only one cook runs at a time on the
 * oven, so this mirrors the oven's real behavior.
 */
export class JuneModeSwitchAccessory {
  private readonly services = new Map<string, { service: Service; mode: JuneModeConfig }>();
  private commandInFlight = false;
  private queuedCommands = 0;
  private commandTail: Promise<void> = Promise.resolve();
  // Set to the subtype of a mode whose start was acked but which the oven has
  // not yet reported as 'active' (e.g. still preheating). While set, inactive
  // telemetry must not flip the just-enabled switch back off.
  private awaitingActiveSubtype?: string;
  private awaitingActiveExpiry?: NodeJS.Timeout;

  constructor(
    private readonly platform: JunePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly client: JuneClient,
  ) {
    const { Service, Characteristic } = this.platform;
    const configuredSubtypes = new Set(this.client.config.modes.map(mode => `mode-${mode.primitiveType}`));
    // Iterate a snapshot: removeService() splices the live services array, which
    // would otherwise skip the element shifted into the removed slot.
    for (const service of [...this.accessory.services]) {
      if (service.subtype?.startsWith('mode-') && !configuredSubtypes.has(service.subtype)) {
        this.accessory.removeService(service);
      }
    }
    for (const mode of this.client.config.modes) {
      const subtype = `mode-${mode.primitiveType}`;
      const service = this.accessory.getServiceById(Service.Switch, subtype)
        || this.accessory.addService(Service.Switch, mode.label, subtype);
      service.setCharacteristic(Characteristic.Name, mode.label);
      service.getCharacteristic(Characteristic.On).onSet(value => this.setOn(subtype, value));
      this.services.set(subtype, { service, mode });
    }
    this.client.on('telemetry', telemetry => this.update(telemetry));
  }

  private update(telemetry: JuneTelemetry): void {
    if (telemetry.active === true) {
      this.clearAwaitingActiveLatch();
      return;
    }
    if (this.commandInFlight || telemetry.active !== false) {
      return;
    }
    if (this.awaitingActiveSubtype) {
      // A start was acked but the oven has not reported 'active' yet; keep the
      // switch on until it does (or until the mode is cancelled).
      return;
    }
    this.setAllOff();
  }

  private clearAwaitingActiveLatch(): void {
    clearTimeout(this.awaitingActiveExpiry);
    this.awaitingActiveExpiry = undefined;
    this.awaitingActiveSubtype = undefined;
  }

  private setAllOff(except?: string): void {
    for (const [subtype, { service }] of this.services) {
      if (subtype !== except) {
        service.updateCharacteristic(this.platform.Characteristic.On, false);
      }
    }
  }

  private setOn(subtype: string, value: CharacteristicValue): Promise<void> {
    this.queuedCommands++;
    this.commandInFlight = true;
    const operation = this.commandTail.then(() => this.runCommand(subtype, value));
    this.commandTail = operation.catch(() => undefined);
    return operation.finally(() => {
      this.queuedCommands--;
      this.commandInFlight = this.queuedCommands > 0;
    });
  }

  private async runCommand(subtype: string, value: CharacteristicValue): Promise<void> {
    const entry = this.services.get(subtype);
    if (!entry) {
      return;
    }
    const status = value
      ? await this.client.startMode(entry.mode.primitiveType, entry.mode.tempF)
      : await this.client.cancel();
    if (status !== 'success') {
      entry.service.updateCharacteristic(this.platform.Characteristic.On, !value);
      this.platform.log.warn(`June rejected ${entry.mode.label} command: ${status || 'no ack'}`);
      return;
    }
    if (value) {
      this.clearAwaitingActiveLatch();
      this.awaitingActiveSubtype = subtype;
      this.awaitingActiveExpiry = setTimeout(() => {
        if (this.awaitingActiveSubtype === subtype) {
          this.platform.log.warn(`Clearing activation latch for ${entry.mode.label} after 90s without 'active' telemetry.`);
          this.clearAwaitingActiveLatch();
        }
      }, 90_000);
      this.awaitingActiveExpiry.unref?.();
      this.setAllOff(subtype);
    } else {
      this.clearAwaitingActiveLatch();
    }
  }
}
