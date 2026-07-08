import { describe, it, expect } from 'vitest';
import { JuneClient, parseProbeTelemetry } from './june-client';

describe('parseProbeTelemetry', () => {
  it('reads left/right probe milli-C into Celsius', () => {
    const out = parseProbeTelemetry({ sensor_data: { left_probe: 60000, right_probe: 62500 }, food_present: true });
    expect(out).toEqual({ probeLeftC: 60, probeRightC: 62.5, probePresent: true });
  });

  it('falls back to single probe_temperature as the left probe', () => {
    const out = parseProbeTelemetry({ sensor_data: { probe_temperature: 71000 } });
    expect(out.probeLeftC).toBe(71);
    expect(out.probeRightC).toBeUndefined();
  });

  it('returns empty object when no probe data present', () => {
    expect(parseProbeTelemetry({ sensor_data: { cavity: 150000 } })).toEqual({});
  });
});

describe('startMode', () => {
  it('exists as a method', () => {
    const client = new JuneClient({
      ovenId: 'o', deviceId: 'd', deviceName: 'n', password: 'p', ed25519SeedHex: 'ab',
    }, { debug() {}, warn() {}, error() {} });
    expect(typeof client.startMode).toBe('function');
  });
});
