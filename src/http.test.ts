import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithTimeout, readResponseBuffer } from './http';

afterEach(() => vi.unstubAllGlobals());

describe('fetchWithTimeout', () => {
  it('aborts a request after its deadline', async () => {
    vi.stubGlobal('fetch', vi.fn((_input: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      })));

    await expect(fetchWithTimeout('https://example.invalid', {}, 5)).rejects.toThrow(/timed out/i);
  });

  it('preserves cancellation from the caller', async () => {
    vi.stubGlobal('fetch', vi.fn((_input: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      })));
    const controller = new AbortController();
    const request = fetchWithTimeout('https://example.invalid', { signal: controller.signal }, 1_000);
    controller.abort(new Error('caller cancelled'));

    await expect(request).rejects.toThrow('caller cancelled');
  });
});

describe('readResponseBuffer', () => {
  it('rejects a body larger than the configured maximum', async () => {
    const response = new Response(Buffer.alloc(11), { headers: { 'content-length': '11' } });

    await expect(readResponseBuffer(response, 10)).rejects.toThrow(/too large/i);
  });
});
