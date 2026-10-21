import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@nextblock-cms/db/server', () => ({
  createClient: () => ({}),
  getServiceRoleSupabaseClient: () => ({}),
}));

vi.mock('@nextblock-cms/utils', () => ({
  formatPrice: (amount: number, currencyCode?: string | null) =>
    `${currencyCode || 'USD'} ${amount}`,
  getCurrencyMinorUnitFactor: () => 100,
  majorUnitAmountToMinor: (amount: number) => Math.round(amount * 100),
  minorUnitAmountToMajor: (amount: number) => amount / 100,
  normalizeCurrencyCode: (code?: string | null) => (code || 'USD').trim().toUpperCase(),
}));

vi.mock('server-only', () => ({}));

import {
  COUPON_VALIDATION_UNKNOWN_CLIENT_KEY,
  createCouponValidationThrottle,
  getCouponQuote,
  recordCouponRedemption,
  resolveCouponValidationThrottleKey,
} from './coupon-server';
import { syncCouponToFreemius } from './freemius-coupons';
import {
  COUPON_INVALID_ERROR_KEY,
  COUPON_INVALID_ERROR_MESSAGE,
  type CouponQuote,
  normalizeCouponCode,
} from './coupons';

type TableRows = Record<string, any[]>;

class MockQuery {
  private filters: Array<(row: any) => boolean> = [];
  private pendingUpdate: Record<string, unknown> | null = null;

  constructor(
    private readonly rows: TableRows,
    private readonly table: string
  ) {}

  select() {
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  ilike(column: string, value: string) {
    // Real ILIKE semantics: `%` and `_` are wildcards (PostgREST also maps `*` to `%`), so a
    // lookup that slips back to ilike fails the wildcard-code test below.
    const pattern = String(value)
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/[%*]/g, '.*')
      .replace(/_/g, '.');
    const re = new RegExp(`^${pattern}$`, 'i');
    this.filters.push((row) => re.test(String(row[column] || '')));
    return this;
  }

  in(column: string, values: unknown[]) {
    const allowed = new Set(values);
    this.filters.push((row) => allowed.has(row[column]));
    return this;
  }

  not(column: string, operator: string, value: unknown) {
    if (operator === 'is' && value === null) {
      this.filters.push((row) => row[column] !== null && row[column] !== undefined);
    }
    return this;
  }

  order() {
    return this;
  }

  insert(value: Record<string, unknown> | Record<string, unknown>[]) {
    const rows = Array.isArray(value) ? value : [value];
    this.rows[this.table].push(...rows);
    return Promise.resolve({ data: rows, error: null });
  }

  update(value: Record<string, unknown>) {
    this.pendingUpdate = value;
    return this;
  }

  upsert(value: Record<string, unknown>) {
    const tableRows = this.rows[this.table];
    const existingIndex =
      typeof value.id === 'string'
        ? tableRows.findIndex((row) => row.id === value.id)
        : tableRows.findIndex(
            (row) =>
              row.coupon_id === value.coupon_id &&
              row.freemius_product_id === value.freemius_product_id
          );

    if (existingIndex >= 0) {
      tableRows[existingIndex] = { ...tableRows[existingIndex], ...value };
    } else {
      tableRows.push({
        id: `${this.table}_${tableRows.length + 1}`,
        ...value,
      });
    }

    return Promise.resolve({ data: value, error: null });
  }

  maybeSingle() {
    return Promise.resolve({ data: this.applyFilters()[0] ?? null, error: null });
  }

  single() {
    return Promise.resolve({ data: this.applyFilters()[0] ?? null, error: null });
  }

  then(resolve: (value: { data: any[]; error: null }) => void) {
    if (this.pendingUpdate) {
      for (const row of this.applyFilters()) {
        Object.assign(row, this.pendingUpdate);
      }
    }

    return Promise.resolve(resolve({ data: this.applyFilters(), error: null }));
  }

  private applyFilters() {
    return (this.rows[this.table] || []).filter((row) =>
      this.filters.every((filter) => filter(row))
    );
  }
}

function createMockClient(
  overrides: Partial<TableRows> = {},
  options: { rpcError?: string } = {}
) {
  const rows: TableRows = {
    currencies: [
      {
        code: 'USD',
        symbol: '$',
        exchange_rate: 1,
        is_default: true,
        is_active: true,
      },
    ],
    coupons: [],
    coupon_products: [],
    coupon_freemius_mappings: [],
    coupon_redemptions: [],
    products: [
      {
        id: 'stripe-product',
        title: 'Theme Kit',
        price: 10000,
        prices: { USD: 10000 },
        sale_price: null,
        sale_prices: {},
        product_type: 'physical',
        payment_provider: 'stripe',
        freemius_product_id: null,
        freemius_plan_id: null,
      },
      {
        id: 'freemius-product',
        title: 'Plugin Pro',
        price: 20000,
        prices: { USD: 20000 },
        sale_price: null,
        sale_prices: {},
        product_type: 'digital',
        payment_provider: 'freemius',
        freemius_product_id: '1234',
        freemius_plan_id: '5678',
      },
    ],
    product_variants: [],
    ...overrides,
  };

  return {
    rows,
    client: {
      from(table: string) {
        if (!rows[table]) {
          rows[table] = [];
        }
        return new MockQuery(rows, table);
      },
      /**
       * Mirrors `public.redeem_coupon_atomically(uuid)` from migration 02022: one guarded
       * increment that returns true only while the count stays within redemption_limit, and
       * false (never null) for a missing, inactive or exhausted coupon.
       */
      rpc(name: string, args: Record<string, unknown>) {
        if (name !== 'redeem_coupon_atomically') {
          return Promise.resolve({ data: null, error: { message: `Unknown function ${name}` } });
        }

        if (options.rpcError) {
          return Promise.resolve({ data: null, error: { message: options.rpcError } });
        }

        const row = rows.coupons.find((candidate) => candidate.id === args.p_coupon_id);
        const redeemed = Boolean(
          row &&
            row.is_active &&
            (row.redemption_limit === null ||
              (row.redemptions_count ?? 0) < row.redemption_limit)
        );

        if (redeemed && row) {
          row.redemptions_count = (row.redemptions_count ?? 0) + 1;
        }

        return Promise.resolve({ data: redeemed, error: null });
      },
    },
  };
}

const mixedCart = [
  {
    id: 'stripe-product',
    product_id: 'stripe-product',
    title: 'Theme Kit',
    slug: 'theme-kit',
    sku: 'THEME',
    price: 10000,
    quantity: 2,
    language_id: 1,
    translation_group_id: 'stripe-product',
  },
  {
    id: 'freemius-product',
    product_id: 'freemius-product',
    title: 'Plugin Pro',
    slug: 'plugin-pro',
    sku: 'PLUGIN',
    price: 20000,
    quantity: 1,
    language_id: 1,
    translation_group_id: 'freemius-product',
  },
] as any[];

function coupon(overrides: Record<string, unknown>) {
  return {
    id: 'coupon-1',
    code: 'SAVE10',
    name: 'Save 10',
    provider_scope: 'all',
    discount_type: 'percent',
    discount_amount: 10,
    is_active: true,
    starts_at: null,
    ends_at: null,
    redemption_limit: null,
    redemptions_count: 0,
    ...overrides,
  };
}

describe('commerce coupon validation', () => {
  it('normalizes shopper-entered coupon codes', () => {
    expect(normalizeCouponCode(' save 10 ')).toBe('SAVE10');
    expect(normalizeCouponCode('Spring Sale')).toBe('SPRINGSALE');
  });

  /** Every way a looked-up code can be refused, plus a code that does not exist at all. */
  const rejectionCases: Array<{
    label: string;
    tables: Partial<TableRows>;
    detailedKey: string;
  }> = [
    { label: 'missing code', tables: { coupons: [] }, detailedKey: 'ecommerce.coupon_not_found' },
    {
      label: 'inactive',
      tables: { coupons: [coupon({ is_active: false })] },
      detailedKey: 'ecommerce.coupon_inactive',
    },
    {
      label: 'not started',
      tables: { coupons: [coupon({ starts_at: '2999-01-01T00:00:00.000Z' })] },
      detailedKey: 'ecommerce.coupon_not_started',
    },
    {
      label: 'expired',
      tables: { coupons: [coupon({ ends_at: '2000-01-01T00:00:00.000Z' })] },
      detailedKey: 'ecommerce.coupon_expired',
    },
    {
      label: 'exhausted',
      tables: { coupons: [coupon({ redemption_limit: 5, redemptions_count: 5 })] },
      detailedKey: 'ecommerce.coupon_limit_reached',
    },
    {
      label: 'wrong product scope',
      tables: {
        coupons: [coupon({})],
        coupon_products: [{ coupon_id: 'coupon-1', product_id: 'some-other-product' }],
      },
      detailedKey: 'ecommerce.coupon_not_applicable',
    },
    {
      label: 'wrong provider scope',
      tables: { coupons: [coupon({ provider_scope: 'freemius' })] },
      detailedKey: 'ecommerce.coupon_not_applicable',
    },
  ];

  it('treats LIKE wildcards in a shopper code literally (2026-10-21)', async () => {
    // `%`, `S%`, `SAVE1_` used to match (and so apply and enumerate) a secret code.
    const { client } = createMockClient({ coupons: [coupon({})] });
    for (const probe of ['%', 'S%', 'SAVE1_', '*']) {
      const result = await getCouponQuote({ client: client as any, code: probe, items: mixedCart, currencyCode: 'USD' });
      expect(result, probe).toMatchObject({ success: false, errorKey: COUPON_INVALID_ERROR_KEY });
    }
    const exact = await getCouponQuote({ client: client as any, code: 'save10', items: mixedCart, currencyCode: 'USD' });
    expect(exact.success).toBe(true);
  });

  it('answers every unusable code exactly like a code that does not exist', async () => {
    // The public validation action is unauthenticated, so any difference between these
    // replies is an oracle that confirms which codes exist (coupon-code-enum-oracle).
    const uniform = {
      success: false,
      error: COUPON_INVALID_ERROR_MESSAGE,
      errorKey: COUPON_INVALID_ERROR_KEY,
    };

    for (const testCase of rejectionCases) {
      const { client } = createMockClient(testCase.tables);
      const result = await getCouponQuote({
        client: client as any,
        code: 'SAVE10',
        items:
          testCase.label === 'wrong provider scope'
            ? mixedCart.filter((item) => item.product_id === 'stripe-product')
            : mixedCart,
        currencyCode: 'USD',
      });

      expect(result, testCase.label).toEqual(uniform);
    }
  });

  it('reveals the specific rejection reason only when detailedErrors is requested', async () => {
    for (const testCase of rejectionCases) {
      const { client } = createMockClient(testCase.tables);
      const result = await getCouponQuote({
        client: client as any,
        code: 'SAVE10',
        items:
          testCase.label === 'wrong provider scope'
            ? mixedCart.filter((item) => item.product_id === 'stripe-product')
            : mixedCart,
        currencyCode: 'USD',
        detailedErrors: true,
      });

      expect(result.success, testCase.label).toBe(false);
      if (!result.success) {
        expect(result.errorKey, testCase.label).toBe(testCase.detailedKey);
      }
    }
  });

  it('keeps the input-validation messages that precede the lookup', async () => {
    const { client } = createMockClient({ coupons: [coupon({})] });

    const empty = await getCouponQuote({ client: client as any, code: '  ', items: mixedCart });
    const noCart = await getCouponQuote({ client: client as any, code: 'SAVE10', items: [] });

    expect(empty).toMatchObject({ success: false, errorKey: 'ecommerce.coupon_code_required' });
    expect(noCart).toMatchObject({ success: false, errorKey: 'ecommerce.coupon_cart_empty' });
  });

  it('never touches the redemption counter while validating', async () => {
    const { client, rows } = createMockClient({
      coupons: [coupon({ redemption_limit: 1, redemptions_count: 0 })],
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await getCouponQuote({
        client: client as any,
        code: 'SAVE10',
        items: mixedCart,
        currencyCode: 'USD',
      });
      expect(result.success).toBe(true);
    }

    expect(rows.coupons[0].redemptions_count).toBe(0);
    expect(rows.coupon_redemptions).toHaveLength(0);
  });

  it('calculates percent discounts across mixed providers', async () => {
    const { client } = createMockClient({ coupons: [coupon({})] });
    const result = await getCouponQuote({
      client: client as any,
      code: 'save10',
      items: mixedCart,
      currencyCode: 'USD',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.quote.eligibleSubtotal).toBe(40000);
      expect(result.quote.discountTotal).toBe(4000);
      expect(result.quote.providerDiscounts).toEqual({
        stripe: 2000,
        freemius: 2000,
      });
    }
  });

  it('honors provider and product scopes', async () => {
    const { client } = createMockClient({
      coupons: [coupon({ provider_scope: 'all', discount_amount: 25 })],
      coupon_products: [{ coupon_id: 'coupon-1', product_id: 'stripe-product' }],
    });
    const result = await getCouponQuote({
      client: client as any,
      code: 'SAVE10',
      items: mixedCart,
      currencyCode: 'USD',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.quote.eligibleSubtotal).toBe(20000);
      expect(result.quote.discountTotal).toBe(5000);
      expect(result.quote.providerDiscounts).toEqual({
        stripe: 5000,
        freemius: 0,
      });
    }
  });

  it('allocates fixed discounts proportionally across eligible lines', async () => {
    const { client } = createMockClient({
      coupons: [coupon({ discount_type: 'fixed', discount_amount: 5000 })],
    });
    const result = await getCouponQuote({
      client: client as any,
      code: 'SAVE10',
      items: mixedCart,
      currencyCode: 'USD',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.quote.discountTotal).toBe(5000);
      expect(result.quote.providerDiscounts).toEqual({
        stripe: 2500,
        freemius: 2500,
      });
    }
  });
});

describe('commerce coupon redemption', () => {
  const quote: CouponQuote = {
    couponId: 'coupon-1',
    code: 'SAVE10',
    name: 'Save 10',
    discountType: 'percent',
    discountAmount: 10,
    providerScope: 'all',
    eligibleSubtotal: 40000,
    discountTotal: 4000,
    providerDiscounts: { stripe: 2000, freemius: 2000 },
    lineDiscounts: [],
  };

  function redeem(client: unknown, orderId: string) {
    return recordCouponRedemption({
      client: client as any,
      quote,
      orderId,
      provider: 'stripe',
      discountTotal: 4000,
      userId: null,
      customerEmail: 'shopper@example.com',
    });
  }

  it('reserves the slot through the atomic RPC and records the redemption', async () => {
    const { client, rows } = createMockClient({
      coupons: [coupon({ redemption_limit: 5, redemptions_count: 0 })],
    });

    const result = await redeem(client, 'order-1');

    expect(result).toEqual({ success: true, alreadyRecorded: false });
    expect(rows.coupons[0].redemptions_count).toBe(1);
    expect(rows.coupon_redemptions).toEqual([
      expect.objectContaining({
        coupon_id: 'coupon-1',
        order_id: 'order-1',
        coupon_code: 'SAVE10',
        provider: 'stripe',
        discount_total: 4000,
        customer_email: 'shopper@example.com',
      }),
    ]);
  });

  it('refuses an exhausted coupon without recording a redemption', async () => {
    const { client, rows } = createMockClient({
      coupons: [coupon({ redemption_limit: 1, redemptions_count: 1 })],
    });

    const result = await redeem(client, 'order-2');

    expect(result).toEqual({
      success: false,
      reason: 'limit_reached',
      error: COUPON_INVALID_ERROR_MESSAGE,
      errorKey: COUPON_INVALID_ERROR_KEY,
    });
    expect(rows.coupons[0].redemptions_count).toBe(1);
    expect(rows.coupon_redemptions).toHaveLength(0);
  });

  it('caps concurrent checkouts at the redemption limit', async () => {
    // The repro: 20 parallel guest checkouts of a limit=1 coupon produced 7 redemption rows
    // because each read the lagging counter and wrote count+1 as a literal. The counter now
    // moves only inside the guarded RPC, so exactly `limit` callers win.
    const { client, rows } = createMockClient({
      coupons: [coupon({ redemption_limit: 2, redemptions_count: 0 })],
    });

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) => redeem(client, `order-${index}`))
    );

    expect(results.filter((result) => result.success)).toHaveLength(2);
    expect(
      results.filter((result) => !result.success && result.reason === 'limit_reached')
    ).toHaveLength(18);
    expect(rows.coupons[0].redemptions_count).toBe(2);
    expect(rows.coupon_redemptions).toHaveLength(2);
  });

  it('does not take a second slot for an order that already holds a redemption', async () => {
    const { client, rows } = createMockClient({
      coupons: [coupon({ redemption_limit: 5, redemptions_count: 0 })],
    });

    const first = await redeem(client, 'order-1');
    const second = await redeem(client, 'order-1');

    expect(first).toEqual({ success: true, alreadyRecorded: false });
    expect(second).toEqual({ success: true, alreadyRecorded: true });
    expect(rows.coupons[0].redemptions_count).toBe(1);
    expect(rows.coupon_redemptions).toHaveLength(1);
  });

  it('treats a deactivated coupon as exhausted at redemption time', async () => {
    const { client, rows } = createMockClient({
      coupons: [coupon({ is_active: false, redemption_limit: null })],
    });

    const result = await redeem(client, 'order-1');

    expect(result).toMatchObject({ success: false, reason: 'limit_reached' });
    expect(rows.coupon_redemptions).toHaveLength(0);
  });

  it('reports an RPC failure without recording anything', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { client, rows } = createMockClient(
      { coupons: [coupon({ redemption_limit: 5, redemptions_count: 0 })] },
      { rpcError: 'permission denied for function redeem_coupon_atomically' }
    );

    const result = await redeem(client, 'order-1');

    expect(result).toMatchObject({ success: false, reason: 'error' });
    expect(rows.coupons[0].redemptions_count).toBe(0);
    expect(rows.coupon_redemptions).toHaveLength(0);
    errorSpy.mockRestore();
  });
});

describe('coupon validation throttle', () => {
  it('allows a burst up to capacity and then refills over time', () => {
    const throttle = createCouponValidationThrottle({ capacity: 3, refillPerSecond: 1 });
    const key = '203.0.113.10';

    expect(throttle.consume(key, 0)).toBe(true);
    expect(throttle.consume(key, 0)).toBe(true);
    expect(throttle.consume(key, 0)).toBe(true);
    expect(throttle.consume(key, 0)).toBe(false);

    // One second later exactly one token has come back.
    expect(throttle.consume(key, 1000)).toBe(true);
    expect(throttle.consume(key, 1000)).toBe(false);

    // A long idle refills to capacity, never beyond it.
    expect(throttle.consume(key, 60_000)).toBe(true);
    expect(throttle.consume(key, 60_000)).toBe(true);
    expect(throttle.consume(key, 60_000)).toBe(true);
    expect(throttle.consume(key, 60_000)).toBe(false);
  });

  it('keeps one client from spending another client\'s tokens', () => {
    const throttle = createCouponValidationThrottle({ capacity: 1, refillPerSecond: 1 });

    expect(throttle.consume('203.0.113.1', 0)).toBe(true);
    expect(throttle.consume('203.0.113.1', 0)).toBe(false);
    expect(throttle.consume('203.0.113.2', 0)).toBe(true);
  });

  it('bounds its memory by evicting idle buckets first', () => {
    const throttle = createCouponValidationThrottle({
      capacity: 2,
      refillPerSecond: 1,
      maxBuckets: 2,
    });

    throttle.consume('a', 0);
    throttle.consume('b', 0);
    expect(throttle.size).toBe(2);

    // Both existing buckets have been idle long enough to be full, so they go first.
    throttle.consume('c', 10_000);
    expect(throttle.size).toBe(1);

    // Nothing idle: the oldest entry is dropped so the newest fits.
    throttle.consume('d', 10_000);
    throttle.consume('e', 10_000);
    expect(throttle.size).toBeLessThanOrEqual(2);
  });

  it('keys on the proxy-set address and throttles unknown origins together', () => {
    const headersOf = (values: Record<string, string>) => ({
      get: (name: string) => values[name.toLowerCase()] ?? null,
    });

    expect(
      resolveCouponValidationThrottleKey(
        headersOf({
          'x-vercel-forwarded-for': '198.51.100.9',
          'x-real-ip': '198.51.100.8',
          'x-forwarded-for': '10.0.0.1, 198.51.100.7',
        })
      )
    ).toBe('198.51.100.9');
    expect(
      resolveCouponValidationThrottleKey(
        headersOf({ 'x-real-ip': '198.51.100.8', 'x-forwarded-for': '10.0.0.1' })
      )
    ).toBe('198.51.100.8');
    expect(
      resolveCouponValidationThrottleKey(headersOf({ 'x-forwarded-for': ' 10.0.0.1 , 10.0.0.2' }))
    ).toBe('10.0.0.1');
    expect(resolveCouponValidationThrottleKey(headersOf({}))).toBe(
      COUPON_VALIDATION_UNKNOWN_CLIENT_KEY
    );
    expect(resolveCouponValidationThrottleKey(headersOf({ 'x-forwarded-for': ' , ' }))).toBe(
      COUPON_VALIDATION_UNKNOWN_CLIENT_KEY
    );
  });
});

describe('Freemius coupon sync', () => {
  beforeEach(() => {
    process.env.FREEMIUS_API_KEY = 'test-token';
    vi.restoreAllMocks();
  });

  it('creates Freemius coupons with product-scoped payloads and stores mappings', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ coupon: { id: 'remote-coupon-1' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { client, rows } = createMockClient({
      coupons: [coupon({ provider_scope: 'freemius', discount_amount: 15 })],
    });

    const result = await syncCouponToFreemius({
      client: client as any,
      couponId: 'coupon-1',
    });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.freemius.com/v1/products/1234/coupons.json',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
        body: expect.stringContaining('"discount_type":"percentage"'),
      })
    );
    expect(rows.coupon_freemius_mappings[0]).toMatchObject({
      coupon_id: 'coupon-1',
      freemius_product_id: '1234',
      freemius_coupon_id: 'remote-coupon-1',
      sync_status: 'synced',
    });
    expect(rows.coupons[0].freemius_sync_status).toBe('synced');
  });

  it('captures Freemius sync errors without throwing away local coupon changes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ message: 'Invalid coupon payload' }),
      })
    );
    const { client, rows } = createMockClient({
      coupons: [coupon({ provider_scope: 'freemius' })],
    });

    const result = await syncCouponToFreemius({
      client: client as any,
      couponId: 'coupon-1',
    });

    expect(result.success).toBe(true);
    expect(rows.coupon_freemius_mappings[0]).toMatchObject({
      sync_status: 'failed',
      sync_error: 'Invalid coupon payload',
    });
    expect(rows.coupons[0].freemius_sync_status).toBe('failed');
  });

  it('converts fixed minor-unit coupons to major amounts for Freemius payloads', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ coupon: { id: 'remote-coupon-2' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { client } = createMockClient({
      coupons: [
        coupon({
          provider_scope: 'freemius',
          discount_type: 'fixed',
          discount_amount: 1000,
        }),
      ],
    });

    await syncCouponToFreemius({
      client: client as any,
      couponId: 'coupon-1',
    });

    const request = fetchMock.mock.calls[0]?.[1] as { body?: string };
    expect(JSON.parse(request.body || '{}')).toMatchObject({
      discount: 10,
      discount_type: 'dollar',
    });
  });
});
