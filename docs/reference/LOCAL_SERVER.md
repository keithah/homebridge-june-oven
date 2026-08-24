# Local June Cloud Mock — `src/local-server`

Stand-in for `*.junelife.com` so oven + app + homebridge keep working after Sept 2026 shutdown. Runs as plain HTTP/WS on LAN; front with TLS 443 + DNS hijack for the oven.

## Run

```bash
npm run build
JUNE_LOCAL_PORT=8080 JUNE_OVEN_ID=395447f53aef42be8a0f5d43ab028330 node dist/local-server/server.js
# or: npm run local-server
```

Test:

```bash
curl -X POST http://127.0.0.1:8080/2/devices/register -H 'Content-Type: application/json' \
  -d '{"device_id":"test","password":"x","client_id":"dcxqbcv2dY-G12elqDoAhCP8E12V0zC8XWThT-4U","client_secret":"tmoSUwt3OOZCcfMaIadAGD7-x-qPht85HkCgdvuhTKk1yFtfMcfJEyd"}'
curl http://127.0.0.1:8080/1/messaging/device/395447f53aef42be8a0f5d43ab028330/status
```

Homebridge override (no TLS needed for plugin):

```json
{
  "ovenId": "395447f53aef42be8a0f5d43ab028330",
  "deviceId": "224523deaf8e495594074d8fa6c9bb97",
  "baseUrl": "http://192.168.42.12:8080",
  "messagingUrl": "http://192.168.42.12:8080",
  "wsUrl": "ws://192.168.42.12:8080/1/messaging/websocket/companion"
}
```

Oven path (needs TLS): DNS `api.junelife.com` + `messaging.junelife.com` → `192.168.42.12`, nginx/stunnel 443 → 8080 with LE cert for `dms.hadm.net` + junelife SANs (see `re/OVEN_CAPTURE.md`).

## Endpoints (mocked)

- `POST /2/devices/register` → `{ token: { access_token: "v2:local-...", expires_in: 604800 } }` — accepts any password
- `POST /2/auth/oauth/token` → same
- `POST /2/devices/{id}` → `{ success: true }` (heartbeat)
- `GET /2/devices/pairing`, `GET /2/devices/{id}/associated`, `/info`, `/features` → minimal success
- `GET /1/messaging/device/{ovenId}/status` → in-memory status (seed via `POST /seed { ovenId, status }`)
- `WSS ws://.../1/messaging/websocket/companion` → verifies signature loosely, acks `11011` with `10020`, synthesizes `10013` telemetry

## WSS framing

Wire format is `JuneFrame` `src/protocol.ts:88` — `v:2`, `message_code`, `order`, `time`, `signature` (72B `BLAKE2b(pub,8)||Ed25519`), `device_id/name`, `data`, `target.id`. Client signing via `src/protocol.ts:182 signFrame` (libsodium). Server currently accepts any sig and replies with `10020 { request_order, status:"success" }` + `10013` cavity telemetry. Harden later with `src/local-server/crypto.ts:8 verifyCompanionSignature` once pairing seed is loaded.

## Next

- Wire oven relay: when oven WSS connects (same path, `device_id==ovenId`), broadcast its `10013` to companions instead of synthesizing
- Persist state, load seed from `re/june_flows.jsonl` capture via `POST /seed`
- Add TLS front + AdGuard rewrite (see `re/OVEN_CAPTURE.md` Drop-in)
