'use server';

import 'server-only';

import { createClient } from '@nextblock-cms/db/server';
import { requireEcomAdmin, requireEcomStaff } from '../../../server-actions/require-ecom-role';
import { ProductFormValues } from '../../../product-schema';
import { toProductGalleryDraftEntries } from '../../../product-gallery';
import {
  createProduct as createProductLib,
  deleteProduct as deleteProductLib,
  isProductCreatedIncompleteError,
  syncCategoriesForTranslationGroup
} from '../../../product-actions';
import { syncProductSaleCouponToFreemius } from '../../../freemius-coupons';
import { normalizeCurrencyRecord } from '../../../currency';
import { sanitizeProductFormValuesForStoreManagedCurrencies } from './product-price-sync';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export async function createProductAction(data: ProductFormValues) {
  // An ADMIN who has passed the enrolled second factor, before anything is read or written. The
  // product RPC checks is_admin(), the role only, which a password alone (aal1) satisfies, and a
  // Freemius product's sale coupon is then pushed with the service role through the developer key
  // pair, which reaches every product of the account. Until 2026-11-13 nothing else checked.
  const serviceClient = await requireEcomAdmin();
  const supabase = createClient();
  const { data: currencies } = await supabase
    .from('currencies')
    .select(
      'code, symbol, exchange_rate, is_default, is_active, auto_sync_product_prices, auto_update_exchange_rate, exchange_rate_source, exchange_rate_updated_at, rounding_mode, rounding_increment, rounding_charm_amount'
    )
    .eq('is_active', true)
    .order('code', { ascending: true });
  const sanitizedData = sanitizeProductFormValuesForStoreManagedCurrencies(
    data,
    (currencies || []).map((currency) => normalizeCurrencyRecord(currency))
  );

  // A product createProduct() created but could not finish (a step after its RPC failed: the stock, the
  // categories...) exists: the editor is sent to it, with a notice naming what to set again, never shown
  // a failed create (the form would offer to create it a second time).
  let productId: string | null = null;
  let failedSteps: string[] = [];
  try {
    const createdProduct = await createProductLib(supabase, sanitizedData);
    productId = createdProduct?.id ?? null;
  } catch (error) {
    if (!isProductCreatedIncompleteError(error)) {
      throw error;
    }
    console.error('[createProductAction] The product was created, but a step after it failed:', error.message);
    productId = error.productId;
    failedSteps = error.failedSteps;
  }

  if (sanitizedData.payment_provider === 'freemius' && productId) {
    try {
      await syncProductSaleCouponToFreemius({
        productId,
        client: serviceClient,
      });
    } catch (couponError) {
      console.error('Failed to sync Freemius sale coupon on create:', couponError);
    }
  }

  revalidatePath('/cms/products');
  redirect(
    productId && failedSteps.length > 0
      ? `/cms/products/${encodeURIComponent(productId)}/edit?created_incomplete=${encodeURIComponent(failedSteps.join(','))}`
      : '/cms/products'
  );
}

/**
 * Stamped on every product-values draft this action writes (0.23.4 and later). The app checks a
 * draft without it, which an earlier version wrote, for the fields the pre-0.23.4 edit page could
 * poison (prices x100, no variants, gallery or description), and never checks one with it. A
 * 'use server' module exports only async functions, so the app keeps its own copy of the literal
 * (PRODUCT_DRAFT_FORM_MARKER_KEY / _VALUE in apps/nextblock/lib/visual-editing/product-draft-meta.ts);
 * product-draft-marker.test.ts there runs this action and fails when the two drift. It never
 * reaches the publish (publish_product_draft) or the products row.
 */
const PRODUCT_DRAFT_FORM_MARKER = { form_version: 2 } as const;

/**
 * Persist the product form's debounced autosave into `product_drafts` without
 * ever overwriting the draft's block snapshot.
 *
 * `product_drafts.blocks` is the working copy the product editor renders (see
 * `app/cms/products/[id]/edit/page.tsx`) and the exact list that publishing
 * writes back over the live `blocks` rows. The column defaults to `'[]'`, so
 * creating the row with a bare upsert made every existing description block
 * vanish from the editor the first time the form autosaved — and deleted them
 * for good on the next publish. Seed the snapshot from the live blocks when the
 * draft is created, and only ever touch `meta` afterwards.
 *
 * The update returns the rows it wrote: none means the draft was deleted after
 * it was read (a publish, which deletes it in the transaction that makes it
 * live, so an autosave that waited on its lock lands here, or a discard in
 * another tab). The values then start a new draft; without the check
 * supabase-js reported the write that matched nothing as saved, and the edit
 * was lost. Their `stock_baseline` is still the one the page loaded before
 * that publish (nothing records which publish a baseline was loaded against)
 * until a save from a page loaded after the publish records the live stock of
 * every SKU the product stocks (the edit page records one for each, a SKU
 * that baseline lacks included). Until then a quantity the publish made live
 * equals the current stock, so the edit page shows it as it is and the next
 * publish leaves it, until the stock moves: after a sale the change is
 * applied again (loaded 5, published 10, one sold: the page shows 14 and the
 * next publish writes it); and a stock typed while the publish ran reads as a
 * change from the older baseline, which the edit page shows applied to the
 * new stock, as the next publish writes it. The edit page names each SKU it
 * shows already live, or applied to a stock that moved at another figure
 * than the draft's, and a publish of the draft as it stands warns of both. A
 * variant added before that publish is in no baseline, so a publish writes
 * its figure as the draft holds it, a sale since included; the edit page
 * shows that figure with no note, and a save from it stores it as a change
 * from the stock it loaded, so a sale made between that publish and that
 * page load stays undone (later ones stay sold).
 */
async function saveProductDraftMeta(
  supabase: ReturnType<typeof createClient>,
  productId: string,
  authorId: string,
  meta: ProductFormValues
) {
  // The gallery as publish will read it: bare `{ media_id }` entries in order, lowercased, each once,
  // uuids only (toProductGalleryDraftEntries). An entry's own `sort_order` or embedded `media`
  // object is never stored: publish ignores both, and the edit page used to show them.
  const productMedia = toProductGalleryDraftEntries(meta.product_media);
  const metaUpdate = {
    author_id: authorId,
    meta: {
      ...meta,
      ...(productMedia ? { product_media: productMedia } : {}),
      ...PRODUCT_DRAFT_FORM_MARKER,
    } as any,
    updated_at: new Date().toISOString(),
  };
  /** Whether the draft row was there to update. */
  const updateExistingDraft = async (): Promise<boolean> => {
    const { data, error } = await supabase
      .from('product_drafts')
      .update(metaUpdate)
      .eq('product_id', productId)
      .select('id');

    if (error) {
      throw new Error(`Failed to save product draft: ${error.message}`);
    }

    return Array.isArray(data) && data.length > 0;
  };

  const { data: existingDraft, error: readError } = await supabase
    .from('product_drafts')
    .select('id')
    .eq('product_id', productId)
    .maybeSingle();

  if (readError) {
    throw new Error(`Failed to read product draft: ${readError.message}`);
  }

  if (existingDraft && (await updateExistingDraft())) {
    return;
  }

  const { data: liveBlocks, error: blocksError } = await supabase
    .from('blocks')
    .select(
      'id, page_id, post_id, product_id, language_id, block_type, content, order, created_at, updated_at'
    )
    .eq('product_id', productId)
    .order('order', { ascending: true });

  if (blocksError) {
    throw new Error(`Failed to read product blocks: ${blocksError.message}`);
  }

  const { error: insertError } = await supabase.from('product_drafts').insert({
    ...metaUpdate,
    blocks: (liveBlocks ?? []) as any,
    product_id: productId,
  });

  if (insertError) {
    // 23505: a concurrent autosave created the draft first. Its snapshot is
    // already seeded, so fall back to a meta-only update rather than failing.
    if (insertError.code === '23505') {
      if (await updateExistingDraft()) {
        return;
      }
      throw new Error(
        'Failed to save product draft: it was published or discarded while this save ran. Edit the form again to save.'
      );
    }

    throw new Error(`Failed to save product draft: ${insertError.message}`);
  }
}

export async function updateProductAction(id: string, data: ProductFormValues) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    throw new Error('User not authenticated.');
  }

  const { data: currencies } = await supabase
    .from('currencies')
    .select(
      'code, symbol, exchange_rate, is_default, is_active, auto_sync_product_prices, auto_update_exchange_rate, exchange_rate_source, exchange_rate_updated_at, rounding_mode, rounding_increment, rounding_charm_amount'
    )
    .eq('is_active', true)
    .order('code', { ascending: true });
  const sanitizedData = sanitizeProductFormValuesForStoreManagedCurrencies(
    data,
    (currencies || []).map((currency) => normalizeCurrencyRecord(currency))
  );

  await saveProductDraftMeta(supabase, id, user.id, sanitizedData);

  // NOTE: do NOT revalidate the edit route here. This is a debounced autosave
  // that only writes a draft; revalidating refetches the page, which resets the
  // form to the saved values and drops an edit typed during the round trip
  // (before 0.23.4 the variations editor also re-dirtied the form after that
  // reset, so the autosave looped). The draft is read fresh on the next real
  // navigation/load, so no revalidation is needed for autosave.
  return { success: true };
}

export async function deleteProductAction(id: string) {
  const supabase = createClient();
  await deleteProductLib(supabase, id);
  revalidatePath('/cms/products');
}

function normalizeProductIds(productIds: string[]) {
  return Array.from(
    new Set(
      productIds
        .map((id) => id.trim())
        .filter(Boolean)
    )
  );
}

export async function bulkDeleteProductsAction(productIds: string[]) {
  const ids = normalizeProductIds(productIds);

  if (ids.length === 0) {
    return { success: false, error: 'Select at least one product.' };
  }

  const supabase = createClient();
  const { error } = await supabase.from('products').delete().in('id', ids);

  if (error) {
    return { success: false, error: error.message };
  }

  revalidatePath('/cms/products');
  return { success: true, count: ids.length };
}

export async function bulkDraftProductsAction(productIds: string[]) {
  const ids = normalizeProductIds(productIds);

  if (ids.length === 0) {
    return { success: false, error: 'Select at least one product.' };
  }

  const supabase = createClient();
  const { error } = await supabase
    .from('products')
    .update({
      status: 'draft',
      updated_at: new Date().toISOString(),
    })
    .in('id', ids);

  if (error) {
    return { success: false, error: error.message };
  }

  revalidatePath('/cms/products');
  return { success: true, count: ids.length };
}

/**
 * Publish a single product directly (status -> "active") so it becomes visible on
 * the storefront. Used by the draft-aware "View Live" button when an admin chooses
 * to publish a still-draft product. A plain status write (mirrors
 * bulkDraftProductsAction) — it does NOT touch variants, prices, or the sale
 * schedule.
 */
export async function publishProductAction(
  productId: string
): Promise<{ error?: string } | void> {
  const id = String(productId || '').trim();
  if (!id) {
    return { error: 'Missing product id.' };
  }

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { error: 'You must be signed in to publish a product.' };
  }

  const { data: product, error } = await supabase
    .from('products')
    .update({
      status: 'active',
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select('slug')
    .single();

  if (error || !product) {
    return { error: error?.message || 'Could not publish the product.' };
  }

  revalidatePath('/cms/products');
  revalidatePath(`/cms/products/${id}/edit`);
  if (product.slug) {
    revalidatePath(`/product/${product.slug}`);
  }
  return {};
}

export async function createProductAttributeAction(input: { name: string; slug?: string }) {
  const supabase = await requireEcomStaff();
  const name = input.name.trim();
  const slug = slugify(input.slug?.trim() || input.name);

  if (!name || !slug) {
    return { success: false, error: 'Attribute name is required.' };
  }

  const { error } = await supabase.from('product_attributes').insert({
    name,
    slug,
  });

  if (error) {
    return { success: false, error: error.message };
  }

  revalidatePath('/cms/products/attributes');
  revalidatePath('/cms/products/new');
  revalidatePath('/cms/products');
  return { success: true };
}

export async function deleteProductAttributeAction(attributeId: string) {
  const supabase = await requireEcomStaff();
  const { error } = await supabase.from('product_attributes').delete().eq('id', attributeId);

  if (error) {
    return { success: false, error: error.message };
  }

  revalidatePath('/cms/products/attributes');
  revalidatePath('/cms/products/new');
  revalidatePath('/cms/products');
  return { success: true };
}

export async function createProductAttributeTermAction(input: {
  attributeId: string;
  value: string;
  slug?: string;
}) {
  const supabase = await requireEcomStaff();
  const value = input.value.trim();
  const slug = slugify(input.slug?.trim() || input.value);

  if (!value || !slug) {
    return { success: false, error: 'Term value is required.' };
  }

  const { data: existingTerms } = await supabase
    .from('product_attribute_terms')
    .select('sort_order')
    .eq('attribute_id', input.attributeId)
    .order('sort_order', { ascending: false })
    .limit(1);

  const nextSortOrder =
    typeof existingTerms?.[0]?.sort_order === 'number' ? existingTerms[0].sort_order + 1 : 0;

  const { error } = await supabase.from('product_attribute_terms').insert({
    attribute_id: input.attributeId,
    value,
    slug,
    sort_order: nextSortOrder,
  });

  if (error) {
    return { success: false, error: error.message };
  }

  revalidatePath('/cms/products/attributes');
  revalidatePath('/cms/products/new');
  revalidatePath('/cms/products');
  return { success: true };
}

export async function reorderProductAttributeTermsAction(input: {
  attributeId: string;
  orderedTermIds: string[];
}) {
  const supabase = await requireEcomStaff();

  for (const [index, termId] of input.orderedTermIds.entries()) {
    const { error } = await supabase
      .from('product_attribute_terms')
      .update({
        sort_order: index,
        updated_at: new Date().toISOString(),
      })
      .eq('id', termId)
      .eq('attribute_id', input.attributeId);

    if (error) {
      return { success: false, error: error.message };
    }
  }

  revalidatePath('/cms/products/attributes');
  revalidatePath('/cms/products/new');
  revalidatePath('/cms/products');
  return { success: true };
}

export async function updateProductAttributeTranslationsAction(input: {
  attributeId: string;
  nameTranslations: Record<string, string>;
  termTranslations: Array<{
    termId: string;
    valueTranslations: Record<string, string>;
  }>;
}) {
  const supabase = await requireEcomStaff();

  const { error: attributeError } = await supabase
    .from('product_attributes')
    .update({
      name_translations: input.nameTranslations,
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.attributeId);

  if (attributeError) {
    return { success: false, error: attributeError.message };
  }

  for (const termTranslation of input.termTranslations) {
    const { error } = await supabase
      .from('product_attribute_terms')
      .update({
        value_translations: termTranslation.valueTranslations,
        updated_at: new Date().toISOString(),
      })
      .eq('id', termTranslation.termId)
      .eq('attribute_id', input.attributeId);

    if (error) {
      return { success: false, error: error.message };
    }
  }

  revalidatePath('/cms/products/attributes');
  revalidatePath('/cms/products/new');
  revalidatePath('/cms/products');
  return { success: true };
}

export async function deleteProductAttributeTermAction(termId: string) {
  const supabase = await requireEcomStaff();
  const { error } = await supabase.from('product_attribute_terms').delete().eq('id', termId);

  if (error) {
    return { success: false, error: error.message };
  }

  revalidatePath('/cms/products/attributes');
  revalidatePath('/cms/products/new');
  revalidatePath('/cms/products');
  return { success: true };
}

export async function createCategoryAction(input: {
  name: string;
  slug?: string;
  description?: string;
  nameTranslations?: Record<string, string>;
  descriptionTranslations?: Record<string, string>;
}) {
  const supabase = await requireEcomStaff();
  const name = input.name.trim();
  const slug = slugify(input.slug?.trim() || input.name);

  if (!name || !slug) {
    return { success: false, error: 'Category name is required.' };
  }

  const { data, error } = await supabase
    .from('categories' as any)
    .insert({
      name,
      slug,
      description: input.description?.trim() || null,
      name_translations: input.nameTranslations || {},
      description_translations: input.descriptionTranslations || {},
    })
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  revalidatePath('/cms/products/categories');
  revalidatePath('/cms/products/new');
  revalidatePath('/cms/products');
  return { success: true, category: data as any };
}

export async function updateCategoryAction(
  id: string,
  input: {
    name: string;
    slug?: string;
    description?: string;
    nameTranslations?: Record<string, string>;
    descriptionTranslations?: Record<string, string>;
  }
) {
  const supabase = await requireEcomStaff();
  const name = input.name.trim();
  const slug = slugify(input.slug?.trim() || input.name);

  if (!name || !slug) {
    return { success: false, error: 'Category name is required.' };
  }

  const { error } = await supabase
    .from('categories' as any)
    .update({
      name,
      slug,
      description: input.description?.trim() || null,
      name_translations: input.nameTranslations || {},
      description_translations: input.descriptionTranslations || {},
    })
    .eq('id', id);

  if (error) {
    return { success: false, error: error.message };
  }

  revalidatePath('/cms/products/categories');
  revalidatePath('/cms/products/new');
  revalidatePath('/cms/products');
  return { success: true };
}

export async function deleteCategoryAction(id: string) {
  const supabase = await requireEcomStaff();
  const { error } = await supabase.from('categories' as any).delete().eq('id', id);

  if (error) {
    return { success: false, error: error.message };
  }

  revalidatePath('/cms/products/categories');
  revalidatePath('/cms/products/new');
  revalidatePath('/cms/products');
  return { success: true };
}

export async function syncProductCategoriesAction(productId: string, categoryIds: string[]) {
  const supabase = await requireEcomStaff();
  
  try {
    await syncCategoriesForTranslationGroup(supabase, productId, categoryIds);
    revalidatePath('/cms/products');
    revalidatePath(`/cms/products/${productId}/edit`);
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

