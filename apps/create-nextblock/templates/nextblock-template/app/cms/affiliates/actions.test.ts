import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every export of app/cms/affiliates/actions.ts is a public POST endpoint. Each must call
 * `requireCmsAdmin()` before it validates, reads or writes anything: a refused caller never
 * reaches the review / payout / settings code or a database client. The admin paths take the
 * reviewer from the session (never from the input), refuse unknown input keys, and answer with
 * readable data instead of throwing.
 */

const mocks = vi.hoisted(() => ({
  requireCmsAdmin: vi.fn(),
  serviceClient: vi.fn(),
  from: vi.fn(),
  approve: vi.fn(),
  requestChanges: vi.fn(),
  suspend: vi.fn(),
  reactivate: vi.fn(),
  remove: vi.fn(),
  changeTier: vi.fn(),
  runCycle: vi.fn(),
  retry: vi.fn(),
  release: vi.fn(),
  saveSettings: vi.fn(),
  stripeSetup: vi.fn(),
  recordManual: vi.fn(),
  prepareManual: vi.fn(),
  preparePayPal: vi.fn(),
  cancelManual: vi.fn(),
  evictStorefront: vi.fn(),
  evictTiers: vi.fn(),
  evictProgramSettings: vi.fn(),
  revalidatePath: vi.fn(),
  dbResponses: {} as Record<string, { data?: unknown; error?: unknown }>,
  writes: [] as Array<{ table: string; kind: string; values?: unknown; filters: Array<[string, string, unknown]> }>,
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@nextblock-cms/db/server', () => ({
  getServiceRoleSupabaseClient: mocks.serviceClient,
  createClient: mocks.serviceClient,
}));
vi.mock('../../../lib/auth/cms-actor', () => ({ requireCmsAdmin: mocks.requireCmsAdmin }));
vi.mock('../../../lib/affiliates/review', () => ({
  approveAffiliateStorefront: mocks.approve,
  requestAffiliateStorefrontChanges: mocks.requestChanges,
  suspendAffiliatePartner: mocks.suspend,
  reactivateAffiliatePartner: mocks.reactivate,
  removeAffiliatePartner: mocks.remove,
  changeAffiliatePartnerTier: mocks.changeTier,
}));
vi.mock('../../../lib/affiliates/payout-runner', () => ({
  runAffiliatePayoutCycleNow: mocks.runCycle,
  retryAffiliatePayoutNow: mocks.retry,
  releaseAffiliatePayoutNow: mocks.release,
  getAffiliatePayoutPlatformInfo: vi.fn(),
  maybeRunAffiliatePayouts: vi.fn(),
}));
vi.mock('../../../lib/affiliates/payout-setup', () => ({ testAffiliateStripeSetupNow: mocks.stripeSetup }));
vi.mock('../../../lib/affiliates/manual-payouts', () => ({
  recordManualAffiliatePayoutNow: mocks.recordManual,
  prepareManualAffiliatePayoutNow: mocks.prepareManual,
  prepareManualAffiliatePayPalPayoutsNow: mocks.preparePayPal,
  cancelManualAffiliatePayoutNow: mocks.cancelManual,
}));
vi.mock('../../../lib/affiliates/settings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  saveAffiliatesSettings: mocks.saveSettings,
}));
vi.mock('../../../lib/affiliates/cache', () => ({
  evictAffiliateStorefrontCache: mocks.evictStorefront,
  evictAffiliateTiersCache: mocks.evictTiers,
  evictAffiliateProgramSettingsCache: mocks.evictProgramSettings,
}));
vi.mock('../../../lib/affiliates/admin-data', () => ({
  toAffiliateAdminClient: (client: unknown) => client,
  AFFILIATE_ADMIN_ALERT_TYPES: [
    'affiliate_signed_up',
    'affiliate_profile_completed',
    'affiliate_payout_configured',
    'affiliate_page_submitted',
    'affiliate_payout_failed',
    'affiliate_refund_after_payout',
  ],
}));
vi.mock('@nextblock-cms/affiliates/server', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../../../libs/affiliates/src/lib/repository/index.ts')),
}));

import * as actions from './actions';

const ADMIN_ID = '0b0b0b0b-1111-4111-8111-0b0b0b0b0b0b';
const PAGE_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const AFFILIATE_ID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const TIER_ID = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
const PAYOUT_ID = 'cccccccc-3333-4333-8333-cccccccccccc';
const ALERT_ID = 'dddddddd-4444-4444-8444-dddddddddddd';
/** A profile fingerprint as the review screen sends it (sha256 hex). */
const FINGERPRINT = 'ab'.repeat(32);
/** "Test connection" on the public sandbox (its Stripe key belongs to the operator). */
const STRIPE_TEST_SANDBOX = "Stripe isn't tested on the sandbox: its keys belong to the site's operator, and payouts are switched off.";

/** The service-role client `requireCmsAdmin()` hands out (recording, chainable). */
function adminClient() {
  return {
    from: (table: string) => {
      mocks.from(table);
      const record = { table, kind: 'select', values: undefined as unknown, filters: [] as Array<[string, string, unknown]> };
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      Object.assign(builder, {
        select: chain,
        order: chain,
        limit: chain,
        range: chain,
        maybeSingle: chain,
        single: chain,
        update: (values: unknown) => {
          record.kind = 'update';
          record.values = values;
          return builder;
        },
        insert: (values: unknown) => {
          record.kind = 'insert';
          record.values = values;
          return builder;
        },
        delete: () => {
          record.kind = 'delete';
          return builder;
        },
        eq: (column: string, value: unknown) => {
          record.filters.push(['eq', column, value]);
          return builder;
        },
        in: (column: string, value: unknown) => {
          record.filters.push(['in', column, value]);
          return builder;
        },
        then: (resolve: (value: unknown) => unknown) => {
          if (record.kind !== 'select') mocks.writes.push(record);
          const response = mocks.dbResponses[`${record.kind}:${table}`] ?? {};
          return Promise.resolve({ data: response.data ?? null, error: response.error ?? null }).then(resolve);
        },
      });
      return builder;
    },
  };
}

const VALID_TIER = {
  name: 'Creator Partner',
  nameFr: 'Partenaire créateur',
  goal: 'Make 8 confirmed sales, then contact us.',
  goalFr: 'Réalisez 8 ventes confirmées, puis contactez-nous.',
  slug: '',
  commissionPercentage: 25,
  cookieDurationDays: 45,
  clearanceHoldDays: 30,
  maxAmbassadorsCap: null,
  isLimitedTimePromo: false,
  isDefaultSignupTier: false,
  badgeColor: 'emerald' as const,
  sortOrder: 5,
  isActive: true,
};

/** One call per exported action, with valid input. */
const INVOCATIONS: Array<[string, () => Promise<{ ok: boolean }>]> = [
  ['upsertAffiliateTier', () => actions.upsertAffiliateTier(VALID_TIER)],
  ['deleteAffiliateTier', () => actions.deleteAffiliateTier({ tierIdToDelete: TIER_ID })],
  [
    'approveAffiliateStorefrontAction',
    () =>
      actions.approveAffiliateStorefrontAction({ pageIdToApprove: PAGE_ID, expectedDraftVersion: 2, expectedProfileFingerprint: FINGERPRINT }),
  ],
  [
    'requestAffiliateStorefrontChangesAction',
    () => actions.requestAffiliateStorefrontChangesAction({ pageIdToReview: PAGE_ID, note: 'Fix the claims.', expectedDraftVersion: 2 }),
  ],
  ['suspendAffiliatePartnerAction', () => actions.suspendAffiliatePartnerAction({ affiliateIdToUpdate: AFFILIATE_ID, reason: 'x' })],
  ['reactivateAffiliatePartnerAction', () => actions.reactivateAffiliatePartnerAction({ affiliateIdToUpdate: AFFILIATE_ID })],
  ['removeAffiliatePartnerAction', () => actions.removeAffiliatePartnerAction({ affiliateIdToRemove: AFFILIATE_ID, confirmHandle: 'jane' })],
  [
    'changeAffiliatePartnerTierAction',
    () => actions.changeAffiliatePartnerTierAction({ affiliateIdToUpdate: AFFILIATE_ID, tierIdToAssign: TIER_ID }),
  ],
  ['runAffiliatePayoutsNow', () => actions.runAffiliatePayoutsNow()],
  ['retryAffiliatePayout', () => actions.retryAffiliatePayout({ payoutIdToRetry: PAYOUT_ID })],
  ['releaseAffiliatePayout', () => actions.releaseAffiliatePayout({ payoutIdToRelease: PAYOUT_ID })],
  ['testAffiliateStripeSetup', () => actions.testAffiliateStripeSetup()],
  [
    'saveAffiliatesProgramSettings',
    () => actions.saveAffiliatesProgramSettings({ notificationEmails: 'ops@example.com', minPayoutCents: 500, autoPayoutsEnabled: true }),
  ],
  ['resolveAffiliateAlert', () => actions.resolveAffiliateAlert({ alertIdToResolve: ALERT_ID })],
  [
    'recordManualAffiliatePayoutAction',
    () =>
      actions.recordManualAffiliatePayoutAction({
        payoutIdToRecord: PAYOUT_ID,
        channel: 'paypal',
        reference: '5TY12345AB678901C',
        note: 'Thanks!',
      }),
  ],
  ['prepareManualAffiliatePayoutAction', () => actions.prepareManualAffiliatePayoutAction({ affiliateIdToPay: AFFILIATE_ID, currency: 'CAD' })],
  ['prepareManualAffiliatePayPalPayoutsAction', () => actions.prepareManualAffiliatePayPalPayoutsAction({ currency: 'CAD' })],
  ['cancelManualAffiliatePayoutAction', () => actions.cancelManualAffiliatePayoutAction({ payoutIdToCancel: PAYOUT_ID })],
];

/** The actions that change a partner's status or tier, or remove one (refused on the public sandbox). */
const PARTNER_ACTION_NAMES: readonly string[] = [
  'suspendAffiliatePartnerAction',
  'reactivateAffiliatePartnerAction',
  'changeAffiliatePartnerTierAction',
  'removeAffiliatePartnerAction',
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  mocks.dbResponses = {};
  mocks.writes = [];
  mocks.requireCmsAdmin.mockResolvedValue({ supabase: adminClient(), userId: ADMIN_ID });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('authorization comes first', () => {
  it('covers every exported action', () => {
    const exported = Object.entries(actions)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
      .sort();
    expect(exported).toEqual(INVOCATIONS.map(([name]) => name).sort());
  });

  it.each(['Forbidden', 'Unauthorized'])('refuses a %s caller before any review, payout, settings or database work', async (reason) => {
    for (const [name, invoke] of INVOCATIONS) {
      mocks.requireCmsAdmin.mockRejectedValueOnce(new Error(reason));
      const result = await invoke();
      expect(result, name).toMatchObject({ ok: false });
    }

    expect(mocks.requireCmsAdmin).toHaveBeenCalledTimes(INVOCATIONS.length);
    for (const spy of [
      mocks.approve,
      mocks.requestChanges,
      mocks.suspend,
      mocks.reactivate,
      mocks.remove,
      mocks.changeTier,
      mocks.runCycle,
      mocks.retry,
      mocks.release,
      mocks.saveSettings,
      mocks.stripeSetup,
      mocks.recordManual,
      mocks.prepareManual,
      mocks.preparePayPal,
      mocks.cancelManual,
      mocks.from,
      mocks.serviceClient,
      mocks.evictStorefront,
      mocks.evictTiers,
      mocks.evictProgramSettings,
      mocks.revalidatePath,
    ]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('answers a readable refusal instead of throwing', async () => {
    mocks.requireCmsAdmin.mockRejectedValueOnce(new Error('Forbidden'));
    await expect(actions.retryAffiliatePayout({ payoutIdToRetry: PAYOUT_ID })).resolves.toEqual({
      ok: false,
      error: 'Only administrators can manage the affiliate program.',
    });
  });
});

describe('storefront review actions', () => {
  it('passes the session admin as the reviewer and refuses smuggled keys', async () => {
    mocks.approve.mockResolvedValueOnce({ ok: true, pageId: PAGE_ID, affiliateId: AFFILIATE_ID, handle: 'jane', firstPublication: true, issues: [] });

    const result = await actions.approveAffiliateStorefrontAction({
      pageIdToApprove: PAGE_ID.toUpperCase(),
      expectedDraftVersion: 2,
      expectedProfileFingerprint: FINGERPRINT,
    });

    expect(result).toMatchObject({ ok: true, handle: 'jane' });
    // The reviewed profile's fingerprint reaches the review code (review A).
    expect(mocks.approve).toHaveBeenCalledWith(
      { pageIdToApprove: PAGE_ID, expectedDraftVersion: 2, expectedProfileFingerprint: FINGERPRINT, reviewerUserId: ADMIN_ID },
      expect.anything()
    );

    const smuggled = await actions.approveAffiliateStorefrontAction({
      pageIdToApprove: PAGE_ID,
      expectedDraftVersion: 2,
      expectedProfileFingerprint: FINGERPRINT,
      reviewerUserId: '99999999-9999-4999-8999-999999999999',
    } as never);
    expect(smuggled).toMatchObject({ ok: false });
    expect(mocks.approve).toHaveBeenCalledTimes(1);
  });

  it('validates ids, versions and the note before calling the review code', async () => {
    const approve = (input: Record<string, unknown>) =>
      actions.approveAffiliateStorefrontAction({
        pageIdToApprove: PAGE_ID,
        expectedDraftVersion: 2,
        expectedProfileFingerprint: FINGERPRINT,
        ...input,
      } as never);
    expect(await approve({ pageIdToApprove: 'nope' })).toMatchObject({ ok: false });
    expect(await approve({ expectedDraftVersion: 1.5 })).toMatchObject({ ok: false });
    // Approve without the reviewed profile's fingerprint (or a malformed one) is refused (review A).
    expect(await actions.approveAffiliateStorefrontAction({ pageIdToApprove: PAGE_ID, expectedDraftVersion: 2 } as never)).toMatchObject({
      ok: false,
    });
    for (const expectedProfileFingerprint of ['', 'ab', FINGERPRINT.toUpperCase(), `${FINGERPRINT}0`, ` ${FINGERPRINT}`, 42]) {
      expect(await approve({ expectedProfileFingerprint }), String(expectedProfileFingerprint)).toMatchObject({ ok: false });
    }
    expect(
      await actions.requestAffiliateStorefrontChangesAction({ pageIdToReview: PAGE_ID, note: '   ', expectedDraftVersion: 2 })
    ).toEqual({ ok: false, error: 'Write a note telling the partner what to change.' });
    expect(
      await actions.requestAffiliateStorefrontChangesAction({ pageIdToReview: PAGE_ID, note: 'x'.repeat(2001), expectedDraftVersion: 2 })
    ).toEqual({ ok: false, error: 'Keep the note under 2,000 characters.' });
    expect(mocks.approve).not.toHaveBeenCalled();
    expect(mocks.requestChanges).not.toHaveBeenCalled();
  });

  it('says the note goes out by email, except on the public sandbox, which sends none', async () => {
    const requestChanges = () =>
      actions.requestAffiliateStorefrontChangesAction({ pageIdToReview: PAGE_ID, note: 'Fix the claims.', expectedDraftVersion: 2 });
    const reviewed = { ok: true, pageId: PAGE_ID, affiliateId: AFFILIATE_ID, handle: 'jane' };

    for (const value of ['', 'false', 'TRUE', '1']) {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      mocks.requestChanges.mockResolvedValueOnce(reviewed);
      expect(await requestChanges(), value).toEqual({
        ok: true,
        message: 'Changes requested. @jane will get your note by email.',
        handle: 'jane',
      });
    }

    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    mocks.requestChanges.mockResolvedValueOnce(reviewed);
    expect(await requestChanges()).toEqual({
      ok: true,
      message: 'Changes requested. @jane sees your note in their portal (the sandbox sends no email).',
      handle: 'jane',
    });
  });

  it('relays the review code’s refusal as data', async () => {
    mocks.approve.mockResolvedValueOnce({ ok: false, code: 'version_mismatch', error: 'The partner changed this storefront…' });
    expect(
      await actions.approveAffiliateStorefrontAction({ pageIdToApprove: PAGE_ID, expectedDraftVersion: 2, expectedProfileFingerprint: FINGERPRINT })
    ).toEqual({
      ok: false,
      error: 'The partner changed this storefront…',
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe('partner accounts on the public sandbox', () => {
  const LOCKED = "Partner accounts can't be changed in the sandbox: every visitor shares them.";

  it('refuses every partner status and tier change after the admin check, before its input is read or a row written', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const calls: Array<[string, () => Promise<{ ok: boolean }>]> = [
      ...INVOCATIONS.filter(([name]) => PARTNER_ACTION_NAMES.includes(name)),
      // Refused before validation: malformed input gets the same answer.
      ['suspend, malformed', () => actions.suspendAffiliatePartnerAction({ affiliateIdToUpdate: 'nope', reason: 'x'.repeat(501) })],
      ['reactivate, smuggled key', () => actions.reactivateAffiliatePartnerAction({ affiliateIdToUpdate: AFFILIATE_ID, status: 'ACTIVE' } as never)],
      ['change tier, malformed', () => actions.changeAffiliatePartnerTierAction({ affiliateIdToUpdate: AFFILIATE_ID, tierIdToAssign: '' })],
      [
        'change tier over the cap, emailing the partner',
        () =>
          actions.changeAffiliatePartnerTierAction({ affiliateIdToUpdate: AFFILIATE_ID, tierIdToAssign: TIER_ID, allowOverCap: true, notifyPartner: true }),
      ],
      ['remove, malformed', () => actions.removeAffiliatePartnerAction({ affiliateIdToRemove: 'nope', confirmHandle: '' })],
      [
        'remove, smuggled key',
        () => actions.removeAffiliatePartnerAction({ affiliateIdToRemove: AFFILIATE_ID, confirmHandle: 'studio-nova', force: true } as never),
      ],
    ];

    for (const [name, invoke] of calls) {
      expect(await invoke(), name).toEqual({ ok: false, error: LOCKED });
    }

    expect(mocks.requireCmsAdmin).toHaveBeenCalledTimes(calls.length);
    for (const spy of [
      mocks.suspend,
      mocks.reactivate,
      mocks.remove,
      mocks.changeTier,
      mocks.from,
      mocks.serviceClient,
      mocks.evictStorefront,
      mocks.evictTiers,
      mocks.revalidatePath,
    ]) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(mocks.writes).toEqual([]);
  });

  it('still answers a caller who is not an admin with the admin refusal', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    mocks.requireCmsAdmin.mockRejectedValueOnce(new Error('Forbidden'));

    expect(await actions.suspendAffiliatePartnerAction({ affiliateIdToUpdate: AFFILIATE_ID })).toEqual({
      ok: false,
      error: 'Only administrators can manage the affiliate program.',
    });
  });

  it('keeps storefront reviews, tier edits, payouts, settings and alerts working', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    mocks.approve.mockResolvedValueOnce({ ok: true, pageId: PAGE_ID, affiliateId: AFFILIATE_ID, handle: 'studio-nova', firstPublication: false, issues: [] });
    mocks.requestChanges.mockResolvedValueOnce({ ok: true, pageId: PAGE_ID, affiliateId: AFFILIATE_ID, handle: 'studio-nova' });
    mocks.dbResponses['insert:affiliate_tiers'] = { data: { id: TIER_ID } };
    mocks.dbResponses['select:affiliate_tiers'] = {
      data: { id: TIER_ID, name: 'Old promo', slug: 'old-promo', member_count: 0, badge_color: 'slate', name_translations: {} },
    };
    mocks.dbResponses['delete:affiliate_tiers'] = { data: [{ id: TIER_ID }] };
    mocks.dbResponses['update:system_alerts'] = { data: [{ id: ALERT_ID }] };
    // The payout runner refuses on the sandbox by itself (payout-runner.test.ts); the actions still reach it.
    mocks.runCycle.mockResolvedValueOnce({ trigger: 'admin', sent: 0, failed: 0, aborted: null, skipped: 'sandbox', errors: [] });
    mocks.retry.mockResolvedValueOnce({ ok: false, error: 'sandbox', payoutId: PAYOUT_ID, reason: null });
    mocks.release.mockResolvedValueOnce({ ok: false, error: 'sandbox', payoutId: PAYOUT_ID, reason: null });

    const results: Record<string, unknown> = {};
    for (const [name, invoke] of INVOCATIONS) {
      if (!PARTNER_ACTION_NAMES.includes(name)) results[name] = await invoke();
    }

    const payoutsOff = { ok: false, error: 'Payouts are disabled in the sandbox.' };
    expect(results).toEqual({
      upsertAffiliateTier: { ok: true, message: 'Creator Partner created.', tierId: TIER_ID },
      deleteAffiliateTier: { ok: true, message: 'Old promo deleted.' },
      approveAffiliateStorefrontAction: { ok: true, message: "@studio-nova's storefront update is live.", handle: 'studio-nova' },
      requestAffiliateStorefrontChangesAction: {
        ok: true,
        message: 'Changes requested. @studio-nova sees your note in their portal (the sandbox sends no email).',
        handle: 'studio-nova',
      },
      runAffiliatePayoutsNow: payoutsOff,
      retryAffiliatePayout: payoutsOff,
      releaseAffiliatePayout: payoutsOff,
      // The operator's Stripe key is never used for a visitor: no call reaches payout-setup.
      testAffiliateStripeSetup: { ok: false, error: STRIPE_TEST_SANDBOX, reason: 'sandbox' },
      saveAffiliatesProgramSettings: { ok: true, message: 'Program settings saved.' },
      resolveAffiliateAlert: { ok: true, message: 'Marked as done.' },
      // The shared demo partner's ledger is never prepared, marked paid or handed back (02036): refused before the input is read.
      recordManualAffiliatePayoutAction: payoutsOff,
      prepareManualAffiliatePayoutAction: payoutsOff,
      prepareManualAffiliatePayPalPayoutsAction: payoutsOff,
      cancelManualAffiliatePayoutAction: payoutsOff,
    });
    for (const spy of [mocks.approve, mocks.requestChanges, mocks.runCycle, mocks.retry, mocks.release, mocks.saveSettings]) {
      expect(spy).toHaveBeenCalledTimes(1);
    }
    expect(mocks.stripeSetup).not.toHaveBeenCalled();
    for (const spy of [mocks.recordManual, mocks.prepareManual, mocks.preparePayPal, mocks.cancelManual]) expect(spy).not.toHaveBeenCalled();
    expect(mocks.writes.map((write) => `${write.kind}:${write.table}`)).toEqual([
      'insert:affiliate_tiers',
      'delete:affiliate_tiers',
      'update:system_alerts',
    ]);
  });

  it('suspends, reactivates and moves partners as before anywhere else (only the exact value "true" is the sandbox)', async () => {
    const values = ['', 'false', 'TRUE', '1'];
    for (const value of values) {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      mocks.suspend.mockResolvedValueOnce({ ok: true, affiliateId: AFFILIATE_ID, handle: 'studio-nova', isApproved: true });
      mocks.reactivate.mockResolvedValueOnce({ ok: true, affiliateId: AFFILIATE_ID, handle: 'studio-nova', isApproved: true });
      mocks.changeTier.mockResolvedValueOnce({
        ok: true,
        affiliateId: AFFILIATE_ID,
        handle: 'studio-nova',
        partnerName: 'Studio Nova',
        tierName: 'Founding Ambassador',
        ratePercent: 50,
        unchanged: false,
        notified: false,
      });

      expect(await actions.suspendAffiliatePartnerAction({ affiliateIdToUpdate: AFFILIATE_ID, reason: ' Chargebacks ' }), value).toEqual({
        ok: true,
        message: '@studio-nova is paused. Their storefront is offline and their referral links stop earning.',
      });
      expect(await actions.reactivateAffiliatePartnerAction({ affiliateIdToUpdate: AFFILIATE_ID }), value).toEqual({
        ok: true,
        message: '@studio-nova is active again.',
      });
      expect(await actions.changeAffiliatePartnerTierAction({ affiliateIdToUpdate: AFFILIATE_ID, tierIdToAssign: TIER_ID }), value).toEqual({
        ok: true,
        message: 'Studio Nova moved to Founding Ambassador. Orders paid from now on earn 50%.',
      });
    }

    expect(mocks.suspend).toHaveBeenCalledTimes(values.length);
    expect(mocks.suspend).toHaveBeenCalledWith({ affiliateIdToUpdate: AFFILIATE_ID, reason: 'Chargebacks' }, expect.anything());
    expect(mocks.reactivate).toHaveBeenCalledWith({ affiliateIdToUpdate: AFFILIATE_ID }, expect.anything());
    expect(mocks.changeTier).toHaveBeenCalledWith(
      { affiliateIdToUpdate: AFFILIATE_ID, tierIdToAssign: TIER_ID, allowOverCap: false, notifyPartner: false },
      expect.anything()
    );
  });

  it('words a pause before a first approval without a storefront or earnings it never had', async () => {
    mocks.suspend.mockResolvedValueOnce({ ok: true, affiliateId: AFFILIATE_ID, handle: 'jane', isApproved: false });

    const result = await actions.suspendAffiliatePartnerAction({ affiliateIdToUpdate: AFFILIATE_ID });

    expect(result).toEqual({
      ok: true,
      message: "@jane is paused. They can't edit or submit their storefront until you resume them.",
    });
    expect(result.ok ? result.message : '').not.toMatch(/offline|earning/);
  });
});

describe('changeAffiliatePartnerTierAction', () => {
  const OTHER_TIER = 'ffffffff-6666-4666-8666-ffffffffffff';
  const moved = {
    ok: true,
    affiliateId: AFFILIATE_ID,
    handle: 'jane',
    partnerName: 'Jane Partner',
    tierName: 'Elite Partner',
    ratePercent: 12.5,
    unchanged: false,
    notified: false,
  };
  const change = (input: Record<string, unknown>) =>
    actions.changeAffiliatePartnerTierAction({ affiliateIdToUpdate: AFFILIATE_ID, tierIdToAssign: OTHER_TIER, ...input } as never);
  const revalidated = () => mocks.revalidatePath.mock.calls.map((call) => call.join(' '));

  it('validates a strict input: two ids and two optional booleans, nothing else', async () => {
    for (const input of [
      { tierIdToAssign: 'nope' },
      { affiliateIdToUpdate: '' },
      { allowOverCap: 'true' },
      { notifyPartner: 1 },
      { allowOverCap: true, force: true },
      { affiliateIdToUpdate: AFFILIATE_ID, tierIdToAssign: OTHER_TIER, actorUserId: ADMIN_ID },
    ]) {
      expect(await change(input), JSON.stringify(input)).toEqual({
        ok: false,
        error: 'That request could not be read. Reload the page and try again.',
      });
    }
    expect(mocks.changeTier).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('passes the over-cap and email choices through as booleans (false unless asked)', async () => {
    mocks.changeTier.mockResolvedValue(moved);
    await change({});
    await change({ allowOverCap: true, notifyPartner: true });
    await change({ allowOverCap: false, notifyPartner: false });
    expect(mocks.changeTier.mock.calls.map(([input]) => input)).toEqual([
      { affiliateIdToUpdate: AFFILIATE_ID, tierIdToAssign: OTHER_TIER, allowOverCap: false, notifyPartner: false },
      { affiliateIdToUpdate: AFFILIATE_ID, tierIdToAssign: OTHER_TIER, allowOverCap: true, notifyPartner: true },
      { affiliateIdToUpdate: AFFILIATE_ID, tierIdToAssign: OTHER_TIER, allowOverCap: false, notifyPartner: false },
    ]);
  });

  it('says what the move changes, and refreshes the overview, approvals, every review page and the tiers', async () => {
    mocks.changeTier.mockResolvedValueOnce(moved);
    expect(await change({ notifyPartner: true })).toEqual({
      ok: true,
      message: 'Jane Partner moved to Elite Partner. Orders paid from now on earn 12.5%.',
    });
    expect(revalidated()).toEqual([
      '/cms/affiliates',
      '/cms/affiliates/approvals',
      '/cms/affiliates/tiers',
      '/cms/affiliates/approvals/[pageId] page',
    ]);
  });

  it('answers an unchanged move without refreshing anything, and relays a refusal as data', async () => {
    mocks.changeTier.mockResolvedValueOnce({ ...moved, unchanged: true });
    expect(await change({})).toEqual({ ok: true, message: 'Jane Partner is already in Elite Partner.' });

    // A refusal that says nothing about the screen refreshes nothing.
    for (const code of ['failed', 'invalid_input', 'sandbox']) {
      mocks.changeTier.mockResolvedValueOnce({ ok: false, code, error: `Refused: ${code}.` });
      expect(await change({}), code).toEqual({ ok: false, error: `Refused: ${code}.` });
    }
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  // The dialog asks for "Assign over the cap" only on a tier the page shows as full, so a tier_full
  // refusal means the tier filled up after the page loaded (likewise a tier deactivated or deleted,
  // or a partner removed since). The action re-renders the screens in its response, so the open
  // dialog gets the current tiers instead of refusing the same way on every retry.
  it('refreshes the overview, approvals, every review page and the tiers when the refusal says the screen is stale', async () => {
    for (const code of ['tier_full', 'tier_inactive', 'tier_not_found', 'partner_missing']) {
      mocks.revalidatePath.mockClear();
      mocks.changeTier.mockResolvedValueOnce({ ok: false, code, error: `Stale: ${code}.` });
      expect(await change({}), code).toEqual({ ok: false, error: `Stale: ${code}.` });
      expect(revalidated(), code).toEqual([
        '/cms/affiliates',
        '/cms/affiliates/approvals',
        '/cms/affiliates/tiers',
        '/cms/affiliates/approvals/[pageId] page',
      ]);
    }
  });

  it('still answers when a revalidation throws', async () => {
    mocks.changeTier.mockResolvedValueOnce(moved);
    mocks.revalidatePath.mockImplementation(() => {
      throw new Error('static generation store missing');
    });
    expect(await change({})).toMatchObject({ ok: true });
    mocks.revalidatePath.mockReset();
  });
});

describe('removeAffiliatePartnerAction', () => {
  const removed = {
    ok: true,
    affiliateId: AFFILIATE_ID,
    handle: 'jane',
    displayName: 'Jane Partner',
    removed: true,
    keptBecause: null,
    roleDemoted: true,
  };

  it('validates strict input before the removal code, and passes the validated target', async () => {
    for (const input of [
      { affiliateIdToRemove: 'not-a-uuid', confirmHandle: 'jane' },
      { affiliateIdToRemove: AFFILIATE_ID, confirmHandle: '   ' },
      { affiliateIdToRemove: AFFILIATE_ID, confirmHandle: 'j'.repeat(81) },
      { affiliateIdToRemove: AFFILIATE_ID, confirmHandle: 'jane', reviewerUserId: ADMIN_ID },
      { affiliateIdToUpdate: AFFILIATE_ID, confirmHandle: 'jane' },
    ]) {
      expect(await actions.removeAffiliatePartnerAction(input as never), JSON.stringify(input)).toEqual({
        ok: false,
        error: 'That request could not be read. Reload the page and try again.',
      });
    }
    expect(mocks.remove).not.toHaveBeenCalled();

    mocks.remove.mockResolvedValueOnce(removed);
    await actions.removeAffiliatePartnerAction({ affiliateIdToRemove: AFFILIATE_ID.toUpperCase(), confirmHandle: ' @jane ' });
    expect(mocks.remove).toHaveBeenCalledWith({ affiliateIdToRemove: AFFILIATE_ID, confirmHandle: '@jane' }, expect.anything());
  });

  it('says the partner is gone, and refreshes approvals, overview, tiers and the CMS chrome', async () => {
    mocks.remove.mockResolvedValueOnce(removed);
    expect(await actions.removeAffiliatePartnerAction({ affiliateIdToRemove: AFFILIATE_ID, confirmHandle: 'jane' })).toEqual({
      ok: true,
      message: 'Jane Partner was removed. Their storefront is gone and their account is a customer account again.',
      removed: true,
    });
    const paths = mocks.revalidatePath.mock.calls.map((call) => call.join(' '));
    expect(paths).toEqual(
      expect.arrayContaining(['/cms/affiliates', '/cms/affiliates/approvals', '/cms/affiliates/tiers', '/cms layout'])
    );

    mocks.remove.mockResolvedValueOnce({ ...removed, roleDemoted: false });
    const roleKept = await actions.removeAffiliatePartnerAction({ affiliateIdToRemove: AFFILIATE_ID, confirmHandle: 'jane' });
    expect(roleKept.ok ? roleKept.message : '').toContain('still has the partner role');
  });

  it('reports a partner kept (paused) because of their ledger, or an unreadable one', async () => {
    mocks.remove.mockResolvedValueOnce({ ...removed, removed: false, keptBecause: 'commissions', roleDemoted: false });
    expect(await actions.removeAffiliatePartnerAction({ affiliateIdToRemove: AFFILIATE_ID, confirmHandle: 'jane' })).toEqual({
      ok: true,
      message: 'Jane Partner has commission or payout history, so they were paused instead of removed.',
      removed: false,
    });

    mocks.remove.mockResolvedValueOnce({ ...removed, displayName: ' ', removed: false, keptBecause: 'unavailable', roleDemoted: false });
    const unreadable = await actions.removeAffiliatePartnerAction({ affiliateIdToRemove: AFFILIATE_ID, confirmHandle: 'jane' });
    expect(unreadable).toMatchObject({ ok: true, removed: false });
    expect(unreadable.ok ? unreadable.message : '').toContain("@jane's commission and payout records could not be checked");
  });

  it('relays a refusal as data', async () => {
    mocks.remove.mockResolvedValueOnce({
      ok: false,
      code: 'handle_mismatch',
      error: 'The handle you typed does not match this partner, so nothing was changed.',
    });
    expect(await actions.removeAffiliatePartnerAction({ affiliateIdToRemove: AFFILIATE_ID, confirmHandle: 'janet' })).toEqual({
      ok: false,
      error: 'The handle you typed does not match this partner, so nothing was changed.',
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('refreshes the screens when the removal failed after the partner was paused', async () => {
    mocks.remove.mockResolvedValueOnce({
      ok: false,
      code: 'remove_failed',
      error: 'The partner is paused, but their partner account could not be removed. Try again in a moment.',
    });

    expect(await actions.removeAffiliatePartnerAction({ affiliateIdToRemove: AFFILIATE_ID, confirmHandle: 'jane' })).toEqual({
      ok: false,
      error: 'The partner is paused, but their partner account could not be removed. Try again in a moment.',
    });
    // The partner is paused now: the overview and approvals screens must show it.
    const paths = mocks.revalidatePath.mock.calls.map((call) => call.join(' '));
    expect(paths).toEqual(expect.arrayContaining(['/cms/affiliates', '/cms/affiliates/approvals']));
  });
});

describe('tier actions', () => {
  it('creates a tier with a derived slug and the French name, never member_count', async () => {
    mocks.dbResponses['insert:affiliate_tiers'] = { data: { id: TIER_ID } };

    const result = await actions.upsertAffiliateTier({ ...VALID_TIER, name: 'Créateur Élite 50 %' });

    expect(result).toMatchObject({ ok: true, tierId: TIER_ID });
    const insert = mocks.writes.find((write) => write.kind === 'insert');
    expect(insert?.values).toMatchObject({
      name: 'Créateur Élite 50 %',
      slug: 'createur-elite-50',
      name_translations: { fr: 'Partenaire créateur' },
      commission_percentage: 25,
      badge_color: 'emerald',
    });
    expect(insert?.values).not.toHaveProperty('member_count');
    expect(mocks.evictTiers).toHaveBeenCalledWith('action');
  });

  it('refuses unknown keys, out-of-range values and a bad slug', async () => {
    expect(await actions.upsertAffiliateTier({ ...VALID_TIER, member_count: 0 } as never)).toMatchObject({ ok: false });
    expect(await actions.upsertAffiliateTier({ ...VALID_TIER, commissionPercentage: 120 })).toEqual({
      ok: false,
      error: 'The commission is between 0 and 100 %.',
    });
    expect(await actions.upsertAffiliateTier({ ...VALID_TIER, cookieDurationDays: 0 })).toMatchObject({ ok: false });
    expect(await actions.upsertAffiliateTier({ ...VALID_TIER, badgeColor: 'red' as never })).toMatchObject({ ok: false });
    expect(await actions.upsertAffiliateTier({ ...VALID_TIER, slug: 'Bad Slug!' })).toMatchObject({ ok: false });
    expect(mocks.writes).toEqual([]);
  });

  it('explains a duplicate slug', async () => {
    mocks.dbResponses['insert:affiliate_tiers'] = { error: { code: '23505', message: 'duplicate key value violates unique constraint "affiliate_tiers_slug_key"' } };
    const result = await actions.upsertAffiliateTier({ ...VALID_TIER, slug: 'elite-partner' });
    expect(result).toEqual({ ok: false, error: 'Another tier already uses the slug "elite-partner". Pick a different one.' });
  });

  it('writes the goal and its French translation, each collapsed to one line (02033)', async () => {
    mocks.dbResponses['insert:affiliate_tiers'] = { data: { id: TIER_ID } };

    const result = await actions.upsertAffiliateTier({
      ...VALID_TIER,
      goal: '  Make 8 confirmed sales,\r\n  then   contact us.  ',
      // A no-break space (pasted French typography) and a tab become plain spaces.
      goalFr: `Réalisez 8 ventes${String.fromCharCode(0xa0)}confirmées,\tpuis contactez-nous.`,
    });

    expect(result).toMatchObject({ ok: true, tierId: TIER_ID });
    const insert = mocks.writes.find((write) => write.kind === 'insert');
    expect(insert?.values).toMatchObject({ goal: 'Make 8 confirmed sales, then contact us.' });
    expect((insert?.values as Record<string, unknown>)['goal_translations']).toEqual({
      fr: 'Réalisez 8 ventes confirmées, puis contactez-nous.',
    });
  });

  it('stores a blank goal as null with no translations', async () => {
    mocks.dbResponses['insert:affiliate_tiers'] = { data: { id: TIER_ID } };

    expect(await actions.upsertAffiliateTier({ ...VALID_TIER, goal: ' \n ', goalFr: '' })).toMatchObject({ ok: true });

    const insert = mocks.writes.find((write) => write.kind === 'insert');
    expect(insert?.values).toMatchObject({ goal: null });
    expect((insert?.values as Record<string, unknown>)['goal_translations']).toEqual({});
  });

  it('measures a goal after the whitespace collapse and refuses one over 160 characters', async () => {
    mocks.dbResponses['insert:affiliate_tiers'] = { data: { id: TIER_ID } };

    // 163 characters typed, 160 once the run of spaces collapses: accepted.
    const typed = `${'a'.repeat(80)}    ${'b'.repeat(79)}`;
    expect(typed).toHaveLength(163);
    expect(await actions.upsertAffiliateTier({ ...VALID_TIER, goal: typed })).toMatchObject({ ok: true });
    expect(mocks.writes.find((write) => write.kind === 'insert')?.values).toMatchObject({ goal: `${'a'.repeat(80)} ${'b'.repeat(79)}` });
    mocks.writes = [];

    expect(await actions.upsertAffiliateTier({ ...VALID_TIER, goal: 'x'.repeat(161) })).toEqual({
      ok: false,
      error: 'Goals are at most 160 characters.',
    });
    expect(await actions.upsertAffiliateTier({ ...VALID_TIER, goalFr: 'é'.repeat(161) })).toEqual({
      ok: false,
      error: 'French goals are at most 160 characters.',
    });
    expect(mocks.writes).toEqual([]);
  });

  it('refuses a French goal without the English one', async () => {
    expect(await actions.upsertAffiliateTier({ ...VALID_TIER, goal: '  ', goalFr: 'Réalisez 8 ventes confirmées.' })).toEqual({
      ok: false,
      error: 'Write the English goal too: a French goal alone would show on French pages only.',
    });
    expect(mocks.writes).toEqual([]);
  });

  it('refuses an input without the goal keys instead of clearing the goal', async () => {
    const withoutGoals: Record<string, unknown> = { ...VALID_TIER };
    delete withoutGoals['goal'];
    delete withoutGoals['goalFr'];
    const withoutFrench: Record<string, unknown> = { ...VALID_TIER };
    delete withoutFrench['goalFr'];

    for (const input of [withoutGoals, withoutFrench, { ...VALID_TIER, goal: null }, { ...VALID_TIER, goalFr: 42 }]) {
      expect(await actions.upsertAffiliateTier(input as never)).toEqual({ ok: false, error: 'Check the tier fields and try again.' });
    }
    expect(mocks.writes).toEqual([]);
  });

  it('keeps the other locales of goal_translations on update and replaces the French one', async () => {
    mocks.dbResponses['select:affiliate_tiers'] = {
      data: {
        id: TIER_ID,
        name: 'Growth Partner',
        slug: 'growth-partner',
        member_count: 2,
        badge_color: 'sky',
        name_translations: { fr: 'Partenaire Croissance' },
        goal: 'Make 8 sales.',
        goal_translations: { fr: 'Vendez 8 modules.', es: '  Vende 8 paquetes.  ', 'es-MX': 'not a two-letter locale', de: 7 },
      },
    };
    mocks.dbResponses['update:affiliate_tiers'] = { data: [{ id: TIER_ID }] };

    const result = await actions.upsertAffiliateTier({ ...VALID_TIER, tierIdToUpdate: TIER_ID, name: 'Growth Partner' });

    expect(result).toEqual({ ok: true, message: 'Growth Partner saved.', tierId: TIER_ID });
    const update = mocks.writes.find((write) => write.kind === 'update');
    expect(update?.filters).toContainEqual(['eq', 'id', TIER_ID]);
    expect(update?.values).toMatchObject({ goal: VALID_TIER.goal });
    expect((update?.values as Record<string, unknown>)['goal_translations']).toEqual({ fr: VALID_TIER.goalFr, es: 'Vende 8 paquetes.' });
  });

  it('clears every goal translation when the goal is cleared, and edits a tier read before 02033', async () => {
    mocks.dbResponses['update:affiliate_tiers'] = { data: [{ id: TIER_ID }] };
    mocks.dbResponses['select:affiliate_tiers'] = {
      data: {
        id: TIER_ID,
        name: 'Growth Partner',
        slug: 'growth-partner',
        member_count: 2,
        badge_color: 'sky',
        name_translations: {},
        goal: 'Make 8 sales.',
        goal_translations: { fr: 'Vendez 8 modules.', es: 'Vende 8 paquetes.' },
      },
    };

    expect(await actions.upsertAffiliateTier({ ...VALID_TIER, tierIdToUpdate: TIER_ID, goal: '', goalFr: '' })).toMatchObject({ ok: true });
    const cleared = mocks.writes.find((write) => write.kind === 'update')?.values as Record<string, unknown>;
    expect(cleared).toMatchObject({ goal: null });
    expect(cleared['goal_translations']).toEqual({});

    // A row without the 02033 columns (read before the migration ran) has no other locale to keep.
    mocks.writes = [];
    mocks.dbResponses['select:affiliate_tiers'] = {
      data: { id: TIER_ID, name: 'Growth Partner', slug: 'growth-partner', member_count: 2, badge_color: 'sky', name_translations: {} },
    };
    expect(await actions.upsertAffiliateTier({ ...VALID_TIER, tierIdToUpdate: TIER_ID })).toMatchObject({ ok: true });
    const written = mocks.writes.find((write) => write.kind === 'update')?.values as Record<string, unknown>;
    expect(written).toMatchObject({ goal: VALID_TIER.goal });
    expect(written['goal_translations']).toEqual({ fr: VALID_TIER.goalFr });
  });

  it('refuses to delete a tier that has partners', async () => {
    mocks.dbResponses['select:affiliate_tiers'] = {
      data: { id: TIER_ID, name: 'Starter Partner', slug: 'starter-partner', member_count: 3, badge_color: 'slate', name_translations: {} },
    };
    const result = await actions.deleteAffiliateTier({ tierIdToDelete: TIER_ID });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? '' : result.error).toContain('deactivate the tier');
    expect(mocks.writes).toEqual([]);
  });

  it('deletes an empty tier', async () => {
    mocks.dbResponses['select:affiliate_tiers'] = {
      data: { id: TIER_ID, name: 'Old promo', slug: 'old-promo', member_count: 0, badge_color: 'slate', name_translations: {} },
    };
    mocks.dbResponses['delete:affiliate_tiers'] = { data: [{ id: TIER_ID }] };
    expect(await actions.deleteAffiliateTier({ tierIdToDelete: TIER_ID })).toEqual({ ok: true, message: 'Old promo deleted.' });
    expect(mocks.writes.map((write) => write.kind)).toEqual(['delete']);
  });
});

describe('payout actions', () => {
  it('passes the validated payout id and maps the runner’s outcome', async () => {
    mocks.retry.mockResolvedValueOnce({ ok: true, outcome: 'pending', payoutId: PAYOUT_ID, transferId: null });
    expect(await actions.retryAffiliatePayout({ payoutIdToRetry: PAYOUT_ID.toUpperCase() })).toEqual({
      ok: true,
      message: 'Stripe has not confirmed the transfer yet. The payout stays processing and the next run checks it again.',
    });
    expect(mocks.retry).toHaveBeenCalledWith(PAYOUT_ID);

    mocks.release.mockResolvedValueOnce({ ok: false, error: 'transfer_exists', payoutId: PAYOUT_ID, reason: null });
    const released = await actions.releaseAffiliatePayout({ payoutIdToRelease: PAYOUT_ID });
    expect(released).toMatchObject({ ok: false });
    expect(released.ok ? '' : released.error).toContain('Stripe already has a transfer');

    mocks.retry.mockResolvedValueOnce({ ok: false, error: 'transfer_failed', payoutId: PAYOUT_ID, reason: 'account_closed' });
    const refused = await actions.retryAffiliatePayout({ payoutIdToRetry: PAYOUT_ID });
    expect(refused.ok ? '' : refused.error).toContain('(account_closed)');
  });

  it('never shows free text from the runner and survives a throw', async () => {
    mocks.retry.mockResolvedValueOnce({ ok: false, error: 'Invalid API Key provided: sk_live_123', payoutId: PAYOUT_ID, reason: null });
    const leaked = await actions.retryAffiliatePayout({ payoutIdToRetry: PAYOUT_ID });
    expect(JSON.stringify(leaked)).not.toContain('sk_live');

    mocks.runCycle.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.1:5432'));
    const thrown = await actions.runAffiliatePayoutsNow();
    expect(thrown).toMatchObject({ ok: false });
    expect(JSON.stringify(thrown)).not.toContain('ECONNREFUSED');
  });

  it('runs an admin cycle and summarizes it', async () => {
    mocks.runCycle.mockResolvedValueOnce({
      trigger: 'admin',
      sent: 2,
      failed: 1,
      pending: 0,
      claimed: 3,
      promoted: 4,
      aborted: null,
      skipped: null,
      errors: [],
    });
    expect(await actions.runAffiliatePayoutsNow()).toEqual({
      ok: true,
      message: 'Payout run finished: 2 payouts sent, 1 failed, 4 commissions cleared.',
    });
    expect(mocks.runCycle).toHaveBeenCalledWith('admin');
  });

  it('explains a skipped or aborted run', async () => {
    mocks.runCycle.mockResolvedValueOnce({ trigger: 'admin', sent: 0, failed: 0, aborted: null, skipped: 'sandbox', errors: [] });
    expect(await actions.runAffiliatePayoutsNow()).toEqual({ ok: false, error: 'Payouts are disabled in the sandbox.' });

    mocks.runCycle.mockResolvedValueOnce({ trigger: 'admin', sent: 1, failed: 0, aborted: 'stripe_authentication', skipped: null, errors: [] });
    expect(await actions.runAffiliatePayoutsNow()).toEqual({
      ok: false,
      error: 'Stripe refused the API key. Check the Stripe keys under Payments. 1 payout was sent before the run stopped.',
    });
  });

  it('rejects malformed payout ids before the runner', async () => {
    expect(await actions.retryAffiliatePayout({ payoutIdToRetry: "1; drop table affiliate_payouts" })).toMatchObject({ ok: false });
    expect(await actions.releaseAffiliatePayout({ payoutIdToRelease: '' })).toMatchObject({ ok: false });
    expect(mocks.retry).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('explains the runner’s package, settings, mode and minimum refusals', async () => {
    const inactive = 'The affiliate program is paused: it needs both the Affiliates package and Commerce Pro to be active.';
    mocks.runCycle.mockResolvedValueOnce({ trigger: 'admin', sent: 0, failed: 0, aborted: null, skipped: 'package_inactive', errors: [] });
    expect(await actions.runAffiliatePayoutsNow()).toEqual({ ok: false, error: inactive });
    mocks.retry.mockResolvedValueOnce({ ok: false, error: 'package_inactive', payoutId: PAYOUT_ID, reason: null });
    expect(await actions.retryAffiliatePayout({ payoutIdToRetry: PAYOUT_ID })).toEqual({ ok: false, error: inactive });
    mocks.release.mockResolvedValueOnce({ ok: false, error: 'package_inactive', payoutId: PAYOUT_ID, reason: null });
    expect(await actions.releaseAffiliatePayout({ payoutIdToRelease: PAYOUT_ID })).toEqual({ ok: false, error: inactive });

    mocks.runCycle.mockResolvedValueOnce({ trigger: 'admin', sent: 0, failed: 0, aborted: null, skipped: 'settings_unavailable', errors: [] });
    const unreadable = await actions.runAffiliatePayoutsNow();
    expect(unreadable.ok ? '' : unreadable.error).toContain('The program settings could not be read');

    mocks.retry.mockResolvedValueOnce({ ok: false, error: 'other_mode', payoutId: PAYOUT_ID, reason: null });
    const otherMode = await actions.retryAffiliatePayout({ payoutIdToRetry: PAYOUT_ID });
    expect(otherMode.ok ? '' : otherMode.error).toContain('the other Stripe key (test or live)');

    mocks.retry.mockResolvedValueOnce({ ok: false, error: 'below_minimum', payoutId: PAYOUT_ID, reason: null });
    const belowMinimum = await actions.retryAffiliatePayout({ payoutIdToRetry: PAYOUT_ID });
    expect(belowMinimum.ok ? '' : belowMinimum.error).toContain('below the minimum payout');
  });

  it('says what a run without Stripe did: the ledger repair (02036)', async () => {
    // Every commission paid by hand: a success that points at "Pay manually".
    mocks.runCycle.mockResolvedValueOnce({ trigger: 'admin', promoted: 3, recorded: 1, sent: 0, skipped: null, stripeTransfers: 'not_needed', errors: [] });
    expect(await actions.runAffiliatePayoutsNow()).toEqual({
      ok: true,
      message:
        'Commissions checked: 3 cleared, 1 recorded late. Every commission is paid manually, so nothing was sent through Stripe: prepare, send and record each payout under Pay manually.',
    });
    mocks.runCycle.mockResolvedValueOnce({ trigger: 'admin', promoted: 0, recorded: 0, skipped: null, stripeTransfers: 'not_needed', errors: [] });
    const quiet = await actions.runAffiliatePayoutsNow();
    expect(quiet.ok ? quiet.message : '').toMatch(/^No commission was due to clear\. Every commission is paid manually/);

    // 02037: a gateway routed to PayPal is never "paid manually", even when PayPal had nothing to send.
    const paypalStep = (extra: Record<string, unknown>) => ({
      environment: 'live',
      gateways: ['FREEMIUS'],
      skipped: null,
      synced: 0,
      completed: 0,
      failed: 0,
      inFlight: 0,
      unclaimed: 0,
      unknown: 0,
      claimed: 0,
      submitted: 0,
      pendingRetry: 0,
      remaining: 0,
      errors: [],
      ...extra,
    });
    mocks.runCycle.mockResolvedValueOnce({ trigger: 'admin', promoted: 0, recorded: 0, skipped: null, stripeTransfers: 'not_needed', errors: [], paypal: paypalStep({}) });
    const idle = await actions.runAffiliatePayoutsNow();
    expect(idle.ok ? idle.message : '').toBe(
      'No commission was due to clear. No commission is paid through Stripe, so nothing was sent through Stripe. PayPal: no payout was due.'
    );
    // PayPal in Sandbox while live sales are routed to it: the run says those wait, instead of staying silent.
    mocks.runCycle.mockResolvedValueOnce({
      trigger: 'admin',
      promoted: 0,
      recorded: 0,
      skipped: null,
      stripeTransfers: 'not_needed',
      errors: [],
      paypal: paypalStep({ environment: 'sandbox' }),
    });
    const sandboxRun = await actions.runAffiliatePayoutsNow();
    expect(sandboxRun.ok ? sandboxRun.message : '').toContain(
      'PayPal is in Sandbox: commissions on real (live) sales routed to PayPal are not sent and not listed under Pay manually'
    );
    expect(sandboxRun.ok ? sandboxRun.message : '').not.toContain('Every commission is paid manually');

    // Stripe needed but missing: still refused, with what the repair cleared.
    mocks.runCycle.mockResolvedValueOnce({ trigger: 'admin', promoted: 2, skipped: 'stripe_not_configured', stripeTransfers: 'skipped', errors: [] });
    expect(await actions.runAffiliatePayoutsNow()).toEqual({
      ok: false,
      error: 'Stripe is not configured, so no transfer can be sent. Add the Stripe keys under Payments first. Commissions checked: 2 cleared.',
    });
  });
});

describe('manual payouts: prepare, record, cancel (Pay manually, 02036)', () => {
  const AFFILIATE_CMS_PAYOUTS = '/cms/affiliates/payouts';
  const RECORD = {
    payoutIdToRecord: PAYOUT_ID,
    channel: 'interac' as const,
    reference: '  CA1x2y3z  ',
    note: ' Thanks for October! ',
  };

  it('prepares one partner with validated input (the gateways come from the settings) and says to send exactly that', async () => {
    mocks.prepareManual.mockResolvedValueOnce({ status: 'prepared', payoutId: PAYOUT_ID, amountCents: 12_345, commissionCount: 3, currency: 'CAD' });

    expect(await actions.prepareManualAffiliatePayoutAction({ affiliateIdToPay: AFFILIATE_ID, currency: ' cad ' })).toEqual({
      ok: true,
      message: 'Payout prepared: CA$123.45 for 3 commissions. Send exactly this amount, then record it with its reference.',
      payoutId: PAYOUT_ID,
    });
    expect(mocks.prepareManual).toHaveBeenCalledWith({ affiliateIdToPay: AFFILIATE_ID, currency: 'CAD' });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(AFFILIATE_CMS_PAYOUTS);

    mocks.prepareManual.mockResolvedValueOnce({ status: 'already_prepared', payoutId: PAYOUT_ID, amountCents: 900, currency: 'CAD' });
    const again = await actions.prepareManualAffiliatePayoutAction({ affiliateIdToPay: AFFILIATE_ID, currency: 'CAD' });
    expect(again.ok ? '' : again.error).toBe(
      'A payout of CA$9.00 is already prepared for this partner in CAD. Record it or cancel it under Prepared payouts first.'
    );
    for (const input of [{ affiliateIdToPay: 'nope', currency: 'CAD' }, { affiliateIdToPay: AFFILIATE_ID, currency: 'CA' }, { affiliateIdToPay: AFFILIATE_ID, currency: 'CAD', gateways: ['STRIPE'] }]) {
      expect(await actions.prepareManualAffiliatePayoutAction(input as never)).toMatchObject({ ok: false });
    }
    expect(mocks.prepareManual).toHaveBeenCalledTimes(2);
  });

  it('prepares the PayPal payouts of a currency and says what to do next', async () => {
    mocks.preparePayPal.mockResolvedValueOnce({ status: 'done', currency: 'CAD', prepared: 3, preparedAmountCents: 30_000, skipped: 1, remaining: 2 });
    expect(await actions.prepareManualAffiliatePayPalPayoutsAction({ currency: 'cad' })).toEqual({
      ok: true,
      message:
        '3 PayPal payouts prepared (CA$300.00). Download the PayPal payouts file next. 1 partner was left out: what they are owed changed. 2 more partners wait: prepare again for the rest.',
    });
    expect(mocks.preparePayPal).toHaveBeenCalledWith({ currency: 'CAD' });

    mocks.preparePayPal.mockResolvedValueOnce({ status: 'nothing_to_prepare' });
    const nothing = await actions.prepareManualAffiliatePayPalPayoutsAction({ currency: 'CAD' });
    expect(nothing.ok ? '' : nothing.error).toMatch(/^No partner owed in this currency has a payout email/);

    mocks.preparePayPal.mockResolvedValueOnce({ status: 'done', currency: 'CAD', prepared: 0, preparedAmountCents: 0, skipped: 2, remaining: 0 });
    const none = await actions.prepareManualAffiliatePayPalPayoutsAction({ currency: 'CAD' });
    expect(none).toEqual({ ok: false, error: 'No PayPal payout was prepared: what these partners are owed changed. Reload the page.' });

    expect(await actions.prepareManualAffiliatePayPalPayoutsAction({ currency: 'CA', extra: 1 } as never)).toMatchObject({ ok: false });
    expect(mocks.preparePayPal).toHaveBeenCalledTimes(3);
  });

  it('records a prepared payout with the validated input (never a recorder) and words the result', async () => {
    mocks.recordManual.mockResolvedValueOnce({
      status: 'recorded',
      payoutId: PAYOUT_ID,
      affiliateId: AFFILIATE_ID,
      amountCents: 12_345,
      commissionCount: 3,
      currency: 'CAD',
    });

    expect(await actions.recordManualAffiliatePayoutAction(RECORD)).toEqual({
      ok: true,
      message: 'Payout recorded: CA$123.45, 3 commissions marked as paid. The partner gets an email.',
      payoutId: PAYOUT_ID,
    });
    expect(mocks.recordManual).toHaveBeenCalledWith({
      payoutIdToRecord: PAYOUT_ID,
      channel: 'interac',
      reference: 'CA1x2y3z',
      note: 'Thanks for October!',
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(AFFILIATE_CMS_PAYOUTS);
  });

  it('refuses smuggled keys (a recorder, an amount, a partner), and malformed values before the implementation', async () => {
    const refused = [
      { ...RECORD, recordedBy: ADMIN_ID },
      { ...RECORD, expectedAmountCents: 12_345 },
      { ...RECORD, affiliateIdToPay: AFFILIATE_ID },
      { ...RECORD, payoutIdToRecord: 'nope' },
      { ...RECORD, channel: 'venmo' },
      { ...RECORD, note: 'x'.repeat(501) },
    ];
    for (const input of refused) {
      expect(await actions.recordManualAffiliatePayoutAction(input as never), JSON.stringify(input).slice(0, 80)).toMatchObject({ ok: false });
    }
    expect(await actions.recordManualAffiliatePayoutAction({ ...RECORD, reference: '   ' })).toEqual({
      ok: false,
      error: 'Enter the PayPal transaction ID, e-Transfer reference or bank reference.',
    });
    expect(await actions.recordManualAffiliatePayoutAction({ ...RECORD, reference: 'r'.repeat(121) })).toEqual({
      ok: false,
      error: 'Keep the reference under 120 characters.',
    });
    expect(mocks.recordManual).not.toHaveBeenCalled();
  });

  it('maps every refusal of the three writes to a sentence, never free text', async () => {
    const expected: Record<string, RegExp> = {
      forbidden: /^Only administrators/,
      sandbox: /^Payouts are disabled in the sandbox\.$/,
      package_inactive: /^The affiliate program is paused/,
      settings_unavailable: /^The program settings could not be read/,
      not_manual: /^No commissions are set to be paid manually\./,
      invalid_input: /^That request could not be read/,
      not_found: /^That payout or partner no longer exists/,
      not_eligible: /paused or not approved yet/,
      reference_required: /^Enter the PayPal transaction ID/,
      duplicate_reference: /already recorded for this partner/,
      already_recorded: /^This payout is already recorded/,
      nothing_owed: /^Nothing is owed to this partner/,
      unknown: /^The payout could not be saved/,
      'Invalid API Key: sk_live_1': /^The payout could not be saved/,
    };
    for (const [status, pattern] of Object.entries(expected)) {
      mocks.recordManual.mockResolvedValueOnce({ status });
      const result = await actions.recordManualAffiliatePayoutAction(RECORD);
      expect(result.ok, status).toBe(false);
      expect(result.ok ? '' : result.error, status).toMatch(pattern);
    }
    mocks.cancelManual.mockResolvedValueOnce({ status: 'already_recorded' });
    const recorded = await actions.cancelManualAffiliatePayoutAction({ payoutIdToCancel: PAYOUT_ID });
    expect(recorded.ok ? '' : recorded.error).toMatch(/^This payout is already recorded/);
    mocks.prepareManual.mockResolvedValueOnce({ status: 'below_minimum', amountCents: 10, commissionCount: 1 });
    const below = await actions.prepareManualAffiliatePayoutAction({ affiliateIdToPay: AFFILIATE_ID, currency: 'CAD' });
    expect(below.ok ? '' : below.error).toMatch(/^Nothing is owed to this partner/);

    mocks.recordManual.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.1:5432'));
    const thrown = await actions.recordManualAffiliatePayoutAction(RECORD);
    expect(JSON.stringify(thrown)).not.toContain('ECONNREFUSED');
  });

  it('cancels a prepared payout and says where its commissions went', async () => {
    mocks.cancelManual.mockResolvedValueOnce({ status: 'cancelled', commissionCount: 2 });
    expect(await actions.cancelManualAffiliatePayoutAction({ payoutIdToCancel: PAYOUT_ID })).toEqual({
      ok: true,
      message: 'Payout cancelled. 2 commissions went back to what is owed.',
    });
    expect(mocks.cancelManual).toHaveBeenCalledWith({ payoutIdToCancel: PAYOUT_ID });
    mocks.cancelManual.mockResolvedValueOnce({ status: 'cancelled', commissionCount: 0 });
    const emptied = await actions.cancelManualAffiliatePayoutAction({ payoutIdToCancel: PAYOUT_ID });
    expect(emptied.ok ? emptied.message : '').toBe('Payout cancelled. Its commissions were refunded meanwhile, so nothing went back to what is owed.');
    expect(await actions.cancelManualAffiliatePayoutAction({ payoutIdToCancel: 'nope' })).toMatchObject({ ok: false });
    expect(mocks.cancelManual).toHaveBeenCalledTimes(2);
  });

  it('is refused on the public sandbox right after the admin check, malformed input included', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const attempts = [
      () => actions.recordManualAffiliatePayoutAction(RECORD),
      () => actions.recordManualAffiliatePayoutAction({ ...RECORD, payoutIdToRecord: 'nope', reference: '' }),
      () => actions.prepareManualAffiliatePayoutAction({ affiliateIdToPay: AFFILIATE_ID, currency: 'CAD' }),
      () => actions.prepareManualAffiliatePayPalPayoutsAction({ currency: 'CAD' }),
      () => actions.cancelManualAffiliatePayoutAction({ payoutIdToCancel: PAYOUT_ID }),
    ];
    for (const attempt of attempts) {
      expect(await attempt()).toEqual({ ok: false, error: 'Payouts are disabled in the sandbox.' });
    }
    expect(mocks.requireCmsAdmin).toHaveBeenCalledTimes(attempts.length);
    for (const spy of [mocks.recordManual, mocks.prepareManual, mocks.preparePayPal, mocks.cancelManual]) expect(spy).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();

    // Only the exact value "true" is the sandbox.
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'TRUE');
    mocks.recordManual.mockResolvedValueOnce({ status: 'already_recorded' });
    await actions.recordManualAffiliatePayoutAction(RECORD);
    expect(mocks.recordManual).toHaveBeenCalledTimes(1);
  });
});

describe('settings and alerts', () => {
  it('saves normalized notification addresses', async () => {
    mocks.saveSettings.mockResolvedValueOnce({ notificationEmails: ['ops@example.com', 'team@example.com'], minPayoutCents: 500, autoPayoutsEnabled: false });
    const result = await actions.saveAffiliatesProgramSettings({
      notificationEmails: ' Ops@Example.com\nteam@example.com, ops@example.com ',
      minPayoutCents: 500,
      autoPayoutsEnabled: false,
    });
    expect(result).toEqual({ ok: true, message: 'Program settings saved.' });
    expect(mocks.saveSettings).toHaveBeenCalledWith({
      notificationEmails: ['ops@example.com', 'team@example.com'],
      minPayoutCents: 500,
      autoPayoutsEnabled: false,
    });
  });

  it('saves how partners are paid (strict: the three known methods, nothing else), and keeps it when omitted (02036, 02037)', async () => {
    const base = { notificationEmails: '', minPayoutCents: 500, autoPayoutsEnabled: true };
    expect(
      await actions.saveAffiliatesProgramSettings({ ...base, payoutMethods: { stripeSales: 'stripe_connect', freemiusSales: 'manual' } })
    ).toEqual({ ok: true, message: 'Program settings saved.' });
    expect(mocks.saveSettings).toHaveBeenLastCalledWith({
      notificationEmails: [],
      minPayoutCents: 500,
      autoPayoutsEnabled: true,
      payoutMethods: { stripeSales: 'stripe_connect', freemiusSales: 'manual' },
    });
    // 02037: automatic PayPal Payouts.
    expect(
      await actions.saveAffiliatesProgramSettings({ ...base, payoutMethods: { stripeSales: 'stripe_connect', freemiusSales: 'paypal' } })
    ).toEqual({ ok: true, message: 'Program settings saved.' });
    expect(mocks.saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ payoutMethods: { stripeSales: 'stripe_connect', freemiusSales: 'paypal' } })
    );

    for (const payoutMethods of [
      { stripeSales: 'stripe_connect', freemiusSales: 'PayPal' },
      { stripeSales: 'stripe_connect', freemiusSales: 'venmo' },
      { stripeSales: 'manual' },
      { stripeSales: 'manual', freemiusSales: 'manual', venmoSales: 'manual' },
      'manual',
    ]) {
      expect(await actions.saveAffiliatesProgramSettings({ ...base, payoutMethods } as never), JSON.stringify(payoutMethods)).toMatchObject({ ok: false });
    }
    expect(mocks.saveSettings).toHaveBeenCalledTimes(2);

    await actions.saveAffiliatesProgramSettings(base);
    expect(mocks.saveSettings).toHaveBeenLastCalledWith({ notificationEmails: [], minPayoutCents: 500, autoPayoutsEnabled: true });
  });

  it('refuses invalid addresses, too many of them, and a minimum outside the limits', async () => {
    const invalid = await actions.saveAffiliatesProgramSettings({
      notificationEmails: 'ok@example.com, "x"@evil\r\nBcc: a@b.c',
      minPayoutCents: 500,
      autoPayoutsEnabled: true,
    });
    expect(invalid).toMatchObject({ ok: false });
    const many = Array.from({ length: 11 }, (_, index) => `user${index}@example.com`);
    expect(await actions.saveAffiliatesProgramSettings({ notificationEmails: many, minPayoutCents: 500, autoPayoutsEnabled: true })).toEqual({
      ok: false,
      error: 'Enter at most 10 notification addresses.',
    });
    expect(await actions.saveAffiliatesProgramSettings({ notificationEmails: '', minPayoutCents: 10, autoPayoutsEnabled: true })).toEqual({
      ok: false,
      error: 'The minimum payout is too small for a Stripe transfer.',
    });
    expect(mocks.saveSettings).not.toHaveBeenCalled();
  });

  it('saves the partner terms pages (trimmed) and evicts the public projection', async () => {
    const result = await actions.saveAffiliatesProgramSettings({
      notificationEmails: '',
      minPayoutCents: 500,
      autoPayoutsEnabled: true,
      termsUrlEn: ' /legal/partner-terms ',
      termsUrlFr: 'https://legal.example.com/conditions-partenaires',
    });
    expect(result).toEqual({ ok: true, message: 'Program settings saved.' });
    expect(mocks.saveSettings).toHaveBeenCalledWith({
      notificationEmails: [],
      minPayoutCents: 500,
      autoPayoutsEnabled: true,
      termsUrlEn: '/legal/partner-terms',
      termsUrlFr: 'https://legal.example.com/conditions-partenaires',
    });
    expect(mocks.evictProgramSettings).toHaveBeenCalledWith('action');
  });

  it('saves the canonical form a browser requests (percent-encoded ASCII, so the redirect never answers 500)', async () => {
    const result = await actions.saveAffiliatesProgramSettings({
      notificationEmails: '',
      minPayoutCents: 500,
      autoPayoutsEnabled: true,
      termsUrlEn: '/conditions’partenaires',
      termsUrlFr: 'HTTPS://Légal.Example.com/conditions',
    });
    expect(result).toEqual({ ok: true, message: 'Program settings saved.' });
    expect(mocks.saveSettings).toHaveBeenCalledWith({
      notificationEmails: [],
      minPayoutCents: 500,
      autoPayoutsEnabled: true,
      termsUrlEn: '/conditions%E2%80%99partenaires',
      termsUrlFr: 'https://xn--lgal-bpa.example.com/conditions',
    });
  });

  it('keeps the stored terms pages when the fields are omitted, and clears them with an empty string', async () => {
    await actions.saveAffiliatesProgramSettings({ notificationEmails: '', minPayoutCents: 500, autoPayoutsEnabled: true });
    expect(mocks.saveSettings).toHaveBeenLastCalledWith({ notificationEmails: [], minPayoutCents: 500, autoPayoutsEnabled: true });

    await actions.saveAffiliatesProgramSettings({
      notificationEmails: '',
      minPayoutCents: 500,
      autoPayoutsEnabled: true,
      termsUrlEn: '',
      termsUrlFr: '   ',
    });
    expect(mocks.saveSettings).toHaveBeenLastCalledWith({
      notificationEmails: [],
      minPayoutCents: 500,
      autoPayoutsEnabled: true,
      termsUrlEn: '',
      termsUrlFr: '',
    });
  });

  it('refuses a terms page that is not a site path or an https URL, or that is the built-in terms address', async () => {
    const base = { notificationEmails: '', minPayoutCents: 500, autoPayoutsEnabled: true };
    const shape =
      'partner terms page must be a path on this site that starts with a single / (like /legal/partner-terms, without // or /./ or /../) or a full https:// address, without spaces and at most 2,048 characters.';
    for (const termsUrlEn of [
      'http://legal.example.com/terms',
      'javascript:alert(1)',
      '//evil.example/terms',
      '/\\evil.example',
      'legal/terms',
      '/legal terms',
      'https://user:secret@legal.example.com/terms',
      `/${'a'.repeat(2048)}`,
      // Rewritten into another address by Next (`//` → 308) or the browser (dot segments): the
      // first four would send /partners/terms back to itself.
      '/partners//terms',
      '/partners/./terms',
      '/partenaires/../partners/terms',
      '/partners/terms/.',
      '/legal//partner-terms',
      '/legal/%2e%2e/terms',
      '/legal%2fterms',
      '/%2f/evil.example',
    ]) {
      expect(await actions.saveAffiliatesProgramSettings({ ...base, termsUrlEn }), termsUrlEn).toEqual({
        ok: false,
        error: `The English ${shape}`,
      });
    }
    expect(await actions.saveAffiliatesProgramSettings({ ...base, termsUrlFr: 'ftp://legal.example.com' })).toEqual({
      ok: false,
      error: `The French ${shape}`,
    });
    // The built-in addresses however they are spelled, also as an https URL on this site's host
    // (resolveSiteUrl(), www. ignored): the rule every read applies too.
    vi.stubEnv('NEXT_PUBLIC_URL', 'https://shop.example.com');
    for (const termsUrlFr of [
      '/partners/terms',
      '/partenaires/conditions/',
      '/Partners/Terms?x=1',
      '/partners/%74erms',
      'https://shop.example.com/partners/terms',
      'https://www.shop.example.com/partenaires/conditions',
      'https://SHOP.example.com/partners//terms',
    ]) {
      expect(await actions.saveAffiliatesProgramSettings({ ...base, termsUrlFr }), termsUrlFr).toEqual({
        ok: false,
        error: 'The French partner terms page is the address of the built-in terms. Leave the field empty to use them.',
      });
    }
    // Bounded by the schema too (strings past 4,096 characters never reach the parser).
    expect(await actions.saveAffiliatesProgramSettings({ ...base, termsUrlEn: `/${'a'.repeat(5000)}` })).toEqual({
      ok: false,
      error: 'Check the settings and try again.',
    });
    expect(mocks.saveSettings).not.toHaveBeenCalled();
    expect(mocks.evictProgramSettings).not.toHaveBeenCalled();
  });

  it('refuses a non-empty terms page on the public sandbox right after the admin check, and saves the rest as before', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const locked = {
      ok: false,
      error: "Partner terms links can't be changed in the sandbox: every visitor, and the partner sign-up form, would be sent there.",
    };
    const base = { notificationEmails: 'ops@example.com', minPayoutCents: 500, autoPayoutsEnabled: false };

    expect(await actions.saveAffiliatesProgramSettings({ ...base, termsUrlEn: 'https://evil.example/terms' })).toEqual(locked);
    expect(await actions.saveAffiliatesProgramSettings({ ...base, termsUrlFr: '/legal/fr' })).toEqual(locked);
    // Refused before validation: malformed input with a link gets the same answer.
    expect(await actions.saveAffiliatesProgramSettings({ ...base, minPayoutCents: 1, termsUrlEn: 'x' } as never)).toEqual(locked);
    expect(mocks.saveSettings).not.toHaveBeenCalled();
    expect(mocks.evictProgramSettings).not.toHaveBeenCalled();
    expect(mocks.requireCmsAdmin).toHaveBeenCalledTimes(3);

    // Empty links (what the sandbox form sends) and the other fields save as anywhere else.
    expect(await actions.saveAffiliatesProgramSettings({ ...base, termsUrlEn: '', termsUrlFr: '' })).toEqual({
      ok: true,
      message: 'Program settings saved.',
    });
    expect(mocks.saveSettings).toHaveBeenCalledWith({
      notificationEmails: ['ops@example.com'],
      minPayoutCents: 500,
      autoPayoutsEnabled: false,
      termsUrlEn: '',
      termsUrlFr: '',
    });

    // A caller who is not an admin still gets the admin refusal first.
    mocks.requireCmsAdmin.mockRejectedValueOnce(new Error('Forbidden'));
    expect(await actions.saveAffiliatesProgramSettings({ ...base, termsUrlEn: '/legal' })).toEqual({
      ok: false,
      error: 'Only administrators can manage the affiliate program.',
    });
  });

  it('resolves only affiliate alerts', async () => {
    mocks.dbResponses['update:system_alerts'] = { data: [{ id: ALERT_ID }] };
    expect(await actions.resolveAffiliateAlert({ alertIdToResolve: ALERT_ID })).toEqual({ ok: true, message: 'Marked as done.' });
    const update = mocks.writes.find((write) => write.table === 'system_alerts');
    expect(update?.values).toMatchObject({ is_resolved: true });
    expect(update?.filters).toContainEqual(['eq', 'id', ALERT_ID]);
    const typeFilter = update?.filters.find(([kind, column]) => kind === 'in' && column === 'alert_type');
    expect(typeFilter?.[2]).not.toContain('merge_conflict');
    expect(typeFilter?.[2]).toContain('affiliate_page_submitted');
  });
});

describe('Stripe connection test', () => {
  const CHECKS = [
    { id: 'key', status: 'pass', title: 'Stripe key', detail: 'Stripe accepted the key (test mode, key ending in 4242).' },
    { id: 'platform', status: 'warn', title: 'Platform account', detail: 'Connect onboarding needs a business name, a brand colour and an icon.' },
    { id: 'webhook', status: 'fail', title: 'Webhook endpoint', detail: "Couldn't reach Stripe. Try again in a moment." },
  ] as const;
  const NOTE = 'Nothing was charged or transferred.';

  it('refuses on the public sandbox right after the admin check, before any Stripe call', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    await expect(actions.testAffiliateStripeSetup()).resolves.toEqual({ ok: false, error: STRIPE_TEST_SANDBOX, reason: 'sandbox' });
    expect(mocks.requireCmsAdmin).toHaveBeenCalledTimes(1);
    expect(mocks.stripeSetup).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();

    // A caller who is not an admin gets the admin refusal, not the sandbox one.
    mocks.requireCmsAdmin.mockRejectedValueOnce(new Error('Forbidden'));
    await expect(actions.testAffiliateStripeSetup()).resolves.toEqual({
      ok: false,
      error: 'Only administrators can manage the affiliate program.',
      reason: 'forbidden',
    });
  });

  it('runs the read-only checks anywhere else (only the exact value "true" is the sandbox) and summarizes them', async () => {
    for (const value of ['', 'false', 'TRUE', '1']) {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      mocks.stripeSetup.mockResolvedValueOnce({ ok: true, livemode: false, checks: CHECKS, note: NOTE });
      await expect(actions.testAffiliateStripeSetup(), value).resolves.toEqual({
        ok: true,
        message: '1 check failed, 1 with a warning.',
        livemode: false,
        checks: CHECKS,
        note: NOTE,
      });
    }
    expect(mocks.stripeSetup).toHaveBeenCalledTimes(4);
    expect(mocks.stripeSetup).toHaveBeenCalledWith();
    expect(mocks.writes).toEqual([]);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('says when every check passed, or only warnings are left', async () => {
    mocks.stripeSetup.mockResolvedValueOnce({ ok: true, livemode: true, checks: [CHECKS[0]], note: NOTE });
    await expect(actions.testAffiliateStripeSetup()).resolves.toMatchObject({ ok: true, message: 'Stripe answered every check.' });
    mocks.stripeSetup.mockResolvedValueOnce({ ok: true, livemode: true, checks: [CHECKS[0], CHECKS[1]], note: NOTE });
    await expect(actions.testAffiliateStripeSetup()).resolves.toMatchObject({ ok: true, message: 'Stripe answered. 1 check needs your attention.' });
  });

  it('answers each refusal with a fixed sentence, and a throw without its text', async () => {
    mocks.stripeSetup.mockResolvedValueOnce({ ok: false, reason: 'stripe_not_configured' });
    await expect(actions.testAffiliateStripeSetup()).resolves.toEqual({
      ok: false,
      error: 'No Stripe secret key is configured. Add it under CMS > Payments, then test again.',
      reason: 'stripe_not_configured',
    });
    mocks.stripeSetup.mockResolvedValueOnce({ ok: false, reason: 'package_inactive' });
    await expect(actions.testAffiliateStripeSetup()).resolves.toEqual({
      ok: false,
      error: 'The affiliate program is paused: it needs both the Affiliates package and Commerce Pro to be active.',
      reason: 'package_inactive',
    });

    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.stripeSetup.mockRejectedValueOnce(new Error('Invalid API Key provided: sk_live_123'));
    const thrown = await actions.testAffiliateStripeSetup();
    expect(thrown).toEqual({ ok: false, error: 'The test did not run. Try again in a moment.', reason: 'unknown' });
    expect(JSON.stringify(thrown)).not.toContain('sk_live');
    errorLog.mockRestore();
  });
});
