import { describe, expect, it, vi } from 'vitest';

import { MEDIA_MAX_PAGES, MEDIA_PAGE_SIZE, readAllMediaRows } from './media-pages';

type Row = { id: string };

/** A fake PostgREST over `total` rows that never returns more than `maxRows` per request. */
function server(total: number, maxRows = 1000) {
  const rows: Row[] = Array.from({ length: total }, (_, index) => ({ id: `m${String(index).padStart(5, '0')}` }));
  const ranges: Array<[number, number]> = [];
  const fetchPage = vi.fn(async (from: number, to: number) => {
    ranges.push([from, to]);
    return { data: rows.slice(from, to + 1).slice(0, maxRows), error: null };
  });
  return { rows, ranges, fetchPage };
}

describe('readAllMediaRows', () => {
  it('pages in 1000s, the PostgREST max_rows', () => {
    expect(MEDIA_PAGE_SIZE).toBe(1000);
  });

  it('reads 2500 files in three pages and stops on the empty one after them', async () => {
    const { rows, ranges, fetchPage } = server(2500);

    const result = await readAllMediaRows(fetchPage);

    expect(result.error).toBeNull();
    expect(result.data).toEqual(rows);
    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
      [2500, 3499],
    ]);
  });

  it('still reads every row when the server caps responses below the page size (dashboard max_rows)', async () => {
    const { rows, ranges, fetchPage } = server(1100, 300);

    const result = await readAllMediaRows(fetchPage);

    expect(result.data).toEqual(rows);
    expect(ranges.map(([from]) => from)).toEqual([0, 300, 600, 900, 1100]);
  });

  it('reads an empty library in one request', async () => {
    const { ranges, fetchPage } = server(0);
    await expect(readAllMediaRows(fetchPage)).resolves.toEqual({ data: [], error: null });
    expect(ranges).toEqual([[0, 999]]);
  });

  it('answers a failed page with its error and no rows, never part of the library', async () => {
    const fetchPage = vi.fn(async (from: number) =>
      from === 0
        ? { data: Array.from({ length: 1000 }, (_, index) => ({ id: String(index) })), error: null }
        : { data: null, error: { message: 'canceling statement due to statement timeout' } },
    );

    await expect(readAllMediaRows(fetchPage)).resolves.toEqual({
      data: null,
      error: { message: 'canceling statement due to statement timeout' },
    });
  });

  it('stops after MEDIA_MAX_PAGES requests when the server ignores the range', async () => {
    const fetchPage = vi.fn(async () => ({ data: [{ id: 'same' }], error: null }));

    const result = await readAllMediaRows(fetchPage);

    expect(result.data).toBeNull();
    expect(result.error?.message).toMatch(/Stopped reading media after 200 requests/);
    expect(fetchPage).toHaveBeenCalledTimes(MEDIA_MAX_PAGES);
  });
});
