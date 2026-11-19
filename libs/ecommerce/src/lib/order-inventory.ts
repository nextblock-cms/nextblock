import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import postgres from 'postgres';
import type { Database } from '@nextblock-cms/db';

import {
  ECOMMERCE_INVENTORY_SETTINGS_KEY,
  normalizeEcommerceInventorySettings,
} from './inventory-settings';

type PostgresSql = postgres.Sql<Record<string, never>>;

function getDirectDatabaseUrl() {
  return process.env.POSTGRES_URL || process.env.DATABASE_URL || null;
}

/**
 * public.apply_order_inventory_deduction (migration 02046) in the app's own transaction, statement for
 * statement: the order row lock and the inventory_deducted_at guard, the track-quantities switch, then
 * three statements (order-inventory.test.ts holds each to the function's):
 *   1. the order's lines, read once: per (product, variant) the SKU it deducts from (its variant's when
 *      variant_id is set, else its product's), the stock that variant or product shows and the quantity
 *      bought, in SKU order, leaving out a SKU that is empty once trim() removes its spaces (until
 *      2026-11-19 this fallback skipped only an empty SKU, and deducted a SKU of spaces the function
 *      skips);
 *   2. every inventory row those SKUs name, in SKU order and in one statement: a missing row created from
 *      that stock, one there locked (ON CONFLICT ... WHERE false writes nothing to it). Each deduction
 *      writes the variant and product rows carrying its SKU (the inventory trigger), so a sale that locked
 *      its rows one by one could hold a product row while it waited for an inventory row another sale or
 *      a publish held, whose trigger waited for that product row;
 *   3. each SKU's total off its row, never below 0, in one statement.
 */
async function applyOrderInventoryDeductionViaSql(orderId: string) {
  const dbUrl = getDirectDatabaseUrl();

  if (!dbUrl) {
    throw new Error('Missing POSTGRES_URL or DATABASE_URL for inventory fallback');
  }

  const db = postgres(dbUrl, {
    ssl: 'require',
    onnotice: () => {
      // Silence Postgres notices during best-effort reconciliation.
    },
  });

  try {
    await db.begin(async (transaction) => {
      const sql = transaction as unknown as PostgresSql;
      const orderRows = await sql<{ inventory_deducted_at: string | null }[]>`
        SELECT inventory_deducted_at
        FROM public.orders
        WHERE id = ${orderId}
        FOR UPDATE
      `;
      const order = orderRows[0];

      if (!order || order.inventory_deducted_at) {
        return;
      }

      const settingRows = await sql<{ value: unknown }[]>`
        SELECT value
        FROM public.site_settings
        WHERE key = ${ECOMMERCE_INVENTORY_SETTINGS_KEY}
        LIMIT 1
      `;
      const trackQuantities = normalizeEcommerceInventorySettings(
        settingRows[0]?.value
      ).trackQuantities;

      if (!trackQuantities) {
        await sql`
          UPDATE public.orders
          SET inventory_deducted_at = now()
          WHERE id = ${orderId}
        `;
        return;
      }

      const lines = await sql<{ sku: string; current_quantity: number; quantity: number }[]>`
        SELECT line.sku, line.current_quantity, line.quantity
          FROM (
            SELECT order_items.product_id,
                   order_items.variant_id,
                   CASE WHEN order_items.variant_id IS NOT NULL THEN v.sku ELSE p.sku END AS sku,
                   CASE
                     WHEN order_items.variant_id IS NOT NULL THEN GREATEST(COALESCE(v.stock_quantity, 0), 0)
                     ELSE GREATEST(COALESCE(p.stock, 0), 0)
                   END AS current_quantity,
                   SUM(order_items.quantity)::integer AS quantity
              FROM public.order_items
              LEFT JOIN public.product_variants v ON v.id = order_items.variant_id
              LEFT JOIN public.products p ON p.id = order_items.product_id
             WHERE order_items.order_id = ${orderId}
             GROUP BY order_items.product_id, order_items.variant_id, v.sku, v.stock_quantity, p.sku, p.stock
          ) AS line
         WHERE NULLIF(trim(line.sku), '') IS NOT NULL
         ORDER BY line.sku, line.product_id, line.variant_id
      `;

      if (lines.length > 0) {
        const skus = lines.map((line) => line.sku);
        const currentQuantities = lines.map((line) => line.current_quantity);
        const quantities = lines.map((line) => line.quantity);

        await sql`
          INSERT INTO public.inventory_items AS inventory (sku, quantity)
          SELECT DISTINCT ON (line.sku) line.sku, line.current_quantity
            FROM unnest(${skus}::text[], ${currentQuantities}::integer[]) WITH ORDINALITY AS line(sku, current_quantity, position)
           ORDER BY line.sku, line.position
              ON CONFLICT (sku) DO UPDATE SET quantity = inventory.quantity WHERE false
        `;

        await sql`
          UPDATE public.inventory_items AS inventory
             SET quantity = GREATEST(COALESCE(inventory.quantity, 0) - bought.quantity, 0),
                 updated_at = now()
            FROM (
              SELECT line.sku, SUM(line.quantity)::integer AS quantity
                FROM unnest(${skus}::text[], ${quantities}::integer[]) AS line(sku, quantity)
               GROUP BY line.sku
            ) AS bought
           WHERE inventory.sku = bought.sku
        `;
      }

      await sql`
        UPDATE public.orders
        SET inventory_deducted_at = now()
        WHERE id = ${orderId}
      `;
    });
  } finally {
    await db.end();
  }
}

export async function applyOrderInventoryDeduction(
  supabase: SupabaseClient<Database>,
  orderId: string
) {
  const { error } = await (supabase as any).rpc('apply_order_inventory_deduction', {
    p_order_id: orderId,
  });

  if (!error) {
    return { method: 'rpc' as const };
  }

  console.error(`[Inventory] RPC deduction failed for order ${orderId}:`, error);

  try {
    await applyOrderInventoryDeductionViaSql(orderId);
    return { method: 'sql-fallback' as const };
  } catch (fallbackError) {
    const fallbackMessage =
      fallbackError instanceof Error ? fallbackError.message : String(fallbackError);

    throw new Error(
      `Failed to reconcile inventory for order ${orderId}. RPC error: ${error.message}. Fallback error: ${fallbackMessage}`
    );
  }
}
