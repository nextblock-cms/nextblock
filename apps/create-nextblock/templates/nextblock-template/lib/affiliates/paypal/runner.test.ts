import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The PayPal step of every payout run (02037): on the public sandbox it returns null before it reads
 * a credential or a payout; elsewhere it hands the engine the service-role client, the active
 * environment, the per-environment credentials, the gateways the program pays with PayPal and the
 * site name, and it never throws.
 */

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  environment: vi.fn(),
  credentials: vi.fn(),
  serviceRole: vi.fn(() => ({ from: vi.fn() })),
  siteSettings: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@nextblock-cms/db/server', () => ({ getServiceRoleSupabaseClient: mocks.serviceRole }));
vi.mock('@nextblock-cms/affiliates', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../../../libs/affiliates/src/lib/core/payout-methods')),
}));
vi.mock('../../../app/lib/site-settings', () => ({ getSiteSettings: mocks.siteSettings }));
vi.mock('../../../app/lib/seo', () => ({ DEFAULT_SITE_TITLE: 'NextBlock' }));
vi.mock('./credentials', () => ({
  resolveAffiliatePayPalEnvironment: mocks.environment,
  resolveAffiliatePayPalCredentials: mocks.credentials,
}));
vi.mock('./engine', () => ({ runAffiliatePayPalPayouts: mocks.run }));
vi.mock('./events', () => ({ dispatchAffiliatePayPalPayoutEvent: vi.fn(), recordAffiliatePayPalAlert: vi.fn() }));

import { runAffiliatePayPalStep } from './runner';

const SETTINGS = {
  notificationEmails: [],
  minPayoutCents: 2500,
  autoPayoutsEnabled: true,
  termsUrlEn: '',
  termsUrlFr: '',
  payoutMethods: { stripeSales: 'stripe_connect', freemiusSales: 'paypal' },
} as never;

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const mock of [mocks.run, mocks.environment, mocks.credentials, mocks.siteSettings]) mock.mockReset();
  mocks.serviceRole.mockClear();
  mocks.environment.mockResolvedValue({ environment: 'live', source: 'cms' });
  mocks.credentials.mockResolvedValue({ environment: 'live', clientId: 'ClientId1234567890', secret: 's', source: 'cms' });
  mocks.siteSettings.mockResolvedValue({ siteTitle: 'Acme Shop' });
  mocks.run.mockResolvedValue({ environment: 'live', submitted: 1 });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('runAffiliatePayPalStep', () => {
  it('returns null on the public sandbox before reading anything', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    expect(await runAffiliatePayPalStep({ trigger: 'admin', settings: SETTINGS, send: true })).toBeNull();
    expect(mocks.environment).not.toHaveBeenCalled();
    expect(mocks.credentials).not.toHaveBeenCalled();
    expect(mocks.serviceRole).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('hands the engine the environment, the PayPal gateways, the minimum and the site name', async () => {
    const summary = await runAffiliatePayPalStep({ trigger: 'cron', settings: SETTINGS, send: false, timeBudgetMs: 9000 });
    expect(summary).toEqual({ environment: 'live', submitted: 1 });
    const deps = mocks.run.mock.calls[0]?.[0];
    expect(deps).toMatchObject({
      environment: 'live',
      trigger: 'cron',
      gateways: ['FREEMIUS'],
      minPayoutCents: 2500,
      send: false,
      siteName: 'Acme Shop',
      timeBudgetMs: 9000,
    });
    await deps.credentialsFor('sandbox');
    expect(mocks.credentials).toHaveBeenCalledWith('sandbox');
  });

  it('never throws: a failure is logged as a code and the step answers null', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.run.mockRejectedValue(new Error('boom'));
    expect(await runAffiliatePayPalStep({ trigger: 'auto', settings: SETTINGS, send: true })).toBeNull();
    mocks.environment.mockRejectedValue(new Error('db down'));
    expect(await runAffiliatePayPalStep({ trigger: 'auto', settings: SETTINGS, send: true })).toBeNull();
    warn.mockRestore();
  });
});
