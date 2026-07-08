#!/usr/bin/env python3
"""
june_oven.py — control a June Oven via June's cloud (clean-room, reverse-engineered).

Sends signed command messages over the companion WebSocket
(wss://messaging.junelife.com/1/messaging/websocket/companion), exactly like the app:
each message is Ed25519-signed with the companion key the oven trusts.

Setup:
  pip install pynacl websocket-client requests
  python3 extract_secrets.py        # writes secrets.local.json from your capture files

Use:
  python3 june_oven.py status                 # read oven state (REST)
  python3 june_oven.py preheat bake 350        # start a preheat (mode, °F)
  python3 june_oven.py temp 375                # change target temperature (°F)
  python3 june_oven.py timer 10                # set a 10-minute timer
  python3 june_oven.py cancel                  # stop/cancel
  python3 june_oven.py listen                  # just watch incoming messages
  python3 june_oven.py refresh                 # mint a fresh access_token (7-day)

Notes:
- Temperatures are entered in °F and converted to the oven's internal milli-°C.
- The access_token lasts 7 days; `status` auto-refreshes on 401, or run `refresh`.
  Refresh = re-register our device (POST /2/devices/register) with the stored
  password + device_id + June's static client_id/client_secret. No user login needed.
"""
import json, os, sys, time, base64, hashlib, threading

import requests
import websocket                      # websocket-client
from nacl.signing import SigningKey

HERE = os.path.dirname(os.path.abspath(__file__))
SEC  = json.load(open(os.path.join(HERE, "secrets.local.json")))

MC_PREHEAT, MC_TEMP, MC_TIMER, MC_CANCEL, MC_KEEPALIVE = 11002, 11005, 11006, 11004, 11011

def f_to_millic(f):        # 350°F -> 176667  (matches the app exactly)
    return round((f - 32) * 5 / 9 * 1000)

def millic_to_f(mc):
    return round(mc / 1000 * 9 / 5 + 32)

def _signer():
    seed = bytes.fromhex(SEC["ed25519_seed_hex"])
    return SigningKey(seed)

def _key_fingerprint():
    """The 8-byte key id the oven expects prefixed on every signature:
    libsodium crypto_generichash (BLAKE2b) of the companion public key, 8 bytes."""
    pub = _signer().verify_key.encode()
    return hashlib.blake2b(pub, digest_size=8).digest()

_last_order = [0]
def _next_order():
    """Strictly increasing int the oven echoes back as request_order. Two frames sent
    in the same millisecond must NOT share an order, so bump past the last one."""
    o = int(time.time() * 1000) & 0x7FFFFFFF
    if o <= _last_order[0]:
        o = _last_order[0] + 1
    _last_order[0] = o
    return o

def build_message(code, data):
    """Ordered exactly as the app serializes it (Gson, compact)."""
    msg = {
        "v": 2,
        "message_code": code,
        "order": _next_order(),
        "time": int(time.time() * 1000),
        "signature": "",
        "device_name": SEC["device_name"],
        "device_id": SEC["device_id"],
        "data": data,
        "target": {"id": SEC["oven_id"]},
    }
    return msg

def serialize(msg):
    return json.dumps(msg, separators=(",", ":"), ensure_ascii=False)

def sign(msg):
    """Sign the signature-blanked JSON, then set signature to
    base64( blake2b(pubkey, 8) || ed25519_sig )  — the 72-byte wire format the oven
    requires. (The 8-byte key fingerprint prefix is what the app sends; omitting it
    makes the oven silently drop every command.)"""
    msg["signature"] = ""
    payload = serialize(msg).encode("utf-8")
    sig = _signer().sign(payload).signature          # 64 bytes
    msg["signature"] = base64.b64encode(_key_fingerprint() + sig).decode()  # 72 bytes
    return serialize(msg)

def _headers():
    return {"Authorization": "Bearer " + SEC["access_token"]}

# ---------- Token (auto-refresh) ----------
# The access_token lasts 7 days. To mint a fresh one we simply re-register OUR device
# (idempotent for an existing device_id): POST /2/devices/register with the stored
# password + device_id + June's static client_id/client_secret. No user login needed.
def refresh_token(save=True):
    body = {
        "password": SEC["password"],
        "device_id": SEC["device_id"],
        "client_id": SEC["client_id"],
        "client_secret": SEC["client_secret"],
        "device_type": "companion",
        "device_name": SEC["device_name"],
        "platform": "android",
        "version": "1.24.1.11",
        "platform_version": "34",
    }
    r = requests.post("https://api.junelife.com/2/devices/register", json=body,
                      headers={"User-Agent": "okhttp/4.8.1"}, timeout=15)
    r.raise_for_status()
    tok = r.json()["token"]
    SEC["access_token"] = tok["access_token"]
    SEC["refresh_token"] = tok.get("refresh_token", SEC.get("refresh_token"))
    if save:
        json.dump(SEC, open(os.path.join(HERE, "secrets.local.json"), "w"), indent=2)
    return tok

# ---------- REST (read state) ----------
def rest_get_status(auto_refresh=True):
    """Return the parsed status dict; transparently refresh the token on 401."""
    url = f"https://messaging.junelife.com/1/messaging/device/{SEC['oven_id']}/status"
    r = requests.get(url, headers=_headers(), timeout=15)
    if r.status_code == 401 and auto_refresh:
        print("… token expired, refreshing")
        refresh_token()
        r = requests.get(url, headers=_headers(), timeout=15)
    r.raise_for_status()
    return r.json()

def rest_status():
    j = rest_get_status()
    print(json.dumps(j, indent=2)[:4000])

# ---------- WebSocket (send commands) ----------
def send_command(code, data, listen_secs=6):
    """Open the companion socket, send an 11011 presence frame, then the command.
    The oven acks every frame with a 10020 {request_order, status}; we match our
    command's `order` to report success/not-allowed."""
    cmd_msg = build_message(code, data)
    cmd_order = cmd_msg["order"]
    cmd_frame = sign(cmd_msg)
    hello_frame = sign(build_message(MC_KEEPALIVE, {}))
    print(f"→ sending code {code} (order {cmd_order}):", json.dumps(data))
    result = {"acked": False, "status": None}

    def on_open(ws):
        ws.send(hello_frame)          # presence/keepalive, like the app
        ws.send(cmd_frame)
        print("… sent, waiting for oven ack")

    def on_message(ws, message):
        if not isinstance(message, str):
            return
        try:
            j = json.loads(message)
        except Exception:
            return
        mc = j.get("message_code")
        ro = (j.get("data") or {}).get("request_order")
        if mc == 10020 and ro == cmd_order:
            result["acked"] = True
            result["status"] = (j.get("data") or {}).get("status")
            print(f"← ACK  status={result['status']}")
        elif mc in (10014, 10015, 10016, 10017, 10018):   # state changes
            print(f"← state {mc}:", json.dumps(j.get("data"))[:160])

    def on_error(ws, err):
        print("! ws error:", err)

    ws = websocket.WebSocketApp(
        SEC["ws_url"],
        header=[f"Authorization: Bearer {SEC['access_token']}",
                "User-Agent: okhttp/4.8.1"],
        on_open=on_open, on_message=on_message, on_error=on_error,
    )
    t = threading.Thread(target=ws.run_forever, kwargs={"ping_interval": 20}, daemon=True)
    t.start()
    time.sleep(listen_secs)
    ws.close()
    if result["acked"]:
        print(f"✓ oven acked the command (status={result['status']})")
    else:
        print("(no ack received — check token/network; run `status` to inspect the oven)")

def cmd_listen(secs=60):
    def on_open(ws): print("… listening", secs, "s")
    def on_message(ws, m): print("←", m[:1500] if isinstance(m, str) else "<bin>")
    def on_error(ws, e): print("! ", e)
    ws = websocket.WebSocketApp(SEC["ws_url"],
        header=[f"Authorization: Bearer {SEC['access_token']}"],
        on_open=on_open, on_message=on_message, on_error=on_error)
    threading.Thread(target=ws.run_forever, daemon=True).start()
    time.sleep(secs)

def main(argv):
    if not argv:
        print(__doc__); return
    cmd = argv[0]
    if cmd == "status":
        rest_status()
    elif cmd == "preheat":
        mode = argv[1] if len(argv) > 1 else "bake"
        tempf = float(argv[2]) if len(argv) > 2 else 350
        send_command(MC_PREHEAT, {"primitive_type": mode, "temperature_cavity": f_to_millic(tempf)})
    elif cmd == "temp":
        send_command(MC_TEMP, {"plan_id": 0, "temperature_cavity": f_to_millic(float(argv[1]))})
    elif cmd == "timer":
        send_command(MC_TIMER, {"plan_id": 0, "duration": int(float(argv[1]) * 60 * 1000)})
    elif cmd == "cancel":
        send_command(MC_CANCEL, {"plan_id": 0})
    elif cmd == "listen":
        cmd_listen(int(argv[1]) if len(argv) > 1 else 60)
    elif cmd == "refresh":
        tok = refresh_token()
        print(f"✓ new token (expires_in={tok.get('expires_in')}s): {tok['access_token'][:16]}…")
    else:
        print("unknown command:", cmd); print(__doc__)

if __name__ == "__main__":
    main(sys.argv[1:])
