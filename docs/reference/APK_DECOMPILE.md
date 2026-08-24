# APK Decompile — Local Hardware Path (branch: feature/apk-local-rescue)

**APK:** `June_1.24.1.11_APKPure.apk` — 20.1M, `com.junelife.companion`, v1.24.1.11 (1240111), targetSdk 34, minSdk 21
**Tool:** `jadx 1.5.2` → `/tmp/jadx_out` (4491 classes), `androguard` for manifest, `unzip` for raw dex strings
**Branch:** `feature/apk-local-rescue` (from `agent/pr-2-review-followups`)
**Date:** 2026-08-23

---

## 1. Verdict: No local API — by design

Confirmed via full decompile + string sweep of `classes.dex`/`classes2.dex`/`classes3.dex`:

- **Zero** listeners: no `ServerSocket`, no HTTP server, no mDNS (`_http._tcp`, `_june`), no SSDP/UPnP, no CoAP, no MQTT broker, no BLE GATT outside phone-side pairing UI.
- Oven (`192.168.42.254`) has **no open ports** (65535 sweep, see `OVEN_CAPTURE.md`) — matches APK: oven is **pure cloud client**, not a local peripheral.
- Only way to drive hardware locally = **replace the cloud** and make oven connect to us. APK shows exactly how to do that.

---

## 2. Hardcoded cloud surface — `ob/d.java` (`Environment.kt`)

```java
// ob.d — DEV vs PROD
PROD: restUrl=https://api.junelife.com
      messagingUrl=https://messaging.junelife.com
      webSocketUrl=wss://messaging.junelife.com/1/messaging/websocket/companion
      recipesUrl=https://recipes.junelife.com
      clientId=dcxqbcv2dY-G12elqDoAhCP8E12V0zC8XWThT-4U
      clientSecret=tmoSUwt3OOZCcfMaIadAGD7-x-qPht85HkCgdvuhTKk1yFtfMcfJEyd
DEV:  same hosts with dev- prefix, same clientId/Secret
```

- Also found in raw strings sweep: `/2/devices/{ovenId}/info`, `/features`, `/activation`, `/1/messaging/device/{ovenId}/status`, `/2/auth/oauth/token`, `/2/devices/register`, `/2/devices/pairing/{pin}/companion`, recipe endpoints.
- `clientId/Secret` identical for **all users** — not per-install, not sodium-encrypted at rest (only in-memory via libsodium, but literal in `Environment.kt`).

---

## 3. Auth & transport

### 3.1 OAuth bearer (`ya/b.java` — `AuthModule.kt`)
- Every REST/WS call: `Authorization: Bearer <access_token>` injected by interceptor `b$a$b`.
- Token minted via `POST /2/devices/register` (device re-register), 7-day TTL (`expires_in=604800`), not `/2/auth/oauth/token` refresh (app itself re-registers).
- OkHttp timeout 15s, pin-aware client built in `ya/g.java`/`h.java`.

### 3.2 Certificate pinning (`ya/d.java`, `ya/b.java:129`, `ri/g.java`)
```java
// AuthModule_Companion_ProvideCertificatePinnerFactory
ri.g d(String apiRoot, String... apiHashes) = new g.a().a(apiRoot, hashes).b()
// hashes from JUNE_CLOUD_PROTOCOL.md (OkHttp CertificatePinner):
sha256/Ko8tivDrEjiY90yGasP6ZpBU4jwXvHqVvQI0GS3GNdA=
sha256/63ehOyGTbdiutHEq3obqv/8QpKqbgJc23iS3lsXf2nQ=
sha256/8Rw90Ej3Ttt8RRkrg+WYDS9n7IS03bk5bjP/UXPtaY8=
```
- Pins `*.junelife.com` only. App MITM fails without Frida/DEX patch — matches prior Frida scripts in `re/` (`frida_june_unpin.js` etc.).

### 3.3 WebSocket envelope (`de/l.java`, `ge/b.java`, `fe/c.java`/`d.java`)
```java
// de.l — MessageData.kt
int    v            // 2
int    message_code
long   order, time
String signature      // Ed25519, base64-like via qb.a
b0     target        // b0(str) = ovenId wrapper
String device_id, device_name
p      data          // polymorphic payload
```
- Mapping (`MessageDataTypeAdapter` + `ge/b.j`):
  - Outgoing: 11002 Preheat, 11004 CancelCooking, 11005 SetTempCavity, 11006 SetTimer, 11007 SetTargetProbe, 11015 SetCookMode, 11012 Unpair, 11031/11032 CookPlanEdit, 11035 CookAdjustment, 11016 StartCookPlan, 11017 Set/ClearRecipeState, 11018 SetCookPlanPrefs, 11011 Ping, 12001 UploadBugReport
  - Incoming: 10017/10018/? , 10020 Acquire? 10022, 10026/10027, 10033, 10011-10014 plus fallthrough → UnsupportedMessage
- Transport: `fe/c.java` (`OkHttpMessaging.kt`) wraps `fe/d.java` (`OkHttpWebSocket.kt`) — OkHttp WS to `wss://messaging…/companion`, verifies **signature** on every inbound before surfacing (`fe/d:b.e` checks `verifySignature`).

---

## 4. Crypto — why you can't just replay WSS without keys

### 4.1 Signing (`ge/e.java` — `Signing.kt`, `qb/a`, `kj/b.java`)
- Outgoing envelope `signature` = `NaCl.sign(messageBytes, seedKeypair)`:
  ```java
  // ge/e.b
  cryptoKeys.getSigningKeyPair() → oh.p.a(priv, pub) → qb.a.b(pubLen) + qb.a.h(msg, priv) → qb.a.j(signed)
  // = libsodium crypto_sign_ed25519(seed_keypair) via kj.b.g/i
  ```
- Incoming verify (`ge/e.c`): `qb.a.a(msg, sig, pubKey, pubKeyLen)` where `pubKey` = oven's `publicSigningKey` from `PairingSessionInfo`.
- Keys persisted in `ae.b` (`CryptoKeys` = encryption+signing `KeyPair`), each `KeyPair\{publicKey, privateKey: byte[]\}`.

### 4.2 Encryption / SRP pairing (`qj/`, `qb/`, `je/p4.java`)
- Native libs: `lib/*/libsodiumjni.so` + `kj/a.java` System.loadLibrary("sodiumjni") — sodium_init on first use.
- Wraps: `crypto_box_curve25519xsalsa20poly1305`, `secretbox_xsalsa20poly1305(_open)`, `scalarmult_curve25519`, `generichash`, `hash_sha256`.
- Pairing: SRP-6a via SpongyCastle (`qj/a.java` SRP6Server, `qj/c SRP6Util`, `pj/sj`), plus `qb/c SrpVerifier`, `pc/g PairingGateway` (PIN → `PairingCompanionInfoRequest`), `je/p4 PairToOvenUseCase` orchestrates PIN + SRP + symmetric key.
- Companion info (`PairingCompanionInfo`/`PairingOvenInfo`/`PairingSessionInfo`) carries `publicSigningKey` + `publicEncryptionKey` — these are the long-lived trust roots the oven checks for every command.

**Implication:** a replacement backend must know the **seed** for the companion that the oven trusts (extracted once from paired phone's `sessionInfoPreferences.xml` → `secrets.local.json`, or via Frida capture `frida_june_paircap.js`). Without it, oven rejects signature (returns 10020 ack with failure).

---

## 5. What the APK does NOT contain (exhaustive negative)

- No `register.mg-0x0002.oui-0xfff114.com` literal — that's oven firmware's UpdateLogic DMS host, not app's. APK never contacts UEI; only oven does (hence `OVEN_CAPTURE.md` OTA hijack path).
- No local subnet scan, no `192.168.*`, `10.*`, no `NsdManager`, no `WifiP2p`, no `BluetoothLeScanner` beyond UI.
- No offline cook fallback — all cook state comes from `messaging…/status` + WS.

---

## 6. Local rescue — confirmed architecture

```
[Oven 192.168.42.254] --TLS/WSS--> [Your fake cloud 192.168.42.12] --no upstream needed after capture
        | pins *.junelife.com (OVEN_CAPTURE.md: certificate_unknown, SNI=null)
        | DMS channel (register.mg-0x0002...) validates to GoDaddy G2 but IGNORES hostname → LE cert works
```

1. **DNS hijack alone is insufficient** for junelife channel (pinning). Must either:
   a) Patch oven trust store (firmware) — needs OTA or UART (see §7), OR
   b) Run replacement backend that presents a cert whose SPKI matches the 3 pinned hashes (requires June's private key — impossible), OR
   c) Intercept at app layer (patched APK / Frida unpin) to keep phone working, but oven still pins independently —phone ≠ oven.
2. **OTA DMS hijack IS feasible without firmware mod** — next oven poll (~weekly, last 2026-08-19) will accept a public Let's Encrypt cert for `dms.hadm.net` if we set `CAP_CERT=fullchain.pem` on `june-ota-capture.service` (see `OVEN_CAPTURE.md` “Drop-in to arm with a real cert”). That path can deliver a future firmware mod if needed, or at least lets us capture/serve OTA images while June lives.

---

## 7. Concrete next steps (do before Sept 2026 shutdown)

1. **Arm DMS capture with real LE cert** (one-shot per ~10 days, next ~2026-08-29):
   ```bash
   sudo certbot certonly --manual --preferred-challenges dns -d dms.hadm.net
   sudo systemctl edit june-ota-capture  # Environment=CAP_CERT=/etc/letsencrypt/live/dms.hadm.net/fullchain.pem …
   sudo systemctl restart june-ota-capture
   # watch: grep -c 192.168.42.254 re/ota_capture.jsonl && journalctl -u june-ota-capture -f
   ```
2. **Keep junelife capture warm** (phone side): run `frida_june_wscap.js` / `june_capture.py` via mitmproxy with a patched APK (unpinned) to get one full WSS trace of a cook (start/preheat/stop) — needed to seed replacement server's TLV framing. Existing `june_flows.jsonl` (6.1M) already has heartbeat, but needs cook commands.
3. **Extract pairing secrets once**: `adb backup` or `app_files_list.txt` → `sessionInfoPreferences.xml` → `extract_secrets.py` → `secrets.local.json` (ovenId, deviceId, password, ed25519_seed_hex). This is the signing root your fake backend will use.
4. **Build replacement backend skeleton** (Node/Python) that:
   - Serves `POST /2/devices/register` (mint bearer), `GET /2/devices/{ovenId}/info|features`, `GET /1/messaging/device/{ovenId}/status`
   - Accepts `wss://…/companion` with same `MessageData` envelope, verifies/re-signs via libsodium (use `kj/b` logic or `tweetnacl`), and drives oven state machine (ack 10020).
   - Start with DNS+LE cert for DMS; for junelife, plan firmware patch (add our CA) via captured OTA — if OTA is unsigned, this is a one-shot repoint; if signed (likely), need UART/eMMC path (see `OVEN_CAPTURE.md` “If the oven validates/pins”).

---

## 8. Files produced / referenced

- Decompile output: `/tmp/jadx_out` (keep, gitignored) + `/tmp/jadx_res`
- Raw: `/tmp/opencode/re/apk_unzipped` (`classes*.dex`, `AndroidManifest.xml`)
- Specs: `re/JUNE_CLOUD_PROTOCOL.md`, `re/JUNE_INTEGRATION_SPEC.md`, `re/OVEN_CAPTURE.md` (authoritative for oven-side pinning test)
- Scripts: `re/extract_secrets.py`, `re/frida_june_*`, `re/june_capture.py`, `re/ota_capture.py`, `re/pin_probe.py`
- New: this file (`re/APK_DECOMPILE.md`)

---

## 9. Repo hygiene

- APK binary not committed to git (already in `re/` but gitignored in most setups — verify before push).
- Decompiled sources not committed — only this distilled markdown + any future `re/local_backend_stub/`.
- Never commit `secrets.local.json`, `paired.local.json`, `probe_key.pem`, `dms_key.pem`.

