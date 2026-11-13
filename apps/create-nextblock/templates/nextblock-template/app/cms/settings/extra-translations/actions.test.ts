import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = { key: string; translations: Record<string, string>; created_at: string | null; updated_at: string | null };
type PageResult = { data: Row[] | null; error: { message: string } | null };

const mocks = vi.hoisted(() => ({
  /** The `translations` table the fake PostgREST serves (1000 rows per response at most). */
  table: [] as Array<{ key: string; translations: Record<string, string>; created_at: string | null; updated_at: string | null }>,
  /** 0-based index of the translations read that fails, or null. */
  failRead: null as number | null,
  reads: [] as Array<[number, number] | null>,
  upserts: [] as unknown[],
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }));

function byKey(a: Row, b: Row) {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** `from('translations')`: select/order/range reads capped at max_rows = 1000, and upsert. */
function translationsQuery() {
  let range: [number, number] | null = null;
  const builder = {
    select: () => builder,
    order: () => builder,
    range: (from: number, to: number) => {
      range = [from, to];
      return builder;
    },
    upsert: async (rows: unknown) => {
      mocks.upserts.push(rows);
      return { error: null };
    },
    then<T>(resolve: (value: PageResult) => T, reject?: (reason: unknown) => T) {
      const index = mocks.reads.length;
      mocks.reads.push(range);
      if (mocks.failRead === index) {
        return Promise.resolve<PageResult>({ data: null, error: { message: 'connection reset' } }).then(resolve, reject);
      }
      const sorted = [...mocks.table].sort(byKey);
      const [from, to] = range ?? [0, sorted.length - 1];
      return Promise.resolve<PageResult>({ data: sorted.slice(from, to + 1).slice(0, 1000), error: null }).then(resolve, reject);
    },
  };
  return builder;
}

function languagesQuery() {
  const result = {
    data: [
      { code: 'en', name: 'English' },
      { code: 'es', name: 'Spanish' },
      { code: 'fr', name: 'French' },
    ],
    error: null,
  };
  const builder = {
    select: () => builder,
    order: () => builder,
    then: <T>(resolve: (value: typeof result) => T) => Promise.resolve(result).then(resolve),
  };
  return builder;
}

vi.mock('@nextblock-cms/db/server', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'admin-1' } } }) },
    from: (table: string) => {
      if (table === 'profiles') {
        return { select: () => ({ eq: () => ({ single: async () => ({ data: { role: 'ADMIN' } }) }) }) };
      }
      if (table === 'languages') return languagesQuery();
      if (table === 'translations') return translationsQuery();
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

import { getTranslations, importTranslationsCsvAction } from './actions';

/** A fresh install after 02031: 1099 keys, plus one that sorts last (past the first 1000). */
const LAST_KEY: Row = {
  key: 'zip_code_required',
  translations: { en: 'ZIP code is required', fr: 'Le code postal est requis', es: 'El código postal es obligatorio' },
  created_at: null,
  updated_at: null,
};
const TABLE: Row[] = [
  ...Array.from({ length: 1099 }, (_, index) => ({
    key: `key_${String(index).padStart(4, '0')}`,
    translations: { en: `Text ${index}` },
    created_at: null,
    updated_at: null,
  })),
  LAST_KEY,
];

beforeEach(() => {
  mocks.table = TABLE;
  mocks.failRead = null;
  mocks.reads = [];
  mocks.upserts = [];
});

describe('getTranslations (CMS → Extra translations)', () => {
  it('lists every key past the 1000-row cap: a page of 1000, then 100', async () => {
    const rows = await getTranslations();

    expect(rows).toHaveLength(1100);
    expect(rows[rows.length - 1]?.key).toBe('zip_code_required');
    expect(mocks.reads).toEqual([
      [0, 999],
      [1000, 1999],
      [1100, 2099],
    ]);
  });

  it('shows nothing rather than part of the table when a page fails', async () => {
    mocks.failRead = 1;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(getTranslations()).resolves.toEqual([]);
    error.mockRestore();
  });
});

describe('importTranslationsCsvAction', () => {
  it('merges into a key past the first 1000 rows instead of treating it as new', async () => {
    const result = await importTranslationsCsvAction('key,fr\nzip_code_required,Code postal requis\n');

    expect(result).toMatchObject({ success: true, createdCount: 0, updatedCount: 1 });
    expect(mocks.upserts).toEqual([
      [
        {
          key: 'zip_code_required',
          translations: { en: 'ZIP code is required', fr: 'Code postal requis', es: 'El código postal es obligatorio' },
        },
      ],
    ]);
  });

  it('refuses to import when the existing translations cannot be read in full', async () => {
    mocks.failRead = 1;
    const result = await importTranslationsCsvAction('key,en,fr\nzip_code_required,ZIP,Code postal\n');

    expect(result).toMatchObject({ success: false, createdCount: 0, updatedCount: 0 });
    expect(result.success ? '' : result.error).toMatch(/connection reset/);
    expect(mocks.upserts).toEqual([]);
  });
});
