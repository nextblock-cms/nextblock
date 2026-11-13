import { describe, expect, it, vi } from 'vitest';

import { TRANSLATIONS_MAX_PAGES, TRANSLATIONS_PAGE_SIZE, readAllTranslationRows } from './translation-pages';

type Row = { key: string };

/** A fake PostgREST over `total` rows that never returns more than `maxRows` per request. */
function server(total: number, maxRows = 1000) {
  const rows: Row[] = Array.from({ length: total }, (_, index) => ({ key: `k${String(index).padStart(5, '0')}` }));
  const ranges: Array<[number, number]> = [];
  const fetchPage = vi.fn(async (from: number, to: number) => {
    ranges.push([from, to]);
    return { data: rows.slice(from, to + 1).slice(0, maxRows), error: null };
  });
  return { rows, ranges, fetchPage };
}

describe('readAllTranslationRows', () => {
  it('pages in 1000s, the PostgREST max_rows', () => {
    expect(TRANSLATIONS_PAGE_SIZE).toBe(1000);
  });

  it('reads a page of 1000, a short page of 100, and stops on the empty page after it', async () => {
    const { rows, ranges, fetchPage } = server(1100);

    const result = await readAllTranslationRows(fetchPage);

    expect(result.error).toBeNull();
    expect(result.data).toEqual(rows);
    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999],
      [1100, 2099],
    ]);
  });

  it('still reads every row when the server caps responses below the page size (dashboard max_rows)', async () => {
    // 2026-10-29 fix review: a project whose Data API "Max rows" is 300 answered the first page with
    // 300 rows, which the reader used to take for the end of the table.
    const { rows, ranges, fetchPage } = server(1100, 300);

    const result = await readAllTranslationRows(fetchPage);

    expect(result.error).toBeNull();
    expect(result.data).toEqual(rows);
    expect(ranges.map(([from]) => from)).toEqual([0, 300, 600, 900, 1100]);
  });

  it('asks once more after an exactly full page, and stops on the empty one', async () => {
    const { ranges, fetchPage } = server(1000);
    await expect(readAllTranslationRows(fetchPage)).resolves.toMatchObject({ error: null, data: { length: 1000 } });
    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it('reads an empty table in one request and a small one in two (the second comes back empty)', async () => {
    const empty = server(0);
    await expect(readAllTranslationRows(empty.fetchPage)).resolves.toEqual({ data: [], error: null });
    expect(empty.ranges).toHaveLength(1);

    const small = server(42);
    await expect(readAllTranslationRows(small.fetchPage)).resolves.toMatchObject({ data: { length: 42 } });
    expect(small.ranges).toEqual([
      [0, 999],
      [42, 1041],
    ]);
  });

  it('treats a page without data as empty', async () => {
    await expect(readAllTranslationRows(async () => ({ data: null, error: null }))).resolves.toEqual({ data: [], error: null });
  });

  it('returns the error and no rows when any page fails (never part of the table)', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ data: Array.from({ length: 1000 }, (_, index) => ({ key: `k${index}` })), error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'statement timeout' } });

    await expect(readAllTranslationRows<Row>(fetchPage)).resolves.toEqual({ data: null, error: { message: 'statement timeout' } });
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('stops after the page limit when a server ignores the range', async () => {
    const full = Array.from({ length: TRANSLATIONS_PAGE_SIZE }, (_, index) => ({ key: `k${index}` }));
    const fetchPage = vi.fn(async () => ({ data: full, error: null }));

    const result = await readAllTranslationRows<Row>(fetchPage);

    expect(result.data).toBeNull();
    expect(result.error?.message).toMatch(/Stopped reading translations/);
    expect(fetchPage).toHaveBeenCalledTimes(TRANSLATIONS_MAX_PAGES);
  });
});
