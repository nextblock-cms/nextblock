/**
 * URL rules of the storefront document. Partner content is untrusted: a link href or an image src
 * is kept only when it passes these allowlists, and the renderer checks every one again before it
 * reaches an attribute (defense in depth). Pure, client-safe and deterministic: each normalizer
 * returns a canonical string that normalizes to itself.
 */
import { STOREFRONT_LIMITS } from './limits';

/** `rel` the renderer puts on partner links unless a caller overrides it. */
export const STOREFRONT_DEFAULT_LINK_REL = 'nofollow ugc noopener noreferrer';

const LINK_PROTOCOLS: ReadonlySet<string> = new Set(['https:', 'http:', 'mailto:']);
const SCHEME_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
/** Throwaway origin used only to normalize site-relative paths with the WHATWG parser. */
const PATH_BASE_ORIGIN = 'https://storefront.invalid';
const MAILTO_ADDRESS =
  /^[A-Za-z0-9._+-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const ENCODED_SLASH_START = /^\/%(?:2f|5c)/i;
const MAX_ORIGIN_ENTRIES = 64;

function parseUrl(value: string, base?: string): URL | null {
  try {
    return base === undefined ? new URL(value) : new URL(value, base);
  } catch {
    return null;
  }
}

/**
 * True for a character no stored URL may contain: C0/C1 controls, space, DEL, NBSP, backslash,
 * soft hyphen, zero-width and bidi formatting characters, Unicode spaces, variation selectors,
 * tag characters, specials and lone surrogates. (The WHATWG parser silently strips tabs and
 * newlines, so `java\tscript:` must be refused before parsing, not after.)
 */
function hasUnsafeUrlChar(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f || code === 0x5c) return true;
    if (code < 0x80) continue;
    if (code <= 0xa0 || code === 0xad) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      // U+E0000–U+E0FFF: tag characters and variation selectors supplement.
      if (code >= 0xdb40 && code <= 0xdb43) return true;
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
    if (
      code === 0x034f ||
      code === 0x061c ||
      code === 0x115f ||
      code === 0x1160 ||
      code === 0x1680 ||
      code === 0x17b4 ||
      code === 0x17b5 ||
      (code >= 0x180b && code <= 0x180f) ||
      (code >= 0x2000 && code <= 0x200f) ||
      (code >= 0x2028 && code <= 0x202f) ||
      (code >= 0x205f && code <= 0x206f) ||
      code === 0x3000 ||
      code === 0x3164 ||
      (code >= 0xfe00 && code <= 0xfe0f) ||
      code === 0xfeff ||
      code === 0xffa0 ||
      code >= 0xfff0
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The same shape rules as `isSafeInternalPath` (apps/nextblock/lib/auth-redirects.ts): starts with
 * `/`, not `//`, no backslash, no control or whitespace characters, no encoded leading slash or
 * backslash (`/%2f…`, `/%5c…`).
 */
function isSafeSitePathShape(path: string): boolean {
  return (
    path.startsWith('/') &&
    !path.startsWith('//') &&
    !path.includes('\\') &&
    !ENCODED_SLASH_START.test(path) &&
    !hasUnsafeUrlChar(path)
  );
}

/** Normalizes a site-relative path (dot segments resolved, characters percent-encoded). */
function normalizeSitePath(value: string): string | null {
  if (!isSafeSitePathShape(value)) return null;
  const url = parseUrl(value, PATH_BASE_ORIGIN);
  if (!url || url.origin !== PATH_BASE_ORIGIN) return null;
  const path = `${url.pathname}${url.search}${url.hash}`;
  // `/.//evil.com` resolves to the path `//evil.com`, a scheme-relative URL: re-check the result.
  return isSafeSitePathShape(path) ? path : null;
}

function readScheme(value: string): string | null {
  const match = SCHEME_PATTERN.exec(value);
  const scheme = match?.[1];
  return scheme ? `${scheme.toLowerCase()}:` : null;
}

function preflight(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > STOREFRONT_LIMITS.maxHrefLength * 4) return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > STOREFRONT_LIMITS.maxHrefLength) return null;
  return hasUnsafeUrlChar(value) ? null : value;
}

function finalize(href: string | null): string | null {
  if (href === null) return null;
  return href.length <= STOREFRONT_LIMITS.maxHrefLength && !hasUnsafeUrlChar(href) ? href : null;
}

/**
 * The only link targets a storefront keeps: absolute `https:` / `http:` URLs without credentials,
 * `mailto:` with one plain address, and site-relative paths (`/products/x?y#z`). Everything else
 * (`javascript:`, `data:`, `vbscript:`, `file:`, `blob:`, `//host`, `/\host`, `#anchor`, relative
 * paths, credentials, hidden characters, over 2000 characters) returns null. The result is
 * normalized with the WHATWG URL parser, so `normalize(normalize(x)) === normalize(x)`.
 */
export function sanitizeStorefrontHref(raw: unknown): string | null {
  const value = preflight(raw);
  if (value === null) return null;
  if (value.charCodeAt(0) === 0x2f) return finalize(normalizeSitePath(value));
  const protocol = readScheme(value);
  if (protocol === null || !LINK_PROTOCOLS.has(protocol)) return null;
  const url = parseUrl(value);
  if (!url || url.protocol !== protocol) return null;
  if (protocol === 'mailto:') {
    if (url.hash !== '' || !MAILTO_ADDRESS.test(url.pathname)) return null;
    return finalize(url.href);
  }
  if (url.username !== '' || url.password !== '' || url.hostname === '') return null;
  return finalize(url.href);
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '[::1]' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/**
 * Normalizes an image origin allowlist: each entry becomes its lowercase origin (`https://host[:port]`,
 * no path, no trailing slash). Only `https:` entries are kept, plus `http:` loopback entries (local
 * development media); anything else is ignored.
 */
export function normalizeStorefrontImageOrigins(origins: readonly string[] | null | undefined): Set<string> {
  const normalized = new Set<string>();
  if (!Array.isArray(origins)) return normalized;
  const entries: readonly unknown[] = origins;
  for (let index = 0; index < entries.length && index < MAX_ORIGIN_ENTRIES; index += 1) {
    const entry = entries[index];
    if (typeof entry !== 'string') continue;
    const url = parseUrl(entry.trim());
    if (!url || url.username !== '' || url.password !== '') continue;
    if (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHostname(url.hostname))) {
      normalized.add(url.origin);
    }
  }
  return normalized;
}

/**
 * Like `normalizeStorefrontImageSrc()` with an allowlist that `normalizeStorefrontImageOrigins()`
 * already normalized (the sanitizer and the renderer normalize it once per call).
 */
export function normalizeStorefrontImageSrcWithOrigins(
  src: unknown,
  origins: ReadonlySet<string>,
): string | null {
  const value = preflight(src);
  if (value === null) return null;
  if (value.charCodeAt(0) === 0x2f) {
    if (!value.startsWith('/images/')) return null;
    const path = normalizeSitePath(value);
    return path !== null && path.startsWith('/images/') && !path.includes('//') ? finalize(path) : null;
  }
  const protocol = readScheme(value);
  if (protocol !== 'https:' && protocol !== 'http:') return null;
  const url = parseUrl(value);
  if (!url || url.protocol !== protocol) return null;
  if (url.username !== '' || url.password !== '' || url.hostname === '') return null;
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) return null;
  if (!origins.has(url.origin)) return null;
  return finalize(url.href);
}

/**
 * The canonical form of an allowed image src, or null: an `https:` URL without credentials whose
 * exact origin is in `allowedOrigins` (an `http:` origin only for loopback hosts the list names),
 * or a site-relative `/images/…` path.
 */
export function normalizeStorefrontImageSrc(src: unknown, allowedOrigins: readonly string[]): string | null {
  return normalizeStorefrontImageSrcWithOrigins(src, normalizeStorefrontImageOrigins(allowedOrigins));
}

/** True when `src` may be used as a storefront image (see `normalizeStorefrontImageSrc`). */
export function isAllowedStorefrontImageSrc(src: unknown, allowedOrigins: readonly string[]): boolean {
  return normalizeStorefrontImageSrc(src, allowedOrigins) !== null;
}

/** The lowercase origin of an `http(s)` site URL (`https://shop.example`), or null. */
export function normalizeStorefrontSiteOrigin(siteOrigin: unknown): string | null {
  if (typeof siteOrigin !== 'string' || siteOrigin.length > STOREFRONT_LIMITS.maxHrefLength) return null;
  const url = parseUrl(siteOrigin.trim());
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) return null;
  return url.origin;
}

/**
 * True when `href` is an absolute `http(s)` URL to an origin other than `siteOrigin` (every absolute
 * URL counts as external when the site origin is unknown). Site-relative paths and `mailto:` are
 * never external. The renderer opens external links in a new tab.
 */
export function isExternalStorefrontHref(href: string, siteOrigin: string | null | undefined): boolean {
  if (!/^https?:\/\//i.test(href)) return false;
  const url = parseUrl(href);
  if (!url) return false;
  const site = normalizeStorefrontSiteOrigin(siteOrigin);
  return site === null || url.origin !== site;
}
