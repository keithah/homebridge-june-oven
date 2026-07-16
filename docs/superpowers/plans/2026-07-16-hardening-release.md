# June Oven Hardening and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct every actionable June Oven issue from the 2026-07-16 review, publish a verified npm/GitHub release, and deploy it to the Homebridge host.

**Architecture:** Give `JuneClient` explicit ownership of one socket, one refresh, and one poll at a time. Centralize bounded HTTP and response validation, make pairing sessions finite and erasable, reconcile HomeKit services, and make camera failure paths close every owned resource.

**Tech Stack:** TypeScript, Homebridge/HAP-NodeJS, `ws`, Node fetch/AbortController, ffmpeg child processes, Vitest, npm, GitHub Actions.

## Global Constraints

- Preserve the current uncommitted custom-UI configuration persistence fix.
- Never log or expose stored oven passwords, signing seeds, or tokens.
- Keep Node 18 compilation compatibility while testing supported Node 20/22/24 lanes already declared by the project.
- Use a failing regression test before each production behavior change.
- Do not change the June protocol wire format.

---

### Task 1: Bounded and validated HTTP

**Files:**
- Create: `src/http.ts`
- Create: `src/http.test.ts`
- Modify: `src/june-client.ts`
- Modify: `src/pairing.ts`
- Modify: `src/accessories/camera.ts`

**Interfaces:**
- `fetchWithTimeout(url, init, timeoutMs)` composes caller cancellation and rejects with a bounded, non-secret error.
- Small runtime guards validate token, pairing, status, and association payloads.

- [ ] Write timeout and caller-abort tests and confirm they fail because the helper does not exist.
- [ ] Implement the helper with an `AbortController`, composed signals, and timer cleanup in `finally`.
- [ ] Replace every runtime, pairing, snapshot, and live-frame fetch with the helper; use shorter camera deadlines and a maximum image size.
- [ ] Add malformed-response tests for credentials and pairing identifiers, then add narrow guards.
- [ ] Run the targeted and full tests.

### Task 2: WebSocket, refresh, poll, and shutdown ownership

**Files:**
- Modify: `src/june-client.ts`
- Modify: `src/june-client.test.ts`
- Modify: `src/platform.ts`
- Modify: `src/platform.test.ts`

**Interfaces:**
- `connect()` returns one promise for OPEN/CONNECTING states.
- Intentional stop suppresses reconnect and rejects pending acknowledgements.
- Refresh and status polling are single-flight.

- [ ] Add tests for two commands during CONNECTING, stop-after-close, delayed connection, concurrent 401 refresh, and overlapping poll ticks.
- [ ] Run them and observe duplicate socket construction/reconnect and refresh calls.
- [ ] Add `stopped`, `connectPromise`, and socket identity checks; wait on socket events instead of a one-second sleep.
- [ ] Clear the previous keepalive on open, reconnect only the current unintentionally closed socket, and make `stop()` idempotent.
- [ ] Add shared refresh and poll promises cleared in `finally`.
- [ ] Register Homebridge shutdown and stop every client.
- [ ] Run client and platform tests.

### Task 3: Finite pairing sessions

**Files:**
- Modify: `src/pairing.ts`
- Modify: `src/pairing.test.ts`
- Modify the existing custom UI server entry point that exposes pairing routes.

**Interfaces:**
- Pairing startup always reaches a terminal state and closes its socket on error.
- Terminal sessions expire and erase credential-bearing state.
- The manager limits active sessions and supports cancellation.

- [ ] Add tests for request-code failure after socket creation, pairing timeout, terminal eviction, and active-session limits.
- [ ] Confirm sessions/socket references remain before the fix.
- [ ] Wrap `begin()` in catch/finally cleanup and introduce a total session deadline.
- [ ] Add manager eviction timers, a small active-session cap, cancellation, and secret erasure.
- [ ] Expose cancellation to the UI server and stop polling when the browser flow ends.
- [ ] Run pairing and UI tests.

### Task 4: Edge-triggered events and service reconciliation

**Files:**
- Modify: `src/june-client.ts`
- Modify: `src/accessories/doorbell.ts`
- Modify: `src/accessories/sensors.ts`
- Modify: `src/accessories/mode-switch.ts`
- Add focused accessory tests under `src/`.

**Interfaces:**
- Ready notifications fire once per false-to-true transition.
- Each occupancy sensor owns at most one reset timer.
- Mode accessories remove cached switch subtypes no longer configured.

- [ ] Add tests with repeated ready telemetry and with one removed cached mode.
- [ ] Confirm repeated doorbell presses/timers and the stale service before changes.
- [ ] Track ready state and only notify on rising edge; replace/reset one sensor timer and clear it on shutdown/disposal.
- [ ] Compare `mode-*` switch subtypes to configuration and remove obsolete services.
- [ ] Run the accessory tests.

### Task 5: Camera failure cleanup

**Files:**
- Modify: `src/accessories/camera.ts`
- Create: `src/camera.test.ts`

**Interfaces:**
- Every prepare/start failure invokes its callback exactly once and removes its session.
- ffmpeg spawn failure is observed before HomeKit receives stream success.

- [ ] Add tests for UDP bind error, absent snapshot, async ffmpeg `error`, oversized frame, timeout, and stop during fetch.
- [ ] Confirm the current code leaks sessions or reports success.
- [ ] Funnel failures through `stopSession`, close sockets, abort frame fetches, and wait for the child `spawn` event before success.
- [ ] Run camera tests.

### Task 6: Verification, publication, and deployment

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md` if behavior text changes.

**Interfaces:**
- Patch release is published by the existing GitHub-release workflow and npm provenance job.

- [ ] Run lint/typecheck, tests, build, audit, and `npm pack --dry-run` with a clean result.
- [ ] Bump the patch version, repeat verification, commit the existing UI fix together with its tests, push, tag, and publish a GitHub release.
- [ ] Monitor CI and npm publication until green and visible.
- [ ] Upgrade the plugin on `keith@192.168.42.15`, restart Homebridge, and verify startup, status polling, socket stability, configuration persistence, and configured accessories.

