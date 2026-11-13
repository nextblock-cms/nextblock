import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Stripe payouts screen's server side: "Test connection" makes read-only Stripe calls (never a
 * create, update or transfer), answers each check with fixed wording (a rejected key, a restricted
 * key without a permission, Stripe unreachable), never returns Stripe's message or key material,
 * and on the public sandbox asks Stripe nothing (the key belongs to the operator). The overview
 * compares what is owed with the transferable balance per currency, in the key's mode.
 */

type Row = Record<string, any>;

const mocks = vi.hoisted(() => ({
  requireCmsAdmin: vi.fn(),
  resolve: vi.fn(),
  platformInfo: vi.fn(),
  keys: vi.fn(),
  active: vi.fn(),
  settings: vi.fn(),
  obligations: vi.fn(),
  tables: {} as Record<string, Row[]>,
  /** Tables whose reads answer an error. */
  failing: new Set<string>(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@nextblock-cms/ecommerce/server', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/ecommerce/src/lib/stripe/webhook-events')),
  getStripeKeyDiagnostics: mocks.keys,
}));
vi.mock('@nextblock-cms/affiliates', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/core/constants')),
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/core/money')),
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/core/payout-methods')),
}));
vi.mock('@nextblock-cms/affiliates/server', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/payouts/index')),
  loadAffiliatePayoutObligations: mocks.obligations,
}));
vi.mock('../auth/cms-actor', () => ({ requireCmsAdmin: mocks.requireCmsAdmin }));
vi.mock('./payout-runner', () => ({
  resolveAffiliateStripeClient: mocks.resolve,
  getAffiliatePayoutPlatformInfo: mocks.platformInfo,
}));
vi.mock('./connect-service', () => ({
  AFFILIATE_CONNECT_SETUP_ALERT_KIND: 'connect_setup',
  affiliateConnectReturnUrls: () => {
    const site = (process.env.NEXT_PUBLIC_URL || 'http://localhost:3000').replace(/\/+$/, '');
    return { returnUrl: `${site}/portal/retailer/payouts?connected=1`, refreshUrl: `${site}/portal/retailer/payouts/connect/refresh` };
  },
}));
vi.mock('./admin-data', () => ({ getAffiliateStoreBaseCurrency: async () => 'USD' }));
vi.mock('./package-state', () => ({ isAffiliatesProgramActive: mocks.active }));
vi.mock('./settings', () => ({ getAffiliatesSettings: mocks.settings }));

import {
  AFFILIATE_STRIPE_SETUP_NOTHING_MOVED,
  describeAffiliateStripePayoutSchedule,
  loadAffiliateStripePayoutsOverview,
  testAffiliateStripeSetupNow,
} from './payout-setup';

/* --------------------------------------------------------------------- fakes --- */

/** A chainable read-only table fake: filters by eq / not-null, then answers the table's rows. */
function fakeDb() {
  return {
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = [];
      let max: number | null = null;
      const builder: Record<string, unknown> = {
        select: () => builder,
        order: () => builder,
        eq: (column: string, value: unknown) => {
          const json = /^(\w+)->>(\w+)$/.exec(column);
          filters.push((row) => (json ? String(row[json[1]]?.[json[2]] ?? '') === String(value) : row[column] === value));
          return builder;
        },
        not: (column: string) => {
          filters.push((row) => row[column] != null);
          return builder;
        },
        limit: (count: number) => {
          max = count;
          return builder;
        },
        then: (resolve: (value: unknown) => unknown) => {
          if (mocks.failing.has(table)) {
            return Promise.resolve({ data: null, error: { code: '42P01', message: `relation "${table}" does not exist` } }).then(resolve);
          }
          let rows = (mocks.tables[table] ?? []).filter((row) => filters.every((filter) => filter(row)));
          if (max !== null) rows = rows.slice(0, max);
          return Promise.resolve({ data: rows.map((row) => ({ ...row })), error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
}

const PLATFORM = {
  id: 'acct_1Platform',
  country: 'CA',
  default_currency: 'usd',
  charges_enabled: true,
  payouts_enabled: true,
  business_profile: { name: 'Shop Inc.' },
  settings: {
    dashboard: { display_name: 'Shop' },
    branding: { icon: 'file_123', primary_color: '#112233' },
    payouts: { schedule: { interval: 'daily', delay_days: 2 } },
  },
};

const ALL_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'charge.refunded',
  'charge.dispute.created',
  'charge.dispute.closed',
];

function stripeError(type: string, statusCode: number, message = 'Invalid API Key provided: sk_live_****9999') {
  return Object.assign(new Error(message), { type, statusCode });
}

function fakeStripe() {
  return {
    balance: {
      retrieve: vi.fn(async () => ({
        livemode: false,
        available: [{ amount: 50_000, currency: 'usd', source_types: { card: 12_000, bank_account: 38_000 } }],
        pending: [{ amount: 900, currency: 'usd', source_types: { card: 700 } }],
      })),
    },
    accounts: {
      retrieve: vi.fn(async (id: string | null) => (id === null ? PLATFORM : { id, details_submitted: true })),
      create: vi.fn(),
      createLoginLink: vi.fn(),
    },
    accountLinks: { create: vi.fn() },
    transfers: { create: vi.fn(), list: vi.fn(async () => ({ data: [{ id: 'tr_1' }] })) },
    webhookEndpoints: {
      list: vi.fn(async () => ({
        data: [{ url: 'https://shop.example.com/api/webhooks/stripe/', status: 'enabled', enabled_events: ALL_EVENTS }],
        has_more: false,
      })),
    },
  };
}

let stripe: ReturnType<typeof fakeStripe>;
let warn: ReturnType<typeof vi.spyOn>;

const KEYS = {
  sandbox: false,
  secretKeySource: 'cms',
  storedSecretKeyUnreadable: false,
  mode: 'test',
  restricted: false,
  secretKeyLast4: '4242',
  publishableKeySource: 'cms',
  publishableKeyMode: 'test',
  publishableKeyMatchesMode: true,
  webhookSecretSource: 'cms',
};

beforeEach(() => {
  vi.clearAllMocks();
  stripe = fakeStripe();
  mocks.tables = {
    affiliate_profiles: [{ id: 'a-1', stripe_connect_account_id: 'acct_Partner1', stripe_connect_livemode: false }],
    system_alerts: [],
    affiliate_payout_runs: [],
  };
  mocks.failing.clear();
  mocks.requireCmsAdmin.mockResolvedValue({ supabase: fakeDb(), userId: 'admin-1' });
  mocks.resolve.mockResolvedValue({ ok: true, stripe });
  mocks.keys.mockResolvedValue(KEYS);
  mocks.active.mockResolvedValue(true);
  mocks.settings.mockResolvedValue({ notificationEmails: [], minPayoutCents: 500, autoPayoutsEnabled: true });
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  vi.stubEnv('NEXT_PUBLIC_URL', 'https://shop.example.com');
  vi.stubEnv('CRON_SECRET', '');
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  warn.mockRestore();
});

/** Every Stripe method the fake saw, as `resource.method`. */
function stripeCalls(): string[] {
  const calls: string[] = [];
  for (const [resource, methods] of Object.entries(stripe)) {
    for (const [method, fn] of Object.entries(methods as Record<string, ReturnType<typeof vi.fn>>)) {
      if (fn.mock.calls.length > 0) calls.push(`${resource}.${method}`);
    }
  }
  return calls.sort();
}

function check(result: Awaited<ReturnType<typeof testAffiliateStripeSetupNow>>, id: string) {
  if (!result.ok) throw new Error(`no checks: ${result.reason}`);
  const found = result.checks.find((entry) => entry.id === id);
  if (!found) throw new Error(`no ${id} check`);
  return found;
}

/* --------------------------------------------------------------------- tests --- */

describe('testAffiliateStripeSetupNow on the public sandbox', () => {
  it('asks Stripe nothing: the key belongs to the operator', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    await expect(testAffiliateStripeSetupNow()).resolves.toEqual({ ok: false, reason: 'sandbox' });

    expect(mocks.requireCmsAdmin).toHaveBeenCalledTimes(1);
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.keys).not.toHaveBeenCalled();
    expect(stripeCalls()).toEqual([]);
  });

  it('runs anywhere else (only the exact value "true" is the sandbox)', async () => {
    for (const value of ['', 'false', 'TRUE', '1']) {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      await expect(testAffiliateStripeSetupNow(), value).resolves.toMatchObject({ ok: true });
    }
    expect(mocks.resolve).toHaveBeenCalledTimes(4);
  });
});

describe('testAffiliateStripeSetupNow refusals', () => {
  it('refuses a caller who is not an admin before anything else', async () => {
    mocks.requireCmsAdmin.mockRejectedValueOnce(new Error('Forbidden'));
    await expect(testAffiliateStripeSetupNow()).resolves.toEqual({ ok: false, reason: 'forbidden' });
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('refuses while the program is inactive, and without a Stripe key', async () => {
    mocks.active.mockResolvedValueOnce(false);
    await expect(testAffiliateStripeSetupNow()).resolves.toEqual({ ok: false, reason: 'package_inactive' });

    mocks.resolve.mockResolvedValueOnce({ ok: false, error: 'stripe_not_configured' });
    await expect(testAffiliateStripeSetupNow()).resolves.toEqual({ ok: false, reason: 'stripe_not_configured' });

    mocks.resolve.mockResolvedValueOnce({ ok: false, error: 'unknown' });
    await expect(testAffiliateStripeSetupNow()).resolves.toEqual({ ok: false, reason: 'unavailable' });
    expect(stripeCalls()).toEqual([]);
  });
});

describe('testAffiliateStripeSetupNow checks', () => {
  it('passes a complete setup with read calls only, and says nothing moved', async () => {
    const result = await testAffiliateStripeSetupNow();

    expect(result).toMatchObject({ ok: true, livemode: false, note: AFFILIATE_STRIPE_SETUP_NOTHING_MOVED });
    expect(AFFILIATE_STRIPE_SETUP_NOTHING_MOVED).toBe('Nothing was charged or transferred.');
    expect(result.ok && result.checks.map((entry) => [entry.id, entry.status])).toEqual([
      ['key', 'pass'],
      ['platform', 'pass'],
      ['currency', 'pass'],
      ['webhook', 'pass'],
      ['transfers', 'pass'],
      ['connect', 'pass'],
    ]);
    expect(check(result, 'key').detail).toBe(
      'Stripe accepted the key (test mode, key ending in 4242). Transferable now (card payments): $120.00. Pending: $7.00.'
    );
    expect(check(result, 'platform').detail).toContain('acct_1Platform in Canada, settling in USD. Name: Shop.');
    expect(check(result, 'platform').detail).toContain('Stripe pays your balance out daily, 2 days after each payment.');
    expect(check(result, 'webhook').detail).toBe(
      'An enabled endpoint sends every event orders and commissions need to https://shop.example.com/api/webhooks/stripe.'
    );
    expect(stripeCalls()).toEqual(['accounts.retrieve', 'balance.retrieve', 'transfers.list', 'webhookEndpoints.list']);
    expect(stripe.accounts.retrieve).toHaveBeenCalledWith(null);
    expect(stripe.accounts.retrieve).toHaveBeenCalledWith('acct_Partner1');
    expect(stripe.webhookEndpoints.list).toHaveBeenCalledWith({ limit: 100 });
    expect(stripe.transfers.list).toHaveBeenCalledWith({ limit: 1 });
  });

  it('warns about missing branding, a currency the balance does not hold, missing events, and skips Connect without a partner', async () => {
    stripe.accounts.retrieve.mockImplementation(async (id: string | null) =>
      id === null
        ? { ...PLATFORM, default_currency: 'eur', settings: { payouts: { schedule: { interval: 'manual' } } }, business_profile: null }
        : { id }
    );
    stripe.balance.retrieve.mockResolvedValue({ livemode: false, available: [{ amount: 0, currency: 'eur' }], pending: [] });
    stripe.webhookEndpoints.list.mockResolvedValue({
      data: [{ url: 'https://shop.example.com/api/webhooks/stripe', status: 'enabled', enabled_events: ['checkout.session.completed', 'charge.refunded'] }],
      has_more: false,
    });
    mocks.tables['affiliate_profiles'] = [];

    const result = await testAffiliateStripeSetupNow();

    expect(check(result, 'key')).toMatchObject({ status: 'warn' });
    expect(check(result, 'key').detail).toContain('Nothing can be transferred to partners right now.');
    expect(check(result, 'platform')).toMatchObject({ status: 'warn' });
    expect(check(result, 'platform').detail).toContain(
      'Connect onboarding needs a business name, a brand colour and an icon: add a business name, a brand colour, an icon in the Stripe Dashboard (Settings > Connect > Branding).'
    );
    expect(check(result, 'platform').detail).toContain('only when you pay out yourself (manual payouts)');
    expect(check(result, 'currency')).toMatchObject({ status: 'warn' });
    expect(check(result, 'currency').detail).toContain('Your Stripe account settles in EUR, but commissions are recorded and paid in the store currency, USD');
    expect(check(result, 'currency').detail).toContain('Your Stripe balance holds no USD');
    expect(check(result, 'webhook')).toMatchObject({ status: 'warn' });
    expect(check(result, 'webhook').detail).toContain(
      'misses these events: checkout.session.async_payment_succeeded, checkout.session.async_payment_failed, charge.dispute.created, charge.dispute.closed'
    );
    expect(check(result, 'connect')).toEqual({ id: 'connect', status: 'skip', title: 'Stripe Connect', detail: 'Checked when the first partner connects.' });
  });

  it('accepts an endpoint that sends every event, and warns when none goes to this site', async () => {
    stripe.webhookEndpoints.list.mockResolvedValueOnce({
      data: [{ url: 'https://SHOP.example.com/api/webhooks/stripe', status: 'enabled', enabled_events: ['*'] }],
      has_more: false,
    });
    expect(check(await testAffiliateStripeSetupNow(), 'webhook').status).toBe('pass');

    stripe.webhookEndpoints.list.mockResolvedValueOnce({
      data: [{ url: 'https://other.example.com/api/webhooks/stripe', status: 'enabled', enabled_events: ['*'] }],
      has_more: true,
    });
    const missing = check(await testAffiliateStripeSetupNow(), 'webhook');
    expect(missing.status).toBe('warn');
    expect(missing.detail).toContain('No webhook endpoint in this mode sends to https://shop.example.com/api/webhooks/stripe (the first 100 endpoints were checked).');

    stripe.webhookEndpoints.list.mockResolvedValueOnce({
      data: [{ url: 'https://shop.example.com/api/webhooks/stripe', status: 'disabled', enabled_events: ['*'] }],
    });
    expect(check(await testAffiliateStripeSetupNow(), 'webhook').detail).toContain('is disabled in Stripe');
  });

  it('on a local site skips the webhook check and gives the Stripe CLI command for this address', async () => {
    vi.stubEnv('NEXT_PUBLIC_URL', 'http://localhost:4200');
    const webhook = check(await testAffiliateStripeSetupNow(), 'webhook');
    expect(webhook).toEqual({
      id: 'webhook',
      status: 'skip',
      title: 'Webhook endpoint',
      // The plain CLI command first: the root `npm run stripe` script exists only in the monorepo.
      detail:
        "This site runs at http://localhost:4200, which Stripe can't reach. Forward webhooks with the Stripe CLI: stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,charge.refunded,charge.dispute.created,charge.dispute.closed --forward-to http://localhost:4200/api/webhooks/stripe, then save the whsec_… signing secret it prints as the webhook secret under CMS > Payments.",
    });
    expect(stripe.webhookEndpoints.list).not.toHaveBeenCalled();
  });

  it.each([
    'http://192.168.1.20:4200',
    'http://10.0.0.5:3000',
    'http://172.20.1.4:3000',
    'http://nicks-pc.local:4200',
    'http://0.0.0.0:3000',
    'http://devbox:4200',
    'http://127.0.1.1:4200',
    'https://shop.test',
    'http://[::1]:4200',
  ])('treats %s as a site Stripe cannot reach (no endpoint lookup)', async (site) => {
    vi.stubEnv('NEXT_PUBLIC_URL', site);
    const webhook = check(await testAffiliateStripeSetupNow(), 'webhook');
    expect(webhook.status).toBe('skip');
    expect(webhook.detail).toContain(`This site runs at ${site}, which Stripe can't reach.`);
    expect(webhook.detail).toContain(`stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,charge.refunded,charge.dispute.created,charge.dispute.closed --forward-to ${site}/api/webhooks/stripe`);
    expect(webhook.detail).not.toContain('Add it in the Stripe Dashboard');
    expect(stripe.webhookEndpoints.list).not.toHaveBeenCalled();
  });

  it('without a configured site address names no invented localhost URL', async () => {
    vi.stubEnv('NEXT_PUBLIC_URL', '');
    vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', '');
    vi.stubEnv('NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL', '');
    const webhook = check(await testAffiliateStripeSetupNow(), 'webhook');
    expect(webhook.status).toBe('skip');
    expect(webhook.detail).toBe(
      "No site address is configured (NEXT_PUBLIC_URL), so the endpoint can't be checked. On a public site, set NEXT_PUBLIC_URL to its address. On your own computer, forward webhooks with the Stripe CLI: stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,charge.refunded,charge.dispute.created,charge.dispute.closed --forward-to <this site's address>/api/webhooks/stripe, then save the whsec_… signing secret it prints as the webhook secret under CMS > Payments."
    );
    expect(webhook.detail).not.toContain('localhost:3000');
    expect(stripe.webhookEndpoints.list).not.toHaveBeenCalled();
  });

  it('stops after a key Stripe rejects, without its message', async () => {
    stripe.balance.retrieve.mockRejectedValue(stripeError('StripeAuthenticationError', 401));

    const result = await testAffiliateStripeSetupNow();

    expect(check(result, 'key')).toEqual({
      id: 'key',
      status: 'fail',
      title: 'Stripe key',
      detail: 'Stripe rejected this key. Check the secret key under CMS > Payments.',
    });
    expect(result.ok && result.checks.filter((entry) => entry.status === 'skip').map((entry) => entry.id)).toEqual([
      'platform',
      'currency',
      'webhook',
      'transfers',
      'connect',
    ]);
    expect(stripeCalls()).toEqual(['balance.retrieve']);
    expect(JSON.stringify(result)).not.toMatch(/sk_live|Invalid API Key/);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/sk_live|Invalid API Key/);
  });

  it('names a restricted key without a permission and an unreachable Stripe, check by check', async () => {
    stripe.transfers.list.mockRejectedValue(stripeError('StripePermissionError', 403, 'The provided key rk_live_****1234 does not have access'));
    stripe.webhookEndpoints.list.mockRejectedValue(stripeError('StripeConnectionError', 0, 'connect ETIMEDOUT'));
    stripe.accounts.retrieve.mockImplementation(async (id: string | null) => {
      if (id === null) return PLATFORM;
      throw stripeError('StripePermissionError', 403, 'rk_live_****1234 cannot read accounts');
    });

    const result = await testAffiliateStripeSetupNow();

    expect(check(result, 'transfers')).toMatchObject({
      status: 'fail',
      detail: "This restricted key can't read transfers. Allow it for the key in the Stripe Dashboard (Developers > API keys), or use a standard secret key.",
    });
    expect(check(result, 'webhook')).toMatchObject({ status: 'fail', detail: "Couldn't reach Stripe. Try again in a moment." });
    expect(check(result, 'connect')).toMatchObject({ status: 'fail', detail: expect.stringContaining("This restricted key can't read connected accounts.") });
    expect(JSON.stringify(result)).not.toMatch(/rk_live|ETIMEDOUT/);
  });

  it("warns when one partner's Connect account is unknown in this mode", async () => {
    stripe.accounts.retrieve.mockImplementation(async (id: string | null) => {
      if (id === null) return PLATFORM;
      throw Object.assign(new Error('No such account'), { type: 'StripeInvalidRequestError', code: 'resource_missing', statusCode: 404 });
    });
    expect(check(await testAffiliateStripeSetupNow(), 'connect')).toMatchObject({ status: 'warn' });
  });
});

describe('describeAffiliateStripePayoutSchedule', () => {
  it('reads the schedule Stripe reports', () => {
    expect(describeAffiliateStripePayoutSchedule('manual', 0)).toBe('only when you pay out yourself (manual payouts)');
    expect(describeAffiliateStripePayoutSchedule('weekly', 1)).toBe('weekly, 1 day after each payment');
    expect(describeAffiliateStripePayoutSchedule('monthly', null)).toBe('monthly');
    expect(describeAffiliateStripePayoutSchedule(null, null)).toBe('on a schedule this check could not read');
  });
});

describe('loadAffiliateStripePayoutsOverview', () => {
  const OBLIGATIONS = {
    livemode: false,
    windowDays: 30,
    truncated: false,
    currencies: [
      {
        currency: 'USD',
        owedNowCents: 10_000,
        owedNowStripeCents: 6_000,
        owedNowFreemiusCents: 4_000,
        inFlightCents: 1_000,
        retryingCents: 2_000,
        needsAdminCents: 500,
        clearingSoonCents: 3_000,
        lastWindowCents: 9_000,
      },
    ],
  };

  const PLATFORM_INFO = {
    stripeConfigured: true,
    sandbox: false,
    platformCountry: 'CA',
    platformDefaultCurrency: 'USD',
    storeBaseCurrency: 'USD',
    currencyMismatch: false,
    livemode: false,
    available: [{ currency: 'USD', amount: 20_000 }],
    transferable: [{ currency: 'USD', amount: 8_000 }],
    pending: [{ currency: 'USD', amount: 1_500 }],
    error: null,
  };

  beforeEach(() => {
    mocks.obligations.mockResolvedValue(OBLIGATIONS);
    mocks.platformInfo.mockResolvedValue(PLATFORM_INFO);
  });

  it('compares what is owed with the transferable balance, in the key mode, and reads the payout schedule fresh', async () => {
    vi.stubEnv('CRON_SECRET', 'x'.repeat(16));
    mocks.tables['system_alerts'] = [
      {
        id: 'alert-1',
        alert_type: 'affiliate_payout_failed',
        is_resolved: false,
        title: 'Stripe Connect refused a partner’s payout setup',
        message: 'Stripe refused the Express account creation (stripe_invalid_request)…',
        metadata: { kind: 'connect_setup', stripe_code: 'stripe_invalid_request', step: 'account_creation' },
        created_at: '2026-11-10T08:00:00.000Z',
      },
    ];
    // A stored summary as saveRun writes it: the latest call's own counts beside the day's totals.
    mocks.tables['affiliate_payout_runs'] = [
      {
        run_date: '2026-11-10',
        trigger: 'cron',
        finished_at: '2026-11-10T06:00:40.000Z',
        summary: {
          trigger: 'cron',
          startedAt: '2026-11-10T06:00:00.000Z',
          sent: 1,
          failed: 0,
          remaining: 2,
          aborted: 'stripe_unavailable',
          totals: { sent: 3, failed: 1 },
        },
      },
    ];

    const overview = await loadAffiliateStripePayoutsOverview(new Date('2026-11-10T12:00:00.000Z'));

    expect(mocks.obligations).toHaveBeenCalledWith(expect.anything(), {
      livemode: false,
      automatedPayoutsRunning: true,
      now: new Date('2026-11-10T12:00:00.000Z'),
      // Settings without payoutMethods pay every gateway through Stripe (02036).
      gateways: ['STRIPE', 'FREEMIUS'],
    });
    expect(overview.funding).toMatchObject({ livemode: false, modeSource: 'stripe', stripeFigures: true });
    expect(overview.funding?.rows).toEqual([
      {
        ...OBLIGATIONS.currencies[0],
        neededCents: 10_000 + 2_000 + 500 + 3_000,
        transferableCents: 8_000,
        pendingCents: 1_500,
        shortCents: 15_500 - 8_000 - 1_500,
      },
    ]);
    expect(overview.schedule).toEqual({ interval: 'daily', delayDays: 2 });
    expect(overview.keys).toEqual(KEYS);
    expect(overview.automation).toMatchObject({
      cronSecretConfigured: true,
      cronSecretTooShort: false,
      nextScheduledRunAt: '2026-11-11T06:00:00.000Z',
      returnUrl: 'https://shop.example.com/portal/retailer/payouts?connected=1',
      siteUrlConfigured: true,
      webhookUrl: 'https://shop.example.com/api/webhooks/stripe',
      webhookReachable: true,
    });
    // The day's totals, and where the latest call stopped (remaining, aborted).
    expect(overview.automation.lastRun).toEqual({
      runDate: '2026-11-10',
      trigger: 'cron',
      finishedAt: '2026-11-10T06:00:40.000Z',
      sent: 3,
      failed: 1,
      remaining: 2,
      aborted: 'stripe_unavailable',
    });
    expect(overview.connectAlert).toMatchObject({ id: 'alert-1', stripeCode: 'stripe_invalid_request', step: 'account_creation' });
    // Only reads reached Stripe.
    expect(stripeCalls()).toEqual(['accounts.retrieve']);
  });

  it('leaves the gateways paid by hand out of the Stripe figures, and counts every gateway when the settings are unknown (02036)', async () => {
    mocks.settings.mockResolvedValueOnce({
      notificationEmails: [],
      minPayoutCents: 500,
      autoPayoutsEnabled: true,
      payoutMethods: { stripeSales: 'stripe_connect', freemiusSales: 'manual' },
    });
    mocks.obligations.mockResolvedValueOnce({
      ...OBLIGATIONS,
      currencies: [{ ...OBLIGATIONS.currencies[0], owedNowCents: 6_000, owedNowFreemiusCents: 0, owedManuallyCents: 4_000 }],
    });

    const overview = await loadAffiliateStripePayoutsOverview();

    expect(mocks.obligations.mock.calls[0][1]).toMatchObject({ gateways: ['STRIPE'] });
    expect(overview.funding?.rows[0]).toMatchObject({ owedManuallyCents: 4_000, neededCents: 6_000 + 2_000 + 500 + 3_000 });

    mocks.settings.mockRejectedValueOnce(new Error('settings down'));
    await loadAffiliateStripePayoutsOverview();
    expect(mocks.obligations.mock.calls[1][1]).toMatchObject({ gateways: null });
  });

  it('counts no failed transfer as retrying once every gateway is paid by hand (the daily run then retries nothing)', async () => {
    mocks.settings.mockResolvedValueOnce({
      notificationEmails: [],
      minPayoutCents: 500,
      autoPayoutsEnabled: true,
      payoutMethods: { stripeSales: 'manual', freemiusSales: 'manual' },
    });
    await loadAffiliateStripePayoutsOverview();
    expect(mocks.obligations.mock.calls[0][1]).toMatchObject({ gateways: [], automatedPayoutsRunning: false });

    mocks.settings.mockResolvedValueOnce({
      notificationEmails: [],
      minPayoutCents: 500,
      autoPayoutsEnabled: true,
      payoutMethods: { stripeSales: 'stripe_connect', freemiusSales: 'manual' },
    });
    await loadAffiliateStripePayoutsOverview();
    expect(mocks.obligations.mock.calls[1][1]).toMatchObject({ gateways: ['STRIPE'], automatedPayoutsRunning: true });
  });

  it('falls back to the key prefix for the mode, and shows the base currency even with nothing owed', async () => {
    mocks.platformInfo.mockResolvedValue({ ...PLATFORM_INFO, livemode: null, transferable: null, pending: null, error: 'stripe_unavailable' });
    mocks.keys.mockResolvedValue({ ...KEYS, mode: 'live' });
    mocks.obligations.mockResolvedValue({ ...OBLIGATIONS, livemode: true, currencies: [] });

    const overview = await loadAffiliateStripePayoutsOverview();

    expect(mocks.obligations.mock.calls[0][1]).toMatchObject({ livemode: true });
    expect(overview.funding).toMatchObject({ livemode: true, modeSource: 'key', stripeFigures: false });
    expect(overview.funding?.rows).toEqual([
      expect.objectContaining({ currency: 'USD', neededCents: 0, transferableCents: null, pendingCents: null, shortCents: null }),
    ]);
  });

  it('on the sandbox shows the ledger but no Stripe figure, and asks Stripe nothing', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    mocks.platformInfo.mockResolvedValue({ ...PLATFORM_INFO, sandbox: true, stripeConfigured: false, livemode: null, transferable: null, pending: null });
    mocks.keys.mockResolvedValue({ ...KEYS, sandbox: true, mode: null, secretKeyLast4: null });

    const overview = await loadAffiliateStripePayoutsOverview();

    expect(overview.sandbox).toBe(true);
    expect(overview.schedule).toBeNull();
    expect(overview.funding).toMatchObject({ stripeFigures: false, modeSource: 'default', livemode: true });
    expect(overview.funding?.rows[0]).toMatchObject({ transferableCents: null, shortCents: null, owedNowCents: 10_000 });
    expect(mocks.obligations.mock.calls[0][1]).toMatchObject({ automatedPayoutsRunning: false });
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(stripeCalls()).toEqual([]);
  });

  it('tells no run yet apart from a run table it could not read', async () => {
    expect((await loadAffiliateStripePayoutsOverview()).automation.lastRun).toBeNull();

    mocks.failing.add('affiliate_payout_runs');
    expect((await loadAffiliateStripePayoutsOverview()).automation.lastRun).toBe('unavailable');
  });

  it('flags a CRON_SECRET too short for the payout route, and a local site Stripe cannot send webhooks to', async () => {
    vi.stubEnv('CRON_SECRET', 'short-secret');
    vi.stubEnv('NEXT_PUBLIC_URL', 'http://192.168.1.20:4200');

    const { automation } = await loadAffiliateStripePayoutsOverview();

    expect(automation).toMatchObject({
      cronSecretConfigured: false,
      cronSecretTooShort: true,
      webhookUrl: 'http://192.168.1.20:4200/api/webhooks/stripe',
      webhookReachable: false,
    });
    expect(JSON.stringify(automation)).not.toContain('short-secret');
  });

  it('keeps rendering when the ledger cannot be read, and refuses a non-admin', async () => {
    mocks.obligations.mockRejectedValue(Object.assign(new Error('Could not read payouts.'), { cause: { code: '42P01' } }));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(loadAffiliateStripePayoutsOverview()).resolves.toMatchObject({ funding: null });
    errorLog.mockRestore();

    mocks.requireCmsAdmin.mockRejectedValueOnce(new Error('Forbidden'));
    await expect(loadAffiliateStripePayoutsOverview()).rejects.toThrow('Forbidden');
  });
});
