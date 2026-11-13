import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The partner portal's server actions. Each one is a public POST endpoint: it must authorize with
 * requireRetailer() before touching any client, scope every write to the caller's own rows, run
 * the storefront sanitizer on the draft, respect the optimistic version and the review lock, keep
 * user input out of LIKE patterns, and never echo a database message.
 */

const mocks = vi.hoisted(() => ({
  requireRetailer: vi.fn(),
  getServiceRoleSupabaseClient: vi.fn(),
  ssgFrom: vi.fn(),
  ssgRows: [] as unknown[],
  ssgError: null as { message: string } | null,
  revalidatePath: vi.fn(),
  notify: vi.fn(),
  evict: vi.fn(),
  startConnect: vi.fn(),
  refreshConnect: vi.fn(),
  dashboardLink: vi.fn(),
  countryOptions: vi.fn(),
}));

vi.mock('next/cache', () => ({
  revalidatePath: mocks.revalidatePath,
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  updateTag: vi.fn(),
  revalidateTag: vi.fn(),
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));

function ssgClient() {
  return {
    from(table: string) {
      const ops: Array<[string, ...unknown[]]> = [];
      mocks.ssgFrom(table, ops);
      const result = () => {
        if (table === 'currencies') return { data: [{ code: 'CAD', symbol: '$', exchange_rate: 1, is_default: true, is_active: true }], error: null };
        if (table === 'languages') return { data: [{ id: 1, code: 'en' }, { id: 2, code: 'fr' }], error: null };
        return mocks.ssgError ? { data: null, error: mocks.ssgError } : { data: mocks.ssgRows, error: null };
      };
      const builder: Record<string, unknown> = {};
      for (const op of ['select', 'eq', 'or', 'ilike', 'in', 'order', 'limit']) {
        builder[op] = (...args: unknown[]) => {
          ops.push([op, ...args]);
          return builder;
        };
      }
      builder['then'] = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(result()).then(resolve, reject);
      return builder;
    },
  };
}

vi.mock('@nextblock-cms/db/server', () => ({
  getSsgSupabaseClient: () => ssgClient(),
  getServiceRoleSupabaseClient: mocks.getServiceRoleSupabaseClient,
}));
vi.mock('@nextblock-cms/ecommerce', () => vi.importActual('../../../../../../libs/ecommerce/src/lib/currency'));
vi.mock('@nextblock-cms/affiliates/server', () => vi.importActual('../../../../../../libs/affiliates/src/lib/repository'));
vi.mock('../../../../lib/storage/provider', () => ({ resolveMediaBaseUrl: () => 'https://media.test' }));
vi.mock('../../../../lib/affiliates/image-origins', () => ({ getStorefrontImageOrigins: () => ['https://media.test'] }));
vi.mock('../../../../lib/affiliates/settings', () => ({ getAffiliatesSettings: vi.fn() }));
vi.mock('../../../../lib/affiliates/notify', () => ({ scheduleAffiliateLifecycleNotification: mocks.notify }));
vi.mock('../../../../lib/affiliates/cache', () => ({ evictAffiliateStorefrontCache: mocks.evict }));
vi.mock('../../../../lib/affiliates/connect-service', () => ({
  startAffiliateConnectOnboarding: mocks.startConnect,
  refreshAffiliateConnectStatus: mocks.refreshConnect,
  createAffiliateExpressDashboardLink: mocks.dashboardLink,
  getAffiliateConnectCountryOptions: mocks.countryOptions,
}));
vi.mock('../../../../lib/affiliates/request-locale', () => ({
  getRequestLocale: async () => 'fr',
  toAffiliatesLocale: (locale: string | null | undefined) => (typeof locale === 'string' && locale.startsWith('fr') ? 'fr' : 'en'),
}));
vi.mock('../../../../lib/affiliates/retailer-actor', () => ({ requireRetailer: mocks.requireRetailer }));

import {
  openStripeExpressDashboard,
  refreshStripeConnectStatus,
  resolveStorefrontProducts,
  saveRetailerPayoutEmail,
  saveRetailerProfile,
  saveStorefrontDraft,
  searchStorefrontProducts,
  startStripeConnectOnboarding,
  submitStorefrontForReview,
  withdrawStorefrontSubmission,
} from './actions';

const USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PROFILE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAGE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const P3 = '33333333-3333-4333-8333-333333333333';

const CONTENT_DOC = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'My favourite picks.' }] }] };

type DbCall = {
  table: string;
  op: 'select' | 'update';
  payload?: Record<string, unknown>;
  filters: Array<[string, string, unknown]>;
};

function createDb(handler: (call: DbCall) => { data: unknown; error: unknown } = () => ({ data: { id: 'row' }, error: null })) {
  const calls: DbCall[] = [];
  const from = vi.fn((table: string) => {
    const call: DbCall = { table, op: 'select', filters: [] };
    const run = () => {
      calls.push(call);
      return Promise.resolve(handler(call));
    };
    const builder: Record<string, unknown> = {
      select: () => builder,
      update: (payload: Record<string, unknown>) => {
        call.op = 'update';
        call.payload = payload;
        return builder;
      },
      eq: (column: string, value: unknown) => {
        call.filters.push(['eq', column, value]);
        return builder;
      },
      is: (column: string, value: unknown) => {
        call.filters.push(['is', column, value]);
        return builder;
      },
      in: (column: string, value: unknown) => {
        call.filters.push(['in', column, value]);
        return builder;
      },
      lt: (column: string, value: unknown) => {
        call.filters.push(['lt', column, value]);
        return builder;
      },
      lte: (column: string, value: unknown) => {
        call.filters.push(['lte', column, value]);
        return builder;
      },
      maybeSingle: () => run(),
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => run().then(resolve, reject),
    };
    return builder;
  });
  return { db: { from }, calls };
}

function actor(page: Record<string, unknown> = {}, profile: Record<string, unknown> = {}) {
  return {
    userId: USER,
    email: 'jane@shop.test',
    role: 'RTL',
    affiliate: {
      id: PROFILE_ID,
      user_id: USER,
      handle: 'jane',
      display_name: 'Jane',
      bio: null,
      status: 'ACTIVE',
      social_links: {},
      avatar_object_key: null,
      profile_completed_at: null,
      page_submitted_at: null,
      first_published_at: null,
      ...profile,
    },
    page: {
      id: PAGE_ID,
      affiliate_id: PROFILE_ID,
      user_id: USER,
      title: 'My picks',
      meta_description: '',
      draft_content: CONTENT_DOC,
      featured_product_ids: [],
      approval_status: 'DRAFT',
      draft_version: 4,
      published_profile: null,
      ...page,
    },
  };
}

function signIn(db: ReturnType<typeof createDb>['db'], who = actor()) {
  mocks.requireRetailer.mockResolvedValue({ supabase: db, actor: who });
}

const draftInput = (overrides: Record<string, unknown> = {}) => ({
  title: 'My picks',
  metaDescription: 'Things I love',
  draft: CONTENT_DOC,
  featuredProductIds: [],
  expectedDraftVersion: 4,
  ...overrides,
});

const updatesTo = (calls: DbCall[], table: string) => calls.filter((call) => call.table === table && call.op === 'update');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ssgRows = [];
  mocks.ssgError = null;
  mocks.countryOptions.mockResolvedValue({ platformCountry: 'CA', countries: [{ code: 'CA', name: 'Canada' }, { code: 'US', name: 'United States' }] });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('authorization comes first', () => {
  const calls: Array<[string, () => Promise<{ ok: boolean; error?: string }>]> = [
    ['saveRetailerProfile', () => saveRetailerProfile({ displayName: 'x', bio: '', socialLinks: {}, preferredLocale: 'en' })],
    ['saveStorefrontDraft', () => saveStorefrontDraft(draftInput())],
    ['submitStorefrontForReview', () => submitStorefrontForReview({ expectedDraftVersion: 4 })],
    ['withdrawStorefrontSubmission', () => withdrawStorefrontSubmission()],
    ['searchStorefrontProducts', () => searchStorefrontProducts({ query: 'x' })],
    ['resolveStorefrontProducts', () => resolveStorefrontProducts({ ids: [P1] })],
    ['startStripeConnectOnboarding', () => startStripeConnectOnboarding({ country: 'CA' })],
    ['refreshStripeConnectStatus', () => refreshStripeConnectStatus()],
    ['openStripeExpressDashboard', () => openStripeExpressDashboard()],
    ['saveRetailerPayoutEmail', () => saveRetailerPayoutEmail({ payoutEmail: 'jane@paypal.example', payoutEmailKind: 'paypal' })],
  ];

  it.each([
    ['Unauthorized', 'unauthorized'],
    ['Forbidden', 'forbidden'],
    ['Suspended', 'suspended'],
    ['PackageInactive', 'package_inactive'],
    ['AffiliateLookupFailed', 'unknown'],
  ])('a %s refusal reaches no client in any action', async (message, error) => {
    mocks.requireRetailer.mockRejectedValue(new Error(message));
    for (const [name, call] of calls) {
      expect(await call(), name).toEqual({ ok: false, error });
    }
    expect(mocks.requireRetailer).toHaveBeenCalledTimes(calls.length);
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
    expect(mocks.ssgFrom).not.toHaveBeenCalled();
    expect(mocks.startConnect).not.toHaveBeenCalled();
    expect(mocks.refreshConnect).not.toHaveBeenCalled();
    expect(mocks.dashboardLink).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('refuses an actor without an affiliate account', async () => {
    const { db } = createDb();
    mocks.requireRetailer.mockResolvedValue({ supabase: db, actor: { ...actor(), affiliate: null } });
    expect(await saveStorefrontDraft(draftInput())).toEqual({ ok: false, error: 'forbidden' });
    expect(db.from).not.toHaveBeenCalled();
  });
});

describe('saveStorefrontDraft', () => {
  it('stores the sanitized document, scoped to the caller’s page and expected version', async () => {
    const { db, calls } = createDb((call) =>
      call.op === 'update' ? { data: { draft_version: 5, approval_status: 'DRAFT' }, error: null } : { data: null, error: null },
    );
    signIn(db);
    const hostile = {
      type: 'doc',
      content: [
        { type: 'scriptTag', content: [{ type: 'text', text: 'alert(1)' }] },
        {
          type: 'paragraph',
          attrs: { style: 'color:red', onclick: 'steal()' },
          content: [{ type: 'text', text: 'Click', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }],
        },
        { type: 'image', attrs: { src: 'https://evil.test/tracker.gif', alt: 'x' } },
      ],
    };

    const result = await saveStorefrontDraft(
      draftInput({ title: '  My\u0007 picks \n today  ', metaDescription: 'x'.repeat(400), draft: hostile }),
    );

    expect(result).toEqual({
      ok: true,
      draftVersion: 5,
      approvalStatus: 'DRAFT',
      featuredProductIds: [],
      title: 'My picks today',
      metaDescription: 'x'.repeat(300),
    });
    const [update] = updatesTo(calls, 'affiliate_pages');
    expect(update?.filters).toEqual([
      ['eq', 'id', PAGE_ID],
      ['eq', 'affiliate_id', PROFILE_ID],
      ['eq', 'user_id', USER],
      ['eq', 'draft_version', 4],
    ]);
    const stored = JSON.stringify(update?.payload?.['draft_content']);
    expect(stored).not.toMatch(/javascript|scriptTag|onclick|style|evil\.test/);
    expect(update?.payload?.['draft_content']).toEqual({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Click' }] }] });
    // Draft columns only: no status, version or publication column from the client.
    expect(Object.keys(update?.payload ?? {}).sort()).toEqual(['draft_content', 'featured_product_ids', 'meta_description', 'title']);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('keeps only active public products among the featured ids, stored ones included', async () => {
    const { db, calls } = createDb(() => ({ data: { draft_version: 5, approval_status: 'DRAFT' }, error: null }));
    // P3 was stored earlier (for example over the Data API) and is not an active public product.
    signIn(db, actor({ featured_product_ids: [P3] }));
    mocks.ssgRows = [{ id: P1 }, { id: P2 }];

    const result = await saveStorefrontDraft(draftInput({ featuredProductIds: [P1, 'not-a-uuid', P2, P3, P2] }));

    expect(result).toMatchObject({ ok: true, featuredProductIds: [P1, P2] });
    expect(updatesTo(calls, 'affiliate_pages')[0]?.payload?.['featured_product_ids']).toEqual([P1, P2]);
    const productQuery = mocks.ssgFrom.mock.calls.find(([table]) => table === 'products');
    expect(productQuery?.[1]).toContainEqual(['in', 'id', [P1, P2, P3]]);
    expect(productQuery?.[1]).toContainEqual(['eq', 'status', 'active']);
  });

  it('leaves the stored featured list untouched when the catalog cannot be read', async () => {
    const { db, calls } = createDb(() => ({ data: { draft_version: 5, approval_status: 'DRAFT' }, error: null }));
    signIn(db, actor({ featured_product_ids: [P1] }));
    mocks.ssgError = { message: 'catalog down' };

    const result = await saveStorefrontDraft(draftInput({ featuredProductIds: [P1, P2] }));

    expect(result).toMatchObject({ ok: true, featuredProductIds: [P1] });
    const [update] = updatesTo(calls, 'affiliate_pages');
    expect(update?.payload).not.toHaveProperty('featured_product_ids');
    expect(update?.payload).toHaveProperty('draft_content');
  });

  it('reports a conflict when another tab saved first (no row at the expected version)', async () => {
    const { db } = createDb((call) =>
      call.op === 'update' ? { data: null, error: null } : { data: { draft_version: 7, approval_status: 'DRAFT' }, error: null },
    );
    signIn(db);
    expect(await saveStorefrontDraft(draftInput())).toEqual({ ok: false, error: 'conflict', currentDraftVersion: 7 });
  });

  it('refuses while the page is in review, before writing', async () => {
    const { db, calls } = createDb();
    signIn(db, actor({ approval_status: 'PENDING_REVIEW' }));
    expect(await saveStorefrontDraft(draftInput())).toEqual({ ok: false, error: 'pending_review' });
    expect(calls).toHaveLength(0);
  });

  it('maps the review lock raised by the database (55000) and hides other database messages', async () => {
    const pending = createDb(() => ({ data: null, error: { code: '55000', message: 'affiliate_page_pending_review' } }));
    signIn(pending.db);
    expect(await saveStorefrontDraft(draftInput())).toEqual({ ok: false, error: 'pending_review' });

    const broken = createDb(() => ({ data: null, error: { code: 'XX000', message: 'internal error in "secret_internal_name"' } }));
    signIn(broken.db);
    const result = await saveStorefrontDraft(draftInput());
    expect(result).toEqual({ ok: false, error: 'unknown' });
    expect(JSON.stringify(result)).not.toContain('secret_internal_name');
  });

  it('answers too_large when a size CHECK refuses the draft (23514), never the constraint name', async () => {
    const tooLarge = createDb(() => ({
      data: null,
      error: { code: '23514', message: 'new row for relation "affiliate_pages" violates check constraint "affiliate_pages_draft_content_check"' },
    }));
    signIn(tooLarge.db);
    const result = await saveStorefrontDraft(draftInput());
    expect(result).toEqual({ ok: false, error: 'too_large' });
    expect(JSON.stringify(result)).not.toContain('affiliate_pages_draft_content_check');
  });

  it('rejects malformed input without writing', async () => {
    const { db, calls } = createDb();
    signIn(db);
    for (const input of [
      null,
      draftInput({ expectedDraftVersion: '4' }),
      draftInput({ featuredProductIds: Array.from({ length: 25 }, () => P1) }),
      draftInput({ title: 'x'.repeat(1001) }),
      { ...draftInput(), approval_status: 'PUBLISHED' },
    ]) {
      expect(await saveStorefrontDraft(input)).toEqual({ ok: false, error: 'invalid_input' });
    }
    expect(calls).toHaveLength(0);
  });
});

describe('submitStorefrontForReview / withdrawStorefrontSubmission', () => {
  it('submits in its own statement, stamps the first submission and tells the admins', async () => {
    const { db, calls } = createDb(() => ({ data: { id: PAGE_ID }, error: null }));
    signIn(db);

    const result = await submitStorefrontForReview({ expectedDraftVersion: 4 });

    expect(result).toMatchObject({ ok: true, approvalStatus: 'PENDING_REVIEW' });
    const [pageUpdate] = updatesTo(calls, 'affiliate_pages');
    expect(Object.keys(pageUpdate?.payload ?? {}).sort()).toEqual(['approval_status', 'submitted_at', 'submitted_version']);
    expect(pageUpdate?.payload).toMatchObject({ approval_status: 'PENDING_REVIEW', submitted_version: 4 });
    expect(pageUpdate?.filters).toContainEqual(['eq', 'draft_version', 4]);
    expect(pageUpdate?.filters).toContainEqual(['in', 'approval_status', ['DRAFT', 'CHANGES_REQUESTED', 'PUBLISHED']]);

    // A first submission lands only while no other one has (two tabs cannot both mail the admins).
    expect(pageUpdate?.filters).toContainEqual(['is', 'submitted_at', null]);

    const [stamp] = updatesTo(calls, 'affiliate_profiles');
    expect(Object.keys(stamp?.payload ?? {})).toEqual(['page_submitted_at']);
    expect(stamp?.filters).toContainEqual(['is', 'page_submitted_at', null]);

    expect(mocks.notify).toHaveBeenCalledWith('PAGE_SUBMITTED', { affiliateId: PROFILE_ID, pageId: PAGE_ID });
    // Nothing public changes on a submission: the storefront reads serve published_* columns only.
    expect(mocks.evict).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/portal/retailer', 'layout');
  });

  describe('resubmission cooldown (review G: a withdraw/submit loop mailed the admins every round)', () => {
    const NOW = new Date('2026-10-29T12:00:00.000Z');
    const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('refuses to resubmit a withdrawn submission within 10 minutes, before any write or notification', async () => {
      const { db, calls } = createDb(() => ({ data: { id: PAGE_ID }, error: null }));
      for (const page of [
        { submitted_at: minutesAgo(2), reviewed_at: null },
        // Reviewed once, then submitted again and withdrawn: the last submission was never decided.
        { submitted_at: minutesAgo(9), reviewed_at: minutesAgo(60) },
      ]) {
        signIn(db, actor(page));
        expect(await submitStorefrontForReview({ expectedDraftVersion: 4 }), JSON.stringify(page)).toEqual({
          ok: false,
          error: 'rate_limited',
        });
      }
      expect(calls).toHaveLength(0);
      expect(mocks.notify).not.toHaveBeenCalled();
    });

    it('resubmits a withdrawn submission after 10 minutes, with the cooldown in the UPDATE itself', async () => {
      const { db, calls } = createDb(() => ({ data: { id: PAGE_ID }, error: null }));
      signIn(db, actor({ submitted_at: minutesAgo(11), reviewed_at: null }));

      expect((await submitStorefrontForReview({ expectedDraftVersion: 4 })).ok).toBe(true);
      const [pageUpdate] = updatesTo(calls, 'affiliate_pages');
      // Concurrent requests that all read the old submission cannot each land one.
      expect(pageUpdate?.filters).toContainEqual(['lt', 'submitted_at', minutesAgo(10)]);
      expect(mocks.notify).toHaveBeenCalledTimes(1);
    });

    it('resubmits at once after an admin decision, guarded against a submission landing first', async () => {
      const { db, calls } = createDb(() => ({ data: { id: PAGE_ID }, error: null }));
      const reviewedAt = minutesAgo(1);
      signIn(db, actor({ approval_status: 'CHANGES_REQUESTED', submitted_at: minutesAgo(3), reviewed_at: reviewedAt }));

      expect((await submitStorefrontForReview({ expectedDraftVersion: 4 })).ok).toBe(true);
      const [pageUpdate] = updatesTo(calls, 'affiliate_pages');
      expect(pageUpdate?.filters).toContainEqual(['lte', 'submitted_at', reviewedAt]);
      expect(mocks.notify).toHaveBeenCalledTimes(1);
    });

    it('answers rate_limited, not conflict, when another request submitted first', async () => {
      // The UPDATE matched nothing, yet the page is out of review at the same version: only the
      // submission guard can have refused it.
      const { db } = createDb((call) =>
        call.op === 'update' ? { data: null, error: null } : { data: { draft_version: 4, approval_status: 'DRAFT' }, error: null },
      );
      signIn(db, actor({ submitted_at: minutesAgo(30), reviewed_at: null }));

      expect(await submitStorefrontForReview({ expectedDraftVersion: 4 })).toEqual({ ok: false, error: 'rate_limited' });
      expect(mocks.notify).not.toHaveBeenCalled();
    });
  });

  it('notifies on every submission but stamps page_submitted_at only once', async () => {
    const { db, calls } = createDb(() => ({ data: { id: PAGE_ID }, error: null }));
    signIn(db, actor({}, { page_submitted_at: '2026-10-01T00:00:00Z' }));
    expect((await submitStorefrontForReview({ expectedDraftVersion: 4 })).ok).toBe(true);
    expect(updatesTo(calls, 'affiliate_profiles')).toHaveLength(0);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });

  it('refuses a stale version, a missing title, an empty page and an unchanged published page', async () => {
    const { db, calls } = createDb();
    signIn(db);
    expect(await submitStorefrontForReview({ expectedDraftVersion: 3 })).toEqual({ ok: false, error: 'conflict', currentDraftVersion: 4 });

    signIn(db, actor({ title: '   ' }));
    expect(await submitStorefrontForReview({ expectedDraftVersion: 4 })).toEqual({ ok: false, error: 'missing_title' });

    signIn(db, actor({ draft_content: { type: 'doc', content: [] } }));
    expect(await submitStorefrontForReview({ expectedDraftVersion: 4 })).toEqual({ ok: false, error: 'empty_storefront' });

    const published = { display_name: 'Jane', bio: null, avatar_object_key: null, social_links: {} };
    signIn(db, actor({ approval_status: 'PUBLISHED', published_profile: published }));
    expect(await submitStorefrontForReview({ expectedDraftVersion: 4 })).toEqual({ ok: false, error: 'nothing_to_submit' });

    signIn(db, actor({ approval_status: 'PENDING_REVIEW' }));
    expect(await submitStorefrontForReview({ expectedDraftVersion: 4 })).toEqual({ ok: false, error: 'pending_review' });

    expect(calls).toHaveLength(0);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('resubmits a published page whose profile changed since the approval', async () => {
    const { db } = createDb(() => ({ data: { id: PAGE_ID }, error: null }));
    const published = { display_name: 'Jane', bio: 'Old bio', avatar_object_key: null, social_links: {} };
    signIn(db, actor({ approval_status: 'PUBLISHED', published_profile: published }, { bio: 'A brand new bio' }));
    expect((await submitStorefrontForReview({ expectedDraftVersion: 4 })).ok).toBe(true);
  });

  it('withdraws a pending submission and closes the admins’ review alert', async () => {
    const { db, calls } = createDb(() => ({ data: { id: PAGE_ID }, error: null }));
    signIn(db, actor({ approval_status: 'PENDING_REVIEW' }));

    expect(await withdrawStorefrontSubmission()).toEqual({ ok: true, approvalStatus: 'DRAFT' });
    const [pageUpdate] = updatesTo(calls, 'affiliate_pages');
    expect(pageUpdate?.payload).toEqual({ approval_status: 'DRAFT' });
    expect(pageUpdate?.filters).toContainEqual(['eq', 'approval_status', 'PENDING_REVIEW']);
    const [alert] = updatesTo(calls, 'system_alerts');
    expect(alert?.filters).toEqual([
      ['eq', 'alert_type', 'affiliate_page_submitted'],
      ['eq', 'is_resolved', false],
      ['eq', 'metadata->>page_id', PAGE_ID],
    ]);
    // The approved version stays live: nothing public to evict.
    expect(mocks.evict).not.toHaveBeenCalled();
  });

  it('has nothing to withdraw when the page is not in review', async () => {
    const { db, calls } = createDb();
    signIn(db);
    expect(await withdrawStorefrontSubmission()).toEqual({ ok: false, error: 'not_pending' });
    expect(calls).toHaveLength(0);
  });
});

describe('saveRetailerProfile', () => {
  const validProfile = (overrides: Record<string, unknown> = {}) => ({
    displayName: ' Jane  Doe ',
    bio: 'I review cosy home goods and only recommend what I use every day.',
    socialLinks: { instagram: 'instagram.com/jane', website: '' },
    preferredLocale: 'fr',
    ...overrides,
  });

  it('saves the normalized profile, completes the step once and notifies the admins', async () => {
    const { db, calls } = createDb((call) =>
      call.payload && 'profile_completed_at' in call.payload
        ? { data: [{ id: PROFILE_ID }], error: null }
        : { data: { id: PROFILE_ID, profile_completed_at: null }, error: null },
    );
    signIn(db);

    const result = await saveRetailerProfile(validProfile());

    expect(result).toEqual({
      ok: true,
      profile: {
        displayName: 'Jane Doe',
        bio: 'I review cosy home goods and only recommend what I use every day.',
        socialLinks: { instagram: 'https://instagram.com/jane' },
        preferredLocale: 'fr',
      },
      profileCompleted: true,
    });
    const [save, stamp] = updatesTo(calls, 'affiliate_profiles');
    expect(Object.keys(save?.payload ?? {}).sort()).toEqual(['bio', 'display_name', 'preferred_locale', 'social_links']);
    expect(save?.filters).toEqual([
      ['eq', 'id', PROFILE_ID],
      ['eq', 'user_id', USER],
    ]);
    expect(stamp?.filters).toContainEqual(['is', 'profile_completed_at', null]);
    expect(mocks.notify).toHaveBeenCalledWith('PROFILE_COMPLETED', { affiliateId: PROFILE_ID });
  });

  it('names the social links it refuses and writes nothing', async () => {
    const { db, calls } = createDb();
    signIn(db);
    const result = await saveRetailerProfile(
      validProfile({ socialLinks: { instagram: 'https://evil.test/jane', website: 'javascript:alert(1)', x: 'https://x.com/jane' } }),
    );
    expect(result).toEqual({ ok: false, error: 'invalid_social_links', fields: ['website', 'instagram'] });
    expect(calls).toHaveLength(0);
  });

  it('refuses while in review, an empty name, unknown keys and unknown networks', async () => {
    const { db, calls } = createDb();
    signIn(db, actor({ approval_status: 'PENDING_REVIEW' }));
    expect(await saveRetailerProfile(validProfile())).toEqual({ ok: false, error: 'pending_review' });

    signIn(db);
    expect(await saveRetailerProfile(validProfile({ displayName: '   ' }))).toEqual({ ok: false, error: 'invalid_input' });
    expect(await saveRetailerProfile({ ...validProfile(), tier_id: 'elite' })).toEqual({ ok: false, error: 'invalid_input' });
    expect(await saveRetailerProfile(validProfile({ socialLinks: { myspace: 'https://myspace.com/j' } }))).toEqual({
      ok: false,
      error: 'invalid_input',
    });
    expect(await saveRetailerProfile(validProfile({ preferredLocale: 'de' }))).toEqual({ ok: false, error: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });
});

describe('product search', () => {
  it('escapes %, _ and \\ before the ILIKE and keeps the query out of .or()', async () => {
    const { db } = createDb();
    signIn(db);
    const result = await searchStorefrontProducts({ query: '100%_cotton\\' });
    expect(result).toEqual({ ok: true, products: [] });

    const [, ops] = mocks.ssgFrom.mock.calls.find(([table]) => table === 'products') ?? [];
    expect(ops).toContainEqual(['ilike', 'title', '%100\\%\\_cotton\\\\%']);
    for (const [op, value] of ops as Array<[string, unknown]>) {
      if (op === 'or') expect(String(value)).not.toContain('cotton');
    }
    expect(db.from).not.toHaveBeenCalled();
  });

  it('formats price labels in the partner’s language and caps the query length', async () => {
    const { db } = createDb();
    signIn(db);
    mocks.ssgRows = [{ id: P1, title: 'Mug', price: 1250, language_id: 2, translation_group_id: 'g' }];
    const result = await searchStorefrontProducts({ query: 'mug' });
    expect(result).toEqual({ ok: true, products: [{ id: P1, title: 'Mug', imageUrl: null, priceLabel: expect.stringContaining('12,50') }] });
    expect(await searchStorefrontProducts({ query: 'x'.repeat(201) })).toEqual({ ok: false, error: 'invalid_input' });
  });

  it('resolves at most 48 ids', async () => {
    const { db } = createDb();
    signIn(db);
    expect(await resolveStorefrontProducts({ ids: Array.from({ length: 49 }, () => P1) })).toEqual({ ok: false, error: 'invalid_input' });
    mocks.ssgRows = [{ id: P1, title: 'Mug', price: 100, language_id: 1, translation_group_id: 'g' }];
    expect(await resolveStorefrontProducts({ ids: [P1, 'x'] })).toMatchObject({ ok: true, products: [{ id: P1 }] });
  });
});

describe('Stripe Connect actions', () => {
  it('starts onboarding for an offered country and returns the Stripe URL', async () => {
    const { db } = createDb();
    signIn(db);
    mocks.startConnect.mockResolvedValue({ ok: true, url: 'https://connect.stripe.com/setup/e/acct_123/x' });
    expect(await startStripeConnectOnboarding({ country: 'ca' })).toEqual({ ok: true, url: 'https://connect.stripe.com/setup/e/acct_123/x' });
    expect(mocks.startConnect).toHaveBeenCalledWith(expect.objectContaining({ userId: USER }), { country: 'CA' });
  });

  it('continues an existing setup without a country (the account already has one)', async () => {
    const { db } = createDb();
    signIn(db, actor({}, { stripe_connect_account_id: 'acct_123' }));
    mocks.startConnect.mockResolvedValue({ ok: true, url: 'https://connect.stripe.com/setup/e/acct_123/y' });
    expect(await startStripeConnectOnboarding({})).toEqual({ ok: true, url: 'https://connect.stripe.com/setup/e/acct_123/y' });
    expect(mocks.startConnect).toHaveBeenCalledWith(expect.objectContaining({ userId: USER }), {});
    expect(mocks.countryOptions).not.toHaveBeenCalled();
    expect(await startStripeConnectOnboarding({ country: 'CAN' })).toEqual({ ok: false, error: 'invalid_input' });
  });

  it('refuses a country the platform does not offer and a non-Stripe URL', async () => {
    const { db } = createDb();
    signIn(db);
    expect(await startStripeConnectOnboarding({ country: 'ZZ' })).toEqual({ ok: false, error: 'invalid_input' });
    expect(mocks.startConnect).not.toHaveBeenCalled();
    mocks.startConnect.mockResolvedValue({ ok: true, url: 'https://evil.test/phish' });
    expect(await startStripeConnectOnboarding({ country: 'US' })).toEqual({ ok: false, error: 'connect_unavailable' });
  });

  it('maps the connect service codes, and reads readiness from Stripe only', async () => {
    const { db } = createDb();
    signIn(db);
    mocks.refreshConnect.mockResolvedValue({ ok: true, status: { ready: true } });
    expect(await refreshStripeConnectStatus()).toEqual({ ok: true, ready: true });
    mocks.refreshConnect.mockResolvedValue({ ok: false, error: 'stripe_not_configured' });
    expect(await refreshStripeConnectStatus()).toEqual({ ok: false, error: 'payouts_not_configured' });
    mocks.refreshConnect.mockResolvedValue({ ok: false, error: 'unknown' });
    expect(await refreshStripeConnectStatus()).toEqual({ ok: false, error: 'connect_unavailable' });
    mocks.dashboardLink.mockResolvedValue({ ok: false, error: 'suspended' });
    signIn(db, actor({}, { stripe_connect_account_id: 'acct_123' }));
    expect(await openStripeExpressDashboard()).toEqual({ ok: false, error: 'suspended' });
  });

  it('tells a store without Stripe apart from a Stripe outage when the partner clicks Connect', async () => {
    const { db } = createDb();
    signIn(db);
    mocks.startConnect.mockResolvedValue({ ok: false, error: 'stripe_not_configured' });
    expect(await startStripeConnectOnboarding({ country: 'CA' })).toEqual({ ok: false, error: 'payouts_not_configured' });
    mocks.startConnect.mockResolvedValue({ ok: false, error: 'connect_unavailable' });
    expect(await startStripeConnectOnboarding({ country: 'CA' })).toEqual({ ok: false, error: 'connect_unavailable' });
  });

  /** A partner with a connected account and a Connect service that would answer, so only the sandbox refusal is left. */
  function connectedPartnerWithWorkingConnect() {
    const { db } = createDb();
    signIn(db, actor({}, { stripe_connect_account_id: 'acct_123' }));
    mocks.startConnect.mockResolvedValue({ ok: true, url: 'https://connect.stripe.com/setup/e/acct_123/x' });
    mocks.refreshConnect.mockResolvedValue({ ok: true, status: { ready: true } });
    mocks.dashboardLink.mockResolvedValue({ ok: true, url: 'https://connect.stripe.com/express/acct_123/login' });
  }

  it('is off in the sandbox', async () => {
    connectedPartnerWithWorkingConnect();
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    try {
      expect(await startStripeConnectOnboarding({ country: 'CA' })).toEqual({ ok: false, error: 'sandbox' });
      expect(await refreshStripeConnectStatus()).toEqual({ ok: false, error: 'sandbox' });
      expect(await openStripeExpressDashboard()).toEqual({ ok: false, error: 'sandbox' });
      expect(mocks.startConnect).not.toHaveBeenCalled();
      expect(mocks.refreshConnect).not.toHaveBeenCalled();
      expect(mocks.dashboardLink).not.toHaveBeenCalled();
      expect(mocks.countryOptions).not.toHaveBeenCalled();
      expect(mocks.revalidatePath).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('runs off the sandbox (only the exact value "true" is the sandbox)', async () => {
    connectedPartnerWithWorkingConnect();
    try {
      for (const value of ['', 'false', 'TRUE', '1']) {
        vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
        expect(await startStripeConnectOnboarding({ country: 'CA' }), value).toEqual({
          ok: true,
          url: 'https://connect.stripe.com/setup/e/acct_123/x',
        });
        expect(await refreshStripeConnectStatus(), value).toEqual({ ok: true, ready: true });
        expect(await openStripeExpressDashboard(), value).toEqual({
          ok: true,
          url: 'https://connect.stripe.com/express/acct_123/login',
        });
      }
      expect(mocks.startConnect).toHaveBeenCalledTimes(4);
      expect(mocks.refreshConnect).toHaveBeenCalledTimes(4);
      expect(mocks.dashboardLink).toHaveBeenCalledTimes(4);
      expect(mocks.dashboardLink).toHaveBeenCalledWith(expect.objectContaining({ userId: USER }));
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('saveRetailerPayoutEmail (manual payouts 02036, PayPal or Interac e-Transfer 02037)', () => {
  const saved = (calls: DbCall[]) => updatesTo(calls, 'affiliate_profiles');

  it('stores the trimmed, lowercased address and what it is for on the caller’s own row only, and nothing else', async () => {
    const { db, calls } = createDb(() => ({ data: { id: PROFILE_ID }, error: null }));
    signIn(db);

    expect(await saveRetailerPayoutEmail({ payoutEmail: '  Jane.Doe+PayPal@Example.COM ', payoutEmailKind: 'paypal' })).toEqual({
      ok: true,
      payoutEmail: 'jane.doe+paypal@example.com',
      payoutEmailKind: 'paypal',
    });
    const [update] = saved(calls);
    // every save is stamped (02037: a save after PayPal returned a payout from the address lifts the block)
    expect(update?.payload).toEqual({ payout_email: 'jane.doe+paypal@example.com', payout_email_kind: 'paypal', payout_email_saved_at: expect.any(String) });
    expect(Number.isFinite(Date.parse(String((update?.payload as Record<string, unknown>)['payout_email_saved_at'])))).toBe(true);
    expect(update?.filters).toEqual([
      ['eq', 'id', PROFILE_ID],
      ['eq', 'user_id', USER],
    ]);
    expect(calls).toHaveLength(1);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/portal/retailer', 'layout');
    // It mails nobody and tells no admin.
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('stores an Interac e-Transfer address as such (the store pays it by hand: PayPal cannot send an e-Transfer)', async () => {
    const { db, calls } = createDb(() => ({ data: { id: PROFILE_ID }, error: null }));
    signIn(db, actor({}, { payout_email: 'jane@paypal.example', payout_email_kind: 'paypal' }));

    expect(await saveRetailerPayoutEmail({ payoutEmail: 'Jane@Bank.example', payoutEmailKind: 'interac' })).toEqual({
      ok: true,
      payoutEmail: 'jane@bank.example',
      payoutEmailKind: 'interac',
    });
    expect(saved(calls).map((call) => call.payload)).toEqual([
      { payout_email: 'jane@bank.example', payout_email_kind: 'interac', payout_email_saved_at: expect.any(String) },
    ]);
    expect(saved(calls)[0]?.filters).toEqual([
      ['eq', 'id', PROFILE_ID],
      ['eq', 'user_id', USER],
    ]);
  });

  it('clears the address with an empty or blank value', async () => {
    const { db, calls } = createDb(() => ({ data: { id: PROFILE_ID }, error: null }));
    signIn(db, actor({}, { payout_email: 'jane@paypal.example' }));
    for (const payoutEmail of ['', '   ']) {
      expect(await saveRetailerPayoutEmail({ payoutEmail, payoutEmailKind: 'paypal' })).toEqual({
        ok: true,
        payoutEmail: null,
        payoutEmailKind: 'paypal',
      });
    }
    expect(saved(calls).map((call) => call.payload)).toEqual([
      { payout_email: null, payout_email_kind: 'paypal', payout_email_saved_at: expect.any(String) },
      { payout_email: null, payout_email_kind: 'paypal', payout_email_saved_at: expect.any(String) },
    ]);
  });

  it('stamps a save of the same PayPal email again ("I checked it: try PayPal again"), on the caller’s own row only', async () => {
    const { db, calls } = createDb(() => ({ data: { id: PROFILE_ID }, error: null }));
    signIn(db, actor({}, { payout_email: 'jane@paypal.example', payout_email_kind: 'paypal', payout_email_saved_at: '2026-11-01T00:00:00.000Z' }));
    expect(await saveRetailerPayoutEmail({ payoutEmail: 'jane@paypal.example', payoutEmailKind: 'paypal' })).toEqual({
      ok: true,
      payoutEmail: 'jane@paypal.example',
      payoutEmailKind: 'paypal',
    });
    const [update] = saved(calls);
    const stamped = Date.parse(String((update?.payload as Record<string, unknown>)['payout_email_saved_at']));
    expect(stamped).toBeGreaterThan(Date.parse('2026-11-01T00:00:00.000Z'));
    expect(update?.filters).toEqual([
      ['eq', 'id', PROFILE_ID],
      ['eq', 'user_id', USER],
    ]);
  });

  it('refuses anything but one deliverable-looking address of at most 254 characters, before any write', async () => {
    const { db, calls } = createDb();
    signIn(db);
    const refused = [
      'not-an-email',
      'jane@localhost',
      'jane@example.com, bob@example.com',
      'jane @example.com',
      '<jane@example.com>',
      '"jane"@example.com',
      'jane@example.com\nBcc: mallory@example.com',
      '=HYPERLINK("https://evil.example")@example.com',
      'a..b@example.com',
      `${'a'.repeat(245)}@example.com`,
    ];
    for (const payoutEmailKind of ['paypal', 'interac'] as const) {
      for (const payoutEmail of refused) {
        expect(await saveRetailerPayoutEmail({ payoutEmail, payoutEmailKind }), `${payoutEmailKind}: ${payoutEmail}`).toEqual({
          ok: false,
          error: 'invalid_payout_email',
        });
      }
    }
    expect(calls).toHaveLength(0);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('refuses a PayPal address PayPal cannot take as is (over 127 characters: the run would skip it), not an Interac one', async () => {
    const { db, calls } = createDb(() => ({ data: { id: PROFILE_ID }, error: null }));
    signIn(db);
    const long = `${'a'.repeat(120)}@example.com`;
    expect(long.length).toBeGreaterThan(127);
    expect(await saveRetailerPayoutEmail({ payoutEmail: long, payoutEmailKind: 'paypal' })).toEqual({ ok: false, error: 'invalid_payout_email' });
    expect(calls).toHaveLength(0);

    expect(await saveRetailerPayoutEmail({ payoutEmail: long, payoutEmailKind: 'interac' })).toEqual({
      ok: true,
      payoutEmail: long,
      payoutEmailKind: 'interac',
    });
    const exact = `${'b'.repeat(115)}@example.com`;
    expect(exact.length).toBe(127);
    expect(await saveRetailerPayoutEmail({ payoutEmail: exact, payoutEmailKind: 'paypal' })).toEqual({
      ok: true,
      payoutEmail: exact,
      payoutEmailKind: 'paypal',
    });
  });

  it('takes exactly the two fields (strict): no other key, no other type, no other kind, nothing oversized', async () => {
    const { db, calls } = createDb();
    signIn(db);
    const malformed: unknown[] = [
      undefined,
      null,
      'jane@paypal.example',
      {},
      { payoutEmail: 42, payoutEmailKind: 'paypal' },
      { payoutEmail: null, payoutEmailKind: 'paypal' },
      // 02037: what the address is for is required, and only PayPal or Interac e-Transfer.
      { payoutEmail: 'jane@paypal.example' },
      { payoutEmail: 'jane@paypal.example', payoutEmailKind: 'venmo' },
      { payoutEmail: 'jane@paypal.example', payoutEmailKind: 'PAYPAL' },
      { payoutEmail: 'jane@paypal.example', payoutEmailKind: null },
      { payoutEmail: 'jane@paypal.example', payoutEmailKind: 'paypal', affiliateIdToUpdate: PROFILE_ID },
      { payoutEmail: 'jane@paypal.example', payoutEmailKind: 'paypal', user_id: USER },
      { payoutEmail: 'jane@paypal.example', payoutEmailKind: 'paypal', payout_email_kind: 'interac' },
      { payoutEmail: `${'a'.repeat(1100)}@example.com`, payoutEmailKind: 'interac' },
    ];
    for (const input of malformed) {
      expect(await saveRetailerPayoutEmail(input), JSON.stringify(input)).toEqual({ ok: false, error: 'invalid_input' });
    }
    expect(calls).toHaveLength(0);
  });

  it('hides the database message, and answers not_found when the row is gone', async () => {
    const error = vi.mocked(console.error);
    const failing = createDb(() => ({ data: null, error: { message: 'violates check constraint "affiliate_profiles_payout_email_kind_check"' } }));
    signIn(failing.db);
    expect(await saveRetailerPayoutEmail({ payoutEmail: 'jane@paypal.example', payoutEmailKind: 'paypal' })).toEqual({ ok: false, error: 'unknown' });
    expect(error).toHaveBeenCalledWith('[affiliates] Portal payout email save failed:', expect.stringContaining('check constraint'));

    const missing = createDb(() => ({ data: null, error: null }));
    signIn(missing.db);
    expect(await saveRetailerPayoutEmail({ payoutEmail: 'jane@paypal.example', payoutEmailKind: 'interac' })).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('is refused on the public sandbox right after the partner check (the demo partner is shared)', async () => {
    const { db, calls } = createDb(() => ({ data: { id: PROFILE_ID }, error: null }));
    signIn(db);
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    try {
      for (const input of [
        { payoutEmail: 'jane@paypal.example', payoutEmailKind: 'paypal' },
        { payoutEmail: 'jane@bank.example', payoutEmailKind: 'interac' },
        { payoutEmail: '', payoutEmailKind: 'paypal' },
        // refused before the input is even read
        { payoutEmail: 42 },
      ]) {
        expect(await saveRetailerPayoutEmail(input), JSON.stringify(input)).toEqual({ ok: false, error: 'sandbox' });
      }
      expect(mocks.requireRetailer).toHaveBeenCalledTimes(4);
      expect(calls).toHaveLength(0);
      expect(db.from).not.toHaveBeenCalled();
      expect(mocks.revalidatePath).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }

    // Only the exact value "true" is the sandbox.
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'TRUE');
    try {
      expect(await saveRetailerPayoutEmail({ payoutEmail: 'jane@paypal.example', payoutEmailKind: 'paypal' })).toEqual({
        ok: true,
        payoutEmail: 'jane@paypal.example',
        payoutEmailKind: 'paypal',
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
