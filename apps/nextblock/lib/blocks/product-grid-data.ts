import { getProducts } from '@nextblock-cms/ecommerce/server';
import { normalizePriceMap, normalizeSalePriceMap } from '@nextblock-cms/ecommerce/currency';
import { getVariantEffectivePriceRange } from '@nextblock-cms/ecommerce/variation-utils';
import type { Product } from '@nextblock-cms/ecommerce/types';
import { getSsgSupabaseClient } from '@nextblock-cms/db/server';

import { resolveMediaUrlWithSupabaseFallback } from '../media/resolveMediaUrl';
import { PRODUCT_GRID_MAX_LIMIT } from './ecommerce-block-schemas';

type SupabaseClientLike = ReturnType<typeof getSsgSupabaseClient>;

export interface ProductGridQuery {
  type?: 'latest' | 'category' | 'manual';
  categoryIds?: string[];
  productIds?: string[];
  /** Products per page, or `0` for every match on a single page. */
  limit: number;
  /** 1-based page number. */
  page?: number;
  languageId?: number;
  excludeProductId?: string;
  excludeTranslationGroupId?: string | null;
}

export interface ProductGridPage {
  products: Product[];
  /** Total matches across all pages, before exclusions. */
  totalCount: number;
}

/** Turn a `getProducts` row into the shape `<ProductGrid />` renders. */
export function mapProductRowToUiProduct(p: any): Product {
  const productRecord = p as any;
  // Accessing the nested media object correctly (array of objects with media property)
  // The type from getProducts select is: product_media: { media: { file_path: string | null } | null }[]
  // A bundled key (images/…) resolves to the app's /images, any other key to the media bucket.
  const mediaItem = p.product_media?.[0]?.media;
  const imageUrl = resolveMediaUrlWithSupabaseFallback(mediaItem?.file_path) ?? undefined;

  const variantPriceRange = getVariantEffectivePriceRange(
    (p.product_variants || []).map((variant: any) => ({
      price: variant.price,
      sale_price: variant.sale_price,
      sale_start_at: variant.sale_start_at ?? null,
      sale_end_at: variant.sale_end_at ?? null,
    }))
  );

  return {
    id: p.id,
    title: p.title,
    slug: p.slug,
    sku: p.sku,
    average_rating: p.average_rating,
    total_reviews: p.total_reviews,
    upc: p.upc || undefined,
    price: p.price,
    prices: normalizePriceMap(p.prices),
    sale_price: typeof p.sale_price === 'number' ? p.sale_price : undefined,
    sale_prices: normalizeSalePriceMap(p.sale_prices),
    sale_start_at: p.sale_start_at ?? null,
    sale_end_at: p.sale_end_at ?? null,
    scheduled_price: typeof p.scheduled_price === 'number' ? p.scheduled_price : undefined,
    scheduled_prices: normalizePriceMap(p.scheduled_prices),
    scheduled_price_at: p.scheduled_price_at ?? null,
    is_taxable: p.is_taxable ?? true,
    product_type: productRecord.product_type ?? undefined,
    payment_provider: productRecord.payment_provider ?? undefined,
    price_range_min: variantPriceRange?.min ?? null,
    price_range_max: variantPriceRange?.max ?? null,
    image_url: imageUrl,
    short_description: p.short_description || undefined,
    categories: (p.product_categories || []).map((pc: any) => pc.category).filter(Boolean),
    language_id: p.language_id as number,
    translation_group_id: p.translation_group_id || "",
    freemius_product_id: productRecord.freemius_product_id || undefined,
    freemius_plan_id: productRecord.freemius_plan_id || undefined,
    trial_period_days: productRecord.trial_period_days ?? 0,
    trial_requires_payment_method:
      productRecord.trial_requires_payment_method ?? false,
    freemius_plans: productRecord.freemius_plans,
    has_variants: (p.product_variants?.length || 0) > 0,
    product_variants: (p.product_variants || []).map((variant: any) => ({
      id: variant.id,
      price: variant.price,
      prices: normalizePriceMap(variant.prices),
      sale_price: variant.sale_price,
      sale_prices: normalizeSalePriceMap(variant.sale_prices),
      sale_start_at: variant.sale_start_at ?? null,
      sale_end_at: variant.sale_end_at ?? null,
      scheduled_price: variant.scheduled_price ?? null,
      scheduled_prices: normalizePriceMap(variant.scheduled_prices),
      scheduled_price_at: variant.scheduled_price_at ?? null,
    })),
  } as Product;
}

/**
 * Load hand-picked products in the author's chosen order. Selections are made
 * against a single language, so when the page renders in another language each
 * pick is swapped for its translation (falling back to the picked row when the
 * product has not been translated yet).
 */
async function fetchHandPickedProducts(
  supabase: SupabaseClientLike,
  productIds: string[],
  languageId?: number
): Promise<any[]> {
  const { data: pickedRows } = await getProducts(supabase, {
    productIds,
    limit: productIds.length,
  });

  const picked = (pickedRows || []) as any[];
  if (picked.length === 0) return [];

  const rowById = new Map(picked.map((row) => [row.id, row]));
  let ordered = productIds
    .map((id) => rowById.get(id))
    .filter(Boolean) as any[];

  if (languageId && ordered.some((row) => row.language_id !== languageId)) {
    const groupIds = Array.from(
      new Set(ordered.map((row) => row.translation_group_id).filter(Boolean))
    ) as string[];

    if (groupIds.length > 0) {
      const { data: translatedRows } = await getProducts(supabase, {
        translationGroupIds: groupIds,
        languageId,
        limit: groupIds.length,
      });
      const rowByGroup = new Map(
        ((translatedRows || []) as any[]).map((row) => [row.translation_group_id, row])
      );
      ordered = ordered.map((row) => rowByGroup.get(row.translation_group_id) ?? row);
    }
  }

  // Picking two translations of the same product resolves to one product here.
  const seen = new Set<string>();
  return ordered.filter((row) => {
    const key = row.translation_group_id || row.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Drop the product the grid is embedded under (related-products placements). */
function applyExclusions(rows: any[], query: ProductGridQuery): any[] {
  const { excludeProductId, excludeTranslationGroupId } = query;
  if (!excludeProductId && !excludeTranslationGroupId) return rows;
  return rows.filter((row) => {
    if (excludeProductId && row.id === excludeProductId) return false;
    if (excludeTranslationGroupId && row.translation_group_id === excludeTranslationGroupId) {
      return false;
    }
    return true;
  });
}

/**
 * One page of a product grid. Shared by the block's server render (page 1) and
 * the pagination server action (page N) so both agree on ordering and shape.
 */
export async function loadProductGridPage(query: ProductGridQuery): Promise<ProductGridPage> {
  const supabase = getSsgSupabaseClient();
  const page = Math.max(1, Math.floor(query.page ?? 1));
  const limit = Math.min(Math.max(0, Math.floor(query.limit ?? 6)), PRODUCT_GRID_MAX_LIMIT);
  const hasExclusions = Boolean(query.excludeProductId || query.excludeTranslationGroupId);

  if (query.type === 'manual') {
    const productIds = query.productIds ?? [];
    if (productIds.length === 0) return { products: [], totalCount: 0 };

    // The whole hand-picked list is at most PRODUCT_GRID_MAX_PRODUCTS rows, so
    // it is cheaper to resolve it once and page in memory than to re-query.
    const rows = applyExclusions(
      await fetchHandPickedProducts(supabase, productIds, query.languageId),
      query
    );
    const paged = limit > 0 ? rows.slice((page - 1) * limit, page * limit) : rows;
    return { products: paged.map(mapProductRowToUiProduct), totalCount: rows.length };
  }

  // Over-fetch just enough to refill a page after the excluded product is dropped.
  const overFetch = hasExclusions ? 2 : 0;
  const { data, count } = await getProducts(supabase, {
    languageId: query.languageId,
    categoryIds: query.type === 'category' ? query.categoryIds : undefined,
    offset: limit > 0 ? (page - 1) * limit : undefined,
    limit: limit > 0 ? limit + overFetch : 0,
  });

  const rows = applyExclusions((data || []) as any[], query);
  const visible = limit > 0 ? rows.slice(0, limit) : rows;

  return {
    products: visible.map(mapProductRowToUiProduct),
    totalCount: count ?? rows.length,
  };
}
