export const DEFAULT_HTTP_TIMEOUT_MS = 15_000;

export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

export class JuneHttpError extends Error {
  constructor(operation: string, public readonly status: number) {
    super(`${operation}: ${status}`);
    this.name = 'JuneHttpError';
  }
}

interface TimedResponse<T> {
  response: Response;
  body: T;
}

async function consumeWithTimeout<T>(
  input: string | URL,
  init: RequestInit,
  timeoutMs: number,
  consume: (response: Response) => Promise<T>,
): Promise<TimedResponse<T>> {
  const controller = new AbortController();
  const timeoutError = new Error(`June HTTP request timed out after ${timeoutMs}ms`);
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  timer.unref?.();
  const callerSignal = init.signal;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) {
    abortFromCaller();
  } else {
    callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  }

  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    return { response, body: await consume(response) };
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', abortFromCaller);
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response is already unusable; there is nothing further to release.
  }
}

export async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
): Promise<Response> {
  return (await consumeWithTimeout(input, init, timeoutMs, async response => response)).response;
}

export async function fetchJsonWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
): Promise<TimedResponse<unknown>> {
  return consumeWithTimeout(input, init, timeoutMs, async response => {
    if (!response.ok) {
      await cancelResponseBody(response);
      return undefined;
    }
    return response.json() as Promise<unknown>;
  });
}

export async function fetchBufferWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
  maxBytes = 10 * 1024 * 1024,
): Promise<TimedResponse<Buffer>> {
  return consumeWithTimeout(input, init, timeoutMs, async response => {
    if (!response.ok) {
      await cancelResponseBody(response);
      return Buffer.alloc(0);
    }
    return readResponseBuffer(response, maxBytes);
  });
}

export async function readResponseBuffer(response: Response, maxBytes: number): Promise<Buffer> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`June HTTP response is too large (${contentLength} bytes).`);
  }
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`June HTTP response is too large (over ${maxBytes} bytes).`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}
