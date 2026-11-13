import 'server-only';

import { cache } from 'react';
import { unstable_cache } from 'next/cache';
import { getSsgSupabaseClient } from '@nextblock-cms/db/server';
import { normalizeCurrencyRecord, resolveEffectivePriceForCurrency, type CurrencyRecord } from '@nextblock-cms/ecommerce';
import type { AffiliateLocale } from '@nextblock-cms/affiliates';
import { buildPublishedAtOrFilter, majorUnitAmountToMinor } from '@nextblock-cms/utils';
import type { PartnersShowcaseProduct } from '../../app/(public)/partners/_components/partners-model';

/**
 * The store's products for the `/partners` page: the calculator's product picker ("what your
 * referrals buy") and the hero's example card. The model keeps the three priciest
 * (`selectPartnersShowcaseProducts`); this module hands it the candidates in the visitor's language.
 *
 * - One cached catalog for every visitor and language (`getPartnersShowcaseCatalog`), read with the
 *   ANON client, so RLS and the publish filter decide exactly as on `/shop`: active, published
 *   products only. It holds a row per product and language; `selectPartnersShowcaseForLocale` then
 *   keeps one per translation group, the visitor's language first. Being locale-free, the read
 *   starts beside the tier read instead of after it.
 * - A Freemius product (a license) is priced from its plan's entry tier, the tier checkout charges:
 *   the active tier with the lowest license quota (ties by tier id) across every plan of the
 *   product's translation group (only the synced language owns plan rows). One order pays the yearly
 *   price when that tier sells one, with the monthly price beside it. Freemius amounts are major
 *   units of the store's default currency, as `ProductCard` reads them.
 * - Any other product: its current price in the store's base currency (a running sale included).
 * - Every read error throws inside the cache, so a degraded catalog (wrong currency, no language
 *   preference) is never stored. The catalog names the currency it priced in, and the page drops it
 *   if that is not the currency it renders in (the two caches can disagree for a few minutes after
 *   the default currency changes).
 *
 * Cached like the other public partner reads (5 minutes, shared by every visitor). The exported
 * reader never throws: a failed read shows no picker, and the calculator keeps its default order
 * value. Product edits do not evict it: a change (an archived product, a new price) shows once the
 * entry is older than 5 minutes and a visit refreshes it (stale-while-revalidate, so that visit still
 * sees the old catalog). Only titles and prices show, as an example; checkout reads live data.
 */

const SHOWCASE_REVALIDATE_SECONDS = 300;
/** Candidates read, by stored price: enough for the three priciest once plans are priced. */
const SHOWCASE_CANDIDATE_LIMIT = 60;
const TITLE_MAX_LENGTH = 120;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface ProductRow {
  id?: unknown;
  title?: unknown;
  slug?: unknown;
  payment_provider?: unknown;
  price?: unknown;
  prices?: unknown;
  sale_price?: unknown;
  sale_prices?: unknown;
  sale_start_at?: unknown;
  sale_end_at?: unknown;
  scheduled_price?: unknown;
  scheduled_prices?: unknown;
  scheduled_price_at?: unknown;
  language_id?: unknown;
  translation_group_id?: unknown;
}

interface PricingTierRow {
  id?: unknown;
  license_quota?: unknown;
  is_active?: unknown;
  api_monthly_price?: unknown;
  api_annual_price?: unknown;
  override_monthly_price?: unknown;
  override_annual_price?: unknown;
}

interface PlanGroupRow {
  translation_group_id?: unknown;
  freemius_plans?: unknown;
}

/** One product in one language, priced. */
export interface PartnersShowcaseCandidate {
  /** The row's language code (`en`, `fr`), or '' when unknown. */
  language: string;
  /** The translation group (or `id:<id>` for a row without one). */
  group: string;
  product: PartnersShowcaseProduct;
}

/** The cached catalog: every priced candidate, and the currency the prices are in. */
export interface PartnersShowcaseCatalog {
  currency: string;
  candidates: PartnersShowcaseCandidate[];
}

const PRODUCT_COLUMNS =
  'id, title, slug, payment_provider, price, prices, sale_price, sale_prices, sale_start_at, sale_end_at, scheduled_price, scheduled_prices, scheduled_price_at, language_id, translation_group_id';

const PLAN_COLUMNS =
  'translation_group_id, freemius_plans(id, freemius_pricing(id, license_quota, is_active, api_monthly_price, api_annual_price, override_monthly_price, override_annual_price))';

function numberOrNull(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function recordOrNull(value: unknown): Record<string, number> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, number>) : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value && typeof value === 'object' ? [value] : [];
}

/** A positive major-unit amount, else null (an unset or zero Freemius price is "not sold"). */
function positiveMajor(...values: unknown[]): number | null {
  for (const value of values) {
    const number = numberOrNull(value);
    if (number !== null) return number > 0 ? number : null;
  }
  return null;
}

/** `ORDER BY license_quota ASC NULLS LAST, id ASC` over the active tiers: the tier checkout charges. */
function compareEntryTiers(a: PricingTierRow, b: PricingTierRow): number {
  const aQuota = typeof a.license_quota === 'number' ? a.license_quota : null;
  const bQuota = typeof b.license_quota === 'number' ? b.license_quota : null;
  if (aQuota !== bQuota) {
    if (aQuota === null) return 1;
    if (bQuota === null) return -1;
    return aQuota - bQuota;
  }
  const aId = String(a.id ?? '');
  const bId = String(b.id ?? '');
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

/** Each translation group's entry tier, across every plan of every row of the group. */
export function partnersShowcaseEntryTiers(rows: PlanGroupRow[]): Map<string, PricingTierRow> {
  const tiersByGroup = new Map<string, PricingTierRow[]>();
  for (const row of rows) {
    const group = stringOrNull(row.translation_group_id);
    if (!group) continue;
    const tiers = tiersByGroup.get(group) ?? [];
    for (const plan of asArray(row.freemius_plans) as Array<{ freemius_pricing?: unknown }>) {
      for (const tier of asArray(plan.freemius_pricing) as PricingTierRow[]) {
        if (tier && tier.is_active !== false) tiers.push(tier);
      }
    }
    tiersByGroup.set(group, tiers);
  }
  const entry = new Map<string, PricingTierRow>();
  for (const [group, tiers] of tiersByGroup) {
    const first = [...tiers].sort(compareEntryTiers)[0];
    if (first) entry.set(group, first);
  }
  return entry;
}

/** The current price in the base currency (a running sale included), in minor units, or null. */
function currentPriceMinor(row: ProductRow, baseCurrency: string, currencies: CurrencyRecord[]): number | null {
  const fallbackPrice = numberOrNull(row.price);
  if (fallbackPrice === null) return null;
  try {
    const resolved = resolveEffectivePriceForCurrency({
      prices: recordOrNull(row.prices),
      salePrices: recordOrNull(row.sale_prices),
      fallbackPrice,
      fallbackSalePrice: numberOrNull(row.sale_price),
      saleStartAt: stringOrNull(row.sale_start_at),
      saleEndAt: stringOrNull(row.sale_end_at),
      scheduledPrice: numberOrNull(row.scheduled_price),
      scheduledPrices: recordOrNull(row.scheduled_prices),
      scheduledPriceAt: stringOrNull(row.scheduled_price_at),
      currencyCode: baseCurrency,
      currencies,
    });
    const amount = resolved.sale_price ?? resolved.price;
    return Number.isFinite(amount) && amount > 0 ? Math.round(amount) : null;
  } catch {
    return fallbackPrice > 0 ? Math.round(fallbackPrice) : null;
  }
}

/** Builds the picker entry for one product row, or null when it has no usable price. */
export function toPartnersShowcaseProduct(
  row: ProductRow,
  tier: PricingTierRow | null,
  baseCurrency: string,
  currencies: CurrencyRecord[],
): PartnersShowcaseProduct | null {
  const id = stringOrNull(row.id);
  const title = typeof row.title === 'string' ? row.title.trim().slice(0, TITLE_MAX_LENGTH) : '';
  const slug = typeof row.slug === 'string' ? row.slug.trim() : '';
  if (!id || !title || !SLUG_PATTERN.test(slug)) return null;
  const href = `/product/${slug}`;

  if (row.payment_provider === 'freemius' && tier) {
    const annual = positiveMajor(tier.override_annual_price, tier.api_annual_price);
    const monthly = positiveMajor(tier.override_monthly_price, tier.api_monthly_price);
    if (annual !== null) {
      return {
        id,
        title,
        href,
        orderValueMinor: majorUnitAmountToMinor(annual, baseCurrency),
        monthlyMinor: monthly === null ? null : majorUnitAmountToMinor(monthly, baseCurrency),
        billing: 'year',
      };
    }
    if (monthly !== null) {
      return { id, title, href, orderValueMinor: majorUnitAmountToMinor(monthly, baseCurrency), monthlyMinor: null, billing: 'month' };
    }
  }

  const price = currentPriceMinor(row, baseCurrency, currencies);
  return price === null ? null : { id, title, href, orderValueMinor: price, monthlyMinor: null, billing: 'once' };
}

/**
 * The visitor's candidates: one per translation group, the visitor's language first (a group with
 * no row in that language shows its first row), in catalog order. Empty when the catalog is missing
 * or priced in another currency than the page's.
 */
export function selectPartnersShowcaseForLocale(
  catalog: PartnersShowcaseCatalog | null,
  locale: AffiliateLocale,
  currency: string,
): PartnersShowcaseProduct[] {
  if (!catalog || catalog.currency !== currency) return [];
  const chosen = new Map<string, PartnersShowcaseCandidate>();
  for (const candidate of catalog.candidates) {
    const current = chosen.get(candidate.group);
    if (!current || (current.language !== locale && candidate.language === locale)) chosen.set(candidate.group, candidate);
  }
  const kept = new Set(chosen.values());
  return catalog.candidates.filter((candidate) => kept.has(candidate)).map((candidate) => candidate.product);
}

const getCachedShowcaseCatalog = unstable_cache(
  async (): Promise<PartnersShowcaseCatalog> => {
    const client = getSsgSupabaseClient();
    const [currencyResult, languageResult, productResult] = await Promise.all([
      client
        .from('currencies')
        .select('code, symbol, exchange_rate, is_default, is_active, rounding_mode, rounding_increment, rounding_charm_amount')
        .eq('is_active', true),
      client.from('languages').select('id, code'),
      client
        .from('products')
        .select(PRODUCT_COLUMNS)
        .eq('status', 'active')
        // Server-built (a timestamp), never user input.
        .or(buildPublishedAtOrFilter())
        .order('price', { ascending: false })
        .order('id', { ascending: true })
        .limit(SHOWCASE_CANDIDATE_LIMIT),
    ]);
    // Thrown inside the cache, so a degraded catalog is never stored.
    if (currencyResult.error || languageResult.error || productResult.error) throw new Error('PartnersShowcaseReadFailed');

    const currencies = Array.isArray(currencyResult.data)
      ? (currencyResult.data as Array<Record<string, unknown>>).map((row) => normalizeCurrencyRecord(row))
      : [];
    const currency = currencies.find((record) => record.is_default)?.code ?? 'USD';
    const languageCodes = new Map<number, string>();
    for (const row of Array.isArray(languageResult.data) ? (languageResult.data as Array<{ id: unknown; code: unknown }>) : []) {
      if (typeof row.id === 'number' && typeof row.code === 'string') languageCodes.set(row.id, row.code.trim().toLowerCase());
    }

    const rows = Array.isArray(productResult.data) ? (productResult.data as ProductRow[]) : [];
    const freemiusGroups = [
      ...new Set(
        rows
          .filter((row) => row.payment_provider === 'freemius')
          .map((row) => stringOrNull(row.translation_group_id))
          .filter((group): group is string => group !== null),
      ),
    ];

    let tiers = new Map<string, PricingTierRow>();
    if (freemiusGroups.length > 0) {
      const planResult = await client
        .from('products')
        .select(PLAN_COLUMNS)
        .in('translation_group_id', freemiusGroups)
        .eq('payment_provider', 'freemius');
      if (planResult.error) throw new Error('PartnersShowcasePlansReadFailed');
      tiers = partnersShowcaseEntryTiers(Array.isArray(planResult.data) ? (planResult.data as PlanGroupRow[]) : []);
    }

    const candidates: PartnersShowcaseCandidate[] = [];
    for (const row of rows) {
      const group = stringOrNull(row.translation_group_id);
      const product = toPartnersShowcaseProduct(row, group ? (tiers.get(group) ?? null) : null, currency, currencies);
      if (!product) continue;
      const language = typeof row.language_id === 'number' ? (languageCodes.get(row.language_id) ?? '') : '';
      candidates.push({ language, group: group ?? `id:${product.id}`, product });
    }
    return { currency, candidates };
  },
  ['affiliates-partners-showcase-catalog'],
  { revalidate: SHOWCASE_REVALIDATE_SECONDS },
);

/** The store's showcase catalog (every language), or null when it cannot be read. Never throws. */
export const getPartnersShowcaseCatalog = cache(async (): Promise<PartnersShowcaseCatalog | null> => {
  try {
    return await getCachedShowcaseCatalog();
  } catch (error) {
    console.error('[affiliates] Showcase product read failed:', error instanceof Error ? error.message : String(error));
    return null;
  }
});
