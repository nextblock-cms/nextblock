import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Freemius at developer scope (freemius-developer-api.ts): one developer key pair reaches every
 * product of the account, so nextblock.dev sells 24851 / 28609 / 43273 without per-product keys.
 *
 * The pair is a master key for the whole Freemius account: requests are signed exactly like the
 * official PHP SDK, ids in paths are digits only, a pair is used only once Freemius accepts it, and
 * on the public sandbox (NEXT_PUBLIC_IS_SANDBOX=true, published admin login) nothing but the
 * GET-only catalog reader runs, for the demo's own 15-minute reset (Sync from Freemius refuses
 * there). No key ever reaches a log.
 */

const mocks = vi.hoisted(() => ({
  candidates: vi.fn<() => Promise<Array<Record<string, string>>>>(async () => []),
  /** What Next's after() received: work scheduled for after the response. */
  afterTasks: [] as Array<() => unknown>,
  after: vi.fn<(task: () => unknown) => void>(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/server', () => ({ after: mocks.after }));
vi.mock('@nextblock-cms/db/server', async () => {
  // The real predicate (a dependency-free module): the env stub drives the refusal.
  const { isSandboxEnvironment } = await vi.importActual<{ isSandboxEnvironment: () => boolean }>(
    '../../../db/src/lib/config-resolve'
  );
  return { isSandboxEnvironment };
});
vi.mock('./payment-config', () => ({ resolveFreemiusDeveloperCredentialCandidates: mocks.candidates }));

import {
  FREEMIUS_DEVELOPER_SANDBOX_MESSAGE,
  FreemiusApiError,
  canUseFreemiusDeveloperScope,
  confirmFreemiusOneProductKeys,
  describeFreemiusDeveloperPairs,
  forgetFreemiusDeveloperCaches,
  formatFreemiusRequestDate,
  freemiusDeveloperRequest,
  getFreemiusDeveloperStatus,
  getFreemiusProductKeys,
  openFreemiusCatalogReader,
  orNullWhenNotFound,
  signFreemiusRequest,
  toFreemiusId,
  withFreemiusDeveloperScope,
} from './freemius-developer-api';

const DEV = '1234';
const GOOD_PAIR = { developerId: DEV, publicKey: 'pk_dev_public_0001', secretKey: 'sk_dev_secret_0001', source: 'env' };
const LEGACY_PRODUCT_PAIR = { developerId: DEV, publicKey: 'pk_product_24851', secretKey: 'sk_product_24851', source: 'cms-legacy' };
const PRODUCT_KEYS: Record<string, { public_key: string; secret_key: string }> = {
  '24851': { public_key: 'pk_commerce_0001', secret_key: 'sk_commerce_0001' },
  '28609': { public_key: 'pk_cortex_0001', secret_key: 'sk_cortex_0001' },
  '43273': { public_key: 'pk_affiliates_0001', secret_key: 'sk_affiliates_0001' },
};

type Call = { url: string; init: RequestInit };
type Answer = { status: number; body?: unknown };

/**
 * A fake api.freemius.com: `answer(path, call)` decides each response (path without the host,
 * query included). By default the good pair lists the three products and reads their keys.
 */
function stubFreemiusApi(answer?: (path: string, call: Call) => Answer | undefined) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    const path = String(url).replace('https://api.freemius.com', '');
    const custom = answer?.(path, call);
    const result = custom ?? defaultAnswer(path, call);
    return new Response(result.body === undefined ? '' : JSON.stringify(result.body), { status: result.status });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

function lastCall(calls: Call[]): Call {
  const call = calls.at(-1);
  if (!call) throw new Error('no request was sent');
  return call;
}

function authorizationPublicKey(call: Call) {
  const header = String((call.init.headers as Record<string, string>)['Authorization'] ?? '');
  return header.split(' ')[1]?.split(':')[1] ?? '';
}

function defaultAnswer(path: string, call: Call): Answer {
  if (authorizationPublicKey(call) !== GOOD_PAIR.publicKey) {
    return { status: 401, body: { error: { type: 'UnauthorizedAccess', code: 'unauthorized_access', message: 'Invalid authorization header.' } } };
  }
  if (path.startsWith(`/v1/developers/${DEV}/plugins.json`)) {
    return { status: 200, body: { plugins: Object.keys(PRODUCT_KEYS).map((id) => ({ id: Number(id), ...PRODUCT_KEYS[id] })) } };
  }
  const product = path.match(new RegExp(`^/v1/developers/${DEV}/plugins/(\\d+)\\.json$`));
  if (product && PRODUCT_KEYS[product[1]]) {
    return { status: 200, body: { id: Number(product[1]), title: 'Product', ...PRODUCT_KEYS[product[1]] } };
  }
  return { status: 404, body: { error: { code: 'not_found', message: 'Not found.' } } };
}

/** The Authorization header the PHP SDK would compute for the same request. */
function expectSignedLikeThePhpSdk(call: Call, secretKey: string) {
  const headers = call.init.headers as Record<string, string>;
  const path = call.url.replace('https://api.freemius.com', '');
  const expected = signFreemiusRequest({
    body: typeof call.init.body === 'string' ? call.init.body : '',
    date: headers['Date'],
    method: (call.init.method ?? 'GET') as 'GET',
    path,
    publicKey: authorizationPublicKey(call),
    scopeId: DEV,
    secretKey,
  });
  expect(headers['Authorization']).toBe(expected.authorization);
  return expected;
}

/** The request paths sent, relative to the developer (`/plugins.json?…`, `/plugins/24851.json`). */
function developerPaths(calls: Call[]) {
  return calls.map((call) => call.url.replace(`https://api.freemius.com/v1/developers/${DEV}`, ''));
}

/** Runs what after() was handed, as Next does once the response is sent. */
async function runAfterTasks() {
  for (const task of mocks.afterTasks.splice(0)) {
    await task();
  }
}

/** Rejects when `promise` takes longer than `ms`: a call that waited on a Freemius request that never answers. */
function withinMs<T>(promise: Promise<T>, ms = 1_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms)),
  ]);
}

/** The default fake Freemius, except that nothing is answered until `open()` is called. */
function stubGatedFreemiusApi() {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const stub = stubFreemiusApi();
  const answer = stub.fetchMock.getMockImplementation();
  stub.fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    await gate;
    if (!answer) throw new Error('no fake Freemius');
    return answer(url, init);
  });
  return { ...stub, open };
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  forgetFreemiusDeveloperCaches();
  mocks.candidates.mockReset().mockImplementation(async () => [GOOD_PAIR]);
  mocks.afterTasks.length = 0;
  mocks.after.mockReset().mockImplementation((task) => {
    mocks.afterTasks.push(task);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('signFreemiusRequest (vectors from the official Freemius PHP SDK)', () => {
  // Computed with GenerateAuthorizationParams + Base64UrlEncode of Freemius/freemius-php-sdk
  // (master, freemius/Freemius.php and freemius/FreemiusBase.php), run by PHP 8.4 with these
  // test keys and the clock at 2026-11-12 15:00:00 UTC.
  const PHP = {
    id: '1234',
    publicKey: 'pk_0123456789abcdef0123456789abc',
    secretKey: 'sk_test-vector+secret/0123456789=',
    date: 'Thu, 12 Nov 2026 15:00:00 +0000',
    body: '{"code":"NBTEST","discount":10,"discount_type":"percentage","is_active":false}',
  };

  it('formats the Date header as PHP date("r") prints it in UTC', () => {
    expect(formatFreemiusRequestDate(new Date(1794495600 * 1000))).toBe(PHP.date);
    expect(formatFreemiusRequestDate(new Date(Date.UTC(2026, 10, 5, 7, 8, 9)))).toBe('Thu, 05 Nov 2026 07:08:09 +0000');
  });

  it('signs a GET without content type or MD5, and never signs the query string', () => {
    const base = { date: PHP.date, method: 'GET' as const, publicKey: PHP.publicKey, scopeId: PHP.id, secretKey: PHP.secretKey };
    const vector =
      'FS 1234:pk_0123456789abcdef0123456789abc:NTVlMGNhMmQyMjgwOTJkMTQ2MDJmYTIzMjdkNzg4MTYzOTE3Yjk1NWNjZGZmM2YwNDhmNjNhODFlODI4ZmI4Mw';

    expect(signFreemiusRequest({ ...base, path: '/v1/developers/1234/plugins/24851/licenses.json' })).toEqual({
      authorization: vector,
      contentMd5: null,
      contentType: null,
    });
    expect(signFreemiusRequest({ ...base, path: '/v1/developers/1234/plugins/24851/licenses.json?count=1&email=a%40b.c' }).authorization).toBe(vector);
  });

  it('signs a POST and a PUT with application/json and the MD5 of the body', () => {
    const base = { body: PHP.body, date: PHP.date, publicKey: PHP.publicKey, scopeId: PHP.id, secretKey: PHP.secretKey };

    expect(signFreemiusRequest({ ...base, method: 'POST', path: '/v1/developers/1234/plugins/24851/coupons.json' })).toEqual({
      authorization:
        'FS 1234:pk_0123456789abcdef0123456789abc:YThiY2ViNzU2MzdjM2UzZjI2MzNmNTkzNDdmZGI5M2FmMjEwOWQyN2FkYTkxMzZjMzNlMTJiMjBjZjNkOTI0ZA',
      contentMd5: '0aaf8fc021bf854f240cb43a7b97c657',
      contentType: 'application/json',
    });
    expect(signFreemiusRequest({ ...base, method: 'PUT', path: '/v1/developers/1234/plugins/24851/coupons/777.json' })).toEqual({
      authorization:
        'FS 1234:pk_0123456789abcdef0123456789abc:MTZlMjU0NGZkNDk2YTcxMTdhMWE3NTQ2NmIyOTM2ZGRhMzU0NDk2OTU5YWI3NDE0ZjFiZDU5MzZmMmRhYWE4NQ',
      contentMd5: '0aaf8fc021bf854f240cb43a7b97c657',
      contentType: 'application/json',
    });
  });

  it('signs a DELETE with application/json and no MD5', () => {
    expect(
      signFreemiusRequest({
        date: PHP.date,
        method: 'DELETE',
        path: '/v1/developers/1234/plugins/24851/coupons/777.json',
        publicKey: PHP.publicKey,
        scopeId: PHP.id,
        secretKey: PHP.secretKey,
      })
    ).toEqual({
      authorization:
        'FS 1234:pk_0123456789abcdef0123456789abc:YTVlMzIyZTFjOWFhOGE4Y2U4YzQ4Y2FkYjVmYTc2NjZlNzExZTAyZTE5OTIwYmE4Y2YwZDhkZGQ5MmNkNGUxMg',
      contentMd5: null,
      contentType: 'application/json',
    });
  });

  it('uses FSP when the secret equals the public key, as the PHP SDK does', () => {
    expect(
      signFreemiusRequest({
        date: PHP.date,
        method: 'GET',
        path: '/v1/developers/1234/plugins.json',
        publicKey: PHP.publicKey,
        scopeId: PHP.id,
        secretKey: PHP.publicKey,
      }).authorization
    ).toBe('FSP 1234:pk_0123456789abcdef0123456789abc:MzQ0NDQzOGYyZGZhMTBhZTZlZjdlYjYwZjhmNWM1ZTQwMTkxZWQwM2UyM2FmN2VjMjQ2ZGEwYzQ5NGNjNDY3Nw');
  });
});

describe('toFreemiusId', () => {
  it('accepts positive digit ids only, so no caller can steer a signed path', () => {
    expect(toFreemiusId('24851')).toBe('24851');
    expect(toFreemiusId(' 43273 ')).toBe('43273');
    expect(toFreemiusId(28609)).toBe('28609');
    for (const bad of ['', '0', '-1', '1.5', '12a', '../1', '1/2', '1?x=1', '1e3', 0, -3, 1.5, NaN, null, undefined, {}]) {
      expect(toFreemiusId(bad), String(bad)).toBeNull();
    }
  });
});

describe('freemiusDeveloperRequest errors', () => {
  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [404, 'not_found'],
    [400, 'rejected'],
    [409, 'rejected'],
    [429, 'unavailable'],
    [500, 'unavailable'],
    [503, 'unavailable'],
  ] as const)('maps %s to %s, with Freemius’ own message and code', async (status, kind) => {
    stubFreemiusApi((path) =>
      path.includes('/licenses/9.json') ? { status, body: { error: { code: 'some_code', message: `Answer ${status}.` } } } : undefined
    );

    const error = await freemiusDeveloperRequest({ path: '/plugins/24851/licenses/9.json' }).catch((caught) => caught);

    expect(error).toBeInstanceOf(FreemiusApiError);
    expect(error).toMatchObject({ kind, status, code: 'some_code', message: `Answer ${status}.` });
  });

  it('reports an unreachable Freemius as unavailable', async () => {
    stubFreemiusApi();
    await getFreemiusDeveloperStatus(); // verified first
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(freemiusDeveloperRequest({ path: '/plugins/24851/licenses/9.json' })).rejects.toMatchObject({
      kind: 'unavailable',
      status: null,
    });
  });

  it('keeps an email in a query string out of the error', async () => {
    stubFreemiusApi((path) => (path.includes('/users.json') ? { status: 500, body: {} } : undefined));

    const error = (await freemiusDeveloperRequest({
      path: '/plugins/24851/users.json',
      query: { email: 'buyer@example.com' },
    }).catch((caught: unknown) => caught)) as FreemiusApiError;

    expect(error).toBeInstanceOf(FreemiusApiError);
    expect(error.path).toBe(`/v1/developers/${DEV}/plugins/24851/users.json`);
    expect(JSON.stringify({ message: error.message, path: error.path, code: error.code })).not.toContain('buyer@example.com');
  });

  it('refuses a malformed path or query before resolving a key or sending anything', async () => {
    const { fetchMock } = stubFreemiusApi();

    for (const path of ['/plugins/24851/../x.json', '/plugins/24851/licenses/9', 'plugins/1.json', '/plugins/1.json?x=1', '//evil.example/x.json']) {
      await expect(freemiusDeveloperRequest({ path }), path).rejects.toMatchObject({ kind: 'rejected' });
    }
    await expect(freemiusDeveloperRequest({ path: '/plugins/1.json', query: { 'a&b': 1 } })).rejects.toMatchObject({ kind: 'rejected' });

    expect(mocks.candidates).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('orNullWhenNotFound turns a 404 into null and keeps every other failure', async () => {
    stubFreemiusApi((path) => (path.includes('/licenses/1.json') ? { status: 404, body: {} } : path.includes('/licenses/2.json') ? { status: 500, body: {} } : undefined));

    await expect(orNullWhenNotFound(freemiusDeveloperRequest({ path: '/plugins/24851/licenses/1.json' }))).resolves.toBeNull();
    await expect(orNullWhenNotFound(freemiusDeveloperRequest({ path: '/plugins/24851/licenses/2.json' }))).rejects.toMatchObject({
      kind: 'unavailable',
    });
  });
});

describe('freemiusDeveloperRequest signing', () => {
  it('sends a GET signed like the PHP SDK, with no content type, no body and no redirects', async () => {
    const { calls } = stubFreemiusApi((path) => (path.includes('/licenses/9.json') ? { status: 200, body: { id: 9 } } : undefined));

    await expect(freemiusDeveloperRequest({ path: '/plugins/24851/licenses/9.json', query: { fields: 'id,secret_key' } })).resolves.toEqual({ id: 9 });

    const call = lastCall(calls);
    expect(call.url).toBe(`https://api.freemius.com/v1/developers/${DEV}/plugins/24851/licenses/9.json?fields=id%2Csecret_key`);
    expect(call.init).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store' });
    expect(call.init.body).toBeUndefined();
    expect(call.init.headers).not.toHaveProperty('Content-Type');
    expectSignedLikeThePhpSdk(call, GOOD_PAIR.secretKey);
  });

  it('sends a POST with the JSON body, its Content-MD5 and application/json, all signed', async () => {
    const { calls } = stubFreemiusApi((path, call) =>
      call.init.method === 'POST' ? { status: 201, body: { id: 555, code: 'NBTEST' } } : undefined
    );

    const answer = await freemiusDeveloperRequest({
      method: 'POST',
      path: '/plugins/24851/coupons.json',
      body: { code: 'NBTEST', discount: 10, discount_type: 'percentage' },
    });

    expect(answer).toEqual({ id: 555, code: 'NBTEST' });
    const call = lastCall(calls);
    const headers = call.init.headers as Record<string, string>;
    expect(call.url).toBe(`https://api.freemius.com/v1/developers/${DEV}/plugins/24851/coupons.json`);
    expect(call.init.body).toBe('{"code":"NBTEST","discount":10,"discount_type":"percentage"}');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Content-MD5']).toBe(crypto.createHash('md5').update(String(call.init.body)).digest('hex'));
    expect(expectSignedLikeThePhpSdk(call, GOOD_PAIR.secretKey).contentMd5).toBe(headers['Content-MD5']);
  });

  it('sends a DELETE with no body and no MD5', async () => {
    const { calls } = stubFreemiusApi((path, call) => (call.init.method === 'DELETE' ? { status: 200 } : undefined));

    await expect(freemiusDeveloperRequest({ method: 'DELETE', path: '/plugins/24851/coupons/777.json' })).resolves.toBeNull();

    const call = lastCall(calls);
    expect(call.init.body).toBeUndefined();
    expect(call.init.headers).not.toHaveProperty('Content-MD5');
    expect(call.init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expectSignedLikeThePhpSdk(call, GOOD_PAIR.secretKey);
  });
});

describe('which developer pair is used', () => {
  it('uses only a pair Freemius accepts, in the resolver’s order: a refused one is skipped', async () => {
    mocks.candidates.mockImplementation(async () => [LEGACY_PRODUCT_PAIR, GOOD_PAIR]);
    const { calls } = stubFreemiusApi((path) => (path.includes('/licenses/9.json') ? { status: 200, body: { id: 9 } } : undefined));

    await expect(getFreemiusDeveloperStatus()).resolves.toEqual({
      state: 'working',
      source: 'env',
      productIds: ['24851', '28609', '43273'],
    });
    await freemiusDeveloperRequest({ path: '/plugins/24851/licenses/9.json' });

    // One probe per pair, then the request signed with the accepted pair only.
    expect(calls.map((call) => authorizationPublicKey(call))).toEqual([
      LEGACY_PRODUCT_PAIR.publicKey,
      GOOD_PAIR.publicKey,
      GOOD_PAIR.publicKey,
    ]);
  });

  it('caches the verdicts: a second use asks Freemius nothing new about the pair', async () => {
    const { calls } = stubFreemiusApi();

    await getFreemiusDeveloperStatus();
    await getFreemiusDeveloperStatus();
    await canUseFreemiusDeveloperScope('24851');

    expect(calls).toHaveLength(1);
  });

  it('reports a refused pair, and none at all', async () => {
    mocks.candidates.mockImplementation(async () => [LEGACY_PRODUCT_PAIR]);
    stubFreemiusApi();
    await expect(getFreemiusDeveloperStatus()).resolves.toEqual({ state: 'refused', source: null, productIds: [] });

    mocks.candidates.mockImplementation(async () => []);
    await expect(getFreemiusDeveloperStatus()).resolves.toEqual({ state: 'missing', source: null, productIds: [] });
  });

  it('reads a 404 on the product list (no such developer: a wrong developer id) as refused, not unreachable', async () => {
    // Review 2026-11-13, round 2: read as unreachable, it counted as ready (buy buttons whose
    // checkouts and webhooks all answered 503) and was re-checked every 30 s.
    vi.useFakeTimers({ now: new Date('2026-11-13T12:00:00Z'), toFake: ['Date'] });
    const { fetchMock } = stubFreemiusApi((path) =>
      path.startsWith(`/v1/developers/${DEV}/plugins.json`) ? { status: 404, body: { error: { code: 'not_found', message: 'Not found.' } } } : undefined
    );

    await expect(getFreemiusDeveloperStatus()).resolves.toEqual({ state: 'refused', source: null, productIds: [] });
    await expect(getFreemiusDeveloperStatus({ wait: false })).resolves.toMatchObject({ state: 'refused' });
    await expect(getFreemiusProductKeys('24851')).resolves.toBeNull();

    // A refusal holds for the usual ten minutes, not the 30 s of an unanswered check.
    vi.setSystemTime(new Date('2026-11-13T12:05:00Z'));
    await getFreemiusDeveloperStatus();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-11-13T12:10:01Z'));
    await getFreemiusDeveloperStatus();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('still reads a 404 on a later page of the product list as Freemius failing to answer', async () => {
    const fifty = Array.from({ length: 50 }, (_, index) => ({ id: 100000 + index }));
    stubFreemiusApi((path) => {
      if (path.startsWith(`/v1/developers/${DEV}/plugins.json?count=50&offset=0`)) return { status: 200, body: { plugins: fifty } };
      if (path.startsWith(`/v1/developers/${DEV}/plugins.json`)) return { status: 404, body: {} };
      return undefined;
    });

    await expect(getFreemiusDeveloperStatus()).resolves.toMatchObject({ state: 'unreachable' });
  });

  it('stops probing once Freemius is unreachable, and says so', async () => {
    mocks.candidates.mockImplementation(async () => [LEGACY_PRODUCT_PAIR, GOOD_PAIR]);
    const { fetchMock } = stubFreemiusApi();
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(getFreemiusDeveloperStatus()).resolves.toEqual({ state: 'unreachable', source: null, productIds: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('checks the pair again after Freemius refuses a request (a revoked key)', async () => {
    let revoked = false;
    const { calls } = stubFreemiusApi((path) => {
      if (revoked) return { status: 401, body: {} };
      return path.includes('/licenses/9.json') ? { status: 200, body: { id: 9 } } : undefined;
    });

    await freemiusDeveloperRequest({ path: '/plugins/24851/licenses/9.json' });
    revoked = true;
    await expect(freemiusDeveloperRequest({ path: '/plugins/24851/licenses/9.json' })).rejects.toMatchObject({ kind: 'auth' });
    await expect(freemiusDeveloperRequest({ path: '/plugins/24851/licenses/9.json' })).rejects.toMatchObject({ kind: 'not_configured' });

    // list, license, license (401) → the pair is checked again (401): no further request is signed with it.
    expect(calls.map((call) => call.url.replace(`https://api.freemius.com/v1/developers/${DEV}`, ''))).toEqual([
      '/plugins.json?count=50&offset=0',
      '/plugins/24851/licenses/9.json',
      '/plugins/24851/licenses/9.json',
      '/plugins.json?count=50&offset=0',
    ]);
  });

  it('describeFreemiusDeveloperPairs says where the pairs come from and whether the one-product keys copy a dedicated one, never the keys', async () => {
    // Keys no other test of this file sends: what Freemius accepted is remembered for the module's life.
    const DEDICATED = { developerId: DEV, publicKey: 'pk_dev_describe', secretKey: 'sk_dev_describe', source: 'env' };
    mocks.candidates.mockImplementation(async () => [DEDICATED, LEGACY_PRODUCT_PAIR]);
    const { fetchMock } = stubFreemiusApi();

    const copied = await describeFreemiusDeveloperPairs({ publicKey: DEDICATED.publicKey, secretKey: DEDICATED.secretKey });
    expect(copied).toEqual({ sources: ['env', 'cms-legacy'], sharesDedicatedKey: true, sharesWorkingLegacyKey: false, sharesVerifiedKey: false });
    // Either key alone counts; a legacy pair's own keys never do (that is what `sources` is for).
    await expect(describeFreemiusDeveloperPairs({ publicKey: null, secretKey: DEDICATED.secretKey })).resolves.toMatchObject({ sharesDedicatedKey: true });
    await expect(describeFreemiusDeveloperPairs({ publicKey: DEDICATED.publicKey, secretKey: 'sk_other' })).resolves.toMatchObject({ sharesDedicatedKey: true });
    await expect(
      describeFreemiusDeveloperPairs({ publicKey: LEGACY_PRODUCT_PAIR.publicKey, secretKey: LEGACY_PRODUCT_PAIR.secretKey })
    ).resolves.toEqual({ sources: ['env', 'cms-legacy'], sharesDedicatedKey: false, sharesWorkingLegacyKey: false, sharesVerifiedKey: false });
    await expect(describeFreemiusDeveloperPairs({ publicKey: null, secretKey: null })).resolves.toMatchObject({ sharesDedicatedKey: false });

    expect(JSON.stringify(copied)).not.toContain(DEDICATED.secretKey);
    expect(JSON.stringify(copied)).not.toContain(DEDICATED.publicKey);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('describeFreemiusDeveloperPairs says when the working pair is the one-product names, and remembers keys Freemius accepted once revoked', async () => {
    // Review 2026-11-13, round 3: FREEMIUS_PRODUCT_ID-bound one-product keys were used whatever they
    // held, the developer pair included (a revoked one too).
    vi.useFakeTimers({ now: new Date('2026-11-13T12:00:00Z'), toFake: ['Date'] });
    const LEGACY_PAIR = { developerId: DEV, publicKey: 'pk_dev_legacy_names', secretKey: 'sk_dev_legacy_names', source: 'env-legacy' };
    mocks.candidates.mockImplementation(async () => [LEGACY_PAIR]);
    let revoked = false;
    stubFreemiusApi((path, call) =>
      path.startsWith(`/v1/developers/${DEV}/plugins.json`) && authorizationPublicKey(call) === LEGACY_PAIR.publicKey && !revoked
        ? { status: 200, body: { plugins: [{ id: 24851 }] } }
        : undefined
    );
    const keys = { publicKey: LEGACY_PAIR.publicKey, secretKey: LEGACY_PAIR.secretKey };

    // Nothing is known before Freemius is asked: nothing here asks it.
    await expect(describeFreemiusDeveloperPairs(keys)).resolves.toMatchObject({ sharesWorkingLegacyKey: false, sharesVerifiedKey: false });

    await expect(getFreemiusDeveloperStatus()).resolves.toMatchObject({ state: 'working', source: 'env-legacy' });
    await expect(describeFreemiusDeveloperPairs(keys)).resolves.toEqual({
      sources: ['env-legacy'],
      sharesDedicatedKey: false,
      sharesWorkingLegacyKey: true,
      sharesVerifiedKey: true,
    });
    // Either key alone counts.
    await expect(describeFreemiusDeveloperPairs({ publicKey: 'pk_product', secretKey: LEGACY_PAIR.secretKey })).resolves.toMatchObject({
      sharesWorkingLegacyKey: true,
      sharesVerifiedKey: true,
    });

    // Revoked while the instance runs: refused at the re-check, still known as a developer pair,
    // through a Sync or a save (forgetFreemiusDeveloperCaches) too.
    revoked = true;
    vi.setSystemTime(new Date('2026-11-13T12:10:01Z'));
    await expect(getFreemiusDeveloperStatus()).resolves.toMatchObject({ state: 'refused' });
    await expect(describeFreemiusDeveloperPairs(keys)).resolves.toMatchObject({ sharesWorkingLegacyKey: false, sharesVerifiedKey: true });
    forgetFreemiusDeveloperCaches();
    await expect(describeFreemiusDeveloperPairs(keys)).resolves.toMatchObject({ sharesVerifiedKey: true });
    // Another developer id with the same keys is still those keys.
    mocks.candidates.mockImplementation(async () => [{ ...LEGACY_PAIR, developerId: '9999' }]);
    await expect(describeFreemiusDeveloperPairs(keys)).resolves.toMatchObject({ sharesVerifiedKey: true });
    // A product's keys never are.
    await expect(describeFreemiusDeveloperPairs({ publicKey: 'pk_product', secretKey: 'sk_product' })).resolves.toMatchObject({ sharesVerifiedKey: false });
  });

  it('withFreemiusDeveloperScope hands back to the caller when the pair cannot do the work', async () => {
    stubFreemiusApi();
    const work = vi.fn(async () => 'done');

    await expect(withFreemiusDeveloperScope('24851', work)).resolves.toEqual({ handled: true, value: 'done' });
    // Another account's product: the caller's own keys take over, nothing is attempted here.
    await expect(withFreemiusDeveloperScope('99999', work)).resolves.toEqual({ handled: false });
    expect(work).toHaveBeenCalledTimes(1);
    // A refusal (401/403) is handed back too; any other failure is the caller's.
    await expect(withFreemiusDeveloperScope('24851', async () => {
      throw new FreemiusApiError('auth', 'refused');
    })).resolves.toEqual({ handled: false });
    await expect(withFreemiusDeveloperScope('24851', async () => {
      throw new FreemiusApiError('rejected', 'Coupon code already exists.');
    })).rejects.toMatchObject({ kind: 'rejected' });
  });
});

describe('getFreemiusProductKeys', () => {
  it('reads each product’s own keys with the developer pair, once, from memory after that', async () => {
    const { calls } = stubFreemiusApi();

    for (const id of ['24851', '28609', '43273']) {
      await expect(getFreemiusProductKeys(id)).resolves.toMatchObject({
        productId: id,
        publicKey: PRODUCT_KEYS[id].public_key,
        secretKey: PRODUCT_KEYS[id].secret_key,
      });
    }
    await getFreemiusProductKeys('24851');

    expect(calls.map((call) => call.url.replace(`https://api.freemius.com/v1/developers/${DEV}`, ''))).toEqual([
      '/plugins.json?count=50&offset=0',
      '/plugins/24851.json',
      '/plugins/28609.json',
      '/plugins/43273.json',
    ]);
  });

  it('never reads a product the account does not list, and re-reads the list at most once a minute', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-12T15:00:00Z'), toFake: ['Date'] });
    const { calls } = stubFreemiusApi();

    await expect(getFreemiusProductKeys('99999')).resolves.toBeNull();
    await expect(getFreemiusProductKeys('99999')).resolves.toBeNull();
    expect(calls).toHaveLength(1); // the first list only: a fresh list is not re-read

    vi.setSystemTime(new Date('2026-11-12T15:01:01Z'));
    await expect(getFreemiusProductKeys('99999')).resolves.toBeNull();
    expect(calls).toHaveLength(2); // one re-read, still no product request
    expect(calls.every((call) => call.url.includes('/plugins.json?'))).toBe(true);
  });

  it('picks up a product added in Freemius after a minute, with nothing configured', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-12T15:00:00Z'), toFake: ['Date'] });
    let added = false;
    stubFreemiusApi((path) => {
      if (path.startsWith(`/v1/developers/${DEV}/plugins.json`)) {
        const ids = added ? ['24851', '50000'] : ['24851'];
        return { status: 200, body: { plugins: ids.map((id) => ({ id: Number(id) })) } };
      }
      if (path === `/v1/developers/${DEV}/plugins/50000.json`) {
        return { status: 200, body: { id: 50000, public_key: 'pk_new', secret_key: 'sk_new' } };
      }
      return undefined;
    });

    await expect(getFreemiusProductKeys('50000')).resolves.toBeNull();
    added = true;
    vi.setSystemTime(new Date('2026-11-12T15:01:30Z'));
    await expect(getFreemiusProductKeys('50000')).resolves.toMatchObject({ publicKey: 'pk_new', secretKey: 'sk_new' });
  });

  it('never reads "not owned" from a stale list: a missing id throws unavailable while the re-read goes unanswered', async () => {
    // Review 2026-11-13, round 2: the list [24851] was kept through an unanswered re-read, so a
    // product added since read as another account's (null), and its genuine webhooks got 401.
    vi.useFakeTimers({ now: new Date('2026-11-13T12:00:00Z'), toFake: ['Date'] });
    let listed = ['24851'];
    let throttled = false;
    const { calls } = stubFreemiusApi((path) => {
      if (throttled) return { status: 429, body: { error: { code: 'rate_limit', message: 'Too many requests.' } } };
      if (path.startsWith(`/v1/developers/${DEV}/plugins.json`)) return { status: 200, body: { plugins: listed.map((id) => ({ id: Number(id) })) } };
      return undefined;
    });
    const listReads = () => calls.filter((call) => call.url.includes('/plugins.json?')).length;

    await expect(getFreemiusDeveloperStatus()).resolves.toMatchObject({ productIds: ['24851'] });
    // Inside the minute after an answered list, an id it lacks is not owned: null, no request.
    await expect(getFreemiusProductKeys('43273')).resolves.toBeNull();
    expect(listReads()).toBe(1);

    listed = ['24851', '43273'];
    throttled = true;
    vi.setSystemTime(new Date('2026-11-13T12:02:00Z'));

    await expect(getFreemiusProductKeys('43273')).rejects.toMatchObject({ kind: 'unavailable' });
    expect(listReads()).toBe(2);
    // Throttled right after the unanswered re-read: the same answer, and no request.
    await expect(getFreemiusProductKeys('43273')).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(getFreemiusProductKeys('99999')).rejects.toMatchObject({ kind: 'unavailable' });
    expect(listReads()).toBe(2);
    // An owned product is unaffected, and the pair still works.
    await expect(canUseFreemiusDeveloperScope('24851')).resolves.toBe(true);
    await expect(getFreemiusDeveloperStatus()).resolves.toMatchObject({ state: 'working' });

    // Freemius answers again: the new product is owned, and an id still missing is not.
    throttled = false;
    vi.setSystemTime(new Date('2026-11-13T12:02:31Z'));
    await expect(getFreemiusProductKeys('43273')).resolves.toMatchObject({ secretKey: PRODUCT_KEYS['43273'].secret_key });
    expect(developerPaths(calls).slice(-2)).toEqual(['/plugins.json?count=50&offset=0', '/plugins/43273.json']);
    await expect(getFreemiusProductKeys('99999')).resolves.toBeNull();
  });

  it('re-reads keys older than maxAgeMs (a rotated secret), at most once a minute', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-12T15:00:00Z'), toFake: ['Date'] });
    const { calls } = stubFreemiusApi();

    await getFreemiusProductKeys('24851');
    vi.setSystemTime(new Date('2026-11-12T15:00:30Z'));
    await getFreemiusProductKeys('24851', { maxAgeMs: 0 });
    expect(calls.filter((call) => call.url.endsWith('/plugins/24851.json'))).toHaveLength(1);

    vi.setSystemTime(new Date('2026-11-12T15:01:01Z'));
    await getFreemiusProductKeys('24851', { maxAgeMs: 0 });
    await getFreemiusProductKeys('24851', { maxAgeMs: 0 });
    expect(calls.filter((call) => call.url.endsWith('/plugins/24851.json'))).toHaveLength(2);
  });

  it('returns null for an id that is not a Freemius id, without a request', async () => {
    const { fetchMock } = stubFreemiusApi();

    await expect(getFreemiusProductKeys('24851/../1')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * Review 2026-11-13, round 3 (K2): a 2xx product read that was not the product (an HTML page, `{}`,
 * the keys without an id, another product) read as "no keys": it replaced the last keys Freemius
 * returned for a minute, so that product's genuine webhooks answered 503 and its checkout fell back
 * to bound keys. Like a 2xx without a product list at the pair's check, it is now no answer.
 */
describe('getFreemiusProductKeys when a 2xx is not the product', () => {
  const COMMERCE = PRODUCT_KEYS['24851'];
  const productReads = (calls: Call[]) => calls.filter((call) => call.url.endsWith('/plugins/24851.json')).length;

  /** The default fake Freemius, except that 24851's key read answers 200 `text` while `broken()` says so. */
  function stubBrokenProductRead(text: string, broken: () => boolean) {
    const stub = stubFreemiusApi();
    const answer = stub.fetchMock.getMockImplementation();
    stub.fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const call = { url: String(url), init: init ?? {} };
      if (broken() && String(url).endsWith(`/v1/developers/${DEV}/plugins/24851.json`)) {
        stub.calls.push(call);
        return new Response(text, { status: 200 });
      }
      if (!answer) throw new Error('no fake Freemius');
      return answer(url, init);
    });
    return stub;
  }

  const NOT_THE_PRODUCT = [
    ['an HTML page', '<html>maintenance</html>'],
    ['an empty body', ''],
    ['{}', '{}'],
    ['a list', JSON.stringify([{ id: 24851, ...COMMERCE }])],
    ['the keys without an id', JSON.stringify({ public_key: 'pk_unnamed', secret_key: 'sk_unnamed' })],
    ['an id that is not a Freemius id', JSON.stringify({ id: 'abc', public_key: 'pk_unnamed', secret_key: 'sk_unnamed' })],
    ['another product', JSON.stringify({ id: 28609, ...PRODUCT_KEYS['28609'] })],
  ] as const;

  it.each(NOT_THE_PRODUCT)('keeps the last keys through a re-read answered with %s, asked again after 30 s', async (_label, text) => {
    vi.useFakeTimers({ now: new Date('2026-11-13T12:00:00Z'), toFake: ['Date'] });
    let broken = false;
    const { calls } = stubBrokenProductRead(text, () => broken);

    await expect(getFreemiusProductKeys('24851')).resolves.toMatchObject({ secretKey: COMMERCE.secret_key });
    const firstFetchedAt = Date.parse('2026-11-13T12:00:00Z');

    // Past the keys' ten minutes the re-read gets a 200 that is not 24851: the last keys stay in use.
    broken = true;
    vi.setSystemTime(new Date('2026-11-13T12:10:01Z'));
    await expect(getFreemiusProductKeys('24851')).resolves.toMatchObject({ secretKey: COMMERCE.secret_key, fetchedAt: firstFetchedAt });
    // Never passed off as a fresh answer (a rotated secret), and remembered: no request for 30 s.
    await expect(getFreemiusProductKeys('24851', { maxAgeMs: 0 })).rejects.toMatchObject({ kind: 'unavailable' });
    vi.setSystemTime(new Date('2026-11-13T12:10:30Z'));
    await expect(getFreemiusProductKeys('24851')).resolves.toMatchObject({ secretKey: COMMERCE.secret_key });
    expect(productReads(calls)).toBe(2);

    // Freemius answers with the product again: its keys, fresh.
    broken = false;
    vi.setSystemTime(new Date('2026-11-13T12:10:32Z'));
    await expect(getFreemiusProductKeys('24851')).resolves.toMatchObject({
      secretKey: COMMERCE.secret_key,
      fetchedAt: Date.parse('2026-11-13T12:10:32Z'),
    });
    expect(productReads(calls)).toBe(3);
  });

  it.each(NOT_THE_PRODUCT)('throws unavailable, never "no keys", for a first read answered with %s', async (_label, text) => {
    vi.useFakeTimers({ now: new Date('2026-11-13T12:00:00Z'), toFake: ['Date'] });
    const { calls } = stubBrokenProductRead(text, () => true);

    await expect(getFreemiusProductKeys('24851')).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(getFreemiusProductKeys('24851')).rejects.toMatchObject({ kind: 'unavailable' });
    expect(productReads(calls)).toBe(1);
  });

  it('keeps the product without keys as Freemius’ answer: null, which replaces the last keys', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-13T12:00:00Z'), toFake: ['Date'] });
    let keysRemoved = false;
    const { calls } = stubBrokenProductRead(JSON.stringify({ id: 24851, title: 'Commerce Pro' }), () => keysRemoved);

    await expect(getFreemiusProductKeys('24851')).resolves.toMatchObject({ secretKey: COMMERCE.secret_key });
    keysRemoved = true;
    vi.setSystemTime(new Date('2026-11-13T12:10:01Z'));

    await expect(getFreemiusProductKeys('24851')).resolves.toBeNull();
    await expect(getFreemiusProductKeys('24851')).resolves.toBeNull();
    expect(productReads(calls)).toBe(2);
  });
});

/**
 * Review 2026-11-13: when the 10-minute verdict expired and its re-check hit one 429, 5xx or
 * timeout, the pair read as "not configured" for 30 s (product keys dropped, webhooks refused,
 * checkout sync answering not_configured, readiness false): nextblock.dev runs on the pair alone.
 */
describe('a working pair through a Freemius blip', () => {
  const AFFILIATES = PRODUCT_KEYS['43273'];

  it('keeps the pair and the product keys in use when the periodic re-check goes unanswered, and asks again 30 s later', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-13T12:00:00Z'), toFake: ['Date'] });
    let down = false;
    const { calls } = stubFreemiusApi(() => (down ? { status: 503, body: {} } : undefined));

    await expect(getFreemiusProductKeys('43273')).resolves.toMatchObject({ secretKey: AFFILIATES.secret_key });
    expect(calls).toHaveLength(2);

    // Ten minutes on, the verdict and the keys are due, and Freemius answers 503 to everything.
    vi.setSystemTime(new Date('2026-11-13T12:10:01Z'));
    down = true;

    await expect(getFreemiusDeveloperStatus()).resolves.toEqual({
      state: 'working',
      source: 'env',
      productIds: ['24851', '28609', '43273'],
    });
    await expect(getFreemiusProductKeys('43273')).resolves.toMatchObject({ publicKey: AFFILIATES.public_key, secretKey: AFFILIATES.secret_key });
    await expect(canUseFreemiusDeveloperScope('43273')).resolves.toBe(true);
    // Work at developer scope reports Freemius down (a retryable 502), never "not configured".
    await expect(freemiusDeveloperRequest({ path: '/plugins/43273/licenses/9.json' })).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(
      withFreemiusDeveloperScope('43273', () => freemiusDeveloperRequest({ path: '/plugins/43273/licenses/9.json' }))
    ).rejects.toMatchObject({ kind: 'unavailable' });
    expect(developerPaths(calls).slice(2)).toEqual([
      '/plugins.json?count=50&offset=0',
      '/plugins/43273.json',
      '/plugins/43273/licenses/9.json',
      '/plugins/43273/licenses/9.json',
    ]);

    // Freemius is back 5 s later: still working from memory, nothing asked again inside the window.
    down = false;
    vi.setSystemTime(new Date('2026-11-13T12:10:06Z'));
    await expect(getFreemiusDeveloperStatus()).resolves.toMatchObject({ state: 'working' });
    await expect(getFreemiusProductKeys('43273')).resolves.toMatchObject({ secretKey: AFFILIATES.secret_key });
    expect(calls).toHaveLength(6);

    // After the window the pair is checked again and the keys read again.
    vi.setSystemTime(new Date('2026-11-13T12:10:32Z'));
    await expect(getFreemiusProductKeys('43273')).resolves.toMatchObject({ secretKey: AFFILIATES.secret_key });
    expect(developerPaths(calls).slice(6)).toEqual(['/plugins.json?count=50&offset=0', '/plugins/43273.json']);
  });

  it('keeps a refused pair refused through an unanswered re-check, and a first check that goes unanswered reads unreachable', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-13T12:00:00Z'), toFake: ['Date'] });
    mocks.candidates.mockImplementation(async () => [LEGACY_PRODUCT_PAIR]);
    let down = false;
    const { calls } = stubFreemiusApi(() => (down ? { status: 503, body: {} } : undefined));

    await expect(getFreemiusDeveloperStatus()).resolves.toMatchObject({ state: 'refused' });
    vi.setSystemTime(new Date('2026-11-13T12:10:01Z'));
    down = true;
    await expect(getFreemiusDeveloperStatus()).resolves.toMatchObject({ state: 'refused' });
    expect(calls).toHaveLength(2);

    forgetFreemiusDeveloperCaches();
    mocks.candidates.mockImplementation(async () => [GOOD_PAIR]);
    await expect(getFreemiusDeveloperStatus()).resolves.toMatchObject({ state: 'unreachable' });
    await expect(getFreemiusProductKeys('43273')).resolves.toBeNull();
    expect(calls).toHaveLength(3);

    down = false;
    vi.setSystemTime(new Date('2026-11-13T12:10:32Z'));
    await expect(getFreemiusDeveloperStatus()).resolves.toMatchObject({ state: 'working' });
  });

  /**
   * Review 2026-11-13, round 3: a 404 on the first page of the list refused the pair (round 2, for
   * a wrong developer id) even when it was working minutes before, so one misrouted 404 at the
   * 10-minute re-check took every Freemius flow offline for ten minutes.
   */
  const notFound = { status: 404, body: { error: { code: 'not_found', message: 'Not found.' } } };

  it('keeps a working pair through one 404 on the first page at its re-check, and asks again 30 s later', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-13T12:00:00Z'), toFake: ['Date'] });
    let listAnswer: Answer | undefined;
    const { calls } = stubFreemiusApi((path) => (path.startsWith(`/v1/developers/${DEV}/plugins.json`) ? listAnswer : undefined));
    const listReads = () => calls.filter((call) => call.url.includes('/plugins.json?')).length;

    await expect(getFreemiusProductKeys('43273')).resolves.toMatchObject({ secretKey: AFFILIATES.secret_key });

    // The verdict is due; that one list request answers 404, then Freemius is fine again.
    vi.setSystemTime(new Date('2026-11-13T12:10:01Z'));
    listAnswer = notFound;
    await expect(getFreemiusDeveloperStatus()).resolves.toEqual({ state: 'working', source: 'env', productIds: ['24851', '28609', '43273'] });
    listAnswer = undefined;
    expect(listReads()).toBe(2);

    // Five seconds on: still working from memory, an owned product's keys still read, nothing asked.
    vi.setSystemTime(new Date('2026-11-13T12:10:06Z'));
    await expect(getFreemiusDeveloperStatus({ wait: false })).resolves.toMatchObject({ state: 'working' });
    await expect(getFreemiusProductKeys('43273')).resolves.toMatchObject({ secretKey: AFFILIATES.secret_key });
    await expect(canUseFreemiusDeveloperScope('28609')).resolves.toBe(true);
    // The list request went unanswered, so an id it lacks is not known to be another account's.
    await expect(getFreemiusProductKeys('99999')).rejects.toMatchObject({ kind: 'unavailable' });
    expect(listReads()).toBe(2);

    // Thirty seconds after the 404 the pair is checked again; answered, the 404 is forgotten.
    vi.setSystemTime(new Date('2026-11-13T12:10:32Z'));
    await expect(getFreemiusDeveloperStatus()).resolves.toMatchObject({ state: 'working' });
    expect(listReads()).toBe(3);
    await expect(getFreemiusProductKeys('99999')).resolves.toBeNull();

    // A later single 404 (ten minutes on) is again only one.
    vi.setSystemTime(new Date('2026-11-13T12:20:33Z'));
    listAnswer = notFound;
    await expect(getFreemiusDeveloperStatus()).resolves.toMatchObject({ state: 'working' });
  });

  it('refuses a working pair at a second 404 in a row, at least 30 s after the first', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-13T12:00:00Z'), toFake: ['Date'] });
    let listAnswer: Answer | undefined;
    stubFreemiusApi((path) => (path.startsWith(`/v1/developers/${DEV}/plugins.json`) ? listAnswer : undefined));

    await getFreemiusDeveloperStatus();
    vi.setSystemTime(new Date('2026-11-13T12:10:01Z'));
    listAnswer = notFound;
    await expect(getFreemiusDeveloperStatus()).resolves.toMatchObject({ state: 'working' });

    // An unanswered check between the two 404s is no answer: the run of 404s goes on.
    vi.setSystemTime(new Date('2026-11-13T12:10:32Z'));
    listAnswer = { status: 429, body: {} };
    await expect(getFreemiusDeveloperStatus()).resolves.toMatchObject({ state: 'working' });

    vi.setSystemTime(new Date('2026-11-13T12:11:03Z'));
    listAnswer = notFound;
    await expect(getFreemiusDeveloperStatus()).resolves.toEqual({ state: 'refused', source: null, productIds: [] });
    await expect(getFreemiusProductKeys('43273')).resolves.toBeNull();
    // A refusal holds for the usual ten minutes.
    await expect(getFreemiusDeveloperStatus({ wait: false })).resolves.toMatchObject({ state: 'refused' });
  });

  it('checks a changed developer id afresh: its fingerprint is new, so its first 404 refuses it', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-13T12:00:00Z'), toFake: ['Date'] });
    stubFreemiusApi((path) => (path.startsWith('/v1/developers/9999/plugins.json') ? notFound : undefined));

    await expect(getFreemiusDeveloperStatus()).resolves.toMatchObject({ state: 'working' });
    mocks.candidates.mockImplementation(async () => [{ ...GOOD_PAIR, developerId: '9999' }]);
    await expect(getFreemiusDeveloperStatus()).resolves.toEqual({ state: 'refused', source: null, productIds: [] });
  });

  /**
   * Review 2026-11-13, round 3: a 2xx without a product list was read as an empty list, so a
   * working pair "owned" nothing for ten minutes: genuine webhooks of owned products got 401.
   */
  it.each([
    ['an HTML page', '<html>maintenance</html>'],
    ['an empty body', ''],
    ['{}', '{}'],
    ['{ "plugins": null }', '{"plugins":null}'],
  ])('reads a 200 with %s on the product list as no answer: a working pair keeps its list', async (_label, text) => {
    vi.useFakeTimers({ now: new Date('2026-11-13T12:00:00Z'), toFake: ['Date'] });
    let broken = true;
    const { fetchMock } = stubFreemiusApi();
    const answer = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (broken && String(url).includes(`/v1/developers/${DEV}/plugins.json`)) return new Response(text, { status: 200 });
      if (!answer) throw new Error('no fake Freemius');
      return answer(url, init);
    });

    // A first check answered that way says nothing: unreachable, never a working pair that owns nothing.
    await expect(getFreemiusDeveloperStatus()).resolves.toEqual({ state: 'unreachable', source: null, productIds: [] });

    // Once the pair works, a re-check answered that way keeps the list and the product keys.
    broken = false;
    vi.setSystemTime(new Date('2026-11-13T12:00:31Z'));
    await expect(getFreemiusDeveloperStatus()).resolves.toMatchObject({ state: 'working', productIds: ['24851', '28609', '43273'] });
    broken = true;
    vi.setSystemTime(new Date('2026-11-13T12:10:32Z'));
    await expect(getFreemiusDeveloperStatus()).resolves.toEqual({ state: 'working', source: 'env', productIds: ['24851', '28609', '43273'] });
    await expect(getFreemiusProductKeys('28609')).resolves.toMatchObject({ secretKey: PRODUCT_KEYS['28609'].secret_key });
    await expect(canUseFreemiusDeveloperScope('24851')).resolves.toBe(true);
  });
});

/**
 * Review 2026-11-13: an unanswered read was never remembered, so once Freemius throttled the key
 * every forged webhook (random signature, any plugin_id) sent one more signed request.
 * The webhook route reads the product's keys and, on a signature mismatch with keys older than a
 * minute, reads them again with maxAgeMs: 0 (freemius-order-sync.ts, verifyFreemiusWebhookRequest).
 */
describe('forged requests while Freemius throttles the key', () => {
  const COMMERCE = PRODUCT_KEYS['24851'];
  const tooMany = { status: 429, body: { error: { code: 'rate_limit', message: 'Too many requests.' } } };

  /** What one forged webhook naming `productId` makes this module do. */
  async function forgedWebhook(productId: string) {
    const keys = await getFreemiusProductKeys(productId).catch(() => null);

    if (keys && Date.now() - keys.fetchedAt >= 60_000) {
      await getFreemiusProductKeys(productId, { maxAgeMs: 0 }).catch(() => null);
    }

    return keys;
  }

  it('sends at most one product read a window, and keeps serving the keys it has', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-13T12:00:00Z'), toFake: ['Date'] });
    let throttled = false;
    const { calls } = stubFreemiusApi(() => (throttled ? tooMany : undefined));
    const productReads = () => calls.filter((call) => call.url.endsWith('/plugins/24851.json')).length;

    await forgedWebhook('24851');
    expect(productReads()).toBe(1);

    vi.setSystemTime(new Date('2026-11-13T12:02:00Z'));
    throttled = true;
    for (let i = 0; i < 25; i += 1) {
      await expect(forgedWebhook('24851')).resolves.toMatchObject({ secretKey: COMMERCE.secret_key });
    }
    expect(productReads()).toBe(2);

    vi.setSystemTime(new Date('2026-11-13T12:02:40Z'));
    for (let i = 0; i < 25; i += 1) await forgedWebhook('24851');
    expect(productReads()).toBe(2);

    vi.setSystemTime(new Date('2026-11-13T12:03:01Z'));
    for (let i = 0; i < 25; i += 1) await forgedWebhook('24851');
    expect(productReads()).toBe(3);
    // The pair itself was never re-checked: its verdict is still fresh.
    expect(calls.filter((call) => call.url.includes('/plugins.json?'))).toHaveLength(1);
  });

  it('never passes old keys off as a fresh re-read: an unanswered maxAgeMs read throws, plain reads keep the keys', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-13T12:00:00Z'), toFake: ['Date'] });
    let throttled = false;
    const { calls } = stubFreemiusApi(() => (throttled ? tooMany : undefined));
    const productReads = () => calls.filter((call) => call.url.endsWith('/plugins/24851.json')).length;

    await getFreemiusProductKeys('24851');
    vi.setSystemTime(new Date('2026-11-13T12:02:00Z'));
    throttled = true;

    // The webhook route then answers 503 (Freemius redelivers) instead of 401 for a rotated secret.
    await expect(getFreemiusProductKeys('24851', { maxAgeMs: 0 })).rejects.toMatchObject({ kind: 'unavailable', status: 429 });
    await expect(getFreemiusProductKeys('24851')).resolves.toMatchObject({ secretKey: COMMERCE.secret_key });
    vi.setSystemTime(new Date('2026-11-13T12:02:45Z'));
    await expect(getFreemiusProductKeys('24851', { maxAgeMs: 0 })).rejects.toMatchObject({ kind: 'unavailable' });
    expect(productReads()).toBe(2);

    // Past the keys' ten minutes, a plain caller and a maxAgeMs caller share one unanswered read,
    // and each applies its own rule to it.
    vi.setSystemTime(new Date('2026-11-13T12:10:30Z'));
    const [plain, fresher] = await Promise.allSettled([
      getFreemiusProductKeys('24851'),
      getFreemiusProductKeys('24851', { maxAgeMs: 0 }),
    ]);
    expect(plain).toMatchObject({ status: 'fulfilled', value: { secretKey: COMMERCE.secret_key } });
    expect(fresher).toMatchObject({ status: 'rejected', reason: { kind: 'unavailable' } });
    expect(productReads()).toBe(3);
  });

  it('remembers an unanswered first read: the same failure, no request, until the window ends', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-13T12:00:00Z'), toFake: ['Date'] });
    const { calls } = stubFreemiusApi((path) => (path.endsWith('/plugins/24851.json') ? tooMany : undefined));
    const productReads = () => calls.filter((call) => call.url.endsWith('/plugins/24851.json')).length;

    for (let i = 0; i < 25; i += 1) {
      await expect(getFreemiusProductKeys('24851')).rejects.toMatchObject({ kind: 'unavailable', status: 429 });
    }
    expect(productReads()).toBe(1);

    vi.setSystemTime(new Date('2026-11-13T12:00:31Z'));
    await expect(getFreemiusProductKeys('24851')).rejects.toMatchObject({ kind: 'unavailable' });
    expect(productReads()).toBe(2);
  });

  it('shares one read between concurrent requests', async () => {
    const { calls } = stubFreemiusApi((path) => (path.endsWith('/plugins/24851.json') ? tooMany : undefined));
    await getFreemiusDeveloperStatus();

    const results = await Promise.allSettled(Array.from({ length: 25 }, () => getFreemiusProductKeys('24851')));

    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(calls.filter((call) => call.url.endsWith('/plugins/24851.json'))).toHaveLength(1);
  });

  it('re-reads the product list for a product the account does not own at most once a window, answered or not', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-13T12:00:00Z'), toFake: ['Date'] });
    let throttled = false;
    const { calls } = stubFreemiusApi(() => (throttled ? tooMany : undefined));
    const listReads = () => calls.filter((call) => call.url.includes('/plugins.json?')).length;

    await getFreemiusDeveloperStatus();
    vi.setSystemTime(new Date('2026-11-13T12:02:00Z'));
    throttled = true;

    for (let i = 0; i < 25; i += 1) {
      await expect(forgedWebhook('99999')).resolves.toBeNull();
    }
    expect(listReads()).toBe(2);

    // The unanswered re-read keeps the verdict, re-checked once the short window is over.
    vi.setSystemTime(new Date('2026-11-13T12:02:31Z'));
    for (let i = 0; i < 25; i += 1) await forgedWebhook('99999');
    expect(listReads()).toBe(3);
    await expect(getFreemiusDeveloperStatus()).resolves.toMatchObject({ state: 'working' });
    expect(calls.some((call) => call.url.endsWith('/plugins/99999.json'))).toBe(false);
  });
});

/**
 * Review 2026-11-13: store readiness (buy buttons, product pages, the checkout preflight) awaited
 * this check during public renders, up to 8 s per page on a cold start or while Freemius hung.
 */
describe('getFreemiusDeveloperStatus({ wait: false }), for store readiness', () => {
  it('answers at once for a pair never checked, and checks it after the response', async () => {
    const { fetchMock, open } = stubGatedFreemiusApi();

    await expect(withinMs(getFreemiusDeveloperStatus({ wait: false }))).resolves.toEqual({ state: 'unchecked', source: null, productIds: [] });
    await expect(withinMs(getFreemiusDeveloperStatus({ wait: false }))).resolves.toMatchObject({ state: 'unchecked' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.after).toHaveBeenCalled();

    open();
    await runAfterTasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(getFreemiusDeveloperStatus({ wait: false })).resolves.toEqual({
      state: 'working',
      source: 'env',
      productIds: ['24851', '28609', '43273'],
    });
    expect(mocks.afterTasks).toHaveLength(0);
  });

  it('starts the check at once, without waiting for it, where Next cannot schedule work after the response', async () => {
    mocks.after.mockImplementation(() => {
      throw new Error('`after` was called outside a request scope.');
    });
    const { fetchMock, open } = stubGatedFreemiusApi();

    await expect(withinMs(getFreemiusDeveloperStatus({ wait: false }))).resolves.toMatchObject({ state: 'unchecked' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    open();
    await expect(getFreemiusDeveloperStatus()).resolves.toMatchObject({ state: 'working' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads a refusal from memory and asks nothing before its re-check is due', async () => {
    mocks.candidates.mockImplementation(async () => [LEGACY_PRODUCT_PAIR]);
    const { fetchMock } = stubFreemiusApi();

    await getFreemiusDeveloperStatus();
    await expect(getFreemiusDeveloperStatus({ wait: false })).resolves.toEqual({ state: 'refused', source: null, productIds: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it('keeps an expired working verdict while it re-checks the pair in the background', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-13T12:00:00Z'), toFake: ['Date'] });
    const { calls } = stubFreemiusApi();

    await getFreemiusDeveloperStatus();
    vi.setSystemTime(new Date('2026-11-13T12:10:01Z'));

    await expect(getFreemiusDeveloperStatus({ wait: false })).resolves.toMatchObject({ state: 'working' });
    expect(calls).toHaveLength(1);
    await runAfterTasks();
    expect(developerPaths(calls)).toEqual(['/plugins.json?count=50&offset=0', '/plugins.json?count=50&offset=0']);
  });
});

describe('on the public sandbox', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
  });

  it('freemiusDeveloperRequest refuses before resolving a key or sending anything', async () => {
    const { fetchMock } = stubFreemiusApi();
    // Sync from Freemius refuses on the sandbox too (pages/cms/products/actions.ts): only the reset
    // reads the catalog there, and the refusal says so.
    expect(FREEMIUS_DEVELOPER_SANDBOX_MESSAGE).toBe(
      "The Freemius developer key isn't used in the sandbox, apart from the demo's own 15-minute catalog reset."
    );

    await expect(freemiusDeveloperRequest({ method: 'POST', path: '/plugins/24851/coupons.json', body: { code: 'FREE100' } })).rejects.toMatchObject({
      kind: 'sandbox',
      message: FREEMIUS_DEVELOPER_SANDBOX_MESSAGE,
    });
    await expect(freemiusDeveloperRequest({ path: '/plugins/24851/licenses/9.json' })).rejects.toMatchObject({ kind: 'sandbox' });
    expect(mocks.candidates).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getFreemiusProductKeys, canUseFreemiusDeveloperScope and withFreemiusDeveloperScope read nothing', async () => {
    const { fetchMock } = stubFreemiusApi();
    const work = vi.fn(async () => 'done');

    await expect(getFreemiusProductKeys('24851')).resolves.toBeNull();
    await expect(canUseFreemiusDeveloperScope('24851')).resolves.toBe(false);
    await expect(withFreemiusDeveloperScope('24851', work)).resolves.toEqual({ handled: false });
    expect(work).not.toHaveBeenCalled();
    expect(mocks.candidates).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getFreemiusDeveloperStatus checks nothing, in the background either', async () => {
    const { fetchMock } = stubFreemiusApi();

    await expect(getFreemiusDeveloperStatus()).resolves.toEqual({ state: 'sandbox', source: null, productIds: [] });
    await expect(getFreemiusDeveloperStatus({ wait: false })).resolves.toEqual({ state: 'sandbox', source: null, productIds: [] });
    expect(mocks.candidates).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('confirmFreemiusOneProductKeys sends nothing there (the key policy lets the one-product keys stand in offline)', async () => {
    const { fetchMock } = stubFreemiusApi();

    await expect(confirmFreemiusOneProductKeys('28609', { publicKey: 'pk_one_product', secretKey: 'sk_one_product' })).resolves.toBe('unknown');
    expect(mocks.candidates).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('describeFreemiusDeveloperPairs resolves no key there', async () => {
    const { fetchMock } = stubFreemiusApi();

    await expect(describeFreemiusDeveloperPairs({ publicKey: GOOD_PAIR.publicKey, secretKey: GOOD_PAIR.secretKey })).resolves.toEqual({
      sources: [],
      sharesDedicatedKey: false,
      sharesWorkingLegacyKey: false,
      sharesVerifiedKey: false,
    });
    expect(mocks.candidates).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the catalog reader the demo’s reset syncs with: GET, products, plans and pricing only', async () => {
    const { calls } = stubFreemiusApi((path) => (path.includes('/plans') ? { status: 200, body: { plans: [] } } : undefined));

    const catalog = await openFreemiusCatalogReader();
    await expect(catalog.read('/plugins.json')).resolves.toMatchObject({ plugins: expect.any(Array) });
    await catalog.read('/plugins/24851.json');
    await catalog.read('/plugins/24851/plans.json');
    await catalog.read('/plugins/24851/plans/40001.json');
    await catalog.read('/plugins/24851/plans/40001/pricing.json');

    for (const path of ['/plugins/24851/licenses.json', '/plugins/24851/users/1.json', '/plugins/24851/coupons.json', '/plugins/24851/events.json', '/plugins/../x.json']) {
      await expect(catalog.read(path), path).rejects.toMatchObject({ kind: 'rejected' });
    }

    expect(calls.every((call) => call.init.method === 'GET')).toBe(true);
    expect(calls.map((call) => call.url.replace(`https://api.freemius.com/v1/developers/${DEV}`, ''))).toEqual([
      '/plugins.json', // opened with it, and the first read is served from it
      '/plugins/24851.json',
      '/plugins/24851/plans.json',
      '/plugins/24851/plans/40001.json',
      '/plugins/24851/plans/40001/pricing.json',
    ]);
  });
});

describe('openFreemiusCatalogReader off the sandbox', () => {
  it('opens with the first pair Freemius accepts (the legacy names keep Sync working)', async () => {
    mocks.candidates.mockImplementation(async () => [LEGACY_PRODUCT_PAIR, GOOD_PAIR]);
    stubFreemiusApi();

    const catalog = await openFreemiusCatalogReader();

    expect(catalog.developerId).toBe(DEV);
    await expect(catalog.read('/plugins/24851.json')).resolves.toMatchObject({ id: 24851 });
  });

  it('says what is missing without a pair, and passes on a refusal', async () => {
    mocks.candidates.mockImplementation(async () => []);
    await expect(openFreemiusCatalogReader()).rejects.toMatchObject({ kind: 'not_configured' });

    mocks.candidates.mockImplementation(async () => [LEGACY_PRODUCT_PAIR]);
    stubFreemiusApi();
    await expect(openFreemiusCatalogReader()).rejects.toMatchObject({ kind: 'auth', status: 401 });
  });

  it.each([
    ['a 404 (no such developer for these keys)', 404],
    ['another 4xx', 400],
  ])('moves on to the next pair after %s on the first product list, as the developer check reads it', async (_label, status) => {
    // Review 2026-11-13, round 3: only a 401/403 moved on, so on nextblock.dev's order (the CMS
    // one-product fields first, then the developer pair) a 404 to the first stopped Sync there.
    mocks.candidates.mockImplementation(async () => [LEGACY_PRODUCT_PAIR, GOOD_PAIR]);
    const { calls } = stubFreemiusApi((path, call) =>
      authorizationPublicKey(call) === LEGACY_PRODUCT_PAIR.publicKey ? { status, body: { error: { code: 'x', message: 'No.' } } } : undefined
    );

    const catalog = await openFreemiusCatalogReader();

    await expect(catalog.read('/plugins/24851.json')).resolves.toMatchObject({ id: 24851 });
    expect(calls.map((call) => authorizationPublicKey(call))).toEqual([
      LEGACY_PRODUCT_PAIR.publicKey,
      GOOD_PAIR.publicKey,
      GOOD_PAIR.publicKey,
    ]);
  });

  it('still stops when Freemius fails to answer the first product list', async () => {
    mocks.candidates.mockImplementation(async () => [LEGACY_PRODUCT_PAIR, GOOD_PAIR]);
    const { calls } = stubFreemiusApi(() => ({ status: 503, body: {} }));

    await expect(openFreemiusCatalogReader()).rejects.toMatchObject({ kind: 'unavailable', status: 503 });
    expect(calls).toHaveLength(1);
  });

  /**
   * Review 2026-11-13, round 3 (K3): a 2xx first page that was not a product list opened the reader
   * as an empty catalog, so Sync from Freemius reported 0 products and dropped every cached verdict
   * and key (forgetFreemiusDeveloperCaches). It is no answer now, as the pair's check reads it.
   */
  it.each([
    ['an HTML page', '<html>maintenance</html>'],
    ['an empty body', ''],
    ['{}', '{}'],
    ['{ "plugins": null }', '{"plugins":null}'],
    ['a bare list', '[{"id":24851}]'],
    ['an error body', '{"error":{"code":"unknown","message":"Something went wrong.","http":402}}'],
  ])('stops with unavailable when the first product list is a 2xx with %s, trying no further pair', async (_label, text) => {
    mocks.candidates.mockImplementation(async () => [GOOD_PAIR, LEGACY_PRODUCT_PAIR]);
    const { calls, fetchMock } = stubFreemiusApi();
    fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return new Response(text, { status: 200 });
    });

    await expect(openFreemiusCatalogReader()).rejects.toMatchObject({ kind: 'unavailable' });
    expect(calls).toHaveLength(1);
  });

  it('opens on an empty product list, which is an answer (an account without products)', async () => {
    const { calls } = stubFreemiusApi((path) => (path.startsWith(`/v1/developers/${DEV}/plugins.json`) ? { status: 200, body: { plugins: [] } } : undefined));

    const catalog = await openFreemiusCatalogReader();

    await expect(catalog.read('/plugins.json')).resolves.toEqual({ plugins: [] });
    expect(calls).toHaveLength(1);
  });
});

/**
 * Review 2026-11-13, round 3: when every configured developer pair is the one-product names and
 * Freemius refuses it, those names hold either a one-product install's keys (it also filled in its
 * developer id) or a revoked developer pair left there (nextblock.dev keeps its pair there), whose
 * secret then verified every product's webhooks. The key policy now asks Freemius, at the product's
 * own scope, whether they are that product's keys.
 */
describe('confirmFreemiusOneProductKeys', () => {
  const ONE_PRODUCT = { publicKey: 'pk_one_product_28609', secretKey: 'sk_one_product_28609' };
  const productScopeUrl = (id: string) => `https://api.freemius.com/v1/plugins/${id}.json`;

  /** api.freemius.com at product scope: `answer(productId)` decides; the developer endpoints as usual. */
  function stubProductScope(answer: (productId: string, call: Call) => Answer) {
    return stubFreemiusApi((path, call) => {
      const product = path.match(/^\/v1\/plugins\/(\d+)\.json$/);
      return product ? answer(product[1], call) : undefined;
    });
  }

  it('confirms the keys for their own product with one GET signed at that product’s scope, then answers from memory', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-13T12:00:00Z'), toFake: ['Date'] });
    const { calls } = stubProductScope((id, call) =>
      id === '28609' && authorizationPublicKey(call) === ONE_PRODUCT.publicKey
        ? { status: 200, body: { id: 28609, public_key: ONE_PRODUCT.publicKey, secret_key: ONE_PRODUCT.secretKey } }
        : { status: 401, body: { error: { code: 'unauthorized' } } }
    );

    await expect(confirmFreemiusOneProductKeys('28609', ONE_PRODUCT)).resolves.toBe('confirmed');
    await expect(confirmFreemiusOneProductKeys(28609, ONE_PRODUCT)).resolves.toBe('confirmed');

    const call = lastCall(calls);
    expect(calls).toHaveLength(1);
    expect(call.url).toBe(productScopeUrl('28609'));
    expect(call.init.method).toBe('GET');
    expect(call.init.redirect).toBe('error');
    const headers = call.init.headers as Record<string, string>;
    // Signed like the PHP SDK's Freemius_Api('plugin', 28609, public, secret).
    expect(headers['Authorization']).toBe(
      signFreemiusRequest({
        date: headers['Date'],
        method: 'GET',
        path: '/v1/plugins/28609.json',
        publicKey: ONE_PRODUCT.publicKey,
        scopeId: '28609',
        secretKey: ONE_PRODUCT.secretKey,
      }).authorization
    );
    expect(headers['Authorization'].startsWith(`FS 28609:${ONE_PRODUCT.publicKey}:`)).toBe(true);
    expect(JSON.stringify(call.init)).not.toContain(ONE_PRODUCT.secretKey);

    // Kept ten minutes, then asked again.
    vi.setSystemTime(new Date('2026-11-13T12:09:59Z'));
    await expect(confirmFreemiusOneProductKeys('28609', ONE_PRODUCT)).resolves.toBe('confirmed');
    expect(calls).toHaveLength(1);
    vi.setSystemTime(new Date('2026-11-13T12:10:01Z'));
    await expect(confirmFreemiusOneProductKeys('28609', ONE_PRODUCT)).resolves.toBe('confirmed');
    expect(calls).toHaveLength(2);
  });

  it.each([
    ['401', { status: 401, body: { error: { code: 'unauthorized' } } }],
    ['403', { status: 403, body: {} }],
    ['404', { status: 404, body: {} }],
    ['a 200 for another product', { status: 200, body: { id: 24851, public_key: ONE_PRODUCT.publicKey } }],
    ['a 200 with another public key', { status: 200, body: { id: 28609, public_key: 'pk_someone_else' } }],
  ])('refuses on %s, and keeps the refusal ten minutes', async (_label, answer) => {
    vi.useFakeTimers({ now: new Date('2026-11-13T12:00:00Z'), toFake: ['Date'] });
    const { calls } = stubProductScope(() => answer);

    await expect(confirmFreemiusOneProductKeys('28609', ONE_PRODUCT)).resolves.toBe('refused');
    vi.setSystemTime(new Date('2026-11-13T12:09:59Z'));
    await expect(confirmFreemiusOneProductKeys('28609', ONE_PRODUCT)).resolves.toBe('refused');
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['429', { status: 429, body: {} }],
    ['a 5xx', { status: 502, body: {} }],
    ['a 200 that is not the product', { status: 200 }],
  ])('answers unknown on %s, remembered 30 s and never kept as an answer', async (_label, answer) => {
    vi.useFakeTimers({ now: new Date('2026-11-13T12:00:00Z'), toFake: ['Date'] });
    let current: Answer = answer;
    const { calls } = stubProductScope(() => current);

    await expect(confirmFreemiusOneProductKeys('28609', ONE_PRODUCT)).resolves.toBe('unknown');
    vi.setSystemTime(new Date('2026-11-13T12:00:29Z'));
    await expect(confirmFreemiusOneProductKeys('28609', ONE_PRODUCT)).resolves.toBe('unknown');
    expect(calls).toHaveLength(1);

    current = { status: 200, body: { id: 28609 } };
    vi.setSystemTime(new Date('2026-11-13T12:00:31Z'));
    await expect(confirmFreemiusOneProductKeys('28609', ONE_PRODUCT)).resolves.toBe('confirmed');
    expect(calls).toHaveLength(2);
  });

  it('answers unknown when Freemius cannot be reached', async () => {
    const { fetchMock } = stubProductScope(() => ({ status: 200, body: { id: 28609 } }));
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(confirmFreemiusOneProductKeys('28609', ONE_PRODUCT)).resolves.toBe('unknown');
  });

  /**
   * Review 2026-11-13, round 3 (K1, both reviewers): any 2xx object that named no other product or
   * public key confirmed, so a revoked developer pair left under the one-product names (its
   * developer scope answering 401) was confirmed for every product by a product-scope 200 `{}`:
   * checkout opened with its public key and its secret verified any product's webhooks. Only the
   * product itself confirms now, and the PHP SDK's rule holds: a body with an `error` member is an
   * error, whatever the HTTP status.
   */
  it.each([
    ['{}', {}],
    ['{ "id": null }', { id: null }],
    ['{ "plugins": [] }', { plugins: [] }],
    ['an id that is not a Freemius id', { id: 'abc' }],
    ['these keys’ public key and no id', { public_key: ONE_PRODUCT.publicKey }],
    ['the product with a public_key that is not a key', { id: 28609, public_key: null }],
    ['an error without a status', { error: { type: 'Unknown', code: 'unknown', message: 'Something went wrong.' } }],
    ['an error stating 429', { error: { type: 'RateLimit', code: 'rate_limit', message: 'Too many requests.', http: 429 } }],
    ['an error stating 500 beside the product', { id: 28609, public_key: ONE_PRODUCT.publicKey, error: { http: 500 } }],
    ['a list', [{ id: 28609, public_key: ONE_PRODUCT.publicKey }]],
    ['a string', 'ok'],
    ['JSON null', null],
  ])('answers unknown on a 200 with %s: nothing but the product itself confirms the keys', async (_label, body) => {
    vi.useFakeTimers({ now: new Date('2026-11-13T12:00:00Z'), toFake: ['Date'] });
    const { calls } = stubProductScope(() => ({ status: 200, body }));

    await expect(confirmFreemiusOneProductKeys('28609', ONE_PRODUCT)).resolves.toBe('unknown');
    // No answer: asked again only after 30 s, and never kept as one.
    vi.setSystemTime(new Date('2026-11-13T12:00:29Z'));
    await expect(confirmFreemiusOneProductKeys('28609', ONE_PRODUCT)).resolves.toBe('unknown');
    expect(calls).toHaveLength(1);
    vi.setSystemTime(new Date('2026-11-13T12:00:31Z'));
    await expect(confirmFreemiusOneProductKeys('28609', ONE_PRODUCT)).resolves.toBe('unknown');
    expect(calls).toHaveLength(2);
  });

  it.each([
    ['an error stating 401 (error.http)', { error: { type: 'UnauthorizedAccess', code: 'unauthorized_access', message: 'Invalid signature.', http: 401 } }],
    ['an error stating 403 (error.http as text)', { error: { code: 'forbidden', http: '403' } }],
    ['an error stating 404 (a numeric error.code)', { error: { code: 404, message: 'Not found.' } }],
    ['an error stating 401 beside the product', { id: 28609, public_key: ONE_PRODUCT.publicKey, error: { http: 401 } }],
    ['another public key and no id', { public_key: 'pk_someone_else' }],
  ])('refuses on a 200 with %s, and keeps the refusal ten minutes', async (_label, body) => {
    vi.useFakeTimers({ now: new Date('2026-11-13T12:00:00Z'), toFake: ['Date'] });
    const { calls } = stubProductScope(() => ({ status: 200, body }));

    await expect(confirmFreemiusOneProductKeys('28609', ONE_PRODUCT)).resolves.toBe('refused');
    vi.setSystemTime(new Date('2026-11-13T12:09:59Z'));
    await expect(confirmFreemiusOneProductKeys('28609', ONE_PRODUCT)).resolves.toBe('refused');
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['{ id }', { id: 28609 }],
    ['{ id, public_key } with the signing public key', { id: 28609, public_key: ONE_PRODUCT.publicKey }],
    ['the product with its id as text and more fields', { id: '28609', public_key: ONE_PRODUCT.publicKey, title: 'Cortex AI', secret_key: ONE_PRODUCT.secretKey }],
  ])('confirms on a 200 that is the product: %s', async (_label, body) => {
    const { calls } = stubProductScope(() => ({ status: 200, body }));

    await expect(confirmFreemiusOneProductKeys('28609', ONE_PRODUCT)).resolves.toBe('confirmed');
    expect(calls).toHaveLength(1);
  });

  it('keeps a confirmation through unanswered re-checks for at most the webhook secret limit (TTL + 1 h)', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-13T12:00:00Z'), toFake: ['Date'] });
    let down = false;
    stubProductScope(() => (down ? { status: 503, body: {} } : { status: 200, body: { id: 28609 } }));
    const at = (minutes: number) => vi.setSystemTime(new Date(Date.parse('2026-11-13T12:00:00Z') + minutes * 60_000));

    await expect(confirmFreemiusOneProductKeys('28609', ONE_PRODUCT)).resolves.toBe('confirmed');
    down = true;
    at(11);
    await expect(confirmFreemiusOneProductKeys('28609', ONE_PRODUCT)).resolves.toBe('confirmed');
    at(69);
    await expect(confirmFreemiusOneProductKeys('28609', ONE_PRODUCT)).resolves.toBe('confirmed');
    at(71);
    await expect(confirmFreemiusOneProductKeys('28609', ONE_PRODUCT)).resolves.toBe('unknown');
    // Freemius answers again (past the 30 s retry window): confirmed again.
    down = false;
    at(72);
    await expect(confirmFreemiusOneProductKeys('28609', ONE_PRODUCT)).resolves.toBe('confirmed');
  });

  it('sends at most ten requests a minute for product ids the keys do not belong to (they come from signed webhooks), and keeps its memory bounded', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-13T12:00:00Z'), toFake: ['Date'] });
    const { calls } = stubProductScope((id) => (id === '28609' ? { status: 200, body: { id: 28609 } } : { status: 401, body: {} }));

    await expect(confirmFreemiusOneProductKeys('28609', ONE_PRODUCT)).resolves.toBe('confirmed');
    const answers = [];
    for (let i = 0; i < 20; i += 1) {
      answers.push(await confirmFreemiusOneProductKeys(String(500000 + i), ONE_PRODUCT));
    }
    expect(calls).toHaveLength(10);
    expect(answers.slice(0, 9)).toEqual(Array(9).fill('refused'));
    expect(answers.slice(9)).toEqual(Array(11).fill('unknown'));

    // A minute later, ten more; hundreds of ids over time never push out the product's own answer.
    for (let minute = 1; minute <= 12; minute += 1) {
      vi.setSystemTime(new Date(Date.parse('2026-11-13T12:00:00Z') + minute * 61_000));
      for (let i = 0; i < 15; i += 1) await confirmFreemiusOneProductKeys(String(600000 + minute * 100 + i), ONE_PRODUCT);
    }
    expect(calls.length).toBe(10 + 12 * 10);
    // Its re-check, due after ten minutes, goes out despite the flood, and Freemius confirms it again.
    await expect(confirmFreemiusOneProductKeys('28609', ONE_PRODUCT)).resolves.toBe('confirmed');
    expect(calls.filter((call) => call.url === productScopeUrl('28609'))).toHaveLength(2);
  });

  it('shares one request between concurrent calls', async () => {
    const { calls } = stubProductScope(() => ({ status: 200, body: { id: 28609 } }));

    const answers = await Promise.all(Array.from({ length: 10 }, () => confirmFreemiusOneProductKeys('28609', ONE_PRODUCT)));

    expect(answers).toEqual(Array(10).fill('confirmed'));
    expect(calls).toHaveLength(1);
  });

  it('sends nothing for keys or an id it cannot send, and answers per (product, keys)', async () => {
    const { calls } = stubProductScope((id, call) =>
      authorizationPublicKey(call) === ONE_PRODUCT.publicKey ? { status: 200, body: { id: Number(id) } } : { status: 401, body: {} }
    );

    await expect(confirmFreemiusOneProductKeys('28609', { publicKey: null, secretKey: ONE_PRODUCT.secretKey })).resolves.toBe('refused');
    await expect(confirmFreemiusOneProductKeys('28609', { publicKey: 'pk with space', secretKey: 'sk' })).resolves.toBe('refused');
    await expect(confirmFreemiusOneProductKeys('28609/../1', ONE_PRODUCT)).resolves.toBe('refused');
    expect(calls).toHaveLength(0);

    await expect(confirmFreemiusOneProductKeys('28609', ONE_PRODUCT)).resolves.toBe('confirmed');
    await expect(confirmFreemiusOneProductKeys('28609', { publicKey: 'pk_other_keys', secretKey: 'sk_other_keys' })).resolves.toBe('refused');
    expect(calls).toHaveLength(2);
    // A Sync or a save asks again.
    forgetFreemiusDeveloperCaches();
    await expect(confirmFreemiusOneProductKeys('28609', ONE_PRODUCT)).resolves.toBe('confirmed');
    expect(calls).toHaveLength(3);
  });
});

describe('no key reaches a log or an error', () => {
  it('a refused pair, a failed request and a failed product read log and say nothing of the keys', async () => {
    const logged: unknown[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(...args);
      });
    }
    mocks.candidates.mockImplementation(async () => [LEGACY_PRODUCT_PAIR, GOOD_PAIR]);
    stubFreemiusApi((path) => (path.includes('/licenses/') || path.endsWith('/plugins/28609.json') ? { status: 500, body: {} } : undefined));

    const errors: unknown[] = [];
    await getFreemiusDeveloperStatus();
    errors.push(await freemiusDeveloperRequest({ path: '/plugins/24851/licenses/9.json' }).catch((error) => error));
    errors.push(await getFreemiusProductKeys('28609').catch((error) => error));
    await getFreemiusProductKeys('24851');

    const secrets = [
      GOOD_PAIR.secretKey,
      GOOD_PAIR.publicKey,
      LEGACY_PRODUCT_PAIR.secretKey,
      ...Object.values(PRODUCT_KEYS).flatMap((keys) => [keys.secret_key]),
    ];
    const text = JSON.stringify([
      logged.map(String),
      errors.map((error) => (error instanceof Error ? { ...error, message: error.message } : error)),
    ]);
    for (const secret of secrets) {
      expect(text).not.toContain(secret);
    }
  });
});
