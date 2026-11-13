import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Freemius coupon sync on the public sandbox (NEXT_PUBLIC_IS_SANDBOX=true), whose admin login
 * is published. The reset syncs the sandbox store from the operator's Freemius developer account,
 * so its products carry the operator's real product ids, and these functions call
 * api.freemius.com with the deployment's bearer (FREEMIUS_API_KEY). Until 2026-11-03 a visitor's
 * coupon save POSTed a live coupon (FREE100, 100% off) to the operator's real product, a sale
 * price of 0 a 100% sale coupon, and the remote coupon outlived the reset (which drops only the
 * mapping rows). On the sandbox nothing is requested and no mapping or sale-coupon row is
 * written; the coupon row says why (a Stripe-only coupon, which no Freemius sync concerns, ends
 * not_required as off the sandbox). Only the exact value 'true' is the sandbox.
 */

const mocks = vi.hoisted(() => ({
  hydrateFreemiusEnvFromDb: vi.fn(async () => undefined),
}));

vi.mock('server-only', () => ({}));
vi.mock('@nextblock-cms/db/server', async () => {
  // The real predicate (a dependency-free module): the env stub drives the refusal.
  const { isSandboxEnvironment } = await vi.importActual<{ isSandboxEnvironment: () => boolean }>(
    '../../../db/src/lib/config-resolve'
  );
  return {
    createClient: () => ({}),
    getServiceRoleSupabaseClient: () => ({}),
    isSandboxEnvironment,
  };
});
vi.mock('@nextblock-cms/utils', () => ({
  formatPrice: (amount: number, currencyCode?: string | null) => `${currencyCode || 'USD'} ${amount}`,
  getCurrencyMinorUnitFactor: () => 100,
  majorUnitAmountToMinor: (amount: number) => Math.round(amount * 100),
  minorUnitAmountToMajor: (amount: number) => amount / 100,
  normalizeCurrencyCode: (code?: string | null) => (code || 'USD').trim().toUpperCase(),
}));
vi.mock('./payment-config', () => ({ hydrateFreemiusEnvFromDb: mocks.hydrateFreemiusEnvFromDb }));

import {
  FREEMIUS_COUPON_SANDBOX_MESSAGE,
  deleteCouponFromFreemius,
  syncCouponToFreemius,
  syncProductSaleCouponToFreemius,
} from './freemius-coupons';

type Row = Record<string, any>;
type Operation = { table: string; op: 'select' | 'update' | 'upsert'; values?: Row };

/** One of the operator's real Freemius product ids, as the reset syncs it into the sandbox store. */
const OPERATOR_PRODUCT_ID = '24851';
const BEARER = 'operator-bearer';
const COUPONS_URL = `https://api.freemius.com/v1/products/${OPERATOR_PRODUCT_ID}/coupons`;

const COUPON = {
  id: 'coupon-1',
  code: 'FREE100',
  name: 'Everything free',
  internal_note: null,
  provider_scope: 'freemius',
  discount_type: 'percent',
  discount_amount: 100,
  is_active: true,
  starts_at: null,
  ends_at: null,
  redemption_limit: null,
  freemius_sync_status: 'pending',
  freemius_sync_error: null,
};

/** A Freemius product on sale at 0: the sale coupon would take 100% off. */
const PRODUCT = {
  id: 'product-1',
  sku: 'FM-24851-1',
  price: 4900,
  sale_price: 0,
  sale_start_at: null,
  sale_end_at: null,
  payment_provider: 'freemius',
  freemius_product_id: OPERATOR_PRODUCT_ID,
  freemius_plan_id: '40001',
};

/** A mapping that names a remote coupon (a visitor can write one over PostgREST as the demo admin). */
const MAPPING = {
  id: 'mapping-1',
  coupon_id: 'coupon-1',
  product_id: 'product-1',
  freemius_product_id: OPERATOR_PRODUCT_ID,
  freemius_coupon_id: 'operator-coupon-7',
  freemius_coupon_code: 'FREE100',
  sync_status: 'synced',
  sync_error: null,
};

/**
 * An in-memory client for the queries this module makes. `operations` logs every select, update
 * and upsert in order; `onFrom` runs on each `from(table)`.
 */
function createStore(seed: Partial<Record<string, Row[]>>, onFrom?: (table: string) => void) {
  const tables: Record<string, Row[]> = {
    coupons: [],
    coupon_products: [],
    coupon_freemius_mappings: [],
    products: [],
    product_freemius_sale_coupons: [],
    ...structuredClone(seed),
  };
  const operations: Operation[] = [];

  class Query {
    private readonly filters: Array<(row: Row) => boolean> = [];
    private pendingUpdate: Row | null = null;

    constructor(private readonly table: string) {}

    private matching() {
      return (tables[this.table] ?? []).filter((row) => this.filters.every((filter) => filter(row)));
    }

    select() {
      operations.push({ table: this.table, op: 'select' });
      return this;
    }

    eq(column: string, value: unknown) {
      this.filters.push((row) => row[column] === value);
      return this;
    }

    in(column: string, values: unknown[]) {
      this.filters.push((row) => values.includes(row[column]));
      return this;
    }

    not(column: string, operator: string, value: unknown) {
      if (operator === 'is' && value === null) {
        this.filters.push((row) => row[column] !== null && row[column] !== undefined);
      }
      return this;
    }

    update(values: Row) {
      operations.push({ table: this.table, op: 'update', values });
      this.pendingUpdate = values;
      return this;
    }

    upsert(values: Row, options: { onConflict: string }) {
      operations.push({ table: this.table, op: 'upsert', values });
      const keys = options.onConflict.split(',');
      const list = (tables[this.table] ??= []);
      const index = list.findIndex((row) =>
        values.id ? row.id === values.id : keys.every((key) => row[key] === values[key])
      );
      if (index >= 0) {
        list[index] = { ...list[index], ...values, id: list[index].id };
      } else {
        list.push({ ...values, id: values.id ?? `${this.table}-${list.length + 1}` });
      }
      return Promise.resolve({ data: null, error: null });
    }

    maybeSingle() {
      return Promise.resolve({ data: this.matching()[0] ?? null, error: null });
    }

    single() {
      const [row] = this.matching();
      return Promise.resolve(row ? { data: row, error: null } : { data: null, error: { message: 'No rows' } });
    }

    then<T>(resolve: (value: { data: Row[]; error: null }) => T, reject?: (reason: unknown) => T) {
      if (this.pendingUpdate) {
        for (const row of this.matching()) {
          Object.assign(row, this.pendingUpdate);
        }
      }
      return Promise.resolve({ data: this.matching(), error: null }).then(resolve, reject);
    }
  }

  return {
    tables,
    operations,
    client: {
      from(table: string) {
        onFrom?.(table);
        return new Query(table);
      },
    } as any,
  };
}

type FreemiusResponse = { ok: boolean; status: number; text: () => Promise<string> };

/** Freemius answering every request with a coupon. */
function stubFreemius(remoteCouponId = 'remote-coupon-1') {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<FreemiusResponse>>(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ id: remoteCouponId }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function requestBody(fetchMock: ReturnType<typeof stubFreemius>, call = 0) {
  return JSON.parse(String(fetchMock.mock.calls[call]?.[1]?.body ?? '{}'));
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  vi.stubEnv('FREEMIUS_API_KEY', BEARER);
  vi.stubEnv('FREEMIUS_CHECKOUT_PRODUCTS_JSON', '');
  mocks.hydrateFreemiusEnvFromDb.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Freemius coupons on the sandbox', () => {
  it('names the reason the coupon rows and the coupons screen show', () => {
    expect(FREEMIUS_COUPON_SANDBOX_MESSAGE).toBe(
      "Coupons aren't sent to Freemius in the sandbox: its checkout is simulated."
    );
  });

  it.each([
    ['a new coupon (POST)', [] as Row[]],
    ['a coupon with a remote mapping (PUT)', [MAPPING]],
  ])(
    'syncCouponToFreemius sends nothing for %s, reads only the coupon, no target, writes no mapping and marks the coupon not_synced',
    async (_label, mappings) => {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
      const fetchMock = stubFreemius();
      const store = createStore({
        coupons: [COUPON],
        products: [PRODUCT],
        coupon_freemius_mappings: mappings,
      });

      const result = await syncCouponToFreemius({ couponId: 'coupon-1', client: store.client });

      expect(result).toEqual({ success: true, targetCount: 0 });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mocks.hydrateFreemiusEnvFromDb).not.toHaveBeenCalled();
      expect(store.operations).toEqual([
        // The coupon's scope, and nothing else: no coupon_products, products or mapping read.
        { table: 'coupons', op: 'select' },
        {
          table: 'coupons',
          op: 'update',
          values: { freemius_sync_status: 'not_synced', freemius_sync_error: FREEMIUS_COUPON_SANDBOX_MESSAGE },
        },
      ]);
      expect(store.tables.coupon_freemius_mappings).toEqual(mappings);
      expect(store.tables.coupons).toEqual([
        { ...COUPON, freemius_sync_status: 'not_synced', freemius_sync_error: FREEMIUS_COUPON_SANDBOX_MESSAGE },
      ]);
    }
  );

  // A Stripe-only coupon has no Freemius target anywhere: it ends not_required with no error, as
  // off the sandbox. Every scope Freemius sells keeps the sandbox message.
  it.each([
    ['stripe', 'not_required with no error', { freemius_sync_status: 'not_required', freemius_sync_error: null }],
    ['all', 'not_synced with the message', { freemius_sync_status: 'not_synced', freemius_sync_error: FREEMIUS_COUPON_SANDBOX_MESSAGE }],
    ['freemius', 'not_synced with the message', { freemius_sync_status: 'not_synced', freemius_sync_error: FREEMIUS_COUPON_SANDBOX_MESSAGE }],
  ])('syncCouponToFreemius marks a %s-scoped coupon %s and sends nothing', async (scope, _label, status) => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const fetchMock = stubFreemius();
    // Pending, as every coupon save leaves it (a Stripe-only save writes not_required itself).
    const coupon = { ...COUPON, provider_scope: scope, freemius_sync_status: 'pending', freemius_sync_error: 'stale error' };
    const store = createStore({ coupons: [coupon], products: [PRODUCT], coupon_freemius_mappings: [MAPPING] });

    const result = await syncCouponToFreemius({ couponId: 'coupon-1', client: store.client });

    expect(result).toEqual({ success: true, targetCount: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.hydrateFreemiusEnvFromDb).not.toHaveBeenCalled();
    expect(store.operations).toEqual([
      { table: 'coupons', op: 'select' },
      { table: 'coupons', op: 'update', values: status },
    ]);
    expect(store.tables.coupon_freemius_mappings).toEqual([MAPPING]);
    expect(store.tables.coupons).toEqual([{ ...coupon, ...status }]);
  });

  it('syncProductSaleCouponToFreemius sends nothing and writes no sale-coupon row', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const fetchMock = stubFreemius();
    const store = createStore({ products: [PRODUCT] });

    const result = await syncProductSaleCouponToFreemius({ productId: 'product-1', client: store.client });

    expect(result).toEqual({ success: true, skipped: true, reason: 'sandbox' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.hydrateFreemiusEnvFromDb).not.toHaveBeenCalled();
    expect(store.operations).toEqual([]);
    expect(store.tables.product_freemius_sale_coupons).toEqual([]);
  });

  it('deleteCouponFromFreemius sends no DELETE, even for a mapping that names a remote coupon', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const fetchMock = stubFreemius();
    const store = createStore({ coupons: [COUPON], coupon_freemius_mappings: [MAPPING] });

    await expect(deleteCouponFromFreemius({ couponId: 'coupon-1', client: store.client })).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.hydrateFreemiusEnvFromDb).not.toHaveBeenCalled();
    expect(store.operations).toEqual([]);
    expect(store.tables.coupon_freemius_mappings).toEqual([MAPPING]);
  });

  // The module-internal helper every coupon request goes through, reached here via syncCouponToFreemius.
  describe('freemiusCouponRequest', () => {
    it('refuses on its own, before it hydrates credentials or fetches', async () => {
      // The flag turns on after syncCouponToFreemius passed its own check, as the request loop
      // starts: the helper still sends nothing.
      const fetchMock = stubFreemius();
      const store = createStore({ coupons: [COUPON], products: [PRODUCT] }, (table) => {
        if (table === 'coupon_freemius_mappings') {
          vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
        }
      });

      const result = await syncCouponToFreemius({ couponId: 'coupon-1', client: store.client });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(mocks.hydrateFreemiusEnvFromDb).not.toHaveBeenCalled();
      // The existing contract: a refused request is recorded on the mapping, never thrown.
      expect(result).toEqual({ success: true, targetCount: 1 });
      expect(store.tables.coupon_freemius_mappings).toEqual([
        expect.objectContaining({
          freemius_product_id: OPERATOR_PRODUCT_ID,
          freemius_coupon_id: null,
          sync_status: 'failed',
          sync_error: FREEMIUS_COUPON_SANDBOX_MESSAGE,
        }),
      ]);
    });
  });
});

describe('Freemius coupons off the sandbox (only the exact value "true" is the sandbox)', () => {
  const OFF_VALUES = ['', 'false', 'TRUE', '1'];

  it.each(OFF_VALUES)(
    'with NEXT_PUBLIC_IS_SANDBOX=%j syncCouponToFreemius POSTs the coupon with the bearer and records the mapping',
    async (value) => {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      const fetchMock = stubFreemius('remote-coupon-1');
      const store = createStore({ coupons: [COUPON], products: [PRODUCT] });

      const result = await syncCouponToFreemius({ couponId: 'coupon-1', client: store.client });

      expect(result).toEqual({ success: true, targetCount: 1 });
      expect(mocks.hydrateFreemiusEnvFromDb).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        `${COUPONS_URL}.json`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: `Bearer ${BEARER}` }),
        })
      );
      expect(requestBody(fetchMock)).toMatchObject({ code: 'FREE100', discount: 100, discount_type: 'percentage' });
      expect(store.tables.coupon_freemius_mappings).toEqual([
        expect.objectContaining({
          coupon_id: 'coupon-1',
          freemius_product_id: OPERATOR_PRODUCT_ID,
          freemius_coupon_id: 'remote-coupon-1',
          sync_status: 'synced',
        }),
      ]);
      expect(store.tables.coupons[0]).toMatchObject({ freemius_sync_status: 'synced', freemius_sync_error: null });
    }
  );

  it.each(OFF_VALUES)(
    'with NEXT_PUBLIC_IS_SANDBOX=%j syncCouponToFreemius sends nothing for a Stripe-only coupon and marks it not_required',
    async (value) => {
      // What the sandbox branch records for the same coupon.
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      const fetchMock = stubFreemius();
      const store = createStore({
        coupons: [{ ...COUPON, provider_scope: 'stripe', freemius_sync_error: 'stale error' }],
        products: [PRODUCT],
      });

      const result = await syncCouponToFreemius({ couponId: 'coupon-1', client: store.client });

      expect(result).toEqual({ success: true, targetCount: 0 });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(store.tables.coupon_freemius_mappings).toEqual([]);
      expect(store.tables.coupons[0]).toMatchObject({ freemius_sync_status: 'not_required', freemius_sync_error: null });
    }
  );

  it.each(OFF_VALUES)(
    'with NEXT_PUBLIC_IS_SANDBOX=%j syncProductSaleCouponToFreemius POSTs the sale coupon and records it',
    async (value) => {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      const fetchMock = stubFreemius('remote-sale-1');
      const store = createStore({ products: [PRODUCT] });

      const result = await syncProductSaleCouponToFreemius({ productId: 'product-1', client: store.client });

      expect(result).toEqual({ success: true, active: true, code: 'SALEFM248511' });
      expect(mocks.hydrateFreemiusEnvFromDb).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        `${COUPONS_URL}.json`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: `Bearer ${BEARER}` }),
        })
      );
      expect(requestBody(fetchMock)).toMatchObject({ code: 'SALEFM248511', discount: 100, plans: '40001' });
      expect(store.tables.product_freemius_sale_coupons).toEqual([
        expect.objectContaining({
          product_id: 'product-1',
          freemius_coupon_id: 'remote-sale-1',
          discount_percent: 100,
          sync_status: 'synced',
        }),
      ]);
    }
  );

  it.each(OFF_VALUES)(
    'with NEXT_PUBLIC_IS_SANDBOX=%j deleteCouponFromFreemius DELETEs the remote coupon and marks the mapping deleted',
    async (value) => {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      const fetchMock = stubFreemius();
      const store = createStore({ coupons: [COUPON], coupon_freemius_mappings: [MAPPING] });

      await deleteCouponFromFreemius({ couponId: 'coupon-1', client: store.client });

      expect(mocks.hydrateFreemiusEnvFromDb).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        `${COUPONS_URL}/operator-coupon-7.json`,
        expect.objectContaining({
          method: 'DELETE',
          headers: expect.objectContaining({ Authorization: `Bearer ${BEARER}` }),
        })
      );
      expect(store.tables.coupon_freemius_mappings).toEqual([
        expect.objectContaining({ id: 'mapping-1', sync_status: 'deleted', sync_error: null }),
      ]);
    }
  );
});
