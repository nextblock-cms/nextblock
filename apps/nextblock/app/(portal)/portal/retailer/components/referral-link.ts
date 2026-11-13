/**
 * The `?ref=<handle>` link builder of the share tools. Pure and client-safe.
 *
 * A partner can point a referral link at any public page of this site: the proxy reads `?ref=`
 * on every document navigation outside `/cms`, `/api`, `/portal` and `/_next`, so those are
 * refused here, as is any other site (the link would leave the store and earn nothing).
 */

export type PortalReferralLinkResult =
  | { ok: true; url: string }
  | { ok: false; error: 'empty' | 'invalid' | 'other_site' | 'excluded_path' };

const MAX_INPUT_LENGTH = 2000;
const EXCLUDED_PREFIXES = ['/cms', '/api', '/portal', '/_next'];
const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;

function isExcludedPath(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return EXCLUDED_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(`${prefix}/`));
}

function hasControlOrSpace(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * `input` is a site path (`/product/tee`) or a full URL on `siteOrigin`; the result keeps its
 * path, query and fragment, with `ref` set to the partner's handle (replacing any `ref` already
 * there). An empty input links to the home page.
 */
export function buildPortalReferralLink(options: { input: string; siteOrigin: string; handle: string }): PortalReferralLinkResult {
  const handle = options.handle.trim().toLowerCase();
  let origin: URL;
  try {
    origin = new URL(options.siteOrigin);
  } catch {
    return { ok: false, error: 'invalid' };
  }
  if (!HANDLE_PATTERN.test(handle)) return { ok: false, error: 'invalid' };

  const raw = options.input.trim();
  if (raw.length > MAX_INPUT_LENGTH) return { ok: false, error: 'invalid' };
  const value = raw === '' ? '/' : raw;
  if (hasControlOrSpace(value) || value.includes('\\')) return { ok: false, error: 'invalid' };

  let url: URL;
  if (value.startsWith('/')) {
    if (value.startsWith('//') || /^\/%2f/i.test(value) || /^\/%5c/i.test(value)) return { ok: false, error: 'invalid' };
    try {
      url = new URL(value, origin);
    } catch {
      return { ok: false, error: 'invalid' };
    }
  } else {
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`);
    } catch {
      return { ok: false, error: 'invalid' };
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, error: 'invalid' };
    if (url.username || url.password) return { ok: false, error: 'invalid' };
    if (url.host.toLowerCase() !== origin.host.toLowerCase()) return { ok: false, error: 'other_site' };
    // Same host: keep this site's own scheme.
    url = new URL(`${url.pathname}${url.search}${url.hash}`, origin);
  }

  if (url.origin !== origin.origin) return { ok: false, error: 'other_site' };
  if (isExcludedPath(url.pathname)) return { ok: false, error: 'excluded_path' };

  url.searchParams.delete('ref');
  url.searchParams.set('ref', handle);
  return { ok: true, url: url.toString() };
}
