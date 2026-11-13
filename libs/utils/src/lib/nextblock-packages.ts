/**
 * The premium packages NextBlock sells, and the commercial terms every install shows
 * for them. Client-safe: no server imports, so the CMS can render prices and trial
 * copy without a round trip.
 *
 * The numbers here are what the dashboard promises the operator. Keep them in step with
 * the Freemius plans (the plan is the source of truth for what the checkout actually
 * charges and whether a trial is offered without a payment method) and with the seeded
 * marketing copy in libs/db/src/supabase/migrations/02004_baseline_seed.sql.
 */

export type PackageTrial = {
  /** Trial length in days. */
  days: number;
  /** false = "No credit card required" (the Freemius plan's card requirement is off). */
  requiresPaymentMethod: boolean;
};

export type PackagePricing = {
  /** Price per year, in major units. */
  annual: number;
  currency: 'USD';
  /** Price per month, in major units, when the plan also bills monthly. */
  monthly?: number;
};

type PackageDefinitionShape = {
  description: string;
  fm_plan_id: string;
  fm_product_id: string;
  id: string;
  name: string;
  pricing: PackagePricing;
  /** Product page on nextblock.dev, for buying outside the dashboard. */
  purchase_url: string;
  /**
   * Packages that must be active for this one to run. Such a package is an add-on: the dashboard
   * sells and trials it only on top of them, and the app treats it as inactive while one of them
   * is off (Affiliates needs Commerce Pro: `lib/affiliates/package-state.ts`).
   */
  requires: readonly string[];
  /** One line on what the package unlocks, for cards and dialogs. */
  tagline: string;
  trial: PackageTrial | null;
};

export const NEXTBLOCK_PACKAGES = {
  ecommerce: {
    id: 'ecommerce',
    name: 'NextBlock™ Commerce Pro',
    tagline: 'Sell physical and digital products with Stripe and Freemius checkout, multi-currency pricing, coupons, tax, and shipping.',
    description: 'Full-featured digital store with Stripe & Freemius.',
    fm_product_id: '24851', // Product ID for NextBlock™ Commerce Pro
    fm_plan_id: '41208',
    purchase_url: 'https://nextblock.dev/product/nextblock-commerce-pro-commerce-license',
    pricing: { currency: 'USD', annual: 250, monthly: 25 },
    requires: [],
    // Both packages start with the same free, no-card 30-day trial; the checkout is
    // opened in trial mode (`trial: 'free'`) whenever this is set.
    trial: { days: 30, requiresPaymentMethod: false },
  },
  'cortex-ai': {
    id: 'cortex-ai',
    name: 'NextBlock Cortex AI',
    tagline: 'AI inside the editor plus the MCP server: build or rebuild the whole site from a chat, in every language, with your own OpenRouter key.',
    description: 'Native JSONB block generation and OpenRouter integration.',
    fm_product_id: '28609',
    fm_plan_id: '47122',
    purchase_url: 'https://nextblock.dev/product/nextblock-cortex-ai-cortex-ai-license',
    pricing: { currency: 'USD', annual: 250 },
    requires: [],
    trial: { days: 30, requiresPaymentMethod: false },
  },
  affiliates: {
    id: 'affiliates',
    name: 'NextBlock Affiliates & Creator Storefronts',
    tagline: 'Recruit partners who earn a commission on the sales they refer, each with an approved co-branded storefront and automatic Stripe payouts.',
    description: 'Affiliate program with partner storefronts, commission tiers and Stripe Connect payouts.',
    fm_product_id: '43273', // Product ID for NextBlock Affiliates & Creator Storefronts
    fm_plan_id: '75655',
    // Created by migration 02032 (EN; the French page is <slug>-fr).
    purchase_url: 'https://nextblock.dev/product/nextblock-affiliates-creator-storefronts-affiliates-license',
    // An add-on to Commerce Pro, priced as one: $450 a year for both. The Freemius plan (single-site
    // pricing 110047) is the source of truth; keep these numbers in step with it.
    pricing: { currency: 'USD', annual: 200, monthly: 20 },
    // Partners earn a share of store sales: without Commerce Pro there is nothing to sell.
    requires: ['ecommerce'],
    trial: { days: 30, requiresPaymentMethod: false },
  },
} as const satisfies Record<string, PackageDefinitionShape>;

export type PackageId = keyof typeof NEXTBLOCK_PACKAGES;
export type PackageDef = (typeof NEXTBLOCK_PACKAGES)[PackageId];

export function getPackageById(id: string): PackageDef | undefined {
  return NEXTBLOCK_PACKAGES[id as PackageId];
}

export function getPackageByFreemiusId(productId: string | number): PackageDef | undefined {
  const pid = String(productId ?? '').trim();
  // A package without a Freemius product (fm_product_id '') must never match an empty id: `pid`
  // is non-empty from here, so the comparison alone keeps that true.
  if (!pid) return undefined;
  return Object.values(NEXTBLOCK_PACKAGES).find((p) => p.fm_product_id === pid);
}

/**
 * The packages `pkg` requires that are not active, in registry order: an add-on is sold, trialed
 * and run only on top of them. `isActive` answers for one package id.
 */
export function missingPackageRequirements(
  pkg: Pick<PackageDefinitionShape, 'requires'>,
  isActive: (packageId: string) => boolean,
): PackageDef[] {
  return pkg.requires
    .map((packageId) => getPackageById(packageId))
    .filter((required): required is PackageDef => required !== undefined && !isActive(required.id));
}

/**
 * True when the package can be bought or trialed from the dashboard (it has a Freemius product
 * and plan). A package without one is activated by a license key or the sandbox key only, so
 * no checkout or trial button may open for it.
 */
export function hasPackageCheckout(pkg: Pick<PackageDefinitionShape, 'fm_plan_id' | 'fm_product_id'>): boolean {
  return pkg.fm_product_id.trim() !== '' && pkg.fm_plan_id.trim() !== '';
}

/** "$250" — whole dollars, no cents, the way the offer is quoted. */
export function formatPackagePrice(amount: number, currency: PackagePricing['currency'] = 'USD') {
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  return `${symbol}${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
}

export type PackageOffer = {
  /** "Free 30-day trial, no credit card required" or null when there is no trial. */
  trialLine: string | null;
  /** "$250/year" (plus " or $25/month" when monthly billing exists). */
  priceLine: string;
  /** "Free 30-day trial, no credit card required, then $250/year." */
  summary: string;
  /** Short badge text: "30-day free trial" or "Paid license". */
  badge: string;
};

/**
 * The commercial terms as one consistent set of strings, so the onboarding checklist,
 * the packages page, the purchase dialog and the setup wizard never disagree.
 */
export function describePackageOffer(pkg: Pick<PackageDefinitionShape, 'pricing' | 'trial'>): PackageOffer {
  const annual = `${formatPackagePrice(pkg.pricing.annual, pkg.pricing.currency)}/year`;
  const priceLine = pkg.pricing.monthly
    ? `${annual} or ${formatPackagePrice(pkg.pricing.monthly, pkg.pricing.currency)}/month`
    : annual;

  if (!pkg.trial) {
    return {
      badge: 'Paid license',
      priceLine,
      summary: `${priceLine}.`,
      trialLine: null,
    };
  }

  const trialLine = pkg.trial.requiresPaymentMethod
    ? `Free ${pkg.trial.days}-day trial`
    : `Free ${pkg.trial.days}-day trial, no credit card required`;

  return {
    badge: `${pkg.trial.days}-day free trial`,
    priceLine,
    summary: `${trialLine}, then ${priceLine}.`,
    trialLine,
  };
}
