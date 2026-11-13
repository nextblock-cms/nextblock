import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Storefront products come from the anon client (only what the public may see), keyed by the id the
 * approved document names, swapped to the visitor's language through the translation group, and
 * the untrusted ids are checked before any query.
 */

const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ID_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ID_A_FR = 'aaaaaaaa-0000-4aaa-8aaa-aaaaaaaaaaaa';

type ProductRow = { id: string; title: string; slug: string; language_id: number; translation_group_id: string | null };

const mocks = vi.hoisted(() => ({
  rows: [] as ProductRow[],
  languages: [] as Array<{ id: number; code: string; is_active: boolean | null }>,
  languagesError: null as unknown,
  productsError: null as unknown,
  getProductsCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock('next/cache', () => ({ unstable_cache: (fn: (...args: unknown[]) => unknown) => fn }));
vi.mock('./storefront-data', () => ({ AFFILIATE_PUBLIC_READ_REVALIDATE_SECONDS: 300 }));
vi.mock('@nextblock-cms/db/server', () => ({
  getSsgSupabaseClient: () => ({
    from: (table: string) => {
      if (table !== 'languages') throw new Error(`unexpected table ${table}`);
      return { select: async () => ({ data: mocks.languagesError ? null : mocks.languages, error: mocks.languagesError }) };
    },
  }),
}));
vi.mock('@nextblock-cms/ecommerce/server', () => ({
  getProducts: async (_supabase: unknown, options: { productIds?: string[]; translationGroupIds?: string[]; languageId?: number }) => {
    mocks.getProductsCalls.push(options as Record<string, unknown>);
    if (mocks.productsError) return { data: null, error: mocks.productsError, count: 0 };
    const data = mocks.rows.filter((row) =>
      options.productIds
        ? options.productIds.includes(row.id)
        : options.translationGroupIds
          ? row.translation_group_id !== null &&
            options.translationGroupIds.includes(row.translation_group_id) &&
            row.language_id === options.languageId
          : false,
    );
    return { data, error: null, count: data.length };
  },
}));

import {
  AFFILIATE_STOREFRONT_MAX_PRODUCTS,
  loadAffiliateStorefrontProducts,
  normalizeAffiliateStorefrontProductIds,
} from './storefront-products';

beforeEach(() => {
  mocks.rows = [
    { id: ID_A, title: 'Chef knife', slug: 'chef-knife', language_id: 1, translation_group_id: 'group-a' },
    { id: ID_A_FR, title: 'Couteau de chef', slug: 'couteau-de-chef', language_id: 2, translation_group_id: 'group-a' },
    { id: ID_B, title: 'Cutting board', slug: 'cutting-board', language_id: 1, translation_group_id: 'group-b' },
  ];
  mocks.languages = [
    { id: 1, code: 'en', is_active: true },
    { id: 2, code: 'fr', is_active: true },
  ];
  mocks.languagesError = null;
  mocks.productsError = null;
  mocks.getProductsCalls = [];
});

describe('normalizeAffiliateStorefrontProductIds', () => {
  it('keeps uuids only, lowercased, de-duplicated, in order and capped', () => {
    expect(normalizeAffiliateStorefrontProductIds([ID_B, 'nope', ID_A.toUpperCase(), ID_B, 42, null])).toEqual([ID_B, ID_A]);
    const many = Array.from({ length: 80 }, (_, index) => `${index.toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`);
    expect(normalizeAffiliateStorefrontProductIds(many)).toHaveLength(AFFILIATE_STOREFRONT_MAX_PRODUCTS);
  });
});

describe('loadAffiliateStorefrontProducts', () => {
  it('runs no query for an empty or invalid list', async () => {
    await expect(loadAffiliateStorefrontProducts({ productIds: ['x', ''], locale: 'en' })).resolves.toEqual(new Map());
    expect(mocks.getProductsCalls).toEqual([]);
  });

  it('keys products by the requested id and keeps the visitor language when it matches', async () => {
    const products = await loadAffiliateStorefrontProducts({ productIds: [ID_B, ID_A, ID_C], locale: 'en' });

    expect([...products.keys()]).toEqual([ID_B, ID_A]);
    expect(products.get(ID_A)?.title).toBe('Chef knife');
    expect(mocks.getProductsCalls).toEqual([{ productIds: [ID_B, ID_A, ID_C], limit: 3 }]);
  });

  it('swaps each pick for its translation in the visitor language, else keeps the pick', async () => {
    const products = await loadAffiliateStorefrontProducts({ productIds: [ID_A, ID_B], locale: 'fr-CA' });

    expect(products.get(ID_A)?.title).toBe('Couteau de chef');
    expect(products.get(ID_A)?.slug).toBe('couteau-de-chef');
    // No French translation of the board yet: the English pick stays.
    expect(products.get(ID_B)?.title).toBe('Cutting board');
    expect(mocks.getProductsCalls[1]).toEqual({ translationGroupIds: ['group-a', 'group-b'], languageId: 2, limit: 2 });
  });

  it('skips the swap when the languages cannot be read', async () => {
    mocks.languagesError = { message: 'boom' };
    const products = await loadAffiliateStorefrontProducts({ productIds: [ID_A], locale: 'fr' });
    expect(products.get(ID_A)?.title).toBe('Chef knife');
    expect(mocks.getProductsCalls).toHaveLength(1);
  });

  it('never throws: a failed read means no products', async () => {
    mocks.productsError = { message: 'permission denied' };
    await expect(loadAffiliateStorefrontProducts({ productIds: [ID_A], locale: 'en' })).resolves.toEqual(new Map());
  });
});
