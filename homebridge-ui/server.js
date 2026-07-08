const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');
const { PairingManager } = require('../dist/pairing');

class JuneUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.pairing = new PairingManager();
    this.onRequest('/pair/begin', this.beginPairing.bind(this));
    this.onRequest('/pair/status', this.pairingStatus.bind(this));
    this.ready();
  }

  async beginPairing(payload) {
    try {
      return await this.pairing.begin(payload && payload.deviceName ? payload.deviceName : 'Homebridge June');
    } catch (error) {
      throw new RequestError(error instanceof Error ? error.message : String(error), { status: 500 });
    }
  }

  async pairingStatus(payload) {
    if (!payload || !payload.id) {
      throw new RequestError('Missing pairing session id.', { status: 400 });
    }
    return this.pairing.status(payload.id);
  }
}

(() => new JuneUiServer())();
