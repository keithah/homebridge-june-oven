import { describe, expect, it } from 'vitest';
import { buildShownCode, damm, modPow, SrpServer } from './pairing';

describe('Damm PIN construction', () => {
  it('appends a check digit that validates to zero', () => {
    const shown = buildShownCode('46605', 3);

    expect(shown).toMatch(/^\d{8}$/);
    expect(shown).toBe('46605037');
    expect(damm(shown)).toBe(0);
  });
});

describe('SRP server', () => {
  it('produces deterministic B and shared secret for fixed inputs', () => {
    const server = new SrpServer('46605037', Buffer.alloc(16, 1), 5n);
    const A = modPow(19n, 7n, BigInt(`0x${'f'.repeat(16)}`));
    const secret = server.secret(A);

    expect(server.saltBase64()).toBe('AQEBAQEBAQEBAQEBAQEBAQ==');
    expect(server.publicBase64().length).toBeGreaterThan(1000);
    expect(secret.length).toBeGreaterThan(0);
  });
});
