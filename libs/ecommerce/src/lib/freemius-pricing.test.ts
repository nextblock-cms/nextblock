import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ client: null as unknown }));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => mocks.client,
}));
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
// Credentials come from the stubbed env below, never from site_settings.
vi.mock('./payment-config', () => ({ hydrateFreemiusEnvFromDb: async () => undefined }));

import { getCouponQuote } from './coupon-server';
import {
  pickFreemiusPricingTier,
  resolveFreemiusBillingCycle,
} from './freemius-pricing';
import { resolveFreemiusUnitAmount } from './freemius-pricing-server';
import { FreemiusProvider } from './providers/freemius';
import type { CartItem } from './types';

type TableRows = Record<string, any[]>;

/**
 * A PostgREST-shaped query over in-memory rows. `order` and `limit` really sort and slice,
 * so a resolver that forgot its ORDER BY would pick whatever row was inserted first.
 */
class MockQuery {
  private filters: Array<(row: any) => boolean> = [];
  private sorts: Array<{ column: string; ascending: boolean; nullsFirst: boolean }> = [];
  private maxRows: number | null = null;
  private pendingUpdate: Record<string, unknown> | null = null;
  private inserted: any[] | null = null;

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
    const normalized = String(value).toLowerCase();
    this.filters.push((row) => String(row[column] || '').toLowerCase() === normalized);
    return this;
  }

  in(column: string, values: unknown[]) {
    const allowed = new Set(values);
    this.filters.push((row) => allowed.has(row[column]));
    return this;
  }

  order(column: string, options: { ascending?: boolean; nullsFirst?: boolean } = {}) {
    const ascending = options.ascending !== false;
    this.sorts.push({ column, ascending, nullsFirst: options.nullsFirst ?? !ascending });
    return this;
  }

  limit(count: number) {
    this.maxRows = count;
    return this;
  }

  insert(value: Record<string, unknown> | Record<string, unknown>[]) {
    const tableRows = this.rows[this.table];
    this.inserted = (Array.isArray(value) ? value : [value]).map((row) => ({
      id: `${this.table}_${tableRows.length + 1}`,
      ...row,
    }));
    tableRows.push(...this.inserted);
    return this;
  }

  update(value: Record<string, unknown>) {
    this.pendingUpdate = value;
    return this;
  }

  maybeSingle() {
    return Promise.resolve({ data: this.result()[0] ?? null, error: null });
  }

  single() {
    return Promise.resolve({ data: this.result()[0] ?? null, error: null });
  }

  then(resolve: (value: { data: any[]; error: null }) => void) {
    if (this.pendingUpdate) {
      for (const row of this.applyFilters()) {
        Object.assign(row, this.pendingUpdate);
      }
    }

    return Promise.resolve(resolve({ data: this.result(), error: null }));
  }

  private result() {
    if (this.inserted) {
      return this.inserted;
    }

    const sorted = [...this.applyFilters()].sort((a, b) => {
      for (const { column, ascending, nullsFirst } of this.sorts) {
        const left = a[column] ?? null;
        const right = b[column] ?? null;
        if (left === right) continue;
        if (left === null) return nullsFirst ? -1 : 1;
        if (right === null) return nullsFirst ? 1 : -1;
        const order = left < right ? -1 : 1;
        return ascending ? order : -order;
      }
      return 0;
    });

    return this.maxRows === null ? sorted : sorted.slice(0, this.maxRows);
  }

  private applyFilters() {
    return (this.rows[this.table] || []).filter((row) =>
      this.filters.every((filter) => filter(row))
    );
  }
}

const PRODUCT = 'prod-en';
const PRODUCT_FR = 'prod-fr';
const PLAN = 'plan-en';

/** The sync's `products.price`: the ANNUAL price, whatever cycle is bought. */
function freemiusProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: PRODUCT,
    translation_group_id: 'group-1',
    title: 'Plugin Pro',
    price: 19000,
    prices: {},
    sale_price: null,
    sale_prices: {},
    sale_start_at: null,
    sale_end_at: null,
    scheduled_price: null,
    scheduled_prices: {},
    scheduled_price_at: null,
    product_type: 'digital',
    payment_provider: 'freemius',
    freemius_product_id: '1234',
    freemius_plan_id: '5678',
    trial_period_days: 0,
    trial_requires_payment_method: false,
    ...overrides,
  };
}

/** Inserted highest quota first: only an ORDER BY makes the 1-license tier win. */
const PRICING_TIERS = [
  {
    id: 'tier-unlimited',
    plan_id: PLAN,
    license_quota: null,
    api_monthly_price: 9,
    api_annual_price: 90,
    api_lifetime_price: null,
    is_active: true,
  },
  {
    id: 'tier-5',
    plan_id: PLAN,
    license_quota: 5,
    api_monthly_price: 49,
    api_annual_price: 490,
    api_lifetime_price: null,
    is_active: true,
  },
  {
    id: 'tier-1',
    plan_id: PLAN,
    license_quota: 1,
    api_monthly_price: 19,
    api_annual_price: 190,
    api_lifetime_price: null,
    is_active: true,
  },
  {
    id: 'tier-1-retired',
    plan_id: PLAN,
    license_quota: 0,
    api_monthly_price: 1,
    api_annual_price: 1,
    api_lifetime_price: 1,
    is_active: false,
  },
];

function createMockClient(overrides: Partial<TableRows> = {}) {
  const rows: TableRows = {
    currencies: [
      { code: 'USD', symbol: '$', exchange_rate: 1, is_default: true, is_active: true },
      { code: 'EUR', symbol: '€', exchange_rate: 0.9, is_default: false, is_active: true },
    ],
    products: [freemiusProduct()],
    product_variants: [],
    freemius_plans: [{ id: PLAN, product_id: PRODUCT, name: 'pro', title: 'Pro' }],
    freemius_pricing: PRICING_TIERS.map((tier) => ({ ...tier })),
    coupons: [],
    coupon_products: [],
    coupon_redemptions: [],
    orders: [],
    order_items: [],
    product_freemius_sale_coupons: [],
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
      rpc(name: string) {
        return Promise.resolve(
          name === 'redeem_coupon_atomically'
            ? { data: true, error: null }
            : { data: null, error: { message: `Unknown function ${name}` } }
        );
      },
    },
  };
}

function cartLine(overrides: Partial<CartItem> = {}): CartItem {
  return {
    id: PRODUCT,
    product_id: PRODUCT,
    title: 'Plugin Pro',
    slug: 'plugin-pro',
    sku: 'FM-1234-5678',
    price: 1900,
    quantity: 1,
    language_id: 1,
    translation_group_id: 'group-1',
    product_type: 'digital',
    provider: 'freemius',
    ...overrides,
  } as CartItem;
}

const percentCoupon = {
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
};

describe('Freemius pricing tier and cycle rules', () => {
  it('picks the lowest active license quota whatever order the tiers arrive in', () => {
    expect(pickFreemiusPricingTier(PRICING_TIERS)?.id).toBe('tier-1');
    expect(pickFreemiusPricingTier([...PRICING_TIERS].reverse())?.id).toBe('tier-1');
    expect(pickFreemiusPricingTier([])).toBeNull();
  });

  it('breaks a quota tie by id, the way the server ORDER BY does', () => {
    const tiers = [
      { id: 'b', license_quota: 1 },
      { id: 'a', license_quota: 1 },
    ];
    expect(pickFreemiusPricingTier(tiers)?.id).toBe('a');
  });

  it('validates the requested cycle against what the tier sells', () => {
    const prices = { monthly: 19, annual: 190, lifetime: null };

    expect(resolveFreemiusBillingCycle('monthly', prices)).toEqual({ ok: true, cycle: 'monthly' });
    expect(resolveFreemiusBillingCycle(undefined, prices)).toEqual({ ok: true, cycle: 'annual' });
    expect(resolveFreemiusBillingCycle(undefined, { ...prices, annual: null })).toEqual({
      ok: true,
      cycle: 'monthly',
    });
    expect(resolveFreemiusBillingCycle('lifetime', prices)).toEqual({
      ok: false,
      reason: 'billing_cycle_not_offered',
    });
    for (const bogus of ['weekly', 'ANNUAL', 'annual&coupon=FREE', 12, {}]) {
      expect(resolveFreemiusBillingCycle(bogus, prices), String(bogus)).toEqual({
        ok: false,
        reason: 'invalid_billing_cycle',
      });
    }
  });
});

describe('resolveFreemiusUnitAmount', () => {
  async function resolve(
    billingCycle: unknown,
    options: { currencyCode?: string; overrides?: Partial<TableRows>; productId?: string } = {}
  ) {
    const { client, rows } = createMockClient(options.overrides);
    const product = rows.products.find((row) => row.id === (options.productId ?? PRODUCT));
    return resolveFreemiusUnitAmount({
      client: client as any,
      product,
      billingCycle,
      currencyCode: options.currencyCode ?? 'USD',
      currencies: rows.currencies,
    });
  }

  it('prices each cycle from the API price of the lowest-quota tier', async () => {
    expect(await resolve('monthly')).toMatchObject({
      ok: true,
      source: 'pricing',
      billingCycle: 'monthly',
      unitAmount: 1900,
    });
    expect(await resolve('annual')).toMatchObject({ billingCycle: 'annual', unitAmount: 19000 });
    expect(await resolve(undefined)).toMatchObject({ billingCycle: 'annual', unitAmount: 19000 });
  });

  it('charges the API price, not a display override', async () => {
    const result = await resolve('monthly', {
      overrides: {
        freemius_pricing: PRICING_TIERS.map((tier) =>
          tier.id === 'tier-1' ? { ...tier, override_monthly_price: 5 } : { ...tier }
        ),
      },
    });
    expect(result).toMatchObject({ unitAmount: 1900 });
  });

  it('converts into the selected currency', async () => {
    expect(await resolve('monthly', { currencyCode: 'EUR' })).toMatchObject({ unitAmount: 1710 });
  });

  it('reaches the plan through a translation sibling', async () => {
    const result = await resolve('monthly', {
      productId: PRODUCT_FR,
      overrides: {
        products: [freemiusProduct(), freemiusProduct({ id: PRODUCT_FR, title: 'Plugin Pro FR' })],
      },
    });
    expect(result).toMatchObject({ source: 'pricing', unitAmount: 1900 });
  });

  it('applies an active sale as the percent the Freemius sale coupon carries', async () => {
    // 19000 -> 15200 is 20 % off; Freemius takes 20 % off whichever cycle is bought.
    const result = await resolve('monthly', {
      overrides: { products: [freemiusProduct({ sale_price: 15200 })] },
    });
    expect(result).toMatchObject({ price: 1900, unitAmount: 1520 });
  });

  it('refuses an unknown cycle and a cycle the plan does not sell', async () => {
    expect(await resolve('weekly')).toEqual({ ok: false, reason: 'invalid_billing_cycle' });
    expect(await resolve('lifetime')).toEqual({ ok: false, reason: 'billing_cycle_not_offered' });
  });

  it('falls back to products.price only when the product has no pricing rows', async () => {
    const noPricing = { freemius_plans: [], freemius_pricing: [] };

    expect(await resolve('annual', { overrides: noPricing })).toEqual({
      ok: true,
      source: 'product',
      billingCycle: 'annual',
      price: 19000,
      unitAmount: 19000,
    });
    expect(await resolve(undefined, { overrides: noPricing })).toMatchObject({
      source: 'product',
      billingCycle: null,
      unitAmount: 19000,
    });
    expect(await resolve('weekly', { overrides: noPricing })).toEqual({
      ok: false,
      reason: 'invalid_billing_cycle',
    });
  });
});

describe('getCouponQuote on Freemius lines', () => {
  it('computes a percent coupon on the price of the cycle being bought', async () => {
    const { client } = createMockClient({ coupons: [{ ...percentCoupon }] });

    const monthly = await getCouponQuote({
      client: client as any,
      code: 'SAVE10',
      items: [cartLine({ billing_cycle: 'monthly' })],
      currencyCode: 'USD',
    });
    const annual = await getCouponQuote({
      client: client as any,
      code: 'SAVE10',
      items: [cartLine({ billing_cycle: 'annual' })],
      currencyCode: 'USD',
    });

    expect(monthly).toMatchObject({
      success: true,
      quote: { eligibleSubtotal: 1900, discountTotal: 190 },
    });
    expect(annual).toMatchObject({
      success: true,
      quote: { eligibleSubtotal: 19000, discountTotal: 1900 },
    });
  });

  it('looks a tier up once per quote however often a public caller repeats the line', async () => {
    const { client } = createMockClient({ coupons: [{ ...percentCoupon }] });
    const tables: string[] = [];
    const counting = {
      ...client,
      from(table: string) {
        tables.push(table);
        return client.from(table);
      },
    };
    const repeated = Array.from({ length: 50 }, (_, index) =>
      cartLine({ billing_cycle: (index % 2 ? 'monthly' : `bogus-${index}`) as any })
    );

    await getCouponQuote({
      client: counting as any,
      code: 'SAVE10',
      items: repeated,
      currencyCode: 'USD',
    });

    expect(tables.filter((table) => table === 'freemius_plans')).toHaveLength(1);
    expect(tables.filter((table) => table === 'freemius_pricing')).toHaveLength(1);
  });

  it('gives no discount to a line on a cycle the plan does not sell', async () => {
    const { client } = createMockClient({ coupons: [{ ...percentCoupon }] });

    const result = await getCouponQuote({
      client: client as any,
      code: 'SAVE10',
      items: [cartLine({ billing_cycle: 'lifetime' })],
      currencyCode: 'USD',
    });

    expect(result.success).toBe(false);
  });
});

describe('FreemiusProvider.createCheckoutSession pricing', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-test-key');
    vi.stubEnv('FREEMIUS_PUBLIC_KEY', 'pk_test_public');
    vi.stubEnv('FREEMIUS_SANDBOX_ENABLED', 'false');
    vi.stubEnv('FREEMIUS_CHECKOUT_PRODUCTS_JSON', '');
    vi.stubEnv('FREEMIUS_PRODUCT_ID', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    mocks.client = null;
  });

  async function checkout(
    line: CartItem,
    options: { overrides?: Partial<TableRows>; couponCode?: string } = {}
  ) {
    const mock = createMockClient(options.overrides);
    mocks.client = mock.client;
    const result = await new FreemiusProvider().createCheckoutSession({
      items: [line],
      billingAddress: { recipient_name: 'Guest Buyer', country_code: 'CA' },
      customerEmail: 'buyer@example.com',
      currencyCode: 'USD',
      couponCode: options.couponCode ?? null,
    });
    return { result, rows: mock.rows };
  }

  it('records a monthly purchase at the monthly price', async () => {
    const { result, rows } = await checkout(cartLine({ billing_cycle: 'monthly' }));

    expect(result.error).toBeUndefined();
    expect(rows.orders).toHaveLength(1);
    expect(rows.orders[0]).toMatchObject({ subtotal: 1900, total: 1900, discount_total: 0 });
    expect(rows.order_items[0]).toMatchObject({ price_at_purchase: 1900, quantity: 1 });
    expect(new URL(result.url as string).searchParams.get('billing_cycle')).toBe('monthly');
    expect(result.customProps).toMatchObject({ billing_cycle: 'monthly', plan_id: '5678' });
  });

  it('records the cycle Freemius defaults to when the cart line names none', async () => {
    const { result, rows } = await checkout(cartLine());

    expect(rows.orders[0]).toMatchObject({ subtotal: 19000, total: 19000 });
    expect(new URL(result.url as string).searchParams.get('billing_cycle')).toBe('annual');
  });

  it('computes a percent coupon on the cycle price', async () => {
    const { result, rows } = await checkout(cartLine({ billing_cycle: 'monthly' }), {
      couponCode: 'SAVE10',
      overrides: { coupons: [{ ...percentCoupon }] },
    });

    expect(result.error).toBeUndefined();
    expect(rows.orders[0]).toMatchObject({ subtotal: 1900, discount_total: 190, total: 1710 });
    expect(rows.coupon_redemptions[0]).toMatchObject({ discount_total: 190 });
  });

  it.each([
    ['an unknown cycle', 'weekly'],
    ['a cycle the plan does not sell', 'lifetime'],
  ])('rejects %s before recording an order', async (_label, billingCycle) => {
    const { result, rows } = await checkout(
      cartLine({ billing_cycle: billingCycle as CartItem['billing_cycle'] })
    );

    expect(result).toEqual({
      url: null,
      error: 'Your checkout items could not be processed.',
      errorKey: 'ecommerce.checkout_invalid_items',
      errorStatus: 400,
    });
    expect(rows.orders).toHaveLength(0);
  });

  it('still records products.price when the product has no pricing rows', async () => {
    const { result, rows } = await checkout(cartLine({ billing_cycle: 'monthly' }), {
      overrides: {
        products: [freemiusProduct({ price: 25000 })],
        freemius_plans: [],
        freemius_pricing: [],
      },
    });

    expect(result.error).toBeUndefined();
    expect(rows.orders[0]).toMatchObject({ subtotal: 25000, total: 25000 });
    expect(new URL(result.url as string).searchParams.get('billing_cycle')).toBe('monthly');
  });
});
