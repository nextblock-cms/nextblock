import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Partner portal reads: the next-payout estimate, the catalog search (anon client, escaped ILIKE,
 * no user input in `.or()`), product resolution and the Stripe redirect guard.
 */

const mocks = vi.hoisted(() => ({
  ssgCalls: [] as Array<{ table: string; ops: Array<[string, ...unknown[]]> }>,
  ssgRows: [] as unknown[],
  ssgError: null as { message: string } | null,
  connectConfigured: true,
  /** `getAffiliatesSettings()`; without `payoutMethods` every gateway is paid through Stripe. */
  settings: { notificationEmails: [], minPayoutCents: 100, autoPayoutsEnabled: true } as Record<string, unknown>,
  /** 02037: whether the active PayPal environment's credentials resolve, and how often the loader asked. */
  paypalConfigured: true,
  paypalStatusReads: 0,
}));

function ssgClient() {
  return {
    from(table: string) {
      const call = { table, ops: [] as Array<[string, ...unknown[]]> };
      mocks.ssgCalls.push(call);
      const result = () => {
        if (table === 'currencies') {
          return { data: [{ code: 'CAD', symbol: '$', exchange_rate: 1, is_default: true, is_active: true }], error: null };
        }
        if (table === 'languages') return { data: [{ id: 1, code: 'en' }, { id: 2, code: 'fr' }], error: null };
        return { data: mocks.ssgError ? null : mocks.ssgRows, error: mocks.ssgError };
      };
      const builder: Record<string, unknown> = {};
      for (const op of ['select', 'eq', 'or', 'ilike', 'in', 'order', 'limit']) {
        builder[op] = (...args: unknown[]) => {
          call.ops.push([op, ...args]);
          return builder;
        };
      }
      builder['then'] = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(result()).then(resolve, reject);
      return builder;
    },
  };
}

vi.mock('next/cache', () => ({ unstable_cache: (fn: (...args: unknown[]) => unknown) => fn }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@nextblock-cms/db/server', () => ({ getSsgSupabaseClient: () => ssgClient() }));
// Only the currency helpers (the full commerce barrel pulls in its client components).
vi.mock('@nextblock-cms/ecommerce', () => vi.importActual('../../../../libs/ecommerce/src/lib/currency'));
// The repository helpers and payout rules portal-data uses, without the rest of the server entry
// (copilot, the payout cycle…).
vi.mock('@nextblock-cms/affiliates/server', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/repository')),
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/payouts/payout-config')),
}));
vi.mock('../storage/provider', () => ({ resolveMediaBaseUrl: () => 'https://media.test' }));
vi.mock('./image-origins', () => ({ getStorefrontImageOrigins: () => ['https://media.test'] }));
vi.mock('./settings', () => ({
  getAffiliatesSettings: async () => mocks.settings,
}));
// Whether the store has Stripe at all (the Connect service resolves the key).
vi.mock('./connect-service', () => ({ isAffiliateConnectConfigured: async () => mocks.connectConfigured }));
// 02037: the PayPal credentials' facts (booleans only; the module never hands a secret out).
vi.mock('./paypal/credentials', () => ({
  getAffiliatePayPalCredentialStatus: async () => {
    mocks.paypalStatusReads += 1;
    return { sandbox: false, environment: 'live', environmentSource: 'cms', active: { configured: mocks.paypalConfigured } };
  },
}));

import {
  buildAffiliateStorefrontUrl,
  computeAffiliateNextPayout,
  computeRetailerManualPayout,
  computeRetailerPayPalPayout,
  countRetailerPayoutRoutes,
  retailerPayoutRoutesOf,
  filterActiveAffiliateCatalogProductIds,
  hasAffiliateProfileChangedSincePublish,
  loadRetailerPayoutsData,
  normalizeAffiliateCatalogQuery,
  readAffiliateStripeRedirectUrl,
  resolveAffiliateCatalogProducts,
  retailerClearedBalanceHint,
  retailerPayoutModeOf,
  searchAffiliateCatalogProducts,
  type AffiliateNextPayoutInput,
  type RetailerManualPayoutInput,
  type RetailerPayPalPayoutInput,
  type RetailerPortalAccount,
  type RetailerPortalContext,
} from './portal-data';

const NOW = new Date('2026-10-27T15:00:00.000Z');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

function payout(overrides: Partial<AffiliateNextPayoutInput> = {}): AffiliateNextPayoutInput {
  return {
    now: NOW,
    autoPayoutsEnabled: true,
    minPayoutCents: 5000,
    clearedCents: 0,
    pending: [],
    lastRunDate: null,
    payoutsReady: true,
    eligible: true,
    ...overrides,
  };
}

function productsCall() {
  const call = mocks.ssgCalls.find((entry) => entry.table === 'products');
  if (!call) throw new Error('no products query');
  return call;
}

beforeEach(() => {
  mocks.ssgCalls.length = 0;
  mocks.ssgRows = [];
  mocks.ssgError = null;
  mocks.connectConfigured = true;
  mocks.settings = { notificationEmails: [], minPayoutCents: 100, autoPayoutsEnabled: true };
  mocks.paypalConfigured = true;
  mocks.paypalStatusReads = 0;
});

describe('computeAffiliateNextPayout', () => {
  it('is paused when automated payouts are off, whatever the balance', () => {
    expect(computeAffiliateNextPayout(payout({ autoPayoutsEnabled: false, clearedCents: 99_999 }))).toEqual({ kind: 'paused' });
  });

  it('waits for the first approval, then for a connected bank account', () => {
    expect(computeAffiliateNextPayout(payout({ eligible: false, clearedCents: 99_999 }))).toEqual({ kind: 'not_eligible' });
    expect(computeAffiliateNextPayout(payout({ payoutsReady: false, clearedCents: 99_999 }))).toEqual({ kind: 'connect_required' });
  });

  it('pays at the next daily run when the cleared balance reaches the minimum', () => {
    expect(computeAffiliateNextPayout(payout({ clearedCents: 5000 }))).toEqual({ kind: 'scheduled', date: '2026-10-27' });
    // Today's run already happened: tomorrow.
    expect(computeAffiliateNextPayout(payout({ clearedCents: 5000, lastRunDate: '2026-10-27' }))).toEqual({
      kind: 'scheduled',
      date: '2026-10-28',
    });
    expect(computeAffiliateNextPayout(payout({ clearedCents: 5000, lastRunDate: '2026-10-26' }))).toEqual({
      kind: 'scheduled',
      date: '2026-10-27',
    });
  });

  it('otherwise waits for the run after the commission that brings the balance to the minimum clears', () => {
    const estimate = computeAffiliateNextPayout(
      payout({
        clearedCents: 1000,
        // Unsorted on purpose; amounts are net of refunds.
        pending: [
          { amountCents: 3000, clearsAt: '2026-11-20T10:00:00.000Z' },
          { amountCents: 2000, clearsAt: '2026-11-03T08:30:00.000Z' },
          { amountCents: 500, clearsAt: '2026-11-01T23:59:00.000Z' },
        ],
      }),
    );
    // 1000 + 500 (Nov 1) + 2000 (Nov 3) = 3500 < 5000; + 3000 (Nov 20) = 6500: the run of Nov 21.
    expect(estimate).toEqual({ kind: 'scheduled', date: '2026-11-21' });
  });

  it('counts a pending commission whose clearance date already passed at the next run', () => {
    const estimate = computeAffiliateNextPayout(
      payout({ pending: [{ amountCents: 6000, clearsAt: '2026-10-20T00:00:00.000Z' }], lastRunDate: '2026-10-27' }),
    );
    expect(estimate).toEqual({ kind: 'scheduled', date: '2026-10-28' });
  });

  it('reports what is missing below the minimum, or no balance at all', () => {
    expect(
      computeAffiliateNextPayout(payout({ clearedCents: 1200, pending: [{ amountCents: 800, clearsAt: '2026-11-01T00:00:00Z' }] })),
    ).toEqual({ kind: 'below_minimum', remainingCents: 3000 });
    expect(computeAffiliateNextPayout(payout())).toEqual({ kind: 'no_balance' });
  });

  it('ignores invalid pending rows and never divides a zero minimum', () => {
    expect(
      computeAffiliateNextPayout(
        payout({ minPayoutCents: 0, pending: [{ amountCents: -5, clearsAt: 'not a date' }, { amountCents: 1, clearsAt: null }] }),
      ),
    ).toEqual({ kind: 'no_balance' });
  });
});

describe('searchAffiliateCatalogProducts', () => {
  it('escapes LIKE wildcards before the ILIKE and keeps user input out of .or()', async () => {
    await searchAffiliateCatalogProducts({ query: '50%_off\\ *deal*', locale: 'en' });
    const call = productsCall();
    const ilike = call.ops.find(([op]) => op === 'ilike');
    expect(ilike).toEqual(['ilike', 'title', '%50\\%\\_off\\\\ deal%']);
    const ors = call.ops.filter(([op]) => op === 'or');
    expect(ors).toHaveLength(1);
    expect(String(ors[0]?.[1])).toMatch(/^published_at\.is\.null,published_at\.lte\.\d{4}-/);
    expect(String(ors[0]?.[1])).not.toContain('off');
    expect(call.ops).toContainEqual(['eq', 'status', 'active']);
  });

  it('lists the newest active products without a filter for an empty query', async () => {
    await searchAffiliateCatalogProducts({ query: '   ', locale: 'en' });
    expect(productsCall().ops.some(([op]) => op === 'ilike')).toBe(false);
  });

  it('maps rows to picker products: one per translation group (visitor language first), price in the base currency', async () => {
    mocks.ssgRows = [
      { id: A.toUpperCase(), title: 'T-shirt', price: 2500, language_id: 1, translation_group_id: 'g1', product_media: [] },
      {
        id: B,
        title: 'Chandail',
        price: 2500,
        language_id: 2,
        translation_group_id: 'g1',
        product_media: [{ sort_order: 0, media: { object_key: 'uploads/shirt.webp', file_path: null } }],
      },
      { id: C, title: 'Mug', price: 1200, sale_price: 900, language_id: 1, translation_group_id: 'g2', product_media: [] },
      { id: 'not-a-uuid', title: 'Broken', price: 1, language_id: 1, translation_group_id: 'g3' },
    ];
    const products = await searchAffiliateCatalogProducts({ query: '', locale: 'fr' });
    expect(products).toEqual([
      { id: B, title: 'Chandail', imageUrl: 'https://media.test/uploads/shirt.webp', priceLabel: expect.stringContaining('25,00') },
      { id: C, title: 'Mug', imageUrl: null, priceLabel: expect.stringContaining('9,00') },
    ]);
  });

  it('throws on a database error (the action answers with a generic failure)', async () => {
    mocks.ssgError = { message: 'permission denied for table products' };
    await expect(searchAffiliateCatalogProducts({ query: 'x', locale: 'en' })).rejects.toThrow('affiliate_catalog_search_failed');
  });

  it('normalizes the query (control characters, whitespace, 100 characters)', () => {
    expect(normalizeAffiliateCatalogQuery(`  a\u0000b\n\tc  ${'z'.repeat(200)}`)).toHaveLength(100);
    expect(normalizeAffiliateCatalogQuery('  a\u0000b\n\tc ')).toBe('a b c');
    expect(normalizeAffiliateCatalogQuery(42)).toBe('');
  });
});

describe('resolveAffiliateCatalogProducts / filterActiveAffiliateCatalogProductIds', () => {
  it('asks only for uuids (deduplicated, at most 48) and keeps the requested order', async () => {
    mocks.ssgRows = [
      { id: C, title: 'Mug', price: 1200, language_id: 1, translation_group_id: 'g2' },
      { id: A, title: 'T-shirt', price: 2500, language_id: 1, translation_group_id: 'g1' },
    ];
    const products = await resolveAffiliateCatalogProducts({ ids: [A, 'drop table', C, A.toUpperCase(), B], locale: 'en' });
    expect(productsCall().ops).toContainEqual(['in', 'id', [A, C, B]]);
    expect(products.map((product) => product.id)).toEqual([A, C]);
  });

  it('returns nothing without a query for no valid id', async () => {
    expect(await resolveAffiliateCatalogProducts({ ids: ['x', ''], locale: 'en' })).toEqual([]);
    expect(await filterActiveAffiliateCatalogProductIds(['x'])).toEqual([]);
    expect(mocks.ssgCalls).toHaveLength(0);
  });

  it('keeps only active public products for featured ids', async () => {
    mocks.ssgRows = [{ id: B }];
    expect(await filterActiveAffiliateCatalogProductIds([A, B])).toEqual([B]);
    expect(productsCall().ops).toContainEqual(['eq', 'status', 'active']);
  });
});

describe('readAffiliateStripeRedirectUrl', () => {
  it('accepts https Stripe URLs from a string or a { ok, url } result', () => {
    expect(readAffiliateStripeRedirectUrl('https://connect.stripe.com/setup/e/acct_1/abc')).toBe('https://connect.stripe.com/setup/e/acct_1/abc');
    expect(readAffiliateStripeRedirectUrl({ ok: true, url: 'https://connect.stripe.com/express/x' })).toBe('https://connect.stripe.com/express/x');
  });

  it('refuses anything that could become an open redirect', () => {
    for (const value of [
      'http://connect.stripe.com/x',
      'https://stripe.com.evil.test/x',
      'https://evilstripe.com/x',
      'https://user:pw@connect.stripe.com/x',
      'https://connect.stripe.com:8443/x',
      'javascript:alert(1)',
      '/portal/retailer',
      { ok: false, error: 'unknown' },
      { ok: true, url: 42 },
      null,
    ]) {
      expect(readAffiliateStripeRedirectUrl(value)).toBeNull();
    }
  });
});

describe('profile snapshot and storefront URL', () => {
  const profile = {
    display_name: 'Jane',
    bio: 'Bio',
    avatar_object_key: 'affiliates/avatars/a/1.jpg',
    social_links: { instagram: 'https://instagram.com/jane', website: 'https://jane.test/' },
    preferred_locale: 'en',
  };

  it('compares the live profile with the approved snapshot (link order does not matter)', () => {
    const published = { ...profile, social_links: { website: 'https://jane.test/', instagram: 'https://instagram.com/jane' } };
    expect(hasAffiliateProfileChangedSincePublish(profile, published)).toBe(false);
    expect(hasAffiliateProfileChangedSincePublish({ ...profile, bio: 'New bio' }, published)).toBe(true);
    expect(hasAffiliateProfileChangedSincePublish({ ...profile, avatar_object_key: null }, published)).toBe(true);
    expect(hasAffiliateProfileChangedSincePublish(profile, null)).toBe(true);
  });

  it('counts a language-only change once the snapshot records a language', () => {
    const published = { ...profile, locale: 'en' as const };
    expect(hasAffiliateProfileChangedSincePublish(profile, published)).toBe(false);
    expect(hasAffiliateProfileChangedSincePublish({ ...profile, preferred_locale: 'fr' }, published)).toBe(true);
    // A snapshot approved before the field existed never differs on language alone.
    expect(hasAffiliateProfileChangedSincePublish({ ...profile, preferred_locale: 'fr' }, profile)).toBe(false);
  });

  it('builds the public storefront address', () => {
    expect(buildAffiliateStorefrontUrl('https://shop.test/', 'jane-picks')).toBe('https://shop.test/partners/jane-picks');
  });
});

describe('loadRetailerPayoutsData: the Connect card', () => {
  // A ledger client that cannot be read: the page still gets its Connect state (and a ledger notice).
  const ctx = {
    supabase: {
      from: () => {
        throw new Error('ledger unreachable');
      },
    },
    actor: {},
  } as unknown as RetailerPortalContext;

  function account(overrides: Record<string, unknown> = {}): RetailerPortalAccount {
    return {
      profile: {
        id: A,
        tier_id: B,
        status: 'ACTIVE',
        first_published_at: '2026-10-01T00:00:00.000Z',
        stripe_connect_account_id: null,
        stripe_connect_onboarding_complete: false,
        ...overrides,
      },
      page: null,
    } as unknown as RetailerPortalAccount;
  }

  it('says bank payouts are unavailable, and the next payout paused, while the store has no Stripe account', async () => {
    mocks.connectConfigured = false;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const data = await loadRetailerPayoutsData(ctx, account(), NOW);
    const connected = await loadRetailerPayoutsData(ctx, account({ stripe_connect_account_id: 'acct_1', stripe_connect_onboarding_complete: true }), NOW);

    expect(data.connect).toBe('unavailable');
    expect(data.nextPayout).toEqual({ kind: 'paused' });
    expect(connected.connect).toBe('unavailable');
    warn.mockRestore();
  });

  it('shows the partner’s own Connect state once Stripe is set up', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect((await loadRetailerPayoutsData(ctx, account(), NOW)).connect).toBe('not_connected');
    expect((await loadRetailerPayoutsData(ctx, account({ stripe_connect_account_id: 'acct_1' }), NOW)).connect).toBe('incomplete');
    const ready = await loadRetailerPayoutsData(ctx, account({ stripe_connect_account_id: 'acct_1', stripe_connect_onboarding_complete: true }), NOW);
    expect(ready.connect).toBe('ready');
    expect(ready.nextPayout).not.toEqual({ kind: 'paused' });
    warn.mockRestore();
  });
});

describe('retailerClearedBalanceHint', () => {
  const none = { autoRetryCents: 0, awaitingReviewCents: 0, autoRetryPayoutIds: [] };

  it('names the minimum payout when nothing is attached to a payout', () => {
    expect(retailerClearedBalanceHint(0, none)).toEqual({ kind: 'minimum' });
  });

  it('says money in a running transfer is on its way', () => {
    expect(retailerClearedBalanceHint(4500, none)).toEqual({ kind: 'on_its_way', amountCents: 4500 });
  });

  it('never calls a failed payout "on its way"', () => {
    expect(retailerClearedBalanceHint(2900, { autoRetryCents: 2900, awaitingReviewCents: 0, autoRetryPayoutIds: [A] })).toEqual({
      kind: 'failed_auto_retry',
      amountCents: 2900,
    });
    expect(retailerClearedBalanceHint(2900, { autoRetryCents: 0, awaitingReviewCents: 2900, autoRetryPayoutIds: [] })).toEqual({
      kind: 'failed_awaiting_review',
      amountCents: 2900,
    });
  });

  it('promises no automatic retry as soon as one failed payout waits for an admin', () => {
    expect(retailerClearedBalanceHint(4400, { autoRetryCents: 1000, awaitingReviewCents: 2900, autoRetryPayoutIds: [A] })).toEqual({
      kind: 'failed_awaiting_review',
      amountCents: 3900,
    });
  });

  it('says a payout the store prepared (02036) is being sent to the partner, not to their bank through Stripe', () => {
    expect(retailerClearedBalanceHint(3000, none, 3000)).toEqual({ kind: 'on_its_way_manual', amountCents: 3000 });
    // a Stripe transfer running at the same time comes first, for its own part only
    expect(retailerClearedBalanceHint(4500, none, 3000)).toEqual({ kind: 'on_its_way', amountCents: 1500 });
    // never more than what is attached
    expect(retailerClearedBalanceHint(1000, none, 3000)).toEqual({ kind: 'on_its_way_manual', amountCents: 1000 });
  });
});

describe('loadRetailerPayoutsData: failed payouts', () => {
  const REVIEW = '44444444-4444-4444-8444-444444444444';
  const RETRY = '55555555-5555-4555-8555-555555555555';
  const RUNNING = '66666666-6666-4666-8666-666666666666';
  const STAMP = '2026-10-20T06:00:00.000Z';

  function payoutRow(id: string, status: string, failureReason: string | null, attemptCount: number) {
    return {
      id,
      affiliate_id: A,
      amount_cents: 0,
      currency: 'CAD',
      stripe_destination_account: 'acct_1',
      stripe_transfer_id: null,
      livemode: true,
      status,
      attempt_count: attemptCount,
      last_attempt_at: STAMP,
      failure_reason: failureReason,
      trigger: 'cron',
      paid_at: null,
      created_at: STAMP,
      updated_at: STAMP,
    };
  }

  function commissionRow(id: string, payoutId: string | null, amount: number, refunded = 0) {
    return {
      id,
      affiliate_id: A,
      status: 'CLEARED',
      currency: 'CAD',
      commission_amount_cents: amount,
      refunded_amount_cents: refunded,
      payout_id: payoutId,
      clears_at: STAMP,
      created_at: STAMP,
      updated_at: STAMP,
    };
  }

  // Automatic retries ran out on REVIEW; RETRY failed once on a short balance; RUNNING is in flight.
  const PAYOUTS = [
    payoutRow(REVIEW, 'FAILED', 'balance_insufficient', 5),
    payoutRow(RETRY, 'FAILED', 'balance_insufficient', 1),
    payoutRow(RUNNING, 'PROCESSING', null, 1),
  ];
  const COMMISSIONS = [
    commissionRow(B, REVIEW, 2900),
    commissionRow(C, RETRY, 1200, 200),
    commissionRow('77777777-7777-4777-8777-777777777777', RUNNING, 500),
    commissionRow('88888888-8888-4888-8888-888888888888', null, 12500),
  ];

  /** A ledger client that applies `.eq()` / `.in()` filters to the rows above. */
  function ledgerClient() {
    return {
      from(table: string) {
        const filters: Array<(row: Record<string, unknown>) => boolean> = [];
        const builder: Record<string, unknown> = {};
        for (const op of ['select', 'order', 'range', 'limit']) builder[op] = () => builder;
        // The tier read: no tier row here (the page falls back to the defaults).
        builder['maybeSingle'] = async () => ({ data: null, error: null });
        builder['eq'] = (column: string, value: unknown) => {
          filters.push((row) => row[column] === value);
          return builder;
        };
        builder['in'] = (column: string, values: unknown[]) => {
          filters.push((row) => values.includes(row[column]));
          return builder;
        };
        builder['then'] = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
          const source: Array<Record<string, unknown>> =
            table === 'affiliate_payouts' ? PAYOUTS : table === 'affiliate_commissions' ? COMMISSIONS : [];
          const rows = source.filter((row) => filters.every((keep) => keep(row)));
          return Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve, reject);
        };
        return builder;
      },
    };
  }

  const ctx = { supabase: ledgerClient(), actor: {} } as unknown as RetailerPortalContext;

  function account(overrides: Record<string, unknown> = {}): RetailerPortalAccount {
    return {
      profile: {
        id: A,
        tier_id: B,
        status: 'ACTIVE',
        first_published_at: '2026-10-01T00:00:00.000Z',
        stripe_connect_account_id: 'acct_1',
        stripe_connect_onboarding_complete: true,
        ...overrides,
      },
      page: null,
    } as unknown as RetailerPortalAccount;
  }

  it('splits the money held by failed payouts from what is really on its way', async () => {
    const data = await loadRetailerPayoutsData(ctx, account(), NOW);

    expect(data.ledgerError).toBe(false);
    expect(data.balances.primary.processingCents).toBe(4400);
    expect(data.failedPayouts).toEqual({ autoRetryCents: 1000, awaitingReviewCents: 2900, autoRetryPayoutIds: [RETRY] });
    expect(retailerClearedBalanceHint(data.balances.primary.processingCents, data.failedPayouts)).toEqual({
      kind: 'failed_awaiting_review',
      amountCents: 3900,
    });
  });

  it('promises no automatic retry while payouts cannot run or the partner cannot be paid', async () => {
    mocks.connectConfigured = false;
    const noStripe = await loadRetailerPayoutsData(ctx, account(), NOW);
    mocks.connectConfigured = true;
    const noAccount = await loadRetailerPayoutsData(ctx, account({ stripe_connect_account_id: null }), NOW);
    const suspended = await loadRetailerPayoutsData(ctx, account({ status: 'SUSPENDED' }), NOW);
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const sandbox = await loadRetailerPayoutsData(ctx, account(), NOW);
    vi.unstubAllEnvs();

    for (const data of [noStripe, noAccount, suspended, sandbox]) {
      expect(data.failedPayouts).toEqual({ autoRetryCents: 0, awaitingReviewCents: 3900, autoRetryPayoutIds: [] });
    }
  });

  it('promises no automatic retry once every gateway is paid by hand (the daily run then only repairs the ledger)', async () => {
    mocks.settings = { ...mocks.settings, payoutMethods: { stripeSales: 'manual', freemiusSales: 'manual' } };
    const data = await loadRetailerPayoutsData(ctx, account(), NOW);
    expect(data.failedPayouts).toEqual({ autoRetryCents: 0, awaitingReviewCents: 3900, autoRetryPayoutIds: [] });
  });
});

describe('retailerPayoutModeOf / computeRetailerManualPayout (02036)', () => {
  it('tells every-gateway-through-Stripe (also without the field), every-gateway-by-hand and mixed apart', () => {
    expect(retailerPayoutModeOf({})).toBe('stripe');
    expect(retailerPayoutModeOf(null)).toBe('stripe');
    expect(retailerPayoutModeOf({ payoutMethods: { stripeSales: 'stripe_connect', freemiusSales: 'stripe_connect' } })).toBe('stripe');
    expect(retailerPayoutModeOf({ payoutMethods: { stripeSales: 'manual', freemiusSales: 'manual' } })).toBe('manual');
    expect(retailerPayoutModeOf({ payoutMethods: { stripeSales: 'stripe_connect', freemiusSales: 'manual' } })).toBe('mixed');
    expect(retailerPayoutModeOf({ payoutMethods: { stripeSales: 'manual', freemiusSales: 'stripe_connect' } })).toBe('mixed');
  });

  function manual(overrides: Partial<RetailerManualPayoutInput> = {}): RetailerManualPayoutInput {
    return { now: NOW, minPayoutCents: 5000, clearedCents: 0, pending: [], eligible: true, hasPayoutEmail: true, ...overrides };
  }

  it('waits for the first approval, then for a payout email, whatever the balance', () => {
    expect(computeRetailerManualPayout(manual({ eligible: false, clearedCents: 9000 }))).toEqual({ kind: 'not_eligible' });
    expect(computeRetailerManualPayout(manual({ hasPayoutEmail: false, clearedCents: 9000 }))).toEqual({ kind: 'email_required' });
    expect(computeRetailerManualPayout(manual({ hasPayoutEmail: false }))).toEqual({ kind: 'email_required' });
  });

  it('is ready at the minimum, clearing when pending commissions reach it, and never names a date', () => {
    expect(computeRetailerManualPayout(manual({ clearedCents: 5000 }))).toEqual({ kind: 'ready' });
    expect(
      computeRetailerManualPayout(manual({ clearedCents: 2000, pending: [{ amountCents: 3000, clearsAt: '2026-11-20T00:00:00.000Z' }] })),
    ).toEqual({ kind: 'clearing' });
    expect(
      computeRetailerManualPayout(manual({ clearedCents: 1000, pending: [{ amountCents: 1500, clearsAt: '2026-11-20T00:00:00.000Z' }] })),
    ).toEqual({ kind: 'below_minimum', remainingCents: 2500 });
    expect(computeRetailerManualPayout(manual())).toEqual({ kind: 'no_balance' });
  });

  it('says a payout the store prepared is being sent before anything else (02036)', () => {
    expect(computeRetailerManualPayout(manual({ sendingCents: 3000 }))).toEqual({ kind: 'sending', amountCents: 3000 });
    // prepared before the partner was paused or removed their email: still on its way
    expect(computeRetailerManualPayout(manual({ sendingCents: 3000, eligible: false, hasPayoutEmail: false }))).toEqual({
      kind: 'sending',
      amountCents: 3000,
    });
    expect(computeRetailerManualPayout(manual({ sendingCents: 0, clearedCents: 5000 }))).toEqual({ kind: 'ready' });
  });
});

describe('loadRetailerPayoutsData: how each commission is paid (02036)', () => {
  const STAMP = '2026-10-20T06:00:00.000Z';
  const LATER = '2026-11-02T00:00:00.000Z';
  const STRIPE_PAYOUT = '44444444-4444-4444-8444-444444444444';
  const MANUAL_PAYOUT = '55555555-5555-4555-8555-555555555555';
  const OLD_MANUAL_PAYOUT = '66666666-6666-4666-8666-666666666666';

  function commission(id: string, gateway: string, status: string, amount: number, extra: Record<string, unknown> = {}) {
    return {
      id,
      affiliate_id: A,
      order_id: B,
      gateway,
      status,
      currency: 'CAD',
      commission_amount_cents: amount,
      refunded_amount_cents: 0,
      commission_rate_snapshot: 10,
      payout_id: null,
      clears_at: STAMP,
      created_at: STAMP,
      updated_at: STAMP,
      ...extra,
    };
  }

  function payoutRow(id: string, method: string, extra: Record<string, unknown> = {}) {
    return {
      id,
      affiliate_id: A,
      amount_cents: 1000,
      currency: 'CAD',
      stripe_destination_account: method === 'manual' ? null : 'acct_1',
      stripe_transfer_id: method === 'manual' ? null : 'tr_1',
      livemode: true,
      status: 'COMPLETED',
      attempt_count: 1,
      last_attempt_at: STAMP,
      failure_reason: null,
      trigger: method === 'manual' ? 'admin' : 'cron',
      paid_at: STAMP,
      method,
      manual_channel: method === 'manual' ? 'paypal' : null,
      external_reference: method === 'manual' ? '5TY12345' : null,
      created_at: STAMP,
      updated_at: STAMP,
      ...extra,
    };
  }

  // Cleared: 1200 on a Stripe sale, 6000 on Freemius sales (one 500 refunded); pending: 900 on each;
  // an older PAID one through a manual payout that is not on the page (only its commission is).
  const COMMISSIONS = [
    commission('c1000000-0000-4000-8000-000000000001', 'STRIPE', 'CLEARED', 1200),
    commission('c1000000-0000-4000-8000-000000000002', 'FREEMIUS', 'CLEARED', 4000),
    commission('c1000000-0000-4000-8000-000000000003', 'FREEMIUS', 'CLEARED', 2500, { refunded_amount_cents: 500 }),
    commission('c1000000-0000-4000-8000-000000000004', 'STRIPE', 'PENDING_CLEARANCE', 900, { clears_at: LATER }),
    commission('c1000000-0000-4000-8000-000000000005', 'FREEMIUS', 'PENDING_CLEARANCE', 900, { clears_at: LATER }),
    commission('c1000000-0000-4000-8000-000000000006', 'STRIPE', 'PAID', 1000, { payout_id: STRIPE_PAYOUT }),
    commission('c1000000-0000-4000-8000-000000000007', 'FREEMIUS', 'PAID', 1000, { payout_id: MANUAL_PAYOUT }),
    commission('c1000000-0000-4000-8000-000000000008', 'FREEMIUS', 'PAID', 700, { payout_id: OLD_MANUAL_PAYOUT }),
    commission('c1000000-0000-4000-8000-000000000009', 'FREEMIUS', 'VOIDED_REFUND', 300),
  ];
  const PAYOUTS_ON_PAGE = [payoutRow(STRIPE_PAYOUT, 'stripe_connect'), payoutRow(MANUAL_PAYOUT, 'manual')];
  const ALL_PAYOUTS = [...PAYOUTS_ON_PAGE, payoutRow(OLD_MANUAL_PAYOUT, 'manual')];

  /** A ledger client applying `.eq()` / `.in()` filters; the payout list (status-free) shows only the page's two payouts. */
  function ledgerClient(calls: Array<{ table: string; columns: string }>) {
    return {
      from(table: string) {
        const filters: Array<(row: Record<string, unknown>) => boolean> = [];
        let columns = '';
        const builder: Record<string, unknown> = {};
        builder['select'] = (selected: string) => {
          columns = selected;
          return builder;
        };
        for (const op of ['order', 'range', 'limit']) builder[op] = () => builder;
        builder['maybeSingle'] = async () => ({ data: null, error: null });
        builder['eq'] = (column: string, value: unknown) => {
          filters.push((row) => row[column] === value);
          return builder;
        };
        builder['in'] = (column: string, values: unknown[]) => {
          filters.push((row) => values.includes(row[column]));
          return builder;
        };
        builder['then'] = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
          calls.push({ table, columns });
          const source: Array<Record<string, unknown>> =
            table === 'affiliate_payouts'
              ? columns === 'id, method'
                ? ALL_PAYOUTS
                : PAYOUTS_ON_PAGE
              : table === 'affiliate_commissions'
                ? COMMISSIONS
                : [];
          const rows = source.filter((row) => filters.every((keep) => keep(row)));
          return Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve, reject);
        };
        return builder;
      },
    };
  }

  function account(overrides: Record<string, unknown> = {}): RetailerPortalAccount {
    return {
      profile: {
        id: A,
        tier_id: B,
        status: 'ACTIVE',
        first_published_at: '2026-10-01T00:00:00.000Z',
        stripe_connect_account_id: 'acct_1',
        stripe_connect_onboarding_complete: true,
        payout_email: 'jane@paypal.example',
        ...overrides,
      },
      page: null,
    } as unknown as RetailerPortalAccount;
  }

  async function load(payoutMethods: Record<string, string> | undefined, profile: Record<string, unknown> = {}) {
    mocks.settings = { notificationEmails: [], minPayoutCents: 5000, autoPayoutsEnabled: true, ...(payoutMethods ? { payoutMethods } : {}) };
    const calls: Array<{ table: string; columns: string }> = [];
    const data = await loadRetailerPayoutsData({ supabase: ledgerClient(calls), actor: {} } as unknown as RetailerPortalContext, account(profile), NOW);
    return { data, calls };
  }

  it('keeps a Stripe-only program as it was: one estimate over every gateway, no manual figure, no Payout column', async () => {
    const { data, calls } = await load(undefined);
    expect(data.ledgerError).toBe(false);
    expect(data.payoutMode).toBe('stripe');
    expect(data.manualPayout).toBeNull();
    expect(data.commissionPayoutMethods).toEqual({});
    expect(data.clearedByMethod).toEqual({ stripeCents: 7200, paypalCents: 0, manualCents: 0 });
    expect(data.payoutRoutes).toEqual({ stripe: true, paypal: false, manual: false });
    // 7200 cleared reaches the 5000 minimum: the next daily run (none ran today).
    expect(data.nextPayout).toEqual({ kind: 'scheduled', date: '2026-10-27' });
    expect(calls.some((call) => call.columns === 'id, method')).toBe(false);
    // No gateway paid with PayPal (02037): no PayPal figure, and the PayPal credentials are never read.
    expect(data.paypalGateways).toEqual([]);
    expect(data.paypalPayout).toBeNull();
    expect(mocks.paypalStatusReads).toBe(0);
  });

  it('pays a Stripe transfer only from the gateways Stripe pays, and lets the store send the rest (mixed)', async () => {
    const { data } = await load({ stripeSales: 'stripe_connect', freemiusSales: 'manual' });
    expect(data.payoutMode).toBe('mixed');
    expect(data.payoutMethods).toEqual({ stripeSales: 'stripe_connect', freemiusSales: 'manual' });
    expect(data.payoutEmail).toBe('jane@paypal.example');
    expect(data.clearedByMethod).toEqual({ stripeCents: 1200, paypalCents: 0, manualCents: 6000 });
    expect(data.payoutRoutes).toEqual({ stripe: true, paypal: false, manual: true });
    // Stripe: 1200 cleared + 900 pending stays under 5000, although the whole cleared balance is over it.
    expect(data.nextPayout).toEqual({ kind: 'below_minimum', remainingCents: 2900 });
    expect(data.manualPayout).toEqual({ kind: 'ready' });
  });

  it('says how each listed commission is or was paid in a mixed program, reading payouts that are not on the page', async () => {
    const { data, calls } = await load({ stripeSales: 'stripe_connect', freemiusSales: 'manual' });
    expect(data.commissionPayoutMethods).toEqual({
      'c1000000-0000-4000-8000-000000000001': 'stripe_connect',
      'c1000000-0000-4000-8000-000000000002': 'manual',
      'c1000000-0000-4000-8000-000000000003': 'manual',
      'c1000000-0000-4000-8000-000000000004': 'stripe_connect',
      'c1000000-0000-4000-8000-000000000005': 'manual',
      'c1000000-0000-4000-8000-000000000006': 'stripe_connect',
      'c1000000-0000-4000-8000-000000000007': 'manual',
      'c1000000-0000-4000-8000-000000000008': 'manual',
    });
    // One lookup, for the payout the page does not hold.
    expect(calls.filter((call) => call.columns === 'id, method')).toHaveLength(1);
  });

  it('has no Stripe estimate once every gateway is paid by hand, and asks for a payout email first', async () => {
    const methods = { stripeSales: 'manual', freemiusSales: 'manual' };
    const withEmail = await load(methods);
    expect(withEmail.data.payoutMode).toBe('manual');
    expect(withEmail.data.nextPayout).toBeNull();
    expect(withEmail.data.clearedByMethod).toEqual({ stripeCents: 0, paypalCents: 0, manualCents: 7200 });
    expect(withEmail.data.manualPayout).toEqual({ kind: 'ready' });
    expect(withEmail.data.commissionPayoutMethods).toEqual({});

    for (const payout_email of [null, '   ', undefined]) {
      const { data } = await load(methods, { payout_email });
      expect(data.payoutEmail).toBeNull();
      expect(data.manualPayout).toEqual({ kind: 'email_required' });
    }
    const paused = await load(methods, { status: 'SUSPENDED' });
    expect(paused.data.manualPayout).toEqual({ kind: 'not_eligible' });
  });

  it('reads the payouts the store prepared (02036) as being sent, also once their gateway went back to Stripe', async () => {
    const prepared = payoutRow('77777777-7777-4777-8777-777777777777', 'manual', {
      status: 'PROCESSING',
      amount_cents: 3000,
      paid_at: null,
      manual_channel: null,
      external_reference: null,
    });
    PAYOUTS_ON_PAGE.push(prepared);
    try {
      const manual = await load({ stripeSales: 'manual', freemiusSales: 'manual' });
      expect(manual.data.manualSendingCents).toBe(3000);
      expect(manual.data.manualPayout).toEqual({ kind: 'sending', amountCents: 3000 });
      expect(manual.calls).toContainEqual({ table: 'affiliate_payouts', columns: 'amount_cents, method, paypal_item_status, paypal_receiver' });
      // A prepared manual payout is not a PayPal payout in flight (02037).
      expect(manual.data.paypalSendingCents).toBe(0);
      expect(manual.data.paypalPayout).toBeNull();

      const stripeOnly = await load({ stripeSales: 'stripe_connect', freemiusSales: 'stripe_connect' });
      expect(stripeOnly.data.payoutMode).toBe('stripe');
      expect(stripeOnly.data.manualPayout).toEqual({ kind: 'sending', amountCents: 3000 });
    } finally {
      PAYOUTS_ON_PAGE.pop();
    }
    const none = await load({ stripeSales: 'stripe_connect', freemiusSales: 'stripe_connect' });
    expect(none.data.manualSendingCents).toBe(0);
    expect(none.data.manualPayout).toBeNull();
  });
});

describe('computeRetailerPayPalPayout / retailerPayoutRoutesOf / retailerClearedBalanceHint (02037)', () => {
  function paypal(overrides: Partial<RetailerPayPalPayoutInput> = {}): RetailerPayPalPayoutInput {
    return { now: NOW, autoPayoutsEnabled: true, minPayoutCents: 5000, clearedCents: 0, pending: [], lastRunDate: null, eligible: true, ...overrides };
  }

  it('says a payout PayPal holds first: waiting to be claimed (with the address), else on its way', () => {
    expect(computeRetailerPayPalPayout(paypal({ sendingCents: 4500, unclaimed: { amountCents: 4500, email: 'jane@paypal.example' }, clearedCents: 9000 }))).toEqual({
      kind: 'unclaimed',
      amountCents: 4500,
      email: 'jane@paypal.example',
    });
    expect(computeRetailerPayPalPayout(paypal({ sendingCents: 4500, clearedCents: 9000 }))).toEqual({ kind: 'sending', amountCents: 4500 });
    // in flight even while payouts are paused or the partner is suspended: PayPal still has it
    expect(computeRetailerPayPalPayout(paypal({ sendingCents: 4500, autoPayoutsEnabled: false, eligible: false }))).toEqual({
      kind: 'sending',
      amountCents: 4500,
    });
  });

  it('follows the daily run otherwise: paused, not eligible, the next run at the minimum, after the clearing commission, or what is missing', () => {
    expect(computeRetailerPayPalPayout(paypal({ autoPayoutsEnabled: false, clearedCents: 9000 }))).toEqual({ kind: 'paused' });
    expect(computeRetailerPayPalPayout(paypal({ eligible: false, clearedCents: 9000 }))).toEqual({ kind: 'not_eligible' });
    expect(computeRetailerPayPalPayout(paypal({ clearedCents: 5000 }))).toEqual({ kind: 'scheduled', date: '2026-10-27' });
    expect(computeRetailerPayPalPayout(paypal({ clearedCents: 5000, lastRunDate: '2026-10-27' }))).toEqual({ kind: 'scheduled', date: '2026-10-28' });
    expect(
      computeRetailerPayPalPayout(paypal({ clearedCents: 2000, pending: [{ amountCents: 3000, clearsAt: '2026-11-20T12:00:00.000Z' }] })),
    ).toEqual({ kind: 'scheduled', date: '2026-11-21' });
    expect(computeRetailerPayPalPayout(paypal({ clearedCents: 1000 }))).toEqual({ kind: 'below_minimum', remainingCents: 4000 });
    expect(computeRetailerPayPalPayout(paypal())).toEqual({ kind: 'no_balance' });
    // A PayPal account needs no Connect setup: never "connect your bank".
    expect(JSON.stringify(computeRetailerPayPalPayout(paypal({ clearedCents: 9000 })))).not.toContain('connect_required');
  });

  it('routes each gateway through Stripe, PayPal (only when PayPal can pay this partner) or by hand', () => {
    expect(retailerPayoutRoutesOf(['STRIPE', 'FREEMIUS'], [])).toEqual({ stripe: true, paypal: false, manual: false });
    expect(retailerPayoutRoutesOf(['STRIPE'], ['FREEMIUS'])).toEqual({ stripe: true, paypal: true, manual: false });
    // the PayPal gateway of a partner PayPal cannot pay (Interac, none, returned) is paid by hand
    expect(retailerPayoutRoutesOf(['STRIPE'], [])).toEqual({ stripe: true, paypal: false, manual: true });
    expect(retailerPayoutRoutesOf([], ['STRIPE', 'FREEMIUS'])).toEqual({ stripe: false, paypal: true, manual: false });
    expect(retailerPayoutRoutesOf([], ['FREEMIUS'])).toEqual({ stripe: false, paypal: true, manual: true });
    expect(countRetailerPayoutRoutes({ stripe: true, paypal: true, manual: false })).toBe(2);
    expect(countRetailerPayoutRoutes({ stripe: false, paypal: false, manual: true })).toBe(1);
  });

  it('words a PayPal payout in flight in the cleared card: a Stripe transfer first, then waiting to be claimed, then on its way, then a manual one', () => {
    const none = { autoRetryCents: 0, awaitingReviewCents: 0, autoRetryPayoutIds: [] };
    expect(retailerClearedBalanceHint(4500, none, 0, { sendingCents: 4500 })).toEqual({ kind: 'on_its_way_paypal', amountCents: 4500 });
    expect(retailerClearedBalanceHint(4500, none, 0, { sendingCents: 4500, unclaimedCents: 4500 })).toEqual({
      kind: 'waiting_claim_paypal',
      amountCents: 4500,
    });
    // a Stripe transfer running at the same time comes first, for its own part only
    expect(retailerClearedBalanceHint(6000, none, 0, { sendingCents: 4500 })).toEqual({ kind: 'on_its_way', amountCents: 1500 });
    // a PayPal payout before a prepared manual one; never more than what is attached
    expect(retailerClearedBalanceHint(7500, none, 3000, { sendingCents: 4500 })).toEqual({ kind: 'on_its_way_paypal', amountCents: 4500 });
    expect(retailerClearedBalanceHint(1000, none, 0, { sendingCents: 4500, unclaimedCents: 4500 })).toEqual({
      kind: 'waiting_claim_paypal',
      amountCents: 1000,
    });
    expect(retailerClearedBalanceHint(3000, none, 3000, { sendingCents: 0 })).toEqual({ kind: 'on_its_way_manual', amountCents: 3000 });
  });
});

describe('loadRetailerPayoutsData: PayPal Payouts (02037)', () => {
  const STAMP = '2026-10-20T06:00:00.000Z';
  const LATER = '2026-11-02T00:00:00.000Z';

  function commission(id: string, gateway: string, status: string, amount: number, extra: Record<string, unknown> = {}) {
    return {
      id,
      affiliate_id: A,
      order_id: B,
      gateway,
      status,
      currency: 'CAD',
      commission_amount_cents: amount,
      refunded_amount_cents: 0,
      commission_rate_snapshot: 10,
      payout_id: null,
      clears_at: STAMP,
      created_at: STAMP,
      updated_at: STAMP,
      ...extra,
    };
  }

  function paypalPayout(id: string, extra: Record<string, unknown> = {}) {
    return {
      id,
      affiliate_id: A,
      amount_cents: 4500,
      currency: 'CAD',
      stripe_destination_account: null,
      stripe_transfer_id: null,
      livemode: true,
      status: 'PROCESSING',
      attempt_count: 1,
      last_attempt_at: STAMP,
      failure_reason: null,
      trigger: 'cron',
      paid_at: null,
      method: 'paypal',
      paypal_receiver: 'jane@paypal.example',
      paypal_item_status: 'PENDING',
      created_at: STAMP,
      updated_at: STAMP,
      ...extra,
    };
  }

  // Cleared: 1200 on a Stripe sale, 6000 on Freemius sales; pending: 900 on each.
  const COMMISSIONS = [
    commission('c2000000-0000-4000-8000-000000000001', 'STRIPE', 'CLEARED', 1200),
    commission('c2000000-0000-4000-8000-000000000002', 'FREEMIUS', 'CLEARED', 6000),
    commission('c2000000-0000-4000-8000-000000000003', 'STRIPE', 'PENDING_CLEARANCE', 900, { clears_at: LATER }),
    commission('c2000000-0000-4000-8000-000000000004', 'FREEMIUS', 'PENDING_CLEARANCE', 900, { clears_at: LATER }),
  ];

  /** A ledger client applying `.eq()` / `.in()` filters to the rows given, in the order given. */
  function ledgerClient(payouts: Array<Record<string, unknown>>, calls: Array<{ table: string; columns: string }>) {
    return {
      from(table: string) {
        const filters: Array<(row: Record<string, unknown>) => boolean> = [];
        let columns = '';
        const builder: Record<string, unknown> = {};
        builder['select'] = (selected: string) => {
          columns = selected;
          return builder;
        };
        for (const op of ['order', 'range', 'limit']) builder[op] = () => builder;
        builder['maybeSingle'] = async () => ({ data: null, error: null });
        builder['eq'] = (column: string, value: unknown) => {
          filters.push((row) => row[column] === value);
          return builder;
        };
        builder['in'] = (column: string, values: unknown[]) => {
          filters.push((row) => values.includes(row[column]));
          return builder;
        };
        builder['then'] = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
          calls.push({ table, columns });
          const source: Array<Record<string, unknown>> =
            table === 'affiliate_payouts' ? payouts : table === 'affiliate_commissions' ? COMMISSIONS : [];
          const rows = source.filter((row) => filters.every((keep) => keep(row)));
          return Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve, reject);
        };
        return builder;
      },
    };
  }

  function account(overrides: Record<string, unknown> = {}): RetailerPortalAccount {
    return {
      profile: {
        id: A,
        tier_id: B,
        status: 'ACTIVE',
        first_published_at: '2026-10-01T00:00:00.000Z',
        stripe_connect_account_id: null,
        stripe_connect_onboarding_complete: false,
        payout_email: 'jane@paypal.example',
        payout_email_kind: 'paypal',
        ...overrides,
      },
      page: null,
    } as unknown as RetailerPortalAccount;
  }

  async function load(
    payoutMethods: Record<string, string>,
    profile: Record<string, unknown> = {},
    payouts: Array<Record<string, unknown>> = [],
  ) {
    mocks.settings = { notificationEmails: [], minPayoutCents: 5000, autoPayoutsEnabled: true, payoutMethods };
    const calls: Array<{ table: string; columns: string }> = [];
    const data = await loadRetailerPayoutsData(
      { supabase: ledgerClient(payouts, calls), actor: {} } as unknown as RetailerPortalContext,
      account(profile),
      NOW,
    );
    return { data, calls };
  }

  const ALL_PAYPAL = { stripeSales: 'paypal', freemiusSales: 'paypal' };
  const STRIPE_AND_PAYPAL = { stripeSales: 'stripe_connect', freemiusSales: 'paypal' };

  it('pays a PayPal-account partner of an all-PayPal program with PayPal: one PayPal estimate over every commission, nothing by hand', async () => {
    const { data } = await load(ALL_PAYPAL);
    expect(data.ledgerError).toBe(false);
    expect(data.payoutMode).toBe('manual');
    expect(data.paypalGateways).toEqual(['STRIPE', 'FREEMIUS']);
    expect(data.payoutEmailKind).toBe('paypal');
    expect(data.payoutRoutes).toEqual({ stripe: false, paypal: true, manual: false });
    expect(data.clearedByMethod).toEqual({ stripeCents: 0, paypalCents: 7200, manualCents: 0 });
    // 7200 cleared reaches the 5000 minimum: the next daily run.
    expect(data.paypalPayout).toEqual({ kind: 'scheduled', date: '2026-10-27' });
    expect(data.nextPayout).toBeNull();
    expect(data.manualPayout).toBeNull();
    expect(data.paypalReturnedTo).toBeNull();
    expect(data.commissionPayoutMethods).toEqual({});
    expect(mocks.paypalStatusReads).toBe(1);
  });

  it('shows the PayPal payouts paused while automatic payouts are off or PayPal has no credentials', async () => {
    mocks.paypalConfigured = false;
    expect((await load(ALL_PAYPAL)).data.paypalPayout).toEqual({ kind: 'paused' });
    mocks.paypalConfigured = true;
    mocks.settings = { notificationEmails: [], minPayoutCents: 5000, autoPayoutsEnabled: false, payoutMethods: ALL_PAYPAL };
    const calls: Array<{ table: string; columns: string }> = [];
    const off = await loadRetailerPayoutsData({ supabase: ledgerClient([], calls), actor: {} } as unknown as RetailerPortalContext, account(), NOW);
    expect(off.paypalPayout).toEqual({ kind: 'paused' });
  });

  it('pays a partner who chose Interac e-Transfer by hand (PayPal cannot send one), and one without an address asks for it', async () => {
    const interac = await load(ALL_PAYPAL, { payout_email: 'jane@bank.example', payout_email_kind: 'interac' });
    expect(interac.data.payoutEmailKind).toBe('interac');
    expect(interac.data.payoutRoutes).toEqual({ stripe: false, paypal: false, manual: true });
    expect(interac.data.paypalPayout).toBeNull();
    expect(interac.data.manualPayout).toEqual({ kind: 'ready' });
    expect(interac.data.clearedByMethod).toEqual({ stripeCents: 0, paypalCents: 0, manualCents: 7200 });
    expect(interac.data.paypalReturnedTo).toBeNull();

    const missing = await load(ALL_PAYPAL, { payout_email: null });
    expect(missing.data.payoutRoutes.paypal).toBe(false);
    expect(missing.data.manualPayout).toEqual({ kind: 'email_required' });

    // Over PayPal's 127-character receiver limit: PayPal could not take it, the store pays by hand.
    const tooLong = await load(ALL_PAYPAL, { payout_email: `${'a'.repeat(120)}@example.com` });
    expect(tooLong.data.payoutRoutes).toEqual({ stripe: false, paypal: false, manual: true });
  });

  it('reads the kind as PayPal when the row predates 02037 (the column default)', async () => {
    const { data } = await load(ALL_PAYPAL, { payout_email_kind: undefined });
    expect(data.payoutEmailKind).toBe('paypal');
    expect(data.payoutRoutes.paypal).toBe(true);
  });

  it('pays by hand, and says so, once PayPal returned the last payout sent to the partner’s current address; a new address is paid by PayPal again', async () => {
    const returned = paypalPayout('99999999-9999-4999-8999-999999999991', {
      status: 'FAILED',
      paypal_item_status: 'RETURNED',
      failure_reason: 'paypal_returned',
    });
    const same = await load(ALL_PAYPAL, {}, [returned]);
    expect(same.data.paypalReturnedTo).toBe('jane@paypal.example');
    expect(same.data.payoutRoutes).toEqual({ stripe: false, paypal: false, manual: true });
    expect(same.data.manualPayout).toEqual({ kind: 'ready' });
    expect(same.data.paypalPayout).toBeNull();
    expect(same.calls).toContainEqual({ table: 'affiliate_payouts', columns: 'affiliate_id, status, failure_reason, paypal_receiver, created_at, updated_at' });

    const changed = await load(ALL_PAYPAL, { payout_email: 'jane.new@paypal.example' }, [returned]);
    expect(changed.data.paypalReturnedTo).toBeNull();
    expect(changed.data.payoutRoutes.paypal).toBe(true);

    // The same address saved again after the return ("I checked it: try PayPal again"): PayPal pays it again.
    const failedAt = String(returned['updated_at'] ?? '');
    const resaved = await load(ALL_PAYPAL, { payout_email_saved_at: new Date(Date.parse(failedAt) + 60_000).toISOString() }, [returned]);
    expect(resaved.data.paypalReturnedTo).toBeNull();
    expect(resaved.data.payoutRoutes.paypal).toBe(true);
    // saved before the return: still paid by hand
    const before = await load(ALL_PAYPAL, { payout_email_saved_at: new Date(Date.parse(failedAt) - 60_000).toISOString() }, [returned]);
    expect(before.data.paypalReturnedTo).toBe('jane@paypal.example');

    // A payout PayPal failed for the store's own reason (its balance) blocks nothing.
    const balance = paypalPayout('99999999-9999-4999-8999-999999999992', { status: 'FAILED', failure_reason: 'paypal_insufficient_funds' });
    expect((await load(ALL_PAYPAL, {}, [balance])).data.payoutRoutes.paypal).toBe(true);
  });

  it('shows a PayPal payout waiting to be claimed, with the address PayPal emailed, and keeps it apart from manual payouts', async () => {
    const unclaimed = paypalPayout('88888888-8888-4888-8888-888888888881', { paypal_item_status: 'UNCLAIMED', paypal_receiver: 'jane.old@paypal.example' });
    const { data } = await load(ALL_PAYPAL, {}, [unclaimed]);
    expect(data.paypalSendingCents).toBe(4500);
    expect(data.paypalUnclaimed).toEqual({ amountCents: 4500, email: 'jane.old@paypal.example' });
    expect(data.paypalPayout).toEqual({ kind: 'unclaimed', amountCents: 4500, email: 'jane.old@paypal.example' });
    expect(data.manualSendingCents).toBe(0);
    expect(data.manualPayout).toBeNull();

    const pending = await load(ALL_PAYPAL, {}, [paypalPayout('88888888-8888-4888-8888-888888888882')]);
    expect(pending.data.paypalPayout).toEqual({ kind: 'sending', amountCents: 4500 });
    expect(pending.data.paypalUnclaimed).toBeNull();

    // Still shown once the partner chose Interac e-Transfer: PayPal has it until it settles.
    const switched = await load(ALL_PAYPAL, { payout_email: 'jane@bank.example', payout_email_kind: 'interac' }, [unclaimed]);
    expect(switched.data.payoutRoutes.paypal).toBe(false);
    expect(switched.data.paypalPayout).toEqual({ kind: 'unclaimed', amountCents: 4500, email: 'jane.old@paypal.example' });
  });

  it('splits Stripe and PayPal commissions, and labels each commission by how this partner is paid', async () => {
    const paypalPartner = await load(STRIPE_AND_PAYPAL, { stripe_connect_account_id: 'acct_1', stripe_connect_onboarding_complete: true });
    expect(paypalPartner.data.payoutMode).toBe('mixed');
    expect(paypalPartner.data.payoutRoutes).toEqual({ stripe: true, paypal: true, manual: false });
    expect(paypalPartner.data.clearedByMethod).toEqual({ stripeCents: 1200, paypalCents: 6000, manualCents: 0 });
    // Stripe: 1200 cleared + 900 pending stays under 5000; PayPal: 6000 cleared reaches it.
    expect(paypalPartner.data.nextPayout).toEqual({ kind: 'below_minimum', remainingCents: 2900 });
    expect(paypalPartner.data.paypalPayout).toEqual({ kind: 'scheduled', date: '2026-10-27' });
    expect(paypalPartner.data.commissionPayoutMethods).toEqual({
      'c2000000-0000-4000-8000-000000000001': 'stripe_connect',
      'c2000000-0000-4000-8000-000000000002': 'paypal',
      'c2000000-0000-4000-8000-000000000003': 'stripe_connect',
      'c2000000-0000-4000-8000-000000000004': 'paypal',
    });

    // The same program for a partner who chose Interac e-Transfer: the Freemius ones are paid by hand.
    const interac = await load(STRIPE_AND_PAYPAL, {
      stripe_connect_account_id: 'acct_1',
      stripe_connect_onboarding_complete: true,
      payout_email: 'jane@bank.example',
      payout_email_kind: 'interac',
    });
    expect(interac.data.payoutRoutes).toEqual({ stripe: true, paypal: false, manual: true });
    expect(interac.data.manualPayout).toEqual({ kind: 'ready' });
    expect(interac.data.commissionPayoutMethods['c2000000-0000-4000-8000-000000000002']).toBe('manual');
  });
});
