import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchJsonWithTimeout, fetchWithTimeout, isRetryableHttpStatus, JuneHttpError, readResponseBuffer } from './http';

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

describe('response-consuming timeout helpers', () => {
  it('keeps the timeout active while a JSON body is stalled', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: string, init?: RequestInit) => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }),
    })));

    await expect(fetchJsonWithTimeout('https://example.invalid', {}, 5)).rejects.toThrow(/timed out/i);
  });

  it('cancels non-success response bodies before returning the status', async () => {
    const cancel = vi.fn(async () => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
      body: { cancel },
    })));

    const result = await fetchJsonWithTimeout('https://example.invalid');

    expect(result.response.status).toBe(503);
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe('HTTP retry classification', () => {
  it('only retries transient HTTP statuses', () => {
    expect(isRetryableHttpStatus(401)).toBe(false);
    expect(isRetryableHttpStatus(408)).toBe(true);
    expect(isRetryableHttpStatus(429)).toBe(true);
    expect(isRetryableHttpStatus(503)).toBe(true);
    expect(new JuneHttpError('Status failed', 401).status).toBe(401);
  });
});
