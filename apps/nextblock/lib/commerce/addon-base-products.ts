import 'server-only';

import { headers } from 'next/headers';
import { cache } from 'react';
import { getProducts } from '@nextblock-cms/ecommerce/product-actions';
import type { Product } from '@nextblock-cms/ecommerce/types';
import { getSsgSupabaseClient } from '@nextblock-cms/db/server';
import { getAddonBaseFreemiusProductIds } from '@nextblock-cms/utils/nextblock-packages';

import { mapProductRowToUiProduct } from '../blocks/product-grid-data';

/**
 * The store products that sell the packages an add-on license requires (Commerce Pro, which the
 * Affiliates add-on needs), one per package, in the page's language when that translation is active,
 * else in another: the product page, the cart and the checkout name them in their add-on notices,
 * where the cart and the checkout also offer an add button (libs/ecommerce product-addons.ts).
 *
 * Only a store carrying NextBlock's own license products has these Freemius products (nextblock.dev,
 * and the public sandbox, whose reset imports them); anywhere else this is one small read that finds
 * nothing. A failed read is no notice button, never a broken page.
 */
export const loadAddonBaseProducts = cache(async (languageId?: number | null): Promise<Product[]> => {
  const freemiusProductIds = getAddonBaseFreemiusProductIds();
  if (freemiusProductIds.length === 0) return [];

  try {
    const supabase = getSsgSupabaseClient();
    const { data: rows, error } = await supabase
      .from('products')
      .select('id, language_id, freemius_product_id')
      .in('freemius_product_id', freemiusProductIds)
      .eq('status', 'active')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });
    if (error || !rows?.length) return [];

    const productIds: string[] = [];
    for (const freemiusProductId of freemiusProductIds) {
      const candidates = rows.filter((row) => row.freemius_product_id === freemiusProductId);
      const chosen = candidates.find((row) => typeof languageId === 'number' && row.language_id === languageId) ?? candidates[0];
      if (chosen) productIds.push(String(chosen.id));
    }
    if (productIds.length === 0) return [];

    const { data: productRows, error: productsError } = await getProducts(supabase, {
      productIds,
      limit: productIds.length,
    });
    if (productsError) return [];
    return ((productRows ?? []) as unknown[]).map(mapProductRowToUiProduct);
  } catch (error) {
    console.error('[Commerce] Could not load the products add-on licenses require:', error);
    return [];
  }
});

/**
 * loadAddonBaseProducts for a route outside the block renderers (`/cart`, `/checkout`), in the
 * visitor's language: the `x-user-locale` header proxy.ts sets, matched to a `languages` row. No
 * header or no such language reads any translation.
 */
export async function loadAddonBaseProductsForRequest(): Promise<Product[]> {
  let languageId: number | null = null;
  try {
    const locale = (await headers()).get('x-user-locale');
    if (locale) {
      const { data } = await getSsgSupabaseClient().from('languages').select('id').eq('code', locale).maybeSingle();
      if (data && typeof data.id === 'number') languageId = data.id;
    }
  } catch {
    /* outside a request, or the languages read failed: any translation */
  }
  return loadAddonBaseProducts(languageId);
}
