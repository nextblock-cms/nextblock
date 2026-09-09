import type { SupabaseClient } from '@supabase/supabase-js';
import { deleteMediaFiles } from '@nextblock-cms/utils/server';
import type { Database } from '@nextblock-cms/db/types';
import type { ProductFormValues } from './product-schema';
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

function serializeVariantsForRpc(variants?: ProductFormValues['variants']) {
  return (variants || []).map((variant) => ({
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
  }));
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

export async function createProduct(supabase: SupabaseClient<Database>, data: ProductFormValues) {
  const { data: productId, error } = await supabase.rpc('upsert_product_with_variants', {
    product_payload: buildProductRpcPayload(data),
  });

  if (error || !productId) throw error || new Error('Failed to create product');

  if (data.product_media && data.product_media.length > 0) {
      const mediaInserts = data.product_media.map((item, index) => ({
        product_id: productId,
        media_id: item.media_id,
        sort_order: index,
      }));
      await supabase.from('product_media').insert(mediaInserts);
  } else if (data.media_id) {
    await supabase.from('product_media').insert({
      product_id: productId,
      media_id: data.media_id,
      sort_order: 0,
    });
  }

  await persistProductTaxability(supabase, productId, data.is_taxable);

  await persistProductSeoMeta(supabase, productId, data);

  await persistProductSaleSchedule(supabase, productId, data);

  await syncSharedInventoryForSavedProduct(productId, data);

  if (data.category_ids !== undefined) {
    await syncCategoriesForTranslationGroup(supabase, productId, data.category_ids);
  }

  const { data: product } = await supabase.from('products').select('*').eq('id', productId).single();
  return product;
}

export async function updateProduct(supabase: SupabaseClient<Database>, id: string, data: ProductFormValues) {
  const { data: currentProductMedia } = await supabase
    .from('product_media')
    .select('media_id')
    .eq('product_id', id);

  const currentMediaIds = currentProductMedia?.map(pm => pm.media_id) || [];

  const { data: productId, error } = await supabase.rpc('upsert_product_with_variants', {
    product_payload: buildProductRpcPayload(data, id),
  });

  if (error || !productId) throw error || new Error('Failed to update product');

  if (data.product_media) {
    await supabase.from('product_media').delete().eq('product_id', id);
    if (data.product_media.length > 0) {
      const mediaInserts = data.product_media.map((item, index) => ({
        product_id: id,
        media_id: item.media_id,
        sort_order: index,
      }));
      await supabase.from('product_media').insert(mediaInserts);
    }
  } else if (data.media_id) {
     await supabase.from('product_media').delete().eq('product_id', id);
     await supabase.from('product_media').insert({
      product_id: id,
      media_id: data.media_id,
      sort_order: 0,
    });
  }

  await persistProductTaxability(supabase, productId, data.is_taxable);

  await persistProductSeoMeta(supabase, productId, data);

  await persistProductSaleSchedule(supabase, productId, data);

  const newMediaIds = data.product_media
    ? data.product_media.map(m => m.media_id)
    : (data.media_id ? [data.media_id] : []);
    
  const explicitlyRemovedIds = data.explicitly_removed_media_ids || [];
  const calculatedRemovedIds = currentMediaIds.filter(id => !newMediaIds.includes(id));
  const removedMediaIds = Array.from(new Set([...calculatedRemovedIds, ...explicitlyRemovedIds]));
  
  if (removedMediaIds.length > 0) {
    for (const removedId of removedMediaIds) {
      const { count: productUsageCount } = await supabase
        .from('product_media')
        .select('*', { count: 'exact', head: true })
        .eq('media_id', removedId);
      
      if (productUsageCount && productUsageCount > 0) continue;

      const { count: postsUsageCount } = await supabase
          .from('posts')
          .select('*', { count: 'exact', head: true })
          .eq('feature_image_id', removedId);

      if (postsUsageCount && postsUsageCount > 0) continue;

      const { count: logosUsageCount } = await supabase
          .from('logos')
          .select('*', { count: 'exact', head: true })
          .eq('media_id', removedId);
      
      if (logosUsageCount && logosUsageCount > 0) continue;

      const { count: variantUsageCount } = await supabase
        .from('product_variants')
        .select('*', { count: 'exact', head: true })
        .eq('main_media_id', removedId);

      if (variantUsageCount && variantUsageCount > 0) continue;

      const { data: mediaToDelete } = await supabase
        .from('media')
        .select('object_key, variants')
        .eq('id', removedId)
        .single();
      
      if (mediaToDelete) {
         const keysToDelete = [mediaToDelete.object_key];
         if (mediaToDelete.variants && Array.isArray(mediaToDelete.variants)) {
             mediaToDelete.variants.forEach((v: any) => {
                 if (v.objectKey) keysToDelete.push(v.objectKey);
             });
         }
         await deleteMediaFiles(keysToDelete);
         await supabase.from('media').delete().eq('id', removedId);
      }
    }
  }

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
