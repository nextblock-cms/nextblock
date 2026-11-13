import 'server-only';

import { cache } from 'react';
import { unstable_cache } from 'next/cache';
import { createStaticSupabaseClient } from '../../app/lib/site-settings';
import { AFFILIATE_TRANSLATION_KEY_PREFIX } from './affiliate-translation-rows';
import { readAllTranslationRows } from './translation-pages';

// The cross-request cached reads of the `translations` table, split by audience:
// - getCachedTranslations: the site-wide UI strings, every key EXCEPT `affiliates.*`, for the
//   root layout (app/layout.tsx), which serialises them into every public page.
// - getCachedAffiliateTranslations: only the Affiliates package's `affiliates.*` keys, for its
//   server copy on the partner pages (lib/affiliates/server-copy.ts).
// Both page through PostgREST's row cap (./translation-pages): 02031 took the table past 1000
// rows, and a single read silently lost the keys that sort last (raw `sign_in` on every page).
// Both carry the same tag, so the CMS translation actions
// (`updateTag('public-layout-translations')`) evict both.

// Five minutes, like lib/public-content-cache.ts: every settings action evicts by tag
// or path, so the TTL only bounds direct database edits, and a cold entry is a
// sequential Supabase round trip inside the request on Vercel.
const PUBLIC_LAYOUT_REVALIDATE_SECONDS = 300;

/** Tag the CMS translation actions evict after every write. */
export const PUBLIC_LAYOUT_TRANSLATIONS_CACHE_TAG = 'public-layout-translations';

/** SQL LIKE pattern for every key the Affiliates package owns (`affiliates.<area>.<key>`). */
export const AFFILIATE_TRANSLATION_KEY_PATTERN = `${AFFILIATE_TRANSLATION_KEY_PREFIX}%`;

/**
 * A failed read throws instead of returning no rows: `unstable_cache` stores nothing for a throw
 * and keeps serving its last good entry while stale, where an empty result would be cached for
 * five minutes. The callers fall back to no rows for that one request.
 */
function failedRead(scope: 'site' | 'affiliates', message: string): never {
  console.error(`Error fetching cached ${scope} translations:`, message);
  throw new Error(`Could not read the ${scope} translations: ${message}`);
}

/** Every site-wide translation row (all keys outside `affiliates.*`), all pages. */
export const getCachedTranslations = unstable_cache(
  async () => {
    const supabase = createStaticSupabaseClient();
    const { data, error } = await readAllTranslationRows((from, to) =>
      supabase
        .from('translations')
        .select('key, translations')
        .not('key', 'like', AFFILIATE_TRANSLATION_KEY_PATTERN)
        .order('key')
        .range(from, to),
    );

    if (error) failedRead('site', error.message);
    return data;
  },
  ['public-layout-translations', 'site'],
  {
    revalidate: PUBLIC_LAYOUT_REVALIDATE_SECONDS,
    tags: [PUBLIC_LAYOUT_TRANSLATIONS_CACHE_TAG],
  }
);

/** Every `affiliates.*` translation row (the operator's copy for the partner pages), all pages. */
export const getCachedAffiliateTranslations = unstable_cache(
  async () => {
    const supabase = createStaticSupabaseClient();
    const { data, error } = await readAllTranslationRows((from, to) =>
      supabase
        .from('translations')
        .select('key, translations')
        .like('key', AFFILIATE_TRANSLATION_KEY_PATTERN)
        .order('key')
        .range(from, to),
    );

    if (error) failedRead('affiliates', error.message);
    return data;
  },
  ['public-layout-translations', 'affiliates'],
  {
    revalidate: PUBLIC_LAYOUT_REVALIDATE_SECONDS,
    tags: [PUBLIC_LAYOUT_TRANSLATIONS_CACHE_TAG],
  }
);

export type CachedTranslationRow = Awaited<ReturnType<typeof getCachedTranslations>>[number];

/**
 * The `affiliates.*` rows, memoised per request with React `cache` for readers that may run
 * several times in one render (a partner layout and its page both building their copy). Never
 * throws: an unreadable table yields no rows, and every caller falls back to built-in strings.
 */
export const getRequestCachedAffiliateTranslations = cache(async (): Promise<CachedTranslationRow[]> => {
  try {
    const rows = await getCachedAffiliateTranslations();
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
});
