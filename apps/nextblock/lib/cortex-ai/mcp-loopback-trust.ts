import 'server-only';

/**
 * Guards for the tokenless "loopback in development" MCP path (`app/api/mcp/route.ts`).
 *
 * That path used to be decided by the `Host` request header alone (plus `NODE_ENV`), and
 * `Host` is whatever the client or the proxy in front says it is: `Host: localhost` or
 * `Host: anything.localhost` from the public internet opened a full read+write MCP session
 * on any instance that ran with a non-production `NODE_ENV`. A single environment variable
 * was the only thing standing between the internet and the service-role tools.
 *
 * Two additional conditions now apply, in this order:
 *
 * 1. **Explicit opt-in.** `NEXTBLOCK_MCP_TRUST_LOCALHOST=true` must be set in the
 *    environment. Without it the tokenless path does not exist at all, whatever the
 *    dashboard toggle says: a bearer token (database-minted or `MCP_BEARER_TOKEN`) or an
 *    admin session is required even on a developer's own machine. The dashboard toggle
 *    becomes the second of two switches rather than the only one.
 *
 * 2. **Forwarded peer must be loopback.** Every peer-address header a proxy or the
 *    platform sets (`x-forwarded-for`, `x-real-ip`, `forwarded`, the CDN variants) must
 *    name only loopback addresses, and `x-forwarded-host`, when present, must be a
 *    localhost host. Next.js fills `x-forwarded-for` from the socket's remote address only
 *    when the client sent none, so a direct connection can still forge it; this check is
 *    defence in depth against the proxied case (where the proxy appends the real client
 *    address), not the gate. The gate is (1).
 *
 * The existing conditions remain: the dashboard setting on, `NODE_ENV !== 'production'`,
 * and a loopback `Host` (`shouldTrustLocalMcpRequest` in `@nextblock-cms/cortex`).
 *
 * This module deliberately imports nothing from `@nextblock-cms/cortex`: the host check
 * for `x-forwarded-host` is injected by the route so the same `isLocalhostHost` decides
 * both headers, and the helper stays trivially unit-testable.
 */

export const NEXTBLOCK_MCP_TRUST_LOCALHOST_ENV = 'NEXTBLOCK_MCP_TRUST_LOCALHOST';

/** True only for the literal value `true` (case-insensitive, trimmed). */
export function isMcpLocalhostTrustOptedIn(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env[NEXTBLOCK_MCP_TRUST_LOCALHOST_ENV]?.trim().toLowerCase() === 'true';
}

/**
 * Headers that carry a client address. Any of them present with a non-loopback value
 * means the request did not originate on this machine.
 */
const PEER_ADDRESS_HEADERS = [
  'x-forwarded-for',
  'x-real-ip',
  'x-client-ip',
  'cf-connecting-ip',
  'true-client-ip',
  'x-vercel-forwarded-for',
  'fly-client-ip',
  'fastly-client-ip',
] as const;

/** `127.0.0.0/8` or `::1`, with an optional port, brackets, quotes or IPv4-mapped prefix. */
export function isLoopbackIpAddress(value: string): boolean {
  let address = value.trim().toLowerCase().replace(/^"+|"+$/g, '');

  if (!address) {
    return false;
  }

  if (address.startsWith('[')) {
    // "[::1]" or "[::1]:3000"
    const match = /^\[([^\]]+)\](?::\d+)?$/.exec(address);

    if (!match) {
      return false;
    }

    address = match[1];
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(address)) {
    // "127.0.0.1:3000"
    address = address.replace(/:\d+$/, '');
  }

  if (address.startsWith('::ffff:')) {
    address = address.slice('::ffff:'.length);
  }

  if (address === '::1') {
    return true;
  }

  return /^127(?:\.\d{1,3}){3}$/.test(address);
}

function splitHeaderList(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export type LoopbackPeerDependencies = {
  /** The same loopback-host test the route applies to `Host` (`isLocalhostHost` from cortex). */
  isLocalhostHost: (value: string | null | undefined) => boolean;
};

/**
 * True when nothing in the request says it came through a proxy from somewhere other
 * than this machine. Absent headers count as loopback (a bare dev server sets none it did
 * not derive from the socket); a present header with any non-loopback entry refuses.
 */
export function isForwardedPeerLoopback(headers: Headers, deps: LoopbackPeerDependencies): boolean {
  for (const name of PEER_ADDRESS_HEADERS) {
    const raw = headers.get(name);

    if (raw === null) {
      continue;
    }

    const entries = splitHeaderList(raw);

    if (entries.length === 0 || !entries.every(isLoopbackIpAddress)) {
      return false;
    }
  }

  const forwarded = headers.get('forwarded');

  if (forwarded !== null) {
    // RFC 7239: `for=192.0.2.60;proto=http, for="[2001:db8::1]:4711"`.
    const peers = [...forwarded.matchAll(/\bfor=("?)([^;,"]+)\1/gi)].map((match) => match[2]);

    if (peers.length === 0 || !peers.every(isLoopbackIpAddress)) {
      return false;
    }
  }

  const forwardedHost = headers.get('x-forwarded-host');

  if (forwardedHost !== null && !splitHeaderList(forwardedHost).every(deps.isLocalhostHost)) {
    return false;
  }

  return true;
}
