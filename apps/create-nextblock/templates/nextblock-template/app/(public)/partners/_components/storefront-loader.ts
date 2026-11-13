import 'server-only';

import { cache } from 'react';
import {
  normalizeAffiliateHandle,
  normalizeStorefrontImageSrc,
  normalizeStorefrontSiteOrigin,
  sanitizeStorefrontDoc,
  type StorefrontDoc,
} from '@nextblock-cms/affiliates';
import { getStorefrontImageOrigins, toStorefrontImageOrigin } from '../../../../lib/affiliates/image-origins';
import { getRequestLocale } from '../../../../lib/affiliates/request-locale';
import {
  getPublishedAffiliateStorefront,
  type AffiliatePublicStorefront,
} from '../../../../lib/affiliates/storefront-data';
import { resolveMediaUrl } from '../../../../lib/media/resolveMediaUrl';
import { resolveSiteUrl } from '../../../../lib/site-url';
import { resolveMediaBaseUrl } from '../../../../lib/storage/provider';
import { isAffiliatesPackageActive } from './package-gate';

/**
 * Everything `/partners/<handle>` (page, metadata, Open Graph card) reads, once per request: the
 * approved storefront, its document sanitized AT READ TIME with this deployment's image origins (an
 * approval-time sanitize is not trusted on its own; the renderer re-checks every URL again), and the
 * locale. Null for an inactive package, a malformed or reserved handle, or no published storefront.
 */
export interface LoadedAffiliateStorefront {
  handle: string;
  storefront: AffiliatePublicStorefront;
  doc: StorefrontDoc;
  imageOrigins: string[];
  siteUrl: string;
  siteOrigin: string | null;
  siteLocale: string;
}

export const loadAffiliateStorefrontPage = cache(async (rawHandle: string): Promise<LoadedAffiliateStorefront | null> => {
  const handle = normalizeAffiliateHandle(rawHandle);
  if (!handle) return null;
  if (!(await isAffiliatesPackageActive())) return null;

  const storefront = await getPublishedAffiliateStorefront(handle);
  if (!storefront) return null;

  const siteUrl = resolveSiteUrl();
  const siteOrigin = normalizeStorefrontSiteOrigin(siteUrl);
  const imageOrigins = getStorefrontImageOrigins();
  const { doc } = sanitizeStorefrontDoc(storefront.content, { allowedImageOrigins: imageOrigins, siteOrigin });

  let siteLocale = 'en';
  try {
    siteLocale = await getRequestLocale();
  } catch {
    siteLocale = 'en';
  }

  return { handle, storefront, doc, imageOrigins, siteUrl, siteOrigin, siteLocale };
});

/**
 * The avatar URL for the page: the server-set object key resolved against the media base, kept
 * only when it lands on an allowed image origin (or a site `/images/…` path). Never a stored URL.
 */
export function resolveStorefrontAvatarUrl(objectKey: string | null, imageOrigins: readonly string[]): string | null {
  if (!objectKey) return null;
  let mediaBase = '';
  try {
    mediaBase = resolveMediaBaseUrl();
  } catch {
    mediaBase = '';
  }
  return normalizeStorefrontImageSrc(resolveMediaUrl(objectKey, mediaBase), imageOrigins);
}

/**
 * The origins of THIS deployment's media storage only (not the site, not the stock photo hosts):
 * the Open Graph card fetches an avatar server-side, so it only ever talks to the operator's own bucket.
 */
export function getStorefrontMediaOrigins(): Set<string> {
  const allowLocalHttp = process.env.NODE_ENV === 'development';
  let mediaBase = '';
  try {
    mediaBase = resolveMediaBaseUrl();
  } catch {
    mediaBase = '';
  }
  const origins = new Set<string>();
  for (const candidate of [mediaBase, process.env.NEXT_PUBLIC_R2_BASE_URL, process.env.NEXT_PUBLIC_R2_PUBLIC_URL]) {
    const origin = toStorefrontImageOrigin(candidate, { allowLocalHttp });
    if (origin) origins.add(origin);
  }
  return origins;
}
