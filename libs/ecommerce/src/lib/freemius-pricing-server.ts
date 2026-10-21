import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { majorUnitAmountToMinor } from '@nextblock-cms/utils';

import {
  type CurrencyRecord,
  convertMinorUnitAmount,
  getDefaultCurrency,
  isSaleWindowActive,
  normalizePriceMap,
  normalizeSalePriceMap,
  resolveEffectivePriceForCurrency,
} from './currency';
import {
  computeFreemiusSaleDiscountPercent,
  type FreemiusCyclePrices,
  isFreemiusBillingCycle,
  resolveFreemiusBillingCycle,
  toFreemiusCyclePrice,
} from './freemius-pricing';
import type { BillingCycle } from './types';

type SupabaseLikeClient = SupabaseClient<any>;

/** The `products` columns the resolver reads; select all of them. */
export const FREEMIUS_PRICED_PRODUCT_COLUMNS =
  'id, translation_group_id, price, prices, sale_price, sale_prices, sale_start_at, sale_end_at, scheduled_price, scheduled_prices, scheduled_price_at';

export type FreemiusPricedProduct = {
  id: string;
  translation_group_id?: string | null;
  price: number | null;
  prices?: Record<string, unknown> | null;
  sale_price?: number | null;
  sale_prices?: Record<string, unknown> | null;
  sale_start_at?: string | null;
  sale_end_at?: string | null;
  scheduled_price?: number | null;
  scheduled_prices?: Record<string, unknown> | null;
  scheduled_price_at?: string | null;
};

type FreemiusPricingRow = {
  id: string;
  license_quota: number | null;
  api_monthly_price: number | string | null;
  api_annual_price: number | string | null;
  api_lifetime_price: number | string | null;
};

/**
 * Tier lookups keyed by product id, shared across one quote. The public coupon action prices a
 * client-supplied line list, so without it repeating one product N times costs 3N queries.
 */
export type FreemiusPricingTierCache = Map<string, Promise<FreemiusPricingRow | null>>;

export type FreemiusUnitAmountResolution =
  | {
      ok: true;
      /** `pricing`: the plan's Freemius price for the cycle. `product`: no pricing rows, so `products.price`. */
      source: 'pricing' | 'product';
      /** The cycle to send to Freemius. Null only on the `product` fallback when none was asked for. */
      billingCycle: BillingCycle | null;
      /** Regular unit price, in the selected currency's minor units. */
      price: number;
      /** What the order records per unit: `price` less an active sale. */
      unitAmount: number;
    }
  | { ok: false; reason: 'invalid_billing_cycle' | 'billing_cycle_not_offered' };

/**
 * The pricing tier checkout charges from: the active tier with the lowest license quota among
 * the plans of the product and its translation siblings (only the synced language owns plan
 * rows; getPublicFreemiusPricing reads them the same way). The ORDER BY makes the pick
 * deterministic and matches pickFreemiusPricingTier on the product page.
 */
async function loadFreemiusPricingTier(
  client: SupabaseLikeClient,
  product: FreemiusPricedProduct
): Promise<FreemiusPricingRow | null> {
  let productIds = [product.id];

  if (product.translation_group_id) {
    const { data: siblings, error: siblingsError } = await (client as any)
      .from('products')
      .select('id')
      .eq('translation_group_id', product.translation_group_id);

    if (siblingsError) {
      throw new Error(siblingsError.message);
    }

    productIds = [
      ...new Set([product.id, ...(siblings || []).map((sibling: { id: string }) => sibling.id)]),
    ];
  }

  const { data: plans, error: plansError } = await (client as any)
    .from('freemius_plans')
    .select('id')
    .in('product_id', productIds);

  if (plansError) {
    throw new Error(plansError.message);
  }

  if (!plans || plans.length === 0) {
    return null;
  }

  const { data: tiers, error: tiersError } = await (client as any)
    .from('freemius_pricing')
    .select('id, license_quota, api_monthly_price, api_annual_price, api_lifetime_price')
    .in(
      'plan_id',
      plans.map((plan: { id: string }) => plan.id)
    )
    .eq('is_active', true)
    .order('license_quota', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true })
    .limit(1);

  if (tiersError) {
    throw new Error(tiersError.message);
  }

  return (tiers?.[0] as FreemiusPricingRow | undefined) ?? null;
}

/**
 * The unit amount a Freemius purchase is recorded and discounted at.
 *
 * Freemius charges its own plan price for the cycle the checkout opens on, so that is what the
 * order records: the `api_*` price (what Freemius charges, never a display override) for the
 * validated cycle, converted from the store's default currency into the selected one the way
 * the product page converts it. An active sale comes off as the percent the Freemius sale coupon
 * carries. `products.price` is used only when the product has no pricing rows at all; it is the
 * sync's cycle-blind annual-first price, so pricing it for a monthly purchase over-records it.
 */
export async function resolveFreemiusUnitAmount(input: {
  client: SupabaseLikeClient;
  product: FreemiusPricedProduct;
  billingCycle?: unknown;
  currencyCode: string;
  currencies: CurrencyRecord[];
  tierCache?: FreemiusPricingTierCache;
  now?: Date;
}): Promise<FreemiusUnitAmountResolution> {
  const { product, currencies } = input;
  const now = input.now ?? new Date();
  const requested = input.billingCycle;
  const hasRequest = requested !== undefined && requested !== null && requested !== '';

  // Refused before any query, priced or not.
  if (hasRequest && !isFreemiusBillingCycle(requested)) {
    return { ok: false, reason: 'invalid_billing_cycle' };
  }

  let tierLookup = input.tierCache?.get(product.id);

  if (!tierLookup) {
    tierLookup = loadFreemiusPricingTier(input.client, product);
    input.tierCache?.set(product.id, tierLookup);
  }

  const tier = await tierLookup;

  if (!tier) {
    const resolvedPrice = resolveEffectivePriceForCurrency({
      prices: normalizePriceMap(product.prices),
      salePrices: normalizeSalePriceMap(product.sale_prices),
      fallbackPrice: product.price,
      fallbackSalePrice: product.sale_price,
      saleStartAt: product.sale_start_at,
      saleEndAt: product.sale_end_at,
      scheduledPrice: product.scheduled_price,
      scheduledPrices: normalizePriceMap(product.scheduled_prices),
      scheduledPriceAt: product.scheduled_price_at,
      currencyCode: input.currencyCode,
      currencies,
      now,
    });

    return {
      ok: true,
      source: 'product',
      billingCycle: hasRequest ? (requested as BillingCycle) : null,
      price: resolvedPrice.price,
      unitAmount: resolvedPrice.sale_price ?? resolvedPrice.price,
    };
  }

  const cyclePrices: FreemiusCyclePrices = {
    monthly: toFreemiusCyclePrice(tier.api_monthly_price),
    annual: toFreemiusCyclePrice(tier.api_annual_price),
    lifetime: toFreemiusCyclePrice(tier.api_lifetime_price),
  };
  const cycle = resolveFreemiusBillingCycle(requested, cyclePrices);

  if (!cycle.ok) {
    return cycle;
  }

  const defaultCurrency = getDefaultCurrency(currencies);
  const price = convertMinorUnitAmount({
    amount: majorUnitAmountToMinor(cyclePrices[cycle.cycle] ?? 0, defaultCurrency.code),
    fromCurrencyCode: defaultCurrency.code,
    toCurrencyCode: input.currencyCode,
    currencies,
    applyRounding: true,
  });
  const salePercent = isSaleWindowActive({
    saleStartAt: product.sale_start_at,
    saleEndAt: product.sale_end_at,
    now,
  })
    ? computeFreemiusSaleDiscountPercent(product.price, product.sale_price)
    : null;

  return {
    ok: true,
    source: 'pricing',
    billingCycle: cycle.cycle,
    price,
    unitAmount: salePercent === null ? price : price - Math.round((price * salePercent) / 100),
  };
}
