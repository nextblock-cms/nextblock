import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The `/partners` showcase catalog: the anon client only, active and published products only, one
 * locale-free cache entry that never stores a degraded read, licenses priced from the tier checkout
 * charges, and the visitor's language chosen per translation group afterwards.
 */

type Result = { data: unknown; error: unknown };

const mocks = vi.hoisted(() => ({
  cacheEntries: [] as Array<{ keyParts: unknown; options: unknown }>,
  results: {} as Record<string, Result[]>,
  calls: [] as Array<{ table: string; calls: Array<[string, unknown[]]> }>,
}));

vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown, keyParts: unknown, options?: unknown) => {
    mocks.cacheEntries.push({ keyParts, options });
    return fn;
  },
}));

function tableBuilder(table: string) {
  const record = { table, calls: [] as Array<[string, unknown[]]> };
  mocks.calls.push(record);
  // Each read of a table takes the next queued result (products is read twice: rows, then plans).
  const result = () => mocks.results[table]?.shift() ?? { data: null, error: { message: `no fixture for ${table}` } };
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'or', 'order', 'in', 'limit']) {
    builder[method] = (...args: unknown[]) => {
      record.calls.push([method, args]);
      return builder;
    };
  }
  builder['then'] = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result()).then(resolve, reject);
  return builder;
}

vi.mock('@nextblock-cms/db/server', () => ({
  getSsgSupabaseClient: () => ({ from: (table: string) => tableBuilder(table) }),
}));

import {
  getPartnersShowcaseCatalog,
  partnersShowcaseEntryTiers,
  selectPartnersShowcaseForLocale,
  type PartnersShowcaseCatalog,
} from './partners-showcase';

const GROUP_COMMERCE = '11111111-1111-4111-8111-111111111111';
const GROUP_TEE = '22222222-2222-4222-8222-222222222222';

const CURRENCIES: Result = {
  data: [{ code: 'USD', symbol: '$', exchange_rate: 1, is_default: true, is_active: true }],
  error: null,
};
const LANGUAGES: Result = { data: [{ id: 1, code: 'en' }, { id: 2, code: 'fr' }], error: null };

function productRow(overrides: Record<string, unknown>) {
  return { payment_provider: 'stripe', price: 3_200, prices: { USD: 3_200 }, ...overrides };
}

const PRODUCT_ROWS: Result = {
  data: [
    productRow({ id: 'c-en', title: 'Commerce Pro License', slug: 'commerce-pro', payment_provider: 'freemius', price: 25_000, prices: {}, language_id: 1, translation_group_id: GROUP_COMMERCE }),
    productRow({ id: 'c-fr', title: 'Licence Commerce Pro', slug: 'commerce-pro-fr', payment_provider: 'freemius', price: 25_000, prices: {}, language_id: 2, translation_group_id: GROUP_COMMERCE }),
    productRow({ id: 't-en', title: 'Studio Tee', slug: 'studio-tee', language_id: 1, translation_group_id: GROUP_TEE }),
  ],
  error: null,
};

/** Plans live on the EN row only; a second, renamed plan row holds a cheaper-quota tier. */
const PLAN_ROWS: Result = {
  data: [
    {
      translation_group_id: GROUP_COMMERCE,
      freemius_plans: [
        { id: 'plan-b', freemius_pricing: [{ id: 'tier-5', license_quota: 5, is_active: true, api_annual_price: 900, api_monthly_price: 90 }] },
        {
          id: 'plan-a',
          freemius_pricing: [
            { id: 'tier-1', license_quota: 1, is_active: true, api_annual_price: 250, api_monthly_price: 25 },
            { id: 'tier-0', license_quota: 1, is_active: false, api_annual_price: 1, api_monthly_price: 1 },
          ],
        },
      ],
    },
    { translation_group_id: GROUP_COMMERCE, freemius_plans: [] },
  ],
  error: null,
};

beforeEach(() => {
  mocks.results = {};
  mocks.calls = [];
});

describe('getPartnersShowcaseCatalog', () => {
  it('reads active, published products with the anon client, once for every language, and prices licenses from the entry tier', async () => {
    mocks.results = { currencies: [CURRENCIES], languages: [LANGUAGES], products: [PRODUCT_ROWS, PLAN_ROWS] };
    const catalog = await getPartnersShowcaseCatalog();

    expect(mocks.cacheEntries[0]?.keyParts).toEqual(['affiliates-partners-showcase-catalog']);
    expect(mocks.cacheEntries[0]?.options).toEqual({ revalidate: 300 });
    const productRead = mocks.calls.find((record) => record.table === 'products');
    expect(productRead?.calls).toContainEqual(['eq', ['status', 'active']]);
    expect(productRead?.calls.find(([method]) => method === 'or')?.[1][0]).toMatch(/^published_at\.is\.null,published_at\.lte\./);

    expect(catalog?.currency).toBe('USD');
    const commerce = catalog?.candidates.filter((candidate) => candidate.group === GROUP_COMMERCE) ?? [];
    expect(commerce.map((candidate) => candidate.language)).toEqual(['en', 'fr']);
    // The active, lowest-quota tier across every plan of the group (the inactive tier-0 never counts).
    expect(commerce[0]?.product).toMatchObject({ orderValueMinor: 25_000, monthlyMinor: 2_500, billing: 'year', href: '/product/commerce-pro' });
    // The French row has no plans of its own: priced through its translation group.
    expect(commerce[1]?.product).toMatchObject({ title: 'Licence Commerce Pro', orderValueMinor: 25_000, href: '/product/commerce-pro-fr' });
    const tee = catalog?.candidates.find((candidate) => candidate.group === GROUP_TEE);
    expect(tee?.product).toMatchObject({ orderValueMinor: 3_200, monthlyMinor: null, billing: 'once' });
  });

  it.each(['currencies', 'languages', 'products'])('returns null (and caches nothing) when the %s read fails', async (failing) => {
    mocks.results = { currencies: [CURRENCIES], languages: [LANGUAGES], products: [PRODUCT_ROWS, PLAN_ROWS] };
    mocks.results[failing] = [{ data: null, error: { message: 'boom' } }];
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(getPartnersShowcaseCatalog()).resolves.toBeNull();
    spy.mockRestore();
  });
});

describe('partnersShowcaseEntryTiers', () => {
  it('picks the active tier with the lowest quota, ties by tier id, across all plans and rows of a group', () => {
    const tiers = partnersShowcaseEntryTiers([
      { translation_group_id: 'g', freemius_plans: [{ freemius_pricing: [{ id: 'b', license_quota: 1 }, { id: 'c', license_quota: null }] }] },
      { translation_group_id: 'g', freemius_plans: [{ freemius_pricing: [{ id: 'a', license_quota: 1 }] }] },
    ]);
    expect(tiers.get('g')?.id).toBe('a');
  });
});

describe('selectPartnersShowcaseForLocale', () => {
  const catalog: PartnersShowcaseCatalog = {
    currency: 'USD',
    candidates: [
      { language: 'en', group: 'g1', product: { id: 'a-en', title: 'A', href: '/product/a', orderValueMinor: 100, monthlyMinor: null, billing: 'once' } },
      { language: 'fr', group: 'g1', product: { id: 'a-fr', title: 'A (fr)', href: '/product/a-fr', orderValueMinor: 100, monthlyMinor: null, billing: 'once' } },
      { language: 'en', group: 'g2', product: { id: 'b-en', title: 'B', href: '/product/b', orderValueMinor: 50, monthlyMinor: null, billing: 'once' } },
    ],
  };

  it('keeps one row per group, the visitor language first, else the first row', () => {
    expect(selectPartnersShowcaseForLocale(catalog, 'fr', 'USD').map((product) => product.id)).toEqual(['a-fr', 'b-en']);
    expect(selectPartnersShowcaseForLocale(catalog, 'en', 'USD').map((product) => product.id)).toEqual(['a-en', 'b-en']);
  });

  it('shows nothing for a missing catalog, or one priced in another currency than the page', () => {
    expect(selectPartnersShowcaseForLocale(null, 'en', 'USD')).toEqual([]);
    expect(selectPartnersShowcaseForLocale(catalog, 'en', 'CAD')).toEqual([]);
  });
});
