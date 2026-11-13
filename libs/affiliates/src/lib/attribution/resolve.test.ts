import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AffiliateRepositoryClient } from '../repository/client';
import { isAffiliateAttributionTokenFresh, resolveCheckoutAttribution } from './resolve';
import type { AffiliateCheckoutAttributionInput } from './types';

/**
 * Checkout attribution decides who earns on an order, so the rules are tested one by one:
 * a valid storefront token beats the referral cookie, only ACTIVE and approved partners earn,
 * the token must be inside the partner tier's window, a partner never earns on their own
 * purchase (user id or normalized email), and nothing here can ever fail a checkout.
 */

type Row = Record<string, unknown>;

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const NOW_SECONDS = Math.floor(NOW / 1000);
const DAY = 24 * 60 * 60;

const JANE = {
  id: '11111111-1111-4111-8111-111111111111',
  user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  handle: 'jane-doe',
  status: 'ACTIVE',
  first_published_at: '2026-09-01T00:00:00Z',
  tier: { cookie_duration_days: 30 },
};
const MARC = {
  id: '22222222-2222-4222-8222-222222222222',
  user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  handle: 'marc-picks',
  status: 'ACTIVE',
  first_published_at: '2026-08-01T00:00:00Z',
  tier: { cookie_duration_days: 7 },
};

interface FakeOptions {
  profiles?: Row[];
  currencies?: Row[];
  emails?: Record<string, string | null>;
  failProfiles?: boolean;
  failCurrencies?: boolean;
  failAuth?: boolean;
  throwOnFrom?: boolean;
}

function fakeClient(options: FakeOptions = {}) {
  const calls = {
    from: [] as string[],
    selects: [] as string[],
    inFilters: [] as Array<{ column: string; values: unknown[] }>,
    getUserById: [] as string[],
  };

  class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
    private filters: Array<(row: Row) => boolean> = [];
    private single = false;
    private max: number | null = null;

    constructor(private readonly table: string) {}

    select(columns: string) {
      calls.selects.push(`${this.table}: ${columns}`);
      return this;
    }

    in(column: string, values: unknown[]) {
      calls.inFilters.push({ column, values });
      this.filters.push((row) => values.includes(row[column]));
      return this;
    }

    eq(column: string, value: unknown) {
      this.filters.push((row) => row[column] === value);
      return this;
    }

    limit(count: number) {
      this.max = count;
      return this;
    }

    maybeSingle() {
      this.single = true;
      return this;
    }

    private resolve(): { data: unknown; error: unknown } {
      if (this.table === 'affiliate_profiles' && options.failProfiles) {
        return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
      }
      if (this.table === 'currencies' && options.failCurrencies) {
        return { data: null, error: { code: '42501', message: 'permission denied for table currencies' } };
      }

      const source = this.table === 'affiliate_profiles' ? options.profiles ?? [] : options.currencies ?? [];
      let rows = source.filter((row) => this.filters.every((filter) => filter(row)));
      if (this.max !== null) rows = rows.slice(0, this.max);
      return { data: this.single ? rows[0] ?? null : rows, error: null };
    }

    then<T1 = { data: unknown; error: unknown }, T2 = never>(
      onFulfilled?: ((value: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>) | null,
      onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null
    ): PromiseLike<T1 | T2> {
      return Promise.resolve(this.resolve()).then(onFulfilled, onRejected);
    }
  }

  const client = {
    from(table: string) {
      if (options.throwOnFrom) throw new Error('fetch failed');
      calls.from.push(table);
      return new FakeQuery(table);
    },
    auth: {
      admin: {
        async getUserById(userId: string) {
          calls.getUserById.push(userId);
          if (options.failAuth) return { data: { user: null }, error: { status: 500, message: 'Database error loading user' } };
          if (!options.emails || !(userId in options.emails)) {
            return { data: { user: null }, error: { status: 404, message: 'User not found' } };
          }
          return { data: { user: { id: userId, email: options.emails[userId] } }, error: null };
        },
      },
    },
  };

  return { client: client as unknown as AffiliateRepositoryClient, calls };
}

function resolve(overrides: Partial<AffiliateCheckoutAttributionInput> & { fake?: FakeOptions } = {}) {
  const { fake: fakeOptions, ...inputOverrides } = overrides;
  const fake = fakeClient({
    profiles: [JANE, MARC],
    currencies: [
      { code: 'CAD', is_default: false },
      { code: 'usd', is_default: true },
    ],
    emails: { [JANE.user_id]: 'jane@example.com', [MARC.user_id]: 'marc@example.com' },
    ...fakeOptions,
  });
  const promise = resolveCheckoutAttribution({
    supabase: fake.client,
    token: null,
    cookieHandle: null,
    buyerUserId: null,
    buyerEmail: null,
    now: NOW,
    ...inputOverrides,
  });
  return { promise, calls: fake.calls };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveCheckoutAttribution: precedence', () => {
  it('returns null without a query when there is neither a token nor a cookie', async () => {
    const { promise, calls } = resolve();

    await expect(promise).resolves.toBeNull();
    expect(calls.from).toEqual([]);
  });

  it('attributes a fresh storefront token to its ACTIVE, approved partner, with the base currency', async () => {
    const { promise, calls } = resolve({ token: { handle: 'jane-doe', issuedAt: NOW_SECONDS - 3 * DAY } });

    await expect(promise).resolves.toEqual({
      affiliateId: JANE.id,
      handle: 'jane-doe',
      source: 'storefront',
      baseCurrency: 'USD',
    });
    expect(calls.inFilters).toEqual([{ column: 'handle', values: ['jane-doe'] }]);
    expect(calls.selects).toContain('affiliate_profiles: id, user_id, handle, status, first_published_at, tier:affiliate_tiers(cookie_duration_days)');
  });

  it('lets the storefront token win over a referral cookie for another partner (one lookup for both)', async () => {
    const { promise, calls } = resolve({
      token: { handle: 'jane-doe', issuedAt: NOW_SECONDS - DAY },
      cookieHandle: 'marc-picks',
    });

    await expect(promise).resolves.toMatchObject({ affiliateId: JANE.id, source: 'storefront' });
    expect(calls.inFilters).toEqual([{ column: 'handle', values: ['jane-doe', 'marc-picks'] }]);
  });

  it('falls back to the cookie when the token is older than its partner tier window', async () => {
    // Marc's tier holds referrals for 7 days; his token is 8 days old.
    const { promise } = resolve({
      token: { handle: 'marc-picks', issuedAt: NOW_SECONDS - 8 * DAY },
      cookieHandle: 'jane-doe',
    });

    await expect(promise).resolves.toMatchObject({ affiliateId: JANE.id, source: 'referral_link' });
  });

  it('accepts a token inside a short tier window', async () => {
    const { promise } = resolve({ token: { handle: 'marc-picks', issuedAt: NOW_SECONDS - 6 * DAY } });

    await expect(promise).resolves.toMatchObject({ affiliateId: MARC.id, source: 'storefront' });
  });

  it('uses the 30-day default window when the tier row is missing from the result', async () => {
    const noTier = { ...MARC, tier: null };
    const fresh = resolve({ token: { handle: 'marc-picks', issuedAt: NOW_SECONDS - 20 * DAY }, fake: { profiles: [noTier] } });
    const stale = resolve({ token: { handle: 'marc-picks', issuedAt: NOW_SECONDS - 31 * DAY }, fake: { profiles: [noTier] } });

    await expect(fresh.promise).resolves.toMatchObject({ affiliateId: MARC.id, source: 'storefront' });
    await expect(stale.promise).resolves.toBeNull();
  });

  it('refuses a token minted in the future (beyond the clock skew)', async () => {
    const { promise } = resolve({ token: { handle: 'jane-doe', issuedAt: NOW_SECONDS + 10 * 60 } });

    await expect(promise).resolves.toBeNull();
  });

  it('falls back to the cookie when the token partner is suspended', async () => {
    const { promise } = resolve({
      token: { handle: 'jane-doe', issuedAt: NOW_SECONDS - DAY },
      cookieHandle: 'marc-picks',
      fake: { profiles: [{ ...JANE, status: 'SUSPENDED' }, MARC] },
    });

    await expect(promise).resolves.toMatchObject({ affiliateId: MARC.id, source: 'referral_link' });
  });

  it('never attributes to a partner whose storefront was never approved', async () => {
    const unapproved = { ...JANE, first_published_at: null };
    const byToken = resolve({ token: { handle: 'jane-doe', issuedAt: NOW_SECONDS - DAY }, fake: { profiles: [unapproved] } });
    const byCookie = resolve({ cookieHandle: 'jane-doe', fake: { profiles: [unapproved] } });

    await expect(byToken.promise).resolves.toBeNull();
    await expect(byCookie.promise).resolves.toBeNull();
  });

  it('attributes the referral cookie of an ACTIVE, approved partner, normalizing its case', async () => {
    const { promise, calls } = resolve({ cookieHandle: '  Marc-Picks ' });

    await expect(promise).resolves.toEqual({
      affiliateId: MARC.id,
      handle: 'marc-picks',
      source: 'referral_link',
      baseCurrency: 'USD',
    });
    expect(calls.inFilters).toEqual([{ column: 'handle', values: ['marc-picks'] }]);
  });

  it.each([
    ['a suspended partner', { profiles: [{ ...MARC, status: 'SUSPENDED' }] }],
    ['an unknown handle', { profiles: [] }],
    ['a row with a malformed id', { profiles: [{ ...MARC, id: 'not-a-uuid' }] }],
  ])('returns null for the cookie of %s', async (_label, fake) => {
    const { promise } = resolve({ cookieHandle: 'marc-picks', fake });

    await expect(promise).resolves.toBeNull();
  });

  it.each([
    ['a path', '../admin'],
    ['a filter injection', 'jane-doe,status.eq.ACTIVE'],
    ['a one-character handle', 'j'],
    ['a non-string', 42],
  ])('ignores %s in the cookie without querying', async (_label, cookieHandle) => {
    const { promise, calls } = resolve({ cookieHandle: cookieHandle as string });

    await expect(promise).resolves.toBeNull();
    expect(calls.from).toEqual([]);
  });

  it('ignores a token with an invalid issue time', async () => {
    const { promise, calls } = resolve({ token: { handle: 'jane-doe', issuedAt: Number.NaN } });

    await expect(promise).resolves.toBeNull();
    expect(calls.from).toEqual([]);
  });
});

describe('resolveCheckoutAttribution: self-referral', () => {
  it('returns null when the signed-in buyer is the partner, without reading the auth email', async () => {
    const { promise, calls } = resolve({
      token: { handle: 'jane-doe', issuedAt: NOW_SECONDS - DAY },
      buyerUserId: JANE.user_id.toUpperCase(),
      buyerEmail: 'someone-else@example.com',
    });

    await expect(promise).resolves.toBeNull();
    expect(calls.getUserById).toEqual([]);
  });

  it('returns null when the buyer email is the partner auth email under normalization (+tag, Gmail dots, case)', async () => {
    const { promise, calls } = resolve({
      cookieHandle: 'jane-doe',
      buyerEmail: '  M.E+promo@GoogleMail.com ',
      fake: { emails: { [JANE.user_id]: 'me@gmail.com' } },
    });

    await expect(promise).resolves.toBeNull();
    expect(calls.getUserById).toEqual([JANE.user_id]);
  });

  it('does not fall back to another partner after a self-referral', async () => {
    const { promise } = resolve({
      token: { handle: 'jane-doe', issuedAt: NOW_SECONDS - DAY },
      cookieHandle: 'marc-picks',
      buyerUserId: JANE.user_id,
    });

    await expect(promise).resolves.toBeNull();
  });

  it('attributes a buyer whose email differs from the partner', async () => {
    const { promise, calls } = resolve({
      cookieHandle: 'jane-doe',
      buyerUserId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      buyerEmail: 'customer@example.com',
    });

    await expect(promise).resolves.toMatchObject({ affiliateId: JANE.id, source: 'referral_link' });
    expect(calls.getUserById).toEqual([JANE.user_id]);
  });

  it('skips the auth lookup when the buyer gave no email', async () => {
    const { promise, calls } = resolve({ cookieHandle: 'jane-doe' });

    await expect(promise).resolves.toMatchObject({ affiliateId: JANE.id });
    expect(calls.getUserById).toEqual([]);
  });
});

describe('resolveCheckoutAttribution: fail-safe', () => {
  it.each([
    ['the partner lookup fails', { failProfiles: true }],
    ['the auth lookup fails', { failAuth: true }],
    ['the partner account is gone', { emails: {} }],
    ['the client throws', { throwOnFrom: true }],
  ])('returns null (and logs) when %s', async (_label, fake) => {
    const { promise } = resolve({ cookieHandle: 'jane-doe', buyerEmail: 'customer@example.com', fake });

    await expect(promise).resolves.toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });

  it('keeps the attribution with a null base currency when the currency read fails', async () => {
    const { promise } = resolve({ cookieHandle: 'jane-doe', fake: { failCurrencies: true } });

    await expect(promise).resolves.toEqual({
      affiliateId: JANE.id,
      handle: 'jane-doe',
      source: 'referral_link',
      baseCurrency: null,
    });
  });

  it('drops a base currency that is not a three-letter code', async () => {
    const { promise } = resolve({ cookieHandle: 'jane-doe', fake: { currencies: [{ code: 'dollars', is_default: true }] } });

    await expect(promise).resolves.toMatchObject({ baseCurrency: null });
  });
});

describe('isAffiliateAttributionTokenFresh', () => {
  it('accepts a token inside the window and at its last second', () => {
    expect(isAffiliateAttributionTokenFresh(NOW_SECONDS - 29 * DAY, 30, NOW)).toBe(true);
    expect(isAffiliateAttributionTokenFresh(NOW_SECONDS - 30 * DAY, 30, NOW)).toBe(true);
  });

  it('refuses a token past the window', () => {
    expect(isAffiliateAttributionTokenFresh(NOW_SECONDS - 30 * DAY - 1, 30, NOW)).toBe(false);
  });

  it('tolerates five minutes of clock skew, no more', () => {
    expect(isAffiliateAttributionTokenFresh(NOW_SECONDS + 5 * 60, 30, NOW)).toBe(true);
    expect(isAffiliateAttributionTokenFresh(NOW_SECONDS + 5 * 60 + 1, 30, NOW)).toBe(false);
  });

  it('caps the window at 365 days and refuses non-positive or non-finite windows', () => {
    expect(isAffiliateAttributionTokenFresh(NOW_SECONDS - 400 * DAY, 1000, NOW)).toBe(false);
    expect(isAffiliateAttributionTokenFresh(NOW_SECONDS - 300 * DAY, 1000, NOW)).toBe(true);
    expect(isAffiliateAttributionTokenFresh(NOW_SECONDS, 0, NOW)).toBe(false);
    expect(isAffiliateAttributionTokenFresh(NOW_SECONDS, Number.NaN, NOW)).toBe(false);
  });
});
