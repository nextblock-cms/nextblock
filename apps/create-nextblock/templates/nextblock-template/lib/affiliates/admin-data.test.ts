import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The CMS read layer behind /cms/affiliates: the sidebar badge (the one loader that authorizes
 * itself, before any service-role client exists), the tier configuration warnings, the payout
 * platform summary, the query-param parsers and the review screen's diffs.
 */

const mocks = vi.hoisted(() => ({
  actor: null as { userId: string; role: string } | null,
  packageActive: true,
  serviceClient: vi.fn(),
  verifyPackageOnline: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@nextblock-cms/db/server', () => ({
  getServiceRoleSupabaseClient: () => mocks.serviceClient(),
  verifyPackageOnline: (id: string) => {
    mocks.verifyPackageOnline(id);
    return Promise.resolve(mocks.packageActive);
  },
}));
vi.mock('../auth/cms-actor', () => ({ getCmsActor: async () => mocks.actor }));
vi.mock('./cache', () => ({ evictAffiliateStorefrontCache: vi.fn(), evictAffiliateTiersCache: vi.fn() }));
vi.mock('./notify', () => ({ scheduleAffiliateLifecycleNotification: vi.fn() }));
vi.mock('./settings', () => ({
  getAffiliatesSettings: async () => ({ notificationEmails: [], minPayoutCents: 100, autoPayoutsEnabled: true }),
}));
vi.mock('./image-origins', () => ({ getStorefrontImageOrigins: () => ['https://media.example.com'] }));
vi.mock('@nextblock-cms/affiliates/server', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/repository/index.ts')),
}));

import type { AffiliateTierRow } from '@nextblock-cms/affiliates';
import type { AffiliateRepositoryClient } from '@nextblock-cms/affiliates/server';
import {
  buildAffiliateProfileChanges,
  describeAffiliateTierWarnings,
  diffAffiliateFeaturedProducts,
  getAffiliateApprovalsBadgeCount,
  listAffiliateActivity,
  loadAffiliateApprovalReview,
  loadAffiliateReviewProducts,
  normalizeAffiliatePayoutPlatformInfo,
  parseAffiliateOverviewFilters,
  parseAffiliatePayoutsFilters,
} from './admin-data';
import { buildAffiliatePublishedProfile, fingerprintAffiliatePublishedProfile } from './review';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';

function tier(overrides: Partial<AffiliateTierRow>): AffiliateTierRow {
  return {
    id: UUID_A,
    name: 'Starter Partner',
    name_translations: {},
    slug: 'starter-partner',
    commission_percentage: 10,
    cookie_duration_days: 30,
    clearance_hold_days: 30,
    is_default_signup_tier: false,
    is_limited_time_promo: false,
    max_ambassadors_cap: null,
    member_count: 0,
    sort_order: 1,
    badge_color: 'slate',
    is_active: true,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

/** A minimal chainable client: `from(table)` answers with `responses[table]`. */
function fakeDb(responses: Record<string, { data?: unknown; error?: unknown; count?: number }>) {
  const calls: string[] = [];
  const from = (table: string) => {
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const method of ['select', 'eq', 'in', 'is', 'not', 'order', 'range', 'limit', 'maybeSingle', 'single']) {
      builder[method] = chain;
    }
    builder['then'] = (resolve: (value: unknown) => unknown) => {
      calls.push(table);
      const response = responses[table] ?? {};
      return Promise.resolve({ data: response.data ?? null, error: response.error ?? null, count: response.count ?? null }).then(resolve);
    };
    return builder;
  };
  return { db: { from } as unknown as AffiliateRepositoryClient, calls };
}

describe('getAffiliateApprovalsBadgeCount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.actor = { userId: UUID_A, role: 'ADMIN' };
    mocks.packageActive = true;
  });

  it('answers 0 for anyone but an ADMIN without building the service client', async () => {
    for (const actor of [null, { userId: UUID_A, role: 'WRITER' }, { userId: UUID_A, role: 'USER' }]) {
      mocks.actor = actor;
      expect(await getAffiliateApprovalsBadgeCount()).toBe(0);
    }
    expect(mocks.serviceClient).not.toHaveBeenCalled();
    expect(mocks.verifyPackageOnline).not.toHaveBeenCalled();
  });

  it('answers 0 when the package is inactive, before any client exists', async () => {
    mocks.packageActive = false;
    expect(await getAffiliateApprovalsBadgeCount()).toBe(0);
    expect(mocks.verifyPackageOnline).toHaveBeenCalledWith('affiliates');
    expect(mocks.serviceClient).not.toHaveBeenCalled();
  });

  it('counts pending pages for an ADMIN, and swallows errors', async () => {
    mocks.serviceClient.mockReturnValueOnce(fakeDb({ affiliate_pages: { count: 4 } }).db);
    expect(await getAffiliateApprovalsBadgeCount()).toBe(4);

    mocks.serviceClient.mockReturnValueOnce(fakeDb({ affiliate_pages: { error: { code: '42P01' } } }).db);
    expect(await getAffiliateApprovalsBadgeCount()).toBe(0);

    mocks.serviceClient.mockImplementationOnce(() => {
      throw new Error('Missing Supabase Service Role environment variables');
    });
    expect(await getAffiliateApprovalsBadgeCount()).toBe(0);
  });
});

describe('describeAffiliateTierWarnings', () => {
  it('is quiet for the seeded ladder', () => {
    expect(
      describeAffiliateTierWarnings([
        tier({ id: UUID_A, sort_order: 1 }),
        tier({ id: UUID_B, name: 'Founding Ambassador', sort_order: 4, is_default_signup_tier: true, is_limited_time_promo: true, max_ambassadors_cap: 50, member_count: 12 }),
      ])
    ).toEqual([]);
  });

  it('warns when nobody can sign up', () => {
    expect(describeAffiliateTierWarnings([tier({ is_active: false })]).map((w) => w.code)).toEqual(['no_active_tier']);
    expect(
      describeAffiliateTierWarnings([tier({ max_ambassadors_cap: 2, member_count: 2, is_default_signup_tier: true })]).map((w) => w.code)
    ).toContain('program_full');
  });

  it('warns about a missing default, two promos and a promo nobody joins', () => {
    const codes = describeAffiliateTierWarnings([
      tier({ id: UUID_A, is_limited_time_promo: true }),
      tier({ id: UUID_B, name: 'Summer promo', is_limited_time_promo: true }),
    ]).map((w) => w.code);
    expect(codes).toEqual(expect.arrayContaining(['no_default_tier', 'multiple_promo_tiers', 'promo_not_default']));
  });

  it('warns when the default tiers are full but another tier has room', () => {
    const warnings = describeAffiliateTierWarnings([
      tier({ id: UUID_A, sort_order: 1 }),
      tier({ id: UUID_B, name: 'Founding Ambassador', is_default_signup_tier: true, is_limited_time_promo: true, max_ambassadors_cap: 50, member_count: 50 }),
    ]);
    expect(warnings.map((w) => w.code)).toEqual(['default_tiers_full']);
    expect(warnings[0].message).toContain('Founding Ambassador');
  });

  it('warns when another default tier ranks ahead of the promo tier (signups skip the launch offer)', () => {
    const founding = tier({ id: UUID_B, name: 'Founding Ambassador', sort_order: 4, is_default_signup_tier: true, is_limited_time_promo: true, max_ambassadors_cap: 50, member_count: 12 });
    // The CMS gives a new tier the next sort order, so a new default tier lands above the promo.
    const partnerPlus = tier({ id: UUID_C, name: 'Partner Plus', commission_percentage: 25, sort_order: 5, is_default_signup_tier: true });
    const warnings = describeAffiliateTierWarnings([tier({ id: UUID_A, sort_order: 1 }), founding, partnerPlus]);

    expect(warnings.map((w) => w.code)).toEqual(['promo_shadowed']);
    expect(warnings[0].message).toContain('New partners join Partner Plus first');
    expect(warnings[0].message).toContain('Founding Ambassador (the launch offer)');

    // Ranked below the promo, the same tier is only the fallback: no warning.
    expect(describeAffiliateTierWarnings([tier({ id: UUID_A, sort_order: 1 }), founding, { ...partnerPlus, sort_order: 3 }])).toEqual([]);
    // Once the shadowing tier is full, signups reach the promo again.
    expect(
      describeAffiliateTierWarnings([tier({ id: UUID_A, sort_order: 1 }), founding, { ...partnerPlus, max_ambassadors_cap: 5, member_count: 5 }]).map(
        (w) => w.code,
      ),
    ).not.toContain('promo_shadowed');
  });
});

describe('normalizeAffiliatePayoutPlatformInfo', () => {
  it('reads the payout runner’s AffiliatePayoutPlatformInfo', () => {
    expect(
      normalizeAffiliatePayoutPlatformInfo(
        {
          stripeConfigured: true,
          sandbox: false,
          platformCountry: 'CA',
          platformDefaultCurrency: 'CAD',
          storeBaseCurrency: 'USD',
          currencyMismatch: true,
          available: [{ currency: 'CAD', amount: 5000 }],
        },
        'EUR'
      )
    ).toEqual({
      stripeConfigured: true,
      sandbox: false,
      livemode: null,
      platformCountry: 'CA',
      platformCurrency: 'CAD',
      baseCurrency: 'USD',
      currencyMismatch: true,
      availableBalances: [{ currency: 'CAD', amountCents: 5000 }],
      transferableBalances: [],
      pendingBalances: [],
      balanceKnown: false,
      error: null,
    });
    expect(
      normalizeAffiliatePayoutPlatformInfo(
        { stripeConfigured: false, sandbox: true, platformCountry: null, platformDefaultCurrency: null, storeBaseCurrency: null, currencyMismatch: false, available: null },
        'USD'
      )
    ).toMatchObject({ stripeConfigured: false, sandbox: true, baseCurrency: 'USD', availableBalances: [] });
  });

  it('flags a platform currency that differs from the store currency', () => {
    const info = normalizeAffiliatePayoutPlatformInfo(
      { configured: true, livemode: false, platformCurrency: 'eur', available: [{ currency: 'eur', amount: 1250 }, { currency: 'usd', amount: 'x' }] },
      'usd'
    );
    expect(info).toMatchObject({
      stripeConfigured: true,
      livemode: false,
      platformCurrency: 'EUR',
      baseCurrency: 'USD',
      currencyMismatch: true,
      availableBalances: [{ currency: 'EUR', amountCents: 1250 }],
      sandbox: false,
      error: null,
    });
  });

  it('reads nested shapes and never invents a mismatch', () => {
    expect(
      normalizeAffiliatePayoutPlatformInfo({ platform: { defaultCurrency: 'CAD' }, balance: { available: [] } }, 'CAD')
    ).toMatchObject({ platformCurrency: 'CAD', currencyMismatch: false, stripeConfigured: null });
    expect(normalizeAffiliatePayoutPlatformInfo(null, 'USD')).toMatchObject({
      platformCurrency: null,
      currencyMismatch: false,
      baseCurrency: 'USD',
    });
  });

  it('reads the key mode, the country, and the transferable (card source) and pending balances apart from the total', () => {
    expect(
      normalizeAffiliatePayoutPlatformInfo(
        {
          stripeConfigured: true,
          sandbox: false,
          platformCountry: 'us',
          platformDefaultCurrency: 'USD',
          storeBaseCurrency: 'USD',
          currencyMismatch: false,
          livemode: true,
          available: [{ currency: 'USD', amount: 50_000 }],
          transferable: [{ currency: 'USD', amount: 12_000 }],
          pending: [{ currency: 'USD', amount: 7_000 }],
          error: null,
        },
        'USD'
      )
    ).toEqual({
      stripeConfigured: true,
      sandbox: false,
      livemode: true,
      platformCountry: 'US',
      platformCurrency: 'USD',
      baseCurrency: 'USD',
      currencyMismatch: false,
      availableBalances: [{ currency: 'USD', amountCents: 50_000 }],
      transferableBalances: [{ currency: 'USD', amountCents: 12_000 }],
      pendingBalances: [{ currency: 'USD', amountCents: 7_000 }],
      balanceKnown: true,
      error: null,
    });
    // An empty transferable list is a real zero once the balance was read.
    expect(normalizeAffiliatePayoutPlatformInfo({ transferable: [], pending: [] }, 'USD')).toMatchObject({ balanceKnown: true, transferableBalances: [] });
    expect(normalizeAffiliatePayoutPlatformInfo({ platformCountry: 'Canada' }, 'USD').platformCountry).toBeNull();
  });

  it('keeps the rejected-key and missing-permission codes', () => {
    expect(normalizeAffiliatePayoutPlatformInfo({ stripeConfigured: true, error: 'stripe_authentication' }, 'USD')).toMatchObject({
      stripeConfigured: true,
      error: 'stripe_authentication',
      balanceKnown: false,
    });
    expect(normalizeAffiliatePayoutPlatformInfo({ error: 'stripe_permission' }, 'USD').error).toBe('stripe_permission');
  });

  it('keeps machine error codes only', () => {
    expect(normalizeAffiliatePayoutPlatformInfo({ error: 'stripe_unavailable' }, 'USD').error).toBe('stripe_unavailable');
    expect(normalizeAffiliatePayoutPlatformInfo({ error: 'Invalid API Key provided: sk_live_123' }, 'USD').error).toBeNull();
    expect(normalizeAffiliatePayoutPlatformInfo({ sandbox: true }, 'USD').sandbox).toBe(true);
  });
});

describe('listAffiliateActivity', () => {
  it('carries the alert kind (a plain code only), so the feed can tell platform-wide Stripe alerts apart', async () => {
    const row = (id: string, metadata: unknown) => ({
      id,
      alert_type: 'affiliate_payout_failed',
      title: 'Alert',
      message: 'Message',
      metadata,
      is_resolved: false,
      created_at: '2026-11-10T08:00:00.000Z',
    });
    const { db } = fakeDb({
      system_alerts: {
        data: [
          row(UUID_A, { kind: 'connect_setup', alert_date: '2026-11-10', step: 'account_creation', first_affiliate_id: UUID_C }),
          row(UUID_B, { kind: 'insufficient_balance', run_date: '2026-11-10' }),
          row(UUID_C, { payout_id: UUID_A, affiliate_id: UUID_B }),
          row('44444444-4444-4444-8444-444444444444', { kind: '<b>Connect</b>' }),
        ],
      },
    });

    const items = await listAffiliateActivity(db);

    expect(items.map((item) => item.kind)).toEqual(['connect_setup', 'insufficient_balance', null, null]);
    // The Connect setup alert names no partner (it is about the platform).
    expect(items[0]).toMatchObject({ alertType: 'affiliate_payout_failed', affiliateId: null, payoutId: null });
    expect(items[2]).toMatchObject({ kind: null, affiliateId: UUID_B, payoutId: UUID_A });
  });
});

describe('query parsing', () => {
  it('keeps only valid overview filters', () => {
    expect(parseAffiliateOverviewFilters({ status: 'suspended', tier: UUID_A.toUpperCase(), q: '  jane  ', page: '3', pageSize: '50' })).toEqual({
      status: 'SUSPENDED',
      tierId: UUID_A,
      search: 'jane',
      page: 3,
      pageSize: 50,
    });
    expect(parseAffiliateOverviewFilters({ status: 'ADMIN', tier: "x' OR 1=1", page: '-2', pageSize: '1000' })).toEqual({
      status: null,
      tierId: null,
      search: '',
      page: 1,
      pageSize: 25,
    });
    expect(parseAffiliateOverviewFilters({ q: 'a'.repeat(500) }).search).toHaveLength(80);
  });

  it('scopes the status filter to the ledger view', () => {
    expect(parseAffiliatePayoutsFilters({ view: 'payouts', status: 'failed' })).toMatchObject({
      view: 'payouts',
      payoutStatus: 'FAILED',
      commissionStatus: null,
    });
    expect(parseAffiliatePayoutsFilters({ status: 'FAILED' })).toMatchObject({ view: 'commissions', commissionStatus: null, payoutStatus: null });
    expect(parseAffiliatePayoutsFilters({ status: 'pending_clearance' })).toMatchObject({ commissionStatus: 'PENDING_CLEARANCE' });
  });
});

describe('review diffs', () => {
  it('reports profile changes field by field, with sanitized links', () => {
    const changes = buildAffiliateProfileChanges(
      { display_name: 'Jane', bio: 'Old bio', avatar_object_key: null, social_links: { website: 'https://jane.example/' } },
      { display_name: 'Jane', bio: 'New bio', avatar_object_key: 'affiliates/avatars/a.webp', social_links: { website: 'https://jane.example/', x: 'javascript:alert(1)' } as never }
    );
    expect(Object.fromEntries(changes.map((change) => [change.key, change.changed]))).toEqual({
      display_name: false,
      bio: true,
      avatar: true,
      social_links: false,
      locale: false,
    });
  });

  it('shows the storefront language and flags a change of it', () => {
    const base = { display_name: 'Jane', bio: null, avatar_object_key: null, social_links: {} };
    expect(buildAffiliateProfileChanges({ ...base, locale: 'en' }, { ...base, locale: 'fr' }).find((change) => change.key === 'locale')).toEqual({
      key: 'locale',
      label: 'Language',
      live: 'English',
      proposed: 'French',
      changed: true,
    });
    expect(buildAffiliateProfileChanges({ ...base, locale: 'fr' }, { ...base, locale: 'fr' }).find((change) => change.key === 'locale')?.changed).toBe(false);
    // A live snapshot without a language: the page starts declaring one with this approval.
    expect(buildAffiliateProfileChanges(base, { ...base, locale: 'en' }).find((change) => change.key === 'locale')).toMatchObject({
      live: null,
      proposed: 'English',
      changed: true,
    });
  });

  it('treats every proposed value as new before the first approval', () => {
    const changes = buildAffiliateProfileChanges(null, {
      display_name: 'Jane',
      bio: null,
      avatar_object_key: null,
      social_links: {},
    });
    expect(changes.find((change) => change.key === 'display_name')).toMatchObject({ live: null, proposed: 'Jane', changed: true });
    expect(changes.find((change) => change.key === 'bio')).toMatchObject({ changed: false });
  });

  it('diffs featured products on validated ids', () => {
    expect(diffAffiliateFeaturedProducts([UUID_A, UUID_B], [UUID_B.toUpperCase(), UUID_C, 'bogus'])).toEqual({
      added: [UUID_C],
      removed: [UUID_A],
      kept: [UUID_B],
    });
  });
});

describe('loadAffiliateReviewProducts', () => {
  it('marks unknown products missing and maps the first image and status', async () => {
    const { db } = fakeDb({
      products: {
        data: [
          {
            id: UUID_A,
            title: 'Trail shoe',
            status: 'active',
            product_media: [
              { sort_order: 2, media: { object_key: 'images/second.webp' } },
              { sort_order: 1, media: { object_key: 'https://cdn.example.com/first.webp' } },
            ],
          },
          { id: UUID_B, title: 'Old tent', status: 'archived', product_media: [] },
        ],
      },
    });

    const products = await loadAffiliateReviewProducts(db, [UUID_A, UUID_B, UUID_C, 'not-a-uuid']);

    expect(Object.keys(products).sort()).toEqual([UUID_A, UUID_B, UUID_C].sort());
    expect(products[UUID_A]).toMatchObject({ title: 'Trail shoe', status: 'active', imageUrl: 'https://cdn.example.com/first.webp' });
    expect(products[UUID_B]).toMatchObject({ status: 'archived', imageUrl: null });
    expect(products[UUID_C]).toMatchObject({ status: 'missing', title: null });
  });

  it('skips the query when there is nothing valid to look up', async () => {
    const { db, calls } = fakeDb({});
    expect(await loadAffiliateReviewProducts(db, ['nope'])).toEqual({});
    expect(calls).toEqual([]);
  });
});

describe('loadAffiliateApprovalReview', () => {
  const PAGE_ID = '44444444-4444-4444-8444-444444444444';

  it('sanitizes both documents the way publication does and diffs them', async () => {
    const published = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Kept' }] }] };
    const draft = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Kept' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'New', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] },
        { type: 'svg', content: [] },
      ],
    };
    const responses: Record<string, { data?: unknown }> = {
      affiliate_pages: {
        data: {
          id: PAGE_ID,
          affiliate_id: UUID_A,
          user_id: UUID_B,
          title: 'Picks',
          meta_description: '',
          draft_content: draft,
          featured_product_ids: [],
          published_content: published,
          published_title: 'Picks',
          published_meta_description: null,
          published_profile: { display_name: 'Jane', bio: null, avatar_object_key: null, social_links: {} },
          published_featured_product_ids: [],
          approval_status: 'PENDING_REVIEW',
          draft_version: 2,
        },
      },
      affiliate_profiles: {
        data: { id: UUID_A, user_id: UUID_B, tier_id: UUID_C, handle: 'jane', display_name: 'Jane', bio: null, social_links: {}, status: 'ACTIVE' },
      },
      affiliate_tiers: { data: null },
      products: { data: [] },
    };
    const { db } = fakeDb(responses);

    const review = await loadAffiliateApprovalReview(db, PAGE_ID);

    expect(review).not.toBeNull();
    expect(review?.diff.statuses).toEqual(['unchanged', 'added']);
    expect(review?.draftIssues.length).toBeGreaterThan(0);
    expect(JSON.stringify(review?.draftDoc)).not.toMatch(/javascript:|svg/);
    expect(review?.draftIsEmpty).toBe(false);
    expect(review?.seoChanges.find((change) => change.key === 'title')?.changed).toBe(false);
  });

  it('carries the fingerprint of the proposed profile it shows, for the Approve button (review A)', async () => {
    const page = {
      id: PAGE_ID,
      affiliate_id: UUID_A,
      user_id: UUID_B,
      title: 'Picks',
      meta_description: '',
      draft_content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Kept' }] }] },
      featured_product_ids: [],
      published_content: null,
      published_profile: null,
      published_featured_product_ids: [],
      approval_status: 'PENDING_REVIEW',
      draft_version: 2,
    };
    const profile = (overrides: Record<string, unknown> = {}) => ({
      id: UUID_A,
      user_id: UUID_B,
      tier_id: UUID_C,
      handle: 'jane',
      display_name: 'Jane',
      bio: 'Trail runner.',
      avatar_object_key: 'affiliates/avatars/jane.webp',
      social_links: { website: 'https://jane.example', youtube: 'https://www.youtube.com/@jane' },
      status: 'ACTIVE',
      ...overrides,
    });
    const load = (row: Record<string, unknown>) =>
      loadAffiliateApprovalReview(
        fakeDb({ affiliate_pages: { data: page }, affiliate_profiles: { data: row }, affiliate_tiers: { data: null }, products: { data: [] } }).db,
        PAGE_ID
      );

    const review = await load(profile());
    // Exactly what approval checks against: the snapshot approval would publish.
    expect(review?.profileFingerprint).toBe(
      fingerprintAffiliatePublishedProfile(buildAffiliatePublishedProfile(profile() as never))
    );
    expect(review?.profileFingerprint).toMatch(/^[0-9a-f]{64}$/);
    // The same links in another order are the same profile; another bio is not.
    const reordered = await load(profile({ social_links: { youtube: 'https://www.youtube.com/@jane', website: 'https://jane.example' } }));
    expect(reordered?.profileFingerprint).toBe(review?.profileFingerprint);
    const edited = await load(profile({ bio: 'Something the admin has not read.' }));
    expect(edited?.profileFingerprint).not.toBe(review?.profileFingerprint);
  });

  it('answers null for an unknown or malformed page id', async () => {
    const { db, calls } = fakeDb({ affiliate_pages: { data: null } });
    expect(await loadAffiliateApprovalReview(db, 'nope')).toBeNull();
    expect(calls).toEqual([]);
    expect(await loadAffiliateApprovalReview(db, PAGE_ID)).toBeNull();
  });

  it('carries every tier for the Partner card’s Change tier, the partner’s own among them, and tier_changed_at', async () => {
    const page = {
      id: PAGE_ID,
      affiliate_id: UUID_A,
      user_id: UUID_B,
      title: 'Picks',
      meta_description: '',
      draft_content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Kept' }] }] },
      featured_product_ids: [],
      published_content: null,
      published_profile: null,
      published_featured_product_ids: [],
      approval_status: 'DRAFT',
      draft_version: 1,
    };
    const tiers = [tier({ id: UUID_B, name: 'Starter Partner' }), tier({ id: UUID_C, name: 'Elite Partner', commission_percentage: 35, is_active: false })];
    const review = await loadAffiliateApprovalReview(
      fakeDb({
        affiliate_pages: { data: page },
        affiliate_profiles: {
          data: { id: UUID_A, user_id: UUID_B, tier_id: UUID_C, handle: 'jane', display_name: 'Jane', status: 'SUSPENDED', tier_changed_at: '2026-11-05T14:00:00.000Z' },
        },
        affiliate_tiers: { data: tiers },
        products: { data: [] },
      }).db,
      PAGE_ID
    );

    // Inactive tiers too: the control lists them disabled.
    expect(review?.tiers.map((row) => row.id)).toEqual([UUID_B, UUID_C]);
    expect(review?.tier).toMatchObject({ id: UUID_C, name: 'Elite Partner', commission_percentage: 35 });
    expect(review?.profile.tier_changed_at).toBe('2026-11-05T14:00:00.000Z');
  });
});
