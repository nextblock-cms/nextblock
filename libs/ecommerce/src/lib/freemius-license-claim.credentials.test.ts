import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Review 2026-11-13 (vendor license routes, L4): a Freemius 401/403 to the vendor's own keys is a
 * configuration error, not a missing license.
 *
 * On the per-product fallback the claim asked through `@freemius/sdk`, whose `license.retrieve`
 * returns null for ANY failure: a wrong bearer token read as `license_not_found`, and the claim route
 * logged a `console.warn` refusal for every claim of that product (an outage read the same way).
 * Now a 401/403 is `credentials_refused` (the buyer still sees the uniform 403) and one
 * `console.error` line a minute per credential and product says what to fix, naming no key; a 429 or
 * 5xx is `upstream_error` (502). At developer scope a 401/403 is logged the same way before the
 * claim falls back to the product's bearer.
 */

const mocks = vi.hoisted(() => ({
  candidates: vi.fn<() => Promise<Array<Record<string, string>>>>(async () => []),
}));

vi.mock('server-only', () => ({}));
vi.mock('@nextblock-cms/db/server', async () => {
  const { isSandboxEnvironment } = await vi.importActual<{ isSandboxEnvironment: () => boolean }>(
    '../../../db/src/lib/config-resolve'
  );
  return { createClient: () => ({}), getServiceRoleSupabaseClient: () => ({}), isSandboxEnvironment };
});
vi.mock('./payment-config', () => ({
  hydrateFreemiusEnvFromDb: async () => undefined,
  resolveFreemiusDeveloperCredentialCandidates: mocks.candidates,
}));

const DEV = '4242';
const PAIR = { developerId: DEV, publicKey: 'pk_dev_claim_pair', secretKey: 'sk_dev_claim_pair_secret', source: 'env' };
const BEARER = { publicKey: 'pk_cortex_claim', secretKey: 'sk_cortex_claim_secret_0123456789abcdef', apiKey: 'fs_claim_bearer_token' };
const KEY_MATERIAL = [PAIR.publicKey, PAIR.secretKey, BEARER.publicKey, BEARER.secretKey, BEARER.apiKey];
const NOW = new Date('2026-11-13T12:00:00Z');
const FRESH_LICENSE = {
  id: 6001,
  plugin_id: 28609,
  user_id: 77,
  plan_id: 47122,
  activated: 0,
  is_cancelled: false,
  created: '2026-11-13 11:58:00',
  secret_key: 'sk_claimed_license_key',
};
const REQUEST = { email: 'Buyer@Example.com', kind: 'purchase' as const, licenseId: '6001', productId: '28609', userId: '77' };

type Call = { method: string; host: string; path: string; authorization: string };
type Answer = { status: number; body?: unknown };

/** Fresh modules per test: the log throttle and the developer caches are module state. */
async function load() {
  vi.resetModules();
  const claim = await import('./freemius-license-claim');
  const developer = await import('./freemius-developer-api');
  developer.forgetFreemiusDeveloperCaches();
  return claim;
}

/** fast-api.freemius.com (the SDK's bearer client) and api.freemius.com (developer scope), then `answer`. */
function stubFreemius(answer: (call: Call) => Answer | undefined) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input));
    const headers = new Headers(request ? request.headers : (init.headers as HeadersInit | undefined));
    const developerPrefix = `/v1/developers/${DEV}`;
    const call: Call = {
      method: (request ? request.method : init.method) ?? 'GET',
      host: url.host,
      path: url.pathname.startsWith(developerPrefix) ? url.pathname.slice(developerPrefix.length) : url.pathname.replace(/^\/v1/, ''),
      authorization: headers.get('authorization') ?? '',
    };
    calls.push(call);
    const result =
      answer(call) ??
      (call.host === 'api.freemius.com' && call.path === '/plugins.json'
        ? { status: 200, body: { plugins: [{ id: 28609 }] } }
        : { status: 404, body: { error: { code: 'not_found', message: 'Not found.' } } });
    return new Response(result.body === undefined ? '' : JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls };
}

/** The bearer answers: the license and its owner, unless `override` answers first. */
function bearerFreemius(override: (call: Call) => Answer | undefined = () => undefined) {
  return stubFreemius((call) => {
    const custom = override(call);
    if (custom) return custom;
    if (call.host !== 'fast-api.freemius.com') return undefined;
    if (call.path === '/products/28609/licenses/6001.json') return { status: 200, body: FRESH_LICENSE };
    if (call.path === '/products/28609/users/77.json') return { status: 200, body: { id: 77, email: 'buyer@example.com' } };
    return undefined;
  });
}

function loggedText(): string {
  const lines = [
    ...vi.mocked(console.error).mock.calls,
    ...vi.mocked(console.warn).mock.calls,
    ...vi.mocked(console.log).mock.calls,
  ];
  return lines.map((args) => args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' ')).join('\n');
}

function configurationLines(): string[] {
  return vi
    .mocked(console.error)
    .mock.calls.map((args) => args.map(String).join(' '))
    .filter((line) => line.includes('Configuration error'));
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  for (const name of ['FREEMIUS_CHECKOUT_PRODUCTS_JSON', 'FREEMIUS_SECRET_KEY', 'FREEMIUS_PUBLIC_KEY', 'FREEMIUS_API_KEY', 'FREEMIUS_PRODUCT_ID']) {
    vi.stubEnv(name, '');
  }
  vi.stubEnv('FREEMIUS_CHECKOUT_PRODUCTS_JSON', JSON.stringify({ '28609': BEARER }));
  mocks.candidates.mockReset().mockImplementation(async () => []);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the claim with the product bearer token', () => {
  it('hands out the key of a fresh license, signed with the bearer token only', async () => {
    const { claimFreemiusLicenseKey } = await load();
    const { calls } = bearerFreemius();

    await expect(claimFreemiusLicenseKey(REQUEST, { now: NOW })).resolves.toEqual({
      ok: true,
      licenseKey: 'sk_claimed_license_key',
      planId: '47122',
      expiration: null,
    });
    expect(calls.map((call) => `${call.host}${call.path}`)).toEqual([
      'fast-api.freemius.com/products/28609/licenses/6001.json',
      'fast-api.freemius.com/products/28609/users/77.json',
    ]);
    expect(calls.every((call) => call.authorization === `Bearer ${BEARER.apiKey}`)).toBe(true);
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each([401, 403])('a %i on the license lookup is a configuration error: the uniform 403, one line a minute, no key named', async (status) => {
    const { claimFreemiusLicenseKey, FREEMIUS_LICENSE_CLAIM_REFUSED_MESSAGE } = await load();
    bearerFreemius((call) => (call.path === '/products/28609/licenses/6001.json' ? { status, body: { error: { message: 'Unauthorized' } } } : undefined));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(claimFreemiusLicenseKey(REQUEST, { now: NOW })).resolves.toEqual({
        error: FREEMIUS_LICENSE_CLAIM_REFUSED_MESSAGE,
        ok: false,
        reason: 'credentials_refused',
        status: 403,
      });
    }

    expect(configurationLines()).toHaveLength(1);
    expect(configurationLines()[0]).toContain(`product 28609's API bearer token`);
    expect(configurationLines()[0]).toContain(`answered ${status}`);
    expect(console.warn).not.toHaveBeenCalled();
    for (const secret of KEY_MATERIAL) expect(loggedText()).not.toContain(secret);
  });

  it('a 401 on the owner lookup is a configuration error too', async () => {
    const { claimFreemiusLicenseKey } = await load();
    bearerFreemius((call) => (call.path === '/products/28609/users/77.json' ? { status: 401, body: {} } : undefined));

    await expect(claimFreemiusLicenseKey(REQUEST, { now: NOW })).resolves.toMatchObject({ ok: false, reason: 'credentials_refused', status: 403 });
    expect(configurationLines()).toEqual([expect.stringContaining('on the user lookup')]);
  });

  it('a 404 is a missing license (the uniform 403, nothing logged here), never a configuration error', async () => {
    const { claimFreemiusLicenseKey } = await load();
    bearerFreemius((call) => (call.path === '/products/28609/licenses/6001.json' ? { status: 404, body: { error: { code: 'license_not_found' } } } : undefined));

    await expect(claimFreemiusLicenseKey(REQUEST, { now: NOW })).resolves.toMatchObject({ ok: false, reason: 'license_not_found', status: 403 });
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each([429, 500, 503])('a %i is Freemius failing to answer: 502, never a refusal the route would cache as a miss', async (status) => {
    const { claimFreemiusLicenseKey } = await load();
    bearerFreemius((call) => (call.path === '/products/28609/licenses/6001.json' ? { status, body: {} } : undefined));

    await expect(claimFreemiusLicenseKey(REQUEST, { now: NOW })).resolves.toMatchObject({ ok: false, reason: 'upstream_error', status: 502 });
    expect(configurationLines()).toEqual([]);
  });
});

describe('the claim at developer scope', () => {
  beforeEach(() => {
    mocks.candidates.mockImplementation(async () => [PAIR]);
  });

  it('a 401 on the license read logs a configuration error, then falls back to the product bearer', async () => {
    const { claimFreemiusLicenseKey } = await load();
    const { calls } = bearerFreemius((call) =>
      call.host === 'api.freemius.com' && call.path === '/plugins/28609/licenses/6001.json' ? { status: 401, body: {} } : undefined
    );

    await expect(claimFreemiusLicenseKey(REQUEST, { now: NOW })).resolves.toMatchObject({ ok: true, licenseKey: 'sk_claimed_license_key' });
    expect(configurationLines()).toEqual([expect.stringContaining('to the developer key pair on the license lookup for product 28609')]);
    expect(calls.some((call) => call.host === 'fast-api.freemius.com')).toBe(true);
    for (const secret of KEY_MATERIAL) expect(loggedText()).not.toContain(secret);
  });

  it('without a bearer to fall back to, the claim is not configured (503), still logged once', async () => {
    vi.stubEnv('FREEMIUS_CHECKOUT_PRODUCTS_JSON', '');
    const { claimFreemiusLicenseKey } = await load();
    bearerFreemius((call) =>
      call.host === 'api.freemius.com' && call.path === '/plugins/28609/licenses/6001.json' ? { status: 403, body: {} } : undefined
    );

    await expect(claimFreemiusLicenseKey(REQUEST, { now: NOW })).resolves.toMatchObject({ ok: false, reason: 'not_configured', status: 503 });
    expect(configurationLines()).toHaveLength(1);
  });
});
