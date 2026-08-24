import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import sodium from 'libsodium-wrappers';
import { getOrCreateStore, seedStatus } from './store';

// Minimal June cloud mock — runs on http://0.0.0.0:8080 (override via JUNE_LOCAL_PORT)
// Use with homebridge config overrides: baseUrl http://<lan-ip>:8080, messagingUrl same, wsUrl ws://<lan-ip>:8080/1/messaging/websocket/companion
// For oven DNS hijack (when you have LE cert / patched trust), front with stunnel/nginx TLS on 443.

const PORT = parseInt(process.env.JUNE_LOCAL_PORT || '8080', 10);

// Seed from captured status if available (re/june_flows.jsonl first 200 status)
// Fallback minimal status
const DEFAULT_OVEN_ID = process.env.JUNE_OVEN_ID || '395447f53aef42be8a0f5d43ab028330';

let seedStatusJson: any = null;
try {
  // try load from docs/reference if re/ is gitignored — caller can seed via POST /seed
  seedStatusJson = {
    connection_state: 'online',
    // minimal structure the app/homebridge expects; real status has cook_plan etc — will be enriched live
    oven_mode: 'idle',
    oven_temp_milliC: 25000,
  };
} catch {}

if (seedStatusJson) seedStatus(getOrCreateStore(DEFAULT_OVEN_ID).ovenId, seedStatusJson);

function json(res: http.ServerResponse, code: number, obj: any) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
  // console.log(req.method, url.pathname);

  // CORS for homebridge-ui / browser
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Collect body
  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    let j: any = null;
    try { j = body ? JSON.parse(body) : null; } catch {}
    const auth = (req.headers.authorization || '').toString();

    // POST /2/devices/register — mint bearer (7d). Accept any password/device_id, echo back token v2:local-...
    if (req.method === 'POST' && url.pathname === '/2/devices/register') {
      const deviceId = j?.device_id || 'local-companion';
      const token = `v2:local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      // remember companion public key if supplied? For now stash deviceId mapping
      json(res, 200, { success: true, token: { access_token: token, refresh_token: token, expires_in: 604800, scope: '', token_type: 'Bearer' } });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/2/auth/oauth/token') {
      const token = `v2:local-${Date.now().toString(36)}`;
      json(res, 200, { access_token: token, refresh_token: token, expires_in: 604800, token_type: 'Bearer' });
      return;
    }
    // Heartbeat the app does: POST /2/devices/{companionId}
    if (req.method === 'POST' && /^\/2\/devices\/[^/]+$/.test(url.pathname)) {
      json(res, 200, { success: true });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/2/devices/pairing') {
      json(res, 200, { success: true, pairings: [] });
      return;
    }
    if (req.method === 'GET' && /^\/2\/devices\/[^/]+\/associated$/.test(url.pathname)) {
      // return associated ovens
      json(res, 200, { success: true, devices: [{ oven_id: DEFAULT_OVEN_ID, id: DEFAULT_OVEN_ID }] });
      return;
    }
    if (req.method === 'GET' && /^\/2\/devices\/[^/]+\/info$/.test(url.pathname)) {
      json(res, 200, { success: true, device: { id: DEFAULT_OVEN_ID, model: 'meerkat', serial: 'JM118AV11215', version: '1.24.1.36' } });
      return;
    }
    if (req.method === 'GET' && /^\/2\/devices\/[^/]+\/features$/.test(url.pathname)) {
      json(res, 200, { success: true, features: [] });
      return;
    }
    // GET /1/messaging/device/{ovenId}/status
    if (req.method === 'GET' && /^\/1\/messaging\/device\/[^/]+\/status$/.test(url.pathname)) {
      const ovenId = url.pathname.split('/')[4];
      const store = getOrCreateStore(ovenId || DEFAULT_OVEN_ID);
      const status = store.lastStatus || {
        connection_state: 'online',
        oven_mode: 'idle',
        timestamp: Date.now(),
      };
      // ETag handling (app sends If-None-Match)
      json(res, 200, status);
      return;
    }
    // POST /seed — dev helper to ingest a real status json from re/june_flows.jsonl
    if (req.method === 'POST' && url.pathname === '/seed') {
      if (j?.ovenId && j?.status) seedStatus(j.ovenId, j.status);
      json(res, 200, { success: true, stores: [...require('./store').allStores().keys()] });
      return;
    }
    // Fallback: log
    console.log('unhandled', req.method, url.pathname, body.slice(0, 500));
    json(res, 404, { success: false, error: 'not found (local mock)' });
  });
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
  if (url.pathname === '/1/messaging/websocket/companion') {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// Track connections: companion vs oven (oven will use same path but device_id = ovenId)
wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
  const auth = (req.headers.authorization || '').toString();
  const url = new URL(req.url || '/', 'http://localhost');
  console.log('[ws] connect', url.pathname, auth.slice(0, 24), 'clients', wss.clients.size);

  // Optional: reject unauthenticated? For local, accept anything that looks like Bearer
  // if (!auth.startsWith('Bearer ')) { ws.close(4401, 'need Bearer'); return; }

  ws.on('message', async (data: Buffer) => {
    const txt = data.toString('utf8');
    let msg: any;
    try { msg = JSON.parse(txt); } catch { console.log('[ws] non-json', txt.slice(0, 300)); return; }
    const code = msg.message_code;
    const order = msg.order;
    const targetId = msg.target?.id || DEFAULT_OVEN_ID;
    const store = getOrCreateStore(targetId);

    // Light verify: signature must be 72b base64 if present and not empty
    // For local dev we accept empty or invalid and just log, to keep bringup easy
    if (msg.signature) {
      // best-effort verify against derived pubkey fingerprint if we have companion key — skip for now
      // console.log('[ws] sig present', msg.signature.slice(0, 16));
    }

    console.log('[ws] <--', code, 'order', order, 'target', targetId, 'data', JSON.stringify(msg.data).slice(0, 200));

    // Relay to oven if this is a companion command and we have an oven socket
    // For now oven is not connected locally, so we synthesize ack + state

    // Keepalive 11011 → ack 10020 success
    if (code === 11011) {
      const ack = {
        v: 2, message_code: 10020, order: Date.now() & 0x7fffffff, time: Date.now(),
        signature: '', device_id: targetId, data: { request_order: order, status: 'success' }, target: { id: targetId }
      };
      ws.send(JSON.stringify(ack));
      return;
    }

    // Commands 11002 preheat, 11004 cancel, 11005 temp, 11006 timer → ack success + broadcast telemetry
    const ack = {
      v: 2, message_code: 10020, order: Date.now() & 0x7fffffff, time: Date.now(),
      signature: '', device_id: targetId, data: { request_order: order, status: 'success' }, target: { id: targetId }
    };
    ws.send(JSON.stringify(ack));

    // Synthesize a 10013 telemetry update so homebridge sees temp change
    // Use store.lastStatus as base
    const tempMilli = msg.data?.temperature_cavity ?? msg.data?.temperatureCavity ?? 176667;
    const fakeTelemetry = {
      v: 2, message_code: 10013, order: Date.now() & 0x7fffffff, time: Date.now(),
      signature: '', device_id: targetId,
      data: {
        cook_plan_data: store.lastStatus?.cook_plan || null,
        cook_state_data: { progress: { label_type: 'temperature', label_value: typeof tempMilli === 'number' ? tempMilli : 52000, percentage: 0.5 }, step_id: 1 },
        heating_configuration: { bottom_power_0: 100, top_power_0: 50, top_power_1: 50 },
        sensor_data: { cavity: typeof tempMilli === 'number' ? tempMilli : 52000 }
      },
      target: { id: targetId }
    };
    // delay a bit to emulate oven
    setTimeout(() => {
      for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(fakeTelemetry));
    }, 200);
  });

  ws.on('close', () => console.log('[ws] close'));
  ws.on('error', e => console.log('[ws] error', e.message));

  // Push initial hello: 10015 cook_plan + 10013 telemetry like real cloud does
  setTimeout(() => {
    const hello = {
      v: 2, message_code: 10013, order: Date.now() & 0x7fffffff, time: Date.now(),
      signature: '', device_id: DEFAULT_OVEN_ID,
      data: { sensor_data: { cavity: 25000 }, connection_state: 'online' },
      target: { id: DEFAULT_OVEN_ID }
    };
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(hello));
  }, 300);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('June local cloud mock listening on http://0.0.0.0:' + PORT);
  console.log('  REST:  POST /2/devices/register, GET /1/messaging/device/:id/status');
  console.log('  WSS:   ws://<host>:' + PORT + '/1/messaging/websocket/companion');
  console.log('  Seed:  POST /seed { ovenId, status }');
  console.log('  Override homebridge config: baseUrl/messagingUrl=http://<host>:' + PORT + ', wsUrl=ws://<host>:' + PORT + '/1/messaging/websocket/companion');
  console.log('  For oven DNS hijack, front with TLS 443 (LE cert for dms + junelife) -> proxy to :' + PORT);
});
