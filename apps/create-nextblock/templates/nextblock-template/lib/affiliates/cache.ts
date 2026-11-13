import 'server-only';

import { revalidatePath, revalidateTag, updateTag } from 'next/cache';
import {
  AFFILIATE_PARTNERS_PATH,
  AFFILIATE_PARTNERS_PATH_FR,
  AFFILIATE_PARTNERS_TERMS_PATH,
  AFFILIATE_PARTNERS_TERMS_PATH_FR,
  AFFILIATE_PROGRAM_SETTINGS_CACHE_TAG,
  AFFILIATE_STOREFRONT_CACHE_TAG,
  AFFILIATE_TIERS_CACHE_TAG,
} from '@nextblock-cms/affiliates';

/**
 * Where the eviction runs. Next 16 only allows `updateTag` (read-your-own-writes) inside Server
 * Actions; route handlers, `after()` jobs and the payout runner must use `revalidateTag(tag, { expire: 0 })`.
 */
export type AffiliateCacheContext = 'action' | 'route';

function evictTag(tag: string, context: AffiliateCacheContext) {
  try {
    if (context === 'action') {
      updateTag(tag);
    } else {
      revalidateTag(tag, { expire: 0 });
    }
  } catch (error) {
    // Cache housekeeping must never fail the write that triggered it; entries expire on their own.
    console.warn(`[affiliates] Failed to evict cache tag ${tag}.`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function evictPath(path: string) {
  try {
    revalidatePath(path);
  } catch (error) {
    console.warn(`[affiliates] Failed to revalidate ${path}.`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Evict the public storefront reads after an approval, a change request that unpublishes nothing,
 * a suspension, a handle change or an approved profile snapshot. Pass every handle the page was or is
 * served at (old and new on a handle change).
 */
export function evictAffiliateStorefrontCache(
  handles: string | ReadonlyArray<string | null | undefined> | null | undefined,
  context: AffiliateCacheContext,
) {
  evictTag(AFFILIATE_STOREFRONT_CACHE_TAG, context);
  const list = Array.isArray(handles) ? handles : [handles];
  for (const handle of list) {
    if (typeof handle === 'string' && handle.trim()) {
      evictPath(`${AFFILIATE_PARTNERS_PATH}/${handle.trim().toLowerCase()}`);
    }
  }
  evictPath('/sitemap.xml');
}

/**
 * Evict the public tier reads (tier CRUD, and every signup because the founding spots change), on
 * both addresses of the landing page.
 */
export function evictAffiliateTiersCache(context: AffiliateCacheContext) {
  evictTag(AFFILIATE_TIERS_CACHE_TAG, context);
  evictPath(AFFILIATE_PARTNERS_PATH);
  evictPath(AFFILIATE_PARTNERS_PATH_FR);
}

/**
 * Evict the public projection of the program settings (`getPublicAffiliatesProgramSettings`) after
 * a settings save: the terms pages (their redirect and payout details), the landing addresses (the
 * signup form's terms link) and the sitemap (which leaves out a terms address that redirects).
 */
export function evictAffiliateProgramSettingsCache(context: AffiliateCacheContext) {
  evictTag(AFFILIATE_PROGRAM_SETTINGS_CACHE_TAG, context);
  evictPath(AFFILIATE_PARTNERS_TERMS_PATH);
  evictPath(AFFILIATE_PARTNERS_TERMS_PATH_FR);
  evictPath(AFFILIATE_PARTNERS_PATH);
  evictPath(AFFILIATE_PARTNERS_PATH_FR);
  evictPath('/sitemap.xml');
}
