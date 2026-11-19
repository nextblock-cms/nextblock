// Deep subpaths, not the barrels: lib/visual-editing/product-drafts.ts imports this module, and the
// public product page imports that one (tools/scripts/commerce-chunking.test.ts).
import {
  buildCombinationKey,
  buildVariantLabel,
  isReadableVariantOption,
  mapRawVariantRelations,
  resolveAttributeName,
  resolveTermValue,
} from '@nextblock-cms/ecommerce/variation-utils';
import type { ProductAttribute, ProductVariantOption } from '@nextblock-cms/ecommerce';
import { normalizeProductGallery } from '@nextblock-cms/ecommerce/product-gallery';
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
 * buildProductDraftPublishValues (libs/ecommerce product-actions.ts: what a publish sends
 * publish_product_draft, migration 02043) multiplies every amount it is handed by 100, as
 * updateProduct() does (`toCents`: price, sale price, both price maps and every variant amount),
 * whatever the currency. This is its exact inverse, so a live amount sent through it comes back
 * unchanged. It is not `minorUnitAmountToMajor` (the display conversion above), which leaves a
 * zero-decimal currency (JPY, KRW, ...) as it is: published, that entry would come back x100.
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
 * mappings) as the values a publish writes back unchanged. Publishing a product-values draft takes
 * every field the draft lacks from here, so a partial draft (a CMS draft import that left the sale
 * schedule out, a hand-written row) never deletes the variants, clears the description or the
 * schedule, or zeroes a price. The gallery and the categories are left out on purpose: the publish
 * (buildProductDraftPublishValues sends null for them) leaves both alone when the values do not
 * carry them.
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

/**
 * Keys the form and the CMS import always store as a list. A value that is not one (null, false, 0, '',
 * an object, a string, a number: only a hand-written draft holds one, product_drafts RLS checks the role
 * only) counts as a missing key, so the edit page shows the live value and publish keeps it: no variant
 * list keeps the live variants, no gallery or category list leaves them as they are. Copied as it was
 * (until 2026-11-18), a variant list that was not one made ProductForm throw on mount
 * (`(variants ?? []).filter`), which took the edit page down, and publish then read false, 0 or '' as no
 * variants (serializeVariantsForRpc's `(variants || [])`), which deleted every live variant, while any
 * other such value made the publish builder throw; variation attributes that were not a list blocked
 * every autosave (productSchema refuses them, and no field shows them) or, as a string, made the
 * variations editor throw.
 */
const PRODUCT_VALUE_LIST_KEYS = new Set([
  'variants',
  'variation_attributes',
  'product_media',
  'category_ids',
  'explicitly_removed_media_ids',
]);

/**
 * `base` with every key of a product-values draft laid over it (see PRODUCT_VALUE_KEYS_NEVER_NULL and
 * PRODUCT_VALUE_LIST_KEYS).
 */
export function overlayProductDraftValues<T extends Record<string, any>>(
  base: T,
  meta: Record<string, unknown>
): T & Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(meta)) {
    if ((value === null || value === undefined) && PRODUCT_VALUE_KEYS_NEVER_NULL.has(key)) {
      continue;
    }
    if (PRODUCT_VALUE_LIST_KEYS.has(key) && !Array.isArray(value)) {
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
 * Draft keys publish never sends: the form never shows them, and nothing pins them (any
 * product_drafts writer, a WRITER over PostgREST included, can set them). A top-level `media_id`
 * replaced the whole gallery while the edit page showed the live one, and
 * `explicitly_removed_media_ids` (the form's list of images removed in its session) named media to
 * delete; updateProduct() reads neither since 0.23.4 (security review 2026-11-15), and
 * buildProductDraftPublishValues, the publish's path since migration 02043, has no field for either.
 */
const PRODUCT_DRAFT_KEYS_NEVER_PUBLISHED = ['media_id', 'explicitly_removed_media_ids'] as const;

/** The largest quantity an inventory row holds (`inventory_items.quantity` is an integer). */
const MAX_STOCK_QUANTITY = 2147483647;

/**
 * A SKU as the inventory rows key it: surrounding spaces removed, as Postgres btrim() does. Text only:
 * publish refuses a draft whose SKU is anything else (findUnreadableProductDraftValues), so such a SKU
 * keys no stock here.
 */
function stockSku(sku: unknown): string {
  return typeof sku === 'string' ? sku.replace(/^ +| +$/g, '') : '';
}

function isStockQuantity(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_STOCK_QUANTITY;
}

/** Text Postgres reads as a plain decimal `numeric`: surrounding spaces, a sign, a fraction, an exponent. */
const DECIMAL_TEXT_PATTERN = /^[ \t\n\v\f\r]*[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?[ \t\n\v\f\r]*$/i;

/**
 * A draft's stock quantity as publish writes it: a number, or text that is a plain decimal, cut to its
 * whole part and held between 0 and MAX_STOCK_QUANTITY (as publish_product_draft, migration 02044, reads
 * one); null or a missing one reads as 0. Null for anything else: a boolean, an object, other text, and a
 * value that is not finite (JSON's 1e400 parses as Infinity, which JSON.stringify would send as null, read
 * as 0; the text "1e400" reads as Infinity too). completeProductDraftValues sends every quantity as this
 * whole number, and publish refuses a draft holding one this reads as null
 * (findUnreadableProductDraftValues), so the function never reads a quantity the edit page could not. The
 * form saves whole numbers only; a hand-written PATCH (any product_drafts writer, a WRITER over PostgREST
 * included) can store anything.
 */
function readDraftStockQuantity(value: unknown): number | null {
  const amount =
    value === null || value === undefined
      ? 0
      : typeof value === 'number'
        ? value
        : typeof value === 'string' && DECIMAL_TEXT_PATTERN.test(value)
          ? Number(value)
          : NaN;
  return Number.isFinite(amount) ? Math.min(MAX_STOCK_QUANTITY, Math.max(0, Math.trunc(amount))) : null;
}

/** A draft variant with its stock quantity as publish writes it (readDraftStockQuantity), or as it is when unreadable. */
function withPublishedStockQuantity(variant: unknown) {
  if (!isRecord(variant)) {
    return variant;
  }

  const quantity = readDraftStockQuantity(variant.stock_quantity);
  return quantity === null || quantity === variant.stock_quantity ? variant : { ...variant, stock_quantity: quantity };
}

/**
 * The total of the variants' stock quantities, held at MAX_STOCK_QUANTITY: the product's stock the function
 * writes beside them, which it computes from the variants itself and holds at the same figure
 * (`products.stock` is an integer). Unheld, two variants of 2147483647 showed a total of 4294967294 beside
 * them, a stock no publish writes.
 */
function totalVariantStock(variants: readonly unknown[]): number {
  return recordsOf(variants).reduce(
    (total: number, variant) => Math.min(MAX_STOCK_QUANTITY, total + (readDraftStockQuantity(variant.stock_quantity) ?? 0)),
    0
  );
}

/**
 * The stock the product form loads, per SKU: the form's `stock_baseline`, { sku: quantity }, from each
 * variant's `stock_quantity`, or the product's `stock` when it has no variants. The edit page sets it on
 * the form's initial data, ProductForm carries it unseen, and the autosave stores it in the draft.
 * Publishing (publish_product_draft, migration 02044) leaves a SKU's inventory alone when the draft's
 * quantity equals it or the SKU's current quantity, and otherwise applies the difference to the current
 * quantity, so a unit sold between the page load and Publish stays sold, and an edit still lands. A SKU
 * without a whole quantity from 0 up is left out (publish then writes the draft's quantity, as before); of
 * variants sharing a SKU the last one counts, as it does in the publish.
 */
export function buildProductStockBaseline(values: {
  sku?: unknown;
  stock?: unknown;
  variants?: unknown;
}): Record<string, number> {
  const variants = Array.isArray(values.variants) ? values.variants.filter(isRecord) : [];
  const slots: Array<readonly [unknown, unknown]> =
    variants.length > 0
      ? variants.map((variant) => [variant.sku, variant.stock_quantity] as const)
      : [[values.sku, values.stock] as const];

  const baseline: Record<string, number> = {};
  for (const [sku, quantity] of slots) {
    const key = stockSku(sku);
    if (!key) {
      continue;
    }
    if (isStockQuantity(quantity)) {
      baseline[key] = quantity;
    } else {
      delete baseline[key];
    }
  }
  return baseline;
}

/** A draft's `stock_baseline` with its readable entries only, or null when it has none (not an object). */
function readProductStockBaseline(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) {
    return null;
  }

  const baseline: Record<string, number> = {};
  for (const [sku, quantity] of Object.entries(value)) {
    const key = stockSku(sku);
    if (key && isStockQuantity(quantity)) {
      baseline[key] = quantity;
    }
  }
  return baseline;
}

/** What a product's last product-values publish did with one SKU (ProductStockPublish). */
export interface ProductStockPublishEntry {
  /** The baseline entry that publish used for the SKU; null when it had none (a SKU the page had not loaded). */
  loaded: number | null;
  /** The quantity that publish's values carried for the SKU. */
  entered: number;
}

/**
 * A product's last product-values publish, as public.product_stock_publishes records it (migration 02047)
 * and publish_product_draft reads it: `count`, how many product-values publishes the product has had (0
 * before the first, and on a database without the table), and `entries`, what the last one did with each
 * SKU of its values (none when its values carried no baseline). The edit page reads the row before the
 * product, records `count` beside the form's baseline (`stock_baseline_publish_count`), and decides a
 * draft's stock from it as publish does (reconcileProductDraftStock): a baseline whose count is below the
 * product's was loaded before the last publish, and a SKU whose baseline entry is the one that publish
 * used counts from the quantity that publish entered.
 */
export interface ProductStockPublish {
  count: number;
  entries: ReadonlyMap<string, ProductStockPublishEntry>;
}

/** No product-values publish recorded: a product without a row, or a database without the table. */
export const NO_PRODUCT_STOCK_PUBLISH: ProductStockPublish = { count: 0, entries: new Map() };

/**
 * A product_stock_publishes row (`publish_count`, `stock`) as private.apply_product_draft_values reads it:
 * a count that is not a whole number from 0 reads as 0, and an entry counts only with a whole `entered`
 * and a whole or null `loaded` (the function counts from no other), keyed by the SKU as stored (trimmed
 * when the function wrote it). Anything that is not a row reads as no publish.
 */
export function readProductStockPublish(row: unknown): ProductStockPublish {
  if (!isRecord(row)) {
    return NO_PRODUCT_STOCK_PUBLISH;
  }

  const entries = new Map<string, ProductStockPublishEntry>();
  if (isRecord(row.stock)) {
    for (const [sku, entry] of Object.entries(row.stock)) {
      if (isRecord(entry) && isStockQuantity(entry.entered) && (entry.loaded === null || isStockQuantity(entry.loaded))) {
        entries.set(sku, { loaded: entry.loaded, entered: entry.entered });
      }
    }
  }
  return { count: isStockQuantity(row.publish_count) ? row.publish_count : 0, entries };
}

/** PostgREST's code for a table its schema cache lacks, and Postgres' own: no product_stock_publishes yet. */
const MISSING_TABLE_ERROR_CODES = new Set(['PGRST205', '42P01']);

/**
 * The edit page's read of a product's product_stock_publishes row (the `{ data, error }` of
 * `.select('publish_count, stock').eq('product_id', id).maybeSingle()`): the row as publish reads it
 * (readProductStockPublish; none for a product without one), no publish recorded on a database that has
 * not applied migration 02047 (its publish ignores the count, so the page decides the stock as 02044 did),
 * and an error for any other failure, which the page throws rather than show a stock it could not check.
 */
export function readProductStockPublishAnswer(answer: {
  data?: unknown;
  error?: { code?: unknown; message?: unknown } | null;
}): ProductStockPublish {
  const error = answer.error;
  if (error) {
    if (typeof error.code === 'string' && MISSING_TABLE_ERROR_CODES.has(error.code)) {
      return NO_PRODUCT_STOCK_PUBLISH;
    }
    const message = typeof error.message === 'string' && error.message ? error.message : 'unknown error';
    throw new Error(`The product's last publish could not be read: ${message}`);
  }
  return readProductStockPublish(answer.data);
}

/**
 * Whether a draft's baseline was loaded before the product's last product-values publish, as
 * publish_product_draft decides it (migration 02047): the values carry a baseline and a
 * `stock_baseline_publish_count` that is a whole number below the product's count. A marker equal to the
 * count, above it, missing or unreadable (a draft saved before 02047, a hand-written one) is not: 02044's
 * rules then apply as they were.
 */
function isBaselineFromBeforeLastPublish(
  draftValues: Record<string, unknown>,
  stockPublish: ProductStockPublish
): boolean {
  const marker = draftValues.stock_baseline_publish_count;
  return isRecord(draftValues.stock_baseline) && isStockQuantity(marker) && marker < stockPublish.count;
}

/** The trimmed SKUs whose stock publish plans from these values: each variant's, or the product's without variants. */
function plannedStockSkus(values: Record<string, unknown>): string[] {
  const variants = Array.isArray(values.variants) ? values.variants : [];
  const skus = variants.length > 0 ? variants.map((variant) => (isRecord(variant) ? variant.sku : undefined)) : [values.sku];
  return skus.map(stockSku).filter(Boolean);
}

/**
 * The live stock per SKU as the edit page reads it (reconcileProductDraftStock reads buildProductFormInitialData's
 * data, which keeps the products row's stock as it is): the values buildProductFormValuesFromLiveProduct made
 * of the same row, with the row's own stock, since that function reads a NULL stock as 0 and the page
 * keeps it NULL, which has no entry.
 */
function readLiveStockAsShown(
  liveValues: { sku?: unknown; stock?: unknown; variants?: unknown },
  liveProduct: unknown
): Record<string, number> {
  return buildProductStockBaseline({ ...liveValues, stock: isRecord(liveProduct) ? liveProduct.stock : undefined });
}

/**
 * The baseline a publish sends with the completed values. The draft's describes the quantities its form
 * showed, so it goes only with quantities that are the draft's: the variants' when the draft carries
 * its variants, the product's stock when the values publish no variants and the draft carries a stock.
 * A quantity the publish takes from live instead (a CMS draft import without those columns) was never
 * in that form: its SKUs publish as unchanged (the live quantities as baseline, so the current stock
 * stays), never against the draft's baseline, which would subtract a sale made since twice. A draft
 * without one sends none: publish writes its quantities as it always did.
 *
 * Of the draft's entries, only those for a SKU the live product stocks go (as the edit page reads the live
 * stock, readLiveStockAsShown). The function reads a SKU's current stock from inventory_items, shared by
 * SKU across products, so an entry for any other SKU (one another publish removed since, a product whose
 * stock is NULL, or one written by hand for another product's SKU) was applied to a stock the page never
 * showed: the page showed 51 and publish wrote 0 to another product's row. Without an entry the function
 * writes the draft's quantity, as the page shows it.
 *
 * The function then leaves a SKU alone where the draft's quantity equals its baseline or the current
 * stock, and otherwise applies the difference to the current stock, never below 0: the rule the edit page
 * shows the same draft by (reconcileProductDraftStock), so a draft published as it stands, with no
 * autosave since the page loaded, writes what the page showed while the stock has not moved since.
 *
 * A SKU of the values the live product stocks that the draft's baseline lacks (a variant added, or a SKU
 * renamed, on a page loaded before the product's last publish, which made it live) goes as a null entry:
 * for a baseline loaded before that publish (`stock_baseline_publish_count`, migration 02047) the
 * function counts it from the quantity that publish entered when that publish had no entry for it either,
 * so a sale of it since that publish stays sold; otherwise it reads a null entry as none, and writes the
 * draft's quantity, as before.
 */
function resolvePublishedStockBaseline(
  draftValues: Record<string, unknown>,
  values: Record<string, unknown>,
  liveValues: { sku?: unknown; stock?: unknown; variants?: unknown },
  liveProduct: unknown
): Record<string, number | null> | undefined {
  const recorded = readProductStockBaseline(draftValues.stock_baseline);
  if (!recorded) {
    return undefined;
  }

  const publishesVariants = Array.isArray(values.variants) && values.variants.length > 0;
  const quantitiesFromDraft = publishesVariants
    ? Array.isArray(draftValues.variants)
    : draftValues.stock !== null && draftValues.stock !== undefined;
  if (!quantitiesFromDraft) {
    return buildProductStockBaseline(liveValues);
  }

  const live = readLiveStockAsShown(liveValues, liveProduct);
  const sent: Record<string, number | null> = {};
  for (const [sku, quantity] of Object.entries(recorded)) {
    if (hasOwn(live, sku)) {
      sent[sku] = quantity;
    }
  }
  for (const sku of plannedStockSkus(values)) {
    if (hasOwn(live, sku) && !hasOwn(sent, sku)) {
      sent[sku] = null;
    }
  }
  return sent;
}

/**
 * What publishing a product-values draft writes (buildProductDraftPublishValues makes the function's
 * `p_values` from it): the draft's own values, and the live product's for every field the draft does
 * not carry, with the sale window as one unit (resolveProductDraftSaleWindow). The draft's marker and
 * PRODUCT_DRAFT_KEYS_NEVER_PUBLISHED never reach it, so the gallery it writes is the draft's
 * `product_media` (which the edit page shows) or the live one. Each variant's stock quantity, and the
 * product's stock without variants, is the whole number readDraftStockQuantity reads (a quantity it
 * cannot read stays as it is, and publish refuses that draft first: findUnreadableProductDraftValues);
 * with variants the product's stock is their total, which the function writes whatever it is sent. Its
 * `stock_baseline` is the draft's, for the quantities that are the draft's (resolvePublishedStockBaseline),
 * with the draft's `stock_baseline_publish_count` beside it (migration 02047), both dropped when the draft
 * has no baseline.
 */
export function completeProductDraftValues(meta: Record<string, unknown>, liveProduct: any) {
  const draftValues = withoutProductDraftFormMarker(meta);
  const liveValues = buildProductFormValuesFromLiveProduct(liveProduct, readLiveProductLanguageCode(liveProduct));
  const values = overlayProductDraftValues(liveValues, draftValues);
  const saleWindow = resolveProductDraftSaleWindow(draftValues, liveValues);
  values.sale_start_at = saleWindow.sale_start_at;
  values.sale_end_at = saleWindow.sale_end_at;

  // A list either way: the draft's, or the live variants (PRODUCT_VALUE_LIST_KEYS).
  const variants = (Array.isArray(values.variants) ? values.variants : []).map(withPublishedStockQuantity);
  values.variants = variants as typeof values.variants;
  values.stock = variants.length > 0 ? totalVariantStock(variants) : readDraftStockQuantity(values.stock) ?? values.stock;

  const stockBaseline = resolvePublishedStockBaseline(draftValues, values, liveValues, liveProduct);
  if (stockBaseline) {
    values.stock_baseline = stockBaseline;
  } else {
    delete values.stock_baseline;
    delete values.stock_baseline_publish_count;
  }

  for (const key of PRODUCT_DRAFT_KEYS_NEVER_PUBLISHED) {
    delete values[key];
  }

  return values;
}

/** A value publishing a product-values draft cannot read (findUnreadableProductDraftValues). */
export interface UnreadableProductDraftValue {
  kind: 'stock' | 'sku';
  /** How the messages name it: "the stock of PRO-RED", "the SKU of variant 2 (Blue)". */
  label: string;
}

/**
 * The stocks and SKUs of a product-values draft that publishing cannot read, among those it takes from
 * the draft (completeProductDraftValues): each variant's SKU and stock when the values publish the draft's
 * variants, else the product's stock, and the product's SKU whenever the draft carries one. Publish
 * refuses a draft with any before anything is written (lib/visual-editing/product-drafts.ts), and the edit
 * page names them above the form (getProductDraftEditNotices) and shows the live stock in place of a
 * stock it cannot read (reconcileProductDraftStock), which the next autosave saves.
 *
 * - A stock readDraftStockQuantity reads as null: a boolean, an object, text that is not a plain decimal,
 *   a value that is not finite. Until 2026-11-18 publish sent one as it was, and the function wrote a
 *   stock the page never showed: the text "NaN" or "Infinity" (PostgreSQL reads both as numeric) as
 *   2147483647, a JSON 1e400 (Infinity here, which JSON.stringify sends as null) as 0. The function now
 *   refuses such text itself (02044); this refusal comes first and says what to do.
 * - A SKU that is not text: a number, an object, a list, a boolean, null or none on a variant. It is
 *   refused rather than read, because the function keys a SKU's stock by the text Postgres prints for the
 *   JSON value (`->>`: a number's digits, an object's JSON, "true"), which this page cannot match for
 *   every value: a crafted number SKU (10045 beside a baseline entry for "10045") showed 5 here, keyed by
 *   nothing, and published 0. A variant row's SKU is text and NOT NULL, so a variant without one failed
 *   the publish anyway. The form saves text only (productSchema), and retyping the SKU there repairs it.
 *
 * Empty for an overlay or a legacy snapshot, which publish no stock or SKU.
 */
export function findUnreadableProductDraftValues(meta: unknown, liveProduct: unknown): UnreadableProductDraftValue[] {
  if (!isRecord(meta) || classifyProductDraftMeta(meta) !== 'product-values') {
    return [];
  }

  const draftValues = withoutProductDraftFormMarker(meta);
  const found: UnreadableProductDraftValue[] = [];

  // A null SKU is a missing one (PRODUCT_VALUE_KEYS_NEVER_NULL): publish takes the live SKU.
  const draftSku = draftValues.sku;
  if (draftSku !== null && draftSku !== undefined && typeof draftSku !== 'string') {
    found.push({ kind: 'sku', label: "the product's SKU" });
  }

  // The variants publish writes: the draft's list, else the live variants (PRODUCT_VALUE_LIST_KEYS).
  const draftVariants = Array.isArray(draftValues.variants) ? draftValues.variants : null;
  if (draftVariants && draftVariants.length > 0) {
    draftVariants.forEach((variant, index) => {
      const entry: Record<string, unknown> = isRecord(variant) ? variant : {};
      const label = typeof entry.label === 'string' ? entry.label.trim() : '';
      const name = `variant ${index + 1}${label ? ` (${label})` : ''}`;
      if (typeof entry.sku !== 'string') {
        found.push({ kind: 'sku', label: `the SKU of ${name}` });
      }
      if (readDraftStockQuantity(entry.stock_quantity) === null) {
        found.push({ kind: 'stock', label: `the stock of ${stockSku(entry.sku) || name}` });
      }
    });
  } else {
    const publishesLiveVariants = draftVariants === null && isRecord(liveProduct) && countRows(liveProduct.product_variants) > 0;
    const draftStock = draftValues.stock;
    // Beside variants the function writes their total, never the product's stock.
    if (!publishesLiveVariants && draftStock !== null && draftStock !== undefined && readDraftStockQuantity(draftStock) === null) {
      const sku = stockSku(draftSku === null || draftSku === undefined ? (isRecord(liveProduct) ? liveProduct.sku : undefined) : draftSku);
      found.push({ kind: 'stock', label: sku ? `the stock of ${sku}` : "the product's stock" });
    }
  }

  return found;
}

const UNREADABLE_PRODUCT_DRAFT_VALUES_REASON =
  '(the form saves a stock as a number and a SKU as text; a hand-written draft can hold anything there)';

function describeUnreadableProductDraftValues(values: readonly UnreadableProductDraftValue[]) {
  return `Publishing cannot read ${joinProductFieldLabels(values.map((value) => value.label))} in this draft ${UNREADABLE_PRODUCT_DRAFT_VALUES_REASON}.`;
}

/**
 * Publish's refusal for a draft holding values it cannot read (findUnreadableProductDraftValues): names
 * them, and says how the CMS editor repairs them.
 */
export function buildUnreadableProductDraftPublishError(values: readonly UnreadableProductDraftValue[]) {
  const steps = [
    ...(values.some((value) => value.kind === 'stock') ? ['which shows the live stock in place of a stock it cannot read'] : []),
    ...(values.some((value) => value.kind === 'sku') ? ['retype a SKU that is not text'] : []),
  ];
  return `Not published. ${describeUnreadableProductDraftValues(values)} Open the product in the CMS editor, ${steps.join(', ')}, save a change (or discard the draft), then publish.`;
}

/**
 * The edit page's note for the same draft, read by anyone who opens the page: only an administrator
 * publishes, so its last step says so.
 */
export function buildUnreadableProductDraftNotice(values: readonly UnreadableProductDraftValue[]) {
  return [
    describeUnreadableProductDraftValues(values),
    ...(values.some((value) => value.kind === 'stock')
      ? ['The form shows the live stock in place of a stock it cannot read (0 for a SKU the live product does not stock).']
      : []),
    `${values.some((value) => value.kind === 'sku') ? 'Retype a SKU that is not text, save' : 'Save'} a change (or discard the draft), then publish (or ask an administrator to).`,
  ].join(' ');
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

  // Empty as publish reads it (normalizeProductGallery): entries it cannot write count for nothing.
  if (normalizeProductGallery(meta.product_media)?.mediaIds.length === 0 && countRows(liveProduct.product_media) > 0) {
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

/**
 * Whether publishing the draft's gallery would drop a live image: publishing would unlink an image the
 * old editor never showed (it stays in the media library; through 0.23.3 the publish also deleted it
 * when nothing else used it). The old page showed a row snapshot with an empty gallery, so a gallery
 * in such a draft was built from nothing. The draft's gallery is read as publish reads it
 * (normalizeProductGallery: lowercased, uuids only), so an id in another case is the same image.
 */
function galleryDropsLiveImage(meta: Record<string, any>, liveProduct: Record<string, any>) {
  const draftGallery = normalizeProductGallery(meta.product_media);
  if (!draftGallery) {
    return false;
  }

  const draftMediaIds = new Set(draftGallery.mediaIds);
  const liveMediaIds = stringIds(recordsOf(liveProduct.product_media).map((item) => item.media_id));
  return liveMediaIds.some((mediaId) => !draftMediaIds.has(mediaId.toLowerCase()));
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
 * The notes the edit page shows above the form for an open draft that publish would refuse or skip
 * parts of: an unmarked product-values draft an earlier version wrote (findPoisonedProductDraftFields),
 * a product-values draft holding a stock or a SKU publish cannot read (findUnreadableProductDraftValues),
 * the SKUs whose stock the form shows already live, already published by the product's last publish, or
 * applied to a stock that moved since the draft's change started, at another figure than the draft's
 * (reconcileProductDraftStock, from the edit page's own merge run again here over the same live product
 * and the same `stockPublish`, the product's last product-values publish as the page read it, so a note
 * names exactly the figures the form shows, the first five of a kind in the order publish's warning names
 * them), and a legacy row snapshot, or an overlay rewritten from one, whose snapshot fields publish will
 * skip (planProductDraftOverlayPublish, which skips nothing for any other overlay). Built from the same
 * functions publish uses, so the page says what publish would do.
 */
export function getProductDraftEditNotices(
  meta: unknown,
  liveProduct: unknown,
  draftCreatedAt: unknown,
  stockPublish: ProductStockPublish = NO_PRODUCT_STOCK_PUBLISH
): string[] {
  const notices: string[] = [];
  const check = checkProductDraft(meta, liveProduct);

  if (check.fields.length > 0) {
    notices.push(buildPoisonedProductDraftNotice(check.fields, { savedOverRowSnapshot: check.savedOverRowSnapshot }));
  }

  const unreadable = findUnreadableProductDraftValues(meta, liveProduct);
  if (unreadable.length > 0) {
    notices.push(buildUnreadableProductDraftNotice(unreadable));
  }

  if (isRecord(meta) && isRecord(liveProduct) && classifyProductDraftMeta(meta) === 'product-values') {
    // The live form data the edit page builds from the same row (the language changes labels only).
    const { stockCases } = mergeProductDraftForEdit(buildProductFormInitialData(liveProduct, []), meta, {
      productId: typeof liveProduct.id === 'string' ? liveProduct.id : '',
      liveProduct,
      draftCreatedAt,
      stockPublish,
    });
    notices.push(...describeProductDraftStockCases(stockCases));
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
 *
 * Options count only as a list whose every entry is readable (isReadableVariantOption, as ProductForm
 * reads them); any other list (a hand-written draft's null, `{}`, `[]`, or an option without a text term
 * value) is completed the same way, and keeps its own readable entries only when nothing names its terms.
 * Kept as they were, the variation attributes derived from them below named only the terms of the
 * readable entries, which the variations editor then selected.
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
  const ownOptions: unknown[] | null = Array.isArray(draftVariant.selected_options) ? draftVariant.selected_options : null;
  const hasOptions = ownOptions !== null && ownOptions.every(isReadableVariantOption);
  const hasLabel = typeof draftVariant.label === 'string';
  if (hasKey && hasOptions && hasLabel) {
    return draftVariant;
  }

  /** The options to show: the draft's own when they count, else `named` (the terms'), else its readable ones. */
  const chooseOptions = (named: unknown[]) =>
    hasOptions ? ownOptions : named.length > 0 ? named : (ownOptions ?? []).filter(isReadableVariantOption);

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
      selected_options: chooseOptions(recordsOf(live.selected_options)),
      label: hasLabel ? draftVariant.label : live.label,
    };
  }

  const named = termIds
    .map((termId) => termOptions.get(termId))
    .filter((entry): entry is TermOption => entry !== undefined)
    .sort((left, right) => left.order - right.order)
    .map((entry) => entry.option);
  const options = chooseOptions(named) as ProductVariantOption[];

  return {
    ...draftVariant,
    combination_key: combinationKey,
    selected_options: options,
    label: hasLabel ? draftVariant.label : buildVariantLabel(hasOptions ? named : options),
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
 * A SKU whose stock the edit page shows at another figure than the draft's quantity, or leaves as it is
 * although the draft changed it, by publish's rule (reconcileProductDraftStock). The page names each above
 * the form (getProductDraftEditNotices), with the kinds publish warns with (`stock_adjusted`, read by
 * describeAdjustedProductStock in lib/visual-editing/product-drafts.ts): the draft changed the SKU's stock
 * from `loaded` (its baseline) to `entered` (its quantity, as publish reads it), the live stock is
 * `current`, and the form shows `shown`, which publishing the draft as it stands writes.
 * - `already_live`: `current` equals `entered`, so the stock is left as it is. Right for a change already
 *   published (a draft started again after its publish), wrong for a change meant to come on top of what
 *   moved the stock (loaded 10, 9 typed for a damaged unit, one sold meanwhile: 9 stays where 8 was meant).
 * - `moved`: the live stock moved away from `loaded`, so the change is applied to it and `shown` is
 *   another figure than `entered`: wrong when the draft's figure already counted what moved the stock.
 * - `already_published` (migration 02047): the draft's baseline was loaded before the product's last
 *   publish, which used the same baseline entry and entered `entered` (`loaded` is that figure), so that
 *   publish made the change live and the stock is left as it is, with what moved it since. Right for a
 *   draft started again after its publish, wrong for a figure meant to replace the stock as it now is.
 * `fromLastPublish`: the change counts from the quantity the product's last publish entered (`loaded`),
 * not from the draft's baseline entry, which that publish used too (migration 02047).
 * The figures may be another editor's autosave or a hand-written draft's (any product_drafts writer can
 * set them), so the notes name the draft, never the reader.
 */
interface ProductDraftStockCase {
  sku: string;
  reason: 'already_live' | 'already_published' | 'moved';
  loaded: number;
  entered: number;
  current: number;
  shown: number;
  fromLastPublish: boolean;
}

/**
 * The stock the edit page shows for an open product-values draft, and the `stock_baseline` its form
 * records (buildProductStockBaseline), SKU by SKU (each variant's, or the product's without variants):
 * what publishing the draft as it stands would write (completeProductDraftValues, then
 * publish_product_draft, migration 02044, by the same rule), with the live quantity as the baseline of
 * every SKU the live product stocks, so a figure typed over the page is absolute from this page load. It
 * writes the quantities shown and that baseline into `merged`, and returns the SKUs to name above the form
 * (ProductDraftStockCase) in the order publish answers them (compareStockSkus): one rule decides both, SKU
 * by SKU, so a note never names a figure the form does not show. The draft's quantity is read as publish
 * sends it (readDraftStockQuantity: a number, or a plain decimal in text, its whole part, from 0; null or
 * none as 0):
 * - For a SKU the draft's baseline records and the live product stocks: equal to its baseline (the editor
 *   did not change it), it shows the live quantity (the draft's copy is the stock from when it was saved,
 *   and a sale since then is no edit); equal to the live quantity (already live: a draft started again
 *   after a publish, from values loaded before it, or a stock that reached the draft's figure some other
 *   way), it shows the live quantity too, and is named (`already_live`); otherwise the change applied to
 *   the live quantity, never below 0, so an edit made before a sale keeps the sale's deduction, and a
 *   baseline the page never loaded (product_drafts RLS checks the role only, so any WRITER can write one)
 *   shows as the stock change it makes, never hidden behind the draft's figure while publish writes
 *   another; named (`moved`) when that is not the draft's figure.
 * - For a SKU the live product stocks that the draft's baseline lacks (a variant added or a SKU renamed in
 *   the draft, or added by a publish the draft was started again after), and every SKU of a draft without
 *   a baseline (an earlier version's): the quantity as read, which publish writes as it stands (it sends
 *   no baseline entry for it, resolvePublishedStockBaseline), with the live quantity recorded as its
 *   baseline, so from the next autosave publish applies the figure shown as a change, and a sale made after
 *   this page load stays sold. A sale made between the save that put that figure in the draft and this page
 *   load is in neither the figure nor a note, so it stays undone after that autosave: for a variant added
 *   before a publish, in the draft an autosave queued behind that publish started again, a sale made
 *   between that publish and this page load (a publish of the draft as it stands undoes every sale since
 *   that publish). Until 2026-11-18 a SKU missing from a draft's baseline got no baseline here while the
 *   draft had one, so every publish of that draft wrote the variant's figure as it stood, each sale of it
 *   since that first publish undone.
 * - For a baseline loaded before the product's last product-values publish (its
 *   `stock_baseline_publish_count` is below `stockPublish.count`, migration 02047: an autosave queued
 *   behind that publish, or a tab opened before it, started the draft again), a SKU whose baseline entry
 *   is the one that publish used (the same number, or none in both: a variant added before that publish,
 *   which publish then sends as a null entry) counts from the quantity that publish entered, as the
 *   function does: equal to it, the live quantity (that publish made the change live; named
 *   `already_published`), otherwise the rules above from that figure. Without this a change that publish
 *   made live was applied again once the stock moved (loaded 5, typed 10 and published, one sold: 14), a
 *   figure typed while it ran counted from the older baseline (12 typed after 10 was published from a load
 *   of 5: 17), and a variant added before it was written as typed again, every sale of it since undone.
 * - For a SKU the live product does not stock (another product's SKU, one another publish removed since, a
 *   product whose stock is NULL): the quantity as read, with no baseline, as publish writes it.
 * - A quantity publish cannot read (a boolean, an object, other text, a value that is not finite) shows
 *   the live quantity (0 for a SKU the live product does not stock), with the live quantity as its
 *   baseline: publish refuses the draft (findUnreadableProductDraftValues, which the page names above the
 *   form) until an autosave saves what the page shows. Kept as it was, it showed an empty field, and the
 *   next autosave of any field saved what the form's z.coerce.number() made of it (1 for true, 0 for false
 *   or [], 16 for "0x10"), a figure the page never showed.
 * A SKU that is not text keys nothing (publish refuses the draft for it): its quantity shows as read. The
 * read-only total beside the variants is the total of the quantities shown (totalVariantStock), the
 * product's stock the function writes beside them. A SKU is named only when the quantities shown are the
 * draft's (`quantitiesFromDraft`, decided as resolvePublishedStockBaseline decides it for publish): beside
 * live quantities (a draft without a variant list, groups the old-draft check repairs) the draft's baseline
 * describes nothing shown, and publish sends the live stock as unchanged. Of variants sharing a SKU the
 * last one decides whether it is named, as it counts in the publish. The form's
 * `stock_baseline_publish_count` becomes `stockPublish.count`, the product's count as this page read it
 * before the product: the baseline it records is this page load's.
 */
function reconcileProductDraftStock(
  merged: Record<string, any>,
  liveInitialData: Record<string, any>,
  draftValues: Record<string, unknown>,
  quantitiesFromDraft: boolean,
  stockPublish: ProductStockPublish
): ProductDraftStockCase[] {
  const live = buildProductStockBaseline(liveInitialData);
  const recorded = readProductStockBaseline(draftValues.stock_baseline);
  const fromBeforeLastPublish = isBaselineFromBeforeLastPublish(draftValues, stockPublish);
  const baseline: Record<string, number> = {};
  const cases = new Map<string, ProductDraftStockCase>();

  const decide = (key: string, entered: number | null): { shown: number; found: ProductDraftStockCase | null } => {
    const liveQuantity = key && hasOwn(live, key) ? live[key] : null;
    if (entered === null) {
      if (liveQuantity !== null) {
        baseline[key] = liveQuantity;
      }
      return { shown: liveQuantity ?? 0, found: null };
    }
    if (liveQuantity === null) {
      return { shown: entered, found: null };
    }

    baseline[key] = liveQuantity;
    if (!recorded) {
      return { shown: entered, found: null };
    }

    // What publish sends for this SKU (resolvePublishedStockBaseline): the draft's entry, or a null entry
    // for a SKU the live product stocks that the draft's baseline lacks. The figure the change counts
    // from: that entry, or, for a baseline loaded before the product's last publish whose entry is the
    // one that publish used, the quantity that publish entered (private.apply_product_draft_values, 02047).
    const loaded = hasOwn(recorded, key) ? recorded[key] : null;
    const last = fromBeforeLastPublish ? stockPublish.entries.get(key) : undefined;
    const fromLastPublish = last !== undefined && last.loaded === loaded;
    const reference = fromLastPublish ? last.entered : loaded;

    if (loaded !== null && entered === loaded) {
      return { shown: liveQuantity, found: null };
    }
    if (reference === null) {
      return { shown: entered, found: null };
    }

    let shown: number;
    let reason: ProductDraftStockCase['reason'] | null;
    if (entered === liveQuantity) {
      shown = liveQuantity;
      reason = 'already_live';
    } else if (fromLastPublish && entered === reference) {
      shown = liveQuantity;
      reason = 'already_published';
    } else {
      shown = Math.min(MAX_STOCK_QUANTITY, Math.max(0, liveQuantity + entered - reference));
      reason = shown !== entered ? 'moved' : null;
    }
    return {
      shown,
      found:
        reason && quantitiesFromDraft
          ? { sku: key, reason, loaded: reference, entered, current: liveQuantity, shown, fromLastPublish }
          : null,
    };
  };

  const resolve = (sku: unknown, quantity: unknown): number => {
    const key = stockSku(sku);
    const { shown, found } = decide(key, readDraftStockQuantity(quantity));
    if (found) {
      cases.set(key, found);
    } else {
      cases.delete(key);
    }
    return shown;
  };

  const variants: unknown[] = Array.isArray(merged.variants) ? merged.variants : [];
  if (variants.length > 0) {
    // A variant whose quantity shows as the draft holds it is kept as it is (the same object).
    const resolved = variants.map((variant) => {
      if (!isRecord(variant)) {
        return variant;
      }
      const quantity = resolve(variant.sku, variant.stock_quantity);
      return quantity === variant.stock_quantity ? variant : { ...variant, stock_quantity: quantity };
    });
    if (resolved.some((variant, index) => variant !== variants[index])) {
      merged.variants = resolved;
    }
    merged.stock = totalVariantStock(resolved);
  } else {
    merged.stock = resolve(merged.sku, merged.stock);
  }

  merged.stock_baseline = baseline;
  merged.stock_baseline_publish_count = stockPublish.count;
  return [...cases.values()].sort((left, right) => compareStockSkus(left.sku, right.sku));
}

/**
 * `left` against `right` in the order publish_product_draft lists its `stock_adjusted` entries (`sku COLLATE
 * "C"`, migration 02044: the SKUs' UTF-8 bytes, which is Unicode code point order), so the notes above the
 * form and the publish warning name the same first five SKUs of a kind (in variant order, the two named
 * different SKUs once a kind had more than five). Not localeCompare, which in English puts "alpha" before
 * "BRAVO" (the function puts every capital letter first), and not a bare `<`, which compares UTF-16 code
 * units: the same order except where a character above U+FFFF (two code units from U+D800 to U+DFFF) meets
 * one from U+E000 to U+FFFF, such as a fullwidth letter, which the function puts first.
 */
function compareStockSkus(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftUnit = left.charCodeAt(index);
    const rightUnit = right.charCodeAt(index);
    if (leftUnit !== rightUnit) {
      return codePointRankOfUnit(leftUnit) - codePointRankOfUnit(rightUnit);
    }
  }
  return left.length - right.length;
}

/** A UTF-16 code unit's rank in code point order: the surrogates, which stand for U+10000 and up, after U+FFFF. */
function codePointRankOfUnit(unit: number): number {
  return unit >= 0xd800 && unit <= 0xdfff ? unit + 0x2000 : unit >= 0xe000 ? unit - 0x800 : unit;
}

/** How many SKUs a stock note or a publish warning names before it counts the rest. */
const PRODUCT_STOCK_SKUS_NAMED = 5;

/**
 * `entries` (one per SKU) joined with "; ": the first five, then how many more ("; and 2 more"). The edit
 * page's stock notes and publish's stock warning (describeAdjustedProductStock) name SKUs this way.
 */
export function listProductStockEntries(entries: readonly string[]): string {
  const named = entries.slice(0, PRODUCT_STOCK_SKUS_NAMED);
  const more = entries.length - named.length;
  return more > 0 ? `${named.join('; ')}; and ${more} more` : named.join('; ');
}

/**
 * The figure a stock note or a publish warning says a draft's change started from: the draft's baseline
 * entry, or the quantity the product's last publish entered, said so (migration 02047).
 */
export function describeProductStockChangeStart(loaded: number, fromLastPublish: boolean): string {
  return fromLastPublish ? `${loaded}, the figure the last publish entered,` : String(loaded);
}

/**
 * The notes above the edit form for the SKUs reconcileProductDraftStock names, one per kind: the stock the
 * draft's change started from has moved (the form shows the change applied to the current stock, at another
 * figure than the draft's), the stock already holds the draft's figure (publishing leaves it), or the
 * product's last publish already entered it, from a draft started on a page loaded before that publish
 * (publishing leaves the stock, with what moved it since). Each names the first five SKUs of its kind in the
 * order the cases come (publish's, so the publish warning names the same five), then how many more. An
 * autosave records the live stock as the baseline, after which a publish sees none of these cases and says
 * nothing: these notes are the only place the editor learns of them, and what they show is what publishing
 * writes. Each says what to do if the figure shown is not the one meant: enter the figure the stock should
 * have, which is absolute from this page load.
 */
function describeProductDraftStockCases(cases: readonly ProductDraftStockCase[]): string[] {
  const notes: string[] = [];

  const moved = cases.filter((entry) => entry.reason === 'moved');
  if (moved.length > 0) {
    const one = moved.length === 1;
    const list = listProductStockEntries(
      moved.map(
        (entry) =>
          `${entry.sku} shows ${entry.shown} (the draft changed ${describeProductStockChangeStart(entry.loaded, entry.fromLastPublish)} to ${entry.entered}, and the stock is now ${entry.current})`
      )
    );
    notes.push(
      `The stock has moved since ${one ? "this draft's stock change" : "this draft's stock changes"} started (after a sale or another stock update, for example), so the form shows ${one ? 'the change' : 'the changes'} applied to the current stock, as publishing would write ${one ? 'it' : 'them'}: ${list}. If the draft's ${one ? 'figure' : 'figures'} already counted that, enter the figure the stock should have.`
    );
  }

  const alreadyLive = cases.filter((entry) => entry.reason === 'already_live');
  if (alreadyLive.length > 0) {
    const one = alreadyLive.length === 1;
    const list = listProductStockEntries(
      alreadyLive.map(
        (entry) =>
          `${entry.sku} stays at ${entry.shown} (the draft changed ${describeProductStockChangeStart(entry.loaded, entry.fromLastPublish)} to ${entry.entered})`
      )
    );
    notes.push(
      `The stock already holds ${one ? "this draft's figure, so publishing leaves it as it is" : "this draft's figures, so publishing leaves them as they are"}: ${list}. If ${one ? 'the change was' : 'a change was'} meant to come on top of what moved the stock (a damaged unit taken out after a sale, for example), enter the figure the stock should have.`
    );
  }

  const alreadyPublished = cases.filter((entry) => entry.reason === 'already_published');
  if (alreadyPublished.length > 0) {
    const one = alreadyPublished.length === 1;
    const list = listProductStockEntries(
      alreadyPublished.map((entry) => `${entry.sku} stays at ${entry.shown} (the last publish entered ${entry.entered})`)
    );
    notes.push(
      `This draft was started on a page loaded before the product's last publish, which already entered ${one ? "this draft's stock figure, so publishing leaves the stock as it is" : "this draft's stock figures, so publishing leaves those stocks as they are"}, with what sold or changed since: ${list}. If ${one ? 'the figure was' : 'a figure was'} meant to replace the stock as it now is, enter the figure the stock should have.`
    );
  }

  return notes;
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
 *   key, options or label (a CMS draft import's), or with options that are not all readable (a
 *   hand-written draft's), gets them (completeDraftVariantForForm; the `globalAttributes` the page
 *   gives ProductForm name the terms no live variant has), and a draft with variants but no
 *   variation_attributes gets those from its variants. A draft an earlier
 *   version saved shows the live values for its poisoned fields (findPoisonedProductDraftFields:
 *   prices, sale prices, variants, stock, gallery, description; with the variants, the live stock
 *   the form shows read-only beside them; and a digital product's stock without naming it), so the
 *   next autosave repairs them together and stamps the marker. The stock and the form's
 *   `stock_baseline` come from reconcileProductDraftStock: what publishing the draft as it stands would
 *   write (a quantity left as loaded, already live or already published by the product's last publish
 *   shows live; a change shows applied to the live stock; a quantity publish cannot read shows live, and
 *   publish refuses the draft until an autosave), over the live stock as the baseline, with
 *   `stockPublish.count` as its `stock_baseline_publish_count`; getProductDraftEditNotices names the SKUs
 *   it shows already live or already published, or applied to a stock that moved at another figure than
 *   the draft's, from the same merge (run again over the same live product and `stockPublish`). A
 *   variant list, a gallery or categories that
 *   are not a list show the live ones, which publish keeps (PRODUCT_VALUE_LIST_KEYS); variation
 *   attributes that are not a list show the live ones beside the live variants and come from the
 *   draft's own variants beside those (publish sends no variation attributes), and a draft without a
 *   variant list shows the live variants with the live attribute selection. Of a draft's own variation
 *   attributes, an entry that is not an object with a text `attribute_id` is left out and term ids that
 *   are not a list of text read as none (readVariationAttributeEntries): the variations editor threw on
 *   them, which took the edit page down.
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
  options: ProductDraftMergeOptions
): T {
  return mergeProductDraftForEdit(liveInitialData, meta, options).initialData;
}

interface ProductDraftMergeOptions {
  productId: string;
  liveProduct: unknown;
  draftCreatedAt?: unknown;
  hydratedProductMedia?: unknown;
  /** The global attributes the edit page gives ProductForm (buildGlobalAttributesForForm). */
  globalAttributes?: readonly ProductAttribute[];
  /**
   * The product's last product-values publish, as the page read it before the product
   * (readProductStockPublish; none recorded when absent): the stock is shown as publish decides it from
   * the same row, and the form records its count beside the baseline (migration 02047).
   */
  stockPublish?: ProductStockPublish;
}

/**
 * A draft's variation attributes as the variations editor reads them: the entries that are an object with
 * a text `attribute_id`, each with its text term ids (none when `term_ids` is not a list). The form and the
 * CMS import write nothing else; a hand-written draft can (product_drafts RLS checks the role only), and
 * the editor threw when it mounted in the browser (the edit page's client shell renders the form only after
 * mount, and /cms has no error boundary, so the page was lost for every reader): "Cannot read properties of
 * null (reading 'attribute_id')" for a null entry, ".includes is not a function" for term ids that were an
 * object or a number. A term id that is not text matches no term, and productSchema refused it, which
 * blocked every autosave. Publish sends no variation attributes, so nothing it writes changes. A list
 * the editor can read as it is comes back as it is (the same array and entries).
 */
function readVariationAttributeEntries(entries: unknown[]): unknown[] {
  let changed = false;
  const readable = entries.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.attribute_id !== 'string') {
      changed = true;
      return [];
    }
    const termIds: unknown[] = Array.isArray(entry.term_ids) ? entry.term_ids : [];
    const textTermIds = termIds.filter((termId) => typeof termId === 'string');
    if (termIds === entry.term_ids && textTermIds.length === termIds.length) {
      return [entry];
    }
    changed = true;
    return [{ ...entry, term_ids: textTermIds }];
  });
  return changed ? readable : entries;
}

/**
 * mergeProductDraftMetaIntoFormInitialData's work, with the SKUs the form shows already live, or applied to
 * a stock that moved at another figure than the draft's (reconcileProductDraftStock, in publish's order),
 * which getProductDraftEditNotices names above the form.
 */
function mergeProductDraftForEdit<T extends Record<string, any>>(
  liveInitialData: T,
  meta: unknown,
  options: ProductDraftMergeOptions
): { initialData: T; stockCases: ProductDraftStockCase[] } {
  if (!isRecord(meta)) {
    return { initialData: liveInitialData, stockCases: [] };
  }

  if (classifyProductDraftMeta(meta) !== 'product-values') {
    const live = isRecord(options.liveProduct) ? options.liveProduct : liveInitialData;
    const { update } = planProductDraftOverlayPublish(meta, live, options.draftCreatedAt);
    return { initialData: { ...liveInitialData, ...update }, stockCases: [] };
  }

  const draftValues = withoutProductDraftFormMarker(meta);
  // Whether the quantities the form shows are the draft's (its variants', or its stock without variants)
  // or live ones: a draft without a variant list shows the live variants, and the old-draft check below
  // repairs groups from live. Publish decides it the same way (resolvePublishedStockBaseline).
  let variantsFromDraft = Array.isArray(draftValues.variants);
  let stockFromDraft = draftValues.stock !== null && draftValues.stock !== undefined;
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

  // Never the draft's own entries: their `media` objects and `sort_order` are whatever its writer put
  // there, and publish reads neither. Without the page's media rows, the ids publish would write,
  // in its order, with no thumbnail. A gallery that is not a list (null, an object, a string) shows the
  // live one, which publish keeps (PRODUCT_VALUE_LIST_KEYS): shown empty, the next autosave saved [] and
  // the publish after it unlinked every image, and an object or a string made ProductForm throw.
  if (Array.isArray(draftValues.product_media)) {
    merged.product_media =
      options.hydratedProductMedia ??
      (normalizeProductGallery(draftValues.product_media)?.mediaIds ?? []).map((media_id, sort_order) => ({
        media_id,
        sort_order,
        media: null,
      }));
  }

  if (!Array.isArray(draftValues.category_ids)) {
    merged.category_ids = liveInitialData.category_ids;
  }

  if (!Array.isArray(draftValues.variants)) {
    // No variant list in the draft (none, null, or a value that is not a list): publish keeps the live
    // variants (PRODUCT_VALUE_LIST_KEYS), so the page shows them, with the live attribute selection the
    // variations editor reads beside them: a draft's own variation_attributes over the live variants
    // would seed its terms from another source than its rows.
    merged.variants = liveInitialData.variants;
    merged.variation_attributes = liveInitialData.variation_attributes;
  } else {
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
    // never the live ones. Its own attributes only as the editor can read them.
    merged.variation_attributes = Array.isArray(draftValues.variation_attributes)
      ? readVariationAttributeEntries(draftValues.variation_attributes)
      : deriveVariationAttributes(merged.variants);
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
      variantsFromDraft = false;
      // The stock ProductForm shows read-only beside the variants: the live variants' (the RPC sums
      // their stock), never the draft's (a rebuilt variant's snapshot had none).
      if (countRows(liveInitialData.variants) > 0) {
        merged.stock = liveInitialData.stock;
        stockFromDraft = false;
      }
    } else if (field === 'stock') {
      merged.stock = liveInitialData.stock;
      stockFromDraft = false;
    } else if (field === 'product_media') {
      merged.product_media = liveInitialData.product_media;
    } else {
      merged.description_json = liveInitialData.description_json;
    }
  }

  if (check.repairHiddenStock) {
    merged.stock = liveInitialData.stock;
    stockFromDraft = false;
  }

  const stockCases = reconcileProductDraftStock(
    merged,
    liveInitialData,
    draftValues,
    countRows(merged.variants) > 0 ? variantsFromDraft : stockFromDraft,
    options.stockPublish ?? NO_PRODUCT_STOCK_PUBLISH
  );

  return { initialData: merged as T, stockCases };
}

/** A media row the edit page reads for a draft's gallery (`id, file_path, object_key, file_name, description`). */
export interface ProductDraftGalleryMediaRow {
  id: string;
  file_path?: string | null;
  object_key?: string | null;
  file_name?: string | null;
  description?: string | null;
}

/** A gallery tile ProductForm draws (its `product_media` initial data). */
export interface ProductDraftGalleryTile {
  media_id: string;
  sort_order: number;
  media: { file_path: string | null; object_key: string | null; alt_text: string };
}

/**
 * The media ids the edit page reads for a draft's gallery: those publish would write
 * (normalizeProductGallery), for a product-values draft whose `product_media` is a list. Null for
 * any other draft, whose gallery the page never shows (an overlay or a legacy snapshot publishes no
 * gallery, and a draft without the key, or with one that is not a list, keeps the live one).
 */
export function readProductDraftGalleryMediaIds(meta: unknown): string[] | null {
  if (!isRecord(meta) || classifyProductDraftMeta(meta) !== 'product-values') {
    return null;
  }

  return normalizeProductGallery(meta.product_media)?.mediaIds ?? null;
}

function describeLeftOutProductDraftGalleryEntries(missing: number, invalid: number, repeats: number): string | null {
  const parts: string[] = [];
  if (missing > 0) {
    parts.push(missing === 1 ? 'an image that is not in the media library' : `${missing} images that are not in the media library`);
  }
  if (invalid > 0) {
    parts.push(invalid === 1 ? 'an entry that is not a media item' : `${invalid} entries that are not media items`);
  }
  if (repeats > 0) {
    parts.push(repeats === 1 ? 'a repeat of an image it already lists' : `${repeats} repeats of images it already lists`);
  }
  if (parts.length === 0) {
    return null;
  }

  const total = missing + invalid + repeats;
  return `This draft's gallery also lists ${joinProductFieldLabels(parts)}. Publishing leaves ${
    total === 1 ? 'it' : 'them'
  } out, so the gallery below shows only the images publishing would save, in its order.`;
}

/**
 * The gallery the product edit page shows for a draft, as publish will write it, and a note for what
 * publish leaves out. `mediaRows` are the media rows the page read for readProductDraftGalleryMediaIds.
 *
 * - The tiles are the ids publish writes (normalizeProductGallery: the list's order, lowercased, each
 *   once, uuids only, the rule publish_product_draft applies in SQL) that have a media row
 *   (publish_product_draft drops the others inside its transaction), each drawn from its row, with
 *   its index as `sort_order` (ProductForm orders by it). Nothing of the
 *   draft's own entries is shown: product_drafts RLS checks the role only, so any WRITER can write
 *   an entry whose embedded `media` object or `sort_order` shows the ADMIN the live gallery while
 *   publish writes another order or main image (security review 2026-11-15).
 * - `notice` names the entries left out (no media row, not a media id, a repeat). Null when there are
 *   none, or when the page shows the live gallery instead (a draft publish refuses for its gallery,
 *   findPoisonedProductDraftFields).
 *
 * Null for a draft whose gallery the page does not show (readProductDraftGalleryMediaIds).
 */
export function resolveProductDraftGalleryForEdit(
  meta: unknown,
  liveProduct: unknown,
  mediaRows: readonly ProductDraftGalleryMediaRow[]
): { tiles: ProductDraftGalleryTile[]; notice: string | null } | null {
  if (!isRecord(meta) || classifyProductDraftMeta(meta) !== 'product-values') {
    return null;
  }

  const gallery = normalizeProductGallery(meta.product_media);
  if (!gallery) {
    return null;
  }

  const rowsById = new Map(
    mediaRows
      .filter((row) => isRecord(row) && typeof row.id === 'string')
      .map((row) => [row.id.toLowerCase(), row] as const)
  );
  const shownIds = gallery.mediaIds.filter((mediaId) => rowsById.has(mediaId));
  const tiles = shownIds.map((mediaId, sort_order) => {
    const row = rowsById.get(mediaId) as ProductDraftGalleryMediaRow;
    return {
      media_id: mediaId,
      sort_order,
      media: {
        file_path: row.file_path ?? null,
        object_key: row.object_key ?? null,
        alt_text: row.description || row.file_name || '',
      },
    };
  });

  const showsLiveGallery = findPoisonedProductDraftFields(meta, liveProduct).includes('product_media');
  const notice = showsLiveGallery
    ? null
    : describeLeftOutProductDraftGalleryEntries(
        gallery.mediaIds.length - shownIds.length,
        gallery.invalidCount,
        gallery.duplicateCount
      );

  return { tiles, notice };
}
