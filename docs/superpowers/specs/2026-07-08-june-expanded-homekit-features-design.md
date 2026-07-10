# June Oven — Expanded HomeKit Features Design

**Date:** 2026-07-08
**Status:** Approved design, pending implementation plan

## Goal

Extend `homebridge-june-oven` beyond its current thermostat + preheat switch + ready/done
occupancy sensors to surface more of the oven's real capabilities in HomeKit. Every new feature
is **opt-in** via the Config UI (default off) so existing users see no behavior change on upgrade.

Four features, in priority order:

1. **Cook-done doorbell** — ships as a Doorbell, and becomes a Video Doorbell when the interior
   camera is also enabled. Offered as an option alongside the existing ready/done sensors; users can
   enable either, both, or neither.
2. **Interior camera** (snapshot + ffmpeg live view) — BUILT. Spike A solved; snapshot verified
   live end-to-end. Combines with the doorbell into a Video Doorbell.
3. **Food probe temperature sensor**
4. **Config-driven cook-mode switches**

Also in scope: a short **README section documenting why timer and cook-progress % are not
exposed** (see Out of scope) so the omission is intentional and discoverable, not a gap.

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

### `10011` camera frame — SOLVED (captured live 2026-07-08)
A capture during a real cook (start a bake on our own trusted key, log inbound WS frames) decoded
`10011` completely. It auto-streams to **any connected companion during a cook** — no emulator,
frida, or app login required; our plugin's existing WebSocket already receives it. Each frame:

```json
{ "video_id": "…", "ts": 1783544754057,
  "signed_url": "https://june-api.s3.amazonaws.com/media/prod/images/1-{video_id}-{ovenId}/image.jpg_{uuid}.jpe?X-Amz-…",
  "image_url":  "https://api.junelife.com/media/prod/images/1-{video_id}-{ovenId}/image.jpg_{uuid}.jpe?X-Amz-…",
  "content_type": "image/jpeg", "image_size": 20436, "client_req_id": "…" }
```

- **It's a still JPEG** (~20 KB), pushed at **~1 fps** during a cook. No video stream to decode.
- `image_url` (api.junelife.com CDN) and `signed_url` (direct S3) are both pre-signed, **expire in
  300 s**. Prefer `image_url`.
- Snapshot strategy: cache the latest `image_url` from `10011`; the camera's snapshot handler
  fetches it. Frames land ~1/s while cooking, so it looks live. No cook → no `10011` → serve the
  last-known frame or a placeholder.

### Food-probe fields — SOLVED (captured live 2026-07-08, probe in a water bowl)
`10013` `sensor_data.probe` is an **array** of `{ id: "left"|"right", value: <milli-C> }`. There is
no `food_present` field; probe presence = the array has entries. Confirmed live: cavity `61100`
(142°F) vs. probe `{id:"left",value:18200}` (65°F water). `parseProbeTelemetry` parses this shape.
- **Food-probe temperature fields** in `10013` — confirmed as `sensor_data.probe`, an array of
  `{id, value}` entries where `value` is milli-°C.
- **Door-open** is only observable as a command *rejection reason* (`10020 status:"door-open"`),
  not as a push event. A live door-state signal is unconfirmed.
- **The full mode list** — only `bake`/`roast` are confirmed on-oven; the `/2/devices/{id}/features`
  response body was not captured. This is why cook modes are user-defined, not hardcoded.

## Prerequisite spikes (tasks, not code)

- **Spike A — capture a `10011` frame. ✅ DONE (2026-07-08).** Decoded live; see the `10011`
  section above. Camera is unblocked and needs no emulator — the frame arrives on our own
  WebSocket during any cook.
- **Spike B — probe field path. ✅ DONE (2026-07-08).** Decoded live; `sensor_data.probe` is an
  array of `{id, value}` (see above). `parseProbeTelemetry` updated and unit-tested to match.
## Feature 1 — Cook-done doorbell

A **Doorbell** accessory that fires a `ProgrammableSwitchEvent` (single-press) when a configured
trigger occurs, producing a HomeKit doorbell notification on phone + Apple TV. When the camera is
also enabled, a Camera service attaches to the same accessory so HomeKit treats it as a Video
Doorbell and includes the latest oven still in the notification. It is offered as an option
**alongside** the existing ready/done occupancy sensors; users can enable either, both, or neither.

- Triggers are **configurable** (all default off):
  - `done` — the cook-complete transition the client already computes (`JuneTelemetry.done`).
  - `ready` — preheat-complete / ready-to-load (`JuneTelemetry.ready`).
- Config (per oven): `doorbell` object — `enabled` (bool, default false), `triggers` (object with
  `done`/`ready` booleans, all default false), `name`.

Enabling the camera is what promotes plain doorbell to video doorbell; the doorbell can still be
used without the camera for image-less HomeKit notifications.

## Feature 2 — Interior camera (snapshot-only)

A Camera service whose `handleSnapshotRequest` returns the latest interior still as a JPEG. The
JPEG snapshot is the real feature: it drives the camera tile preview and the food photo in the
doorbell's rich notification. **No real video capture and no HKSV.**

HomeKit API constraint: hap-nodejs's `CameraController` cannot be registered snapshot-only — it
requires a streaming delegate (`handleStreamRequest`). We satisfy this with a **minimal
ffmpeg-from-still stub**: when the user taps the tile to "go live," ffmpeg loops the latest JPEG
into an H.264 stream. This is the only place ffmpeg runs; the still refreshes so it looks live.
There is deliberately no continuous/HKSV recording.

- Snapshot source: the URL learned from Spike A's `10011` frame. The client keeps the most recent
  signed still URL from the telemetry stream; the snapshot handler fetches it (with a short cache
  to avoid hammering the CDN) and returns the bytes. When no cook is active / no still is
  available, return a static placeholder image.
- Config (per oven): `camera.enabled` (bool, default false), `camera.name`, `camera.ffmpegPath`.
- Implemented as part of the same accessory as the doorbell (feature 1) when both are enabled;
  camera-only (no doorbell triggers) is also valid.

## Feature 3 — Food probe temperature sensor

Expose the oven's food probe temperature as a HomeKit **Temperature Sensor** service, so users
can build automations like "notify when probe reaches 145 °F."

- Source: `10013` telemetry `sensor_data.probe` array from Spike B. The June oven has a single
  food probe; the accessory keeps the last reported value between updates.
- Opt-in. Config (per oven): `probeSensors.enabled` (bool, default false). Optionally a
  `probeSensors.name` display name.
- New `JuneTelemetry` fields (`probeC`, `probePresent`) populated in
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
- `src/accessories/`: new `doorbell.ts` (Doorbell service now; attaches a Camera service later
  when the camera is enabled, becoming a Video Doorbell), `probe-sensor.ts`, `mode-switch.ts`.
  Existing `thermostat.ts`, `preheat-switch.ts`, `sensors.ts` unchanged.
- `src/platform.ts`: construct the new opt-in accessories based on config.
- `config.schema.json`: add `doorbell`, `camera`, `probeSensors`, `modes` per-oven properties and
  form entries; all new toggles default false.

## Out of scope

- HKSV / secure video recording.
- Live H.264/HLS streaming.
- Timer as a HomeKit control (command exists; no natural HomeKit surface — revisit later).
- Cook progress % as a dedicated characteristic (no native HomeKit type; used internally only).

Both of these get a short **README section** explaining the omission: the `11006` set-timer
command works but HomeKit has no timer/countdown surface for a thermostat-style accessory, and
cook progress has no native HomeKit characteristic (so it is only used internally to derive
ready/done). This is a documentation deliverable of this work, not a code feature.

## Open risks

- The whole camera path hinges on Spike A; if `10011` turns out to deliver something other than a
  fetchable still URL, feature 2 (and the doorbell thumbnail) may need rework.
- Door-open trigger may prove impossible; it ships as a no-op toggle if Spike C fails.
- Mutually-exclusive mode switches are a HomeKit UX compromise (no native radio group); acceptable
  and matches how other appliance plugins model modes.
