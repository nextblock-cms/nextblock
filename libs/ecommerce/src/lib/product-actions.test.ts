import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * updateProduct() purges media that a product save orphaned. Media DELETE is row-scoped to the
 * uploader (or ADMIN) by RLS (migration 02022 §9) and the save uses the cookie client, so the
 * DB delete must run BEFORE the storage purge: a non-owner match deletes zero rows, and purging
 * the files first would destroy the objects while the media row survived. These tests drive the
 * orphan path with a mocked Supabase client and assert the DB-first ordering and the zero-row gate.
 */

const PRODUCT_ID = 'prod-1';
const REMOVED_MEDIA_ID = 'media-removed-1';

const callLog: string[] = [];

const mocks = vi.hoisted(() => ({
  // The rows the media DELETE ... .select() returns (what RLS actually removed).
  mediaDeleteResult: [] as any[] | null,
}));

const deleteMediaFiles = vi.fn(async (_keys: string[]) => {
  callLog.push('storage.delete');
});

vi.mock('@nextblock-cms/utils/server', () => ({
  deleteMediaFiles: (keys: string[]) => deleteMediaFiles(keys),
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

import { updateProduct } from './product-actions';

function makeSupabase() {
  function resolve(state: any) {
    const { table, op, selectArg, single } = state;

    if (table === 'product_media') {
      if (op === 'select') {
        // Initial "current media" read vs. the usage-count head reads.
        if (selectArg === 'media_id') {
          return { data: [{ media_id: REMOVED_MEDIA_ID }], error: null };
        }
        return { data: null, error: null, count: 0 };
      }
      return { data: null, error: null }; // delete / insert
    }

    if (table === 'posts' || table === 'logos') {
      return { data: null, error: null, count: 0 };
    }

    if (table === 'product_variants') {
      if (op === 'select') return { data: [], error: null, count: 0 };
      return { data: null, error: null };
    }

    if (table === 'products') {
      if (op === 'update') return { data: null, error: null };
      if (op === 'select') {
        if (single) {
          return {
            data: { id: PRODUCT_ID, sku: 'SKU-1', sale_price: null, sale_prices: null },
            error: null,
          };
        }
        return { data: [{ id: PRODUCT_ID }], error: null }; // SKU group rows
      }
      return { data: null, error: null };
    }

    if (table === 'media') {
      if (op === 'delete') {
        callLog.push('media.delete');
        return { data: mocks.mediaDeleteResult, error: null };
      }
      return { data: null, error: null };
    }

    return { data: null, error: null };
  }

  function builder(table: string) {
    const state: any = { table, op: 'select', filters: [] };
    const chain: any = {
      select(arg?: any) { state.selectArg = arg; return chain; },
      insert(v: any) { state.op = 'insert'; state.values = v; return chain; },
      update(v: any) { state.op = 'update'; state.values = v; return chain; },
      delete() { state.op = 'delete'; return chain; },
      eq(col: string, val: any) { state.filters.push(['eq', col, val]); return chain; },
      in(col: string, val: any) { state.filters.push(['in', col, val]); return chain; },
      order() { return chain; },
      range() { return chain; },
      single() { state.single = true; return Promise.resolve(resolve(state)); },
      maybeSingle() { state.single = true; return Promise.resolve(resolve(state)); },
      then(res: any, rej: any) { return Promise.resolve(resolve(state)).then(res, rej); },
    };
    return chain;
  }

  return {
    from: (t: string) => builder(t),
    rpc: vi.fn(async () => ({ data: PRODUCT_ID, error: null })),
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
  product_media: [], // all current media now orphaned
  variants: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  callLog.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocks.mediaDeleteResult = [];
});

describe('updateProduct orphan-media cleanup', () => {
  it('deletes the media row BEFORE purging storage, and only for returned keys', async () => {
    mocks.mediaDeleteResult = [
      { object_key: 'uploads/x.avif', variants: [{ objectKey: 'uploads/x_thumb.avif' }] },
    ];

    await updateProduct(makeSupabase() as any, PRODUCT_ID, { ...baseData });

    expect(callLog).toEqual(['media.delete', 'storage.delete']);
    expect(deleteMediaFiles).toHaveBeenCalledTimes(1);
    expect(deleteMediaFiles).toHaveBeenCalledWith(['uploads/x.avif', 'uploads/x_thumb.avif']);
  });

  it('a non-owner session (zero rows deleted) purges no storage objects', async () => {
    mocks.mediaDeleteResult = []; // RLS removed nothing

    await updateProduct(makeSupabase() as any, PRODUCT_ID, { ...baseData });

    expect(callLog).toEqual(['media.delete']); // DB delete attempted, no storage purge
    expect(deleteMediaFiles).not.toHaveBeenCalled();
  });
});
