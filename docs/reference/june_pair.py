#!/usr/bin/env python3
"""june_pair.py — self-pair a NEW companion key to a June oven via a PIN.

No secret extraction, no June account/login. Implements the decoded pairing:
  SRP-6a SERVER (RFC5054 8192-bit group, g=19, SHA-1)  +  BLAKE2b-256(seal)  +  NaCl secretbox.
Run it, type the shown 8-digit code into your oven, and it registers a fresh Ed25519 key the
oven will trust. Writes the new identity to paired.local.json.
"""
import json, os, sys, time, base64, hashlib, threading
import secrets as rnd
import requests, websocket
from nacl.signing import SigningKey
from nacl.public import PrivateKey
from nacl.secret import SecretBox

CLIENT_ID = "dcxqbcv2dY-G12elqDoAhCP8E12V0zC8XWThT-4U"
CLIENT_SECRET = "tmoSUwt3OOZCcfMaIadAGD7-x-qPht85HkCgdvuhTKk1yFtfMcfJEyd"
API = "https://api.junelife.com"
WS  = "wss://messaging.junelife.com/1/messaging/websocket/companion"
UA  = "okhttp/4.8.1"
HERE = os.path.dirname(os.path.abspath(__file__))

# --- SRP-6a group (extracted from the app) ---
N = int("FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A92108011A723C12A787E6D788719A10BDBA5B2699C327186AF4E23C1A946834B6150BDA2583E9CA2AD44CE8DBBBC2DB04DE8EF92E8EFC141FBECAA6287C59474E6BC05D99B2964FA090C3A2233BA186515BE7ED1F612970CEE2D7AFB81BDD762170481CD0069127D5B05AA993B4EA988D8FDDC186FFB7DC90A6C08F4DF435C93402849236C3FAB4D27C7026C1D4DCB2602646DEC9751E763DBA37BDF8FF9406AD9E530EE5DB382F413001AEB06A53ED9027D831179727B0865A8918DA3EDBEBCF9B14ED44CE6CBACED4BB1BDB7F1447E6CC254B332051512BD7AF426FB8F401378CD2BF5983CA01C64B92ECF032EA15D1721D03F482D7CE6E74FEF6D55E702F46980C82B5A84031900B1C9E59E7C97FBEC7E8F323A97A7E36CC88BE0F1D45B7FF585AC54BD407B22B4154AACC8F6D7EBF48E1D814CC5ED20F8037E0A79715EEF29BE32806A1D58BB7C5DA76F550AA3D8A1FBFF0EB19CCB1A313D55CDA56C9EC2EF29632387FE8D76E3C0468043E8F663F4860EE12BF2D5B0B7474D6E694F91E6DBE115974A3926F12FEE5E438777CB6A932DF8CD8BEC4D073B931BA3BC832B68D9DD300741FA7BF8AFC47ED2576F6936BA424663AAB639C5AE4F5683423B4742BF1C978238F16CBE39D652DE3FDB8BEFC848AD922222E04A4037C0713EB57A81A23F0C73473FC646CEA306B4BCBC8862F8385DDFA9D4B7FA2C087E879683303ED5BDD3A062B3CF5B3A278A66D2A13F83F44F82DDF310EE074AB6A364597E899A0255DC164F31CC50846851DF9AB48195DED7EA1B1D510BD7EE74D73FAF36BC31ECFA268359046F4EB879F924009438B481C6CD7889A002ED5EE382BC9190DA6FC026E479558E4475677E9AA9E3050E2765694DFC81F56E880B96E7160C980DD98EDD3DFFFFFFFFFFFFFFFFF", 16)
g = 19
PADLEN = (N.bit_length() + 7) // 8          # 1024

# --- Damm checksum table (from SpongyCastleSrpVerifier) ---
DAMM = [[0,3,1,7,5,9,8,6,4,2],[7,0,9,2,1,5,4,8,6,3],[4,2,0,6,8,7,1,3,5,9],
        [1,7,5,0,9,8,3,4,2,6],[6,1,2,3,0,4,5,9,7,8],[3,6,7,4,2,0,9,5,8,1],
        [5,8,6,9,7,2,0,1,3,4],[8,9,4,5,3,6,2,0,1,7],[9,4,3,8,6,1,7,2,0,5],
        [2,5,8,1,4,3,6,7,9,0]]
def damm(s):
    r = 0
    for ch in s: r = DAMM[r][int(ch)]
    return r

def sha1(*chunks):
    h = hashlib.sha1()
    for c in chunks: h.update(c)
    return h.digest()
def pad(x): return x.to_bytes(PADLEN, "big")
def i2b(x): return x.to_bytes((x.bit_length() + 7) // 8, "big")   # asUnsignedByteArray (minimal)
def b64(b): return base64.b64encode(b).decode()

class SrpServer:
    """BouncyCastle/SpongyCastle-compatible SRP-6a server."""
    def __init__(self, password):
        self.salt = rnd.token_bytes(16)
        x = int.from_bytes(sha1(self.salt, sha1(b"user" + b":" + password.encode())), "big")
        self.v = pow(g, x, N)
        self.k = int.from_bytes(sha1(pad(N), pad(g)), "big")
        self.b = int.from_bytes(rnd.token_bytes(32), "big") % N
        self.B = (self.k * self.v + pow(g, self.b, N)) % N
    def secret(self, A_int):
        u = int.from_bytes(sha1(pad(A_int), pad(self.B)), "big")
        S = pow((A_int * pow(self.v, u, N)) % N, self.b, N)
        return i2b(S)

def register_device():
    dev_id = rnd.token_hex(16)
    password = rnd.token_hex(16)
    body = {"password": password, "device_id": dev_id, "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET, "device_type": "companion",
            "device_name": "June CLI", "platform": "android",
            "version": "1.24.1.11", "platform_version": "34"}
    r = requests.post(f"{API}/2/devices/register", json=body, headers={"User-Agent": UA}, timeout=15)
    r.raise_for_status()
    return dev_id, password, r.json()["token"]["access_token"]

def main():
    print("Registering a fresh companion device…")
    dev_id, password, token = register_device()
    print(f"  device_id={dev_id}")
    sign_key = SigningKey.generate()
    box_key  = PrivateKey.generate()
    sign_pub = sign_key.verify_key.encode()            # Ed25519 pub (the key the oven will trust)
    box_pub  = bytes(box_key.public_key)               # Curve25519 pub

    got_A = {"val": None}
    ev = threading.Event()
    def on_open(ws): print("  (messaging socket open, listening for oven)")
    def on_message(ws, m):
        try: j = json.loads(m)
        except Exception:
            print("  <recv non-json>"); return
        mc = j.get("message_code")
        print(f"  <recv code={mc} data={json.dumps(j.get('data'))[:80]}")
        if mc == 10026:
            blob = json.dumps(j.get("data"))
            # A = the long base64 string in the payload
            import re
            cands = re.findall(r'"([A-Za-z0-9+/=]{300,})"', blob)
            if cands:
                got_A["val"] = cands[0]; ev.set()
                print("  <<< received oven public A (message_code 10026)")
        elif mc == 10027:
            print("  !!! PairingSessionInvalidated (10027) — oven rejected/aborted the session.")
            print("      Make sure the oven is idle, door closed, and connected to Wi-Fi, then retry.")
    ws = websocket.WebSocketApp(WS, header=[f"Authorization: Bearer {token}", f"User-Agent: {UA}"],
                                on_open=on_open, on_message=on_message,
                                on_error=lambda w,e: print("  ws err:", e))
    threading.Thread(target=ws.run_forever, kwargs={"ping_interval": 20}, daemon=True).start()
    time.sleep(2)

    print("Requesting a pairing code…")
    r = requests.post(f"{API}/2/devices/pairing", headers={"Authorization": f"Bearer {token}", "User-Agent": UA}, timeout=15)
    r.raise_for_status()
    code = r.json()["pin"]["code"]                     # 5-digit server code (session id / routing)
    base = code + f"{rnd.randbelow(100):02d}"          # + 2 random digits -> 7-digit base
    shown = base + str(damm(base))                     # + Damm digit -> 8-digit code = SRP password
    srp = SrpServer(shown)

    print("\n" + "="*44)
    print(f"  ENTER THIS CODE ON YOUR OVEN:  {shown[:4]} {shown[4:]}")
    print("="*44 + "\n  (waiting up to 5 min for the oven…)")

    if not ev.wait(timeout=300):
        print("Timed out waiting for the oven's A. (Did the code get entered?)"); return
    A = int.from_bytes(base64.b64decode(got_A["val"]), "big")
    S = srp.secret(A)
    K = hashlib.blake2b(S, digest_size=32).digest()
    tz = "America/Los_Angeles"
    companion = {"companion_id": dev_id, "companion_name": "June CLI",
                 "public_signing_key": b64(sign_pub), "public_encryption_key": b64(box_pub),
                 "timezone": tz, "platform": "Android"}
    pj = json.dumps(companion, separators=(",", ":")).encode()
    nonce = rnd.token_bytes(24)
    sealed = bytes(SecretBox(K).encrypt(pj, nonce))     # nonce(24) || ciphertext
    companion_info = b64(sealed)
    body = {"key_info": {"salt": b64(srp.salt), "B": b64(i2b(srp.B)), "companion_info": companion_info}}
    print("Posting companion key_info…")
    r = requests.post(f"{API}/2/devices/pairing/{code}/companion", json=body,
                      headers={"Authorization": f"Bearer {token}", "User-Agent": UA}, timeout=15)
    print("  ->", r.status_code, r.text[:200])
    # Do NOT delete the session — the oven now fetches key_info, finishes SRP, decrypts
    # companion_info and trusts our signing key. Wait for it to complete (watch WS / associated).
    print("  waiting for oven to complete pairing…")
    oven_id = None
    for _ in range(20):
        time.sleep(3)
        try:
            a = requests.get(f"{API}/2/devices/{dev_id}/associated",
                             headers={"Authorization": f"Bearer {token}", "User-Agent": UA}, timeout=10).json()
            devs = a.get("devices") or []
            if devs:
                oven_id = devs[0].get("oven_id")
                print("  ✓ PAIRED — associated devices:", json.dumps(devs)[:300])
                break
        except Exception:
            pass
    if not oven_id:
        print("  (no associated device yet — pairing may not have completed)")

    # Persist the new identity (drop-in for june_oven.py: rename to secrets.local.json)
    out = {"device_id": dev_id, "device_name": "June CLI", "password": password,
           "access_token": token, "ed25519_seed_hex": sign_key.encode().hex(),
           "client_id": CLIENT_ID, "client_secret": CLIENT_SECRET,
           "oven_id": oven_id, "ws_url": WS, "base_url": API}
    json.dump(out, open(os.path.join(HERE, "paired.local.json"), "w"), indent=2)
    print("\nSaved new identity -> paired.local.json")

    # Verify: sign a keepalive with the NEW key and confirm the oven acks it.
    if oven_id:
        fp = hashlib.blake2b(sign_pub, digest_size=8).digest()
        def signed(code_, data):
            o = int(time.time()*1000) & 0x7FFFFFFF
            msg = {"v":2,"message_code":code_,"order":o,"time":int(time.time()*1000),"signature":"",
                   "device_name":"June CLI","device_id":dev_id,"data":data,"target":{"id":oven_id}}
            p = json.dumps(msg, separators=(",",":"), ensure_ascii=False).encode()
            msg["signature"] = b64(fp + sign_key.sign(p).signature)
            return json.dumps(msg, separators=(",",":"), ensure_ascii=False), o
        res = {"ok": False}
        def v_open(w):
            f, o = signed(11011, {}); res["o"] = o; w.send(f)
        def v_msg(w, m):
            j = json.loads(m)
            if j.get("message_code") == 10020 and (j.get("data") or {}).get("request_order") == res.get("o"):
                res["ok"] = (j.get("data") or {}).get("status") == "success"
        vws = websocket.WebSocketApp(WS, header=[f"Authorization: Bearer {token}", f"User-Agent: {UA}"],
                                     on_open=v_open, on_message=v_msg)
        threading.Thread(target=vws.run_forever, kwargs={"ping_interval": 20}, daemon=True).start()
        time.sleep(5); vws.close()
        print("  ✓ verified: our key controls the oven" if res["ok"] else "  (verify keepalive not acked)")

if __name__ == "__main__":
    main()
