/**
 * Checkout attribution (ADDENDUM B4, B9, A12, A13): which partner, if any, an order is credited
 * to. The app hands in the storefront token it already verified and the referral cookie's
 * handle; this decides between them against the database. Fail-safe by design: any error
 * leaves the order unattributed and never reaches checkout.
 */
import { AFFILIATE_DEFAULT_COOKIE_DAYS } from '../core/constants';
import { affiliateEmailsMatch, normalizeAffiliateEmail } from '../core/email';
import { AFFILIATE_HANDLE_PATTERN } from '../core/handle';
import { affiliateTable, normalizeAffiliateUuid, type AffiliateRepositoryClient } from '../repository/client';
import type {
  AffiliateAttributionSource,
  AffiliateCheckoutAttribution,
  AffiliateCheckoutAttributionInput,
} from './types';

/** Tolerated difference between the clock that minted a token and the one checking it. */
const AFFILIATE_ATTRIBUTION_CLOCK_SKEW_SECONDS = 5 * 60;

/** The longest referral window a tier may set (the CHECK on `cookie_duration_days`). */
const AFFILIATE_ATTRIBUTION_MAX_WINDOW_DAYS = 365;

const AFFILIATE_ATTRIBUTION_PROFILE_COLUMNS =
  'id, user_id, handle, status, first_published_at, tier:affiliate_tiers(cookie_duration_days)';

const AFFILIATE_ATTRIBUTION_CURRENCY_PATTERN = /^[A-Z]{3}$/;

interface AffiliateAttributionCandidate {
  id: string;
  userId: string;
  handle: string;
  /** ACTIVE and approved (A12: a partner earns once its first storefront was approved). */
  eligible: boolean;
  /** The tier's referral window in days, or null when the row did not carry it. */
  windowDays: number | null;
}

/** Lowercased and pattern-checked; the database, not the reserved list, decides what exists. */
function normalizeAttributionHandle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const handle = value.trim().toLowerCase();
  return AFFILIATE_HANDLE_PATTERN.test(handle) ? handle : null;
}

function describeAttributionError(error: unknown): string {
  if (error && typeof error === 'object') {
    const record = error as { code?: unknown; message?: unknown };
    const code = typeof record.code === 'string' ? record.code : null;
    const message = typeof record.message === 'string' ? record.message : null;
    return [code, message].filter(Boolean).join(' ') || 'unknown error';
  }
  return typeof error === 'string' ? error : 'unknown error';
}

/**
 * True while a token minted at `issuedAtSeconds` is inside a referral window of `windowDays`
 * days (capped at 365). A token from the future (beyond five minutes of skew) and a
 * non-positive window never match. Same rule as the app's `isAffiliateStorefrontTokenWithinWindow`.
 */
export function isAffiliateAttributionTokenFresh(issuedAtSeconds: number, windowDays: number, nowMs: number = Date.now()): boolean {
  if (!Number.isFinite(issuedAtSeconds) || !Number.isFinite(windowDays) || windowDays <= 0 || !Number.isFinite(nowMs)) {
    return false;
  }

  const nowSeconds = Math.floor(nowMs / 1000);

  if (issuedAtSeconds > nowSeconds + AFFILIATE_ATTRIBUTION_CLOCK_SKEW_SECONDS) return false;

  return nowSeconds - issuedAtSeconds <= Math.min(windowDays, AFFILIATE_ATTRIBUTION_MAX_WINDOW_DAYS) * 24 * 60 * 60;
}

function readWindowDays(tier: unknown): number | null {
  const row = Array.isArray(tier) ? tier[0] : tier;
  const days = row && typeof row === 'object' ? (row as { cookie_duration_days?: unknown }).cookie_duration_days : null;
  const value = typeof days === 'string' ? Number(days) : days;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function toAttributionCandidate(raw: unknown): AffiliateAttributionCandidate | null {
  if (!raw || typeof raw !== 'object') return null;

  const row = raw as Record<string, unknown>;
  const id = normalizeAffiliateUuid(row['id']);
  const userId = normalizeAffiliateUuid(row['user_id']);
  const handle = normalizeAttributionHandle(row['handle']);

  if (!id || !userId || !handle) return null;

  const firstPublishedAt = row['first_published_at'];

  return {
    id,
    userId,
    handle,
    eligible: row['status'] === 'ACTIVE' && typeof firstPublishedAt === 'string' && firstPublishedAt.length > 0,
    windowDays: readWindowDays(row['tier']),
  };
}

async function loadAttributionCandidates(
  supabase: AffiliateRepositoryClient,
  handles: string[]
): Promise<Map<string, AffiliateAttributionCandidate>> {
  const { data, error } = await affiliateTable(supabase, 'affiliate_profiles')
    .select(AFFILIATE_ATTRIBUTION_PROFILE_COLUMNS)
    .in('handle', handles);

  if (error) throw error;

  const candidates = new Map<string, AffiliateAttributionCandidate>();

  for (const raw of Array.isArray(data) ? data : []) {
    const candidate = toAttributionCandidate(raw);
    if (candidate) candidates.set(candidate.handle, candidate);
  }

  return candidates;
}

/** The partner's sign-in email, for the self-referral rule. Throws when it cannot be read. */
async function loadPartnerEmail(supabase: AffiliateRepositoryClient, userId: string): Promise<string | null> {
  const { data, error } = await supabase.auth.admin.getUserById(userId);

  if (error) throw error;
  if (!data?.user) throw new Error('partner account not found');

  return typeof data.user.email === 'string' ? data.user.email : null;
}

/** The store default currency (one row, by a unique partial index), or null when unreadable. */
async function loadAttributionBaseCurrency(supabase: AffiliateRepositoryClient): Promise<string | null> {
  try {
    const { data, error } = await affiliateTable(supabase, 'currencies')
      .select('code')
      .eq('is_default', true)
      .limit(1)
      .maybeSingle();

    if (error) throw error;

    const code = data && typeof (data as { code?: unknown }).code === 'string' ? (data as { code: string }).code.trim().toUpperCase() : '';
    return AFFILIATE_ATTRIBUTION_CURRENCY_PATTERN.test(code) ? code : null;
  } catch (error) {
    // The commission falls back to the default currency of the day it is recorded.
    console.warn('[affiliates] Could not read the store base currency for an attributed order:', describeAttributionError(error));
    return null;
  }
}

async function resolveAttributionOrThrow(input: AffiliateCheckoutAttributionInput): Promise<AffiliateCheckoutAttribution | null> {
  const nowMs = typeof input.now === 'number' && Number.isFinite(input.now) ? input.now : Date.now();
  const token = input.token;
  const tokenHandle = token ? normalizeAttributionHandle(token.handle) : null;
  const tokenIssuedAt =
    token && typeof token.issuedAt === 'number' && Number.isSafeInteger(token.issuedAt) && token.issuedAt > 0 ? token.issuedAt : null;
  const storefrontHandle = tokenHandle && tokenIssuedAt !== null ? tokenHandle : null;
  const cookieHandle = normalizeAttributionHandle(input.cookieHandle);
  const handles = [...new Set([storefrontHandle, cookieHandle].filter((handle): handle is string => Boolean(handle)))];

  if (handles.length === 0) return null;

  const candidates = await loadAttributionCandidates(input.supabase, handles);
  let chosen: { candidate: AffiliateAttributionCandidate; source: AffiliateAttributionSource } | null = null;

  // A valid storefront token wins: the buyer added the product on that partner's storefront.
  if (storefrontHandle && tokenIssuedAt !== null) {
    const candidate = candidates.get(storefrontHandle);
    const windowDays = candidate?.windowDays ?? AFFILIATE_DEFAULT_COOKIE_DAYS;

    if (candidate?.eligible && isAffiliateAttributionTokenFresh(tokenIssuedAt, windowDays, nowMs)) {
      chosen = { candidate, source: 'storefront' };
    }
  }

  // Otherwise the referral cookie (last click; its max-age is the tier window).
  if (!chosen && cookieHandle) {
    const candidate = candidates.get(cookieHandle);
    if (candidate?.eligible) chosen = { candidate, source: 'referral_link' };
  }

  if (!chosen) return null;

  // Self-referral: a partner never earns on their own purchase (the commission trigger applies
  // the same rule again when the order is paid). No fallback to another candidate.
  const buyerUserId = normalizeAffiliateUuid(input.buyerUserId);
  if (buyerUserId && buyerUserId === chosen.candidate.userId) return null;

  const buyerEmail = normalizeAffiliateEmail(input.buyerEmail);
  const [partnerEmail, baseCurrency] = await Promise.all([
    buyerEmail ? loadPartnerEmail(input.supabase, chosen.candidate.userId) : Promise.resolve(null),
    loadAttributionBaseCurrency(input.supabase),
  ]);

  if (buyerEmail && affiliateEmailsMatch(buyerEmail, partnerEmail)) return null;

  return {
    affiliateId: chosen.candidate.id,
    handle: chosen.candidate.handle,
    source: chosen.source,
    baseCurrency,
  };
}

/**
 * The partner a checkout is attributed to, or null.
 *
 * 1. The verified storefront token wins when its partner is ACTIVE and approved
 *    (`first_published_at` set) and `issuedAt` is inside the partner tier's
 *    `cookie_duration_days`.
 * 2. Otherwise the referral cookie's partner, when ACTIVE and approved.
 * 3. A self-referral is null: the buyer's user id is the partner's, or the buyer's email equals
 *    the partner's auth email under `normalizeAffiliateEmail` (case, `+tag`, Gmail dots).
 *
 * `baseCurrency` is the store default currency code. Never throws: an error is logged and the
 * order is simply not attributed.
 */
export async function resolveCheckoutAttribution(input: AffiliateCheckoutAttributionInput): Promise<AffiliateCheckoutAttribution | null> {
  try {
    return await resolveAttributionOrThrow(input);
  } catch (error) {
    console.warn('[affiliates] Checkout attribution failed; the order is not attributed:', describeAttributionError(error));
    return null;
  }
}
