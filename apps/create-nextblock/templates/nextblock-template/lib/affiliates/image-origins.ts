import 'server-only';

import { AFFILIATE_STOCK_IMAGE_ORIGINS } from '@nextblock-cms/affiliates';
import { resolveMediaBaseUrl } from '../storage/provider';
import { resolveSiteUrl } from '../site-url';

/**
 * The exact origins a storefront image may load from: this site's own media storage (the
 * resolved media base, plus both explicit R2 variables when they differ), the site itself, and
 * the stock photo hosts the copilot uses. Passed to `sanitizeStorefrontDoc()`, the editor and the
 * renderer as `allowedImageOrigins`; `/images/…` paths are always allowed by the sanitizer.
 *
 * Server-only because `lib/storage/provider.ts` is (it resolves the storage backend from the
 * service key's presence). Compute the list in RSC or route code and pass it down as a prop
 * (ADDENDUM C14). Only https origins are returned; plain http is kept solely for a localhost
 * address in development (a local MinIO or `next dev`), never in a production build.
 */

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost');
}

/**
 * `scheme://host[:port]` of a URL, lowercase, or null when it is not an acceptable image origin:
 * not a URL, carries credentials, not https (http only for localhost when `allowLocalHttp`).
 */
export function toStorefrontImageOrigin(
  raw: string | null | undefined,
  options: { allowLocalHttp?: boolean } = {},
): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }

  if (url.username || url.password) return null;
  if (url.protocol === 'https:') return url.origin.toLowerCase();
  if (url.protocol === 'http:' && options.allowLocalHttp && isLocalHostname(url.hostname.toLowerCase())) {
    return url.origin.toLowerCase();
  }
  return null;
}

/** De-duplicated allow-list of storefront image origins for this deployment. */
export function getStorefrontImageOrigins(): string[] {
  const allowLocalHttp = process.env.NODE_ENV === 'development';

  let mediaBase = '';
  try {
    mediaBase = resolveMediaBaseUrl();
  } catch {
    mediaBase = '';
  }

  const candidates = [
    mediaBase,
    process.env.NEXT_PUBLIC_R2_BASE_URL,
    process.env.NEXT_PUBLIC_R2_PUBLIC_URL,
    resolveSiteUrl(),
    ...AFFILIATE_STOCK_IMAGE_ORIGINS,
  ];

  const origins: string[] = [];
  for (const candidate of candidates) {
    const origin = toStorefrontImageOrigin(candidate, { allowLocalHttp });
    if (origin && !origins.includes(origin)) origins.push(origin);
  }
  return origins;
}
