# Expanded HomeKit Features Implementation Plan

> **Historical plan:** This records the initial implementation sequence, including protocol assumptions that were later replaced by live captures. The shipped contract is documented in the expanded-features design and README. Camera and ffmpeg streaming were added after the original scoped tasks once Spike A confirmed the `10011` still-image feed.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in cook-done doorbell, food-probe temperature sensors, and config-driven cook-mode switches to `homebridge-june-oven`, and document why timer/progress are intentionally omitted.

**Architecture:** Follow the existing dynamic-platform pattern. Keep all testable logic as pure functions in `protocol.ts` / `june-client.ts` (unit-tested with vitest); keep accessory classes as thin HomeKit glue wired in `platform.ts`. Every new feature is a per-oven opt-in config flag defaulting to off/empty.

**Tech Stack:** TypeScript, Homebridge dynamic platform API (hap-nodejs), vitest.

## Global Constraints

- Node floors: `18.20.4+`, `20.19.0+`, `22.12.0+`, or `24+`. Homebridge `>=1.8.0`.
- Every new feature is **opt-in**, default off (doorbell) or empty (modes, probes). Upgrading an existing install must change no behavior.
- Temperature on the wire is milli-°C; convert with existing helpers (`fahrenheitToMilliC`, `milliCToCelsius`). HomeKit temperature characteristics are Celsius.
- No new npm runtime dependencies. Camera/streaming/ffmpeg were deferred from the original task sequence to Spike A, then delivered in the same feature branch after the camera feed was confirmed.
- Test runner: `npm test` (vitest run). Type-check: `npm run lint` (`tsc --noEmit`).
- Commit after each task with a `feat:`/`docs:` message.

---

### Task 1: Config types & normalization for new options

**Files:**
- Modify: `src/protocol.ts` (extend `JuneOvenConfig`, `NormalizedJuneConfig`, `normalizeOvenConfig`)
- Test: `src/protocol.test.ts`

**Interfaces:**
- Produces:
  - `interface JuneModeConfig { label: string; primitiveType: string; tempF: number }`
  - `interface JuneDoorbellConfig { enabled: boolean; name: string; triggers: { done: boolean; ready: boolean; doorOpen: boolean } }`
  - `JuneOvenConfig` gains optional `doorbell?`, `modes?: JuneModeConfig[]`, `probeSensors?: { enabled?: boolean; leftName?: string; rightName?: string }`
  - `NormalizedJuneConfig` gains `doorbell: JuneDoorbellConfig`, `modes: JuneModeConfig[]`, `probeSensors: { enabled: boolean; leftName: string; rightName: string }`
  - `normalizeOvenConfig` fills these with safe defaults (doorbell disabled, empty modes, probes disabled).

- [ ] **Step 1: Write the failing test**

Add to `src/protocol.test.ts`:

```ts
import { normalizeOvenConfig } from './protocol';

const base = {
  ovenId: 'o', deviceId: 'd', deviceName: 'n', password: 'p', ed25519SeedHex: 'ab',
};

describe('normalizeOvenConfig new options', () => {
  it('defaults doorbell to disabled with all triggers off', () => {
    const n = normalizeOvenConfig(base);
    expect(n.doorbell).toEqual({
      enabled: false,
      name: 'June Doorbell',
      triggers: { done: false, ready: false, doorOpen: false },
    });
  });

  it('defaults modes to an empty array and probeSensors to disabled', () => {
    const n = normalizeOvenConfig(base);
    expect(n.modes).toEqual([]);
    expect(n.probeSensors).toEqual({ enabled: false, leftName: 'Left Probe', rightName: 'Right Probe' });
  });

  it('passes through configured modes and doorbell triggers', () => {
    const n = normalizeOvenConfig({
      ...base,
      doorbell: { enabled: true, triggers: { done: true } },
      modes: [{ label: 'Broil', primitiveType: 'broil', tempF: 500 }],
      probeSensors: { enabled: true, leftName: 'Roast' },
    });
    expect(n.doorbell.enabled).toBe(true);
    expect(n.doorbell.triggers).toEqual({ done: true, ready: false, doorOpen: false });
    expect(n.modes).toEqual([{ label: 'Broil', primitiveType: 'broil', tempF: 500 }]);
    expect(n.probeSensors).toEqual({ enabled: true, leftName: 'Roast', rightName: 'Right Probe' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/protocol.test.ts`
Expected: FAIL — `n.doorbell` is undefined / property missing.

- [ ] **Step 3: Write minimal implementation**

In `src/protocol.ts`, add the interfaces above the existing `JuneOvenConfig`:

```ts
export interface JuneModeConfig {
  label: string;
  primitiveType: string;
  tempF: number;
}

export interface JuneDoorbellConfig {
  enabled: boolean;
  name: string;
  triggers: { done: boolean; ready: boolean; doorOpen: boolean };
}

export interface JuneProbeSensorsConfig {
  enabled: boolean;
  leftName: string;
  rightName: string;
}
```

Extend `JuneOvenConfig` with:

```ts
  doorbell?: Partial<Omit<JuneDoorbellConfig, 'triggers'>> & { triggers?: Partial<JuneDoorbellConfig['triggers']> };
  modes?: JuneModeConfig[];
  probeSensors?: Partial<JuneProbeSensorsConfig>;
```

Extend `NormalizedJuneConfig` with:

```ts
  doorbell: JuneDoorbellConfig;
  modes: JuneModeConfig[];
  probeSensors: JuneProbeSensorsConfig;
```

In `normalizeOvenConfig`, add to the returned object (before the closing `}`):

```ts
    doorbell: {
      enabled: config.doorbell?.enabled ?? false,
      name: config.doorbell?.name || 'June Doorbell',
      triggers: {
        done: config.doorbell?.triggers?.done ?? false,
        ready: config.doorbell?.triggers?.ready ?? false,
        doorOpen: config.doorbell?.triggers?.doorOpen ?? false,
      },
    },
    modes: (config.modes ?? [])
      .filter(m => m && typeof m.primitiveType === 'string' && m.primitiveType.length > 0)
      .map(m => ({ label: m.label || m.primitiveType, primitiveType: m.primitiveType, tempF: m.tempF ?? 350 })),
    probeSensors: {
      enabled: config.probeSensors?.enabled ?? false,
      leftName: config.probeSensors?.leftName || 'Left Probe',
      rightName: config.probeSensors?.rightName || 'Right Probe',
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/protocol.test.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add src/protocol.ts src/protocol.test.ts
git commit -m "feat: config types and normalization for doorbell, modes, probe sensors"
```

---

### Task 2: Probe temperature telemetry parsing

**Files:**
- Modify: `src/june-client.ts` (extend `JuneTelemetry`, add exported pure parser, call it in `handleMessage`)
- Test: `src/june-client.test.ts` (create)

**Interfaces:**
- Consumes: nothing from prior tasks.
- Produces:
  - `JuneTelemetry` gains `probeLeftC?: number; probeRightC?: number; probePresent?: boolean`.
  - `export function parseProbeTelemetry(data: any): Pick<JuneTelemetry, 'probeLeftC' | 'probeRightC' | 'probePresent'>`
  - Field paths are the spec's documented guess (`sensor_data.left_probe`, `sensor_data.right_probe`, `sensor_data.probe_temperature`, `food_present`). Parser tolerates missing paths. **Verify against a live probe capture (Spike B) before release.**

- [ ] **Step 1: Write the failing test**

Create `src/june-client.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseProbeTelemetry } from './june-client';

describe('parseProbeTelemetry', () => {
  it('reads left/right probe milli-C into Celsius', () => {
    const out = parseProbeTelemetry({ sensor_data: { left_probe: 60000, right_probe: 62500 }, food_present: true });
    expect(out).toEqual({ probeLeftC: 60, probeRightC: 62.5, probePresent: true });
  });

  it('falls back to single probe_temperature as the left probe', () => {
    const out = parseProbeTelemetry({ sensor_data: { probe_temperature: 71000 } });
    expect(out.probeLeftC).toBe(71);
    expect(out.probeRightC).toBeUndefined();
  });

  it('returns empty object when no probe data present', () => {
    expect(parseProbeTelemetry({ sensor_data: { cavity: 150000 } })).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/june-client.test.ts`
Expected: FAIL — `parseProbeTelemetry` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/june-client.ts`, extend the `JuneTelemetry` interface:

```ts
  probeLeftC?: number;
  probeRightC?: number;
  probePresent?: boolean;
```

Add the exported parser near the top-level (after the interfaces, before the class):

```ts
export function parseProbeTelemetry(data: any): Pick<JuneTelemetry, 'probeLeftC' | 'probeRightC' | 'probePresent'> {
  const sensor = data?.sensor_data ?? {};
  const out: Pick<JuneTelemetry, 'probeLeftC' | 'probeRightC' | 'probePresent'> = {};
  const left = typeof sensor.left_probe === 'number' ? sensor.left_probe
    : typeof sensor.probe_temperature === 'number' ? sensor.probe_temperature : undefined;
  if (typeof left === 'number') {
    out.probeLeftC = milliCToCelsius(left);
  }
  if (typeof sensor.right_probe === 'number') {
    out.probeRightC = milliCToCelsius(sensor.right_probe);
  }
  if (typeof data?.food_present === 'boolean') {
    out.probePresent = data.food_present;
  }
  return out;
}
```

In `handleMessage`, inside the existing `if (frame.message_code === 10013)` branch, merge probe data into the telemetry update:

```ts
    if (frame.message_code === 10013) {
      this.applyTelemetry({
        currentTempC: typeof data.sensor_data?.cavity === 'number' ? milliCToCelsius(data.sensor_data.cavity) : undefined,
        ready: typeof data.cook_state_data?.progress === 'number' && data.cook_state_data.progress >= 0.995,
        ...parseProbeTelemetry(data),
      });
      return;
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/june-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/june-client.ts src/june-client.test.ts
git commit -m "feat: parse food-probe temperatures from 10013 telemetry"
```

---

### Task 3: startMode helper on JuneClient

**Files:**
- Modify: `src/june-client.ts` (add `startMode`)
- Test: covered indirectly; add a smoke assertion in `src/june-client.test.ts`

**Interfaces:**
- Consumes: `fahrenheitToMilliC`, `MC_PREHEAT` (already imported), `this.sendCommand`.
- Produces: `public startMode(primitiveType: string, tempF: number): Promise<string | null>` — sends `11002` with the given mode; clears `lastCancelled`. This is what the mode switches call (the existing `preheat()` hardcodes config defaults; `startMode` is the arbitrary-mode variant).

- [ ] **Step 1: Write the failing test**

Add to `src/june-client.test.ts`:

```ts
import { JuneClient } from './june-client';

describe('startMode', () => {
  it('exists as a method that returns a promise', () => {
    const client = new JuneClient({
      ovenId: 'o', deviceId: 'd', deviceName: 'n', password: 'p', ed25519SeedHex: 'ab',
    }, { debug() {}, warn() {}, error() {} });
    expect(typeof client.startMode).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/june-client.test.ts`
Expected: FAIL — `client.startMode` is not a function.

- [ ] **Step 3: Write minimal implementation**

In `src/june-client.ts`, add after the existing `preheat` method:

```ts
  public async startMode(primitiveType: string, tempF: number): Promise<string | null> {
    this.lastCancelled = false;
    return this.sendCommand(MC_PREHEAT, { primitive_type: primitiveType, temperature_cavity: fahrenheitToMilliC(tempF) });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/june-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/june-client.ts src/june-client.test.ts
git commit -m "feat: add startMode helper for arbitrary cook modes"
```

---

### Task 4: Doorbell accessory (plain)

**Files:**
- Create: `src/accessories/doorbell.ts`
- Test: none (thin HomeKit glue; verified by build + manual). Logic being tested (trigger events) lives in `JuneClient` and is already covered.

**Interfaces:**
- Consumes: `JuneClient` telemetry events (`ready`, `done`), `JuneDoorbellConfig` (from `client.config.doorbell`).
- Produces: `export class JuneDoorbellAccessory { constructor(platform: JunePlatform, accessory: PlatformAccessory, client: JuneClient) }`
  - Adds a `Doorbell` service; on a configured trigger, updates `ProgrammableSwitchEvent` to `SINGLE_PRESS`.
  - Structured so a Camera service can be attached later (spec: promote to Video Doorbell); no camera in this task.

- [ ] **Step 1: Write the accessory**

Create `src/accessories/doorbell.ts`:

```ts
import type { PlatformAccessory, Service } from 'homebridge';
import type { JuneClient, JuneTelemetry } from '../june-client';
import type { JunePlatform } from '../platform';

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
```

Note on `doorOpen`: intentionally not wired — no confirmed signal (spec Spike C). The config toggle exists but never fires until a signal is captured.

- [ ] **Step 2: Verify it type-checks**

Run: `npm run lint`
Expected: PASS (no type errors).

- [ ] **Step 3: Commit**

```bash
git add src/accessories/doorbell.ts
git commit -m "feat: add plain cook-done doorbell accessory"
```

---

### Task 5: Cook-mode switches accessory

**Files:**
- Create: `src/accessories/mode-switch.ts`
- Test: none (thin glue; `startMode`/`cancel` already covered).

**Interfaces:**
- Consumes: `JuneClient.startMode`, `JuneClient.cancel`, `client.config.modes` (`JuneModeConfig[]`), telemetry `active`.
- Produces: `export class JuneModeSwitchAccessory { constructor(platform, accessory, client) }` — one accessory hosting one `Switch` service per configured mode (distinct subtype per `primitiveType`). Turning a switch on calls `startMode` and turns sibling switches off (mutually exclusive). Telemetry `active === false` turns all off.

- [ ] **Step 1: Write the accessory**

Create `src/accessories/mode-switch.ts`:

```ts
import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { JuneClient, JuneTelemetry } from '../june-client';
import type { JunePlatform } from '../platform';
import type { JuneModeConfig } from '../protocol';

export class JuneModeSwitchAccessory {
  private readonly services = new Map<string, { service: Service; mode: JuneModeConfig }>();

  constructor(
    private readonly platform: JunePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly client: JuneClient,
  ) {
    const { Service, Characteristic } = this.platform;
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
    if (telemetry.active === false) {
      this.setAllOff();
    }
  }

  private setAllOff(except?: string): void {
    for (const [subtype, { service }] of this.services) {
      if (subtype !== except) {
        service.updateCharacteristic(this.platform.Characteristic.On, false);
      }
    }
  }

  private async setOn(subtype: string, value: CharacteristicValue): Promise<void> {
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
      this.setAllOff(subtype);
    }
  }
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/accessories/mode-switch.ts
git commit -m "feat: add config-driven cook-mode switches"
```

---

### Task 6: Probe temperature sensor accessory

**Files:**
- Create: `src/accessories/probe-sensor.ts`
- Test: none (parsing covered in Task 2).

**Interfaces:**
- Consumes: telemetry `probeLeftC`, `probeRightC`; `client.config.probeSensors` names.
- Produces: `export class JuneProbeSensorAccessory { constructor(platform, accessory, client) }` — one accessory with two `TemperatureSensor` services (left/right, distinct subtypes). Each updates `CurrentTemperature` from telemetry; when a probe reports no value, it retains its last reading.

- [ ] **Step 1: Write the accessory**

Create `src/accessories/probe-sensor.ts`:

```ts
import type { PlatformAccessory, Service } from 'homebridge';
import type { JuneClient, JuneTelemetry } from '../june-client';
import type { JunePlatform } from '../platform';

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
```

- [ ] **Step 2: Verify it type-checks**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/accessories/probe-sensor.ts
git commit -m "feat: add food-probe temperature sensor accessory"
```

---

### Task 7: Wire new accessories into the platform

**Files:**
- Modify: `src/platform.ts`
- Test: none (integration wiring; verified by build).

**Interfaces:**
- Consumes: `JuneDoorbellAccessory`, `JuneModeSwitchAccessory`, `JuneProbeSensorAccessory` (Tasks 4–6); normalized config from Task 1.
- Produces: platform registers the new accessories only when their config opts in.

- [ ] **Step 1: Add imports and extend AccessoryKind**

In `src/platform.ts`, add imports:

```ts
import { JuneDoorbellAccessory } from './accessories/doorbell';
import { JuneModeSwitchAccessory } from './accessories/mode-switch';
import { JuneProbeSensorAccessory } from './accessories/probe-sensor';
```

Change the `AccessoryKind` type:

```ts
type AccessoryKind = 'thermostat' | 'preheat' | 'ready' | 'done' | 'doorbell' | 'modes' | 'probes';
```

- [ ] **Step 2: Bind the new accessories in `discover`**

In `discover`, after the existing `done` binding block and before `client.start()`, add:

```ts
      const normalized = client.config;
      if (normalized.doorbell.enabled) {
        this.bindAccessory(client, 'doorbell', normalized.doorbell.name, wanted);
      }
      if (normalized.modes.length > 0) {
        this.bindAccessory(client, 'modes', `${oven.name || 'June'} Modes`, wanted);
      }
      if (normalized.probeSensors.enabled) {
        this.bindAccessory(client, 'probes', `${oven.name || 'June'} Probes`, wanted);
      }
```

- [ ] **Step 3: Construct the new accessories in `bindAccessory`**

Replace the trailing `if/else if/else` chain in `bindAccessory` with:

```ts
    if (kind === 'thermostat') {
      new JuneThermostatAccessory(this, accessory, client);
    } else if (kind === 'preheat') {
      new JunePreheatSwitchAccessory(this, accessory, client);
    } else if (kind === 'doorbell') {
      new JuneDoorbellAccessory(this, accessory, client);
    } else if (kind === 'modes') {
      new JuneModeSwitchAccessory(this, accessory, client);
    } else if (kind === 'probes') {
      new JuneProbeSensorAccessory(this, accessory, client);
    } else {
      new JuneOccupancySensorAccessory(this, accessory, client, kind as 'ready' | 'done');
    }
```

- [ ] **Step 4: Verify build + full test suite**

Run: `npm run lint && npm test`
Expected: PASS (type-check clean, all tests green).

- [ ] **Step 5: Commit**

```bash
git add src/platform.ts
git commit -m "feat: register doorbell, mode-switch, and probe-sensor accessories"
```

---

### Task 8: Config UI schema

**Files:**
- Modify: `config.schema.json`
- Test: none (JSON schema; validated by loading in Homebridge UI — verify JSON parses).

**Interfaces:**
- Consumes: config shape from Task 1.
- Produces: Config UI fields for doorbell (enabled + trigger toggles + name), modes (array of label/primitiveType/tempF with seeded disabled examples in the description), probe sensors (enabled + names).

- [ ] **Step 1: Add properties**

In `config.schema.json`, inside `schema.properties.ovens.items.properties`, after `tempUnit` and before `ovenId`, add:

```json
            "doorbell": {
              "title": "Cook Doorbell",
              "type": "object",
              "properties": {
                "enabled": { "title": "Enable Doorbell", "type": "boolean", "default": false },
                "name": { "title": "Doorbell Name", "type": "string", "default": "June Doorbell" },
                "triggers": {
                  "type": "object",
                  "properties": {
                    "done": { "title": "Ring when cook is done", "type": "boolean", "default": false },
                    "ready": { "title": "Ring when preheat/ready", "type": "boolean", "default": false },
                    "doorOpen": { "title": "Ring on door open (not yet supported)", "type": "boolean", "default": false }
                  }
                }
              }
            },
            "probeSensors": {
              "title": "Food Probe Temperature Sensors",
              "type": "object",
              "properties": {
                "enabled": { "title": "Enable Probe Sensors", "type": "boolean", "default": false },
                "leftName": { "title": "Left Probe Name", "type": "string", "default": "Left Probe" },
                "rightName": { "title": "Right Probe Name", "type": "string", "default": "Right Probe" }
              }
            },
            "modes": {
              "title": "Cook Mode Switches",
              "type": "array",
              "default": [],
              "description": "Add a switch for each cook mode you want. primitiveType is the June mode id (e.g. bake, roast, broil, air_fry, toast) — you can enter any value the oven supports.",
              "items": {
                "type": "object",
                "properties": {
                  "label": { "title": "Switch Name", "type": "string" },
                  "primitiveType": { "title": "June Mode (primitive_type)", "type": "string" },
                  "tempF": { "title": "Temperature (F)", "type": "integer", "default": 350, "minimum": 100, "maximum": 550 }
                },
                "required": ["primitiveType"]
              }
            },
```

- [ ] **Step 2: Add form entries**

In the `form` array's `ovens` `items` list, after `"ovens[].tempUnit"`, add:

```json
        "ovens[].doorbell.enabled",
        "ovens[].doorbell.name",
        "ovens[].doorbell.triggers.done",
        "ovens[].doorbell.triggers.ready",
        "ovens[].doorbell.triggers.doorOpen",
        "ovens[].probeSensors.enabled",
        "ovens[].probeSensors.leftName",
        "ovens[].probeSensors.rightName",
        { "key": "ovens[].modes", "type": "array", "items": ["ovens[].modes[].label", "ovens[].modes[].primitiveType", "ovens[].modes[].tempF"] }
```

- [ ] **Step 3: Verify JSON parses**

Run: `node -e "JSON.parse(require('fs').readFileSync('config.schema.json','utf8')); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 4: Commit**

```bash
git add config.schema.json
git commit -m "feat: config UI for doorbell, probe sensors, and cook-mode switches"
```

---

### Task 9: README documentation

**Files:**
- Modify: `README.md`

**Interfaces:** none.

- [ ] **Step 1: Document the new features and the intentional omissions**

In `README.md`, under the `## Features` list, add bullet points for the doorbell, probe sensors, and cook-mode switches (all noted as opt-in). Then add a new section:

```markdown
## Not exposed (and why)

- **Cook timer** — the oven accepts a set-timer command, but HomeKit has no timer/countdown
  surface for a thermostat-style accessory, so there is nowhere sensible to put it. Use a Home
  automation on the Done doorbell/sensor instead.
- **Cook progress %** — HomeKit has no native "percent complete" characteristic, so progress is
  used internally only (to drive the Ready/Done triggers) rather than shown as its own tile.
- **Interior camera / live video** — the oven has an interior camera, but wiring its snapshot
  into a HomeKit camera (and a Video Doorbell that shows a photo of your food) needs one more
  protocol capture to confirm how the current image URL is delivered. It is planned; see
  `docs/superpowers/specs/2026-07-08-june-expanded-homekit-features-design.md`.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document new opt-in features and intentional omissions"
```

---

## Self-Review

**Spec coverage:**
- Feature 1 (doorbell, plain now, architected for camera) → Tasks 4, 7, 8. ✓ (`doorOpen` wired as no-op per spec.)
- Feature 2 (camera) → deferred (Spike A); documented in Task 9 + spec. ✓ (out of scope, stated.)
- Feature 3 (probe sensors) → Tasks 2, 6, 7, 8. ✓ (field path flagged for Spike B verification.)
- Feature 4 (mode switches, user-defined) → Tasks 1, 3, 5, 7, 8. ✓
- README for timer/progress omission → Task 9. ✓
- All opt-in, default off → Task 1 defaults + Task 7 guards + Task 8 defaults. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `startMode(primitiveType, tempF)` used identically in Task 3 (def) and Task 5 (call). `JuneModeConfig`/`JuneDoorbellConfig`/`probeSensors` shapes match between Task 1 (def) and Tasks 4–8 (use). `parseProbeTelemetry` returns the same `probeLeftC/probeRightC/probePresent` fields added to `JuneTelemetry`. Accessory constructor signatures `(platform, accessory, client)` match `bindAccessory` calls. ✓

**Known limitation carried from spec:** probe field paths and camera are unverified pending captures that require the Android app + Frida (not runnable here); implemented defensively and documented, not blocking the buildable features.
