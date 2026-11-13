/**
 * Read every row of the `translations` table through PostgREST's row cap.
 *
 * PostgREST answers one request with at most `max_rows` rows (1000 in
 * libs/db/src/supabase/config.toml, and Supabase's hosted default) and drops the rest without an
 * error. Migration 02031 took a fresh install to about 1100 keys, so an unpaginated
 * `.order('key')` read lost the hundred keys that sort last (`sign_in`, `sign_up`,
 * `theme_switcher`, `reviews.*`…) and every public page rendered them as raw keys.
 *
 * Every read of many translation rows goes through {@link readAllTranslationRows}:
 * `tools/scripts/translations-pagination.test.ts` fails on a `.from('translations')` read of many
 * rows without `.range()`. Dependency-free, like ./slim-translations, so the layout's cached
 * reader, the CMS actions and their tests can share it.
 */

/**
 * Rows asked for per request: the server's `max_rows`, so a read takes as few requests as possible.
 * A server that returns fewer (a project whose Data API "Max rows" was lowered in the dashboard,
 * which this repository cannot see) still yields every row: the reader moves on by the rows it got.
 */
export const TRANSLATIONS_PAGE_SIZE = 1000;

/** Hard stop on requests, so a server that ignored the page range could not loop forever. */
export const TRANSLATIONS_MAX_PAGES = 100;

export interface TranslationPageError {
  message: string;
}

/** What one page request resolves to: a Supabase query builder fits as is. */
export type TranslationPageResponse<Row> = PromiseLike<{
  data: Row[] | null;
  error: TranslationPageError | null;
}>;

export type TranslationPagesResult<Row> =
  | { data: Row[]; error: null }
  | { data: null; error: TranslationPageError };

/**
 * Fetch `[0, 999]`, then from wherever the rows received so far end, until a page comes back
 * EMPTY, and return every row. A short page is not the end: PostgREST silently caps a response at
 * the project's `max_rows`, which may be lower than {@link TRANSLATIONS_PAGE_SIZE}, so only an empty
 * page proves there is nothing left (one extra request per read; the callers cache the result).
 *
 * `fetchPage(from, to)` must return rows `from` to `to` (inclusive) of a query with a total order,
 * i.e. `.order('key').range(from, to)` on the primary key, so no row is skipped or read twice.
 *
 * All or nothing: when any page fails, the result is that error and no rows, so a caller never
 * caches, shows or edits against part of the table.
 */
export async function readAllTranslationRows<Row>(
  fetchPage: (from: number, to: number) => TranslationPageResponse<Row>,
): Promise<TranslationPagesResult<Row>> {
  const rows: Row[] = [];

  for (let request = 0; request < TRANSLATIONS_MAX_PAGES; request += 1) {
    const from = rows.length;
    const { data, error } = await fetchPage(from, from + TRANSLATIONS_PAGE_SIZE - 1);
    if (error) return { data: null, error };

    const batch = Array.isArray(data) ? data : [];
    if (batch.length === 0) return { data: rows, error: null };
    for (const row of batch) rows.push(row);
  }

  return {
    data: null,
    error: {
      message: `Stopped reading translations after ${TRANSLATIONS_MAX_PAGES} requests without reaching an empty page.`,
    },
  };
}
