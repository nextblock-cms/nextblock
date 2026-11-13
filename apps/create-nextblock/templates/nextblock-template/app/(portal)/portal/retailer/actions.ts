'use server';

import 'server-only';

import { revalidatePath } from 'next/cache';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AFFILIATE_PAYOUT_EMAIL_KINDS,
  AFFILIATE_PAYOUT_EMAIL_MAX_LENGTH,
  AFFILIATE_PORTAL_PATH,
  AFFILIATE_SOCIAL_NETWORKS,
  cleanStorefrontText,
  isAffiliatePayPalPayoutReceiver,
  isAffiliateProfileComplete,
  isStorefrontDocEmpty,
  normalizeAffiliatePayoutEmail,
  sanitizeAffiliateSocialLinks,
  sanitizeAffiliateSocialUrl,
  sanitizeStorefrontDoc,
  STOREFRONT_LIMITS,
  truncateStorefrontText,
  type AffiliatePageRow,
  type AffiliatePageStatus,
  type AffiliateProfileRow,
  type AffiliateSocialLinks,
  type AffiliateSocialNetwork,
} from '@nextblock-cms/affiliates';

import {
  createAffiliateExpressDashboardLink,
  getAffiliateConnectCountryOptions,
  refreshAffiliateConnectStatus,
  startAffiliateConnectOnboarding,
  type AffiliateConnectServiceError,
} from '../../../../lib/affiliates/connect-service';
import { getStorefrontImageOrigins } from '../../../../lib/affiliates/image-origins';
import { scheduleAffiliateLifecycleNotification } from '../../../../lib/affiliates/notify';
import {
  filterActiveAffiliateCatalogProductIds,
  hasAffiliateProfileChangedSincePublish,
  normalizeAffiliateProductIdList,
  readAffiliateStripeRedirectUrl,
  readRetailerPortalAccount,
  resolveAffiliateCatalogProducts,
  resolvePortalSiteOrigin,
  searchAffiliateCatalogProducts,
  AFFILIATE_CATALOG_QUERY_MAX_LENGTH,
  AFFILIATE_CATALOG_RESOLVE_LIMIT,
} from '../../../../lib/affiliates/portal-data';
import { getRequestLocale, toAffiliatesLocale } from '../../../../lib/affiliates/request-locale';
import { requireRetailer, type RetailerActor, type RetailerServiceRoleClient } from '../../../../lib/affiliates/retailer-actor';
import { z } from '../../../../lib/zod-config';
import type {
  RetailerPortalActionError,
  RetailerPortalFailure,
  SaveRetailerPayoutEmailResult,
  SaveRetailerProfileResult,
  SaveStorefrontDraftResult,
  StorefrontProductsResult,
  StripeConnectRedirectResult,
  StripeConnectRefreshResult,
  SubmitStorefrontResult,
  WithdrawStorefrontResult,
} from './components/portal-types';

/**
 * Partner portal server actions (`/portal/retailer/**`).
 *
 * Every export is a public POST endpoint, reachable from any page: each one calls
 * `requireRetailer()` FIRST (session, enrolled second factor, `RTL` role, package activation,
 * not suspended) and only then reads or writes, always scoped to the caller's own affiliate and
 * page ids taken from that actor. None takes an actor, owner or client argument; inputs are
 * validated with zod and normalized again before they reach a column. Results are
 * `{ ok: true, … } | { ok: false, error }` with a fixed error vocabulary: database messages are
 * logged on the server and never returned.
 *
 * Writes go through the service role because the portal writes columns the Data API pins and
 * the ledger is service-role only; RLS is not the boundary here, the checks below are. The
 * draft guard trigger (02030) still refuses every draft write while the page is in review.
 */

type AnyClient = SupabaseClient<any>;

type AuthorizedRetailer = {
  ok: true;
  db: AnyClient;
  actor: RetailerActor;
  profile: AffiliateProfileRow;
  page: AffiliatePageRow | null;
};

function fail(error: RetailerPortalActionError, extra: Omit<RetailerPortalFailure, 'ok' | 'error'> = {}): RetailerPortalFailure {
  return { ok: false, error, ...extra };
}

function accessErrorOf(error: unknown): RetailerPortalActionError {
  switch (error instanceof Error ? error.message : '') {
    case 'Unauthorized':
      return 'unauthorized';
    case 'Forbidden':
      return 'forbidden';
    case 'Suspended':
      return 'suspended';
    case 'PackageInactive':
      return 'package_inactive';
    default:
      return 'unknown';
  }
}

/** `requireRetailer()` plus the caller's normalized account. Never throws. */
async function authorizeRetailer(): Promise<AuthorizedRetailer | RetailerPortalFailure> {
  let supabase: RetailerServiceRoleClient;
  let actor: RetailerActor;
  try {
    ({ supabase, actor } = await requireRetailer());
  } catch (error) {
    return fail(accessErrorOf(error));
  }
  const account = readRetailerPortalAccount(actor);
  if (!account) return fail('forbidden');
  return { ok: true, db: supabase as unknown as AnyClient, actor, profile: account.profile, page: account.page };
}

function logFailure(operation: string, error: unknown) {
  const message =
    error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : String(error);
  console.error(`[affiliates] Portal ${operation} failed:`, message);
}

function isPendingReviewError(error: { code?: unknown; message?: unknown } | null | undefined): boolean {
  if (!error) return false;
  return error.code === '55000' || /affiliate_page_pending_review/.test(String(error.message ?? ''));
}

/** One line: control characters removed, whitespace collapsed, trimmed, cut to `max`. */
function cleanLine(value: string, max: number): string {
  const text = cleanStorefrontText(value, { singleLine: true }).text.replace(/\s+/g, ' ').trim();
  return truncateStorefrontText(text, max).trim();
}

/** Paragraphs kept (at most one blank line in a row), control characters removed, trimmed. */
function cleanMultiline(value: string): string {
  return cleanStorefrontText(value)
    .text.replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ------------------------------------------------------------------ profile --- */

const DISPLAY_NAME_MAX = 80;
const BIO_MAX = 2000;
const TITLE_MAX = 120;
const META_DESCRIPTION_MAX = 300;

const socialLinksShape = Object.fromEntries(
  AFFILIATE_SOCIAL_NETWORKS.map((network) => [network, z.string().max(400).optional()]),
) as Record<AffiliateSocialNetwork, z.ZodOptional<z.ZodString>>;

const profileInputSchema = z
  .object({
    displayName: z.string().max(400),
    bio: z.string().max(8000),
    socialLinks: z.object(socialLinksShape).strict(),
    preferredLocale: z.enum(['en', 'fr']),
  })
  .strict();

/**
 * Save the partner's own name, bio, social links and email language. Refused while the page is in
 * review (the reviewer approves the profile snapshot together with the page). The first save
 * that completes the profile stamps `profile_completed_at` and tells the admins.
 */
export async function saveRetailerProfile(input: unknown): Promise<SaveRetailerProfileResult> {
  const auth = await authorizeRetailer();
  if (!auth.ok) return auth;
  const { db, actor, profile, page } = auth;

  if (page?.approval_status === 'PENDING_REVIEW') return fail('pending_review');

  const parsed = profileInputSchema.safeParse(input);
  if (!parsed.success) return fail('invalid_input');

  const displayName = cleanLine(parsed.data.displayName, 400);
  if (!displayName || displayName.length > DISPLAY_NAME_MAX) return fail('invalid_input');
  const bio = cleanMultiline(parsed.data.bio);
  if (bio.length > BIO_MAX) return fail('invalid_input');

  // Per network first (so the partner learns which link was refused), then the whole map through
  // the same sanitizer every reader uses.
  const candidates: AffiliateSocialLinks = {};
  const refused: AffiliateSocialNetwork[] = [];
  for (const network of AFFILIATE_SOCIAL_NETWORKS) {
    const raw = parsed.data.socialLinks[network]?.trim() ?? '';
    if (!raw) continue;
    const url = sanitizeAffiliateSocialUrl(network, raw);
    if (url) candidates[network] = url;
    else refused.push(network);
  }
  if (refused.length > 0) return fail('invalid_social_links', { fields: refused });
  const socialLinks = sanitizeAffiliateSocialLinks(candidates);

  const { data, error } = await db
    .from('affiliate_profiles')
    .update({
      display_name: displayName,
      bio: bio || null,
      social_links: socialLinks,
      preferred_locale: parsed.data.preferredLocale,
    })
    .eq('id', profile.id)
    .eq('user_id', actor.userId)
    .select('id, profile_completed_at')
    .maybeSingle();
  if (error || !data) {
    logFailure('profile save', error ?? 'no row');
    return fail('unknown');
  }

  let profileCompleted = false;
  const alreadyCompleted = typeof (data as { profile_completed_at?: unknown }).profile_completed_at === 'string';
  if (!alreadyCompleted && isAffiliateProfileComplete({ display_name: displayName, bio })) {
    const { data: stamped, error: stampError } = await db
      .from('affiliate_profiles')
      .update({ profile_completed_at: new Date().toISOString() })
      .eq('id', profile.id)
      .eq('user_id', actor.userId)
      .is('profile_completed_at', null)
      .select('id');
    if (stampError) {
      logFailure('profile completion stamp', stampError);
    } else if (Array.isArray(stamped) && stamped.length > 0) {
      profileCompleted = true;
      scheduleAffiliateLifecycleNotification('PROFILE_COMPLETED', { affiliateId: profile.id });
    }
  }

  revalidatePath(AFFILIATE_PORTAL_PATH, 'layout');
  return {
    ok: true,
    profile: { displayName, bio, socialLinks, preferredLocale: parsed.data.preferredLocale },
    profileCompleted,
  };
}

/* -------------------------------------------------------------------- draft --- */

const draftInputSchema = z
  .object({
    title: z.string().max(1000),
    metaDescription: z.string().max(2000),
    draft: z.unknown(),
    featuredProductIds: z.array(z.string().max(64)).max(STOREFRONT_LIMITS.maxFeaturedProducts),
    expectedDraftVersion: z.number().int().min(0).max(2_147_483_647),
  })
  .strict();

async function readPageState(db: AnyClient, page: AffiliatePageRow): Promise<{ draftVersion: number; status: AffiliatePageStatus } | null> {
  const { data, error } = await db
    .from('affiliate_pages')
    .select('draft_version, approval_status')
    .eq('id', page.id)
    .eq('affiliate_id', page.affiliate_id)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as { draft_version?: unknown; approval_status?: unknown };
  return { draftVersion: Number(row.draft_version) || 0, status: String(row.approval_status) as AffiliatePageStatus };
}

/**
 * Autosave of the storefront draft: title, meta description, the editor document and the
 * featured products. The document is sanitized again here (the editor's output is untrusted
 * input), new featured ids are kept only when they are active public products, and the write is
 * optimistic: it only lands when `draft_version` still equals `expectedDraftVersion` (another tab
 * or device wins otherwise, and the caller is told to reload). Refused while in review.
 */
export async function saveStorefrontDraft(input: unknown): Promise<SaveStorefrontDraftResult> {
  const auth = await authorizeRetailer();
  if (!auth.ok) return auth;
  const { db, actor, profile, page } = auth;
  if (!page) return fail('not_found');

  const parsed = draftInputSchema.safeParse(input);
  if (!parsed.success) return fail('invalid_input');
  if (page.approval_status === 'PENDING_REVIEW') return fail('pending_review');

  const title = cleanLine(parsed.data.title, TITLE_MAX);
  const metaDescription = cleanLine(parsed.data.metaDescription, META_DESCRIPTION_MAX);
  const siteOrigin = await resolvePortalSiteOrigin();
  const { doc } = sanitizeStorefrontDoc(parsed.data.draft, { allowedImageOrigins: getStorefrontImageOrigins(), siteOrigin });

  // Every featured id is checked against the public catalog on every save (the stored list may
  // have been written over the Data API, whose column grant allows it). When the catalog cannot be
  // read, the stored list is left as it is: an unvalidated id is never written by this action.
  const requested = normalizeAffiliateProductIdList(parsed.data.featuredProductIds, STOREFRONT_LIMITS.maxFeaturedProducts);
  let featuredProductIds: string[] | null = [];
  if (requested.length > 0) {
    try {
      featuredProductIds = await filterActiveAffiliateCatalogProductIds(requested, STOREFRONT_LIMITS.maxFeaturedProducts);
    } catch (error) {
      logFailure('featured product check', error);
      featuredProductIds = null;
    }
  }

  const { data, error } = await db
    .from('affiliate_pages')
    .update({
      title,
      meta_description: metaDescription,
      draft_content: doc,
      ...(featuredProductIds ? { featured_product_ids: featuredProductIds } : {}),
    })
    .eq('id', page.id)
    .eq('affiliate_id', profile.id)
    .eq('user_id', actor.userId)
    .eq('draft_version', parsed.data.expectedDraftVersion)
    .select('draft_version, approval_status')
    .maybeSingle();

  if (error) {
    if (isPendingReviewError(error)) return fail('pending_review');
    logFailure('draft save', error);
    // A size CHECK of 02030 (the sanitizer keeps the document under its limit, so this is defense
    // in depth): retrying the same content can never succeed, so say what to do instead.
    if (error.code === '23514') return fail('too_large');
    return fail('unknown');
  }
  if (!data) {
    const current = await readPageState(db, page);
    if (current?.status === 'PENDING_REVIEW') return fail('pending_review');
    return fail('conflict', current ? { currentDraftVersion: current.draftVersion } : {});
  }

  const row = data as { draft_version?: unknown; approval_status?: unknown };
  return {
    ok: true,
    draftVersion: Number(row.draft_version) || parsed.data.expectedDraftVersion,
    approvalStatus: String(row.approval_status) as AffiliatePageStatus,
    featuredProductIds: featuredProductIds ?? page.featured_product_ids,
    title,
    metaDescription,
  };
}

const submitInputSchema = z.object({ expectedDraftVersion: z.number().int().min(0).max(2_147_483_647) }).strict();

/**
 * How long after a submission that was withdrawn (never decided by an admin) the page can be
 * submitted again. Every submission emails the admins, and a withdraw/submit loop needs no admin
 * in between, so without it a scripted loop mailed every admin recipient on every round through
 * the store's SMTP account (review G). After an admin decision (approved, or changes requested)
 * the partner can resubmit at once: the loop cannot go round without the admin.
 */
const SUBMIT_COOLDOWN_MS = 10 * 60_000;

type SubmissionGuard =
  | { kind: 'first' }
  | { kind: 'after_review'; reviewedAt: string }
  | { kind: 'cooldown'; cutoff: string }
  | { kind: 'wait' };

/**
 * Which submissions may land now, from the page as this request read it. Each answer is also a
 * filter on the UPDATE (`submitted_at` IS NULL, <= the decision, < the cooldown cutoff), so
 * concurrent requests that read the same row cannot each land a submission and an email.
 */
function submissionGuardOf(page: AffiliatePageRow, now: number): SubmissionGuard {
  if (!page.submitted_at) return { kind: 'first' };
  const submittedAt = Date.parse(page.submitted_at);
  const reviewedAt = page.reviewed_at ? Date.parse(page.reviewed_at) : Number.NaN;
  if (page.reviewed_at && Number.isFinite(submittedAt) && Number.isFinite(reviewedAt) && reviewedAt >= submittedAt) {
    return { kind: 'after_review', reviewedAt: page.reviewed_at };
  }
  if (Number.isFinite(submittedAt) && now - submittedAt < SUBMIT_COOLDOWN_MS) return { kind: 'wait' };
  return { kind: 'cooldown', cutoff: new Date(now - SUBMIT_COOLDOWN_MS).toISOString() };
}

/**
 * Send the saved draft (and the current profile) for review. The stored draft must match the
 * version the partner looked at, have a title and some content; a published page can be
 * resubmitted only when the profile changed (a draft edit already moved it back to DRAFT).
 * Status, submission time and version are written in their own statement, never together with
 * draft columns. Admins are notified on every submission, so a withdrawn submission can be sent
 * again only `SUBMIT_COOLDOWN_MS` after it was made (`rate_limited` until then). Nothing public
 * changes here (the storefront serves the `published_*` columns), so no public cache is evicted.
 */
export async function submitStorefrontForReview(input: unknown): Promise<SubmitStorefrontResult> {
  const auth = await authorizeRetailer();
  if (!auth.ok) return auth;
  const { db, actor, profile, page } = auth;
  if (!page) return fail('not_found');

  const parsed = submitInputSchema.safeParse(input);
  if (!parsed.success) return fail('invalid_input');
  if (page.approval_status === 'PENDING_REVIEW') return fail('pending_review');
  if (page.draft_version !== parsed.data.expectedDraftVersion) {
    return fail('conflict', { currentDraftVersion: page.draft_version });
  }

  const siteOrigin = await resolvePortalSiteOrigin();
  const { doc } = sanitizeStorefrontDoc(page.draft_content, { allowedImageOrigins: getStorefrontImageOrigins(), siteOrigin });
  if (!page.title.trim()) return fail('missing_title');
  if (isStorefrontDocEmpty(doc)) return fail('empty_storefront');
  if (page.approval_status === 'PUBLISHED' && !hasAffiliateProfileChangedSincePublish(profile, page.published_profile)) {
    return fail('nothing_to_submit');
  }

  const now = Date.now();
  const guard = submissionGuardOf(page, now);
  if (guard.kind === 'wait') return fail('rate_limited');

  const submittedAt = new Date(now).toISOString();
  let submission = db
    .from('affiliate_pages')
    .update({
      approval_status: 'PENDING_REVIEW',
      submitted_at: submittedAt,
      submitted_version: parsed.data.expectedDraftVersion,
    })
    .eq('id', page.id)
    .eq('affiliate_id', profile.id)
    .eq('user_id', actor.userId)
    .eq('draft_version', parsed.data.expectedDraftVersion)
    .in('approval_status', ['DRAFT', 'CHANGES_REQUESTED', 'PUBLISHED']);
  if (guard.kind === 'first') submission = submission.is('submitted_at', null);
  else if (guard.kind === 'after_review') submission = submission.lte('submitted_at', guard.reviewedAt);
  else submission = submission.lt('submitted_at', guard.cutoff);
  const { data, error } = await submission.select('id').maybeSingle();
  if (error) {
    logFailure('submission', error);
    return fail('unknown');
  }
  if (!data) {
    const current = await readPageState(db, page);
    if (current?.status === 'PENDING_REVIEW') return fail('pending_review');
    // Out of review at the version the partner submitted: only the submission guard refused it,
    // because another submission landed in the meantime.
    if (current && current.draftVersion === parsed.data.expectedDraftVersion) return fail('rate_limited');
    return fail('conflict', current ? { currentDraftVersion: current.draftVersion } : {});
  }

  if (!profile.page_submitted_at) {
    const { error: stampError } = await db
      .from('affiliate_profiles')
      .update({ page_submitted_at: submittedAt })
      .eq('id', profile.id)
      .eq('user_id', actor.userId)
      .is('page_submitted_at', null);
    if (stampError) logFailure('submission stamp', stampError);
  }

  scheduleAffiliateLifecycleNotification('PAGE_SUBMITTED', { affiliateId: profile.id, pageId: page.id });
  revalidatePath(AFFILIATE_PORTAL_PATH, 'layout');
  return { ok: true, approvalStatus: 'PENDING_REVIEW', submittedAt };
}

/**
 * Take a pending submission back (to edit it again). The page returns to DRAFT; the approved
 * version, if any, stays live (so no public cache is evicted). The admins' open review alert for
 * the page is closed. Submitting it again waits for the cooldown (`submitStorefrontForReview`).
 */
export async function withdrawStorefrontSubmission(): Promise<WithdrawStorefrontResult> {
  const auth = await authorizeRetailer();
  if (!auth.ok) return auth;
  const { db, actor, profile, page } = auth;
  if (!page) return fail('not_found');
  if (page.approval_status !== 'PENDING_REVIEW') return fail('not_pending');

  const { data, error } = await db
    .from('affiliate_pages')
    .update({ approval_status: 'DRAFT' })
    .eq('id', page.id)
    .eq('affiliate_id', profile.id)
    .eq('user_id', actor.userId)
    .eq('approval_status', 'PENDING_REVIEW')
    .select('id')
    .maybeSingle();
  if (error) {
    logFailure('withdrawal', error);
    return fail('unknown');
  }
  if (!data) return fail('not_pending');

  const { error: alertError } = await db
    .from('system_alerts')
    .update({ is_resolved: true, resolved_at: new Date().toISOString() })
    .eq('alert_type', 'affiliate_page_submitted')
    .eq('is_resolved', false)
    .eq('metadata->>page_id', page.id);
  if (alertError) logFailure('review alert resolution', alertError);

  revalidatePath(AFFILIATE_PORTAL_PATH, 'layout');
  return { ok: true, approvalStatus: 'DRAFT' };
}

/* ----------------------------------------------------------------- catalog --- */

const searchInputSchema = z.object({ query: z.string().max(AFFILIATE_CATALOG_QUERY_MAX_LENGTH * 2) }).strict();
const resolveInputSchema = z
  .object({ ids: z.array(z.string().max(64)).max(AFFILIATE_CATALOG_RESOLVE_LIMIT) })
  .strict();

async function partnerLocale() {
  try {
    return toAffiliatesLocale(await getRequestLocale());
  } catch {
    return 'en' as const;
  }
}

/**
 * The storefront product picker's search: active public products only (anon client), at most 50,
 * the query escaped before it becomes an ILIKE pattern, price labels in the partner's language.
 */
export async function searchStorefrontProducts(input: unknown): Promise<StorefrontProductsResult> {
  const auth = await authorizeRetailer();
  if (!auth.ok) return auth;

  const parsed = searchInputSchema.safeParse(input);
  if (!parsed.success) return fail('invalid_input');

  try {
    const products = await searchAffiliateCatalogProducts({ query: parsed.data.query, locale: await partnerLocale() });
    return { ok: true, products };
  } catch (error) {
    logFailure('product search', error);
    return fail('unknown');
  }
}

/** Details of the given products (at most 48 ids) that are active and public; others are omitted. */
export async function resolveStorefrontProducts(input: unknown): Promise<StorefrontProductsResult> {
  const auth = await authorizeRetailer();
  if (!auth.ok) return auth;

  const parsed = resolveInputSchema.safeParse(input);
  if (!parsed.success) return fail('invalid_input');

  try {
    const products = await resolveAffiliateCatalogProducts({ ids: parsed.data.ids, locale: await partnerLocale() });
    return { ok: true, products };
  } catch (error) {
    logFailure('product lookup', error);
    return fail('unknown');
  }
}

/* ------------------------------------------------------------ Stripe Connect --- */

// The country matters only when the account is created; continuing an existing setup sends none.
const connectInputSchema = z
  .object({ country: z.string().trim().regex(/^[A-Za-z]{2}$/).optional() })
  .strict();

function connectDisabledInSandbox(): boolean {
  return process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';
}

/**
 * The connect service's codes → the portal's. `sandbox`, `suspended` and a store without Stripe
 * (`payouts_not_configured`: retrying cannot help, unlike `connect_unavailable`) are worth
 * telling apart.
 */
function connectErrorOf(error: AffiliateConnectServiceError): RetailerPortalActionError {
  if (error === 'sandbox') return 'sandbox';
  if (error === 'suspended') return 'suspended';
  if (error === 'stripe_not_configured') return 'payouts_not_configured';
  return 'connect_unavailable';
}

/**
 * Start (or continue) Stripe Connect Express onboarding. Returns Stripe's hosted onboarding URL
 * for the browser to open (`window.location`; the CSP's `form-action 'self'` forbids a form post
 * to Stripe). The country must be one the platform offers.
 */
export async function startStripeConnectOnboarding(input: unknown): Promise<StripeConnectRedirectResult> {
  const auth = await authorizeRetailer();
  if (!auth.ok) return auth;
  if (connectDisabledInSandbox()) return fail('sandbox');

  const parsed = connectInputSchema.safeParse(input ?? {});
  if (!parsed.success) return fail('invalid_input');
  const country = parsed.data.country?.toUpperCase() ?? null;

  try {
    if (country) {
      const options = await getAffiliateConnectCountryOptions();
      if (!options.countries.some((option) => option.code === country)) return fail('invalid_input');
    }

    const result = await startAffiliateConnectOnboarding(auth.actor, country ? { country } : {});
    if (!result.ok) return fail(connectErrorOf(result.error));
    const url = readAffiliateStripeRedirectUrl(result.url);
    if (!url) return fail('connect_unavailable');
    return { ok: true, url };
  } catch (error) {
    logFailure('Connect onboarding', error);
    return fail('connect_unavailable');
  }
}

/** Re-read the Connect account from Stripe (readiness comes from Stripe, never from the URL). */
export async function refreshStripeConnectStatus(): Promise<StripeConnectRefreshResult> {
  const auth = await authorizeRetailer();
  if (!auth.ok) return auth;
  if (connectDisabledInSandbox()) return fail('sandbox');

  try {
    const result = await refreshAffiliateConnectStatus(auth.actor);
    if (!result.ok) return fail(connectErrorOf(result.error));
    revalidatePath(AFFILIATE_PORTAL_PATH, 'layout');
    return { ok: true, ready: result.status.ready === true };
  } catch (error) {
    logFailure('Connect status refresh', error);
    return fail('connect_unavailable');
  }
}

/** A one-time login link to the partner's Stripe Express dashboard (connected accounts only). */
export async function openStripeExpressDashboard(): Promise<StripeConnectRedirectResult> {
  const auth = await authorizeRetailer();
  if (!auth.ok) return auth;
  if (connectDisabledInSandbox()) return fail('sandbox');
  if (!auth.profile.stripe_connect_account_id) return fail('connect_unavailable');

  try {
    const result = await createAffiliateExpressDashboardLink(auth.actor);
    if (!result.ok) return fail(connectErrorOf(result.error));
    const url = readAffiliateStripeRedirectUrl(result.url);
    if (!url) return fail('connect_unavailable');
    return { ok: true, url };
  } catch (error) {
    logFailure('Express dashboard link', error);
    return fail('connect_unavailable');
  }
}

/* ------------------------------------------------------------- payout email --- */

/**
 * The raw input, bounded before anything reads it: the address (`''` clears it) and what it is for
 * (02037: `paypal`, a PayPal account, or `interac`, an Interac e-Transfer address). Both required.
 */
const payoutEmailInputSchema = z
  .object({ payoutEmail: z.string().max(1024), payoutEmailKind: z.enum(AFFILIATE_PAYOUT_EMAIL_KINDS) })
  .strict();

/** One email address of at most 254 characters (the 02036 CHECK's limit), checked once normalized. */
const payoutEmailSchema = z.email().max(AFFILIATE_PAYOUT_EMAIL_MAX_LENGTH);

/**
 * Set or clear where the partner's payouts outside Stripe go: the address of
 * `affiliate_profiles.payout_email` (02036) and what it is for, `payout_email_kind` (02037: a PayPal
 * account, which automatic PayPal Payouts and the CMS PayPal payouts file pay, or an Interac
 * e-Transfer address, which the store pays by hand under "Pay manually"). `''` clears the address.
 * It is trimmed and lowercased by `normalizeAffiliatePayoutEmail` (HTML's email grammar with a dot in
 * the domain: no whitespace, quote, comma or angle bracket) and must also pass zod's email rule; a
 * PayPal address must also be one PayPal can take as is (`isAffiliatePayPalPayoutReceiver`: at most
 * 127 characters, the claim's own rule), so a partner is never told PayPal pays them when the run
 * would skip them. The columns have no Data API grant and the profile guard refuses them from a
 * partner session, so the portal writes them with the service role, on the caller's own row only (the
 * affiliate and user ids of the actor). Refused on the public sandbox right after the partner check:
 * the demo partner is shared, so a visitor's address would be shown to every later visitor and listed
 * in the payouts file. It mails nobody. A PayPal payout already in flight keeps the address it was
 * sent to (`paypal_receiver`); the next one uses the new address. Every save stamps
 * `payout_email_saved_at` (02037), the same address included: a save after PayPal returned a payout
 * from an address lets the run try PayPal there again ("Try PayPal again" once the partner opened or
 * confirmed their PayPal account).
 */
export async function saveRetailerPayoutEmail(input: unknown): Promise<SaveRetailerPayoutEmailResult> {
  const auth = await authorizeRetailer();
  if (!auth.ok) return auth;
  if (process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') return fail('sandbox');
  const { db, actor, profile } = auth;

  const parsed = payoutEmailInputSchema.safeParse(input);
  if (!parsed.success) return fail('invalid_input');
  const payoutEmailKind = parsed.data.payoutEmailKind;
  const email = normalizeAffiliatePayoutEmail(parsed.data.payoutEmail);
  if (email === null || (email !== '' && !payoutEmailSchema.safeParse(email).success)) return fail('invalid_payout_email');
  if (email !== '' && payoutEmailKind === 'paypal' && !isAffiliatePayPalPayoutReceiver(email, payoutEmailKind)) {
    return fail('invalid_payout_email');
  }
  const payoutEmail = email || null;

  const { data, error } = await db
    .from('affiliate_profiles')
    .update({ payout_email: payoutEmail, payout_email_kind: payoutEmailKind, payout_email_saved_at: new Date().toISOString() })
    .eq('id', profile.id)
    .eq('user_id', actor.userId)
    .select('id')
    .maybeSingle();
  if (error) {
    logFailure('payout email save', error);
    return fail('unknown');
  }
  if (!data) return fail('not_found');

  // The overview's onboarding step and the payouts page read it.
  revalidatePath(AFFILIATE_PORTAL_PATH, 'layout');
  return { ok: true, payoutEmail, payoutEmailKind };
}
