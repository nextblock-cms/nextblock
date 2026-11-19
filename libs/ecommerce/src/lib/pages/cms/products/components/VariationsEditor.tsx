'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Input, Label } from '@nextblock-cms/ui';

import { ProductFormValues } from '../../../../product-schema';
import {
  ProductVariantDraft,
  VariationSelectionGroup,
  extractSelectedTermsByAttribute,
  generateVariantDrafts,
  resolveAttributeName,
  resolveTermValue,
} from '../../../../variation-utils';
import { ProductAttribute } from '../../../../types';
import { CurrencyPriceFields } from './CurrencyPriceFields';
import { SaleScheduleFields, type SaleScheduleField } from './SaleScheduleFields';
import {
  convertMinorUnitAmount,
  normalizeCurrencyRecord,
  type CurrencyRecord,
} from '../../../../currency';
import {
  getStoreManagedPriceCurrencyCodes,
  resolveEditorCurrencyPriceMaps,
  sanitizeVariantDraftsForStoreManagedCurrencies,
} from '../product-price-sync';
import {
  majorUnitAmountToMinor,
  minorUnitAmountToMajor,
} from '@nextblock-cms/utils';
import { resolveMediaUrlWithSupabaseFallback } from '@nextblock-cms/utils/media-url';

interface VariationsEditorProps {
  globalAttributes: ProductAttribute[];
  currentLanguageCode?: string;
  baseSku: string;
  basePrice: number;
  basePrices?: Record<string, number | null | undefined>;
  baseSalePrice?: number | null;
  baseSalePrices?: Record<string, number | null | undefined>;
  /** The product's sale window, which a new combination takes with the product's sale amounts. */
  baseSaleStartAt?: string | null;
  baseSaleEndAt?: string | null;
  currencies: CurrencyRecord[];
  availableVariantImages?: Array<{
    media_id: string;
    file_path: string;
    alt?: string | null;
  }>;
  initialVariationAttributes?: ProductFormValues['variation_attributes'];
  initialVariants?: ProductFormValues['variants'];
  onChange: (payload: {
    variationAttributes: ProductFormValues['variation_attributes'];
    variants: ProductFormValues['variants'];
  }) => void;
}

/**
 * The largest quantity an inventory row holds (`inventory_items.quantity` and `products.stock` are
 * integers), as product-actions.ts and the app's productFormData.ts hold a stock.
 */
const MAX_STOCK_QUANTITY = 2147483647;

function formatCurrency(value: number, currencyCode = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currencyCode,
  }).format(value);
}

function buildVariationAttributes(selectedTermsByAttribute: Record<string, string[]>) {
  return Object.entries(selectedTermsByAttribute)
    .filter(([, termIds]) => termIds.length > 0)
    .map(([attribute_id, term_ids]) => ({ attribute_id, term_ids }));
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * What the variant list is regenerated from, each as one string compared by value: the selected
 * terms, and each currency's code with the flags that decide which amounts a variant keeps.
 */
function buildRegenerationInputs(selectedAttributes: VariationSelectionGroup[], currencies: CurrencyRecord[]) {
  return {
    terms: JSON.stringify(
      selectedAttributes
        .map((attribute) => [attribute.attribute_id, attribute.terms.map((term) => term.id).sort(compareText)] as const)
        .sort(([left], [right]) => compareText(left, right))
    ),
    currencies: JSON.stringify(
      currencies
        .map((currency) => normalizeCurrencyRecord(currency))
        .map((currency) => [currency.code, currency.is_default, currency.auto_sync_product_prices])
    ),
  };
}

export function VariationsEditor({
  globalAttributes,
  currentLanguageCode,
  baseSku,
  basePrice,
  basePrices,
  baseSalePrice,
  baseSalePrices,
  baseSaleStartAt,
  baseSaleEndAt,
  currencies,
  availableVariantImages = [],
  initialVariationAttributes,
  initialVariants,
  onChange,
}: VariationsEditorProps) {
  const [selectedTermsByAttribute, setSelectedTermsByAttribute] = useState<Record<string, string[]>>(() => {
    // Only entries it can read that select a term: an object with a text attribute id, and its text term
    // ids. ProductForm hands it readable entries only; given a draft's null entry, or term ids that were an
    // object or a number, this threw on mount, which took the whole product edit page down. With no entry
    // selecting a term, the selection comes from the variants' own options, as the form's change check
    // assumes (variationAttributesMatchFormValues in ProductForm): taken as a selection of nothing, the
    // variants showed with none of their terms selected, the panel's next mount emitted a change no one
    // made, and toggling another term regenerated the list without them.
    const attributes = (Array.isArray(initialVariationAttributes) ? initialVariationAttributes : [])
      .filter((attribute) => attribute !== null && typeof attribute === 'object' && typeof attribute.attribute_id === 'string')
      .map((attribute) => {
        const termIds: unknown[] = Array.isArray(attribute.term_ids) ? attribute.term_ids : [];
        return [
          attribute.attribute_id,
          termIds.every((termId) => typeof termId === 'string')
            ? (termIds as string[])
            : termIds.filter((termId): termId is string => typeof termId === 'string'),
        ] as const;
      })
      .filter(([, termIds]) => termIds.length > 0);
    if (attributes.length > 0) {
      return Object.fromEntries(attributes);
    }

    return extractSelectedTermsByAttribute(initialVariants || []);
  });
  const [variantDrafts, setVariantDrafts] = useState<ProductVariantDraft[]>(
    sanitizeVariantDraftsForStoreManagedCurrencies(
      (initialVariants as ProductVariantDraft[]) || [],
      currencies
    ) as ProductVariantDraft[]
  );

  const selectedAttributes = useMemo<VariationSelectionGroup[]>(
    () =>
      globalAttributes
        .map((attribute) => ({
          attribute_id: attribute.id,
          attribute_name: resolveAttributeName(attribute, currentLanguageCode),
          terms: attribute.terms
            .filter((term) => (selectedTermsByAttribute[attribute.id] || []).includes(term.id))
            .map((term) => ({
              ...term,
              value: resolveTermValue(term, currentLanguageCode),
            })),
        }))
        .filter((attribute) => attribute.terms.length > 0),
    [currentLanguageCode, globalAttributes, selectedTermsByAttribute]
  );

  // The editor opens on exactly the variants the form holds and regenerates them only when the
  // selected terms change (a toggle) or the currencies do, compared by value, so a render with new
  // objects for the same terms and currencies regenerates nothing. Regenerating on open rebuilt every
  // combination of the selected terms, so a product whose variants are not all of them (Cortex's
  // manage_product_variants, a CMS import) gained the missing ones at the product's price with
  // stock 0, and the form autosaved that with no edit. A change to the product's SKU, prices or sale
  // regenerates nothing: an existing variant keeps its own values, so that rebuild only added the
  // missing combinations (a product SKU edit did), or emptied the list when the attribute list
  // lacked the variants' terms. A toggle reads the product's current values for what it adds.
  const { terms: selectedTermsKey, currencies: currenciesKey } = buildRegenerationInputs(
    selectedAttributes,
    currencies
  );
  const regeneratedForRef = useRef({ terms: selectedTermsKey, currencies: currenciesKey });

  useEffect(() => {
    const previousInputs = regeneratedForRef.current;
    if (selectedTermsKey === previousInputs.terms && currenciesKey === previousInputs.currencies) {
      return;
    }
    regeneratedForRef.current = { terms: selectedTermsKey, currencies: currenciesKey };

    if (selectedAttributes.length === 0) {
      // Only deselecting the last term empties the list.
      if (selectedTermsKey !== previousInputs.terms) {
        setVariantDrafts([]);
      }
      return;
    }

    setVariantDrafts((currentDrafts) =>
      sanitizeVariantDraftsForStoreManagedCurrencies(
        generateVariantDrafts({
          baseSku,
          basePrice,
          basePrices,
          baseSalePrice,
          baseSalePrices,
          baseSaleStartAt,
          baseSaleEndAt,
          selectedAttributes,
          previousVariants: currentDrafts,
        }) as ProductFormValues['variants'],
        currencies
      ) as ProductVariantDraft[]
    );
  }, [
    basePrice,
    basePrices,
    baseSaleEndAt,
    baseSalePrice,
    baseSalePrices,
    baseSaleStartAt,
    baseSku,
    currencies,
    currenciesKey,
    selectedAttributes,
    selectedTermsKey,
  ]);

  useEffect(() => {
    onChange({
      variationAttributes: buildVariationAttributes(selectedTermsByAttribute),
      variants: variantDrafts,
    });
  }, [onChange, selectedTermsByAttribute, variantDrafts]);

  // Held at the largest stock a row holds, as the app's edit page holds the read-only total beside the
  // variants and the publish holds the product's stock it writes from them: unheld, two variants of
  // 2147483647 showed "Stock: 4294967294", a stock nothing can hold.
  const totalVariantStock = variantDrafts.reduce(
    (accumulator, variant) => Math.min(MAX_STOCK_QUANTITY, accumulator + (variant.stock_quantity || 0)),
    0
  );
  const defaultCurrency = currencies.find((currency) => currency.is_default) ?? currencies[0];
  const storeManagedPriceCurrencyCodes = useMemo(
    () => getStoreManagedPriceCurrencyCodes(currencies),
    [currencies]
  );

  const handleToggleTerm = (attributeId: string, termId: string) => {
    setSelectedTermsByAttribute((current) => {
      const selectedTerms = new Set(current[attributeId] || []);
      if (selectedTerms.has(termId)) {
        selectedTerms.delete(termId);
      } else {
        selectedTerms.add(termId);
      }

      return {
        ...current,
        [attributeId]: [...selectedTerms],
      };
    });
  };

  const handleVariantChange = (
    combinationKey: string,
    field:
      | 'sku'
      | 'upc'
      | 'price'
      | 'sale_price'
      | 'stock_quantity'
      | 'prices'
      | 'sale_prices',
    value: string
  ) => {
    setVariantDrafts((currentDrafts) =>
      currentDrafts.map((variant) => {
        if (variant.combination_key !== combinationKey) {
          return variant;
        }

        if (field === 'sku') {
          return {
            ...variant,
            sku: value,
          };
        }

        if (field === 'upc') {
          return {
            ...variant,
            upc: value,
          };
        }

        if (field === 'sale_price' && value === '') {
          return {
            ...variant,
            sale_price: null,
          };
        }

        if (field === 'prices' || field === 'sale_prices') {
          return variant;
        }

        const numericValue = value === '' ? 0 : Number(value);

        return {
          ...variant,
          [field]: Number.isFinite(numericValue) ? numericValue : 0,
        };
      })
    );
  };

  const handleVariantScheduleChange = (
    combinationKey: string,
    field: SaleScheduleField,
    value: string | null
  ) => {
    setVariantDrafts((currentDrafts) =>
      currentDrafts.map((variant) =>
        variant.combination_key === combinationKey
          ? { ...variant, [field]: value }
          : variant
      )
    );
  };

  const handleVariantCurrencyChange = (
    combinationKey: string,
    currencyCode: string,
    field: 'prices' | 'sale_prices',
    value: number | null
  ) => {
    const defaultCurrency = currencies.find((currency) => currency.is_default) ?? currencies[0];

    setVariantDrafts((currentDrafts) =>
      currentDrafts.map((variant) => {
        if (variant.combination_key !== combinationKey) {
          return variant;
        }

        const nextMap = {
          ...(field === 'prices' ? variant.prices : variant.sale_prices),
          [currencyCode]: value,
        };

        return {
          ...variant,
          [field]: nextMap,
          ...(currencyCode === defaultCurrency?.code
            ? field === 'prices'
              ? { price: value ?? 0 }
              : { sale_price: value }
            : {}),
        };
      })
    );
  };

  const autoFillVariantCurrencies = (combinationKey: string) => {
    const defaultCurrency = currencies.find((currency) => currency.is_default) ?? currencies[0];
    const storeManagedCurrencyCodeSet = new Set(storeManagedPriceCurrencyCodes);

    if (!defaultCurrency) {
      return;
    }

    setVariantDrafts((currentDrafts) =>
      currentDrafts.map((variant) => {
        if (variant.combination_key !== combinationKey) {
          return variant;
        }

        const nextPrices = currencies.reduce<Record<string, number>>((accumulator, currency) => {
          if (
            currency.code !== defaultCurrency.code &&
            storeManagedCurrencyCodeSet.has(currency.code)
          ) {
            return accumulator;
          }

          const convertedMinor = convertMinorUnitAmount({
            amount: majorUnitAmountToMinor(variant.price, defaultCurrency.code),
            fromCurrencyCode: defaultCurrency.code,
            toCurrencyCode: currency.code,
            currencies,
            applyRounding: true,
          });
          accumulator[currency.code] = minorUnitAmountToMajor(convertedMinor, currency.code);
          return accumulator;
        }, {});

        const nextSalePrices = currencies.reduce<Record<string, number | null>>(
          (accumulator, currency) => {
            if (
              currency.code !== defaultCurrency.code &&
              storeManagedCurrencyCodeSet.has(currency.code)
            ) {
              return accumulator;
            }

            if (typeof variant.sale_price !== 'number') {
              accumulator[currency.code] = null;
              return accumulator;
            }

            const convertedMinor = convertMinorUnitAmount({
              amount: majorUnitAmountToMinor(variant.sale_price, defaultCurrency.code),
              fromCurrencyCode: defaultCurrency.code,
              toCurrencyCode: currency.code,
              currencies,
              applyRounding: true,
            });
            accumulator[currency.code] = minorUnitAmountToMajor(convertedMinor, currency.code);
            return accumulator;
          },
          {}
        );

        return {
          ...variant,
          prices: nextPrices,
          sale_prices: nextSalePrices,
        };
      })
    );
  };

  const handleVariantImageSelect = (
    combinationKey: string,
    selectedMediaId: string
  ) => {
    const selectedMedia = availableVariantImages.find((image) => image.media_id === selectedMediaId);
    if (!selectedMedia) {
      return;
    }

    const filePath = selectedMedia.file_path;
    const imageUrl = resolveMediaUrlWithSupabaseFallback(filePath);

    setVariantDrafts((currentDrafts) =>
      currentDrafts.map((variant) =>
        variant.combination_key === combinationKey
          ? {
              ...variant,
              main_media_id: selectedMedia.media_id,
              main_image_url: imageUrl,
            }
          : variant
      )
    );
  };

  const clearVariantImage = (combinationKey: string) => {
    setVariantDrafts((currentDrafts) =>
      currentDrafts.map((variant) =>
        variant.combination_key === combinationKey
          ? {
              ...variant,
              main_media_id: null,
              main_image_url: null,
            }
          : variant
      )
    );
  };

  if (globalAttributes.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
        No global attributes have been created yet. Create them first in{' '}
        <Link href="/cms/products/attributes" className="font-medium text-primary underline-offset-4 hover:underline">
          Attribute Management
        </Link>
        .
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Attributes selector */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="text-xs uppercase font-bold text-muted-foreground tracking-wider leading-none">Attributes</span>
            <Badge variant="outline" className="text-[10px] px-1.5 h-4">{variantDrafts.length} variants</Badge>
            <Badge variant="secondary" className="text-[10px] px-1.5 h-4">Stock: {totalVariantStock}</Badge>
          </div>
          <Button asChild variant="outline" size="sm" className="h-7 text-xs px-3">
            <Link href="/cms/products/attributes">Manage</Link>
          </Button>
        </div>

        <div className="grid gap-2 lg:grid-cols-2">
          {globalAttributes.map((attribute) => {
            const selectedTerms = selectedTermsByAttribute[attribute.id] || [];

            return (
              <div key={attribute.id} className="flex items-center gap-3 rounded border p-2.5">
                <div className="shrink-0 w-[100px]">
                  <span className="text-sm font-bold block leading-tight">{resolveAttributeName(attribute, currentLanguageCode)}</span>
                  <span className="text-[10px] text-muted-foreground leading-none">{selectedTerms.length} selected</span>
                </div>
                <div className="flex flex-wrap gap-1.5 flex-1">
                  {attribute.terms.map((term) => {
                    const isSelected = selectedTerms.includes(term.id);

                    return (
                      <button
                        key={term.id}
                        type="button"
                        onClick={() => handleToggleTerm(attribute.id, term.id)}
                        className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                          isSelected
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border bg-background text-foreground hover:border-primary/40'
                        }`}
                      >
                        {resolveTermValue(term, currentLanguageCode)}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Variant cards */}
      {variantDrafts.length === 0 ? (
        <div className="rounded border border-dashed p-3 text-xs text-muted-foreground text-center">
          Select terms above to generate variations.
        </div>
      ) : (
        <div className="space-y-2">
          {variantDrafts.map((variant) => {
            const resolvedVariantPriceMaps = resolveEditorCurrencyPriceMaps({
              currencies,
              prices: variant.prices || {},
              salePrices: variant.sale_prices || {},
              fallbackPrice: variant.price,
              fallbackSalePrice: variant.sale_price,
            });

            return (
              <div key={variant.combination_key} className="rounded border p-3 space-y-2">
                {/* Header row: label + price summary */}
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold">{variant.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {/* A CMS draft import's variants carry only their term ids. */}
                      {(variant.selected_options ?? [])
                        .map((option) => `${option.attribute_name}: ${option.term_value}`)
                        .join(' · ')}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span>Reg: {formatCurrency(variant.price, defaultCurrency?.code || 'USD')}</span>
                    <span>
                      Sale:{' '}
                      {variant.sale_price !== null && variant.sale_price !== undefined
                        ? formatCurrency(variant.sale_price, defaultCurrency?.code || 'USD')
                        : '—'}
                    </span>
                  </div>
                </div>

                {/* SKU / UPC / Stock — single row */}
                <div className="grid grid-cols-3 gap-2.5">
                  <div className="flex items-center gap-2">
                    <Label htmlFor={`variant-sku-${variant.combination_key}`} className="text-xs uppercase font-bold text-muted-foreground tracking-wider shrink-0">SKU</Label>
                    <Input
                      id={`variant-sku-${variant.combination_key}`}
                      value={variant.sku}
                      onChange={(event) =>
                        handleVariantChange(variant.combination_key, 'sku', event.target.value)
                      }
                      placeholder="SKU"
                      className="h-8 text-sm font-mono"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Label htmlFor={`variant-upc-${variant.combination_key}`} className="text-xs uppercase font-bold text-muted-foreground tracking-wider shrink-0">UPC</Label>
                    <Input
                      id={`variant-upc-${variant.combination_key}`}
                      value={variant.upc ?? ''}
                      onChange={(event) =>
                        handleVariantChange(variant.combination_key, 'upc', event.target.value)
                      }
                      placeholder="—"
                      className="h-8 text-sm font-mono"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Label htmlFor={`variant-stock-${variant.combination_key}`} className="text-xs uppercase font-bold text-muted-foreground tracking-wider shrink-0">Qty</Label>
                    <Input
                      id={`variant-stock-${variant.combination_key}`}
                      type="number"
                      min="0"
                      value={variant.stock_quantity}
                      onChange={(event) =>
                        handleVariantChange(
                          variant.combination_key,
                          'stock_quantity',
                          event.target.value
                        )
                      }
                      className="h-8 text-sm font-mono w-20"
                    />
                  </div>
                </div>

                {/* Currency prices */}
                <CurrencyPriceFields
                  idPrefix={`variant-${variant.combination_key}`}
                  currencies={currencies}
                  prices={resolvedVariantPriceMaps.prices}
                  salePrices={resolvedVariantPriceMaps.salePrices}
                  managedCurrencyCodes={storeManagedPriceCurrencyCodes}
                  onPriceChange={(currencyCode, value) =>
                    handleVariantCurrencyChange(
                      variant.combination_key,
                      currencyCode,
                      'prices',
                      value
                    )
                  }
                  onSalePriceChange={(currencyCode, value) =>
                    handleVariantCurrencyChange(
                      variant.combination_key,
                      currencyCode,
                      'sale_prices',
                      value
                    )
                  }
                  onAutoFill={() => autoFillVariantCurrencies(variant.combination_key)}
                  helperText={
                    storeManagedPriceCurrencyCodes.length > 0
                      ? `Store-managed currencies derive from ${defaultCurrency?.code || 'the base currency'}.`
                      : undefined
                  }
                  trailing={
                    <SaleScheduleFields
                      idPrefix={`variant-${variant.combination_key}`}
                      startAt={variant.sale_start_at}
                      endAt={variant.sale_end_at}
                      onChange={(field, value) =>
                        handleVariantScheduleChange(variant.combination_key, field, value)
                      }
                      bare
                    />
                  }
                />

                {/* Image selector — single inline row */}
                <div className="flex items-center gap-3 pt-1.5 border-t border-muted/30">
                  {variant.main_image_url && (
                    <div className="h-9 w-9 overflow-hidden rounded border bg-background shrink-0">
                      <img
                        src={variant.main_image_url}
                        alt={`${variant.label} image`}
                        className="h-full w-full object-cover"
                      />
                    </div>
                  )}
                  <span className="text-xs uppercase font-bold text-muted-foreground tracking-wider shrink-0">Image</span>
                  {availableVariantImages.length > 0 ? (
                    <select
                      className="flex h-8 rounded-md border border-input bg-background px-2 py-1 text-sm min-w-[180px]"
                      value={variant.main_media_id ?? ''}
                      onChange={(event) => {
                        if (!event.target.value) {
                          clearVariantImage(variant.combination_key);
                          return;
                        }
                        handleVariantImageSelect(variant.combination_key, event.target.value);
                      }}
                    >
                      <option value="">Use parent image</option>
                      {availableVariantImages.map((image, index) => (
                        <option key={image.media_id} value={image.media_id}>
                          {image.alt?.trim() || `Gallery image ${index + 1}`}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-xs text-muted-foreground">Add gallery images first.</span>
                  )}
                  {variant.main_media_id && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs px-2 text-muted-foreground hover:text-destructive"
                      onClick={() => clearVariantImage(variant.combination_key)}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
