# `homebridge-june-oven` — Homebridge plugin spec (distributable, with in-plugin pairing)

A **distributable** Homebridge plugin that exposes a June Oven to Apple HomeKit / Siri / HomePod.
Any user installs it, **pairs their own oven from the plugin's Config UI with a PIN** (no June
account, no credential extraction), and controls it by voice / Home app. Built on the fully
reverse-engineered June cloud protocol.

**This document is the build spec** (for Codex). The wire protocol it implements is in
**`JUNE_INTEGRATION_SPEC.md`** (endpoints, signature, message codes, temperature units, token
refresh, **and the full pairing recipe in §13**) — that is the authoritative source and is
referenced, not duplicated, here. Working Python references: `june_oven.py` (control/status/token)
and `june_pair.py` (the exact, verified pairing flow to port).

Runtime: **Linux**, Node.js ≥ 18, TypeScript, standard npm Homebridge dynamic platform plugin +
a Homebridge **custom Config UI** (`@homebridge/plugin-ui-utils`) for pairing.

---

## 1. Goals & scope

**Distribution model:** the plugin ships generic (the June app's `client_id`/`client_secret` are
constants baked in). A user installs it, opens its settings, clicks **Pair**, the plugin shows an
**8-digit code**, the user enters it **on their oven**, and the plugin completes SRP pairing and
saves the resulting per-user identity into its own config. Nothing user-specific is bundled.

Enable, by HomePod/Siri voice and in the Home app:
- **Preheat** on/off, **set temperature**, **read current cavity temperature**, and **"done"
  notifications** (see §2 for exact Siri phrasing and §9 for HomeKit limits).

In scope: **pairing (in-plugin, via Config UI)**, control, status, done-notifications, token
auto-refresh, multi-oven.

Out of scope (HomeKit genuinely can't — see §9; do **not** fake): voice timer / "extend timer",
voice "time remaining". Those are a future iOS-app (App Intents) concern.

---

## 2. What it exposes (HomeKit services)

A **dynamic platform** publishing, per paired oven (names configurable; defaults read naturally):

| Accessory (default) | Service | Purpose / Siri |
|---|---|---|
| **"June"** | `Thermostat` | Primary. Current temp (status), target temp, Off=cancel. "set June to 375", "turn June off", "what's the temperature of June". |
| **"June Preheat"** | `Switch` | On → preheat at configured default; Off → cancel. "turn on June Preheat"; or a Home scene "Preheat June" → "Hey Siri, Preheat June". |
| **"June Ready"** | `OccupancySensor` | Trips when preheat completes → HomeKit "June is preheated" notification. |
| **"June Done"** | `OccupancySensor` (optional) | Trips when a cook finishes (state active→idle) → "June is done". |

Prefer **separate accessories** so each has its own Siri-addressable name + notification toggle;
make each individually enable-able in config. Keep names short/distinct (thermostat "June", switch
"June Preheat"); tell users to build a **"Preheat June" scene** for the exact word "preheat".

---

## 3. Pairing (in-plugin, via Config UI) — the distributable part

Implements `JUNE_INTEGRATION_SPEC.md §13` (verified by `june_pair.py`). The plugin is the SRP-6a
**server**; the oven is the client; the shown 8-digit PIN is the SRP password.

### 3.1 UX (Homebridge custom Config UI, `@homebridge/plugin-ui-utils`)
Plugin ships a `homebridge-ui/` folder: a `server.js` (`HomebridgePluginUiServer` subclass, runs in
the Homebridge-UI Node process) + `public/` frontend. The frontend uses the `window.homebridge` API.

Flow:
1. Settings screen lists paired ovens + a **"Pair a new June oven"** button.
2. Button → frontend calls server request `/pair/begin`. Server: registers an anonymous device
   (`POST /2/devices/register`), requests a pairing code (`POST /2/devices/pairing`), generates a
   fresh Ed25519 signing keypair + Curve25519 box keypair, initializes the SRP-6a server, opens the
   `/companion` WebSocket, and returns the **8-digit code** (`code + 2 random digits + Damm digit`).
3. Frontend shows: **"On your oven, open Settings → Connect and enter: `4660 5037`"** with a spinner.
4. Server, upon receiving the oven's `A` (WS msg `10026`, `data.key_info.A`): computes `B`,`S`,
   `K = BLAKE2b-256(S)`, seals `companion_info`, `POST /2/devices/pairing/{code}/companion`
   `{key_info:{salt,B,companion_info}}`, then **waits (does NOT delete the session)**. It polls
   `GET /2/devices/{deviceId}/associated`; when the oven appears (also yields `oven_id`), pairing is
   done. *(The oven also sends a second `10026` carrying `oven_info` — informational.)*
5. Frontend polls `/pair/status`; on success it writes the new oven's identity into the plugin
   config (`ovens[]`) via `homebridge.updatePluginConfig()` + `homebridge.savePluginConfig()`, and
   the platform picks it up on the next restart.
6. Handle: code expired (fast — a couple minutes → offer regenerate), oven rejected/`10027`
   (`PairingSessionInvalidated` → most often the oven wasn't idle/reachable → retry), timeout.

> **Critical (this was the real pairing bug):** after `POST …/companion`, do **NOT** `DELETE` the
> session — that aborts it and the oven sends `10027`. Wait for completion; delete later or not at all.

### 3.2 Pairing crypto (per §13)
- SRP-6a **server**: group = RFC 5054 **8192-bit** (g=19), hash **SHA-1**, identity `"user"`, 16-byte
  random salt, verifier `v=g^x`, `x=H(salt‖H("user:"+PIN))`, `k=H(PAD(N)‖PAD(g))`,
  `B=(k·v+g^b) mod N`, `u=H(PAD(A)‖PAD(B))`, `S=(A·v^u)^b mod N` (all PADs to N's byte length = 1024).
  - **Native `BigInt` is sufficient** — no BigInt dependency. Implement `modPow` (square-and-multiply);
    8192-bit modexp once per pairing is fine. SHA-1 via Node `crypto`.
- **Seal**: `K = crypto_generichash(32, S)` (BLAKE2b-256); `companion_info =
  base64( nonce(24) ‖ crypto_secretbox(json, nonce, K) )` where json =
  `{companion_id, companion_name, public_signing_key(b64 Ed25519 pub), public_encryption_key(b64
  Curve25519 pub), timezone, platform:"iOS"}` (field order per §13). All via `libsodium-wrappers`.
- **Damm** check digit + the "code + 2 random digits" construction: see §13 / `june_pair.py`.

### 3.3 Stored identity (written to config on success)
Per oven: `ovenId, deviceId, deviceName, password, ed25519SeedHex, accessToken, refreshToken`
(+ the shared `clientId/clientSecret` defaults). Persisted in the plugin config so the platform runtime
uses it. Treat as secrets (they live in Homebridge's config.json — document that; do not log them).

---

## 4. Thermostat service — detailed mapping

HomeKit thermostats are **°C internally**; the oven uses **milli-°C** (`§8`). Convert at the boundary;
widen ranges so oven temps are allowed.

| Characteristic | Behavior |
|---|---|
| `CurrentTemperature` | Live cavity temp from WS `10013` `sensor_data.cavity` (milliC→°C); REST `status` fallback. `setProps({minValue:0,maxValue:300})`. Read-only. |
| `TargetTemperature` | Setpoint (°C). `setProps({minValue:10,maxValue:260,minStep:1})`. On write (state=Heat) → temp command. Persist last setpoint. |
| `TargetHeatingCoolingState` | `validValues` = **Off(0)**, **Heat(1)** only. Off → cancel (`11004`); Heat → preheat (`11002`) to `TargetTemperature` w/ configured default mode. |
| `CurrentHeatingCoolingState` | Off/Heat from `device_state` (`10018`): active→Heat, idle→Off. |
| `TemperatureDisplayUnits` | Expose; default from config (°F/°C). Display only; commands convert to milliC. |

On ack failure (`door-open`,`not-allowed`,`not-ready`,`cleaning`,… — full list `§7`): revert the
characteristic to its prior value, log a warning, optionally set `StatusFault`.

---

## 5. Switch & sensors
- **Switch "June Preheat"** `On`: On → `preheat(defaultMode, defaultTempF)`; Off → `cancel`. Reflect
  real state from `device_state` (active→On, idle→Off).
- **OccupancySensor "June Ready"**: `OccupancyDetected = DETECTED` on **preheat-complete** (cook step
  transitions off the `preheat` step and/or that step's `cook_state_data.progress`→~1.0 / cavity hits
  target). Reset shortly after or when a new cook starts.
- **OccupancySensor "June Done"** (optional): trip on `active`→`idle` after a real cook (distinguish
  cancel via `10017 type:"cancelled"` if possible).

---

## 6. Protocol runtime core (per `JUNE_INTEGRATION_SPEC.md`)

`JuneClient` (one per oven), shared by the platform runtime (and the pairing UI reuses the same
crypto/token/WS helpers):
- **Signing** (`§6`): `base64( crypto_generichash(8, pub) ‖ ed25519_sign(canonical_json) )`.
  ⚠️ Node's built-in `crypto` can't do variable-length BLAKE2b — use **`libsodium-wrappers`**
  (`crypto_generichash`, `crypto_sign_seed_keypair`, `crypto_sign_detached`, `crypto_secretbox`).
  Canonical JSON: compact, exact key order `v,message_code,order,time,signature,device_name,device_id,
  data,target`, `signature:""` while signing (build the string explicitly). `order` = strictly
  increasing int (`Date.now()&0x7fffffff`, bump on collision).
- **Token** (`§3`): refresh via `POST /2/devices/register` on startup + on 401; cache. `client_id`/
  `client_secret` ship as plugin defaults.
- **WebSocket** (`§5`): `wss://…/companion`, Bearer + `User-Agent: okhttp/4.8.1`, **no
  permessage-deflate**; `11011` keepalive on open + every ~7 s; parse `10018/10013/10015/10016/10014/
  10017/10020` (+ `10026` during pairing). Reconnect w/ backoff; socket = live source of truth.
- **Commands**: `11002` preheat, `11005` set-temp, `11004` cancel (`11006` timer only if a future
  timer feature is added). Match `10020` ack by `request_order`.
- **REST status** (`§4`): initial snapshot + periodic (~60 s) fallback.

---

## 7. Configuration (`config.schema.json`)

Platform config; the **identity block per oven is produced by the pairing UI (§3)**, not hand-entered.
Users only set preferences; credentials are filled in on pairing.

```jsonc
{
  "platform": "JuneOven",
  "name": "June",
  "ovens": [
    {
      "name": "June",                     // thermostat accessory name
      "preheatSwitchName": "June Preheat", // "" disables the switch
      "readySensor": true,
      "doneSensor": true,
      "defaultMode": "bake",               // bake|roast|broil|air_fry|…
      "defaultTempF": 350,
      "tempUnit": "F",

      // ↓ written by the pairing flow; hidden/read-only in the UI, treated as secrets
      "ovenId": "…", "deviceId": "…", "deviceName": "June",
      "password": "…", "ed25519SeedHex": "…",
      "accessToken": "…", "refreshToken": "…"
      // clientId/clientSecret default to June app constants; overridable
    }
  ]
}
```

- Provide a real `config.schema.json` (preferences visible; credential fields hidden/advanced).
- The **custom UI (§3.1)** is the primary way ovens get added; support **multiple** ovens.

---

## 8. Lifecycle & behavior
1. `didFinishLaunching` → for each paired oven: refresh token, create `JuneClient`, restore/create
   accessories (dynamic platform, cached).
2. REST `status` for initial values; open WS for live updates.
3. Telemetry → update `CurrentTemperature`, `CurrentHeatingCoolingState`, switch `On`, trip sensors.
4. HomeKit writes → commands → await `10020` ack → on failure revert + log; debounce dial changes (~500 ms).
5. Keepalive + reconnect; refresh token proactively (~daily) and on 401.
6. Pairing runs in the Config-UI server process (§3), independent of the running platform; on success
   the user restarts the bridge (or the platform hot-reloads config) to bring the new oven online.

---

## 9. HomeKit / HomePod reality (put in README)
- ✅ HomePod: preheat on/off, set temperature, read current temperature, done-notifications.
- ❌ **No voice timer / "extend"** (HomeKit has no oven-timer; "timer" = HomePod's own). Preset-duration
  Home **scenes** are the only voice-ish workaround (user-created, optional).
- ❌ **No voice "time remaining"** (no HomeKit duration characteristic Siri will speak). Use the
  **Ready/Done sensor notifications** instead. (Real time-remaining by voice = future iOS app, iPhone/
  Watch only.) Note many June cooks are temperature/probe-based, so a countdown often doesn't exist.
- Exact **"Preheat June"** phrase = a user-created Home **scene**; the switch backs it.

---

## 10. File layout
```
homebridge-june-oven/
  package.json            // homebridge engines, main, deps
  config.schema.json      // Config UI schema (prefs visible, creds hidden)
  tsconfig.json
  src/
    index.ts              // registerPlatform
    settings.ts           // names, client_id/secret defaults, URLs, group N (8192-bit) constant
    platform.ts           // dynamic platform: config parse, accessory lifecycle
    june-client.ts        // JuneClient: sign, token, WS, commands, status, telemetry events
    pairing.ts            // SRP-6a server, Damm, keygen, seal, pairing state machine (from june_pair.py)
    protocol.ts           // message codes, temp conversion, canonical JSON + signing (shared)
    accessories/{thermostat,preheat-switch,sensors}.ts
  homebridge-ui/
    server.js             // HomebridgePluginUiServer: /pair/begin, /pair/status handlers (uses pairing.ts logic)
    public/index.html     // Pair button, code display, spinner, writes config on success
  README.md               // install, in-app pairing walkthrough, config, Siri phrases, HomeKit limits
```
*(Pairing logic must be importable by both `homebridge-ui/server.js` and the platform — put shared
crypto/protocol in a module compiled to `dist/` that both import, or duplicate minimal helpers.)*

---

## 11. Dependencies
- `libsodium-wrappers` — Ed25519 sign, BLAKE2b (`generichash`, 8- & 32-byte), secretbox (pairing seal).
- `ws` — WebSocket client.
- `@homebridge/plugin-ui-utils` — custom Config UI (pairing screen).
- Built-ins: **native `BigInt`** (SRP 8192-bit modexp — implement `modPow`, no dep), `crypto` (SHA-1),
  global `fetch` (Node ≥18). `homebridge`/`hap-nodejs` as peer.

---

## 12. Verification (before release)
- **Pairing:** from a fresh install with no identity, the Config UI pairs a real oven end-to-end
  (matches `june_pair.py`): shows code → user enters on oven → `associated` returns the oven → identity
  saved → the freshly paired key controls the oven (a signed keepalive/preheat gets `10020 success`).
- **Runtime:** `JuneClient` reproduces `june_oven.py` (signed preheat/cancel → `success`; current temp
  tracks status/telemetry). In Home app: set temp / heat / switch → oven reacts; "June Ready" trips +
  notifies on preheat completion.
- **HomePod:** "set June to 375", "turn on June Preheat" / scene "Preheat June", "what's the
  temperature of June".

---

## 13. References
- `JUNE_INTEGRATION_SPEC.md` — **authoritative** wire protocol (§3 token, §4 REST, §5 WS, §6 signature,
  §7 codes, §8 temperature, **§13 pairing**).
- `JUNE_CLOUD_PROTOCOL.md` — deeper decoded notes.
- `june_oven.py` — control/status/token reference (port `JuneClient`).
- `june_pair.py` — **verified pairing flow to port** into `pairing.ts` / `homebridge-ui/server.js`.
