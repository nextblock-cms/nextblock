import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * loadAddonBaseProducts: the store products that sell what an add-on license requires (Commerce Pro,
 * for Affiliates), for the add-on notices of the product page, the cart and the checkout.
 */

const mocks = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; language_id: number; freemius_product_id: string }>,
  rowsError: null as { message: string } | null,
  filters: [] as Array<[string, string, unknown]>,
  getProducts: vi.fn(),
  /** What `x-user-locale` holds, and the languages row it matches. */
  locale: null as string | null,
  languageId: null as number | null,
}));

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  headers: async () => new Map(mocks.locale ? [['x-user-locale', mocks.locale]] : []),
}));
vi.mock('@nextblock-cms/db/server', () => ({
  getSsgSupabaseClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.in = (column: string, values: unknown) => {
        mocks.filters.push([table, `in:${column}`, values]);
        return chain;
      };
      chain.eq = (column: string, value: unknown) => {
        mocks.filters.push([table, `eq:${column}`, value]);
        return chain;
      };
      chain.order = () => chain;
      chain.maybeSingle = async () => ({
        data: table === 'languages' && mocks.languageId !== null ? { id: mocks.languageId } : null,
        error: null,
      });
      chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve({ data: mocks.rowsError ? null : mocks.rows, error: mocks.rowsError }).then(resolve, reject);
      return chain;
    },
  }),
}));
vi.mock('@nextblock-cms/ecommerce/product-actions', () => ({ getProducts: mocks.getProducts }));
vi.mock('../blocks/product-grid-data', () => ({
  mapProductRowToUiProduct: (row: { id: string }) => ({ ...row, mapped: true }),
}));

import { loadAddonBaseProducts, loadAddonBaseProductsForRequest } from './addon-base-products';

const COMMERCE = '24851';

beforeEach(() => {
  mocks.rows = [];
  mocks.rowsError = null;
  mocks.filters = [];
  mocks.locale = null;
  mocks.languageId = null;
  mocks.getProducts.mockReset();
  mocks.getProducts.mockImplementation(async (_supabase: unknown, options: { productIds: string[] }) => ({
    data: options.productIds.map((id) => ({ id })),
    error: null,
  }));
});

describe('loadAddonBaseProducts', () => {
  it("asks for the active products that sell a required package, and loads the page language's one", async () => {
    mocks.rows = [
      { id: 'commerce-en', language_id: 1, freemius_product_id: COMMERCE },
      { id: 'commerce-fr', language_id: 2, freemius_product_id: COMMERCE },
    ];

    await expect(loadAddonBaseProducts(2)).resolves.toEqual([{ id: 'commerce-fr', mapped: true }]);
    expect(mocks.filters).toEqual([
      ['products', 'in:freemius_product_id', [COMMERCE]],
      ['products', 'eq:status', 'active'],
    ]);
    expect(mocks.getProducts).toHaveBeenCalledWith(expect.anything(), { productIds: ['commerce-fr'], limit: 1 });
  });

  it('falls back to another language when the page language has no translation', async () => {
    mocks.rows = [{ id: 'commerce-en', language_id: 1, freemius_product_id: COMMERCE }];
    await expect(loadAddonBaseProducts(3)).resolves.toEqual([{ id: 'commerce-en', mapped: true }]);
  });

  it('answers none on a store that sells no such product, or when a read fails', async () => {
    await expect(loadAddonBaseProducts(1)).resolves.toEqual([]);
    expect(mocks.getProducts).not.toHaveBeenCalled();

    mocks.rows = [{ id: 'commerce-en', language_id: 1, freemius_product_id: COMMERCE }];
    mocks.rowsError = { message: 'connection refused' };
    await expect(loadAddonBaseProducts(4)).resolves.toEqual([]);

    mocks.rowsError = null;
    mocks.getProducts.mockResolvedValueOnce({ data: null, error: { message: 'timeout' } });
    await expect(loadAddonBaseProducts(5)).resolves.toEqual([]);
  });
});

describe('loadAddonBaseProductsForRequest (/cart, /checkout)', () => {
  it("loads the translation of the visitor's language, from proxy.ts's x-user-locale", async () => {
    mocks.rows = [
      { id: 'commerce-en', language_id: 1, freemius_product_id: COMMERCE },
      { id: 'commerce-fr', language_id: 2, freemius_product_id: COMMERCE },
    ];
    mocks.locale = 'fr';
    mocks.languageId = 2;

    await expect(loadAddonBaseProductsForRequest()).resolves.toEqual([{ id: 'commerce-fr', mapped: true }]);
    expect(mocks.filters).toContainEqual(['languages', 'eq:code', 'fr']);
  });

  it('reads any translation without the header or a matching language', async () => {
    mocks.rows = [{ id: 'commerce-en', language_id: 1, freemius_product_id: COMMERCE }];
    await expect(loadAddonBaseProductsForRequest()).resolves.toEqual([{ id: 'commerce-en', mapped: true }]);
    mocks.locale = 'de';
    await expect(loadAddonBaseProductsForRequest()).resolves.toEqual([{ id: 'commerce-en', mapped: true }]);
  });
});
