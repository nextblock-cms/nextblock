// Server-side fetches of user-supplied URLs: the host blocklist, the DNS-pinned lookup and
// `guardedFetch`, which every such fetch goes through (`fetch_url_content`, the alt-text
// image download, and the app's external media import). Moved out of
// ai-global-agent-tools.ts (which re-exports the blocklist) so the downloaders can use it
// without importing the whole tool registry.

import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as requestHttp, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { request as requestHttps } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

/**
 * Unwrap an IPv4-mapped IPv6 address to its dotted-quad form.
 *
 * `http://[::ffff:127.0.0.1]/` reaches loopback just as `http://127.0.0.1/` does,
 * but the WHATWG URL parser normalises it to `::ffff:7f00:1` — which matches none of
 * the IPv4 private-range checks below. Without this, the mapped form is a working
 * bypass of the entire SSRF blocklist. Decimal and hex hosts (`http://2130706433/`)
 * need no special handling: the URL parser already normalises those to dotted-quad.
 */
function unwrapMappedIpv4(host: string): string | null {
  const mapped = host.match(/^::ffff:(.+)$/i);

  if (!mapped) {
    return null;
  }

  const rest = mapped[1] as string;

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) {
    return rest;
  }

  const hextets = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);

  if (!hextets) {
    return null;
  }

  const high = Number.parseInt(hextets[1] as string, 16);
  const low = Number.parseInt(hextets[2] as string, 16);

  return [(high >> 8) & 255, high & 255, (low >> 8) & 255, low & 255].join('.');
}

/**
 * Every range a fetch must never reach: what an IP-literal host is checked against, and
 * what the pinned lookup refuses once DNS has answered. Before 2026-10-21 the hostname
 * blocklist covered only the RFC 1918, loopback and link-local ranges, so carrier-grade
 * NAT (100.64.0.0/10), the benchmarking range (198.18.0.0/15) and NAT64 (64:ff9b::/96,
 * which reaches IPv4 space) were fetchable.
 */
const PRIVATE_ADDRESSES = (() => {
  const list = new BlockList();
  for (const [network, prefix] of [
    ['0.0.0.0', 8], // "this network"
    ['10.0.0.0', 8],
    ['100.64.0.0', 10], // carrier-grade NAT
    ['127.0.0.0', 8],
    ['169.254.0.0', 16], // link-local, cloud metadata
    ['172.16.0.0', 12],
    ['192.0.0.0', 24], // IETF protocol assignments
    ['192.0.2.0', 24], // TEST-NET-1
    ['192.168.0.0', 16],
    ['198.18.0.0', 15], // benchmarking
    ['198.51.100.0', 24], // TEST-NET-2
    ['203.0.113.0', 24], // TEST-NET-3
    ['224.0.0.0', 4], // multicast
    ['240.0.0.0', 4], // reserved, broadcast
  ] as const) {
    list.addSubnet(network, prefix, 'ipv4');
  }
  for (const [network, prefix] of [
    ['::', 128], // unspecified
    ['::1', 128], // loopback
    // No ::ffff:0:0/96 rule: BlockList already checks an IPv4-mapped address against the
    // IPv4 rules above, and that rule would make every plain IPv4 address match too.
    ['64:ff9b::', 96], // NAT64 can reach IPv4 space
    ['100::', 64], // discard
    ['2001:db8::', 32], // documentation
    ['fc00::', 7], // unique local
    ['fe80::', 10], // link-local
    ['ff00::', 8], // multicast
  ] as const) {
    list.addSubnet(network, prefix, 'ipv6');
  }
  return list;
})();

/** True for any address in `PRIVATE_ADDRESSES`, and for anything that is not an IP. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return PRIVATE_ADDRESSES.check(address, 'ipv4');
  if (family === 6) return PRIVATE_ADDRESSES.check(address, 'ipv6');
  return true;
}

/**
 * DNS-rebinding guard. `isBlockedFetchHost` only inspects the hostname STRING, so a public name
 * that resolves to a private/loopback/link-local/metadata address (attacker-controlled DNS) sails
 * through it and the connection still lands inside the perimeter. This resolves the name and
 * reports blocked if ANY resolved address is internal.
 *
 * Advisory only: there is a window between this lookup and the socket's own. A fetch goes
 * through `guardedFetch`, whose pinned lookup checks the address the socket connects to.
 */
export async function resolvedHostIsBlocked(hostname: string): Promise<boolean> {
  const host = (hostname || '').trim().toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (!host) return true;
  // IP literals are already fully covered by the synchronous check; no DNS needed.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
    return isBlockedFetchHost(host);
  }
  try {
    const dns = await import('node:dns');
    const records = await dns.promises.lookup(host, { all: true });
    if (!records || records.length === 0) return true;
    return records.some((r) => isBlockedFetchHost(r.address));
  } catch {
    // Resolution failure -> fail closed (the fetch would fail anyway).
    return true;
  }
}

/** Exported for the SSRF regression tests in ai-global-agent-ssrf.test.ts. */
export function isBlockedFetchHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');

  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal'
  ) {
    return true;
  }

  // `::` is the unspecified address and reaches loopback on most stacks.
  if (
    host === '0.0.0.0' ||
    host === '::' ||
    host === '::1' ||
    host.startsWith('fe80:') ||
    host.startsWith('fc') ||
    host.startsWith('fd')
  ) {
    return true;
  }

  const mappedIpv4 = unwrapMappedIpv4(host);

  if (mappedIpv4) {
    return isBlockedFetchHost(mappedIpv4);
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);

  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);

    if (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31)
    ) {
      return true;
    }
  }

  // Every other reserved range (CGNAT, benchmarking, NAT64, multicast, ...).
  return isIP(host) !== 0 && isPrivateAddress(host);
}

/** `code` the pinned lookup puts on its refusal, so `guardedFetch` can tell it from a DNS failure. */
const BLOCKED_LOOKUP_CODE = 'ENEXTBLOCK_PRIVATE_ADDRESS';

type ResolveAll = (
  hostname: string,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void
) => void;

const resolveAllWithDns: ResolveAll = (hostname, callback) =>
  dnsLookup(hostname, { all: true }, (error, addresses) => callback(error, addresses ?? []));

/**
 * A `lookup` for http(s).request that refuses any answer containing a private address, so
 * the address that is checked is the address the socket connects to and a rebinding
 * hostname cannot swap in a private one afterwards. `resolveAll` is injectable so tests
 * can simulate DNS without the network.
 */
export function createPinnedLookup(resolveAll: ResolveAll = resolveAllWithDns): LookupFunction {
  const lookup = (
    hostname: string,
    options: { all?: boolean },
    callback: (
      error: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number
    ) => void
  ) => {
    resolveAll(hostname, (error, addresses) => {
      if (error) {
        callback(error, '');
        return;
      }
      const blocked = addresses.find((entry) => isPrivateAddress(entry.address));
      if (addresses.length === 0 || blocked) {
        const refusal: NodeJS.ErrnoException = new Error(
          blocked
            ? `Refusing to connect: ${hostname} resolves to a private address (${blocked.address}).`
            : `Refusing to connect: ${hostname} did not resolve to any address.`
        );
        refusal.code = BLOCKED_LOOKUP_CODE;
        callback(refusal, '');
        return;
      }
      if (options.all) {
        callback(null, addresses);
        return;
      }
      const [first] = addresses as [LookupAddress, ...LookupAddress[]];
      callback(null, first.address, first.family);
    });
  };
  return lookup as unknown as LookupFunction;
}

/**
 * Why `guardedFetch` refused. `blocked` is reported before any status code is read, so a
 * caller can say "refused" without ever telling the user what an internal host answered.
 */
export type GuardedFetchErrorReason = 'blocked' | 'protocol' | 'redirects' | 'too_large';

export class GuardedFetchError extends Error {
  constructor(
    readonly reason: GuardedFetchErrorReason,
    message: string,
    /** How many redirects had been followed when the fetch was refused. */
    readonly redirects = 0
  ) {
    super(message);
    this.name = 'GuardedFetchError';
  }
}

export type GuardedFetchOptions = {
  abortSignal?: AbortSignal;
  headers?: Record<string, string>;
  /** Override for tests. Defaults to the pinned DNS lookup. */
  lookup?: LookupFunction;
  /** Largest body `readBody()` accepts. */
  maxBytes: number;
  maxRedirects?: number;
  timeoutMs?: number;
};

export type GuardedFetchResponse = {
  headers: IncomingHttpHeaders;
  /** The media type of Content-Type, lower-cased and without parameters ('' when absent). */
  mediaType: string;
  status: number;
  /** The URL that answered. Every hop on the way passed the same host checks. */
  url: URL;
  /**
   * Read the body as it streams, never buffering more than `maxBytes`. Past the cap it
   * throws (`too_large`), or with `truncate` returns the first `maxBytes` bytes.
   */
  readBody(options?: { truncate?: boolean }): Promise<Uint8Array>;
  /** Drop the connection without reading the body. */
  discard(): void;
};

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 15_000;

/** Throws unless `url` is http(s) on a host that is neither local nor a private IP literal. */
function assertFetchableUrl(url: URL, redirects: number) {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new GuardedFetchError('protocol', `Refusing to fetch: ${url.protocol} URLs are not allowed.`, redirects);
  }

  // IP literals never reach `lookup`, so this check is what covers them.
  const host = url.hostname.replace(/^\[|\]$/g, '');

  if (isBlockedFetchHost(host) || (isIP(host) !== 0 && isPrivateAddress(host))) {
    throw new GuardedFetchError('blocked', `Refusing to fetch from ${url.hostname}: private or local host.`, redirects);
  }
}

function requestOnce(
  url: URL,
  params: { headers: Record<string, string>; lookup: LookupFunction; redirects: number; signal: AbortSignal }
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? requestHttps : requestHttp;
    const request = send(url, {
      // No pooled sockets: a reused connection would skip the pinned lookup.
      agent: false,
      headers: params.headers,
      lookup: params.lookup,
      method: 'GET',
      signal: params.signal,
    });
    request.on('response', resolve);
    request.on('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === BLOCKED_LOOKUP_CODE
          ? new GuardedFetchError('blocked', error.message, params.redirects)
          : error
      );
    });
    request.end();
  });
}

async function readCappedBody(response: IncomingMessage, maxBytes: number, truncate: boolean): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of response) {
    const buffer = chunk as Buffer;

    if (total + buffer.length > maxBytes) {
      response.destroy();

      if (!truncate) {
        throw new GuardedFetchError('too_large', `The response is larger than the ${maxBytes}-byte limit.`);
      }

      chunks.push(buffer.subarray(0, maxBytes - total));
      total = maxBytes;
      break;
    }

    total += buffer.length;
    chunks.push(buffer);
  }

  return new Uint8Array(Buffer.concat(chunks, total));
}

/**
 * GET a user-supplied URL without letting it reach anything internal.
 *
 * - The host is checked before every request (a literal private IP, `localhost`, `.internal`,
 *   ...), and the DNS lookup is PINNED: the answer is checked and is the address the socket
 *   connects to, so a rebinding name cannot swap a private address in afterwards.
 * - Redirects are followed by hand, up to `maxRedirects`, and every hop is checked the same
 *   way. `redirect: 'follow'` checked only the final URL, after the internal hop had already
 *   been requested, and its status code was reported back to the caller.
 * - The body streams and is capped at `maxBytes`, instead of being buffered whole first.
 *
 * Callers must not report a status or a body for a refused fetch: a refusal is a
 * `GuardedFetchError` with reason `blocked`, thrown before any response from that host is read.
 */
export async function guardedFetch(url: URL | string, options: GuardedFetchOptions): Promise<GuardedFetchResponse> {
  const lookup = options.lookup ?? createPinnedLookup();
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.abortSignal ? AbortSignal.any([options.abortSignal, timeout]) : timeout;
  const headers = options.headers ?? {};

  let current = typeof url === 'string' ? new URL(url) : url;

  for (let redirects = 0; ; redirects++) {
    assertFetchableUrl(current, redirects);

    const response = await requestOnce(current, { headers, lookup, redirects, signal });
    const status = response.statusCode ?? 0;
    const location = response.headers.location;

    if (status >= 300 && status < 400 && location) {
      response.destroy();

      if (redirects >= maxRedirects) {
        throw new GuardedFetchError('redirects', `Too many redirects (more than ${maxRedirects}).`, redirects);
      }

      current = new URL(location, current);
      continue;
    }

    const [mediaType = ''] = String(response.headers['content-type'] ?? '').split(';');

    return {
      discard: () => response.destroy(),
      headers: response.headers,
      mediaType: mediaType.trim().toLowerCase(),
      readBody: (readOptions) => readCappedBody(response, options.maxBytes, Boolean(readOptions?.truncate)),
      status,
      url: current,
    };
  }
}
