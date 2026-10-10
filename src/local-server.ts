import { X509Certificate } from 'crypto';
import { isIP } from 'net';
import { fetchJsonWithTimeout } from './http';
import {
  JUNE_API_URL,
  JUNE_MESSAGING_URL,
  JUNE_USER_AGENT,
  JUNE_WS_PATH,
  JUNE_WS_URL,
} from './settings';

/**
 * Project July's june-local server runs on the oven itself and serves the same
 * REST and WebSocket routes as June's cloud from one base URL: over TLS on 443
 * with a per-install CA certificate, and over plain HTTP on this port.
 */
export const LOCAL_HTTP_PORT = 8080;

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

export type JuneServerErrorKind = 'invalid-endpoint' | 'invalid-ca' | 'not-local-server' | 'certificate' | 'cannot-connect';

export class JuneServerError extends Error {
  constructor(public readonly kind: JuneServerErrorKind, message: string) {
    super(message);
    this.name = 'JuneServerError';
  }
}

/** TLS settings for a june-local server, named as `ws` and undici expect them. */
export interface JuneTlsOptions {
  ca?: string;
  rejectUnauthorized: boolean;
}

export interface JuneServerSettings {
  endpoint?: string;
  caCert?: string;
  verifySsl?: boolean;
}

export interface JuneEndpoints {
  apiUrl: string;
  messagingUrl: string;
  wsUrl: string;
  local: boolean;
}

function invalidEndpoint(detail: string): JuneServerError {
  return new JuneServerError(
    'invalid-endpoint',
    `Invalid oven address (${detail}). Enter a hostname or IP address with an optional port, such as 192.168.1.75 or june-oven.local:443.`,
  );
}

/**
 * Normalize a user-entered endpoint to `scheme://host[:port]`.
 *
 * Accepts a hostname or an IPv4/IPv6 address, optionally with a port and an
 * `https://` or `http://` prefix. HTTPS is assumed; plain HTTP defaults to the
 * local server's port-8080 listener. An empty value returns '' and selects
 * June's cloud. Throws a JuneServerError for anything else.
 */
export function normalizeEndpoint(value: string): string {
  let text = value.trim();
  if (!text) {
    return '';
  }
  if (isIP(text) === 6) {
    text = `[${text}]`;
  }
  if (!text.includes('://')) {
    text = `https://${text}`;
  }
  const parts = /^([^:/?#]+):\/\/([^/?#]*)(.*)$/.exec(text);
  if (!parts) {
    throw invalidEndpoint('unrecognized format');
  }
  const scheme = parts[1].toLowerCase();
  const netloc = parts[2];
  if (scheme !== 'http' && scheme !== 'https') {
    throw invalidEndpoint(`unsupported scheme "${parts[1]}"`);
  }
  if (netloc.includes('@') || !/^\/*$/.test(parts[3])) {
    throw invalidEndpoint('enter only a hostname or IP address and optional port');
  }
  const hostPort = /^(?:\[([^\]]*)\]|([^:[\]]*))(?::(\d*))?$/.exec(netloc);
  if (!hostPort) {
    throw invalidEndpoint('malformed host or port');
  }
  let port: number | undefined;
  if (hostPort[3]) {
    port = Number(hostPort[3]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw invalidEndpoint(`invalid port "${hostPort[3]}"`);
    }
  }

  let host: string;
  if (hostPort[1] !== undefined) {
    if (isIP(hostPort[1]) !== 6) {
      throw invalidEndpoint(`invalid IPv6 address "${hostPort[1]}"`);
    }
    try {
      // The WHATWG URL parser prints IPv6 addresses in compressed form.
      host = new URL(`http://[${hostPort[1]}]`).hostname;
    } catch {
      throw invalidEndpoint(`invalid IPv6 address "${hostPort[1]}"`);
    }
  } else if (isIP(hostPort[2]) === 4) {
    host = hostPort[2];
  } else {
    host = hostPort[2].toLowerCase().replace(/\.+$/, '');
    if (!host) {
      throw invalidEndpoint('missing hostname');
    }
    if (!HOSTNAME.test(host)) {
      throw invalidEndpoint(`invalid hostname "${host}"`);
    }
  }

  if (scheme === 'http' && port === undefined) {
    port = LOCAL_HTTP_PORT;
  }
  if (scheme === 'https' && port === 443) {
    port = undefined;
  }
  return `${scheme}://${host}${port !== undefined ? `:${port}` : ''}`;
}

/** Derive every service URL from one endpoint; empty means June's cloud. */
export function buildEndpoints(endpoint = ''): JuneEndpoints {
  const base = normalizeEndpoint(endpoint);
  if (!base) {
    return { apiUrl: JUNE_API_URL, messagingUrl: JUNE_MESSAGING_URL, wsUrl: JUNE_WS_URL, local: false };
  }
  const [scheme, netloc] = base.split('://');
  return {
    apiUrl: base,
    messagingUrl: base,
    wsUrl: `${scheme === 'https' ? 'wss' : 'ws'}://${netloc}${JUNE_WS_PATH}`,
    local: true,
  };
}

/**
 * Check a pasted CA certificate bundle and return it trimmed ('' if empty).
 * Throws a JuneServerError when it holds no parseable PEM certificate.
 */
export function normalizeCaCert(value: unknown): string {
  const pem = typeof value === 'string' ? value.trim() : '';
  if (!pem) {
    return '';
  }
  const certificates = pem.match(PEM_CERTIFICATE) ?? [];
  try {
    if (!certificates.length) {
      throw new Error('no certificate');
    }
    certificates.forEach(certificate => new X509Certificate(certificate));
  } catch {
    throw new JuneServerError(
      'invalid-ca',
      'Invalid CA certificate. Paste the full contents of ca.crt, including the BEGIN and END lines.',
    );
  }
  return pem;
}

/**
 * The TLS settings to use for a local HTTPS endpoint, or undefined when the
 * defaults (the system certificate store) apply: June's cloud, a plain-HTTP
 * endpoint, or a local endpoint with verification on and no pasted CA. A
 * pasted CA is trusted on its own, without the system store.
 */
export function localTlsOptions(endpoint: string, caCert: string, verifySsl: boolean): JuneTlsOptions | undefined {
  if (!endpoint.startsWith('https://')) {
    return undefined;
  }
  if (!verifySsl) {
    return { rejectUnauthorized: false };
  }
  return caCert ? { ca: caCert, rejectUnauthorized: true } : undefined;
}

/**
 * Re-home a camera frame URL onto the configured local server.
 *
 * june-local names api.junelife.com (or its --media-url) in 10011 frames
 * because the oven believes it is talking to June's cloud. Only the path and
 * query are kept, so images are only ever fetched from the configured server.
 */
export function localMediaUrl(endpoint: string, candidate: unknown): string | undefined {
  if (!endpoint || typeof candidate !== 'string') {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (!url.pathname.startsWith('/media/') || url.pathname.split('/').includes('..')) {
    return undefined;
  }
  return `${endpoint}${url.pathname}${url.search}`;
}

export interface ResolvedJuneServer {
  /** Normalized endpoint; '' selects June's cloud. */
  endpoint: string;
  caCert: string;
  verifySsl: boolean;
  endpoints: JuneEndpoints;
  tls?: JuneTlsOptions;
}

/**
 * Normalize an oven's server settings. The CA certificate and verifySsl only
 * apply to a local endpoint; June's cloud always uses the system store.
 * Throws a JuneServerError for an invalid endpoint or CA certificate.
 */
export function resolveServerSettings(settings: JuneServerSettings = {}): ResolvedJuneServer {
  const endpoint = normalizeEndpoint(typeof settings.endpoint === 'string' ? settings.endpoint : '');
  const caCert = endpoint ? normalizeCaCert(settings.caCert) : '';
  const verifySsl = settings.verifySsl !== false;
  return {
    endpoint,
    caCert,
    verifySsl,
    endpoints: buildEndpoints(endpoint),
    tls: localTlsOptions(endpoint, caCert, verifySsl),
  };
}

const LOCAL_STATUS_TIMEOUT_MS = 10_000;
const CERTIFICATE_ERROR_CODE = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ERR_TLS|HOSTNAME_MISMATCH/;

function errorChain(error: unknown): Array<{ code?: unknown; message?: unknown }> {
  const chain: Array<{ code?: unknown; message?: unknown }> = [];
  let current = error;
  while (current && typeof current === 'object' && chain.length < 5) {
    chain.push(current as { code?: unknown; message?: unknown });
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

function isCertificateError(error: unknown): boolean {
  return errorChain(error).some(entry =>
    (typeof entry.code === 'string' && CERTIFICATE_ERROR_CODE.test(entry.code)) ||
    (typeof entry.message === 'string' && /certificate/i.test(entry.message)));
}

function innermostMessage(error: unknown): string {
  const chain = errorChain(error);
  const message = chain[chain.length - 1]?.message;
  return typeof message === 'string' && message ? message : String(error);
}

/**
 * Confirm a local endpoint is a reachable, trusted Project July june-local
 * server by reading `GET {endpoint}/local/status`.
 */
export async function checkLocalServer(endpoint: string, tls?: JuneTlsOptions, timeoutMs = LOCAL_STATUS_TIMEOUT_MS): Promise<void> {
  let response: Response;
  let body: unknown;
  try {
    ({ response, body } = await fetchJsonWithTimeout(`${endpoint}/local/status`, {
      headers: { 'User-Agent': JUNE_USER_AGENT },
      tls,
    }, timeoutMs));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new JuneServerError('not-local-server', `${endpoint} answered, but it is not a Project July june-local server (invalid JSON). Check the oven address.`);
    }
    if (isCertificateError(error)) {
      throw new JuneServerError(
        'certificate',
        `The TLS certificate at ${endpoint} is not trusted (${innermostMessage(error)}). Paste your Project July CA certificate, make sure the oven address matches a name or IP address in the certificate, or turn off certificate verification.`,
      );
    }
    throw new JuneServerError(
      'cannot-connect',
      `Could not connect to ${endpoint} (${innermostMessage(error)}). Check the oven address, that the oven is switched on, and that Homebridge can reach it.`,
    );
  }
  if (!response.ok) {
    throw new JuneServerError('not-local-server', `${endpoint} answered, but it is not a Project July june-local server (HTTP ${response.status}). Check the oven address.`);
  }
  if (!body || typeof body !== 'object' || (body as { server?: unknown }).server !== 'june-local') {
    throw new JuneServerError('not-local-server', `${endpoint} answered, but it is not a Project July june-local server. Check the oven address.`);
  }
}
