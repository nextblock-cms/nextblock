import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Store readiness (pages/cms/payments/queries.ts, the one predicate behind the buy buttons, the
 * product pages, the CMS banners and the /api/checkout preflight) reads Freemius as ready from
 * getPaymentConfigStatus. With only a Freemius developer key pair configured (nextblock.dev), that
 * used to wait on a live check of the pair with Freemius during public renders: up to 8 s per page
 * on every cold start and while Freemius hung (review 2026-11-13). It now answers from memory: a
 * configured pair counts unless Freemius has refused it, and the pair is checked after the
 * response. On the sandbox (simulated checkout, the pair never used) a configured env pair counts.
 *
 * The real payment-config and freemius-developer-api run here; only the database, the role check,
 * Next's after() and api.freemius.com are faked.
 */

const mocks = vi.hoisted(() => ({
  afterTasks: [] as Array<() => unknown>,
  after: vi.fn<(task: () => unknown) => void>(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/server', () => ({ after: mocks.after }));
vi.mock('@nextblock-cms/db/server', async () => {
  const configResolve = await vi.importActual<{
    isSandboxEnvironment: () => boolean;
    resolveConfigValue: (dbValue: string | null | undefined, envName: string, options?: { warnOnEnvFallback?: boolean }) => string | null;
  }>('../../../db/src/lib/config-resolve');
  // No payment row is stored: every credential comes from the env.
  const noRows = () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
  });
  return {
    createClient: noRows,
    getServiceRoleSupabaseClient: noRows,
    encryptWithEnvKey: (value: string) => value,
    getSecretEnvelopeStatus: () => ({ hasStoredValue: false, last4: null }),
    isSandboxEnvironment: configResolve.isSandboxEnvironment,
    resealWithEnvKey: (value: unknown) => value,
    resolveConfigValue: configResolve.resolveConfigValue,
    siteSettingSecretSlot: (key: string, field: string) => ({ key, field }),
    tryDecryptWithEnvKey: () => null,
  };
});
vi.mock('./server-actions/require-ecom-role', () => ({
  getEcomActorRole: vi.fn(async () => 'ADMIN'),
  requireEcomAdmin: vi.fn(),
}));

import { forgetFreemiusDeveloperCaches } from './freemius-developer-api';
import { clearPaymentConfigCache, getPaymentConfigStatus } from './payment-config';

const DEV = '4242';
const DEVELOPER_ENV = {
  FREEMIUS_DEVELOPER_ID: DEV,
  FREEMIUS_DEVELOPER_PUBLIC_KEY: 'pk_dev_readiness',
  FREEMIUS_DEVELOPER_SECRET_KEY: 'sk_dev_readiness',
};

/** api.freemius.com: `status` for every request, the account's three products on a 200. Nothing is answered before `open()`. */
function stubFreemius(status: number, options: { gated?: boolean } = {}) {
  let open: () => void = () => undefined;
  const gate = options.gated
    ? new Promise<void>((resolve) => {
        open = resolve;
      })
    : Promise.resolve();
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => {
    await gate;
    const body = status === 200 ? { plugins: [{ id: 24851 }, { id: 28609 }, { id: 43273 }] } : { error: { message: 'No.' } };
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, open };
}

async function runAfterTasks() {
  for (const task of mocks.afterTasks.splice(0)) {
    await task();
  }
}

/** Rejects when `promise` takes longer than `ms`: readiness that waited on a Freemius request that never answers. */
function withinMs<T>(promise: Promise<T>, ms = 1_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms)),
  ]);
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  // The one-product keys are missing, so only the developer pair can make Freemius ready.
  for (const name of ['FREEMIUS_PUBLIC_KEY', 'FREEMIUS_SECRET_KEY', 'FREEMIUS_PRODUCT_ID', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY']) {
    vi.stubEnv(name, '');
  }
  for (const [name, value] of Object.entries(DEVELOPER_ENV)) vi.stubEnv(name, value);
  clearPaymentConfigCache();
  forgetFreemiusDeveloperCaches();
  mocks.afterTasks.length = 0;
  mocks.after.mockReset().mockImplementation((task) => {
    mocks.afterTasks.push(task);
  });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getPaymentConfigStatus with only a Freemius developer key pair', () => {
  it('is Freemius-ready at once, without waiting on Freemius, and checks the pair after the response', async () => {
    const { fetchMock, open } = stubFreemius(200, { gated: true });

    await expect(withinMs(getPaymentConfigStatus())).resolves.toMatchObject({ freemius: { hasKeys: true, missing: [] } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.afterTasks).toHaveLength(1);

    open();
    await runAfterTasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`https://api.freemius.com/v1/developers/${DEV}/plugins.json?count=50&offset=0`);

    clearPaymentConfigCache();
    await expect(getPaymentConfigStatus()).resolves.toMatchObject({ freemius: { hasKeys: true, missing: [] } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.afterTasks).toHaveLength(0);
  });

  it('is not ready once Freemius has refused the pair', async () => {
    const { fetchMock } = stubFreemius(401);

    await getPaymentConfigStatus();
    await runAfterTasks();
    clearPaymentConfigCache();

    await expect(getPaymentConfigStatus()).resolves.toMatchObject({
      freemius: { hasKeys: false, missing: ['Public key', 'Secret key'] },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('is not ready when Freemius answers 404 for the developer (a wrong developer id): a refusal, not an outage', async () => {
    // Review 2026-11-13, round 2: read as unreachable, it showed buy buttons whose checkouts and
    // webhooks all answered 503.
    const { fetchMock } = stubFreemius(404);

    await getPaymentConfigStatus();
    await runAfterTasks();
    clearPaymentConfigCache();

    await expect(getPaymentConfigStatus()).resolves.toMatchObject({
      freemius: { hasKeys: false, missing: ['Public key', 'Secret key'] },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stays ready while Freemius cannot be reached: checkout reports that itself', async () => {
    stubFreemius(503);

    await getPaymentConfigStatus();
    await runAfterTasks();
    clearPaymentConfigCache();

    await expect(getPaymentConfigStatus()).resolves.toMatchObject({ freemius: { hasKeys: true, missing: [] } });
  });

  it('is not ready without a developer id and pair, and asks Freemius nothing', async () => {
    vi.stubEnv('FREEMIUS_DEVELOPER_ID', '');
    const { fetchMock } = stubFreemius(200);

    await expect(getPaymentConfigStatus()).resolves.toMatchObject({ freemius: { hasKeys: false, missing: ['Public key', 'Secret key'] } });
    expect(mocks.after).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * Review 2026-11-13, round 3: wrong developer keys typed beside working one-product keys (the
 * Product ID empty, no JSON entry) left the store ready while every checkout and webhook answered
 * 503: the key policy lets the one-product keys stand in for no product while Freemius refuses a
 * dedicated pair. Readiness now reads that refusal from memory, still never waiting on Freemius.
 */
describe('getPaymentConfigStatus with the one-product keys and a dedicated developer pair', () => {
  beforeEach(() => {
    vi.stubEnv('FREEMIUS_PUBLIC_KEY', 'pk_one_product_readiness');
    vi.stubEnv('FREEMIUS_SECRET_KEY', 'sk_one_product_readiness');
  });

  it('is ready at once, then not ready once Freemius has refused the dedicated pair', async () => {
    const { fetchMock, open } = stubFreemius(401, { gated: true });

    await expect(withinMs(getPaymentConfigStatus())).resolves.toMatchObject({ freemius: { hasKeys: true, missing: [] } });
    expect(fetchMock).not.toHaveBeenCalled();

    open();
    await runAfterTasks();
    clearPaymentConfigCache();

    await expect(getPaymentConfigStatus()).resolves.toMatchObject({
      freemius: { hasKeys: false, missing: ['Developer key pair Freemius accepts, or a Product ID'] },
    });
    // One check each: the dedicated pair, then the one-product names tried as a pair (a developer id is set).
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // A Product ID binds the one-product keys to a product, which they then open: ready again.
    vi.stubEnv('FREEMIUS_PRODUCT_ID', '28609');
    await expect(getPaymentConfigStatus()).resolves.toMatchObject({ freemius: { hasKeys: true, missing: [] } });
  });

  it.each([
    ['works', 200],
    ['cannot be reached', 503],
  ])('stays ready when the dedicated pair %s', async (_label, status) => {
    stubFreemius(status);

    await getPaymentConfigStatus();
    await runAfterTasks();
    clearPaymentConfigCache();

    await expect(getPaymentConfigStatus()).resolves.toMatchObject({ freemius: { hasKeys: true, missing: [] } });
  });
});

describe('getPaymentConfigStatus on the sandbox', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
  });

  it('counts a configured env developer pair as ready (its checkout is simulated), with no Freemius request', async () => {
    const { fetchMock } = stubFreemius(200);

    await expect(getPaymentConfigStatus()).resolves.toMatchObject({ freemius: { hasKeys: true, missing: [] } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it('is not ready without one', async () => {
    vi.stubEnv('FREEMIUS_DEVELOPER_PUBLIC_KEY', '');
    vi.stubEnv('FREEMIUS_DEVELOPER_SECRET_KEY', '');
    const { fetchMock } = stubFreemius(200);

    await expect(getPaymentConfigStatus()).resolves.toMatchObject({ freemius: { hasKeys: false, missing: ['Public key', 'Secret key'] } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
