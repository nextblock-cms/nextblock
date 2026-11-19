import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@nextblock-cms/db/types';
import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';

import type { ProductFormValues } from './product-schema';

export type InventoryUsageType = 'product' | 'variant' | 'mixed';

export interface InventoryItem {
  key: string;
  sku: string;
  stock: number;
  usageType: InventoryUsageType;
  productTitles: string[];
  parentProductSkus: string[];
  languages: string[];
  statuses: string[];
  productIds: string[];
  variantIds: string[];
}

interface InventoryQuantityUpdateInput {
  sku: string;
  stock: number;
}

type RawInventoryProductRow = {
  id: string;
  title: string;
  sku: string;
  stock: number | null;
  status: string;
  languages?: { code?: string | null } | Array<{ code?: string | null }> | null;
  product_variants?: Array<{
    id: string;
    sku: string;
    stock_quantity: number | null;
  }> | null;
};

type InventoryUsageDraft = {
  sku: string;
  stockFallback: number;
  usageType: InventoryUsageType;
  productTitles: Set<string>;
  parentProductSkus: Set<string>;
  languages: Set<string>;
  statuses: Set<string>;
  productIds: Set<string>;
  variantIds: Set<string>;
};

function getInventoryClient(client?: SupabaseClient<Database>) {
  return client ?? getServiceRoleSupabaseClient();
}

function normalizeLanguageCodes(
  value: RawInventoryProductRow['languages']
): string[] {
  if (!value) {
    return [];
  }

  const entries = Array.isArray(value) ? value : [value];

  return entries
    .map((entry) => entry?.code?.toUpperCase().trim())
    .filter((entry): entry is string => Boolean(entry));
}

function uniqueSorted(values: Iterable<string>) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function mergeUsageType(
  currentType: InventoryUsageType | undefined,
  nextType: 'product' | 'variant'
): InventoryUsageType {
  if (!currentType || currentType === nextType) {
    return nextType;
  }

  return 'mixed';
}

/**
 * What an inventory write does to a SKU that already has a row: 'update' sets its quantity, 'nothing'
 * leaves it as it is (only the missing rows are created).
 */
type InventoryConflictRule = 'update' | 'nothing';

/** Postgres answers for a write that lost a lock race and wrote nothing: a deadlock, a serialization failure, a lock timeout. */
const RETRIED_INVENTORY_WRITE_CODES = new Set(['40P01', '40001', '55P03']);
const INVENTORY_WRITE_ATTEMPTS = 3;
const INVENTORY_WRITE_RETRY_DELAY_MS = 40;

/** The function of migration 02046 is unknown: PostgREST's schema cache lacks it (PGRST202) or Postgres does (42883). */
function isMissingInventoryWriteFunction(error: { code?: string | null } | null | undefined) {
  return error?.code === 'PGRST202' || error?.code === '42883';
}

function inventoryWriteError(error: { message?: string | null; code?: string | null }) {
  return Object.assign(new Error(error.message || 'The inventory rows were not saved.'), {
    code: error.code ?? undefined,
  });
}

/**
 * Writes inventory rows through public.upsert_inventory_items (migration 02046), which takes them in SKU
 * order in one statement: the order publish_product_draft and a sale's deduction lock inventory rows in
 * (the sku column's collation, which a JavaScript sort does not reproduce, so the database sorts). Sent
 * to PostgREST as a list they were written in the order given (a new product's variants in form order,
 * the Inventory screen's missing rows in title order), and a write that held a later SKU of a publish
 * while the publish held an earlier one deadlocked with it (40P01). Each SKU is trimmed and written once
 * (the last quantity given wins), a blank one is skipped, and quantities are whole numbers from 0.
 *
 * A write that lost a lock race wrote nothing, and the same rows again are the same write, so it is
 * tried up to INVENTORY_WRITE_ATTEMPTS times. A database without 02046 gets the PostgREST upsert of
 * 0.23.6 and earlier, in the order given.
 */
async function upsertInventoryRows(
  supabase: SupabaseClient<Database>,
  rows: Array<{ sku: string; quantity: number }>,
  onConflict: InventoryConflictRule = 'update'
) {
  const normalizedRows = Array.from(
    rows.reduce<Map<string, { sku: string; quantity: number }>>((accumulator, row) => {
      const sku = row.sku.trim();

      if (!sku) {
        return accumulator;
      }

      accumulator.set(sku, {
        sku,
        quantity: Math.max(0, Math.trunc(row.quantity)),
      });
      return accumulator;
    }, new Map()).values()
  );

  if (normalizedRows.length === 0) {
    return;
  }

  for (let attempt = 1; ; attempt += 1) {
    const { error } = await (supabase as any).rpc('upsert_inventory_items', {
      p_rows: normalizedRows,
      p_on_conflict: onConflict,
    });

    if (!error) {
      return;
    }

    if (isMissingInventoryWriteFunction(error)) {
      const { error: tableError } = await (supabase as any)
        .from('inventory_items')
        .upsert(normalizedRows, { onConflict: 'sku', ignoreDuplicates: onConflict === 'nothing' });

      if (tableError) {
        throw inventoryWriteError(tableError);
      }
      return;
    }

    if (attempt >= INVENTORY_WRITE_ATTEMPTS || !RETRIED_INVENTORY_WRITE_CODES.has(error.code)) {
      throw inventoryWriteError(error);
    }

    await new Promise((resolve) => setTimeout(resolve, INVENTORY_WRITE_RETRY_DELAY_MS * attempt));
  }
}

async function getInventoryQuantitiesBySku(
  supabase: SupabaseClient<Database>,
  skus: string[]
) {
  const uniqueSkus = uniqueSorted(
    skus.map((sku) => sku.trim()).filter(Boolean)
  );

  if (uniqueSkus.length === 0) {
    return new Map<string, number>();
  }

  const { data, error } = await (supabase as any)
    .from('inventory_items')
    .select('sku, quantity')
    .in('sku', uniqueSkus);

  if (error) {
    throw new Error(error.message);
  }

  return new Map<string, number>(
    (data || []).map((row: { sku: string; quantity: number | null }) => [
      row.sku,
      Math.max(0, row.quantity ?? 0),
    ])
  );
}

async function buildInventoryUsageMap(
  supabase: SupabaseClient<Database>
) {
  const { data, error } = await (supabase as any)
    .from('products')
    .select(
      `
      id,
      title,
      sku,
      stock,
      status,
      languages (
        code
      ),
      product_variants (
        id,
        sku,
        stock_quantity
      )
    `
    )
    .order('title', { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  const usageMap = new Map<string, InventoryUsageDraft>();

  const registerUsage = (
    sku: string,
    usageKind: 'product' | 'variant',
    stockFallback: number,
    product: RawInventoryProductRow,
    variantId?: string
  ) => {
    const normalizedSku = sku.trim();

    if (!normalizedSku) {
      return;
    }

    const languageCodes = normalizeLanguageCodes(product.languages);
    const existing = usageMap.get(normalizedSku);

    if (existing) {
      existing.usageType = mergeUsageType(existing.usageType, usageKind);
      existing.stockFallback = Math.min(existing.stockFallback, stockFallback);
      existing.productTitles.add(product.title);
      existing.parentProductSkus.add(product.sku);
      existing.languages = new Set([...existing.languages, ...languageCodes]);
      existing.statuses.add(product.status);
      existing.productIds.add(product.id);

      if (variantId) {
        existing.variantIds.add(variantId);
      }

      return;
    }

    usageMap.set(normalizedSku, {
      sku: normalizedSku,
      stockFallback,
      usageType: usageKind,
      productTitles: new Set([product.title]),
      parentProductSkus: new Set([product.sku]),
      languages: new Set(languageCodes),
      statuses: new Set([product.status]),
      productIds: new Set([product.id]),
      variantIds: variantId ? new Set([variantId]) : new Set<string>(),
    });
  };

  for (const product of (data || []) as RawInventoryProductRow[]) {
    const variants = product.product_variants || [];

    if (variants.length > 0) {
      for (const variant of variants) {
        registerUsage(
          variant.sku,
          'variant',
          Math.max(0, variant.stock_quantity ?? 0),
          product,
          variant.id
        );
      }

      continue;
    }

    registerUsage(
      product.sku,
      'product',
      Math.max(0, product.stock ?? 0),
      product
    );
  }

  return usageMap;
}

export async function getInventoryItems(client?: SupabaseClient<Database>) {
  const supabase = getInventoryClient(client);
  const usageMap = await buildInventoryUsageMap(supabase);
  const usedSkus = [...usageMap.keys()];

  if (usedSkus.length === 0) {
    return [];
  }

  let inventoryBySku = await getInventoryQuantitiesBySku(supabase, usedSkus);
  const missingRows = usedSkus
    .filter((sku) => !inventoryBySku.has(sku))
    .flatMap((sku) => {
      const usage = usageMap.get(sku);

      if (!usage) {
        return [];
      }

      return [
        {
          sku,
          quantity: usage.stockFallback,
        },
      ];
    });

  if (missingRows.length > 0) {
    // Only the rows still missing: one a sale or a publish created since the read above keeps its
    // quantity (an upsert set it back to the fallback read before it).
    await upsertInventoryRows(supabase, missingRows, 'nothing');
    inventoryBySku = await getInventoryQuantitiesBySku(supabase, usedSkus);
  }

  return usedSkus
    .flatMap((sku) => {
      const usage = usageMap.get(sku);

      if (!usage) {
        return [];
      }

      return {
        key: sku,
        sku,
        stock: inventoryBySku.get(sku) ?? usage.stockFallback,
        usageType: usage.usageType,
        productTitles: uniqueSorted(usage.productTitles),
        parentProductSkus: uniqueSorted(usage.parentProductSkus),
        languages: uniqueSorted(usage.languages),
        statuses: uniqueSorted(usage.statuses),
        productIds: uniqueSorted(usage.productIds),
        variantIds: uniqueSorted(usage.variantIds),
      } satisfies InventoryItem;
    })
    .sort((left, right) => {
      return (
        left.sku.localeCompare(right.sku) ||
        left.usageType.localeCompare(right.usageType) ||
        left.productTitles.join(', ').localeCompare(right.productTitles.join(', '))
      );
    });
}

export async function setSharedInventoryQuantity(
  input: InventoryQuantityUpdateInput,
  client?: SupabaseClient<Database>
) {
  const supabase = getInventoryClient(client);
  const sku = input.sku.trim();
  const stock = Math.max(0, Math.trunc(input.stock));

  if (!sku) {
    throw new Error('SKU is required to update inventory.');
  }

  await upsertInventoryRows(supabase, [{ sku, quantity: stock }]);

  const usageMap = await buildInventoryUsageMap(supabase);
  const usage = usageMap.get(sku);
  const affectedCount = (usage?.productIds.size ?? 0) + (usage?.variantIds.size ?? 0);

  return { stock, affectedCount };
}

export async function syncSharedInventoryForSavedProduct(
  productId: string,
  data: Pick<ProductFormValues, 'sku' | 'stock' | 'variants'>,
  client?: SupabaseClient<Database>
) {
  const supabase = getInventoryClient(client);
  void productId;

  if (data.variants && data.variants.length > 0) {
    const variantRows = Array.from(
      data.variants.reduce<Map<string, number>>((accumulator, variant) => {
        accumulator.set(
          variant.sku.trim(),
          Math.max(0, Math.trunc(variant.stock_quantity))
        );
        return accumulator;
      }, new Map()).entries()
    ).map(([sku, quantity]) => ({ sku, quantity }));

    await upsertInventoryRows(supabase, variantRows);
    return;
  }

  await upsertInventoryRows(supabase, [
    {
      sku: data.sku,
      quantity: Math.max(0, Math.trunc(data.stock)),
    },
  ]);
}
