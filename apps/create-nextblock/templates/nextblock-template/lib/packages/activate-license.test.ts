import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Two promises of the activation core. The row keeps none of the credentials Freemius answers
 * with. And a key Freemius already holds on this install (`license_activated`: the CMS lost its
 * row to a database reset, a reinstall, a deactivation that never reached Freemius) is read
 * back and recorded instead of leaving the buyer locked out of their own license.
 */

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  revalidatePath: vi.fn(),
  updateTag: vi.fn(),
  upserted: [] as Array<Record<string, any>>,
}));

vi.mock('server-only', () => ({}));

vi.mock('next/cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/cache')>()),
  revalidatePath: mocks.revalidatePath,
  updateTag: mocks.updateTag,
}));

import { activateLicenseKeyWithFreemius, buildPackageActivationInstance } from './activate-license';

const NOW = Date.parse('2026-10-30T12:00:00Z');
const LICENSE_KEY = 'sk_7Ab+9Cd%2F;eF';
const INSTALL_ID = '4815162342';
const instance = buildPackageActivationInstance({ host: 'shop.example.com' });

const supabase = {
  from: () => ({
    delete: () => ({ eq: () => ({ neq: async () => ({ error: null }) }) }),
    upsert: async (row: Record<string, any>) => {
      mocks.upserted.push(row);
      return { error: null };
    },
  }),
};

const activate = () =>
  activateLicenseKeyWithFreemius({ instance, licenseKey: LICENSE_KEY, packageId: 'cortex-ai', supabase });

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' }, status });
}

const alreadyActivated = (message = `License is already activated on install ${INSTALL_ID}.`) =>
  jsonResponse(400, { error: { code: 'license_activated', http: 400, message, type: '' }, path: '', request: [] });

function license(overrides: Record<string, unknown> = {}) {
  return {
    expiration: '2027-11-15 10:00:00',
    id: '1977',
    is_block_features: true,
    is_cancelled: false,
    plan_id: '47122',
    plugin_id: '28609',
    pricing_id: '9',
    secret_key: LICENSE_KEY,
    user_id: '77',
    ...overrides,
  };
}

/** Route Freemius by endpoint: the activation call, then the read-back of the install. */
function freemiusAnswers(activation: () => Response, readBack?: () => Response) {
  mocks.fetch.mockImplementation(async (url: string) =>
    url.includes('/licenses/activate.json') ? activation() : (readBack?.() ?? new Response(null, { status: 500 }))
  );
}

describe('activateLicenseKeyWithFreemius', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.stubGlobal('fetch', mocks.fetch);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.fetch.mockReset();
    mocks.revalidatePath.mockReset();
    mocks.updateTag.mockReset();
    mocks.upserted = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps none of the credentials Freemius answers with', async () => {
    freemiusAnswers(() =>
      jsonResponse(200, {
        install_api_token: 'install-token',
        install_id: INSTALL_ID,
        install_public_key: 'pk_install',
        install_secret_key: 'sk_install',
        is_marketing_allowed: true,
        license_plan_id: '47122',
        license_plan_name: 'pro',
        license_pricing_id: '9',
        plugin_id: '28609',
        some_future_field: 'not on the allowlist',
        user_id: '77',
        user_public_key: 'pk_user',
        user_secret_key: 'sk_user',
      })
    );

    await expect(activate()).resolves.toMatchObject({ packageId: 'cortex-ai', planId: '47122', success: true });

    expect(mocks.upserted).toHaveLength(1);
    expect(mocks.upserted[0].meta).toEqual({
      fm_install_id: INSTALL_ID,
      fm_product_id: '28609',
      fm_uid: instance.uid,
      install_id: INSTALL_ID,
      license_plan_id: '47122',
      license_plan_name: 'pro',
      license_pricing_id: '9',
      nextblock: { activated_at: new Date(NOW).toISOString(), plan_id: '47122', source: 'manual' },
      plugin_id: '28609',
      user_id: '77',
    });
  });

  it('records a key Freemius already holds on this install', async () => {
    freemiusAnswers(alreadyActivated, () => jsonResponse(200, license()));

    await expect(activate()).resolves.toMatchObject({
      expiration: '2027-11-15 10:00:00',
      packageId: 'cortex-ai',
      planId: '47122',
      success: true,
    });

    // The named install was read back with this site's uid and key, and no other product tried.
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    const readBack = new URL(mocks.fetch.mock.calls[1][0] as string);
    expect(readBack.pathname).toBe(`/v1/products/28609/installs/${INSTALL_ID}/license.json`);
    expect(readBack.searchParams.get('uid')).toBe(instance.uid);
    expect(readBack.searchParams.get('license_key')).toBe(LICENSE_KEY);

    expect(mocks.upserted).toHaveLength(1);
    expect(mocks.upserted[0]).toMatchObject({
      license_key: LICENSE_KEY,
      meta: {
        fm_install_id: INSTALL_ID,
        fm_product_id: '28609',
        fm_uid: instance.uid,
        nextblock: { expiration: '2027-11-15 10:00:00', plan_id: '47122', source: 'manual' },
      },
      package_id: 'cortex-ai',
      status: 'active',
    });
    expect(mocks.updateTag).toHaveBeenCalled();
  });

  it('records no date for a held key whose plan keeps features after expiry', async () => {
    freemiusAnswers(alreadyActivated, () =>
      jsonResponse(200, license({ expiration: '2026-10-01 00:00:00', is_block_features: false }))
    );

    await expect(activate()).resolves.toMatchObject({ expiration: null, success: true });

    expect(mocks.upserted[0].meta.nextblock).not.toHaveProperty('expiration');
  });

  it.each([
    ['cancelled', license({ is_cancelled: true }), /no longer valid/],
    // The renewal grace keeps an activation alive; it does not start one.
    ['just lapsed', license({ expiration: '2026-10-29 00:00:00' }), /no longer valid/],
  ])('refuses a held key whose license is %s', async (_label, body, message) => {
    freemiusAnswers(alreadyActivated, () => jsonResponse(200, body));

    await expect(activate()).resolves.toMatchObject({ code: 'freemius_error', error: expect.stringMatching(message) });

    expect(mocks.upserted).toEqual([]);
  });

  it('asks to try again when Freemius cannot confirm a held key', async () => {
    freemiusAnswers(alreadyActivated, () => jsonResponse(503, { error: { code: 'unavailable' } }));

    await expect(activate()).resolves.toMatchObject({
      code: 'freemius_error',
      error: expect.stringMatching(/try again/i),
    });

    expect(mocks.upserted).toEqual([]);
  });

  it('points to the customer portal when Freemius names no install', async () => {
    freemiusAnswers(() => alreadyActivated('License is already activated.'));

    await expect(activate()).resolves.toMatchObject({
      code: 'freemius_error',
      error: expect.stringMatching(/customer portal/i),
    });

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.upserted).toEqual([]);
  });
});
