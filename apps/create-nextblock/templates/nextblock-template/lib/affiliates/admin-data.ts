import 'server-only';

import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';
import {
  AFFILIATE_ALERT_TYPES,
  AFFILIATE_ONBOARDING_STEPS,
  affiliateTierHasCapacity,
  diffStorefrontBlocks,
  isAffiliateCommissionStatus,
  isAffiliatePayoutStatus,
  isAffiliateStatus,
  isStorefrontDocEmpty,
  sanitizeAffiliateSocialLinks,
  selectAffiliateSignupTier,
  type AffiliateBadgeColor,
  type AffiliateCommissionRow,
  type AffiliateCommissionStatus,
  type AffiliateOnboardingStep,
  type AffiliatePageRow,
  type AffiliatePageStatus,
  type AffiliatePayoutRow,
  type AffiliatePayoutStatus,
  type AffiliateProfileRow,
  type AffiliatePublishedProfile,
  type AffiliateSocialLinks,
  type AffiliateStatus,
  type AffiliateTierRow,
  type AffiliatesSettings,
  type StorefrontBlockDiff,
  type StorefrontDoc,
} from '@nextblock-cms/affiliates';
import {
  AFFILIATE_PAYOUT_CLOSED_FAILURE_REASONS,
  computeAffiliateBalances,
  getAffiliatePageById,
  getAffiliateProfileById,
  listAffiliateCommissions,
  listAffiliatePayouts,
  listAffiliateProfiles,
  listAffiliateTiers,
  normalizeAffiliateUuid,
  type AffiliateBalanceInputRow,
  type AffiliateRepositoryClient,
} from '@nextblock-cms/affiliates/server';
import { getCmsActor } from '../auth/cms-actor';
import { usableEmail } from '../email/placeholder-address';
import { resolveMediaUrl } from '../media/resolveMediaUrl';
import { resolveSiteUrl } from '../site-url';
import { getStorefrontImageOrigins } from './image-origins';
import {
  buildAffiliatePublishedProfile,
  fingerprintAffiliatePublishedProfile,
  normalizeAffiliateFeaturedProductIds,
  sanitizeAffiliateDraftForReview,
} from './review';
import { getAffiliatesSettings, normalizeAffiliateNotificationEmail } from './settings';
import { isAffiliatesProgramActive } from './package-state';

/**
 * Reads behind the /cms/affiliates screens (overview, tiers, approvals, payouts).
 *
 * Every loader takes the service-role client from `requireCmsAdmin()`: the page authorizes first,
 * then reads. The affiliate tables are service-role-write only and their admin SELECT policies
 * require an aal2 session (`is_admin_mfa()`), which a "remember this device" admin does not have,
 * so the cookie client would show the people this screen exists for an empty program. Under the
 * service role RLS is not a boundary: the in-code admin check is.
 *
 * The one exception is {@link getAffiliateApprovalsBadgeCount}, which the CMS layout calls for
 * every staff page: it verifies the ADMIN itself (React-cached actor) before it builds a client.
 *
 * Loaders throw {@link AffiliateAdminDataError} (a generic message; the PostgREST code is kept for
 * logs) so a page can show a "could not load" card instead of a stack trace.
 */

export class AffiliateAdminDataError extends Error {
  readonly operation: string;
  readonly code: string | null;

  constructor(operation: string, cause: unknown) {
    super(`Affiliate admin data: ${operation} failed`, { cause });
    this.name = 'AffiliateAdminDataError';
    this.operation = operation;
    const code = cause && typeof cause === 'object' ? (cause as { code?: unknown }).code : undefined;
    this.code = typeof code === 'string' && code ? code : null;
  }
}

/** The service-role client, read untyped (the generated types do not know the 02030 tables yet). */
export function toAffiliateAdminClient(client: unknown): AffiliateRepositoryClient {
  return client as AffiliateRepositoryClient;
}

/** Every `system_alerts.alert_type` this package writes (banner types and informational ones). */
export const AFFILIATE_ADMIN_ALERT_TYPES: readonly string[] = Object.values(AFFILIATE_ALERT_TYPES);

/** Pending storefront approvals for the sidebar badge. ADMIN only; 0 on any error or when inactive. */
export async function getAffiliateApprovalsBadgeCount(): Promise<number> {
  try {
    const actor = await getCmsActor();
    if (actor?.role !== 'ADMIN') return 0;
    if (!(await isAffiliatesProgramActive())) return 0;

    const db = toAffiliateAdminClient(getServiceRoleSupabaseClient());
    const { count, error } = await db
      .from('affiliate_pages')
      .select('id', { count: 'exact', head: true })
      .eq('approval_status', 'PENDING_REVIEW');
    if (error) return 0;
    return typeof count === 'number' && count > 0 ? count : 0;
  } catch {
    return 0;
  }
}

/** `currencies.is_default` (the currency commissions are recorded and paid in), else USD. */
export async function getAffiliateStoreBaseCurrency(db: AffiliateRepositoryClient): Promise<string> {
  try {
    const { data, error } = await db.from('currencies').select('code').eq('is_default', true).limit(1).maybeSingle();
    const raw = !error && data && typeof (data as { code?: unknown }).code === 'string' ? (data as { code: string }).code : '';
    const code = raw.trim().toUpperCase();
    return /^[A-Z]{3}$/.test(code) ? code : 'USD';
  } catch {
    return 'USD';
  }
}

/* ------------------------------------------------------------------ query params --- */

type SearchParamValue = string | string[] | undefined;

function firstParam(value: SearchParamValue): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' ? raw : '';
}

/** `?page=` as a positive integer (1 for anything else), capped so offsets stay sane. */
export function parseAffiliateAdminPage(value: SearchParamValue): number {
  const page = Number.parseInt(firstParam(value), 10);
  return Number.isInteger(page) && page >= 1 ? Math.min(page, 10_000) : 1;
}

/** `?pageSize=` restricted to the pagination control's options (25 by default). */
export function parseAffiliateAdminPageSize(value: SearchParamValue): number {
  const size = Number.parseInt(firstParam(value), 10);
  return [10, 25, 50, 100].includes(size) ? size : 25;
}

export interface AffiliateOverviewFilters {
  status: AffiliateStatus | null;
  tierId: string | null;
  /** Free text, trimmed and capped; the repository escapes it before `.ilike()`. */
  search: string;
  page: number;
  pageSize: number;
}

export function parseAffiliateOverviewFilters(params: Record<string, SearchParamValue>): AffiliateOverviewFilters {
  const status = firstParam(params['status']).toUpperCase();
  return {
    status: isAffiliateStatus(status) ? status : null,
    tierId: normalizeAffiliateUuid(firstParam(params['tier'])),
    search: firstParam(params['q']).trim().slice(0, 80),
    page: parseAffiliateAdminPage(params['page']),
    pageSize: parseAffiliateAdminPageSize(params['pageSize']),
  };
}

/* ----------------------------------------------------------------------- overview --- */

export interface AffiliateOverviewMetrics {
  baseCurrency: string;
  partners: { total: number; active: number; suspended: number; approved: number };
  steps: Record<AffiliateOnboardingStep, number>;
  liveStorefronts: number;
  pendingApprovals: number;
  clicks: number;
  /** Base-currency minor units, net of partial refunds. */
  pendingClearanceCents: number;
  clearedCents: number;
  /** Cleared commissions attached to an in-flight or failed payout. */
  processingCents: number;
  /** Sum of `affiliate_profiles.total_paid_cents` (completed payouts). */
  paidLifetimeCents: number;
  /** Open balances recorded in a currency other than the base one (rare: the store currency changed). */
  otherCurrencies: Array<{ currency: string; pendingCents: number; clearedCents: number; processingCents: number }>;
  /** True when a scan hit its row cap (the totals are then a lower bound). */
  truncated: boolean;
}

export interface AffiliatePartnerListItem {
  id: string;
  /** The partner's auth user (for the email lookup of the visible rows). */
  userId: string;
  handle: string;
  displayName: string;
  status: AffiliateStatus;
  suspendedReason: string | null;
  onboardingStep: AffiliateOnboardingStep;
  tierId: string;
  tierName: string;
  tierBadgeColor: AffiliateBadgeColor | null;
  /** In the current tier since: `tier_changed_at` (02035), else `created_at` (the sign-up tier). */
  tierSince: string;
  totalClicks: number;
  totalEarnedCents: number;
  totalPaidCents: number;
  createdAt: string;
  /** `first_published_at` is set: the partner can earn (ADDENDUM A12). */
  isApproved: boolean;
  payoutsReady: boolean;
  pageId: string | null;
  pageStatus: AffiliatePageStatus | null;
  hasPublishedPage: boolean;
}

export interface AffiliateActivityItem {
  id: string;
  alertType: string;
  /** `metadata.kind` when it is a plain code (`connect_setup`, `insufficient_balance`: platform-wide Stripe alerts). */
  kind: string | null;
  title: string;
  message: string;
  createdAt: string;
  isResolved: boolean;
  affiliateId: string | null;
  pageId: string | null;
  payoutId: string | null;
  orderId: string | null;
}

export interface AffiliateOverviewData {
  metrics: AffiliateOverviewMetrics;
  tiers: AffiliateTierRow[];
  partners: { rows: AffiliatePartnerListItem[]; total: number };
  activity: AffiliateActivityItem[];
  settings: AffiliatesSettings;
}

const SCAN_PAGE_SIZE = 1000;
const SCAN_MAX_PAGES = 50;
const ACTIVITY_LIMIT = 30;

function emptySteps(): Record<AffiliateOnboardingStep, number> {
  const steps = {} as Record<AffiliateOnboardingStep, number>;
  for (const step of AFFILIATE_ONBOARDING_STEPS) steps[step] = 0;
  return steps;
}

function toCount(value: unknown): number {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

interface ProfileScan {
  total: number;
  active: number;
  suspended: number;
  approved: number;
  clicks: number;
  paidCents: number;
  steps: Record<AffiliateOnboardingStep, number>;
  truncated: boolean;
}

async function scanProfiles(db: AffiliateRepositoryClient): Promise<ProfileScan> {
  const scan: ProfileScan = { total: 0, active: 0, suspended: 0, approved: 0, clicks: 0, paidCents: 0, steps: emptySteps(), truncated: false };

  for (let page = 0; page < SCAN_MAX_PAGES; page += 1) {
    const from = page * SCAN_PAGE_SIZE;
    const { data, error } = await db
      .from('affiliate_profiles')
      .select('id, status, onboarding_step, total_clicks, total_paid_cents, first_published_at')
      .order('id', { ascending: true })
      .range(from, from + SCAN_PAGE_SIZE - 1);
    if (error) throw new AffiliateAdminDataError('scan partners', error);

    const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    for (const row of rows) {
      scan.total += 1;
      if (row['status'] === 'SUSPENDED') scan.suspended += 1;
      else scan.active += 1;
      if (typeof row['first_published_at'] === 'string') scan.approved += 1;
      const step = row['onboarding_step'];
      if (typeof step === 'string' && step in scan.steps) scan.steps[step as AffiliateOnboardingStep] += 1;
      scan.clicks += toCount(row['total_clicks']);
      scan.paidCents += toCount(row['total_paid_cents']);
    }

    if (rows.length < SCAN_PAGE_SIZE) return scan;
  }

  scan.truncated = true;
  return scan;
}

async function scanOpenCommissions(db: AffiliateRepositoryClient): Promise<{ rows: AffiliateBalanceInputRow[]; truncated: boolean }> {
  const rows: AffiliateBalanceInputRow[] = [];

  for (let page = 0; page < SCAN_MAX_PAGES; page += 1) {
    const from = page * SCAN_PAGE_SIZE;
    const { data, error } = await db
      .from('affiliate_commissions')
      .select('id, status, currency, commission_amount_cents, refunded_amount_cents, payout_id, clears_at')
      .in('status', ['PENDING_CLEARANCE', 'CLEARED'])
      .order('id', { ascending: true })
      .range(from, from + SCAN_PAGE_SIZE - 1);
    if (error) throw new AffiliateAdminDataError('scan open commissions', error);

    const batch = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    for (const row of batch) {
      if (!isAffiliateCommissionStatus(row['status'])) continue;
      rows.push({
        status: row['status'],
        currency: typeof row['currency'] === 'string' ? row['currency'] : 'USD',
        commission_amount_cents: toCount(row['commission_amount_cents']),
        refunded_amount_cents: toCount(row['refunded_amount_cents']),
        payout_id: typeof row['payout_id'] === 'string' ? row['payout_id'] : null,
        clears_at: typeof row['clears_at'] === 'string' ? row['clears_at'] : '',
      });
    }

    if (batch.length < SCAN_PAGE_SIZE) return { rows, truncated: false };
  }

  return { rows, truncated: true };
}

async function countPendingApprovals(db: AffiliateRepositoryClient): Promise<number> {
  const { count, error } = await db
    .from('affiliate_pages')
    .select('id', { count: 'exact', head: true })
    .eq('approval_status', 'PENDING_REVIEW');
  if (error) throw new AffiliateAdminDataError('count pending approvals', error);
  return toCount(count);
}

/** Live storefronts, judged exactly like the public page: the anon storefront list RPC. */
async function countLiveStorefronts(db: AffiliateRepositoryClient): Promise<number> {
  const { data, error } = await db.rpc('list_affiliate_storefronts', { p_limit: 5000 });
  if (error) throw new AffiliateAdminDataError('count live storefronts', error);
  return Array.isArray(data) ? data.length : 0;
}

function readMetadataId(metadata: Record<string, unknown>, key: string): string | null {
  return normalizeAffiliateUuid(metadata[key]);
}

function readMetadataKind(metadata: Record<string, unknown>): string | null {
  const kind = metadata['kind'];
  return typeof kind === 'string' && /^[a-z][a-z0-9_]{0,40}$/.test(kind) ? kind : null;
}

/** The newest affiliate alerts (resolved and not), for the overview feed. */
export async function listAffiliateActivity(db: AffiliateRepositoryClient, limit = ACTIVITY_LIMIT): Promise<AffiliateActivityItem[]> {
  const { data, error } = await db
    .from('system_alerts')
    .select('id, alert_type, title, message, metadata, is_resolved, created_at')
    .in('alert_type', [...AFFILIATE_ADMIN_ALERT_TYPES])
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(1, Math.trunc(limit)), 100));
  if (error) throw new AffiliateAdminDataError('list affiliate activity', error);

  const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
  return rows
    .filter((row) => typeof row['id'] === 'string')
    .map((row) => {
      const metadata =
        row['metadata'] && typeof row['metadata'] === 'object' && !Array.isArray(row['metadata'])
          ? (row['metadata'] as Record<string, unknown>)
          : {};
      return {
        id: row['id'] as string,
        alertType: typeof row['alert_type'] === 'string' ? row['alert_type'] : '',
        kind: readMetadataKind(metadata),
        title: typeof row['title'] === 'string' ? row['title'] : '',
        message: typeof row['message'] === 'string' ? row['message'] : '',
        createdAt: typeof row['created_at'] === 'string' ? row['created_at'] : '',
        isResolved: row['is_resolved'] === true,
        affiliateId: readMetadataId(metadata, 'affiliate_id'),
        pageId: readMetadataId(metadata, 'page_id'),
        payoutId: readMetadataId(metadata, 'payout_id'),
        orderId: readMetadataId(metadata, 'order_id'),
      };
    });
}

type PageSummary = Pick<AffiliatePageRow, 'id' | 'affiliate_id' | 'approval_status' | 'published_at'>;

async function loadPageSummaries(db: AffiliateRepositoryClient, affiliateIds: string[]): Promise<Map<string, PageSummary>> {
  const ids = [...new Set(affiliateIds.map((id) => normalizeAffiliateUuid(id)).filter((id): id is string => Boolean(id)))];
  const pages = new Map<string, PageSummary>();
  if (ids.length === 0) return pages;

  const { data, error } = await db.from('affiliate_pages').select('id, affiliate_id, approval_status, published_at').in('affiliate_id', ids);
  if (error) throw new AffiliateAdminDataError('load storefront summaries', error);

  for (const row of Array.isArray(data) ? (data as Array<Record<string, unknown>>) : []) {
    if (typeof row['id'] !== 'string' || typeof row['affiliate_id'] !== 'string') continue;
    const status = row['approval_status'];
    pages.set(row['affiliate_id'], {
      id: row['id'],
      affiliate_id: row['affiliate_id'],
      approval_status: (typeof status === 'string' ? status : 'DRAFT') as AffiliatePageStatus,
      published_at: typeof row['published_at'] === 'string' ? row['published_at'] : null,
    });
  }
  return pages;
}

function toPartnerListItem(
  profile: AffiliateProfileRow,
  tiers: Map<string, AffiliateTierRow>,
  page: PageSummary | undefined
): AffiliatePartnerListItem {
  const tier = tiers.get(profile.tier_id);
  return {
    id: profile.id,
    userId: profile.user_id,
    handle: profile.handle,
    displayName: profile.display_name,
    status: profile.status,
    suspendedReason: profile.suspended_reason,
    onboardingStep: profile.onboarding_step,
    tierId: profile.tier_id,
    tierName: tier?.name ?? 'Unknown tier',
    tierBadgeColor: tier?.badge_color ?? null,
    tierSince: profile.tier_changed_at ?? profile.created_at,
    totalClicks: profile.total_clicks,
    totalEarnedCents: profile.total_earned_cents,
    totalPaidCents: profile.total_paid_cents,
    createdAt: profile.created_at,
    isApproved: Boolean(profile.first_published_at),
    payoutsReady: profile.stripe_connect_onboarding_complete,
    pageId: page?.id ?? null,
    pageStatus: page?.approval_status ?? null,
    hasPublishedPage: Boolean(page?.published_at),
  };
}

/** Everything the overview renders, in one round of parallel reads. */
export async function loadAffiliateOverview(
  db: AffiliateRepositoryClient,
  filters: AffiliateOverviewFilters
): Promise<AffiliateOverviewData> {
  const offset = (filters.page - 1) * filters.pageSize;

  try {
    const [baseCurrency, tiers, partnerPage, profileScan, commissionScan, pendingApprovals, liveStorefronts, activity, settings] =
      await Promise.all([
        getAffiliateStoreBaseCurrency(db),
        listAffiliateTiers(db, { includeInactive: true }),
        listAffiliateProfiles(db, {
          status: filters.status,
          tierId: filters.tierId,
          search: filters.search || null,
          limit: filters.pageSize,
          offset,
        }),
        scanProfiles(db),
        scanOpenCommissions(db),
        countPendingApprovals(db),
        countLiveStorefronts(db),
        listAffiliateActivity(db),
        getAffiliatesSettings(),
      ]);

    const tiersById = new Map(tiers.map((tier) => [tier.id, tier]));
    const pages = await loadPageSummaries(
      db,
      partnerPage.rows.map((row) => row.id)
    );
    const balances = computeAffiliateBalances(commissionScan.rows, { baseCurrency });

    return {
      metrics: {
        baseCurrency,
        partners: {
          total: profileScan.total,
          active: profileScan.active,
          suspended: profileScan.suspended,
          approved: profileScan.approved,
        },
        steps: profileScan.steps,
        liveStorefronts,
        pendingApprovals,
        clicks: profileScan.clicks,
        pendingClearanceCents: balances.primary.pendingCents,
        clearedCents: balances.primary.clearedCents,
        processingCents: balances.primary.processingCents,
        paidLifetimeCents: profileScan.paidCents,
        otherCurrencies: balances.byCurrency
          .filter((entry) => entry.currency !== balances.primary.currency)
          .map((entry) => ({
            currency: entry.currency,
            pendingCents: entry.pendingCents,
            clearedCents: entry.clearedCents,
            processingCents: entry.processingCents,
          })),
        truncated: profileScan.truncated || commissionScan.truncated,
      },
      tiers,
      partners: {
        rows: partnerPage.rows.map((profile) => toPartnerListItem(profile, tiersById, pages.get(profile.id))),
        total: partnerPage.count,
      },
      activity,
      settings,
    };
  } catch (error) {
    if (error instanceof AffiliateAdminDataError) throw error;
    throw new AffiliateAdminDataError('load overview', error);
  }
}

/* -------------------------------------------------------------------------- tiers --- */

export type AffiliateTierWarningCode =
  | 'no_active_tier'
  | 'no_default_tier'
  | 'multiple_promo_tiers'
  | 'promo_not_default'
  | 'promo_shadowed'
  | 'default_tiers_full'
  | 'program_full';

export interface AffiliateTierWarning {
  code: AffiliateTierWarningCode;
  message: string;
}

function tierNames(tiers: readonly AffiliateTierRow[]): string {
  return tiers.map((tier) => tier.name).join(', ');
}

/**
 * Configuration problems the Tiers screen warns about. Mirrors how `create_affiliate_account`
 * picks a signup tier (`selectAffiliateSignupTier`: active tiers, defaults first with the highest
 * sort order first, the first one with room) and how the /partners page picks its featured promo
 * (`selectAffiliatePromoTier`: that signup tier, when it is a default promo tier).
 */
export function describeAffiliateTierWarnings(tiers: readonly AffiliateTierRow[]): AffiliateTierWarning[] {
  const warnings: AffiliateTierWarning[] = [];
  const active = tiers.filter((tier) => tier.is_active);

  if (active.length === 0) {
    warnings.push({
      code: 'no_active_tier',
      message: 'No tier is active, so new partners cannot sign up. Activate at least one tier.',
    });
    return warnings;
  }

  const defaults = active.filter((tier) => tier.is_default_signup_tier);
  if (defaults.length === 0) {
    warnings.push({
      code: 'no_default_tier',
      message:
        'No active tier is marked as the default signup tier. New partners join the first active tier with room, in sort order.',
    });
  }

  const promos = active.filter((tier) => tier.is_limited_time_promo);
  if (promos.length > 1) {
    warnings.push({
      code: 'multiple_promo_tiers',
      message: `${promos.length} active tiers are marked as limited-time promos (${tierNames(promos)}). The partners page features only one; keep a single promo tier.`,
    });
  }

  const promoNotDefault = promos.filter((tier) => !tier.is_default_signup_tier);
  if (promoNotDefault.length > 0) {
    warnings.push({
      code: 'promo_not_default',
      message: `${tierNames(promoNotDefault)} ${promoNotDefault.length === 1 ? 'is a promo tier but is not' : 'are promo tiers but are not'} the default signup tier, so new partners never join ${promoNotDefault.length === 1 ? 'it' : 'them'} and the partners page does not feature ${promoNotDefault.length === 1 ? 'it' : 'them'}.`,
    });
  }

  // A default promo tier with room that signups skip: another default tier ranks ahead of it (the
  // CMS gives a new tier the next, higher sort order). The page drops the offer meanwhile.
  const signup = selectAffiliateSignupTier(active);
  const shadowedPromos =
    signup && !signup.is_limited_time_promo
      ? promos.filter((tier) => tier.is_default_signup_tier && affiliateTierHasCapacity(tier))
      : [];
  if (signup && shadowedPromos.length > 0) {
    const one = shadowedPromos.length === 1;
    warnings.push({
      code: 'promo_shadowed',
      message: `New partners join ${signup.name} first, so ${tierNames(shadowedPromos)} (the launch offer) ${one ? 'is' : 'are'} neither assigned nor shown on the partners page while ${signup.name} has room. Among default tiers, signups fill the highest sort order first: give the promo tier a higher sort order than ${signup.name}.`,
    });
  }

  if (!active.some((tier) => affiliateTierHasCapacity(tier))) {
    warnings.push({
      code: 'program_full',
      message: 'Every active tier is full, so signups are refused. Raise a partner cap or add a tier.',
    });
  } else if (defaults.length > 0 && !defaults.some((tier) => affiliateTierHasCapacity(tier))) {
    warnings.push({
      code: 'default_tiers_full',
      message: `The default signup ${defaults.length === 1 ? 'tier is' : 'tiers are'} full (${tierNames(defaults)}). New partners now join the next active tier with room.`,
    });
  }

  return warnings;
}

export async function loadAffiliateTiersAdmin(
  db: AffiliateRepositoryClient
): Promise<{ tiers: AffiliateTierRow[]; warnings: AffiliateTierWarning[] }> {
  try {
    const tiers = await listAffiliateTiers(db, { includeInactive: true });
    return { tiers, warnings: describeAffiliateTierWarnings(tiers) };
  } catch (error) {
    throw new AffiliateAdminDataError('load tiers', error);
  }
}

/* ---------------------------------------------------------------------- approvals --- */

export interface AffiliateApprovalQueueItem {
  pageId: string;
  affiliateId: string;
  /** The partner's auth user (for the email lookup of the visible rows). */
  userId: string | null;
  handle: string;
  displayName: string;
  partnerStatus: AffiliateStatus | null;
  tierName: string | null;
  tierBadgeColor: AffiliateBadgeColor | null;
  title: string;
  submittedAt: string | null;
  draftVersion: number;
  /**
   * The partner was never approved (`first_published_at` is empty, as on the review page): this
   * review decides whether they can earn at all.
   */
  isFirstPublication: boolean;
}

export interface AffiliateRecentReviewItem {
  pageId: string;
  handle: string;
  displayName: string;
  status: AffiliatePageStatus;
  /** A paused partner's published page is offline: the list says "Paused", not "Published". */
  partnerStatus: AffiliateStatus | null;
  reviewedAt: string;
}

type ProfileSummary = Pick<
  AffiliateProfileRow,
  'id' | 'user_id' | 'handle' | 'display_name' | 'status' | 'tier_id' | 'first_published_at'
>;

async function loadProfileSummaries(db: AffiliateRepositoryClient, affiliateIds: string[]): Promise<Map<string, ProfileSummary>> {
  const ids = [...new Set(affiliateIds.map((id) => normalizeAffiliateUuid(id)).filter((id): id is string => Boolean(id)))];
  const profiles = new Map<string, ProfileSummary>();
  if (ids.length === 0) return profiles;

  const { data, error } = await db
    .from('affiliate_profiles')
    .select('id, user_id, handle, display_name, status, tier_id, first_published_at')
    .in('id', ids);
  if (error) throw new AffiliateAdminDataError('load partner summaries', error);

  for (const row of Array.isArray(data) ? (data as Array<Record<string, unknown>>) : []) {
    if (typeof row['id'] !== 'string') continue;
    profiles.set(row['id'], {
      id: row['id'],
      user_id: typeof row['user_id'] === 'string' ? row['user_id'] : '',
      handle: typeof row['handle'] === 'string' ? row['handle'] : '',
      display_name: typeof row['display_name'] === 'string' ? row['display_name'] : '',
      status: isAffiliateStatus(row['status']) ? row['status'] : 'SUSPENDED',
      tier_id: typeof row['tier_id'] === 'string' ? row['tier_id'] : '',
      first_published_at: typeof row['first_published_at'] === 'string' ? row['first_published_at'] : null,
    });
  }
  return profiles;
}

/**
 * PostgREST answers an offset past the last row with 416 `PGRST103` and no count (supabase-js
 * hands it over as `error`). For a paged admin list that is an empty page, not a load failure: the
 * list shrank under a stale `?page=` (reviews, removals) or someone typed a page number.
 */
function isAffiliateRangeNotSatisfiable(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'PGRST103');
}

export async function loadAffiliateApprovalQueue(
  db: AffiliateRepositoryClient,
  options: { page: number; pageSize: number }
): Promise<{ items: AffiliateApprovalQueueItem[]; total: number; recentlyReviewed: AffiliateRecentReviewItem[] }> {
  const from = (options.page - 1) * options.pageSize;

  try {
    const [queue, recent, tiers] = await Promise.all([
      db
        .from('affiliate_pages')
        .select('id, affiliate_id, title, submitted_at, draft_version, published_at', { count: 'exact' })
        .eq('approval_status', 'PENDING_REVIEW')
        .order('submitted_at', { ascending: true, nullsFirst: false })
        .order('id', { ascending: true })
        .range(from, from + options.pageSize - 1),
      // A partner's edit after the review moves the page back to DRAFT, which no longer says what
      // the review decided: only the two outcomes that are still visible are listed.
      db
        .from('affiliate_pages')
        .select('id, affiliate_id, approval_status, reviewed_at')
        .not('reviewed_at', 'is', null)
        .in('approval_status', ['PUBLISHED', 'CHANGES_REQUESTED'])
        .order('reviewed_at', { ascending: false })
        .limit(8),
      listAffiliateTiers(db, { includeInactive: true }),
    ]);
    if (recent.error) throw new AffiliateAdminDataError('list reviewed storefronts', recent.error);
    let queueRows: Array<Record<string, unknown>>;
    let queueTotal: number | null;
    if (queue.error && isAffiliateRangeNotSatisfiable(queue.error)) {
      // A page past the end (the queue shrinks with every review; a stale ?page=): an empty page
      // with the real total, which the screen turns into a way back to the first page.
      queueRows = [];
      queueTotal = await countPendingApprovals(db);
    } else {
      if (queue.error) throw new AffiliateAdminDataError('list pending storefronts', queue.error);
      queueRows = Array.isArray(queue.data) ? (queue.data as Array<Record<string, unknown>>) : [];
      queueTotal = typeof queue.count === 'number' ? queue.count : null;
    }
    const recentRows = Array.isArray(recent.data) ? (recent.data as Array<Record<string, unknown>>) : [];
    const profiles = await loadProfileSummaries(db, [
      ...queueRows.map((row) => String(row['affiliate_id'] ?? '')),
      ...recentRows.map((row) => String(row['affiliate_id'] ?? '')),
    ]);
    const tiersById = new Map(tiers.map((tier) => [tier.id, tier]));

    const items = queueRows
      .filter((row) => typeof row['id'] === 'string' && typeof row['affiliate_id'] === 'string')
      .map((row): AffiliateApprovalQueueItem => {
        const profile = profiles.get(row['affiliate_id'] as string);
        const tier = profile ? tiersById.get(profile.tier_id) : undefined;
        return {
          pageId: row['id'] as string,
          affiliateId: row['affiliate_id'] as string,
          userId: profile?.user_id || null,
          handle: profile?.handle ?? '',
          displayName: profile?.display_name ?? 'Unknown partner',
          partnerStatus: profile?.status ?? null,
          tierName: tier?.name ?? null,
          tierBadgeColor: tier?.badge_color ?? null,
          title: typeof row['title'] === 'string' ? row['title'] : '',
          submittedAt: typeof row['submitted_at'] === 'string' ? row['submitted_at'] : null,
          draftVersion: Math.max(1, Math.trunc(Number(row['draft_version']) || 1)),
          // Judged like the review page (the partner's first approval), the page as a fallback.
          isFirstPublication: profile ? !profile.first_published_at : typeof row['published_at'] !== 'string',
        };
      });

    const recentlyReviewed = recentRows
      .filter((row) => typeof row['id'] === 'string' && typeof row['reviewed_at'] === 'string')
      .map((row): AffiliateRecentReviewItem => {
        const profile = profiles.get(String(row['affiliate_id'] ?? ''));
        const status = row['approval_status'];
        return {
          pageId: row['id'] as string,
          handle: profile?.handle ?? '',
          displayName: profile?.display_name ?? 'Unknown partner',
          status: (typeof status === 'string' ? status : 'DRAFT') as AffiliatePageStatus,
          partnerStatus: profile?.status ?? null,
          reviewedAt: row['reviewed_at'] as string,
        };
      });

    return { items, total: queueTotal ?? items.length, recentlyReviewed };
  } catch (error) {
    if (error instanceof AffiliateAdminDataError) throw error;
    throw new AffiliateAdminDataError('load approval queue', error);
  }
}

/* ----------------------------------------------------------------- storefronts --- */

/**
 * What the public sees of a storefront that has been published: `live` (served at
 * `/partners/<handle>`: the partner is ACTIVE and approved), `paused` (the partner is SUSPENDED,
 * so the storefront RPC serves nothing) or `unpublished` (ACTIVE but never approved).
 */
export type AffiliateStorefrontState = 'live' | 'paused' | 'unpublished';

export interface AffiliateStorefrontAdminItem {
  pageId: string;
  affiliateId: string;
  /** The partner's auth user (for the email lookup of the visible rows). */
  userId: string | null;
  handle: string;
  displayName: string;
  partnerStatus: AffiliateStatus | null;
  suspendedReason: string | null;
  state: AffiliateStorefrontState;
  /** The partner was approved once (`first_published_at`): picks the pause / resume wording. */
  isApproved: boolean;
  /** Last approval (`affiliate_pages.published_at`). */
  publishedAt: string | null;
  approvalStatus: AffiliatePageStatus;
}

/** The public state of a published storefront, judged like `get_affiliate_storefront` (02030). */
export function describeAffiliateStorefrontState(
  partner: { status: AffiliateStatus | null; first_published_at: string | null } | null | undefined
): AffiliateStorefrontState {
  if (partner?.status === 'SUSPENDED') return 'paused';
  if (partner?.status === 'ACTIVE' && partner.first_published_at) return 'live';
  return 'unpublished';
}

const STOREFRONTS_MAX_PAGE_SIZE = 100;

async function countPublishedStorefronts(db: AffiliateRepositoryClient): Promise<number> {
  const { count, error } = await db
    .from('affiliate_pages')
    .select('id', { count: 'exact', head: true })
    .not('published_content', 'is', null);
  if (error) throw new AffiliateAdminDataError('count published storefronts', error);
  return toCount(count);
}

/**
 * Every storefront that has been published (`published_content` is set), newest approval first,
 * one page at a time: `.order().range()` with an exact count, so a program past PostgREST's 1000
 * rows (`max_rows`) still lists everything. The partners of the page are read in one query. A page
 * past the last storefront (removals shrink the list under a stale `?storefronts=`) answers no
 * rows with the real total, read by a separate head count (PostgREST's 416 carries none).
 */
export async function loadAffiliateStorefrontsAdmin(
  db: AffiliateRepositoryClient,
  options: { page: number; pageSize: number }
): Promise<{ rows: AffiliateStorefrontAdminItem[]; total: number }> {
  const pageSize = Math.min(Math.max(1, Math.trunc(options.pageSize) || 25), STOREFRONTS_MAX_PAGE_SIZE);
  const page = Math.min(Math.max(1, Math.trunc(options.page) || 1), 10_000);
  const from = (page - 1) * pageSize;

  try {
    const { data, error, count } = await db
      .from('affiliate_pages')
      .select('id, affiliate_id, approval_status, published_at', { count: 'exact' })
      .not('published_content', 'is', null)
      .order('published_at', { ascending: false, nullsFirst: false })
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) {
      if (isAffiliateRangeNotSatisfiable(error)) return { rows: [], total: await countPublishedStorefronts(db) };
      throw new AffiliateAdminDataError('list published storefronts', error);
    }

    const pageRows = (Array.isArray(data) ? (data as Array<Record<string, unknown>>) : []).filter(
      (row) => typeof row['id'] === 'string' && typeof row['affiliate_id'] === 'string'
    );
    const ids = [...new Set(pageRows.map((row) => normalizeAffiliateUuid(row['affiliate_id'])).filter((id): id is string => Boolean(id)))];

    const partners = new Map<string, Record<string, unknown>>();
    if (ids.length > 0) {
      const { data: profileRows, error: profileError } = await db
        .from('affiliate_profiles')
        .select('id, user_id, handle, display_name, status, suspended_reason, first_published_at')
        .in('id', ids);
      if (profileError) throw new AffiliateAdminDataError('load storefront partners', profileError);
      for (const row of Array.isArray(profileRows) ? (profileRows as Array<Record<string, unknown>>) : []) {
        if (typeof row['id'] === 'string') partners.set(row['id'], row);
      }
    }

    const rows = pageRows.map((row): AffiliateStorefrontAdminItem => {
      const partner = partners.get(row['affiliate_id'] as string);
      const partnerStatus = partner && isAffiliateStatus(partner['status']) ? partner['status'] : null;
      const firstPublishedAt = partner && typeof partner['first_published_at'] === 'string' ? partner['first_published_at'] : null;
      const status = row['approval_status'];
      return {
        pageId: row['id'] as string,
        affiliateId: row['affiliate_id'] as string,
        userId: partner && typeof partner['user_id'] === 'string' ? partner['user_id'] : null,
        handle: partner && typeof partner['handle'] === 'string' ? partner['handle'] : '',
        displayName: partner && typeof partner['display_name'] === 'string' ? partner['display_name'] : 'Unknown partner',
        partnerStatus,
        suspendedReason: partner && typeof partner['suspended_reason'] === 'string' ? partner['suspended_reason'] : null,
        state: describeAffiliateStorefrontState(partner ? { status: partnerStatus, first_published_at: firstPublishedAt } : null),
        isApproved: firstPublishedAt !== null,
        publishedAt: typeof row['published_at'] === 'string' ? row['published_at'] : null,
        approvalStatus: (typeof status === 'string' ? status : 'DRAFT') as AffiliatePageStatus,
      };
    });

    return { rows, total: typeof count === 'number' ? count : rows.length };
  } catch (error) {
    if (error instanceof AffiliateAdminDataError) throw error;
    throw new AffiliateAdminDataError('load storefronts', error);
  }
}

/** At most this many `auth.admin.getUserById` calls run at once (as in lib/commerce/seller-contact.ts). */
export const AFFILIATE_PARTNER_EMAIL_LOOKUP_CONCURRENCY = 10;
/** Lookups per call: the visible rows of a screen (two tables of at most 100). */
const MAX_PARTNER_EMAIL_LOOKUPS = 200;

type PartnerEmailLookup = { ok: true; email: string | null } | { ok: false; code: string | null };

/** A GoTrue error's code (or HTTP status) for the log: never its message or the user. */
function authErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const { code, status } = error as { code?: unknown; status?: unknown };
  if (typeof code === 'string' && code) return code;
  return typeof status === 'number' ? String(status) : null;
}

async function lookupPartnerEmail(db: AffiliateRepositoryClient, userId: string): Promise<PartnerEmailLookup> {
  try {
    const { data, error } = await db.auth.admin.getUserById(userId);
    if (error) return { ok: false, code: authErrorCode(error) };
    // The notifier's rule for a partner address: a valid address that can receive mail.
    return { ok: true, email: usableEmail(normalizeAffiliateNotificationEmail(data?.user?.email)) };
  } catch (error) {
    return { ok: false, code: authErrorCode(error) };
  }
}

/**
 * The sign-in addresses of the partners on screen, keyed by auth user id. Three outcomes per id:
 * an address; `null` when the account was read but its address is unusable (invalid, or a
 * reserved placeholder domain); and NO key when the lookup failed (GoTrue unreachable or
 * refusing), so a screen can say "Email unavailable right now" instead of claiming the partner has
 * no address (every partner signs up with one). Failures are logged once per call, by code.
 * Partner addresses live in `auth.users` only, so each one is a service-role
 * `auth.admin.getUserById` call: call this for the visible rows only. Never throws.
 */
export async function loadAffiliatePartnerEmails(
  db: AffiliateRepositoryClient,
  userIds: ReadonlyArray<string | null | undefined>
): Promise<Partial<Record<string, string | null>>> {
  const ids = [...new Set(userIds.map((id) => normalizeAffiliateUuid(id)).filter((id): id is string => Boolean(id)))].slice(
    0,
    MAX_PARTNER_EMAIL_LOOKUPS
  );
  const emails: Partial<Record<string, string | null>> = {};
  let failures = 0;
  let failureCode: string | null = null;
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next] as string;
      next += 1;
      const lookup = await lookupPartnerEmail(db, id);
      if (lookup.ok) {
        emails[id] = lookup.email;
      } else {
        failures += 1;
        failureCode ??= lookup.code;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(AFFILIATE_PARTNER_EMAIL_LOOKUP_CONCURRENCY, ids.length) }, worker));
  if (failures > 0) console.error('[affiliates] partner email lookups failed', { failures, code: failureCode });
  return emails;
}

export type AffiliateReviewProductStatus = 'active' | 'draft' | 'archived' | 'missing';

export interface AffiliateReviewProduct {
  id: string;
  title: string | null;
  imageUrl: string | null;
  status: AffiliateReviewProductStatus;
}

export interface AffiliateReviewFieldChange {
  key: 'display_name' | 'bio' | 'avatar' | 'social_links' | 'locale' | 'title' | 'meta_description';
  label: string;
  live: string | null;
  proposed: string | null;
  changed: boolean;
}

export interface AffiliateFeaturedProductsDiff {
  added: string[];
  removed: string[];
  kept: string[];
}

export interface AffiliateApprovalReviewData {
  page: Pick<
    AffiliatePageRow,
    | 'id'
    | 'affiliate_id'
    | 'approval_status'
    | 'draft_version'
    | 'draft_updated_at'
    | 'submitted_at'
    | 'submitted_version'
    | 'reviewed_at'
    | 'published_at'
    | 'admin_feedback_note'
  >;
  profile: AffiliateProfileRow;
  tier: AffiliateTierRow | null;
  /** Every tier, inactive ones included: the Partner card's "Change tier" lists them. */
  tiers: AffiliateTierRow[];
  /** Sanitized `published_content` (null before the first approval). */
  publishedDoc: StorefrontDoc | null;
  /** Sanitized `draft_content`: exactly what Approve & Publish would publish. */
  draftDoc: StorefrontDoc;
  draftIssues: string[];
  draftIsEmpty: boolean;
  diff: StorefrontBlockDiff;
  products: Record<string, AffiliateReviewProduct>;
  featured: AffiliateFeaturedProductsDiff;
  profileChanges: AffiliateReviewFieldChange[];
  /**
   * Fingerprint of the proposed profile snapshot shown here (`fingerprintAffiliatePublishedProfile`).
   * Approve sends it back, and approval refuses when the partner's profile changed since.
   */
  profileFingerprint: string;
  seoChanges: AffiliateReviewFieldChange[];
  liveAvatarUrl: string | null;
  proposedAvatarUrl: string | null;
  allowedImageOrigins: string[];
  siteOrigin: string;
}

const SOCIAL_LABELS: Record<string, string> = {
  website: 'Website',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  x: 'X',
  facebook: 'Facebook',
  pinterest: 'Pinterest',
  linkedin: 'LinkedIn',
};

function describeSocialLinks(links: AffiliateSocialLinks | null | undefined): string | null {
  const entries = Object.entries(sanitizeAffiliateSocialLinks(links ?? {})).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== ''
  );
  if (entries.length === 0) return null;
  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([network, url]) => `${SOCIAL_LABELS[network] ?? network}: ${url}`)
    .join('\n');
}

function blankToNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function fieldChange(
  key: AffiliateReviewFieldChange['key'],
  label: string,
  live: string | null,
  proposed: string | null
): AffiliateReviewFieldChange {
  return { key, label, live, proposed, changed: (live ?? '') !== (proposed ?? '') };
}

/** The storefront language as the (English-only) review screen names it; null when the snapshot has none. */
function describeProfileLocale(locale: AffiliatePublishedProfile['locale'] | null | undefined): string | null {
  if (locale === 'fr') return 'French';
  if (locale === 'en') return 'English';
  return null;
}

/**
 * The partner's public profile as it would be published (the approval snapshot) against the
 * snapshot that is live now. Before the first approval every proposed value counts as a change.
 * The language row is the storefront's declared language (the partner's `preferred_locale`).
 */
export function buildAffiliateProfileChanges(
  live: AffiliatePublishedProfile | null,
  proposed: AffiliatePublishedProfile
): AffiliateReviewFieldChange[] {
  return [
    fieldChange('display_name', 'Display name', blankToNull(live?.display_name), blankToNull(proposed.display_name)),
    fieldChange('bio', 'Bio', blankToNull(live?.bio), blankToNull(proposed.bio)),
    fieldChange('avatar', 'Avatar', live?.avatar_object_key ?? null, proposed.avatar_object_key),
    fieldChange('social_links', 'Social links', describeSocialLinks(live?.social_links), describeSocialLinks(proposed.social_links)),
    fieldChange('locale', 'Language', describeProfileLocale(live?.locale), describeProfileLocale(proposed.locale)),
  ];
}

/** Featured product ids added and removed by the submission (uuid-checked, deduplicated, ≤ 24 each). */
export function diffAffiliateFeaturedProducts(published: unknown, proposed: unknown): AffiliateFeaturedProductsDiff {
  const live = normalizeAffiliateFeaturedProductIds(published);
  const next = normalizeAffiliateFeaturedProductIds(proposed);
  return {
    added: next.filter((id) => !live.includes(id)),
    removed: live.filter((id) => !next.includes(id)),
    kept: next.filter((id) => live.includes(id)),
  };
}

/** Product ids a storefront document shows (every grid, deduplicated). */
function productIdsOf(doc: StorefrontDoc | null): string[] {
  const ids: string[] = [];
  for (const block of doc?.content ?? []) {
    if (block.type !== 'affiliateProductGrid') continue;
    for (const id of block.attrs.productIds) {
      const normalized = normalizeAffiliateUuid(id);
      if (normalized && !ids.includes(normalized)) ids.push(normalized);
    }
  }
  return ids;
}

const MAX_REVIEW_PRODUCTS = 120;

/** Title, first image and status of the products a review shows (service role: drafts included). */
export async function loadAffiliateReviewProducts(
  db: AffiliateRepositoryClient,
  productIds: readonly string[]
): Promise<Record<string, AffiliateReviewProduct>> {
  const ids = [...new Set(productIds.map((id) => normalizeAffiliateUuid(id)).filter((id): id is string => Boolean(id)))].slice(
    0,
    MAX_REVIEW_PRODUCTS
  );
  const products: Record<string, AffiliateReviewProduct> = {};
  for (const id of ids) products[id] = { id, title: null, imageUrl: null, status: 'missing' };
  if (ids.length === 0) return products;

  const { data, error } = await db
    .from('products')
    .select('id, title, status, product_media(sort_order, media(object_key))')
    .in('id', ids);
  if (error) throw new AffiliateAdminDataError('load review products', error);

  for (const row of Array.isArray(data) ? (data as Array<Record<string, unknown>>) : []) {
    const id = normalizeAffiliateUuid(row['id']);
    if (!id) continue;
    const media = Array.isArray(row['product_media']) ? (row['product_media'] as Array<Record<string, unknown>>) : [];
    const first = [...media].sort((a, b) => Number(a['sort_order'] ?? 0) - Number(b['sort_order'] ?? 0))[0];
    const mediaRow = first && first['media'] && typeof first['media'] === 'object' ? (first['media'] as Record<string, unknown>) : null;
    const objectKey = mediaRow && typeof mediaRow['object_key'] === 'string' ? mediaRow['object_key'] : null;
    const status = row['status'];
    products[id] = {
      id,
      title: typeof row['title'] === 'string' ? row['title'] : null,
      imageUrl: resolveMediaUrl(objectKey),
      status: status === 'active' || status === 'draft' || status === 'archived' ? status : 'missing',
    };
  }
  return products;
}

/**
 * The approval detail screen: both documents sanitized exactly as publication would, the block
 * diff, the products they show, and the profile / SEO / featured-product changes. Null when the
 * page does not exist.
 */
export async function loadAffiliateApprovalReview(
  db: AffiliateRepositoryClient,
  pageIdToReview: string
): Promise<AffiliateApprovalReviewData | null> {
  const pageId = normalizeAffiliateUuid(pageIdToReview);
  if (!pageId) return null;

  try {
    const page = await getAffiliatePageById(db, pageId);
    if (!page) return null;
    const profile = await getAffiliateProfileById(db, page.affiliate_id);
    if (!profile) return null;
    // Every tier for the Partner card's "Change tier"; the partner's own is one of them.
    const tiers = await listAffiliateTiers(db, { includeInactive: true });
    const tier = tiers.find((candidate) => candidate.id === profile.tier_id) ?? null;

    const allowedImageOrigins = getStorefrontImageOrigins();
    const draft = sanitizeAffiliateDraftForReview(page.draft_content);
    const published = page.published_content ? sanitizeAffiliateDraftForReview(page.published_content) : null;
    const publishedDoc = published ? published.doc : null;

    const featured = diffAffiliateFeaturedProducts(page.published_featured_product_ids, page.featured_product_ids);
    const products = await loadAffiliateReviewProducts(db, [
      ...productIdsOf(draft.doc),
      ...productIdsOf(publishedDoc),
      ...featured.added,
      ...featured.removed,
      ...featured.kept,
    ]);

    const proposedProfile = buildAffiliatePublishedProfile(profile);
    const liveProfile = page.published_profile;

    return {
      page: {
        id: page.id,
        affiliate_id: page.affiliate_id,
        approval_status: page.approval_status,
        draft_version: page.draft_version,
        draft_updated_at: page.draft_updated_at,
        submitted_at: page.submitted_at,
        submitted_version: page.submitted_version,
        reviewed_at: page.reviewed_at,
        published_at: page.published_at,
        admin_feedback_note: page.admin_feedback_note,
      },
      profile,
      tier,
      tiers,
      publishedDoc,
      draftDoc: draft.doc,
      draftIssues: draft.issues,
      draftIsEmpty: isStorefrontDocEmpty(draft.doc),
      diff: diffStorefrontBlocks(publishedDoc, draft.doc),
      products,
      featured,
      profileChanges: buildAffiliateProfileChanges(liveProfile, proposedProfile),
      profileFingerprint: fingerprintAffiliatePublishedProfile(proposedProfile),
      seoChanges: [
        fieldChange('title', 'Page title', blankToNull(page.published_title), blankToNull(page.title)),
        fieldChange(
          'meta_description',
          'Meta description',
          blankToNull(page.published_meta_description),
          blankToNull(page.meta_description)
        ),
      ],
      liveAvatarUrl: liveProfile?.avatar_object_key ? resolveMediaUrl(liveProfile.avatar_object_key) : null,
      proposedAvatarUrl: proposedProfile.avatar_object_key ? resolveMediaUrl(proposedProfile.avatar_object_key) : null,
      allowedImageOrigins,
      siteOrigin: resolveSiteUrl(),
    };
  } catch (error) {
    if (error instanceof AffiliateAdminDataError) throw error;
    throw new AffiliateAdminDataError('load storefront review', error);
  }
}

/* ------------------------------------------------------------------------ payouts --- */

export interface AffiliatePayoutPlatformSummary {
  /** Stripe keys are configured (null when the runner could not tell). */
  stripeConfigured: boolean | null;
  /** Payouts are switched off because this is the public sandbox. */
  sandbox: boolean;
  /** Mode of the Stripe key (null when unknown). */
  livemode: boolean | null;
  /** ISO country of the Stripe platform account (uppercase), when known. */
  platformCountry: string | null;
  /** `default_currency` of the Stripe platform account (uppercase), when known. */
  platformCurrency: string | null;
  /** The store base currency commissions are recorded and paid in. */
  baseCurrency: string;
  /** The two differ: transfers draw on a balance in another currency (ADDENDUM B2). */
  currencyMismatch: boolean;
  /** Total available platform balance per currency, when the runner read it. */
  availableBalances: Array<{ currency: string; amountCents: number }>;
  /** What a transfer can draw now (the available `card` source, the cycle's rule), when the runner read it. */
  transferableBalances: Array<{ currency: string; amountCents: number }>;
  /** Pending `card`-source balance per currency: transferable once Stripe settles it. */
  pendingBalances: Array<{ currency: string; amountCents: number }>;
  /** The runner read the balance: the balance lists are real figures, not "unknown". */
  balanceKnown: boolean;
  /**
   * A machine code the runner reported instead of the information: `stripe_authentication` (Stripe
   * rejected the key), `stripe_permission` (a restricted key lacks a permission), `stripe_unavailable`.
   */
  error: string | null;
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function pickValue(records: Array<Record<string, unknown> | null>, keys: readonly string[]): unknown {
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      if (record[key] !== undefined && record[key] !== null) return record[key];
    }
  }
  return undefined;
}

function currencyCode(value: unknown): string | null {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

function readBalances(value: unknown): Array<{ currency: string; amountCents: number }> {
  if (!Array.isArray(value)) return [];
  const balances: Array<{ currency: string; amountCents: number }> = [];
  for (const entry of value.slice(0, 20)) {
    const record = asPlainRecord(entry);
    if (!record) continue;
    const currency = currencyCode(record['currency']);
    const amount = Number(pickValue([record], ['amountCents', 'amount', 'availableCents']));
    if (currency && Number.isFinite(amount)) balances.push({ currency, amountCents: Math.trunc(amount) });
  }
  return balances;
}

/**
 * The payout runner's platform information (`getAffiliatePayoutPlatformInfo()`), read defensively
 * into what the Payouts screen shows. A missing or failed read yields "unknown" values, never a
 * throw; the base currency always comes from the store.
 */
export function normalizeAffiliatePayoutPlatformInfo(raw: unknown, baseCurrency: string): AffiliatePayoutPlatformSummary {
  const record = asPlainRecord(raw);
  const platform = asPlainRecord(record?.['platform']) ?? asPlainRecord(record?.['account']);
  const balance = asPlainRecord(record?.['balance']);
  const records = [record, platform, balance];

  const configured = pickValue(records, ['stripeConfigured', 'configured', 'isConfigured', 'hasStripe']);
  const sandbox = pickValue(records, ['sandbox', 'isSandbox']);
  const livemode = pickValue(records, ['livemode', 'liveMode']);
  const countryRaw = pickValue(records, ['platformCountry', 'country']);
  const platformCountry = typeof countryRaw === 'string' && /^[A-Za-z]{2}$/.test(countryRaw.trim()) ? countryRaw.trim().toUpperCase() : null;
  const platformCurrency = currencyCode(
    pickValue(records, ['platformCurrency', 'platformDefaultCurrency', 'defaultCurrency', 'default_currency'])
  );
  const storeCurrency = currencyCode(pickValue([record], ['baseCurrency', 'storeCurrency', 'storeBaseCurrency'])) ?? currencyCode(baseCurrency) ?? 'USD';
  const explicitMismatch = pickValue([record], ['currencyMismatch']);
  const availableRaw = pickValue(records, ['availableBalances', 'available']);
  const transferableRaw = pickValue(records, ['transferableBalances', 'transferable']);
  const pendingRaw = pickValue(records, ['pendingBalances', 'pending']);
  const errorCode = pickValue([record], ['error', 'reason', 'code']);

  return {
    stripeConfigured: typeof configured === 'boolean' ? configured : null,
    sandbox: sandbox === true,
    livemode: typeof livemode === 'boolean' ? livemode : null,
    platformCountry,
    platformCurrency,
    baseCurrency: storeCurrency,
    currencyMismatch:
      typeof explicitMismatch === 'boolean' ? explicitMismatch : platformCurrency !== null && platformCurrency !== storeCurrency,
    availableBalances: readBalances(availableRaw),
    transferableBalances: readBalances(transferableRaw),
    pendingBalances: readBalances(pendingRaw),
    balanceKnown: Array.isArray(transferableRaw),
    error: typeof errorCode === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(errorCode) ? errorCode : null,
  };
}

export type AffiliatePayoutsView = 'commissions' | 'payouts';

export interface AffiliatePayoutsFilters {
  view: AffiliatePayoutsView;
  commissionStatus: AffiliateCommissionStatus | null;
  payoutStatus: AffiliatePayoutStatus | null;
  page: number;
  pageSize: number;
}

export function parseAffiliatePayoutsFilters(params: Record<string, SearchParamValue>): AffiliatePayoutsFilters {
  const view = firstParam(params['view']) === 'payouts' ? 'payouts' : 'commissions';
  const status = firstParam(params['status']).toUpperCase();
  return {
    view,
    commissionStatus: view === 'commissions' && isAffiliateCommissionStatus(status) ? status : null,
    payoutStatus: view === 'payouts' && isAffiliatePayoutStatus(status) ? status : null,
    page: parseAffiliateAdminPage(params['page']),
    pageSize: parseAffiliateAdminPageSize(params['pageSize']),
  };
}

export interface AffiliateLedgerPartner {
  handle: string;
  displayName: string;
}

export interface AffiliatePayoutsAdminData {
  baseCurrency: string;
  settings: AffiliatesSettings;
  commissions: { rows: AffiliateCommissionRow[]; total: number } | null;
  payouts: { rows: AffiliatePayoutRow[]; total: number } | null;
  partners: Record<string, AffiliateLedgerPartner>;
  /**
   * FAILED payouts that still hold their commissions (Retry or Release): a payout released, emptied
   * or handed back below the minimum keeps the FAILED status but has nothing left to do.
   */
  failedPayouts: number;
  processingPayouts: number;
}

async function countPayouts(db: AffiliateRepositoryClient, status: AffiliatePayoutStatus): Promise<number> {
  const { count, error } = await db.from('affiliate_payouts').select('id', { count: 'exact', head: true }).eq('status', status);
  if (error) throw new AffiliateAdminDataError(`count ${status.toLowerCase()} payouts`, error);
  return toCount(count);
}

/**
 * FAILED Stripe payouts with an open failure (not released, emptied or below the minimum): the ones
 * that wait for Retry or Release. A failed PayPal payout (02037) handed its commissions back when it
 * failed, so it never waits for an admin.
 */
async function countOpenFailedPayouts(db: AffiliateRepositoryClient): Promise<number> {
  const { count, error } = await db
    .from('affiliate_payouts')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'FAILED')
    .neq('method', 'paypal')
    .not('failure_reason', 'in', `(${AFFILIATE_PAYOUT_CLOSED_FAILURE_REASONS.join(',')})`);
  if (error) throw new AffiliateAdminDataError('count failed payouts', error);
  return toCount(count);
}

export async function loadAffiliatePayoutsAdmin(
  db: AffiliateRepositoryClient,
  filters: AffiliatePayoutsFilters
): Promise<AffiliatePayoutsAdminData> {
  const offset = (filters.page - 1) * filters.pageSize;

  try {
    const [baseCurrency, settings, commissions, payouts, failedPayouts, processingPayouts] = await Promise.all([
      getAffiliateStoreBaseCurrency(db),
      getAffiliatesSettings(),
      filters.view === 'commissions'
        ? listAffiliateCommissions(db, { status: filters.commissionStatus, limit: filters.pageSize, offset })
        : Promise.resolve(null),
      filters.view === 'payouts'
        ? listAffiliatePayouts(db, { status: filters.payoutStatus, limit: filters.pageSize, offset })
        : Promise.resolve(null),
      countOpenFailedPayouts(db),
      countPayouts(db, 'PROCESSING'),
    ]);

    const affiliateIds = [
      ...(commissions?.rows ?? []).map((row) => row.affiliate_id),
      ...(payouts?.rows ?? []).map((row) => row.affiliate_id),
    ];
    const profiles = await loadProfileSummaries(db, affiliateIds);
    const partners: Record<string, AffiliateLedgerPartner> = {};
    for (const [id, profile] of profiles) partners[id] = { handle: profile.handle, displayName: profile.display_name };

    return {
      baseCurrency,
      settings,
      commissions: commissions ? { rows: commissions.rows, total: commissions.count } : null,
      payouts: payouts ? { rows: payouts.rows, total: payouts.count } : null,
      partners,
      failedPayouts,
      processingPayouts,
    };
  } catch (error) {
    if (error instanceof AffiliateAdminDataError) throw error;
    throw new AffiliateAdminDataError('load payouts', error);
  }
}
