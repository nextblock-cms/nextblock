import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * updateProduct() and the gallery. A product save never deletes media: an image dropped from the
 * gallery is only unlinked, and stays in the media library with its files. Until 0.23.4 it deleted
 * every dropped image no product, post, logo or variant used, row and (on R2) every key the row
 * listed, and took more ids from the values' explicitly_removed_media_ids. Blocks, section
 * backgrounds and the social image keep their own copy of a key and were never checked, and the
 * values could be a draft any WRITER can write (security review 2026-11-15). The gallery is now
 * written as one checked upsert of the listed images, then one checked unlink of the rest: the old
 * delete-then-insert ignored both results, so one stale id emptied the gallery while the save
 * reported success. These tests drive it with a mocked Supabase client.
 */

const PRODUCT_ID = 'prod-1';
const IMAGE_A = '11111111-1111-4111-8111-111111111111';
const IMAGE_B = '22222222-2222-4222-8222-222222222222';
const IMAGE_C = '33333333-3333-4333-8333-333333333333';
const DELETED_IMAGE = '44444444-4444-4444-8444-444444444444';
// Hex letters, so its uppercase spelling differs.
const LETTERED_IMAGE = 'abcdef12-3456-4789-8abc-def123456789';

const mocks = vi.hoisted(() => ({
  /** Media ids that still have a media row. */
  existingMedia: [] as string[],
  mediaReadError: null as string | null,
  upsertError: null as string | null,
  unlinkError: null as string | null,
  /** Every write, in order: [table, op, values, filters, options]. */
  writes: [] as unknown[][],
  rpcCalls: 0,
}));

vi.mock('@nextblock-cms/utils/utils', () => ({
  normalizeCurrencyCode: (code?: string | null) => (code || 'USD').trim().toUpperCase(),
}));

vi.mock('@nextblock-cms/utils', () => ({
  buildPublishedAtOrFilter: () => 'published_at.is.null',
}));

vi.mock('./shared-inventory', () => ({
  syncSharedInventoryForSavedProduct: vi.fn(async () => undefined),
}));

import { copyProductFromLanguage, updateProduct } from './product-actions';

function makeSupabase() {
  function resolve(state: any) {
    const { table, op, single } = state;

    if (table === 'media') {
      if (op === 'select') {
        if (mocks.mediaReadError) return { data: null, error: { message: mocks.mediaReadError } };
        // As Postgres answers a uuid filter: case-insensitive, ids returned lowercase.
        const ids = (state.filters.find((filter: any[]) => filter[0] === 'in')?.[2] ?? []) as string[];
        return {
          data: ids
            .filter((id) => mocks.existingMedia.includes(id.toLowerCase()))
            .map((id) => ({ id: id.toLowerCase() })),
          error: null,
        };
      }
      return { data: null, error: null };
    }

    if (table === 'product_media') {
      if (op === 'upsert' && mocks.upsertError) return { data: null, error: { message: mocks.upsertError } };
      if (op === 'delete' && mocks.unlinkError) return { data: null, error: { message: mocks.unlinkError } };
      return { data: null, error: null };
    }

    if (table === 'products') {
      if (op === 'update') return { data: null, error: null };
      if (op === 'select') {
        if (single) {
          return { data: { id: PRODUCT_ID, sku: 'SKU-1', sale_price: null, sale_prices: null }, error: null };
        }
        return { data: [{ id: PRODUCT_ID }], error: null }; // SKU group rows
      }
      return { data: null, error: null };
    }

    return { data: null, error: null };
  }

  function builder(table: string) {
    const state: any = { table, op: 'select', filters: [] };
    const record = () => {
      if (state.op !== 'select' && !state.recorded) {
        state.recorded = true;
        mocks.writes.push([table, state.op, state.values, state.filters, state.options]);
      }
    };
    const chain: any = {
      select(arg?: any) { state.selectArg = arg; return chain; },
      insert(v: any) { state.op = 'insert'; state.values = v; return chain; },
      upsert(v: any, options?: any) { state.op = 'upsert'; state.values = v; state.options = options; return chain; },
      update(v: any) { state.op = 'update'; state.values = v; return chain; },
      delete() { state.op = 'delete'; return chain; },
      eq(col: string, val: any) { state.filters.push(['eq', col, val]); return chain; },
      in(col: string, val: any) { state.filters.push(['in', col, val]); return chain; },
      not(col: string, operator: string, val: any) { state.filters.push(['not', col, operator, val]); return chain; },
      order() { return chain; },
      range() { return chain; },
      single() { state.single = true; record(); return Promise.resolve(resolve(state)); },
      maybeSingle() { state.single = true; record(); return Promise.resolve(resolve(state)); },
      then(res: any, rej: any) { record(); return Promise.resolve(resolve(state)).then(res, rej); },
    };
    return chain;
  }

  return {
    from: (t: string) => builder(t),
    rpc: vi.fn(async () => {
      mocks.rpcCalls += 1;
      mocks.writes.push(['rpc', 'upsert_product_with_variants']);
      return { data: PRODUCT_ID, error: null };
    }),
  };
}

const baseData: any = {
  product_type: 'physical',
  payment_provider: 'stripe',
  title: 'Widget',
  slug: 'widget',
  sku: 'SKU-1',
  price: 10,
  status: 'active',
  is_taxable: true,
  language_id: 1,
  variants: [],
};

/** The product_media writes, in order. */
function galleryWrites() {
  return mocks.writes.filter((write) => write[0] === 'product_media');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocks.existingMedia = [IMAGE_A, IMAGE_B, IMAGE_C, LETTERED_IMAGE];
  mocks.mediaReadError = null;
  mocks.upsertError = null;
  mocks.unlinkError = null;
  mocks.writes = [];
  mocks.rpcCalls = 0;
});

describe('updateProduct and the gallery: a save never deletes media', () => {
  it('upserts the listed images in their order, then unlinks the rest of the gallery', async () => {
    await updateProduct(makeSupabase() as any, PRODUCT_ID, {
      ...baseData,
      product_media: [{ media_id: IMAGE_B }, { media_id: IMAGE_A }],
    });

    expect(galleryWrites()).toEqual([
      [
        'product_media',
        'upsert',
        [
          { product_id: PRODUCT_ID, media_id: IMAGE_B, sort_order: 0 },
          { product_id: PRODUCT_ID, media_id: IMAGE_A, sort_order: 1 },
        ],
        [],
        { onConflict: 'product_id,media_id' },
      ],
      [
        'product_media',
        'delete',
        undefined,
        [
          ['eq', 'product_id', PRODUCT_ID],
          ['not', 'media_id', 'in', `(${IMAGE_B},${IMAGE_A})`],
        ],
        undefined,
      ],
    ]);
  });

  it('only unlinks a dropped image: no media row is deleted, whatever explicitly_removed_media_ids names', async () => {
    await updateProduct(makeSupabase() as any, PRODUCT_ID, {
      ...baseData,
      product_media: [{ media_id: IMAGE_A }],
      explicitly_removed_media_ids: [IMAGE_B, IMAGE_C],
    });

    expect(mocks.writes.some((write) => write[0] === 'media')).toBe(false);
    expect(galleryWrites().map((write) => write[1])).toEqual(['upsert', 'delete']);
  });

  it('unlinks the whole gallery for an emptied one, and deletes no media', async () => {
    await updateProduct(makeSupabase() as any, PRODUCT_ID, { ...baseData, product_media: [] });

    expect(galleryWrites()).toEqual([['product_media', 'delete', undefined, [['eq', 'product_id', PRODUCT_ID]], undefined]]);
    expect(mocks.writes.some((write) => write[0] === 'media')).toBe(false);
  });

  it('leaves the gallery alone when the values carry none, a top-level media_id included (the form never writes one)', async () => {
    await updateProduct(makeSupabase() as any, PRODUCT_ID, {
      ...baseData,
      media_id: IMAGE_C,
      explicitly_removed_media_ids: [IMAGE_A],
    });

    expect(galleryWrites()).toEqual([]);
    expect(mocks.writes.some((write) => write[0] === 'media')).toBe(false);
  });

  it('leaves out an image deleted from the media library, duplicates and ids that are not media ids, and saves the rest', async () => {
    await updateProduct(makeSupabase() as any, PRODUCT_ID, {
      ...baseData,
      product_media: [
        { media_id: IMAGE_A },
        { media_id: DELETED_IMAGE },
        { media_id: IMAGE_A },
        { media_id: 'not-a-uuid' },
        { media_id: IMAGE_C },
      ],
    });

    const [upsert] = galleryWrites();
    expect(upsert[2]).toEqual([
      { product_id: PRODUCT_ID, media_id: IMAGE_A, sort_order: 0 },
      { product_id: PRODUCT_ID, media_id: IMAGE_C, sort_order: 1 },
    ]);
  });

  it('writes the gallery only after the product RPC: a refused RPC leaves the gallery untouched', async () => {
    const supabase = makeSupabase();
    supabase.rpc.mockImplementationOnce(async () => ({ data: null, error: { message: 'products_sale_window_valid' } }) as any);

    await expect(
      updateProduct(supabase as any, PRODUCT_ID, { ...baseData, product_media: [{ media_id: IMAGE_A }] })
    ).rejects.toMatchObject({ message: 'products_sale_window_valid' });
    expect(galleryWrites()).toEqual([]);
  });

  it('reads an uppercase media id as the lowercase uuid Postgres stores, not as a deleted image', async () => {
    await updateProduct(makeSupabase() as any, PRODUCT_ID, {
      ...baseData,
      product_media: [{ media_id: LETTERED_IMAGE.toUpperCase() }],
    });

    const [upsert] = galleryWrites();
    expect(upsert[1]).toBe('upsert');
    expect(upsert[2]).toEqual([{ product_id: PRODUCT_ID, media_id: LETTERED_IMAGE, sort_order: 0 }]);
  });

  it('stops before any write when the gallery cannot be checked', async () => {
    mocks.mediaReadError = 'statement timeout';

    await expect(
      updateProduct(makeSupabase() as any, PRODUCT_ID, { ...baseData, product_media: [{ media_id: IMAGE_A }] })
    ).rejects.toThrow("The product's gallery could not be checked: statement timeout");
    expect(mocks.rpcCalls).toBe(0);
    expect(mocks.writes).toEqual([]);
  });

  it('throws when the upsert fails, before unlinking anything, so the gallery stays as it was', async () => {
    mocks.upsertError = 'insert or update on table "product_media" violates foreign key constraint';

    await expect(
      updateProduct(makeSupabase() as any, PRODUCT_ID, { ...baseData, product_media: [{ media_id: IMAGE_A }] })
    ).rejects.toThrow("The product's gallery was not saved: insert or update on table");
    expect(galleryWrites().map((write) => write[1])).toEqual(['upsert']);
  });

  it('throws when the unlink fails', async () => {
    mocks.unlinkError = 'permission denied';

    await expect(
      updateProduct(makeSupabase() as any, PRODUCT_ID, { ...baseData, product_media: [{ media_id: IMAGE_A }] })
    ).rejects.toThrow("The product's gallery was not saved: permission denied");
  });
});

/**
 * Review 2026-11-14, round 6: Copy from language rewrote the target's title, short description and
 * description without products.updated_at, which no trigger maintains (the sitemap's lastModified and
 * the visual editor's rule for pre-0.23.4 drafts both read it).
 */
describe('copyProductFromLanguage', () => {
  it('stamps updated_at with the copied title and descriptions', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-14T12:00:00Z'), toFake: ['Date'] });
    try {
      const productUpdates: unknown[] = [];
      const source = {
        id: 'source-product',
        title: 'Pro plugin',
        short_description: 'Short copy',
        description_json: { type: 'doc', content: [] },
        language_id: 2,
      };
      const supabase = {
        from(table: string) {
          const chain: any = {
            select: () => chain,
            update(values: unknown) {
              if (table === 'products') productUpdates.push(values);
              return chain;
            },
            delete: () => chain,
            insert: () => chain,
            eq: () => chain,
            order: () => chain,
            single: async () => ({ data: table === 'products' ? source : null, error: null }),
            then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
              Promise.resolve({ data: table === 'products' ? null : [], error: null }).then(onFulfilled, onRejected),
          };
          return chain;
        },
      };

      await expect(copyProductFromLanguage(supabase as any, 'target-product', 'source-product')).resolves.toEqual({
        success: true,
      });

      expect(productUpdates).toEqual([
        {
          title: 'Pro plugin',
          short_description: 'Short copy',
          description_json: { type: 'doc', content: [] },
          updated_at: '2026-11-14T12:00:00.000Z',
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * What a draft publish hands public.publish_product_draft (migration 02043): updateProduct()'s RPC
 * payload in minor units, plus the writes updateProduct() made after the RPC, and nothing that could
 * change visibility or delete media. The function itself runs against a real database in
 * tools/scripts/product-draft-publish.db.test.ts.
 */
describe('buildProductDraftPublishValues', () => {
  const formValues: any = {
    ...baseData,
    upc: '',
    price: 49.99,
    prices: { USD: 49.99, EUR: 45 },
    sale_price: 39.5,
    sale_prices: { USD: 39.5, EUR: null },
    sale_start_at: '2026-12-01T00:00:00.000Z',
    sale_end_at: null,
    stock: 4,
    meta_title: '  Widget | Store  ',
    meta_description: null,
    custom_canonical: '',
    short_description: 'Short',
    description_json: { type: 'doc', content: [] },
    translation_group_id: '',
    product_media: [{ media_id: IMAGE_B }, { media_id: IMAGE_A }, { media_id: 42 }],
    category_ids: ['55555555-5555-4555-8555-555555555555'],
    media_id: DELETED_IMAGE,
    explicitly_removed_media_ids: [IMAGE_C],
    variants: [
      {
        id: '66666666-6666-4666-8666-666666666666',
        combination_key: 'red',
        sku: 'SKU-1-RED',
        upc: null,
        price: 12.34,
        prices: { USD: 12.34 },
        sale_price: null,
        sale_prices: {},
        sale_start_at: null,
        sale_end_at: null,
        stock_quantity: 3,
        main_media_id: IMAGE_A,
        attribute_term_ids: ['77777777-7777-4777-8777-777777777777'],
        selected_options: [],
        label: 'Red',
      },
    ],
  };

  it("converts every amount to minor units and keeps each variant with its terms and the draft's copy of its id", async () => {
    const { buildProductDraftPublishValues } = await import('./product-actions');
    const values = buildProductDraftPublishValues(formValues);

    expect(values).toMatchObject({
      product_type: 'physical',
      title: 'Widget',
      slug: 'widget',
      sku: 'SKU-1',
      upc: '',
      stock: 4,
      price: 4999,
      prices: { USD: 4999, EUR: 4500 },
      sale_price: 3950,
      // A blank entry is dropped, as updateProduct() always did.
      sale_prices: { USD: 3950 },
      sale_start_at: '2026-12-01T00:00:00.000Z',
      sale_end_at: null,
      is_taxable: true,
      language_id: 1,
      trial_period_days: 0,
      trial_requires_payment_method: false,
      short_description: 'Short',
      description_json: { type: 'doc', content: [] },
      // Sent as typed: the function trims them, and a blank becomes NULL.
      meta_title: '  Widget | Store  ',
      meta_description: null,
      custom_canonical: '',
      variants: [
        {
          id: '66666666-6666-4666-8666-666666666666',
          sku: 'SKU-1-RED',
          upc: null,
          price: 1234,
          sale_price: null,
          prices: { USD: 1234 },
          sale_prices: {},
          sale_start_at: null,
          sale_end_at: null,
          stock_quantity: 3,
          main_media_id: IMAGE_A,
          attribute_term_ids: ['77777777-7777-4777-8777-777777777777'],
        },
      ],
    });
  });

  it('sends the gallery as the listed media ids in order and the categories as listed, null when the values carry none', async () => {
    const { buildProductDraftPublishValues } = await import('./product-actions');

    expect(buildProductDraftPublishValues(formValues)).toMatchObject({
      gallery_media_ids: [IMAGE_B, IMAGE_A],
      category_ids: ['55555555-5555-4555-8555-555555555555'],
    });
    const bare = buildProductDraftPublishValues({ ...formValues, product_media: undefined, category_ids: undefined });
    expect(bare.gallery_media_ids).toBeNull();
    expect(bare.category_ids).toBeNull();
    expect(buildProductDraftPublishValues({ ...formValues, product_media: [], category_ids: [] })).toMatchObject({
      gallery_media_ids: [],
      category_ids: [],
    });
  });

  it('never carries visibility, a top-level media_id, a removal list, metadata, the provider or an id', async () => {
    const { buildProductDraftPublishValues } = await import('./product-actions');
    const values = buildProductDraftPublishValues(formValues);

    for (const key of ['status', 'media_id', 'explicitly_removed_media_ids', 'product_media', 'metadata', 'payment_provider', 'id']) {
      expect(values).not.toHaveProperty(key);
    }
    expect(JSON.stringify(values)).not.toContain(DELETED_IMAGE);
    expect(JSON.stringify(values)).not.toContain(IMAGE_C);
    // An empty translation group never reaches the function (it keeps the row's).
    expect(JSON.parse(JSON.stringify(values))).not.toHaveProperty('translation_group_id');
  });

  it('sends the stock the edit page loaded, keyed as the inventory rows are, with only whole quantities from 0 up', async () => {
    const { buildProductDraftPublishValues } = await import('./product-actions');

    const values = buildProductDraftPublishValues({
      ...formValues,
      stock_baseline: {
        'SKU-1-RED': 3,
        // Spaces around a SKU go, as Postgres btrim() takes them off the inventory key.
        '  SKU-1-BLUE ': 0,
        'SKU-1-GREEN': 2.5,
        'SKU-1-BLACK': -1,
        'SKU-1-WHITE': 2147483648,
        'SKU-1-GREY': '4',
        '   ': 9,
      },
    });

    expect(values.stock_baseline).toEqual({ 'SKU-1-RED': 3, 'SKU-1-BLUE': 0 });
    // The quantities themselves are sent as the draft holds them: the function compares the two.
    expect(values).toMatchObject({ stock: 4, variants: [expect.objectContaining({ sku: 'SKU-1-RED', stock_quantity: 3 })] });
  });

  it('sends no baseline for values without one (a draft an earlier version saved, a CMS draft import)', async () => {
    const { buildProductDraftPublishValues } = await import('./product-actions');

    expect(buildProductDraftPublishValues(formValues).stock_baseline).toBeNull();
    expect(buildProductDraftPublishValues({ ...formValues, stock_baseline: null }).stock_baseline).toBeNull();
    expect(buildProductDraftPublishValues({ ...formValues, stock_baseline: ['SKU-1-RED'] }).stock_baseline).toBeNull();
  });

  // Review 2026-11-18: a hand-written draft's variant list that was not a list threw here
  // (`(variants || []).map is not a function`), and a null entry threw on its first field. Neither is
  // read as no variants, which the function would apply by deleting every live variant: it goes on as
  // it is, and publish_product_draft refuses it (NBP04). The app's completeProductDraftValues sends the
  // live variants for a variant list that is not a list, so a publish never gets here with one.
  it('never throws on variants that are not a list or entries that are not objects, and never reads them as no variants', async () => {
    const { buildProductDraftPublishValues } = await import('./product-actions');

    // The payload's own fields are typed loosely (buildProductDraftPublishValues types the fields it adds).
    const sentVariants = (values: unknown) => (values as { variants: unknown }).variants;

    // false, 0 and '' too: until round 2 `(variants || [])` sent them as no variants, which deleted every
    // live variant, and a truthiness test (`if (!variants) return []`) would again.
    for (const variants of [{}, 'x', 42, false, 0, '']) {
      let values: unknown;
      expect(() => {
        values = buildProductDraftPublishValues({ ...formValues, variants });
      }).not.toThrow();
      expect(sentVariants(values)).toBe(variants);
    }

    expect(sentVariants(buildProductDraftPublishValues({ ...formValues, variants: [null, 'x', [], formValues.variants[0]] }))).toEqual([
      null,
      'x',
      [],
      expect.objectContaining({ sku: 'SKU-1-RED', price: 1234, stock_quantity: 3 }),
    ]);

    // None at all is still none.
    expect(sentVariants(buildProductDraftPublishValues({ ...formValues, variants: undefined }))).toEqual([]);
    expect(sentVariants(buildProductDraftPublishValues({ ...formValues, variants: null }))).toEqual([]);
  });

  it('keeps the trial only for a digital product sold through Freemius', async () => {
    const { buildProductDraftPublishValues } = await import('./product-actions');
    const trial = { trial_period_days: 14, trial_requires_payment_method: true };

    expect(buildProductDraftPublishValues({ ...formValues, ...trial })).toMatchObject({ trial_period_days: 0, trial_requires_payment_method: false });
    expect(
      buildProductDraftPublishValues({ ...formValues, ...trial, product_type: 'digital', payment_provider: 'freemius', freemius_plan_id: '9' })
    ).toMatchObject({ product_type: 'digital', trial_period_days: 14, trial_requires_payment_method: true, freemius_plan_id: '9' });
  });

  it('writes nothing itself', async () => {
    const { buildProductDraftPublishValues } = await import('./product-actions');
    buildProductDraftPublishValues(formValues);
    expect(mocks.writes).toEqual([]);
    expect(mocks.rpcCalls).toBe(0);
  });
});
