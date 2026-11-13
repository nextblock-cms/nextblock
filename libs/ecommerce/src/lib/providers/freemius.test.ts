import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: mocks.from }),
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
// The checkout reads its credentials from the environment after the order insert; none are
// configured here, so a run stops at the 503 right after the order and its items are recorded.
vi.mock('../payment-config', () => ({ hydrateFreemiusEnvFromDb: async () => undefined }));
vi.mock('../freemius-pricing-server', () => ({
  FREEMIUS_PRICED_PRODUCT_COLUMNS: 'id, price, prices, sale_price, sale_prices, sale_start_at, sale_end_at',
  resolveFreemiusUnitAmount: async () => ({
    ok: true,
    source: 'product',
    billingCycle: null,
    price: 25000,
    unitAmount: 25000,
  }),
}));

import type { CartItem } from '../types';
import { FreemiusProvider } from './freemius';

const PRODUCT_D = 'b3367bed-2d2e-459f-856c-9c5568fd8266';
const AFFILIATE_ID = '11111111-1111-4111-8111-111111111111';

function digitalLine(quantity: unknown): CartItem {
  return {
    id: PRODUCT_D,
    product_id: PRODUCT_D,
    title: 'Cortex AI - Pro',
    slug: 'cortex-ai-pro',
    sku: 'FM-28609-47122',
    price: 25000,
    language_id: 1,
    translation_group_id: 'g1',
    product_type: 'digital',
    provider: 'freemius',
    quantity,
  } as CartItem;
}

/** The slice of the PostgREST builder the Freemius checkout uses, over in-memory tables. */
function installFakeDatabase(options: { rejectOrderInsert?: (row: Row) => Record<string, unknown> | null } = {}) {
  const tables: Record<string, Row[]> = {
    currencies: [{ code: 'USD', symbol: '$', exchange_rate: 1, is_default: true, is_active: true }],
    products: [
      {
        id: PRODUCT_D,
        title: 'Cortex AI - Pro',
        price: 25000,
        prices: { USD: 25000 },
        sale_price: null,
        sale_prices: {},
        sale_start_at: null,
        sale_end_at: null,
        freemius_plan_id: '47122',
        freemius_product_id: '28609',
        trial_period_days: 0,
        trial_requires_payment_method: false,
      },
    ],
    orders: [],
    order_items: [],
  };
  const attempts: Row[] = [];

  mocks.from.mockImplementation((table: string) => {
    const filters: Array<(row: Row) => boolean> = [];
    let inserted: Row[] | null = null;
    let insertError: Record<string, unknown> | null = null;

    const resolve = () => {
      if (insertError) return { data: null, error: insertError };
      if (inserted) return { data: inserted, error: null };
      return { data: (tables[table] ?? []).filter((row) => filters.every((filter) => filter(row))), error: null };
    };

    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return builder;
      },
      order: () => builder,
      insert: (value: Row | Row[]) => {
        const rows = (Array.isArray(value) ? value : [value]).map((row, index) => ({
          id: `${table}-${(tables[table] ?? []).length + index + 1}`,
          ...row,
        }));
        if (table === 'orders') {
          attempts.push(...rows);
          insertError = options.rejectOrderInsert?.(rows[0]) ?? null;
        }
        if (!insertError) (tables[table] ??= []).push(...rows);
        inserted = rows;
        return builder;
      },
      update: () => builder,
      single: async () => {
        const result = resolve();
        const rows = Array.isArray(result.data) ? result.data : [];
        return result.error ? result : { data: rows[0] ?? null, error: rows[0] ? null : { message: 'no rows' } };
      },
      then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onFulfilled, onRejected),
    };

    return builder;
  });

  return { tables, attempts };
}

function checkout(overrides: Record<string, unknown> = {}) {
  return new FreemiusProvider().createCheckoutSession({
    items: [digitalLine(1)],
    customerEmail: 'buyer@example.test',
    billingAddress: { recipient_name: 'Guest Buyer', country_code: 'CA' },
    currencyCode: 'USD',
    ...overrides,
  });
}

describe('FreemiusProvider.createCheckoutSession quantities', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-test-key');
    mocks.from.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['a negative quantity', -1],
    ['a zero quantity', 0],
    ['a fractional quantity', 0.5],
    ['an absurd quantity', 1_000_000],
  ])('rejects %s before touching the database', async (_label, quantity) => {
    const result = await new FreemiusProvider().createCheckoutSession({
      items: [digitalLine(quantity)],
      billingAddress: { recipient_name: 'Guest', country_code: 'CA' },
    });

    expect(result).toEqual({
      url: null,
      error: 'Your checkout items could not be processed.',
      errorKey: 'ecommerce.checkout_invalid_items',
      errorStatus: 400,
    });
    expect(mocks.from).not.toHaveBeenCalled();
  });
});

describe('FreemiusProvider.createCheckoutSession affiliate attribution', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-test-key');
    mocks.from.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('records the attribution on the pending order', async () => {
    const { tables } = installFakeDatabase();

    const result = await checkout({
      attribution: { affiliateId: AFFILIATE_ID, source: 'referral_link', baseCurrency: 'USD' },
    });

    // No Freemius credentials in this environment: the shopper gets the keyed 503 after the insert.
    expect(result).toMatchObject({ url: null, errorKey: 'ecommerce.checkout_payments_unavailable', errorStatus: 503 });
    expect(tables.orders).toHaveLength(1);
    expect(tables.orders[0]).toMatchObject({
      status: 'pending',
      provider: 'freemius',
      affiliate_id: AFFILIATE_ID,
      affiliate_source: 'referral_link',
      affiliate_base_currency: 'USD',
    });
    expect(tables.order_items).toHaveLength(1);
  });

  it('adds no affiliate keys without an attribution', async () => {
    const { tables } = installFakeDatabase();

    await checkout();

    expect(Object.keys(tables.orders[0]).filter((key) => key.startsWith('affiliate'))).toEqual([]);
  });

  it.each([
    ['a sandbox checkout as test mode', 'true', false],
    ['a live checkout as live', '', true],
    ['any other flag value as live', 'yes', true],
  ])('records %s on the attributed order', async (_label, flag, livemode) => {
    vi.stubEnv('FREEMIUS_SANDBOX_ENABLED', flag);
    const { tables } = installFakeDatabase();

    await checkout({ attribution: { affiliateId: AFFILIATE_ID, source: 'storefront', baseCurrency: 'USD' } });

    expect(tables.orders[0]).toMatchObject({ affiliate_id: AFFILIATE_ID, affiliate_livemode: livemode });
  });

  it.each([
    ['PGRST204', "Could not find the 'affiliate_id' column of 'orders' in the schema cache"],
    ['42703', 'column "affiliate_source" of relation "orders" does not exist'],
  ])('retries the insert without the attribution columns on %s', async (code, message) => {
    const { tables, attempts } = installFakeDatabase({
      rejectOrderInsert: (row) => ('affiliate_id' in row ? { code, message } : null),
    });

    await checkout({ attribution: { affiliateId: AFFILIATE_ID, source: 'storefront', baseCurrency: 'USD' } });

    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toHaveProperty('affiliate_id', AFFILIATE_ID);
    expect(attempts[1]).not.toHaveProperty('affiliate_id');
    expect(tables.orders).toHaveLength(1);
    expect(tables.orders[0]).not.toHaveProperty('affiliate_id');
    expect(tables.order_items).toHaveLength(1);
  });
});
