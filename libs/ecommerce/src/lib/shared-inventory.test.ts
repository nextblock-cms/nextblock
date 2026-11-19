import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The shared inventory's writes go through public.upsert_inventory_items (migration 02046), which takes
 * the rows in SKU order in one statement, the order a publish and a sale lock inventory rows in: a list
 * sent to PostgREST was written in the order given (a new product's variants in form order), which could
 * deadlock with a publish (40P01). tools/scripts/product-draft-publish.db.test.ts runs the function's
 * order against a held row; these cover what this module sends it.
 */

const mocks = vi.hoisted(() => ({
  serviceClient: null as unknown,
}));

vi.mock('server-only', () => ({}));
vi.mock('@nextblock-cms/db/server', () => ({
  getServiceRoleSupabaseClient: () => mocks.serviceClient,
}));

import { getInventoryItems, setSharedInventoryQuantity, syncSharedInventoryForSavedProduct } from './shared-inventory';

type RpcAnswer = { data?: unknown; error: { code?: string; message: string } | null };

/** A client whose rpc() answers from `answers` in turn (then success), and whose table calls are recorded. */
function makeClient(answers: RpcAnswer[] = [], tables: Record<string, unknown[]> = {}) {
  const calls = { rpc: [] as Array<{ fn: string; args: any }>, upsert: [] as Array<{ table: string; rows: any; options: any }> };
  const client = {
    rpc: vi.fn(async (fn: string, args: any) => {
      calls.rpc.push({ fn, args });
      return answers.shift() ?? { data: [], error: null };
    }),
    from: (table: string) => {
      const query: any = {
        select: () => query,
        in: () => query,
        order: () => query,
        upsert: async (rows: any, options: any) => {
          calls.upsert.push({ table, rows, options });
          return { error: null };
        },
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve({ data: tables[table] ?? [], error: null }).then(resolve, reject),
      };
      return query;
    },
  };
  return { client, calls };
}

beforeEach(() => {
  vi.useRealTimers();
});

describe('syncSharedInventoryForSavedProduct (createProduct)', () => {
  it("sends a new product's variant SKUs to upsert_inventory_items, trimmed, each once (the last quantity wins), for the database to take in SKU order", async () => {
    const { client, calls } = makeClient();
    mocks.serviceClient = client;
    await syncSharedInventoryForSavedProduct('product-1', {
      sku: 'PARENT',
      stock: 0,
      variants: [
        { sku: ' Z-1 ', stock_quantity: 4.9 },
        { sku: 'A-1', stock_quantity: -2 },
        { sku: 'Z-1', stock_quantity: 6 },
        { sku: '   ', stock_quantity: 9 },
      ],
    } as any);

    expect(calls.rpc).toEqual([
      {
        fn: 'upsert_inventory_items',
        args: {
          p_rows: [
            { sku: 'Z-1', quantity: 6 },
            { sku: 'A-1', quantity: 0 },
          ],
          p_on_conflict: 'update',
        },
      },
    ]);
    expect(calls.upsert).toEqual([]);
  });

  it("writes a product without variants under its own SKU", async () => {
    const { client, calls } = makeClient();
    mocks.serviceClient = client;
    await syncSharedInventoryForSavedProduct('product-1', { sku: ' SOLO ', stock: 3, variants: [] } as any);
    expect(calls.rpc[0].args).toEqual({ p_rows: [{ sku: 'SOLO', quantity: 3 }], p_on_conflict: 'update' });
  });

  it('tries a write that lost a lock race again (deadlock, serialization failure, lock timeout), three times at most', async () => {
    const { client, calls } = makeClient([
      { error: { code: '40P01', message: 'deadlock detected' } },
      { error: { code: '55P03', message: 'lock timeout' } },
    ]);
    mocks.serviceClient = client;
    await syncSharedInventoryForSavedProduct('product-1', { sku: 'S', stock: 1, variants: [] } as any);
    expect(calls.rpc).toHaveLength(3);

    const failing = makeClient([
      { error: { code: '40P01', message: 'deadlock detected' } },
      { error: { code: '40001', message: 'could not serialize access' } },
      { error: { code: '40P01', message: 'deadlock detected' } },
    ]);
    mocks.serviceClient = failing.client;
    await expect(syncSharedInventoryForSavedProduct('product-1', { sku: 'S', stock: 1, variants: [] } as any)).rejects.toMatchObject({
      message: 'deadlock detected',
      code: '40P01',
    });
    expect(failing.calls.rpc).toHaveLength(3);
  });

  it('throws any other refusal at once, with its code', async () => {
    const { client, calls } = makeClient([{ error: { code: '42501', message: 'new row violates row-level security policy' } }]);
    mocks.serviceClient = client;
    await expect(syncSharedInventoryForSavedProduct('product-1', { sku: 'S', stock: 1, variants: [] } as any)).rejects.toMatchObject({
      code: '42501',
    });
    expect(calls.rpc).toHaveLength(1);
  });

  it('falls back to the PostgREST upsert on a database without migration 02046 (the function unknown)', async () => {
    const { client, calls } = makeClient([{ error: { code: 'PGRST202', message: 'Could not find the function public.upsert_inventory_items' } }]);
    mocks.serviceClient = client;
    await syncSharedInventoryForSavedProduct('product-1', { sku: 'S', stock: 2, variants: [] } as any);
    expect(calls.upsert).toEqual([
      { table: 'inventory_items', rows: [{ sku: 'S', quantity: 2 }], options: { onConflict: 'sku', ignoreDuplicates: false } },
    ]);
  });
});

describe('setSharedInventoryQuantity (the Inventory screen)', () => {
  it('writes the one SKU through the function with the caller’s client', async () => {
    const { client, calls } = makeClient();
    mocks.serviceClient = null;
    await setSharedInventoryQuantity({ sku: ' SKU-1 ', stock: 12.7 }, client as any);
    expect(calls.rpc).toEqual([{ fn: 'upsert_inventory_items', args: { p_rows: [{ sku: 'SKU-1', quantity: 12 }], p_on_conflict: 'update' } }]);
  });
});

describe('getInventoryItems (the Inventory screen)', () => {
  it('creates only the rows still missing (a row a sale or a publish created since the read keeps its quantity)', async () => {
    const { client, calls } = makeClient([], {
      products: [
        {
          id: 'p1',
          title: 'Shirt',
          sku: 'SHIRT',
          stock: 9,
          status: 'active',
          languages: { code: 'en' },
          product_variants: [
            { id: 'v1', sku: 'SHIRT-B', stock_quantity: 4 },
            { id: 'v2', sku: 'SHIRT-A', stock_quantity: 5 },
          ],
        },
      ],
      inventory_items: [{ sku: 'SHIRT-A', quantity: 3 }],
    });
    await getInventoryItems(client as any);
    expect(calls.rpc).toEqual([{ fn: 'upsert_inventory_items', args: { p_rows: [{ sku: 'SHIRT-B', quantity: 4 }], p_on_conflict: 'nothing' } }]);

    // On a database without 02046, the PostgREST upsert ignores the rows that exist.
    const old = makeClient([{ error: { code: 'PGRST202', message: 'unknown function' } }], {
      products: [{ id: 'p2', title: 'Mug', sku: 'MUG', stock: 2, status: 'active', languages: null, product_variants: [] }],
      inventory_items: [],
    });
    await getInventoryItems(old.client as any);
    expect(old.calls.upsert).toEqual([
      { table: 'inventory_items', rows: [{ sku: 'MUG', quantity: 2 }], options: { onConflict: 'sku', ignoreDuplicates: true } },
    ]);
  });
});
