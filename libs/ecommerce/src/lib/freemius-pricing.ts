import type { BillingCycle } from './types';

/**
 * Pure Freemius pricing rules shared by the product page (client) and the checkout and coupon
 * quote (server, see freemius-pricing-server.ts). Both sides must pick the same tier and the
 * same cycle, or the price the shopper sees, the coupon base and the recorded order drift apart.
 */

/**
 * The cycles a Freemius checkout accepts, in the order a missing cycle defaults through:
 * Freemius opens on the annual cycle when the plan sells one, and the product page pre-selects
 * the same way.
 */
export const FREEMIUS_BILLING_CYCLES: readonly BillingCycle[] = ['annual', 'monthly', 'lifetime'];

export function isFreemiusBillingCycle(value: unknown): value is BillingCycle {
  return (
    typeof value === 'string' && (FREEMIUS_BILLING_CYCLES as readonly string[]).includes(value)
  );
}

/** Major-unit price per cycle for one pricing tier; null means the plan does not sell that cycle. */
export type FreemiusCyclePrices = Record<BillingCycle, number | null>;

export function toFreemiusCyclePrice(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

type FreemiusPricingTierLike = {
  id: string;
  license_quota: number | null;
  is_active?: boolean | null;
};

/**
 * `ORDER BY license_quota ASC NULLS LAST, id ASC`, the order the server query uses. Ids are
 * compared as plain strings (not localeCompare) so lowercase uuids sort as Postgres sorts them.
 */
export function compareFreemiusPricingTiers(a: FreemiusPricingTierLike, b: FreemiusPricingTierLike) {
  const aQuota = typeof a.license_quota === 'number' ? a.license_quota : null;
  const bQuota = typeof b.license_quota === 'number' ? b.license_quota : null;

  if (aQuota !== bQuota) {
    if (aQuota === null) return 1;
    if (bQuota === null) return -1;
    return aQuota - bQuota;
  }

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The tier a Freemius product is sold at: the active tier with the lowest license quota. The
 * checkout does not pick a license count, so Freemius charges its entry tier, and this is the
 * tier the product page shows and the order records.
 */
export function pickFreemiusPricingTier<T extends FreemiusPricingTierLike>(
  tiers: readonly T[]
): T | null {
  const active = tiers.filter((tier) => tier.is_active !== false);
  active.sort(compareFreemiusPricingTiers);
  return active[0] ?? null;
}

export type FreemiusBillingCycleResolution =
  | { ok: true; cycle: BillingCycle }
  | { ok: false; reason: 'invalid_billing_cycle' | 'billing_cycle_not_offered' };

/**
 * Validates the cycle a cart line asks for against the cycles the tier sells. No cycle (a grid
 * "add to cart" sends none) resolves to the first one sold, in FREEMIUS_BILLING_CYCLES order.
 * Anything that is not a cycle name, or a cycle without a price, is refused: the value is
 * appended to the Freemius checkout as sent, so it is never passed through unchecked.
 */
export function resolveFreemiusBillingCycle(
  requested: unknown,
  prices: FreemiusCyclePrices
): FreemiusBillingCycleResolution {
  if (requested === undefined || requested === null || requested === '') {
    const fallback = FREEMIUS_BILLING_CYCLES.find((cycle) => prices[cycle] !== null);
    return fallback
      ? { ok: true, cycle: fallback }
      : { ok: false, reason: 'billing_cycle_not_offered' };
  }

  if (!isFreemiusBillingCycle(requested)) {
    return { ok: false, reason: 'invalid_billing_cycle' };
  }

  if (prices[requested] === null) {
    return { ok: false, reason: 'billing_cycle_not_offered' };
  }

  return { ok: true, cycle: requested };
}

/**
 * The whole-percent discount a product sale becomes on Freemius. The sale coupon pushed to
 * Freemius (syncProductSaleCouponToFreemius) carries this percent, and Freemius applies it to
 * whichever cycle is bought, so the checkout records the sale with the same percent.
 */
export function computeFreemiusSaleDiscountPercent(
  price?: number | null,
  salePrice?: number | null
) {
  if (typeof price !== 'number' || price <= 0) {
    return null;
  }
  if (typeof salePrice !== 'number' || salePrice < 0 || salePrice >= price) {
    return null;
  }
  const percent = Math.round((1 - salePrice / price) * 100);
  if (percent <= 0 || percent > 100) {
    return null;
  }
  return percent;
}
