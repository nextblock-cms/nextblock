'use client';

import { Product } from '../types';
import { AddToCartButton } from './AddToCartButton';
import { ShortDescription } from './ShortDescription';
import { cn } from '@nextblock-cms/utils';
import { usePriceFormatter } from '../use-price-formatter';
import Link from 'next/link';

import { useTranslations } from '@nextblock-cms/utils';
import { useCurrency } from '../CurrencyProvider';
import {
  resolveEffectivePriceForCurrency,
  resolvePriceRangeForCurrency,
} from '../currency';
import { getTrialSummary } from '../trials';

interface FeaturedProductProps {
  product: Product;
  className?: string;
  imagePosition?: 'left' | 'right';
}

export const FeaturedProduct = ({ product, className, imagePosition = 'left' }: FeaturedProductProps) => {
  // Locale-aware: see use-price-formatter.ts.
  const formatPrice = usePriceFormatter();
  const { t } = useTranslations();
  const { activeCurrencyCode, currencies } = useCurrency();
  const variantRange = resolvePriceRangeForCurrency({
    entries:
      product.variants?.length
        ? product.variants
        : product.product_variants?.length
          ? product.product_variants
          : [],
    currencyCode: activeCurrencyCode,
    currencies,
  });
  const hasVariantPriceRange = Boolean(product.has_variants && variantRange);
  const resolvedPrice = resolveEffectivePriceForCurrency({
    prices: product.prices,
    salePrices: product.sale_prices,
    fallbackPrice: product.price,
    fallbackSalePrice: product.sale_price,
    saleStartAt: product.sale_start_at,
    saleEndAt: product.sale_end_at,
    scheduledPrice: product.scheduled_price,
    scheduledPrices: product.scheduled_prices,
    scheduledPriceAt: product.scheduled_price_at,
    currencyCode: activeCurrencyCode,
    currencies,
  });
  const priceLabel =
    hasVariantPriceRange && variantRange
      ? variantRange.min === variantRange.max
        ? formatPrice(variantRange.min, activeCurrencyCode)
        : `${formatPrice(variantRange.min, activeCurrencyCode)} - ${formatPrice(
            variantRange.max,
            activeCurrencyCode
          )}`
      : formatPrice(resolvedPrice.sale_price ?? resolvedPrice.price, activeCurrencyCode);
  const trialSummary = getTrialSummary(product, t);
  
  return (
    <div className={cn("overflow-hidden rounded-xl border bg-card shadow-sm", className)}>
      <div className={cn("flex flex-col gap-8 md:flex-row", imagePosition === 'right' && "md:flex-row-reverse")}>
        
        {/* Image Section */}
        <div className="relative aspect-square w-full md:w-1/2">
             {product.image_url ? (
                <img
                    src={product.image_url}
                    alt={product.title}
                    width={800}
                    height={800}
                    loading="lazy"
                    decoding="async"
                    className="h-full w-full object-cover"
                />
             ) : (
                <div className="flex h-full w-full items-center justify-center bg-secondary text-muted-foreground">
                    {t('ecommerce.no_image')}
                </div>
             )}
        </div>

        {/* Content Section */}
        <div className="flex flex-1 flex-col justify-center p-6 md:p-12">
            <Link href={`/product/${product.slug}`}>
                <h2 className="mb-4 text-3xl font-bold tracking-tight hover:underline md:text-4xl">
                    {product.title}
                </h2>
            </Link>
            
            <div className="mb-6 flex items-baseline gap-3">
                <span className="text-3xl font-bold text-primary">
                    {priceLabel}
                </span>
                {!hasVariantPriceRange && resolvedPrice.sale_price && (
                    <span className="text-lg text-muted-foreground line-through">
                        {formatPrice(resolvedPrice.price, activeCurrencyCode)}
                    </span>
                )}
            </div>

            {trialSummary && (
                <div className="mb-6 inline-flex w-fit flex-col rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
                    <span className="font-semibold">{trialSummary.label}</span>
                    <span className="text-emerald-700">
                        {trialSummary.paymentRequirementLabel}
                    </span>
                </div>
            )}

            <ShortDescription
                value={product.short_description}
                className="mb-8 text-lg text-muted-foreground"
            />

            <div className="flex flex-col gap-4 sm:flex-row">
                <AddToCartButton 
                    product={product} 
                    className="h-12 w-full px-8 text-lg sm:w-auto"
                />

                <Link 
                    href={`/product/${product.slug}`} 
                    className="inline-flex h-12 items-center justify-center rounded-md border border-input bg-background px-8 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
                >
                    {t('ecommerce.view_details')}
                </Link>

            </div>
        </div>
      </div>
    </div>
  );
};
