import { afterEach, describe, expect, it, vi } from 'vitest';

const undici = vi.hoisted(() => ({
  agents: [] as Array<{ options: unknown }>,
  fetch: vi.fn(),
}));
vi.mock('undici', () => ({
  Agent: class {
    constructor(public readonly options: unknown) {
      undici.agents.push(this);
    }
  },
  fetch: undici.fetch,
}));

import { fetchBufferWithTimeout, fetchJsonWithTimeout, fetchWithTimeout, isRetryableHttpStatus, JuneHttpError, readResponseBuffer } from './http';

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

describe('june-local TLS settings', () => {
  it('leaves requests without TLS settings on the global fetch', async () => {
    const fetch = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetch);

    await fetchJsonWithTimeout('https://api.junelife.com/2/devices/register', { method: 'POST', tls: undefined });

    expect(undici.fetch).not.toHaveBeenCalled();
    const init = (fetch.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(Object.keys(init).sort()).toEqual(['method', 'signal']);
  });

  it('sends requests with TLS settings through one shared undici Agent', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    undici.fetch.mockImplementation(async (url: string) => new Response(url.endsWith('.jpg') ? Buffer.from('jpeg') : '{}'));
    const tls = { ca: 'PEM', rejectUnauthorized: true };

    await fetchJsonWithTimeout('https://192.168.1.75/local/status', { tls });
    const { body } = await fetchBufferWithTimeout('https://192.168.1.75/media/a.jpg', { redirect: 'error', tls: { ...tls } });

    expect(fetch).not.toHaveBeenCalled();
    expect(body.toString()).toBe('jpeg');
    expect(undici.agents).toHaveLength(1);
    expect(undici.agents[0].options).toEqual({ connect: { ca: 'PEM', rejectUnauthorized: true } });
    expect(undici.fetch).toHaveBeenLastCalledWith('https://192.168.1.75/media/a.jpg', expect.objectContaining({
      redirect: 'error',
      dispatcher: undici.agents[0],
      signal: expect.any(AbortSignal),
    }));
    expect('tls' in undici.fetch.mock.calls[1][1]).toBe(false);

    await fetchJsonWithTimeout('https://192.168.1.75/local/status', { tls: { rejectUnauthorized: false } });
    expect(undici.agents).toHaveLength(2);
    expect(undici.agents[1].options).toEqual({ connect: { ca: undefined, rejectUnauthorized: false } });
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
