'use client';

import { Product } from '../types';
import { AddToCartButton } from './AddToCartButton';
import { cn, majorUnitAmountToMinor, useTranslations } from '@nextblock-cms/utils';
import { usePriceFormatter } from '../use-price-formatter';
import Link from 'next/link';
import { useCurrency } from '../CurrencyProvider';
import {
  resolveEffectivePriceForCurrency,
  resolvePriceForCurrency,
  resolvePriceRangeForCurrency,
} from '../currency';
import { getTrialSummary } from '../trials';

import { resolveTranslatedText } from '../variation-utils';

interface ProductCardProps {
  product: Product;
  className?: string;
  /** Above the fold (first grid row): load the image eagerly instead of lazily. */
  priority?: boolean;
}

export const ProductCard = ({ product, className, priority = false }: ProductCardProps) => {
  // Locale-aware: see use-price-formatter.ts.
  const formatPrice = usePriceFormatter();
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

  // Only flag "On Sale" when an effective (schedule-active) sale price exists —
  // for a variant product, when any variant is currently on sale.
  const variantSaleEntries =
    product.variants?.length
      ? product.variants
      : product.product_variants?.length
        ? product.product_variants
        : [];
  const onSale = hasVariantPriceRange
    ? variantSaleEntries.some(
        (variant) =>
          resolveEffectivePriceForCurrency({
            prices: variant.prices,
            salePrices: variant.sale_prices,
            fallbackPrice: variant.price,
            fallbackSalePrice: variant.sale_price,
            saleStartAt: variant.sale_start_at,
            saleEndAt: variant.sale_end_at,
            scheduledPrice: variant.scheduled_price,
            scheduledPrices: variant.scheduled_prices,
            scheduledPriceAt: variant.scheduled_price_at,
            currencyCode: activeCurrencyCode,
            currencies,
          }).sale_price != null
      )
    : resolvedPrice.sale_price != null;

  const { t, lang } = useTranslations();
  // `t` returns the key itself when a translation is missing, so fall back to a
  // readable label until `ecommerce.on_sale` is seeded (migration …026).
  const onSaleLabelRaw = t('ecommerce.on_sale');
  const onSaleLabel = onSaleLabelRaw === 'ecommerce.on_sale' ? 'On Sale' : onSaleLabelRaw;
  const trialSummary = getTrialSummary(product, t);

  // Freemius pricing resolution
  const firstPlan = product.freemius_plans?.[0];
  const firstPricing = firstPlan?.freemius_pricing?.[0];
  const defaultCurrencyCode =
    currencies.find((c) => c.is_default)?.code || 'USD';

  const monthlyPriceMajor =
    firstPricing?.override_monthly_price ?? firstPricing?.api_monthly_price;
  const annualPriceMajor =
    firstPricing?.override_annual_price ?? firstPricing?.api_annual_price;

  const monthlyPriceResolved =
    typeof monthlyPriceMajor === 'number'
      ? resolvePriceForCurrency({
          prices: {
            [defaultCurrencyCode]: majorUnitAmountToMinor(
              monthlyPriceMajor,
              defaultCurrencyCode
            ),
          },
          currencyCode: activeCurrencyCode,
          currencies,
        })
      : null;

  const annualPriceResolved =
    typeof annualPriceMajor === 'number'
      ? resolvePriceForCurrency({
          prices: {
            [defaultCurrencyCode]: majorUnitAmountToMinor(
              annualPriceMajor,
              defaultCurrencyCode
            ),
          },
          currencyCode: activeCurrencyCode,
          currencies,
        })
      : null;

  return (
    <div className={cn("group relative flex flex-col overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm transition-shadow hover:shadow-md", className)}>
      {/* The title below links to the same page. This duplicate is for pointer users only:
          out of the tab order and hidden from assistive tech, so a keyboard user tabs once
          per card and never lands on a focus ring the card's overflow would clip. */}
      <Link
        href={`/product/${product.slug}`}
        tabIndex={-1}
        aria-hidden="true"
        className="relative aspect-square overflow-hidden bg-muted"
      >
        {onSale && (
          <span className="absolute left-3 top-3 z-10 rounded-full bg-destructive px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-destructive-foreground shadow-sm">
            {onSaleLabel}
          </span>
        )}
        {product.image_url ? (
          <img
            src={product.image_url}
            alt=""
            width={600}
            height={600}
            loading={priority ? 'eager' : 'lazy'}
            decoding="async"
            className="h-full w-full object-cover object-center transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
             {t('ecommerce.no_image') === 'ecommerce.no_image' ? 'No image' : t('ecommerce.no_image')}
          </div>
        )}
      </Link>

      <div className="flex flex-1 flex-col p-4">
        {product.categories && product.categories.length > 0 && (
          <div className="text-[10px] font-bold uppercase tracking-widest text-amber-600 dark:text-amber-400 mb-1">
            {product.categories
              .map((cat) => resolveTranslatedText(cat.name, cat.name_translations, lang))
              .join(' • ')}
          </div>
        )}
        <Link href={`/product/${product.slug}`} className="mb-2">
           <h3 className="line-clamp-1 text-lg font-medium text-foreground group-hover:underline">
             {product.title}
           </h3>
        </Link>

        {/* Rating stars display */}
        <div className="flex items-center gap-1 mb-2 mt-0.5 text-xs text-muted-foreground min-h-[1.25rem] select-none">
          {product.total_reviews && product.total_reviews > 0 ? (
            <>
              {/* role="img" so the label is announced; on a plain <div> it was ignored, and it
                  claimed "0 out of 5" for products nobody had reviewed. */}
              <div
                role="img"
                aria-label={
                  t('ecommerce.rating_out_of_5', { rating: Number(product.average_rating ?? 0).toFixed(1) }) ===
                  'ecommerce.rating_out_of_5'
                    ? `Rated ${Number(product.average_rating ?? 0).toFixed(1)} out of 5`
                    : t('ecommerce.rating_out_of_5', { rating: Number(product.average_rating ?? 0).toFixed(1) })
                }
                className="flex items-center text-amber-500 mr-1"
              >
                {Array.from({ length: 5 }).map((_, i) => {
                  const ratingValue = product.average_rating ?? 0;
                  return (
                    <svg
                      key={i}
                      className={cn(
                        "h-3.5 w-3.5 fill-current",
                        i < Math.round(ratingValue) ? "text-amber-500" : "text-slate-200 dark:text-slate-800"
                      )}
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                    </svg>
                  );
                })}
              </div>
              <span className="font-semibold text-slate-700 dark:text-slate-300">
                {Number(product.average_rating).toFixed(1)}
              </span>
              <span className="ml-0.5">({product.total_reviews})</span>
            </>
          ) : (
            <span className="text-slate-400 dark:text-slate-600">{t('reviews.no_reviews')}</span>
          )}
        </div>
        
        <div className="mb-4">
          {product.product_type === 'digital' && (monthlyPriceResolved || annualPriceResolved) ? (
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              {monthlyPriceResolved && (
                <div className="flex items-baseline gap-0.5">
                  <span className="text-xl font-bold text-primary">
                    {formatPrice(monthlyPriceResolved.price, activeCurrencyCode)}
                  </span>
                  <span className="text-xs font-medium text-muted-foreground lowercase">
                    / {t('ecommerce.month')}
                  </span>
                </div>
              )}
              {annualPriceResolved && (
                <div className="flex items-baseline gap-0.5">
                  <span className={cn("font-bold text-primary", monthlyPriceResolved ? "text-lg" : "text-xl")}>
                    {formatPrice(annualPriceResolved.price, activeCurrencyCode)}
                  </span>
                  <span className="text-xs font-medium text-muted-foreground lowercase">
                    / {t('ecommerce.year')}
                  </span>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-baseline gap-2">
              <span className="text-xl font-bold text-primary">
                {priceLabel}
              </span>
              {!hasVariantPriceRange && resolvedPrice.sale_price && (
                <span className="text-sm text-muted-foreground tabular-nums">
                  <span className="sr-only">
                    {t('ecommerce.regular_price') === 'ecommerce.regular_price' ? 'Regular price' : t('ecommerce.regular_price')}{' '}
                  </span>
                  <s>{formatPrice(resolvedPrice.price, activeCurrencyCode)}</s>
                </span>
              )}
            </div>
          )}
        </div>

        {trialSummary && (
          <div className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
            <div className="font-semibold">{trialSummary.label}</div>
            <div className="text-emerald-700">
              {trialSummary.paymentRequirementLabel}
            </div>
          </div>
        )}

        <div className="mt-auto">
          <AddToCartButton 
            product={{
              ...product,
              price: product.price,
              prices: product.prices,
              sale_price: product.sale_price,
              sale_prices: product.sale_prices,
            }} 
            className="w-full"
          />
        </div>
      </div>
    </div>
  );
};
