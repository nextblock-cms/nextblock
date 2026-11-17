import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Freemius keys end to end, as installs configure them: the REAL candidate resolver and hydration
 * (payment-config.ts, CMS → Payments rows faked at the Supabase boundary), the real developer API,
 * key policy, checkout (FreemiusProvider), webhook verification and store readiness
 * (pages/cms/payments/queries.ts). Only the database rows, the checkout's tables and
 * api.freemius.com are faked.
 *
 * Review 2026-11-13, round 3: no test covered nextblock.dev's configuration (the CMS one-product
 * fields holding one product's keys, hydrated over env names that hold the developer pair) end to
 * end, and readiness could show buy buttons over checkouts the key policy refuses.
 */

type Row = Record<string, any>;

const mocks = vi.hoisted(() => ({
  /** site_settings rows by key (payment_public, payment_secret, enabled_payment_providers). */
  rows: new Map<string, unknown>(),
  from: vi.fn(),
  rpc: vi.fn(async () => ({ data: true, error: null })),
  afterTasks: [] as Array<() => unknown>,
}));

vi.mock('server-only', () => ({}));
vi.mock('next/server', () => ({ after: (task: () => unknown) => void mocks.afterTasks.push(task) }));
vi.mock('@nextblock-cms/db/server', async () => {
  const configResolve = await vi.importActual<{
    isSandboxEnvironment: () => boolean;
    resolveConfigValue: (dbValue: string | null | undefined, envName: string, options?: { warnOnEnvFallback?: boolean }) => string | null;
  }>('../../../db/src/lib/config-resolve');
  const settings = () => ({
    from: () => ({
      select: () => ({
        eq: (_column: string, key: string) => ({
          maybeSingle: async () => ({ data: mocks.rows.has(key) ? { value: mocks.rows.get(key) } : null, error: null }),
        }),
      }),
    }),
  });
  return {
    createClient: settings,
    getServiceRoleSupabaseClient: settings,
    // Stored secrets are `plain:<value>` stand-ins here; the real envelopes have their own tests.
    encryptWithEnvKey: (value: string) => `plain:${value}`,
    getSecretEnvelopeStatus: (value: unknown) => ({ hasStoredValue: Boolean(value), last4: null }),
    tryDecryptWithEnvKey: (value: unknown) => (typeof value === 'string' && value.startsWith('plain:') ? value.slice(6) : null),
    resealWithEnvKey: (value: unknown) => value,
    siteSettingSecretSlot: (key: string, field: string) => ({ key, field }),
    isSandboxEnvironment: configResolve.isSandboxEnvironment,
    resolveConfigValue: configResolve.resolveConfigValue,
  };
});
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: mocks.from, rpc: mocks.rpc }) }));
vi.mock('./server-actions/require-ecom-role', () => ({ getEcomActorRole: async () => 'ADMIN', requireEcomAdmin: async () => ({}) }));
vi.mock('./freemius-pricing-server', () => ({
  FREEMIUS_PRICED_PRODUCT_COLUMNS: 'id, price, prices, sale_price, sale_prices, sale_start_at, sale_end_at',
  resolveFreemiusUnitAmount: async () => ({ ok: true, source: 'product', billingCycle: null, price: 25000, unitAmount: 25000 }),
}));
vi.mock('./invoice-server', () => ({ assignInvoiceMetadata: vi.fn() }));
vi.mock('./order-inventory', () => ({ applyOrderInventoryDeduction: vi.fn() }));

const DEV = '4242';
const DEV_PAIR = { publicKey: 'pk_dev_e2e_live', secretKey: 'sk_dev_e2e_live' };
const PRODUCTS: Record<string, { public_key: string; secret_key: string; uuid: string }> = {
  '24851': { public_key: 'pk_commerce_e2e', secret_key: 'sk_commerce_e2e', uuid: '24851000-0000-4000-8000-000000000001' },
  '28609': { public_key: 'pk_cortex_e2e', secret_key: 'sk_cortex_e2e', uuid: '28609000-0000-4000-8000-000000000002' },
  '43273': { public_key: 'pk_affiliates_e2e', secret_key: 'sk_affiliates_e2e', uuid: '43273000-0000-4000-8000-000000000003' },
};
const FREEMIUS_ENV = [
  'FREEMIUS_DEVELOPER_ID',
  'FREEMIUS_DEVELOPER_PUBLIC_KEY',
  'FREEMIUS_DEVELOPER_SECRET_KEY',
  'FREEMIUS_PUBLIC_KEY',
  'FREEMIUS_SECRET_KEY',
  'FREEMIUS_API_KEY',
  'FREEMIUS_PRODUCT_ID',
  'FREEMIUS_CHECKOUT_PRODUCTS_JSON',
  'FREEMIUS_SANDBOX_ENABLED',
  'FREEMIUS_ECOMMERCE_SANDBOX_PUBLIC_KEY',
  'FREEMIUS_ECOMMERCE_SANDBOX_SECRET_KEY',
];

type FreemiusCall = { path: string; publicKey: string };

/**
 * api.freemius.com. Developer scope (`/v1/developers/4242/...`) answers only `developerKey`: the
 * account's three products and each product's keys (`productRead(id)`, 200 by default); any other
 * key gets 401. Product scope (`/v1/plugins/{id}.json`) answers 200 only to that product's own
 * public key, 401 otherwise. `answer(path, publicKey)`, when it returns a response, answers first.
 */
function stubFreemius(
  options: {
    developerKey?: string | null;
    productRead?: (productId: string) => number;
    answer?: (path: string, publicKey: string) => Response | undefined;
  } = {}
) {
  const calls: FreemiusCall[] = [];
  const developerKey = options.developerKey === undefined ? DEV_PAIR.publicKey : options.developerKey;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const authorization = String((init.headers as Record<string, string>)?.['Authorization'] ?? '');
      const publicKey = authorization.split(' ')[1]?.split(':')[1] ?? '';
      const path = String(url).replace('https://api.freemius.com', '');
      calls.push({ path, publicKey });
      const custom = options.answer?.(path, publicKey);
      if (custom) return custom;
      const productScope = path.match(/^\/v1\/plugins\/(\d+)\.json$/);
      if (productScope) {
        const own = PRODUCTS[productScope[1]];
        return own && own.public_key === publicKey
          ? new Response(JSON.stringify({ id: Number(productScope[1]), public_key: own.public_key }), { status: 200 })
          : new Response(JSON.stringify({ error: { code: 'unauthorized' } }), { status: 401 });
      }
      if (!developerKey || publicKey !== developerKey) {
        return new Response(JSON.stringify({ error: { code: 'unauthorized' } }), { status: 401 });
      }
      const developerPath = path.replace(`/v1/developers/${DEV}`, '');
      if (developerPath.startsWith('/plugins.json')) {
        return new Response(JSON.stringify({ plugins: Object.keys(PRODUCTS).map((id) => ({ id: Number(id) })) }), { status: 200 });
      }
      const product = developerPath.match(/^\/plugins\/(\d+)\.json$/);
      if (product && PRODUCTS[product[1]]) {
        const status = options.productRead?.(product[1]) ?? 200;
        const keys = PRODUCTS[product[1]];
        return status === 200
          ? new Response(JSON.stringify({ id: Number(product[1]), public_key: keys.public_key, secret_key: keys.secret_key }), { status })
          : new Response('{}', { status });
      }
      return new Response('{}', { status: 404 });
    })
  );
  return calls;
}

/** The checkout's tables: one digital product per Freemius product, a limited coupon, and the writes sent. */
function installCheckoutDatabase() {
  const tables: Record<string, Row[]> = {
    currencies: [{ code: 'USD', symbol: '$', exchange_rate: 1, is_default: true, is_active: true }],
    products: Object.entries(PRODUCTS).map(([freemiusId, product]) => ({
      id: product.uuid,
      title: `Product ${freemiusId}`,
      price: 25000,
      prices: { USD: 25000 },
      sale_price: null,
      sale_prices: {},
      sale_start_at: null,
      sale_end_at: null,
      product_type: 'digital',
      payment_provider: 'freemius',
      freemius_plan_id: '40001',
      freemius_product_id: freemiusId,
      trial_period_days: 0,
      trial_requires_payment_method: false,
    })),
    coupons: [
      {
        id: '22222222-2222-4222-8222-222222222222',
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
      },
    ],
    orders: [],
    order_items: [],
  };
  const writes: string[] = [];

  mocks.from.mockImplementation((table: string) => {
    const filters: Array<(row: Row) => boolean> = [];
    let inserted: Row[] | null = null;
    const resolve = () =>
      inserted ? { data: inserted, error: null } : { data: (tables[table] ?? []).filter((row) => filters.every((filter) => filter(row))), error: null };
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (column: string, value: unknown) => (filters.push((row) => row[column] === value), builder),
      in: (column: string, values: unknown[]) => (filters.push((row) => values.includes(row[column])), builder),
      order: () => builder,
      insert: (value: Row | Row[]) => {
        writes.push(`insert:${table}`);
        const rows = (Array.isArray(value) ? value : [value]).map((row, index) => ({ id: `${table}-${(tables[table] ?? []).length + index + 1}`, ...row }));
        (tables[table] ??= []).push(...rows);
        inserted = rows;
        return builder;
      },
      update: () => (writes.push(`update:${table}`), builder),
      upsert: () => (writes.push(`upsert:${table}`), builder),
      delete: () => (writes.push(`delete:${table}`), builder),
      single: async () => {
        const result = resolve();
        const rows = Array.isArray(result.data) ? result.data : [];
        return { data: rows[0] ?? null, error: rows[0] ? null : { message: 'no rows' } };
      },
      maybeSingle: async () => {
        const result = resolve();
        const rows = Array.isArray(result.data) ? result.data : [];
        return { data: rows[0] ?? null, error: null };
      },
      then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onFulfilled, onRejected),
    };
    return builder;
  });

  return { tables, writes };
}

const sign = (body: string, secret: string) => crypto.createHmac('sha256', secret).update(body).digest('hex');
const refund = (productId: string) =>
  JSON.stringify({ id: '990001', type: 'payment.refund', plugin_id: Number(productId), objects: { payment: { license_id: 9001 } } });

/** The modules under test, fresh for each test (verdicts, caches and hydration are module state). */
async function load() {
  const paymentConfig = await import('./payment-config');
  const developerApi = await import('./freemius-developer-api');
  const orderSync = await import('./freemius-order-sync');
  const provider = await import('./providers/freemius');
  const readiness = await import('./pages/cms/payments/queries');

  const checkout = (freemiusProductId: string) => {
    const uuid = PRODUCTS[freemiusProductId].uuid;
    return new provider.FreemiusProvider().createCheckoutSession({
      items: [
        {
          id: uuid,
          product_id: uuid,
          title: `Product ${freemiusProductId}`,
          slug: `product-${freemiusProductId}`,
          sku: `FM-${freemiusProductId}-40001`,
          price: 25000,
          language_id: 1,
          translation_group_id: 'g1',
          product_type: 'digital',
          provider: 'freemius',
          quantity: 1,
        } as any,
      ],
      customerEmail: 'buyer@example.test',
      billingAddress: { recipient_name: 'Guest Buyer', country_code: 'CA' } as any,
      currencyCode: 'USD',
      couponCode: 'launch10',
    });
  };

  /** What the route does: hydrate, then verify. */
  const verify = async (body: string, secret: string) => {
    await paymentConfig.hydrateFreemiusEnvFromDb();
    return orderSync.getFreemiusWebhookVerification(body, sign(body, secret));
  };

  const freemiusReadiness = async () => (await readiness.getStoreReadiness()).freemius;

  return { paymentConfig, developerApi, provider, checkout, verify, freemiusReadiness };
}

async function runAfterTasks() {
  for (const task of mocks.afterTasks.splice(0)) {
    await task();
  }
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-test-key');
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  // Every name hydration may write is stubbed, so each test's writes are undone after it.
  for (const name of FREEMIUS_ENV) vi.stubEnv(name, '');
  mocks.rows.clear();
  mocks.rows.set('enabled_payment_providers', { stripe: false, freemius: true });
  mocks.from.mockReset();
  mocks.rpc.mockClear();
  mocks.afterTasks.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * nextblock.dev: FREEMIUS_DEVELOPER_ID and the developer pair under FREEMIUS_PUBLIC_KEY /
 * FREEMIUS_SECRET_KEY in the env; CMS → Payments holds one product's keys (Cortex, 28609), which
 * hydration writes over those env names; no JSON. It owns 24851, 28609 and 43273.
 */
describe.each([
  ['the CMS Product ID empty', ''],
  ['the CMS Product ID 28609', '28609'],
])("nextblock.dev's configuration, %s", (_label, cmsProductId) => {
  beforeEach(() => {
    vi.stubEnv('FREEMIUS_DEVELOPER_ID', DEV);
    vi.stubEnv('FREEMIUS_PUBLIC_KEY', DEV_PAIR.publicKey);
    vi.stubEnv('FREEMIUS_SECRET_KEY', DEV_PAIR.secretKey);
    mocks.rows.set('payment_public', { freemius: { publicKey: PRODUCTS['28609'].public_key, productId: cmsProductId } });
    mocks.rows.set('payment_secret', { freemiusSecretKey: `plain:${PRODUCTS['28609'].secret_key}` });
  });

  it('every owned product checks out and verifies with its own keys; the developer secret verifies nothing; readiness is green', async () => {
    const calls = stubFreemius();
    const { paymentConfig, developerApi, checkout, verify, freemiusReadiness } = await load();
    await paymentConfig.hydrateFreemiusEnvFromDb();

    expect((await paymentConfig.resolveFreemiusDeveloperCredentialCandidates()).map((candidate) => candidate.source)).toEqual([
      'cms-legacy',
      'env-legacy',
    ]);
    await expect(freemiusReadiness()).resolves.toMatchObject({ ready: true, hasKeys: true });

    installCheckoutDatabase();
    for (const id of Object.keys(PRODUCTS)) {
      const result = await checkout(id);
      expect(result.customProps, id).toMatchObject({ public_key: PRODUCTS[id].public_key, credential_source: 'developer-api' });
      await expect(verify(refund(id), PRODUCTS[id].secret_key), id).resolves.toEqual({ outcome: 'valid', productId: id });
      await expect(verify(refund(id), DEV_PAIR.secretKey), id).resolves.toMatchObject({ outcome: 'invalid' });
    }
    await expect(developerApi.getFreemiusDeveloperStatus()).resolves.toMatchObject({ state: 'working', source: 'env-legacy' });

    // A product outside the account: no stand-in (the working pair is the env one-product names).
    await expect(verify(refund('777'), DEV_PAIR.secretKey)).resolves.toMatchObject({ outcome: 'invalid' });
    await expect(verify(refund('777'), PRODUCTS['28609'].secret_key)).resolves.toMatchObject({ outcome: 'invalid' });
    // The CMS product keys never reach developer scope beyond the one check of them as a pair.
    expect(calls.filter((call) => call.publicKey === PRODUCTS['28609'].public_key).map((call) => call.path)).toEqual([
      `/v1/developers/${DEV}/plugins.json?count=50&offset=0`,
    ]);
    expect(calls.some((call) => call.path.startsWith('/v1/plugins/'))).toBe(false);
  });

  it('a failed key read: Cortex keeps its bound CMS keys only with the Product ID set, never the developer pair', async () => {
    stubFreemius({ productRead: () => 503 });
    const { paymentConfig, checkout, verify } = await load();
    await paymentConfig.hydrateFreemiusEnvFromDb();
    const { writes } = installCheckoutDatabase();

    const cortex = await checkout('28609');
    expect(JSON.stringify(cortex)).not.toContain(DEV_PAIR.publicKey);
    await expect(verify(refund('28609'), DEV_PAIR.secretKey)).resolves.toMatchObject({ outcome: 'unverifiable', reason: 'product_key_read_failed' });

    if (cmsProductId) {
      // The operator bound the CMS keys to Cortex: unchanged, they open its checkout and verify it.
      expect(cortex.customProps).toMatchObject({ public_key: PRODUCTS['28609'].public_key, credential_source: 'single-product-env' });
      await expect(verify(refund('28609'), PRODUCTS['28609'].secret_key)).resolves.toEqual({ outcome: 'valid', productId: '28609' });
    } else {
      expect(cortex).toMatchObject({ url: null, errorKey: 'ecommerce.checkout_payments_unavailable', errorStatus: 503 });
      expect(writes).toEqual([]);
      expect(mocks.rpc).not.toHaveBeenCalled();
    }

    // Another owned product has no bound keys at all: the keyed 503, never the developer pair.
    const { writes: commerceWrites } = installCheckoutDatabase();
    await expect(checkout('24851')).resolves.toMatchObject({ url: null, errorStatus: 503 });
    expect(commerceWrites).toEqual([]);
  });
});

/**
 * A one-product install that also filled in the Developer ID (0.23.3 called it "only used by
 * Sync"): the only configured "pair" is its CMS one-product fields, which Freemius refuses at
 * developer scope. Its keys still check out its product and verify its webhooks, once Freemius
 * confirms at that product's scope that they are its keys; no other product's.
 */
describe('a one-product install with a developer id', () => {
  beforeEach(() => {
    mocks.rows.set('payment_public', { freemius: { developerId: DEV, publicKey: PRODUCTS['28609'].public_key, productId: '' } });
    mocks.rows.set('payment_secret', { freemiusSecretKey: `plain:${PRODUCTS['28609'].secret_key}` });
  });

  it('checks out and verifies its product, refuses another product, and reads ready', async () => {
    const calls = stubFreemius({ developerKey: null });
    const { paymentConfig, provider, checkout, verify, freemiusReadiness } = await load();
    await paymentConfig.hydrateFreemiusEnvFromDb();

    expect((await paymentConfig.resolveFreemiusDeveloperCredentialCandidates()).map((candidate) => candidate.source)).toEqual(['cms-legacy']);
    await expect(freemiusReadiness()).resolves.toMatchObject({ ready: true });

    const { tables } = installCheckoutDatabase();
    const result = await checkout('28609');
    expect(result.customProps).toMatchObject({ public_key: PRODUCTS['28609'].public_key, credential_source: 'legacy-env' });
    expect(tables.orders).toHaveLength(1);
    await expect(verify(refund('28609'), PRODUCTS['28609'].secret_key)).resolves.toEqual({ outcome: 'valid', productId: '28609' });

    // Another product: Freemius refuses these keys at its scope.
    await expect(provider.resolveFreemiusProductCredentials('24851')).resolves.toMatchObject({
      source: 'none',
      refusal: 'one_product_keys_not_this_product',
    });
    await expect(verify(refund('24851'), PRODUCTS['28609'].secret_key)).resolves.toMatchObject({ outcome: 'invalid' });

    // One confirmation per product, kept.
    expect(calls.filter((call) => call.path.startsWith('/v1/plugins/')).map((call) => call.path)).toEqual([
      '/v1/plugins/28609.json',
      '/v1/plugins/24851.json',
    ]);
  });

  it('with its Product ID filled in, its bound keys work offline: no confirmation request', async () => {
    mocks.rows.set('payment_public', { freemius: { developerId: DEV, publicKey: PRODUCTS['28609'].public_key, productId: '28609' } });
    const calls = stubFreemius({ developerKey: null });
    const { paymentConfig, checkout, verify } = await load();
    await paymentConfig.hydrateFreemiusEnvFromDb();
    installCheckoutDatabase();

    await expect(checkout('28609')).resolves.toMatchObject({
      customProps: { public_key: PRODUCTS['28609'].public_key, credential_source: 'single-product-env' },
    });
    await expect(verify(refund('28609'), PRODUCTS['28609'].secret_key)).resolves.toEqual({ outcome: 'valid', productId: '28609' });
    expect(calls.some((call) => call.path.startsWith('/v1/plugins/'))).toBe(false);
  });
});

/** A developer-pair install: FREEMIUS_DEVELOPER_ID and the dedicated developer names only, nothing in the CMS. */
describe('a developer-pair install (dedicated names only)', () => {
  beforeEach(() => {
    vi.stubEnv('FREEMIUS_DEVELOPER_ID', DEV);
    vi.stubEnv('FREEMIUS_DEVELOPER_PUBLIC_KEY', DEV_PAIR.publicKey);
    vi.stubEnv('FREEMIUS_DEVELOPER_SECRET_KEY', DEV_PAIR.secretKey);
  });

  it('every owned product checks out and verifies with its own keys; outside products have none; readiness is green without waiting', async () => {
    stubFreemius();
    const { paymentConfig, provider, checkout, verify, freemiusReadiness } = await load();
    await paymentConfig.hydrateFreemiusEnvFromDb();

    expect((await paymentConfig.resolveFreemiusDeveloperCredentialCandidates()).map((candidate) => candidate.source)).toEqual(['env']);
    // Unchecked yet: ready at once, the check runs after the response.
    await expect(freemiusReadiness()).resolves.toMatchObject({ ready: true });
    await runAfterTasks();
    paymentConfig.clearPaymentConfigCache();
    await expect(freemiusReadiness()).resolves.toMatchObject({ ready: true });

    installCheckoutDatabase();
    for (const id of Object.keys(PRODUCTS)) {
      await expect(checkout(id), id).resolves.toMatchObject({
        customProps: { public_key: PRODUCTS[id].public_key, credential_source: 'developer-api' },
      });
      await expect(verify(refund(id), PRODUCTS[id].secret_key), id).resolves.toEqual({ outcome: 'valid', productId: id });
    }
    await expect(verify(refund('777'), DEV_PAIR.secretKey)).resolves.toMatchObject({ outcome: 'invalid' });
    await expect(provider.resolveFreemiusProductCredentials('777')).resolves.toMatchObject({ source: 'none', refusal: 'no_one_product_keys' });
  });
});

/**
 * The state readiness must now read as not ready: one-product keys only (CMS fields), the Product
 * ID empty, no JSON entry, and wrong developer keys in the dedicated names that Freemius refuses.
 * Every checkout and webhook then answers 503, and readiness agrees.
 */
describe('one-product keys beside a dedicated developer pair Freemius refuses', () => {
  beforeEach(() => {
    vi.stubEnv('FREEMIUS_DEVELOPER_ID', DEV);
    vi.stubEnv('FREEMIUS_DEVELOPER_PUBLIC_KEY', 'pk_dev_e2e_wrong');
    vi.stubEnv('FREEMIUS_DEVELOPER_SECRET_KEY', 'sk_dev_e2e_wrong');
    mocks.rows.set('payment_public', { freemius: { publicKey: PRODUCTS['28609'].public_key, productId: '' } });
    mocks.rows.set('payment_secret', { freemiusSecretKey: `plain:${PRODUCTS['28609'].secret_key}` });
  });

  it('readiness turns red from memory once the pair is refused, and agrees with checkout and webhooks', async () => {
    stubFreemius({ developerKey: null });
    const { paymentConfig, checkout, verify, freemiusReadiness } = await load();
    await paymentConfig.hydrateFreemiusEnvFromDb();

    // Never checked: readiness does not wait on Freemius, and stays green meanwhile.
    await expect(freemiusReadiness()).resolves.toMatchObject({ ready: true });
    await runAfterTasks();
    paymentConfig.clearPaymentConfigCache();
    await expect(freemiusReadiness()).resolves.toMatchObject({
      ready: false,
      hasKeys: false,
      missing: ['Developer key pair Freemius accepts, or a Product ID'],
    });

    const { writes } = installCheckoutDatabase();
    await expect(checkout('28609')).resolves.toMatchObject({ url: null, errorKey: 'ecommerce.checkout_payments_unavailable', errorStatus: 503 });
    expect(writes).toEqual([]);
    expect(mocks.rpc).not.toHaveBeenCalled();
    await expect(verify(refund('28609'), PRODUCTS['28609'].secret_key)).resolves.toMatchObject({
      outcome: 'unverifiable',
      reason: 'developer_pair_refused',
    });
  });

  /**
   * Review 2026-11-13, round 3 (K5): any FREEMIUS_CHECKOUT_PRODUCTS_JSON entry kept readiness green,
   * though an entry without a `publicKey` opens no checkout of its own (only the developer pair can
   * read that product's keys) and keeps the one-product keys from standing in for its product.
   */
  it('reads not ready with JSON entries that lack a publicKey, which open no checkout either', async () => {
    vi.stubEnv('FREEMIUS_CHECKOUT_PRODUCTS_JSON', JSON.stringify({ '24851': { secretKey: 'sk_json_commerce_e2e' } }));
    stubFreemius({ developerKey: null });
    const { paymentConfig, checkout, freemiusReadiness } = await load();
    await paymentConfig.hydrateFreemiusEnvFromDb();

    await expect(freemiusReadiness()).resolves.toMatchObject({ ready: true });
    await runAfterTasks();
    paymentConfig.clearPaymentConfigCache();
    await expect(freemiusReadiness()).resolves.toMatchObject({
      ready: false,
      hasKeys: false,
      missing: ['Developer key pair Freemius accepts, or a Product ID'],
    });

    for (const id of ['24851', '28609']) {
      const { writes } = installCheckoutDatabase();
      await expect(checkout(id), id).resolves.toMatchObject({ url: null, errorKey: 'ecommerce.checkout_payments_unavailable', errorStatus: 503 });
      expect(writes, id).toEqual([]);
    }

    // An entry with a publicKey opens its product's checkout: ready again, and it checks out.
    vi.stubEnv('FREEMIUS_CHECKOUT_PRODUCTS_JSON', JSON.stringify({ '24851': { publicKey: 'pk_json_commerce_e2e', secretKey: 'sk_json_commerce_e2e' } }));
    await expect(freemiusReadiness()).resolves.toMatchObject({ ready: true, hasKeys: true });
    installCheckoutDatabase();
    await expect(checkout('24851')).resolves.toMatchObject({ customProps: { public_key: 'pk_json_commerce_e2e', credential_source: 'product-map' } });
  });
});

/**
 * The documented residual of the bound-keys check (docs/02 → "Freemius keys", docs/13 → 0.23.4).
 * `freemiusKeysMayBeDeveloperPair` reads configuration and memory only, so a one-product install's
 * binding works offline. An instance that has not yet seen Freemius accept a developer pair left
 * under the one-product names therefore honours it as the keys of the product FREEMIUS_PRODUCT_ID
 * binds: one started after a revocation, or a cold start whose developer checks Freemius has not
 * answered (429/502). Closing it would cost one-product installs their offline binding, so it is
 * documented (set no Product ID while the pair sits in those names) and pinned here: a change to it
 * must be deliberate.
 */
describe('documented residual: a live developer pair that FREEMIUS_PRODUCT_ID binds under the one-product names', () => {
  beforeEach(() => {
    vi.stubEnv('FREEMIUS_DEVELOPER_ID', DEV);
    vi.stubEnv('FREEMIUS_PUBLIC_KEY', DEV_PAIR.publicKey);
    vi.stubEnv('FREEMIUS_SECRET_KEY', DEV_PAIR.secretKey);
    vi.stubEnv('FREEMIUS_PRODUCT_ID', '28609');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is honoured by a cold instance while Freemius answers 429, and refused once Freemius accepts that pair at developer scope', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-13T12:00:00Z'), toFake: ['Date'] });
    let throttled = true;
    let productRead = 200;
    stubFreemius({
      answer: () => (throttled ? new Response(JSON.stringify({ error: { code: 'rate_limit', message: 'Too many requests.' } }), { status: 429 }) : undefined),
      productRead: () => productRead,
    });
    const { paymentConfig, developerApi, provider, checkout, verify } = await load();
    await paymentConfig.hydrateFreemiusEnvFromDb();
    expect((await paymentConfig.resolveFreemiusDeveloperCredentialCandidates()).map((candidate) => candidate.source)).toEqual(['env-legacy']);

    // Cold, with Freemius throttling the key: nothing in memory says those names hold a developer
    // pair, so the binding stands. Checkout opens with the developer public key and writes the
    // order, and the developer secret verifies the bound product's webhooks.
    const { tables } = installCheckoutDatabase();
    await expect(checkout('28609')).resolves.toMatchObject({
      customProps: { public_key: DEV_PAIR.publicKey, credential_source: 'single-product-env' },
    });
    expect(tables.orders).toHaveLength(1);
    await expect(verify(refund('28609'), DEV_PAIR.secretKey)).resolves.toEqual({ outcome: 'valid', productId: '28609' });
    // For that product only: another one waits for Freemius (503).
    await expect(verify(refund('24851'), DEV_PAIR.secretKey)).resolves.toMatchObject({
      outcome: 'unverifiable',
      reason: 'developer_pair_unreachable',
    });
    await expect(developerApi.getFreemiusDeveloperStatus({ wait: false })).resolves.toMatchObject({ state: 'unreachable' });

    // Freemius answers again (after the 30 s retry window) and accepts the pair at developer scope.
    throttled = false;
    vi.setSystemTime(new Date('2026-11-13T12:00:31Z'));
    await expect(developerApi.getFreemiusDeveloperStatus()).resolves.toMatchObject({ state: 'working', source: 'env-legacy' });

    // The binding is refused from then on: with the product's key read failing, its checkout gets
    // the keyed 503 with nothing written, and the developer secret verifies nothing.
    productRead = 503;
    const { writes } = installCheckoutDatabase();
    await expect(checkout('28609')).resolves.toMatchObject({ url: null, errorKey: 'ecommerce.checkout_payments_unavailable', errorStatus: 503 });
    expect(writes).toEqual([]);
    await expect(provider.resolveFreemiusProductCredentials('28609')).resolves.toMatchObject({
      source: 'none',
      refusal: 'one_product_keys_are_developer_pair',
    });
    await expect(verify(refund('28609'), DEV_PAIR.secretKey)).resolves.toMatchObject({
      outcome: 'unverifiable',
      reason: 'product_key_read_failed',
    });

    // And with the read answered, the product's own keys serve it; the developer secret stays refused.
    productRead = 200;
    vi.setSystemTime(new Date('2026-11-13T12:01:02Z'));
    installCheckoutDatabase();
    await expect(checkout('28609')).resolves.toMatchObject({
      customProps: { public_key: PRODUCTS['28609'].public_key, credential_source: 'developer-api' },
    });
    await expect(verify(refund('28609'), DEV_PAIR.secretKey)).resolves.toMatchObject({ outcome: 'invalid' });
    await expect(verify(refund('28609'), PRODUCTS['28609'].secret_key)).resolves.toEqual({ outcome: 'valid', productId: '28609' });
  });
});
