import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  // The coupon slot: `redeem_coupon_atomically`, which never gives a slot back.
  rpc: vi.fn<(name: string, args: Record<string, unknown>) => Promise<{ data: boolean; error: null }>>(async () => ({
    data: true,
    error: null,
  })),
  // No developer key pair unless a test configures one.
  developerCandidates: vi.fn<() => Promise<Array<Record<string, string>>>>(async () => []),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: mocks.from, rpc: mocks.rpc }),
}));
vi.mock('@nextblock-cms/db/server', async () => {
  const { isSandboxEnvironment } = await vi.importActual<{ isSandboxEnvironment: () => boolean }>(
    '../../../../db/src/lib/config-resolve'
  );
  return {
    createClient: () => ({}),
    getServiceRoleSupabaseClient: () => ({}),
    isSandboxEnvironment,
  };
});
vi.mock('server-only', () => ({}));
// The checkout resolves its keys (developer pair, then the configured names) BEFORE it writes the
// order; a test that needs the order written configures keys, and without any the run stops at the
// keyed 503 with nothing written.
vi.mock('../payment-config', () => ({
  hydrateFreemiusEnvFromDb: async () => undefined,
  resolveFreemiusDeveloperCredentialCandidates: mocks.developerCandidates,
}));
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

import { createHash } from 'node:crypto';

import { forgetFreemiusDeveloperCaches, getFreemiusDeveloperStatus } from '../freemius-developer-api';
import type { CartItem } from '../types';
import { FreemiusProvider, resolveFreemiusProductCredentials, syncFreemiusProductsToSupabase } from './freemius';

const PRODUCT_D = 'b3367bed-2d2e-459f-856c-9c5568fd8266';
const AFFILIATE_ID = '11111111-1111-4111-8111-111111111111';
const COUPON_ID = '22222222-2222-4222-8222-222222222222';
/** Every FREEMIUS_* name the checkout reads keys or modes from (blanked per test, then set as needed). */
const FREEMIUS_ENV_NAMES = [
  'FREEMIUS_PUBLIC_KEY',
  'FREEMIUS_SECRET_KEY',
  'FREEMIUS_API_KEY',
  'FREEMIUS_PRODUCT_ID',
  'FREEMIUS_CHECKOUT_PRODUCTS_JSON',
  'FREEMIUS_SANDBOX_ENABLED',
  'FREEMIUS_ECOMMERCE_SANDBOX_PUBLIC_KEY',
  'FREEMIUS_ECOMMERCE_SANDBOX_SECRET_KEY',
];
/** A limited coupon with one slot left: a spent slot is never given back. */
const LIMITED_COUPON: Row = {
  id: COUPON_ID,
  code: 'LAUNCH10',
  name: 'Launch',
  provider_scope: 'freemius',
  discount_type: 'percent',
  discount_amount: 10,
  is_active: true,
  starts_at: null,
  ends_at: null,
  redemption_limit: 5,
  redemptions_count: 4,
};

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

/** The slice of the PostgREST builder the Freemius checkout (and its coupon quote) uses, over in-memory tables. */
function installFakeDatabase(
  options: { rejectOrderInsert?: (row: Row) => Record<string, unknown> | null; coupons?: Row[] } = {}
) {
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
        product_type: 'digital',
        payment_provider: 'freemius',
        freemius_plan_id: '47122',
        freemius_product_id: '28609',
        trial_period_days: 0,
        trial_requires_payment_method: false,
      },
    ],
    coupons: options.coupons ?? [],
    orders: [],
    order_items: [],
  };
  const attempts: Row[] = [];
  /** Every write sent to any table, in order: a checkout that cannot open must send none. */
  const writes: Array<{ table: string; op: string; value: unknown }> = [];

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
      in: (column: string, values: unknown[]) => {
        filters.push((row) => values.includes(row[column]));
        return builder;
      },
      order: () => builder,
      insert: (value: Row | Row[]) => {
        writes.push({ table, op: 'insert', value });
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
      update: (value: unknown) => {
        writes.push({ table, op: 'update', value });
        return builder;
      },
      upsert: (value: unknown) => {
        writes.push({ table, op: 'upsert', value });
        return builder;
      },
      delete: () => {
        writes.push({ table, op: 'delete', value: null });
        return builder;
      },
      single: async () => {
        const result = resolve();
        const rows = Array.isArray(result.data) ? result.data : [];
        return result.error ? result : { data: rows[0] ?? null, error: rows[0] ? null : { message: 'no rows' } };
      },
      maybeSingle: async () => {
        const result = resolve();
        const rows = Array.isArray(result.data) ? result.data : [];
        return result.error ? result : { data: rows[0] ?? null, error: null };
      },
      then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onFulfilled, onRejected),
    };

    return builder;
  });

  return { tables, attempts, writes };
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

/**
 * The checkout's log lines are written at most once per product per minute, a memory that lasts the
 * module's life: each test runs ten minutes after the previous one, so no line of one test silences
 * another's.
 */
let clock = Date.parse('2026-11-13T12:00:00Z');

beforeEach(() => {
  clock += 10 * 60_000;
  vi.useFakeTimers({ now: clock, toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

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
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
    for (const name of FREEMIUS_ENV_NAMES) {
      vi.stubEnv(name, '');
    }
    // The store's configured checkout keys (no developer pair): read before the order is written.
    vi.stubEnv('FREEMIUS_PUBLIC_KEY', 'pk_store_checkout');
    vi.stubEnv('FREEMIUS_SECRET_KEY', 'sk_store_checkout');
    mocks.from.mockReset();
    mocks.rpc.mockClear();
    mocks.developerCandidates.mockReset().mockImplementation(async () => []);
    forgetFreemiusDeveloperCaches();
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

    expect(result.url).toMatch(/^https:\/\/checkout\.freemius\.com\/app\/28609\/plan\/47122\//);
    expect(result.customProps).toMatchObject({ public_key: 'pk_store_checkout', credential_source: 'legacy-env' });
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

/**
 * nextblock.dev opens the checkout of every product with that product's own public key (and, in
 * Freemius sandbox mode, a token from its own keys), read with the developer key pair: no
 * FREEMIUS_CHECKOUT_PRODUCTS_JSON and no API key needed.
 */
describe('FreemiusProvider.createCheckoutSession with the developer key pair', () => {
  const DEV = '4242';
  const PAIR = { developerId: DEV, publicKey: 'pk_dev_checkout', secretKey: 'sk_dev_checkout', source: 'env' };

  function stubFreemius(options: { productRead?: { status: number; body?: unknown } } = {}) {
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url).replace(`https://api.freemius.com/v1/developers/${DEV}`, '');
      if (path.startsWith('/plugins.json')) {
        return new Response(JSON.stringify({ plugins: [{ id: 24851 }, { id: 28609 }, { id: 43273 }] }), { status: 200 });
      }
      if (path === '/plugins/28609.json') {
        const answer = options.productRead ?? { status: 200, body: { id: 28609, public_key: 'pk_cortex_product', secret_key: 'sk_cortex_product' } };
        return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-test-key');
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
    for (const name of FREEMIUS_ENV_NAMES) {
      vi.stubEnv(name, '');
    }
    mocks.from.mockReset();
    mocks.rpc.mockClear();
    mocks.developerCandidates.mockReset().mockImplementation(async () => [PAIR]);
    forgetFreemiusDeveloperCaches();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('opens the checkout with the product’s own public key', async () => {
    stubFreemius();
    installFakeDatabase();

    const result = await checkout();

    expect(result.url).toMatch(/^https:\/\/checkout\.freemius\.com\/app\/28609\/plan\/47122\//);
    expect(result.customProps).toMatchObject({
      provider: 'freemius',
      plugin_id: '28609',
      public_key: 'pk_cortex_product',
      credential_source: 'developer-api',
      sandbox: false,
    });
    expect(JSON.stringify(result)).not.toContain('sk_');
  });

  it('builds the Freemius sandbox token from the product’s own keys, without an API key', async () => {
    vi.stubEnv('FREEMIUS_SANDBOX_ENABLED', 'true');
    stubFreemius();
    installFakeDatabase();

    const result = await checkout();
    const sandbox = result.customProps?.sandbox as { ctx: string; token: string };

    expect(sandbox.token).toBe(createHash('md5').update(`${sandbox.ctx}28609sk_cortex_productpk_cortex_productcheckout`).digest('hex'));
    const url = new URL(String(result.url));
    expect(url.searchParams.get('sandbox')).toBe(sandbox.token);
    expect(url.searchParams.get('s_ctx_ts')).toBe(sandbox.ctx);
  });

  it('falls back to the configured keys when Freemius cannot be reached (none here: the keyed 503)', async () => {
    stubFreemius({ productRead: { status: 503 } });
    installFakeDatabase();

    await expect(checkout()).resolves.toMatchObject({ url: null, errorKey: 'ecommerce.checkout_payments_unavailable', errorStatus: 503 });
  });

  // Readiness can be green from a cached verdict while the product-key read (a network call) fails.
  // The 503 must then come before the pending order and the coupon redemption: an order left
  // pending forever and a limited coupon's slot spent on every retry (correctness review, finding 4).
  it.each([
    ['fails (Freemius answers 503)', { status: 503 }],
    ['finds no keys (Freemius answers 404)', { status: 404 }],
  ])('creates no order and spends no coupon redemption when the product-key read %s', async (_label, productRead) => {
    stubFreemius({ productRead });
    const { tables, attempts, writes } = installFakeDatabase({ coupons: [LIMITED_COUPON] });

    const result = await checkout({ couponCode: 'launch10' });

    expect(result).toMatchObject({ url: null, errorKey: 'ecommerce.checkout_payments_unavailable', errorStatus: 503 });
    expect(attempts).toEqual([]);
    expect(writes).toEqual([]);
    expect(tables.orders).toEqual([]);
    expect(tables.order_items).toEqual([]);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('writes nothing either without any checkout keys (no developer pair, nothing configured)', async () => {
    mocks.developerCandidates.mockImplementation(async () => []);
    const fetchMock = stubFreemius();
    const { writes } = installFakeDatabase({ coupons: [LIMITED_COUPON] });

    await expect(checkout({ couponCode: 'launch10' })).resolves.toMatchObject({ url: null, errorStatus: 503 });
    expect(writes).toEqual([]);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('with the product’s keys, the same coupon checkout records the order and takes exactly one redemption', async () => {
    stubFreemius();
    const { tables } = installFakeDatabase({ coupons: [LIMITED_COUPON] });

    const result = await checkout({ couponCode: 'launch10' });

    expect(new URL(String(result.url)).searchParams.get('coupon')).toBe('LAUNCH10');
    expect(tables.orders).toHaveLength(1);
    expect(tables.orders[0]).toMatchObject({ status: 'pending', coupon_id: COUPON_ID, coupon_code: 'LAUNCH10', discount_total: 2500, total: 22500 });
    expect(tables.order_items).toHaveLength(1);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith('redeem_coupon_atomically', { p_coupon_id: COUPON_ID });
    expect(tables.coupon_redemptions).toEqual([expect.objectContaining({ coupon_id: COUPON_ID, order_id: tables.orders[0].id })]);
  });
});

/**
 * Review 2026-11-13, round 2 (major): a failed product-key read fell back to the configured names,
 * and with FREEMIUS_PUBLIC_KEY / FREEMIUS_SECRET_KEY holding the developer pair (nextblock.dev) the
 * checkout opened with the developer public key in the buyer's browser, wrote the pending order and
 * spent the coupon slot. The checkout now follows the webhook's key policy (freemius-key-policy.ts):
 * bound keys always, the one-product keys only where they may stand in.
 */
describe('FreemiusProvider.createCheckoutSession key policy', () => {
  const DEV = '4242';
  const PAIR = { developerId: DEV, publicKey: 'pk_dev_master', secretKey: 'sk_dev_master', source: 'env' };
  const ONE_PRODUCT = { publicKey: 'pk_one_product', secretKey: 'sk_one_product' };
  const LEGACY_ONLY = { developerId: DEV, ...ONE_PRODUCT, source: 'env-legacy' };

  /**
   * api.freemius.com: the list answers `list` (the account's ids on a 200), 28609's key read answers
   * `productRead`, and a product-scope read of a product (the one-product keys confirmation)
   * answers `productScope(id)`, 401 by default, with `productScopeBody(id)` as its 200 body (the
   * product's id by default).
   */
  function stubFreemius(
    options: {
      list?: number;
      listed?: number[];
      productRead?: number;
      productScope?: (productId: string) => number;
      productScopeBody?: (productId: string) => unknown;
    } = {}
  ) {
    const fetchMock = vi.fn(async (url: string) => {
      const productScope = String(url).match(/^https:\/\/api\.freemius\.com\/v1\/plugins\/(\d+)\.json$/);
      if (productScope) {
        const status = options.productScope?.(productScope[1]) ?? 401;
        const body = status === 200 ? (options.productScopeBody ? options.productScopeBody(productScope[1]) : { id: Number(productScope[1]) }) : {};
        return new Response(JSON.stringify(body), { status });
      }
      const path = String(url).replace(`https://api.freemius.com/v1/developers/${DEV}`, '');
      if (path.startsWith('/plugins.json')) {
        const status = options.list ?? 200;
        const body = status === 200 ? { plugins: (options.listed ?? [24851, 28609, 43273]).map((id) => ({ id })) } : { error: { code: 'x' } };
        return new Response(JSON.stringify(body), { status });
      }
      if (path === '/plugins/28609.json') {
        const status = options.productRead ?? 200;
        const body = status === 200 ? { id: 28609, public_key: 'pk_cortex_product', secret_key: 'sk_cortex_product' } : {};
        return new Response(JSON.stringify(body), { status });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function expectNothingWritten(result: Awaited<ReturnType<typeof checkout>>, writes: unknown[]) {
    expect(result).toMatchObject({ url: null, errorKey: 'ecommerce.checkout_payments_unavailable', errorStatus: 503 });
    expect(result.customProps).toBeUndefined();
    expect(writes).toEqual([]);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(PAIR.publicKey);
  }

  function expectOpenedWith(result: Awaited<ReturnType<typeof checkout>>, tables: Record<string, Row[]>, publicKey: string, source: string) {
    expect(result.url).toMatch(/^https:\/\/checkout\.freemius\.com\/app\/28609\/plan\/47122\//);
    expect(result.customProps).toMatchObject({ public_key: publicKey, credential_source: source });
    expect(JSON.stringify(result)).not.toContain(PAIR.publicKey);
    expect(tables.orders).toHaveLength(1);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  }

  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-test-key');
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
    for (const name of FREEMIUS_ENV_NAMES) {
      vi.stubEnv(name, '');
    }
    mocks.from.mockReset();
    mocks.rpc.mockClear();
    mocks.developerCandidates.mockReset().mockImplementation(async () => [PAIR]);
    forgetFreemiusDeveloperCaches();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ['tried as a pair under the legacy names alone (env-legacy)', [{ ...PAIR, source: 'env-legacy' }]],
    ['an identical copy of the dedicated pair (listed once, as env)', [PAIR]],
  ])(
    'never opens a checkout with the developer pair when the product-key read fails and the legacy names hold it: %s',
    async (_label, candidates) => {
      vi.stubEnv('FREEMIUS_PUBLIC_KEY', PAIR.publicKey);
      vi.stubEnv('FREEMIUS_SECRET_KEY', PAIR.secretKey);
      mocks.developerCandidates.mockImplementation(async () => candidates);
      stubFreemius({ productRead: 503 });
      const { writes } = installFakeDatabase({ coupons: [LIMITED_COUPON] });

      expectNothingWritten(await checkout({ couponCode: 'launch10' }), writes);
    }
  );

  it('nor for a product outside the account while the legacy names hold the developer pair', async () => {
    vi.stubEnv('FREEMIUS_PUBLIC_KEY', PAIR.publicKey);
    vi.stubEnv('FREEMIUS_SECRET_KEY', PAIR.secretKey);
    mocks.developerCandidates.mockImplementation(async () => [{ ...PAIR, source: 'env-legacy' }]);
    stubFreemius({ listed: [24851, 43273] });
    const { writes } = installFakeDatabase({ coupons: [LIMITED_COUPON] });

    expectNothingWritten(await checkout({ couponCode: 'launch10' }), writes);
  });

  it('checks out with the product’s FREEMIUS_CHECKOUT_PRODUCTS_JSON entry when its key read fails', async () => {
    vi.stubEnv('FREEMIUS_CHECKOUT_PRODUCTS_JSON', JSON.stringify({ '28609': { publicKey: 'pk_json_cortex', secretKey: 'sk_json_cortex' } }));
    vi.stubEnv('FREEMIUS_PUBLIC_KEY', PAIR.publicKey);
    vi.stubEnv('FREEMIUS_SECRET_KEY', PAIR.secretKey);
    stubFreemius({ productRead: 503 });
    const { tables } = installFakeDatabase({ coupons: [LIMITED_COUPON] });

    expectOpenedWith(await checkout({ couponCode: 'launch10' }), tables, 'pk_json_cortex', 'product-map');
  });

  it('checks out with the one-product keys when FREEMIUS_PRODUCT_ID names the product and its key read fails', async () => {
    vi.stubEnv('FREEMIUS_PRODUCT_ID', '28609');
    vi.stubEnv('FREEMIUS_PUBLIC_KEY', 'pk_single_cortex');
    vi.stubEnv('FREEMIUS_SECRET_KEY', 'sk_single_cortex');
    stubFreemius({ productRead: 503 });
    const { tables } = installFakeDatabase({ coupons: [LIMITED_COUPON] });

    expectOpenedWith(await checkout({ couponCode: 'launch10' }), tables, 'pk_single_cortex', 'single-product-env');
  });

  it('gives the keyed 503, writing nothing, when a dedicated pair is refused and the product has no bound keys', async () => {
    vi.stubEnv('FREEMIUS_PUBLIC_KEY', ONE_PRODUCT.publicKey);
    vi.stubEnv('FREEMIUS_SECRET_KEY', ONE_PRODUCT.secretKey);
    stubFreemius({ list: 401 });
    const { writes } = installFakeDatabase({ coupons: [LIMITED_COUPON] });

    expectNothingWritten(await checkout({ couponCode: 'launch10' }), writes);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('source none, developer_pair_refused'));
  });

  it('gives the keyed 503 for an owned product without keys from Freemius, whatever one-product keys are set', async () => {
    vi.stubEnv('FREEMIUS_PUBLIC_KEY', ONE_PRODUCT.publicKey);
    vi.stubEnv('FREEMIUS_SECRET_KEY', ONE_PRODUCT.secretKey);
    stubFreemius({ productRead: 404 });
    const { writes } = installFakeDatabase({ coupons: [LIMITED_COUPON] });

    expectNothingWritten(await checkout({ couponCode: 'launch10' }), writes);
  });

  it('gives the keyed 503 while Freemius cannot be asked about the pair and the product has no bound keys', async () => {
    vi.stubEnv('FREEMIUS_PUBLIC_KEY', ONE_PRODUCT.publicKey);
    vi.stubEnv('FREEMIUS_SECRET_KEY', ONE_PRODUCT.secretKey);
    stubFreemius({ list: 503 });
    const { writes } = installFakeDatabase({ coupons: [LIMITED_COUPON] });

    expectNothingWritten(await checkout({ couponCode: 'launch10' }), writes);
  });

  it('opens with the one-product keys where they may stand in: a one-product install whose “pair” is only those names, refused, once Freemius confirms they are this product’s', async () => {
    vi.stubEnv('FREEMIUS_PUBLIC_KEY', ONE_PRODUCT.publicKey);
    vi.stubEnv('FREEMIUS_SECRET_KEY', ONE_PRODUCT.secretKey);
    mocks.developerCandidates.mockImplementation(async () => [LEGACY_ONLY]);
    const fetchMock = stubFreemius({ list: 401, productScope: (id) => (id === '28609' ? 200 : 401) });
    const { tables } = installFakeDatabase({ coupons: [LIMITED_COUPON] });

    expectOpenedWith(await checkout({ couponCode: 'launch10' }), tables, ONE_PRODUCT.publicKey, 'legacy-env');
    // Another product is not theirs: Freemius refuses the keys at its scope.
    await expect(resolveFreemiusProductCredentials('24851')).resolves.toMatchObject({
      publicKey: null,
      source: 'none',
      refusal: 'one_product_keys_not_this_product',
    });
    expect(fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith('https://api.freemius.com/v1/plugins/'))).toEqual([
      'https://api.freemius.com/v1/plugins/28609.json',
      'https://api.freemius.com/v1/plugins/24851.json',
    ]);
  });

  /**
   * Review 2026-11-13, round 3: the refused "pair" under the one-product names stood in for every
   * product, though it may be a revoked developer pair (nextblock.dev keeps its pair there): the
   * checkout opened with the developer public key and wrote the order and the coupon redemption.
   */
  it('gives the keyed 503, writing nothing, when the refused one-product names are a revoked developer pair (Freemius refuses them at the product’s scope)', async () => {
    // Revoked before this instance started, so it never saw Freemius accept the pair (keys no
    // other test of this file sends: what Freemius accepted is remembered for the module's life).
    const REVOKED = { developerId: DEV, publicKey: 'pk_dev_revoked_before_start', secretKey: 'sk_dev_revoked_before_start' };
    vi.stubEnv('FREEMIUS_PUBLIC_KEY', REVOKED.publicKey);
    vi.stubEnv('FREEMIUS_SECRET_KEY', REVOKED.secretKey);
    mocks.developerCandidates.mockImplementation(async () => [{ ...REVOKED, source: 'env-legacy' }]);
    stubFreemius({ list: 401, productScope: () => 401 });
    const { writes } = installFakeDatabase({ coupons: [LIMITED_COUPON] });

    const result = await checkout({ couponCode: 'launch10' });
    expectNothingWritten(result, writes);
    expect(JSON.stringify(result)).not.toContain(REVOKED.publicKey);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('source none, one_product_keys_not_this_product'));
  });

  /**
   * Review 2026-11-13, round 3 (K1): a product-scope 200 that was not the product (`{}`) confirmed
   * the refused one-product names, so a revoked developer pair left there opened the checkout with
   * its public key and wrote the order and the coupon redemption.
   */
  it('gives the keyed 503, writing nothing, when the refused one-product names are a revoked developer pair and their product-scope read answers 200 {}', async () => {
    // Keys no other test of this file sends (what Freemius accepted is remembered for the module's life).
    const REVOKED = { developerId: DEV, publicKey: 'pk_dev_revoked_empty_answer', secretKey: 'sk_dev_revoked_empty_answer' };
    vi.stubEnv('FREEMIUS_PUBLIC_KEY', REVOKED.publicKey);
    vi.stubEnv('FREEMIUS_SECRET_KEY', REVOKED.secretKey);
    mocks.developerCandidates.mockImplementation(async () => [{ ...REVOKED, source: 'env-legacy' }]);
    const fetchMock = stubFreemius({ list: 401, productScope: () => 200, productScopeBody: () => ({}) });
    const { writes } = installFakeDatabase({ coupons: [LIMITED_COUPON] });

    const result = await checkout({ couponCode: 'launch10' });
    expectNothingWritten(result, writes);
    expect(JSON.stringify(result)).not.toContain(REVOKED.publicKey);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('source none, one_product_keys_unconfirmed'));
    expect(fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith('https://api.freemius.com/v1/plugins/'))).toEqual([
      'https://api.freemius.com/v1/plugins/28609.json',
    ]);
  });

  it('gives the keyed 503, writing nothing, while Freemius does not answer whether the refused one-product names are this product’s', async () => {
    vi.stubEnv('FREEMIUS_PUBLIC_KEY', ONE_PRODUCT.publicKey);
    vi.stubEnv('FREEMIUS_SECRET_KEY', ONE_PRODUCT.secretKey);
    mocks.developerCandidates.mockImplementation(async () => [LEGACY_ONLY]);
    stubFreemius({ list: 401, productScope: () => 503 });
    const { writes } = installFakeDatabase({ coupons: [LIMITED_COUPON] });

    expectNothingWritten(await checkout({ couponCode: 'launch10' }), writes);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('source none, one_product_keys_unconfirmed'));
  });

  /**
   * Review 2026-11-13, round 3: FREEMIUS_PRODUCT_ID-bound one-product keys were returned before the
   * key policy was consulted, so with those names holding the developer pair and a failed key read
   * the checkout opened with the developer public key and wrote the order and the coupon redemption.
   */
  it.each([
    ['the working pair under the legacy names (env-legacy)', [{ ...PAIR, source: 'env-legacy' }]],
    ['the working pair under the CMS one-product fields (cms-legacy)', [{ ...PAIR, source: 'cms-legacy' }]],
    ['an identical copy of the dedicated pair (listed once, as env)', [PAIR]],
  ])(
    'gives the keyed 503, writing nothing, when FREEMIUS_PRODUCT_ID binds one-product names holding the developer pair and the key read fails: %s',
    async (_label, candidates) => {
      vi.stubEnv('FREEMIUS_PRODUCT_ID', '28609');
      vi.stubEnv('FREEMIUS_PUBLIC_KEY', PAIR.publicKey);
      vi.stubEnv('FREEMIUS_SECRET_KEY', PAIR.secretKey);
      mocks.developerCandidates.mockImplementation(async () => candidates);
      stubFreemius({ productRead: 503 });
      const { writes } = installFakeDatabase({ coupons: [LIMITED_COUPON] });

      expectNothingWritten(await checkout({ couponCode: 'launch10' }), writes);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('source none, one_product_keys_are_developer_pair'));
    }
  );

  it('gives the keyed 503 for FREEMIUS_PRODUCT_ID-bound one-product names holding a developer pair revoked while the instance runs', async () => {
    vi.stubEnv('FREEMIUS_PRODUCT_ID', '28609');
    vi.stubEnv('FREEMIUS_PUBLIC_KEY', 'pk_dev_revoked_later');
    vi.stubEnv('FREEMIUS_SECRET_KEY', 'sk_dev_revoked_later');
    mocks.developerCandidates.mockImplementation(async () => [
      { developerId: DEV, publicKey: 'pk_dev_revoked_later', secretKey: 'sk_dev_revoked_later', source: 'env-legacy' },
    ]);
    let list = 200;
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url).replace(`https://api.freemius.com/v1/developers/${DEV}`, '');
      if (path.startsWith('/plugins.json')) return new Response(JSON.stringify(list === 200 ? { plugins: [{ id: 28609 }] } : {}), { status: list });
      if (path === '/plugins/28609.json') return new Response(JSON.stringify({ id: 28609, public_key: 'pk_cortex_product', secret_key: 'sk_cortex_product' }), { status: 200 });
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    installFakeDatabase();
    await expect(checkout()).resolves.toMatchObject({ customProps: { public_key: 'pk_cortex_product', credential_source: 'developer-api' } });

    // Revoked at Freemius: the next re-check is refused, and the bound names still hold that pair.
    list = 401;
    vi.setSystemTime(new Date(clock + 10 * 60_000 + 1_000));
    mocks.rpc.mockClear();
    const { writes } = installFakeDatabase({ coupons: [LIMITED_COUPON] });

    const result = await checkout({ couponCode: 'launch10' });
    expect(result).toMatchObject({ url: null, errorKey: 'ecommerce.checkout_payments_unavailable', errorStatus: 503 });
    expect(JSON.stringify(result)).not.toContain('pk_dev_revoked_later');
    expect(writes).toEqual([]);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  /**
   * Review 2026-11-13, round 3: every POST /api/checkout of a product whose key read failed wrote
   * two lines (the failed read, the blocked checkout), the read failure being remembered, so anyone
   * could fill the logs while Freemius throttled the developer key.
   */
  it('writes one key-read line and one blocked line per product per minute, however many checkouts fail', async () => {
    stubFreemius({ productRead: 429 });
    installFakeDatabase();
    const lines = () => ({
      read: vi.mocked(console.warn).mock.calls.filter((call) => String(call[0]).includes("Could not read product 28609's keys")).length,
      blocked: vi.mocked(console.error).mock.calls.filter((call) => String(call[0]).includes('Freemius checkout blocked for product 28609')).length,
    });

    for (let i = 0; i < 20; i += 1) {
      await expect(checkout()).resolves.toMatchObject({ errorStatus: 503 });
    }
    expect(lines()).toEqual({ read: 1, blocked: 1 });

    vi.setSystemTime(new Date(clock + 61_000));
    for (let i = 0; i < 5; i += 1) await checkout();
    expect(lines()).toEqual({ read: 2, blocked: 2 });
  });

  it('opens with the one-product keys where they may stand in: a product outside a working dedicated pair’s account', async () => {
    vi.stubEnv('FREEMIUS_PUBLIC_KEY', ONE_PRODUCT.publicKey);
    vi.stubEnv('FREEMIUS_SECRET_KEY', ONE_PRODUCT.secretKey);
    // The resolver lists the one-product names too (a developer id is set), after the working pair.
    mocks.developerCandidates.mockImplementation(async () => [PAIR, LEGACY_ONLY]);
    const fetchMock = stubFreemius({ listed: [24851, 43273] });
    const { tables } = installFakeDatabase({ coupons: [LIMITED_COUPON] });

    expectOpenedWith(await checkout({ couponCode: 'launch10' }), tables, ONE_PRODUCT.publicKey, 'legacy-env');
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/plugins/28609.json'))).toBe(false);
  });

  it('opens with the one-product keys where they may stand in: no developer pair at all', async () => {
    vi.stubEnv('FREEMIUS_PUBLIC_KEY', ONE_PRODUCT.publicKey);
    vi.stubEnv('FREEMIUS_SECRET_KEY', ONE_PRODUCT.secretKey);
    mocks.developerCandidates.mockImplementation(async () => []);
    const fetchMock = stubFreemius();
    const { tables } = installFakeDatabase({ coupons: [LIMITED_COUPON] });

    expectOpenedWith(await checkout({ couponCode: 'launch10' }), tables, ONE_PRODUCT.publicKey, 'legacy-env');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * Review 2026-11-13, round 3 (K3): Sync from Freemius read a 2xx first product list that was not a
 * list as an empty catalog, so it reported 0 products and dropped every cached verdict and key
 * (forgetFreemiusDeveloperCaches). It now stops as it does when Freemius fails to answer.
 */
describe('syncFreemiusProductsToSupabase (Sync from Freemius)', () => {
  const DEV = '4242';
  const PAIR = { developerId: DEV, publicKey: 'pk_dev_sync', secretKey: 'sk_dev_sync', source: 'env' };

  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-test-key');
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
    mocks.from.mockReset();
    mocks.developerCandidates.mockReset().mockImplementation(async () => [PAIR]);
    forgetFreemiusDeveloperCaches();
    for (const method of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation(() => undefined);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ['an HTML page', '<html>maintenance</html>'],
    ['{}', '{}'],
    ['{ "plugins": null }', '{"plugins":null}'],
  ])('stops at a 2xx first product list with %s: the store untouched, no "0 products", the cached verdict kept', async (_label, text) => {
    let broken = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const path = String(url).replace(`https://api.freemius.com/v1/developers/${DEV}`, '');
        if (path.startsWith('/plugins.json')) {
          return broken ? new Response(text, { status: 200 }) : new Response(JSON.stringify({ plugins: [{ id: 28609 }] }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
      })
    );
    // The store has its English language, so a sync that went on would finish with 0 products.
    mocks.from.mockImplementation(() => {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        single: async () => ({ data: { id: 1 }, error: null }),
      };
      return builder;
    });
    await expect(getFreemiusDeveloperStatus()).resolves.toMatchObject({ state: 'working', productIds: ['28609'] });

    broken = true;
    await expect(syncFreemiusProductsToSupabase()).rejects.toMatchObject({ kind: 'unavailable' });
    expect(mocks.from).not.toHaveBeenCalled();
    // forgetFreemiusDeveloperCaches did not run: the pair's verdict is still in memory.
    await expect(getFreemiusDeveloperStatus({ wait: false })).resolves.toMatchObject({ state: 'working', productIds: ['28609'] });
  });

  /**
   * Review 2026-11-14, round 6: the sync rewrote a synced product's title, slug, short description and
   * price without products.updated_at, which no trigger maintains. The visual editor publishes the
   * title and short description of a pre-0.23.4 draft holding a copy of the products row only while
   * updated_at is not later than the draft's created_at, so publishing such a draft reverted the
   * synced title.
   */
  it('stamps updated_at on every product it upserts', async () => {
    const answers: Record<string, unknown> = {
      '/plugins.json': { plugins: [{ id: 28609, title: 'Cortex AI' }] },
      '/plugins/28609/plans.json': {
        plans: [{ id: 47122, name: 'pro', title: 'Pro', description: 'Every agent tool', trial_period: 0, is_require_subscription: false }],
      },
      '/plugins/28609/plans/47122/pricing.json': { pricing: [{ licenses: 1, annual_price: 250 }] },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const answer = answers[String(url).replace(`https://api.freemius.com/v1/developers/${DEV}`, '')];
        return answer ? new Response(JSON.stringify(answer), { status: 200 }) : new Response('{}', { status: 404 });
      })
    );
    const upserts: Array<{ value: Row; options: unknown }> = [];
    mocks.from.mockImplementation((table: string) => {
      let upserted = false;
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        upsert: (value: Row, options: unknown) => {
          upserts.push({ value, options });
          upserted = true;
          return builder;
        },
        insert: () => builder,
        update: () => builder,
        single: async () => ({ data: { id: table === 'languages' ? 1 : `${table}-1` }, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve(upserted ? { data: [{ id: 'product-1' }], error: null } : { data: null, error: null }).then(
            onFulfilled,
            onRejected
          ),
      };
      return builder;
    });

    await expect(syncFreemiusProductsToSupabase()).resolves.toEqual({ success: true, count: 1 });

    expect(upserts).toHaveLength(1);
    expect(upserts[0].options).toEqual({ onConflict: 'language_id, sku' });
    expect(upserts[0].value).toMatchObject({
      sku: 'FM-28609-47122',
      title: 'Cortex AI - Pro',
      short_description: 'Every agent tool',
      price: 25000,
      updated_at: new Date(clock).toISOString(),
    });
  });
});
