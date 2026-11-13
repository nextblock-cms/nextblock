import {
  AFFILIATE_DEFAULT_CLEARANCE_DAYS,
  AFFILIATE_DEFAULT_COOKIE_DAYS,
  affiliateTierDisplayGoalWithLanguage,
  affiliateTierDisplayName,
  affiliateTierHasCapacity,
  affiliateTierSpotsRemaining,
  selectAffiliateBaseTier,
  selectAffiliatePromoTier,
  selectAffiliateSignupTier,
  type AffiliateBadgeColor,
  type AffiliateLocale,
  type AffiliateTierRow,
  type AffiliatesCopyTranslate,
} from '@nextblock-cms/affiliates';

/**
 * The `/partners` view model, built from the active tiers (pure: no I/O, no React), so the page,
 * its metadata, its JSON-LD and the SEO test all read the same numbers.
 *
 * - The offer (the "FOMO" badge) is the limited-time promo tier only while it is the tier a new
 *   signup actually gets (`selectAffiliatePromoTier`: a default tier with a free spot that no other
 *   default tier ranks ahead of). Once it is sold out, or while another default tier takes the
 *   signups, the badge disappears and the calculator compares the signup tier with the base tier.
 * - Rates are `numeric(5,2)`; labels are formatted per locale (`12.5` / `12,5`).
 */

export interface PartnersLadderTier {
  id: string;
  name: string;
  rate: number;
  rateLabel: string;
  badgeColor: AffiliateBadgeColor;
  /** The tier the launch offer features. */
  isOffer: boolean;
  /** The tier a signup lands on today. */
  isSignupTier: boolean;
  isLimitedTimePromo: boolean;
  /** Null when the tier has no cap. */
  spotsRemaining: number | null;
  soldOut: boolean;
  cookieDays: number;
  /** What a partner aims for to reach this tier, in the page language; null = no goal line. */
  goal: string | null;
  /** The language `goal` is written in: the page's, or `en` for an English fallback. */
  goalLanguage: string | null;
}

export interface PartnersOffer {
  tierName: string;
  rateLabel: string;
  /** Lowest and highest standard (non-promo) rates, or null when there are none. */
  minRateLabel: string | null;
  maxRateLabel: string | null;
  /** Null when the promo tier has no cap. */
  spotsRemaining: number | null;
  /** The promo tier's partner cap; null when it has none. */
  spotsTotal: number | null;
}

/**
 * One of the store's products, as the calculator's product picker and the hero's example card show
 * it (read by `lib/affiliates/partners-showcase.ts`, in the page language).
 */
export interface PartnersShowcaseProduct {
  id: string;
  title: string;
  /** Site-relative product page (`/product/<slug>`). */
  href: string;
  /**
   * What one order pays, in minor units of the store currency: a license's yearly price when its
   * plan sells one (else its monthly price), any other product's current price.
   */
  orderValueMinor: number;
  /** A yearly license's monthly price (minor units) when the plan also bills monthly, else null. */
  monthlyMinor: number | null;
  /** What `orderValueMinor` buys: a year, a month, or the product itself. */
  billing: 'year' | 'month' | 'once';
}

/** One row of the hero card's example ledger: a sale, its commission and where it is in the hold. */
export interface PartnersHeroSale {
  /** The product's title; null = the generic "Referred sale" label. */
  title: string | null;
  commissionMinor: number;
  status: 'pending_clearance' | 'cleared' | 'paid';
}

/**
 * The hero's example month: the calculator's starting point (its default monthly sales and order
 * value at the rate a signup gets), so the card and the calculator always tell the same story.
 */
export interface PartnersHeroExample {
  currency: string;
  rateLabel: string;
  sales: number;
  orderValueMinor: number;
  monthlyMinor: number;
  saleRows: PartnersHeroSale[];
}

export interface PartnersRangeConfig {
  min: number;
  max: number;
  step: number;
  initial: number;
}

export interface PartnersCalculatorConfig {
  /** Store base currency (commissions are recorded and paid in it). */
  currency: string;
  compareRate: number;
  compareRateLabel: string;
  /** Null when the compared tier is the base tier (or pays no more): one figure, no bonus. */
  baseRate: number | null;
  baseRateLabel: string | null;
  referrals: PartnersRangeConfig;
  /** Average order value, in minor units of `currency`. */
  averageOrderValue: PartnersRangeConfig;
  /** The product picker (highest order value first, at most three); empty hides it. */
  products: PartnersShowcaseProduct[];
}

export interface PartnersLandingModel {
  locale: AffiliateLocale;
  tiers: PartnersLadderTier[];
  /** "Earn up to {rate}%": the offer rate, else the best rate a partner can still reach. */
  headlineRateLabel: string | null;
  offer: PartnersOffer | null;
  signupTier: { name: string; rateLabel: string } | null;
  /** Index (in `tiers`) of the locked knob of the decorative slider, and what it means. */
  track: { index: number; kind: 'offer' | 'standard'; tierName: string; rateLabel: string } | null;
  calculator: PartnersCalculatorConfig | null;
  /** The hero's example card; null when there is no rate to show (then the hero is one column). */
  heroExample: PartnersHeroExample | null;
  /** True when at least one tier has a goal (the ladder then explains how goals are reviewed). */
  hasTierGoals: boolean;
  cookieDays: number;
  clearanceDays: number;
  /** False when no tier has a free spot (the RPC would answer `program_full`). */
  signupOpen: boolean;
}

export interface PartnersFaqItem {
  question: string;
  answer: string;
}

/** Monthly referrals slider (SPEC: 1–100). */
export const PARTNERS_CALCULATOR_REFERRALS: PartnersRangeConfig = { min: 1, max: 100, step: 1, initial: 10 };

/**
 * Average order value slider in MINOR units, for a store with no product to show. For a two-decimal
 * currency that is 10.00–500.00 in steps of 1.00 (60.00 to start); a zero-decimal currency (JPY,
 * KRW…) reads the same numbers as 1,000–50,000 whole units, the same order of magnitude in practice.
 * With products the slider starts at the priciest one and reaches their sum
 * ({@link partnersAverageOrderRange}).
 */
export const PARTNERS_CALCULATOR_AVERAGE_ORDER_VALUE: PartnersRangeConfig = {
  min: 1_000,
  max: 50_000,
  step: 100,
  initial: 6_000,
};

/** Products the picker and the hero card show, at most. */
export const PARTNERS_SHOWCASE_PRODUCT_LIMIT = 3;

/** The slider's top is rounded up to a multiple of this (minor units). */
const AVERAGE_ORDER_MAX_ROUNDING = 5_000;

/** The hero ledger's rows, newest first: a fresh sale waits out the hold, older ones cleared and paid. */
const HERO_SALE_STATUSES: readonly PartnersHeroSale['status'][] = ['pending_clearance', 'cleared', 'paid'];

function positiveMinor(value: unknown): number {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount) : 0;
}

/**
 * The products worth showing: a positive order value and a title, highest order value first
 * (ties by title), at most {@link PARTNERS_SHOWCASE_PRODUCT_LIMIT}.
 */
export function selectPartnersShowcaseProducts(products: readonly PartnersShowcaseProduct[]): PartnersShowcaseProduct[] {
  return products
    .filter((product) => positiveMinor(product.orderValueMinor) > 0 && product.title.trim() !== '')
    .map((product) => ({
      ...product,
      orderValueMinor: positiveMinor(product.orderValueMinor),
      monthlyMinor: product.monthlyMinor === null ? null : positiveMinor(product.monthlyMinor) || null,
    }))
    .sort((a, b) => b.orderValueMinor - a.orderValueMinor || a.title.localeCompare(b.title))
    .slice(0, PARTNERS_SHOWCASE_PRODUCT_LIMIT);
}

/**
 * The order value slider for these products: it starts at the priciest one and reaches their sum
 * (the picker's "all together" choice). It reaches down to the cheapest one too (floored to a step,
 * at least one step), so every listed price is a value the slider and the hero card can show.
 */
export function partnersAverageOrderRange(products: readonly PartnersShowcaseProduct[]): PartnersRangeConfig {
  const base = PARTNERS_CALCULATOR_AVERAGE_ORDER_VALUE;
  if (products.length === 0) return base;
  const prices = products.map((product) => product.orderValueMinor);
  const top = Math.max(...prices);
  const cheapest = Math.min(...prices);
  const total = prices.reduce((sum, price) => sum + price, 0);
  const min = Math.max(base.step, Math.min(base.min, Math.floor(cheapest / base.step) * base.step));
  const max = Math.max(base.max, Math.ceil(total / AVERAGE_ORDER_MAX_ROUNDING) * AVERAGE_ORDER_MAX_ROUNDING);
  return { ...base, min, max, initial: Math.min(max, Math.max(min, top)) };
}

function positiveDays(value: unknown, fallback: number): number {
  const days = Number(value);
  return Number.isInteger(days) && days > 0 && days <= 365 ? days : fallback;
}

function finiteRate(value: unknown): number {
  const rate = Number(value);
  return Number.isFinite(rate) && rate > 0 ? Math.min(rate, 100) : 0;
}

/** `50` / `12.5` (en) or `12,5` (fr): at most two decimals, no trailing zeros. */
export function formatPartnersRate(rate: number, locale: AffiliateLocale): string {
  return new Intl.NumberFormat(locale === 'fr' ? 'fr-CA' : 'en-US', { maximumFractionDigits: 2 }).format(finiteRate(rate));
}


export interface BuildPartnersLandingModelInput {
  tiers: readonly AffiliateTierRow[];
  locale: AffiliateLocale;
  currency: string;
  /** The store's products in the page language (any order; the model picks and sorts). */
  products?: readonly PartnersShowcaseProduct[];
}

export function buildPartnersLandingModel({
  tiers,
  locale,
  currency,
  products = [],
}: BuildPartnersLandingModelInput): PartnersLandingModel {
  const active = tiers.filter((tier) => tier.is_active).sort((a, b) => a.sort_order - b.sort_order);
  const promo = selectAffiliatePromoTier(active);
  const signup = selectAffiliateSignupTier(active);
  const base = selectAffiliateBaseTier(active);
  const rateLabel = (rate: number) => formatPartnersRate(rate, locale);
  const nameOf = (tier: AffiliateTierRow) => affiliateTierDisplayName(tier, locale);

  const ladder: PartnersLadderTier[] = active.map((tier) => {
    const goal = affiliateTierDisplayGoalWithLanguage(tier, locale);
    return {
      id: tier.id,
      name: nameOf(tier),
      rate: finiteRate(tier.commission_percentage),
      rateLabel: rateLabel(tier.commission_percentage),
      badgeColor: tier.badge_color,
      isOffer: promo !== null && tier.id === promo.id,
      isSignupTier: signup !== null && tier.id === signup.id,
      isLimitedTimePromo: tier.is_limited_time_promo,
      spotsRemaining: affiliateTierSpotsRemaining(tier),
      soldOut: !affiliateTierHasCapacity(tier),
      cookieDays: positiveDays(tier.cookie_duration_days, AFFILIATE_DEFAULT_COOKIE_DAYS),
      goal: goal?.text ?? null,
      goalLanguage: goal?.language ?? null,
    };
  });

  let offer: PartnersOffer | null = null;
  if (promo) {
    const standardRates = active
      .filter((tier) => !tier.is_limited_time_promo)
      .map((tier) => finiteRate(tier.commission_percentage))
      .filter((rate) => rate > 0);
    offer = {
      tierName: nameOf(promo),
      rateLabel: rateLabel(promo.commission_percentage),
      minRateLabel: standardRates.length > 0 ? rateLabel(Math.min(...standardRates)) : null,
      maxRateLabel: standardRates.length > 0 ? rateLabel(Math.max(...standardRates)) : null,
      spotsRemaining: affiliateTierSpotsRemaining(promo),
      spotsTotal:
        promo.max_ambassadors_cap === null || promo.max_ambassadors_cap === undefined
          ? null
          : Math.max(0, Math.floor(Number(promo.max_ambassadors_cap)) || 0),
    };
  }

  // "Up to": the offer while it lasts; else the best rate still reachable: the standard tiers (by
  // promotion) and the tier a signup gets. A promo tier no signup gets (sold out, or ranked behind
  // another default tier) is out of reach for a new partner, so it never inflates the headline.
  const reachable = active.filter((tier) => !tier.is_limited_time_promo || (signup !== null && tier.id === signup.id));
  const bestReachable = reachable.reduce((best, tier) => Math.max(best, finiteRate(tier.commission_percentage)), 0);
  const headlineRate = promo ? finiteRate(promo.commission_percentage) : bestReachable;

  const trackTier = promo ?? signup;
  const trackIndex = trackTier ? ladder.findIndex((tier) => tier.id === trackTier.id) : -1;

  // The calculator compares what a signup gets today (the offer, else the signup tier) with the base tier.
  const compared = promo ?? signup;
  const showcase = selectPartnersShowcaseProducts(products);
  let calculator: PartnersCalculatorConfig | null = null;
  let heroExample: PartnersHeroExample | null = null;
  if (compared && finiteRate(compared.commission_percentage) > 0) {
    const compareRate = finiteRate(compared.commission_percentage);
    const baseRate = base ? finiteRate(base.commission_percentage) : 0;
    const showsBase = base !== null && base.id !== compared.id && baseRate > 0 && baseRate < compareRate;
    const averageOrderValue = partnersAverageOrderRange(showcase);
    calculator = {
      currency,
      compareRate,
      compareRateLabel: rateLabel(compareRate),
      baseRate: showsBase ? baseRate : null,
      baseRateLabel: showsBase ? rateLabel(baseRate) : null,
      referrals: PARTNERS_CALCULATOR_REFERRALS,
      averageOrderValue,
      products: showcase,
    };

    // The calculator's starting point, worked out: its default sales a month at its default order value.
    const commissionOf = (orderValueMinor: number) => Math.round((orderValueMinor * compareRate) / 100);
    const sales = PARTNERS_CALCULATOR_REFERRALS.initial;
    const saleRows: PartnersHeroSale[] =
      showcase.length > 0
        ? showcase.map((product, index) => ({
            title: product.title,
            commissionMinor: commissionOf(product.orderValueMinor),
            status: HERO_SALE_STATUSES[index] ?? 'paid',
          }))
        : [{ title: null, commissionMinor: commissionOf(averageOrderValue.initial), status: 'pending_clearance' }];
    heroExample = {
      currency,
      rateLabel: rateLabel(compareRate),
      sales,
      orderValueMinor: averageOrderValue.initial,
      monthlyMinor: commissionOf(averageOrderValue.initial * sales),
      saleRows,
    };
  }

  const termsTier = signup ?? promo ?? base;

  return {
    locale,
    tiers: ladder,
    headlineRateLabel: headlineRate > 0 ? rateLabel(headlineRate) : null,
    offer,
    signupTier: signup ? { name: nameOf(signup), rateLabel: rateLabel(signup.commission_percentage) } : null,
    track:
      trackTier && trackIndex >= 0
        ? {
            index: trackIndex,
            kind: promo ? 'offer' : 'standard',
            tierName: nameOf(trackTier),
            rateLabel: rateLabel(trackTier.commission_percentage),
          }
        : null,
    calculator,
    heroExample,
    hasTierGoals: ladder.some((tier) => tier.goal !== null),
    cookieDays: positiveDays(termsTier?.cookie_duration_days, AFFILIATE_DEFAULT_COOKIE_DAYS),
    clearanceDays: positiveDays(termsTier?.clearance_hold_days, AFFILIATE_DEFAULT_CLEARANCE_DAYS),
    signupOpen: signup !== null,
  };
}

/** `<title>` (at most 60 characters before the site suffix) and meta description (70–160). */
export function buildPartnersMetaCopy(t: AffiliatesCopyTranslate, model: PartnersLandingModel): { title: string; description: string } {
  return model.headlineRateLabel
    ? {
        title: t('affiliates.partners.meta_title', { rate: model.headlineRateLabel }),
        description: t('affiliates.partners.meta_description', { rate: model.headlineRateLabel }),
      }
    : {
        title: t('affiliates.partners.meta_title_no_rate'),
        description: t('affiliates.partners.meta_description_no_rate'),
      };
}

/**
 * The launch offer line ("Claim 50% Revenue Share (Normally 10%–35%) — Only 49 Founding Ambassador
 * Spots Left!"), or null. The spots sentence names the promo tier by its current localized name.
 */
export function buildPartnersOfferMessage(t: AffiliatesCopyTranslate, offer: PartnersOffer | null): string | null {
  if (!offer) return null;
  const parts = [t('affiliates.partners.offer_claim', { rate: offer.rateLabel })];
  if (offer.minRateLabel && offer.maxRateLabel) {
    parts.push(
      offer.minRateLabel === offer.maxRateLabel
        ? t('affiliates.partners.offer_range_single', { rate: offer.minRateLabel })
        : t('affiliates.partners.offer_range', { min: offer.minRateLabel, max: offer.maxRateLabel }),
    );
  }
  if (offer.spotsRemaining === null) parts.push(t('affiliates.partners.offer_spots_unlimited'));
  else if (offer.spotsRemaining === 1) parts.push(t('affiliates.partners.offer_spots_one', { tier: offer.tierName }));
  else parts.push(t('affiliates.partners.offer_spots_many', { spots: offer.spotsRemaining, tier: offer.tierName }));
  return parts.join(' ');
}

/** The FAQ, shared by the page and its FAQPage JSON-LD. */
export function buildPartnersFaq(t: AffiliatesCopyTranslate, model: PartnersLandingModel): PartnersFaqItem[] {
  return [
    { question: t('affiliates.partners.faq_cost_question'), answer: t('affiliates.partners.faq_cost_answer') },
    { question: t('affiliates.partners.faq_commission_question'), answer: t('affiliates.partners.faq_commission_answer') },
    {
      question: t('affiliates.partners.faq_payouts_question'),
      answer: t('affiliates.partners.faq_payouts_answer', { days: model.clearanceDays }),
    },
    {
      question: t('affiliates.partners.faq_cookie_question'),
      answer: t('affiliates.partners.faq_cookie_answer', { days: model.cookieDays }),
    },
    { question: t('affiliates.partners.faq_approval_question'), answer: t('affiliates.partners.faq_approval_answer') },
    { question: t('affiliates.partners.faq_refund_question'), answer: t('affiliates.partners.faq_refund_answer') },
  ];
}

/** WebPage + FAQPage structured data for `/partners`. */
export function buildPartnersJsonLd(input: {
  t: AffiliatesCopyTranslate;
  model: PartnersLandingModel;
  url: string;
  siteTitle: string;
}): Record<string, unknown> {
  const { title, description } = buildPartnersMetaCopy(input.t, input.model);
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebPage',
        '@id': `${input.url}#webpage`,
        url: input.url,
        name: title,
        description,
        inLanguage: input.model.locale === 'fr' ? 'fr-CA' : 'en',
        isPartOf: { '@type': 'WebSite', name: input.siteTitle },
      },
      {
        '@type': 'FAQPage',
        '@id': `${input.url}#faq`,
        mainEntity: buildPartnersFaq(input.t, input.model).map((item) => ({
          '@type': 'Question',
          name: item.question,
          acceptedAnswer: { '@type': 'Answer', text: item.answer },
        })),
      },
    ],
  };
}
