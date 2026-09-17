import 'server-only';

import { getSsgSupabaseClient } from '@nextblock-cms/db/server';
import { unstable_cache } from 'next/cache';

const getCachedLanguageCodes = unstable_cache(
  async (): Promise<Array<[number, string]>> => {
    const { data, error } = await getSsgSupabaseClient().from('languages').select('id, code');

    if (error || !data) return [];

    return data.map((row) => [row.id, row.code] as [number, string]);
  },
  ['public-language-codes'],
  { revalidate: 300, tags: ['public-language-codes'] }
);

/**
 * The locale code (`en`, `fr`, ...) behind a `language_id`. Server block renderers only
 * receive the numeric id, but `Intl` formatting needs the code. Cached: the table is tiny
 * and changes about never. Returns `fallback` when the lookup fails, never throws.
 */
export async function getCachedLanguageCode(languageId: number, fallback = 'en'): Promise<string> {
  try {
    const codes = await getCachedLanguageCodes();
    return codes.find(([id]) => id === languageId)?.[1] ?? fallback;
  } catch {
    return fallback;
  }
}
