/**
 * The proxy's partner-referral rules (Affiliates package, ADDENDUM C1): which requests stamp the
 * first-party `nb_affiliate_ref` cookie, how long it lives, and the visitor hash the click
 * counter dedupes on.
 *
 * Dependency-free on purpose (no imports at all). `proxy.ts` runs in front of every request and
 * may not import server-only code, `@nextblock-cms/db/server` or a library barrel (the affiliates
 * barrel would also pull React and every copy dictionary into the proxy bundle). The handle rules
 * and cookie name are therefore mirrored from `@nextblock-cms/affiliates`
 * (`AFFILIATE_HANDLE_PATTERN`, `RESERVED_AFFILIATE_HANDLES`, `AFFILIATE_REF_COOKIE`,
 * `AFFILIATE_DEFAULT_COOKIE_DAYS`) and the consent cookie name from `lib/privacy/types.ts`;
 * `referral-cookie.test.ts` fails as soon as a copy drifts.
 *
 * Nothing here throws. The proxy fails open: a broken referral must never cost a page view.
 */

/** Mirror of `AFFILIATE_REF_COOKIE`. Holds a lowercase handle and nothing else. */
export const AFFILIATE_REFERRAL_COOKIE = 'nb_affiliate_ref';

/** Mirror of `AFFILIATE_DEFAULT_COOKIE_DAYS`: the window used when the tier lookup fails. */
export const AFFILIATE_REFERRAL_FALLBACK_DAYS = 30;

/** Upper bound of `affiliate_tiers.cookie_duration_days` (CHECK 1..365 in 02030). */
export const AFFILIATE_REFERRAL_MAX_DAYS = 365;

/** Mirror of `AFFILIATE_HANDLE_PATTERN` (the `affiliate_profiles.handle` CHECK in 02030). */
export const AFFILIATE_REFERRAL_HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;

/** Mirror of `RESERVED_AFFILIATE_HANDLES`. */
export const AFFILIATE_REFERRAL_RESERVED_HANDLES: readonly string[] = Object.freeze([
  'admin',
  'api',
  'apply',
  'cms',
  'conditions',
  'dashboard',
  'help',
  'join',
  'login',
  'logout',
  'new',
  'nextblock',
  'opengraph-image',
  'partner',
  'partners',
  'portal',
  'retailer',
  'settings',
  'signin',
  'signup',
  'sign-in',
  'sign-up',
  'sitemap',
  'store',
  'support',
  'terms',
  'twitter-image',
  'www',
]);

/** Mirror of `CONSENT_COOKIE_NAME` (lib/privacy/types.ts): the Law 25 consent banner's record. */
export const AFFILIATE_REFERRAL_CONSENT_COOKIE = 'nb_consent_preference';

/** `?ref=<handle>` on any public page. */
export const AFFILIATE_REFERRAL_QUERY_PARAM = 'ref';

/**
 * A storefront: exactly `/partners/<handle>` (optional trailing slash). Never
 * `/partners/<handle>/opengraph-image` or anything else below it.
 */
export const AFFILIATE_REFERRAL_STOREFRONT_PATH = /^\/partners\/([a-z0-9-]+)\/?$/;

/** Path prefixes where `?ref=` never counts: staff, API, the partner portal, framework assets. */
export const AFFILIATE_REFERRAL_EXCLUDED_PREFIXES: readonly string[] = Object.freeze(['/cms', '/api', '/portal', '/_next']);

/** Cache-Control of every response that sets the referral cookie. */
export const AFFILIATE_REFERRAL_CACHE_CONTROL = 'private, no-store';

/** Tier-window cache bounds (see {@link createAffiliateReferralWindowCache}). */
export const AFFILIATE_REFERRAL_WINDOW_CACHE_DEFAULTS = Object.freeze({
  maxEntries: 1000,
  maxInflight: 100,
  positiveTtlMs: 5 * 60_000,
  negativeTtlMs: 60_000,
  errorTtlMs: 15_000,
});

const SECONDS_PER_DAY = 86_400;
/** Same raw-input cap as `normalizeAffiliateHandle` (the lib), so both normalizers agree. */
const MAX_RAW_HANDLE_LENGTH = 256;
/** Browsers cap a cookie at ~4 KB; anything longer is not the banner's record. */
const MAX_CONSENT_COOKIE_LENGTH = 4096;
const MAX_IP_LENGTH = 100;
const MAX_USER_AGENT_LENGTH = 200;
const RESERVED_HANDLES: ReadonlySet<string> = new Set(AFFILIATE_REFERRAL_RESERVED_HANDLES);

export interface AffiliateReferralHeaders {
  get(name: string): string | null;
}

export interface AffiliateReferralSearchParams {
  get(name: string): string | null;
}

/** `NextRequest.cookies` fits this shape. */
export interface AffiliateReferralCookies {
  get(name: string): { value: string } | undefined;
}

export interface AffiliateReferralRequest {
  method: string;
  pathname: string;
  searchParams: AffiliateReferralSearchParams;
  headers: AffiliateReferralHeaders;
  cookies: AffiliateReferralCookies;
  /**
   * `userAgent(request).isBot` from next/server, or a function returning it. A function is only
   * called once a referral handle was found, so ordinary requests never parse the user agent.
   */
  isBot: boolean | (() => boolean);
}

export interface AffiliateReferralDecision {
  /** Lowercase, pattern-valid, not reserved. */
  handle: string;
  /**
   * False when the visitor already carries a cookie for this same handle: the cookie is
   * refreshed but no click is counted.
   */
  isNewClick: boolean;
}

function readHeader(headers: AffiliateReferralHeaders, name: string): string {
  try {
    const value = headers.get(name);
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

function readCookie(cookies: AffiliateReferralCookies, name: string): string | undefined {
  try {
    const entry = cookies.get(name);
    return typeof entry?.value === 'string' ? entry.value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The canonical handle (trimmed, lowercased, pattern-valid, not reserved), or null. Same rules as
 * `normalizeAffiliateHandle` in `@nextblock-cms/affiliates`.
 */
export function normalizeAffiliateReferralHandle(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_RAW_HANDLE_LENGTH) {
    return null;
  }

  const handle = raw.trim().toLowerCase();
  return AFFILIATE_REFERRAL_HANDLE_PATTERN.test(handle) && !RESERVED_HANDLES.has(handle) ? handle : null;
}

/**
 * True for a top-level GET document navigation: `Sec-Fetch-Dest: document`, or (an older client
 * that sends no `Sec-Fetch-Dest`) an `Accept` that asks for HTML. A client-side navigation or a
 * router prefetch is an RSC fetch, never a document.
 */
export function isAffiliateReferralDocumentRequest(method: string, headers: AffiliateReferralHeaders): boolean {
  if (String(method ?? '').toUpperCase() !== 'GET') {
    return false;
  }

  if (readHeader(headers, 'rsc') || readHeader(headers, 'next-router-prefetch')) {
    return false;
  }

  const destination = readHeader(headers, 'sec-fetch-dest').trim().toLowerCase();
  if (destination) {
    return destination === 'document';
  }

  return readHeader(headers, 'accept').toLowerCase().includes('text/html');
}

/** True when the browser says this navigation is speculative (prefetch, prerender, preview). */
export function isAffiliateReferralPrefetch(headers: AffiliateReferralHeaders): boolean {
  return ['sec-purpose', 'purpose', 'x-purpose', 'x-moz'].some((name) => {
    const value = readHeader(headers, name).toLowerCase();
    return value.includes('prefetch') || value.includes('prerender') || value.includes('preview');
  });
}

/** The handle of a storefront path (`/partners/<handle>`), or null for any other path. */
export function affiliateReferralHandleFromPath(pathname: string): string | null {
  if (typeof pathname !== 'string') {
    return null;
  }

  const match = AFFILIATE_REFERRAL_STOREFRONT_PATH.exec(pathname);
  return match ? normalizeAffiliateReferralHandle(match[1]) : null;
}

/** True under `/cms`, `/api`, `/portal` or `/_next` (whole path segments only). */
export function isAffiliateReferralExcludedPath(pathname: string): boolean {
  if (typeof pathname !== 'string') {
    return true;
  }

  return AFFILIATE_REFERRAL_EXCLUDED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * True only when the consent cookie is the banner's record and it says `marketing: false`. No
 * cookie, an unreadable one, or one without that answer leaves the referral alone. The banner
 * writes `encodeURIComponent(JSON.stringify(record))`; Next decodes cookie values, so both the
 * decoded and the raw spelling are accepted.
 */
export function hasDeclinedAffiliateMarketingConsent(raw: string | null | undefined): boolean {
  if (typeof raw !== 'string' || raw === '' || raw.length > MAX_CONSENT_COOKIE_LENGTH) {
    return false;
  }

  const candidates = [raw];
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded !== raw) candidates.push(decoded);
  } catch {
    // Not percent-encoded: the raw value is the only spelling.
  }

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return (parsed as { marketing?: unknown }).marketing === false;
      }
    } catch {
      // Try the next spelling.
    }
  }

  return false;
}

/**
 * Whether this request carries a partner referral, decided once per request before the proxy's
 * first response branch. Checks, cheapest first: a GET document navigation that is not a
 * prefetch; a handle from `/partners/<handle>`, else from `?ref=<handle>` outside the excluded
 * prefixes; not a bot; marketing consent not declined. A visitor whose cookie already names the
 * same handle gets `isNewClick: false`. Never throws (null on any surprise).
 */
export function decideAffiliateReferral(request: AffiliateReferralRequest): AffiliateReferralDecision | null {
  try {
    if (!isAffiliateReferralDocumentRequest(request.method, request.headers)) {
      return null;
    }
    if (isAffiliateReferralPrefetch(request.headers)) {
      return null;
    }

    const pathname = typeof request.pathname === 'string' ? request.pathname : '';
    let handle = affiliateReferralHandleFromPath(pathname);
    if (!handle) {
      if (isAffiliateReferralExcludedPath(pathname)) {
        return null;
      }
      handle = normalizeAffiliateReferralHandle(request.searchParams.get(AFFILIATE_REFERRAL_QUERY_PARAM));
    }
    if (!handle) {
      return null;
    }

    const isBot = typeof request.isBot === 'function' ? request.isBot() : request.isBot;
    if (isBot) {
      return null;
    }

    if (hasDeclinedAffiliateMarketingConsent(readCookie(request.cookies, AFFILIATE_REFERRAL_CONSENT_COOKIE))) {
      return null;
    }

    const current = normalizeAffiliateReferralHandle(readCookie(request.cookies, AFFILIATE_REFERRAL_COOKIE));
    return { handle, isNewClick: current !== handle };
  } catch {
    return null;
  }
}

/**
 * True when a document navigation still carries a referral cookie although the visitor has since
 * declined marketing cookies: the proxy then expires it, so withdrawing consent also ends the
 * referral (checkout would otherwise keep attributing the order). Never throws.
 */
export function shouldWithdrawAffiliateReferral(
  request: Pick<AffiliateReferralRequest, 'method' | 'headers' | 'cookies'>,
): boolean {
  try {
    if (!isAffiliateReferralDocumentRequest(request.method, request.headers) || isAffiliateReferralPrefetch(request.headers)) {
      return false;
    }
    if (readCookie(request.cookies, AFFILIATE_REFERRAL_COOKIE) === undefined) {
      return false;
    }
    return hasDeclinedAffiliateMarketingConsent(readCookie(request.cookies, AFFILIATE_REFERRAL_CONSENT_COOKIE));
  } catch {
    return false;
  }
}

/**
 * A tier window in whole days (1..365); null when there is no active, approved partner for the
 * handle (`get_affiliate_referral_window` returned NULL); undefined for anything that is not a
 * window at all (treated like a failed lookup).
 */
export function normalizeAffiliateReferralWindowDays(value: unknown): number | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }

  const days = typeof value === 'string' && /^\d{1,3}$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof days === 'number' && Number.isInteger(days) && days >= 1 && days <= AFFILIATE_REFERRAL_MAX_DAYS) {
    return days;
  }

  return undefined;
}

export interface AffiliateReferralWindowCacheOptions {
  /**
   * The tier window for a handle: days, or null when the handle has no active, approved partner.
   * Rejects (or throws) on a failed lookup, which the cache answers with `fallbackDays`.
   */
  load: (handle: string) => unknown;
  now?: () => number;
  /** Handles kept at once (oldest evicted first). Default 1000. */
  maxEntries?: number;
  /** Concurrent lookups; past it a handle gets no cookie rather than another query. Default 100. */
  maxInflight?: number;
  /** Lifetime of a window. Default 5 minutes. */
  positiveTtlMs?: number;
  /** Lifetime of "no such partner". Default 60 s. */
  negativeTtlMs?: number;
  /** Lifetime of a failed lookup's fallback, short so a recovered database is asked again soon. Default 15 s. */
  errorTtlMs?: number;
  /** Window when a lookup fails. Default 30 days. */
  fallbackDays?: number;
}

export interface AffiliateReferralWindowCache {
  /** Days for the handle's referral cookie, or null for no cookie. Never rejects. */
  get(handle: string): Promise<number | null>;
  readonly size: number;
  clear(): void;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Per-handle memo of the referral window: a bounded TTL cache plus one in-flight lookup per
 * handle, so a burst of visitors on a new link costs one query and a flood of made-up handles
 * costs at most `maxEntries` cache slots and `maxInflight` concurrent queries.
 */
export function createAffiliateReferralWindowCache(options: AffiliateReferralWindowCacheOptions): AffiliateReferralWindowCache {
  const defaults = AFFILIATE_REFERRAL_WINDOW_CACHE_DEFAULTS;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const maxEntries = Math.floor(positiveNumber(options.maxEntries, defaults.maxEntries));
  const maxInflight = Math.floor(positiveNumber(options.maxInflight, defaults.maxInflight));
  const positiveTtlMs = positiveNumber(options.positiveTtlMs, defaults.positiveTtlMs);
  const negativeTtlMs = positiveNumber(options.negativeTtlMs, defaults.negativeTtlMs);
  const errorTtlMs = positiveNumber(options.errorTtlMs, defaults.errorTtlMs);
  const fallbackDays = normalizeAffiliateReferralWindowDays(options.fallbackDays) ?? AFFILIATE_REFERRAL_FALLBACK_DAYS;

  const entries = new Map<string, { days: number | null; expiresAt: number }>();
  const inflight = new Map<string, Promise<number | null>>();

  function remember(handle: string, days: number | null, ttlMs: number): void {
    const at = now();
    entries.delete(handle);
    if (entries.size >= maxEntries) {
      for (const [key, entry] of entries) {
        if (entry.expiresAt <= at) entries.delete(key);
      }
    }
    while (entries.size >= maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
    entries.set(handle, { days, expiresAt: at + ttlMs });
  }

  async function lookup(handle: string): Promise<number | null> {
    let days: number | null = fallbackDays;
    let ttlMs = errorTtlMs;
    try {
      const value = normalizeAffiliateReferralWindowDays(await options.load(handle));
      if (value === null) {
        days = null;
        ttlMs = negativeTtlMs;
      } else if (value !== undefined) {
        days = value;
        ttlMs = positiveTtlMs;
      }
    } catch {
      // Fail open: the fallback window, remembered briefly.
    }
    remember(handle, days, ttlMs);
    return days;
  }

  return {
    get(rawHandle: string): Promise<number | null> {
      const handle = normalizeAffiliateReferralHandle(rawHandle);
      if (!handle) {
        return Promise.resolve(null);
      }

      const cached = entries.get(handle);
      if (cached) {
        if (cached.expiresAt > now()) {
          return Promise.resolve(cached.days);
        }
        entries.delete(handle);
      }

      const pending = inflight.get(handle);
      if (pending) {
        return pending;
      }
      if (inflight.size >= maxInflight) {
        return Promise.resolve(null);
      }

      const promise = lookup(handle).finally(() => {
        inflight.delete(handle);
      });
      inflight.set(handle, promise);
      return promise;
    },
    get size(): number {
      return entries.size;
    },
    clear(): void {
      entries.clear();
      inflight.clear();
    },
  };
}

export interface AffiliateReferralCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
  maxAge: number;
}

export interface AffiliateReferralCookie {
  name: string;
  value: string;
  options: AffiliateReferralCookieOptions;
}

/**
 * The referral cookie for a handle and a tier window: httpOnly (the checkout reads it on the
 * server; no script needs it), `Secure` in production, `SameSite=Lax` (sent on the top-level
 * navigation back from the partner's link), whole site, `days × 86400` seconds. Null for an
 * invalid handle or window.
 */
export function buildAffiliateReferralCookie(input: { handle: string; days: number; secure: boolean }): AffiliateReferralCookie | null {
  const handle = normalizeAffiliateReferralHandle(input?.handle);
  const days = normalizeAffiliateReferralWindowDays(input?.days);
  if (!handle || typeof days !== 'number') {
    return null;
  }

  return {
    name: AFFILIATE_REFERRAL_COOKIE,
    value: handle,
    options: {
      httpOnly: true,
      secure: input.secure === true,
      sameSite: 'lax',
      path: '/',
      maxAge: days * SECONDS_PER_DAY,
    },
  };
}

/** `NextResponse` fits this shape. */
export interface AffiliateReferralResponse {
  cookies: { set(name: string, value: string, options: AffiliateReferralCookieOptions): unknown };
  headers: { set(name: string, value: string): void };
}

/**
 * Set the cookie and mark the response `private, no-store`: a response carrying one visitor's
 * Set-Cookie must never be stored by a shared cache (it would hand the referral to everyone the
 * cache serves), and this overrides the public caching the proxy gives HTML and 301s.
 */
export function applyAffiliateReferralCookie(response: AffiliateReferralResponse, cookie: AffiliateReferralCookie): void {
  response.cookies.set(cookie.name, cookie.value, cookie.options);
  response.headers.set('Cache-Control', AFFILIATE_REFERRAL_CACHE_CONTROL);
}

/** Expire the referral cookie (same attributes, `Max-Age=0`) on a private response. */
export function expireAffiliateReferralCookie(response: AffiliateReferralResponse, secure: boolean): void {
  response.cookies.set(AFFILIATE_REFERRAL_COOKIE, '', {
    httpOnly: true,
    secure: secure === true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  response.headers.set('Cache-Control', AFFILIATE_REFERRAL_CACHE_CONTROL);
}

/** The client IP the platform reports (first `X-Forwarded-For` hop, else `X-Real-IP`), or null. */
export function readAffiliateVisitorIp(headers: AffiliateReferralHeaders): string | null {
  const forwarded = readHeader(headers, 'x-forwarded-for').split(',')[0]?.trim();
  if (forwarded) {
    return forwarded.slice(0, MAX_IP_LENGTH);
  }

  const real = readHeader(headers, 'x-real-ip').trim();
  return real ? real.slice(0, MAX_IP_LENGTH) : null;
}

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseIpv4(value: string): number[] | null {
  const match = IPV4_PATTERN.exec(value);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

function parseIpv6Groups(part: string, allowIpv4Tail: boolean): number[] | null {
  if (part === '') return [];
  const pieces = part.split(':');
  const groups: number[] = [];
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index];
    if (piece.includes('.')) {
      const octets = allowIpv4Tail && index === pieces.length - 1 ? parseIpv4(piece) : null;
      if (!octets) return null;
      groups.push(octets[0] * 256 + octets[1], octets[2] * 256 + octets[3]);
    } else if (/^[0-9a-f]{1,4}$/i.test(piece)) {
      groups.push(parseInt(piece, 16));
    } else {
      return null;
    }
  }
  return groups;
}

function expandIpv6(value: string): number[] | null {
  if (!/^[0-9a-f:.]+$/i.test(value)) return null;
  const halves = value.split('::');
  if (halves.length > 2) return null;

  if (halves.length === 1) {
    const groups = parseIpv6Groups(halves[0], true);
    return groups && groups.length === 8 ? groups : null;
  }

  const head = parseIpv6Groups(halves[0], false);
  const tail = parseIpv6Groups(halves[1], true);
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/**
 * The visitor's network, never the address: an IPv4 address keeps its /24
 * (`203.0.113.0/24`), an IPv6 address its /48 (`2001:db8:85a3::/48`); an IPv4-mapped IPv6
 * address counts as IPv4. Ports, brackets and zone ids are dropped; anything else is `unknown`.
 */
export function maskAffiliateVisitorIp(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return 'unknown';
  let value = raw.trim();
  if (!value || value.length > MAX_IP_LENGTH) return 'unknown';

  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) {
    value = bracketed[1];
  } else if (/^[\d.]+:\d+$/.test(value)) {
    value = value.slice(0, value.lastIndexOf(':'));
  }
  const zone = value.indexOf('%');
  if (zone > 0) value = value.slice(0, zone);

  const ipv4 = parseIpv4(value);
  if (ipv4) {
    return `${ipv4[0]}.${ipv4[1]}.${ipv4[2]}.0/24`;
  }

  const ipv6 = expandIpv6(value);
  if (!ipv6) return 'unknown';

  if (ipv6.slice(0, 5).every((group) => group === 0) && ipv6[5] === 0xffff) {
    return `${Math.floor(ipv6[6] / 256)}.${ipv6[6] % 256}.${Math.floor(ipv6[7] / 256)}.0/24`;
  }

  return `${ipv6[0].toString(16)}:${ipv6[1].toString(16)}:${ipv6[2].toString(16)}::/48`;
}

export interface AffiliateVisitorFingerprint {
  /** Request time, epoch milliseconds. Only its UTC date is used. */
  now: number;
  ip: string | null;
  userAgent: string | null;
}

/** `<UTC yyyy-mm-dd>|<masked ip>|<user agent, first 200 chars>`, or null for an invalid time. */
export function buildAffiliateVisitorHashInput(visitor: AffiliateVisitorFingerprint): string | null {
  const date = new Date(visitor?.now);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const userAgent = typeof visitor.userAgent === 'string' ? visitor.userAgent.slice(0, MAX_USER_AGENT_LENGTH) : '';
  return `${date.toISOString().slice(0, 10)}|${maskAffiliateVisitorIp(visitor.ip)}|${userAgent}`;
}

/**
 * The `p_visitor_hash` of `record_affiliate_click`: the first 32 hex characters of the SHA-256 of
 * {@link buildAffiliateVisitorHashInput}, through Web Crypto. No secret is involved and no
 * address is stored: it only has to tell one visitor's clicks of one day apart from another's.
 * Null when Web Crypto is unavailable or the input is invalid.
 */
export async function computeAffiliateVisitorHash(visitor: AffiliateVisitorFingerprint): Promise<string | null> {
  try {
    const input = buildAffiliateVisitorHashInput(visitor);
    const subtle = globalThis.crypto?.subtle;
    if (input === null || !subtle) {
      return null;
    }

    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(input));
    let hex = '';
    for (const byte of new Uint8Array(digest)) {
      hex += byte.toString(16).padStart(2, '0');
    }
    return hex.slice(0, 32);
  } catch {
    return null;
  }
}
