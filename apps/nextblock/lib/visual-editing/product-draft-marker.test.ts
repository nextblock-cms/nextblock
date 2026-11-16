import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The 0.23.4 product-values marker exists three times: libs/ecommerce's saveProductDraftMeta stamps its
 * own literal (a 'use server' module exports only async functions), the app reads
 * PRODUCT_DRAFT_FORM_MARKER_KEY / _VALUE (lib/visual-editing/product-draft-meta.ts), and libs/cortex
 * keeps a copy (a lib cannot import the app). This runs the lib's real autosave action and checks what
 * it stores is what the app recognises: if the two drift, every draft the form saves reads as one an
 * earlier version wrote, and the edit page and publish second-guess the editor's prices. Cortex
 * refuses to rewrite the meta of an open draft holding unmarked product values; if its copy drifted,
 * it would refuse every draft the form saves, or rewrite one the app still checks.
 */

const PRODUCT_ID = '123e4567-e89b-12d3-a456-426614174000';

const mocks = vi.hoisted(() => ({
  draftExists: true,
  writes: [] as Array<[string, string, any]>,
}));

function makeCookieClient() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'writer-1' } }, error: null }) },
    from: (table: string) => {
      let op = 'select';
      const query: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'order']) query[method] = () => query;
      for (const method of ['update', 'insert']) {
        query[method] = (values: unknown) => {
          op = method;
          mocks.writes.push([method, table, values]);
          return query;
        };
      }
      query.maybeSingle = async () => ({
        data: table === 'product_drafts' && mocks.draftExists ? { id: 7 } : null,
        error: null,
      });
      query.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(op === 'select' ? { data: [], error: null } : { error: null }).then(resolve, reject);
      return query;
    },
  };
}

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@nextblock-cms/db/server', () => ({
  createClient: () => makeCookieClient(),
  getServiceRoleSupabaseClient: vi.fn(),
}));
// Mocked by resolved file: the lib's own relative imports of these modules land here too.
vi.mock('@nextblock-cms/ecommerce/product-actions', () => ({
  createProduct: vi.fn(),
  deleteProduct: vi.fn(),
  syncCategoriesForTranslationGroup: vi.fn(),
}));
vi.mock('@nextblock-cms/ecommerce/freemius-coupons', () => ({ syncProductSaleCouponToFreemius: vi.fn() }));

import {
  CORTEX_PRODUCT_DRAFT_FORM_MARKER_KEY,
  CORTEX_PRODUCT_DRAFT_FORM_MARKER_VALUE,
  isUnmarkedProductValuesDraftMeta,
} from '@nextblock-cms/cortex';
import { updateProductAction } from '@nextblock-cms/ecommerce/pages/cms/products/server-actions';
import {
  PRODUCT_DRAFT_FORM_MARKER_KEY,
  PRODUCT_DRAFT_FORM_MARKER_VALUE,
  classifyProductDraftMeta,
  hasProductDraftFormMarker,
  withProductDraftFormMarker,
} from './product-draft-meta';
import { findPoisonedProductDraftFields } from '../../app/cms/products/productFormData';

/** Form values an editor may legitimately save: a price that happens to equal the live minor amount. */
const FORM_VALUES = {
  product_type: 'physical',
  payment_provider: 'stripe',
  title: 'Pro plugin',
  slug: 'pro-plugin',
  sku: 'PRO',
  price: 4900,
  prices: { USD: 4900 },
  sale_price: null,
  sale_prices: {},
  stock: 4,
  is_taxable: true,
  status: 'active',
  language_id: 1,
  product_media: [],
  variants: [],
};

const LIVE_PRODUCT = {
  price: 4900,
  prices: { USD: 4900 },
  product_type: 'physical',
  product_media: [{ media_id: 'media-1' }],
  product_variants: [{ id: 'variant-1' }],
};

function storedMeta() {
  const write = mocks.writes.find(([, table]) => table === 'product_drafts');
  return write?.[2]?.meta as Record<string, unknown>;
}

beforeEach(() => {
  mocks.writes = [];
  mocks.draftExists = true;
});

describe("the lib's autosave stamps the marker the app reads", () => {
  it.each([
    ['updating an existing draft', true],
    ['creating the draft', false],
  ])('when %s', async (_label, draftExists) => {
    mocks.draftExists = draftExists;

    await expect(updateProductAction(PRODUCT_ID, FORM_VALUES as any)).resolves.toEqual({ success: true });

    const meta = storedMeta();
    expect(meta[PRODUCT_DRAFT_FORM_MARKER_KEY]).toBe(PRODUCT_DRAFT_FORM_MARKER_VALUE);
    expect(hasProductDraftFormMarker(meta)).toBe(true);
    expect(classifyProductDraftMeta(meta)).toBe('product-values');
    // So publish and the edit page take the editor's values as they are.
    expect(findPoisonedProductDraftFields(meta, LIVE_PRODUCT)).toEqual([]);
    // And Cortex patches the draft's gallery when it sets the product's images.
    expect(isUnmarkedProductValuesDraftMeta(meta)).toBe(false);
  });
});

describe("Cortex's copy of the marker and of the product-values rule", () => {
  it('uses the same key and value', () => {
    expect(CORTEX_PRODUCT_DRAFT_FORM_MARKER_KEY).toBe(PRODUCT_DRAFT_FORM_MARKER_KEY);
    expect(CORTEX_PRODUCT_DRAFT_FORM_MARKER_VALUE).toBe(PRODUCT_DRAFT_FORM_MARKER_VALUE);
  });

  const values = { sku: 'PRO', price: 49, prices: { USD: 49 }, product_media: [], variants: [] };

  it.each([
    ['form values without the marker', values, true],
    ['form values the 0.23.4 form saved', withProductDraftFormMarker(values), false],
    ['a later marker value', { ...values, [PRODUCT_DRAFT_FORM_MARKER_KEY]: PRODUCT_DRAFT_FORM_MARKER_VALUE + 1 }, false],
    ['an earlier marker value', { ...values, [PRODUCT_DRAFT_FORM_MARKER_KEY]: PRODUCT_DRAFT_FORM_MARKER_VALUE - 1 }, true],
    ['a marker that is not a number', { ...values, [PRODUCT_DRAFT_FORM_MARKER_KEY]: `${PRODUCT_DRAFT_FORM_MARKER_VALUE}` }, true],
    ['only a sku', { sku: 'PRO' }, true],
    ['only a numeric price', { price: 4900 }, true],
    ['a price as text and no sku', { price: '49' }, false],
    ['the pre-0.23.4 copy of the products row', { id: PRODUCT_ID, sku: 'PRO', price: 4900, title: 'Pro plugin' }, false],
    ['an id beside a variants array', { id: PRODUCT_ID, ...values }, true],
    ['an empty overlay', {}, false],
    ['an overlay', { title: 'Pro plugin', short_description: 'Short', description_json: null }, false],
    ['no meta', null, false],
    ['an array', [values], false],
  ])('agrees with the app on %s', (_label, meta, unmarkedValues) => {
    const app = classifyProductDraftMeta(meta) === 'product-values' && !hasProductDraftFormMarker(meta);

    expect(app).toBe(unmarkedValues);
    expect(isUnmarkedProductValuesDraftMeta(meta)).toBe(app);
  });
});
