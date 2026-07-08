# June Oven — Expanded HomeKit Features Design

**Date:** 2026-07-08
**Status:** Approved design, pending implementation plan

## Goal

Extend `homebridge-june-oven` beyond its current thermostat + preheat switch + ready/done
occupancy sensors to surface more of the oven's real capabilities in HomeKit. Every new feature
is **opt-in** via the Config UI (default off) so existing users see no behavior change on upgrade.

Four features, in priority order:

1. **Cook-done doorbell** (with the interior-camera snapshot attached to the notification)
2. **Interior camera** (snapshot-only, refreshed periodically to look live)
3. **Food probe temperature sensors**
4. **Config-driven cook-mode switches**

## Source of truth

All protocol facts come from the reverse-engineering research in
`/Users/keith/src/june/June Oven` (`JUNE_INTEGRATION_SPEC.md`, `JUNE_CLOUD_PROTOCOL.md`,
`june_flows.jsonl`), which was captured from the June Android app via an emulator + Frida. No
live emulator run is possible here (the June app is Android; the iOS simulator can't run App
Store builds), so that captured research is authoritative.

### What is already confirmed
- Commands (companion → oven): `11002` preheat/start `{primitive_type, temperature_cavity}`,
  `11005` set-temp, `11006` set-timer, `11004` cancel, `11011` keepalive.
- Telemetry (oven → companion): `10013` live cook telemetry carries `sensor_data.cavity`
  (current temp, milli-°C) and `cook_state_data.progress`; `10018` device state; `10015/10016`
  cook plan / target; `10017` cancelled; `10020` command ack.
- Temperature is milli-°C on the wire (`°F = milliC/1000 × 9/5 + 32`).
- The interior camera exists and produces **periodic JPEG stills** per cook session, stored at
  `api.junelife.com/media/prod/images/1-{sessionId}-{ovenId}/image.jpg_{uuid}.jpe`.

### What is NOT confirmed (drives the two spikes below)
- **`10011` camera frame** (`{video_id, signed_url}`) was never captured (0 frames in the dump).
  It is the only documented way to learn the *current* still's URL — the stored stills have
  unpredictable UUID filenames and there is no listing endpoint in the capture. **The camera
  snapshot and the doorbell thumbnail both depend on capturing one `10011` frame.**
- **Food-probe temperature fields** in `10013` — the spec names `left_probe`/`right_probe`/
  `probe_temperature`, but the exact JSON path was not pinned down in a live probe cook.
- **Door-open** is only observable as a command *rejection reason* (`10020 status:"door-open"`),
  not as a push event. A live door-state signal is unconfirmed.
- **The full mode list** — only `bake`/`roast` are confirmed on-oven; the `/2/devices/{id}/features`
  response body was not captured. This is why cook modes are user-defined, not hardcoded.

## Prerequisite spikes (tasks, not code)

- **Spike A — capture a `10011` frame.** Run the June app through the Android emulator + Frida
  during an active cook, record a `10011` message, and document how the current snapshot URL is
  delivered (signed URL shape, TTL, whether it is a single still or a refreshing sequence). This
  unblocks features 1 (thumbnail) and 2 (camera). Until it lands, the doorbell ships without a
  thumbnail and the camera is not built.
- **Spike B — probe field path.** From the same or a probe-cook capture, confirm the exact
  `10013` JSON path(s) for left/right probe temperature and probe-present. Unblocks feature 3.
- **Spike C (optional) — door-open.** Only needed if the door-open doorbell trigger should
  actually work. Confirm whether any push signal reports door state.

Features 3 and 4 can begin in parallel with Spike A; feature 4 needs no spike.

## Feature 1 — Cook-done doorbell (Video Doorbell accessory)

A single accessory combining a **Doorbell** service and a **Camera** service (feature 2). The
combination is deliberate: HomeKit attaches the linked camera's snapshot to the doorbell's rich
notification, which is what delivers "a photo of your finished food" to the phone and Apple TV.

- The Doorbell service exposes a `ProgrammableSwitchEvent` fired as **single-press** when a
  configured trigger occurs.
- Triggers are **configurable** (all default off):
  - `done` — the cook-complete transition the client already computes (`JuneTelemetry.done`).
  - `ready` — preheat-complete / ready-to-load (`JuneTelemetry.ready`).
  - `doorOpen` — **tentative**; wired behind config but only functional if Spike C confirms a
    signal. If no signal is available it simply never fires; documented as such.
- Before Spike A lands, the accessory is a Doorbell with no usable camera snapshot. Options for
  that interim: ship the doorbell as a plain Doorbell (no camera) and upgrade it to a Video
  Doorbell once the snapshot works, OR gate the whole accessory behind Spike A. **Decision: gate
  the Video Doorbell behind Spike A** so we never expose a broken camera tile; the plain
  ready/done occupancy sensors already cover notifications in the meantime.

Config (per oven): `doorbell` object — `enabled` (bool, default false), `triggers` (object with
`done`/`ready`/`doorOpen` booleans, all default false), `name`.

## Feature 2 — Interior camera (snapshot-only)

A Camera service whose `handleSnapshotRequest` returns the latest interior still as a JPEG.
Explicitly **no live H.264 stream and no HKSV** — HomeKit re-requests the snapshot periodically,
which is enough to "look live" per the user. Streaming/recording are out of scope.

- Snapshot source: the URL learned from Spike A's `10011` frame. The client keeps the most recent
  signed still URL from the telemetry stream; the snapshot handler fetches it (with a short cache
  to avoid hammering the CDN) and returns the bytes. When no cook is active / no still is
  available, return a static placeholder image.
- Depends on Spike A. Config (per oven): `camera.enabled` (bool, default false), `camera.name`.
- Implemented as part of the same accessory as the doorbell (feature 1) when both are enabled;
  camera-only (no doorbell triggers) is also valid.

## Feature 3 — Food probe temperature sensors

Expose the oven's food probe temperature(s) as HomeKit **Temperature Sensor** services, so users
can build automations like "notify when probe reaches 145 °F."

- Source: `10013` telemetry probe fields (exact path from Spike B). Support up to two probes
  (left/right); a sensor is only shown when its probe reports a reading, and reads as inactive /
  its last value otherwise.
- Opt-in. Config (per oven): `probeSensors.enabled` (bool, default false). Optionally a
  `probeSensors.names` map for left/right display names.
- New `JuneTelemetry` fields (e.g. `probeLeftC`, `probeRightC`, `probePresent`) populated in
  `JuneClient.handleMessage` for `10013`; a `JuneProbeSensorAccessory` subscribes to telemetry.

## Feature 4 — Config-driven cook-mode switches

Let users define an arbitrary set of cook-mode start switches in the Config UI, because the full
mode list can't be predicted or enumerated from the capture.

- Config (per oven): `modes` — an array (default empty). Each entry:
  `{ label: string, primitiveType: string, tempF: integer }`. `primitiveType` is free-form so
  unknown/future oven modes work (e.g. `dehydrate`, `pizza`).
- The Config UI schema seeds a set of plausible-but-disabled example entries the user can keep or
  delete (bake/roast/broil/air_fry/toast), and supports adding arbitrary entries.
- Each entry renders as a **Switch** service. Turning one on sends `11002`
  `{primitive_type, temperature_cavity: f2milli(tempF)}`. Switches are **mutually exclusive**:
  turning one on turns the others off (and turning any off while active sends `11004` cancel).
  State is driven back from `10018`/`10017` so HomeKit reflects the real oven state.
- The existing preheat switch stays; its `defaultMode`/`defaultTempF` remain as today.

## Data model / code changes (high level)

- `src/protocol.ts`: add `MC_TIMER = 11006` if timer is used later (not required now); add probe
  temp parsing helpers.
- `src/june-client.ts`: extend `JuneTelemetry` with probe fields, latest-snapshot-URL state, and
  a `ready`-distinct `preheatComplete` if needed; parse probe + camera fields in `handleMessage`;
  expose a `startMode(primitiveType, tempF)` helper for mode switches.
- `src/accessories/`: new `video-doorbell.ts` (Doorbell + Camera), `probe-sensor.ts`,
  `mode-switch.ts`. Existing `thermostat.ts`, `preheat-switch.ts`, `sensors.ts` unchanged.
- `src/platform.ts`: construct the new opt-in accessories based on config.
- `config.schema.json`: add `doorbell`, `camera`, `probeSensors`, `modes` per-oven properties and
  form entries; all new toggles default false.

## Out of scope

- HKSV / secure video recording.
- Live H.264/HLS streaming.
- Timer as a HomeKit control (command exists; no natural HomeKit surface — revisit later).
- Cook progress % as a dedicated characteristic (no native HomeKit type; used internally only).

## Open risks

- The whole camera path hinges on Spike A; if `10011` turns out to deliver something other than a
  fetchable still URL, feature 2 (and the doorbell thumbnail) may need rework.
- Door-open trigger may prove impossible; it ships as a no-op toggle if Spike C fails.
- Mutually-exclusive mode switches are a HomeKit UX compromise (no native radio group); acceptable
  and matches how other appliance plugins model modes.
