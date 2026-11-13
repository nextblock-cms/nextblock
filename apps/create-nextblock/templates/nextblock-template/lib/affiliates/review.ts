import 'server-only';

import { createHash } from 'node:crypto';
import {
  AFFILIATE_ALERT_TYPES,
  AFFILIATE_RETAILER_ROLE,
  affiliateTierDisplayName,
  isStorefrontDocEmpty,
  normalizeStorefrontSiteOrigin,
  sanitizeAffiliateSocialLinks,
  sanitizeStorefrontDoc,
  type AffiliatePageRow,
  type AffiliateProfileRow,
  type AffiliatePublishedProfile,
} from '@nextblock-cms/affiliates';
import {
  AffiliateRepositoryError,
  getAffiliatePageById,
  getAffiliateProfileById,
  getAffiliateTierById,
  normalizeAffiliateUuid,
  type AffiliateRepositoryClient,
} from '@nextblock-cms/affiliates/server';
import { resolveSiteUrl } from '../site-url';
import { checkAffiliateUserDeletion } from './affiliate-deletion-guard';
import { deleteSupersededAffiliateAvatar } from './avatar-cleanup';
import { evictAffiliateStorefrontCache, evictAffiliateTiersCache } from './cache';
import { getStorefrontImageOrigins } from './image-origins';
import { scheduleAffiliateLifecycleNotification } from './notify';

/**
 * The admin side of the storefront review and partner moderation (milestone 5).
 *
 * Every function here runs with the service-role client the caller passes in, and it does NOT
 * authorize: the CMS server actions (`app/cms/affiliates/actions.ts`) call `requireCmsAdmin()`
 * first and hand over that client plus the verified admin's id. Under the service role RLS is
 * not a boundary, so these functions treat every stored partner value as untrusted:
 *
 * - `draft_content` is re-sanitized (`sanitizeStorefrontDoc` with this deployment's image origins)
 *   before it becomes `published_content`; an empty result is refused.
 * - The approval is optimistic: it only succeeds while the page is still PENDING_REVIEW at the
 *   `draft_version` the admin looked at, and while the public profile still matches the
 *   fingerprint of the snapshot the review screen showed (`fingerprintAffiliatePublishedProfile`).
 *   A profile edit does not move `draft_version` (over the Data API, or a withdraw, profile edit
 *   or avatar upload, then a resubmission), so without the fingerprint a stale Approve would
 *   publish a name, bio, avatar or links nobody reviewed. The snapshot that matched is the one
 *   written, so a change after the check cannot be published either.
 * - Approving and requesting changes never write a draft column (`title`, `meta_description`,
 *   `draft_content`, `featured_product_ids`): the 02030 page guard would bump `draft_version`
 *   and flip the status back to DRAFT if they did.
 * - `onboarding_step` and `affiliate_tiers.member_count` are derived by triggers; nothing here
 *   writes them.
 *
 * Results are `{ ok: true, … } | { ok: false, code, error }` with English (CMS) messages that are
 * safe to show: database errors are logged by operation and code, never echoed.
 */

export type AffiliateReviewErrorCode =
  | 'invalid_input'
  | 'note_required'
  | 'not_found'
  | 'not_pending'
  | 'version_mismatch'
  | 'empty_storefront'
  | 'partner_missing'
  | 'partner_suspended'
  | 'too_large'
  | 'tier_not_found'
  | 'tier_inactive'
  | 'tier_full'
  | 'stale'
  | 'handle_mismatch'
  | 'remove_failed'
  | 'sandbox'
  | 'failed';

export type AffiliateReviewFailure = { ok: false; code: AffiliateReviewErrorCode; error: string };

export type AffiliateReviewResult<T extends object = Record<never, never>> = ({ ok: true } & T) | AffiliateReviewFailure;

export const AFFILIATE_REVIEW_ERROR_MESSAGES: Readonly<Record<AffiliateReviewErrorCode, string>> = {
  invalid_input: 'That request could not be read. Reload the page and try again.',
  note_required: 'Write a note telling the partner what to change.',
  not_found: 'That storefront no longer exists.',
  not_pending: 'This storefront is not waiting for review any more. Reload the page to see its current state.',
  version_mismatch:
    'The partner changed this storefront after you opened it. Reload the page to review the latest version.',
  empty_storefront:
    'The proposed storefront has no content left after sanitizing, so there is nothing to publish. Request changes instead.',
  partner_missing: 'The partner account behind this storefront could not be found.',
  partner_suspended: 'This partner is paused. Resume them before publishing their storefront.',
  too_large: 'The proposed storefront is too large to publish. Request changes so the partner can shorten it.',
  tier_not_found: 'That tier no longer exists. Reload the page and pick another one.',
  tier_inactive: 'That tier is inactive. Activate it on the Tiers screen before assigning partners to it.',
  // The Change tier dialog asks for "Assign over the cap" on a tier it knows is full, so the RPC
  // answers tier_full only when the tier filled up after the page loaded; the CMS action then
  // re-renders the screen, and the box appears in the open dialog.
  tier_full:
    'That tier filled up in the meantime. Tick "Assign over the cap" to move this partner anyway, or raise the tier\'s partner cap on the Tiers screen.',
  stale: 'This partner changed in the meantime. Reload the page and try again.',
  handle_mismatch: 'The handle you typed does not match this partner, so nothing was changed.',
  remove_failed: 'The partner is paused, but their partner account could not be removed. Try again in a moment.',
  sandbox: "Partner accounts can't be changed in the sandbox: every visitor shares them.",
  failed: 'The change could not be saved. Try again in a moment.',
};

/** Lengths enforced by the 02030 CHECK constraints. */
const MAX_TITLE_LENGTH = 120;
const MAX_META_DESCRIPTION_LENGTH = 300;
const MAX_FEEDBACK_NOTE_LENGTH = 2000;
const MAX_SUSPENDED_REASON_LENGTH = 500;
const MAX_BIO_LENGTH = 2000;
const MAX_DISPLAY_NAME_LENGTH = 80;
const MAX_FEATURED_PRODUCTS = 24;
const MAX_AVATAR_KEY_LENGTH = 512;
const AVATAR_KEY_PATTERN = /^(affiliates\/avatars\/|images\/)[A-Za-z0-9._/-]+$/;

/** The draft columns approval and change requests must never write (02030 page guard). */
export const AFFILIATE_PAGE_DRAFT_COLUMNS = ['title', 'meta_description', 'draft_content', 'featured_product_ids'] as const;

function fail(code: AffiliateReviewErrorCode): AffiliateReviewFailure {
  return { ok: false, code, error: AFFILIATE_REVIEW_ERROR_MESSAGES[code] };
}

function describeFailure(operation: string, error: unknown): void {
  const code =
    error instanceof AffiliateRepositoryError
      ? error.code
      : error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : null;
  // Operation and SQLSTATE only: no row data, no raw message that could carry partner input.
  console.error(`[affiliates] ${operation} failed`, { code });
}

function errorCode(error: unknown): string | null {
  return error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null;
}

/** True for C0/C1 control characters and DEL (newline handled by the callers). */
function isControlCode(code: number): boolean {
  return code < 32 || (code >= 127 && code < 160);
}

/** One line of plain text: control characters become spaces, runs of whitespace collapse, then clipped. */
export function cleanAffiliateSingleLine(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  let out = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    out += isControlCode(code) ? ' ' : character;
  }
  return Array.from(out.replace(/\s+/g, ' ').trim()).slice(0, max).join('').trim();
}

/** Multi-line plain text (notes, reasons, bios): CR/LF kept as `\n`, other controls dropped, clipped. */
export function cleanAffiliateMultiline(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/\r\n?/g, '\n');
  let out = '';
  for (const character of normalized) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 10) {
      out += '\n';
    } else if (code === 9) {
      out += ' ';
    } else if (!isControlCode(code)) {
      out += character;
    }
  }
  const collapsed = out
    .split('\n')
    .map((line) => line.replace(/[ ]{2,}/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return Array.from(collapsed).slice(0, max).join('').trim();
}

/** Product ids for `published_featured_product_ids`: uuid strings only, lowercased, deduplicated, at most 24. */
export function normalizeAffiliateFeaturedProductIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const entry of value) {
    const id = normalizeAffiliateUuid(entry);
    if (!id || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= MAX_FEATURED_PRODUCTS) break;
  }
  return ids;
}

function normalizeAvatarKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  if (!key || key.length > MAX_AVATAR_KEY_LENGTH) return null;
  if (!AVATAR_KEY_PATTERN.test(key) || key.includes('..') || key.includes('//')) return null;
  return key;
}

/**
 * The public profile copied onto the page at approval time: the storefront renders this snapshot,
 * so a partner cannot change their name, bio, avatar or links on the live page without review.
 * `locale` is the partner's language (`preferred_locale`), which the page declares for their text.
 */
export function buildAffiliatePublishedProfile(
  profile: Pick<AffiliateProfileRow, 'display_name' | 'bio' | 'avatar_object_key' | 'social_links' | 'preferred_locale'>
): AffiliatePublishedProfile {
  const bio = cleanAffiliateMultiline(profile.bio, MAX_BIO_LENGTH);
  return {
    display_name: cleanAffiliateSingleLine(profile.display_name, MAX_DISPLAY_NAME_LENGTH),
    bio: bio || null,
    avatar_object_key: normalizeAvatarKey(profile.avatar_object_key),
    social_links: sanitizeAffiliateSocialLinks(profile.social_links),
    locale: profile.preferred_locale === 'fr' ? 'fr' : 'en',
  };
}

/** JSON with object keys sorted at every level (undefined members dropped, as JSON.stringify does). */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The fingerprint of a published-profile snapshot: sha256 (hex) of its canonical JSON, so it
 * covers every field of the snapshot whatever the key order. The review screen sends the one it
 * showed with Approve; `approveAffiliateStorefront` refuses when the snapshot built at approval
 * differs. Not `affiliate_profiles.updated_at`: every counted click bumps that.
 */
export function fingerprintAffiliatePublishedProfile(snapshot: AffiliatePublishedProfile): string {
  return createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
}

const PROFILE_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

function toProfileFingerprint(value: unknown): string | null {
  return typeof value === 'string' && PROFILE_FINGERPRINT_PATTERN.test(value) ? value : null;
}

function toDraftVersion(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isInteger(number) && number >= 1 && number <= 2_147_483_647 ? number : null;
}

function siteOrigin(): string | null {
  return normalizeStorefrontSiteOrigin(resolveSiteUrl());
}

/** Sanitize a stored storefront document exactly the way approval does (shared with the review screen). */
export function sanitizeAffiliateDraftForReview(raw: unknown) {
  return sanitizeStorefrontDoc(raw, { allowedImageOrigins: getStorefrontImageOrigins(), siteOrigin: siteOrigin() });
}

type ReviewTarget = { page: AffiliatePageRow; profile: AffiliateProfileRow };

/** Load the page under review and its partner, enforcing PENDING_REVIEW at the expected version. */
async function loadPendingPage(
  db: AffiliateRepositoryClient,
  pageId: string,
  expectedVersion: number
): Promise<ReviewTarget | AffiliateReviewFailure> {
  const page = await getAffiliatePageById(db, pageId);
  if (!page) return fail('not_found');
  if (page.approval_status !== 'PENDING_REVIEW') return fail('not_pending');
  if (page.draft_version !== expectedVersion) return fail('version_mismatch');

  const profile = await getAffiliateProfileById(db, page.affiliate_id);
  if (!profile || profile.user_id !== page.user_id) return fail('partner_missing');
  return { page, profile };
}

function isFailure(value: ReviewTarget | AffiliateReviewFailure): value is AffiliateReviewFailure {
  return (value as AffiliateReviewFailure).ok === false;
}

/**
 * Close the page's unresolved "storefront submitted" alerts (the banner and the activity feed):
 * keyed by page id, and by partner id for alerts raised before the page id was known. Best effort.
 */
async function resolveSubmissionAlerts(db: AffiliateRepositoryClient, pageId: string, affiliateId: string): Promise<void> {
  const resolvedAt = new Date().toISOString();
  const keys: Array<[string, string]> = [
    ['metadata->>page_id', pageId],
    ['metadata->>affiliate_id', affiliateId],
  ];
  for (const [column, value] of keys) {
    try {
      const { error } = await db
        .from('system_alerts')
        .update({ is_resolved: true, resolved_at: resolvedAt })
        .eq('alert_type', AFFILIATE_ALERT_TYPES.PAGE_SUBMITTED)
        .eq('is_resolved', false)
        .eq(column, value);
      if (error) describeFailure('resolve submission alerts', error);
    } catch (error) {
      describeFailure('resolve submission alerts', error);
    }
  }
}

export interface ApproveAffiliateStorefrontInput {
  pageIdToApprove: string;
  /** `draft_version` the admin reviewed (carried by the Approve button). */
  expectedDraftVersion: number;
  /**
   * `fingerprintAffiliatePublishedProfile` of the profile snapshot the admin reviewed (carried by
   * the Approve button): approval refuses with `version_mismatch` when the profile moved since.
   */
  expectedProfileFingerprint: string;
  /** The verified admin (from `requireCmsAdmin()`), recorded in `reviewed_by`. */
  reviewerUserId: string;
}

export type ApproveAffiliateStorefrontResult = AffiliateReviewResult<{
  pageId: string;
  affiliateId: string;
  handle: string;
  firstPublication: boolean;
  /** What the sanitizer removed or changed while publishing (English, for the CMS). */
  issues: string[];
}>;

/**
 * Approve & Publish: the sanitized draft becomes `published_content`, together with the title,
 * meta description, featured product ids and a snapshot of the public profile (exactly the one
 * the reviewer saw: `expectedProfileFingerprint` must match it). The partner's
 * first approval also sets `first_published_at` (once: COALESCE semantics), which is what lets
 * them earn, record clicks and set the referral cookie (ADDENDUM A12).
 */
export async function approveAffiliateStorefront(
  input: ApproveAffiliateStorefrontInput,
  db: AffiliateRepositoryClient
): Promise<ApproveAffiliateStorefrontResult> {
  const pageId = normalizeAffiliateUuid(input?.pageIdToApprove);
  const reviewerId = normalizeAffiliateUuid(input?.reviewerUserId);
  const expectedVersion = toDraftVersion(input?.expectedDraftVersion);
  const expectedFingerprint = toProfileFingerprint(input?.expectedProfileFingerprint);
  if (!pageId || !reviewerId || expectedVersion === null || !expectedFingerprint) return fail('invalid_input');

  try {
    const target = await loadPendingPage(db, pageId, expectedVersion);
    if (isFailure(target)) return target;
    const { page, profile } = target;
    if (profile.status !== 'ACTIVE') return fail('partner_suspended');

    // The profile the reviewer saw, or nothing: the partner may have changed it since the review
    // screen loaded without moving `draft_version`. This exact snapshot is what gets published.
    const profileSnapshot = buildAffiliatePublishedProfile(profile);
    if (fingerprintAffiliatePublishedProfile(profileSnapshot) !== expectedFingerprint) return fail('version_mismatch');

    const sanitized = sanitizeAffiliateDraftForReview(page.draft_content);
    if (isStorefrontDocEmpty(sanitized.doc)) return fail('empty_storefront');

    const now = new Date().toISOString();
    const firstPublication = !profile.first_published_at;

    // First approval: mark the partner approved (COALESCE(first_published_at, now()) as a filtered
    // update) BEFORE publishing, and undo it below if the page write does not go through. The
    // other order could leave a published page that the storefront RPC never serves.
    let markedApproved = false;
    if (firstPublication) {
      const { data: approvedRows, error: approveError } = await db
        .from('affiliate_profiles')
        .update({ first_published_at: now })
        .eq('id', profile.id)
        .is('first_published_at', null)
        .select('id');
      if (approveError) {
        describeFailure('mark partner approved', approveError);
        return fail('failed');
      }
      markedApproved = Array.isArray(approvedRows) && approvedRows.length > 0;
    }

    const { data: publishedRows, error: publishError } = await db
      .from('affiliate_pages')
      .update({
        published_content: sanitized.doc,
        published_title: cleanAffiliateSingleLine(page.title, MAX_TITLE_LENGTH) || null,
        published_meta_description: cleanAffiliateSingleLine(page.meta_description, MAX_META_DESCRIPTION_LENGTH) || null,
        published_profile: profileSnapshot,
        published_featured_product_ids: normalizeAffiliateFeaturedProductIds(page.featured_product_ids),
        approval_status: 'PUBLISHED',
        admin_feedback_note: null,
        reviewed_at: now,
        reviewed_by: reviewerId,
        published_at: now,
      })
      .eq('id', page.id)
      .eq('approval_status', 'PENDING_REVIEW')
      .eq('draft_version', expectedVersion)
      .select('id');

    const published = !publishError && Array.isArray(publishedRows) && publishedRows.length > 0;
    if (!published) {
      if (markedApproved) {
        const { error: undoError } = await db
          .from('affiliate_profiles')
          .update({ first_published_at: null })
          .eq('id', profile.id)
          .eq('first_published_at', now);
        if (undoError) describeFailure('undo partner approval', undoError);
      }
      if (publishError) {
        describeFailure('publish storefront', publishError);
        return fail(errorCode(publishError) === '23514' ? 'too_large' : 'failed');
      }
      // Zero rows: the page left PENDING_REVIEW or got a new version between the read and the write.
      return fail('version_mismatch');
    }

    await resolveSubmissionAlerts(db, page.id, profile.id);
    scheduleAffiliateLifecycleNotification('PAGE_PUBLISHED', { affiliateId: profile.id, pageId: page.id });
    evictAffiliateStorefrontCache(profile.handle, 'action');
    // The previous snapshot's avatar is shown nowhere now (the upload route kept it while it was live).
    await deleteSupersededAffiliateAvatar({
      affiliateId: profile.id,
      previousPublishedKey: page.published_profile?.avatar_object_key,
      keepKeys: [profileSnapshot.avatar_object_key, profile.avatar_object_key],
    });

    return {
      ok: true,
      pageId: page.id,
      affiliateId: profile.id,
      handle: profile.handle,
      firstPublication,
      issues: sanitized.issues,
    };
  } catch (error) {
    describeFailure('approve storefront', error);
    return fail('failed');
  }
}

export interface RequestAffiliateStorefrontChangesInput {
  pageIdToReview: string;
  /** Shown to the partner in the portal and in the CHANGES_REQUESTED email. Required. */
  note: string;
  expectedDraftVersion: number;
  reviewerUserId: string;
}

export type RequestAffiliateStorefrontChangesResult = AffiliateReviewResult<{
  pageId: string;
  affiliateId: string;
  handle: string;
}>;

/**
 * Request Changes: the page goes to CHANGES_REQUESTED with the admin's note; whatever was
 * published before stays live. The partner is emailed the note.
 */
export async function requestAffiliateStorefrontChanges(
  input: RequestAffiliateStorefrontChangesInput,
  db: AffiliateRepositoryClient
): Promise<RequestAffiliateStorefrontChangesResult> {
  const pageId = normalizeAffiliateUuid(input?.pageIdToReview);
  const reviewerId = normalizeAffiliateUuid(input?.reviewerUserId);
  const expectedVersion = toDraftVersion(input?.expectedDraftVersion);
  if (!pageId || !reviewerId || expectedVersion === null) return fail('invalid_input');

  const note = cleanAffiliateMultiline(input?.note, MAX_FEEDBACK_NOTE_LENGTH);
  if (!note) return fail('note_required');

  try {
    const target = await loadPendingPage(db, pageId, expectedVersion);
    if (isFailure(target)) return target;
    const { page, profile } = target;

    const { data, error } = await db
      .from('affiliate_pages')
      .update({
        approval_status: 'CHANGES_REQUESTED',
        admin_feedback_note: note,
        reviewed_at: new Date().toISOString(),
        reviewed_by: reviewerId,
      })
      .eq('id', page.id)
      .eq('approval_status', 'PENDING_REVIEW')
      .eq('draft_version', expectedVersion)
      .select('id');
    if (error) {
      describeFailure('request storefront changes', error);
      return fail('failed');
    }
    if (!Array.isArray(data) || data.length === 0) return fail('version_mismatch');

    await resolveSubmissionAlerts(db, page.id, profile.id);
    scheduleAffiliateLifecycleNotification('CHANGES_REQUESTED', {
      affiliateId: profile.id,
      pageId: page.id,
      feedbackNote: note,
    });
    evictAffiliateStorefrontCache(profile.handle, 'action');

    return { ok: true, pageId: page.id, affiliateId: profile.id, handle: profile.handle };
  } catch (error) {
    describeFailure('request storefront changes', error);
    return fail('failed');
  }
}

export interface SuspendAffiliatePartnerInput {
  affiliateIdToUpdate: string;
  /** Internal note (shown in the CMS and the partner's portal notice); optional. */
  reason?: string | null;
}

export type AffiliatePartnerModerationResult = AffiliateReviewResult<{
  affiliateId: string;
  handle: string;
  /**
   * The partner was approved once (`first_published_at` is set), so a pause takes a public
   * storefront offline and stops earning links. False before a first approval: nothing of theirs
   * is public and they earn nothing, so the CMS words the outcome differently.
   */
  isApproved: boolean;
}>;

async function setPartnerStatus(
  db: AffiliateRepositoryClient,
  affiliateId: string,
  values: { status: 'ACTIVE' | 'SUSPENDED'; suspended_reason: string | null },
  operation: string
): Promise<AffiliatePartnerModerationResult> {
  try {
    const profile = await getAffiliateProfileById(db, affiliateId);
    if (!profile) return fail('partner_missing');

    const { data, error } = await db.from('affiliate_profiles').update(values).eq('id', profile.id).select('id');
    if (error) {
      describeFailure(operation, error);
      return fail('failed');
    }
    if (!Array.isArray(data) || data.length === 0) return fail('partner_missing');

    // The storefront RPC only serves ACTIVE partners: the public page appears or disappears now.
    evictAffiliateStorefrontCache(profile.handle, 'action');
    // The partner hears about a real change only (a reason edited on a paused partner sends nothing).
    // The notifier runs after the response and mails nobody on the sandbox.
    if (profile.status !== values.status) {
      scheduleAffiliateLifecycleNotification(values.status === 'SUSPENDED' ? 'PARTNER_SUSPENDED' : 'PARTNER_REACTIVATED', {
        affiliateId: profile.id,
        suspendedReason: values.suspended_reason,
        storefrontLive: Boolean(profile.first_published_at),
      });
    }
    return { ok: true, affiliateId: profile.id, handle: profile.handle, isApproved: Boolean(profile.first_published_at) };
  } catch (error) {
    describeFailure(operation, error);
    return fail('failed');
  }
}

/**
 * Suspend a partner ("Pause partner" in the CMS): their storefront leaves the public site, their
 * referral links stop setting the cookie and counting clicks, checkout stops attributing to them,
 * and no commission is recorded or payout claimed for them (every 02030 money function requires
 * an ACTIVE partner). Commissions already recorded keep clearing. Orders attributed before the
 * pause that are paid meanwhile get their commission from `reconcile_affiliate_commissions` (the
 * first step of every payout cycle, 120 days back) once the partner is ACTIVE again, at the rate
 * stored on each order when it was paid (02035), whatever tier the partner is in by then. The
 * partner is emailed a PARTNER_SUSPENDED notice with the reason.
 */
export async function suspendAffiliatePartner(
  input: SuspendAffiliatePartnerInput,
  db: AffiliateRepositoryClient
): Promise<AffiliatePartnerModerationResult> {
  const affiliateId = normalizeAffiliateUuid(input?.affiliateIdToUpdate);
  if (!affiliateId) return fail('invalid_input');
  const reason = cleanAffiliateMultiline(input?.reason ?? '', MAX_SUSPENDED_REASON_LENGTH);
  return setPartnerStatus(db, affiliateId, { status: 'SUSPENDED', suspended_reason: reason || null }, 'suspend partner');
}

export interface ReactivateAffiliatePartnerInput {
  affiliateIdToUpdate: string;
}

/**
 * Reactivate a suspended partner ("Resume partner" in the CMS): their last approved storefront is
 * served again and their links earn again. The partner is emailed a PARTNER_REACTIVATED notice.
 */
export async function reactivateAffiliatePartner(
  input: ReactivateAffiliatePartnerInput,
  db: AffiliateRepositoryClient
): Promise<AffiliatePartnerModerationResult> {
  const affiliateId = normalizeAffiliateUuid(input?.affiliateIdToUpdate);
  if (!affiliateId) return fail('invalid_input');
  return setPartnerStatus(db, affiliateId, { status: 'ACTIVE', suspended_reason: null }, 'reactivate partner');
}

export interface RemoveAffiliatePartnerInput {
  affiliateIdToRemove: string;
  /** What the admin typed to confirm: the partner's handle (a leading `@`, spaces and case aside). */
  confirmHandle: string;
}

export type RemoveAffiliatePartnerResult = AffiliateReviewResult<{
  affiliateId: string;
  handle: string;
  displayName: string;
  /** True when the partner account is gone; false when the partner was paused instead. */
  removed: boolean;
  /** Why the partner was paused instead of removed (null once removed). */
  keptBecause: 'payouts' | 'commissions' | 'unavailable' | null;
  /** Removed only: false when `profiles.role` could not be moved from RTL back to USER. */
  roleDemoted: boolean;
}>;

/** What a confirmation field holds, as a handle: trimmed, one leading `@` dropped, lowercased. */
export function normalizeAffiliateConfirmHandle(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/^@/, '').trim().toLowerCase();
}

/**
 * `profiles.role` back from RTL to USER, so the account keeps signing in as a customer and loses
 * the portal. The role is read and compared as text (`String(role)`; the generated `user_role`
 * type predates 02029's RTL label), and the update is guarded on it, so a role another admin
 * changed in between is never overwritten. True when the account no longer holds the partner role.
 */
async function demotePartnerRole(db: AffiliateRepositoryClient, userId: string): Promise<boolean> {
  try {
    const { data, error } = await db.from('profiles').select('role').eq('id', userId).maybeSingle();
    if (error) {
      describeFailure('read the partner role', error);
      return false;
    }
    const role = (data as { role?: unknown } | null)?.role;
    if (String(role ?? '') !== AFFILIATE_RETAILER_ROLE) return true;

    const { error: updateError } = await db
      .from('profiles')
      .update({ role: 'USER' })
      .eq('id', userId)
      .eq('role', AFFILIATE_RETAILER_ROLE)
      .select('id');
    if (updateError) {
      describeFailure('demote the partner role', updateError);
      return false;
    }
    // Zero rows: the role changed (or the account went away) in between; either way it is not RTL.
    return true;
  } catch (error) {
    describeFailure('demote the partner role', error);
    return false;
  }
}

/**
 * The alerts a removal closes: the partner's own lifecycle steps. Never `affiliate_payout_failed`
 * (or a refund alert): the Connect setup alert (`recordConnectSetupAlert` in `connect-service.ts`,
 * `metadata.kind = 'connect_setup'`) is an `affiliate_payout_failed` row that carries the id of
 * whichever partner hit the failure, but it describes the platform's Stripe setup, so removing a
 * test partner must not hide it. A removable partner has no payouts, so no per-payout alert can
 * name them anyway. Do not widen this list.
 */
export const AFFILIATE_REMOVAL_RESOLVED_ALERT_TYPES: readonly string[] = [
  AFFILIATE_ALERT_TYPES.SIGNED_UP,
  AFFILIATE_ALERT_TYPES.PROFILE_COMPLETED,
  AFFILIATE_ALERT_TYPES.PAYOUT_CONFIGURED,
  AFFILIATE_ALERT_TYPES.PAGE_SUBMITTED,
];

/**
 * Close the unresolved lifecycle alerts about a removed partner (the activity feed and the banner
 * would otherwise point at a review page that no longer exists), keyed by `metadata.affiliate_id`.
 * Best effort, like `resolveSubmissionAlerts`.
 */
async function resolvePartnerAlerts(db: AffiliateRepositoryClient, affiliateId: string): Promise<void> {
  try {
    const { error } = await db
      .from('system_alerts')
      .update({ is_resolved: true, resolved_at: new Date().toISOString() })
      .in('alert_type', [...AFFILIATE_REMOVAL_RESOLVED_ALERT_TYPES])
      .eq('is_resolved', false)
      .eq('metadata->>affiliate_id', affiliateId);
    if (error) describeFailure('resolve the partner alerts', error);
  } catch (error) {
    describeFailure('resolve the partner alerts', error);
  }
}

/**
 * "Remove partner" in /cms/affiliates: delete a partner account that never earned anything, and
 * keep every partner who did.
 *
 * 1. Refused on the public sandbox, whose demo partners every visitor shares, before anything is
 *    read (the CMS action refuses there too).
 * 2. The partner is loaded, and `confirmHandle` must be their handle.
 * 3. The partner is paused first (`status = SUSPENDED`): every 02030 money function requires an
 *    ACTIVE partner, so no commission or payout can be recorded from here on. The storefront
 *    leaves the public site at once.
 * 4. The ledger is checked again (`checkAffiliateUserDeletion`, the /cms/users guard): commission
 *    and payout rows cascade from the profile, so a partner with any payout or real commission is
 *    kept, paused (`removed: false`, and the partner gets the PARTNER_SUSPENDED notice when this
 *    call paused them). A ledger that cannot be read keeps the partner the same way.
 * 5. Otherwise the `affiliate_profiles` row is deleted, only while it is still SUSPENDED (a resume
 *    in between answers `stale`). The page and the click events cascade; `member_count` drops by
 *    trigger; attributed orders keep their rows with `affiliate_id` set to NULL.
 * 6. `profiles.role` goes back from RTL to USER (the sign-in account itself stays), the partner's
 *    open lifecycle alerts are resolved (never a payout alert: see
 *    `AFFILIATE_REMOVAL_RESOLVED_ALERT_TYPES`), and the storefront and tier caches are evicted.
 *
 * The Stripe Connect account and the partner's storage objects (`affiliates/avatars/<id>/`,
 * `affiliates/pages/<id>/`) are left alone. No email is sent for a removal.
 */
export async function removeAffiliatePartner(
  input: RemoveAffiliatePartnerInput,
  db: AffiliateRepositoryClient
): Promise<RemoveAffiliatePartnerResult> {
  if (process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') return fail('sandbox');

  const affiliateId = normalizeAffiliateUuid(input?.affiliateIdToRemove);
  const confirmHandle = normalizeAffiliateConfirmHandle(input?.confirmHandle);
  if (!affiliateId || !confirmHandle) return fail('invalid_input');

  let paused = false;
  try {
    const profile = await getAffiliateProfileById(db, affiliateId);
    if (!profile) return fail('partner_missing');
    if (confirmHandle !== profile.handle) return fail('handle_mismatch');

    const wasActive = profile.status !== 'SUSPENDED';
    if (wasActive) {
      const { data, error } = await db.from('affiliate_profiles').update({ status: 'SUSPENDED' }).eq('id', profile.id).select('id');
      if (error) {
        describeFailure('pause partner before removal', error);
        return fail('failed');
      }
      if (!Array.isArray(data) || data.length === 0) return fail('partner_missing');
      evictAffiliateStorefrontCache(profile.handle, 'action');
    }
    paused = true;

    const kept = (keptBecause: 'payouts' | 'commissions' | 'unavailable'): RemoveAffiliatePartnerResult => {
      if (wasActive) {
        scheduleAffiliateLifecycleNotification('PARTNER_SUSPENDED', {
          affiliateId: profile.id,
          suspendedReason: profile.suspended_reason,
          storefrontLive: Boolean(profile.first_published_at),
        });
      }
      return {
        ok: true,
        affiliateId: profile.id,
        handle: profile.handle,
        displayName: profile.display_name,
        removed: false,
        keptBecause,
        roleDemoted: false,
      };
    };

    const ledger = await checkAffiliateUserDeletion(db, profile.user_id);
    if (ledger.kind === 'blocked') return kept(ledger.reason);
    if (ledger.kind === 'unavailable') return kept('unavailable');

    const { data: deleted, error: deleteError } = await db
      .from('affiliate_profiles')
      .delete()
      .eq('id', profile.id)
      .eq('status', 'SUSPENDED')
      .select('id');
    if (deleteError) {
      describeFailure('remove partner', deleteError);
      return fail('remove_failed');
    }
    if (!Array.isArray(deleted) || deleted.length === 0) return fail('stale');

    const roleDemoted = await demotePartnerRole(db, profile.user_id);
    await resolvePartnerAlerts(db, profile.id);
    // The storefront, the sitemap and the tier list (member count, founding spots) drop the partner.
    evictAffiliateStorefrontCache(profile.handle, 'action');
    evictAffiliateTiersCache('action');

    return {
      ok: true,
      affiliateId: profile.id,
      handle: profile.handle,
      displayName: profile.display_name,
      removed: true,
      keptBecause: null,
      roleDemoted,
    };
  } catch (error) {
    describeFailure('remove partner', error);
    return fail(paused ? 'remove_failed' : 'failed');
  }
}

export interface ChangeAffiliatePartnerTierInput {
  affiliateIdToUpdate: string;
  tierIdToAssign: string;
  /**
   * Move the partner into a capped tier that is already full. The cap limits public sign-ups and the
   * spots the public pages count, not the operator; without this a full tier answers `tier_full`.
   */
  allowOverCap?: boolean;
  /** Email the partner a TIER_CHANGED notice, only once the move went through. */
  notifyPartner?: boolean;
}

export type ChangeAffiliatePartnerTierResult = AffiliateReviewResult<{
  affiliateId: string;
  handle: string;
  /** The partner's display name, or `@handle` when it is blank (for the CMS sentence). */
  partnerName: string;
  tierName: string;
  /** The tier's commission rate in percent: what orders paid from now on earn. */
  ratePercent: number;
  unchanged: boolean;
  /** A TIER_CHANGED email was scheduled (asked for, and the partner really moved). */
  notified: boolean;
}>;

/** What `change_affiliate_partner_tier` (02035) answers, each outcome decided under its row locks. */
const AFFILIATE_TIER_MOVE_OUTCOMES = ['not_found', 'unchanged', 'tier_not_found', 'tier_inactive', 'tier_full', 'moved'] as const;

type AffiliateTierMoveOutcome = (typeof AFFILIATE_TIER_MOVE_OUTCOMES)[number];

function toAffiliateTierMoveOutcome(value: unknown): AffiliateTierMoveOutcome | null {
  return typeof value === 'string' && (AFFILIATE_TIER_MOVE_OUTCOMES as readonly string[]).includes(value)
    ? (value as AffiliateTierMoveOutcome)
    : null;
}

/** The refusals of the RPC, as review codes (`unchanged` and `moved` succeed). */
const AFFILIATE_TIER_MOVE_REFUSALS: Readonly<Partial<Record<AffiliateTierMoveOutcome, AffiliateReviewErrorCode>>> = {
  not_found: 'partner_missing',
  tier_not_found: 'tier_not_found',
  tier_inactive: 'tier_inactive',
  tier_full: 'tier_full',
};

/**
 * "Change tier" in the CMS: move a partner to another tier, at any time, whatever their status (a
 * paused partner can be moved). The move is one service-role RPC, `change_affiliate_partner_tier`
 * (02035), which locks the profile and both tiers and re-checks everything under those locks: the
 * partner exists, the tier exists and is active, and a capped tier has room unless `allowOverCap`.
 * Only `tier_id` is written; the triggers move `member_count` and stamp `tier_changed_at`.
 *
 * The new rate applies only to orders paid from now on: each order stores its partner's tier rate
 * and clearance hold when it is paid, and its commission is recorded at that rate whenever it is
 * recorded (even later, by the payout run's reconcile after a pause). Commissions already
 * recorded keep theirs.
 *
 * The profile and tier read first only name the partner, the tier and its rate for the CMS and the
 * email. Refused on the public sandbox before anything is read, like the CMS action. The partner
 * is emailed (TIER_CHANGED, in their language) only when `notifyPartner` is set and the partner
 * really moved; the notifier mails nobody on the sandbox either way.
 */
export async function changeAffiliatePartnerTier(
  input: ChangeAffiliatePartnerTierInput,
  db: AffiliateRepositoryClient
): Promise<ChangeAffiliatePartnerTierResult> {
  if (process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') return fail('sandbox');

  const affiliateId = normalizeAffiliateUuid(input?.affiliateIdToUpdate);
  const tierId = normalizeAffiliateUuid(input?.tierIdToAssign);
  if (!affiliateId || !tierId) return fail('invalid_input');
  const allowOverCap = input?.allowOverCap === true;
  const notifyPartner = input?.notifyPartner === true;

  try {
    const [profile, tier] = await Promise.all([getAffiliateProfileById(db, affiliateId), getAffiliateTierById(db, tierId)]);
    if (!profile) return fail('partner_missing');
    if (!tier) return fail('tier_not_found');

    const { data, error } = await db.rpc('change_affiliate_partner_tier', {
      p_affiliate_id: profile.id,
      p_tier_id: tier.id,
      p_allow_over_cap: allowOverCap,
    });
    if (error) {
      describeFailure('change partner tier', error);
      return fail('failed');
    }
    const outcome = toAffiliateTierMoveOutcome(data);
    if (outcome === null) {
      describeFailure('change partner tier', { code: 'unexpected_outcome' });
      return fail('failed');
    }
    const refusal = AFFILIATE_TIER_MOVE_REFUSALS[outcome];
    if (refusal) return fail(refusal);

    const moved = outcome === 'moved';
    const notified = moved && notifyPartner;
    if (moved) {
      // The storefront shows the tier badge, and /partners shows the spots left in capped tiers.
      evictAffiliateStorefrontCache(profile.handle, 'action');
      evictAffiliateTiersCache('action');
      if (notified) {
        scheduleAffiliateLifecycleNotification('TIER_CHANGED', {
          affiliateId: profile.id,
          tierName: affiliateTierDisplayName(tier, profile.preferred_locale),
          tierRatePercent: tier.commission_percentage,
        });
      }
    }
    return {
      ok: true,
      affiliateId: profile.id,
      handle: profile.handle,
      partnerName: cleanAffiliateSingleLine(profile.display_name, MAX_DISPLAY_NAME_LENGTH) || `@${profile.handle}`,
      tierName: tier.name,
      ratePercent: tier.commission_percentage,
      unchanged: !moved,
      notified,
    };
  } catch (error) {
    describeFailure('change partner tier', error);
    return fail('failed');
  }
}
