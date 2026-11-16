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
