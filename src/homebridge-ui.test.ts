import { readFile } from 'node:fs/promises';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  loadJuneConfig,
  saveJuneConfig,
} from '../homebridge-ui/public/june-ui.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('June Oven custom UI configuration', () => {
  test('rejects initialization when Homebridge does not return plugin config', async () => {
    vi.useFakeTimers();
    const homebridge = {
      getPluginConfig: vi.fn(() => new Promise(() => undefined)),
    };
    let rejection: unknown;

    void loadJuneConfig(homebridge).catch((error: unknown) => {
      rejection = error;
    });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(rejection).toEqual(new Error('Homebridge UI request timed out'));
  });

  test('persists the complete platform configuration without a linked schema form', async () => {
    const config = [{
      platform: 'JuneOven',
      name: 'June',
      ovens: [{
        ovenId: 'oven-1',
        readySensor: false,
        refreshToken: 'secret-refresh-token',
      }],
    }];
    const homebridge = {
      updatePluginConfig: vi.fn(async () => undefined),
      savePluginConfig: vi.fn(async () => undefined),
    };

    await saveJuneConfig(homebridge, config);

    expect(homebridge.updatePluginConfig).toHaveBeenCalledWith(config);
    expect(homebridge.savePluginConfig).toHaveBeenCalledOnce();

    const html = await readFile('homebridge-ui/public/index.html', 'utf8');
    expect(html).not.toContain('homebridge.showSchemaForm');
  });

  test('serializes pairing polls instead of starting overlapping intervals', async () => {
    const html = await readFile('homebridge-ui/public/index.html', 'utf8');

    expect(html).not.toContain('setInterval(() => pollStatus');
    expect(html).toContain('pollTimer = setTimeout');
    expect(html).not.toContain('function withTimeout');
  });
});
