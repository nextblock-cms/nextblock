import { describe, expect, it } from 'vitest';

import type { CreateAffiliateAccountInput } from '../core/types';
import type { AffiliateRepositoryClient } from './client';
import {
  AFFILIATE_REPOSITORY_MAX_PAGE_SIZE,
  AffiliateAccountError,
  AffiliateRepositoryError,
  computeAffiliateBalances,
  createAffiliateAccountViaRpc,
  escapeAffiliateLikePattern,
  getAffiliateBalances,
  getAffiliatePageByAffiliateId,
  getAffiliateProfileByHandle,
  getAffiliateProfileById,
  getAffiliateProfileByUserId,
  getAffiliateTierById,
  listAffiliateCommissions,
  listAffiliatePayouts,
  listAffiliateProfiles,
  listAffiliateTiers,
  mapAffiliateRpcError,
  type AffiliateBalanceInputRow,
} from './index';

/* ------------------------------ fake PostgREST chain ------------------------------ */

type Call = { method: string; args: unknown[] };
type Query = { table: string; calls: Call[] };
type Result = { data: unknown; error: unknown; count?: number | null };

/**
 * A Supabase-shaped fake: `from(table)` returns a chainable builder that records every call
 * and, when awaited, asks `respond` for the result. `rpc` records the function and its args.
 */
function fakeSupabase(respond: (query: Query) => Result = () => ({ data: null, error: null }), rpcResult?: Result) {
  const queries: Query[] = [];
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];

  const builder = (query: Query): Record<string, unknown> => {
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'ilike', 'order', 'range', 'limit', 'maybeSingle', 'single', 'or']) {
      chain[method] = (...args: unknown[]) => {
        query.calls.push({ method, args });
        return chain;
      };
    }
    chain['then'] = (resolve: (value: Result) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(respond(query)).then(resolve, reject);
    return chain;
  };

  const client = {
    from(table: string) {
      const query: Query = { table, calls: [] };
      queries.push(query);
      return builder(query);
    },
    rpc(fn: string, args: unknown) {
      rpcCalls.push({ fn, args });
      return Promise.resolve(rpcResult ?? { data: null, error: null });
    },
  };

  return { client: client as unknown as AffiliateRepositoryClient, queries, rpcCalls };
}

function callsOf(query: Query | undefined, method: string): unknown[][] {
  return (query?.calls ?? []).filter((call) => call.method === method).map((call) => call.args);
}

const USER_ID = '11111111-1111-4111-8111-111111111111';
const AFFILIATE_ID = '22222222-2222-4222-8222-222222222222';
const TIER_ID = '33333333-3333-4333-8333-333333333333';

const PROFILE_ROW = {
  id: AFFILIATE_ID,
  user_id: USER_ID,
  tier_id: TIER_ID,
  handle: 'jane',
  display_name: 'Jane',
  bio: null,
  avatar_object_key: null,
  social_links: { instagram: 'https://instagram.com/jane', bogus: 5 },
  preferred_locale: 'fr',
  onboarding_step: 'PROFILE_COMPLETED',
  status: 'ACTIVE',
  suspended_reason: null,
  stripe_connect_account_id: null,
  stripe_connect_onboarding_complete: false,
  stripe_connect_details_submitted: false,
  stripe_connect_payouts_enabled: false,
  stripe_connect_livemode: null,
  stripe_connect_checked_at: null,
  total_clicks: '17',
  last_click_at: null,
  total_earned_cents: '12500',
  total_paid_cents: 0,
  profile_completed_at: '2026-10-02T00:00:00Z',
  payout_configured_at: null,
  page_submitted_at: null,
  first_published_at: null,
  signup_ip_masked: '203.0.113.0/24',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-02T00:00:00Z',
  some_future_column: 'dropped',
};

/* ------------------------------------- reads ------------------------------------- */

describe('profile and page reads', () => {
  it('reads a profile by user id and normalizes the row to the contract', async () => {
    const { client, queries } = fakeSupabase(() => ({ data: PROFILE_ROW, error: null }));
    const profile = await getAffiliateProfileByUserId(client, USER_ID.toUpperCase());

    expect(queries[0]?.table).toBe('affiliate_profiles');
    expect(callsOf(queries[0], 'eq')).toEqual([['user_id', USER_ID]]);
    expect(callsOf(queries[0], 'maybeSingle')).toHaveLength(1);
    expect(profile?.total_clicks).toBe(17);
    expect(profile?.total_earned_cents).toBe(12500);
    expect(profile?.social_links).toEqual({ instagram: 'https://instagram.com/jane' });
    expect(profile).not.toHaveProperty('some_future_column');
  });

  it('maps tier_changed_at (02035), and reads a row without it, or with an unusable value, as null', async () => {
    const moved = fakeSupabase(() => ({ data: { ...PROFILE_ROW, tier_changed_at: '2026-11-11T09:30:00.000Z' }, error: null }));
    expect((await getAffiliateProfileById(moved.client, AFFILIATE_ID))?.tier_changed_at).toBe('2026-11-11T09:30:00.000Z');

    // Before 02035 the column does not exist: the partner is in their sign-up tier since created_at.
    const before = fakeSupabase(() => ({ data: PROFILE_ROW, error: null }));
    const profile = await getAffiliateProfileById(before.client, AFFILIATE_ID);
    expect(profile).toHaveProperty('tier_changed_at', null);
    expect(profile?.created_at).toBe('2026-10-01T00:00:00Z');

    for (const value of [null, 42, { at: 'x' }]) {
      const odd = fakeSupabase(() => ({ data: { ...PROFILE_ROW, tier_changed_at: value }, error: null }));
      expect((await getAffiliateProfileById(odd.client, AFFILIATE_ID))?.tier_changed_at, JSON.stringify(value)).toBeNull();
    }
  });

  it('never queries with an id that is not a uuid', async () => {
    const { client, queries } = fakeSupabase();
    expect(await getAffiliateProfileByUserId(client, 'not-a-uuid')).toBeNull();
    expect(await getAffiliateProfileById(client, "1' or '1'='1")).toBeNull();
    expect(await getAffiliatePageByAffiliateId(client, '')).toBeNull();
    expect(await getAffiliateTierById(client, '42')).toBeNull();
    expect(queries).toHaveLength(0);
  });

  it('looks handles up lowercased and skips strings that cannot be handles', async () => {
    const { client, queries } = fakeSupabase(() => ({ data: PROFILE_ROW, error: null }));
    expect((await getAffiliateProfileByHandle(client, '  Jane '))?.id).toBe(AFFILIATE_ID);
    expect(callsOf(queries[0], 'eq')).toEqual([['handle', 'jane']]);

    expect(await getAffiliateProfileByHandle(client, 'a')).toBeNull();
    expect(await getAffiliateProfileByHandle(client, 'jane%')).toBeNull();
    expect(queries).toHaveLength(1);
  });

  it('answers null for no row and throws a generic error on a PostgREST error', async () => {
    const missing = fakeSupabase(() => ({ data: null, error: null }));
    expect(await getAffiliateProfileById(missing.client, AFFILIATE_ID)).toBeNull();

    const failing = fakeSupabase(() => ({ data: null, error: { code: '42P01', message: 'relation "affiliate_profiles" does not exist' } }));
    const error = await getAffiliateProfileById(failing.client, AFFILIATE_ID).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AffiliateRepositoryError);
    expect((error as AffiliateRepositoryError).code).toBe('42P01');
    expect((error as Error).message).toBe('Affiliates repository: getAffiliateProfileById failed');
    expect((error as Error).message).not.toContain('relation');
  });

  it('passes the untrusted draft through untouched and normalizes the published snapshot', async () => {
    const draft = { type: 'doc', content: [{ type: 'scriptTag' }] };
    const { client, queries } = fakeSupabase(() => ({
      data: {
        id: '44444444-4444-4444-8444-444444444444',
        affiliate_id: AFFILIATE_ID,
        user_id: USER_ID,
        title: 'Jane picks',
        meta_description: '',
        draft_content: draft,
        featured_product_ids: ['p1', 7, null],
        published_content: null,
        published_profile: { display_name: 'Jane', bio: 'Hi', avatar_object_key: null, social_links: null, extra: true },
        published_featured_product_ids: null,
        approval_status: 'BOGUS',
        draft_version: '3',
        draft_updated_at: '2026-10-03T00:00:00Z',
      },
      error: null,
    }));

    const page = await getAffiliatePageByAffiliateId(client, AFFILIATE_ID);
    expect(callsOf(queries[0], 'eq')).toEqual([['affiliate_id', AFFILIATE_ID]]);
    expect(page?.draft_content).toBe(draft);
    expect(page?.featured_product_ids).toEqual(['p1']);
    expect(page?.published_featured_product_ids).toEqual([]);
    expect(page?.published_profile).toEqual({ display_name: 'Jane', bio: 'Hi', avatar_object_key: null, social_links: {} });
    expect(page?.approval_status).toBe('DRAFT');

    // The storefront's declared language survives normalization; anything but en/fr is dropped.
    for (const [locale, expected] of [['fr', 'fr'], ['en', 'en'], ['de', undefined], [7, undefined]] as const) {
      const fake = fakeSupabase(() => ({
        data: {
          id: '44444444-4444-4444-8444-444444444444',
          affiliate_id: AFFILIATE_ID,
          user_id: USER_ID,
          published_profile: { display_name: 'Jane', bio: null, avatar_object_key: null, social_links: null, locale },
        },
        error: null,
      }));
      const withLocale = await getAffiliatePageByAffiliateId(fake.client, AFFILIATE_ID);
      expect(withLocale?.published_profile?.locale).toBe(expected);
    }
    expect(page?.draft_version).toBe(3);
  });
});

describe('tier reads', () => {
  const tierRow = {
    id: TIER_ID,
    name: 'Founding Ambassador',
    name_translations: { fr: 'Ambassadeur fondateur', bad: 1 },
    slug: 'founding-ambassador',
    commission_percentage: '50.00',
    cookie_duration_days: 30,
    clearance_hold_days: 30,
    is_default_signup_tier: true,
    is_limited_time_promo: true,
    max_ambassadors_cap: 50,
    member_count: 3,
    sort_order: 4,
    badge_color: 'amber',
    is_active: true,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
  };

  it('lists active tiers by sort order unless inactive ones are asked for', async () => {
    const active = fakeSupabase(() => ({ data: [tierRow], error: null }));
    const tiers = await listAffiliateTiers(active.client);
    expect(callsOf(active.queries[0], 'eq')).toEqual([['is_active', true]]);
    expect(callsOf(active.queries[0], 'order')).toEqual([
      ['sort_order', { ascending: true }],
      ['created_at', { ascending: true }],
    ]);
    expect(tiers[0]?.commission_percentage).toBe(50);
    expect(tiers[0]?.name_translations).toEqual({ fr: 'Ambassadeur fondateur' });

    const all = fakeSupabase(() => ({ data: [tierRow, { not: 'a row' }], error: null }));
    expect(await listAffiliateTiers(all.client, { includeInactive: true })).toHaveLength(1);
    expect(callsOf(all.queries[0], 'eq')).toEqual([]);
  });

  it('falls back to a known badge colour', async () => {
    const { client } = fakeSupabase(() => ({ data: { ...tierRow, badge_color: 'url(javascript:x)' }, error: null }));
    expect((await getAffiliateTierById(client, TIER_ID))?.badge_color).toBe('violet');
  });

  it('maps the goal and its translations (02033), keeping string entries only', async () => {
    const { client } = fakeSupabase(() => ({
      data: {
        ...tierRow,
        goal: 'Join while the founding spots last.',
        goal_translations: { fr: 'Inscrivez-vous tant qu’il reste des places fondatrices.', bad: 1, nested: { fr: 'x' } },
      },
      error: null,
    }));
    const tier = await getAffiliateTierById(client, TIER_ID);
    expect(tier?.goal).toBe('Join while the founding spots last.');
    expect(tier?.goal_translations).toEqual({ fr: 'Inscrivez-vous tant qu’il reste des places fondatrices.' });
  });

  it('reads a row without the goal columns (before 02033) or with unusable values as no goal', async () => {
    const before = fakeSupabase(() => ({ data: [tierRow], error: null }));
    const [tier] = await listAffiliateTiers(before.client);
    expect(tier?.goal).toBeNull();
    expect(tier?.goal_translations).toEqual({});

    const unusable = fakeSupabase(() => ({ data: { ...tierRow, goal: 42, goal_translations: ['fr'] }, error: null }));
    const odd = await getAffiliateTierById(unusable.client, TIER_ID);
    expect(odd?.goal).toBeNull();
    expect(odd?.goal_translations).toEqual({});

    const nulls = fakeSupabase(() => ({ data: { ...tierRow, goal: null, goal_translations: null }, error: null }));
    const empty = await getAffiliateTierById(nulls.client, TIER_ID);
    expect(empty?.goal).toBeNull();
    expect(empty?.goal_translations).toEqual({});
  });
});

describe('ledger lists', () => {
  it('filters, orders newest first, pages with range and returns the exact count', async () => {
    const { client, queries } = fakeSupabase(() => ({
      data: [{ id: 'c1', status: 'PAID', commission_amount_cents: '500', currency: 'USD' }],
      error: null,
      count: 41,
    }));
    const page = await listAffiliateCommissions(client, {
      affiliateId: AFFILIATE_ID,
      status: ['CLEARED', 'PAID', 'CLEARED'],
      limit: 20,
      offset: 40,
    });

    const query = queries[0];
    expect(query?.table).toBe('affiliate_commissions');
    expect(callsOf(query, 'select')).toEqual([['*', { count: 'exact' }]]);
    expect(callsOf(query, 'eq')).toEqual([['affiliate_id', AFFILIATE_ID]]);
    expect(callsOf(query, 'in')).toEqual([['status', ['CLEARED', 'PAID']]]);
    expect(callsOf(query, 'order')).toEqual([
      ['created_at', { ascending: false }],
      ['id', { ascending: false }],
    ]);
    expect(callsOf(query, 'range')).toEqual([[40, 59]]);
    expect(page.count).toBe(41);
    expect(page.rows[0]?.commission_amount_cents).toBe(500);
  });

  it('clamps the page size and uses eq for a single status', async () => {
    const { client, queries } = fakeSupabase(() => ({ data: [], error: null, count: 0 }));
    await listAffiliatePayouts(client, { status: 'FAILED', limit: 10_000, offset: -5 });
    expect(queries[0]?.table).toBe('affiliate_payouts');
    expect(callsOf(queries[0], 'eq')).toEqual([['status', 'FAILED']]);
    expect(callsOf(queries[0], 'range')).toEqual([[0, AFFILIATE_REPOSITORY_MAX_PAGE_SIZE - 1]]);
  });

  it('answers an empty page without a query for filters that cannot match', async () => {
    const { client, queries } = fakeSupabase();
    expect(await listAffiliateCommissions(client, { status: 'REFUNDED' as never })).toEqual({ rows: [], count: 0 });
    expect(await listAffiliatePayouts(client, { affiliateId: 'nope' })).toEqual({ rows: [], count: 0 });
    expect(queries).toHaveLength(0);
  });

  it('throws on a PostgREST error', async () => {
    const { client } = fakeSupabase(() => ({ data: null, error: { code: 'PGRST103', message: 'Requested range not satisfiable' } }));
    await expect(listAffiliatePayouts(client)).rejects.toBeInstanceOf(AffiliateRepositoryError);
  });

  it('keeps the key mode of a sale and of a payout (an absent column reads as live) and the dispute hold', async () => {
    const { client: commissions } = fakeSupabase(() => ({
      data: [
        { id: 'c1', status: 'CLEARED', livemode: false, disputed_at: '2026-10-20T00:00:00.000Z' },
        { id: 'c2', status: 'CLEARED', livemode: true },
        { id: 'c3', status: 'CLEARED' },
      ],
      error: null,
      count: 3,
    }));
    const page = await listAffiliateCommissions(commissions);
    expect(page.rows.map((row) => [row.livemode, row.disputed_at])).toEqual([
      [false, '2026-10-20T00:00:00.000Z'],
      [true, null],
      [true, null],
    ]);

    const { client: payouts } = fakeSupabase(() => ({
      data: [{ id: 'p1', status: 'FAILED', livemode: false }, { id: 'p2', status: 'COMPLETED' }],
      error: null,
      count: 2,
    }));
    expect((await listAffiliatePayouts(payouts)).rows.map((row) => row.livemode)).toEqual([false, true]);
  });
});

describe('listAffiliateProfiles search', () => {
  it('searches handles with handle-shaped terms and escapes LIKE wildcards otherwise, never through .or()', async () => {
    const { client, queries } = fakeSupabase(() => ({ data: [PROFILE_ROW], error: null, count: 1 }));

    await listAffiliateProfiles(client, { search: ' Jane-Doe ', status: 'ACTIVE', tierId: TIER_ID });
    expect(callsOf(queries[0], 'ilike')).toEqual([['handle', '%jane-doe%']]);
    expect(callsOf(queries[0], 'eq')).toEqual([
      ['status', 'ACTIVE'],
      ['tier_id', TIER_ID],
    ]);

    await listAffiliateProfiles(client, { search: '100% *real*_deals\\' });
    expect(callsOf(queries[1], 'ilike')).toEqual([['display_name', '%100\\% real\\_deals\\\\%']]);

    expect(queries.every((query) => callsOf(query, 'or').length === 0)).toBe(true);
  });

  it('answers nothing for a bad status or tier id', async () => {
    const { client, queries } = fakeSupabase();
    expect(await listAffiliateProfiles(client, { status: 'BANNED' as never })).toEqual({ rows: [], count: 0 });
    expect(await listAffiliateProfiles(client, { tierId: 'x' })).toEqual({ rows: [], count: 0 });
    expect(queries).toHaveLength(0);
  });

  it('escapes LIKE patterns', () => {
    expect(escapeAffiliateLikePattern('50%_off\\*')).toBe('50\\%\\_off\\\\');
    expect(escapeAffiliateLikePattern('plain')).toBe('plain');
  });
});

/* ------------------------------------ balances ------------------------------------ */

function commission(overrides: Partial<AffiliateBalanceInputRow>): AffiliateBalanceInputRow {
  return {
    status: 'PENDING_CLEARANCE',
    currency: 'USD',
    commission_amount_cents: 1000,
    refunded_amount_cents: 0,
    payout_id: null,
    clears_at: '2026-11-01T00:00:00Z',
    ...overrides,
  };
}

describe('computeAffiliateBalances', () => {
  it('splits the ledger into pending, cleared, processing, paid and voided, net of refunds', () => {
    const balances = computeAffiliateBalances(
      [
        commission({ commission_amount_cents: 1000, refunded_amount_cents: 250, clears_at: '2026-11-20T00:00:00Z' }),
        commission({ commission_amount_cents: 2000, clears_at: '2026-11-05T00:00:00Z' }),
        commission({ status: 'CLEARED', commission_amount_cents: 3000 }),
        commission({ status: 'CLEARED', commission_amount_cents: 4000, payout_id: 'po-1' }),
        commission({ status: 'PAID', commission_amount_cents: 5000, refunded_amount_cents: 500 }),
        commission({ status: 'VOIDED_REFUND', commission_amount_cents: 600, refunded_amount_cents: 100 }),
        commission({ status: 'VOIDED_REFUND', commission_amount_cents: 0 }),
      ],
      { baseCurrency: 'usd' }
    );

    expect(balances.primary).toEqual({
      currency: 'USD',
      pendingCents: 750 + 2000,
      clearedCents: 3000,
      processingCents: 4000,
      paidCents: 4500,
      voidedCents: 250 + 500 + 600,
      nextClearsAt: '2026-11-05T00:00:00Z',
    });
    expect(balances.byCurrency).toEqual([balances.primary]);
  });

  it('puts the base currency first even with no rows in it, and lists only currencies with rows', () => {
    const balances = computeAffiliateBalances([commission({ currency: 'EUR' }), commission({ currency: 'CAD' })], {
      baseCurrency: 'USD',
    });
    expect(balances.primary).toEqual({
      currency: 'USD',
      pendingCents: 0,
      clearedCents: 0,
      processingCents: 0,
      paidCents: 0,
      voidedCents: 0,
      nextClearsAt: null,
    });
    expect(balances.byCurrency.map((balance) => balance.currency)).toEqual(['CAD', 'EUR']);
  });

  it('without a base currency, picks the most frequent one (ties alphabetical)', () => {
    const rows = [commission({ currency: 'EUR' }), commission({ currency: 'CAD' }), commission({ currency: 'EUR' })];
    expect(computeAffiliateBalances(rows).primary.currency).toBe('EUR');
    expect(computeAffiliateBalances(rows).byCurrency.map((b) => b.currency)).toEqual(['EUR', 'CAD']);
    expect(computeAffiliateBalances([commission({ currency: 'EUR' }), commission({ currency: 'CAD' })]).primary.currency).toBe('CAD');
    expect(computeAffiliateBalances([]).primary.currency).toBe('USD');
  });

  it('never reports a refund larger than the commission', () => {
    const balances = computeAffiliateBalances([commission({ status: 'PAID', commission_amount_cents: 100, refunded_amount_cents: 900 })]);
    expect(balances.primary.paidCents).toBe(0);
    expect(balances.primary.voidedCents).toBe(100);
  });
});

describe('getAffiliateBalances', () => {
  it('pages through every commission (PostgREST caps responses at 1000 rows)', async () => {
    const firstPage = Array.from({ length: 1000 }, (_, index) => ({ id: `c${index}`, ...commission({ commission_amount_cents: 1 }) }));
    const secondPage = [{ id: 'last', ...commission({ status: 'PAID', commission_amount_cents: 7 }) }];
    const { client, queries } = fakeSupabase((query) => {
      const [[from]] = callsOf(query, 'range') as [[number, number]];
      return { data: from === 0 ? firstPage : secondPage, error: null };
    });

    const balances = await getAffiliateBalances(client, AFFILIATE_ID, { baseCurrency: 'USD' });

    expect(queries.map((query) => callsOf(query, 'range')[0])).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(callsOf(queries[0], 'eq')).toEqual([['affiliate_id', AFFILIATE_ID]]);
    expect(balances.primary.pendingCents).toBe(1000);
    expect(balances.primary.paidCents).toBe(7);
  });

  it('returns zero balances for a non-uuid id without a query', async () => {
    const { client, queries } = fakeSupabase();
    expect((await getAffiliateBalances(client, 'x', { baseCurrency: 'CAD' })).primary).toMatchObject({ currency: 'CAD', paidCents: 0 });
    expect(queries).toHaveLength(0);
  });
});

/* ------------------------------------- signup ------------------------------------- */

const SIGNUP_INPUT: CreateAffiliateAccountInput = {
  userId: USER_ID,
  handle: ' Jane-Doe ',
  displayName: '  Jane Doe  ',
  locale: 'FR',
  title: 'T'.repeat(200),
  metaDescription: 'M'.repeat(400),
  starterDoc: { type: 'doc', content: [] },
  signupIpMasked: '  ',
};

describe('createAffiliateAccountViaRpc', () => {
  it('calls create_affiliate_account with normalized, clipped arguments and maps the row', async () => {
    const { client, rpcCalls } = fakeSupabase(undefined, {
      data: [
        {
          affiliate_id: AFFILIATE_ID,
          page_id: '44444444-4444-4444-8444-444444444444',
          tier_id: TIER_ID,
          tier_name: 'Founding Ambassador',
          tier_slug: 'founding-ambassador',
          commission_percentage: '50.00',
          is_limited_time_promo: true,
          spots_remaining: 37,
        },
      ],
      error: null,
    });

    const result = await createAffiliateAccountViaRpc(client, SIGNUP_INPUT);

    expect(rpcCalls).toEqual([
      {
        fn: 'create_affiliate_account',
        args: {
          p_user_id: USER_ID,
          p_handle: 'jane-doe',
          p_display_name: 'Jane Doe',
          p_locale: 'fr',
          p_title: 'T'.repeat(120),
          p_meta_description: 'M'.repeat(300),
          p_starter_doc: { type: 'doc', content: [] },
          p_signup_ip_masked: null,
        },
      },
    ]);
    expect(result).toEqual({
      affiliateId: AFFILIATE_ID,
      pageId: '44444444-4444-4444-8444-444444444444',
      tierId: TIER_ID,
      tierName: 'Founding Ambassador',
      tierSlug: 'founding-ambassador',
      commissionPercentage: 50,
      isLimitedTimePromo: true,
      spotsRemaining: 37,
    });
  });

  it('reports unlimited tiers as spotsRemaining null', async () => {
    const { client } = fakeSupabase(undefined, {
      data: { affiliate_id: AFFILIATE_ID, page_id: 'p', tier_id: TIER_ID, spots_remaining: null },
      error: null,
    });
    expect((await createAffiliateAccountViaRpc(client, SIGNUP_INPUT)).spotsRemaining).toBeNull();
  });

  it('refuses reserved or malformed handles, bad users and oversized documents before the RPC', async () => {
    const { client, rpcCalls } = fakeSupabase();
    const codeOf = (input: Partial<CreateAffiliateAccountInput>) =>
      createAffiliateAccountViaRpc(client, { ...SIGNUP_INPUT, ...input }).catch((error: unknown) => mapAffiliateRpcError(error));

    expect(await codeOf({ handle: 'admin' })).toBe('handle_invalid');
    expect(await codeOf({ handle: 'a' })).toBe('handle_invalid');
    expect(await codeOf({ userId: 'nobody' })).toBe('unknown');
    expect(await codeOf({ displayName: '   ' })).toBe('unknown');
    expect(await codeOf({ starterDoc: { type: 'doc', content: [{ type: 'paragraph', text: 'x'.repeat(300_000) }] } })).toBe('unknown');
    expect(rpcCalls).toHaveLength(0);
  });

  it('turns RPC errors into AffiliateAccountError codes', async () => {
    const cases: Array<[unknown, string]> = [
      [{ code: 'P0001', message: 'affiliate_exists' }, 'affiliate_exists'],
      [{ code: 'P0001', message: 'affiliate_program_full' }, 'program_full'],
      [{ code: 'P0001', message: 'affiliate_role_conflict' }, 'role_conflict'],
      [{ code: 'P0001', message: 'affiliate_handle_invalid' }, 'handle_invalid'],
      [{ code: '23505', message: 'duplicate key value violates unique constraint "affiliate_profiles_handle_key"' }, 'handle_taken'],
    ];

    for (const [error, code] of cases) {
      const { client } = fakeSupabase(undefined, { data: null, error });
      const caught = await createAffiliateAccountViaRpc(client, SIGNUP_INPUT).catch((value: unknown) => value);
      expect(caught, code).toBeInstanceOf(AffiliateAccountError);
      expect((caught as AffiliateAccountError).code).toBe(code);
      expect((caught as Error).cause).toBe(error);
    }
  });

  it('fails as unknown when the RPC returns no row', async () => {
    const { client } = fakeSupabase(undefined, { data: [], error: null });
    await expect(createAffiliateAccountViaRpc(client, SIGNUP_INPUT)).rejects.toMatchObject({ code: 'unknown' });
  });
});

describe('mapAffiliateRpcError', () => {
  it.each([
    [{ code: '23505', message: 'duplicate key', details: 'Key (handle)=(jane) already exists.' }, 'handle_taken'],
    [{ code: '23505', message: 'duplicate key value violates unique constraint "affiliate_profiles_user_id_key"' }, 'affiliate_exists'],
    [{ code: '23505', message: 'duplicate key value violates unique constraint "affiliate_pages_affiliate_id_key"' }, 'affiliate_exists'],
    [{ code: '23505', message: 'duplicate key' }, 'handle_taken'],
    [{ code: '23514', message: 'new row violates check constraint "affiliate_profiles_handle_check"' }, 'handle_invalid'],
    [{ code: '23514', message: 'new row violates check constraint "affiliate_profiles_bio_check"' }, 'unknown'],
    [{ code: 'P0001', message: 'AFFILIATE_PROGRAM_FULL' }, 'program_full'],
    [{ code: '42501', message: 'permission denied for function create_affiliate_account' }, 'unknown'],
    [new Error('network down'), 'unknown'],
    [null, 'unknown'],
    ['affiliate_exists', 'unknown'],
  ])('%j → %s', (error, code) => {
    expect(mapAffiliateRpcError(error)).toBe(code);
  });

  it('passes an AffiliateAccountError code through', () => {
    expect(mapAffiliateRpcError(new AffiliateAccountError('program_full'))).toBe('program_full');
  });
});
