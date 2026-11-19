import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Publishing a product-values draft completes it from the live product
 * (buildProductFormValuesFromLiveProduct) before handing it to updateProduct(), and the edit page
 * lays a draft over the live form data (mergeProductDraftMetaIntoFormInitialData). Until 0.23.4
 * both took a draft as the whole product: a draft holding the raw products row (what a block edit
 * created) showed and published its cents as dollars (x100) with no variants, gallery,
 * description or sale schedule, and the first form autosave over it stored all of that as product
 * values. Those drafts carry no marker: the edit page shows the live values for their poisoned
 * fields, and publish refuses them (lib/visual-editing/product-drafts-publish.test.ts).
 */

const mocks = vi.hoisted(() => ({
  deleteMediaFiles: vi.fn(),
  syncSharedInventoryForSavedProduct: vi.fn(),
}));

vi.mock('@nextblock-cms/utils/server', () => ({ deleteMediaFiles: mocks.deleteMediaFiles }));
vi.mock('@nextblock-cms/ecommerce/shared-inventory', () => ({
  syncSharedInventoryForSavedProduct: mocks.syncSharedInventoryForSavedProduct,
}));

import { buildProductDraftPublishValues, updateProduct } from '@nextblock-cms/ecommerce/product-actions';
import { computeFreemiusSaleDiscountPercent } from '@nextblock-cms/ecommerce/freemius-pricing';
import {
  buildPoisonedProductDraftNotice,
  buildPoisonedProductDraftPublishError,
  buildProductFormInitialData,
  buildProductFormValuesFromLiveProduct,
  buildProductStockBaseline,
  buildUnreadableProductDraftNotice,
  buildUnreadableProductDraftPublishError,
  completeProductDraftValues,
  findPoisonedProductDraftFields,
  findUnreadableProductDraftValues,
  getProductDraftEditNotices,
  mergeProductDraftMetaIntoFormInitialData,
} from './productFormData';
import {
  PRODUCT_DRAFT_FORM_MARKER_KEY,
  PRODUCT_DRAFT_FORM_MARKER_VALUE,
  PRODUCT_DRAFT_LEGACY_CREATED_AT_KEY,
  PRODUCT_DRAFT_LEGACY_FIELDS_KEY,
  describeSkippedProductDraftOverlayNotice,
} from '../../../lib/visual-editing/product-draft-meta';

const PRODUCT_ID = '123e4567-e89b-12d3-a456-426614174000';
const TERM_RED = '323e4567-e89b-12d3-a456-426614174000';
const ATTR_COLOR = '423e4567-e89b-12d3-a456-426614174000';
const LANGUAGES = [{ id: 1, code: 'en', is_default: true }];
const MARKER = { [PRODUCT_DRAFT_FORM_MARKER_KEY]: PRODUCT_DRAFT_FORM_MARKER_VALUE };

/** A getProduct() row: minor units, a zero-decimal currency in the maps, one variant. */
const LIVE_PRODUCT = {
  id: PRODUCT_ID,
  title: 'Pro plugin',
  slug: 'pro-plugin',
  sku: 'PRO',
  upc: '0123456789012',
  price: 4900,
  prices: { USD: 4900, EUR: 4500, JPY: 7000 },
  sale_price: 3900,
  sale_prices: { USD: 3900 },
  sale_start_at: '2026-11-20T00:00:00+00:00',
  sale_end_at: '2026-11-30T00:00:00+00:00',
  stock: 4,
  is_taxable: true,
  product_type: 'physical',
  payment_provider: 'stripe',
  status: 'active',
  short_description: 'Short copy',
  description_json: {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Rich description' }] }],
  },
  meta_title: 'Pro plugin | Store',
  meta_description: 'The pro plugin.',
  custom_canonical: 'https://example.com/pro-plugin',
  freemius_product_id: null,
  freemius_plan_id: null,
  trial_period_days: 0,
  trial_requires_payment_method: false,
  language_id: 1,
  translation_group_id: '523e4567-e89b-12d3-a456-426614174000',
  updated_at: '2026-06-01T10:00:00+00:00',
  languages: { code: 'en' },
  product_media: [{ media_id: 'aaaaaaaa-0001-4001-8001-000000000001', sort_order: 0, media: { file_path: 'a.webp' } }],
  product_variants: [
    {
      id: 'variant-1',
      sku: 'PRO-RED',
      upc: '0123456789029',
      main_media_id: null,
      price: 4900,
      prices: { USD: 4900, EUR: 4500, JPY: 7000 },
      sale_price: 3999,
      sale_prices: { USD: 3999 },
      sale_start_at: '2026-11-21T00:00:00+00:00',
      sale_end_at: null,
      stock_quantity: 4,
      variant_attribute_mapping: [
        {
          attribute_term_id: TERM_RED,
          product_attribute_terms: {
            id: TERM_RED,
            attribute_id: ATTR_COLOR,
            value: 'Red',
            slug: 'red',
            sort_order: 0,
            value_translations: {},
            product_attributes: { id: ATTR_COLOR, name: 'Color', slug: 'color', name_translations: {} },
          },
        },
      ],
    },
  ],
};

/** The same product sold through Freemius: Freemius ids and a trial, no variants. */
const LIVE_FREEMIUS_PRODUCT = {
  ...LIVE_PRODUCT,
  product_type: 'digital',
  payment_provider: 'freemius',
  is_taxable: false,
  freemius_product_id: '12345',
  freemius_plan_id: '67890',
  trial_period_days: 14,
  trial_requires_payment_method: true,
  product_variants: [],
};

/** The draft row's created_at: after the live row's updated_at. */
const DRAFT_CREATED_AT = '2026-06-02T09:00:00.123456+00:00';

/** What getOrCreateProductDraft() stored before 0.23.4: the raw products row, cents, no variants. */
const LEGACY_ROW_SNAPSHOT = {
  id: PRODUCT_ID,
  title: 'Pro plugin',
  slug: 'pro-plugin',
  sku: 'PRO',
  upc: '0123456789012',
  price: 4900,
  prices: { USD: 4900, EUR: 4500, JPY: 7000 },
  sale_price: 3900,
  sale_prices: { USD: 3900 },
  is_taxable: true,
  product_type: 'physical',
  payment_provider: 'stripe',
  short_description: 'Short copy',
  stock: 4,
  status: 'active',
  language_id: 1,
};

/**
 * The first autosave the pre-0.23.4 edit page made over LEGACY_ROW_SNAPSHOT: the snapshot's cents as
 * dollars, no variants, no gallery, ProductForm's empty description, no id and no marker.
 */
const POISONED_AUTOSAVE = {
  product_type: 'physical',
  payment_provider: 'stripe',
  title: 'Pro plugin (renamed in the form)',
  slug: 'pro-plugin',
  sku: 'PRO',
  upc: '0123456789012',
  is_taxable: true,
  price: 4900,
  prices: { USD: 4900, EUR: 4500, JPY: 7000 },
  sale_price: 3900,
  sale_prices: { USD: 3900 },
  stock: 4,
  meta_title: 'Pro plugin | Store',
  meta_description: 'The pro plugin.',
  custom_canonical: 'https://example.com/pro-plugin',
  short_description: 'Short copy',
  description_json: { type: 'doc', content: [{ type: 'paragraph' }] },
  freemius_product_id: '',
  freemius_plan_id: '',
  trial_period_days: 0,
  trial_requires_payment_method: false,
  status: 'active',
  language_id: 1,
  translation_group_id: '523e4567-e89b-12d3-a456-426614174000',
  product_media: [],
  category_ids: [],
  variation_attributes: [],
  variants: [],
};

/** updateProduct()'s writes, with the RPC payload captured. */
function makeProductSaveClient() {
  const rpcCalls: Array<[string, any]> = [];
  const writes: Array<[string, string, any]> = [];
  const client = {
    rpc: async (name: string, args: { product_payload: unknown }) => {
      rpcCalls.push([name, args.product_payload]);
      return { data: PRODUCT_ID, error: null };
    },
    from: (table: string) => {
      let op = 'select';
      let single = false;
      const chain: Record<string, unknown> = {};
      const result = () => {
        if (op !== 'select') return { data: null, error: null };
        if (table === 'products') {
          return single
            ? { data: { id: PRODUCT_ID, sku: 'PRO', sale_price: 3900, sale_prices: { USD: 3900 } }, error: null }
            : { data: [{ id: PRODUCT_ID }], error: null };
        }
        // The gallery read and the "is this media still used" counts: the product keeps its image.
        if (table === 'product_media') return { data: [{ media_id: 'aaaaaaaa-0001-4001-8001-000000000001' }], error: null, count: 1 };
        return { data: [], error: null, count: 0 };
      };
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.in = () => chain;
      chain.single = async () => {
        single = true;
        return result();
      };
      chain.maybeSingle = chain.single;
      for (const name of ['update', 'insert', 'delete', 'upsert']) {
        chain[name] = (values: unknown) => {
          op = name;
          writes.push([name, table, values]);
          return chain;
        };
      }
      chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(result()).then(resolve, reject);
      return chain;
    },
  };
  return { client, rpcCalls, writes };
}

/** The products write persistProductSeoMeta() makes beside the RPC. */
function seoWrite(writes: Array<[string, string, any]>) {
  return writes.find(([op, table, values]) => op === 'update' && table === 'products' && 'meta_title' in values)?.[2];
}

/** The products write persistProductSaleSchedule() makes across the SKU group. */
function saleScheduleWrite(writes: Array<[string, string, any]>) {
  return writes.find(([op, table, values]) => op === 'update' && table === 'products' && 'sale_start_at' in values)?.[2];
}

/** CHECK products_sale_window_valid: (sale_start_at IS NULL) OR (sale_end_at IS NULL) OR (sale_start_at < sale_end_at). */
function satisfiesSaleWindowCheck(start: string | null, end: string | null) {
  return start === null || end === null || Date.parse(start) < Date.parse(end);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildProductFormValuesFromLiveProduct: the live product in the units updateProduct() multiplies by 100', () => {
  it('sends the live row back through the real updateProduct() unchanged: prices, variants, description, schedule, UPC and canonical', async () => {
    const { client, rpcCalls, writes } = makeProductSaveClient();

    await updateProduct(client as any, PRODUCT_ID, buildProductFormValuesFromLiveProduct(LIVE_PRODUCT, 'en') as any);

    expect(rpcCalls).toHaveLength(1);
    const [name, payload] = rpcCalls[0];
    expect(name).toBe('upsert_product_with_variants');
    expect(payload).toMatchObject({
      id: PRODUCT_ID,
      title: 'Pro plugin',
      slug: 'pro-plugin',
      sku: 'PRO',
      upc: '0123456789012',
      stock: 4,
      short_description: 'Short copy',
      description_json: LIVE_PRODUCT.description_json,
      price: 4900,
      // The zero-decimal entry included: minorUnitAmountToMajor would have sent 700000.
      prices: { USD: 4900, EUR: 4500, JPY: 7000 },
      sale_price: 3900,
      sale_prices: { USD: 3900 },
      sale_start_at: LIVE_PRODUCT.sale_start_at,
      sale_end_at: LIVE_PRODUCT.sale_end_at,
      product_type: 'physical',
      payment_provider: 'stripe',
      language_id: 1,
      translation_group_id: LIVE_PRODUCT.translation_group_id,
    });
    expect(payload.variants).toEqual([
      {
        id: 'variant-1',
        sku: 'PRO-RED',
        upc: '0123456789029',
        price: 4900,
        sale_price: 3999,
        prices: { USD: 4900, EUR: 4500, JPY: 7000 },
        sale_prices: { USD: 3999 },
        sale_start_at: '2026-11-21T00:00:00+00:00',
        sale_end_at: null,
        stock_quantity: 4,
        main_media_id: null,
        attribute_term_ids: [TERM_RED],
      },
    ]);

    // The SEO fields and the sale schedule written beside the RPC keep their live values too.
    expect(seoWrite(writes)).toMatchObject({
      meta_title: 'Pro plugin | Store',
      meta_description: 'The pro plugin.',
      custom_canonical: 'https://example.com/pro-plugin',
    });
    expect(saleScheduleWrite(writes)).toMatchObject({
      sale_start_at: LIVE_PRODUCT.sale_start_at,
      sale_end_at: LIVE_PRODUCT.sale_end_at,
    });
    // No gallery in the values: updateProduct leaves product_media and the media library alone.
    expect(writes.filter(([, table]) => table === 'product_media' || table === 'media')).toEqual([]);
    expect(mocks.deleteMediaFiles).not.toHaveBeenCalled();
  });

  it("keeps a Freemius product's ids, trial and canonical through the real updateProduct()", async () => {
    const { client, rpcCalls, writes } = makeProductSaveClient();

    await updateProduct(client as any, PRODUCT_ID, buildProductFormValuesFromLiveProduct(LIVE_FREEMIUS_PRODUCT, 'en') as any);

    expect(rpcCalls[0][1]).toMatchObject({
      product_type: 'digital',
      payment_provider: 'freemius',
      freemius_product_id: '12345',
      freemius_plan_id: '67890',
      trial_period_days: 14,
      trial_requires_payment_method: true,
      upc: '0123456789012',
      variants: [],
    });
    expect(seoWrite(writes)).toMatchObject({ custom_canonical: 'https://example.com/pro-plugin' });
  });

  it('is not the display conversion: that one keeps a zero-decimal currency as it is', () => {
    const display = buildProductFormInitialData(LIVE_PRODUCT, LANGUAGES);
    expect(display.prices).toEqual({ USD: 49, EUR: 45, JPY: 7000 });
    expect(display.price).toBe(4900);

    const values = buildProductFormValuesFromLiveProduct(LIVE_PRODUCT);
    expect(values.prices).toEqual({ USD: 49, EUR: 45, JPY: 70 });
    expect(values.price).toBe(49);
  });

  it('takes the attribute terms from the mapping rows even when a term join came back empty', () => {
    const product = {
      ...LIVE_PRODUCT,
      product_variants: [
        {
          ...LIVE_PRODUCT.product_variants[0],
          variant_attribute_mapping: [{ attribute_term_id: TERM_RED, product_attribute_terms: null }],
        },
      ],
    };

    expect(buildProductFormValuesFromLiveProduct(product).variants[0].attribute_term_ids).toEqual([TERM_RED]);
  });
});

describe('completeProductDraftValues: what publishing a product-values draft hands updateProduct()', () => {
  it('reaches the RPC with the live variants, description, schedule, UPC, canonical and Freemius fields when the draft carries only sku and price', async () => {
    const { client, rpcCalls, writes } = makeProductSaveClient();

    await updateProduct(client as any, PRODUCT_ID, completeProductDraftValues({ sku: 'PRO', price: 59 }, LIVE_PRODUCT) as any);

    const [, payload] = rpcCalls[0];
    expect(payload.price).toBe(5900);
    expect(payload.prices).toEqual({ USD: 4900, EUR: 4500, JPY: 7000 });
    expect(payload.variants).toHaveLength(1);
    expect(payload.variants[0]).toMatchObject({ sku: 'PRO-RED', upc: '0123456789029', price: 4900, attribute_term_ids: [TERM_RED] });
    expect(payload.upc).toBe('0123456789012');
    expect(payload.description_json).toEqual(LIVE_PRODUCT.description_json);
    expect(payload.sale_start_at).toBe(LIVE_PRODUCT.sale_start_at);
    expect(payload.sale_end_at).toBe(LIVE_PRODUCT.sale_end_at);
    expect(seoWrite(writes)).toMatchObject({ custom_canonical: 'https://example.com/pro-plugin' });

    const freemius = makeProductSaveClient();
    await updateProduct(
      freemius.client as any,
      PRODUCT_ID,
      completeProductDraftValues({ sku: 'PRO', price: 59 }, LIVE_FREEMIUS_PRODUCT) as any
    );
    expect(freemius.rpcCalls[0][1]).toMatchObject({
      freemius_product_id: '12345',
      freemius_plan_id: '67890',
      trial_period_days: 14,
      trial_requires_payment_method: true,
    });
    expect(seoWrite(freemius.writes)).toMatchObject({ custom_canonical: 'https://example.com/pro-plugin' });
  });

  it("keeps the draft's own values, an explicit clear (null) included", () => {
    const values = completeProductDraftValues(
      { sku: 'PRO', price: 59, variants: [], description_json: null, sale_start_at: null },
      LIVE_PRODUCT
    );

    expect(values.variants).toEqual([]);
    expect(values.description_json).toBeNull();
    // The window is one unit: a draft that clears one bound and never carried the other has no window.
    expect(values.sale_start_at).toBeNull();
    expect(values.sale_end_at).toBeNull();
  });

  it('never lets null zero the price, empty the price maps or delete the variants', () => {
    const values = completeProductDraftValues({ sku: 'PRO', price: null, prices: null, variants: null }, LIVE_PRODUCT);

    expect(values.price).toBe(49);
    expect(values.prices).toEqual({ USD: 49, EUR: 45, JPY: 70 });
    expect(values.variants).toHaveLength(1);
  });

  it('never hands updateProduct the draft marker', () => {
    const values = completeProductDraftValues({ sku: 'PRO', price: 59, ...MARKER }, LIVE_PRODUCT);

    expect(values).not.toHaveProperty(PRODUCT_DRAFT_FORM_MARKER_KEY);
  });

  // Security review 2026-11-15: any product_drafts writer, a WRITER over PostgREST included, can set
  // keys the form never shows. A top-level media_id replaced the whole gallery while the edit page
  // showed the live one, and explicitly_removed_media_ids named media for updateProduct() to delete.
  it('never hands updateProduct a top-level media_id or an explicitly removed list', () => {
    const values = completeProductDraftValues(
      {
        sku: 'PRO',
        ...MARKER,
        media_id: 'decoy-media',
        explicitly_removed_media_ids: ['aaaaaaaa-0001-4001-8001-000000000001', 'other-uploader-media'],
      },
      LIVE_PRODUCT
    );

    expect(values).not.toHaveProperty('media_id');
    expect(values).not.toHaveProperty('explicitly_removed_media_ids');
    // No gallery in the draft: updateProduct() leaves the live one as it is.
    expect(values).not.toHaveProperty('product_media');
  });

  it('keeps the gallery a draft carries, which the edit page shows', () => {
    const values = completeProductDraftValues({ sku: 'PRO', ...MARKER, product_media: [{ media_id: 'aaaaaaaa-0002-4002-8002-000000000002' }] }, LIVE_PRODUCT);

    expect(values.product_media).toEqual([{ media_id: 'aaaaaaaa-0002-4002-8002-000000000002' }]);
  });
});

describe('completeProductDraftValues takes the product-level sale window as one unit', () => {
  it.each([
    ['neither bound: both live', {}, LIVE_PRODUCT.sale_start_at, LIVE_PRODUCT.sale_end_at],
    ['a start only: that start and an open end', { sale_start_at: '2026-12-05T00:00:00.000Z' }, '2026-12-05T00:00:00.000Z', null],
    ['an end only: an open start and that end', { sale_end_at: '2026-12-24T00:00:00.000Z' }, null, '2026-12-24T00:00:00.000Z'],
    [
      'both bounds: the pair the form validated',
      { sale_start_at: '2026-12-01T00:00:00.000Z', sale_end_at: '2026-12-24T00:00:00.000Z' },
      '2026-12-01T00:00:00.000Z',
      '2026-12-24T00:00:00.000Z',
    ],
    ['both cleared: no window', { sale_start_at: null, sale_end_at: null }, null, null],
  ])('%s', (_label, window, start, end) => {
    const values = completeProductDraftValues({ sku: 'PRO', price: 49, ...window }, LIVE_PRODUCT);

    expect(values.sale_start_at).toBe(start);
    expect(values.sale_end_at).toBe(end);
  });

  it('publishes a new start after the hidden live end as an open-ended window: the RPC and the SKU-group write pass the CHECK', async () => {
    // What a pre-0.23.4 form autosaved when the editor typed a new start only: the form never showed
    // the live window (Nov 20 to Nov 30). Merged key by key, the payload ran Dec 5 to Nov 30.
    const autosave = { ...POISONED_AUTOSAVE, price: 49, prices: { USD: 49 }, sale_price: 39, sale_prices: { USD: 39 }, sale_start_at: '2026-12-05T00:00:00.000Z' };
    const { client, rpcCalls, writes } = makeProductSaveClient();

    await updateProduct(client as any, PRODUCT_ID, completeProductDraftValues(autosave, LIVE_PRODUCT) as any);

    const [, payload] = rpcCalls[0];
    expect([payload.sale_start_at, payload.sale_end_at]).toEqual(['2026-12-05T00:00:00.000Z', null]);
    expect(satisfiesSaleWindowCheck(payload.sale_start_at, payload.sale_end_at)).toBe(true);
    const schedule = saleScheduleWrite(writes);
    expect([schedule.sale_start_at, schedule.sale_end_at]).toEqual(['2026-12-05T00:00:00.000Z', null]);
  });

  it('never publishes an expired live window with a sale price the draft set without one', () => {
    const live = { ...LIVE_PRODUCT, sale_start_at: '2025-11-28T00:00:00+00:00', sale_end_at: '2025-12-01T00:00:00+00:00' };

    // A draft that carries no window keeps the live pair as it is (nothing new is combined with it)...
    expect(completeProductDraftValues({ sku: 'PRO', price: 20, sale_price: 12 }, live)).toMatchObject({
      sale_start_at: live.sale_start_at,
      sale_end_at: live.sale_end_at,
    });
    // ...and the 0.23.4 form always sends the window it showed, so clearing it in the editor clears it.
    expect(
      completeProductDraftValues({ sku: 'PRO', price: 20, sale_price: 12, sale_start_at: null, sale_end_at: null }, live)
    ).toMatchObject({ sale_start_at: null, sale_end_at: null });
  });
});

describe('findPoisonedProductDraftFields: a product-values draft an earlier version saved over a row snapshot', () => {
  it('finds every field the old edit page poisoned', () => {
    expect(findPoisonedProductDraftFields(POISONED_AUTOSAVE, LIVE_PRODUCT)).toEqual([
      'prices',
      'sale_prices',
      'variants',
      'product_media',
      'description_json',
    ]);
  });

  it('finds none in a marked draft: a 0.23.4 editor may set any price', () => {
    expect(findPoisonedProductDraftFields({ ...POISONED_AUTOSAVE, ...MARKER }, LIVE_PRODUCT)).toEqual([]);
  });

  it('finds none in an overlay or a legacy snapshot (they never reach updateProduct)', () => {
    expect(findPoisonedProductDraftFields({ title: 'New title' }, LIVE_PRODUCT)).toEqual([]);
    expect(findPoisonedProductDraftFields(LEGACY_ROW_SNAPSHOT, LIVE_PRODUCT)).toEqual([]);
  });

  it('finds none in an unmarked draft the old editor saved over the live data (major units, the live description)', () => {
    // buildProductFormInitialData's display maps: USD/EUR divided by 100, JPY as it is.
    const legitimate = {
      ...POISONED_AUTOSAVE,
      price: 49,
      prices: { USD: 49, EUR: 45, JPY: 7000 },
      sale_price: 39,
      sale_prices: { USD: 39 },
      description_json: LIVE_PRODUCT.description_json,
      product_media: [{ media_id: 'aaaaaaaa-0001-4001-8001-000000000001' }],
      variation_attributes: [{ attribute_id: ATTR_COLOR, term_ids: [TERM_RED] }],
      variants: [{ sku: 'PRO-RED', price: 49 }],
    };

    expect(findPoisonedProductDraftFields(legitimate, LIVE_PRODUCT)).toEqual([]);
  });

  it('ignores a zero-decimal currency, which the edit page shows unscaled anyway', () => {
    expect(
      findPoisonedProductDraftFields(
        { sku: 'PRO', price: 49, prices: { USD: 49, JPY: 7000 }, variation_attributes: [] },
        LIVE_PRODUCT
      )
    ).toEqual([]);
  });

  it("does not flag a digital product's empty variant list: its form always sends []", () => {
    expect(
      findPoisonedProductDraftFields(
        { sku: 'PRO', price: 49, product_type: 'digital', variants: [], variation_attributes: [] },
        { ...LIVE_PRODUCT, product_type: 'digital' }
      )
    ).toEqual([]);
  });

  it('flags an empty description only over a live one with content', () => {
    const emptyDoc = { type: 'doc', content: [{ type: 'paragraph' }] };
    const draft = { sku: 'PRO', price: 49, description_json: emptyDoc, variation_attributes: [] };
    expect(findPoisonedProductDraftFields(draft, { ...LIVE_PRODUCT, description_json: null })).toEqual([]);
    expect(
      findPoisonedProductDraftFields(draft, {
        ...LIVE_PRODUCT,
        description_json: { type: 'doc', content: [{ type: 'image', attrs: { src: '/a.webp' } }] },
      })
    ).toEqual(['description_json']);
  });
});

describe('mergeProductDraftMetaIntoFormInitialData: the edit page with a draft open', () => {
  const live = {
    ...buildProductFormInitialData(LIVE_PRODUCT, LANGUAGES),
    category_ids: ['623e4567-e89b-12d3-a456-426614174000'],
  };
  const options = { productId: PRODUCT_ID, liveProduct: LIVE_PRODUCT, draftCreatedAt: DRAFT_CREATED_AT };

  it('shows a pre-0.23.4 row snapshot as the live data with its overlay fields, never its cents as dollars', () => {
    const merged = mergeProductDraftMetaIntoFormInitialData(live, { ...LEGACY_ROW_SNAPSHOT, title: 'Renamed in page' }, options);

    // ProductForm divides price by 100: the live 4900 cents, not the old 4900 * 100.
    expect(merged.price).toBe(4900);
    expect(merged.prices).toEqual(live.prices);
    expect(merged.variants).toEqual(live.variants);
    expect(merged.variants).toHaveLength(1);
    expect(merged.product_media).toEqual(LIVE_PRODUCT.product_media);
    expect(merged.sale_start_at).toBe(LIVE_PRODUCT.sale_start_at);
    expect(merged.description_json).toEqual(LIVE_PRODUCT.description_json);
    expect(merged.category_ids).toEqual(live.category_ids);
    expect(merged.title).toBe('Renamed in page');
    expect(getProductDraftEditNotices({ ...LEGACY_ROW_SNAPSHOT, title: 'Renamed in page' }, LIVE_PRODUCT, DRAFT_CREATED_AT)).toEqual([]);
  });

  it('shows the live title of a row snapshot whose product changed after the draft was created, and says publish will skip it', () => {
    const changedLive = { ...LIVE_PRODUCT, title: 'Pro plugin, rewritten', updated_at: '2026-10-15T08:00:00+00:00' };
    const changed = { ...buildProductFormInitialData(changedLive, LANGUAGES), category_ids: [] };

    const merged = mergeProductDraftMetaIntoFormInitialData(changed, LEGACY_ROW_SNAPSHOT, {
      ...options,
      liveProduct: changedLive,
    });

    expect(merged.title).toBe('Pro plugin, rewritten');
    expect(getProductDraftEditNotices(LEGACY_ROW_SNAPSHOT, changedLive, DRAFT_CREATED_AT)).toEqual([
      describeSkippedProductDraftOverlayNotice(['title']),
    ]);
  });

  it('says publish will skip the snapshot title an overlay rewritten from a row snapshot recorded, once the product changed after the snapshot', () => {
    // An in-page short description save rewrote a June snapshot as an overlay, keeping (and recording)
    // its title; the product changed afterwards.
    const converted = {
      title: 'Pro plugin - Basic',
      short_description: 'New short copy',
      [PRODUCT_DRAFT_LEGACY_FIELDS_KEY]: ['title'],
      [PRODUCT_DRAFT_LEGACY_CREATED_AT_KEY]: '2026-06-02T09:00:00+00:00',
    };
    const changedLive = { ...LIVE_PRODUCT, updated_at: '2026-11-14T12:00:00+00:00' };
    const changed = { ...buildProductFormInitialData(changedLive, LANGUAGES), category_ids: [] };

    expect(getProductDraftEditNotices(converted, changedLive, '2026-06-02T09:00:00+00:00')).toEqual([
      describeSkippedProductDraftOverlayNotice(['title']),
    ]);
    const merged = mergeProductDraftMetaIntoFormInitialData(changed, converted, { ...options, liveProduct: changedLive });
    expect([merged.title, merged.short_description]).toEqual(['Pro plugin', 'New short copy']);

    // While the product is unchanged since the snapshot, the recorded title publishes: no note.
    expect(getProductDraftEditNotices(converted, LIVE_PRODUCT, '2026-06-02T09:00:00+00:00')).toEqual([]);
  });

  it('shows a block-seeded draft (meta {}) as the live data, and applies in-page edits only', () => {
    expect(mergeProductDraftMetaIntoFormInitialData(live, {}, options)).toEqual(live);

    const staged = { type: 'doc', content: [] };
    expect(
      mergeProductDraftMetaIntoFormInitialData(live, { short_description: 'Edited', description_json: staged }, options)
    ).toEqual({ ...live, short_description: 'Edited', description_json: staged });
  });

  it('merges product values over the live data: a key the draft lacks keeps its live value', () => {
    const merged = mergeProductDraftMetaIntoFormInitialData(
      live,
      { sku: 'PRO', price: 59, sale_price: 39.5, prices: { USD: 59 } },
      options
    );

    // Major units back to the cents ProductForm reads.
    expect(merged.price).toBe(5900);
    expect(merged.sale_price).toBe(3950);
    expect(merged.prices).toEqual({ USD: 59 });
    expect(merged.variants).toEqual(live.variants);
    expect(merged.description_json).toEqual(LIVE_PRODUCT.description_json);
    expect(merged.product_media).toEqual(LIVE_PRODUCT.product_media);
    expect(merged.category_ids).toEqual(live.category_ids);
  });

  it('shows a form autosave as before: its gallery (hydrated), categories, variants and cleared sale price, never the marker', () => {
    const hydrated = [{ media_id: 'aaaaaaaa-0002-4002-8002-000000000002', sort_order: 0, media: { file_path: 'b.webp' } }];
    const merged = mergeProductDraftMetaIntoFormInitialData(
      live,
      {
        sku: 'PRO',
        price: 59,
        sale_price: null,
        variants: [],
        product_media: [{ media_id: 'aaaaaaaa-0002-4002-8002-000000000002' }],
        category_ids: [],
        ...MARKER,
      },
      { ...options, hydratedProductMedia: hydrated }
    );

    expect(merged.id).toBe(PRODUCT_ID);
    expect(merged.sale_price).toBeNull();
    expect(merged.variants).toEqual([]);
    expect(merged.product_media).toEqual(hydrated);
    expect(merged.category_ids).toEqual([]);
    expect(merged).not.toHaveProperty(PRODUCT_DRAFT_FORM_MARKER_KEY);
  });

  it('pairs variants with attributes from the same source: a draft with its own variants never gets the live attributes', () => {
    expect(live.variation_attributes).toEqual([{ attribute_id: ATTR_COLOR, term_ids: [TERM_RED] }]);

    // A CMS draft import: its own variants, no variation_attributes. They come from its variants'
    // terms (none here), never from the live variants.
    const imported = mergeProductDraftMetaIntoFormInitialData(
      live,
      { sku: 'PRO', price: 59, variants: [{ sku: 'PRO-BLUE', price: 59, attribute_term_ids: [] }], ...MARKER },
      options
    );
    expect(imported.variation_attributes).toEqual([]);

    // No variants in the draft: the live variants and their attributes stay together.
    const partial = mergeProductDraftMetaIntoFormInitialData(live, { sku: 'PRO', price: 59 }, options);
    expect(partial.variation_attributes).toEqual(live.variation_attributes);
  });

  it('keeps the live price and variants when product values carry null for them', () => {
    const merged = mergeProductDraftMetaIntoFormInitialData(live, { sku: 'PRO', price: null, variants: null }, options);

    expect(merged.price).toBe(4900);
    expect(merged.variants).toEqual(live.variants);
  });
});

/**
 * The stock the form loaded (`stock_baseline`): publishing leaves a SKU's stock alone where the draft's
 * quantity equals it or the current stock, and otherwise applies the difference to the current stock
 * (migration 02044), so a sale made while the page was open keeps its deduction. The edit page records
 * it; with a draft open it shows, SKU by SKU, what publishing the draft as it stands would write, over
 * the live stock as the baseline; publish sends it only with the draft's own quantities.
 */
describe('the stock baseline: the stock the form loaded, so publishing writes only what the editor changed', () => {
  const live = { ...buildProductFormInitialData(LIVE_PRODUCT, LANGUAGES), category_ids: [] };
  const liveWithBaseline = { ...live, stock_baseline: buildProductStockBaseline(live) };
  const options = { productId: PRODUCT_ID, liveProduct: LIVE_PRODUCT, draftCreatedAt: DRAFT_CREATED_AT };
  /** A form autosave (marked) with the live variant at `quantity` and the given baseline. */
  const autosave = (quantity: unknown, baseline?: Record<string, number>, sku = 'PRO-RED') => ({
    ...MARKER,
    sku: 'PRO',
    price: 49,
    stock: 6,
    variants: [{ ...live.variants[0], sku, stock_quantity: quantity }],
    ...(baseline ? { stock_baseline: baseline } : {}),
  });

  /** LIVE_PRODUCT with its variant at `stock` (a getProduct() row), and the edit page's live data for it. */
  const liveAt = (stock: number) => {
    const liveProduct = {
      ...LIVE_PRODUCT,
      stock,
      product_variants: [{ ...LIVE_PRODUCT.product_variants[0], stock_quantity: stock }],
    };
    const data = { ...buildProductFormInitialData(liveProduct, LANGUAGES), category_ids: [] };
    return { liveProduct, initialData: { ...data, stock_baseline: buildProductStockBaseline(data) } };
  };

  /** LIVE_PRODUCT with one variant per [SKU, stock], each on its own Color term, and the edit page's live data for it. */
  const liveWithVariants = (stocks: Array<[string, number]>) => {
    const [base] = LIVE_PRODUCT.product_variants;
    const [mapping] = base.variant_attribute_mapping;
    const liveProduct = {
      ...LIVE_PRODUCT,
      stock: stocks.reduce((total, [, stock]) => total + stock, 0),
      product_variants: stocks.map(([sku, stock], index) => {
        const termId = `a${String(index).padStart(7, '0')}-e89b-12d3-a456-426614174000`;
        return {
          ...base,
          id: `variant-${index + 1}`,
          sku,
          stock_quantity: stock,
          variant_attribute_mapping: [
            {
              attribute_term_id: termId,
              product_attribute_terms: { ...mapping.product_attribute_terms, id: termId, value: sku, slug: sku.toLowerCase() },
            },
          ],
        };
      }),
    };
    const data = { ...buildProductFormInitialData(liveProduct, LANGUAGES), category_ids: [] };
    return { liveProduct, initialData: { ...data, stock_baseline: buildProductStockBaseline(data) } };
  };

  /** A form autosave (marked) of `initialData`'s variants at `quantities`, beside `baseline`. */
  const autosaveOf = (initialData: { variants: Array<Record<string, unknown>> }, quantities: unknown[], baseline?: Record<string, number>) => ({
    ...MARKER,
    sku: 'PRO',
    price: 49,
    variants: initialData.variants.map((variant, index) => ({ ...variant, stock_quantity: quantities[index] })),
    ...(baseline ? { stock_baseline: baseline } : {}),
  });

  /**
   * What publish_product_draft (migration 02044) writes for one SKU: the current stock where the
   * draft's quantity equals its baseline or the current stock, otherwise the difference applied to the
   * current stock, never below 0; the draft's quantity without a baseline.
   * tools/scripts/product-draft-publish.db.test.ts runs the function itself.
   */
  const publishedStock = (entered: number, loaded: number | undefined, current: number) =>
    loaded === undefined
      ? entered
      : entered === loaded || entered === current
        ? current
        : Math.max(0, current + entered - loaded);

  /** What publishing `draft` over `liveProduct` writes for PRO-RED, the live stock still `current`. */
  const publishPro = (draft: Record<string, unknown>, liveProduct: unknown, current: number) => {
    const values = buildProductDraftPublishValues(completeProductDraftValues(draft, liveProduct) as any);
    const { variants } = values as unknown as { variants: Array<{ stock_quantity: number }> };
    return publishedStock(variants[0].stock_quantity, values.stock_baseline?.['PRO-RED'], current);
  };

  it("is each variant's stock, or the product's without variants, keyed as the inventory rows are", () => {
    expect(buildProductStockBaseline(live)).toEqual({ 'PRO-RED': 4 });
    expect(buildProductStockBaseline({ sku: ' PRO ', stock: 7, variants: [] })).toEqual({ PRO: 7 });
    // Only whole quantities from 0 up, and only SKUs that are not blank.
    expect(
      buildProductStockBaseline({
        sku: 'PRO',
        stock: 7,
        variants: [
          { sku: 'A', stock_quantity: 2 },
          { sku: '  ', stock_quantity: 5 },
          { sku: 'B', stock_quantity: 1.5 },
          { sku: 'C', stock_quantity: -1 },
          { sku: 'D', stock_quantity: 0 },
        ],
      })
    ).toEqual({ A: 2, D: 0 });
    // Of variants sharing a SKU the last one counts, as it does in the publish.
    expect(buildProductStockBaseline({ variants: [{ sku: 'A', stock_quantity: 2 }, { sku: 'A', stock_quantity: 3 }] })).toEqual({ A: 3 });
    expect(buildProductStockBaseline({ variants: [{ sku: 'A', stock_quantity: 2 }, { sku: 'A', stock_quantity: null }] })).toEqual({});
  });

  it('with a draft open, shows the live stock for a quantity the editor did not change, and records it as the baseline', () => {
    // Loaded 6 and autosaved unchanged with an unrelated edit; two sold since (live 4).
    const merged = mergeProductDraftMetaIntoFormInitialData(liveWithBaseline, autosave(6, { 'PRO-RED': 6 }), options);

    expect(merged.variants[0].stock_quantity).toBe(4);
    expect(merged.stock_baseline).toEqual({ 'PRO-RED': 4 });
    // The read-only total beside the variants follows the quantities shown.
    expect(merged.stock).toBe(4);
  });

  it.each([
    // [case, live stock, draft quantity, draft baseline, shown]
    ['a draft started again after a publish, holding the stock that publish made live', 10, 10, 5, 10],
    ['a baseline nobody loaded beside the live stock (a WRITER over PostgREST)', 4, 4, 1004, 4],
    ['a baseline nobody loaded beside another figure: the change it makes shows', 4, 5, 1004, 0],
    ['a change from an earlier load, after a sale: the change applied to the live stock', 4, 10, 5, 9],
    ['loaded 6, typed 16, two sold since', 4, 16, 6, 14],
  ])('%s: shows what publishing writes, over the live stock as the baseline', (_case, liveStock, quantity, baseline, shown) => {
    const { liveProduct, initialData } = liveAt(liveStock);
    // The draft's read-only total as the form saved it beside the variant.
    const draft = { ...autosave(quantity, { 'PRO-RED': baseline }), stock: quantity };

    const merged = mergeProductDraftMetaIntoFormInitialData(initialData, draft, { ...options, liveProduct });

    expect(merged.variants[0].stock_quantity).toBe(shown);
    expect(merged.stock_baseline).toEqual({ 'PRO-RED': liveStock });
    // The read-only total beside the variants follows the quantities shown.
    expect(merged.stock).toBe(shown);
    // Published as it stands (no autosave since the page load), the draft writes what the page showed;
    // so does the autosave of what the page showed, after an edit to any other field.
    expect(publishPro(draft, liveProduct, liveStock)).toBe(shown);
    expect(publishPro({ ...draft, variants: merged.variants, stock_baseline: merged.stock_baseline }, liveProduct, liveStock)).toBe(
      shown
    );
  });

  it('takes a figure typed over the page as absolute from its load, whatever baseline the draft held', () => {
    // A WRITER's draft: the live quantity beside a baseline of their choosing. The page shows 4, as live.
    const draft = autosave(4, { 'PRO-RED': 1004 });
    const merged = mergeProductDraftMetaIntoFormInitialData(liveWithBaseline, draft, options);
    expect(merged.variants[0].stock_quantity).toBe(4);

    // The ADMIN types 50: the autosave stores the form values, the baseline the page recorded included.
    const typed = { ...draft, variants: [{ ...merged.variants[0], stock_quantity: 50 }], stock_baseline: merged.stock_baseline };

    expect(typed.stock_baseline).toEqual({ 'PRO-RED': 4 });
    expect(publishPro(typed, LIVE_PRODUCT, 4)).toBe(50);
  });

  it('reads the draft quantity as publish does: a number in text, the whole part of a fraction, a missing one as 0', () => {
    // Each beside a baseline nobody loaded, over the live 4: publish reads 5, so 4 + 5 - 1004, never below 0.
    for (const quantity of ['5', ' 5 ', 5.9]) {
      const merged = mergeProductDraftMetaIntoFormInitialData(liveWithBaseline, autosave(quantity, { 'PRO-RED': 1004 }), options);
      expect([quantity, merged.variants[0].stock_quantity, merged.stock_baseline]).toEqual([quantity, 0, { 'PRO-RED': 4 }]);
    }

    // Missing, read as 0: equal to the baseline 0, so left alone.
    const missing = { ...autosave(0, { 'PRO-RED': 0 }) };
    delete (missing.variants[0] as { stock_quantity?: unknown }).stock_quantity;
    expect(mergeProductDraftMetaIntoFormInitialData(liveWithBaseline, missing, options).variants[0].stock_quantity).toBe(4);

    // One publish cannot read (it refuses the draft) shows the live stock, over the live stock as the
    // baseline, so the next autosave saves what the page shows (the cases: the test below).
    const unreadable = mergeProductDraftMetaIntoFormInitialData(liveWithBaseline, autosave(true, { 'PRO-RED': 1004 }), options);
    expect([unreadable.variants[0].stock_quantity, unreadable.stock_baseline]).toEqual([4, { 'PRO-RED': 4 }]);
  });

  // Review 2026-11-18 (X1): the text "NaN" or "Infinity", which the page could not read, published as
  // 2147483647 (Postgres reads both as numeric), and a JSON 1e400 (Infinity here) showed 2147483647 and
  // went out as null, read as 0. The form's z.coerce.number() turned true into 1 on the next autosave of
  // any field, a figure the page never showed. Publish now refuses the draft, and the page shows the live
  // stock in its place, which the next autosave saves.
  it.each([
    ['true', true],
    ['false', false],
    ['an empty list', []],
    ['an object', {}],
    ['the text "NaN"', 'NaN'],
    ['the text "Infinity"', 'Infinity'],
    ['the text "0x10" (hex, which PostgreSQL 16 reads)', '0x10'],
    ['the text "1_000"', '1_000'],
    ['a JSON 1e400 (Infinity once parsed)', JSON.parse('{"q":1e400}').q],
    ['the text "1e400"', '1e400'],
    ['-Infinity', -Infinity],
  ])('shows the live stock for a quantity publish cannot read (%s), and publish refuses the draft naming the SKU', (_label, quantity) => {
    const draft = autosave(quantity, { 'PRO-RED': 4 });

    const merged = mergeProductDraftMetaIntoFormInitialData(liveWithBaseline, draft, options);
    expect([merged.variants[0].stock_quantity, merged.stock, merged.stock_baseline]).toEqual([4, 4, { 'PRO-RED': 4 }]);

    const unreadable = findUnreadableProductDraftValues(draft, LIVE_PRODUCT);
    expect(unreadable).toEqual([{ kind: 'stock', label: 'the stock of PRO-RED' }]);
    expect(getProductDraftEditNotices(draft, LIVE_PRODUCT, DRAFT_CREATED_AT)).toEqual([buildUnreadableProductDraftNotice(unreadable)]);
    expect(buildUnreadableProductDraftNotice(unreadable)).toBe(
      'Publishing cannot read the stock of PRO-RED in this draft (the form saves a stock as a number and a SKU as text; a hand-written draft can hold anything there). The form shows the live stock in place of a stock it cannot read (0 for a SKU the live product does not stock). Save a change (or discard the draft), then publish (or ask an administrator to).'
    );
    expect(buildUnreadableProductDraftPublishError(unreadable)).toBe(
      'Not published. Publishing cannot read the stock of PRO-RED in this draft (the form saves a stock as a number and a SKU as text; a hand-written draft can hold anything there). Open the product in the CMS editor, which shows the live stock in place of a stock it cannot read, save a change (or discard the draft), then publish.'
    );

    // The next autosave stores what the page shows: readable, and published as shown.
    const saved = { ...draft, variants: merged.variants, stock: merged.stock, stock_baseline: merged.stock_baseline };
    expect(findUnreadableProductDraftValues(saved, LIVE_PRODUCT)).toEqual([]);
    expect(publishPro(saved, LIVE_PRODUCT, 4)).toBe(4);
  });

  it("refuses the product's own stock publish cannot read when the values publish no variants, and shows the live one", () => {
    const simpleLive = { ...LIVE_PRODUCT, stock: 5, product_variants: [] };
    const simple = { ...buildProductFormInitialData(simpleLive, LANGUAGES), category_ids: [] };
    const draft = { ...MARKER, sku: 'PRO', price: 49, stock: 'NaN', variants: [], stock_baseline: { PRO: 5 } };

    const merged = mergeProductDraftMetaIntoFormInitialData(
      { ...simple, stock_baseline: buildProductStockBaseline(simple) },
      draft,
      { ...options, liveProduct: simpleLive }
    );
    expect([merged.stock, merged.stock_baseline]).toEqual([5, { PRO: 5 }]);
    expect(findUnreadableProductDraftValues(draft, simpleLive)).toEqual([{ kind: 'stock', label: 'the stock of PRO' }]);

    // Beside variants the function writes their total, never the product's stock: nothing to refuse,
    // and the read-only box beside them shows that total.
    const besideVariants = { ...autosave(4, { 'PRO-RED': 4 }), stock: 'NaN' };
    expect(findUnreadableProductDraftValues(besideVariants, LIVE_PRODUCT)).toEqual([]);
    expect(mergeProductDraftMetaIntoFormInitialData(liveWithBaseline, besideVariants, options).stock).toBe(4);
    expect(completeProductDraftValues(besideVariants, LIVE_PRODUCT).stock).toBe(4);
  });

  it('publish sends each quantity as the whole number the page reads it as, never text, a fraction or a figure past the limits', () => {
    for (const [quantity, read] of [
      ['5', 5],
      [' 5 ', 5],
      ['5.9', 5],
      [5.9, 5],
      ['1e3', 1000],
      [-3, 0],
      [1e300, 2147483647],
      [null, 0],
    ] as const) {
      // A quantity in no baseline, so publish writes it as it stands and the page shows it as read.
      const draft = autosave(quantity, { 'PRO-BLUE': 1 });
      const values = buildProductDraftPublishValues(completeProductDraftValues(draft, LIVE_PRODUCT) as any);
      const { variants, stock } = values as unknown as { variants: Array<{ stock_quantity: unknown }>; stock: unknown };
      expect([quantity, variants[0].stock_quantity, stock]).toEqual([quantity, read, read]);
      expect(mergeProductDraftMetaIntoFormInitialData(liveWithBaseline, draft, options).variants[0].stock_quantity).toBe(read);
      expect(findUnreadableProductDraftValues(draft, LIVE_PRODUCT)).toEqual([]);
    }

    // Without variants, the product's stock.
    const simpleLive = { ...LIVE_PRODUCT, stock: 5, product_variants: [] };
    const values = buildProductDraftPublishValues(
      completeProductDraftValues({ ...MARKER, sku: 'PRO', price: 49, stock: ' 12.7 ', variants: [] }, simpleLive) as any
    );
    expect((values as unknown as { stock: unknown }).stock).toBe(12);
  });

  it("keeps a SKU the draft's baseline lacks, or the live product does not stock, as the draft holds it with no baseline, and an earlier version's draft over the live stock", () => {
    // A variant renamed in the draft: publish writes it as it stands.
    const renamed = mergeProductDraftMetaIntoFormInitialData(liveWithBaseline, autosave(3, { 'PRO-RED': 4 }, 'PRO-RENAMED'), options);
    expect(renamed.variants[0].stock_quantity).toBe(3);
    expect(renamed.stock_baseline).toEqual({});

    // A SKU the live product does not stock, with an entry in the draft's baseline: shown as the draft
    // holds it, with no baseline. Publish sends no entry for it, so it writes the draft's figure too.
    const added = mergeProductDraftMetaIntoFormInitialData(liveWithBaseline, autosave(5, { 'PRO-NEW': 2 }, 'PRO-NEW'), options);
    expect(added.variants[0].stock_quantity).toBe(5);
    expect(added.stock_baseline).toEqual({});
    expect(completeProductDraftValues(autosave(5, { 'PRO-NEW': 2 }, 'PRO-NEW'), LIVE_PRODUCT).stock_baseline).toEqual({});

    // No baseline in the draft (saved by an earlier version): whether 9 was typed cannot be told, so it
    // stays, over the live 4: publish writes it as it always did.
    const old = mergeProductDraftMetaIntoFormInitialData(liveWithBaseline, autosave(9), options);
    expect(old.variants[0].stock_quantity).toBe(9);
    expect(old.stock_baseline).toEqual({ 'PRO-RED': 4 });
  });

  it('decides the same for a product without variants', () => {
    const simpleLive = { ...LIVE_PRODUCT, stock: 5, product_variants: [] };
    const simple = { ...buildProductFormInitialData(simpleLive, LANGUAGES), category_ids: [] };
    const simpleWithBaseline = { ...simple, stock_baseline: buildProductStockBaseline(simple) };
    const simpleOptions = { ...options, liveProduct: simpleLive };
    expect(simpleWithBaseline.stock_baseline).toEqual({ PRO: 5 });

    const unchanged = mergeProductDraftMetaIntoFormInitialData(
      simpleWithBaseline,
      { ...MARKER, sku: 'PRO', price: 49, stock: 7, variants: [], stock_baseline: { PRO: 7 } },
      simpleOptions
    );
    expect([unchanged.stock, unchanged.stock_baseline]).toEqual([5, { PRO: 5 }]);

    // Loaded 7, typed 12, two sold since: the change applied to the live 5.
    const changed = mergeProductDraftMetaIntoFormInitialData(
      simpleWithBaseline,
      { ...MARKER, sku: 'PRO', price: 49, stock: 12, variants: [], stock_baseline: { PRO: 7 } },
      simpleOptions
    );
    expect([changed.stock, changed.stock_baseline]).toEqual([10, { PRO: 5 }]);

    // Already live (a draft started again after the publish that wrote 5): left alone.
    const alreadyLive = mergeProductDraftMetaIntoFormInitialData(
      simpleWithBaseline,
      { ...MARKER, sku: 'PRO', price: 49, stock: 5, variants: [], stock_baseline: { PRO: 2 } },
      simpleOptions
    );
    expect([alreadyLive.stock, alreadyLive.stock_baseline]).toEqual([5, { PRO: 5 }]);
  });

  it("publish sends the draft's baseline with the draft's own quantities", () => {
    const values = completeProductDraftValues(autosave(16, { 'PRO-RED': 6 }), LIVE_PRODUCT);

    expect(values.variants[0].stock_quantity).toBe(16);
    expect(values.stock_baseline).toEqual({ 'PRO-RED': 6 });
  });

  it("publish never sets the draft's baseline against a quantity it takes from live, and sends none without one", () => {
    // No variants in the draft: the live variants publish with their live stock, as unchanged. Against
    // the draft's 6 their 4 would read as an edit of -2 and take a sale off twice.
    const values = completeProductDraftValues({ ...MARKER, sku: 'PRO', price: 49, stock_baseline: { 'PRO-RED': 6 } }, LIVE_PRODUCT);
    expect(values.variants[0].stock_quantity).toBe(4);
    expect(values.stock_baseline).toEqual({ 'PRO-RED': 4 });

    expect(completeProductDraftValues(autosave(4), LIVE_PRODUCT)).not.toHaveProperty('stock_baseline');
    expect(completeProductDraftValues({ ...autosave(4), stock_baseline: 'PRO-RED' }, LIVE_PRODUCT)).not.toHaveProperty(
      'stock_baseline'
    );
  });

  // Review 2026-11-18 (writer-skew bypass b): the function reads a SKU's current stock from
  // inventory_items, shared by SKU across products. A draft variant with another product's SKU and a
  // baseline entry for it showed 51 on this page while publish applied 51 - 1051 to that product's 50 and
  // wrote 0 to its row.
  it('sends no baseline entry for a SKU the live product does not stock: the page and publish both write the draft figure', () => {
    const otherSkuVariant = {
      combination_key: 'b23e4567-e89b-12d3-a456-426614174000',
      sku: 'OTHER-1',
      price: 49,
      prices: { USD: 49 },
      stock_quantity: 51,
      attribute_term_ids: ['b23e4567-e89b-12d3-a456-426614174000'],
      selected_options: [],
      label: 'Blue',
    };
    const draft = {
      ...autosave(4, { 'PRO-RED': 4, 'OTHER-1': 1051 }),
      variants: [{ ...live.variants[0], stock_quantity: 4 }, otherSkuVariant],
    };

    const merged = mergeProductDraftMetaIntoFormInitialData(liveWithBaseline, draft, options);
    expect(merged.variants.map((variant: { stock_quantity: unknown }) => variant.stock_quantity)).toEqual([4, 51]);
    expect(merged.stock_baseline).toEqual({ 'PRO-RED': 4 });

    const values = buildProductDraftPublishValues(completeProductDraftValues(draft, LIVE_PRODUCT) as any);
    expect(values.stock_baseline).toEqual({ 'PRO-RED': 4 });
    // 02044 for OTHER-1, whose shared row holds 50: no baseline entry, so the draft's 51.
    expect(publishedStock(51, values.stock_baseline?.['OTHER-1'], 50)).toBe(51);
  });

  it('treats a product whose stock is NULL as not stocked: the page shows the draft figure and publish sends no entry for it', () => {
    // buildProductFormValuesFromLiveProduct reads a NULL stock as 0; the edit page keeps it NULL (no
    // baseline entry), so publish must not send the draft's entry, or the function applied it to 0.
    const nullStockLive = { ...LIVE_PRODUCT, stock: null, product_variants: [] };
    const data = { ...buildProductFormInitialData(nullStockLive, LANGUAGES), category_ids: [] };
    const draft = { ...MARKER, sku: 'PRO', price: 49, stock: 5, variants: [], stock_baseline: { PRO: 3 } };

    const merged = mergeProductDraftMetaIntoFormInitialData(
      { ...data, stock_baseline: buildProductStockBaseline(data) },
      draft,
      { ...options, liveProduct: nullStockLive }
    );
    expect([merged.stock, merged.stock_baseline]).toEqual([5, {}]);

    const values = buildProductDraftPublishValues(completeProductDraftValues(draft, nullStockLive) as any);
    expect([(values as unknown as { stock: unknown }).stock, values.stock_baseline]).toEqual([5, {}]);
    expect(publishedStock(5, values.stock_baseline?.PRO, 0)).toBe(5);
  });

  // Review 2026-11-18 (writer-skew bypass a): the function keys a SKU by the text Postgres prints for
  // its JSON value (btrim(sku->>...)), a number's digits included, while this page read only text. A
  // number SKU beside a baseline entry for its digits showed 5 here and published 0.
  it.each([
    ['a number', 10045],
    ['an object', { code: '10045' }],
    ['null', null],
  ])('refuses a variant SKU that is %s: the page keys no stock by it, and publish refuses before any write', (_label, sku) => {
    const liveProduct = {
      ...LIVE_PRODUCT,
      product_variants: [{ ...LIVE_PRODUCT.product_variants[0], sku: '10045', stock_quantity: 4 }],
    };
    const data = { ...buildProductFormInitialData(liveProduct, LANGUAGES), category_ids: [] };
    const draft = {
      ...autosave(5, { '10045': 1004 }),
      variants: [{ ...data.variants[0], sku, stock_quantity: 5 }],
    };

    const merged = mergeProductDraftMetaIntoFormInitialData(
      { ...data, stock_baseline: buildProductStockBaseline(data) },
      draft,
      { ...options, liveProduct }
    );
    expect([merged.variants[0].stock_quantity, merged.stock_baseline]).toEqual([5, {}]);

    const unreadable = findUnreadableProductDraftValues(draft, liveProduct);
    expect(unreadable).toEqual([{ kind: 'sku', label: 'the SKU of variant 1 (Red)' }]);
    expect(buildUnreadableProductDraftPublishError(unreadable)).toBe(
      'Not published. Publishing cannot read the SKU of variant 1 (Red) in this draft (the form saves a stock as a number and a SKU as text; a hand-written draft can hold anything there). Open the product in the CMS editor, retype a SKU that is not text, save a change (or discard the draft), then publish.'
    );
    expect(getProductDraftEditNotices(draft, liveProduct, DRAFT_CREATED_AT)).toEqual([
      'Publishing cannot read the SKU of variant 1 (Red) in this draft (the form saves a stock as a number and a SKU as text; a hand-written draft can hold anything there). Retype a SKU that is not text, save a change (or discard the draft), then publish (or ask an administrator to).',
    ]);
  });

  it("refuses the product's own SKU that is not text, a variant with no SKU and an entry that is not a variant, and names each", () => {
    expect(findUnreadableProductDraftValues({ ...autosave(4), sku: 10045 }, LIVE_PRODUCT)).toEqual([
      { kind: 'sku', label: "the product's SKU" },
    ]);
    // A null product SKU is a missing one: publish takes the live SKU.
    expect(findUnreadableProductDraftValues({ ...autosave(4), sku: null }, LIVE_PRODUCT)).toEqual([]);

    const withoutSku: Record<string, unknown> = { ...live.variants[0] };
    delete withoutSku.sku;
    const both = findUnreadableProductDraftValues(
      { ...autosave(4), variants: [withoutSku, null, { ...live.variants[0], stock_quantity: 'NaN' }] },
      LIVE_PRODUCT
    );
    expect(both).toEqual([
      { kind: 'sku', label: 'the SKU of variant 1 (Red)' },
      { kind: 'sku', label: 'the SKU of variant 2' },
      { kind: 'stock', label: 'the stock of PRO-RED' },
    ]);
    expect(buildUnreadableProductDraftPublishError(both)).toContain(
      'Publishing cannot read the SKU of variant 1 (Red), the SKU of variant 2 and the stock of PRO-RED in this draft'
    );
    expect(buildUnreadableProductDraftPublishError(both)).toContain(
      'Open the product in the CMS editor, which shows the live stock in place of a stock it cannot read, retype a SKU that is not text, save a change'
    );

    // Not checked: an overlay or a legacy snapshot publishes no stock or SKU.
    expect(findUnreadableProductDraftValues({ title: 'New title' }, LIVE_PRODUCT)).toEqual([]);
    expect(findUnreadableProductDraftValues({ ...LEGACY_ROW_SNAPSHOT, stock: 'NaN' }, LIVE_PRODUCT)).toEqual([]);
  });

  // Review 2026-11-18 (round-2 verifier, fix A): a SKU the live product stocks but the draft's baseline
  // lacks got no baseline on the page, ever. An editor added PRO-BLUE at 5 and published; the autosave
  // queued behind that publish started the same values again as a new draft, whose baseline (loaded before
  // the publish) has no PRO-BLUE; every page loaded after it recorded PRO-RED only. One BLUE sold, a title
  // edit autosaved, and the next publish wrote BLUE 5 again: the sale was undone.
  it("records the live stock of a SKU the draft's baseline lacks, so a sale made after the page load stays sold", () => {
    const { liveProduct, initialData } = liveWithVariants([
      ['PRO-RED', 4],
      ['PRO-BLUE', 5],
    ]);
    const recreated = { ...autosaveOf(initialData, [4, 5], { 'PRO-RED': 4 }), stock: 9 };

    // As it stands, publish writes BLUE as the draft holds it (no baseline entry), and the page shows that.
    const asItStands = buildProductDraftPublishValues(completeProductDraftValues(recreated, liveProduct) as any);
    expect(asItStands.stock_baseline).toEqual({ 'PRO-RED': 4 });
    expect(publishedStock(5, asItStands.stock_baseline?.['PRO-BLUE'], 5)).toBe(5);
    const page = mergeProductDraftMetaIntoFormInitialData(initialData, recreated, { ...options, liveProduct });
    expect(page.variants.map((variant: { stock_quantity: unknown }) => variant.stock_quantity)).toEqual([4, 5]);
    expect(page.stock_baseline).toEqual({ 'PRO-RED': 4, 'PRO-BLUE': 5 });
    expect(getProductDraftEditNotices(recreated, liveProduct, DRAFT_CREATED_AT)).toEqual([]);

    // One BLUE sells while the page is open, then the editor's title change autosaves the form values.
    const saved = {
      ...recreated,
      title: 'Pro plugin (edited)',
      variants: page.variants,
      stock: page.stock,
      stock_baseline: page.stock_baseline,
    };
    const afterSale = liveWithVariants([
      ['PRO-RED', 4],
      ['PRO-BLUE', 4],
    ]).liveProduct;
    const values = buildProductDraftPublishValues(completeProductDraftValues(saved, afterSale) as any);
    const { variants } = values as unknown as { variants: Array<{ sku: string; stock_quantity: number }> };
    const blue = variants.find((variant) => variant.sku === 'PRO-BLUE');

    expect(values.stock_baseline).toEqual({ 'PRO-RED': 4, 'PRO-BLUE': 5 });
    expect(publishedStock(blue?.stock_quantity ?? NaN, values.stock_baseline?.['PRO-BLUE'], 4)).toBe(4);
  });

  // Review 2026-11-18 (item 7): two variants of 2147483647 showed a total of 4294967294 beside them.
  it('holds the read-only total beside the variants at the largest stock a row holds, as the function does', () => {
    const MAX = 2147483647;
    const draft = {
      ...MARKER,
      sku: 'PRO',
      price: 49,
      variants: [
        { ...live.variants[0], sku: 'PRO-A', stock_quantity: MAX },
        { ...live.variants[0], combination_key: 'b23e4567-e89b-12d3-a456-426614174000', sku: 'PRO-B', stock_quantity: MAX },
      ],
    };

    const merged = mergeProductDraftMetaIntoFormInitialData(liveWithBaseline, draft, options);
    expect(merged.variants.map((variant: { stock_quantity: unknown }) => variant.stock_quantity)).toEqual([MAX, MAX]);
    expect(merged.stock).toBe(MAX);
    expect(completeProductDraftValues(draft, LIVE_PRODUCT).stock).toBe(MAX);
    expect((buildProductDraftPublishValues(completeProductDraftValues(draft, LIVE_PRODUCT) as any) as unknown as { stock: unknown }).stock).toBe(MAX);
  });

  // Review 2026-11-18 (item 2): the page re-bases every SKU on the live stock, and the next autosave stores
  // that, after which a publish sees neither case below and nothing told the editor. The page names each
  // such SKU above the form, from the same merge that decides the figures it shows; the publish warns of
  // the same kinds (product-drafts-publish.test.ts).
  describe('names above the form each SKU it shows already live, or applied to a stock that moved', () => {
    const ALREADY_LIVE_NOTE =
      "The stock already holds this draft's figure, so publishing leaves it as it is: PRO-RED stays at 9 (the draft changed 10 to 9). If the change was meant to come on top of what moved the stock (a damaged unit taken out after a sale, for example), enter the figure the stock should have.";
    const MOVED_NOTE =
      "The stock has moved since this draft's stock change started (after a sale or another stock update, for example), so the form shows the change applied to the current stock, as publishing would write it: PRO-RED shows 14 (the draft changed 5 to 15, and the stock is now 4). If the draft's figure already counted that, enter the figure the stock should have.";

    it('already live: the draft changed the stock, and the stock already holds its figure (loaded 10, 9 typed, one sold)', () => {
      const { liveProduct, initialData } = liveAt(9);
      const draft = autosave(9, { 'PRO-RED': 10 });

      const merged = mergeProductDraftMetaIntoFormInitialData(initialData, draft, { ...options, liveProduct });
      expect([merged.variants[0].stock_quantity, merged.stock_baseline]).toEqual([9, { 'PRO-RED': 9 }]);
      expect(getProductDraftEditNotices(draft, liveProduct, DRAFT_CREATED_AT)).toEqual([ALREADY_LIVE_NOTE]);
      expect(publishPro(draft, liveProduct, 9)).toBe(9);
    });

    it('moved: the change applied to a stock that moved since it started (loaded 5, 15 typed, one sold)', () => {
      const { liveProduct, initialData } = liveAt(4);
      const draft = autosave(15, { 'PRO-RED': 5 });

      const merged = mergeProductDraftMetaIntoFormInitialData(initialData, draft, { ...options, liveProduct });
      expect([merged.variants[0].stock_quantity, merged.stock]).toEqual([14, 14]);
      expect(getProductDraftEditNotices(draft, liveProduct, DRAFT_CREATED_AT)).toEqual([MOVED_NOTE]);
      expect(publishPro(draft, liveProduct, 4)).toBe(14);
    });

    it('both kinds in one draft: one note each, every figure the one the form shows', () => {
      const { liveProduct, initialData } = liveWithVariants([
        ['PRO-RED', 4],
        ['PRO-BLUE', 9],
        ['PRO-GREEN', 3],
      ]);
      // RED loaded 5, typed 15, one sold; BLUE loaded 10, typed 9, one sold; GREEN left alone.
      const draft = autosaveOf(initialData, [15, 9, 3], { 'PRO-RED': 5, 'PRO-BLUE': 10, 'PRO-GREEN': 3 });

      const merged = mergeProductDraftMetaIntoFormInitialData(initialData, draft, { ...options, liveProduct });
      expect(merged.variants.map((variant: { stock_quantity: unknown }) => variant.stock_quantity)).toEqual([14, 9, 3]);
      expect(getProductDraftEditNotices(draft, liveProduct, DRAFT_CREATED_AT)).toEqual([
        MOVED_NOTE,
        ALREADY_LIVE_NOTE.replace('PRO-RED stays at 9', 'PRO-BLUE stays at 9'),
      ]);
    });

    it('names the first five SKUs of a kind, then how many more, in plural notes', () => {
      const skus = Array.from({ length: 7 }, (_, index) => `SKU-${index + 1}`);
      const { liveProduct, initialData } = liveWithVariants([
        ...skus.map((sku) => [sku, 4] as [string, number]),
        ...skus.map((sku) => [`LIVE-${sku}`, 9] as [string, number]),
      ]);
      const draft = autosaveOf(initialData, [...skus.map(() => 15), ...skus.map(() => 9)], {
        ...Object.fromEntries(skus.map((sku) => [sku, 5])),
        ...Object.fromEntries(skus.map((sku) => [`LIVE-${sku}`, 10])),
      });

      const [moved, alreadyLive, ...rest] = getProductDraftEditNotices(draft, liveProduct, DRAFT_CREATED_AT);
      expect(rest).toEqual([]);
      expect(moved).toBe(
        "The stock has moved since this draft's stock changes started (after a sale or another stock update, for example), so the form shows the changes applied to the current stock, as publishing would write them: SKU-1 shows 14 (the draft changed 5 to 15, and the stock is now 4); SKU-2 shows 14 (the draft changed 5 to 15, and the stock is now 4); SKU-3 shows 14 (the draft changed 5 to 15, and the stock is now 4); SKU-4 shows 14 (the draft changed 5 to 15, and the stock is now 4); SKU-5 shows 14 (the draft changed 5 to 15, and the stock is now 4); and 2 more. If the draft's figures already counted that, enter the figure the stock should have."
      );
      expect(alreadyLive).toBe(
        "The stock already holds this draft's figures, so publishing leaves them as they are: LIVE-SKU-1 stays at 9 (the draft changed 10 to 9); LIVE-SKU-2 stays at 9 (the draft changed 10 to 9); LIVE-SKU-3 stays at 9 (the draft changed 10 to 9); LIVE-SKU-4 stays at 9 (the draft changed 10 to 9); LIVE-SKU-5 stays at 9 (the draft changed 10 to 9); and 2 more. If a change was meant to come on top of what moved the stock (a damaged unit taken out after a sale, for example), enter the figure the stock should have."
      );
    });

    // Review 2026-11-18 (round 4): the notes named the first five SKUs of a kind in variant order, the
    // publish warning in the function's (`stock_adjusted` by `sku COLLATE "C"`, 02044), so with more than
    // five of a kind the two named different SKUs.
    it('names the first five SKUs of a kind in the order the publish warning names them, each with its own figures', () => {
      const moved = ['ZED', 'ALPHA', 'MIKE', 'BRAVO', 'YANKEE', 'CHARLIE'];
      // Capitals before small letters, and a letter beyond ASCII after both: code point order, not a locale's.
      const alreadyLive = ['zulu', 'Alpha', 'alpha', 'ÉCHO', 'Echo', 'bravo'];
      const { liveProduct, initialData } = liveWithVariants([
        // Each moved SKU loaded 10, 20 typed, and a different stock now: 1 to 6.
        ...moved.map((sku, index) => [sku, index + 1] as [string, number]),
        ...alreadyLive.map((sku) => [sku, 9] as [string, number]),
      ]);
      const draft = autosaveOf(initialData, [...moved.map(() => 20), ...alreadyLive.map(() => 9)], {
        ...Object.fromEntries(moved.map((sku) => [sku, 10])),
        ...Object.fromEntries(alreadyLive.map((sku) => [sku, 10])),
      });

      // The form keeps the variants' order, each with its own figure.
      const merged = mergeProductDraftMetaIntoFormInitialData(initialData, draft, { ...options, liveProduct });
      expect(merged.variants.map((variant: { sku: string; stock_quantity: unknown }) => [variant.sku, variant.stock_quantity])).toEqual([
        ['ZED', 11],
        ['ALPHA', 12],
        ['MIKE', 13],
        ['BRAVO', 14],
        ['YANKEE', 15],
        ['CHARLIE', 16],
        ...alreadyLive.map((sku) => [sku, 9]),
      ]);

      const changed = (sku: string, now: number) => `${sku} shows ${now + 10} (the draft changed 10 to 20, and the stock is now ${now})`;
      const stays = (sku: string) => `${sku} stays at 9 (the draft changed 10 to 9)`;
      expect(getProductDraftEditNotices(draft, liveProduct, DRAFT_CREATED_AT)).toEqual([
        `The stock has moved since this draft's stock changes started (after a sale or another stock update, for example), so the form shows the changes applied to the current stock, as publishing would write them: ${[
          changed('ALPHA', 2),
          changed('BRAVO', 4),
          changed('CHARLIE', 6),
          changed('MIKE', 3),
          changed('YANKEE', 5),
        ].join('; ')}; and 1 more. If the draft's figures already counted that, enter the figure the stock should have.`,
        `The stock already holds this draft's figures, so publishing leaves them as they are: ${[
          stays('Alpha'),
          stays('Echo'),
          stays('alpha'),
          stays('bravo'),
          stays('zulu'),
        ].join('; ')}; and 1 more. If a change was meant to come on top of what moved the stock (a damaged unit taken out after a sale, for example), enter the figure the stock should have.`,
      ]);
    });

    // `sku COLLATE "C"` compares the SKUs' UTF-8 bytes: code point order, where a character above U+FFFF
    // comes after one from U+E000 to U+FFFF. A bare `<` compares UTF-16 code units and puts it first.
    it('orders a SKU with a character above U+FFFF after one with a fullwidth letter, as the function does', () => {
      const skus = ['A-1', '\u{1F600}-1', 'A-2', 'Ａ-1', 'A-3', 'A-4'];
      const { liveProduct, initialData } = liveWithVariants(skus.map((sku) => [sku, 4] as [string, number]));
      const draft = autosaveOf(
        initialData,
        skus.map(() => 15),
        Object.fromEntries(skus.map((sku) => [sku, 5]))
      );

      const [note, ...rest] = getProductDraftEditNotices(draft, liveProduct, DRAFT_CREATED_AT);
      expect(rest).toEqual([]);
      expect([...note.matchAll(/(?:: |; )(\S+) shows 14 /g)].map((match) => match[1])).toEqual(['A-1', 'A-2', 'A-3', 'A-4', 'Ａ-1']);
      expect(note).toContain('; and 1 more.');
    });

    // As `COLLATE "C"` does, a SKU comes before every longer SKU it starts (`A` before `A-1`, `A-1` before
    // `A-1-X`), whatever the variants' order.
    it('orders a SKU before the longer SKUs it starts, as the function does', () => {
      const skus = ['AB', 'A-1-X', 'A-1', 'A', 'A-10', 'B'];
      const { liveProduct, initialData } = liveWithVariants(skus.map((sku) => [sku, 4] as [string, number]));
      const draft = autosaveOf(
        initialData,
        skus.map(() => 15),
        Object.fromEntries(skus.map((sku) => [sku, 5]))
      );

      const [note, ...rest] = getProductDraftEditNotices(draft, liveProduct, DRAFT_CREATED_AT);
      expect(rest).toEqual([]);
      expect([...note.matchAll(/(?:: |; )(\S+) shows 14 /g)].map((match) => match[1])).toEqual(['A', 'A-1', 'A-1-X', 'A-10', 'AB']);
      expect(note).toContain('; and 1 more.');
    });

    it('a product without variants: its own SKU', () => {
      const simpleLive = { ...LIVE_PRODUCT, stock: 9, product_variants: [] };
      const draft = { ...MARKER, sku: 'PRO', price: 49, stock: 9, variants: [], stock_baseline: { PRO: 10 } };

      expect(getProductDraftEditNotices(draft, simpleLive, DRAFT_CREATED_AT)).toEqual([
        ALREADY_LIVE_NOTE.replace('PRO-RED stays at 9', 'PRO stays at 9'),
      ]);
      expect(getProductDraftEditNotices({ ...draft, stock: 15, stock_baseline: { PRO: 5 } }, { ...simpleLive, stock: 4 }, DRAFT_CREATED_AT)).toEqual([
        MOVED_NOTE.replace('PRO-RED shows 14', 'PRO shows 14'),
      ]);
    });

    it.each([
      // [case, live stock, draft quantity, draft baseline (none: undefined)]
      ['a quantity left as loaded, the stock sold down since', 4, 6, 6],
      ['a change over a stock that has not moved', 4, 10, 4],
      ['a draft without a baseline (an earlier version saved it)', 4, 9, undefined],
      ['a change applied to a stock that moved, which lands on the draft figure (loaded 5, 0 typed, two sold)', 3, 0, 5],
      ['a quantity publish cannot read (its own notice names it)', 4, 'NaN', 10],
    ] as const)('names nothing for %s', (_case, liveStock, quantity, baseline) => {
      const { liveProduct } = liveAt(liveStock);
      const draft = autosave(quantity, baseline === undefined ? undefined : { 'PRO-RED': baseline });

      const notices = getProductDraftEditNotices(draft, liveProduct, DRAFT_CREATED_AT);
      expect(notices.filter((notice) => notice.startsWith('The stock'))).toEqual([]);
    });

    it("names nothing for a SKU the draft's baseline lacks, or one the live product does not stock", () => {
      // PRO-RED renamed in the draft (not stocked live), and a baseline for another SKU only.
      expect(getProductDraftEditNotices(autosave(9, { 'PRO-RED': 10 }, 'PRO-RENAMED'), liveAt(9).liveProduct, DRAFT_CREATED_AT)).toEqual([]);
      expect(getProductDraftEditNotices(autosave(9, { 'PRO-BLUE': 10 }), liveAt(4).liveProduct, DRAFT_CREATED_AT)).toEqual([]);
    });

    it('names nothing beside quantities the page shows from live: a draft without a variant list, groups the old-draft check repairs', () => {
      // No variant list: the live variants show and publish sends the live stock as unchanged, whatever
      // baseline the draft carries.
      const { liveProduct, initialData } = liveAt(4);
      const noVariants = { ...MARKER, sku: 'PRO', price: 49, stock_baseline: { 'PRO-RED': 6 } };
      const merged = mergeProductDraftMetaIntoFormInitialData(initialData, noVariants, { ...options, liveProduct });
      expect(merged.variants[0].stock_quantity).toBe(4);
      expect(getProductDraftEditNotices(noVariants, liveProduct, DRAFT_CREATED_AT)).toEqual([]);
      expect(publishPro(noVariants, liveProduct, 4)).toBe(4);

      // An unmarked autosave over a row snapshot (rebuilt variants, x100 prices) beside a baseline: the
      // check repairs the variants from live, and only its own notice shows.
      const poisoned = {
        ...autosave(15, { 'PRO-RED': 5 }),
        [PRODUCT_DRAFT_FORM_MARKER_KEY]: undefined,
        price: 4900,
        prices: { USD: 4900, EUR: 4500 },
        variation_attributes: [],
        variants: [],
      };
      const notices = getProductDraftEditNotices(poisoned, liveProduct, DRAFT_CREATED_AT);
      expect(notices.length).toBeGreaterThan(0);
      expect(notices.filter((notice) => notice.startsWith('The stock'))).toEqual([]);
    });

    it('decides a SKU two variants share by the last one, as publish counts it', () => {
      const { liveProduct, initialData } = liveAt(9);
      const twice = (first: number, last: number) => ({
        ...autosave(first, { 'PRO-RED': 10 }),
        variants: [
          { ...initialData.variants[0], stock_quantity: first },
          { ...initialData.variants[0], combination_key: 'b23e4567-e89b-12d3-a456-426614174000', stock_quantity: last },
        ],
      });

      expect(getProductDraftEditNotices(twice(15, 9), liveProduct, DRAFT_CREATED_AT)).toEqual([ALREADY_LIVE_NOTE]);
      expect(getProductDraftEditNotices(twice(9, 10), liveProduct, DRAFT_CREATED_AT)).toEqual([]);
    });
  });
});

/**
 * A product-values draft's list fields hold a list in every writer's values (the form, the CMS import).
 * Any product_drafts writer can PATCH another value in (RLS checks the role only): it counts as a missing
 * key, so the edit page shows the live value and publish keeps it (review 2026-11-18, X2). A variant list
 * that was not one made ProductForm throw and the publish builder throw; variation attributes that were
 * not a list blocked every autosave.
 */
describe('a list field that is not a list counts as a missing one: the page shows the live value and publish keeps it', () => {
  const live = { ...buildProductFormInitialData(LIVE_PRODUCT, LANGUAGES), category_ids: ['623e4567-e89b-12d3-a456-426614174000'] };
  const options = { productId: PRODUCT_ID, liveProduct: LIVE_PRODUCT, draftCreatedAt: DRAFT_CREATED_AT };
  const NOT_LISTS: Array<[string, unknown]> = [
    ['an object', {}],
    ['a string', 'x'],
    ['a number', 42],
    ['true', true],
    // Until round 2 these three went out as no variants, and the publish deleted every live variant: a
    // check that skips only a truthy value that is not a list would let them through again.
    ['false', false],
    ['0', 0],
    ['an empty string', ''],
  ];
  const draftWith = (key: string, value: unknown) => ({ ...MARKER, sku: 'PRO', price: 49, [key]: value });

  it.each(NOT_LISTS)('variants that are %s: the live variants and their attributes show, and publish sends the live variants', (_label, value) => {
    // Its own attributes beside no variant list: the live variants keep the live attributes.
    const draft = { ...draftWith('variants', value), variation_attributes: [{ attribute_id: ATTR_COLOR, term_ids: [] }] };

    const merged = mergeProductDraftMetaIntoFormInitialData(live, draft, options);
    expect(merged.variants).toEqual(live.variants);
    expect(merged.variation_attributes).toEqual(live.variation_attributes);
    expect(merged.stock).toBe(4);

    const values = buildProductDraftPublishValues(completeProductDraftValues(draft, LIVE_PRODUCT) as any);
    expect((values as unknown as { variants: unknown }).variants).toEqual([
      expect.objectContaining({ id: 'variant-1', sku: 'PRO-RED', price: 4900, stock_quantity: 4, attribute_term_ids: [TERM_RED] }),
    ]);
    expect(findUnreadableProductDraftValues(draft, LIVE_PRODUCT)).toEqual([]);
  });

  it.each(NOT_LISTS)('variation attributes that are %s: the live ones show beside the live variants, those of the draft variants beside them', (_label, value) => {
    expect(mergeProductDraftMetaIntoFormInitialData(live, draftWith('variation_attributes', value), options).variation_attributes).toEqual(
      live.variation_attributes
    );

    // With the draft's own variants, the attributes come from those variants (none here: no options).
    const withVariants = { ...draftWith('variation_attributes', value), variants: [{ ...live.variants[0], selected_options: [] }] };
    expect(mergeProductDraftMetaIntoFormInitialData(live, withVariants, options).variation_attributes).toEqual([]);
    expect(() => buildProductDraftPublishValues(completeProductDraftValues(withVariants, LIVE_PRODUCT) as any)).not.toThrow();
  });

  it.each(NOT_LISTS)('categories that are %s: the live ones show, and publish leaves them as they are', (_label, value) => {
    const draft = draftWith('category_ids', value);

    expect(mergeProductDraftMetaIntoFormInitialData(live, draft, options).category_ids).toEqual(live.category_ids);
    expect(buildProductDraftPublishValues(completeProductDraftValues(draft, LIVE_PRODUCT) as any).category_ids).toBeNull();
  });

  it.each(NOT_LISTS)('a gallery that is %s: the live one shows, and publish leaves it as it is', (_label, value) => {
    const draft = draftWith('product_media', value);

    expect(mergeProductDraftMetaIntoFormInitialData(live, draft, options).product_media).toEqual(LIVE_PRODUCT.product_media);
    expect(buildProductDraftPublishValues(completeProductDraftValues(draft, LIVE_PRODUCT) as any).gallery_media_ids).toBeNull();
  });

  // Review 2026-11-18 (item 5): entries the variations editor cannot read made it throw when the form mounted
  // in the browser, which lost the edit page ("Cannot read properties of null (reading 'attribute_id')",
  // ".includes is not a function").
  it('shows a draft’s own variation attributes only as the variations editor can read them, and a readable list as it is', () => {
    const withVariants = (variationAttributes: unknown[]) => ({
      ...draftWith('variation_attributes', variationAttributes),
      variants: [{ ...live.variants[0] }],
    });

    const merged = mergeProductDraftMetaIntoFormInitialData(
      live,
      withVariants([
        null,
        42,
        { attribute_id: ATTR_COLOR, term_ids: {} },
        { attribute_id: 7, term_ids: [TERM_RED] },
        { term_ids: [TERM_RED] },
        { attribute_id: ATTR_COLOR, term_ids: 5 },
        { attribute_id: ATTR_COLOR, term_ids: [TERM_RED, null, 7] },
      ]),
      options
    );
    expect(merged.variation_attributes).toEqual([
      { attribute_id: ATTR_COLOR, term_ids: [] },
      { attribute_id: ATTR_COLOR, term_ids: [] },
      { attribute_id: ATTR_COLOR, term_ids: [TERM_RED] },
    ]);
    // Publish sends no variation attributes: the values are the same either way.
    expect(buildProductDraftPublishValues(completeProductDraftValues(withVariants([null]), LIVE_PRODUCT) as any)).not.toHaveProperty(
      'variation_attributes'
    );

    const readable = [{ attribute_id: ATTR_COLOR, term_ids: [TERM_RED] }];
    expect(mergeProductDraftMetaIntoFormInitialData(live, withVariants(readable), options).variation_attributes).toBe(readable);
  });

  // Review 2026-11-18 (round 4): a draft variant's own options can hold anything too. Kept as they were, the
  // variation attributes derived from them named only the terms of the readable ones (none for `[{}]`), and
  // ProductForm, handed them, threw or blocked every autosave (ProductForm.list-fields.test.tsx). A list of
  // options counts only when every one is readable, as ProductForm reads them; any other is completed as a
  // CMS import's missing options are.
  const RED_OPTION = { attribute_id: ATTR_COLOR, attribute_name: 'Color', term_id: TERM_RED, term_value: 'Red', term_slug: 'red' };
  it.each([
    ['{}', [{}]],
    ['[]', [[]]],
    ['{ term_value: 5 }', [{ term_value: 5 }]],
    ['null, a number and a string beside {}', [null, 5, 'x', {}]],
    ['an option without its attribute name, beside null', [null, { attribute_id: ATTR_COLOR, term_id: TERM_RED, term_value: 'Red' }]],
  ])("a draft variant whose own options hold %s shows the live variant's options, and the attributes name its term", (_label, selectedOptions) => {
    const draft = draftWith('variants', [{ ...live.variants[0], selected_options: selectedOptions }]);

    const merged = mergeProductDraftMetaIntoFormInitialData(live, draft, options);
    expect(merged.variants).toEqual([expect.objectContaining({ sku: 'PRO-RED', label: 'Red', selected_options: [RED_OPTION] })]);
    expect(merged.variation_attributes).toEqual([{ attribute_id: ATTR_COLOR, term_ids: [TERM_RED] }]);
  });

  it('a draft variant of two attributes whose option for one is null shows both options from its terms, and the attributes name both', () => {
    const ATTR_SIZE = '423e4567-e89b-12d3-a456-426614174021';
    const TERM_S = '323e4567-e89b-12d3-a456-426614174021';
    const globalAttributes = [
      { id: ATTR_COLOR, name: 'Color', slug: 'color', terms: [{ id: TERM_RED, attribute_id: ATTR_COLOR, value: 'Red', slug: 'red' }] },
      { id: ATTR_SIZE, name: 'Size', slug: 'size', terms: [{ id: TERM_S, attribute_id: ATTR_SIZE, value: 'S', slug: 's' }] },
    ];
    const sOption = { attribute_id: ATTR_SIZE, attribute_name: 'Size', term_id: TERM_S, term_value: 'S', term_slug: 's' };
    const draft = draftWith('variants', [
      {
        sku: 'PRO-RED-S',
        price: 49,
        prices: { USD: 49 },
        stock_quantity: 2,
        combination_key: `${TERM_RED}__${TERM_S}`,
        attribute_term_ids: [TERM_RED, TERM_S],
        selected_options: [RED_OPTION, null],
        label: 'Red / S',
      },
    ]);

    const merged = mergeProductDraftMetaIntoFormInitialData(live, draft, { ...options, globalAttributes: globalAttributes as any });
    expect(merged.variants).toEqual([expect.objectContaining({ sku: 'PRO-RED-S', label: 'Red / S', selected_options: [RED_OPTION, sOption] })]);
    expect(merged.variation_attributes).toEqual([
      { attribute_id: ATTR_COLOR, term_ids: [TERM_RED] },
      { attribute_id: ATTR_SIZE, term_ids: [TERM_S] },
    ]);
  });

  it('a draft variant on a term nothing names keeps its own readable options; a readable list stays as it is', () => {
    const TERM_GONE = '323e4567-e89b-12d3-a456-4266141740ff';
    const goneOption = { attribute_id: ATTR_COLOR, attribute_name: 'Color', term_id: TERM_GONE, term_value: 'Gone', term_slug: 'gone' };
    const gone = { sku: 'PRO-GONE', price: 49, stock_quantity: 1, combination_key: TERM_GONE, attribute_term_ids: [TERM_GONE], label: 'Gone' };

    const merged = mergeProductDraftMetaIntoFormInitialData(live, draftWith('variants', [{ ...gone, selected_options: [{}, goneOption] }]), options);
    expect(merged.variants).toEqual([expect.objectContaining({ sku: 'PRO-GONE', selected_options: [goneOption] })]);
    expect(merged.variation_attributes).toEqual([{ attribute_id: ATTR_COLOR, term_ids: [TERM_GONE] }]);

    const readable = { ...live.variants[0] };
    expect(mergeProductDraftMetaIntoFormInitialData(live, draftWith('variants', [readable]), options).variants[0]).toBe(readable);
  });

  it.each(NOT_LISTS)('a removal list or Freemius plans that are %s: nothing reads them, nothing throws', (_label, value) => {
    for (const key of ['explicitly_removed_media_ids', 'freemius_plans']) {
      const draft = draftWith(key, value);
      expect(() => mergeProductDraftMetaIntoFormInitialData(live, draft, options)).not.toThrow();
      const values = completeProductDraftValues(draft, LIVE_PRODUCT);
      expect(values).not.toHaveProperty('explicitly_removed_media_ids');
      expect(buildProductDraftPublishValues(values as any)).not.toHaveProperty('freemius_plans');
      // The old-draft check reads the live product's plans, never the draft's.
      expect(findPoisonedProductDraftFields({ ...draft, [PRODUCT_DRAFT_FORM_MARKER_KEY]: undefined }, LIVE_PRODUCT)).toEqual([]);
    }
  });
});

describe('the edit page repairs a draft the old editor saved over a row snapshot', () => {
  const live = {
    ...buildProductFormInitialData(LIVE_PRODUCT, LANGUAGES),
    category_ids: ['623e4567-e89b-12d3-a456-426614174000'],
  };
  const options = { productId: PRODUCT_ID, liveProduct: LIVE_PRODUCT, draftCreatedAt: DRAFT_CREATED_AT };

  it('shows the live values for the poisoned fields and keeps the draft\'s other edits', () => {
    const merged = mergeProductDraftMetaIntoFormInitialData(live, POISONED_AUTOSAVE, options);

    // Before 0.23.4 the page showed price 490000 (4900.00 in the form), no variants, no gallery.
    expect(merged.price).toBe(4900);
    expect(merged.prices).toEqual(live.prices);
    expect(merged.sale_price).toBe(3900);
    expect(merged.sale_prices).toEqual(live.sale_prices);
    expect(merged.variants).toEqual(live.variants);
    expect(merged.variants).toHaveLength(1);
    expect(merged.variation_attributes).toEqual(live.variation_attributes);
    expect(merged.product_media).toEqual(LIVE_PRODUCT.product_media);
    expect(merged.description_json).toEqual(LIVE_PRODUCT.description_json);
    // The rest is the draft's: the next autosave stores it with the live fields and the marker.
    expect(merged.title).toBe('Pro plugin (renamed in the form)');
    expect(merged.id).toBe(PRODUCT_ID);
  });

  it('names the fields above the form, with the same advice as publish', () => {
    const notices = getProductDraftEditNotices(POISONED_AUTOSAVE, LIVE_PRODUCT, DRAFT_CREATED_AT);

    expect(notices).toEqual([
      buildPoisonedProductDraftNotice(['prices', 'sale_prices', 'variants', 'product_media', 'description_json']),
    ]);
    expect(notices[0]).toContain('Affected in this draft: prices, sale prices, variants, gallery and description.');
    expect(notices[0]).toContain(
      'SEO fields, categories, SKU and UPC, and the Freemius and trial settings) are a copy of the product from when it was saved'
    );
    // Read by anyone who opens the page: it ends with the step a WRITER cannot take.
    expect(notices[0].endsWith('check them, save a change (or discard the draft), then publish (or ask an administrator to).')).toBe(true);
  });

  it('leaves a marked draft as it is: no repair, no note', () => {
    const marked = { ...POISONED_AUTOSAVE, ...MARKER };
    const merged = mergeProductDraftMetaIntoFormInitialData(live, marked, options);

    expect(merged.price).toBe(490000);
    expect(merged.variants).toEqual([]);
    expect(getProductDraftEditNotices(marked, LIVE_PRODUCT, DRAFT_CREATED_AT)).toEqual([]);
  });

  it('shows the sale window publish writes: an unmarked start-only draft over a live end has an open end', () => {
    // A pre-0.23.4 autosave where the editor typed a start only: that form never loaded the window.
    const startOnly = {
      sku: 'PRO',
      price: 49,
      prices: { USD: 49, EUR: 45, JPY: 7000 },
      sale_price: 39,
      sale_prices: { USD: 39 },
      sale_start_at: '2026-11-25T00:00:00.000Z',
    };
    expect(findPoisonedProductDraftFields(startOnly, LIVE_PRODUCT)).toEqual([]);

    const merged = mergeProductDraftMetaIntoFormInitialData(live, startOnly, options);
    const published = completeProductDraftValues(startOnly, LIVE_PRODUCT);

    // Merged key by key, the page showed Nov 25 to the live Nov 30, which publish never wrote.
    expect([merged.sale_start_at, merged.sale_end_at]).toEqual(['2026-11-25T00:00:00.000Z', null]);
    expect([published.sale_start_at, published.sale_end_at]).toEqual(['2026-11-25T00:00:00.000Z', null]);

    // A draft with neither bound shows, and publishes, the live window.
    const neither = mergeProductDraftMetaIntoFormInitialData(live, { sku: 'PRO', price: 49 }, options);
    expect([neither.sale_start_at, neither.sale_end_at]).toEqual([LIVE_PRODUCT.sale_start_at, LIVE_PRODUCT.sale_end_at]);
  });
});

/**
 * The live product changed after the old autosave: a Freemius sync, Cortex or the promotions import
 * moved the price, and sales moved the stock. Matching only the current live amounts, the check
 * missed the x100 prices then, and repairing one price group alone made things worse.
 */
const LIVE_AT_SNAPSHOT = {
  ...LIVE_PRODUCT,
  price: 4900,
  prices: { USD: 4900 },
  sale_price: null,
  sale_prices: null,
  sale_start_at: null,
  sale_end_at: null,
  stock: 10,
  product_variants: [
    { ...LIVE_PRODUCT.product_variants[0], price: 4900, prices: { USD: 4900 }, sale_price: null, sale_prices: null, stock_quantity: 10 },
  ],
};

/** The same product now: $59 instead of $49, three sold. */
const LIVE_MOVED = {
  ...LIVE_AT_SNAPSHOT,
  price: 5900,
  prices: { USD: 5900 },
  stock: 7,
  updated_at: '2026-09-01T10:00:00+00:00',
  product_variants: [{ ...LIVE_AT_SNAPSHOT.product_variants[0], price: 5900, prices: { USD: 5900 }, stock_quantity: 7 }],
};

/** The old page's autosave over the snapshot taken at $49: 4900 "dollars", the stock of that day. */
const OLD_AUTOSAVE_AT_49 = {
  ...POISONED_AUTOSAVE,
  price: 4900,
  prices: { USD: 4900 },
  sale_price: null,
  sale_prices: {},
  stock: 10,
};

/** A variant the old page generated from the x100 base price when the editor re-selected its term there. */
const REBUILT_VARIANT = {
  combination_key: TERM_RED,
  sku: 'PRO-RED',
  upc: null,
  price: 4900,
  prices: { USD: 4900 },
  sale_price: null,
  sale_prices: {},
  sale_start_at: null,
  sale_end_at: null,
  stock_quantity: 0,
  main_media_id: null,
  main_image_url: null,
  attribute_term_ids: [TERM_RED],
  selected_options: [{ attribute_id: ATTR_COLOR, attribute_name: 'Color', term_id: TERM_RED, term_value: 'Red', term_slug: 'red' }],
  label: 'Red',
};

describe('findPoisonedProductDraftFields needs no unchanged live price', () => {
  const options = { productId: PRODUCT_ID, draftCreatedAt: DRAFT_CREATED_AT };

  it('flags the moved prices and the stock of a physical product with variants; the edit page shows the live ones', () => {
    expect(findPoisonedProductDraftFields(OLD_AUTOSAVE_AT_49, LIVE_MOVED)).toEqual([
      'prices',
      'sale_prices',
      'variants',
      'stock',
      'product_media',
      'description_json',
    ]);

    const live = { ...buildProductFormInitialData(LIVE_MOVED, LANGUAGES), category_ids: [] };
    const merged = mergeProductDraftMetaIntoFormInitialData(live, OLD_AUTOSAVE_AT_49, { ...options, liveProduct: LIVE_MOVED });

    // ProductForm divides by 100: $59.00, where the old check left $4,900.00 and the stock of the snapshot.
    expect(merged.price).toBe(5900);
    expect(merged.prices).toEqual({ USD: 59 });
    expect(merged.stock).toBe(7);
    expect(merged.variants).toEqual(live.variants);
    expect(merged.variants[0]).toMatchObject({ price: 59, stock_quantity: 7 });
    expect(merged.product_media).toEqual(LIVE_MOVED.product_media);
    expect(merged.title).toBe(OLD_AUTOSAVE_AT_49.title);
  });

  it('names every flagged group above the form and in the refusal, and says the rest of the draft is a copy', () => {
    const fields = findPoisonedProductDraftFields(OLD_AUTOSAVE_AT_49, LIVE_MOVED);
    const notices = getProductDraftEditNotices(OLD_AUTOSAVE_AT_49, LIVE_MOVED, DRAFT_CREATED_AT);

    expect(notices).toEqual([
      "This draft was saved by an earlier version of NextBlock, which could store a product's prices 100 times too high, reset its stock and drop its variants, gallery or description. Affected in this draft: prices, sale prices, variants, stock, gallery and description. The draft's other fields (title, slug, descriptions, SEO fields, categories, SKU and UPC, and the Freemius and trial settings) are a copy of the product from when it was saved: compare them with the live product. The form shows the live values for the affected fields: check them, save a change (or discard the draft), then publish (or ask an administrator to).",
    ]);
    expect(buildPoisonedProductDraftPublishError(fields)).toBe(
      "Not published. This draft was saved by an earlier version of NextBlock, which could store a product's prices 100 times too high, reset its stock and drop its variants, gallery or description. Affected in this draft: prices, sale prices, variants, stock, gallery and description. Open the product in the CMS editor, check those fields, save a change (or discard the draft), then publish."
    );
    // Given the draft, the refusal of a form autosave opens the same way (a CMS import's says what the import did).
    expect(buildPoisonedProductDraftPublishError(fields, { meta: OLD_AUTOSAVE_AT_49 })).toBe(
      buildPoisonedProductDraftPublishError(fields)
    );
  });

  it("repairs a Freemius product's prices and sale prices together: the coupon keeps the live percent, never 99", async () => {
    // A Freemius sync moved the price to $59 and left the $39 sale price: only the sale prices still
    // matched the snapshot's cents, so the old check repaired them beside a $4,900 regular price.
    const liveSynced = {
      ...LIVE_FREEMIUS_PRODUCT,
      price: 5900,
      prices: { USD: 5900 },
      sale_price: 3900,
      sale_prices: { USD: 3900 },
      product_media: [],
    };
    const draft = {
      ...POISONED_AUTOSAVE,
      product_type: 'digital',
      payment_provider: 'freemius',
      freemius_product_id: '12345',
      freemius_plan_id: '67890',
      price: 4900,
      prices: { USD: 4900 },
      sale_price: 3900,
      sale_prices: { USD: 3900 },
    };

    expect(findPoisonedProductDraftFields(draft, liveSynced)).toEqual(['prices', 'sale_prices', 'description_json']);

    const live = { ...buildProductFormInitialData(liveSynced, LANGUAGES), category_ids: [] };
    const merged = mergeProductDraftMetaIntoFormInitialData(live, draft, { ...options, liveProduct: liveSynced });
    expect([merged.price, merged.sale_price]).toEqual([5900, 3900]);
    expect([merged.prices, merged.sale_prices]).toEqual([{ USD: 59 }, { USD: 39 }]);

    // The autosave after the editor's next change: what the form shows (it divides the top-level
    // amounts by 100), stamped with the marker.
    const autosave = {
      ...draft,
      price: merged.price / 100,
      prices: merged.prices,
      sale_price: merged.sale_price / 100,
      sale_prices: merged.sale_prices,
      description_json: merged.description_json,
      ...MARKER,
    };
    expect(findPoisonedProductDraftFields(autosave, liveSynced)).toEqual([]);

    const values = completeProductDraftValues(autosave, liveSynced);
    const livePercent = computeFreemiusSaleDiscountPercent(liveSynced.price, liveSynced.sale_price);
    expect(livePercent).toBe(34);
    expect(computeFreemiusSaleDiscountPercent(values.price, values.sale_price)).toBe(livePercent);

    // syncProductSaleCouponToFreemius reads the saved row back and pushes this percent.
    const { client, rpcCalls } = makeProductSaveClient();
    await updateProduct(client as any, PRODUCT_ID, values as any);
    const [, payload] = rpcCalls[0];
    expect([payload.price, payload.sale_price]).toEqual([5900, 3900]);
    expect(computeFreemiusSaleDiscountPercent(payload.price, payload.sale_price)).toBe(livePercent);
  });

  it('flags variants rebuilt from the x100 base price, also when the editor corrected the base price there', () => {
    const live = { ...LIVE_AT_SNAPSHOT, product_media: [], description_json: null };
    const rebuilt = {
      ...OLD_AUTOSAVE_AT_49,
      variation_attributes: [{ attribute_id: ATTR_COLOR, term_ids: [TERM_RED] }],
      variants: [REBUILT_VARIANT],
    };

    expect(findPoisonedProductDraftFields(rebuilt, live)).toEqual(['prices', 'sale_prices', 'variants']);
    // The variant amounts alone show it: its price is the live variant's cents read as dollars.
    expect(findPoisonedProductDraftFields({ ...rebuilt, price: 49, prices: { USD: 49 } }, live)).toEqual(['variants']);
    // A rebuilt variant whose amounts were corrected there still has no stock: publishing it zeroes the live one.
    const correctedVariant = {
      ...REBUILT_VARIANT,
      upc: '0123456789029',
      sale_start_at: '2026-11-21T00:00:00+00:00',
      price: 49,
      prices: { USD: 49 },
    };
    expect(findPoisonedProductDraftFields({ ...rebuilt, variants: [correctedVariant] }, live)).toEqual([
      'prices',
      'sale_prices',
      'variants',
    ]);

    const liveInitialData = { ...buildProductFormInitialData(live, LANGUAGES), category_ids: [] };
    const merged = mergeProductDraftMetaIntoFormInitialData(liveInitialData, rebuilt, { ...options, liveProduct: live });
    expect(merged.variants).toEqual(liveInitialData.variants);
    expect(merged.variants[0]).toMatchObject({ price: 49, stock_quantity: 10 });
    expect(merged.variation_attributes).toEqual(liveInitialData.variation_attributes);
  });

  it('flags a digital product with no gallery or description by its moved price alone', () => {
    const liveDigital = {
      ...LIVE_FREEMIUS_PRODUCT,
      price: 5900,
      prices: { USD: 5900 },
      sale_price: null,
      sale_prices: null,
      product_media: [],
      description_json: null,
    };
    const draft = { ...OLD_AUTOSAVE_AT_49, product_type: 'digital', payment_provider: 'freemius', stock: 4 };

    const fields = findPoisonedProductDraftFields(draft, liveDigital);
    expect(fields).toEqual(['prices', 'sale_prices']);
    expect(buildPoisonedProductDraftPublishError(fields)).toContain('Affected in this draft: prices and sale prices.');

    // Without variants the RPC writes the draft's own stock, the snapshot's. The form hides a digital
    // product's stock, so the edit page shows the live one without naming it.
    const snapshotStock = { ...draft, stock: 10 };
    expect(findPoisonedProductDraftFields(snapshotStock, liveDigital)).toEqual(['prices', 'sale_prices']);
    const live = { ...buildProductFormInitialData(liveDigital, LANGUAGES), category_ids: [] };
    const merged = mergeProductDraftMetaIntoFormInitialData(live, snapshotStock, { ...options, liveProduct: liveDigital });
    expect(merged.stock).toBe(4);
  });

  it('leaves the stock to the variants when both sides have them, and flags a gallery that drops a live image', () => {
    const live = { ...LIVE_AT_SNAPSHOT, stock: 25, description_json: null };
    const rebuilt = { ...OLD_AUTOSAVE_AT_49, variants: [REBUILT_VARIANT], product_media: [{ media_id: 'aaaaaaaa-0001-4001-8001-000000000001' }] };
    // The RPC sums the variants' stock there: the variants group carries it.
    expect(findPoisonedProductDraftFields(rebuilt, live)).toEqual(['prices', 'sale_prices', 'variants']);

    // Publishing a gallery without a live image unlinks an image the old editor never showed.
    expect(findPoisonedProductDraftFields({ ...rebuilt, product_media: [{ media_id: 'aaaaaaaa-0009-4009-8009-000000000009' }] }, live)).toContain('product_media');
    expect(
      findPoisonedProductDraftFields({ ...rebuilt, product_media: [{ media_id: 'aaaaaaaa-0001-4001-8001-000000000001' }, { media_id: 'aaaaaaaa-0009-4009-8009-000000000009' }] }, live)
    ).not.toContain('product_media');
  });

  it('leaves a clean old draft alone on a store whose default currency is zero-decimal', () => {
    // The form showed JPY unscaled and took the top-level price from it: the live amount, clean or not.
    const liveJpy = {
      ...LIVE_FREEMIUS_PRODUCT,
      price: 7000,
      prices: { JPY: 7000 },
      sale_price: null,
      sale_prices: null,
      product_media: [],
      description_json: null,
    };
    const cleanOldDraft = {
      sku: 'PRO',
      product_type: 'digital',
      price: 7000,
      prices: { JPY: 7000 },
      sale_price: null,
      variation_attributes: [],
      variants: [],
    };

    expect(findPoisonedProductDraftFields(cleanOldDraft, liveJpy)).toEqual([]);

    // A poisoned one still shows through a currency that has cents, which the old page showed as such.
    const liveJpyUsd = { ...liveJpy, prices: { JPY: 7000, USD: 4900 } };
    expect(findPoisonedProductDraftFields({ ...cleanOldDraft, prices: { JPY: 7000, USD: 49 } }, liveJpyUsd)).toEqual([]);
    expect(findPoisonedProductDraftFields({ ...cleanOldDraft, prices: { JPY: 7000, USD: 4900 } }, liveJpyUsd)).toEqual([
      'prices',
      'sale_prices',
    ]);
  });

  it('never flags a marked draft, a 100-fold reprice included', () => {
    const marked = { ...OLD_AUTOSAVE_AT_49, ...MARKER };

    expect(findPoisonedProductDraftFields(marked, LIVE_MOVED)).toEqual([]);
    const live = { ...buildProductFormInitialData(LIVE_MOVED, LANGUAGES), category_ids: [] };
    const merged = mergeProductDraftMetaIntoFormInitialData(live, marked, { ...options, liveProduct: LIVE_MOVED });
    expect([merged.price, merged.stock]).toEqual([490000, 10]);
  });

  it('leaves a clean old draft alone when it differs from live in ordinary ways', () => {
    const edited = {
      ...POISONED_AUTOSAVE,
      price: 59,
      prices: { USD: 59, EUR: 55, JPY: 7500 },
      sale_price: 45,
      sale_prices: { USD: 45 },
      stock: 12,
      description_json: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Rewritten' }] }] },
      product_media: [{ media_id: 'aaaaaaaa-0002-4002-8002-000000000002' }],
      variation_attributes: [{ attribute_id: ATTR_COLOR, term_ids: [TERM_RED] }],
      variants: [
        {
          ...REBUILT_VARIANT,
          id: 'variant-1',
          upc: '0123456789029',
          price: 55,
          prices: { USD: 55, EUR: 50, JPY: 7000 },
          sale_price: 44,
          sale_prices: { USD: 44 },
          stock_quantity: 9,
        },
      ],
    };

    expect(findPoisonedProductDraftFields(edited, LIVE_PRODUCT)).toEqual([]);
    expect(getProductDraftEditNotices(edited, LIVE_PRODUCT, DRAFT_CREATED_AT)).toEqual([]);
    // Beside its variants the product's stock is their total (9, not the draft's 12): what the function
    // writes whatever it is sent, and what the edit page shows read-only beside them.
    expect(completeProductDraftValues(edited, LIVE_PRODUCT)).toMatchObject({ price: 59, sale_price: 45, stock: 9 });
    const live = { ...buildProductFormInitialData(LIVE_PRODUCT, LANGUAGES), category_ids: [] };
    expect(mergeProductDraftMetaIntoFormInitialData(live, edited, { ...options, liveProduct: LIVE_PRODUCT }).stock).toBe(9);
  });
});
