import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The admin review flow (approve & publish, request changes) and partner moderation run on the
 * service role, where RLS is no boundary: these tests pin what the code itself must guarantee.
 * Approval is refused on a version mismatch or an empty document, publishes only the sanitized
 * draft, never writes a draft column (the 02030 page guard would bump the version and unpublish),
 * and sets `first_published_at` once (COALESCE semantics). Pause and resume tell the partner;
 * "Remove partner" pauses first, re-checks the ledger, and deletes only a partner who never earned
 * (the commission and payout rows cascade from the profile); never on the public sandbox.
 */

const mocks = vi.hoisted(() => ({
  evictStorefront: vi.fn(),
  evictTiers: vi.fn(),
  schedule: vi.fn(),
  ledgerCheck: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('./cache', () => ({
  evictAffiliateStorefrontCache: mocks.evictStorefront,
  evictAffiliateTiersCache: mocks.evictTiers,
}));
vi.mock('./notify', () => ({ scheduleAffiliateLifecycleNotification: mocks.schedule }));
// The ledger guard shared with /cms/users (its own cases run through cms/users/actions.test.ts).
vi.mock('./affiliate-deletion-guard', () => ({ checkAffiliateUserDeletion: mocks.ledgerCheck }));
vi.mock('./image-origins', () => ({
  getStorefrontImageOrigins: () => ['https://media.example.com', 'https://images.unsplash.com'],
}));
// The avatar a new snapshot replaces is deleted through the upload module, which ./avatar-cleanup
// loads only when there is one to delete (the real one pulls in sharp and the storage clients).
const avatarStorage = vi.hoisted(() => ({ deleteObject: vi.fn<(key: string) => Promise<void>>(async () => undefined) }));
vi.mock('./uploads', () => ({ deleteAffiliateUploadObject: avatarStorage.deleteObject }));
// Only the repository is needed from the server entry (no copilot/ai/stripe code in this test).
vi.mock('@nextblock-cms/affiliates/server', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/repository/index.ts')),
}));

import type { AffiliatePublishedProfile } from '@nextblock-cms/affiliates';
import type { AffiliateRepositoryClient } from '@nextblock-cms/affiliates/server';
import {
  AFFILIATE_PAGE_DRAFT_COLUMNS,
  approveAffiliateStorefront,
  buildAffiliatePublishedProfile,
  changeAffiliatePartnerTier,
  cleanAffiliateMultiline,
  cleanAffiliateSingleLine,
  fingerprintAffiliatePublishedProfile,
  normalizeAffiliateConfirmHandle,
  reactivateAffiliatePartner,
  removeAffiliatePartner,
  requestAffiliateStorefrontChanges,
  suspendAffiliatePartner,
  type ApproveAffiliateStorefrontInput,
} from './review';

type Filter = [string, string, unknown];

interface RecordedOp {
  table: string;
  kind: 'select' | 'update' | 'insert' | 'delete';
  values?: Record<string, unknown>;
  filters: Filter[];
}

type Handler = (op: RecordedOp) => { data?: unknown; error?: unknown; count?: number } | undefined;

interface RecordedRpc {
  fn: string;
  args: Record<string, unknown>;
}

type RpcHandler = (call: RecordedRpc) => { data?: unknown; error?: unknown } | undefined;

/** A chainable PostgREST stand-in that records every awaited query and every RPC call. */
function createFakeDb(handler: Handler, rpcHandler: RpcHandler = () => undefined) {
  const ops: RecordedOp[] = [];
  const rpcs: RecordedRpc[] = [];
  const rpc = (fn: string, args: Record<string, unknown>) => {
    const call = { fn, args };
    rpcs.push(call);
    const result = rpcHandler(call) ?? {};
    return Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
  };
  const from = (table: string) => {
    const op: RecordedOp = { table, kind: 'select', filters: [] };
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    Object.assign(builder, {
      select: chain,
      order: chain,
      range: chain,
      limit: chain,
      maybeSingle: chain,
      single: chain,
      update: (values: Record<string, unknown>) => {
        op.kind = 'update';
        op.values = values;
        return builder;
      },
      insert: (values: Record<string, unknown>) => {
        op.kind = 'insert';
        op.values = values;
        return builder;
      },
      delete: () => {
        op.kind = 'delete';
        return builder;
      },
      eq: (column: string, value: unknown) => {
        op.filters.push(['eq', column, value]);
        return builder;
      },
      is: (column: string, value: unknown) => {
        op.filters.push(['is', column, value]);
        return builder;
      },
      in: (column: string, value: unknown) => {
        op.filters.push(['in', column, value]);
        return builder;
      },
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
        ops.push(op);
        const result = handler(op) ?? {};
        return Promise.resolve({ data: result.data ?? null, error: result.error ?? null, count: result.count ?? null }).then(
          resolve,
          reject
        );
      },
    });
    return builder;
  };
  return { db: { from, rpc } as unknown as AffiliateRepositoryClient, ops, rpcs };
}

const PAGE_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const AFFILIATE_ID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const USER_ID = 'cccccccc-3333-4333-8333-cccccccccccc';
const REVIEWER_ID = 'dddddddd-4444-4444-8444-dddddddddddd';
const TIER_ID = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
const OTHER_TIER_ID = 'ffffffff-6666-4666-8666-ffffffffffff';
const PRODUCT_ID = '12345678-1234-4234-8234-123456789abc';

const SAFE_DOC = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'My picks' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Hand-picked favourites.' }] },
  ],
};

function pageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PAGE_ID,
    affiliate_id: AFFILIATE_ID,
    user_id: USER_ID,
    title: 'Jane’s picks',
    meta_description: 'The products Jane actually uses.',
    draft_content: SAFE_DOC,
    featured_product_ids: [PRODUCT_ID],
    published_content: null,
    published_title: null,
    published_meta_description: null,
    published_profile: null,
    published_featured_product_ids: [],
    approval_status: 'PENDING_REVIEW',
    admin_feedback_note: null,
    draft_version: 3,
    draft_updated_at: '2026-10-20T10:00:00.000Z',
    submitted_at: '2026-10-21T10:00:00.000Z',
    submitted_version: 3,
    reviewed_at: null,
    reviewed_by: null,
    published_at: null,
    created_at: '2026-10-01T10:00:00.000Z',
    updated_at: '2026-10-21T10:00:00.000Z',
    ...overrides,
  };
}

function profileRow(overrides: Record<string, unknown> = {}) {
  return {
    id: AFFILIATE_ID,
    user_id: USER_ID,
    tier_id: TIER_ID,
    handle: 'jane',
    display_name: 'Jane Partner',
    bio: 'I review outdoor gear and only recommend what I use myself.',
    avatar_object_key: 'affiliates/avatars/jane.webp',
    social_links: { website: 'https://jane.example', instagram: 'javascript:alert(1)' },
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
    profile_completed_at: '2026-10-02T10:00:00.000Z',
    payout_configured_at: null,
    page_submitted_at: '2026-10-21T10:00:00.000Z',
    first_published_at: null,
    signup_ip_masked: null,
    created_at: '2026-10-01T10:00:00.000Z',
    updated_at: '2026-10-21T10:00:00.000Z',
    ...overrides,
  };
}

function tierRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id === TIER_ID ? 'Starter Partner' : 'Elite Partner',
    name_translations: {},
    slug: id === TIER_ID ? 'starter-partner' : 'elite-partner',
    commission_percentage: 10,
    cookie_duration_days: 30,
    clearance_hold_days: 30,
    is_default_signup_tier: false,
    is_limited_time_promo: false,
    max_ambassadors_cap: null,
    member_count: 3,
    sort_order: 1,
    badge_color: 'violet',
    is_active: true,
    created_at: '2026-10-01T10:00:00.000Z',
    updated_at: '2026-10-01T10:00:00.000Z',
    ...overrides,
  };
}

function filterValue(op: RecordedOp, kind: string, column: string): unknown {
  return op.filters.find(([k, c]) => k === kind && c === column)?.[2];
}

/** The standard world: one pending page, its partner, and updates that hit one row. */
function reviewWorld(options: { page?: Record<string, unknown>; profile?: Record<string, unknown>; pageUpdateRows?: number } = {}) {
  const page = pageRow(options.page);
  const profile = profileRow(options.profile);
  return createFakeDb((op) => {
    if (op.kind === 'select' && op.table === 'affiliate_pages') return { data: page };
    if (op.kind === 'select' && op.table === 'affiliate_profiles') return { data: profile };
    if (op.kind === 'update' && op.table === 'affiliate_pages') {
      return { data: Array.from({ length: options.pageUpdateRows ?? 1 }, () => ({ id: PAGE_ID })) };
    }
    if (op.kind === 'update' && op.table === 'affiliate_profiles') return { data: [{ id: AFFILIATE_ID }] };
    if (op.kind === 'update' && op.table === 'system_alerts') return { data: null };
    return undefined;
  });
}

function pageUpdates(ops: RecordedOp[]) {
  return ops.filter((op) => op.kind === 'update' && op.table === 'affiliate_pages');
}

/** The fingerprint the review screen computes for the standard partner's profile. */
function reviewedFingerprint(profile: Record<string, unknown> = {}): string {
  return fingerprintAffiliatePublishedProfile(buildAffiliatePublishedProfile(profileRow(profile) as never));
}

/** What the Approve button sends for the standard world: the reviewed version and profile. */
function approveInput(overrides: Record<string, unknown> = {}): ApproveAffiliateStorefrontInput {
  return {
    pageIdToApprove: PAGE_ID,
    expectedDraftVersion: 3,
    expectedProfileFingerprint: reviewedFingerprint(),
    reviewerUserId: REVIEWER_ID,
    ...overrides,
  } as ApproveAffiliateStorefrontInput;
}

describe('approveAffiliateStorefront', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('publishes the sanitized draft, snapshots the profile and records the reviewer', async () => {
    const { db, ops } = reviewWorld();

    const result = await approveAffiliateStorefront(
      approveInput(),
      db
    );

    expect(result).toMatchObject({ ok: true, handle: 'jane', firstPublication: true });
    const [update] = pageUpdates(ops);
    expect(update.values).toMatchObject({
      approval_status: 'PUBLISHED',
      published_title: 'Jane’s picks',
      published_meta_description: 'The products Jane actually uses.',
      published_featured_product_ids: [PRODUCT_ID],
      reviewed_by: REVIEWER_ID,
      admin_feedback_note: null,
    });
    expect(update.values?.['published_content']).toEqual(SAFE_DOC);
    // The profile is snapshotted, and its links go through the social allow-list.
    expect(update.values?.['published_profile']).toEqual({
      display_name: 'Jane Partner',
      bio: 'I review outdoor gear and only recommend what I use myself.',
      avatar_object_key: 'affiliates/avatars/jane.webp',
      social_links: { website: 'https://jane.example/' },
      locale: 'en',
    });
    // Optimistic: only while still PENDING_REVIEW at the reviewed version.
    expect(filterValue(update, 'eq', 'approval_status')).toBe('PENDING_REVIEW');
    expect(filterValue(update, 'eq', 'draft_version')).toBe(3);
    expect(mocks.schedule).toHaveBeenCalledWith('PAGE_PUBLISHED', { affiliateId: AFFILIATE_ID, pageId: PAGE_ID });
    expect(mocks.evictStorefront).toHaveBeenCalledWith('jane', 'action');
  });

  it('never writes a draft column', async () => {
    const { db, ops } = reviewWorld();
    await approveAffiliateStorefront(approveInput(), db);

    const [update] = pageUpdates(ops);
    for (const column of AFFILIATE_PAGE_DRAFT_COLUMNS) {
      expect(update.values).not.toHaveProperty(column);
    }
    expect(update.values).not.toHaveProperty('draft_version');
    expect(update.values).not.toHaveProperty('onboarding_step');
  });

  it('refuses a version mismatch without writing anything', async () => {
    const { db, ops } = reviewWorld({ page: { draft_version: 4 } });

    const result = await approveAffiliateStorefront(
      approveInput(),
      db
    );

    expect(result).toMatchObject({ ok: false, code: 'version_mismatch' });
    expect(ops.filter((op) => op.kind !== 'select')).toEqual([]);
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('refuses a page that is not waiting for review', async () => {
    const { db, ops } = reviewWorld({ page: { approval_status: 'DRAFT' } });
    const result = await approveAffiliateStorefront(approveInput(), db);
    expect(result).toMatchObject({ ok: false, code: 'not_pending' });
    expect(pageUpdates(ops)).toEqual([]);
  });

  it('refuses a document that is empty once sanitized', async () => {
    const { db, ops } = reviewWorld({
      page: {
        draft_content: {
          type: 'doc',
          content: [
            { type: 'paragraph' },
            { type: 'scriptTag', content: [{ type: 'text', text: 'alert(1)' }] },
            { type: 'affiliateProductGrid', attrs: { productIds: [], title: null, columns: 3 } },
          ],
        },
      },
    });

    const result = await approveAffiliateStorefront(approveInput(), db);

    expect(result).toMatchObject({ ok: false, code: 'empty_storefront' });
    expect(ops.filter((op) => op.kind === 'update')).toEqual([]);
  });

  it('publishes only what survives the sanitizer', async () => {
    const { db, ops } = reviewWorld({
      page: {
        draft_content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Click me', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] },
              ],
            },
            { type: 'iframe', attrs: { src: 'https://evil.example' } },
            { type: 'image', attrs: { src: 'https://evil.example/pixel.png', alt: 'x' } },
            { type: 'paragraph', attrs: { style: 'color:red', onclick: 'steal()' }, content: [{ type: 'text', text: 'Kept' }] },
          ],
        },
      },
    });

    const result = await approveAffiliateStorefront(approveInput(), db);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.issues.length).toBeGreaterThan(0);
    const published = JSON.stringify(pageUpdates(ops)[0].values?.['published_content']);
    expect(published).not.toMatch(/javascript:|iframe|evil\.example|onclick|style/i);
    expect(published).toContain('Click me');
    expect(published).toContain('Kept');
  });

  it('sets first_published_at only when it is still empty (COALESCE)', async () => {
    const { db, ops } = reviewWorld();
    await approveAffiliateStorefront(approveInput(), db);

    const profileUpdates = ops.filter((op) => op.kind === 'update' && op.table === 'affiliate_profiles');
    expect(profileUpdates).toHaveLength(1);
    expect(Object.keys(profileUpdates[0].values ?? {})).toEqual(['first_published_at']);
    expect(filterValue(profileUpdates[0], 'is', 'first_published_at')).toBeNull();
    expect(filterValue(profileUpdates[0], 'eq', 'id')).toBe(AFFILIATE_ID);
  });

  it('leaves an earlier first_published_at alone on later approvals', async () => {
    const { db, ops } = reviewWorld({ profile: { first_published_at: '2026-09-01T00:00:00.000Z' } });
    const result = await approveAffiliateStorefront(approveInput(), db);

    expect(result).toMatchObject({ ok: true, firstPublication: false });
    expect(ops.filter((op) => op.kind === 'update' && op.table === 'affiliate_profiles')).toEqual([]);
  });

  it('undoes the approval mark when the page changed between the read and the write', async () => {
    const { db, ops } = reviewWorld({ pageUpdateRows: 0 });
    const result = await approveAffiliateStorefront(approveInput(), db);

    expect(result).toMatchObject({ ok: false, code: 'version_mismatch' });
    const profileUpdates = ops.filter((op) => op.kind === 'update' && op.table === 'affiliate_profiles');
    expect(profileUpdates).toHaveLength(2);
    const [mark, undo] = profileUpdates;
    expect(undo.values).toEqual({ first_published_at: null });
    expect(filterValue(undo, 'eq', 'first_published_at')).toBe(mark.values?.['first_published_at']);
    expect(mocks.schedule).not.toHaveBeenCalled();
    expect(mocks.evictStorefront).not.toHaveBeenCalled();
  });

  it('resolves the page’s open submission alerts', async () => {
    const { db, ops } = reviewWorld();
    await approveAffiliateStorefront(approveInput(), db);

    const alertUpdates = ops.filter((op) => op.kind === 'update' && op.table === 'system_alerts');
    expect(alertUpdates.length).toBeGreaterThan(0);
    for (const update of alertUpdates) {
      expect(update.values).toMatchObject({ is_resolved: true });
      expect(filterValue(update, 'eq', 'alert_type')).toBe('affiliate_page_submitted');
      expect(filterValue(update, 'eq', 'is_resolved')).toBe(false);
    }
    expect(alertUpdates.some((update) => filterValue(update, 'eq', 'metadata->>page_id') === PAGE_ID)).toBe(true);
  });

  it('refuses a suspended partner and malformed input', async () => {
    const suspended = reviewWorld({ profile: { status: 'SUSPENDED' } });
    expect(
      await approveAffiliateStorefront(approveInput(), suspended.db)
    ).toMatchObject({ ok: false, code: 'partner_suspended' });

    const { db, ops } = reviewWorld();
    expect(await approveAffiliateStorefront(approveInput({ pageIdToApprove: 'not-a-uuid' }), db)).toMatchObject({
      ok: false,
      code: 'invalid_input',
    });
    expect(await approveAffiliateStorefront(approveInput({ expectedDraftVersion: 0 }), db)).toMatchObject({
      ok: false,
      code: 'invalid_input',
    });
    expect(ops).toEqual([]);
  });

  it('refuses a missing or malformed profile fingerprint before reading anything', async () => {
    const { db, ops } = reviewWorld();
    for (const expectedProfileFingerprint of [undefined, null, '', 'abc', 'A'.repeat(64), `${'a'.repeat(63)}g`, 'a'.repeat(65), 42]) {
      expect(
        await approveAffiliateStorefront(approveInput({ expectedProfileFingerprint }), db),
        String(expectedProfileFingerprint)
      ).toMatchObject({ ok: false, code: 'invalid_input' });
    }
    expect(ops).toEqual([]);
  });

  it.each([
    ['display name', { display_name: 'BUY CHEAP PILLS' }],
    ['bio', { bio: 'Unreviewed claims about miracle cures.' }],
    ['social links', { social_links: { website: 'https://scam.example/phish' } }],
    ['avatar', { avatar_object_key: 'affiliates/avatars/someone-else.webp' }],
  ])('refuses, writing nothing, when the %s changed after the review screen loaded', async (_label, changed) => {
    // A profile edit never moves draft_version (Data API during review, or withdraw, edit or avatar
    // upload, resubmit): the fingerprint the screen sent is what notices it (review A).
    const { db, ops } = reviewWorld({ profile: changed });

    const result = await approveAffiliateStorefront(approveInput(), db);

    expect(result).toMatchObject({ ok: false, code: 'version_mismatch' });
    expect(ops.filter((op) => op.kind !== 'select')).toEqual([]);
    expect(mocks.schedule).not.toHaveBeenCalled();
    expect(mocks.evictStorefront).not.toHaveBeenCalled();
  });

  it('publishes exactly the snapshot whose fingerprint the reviewer sent', async () => {
    const changed = { bio: 'A bio the admin did review.', social_links: { website: 'https://jane.example/new' } };
    const { db, ops } = reviewWorld({ profile: changed });

    const result = await approveAffiliateStorefront(approveInput({ expectedProfileFingerprint: reviewedFingerprint(changed) }), db);

    expect(result).toMatchObject({ ok: true });
    const published = pageUpdates(ops)[0].values?.['published_profile'] as AffiliatePublishedProfile;
    expect(published).toMatchObject({ bio: 'A bio the admin did review.' });
    expect(fingerprintAffiliatePublishedProfile(published)).toBe(reviewedFingerprint(changed));
  });

  it('keeps only uuid featured products, deduplicated', async () => {
    const { db, ops } = reviewWorld({
      page: { featured_product_ids: [PRODUCT_ID.toUpperCase(), PRODUCT_ID, 'not-a-uuid', '{"x":1}'] },
    });
    await approveAffiliateStorefront(approveInput(), db);
    expect(pageUpdates(ops)[0].values?.['published_featured_product_ids']).toEqual([PRODUCT_ID]);
  });
});

describe('approveAffiliateStorefront: the avatar the new snapshot replaces', () => {
  const OLD_AVATAR = `affiliates/avatars/${AFFILIATE_ID}/20260101000000-aaaaaaaa.jpg`;
  const NEW_AVATAR = `affiliates/avatars/${AFFILIATE_ID}/20261020000000-bbbbbbbb.jpg`;
  const snapshot = (avatar: string) => ({ display_name: 'Jane Partner', bio: null, avatar_object_key: avatar, social_links: {} });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes the previous snapshot avatar once the new snapshot is live (the upload route kept it)', async () => {
    const profile = { avatar_object_key: NEW_AVATAR, first_published_at: '2026-10-05T10:00:00.000Z' };
    const { db } = reviewWorld({ page: { published_profile: snapshot(OLD_AVATAR) }, profile });

    const result = await approveAffiliateStorefront(approveInput({ expectedProfileFingerprint: reviewedFingerprint(profile) }), db);

    expect(result).toMatchObject({ ok: true });
    expect(avatarStorage.deleteObject).toHaveBeenCalledTimes(1);
    expect(avatarStorage.deleteObject).toHaveBeenCalledWith(OLD_AVATAR);
  });

  it('deletes nothing when the avatar is unchanged, is not the partner’s own object, or the publish fails', async () => {
    const cases = [
      { published: OLD_AVATAR, avatar: OLD_AVATAR, pageUpdateRows: 1 },
      { published: 'images/seeded-avatar.webp', avatar: NEW_AVATAR, pageUpdateRows: 1 },
      { published: OLD_AVATAR, avatar: NEW_AVATAR, pageUpdateRows: 0 },
    ];
    for (const { published, avatar, pageUpdateRows } of cases) {
      const profile = { avatar_object_key: avatar, first_published_at: '2026-10-05T10:00:00.000Z' };
      const { db } = reviewWorld({ page: { published_profile: snapshot(published) }, profile, pageUpdateRows });
      await approveAffiliateStorefront(approveInput({ expectedProfileFingerprint: reviewedFingerprint(profile) }), db);
    }
    expect(avatarStorage.deleteObject).not.toHaveBeenCalled();
  });
});

describe('buildAffiliatePublishedProfile language', () => {
  it("snapshots the partner's language for the storefront ('fr' stays French, anything else is English)", () => {
    expect(buildAffiliatePublishedProfile(profileRow({ preferred_locale: 'fr' }) as never).locale).toBe('fr');
    expect(buildAffiliatePublishedProfile(profileRow({ preferred_locale: 'en' }) as never).locale).toBe('en');
    expect(buildAffiliatePublishedProfile(profileRow({ preferred_locale: 'de' }) as never).locale).toBe('en');
    expect(buildAffiliatePublishedProfile(profileRow({ preferred_locale: null }) as never).locale).toBe('en');
  });
});

describe('fingerprintAffiliatePublishedProfile', () => {
  const snapshot: AffiliatePublishedProfile = {
    display_name: 'Jane Partner',
    bio: 'Trail runner.',
    avatar_object_key: 'affiliates/avatars/jane.webp',
    social_links: { website: 'https://jane.example/', youtube: 'https://www.youtube.com/@jane' },
  };

  it('is a sha256 hex digest that ignores key order at every level', () => {
    const fingerprint = fingerprintAffiliatePublishedProfile(snapshot);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const reordered = {
      social_links: { youtube: 'https://www.youtube.com/@jane', website: 'https://jane.example/' },
      avatar_object_key: 'affiliates/avatars/jane.webp',
      bio: 'Trail runner.',
      display_name: 'Jane Partner',
    };
    expect(fingerprintAffiliatePublishedProfile(reordered)).toBe(fingerprint);
  });

  it('changes with every field of the snapshot, including fields added later', () => {
    const fingerprint = fingerprintAffiliatePublishedProfile(snapshot);
    for (const change of [
      { display_name: 'Jane P.' },
      { bio: null },
      { bio: 'Trail runner!' },
      { avatar_object_key: null },
      { social_links: { website: 'https://jane.example/' } },
      { locale: 'fr' },
    ]) {
      expect(fingerprintAffiliatePublishedProfile({ ...snapshot, ...change } as AffiliatePublishedProfile), JSON.stringify(change)).not.toBe(
        fingerprint
      );
    }
  });
});

describe('requestAffiliateStorefrontChanges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stores the note and notifies the partner without touching the draft or the live version', async () => {
    const { db, ops } = reviewWorld();

    const result = await requestAffiliateStorefrontChanges(
      { pageIdToReview: PAGE_ID, note: '  Please remove the medical claim in the second section.  ', expectedDraftVersion: 3, reviewerUserId: REVIEWER_ID },
      db
    );

    expect(result).toMatchObject({ ok: true, handle: 'jane' });
    const [update] = pageUpdates(ops);
    expect(update.values).toMatchObject({
      approval_status: 'CHANGES_REQUESTED',
      admin_feedback_note: 'Please remove the medical claim in the second section.',
      reviewed_by: REVIEWER_ID,
    });
    for (const column of [...AFFILIATE_PAGE_DRAFT_COLUMNS, 'published_content', 'published_at', 'published_profile']) {
      expect(update.values).not.toHaveProperty(column);
    }
    expect(filterValue(update, 'eq', 'draft_version')).toBe(3);
    expect(mocks.schedule).toHaveBeenCalledWith('CHANGES_REQUESTED', {
      affiliateId: AFFILIATE_ID,
      pageId: PAGE_ID,
      feedbackNote: 'Please remove the medical claim in the second section.',
    });
  });

  it('requires a note and the reviewed version', async () => {
    const { db, ops } = reviewWorld({ page: { draft_version: 5 } });
    expect(
      await requestAffiliateStorefrontChanges({ pageIdToReview: PAGE_ID, note: '   ', expectedDraftVersion: 5, reviewerUserId: REVIEWER_ID }, db)
    ).toMatchObject({ ok: false, code: 'note_required' });
    expect(
      await requestAffiliateStorefrontChanges({ pageIdToReview: PAGE_ID, note: 'Fix it', expectedDraftVersion: 4, reviewerUserId: REVIEWER_ID }, db)
    ).toMatchObject({ ok: false, code: 'version_mismatch' });
    expect(pageUpdates(ops)).toEqual([]);
  });
});

describe('partner moderation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function moderationWorld(options: { profile?: Record<string, unknown>; tiers?: Record<string, Record<string, unknown>> } = {}) {
    const profile = profileRow(options.profile);
    return createFakeDb((op) => {
      if (op.kind === 'select' && op.table === 'affiliate_profiles') return { data: profile };
      if (op.kind === 'select' && op.table === 'affiliate_tiers') {
        const id = filterValue(op, 'eq', 'id') as string;
        return { data: tierRow(id, options.tiers?.[id] ?? {}) };
      }
      if (op.kind === 'update' && op.table === 'affiliate_profiles') return { data: [{ id: AFFILIATE_ID }] };
      return undefined;
    });
  }

  it('suspends with a cleaned reason and takes the storefront offline', async () => {
    const { db, ops } = moderationWorld();
    const result = await suspendAffiliatePartner({ affiliateIdToUpdate: AFFILIATE_ID, reason: '  Chargebacks\r\non 3 orders  ' }, db);

    expect(result).toMatchObject({ ok: true, handle: 'jane' });
    const update = ops.find((op) => op.kind === 'update');
    expect(update?.values).toEqual({ status: 'SUSPENDED', suspended_reason: 'Chargebacks\non 3 orders' });
    expect(mocks.evictStorefront).toHaveBeenCalledWith('jane', 'action');
  });

  it('reactivates and clears the reason', async () => {
    const { db, ops } = moderationWorld({ profile: { status: 'SUSPENDED', suspended_reason: 'x' } });
    expect(await reactivateAffiliatePartner({ affiliateIdToUpdate: AFFILIATE_ID }, db)).toMatchObject({ ok: true });
    expect(ops.find((op) => op.kind === 'update')?.values).toEqual({ status: 'ACTIVE', suspended_reason: null });
  });

  it('tells the partner about a pause, with the reason, once the write went through', async () => {
    const approved = moderationWorld({ profile: { first_published_at: '2026-10-05T10:00:00.000Z' } });
    // The CMS words its toast by whether the partner was ever approved.
    expect(await suspendAffiliatePartner({ affiliateIdToUpdate: AFFILIATE_ID, reason: '  Chargebacks  ' }, approved.db)).toMatchObject({
      ok: true,
      isApproved: true,
    });
    expect(mocks.schedule).toHaveBeenCalledExactlyOnceWith('PARTNER_SUSPENDED', {
      affiliateId: AFFILIATE_ID,
      suspendedReason: 'Chargebacks',
      storefrontLive: true,
    });

    mocks.schedule.mockClear();
    const neverApproved = moderationWorld();
    expect(await suspendAffiliatePartner({ affiliateIdToUpdate: AFFILIATE_ID }, neverApproved.db)).toMatchObject({
      ok: true,
      isApproved: false,
    });
    expect(mocks.schedule).toHaveBeenCalledExactlyOnceWith('PARTNER_SUSPENDED', {
      affiliateId: AFFILIATE_ID,
      suspendedReason: null,
      storefrontLive: false,
    });
  });

  it('tells the partner about a resume', async () => {
    const { db } = moderationWorld({
      profile: { status: 'SUSPENDED', suspended_reason: 'x', first_published_at: '2026-10-05T10:00:00.000Z' },
    });
    await reactivateAffiliatePartner({ affiliateIdToUpdate: AFFILIATE_ID }, db);
    expect(mocks.schedule).toHaveBeenCalledExactlyOnceWith('PARTNER_REACTIVATED', {
      affiliateId: AFFILIATE_ID,
      suspendedReason: null,
      storefrontLive: true,
    });
  });

  it('sends nothing when the status does not change or the write fails', async () => {
    // A reason edited on a partner who is already paused, and a resume of an active partner.
    const paused = moderationWorld({ profile: { status: 'SUSPENDED', suspended_reason: 'old' } });
    expect(await suspendAffiliatePartner({ affiliateIdToUpdate: AFFILIATE_ID, reason: 'new' }, paused.db)).toMatchObject({ ok: true });
    const active = moderationWorld();
    expect(await reactivateAffiliatePartner({ affiliateIdToUpdate: AFFILIATE_ID }, active.db)).toMatchObject({ ok: true });

    const failing = createFakeDb((op) => {
      if (op.kind === 'select' && op.table === 'affiliate_profiles') return { data: profileRow() };
      if (op.kind === 'update') return { error: { code: '57014', message: 'timeout' } };
      return undefined;
    });
    expect(await suspendAffiliatePartner({ affiliateIdToUpdate: AFFILIATE_ID }, failing.db)).toMatchObject({ ok: false, code: 'failed' });
    expect(mocks.schedule).not.toHaveBeenCalled();
  });
});

describe('changeAffiliatePartnerTier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const ELITE = { name: 'Elite Partner', name_translations: { fr: 'Partenaire Élite' }, commission_percentage: 35 };

  /**
   * The partner (active, in TIER_ID, unless overridden) and the tiers read for the wording; the RPC
   * answers `outcome` ('moved' by default) or `rpc` when given.
   */
  function tierWorld(
    options: { profile?: Record<string, unknown> | null; tier?: Record<string, unknown> | null; rpc?: { data?: unknown; error?: unknown } } = {}
  ) {
    return createFakeDb(
      (op) => {
        if (op.kind === 'select' && op.table === 'affiliate_profiles') {
          return { data: options.profile === null ? null : profileRow(options.profile ?? {}) };
        }
        if (op.kind === 'select' && op.table === 'affiliate_tiers') {
          const id = filterValue(op, 'eq', 'id') as string;
          return { data: options.tier === null ? null : tierRow(id, { ...ELITE, ...(options.tier ?? {}) }) };
        }
        return undefined;
      },
      (call) => (call.fn === 'change_affiliate_partner_tier' ? options.rpc ?? { data: 'moved' } : undefined)
    );
  }

  const move = (extra: Record<string, unknown> = {}) => ({ affiliateIdToUpdate: AFFILIATE_ID, tierIdToAssign: OTHER_TIER_ID, ...extra });

  it('moves the partner through change_affiliate_partner_tier only, then evicts the storefront and tier caches', async () => {
    const { db, ops, rpcs } = tierWorld();
    const result = await changeAffiliatePartnerTier(move(), db);

    expect(result).toEqual({
      ok: true,
      affiliateId: AFFILIATE_ID,
      handle: 'jane',
      partnerName: 'Jane Partner',
      tierName: 'Elite Partner',
      ratePercent: 35,
      unchanged: false,
      notified: false,
    });
    expect(rpcs).toEqual([
      { fn: 'change_affiliate_partner_tier', args: { p_affiliate_id: AFFILIATE_ID, p_tier_id: OTHER_TIER_ID, p_allow_over_cap: false } },
    ]);
    // The RPC writes tier_id under its locks: no direct write, no member_count arithmetic here.
    expect(ops.filter((op) => op.kind !== 'select')).toEqual([]);
    expect(mocks.evictStorefront).toHaveBeenCalledWith('jane', 'action');
    expect(mocks.evictTiers).toHaveBeenCalledWith('action');
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('moves a paused partner like any other (the RPC never checks the status)', async () => {
    const { db, rpcs } = tierWorld({ profile: { status: 'SUSPENDED', suspended_reason: 'Chargebacks', display_name: '  ' } });
    expect(await changeAffiliatePartnerTier(move(), db)).toMatchObject({ ok: true, unchanged: false, partnerName: '@jane' });
    expect(rpcs).toHaveLength(1);
  });

  it('maps every refusal of the RPC to its review code and sentence, and touches no cache', async () => {
    const cases: Array<[string, string]> = [
      ['not_found', 'partner_missing'],
      ['tier_not_found', 'tier_not_found'],
      ['tier_inactive', 'tier_inactive'],
      ['tier_full', 'tier_full'],
    ];
    for (const [outcome, code] of cases) {
      const { db } = tierWorld({ rpc: { data: outcome } });
      const result = await changeAffiliatePartnerTier(move({ notifyPartner: true }), db);
      expect(result, outcome).toMatchObject({ ok: false, code });
    }
    const full = await changeAffiliatePartnerTier(move(), tierWorld({ rpc: { data: 'tier_full' } }).db);
    // Only a stale page sends a full tier without "Assign over the cap": the tier filled up since.
    expect(full.ok ? '' : full.error).toBe(
      'That tier filled up in the meantime. Tick "Assign over the cap" to move this partner anyway, or raise the tier\'s partner cap on the Tiers screen.'
    );
    expect(mocks.evictStorefront).not.toHaveBeenCalled();
    expect(mocks.evictTiers).not.toHaveBeenCalled();
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('answers unchanged without evicting, and failed for an RPC error, a missing function or an unknown answer', async () => {
    expect(await changeAffiliatePartnerTier(move({ notifyPartner: true }), tierWorld({ rpc: { data: 'unchanged' } }).db)).toMatchObject({
      ok: true,
      unchanged: true,
      notified: false,
      tierName: 'Elite Partner',
    });
    for (const rpc of [{ error: { code: '57014', message: 'timeout' } }, { error: { code: 'PGRST202', message: 'no such function' } }, { data: 'moved_later' }, { data: null }]) {
      expect(await changeAffiliatePartnerTier(move(), tierWorld({ rpc }).db), JSON.stringify(rpc)).toMatchObject({ ok: false, code: 'failed' });
    }
    expect(mocks.evictStorefront).not.toHaveBeenCalled();
    expect(mocks.evictTiers).not.toHaveBeenCalled();
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('refuses a missing partner or tier before the RPC, and malformed ids before any read', async () => {
    const noPartner = tierWorld({ profile: null });
    expect(await changeAffiliatePartnerTier(move(), noPartner.db)).toMatchObject({ ok: false, code: 'partner_missing' });
    const noTier = tierWorld({ tier: null });
    expect(await changeAffiliatePartnerTier(move(), noTier.db)).toMatchObject({ ok: false, code: 'tier_not_found' });
    expect([...noPartner.rpcs, ...noTier.rpcs]).toEqual([]);

    const malformed = tierWorld();
    for (const input of [move({ tierIdToAssign: 'nope' }), move({ affiliateIdToUpdate: '' }), null]) {
      expect(await changeAffiliatePartnerTier(input as never, malformed.db)).toMatchObject({ ok: false, code: 'invalid_input' });
    }
    expect(malformed.ops).toEqual([]);
    expect(malformed.rpcs).toEqual([]);
  });

  it('passes p_allow_over_cap only when the admin asked for it (a boolean true)', async () => {
    const asked = tierWorld();
    await changeAffiliatePartnerTier(move({ allowOverCap: true }), asked.db);
    expect(asked.rpcs[0]?.args).toEqual({ p_affiliate_id: AFFILIATE_ID, p_tier_id: OTHER_TIER_ID, p_allow_over_cap: true });

    for (const allowOverCap of [false, undefined, 'true', 1]) {
      const world = tierWorld();
      await changeAffiliatePartnerTier(move({ allowOverCap }), world.db);
      expect(world.rpcs[0]?.args, String(allowOverCap)).toMatchObject({ p_allow_over_cap: false });
    }
  });

  it('emails the partner only after a real move, and only when asked, naming the tier in their language', async () => {
    const french = tierWorld({ profile: { preferred_locale: 'fr' } });
    expect(await changeAffiliatePartnerTier(move({ notifyPartner: true }), french.db)).toMatchObject({ ok: true, notified: true });
    expect(mocks.schedule).toHaveBeenCalledExactlyOnceWith('TIER_CHANGED', {
      affiliateId: AFFILIATE_ID,
      tierName: 'Partenaire Élite',
      tierRatePercent: 35,
    });

    mocks.schedule.mockClear();
    await changeAffiliatePartnerTier(move({ notifyPartner: true }), tierWorld().db);
    expect(mocks.schedule).toHaveBeenCalledExactlyOnceWith('TIER_CHANGED', {
      affiliateId: AFFILIATE_ID,
      tierName: 'Elite Partner',
      tierRatePercent: 35,
    });

    // Not asked, or asked but nothing moved: no email.
    mocks.schedule.mockClear();
    expect(await changeAffiliatePartnerTier(move(), tierWorld().db)).toMatchObject({ ok: true, notified: false });
    expect(await changeAffiliatePartnerTier(move({ notifyPartner: 'yes' }), tierWorld().db)).toMatchObject({ ok: true, notified: false });
    await changeAffiliatePartnerTier(move({ notifyPartner: true }), tierWorld({ rpc: { data: 'unchanged' } }).db);
    await changeAffiliatePartnerTier(move({ notifyPartner: true }), tierWorld({ rpc: { data: 'tier_full' } }).db);
    await changeAffiliatePartnerTier(move({ notifyPartner: true }), tierWorld({ rpc: { error: { code: '40P01' } } }).db);
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('refuses on the public sandbox before reading or writing anything', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const { db, ops, rpcs } = tierWorld();

    expect(await changeAffiliatePartnerTier(move({ allowOverCap: true, notifyPartner: true }), db)).toEqual({
      ok: false,
      code: 'sandbox',
      error: "Partner accounts can't be changed in the sandbox: every visitor shares them.",
    });
    expect(ops).toEqual([]);
    expect(rpcs).toEqual([]);
    expect(mocks.evictStorefront).not.toHaveBeenCalled();
    expect(mocks.schedule).not.toHaveBeenCalled();

    // Only the exact value 'true' is the sandbox.
    for (const value of ['', 'false', 'TRUE', '1']) {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      expect(await changeAffiliatePartnerTier(move(), tierWorld().db), value).toMatchObject({ ok: true, unchanged: false });
    }
  });
});

describe('removeAffiliatePartner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
    mocks.ledgerCheck.mockResolvedValue({ kind: 'allowed', handle: 'jane' });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /**
   * One partner (active unless overridden); every write hits one row unless told otherwise.
   * `override` answers an operation first (to make one of them fail).
   */
  function removalWorld(
    options: { profile?: Record<string, unknown>; role?: string; deletedRows?: number; override?: Handler } = {}
  ) {
    const profile = profileRow(options.profile);
    return createFakeDb((op) => {
      const overridden = options.override?.(op);
      if (overridden) return overridden;
      if (op.kind === 'select' && op.table === 'affiliate_profiles') return { data: profile };
      if (op.kind === 'update' && op.table === 'affiliate_profiles') return { data: [{ id: AFFILIATE_ID }] };
      if (op.kind === 'delete' && op.table === 'affiliate_profiles') {
        return { data: Array.from({ length: options.deletedRows ?? 1 }, () => ({ id: AFFILIATE_ID })) };
      }
      if (op.kind === 'select' && op.table === 'profiles') return { data: { role: options.role ?? 'RTL' } };
      if (op.kind === 'update' && op.table === 'profiles') return { data: [{ id: USER_ID }] };
      if (op.kind === 'update' && op.table === 'system_alerts') return { data: null };
      return undefined;
    });
  }

  const describeOp = (op: RecordedOp) => `${op.kind}:${op.table}`;
  const input = (confirmHandle = 'jane') => ({ affiliateIdToRemove: AFFILIATE_ID, confirmHandle });

  it('pauses first, re-checks the ledger, then deletes the profile, demotes the role and closes the alerts', async () => {
    const { db, ops } = removalWorld();
    let opsAtLedgerCheck: string[] = [];
    mocks.ledgerCheck.mockImplementation(async () => {
      opsAtLedgerCheck = ops.map(describeOp);
      return { kind: 'allowed', handle: 'jane' };
    });

    const result = await removeAffiliatePartner(input(), db);

    expect(result).toEqual({
      ok: true,
      affiliateId: AFFILIATE_ID,
      handle: 'jane',
      displayName: 'Jane Partner',
      removed: true,
      keptBecause: null,
      roleDemoted: true,
    });
    // No commission or payout can appear once the partner is SUSPENDED: the check comes after.
    expect(opsAtLedgerCheck).toEqual(['select:affiliate_profiles', 'update:affiliate_profiles']);
    expect(mocks.ledgerCheck).toHaveBeenCalledExactlyOnceWith(db, USER_ID);
    expect(ops.map(describeOp)).toEqual([
      'select:affiliate_profiles',
      'update:affiliate_profiles',
      'delete:affiliate_profiles',
      'select:profiles',
      'update:profiles',
      'update:system_alerts',
    ]);

    const [, pause, remove, , demote, alerts] = ops;
    expect(pause.values).toEqual({ status: 'SUSPENDED' });
    expect(filterValue(pause, 'eq', 'id')).toBe(AFFILIATE_ID);
    // Conditional delete: only while still paused (a resume in between keeps the partner).
    expect(filterValue(remove, 'eq', 'id')).toBe(AFFILIATE_ID);
    expect(filterValue(remove, 'eq', 'status')).toBe('SUSPENDED');
    // RTL back to USER, guarded on the role read as text.
    expect(demote.values).toEqual({ role: 'USER' });
    expect(filterValue(demote, 'eq', 'id')).toBe(USER_ID);
    expect(filterValue(demote, 'eq', 'role')).toBe('RTL');
    expect(alerts.values).toMatchObject({ is_resolved: true });
    expect(filterValue(alerts, 'eq', 'metadata->>affiliate_id')).toBe(AFFILIATE_ID);
    expect(filterValue(alerts, 'eq', 'is_resolved')).toBe(false);
    // Exactly the partner's lifecycle alerts. Never `affiliate_payout_failed`: the Connect setup
    // alert (metadata.kind 'connect_setup') is such a row, carries the id of the partner who hit
    // the failure, and describes the platform's Stripe setup, which removing that partner does not fix.
    expect(filterValue(alerts, 'in', 'alert_type')).toEqual([
      'affiliate_signed_up',
      'affiliate_profile_completed',
      'affiliate_payout_configured',
      'affiliate_page_submitted',
    ]);
    expect(filterValue(alerts, 'in', 'alert_type')).not.toContain('affiliate_payout_failed');
    expect(filterValue(alerts, 'in', 'alert_type')).not.toContain('affiliate_refund_after_payout');

    expect(mocks.evictStorefront).toHaveBeenCalledWith('jane', 'action');
    expect(mocks.evictTiers).toHaveBeenCalledExactlyOnceWith('action');
    // A removal sends no notice (the profile it would describe is gone).
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it.each([
    ['payouts', { kind: 'blocked', reason: 'payouts' }],
    ['commissions', { kind: 'blocked', reason: 'commissions' }],
    ['unavailable', { kind: 'unavailable' }],
  ] as const)('keeps the partner paused instead when the ledger answers %s', async (keptBecause, check) => {
    mocks.ledgerCheck.mockResolvedValue(check);
    const { db, ops } = removalWorld({ profile: { first_published_at: '2026-10-05T10:00:00.000Z' } });

    const result = await removeAffiliatePartner(input(), db);

    expect(result).toMatchObject({ ok: true, removed: false, keptBecause, handle: 'jane', roleDemoted: false });
    // Paused (and left paused): no delete, no role change, no tier eviction.
    expect(ops.map(describeOp)).toEqual(['select:affiliate_profiles', 'update:affiliate_profiles']);
    expect(ops[1].values).toEqual({ status: 'SUSPENDED' });
    expect(mocks.evictStorefront).toHaveBeenCalledWith('jane', 'action');
    expect(mocks.evictTiers).not.toHaveBeenCalled();
    // This call paused them, so they hear about it like any pause.
    expect(mocks.schedule).toHaveBeenCalledExactlyOnceWith('PARTNER_SUSPENDED', {
      affiliateId: AFFILIATE_ID,
      suspendedReason: null,
      storefrontLive: true,
    });
  });

  it('does not pause again, or notify, a partner who was already paused', async () => {
    mocks.ledgerCheck.mockResolvedValue({ kind: 'blocked', reason: 'payouts' });
    const { db, ops } = removalWorld({ profile: { status: 'SUSPENDED', suspended_reason: 'Spam' } });

    expect(await removeAffiliatePartner(input(), db)).toMatchObject({ ok: true, removed: false, keptBecause: 'payouts' });
    expect(ops.map(describeOp)).toEqual(['select:affiliate_profiles']);
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('refuses a handle that does not match, before any write or ledger read', async () => {
    const { db, ops } = removalWorld();
    for (const confirmHandle of ['janet', 'jan', 'jane-doe', 'j a n e', '@@jane']) {
      expect(await removeAffiliatePartner(input(confirmHandle), db), confirmHandle).toMatchObject({ ok: false, code: 'handle_mismatch' });
    }
    expect(ops.every((op) => op.kind === 'select' && op.table === 'affiliate_profiles')).toBe(true);
    expect(mocks.ledgerCheck).not.toHaveBeenCalled();
    expect(mocks.evictStorefront).not.toHaveBeenCalled();

    // An @, surrounding spaces and capitals are not a mismatch.
    expect(normalizeAffiliateConfirmHandle('  @Jane ')).toBe('jane');
    expect(await removeAffiliatePartner(input(' @Jane '), removalWorld().db)).toMatchObject({ ok: true, removed: true });
  });

  it('refuses malformed input and a missing partner without writing', async () => {
    const { db, ops } = removalWorld();
    expect(await removeAffiliatePartner({ affiliateIdToRemove: 'nope', confirmHandle: 'jane' }, db)).toMatchObject({
      ok: false,
      code: 'invalid_input',
    });
    expect(await removeAffiliatePartner(input('   '), db)).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(ops).toEqual([]);

    const missing = createFakeDb(() => ({ data: null }));
    expect(await removeAffiliatePartner(input(), missing.db)).toMatchObject({ ok: false, code: 'partner_missing' });
    expect(missing.ops.filter((op) => op.kind !== 'select')).toEqual([]);
  });

  it('answers stale, keeping the role, when the partner was resumed or removed in between', async () => {
    const { db, ops } = removalWorld({ deletedRows: 0 });
    expect(await removeAffiliatePartner(input(), db)).toMatchObject({ ok: false, code: 'stale' });
    expect(ops.some((op) => op.table === 'profiles')).toBe(false);
    expect(mocks.evictTiers).not.toHaveBeenCalled();
  });

  it('leaves a role that is not RTL alone', async () => {
    const { db, ops } = removalWorld({ role: 'ADMIN' });
    expect(await removeAffiliatePartner(input(), db)).toMatchObject({ ok: true, removed: true, roleDemoted: true });
    expect(ops.some((op) => op.kind === 'update' && op.table === 'profiles')).toBe(false);
  });

  it('answers remove_failed when the delete errors, leaving the partner paused and the role alone', async () => {
    const { db, ops } = removalWorld({
      override: (op) => (op.kind === 'delete' ? { error: { code: '57014', message: 'canceling statement due to statement timeout' } } : undefined),
    });

    expect(await removeAffiliatePartner(input(), db)).toEqual({
      ok: false,
      code: 'remove_failed',
      error: 'The partner is paused, but their partner account could not be removed. Try again in a moment.',
    });
    // Paused (the storefront went offline), and nothing after the failed delete ran.
    expect(ops.map(describeOp)).toEqual(['select:affiliate_profiles', 'update:affiliate_profiles', 'delete:affiliate_profiles']);
    expect(ops[1].values).toEqual({ status: 'SUSPENDED' });
    expect(mocks.evictStorefront).toHaveBeenCalledExactlyOnceWith('jane', 'action');
    expect(mocks.evictTiers).not.toHaveBeenCalled();
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('answers remove_failed for a throw after the pause, and failed for one before it', async () => {
    mocks.ledgerCheck.mockRejectedValueOnce(new Error('fetch failed'));
    const afterPause = removalWorld();
    expect(await removeAffiliatePartner(input(), afterPause.db)).toMatchObject({ ok: false, code: 'remove_failed' });
    expect(afterPause.ops.map(describeOp)).toEqual(['select:affiliate_profiles', 'update:affiliate_profiles']);
    expect(mocks.evictTiers).not.toHaveBeenCalled();

    // The partner could not even be read: nothing was paused, so nothing claims it was.
    const beforePause = removalWorld({
      override: (op) => (op.kind === 'select' && op.table === 'affiliate_profiles' ? { error: { code: '57014' } } : undefined),
    });
    expect(await removeAffiliatePartner(input(), beforePause.db)).toMatchObject({ ok: false, code: 'failed' });
    expect(beforePause.ops.filter((op) => op.kind !== 'select')).toEqual([]);
  });

  it.each([
    ['the role read fails', (op: RecordedOp) => (op.kind === 'select' && op.table === 'profiles' ? { error: { code: '57014' } } : undefined)],
    ['the role update fails', (op: RecordedOp) => (op.kind === 'update' && op.table === 'profiles' ? { error: { code: '42501' } } : undefined)],
  ])('reports roleDemoted false when %s, once the partner is gone', async (_label, override) => {
    const { db, ops } = removalWorld({ override });

    // The partner account is gone either way: the action tells the admin to fix the role by hand.
    expect(await removeAffiliatePartner(input(), db)).toMatchObject({ ok: true, removed: true, roleDemoted: false });
    expect(ops.map(describeOp)).toContain('delete:affiliate_profiles');
    // The rest of the clean-up still runs.
    expect(ops.map(describeOp)).toContain('update:system_alerts');
    expect(mocks.evictTiers).toHaveBeenCalledExactlyOnceWith('action');
  });

  it('reports roleDemoted false when the role update throws', async () => {
    const { db } = removalWorld({
      override: (op) => {
        if (op.kind === 'update' && op.table === 'profiles') throw new Error('socket hang up');
        return undefined;
      },
    });
    expect(await removeAffiliatePartner(input(), db)).toMatchObject({ ok: true, removed: true, roleDemoted: false });
  });

  it('refuses on the public sandbox before reading or writing anything', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const { db, ops } = removalWorld();

    expect(await removeAffiliatePartner(input(), db)).toEqual({
      ok: false,
      code: 'sandbox',
      error: "Partner accounts can't be changed in the sandbox: every visitor shares them.",
    });
    expect(ops).toEqual([]);
    expect(mocks.ledgerCheck).not.toHaveBeenCalled();
    expect(mocks.evictStorefront).not.toHaveBeenCalled();
    expect(mocks.schedule).not.toHaveBeenCalled();

    // Only the exact value 'true' is the sandbox.
    for (const value of ['', 'false', 'TRUE', '1']) {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      expect(await removeAffiliatePartner(input(), removalWorld().db), value).toMatchObject({ ok: true, removed: true });
    }
  });
});

describe('text cleaning', () => {
  it('collapses one-line text and keeps paragraphs in notes', () => {
    expect(cleanAffiliateSingleLine('  Big\t\tsale\nnow  ', 120)).toBe('Big sale now');
    expect(cleanAffiliateSingleLine('a'.repeat(200), 120)).toHaveLength(120);
    expect(cleanAffiliateMultiline('Line one\r\n\r\n\r\n\r\nLine two\u0007', 2000)).toBe('Line one\n\nLine two');
  });
});
