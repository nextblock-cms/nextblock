import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AffiliateRepositoryClient } from '../repository/client';
import type { AffiliateStripeAccountCreateParams, AffiliateStripeAccountLike, AffiliatesStripeLike } from '../payouts/stripe-like';
import {
  affiliateConnectIdempotencyKey,
  buildAffiliateExpressAccountParams,
  createAffiliateExpressDashboardLink,
  createAffiliateOnboardingLink,
  ensureAffiliateExpressAccount,
  getAffiliatePlatformAccountInfo,
} from './accounts';
import {
  AFFILIATE_CONNECT_COUNTRY_CODES,
  AFFILIATE_CONNECT_CROSS_BORDER_COUNTRY_CODES,
  filterAffiliateConnectCountriesForPlatform,
  isAffiliateConnectCountryAllowedForPlatform,
  isAffiliateConnectCrossBorderCountry,
  listAffiliateConnectCountryOptions,
  normalizeAffiliateConnectCountry,
} from './countries';
import { evaluateAffiliateConnectAccount, syncAffiliateConnectStatus } from './status';

/**
 * Stripe Connect Express for partners (ADDENDUM B3): one idempotent account per partner, stored
 * with a conditional update; readiness only from accounts.retrieve; the key mode tracked so an
 * account of the other mode means re-onboarding.
 */

type Row = Record<string, any>;

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private readonly filters: Array<(row: Row) => boolean> = [];
  private values: Row | null = null;
  private returning = false;
  private single = false;

  constructor(private readonly db: FakeDb) {}

  select() {
    if (this.values) this.returning = true;
    return this;
  }
  update(values: Row) {
    this.values = values;
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value);
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
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
  private run() {
    if (this.db.failWrites && this.values) return { data: null, error: { message: 'write failed', code: 'XX000' } };
    const matched = this.db.profiles.filter((row) => this.filters.every((filter) => filter(row)));
    if (this.values) {
      this.db.updates.push({ ...this.values });
      if (this.db.beforeUpdate) {
        const hook = this.db.beforeUpdate;
        this.db.beforeUpdate = null;
        hook();
        const rematched = this.db.profiles.filter((row) => this.filters.every((filter) => filter(row)));
        for (const row of rematched) Object.assign(row, this.values);
        return { data: this.returning ? rematched.map((row) => ({ ...row })) : null, error: null };
      }
      for (const row of matched) Object.assign(row, this.values);
      return { data: this.returning ? matched.map((row) => ({ ...row })) : null, error: null };
    }
    const copies = matched.map((row) => ({ ...row }));
    return { data: this.single ? (copies[0] ?? null) : copies, error: null };
  }
}

class FakeDb {
  profiles: Row[] = [];
  updates: Row[] = [];
  failWrites = false;
  /** Runs once, right before the next update matches rows (a concurrent request). */
  beforeUpdate: (() => void) | null = null;
  from(table: string) {
    if (table !== 'affiliate_profiles') throw new Error(`unexpected table ${table}`);
    return new FakeQuery(this);
  }
}

function stripeError(code: string, statusCode: number) {
  return Object.assign(new Error(code), { type: 'StripeInvalidRequestError', code, statusCode });
}

class FakeStripe implements AffiliatesStripeLike {
  livemode = false;
  platform: AffiliateStripeAccountLike = { id: 'acct_platform', country: 'CA', default_currency: 'cad' };
  readonly accountsById = new Map<string, AffiliateStripeAccountLike>();
  readonly creates: Array<{ params: AffiliateStripeAccountCreateParams; idempotencyKey?: string }> = [];
  private readonly byKey = new Map<string, AffiliateStripeAccountLike>();
  private sequence = 0;
  linkUrl = 'https://connect.stripe.com/setup/e/acct_x/abc';

  balance = { retrieve: async () => ({ livemode: this.livemode, available: [] }) };

  accounts = {
    retrieve: vi.fn(async (id: string | null): Promise<AffiliateStripeAccountLike> => {
      if (id === null) return this.platform;
      const account = this.accountsById.get(id);
      if (!account) throw stripeError('resource_missing', 404);
      return account;
    }),
    create: vi.fn(async (params: AffiliateStripeAccountCreateParams, options?: { idempotencyKey?: string }) => {
      this.creates.push({ params, idempotencyKey: options?.idempotencyKey });
      const key = options?.idempotencyKey;
      if (key && this.byKey.has(key)) return this.byKey.get(key) as AffiliateStripeAccountLike;
      const account: AffiliateStripeAccountLike = { id: `acct_New${++this.sequence}`, details_submitted: false, payouts_enabled: false };
      this.accountsById.set(account.id, account);
      if (key) this.byKey.set(key, account);
      return account;
    }),
    createLoginLink: vi.fn(async () => ({ url: 'https://connect.stripe.com/express/acct_x/login' })),
  };

  accountLinks = { create: vi.fn(async () => ({ url: this.linkUrl })) };

  transfers = {
    create: async () => {
      throw new Error('not used');
    },
    list: async () => ({ data: [] }),
  };
}

let db: FakeDb;
let stripe: FakeStripe;

// `any`: the fixtures stand in for normalized profile rows (AffiliateConnectProfileRef & co.).
function addProfile(overrides: Row = {}): any {
  const profile: Row = {
    id: randomUUID(),
    user_id: randomUUID(),
    tier_id: randomUUID(),
    handle: 'jane-picks',
    display_name: 'Jane',
    status: 'ACTIVE',
    preferred_locale: 'en',
    social_links: {},
    stripe_connect_account_id: null,
    stripe_connect_livemode: null,
    stripe_connect_onboarding_complete: false,
    stripe_connect_details_submitted: false,
    stripe_connect_payouts_enabled: false,
    stripe_connect_checked_at: null,
    payout_configured_at: null,
    created_at: '2026-10-27T00:00:00.000Z',
    updated_at: '2026-10-27T00:00:00.000Z',
    ...overrides,
  };
  db.profiles.push(profile);
  return profile;
}

const client = () => db as unknown as AffiliateRepositoryClient;

function ensureInput(profile: Row, overrides: Partial<Parameters<typeof ensureAffiliateExpressAccount>[2]> = {}) {
  return {
    affiliateId: profile['id'],
    email: 'jane@example.org',
    country: 'CA',
    platform: { country: 'CA', livemode: false },
    storefrontUrl: 'https://shop.example.org/partners/jane-picks',
    productDescription: 'Affiliate partner of shop.example.org',
    now: new Date('2026-10-27T12:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  db = new FakeDb();
  stripe = new FakeStripe();
});

describe('countries', () => {
  it('normalizes supported codes and refuses others', () => {
    expect(normalizeAffiliateConnectCountry(' ca ')).toBe('CA');
    expect(normalizeAffiliateConnectCountry('US')).toBe('US');
    expect(normalizeAffiliateConnectCountry('KP')).toBeNull();
    expect(normalizeAffiliateConnectCountry('<script>')).toBeNull();
    expect(normalizeAffiliateConnectCountry(42)).toBeNull();
  });

  it('lists every supported country with a localized name, sorted by name', () => {
    const english = listAffiliateConnectCountryOptions('en');
    expect(english).toHaveLength(AFFILIATE_CONNECT_COUNTRY_CODES.length);
    expect(english.find((option) => option.code === 'DE')?.name).toBe('Germany');
    const names = english.map((option) => option.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')));
    expect(listAffiliateConnectCountryOptions('fr').find((option) => option.code === 'DE')?.name).toBe('Allemagne');
    expect(listAffiliateConnectCountryOptions('not a locale')).toHaveLength(AFFILIATE_CONNECT_COUNTRY_CODES.length);
  });

  it('limits a platform in the cross-border region (US, CA, GB, EEA, CH) to that region', () => {
    const options = listAffiliateConnectCountryOptions('en');
    for (const platform of ['US', 'ca', 'GB', 'FR', 'CH', 'NO']) {
      const codes = filterAffiliateConnectCountriesForPlatform(options, platform).map((option) => option.code).sort();
      // The region's supported countries: every supported code of the region (Iceland has no Express accounts).
      const expected = AFFILIATE_CONNECT_COUNTRY_CODES.filter((code) => isAffiliateConnectCrossBorderCountry(code)).sort();
      expect(codes, platform).toEqual(expected);
      expect(codes, platform).toHaveLength(33);
      for (const outside of ['AU', 'JP', 'SG', 'MX', 'BR', 'AE', 'GI', 'HK']) expect(codes, `${platform} ${outside}`).not.toContain(outside);
    }
    expect(AFFILIATE_CONNECT_CROSS_BORDER_COUNTRY_CODES).toContain('IS');
    expect(AFFILIATE_CONNECT_COUNTRY_CODES).not.toContain('IS' as never);
  });

  it("offers a platform outside the region only its own country, and nothing when that country is unsupported", () => {
    const options = listAffiliateConnectCountryOptions('en');
    expect(filterAffiliateConnectCountriesForPlatform(options, 'AU').map((option) => option.code)).toEqual(['AU']);
    expect(filterAffiliateConnectCountriesForPlatform(options, 'jp').map((option) => option.code)).toEqual(['JP']);
    expect(filterAffiliateConnectCountriesForPlatform(options, 'IN')).toEqual([]);
    expect(isAffiliateConnectCountryAllowedForPlatform('US', 'SG')).toBe(false);
    expect(isAffiliateConnectCountryAllowedForPlatform('SG', 'SG')).toBe(true);
  });

  it('keeps every supported country while the platform country is unknown', () => {
    const options = listAffiliateConnectCountryOptions('en');
    for (const platform of [null, undefined, '', 'not a country', 'USA']) {
      expect(filterAffiliateConnectCountriesForPlatform(options, platform as string | null)).toHaveLength(AFFILIATE_CONNECT_COUNTRY_CODES.length);
    }
    expect(isAffiliateConnectCountryAllowedForPlatform('KP', null)).toBe(false);
    expect(isAffiliateConnectCrossBorderCountry(' de ')).toBe(true);
    expect(isAffiliateConnectCrossBorderCountry('JP')).toBe(false);
    expect(isAffiliateConnectCrossBorderCountry(7)).toBe(false);
  });
});

describe('buildAffiliateExpressAccountParams (B3)', () => {
  it('builds an Express account with the transfers capability and the partner id in metadata', () => {
    const profile = addProfile();
    expect(buildAffiliateExpressAccountParams(ensureInput(profile))).toEqual({
      type: 'express',
      country: 'CA',
      email: 'jane@example.org',
      capabilities: { transfers: { requested: true } },
      business_profile: {
        url: 'https://shop.example.org/partners/jane-picks',
        product_description: 'Affiliate partner of shop.example.org',
      },
      metadata: { affiliate_id: profile['id'] },
    });
  });

  it('adds the recipient service agreement only across borders', () => {
    const profile = addProfile();
    expect(buildAffiliateExpressAccountParams(ensureInput(profile, { country: 'FR' })).tos_acceptance).toEqual({
      service_agreement: 'recipient',
    });
    expect(buildAffiliateExpressAccountParams(ensureInput(profile, { country: 'CA' })).tos_acceptance).toBeUndefined();
  });

  it('drops a local or non-https storefront URL and an unusable email', () => {
    const profile = addProfile();
    const params = buildAffiliateExpressAccountParams(
      ensureInput(profile, { storefrontUrl: 'http://localhost:4200/partners/jane-picks', email: 'not an email' })
    );
    expect(params.business_profile).toEqual({ product_description: 'Affiliate partner of shop.example.org' });
    expect(params.email).toBeUndefined();
  });
});

describe('ensureAffiliateExpressAccount (B3)', () => {
  it('creates the account once with the affiliate idempotency key and stores it conditionally', async () => {
    const profile = addProfile();
    const result = await ensureAffiliateExpressAccount(client(), stripe, ensureInput(profile));

    expect(result).toMatchObject({ created: true, replacedAccountId: null });
    expect(stripe.creates).toHaveLength(1);
    expect(stripe.creates[0].idempotencyKey).toBe(`affiliate-connect-${profile['id']}`);
    expect(profile).toMatchObject({
      stripe_connect_account_id: result.accountId,
      stripe_connect_livemode: false,
      stripe_connect_onboarding_complete: false,
      stripe_connect_checked_at: '2026-10-27T12:00:00.000Z',
    });

    // A second call reuses the stored account.
    const again = await ensureAffiliateExpressAccount(client(), stripe, ensureInput(profile));
    expect(again).toMatchObject({ accountId: result.accountId, created: false });
    expect(stripe.creates).toHaveLength(1);
  });

  it('keeps the account a concurrent request stored first', async () => {
    const profile = addProfile();
    db.beforeUpdate = () => {
      profile['stripe_connect_account_id'] = 'acct_Winner';
      profile['stripe_connect_livemode'] = false;
    };
    const result = await ensureAffiliateExpressAccount(client(), stripe, ensureInput(profile));
    expect(result).toMatchObject({ accountId: 'acct_Winner', created: false });
    expect(profile['stripe_connect_account_id']).toBe('acct_Winner');
  });

  it('replaces an account of the other key mode (re-onboarding) with a replacement key', async () => {
    const profile = addProfile({ stripe_connect_account_id: 'acct_TestMode', stripe_connect_livemode: false });
    const result = await ensureAffiliateExpressAccount(client(), stripe, ensureInput(profile, { platform: { country: 'CA', livemode: true } }));
    expect(result).toMatchObject({ created: true, replacedAccountId: 'acct_TestMode' });
    expect(stripe.creates[0].idempotencyKey).toBe(affiliateConnectIdempotencyKey(profile['id'], 'acct_TestMode'));
    expect(profile).toMatchObject({ stripe_connect_account_id: result.accountId, stripe_connect_livemode: true });
    expect(stripe.accounts.retrieve).not.toHaveBeenCalledWith('acct_TestMode');
  });

  it('replaces an account Stripe no longer knows', async () => {
    const profile = addProfile({ stripe_connect_account_id: 'acct_Deleted', stripe_connect_livemode: false });
    const result = await ensureAffiliateExpressAccount(client(), stripe, ensureInput(profile));
    expect(result).toMatchObject({ created: true, replacedAccountId: 'acct_Deleted' });
  });

  it('adopts the key mode of a stored account that answers', async () => {
    stripe.accountsById.set('acct_Legacy', { id: 'acct_Legacy', details_submitted: true });
    const profile = addProfile({ stripe_connect_account_id: 'acct_Legacy', stripe_connect_livemode: null });
    const result = await ensureAffiliateExpressAccount(client(), stripe, ensureInput(profile, { platform: { country: 'CA', livemode: true } }));
    expect(result).toMatchObject({ accountId: 'acct_Legacy', created: false });
    expect(profile['stripe_connect_livemode']).toBe(true);
  });

  it('propagates other Stripe errors and refuses unknown partners', async () => {
    const profile = addProfile({ stripe_connect_account_id: 'acct_Flaky', stripe_connect_livemode: false });
    stripe.accounts.retrieve.mockRejectedValueOnce(Object.assign(new Error('timeout'), { type: 'StripeConnectionError' }));
    await expect(ensureAffiliateExpressAccount(client(), stripe, ensureInput(profile))).rejects.toMatchObject({
      type: 'StripeConnectionError',
    });
    await expect(ensureAffiliateExpressAccount(client(), stripe, ensureInput({ id: randomUUID() }))).rejects.toMatchObject({
      code: 'affiliate_not_found',
    });
  });
});

describe('syncAffiliateConnectStatus (B3: readiness only from accounts.retrieve)', () => {
  const ready: AffiliateStripeAccountLike = {
    id: 'acct_Ready',
    details_submitted: true,
    payouts_enabled: true,
    capabilities: { transfers: 'active' },
    requirements: { currently_due: [], past_due: [], disabled_reason: null },
  };

  it('records readiness and reports firstReady exactly once', async () => {
    stripe.accountsById.set('acct_Ready', ready);
    const profile = addProfile({ stripe_connect_account_id: 'acct_Ready', stripe_connect_livemode: false });

    const first = await syncAffiliateConnectStatus(client(), stripe, { profile: { ...profile }, livemode: false });
    expect(first.firstReady).toBe(true);
    expect(first.status).toMatchObject({ hasAccount: true, ready: true, transfersActive: true });
    expect(profile).toMatchObject({ stripe_connect_onboarding_complete: true, stripe_connect_payouts_enabled: true });
    expect(profile['payout_configured_at']).toEqual(expect.any(String));

    const second = await syncAffiliateConnectStatus(client(), stripe, { profile: { ...profile, payout_configured_at: null }, livemode: false });
    expect(second.firstReady).toBe(false);
  });

  it('reports what is missing for an incomplete account', async () => {
    stripe.accountsById.set('acct_Half', {
      id: 'acct_Half',
      details_submitted: true,
      payouts_enabled: false,
      capabilities: { transfers: 'inactive' },
      requirements: { currently_due: ['external_account'], past_due: [], disabled_reason: 'requirements.past_due' },
    });
    const profile = addProfile({ stripe_connect_account_id: 'acct_Half', stripe_connect_livemode: false });
    const { status, firstReady } = await syncAffiliateConnectStatus(client(), stripe, { profile, livemode: false });
    expect(firstReady).toBe(false);
    expect(status).toMatchObject({ ready: false, detailsSubmitted: true, payoutsEnabled: false, requirementsDue: true, disabledReason: 'requirements.past_due' });
    expect(db.profiles[0]['stripe_connect_onboarding_complete']).toBe(false);
  });

  it('marks an account of the other key mode as not ready without calling Stripe', async () => {
    const profile = addProfile({ stripe_connect_account_id: 'acct_Test', stripe_connect_livemode: false, stripe_connect_onboarding_complete: true });
    const { status } = await syncAffiliateConnectStatus(client(), stripe, { profile, livemode: true });
    expect(status).toMatchObject({ livemodeMismatch: true, ready: false });
    expect(stripe.accounts.retrieve).not.toHaveBeenCalled();
    expect(db.profiles[0]['stripe_connect_onboarding_complete']).toBe(false);
  });

  it('marks an account Stripe no longer knows as missing', async () => {
    const profile = addProfile({ stripe_connect_account_id: 'acct_Gone', stripe_connect_livemode: false, stripe_connect_onboarding_complete: true });
    const { status } = await syncAffiliateConnectStatus(client(), stripe, { profile, livemode: false });
    expect(status).toMatchObject({ accountMissing: true, ready: false });
    expect(db.profiles[0]['stripe_connect_onboarding_complete']).toBe(false);
  });

  it('never overwrites a newer account with the status of the old one', async () => {
    stripe.accountsById.set('acct_Old', ready);
    const profile = addProfile({ stripe_connect_account_id: 'acct_New', stripe_connect_livemode: false });
    await syncAffiliateConnectStatus(client(), stripe, {
      profile: { ...profile, stripe_connect_account_id: 'acct_Old' },
      livemode: false,
    });
    expect(db.profiles[0]['stripe_connect_onboarding_complete']).toBe(false);
  });

  it('does nothing without an account and throws when the write fails', async () => {
    const empty = addProfile();
    expect((await syncAffiliateConnectStatus(client(), stripe, { profile: empty, livemode: false })).status.hasAccount).toBe(false);

    stripe.accountsById.set('acct_Ready', ready);
    const profile = addProfile({ stripe_connect_account_id: 'acct_Ready', stripe_connect_livemode: false });
    db.failWrites = true;
    await expect(syncAffiliateConnectStatus(client(), stripe, { profile, livemode: false })).rejects.toThrow();
  });

  it('evaluates readiness from the three Stripe flags', () => {
    expect(evaluateAffiliateConnectAccount(ready).ready).toBe(true);
    expect(evaluateAffiliateConnectAccount({ ...ready, details_submitted: false }).ready).toBe(false);
    expect(evaluateAffiliateConnectAccount({ ...ready, capabilities: null }).ready).toBe(false);
  });
});

describe('links and platform facts', () => {
  it('creates an onboarding link and refuses anything but a Stripe https URL', async () => {
    const url = await createAffiliateOnboardingLink(stripe, {
      accountId: 'acct_Abc',
      refreshUrl: 'https://shop.example.org/portal/retailer/payouts/connect/refresh',
      returnUrl: 'https://shop.example.org/portal/retailer/payouts?connected=1',
    });
    expect(url).toBe(stripe.linkUrl);
    expect(stripe.accountLinks.create).toHaveBeenCalledWith({
      account: 'acct_Abc',
      refresh_url: 'https://shop.example.org/portal/retailer/payouts/connect/refresh',
      return_url: 'https://shop.example.org/portal/retailer/payouts?connected=1',
      type: 'account_onboarding',
    });

    stripe.linkUrl = 'https://evil.example/phish';
    await expect(
      createAffiliateOnboardingLink(stripe, { accountId: 'acct_Abc', refreshUrl: 'https://a.b/r', returnUrl: 'https://a.b/r' })
    ).rejects.toMatchObject({ code: 'invalid_link' });
    await expect(
      createAffiliateOnboardingLink(stripe, { accountId: 'bad id', refreshUrl: 'https://a.b/r', returnUrl: 'https://a.b/r' })
    ).rejects.toMatchObject({ code: 'invalid_account' });
  });

  it('creates an Express dashboard link', async () => {
    await expect(createAffiliateExpressDashboardLink(stripe, 'acct_Abc')).resolves.toBe('https://connect.stripe.com/express/acct_x/login');
    expect(stripe.accounts.createLoginLink).toHaveBeenCalledWith('acct_Abc');
  });

  it("reads the platform's country, settlement currency and key mode", async () => {
    stripe.livemode = true;
    await expect(getAffiliatePlatformAccountInfo(stripe)).resolves.toEqual({ country: 'CA', defaultCurrency: 'CAD', livemode: true });
    expect(stripe.accounts.retrieve).toHaveBeenCalledWith(null);
  });
});
