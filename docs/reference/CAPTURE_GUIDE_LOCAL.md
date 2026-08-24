# Capturing the missing cook frames (Frida unpin)

`re/june_ws.log` already has `11011` ping + `11004` cancel + `10020` ack + `10013` telemetry, but no `11002` preheat / `11016` startCookPlan with full `data`. The APK pins `*.junelife.com` (`ya/b.java:129`, `sha256/Ko8t...` in `JUNE_CLOUD_PROTOCOL.md`), so plain mitmproxy sees nothing (iOS WS also bypasses HTTP proxy).

## What you need

- Rooted Android or emulator (Android Studio, API 34) with June `1.24.1.11`
- Frida + `frida-server` on device, or patch APK DEX (` apktool` + remove pin strings)
- mitmproxy or `re/june_capture.py` on LAN, DNS still pointing direct (no hijack yet)

## Frida unpin (use existing scripts in re/)

```bash
# 1. Install APK on emulator
adb install re/June_1.24.1.11_APKPure.apk

# 2a. Hook cert pinner + WSS signing (captures plaintext before TLS + signature)
adb push re/frida_june_unpin.js /data/local/tmp/
adb push re/frida_june_wscap.js /data/local/tmp/
frida -U -f com.junelife.companion -l re/frida_june_unpin.js -l re/frida_june_wscap.js --no-pause

# 2b. Alternative: Sodium-level capture (shows raw frames + 72B sig)
frida -U -f com.junelife.companion -l re/frida_june_wssend.js -l re/frida_june_wsframes.js --no-pause

# 3. With Frida running, start mitmproxy for HTTP (optional, for token + status)
mitmdump -s re/june_capture.py --mode transparent --showhost --set connection_strategy=lazy
# Trust mitmproxy CA on device: http://mitm.it
```

Scripts in `re/`:

- `frida_june_unpin.js` — hooks `CertificatePinner` (`ri/g.java`)
- `frida_june_wscap.js` / `frida_june_wsframes.js` — hooks `OkHttpWebSocket` (`fe/d.java`) and `SodiumJNI.crypto_sign_ed25519*` (`kj/b.java`)
- `frida_june_srpfull.js` / `frida_june_srptx.js` — capture SRP pairing exchange (for local pairing server)
- `frida_june_wshdr.js` — log WS `Authorization` header

## Sequence to trigger

1. App cold start → `POST /2/devices/register` (captures `client_id/secret` already known, but confirms seed)
2. Tap **Preheat → Bake 350** → look for `message_code 11002` with `data: { primitive_type:"bake", temperature_cavity:176667 }`
3. Change temp → `11005 { plan_id:0, temperature_cavity: ... }`
4. Timer → `11006 { plan_id:0, duration: ... }`
5. Cancel → `11004 { plan_id:0 }` (already in `june_ws.log:11004`)
6. Keep connection 30s → collect server pushes `10013` telemetry + `10020` acks

Save output: `june_ws.log` (Frida) + `june_flows.jsonl` (mitmproxy). Then:

```bash
# decode any capture
python3 -c "import json; [print(l[:400]) for l in open('re/june_ws.log') if 'message_code' in l][:5]"
# feed status seed to local mock
curl -X POST http://192.168.42.12:8080/seed -H 'Content-Type: application/json' \
  -d @<(jq -s '.[] | select(.url | contains(\"/status\")) | .resp_body | fromjson' re/june_flows.jsonl | head -1 | jq '{ovenId:"395447f53aef42be8a0f5d43ab028330", status:.}')
```

## Why VPN-level capture otherwise fails

iOS `RealWebSocket` (`ej/d.java`) uses raw sockets, not `CFNetwork` proxy. Android `OkHttpWebSocket` does too. `re/june_capture.py` notes zero WS frames via HTTP proxy. Frida hooking `SodiumJNI.crypto_sign_ed25519_open` is more reliable than TLS MITM for WSS.
