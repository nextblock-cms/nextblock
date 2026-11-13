import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The storefront moderation reads of /cms/affiliates (admin-data.ts): the approvals screen's
 * Storefronts list (every published storefront, paged past PostgREST's 1000-row cap with
 * `.order().range()` and an exact count), the partner emails of the visible rows (service-role
 * `auth.admin.getUserById`, at most 10 at a time, only addresses the notifier would mail), and the
 * approval queue's judgement of a first publication and of a paused partner's last review.
 */

vi.mock('server-only', () => ({}));
vi.mock('@nextblock-cms/db/server', () => ({ getServiceRoleSupabaseClient: vi.fn(), verifyPackageOnline: vi.fn() }));
vi.mock('../auth/cms-actor', () => ({ getCmsActor: vi.fn(), requireCmsAdmin: vi.fn() }));
vi.mock('./cache', () => ({ evictAffiliateStorefrontCache: vi.fn(), evictAffiliateTiersCache: vi.fn() }));
vi.mock('./notify', () => ({ scheduleAffiliateLifecycleNotification: vi.fn() }));
vi.mock('./image-origins', () => ({ getStorefrontImageOrigins: () => ['https://media.example.com'] }));
// The real email normalizer (the notifier's rule), without the settings read.
vi.mock('./settings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAffiliatesSettings: async () => ({ notificationEmails: [], minPayoutCents: 100, autoPayoutsEnabled: true }),
}));
vi.mock('@nextblock-cms/affiliates/server', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/repository/index.ts')),
}));

import type { AffiliateRepositoryClient } from '@nextblock-cms/affiliates/server';
import {
  AFFILIATE_PARTNER_EMAIL_LOOKUP_CONCURRENCY,
  describeAffiliateStorefrontState,
  loadAffiliateApprovalQueue,
  loadAffiliatePartnerEmails,
  loadAffiliateStorefrontsAdmin,
} from './admin-data';

const PAGE_A = '11111111-1111-4111-8111-111111111111';
const PAGE_B = '22222222-2222-4222-8222-222222222222';
const PARTNER_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const PARTNER_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const USER_A = 'cccccccc-3333-4333-8333-cccccccccccc';
const USER_B = 'dddddddd-4444-4444-8444-dddddddddddd';

type Call = { table: string; calls: Array<[string, unknown[]]> };

/** A chainable client that records every builder call; `from(table)` answers `responses[table]`. */
function recordingDb(responses: Record<string, Array<{ data?: unknown; error?: unknown; count?: number }>>) {
  const queries: Call[] = [];
  const from = (table: string) => {
    const query: Call = { table, calls: [] };
    queries.push(query);
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'is', 'not', 'order', 'range', 'limit', 'maybeSingle', 'single']) {
      builder[method] = (...args: unknown[]) => {
        query.calls.push([method, args]);
        return builder;
      };
    }
    builder['then'] = (resolve: (value: unknown) => unknown) => {
      const queue = responses[table] ?? [];
      const response = queue.length > 1 ? queue.shift() ?? {} : queue[0] ?? {};
      return Promise.resolve({ data: response.data ?? null, error: response.error ?? null, count: response.count ?? null }).then(resolve);
    };
    return builder;
  };
  return { db: { from } as unknown as AffiliateRepositoryClient, queries };
}

describe('describeAffiliateStorefrontState', () => {
  it('is live only for an ACTIVE, approved partner, paused for a SUSPENDED one', () => {
    expect(describeAffiliateStorefrontState({ status: 'ACTIVE', first_published_at: '2026-10-01T00:00:00Z' })).toBe('live');
    expect(describeAffiliateStorefrontState({ status: 'SUSPENDED', first_published_at: '2026-10-01T00:00:00Z' })).toBe('paused');
    expect(describeAffiliateStorefrontState({ status: 'SUSPENDED', first_published_at: null })).toBe('paused');
    expect(describeAffiliateStorefrontState({ status: 'ACTIVE', first_published_at: null })).toBe('unpublished');
    expect(describeAffiliateStorefrontState(null)).toBe('unpublished');
  });
});

describe('loadAffiliateStorefrontsAdmin', () => {
  it('lists published storefronts newest first, one page at a time with an exact count', async () => {
    const { db, queries } = recordingDb({
      affiliate_pages: [
        {
          data: [
            { id: PAGE_A, affiliate_id: PARTNER_A, approval_status: 'PUBLISHED', published_at: '2026-10-20T00:00:00Z' },
            { id: PAGE_B, affiliate_id: PARTNER_B, approval_status: 'DRAFT', published_at: '2026-10-10T00:00:00Z' },
          ],
          count: 1234,
        },
      ],
      affiliate_profiles: [
        {
          data: [
            { id: PARTNER_A, user_id: USER_A, handle: 'jane', display_name: 'Jane', status: 'ACTIVE', suspended_reason: null, first_published_at: '2026-09-01T00:00:00Z' },
            { id: PARTNER_B, user_id: USER_B, handle: 'max', display_name: 'Max', status: 'SUSPENDED', suspended_reason: 'Spam', first_published_at: '2026-09-02T00:00:00Z' },
          ],
        },
      ],
    });

    const result = await loadAffiliateStorefrontsAdmin(db, { page: 3, pageSize: 25 });

    expect(result.total).toBe(1234);
    expect(result.rows).toEqual([
      {
        pageId: PAGE_A,
        affiliateId: PARTNER_A,
        userId: USER_A,
        handle: 'jane',
        displayName: 'Jane',
        partnerStatus: 'ACTIVE',
        suspendedReason: null,
        state: 'live',
        isApproved: true,
        publishedAt: '2026-10-20T00:00:00Z',
        approvalStatus: 'PUBLISHED',
      },
      {
        pageId: PAGE_B,
        affiliateId: PARTNER_B,
        userId: USER_B,
        handle: 'max',
        displayName: 'Max',
        partnerStatus: 'SUSPENDED',
        suspendedReason: 'Spam',
        state: 'paused',
        isApproved: true,
        publishedAt: '2026-10-10T00:00:00Z',
        approvalStatus: 'DRAFT',
      },
    ]);

    const pages = queries.find((query) => query.table === 'affiliate_pages');
    expect(pages?.calls).toEqual([
      ['select', ['id, affiliate_id, approval_status, published_at', { count: 'exact' }]],
      // Published once (an edit after approval keeps the approved version live).
      ['not', ['published_content', 'is', null]],
      ['order', ['published_at', { ascending: false, nullsFirst: false }]],
      ['order', ['id', { ascending: true }]],
      ['range', [50, 74]],
    ]);
    const profiles = queries.find((query) => query.table === 'affiliate_profiles');
    expect(profiles?.calls).toContainEqual(['in', ['id', [PARTNER_A, PARTNER_B]]]);
  });

  it('caps the page size and reads no partner for an empty page', async () => {
    const { db, queries } = recordingDb({ affiliate_pages: [{ data: [], count: 0 }] });
    expect(await loadAffiliateStorefrontsAdmin(db, { page: 1, pageSize: 5000 })).toEqual({ rows: [], total: 0 });
    expect(queries.find((query) => query.table === 'affiliate_pages')?.calls).toContainEqual(['range', [0, 99]]);
    expect(queries.some((query) => query.table === 'affiliate_profiles')).toBe(false);
  });

  it('throws a generic loader error, keeping the code for the logs', async () => {
    const { db } = recordingDb({ affiliate_pages: [{ error: { code: '57014', message: 'canceling statement due to statement timeout' } }] });
    await expect(loadAffiliateStorefrontsAdmin(db, { page: 1, pageSize: 25 })).rejects.toMatchObject({
      name: 'AffiliateAdminDataError',
      code: '57014',
      message: 'Affiliate admin data: list published storefronts failed',
    });
  });

  it('reads a page past the last storefront as an empty page, with the total from a head count', async () => {
    // PostgREST answers an offset past the last row with 416 PGRST103 and no count (a stale
    // ?storefronts= after removals): not a load failure.
    const { db, queries } = recordingDb({
      affiliate_pages: [
        { error: { code: 'PGRST103', message: 'Requested range not satisfiable' } },
        { count: 50 },
      ],
    });

    expect(await loadAffiliateStorefrontsAdmin(db, { page: 9, pageSize: 25 })).toEqual({ rows: [], total: 50 });

    const pageQueries = queries.filter((query) => query.table === 'affiliate_pages');
    expect(pageQueries).toHaveLength(2);
    // The same filter, counted without rows.
    expect(pageQueries[1].calls).toEqual([
      ['select', ['id', { count: 'exact', head: true }]],
      ['not', ['published_content', 'is', null]],
    ]);
    expect(queries.some((query) => query.table === 'affiliate_profiles')).toBe(false);
  });

  it('marks a partner never approved (no first_published_at), which picks the pause wording', async () => {
    const { db } = recordingDb({
      affiliate_pages: [{ data: [{ id: PAGE_A, affiliate_id: PARTNER_A, approval_status: 'PUBLISHED', published_at: null }], count: 1 }],
      affiliate_profiles: [
        { data: [{ id: PARTNER_A, user_id: USER_A, handle: 'jane', display_name: 'Jane', status: 'SUSPENDED', suspended_reason: null, first_published_at: null }] },
      ],
    });
    const { rows } = await loadAffiliateStorefrontsAdmin(db, { page: 1, pageSize: 25 });
    expect(rows[0]).toMatchObject({ state: 'paused', isApproved: false });
  });
});

describe('loadAffiliatePartnerEmails', () => {
  function authDb(lookup: (id: string) => Promise<{ data: { user: { email?: string | null } | null } | null; error: unknown }>) {
    const getUserById = vi.fn(lookup);
    return { db: { auth: { admin: { getUserById } } } as unknown as AffiliateRepositoryClient, getUserById };
  }

  it('keys usable addresses by user id, normalized like the notifier, null for an unusable one, and no key for a failed lookup', async () => {
    const addresses: Record<string, string | null> = {
      [USER_A]: '  Jane@Partner.DEV ',
      [USER_B]: 'demo@example.com',
      [PARTNER_A]: 'not an address',
    };
    const { db, getUserById } = authDb(async (id) =>
      id === PARTNER_B
        ? { data: { user: null }, error: { message: 'Jane@Partner.DEV is not allowed', status: 500, code: 'unexpected_failure' } }
        : { data: { user: { email: addresses[id] } }, error: null }
    );
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const emails = await loadAffiliatePartnerEmails(db, [USER_A, USER_B, PARTNER_A, PARTNER_B, USER_A.toUpperCase(), null, 'nope', undefined]);

    expect(emails).toEqual({
      [USER_A]: 'jane@partner.dev',
      // A reserved placeholder domain can receive nothing.
      [USER_B]: null,
      [PARTNER_A]: null,
    });
    // A failed lookup is not "no address": the screen says the address is unavailable right now.
    expect(PARTNER_B in emails).toBe(false);
    // Deduplicated (case aside), invalid ids dropped before any call.
    expect(getUserById).toHaveBeenCalledTimes(4);
    // One log line per call, by code: never the error's message, an address or a user id.
    expect(logged).toHaveBeenCalledExactlyOnceWith('[affiliates] partner email lookups failed', { failures: 1, code: 'unexpected_failure' });
    logged.mockRestore();
  });

  it('never throws, leaves every failed id out, and answers an empty map for no ids', async () => {
    const { db } = authDb(async () => {
      throw Object.assign(new Error('fetch failed'), { status: 503 });
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await loadAffiliatePartnerEmails(db, [USER_A, USER_B])).toEqual({});
    expect(logged).toHaveBeenCalledExactlyOnceWith('[affiliates] partner email lookups failed', { failures: 2, code: '503' });
    logged.mockClear();
    expect(await loadAffiliatePartnerEmails(db, [])).toEqual({});
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it(`runs at most ${AFFILIATE_PARTNER_EMAIL_LOOKUP_CONCURRENCY} lookups at once`, async () => {
    let inFlight = 0;
    let peak = 0;
    const { db, getUserById } = authDb(async (id) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return { data: { user: { email: `${id.slice(0, 8)}@partner.dev` } }, error: null };
    });
    const ids = Array.from({ length: 35 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);

    const emails = await loadAffiliatePartnerEmails(db, ids);

    expect(getUserById).toHaveBeenCalledTimes(35);
    expect(Object.keys(emails)).toHaveLength(35);
    expect(peak).toBe(AFFILIATE_PARTNER_EMAIL_LOOKUP_CONCURRENCY);
  });
});

describe('loadAffiliateApprovalQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('judges a first publication by the partner’s first approval, and carries the partner for the rows', async () => {
    const { db } = recordingDb({
      affiliate_pages: [
        {
          data: [
            // An approved partner whose page lost its published_at would read "First publication" by the page alone.
            { id: PAGE_A, affiliate_id: PARTNER_A, title: 'Picks', submitted_at: '2026-10-26T00:00:00Z', draft_version: 4, published_at: null },
            { id: PAGE_B, affiliate_id: PARTNER_B, title: 'Mine', submitted_at: '2026-10-27T00:00:00Z', draft_version: 1, published_at: null },
          ],
          count: 2,
        },
        {
          data: [{ id: PAGE_A, affiliate_id: PARTNER_A, approval_status: 'PUBLISHED', reviewed_at: '2026-10-20T00:00:00Z' }],
        },
      ],
      affiliate_profiles: [
        {
          data: [
            { id: PARTNER_A, user_id: USER_A, handle: 'jane', display_name: 'Jane', status: 'SUSPENDED', tier_id: 't', first_published_at: '2026-09-01T00:00:00Z' },
            { id: PARTNER_B, user_id: USER_B, handle: 'max', display_name: 'Max', status: 'ACTIVE', tier_id: 't', first_published_at: null },
          ],
        },
      ],
      affiliate_tiers: [{ data: [] }],
    });

    const result = await loadAffiliateApprovalQueue(db, { page: 1, pageSize: 25 });

    expect(result.items.map((item) => [item.handle, item.userId, item.isFirstPublication])).toEqual([
      ['jane', USER_A, false],
      ['max', USER_B, true],
    ]);
    // The paused partner's last review: the screen reads "Paused", not "Published".
    expect(result.recentlyReviewed).toEqual([
      { pageId: PAGE_A, handle: 'jane', displayName: 'Jane', status: 'PUBLISHED', partnerStatus: 'SUSPENDED', reviewedAt: '2026-10-20T00:00:00Z' },
    ]);
  });

  it('reads a page past the last pending storefront as an empty page with the real total, keeping the recent reviews', async () => {
    // The queue shrinks with every review: a stale ?page= gets 416 PGRST103 (no count) from PostgREST.
    const { db, queries } = recordingDb({
      affiliate_pages: [
        { error: { code: 'PGRST103', message: 'Requested range not satisfiable' } },
        { data: [{ id: PAGE_A, affiliate_id: PARTNER_A, approval_status: 'CHANGES_REQUESTED', reviewed_at: '2026-10-20T00:00:00Z' }] },
        { count: 3 },
      ],
      affiliate_profiles: [
        { data: [{ id: PARTNER_A, user_id: USER_A, handle: 'jane', display_name: 'Jane', status: 'ACTIVE', tier_id: 't', first_published_at: null }] },
      ],
      affiliate_tiers: [{ data: [] }],
    });

    const result = await loadAffiliateApprovalQueue(db, { page: 4, pageSize: 25 });

    expect(result.items).toEqual([]);
    expect(result.total).toBe(3);
    expect(result.recentlyReviewed.map((item) => item.handle)).toEqual(['jane']);
    const count = queries.filter((query) => query.table === 'affiliate_pages')[2];
    expect(count?.calls).toEqual([
      ['select', ['id', { count: 'exact', head: true }]],
      ['eq', ['approval_status', 'PENDING_REVIEW']],
    ]);
  });

  it('still throws on any other queue error', async () => {
    const { db } = recordingDb({
      affiliate_pages: [{ error: { code: '57014' } }, { data: [] }],
      affiliate_tiers: [{ data: [] }],
    });
    await expect(loadAffiliateApprovalQueue(db, { page: 1, pageSize: 25 })).rejects.toMatchObject({
      name: 'AffiliateAdminDataError',
      code: '57014',
    });
  });
});
