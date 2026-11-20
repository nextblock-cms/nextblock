/**
 * Read every row of a `media` query through PostgREST's row cap.
 *
 * PostgREST answers one request with at most `max_rows` rows (1000 in
 * libs/db/src/supabase/config.toml, and Supabase's hosted default) and drops the rest without an
 * error. The media library read its files, its folder list and its folder counts in one request
 * each, so a library past 1000 files showed only the newest 1000, and folders holding only older
 * files vanished from the navigator; the CMS transfer's media map lost the same rows.
 *
 * Dependency-free, like ../i18n/translation-pages (whose reader this mirrors), so the media page,
 * the CMS transfer and their tests can share it.
 */

/** Rows asked for per request: the server's `max_rows`, so a read takes as few requests as possible. */
export const MEDIA_PAGE_SIZE = 1000;

/** Hard stop on requests (200,000 rows), so a server that ignored the range could not loop forever. */
export const MEDIA_MAX_PAGES = 200;

export interface MediaPageError {
  message: string;
}

/** What one page request resolves to: a Supabase query builder fits as is. */
export type MediaPageResponse<Row> = PromiseLike<{
  data: Row[] | null;
  error: MediaPageError | null;
}>;

export type MediaPagesResult<Row> = { data: Row[]; error: null } | { data: null; error: MediaPageError };

/**
 * Fetch `[0, 999]`, then from wherever the rows received so far end, until a page comes back
 * EMPTY, and return every row. A short page is not the end: PostgREST caps a response at the
 * project's `max_rows`, which may be lower than {@link MEDIA_PAGE_SIZE}, so only an empty page proves
 * there is nothing left (one extra request per read).
 *
 * `fetchPage(from, to)` must return rows `from` to `to` (inclusive) of a query with a total order
 * (end the ordering on the primary key: `.order('created_at', …).order('id', …)`), so no row is
 * skipped or read twice.
 *
 * All or nothing: when any page fails, the result is that error and no rows, so a caller never
 * shows or maps part of the library as all of it.
 */
export async function readAllMediaRows<Row>(
  fetchPage: (from: number, to: number) => MediaPageResponse<Row>,
): Promise<MediaPagesResult<Row>> {
  const rows: Row[] = [];

  for (let request = 0; request < MEDIA_MAX_PAGES; request += 1) {
    const from = rows.length;
    const { data, error } = await fetchPage(from, from + MEDIA_PAGE_SIZE - 1);
    if (error) return { data: null, error };

    const batch = Array.isArray(data) ? data : [];
    if (batch.length === 0) return { data: rows, error: null };
    for (const row of batch) rows.push(row);
  }

  return {
    data: null,
    error: { message: `Stopped reading media after ${MEDIA_MAX_PAGES} requests without reaching an empty page.` },
  };
}
