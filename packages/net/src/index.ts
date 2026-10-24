// SSRF guards for server-side fetches of a user/agent-supplied URL. A URL that
// resolves to a loopback, link-local, or private-range address could reach internal
// services (including the cloud metadata endpoint at 169.254.169.254), so those are
// rejected. The check resolves DNS, so a public hostname that points at a private
// address is caught too.
//
// This runs on Cloudflare Workers (nodejs_compat). There, the Node DNS lookup throws "Not
// implemented" and fetch cannot connect to an address chosen by the caller, so:
// - the hostname is resolved over DNS-over-HTTPS (Cloudflare's resolver), and every
//   address it returns is checked before the request is sent;
// - the request is left to the runtime, which resolves the name again. The address
//   checked is therefore not pinned to the connection: a name whose answer changes
//   between the check and the connection (DNS rebinding) is not caught by this module;
// - redirects are never followed: a 3xx is returned as-is, so each hop is a new call
//   that is validated again before anything is sent to it.
//
// SSRF_ALLOWED_HOSTS names the hosts an operator has decided to trust anyway — see
// isAllowedHost below. It is empty by default.

export class UrlNotAllowedError extends Error {}

// A response body larger than the caller's maxBytes.
export class ResponseTooLargeError extends Error {}

// DNS-over-HTTPS endpoint of Cloudflare's public resolver.
const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';

// A hostname that is inherently local (not an IP literal).
function isLocalHostname(host: string): boolean {
  return host === 'localhost' || host.endsWith('.local');
}

// Hosts the operator has explicitly trusted even though they resolve privately.
//
// The rules above are right for a URL that arrives as content — a webhook target, an
// attachment to import. A self-hosted repository host is different: its address is
// configuration, entered by someone who already administers the project's
// integrations, and on a self-hosted instance it is normally a private one. Without
// an escape hatch, connecting an instance to a Gitea, Forgejo, or GitLab on the same
// network cannot be expressed at all.
//
// Empty by default, so nothing is exempt unless it is named. Matching is on the exact
// hostname — no wildcards, no CIDR ranges, no suffix matching — so naming one host
// trusts one host. Everything else still applies to it: https is still required.
//
// Read per call rather than at module load so a test can set it around one case.
function isAllowedHost(host: string): boolean {
  // process is typed `any` by @cloudflare/workers-types, hence the annotation.
  const configured: string | undefined = process.env.SSRF_ALLOWED_HOSTS;
  if (!configured) return false;
  return configured
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .includes(host);
}

// IPv4-mapped and IPv4-compatible IPv6 addresses (`::ffff:127.0.0.1`, `::ffff:7f00:1`,
// `::127.0.0.1`) reach the same host as the IPv4 they carry, so they are compared as
// that IPv4 rather than as an IPv6 the range checks below would not recognise.
function toIpv4(ip: string): string {
  const embedded = ip.match(/^::(?:ffff:)?(.+)$/);
  if (!embedded) return ip;
  const rest = embedded[1]!;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) return rest;
  const hex = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return ip;
  const n = ((parseInt(hex[1]!, 16) << 16) | parseInt(hex[2]!, 16)) >>> 0;
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

// A dotted-decimal IPv4 address. The URL parser writes numeric hosts in this form.
function isIpv4Literal(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

// An IP literal host, brackets already removed. The URL parser only accepts a colon
// inside a host when it is an IPv6 address.
function isIpLiteral(host: string): boolean {
  return isIpv4Literal(host) || host.includes(':');
}

// An IPv4/IPv6 address in a loopback, link-local, or private range.
export function isPrivateIp(ip: string): boolean {
  const normalized = toIpv4(ip.toLowerCase());
  const v4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 ||
      a === 127 || // loopback
      a === 10 || // private
      (a === 172 && b >= 16 && b <= 31) || // private
      (a === 192 && b === 168) || // private
      (a === 169 && b === 254) || // link-local (incl. cloud metadata)
      (a === 100 && b >= 64 && b <= 127) // CGNAT
    );
  }
  return (
    normalized === '::1' || // loopback
    normalized === '::' ||
    normalized.startsWith('fe80:') || // link-local
    /^f[cd][0-9a-f]{2}:/.test(normalized) // unique local
  );
}

interface UrlPolicy {
  // Public content never uses development or configured private-host exceptions.
  publicOnly?: boolean;
  signal?: AbortSignal;
}

function isNonPublicIp(ip: string): boolean {
  const normalized = toIpv4(ip.toLowerCase());
  if (isPrivateIp(normalized)) return true;
  if (isIpv4Literal(normalized)) {
    const [a, b, c] = normalized.split('.').map(Number);
    return (
      a! >= 224 ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  return (
    !/^[23][0-9a-f]{3}:/.test(normalized) ||
    (normalized.startsWith('2001:') && parseInt(normalized.split(':')[1] || '0', 16) < 0x200) ||
    normalized.startsWith('2001:db8:') ||
    normalized.startsWith('3fff:') ||
    normalized.startsWith('2002:')
  );
}

// Every A and AAAA address of a hostname, through DNS-over-HTTPS. Both families are
// required: a failed lookup is an error, never an empty answer, so a partial view of
// the addresses cannot pass the check.
async function resolveHost(host: string, signal?: AbortSignal): Promise<string[]> {
  const [v4, v6] = await Promise.all([
    dohAddresses(host, 'A', signal),
    dohAddresses(host, 'AAAA', signal),
  ]);
  return [...v4, ...v6];
}

async function dohAddresses(
  host: string,
  type: 'A' | 'AAAA',
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const query = new URLSearchParams({ name: host, type });
  const res = await fetch(`${DOH_ENDPOINT}?${query.toString()}`, {
    headers: { accept: 'application/dns-json' },
    signal,
  });
  if (!res.ok) throw new Error(`DNS-over-HTTPS answered ${res.status}`);
  const answer = (await res.json()) as {
    Status?: number;
    Answer?: { type?: number; data?: string }[];
  };
  // 0 is NOERROR (the answer may still be empty), 3 is NXDOMAIN. Any other status
  // (SERVFAIL, REFUSED, ...) means the name was not resolved.
  if (answer.Status !== 0 && answer.Status !== 3) {
    throw new Error(`DNS status ${answer.Status}`);
  }
  if (answer.Status === 3) throw new Error('name does not exist');
  const wanted = type === 'A' ? 1 : 28;
  return (answer.Answer ?? []).flatMap((record) =>
    record.type === wanted && typeof record.data === 'string' ? [record.data] : [],
  );
}

// Validates the URL and resolves its hostname. Returns the parsed URL.
async function vet(raw: string, policy: UrlPolicy = {}): Promise<URL> {
  policy.signal?.throwIfAborted();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlNotAllowedError('url must be a valid URL');
  }

  const devRelaxed =
    !policy.publicOnly && process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test';
  if (
    url.protocol !== 'https:' &&
    !((devRelaxed || policy.publicOnly) && url.protocol === 'http:')
  ) {
    throw new UrlNotAllowedError('url must use https');
  }
  if (policy.publicOnly && (url.username || url.password)) {
    throw new UrlNotAllowedError('url must not include credentials');
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const allowed = !policy.publicOnly && isAllowedHost(host);
  const blockedIp = policy.publicOnly ? isNonPublicIp : isPrivateIp;
  if (isLocalHostname(host) || (isIpLiteral(host) && blockedIp(host))) {
    if (!devRelaxed && !allowed) {
      throw new UrlNotAllowedError('url must not point to a private or local address');
    }
    return url;
  }

  let addresses: string[];
  if (isIpLiteral(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await resolveHost(host, policy.signal);
    } catch {
      policy.signal?.throwIfAborted();
      throw new UrlNotAllowedError('url host could not be resolved');
    }
    if (addresses.length === 0) throw new UrlNotAllowedError('url host could not be resolved');
  }
  if (addresses.some((address) => blockedIp(address)) && !devRelaxed && !allowed) {
    throw new UrlNotAllowedError('url must not point to a private or local address');
  }
  return url;
}

// Validates a user/agent-supplied URL for a server-side fetch: http(s) only, and it
// must not resolve to a local/private address. Returns the parsed URL. http is
// allowed in local development or under the public-only policy. Throws
// UrlNotAllowedError when the URL or its resolved addresses are refused.
export async function assertPublicHttpUrl(raw: string, policy?: UrlPolicy): Promise<URL> {
  return vet(raw, policy);
}

// The runtime sends no User-Agent of its own, and GitHub answers 403 with an HTML body
// to a request that carries none. The Node-based fetch this replaced always sent one,
// so callers never had to.
const DEFAULT_USER_AGENT = 'itsaplan/1';

export interface PinnedRequestInit extends UrlPolicy {
  method?: string;
  headers?: Record<string, string> | Headers;
  body?: string | Uint8Array;
  // Bounds the whole exchange, headers and body. The runtime exposes no inactivity timer.
  timeoutMs?: number;
  maxBytes?: number;
  // Keep a document prefix for metadata; binary downloads must reject oversized bodies.
  truncateBody?: boolean;
}

function requestSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  const signals = [signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined].filter(
    (s): s is AbortSignal => s !== undefined,
  );
  if (signals.length === 0) return undefined;
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// Reads the whole body into memory, bounded by maxBytes. Over the bound the read fails,
// or, with truncate, keeps the prefix that fits.
async function readBounded(
  res: Response,
  maxBytes: number | undefined,
  truncate: boolean,
): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (maxBytes !== undefined && bytes + value.byteLength > maxBytes) {
      if (!truncate) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseTooLargeError('response exceeds the byte limit');
      }
      const room = maxBytes - bytes;
      chunks.push(value.subarray(0, room));
      bytes += room;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    bytes += value.byteLength;
  }
  return concat(chunks, bytes);
}

// Validates the URL, then sends the request. Redirects are never followed: the 3xx is
// returned as-is, so a caller cannot be steered to an address that was never validated.
// The body is read in full before the promise resolves, so a failure while reading
// (size limit, timeout, abort) rejects this call rather than a later read of the body.
export async function pinnedFetch(raw: string, init: PinnedRequestInit = {}): Promise<Response> {
  const url = await vet(raw, init);
  init.signal?.throwIfAborted();
  const headers = new Headers(init.headers);
  if (!headers.has('user-agent')) headers.set('user-agent', DEFAULT_USER_AGENT);

  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers,
    body: init.body,
    redirect: 'manual',
    signal: requestSignal(init.signal, init.timeoutMs),
  });
  const status = res.status;
  if (status < 200 || status > 599) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error('response has an invalid HTTP status');
  }

  const empty = status === 204 || status === 205 || status === 304;
  let body: Uint8Array | null = null;
  if (empty) await res.body?.cancel().catch(() => undefined);
  else body = await readBounded(res, init.maxBytes, init.truncateBody === true);

  // The runtime decodes the body, so the encoding and length of the wire are dropped.
  const forwarded = new Headers(res.headers);
  forwarded.delete('content-encoding');
  forwarded.delete('content-length');
  return new Response(body, { status, headers: forwarded });
}
