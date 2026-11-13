import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = { key: string; translations: unknown };
type Request = { table: string; columns: string; filters: string[]; order: string | null; range: [number, number] | null };

const mocks = vi.hoisted(() => ({
  cacheCalls: [] as Array<{ keyParts: unknown; options: unknown }>,
  /** The `translations` table the fake PostgREST serves. */
  table: [] as Array<{ key: string; translations: unknown }>,
  /** 0-based index of the request that fails, or null. */
  failRequest: null as number | null,
  requests: [] as Array<{
    table: string;
    columns: string;
    filters: string[];
    order: string | null;
    range: [number, number] | null;
  }>,
}));

vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown, keyParts: unknown, options: unknown) => {
    mocks.cacheCalls.push({ keyParts, options });
    return fn;
  },
}));

/** SQL LIKE → RegExp (`%` any run, `_` any one character). */
function likeToRegExp(pattern: string): RegExp {
  const source = pattern
    .split('')
    .map((ch) => (ch === '%' ? '.*' : ch === '_' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${source}$`);
}

/**
 * A fake PostgREST query builder over `mocks.table`: `like` / `not like` filters, `order`, `range`,
 * and the server's `max_rows` cap of 1000 rows per response (an unranged read gets the first 1000).
 */
function fakeQuery(table: string) {
  const request: Request = { table, columns: '', filters: [], order: null, range: null };
  const predicates: Array<(row: Row) => boolean> = [];
  const builder = {
    select(columns: string) {
      request.columns = columns;
      return builder;
    },
    like(column: string, pattern: string) {
      request.filters.push(`${column} like ${pattern}`);
      const regexp = likeToRegExp(pattern);
      predicates.push((row) => regexp.test(String(row[column as keyof Row])));
      return builder;
    },
    not(column: string, operator: string, pattern: string) {
      expect(operator).toBe('like');
      request.filters.push(`${column} not like ${pattern}`);
      const regexp = likeToRegExp(pattern);
      predicates.push((row) => !regexp.test(String(row[column as keyof Row])));
      return builder;
    },
    order(column: string) {
      request.order = column;
      return builder;
    },
    range(from: number, to: number) {
      request.range = [from, to];
      return builder;
    },
    then<T>(resolve: (value: { data: Row[] | null; error: { message: string } | null }) => T, reject?: (reason: unknown) => T) {
      const index = mocks.requests.length;
      mocks.requests.push(request);
      if (mocks.failRequest === index) {
        return Promise.resolve({ data: null, error: { message: 'canceling statement due to statement timeout' } }).then(resolve, reject);
      }
      const rows = mocks.table
        .filter((row) => predicates.every((predicate) => predicate(row)))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const [from, to] = request.range ?? [0, rows.length - 1];
      const page = rows.slice(from, to + 1).slice(0, 1000);
      return Promise.resolve({ data: page, error: null }).then(resolve, reject);
    },
  };
  return builder;
}

vi.mock('../../app/lib/site-settings', () => ({
  createStaticSupabaseClient: () => ({ from: (table: string) => fakeQuery(table) }),
}));

import {
  AFFILIATE_TRANSLATION_KEY_PATTERN,
  PUBLIC_LAYOUT_TRANSLATIONS_CACHE_TAG,
  getCachedAffiliateTranslations,
  getCachedTranslations,
  getRequestCachedAffiliateTranslations,
} from './cached-translations';

function rows(prefix: string, count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `${prefix}${String(index).padStart(4, '0')}`,
    translations: { en: `${prefix}${index}`, fr: `${prefix}${index} (fr)` },
  }));
}

/** A fresh install after 02031: ~1100 site-wide keys (the tail sorts after `affiliates.`) and the partner copy. */
const SITE_ROWS = [...rows('a_site_', 400), ...rows('sign_', 700)];
const AFFILIATE_ROWS = rows('affiliates.portal.k', 590);

beforeEach(() => {
  mocks.table = [...AFFILIATE_ROWS, ...SITE_ROWS];
  mocks.failRequest = null;
  mocks.requests = [];
});

describe('the cached translation reads', () => {
  it('are two entries under the tag the CMS translation actions evict, with a five-minute lifetime', () => {
    expect(mocks.cacheCalls).toEqual([
      {
        keyParts: ['public-layout-translations', 'site'],
        options: { revalidate: 300, tags: ['public-layout-translations'] },
      },
      {
        keyParts: ['public-layout-translations', 'affiliates'],
        options: { revalidate: 300, tags: ['public-layout-translations'] },
      },
    ]);
    // The tag the CMS translation actions evict (app/cms/settings/extra-translations/actions.ts).
    expect(PUBLIC_LAYOUT_TRANSLATIONS_CACHE_TAG).toBe('public-layout-translations');
    expect(AFFILIATE_TRANSLATION_KEY_PATTERN).toBe('affiliates.%');
  });
});

describe('getCachedTranslations (root layout)', () => {
  it('reads every site-wide row past the 1000-row cap: a page of 1000, then 100, then the empty end', async () => {
    const result = await getCachedTranslations();

    expect(result).toHaveLength(1100);
    expect(result.map((row) => row.key)).toEqual(SITE_ROWS.map((row) => row.key));
    expect(result.at(-1)).toEqual({ key: 'sign_0699', translations: { en: 'sign_699', fr: 'sign_699 (fr)' } });
    expect(mocks.requests).toEqual([
      { table: 'translations', columns: 'key, translations', filters: ['key not like affiliates.%'], order: 'key', range: [0, 999] },
      { table: 'translations', columns: 'key, translations', filters: ['key not like affiliates.%'], order: 'key', range: [1000, 1999] },
      { table: 'translations', columns: 'key, translations', filters: ['key not like affiliates.%'], order: 'key', range: [1100, 2099] },
    ]);
  });

  it('never fetches an affiliates.* row', async () => {
    const result = await getCachedTranslations();
    expect(result.some((row) => row.key.startsWith('affiliates.'))).toBe(false);
  });

  it('reads a small table in two requests: its rows, then the empty end', async () => {
    mocks.table = rows('k', 3);
    await expect(getCachedTranslations()).resolves.toHaveLength(3);
    expect(mocks.requests.map((request) => request.range)).toEqual([
      [0, 999],
      [3, 1002],
    ]);
  });

  it('throws on a failed page instead of returning (and caching) part of the table', async () => {
    mocks.failRequest = 1;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(getCachedTranslations()).rejects.toThrow(/statement timeout/);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('getCachedAffiliateTranslations (partner pages)', () => {
  it('reads only the affiliates.* rows', async () => {
    const result = await getCachedAffiliateTranslations();

    expect(result).toHaveLength(590);
    expect(result.every((row) => row.key.startsWith('affiliates.'))).toBe(true);
    expect(mocks.requests).toEqual([
      { table: 'translations', columns: 'key, translations', filters: ['key like affiliates.%'], order: 'key', range: [0, 999] },
      { table: 'translations', columns: 'key, translations', filters: ['key like affiliates.%'], order: 'key', range: [590, 1589] },
    ]);
  });

  it('pages too once the package copy alone passes 1000 rows', async () => {
    mocks.table = [...rows('affiliates.portal.k', 1500), ...SITE_ROWS];
    await expect(getCachedAffiliateTranslations()).resolves.toHaveLength(1500);
    expect(mocks.requests.map((request) => request.range)).toEqual([
      [0, 999],
      [1000, 1999],
      [1500, 2499],
    ]);
  });
});

describe('getRequestCachedAffiliateTranslations', () => {
  it('returns the affiliates rows', async () => {
    await expect(getRequestCachedAffiliateTranslations()).resolves.toHaveLength(590);
  });

  it('never throws: a failed read yields no rows', async () => {
    mocks.failRequest = 0;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(getRequestCachedAffiliateTranslations()).resolves.toEqual([]);
    error.mockRestore();
  });
});

describe('app/layout.tsx wiring', () => {
  // A source check, because the layout itself (headers, cookies, a dozen readers) is not unit
  // rendered: it must read the shared cached site-wide rows, fall back to none when the read
  // throws, and still drop any affiliates string before they are serialised into every page.
  const layoutSource = readFileSync(path.resolve(__dirname, '../../app/layout.tsx'), 'utf8');

  it('imports the shared cached reader instead of defining its own', () => {
    expect(layoutSource).toMatch(/import \{ getCachedTranslations \} from '\.\.\/lib\/i18n\/cached-translations';/);
    expect(layoutSource).not.toMatch(/const getCachedTranslations\s*=/);
    expect(layoutSource).toMatch(/getCachedTranslations\(\)\.catch\(\(\) => \[\]\)/);
  });

  it('filters affiliates.* rows before compacting the client payload', () => {
    expect(layoutSource).toMatch(
      /compactTranslationsForLocale\(\s*excludeAffiliateTranslationRows\(translations\),\s*serverDeterminedLocale\s*\)/,
    );
    expect(layoutSource).not.toMatch(/compactTranslationsForLocale\(translations,/);
  });
});
