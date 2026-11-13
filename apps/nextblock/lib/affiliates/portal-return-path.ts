import { AFFILIATE_PORTAL_PATH } from '@nextblock-cms/affiliates';

/**
 * Where a partner who has to sign in (or finish their second factor) first comes back to: the
 * portal page they asked for, with its query string (an email's deep link, Stripe Connect's
 * `?connected=1` / `?connect_error=1` landings). Anything outside `/portal/retailer` falls back to
 * the overview and loses its query. `requireRetailerPage()` re-checks the result with
 * `isSafeInternalPath` before it puts it in the sign-in URL.
 *
 * Pure. The portal layout passes the proxy's `x-nextblock-path` / `x-nextblock-search` (set from the
 * real request on every path the proxy matches, which includes the portal); a page passes its own
 * path and `searchParams`.
 */

/** Framework query parameters that never belong in a return address. */
const INTERNAL_QUERY_PARAMS = ['_rsc'];

/** A longer query is dropped (the page itself is kept): sign-in URLs stay short. */
const MAX_RETURN_QUERY_LENGTH = 512;

export type AffiliatePortalReturnQuery =
  | string
  | URLSearchParams
  | Readonly<Record<string, string | readonly string[] | undefined>>
  | null
  | undefined;

function isPortalPath(path: string): boolean {
  if (path !== AFFILIATE_PORTAL_PATH && !path.startsWith(`${AFFILIATE_PORTAL_PATH}/`)) return false;
  // Whole, plain segments only: no dot segments, empty segments, backslashes, encoded slashes or
  // whitespace and control characters.
  if (path.includes('//') || path.includes('\\') || /%2f|%5c/i.test(path)) return false;
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) return false;
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return false;
  }
  return true;
}

function toSearchParams(query: AffiliatePortalReturnQuery): URLSearchParams {
  if (!query) return new URLSearchParams();
  if (typeof query === 'string') return new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  if (query instanceof URLSearchParams) return new URLSearchParams(query);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string') params.append(key, value);
    else if (Array.isArray(value)) for (const entry of value) if (typeof entry === 'string') params.append(key, entry);
  }
  return params;
}

export function buildAffiliatePortalReturnPath(path: string | null | undefined, query?: AffiliatePortalReturnQuery): string {
  const requested = typeof path === 'string' ? path.trim() : '';
  if (!isPortalPath(requested)) return AFFILIATE_PORTAL_PATH;

  const params = toSearchParams(query);
  for (const name of INTERNAL_QUERY_PARAMS) params.delete(name);
  const search = params.toString();
  return search && search.length <= MAX_RETURN_QUERY_LENGTH ? `${requested}?${search}` : requested;
}
