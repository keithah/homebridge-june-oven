/**
 * In-memory oven state, seeded from june_flows.jsonl /status capture.
 * Mirrors what messaging.junelife.com /1/messaging/device/{ovenId}/status returns.
 */
export interface OvenStore {
  ovenId: string;
  connectionState: 'online' | 'offline';
  // raw status json as captured, mutated by incoming commands
  lastStatus: any;
  clients: Set<any>; // ws connections
  ovenSocket?: any;
}

const stores = new Map<string, OvenStore>();

export function getOrCreateStore(ovenId: string): OvenStore {
  let s = stores.get(ovenId);
  if (!s) {
    s = {
      ovenId,
      connectionState: 'online',
      lastStatus: null,
      clients: new Set(),
    };
    stores.set(ovenId, s);
  }
  return s;
}

export function seedStatus(ovenId: string, statusJson: any) {
  const s = getOrCreateStore(ovenId);
  s.lastStatus = statusJson;
  s.connectionState = statusJson?.connection_state || 'online';
}

export function allStores() { return stores; }
