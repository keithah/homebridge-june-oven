# June Oven — third-party integration spec

Everything needed to control a June Oven from your own client (Homebridge plugin, Swift/iOS
app, Home Assistant, …). This is a clean-room reverse-engineering of the June companion app's
cloud protocol, **verified end-to-end against a real oven** (model `meerkat`). No official API.

The reference implementation is `june_oven.py` in this folder (Python). This document restates
the protocol implementation-language-agnostically and gives a **Node.js** reference for Homebridge.

> ⚠️ Commands act on a **real, physical oven**. Test with `cancel` and low temperatures.
> This is for controlling your own oven; June/Weber ToS may restrict it and the cloud API can
> change without notice.

---

## 1. Architecture

```
your client  ──HTTPS──►  api.junelife.com          (token, device info — REST)
your client  ──HTTPS──►  messaging.junelife.com     (oven status snapshot — REST)
your client  ──WSS───►   messaging.junelife.com     (send commands + receive live state)
                              │
                              ▼
                         the oven  (verifies each command's Ed25519 signature, then acts;
                                    every frame is acked with a signed 10020 message)
```

Two independent trust mechanisms:
- **Bearer token** (OAuth) — authenticates REST + opens the WebSocket. 7-day lifetime, refreshable.
- **Ed25519 signature** — the oven only executes commands signed by a key it trusts (established
  at pairing). This is separate from the token: the token gets you *connected*; the signature gets
  the *command executed*.

---

## 2. Credentials / config

The plugin needs these per-oven values (in this folder they live in `secrets.local.json`, produced
from the paired app's `sessionInfoPreferences.xml` + a capture):

| field | example / source | purpose |
|---|---|---|
| `oven_id` | `395447f53aef42be8a0f5d43ab028330` | target oven |
| `device_id` | `224523deaf8e495594074d8fa6c9bb97` | your companion's id (from pairing) |
| `device_name` | `sdk_gphone64_arm64` | free-form label sent in each message |
| `password` | 32-hex device secret | used to re-mint tokens (see §3) |
| `ed25519_seed_hex` | 32-byte hex seed | the signing key the oven trusts |
| `access_token` | `v2:…` | current Bearer token (7-day) |
| `refresh_token` | `v2:…` | returned alongside access_token (currently unused) |
| `client_id` | `dcxqbcv2dY-G12elqDoAhCP8E12V0zC8XWThT-4U` | **June app constant** (same for everyone) |
| `client_secret` | `tmoSUwt3OOZCcfMaIadAGD7-x-qPht85HkCgdvuhTKk1yFtfMcfJEyd` | **June app constant** |
| `base_url` | `https://api.junelife.com` | REST base |
| `ws_url` | `wss://messaging.junelife.com/1/messaging/websocket/companion` | command channel |

`client_id`/`client_secret` are hard-coded in the June Android app (v1.24.1.11) and are the same
for all users. `oven_id`, `device_id`, `password`, and `ed25519_seed_hex` are specific to *your*
paired companion and must be extracted once (they persist).

---

## 3. Token: acquire & refresh  (7-day lifetime)

The access token lasts **7 days** (`expires_in: 604800`). To mint a fresh one, **re-register your
device** — idempotent for an existing `device_id`, no user login required:

```
POST https://api.junelife.com/2/devices/register
Content-Type: application/json
User-Agent: okhttp/4.8.1

{
  "password": "<password>",
  "device_id": "<device_id>",
  "client_id": "<client_id>",
  "client_secret": "<client_secret>",
  "device_type": "companion",
  "device_name": "<device_name>",
  "platform": "android",
  "version": "1.24.1.11",
  "platform_version": "34"
}
```

Response `200`:
```json
{ "success": true,
  "token": { "access_token": "v2:…", "refresh_token": "v2:…",
             "expires_in": 604800, "scope": "", "token_type": "Bearer" } }
```

Strategy: cache the token; refresh proactively (e.g. daily) and/or transparently on any `401`.
(The OAuth endpoint `/2/auth/oauth/token` exists but rejects `grant_type=refresh_token` —
`unsupported_grant_type` — so use device re-registration, which is what the app itself does.)

---

## 4. REST — read oven status

```
GET https://messaging.junelife.com/1/messaging/device/<oven_id>/status
Authorization: Bearer <access_token>
```

Returns a snapshot:
```json
{
  "connection_state": "online",                 // or "offline"
  "device_state": { "data": { "state": "idle" }, "message_code": 10018, ... },
  "cook_plan":    { "data": { "food": { "name": "bake", "plan": { "steps": [...] } } },
                    "message_code": 10015, ... },
  "success": true
}
```
- `connection_state` — is the oven reachable.
- `device_state.data.state` — `"idle"` (off) or `"active"` (cooking/preheating).
- `cook_plan.data.food.plan.steps[].temperature_cavity` — the target temp (milli-°C, see §8).

This is a **snapshot**; live temperature/telemetry comes over the WebSocket (§7) while cooking.

---

## 5. WebSocket — the command channel

Connect:
```
GET wss://messaging.junelife.com/1/messaging/websocket/companion
Authorization: Bearer <access_token>
User-Agent: okhttp/4.8.1
```
- Plain WebSocket text frames. **Do not enable permessage-deflate** — the correct signature works
  fine on an uncompressed connection (the app negotiates deflate but actually sends uncompressed
  `rsv1=0` frames; simplest is to not offer the extension at all).
- On connect the server pushes device state and, while cooking, a live telemetry stream. Send an
  `11011` keepalive right after connecting (the app sends one every ~7 s) then your command.
- Keep the socket open a few seconds after sending to receive the ack + state changes.

### Message envelope (every outgoing frame)

Compact JSON, **exact key order** (this order is what you sign — see §6):

```json
{"v":2,"message_code":<int>,"order":<int>,"time":<epoch_ms>,"signature":"<base64>",
 "device_name":"<device_name>","device_id":"<device_id>","data":{…},"target":{"id":"<oven_id>"}}
```

- `time` — `Date.now()` (epoch ms).
- `order` — a **strictly increasing** integer the oven echoes back as `request_order` (that's how
  you match an ack to your command). `Date.now() & 0x7fffffff` works; just bump it if two frames
  land in the same millisecond so they never collide. Magnitude/scale does **not** matter.
- `signature` — see §6. Set to `""` while signing, then fill in.

---

## 6. ⭐ Signature (the part everyone gets wrong)

The oven **silently drops** (no ack, no error) any command whose signature isn't in this exact
72-byte form. This was the single thing blocking control.

```
signature = base64(  BLAKE2b(ed25519_public_key, digest_size=8)      // 8-byte key fingerprint
                   || Ed25519_sign(privkey, canonical_json_bytes) )   // 64-byte signature
```

- **8-byte prefix** = libsodium `crypto_generichash(publicKey, 8)` (BLAKE2b with an 8-byte output —
  NOT a truncated BLAKE2b-512; the output length is part of the hash). It's a constant per key
  (identifies which trusted key signed). For this key it is `26d3542f4119b8d2`.
- **64-byte signature** = detached Ed25519 over the canonical JSON.
- **canonical_json_bytes** = the envelope (§5) serialized compactly (no spaces) with `signature`
  set to the empty string `""`, in the exact key order shown, UTF-8 encoded. After signing, set
  `signature` to the base64 above and re-serialize to send. (The oven re-blanks `signature` to
  `""` and verifies, so your signed bytes must match byte-for-byte.)
- Standard base64 (with `+` `/` and `=` padding — 96 chars for 72 bytes). Do not url-safe encode,
  do not escape `/`.

The `ed25519_seed_hex` is a 32-byte seed; derive the keypair with
`crypto_sign_seed_keypair(seed)` (libsodium) → `{publicKey (32B), privateKey (64B)}`.

---

## 7. Message codes

### Commands you send (companion → oven)

| code | meaning | `data` payload |
|---|---|---|
| `11011` | keepalive / presence | `{}` |
| `11002` | preheat / start cook | `{"primitive_type":"bake","temperature_cavity":<milliC>}` |
| `11005` | change target temp | `{"plan_id":0,"temperature_cavity":<milliC>}` |
| `11006` | set timer | `{"plan_id":0,"duration":<ms>}` |
| `11004` | cancel / stop | `{"plan_id":0}` |

`primitive_type` values seen: `"bake"`, `"roast"` (the app has more: broil, air-fry, etc. — each is
a preset primitive; bake/roast confirmed on-oven).

### Responses / pushes you receive (oven → companion)

| code | meaning |
|---|---|
| `10020` | **ack** — `{"request_order":<your order>,"status":"success"|"not-allowed"}` (match `request_order` to your command's `order`) |
| `10018` | device_state — `{"state":"idle"|"active"}` |
| `10013` | live cook telemetry (streams ~1/s while cooking) — includes `sensor_data.cavity` (current temp, milli-°C) and `cook_state_data.progress` |
| `10014` | cook plan started |
| `10015` | cook plan / target updated |
| `10016` | temperature changed |
| `10017` | cancelled — `{"type":"cancelled", ...}` |
| `10011` | camera frame — `{"video_id":…,"signed_url":…}` (the oven has an interior camera!) |

All oven→companion frames are signed by the **oven's** key (they share a leading base64 substring,
e.g. `I0CI//qZUdG…`); you can ignore/verify that as you like.

Acks arrive ~150–300 ms after you send. `not-allowed` means the oven rejected it in context (e.g.
`cancel` while already idle) — the command *was* received and processed.

---

## 8. Temperature units

The oven works in **milli-degrees Celsius**.

```
milliC = round((°F − 32) × 5/9 × 1000)      // 350°F = 176667,  375°F = 190556
°F     = round(milliC / 1000 × 9/5 + 32)
°C     = milliC / 1000                        // sensor_data.cavity 52000 = 52°C
```

Note for HomeKit: an oven's range (up to ~260 °C / 500 °F) exceeds the default HomeKit Thermostat
`TargetTemperature` range (10–38 °C). Either widen the characteristic's min/max metadata, use a
`HeaterCooler`, or model temperature via a custom/`TemperatureSensor` + a mode switch. (Design
choice left to the plugin author.)

---

## 9. Verified control flow (what "working" looks like)

```
status                    → device_state.state = "idle"
preheat bake 150          → 10020 status=success → 10018 {"state":"active"} → 10014 cook plan
status                    → device_state.state = "active"          (oven is heating)
cancel                    → 10020 status=success → 10017 cancelled → 10018 {"state":"idle"}
status                    → device_state.state = "idle"
```
Confirmed on the real oven for `preheat` / `temp` / `timer` / `cancel`.

---

## 10. Node.js reference (for the Homebridge plugin)

Deps: `libsodium-wrappers` (same primitives as the app) and `ws`. `fetch` is built into Node 18+.

```js
const sodium = require('libsodium-wrappers');
const WebSocket = require('ws');

// cfg = { wsUrl, ovenId, deviceId, deviceName, ed25519SeedHex,
//         accessToken, password, clientId, clientSecret }

const f2milli = f => Math.round((f - 32) * 5 / 9 * 1000);

let _order = 0;
function nextOrder() {                       // strictly increasing
  let o = Date.now() & 0x7fffffff;
  if (o <= _order) o = _order + 1;
  _order = o;
  return o;
}

function signedFrame(cfg, code, data) {
  const msg = {
    v: 2, message_code: code, order: nextOrder(), time: Date.now(),
    signature: "", device_name: cfg.deviceName, device_id: cfg.deviceId,
    data, target: { id: cfg.ovenId },
  };
  const payload = Buffer.from(JSON.stringify(msg), 'utf8');   // signature is "" here
  const kp  = sodium.crypto_sign_seed_keypair(Buffer.from(cfg.ed25519SeedHex, 'hex'));
  const fp  = sodium.crypto_generichash(8, kp.publicKey);     // 8-byte BLAKE2b fingerprint
  const sig = sodium.crypto_sign_detached(payload, kp.privateKey); // 64-byte Ed25519
  msg.signature = Buffer.concat([Buffer.from(fp), Buffer.from(sig)]).toString('base64');
  return JSON.stringify(msg);                                 // key order preserved → still valid
}

async function refreshToken(cfg) {
  const r = await fetch('https://api.junelife.com/2/devices/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'okhttp/4.8.1' },
    body: JSON.stringify({
      password: cfg.password, device_id: cfg.deviceId,
      client_id: cfg.clientId, client_secret: cfg.clientSecret,
      device_type: 'companion', device_name: cfg.deviceName,
      platform: 'android', version: '1.24.1.11', platform_version: '34',
    }),
  });
  return (await r.json()).token;             // { access_token, refresh_token, expires_in, ... }
}

async function getStatus(cfg) {
  const url = `https://messaging.junelife.com/1/messaging/device/${cfg.ovenId}/status`;
  let r = await fetch(url, { headers: { Authorization: 'Bearer ' + cfg.accessToken } });
  if (r.status === 401) { cfg.accessToken = (await refreshToken(cfg)).access_token; /* persist */
    r = await fetch(url, { headers: { Authorization: 'Bearer ' + cfg.accessToken } }); }
  return r.json();
}

// Send a command; resolves with the oven's ack status ("success"/"not-allowed").
async function sendCommand(cfg, code, data, listenMs = 6000) {
  await sodium.ready;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(cfg.wsUrl, {
      headers: { Authorization: 'Bearer ' + cfg.accessToken, 'User-Agent': 'okhttp/4.8.1' },
      perMessageDeflate: false,               // <-- important: plain uncompressed frames
    });
    let cmdOrder;
    ws.on('open', () => {
      ws.send(signedFrame(cfg, 11011, {}));   // presence/keepalive first
      const frame = signedFrame(cfg, code, data);
      cmdOrder = JSON.parse(frame).order;
      ws.send(frame);
    });
    ws.on('message', (buf) => {
      let j; try { j = JSON.parse(buf.toString()); } catch { return; }
      if (j.message_code === 10020 && j.data?.request_order === cmdOrder) {
        resolve(j.data.status); ws.close();
      }
      // j.message_code 10018 => j.data.state ("idle"/"active"); 10013 => live telemetry
    });
    ws.on('error', reject);
    setTimeout(() => { try { ws.close(); } catch {} ; resolve(null); }, listenMs);
  });
}

// Examples:
//   sendCommand(cfg, 11002, { primitive_type: 'bake', temperature_cavity: f2milli(350) });
//   sendCommand(cfg, 11005, { plan_id: 0, temperature_cavity: f2milli(375) });
//   sendCommand(cfg, 11006, { plan_id: 0, duration: 10 * 60 * 1000 });
//   sendCommand(cfg, 11004, { plan_id: 0 });
```

For a long-lived accessory, keep one WebSocket open, send an `11011` every ~7 s, and drive HomeKit
`CurrentTemperature` from the `10013` `sensor_data.cavity` stream and on/off from `10018`.

---

## 11. Notes for other targets

- **Swift / iOS (+ Watch + Live Activities):** identical protocol. Use swift-sodium or
  CryptoKit + a BLAKE2b lib (CryptoKit has Curve25519 signing but not BLAKE2b — libsodium/
  swift-sodium gives you both `crypto_sign` and `crypto_generichash(outlen: 8)`). The live
  `10013` telemetry (current temp, % progress) and `10018` state are exactly what a Live Activity
  wants; `10011` gives interior-camera frames (`signed_url`) if you want a glanceable image.
- **Home Assistant:** the Python `june_oven.py` here is a working reference; wrap it as a
  `climate` entity + sensors.

---

## 12. Provenance (how this was derived)

Android emulator running the June app + Frida. Hooking libsodium gave the signed message plaintext;
hooking conscrypt's `SSLOutputStream.write` gave the pre-encryption WebSocket frames and the
`/2/devices/register` request (client_id/secret). The decisive find was that the wire `signature`
is 72 bytes (`BLAKE2b(pubkey,8) || Ed25519`), not the bare 64-byte signature. Full protocol notes:
`JUNE_CLOUD_PROTOCOL.md`. Working client: `june_oven.py`.

---

## 13. Self-pairing (publishable: generate a PIN, user enters it on their oven)

Decoded from the app (`PairingFlow`, `SpongyCastleSrpVerifier`, `LibsodiumCipher`,
`SRP6StandardGroups`). This lets each install pair **its own** freshly-generated key — no
extraction, no account/SSO. **✅ VERIFIED end-to-end on a real oven** by `june_pair.py`: a fresh
keypair, paired by PIN, then successfully sent `preheat`/`keepalive` and got `success` acks. The
SRP was also validated numerically against a real app transcript (our S reproduces the app's byte
for byte).

**Critical gotcha:** after `POST …/companion`, do **NOT** immediately `DELETE` the pairing session
— the oven still needs to fetch your `key_info`, finish SRP, decrypt `companion_info`, and trust
your key. Deleting early aborts it → the oven sends `10027` (`PairingSessionInvalidated`). Instead,
wait: the oven replies with a **second `10026` frame whose `data.key_info` contains `oven_info`**
(its own keys, sealed the same way) and the device appears under
`GET /2/devices/{deviceId}/associated` (which also yields the `oven_id`). Only delete afterward, if
at all (the session expires on its own).

The real `companion_info` **plaintext** (snake_case field names, confirmed on the wire):
```json
{"companion_id":"<hex device id>","companion_name":"<display name — your call>",
 "public_signing_key":"<base64 Ed25519 pub>","public_encryption_key":"<base64 Curve25519 pub>",
 "timezone":"America/Los_Angeles","platform":"Android"}
```
`companion_name` is exactly what shows up as the device name on the oven/app — **set it to whatever
you want** (the app just copies the Android model, e.g. `sdk_gphone64_arm64`).

**Roles:** the companion (your client) is the **SRP-6a _server_**; the oven is the SRP client;
the 8-digit PIN is the shared low-entropy password.

**SRP parameters (exact):**
- Group: **RFC 5054 8192-bit** (the `f22293g` modulus in `SRP6StandardGroups`), generator **g = 19** (`0x13`).
- Hash: **SHA-1** (SpongyCastle digest used for both verifier generation and the server).
- Identity/username `I` = ASCII `"user"`.
- salt = **16 random bytes**.
- verifier `v` = standard SRP-6 `SRP6VerifierGenerator(group, SHA1).generateVerifier(salt, "user", PIN)`.

**Keys the companion generates once (persist them):**
- **Ed25519 signing keypair** — the key the oven will trust for command signatures (§6).
- **Curve25519 box (encryption) keypair** — sent alongside; used for encrypted extras.

**Flow:**
1. Register an anonymous device → token (§3).
2. `POST /2/devices/pairing` (Bearer) → `{pin:{code, expires, request_id}}`. **Display code =
   `code` + one Damm check digit** (Damm algorithm; the quasigroup table is in the app). The user
   types this 8-digit code on the oven.
3. Initialize the SRP server with the PIN as password: pick salt (16 rand), compute verifier,
   `SRP6Server.init(group8192, verifier, SHA1, secureRandom)`.
4. The oven (once the user enters the PIN) sends its SRP client public **A** to your client over
   the **messaging WebSocket** as an incoming `PairingInfo` message (A is base64). *(Exact message
   framing is the one piece to confirm during implementation.)*
5. `B = SRP6Server.generateServerCredentials()`; `S = SRP6Server.calculateSecret(A)` (shared
   secret, as unsigned big-endian bytes).
6. **Seal key `K = BLAKE2b-256(S)`** = `crypto_generichash(out=32, S)` (no key).
7. Build the plaintext `PairingCompanionInfo` JSON:
   `{companionId, name, publicSigningKey (base64 Ed25519 pub), publicEncryptionKey (base64
   Curve25519 pub), timezone, platform:"Android", platformVersion, modelNumber, serialNumber}`.
8. **`companion_info = base64( nonce(24 rand) ‖ crypto_secretbox_xsalsa20poly1305(json_utf8, nonce, K) )`**
   (NaCl secretbox: 24-byte nonce, 16-byte Poly1305 tag; the app prepends the 24-byte nonce to the
   secretbox output, then base64).
9. `POST /2/devices/pairing/{code}/companion` with body
   `{"key_info":{"salt":"<b64>","B":"<b64 server public>","companion_info":"<b64>"}}`.
10. The oven, knowing the PIN, computes the same `S`, derives `K = BLAKE2b-256(S)`, decrypts
    `companion_info`, and **stores/trusts `publicSigningKey`**.
11. `DELETE /2/devices/pairing/{code}/companion` closes the pairing session.
12. Done — your Ed25519 key is now trusted; command the oven as in §6.

**Discovering the oven after pairing:** the pairing result / `GET /2/devices/{deviceId}/associated`
(seen in traffic) yields the paired oven's id — use it as `oven_id`.

**Verify-signature cross-check (from the app's `LibsodiumCipher.a`):** to validate an oven→companion
message, split its base64 signature into `fp = sig[0:8]` and `raw = sig[8:]`, check
`fp == BLAKE2b(oven_pubkey, 8)`, then Ed25519-verify `raw` over the message. This mirrors the exact
72-byte format we send (§6) and is a good self-test of your crypto.

**Open items to confirm when implementing (crypto is known; these are wiring details):**
- Whether the SRP password is `code` alone or `code`+Damm digit (i.e. what the oven feeds SRP).
- SpongyCastle's exact `x = SHA1(salt ‖ SHA1("user:"+PIN))` construction (match SRP6 conventions).
- The precise messaging-WS message(s) that carry the oven's `A` and the completion/ack.
- libsodium secretbox output framing (confirm `nonce ‖ tag ‖ ciphertext`).

**Final verification (needs a physical oven):** implement the above, generate a PIN from your
client, type it into the oven, and confirm a signed `preheat` is accepted by *your* key.
