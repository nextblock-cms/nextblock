'use client';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { z } from 'zod';

import { zodResolver } from '@hookform/resolvers/zod';
import { CheckCircle2, AlertCircle, Info } from 'lucide-react';
import {
  Badge,
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@nextblock-cms/ui';
// Use dependency injection for NotionEditor to avoid SSR/lazy-loading issues
import { ProductFormValues, productSchema } from '../../../../product-schema';
import { useForm } from 'react-hook-form';
import { ProductMediaManager } from './ProductMediaManager';
import { SyncFreemiusPricingButton } from './SyncFreemiusPricingButton';
import { VariationsEditor } from './VariationsEditor';
import { CurrencyPriceFields } from './CurrencyPriceFields';
import { SaleScheduleFields } from './SaleScheduleFields';
import { ProductCategorySelector } from './ProductCategorySelector';
import {
  getStoreManagedPriceCurrencyCodes,
  resolveEditorCurrencyPriceMaps,
  sanitizeProductFormValuesForStoreManagedCurrencies,
} from '../product-price-sync';
import {
  type EnabledPaymentProviders,
  ProductAttribute,
  derivePaymentProviderFromProductType,
} from '../../../../types';
import { convertMinorUnitAmount, type CurrencyRecord } from '../../../../currency';
import {
  majorUnitAmountToMinor,
  minorUnitAmountToMajor,
} from '@nextblock-cms/utils';

type ProductLanguageOption = {
  id: number;
  name: string;
  code: string;
  is_default?: boolean;
};

type ProductMediaRelation = {
  id?: string;
  media_id: string;
  sort_order?: number | null;
  media?: {
    file_path?: string | null;
    object_key?: string | null;
    alt_text?: string | null;
  } | null;
};

type ProductMediaManagerItem = {
  id: string;
  media_id: string;
  file_path: string;
  alt: string;
  sort_order: number;
};

type ProductFormInitialData = Omit<z.infer<typeof productSchema>, 'product_media'> & {
  id?: string;
  product_media?: ProductMediaRelation[];
  language_id?: number;
  translation_group_id?: string;
  category_ids?: string[];
};

type PaymentConfigStatus = {
  stripe: {
    hasKeys: boolean;
    missing: string[];
  };
  freemius: {
    hasKeys: boolean;
    missing: string[];
  };
};

interface ProductFormProps {
  initialData?: ProductFormInitialData;
  isEdit?: boolean;
  mediaPickerNode?: React.ReactNode;
  availableLanguagesProp: ProductLanguageOption[];
  globalAttributesProp: ProductAttribute[];
  currenciesProp: CurrencyRecord[];
  translationGroupId?: string;
  targetLanguageId?: string;
  freemiusDashboardNode?: React.ReactNode;
  enabledProviders: EnabledPaymentProviders;
  configStatus: PaymentConfigStatus;
  createAction?: (data: ProductFormValues) => Promise<void>;
  updateAction?: (data: ProductFormValues) => Promise<{ success: boolean } | void>;
  availableCategoriesProp?: Array<{ id: string; name: string; slug: string }>;
  /** Whether an unpublished draft is currently open for this product (drives the Freemius sync warning). */
  hasOpenDraft?: boolean;
  /** Live notification for title or SEO metadata changes in the form. */
  onSeoChange?: (values: {
    title?: string | null;
    meta_title?: string | null;
    meta_description?: string | null;
  }) => void;
}

interface FormSectionProps {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  hideHeader?: boolean;
}

function FormSection({ title, description, action, children, hideHeader }: FormSectionProps) {
  return (
    <section className="rounded-lg border bg-card p-3 shadow-sm space-y-3">
      {!hideHeader && (
        <div className="flex items-start justify-between gap-4 flex-wrap border-b border-muted/50 pb-2 mb-1">
          <div className="space-y-0.5">
            <h2 className="text-sm font-bold tracking-tight">{title}</h2>
            {description ? (
              <p className="text-[11px] text-muted-foreground leading-none">{description}</p>
            ) : null}
          </div>
          {action}
        </div>
      )}
      <div className={hideHeader ? "" : "pt-1"}>
        {children}
      </div>
    </section>
  );
}

function resolveDefaultLanguageId(
  initialData: ProductFormInitialData | undefined,
  targetLanguageId: string | undefined,
  availableLanguages: ProductLanguageOption[]
) {
  const parsedTargetLanguageId = targetLanguageId
    ? Number.parseInt(targetLanguageId, 10)
    : undefined;

  return (
    initialData?.language_id ||
    (Number.isFinite(parsedTargetLanguageId) ? parsedTargetLanguageId : undefined) ||
    availableLanguages.find((language) => language.is_default)?.id ||
    availableLanguages[0]?.id ||
    1
  );
}

function buildProductFormDefaults(
  initialData: ProductFormInitialData | undefined,
  targetLanguageId: string | undefined,
  availableLanguages: ProductLanguageOption[],
  currencies: CurrencyRecord[],
  translationGroupId?: string
): z.input<typeof productSchema> {
  const defaultCurrency =
    currencies.find((currency) => currency.is_default) ?? currencies[0];
  const defaultCurrencyCode = defaultCurrency?.code || 'USD';
  const initialPrices =
    initialData?.prices && Object.keys(initialData.prices).length > 0
      ? initialData.prices
      : {
          [defaultCurrencyCode]:
            typeof initialData?.price === 'number' ? initialData.price / 100 : 0,
        };
  const initialSalePrices =
    initialData?.sale_prices && Object.keys(initialData.sale_prices).length > 0
      ? initialData.sale_prices
      : typeof initialData?.sale_price === 'number'
        ? {
            [defaultCurrencyCode]: initialData.sale_price / 100,
          }
        : {};
  const productType = initialData?.product_type || '';
  const paymentProvider =
    initialData?.payment_provider ||
    (initialData?.product_type
      ? derivePaymentProviderFromProductType(initialData.product_type)
      : 'stripe');

  const sanitizedDefaults = sanitizeProductFormValuesForStoreManagedCurrencies({
    product_type: (productType || 'physical') as ProductFormValues['product_type'],
    payment_provider: paymentProvider as ProductFormValues['payment_provider'],
    title: initialData?.title || '',
    slug: initialData?.slug || '',
    sku: initialData?.sku || '',
    upc: initialData?.upc || '',
    is_taxable: initialData?.is_taxable ?? true,
    price: typeof initialData?.price === 'number' ? initialData.price / 100 : 0,
    prices: initialPrices,
    sale_price:
      typeof initialData?.sale_price === 'number' ? initialData.sale_price / 100 : null,
    sale_prices: initialSalePrices,
    stock: initialData?.stock || 0,
    meta_title: initialData?.meta_title || '',
    meta_description: initialData?.meta_description || '',
    custom_canonical: initialData?.custom_canonical || '',
    short_description: initialData?.short_description || '',
    description_json:
      initialData?.description_json || {
        type: 'doc',
        content: [{ type: 'paragraph' }],
      },
    freemius_product_id: initialData?.freemius_product_id || '',
    freemius_plan_id: initialData?.freemius_plan_id || '',
    trial_period_days: initialData?.trial_period_days ?? 0,
    trial_requires_payment_method: initialData?.trial_requires_payment_method ?? false,
    status: initialData?.status || 'draft',
    language_id: resolveDefaultLanguageId(
      initialData,
      targetLanguageId,
      availableLanguages
    ),
    translation_group_id:
      initialData?.translation_group_id || translationGroupId || undefined,
    product_media:
      initialData?.product_media?.map((productMedia) => ({
        media_id: productMedia.media_id,
      })) || [],
    category_ids: initialData?.category_ids || [],
    variation_attributes: initialData?.variation_attributes || [],
    variants:
      initialData?.variants?.map((variant) => ({
        ...variant,
        prices: variant.prices || {},
        sale_prices: variant.sale_prices || {},
      })) || [],
  }, currencies);

  return {
    ...sanitizedDefaults,
    product_type: productType,
    payment_provider: paymentProvider,
  };
}

function buildMediaManagerItems(
  productMedia: ProductFormInitialData['product_media']
): ProductMediaManagerItem[] {
  if (!productMedia) {
    return [];
  }

  return productMedia
    .map((item) => ({
      id: item.id || item.media_id,
      media_id: item.media_id,
      file_path: item.media?.file_path || item.media?.object_key || '',
      alt: item.media?.alt_text || '',
      sort_order: item.sort_order ?? 0,
    }))
    .sort((left, right) => left.sort_order - right.sort_order);
}

function serializeProductMedia(items: ProductMediaManagerItem[]) {
  return items.map((item) => ({ media_id: item.media_id }));
}

function buildVariantImageOptions(items: ProductMediaManagerItem[]) {
  return items.map((item) => ({
    media_id: item.media_id,
    file_path: item.file_path,
    alt: item.alt,
  }));
}

// Simple slugify helper
const slugify = (text: string) => {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')     // Replace spaces with -
    .replace(/[^\w-]+/g, '')  // Remove all non-word chars
    .replace(/--+/g, '-')     // Replace multiple - with single -
    .replace(/^-+/, '')       // Trim - from start
    .replace(/-+$/, '');      // Trim - from end
};

export function ProductForm({ 
  initialData, 
  isEdit = false, 
  mediaPickerNode, 
  availableLanguagesProp,
  globalAttributesProp,
  currenciesProp,
  translationGroupId,
  targetLanguageId,
  freemiusDashboardNode,
  enabledProviders,
  configStatus,
  createAction,
  updateAction,
  availableCategoriesProp = [],
  hasOpenDraft = false,
  onSeoChange,
}: ProductFormProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showVariations, setShowVariations] = useState(() => Boolean(initialData?.variants?.length));
  const currencies = React.useMemo(
    () =>
      currenciesProp
        .filter((currency) => currency.is_active !== false)
        .sort((left, right) => {
          if (left.is_default !== right.is_default) {
            return left.is_default ? -1 : 1;
          }

          return left.code.localeCompare(right.code);
        }),
    [currenciesProp]
  );
  const defaultCurrency = React.useMemo(
    () => currencies.find((currency) => currency.is_default) ?? currencies[0],
    [currencies]
  );
  const storeManagedPriceCurrencyCodes = React.useMemo(
    () => getStoreManagedPriceCurrencyCodes(currencies),
    [currencies]
  );
  const form = useForm<z.input<typeof productSchema>, unknown, ProductFormValues>({
    resolver: zodResolver(productSchema),
    defaultValues: buildProductFormDefaults(
      initialData,
      targetLanguageId,
      availableLanguagesProp,
      currencies,
      translationGroupId
    ),
  });

  const {
    register,
    handleSubmit,
    setValue,
    reset,
    watch,
    setError,
    formState: { errors, dirtyFields },
  } = form;

  const isFirstRender = useRef(true);
  // Serialized snapshot of the last successfully-autosaved values. Comparing
  // against this (instead of calling reset() to clear the dirty flag) lets us
  // stop the autosave from re-firing in a loop WITHOUT re-rendering the form —
  // re-rendering mid-edit would reset native inputs like the datetime pickers.
  const lastSavedSnapshotRef = useRef<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const allValues = watch();
  const isDirty = form.formState.isDirty;

  const watchedTitle = allValues.title;
  const watchedMetaTitle = allValues.meta_title;
  const watchedMetaDescription = allValues.meta_description;

  useEffect(() => {
    onSeoChange?.({
      title: watchedTitle,
      meta_title: watchedMetaTitle,
      meta_description: watchedMetaDescription,
    });
  }, [watchedTitle, watchedMetaTitle, watchedMetaDescription, onSeoChange]);

  useEffect(() => {
    if (!isEdit) return;

    if (isFirstRender.current) {
      isFirstRender.current = false;
      lastSavedSnapshotRef.current = JSON.stringify(allValues);
      return;
    }

    if (!isDirty) return;

    const snapshot = JSON.stringify(allValues);
    // Nothing has changed since the last autosave — don't re-fire.
    if (snapshot === lastSavedSnapshotRef.current) return;

    // Keep this debounce short so the draft persists — and the "Unpublished
    // Draft" toolbar appears — soon after the user pauses, without spamming a
    // write on every keystroke (it's a trailing debounce, so continuous typing
    // still only fires once they stop).
    const timer = setTimeout(() => {
      if (!isSubmitting) {
        lastSavedSnapshotRef.current = snapshot;
        handleSubmit(onSubmit)();
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [allValues, isEdit, isDirty, isSubmitting, handleSubmit]);

  // Auto-generate slug from title if title is modified
  const title = watch('title');
  const productType = watch('product_type');
  const derivedPaymentProvider =
    productType === 'digital'
      ? 'freemius'
      : productType === 'physical'
        ? 'stripe'
        : undefined;
  const isStripeMode = productType === 'physical';
  const isFreemiusMode = productType === 'digital';
  const isProviderEnabled = derivedPaymentProvider
    ? enabledProviders[derivedPaymentProvider]
    : false;
  const isProviderReady = derivedPaymentProvider
    ? configStatus[derivedPaymentProvider].hasKeys
    : false;
  const hasFreemiusProductId = !!watch('freemius_product_id');
  const trialPeriodDays = Number(watch('trial_period_days') || 0);
  const trialRequiresPaymentMethod = Boolean(watch('trial_requires_payment_method'));
  const variants = (watch('variants') || []) as NonNullable<ProductFormValues['variants']>;
  const baseProductPrice = watch('price') as number;
  const baseProductSalePrice = watch('sale_price') as number | null;
  const productPrices = (watch('prices') || {}) as Record<string, number>;
  const productSalePrices = (watch('sale_prices') || {}) as Record<string, number | null>;
  const hasVariants = (variants?.length || 0) > 0;
  const selectedLanguageId = watch('language_id');
  const currentLanguageCode =
    availableLanguagesProp.find((lang) => lang.id === selectedLanguageId)?.code ||
    availableLanguagesProp.find((lang) => lang.is_default)?.code ||
    availableLanguagesProp[0]?.code;
  const resolvedProductPriceMaps = React.useMemo(
    () =>
      resolveEditorCurrencyPriceMaps({
        currencies,
        prices: productPrices,
        salePrices: productSalePrices,
        fallbackPrice: baseProductPrice,
        fallbackSalePrice: baseProductSalePrice,
      }),
    [baseProductPrice, baseProductSalePrice, currencies, productPrices, productSalePrices]
  );
  const initialVariantsForEditor = React.useMemo(
    () =>
      initialData?.variants?.map((variant) => ({
        ...variant,
        prices: variant.prices || {},
        sale_prices: variant.sale_prices || {},
      })),
    [initialData?.variants]
  );

  // Use explicit useEffect to handle slug updates
  useEffect(() => {
    if (dirtyFields.title && !isEdit) { // Only auto-update on creation or if explicitly focusing on auto-generation logic
        const newSlug = slugify(title);
        setValue('slug', newSlug, { shouldValidate: true });
    }
  }, [title, dirtyFields.title, setValue, isEdit]);

  const [mediaForManager, setMediaForManager] = useState<ProductMediaManagerItem[]>(() =>
    buildMediaManagerItems(initialData?.product_media)
  );

  const [removedMediaIds, setRemovedMediaIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    reset(
      buildProductFormDefaults(
        initialData,
        targetLanguageId,
        availableLanguagesProp,
        currencies,
        translationGroupId
      )
    );
    setMediaForManager(buildMediaManagerItems(initialData?.product_media));
    setRemovedMediaIds(new Set());
    setShowVariations(Boolean(initialData?.variants?.length));
  }, [
    availableLanguagesProp,
    currencies,
    initialData,
    reset,
    targetLanguageId,
    translationGroupId,
  ]);

  const onMediaUpdate = (updatedMedia: ProductMediaManagerItem[]) => {
      // identify items that were in mediaForManager but are not in updatedMedia
      const currentIds = new Set(updatedMedia.map(m => m.id));
      const removed = mediaForManager.filter(m => !currentIds.has(m.id));

      const nextRemovedMediaIds = new Set(removedMediaIds);
      removed.forEach((mediaItem) => {
        if (mediaItem.media_id) {
          nextRemovedMediaIds.add(mediaItem.media_id);
        }
      });

      setRemovedMediaIds(nextRemovedMediaIds);
      setMediaForManager(updatedMedia);
      setValue('product_media', serializeProductMedia(updatedMedia), { shouldDirty: true });
      setValue('explicitly_removed_media_ids', Array.from(nextRemovedMediaIds), {
        shouldDirty: true,
      });
  };

  // Keep the hidden field aligned with the latest gallery removals.
  useEffect(() => {
     setValue('explicitly_removed_media_ids', Array.from(removedMediaIds));
  }, [removedMediaIds, setValue]);

  useEffect(() => {
    if (hasVariants) {
      setShowVariations(true);
    }
  }, [hasVariants]);

  useEffect(() => {
    register('is_taxable');
    register('price');
    register('sale_price');
    register('payment_provider');
    register('trial_requires_payment_method');
  }, [register]);

  useEffect(() => {
    if (!isFreemiusMode) {
      setValue('trial_period_days', 0, { shouldDirty: false, shouldValidate: true });
      setValue('trial_requires_payment_method', false, {
        shouldDirty: false,
        shouldValidate: true,
      });
      return;
    }

    if (trialPeriodDays <= 0) {
      setValue('trial_requires_payment_method', false, {
        shouldDirty: false,
        shouldValidate: true,
      });
    }
  }, [isFreemiusMode, setValue, trialPeriodDays]);

  useEffect(() => {
    if (!derivedPaymentProvider) {
      return;
    }

    setValue('payment_provider', derivedPaymentProvider, {
      shouldDirty: false,
      shouldValidate: true,
    });
  }, [derivedPaymentProvider, setValue]);

  useEffect(() => {
    if (!defaultCurrency) {
      return;
    }

    if (productPrices[defaultCurrency.code] === undefined) {
      setValue(
        'prices',
        {
          ...productPrices,
          [defaultCurrency.code]: baseProductPrice || 0,
        },
        { shouldDirty: false }
      );
    }
  }, [baseProductPrice, defaultCurrency, productPrices, setValue]);

  const handleProductPriceChange = useCallback(
    (currencyCode: string, value: number) => {
      const nextPrices = {
        ...productPrices,
        [currencyCode]: value,
      };
      setValue('prices', nextPrices, { shouldDirty: true, shouldValidate: true });

      if (currencyCode === defaultCurrency?.code) {
        setValue('price', value, { shouldDirty: true, shouldValidate: true });
      }
    },
    [defaultCurrency?.code, productPrices, setValue]
  );

  const handleProductSalePriceChange = useCallback(
    (currencyCode: string, value: number | null) => {
      const nextSalePrices = {
        ...productSalePrices,
        [currencyCode]: value,
      };
      setValue('sale_prices', nextSalePrices, {
        shouldDirty: true,
        shouldValidate: true,
      });

      if (currencyCode === defaultCurrency?.code) {
        setValue('sale_price', value, { shouldDirty: true, shouldValidate: true });
      }
    },
    [defaultCurrency?.code, productSalePrices, setValue]
  );

  const handleAutoFillProductPrices = useCallback(() => {
    if (!defaultCurrency) {
      return;
    }

    const storeManagedCurrencyCodeSet = new Set(storeManagedPriceCurrencyCodes);

    const baseRegularPrice =
      productPrices[defaultCurrency.code] ?? baseProductPrice ?? 0;
    const baseSalePrice =
      productSalePrices[defaultCurrency.code] ?? baseProductSalePrice ?? null;

    const nextPrices = currencies.reduce<Record<string, number>>((accumulator, currency) => {
      if (
        currency.code !== defaultCurrency.code &&
        storeManagedCurrencyCodeSet.has(currency.code)
      ) {
        return accumulator;
      }

      const convertedMinor = convertMinorUnitAmount({
        amount: majorUnitAmountToMinor(baseRegularPrice, defaultCurrency.code),
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

        if (typeof baseSalePrice !== 'number') {
          if (currency.code === defaultCurrency.code || !storeManagedCurrencyCodeSet.has(currency.code)) {
            accumulator[currency.code] = null;
          }
          return accumulator;
        }

        const convertedMinor = convertMinorUnitAmount({
          amount: majorUnitAmountToMinor(baseSalePrice, defaultCurrency.code),
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

    setValue('prices', nextPrices, { shouldDirty: true, shouldValidate: true });
    setValue('sale_prices', nextSalePrices, {
      shouldDirty: true,
      shouldValidate: true,
    });
    setValue('price', nextPrices[defaultCurrency.code] ?? baseRegularPrice, {
      shouldDirty: true,
      shouldValidate: true,
    });
    setValue('sale_price', nextSalePrices[defaultCurrency.code] ?? null, {
      shouldDirty: true,
      shouldValidate: true,
    });
  }, [
    currencies,
    defaultCurrency,
    productPrices,
    productSalePrices,
    setValue,
    storeManagedPriceCurrencyCodes,
    baseProductPrice,
    baseProductSalePrice,
  ]);

  const handleVariationChange = useCallback(
    ({
      variationAttributes,
      variants,
    }: {
      variationAttributes: ProductFormValues['variation_attributes'];
      variants: ProductFormValues['variants'];
    }) => {
      setValue('variation_attributes', variationAttributes, { shouldDirty: true });
      setValue('variants', variants, { shouldDirty: true, shouldValidate: true });
    },
    [setValue]
  );

  const onSubmit = async (data: ProductFormValues) => {
    setIsSubmitting(true);
    setIsSaving(true);
    setSaveError(null);
    
    try {
      if (!derivedPaymentProvider) {
        const errorMsg = 'Select whether this product is physical or digital before saving.';
        setError('product_type', {
          type: 'manual',
          message: errorMsg,
        });
        if (isEdit) {
          setSaveError(errorMsg);
        } else {
          alert(errorMsg);
        }
        setIsSubmitting(false);
        setIsSaving(false);
        return;
      }

      // NOTE: there used to be a guard here rejecting any save where `data.status ===
      // 'active'` and the provider wasn't configured. It became a trap once the Status
      // select moved out of this form: `data.status` is now simply whatever the live row
      // already holds, so on an already-published product with missing keys EVERY
      // debounced autosave failed — the owner could not edit the very product they
      // needed to fix. Publishing is gated (as a warning) by VisibilityControl instead;
      // the readiness pill below still tells the editor what is missing.

      const normalizedTrialPeriodDays = isStripeMode
        ? 0
        : Math.max(0, Number(data.trial_period_days || 0));
      const normalizedData: ProductFormValues = {
        ...data,
        product_type: data.product_type,
        payment_provider: derivedPaymentProvider,
        freemius_product_id: isStripeMode ? '' : data.freemius_product_id,
        freemius_plan_id: isStripeMode ? '' : data.freemius_plan_id,
        trial_period_days: normalizedTrialPeriodDays,
        trial_requires_payment_method:
          !isStripeMode && normalizedTrialPeriodDays > 0
            ? data.trial_requires_payment_method
            : false,
        upc: isStripeMode ? data.upc : null,
        is_taxable: isStripeMode ? data.is_taxable : false,
        variation_attributes: isStripeMode ? data.variation_attributes : [],
        variants: isStripeMode ? data.variants : [],
      };
      const sanitizedData = sanitizeProductFormValuesForStoreManagedCurrencies(
        normalizedData,
        currencies
      );

      if (isEdit && updateAction) {
        await updateAction(sanitizedData);
        setLastSaved(new Date());
        // NOTE: do not call reset() here. The autosave loop is prevented by the
        // snapshot comparison in the autosave effect, so we avoid re-rendering
        // the form mid-edit (which would reset native inputs like the datetime
        // pickers — e.g. clearing the sale start while picking the sale end).
      } else if (createAction) {
        await createAction(sanitizedData);
      } else {
        throw new Error('Product form action is not configured.');
      }
    } catch (error: any) {
      console.error(error);
      if (error.message === 'NEXT_REDIRECT') {
          return;
      }
      
      let errorMsg = error.message || 'An error occurred while saving.';
      if (error.code === '23505') {
        const msg = error.message?.toLowerCase() || '';
        if (msg.includes('products_slug_key') || msg.includes('slug')) {
          errorMsg = 'This slug is already in use. Please choose another one.';
          setError('slug', { 
              type: 'manual', 
              message: errorMsg 
          });
        } else if (msg.includes('products_sku_key') || msg.includes('sku')) {
          errorMsg = 'This SKU is already in use.';
          setError('sku', { 
              type: 'manual', 
              message: errorMsg 
          });
        }
      }
      
      if (isEdit) {
        setSaveError(errorMsg);
      } else {
        alert(errorMsg);
      }
    } finally {
      setIsSubmitting(false);
      setIsSaving(false);
    }
  };

  const disabledBaseFieldClass = hasVariants
    ? 'bg-muted/60 text-muted-foreground opacity-70'
    : '';
  const variantImageOptions = buildVariantImageOptions(mediaForManager);

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-2.5 pb-4">

      <input type="hidden" {...register('translation_group_id')} />
      <input type="hidden" {...register('payment_provider')} />

      <div className="space-y-2.5 w-full">
        <div className="rounded-lg border bg-card p-2.5 px-4 shadow-sm flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-6">
            <div className="flex h-9 items-center gap-2">
              <span className="text-sm font-bold whitespace-nowrap leading-none pt-0.5">Product Type</span>
              {errors.product_type && (
                <AlertCircle className="h-4 w-4 text-destructive" />
              )}
            </div>
            
            <div className="flex h-9 items-center">
              <Select
                onValueChange={(value) =>
                  setValue('product_type', value as ProductFormValues['product_type'], {
                    shouldDirty: true,
                    shouldValidate: true,
                  })
                }
                value={productType || undefined}
              >
                <SelectTrigger className="w-[160px] h-9 text-xs">
                  <SelectValue placeholder="Select Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="physical">Physical Product</SelectItem>
                  <SelectItem value="digital">Digital Product</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center gap-6">
            <div className="flex h-9 items-center gap-3">
              <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider leading-none">Payment Provider</span>
              <Badge variant="outline" className="text-xs py-1 font-bold bg-muted/30 leading-none">
                {derivedPaymentProvider
                  ? derivedPaymentProvider === 'stripe'
                    ? 'Stripe'
                    : 'Freemius'
                  : '—'}
              </Badge>
            </div>

            {derivedPaymentProvider && (
              <div className="flex h-9 items-center gap-2">
                {isProviderEnabled && isProviderReady ? (
                  <span className="flex items-center gap-1.5 text-emerald-600 text-[10px] font-bold bg-emerald-50 px-2 py-1 rounded-full border border-emerald-100 uppercase leading-none">
                    <CheckCircle2 className="h-3 w-3" />
                    Ready
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 text-amber-600 text-[10px] font-bold bg-amber-50 px-2 py-1 rounded-full border border-amber-100 uppercase leading-none">
                    <AlertCircle className="h-3 w-3" />
                    {isProviderEnabled ? 'Keys Missing' : 'Disabled'}
                  </span>
                )}
              </div>
            )}
            
            {!isProviderReady && derivedPaymentProvider && configStatus[derivedPaymentProvider].missing.length > 0 && (
              <a
                href="/cms/payments"
                className="hidden xl:flex h-9 items-center gap-1 text-[10px] text-muted-foreground bg-muted/50 px-2 py-1 rounded border border-dashed leading-none hover:text-foreground hover:border-solid"
              >
                <Info className="h-3 w-3" />
                Missing: {configStatus[derivedPaymentProvider].missing.join(', ')} — set up payments
              </a>
            )}
          </div>
        </div>

        <FormSection
          title="Product Information"
          hideHeader
        >
          {isEdit && (
            <div className="flex items-center justify-between text-xs text-muted-foreground pb-2 border-b border-border/40 mb-2.5">
              <span className="font-semibold text-[11px] uppercase tracking-wider text-muted-foreground/80">Product Settings</span>
              <div className="flex items-center gap-1.5 min-h-[16px]">
                {isSaving ? (
                  <>
                    <div className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
                    </div>
                    <span className="text-amber-600 dark:text-amber-400 font-medium">Autosaving settings...</span>
                  </>
                ) : saveError ? (
                  <span className="text-red-500 font-medium">Error saving settings: {saveError}</span>
                ) : lastSaved ? (
                  <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                    Settings autosaved at {lastSaved.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                ) : (
                  <span className="text-muted-foreground/60">Settings autosave in draft mode</span>
                )}
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2.5">
            <div className="col-span-2 space-y-1">
              <Label htmlFor="title" className="text-xs uppercase font-bold text-muted-foreground tracking-wider leading-none">Title</Label>
              <Input id="title" placeholder="Product title" {...register('title')} className="h-8 text-sm" />
              {errors.title && <p className="text-destructive text-[11px] leading-none">{errors.title.message as string}</p>}
            </div>
            <div className="col-span-2 space-y-1">
              <Label htmlFor="slug" className="text-xs uppercase font-bold text-muted-foreground tracking-wider leading-none">Slug</Label>
              <Input id="slug" placeholder="product-slug" {...register('slug')} className="h-8 text-sm" />
              {errors.slug && <p className="text-destructive text-[11px] leading-none">{errors.slug.message as string}</p>}
            </div>
            <div className="col-span-1 space-y-1">
              <Label htmlFor="sku" className="text-xs uppercase font-bold text-muted-foreground tracking-wider leading-none">SKU</Label>
              <Input id="sku" placeholder="SKU" {...register('sku')} className="h-8 text-sm font-mono" />
              {errors.sku && <p className="text-destructive text-[11px] leading-none">{errors.sku.message as string}</p>}
            </div>
            <div className="col-span-1 space-y-1">
              <Label htmlFor="upc_ean" className="text-xs uppercase font-bold text-muted-foreground tracking-wider leading-none">UPC / EAN</Label>
              <Input id="upc_ean" placeholder="000000000" {...register('upc')} className="h-8 text-sm font-mono" readOnly={hasVariants} />
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-12 gap-2.5 mt-2">
            <div className={`${isEdit ? 'lg:col-span-3' : 'lg:col-span-4'} col-span-2 space-y-1`}>
              <Label htmlFor="meta_title" className="text-xs uppercase font-bold text-muted-foreground tracking-wider leading-none">Meta Title</Label>
              <Input id="meta_title" {...register('meta_title')} placeholder="SEO page title (50-60 chars)" className="h-8 text-sm" />
            </div>
            <div className="lg:col-span-4 col-span-2 space-y-1">
              <Label htmlFor="meta_description" className="text-xs uppercase font-bold text-muted-foreground tracking-wider leading-none">Meta Description</Label>
              <Input id="meta_description" {...register('meta_description')} placeholder="SEO description (150-160 chars)" className="h-8 text-sm" />
            </div>
            <div className={`${isEdit ? 'lg:col-span-3' : 'lg:col-span-4'} col-span-2 space-y-1`}>
              <Label htmlFor="custom_canonical" className="text-xs uppercase font-bold text-muted-foreground tracking-wider leading-none">Canonical URL (optional)</Label>
              <Input id="custom_canonical" {...register('custom_canonical')} placeholder="Blank = self-referencing. Absolute https://… URL or /relative path to override." className="h-8 text-sm" />
            </div>
            {/* Visibility lives in the editor's top bar, not here: this form
                autosaves into the product draft, and publishing a product must
                never be a side effect of editing its details. */}
          </div>
        </FormSection>

        <FormSection
          title="Product Categories"
          description="Assign this product to one or more categories."
        >
          <ProductCategorySelector
            categories={availableCategoriesProp}
            selectedIds={watch('category_ids') || []}
            onChange={(ids) => setValue('category_ids', ids, { shouldDirty: true, shouldValidate: true })}
          />
        </FormSection>

        <section className="rounded-lg border bg-card p-3 shadow-sm space-y-3">
          {isStripeMode && (
            <div className="flex items-center justify-between gap-4 flex-wrap border-b border-muted/50 pb-2">
              <div className="flex items-center gap-4">
                <div className="space-y-0.5">
                  <h2 className="text-sm font-bold tracking-tight">Pricing & Inventory</h2>
                  <p className="text-[11px] text-muted-foreground leading-none">Manage simple or variant pricing.</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2 bg-muted/40 rounded-md px-2.5 py-1.5">
                    <span className="text-xs uppercase font-bold text-muted-foreground tracking-wider leading-none">Stock</span>
                    <Input
                      id="stock"
                      type="number"
                      min="0"
                      {...register('stock', { valueAsNumber: true })}
                      placeholder="0"
                      readOnly={hasVariants}
                      className={`${disabledBaseFieldClass} h-8 w-20 text-sm text-center font-mono bg-background`}
                    />
                  </div>
                {hasVariants ? (
                  <Badge variant="secondary" className="text-[11px] py-0 px-2 h-5">Variant pricing</Badge>
                ) : null}
              </div>
            </div>
          )}
          {isStripeMode ? (
            <div className="space-y-3">
              <div className="w-full">
                <CurrencyPriceFields
                  idPrefix="product"
                  currencies={currencies}
                  prices={resolvedProductPriceMaps.prices}
                  salePrices={resolvedProductPriceMaps.salePrices}
                  managedCurrencyCodes={storeManagedPriceCurrencyCodes}
                  onPriceChange={handleProductPriceChange}
                  onSalePriceChange={handleProductSalePriceChange}
                  onAutoFill={handleAutoFillProductPrices}
                  readOnly={hasVariants}
                  helperText={
                    hasVariants
                      ? 'Parent prices stay as a fallback, but active variants define the live shopper price.'
                      : undefined
                  }
                  trailing={
                    <SaleScheduleFields
                      idPrefix="product"
                      startAt={watch('sale_start_at') as string | null | undefined}
                      endAt={watch('sale_end_at') as string | null | undefined}
                      onChange={(field, value) =>
                        setValue(field, value, { shouldDirty: true, shouldValidate: true })
                      }
                      error={errors.sale_end_at?.message as string | undefined}
                      bare
                    />
                  }
                />
                {errors.price && (
                  <p className="text-destructive text-sm mt-1">{errors.price.message as string}</p>
                )}
                {errors.sale_price && (
                  <p className="text-destructive text-sm mt-1">{errors.sale_price.message as string}</p>
                )}
                {errors.stock && (
                  <p className="text-destructive text-[10px] font-medium leading-none mt-1">{errors.stock.message as string}</p>
                )}
              </div>

              <div className="flex items-center justify-between gap-3 rounded border border-dashed p-2.5 bg-muted/5">
                <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{hasVariants ? 'Variations Active' : 'Variations'}</span>
                <Button
                  type="button"
                  variant={showVariations ? 'outline' : 'default'}
                  onClick={() => setShowVariations((current) => !current)}
                  size="sm"
                  className="h-7 text-xs px-3"
                >
                  {showVariations ? 'Hide' : 'Manage'}
                </Button>
              </div>

              {showVariations && (
                <div className="border-t pt-3">
                  <VariationsEditor
                    globalAttributes={globalAttributesProp}
                    currentLanguageCode={currentLanguageCode}
                    baseSku={watch('sku') || ''}
                    basePrice={baseProductPrice || 0}
                    basePrices={productPrices}
                    baseSalePrice={
                      typeof baseProductSalePrice === 'number' ? baseProductSalePrice : null
                    }
                    baseSalePrices={productSalePrices}
                    currencies={currencies}
                    availableVariantImages={variantImageOptions}
                    initialVariationAttributes={initialData?.variation_attributes}
                    initialVariants={initialVariantsForEditor}
                    onChange={handleVariationChange}
                  />
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="space-y-4">
              <div className="flex items-end gap-4 w-full">
                <div className="flex-1">
                  <Label htmlFor="freemius_product_id" className="text-[11px] uppercase tracking-wider text-muted-foreground font-bold mb-1.5 block">Freemius Product ID</Label>
                  <Input id="freemius_product_id" {...register('freemius_product_id')} className="h-9" />
                </div>
                <div className="flex-1">
                  <Label htmlFor="freemius_plan_id" className="text-[11px] uppercase tracking-wider text-muted-foreground font-bold mb-1.5 block">Freemius Plan ID</Label>
                  <Input id="freemius_plan_id" {...register('freemius_plan_id')} className="h-9" />
                </div>
                {hasFreemiusProductId ? (
                  <SyncFreemiusPricingButton
                    productId={watch('freemius_product_id') as string}
                    hasOpenDraft={hasOpenDraft}
                  />
                ) : null}
              </div>

              <div className="bg-muted/10 border rounded-md overflow-hidden">
                <div className="flex flex-wrap items-center gap-6 bg-muted/20 border-b p-2.5 px-4">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Free Trial</span>
                    <Badge variant="outline" className="font-mono text-xs shadow-sm bg-background">{String(watch('trial_period_days') || 0)} Days</Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Card Required</span>
                    <Badge variant={trialRequiresPaymentMethod ? "default" : "secondary"} className="text-xs shadow-sm">
                       {trialRequiresPaymentMethod ? 'Yes' : 'No'}
                    </Badge>
                  </div>
                  <span className="text-[10px] text-muted-foreground ml-auto">
                     Managed in Freemius dashboard
                  </span>
                  {/* Hidden inputs to preserve form state if needed */}
                  <input type="hidden" {...register('trial_period_days', { valueAsNumber: true })} />
                </div>

                <div className="w-full p-4 pt-3 space-y-2">
                  <CurrencyPriceFields
                    idPrefix="product"
                    currencies={currencies}
                    prices={resolvedProductPriceMaps.prices}
                    salePrices={resolvedProductPriceMaps.salePrices}
                    managedCurrencyCodes={storeManagedPriceCurrencyCodes}
                    onPriceChange={handleProductPriceChange}
                    onSalePriceChange={handleProductSalePriceChange}
                    onAutoFill={handleAutoFillProductPrices}
                    readOnly={true}
                    trailing={
                      <SaleScheduleFields
                        idPrefix="product"
                        startAt={watch('sale_start_at') as string | null | undefined}
                        endAt={watch('sale_end_at') as string | null | undefined}
                        onChange={(field, value) =>
                          setValue(field, value, { shouldDirty: true, shouldValidate: true })
                        }
                        error={errors.sale_end_at?.message as string | undefined}
                        bare
                      />
                    }
                  />
                  <p className="text-[10px] leading-snug text-muted-foreground">
                    Scheduling a sale on a Freemius product generates a time-bounded Freemius
                    coupon so the discount is enforced at Freemius checkout.
                  </p>
                </div>
              </div>
            </div>
              {freemiusDashboardNode && (
                <div className="pt-2 border-t">
                  {freemiusDashboardNode}
                </div>
              )}
            </>
          )}
        </section>

        <FormSection title="Product Description" hideHeader>
          <div className="space-y-2">
            <div className="space-y-1">
              <Label htmlFor="short_description" className="text-xs uppercase font-bold text-muted-foreground tracking-wider leading-none">Short Description</Label>
              <Input id="short_description" {...register('short_description')} placeholder="Brief summary for product cards..." className="h-8 text-sm" />
            </div>
          </div>
        </FormSection>
 
        <FormSection title="Media Gallery" description="Drag to reorder. First image is the hero.">
          <ProductMediaManager
            initialMedia={mediaForManager}
            onUpdate={onMediaUpdate}
            mediaPickerNode={mediaPickerNode}
          />
          <input type="hidden" {...register('product_media')} />
        </FormSection>
 
        {!isEdit && (
          <div className="rounded-lg border bg-card p-3 px-4 shadow-sm flex items-center justify-between gap-3 flex-wrap">
            <p className="text-xs text-muted-foreground">
              New products start as a draft. Publish it from the top bar once it&apos;s ready.
            </p>
            <Button disabled={isSubmitting} type="submit" size="sm" className="h-8 text-sm px-5">
              {isSubmitting ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
        )}
      </div>
    </form>
  );
}
