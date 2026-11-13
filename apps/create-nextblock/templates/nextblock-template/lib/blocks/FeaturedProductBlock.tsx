import { FeaturedProduct } from '@nextblock-cms/ecommerce/components/FeaturedProduct';
import { getProduct } from '@nextblock-cms/ecommerce/server';
import { normalizePriceMap, normalizeSalePriceMap } from '@nextblock-cms/ecommerce/currency';
import { getVariantEffectivePriceRange } from '@nextblock-cms/ecommerce/variation-utils';

import type { FeaturedProductBlockContent } from './ecommerce-block-schemas';
import { getSsgSupabaseClient } from '@nextblock-cms/db/server';
import { resolveMediaUrlWithSupabaseFallback } from '../media/resolveMediaUrl';

// Component (Server Component)
export const FeaturedProductBlock = async ({ content }: { content: FeaturedProductBlockContent }) => {
  const supabase = getSsgSupabaseClient();
  const { data: product } = await getProduct(supabase, content.productId); // Assuming getProduct takes ID or Slug. Usually ID for blocks.
  const productRecord = product as any;

  if (!productRecord) {
      return null; // Or render placeholder in edit mode
  }

  // Image Resolution: a bundled key (images/…) from the app's /images, any other from the bucket.
  const mediaItem = productRecord.product_media?.[0]?.media;
  const imageUrl = resolveMediaUrlWithSupabaseFallback(mediaItem?.file_path) ?? undefined;

  const variantPriceRange = getVariantEffectivePriceRange(
    ((product as any).product_variants || []).map((variant: any) => ({
      price: variant.price,
      sale_price: variant.sale_price,
      sale_start_at: variant.sale_start_at ?? null,
      sale_end_at: variant.sale_end_at ?? null,
    }))
  );
  const uiProduct = {
    id: productRecord.id,
    title: productRecord.title,
    slug: productRecord.slug,
    sku: productRecord.sku,
    upc: productRecord.upc || undefined,
    price: productRecord.price,
    prices: normalizePriceMap(productRecord.prices),
    sale_price:
      typeof productRecord.sale_price === 'number' ? productRecord.sale_price : undefined,
    sale_prices: normalizeSalePriceMap(productRecord.sale_prices),
    sale_start_at: productRecord.sale_start_at ?? null,
    sale_end_at: productRecord.sale_end_at ?? null,
    scheduled_price:
      typeof productRecord.scheduled_price === 'number' ? productRecord.scheduled_price : undefined,
    scheduled_prices: normalizePriceMap(productRecord.scheduled_prices),
    scheduled_price_at: productRecord.scheduled_price_at ?? null,
    is_taxable: productRecord.is_taxable ?? true,
    product_type: productRecord.product_type ?? undefined,
    payment_provider: productRecord.payment_provider ?? undefined,
    price_range_min: variantPriceRange?.min ?? null,
    price_range_max: variantPriceRange?.max ?? null,
    image_url: imageUrl,
    short_description: productRecord.short_description || undefined,
    stock: productRecord.stock,
    freemius_product_id: productRecord.freemius_product_id || undefined,
    freemius_plan_id: productRecord.freemius_plan_id || undefined,
    trial_period_days: productRecord.trial_period_days ?? 0,
    trial_requires_payment_method: productRecord.trial_requires_payment_method ?? false,
    freemius_plans: productRecord.freemius_plans,
    language_id: productRecord.language_id,
    translation_group_id: productRecord.translation_group_id || "",
    has_variants: (productRecord.product_variants?.length || 0) > 0,
    product_variants: (productRecord.product_variants || []).map((variant: any) => ({
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
  };

  return (
    <section className={`py-12 ${content.showBackground ? 'bg-secondary/30' : ''}`}>
       <div className="container">
          <FeaturedProduct product={uiProduct} imagePosition={content.imagePosition} />
       </div>
    </section>
  );
};
