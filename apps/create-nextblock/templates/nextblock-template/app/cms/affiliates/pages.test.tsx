import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Render smoke tests of the four /cms/affiliates screens with fixture data: each page checks the
 * ADMIN and the package before it loads anything, renders without throwing, keeps a clean heading
 * outline under the CMS header's h1 (starts at h2, never skips a level going down), labels every
 * form control, and never links to a public storefront (an admin visit would set a referral
 * cookie and count a click). Partner addresses appear only as a `mailto:` the admin's own mail
 * client opens.
 */

const mocks = vi.hoisted(() => ({
  requireCmsAdmin: vi.fn(),
  packageActive: true,
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  loadOverview: vi.fn(),
  loadTiers: vi.fn(),
  loadQueue: vi.fn(),
  loadStorefronts: vi.fn(),
  loadEmails: vi.fn(),
  ledgerCheck: vi.fn(),
  loadReview: vi.fn(),
  loadPayouts: vi.fn(),
  loadManualQueue: vi.fn(),
  loadPrepared: vi.fn(),
  platformInfo: vi.fn(),
  stripeOverview: vi.fn(),
  badgeCount: vi.fn(async () => 2),
  /** The built-in terms' operator identity (lib/affiliates/terms-identity.ts, from Settings → Privacy & Consent). */
  termsIdentity: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
  notFound: mocks.notFound,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/cms/affiliates',
}));
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn(), updateTag: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@nextblock-cms/db/server', () => ({
  verifyPackageOnline: async () => mocks.packageActive,
  getServiceRoleSupabaseClient: vi.fn(),
  createClient: vi.fn(),
}));
vi.mock('../../../lib/auth/cms-actor', () => ({ requireCmsAdmin: mocks.requireCmsAdmin, getCmsActor: vi.fn() }));
vi.mock('../../../lib/affiliates/cache', () => ({ evictAffiliateStorefrontCache: vi.fn(), evictAffiliateTiersCache: vi.fn() }));
vi.mock('../../../lib/affiliates/notify', () => ({ scheduleAffiliateLifecycleNotification: vi.fn() }));
vi.mock('../../../lib/affiliates/image-origins', () => ({ getStorefrontImageOrigins: () => ['https://media.example.com'] }));
vi.mock('../../../lib/affiliates/settings', () => ({
  AFFILIATES_SETTINGS_LIMITS: { maxNotificationEmails: 10, maxEmailLength: 254, minPayoutCents: 50, maxPayoutCents: 1_000_000 },
  normalizeAffiliateNotificationEmail: (value: string) => value,
  saveAffiliatesSettings: vi.fn(),
  getAffiliatesSettings: vi.fn(),
}));
vi.mock('../../../lib/affiliates/payout-runner', () => ({
  getAffiliatePayoutPlatformInfo: mocks.platformInfo,
  runAffiliatePayoutCycleNow: vi.fn(),
  retryAffiliatePayoutNow: vi.fn(),
  releaseAffiliatePayoutNow: vi.fn(),
  maybeRunAffiliatePayouts: vi.fn(),
}));
vi.mock('../../../lib/affiliates/payout-setup', () => ({
  loadAffiliateStripePayoutsOverview: mocks.stripeOverview,
  testAffiliateStripeSetupNow: vi.fn(),
  // The real wording for the schedules these fixtures use (payout-setup.test.ts covers the rest).
  describeAffiliateStripePayoutSchedule: (interval: string | null, delayDays: number | null) =>
    interval === 'manual' ? 'only when you pay out yourself (manual payouts)' : `${interval}${delayDays ? `, ${delayDays} days after each payment` : ''}`,
}));
vi.mock('@nextblock-cms/affiliates/server', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../../../libs/affiliates/src/lib/repository/index.ts')),
}));
vi.mock('../../../lib/affiliates/admin-data', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadAffiliateOverview: mocks.loadOverview,
  loadAffiliateTiersAdmin: mocks.loadTiers,
  loadAffiliateApprovalQueue: mocks.loadQueue,
  loadAffiliateStorefrontsAdmin: mocks.loadStorefronts,
  loadAffiliatePartnerEmails: mocks.loadEmails,
  loadAffiliateApprovalReview: mocks.loadReview,
  loadAffiliatePayoutsAdmin: mocks.loadPayouts,
  getAffiliateApprovalsBadgeCount: mocks.badgeCount,
  getAffiliateStoreBaseCurrency: async () => 'USD',
}));
vi.mock('../../../lib/affiliates/affiliate-deletion-guard', () => ({ checkAffiliateUserDeletion: mocks.ledgerCheck }));
vi.mock('../../../lib/affiliates/manual-payouts', () => ({
  loadAffiliateManualPayoutQueue: mocks.loadManualQueue,
  loadAffiliatePreparedManualPayouts: mocks.loadPrepared,
}));
vi.mock('../../../lib/affiliates/terms-identity', () => ({ loadAffiliateTermsOperatorIdentity: mocks.termsIdentity }));
// The email subject's site name (lib/affiliates/partner-contact.ts reads the cached site settings).
vi.mock('../../lib/site-settings', () => ({ getSiteSettings: async () => ({ siteTitle: 'Maple Shop' }) }));

import OverviewPage from './page';
import TiersPage from './tiers/page';
import ApprovalsPage from './approvals/page';
import ReviewPage from './approvals/[pageId]/page';
import PayoutsPage from './payouts/page';
import StripePayoutsPage from './stripe/page';

const TIER_ID = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
const AFFILIATE_ID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const PAGE_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const PAYOUT_ID = 'cccccccc-3333-4333-8333-cccccccccccc';
const PRODUCT_ID = '12345678-1234-4234-8234-123456789abc';
const ORDER_ID = '99999999-9999-4999-8999-999999999999';
const USER_ID = 'dddddddd-4444-4444-8444-dddddddddddd';
const STOREFRONT_PAGE_ID = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';
/** The `mailto:` every screen builds for the fixture partner (subject: "Your partner storefront on Maple Shop"). */
const MAILTO = 'href="mailto:jane@partner.dev?subject=Your%20partner%20storefront%20on%20Maple%20Shop"';

const TIER = {
  id: TIER_ID,
  name: 'Founding Ambassador',
  name_translations: { fr: 'Ambassadeur fondateur' },
  slug: 'founding-ambassador',
  commission_percentage: 50,
  cookie_duration_days: 30,
  clearance_hold_days: 30,
  is_default_signup_tier: true,
  is_limited_time_promo: true,
  max_ambassadors_cap: 50,
  member_count: 12,
  sort_order: 4,
  badge_color: 'amber' as const,
  is_active: true,
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
};

const SETTINGS = { notificationEmails: ['ops@example.com'], minPayoutCents: 500, autoPayoutsEnabled: true, termsUrlEn: '', termsUrlFr: '' };

function overviewData() {
  return {
    metrics: {
      baseCurrency: 'USD',
      partners: { total: 3, active: 2, suspended: 1, approved: 1 },
      steps: { SIGNED_UP: 1, PROFILE_COMPLETED: 0, PAYOUT_CONFIGURED: 0, PAGE_SUBMITTED: 1, ACTIVE_PUBLISHED: 1 },
      liveStorefronts: 1,
      pendingApprovals: 1,
      clicks: 42,
      pendingClearanceCents: 12_345,
      clearedCents: 5_000,
      processingCents: 0,
      paidLifetimeCents: 80_000,
      otherCurrencies: [],
      truncated: false,
    },
    tiers: [TIER],
    partners: {
      rows: [
        {
          id: AFFILIATE_ID,
          userId: USER_ID,
          handle: 'jane',
          displayName: 'Jane <b>Partner</b>',
          status: 'SUSPENDED' as const,
          suspendedReason: 'Chargebacks',
          onboardingStep: 'PAGE_SUBMITTED' as const,
          tierId: TIER_ID,
          tierName: 'Founding Ambassador',
          tierBadgeColor: 'amber' as const,
          // Moved into this tier after signing up (02035 tier_changed_at).
          tierSince: '2026-11-05T14:00:00.000Z',
          totalClicks: 42,
          totalEarnedCents: 1_000,
          totalPaidCents: 0,
          createdAt: '2026-10-02T00:00:00.000Z',
          isApproved: false,
          payoutsReady: false,
          pageId: PAGE_ID,
          pageStatus: 'PENDING_REVIEW' as const,
          hasPublishedPage: false,
        },
      ],
      total: 1,
    },
    activity: [
      {
        id: 'f1f1f1f1-1111-4111-8111-f1f1f1f1f1f1',
        alertType: 'affiliate_page_submitted',
        title: 'Storefront waiting for review',
        message: '@jane submitted their storefront.',
        createdAt: '2026-10-26T00:00:00.000Z',
        isResolved: false,
        affiliateId: AFFILIATE_ID,
        pageId: PAGE_ID,
        payoutId: null,
        orderId: null,
      },
    ],
    settings: SETTINGS,
  };
}

function reviewData(overrides: Record<string, unknown> = {}) {
  const draftDoc = {
    type: 'doc' as const,
    content: [
      { type: 'heading' as const, attrs: { level: 2 as const }, content: [{ type: 'text' as const, text: 'My picks' }] },
      { type: 'affiliateProductGrid' as const, attrs: { productIds: [PRODUCT_ID], title: 'Favourites', columns: 3 as const } },
    ],
  };
  return {
    page: {
      id: PAGE_ID,
      affiliate_id: AFFILIATE_ID,
      approval_status: 'PENDING_REVIEW',
      draft_version: 7,
      draft_updated_at: '2026-10-25T00:00:00.000Z',
      submitted_at: '2026-10-26T00:00:00.000Z',
      submitted_version: 7,
      reviewed_at: null,
      published_at: null,
      admin_feedback_note: null,
    },
    profile: {
      id: AFFILIATE_ID,
      user_id: USER_ID,
      tier_id: TIER_ID,
      handle: 'jane',
      display_name: 'Jane Partner',
      bio: null,
      avatar_object_key: null,
      social_links: {},
      preferred_locale: 'en',
      onboarding_step: 'PAGE_SUBMITTED',
      status: 'ACTIVE',
      suspended_reason: null,
      stripe_connect_account_id: null,
      stripe_connect_onboarding_complete: false,
      stripe_connect_details_submitted: false,
      stripe_connect_payouts_enabled: false,
      stripe_connect_livemode: null,
      stripe_connect_checked_at: null,
      total_clicks: 0,
      last_click_at: null,
      total_earned_cents: 0,
      total_paid_cents: 0,
      profile_completed_at: null,
      payout_configured_at: null,
      page_submitted_at: null,
      first_published_at: null,
      signup_ip_masked: null,
      tier_changed_at: null,
      created_at: '2026-10-02T00:00:00.000Z',
      updated_at: '',
    },
    tier: TIER,
    // Every tier for the Partner card's "Change tier": the partner's own and an inactive one.
    tiers: [TIER, { ...TIER, id: 'eeeeeeee-6666-4666-8666-eeeeeeeeeeee', name: 'Retired', slug: 'retired', is_active: false, max_ambassadors_cap: null }],
    publishedDoc: null,
    draftDoc,
    draftIssues: ['Removed a link with an unsafe address'],
    draftIsEmpty: false,
    diff: { statuses: ['added', 'added'], removedCount: 0 },
    products: { [PRODUCT_ID]: { id: PRODUCT_ID, title: 'Trail shoe', imageUrl: 'https://media.example.com/shoe.webp', status: 'draft' } },
    featured: { added: [PRODUCT_ID], removed: [], kept: [] },
    profileChanges: [
      { key: 'display_name', label: 'Display name', live: null, proposed: 'Jane Partner', changed: true },
      { key: 'bio', label: 'Bio', live: null, proposed: null, changed: false },
      { key: 'avatar', label: 'Avatar', live: null, proposed: null, changed: false },
      { key: 'social_links', label: 'Social links', live: null, proposed: null, changed: false },
    ],
    seoChanges: [
      { key: 'title', label: 'Page title', live: null, proposed: 'Jane’s picks', changed: true },
      { key: 'meta_description', label: 'Meta description', live: null, proposed: null, changed: false },
    ],
    liveAvatarUrl: null,
    proposedAvatarUrl: null,
    allowedImageOrigins: ['https://media.example.com'],
    siteOrigin: 'https://shop.example.com',
    ...overrides,
  };
}

function payoutsData(view: 'commissions' | 'payouts') {
  return {
    baseCurrency: 'USD',
    settings: SETTINGS,
    commissions:
      view === 'commissions'
        ? {
            rows: [
              {
                id: 'c0c0c0c0-0000-4000-8000-c0c0c0c0c0c0',
                affiliate_id: AFFILIATE_ID,
                order_id: ORDER_ID,
                gateway: 'STRIPE',
                order_currency: 'CAD',
                order_net_amount_minor: 13_500,
                exchange_rate_snapshot: 1.35,
                net_order_amount_cents: 10_000,
                commission_rate_snapshot: 50,
                commission_amount_cents: 5_000,
                refunded_amount_cents: 500,
                refund_pending_cents: 0,
                void_requested_at: null,
                currency: 'USD',
                status: 'PENDING_CLEARANCE',
                clears_at: new Date(Date.now() + 12 * 86_400_000).toISOString(),
                cleared_at: null,
                paid_at: null,
                voided_at: null,
                void_reason: null,
                payout_id: null,
                stripe_transfer_id: null,
                notified_at: null,
                created_at: '2026-10-20T00:00:00.000Z',
                updated_at: '2026-10-20T00:00:00.000Z',
              },
            ],
            total: 1,
          }
        : null,
    payouts:
      view === 'payouts'
        ? {
            rows: [
              {
                id: PAYOUT_ID,
                affiliate_id: AFFILIATE_ID,
                amount_cents: 4_500,
                currency: 'USD',
                stripe_destination_account: 'acct_123',
                stripe_transfer_id: null,
                status: 'FAILED',
                attempt_count: 2,
                last_attempt_at: '2026-10-26T00:00:00.000Z',
                failure_reason: 'balance_insufficient',
                trigger: 'cron',
                paid_at: null,
                created_at: '2026-10-25T00:00:00.000Z',
                updated_at: '2026-10-26T00:00:00.000Z',
              },
            ],
            total: 1,
          }
        : null,
    partners: { [AFFILIATE_ID]: { handle: 'jane', displayName: 'Jane Partner' } },
    failedPayouts: 1,
    processingPayouts: 0,
  };
}

/** Heading levels in document order. */
function headingLevels(html: string): number[] {
  return [...html.matchAll(/<h([1-6])[\s>]/g)].map((match) => Number(match[1]));
}

function expectCleanOutline(html: string) {
  const levels = headingLevels(html);
  expect(levels[0]).toBe(2);
  expect(levels.filter((level) => level === 1)).toEqual([]);
  for (let index = 1; index < levels.length; index += 1) {
    expect(levels[index] - levels[index - 1], `h${levels[index - 1]} -> h${levels[index]}`).toBeLessThanOrEqual(1);
  }
}

/**
 * Every visible input, select and textarea has a <label for> or an aria-label. Hidden inputs and
 * Radix's aria-hidden mirror of its Select (TablePagination's page size) are not controls.
 */
function expectLabelledControls(html: string) {
  const controls = [...html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)];
  for (const [, tag, attributes] of controls) {
    if (/type="hidden"/.test(attributes) || /aria-hidden="true"/.test(attributes)) continue;
    const id = /\sid="([^"]+)"/.exec(attributes)?.[1];
    const labelled = (id && html.includes(`for="${id}"`)) || /aria-label="/.test(attributes);
    expect(labelled, `${tag} ${attributes}`).toBeTruthy();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  mocks.packageActive = true;
  mocks.requireCmsAdmin.mockResolvedValue({ supabase: {}, userId: '0b0b0b0b-1111-4111-8111-0b0b0b0b0b0b' });
  mocks.termsIdentity.mockResolvedValue({ company: 'Maple Shop Inc.', contactEmail: 'legal@maple-shop.test', settingsRead: true });
  mocks.loadOverview.mockResolvedValue(overviewData());
  mocks.loadPrepared.mockResolvedValue({ rows: [], total: 0, totals: [], truncated: false });
  mocks.loadTiers.mockResolvedValue({ tiers: [TIER], warnings: [{ code: 'no_default_tier', message: 'No default tier.' }] });
  mocks.loadQueue.mockResolvedValue({
    items: [
      {
        pageId: PAGE_ID,
        affiliateId: AFFILIATE_ID,
        userId: USER_ID,
        handle: 'jane',
        displayName: 'Jane Partner',
        partnerStatus: 'ACTIVE',
        tierName: 'Founding Ambassador',
        tierBadgeColor: 'amber',
        title: 'Jane’s picks',
        submittedAt: '2026-10-26T00:00:00.000Z',
        draftVersion: 7,
        isFirstPublication: true,
      },
    ],
    total: 1,
    recentlyReviewed: [
      { pageId: PAGE_ID, handle: 'max', displayName: 'Max', status: 'PUBLISHED', partnerStatus: 'ACTIVE', reviewedAt: '2026-10-20T00:00:00.000Z' },
    ],
  });
  mocks.loadStorefronts.mockResolvedValue({
    rows: [
      {
        pageId: STOREFRONT_PAGE_ID,
        affiliateId: AFFILIATE_ID,
        userId: USER_ID,
        handle: 'studio-nova',
        displayName: 'Studio Nova',
        partnerStatus: 'SUSPENDED',
        suspendedReason: 'Chargebacks on 3 orders',
        state: 'paused',
        isApproved: true,
        publishedAt: '2026-10-15T00:00:00.000Z',
        approvalStatus: 'PUBLISHED',
      },
    ],
    total: 1,
  });
  // One address for whoever is on screen (the loader keys them by auth user id).
  mocks.loadEmails.mockImplementation(async (_db: unknown, userIds: Array<string | null>) =>
    Object.fromEntries(userIds.filter((id): id is string => Boolean(id)).map((id) => [id, 'jane@partner.dev']))
  );
  mocks.ledgerCheck.mockResolvedValue({ kind: 'allowed', handle: 'jane' });
  mocks.loadReview.mockResolvedValue(reviewData());
  mocks.platformInfo.mockResolvedValue({
    stripeConfigured: true,
    sandbox: false,
    platformCountry: 'CA',
    platformDefaultCurrency: 'CAD',
    storeBaseCurrency: 'USD',
    currencyMismatch: true,
    livemode: false,
    available: [{ currency: 'CAD', amount: 10_000 }],
    transferable: [{ currency: 'CAD', amount: 8_000 }],
    pending: [{ currency: 'CAD', amount: 1_500 }],
    error: null,
  });
  mocks.stripeOverview.mockResolvedValue(stripeOverview());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('every screen authorizes before it loads', () => {
  it.each([
    ['overview', () => OverviewPage({ searchParams: Promise.resolve({}) })],
    ['tiers', () => TiersPage()],
    ['approvals', () => ApprovalsPage({ searchParams: Promise.resolve({}) })],
    ['review', () => ReviewPage({ params: Promise.resolve({ pageId: PAGE_ID }) })],
    ['payouts', () => PayoutsPage({ searchParams: Promise.resolve({}) })],
    ['stripe payouts', () => StripePayoutsPage()],
  ])('%s: a refused admin check stops the page; an inactive package redirects', async (_name, render) => {
    mocks.requireCmsAdmin.mockRejectedValueOnce(new Error('Forbidden'));
    await expect(render()).rejects.toThrow('Forbidden');

    mocks.packageActive = false;
    await expect(render()).rejects.toThrow('NEXT_REDIRECT:/cms/settings/packages');

    for (const loader of [
      mocks.loadOverview,
      mocks.loadTiers,
      mocks.loadQueue,
      mocks.loadStorefronts,
      mocks.loadEmails,
      mocks.ledgerCheck,
      mocks.loadReview,
      mocks.loadPayouts,
      mocks.platformInfo,
      mocks.stripeOverview,
    ]) {
      expect(loader).not.toHaveBeenCalled();
    }
  });
});

describe('screens render', () => {
  it('overview', async () => {
    const html = renderToStaticMarkup(await OverviewPage({ searchParams: Promise.resolve({ q: 'jane' }) }));
    expectCleanOutline(html);
    expectLabelledControls(html);
    expect(html).toContain('Affiliate program');
    expect(html).toContain('$123.45');
    expect(html).toContain('Jane &lt;b&gt;Partner&lt;/b&gt;');
    expect(html).toContain(`href="/cms/affiliates/approvals/${PAGE_ID}"`);
    expect(html).toContain('/api/affiliates/cron/payouts');
    // No storefront link (an admin's click would set the referral cookie). The one /partners/ link is
    // the program settings' preview of the built-in terms: `terms` is a reserved handle, never a storefront.
    expect(html).not.toMatch(/href="\/partners\/(?!terms\?builtin=1")/);
    expect(html).toContain('href="/partners/terms?builtin=1" target="_blank" rel="noopener noreferrer"');
    expect(html).not.toMatch(/process\.env|CRON_SECRET=/);
  });

  it('overview: the partner’s email, and the pause wording', async () => {
    const html = renderToStaticMarkup(await OverviewPage({ searchParams: Promise.resolve({}) }));
    // The partner's address, for the visible rows only, as a same-tab mailto and a copy button.
    expect(html).toContain(MAILTO);
    expect(html).not.toMatch(/<a [^>]*href="mailto:[^"]*"[^>]*target=/);
    expect(html).toContain('aria-label="Copy the email address of @jane"');
    expect(mocks.loadEmails).toHaveBeenCalledWith(expect.anything(), [USER_ID]);
    // The CMS calls a suspension a pause.
    expect(html).toContain('aria-label="Resume partner @jane"');
    expect(html).toContain('>Paused</');
    expect(html).not.toContain('>Suspended<');
  });

  /** The cells of the overview row whose tier button names `@handle`. */
  function overviewRowCells(html: string, handle: string): string[] {
    const row = html.split('<tr').find((part) => part.includes(`aria-label="Change tier of @${handle}"`)) ?? '';
    expect(row, handle).not.toBe('');
    return row.split('<td').slice(1);
  }
  const STOREFRONT_CELL = 3;

  const TIER_CELL = 1;

  it('overview: each partner’s tier says since when (the last move, else the sign-up)', async () => {
    const html = renderToStaticMarkup(await OverviewPage({ searchParams: Promise.resolve({}) }));
    const tier = overviewRowCells(html, 'jane')[TIER_CELL];
    expect(tier).toContain('Founding Ambassador');
    expect(tier).toContain('Tier since Nov 5, 2026');

    const data = overviewData();
    const [jane] = data.partners.rows;
    mocks.loadOverview.mockResolvedValueOnce({ ...data, partners: { rows: [{ ...jane, tierSince: jane.createdAt }], total: 1 } });
    const never = renderToStaticMarkup(await OverviewPage({ searchParams: Promise.resolve({}) }));
    expect(overviewRowCells(never, 'jane')[TIER_CELL]).toContain('Tier since Oct 2, 2026');
  });

  it('overview: every partner links their review page, one who never submitted too (Remove partner lives there)', async () => {
    const data = overviewData();
    const [jane] = data.partners.rows;
    mocks.loadOverview.mockResolvedValueOnce({
      ...data,
      partners: {
        rows: [
          {
            ...jane,
            status: 'ACTIVE' as const,
            suspendedReason: null,
            onboardingStep: 'SIGNED_UP' as const,
            pageStatus: 'DRAFT' as const,
            hasPublishedPage: false,
            isApproved: false,
          },
        ],
        total: 1,
      },
    });

    const html = renderToStaticMarkup(await OverviewPage({ searchParams: Promise.resolve({}) }));
    const storefront = overviewRowCells(html, 'jane')[STOREFRONT_CELL];

    expect(storefront).toContain('>Draft<');
    expect(storefront).toContain(`href="/cms/affiliates/approvals/${PAGE_ID}"`);
    expect(storefront).toContain('aria-label="Open review for @jane"');
    expect(storefront).toContain('>Open review<');
    expect(storefront).not.toContain('Review now');
    // Still no storefront link (the terms preview is the one /partners/ link, a reserved handle).
    expect(html).not.toMatch(/href="\/partners\/(?!terms\?builtin=1")/);
  });

  it('overview: a paused partner’s published storefront reads Paused, never Published or live', async () => {
    const data = overviewData();
    const [jane] = data.partners.rows;
    const MAX_PAGE_ID = 'aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa';
    mocks.loadOverview.mockResolvedValueOnce({
      ...data,
      partners: {
        rows: [
          // Paused with a published page, and paused with an update waiting over an approved version.
          { ...jane, pageStatus: 'PUBLISHED' as const, hasPublishedPage: true, isApproved: true },
          {
            ...jane,
            id: 'bbbbbbbb-4444-4444-8444-bbbbbbbbbbbb',
            handle: 'max',
            displayName: 'Max',
            pageId: MAX_PAGE_ID,
            pageStatus: 'PENDING_REVIEW' as const,
            hasPublishedPage: true,
            isApproved: true,
          },
          // Active, the same update: its approved version is live.
          {
            ...jane,
            id: 'bbbbbbbb-5555-4555-8555-bbbbbbbbbbbb',
            handle: 'ana',
            displayName: 'Ana',
            status: 'ACTIVE' as const,
            suspendedReason: null,
            pageId: 'aaaaaaaa-4444-4444-8444-aaaaaaaaaaaa',
            pageStatus: 'PENDING_REVIEW' as const,
            hasPublishedPage: true,
            isApproved: true,
          },
        ],
        total: 3,
      },
    });

    const html = renderToStaticMarkup(await OverviewPage({ searchParams: Promise.resolve({}) }));

    const jane1 = overviewRowCells(html, 'jane')[STOREFRONT_CELL];
    expect(jane1).toContain('>Paused<');
    expect(jane1).not.toContain('>Published<');
    expect(jane1).toContain('aria-label="Open review for @jane"');

    const max = overviewRowCells(html, 'max')[STOREFRONT_CELL];
    expect(max).toContain('>Pending review<');
    expect(max).toContain('The approved version is offline while they are paused');
    expect(max).not.toContain('An approved version is live');
    expect(max).toContain(`href="/cms/affiliates/approvals/${MAX_PAGE_ID}"`);
    expect(max).toContain('aria-label="Review now for @max"');

    const ana = overviewRowCells(html, 'ana')[STOREFRONT_CELL];
    expect(ana).toContain('An approved version is live');
    expect(ana).toContain('>Review now<');
  });

  it('overview: platform-wide Stripe alerts link the Stripe payouts screen, a failed payout the payouts list', async () => {
    const alert = (id: string, title: string, kind: string | null) => ({
      id,
      alertType: 'affiliate_payout_failed',
      kind,
      title,
      message: `${title}.`,
      createdAt: '2026-11-10T08:00:00.000Z',
      isResolved: false,
      affiliateId: null,
      pageId: null,
      payoutId: null,
      orderId: null,
    });
    mocks.loadOverview.mockResolvedValueOnce({
      ...overviewData(),
      activity: [
        alert('f3f3f3f3-3333-4333-8333-f3f3f3f3f3f3', 'Stripe Connect refused a partner’s payout setup', 'connect_setup'),
        alert('f4f4f4f4-4444-4444-8444-f4f4f4f4f4f4', 'Insufficient Stripe balance for affiliate payouts', 'insufficient_balance'),
        alert('f5f5f5f5-5555-4555-8555-f5f5f5f5f5f5', 'Affiliate payout failed', null),
      ],
    });
    const html = renderToStaticMarkup(await OverviewPage({ searchParams: Promise.resolve({}) }));
    const items = [...html.matchAll(/<li class="flex items-start gap-3 p-4">[\s\S]*?<\/li>/g)].map(([entry]) => entry);
    const item = (title: string) => items.find((entry) => entry.includes(title)) ?? '';

    // Like the banner: the screen that explains the fix, labelled by what the alert is about.
    expect(item('Stripe Connect refused')).toContain('href="/cms/affiliates/stripe"');
    expect(item('Stripe Connect refused')).toContain('Stripe Connect setup<');
    expect(item('Stripe Connect refused')).not.toContain('Payout failed');
    expect(item('Insufficient Stripe balance')).toContain('href="/cms/affiliates/stripe"');
    expect(item('Insufficient Stripe balance')).toContain('Stripe balance<');
    // One payout's failure still leads to the payouts list.
    expect(item('Affiliate payout failed')).toContain('href="/cms/affiliates/payouts?view=payouts"');
    expect(item('Affiliate payout failed')).toContain('Payout failed<');
  });

  it('overview shows a load error card instead of throwing', async () => {
    mocks.loadOverview.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '42P01' }));
    const html = renderToStaticMarkup(await OverviewPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('could not be loaded');
    expect(html).not.toContain('42P01');
  });

  it('tiers', async () => {
    const html = renderToStaticMarkup(await TiersPage());
    expectCleanOutline(html);
    expect(html).toContain('Commission tiers');
    expect(html).toContain('No default tier.');
    expect(html).toContain('Founding Ambassador');
    // Live counts that read as such, the spots left, and a link to the tier's partners.
    expect(html).toContain('12 of 50 spots taken');
    expect(html).toContain('38 left');
    expect(html).toContain('aria-label="12 of 50 spots taken, 38 left"');
    expect(html).toContain(`href="/cms/affiliates?tier=${TIER_ID}"`);
    expect(html).not.toContain('12 / 50');
    // The fixture predates 02033 (no goal fields): no goal line, and the page still renders.
    expect(html).not.toContain('Goal:');
    // The only active tier, a default with room: new partners join it.
    expect(html).toContain('New partners join here');
  });

  it('tiers: goals, where new partners go, and uncapped, empty and full tiers', async () => {
    const STARTER_ID = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee';
    const GROWTH_ID = 'eeeeeeee-2222-4222-8222-eeeeeeeeeeee';
    const ELITE_ID = 'eeeeeeee-3333-4333-8333-eeeeeeeeeeee';
    const plain = { is_default_signup_tier: false, is_limited_time_promo: false };
    mocks.loadTiers.mockResolvedValueOnce({
      tiers: [
        {
          ...TIER,
          member_count: 50,
          goal: 'Join while the founding spots last.',
          goal_translations: { fr: 'Inscrivez-vous tant qu’il reste des places fondatrices.' },
        },
        { ...TIER, ...plain, id: STARTER_ID, name: 'Starter Partner', slug: 'starter-partner', max_ambassadors_cap: null, member_count: 1, sort_order: 1 },
        {
          ...TIER,
          ...plain,
          id: GROWTH_ID,
          name: 'Growth Partner',
          slug: 'growth-partner',
          max_ambassadors_cap: null,
          member_count: 0,
          sort_order: 2,
          goal: 'Make 8 confirmed sales, then contact us for a meeting to grow.',
          goal_translations: {},
        },
        { ...TIER, ...plain, id: ELITE_ID, name: 'Elite Partner', slug: 'elite-partner', max_ambassadors_cap: 10, member_count: 0, sort_order: 3 },
      ],
      warnings: [],
    });

    const html = renderToStaticMarkup(await TiersPage());
    const rows = html.split('<tr').slice(1);
    const row = (slug: string) => rows.find((part) => part.includes(`>${slug}<`)) ?? '';

    // The goal shows under the tier (English; the CMS is English-only).
    expect(row('founding-ambassador')).toContain('Goal: Join while the founding spots last.');
    expect(row('growth-partner')).toContain('Goal: Make 8 confirmed sales, then contact us for a meeting to grow.');
    expect(row('starter-partner')).not.toContain('Goal:');

    // Full: the badge, and the tier signups reach instead (selectAffiliateSignupTier).
    expect(row('founding-ambassador')).toContain('50 of 50 spots taken');
    expect(row('founding-ambassador')).toContain('New partners join Starter Partner');
    expect(row('founding-ambassador')).toContain('aria-label="Full, 50 of 50 spots taken, new partners join Starter Partner"');
    expect(row('founding-ambassador')).not.toContain('New partners join here');
    expect(row('starter-partner')).toContain('New partners join here');
    expect(rows.filter((part) => part.includes('New partners join here'))).toHaveLength(1);

    // Uncapped, empty and capped-but-empty tiers.
    expect(row('starter-partner')).toContain('1 partner · No cap');
    expect(row('starter-partner')).toContain(`href="/cms/affiliates?tier=${STARTER_ID}"`);
    expect(row('growth-partner')).toContain('No partners yet · No cap');
    expect(row('growth-partner')).not.toContain('href="/cms/affiliates?tier=');
    expect(row('elite-partner')).toContain('No partners yet');
    expect(row('elite-partner')).toContain('aria-label="No partners yet, 10 spots left"');
    expect(row('elite-partner')).not.toContain('href="/cms/affiliates?tier=');

    // Suspended partners hold their spot: the footnote says so.
    expect(html).toContain('Paused partners keep their spot');
  });

  it('approvals', async () => {
    const html = renderToStaticMarkup(await ApprovalsPage({ searchParams: Promise.resolve({}) }));
    expectCleanOutline(html);
    expectLabelledControls(html);
    expect(html).toContain('Waiting for review (1)');
    expect(html).toContain(`href="/cms/affiliates/approvals/${PAGE_ID}"`);
    expect(html).toContain('First publication');
    expect(html).not.toContain('href="/partners/');
  });

  it('approvals: every published storefront, with its status, pause / resume, email and review link', async () => {
    const html = renderToStaticMarkup(
      await ApprovalsPage({ searchParams: Promise.resolve({ storefronts: '2', storefrontsPageSize: '10' }) })
    );
    expect(html).toContain('Storefronts (1)');
    expect(mocks.loadStorefronts).toHaveBeenCalledWith(expect.anything(), { page: 2, pageSize: 10 });
    // The queue keeps its own page parameters.
    expect(mocks.loadQueue).toHaveBeenCalledWith(expect.anything(), { page: 1, pageSize: 25 });
    const section = /<section aria-labelledby="affiliate-storefronts-heading"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    expect(section).toContain('Studio Nova');
    // The handle is plain text: an admin's click on the storefront would set the referral cookie.
    expect(section).toContain('@studio-nova');
    expect(html).not.toContain('href="/partners/');
    expect(section).toContain('>Paused<');
    expect(section).toContain('Chargebacks on 3 orders');
    expect(section).toContain('aria-label="Resume partner @studio-nova"');
    expect(section).toContain(MAILTO);
    expect(section).toContain(`href="/cms/affiliates/approvals/${STOREFRONT_PAGE_ID}"`);
    expect(section).toContain('Open review');
    // Emails are read for the visible rows only: the queue row and the storefront row.
    expect(mocks.loadEmails).toHaveBeenCalledWith(expect.anything(), [USER_ID, USER_ID]);
    // Not on the sandbox: no lock note, enabled controls.
    expect(html).not.toContain('affiliate-partners-locked-note');
  });

  it('approvals: a paused partner’s published page does not read "Published" under Recently reviewed', async () => {
    mocks.loadQueue.mockResolvedValueOnce({
      items: [],
      total: 0,
      recentlyReviewed: [
        { pageId: PAGE_ID, handle: 'max', displayName: 'Max', status: 'PUBLISHED', partnerStatus: 'SUSPENDED', reviewedAt: '2026-10-20T00:00:00.000Z' },
      ],
    });
    const html = renderToStaticMarkup(await ApprovalsPage({ searchParams: Promise.resolve({}) }));
    const recent = /<section aria-labelledby="affiliate-recent-heading"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    expect(recent).toContain('>Paused<');
    expect(recent).not.toContain('>Published<');
  });

  it('approvals: a storefront list that fails to load shows its own error card', async () => {
    mocks.loadStorefronts.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '57014' }));
    const html = renderToStaticMarkup(await ApprovalsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('The storefront list could not be loaded.');
    expect(html).toContain('Waiting for review (1)');
    expect(html).not.toContain('57014');
  });

  it('approvals: an update from a paused partner is to a paused storefront, not a live one', async () => {
    mocks.loadQueue.mockResolvedValueOnce({
      items: [
        {
          pageId: PAGE_ID,
          affiliateId: AFFILIATE_ID,
          userId: USER_ID,
          handle: 'jane',
          displayName: 'Jane Partner',
          partnerStatus: 'SUSPENDED',
          tierName: 'Founding Ambassador',
          tierBadgeColor: 'amber',
          title: 'Jane’s picks',
          submittedAt: '2026-10-26T00:00:00.000Z',
          draftVersion: 7,
          isFirstPublication: false,
        },
      ],
      total: 1,
      recentlyReviewed: [],
    });
    const html = renderToStaticMarkup(await ApprovalsPage({ searchParams: Promise.resolve({}) }));
    const queue = /<section aria-labelledby="affiliate-queue-heading"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    expect(queue).toContain('Update to a paused storefront');
    expect(queue).not.toContain('Update to a live storefront');
  });

  it('approvals: a page past the last storefront says so and links the first page, keeping the other table’s pages', async () => {
    // Removals shrank the list under a stale ?storefronts= (the loader reads PostgREST's 416 as no rows).
    mocks.loadStorefronts.mockResolvedValueOnce({ rows: [], total: 50 });
    const html = renderToStaticMarkup(
      await ApprovalsPage({ searchParams: Promise.resolve({ storefronts: '9', storefrontsPageSize: '10' }) })
    );
    const section = /<section aria-labelledby="affiliate-storefronts-heading"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    expect(section).toContain('Storefronts (50)');
    expect(section).toContain('This page is past the last storefront.');
    expect(section).toContain('href="/cms/affiliates/approvals?storefrontsPageSize=10"');
    expect(section).toContain('>Go to the first page<');
    expect(section).not.toContain('No storefront has been published yet');
    // No pagination claiming "Page 9 of 5".
    expect(section).not.toContain('Rows per page');
  });

  it('approvals: a page past the last storefront waiting for review says so too', async () => {
    mocks.loadQueue.mockResolvedValueOnce({ items: [], total: 3, recentlyReviewed: [] });
    const html = renderToStaticMarkup(await ApprovalsPage({ searchParams: Promise.resolve({ page: '2', storefronts: '2' }) }));
    const queue = /<section aria-labelledby="affiliate-queue-heading"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    expect(queue).toContain('Waiting for review (3)');
    expect(queue).toContain('This page is past the last storefront waiting for review.');
    expect(queue).toContain('href="/cms/affiliates/approvals?storefronts=2"');
    expect(queue).not.toContain('Nothing to review.');

    // On its first page an empty queue is simply empty.
    mocks.loadQueue.mockResolvedValueOnce({ items: [], total: 0, recentlyReviewed: [] });
    const empty = renderToStaticMarkup(await ApprovalsPage({ searchParams: Promise.resolve({}) }));
    expect(empty).toContain('Nothing to review. Submitted storefronts appear here.');
    expect(empty).not.toContain('past the last storefront waiting');
  });

  it('a failed email lookup reads "unavailable", an unusable address "no usable email"', async () => {
    // The loader leaves a failed lookup out of the map, and maps an unusable address to null.
    mocks.loadEmails.mockResolvedValueOnce({});
    const approvals = renderToStaticMarkup(await ApprovalsPage({ searchParams: Promise.resolve({}) }));
    expect(approvals).toContain('Email unavailable right now');
    expect(approvals).not.toContain('No usable email');
    expect(approvals).not.toContain('href="mailto:');

    mocks.loadEmails.mockResolvedValueOnce({ [USER_ID]: null });
    const review = renderToStaticMarkup(await ReviewPage({ params: Promise.resolve({ pageId: PAGE_ID }) }));
    const card = /<section aria-labelledby="affiliate-review-partner-heading"[\s\S]*?<\/section>/.exec(review)?.[0] ?? '';
    expect(card).toContain('No usable email');
    expect(card).not.toContain('Email unavailable right now');
  });

  it('review', async () => {
    const html = renderToStaticMarkup(await ReviewPage({ params: Promise.resolve({ pageId: PAGE_ID }) }));
    expect(headingLevels(html)[0]).toBe(2);
    expect(html).toContain('Approve &amp; Publish');
    expect(html).toContain('Request changes');
    expect(html).toContain('Removed a link with an unsafe address');
    expect(html).toContain('Trail shoe');
    expect(html).toContain('Draft: hidden on the storefront');
    expect(html).toContain('data-diff="added"');
    expect(html).not.toContain('href="/partners/');
    expect(mocks.loadReview).toHaveBeenCalledWith(expect.anything(), PAGE_ID);
  });

  it('review: the Partner card shows the status, the email, pause and remove', async () => {
    const html = renderToStaticMarkup(await ReviewPage({ params: Promise.resolve({ pageId: PAGE_ID }) }));
    const card = /<section aria-labelledby="affiliate-review-partner-heading"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    expect(card).toContain('Partner</h3>');
    expect(card).toContain('Not published yet');
    expect(card).toContain('jane@partner.dev');
    expect(card).toContain(MAILTO);
    expect(card).toContain('aria-label="Pause partner @jane"');
    const remove = /<button\b[^>]*aria-label="Remove partner @jane"[^>]*>/.exec(card)?.[0] ?? '';
    expect(remove).not.toBe('');
    expect(remove).not.toMatch(/\sdisabled=""/);
    expect(mocks.loadEmails).toHaveBeenCalledWith(expect.anything(), [USER_ID]);
    expect(mocks.ledgerCheck).toHaveBeenCalledWith(expect.anything(), USER_ID);
    expect(html).not.toContain('href="/partners/');
  });

  it('review: the Partner card shows the tier and since when, and offers Change tier', async () => {
    const html = renderToStaticMarkup(await ReviewPage({ params: Promise.resolve({ pageId: PAGE_ID }) }));
    const card = /<section aria-labelledby="affiliate-review-partner-heading"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    expect(card).toContain('>Tier</dt>');
    expect(card).toContain('Founding Ambassador (50%)');
    // Never moved: in the sign-up tier since the account was created.
    expect(card).toContain('Tier since Oct 2, 2026');
    const button = /<button\b[^>]*aria-label="Change tier of @jane"[^>]*>/.exec(card)?.[0] ?? '';
    expect(button).not.toBe('');
    expect(button).not.toMatch(/\sdisabled=""/);
    // Its visible text says what it does (beside Pause partner and Remove partner), and begins its name.
    expect(card).toMatch(/aria-label="Change tier of @jane"[^>]*>(?:(?!<\/button>)[\s\S])*Change tier<\/button>/);
    // The control sits with the other partner controls, before Pause.
    expect(card.indexOf('aria-label="Change tier of @jane"')).toBeLessThan(card.indexOf('aria-label="Pause partner @jane"'));

    mocks.loadReview.mockResolvedValueOnce(
      reviewData({ profile: { ...reviewData().profile, status: 'SUSPENDED', tier_changed_at: '2026-11-05T14:00:00.000Z' } })
    );
    const moved = renderToStaticMarkup(await ReviewPage({ params: Promise.resolve({ pageId: PAGE_ID }) }));
    const movedCard = /<section aria-labelledby="affiliate-review-partner-heading"[\s\S]*?<\/section>/.exec(moved)?.[0] ?? '';
    expect(movedCard).toContain('Tier since Nov 5, 2026');
    // A paused partner can be moved too.
    expect(/<button\b[^>]*aria-label="Change tier of @jane"[^>]*>/.exec(movedCard)?.[0]).not.toMatch(/\sdisabled=""/);
    expect(moved).not.toContain('href="/partners/');
  });

  it('review: Remove is disabled, with the reason, while the partner has ledger history', async () => {
    mocks.ledgerCheck.mockResolvedValueOnce({ kind: 'blocked', reason: 'payouts' });
    const html = renderToStaticMarkup(await ReviewPage({ params: Promise.resolve({ pageId: PAGE_ID }) }));
    const remove = /<button\b[^>]*aria-label="Remove partner @jane"[^>]*>/.exec(html)?.[0] ?? '';
    expect(remove).toMatch(/\sdisabled=""/);
    const describedBy = /aria-describedby="([^"]+)"/.exec(remove)?.[1] ?? '';
    expect(describedBy).not.toBe('');
    expect(html).toContain(`id="${describedBy}"`);
    expect(html).toContain('Jane Partner has commission or payout history, so they can&#x27;t be removed');

    mocks.ledgerCheck.mockResolvedValueOnce({ kind: 'unavailable' });
    const unknown = renderToStaticMarkup(await ReviewPage({ params: Promise.resolve({ pageId: PAGE_ID }) }));
    expect(/<button\b[^>]*aria-label="Remove partner @jane"[^>]*>/.exec(unknown)?.[0]).toMatch(/\sdisabled=""/);
    expect(unknown).toContain('could not be checked, so removal is unavailable right now');
  });

  it('review: a paused partner with history is told to stay paused, and their update is to a paused storefront', async () => {
    mocks.loadReview.mockResolvedValueOnce(
      reviewData({
        profile: { ...reviewData().profile, status: 'SUSPENDED', suspended_reason: 'Spam', first_published_at: '2026-09-01T00:00:00.000Z' },
      })
    );
    mocks.ledgerCheck.mockResolvedValueOnce({ kind: 'blocked', reason: 'commissions' });

    const html = renderToStaticMarkup(await ReviewPage({ params: Promise.resolve({ pageId: PAGE_ID }) }));

    expect(html).toContain('Update to a paused storefront.');
    expect(html).not.toContain('Update to a live storefront.');
    expect(html).toContain('Jane Partner has commission or payout history, so they can&#x27;t be removed. Keep them paused to keep those records.');
    expect(html).not.toContain('pause them instead');
    expect(html).toContain('aria-label="Resume partner @jane"');
  });

  it('review: an unknown page is a 404 and a paused partner cannot be approved', async () => {
    mocks.loadReview.mockResolvedValueOnce(null);
    await expect(ReviewPage({ params: Promise.resolve({ pageId: PAGE_ID }) })).rejects.toThrow('NEXT_NOT_FOUND');

    mocks.loadReview.mockResolvedValueOnce(
      reviewData({ profile: { ...reviewData().profile, status: 'SUSPENDED', suspended_reason: 'Fake reviews' } })
    );
    const html = renderToStaticMarkup(await ReviewPage({ params: Promise.resolve({ pageId: PAGE_ID }) }));
    expect(html).toContain('This partner is paused');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Approve &amp; Publish/);
    // The Partner card: paused, with the reason, and Resume instead of Pause.
    expect(html).toContain('Fake reviews');
    expect(html).toContain('aria-label="Resume partner @jane"');
    expect(html).not.toContain('aria-label="Pause partner @jane"');
  });

  it('payouts: commissions ledger with the currency mismatch warning', async () => {
    mocks.loadPayouts.mockResolvedValueOnce(payoutsData('commissions'));
    const html = renderToStaticMarkup(await PayoutsPage({ searchParams: Promise.resolve({}) }));
    expectCleanOutline(html);
    expectLabelledControls(html);
    expect(html).toContain('settles in CAD');
    expect(html).toContain(`href="/cms/orders/${ORDER_ID}"`);
    expect(html).toContain('Clears in 12 days');
    expect(html).toContain('$45.00');
  });

  it('payouts: failed payouts offer Retry and Release', async () => {
    mocks.loadPayouts.mockResolvedValueOnce(payoutsData('payouts'));
    const html = renderToStaticMarkup(await PayoutsPage({ searchParams: Promise.resolve({ view: 'payouts' }) }));
    expect(html).toContain('The Stripe balance was too low.');
    expect(html).toContain('Retry');
    expect(html).toContain('Release');
    expect(html).toContain('1 payout has failed.');
  });

  it('payouts: survives the platform read failing', async () => {
    mocks.loadPayouts.mockResolvedValueOnce(payoutsData('commissions'));
    mocks.platformInfo.mockRejectedValueOnce(new Error('Invalid API Key provided: sk_test_123'));
    const html = renderToStaticMarkup(await PayoutsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('Could not be reached');
    expect(html).not.toContain('sk_test_123');
  });
});

describe('program settings: the partner terms fields', () => {
  /** The sandbox refusal under the terms fields (ProgramSettingsForm = the action's error), as React escapes it. */
  const TERMS_LOCKED_NOTE =
    'Partner terms links can&#x27;t be changed in the sandbox: every visitor, and the partner sign-up form, would be sent there.';
  const TEMPLATE_HELP =
    'Leave empty to use the built-in terms. The built-in terms are a starting template, not legal advice: have them reviewed, or link your own page.';
  const IDENTITY_HELP = 'The built-in terms use the legal name and the support email from';
  const CONTACT_MISSING = 'No support email is set there yet, so they show partners no contact address.';

  async function renderWithSettings(settings: Partial<typeof SETTINGS> = {}) {
    mocks.loadOverview.mockResolvedValueOnce({ ...overviewData(), settings: { ...SETTINGS, ...settings } });
    return renderToStaticMarkup(await OverviewPage({ searchParams: Promise.resolve({}) }));
  }

  /** The opening tag of the input whose `<label>` reads exactly `label`. */
  function inputFor(html: string, label: string): string {
    const labelTag = [...html.matchAll(/<label\b([^>]*)>([^<]*)<\/label>/g)].find(([, , text]) => text === label);
    const id = labelTag ? /\sfor="([^"]+)"/.exec(labelTag[1] ?? '')?.[1] : undefined;
    expect(id, label).toBeDefined();
    const tag = [...html.matchAll(/<input\b[^>]*>/g)].map(([match]) => match).find((match) => match.includes(`id="${id}"`));
    expect(tag, label).toBeDefined();
    return tag as string;
  }

  /** The markup of every element an input's aria-describedby names (each a `<p>` or `<div>` of text). */
  function describedBy(html: string, input: string): string {
    const ids = /\saria-describedby="([^"]+)"/.exec(input)?.[1]?.split(' ') ?? [];
    expect(ids.length, input).toBeGreaterThan(0);
    return ids
      .map((id) => {
        const at = html.indexOf(`id="${id}"`);
        expect(at, id).toBeGreaterThan(-1);
        const open = html.lastIndexOf('<', at);
        const tag = /^<(\w+)/.exec(html.slice(open))?.[1] ?? 'div';
        return html.slice(open, html.indexOf(`</${tag}>`, at));
      })
      .join('\n');
  }

  it('labels both fields and describes them: the template warning, where the identity comes from, the preview link', async () => {
    const html = await renderWithSettings();
    expect(html).toContain('<legend class="text-sm font-medium text-foreground">Partner terms</legend>');
    for (const label of ['Partner terms page (English)', 'Partner terms page (French)']) {
      const input = inputFor(html, label);
      expect(input, label).toContain('value=""');
      expect(input, label).not.toMatch(/\sdisabled=""/);
      const help = describedBy(html, input);
      expect(help, label).toContain(TEMPLATE_HELP);
      expect(help, label).toMatch(
        new RegExp(`${IDENTITY_HELP} <a href="/cms/settings/privacy" class="[^"]*underline[^"]*">Settings → Privacy &amp; Consent</a>\\.</p>`),
      );
      expect(help, label).toMatch(
        /<a href="\/partners\/terms\?builtin=1" target="_blank" rel="noopener noreferrer" class="[^"]*">Preview built-in terms<svg[^>]*aria-hidden="true"[\s\S]*?<span class="sr-only"> \(opens in a new tab\)<\/span><\/a>/,
      );
      expect(help, label).not.toContain(CONTACT_MISSING);
      expect(help, label).not.toContain('changed in the sandbox');
    }
    expect(describedBy(html, inputFor(html, 'Partner terms page (French)'))).toContain(
      'Empty: French visitors get the English page above when one is set.',
    );
    // The privacy settings are read once, for the built-in terms the page is about.
    expect(mocks.termsIdentity).toHaveBeenCalledTimes(1);
  });

  it('fills the fields with the saved pages (then the built-in terms are not in use: no privacy read, no notice)', async () => {
    mocks.termsIdentity.mockResolvedValue({ company: '', contactEmail: null, settingsRead: true });
    const html = await renderWithSettings({ termsUrlEn: '/legal/partner-terms', termsUrlFr: 'https://legal.example.com/conditions' });
    expect(inputFor(html, 'Partner terms page (English)')).toContain('value="/legal/partner-terms"');
    expect(inputFor(html, 'Partner terms page (French)')).toContain('value="https://legal.example.com/conditions"');
    expect(html).not.toContain(CONTACT_MISSING);
    expect(mocks.termsIdentity).not.toHaveBeenCalled();
  });

  it('says when the built-in terms show partners no contact address (no support email under Settings → Privacy & Consent)', async () => {
    mocks.termsIdentity.mockResolvedValue({ company: 'Maple Shop', contactEmail: null, settingsRead: true });
    let html = await renderWithSettings();
    expect(describedBy(html, inputFor(html, 'Partner terms page (English)'))).toContain(
      `Settings → Privacy &amp; Consent</a>. ${CONTACT_MISSING}</p>`,
    );

    // A French page alone leaves the English visitors on the built-in terms: still worth saying.
    html = await renderWithSettings({ termsUrlFr: '/legal/conditions' });
    expect(html).toContain(CONTACT_MISSING);

    // Unreadable privacy settings: nothing is known, so nothing is claimed.
    mocks.termsIdentity.mockResolvedValue({ company: '', contactEmail: null, settingsRead: false });
    html = await renderWithSettings();
    expect(html).not.toContain(CONTACT_MISSING);
    expect(html).toContain(IDENTITY_HELP);
  });

  it('on the public sandbox: both fields disabled and empty, described by the refusal (so the form never sends a link)', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const html = await renderWithSettings({ termsUrlEn: '/legal/partner-terms', termsUrlFr: '/legal/conditions' });
    for (const label of ['Partner terms page (English)', 'Partner terms page (French)']) {
      const input = inputFor(html, label);
      expect(input, label).toMatch(/\sdisabled=""/);
      expect(input, label).toContain('value=""');
      expect(input, label).not.toContain('value="/legal/');
      expect(describedBy(html, input), label).toContain(TERMS_LOCKED_NOTE);
    }

    for (const value of ['', 'false', 'TRUE', '1']) {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      const page = await renderWithSettings({ termsUrlEn: '/legal/partner-terms' });
      const input = inputFor(page, 'Partner terms page (English)');
      expect(input, value).not.toMatch(/\sdisabled=""/);
      expect(input, value).toContain('value="/legal/partner-terms"');
      expect(page, value).not.toContain(TERMS_LOCKED_NOTE);
    }
  });
});

describe('overview on the public sandbox', () => {
  const LOCKED_NOTE_ID = 'affiliate-partners-locked-note';
  /** The partner actions' refusal, as React escapes it. */
  const LOCKED_NOTE = 'Partner accounts can&#x27;t be changed in the sandbox: every visitor shares them.';
  /** The program settings' help under the notification addresses (ProgramSettingsForm). */
  const EMAILS_HELP =
    'Signups, completed profiles, submitted storefronts and payout problems are emailed here (up to 10 addresses, one per line). Leave it empty to use the store contact address.';
  /** One paused partner (Change tier, Resume) and one active partner (Change tier, Pause). */
  const PARTNER_BUTTONS = ['Change tier of @jane', 'Resume partner @jane', 'Change tier of @studio-nova', 'Pause partner @studio-nova'];

  function overviewWithBothStatuses() {
    const data = overviewData();
    const [jane] = data.partners.rows;
    const studioNova = {
      ...jane,
      id: 'bbbbbbbb-3333-4333-8333-bbbbbbbbbbbb',
      handle: 'studio-nova',
      displayName: 'Studio Nova',
      status: 'ACTIVE' as const,
      suspendedReason: null,
      pageId: null,
      pageStatus: 'PUBLISHED' as const,
      hasPublishedPage: true,
      isApproved: true,
    };
    return { ...data, partners: { rows: [jane, studioNova], total: 2 } };
  }

  async function renderOverview() {
    mocks.loadOverview.mockResolvedValueOnce(overviewWithBothStatuses());
    return renderToStaticMarkup(await OverviewPage({ searchParams: Promise.resolve({}) }));
  }

  /** The opening tag of the button with this accessible name. */
  function buttonTag(html: string, label: string): string {
    const tag = [...html.matchAll(/<button\b[^>]*>/g)].map(([match]) => match).find((match) => match.includes(`aria-label="${label}"`));
    expect(tag, label).toBeDefined();
    return tag as string;
  }

  it('shows the tour above the overview, each stop linked to its screen', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const html = await renderOverview();

    expectCleanOutline(html);
    expectLabelledControls(html);
    const tour = html.indexOf('id="affiliate-sandbox-tour-heading"');
    expect(tour).toBeGreaterThan(html.indexOf('<h2'));
    expect(tour).toBeLessThan(html.indexOf('id="affiliate-metrics-heading"'));
    expect(html).toContain('Try the affiliate program');
    for (const href of ['/cms/affiliates/approvals', '/cms/orders', '/cms/affiliates/tiers', '/cms/affiliates/payouts', '/partners']) {
      expect(html, href).toContain(`href="${href}"`);
    }
    expect(html).toContain('<p class="text-foreground">This sandbox resets every 15 minutes. Things to try:</p>');
    expect(html).toContain('<ul class="list-disc space-y-1 pl-5 text-foreground">');
    expect(html).toContain('Studio Nova’s pending order');
    expect(html).toContain(
      ': mark Studio Nova’s pending order as paid to record a commission, or set a paid order to Refunded to void its commission (one already paid out raises an alert instead).',
    );
    expect(html).toContain(': browse the commission ledger and a failed payout. Payouts are disabled in the sandbox.');
    // The landing page only: an admin visit to a storefront would set a referral cookie and count a click.
    // The program settings' terms preview is no storefront (`terms` is a reserved handle the proxy never reads).
    expect(html).not.toMatch(/href="\/partners\/(?!terms\?builtin=1")/);
  });

  it('underlines every tour link, so none differs from its sentence by colour alone', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const html = await renderOverview();
    const section = /<section aria-labelledby="affiliate-sandbox-tour-heading"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    const links = [...section.matchAll(/<a\b[^>]*>/g)].map(([tag]) => tag);

    expect(links).toHaveLength(5);
    for (const tag of links) {
      const classes = /class="([^"]*)"/.exec(tag)?.[1]?.split(' ') ?? [];
      expect(classes, tag).toEqual(expect.arrayContaining(['underline', 'hover:no-underline', 'focus-visible:ring-2']));
      expect(classes, tag).not.toContain('hover:underline');
    }
  });

  it('says the sandbox sends no email under the notification addresses, and only there', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    expect(await renderOverview()).toContain(`${EMAILS_HELP} The sandbox sends no email.</p>`);

    for (const value of ['', 'false', 'TRUE', '1']) {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      const html = await renderOverview();
      expect(html, value).toContain(`${EMAILS_HELP}</p>`);
      expect(html, value).not.toContain('The sandbox sends no email.');
    }
  });

  it('renders every partner control disabled, described by the note', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const html = await renderOverview();

    expect(html).toContain(`id="${LOCKED_NOTE_ID}"`);
    expect(html).toContain(LOCKED_NOTE);
    for (const label of PARTNER_BUTTONS) {
      const tag = buttonTag(html, label);
      expect(tag, label).toMatch(/\sdisabled=""/);
      expect(tag, label).toContain(`aria-describedby="${LOCKED_NOTE_ID}"`);
    }
  });

  it('shows neither the tour nor the lock anywhere else (only the exact value "true" is the sandbox)', async () => {
    for (const value of ['', 'false', 'TRUE', '1']) {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      const html = await renderOverview();

      expect(html, value).not.toContain('Try the affiliate program');
      expect(html, value).not.toContain('affiliate-sandbox-tour-heading');
      expect(html, value).not.toContain(LOCKED_NOTE_ID);
      expect(html, value).not.toContain('changed in the sandbox');
      for (const label of PARTNER_BUTTONS) {
        const tag = buttonTag(html, label);
        expect(tag, `${value} ${label}`).not.toMatch(/\sdisabled=""/);
        expect(tag, `${value} ${label}`).not.toContain('aria-describedby');
      }
    }
  });
});

describe('approvals and review on the public sandbox', () => {
  const LOCKED_NOTE_ID = 'affiliate-partners-locked-note';
  const LOCKED_NOTE = 'Partner accounts can&#x27;t be changed in the sandbox: every visitor shares them.';

  function buttonTag(html: string, label: string): string {
    const tag = [...html.matchAll(/<button\b[^>]*>/g)].map(([match]) => match).find((match) => match.includes(`aria-label="${label}"`));
    expect(tag, label).toBeDefined();
    return tag as string;
  }

  it('renders the Storefronts pause / resume disabled, described by the note', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const html = renderToStaticMarkup(await ApprovalsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain(`id="${LOCKED_NOTE_ID}"`);
    expect(html).toContain(LOCKED_NOTE);
    const tag = buttonTag(html, 'Resume partner @studio-nova');
    expect(tag).toMatch(/\sdisabled=""/);
    expect(tag).toContain(`aria-describedby="${LOCKED_NOTE_ID}"`);
    expect(html).not.toContain('href="/partners/');
  });

  it('renders the Partner card controls disabled, described by the note', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const html = renderToStaticMarkup(await ReviewPage({ params: Promise.resolve({ pageId: PAGE_ID }) }));
    expect(html).toContain(`id="${LOCKED_NOTE_ID}"`);
    for (const label of ['Change tier of @jane', 'Pause partner @jane', 'Remove partner @jane']) {
      const tag = buttonTag(html, label);
      expect(tag, label).toMatch(/\sdisabled=""/);
      expect(tag, label).toContain(LOCKED_NOTE_ID);
    }
  });

  it('keeps them enabled anywhere else (only the exact value "true" is the sandbox)', async () => {
    for (const value of ['', 'false', 'TRUE', '1']) {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      const approvals = renderToStaticMarkup(await ApprovalsPage({ searchParams: Promise.resolve({}) }));
      const review = renderToStaticMarkup(await ReviewPage({ params: Promise.resolve({ pageId: PAGE_ID }) }));
      expect(approvals, value).not.toContain(LOCKED_NOTE_ID);
      expect(review, value).not.toContain(LOCKED_NOTE_ID);
      expect(buttonTag(approvals, 'Resume partner @studio-nova'), value).not.toMatch(/\sdisabled=""/);
      expect(buttonTag(review, 'Change tier of @jane'), value).not.toMatch(/\sdisabled=""/);
      expect(buttonTag(review, 'Pause partner @jane'), value).not.toMatch(/\sdisabled=""/);
      expect(buttonTag(review, 'Remove partner @jane'), value).not.toMatch(/\sdisabled=""/);
    }
  });
});

/* ------------------------------------------------------------ Stripe payouts --- */

const CONNECT_ALERT_ID = 'f2f2f2f2-2222-4222-8222-f2f2f2f2f2f2';

/** What `loadAffiliateStripePayoutsOverview()` hands the Stripe payouts screen (test mode, a local site). */
function stripeOverview(overrides: Record<string, unknown> = {}) {
  return {
    sandbox: false,
    keys: {
      sandbox: false,
      secretKeySource: 'cms',
      storedSecretKeyUnreadable: false,
      mode: 'test',
      restricted: false,
      secretKeyLast4: '4242',
      publishableKeySource: 'cms',
      publishableKeyMode: 'test',
      publishableKeyMatchesMode: true,
      webhookSecretSource: 'env',
    },
    platform: {
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
    },
    schedule: { interval: 'daily', delayDays: 2 },
    baseCurrency: 'USD',
    settings: SETTINGS,
    funding: {
      livemode: false,
      modeSource: 'stripe',
      windowDays: 30,
      truncated: false,
      stripeFigures: true,
      rows: [
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
          neededCents: 15_500,
          transferableCents: 8_000,
          pendingCents: 1_500,
          shortCents: 6_000,
        },
      ],
    },
    automation: {
      cronSecretConfigured: false,
      cronSecretTooShort: false,
      lastRun: { runDate: '2026-11-10', trigger: 'cron', finishedAt: '2026-11-10T06:00:40.000Z', sent: 3, failed: 1, remaining: 0, aborted: null },
      nextScheduledRunAt: '2026-11-11T06:00:00.000Z',
      returnUrl: 'http://localhost:4200/portal/retailer/payouts?connected=1',
      siteUrlConfigured: false,
      webhookUrl: 'http://localhost:4200/api/webhooks/stripe',
      webhookReachable: false,
    },
    connectAlert: {
      id: CONNECT_ALERT_ID,
      title: 'Stripe Connect refused a partner’s payout setup',
      message: 'Stripe refused the Express account creation (stripe_invalid_request), so a partner could not set up payouts.',
      createdAt: '2026-11-10T08:00:00.000Z',
      stripeCode: 'stripe_invalid_request',
      step: 'account_creation',
    },
    ...overrides,
  };
}

/** The opening tag of the button whose text contains `text`. */
function buttonWithText(html: string, text: string): string {
  const match = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(([tag]) => tag).find((tag) => tag.includes(text));
  expect(match, text).toBeDefined();
  return (match as string).slice(0, (match as string).indexOf('>') + 1);
}

describe('stripe payouts screen', () => {
  it('says who pays partners, shows the keys, the balance verdict, the schedule fix, the automation and the guide', async () => {
    const html = renderToStaticMarkup(await StripePayoutsPage());
    expectCleanOutline(html);
    expectLabelledControls(html);

    // Who pays your partners (first card).
    expect(html.indexOf('Who pays your partners')).toBeLessThan(html.indexOf('Stripe keys'));
    expect(html).toContain(
      'Customers pay you through Freemius (digital products) and Stripe (physical products). Your partners are always paid through Stripe Connect, from your Stripe balance — including their commissions on Freemius sales. Freemius pays you, never your partners, and its sales never add money to your Stripe balance.'
    );
    expect(html).toContain(
      'Payouts use the same Stripe account and secret key as physical-product checkout. Payouts need only the secret key; the publishable key and webhook secret serve checkout and refunds.'
    );

    // The keys live under Payments; only the last 4 characters show.
    expect(html).toContain('href="/cms/payments"');
    expect(html).toContain('Edit keys in Payments');
    expect(html).toContain('Saved in the CMS · ending in 4242');
    expect(html).toContain('Key accepted (test mode)');
    expect(html).toContain('CA · Store USD · Stripe USD');
    expect(html).toContain('Present, test mode');
    expect(html).toContain('Set · from the environment (STRIPE_WEBHOOK_SECRET)');
    expect(buttonWithText(html, 'Test connection')).not.toMatch(/\sdisabled=""/);

    // Balance vs what you owe.
    expect(html).toContain('Short by $60.00');
    expect(html).toContain('Stripe sales $60.00 · Freemius sales $40.00');
    expect(html).toContain('$80.00 available · $15.00 pending');
    expect(html).toContain('$40.00 of it was earned on Freemius sales');
    // Owed now counts every partner; the next run pays only the payable part of it.
    expect(html).toContain(
      'Owed now is every cleared commission in no payout and under no dispute, net of refunds. The next payout run pays only the part owed to active partners with an approved storefront who finished Stripe onboarding and reached the minimum payout, and only while the balance covers it.'
    );
    expect(html).not.toContain('Owed now is what the next payout run claims');
    expect(html).not.toContain('settles in');

    // Keep money in Stripe: a daily schedule gets the advice, not an alert (a Minimum balance can't be read).
    const keep = /<section aria-labelledby="stripe-keep-heading"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    expect(keep).toContain('Stripe pays your balance out daily, 2 days after each payment.');
    expect(keep).toContain(
      'Unless you keep a Minimum balance of at least a month of commissions (about $90.00: your commissions of the last 30 days), set the schedule to Manual in the Stripe Dashboard → Settings → Payouts.'
    );
    expect(keep).toContain('This screen can’t read a minimum balance');
    expect(keep).not.toContain('role="alert"');
    expect(html).toContain(
      'Top-ups (adding funds to your Stripe balance) exist only in some countries (US, UK, Japan; private preview in Canada: ask Stripe).'
    );

    // Automation.
    expect(html).toContain('On · minimum $5.00');
    expect(html).toContain(
      'Not configured: the payout endpoint refuses every call, so the daily run happens on the first CMS or portal visit of the day'
    );
    expect(html).toContain('Nov 10, 2026 (Scheduled run) · 3 sent, 1 failed');
    expect(html).not.toContain('(cron)');
    expect(html).toContain('http://localhost:4200/portal/retailer/payouts?connected=1');
    expect(html).toContain('That works in test mode on this computer only.');
    expect(html).not.toContain('Your Stripe key is live');

    // The latest Connect setup alert, with "Done".
    expect(html).toContain('Stripe Connect refused a partner’s payout setup');
    expect(html).toContain('aria-label="Mark as done: Stripe Connect refused a partner’s payout setup"');

    // The guide.
    expect(html).toContain('Set up Stripe for payouts');
    expect(html).toContain('4000 0000 0000 0077');
    // A local site: the plain Stripe CLI command for this address (npm run stripe exists only in the monorepo).
    expect(html).toContain('<code class="break-all">stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,charge.refunded,charge.dispute.created,charge.dispute.closed --forward-to http://localhost:4200/api/webhooks/stripe</code>');
    expect(html).not.toContain('npm run stripe');
    expect(html).toContain('<code>whsec_…</code> signing secret it prints');
    // What a test payout needs after the order: a 0-day hold set first, an approved storefront, onboarding.
    expect(html).toContain('Give them a tier with a 0-day clearance hold');
    expect(html).toContain('href="/cms/affiliates/tiers"');
    expect(html).toContain('a hold changed later doesn’t move a commission already recorded');
    expect(html).toContain('finish Stripe onboarding from their portal while this site uses the test key');
    expect(html).toContain('Before going live, remove the test tier or restore its hold.');
    expect(html).toContain('<code>pk_test_…</code>');
    expect(html).not.toContain('href="/partners/');
  });

  it('confirms manual payouts, and warns when a live key would send partners back to a non-https address', async () => {
    const base = stripeOverview();
    mocks.stripeOverview.mockResolvedValueOnce(
      stripeOverview({
        schedule: { interval: 'manual', delayDays: 0 },
        platform: { ...base.platform, livemode: true },
        keys: { ...base.keys, mode: 'live', publishableKeyMode: 'test', publishableKeyMatchesMode: false },
        connectAlert: null,
      })
    );
    const html = renderToStaticMarkup(await StripePayoutsPage());

    expect(html).toContain('Your Stripe payouts are manual: your balance stays in Stripe until you pay it out yourself.');
    expect(html).toContain('Your Stripe key is live, but no site address is configured');
    expect(html).toContain('Present, but test mode: use the pair of the same mode');
    expect(html).not.toContain('Mark as done');
  });

  it('on the sandbox shows no key fact and no Stripe figure, and disables the test', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const base = stripeOverview();
    mocks.stripeOverview.mockResolvedValueOnce(
      stripeOverview({
        sandbox: true,
        keys: { ...base.keys, sandbox: true, secretKeySource: null, mode: null, secretKeyLast4: null },
        platform: { ...base.platform, sandbox: true, stripeConfigured: false, livemode: null, transferable: null, pending: null },
        schedule: null,
        funding: {
          ...base.funding,
          modeSource: 'default',
          livemode: true,
          stripeFigures: false,
          rows: [{ ...base.funding.rows[0], transferableCents: null, pendingCents: null, shortCents: null }],
        },
        connectAlert: null,
      })
    );
    const html = renderToStaticMarkup(await StripePayoutsPage());
    expectCleanOutline(html);

    expect(html).toContain('On the sandbox the Stripe keys come from the deployment’s environment and belong to its operator');
    expect(html).not.toContain('ending in');
    expect(html).toContain('Not read on the sandbox');
    expect(html).toContain('Not checked');
    expect(html).toContain('The payout schedule is not read on the sandbox.');
    expect(html).toContain('None: payouts are off on the sandbox');
    const button = buttonWithText(html, 'Test connection');
    expect(button).toMatch(/\sdisabled=""/);
    expect(button).toContain('aria-describedby=');
    expect(html).toContain('Not available on the sandbox: its Stripe keys belong to the site&#x27;s operator.');
  });

  it('keeps rendering when what is owed could not be loaded, and asks for a key when none is set', async () => {
    const base = stripeOverview();
    mocks.stripeOverview.mockResolvedValueOnce(
      stripeOverview({
        funding: null,
        // What getStripeKeyDiagnostics() answers without a secret key: no mode, so nothing to match.
        keys: { ...base.keys, secretKeySource: null, secretKeyLast4: null, mode: null, publishableKeyMatchesMode: false },
      })
    );
    const html = renderToStaticMarkup(await StripePayoutsPage());
    expect(html).toContain('What you owe your partners could not be loaded.');
    expect(buttonWithText(html, 'Test connection')).toMatch(/\sdisabled=""/);
    expect(html).toContain('Add a Stripe secret key under Payments first.');
    // No secret key mode: the publishable key has no pair to mismatch.
    expect(html).toContain('Present, test mode');
    expect(html).not.toContain('use the pair of the same mode');
  });

  it('says a restricted key lacks a permission, not that Stripe is unreachable, and names a rejected key', async () => {
    const base = stripeOverview();
    // A restricted key without Balance read: every read that sets the mode fails with a 403.
    mocks.stripeOverview.mockResolvedValueOnce(
      stripeOverview({
        keys: { ...base.keys, restricted: true },
        platform: { ...base.platform, stripeConfigured: true, livemode: null, available: null, transferable: null, pending: null, error: 'stripe_permission' },
      })
    );
    let html = renderToStaticMarkup(await StripePayoutsPage());
    expect(html).toContain('Key accepted, but it can&#x27;t read everything payouts need (the balance)');
    expect(html).not.toContain('Couldn&#x27;t reach Stripe');
    expect(html).toContain('A restricted key must allow, for payouts: Balance (read)');

    // With the mode known (the balance answered), the mode is named.
    mocks.stripeOverview.mockResolvedValueOnce(stripeOverview({ platform: { ...base.platform, livemode: true, error: 'stripe_permission' } }));
    html = renderToStaticMarkup(await StripePayoutsPage());
    expect(html).toContain('Key accepted (live mode), but it can&#x27;t read everything payouts need');

    mocks.stripeOverview.mockResolvedValueOnce(
      stripeOverview({ platform: { ...base.platform, livemode: null, transferable: null, pending: null, error: 'stripe_authentication' } })
    );
    html = renderToStaticMarkup(await StripePayoutsPage());
    expect(html).toContain('Stripe rejected this key');

    mocks.stripeOverview.mockResolvedValueOnce(
      stripeOverview({ platform: { ...base.platform, livemode: null, transferable: null, pending: null, error: 'stripe_unavailable' } })
    );
    html = renderToStaticMarkup(await StripePayoutsPage());
    expect(html).toContain('Couldn&#x27;t reach Stripe');
  });

  it('shows the platform country and settlement currency, and warns when Stripe settles in another currency', async () => {
    const base = stripeOverview();
    mocks.stripeOverview.mockResolvedValueOnce(
      stripeOverview({ platform: { ...base.platform, platformDefaultCurrency: 'CAD', currencyMismatch: true } })
    );
    const html = renderToStaticMarkup(await StripePayoutsPage());

    expect(html).toContain('CA · Store USD · Stripe CAD');
    const funding = /<section aria-labelledby="stripe-funding-heading"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    // Above the table, where a "Short by" in USD would otherwise have no explanation.
    expect(funding.indexOf('Your Stripe account settles in CAD')).toBeGreaterThan(-1);
    expect(funding.indexOf('Your Stripe account settles in CAD')).toBeLessThan(funding.indexOf('<table'));
    expect(funding).toContain(
      'Your Stripe account settles in CAD, but commissions are recorded and paid in the store currency, USD. Transfers in USD need a USD balance: either add USD to your Stripe account or make CAD the store’s default currency.'
    );
  });

  it('labels the last run, tells an unreadable run apart, and promises the visit fallback only when it runs', async () => {
    const base = stripeOverview();
    const ran = base.automation.lastRun;
    mocks.stripeOverview.mockResolvedValueOnce(
      stripeOverview({ automation: { ...base.automation, lastRun: { ...ran, trigger: 'admin', remaining: 1, aborted: 'stripe_authentication' } } })
    );
    let html = renderToStaticMarkup(await StripePayoutsPage());
    expect(html).toContain('Nov 10, 2026 (Run by an admin) · 3 sent, 1 failed, 1 partner left · stopped: Stripe rejected the key');
    expect(html).not.toContain('stripe_authentication');

    // An unknown trigger is left out rather than shown raw.
    mocks.stripeOverview.mockResolvedValueOnce(stripeOverview({ automation: { ...base.automation, lastRun: { ...ran, trigger: 'weird' } } }));
    html = renderToStaticMarkup(await StripePayoutsPage());
    expect(html).toContain('Nov 10, 2026 · 3 sent, 1 failed');
    expect(html).not.toContain('weird');

    // An unreadable run table is not "No run yet".
    mocks.stripeOverview.mockResolvedValueOnce(stripeOverview({ automation: { ...base.automation, lastRun: 'unavailable' } }));
    html = renderToStaticMarkup(await StripePayoutsPage());
    expect(html).toContain('Could not be read');
    expect(html).not.toContain('No run yet');
  });

  it('says the daily run still clears commissions when it sends no transfer, and names a CRON_SECRET that is too short (02036)', async () => {
    const base = stripeOverview();
    // Automatic transfers off: the visit fallback still runs the daily ledger repair, without a transfer.
    mocks.stripeOverview.mockResolvedValueOnce(
      stripeOverview({
        settings: { ...SETTINGS, autoPayoutsEnabled: false },
        automation: { ...base.automation, cronSecretTooShort: true, lastRun: null },
      })
    );
    let html = renderToStaticMarkup(await StripePayoutsPage());
    expect(html).toContain(
      'Too short (under 16 characters): the payout endpoint refuses it, so the daily run happens on the first CMS or portal visit of the day. Use a longer secret.'
    );
    expect(html).toContain('(it clears commissions; it sends no Stripe transfer: automatic Stripe transfers are off)');
    expect(html).not.toContain('None: automatic payouts are off');
    expect(html).toContain('No run yet');

    // No Stripe key: commissions still clear; transfers wait for a key.
    mocks.stripeOverview.mockResolvedValueOnce(
      stripeOverview({ platform: { ...base.platform, stripeConfigured: false, livemode: null, transferable: null, pending: null } })
    );
    html = renderToStaticMarkup(await StripePayoutsPage());
    expect(html).toContain('the first CMS or portal visit of the day');
    expect(html).toContain('(it clears commissions; it sends no Stripe transfer: no Stripe secret key is configured (add one under Payments))');
    expect(html).not.toContain('None: add a Stripe secret key under Payments first');

    // Every commission paid by hand and no key: the run is promised without asking for a key.
    mocks.stripeOverview.mockResolvedValueOnce(
      stripeOverview({
        settings: { ...SETTINGS, payoutMethods: { stripeSales: 'manual', freemiusSales: 'manual' } },
        platform: { ...base.platform, stripeConfigured: false, livemode: null, transferable: null, pending: null },
      })
    );
    html = renderToStaticMarkup(await StripePayoutsPage());
    expect(html).toContain('(it clears commissions; it sends no Stripe transfer: every commission is paid manually)');
    expect(html).not.toContain('add one under Payments');
  });

  it('on a public site points the guide at a Dashboard endpoint instead of the Stripe CLI', async () => {
    const base = stripeOverview();
    mocks.stripeOverview.mockResolvedValueOnce(
      stripeOverview({
        automation: {
          ...base.automation,
          returnUrl: 'https://shop.example.com/portal/retailer/payouts?connected=1',
          siteUrlConfigured: true,
          webhookUrl: 'https://shop.example.com/api/webhooks/stripe',
          webhookReachable: true,
        },
      })
    );
    const html = renderToStaticMarkup(await StripePayoutsPage());
    expect(html).toContain('add an endpoint for <code>https://shop.example.com/api/webhooks/stripe</code> in the Stripe Dashboard');
    expect(html).not.toContain('stripe listen');
  });

  it('shows the commissions paid by hand as "Paid manually", outside Needed and the Freemius split (02036)', async () => {
    const base = stripeOverview();
    const row = base.funding.rows[0];
    mocks.stripeOverview.mockResolvedValueOnce(
      stripeOverview({
        settings: { ...SETTINGS, payoutMethods: { stripeSales: 'stripe_connect', freemiusSales: 'manual' } },
        funding: {
          ...base.funding,
          rows: [{ ...row, owedNowCents: 6_000, owedNowFreemiusCents: 0, owedManuallyCents: 4_000, neededCents: 11_500, shortCents: 2_000 }],
        },
      })
    );

    const html = renderToStaticMarkup(await StripePayoutsPage());

    expect(html).toContain('Paid manually: $40.00 owed');
    expect(html).not.toContain('Freemius sales $0.00');
    expect(html).toContain('Needed $115.00');
    expect(html).toContain('Owed now is every cleared commission in no payout and under no dispute, net of refunds, on the sales paid through Stripe.');
    expect(html).toContain('it never needs your Stripe balance and is not part of Needed');
    expect(html).toContain(
      'Commissions on Stripe sales are paid through Stripe Connect, from your Stripe balance; commissions on Freemius sales are paid manually (PayPal, Interac e-Transfer or bank transfer) and recorded on the'
    );
    expect(html).not.toContain('Your partners are always paid through Stripe Connect');
  });

  it('says every commission is paid by hand when no gateway goes through Stripe, and points a Stripe-only store at the setting', async () => {
    mocks.stripeOverview.mockResolvedValueOnce(stripeOverview({ settings: { ...SETTINGS, payoutMethods: { stripeSales: 'manual', freemiusSales: 'manual' } } }));
    let html = renderToStaticMarkup(await StripePayoutsPage());
    expect(html).toContain('Every commission is paid manually (PayPal, Interac e-Transfer or bank transfer) and recorded on the');

    html = renderToStaticMarkup(await StripePayoutsPage());
    expect(html).toContain(
      'To pay the commissions on Freemius sales from PayPal or Interac e-Transfer instead, choose PayPal (automatic) or Manually under'
    );
    expect(html).toContain('or pay those commissions manually (Overview → Program settings → How partners are paid).');
  });
});

describe('payouts screen: Stripe state and the run button', () => {
  it('links the Stripe payouts screen and shows the transferable (card) balance with what is pending', async () => {
    mocks.loadPayouts.mockResolvedValueOnce(payoutsData('commissions'));
    const html = renderToStaticMarkup(await PayoutsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('href="/cms/affiliates/stripe"');
    expect(html).toContain('Configured (test mode)');
    expect(html).toContain('CA · Store USD · Stripe CAD');
    expect(html).toContain('CA$80.00');
    expect(html).toContain('CA$15.00');
    expect(buttonWithText(html, 'Run payouts now')).not.toMatch(/\sdisabled=""/);
  });

  it('says why "Run payouts now" is off, in visible text with the screen that fixes it', async () => {
    mocks.loadPayouts.mockResolvedValueOnce(payoutsData('commissions'));
    mocks.platformInfo.mockResolvedValueOnce({
      stripeConfigured: false,
      sandbox: false,
      storeBaseCurrency: 'USD',
      available: null,
      transferable: null,
      pending: null,
      error: null,
    });
    let html = renderToStaticMarkup(await PayoutsPage({ searchParams: Promise.resolve({}) }));
    let button = buttonWithText(html, 'Run payouts now');
    expect(button).toMatch(/\sdisabled=""/);
    expect(button).toContain('aria-describedby=');
    expect(button).not.toContain('title=');
    expect(html).toContain('Add your Stripe secret key first. <a href="/cms/payments"');
    expect(html).toContain('Open Payments');

    // A key Stripe rejects is no longer shown as "Configured".
    mocks.loadPayouts.mockResolvedValueOnce(payoutsData('commissions'));
    mocks.platformInfo.mockResolvedValueOnce({
      stripeConfigured: true,
      sandbox: false,
      storeBaseCurrency: 'USD',
      livemode: null,
      transferable: null,
      pending: null,
      error: 'stripe_authentication',
    });
    html = renderToStaticMarkup(await PayoutsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('Key rejected by Stripe');
    expect(html).not.toContain('Configured (');
    button = buttonWithText(html, 'Run payouts now');
    expect(button).toMatch(/\sdisabled=""/);
    expect(html).toContain('Stripe rejected the secret key. <a href="/cms/affiliates/stripe"');
  });
});

describe('payouts screen: commissions paid manually (02036)', () => {
  const MANUAL_SETTINGS = { ...SETTINGS, minPayoutCents: 2500, payoutMethods: { stripeSales: 'stripe_connect', freemiusSales: 'manual' } };
  const PAUSED_ID = 'ffffffff-6666-4666-8666-ffffffffffff';

  function manualQueue() {
    return {
      gateways: ['FREEMIUS'],
      total: 3,
      truncated: false,
      totals: [{ currency: 'USD', amountCents: 62_000, partners: 3, paypalAmountCents: 3_000, paypalPartners: 1 }],
      rows: [
        {
          affiliateId: AFFILIATE_ID,
          handle: 'jane',
          displayName: 'Jane Partner',
          payoutEmail: 'jane@paypal.example',
          partnerStatus: 'ACTIVE',
          payable: true,
          preferredLocale: 'en',
          currency: 'USD',
          amountCents: 3_000,
          commissionCount: 2,
          reachesMinimum: true,
          commissions: [
            { id: 'c-1', orderId: ORDER_ID, gateway: 'FREEMIUS', amountCents: 1_500, createdAt: '2026-10-20T00:00:00.000Z' },
            { id: 'c-2', orderId: null, gateway: 'FREEMIUS', amountCents: 1_500, createdAt: '2026-10-19T00:00:00.000Z' },
          ],
        },
        {
          affiliateId: USER_ID,
          handle: 'max',
          displayName: 'Max',
          payoutEmail: null,
          partnerStatus: 'ACTIVE',
          payable: true,
          preferredLocale: 'fr',
          currency: 'USD',
          amountCents: 900,
          commissionCount: 1,
          reachesMinimum: false,
          commissions: [],
        },
        {
          affiliateId: PAUSED_ID,
          handle: 'paused-pat',
          displayName: 'Pat',
          payoutEmail: 'pat@paypal.example',
          partnerStatus: 'SUSPENDED',
          payable: false,
          preferredLocale: 'en',
          currency: 'USD',
          amountCents: 58_100,
          commissionCount: 4,
          reachesMinimum: true,
          commissions: [],
        },
      ],
    };
  }

  function preparedPayouts() {
    return {
      total: 2,
      truncated: false,
      totals: [{ currency: 'USD', amountCents: 7_500, payouts: 2, paypalAmountCents: 3_000, paypalPayouts: 1 }],
      rows: [
        {
          payoutId: PAYOUT_ID,
          affiliateId: AFFILIATE_ID,
          handle: 'jane',
          displayName: 'Jane Partner',
          payoutEmail: 'jane@paypal.example',
          partnerStatus: 'ACTIVE',
          paypalReady: true,
          preferredLocale: 'en',
          currency: 'USD',
          amountCents: 3_000,
          commissionCount: 2,
          preparedAt: '2026-11-10T12:00:00.000Z',
          refundedCount: 1,
          disputedCount: 0,
          commissions: [
            { id: 'c-1', orderId: ORDER_ID, gateway: 'FREEMIUS', amountCents: 1_500, createdAt: '2026-10-20T00:00:00.000Z', flag: 'refunded' },
            { id: 'c-2', orderId: null, gateway: 'FREEMIUS', amountCents: 1_500, createdAt: '2026-10-19T00:00:00.000Z', flag: null },
          ],
        },
        {
          payoutId: 'eeeeeeee-7777-4777-8777-eeeeeeeeeeee',
          affiliateId: USER_ID,
          handle: 'max',
          displayName: 'Max',
          payoutEmail: null,
          partnerStatus: 'ACTIVE',
          paypalReady: false,
          preferredLocale: 'fr',
          currency: 'USD',
          amountCents: 4_500,
          commissionCount: 1,
          preparedAt: '2026-11-09T12:00:00.000Z',
          refundedCount: 0,
          disputedCount: 0,
          commissions: [],
        },
      ],
    };
  }

  it('lists the prepared payouts to send and record, what is owed to prepare, the PayPal file, and no storefront link', async () => {
    mocks.loadPayouts.mockResolvedValueOnce({ ...payoutsData('commissions'), settings: MANUAL_SETTINGS });
    mocks.loadManualQueue.mockResolvedValueOnce(manualQueue());
    mocks.loadPrepared.mockResolvedValueOnce(preparedPayouts());

    const html = renderToStaticMarkup(
      await PayoutsPage({ searchParams: Promise.resolve({ manualPage: '2', manualPageSize: '10', preparedPage: '1', preparedPageSize: '25' }) })
    );

    expectCleanOutline(html);
    expectLabelledControls(html);
    expect(mocks.loadManualQueue).toHaveBeenCalledWith(expect.anything(), {
      gateways: ['FREEMIUS'],
      paypalGateways: [],
      minPayoutCents: 2500,
      page: 2,
      pageSize: 10,
    });
    expect(mocks.loadPrepared).toHaveBeenCalledWith(expect.anything(), { page: 1, pageSize: 25 });
    expect(html).toContain('<h3 id="affiliate-manual-heading" class="text-base font-semibold text-foreground">Pay manually</h3>');
    expect(html).toContain('Commissions on Freemius sales are paid outside Stripe, in three steps.');
    expect(html).toContain('1. Prepare a payout: it reserves what the partner is owed, so the amount cannot change under you.');
    expect(html).toContain('It does not send any money.');
    // Test-mode sales never show up here (02036 reads live mode only).
    expect(html).toContain('Only live sales appear here: commissions on test orders (a Stripe test key, the Freemius sandbox) are never paid manually.');

    // Step 2 and 3: the prepared payouts, with the PayPal file of those PayPal can pay.
    expect(html).toContain('Prepared payouts: send them, then record them');
    expect(html).toContain('$75.00 in 2 prepared payouts');
    expect(html).toContain('href="/cms/affiliates/payouts/paypal?currency=USD"');
    expect(html).toContain('Download PayPal payouts file (USD, 1 payout, $30.00)');
    expect(html).toContain('aria-label="Record payout of $30.00 to @jane"');
    expect(html).toContain('aria-label="Cancel payout of $30.00 to @jane"');
    expect(html).toContain('aria-label="Record payout of $45.00 to @max"');
    expect(html).toContain('Changed since it was prepared: open Record payout for what to do.');
    expect(html).toContain('recording cannot be undone, while a prepared payout can still be cancelled');
    expect(html).toContain('a PayPal payment nobody claims comes back after 30 days');
    expect(html).toContain('PayPal Business → Pay &amp; Get Paid → Payouts');

    // Step 1: what is owed and not prepared yet.
    expect(html).toContain('Owed, not prepared yet');
    expect(html).toContain('$620.00 owed to 3 partners');
    expect(html).toContain('Prepare PayPal payouts (USD, 1 partner, $30.00)');
    expect(html).toContain('No payout email yet');
    expect(html).toContain('Below $25.00');
    expect(html).toContain('aria-label="Prepare payout of $30.00 to @jane"');
    expect(html).toContain('aria-label="Prepare payout of $9.00 to @max"');
    // A paused partner is listed but cannot be paid (claim_manual_affiliate_payout refuses them).
    expect(html).not.toContain('to @paused-pat"');
    expect(html).toContain('Paused partners are not paid: resume them first.');
    // The platform card says how partners are paid, and the run explains the split.
    expect(html).toContain('Stripe sales: Stripe Connect · Freemius sales: manually');
    expect(html).toContain('the daily run transfers the ones paid through Stripe Connect, and you pay the others manually under Pay manually.');
    for (const match of html.matchAll(/href="([^"]*)"/g)) expect(match[1]).not.toContain('/partners/');
  });

  it('shows no Pay manually section while every commission is paid through Stripe and nothing is prepared', async () => {
    mocks.loadPayouts.mockResolvedValueOnce(payoutsData('commissions'));
    const html = renderToStaticMarkup(await PayoutsPage({ searchParams: Promise.resolve({}) }));
    expect(html).not.toContain('Pay manually</h3>');
    expect(mocks.loadManualQueue).not.toHaveBeenCalled();
    // The prepared payouts are always read: one prepared before a gateway went back to Stripe must stay recordable.
    expect(mocks.loadPrepared).toHaveBeenCalledTimes(1);
  });

  it('keeps a payout prepared before every gateway went back to Stripe recordable, without the owed list', async () => {
    mocks.loadPayouts.mockResolvedValueOnce(payoutsData('commissions'));
    mocks.loadPrepared.mockResolvedValueOnce(preparedPayouts());
    const html = renderToStaticMarkup(await PayoutsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('Pay manually</h3>');
    expect(html).toContain('No commission is paid manually anymore; finish or cancel the payouts already prepared.');
    expect(html).toContain('aria-label="Record payout of $30.00 to @jane"');
    expect(html).not.toContain('Owed, not prepared yet');
    expect(mocks.loadManualQueue).not.toHaveBeenCalled();
  });

  it('keeps "Run payouts now" on without a Stripe key while commissions are paid by hand (the run clears them)', async () => {
    mocks.loadPayouts.mockResolvedValueOnce({ ...payoutsData('commissions'), settings: { ...MANUAL_SETTINGS, payoutMethods: { stripeSales: 'manual', freemiusSales: 'manual' } } });
    mocks.loadManualQueue.mockResolvedValueOnce({ ...manualQueue(), gateways: ['STRIPE', 'FREEMIUS'] });
    mocks.platformInfo.mockResolvedValueOnce({ stripeConfigured: false, sandbox: false, storeBaseCurrency: 'USD', available: null, transferable: null, pending: null, error: null });

    const html = renderToStaticMarkup(await PayoutsPage({ searchParams: Promise.resolve({}) }));

    expect(buttonWithText(html, 'Run payouts now')).not.toMatch(/\sdisabled=""/);
    expect(html).not.toContain('Add your Stripe secret key first.');
    expect(html).toContain('Commissions on Stripe and Freemius sales are paid outside Stripe, in three steps.');
    expect(html).toContain('Manually (every sale)');
    expect(html).toContain('prepare, send and record each payout under Pay manually.');
  });

  it('survives the lists failing to load, and disables every manual control on the sandbox', async () => {
    mocks.loadPayouts.mockResolvedValueOnce({ ...payoutsData('commissions'), settings: MANUAL_SETTINGS });
    mocks.loadManualQueue.mockRejectedValueOnce(Object.assign(new Error('Could not read'), { cause: { code: '42P01', message: 'secret detail' } }));
    mocks.loadPrepared.mockRejectedValueOnce(Object.assign(new Error('Could not read'), { cause: { code: '42P01', message: 'other secret' } }));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let html = renderToStaticMarkup(await PayoutsPage({ searchParams: Promise.resolve({}) }));
    errorLog.mockRestore();
    expect(html).toContain('The commissions paid manually could not be loaded.');
    expect(html).toContain('The prepared manual payouts could not be loaded.');
    expect(html).not.toContain('secret detail');
    expect(html).not.toContain('other secret');

    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    mocks.loadPayouts.mockResolvedValueOnce({ ...payoutsData('commissions'), settings: MANUAL_SETTINGS });
    mocks.loadManualQueue.mockResolvedValueOnce(manualQueue());
    mocks.loadPrepared.mockResolvedValueOnce(preparedPayouts());
    mocks.platformInfo.mockResolvedValueOnce({ stripeConfigured: false, sandbox: true, storeBaseCurrency: 'USD', available: null, transferable: null, pending: null, error: null });
    html = renderToStaticMarkup(await PayoutsPage({ searchParams: Promise.resolve({}) }));
    for (const label of ['Record payout', 'Cancel', 'Prepare payout', 'Prepare PayPal payouts']) {
      expect(buttonWithText(html, label), label).toMatch(/\sdisabled=""/);
    }
    expect(html).toContain('Payouts are disabled in the sandbox.');
  });

  it('shows a recorded manual payout as its channel and reference, a prepared one as waiting, never a Connect account', async () => {
    const data = payoutsData('payouts');
    const base = data.payouts?.rows[0] ?? {};
    const manualRow = {
      ...base,
      id: 'eeeeeeee-7777-4777-8777-eeeeeeeeeeee',
      status: 'COMPLETED',
      failure_reason: null,
      stripe_destination_account: '',
      paid_at: '2026-11-10T00:00:00.000Z',
      trigger: 'admin',
      method: 'manual',
      manual_channel: 'interac',
      external_reference: 'CA1x2y3z',
      note: 'Thanks for October!',
    };
    const preparedRow = {
      ...base,
      id: 'dddddddd-8888-4888-8888-dddddddddddd',
      status: 'PROCESSING',
      failure_reason: null,
      stripe_destination_account: '',
      trigger: 'admin',
      method: 'manual',
      manual_channel: null,
      external_reference: null,
      note: null,
    };
    mocks.loadPayouts.mockResolvedValueOnce({ ...data, payouts: { rows: [manualRow, preparedRow, ...(data.payouts?.rows ?? [])], total: 3 } });

    const html = renderToStaticMarkup(await PayoutsPage({ searchParams: Promise.resolve({ view: 'payouts' }) }));

    expect(html).toContain('Interac e-Transfer · Ref. CA1x2y3z');
    expect(html).toContain('Note to the partner: Thanks for October!');
    expect(html).toContain('Recorded manually');
    expect(html).toContain('Prepared manually');
    expect(html).toContain('Prepared, not recorded yet: send it, then record it (or cancel it if it was never sent) under Pay manually.');
    // A manual payout is never retried or released through Stripe.
    // The Stripe payout keeps its Connect account line, and its Retry / Release.
    expect(html).toContain('To acct_123');
    expect(html.match(/To acct_/g)).toHaveLength(1);
    expect(html.match(/aria-label="Retry the /g)).toHaveLength(1);
  });

  it('says failed payouts are not retried once every commission is paid manually, and how to free their commissions', async () => {
    const manualOnly = { ...MANUAL_SETTINGS, payoutMethods: { stripeSales: 'manual', freemiusSales: 'manual' } };
    mocks.loadPayouts.mockResolvedValueOnce({ ...payoutsData('commissions'), settings: manualOnly });
    mocks.loadManualQueue.mockResolvedValueOnce({ ...manualQueue(), gateways: ['STRIPE', 'FREEMIUS'] });
    let html = renderToStaticMarkup(await PayoutsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain(
      'No commission is paid through Stripe now, so failed payouts are not retried: Release one to move its commissions to Pay manually, or Retry it.'
    );
    expect(html).not.toContain('retried automatically');

    mocks.loadPayouts.mockResolvedValueOnce({ ...payoutsData('commissions'), settings: MANUAL_SETTINGS });
    mocks.loadManualQueue.mockResolvedValueOnce(manualQueue());
    html = renderToStaticMarkup(await PayoutsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('Failures caused by a low Stripe balance are retried automatically; others need Retry or Release.');
    expect(html).toContain('A failed Stripe payout keeps its commissions out of Pay manually: Release it to move the ones now paid manually there.');
  });

  it('offers Retry or Release on a stale Stripe transfer when no daily run checks it (every commission paid manually)', async () => {
    const data = payoutsData('payouts');
    const staleRow = { ...(data.payouts?.rows[0] ?? {}), status: 'PROCESSING', failure_reason: null, last_attempt_at: '2026-10-26T00:00:00.000Z' };
    mocks.loadPayouts.mockResolvedValueOnce({
      ...data,
      settings: { ...MANUAL_SETTINGS, payoutMethods: { stripeSales: 'manual', freemiusSales: 'manual' } },
      payouts: { rows: [staleRow], total: 1 },
    });
    mocks.loadManualQueue.mockResolvedValueOnce({ ...manualQueue(), gateways: ['STRIPE', 'FREEMIUS'] });
    const html = renderToStaticMarkup(await PayoutsPage({ searchParams: Promise.resolve({ view: 'payouts' }) }));
    expect(html).toContain('No commission is paid through Stripe now, so no daily run checks it against Stripe');
    expect(html).toContain('aria-label="Retry the $45.00 payout to @jane"');
    expect(html).toContain('aria-label="Release the $45.00 payout to @jane"');
  });
});

describe('program settings: how partners are paid (02036)', () => {
  /** The opening tag of the select whose `<label>` reads exactly `label`, and its markup up to `</select>`. */
  function selectFor(html: string, label: string): string {
    const labelTag = [...html.matchAll(/<label\b([^>]*)>([^<]*)<\/label>/g)].find(([, , text]) => text === label);
    const id = labelTag ? /\sfor="([^"]+)"/.exec(labelTag[1] ?? '')?.[1] : undefined;
    expect(id, label).toBeDefined();
    const start = html.indexOf(`<select id="${id}"`);
    expect(start, label).toBeGreaterThan(-1);
    return html.slice(start, html.indexOf('</select>', start) + '</select>'.length);
  }

  it('offers both methods for each gateway, says why Freemius is usually manual, and keeps the saved choice', async () => {
    mocks.loadOverview.mockResolvedValueOnce({
      ...overviewData(),
      settings: { ...SETTINGS, payoutMethods: { stripeSales: 'stripe_connect', freemiusSales: 'manual' } },
    });
    const html = renderToStaticMarkup(await OverviewPage({ searchParams: Promise.resolve({}) }));

    expectLabelledControls(html);
    expect(html).toContain('<legend class="text-sm font-medium text-foreground">How partners are paid</legend>');
    const stripe = selectFor(html, 'Commissions on Stripe sales');
    const freemius = selectFor(html, 'Commissions on Freemius sales');
    for (const select of [stripe, freemius]) {
      expect(select).toContain('<option value="stripe_connect"');
      expect(select).toContain('Stripe Connect (automatic transfers)');
      // 02037: automatic PayPal Payouts from the operator's PayPal balance.
      expect(select).toContain('<option value="paypal"');
      expect(select).toContain('PayPal (automatic, from your PayPal balance)');
      expect(select).toContain('Manually (PayPal, Interac e-Transfer, bank transfer)');
    }
    expect(stripe).toMatch(/<option value="stripe_connect" selected="">/);
    expect(freemius).toMatch(/<option value="manual" selected="">/);
    expect(html).toContain(
      'Freemius pays you, not your partners: choose PayPal or Manually for Freemius sales unless you keep enough money in Stripe. Freemius pays you on the 10th of the second month after a sale.'
    );
    expect(html).toContain('set them up under Affiliates → PayPal payouts');
  });

  it('keeps a saved PayPal choice (02037)', async () => {
    mocks.loadOverview.mockResolvedValueOnce({
      ...overviewData(),
      settings: { ...SETTINGS, payoutMethods: { stripeSales: 'stripe_connect', freemiusSales: 'paypal' } },
    });
    const html = renderToStaticMarkup(await OverviewPage({ searchParams: Promise.resolve({}) }));
    expect(selectFor(html, 'Commissions on Freemius sales')).toMatch(/<option value="paypal" selected="">/);
    expect(selectFor(html, 'Commissions on Stripe sales')).toMatch(/<option value="stripe_connect" selected="">/);
  });

  it('defaults both gateways to Stripe Connect for settings saved before 02036', async () => {
    const html = renderToStaticMarkup(await OverviewPage({ searchParams: Promise.resolve({}) }));
    expect(selectFor(html, 'Commissions on Stripe sales')).toMatch(/<option value="stripe_connect" selected="">/);
    expect(selectFor(html, 'Commissions on Freemius sales')).toMatch(/<option value="stripe_connect" selected="">/);
  });

  it('says the daily switch stops Stripe transfers and new PayPal payouts only, and what the minimum does for commissions paid manually', async () => {
    const html = renderToStaticMarkup(await OverviewPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('Send Stripe transfers and PayPal payouts automatically every day');
    expect(html).toContain(
      'The daily run clears commissions past their hold, including those you pay manually, and checks the PayPal payouts already sent, whether this is on or off.'
    );
    expect(html).not.toContain('Run automated payouts every day');
    expect(html).toContain('For commissions paid manually it decides who is ready under Pay manually and whom “Prepare');
    expect(html).not.toContain('decides who is ready under Pay manually and in the PayPal payouts');
    expect(html).not.toContain('balance is transferred once it reaches this amount');
  });

  it('words the overview tiles by how partners are paid: never "every payout is a Stripe transfer"', async () => {
    // A tile's markup, from its label to the next tile's label (the icons sit in between).
    const tileHint = (html: string, label: string) => {
      const start = html.indexOf(label);
      expect(start, label).toBeGreaterThan(-1);
      const next = label === 'Paid out' ? html.indexOf('Onboarding', start) : html.indexOf('Paid out', start);
      return html.slice(start, next > start ? next : start + 3000);
    };
    let html = renderToStaticMarkup(await OverviewPage({ searchParams: Promise.resolve({}) }));
    expect(tileHint(html, 'Cleared, awaiting payout')).toContain('Paid by the next payout run');
    expect(tileHint(html, 'Paid out')).toContain('Lifetime, every completed payout (Stripe transfers and payouts recorded manually)');
    expect(html).not.toContain('Lifetime, by Stripe transfer');

    mocks.loadOverview.mockResolvedValueOnce({ ...overviewData(), settings: { ...SETTINGS, payoutMethods: { stripeSales: 'stripe_connect', freemiusSales: 'manual' } } });
    html = renderToStaticMarkup(await OverviewPage({ searchParams: Promise.resolve({}) }));
    expect(tileHint(html, 'Cleared, awaiting payout')).toContain(
      'Stripe-paid ones go out in the next payout run; pay the others under Payouts → Pay manually'
    );

    mocks.loadOverview.mockResolvedValueOnce({ ...overviewData(), settings: { ...SETTINGS, payoutMethods: { stripeSales: 'manual', freemiusSales: 'manual' } } });
    html = renderToStaticMarkup(await OverviewPage({ searchParams: Promise.resolve({}) }));
    expect(tileHint(html, 'Cleared, awaiting payout')).toContain('Prepare, send and record each payout under Payouts → Pay manually');
    expect(tileHint(html, 'Cleared, awaiting payout')).not.toContain('next payout run');
  });
});
