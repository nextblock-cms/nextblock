import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@nextblock-cms/db/types';
import type { ProductFormValues } from './product-schema';
import { normalizeProductGallery } from './product-gallery';
import { syncSharedInventoryForSavedProduct } from './shared-inventory';
import { normalizeCurrencyCode } from '@nextblock-cms/utils/utils';
import { buildPublishedAtOrFilter } from '@nextblock-cms/utils';

// Helper to convert dollars to cents
const toCents = (dollars: number) => Math.round(dollars * 100);

function serializePriceMap(
  priceMap?: Record<string, number | null | undefined> | null
) {
  return Object.entries(priceMap || {}).reduce<Record<string, number>>(
    (accumulator, [currencyCode, amount]) => {
      if (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) {
        accumulator[normalizeCurrencyCode(currencyCode)] = toCents(amount);
      }

      return accumulator;
    },
    {}
  );
}

type SerializedVariant = ReturnType<typeof serializeVariantForRpc>;

/**
 * The variants as the RPCs take them: none for null or undefined. Anything else that is not a list, or a
 * list entry that is not an object, goes on as it is, for the database to refuse (publish_product_draft:
 * NBP04, "not a list" or "not an object"), never read as no variants, which deletes every live variant:
 * only a hand-written draft holds one, and the app's completeProductDraftValues reads a variant list that
 * is not a list as a missing one, which keeps the live variants. Until 2026-11-18 this read
 * `(variants || [])`: false, 0 or '' went out as no variants, so the publish deleted every live variant,
 * and any other value that is not a list threw here.
 */
function serializeVariantsForRpc(variants?: ProductFormValues['variants']): SerializedVariant[] {
  if (variants === null || variants === undefined) return [];
  if (!Array.isArray(variants)) return variants as unknown as SerializedVariant[];
  return variants.map((variant) =>
    variant !== null && typeof variant === 'object' && !Array.isArray(variant)
      ? serializeVariantForRpc(variant)
      : (variant as unknown as SerializedVariant)
  );
}

function serializeVariantForRpc(variant: NonNullable<ProductFormValues['variants']>[number]) {
  return {
    id: variant.id,
    sku: variant.sku,
    upc: variant.upc ?? null,
    price: toCents(variant.price),
    sale_price:
      typeof variant.sale_price === 'number' && !isNaN(variant.sale_price)
        ? toCents(variant.sale_price)
        : null,
    prices: serializePriceMap(variant.prices),
    sale_prices: serializePriceMap(variant.sale_prices),
    sale_start_at: variant.sale_start_at ?? null,
    sale_end_at: variant.sale_end_at ?? null,
    stock_quantity: variant.stock_quantity,
    main_media_id: variant.main_media_id ?? null,
    attribute_term_ids: variant.attribute_term_ids,
  };
}

function buildProductRpcPayload(data: ProductFormValues, id?: string) {
  const isFreemiusProduct =
    data.product_type === 'digital' && data.payment_provider === 'freemius';
  const trialPeriodDays = isFreemiusProduct
    ? Math.max(0, Number(data.trial_period_days ?? 0))
    : 0;

  return {
    id,
    product_type: data.product_type,
    payment_provider: data.payment_provider,
    title: data.title,
    slug: data.slug,
    sku: data.sku,
    upc: data.upc ?? null,
    stock: data.stock,
    status: data.status,
    short_description: data.short_description ?? null,
    description_json: data.description_json ?? null,
    metadata: {},
    price: toCents(data.price),
    sale_price:
      typeof data.sale_price === 'number' && !isNaN(data.sale_price)
        ? toCents(data.sale_price)
        : null,
    prices: serializePriceMap(data.prices),
    sale_prices: serializePriceMap(data.sale_prices),
    sale_start_at: data.sale_start_at ?? null,
    sale_end_at: data.sale_end_at ?? null,
    freemius_plan_id: data.freemius_plan_id ?? null,
    freemius_product_id: data.freemius_product_id ?? null,
    trial_period_days: trialPeriodDays,
    trial_requires_payment_method:
      trialPeriodDays > 0 ? data.trial_requires_payment_method ?? false : false,
    is_taxable: data.is_taxable,
    language_id: data.language_id,
    translation_group_id: data.translation_group_id || undefined,
    variants: serializeVariantsForRpc(data.variants),
  };
}

/**
 * Persist the SEO text fields directly on the product row. The
 * `upsert_product_with_variants` RPC intentionally does not touch these columns, so
 * meta_title / meta_description / custom_canonical are written here (keyed by the
 * just-saved product id). Empty strings normalise to NULL so a blank canonical falls
 * back to the self-referencing default (see the app's app/lib/seo.ts buildCanonicalUrl).
 */
async function persistProductSeoMeta(
  supabase: SupabaseClient<Database>,
  productId: string,
  data: ProductFormValues
) {
  const normalize = (value: string | null | undefined) => {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed ? trimmed : null;
  };

  const { error } = await supabase
    .from('products')
    .update({
      meta_title: normalize(data.meta_title),
      meta_description: normalize(data.meta_description),
      custom_canonical: normalize(data.custom_canonical),
      updated_at: new Date().toISOString(),
    })
    .eq('id', productId);

  if (error) {
    throw error;
  }
}

async function persistProductTaxability(
  supabase: SupabaseClient<Database>,
  productId: string,
  isTaxable: boolean
) {
  const { error } = await supabase
    .from('products')
    .update({
      is_taxable: isTaxable,
      updated_at: new Date().toISOString(),
    })
    .eq('id', productId);

  if (error) {
    throw error;
  }
}

/**
 * Persists the scheduled sale (price + window) directly, keyed by SKU so it
 * applies to every product row sharing the SKU — e.g. translations in other
 * languages (`products` is UNIQUE on `(language_id, sku)`, so the same SKU spans
 * languages). A sale belongs to the item (SKU), not a single language row or
 * product id. This also covers the case where the `upsert_product_with_variants`
 * RPC predates these columns (migration 00000000000025) on some databases.
 *
 * Canonical minor-unit sale amounts are read back from the just-saved product
 * row (written by the RPC) and copied across the SKU group; the schedule window
 * comes from the submitted form data. Variant propagation is scoped to the SKU
 * group's products to avoid touching unrelated products that reuse a SKU.
 */
async function persistProductSaleSchedule(
  supabase: SupabaseClient<Database>,
  productId: string,
  data: ProductFormValues
) {
  const now = new Date().toISOString();

  // Canonical (already minor-unit) sale values from the just-saved product row.
  const { data: saved } = await supabase
    .from('products')
    .select('sku, sale_price, sale_prices')
    .eq('id', productId)
    .maybeSingle();
  const sku = saved?.sku ?? data.sku;

  // The SKU group: every product row (any language) that shares this SKU.
  const { data: groupRows } = await supabase
    .from('products')
    .select('id')
    .eq('sku', sku);
  const groupProductIds = (groupRows ?? []).map((row) => row.id);
  if (groupProductIds.length === 0) {
    groupProductIds.push(productId);
  }

  const { error } = await supabase
    .from('products')
    .update({
      sale_price: saved?.sale_price ?? null,
      sale_prices: saved?.sale_prices ?? null,
      sale_start_at: data.sale_start_at ?? null,
      sale_end_at: data.sale_end_at ?? null,
      updated_at: now,
    })
    .in('id', groupProductIds);

  if (error) {
    throw error;
  }

  const variants = data.variants ?? [];
  if (variants.length === 0) {
    return;
  }

  // Canonical variant sale amounts from the just-saved (edited) product variants.
  const { data: variantRows } = await supabase
    .from('product_variants')
    .select('sku, sale_price, sale_prices')
    .eq('product_id', productId);
  const savedVariantBySku = new Map(
    (variantRows ?? []).map((row) => [row.sku, row])
  );

  for (const variant of variants) {
    const savedVariant = savedVariantBySku.get(variant.sku);
    if (!savedVariant) {
      continue;
    }
    const { error: variantError } = await supabase
      .from('product_variants')
      .update({
        sale_price: savedVariant.sale_price ?? null,
        sale_prices: savedVariant.sale_prices ?? null,
        sale_start_at: variant.sale_start_at ?? null,
        sale_end_at: variant.sale_end_at ?? null,
        updated_at: now,
      })
      .eq('sku', variant.sku)
      .in('product_id', groupProductIds);
    if (variantError) {
      throw variantError;
    }
  }
}

export async function getProducts(
  supabase: SupabaseClient<Database>,
  {
    page = 1,
    limit = 10,
    offset,
    search = '',
    languageId,
    categoryId,
    categoryIds,
    productIds,
    translationGroupIds,
    status = 'active',
  }: {
    page?: number;
    /** Rows per page. `0` (or less) returns every match, with no range applied. */
    limit?: number;
    /** Explicit row offset, overriding the one derived from `page`. */
    offset?: number;
    search?: string;
    languageId?: number;
    /** Legacy single-category filter. Superseded by `categoryIds`, which wins when both are set. */
    categoryId?: string;
    /** Products in ANY of these categories. */
    categoryIds?: string[];
    /** Restrict to an explicit set of product ids (hand-picked selections). */
    productIds?: string[];
    /** Restrict to products belonging to these translation groups. */
    translationGroupIds?: string[];
    status?: 'active' | 'draft' | 'archived' | 'all';
  } = {}
) {
  const isPaged = limit > 0;
  const start = typeof offset === 'number' ? Math.max(0, offset) : (page - 1) * limit;
  const end = start + limit - 1;

  let query = supabase
    .from('products')
    .select(
      'id, title, meta_title, meta_description, average_rating, total_reviews, sku, upc, price, prices, sale_price, sale_prices, sale_start_at, sale_end_at, scheduled_price, scheduled_prices, scheduled_price_at, is_taxable, product_type, payment_provider, short_description, stock, status, slug, language_id, translation_group_id, freemius_product_id, freemius_plan_id, trial_period_days, trial_requires_payment_method, product_media(media(file_path, object_key)), product_variants(id, price, prices, sale_price, sale_prices, sale_start_at, sale_end_at, scheduled_price, scheduled_prices, scheduled_price_at), freemius_plans(id, name, title, freemius_pricing(id, license_quota, api_monthly_price, api_annual_price, api_lifetime_price, override_monthly_price, override_annual_price, override_lifetime_price, is_active)), product_categories(category:categories(id, name, slug, description, name_translations, description_translations))',
      { count: 'exact' }
    )
    .order('created_at', { ascending: false });

  // An unlimited caller (limit <= 0) wants every match, so no range is applied.
  if (isPaged) {
    query = query.range(start, end);
  }

  // Storefront reads default to active-only so draft and archived products never
  // appear in public blocks such as the product grid. CMS/admin callers pass
  // status: 'all' to list every product regardless of its publish state.
  if (status !== 'all') {
    query = query.eq('status', status);
  }

  if (languageId) {
    query = query.eq('language_id', languageId);
  }

  if (productIds) {
    if (productIds.length === 0) {
      return { data: [], error: null, count: 0 };
    }
    query = query.in('id', productIds);
  }

  if (translationGroupIds) {
    if (translationGroupIds.length === 0) {
      return { data: [], error: null, count: 0 };
    }
    query = query.in('translation_group_id', translationGroupIds);
  }

  // `categoryIds` is the multi-select form; `categoryId` is the pre-multi-select
  // field kept for blocks saved before it existed.
  const resolvedCategoryIds = categoryIds?.length
    ? categoryIds
    : categoryId
      ? [categoryId]
      : [];

  if (resolvedCategoryIds.length > 0) {
    const { data: productCategoryRows, error: categoryError } = await supabase
      .from('product_categories' as any)
      .select('product_id')
      .in('category_id', resolvedCategoryIds);

    if (categoryError) {
      return { data: [], error: categoryError, count: 0 };
    }

    // A product in two selected categories comes back twice; `.in` needs it once.
    const categoryProductIds = Array.from(
      new Set(
        (productCategoryRows || [])
          .map((row: any) => row.product_id)
          .filter(Boolean)
      )
    );

    if (categoryProductIds.length === 0) {
      return { data: [], error: null, count: 0 };
    }

    query = query.in('id', categoryProductIds);
  }

  if (search) {
    query = query.or(`title.ilike.%${search}%,sku.ilike.%${search}%`);
  }

  return query;
}

export async function getProduct(supabase: SupabaseClient<Database>, id: string) {
  return supabase
    .from('products')
    .select(
      `
      *,
      languages (
        code
      ),
      product_media (
        media_id,
        sort_order,
        media (
          id,
          file_path,
          object_key,
          file_name,
          blur_data_url,
          width,
          height
        )
      ),
      product_variants (
        id,
        sku,
        upc,
        main_media_id,
        price,
        prices,
        sale_price,
        sale_prices,
        sale_start_at,
        sale_end_at,
        scheduled_price,
        scheduled_prices,
        scheduled_price_at,
        stock_quantity,
        media:main_media_id (
          id,
          file_path,
          object_key,
          description
        ),
        variant_attribute_mapping (
          attribute_term_id,
          product_attribute_terms (
            id,
            attribute_id,
            value,
            slug,
            sort_order,
            value_translations,
            product_attributes (
              id,
              name,
              slug,
              name_translations
            )
          )
        )
      ),
      freemius_plans (
        id,
        name,
        title,
        freemius_pricing (
          id,
          license_quota,
          api_monthly_price,
          api_annual_price,
          api_lifetime_price,
          override_monthly_price,
          override_annual_price,
          override_lifetime_price,
          is_active
        )
      ),
      product_categories (
        category:categories (
          id,
          name,
          slug,
          description,
          name_translations,
          description_translations
        )
      )
    `
    )
    .eq('id', id)
    .single();
}

export async function getProductBySlug(
  supabase: SupabaseClient<Database>,
  slug: string,
  preferredLanguageCode?: string
) {
  const { data: products, error } = await supabase
    .from('products')
    .select(
      `
      *,
      languages (
        id,
        code,
        is_default
      ),
      product_media (
        media_id,
        sort_order,
        media (
          id,
          file_path,
          object_key,
          file_name,
          blur_data_url,
          width,
          height,
          variants
        )
      ),
      product_variants (
        id,
        sku,
        upc,
        main_media_id,
        price,
        prices,
        sale_price,
        sale_prices,
        sale_start_at,
        sale_end_at,
        scheduled_price,
        scheduled_prices,
        scheduled_price_at,
        stock_quantity,
        media:main_media_id (
          id,
          file_path,
          object_key,
          description
        ),
        variant_attribute_mapping (
          attribute_term_id,
          product_attribute_terms (
            id,
            attribute_id,
            value,
            slug,
            sort_order,
            value_translations,
            product_attributes (
              id,
              name,
              slug,
              name_translations
            )
          )
        )
      ),
      freemius_plans (
        id,
        name,
        title,
        freemius_pricing (
          id,
          license_quota,
          api_monthly_price,
          api_annual_price,
          api_lifetime_price,
          override_monthly_price,
          override_annual_price,
          override_lifetime_price,
          is_active
        )
      ),
      product_categories (
        category:categories (
          id,
          name,
          slug,
          description,
          name_translations,
          description_translations
        )
      )
    `
    )
    .eq('slug', slug);

  if (error) {
    return { data: null, error };
  }

  if (!products || products.length === 0) {
    return { data: null, error: { message: 'Product not found', code: 'PGRST116' } as any };
  }

  let selectedProduct: any = null;

  if (preferredLanguageCode) {
    selectedProduct = products.find(p => {
      const lang = Array.isArray(p.languages) ? p.languages[0] : p.languages;
      return lang?.code === preferredLanguageCode;
    });
  }

  if (!selectedProduct) {
    // Prefer default language
    selectedProduct = products.find(p => {
      const lang = Array.isArray(p.languages) ? p.languages[0] : p.languages;
      return lang?.is_default;
    });
  }

  if (!selectedProduct) {
    // Fallback to English
    selectedProduct = products.find(p => {
      const lang = Array.isArray(p.languages) ? p.languages[0] : p.languages;
      return lang?.code === 'en';
    });
  }

  if (!selectedProduct) {
    // Fallback to the first available product
    selectedProduct = products[0];
  }

  return { data: selectedProduct, error: null };
}

/** The steps createProduct() runs once the product row exists, each in its own request. */
export const PRODUCT_CREATE_STEPS = ['gallery', 'taxability', 'seo', 'sale_schedule', 'stock', 'categories'] as const;

export type ProductCreateStep = (typeof PRODUCT_CREATE_STEPS)[number];

/** Each step as the notice on the product's edit page names it. */
const PRODUCT_CREATE_STEP_LABELS: Record<ProductCreateStep, string> = {
  gallery: 'images',
  taxability: 'tax setting',
  seo: 'SEO fields',
  sale_schedule: 'sale schedule',
  stock: 'stock',
  categories: 'categories',
};

const PRODUCT_CREATED_INCOMPLETE_ERROR_NAME = 'ProductCreatedIncompleteError';

/**
 * Thrown by createProduct() for a product it created (upsert_product_with_variants committed) when a
 * later step was not saved. Until 2026-11-19 the first such failure was rethrown as it was: the CMS
 * reported a failed create for a product that existed (a second Save then met its slug), and the steps
 * after it never ran, the categories included. The stock write was the likely one: it could deadlock
 * with a publish taking the same SKUs in another order (fixed by migration 02046) and is retried, but
 * any step can fail. Now every step runs, and this names the product and each step that failed.
 */
export class ProductCreatedIncompleteError extends Error {
  readonly productId: string;
  readonly failedSteps: ProductCreateStep[];

  constructor(productId: string, failures: Array<{ step: ProductCreateStep; message: string }>) {
    super(
      `The product was created, but its ${failures.map((failure) => PRODUCT_CREATE_STEP_LABELS[failure.step]).join(', ')} ` +
        `could not be saved: ${failures.map((failure) => `${failure.step}: ${failure.message}`).join('; ')}`
    );
    this.name = PRODUCT_CREATED_INCOMPLETE_ERROR_NAME;
    this.productId = productId;
    this.failedSteps = failures.map((failure) => failure.step);
  }
}

/** A ProductCreatedIncompleteError, by its name and fields (a second copy of this module still counts). */
export function isProductCreatedIncompleteError(error: unknown): error is ProductCreatedIncompleteError {
  return (
    error instanceof Error &&
    error.name === PRODUCT_CREATED_INCOMPLETE_ERROR_NAME &&
    typeof (error as { productId?: unknown }).productId === 'string' &&
    Array.isArray((error as { failedSteps?: unknown }).failedSteps)
  );
}

/**
 * The notice the product's edit page shows when the CMS create sent the editor there with the steps that
 * failed (`?created_incomplete=stock,categories`, ProductCreatedIncompleteError's failedSteps): null when
 * the value names no step this file knows.
 */
export function buildProductCreatedIncompleteNotice(failedSteps: unknown): string | null {
  const steps = (typeof failedSteps === 'string' ? failedSteps.split(',') : []).filter(
    (step, index, list): step is ProductCreateStep =>
      (PRODUCT_CREATE_STEPS as readonly string[]).includes(step) && list.indexOf(step) === index
  );
  if (steps.length === 0) {
    return null;
  }
  const remedy = steps.includes('stock')
    ? ' Set the stock on the Inventory screen; check the rest below, then save.'
    : ' Check them below, then save.';
  return `This product was created, but its ${steps.map((step) => PRODUCT_CREATE_STEP_LABELS[step]).join(', ')} could not be saved.${remedy}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return String(error);
}

/**
 * Creates a product from the form's values: the product row and its variants
 * (`upsert_product_with_variants`, which commits on its own), then the gallery, taxability, SEO fields, the
 * sale schedule, the shared inventory and the categories, each in its own request. A failure of the
 * product RPC throws as it is (nothing was created). From then on the product exists: every step runs,
 * and if one failed this throws ProductCreatedIncompleteError naming the product and the failed steps,
 * never an error that reads as a failed create.
 */
export async function createProduct(supabase: SupabaseClient<Database>, data: ProductFormValues) {
  const { data: productId, error } = await supabase.rpc('upsert_product_with_variants', {
    product_payload: buildProductRpcPayload(data),
  });

  if (error || !productId) throw error || new Error('Failed to create product');

  const failures: Array<{ step: ProductCreateStep; message: string }> = [];
  const attempt = async (step: ProductCreateStep, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (stepError) {
      failures.push({ step, message: errorMessage(stepError) });
    }
  };

  await attempt('gallery', async () => {
    const mediaInserts =
      data.product_media && data.product_media.length > 0
        ? data.product_media.map((item, index) => ({
            product_id: productId,
            media_id: item.media_id,
            sort_order: index,
          }))
        : data.media_id
          ? [{ product_id: productId, media_id: data.media_id, sort_order: 0 }]
          : [];
    if (mediaInserts.length === 0) return;
    const { error: mediaError } = await supabase.from('product_media').insert(mediaInserts);
    if (mediaError) throw mediaError;
  });

  await attempt('taxability', () => persistProductTaxability(supabase, productId, data.is_taxable));

  await attempt('seo', () => persistProductSeoMeta(supabase, productId, data));

  await attempt('sale_schedule', () => persistProductSaleSchedule(supabase, productId, data));

  await attempt('stock', () => syncSharedInventoryForSavedProduct(productId, data));

  if (data.category_ids !== undefined) {
    const categoryIds = data.category_ids;
    await attempt('categories', () => syncCategoriesForTranslationGroup(supabase, productId, categoryIds));
  }

  if (failures.length > 0) {
    throw new ProductCreatedIncompleteError(productId, failures);
  }

  const { data: product } = await supabase.from('products').select('*').eq('id', productId).single();
  return product;
}

type ProductGalleryRow = { product_id: string; media_id: string; sort_order: number };

/**
 * The gallery a save writes, checked before any write: the values' `product_media` as
 * normalizeProductGallery reads it (in order, lowercased, each media id once, uuids only), and only
 * ids that still have a media row. Null when the values carry no gallery (the gallery is then left
 * as it is). The product edit page shows a draft's gallery through the same reading
 * (apps/nextblock/app/cms/products/productFormData.ts, resolveProductDraftGalleryForEdit). An image
 * deleted from the media library while a draft still listed it failed the whole insert on
 * product_media_media_id_fkey, and the old delete-then-insert left the product with no gallery while
 * the save reported success.
 */
async function resolveProductGalleryRows(
  supabase: SupabaseClient<Database>,
  id: string,
  data: ProductFormValues
): Promise<ProductGalleryRow[] | null> {
  const gallery = normalizeProductGallery(data.product_media);
  if (!gallery) return null;

  const orderedIds = gallery.mediaIds;
  if (orderedIds.length === 0) return [];

  const { data: existingMedia, error } = await supabase.from('media').select('id').in('id', orderedIds);
  if (error) throw new Error(`The product's gallery could not be checked: ${error.message}`);

  const existingIds = new Set((existingMedia ?? []).map((row: { id: string }) => row.id));
  return orderedIds
    .filter((mediaId) => existingIds.has(mediaId))
    .map((mediaId, index) => ({ product_id: id, media_id: mediaId, sort_order: index }));
}

/**
 * Writes the gallery: the listed images upserted in their order, then the images it no longer lists
 * unlinked. One statement each, both checked, so a failure throws with the gallery as it was (or
 * with every listed image in it) instead of empty.
 *
 * A product save never deletes media. An image dropped from the gallery stays in the media library
 * with its files, where an editor can delete it once nothing uses it. Until 0.23.4 this function
 * deleted every dropped image that no product, post, logo or variant used, its media row and, on R2,
 * every storage key the row listed. Image blocks, section backgrounds, text blocks and the social
 * image keep their own copy of a key and were never checked, and the ids could come from a draft
 * any WRITER can write over PostgREST (product_drafts RLS checks the role only), so an ADMIN's
 * publish could delete media the ADMIN never saw (security review 2026-11-15).
 */
async function writeProductGallery(supabase: SupabaseClient<Database>, id: string, rows: ProductGalleryRow[] | null) {
  if (rows === null) return;

  if (rows.length > 0) {
    const { error: upsertError } = await supabase.from('product_media').upsert(rows, { onConflict: 'product_id,media_id' });
    if (upsertError) throw new Error(`The product's gallery was not saved: ${upsertError.message}`);
  }

  let unlink = supabase.from('product_media').delete().eq('product_id', id);
  if (rows.length > 0) {
    unlink = unlink.not('media_id', 'in', `(${rows.map((row) => row.media_id).join(',')})`);
  }
  const { error: unlinkError } = await unlink;
  if (unlinkError) throw new Error(`The product's gallery was not saved: ${unlinkError.message}`);
}

/** The largest quantity an inventory row holds (`inventory_items.quantity` is an integer). */
const MAX_STOCK_QUANTITY = 2147483647;

/** A whole number from 0 to 2^31 - 1, as publish_product_draft reads a stock figure or a publish count. */
function isWholeStockNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_STOCK_QUANTITY;
}

/**
 * A draft's `stock_baseline` (the stock the edit page loaded, per SKU) as publish_product_draft
 * (migration 02044) reads it: each SKU as the inventory rows key it (surrounding spaces removed, as
 * Postgres btrim() does), and only whole quantities from 0 to 2^31 - 1, or null: the entry the app's
 * publish sends for a SKU the live product stocks that the draft's baseline lacks (a variant added
 * before the product's last publish), which the function counts from that publish's figure when the
 * baseline predates it (migration 02047) and otherwise reads as no entry. Null when the values carry
 * none (a draft an earlier version saved, a CMS draft import): the publish then writes every SKU's
 * quantity as the draft holds it, as it always did.
 */
function serializeStockBaselineForRpc(baseline: unknown): Record<string, number | null> | null {
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
    return null;
  }

  const serialized: Record<string, number | null> = {};
  for (const [sku, quantity] of Object.entries(baseline as Record<string, unknown>)) {
    const key = sku.replace(/^ +| +$/g, '');
    if (key && (quantity === null || isWholeStockNumber(quantity))) {
      serialized[key] = quantity;
    }
  }
  return serialized;
}

/**
 * The product values a draft publish writes: the `p_values` of `public.publish_product_draft`
 * (migration 02043), which writes all of them, the description blocks, History and the draft delete in
 * one transaction. It is updateProduct()'s RPC payload (amounts in minor units, each variant with its
 * attribute terms and the draft's copy of its id) without `id`, `status` (visibility belongs to the
 * row), `metadata` and `payment_provider` (the function derives it from the product type, as
 * upsert_product_with_variants does), plus what updateProduct() wrote after that RPC: the SEO fields
 * (the function trims them, blank becomes NULL), `gallery_media_ids` (the values' `product_media` ids
 * in order, or null when they carry no gallery, which then stays as it is) and `category_ids` (null
 * when the values carry none). A top-level `media_id` and `explicitly_removed_media_ids` never reach
 * it: a save path never deletes media, and the function only unlinks an image the gallery drops.
 *
 * `stock_baseline` (since migration 02044) is the stock the edit page loaded, per SKU: the function
 * leaves a SKU's inventory alone when the draft's quantity equals that baseline or the SKU's current
 * quantity, and otherwise applies the difference between the quantity and its baseline to the current
 * quantity, never below 0, so a sale made while the page was open keeps its deduction. A SKU the
 * baseline lacks, and every SKU when it is null (no baseline), is written as the values hold it. Its
 * answer's `stock_adjusted` names each SKU whose change went live on a quantity that had moved
 * (`reason` 'moved') or was left out because the quantity already equalled the draft's ('already_live'),
 * which the app's publish turns into a warning.
 *
 * `stock_baseline_publish_count` (since migration 02047) is the product's publish count when the edit
 * page loaded that baseline (whole numbers from 0 only; null without one). Below the product's count,
 * the baseline predates its last publish, and a SKU whose baseline entry is the one that publish used
 * counts from the quantity that publish entered: its answer then names the SKU `already_published` when
 * the draft's quantity is that figure, and marks an entry so counted `from_last_publish`.
 */
export function buildProductDraftPublishValues(data: ProductFormValues) {
  const payload: Record<string, unknown> = { ...buildProductRpcPayload(data) };
  delete payload['id'];
  delete payload['status'];
  delete payload['metadata'];
  delete payload['payment_provider'];

  return {
    ...payload,
    meta_title: data.meta_title ?? null,
    meta_description: data.meta_description ?? null,
    custom_canonical: data.custom_canonical ?? null,
    gallery_media_ids: Array.isArray(data.product_media)
      ? data.product_media
          .map((item) => (item as { media_id?: unknown } | null)?.media_id)
          .filter((mediaId): mediaId is string => typeof mediaId === 'string')
      : null,
    category_ids: Array.isArray(data.category_ids) ? data.category_ids : null,
    stock_baseline: serializeStockBaselineForRpc(data.stock_baseline),
    stock_baseline_publish_count: isWholeStockNumber(data.stock_baseline_publish_count)
      ? data.stock_baseline_publish_count
      : null,
  };
}

export type ProductDraftPublishValues = ReturnType<typeof buildProductDraftPublishValues>;

/**
 * Saves a product's form values: the product row and its variants (`upsert_product_with_variants`),
 * the gallery (only `product_media`; a top-level `media_id` is ignored, the form never writes one),
 * taxability, SEO fields, the sale schedule, shared inventory and categories.
 *
 * Not the publish path: since migration 02043 a product draft publishes through
 * `public.publish_product_draft` (buildProductDraftPublishValues above), in one transaction that keeps
 * variant ids and pending scheduled prices. This function still sends separate requests with no
 * transaction around them, and the RPC deletes and re-creates every variant (new ids, scheduled prices
 * dropped); nothing in the app calls it.
 */
export async function updateProduct(supabase: SupabaseClient<Database>, id: string, data: ProductFormValues) {
  // Checked before the first write, so a gallery that cannot be resolved stops the save untouched.
  const galleryRows = await resolveProductGalleryRows(supabase, id, data);

  const { data: productId, error } = await supabase.rpc('upsert_product_with_variants', {
    product_payload: buildProductRpcPayload(data, id),
  });

  if (error || !productId) throw error || new Error('Failed to update product');

  await writeProductGallery(supabase, id, galleryRows);

  await persistProductTaxability(supabase, productId, data.is_taxable);

  await persistProductSeoMeta(supabase, productId, data);

  await persistProductSaleSchedule(supabase, productId, data);

  await syncSharedInventoryForSavedProduct(productId, data);

  if (data.category_ids !== undefined) {
    await syncCategoriesForTranslationGroup(supabase, id, data.category_ids);
  }

  const { data: product } = await supabase.from('products').select('*').eq('id', productId).single();
  return product;
}

export async function deleteProduct(supabase: SupabaseClient<Database>, id: string) {
  const { error } = await supabase.from('products').delete().eq('id', id);
  if (error) throw error;
  return true;
}

export async function copyProductFromLanguage(
  supabase: SupabaseClient<Database>,
  targetProductId: string,
  sourceProductId: string
) {
  const { data: sourceProduct, error: fetchError } = await supabase
    .from('products')
    .select('*')
    .eq('id', sourceProductId)
    .single();

  if (fetchError || !sourceProduct) {
    throw new Error(fetchError?.message || 'Source product not found');
  }

  const { data: targetProduct, error: targetFetchError } = await supabase
    .from('products')
    .select('language_id')
    .eq('id', targetProductId)
    .single();

  if (targetFetchError || !targetProduct) {
    throw new Error(targetFetchError?.message || 'Target product not found');
  }

  const { error: updateError } = await supabase
    .from('products')
    .update({
      title: sourceProduct.title,
      short_description: sourceProduct.short_description,
      description_json: sourceProduct.description_json,
      // As the product RPC and the Freemius sync do: the sitemap's lastModified reads it, and the
      // visual editor publishes a pre-0.23.4 draft's copy of the title and descriptions only while
      // updated_at is not later than the draft's created_at.
      updated_at: new Date().toISOString(),
    })
    .eq('id', targetProductId);

  if (updateError) throw updateError;

  // Copy product description blocks
  const { data: sourceBlocks, error: blocksError } = await supabase
    .from('blocks')
    .select('*')
    .eq('product_id', sourceProductId)
    .order('order', { ascending: true });

  if (blocksError) throw blocksError;

  await supabase.from('blocks').delete().eq('product_id', targetProductId);

  if (sourceBlocks && sourceBlocks.length > 0) {
    const blocksInserts = sourceBlocks.map(block => {
      // Strip identity/timestamp columns (via rest-spread) so the DB generates
      // fresh ones for the copy; the extracted fields are intentionally discarded.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { id, created_at, updated_at, ...rest } = block;
      return {
        ...rest,
        product_id: targetProductId,
        language_id: targetProduct.language_id,
      };
    });
    const { error: insertError } = await supabase.from('blocks').insert(blocksInserts);
    if (insertError) throw insertError;
  }

  // Clear target draft so that a fresh copy is generated from the newly copied blocks
  await supabase.from('product_drafts').delete().eq('product_id', targetProductId);

  await supabase.from('product_media').delete().eq('product_id', targetProductId);

  const { data: sourceMedia } = await supabase
    .from('product_media')
    .select('media_id, sort_order')
    .eq('product_id', sourceProductId);

  if (sourceMedia && sourceMedia.length > 0) {
    const mediaInserts = sourceMedia.map(sm => ({
      product_id: targetProductId,
      media_id: sm.media_id,
      sort_order: sm.sort_order,
    }));
    await supabase.from('product_media').insert(mediaInserts);
  }

  return { success: true };
}

export async function fetchTranslatedProductsForCartInternal(
  supabase: SupabaseClient,
  translationGroupIds: string[],
  languageCode: string,
  skus: string[] = [],
  productIds: string[] = []
) {
  const { data: language } = await supabase
    .from('languages')
    .select('id')
    .eq('code', languageCode)
    .single();

  if (!language) {
    return { data: [], error: 'Language not found' };
  }

  const filters: string[] = [];
  if (translationGroupIds.length > 0) {
    filters.push(`translation_group_id.in.(${translationGroupIds.join(',')})`);
  }
  if (skus.length > 0) {
    filters.push(`sku.in.(${skus.map(sku => `"${sku}"`).join(',')})`);
  }
  if (productIds.length > 0) {
    filters.push(`id.in.(${productIds.join(',')})`);
  }


  let query = supabase
    .from('products')
    .select(`
      id, 
      title, 
      sku, 
      price,
      prices,
      sale_price,
      sale_prices,
      sale_start_at,
      sale_end_at,
      scheduled_price,
      scheduled_prices,
      scheduled_price_at,
      stock,
      slug,
      language_id,
      product_type,
      payment_provider,
      freemius_product_id,
      freemius_plan_id,
      trial_period_days,
      trial_requires_payment_method,
      is_taxable,
      product_media (
        media (
          file_path,
          object_key
        )
      ),
      product_variants (
        id,
        sku,
        upc,
        main_media_id,
        price,
        prices,
        sale_price,
        sale_prices,
        sale_start_at,
        sale_end_at,
        scheduled_price,
        scheduled_prices,
        scheduled_price_at,
        stock_quantity,
        media:main_media_id (
          file_path,
          object_key,
          description
        ),
        variant_attribute_mapping (
          attribute_term_id,
          product_attribute_terms (
            id,
            attribute_id,
            value,
            slug,
            sort_order,
            value_translations,
            product_attributes (
              id,
              name,
              slug,
              name_translations
            )
          )
        )
      ),
      translation_group_id
    `)
    .eq('language_id', language.id)
    .eq('status', 'active')
    // Scheduled products (a future published_at) stay out of the catalog until
    // their go-live moment. PostgREST ANDs successive `or=` params, so this
    // composes safely with the caller-supplied filters below.
    .or(buildPublishedAtOrFilter());

  if (filters.length > 0) {
    query = query.or(filters.join(','));
  }

  const result = await query.order('id');
  
  return result;
}

export async function syncCategoriesForTranslationGroup(
  supabase: SupabaseClient<Database>,
  productId: string,
  categoryIds: string[]
) {
  const { data: product } = await supabase
    .from('products')
    .select('translation_group_id')
    .eq('id', productId)
    .single();

  if (!product || !product.translation_group_id) {
    await supabase.from('product_categories' as any).delete().eq('product_id', productId);
    if (categoryIds.length > 0) {
      const categoryInserts = categoryIds.map(catId => ({
        product_id: productId,
        category_id: catId,
      }));
      await supabase.from('product_categories' as any).insert(categoryInserts);
    }
    return;
  }

  const { data: siblingProducts } = await supabase
    .from('products')
    .select('id')
    .eq('translation_group_id', product.translation_group_id);

  const siblingIds = siblingProducts && siblingProducts.length > 0
    ? siblingProducts.map((p) => p.id)
    : [productId];

  await supabase
    .from('product_categories' as any)
    .delete()
    .in('product_id', siblingIds);

  if (categoryIds.length > 0) {
    const categoryInserts: any[] = [];
    for (const siblingId of siblingIds) {
      for (const catId of categoryIds) {
        categoryInserts.push({
          product_id: siblingId,
          category_id: catId,
        });
      }
    }
    await supabase.from('product_categories' as any).insert(categoryInserts);
  }
}
