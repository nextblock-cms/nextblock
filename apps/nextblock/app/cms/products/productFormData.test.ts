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

import { updateProduct } from '@nextblock-cms/ecommerce/product-actions';
import { computeFreemiusSaleDiscountPercent } from '@nextblock-cms/ecommerce/freemius-pricing';
import {
  buildPoisonedProductDraftNotice,
  buildPoisonedProductDraftPublishError,
  buildProductFormInitialData,
  buildProductFormValuesFromLiveProduct,
  completeProductDraftValues,
  findPoisonedProductDraftFields,
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
  product_media: [{ media_id: 'media-1', sort_order: 0, media: { file_path: 'a.webp' } }],
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
        if (table === 'product_media') return { data: [{ media_id: 'media-1' }], error: null, count: 1 };
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
        explicitly_removed_media_ids: ['media-1', 'other-uploader-media'],
      },
      LIVE_PRODUCT
    );

    expect(values).not.toHaveProperty('media_id');
    expect(values).not.toHaveProperty('explicitly_removed_media_ids');
    // No gallery in the draft: updateProduct() leaves the live one as it is.
    expect(values).not.toHaveProperty('product_media');
  });

  it('keeps the gallery a draft carries, which the edit page shows', () => {
    const values = completeProductDraftValues({ sku: 'PRO', ...MARKER, product_media: [{ media_id: 'media-2' }] }, LIVE_PRODUCT);

    expect(values.product_media).toEqual([{ media_id: 'media-2' }]);
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
      product_media: [{ media_id: 'media-1' }],
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
    const hydrated = [{ media_id: 'media-2', sort_order: 0, media: { file_path: 'b.webp' } }];
    const merged = mergeProductDraftMetaIntoFormInitialData(
      live,
      {
        sku: 'PRO',
        price: 59,
        sale_price: null,
        variants: [],
        product_media: [{ media_id: 'media-2' }],
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
    const rebuilt = { ...OLD_AUTOSAVE_AT_49, variants: [REBUILT_VARIANT], product_media: [{ media_id: 'media-1' }] };
    // The RPC sums the variants' stock there: the variants group carries it.
    expect(findPoisonedProductDraftFields(rebuilt, live)).toEqual(['prices', 'sale_prices', 'variants']);

    // Publishing a gallery without a live image unlinks an image the old editor never showed.
    expect(findPoisonedProductDraftFields({ ...rebuilt, product_media: [{ media_id: 'media-9' }] }, live)).toContain('product_media');
    expect(
      findPoisonedProductDraftFields({ ...rebuilt, product_media: [{ media_id: 'media-1' }, { media_id: 'media-9' }] }, live)
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
      product_media: [{ media_id: 'media-2' }],
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
    expect(completeProductDraftValues(edited, LIVE_PRODUCT)).toMatchObject({ price: 59, sale_price: 45, stock: 12 });
  });
});
