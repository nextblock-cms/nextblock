import 'server-only';

import { cache } from 'react';
import { unstable_cache } from 'next/cache';
import { getSsgSupabaseClient } from '@nextblock-cms/db/server';
import { getProducts } from '@nextblock-cms/ecommerce/server';
import type { Product } from '@nextblock-cms/ecommerce/types';
import { mapProductRowToUiProduct } from '../blocks/product-grid-data';
import { AFFILIATE_PUBLIC_READ_REVALIDATE_SECONDS } from './storefront-data';

/**
 * The catalog products a partner storefront shows, resolved the way the product grid block resolves
 * hand-picked products (lib/blocks/product-grid-data.ts): through the ANON client, so only what the
 * public may see comes back (RLS: `status = 'active'` and a go-live time that has passed; `getProducts`
 * also filters `status = 'active'`), then each pick swapped for its translation in the visitor's
 * language through its translation group (the pick itself when there is no translation yet).
 *
 * The ids come from the approved storefront document, so they are untrusted: they are checked as
 * uuids, de-duplicated and capped before any query, and an id that resolves to nothing is simply
 * absent from the result (an archived or deleted product disappears from the storefront).
 */

/** The sanitizer allows 24 distinct products per page; featured ids are a subset. */
export const AFFILIATE_STOREFRONT_MAX_PRODUCTS = 48;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LoadAffiliateStorefrontProductsInput {
  productIds: readonly unknown[];
  /** The visitor's site language (`languages.code`); products are swapped to it when translated. */
  locale: string | null | undefined;
}

interface StorefrontLanguage {
  id: number;
  code: string;
}

type ProductRow = {
  id: string;
  language_id: number | null;
  translation_group_id: string | null;
} & Record<string, unknown>;

/** Valid, lowercase, de-duplicated product ids in their original order, at most the cap. */
export function normalizeAffiliateStorefrontProductIds(productIds: readonly unknown[] | null | undefined): string[] {
  const ids: string[] = [];
  for (const entry of productIds ?? []) {
    if (typeof entry !== 'string' || !UUID_PATTERN.test(entry.trim())) continue;
    const id = entry.trim().toLowerCase();
    if (!ids.includes(id)) ids.push(id);
    if (ids.length >= AFFILIATE_STOREFRONT_MAX_PRODUCTS) break;
  }
  return ids;
}

const getCachedStorefrontLanguages = unstable_cache(
  async (): Promise<StorefrontLanguage[]> => {
    const { data, error } = await getSsgSupabaseClient().from('languages').select('id, code, is_active');
    if (error) throw new Error('AffiliateStorefrontLanguagesReadFailed');
    return (Array.isArray(data) ? data : [])
      .filter(
        (row: { id: unknown; code: unknown; is_active: unknown }) =>
          typeof row.id === 'number' && typeof row.code === 'string' && row.is_active !== false,
      )
      .map((row: { id: number; code: string }) => ({ id: row.id, code: row.code.trim().toLowerCase() }));
  },
  ['affiliates-storefront-languages'],
  { revalidate: AFFILIATE_PUBLIC_READ_REVALIDATE_SECONDS },
);

/** The `languages.id` for a site locale (exact code first, then its base language), or null. */
export const resolveAffiliateStorefrontLanguageId = cache(async (locale: string | null | undefined): Promise<number | null> => {
  const code = typeof locale === 'string' ? locale.trim().toLowerCase() : '';
  if (!code) return null;
  let languages: StorefrontLanguage[];
  try {
    languages = await getCachedStorefrontLanguages();
  } catch {
    return null;
  }
  const base = code.split(/[-_]/)[0] ?? code;
  return (
    languages.find((language) => language.code === code)?.id ??
    languages.find((language) => language.code === base)?.id ??
    null
  );
});

function asProductRows(value: unknown): ProductRow[] {
  return (Array.isArray(value) ? value : []).filter(
    (row): row is ProductRow => Boolean(row) && typeof (row as { id?: unknown }).id === 'string',
  );
}

/**
 * `Map<requested id, Product>` for the ids a storefront asks for (keys are the ids as the document
 * names them, lowercased; values may be the translation in the visitor's language). Never throws:
 * a failed read yields an empty map and the grids render nothing.
 */
export async function loadAffiliateStorefrontProducts(
  input: LoadAffiliateStorefrontProductsInput,
): Promise<Map<string, Product>> {
  const products = new Map<string, Product>();
  const ids = normalizeAffiliateStorefrontProductIds(input.productIds);
  if (ids.length === 0) return products;

  try {
    const supabase = getSsgSupabaseClient();
    const [languageId, picked] = await Promise.all([
      resolveAffiliateStorefrontLanguageId(input.locale),
      getProducts(supabase, { productIds: ids, limit: ids.length }),
    ]);
    if (picked.error) {
      console.error('[affiliates] Storefront products read failed:', picked.error.message);
      return products;
    }

    const rows = asProductRows(picked.data);
    const rowById = new Map(rows.map((row) => [String(row.id).toLowerCase(), row]));

    // Selections are made in one language; swap each pick for its translation when the visitor
    // reads another one (falling back to the pick itself when it has not been translated yet).
    const translatedByGroup = new Map<string, ProductRow>();
    if (languageId !== null && rows.some((row) => row.language_id !== languageId)) {
      const groupIds = [
        ...new Set(
          rows
            .filter((row) => row.language_id !== languageId)
            .map((row) => row.translation_group_id)
            .filter((groupId): groupId is string => typeof groupId === 'string' && groupId !== ''),
        ),
      ];
      if (groupIds.length > 0) {
        const translated = await getProducts(supabase, {
          translationGroupIds: groupIds,
          languageId,
          limit: groupIds.length,
        });
        if (!translated.error) {
          for (const row of asProductRows(translated.data)) {
            if (row.translation_group_id) translatedByGroup.set(row.translation_group_id, row);
          }
        }
      }
    }

    for (const id of ids) {
      const row = rowById.get(id);
      if (!row) continue;
      const shown =
        languageId !== null && row.language_id !== languageId && row.translation_group_id
          ? translatedByGroup.get(row.translation_group_id) ?? row
          : row;
      products.set(id, mapProductRowToUiProduct(shown));
    }
  } catch (error) {
    console.error('[affiliates] Storefront products read failed:', error instanceof Error ? error.message : String(error));
    return new Map();
  }

  return products;
}
