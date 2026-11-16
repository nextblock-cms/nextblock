import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The one key policy the checkout and the webhook check share (freemius-key-policy.ts): whether the
 * one-product keys (FREEMIUS_PUBLIC_KEY / FREEMIUS_SECRET_KEY), which may hold the developer key
 * pair, may serve as a product's keys. The real freemius-developer-api runs here; only the
 * candidate resolver and api.freemius.com are faked.
 */

const mocks = vi.hoisted(() => ({
  candidates: vi.fn<() => Promise<Array<Record<string, string>>>>(async () => []),
}));

vi.mock('server-only', () => ({}));
vi.mock('@nextblock-cms/db/server', async () => {
  const { isSandboxEnvironment } = await vi.importActual<{ isSandboxEnvironment: () => boolean }>(
    '../../../db/src/lib/config-resolve'
  );
  return { isSandboxEnvironment };
});
vi.mock('./payment-config', () => ({ resolveFreemiusDeveloperCredentialCandidates: mocks.candidates }));

import { forgetFreemiusDeveloperCaches, getFreemiusDeveloperStatus } from './freemius-developer-api';
import {
  createFreemiusLogThrottle,
  decideFreemiusOneProductStandIn,
  freemiusKeysMayBeDeveloperPair,
  parseFreemiusCheckoutCredentialsMap,
} from './freemius-key-policy';

const DEV = '4242';

type Call = { url: string; publicKey: string };

/**
 * api.freemius.com: the developer list answers `list(publicKey)`, a product-scope read of a product
 * answers `product(id, publicKey)` (both default to 401), with `productBody(id)` as its 200 body
 * (the product's id by default).
 */
function stubFreemius(
  options: {
    list?: (publicKey: string) => number;
    product?: (id: string, publicKey: string) => number;
    productBody?: (id: string) => unknown;
  } = {}
) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const authorization = String((init.headers as Record<string, string>)?.['Authorization'] ?? '');
    const publicKey = authorization.split(' ')[1]?.split(':')[1] ?? '';
    calls.push({ url: String(url), publicKey });
    const path = String(url).replace('https://api.freemius.com', '');
    if (path.startsWith(`/v1/developers/${DEV}/plugins.json`)) {
      const status = options.list?.(publicKey) ?? 401;
      return new Response(JSON.stringify(status === 200 ? { plugins: [{ id: 24851 }] } : { error: { code: 'x' } }), { status });
    }
    const product = path.match(/^\/v1\/plugins\/(\d+)\.json$/);
    if (product) {
      const status = options.product?.(product[1], publicKey) ?? 401;
      const body = status === 200 ? (options.productBody ? options.productBody(product[1]) : { id: Number(product[1]) }) : {};
      return new Response(JSON.stringify(body), { status });
    }
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  for (const name of ['FREEMIUS_PUBLIC_KEY', 'FREEMIUS_SECRET_KEY', 'FREEMIUS_PRODUCT_ID', 'FREEMIUS_CHECKOUT_PRODUCTS_JSON']) {
    vi.stubEnv(name, '');
  }
  forgetFreemiusDeveloperCaches();
  mocks.candidates.mockReset().mockImplementation(async () => []);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Review 2026-11-13, round 3: the parse error of a malformed FREEMIUS_CHECKOUT_PRODUCTS_JSON was
 * logged with V8's message, which quotes the text around the fault (part of a key), on every read:
 * twice per webhook, forged ones included.
 */
describe('parseFreemiusCheckoutCredentialsMap', () => {
  const LEAKY = '{"28609":{"publicKey":"pk_x","secretKey":sk_SUPERSECRET_0001}}';
  const TRAILING_COMMA = '{"28609":{"publicKey":"pk_y",}}';

  function loggedText() {
    return JSON.stringify(vi.mocked(console.error).mock.calls.map((args) => args.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg)))));
  }

  it('logs a malformed value once per value, with the error name and position only, never the text around the fault', () => {
    vi.stubEnv('FREEMIUS_CHECKOUT_PRODUCTS_JSON', LEAKY);

    for (let i = 0; i < 20; i += 1) {
      expect(parseFreemiusCheckoutCredentialsMap()).toBeNull();
    }

    expect(console.error).toHaveBeenCalledTimes(1);
    expect(loggedText()).toContain('FREEMIUS_CHECKOUT_PRODUCTS_JSON is not valid JSON (SyntaxError');
    for (const fragment of ['SUPERSECRET', 'SUPERSE', 'ecretKey', 'sk_', 'pk_x']) {
      expect(loggedText()).not.toContain(fragment);
    }

    // Another malformed value is said once too, with its position when V8 gives one.
    vi.stubEnv('FREEMIUS_CHECKOUT_PRODUCTS_JSON', TRAILING_COMMA);
    for (let i = 0; i < 5; i += 1) parseFreemiusCheckoutCredentialsMap();
    expect(console.error).toHaveBeenCalledTimes(2);
    expect(String(vi.mocked(console.error).mock.calls[1][0])).toMatch(/\(SyntaxError at position \d+\)/);
    expect(loggedText()).not.toContain('pk_y');
  });

  it('reads a valid map as before', () => {
    vi.stubEnv('FREEMIUS_CHECKOUT_PRODUCTS_JSON', JSON.stringify({ '28609': { publicKey: 'pk_a', secretKey: 'sk_a' } }));

    expect(parseFreemiusCheckoutCredentialsMap()).toEqual({ '28609': { publicKey: 'pk_a', secretKey: 'sk_a' } });
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe('createFreemiusLogThrottle', () => {
  it('says yes once per key per window, for a bounded number of keys', () => {
    vi.useFakeTimers({ now: new Date('2026-11-13T12:00:00Z'), toFake: ['Date'] });
    const shouldLog = createFreemiusLogThrottle({ windowMs: 60_000, maxKeys: 3 });

    expect([shouldLog('a'), shouldLog('a'), shouldLog('b'), shouldLog('c'), shouldLog('d')]).toEqual([true, false, true, true, false]);

    vi.setSystemTime(new Date('2026-11-13T12:01:01Z'));
    expect([shouldLog('d'), shouldLog('a'), shouldLog('a')]).toEqual([true, true, false]);

    // A clock that went back counts as a new window.
    vi.setSystemTime(new Date('2026-11-13T11:00:00Z'));
    expect(shouldLog('a')).toBe(true);
  });
});

/**
 * Review 2026-11-13, round 3: FREEMIUS_PRODUCT_ID-bound one-product keys were used whatever they
 * held. The checkout's bound keys and the webhook check's bound secrets now follow this predicate.
 */
describe('freemiusKeysMayBeDeveloperPair', () => {
  it('is false for keys that are a product’s, and for no keys, asking Freemius nothing', async () => {
    mocks.candidates.mockImplementation(async () => [{ developerId: DEV, publicKey: 'pk_dev_a', secretKey: 'sk_dev_a', source: 'env' }]);
    const { fetchMock } = stubFreemius();

    await expect(freemiusKeysMayBeDeveloperPair({ publicKey: 'pk_product', secretKey: 'sk_product' })).resolves.toBe(false);
    await expect(freemiusKeysMayBeDeveloperPair({ publicKey: null, secretKey: null })).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is true for a key of a dedicated pair, either key alone', async () => {
    mocks.candidates.mockImplementation(async () => [{ developerId: DEV, publicKey: 'pk_dev_b', secretKey: 'sk_dev_b', source: 'cms' }]);
    stubFreemius();

    await expect(freemiusKeysMayBeDeveloperPair({ publicKey: 'pk_dev_b', secretKey: 'sk_dev_b' })).resolves.toBe(true);
    await expect(freemiusKeysMayBeDeveloperPair({ publicKey: 'pk_other', secretKey: 'sk_dev_b' })).resolves.toBe(true);
    await expect(freemiusKeysMayBeDeveloperPair({ publicKey: 'pk_dev_b', secretKey: null })).resolves.toBe(true);
  });

  it('is true for the working pair under the one-product names, and stays true once Freemius refuses it (revoked while running)', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-13T12:00:00Z'), toFake: ['Date'] });
    const LEGACY = { developerId: DEV, publicKey: 'pk_dev_c', secretKey: 'sk_dev_c', source: 'env-legacy' };
    mocks.candidates.mockImplementation(async () => [LEGACY]);
    let revoked = false;
    stubFreemius({ list: () => (revoked ? 401 : 200) });
    const keys = { publicKey: LEGACY.publicKey, secretKey: LEGACY.secretKey };

    // Before Freemius was ever asked, nothing says so: such a binding stands, offline too.
    await expect(freemiusKeysMayBeDeveloperPair(keys)).resolves.toBe(false);

    await getFreemiusDeveloperStatus();
    await expect(freemiusKeysMayBeDeveloperPair(keys)).resolves.toBe(true);

    revoked = true;
    vi.setSystemTime(new Date('2026-11-13T12:10:01Z'));
    await expect(getFreemiusDeveloperStatus()).resolves.toMatchObject({ state: 'refused' });
    await expect(freemiusKeysMayBeDeveloperPair(keys)).resolves.toBe(true);
  });

  it('is true when the facts cannot be read (the caller then refuses the keys)', async () => {
    mocks.candidates.mockRejectedValue(new Error('database down'));

    await expect(freemiusKeysMayBeDeveloperPair({ publicKey: 'pk_product', secretKey: 'sk_product' })).resolves.toBe(true);
  });
});

/**
 * Review 2026-11-13, round 3: with every configured developer pair under the one-product names and
 * refused, those names stood in for every product without bound keys, though they may be a revoked
 * developer pair. They now stand in for a product only once Freemius confirms they are its keys.
 */
describe('decideFreemiusOneProductStandIn when the only pair is the one-product names and Freemius refuses it', () => {
  const ONE_PRODUCT = { publicKey: 'pk_one_product_d', secretKey: 'sk_one_product_d' };
  const LEGACY_ONLY = { developerId: DEV, ...ONE_PRODUCT, source: 'env-legacy' };
  const productScopeCalls = (calls: Call[]) => calls.filter((call) => call.url.startsWith('https://api.freemius.com/v1/plugins/'));

  beforeEach(() => {
    vi.stubEnv('FREEMIUS_PUBLIC_KEY', ONE_PRODUCT.publicKey);
    vi.stubEnv('FREEMIUS_SECRET_KEY', ONE_PRODUCT.secretKey);
    mocks.candidates.mockImplementation(async () => [LEGACY_ONLY]);
  });

  it('allows them for the product Freemius confirms they belong to, and only that one', async () => {
    const { calls } = stubFreemius({ product: (id, publicKey) => (id === '28609' && publicKey === ONE_PRODUCT.publicKey ? 200 : 401) });

    await expect(decideFreemiusOneProductStandIn('28609', { keyReadFailed: false })).resolves.toMatchObject({
      allowed: true,
      developer: { state: 'refused' },
    });
    await expect(decideFreemiusOneProductStandIn('24851', { keyReadFailed: false })).resolves.toMatchObject({
      allowed: false,
      reason: 'one_product_keys_not_this_product',
    });
    expect(productScopeCalls(calls).map((call) => call.url)).toEqual([
      'https://api.freemius.com/v1/plugins/28609.json',
      'https://api.freemius.com/v1/plugins/24851.json',
    ]);
  });

  it('refuses while Freemius does not answer the confirmation', async () => {
    stubFreemius({ product: () => 503 });

    await expect(decideFreemiusOneProductStandIn('28609', { keyReadFailed: false })).resolves.toMatchObject({
      allowed: false,
      reason: 'one_product_keys_unconfirmed',
    });
  });

  it.each([
    ['{}', () => ({})],
    ['{ "id": null }', () => ({ id: null })],
    ['an error body', () => ({ error: { code: 'unknown', message: 'Something went wrong.' } })],
  ])('refuses while Freemius answers the confirmation with a 200 that is not the product (%s), for every product', async (_label, productBody) => {
    // Review 2026-11-13, round 3 (K1): such a 200 confirmed a revoked developer pair left under the
    // one-product names for every product it was asked about.
    const { calls } = stubFreemius({ product: () => 200, productBody });

    for (const productId of ['28609', '24851', '43273']) {
      await expect(decideFreemiusOneProductStandIn(productId, { keyReadFailed: false }), productId).resolves.toMatchObject({
        allowed: false,
        reason: 'one_product_keys_unconfirmed',
        developer: { state: 'refused' },
      });
    }
    expect(productScopeCalls(calls)).toHaveLength(3);
  });

  it('sends no confirmation request with confirm: false (a webhook its secret did not sign)', async () => {
    const { calls } = stubFreemius({ product: () => 200 });

    await expect(decideFreemiusOneProductStandIn('28609', { keyReadFailed: false, confirm: false })).resolves.toMatchObject({
      allowed: false,
      reason: 'one_product_keys_unconfirmed',
    });
    expect(productScopeCalls(calls)).toEqual([]);
  });

  it('refuses keys Freemius accepted at developer scope earlier (a revoked pair), without asking it to confirm them', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-13T12:00:00Z'), toFake: ['Date'] });
    const REVOKED = { developerId: DEV, publicKey: 'pk_dev_revoked_d', secretKey: 'sk_dev_revoked_d', source: 'env-legacy' };
    vi.stubEnv('FREEMIUS_PUBLIC_KEY', REVOKED.publicKey);
    vi.stubEnv('FREEMIUS_SECRET_KEY', REVOKED.secretKey);
    mocks.candidates.mockImplementation(async () => [REVOKED]);
    let revoked = false;
    const { calls } = stubFreemius({ list: () => (revoked ? 401 : 200), product: () => 200 });

    await getFreemiusDeveloperStatus();
    revoked = true;
    vi.setSystemTime(new Date('2026-11-13T12:10:01Z'));

    await expect(decideFreemiusOneProductStandIn('28609', { keyReadFailed: false })).resolves.toMatchObject({
      allowed: false,
      reason: 'one_product_keys_are_developer_pair',
      developer: { state: 'refused' },
    });
    expect(productScopeCalls(calls)).toEqual([]);
  });

  it('keeps the offline answer without a developer pair: allowed, nothing sent', async () => {
    mocks.candidates.mockImplementation(async () => []);
    const { fetchMock } = stubFreemius();

    await expect(decideFreemiusOneProductStandIn('28609', { keyReadFailed: false })).resolves.toMatchObject({
      allowed: true,
      developer: { state: 'missing' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
