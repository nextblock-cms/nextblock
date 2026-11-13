import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The partner portal's Stripe Connect service (ADDENDUM B3) with the lib's real Connect helpers
 * against a fake Stripe and a fake profiles table: sandbox and configuration refusals, the
 * partner row re-read by id and user id, the Express account parameters, the return / refresh
 * URLs from the site address, readiness only from accounts.retrieve with the one-time
 * PAYOUT_CONFIGURED notice, and the two link kinds.
 */

type Row = Record<string, any>;

const mocks = vi.hoisted(() => ({
  db: null as any,
  stripe: null as any,
  getStripeClient: vi.fn(),
  notify: vi.fn(),
  scheduled: [] as Array<() => unknown>,
}));

vi.mock('@nextblock-cms/db/server', () => ({
  getServiceRoleSupabaseClient: () => mocks.db,
  verifyPackageOnline: vi.fn(async () => true),
}));

vi.mock('@nextblock-cms/ecommerce/server', () => ({
  getStripeClient: mocks.getStripeClient,
  StripeNotConfiguredError: class StripeNotConfiguredError extends Error {},
}));

vi.mock('@nextblock-cms/affiliates', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/core/constants')),
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/core/money')),
}));

vi.mock('@nextblock-cms/affiliates/server', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/repository/index')),
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/payouts/index')),
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/connect/index')),
}));

vi.mock('../auth/cms-actor', () => ({ requireCmsAdmin: vi.fn() }));
vi.mock('./settings', () => ({ getAffiliatesSettings: vi.fn(), readAffiliatesSettingsStrict: vi.fn() }));
vi.mock('./notify', () => ({
  notifyAffiliateLifecycle: mocks.notify,
  sweepAffiliateCommissionNotifications: vi.fn(),
  sweepAffiliateRefundAlertEmails: vi.fn(),
  scheduleAffiliateNotification: (task: () => unknown) => {
    mocks.scheduled.push(task);
  },
}));

import type { RetailerActor } from './retailer-actor';
import {
  createAffiliateConnectRefreshLink,
  createAffiliateExpressDashboardLink,
  getAffiliateConnectCountryOptions,
  isAffiliateConnectConfigured,
  refreshAffiliateConnectStatus,
  startAffiliateConnectOnboarding,
} from './connect-service';

/* ------------------------------------------------------------------ fakes --- */

/** A column, or a `metadata->>key` JSON path (read as text, like PostgREST). */
function readPath(row: Row, column: string): unknown {
  const json = /^(\w+)->>(\w+)$/.exec(column);
  if (json) {
    const value = row[json[1]]?.[json[2]];
    return value == null ? null : String(value);
  }
  return row[column];
}

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private readonly filters: Array<(row: Row) => boolean> = [];
  private values: Row | null = null;
  private inserted: Row | null = null;
  private returning = false;
  private single = false;
  private max: number | null = null;

  constructor(
    private readonly db: FakeDb,
    private readonly table: 'affiliate_profiles' | 'system_alerts' = 'affiliate_profiles'
  ) {}

  select() {
    if (this.values) this.returning = true;
    return this;
  }
  update(values: Row) {
    this.values = values;
    return this;
  }
  insert(values: Row) {
    this.inserted = values;
    return this;
  }
  limit(count: number) {
    this.max = count;
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push((row) => readPath(row, column) === value);
    return this;
  }
  is(column: string, value: null) {
    this.filters.push((row) => (value === null ? row[column] == null : row[column] === value));
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }
  then<T1 = { data: unknown; error: unknown }, T2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null
  ): PromiseLike<T1 | T2> {
    const rows = this.table === 'system_alerts' ? this.db.alerts : this.db.profiles;
    if (this.inserted) {
      rows.push({ id: `alert-${rows.length + 1}`, is_resolved: false, ...this.inserted });
      return Promise.resolve({ data: null, error: null }).then(onfulfilled, onrejected);
    }
    let matched = rows.filter((row) => this.filters.every((filter) => filter(row)));
    if (this.max !== null) matched = matched.slice(0, this.max);
    let result: { data: unknown; error: unknown };
    if (this.values) {
      for (const row of matched) Object.assign(row, this.values);
      result = { data: this.returning ? matched.map((row) => ({ ...row })) : null, error: null };
    } else {
      const copies = matched.map((row) => ({ ...row }));
      result = { data: this.single ? (copies[0] ?? null) : copies, error: null };
    }
    return Promise.resolve(result).then(onfulfilled, onrejected);
  }
}

class FakeDb {
  profiles: Row[] = [];
  alerts: Row[] = [];
  alertsUnavailable = false;
  from(table: string) {
    if (table === 'system_alerts') {
      if (this.alertsUnavailable) throw new Error('system_alerts unreachable');
      return new FakeQuery(this, 'system_alerts');
    }
    if (table !== 'affiliate_profiles') throw new Error(`unexpected table ${table}`);
    return new FakeQuery(this);
  }
}

function stripeError(type: string, code: string | null, statusCode: number) {
  return Object.assign(new Error(code ?? type), { type, code: code ?? undefined, statusCode });
}

function fakeStripe() {
  const connected = new Map<string, Row>();
  let sequence = 0;
  const stripe = {
    livemode: false,
    connected,
    balance: { retrieve: vi.fn(async () => ({ livemode: stripe.livemode, available: [] })) },
    accounts: {
      retrieve: vi.fn(async (id: string | null) => {
        if (id === null) return { id: 'acct_platform', country: 'CA', default_currency: 'cad' };
        const account = connected.get(id);
        if (!account) throw stripeError('StripeInvalidRequestError', 'resource_missing', 404);
        return account;
      }),
      create: vi.fn(async (params: Row) => {
        const account = { id: `acct_Partner${++sequence}`, country: params['country'], details_submitted: false, payouts_enabled: false };
        connected.set(account.id, account);
        return account;
      }),
      createLoginLink: vi.fn(async (id: string) => ({ url: `https://connect.stripe.com/express/${id}/login` })),
    },
    accountLinks: { create: vi.fn(async (params: Row) => ({ url: `https://connect.stripe.com/setup/e/${params['account']}/link` })) },
    transfers: { create: vi.fn(), list: vi.fn(async () => ({ data: [] })) },
  };
  return stripe;
}

const USER_ID = '2f0e9a6c-8f4b-4f0a-9c55-3c0a5f9a1b11';
const AFFILIATE_ID = '5b1d3c3e-61d4-4c2c-9a8f-0f6b0e9b7a22';

function addPartner(overrides: Row = {}): Row {
  const row: Row = {
    id: AFFILIATE_ID,
    user_id: USER_ID,
    tier_id: 'tier',
    handle: 'jane-picks',
    display_name: 'Jane',
    status: 'ACTIVE',
    social_links: {},
    preferred_locale: 'en',
    stripe_connect_account_id: null,
    stripe_connect_livemode: null,
    stripe_connect_onboarding_complete: false,
    stripe_connect_details_submitted: false,
    stripe_connect_payouts_enabled: false,
    stripe_connect_checked_at: null,
    payout_configured_at: null,
    first_published_at: null,
    created_at: '2026-10-27T00:00:00.000Z',
    updated_at: '2026-10-27T00:00:00.000Z',
    ...overrides,
  };
  mocks.db.profiles.push(row);
  return row;
}

function actorFor(profile: Row, overrides: Partial<RetailerActor> = {}): RetailerActor {
  return {
    userId: USER_ID,
    email: 'jane@example.org',
    role: 'RTL',
    affiliate: { ...profile } as RetailerActor['affiliate'],
    page: null,
    ...overrides,
  };
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mocks.db = new FakeDb();
  mocks.stripe = fakeStripe();
  mocks.scheduled = [];
  mocks.notify.mockReset();
  mocks.getStripeClient.mockReset();
  mocks.getStripeClient.mockImplementation(async () => mocks.stripe);
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  vi.stubEnv('NEXT_PUBLIC_URL', 'https://shop.example.org');
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  warn.mockRestore();
});

/* ------------------------------------------------------------------ tests --- */

describe('refusals', () => {
  it('is disabled in the sandbox (no Stripe call at all)', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const actor = actorFor(addPartner());
    await expect(startAffiliateConnectOnboarding(actor, { country: 'CA' })).resolves.toEqual({ ok: false, error: 'sandbox' });
    await expect(refreshAffiliateConnectStatus(actor)).resolves.toEqual({ ok: false, error: 'sandbox' });
    await expect(createAffiliateConnectRefreshLink(actor)).resolves.toEqual({ ok: false, error: 'sandbox' });
    await expect(createAffiliateExpressDashboardLink(actor)).resolves.toEqual({ ok: false, error: 'sandbox' });
    await expect(getAffiliateConnectCountryOptions()).resolves.toMatchObject({ platformCountry: null });
    expect(mocks.getStripeClient).not.toHaveBeenCalled();
  });

  it('reports a missing Stripe key', async () => {
    mocks.getStripeClient.mockRejectedValue(Object.assign(new Error('not configured'), { name: 'StripeNotConfiguredError' }));
    await expect(startAffiliateConnectOnboarding(actor_(), { country: 'CA' })).resolves.toEqual({
      ok: false,
      error: 'stripe_not_configured',
    });
  });

  it('tells the payouts page whether bank payouts can be connected at all', async () => {
    await expect(isAffiliateConnectConfigured()).resolves.toBe(true);

    // No Stripe key: the page says payouts are not available yet instead of offering the button.
    mocks.getStripeClient.mockRejectedValue(Object.assign(new Error('not configured'), { name: 'StripeNotConfiguredError' }));
    await expect(isAffiliateConnectConfigured()).resolves.toBe(false);

    // Any other failure may be transient: the button stays (a click reports connect_unavailable).
    mocks.getStripeClient.mockRejectedValue(new Error('site_settings unreachable'));
    await expect(isAffiliateConnectConfigured()).resolves.toBe(true);

    // The sandbox has its own notice and never asks Stripe.
    mocks.getStripeClient.mockClear();
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    await expect(isAffiliateConnectConfigured()).resolves.toBe(true);
    expect(mocks.getStripeClient).not.toHaveBeenCalled();
  });

  it('refuses a suspended partner and an actor whose row is not theirs', async () => {
    const suspended = addPartner({ status: 'SUSPENDED' });
    await expect(startAffiliateConnectOnboarding(actorFor(suspended), {})).resolves.toEqual({ ok: false, error: 'suspended' });

    await expect(
      startAffiliateConnectOnboarding(actorFor(suspended, { userId: '9d1f0a3e-0000-4000-8000-000000000000' }), {})
    ).resolves.toEqual({ ok: false, error: 'unknown' });
    await expect(startAffiliateConnectOnboarding(actorFor(suspended, { affiliate: null }), {})).resolves.toEqual({ ok: false, error: 'unknown' });
    expect(mocks.stripe.accounts.create).not.toHaveBeenCalled();
  });

  it('refuses an unsupported country without creating an account', async () => {
    await expect(startAffiliateConnectOnboarding(actor_(), { country: 'KP' })).resolves.toEqual({ ok: false, error: 'unknown' });
    expect(mocks.stripe.accounts.create).not.toHaveBeenCalled();
  });
});

function actor_() {
  return actorFor(addPartner());
}

describe('startAffiliateConnectOnboarding', () => {
  it('creates the Express account (platform country by default) and returns the Stripe onboarding URL', async () => {
    const partner = addPartner();
    const result = await startAffiliateConnectOnboarding(actorFor(partner), {});

    expect(result).toEqual({ ok: true, url: 'https://connect.stripe.com/setup/e/acct_Partner1/link' });
    expect(mocks.stripe.accounts.create).toHaveBeenCalledWith(
      {
        type: 'express',
        country: 'CA',
        email: 'jane@example.org',
        capabilities: { transfers: { requested: true } },
        business_profile: {
          url: 'https://shop.example.org/partners/jane-picks',
          product_description: 'Affiliate partner earning referral commissions from shop.example.org',
        },
        metadata: { affiliate_id: AFFILIATE_ID },
      },
      { idempotencyKey: `affiliate-connect-${AFFILIATE_ID}` }
    );
    expect(mocks.stripe.accountLinks.create).toHaveBeenCalledWith({
      account: 'acct_Partner1',
      refresh_url: 'https://shop.example.org/portal/retailer/payouts/connect/refresh',
      return_url: 'https://shop.example.org/portal/retailer/payouts?connected=1',
      type: 'account_onboarding',
    });
    expect(partner).toMatchObject({ stripe_connect_account_id: 'acct_Partner1', stripe_connect_livemode: false });
  });

  it('opens a cross-border account with the recipient agreement and reuses it afterwards', async () => {
    const partner = addPartner();
    await startAffiliateConnectOnboarding(actorFor(partner), { country: 'fr' });
    expect(mocks.stripe.accounts.create.mock.calls[0][0]).toMatchObject({ country: 'FR', tos_acceptance: { service_agreement: 'recipient' } });

    await startAffiliateConnectOnboarding(actorFor(partner), { country: 'FR' });
    expect(mocks.stripe.accounts.create).toHaveBeenCalledTimes(1);
    expect(mocks.stripe.accountLinks.create).toHaveBeenCalledTimes(2);
  });

  it('leaves the storefront URL out while the site address is local', async () => {
    vi.stubEnv('NEXT_PUBLIC_URL', 'http://localhost:4200');
    await startAffiliateConnectOnboarding(actor_(), {});
    expect(mocks.stripe.accounts.create.mock.calls[0][0]['business_profile']).toEqual({
      product_description: 'Affiliate partner earning referral commissions from localhost:4200',
    });
  });

  it('maps a Stripe refusal to connect_unavailable and anything else to unknown', async () => {
    mocks.stripe.accounts.create.mockRejectedValueOnce(stripeError('StripeInvalidRequestError', null, 400));
    await expect(startAffiliateConnectOnboarding(actor_(), {})).resolves.toEqual({ ok: false, error: 'connect_unavailable' });

    mocks.db = new FakeDb();
    mocks.stripe.accounts.create.mockRejectedValueOnce(stripeError('StripeConnectionError', null, 0));
    await expect(startAffiliateConnectOnboarding(actor_(), {})).resolves.toEqual({ ok: false, error: 'unknown' });
  });
});

describe('refreshAffiliateConnectStatus', () => {
  it('reads readiness from Stripe and notifies the admins the first time only', async () => {
    const partner = addPartner({ stripe_connect_account_id: 'acct_Ready', stripe_connect_livemode: false });
    mocks.stripe.connected.set('acct_Ready', {
      id: 'acct_Ready',
      details_submitted: true,
      payouts_enabled: true,
      capabilities: { transfers: 'active' },
      requirements: { currently_due: [], past_due: [] },
    });

    const first = await refreshAffiliateConnectStatus(actorFor(partner));
    expect(first).toMatchObject({ ok: true, status: { ready: true, hasAccount: true } });
    expect(partner['stripe_connect_onboarding_complete']).toBe(true);
    expect(mocks.scheduled).toHaveLength(1);
    await mocks.scheduled[0]();
    expect(mocks.notify).toHaveBeenCalledWith('PAYOUT_CONFIGURED', { affiliateId: AFFILIATE_ID });

    await refreshAffiliateConnectStatus(actorFor(partner));
    expect(mocks.scheduled).toHaveLength(1);
  });

  it('reports an account without a partner as not connected', async () => {
    await expect(refreshAffiliateConnectStatus(actor_())).resolves.toMatchObject({ ok: true, status: { hasAccount: false, ready: false } });
  });

  it('reports an account of the other key mode as a mismatch', async () => {
    mocks.stripe.livemode = true;
    const partner = addPartner({ stripe_connect_account_id: 'acct_Test', stripe_connect_livemode: false });
    await expect(refreshAffiliateConnectStatus(actorFor(partner))).resolves.toMatchObject({
      ok: true,
      status: { livemodeMismatch: true, ready: false },
    });
  });
});

describe('links', () => {
  it('mints a fresh onboarding link for the refresh route, or says there is no account', async () => {
    await expect(createAffiliateConnectRefreshLink(actor_())).resolves.toEqual({ ok: false, error: 'no_account' });

    mocks.db = new FakeDb();
    const partner = addPartner({ stripe_connect_account_id: 'acct_Known', stripe_connect_livemode: false });
    await expect(createAffiliateConnectRefreshLink(actorFor(partner))).resolves.toEqual({
      ok: true,
      url: 'https://connect.stripe.com/setup/e/acct_Known/link',
    });
  });

  it('opens the Express dashboard once details are submitted', async () => {
    const partner = addPartner({ stripe_connect_account_id: 'acct_Known', stripe_connect_livemode: false });
    await expect(createAffiliateExpressDashboardLink(actorFor(partner))).resolves.toEqual({ ok: false, error: 'not_ready' });

    partner['stripe_connect_details_submitted'] = true;
    await expect(createAffiliateExpressDashboardLink(actorFor(partner))).resolves.toEqual({
      ok: true,
      url: 'https://connect.stripe.com/express/acct_Known/login',
    });
  });
});

describe('getAffiliateConnectCountryOptions', () => {
  it("offers the supported countries, localized, with the platform's country as the default", async () => {
    const options = await getAffiliateConnectCountryOptions('fr');
    expect(options.platformCountry).toBe('CA');
    expect(options.countries.find((country) => country.code === 'DE')?.name).toBe('Allemagne');
    expect(options.countries.some((country) => country.code === 'US')).toBe(true);
  });
});

describe('the Connect setup alert', () => {
  const TODAY = () => new Date().toISOString().slice(0, 10);

  function connectRefusal() {
    // Stripe's message names the problem; only the code may reach the alert.
    return Object.assign(new Error("You can only create new accounts if you've signed up for Connect"), {
      type: 'StripeInvalidRequestError',
      statusCode: 400,
    });
  }

  it('raises one admin alert a day for a Stripe refusal, with the step and the code, never the message', async () => {
    const actor = actorFor(addPartner());
    mocks.stripe.accounts.create.mockRejectedValue(connectRefusal());

    await expect(startAffiliateConnectOnboarding(actor, {})).resolves.toEqual({ ok: false, error: 'connect_unavailable' });

    expect(mocks.db.alerts).toHaveLength(1);
    expect(mocks.db.alerts[0]).toMatchObject({
      alert_type: 'affiliate_payout_failed',
      title: 'Stripe Connect refused a partner’s payout setup',
      metadata: {
        kind: 'connect_setup',
        alert_date: TODAY(),
        step: 'account_creation',
        stripe_code: 'stripe_invalid_request',
        first_affiliate_id: AFFILIATE_ID,
        action_url: '/cms/affiliates/stripe',
        action_label: 'Open Stripe payouts',
      },
    });
    // A platform alert: never keyed on the partner (removing them must not close it).
    expect(mocks.db.alerts[0]['metadata']).not.toHaveProperty('affiliate_id');
    expect(mocks.db.alerts[0]['message']).toBe(
      'Stripe refused the Express account creation (stripe_invalid_request), so a partner could not set up payouts. In the Stripe Dashboard, check that Connect is enabled, the platform profile is complete, Connect branding (business name, colour and icon) is set, Accounts v1 support is turned on, and the partner’s country is among the countries allowed for Express onboarding.'
    );
    expect(JSON.stringify(mocks.db.alerts)).not.toContain('signed up for Connect');

    // The same day: no second alert while the first is open.
    await expect(startAffiliateConnectOnboarding(actor, {})).resolves.toEqual({ ok: false, error: 'connect_unavailable' });
    expect(mocks.db.alerts).toHaveLength(1);

    // Marked done: the next refusal raises a fresh one.
    mocks.db.alerts[0]['is_resolved'] = true;
    await startAffiliateConnectOnboarding(actor, {});
    expect(mocks.db.alerts).toHaveLength(2);
  });

  it('names the onboarding-link step too, and sends a restricted key to its permissions', async () => {
    mocks.stripe.accountLinks.create.mockRejectedValueOnce(stripeError('StripePermissionError', null, 403));
    await expect(startAffiliateConnectOnboarding(actor_(), {})).resolves.toEqual({ ok: false, error: 'connect_unavailable' });
    expect(mocks.db.alerts[0]['metadata']).toMatchObject({ step: 'onboarding_link', stripe_code: 'stripe_permission' });
    // No Dashboard setting fixes a 403: the key's permissions do.
    expect(mocks.db.alerts[0]['message']).toBe(
      'Stripe refused the onboarding link (stripe_permission), so a partner could not set up payouts. This restricted key lacks a permission Connect needs: allow Balance (read), Accounts and Account links (write) and Login links (write) for it in the Stripe Dashboard (Developers > API keys), or use a standard secret key.'
    );
  });

  it('raises none for a transient failure, or on the sandbox', async () => {
    mocks.stripe.accounts.create.mockRejectedValueOnce(stripeError('StripeConnectionError', null, 0));
    await expect(startAffiliateConnectOnboarding(actor_(), {})).resolves.toEqual({ ok: false, error: 'unknown' });

    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    mocks.stripe.accounts.create.mockRejectedValue(connectRefusal());
    await expect(startAffiliateConnectOnboarding(actor_(), {})).resolves.toEqual({ ok: false, error: 'sandbox' });
    expect(mocks.db.alerts).toEqual([]);
  });

  it('answers the same when the alert cannot be written', async () => {
    mocks.db.alertsUnavailable = true;
    mocks.stripe.accounts.create.mockRejectedValueOnce(connectRefusal());
    await expect(startAffiliateConnectOnboarding(actor_(), {})).resolves.toEqual({ ok: false, error: 'connect_unavailable' });
  });
});

describe('partner countries follow where Stripe can transfer', () => {
  it('offers a platform in the cross-border region (US, CA, GB, EEA, CH) that region only', async () => {
    const options = await getAffiliateConnectCountryOptions('en');
    const codes = options.countries.map((country) => country.code);
    expect(options.platformCountry).toBe('CA');
    for (const code of ['CA', 'US', 'GB', 'FR', 'DE', 'CH', 'NO']) expect(codes, code).toContain(code);
    for (const code of ['AU', 'JP', 'SG', 'MX', 'BR', 'HK']) expect(codes, code).not.toContain(code);
  });

  it("offers a platform outside the region only its own country", async () => {
    mocks.stripe.accounts.retrieve.mockImplementation(async (id: string | null) => {
      if (id === null) return { id: 'acct_platform', country: 'AU', default_currency: 'aud' };
      throw stripeError('StripeInvalidRequestError', 'resource_missing', 404);
    });
    const options = await getAffiliateConnectCountryOptions('en');
    expect(options.platformCountry).toBe('AU');
    expect(options.countries.map((country) => country.code)).toEqual(['AU']);
  });

  it('keeps every supported country while the platform country is unknown, or Stripe cannot be asked', async () => {
    mocks.stripe.accounts.retrieve.mockImplementation(async () => ({ id: 'acct_platform', country: null }));
    const unknown = await getAffiliateConnectCountryOptions('en');
    expect(unknown.platformCountry).toBeNull();
    expect(unknown.countries).toHaveLength(44);

    mocks.getStripeClient.mockRejectedValue(Object.assign(new Error('not configured'), { name: 'StripeNotConfiguredError' }));
    await expect(getAffiliateConnectCountryOptions('en')).resolves.toMatchObject({ platformCountry: null, countries: expect.arrayContaining([expect.objectContaining({ code: 'JP' })]) });
  });

  it('refuses to open an account in a country the platform cannot pay', async () => {
    await expect(startAffiliateConnectOnboarding(actor_(), { country: 'JP' })).resolves.toEqual({ ok: false, error: 'unknown' });
    expect(mocks.stripe.accounts.create).not.toHaveBeenCalled();
    expect(mocks.db.alerts).toEqual([]);
  });
});
