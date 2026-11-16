// Deep subpaths, not the barrels: lib/visual-editing/product-drafts.ts imports this module, and the
// public product page imports that one (tools/scripts/commerce-chunking.test.ts).
import {
  buildCombinationKey,
  buildVariantLabel,
  mapRawVariantRelations,
  resolveAttributeName,
  resolveTermValue,
} from '@nextblock-cms/ecommerce/variation-utils';
import type { ProductAttribute, ProductVariantOption } from '@nextblock-cms/ecommerce';
import {
  getCurrencyMinorUnitFactor,
  majorUnitAmountToMinor,
  minorUnitAmountToMajor,
  normalizeCurrencyCode,
} from '@nextblock-cms/utils/utils';
import {
  classifyProductDraftMeta,
  describeSkippedProductDraftOverlayNotice,
  hasProductDraftFormMarker,
  joinProductFieldLabels,
  planProductDraftOverlayPublish,
  withoutProductDraftFormMarker,
} from '../../../lib/visual-editing/product-draft-meta';

type LanguageOption = {
  id: number;
  code: string;
  is_default?: boolean;
};

export function buildGlobalAttributesForForm(globalAttributesRaw: any[]): ProductAttribute[] {
  return (globalAttributesRaw || []).map((attribute: any) => ({
    id: attribute.id,
    name: attribute.name,
    name_translations: attribute.name_translations || {},
    slug: attribute.slug,
    terms: (attribute.product_attribute_terms || []).map((term: any) => ({
      ...term,
      value_translations: term.value_translations || {},
    })),
  }));
}

export function resolveProductFormLanguageCode(
  availableLanguages: LanguageOption[],
  languageId?: number
) {
  return (
    availableLanguages.find((language) => language.id === languageId)?.code ||
    availableLanguages.find((language) => language.is_default)?.code ||
    availableLanguages[0]?.code
  );
}

export function buildTranslationSourceInitialData(
  sourceProduct: any,
  translationGroupId: string,
  targetLanguageId?: string
) {
  if (!sourceProduct) {
    return null;
  }

  return {
    ...sourceProduct,
    id: undefined,
    slug: sourceProduct.slug || '',
    sku: sourceProduct.sku || '',
    status: 'draft',
    language_id: targetLanguageId ? parseInt(targetLanguageId, 10) : sourceProduct.language_id,
    translation_group_id: translationGroupId,
    created_at: undefined,
    updated_at: undefined,
  };
}

export function buildProductFormInitialData(
  product: any,
  availableLanguages: LanguageOption[],
  languageIdOverride?: number
) {
  if (!product) {
    return undefined;
  }

  const resolvedLanguageId = languageIdOverride ?? product.language_id;
  const currentLanguageCode = resolveProductFormLanguageCode(
    availableLanguages,
    resolvedLanguageId
  );
  const { attributes: productAttributes, variants } = mapRawVariantRelations(
    product.product_variants || [],
    currentLanguageCode
  );

  return {
    ...product,
    language_id: resolvedLanguageId,
    prices: Object.entries(product.prices || {}).reduce<Record<string, number>>(
      (accumulator, [currencyCode, amount]) => {
        if (typeof amount === 'number') {
          accumulator[currencyCode] = minorUnitAmountToMajor(amount, currencyCode);
        }
        return accumulator;
      },
      {}
    ),
    sale_prices: Object.entries(product.sale_prices || {}).reduce<Record<string, number | null>>(
      (accumulator, [currencyCode, amount]) => {
        if (typeof amount === 'number') {
          accumulator[currencyCode] = minorUnitAmountToMajor(amount, currencyCode);
        }
        return accumulator;
      },
      {}
    ),
    variation_attributes:
      product.variation_attributes ||
      productAttributes.map((attribute) => ({
        attribute_id: attribute.id,
        term_ids: attribute.terms.map((term) => term.id),
      })),
    variants:
      product.variants ||
      variants.map((variant) => ({
        ...variant,
        upc: variant.upc ?? null,
        price: variant.price / 100,
        prices: Object.entries(variant.prices || {}).reduce<Record<string, number>>(
          (accumulator, [currencyCode, amount]) => {
            if (typeof amount === 'number') {
              accumulator[currencyCode] = minorUnitAmountToMajor(amount, currencyCode);
            }
            return accumulator;
          },
          {}
        ),
        sale_price:
          typeof variant.sale_price === 'number' ? variant.sale_price / 100 : null,
        sale_prices: Object.entries(variant.sale_prices || {}).reduce<Record<string, number | null>>(
          (accumulator, [currencyCode, amount]) => {
            if (typeof amount === 'number') {
              accumulator[currencyCode] = minorUnitAmountToMajor(amount, currencyCode);
            }
            return accumulator;
          },
          {}
        ),
        main_media_id: variant.main_media_id ?? null,
        main_image_url: variant.image_url ?? null,
      })),
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * updateProduct() (libs/ecommerce product-actions.ts) multiplies every amount it is handed by 100
 * (`toCents`: price, sale price, both price maps and every variant amount), whatever the currency.
 * This is its exact inverse, so a live amount sent through it comes back unchanged. It is not
 * `minorUnitAmountToMajor` (the display conversion above), which leaves a zero-decimal currency
 * (JPY, KRW, ...) as it is: through updateProduct that entry would come back multiplied by 100.
 */
function storedAmountToFormAmount(amount: unknown): number | null {
  return typeof amount === 'number' && Number.isFinite(amount) ? amount / 100 : null;
}

function storedAmountMapToFormAmounts(amounts: unknown): Record<string, number> {
  if (!isRecord(amounts)) {
    return {};
  }

  return Object.entries(amounts).reduce<Record<string, number>>((accumulator, [currencyCode, amount]) => {
    if (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) {
      accumulator[currencyCode] = amount / 100;
    }
    return accumulator;
  }, {});
}

/**
 * The live product (a `getProduct()` row: minor units, `product_variants` with their attribute
 * mappings) as the values updateProduct() writes back unchanged. Publishing a product-values draft
 * takes every field the draft lacks from here, so a partial draft (a CMS draft import that left the
 * sale schedule out, a hand-written row) never deletes the variants, clears the description or the
 * schedule, or zeroes a price. The gallery and the categories are left out on purpose:
 * updateProduct() leaves both alone when the values do not carry them.
 */
export function buildProductFormValuesFromLiveProduct(product: any, languageCode?: string | null) {
  const rawVariants: any[] = Array.isArray(product?.product_variants) ? product.product_variants : [];
  // Labels and options only: the amounts come from the raw rows (exact inverse above), and the
  // attribute terms from the mapping rows themselves, so no mapping is lost with its join.
  const { variants } = mapRawVariantRelations(rawVariants, languageCode);

  return {
    product_type: product.product_type,
    payment_provider: product.payment_provider,
    title: product.title,
    slug: product.slug,
    sku: product.sku,
    upc: product.upc ?? null,
    price: storedAmountToFormAmount(product.price) ?? 0,
    prices: storedAmountMapToFormAmounts(product.prices),
    sale_price: storedAmountToFormAmount(product.sale_price),
    sale_prices: storedAmountMapToFormAmounts(product.sale_prices),
    sale_start_at: product.sale_start_at ?? null,
    sale_end_at: product.sale_end_at ?? null,
    stock: typeof product.stock === 'number' ? product.stock : 0,
    meta_title: product.meta_title ?? null,
    meta_description: product.meta_description ?? null,
    custom_canonical: product.custom_canonical ?? null,
    short_description: product.short_description ?? null,
    description_json: product.description_json ?? null,
    freemius_product_id: product.freemius_product_id ?? null,
    freemius_plan_id: product.freemius_plan_id ?? null,
    trial_period_days: product.trial_period_days ?? 0,
    trial_requires_payment_method: product.trial_requires_payment_method ?? false,
    is_taxable: product.is_taxable,
    status: product.status,
    language_id: product.language_id,
    translation_group_id: product.translation_group_id ?? undefined,
    variants: variants.map((variant, index) => {
      const raw = isRecord(rawVariants[index]) ? rawVariants[index] : {};
      const mappedTermIds = (Array.isArray(raw.variant_attribute_mapping) ? raw.variant_attribute_mapping : [])
        .map((mapping: any) => mapping?.attribute_term_id)
        .filter((termId: unknown): termId is string => typeof termId === 'string' && termId.length > 0);

      return {
        id: variant.id,
        combination_key: variant.combination_key,
        sku: variant.sku,
        upc: variant.upc ?? null,
        price: storedAmountToFormAmount(raw.price) ?? 0,
        prices: storedAmountMapToFormAmounts(raw.prices),
        sale_price: storedAmountToFormAmount(raw.sale_price),
        sale_prices: storedAmountMapToFormAmounts(raw.sale_prices),
        sale_start_at: variant.sale_start_at ?? null,
        sale_end_at: variant.sale_end_at ?? null,
        stock_quantity: variant.stock_quantity ?? 0,
        main_media_id: variant.main_media_id ?? null,
        main_image_url: variant.image_url ?? null,
        attribute_term_ids: mappedTermIds.length > 0 ? mappedTermIds : variant.attribute_term_ids,
        selected_options: variant.selected_options,
        label: variant.label,
      };
    }),
  };
}

/**
 * Keys the form and the CMS import always write and that null would corrupt (a zero price, emptied
 * price maps, every variant deleted, a NOT NULL column): a null there counts as a missing key.
 */
const PRODUCT_VALUE_KEYS_NEVER_NULL = new Set([
  'title',
  'slug',
  'sku',
  'price',
  'prices',
  'stock',
  'variants',
  'is_taxable',
  'language_id',
  'product_type',
  'payment_provider',
]);

/** `base` with every key of a product-values draft laid over it (see PRODUCT_VALUE_KEYS_NEVER_NULL). */
export function overlayProductDraftValues<T extends Record<string, any>>(
  base: T,
  meta: Record<string, unknown>
): T & Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(meta)) {
    if ((value === null || value === undefined) && PRODUCT_VALUE_KEYS_NEVER_NULL.has(key)) {
      continue;
    }
    merged[key] = value;
  }
  return merged as T & Record<string, unknown>;
}

/**
 * The product-level sale window of a product-values draft, as one unit: when the draft carries either
 * bound, both come from the draft (the missing one null, an open end, as the form shows an empty
 * field); when it carries neither, both are `live`'s. Publish (completeProductDraftValues) and the
 * edit page (mergeProductDraftMetaIntoFormInitialData) both take it from here, so the page shows the
 * window publish writes. Merged key by key, a draft that set only a new start kept the live end it
 * never showed, which could end before the start (CHECK products_sale_window_valid refuses that) or
 * close a sale nobody scheduled. The form loads both bounds since 0.23.4, so its autosave always
 * carries the pair it validated; a draft an earlier version saved holds only the bound the editor
 * touched (that form loaded neither).
 */
function resolveProductDraftSaleWindow(
  draftValues: Record<string, unknown>,
  live: { sale_start_at?: unknown; sale_end_at?: unknown }
): { sale_start_at: string | null; sale_end_at: string | null } {
  const source = hasOwn(draftValues, 'sale_start_at') || hasOwn(draftValues, 'sale_end_at') ? draftValues : live;
  return {
    sale_start_at: (source.sale_start_at ?? null) as string | null,
    sale_end_at: (source.sale_end_at ?? null) as string | null,
  };
}

/** The live product's language code (a getProduct() row's `languages (code)`). */
function readLiveProductLanguageCode(liveProduct: unknown): string | null {
  if (!isRecord(liveProduct)) {
    return null;
  }

  const language = Array.isArray(liveProduct.languages) ? liveProduct.languages[0] : liveProduct.languages;
  return isRecord(language) && typeof language.code === 'string' ? language.code : null;
}

/**
 * Draft keys publish never hands updateProduct(): the form never shows them, and nothing pins them (any
 * product_drafts writer, a WRITER over PostgREST included, can set them). A top-level `media_id`
 * replaced the whole gallery while the edit page showed the live one, and
 * `explicitly_removed_media_ids` (the form's list of images removed in its session) named media to
 * delete; updateProduct() reads neither since 0.23.4 (security review 2026-11-15).
 */
const PRODUCT_DRAFT_KEYS_NEVER_PUBLISHED = ['media_id', 'explicitly_removed_media_ids'] as const;

/**
 * What publishing a product-values draft hands updateProduct(): the draft's own values, and the live
 * product's for every field the draft does not carry, with the sale window as one unit
 * (resolveProductDraftSaleWindow). The draft's marker and PRODUCT_DRAFT_KEYS_NEVER_PUBLISHED never
 * reach it, so the gallery it writes is the draft's `product_media` (which the edit page shows) or
 * the live one.
 */
export function completeProductDraftValues(meta: Record<string, unknown>, liveProduct: any) {
  const draftValues = withoutProductDraftFormMarker(meta);
  const liveValues = buildProductFormValuesFromLiveProduct(liveProduct, readLiveProductLanguageCode(liveProduct));
  const values = overlayProductDraftValues(liveValues, draftValues);
  const saleWindow = resolveProductDraftSaleWindow(draftValues, liveValues);
  values.sale_start_at = saleWindow.sale_start_at;
  values.sale_end_at = saleWindow.sale_end_at;

  for (const key of PRODUCT_DRAFT_KEYS_NEVER_PUBLISHED) {
    delete values[key];
  }

  return values;
}

/**
 * The field groups a pre-0.23.4 edit page could poison in a product-values draft. That page showed a
 * legacy row snapshot (what a block or in-page edit created: cents, the stock of that moment, no
 * variants, gallery or, after 2026-05-27, description) as form values: it multiplied the snapshot's
 * `price` and `sale_price` by 100 for ProductForm, which divides them back, passed the cent price maps
 * through as major amounts, and left the variants, the gallery and the description to ProductForm's
 * empty defaults. The first autosave over it (any dirty field) stored all of that as product values,
 * with no `id`. Variants rebuilt on that page were generated from the x100 base price, with no stock
 * (generateVariantDrafts), and a gallery started from empty. A CMS import in draft mode wrote
 * unmarked product values too, with an empty gallery, no variants and no description (null) when
 * the file had no media, variant or description columns.
 *
 * - `prices`: `price` and the `prices` map; `sale_prices`: `sale_price` and `sale_prices`. The two are
 *   always flagged together: a sale price repaired beside a x100 regular price made a 99% Freemius
 *   sale coupon (computeFreemiusSaleDiscountPercent), where the unrepaired pair still made the right one.
 * - `variants`: `variants` and `variation_attributes` (the variations editor shows the variants as
 *   they are and rebuilds them from the attributes only when the selected terms (or the currencies)
 *   change, so they are repaired together), with the stock the form shows beside the live variants.
 * - `stock`: a physical product's top-level stock, which upsert_product_with_variants writes only for
 *   values without variants (it sums the variants' stock otherwise), as does the SKU's shared
 *   inventory. A digital product's form hides the stock, so the edit page repairs it without naming
 *   it (ProductDraftCheck.repairHiddenStock).
 * - `product_media`: the gallery; `description_json`: the rich description.
 */
export type PoisonedProductDraftField =
  | 'prices'
  | 'sale_prices'
  | 'variants'
  | 'stock'
  | 'product_media'
  | 'description_json';

const POISONED_PRODUCT_DRAFT_FIELD_LABELS: Record<PoisonedProductDraftField, string> = {
  prices: 'prices',
  sale_prices: 'sale prices',
  variants: 'variants',
  stock: 'stock',
  product_media: 'gallery',
  description_json: 'description',
};

/**
 * A draft amount at least this many times the live amount (both in major units) reads as the live
 * minor amount stored as a major one: the snapshot's cents read as dollars are 100 times the live
 * amount while it is unchanged, and still at least 20 times it while the live amount is at most five
 * times what it was (a Freemius sync, Cortex, the promotions import moved it). The same rule flags a
 * clean old autosave an editor repriced 20-fold or more, or whose live amount has fallen to a
 * twentieth or less of the draft's since: the edit page shows the live values of every group that
 * differs, and the editor enters that draft's changes again.
 */
const MINOR_AMOUNT_AS_MAJOR_RATIO = 20;

function finiteAmount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function positiveAmount(value: unknown): number | null {
  const amount = finiteAmount(value);
  return amount !== null && amount > 0 ? amount : null;
}

/** JPY, KRW, ...: no minor unit, so the stored amount is the major amount. */
function isZeroDecimalCurrency(currencyCode: string) {
  return getCurrencyMinorUnitFactor(currencyCode) === 1;
}

function amountIn(amounts: unknown, currencyCode: string): unknown {
  return isRecord(amounts) ? amounts[currencyCode] : undefined;
}

/**
 * Whether a draft amount (major units) is a live minor amount stored as a major one: equal to the live
 * minor amount above zero (the snapshot's cents, read as dollars, while the live price is unchanged),
 * or at least MINOR_AMOUNT_AS_MAJOR_RATIO times `liveMajorAmount`, the live amount in the major units
 * the edit page showed it in (the same cents after the live price moved). Callers pick the conversion:
 *
 * - `storedAmountToFormAmount` (amount / 100) for a top-level price or sale price, the product's or a
 *   variant's: ProductForm shows `initialData.price / 100`, and buildProductFormInitialData divides a
 *   variant's price by 100, whatever the currency.
 * - `minorUnitAmountToMajor` for a price-map entry, the conversion buildProductFormInitialData showed
 *   it with, so what a clean draft holds. Zero-decimal entries never get here: it leaves them
 *   unscaled, so a clean draft and a poisoned one hold the same number (and amount / 100 would make
 *   every clean entry read as 100 times the live one). For every other currency the two agree.
 */
function isMinorAmountStoredAsMajor(draftAmount: unknown, liveMinorAmount: unknown, liveMajorAmount: number | null) {
  const draft = finiteAmount(draftAmount);
  const liveMinor = positiveAmount(liveMinorAmount);
  if (draft === null || liveMinor === null) {
    return false;
  }

  return (
    draft === liveMinor ||
    (liveMajorAmount !== null && liveMajorAmount > 0 && draft >= MINOR_AMOUNT_AS_MAJOR_RATIO * liveMajorAmount)
  );
}

/**
 * The same for each entry of a draft price map, against `liveAmountFor(currency)`; zero-decimal entries
 * are exempt. With `compareRatio` false an entry counts only when it equals the live minor amount.
 */
function hasMapAmountStoredAsMajor(
  draftAmounts: unknown,
  liveAmountFor: (currencyCode: string) => unknown,
  compareRatio = true
) {
  if (!isRecord(draftAmounts)) {
    return false;
  }

  return Object.entries(draftAmounts).some(([currencyCode, amount]) => {
    if (isZeroDecimalCurrency(currencyCode)) {
      return false;
    }

    const liveAmount = positiveAmount(liveAmountFor(currencyCode));
    return (
      liveAmount !== null &&
      isMinorAmountStoredAsMajor(
        amount,
        liveAmount,
        compareRatio ? minorUnitAmountToMajor(liveAmount, currencyCode) : null
      )
    );
  });
}

function hasZeroDecimalEntryEqualTo(amounts: unknown, amount: unknown) {
  const target = positiveAmount(amount);
  return (
    target !== null &&
    isRecord(amounts) &&
    Object.entries(amounts).some(([currencyCode, entry]) => entry === target && isZeroDecimalCurrency(currencyCode))
  );
}

/**
 * Whether the store's default currency may be zero-decimal, read from the live rows: the trigger
 * sync_currency_price_maps (02001) keeps `prices[default]` equal to `price`, and `sale_prices[default]`
 * to `sale_price`, on every write to a product or variant price, so a zero-decimal entry equal to its
 * row's top-level amount may be the default currency's. ProductForm then takes the top-level amount
 * from that entry (sanitizeProductFormValuesForStoreManagedCurrencies), which it shows unscaled, so a
 * clean draft and a poisoned one hold the same top-level number, and the top-level amounts are left
 * out of the checks. A poisoned draft still shows through its entries in the other currencies, which
 * it carries as cents like the rest; a two-decimal entry equal to the top-level amount as well (an
 * ambiguous row) is checked that way.
 */
function mayHaveZeroDecimalDefaultCurrency(liveProduct: Record<string, any>) {
  const rows: unknown[] = [
    liveProduct,
    ...(Array.isArray(liveProduct.product_variants) ? liveProduct.product_variants : []),
  ];
  return rows.some(
    (row) =>
      isRecord(row) &&
      (hasZeroDecimalEntryEqualTo(row.prices, row.price) || hasZeroDecimalEntryEqualTo(row.sale_prices, row.sale_price))
  );
}

interface LiveVariantRow {
  raw: Record<string, any>;
  combinationKey: string | null;
}

function stringIds(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).filter(
    (id: unknown): id is string => typeof id === 'string' && id.length > 0
  );
}

/** The live variant rows (getProduct()'s `product_variants`) with the combination key of their attribute terms. */
function readLiveVariantRows(liveProduct: Record<string, any>): LiveVariantRow[] {
  const rawVariants: unknown[] = Array.isArray(liveProduct.product_variants) ? liveProduct.product_variants : [];
  return rawVariants.filter(isRecord).map((raw) => {
    const termIds = stringIds(
      (Array.isArray(raw.variant_attribute_mapping) ? raw.variant_attribute_mapping : []).map(
        (mapping: any) => mapping?.attribute_term_id
      )
    );
    return { raw, combinationKey: termIds.length > 0 ? buildCombinationKey(termIds) : null };
  });
}

/** The live row a draft variant stands for: the same combination of attribute terms, else the same id. */
function findLiveVariantRow(draftVariant: Record<string, any>, liveVariantRows: LiveVariantRow[]) {
  const termIds = stringIds(draftVariant.attribute_term_ids);
  const combinationKey =
    typeof draftVariant.combination_key === 'string' && draftVariant.combination_key
      ? draftVariant.combination_key
      : termIds.length > 0
        ? buildCombinationKey(termIds)
        : null;

  return (
    (combinationKey ? liveVariantRows.find((row) => row.combinationKey === combinationKey) : undefined) ??
    (draftVariant.id ? liveVariantRows.find((row) => row.raw.id === draftVariant.id) : undefined) ??
    null
  );
}

/** Whether a draft amount (major units) is `baseAmount`, above zero, in cents: Math.round(baseAmount * 100). */
function isAmountInCentsOf(draftAmount: unknown, baseAmount: unknown) {
  const draft = finiteAmount(draftAmount);
  const base = positiveAmount(baseAmount);
  return draft !== null && base !== null && draft === Math.round(base * 100);
}

/**
 * Whether a draft variant holds the draft's own product-level amount in cents: its price or sale
 * price is the draft's price or sale price times 100, or a price-map entry is the same map's entry in
 * that currency times 100 (zero-decimal entries are exempt, as in hasMapAmountStoredAsMajor). The old
 * page generated a new combination from the x100 base (generateVariantDrafts), and an editor who
 * corrected the base price there afterwards left the variant at that base, which equals the live
 * parent's cents only while the product's price is unchanged.
 */
function holdsDraftAmountInCents(
  draftVariant: Record<string, any>,
  meta: Record<string, any>,
  checkTopLevelAmounts: boolean
) {
  if (
    checkTopLevelAmounts &&
    (isAmountInCentsOf(draftVariant.price, meta.price) || isAmountInCentsOf(draftVariant.sale_price, meta.sale_price))
  ) {
    return true;
  }

  return (['prices', 'sale_prices'] as const).some((key) => {
    const amounts = draftVariant[key];
    return (
      isRecord(amounts) &&
      Object.entries(amounts).some(
        ([currencyCode, amount]) =>
          !isZeroDecimalCurrency(currencyCode) && isAmountInCentsOf(amount, amountIn(meta[key], currencyCode))
      )
    );
  });
}

/**
 * Whether a draft variant carries a live minor amount stored as a major one.
 *
 * - A variant with a live row of its own (findLiveVariantRow) is compared with that row only
 *   (isMinorAmountStoredAsMajor): the old page rebuilt such a variant with the snapshot's cents of
 *   the parent's price (generateVariantDrafts), its own cents while it sold at the parent's price. An
 *   amount the live row lacks (no sale price) is not compared.
 * - A variant with no live row (a combination the live product does not have) is compared with the
 *   live parent by equality only, and with the draft's own product-level amounts
 *   (holdsDraftAmountInCents): a variant rebuilt on the old page for such a combination took the
 *   snapshot's cents of the parent's price, which the editor may have corrected on the parent since,
 *   and a new variant an editor priced at another multiple of the parent's price is no sign of a
 *   snapshot.
 */
function hasVariantAmountStoredAsMajor(
  draftVariant: Record<string, any>,
  liveVariant: Record<string, any> | null,
  liveProduct: Record<string, any>,
  meta: Record<string, any>,
  checkTopLevelAmounts: boolean
) {
  if (liveVariant === null && holdsDraftAmountInCents(draftVariant, meta, checkTopLevelAmounts)) {
    return true;
  }

  const live = liveVariant ?? liveProduct;
  const compareRatio = liveVariant !== null;

  if (checkTopLevelAmounts) {
    for (const key of ['price', 'sale_price'] as const) {
      const liveMajorAmount = compareRatio ? storedAmountToFormAmount(live[key]) : null;
      if (isMinorAmountStoredAsMajor(draftVariant[key], live[key], liveMajorAmount)) {
        return true;
      }
    }
  }

  return (['prices', 'sale_prices'] as const).some((key) =>
    hasMapAmountStoredAsMajor(draftVariant[key], (currencyCode) => amountIn(live[key], currencyCode), compareRatio)
  );
}

function countRows(value: unknown) {
  return Array.isArray(value) ? value.length : 0;
}

/** Node types that carry no content of their own: a doc made only of them shows nothing. */
const STRUCTURAL_RICH_TEXT_NODES = new Set(['doc', 'paragraph', 'heading', 'hardBreak', 'text']);

function hasRichTextContent(node: unknown): boolean {
  if (!isRecord(node)) {
    return false;
  }

  if (node.type === 'text') {
    return typeof node.text === 'string' && node.text.trim().length > 0;
  }

  // An image, a table, a rule, an embed...: content.
  if (typeof node.type === 'string' && !STRUCTURAL_RICH_TEXT_NODES.has(node.type)) {
    return true;
  }

  return Array.isArray(node.content) && node.content.some(hasRichTextContent);
}

/** A Tiptap doc that shows nothing, such as ProductForm's default `{ type: 'doc', content: [{ type: 'paragraph' }] }`. */
function isEmptyRichTextDocument(value: unknown) {
  return isRecord(value) && value.type === 'doc' && !hasRichTextContent(value);
}

function recordsOf(value: unknown): Record<string, any>[] {
  return Array.isArray(value) ? value.filter(isRecord) : isRecord(value) ? [value] : [];
}

const FREEMIUS_PLAN_PRICE_KEYS = ['api_monthly_price', 'api_annual_price', 'api_lifetime_price'] as const;

/** A plan price in dollars above zero: `freemius_pricing` stores it as numeric (number, or a numeric string). */
function readFreemiusPlanPrice(value: unknown): number | null {
  const amount = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

/**
 * Whether a draft's top-level price is one of the live product's Freemius plan prices in cents
 * (Math.round(dollars * 100)), read as dollars. The Freemius sync sets a synced product's price to one
 * plan price in cents (annual, else monthly, else lifetime: providers/freemius.ts) and keeps the plan
 * prices themselves, in dollars, in `freemius_pricing`, which getProduct() reads through
 * `freemius_plans` (one row per plan, each with its pricing rows). So a snapshot whose price a later
 * sync moved, by any factor, still shows: a monthly-only plan that gained an annual price, or a
 * failed pricing fetch that set the price to 0 and left the plan prices as they were. A plan whose
 * prices changed since (a plan made free) no longer holds the snapshot's.
 */
function isFreemiusPlanPriceInCents(draftAmount: unknown, liveProduct: Record<string, any>) {
  const draft = finiteAmount(draftAmount);
  if (draft === null || draft <= 0) {
    return false;
  }

  return recordsOf(liveProduct.freemius_plans).some((plan) =>
    recordsOf(plan.freemius_pricing).some((pricing) =>
      FREEMIUS_PLAN_PRICE_KEYS.some((key) => {
        const dollars = readFreemiusPlanPrice(pricing[key]);
        return dollars !== null && Math.round(dollars * 100) === draft;
      })
    )
  );
}

/**
 * The groups an earlier version left empty where the live product has them: no variants for a
 * physical product that has some (a digital product's form always sends none), an empty gallery over
 * a live one, an empty description over live content. With `nullDescriptionIsEmpty` (a CMS draft
 * import, which stored the description its file lacked as null: draft mode never kept a blank), a
 * null description counts as empty too.
 */
function findEmptiedProductDraftGroups(
  meta: Record<string, any>,
  liveProduct: Record<string, any>,
  liveVariantRows: LiveVariantRow[],
  isPhysical: boolean,
  nullDescriptionIsEmpty = false
): PoisonedProductDraftField[] {
  const fields: PoisonedProductDraftField[] = [];

  if (isPhysical && Array.isArray(meta.variants) && meta.variants.length === 0 && liveVariantRows.length > 0) {
    fields.push('variants');
  }

  if (Array.isArray(meta.product_media) && meta.product_media.length === 0 && countRows(liveProduct.product_media) > 0) {
    fields.push('product_media');
  }

  // A meta without the key keeps the live description (completeProductDraftValues).
  const descriptionIsEmpty =
    isEmptyRichTextDocument(meta.description_json) || (nullDescriptionIsEmpty && meta.description_json === null);
  if (descriptionIsEmpty && hasRichTextContent(liveProduct.description_json)) {
    fields.push('description_json');
  }

  return fields;
}

/**
 * Whether an unmarked product form autosave was saved over a row snapshot by the pre-0.23.4 edit page,
 * whatever the live product became since:
 *
 * - an amount that is a live minor amount stored as a major one (isMinorAmountStoredAsMajor): the
 *   top-level price and sale price (unless the default currency may be zero-decimal), each entry of
 *   both price maps in a currency that has a minor unit, and each draft variant's amounts
 *   (hasVariantAmountStoredAsMajor; a variant with no live row also when it holds the draft's own
 *   amount in cents);
 * - a top-level price that is one of the product's Freemius plan prices in cents
 *   (isFreemiusPlanPriceInCents; not when the default currency may be zero-decimal, where the form
 *   showed the price unscaled, so a clean draft holds those cents too);
 * - or what that page left empty where the live product has it (findEmptiedProductDraftGroups).
 */
function isSavedOverRowSnapshot(
  meta: Record<string, any>,
  liveProduct: Record<string, any>,
  liveVariantRows: LiveVariantRow[],
  zeroDecimalDefault: boolean,
  isPhysical: boolean
) {
  if (
    !zeroDecimalDefault &&
    (isMinorAmountStoredAsMajor(meta.price, liveProduct.price, storedAmountToFormAmount(liveProduct.price)) ||
      isMinorAmountStoredAsMajor(meta.sale_price, liveProduct.sale_price, storedAmountToFormAmount(liveProduct.sale_price)) ||
      isFreemiusPlanPriceInCents(meta.price, liveProduct))
  ) {
    return true;
  }

  if (
    hasMapAmountStoredAsMajor(meta.prices, (currencyCode) => amountIn(liveProduct.prices, currencyCode)) ||
    hasMapAmountStoredAsMajor(meta.sale_prices, (currencyCode) => amountIn(liveProduct.sale_prices, currencyCode))
  ) {
    return true;
  }

  const draftVariants = Array.isArray(meta.variants) ? meta.variants.filter(isRecord) : [];
  if (
    draftVariants.some((variant) =>
      hasVariantAmountStoredAsMajor(
        variant,
        findLiveVariantRow(variant, liveVariantRows)?.raw ?? null,
        liveProduct,
        meta,
        !zeroDecimalDefault
      )
    )
  ) {
    return true;
  }

  return findEmptiedProductDraftGroups(meta, liveProduct, liveVariantRows, isPhysical).length > 0;
}

/**
 * Whether a draft amount (major units) differs from the live minor amount, read back with
 * `minorUnitFactor` (the inverse of the conversion the edit page showed it with). Null is a value.
 */
function amountDiffersFromLive(draftAmount: unknown, liveMinorAmount: unknown, minorUnitFactor: number) {
  const draft = finiteAmount(draftAmount);
  const live = finiteAmount(liveMinorAmount);
  return draft === null || live === null ? draft !== live : Math.round(draft * minorUnitFactor) !== live;
}

/** A price map's amounts by currency (non-negative numbers only: a null entry is a cleared one). */
function amountEntries(amounts: unknown, toMinor: (amount: number, currencyCode: string) => number) {
  const entries = new Map<string, number>();
  if (isRecord(amounts)) {
    for (const [currencyCode, amount] of Object.entries(amounts)) {
      const value = finiteAmount(amount);
      if (value !== null && value >= 0) {
        entries.set(normalizeCurrencyCode(currencyCode), toMinor(value, currencyCode));
      }
    }
  }
  return entries;
}

/**
 * Whether a draft price map (major units, as buildProductFormInitialData showed it: majorUnitAmountToMinor
 * reads it back) differs from the live map (minor units): another set of currencies or another amount.
 */
function amountMapDiffersFromLive(draftAmounts: unknown, liveAmounts: unknown) {
  const draft = amountEntries(draftAmounts, majorUnitAmountToMinor);
  const live = amountEntries(liveAmounts, (amount) => amount);
  return draft.size !== live.size || [...draft].some(([currencyCode, amount]) => live.get(currencyCode) !== amount);
}

/**
 * Whether publishing would write other prices or sale prices than the live ones. Only the keys the
 * draft carries count: publish takes the rest from live (completeProductDraftValues, where a null
 * `price` or `prices` is a missing key and a null sale price clears it).
 */
function priceGroupsDifferFromLive(meta: Record<string, any>, liveProduct: Record<string, any>, topLevelFactor: number) {
  return (
    (meta.price != null && amountDiffersFromLive(meta.price, liveProduct.price, topLevelFactor)) ||
    (meta.prices != null && amountMapDiffersFromLive(meta.prices, liveProduct.prices)) ||
    (hasOwn(meta, 'sale_price') && amountDiffersFromLive(meta.sale_price, liveProduct.sale_price, topLevelFactor)) ||
    (hasOwn(meta, 'sale_prices') && amountMapDiffersFromLive(meta.sale_prices, liveProduct.sale_prices))
  );
}

function textValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : String(value);
}

function isSameInstant(left: unknown, right: unknown) {
  const leftTime = typeof left === 'string' && left ? Date.parse(left) : null;
  const rightTime = typeof right === 'string' && right ? Date.parse(right) : null;
  if (leftTime === null || rightTime === null) {
    return leftTime === rightTime;
  }
  return Number.isNaN(leftTime) || Number.isNaN(rightTime) ? left === right : leftTime === rightTime;
}

/**
 * Whether publishing the draft's variants would write other rows than the live ones: another number of
 * rows, a row with no live row of its own (findLiveVariantRow; the RPC re-creates every variant, so the
 * ids themselves never count), or a row whose values differ from its live row's, among what
 * serializeVariantsForRpc sends: amounts, stock, SKU, UPC, image and sale window. A variant rebuilt
 * on the old page carries the x100 base price, no stock, UPC or image.
 */
function variantRowsDifferFromLive(draftVariants: unknown[], liveVariantRows: LiveVariantRow[], topLevelFactor: number) {
  if (draftVariants.length !== liveVariantRows.length) {
    return true;
  }

  const matchedRows = new Set<LiveVariantRow>();
  return draftVariants.some((draftVariant) => {
    if (!isRecord(draftVariant)) {
      return true;
    }

    const liveRow = findLiveVariantRow(draftVariant, liveVariantRows);
    if (!liveRow || matchedRows.has(liveRow)) {
      return true;
    }
    matchedRows.add(liveRow);

    const live = liveRow.raw;
    return (
      amountDiffersFromLive(draftVariant.price, live.price, topLevelFactor) ||
      amountDiffersFromLive(draftVariant.sale_price, live.sale_price, topLevelFactor) ||
      amountMapDiffersFromLive(draftVariant.prices, live.prices) ||
      amountMapDiffersFromLive(draftVariant.sale_prices, live.sale_prices) ||
      (finiteAmount(draftVariant.stock_quantity) ?? 0) !== (finiteAmount(live.stock_quantity) ?? 0) ||
      textValue(draftVariant.sku) !== textValue(live.sku) ||
      textValue(draftVariant.upc) !== textValue(live.upc) ||
      textValue(draftVariant.main_media_id) !== textValue(live.main_media_id) ||
      !isSameInstant(draftVariant.sale_start_at, live.sale_start_at) ||
      !isSameInstant(draftVariant.sale_end_at, live.sale_end_at)
    );
  });
}

function mediaIds(value: unknown) {
  return new Set(stringIds((Array.isArray(value) ? value : []).map((item: any) => item?.media_id)));
}

/**
 * Whether publishing the draft's gallery would drop a live image: publishing would unlink an image the
 * old editor never showed (it stays in the media library; through 0.23.3 the publish also deleted it
 * when nothing else used it). The old page showed a row snapshot with an empty gallery, so a gallery
 * in such a draft was built from nothing.
 */
function galleryDropsLiveImage(meta: Record<string, any>, liveProduct: Record<string, any>) {
  if (!Array.isArray(meta.product_media)) {
    return false;
  }

  const draftMediaIds = mediaIds(meta.product_media);
  return [...mediaIds(liveProduct.product_media)].some((mediaId) => !draftMediaIds.has(mediaId));
}

/**
 * Whether an unmarked product-values meta is the product form's autosave. Every one carries a
 * `variation_attributes` array: ProductForm's default since 2026-04-14 (731ae56a), before the form
 * first autosaved into a draft (cd68f26b, 2026-05-22), and its submit and the save's sanitizer keep it
 * (`[]` for a digital product). The other writer of unmarked product values, a CMS import in draft
 * mode before 0.23.4, never wrote one (`git log -S variation_attributes -- apps/nextblock/lib/cms-transfer`
 * finds nothing). Only the form's autosave was saved over a row snapshot on the old edit page.
 */
function isProductFormAutosave(meta: Record<string, any>) {
  return Array.isArray(meta.variation_attributes);
}

/** What the old-draft check found (findPoisonedProductDraftFields returns `fields`). */
interface ProductDraftCheck {
  /** The groups the edit page shows live and publish refuses the draft for. */
  fields: PoisonedProductDraftField[];
  /** A form autosave over a row snapshot: its other fields are that copy too (the edit page says so). */
  savedOverRowSnapshot: boolean;
  /** A digital product's snapshot stock: shown live by the edit page without naming it (its form hides the stock). */
  repairHiddenStock: boolean;
}

function checkProductDraft(meta: unknown, liveProduct: unknown): ProductDraftCheck {
  const none: ProductDraftCheck = { fields: [], savedOverRowSnapshot: false, repairHiddenStock: false };
  if (
    !isRecord(meta) ||
    !isRecord(liveProduct) ||
    classifyProductDraftMeta(meta) !== 'product-values' ||
    hasProductDraftFormMarker(meta)
  ) {
    return none;
  }

  const liveVariantRows = readLiveVariantRows(liveProduct);
  // Only a physical (Stripe) product's form sends variants and shows the stock; a digital one sends [].
  const productType =
    typeof meta.product_type === 'string' && meta.product_type ? meta.product_type : liveProduct.product_type;
  const isPhysical = productType === 'physical';

  // A draft import's prices and stock are the file's: only what that import left empty is flagged,
  // a description its file lacked (null) included.
  if (!isProductFormAutosave(meta)) {
    return { ...none, fields: findEmptiedProductDraftGroups(meta, liveProduct, liveVariantRows, isPhysical, true) };
  }

  const zeroDecimalDefault = mayHaveZeroDecimalDefaultCurrency(liveProduct);
  if (!isSavedOverRowSnapshot(meta, liveProduct, liveVariantRows, zeroDecimalDefault, isPhysical)) {
    return none;
  }

  // The form's top-level amounts are amount / 100 (as they are when the default currency is zero-decimal).
  const topLevelFactor = zeroDecimalDefault ? 1 : 100;
  const fields: PoisonedProductDraftField[] = [];

  if (priceGroupsDifferFromLive(meta, liveProduct, topLevelFactor)) {
    fields.push('prices', 'sale_prices');
  }

  const draftVariants: unknown[] | null = Array.isArray(meta.variants) ? meta.variants : null;
  if (isPhysical && draftVariants && variantRowsDifferFromLive(draftVariants, liveVariantRows, topLevelFactor)) {
    fields.push('variants');
  }

  const publishesVariants = draftVariants ? draftVariants.length > 0 : liveVariantRows.length > 0;
  const stockDiffers =
    (!publishesVariants || liveVariantRows.length === 0) &&
    meta.stock != null &&
    finiteAmount(meta.stock) !== (finiteAmount(liveProduct.stock) ?? 0);
  if (stockDiffers && isPhysical) {
    fields.push('stock');
  }

  if (galleryDropsLiveImage(meta, liveProduct)) {
    fields.push('product_media');
  }

  if (isEmptyRichTextDocument(meta.description_json) && hasRichTextContent(liveProduct.description_json)) {
    fields.push('description_json');
  }

  return { fields, savedOverRowSnapshot: true, repairHiddenStock: stockDiffers && !isPhysical };
}

/**
 * The poisoned field groups of a product-values draft that an earlier version saved (no
 * PRODUCT_DRAFT_FORM_MARKER_KEY), compared with the live product (a getProduct() row: minor units,
 * `product_variants` with their attribute mappings, `product_media`, `freemius_plans`). Empty for a
 * marked draft (a 0.23.4 editor may set any price), an overlay or a legacy snapshot.
 *
 * - A product form autosave (isProductFormAutosave) with no sign of a row snapshot
 *   (isSavedOverRowSnapshot) has none. One with a sign holds the snapshot's copy of every value the
 *   old page showed, so every group whose values differ from live is flagged, to be repaired
 *   together from live: the prices and sale prices always together; the variants (physical
 *   products) when their rows or amounts differ; a physical product's top-level stock when the
 *   values publish would write carry no variants on one side (the RPC writes it then); the gallery
 *   when it drops a live image; the description when it is empty over live content.
 * - Any other unmarked product values (a CMS import in draft mode before 0.23.4) get no amount rule:
 *   only the gallery, variants and description that import left empty where the live product has
 *   them (findEmptiedProductDraftGroups), a description its file lacked (null) included. The other
 *   columns its file lacked are not checked and publish as the import stored them: blank (the short
 *   description, the SEO title and description, the UPC, the sale price, the currency price and
 *   sale-price maps, the Freemius ids, the categories) or a default (no trial, taxable, and without
 *   type and provider columns a physical Stripe product); the canonical URL is never written, so the
 *   live one stays. Its description blocks are the file's: none when the file gave none.
 *
 * Publish refuses a draft with any (product-drafts.ts); the edit page shows the live values for them
 * and says which (mergeProductDraftMetaIntoFormInitialData, getProductDraftEditNotices), so the next
 * autosave repairs them and stamps the marker.
 */
export function findPoisonedProductDraftFields(meta: unknown, liveProduct: unknown): PoisonedProductDraftField[] {
  return checkProductDraft(meta, liveProduct).fields;
}

function describePoisonedProductDraftFields(fields: readonly PoisonedProductDraftField[]) {
  return joinProductFieldLabels(fields.map((field) => POISONED_PRODUCT_DRAFT_FIELD_LABELS[field]));
}

const OLD_PRODUCT_DRAFT_EXPLANATION =
  'This draft was saved by an earlier version of NextBlock, which could store a product\'s prices 100 times too high, reset its stock and drop its variants, gallery or description.';

/** The opening for a draft an earlier version's CMS import wrote: its prices and stock are the file's. */
const OLD_PRODUCT_DRAFT_IMPORT_EXPLANATION =
  'This draft was saved by a CMS import in an earlier version of NextBlock. An import in draft mode, this version’s included, writes an empty gallery, no variants and no description when the file has no such columns; so does a live overwrite import unless “Ignore blank fields” is ticked.';

/**
 * A form autosave over a row snapshot holds that copy in every field the old page showed: the ones
 * the check compares, and these, which it cannot tell from an edit (the Freemius sync rewrites the
 * Freemius and trial settings, and publish copies the categories to the product's translations).
 */
const OLD_PRODUCT_DRAFT_COPY_WARNING =
  'The draft\'s other fields (title, slug, descriptions, SEO fields, categories, SKU and UPC, and the Freemius and trial settings) are a copy of the product from when it was saved: compare them with the live product.';

/**
 * Publish's refusal for a draft with poisoned fields: names them, and says what to do. Given `meta`,
 * the draft findPoisonedProductDraftFields flagged (unmarked product values), a CMS draft import's
 * refusal (no `variation_attributes`: isProductFormAutosave) opens with what that import did; a form
 * autosave's, or one built without `meta`, with the row snapshot's explanation.
 */
export function buildPoisonedProductDraftPublishError(
  fields: readonly PoisonedProductDraftField[],
  { meta }: { meta?: unknown } = {}
) {
  const explanation =
    isRecord(meta) && !isProductFormAutosave(meta) ? OLD_PRODUCT_DRAFT_IMPORT_EXPLANATION : OLD_PRODUCT_DRAFT_EXPLANATION;
  return `Not published. ${explanation} Affected in this draft: ${describePoisonedProductDraftFields(fields)}. Open the product in the CMS editor, check those fields, save a change (or discard the draft), then publish.`;
}

/**
 * The edit page's note for the same draft (the form shows the live values for those fields), read by
 * anyone who opens the page: only an administrator publishes, so its last step says so. A form
 * autosave over a row snapshot gets the snapshot's explanation and the copy sentence; a draft import
 * (`savedOverRowSnapshot` false) gets what that import did instead, and no copy sentence: its other
 * fields are the file's.
 */
export function buildPoisonedProductDraftNotice(
  fields: readonly PoisonedProductDraftField[],
  { savedOverRowSnapshot = true }: { savedOverRowSnapshot?: boolean } = {}
) {
  return [
    savedOverRowSnapshot ? OLD_PRODUCT_DRAFT_EXPLANATION : OLD_PRODUCT_DRAFT_IMPORT_EXPLANATION,
    `Affected in this draft: ${describePoisonedProductDraftFields(fields)}.`,
    ...(savedOverRowSnapshot ? [OLD_PRODUCT_DRAFT_COPY_WARNING] : []),
    'The form shows the live values for the affected fields: check them, save a change (or discard the draft), then publish (or ask an administrator to).',
  ].join(' ');
}

/**
 * The notes the edit page shows above the form for an open draft that holds what an earlier version
 * wrote: an unmarked product-values draft publish refuses (findPoisonedProductDraftFields), and a
 * legacy row snapshot, or an overlay rewritten from one, whose snapshot fields publish will skip
 * (planProductDraftOverlayPublish, which skips nothing for any other overlay). Built from the same
 * functions publish uses, so the page says what publish would do.
 */
export function getProductDraftEditNotices(meta: unknown, liveProduct: unknown, draftCreatedAt: unknown): string[] {
  const notices: string[] = [];
  const check = checkProductDraft(meta, liveProduct);

  if (check.fields.length > 0) {
    notices.push(buildPoisonedProductDraftNotice(check.fields, { savedOverRowSnapshot: check.savedOverRowSnapshot }));
  }

  if (isRecord(meta) && isRecord(liveProduct) && classifyProductDraftMeta(meta) !== 'product-values') {
    const { skipped } = planProductDraftOverlayPublish(meta, liveProduct, draftCreatedAt);
    if (skipped.length > 0) {
      notices.push(describeSkippedProductDraftOverlayNotice(skipped));
    }
  }

  return notices;
}

/** A draft's major-unit amount in the cents ProductForm reads `initialData.price` / `sale_price` in. */
function draftAmountToStoredCents(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) : value;
}

interface TermOption {
  /** The attribute's place in the global attribute list, which orders a variant's options. */
  order: number;
  option: ProductVariantOption;
}

/**
 * Each attribute term's option as the variations editor builds it (generateVariantDrafts: the
 * attribute and term names in the product's language): from the global attributes the edit page
 * loads, else from the options of the live variants (mapRawVariantRelations).
 */
function indexTermOptions(
  liveVariants: Record<string, any>[],
  globalAttributes: readonly ProductAttribute[] | undefined,
  languageCode: string | null
) {
  const index = new Map<string, TermOption>();
  const attributes = Array.isArray(globalAttributes) ? globalAttributes : [];

  attributes.forEach((attribute, order) => {
    for (const term of Array.isArray(attribute?.terms) ? attribute.terms : []) {
      if (typeof term?.id === 'string' && term.id && !index.has(term.id)) {
        index.set(term.id, {
          order,
          option: {
            attribute_id: attribute.id,
            attribute_name: resolveAttributeName(attribute, languageCode),
            term_id: term.id,
            term_value: resolveTermValue(term, languageCode),
            term_slug: term.slug,
          },
        });
      }
    }
  });

  for (const variant of liveVariants) {
    for (const option of recordsOf(variant.selected_options)) {
      if (typeof option.term_id === 'string' && option.term_id && !index.has(option.term_id)) {
        index.set(option.term_id, { order: attributes.length, option: option as ProductVariantOption });
      }
    }
  }

  return index;
}

/**
 * A draft variant with the combination key, options and label the variations editor reads on its
 * first render and keys its rows by. A CMS import writes variants as the export holds them, with
 * their attribute terms only: the editor threw on such a draft, and without a key it regenerated
 * them as new variants at the product's price. They come from the live variant with the same terms,
 * or (for a variant that names none) the same id, whose terms it then takes too; else from the term
 * options (indexTermOptions); a term none of them knows gets no option. Everything else, the prices
 * and the stock included, stays the draft's; a variant that has all three is left as it is.
 */
function completeDraftVariantForForm(
  draftVariant: unknown,
  liveVariants: Record<string, any>[],
  termOptions: Map<string, TermOption>
) {
  if (!isRecord(draftVariant)) {
    return draftVariant;
  }

  const hasKey = typeof draftVariant.combination_key === 'string' && draftVariant.combination_key.length > 0;
  const hasOptions = Array.isArray(draftVariant.selected_options);
  const hasLabel = typeof draftVariant.label === 'string';
  if (hasKey && hasOptions && hasLabel) {
    return draftVariant;
  }

  const termIds = stringIds(draftVariant.attribute_term_ids);
  const combinationKey = hasKey ? draftVariant.combination_key : buildCombinationKey(termIds);
  const live =
    termIds.length > 0
      ? liveVariants.find((variant) => variant.combination_key === combinationKey)
      : draftVariant.id
        ? liveVariants.find((variant) => variant.id === draftVariant.id)
        : undefined;

  if (live) {
    return {
      ...draftVariant,
      ...(termIds.length > 0 ? {} : { attribute_term_ids: live.attribute_term_ids }),
      combination_key: hasKey ? draftVariant.combination_key : live.combination_key,
      selected_options: hasOptions ? draftVariant.selected_options : live.selected_options,
      label: hasLabel ? draftVariant.label : live.label,
    };
  }

  const options = termIds
    .map((termId) => termOptions.get(termId))
    .filter((entry): entry is TermOption => entry !== undefined)
    .sort((left, right) => left.order - right.order)
    .map((entry) => entry.option);

  return {
    ...draftVariant,
    combination_key: combinationKey,
    selected_options: hasOptions ? draftVariant.selected_options : options,
    label: hasLabel ? draftVariant.label : buildVariantLabel(options),
  };
}

/** The selected terms per attribute, as the variations editor emits them, from the variants' options. */
function deriveVariationAttributes(variants: unknown[]) {
  const termIdsByAttribute = new Map<string, string[]>();

  for (const variant of recordsOf(variants)) {
    for (const option of recordsOf(variant.selected_options)) {
      const attributeId = option.attribute_id;
      const termId = option.term_id;
      if (typeof attributeId !== 'string' || !attributeId || typeof termId !== 'string' || !termId) {
        continue;
      }

      const termIds = termIdsByAttribute.get(attributeId) ?? [];
      if (!termIds.includes(termId)) {
        termIds.push(termId);
      }
      termIdsByAttribute.set(attributeId, termIds);
    }
  }

  return [...termIdsByAttribute].map(([attribute_id, term_ids]) => ({ attribute_id, term_ids }));
}

/**
 * The product form's initial data while a draft is open: the live data the edit page builds
 * (buildProductFormInitialData plus the assigned categories) with the draft laid over it.
 *
 * - Product values (the form's own autosave, a CMS draft import): merged over the live data, not in
 *   place of it, so a key the draft lacks keeps its live value, except the sale window, which is one
 *   unit as publish takes it (resolveProductDraftSaleWindow). The draft's top-level price and sale
 *   price are major units and go back to cents, the unit ProductForm reads them in; its price maps
 *   and variants are already in the form's units. `hydratedProductMedia` stands in for the draft's
 *   `{ media_id }` gallery entries when the page resolved them. A variant without its combination
 *   key, options or label (a CMS draft import's) gets them (completeDraftVariantForForm; the
 *   `globalAttributes` the page gives ProductForm name the terms no live variant has), and a draft
 *   with variants but no variation_attributes gets those from its variants. A draft an earlier
 *   version saved shows the live values for its poisoned fields (findPoisonedProductDraftFields:
 *   prices, sale prices, variants, stock, gallery, description; with the variants, the live stock
 *   the form shows read-only beside them; and a digital product's stock without naming it), so the
 *   next autosave repairs them together and stamps the marker.
 * - An in-page overlay or a pre-0.23.4 row snapshot: the live data with the overlay fields publish
 *   would write (planProductDraftOverlayPublish: a legacy snapshot's, and the snapshot fields an
 *   overlay rewritten from one recorded, only while the live row is unchanged since the snapshot was
 *   taken; getProductDraftEditNotices names those it skips). Shown as form values, a snapshot put its
 *   cent prices into dollar fields (x100) and an empty variant list into the form, and the next
 *   autosave made both real.
 *
 * `liveProduct` is the live getProduct() row the old-draft checks compare with, and `draftCreatedAt`
 * the draft's `created_at`.
 */
export function mergeProductDraftMetaIntoFormInitialData<T extends Record<string, any>>(
  liveInitialData: T,
  meta: unknown,
  options: {
    productId: string;
    liveProduct: unknown;
    draftCreatedAt?: unknown;
    hydratedProductMedia?: unknown;
    /** The global attributes the edit page gives ProductForm (buildGlobalAttributesForForm). */
    globalAttributes?: readonly ProductAttribute[];
  }
): T {
  if (!isRecord(meta)) {
    return liveInitialData;
  }

  if (classifyProductDraftMeta(meta) !== 'product-values') {
    const live = isRecord(options.liveProduct) ? options.liveProduct : liveInitialData;
    const { update } = planProductDraftOverlayPublish(meta, live, options.draftCreatedAt);
    return { ...liveInitialData, ...update };
  }

  const draftValues = withoutProductDraftFormMarker(meta);
  const merged: Record<string, any> = {
    ...overlayProductDraftValues(liveInitialData, draftValues),
    ...resolveProductDraftSaleWindow(draftValues, liveInitialData),
    id: options.productId,
  };

  if (typeof draftValues.price === 'number') {
    merged.price = draftAmountToStoredCents(draftValues.price);
  }

  if (hasOwn(draftValues, 'sale_price')) {
    merged.sale_price = draftAmountToStoredCents(draftValues.sale_price);
  }

  if (Array.isArray(draftValues.product_media)) {
    merged.product_media = options.hydratedProductMedia ?? draftValues.product_media;
  }

  if (!Array.isArray(draftValues.category_ids)) {
    merged.category_ids = liveInitialData.category_ids;
  }

  if (Array.isArray(draftValues.variants)) {
    const liveVariants = recordsOf(liveInitialData.variants);
    const termOptions = indexTermOptions(
      liveVariants,
      options.globalAttributes,
      readLiveProductLanguageCode(options.liveProduct)
    );
    merged.variants = draftValues.variants.map((variant) =>
      completeDraftVariantForForm(variant, liveVariants, termOptions)
    );

    // The variations editor picks its attribute terms from variation_attributes (from the variants'
    // options when there are none) and regenerates the variant list from them only when the selected
    // terms (or the currencies) change, so they come from the same source as the variants: a draft
    // with its own variants and no attributes (a CMS draft import) takes them from those variants,
    // never the live ones.
    if (!Array.isArray(draftValues.variation_attributes)) {
      merged.variation_attributes = deriveVariationAttributes(merged.variants);
    }
  }

  const check = checkProductDraft(meta, options.liveProduct);
  for (const field of check.fields) {
    if (field === 'prices') {
      merged.price = liveInitialData.price;
      merged.prices = liveInitialData.prices;
    } else if (field === 'sale_prices') {
      merged.sale_price = liveInitialData.sale_price ?? null;
      merged.sale_prices = liveInitialData.sale_prices;
    } else if (field === 'variants') {
      merged.variants = liveInitialData.variants;
      merged.variation_attributes = liveInitialData.variation_attributes;
      // The stock ProductForm shows read-only beside the variants: the live variants' (the RPC sums
      // their stock), never the draft's (a rebuilt variant's snapshot had none).
      if (countRows(liveInitialData.variants) > 0) {
        merged.stock = liveInitialData.stock;
      }
    } else if (field === 'stock') {
      merged.stock = liveInitialData.stock;
    } else if (field === 'product_media') {
      merged.product_media = liveInitialData.product_media;
    } else {
      merged.description_json = liveInitialData.description_json;
    }
  }

  if (check.repairHiddenStock) {
    merged.stock = liveInitialData.stock;
  }

  return merged as T;
}
