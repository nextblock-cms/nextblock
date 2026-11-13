'use server';

import 'server-only';

import { revalidatePath } from 'next/cache';
import {
  AFFILIATE_BADGE_COLORS,
  AFFILIATE_CMS_APPROVALS_PATH,
  AFFILIATE_CMS_PATH,
  AFFILIATE_CMS_PAYOUTS_PATH,
  AFFILIATE_CMS_STRIPE_PATH,
  AFFILIATE_CMS_TIERS_PATH,
  AFFILIATE_MANUAL_PAYOUT_CHANNELS,
  AFFILIATE_MANUAL_PAYOUT_NOTE_MAX_LENGTH,
  AFFILIATE_MANUAL_PAYOUT_REFERENCE_MAX_LENGTH,
  AFFILIATE_PAYOUT_METHODS,
  AFFILIATE_TIER_GOAL_MAX_LENGTH,
} from '@nextblock-cms/affiliates';
import {
  getAffiliateTierById,
  normalizeAffiliateUuid,
  type AffiliateRepositoryClient,
} from '@nextblock-cms/affiliates/server';
import { requireCmsAdmin } from '../../../lib/auth/cms-actor';
import { AFFILIATE_ADMIN_ALERT_TYPES, toAffiliateAdminClient } from '../../../lib/affiliates/admin-data';
import {
  evictAffiliateProgramSettingsCache,
  evictAffiliateStorefrontCache,
  evictAffiliateTiersCache,
} from '../../../lib/affiliates/cache';
import {
  releaseAffiliatePayoutNow,
  retryAffiliatePayoutNow,
  runAffiliatePayoutCycleNow,
} from '../../../lib/affiliates/payout-runner';
import {
  cancelManualAffiliatePayoutNow,
  prepareManualAffiliatePayoutNow,
  prepareManualAffiliatePayPalPayoutsNow,
  recordManualAffiliatePayoutNow,
} from '../../../lib/affiliates/manual-payouts';
import { testAffiliateStripeSetupNow, type AffiliateStripeSetupCheck } from '../../../lib/affiliates/payout-setup';
import {
  approveAffiliateStorefront,
  changeAffiliatePartnerTier,
  reactivateAffiliatePartner,
  removeAffiliatePartner,
  requestAffiliateStorefrontChanges,
  suspendAffiliatePartner,
} from '../../../lib/affiliates/review';
import {
  AFFILIATES_SETTINGS_LIMITS,
  isAffiliateTermsUrlBuiltIn,
  normalizeAffiliateNotificationEmail,
  parseAffiliateTermsUrl,
  saveAffiliatesSettings,
} from '../../../lib/affiliates/settings';
import { z } from '../../../lib/zod-config';
import { formatAdminMoney, formatAdminRate } from './components/format';

/**
 * Server actions of the /cms/affiliates screens.
 *
 * Each export is a public POST endpoint reachable from any route, so each one calls
 * `requireCmsAdmin()` (session, enrolled second factor, ADMIN role) BEFORE it validates or reads
 * anything, then works with the service-role client that call returns. None takes an actor or a
 * client: the reviewer is the verified admin, and every target id is named for what it targets
 * (`pageIdToApprove`, `payoutIdToRetry`, …) and re-validated here. Input is parsed with strict zod
 * schemas (unknown keys refused, every string and number bounded).
 *
 * Results are data (`{ ok: true, message } | { ok: false, error }`): Next replaces the message of
 * a thrown action error in production. Database errors are logged by code and answered with a
 * readable sentence, never echoed.
 */

export type AffiliateAdminActionResult<T extends object = Record<never, never>> =
  | ({ ok: true; message: string } & T)
  | { ok: false; error: string };

type AdminSession = { db: AffiliateRepositoryClient; userId: string };

const INVALID_INPUT = 'That request could not be read. Reload the page and try again.';
const SAVE_FAILED = 'The change could not be saved. Try again in a moment.';

/** Validation sentences shown to the admin (anything else zod reports becomes the fallback). */
const MSG = {
  tierName: 'Enter a tier name.',
  tierNameLength: 'Tier names are at most 80 characters.',
  tierNameFrLength: 'French names are at most 80 characters.',
  tierGoalLength: `Goals are at most ${AFFILIATE_TIER_GOAL_MAX_LENGTH} characters.`,
  tierGoalFrLength: `French goals are at most ${AFFILIATE_TIER_GOAL_MAX_LENGTH} characters.`,
  tierGoalFrAlone: 'Write the English goal too: a French goal alone would show on French pages only.',
  slugLength: 'Slugs are at most 64 characters.',
  commission: 'The commission is between 0 and 100 %.',
  cookieDays: 'The referral window is 1 to 365 days.',
  clearanceDays: 'The clearance hold is 0 to 365 days.',
  capRange: 'The partner cap is a whole number from 0 to 1,000,000 (leave it empty for unlimited).',
  sortOrder: 'The sort order is a whole number from -10,000 to 10,000.',
  noteRequired: 'Write a note telling the partner what to change.',
  noteLength: 'Keep the note under 2,000 characters.',
  reasonLength: 'Keep the reason under 500 characters.',
  minPayoutSmall: 'The minimum payout is too small for a Stripe transfer.',
  minPayoutLarge: 'The minimum payout is too large.',
  referenceRequired: 'Enter the PayPal transaction ID, e-Transfer reference or bank reference.',
  referenceLength: `Keep the reference under ${AFFILIATE_MANUAL_PAYOUT_REFERENCE_MAX_LENGTH} characters.`,
  payoutNoteLength: `Keep the note under ${AFFILIATE_MANUAL_PAYOUT_NOTE_MAX_LENGTH} characters.`,
} as const;

const OWN_VALIDATION_MESSAGES: ReadonlySet<string> = new Set<string>(Object.values(MSG));

async function authorizeAdmin(): Promise<{ ok: true; session: AdminSession } | { ok: false; error: string }> {
  try {
    const { supabase, userId } = await requireCmsAdmin();
    return { ok: true, session: { db: toAffiliateAdminClient(supabase), userId } };
  } catch (error) {
    const forbidden = error instanceof Error && error.message === 'Forbidden';
    return {
      ok: false,
      error: forbidden
        ? 'Only administrators can manage the affiliate program.'
        : 'Your session has expired or needs its second factor. Sign in again to continue.',
    };
  }
}

function logFailure(operation: string, error: unknown): void {
  const code =
    error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : null;
  console.error(`[affiliates] ${operation} failed`, { code });
}

function dbErrorCode(error: unknown): string | null {
  return error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null;
}

function revalidateAffiliateScreens(...paths: string[]): void {
  for (const path of new Set([AFFILIATE_CMS_PATH, ...paths])) {
    try {
      revalidatePath(path);
    } catch (error) {
      logFailure(`revalidate ${path}`, error);
    }
  }
}

/** The CMS chrome (sidebar badge, alert banner) is rendered by the /cms layout. */
function revalidateCmsChrome(): void {
  try {
    revalidatePath('/cms', 'layout');
  } catch (error) {
    logFailure('revalidate the CMS layout', error);
  }
}

/** A Postgres-shaped uuid (any version: ids come from `gen_random_uuid()` but fixtures vary). */
const idSchema = z
  .string()
  .trim()
  .max(64)
  .refine((value) => normalizeAffiliateUuid(value) !== null, 'Invalid id')
  .transform((value) => normalizeAffiliateUuid(value) as string);

const draftVersionSchema = z.number().int().min(1).max(2_147_483_647);

/* ------------------------------------------------------------------------- tiers --- */

const TIER_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A slug from a tier name: lowercase ASCII words joined by dashes ('Élite 50 %' → 'elite-50'). */
function slugifyTierName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return slug || 'tier';
}

/**
 * A tier goal ('' clears it). It renders as one line on /partners, so every whitespace run (a
 * pasted line break, a double space) becomes one space before the length check.
 */
function tierGoalSchema(lengthMessage: string) {
  return z
    .string()
    .overwrite((value) => value.replace(/\s+/g, ' ').trim())
    .max(AFFILIATE_TIER_GOAL_MAX_LENGTH, lengthMessage);
}

const tierInputSchema = z
  .object({
    /** Null or absent creates a tier. */
    tierIdToUpdate: idSchema.nullable().optional(),
    name: z.string().trim().min(1, MSG.tierName).max(80, MSG.tierNameLength),
    nameFr: z.string().trim().max(80, MSG.tierNameFrLength).optional(),
    /** Required, so a client that does not know the field is refused instead of wiping the goal. */
    goal: tierGoalSchema(MSG.tierGoalLength),
    goalFr: tierGoalSchema(MSG.tierGoalFrLength),
    /** Blank derives one from the name. */
    slug: z.string().trim().toLowerCase().max(64, MSG.slugLength).optional(),
    commissionPercentage: z.number(MSG.commission).finite(MSG.commission).min(0, MSG.commission).max(100, MSG.commission),
    cookieDurationDays: z.number(MSG.cookieDays).int(MSG.cookieDays).min(1, MSG.cookieDays).max(365, MSG.cookieDays),
    clearanceHoldDays: z.number(MSG.clearanceDays).int(MSG.clearanceDays).min(0, MSG.clearanceDays).max(365, MSG.clearanceDays),
    maxAmbassadorsCap: z.number(MSG.capRange).int(MSG.capRange).min(0, MSG.capRange).max(1_000_000, MSG.capRange).nullable(),
    isLimitedTimePromo: z.boolean(),
    isDefaultSignupTier: z.boolean(),
    badgeColor: z.enum(AFFILIATE_BADGE_COLORS),
    sortOrder: z.number(MSG.sortOrder).int(MSG.sortOrder).min(-10_000, MSG.sortOrder).max(10_000, MSG.sortOrder),
    isActive: z.boolean(),
  })
  .strict();

export interface UpsertAffiliateTierInput {
  tierIdToUpdate?: string | null;
  name: string;
  nameFr?: string;
  /** The goal shown under the tier on /partners, in English. Display only; '' clears it. */
  goal: string;
  /** Its French translation; '' falls back to the English goal. Refused without `goal`. */
  goalFr: string;
  slug?: string;
  commissionPercentage: number;
  cookieDurationDays: number;
  clearanceHoldDays: number;
  maxAmbassadorsCap: number | null;
  isLimitedTimePromo: boolean;
  isDefaultSignupTier: boolean;
  badgeColor: (typeof AFFILIATE_BADGE_COLORS)[number];
  sortOrder: number;
  isActive: boolean;
}

/**
 * The first validation message when it is one of ours (zod's defaults read like developer text:
 * "Too small: expected string to have >=1 characters"), else the fallback sentence.
 */
function firstIssue(error: { issues: ReadonlyArray<{ message: string }> }, fallback: string): string {
  const message = error.issues[0]?.message;
  return message && OWN_VALIDATION_MESSAGES.has(message) ? message : fallback;
}

/**
 * A tier translations map (`name_translations`, `goal_translations`) with its French entry set to
 * `fr`, or removed when `fr` is blank. The CMS edits French only, so every other two-letter locale
 * is kept, trimmed and cut to `maxLength`.
 */
function mergeTierTranslations(existing: unknown, fr: string, maxLength: number): Record<string, string> {
  const translations: Record<string, string> = {};
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    for (const [locale, value] of Object.entries(existing as Record<string, unknown>)) {
      if (/^[a-z]{2}$/.test(locale) && typeof value === 'string' && value.trim()) {
        translations[locale] = value.trim().slice(0, maxLength);
      }
    }
  }
  if (fr) translations['fr'] = fr;
  else delete translations['fr'];
  return translations;
}

/**
 * Create or edit a commission tier (every column but `member_count`, which a trigger keeps).
 * A changed rate or hold applies to orders paid from now on: each attributed order stores its
 * partner's rate and hold when it is paid (02035), and recorded commissions keep their snapshot.
 */
export async function upsertAffiliateTier(
  input: UpsertAffiliateTierInput
): Promise<AffiliateAdminActionResult<{ tierId: string }>> {
  const auth = await authorizeAdmin();
  if (!auth.ok) return auth;

  const parsed = tierInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error, 'Check the tier fields and try again.') };
  const values = parsed.data;
  if (values.goalFr && !values.goal) return { ok: false, error: MSG.tierGoalFrAlone };

  const slug = values.slug ? values.slug : slugifyTierName(values.name);
  if (!TIER_SLUG_PATTERN.test(slug)) {
    return { ok: false, error: 'Slugs use lowercase letters, digits and single dashes (for example founding-ambassador).' };
  }

  const { db } = auth.session;
  const tierId = values.tierIdToUpdate ?? null;

  try {
    let existingTranslations: unknown = {};
    let existingGoalTranslations: unknown = {};
    let memberCount = 0;
    if (tierId) {
      const existing = await getAffiliateTierById(db, tierId);
      if (!existing) return { ok: false, error: 'That tier no longer exists. Reload the page.' };
      existingTranslations = existing.name_translations;
      // Absent on a row read before 02033 ran: then there is no other locale to keep.
      existingGoalTranslations = existing.goal_translations ?? {};
      memberCount = existing.member_count;
    }

    const row = {
      name: values.name,
      name_translations: mergeTierTranslations(existingTranslations, values.nameFr ?? '', 80),
      // Display only: no SQL reads it, and reaching a goal moves nobody (tier changes stay manual).
      goal: values.goal || null,
      // A blank goal hides the goal line in every language, so it clears the translations too
      // (a translation never stands alone: goalFr without goal is refused above).
      goal_translations: values.goal
        ? mergeTierTranslations(existingGoalTranslations, values.goalFr, AFFILIATE_TIER_GOAL_MAX_LENGTH)
        : {},
      slug,
      commission_percentage: Math.round(values.commissionPercentage * 100) / 100,
      cookie_duration_days: values.cookieDurationDays,
      clearance_hold_days: values.clearanceHoldDays,
      max_ambassadors_cap: values.maxAmbassadorsCap,
      is_limited_time_promo: values.isLimitedTimePromo,
      is_default_signup_tier: values.isDefaultSignupTier,
      badge_color: values.badgeColor,
      sort_order: values.sortOrder,
      is_active: values.isActive,
    };

    let savedId: string | null = null;
    if (tierId) {
      const { data, error } = await db.from('affiliate_tiers').update(row).eq('id', tierId).select('id');
      if (error) return tierWriteFailure('update tier', error, slug);
      const first = Array.isArray(data) ? (data[0] as { id?: unknown } | undefined) : undefined;
      savedId = typeof first?.id === 'string' ? first.id : null;
      if (!savedId) return { ok: false, error: 'That tier no longer exists. Reload the page.' };
    } else {
      const { data, error } = await db.from('affiliate_tiers').insert(row).select('id').single();
      if (error) return tierWriteFailure('create tier', error, slug);
      const id = (data as { id?: unknown } | null)?.id;
      savedId = typeof id === 'string' ? id : null;
      if (!savedId) return { ok: false, error: SAVE_FAILED };
    }

    // Tier names, badges and spots appear on /partners and on every storefront.
    evictAffiliateTiersCache('action');
    evictAffiliateStorefrontCache(null, 'action');
    revalidateAffiliateScreens(AFFILIATE_CMS_TIERS_PATH);

    const full = values.maxAmbassadorsCap !== null && memberCount >= values.maxAmbassadorsCap;
    const message = tierId
      ? full && memberCount > 0
        ? `${values.name} saved. It is now full (${memberCount} partners, cap ${values.maxAmbassadorsCap}), so new partners join another tier.`
        : `${values.name} saved.`
      : `${values.name} created.`;
    return { ok: true, message, tierId: savedId };
  } catch (error) {
    logFailure('save tier', error);
    return { ok: false, error: SAVE_FAILED };
  }
}

function tierWriteFailure(operation: string, error: unknown, slug: string): { ok: false; error: string } {
  logFailure(operation, error);
  const code = dbErrorCode(error);
  if (code === '23505') return { ok: false, error: `Another tier already uses the slug "${slug}". Pick a different one.` };
  if (code === '23514') return { ok: false, error: 'One of the values is out of range. Check the fields and try again.' };
  return { ok: false, error: SAVE_FAILED };
}

const deleteTierSchema = z.object({ tierIdToDelete: idSchema }).strict();

export interface DeleteAffiliateTierInput {
  tierIdToDelete: string;
}

/** Delete an empty tier. A tier with partners is refused: move them or deactivate the tier instead. */
export async function deleteAffiliateTier(input: DeleteAffiliateTierInput): Promise<AffiliateAdminActionResult> {
  const auth = await authorizeAdmin();
  if (!auth.ok) return auth;

  const parsed = deleteTierSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: INVALID_INPUT };

  const { db } = auth.session;
  const inUse = (count: number) =>
    `${count === 1 ? '1 partner is' : `${count} partners are`} in this tier. Move them to another tier, or deactivate the tier instead of deleting it.`;

  try {
    const tier = await getAffiliateTierById(db, parsed.data.tierIdToDelete);
    if (!tier) return { ok: false, error: 'That tier no longer exists. Reload the page.' };
    if (tier.member_count > 0) return { ok: false, error: inUse(tier.member_count) };

    const { data, error } = await db.from('affiliate_tiers').delete().eq('id', tier.id).select('id');
    if (error) {
      logFailure('delete tier', error);
      // The profiles foreign key (ON DELETE RESTRICT) is the last word on "in use".
      if (dbErrorCode(error) === '23503') return { ok: false, error: inUse(Math.max(1, tier.member_count)) };
      return { ok: false, error: SAVE_FAILED };
    }
    if (!Array.isArray(data) || data.length === 0) return { ok: false, error: 'That tier no longer exists. Reload the page.' };

    evictAffiliateTiersCache('action');
    evictAffiliateStorefrontCache(null, 'action');
    revalidateAffiliateScreens(AFFILIATE_CMS_TIERS_PATH);
    return { ok: true, message: `${tier.name} deleted.` };
  } catch (error) {
    logFailure('delete tier', error);
    return { ok: false, error: SAVE_FAILED };
  }
}

/* ------------------------------------------------------------------- approvals --- */

const approveSchema = z
  .object({
    pageIdToApprove: idSchema,
    expectedDraftVersion: draftVersionSchema,
    // sha256 hex of the profile snapshot the review screen showed (`fingerprintAffiliatePublishedProfile`).
    expectedProfileFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export interface ApproveAffiliateStorefrontActionInput {
  pageIdToApprove: string;
  expectedDraftVersion: number;
  /** The review screen's `profileFingerprint`: Approve is refused if the profile changed since. */
  expectedProfileFingerprint: string;
}

/** Approve & Publish the submitted storefront (see `lib/affiliates/review.ts`). */
export async function approveAffiliateStorefrontAction(
  input: ApproveAffiliateStorefrontActionInput
): Promise<AffiliateAdminActionResult<{ handle: string }>> {
  const auth = await authorizeAdmin();
  if (!auth.ok) return auth;

  const parsed = approveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: INVALID_INPUT };

  const result = await approveAffiliateStorefront(
    {
      pageIdToApprove: parsed.data.pageIdToApprove,
      expectedDraftVersion: parsed.data.expectedDraftVersion,
      expectedProfileFingerprint: parsed.data.expectedProfileFingerprint,
      reviewerUserId: auth.session.userId,
    },
    auth.session.db
  );
  if (!result.ok) return { ok: false, error: result.error };

  revalidateAffiliateScreens(AFFILIATE_CMS_APPROVALS_PATH, `${AFFILIATE_CMS_APPROVALS_PATH}/${result.pageId}`);
  revalidateCmsChrome();

  const removed =
    result.issues.length > 0
      ? ` The sanitizer removed or adjusted ${result.issues.length === 1 ? '1 element' : `${result.issues.length} elements`} that storefronts do not allow.`
      : '';
  const message = result.firstPublication
    ? `@${result.handle} is live. Their storefront is public and they can now earn commissions.${removed}`
    : `@${result.handle}'s storefront update is live.${removed}`;
  return { ok: true, message, handle: result.handle };
}

const requestChangesSchema = z
  .object({
    pageIdToReview: idSchema,
    note: z.string().trim().min(1, 'Write a note telling the partner what to change.').max(2000, 'Keep the note under 2,000 characters.'),
    expectedDraftVersion: draftVersionSchema,
  })
  .strict();

export interface RequestAffiliateStorefrontChangesActionInput {
  pageIdToReview: string;
  note: string;
  expectedDraftVersion: number;
}

/** Send the storefront back to the partner with a note (the live version stays published). */
export async function requestAffiliateStorefrontChangesAction(
  input: RequestAffiliateStorefrontChangesActionInput
): Promise<AffiliateAdminActionResult<{ handle: string }>> {
  const auth = await authorizeAdmin();
  if (!auth.ok) return auth;

  const parsed = requestChangesSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error, INVALID_INPUT) };

  const result = await requestAffiliateStorefrontChanges(
    {
      pageIdToReview: parsed.data.pageIdToReview,
      note: parsed.data.note,
      expectedDraftVersion: parsed.data.expectedDraftVersion,
      reviewerUserId: auth.session.userId,
    },
    auth.session.db
  );
  if (!result.ok) return { ok: false, error: result.error };

  revalidateAffiliateScreens(AFFILIATE_CMS_APPROVALS_PATH, `${AFFILIATE_CMS_APPROVALS_PATH}/${result.pageId}`);
  revalidateCmsChrome();
  // The public sandbox sends no email (lib/affiliates/notify.ts mails nobody there): only the portal shows the note.
  const message =
    process.env.NEXT_PUBLIC_IS_SANDBOX === 'true'
      ? `Changes requested. @${result.handle} sees your note in their portal (the sandbox sends no email).`
      : `Changes requested. @${result.handle} will get your note by email.`;
  return { ok: true, message, handle: result.handle };
}

/* -------------------------------------------------------------------- partners --- */

/**
 * The public sandbox's demo partners (Studio Nova, signed in as partner@nextblock.dev) are shared
 * by every visitor, and its admin login is published: one visitor pausing, resuming, removing or
 * moving a partner would change the demo for everyone until the next reset (a removed demo
 * partner's storefront and seat only come back with it). So on the sandbox every partner status,
 * tier or removal change is refused right after the admin check, before its input is read or
 * anything is written. Reviews, tiers, settings and payouts are not affected. The overview,
 * approvals and review pages show the same sentence beside these controls and disable them.
 */
const PARTNER_ACCOUNTS_LOCKED_IN_SANDBOX = "Partner accounts can't be changed in the sandbox: every visitor shares them.";

function partnerAccountsLockedInSandbox(): boolean {
  return process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';
}

const suspendSchema = z
  .object({
    affiliateIdToUpdate: idSchema,
    reason: z.string().trim().max(500, 'Keep the reason under 500 characters.').nullable().optional(),
  })
  .strict();

export interface SuspendAffiliatePartnerActionInput {
  affiliateIdToUpdate: string;
  reason?: string | null;
}

/** "Pause partner" (status SUSPENDED): storefront offline, referral links stop earning, no payouts. */
export async function suspendAffiliatePartnerAction(
  input: SuspendAffiliatePartnerActionInput
): Promise<AffiliateAdminActionResult> {
  const auth = await authorizeAdmin();
  if (!auth.ok) return auth;
  if (partnerAccountsLockedInSandbox()) return { ok: false, error: PARTNER_ACCOUNTS_LOCKED_IN_SANDBOX };

  const parsed = suspendSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error, INVALID_INPUT) };

  const result = await suspendAffiliatePartner(
    { affiliateIdToUpdate: parsed.data.affiliateIdToUpdate, reason: parsed.data.reason ?? null },
    auth.session.db
  );
  if (!result.ok) return { ok: false, error: result.error };

  revalidateAffiliateScreens(AFFILIATE_CMS_APPROVALS_PATH);
  // Before a first approval nothing of theirs is public and nothing earns: only the portal locks.
  return {
    ok: true,
    message: result.isApproved
      ? `@${result.handle} is paused. Their storefront is offline and their referral links stop earning.`
      : `@${result.handle} is paused. They can't edit or submit their storefront until you resume them.`,
  };
}

const partnerIdSchema = z.object({ affiliateIdToUpdate: idSchema }).strict();

export interface ReactivateAffiliatePartnerActionInput {
  affiliateIdToUpdate: string;
}

/** "Resume partner" (status ACTIVE): the last approved storefront is back online, links earn again. */
export async function reactivateAffiliatePartnerAction(
  input: ReactivateAffiliatePartnerActionInput
): Promise<AffiliateAdminActionResult> {
  const auth = await authorizeAdmin();
  if (!auth.ok) return auth;
  if (partnerAccountsLockedInSandbox()) return { ok: false, error: PARTNER_ACCOUNTS_LOCKED_IN_SANDBOX };

  const parsed = partnerIdSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: INVALID_INPUT };

  const result = await reactivateAffiliatePartner({ affiliateIdToUpdate: parsed.data.affiliateIdToUpdate }, auth.session.db);
  if (!result.ok) return { ok: false, error: result.error };

  revalidateAffiliateScreens(AFFILIATE_CMS_APPROVALS_PATH);
  return { ok: true, message: `@${result.handle} is active again.` };
}

const removePartnerSchema = z
  .object({
    affiliateIdToRemove: idSchema,
    // The handle the admin typed (3–32 characters, maybe with an `@`); compared in review.ts.
    confirmHandle: z.string().trim().min(1).max(80),
  })
  .strict();

export interface RemoveAffiliatePartnerActionInput {
  affiliateIdToRemove: string;
  /** The partner's handle, typed by the admin to confirm. */
  confirmHandle: string;
}

/**
 * "Remove partner": delete a partner account that never earned (see `removeAffiliatePartner`).
 * A partner with commission or payout history is paused instead (`removed: false`). The sign-in
 * account stays (back to a customer), and so do the Stripe Connect account and the uploads.
 */
export async function removeAffiliatePartnerAction(
  input: RemoveAffiliatePartnerActionInput
): Promise<AffiliateAdminActionResult<{ removed: boolean }>> {
  const auth = await authorizeAdmin();
  if (!auth.ok) return auth;
  if (partnerAccountsLockedInSandbox()) return { ok: false, error: PARTNER_ACCOUNTS_LOCKED_IN_SANDBOX };

  const parsed = removePartnerSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: INVALID_INPUT };

  const result = await removeAffiliatePartner(
    { affiliateIdToRemove: parsed.data.affiliateIdToRemove, confirmHandle: parsed.data.confirmHandle },
    auth.session.db
  );
  if (!result.ok) {
    // A failure after the pause still changed the partner: the screens show it paused.
    if (result.code === 'remove_failed') revalidateAffiliateScreens(AFFILIATE_CMS_APPROVALS_PATH);
    return { ok: false, error: result.error };
  }

  revalidateAffiliateScreens(AFFILIATE_CMS_APPROVALS_PATH, AFFILIATE_CMS_TIERS_PATH);
  revalidateCmsChrome();

  const name = result.displayName.trim() || `@${result.handle}`;
  if (!result.removed) {
    const message =
      result.keptBecause === 'unavailable'
        ? `${name}'s commission and payout records could not be checked, so they were paused instead of removed. Try again in a moment.`
        : `${name} has commission or payout history, so they were paused instead of removed.`;
    return { ok: true, message, removed: false };
  }
  const roleNote = result.roleDemoted
    ? ''
    : ' Their account still has the partner role: change it to User on the Users screen.';
  return {
    ok: true,
    message: `${name} was removed. Their storefront is gone and their account is a customer account again.${roleNote}`,
    removed: true,
  };
}

const changeTierSchema = z
  .object({
    affiliateIdToUpdate: idSchema,
    tierIdToAssign: idSchema,
    /** Into a capped tier that is full (the cap limits public sign-ups, not the operator). */
    allowOverCap: z.boolean().optional(),
    /** Email the partner once the move went through. */
    notifyPartner: z.boolean().optional(),
  })
  .strict();

export interface ChangeAffiliatePartnerTierActionInput {
  affiliateIdToUpdate: string;
  tierIdToAssign: string;
  /** "Assign over the cap": move into a full capped tier anyway. Default false. */
  allowOverCap?: boolean;
  /** "Email the partner": a TIER_CHANGED notice once the move went through. Default false. */
  notifyPartner?: boolean;
}

/**
 * Refusals that mean the screen was out of date when the admin pressed Move: since the page loaded
 * the tier filled up (public sign-ups into a capped tier, another admin's move), was deactivated
 * or deleted, or the partner is gone.
 */
const STALE_TIER_MOVE_REFUSALS: ReadonlySet<string> = new Set(['tier_full', 'tier_inactive', 'tier_not_found', 'partner_missing']);

/** The overview and the approvals list show the tier, every review page the Partner card, and the Tiers screen the member counts. */
function revalidateTierMoveScreens(): void {
  revalidateAffiliateScreens(AFFILIATE_CMS_APPROVALS_PATH, AFFILIATE_CMS_TIERS_PATH);
  try {
    revalidatePath(`${AFFILIATE_CMS_APPROVALS_PATH}/[pageId]`, 'page');
  } catch (error) {
    logFailure('revalidate the storefront review pages', error);
  }
}

/**
 * "Change tier": move a partner to another tier, paused or not (see `changeAffiliatePartnerTier`).
 * Orders paid from now on earn the new tier's rate; commissions already recorded keep theirs.
 */
export async function changeAffiliatePartnerTierAction(
  input: ChangeAffiliatePartnerTierActionInput
): Promise<AffiliateAdminActionResult> {
  const auth = await authorizeAdmin();
  if (!auth.ok) return auth;
  if (partnerAccountsLockedInSandbox()) return { ok: false, error: PARTNER_ACCOUNTS_LOCKED_IN_SANDBOX };

  const parsed = changeTierSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: INVALID_INPUT };

  const result = await changeAffiliatePartnerTier(
    {
      affiliateIdToUpdate: parsed.data.affiliateIdToUpdate,
      tierIdToAssign: parsed.data.tierIdToAssign,
      allowOverCap: parsed.data.allowOverCap === true,
      notifyPartner: parsed.data.notifyPartner === true,
    },
    auth.session.db
  );
  if (!result.ok) {
    // A stale screen: re-render it in this action's response, so the open dialog shows the tiers as
    // they are now (a tier that filled up gets its "Assign over the cap" box, the selection kept)
    // instead of the list the page loaded with, which would refuse the same way on every retry.
    if (STALE_TIER_MOVE_REFUSALS.has(result.code)) revalidateTierMoveScreens();
    return { ok: false, error: result.error };
  }

  if (result.unchanged) return { ok: true, message: `${result.partnerName} is already in ${result.tierName}.` };

  revalidateTierMoveScreens();
  return {
    ok: true,
    message: `${result.partnerName} moved to ${result.tierName}. Orders paid from now on earn ${formatAdminRate(result.ratePercent)}.`,
  };
}

/* --------------------------------------------------------------------- payouts --- */

/**
 * Readable sentences for the machine codes of a refused payout action (the lib's
 * `AffiliatePayoutActionError`, plus the runner's package / sandbox / configuration refusals).
 */
const PAYOUT_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  invalid_id: INVALID_INPUT,
  not_found: 'That payout no longer exists. Reload the page.',
  not_failed: 'Only a failed payout can be retried or released. Reload the page to see its current state.',
  in_flight: 'This payout is being transferred right now. Reload the page in 15 minutes to see how it ended.',
  transfer_exists:
    'Stripe already has a transfer for this payout, so nothing new was sent or released. It is recorded as completed; check the payout alert if the amounts differ.',
  reconcile_failed: 'Stripe could not be checked for an earlier transfer, so nothing was sent. Try again in a few minutes.',
  stripe_error: 'Stripe could not be reached, so nothing was sent. Try again in a few minutes.',
  stripe_unavailable: 'Stripe could not be reached, so nothing was sent. Try again in a few minutes.',
  stripe_authentication: 'Stripe refused the API key. Check the Stripe keys under Payments.',
  not_eligible: 'The partner cannot be paid right now: they are paused, not approved yet, or their Stripe account changed.',
  account_not_ready: 'The partner’s Stripe account cannot receive transfers yet. They need to finish Stripe onboarding.',
  balance_insufficient: 'The Stripe balance is too low for this transfer. Top up the platform balance, then retry.',
  nothing_to_pay: 'Nothing is left to pay on this payout (its commissions were refunded), so it was closed.',
  below_minimum:
    'What is left on this payout after refunds is below the minimum payout, so nothing was sent. Its commissions went back to the cleared balance for a later run.',
  other_mode:
    'This payout was made with the other Stripe key (test or live). Switch back to that key to retry or release it.',
  manual_payout: 'This is a manual payout: record it or cancel it under Pay manually. It is never retried or released through Stripe.',
  paypal_payout:
    'This is a PayPal payout: PayPal settles it, so it is never retried or released through Stripe. Cancel an unclaimed one on the PayPal payouts screen.',
  transfer_failed: 'Stripe refused the transfer. The payout shows the reason Stripe gave.',
  sandbox: 'Payouts are disabled in the sandbox.',
  stripe_not_configured: 'Stripe is not configured, so no transfer can be sent. Add the Stripe keys under Payments first.',
  unavailable: 'Stripe could not be reached, so nothing was sent. Try again in a few minutes.',
  package_inactive: 'The affiliate program is paused: it needs both the Affiliates package and Commerce Pro to be active.',
  settings_unavailable: 'The program settings could not be read, so nothing was sent. Try again in a few minutes.',
  disabled: 'Automated payouts are turned off in the program settings.',
  already_running: 'A payout run is already in progress. Try again in a few minutes.',
  forbidden: 'Only administrators can manage the affiliate program.',
  unknown: 'The payout request did not go through. Check the payouts screen and try again.',
};

/**
 * A released payout's commissions go back to the cleared balance: the next Stripe run pays the ones
 * still paid through Stripe, and the ones now paid by hand (02036) join Pay manually.
 */
const RELEASED_MESSAGE =
  'Payout released. Its commissions go back to the cleared balance: the next Stripe run pays the ones paid through Stripe, and the ones paid manually appear under Pay manually.';

/** What a successful retry / release did (`AffiliatePayoutActionResult.outcome`). */
const PAYOUT_OUTCOME_MESSAGES: Readonly<Record<string, string>> = {
  sent: 'Transfer sent. The payout is completed.',
  completed: 'Stripe already had a transfer for this payout, so it is now recorded as completed.',
  pending: 'Stripe has not confirmed the transfer yet. The payout stays processing and the next run checks it again.',
  released: RELEASED_MESSAGE,
};

const PAYOUT_FALLBACK_ERROR = PAYOUT_ERROR_MESSAGES['unknown'] as string;
const MACHINE_CODE = /^[a-z][a-z0-9_]{0,63}$/;

function machineCode(value: unknown): string | null {
  return typeof value === 'string' && MACHINE_CODE.test(value) ? value : null;
}

function readCount(record: Record<string, unknown>, key: string): number {
  const value = Number(record[key]);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** "3 payouts sent, 1 failed": the figures of a cycle summary that are worth a toast. */
function describeCycleSummary(summary: Record<string, unknown>): string | null {
  const sent = readCount(summary, 'sent');
  const failed = readCount(summary, 'failed');
  const pending = readCount(summary, 'pending');
  const promoted = readCount(summary, 'promoted');
  const short = readCount(summary, 'skippedInsufficientBalance');
  const hasFigures = ['sent', 'failed', 'pending', 'claimed', 'promoted'].some((key) => key in summary);
  if (!hasFigures) return null;

  const parts = [`${sent} ${sent === 1 ? 'payout' : 'payouts'} sent`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (pending > 0) parts.push(`${pending} still processing`);
  if (promoted > 0) parts.push(`${promoted} ${promoted === 1 ? 'commission' : 'commissions'} cleared`);
  if (short > 0) parts.push(`${short} waiting for Stripe balance`);
  const errors = Array.isArray(summary['errors']) ? summary['errors'].length : 0;
  const errorNote = errors > 0 ? ` ${errors === 1 ? 'One step' : `${errors} steps`} failed and will be retried; the server log has the details.` : '';
  return `Payout run finished: ${parts.join(', ')}.${errorNote}`;
}

/**
 * The payout runner's answer as an action result. The runner speaks in machine codes (`{ ok,
 * outcome }`, `{ ok: false, error, reason }`, or a cycle summary); only known codes become
 * sentences, and free text is never shown (it could quote a provider or database error).
 */
function describePayoutOutcome(outcome: unknown, successMessage: string): AffiliateAdminActionResult {
  if (outcome === false) return { ok: false, error: PAYOUT_FALLBACK_ERROR };
  if (!outcome || typeof outcome !== 'object') return { ok: true, message: successMessage };

  const record = outcome as Record<string, unknown>;
  if (record['ok'] === false) {
    const code = machineCode(record['error']) ?? machineCode(record['code']) ?? machineCode(record['reason']);
    const base = (code && PAYOUT_ERROR_MESSAGES[code]) || PAYOUT_FALLBACK_ERROR;
    // Stripe's refusal code (`balance_insufficient`, `account_closed`, …) is a fixed vocabulary.
    const stripeCode = code === 'transfer_failed' ? machineCode(record['reason']) : null;
    return { ok: false, error: stripeCode ? `${base} (${stripeCode})` : base };
  }

  const outcomeCode = machineCode(record['outcome']);
  if (outcomeCode && PAYOUT_OUTCOME_MESSAGES[outcomeCode]) return { ok: true, message: PAYOUT_OUTCOME_MESSAGES[outcomeCode] };

  // The run's PayPal step (02037), when it ran: appended to whatever the Stripe side says.
  const paypal = describePayPalRun(record['paypal']);
  const withPayPal = (text: string) => (paypal ? `${text} ${paypal}` : text);

  // A cycle that did not run (`skipped`: sandbox, no Stripe, unavailable) or stopped early. Without
  // Stripe the ledger repair still ran (02036): say what it cleared.
  const skipped = machineCode(record['skipped']);
  if (skipped) {
    const base = PAYOUT_ERROR_MESSAGES[skipped] ?? PAYOUT_FALLBACK_ERROR;
    const checked = skipped === 'stripe_not_configured' || skipped === 'unavailable' ? describeLedgerRepair(record) : null;
    return { ok: false, error: withPayPal(checked ? `${base} ${checked}` : base) };
  }
  // No gateway's commissions are paid through Stripe: the run was the ledger repair alone (and the
  // PayPal step when some gateway is paid with PayPal).
  if (record['stripeTransfers'] === 'not_needed') {
    const checked = describeLedgerRepair(record) ?? 'No commission was due to clear.';
    const paypalRouted = paypalGatewayCount(record['paypal']) > 0;
    return {
      ok: true,
      message: paypal
        ? `${checked} No commission is paid through Stripe, so nothing was sent through Stripe. ${paypal}`
        : paypalRouted
          ? `${checked} No commission is paid through Stripe, so nothing was sent through Stripe. PayPal: no payout was due.`
          : `${checked} Every commission is paid manually, so nothing was sent through Stripe: prepare, send and record each payout under Pay manually.`,
    };
  }
  const summaryRecord = asRecord(record['summary']) ?? record;
  const aborted = machineCode(summaryRecord['aborted']);
  if (aborted) {
    const sentBeforeStop = readCount(summaryRecord, 'sent');
    const partial =
      sentBeforeStop > 0 ? ` ${sentBeforeStop === 1 ? '1 payout was' : `${sentBeforeStop} payouts were`} sent before the run stopped.` : '';
    return { ok: false, error: withPayPal(`${PAYOUT_ERROR_MESSAGES[aborted] ?? PAYOUT_FALLBACK_ERROR}${partial}`) };
  }

  const summary = describeCycleSummary(summaryRecord);
  return { ok: true, message: withPayPal(summary ?? successMessage) };
}

/** Why the PayPal step sent nothing new (`AffiliatePayPalRunSummary.skipped`), as a sentence. */
const PAYPAL_SKIP_MESSAGES: Readonly<Record<string, string>> = {
  not_configured: 'No PayPal payout was sent: no PayPal credentials are configured (see PayPal payouts).',
  not_enabled: 'No PayPal payout was sent: PayPal Payouts is not enabled for your PayPal app yet (see PayPal payouts).',
  credentials: 'No PayPal payout was sent: PayPal rejected the credentials (see PayPal payouts).',
  unavailable: 'No PayPal payout was sent: PayPal could not be reached. The next run tries again.',
};

/** How many gateways the run's PayPal step claims for (`AffiliatePayPalRunSummary.gateways`). */
function paypalGatewayCount(value: unknown): number {
  const paypal = asRecord(value);
  return paypal && Array.isArray(paypal['gateways']) ? paypal['gateways'].length : 0;
}

/**
 * While PayPal is in Sandbox, commissions on live sales routed to PayPal are neither sent nor listed
 * under Pay manually: the run says so instead of staying silent.
 */
const PAYPAL_SANDBOX_NOTE =
  'PayPal is in Sandbox: commissions on real (live) sales routed to PayPal are not sent and not listed under Pay manually; they wait until you save your live credentials (see PayPal payouts).';

/**
 * "PayPal: 2 payouts sent, 1 paid." for the run's PayPal step (02037), from its counts and its skip
 * code only (never PayPal's text); null when the step did not run or had nothing to say.
 */
function describePayPalRun(value: unknown): string | null {
  const paypal = asRecord(value);
  if (!paypal) return null;
  const submitted = readCount(paypal, 'submitted');
  const completed = readCount(paypal, 'completed');
  const failed = readCount(paypal, 'failed');
  const inFlight = readCount(paypal, 'inFlight');
  const pendingRetry = readCount(paypal, 'pendingRetry');
  const skipped = machineCode(paypal['skipped']);
  const skipText = skipped ? PAYPAL_SKIP_MESSAGES[skipped] ?? null : null;
  const sandboxNote = paypal['environment'] === 'sandbox' && paypalGatewayCount(paypal) > 0 ? PAYPAL_SANDBOX_NOTE : null;
  const parts: string[] = [];
  if (submitted > 0) parts.push(`${submitted} ${submitted === 1 ? 'payout' : 'payouts'} sent`);
  if (completed > 0) parts.push(`${completed} paid`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (inFlight > 0) parts.push(`${inFlight} still in flight`);
  if (pendingRetry > 0) parts.push(`${pendingRetry} waiting for PayPal's answer`);
  const errors = Array.isArray(paypal['errors']) ? paypal['errors'].length : 0;
  const errorNote = errors > 0 ? ' Some PayPal steps failed and will be retried; the server log has the details.' : '';
  if (parts.length === 0 && !skipText && !errorNote && !sandboxNote) return null;
  const figures = parts.length > 0 ? `PayPal: ${parts.join(', ')}.` : '';
  return [figures, skipText, errorNote.trim(), sandboxNote].filter(Boolean).join(' ');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** "Commissions checked: 3 cleared, 1 recorded late." for a run without Stripe (02036), or null when it did nothing. */
function describeLedgerRepair(summary: Record<string, unknown>): string | null {
  const promoted = readCount(summary, 'promoted');
  const recorded = readCount(summary, 'recorded');
  if (promoted === 0 && recorded === 0) return null;
  const parts: string[] = [];
  if (promoted > 0) parts.push(`${promoted} cleared`);
  if (recorded > 0) parts.push(`${recorded} recorded late`);
  return `Commissions checked: ${parts.join(', ')}.`;
}

/** "Run payouts now": the same cycle the daily job runs (reconcile, promote, claim, transfer). */
export async function runAffiliatePayoutsNow(): Promise<AffiliateAdminActionResult> {
  const auth = await authorizeAdmin();
  if (!auth.ok) return auth;

  let outcome: unknown;
  try {
    outcome = await runAffiliatePayoutCycleNow('admin');
  } catch (error) {
    logFailure('run payouts now', error);
    return { ok: false, error: PAYOUT_FALLBACK_ERROR };
  }

  revalidateAffiliateScreens(AFFILIATE_CMS_PAYOUTS_PATH);
  revalidateCmsChrome();
  return describePayoutOutcome(outcome, 'Payout run finished. The tables below show the result.');
}

const retrySchema = z.object({ payoutIdToRetry: idSchema }).strict();

export interface RetryAffiliatePayoutInput {
  payoutIdToRetry: string;
}

/** Retry a FAILED payout (reconciled against Stripe first, so a transfer is never sent twice). */
export async function retryAffiliatePayout(input: RetryAffiliatePayoutInput): Promise<AffiliateAdminActionResult> {
  const auth = await authorizeAdmin();
  if (!auth.ok) return auth;

  const parsed = retrySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: INVALID_INPUT };

  let outcome: unknown;
  try {
    outcome = await retryAffiliatePayoutNow(parsed.data.payoutIdToRetry);
  } catch (error) {
    logFailure('retry payout', error);
    return { ok: false, error: PAYOUT_FALLBACK_ERROR };
  }

  revalidateAffiliateScreens(AFFILIATE_CMS_PAYOUTS_PATH);
  revalidateCmsChrome();
  return describePayoutOutcome(outcome, 'Payout retried. Its status below shows the result.');
}

const releaseSchema = z.object({ payoutIdToRelease: idSchema }).strict();

export interface ReleaseAffiliatePayoutInput {
  payoutIdToRelease: string;
}

/** Release a FAILED payout: its commissions return to the partner's cleared balance for a later run. */
export async function releaseAffiliatePayout(input: ReleaseAffiliatePayoutInput): Promise<AffiliateAdminActionResult> {
  const auth = await authorizeAdmin();
  if (!auth.ok) return auth;

  const parsed = releaseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: INVALID_INPUT };

  let outcome: unknown;
  try {
    outcome = await releaseAffiliatePayoutNow(parsed.data.payoutIdToRelease);
  } catch (error) {
    logFailure('release payout', error);
    return { ok: false, error: PAYOUT_FALLBACK_ERROR };
  }

  revalidateAffiliateScreens(AFFILIATE_CMS_PAYOUTS_PATH);
  revalidateCmsChrome();
  return describePayoutOutcome(outcome, RELEASED_MESSAGE);
}

/* ------------------------------------------------------------- manual payouts --- */

/**
 * The public sandbox's demo partner is shared by every visitor (and its admin login is published):
 * no manual payout is prepared, recorded or cancelled there. Refused right after the admin check,
 * before the input is read.
 */
function manualPayoutsLockedInSandbox(): boolean {
  return process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';
}

const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/);

const prepareManualPayoutSchema = z.object({ affiliateIdToPay: idSchema, currency: currencySchema }).strict();
const preparePayPalPayoutsSchema = z.object({ currency: currencySchema }).strict();
const recordManualPayoutSchema = z
  .object({
    payoutIdToRecord: idSchema,
    channel: z.enum(AFFILIATE_MANUAL_PAYOUT_CHANNELS),
    reference: z.string().trim().min(1, MSG.referenceRequired).max(AFFILIATE_MANUAL_PAYOUT_REFERENCE_MAX_LENGTH, MSG.referenceLength),
    note: z.string().trim().max(AFFILIATE_MANUAL_PAYOUT_NOTE_MAX_LENGTH, MSG.payoutNoteLength).nullable().optional(),
  })
  .strict();
const cancelManualPayoutSchema = z.object({ payoutIdToCancel: idSchema }).strict();

export interface PrepareManualAffiliatePayoutActionInput {
  /** The partner whose commissions owed by hand are reserved. */
  affiliateIdToPay: string;
  /** The store base currency the commissions were recorded in. */
  currency: string;
}

export interface PrepareManualAffiliatePayPalPayoutsActionInput {
  currency: string;
}

export interface RecordManualAffiliatePayoutActionInput {
  /** The prepared payout whose money was sent. */
  payoutIdToRecord: string;
  channel: 'paypal' | 'interac' | 'wise' | 'bank_transfer' | 'other';
  /** The PayPal transaction ID, e-Transfer reference or bank reference (required). */
  reference: string;
  /** Visible to the partner. */
  note?: string | null;
}

export interface CancelManualAffiliatePayoutActionInput {
  payoutIdToCancel: string;
}

export type RecordManualAffiliatePayoutActionResult = { ok: true; message: string; payoutId: string } | { ok: false; error: string };

/** Readable sentences for every refusal of a manual payout write (prepare, record, cancel). */
const MANUAL_PAYOUT_ERRORS: Readonly<Record<string, string>> = {
  forbidden: 'Only administrators can manage the affiliate program.',
  sandbox: 'Payouts are disabled in the sandbox.',
  package_inactive: PAYOUT_ERROR_MESSAGES['package_inactive'] as string,
  settings_unavailable: 'The program settings could not be read, so nothing was changed. Try again in a moment.',
  not_manual:
    'No commissions are set to be paid manually. Choose "Manually" under Overview → Program settings → How partners are paid first.',
  invalid_input: INVALID_INPUT,
  not_found: 'That payout or partner no longer exists. Reload the page.',
  not_eligible: 'This partner is paused or not approved yet, so no payout is prepared for them. Resume them first.',
  nothing_owed: 'Nothing is owed to this partner in this currency anymore. Reload the page.',
  nothing_to_prepare:
    'No partner owed in this currency has a payout email and reaches the minimum payout, so no PayPal payout was prepared. Reload the page.',
  reference_required: MSG.referenceRequired,
  duplicate_reference:
    'A payout with this reference is already recorded for this partner. Check the payout history, or use the exact reference of this payment.',
  already_recorded: 'This payout is already recorded, so nothing was changed. Reload the page.',
  unknown: 'The payout could not be saved. Nothing was changed; try again in a moment.',
};

function manualPayoutError(status: string): string {
  return MANUAL_PAYOUT_ERRORS[status] ?? (MANUAL_PAYOUT_ERRORS['unknown'] as string);
}

function commissionsText(count: number): string {
  return `${count} ${count === 1 ? 'commission' : 'commissions'}`;
}

/**
 * "Prepare payout" (Pay manually, 02036): reserves what one partner is owed by hand in one currency
 * in a prepared manual payout, before any money is sent; the admin then sends exactly that amount
 * and records it. The gateways come from the program settings, never from this input.
 */
export async function prepareManualAffiliatePayoutAction(
  input: PrepareManualAffiliatePayoutActionInput
): Promise<AffiliateAdminActionResult<{ payoutId: string }>> {
  const auth = await authorizeAdmin();
  if (!auth.ok) return auth;
  if (manualPayoutsLockedInSandbox()) return { ok: false, error: manualPayoutError('sandbox') };

  const parsed = prepareManualPayoutSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: INVALID_INPUT };

  let outcome: Awaited<ReturnType<typeof prepareManualAffiliatePayoutNow>>;
  try {
    outcome = await prepareManualAffiliatePayoutNow(parsed.data);
  } catch (error) {
    logFailure('prepare manual payout', error);
    return { ok: false, error: manualPayoutError('unknown') };
  }

  revalidateAffiliateScreens(AFFILIATE_CMS_PAYOUTS_PATH, AFFILIATE_CMS_STRIPE_PATH);
  if (outcome.status === 'prepared') {
    const amount = formatAdminMoney(outcome.amountCents, parsed.data.currency);
    return {
      ok: true,
      message: `Payout prepared: ${amount} for ${commissionsText(outcome.commissionCount)}. Send exactly this amount, then record it with its reference.`,
      payoutId: outcome.payoutId,
    };
  }
  if (outcome.status === 'already_prepared') {
    const amount = formatAdminMoney(outcome.amountCents, parsed.data.currency);
    return {
      ok: false,
      error: `A payout of ${amount} is already prepared for this partner in ${parsed.data.currency}. Record it or cancel it under Prepared payouts first.`,
    };
  }
  if (outcome.status === 'below_minimum') return { ok: false, error: manualPayoutError('nothing_owed') };
  return { ok: false, error: manualPayoutError(outcome.status) };
}

/**
 * "Prepare PayPal payouts" (Pay manually, 02036): prepares a payout for every partner owed by hand
 * in one currency who has a payout email and reaches the minimum, so the PayPal payouts file can
 * list them. Nothing is sent.
 */
export async function prepareManualAffiliatePayPalPayoutsAction(
  input: PrepareManualAffiliatePayPalPayoutsActionInput
): Promise<AffiliateAdminActionResult> {
  const auth = await authorizeAdmin();
  if (!auth.ok) return auth;
  if (manualPayoutsLockedInSandbox()) return { ok: false, error: manualPayoutError('sandbox') };

  const parsed = preparePayPalPayoutsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: INVALID_INPUT };

  let outcome: Awaited<ReturnType<typeof prepareManualAffiliatePayPalPayoutsNow>>;
  try {
    outcome = await prepareManualAffiliatePayPalPayoutsNow(parsed.data);
  } catch (error) {
    logFailure('prepare PayPal payouts', error);
    return { ok: false, error: manualPayoutError('unknown') };
  }

  revalidateAffiliateScreens(AFFILIATE_CMS_PAYOUTS_PATH, AFFILIATE_CMS_STRIPE_PATH);
  if (outcome.status !== 'done') return { ok: false, error: manualPayoutError(outcome.status) };
  if (outcome.prepared === 0) {
    return { ok: false, error: 'No PayPal payout was prepared: what these partners are owed changed. Reload the page.' };
  }
  const amount = formatAdminMoney(outcome.preparedAmountCents, outcome.currency);
  const skipped = outcome.skipped > 0 ? ` ${outcome.skipped} ${outcome.skipped === 1 ? 'partner was' : 'partners were'} left out: what they are owed changed.` : '';
  const remaining =
    outcome.remaining > 0 ? ` ${outcome.remaining} more ${outcome.remaining === 1 ? 'partner waits' : 'partners wait'}: prepare again for the rest.` : '';
  return {
    ok: true,
    message: `${outcome.prepared} PayPal ${outcome.prepared === 1 ? 'payout' : 'payouts'} prepared (${amount}). Download the PayPal payouts file next.${skipped}${remaining}`,
  };
}

/**
 * "Record payout" (Pay manually, 02036): the money of a prepared payout was sent outside Stripe
 * (PayPal, Interac e-Transfer, Wise, a bank). Nothing is sent: that payout's commissions become
 * PAID and the partner gets an email. The recorder is the verified admin
 * (lib/affiliates/manual-payouts.ts reads it from the session, never from this input).
 */
export async function recordManualAffiliatePayoutAction(
  input: RecordManualAffiliatePayoutActionInput
): Promise<RecordManualAffiliatePayoutActionResult> {
  const auth = await authorizeAdmin();
  if (!auth.ok) return auth;
  if (manualPayoutsLockedInSandbox()) return { ok: false, error: manualPayoutError('sandbox') };

  const parsed = recordManualPayoutSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error, INVALID_INPUT) };

  let outcome: Awaited<ReturnType<typeof recordManualAffiliatePayoutNow>>;
  try {
    outcome = await recordManualAffiliatePayoutNow({
      payoutIdToRecord: parsed.data.payoutIdToRecord,
      channel: parsed.data.channel,
      reference: parsed.data.reference,
      note: parsed.data.note ? parsed.data.note : null,
    });
  } catch (error) {
    logFailure('record manual payout', error);
    return { ok: false, error: manualPayoutError('unknown') };
  }

  if (outcome.status === 'recorded') {
    revalidateAffiliateScreens(AFFILIATE_CMS_PAYOUTS_PATH, AFFILIATE_CMS_STRIPE_PATH);
    const amount = formatAdminMoney(outcome.amountCents, outcome.currency);
    return {
      ok: true,
      message: `Payout recorded: ${amount}, ${commissionsText(outcome.commissionCount)} marked as paid. The partner gets an email.`,
      payoutId: outcome.payoutId,
    };
  }
  if (outcome.status === 'not_found' || outcome.status === 'already_recorded') revalidateAffiliateScreens(AFFILIATE_CMS_PAYOUTS_PATH);
  return { ok: false, error: manualPayoutError(outcome.status) };
}

/**
 * "Cancel" (Pay manually, 02036): gives up a prepared payout that was never sent. Its commissions
 * go back to what is owed (a refund since it was prepared is applied first).
 */
export async function cancelManualAffiliatePayoutAction(input: CancelManualAffiliatePayoutActionInput): Promise<AffiliateAdminActionResult> {
  const auth = await authorizeAdmin();
  if (!auth.ok) return auth;
  if (manualPayoutsLockedInSandbox()) return { ok: false, error: manualPayoutError('sandbox') };

  const parsed = cancelManualPayoutSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: INVALID_INPUT };

  let outcome: Awaited<ReturnType<typeof cancelManualAffiliatePayoutNow>>;
  try {
    outcome = await cancelManualAffiliatePayoutNow(parsed.data);
  } catch (error) {
    logFailure('cancel manual payout', error);
    return { ok: false, error: manualPayoutError('unknown') };
  }

  revalidateAffiliateScreens(AFFILIATE_CMS_PAYOUTS_PATH, AFFILIATE_CMS_STRIPE_PATH);
  if (outcome.status === 'cancelled') {
    const back =
      outcome.commissionCount > 0
        ? ` ${commissionsText(outcome.commissionCount)} went back to what is owed.`
        : ' Its commissions were refunded meanwhile, so nothing went back to what is owed.';
    return { ok: true, message: `Payout cancelled.${back}` };
  }
  return { ok: false, error: manualPayoutError(outcome.status) };
}

/* ---------------------------------------------------------------- Stripe setup --- */

/**
 * On the public sandbox the Stripe key comes from the deployment's env and belongs to its
 * operator: "Test connection" answers before any Stripe call, right after the admin check.
 */
function stripeSetupTestRefusedInSandbox(): boolean {
  return process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';
}

const STRIPE_SETUP_SANDBOX = "Stripe isn't tested on the sandbox: its keys belong to the site's operator, and payouts are switched off.";

const STRIPE_SETUP_REFUSALS: Readonly<Record<string, string>> = {
  sandbox: STRIPE_SETUP_SANDBOX,
  forbidden: 'Only administrators can manage the affiliate program.',
  package_inactive: PAYOUT_ERROR_MESSAGES['package_inactive'] as string,
  stripe_not_configured: 'No Stripe secret key is configured. Add it under CMS > Payments, then test again.',
  unavailable: "Couldn't reach Stripe. Try again in a moment.",
};

export type TestAffiliateStripeSetupResult =
  | { ok: true; message: string; livemode: boolean | null; checks: AffiliateStripeSetupCheck[]; note: string }
  | { ok: false; error: string; reason: 'forbidden' | 'sandbox' | 'package_inactive' | 'stripe_not_configured' | 'unavailable' | 'unknown' };

/**
 * "Test connection" on the Stripe payouts screen: read-only Stripe calls that check what payouts
 * need (the key, the platform account, the currency, the webhook endpoint, transfers, Connect),
 * as checks with fixed wording (`lib/affiliates/payout-setup.ts`). Nothing is charged or
 * transferred. No input: there is nothing for a caller to choose.
 */
export async function testAffiliateStripeSetup(): Promise<TestAffiliateStripeSetupResult> {
  const auth = await authorizeAdmin();
  if (!auth.ok) return { ok: false, error: auth.error, reason: 'forbidden' };
  if (stripeSetupTestRefusedInSandbox()) return { ok: false, error: STRIPE_SETUP_SANDBOX, reason: 'sandbox' };

  let result: Awaited<ReturnType<typeof testAffiliateStripeSetupNow>>;
  try {
    result = await testAffiliateStripeSetupNow();
  } catch (error) {
    logFailure('test Stripe setup', error);
    return { ok: false, error: 'The test did not run. Try again in a moment.', reason: 'unknown' };
  }
  if (!result.ok) {
    return { ok: false, error: STRIPE_SETUP_REFUSALS[result.reason] ?? 'The test did not run. Try again in a moment.', reason: result.reason };
  }

  const { checks, livemode, note } = result;
  const count = (status: AffiliateStripeSetupCheck['status']) => checks.filter((check) => check.status === status).length;
  const failed = count('fail');
  const warnings = count('warn');
  const message =
    failed > 0
      ? `${failed} ${failed === 1 ? 'check' : 'checks'} failed${warnings > 0 ? `, ${warnings} with a warning` : ''}.`
      : warnings > 0
        ? `Stripe answered. ${warnings} ${warnings === 1 ? 'check needs' : 'checks need'} your attention.`
        : 'Stripe answered every check.';
  return { ok: true, message, livemode, checks, note };
}

/* -------------------------------------------------------------------- settings --- */

const settingsSchema = z
  .object({
    notificationEmails: z.union([z.string().max(3000), z.array(z.string().max(320)).max(50)]),
    minPayoutCents: z
      .number()
      .int()
      .min(AFFILIATES_SETTINGS_LIMITS.minPayoutCents, 'The minimum payout is too small for a Stripe transfer.')
      .max(AFFILIATES_SETTINGS_LIMITS.maxPayoutCents, 'The minimum payout is too large.'),
    autoPayoutsEnabled: z.boolean(),
    // Checked by parseAffiliateTermsUrl below (its 2,048-character limit included), with a readable error.
    termsUrlEn: z.string().max(4096).optional(),
    termsUrlFr: z.string().max(4096).optional(),
    // How each gateway's commissions are paid (02036). Omitted = unchanged; never anything else.
    payoutMethods: z
      .object({ stripeSales: z.enum(AFFILIATE_PAYOUT_METHODS), freemiusSales: z.enum(AFFILIATE_PAYOUT_METHODS) })
      .strict()
      .optional(),
  })
  .strict();

export interface SaveAffiliatesProgramSettingsInput {
  /** One textarea ("a@x.com, b@y.com" or one per line) or a list. */
  notificationEmails: string | string[];
  /** Base-currency minor units. */
  minPayoutCents: number;
  autoPayoutsEnabled: boolean;
  /**
   * The operator's own partner terms page in English: a site path (`/legal/partners`) or an https
   * URL; `''` = the built-in terms. Omitted = unchanged.
   */
  termsUrlEn?: string;
  /** The same in French (`''` = the English page when one is set, else the built-in terms). */
  termsUrlFr?: string;
  /**
   * How the commissions of each sale gateway are paid: `stripe_connect` (automatic transfers),
   * `paypal` (automatic PayPal Payouts from the PayPal balance, 02037) or `manual` (PayPal, Interac
   * e-Transfer, bank transfer, recorded under Payouts). Omitted = unchanged.
   */
  payoutMethods?: { stripeSales: 'stripe_connect' | 'paypal' | 'manual'; freemiusSales: 'stripe_connect' | 'paypal' | 'manual' };
}

/** The sandbox refusal, word for word in the form's note under the terms fields. */
const TERMS_URLS_LOCKED_IN_SANDBOX =
  "Partner terms links can't be changed in the sandbox: every visitor, and the partner sign-up form, would be sent there.";

/**
 * On the public sandbox (published admin login) a terms link would send every later visitor to an
 * address a visitor chose, so a non-empty one is refused right after the admin check; the other
 * fields save as anywhere else, and every read drops a stored link there (lib/affiliates/settings.ts).
 */
function termsUrlRequestedInSandbox(input: unknown): boolean {
  if (process.env.NEXT_PUBLIC_IS_SANDBOX !== 'true') return false;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const { termsUrlEn, termsUrlFr } = input as Record<string, unknown>;
  return [termsUrlEn, termsUrlFr].some((value) => typeof value === 'string' && value.trim() !== '');
}

/**
 * The submitted terms overrides, checked and in their stored (canonical, percent-encoded) form: each
 * a site path starting with one `/` made of plain segments, an https URL, or `''`; never a built-in
 * terms address however it is spelled, as a path or as an https URL on this site's host (the page
 * would redirect to itself: `isAffiliateTermsUrlBuiltIn`, the rule every read applies too). An
 * omitted field stays out (the stored value is kept).
 */
function checkTermsUrls(
  data: { termsUrlEn?: string; termsUrlFr?: string }
): { ok: true; urls: { termsUrlEn?: string; termsUrlFr?: string } } | { ok: false; error: string } {
  const urls: { termsUrlEn?: string; termsUrlFr?: string } = {};
  for (const [field, language] of [
    ['termsUrlEn', 'English'],
    ['termsUrlFr', 'French'],
  ] as const) {
    const value = data[field];
    if (value === undefined) continue;
    const url = parseAffiliateTermsUrl(value);
    if (url === null) {
      return {
        ok: false,
        error: `The ${language} partner terms page must be a path on this site that starts with a single / (like /legal/partner-terms, without // or /./ or /../) or a full https:// address, without spaces and at most 2,048 characters.`,
      };
    }
    if (isAffiliateTermsUrlBuiltIn(url)) {
      return {
        ok: false,
        error: `The ${language} partner terms page is the address of the built-in terms. Leave the field empty to use them.`,
      };
    }
    urls[field] = url;
  }
  return { ok: true, urls };
}

/**
 * Notification recipients, the minimum automated payout, the daily payout switch and the partner
 * terms pages (refused on the sandbox when non-empty).
 */
export async function saveAffiliatesProgramSettings(
  input: SaveAffiliatesProgramSettingsInput
): Promise<AffiliateAdminActionResult> {
  const auth = await authorizeAdmin();
  if (!auth.ok) return auth;
  if (termsUrlRequestedInSandbox(input)) return { ok: false, error: TERMS_URLS_LOCKED_IN_SANDBOX };

  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error, 'Check the settings and try again.') };

  const terms = checkTermsUrls(parsed.data);
  if (!terms.ok) return { ok: false, error: terms.error };

  const candidates = (
    Array.isArray(parsed.data.notificationEmails)
      ? parsed.data.notificationEmails
      : parsed.data.notificationEmails.split(/[\s,;]+/)
  )
    .map((value) => value.trim())
    .filter(Boolean);

  const emails: string[] = [];
  const invalid: string[] = [];
  for (const candidate of candidates) {
    const email = normalizeAffiliateNotificationEmail(candidate);
    if (!email) invalid.push(candidate.length > 60 ? `${candidate.slice(0, 59)}…` : candidate);
    else if (!emails.includes(email)) emails.push(email);
  }
  if (invalid.length > 0) {
    const listed = invalid.slice(0, 3).join(', ');
    return {
      ok: false,
      error: `${invalid.length === 1 ? 'This address is' : 'These addresses are'} not valid: ${listed}${invalid.length > 3 ? ', …' : ''}`,
    };
  }
  if (emails.length > AFFILIATES_SETTINGS_LIMITS.maxNotificationEmails) {
    return { ok: false, error: `Enter at most ${AFFILIATES_SETTINGS_LIMITS.maxNotificationEmails} notification addresses.` };
  }

  try {
    await saveAffiliatesSettings({
      notificationEmails: emails,
      minPayoutCents: parsed.data.minPayoutCents,
      autoPayoutsEnabled: parsed.data.autoPayoutsEnabled,
      ...terms.urls,
      ...(parsed.data.payoutMethods ? { payoutMethods: parsed.data.payoutMethods } : {}),
    });
  } catch (error) {
    logFailure('save affiliate settings', error);
    return { ok: false, error: 'The settings could not be saved. Try again in a moment.' };
  }

  // The terms pages, the signup form's terms link and the sitemap read the public projection.
  evictAffiliateProgramSettingsCache('action');
  revalidateAffiliateScreens(AFFILIATE_CMS_PAYOUTS_PATH, AFFILIATE_CMS_STRIPE_PATH);
  return { ok: true, message: 'Program settings saved.' };
}

/* ---------------------------------------------------------------------- alerts --- */

const resolveAlertSchema = z.object({ alertIdToResolve: idSchema }).strict();

export interface ResolveAffiliateAlertInput {
  alertIdToResolve: string;
}

/** Mark an affiliate notification done (only affiliate alert types; other alerts are untouched). */
export async function resolveAffiliateAlert(input: ResolveAffiliateAlertInput): Promise<AffiliateAdminActionResult> {
  const auth = await authorizeAdmin();
  if (!auth.ok) return auth;

  const parsed = resolveAlertSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: INVALID_INPUT };

  try {
    const { data, error } = await auth.session.db
      .from('system_alerts')
      .update({ is_resolved: true, resolved_at: new Date().toISOString() })
      .eq('id', parsed.data.alertIdToResolve)
      .in('alert_type', [...AFFILIATE_ADMIN_ALERT_TYPES])
      .select('id');
    if (error) {
      logFailure('resolve affiliate alert', error);
      return { ok: false, error: SAVE_FAILED };
    }
    if (!Array.isArray(data) || data.length === 0) return { ok: false, error: 'That notification no longer exists.' };
  } catch (error) {
    logFailure('resolve affiliate alert', error);
    return { ok: false, error: SAVE_FAILED };
  }

  revalidateAffiliateScreens();
  revalidateCmsChrome();
  return { ok: true, message: 'Marked as done.' };
}
