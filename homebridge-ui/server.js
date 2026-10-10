const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');
const { PairingManager } = require('../dist/pairing');
const { JuneClient } = require('../dist/june-client');

class JuneUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.pairing = new PairingManager();
    this.onRequest('/pair/begin', this.beginPairing.bind(this));
    this.onRequest('/pair/status', this.pairingStatus.bind(this));
    this.onRequest('/pair/cancel', this.cancelPairing.bind(this));
    this.onRequest('/oven/status', this.ovenStatus.bind(this));
    this.ready();
  }

  async beginPairing(payload) {
    try {
      const options = payload || {};
      return await this.pairing.begin(options.deviceName || 'Homebridge June', {
        endpoint: options.endpoint,
        caCert: options.caCert,
        verifySsl: options.verifySsl,
      });
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

  async cancelPairing(payload) {
    if (!payload || !payload.id) {
      throw new RequestError('Missing pairing session id.', { status: 400 });
    }
    this.pairing.cancel(payload.id);
    return { cancelled: true };
  }

  async ovenStatus(payload) {
    if (!payload || !payload.oven) {
      throw new RequestError('Missing oven config.', { status: 400 });
    }
    let client;
    let telemetry = {};
    try {
      client = new JuneClient(payload.oven, console);
      client.on('telemetry', update => {
        telemetry = { ...telemetry, ...update };
      });
      await client.fetchStatus();
    } catch (error) {
      throw new RequestError(error instanceof Error ? error.message : String(error), { status: 502 });
    }
    return {
      telemetry,
      accessToken: client.config.accessToken,
      refreshToken: client.config.refreshToken,
    };
  }
}

(() => new JuneUiServer())();
