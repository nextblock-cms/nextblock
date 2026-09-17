'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Download, Package, ShieldCheck } from 'lucide-react';
import { Badge } from '@nextblock-cms/ui/badge';
import { Button } from '@nextblock-cms/ui/button';
import { Label } from '@nextblock-cms/ui/label';
import { Separator } from '@nextblock-cms/ui/separator';
import { cn, useTranslations } from '@nextblock-cms/utils';
import { usePriceFormatter } from '../use-price-formatter';

import { useProduct } from '../product-context';
import { ProductGallery } from './ProductGallery';
import { AddToCartButton } from './AddToCartButton';
import { SubscriptionSelector } from './SubscriptionSelector';
import { SimpleTiptapRenderer, toNoCookieEmbedSrc } from './SimpleTiptapRenderer';
import {
  chooseInitialVariantSelections,
  findMatchingVariant,
  applyVariantSelection,
  getAvailableTermIdsForAttribute,
  normalizeSelectionsToAvailableVariants,
  resolveTranslatedText,
} from '../variation-utils';
import { useCurrency } from '../CurrencyProvider';
import { resolveEffectivePriceForCurrency } from '../currency';
import { isDigitalProduct } from '../types';
import { getTrialSummary } from '../trials';

type ProductVisualEditingField =
  | 'title'
  | 'short_description'
  | 'description_json';
type ProductVisualEditingInput = 'plain-text' | 'tiptap';

type ProductVisualEditAttributes = {
  'data-vercel-edit-info'?: string;
  'data-vercel-edit-target'?: string;
  'data-nextblock-visual-edit'?: string;
};

interface ProductDetailsLayoutProps {
  visualEditingEnabled?: boolean;
  descriptionNode?: React.ReactNode;
  reviewsNode?: React.ReactNode;
  /**
   * False when the store cannot take payment for this product's provider. The whole
   * purchase control — physical or digital — is then replaced by `purchaseFallbackNode`.
   * Defaults to true so every existing caller is unaffected.
   */
  canPurchase?: boolean;
  /** Rendered in place of the buy controls when `canPurchase` is false. */
  purchaseFallbackNode?: React.ReactNode;
}

function buildProductVisualEditAttributes(
  product: ReturnType<typeof useProduct>,
  field: ProductVisualEditingField,
  input: ProductVisualEditingInput,
  label: string,
): ProductVisualEditAttributes | undefined {
  const target = {
    kind: 'product-field' as const,
    field,
    input,
    label,
  };

  const baseUrl = typeof window !== 'undefined'
    ? window.location.origin
    : (process.env.NEXT_PUBLIC_URL || 
       process.env.TARGET_URL || 
       (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "") || 
       "http://localhost:3000");

  const pageOrigin = typeof window !== 'undefined'
    ? window.location.origin
    : (process.env.NEXT_PUBLIC_URL || 
       process.env.TARGET_URL || 
       (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "") || 
       "http://localhost:3000");

  let origin = pageOrigin.replace(/\/+$/, "");
  try {
    if (origin.startsWith('http://') || origin.startsWith('https://')) {
      origin = new URL(origin).hostname;
    }
  } catch {
    // Fallback
  }

  const projectId = process.env.NEXTBLOCK_VERCEL_PROJECT_ID || process.env.VERCEL_PROJECT_ID;
  const workspaceId = process.env.NEXTBLOCK_VERCEL_WORKSPACE_ID || process.env.VERCEL_ORG_ID;

  const payload: any = {
    origin,
    editUrl: `${baseUrl}/cms/products/${product.id}/edit`,
    data: {
      parentType: 'product',
      parentId: product.id,
      slug: product.slug,
      languageId: product.language_id,
      draftId: null,
      target,
    },
  };

  if (projectId) {
    payload.projectId = projectId;
  }
  if (workspaceId) {
    payload.workspaceId = workspaceId;
  }

  return {
    'data-vercel-edit-info': JSON.stringify(payload),
    'data-vercel-edit-target': JSON.stringify(target),
    'data-nextblock-visual-edit': `product:${field}`,
  };
}

export const ProductDetailsLayout: React.FC<ProductDetailsLayoutProps> = ({
  visualEditingEnabled = false,
  descriptionNode,
  reviewsNode,
  canPurchase = true,
  purchaseFallbackNode,
}) => {
  const product = useProduct();
  const { t, lang } = useTranslations();
  // Locale-aware: see use-price-formatter.ts.
  const formatPrice = usePriceFormatter();
  const { activeCurrencyCode, currencies } = useCurrency();
  const titleVisualEditAttributes = visualEditingEnabled
    ? buildProductVisualEditAttributes(
        product,
        'title',
        'plain-text',
        'Product title',
      )
    : undefined;
  const shortDescriptionVisualEditAttributes = visualEditingEnabled
    ? buildProductVisualEditAttributes(
        product,
        'short_description',
        'plain-text',
        'Short description',
      )
    : undefined;
  const descriptionVisualEditAttributes = visualEditingEnabled
    ? buildProductVisualEditAttributes(
        product,
        'description_json',
        'tiptap',
        'Product description',
      )
    : undefined;

  const translateOrFallback = (
    key: string,
    fallback: string,
    params?: Record<string, string | number>,
  ) => {
    const translated = t(key, params);
    return translated === key ? fallback : translated;
  };

  const images =
    product.images && product.images.length > 0
      ? product.images
      : product.image_url
        ? [{ url: product.image_url, alt: product.title }]
        : [];

  const isFreemius =
    (product as any).custom_props?.provider === 'freemius' ||
    isDigitalProduct(product);
  const trialSummary = getTrialSummary(product, t);
  const hasVariants =
    !isFreemius &&
    Boolean(
      product.has_variants &&
      product.attributes?.length &&
      product.variants?.length,
    );
  const attributes = product.attributes || [];
  const variants = product.variants || [];
  const [selectedTerms, setSelectedTerms] = useState<
    Record<string, string | undefined>
  >(() => chooseInitialVariantSelections(attributes, variants));
  const [quantity, setQuantity] = useState(1);

  useEffect(() => {
    setQuantity(1);
  }, [product.id]);

  useEffect(() => {
    if (!hasVariants) {
      return;
    }

    setSelectedTerms(chooseInitialVariantSelections(attributes, variants));
  }, [attributes, hasVariants, product.id, variants]);

  const normalizedSelections = useMemo(() => {
    if (!hasVariants) {
      return selectedTerms;
    }

    return normalizeSelectionsToAvailableVariants(
      attributes,
      variants,
      selectedTerms,
    );
  }, [attributes, hasVariants, selectedTerms, variants]);

  useEffect(() => {
    if (
      JSON.stringify(normalizedSelections) !== JSON.stringify(selectedTerms)
    ) {
      setSelectedTerms(normalizedSelections);
    }
  }, [normalizedSelections, selectedTerms]);

  const selectedVariant = useMemo(() => {
    if (!hasVariants) {
      return null;
    }

    return findMatchingVariant(variants, normalizedSelections);
  }, [hasVariants, normalizedSelections, variants]);

  const resolvedBasePrice = resolveEffectivePriceForCurrency({
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
  const resolvedVariantPrice =
    hasVariants && selectedVariant
      ? resolveEffectivePriceForCurrency({
          prices: selectedVariant.prices,
          salePrices: selectedVariant.sale_prices,
          fallbackPrice: selectedVariant.price,
          fallbackSalePrice: selectedVariant.sale_price,
          saleStartAt: selectedVariant.sale_start_at,
          saleEndAt: selectedVariant.sale_end_at,
          scheduledPrice: selectedVariant.scheduled_price,
          scheduledPrices: selectedVariant.scheduled_prices,
          scheduledPriceAt: selectedVariant.scheduled_price_at,
          currencyCode: activeCurrencyCode,
          currencies,
        })
      : null;
  const effectivePrice = resolvedVariantPrice?.price ?? resolvedBasePrice.price;
  const effectiveSalePrice =
    resolvedVariantPrice?.sale_price ?? resolvedBasePrice.sale_price;
  // `null` = not inventory-tracked (`products.stock` is nullable). It used to collapse to 0,
  // so an untracked product said "Out of stock" and lost its quantity stepper while the
  // add-to-cart button, which already treats null as unlimited, stayed enabled.
  const effectiveStock: number | null = hasVariants
    ? (selectedVariant?.stock_quantity ?? 0)
    : (product.stock ?? null);
  const isInStock = effectiveStock === null || effectiveStock > 0;
  // Clamped at render: switching to a variant with less stock used to keep e.g. 8 selected
  // when 3 exist, and the add then failed in the cart store.
  const effectiveQuantity =
    effectiveStock === null ? quantity : Math.max(1, Math.min(quantity, Math.max(effectiveStock, 1)));

  const displayImages = useMemo(() => {
    if (!selectedVariant?.image_url) {
      return images;
    }

    const variantImage = {
      url: selectedVariant.image_url,
      alt: `${product.title} ${selectedVariant.label}`,
    };
    const dedupedImages = images.filter(
      (image) => image.url !== selectedVariant.image_url,
    );
    return [variantImage, ...dedupedImages];
  }, [images, product.title, selectedVariant]);

  const discountPercentage =
    typeof effectiveSalePrice === 'number' && effectivePrice > 0
      ? Math.round(
          ((effectivePrice - effectiveSalePrice) / effectivePrice) * 100,
        )
      : 0;

  const addToCartProduct =
    hasVariants && selectedVariant
      ? {
          ...product,
          sku: selectedVariant.sku,
          price: selectedVariant.price,
          prices: selectedVariant.prices,
          sale_price:
            typeof selectedVariant.sale_price === 'number'
              ? selectedVariant.sale_price
              : null,
          sale_prices: selectedVariant.sale_prices,
          // The variant's own sale window and scheduled price, not the parent product's.
          sale_start_at: selectedVariant.sale_start_at,
          sale_end_at: selectedVariant.sale_end_at,
          scheduled_price: selectedVariant.scheduled_price,
          scheduled_prices: selectedVariant.scheduled_prices,
          scheduled_price_at: selectedVariant.scheduled_price_at,
          image_url: selectedVariant.image_url || product.image_url,
          stock: selectedVariant.stock_quantity,
          variant_id: selectedVariant.id,
          variant_label: selectedVariant.label,
          selected_options: selectedVariant.selected_options,
          currency_code: activeCurrencyCode,
        }
      : {
          ...product,
          currency_code: activeCurrencyCode,
        };

  const handleSelectionChange = (attributeId: string, termId: string) => {
    setSelectedTerms((current) =>
      applyVariantSelection(attributes, variants, current, attributeId, termId),
    );
  };

  const inStockLabel =
    effectiveStock === null
      ? translateOrFallback('ecommerce.in_stock_untracked', 'In stock')
      : translateOrFallback('ecommerce.in_stock', `${effectiveStock} in stock`, {
          count: String(effectiveStock),
        });
  const outOfStockLabel = translateOrFallback(
    'ecommerce.out_of_stock',
    'Out of stock',
  );
  const selectOptionsLabel = translateOrFallback(
    'ecommerce.select_options',
    'Select Options',
  );
  const variantSelectionRequiredLabel = translateOrFallback(
    'ecommerce.variant_selection_required',
    'Select one term from every dropdown to resolve a variation.',
  );

  return (
    <div className="w-full animate-in fade-in slide-in-from-bottom-4 duration-700 ease-out">
      <div className="container mx-auto px-4 md:px-6 py-12">
        <div className="grid gap-12 lg:grid-cols-[2fr_3fr] items-start">
          <div className="w-full max-w-2xl mx-auto lg:max-w-none">
            <ProductGallery images={displayImages} className="w-full" />
          </div>

          <div className="flex flex-col gap-4 pb-2 max-w-xl mx-auto lg:mx-0 lg:max-w-none">
            <div className="space-y-6">
              <div className="space-y-4">
                

                <h1
                  className="text-3xl sm:text-4xl lg:text-5xl font-extrabold tracking-tight text-foreground leading-[1.1] lg:mt-0"
                  {...titleVisualEditAttributes}
                >
                  {product.title}
                </h1>

                {/* Rating display under title */}
                <div className="flex items-center gap-2 mt-2">
                  <a
                    href="#reviews-section"
                    className="flex items-center gap-1.5 group hover:opacity-85 transition-opacity"
                  >
                    <div className="flex items-center text-amber-500">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <svg
                          key={i}
                          className={cn(
                            "h-4 w-4 fill-current",
                            i < Math.round(product.average_rating || 0)
                              ? "text-amber-500"
                              : "text-slate-300 dark:text-slate-700"
                          )}
                          viewBox="0 0 20 20"
                          fill="currentColor"
                        >
                          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                        </svg>
                      ))}
                    </div>
                    {product.total_reviews && product.total_reviews > 0 ? (
                      <>
                        <span className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                          {product.average_rating?.toFixed(1)}
                        </span>
                        <span className="text-sm text-muted-foreground underline decoration-dotted group-hover:text-primary">
                          ({product.total_reviews === 1
                            ? t('reviews.review_count_one', { count: product.total_reviews })
                            : t('reviews.review_count_other', { count: product.total_reviews })})
                        </span>
                      </>
                    ) : (
                      <span className="text-xs text-muted-foreground group-hover:text-primary underline decoration-dotted">
                        {t('reviews.be_the_first')}
                      </span>
                    )}
                  </a>
                </div>

                {product.categories && product.categories.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-amber-600 dark:text-amber-400">
                    {product.categories.map((cat, idx) => {
                      const resolvedName = resolveTranslatedText(
                        cat.name,
                        cat.name_translations,
                        lang,
                      );
                      return (
                        <React.Fragment key={cat.id}>
                          {idx > 0 && (
                            <span className="text-muted-foreground/30">•</span>
                          )}
                          <span>{resolvedName}</span>
                        </React.Fragment>
                      );
                    })}
                  </div>
                )}

                <div
                  className="prose prose-neutral dark:prose-invert max-w-none text-muted-foreground leading-relaxed text-left"
                  {...shortDescriptionVisualEditAttributes}
                >
                  {product.short_description ? (
                    <div
                      className="text-lg mb-4 leading-relaxed"
                      dangerouslySetInnerHTML={{
                        __html:
                          toNoCookieEmbedSrc(product.short_description) ??
                          product.short_description,
                      }}
                    />
                  ) : visualEditingEnabled ? (
                    <p className="text-lg mb-4 italic text-muted-foreground">
                      Add a short product description.
                    </p>
                  ) : null}
                </div>
                
                <div className="flex items-center gap-3">
                  {typeof effectiveSalePrice === 'number' && (
                    <Badge
                      variant="destructive"
                      className="px-2.5 py-1 text-xs font-bold uppercase tracking-wide animate-pulse shadow-sm"
                    >
                      {t('ecommerce.sale_badge', {
                        percent: String(discountPercentage),
                      })}
                    </Badge>
                  )}
                  {!isFreemius && effectiveStock !== null && effectiveStock > 0 && effectiveStock < 10 && (
                    <Badge
                      variant="outline"
                      className="text-amber-600 border-amber-200 bg-amber-50"
                    >
                      {t('ecommerce.low_stock', {
                        count: String(effectiveStock),
                      })}
                    </Badge>
                  )}
                  {trialSummary && (
                    <Badge
                      variant="secondary"
                      className="border border-emerald-200 bg-emerald-50 text-emerald-800"
                    >
                      {trialSummary.label}
                    </Badge>
                  )}
                </div>
              </div>
            </div>

            {/* Unified Purchase Card */}
            {/* Opaque on purpose: this card is above the fold, and `backdrop-blur-*` there costs
                a compositing pass on the first frame (project rule). */}
            <div className="p-5 rounded-2xl bg-card border border-border/80 shadow-md space-y-4">
              {!canPurchase ? (
                purchaseFallbackNode
              ) : isFreemius ? (
                <SubscriptionSelector product={product} />
              ) : (
                <div className="space-y-3.5">
                  {/* Price & Status display inside the card */}
                  <div className="flex items-center justify-between gap-4">
                    <div className="space-y-1">
                      <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
                        {translateOrFallback('ecommerce.price', 'Price')}
                      </span>
                      <div className="flex items-baseline gap-2.5">
                        <span className="text-3xl font-extrabold text-foreground">
                          {formatPrice(
                            effectiveSalePrice ?? effectivePrice,
                            activeCurrencyCode,
                          )}
                        </span>
                        {typeof effectiveSalePrice === 'number' && (
                          <span className="text-lg text-muted-foreground line-through decoration-destructive/20 decoration-1">
                            {formatPrice(effectivePrice, activeCurrencyCode)}
                          </span>
                        )}
                      </div>
                    </div>

                    {!isFreemius && (selectedVariant || !hasVariants) && (
                      <div className="text-right space-y-1">
                        <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest block">
                          {!hasVariants && product.sku && (
                            <span className="mr-2 font-normal lowercase normal-case text-muted-foreground/70">
                              {translateOrFallback('ecommerce.sku', 'SKU')}: {product.sku}
                            </span>
                          )}
                          {translateOrFallback('ecommerce.status', 'Status')}
                        </span>
                        <div className={isInStock ? 'text-emerald-600 dark:text-emerald-400 font-semibold text-sm' : 'text-destructive font-semibold text-sm'}>
                          {isInStock ? inStockLabel : outOfStockLabel}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Variant Selector inside the card */}
                  {hasVariants && (
                    <div className="space-y-3">
                      <div className="grid gap-3 sm:grid-cols-2">
                        {attributes.map((attribute, attributeIndex) => {
                          // Unconstrained on purpose: a term is only disabled when NO variant
                          // uses it. Disabling against the other dropdowns' current values made
                          // whole combinations unreachable (with just Red/S and Blue/M, both
                          // Blue and M stayed greyed out forever).
                          const availableTermIds =
                            getAvailableTermIdsForAttribute(
                              variants,
                              attribute.id,
                              {},
                            );

                          return (
                            <div key={attribute.id} className="space-y-1">
                              <div className="flex items-center justify-between">
                                <Label
                                  htmlFor={`attribute-${attribute.id}`}
                                  className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider"
                                >
                                  {attribute.name}
                                </Label>
                                {/* Once, not once per attribute. */}
                                {attributeIndex === 0 && selectedVariant?.sku && (
                                  <span className="text-[10px] text-muted-foreground font-mono">
                                    {selectedVariant.sku}
                                  </span>
                                )}
                              </div>
                              <select
                                id={`attribute-${attribute.id}`}
                                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                                value={normalizedSelections[attribute.id] || ''}
                                onChange={(event) =>
                                  handleSelectionChange(
                                    attribute.id,
                                    event.target.value,
                                  )
                                }
                              >
                                {attribute.terms.map((term) => (
                                  <option
                                    key={term.id}
                                    value={term.id}
                                    disabled={!availableTermIds.has(term.id)}
                                  >
                                    {term.value}
                                  </option>
                                ))}
                              </select>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {hasVariants && !selectedVariant && (
                    <p className="text-xs text-muted-foreground italic pt-1">
                      {variantSelectionRequiredLabel}
                    </p>
                  )}

                  {/* Qty Selector & Add to Cart button */}
                  <div className="flex items-center gap-3 pt-1">
                    {!isFreemius && isInStock && (
                      <div
                        role="group"
                        aria-label={translateOrFallback('ecommerce.quantity', 'Quantity')}
                        className="flex items-center border rounded-lg h-12 bg-background border-input select-none"
                      >
                        <button
                          type="button"
                          onClick={() => setQuantity(Math.max(1, effectiveQuantity - 1))}
                          aria-label={translateOrFallback('ecommerce.decrease_quantity', 'Decrease quantity')}
                          className="px-3 h-full flex items-center justify-center rounded-l-lg text-muted-foreground hover:text-foreground active:scale-95 transition-colors text-lg font-medium focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                          disabled={effectiveQuantity <= 1}
                        >
                          <span aria-hidden="true">-</span>
                        </button>
                        <span aria-live="polite" aria-atomic="true" className="w-8 text-center text-sm font-semibold tabular-nums">
                          {effectiveQuantity}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setQuantity(
                              effectiveStock !== null && effectiveQuantity >= effectiveStock
                                ? effectiveQuantity
                                : effectiveQuantity + 1,
                            )
                          }
                          aria-label={translateOrFallback('ecommerce.increase_quantity', 'Increase quantity')}
                          className="px-3 h-full flex items-center justify-center rounded-r-lg text-muted-foreground hover:text-foreground active:scale-95 transition-colors text-lg font-medium focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                          disabled={
                            effectiveStock !== null &&
                            effectiveQuantity >= effectiveStock
                          }
                        >
                          <span aria-hidden="true">+</span>
                        </button>
                      </div>
                    )}
                    {hasVariants &&
                    (!selectedVariant || !isInStock) ? (
                      <Button
                        disabled
                        className="flex-1 h-12 text-md font-bold shadow-md"
                      >
                        {selectedVariant ? outOfStockLabel : selectOptionsLabel}
                      </Button>
                    ) : (
                      <AddToCartButton
                        product={addToCartProduct}
                        quantity={effectiveQuantity}
                        className="flex-1 h-12 text-base font-bold shadow-md transition-shadow hover:shadow-lg active:scale-[0.98]"
                      />
                    )}
                  </div>
                </div>
              )}

              <Separator className="opacity-60 my-0.5" />

              <div className="grid grid-cols-2 gap-4 text-center text-[11px] font-medium text-muted-foreground pt-1">
                <div className="flex items-center justify-center gap-2">
                  {isFreemius ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Download className="h-3.5 w-3.5" />
                      {t('ecommerce.instant_digital_delivery')}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5">
                      <Package className="h-3.5 w-3.5" />
                      {t('ecommerce.free_shipping')}
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-center gap-2">
                  <span className="inline-flex items-center gap-1.5">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    {t('ecommerce.secure_checkout')}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="min-w-0 w-full" {...(!descriptionNode ? descriptionVisualEditAttributes : undefined)}>
        {descriptionNode ? (
          descriptionNode
        ) : product.description_json ? (
          <div className="container mx-auto px-4 md:px-6 pb-12 prose prose-neutral dark:prose-invert max-w-none leading-relaxed">
            <SimpleTiptapRenderer content={product.description_json} />
          </div>
        ) : (
          <div className="container mx-auto px-4 md:px-6 pb-12">
            <p className="italic text-sm text-muted-foreground">
              {t('ecommerce.no_description')}
            </p>
          </div>
        )}
      </div>

      {/* Product Reviews Section */}
      {reviewsNode && (
        <div id="reviews-section" className="border-t border-border mt-12 pt-12">
          {reviewsNode}
        </div>
      )}
    </div>
  );
};
