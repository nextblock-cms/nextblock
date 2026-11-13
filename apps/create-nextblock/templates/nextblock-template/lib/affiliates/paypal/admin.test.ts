import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The CMS PayPal payouts screen's server side (02037). Each export checks the ADMIN first, then the
 * public sandbox (PayPal is never asked and no credential is read or saved there), then the package.
 * Credentials are verified with PayPal before they are saved (a rejection saves nothing), "Test
 * connection" sends nothing and returns no secret, "Check PayPal status now" only syncs, and Cancel
 * goes through the engine with the payout's own environment.
 */

const mocks = vi.hoisted(() => ({
  requireCmsAdmin: vi.fn(),
  active: vi.fn(),
  settings: vi.fn(),
  settingsStrict: vi.fn(),
  createClient: vi.fn(),
  status: vi.fn(),
  preview: vi.fn(),
  resolve: vi.fn(),
  store: vi.fn(),
  cancel: vi.fn(),
  step: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@nextblock-cms/affiliates', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../../../libs/affiliates/src/lib/core/constants')),
  ...(await vi.importActual<Record<string, unknown>>('../../../../../libs/affiliates/src/lib/core/payout-methods')),
}));
vi.mock('@nextblock-cms/affiliates/server', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../../../libs/affiliates/src/lib/repository/rows')),
  ...(await vi.importActual<Record<string, unknown>>('../../../../../libs/affiliates/src/lib/repository/client')),
}));
vi.mock('../../auth/cms-actor', () => ({ requireCmsAdmin: mocks.requireCmsAdmin }));
vi.mock('../admin-data', () => ({ getAffiliateStoreBaseCurrency: async () => 'CAD' }));
vi.mock('../package-state', () => ({ isAffiliatesProgramActive: mocks.active }));
vi.mock('../settings', () => ({ getAffiliatesSettings: mocks.settings, readAffiliatesSettingsStrict: mocks.settingsStrict }));
vi.mock('./client', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('./client')),
  createAffiliatePayPalClient: mocks.createClient,
}));
vi.mock('./credentials', () => ({
  getAffiliatePayPalCredentialStatus: mocks.status,
  previewAffiliatePayPalCredentials: mocks.preview,
  resolveAffiliatePayPalCredentials: mocks.resolve,
  storeAffiliatePayPalCredentials: mocks.store,
}));
vi.mock('./engine', async () => ({
  // the screen's own guide to the release rule (the database checks it again under the payout lock)
  affiliatePayPalReleaseKind: (await vi.importActual<typeof import('./engine')>('./engine')).affiliatePayPalReleaseKind,
  cancelAffiliatePayPalPayout: mocks.cancel,
}));
vi.mock('./runner', () => ({ affiliatePayPalStepHooks: () => ({}), runAffiliatePayPalStep: mocks.step }));

import { AffiliatePayPalError } from './client';
import {
  cancelAffiliatePayPalPayoutNow,
  loadAffiliatePayPalPayoutsOverview,
  saveAffiliatePayPalCredentialsNow,
  syncAffiliatePayPalPayoutsNow,
  testAffiliatePayPalConnectionNow,
} from './admin';

const PAYOUTS_SCOPE = 'https://uri.paypal.com/payments/payouts';
const BALANCES_SCOPE = 'https://uri.paypal.com/services/reporting/balances/read';
const SECRET = 'very-secret-paypal-value';
const CREDENTIALS = { environment: 'live', clientId: 'LiveClientIdABCD1234', secret: SECRET, source: 'cms' };
const SETTINGS = { minPayoutCents: 2000, autoPayoutsEnabled: true, payoutMethods: { stripeSales: 'stripe_connect', freemiusSales: 'paypal' } };

function emptyDb() {
  const builder: Record<string, any> = {};
  for (const method of ['select', 'eq', 'in', 'order', 'limit', 'neq', 'not']) builder[method] = () => builder;
  builder['then'] = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null, count: 0 }).then(resolve);
  return { from: () => builder };
}

/** A database answering each table with its rows (filters ignored: each read here names one table). */
function tableDb(rows: Record<string, unknown[]>) {
  return {
    from: (table: string) => {
      const builder: Record<string, any> = {};
      for (const method of ['select', 'eq', 'in', 'order', 'limit', 'neq', 'not']) builder[method] = () => builder;
      builder['then'] = (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: rows[table] ?? [], error: null, count: (rows[table] ?? []).length }).then(resolve);
      return builder;
    },
  };
}

function client(overrides: Record<string, unknown> = {}) {
  return {
    environment: 'live',
    getToken: vi.fn(async () => ({ accessToken: 't', scopes: [PAYOUTS_SCOPE, BALANCES_SCOPE], appId: 'APP-123', expiresAt: Date.now() + 1000 })),
    getBalances: vi.fn(async () => [{ currency: 'CAD', primary: true, availableCents: 12345 }]),
    createPayoutBatch: vi.fn(),
    cancelPayoutItem: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.requireCmsAdmin.mockResolvedValue({ supabase: emptyDb(), userId: 'admin-1' });
  mocks.active.mockResolvedValue(true);
  mocks.settings.mockResolvedValue(SETTINGS);
  mocks.settingsStrict.mockResolvedValue(SETTINGS);
  mocks.resolve.mockResolvedValue(CREDENTIALS);
  mocks.preview.mockResolvedValue({ environment: 'live', clientId: CREDENTIALS.clientId, secret: SECRET });
  mocks.store.mockResolvedValue(undefined);
  mocks.status.mockResolvedValue({
    sandbox: false,
    environment: 'live',
    environmentSource: 'cms',
    active: { configured: true, source: 'cms', clientIdLast4: '1234', storedSecretUnreadable: false, savedInCms: true },
    environments: {},
  });
  mocks.createClient.mockImplementation(() => client());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('on the public sandbox', () => {
  it('asks PayPal nothing, reads and saves no credential, and cancels nothing', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    mocks.status.mockResolvedValue({ sandbox: true, environment: 'sandbox', environmentSource: 'default', active: { configured: false }, environments: {} });
    const overview = await loadAffiliatePayPalPayoutsOverview();
    expect(overview.sandbox).toBe(true);
    expect(overview.connection).toEqual({ checked: false, payoutsEnabled: null, appId: null, error: null });

    expect(await testAffiliatePayPalConnectionNow()).toEqual({ ok: false, reason: 'sandbox' });
    expect(await saveAffiliatePayPalCredentialsNow({ environment: 'live', clientId: 'X1234567890', secret: 'y' })).toEqual({ status: 'sandbox' });
    expect(await syncAffiliatePayPalPayoutsNow()).toEqual({ status: 'sandbox' });
    expect(await cancelAffiliatePayPalPayoutNow({ payoutIdToCancel: '0b0e7c8e-0f5a-4f7e-9c49-3c8ad0f3a111' })).toEqual({ status: 'sandbox' });

    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.store).not.toHaveBeenCalled();
    expect(mocks.step).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
});

describe('the admin and package gates', () => {
  it('refuses a caller who is not an ADMIN, before anything else', async () => {
    mocks.requireCmsAdmin.mockRejectedValue(new Error('Forbidden'));
    expect(await testAffiliatePayPalConnectionNow()).toEqual({ ok: false, reason: 'forbidden' });
    expect(await saveAffiliatePayPalCredentialsNow({ environment: 'sandbox' })).toEqual({ status: 'forbidden' });
    expect(await syncAffiliatePayPalPayoutsNow()).toEqual({ status: 'forbidden' });
    expect(await cancelAffiliatePayPalPayoutNow({ payoutIdToCancel: '0b0e7c8e-0f5a-4f7e-9c49-3c8ad0f3a111' })).toEqual({ status: 'forbidden' });
    await expect(loadAffiliatePayPalPayoutsOverview()).rejects.toThrow('Forbidden');
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it('refuses while the program is paused', async () => {
    mocks.active.mockResolvedValue(false);
    expect(await testAffiliatePayPalConnectionNow()).toEqual({ ok: false, reason: 'package_inactive' });
    expect(await saveAffiliatePayPalCredentialsNow({ environment: 'sandbox' })).toEqual({ status: 'package_inactive' });
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
});

describe('testAffiliatePayPalConnectionNow', () => {
  it('reports a fresh token, the Payouts scope, the app id and the balance, never a secret', async () => {
    const paypal = client();
    mocks.createClient.mockReturnValue(paypal);
    const result = await testAffiliatePayPalConnectionNow();
    expect(result).toEqual({
      ok: true,
      environment: 'live',
      source: 'cms',
      clientIdLast4: '1234',
      appId: 'APP-123',
      payoutsEnabled: true,
      balances: [{ currency: 'CAD', primary: true, availableCents: 12345 }],
      storeCurrency: 'CAD',
    });
    expect(paypal.getToken).toHaveBeenCalledWith({ fresh: true });
    expect(paypal.createPayoutBatch).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(CREDENTIALS.clientId);
  });

  it('skips the balance without its permission, and maps a rejection', async () => {
    const paypal = client({ getToken: vi.fn(async () => ({ accessToken: 't', scopes: ['openid'], appId: null, expiresAt: 0 })) });
    mocks.createClient.mockReturnValue(paypal);
    expect(await testAffiliatePayPalConnectionNow()).toMatchObject({ ok: true, payoutsEnabled: false, balances: null });
    expect(paypal.getBalances).not.toHaveBeenCalled();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.createClient.mockReturnValue(
      client({
        getToken: vi.fn(async () => {
          throw new AffiliatePayPalError('credentials', { status: 401 });
        }),
      })
    );
    expect(await testAffiliatePayPalConnectionNow()).toEqual({ ok: false, reason: 'credentials' });
    mocks.resolve.mockResolvedValue(null);
    expect(await testAffiliatePayPalConnectionNow()).toEqual({ ok: false, reason: 'not_configured' });
    warn.mockRestore();
  });
});

describe('saveAffiliatePayPalCredentialsNow', () => {
  it('saves only credentials PayPal accepted', async () => {
    expect(await saveAffiliatePayPalCredentialsNow({ environment: 'live', clientId: CREDENTIALS.clientId, secret: SECRET })).toEqual({
      status: 'saved',
      environment: 'live',
      payoutsEnabled: true,
      clientIdLast4: '1234',
    });
    expect(mocks.store).toHaveBeenCalledWith({ environment: 'live', clientId: CREDENTIALS.clientId, secret: SECRET });
  });

  it('saves nothing when PayPal rejects them, cannot be reached, or there is no pair', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.createClient.mockReturnValue(
      client({
        getToken: vi.fn(async () => {
          throw new AffiliatePayPalError('credentials', { status: 401, code: 'INVALID_CLIENT' });
        }),
      })
    );
    expect(await saveAffiliatePayPalCredentialsNow({ environment: 'live', clientId: 'Wrong1234567890', secret: 'nope' })).toEqual({ status: 'rejected' });
    mocks.createClient.mockReturnValue(
      client({
        getToken: vi.fn(async () => {
          throw new AffiliatePayPalError('unavailable');
        }),
      })
    );
    expect(await saveAffiliatePayPalCredentialsNow({ environment: 'live' })).toEqual({ status: 'unavailable' });
    mocks.preview.mockResolvedValue(null);
    expect(await saveAffiliatePayPalCredentialsNow({ environment: 'sandbox' })).toEqual({ status: 'missing_credentials' });
    expect(mocks.store).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('the payouts in flight on the overview', () => {
  it('offers Stop payment for an unclaimed item, and Release only past the release rule (an hour unconfirmed, a week acknowledged and not held)', async () => {
    const now = new Date('2026-11-11T12:00:00.000Z');
    const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
    const row = (id: string, extra: Record<string, unknown>) => ({
      id,
      affiliate_id: 'aff-1',
      amount_cents: 5000,
      currency: 'CAD',
      method: 'paypal',
      status: 'PROCESSING',
      livemode: true,
      paypal_receiver: 'jane@paypal.example',
      paypal_sender_batch_id: 'sb-1',
      created_at: ago(9 * 86_400_000),
      updated_at: ago(60_000),
      ...extra,
    });
    mocks.requireCmsAdmin.mockResolvedValue({
      supabase: tableDb({
        affiliate_payouts: [
          row('p-unclaimed', { paypal_batch_id: 'B1', paypal_item_id: 'I1', paypal_item_status: 'UNCLAIMED', last_attempt_at: ago(600_000) }),
          row('p-unconfirmed-old', { paypal_batch_id: null, last_attempt_at: ago(2 * 3_600_000) }),
          row('p-unconfirmed-new', { paypal_batch_id: null, last_attempt_at: ago(600_000) }),
          row('p-stuck', { paypal_batch_id: 'B2', paypal_item_status: null, last_attempt_at: ago(8 * 86_400_000) }),
          row('p-stuck-new', { paypal_batch_id: 'B3', paypal_item_status: 'MYSTERY', last_attempt_at: ago(86_400_000) }),
          row('p-pending', { paypal_batch_id: 'B4', paypal_item_status: 'PENDING', last_attempt_at: ago(8 * 86_400_000) }),
        ],
        affiliate_profiles: [{ id: 'aff-1', handle: 'jane', display_name: 'Jane' }],
        system_alerts: [],
      }),
      userId: 'admin-1',
    });
    const overview = await loadAffiliatePayPalPayoutsOverview(now);
    expect(overview.inFlight?.rows.map((entry) => [entry.payoutId, entry.action])).toEqual([
      ['p-unclaimed', 'cancel'],
      ['p-unconfirmed-old', 'release'],
      ['p-unconfirmed-new', null],
      ['p-stuck', 'release_acknowledged'],
      ['p-stuck-new', null],
      ['p-pending', null],
    ]);
  });
});

describe('syncAffiliatePayPalPayoutsNow and cancelAffiliatePayPalPayoutNow', () => {
  it('runs the PayPal step without sending, with the settings read strictly', async () => {
    mocks.step.mockResolvedValue({ synced: 2, completed: 1, failed: 0, inFlight: 1, unclaimed: 0, pendingRetry: 0, errors: [] });
    // the screen words "sent again by the next payout run" only while automatic payouts are on
    expect(await syncAffiliatePayPalPayoutsNow()).toMatchObject({ status: 'synced', summary: { synced: 2 }, autoPayoutsEnabled: true });
    mocks.settingsStrict.mockResolvedValue({ ...SETTINGS, autoPayoutsEnabled: false });
    expect(await syncAffiliatePayPalPayoutsNow()).toMatchObject({ status: 'synced', autoPayoutsEnabled: false });
    expect(mocks.step).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'admin', send: false }));
    mocks.settingsStrict.mockResolvedValue(null);
    expect(await syncAffiliatePayPalPayoutsNow()).toEqual({ status: 'settings_unavailable' });
  });

  it('checks the payout id, then cancels through the engine', async () => {
    expect(await cancelAffiliatePayPalPayoutNow({ payoutIdToCancel: 'not-a-uuid' })).toEqual({ status: 'invalid_input' });
    mocks.cancel.mockResolvedValue({ status: 'cancelled', result: 'returned' });
    expect(await cancelAffiliatePayPalPayoutNow({ payoutIdToCancel: '0b0e7c8e-0f5a-4f7e-9c49-3c8ad0f3a111' })).toEqual({
      status: 'cancelled',
      result: 'returned',
    });
    expect(mocks.cancel.mock.calls[0]?.[1]).toBe('0b0e7c8e-0f5a-4f7e-9c49-3c8ad0f3a111');
  });
});
