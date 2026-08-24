# OTA capture — arm with LE cert before 2026-08-29

Oven polls `register.mg-0x0002.oui-0xfff114.com:443` (UpdateLogic DMS) ~every 10 days. Last hits `2026-08-23:TLSV1_ALERT_UNKNOWN_CA` — our `dms_cert.pem` self-signed was rejected (chain must be public GoDaddy-G2 / ISRG). Next window ~2026-08-29, one shot.

## Arm (DNS-01, no port 443 downtime)

```bash
# AdGuard already rewrites register.mg-0x0002.oui-0xfff114.com -> 192.168.42.12 (see re/OVEN_CAPTURE.md)
# Get LE cert without touching :443 (held by june-ota-capture.service)
sudo certbot certonly --manual --preferred-challenges dns -d dms.hadm.net
# or: sudo certbot certonly --dns-cloudflare -d dms.hadm.net  (if plugin)

# Point capture at fullchain (leaf+intermediates, fixes GoDaddy path-building gap)
sudo systemctl edit june-ota-capture  # add:
# [Service]
# Environment=CAP_CERT=/etc/letsencrypt/live/dms.hadm.net/fullchain.pem
# Environment=CAP_KEY=/etc/letsencrypt/live/dms.hadm.net/privkey.pem
# Environment=CAP_ONLY_IP=192.168.42.254

sudo systemctl restart june-ota-capture
systemctl status june-ota-capture
journalctl -u june-ota-capture -f
```

Watch for hit:

```bash
grep -c 192.168.42.254 re/ota_capture.jsonl   # >0 = oven checked in
tail -f re/ota_capture.jsonl | grep -E "client_hello|oven_handshake"
ls -lh re/ota_*.bin | tail -20
```

## What you get

- `re/ota_*.bin` + `re/ota_capture.jsonl` contain raw DMS request/response (likely OTA manifest + firmware URL). If that URL is on same host, cert now passes and you can download image offline for pin analysis.
- If firmware is unsigned / weakly signed, you can serve a patched trust store (add your CA for `*.junelife.com`). If signed, image still reveals the pin SPKI and trust anchors to clone.
- LE cert also unlocks fronting `api/messaging.junelife.com` on same box later (add SANs `dms.hadm.net`, `api.junelife.com`, `messaging.junelife.com` if you want one cert, or run separate vhosts).

## Stop & remove after capture

```bash
sudo systemctl disable --now june-ota-capture
sudo rm /etc/systemd/system/june-ota-capture.service
sudo systemctl daemon-reload
```

See `re/OVEN_CAPTURE.md` (authoritative) + `re/ota_capture.py` for the Python MITM.
