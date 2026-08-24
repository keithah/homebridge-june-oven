# Cert pinning — June app + oven

## Pinned SPKIs (`ya/b.java:129` `ri/g.java:278` `AuthModule_Companion_ProvideCertificatePinnerFactory`)

```
sha256/Ko8tivDrEjiY90yGasP6ZpBU4jwXvHqVvQI0GS3GNdA=  # Go Daddy Root CA - G2 (root, self-signed, 2009-2037) — /tmp/june-chain-4.pem
sha256/63ehOyGTbdiutHEq3obqv/8QpKqbgJc23iS3lsXf2nQ=  # *.junelife.com leaf 2026-07-17 → 2027-01-31 — /tmp/june-chain-1.pem (current)
sha256/8Rw90Ej3Ttt8RRkrg+WYDS9n7IS03bk5bjP/UXPtaY8=  # backup leaf (not in current chain, CT not found)
```

`OkHttp CertificatePinner` checks **all** certs in chain, so pinning to root G2 (`Ko8t...`) allows any leaf issued by GoDaddy that chains to G2 to pass, even if leaf changes. Current leaf `63eh...` is GoDaddy-issued and chains `leaf → R1v1 → R1 → G2`.

## Live chain (`api.junelife.com:443`)

```
leaf *.junelife.com (63eh...) → R1v1 (Y1e/...) → R1 (gKjJ...) → G2 (Ko8t...) self-signed
```

`openssl s_client -connect api.junelife.com:443 -servername api.junelife.com | openssl x509 -pubkey | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | openssl enc -base64` → `63eh...` matches pin2.

## What dump we can use

- **Leaf cert** `/tmp/june-chain-1.pem` (2048-bit RSA, `CN=*.junelife.com`) — public, no private key. SPKI hash `63eh...` — pin2. Can present as server cert only if we have matching private key (we don't).
- **Root G2** `/tmp/june-chain-4.pem` — public root, self-signed, SPKI `Ko8t...` pin1. Trusted in Android system store (and oven). Cannot present as leaf without private key.
- **No private key in APK** — `META-INF/CERT.RSA` is APK signing cert, not TLS. `strings` sweep found no `PRIVATE KEY`.

## Forcing oven → local server (`192.168.42.254` → `192.168.42.12:443`)

### Why DNS hijack alone fails for `*.junelife.com`

- Oven `ClientHello sni=null`, `handshake_failed UNKNOWN_CA` (`OVEN_CAPTURE.md`) → validates chain to public root, not hostname. Self-signed `probe_cert.pem` → `unknown_ca`.
- Even with valid LE `dms.hadm.net` (`fullchain.pem` ISRG → trusted), `CertificatePinner` will reject because no cert in chain matches `Ko8t`/`63eh`/`8Rw90` (LE chain is `YR1 → ISRG Root X1`, not GoDaddy). LE works for `register.mg-0x0002.oui-0xfff114.com` because oven **ignores hostname and does not pin that host** (SANs `support.updatelogic.com` vs `register.mg-0x0002...` mismatch but accepted, `sni=null`). Confirmed `ota_capture.py` now `TLSv1` + `SECLEVEL=0` passes with LE.

### Options without UART/JTAG/eMMC (ordered)

1. **OTA via UpdateLogic DMS (non-invasive, next window ~2026-08-29)** — `AdGuard 192.168.42.11` already rewrites `*.0xfff114.com → 192.168.42.12`, `ota_capture.py:443` forwarding MITM with `LE dms.hadm.net`. Capture `ota_*.bin` manifest + firmware, check if OTA unsigned (`openssl cms -verify` / `META-INF` sig). If unsigned, craft patched OTA that adds `CA` (`/system/etc/security/cacerts`) or patches `ri/g.java` pin check to allow `LE`/`self-signed`, serve via same MITM. Oven updates, then `api/messaging → 192.168.42.12` with any `LE`/`self-signed` trusted.

2. **GoDaddy-issued cert for our domain** — Since pin1 is root G2, any cert issued by GoDaddy that chains to G2 will pass pin (root in chain). Get a free GoDaddy cert for `june.hadm.net` via `acme.godaddy.com` or purchase, present via DNS hijack `api.junelife.com → 192.168.42.12` with that cert. Oven will see chain `leaf (hadm.net) → R1v1 → R1 → G2` and pin1 matches. Needs GoDaddy API for `hadm.net` (`dig NS hadm.net`).

3. **Exploit pin check order** — Present a cert whose SPKI matches `8Rw90...` backup pin but is otherwise valid. Need to find what cert has that SPKI (CT log for `junelife.com` backup). If it's a GoDaddy backup leaf, same as above.

If OTA is signed and GoDaddy cert not obtainable → hardware `UART` header (`/dev/tty*`) or `eMMC` dump to add `CA` is only path, per `OVEN_CAPTURE.md` firmware path.

## What to try now

- Keep `AdGuard` only `*.0xfff114.com` → `192.168.42.12`, leave `api/messaging` direct to real cloud until OTA patch ready. Do not hijack `junelife` with `LE` yet — it will be rejected and break oven's current cook.
- Arm `LE dms.hadm.net` (`certbot --manual --preferred-challenges dns`), set `CAP_CERT`/`CAP_KEY` on `june-ota-capture.service`, wait for `ota_capture.jsonl` hit, dump `ota_*.bin`.
- In parallel, try to obtain GoDaddy cert for `hadm.net` to test pin1 bypass without firmware.

Dump script: `re/dump_pins.py` / `openssl s_client` above.
