/**
 * Tier helpers: display names, capacity, the signup tier choice (a mirror of
 * `public.create_affiliate_account` in migration 02030) and the earnings projections the
 * `/partners` calculator shows. Pure and client-safe; integer minor units throughout.
 */
import { AFFILIATES_COMMON_COPY } from '../i18n/copy/common';
import { applyAffiliatesFrenchTypography } from '../i18n/copy-runtime';
import type { AffiliatesCopyEntry } from '../i18n/types';
import type { AffiliateTierRow } from './types';

/** The fields the tier helpers read; full rows satisfy it. */
export type AffiliateTierLike = Pick<
  AffiliateTierRow,
  | 'id'
  | 'name'
  | 'name_translations'
  | 'slug'
  | 'sort_order'
  | 'is_active'
  | 'is_default_signup_tier'
  | 'is_limited_time_promo'
  | 'max_ambassadors_cap'
  | 'member_count'
  | 'created_at'
>;

const COMMON_COPY: Readonly<Record<string, AffiliatesCopyEntry | undefined>> = AFFILIATES_COMMON_COPY;

function localeKey(locale: unknown): string {
  return typeof locale === 'string' ? (locale.trim().toLowerCase().split(/[-_]/)[0] ?? '') : '';
}

function nonBlank(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** The common-copy entry of a seeded tier (`affiliates.common.tier_name_<slug>`), if any. */
function seededTierName(slug: string | null | undefined): AffiliatesCopyEntry | undefined {
  return slug ? COMMON_COPY[`affiliates.common.tier_name_${slug.replace(/-/g, '_')}`] : undefined;
}

/**
 * The tier goal for `locale` ("Make 8 confirmed sales…"): its `goal_translations[locale]`, else the
 * English `goal`, else null (no goal line). A French goal gets the no-break spaces of Québec
 * typography (the copy runtime never rewrites values it inserts, and the goal renders as is).
 * Display only: reaching a goal promotes nobody; an admin moves partners between tiers by hand.
 */
export function affiliateTierDisplayGoal(
  tier: Pick<AffiliateTierRow, 'goal' | 'goal_translations'>,
  locale: string
): string | null {
  return affiliateTierDisplayGoalWithLanguage(tier, locale)?.text ?? null;
}

/**
 * {@link affiliateTierDisplayGoal} plus the language the text is in: `locale`'s base language for a
 * translation, `en` for the English fallback, so a page can mark an English goal on a French page
 * with `lang="en"`.
 */
export function affiliateTierDisplayGoalWithLanguage(
  tier: Pick<AffiliateTierRow, 'goal' | 'goal_translations'>,
  locale: string
): { text: string; language: string } | null {
  const lang = localeKey(locale);
  const translations =
    tier.goal_translations && typeof tier.goal_translations === 'object' && !Array.isArray(tier.goal_translations)
      ? (tier.goal_translations as Record<string, unknown>)
      : {};
  if (lang && lang !== 'en') {
    const translated = nonBlank(translations[lang]);
    if (translated) return { text: lang === 'fr' ? applyAffiliatesFrenchTypography(translated) : translated, language: lang };
  }
  const english = nonBlank(tier.goal);
  return english ? { text: english, language: 'en' } : null;
}

/**
 * The tier name for `locale`: its `name_translations[locale]`; else, for a seeded tier that
 * still carries its seeded English name, the seeded French name; else the English `name`.
 * A renamed tier without a translation shows its own (English) name.
 */
export function affiliateTierDisplayName(
  tier: Pick<AffiliateTierRow, 'name' | 'name_translations'> & { slug?: string | null },
  locale: string
): string {
  const lang = localeKey(locale);
  const englishName = nonBlank(tier.name);
  const translations =
    tier.name_translations && typeof tier.name_translations === 'object' && !Array.isArray(tier.name_translations)
      ? (tier.name_translations as Record<string, unknown>)
      : {};

  if (lang && lang !== 'en') {
    const translated = nonBlank(translations[lang]);
    if (translated) return translated;

    const seeded = seededTierName(tier.slug);
    if (lang === 'fr' && seeded && (!englishName || englishName === seeded.en)) {
      return seeded.fr;
    }
  }

  if (englishName) return englishName;

  const fallback = COMMON_COPY['affiliates.common.tier_name_fallback'];
  return fallback ? (lang === 'fr' ? fallback.fr : fallback.en) : 'Partner tier';
}

function wholeNonNegative(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

/** Spots left before the cap; null when the tier is unlimited. */
export function affiliateTierSpotsRemaining(
  tier: Pick<AffiliateTierRow, 'max_ambassadors_cap' | 'member_count'>
): number | null {
  if (tier.max_ambassadors_cap === null || tier.max_ambassadors_cap === undefined) {
    return null;
  }

  return Math.max(0, wholeNonNegative(tier.max_ambassadors_cap) - wholeNonNegative(tier.member_count));
}

/** SQL: `max_ambassadors_cap IS NULL OR member_count < max_ambassadors_cap`. */
export function affiliateTierHasCapacity(tier: Pick<AffiliateTierRow, 'max_ambassadors_cap' | 'member_count'>): boolean {
  const remaining = affiliateTierSpotsRemaining(tier);
  return remaining === null || remaining > 0;
}

function createdAtValue(value: unknown): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

/** `created_at` ascending (unparseable last), then id, so the order is total and deterministic. */
function compareCreatedThenId(a: Pick<AffiliateTierLike, 'id' | 'created_at'>, b: Pick<AffiliateTierLike, 'id' | 'created_at'>): number {
  const left = createdAtValue(a.created_at);
  const right = createdAtValue(b.created_at);

  if (left !== right) return left < right ? -1 : 1;

  return String(a.id).localeCompare(String(b.id));
}

/**
 * The order `create_affiliate_account` walks the tiers in:
 * `ORDER BY is_default_signup_tier DESC, CASE WHEN is_default_signup_tier THEN -sort_order ELSE sort_order END, created_at`
 * (default tiers first, highest sort order first among them; then the rest, lowest sort order first).
 */
export function compareAffiliateSignupTierOrder(a: AffiliateTierLike, b: AffiliateTierLike): number {
  if (a.is_default_signup_tier !== b.is_default_signup_tier) {
    return a.is_default_signup_tier ? -1 : 1;
  }

  const rank = (tier: AffiliateTierLike) => (tier.is_default_signup_tier ? -tier.sort_order : tier.sort_order);
  const byRank = rank(a) - rank(b);

  return byRank !== 0 ? byRank : compareCreatedThenId(a, b);
}

/** The tier a new signup gets: the first active tier, in signup order, with a free spot. */
export function selectAffiliateSignupTier<T extends AffiliateTierLike>(tiers: readonly T[]): T | null {
  return (
    tiers
      .filter((tier) => tier.is_active)
      .sort(compareAffiliateSignupTierOrder)
      .find((tier) => affiliateTierHasCapacity(tier)) ?? null
  );
}

/** The standard tier the calculator compares against: the active tier with the lowest sort order. */
export function selectAffiliateBaseTier<T extends AffiliateTierLike>(tiers: readonly T[]): T | null {
  return (
    tiers
      .filter((tier) => tier.is_active)
      .sort((a, b) => a.sort_order - b.sort_order || compareCreatedThenId(a, b))[0] ?? null
  );
}

/**
 * The limited-time offer to feature: the tier a new signup gets (`selectAffiliateSignupTier`), when
 * it is a default + promo tier. Null once the promo is full, and null while another tier ranks ahead
 * of it (a default tier with a higher sort order and room): the page must never promise a rate the
 * signup does not get.
 */
export function selectAffiliatePromoTier<T extends AffiliateTierLike>(tiers: readonly T[]): T | null {
  const signup = selectAffiliateSignupTier(tiers);
  return signup && signup.is_default_signup_tier && signup.is_limited_time_promo ? signup : null;
}

function clampRate(ratePercent: unknown): number {
  const rate = Number(ratePercent);
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return Math.min(rate, 100);
}

function nonNegative(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export interface AffiliateEarningsProjectionInput {
  monthlyReferrals: number;
  /** Average order value in minor units. */
  averageOrderValueMinor: number;
  ratePercent: number;
}

export interface AffiliateEarningsProjection {
  monthlyMinor: number;
  /** Always 12 × `monthlyMinor`, so the two figures never disagree on screen. */
  annualMinor: number;
}

/** Projected commission for a referral volume, in minor units (rounded once, per month). */
export function projectAffiliateEarnings(input: AffiliateEarningsProjectionInput): AffiliateEarningsProjection {
  const monthlyMinor = Math.round(
    (nonNegative(input.monthlyReferrals) * nonNegative(input.averageOrderValueMinor) * clampRate(input.ratePercent)) / 100
  );

  return { monthlyMinor, annualMinor: monthlyMinor * 12 };
}

export interface AffiliateTierEarningsComparisonInput {
  monthlyReferrals: number;
  averageOrderValueMinor: number;
  promoRatePercent: number;
  baseRatePercent: number;
}

export interface AffiliateTierEarningsComparison {
  promoAnnualMinor: number;
  baseAnnualMinor: number;
  /** What the promo tier adds per year over the base tier (never negative). */
  bonusAnnualMinor: number;
}

/** The calculator's side-by-side: annual earnings at the promo rate vs the standard rate. */
export function compareAffiliateTierEarnings(input: AffiliateTierEarningsComparisonInput): AffiliateTierEarningsComparison {
  const shared = { monthlyReferrals: input.monthlyReferrals, averageOrderValueMinor: input.averageOrderValueMinor };
  const promoAnnualMinor = projectAffiliateEarnings({ ...shared, ratePercent: input.promoRatePercent }).annualMinor;
  const baseAnnualMinor = projectAffiliateEarnings({ ...shared, ratePercent: input.baseRatePercent }).annualMinor;

  return { promoAnnualMinor, baseAnnualMinor, bonusAnnualMinor: Math.max(0, promoAnnualMinor - baseAnnualMinor) };
}
