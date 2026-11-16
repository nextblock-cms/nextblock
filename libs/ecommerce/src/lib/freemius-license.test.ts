import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The license key on the checkout success page and the customer's order pages
 * (`getFreemiusOrderLicense`). Each visit used to send one uncached license read to Freemius, at
 * developer scope since 2026-11-12 (25 visits of one free-trial order gave 25 reads on the key
 * production's checkouts, claims, coupon pushes and webhook checks share). Reads are now kept in
 * memory per (product, license), misses briefly, concurrent visits share one request, and uncached
 * reads are capped per instance and minute. The key is re-checked against the order on every
 * visit, cached or not, and the public sandbox reads no license at all.
 *
 * The developer-scope module runs for real: only Freemius (fetch), the order rows and the
 * configured developer pair are faked.
 */

const mocks = vi.hoisted(() => ({
  candidates: vi.fn(async () => [] as Array<Record<string, string>>),
}));

vi.mock('server-only', () => ({}));
vi.mock('@nextblock-cms/db/server', async () => ({
  createClient: () => ({}),
  getServiceRoleSupabaseClient: () => ({}),
  // The real predicate (a dependency-free module), so the env stub drives it.
  isSandboxEnvironment: (await vi.importActual<{ isSandboxEnvironment: () => boolean }>('../../../db/src/lib/config-resolve'))
    .isSandboxEnvironment,
}));
vi.mock('./payment-config', () => ({
  hydrateFreemiusEnvFromDb: async () => undefined,
  resolveFreemiusDeveloperCredentialCandidates: mocks.candidates,
}));

import { forgetFreemiusDeveloperCaches } from './freemius-developer-api';
import { forgetFreemiusLicenseReads, getFreemiusOrderLicense } from './freemius-license';

type Row = Record<string, unknown>;
type Answer = { status: number; body?: unknown };

const DEV = '4242';
const PAIR = { developerId: DEV, publicKey: 'pk_dev_master', secretKey: 'sk_dev_master', source: 'env' };
const NOW = new Date('2026-11-13T10:10:00Z');
// The cap and windows freemius-license.ts enforces.
const READS_PER_MINUTE = 30;
const HIT_TTL_MS = 5 * 60_000;
const MISS_TTL_MS = 30_000;

/** A license Freemius returns for product 28609, created a minute after the default order. */
function license(id: number, overrides: Row = {}): Row {
  return { id, plugin_id: 28609, plan_id: 47122, created: '2026-11-13 10:01:00', expiration: null, is_cancelled: false, secret_key: `sk_license_${id}`, ...overrides };
}

/** An order row of product 28609 that points at `licenseId`. */
function order(id: string, licenseId: number | string, overrides: Row = {}): Row {
  return {
    id,
    provider: 'freemius',
    created_at: '2026-11-13T10:00:00Z',
    freemius_product_id: '28609',
    freemius_license_id: String(licenseId),
    freemius_trial_ends_at: null,
    ...overrides,
  };
}

/** The `orders` read getFreemiusOrderLicense makes through the caller's client. */
function ordersClient(rows: Row[]) {
  return {
    from: () => {
      let wanted: unknown = null;
      const builder = {
        select: () => builder,
        eq: (_column: string, value: unknown) => {
          wanted = value;
          return builder;
        },
        maybeSingle: async () => ({ data: rows.find((row) => row.id === wanted) ?? null, error: null }),
      };
      return builder;
    },
  } as any;
}

/**
 * api.freemius.com: the account's products, then `licenses` by id (404 for any other). Every request
 * is recorded, the Freemius SDK's too (it sends a Request to fast-api.freemius.com with the product's keys).
 */
function stubFreemius(licenses: (licenseId: string) => Answer | undefined) {
  const paths: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | Request) => {
      const url = typeof input === 'string' ? input : input.url;
      const path = url.replace(`https://api.freemius.com/v1/developers/${DEV}`, '').split('?')[0];
      paths.push(path);
      if (path === '/plugins.json') {
        return new Response(JSON.stringify({ plugins: [{ id: 24851 }, { id: 28609 }, { id: 43273 }] }), { status: 200 });
      }
      const match = path.match(/^\/plugins\/28609\/licenses\/(\d+)\.json$/);
      const answer = (match && licenses(match[1])) ?? { status: 404, body: { error: { code: 'license_not_found', message: 'Not found.' } } };
      return new Response(answer.body === undefined ? '' : JSON.stringify(answer.body), { status: answer.status });
    })
  );
  return {
    paths,
    licenseReads: () => paths.filter((path) => path.includes('/licenses/')).length,
  };
}

function visit(rows: Row[], orderId: string) {
  return getFreemiusOrderLicense({ orderId, client: ordersClient(rows) });
}

function advance(ms: number) {
  vi.setSystemTime(Date.now() + ms);
}

function loggedText(): string {
  return [console.error, console.warn, console.log, console.info]
    .flatMap((spy) => (spy as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat())
    .map((value) => (value instanceof Error ? `${value.name} ${value.message} ${String(value.cause ?? '')}` : String(value)))
    .join('\n');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  mocks.candidates.mockReset().mockImplementation(async () => [PAIR]);
  forgetFreemiusDeveloperCaches();
  forgetFreemiusLicenseReads();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('license reads on page visits', () => {
  it('sends one read for many visits of one order, and reads again once the cached license expires', async () => {
    const freemius = stubFreemius((id) => (id === '555001' ? { status: 200, body: license(555001) } : undefined));
    const rows = [order('order-1', 555001)];

    for (let n = 0; n < 25; n += 1) {
      await expect(visit(rows, 'order-1')).resolves.toMatchObject({ licenseId: '555001', licenseKey: 'sk_license_555001', planId: '47122' });
    }
    expect(freemius.licenseReads()).toBe(1);

    advance(HIT_TTL_MS - 1_000);
    await visit(rows, 'order-1');
    expect(freemius.licenseReads()).toBe(1);

    advance(2_000);
    await expect(visit(rows, 'order-1')).resolves.toMatchObject({ licenseKey: 'sk_license_555001' });
    expect(freemius.licenseReads()).toBe(2);
  });

  it('shares one request between concurrent visits of one license', async () => {
    const freemius = stubFreemius((id) => (id === '555001' ? { status: 200, body: license(555001) } : undefined));
    const rows = [order('order-1', 555001), order('order-2', 555001)];

    const results = await Promise.all(Array.from({ length: 10 }, (_, n) => visit(rows, n % 2 ? 'order-1' : 'order-2')));

    expect(results.every((result) => result?.licenseKey === 'sk_license_555001')).toBe(true);
    expect(freemius.licenseReads()).toBe(1);
  });

  it('starts no more uncached reads a minute than the cap: past it a visit reads nothing and gets the emailed-key fallback', async () => {
    const freemius = stubFreemius((id) => ({ status: 200, body: license(Number(id)) }));
    const rows = Array.from({ length: READS_PER_MINUTE + 10 }, (_, n) => order(`order-${n}`, 600000 + n));

    const results = [];
    for (const row of rows) results.push(await visit(rows, String(row.id)));

    expect(freemius.licenseReads()).toBe(READS_PER_MINUTE);
    expect(results.slice(0, READS_PER_MINUTE).every((result) => result?.licenseKey?.startsWith('sk_license_'))).toBe(true);
    // Over the cap: the order's facts, no key, as after a failed read; logged once, not per visit.
    expect(results.slice(READS_PER_MINUTE)).toEqual(
      rows.slice(READS_PER_MINUTE).map((row) => ({
        licenseId: row.freemius_license_id,
        licenseKey: null,
        planId: null,
        expiration: null,
        trialEndsAt: null,
        isCancelled: false,
      }))
    );
    expect((console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(([line]) => String(line).includes('paused'))).toHaveLength(1);

    // A license read before the cap is still served from memory.
    await expect(visit(rows, 'order-0')).resolves.toMatchObject({ licenseKey: 'sk_license_600000' });
    expect(freemius.licenseReads()).toBe(READS_PER_MINUTE);

    // A minute later the budget is back.
    advance(60_000);
    await expect(visit(rows, `order-${READS_PER_MINUTE}`)).resolves.toMatchObject({ licenseKey: `sk_license_${600000 + READS_PER_MINUTE}` });
    expect(freemius.licenseReads()).toBe(READS_PER_MINUTE + 1);
  });

  it('remembers a missing license and a failed read briefly, then asks again', async () => {
    let failing = true;
    const freemius = stubFreemius((id) => {
      if (id === '555404') return undefined;
      if (id === '555500') return failing ? { status: 500, body: { error: { message: 'Freemius is down.' } } } : { status: 200, body: license(555500) };
      return undefined;
    });
    const rows = [order('missing', 555404), order('failing', 555500)];

    for (let n = 0; n < 5; n += 1) {
      await expect(visit(rows, 'missing')).resolves.toMatchObject({ licenseKey: null });
      await expect(visit(rows, 'failing')).resolves.toMatchObject({ licenseKey: null });
    }
    expect(freemius.licenseReads()).toBe(2);
    // One line for the failed read, never one per visit.
    expect((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(1);

    advance(MISS_TTL_MS - 1_000);
    await visit(rows, 'missing');
    await visit(rows, 'failing');
    expect(freemius.licenseReads()).toBe(2);

    failing = false;
    advance(2_000);
    await expect(visit(rows, 'missing')).resolves.toMatchObject({ licenseKey: null });
    await expect(visit(rows, 'failing')).resolves.toMatchObject({ licenseKey: 'sk_license_555500' });
    expect(freemius.licenseReads()).toBe(4);
    expect(loggedText()).not.toContain('sk_license_');
    expect(loggedText()).not.toContain('sk_dev_master');
  });

  it('re-checks a cached license against each order: its product, and created after the order', async () => {
    const freemius = stubFreemius((id) => {
      if (id === '555001') return { status: 200, body: license(555001) };
      // A license of another product, behind an order of 28609 (a poisoned license id).
      if (id === '555002') return { status: 200, body: license(555002, { plugin_id: 24851 }) };
      return undefined;
    });
    const rows = [
      order('genuine', 555001),
      // Created 29 minutes after the license: never this order's own.
      order('later', 555001, { created_at: '2026-11-13T10:30:00Z' }),
      order('poisoned', 555002),
    ];

    await expect(visit(rows, 'genuine')).resolves.toMatchObject({ licenseKey: 'sk_license_555001' });
    await expect(visit(rows, 'later')).resolves.toMatchObject({ licenseId: '555001', licenseKey: null });
    await expect(visit(rows, 'genuine')).resolves.toMatchObject({ licenseKey: 'sk_license_555001' });
    expect(freemius.licenseReads()).toBe(1);

    await expect(visit(rows, 'poisoned')).resolves.toMatchObject({ licenseKey: null });
    await expect(visit(rows, 'poisoned')).resolves.toMatchObject({ licenseKey: null });
    expect(freemius.licenseReads()).toBe(2);
    expect(loggedText()).not.toContain('sk_license_');
  });

  it('asks nothing for an order without a Freemius license, or for ids that are not Freemius ids', async () => {
    const freemius = stubFreemius(() => undefined);
    const rows = [
      order('stripe', 555001, { provider: 'stripe' }),
      order('no-license', '', {}),
      order('not-an-id', '../users/1', {}),
    ];

    await expect(visit(rows, 'stripe')).resolves.toBeNull();
    await expect(visit(rows, 'no-license')).resolves.toBeNull();
    await expect(visit(rows, 'not-an-id')).resolves.toMatchObject({ licenseId: '../users/1', licenseKey: null });
    expect(freemius.paths).toEqual([]);
  });
});

describe('on the public sandbox', () => {
  it('reads no license at Freemius, whatever order a visitor opens, and shows the emailed-key fallback', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    // The developer pair refuses on the sandbox by itself; the one-product keys in its env (which
    // can be a real product's, or the developer pair under the legacy names) must not be used either.
    // (The SDK refuses keys shorter than 32 characters before sending anything.)
    vi.stubEnv('FREEMIUS_PUBLIC_KEY', 'pk_one_product_0123456789abcdef0123456789');
    vi.stubEnv('FREEMIUS_SECRET_KEY', 'sk_one_product_0123456789abcdef0123456789');
    vi.stubEnv('FREEMIUS_API_KEY', 'api_one_product_0123456789abcdef0123456789');
    const freemius = stubFreemius((id) => ({ status: 200, body: license(Number(id)) }));
    const rows = [order('order-1', 555001)];

    for (let n = 0; n < 5; n += 1) {
      await expect(getFreemiusOrderLicense({ orderId: 'order-1', client: ordersClient(rows) })).resolves.toEqual({
        licenseId: '555001',
        licenseKey: null,
        planId: null,
        expiration: null,
        trialEndsAt: null,
        isCancelled: false,
      });
    }

    expect(freemius.paths).toEqual([]);
    expect(mocks.candidates).not.toHaveBeenCalled();
  });
});
