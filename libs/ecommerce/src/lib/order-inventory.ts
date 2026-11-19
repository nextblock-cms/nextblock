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

      // The lines in the order of the SKU each one locks below (the variant's when variant_id is set,
      // else the product's), as apply_order_inventory_deduction takes them since migration 02044 and
      // publish_product_draft locks inventory rows: two writers taking the same SKUs in one order never
      // hold each other's next row (order-inventory.test.ts holds this query to the function's).
      const orderItems = await sql<
        {
          product_id: string | null;
          variant_id: string | null;
          quantity: number;
        }[]
      >`
        SELECT
          product_id,
          variant_id,
          SUM(quantity)::integer AS quantity
        FROM public.order_items
        WHERE order_id = ${orderId}
        GROUP BY product_id, variant_id
        ORDER BY CASE
                   WHEN order_items.variant_id IS NOT NULL
                     THEN (SELECT v.sku FROM public.product_variants v WHERE v.id = order_items.variant_id)
                   ELSE (SELECT p.sku FROM public.products p WHERE p.id = order_items.product_id)
                 END,
                 product_id,
                 variant_id
      `;

      for (const item of orderItems) {
        if (item.variant_id) {
          const variantRows = await sql<
            {
              sku: string | null;
              stock_quantity: number | null;
            }[]
          >`
            SELECT
              sku,
              stock_quantity
            FROM public.product_variants
            WHERE id = ${item.variant_id}
            LIMIT 1
          `;
          const variant = variantRows[0];

          if (!variant?.sku) {
            continue;
          }

          await sql`
            INSERT INTO public.inventory_items (sku, quantity)
            VALUES (${variant.sku}, ${Math.max(0, variant.stock_quantity ?? 0)})
            ON CONFLICT (sku) DO NOTHING
          `;

          await sql`
            UPDATE public.inventory_items
            SET
              quantity = GREATEST(COALESCE(quantity, 0) - ${item.quantity}, 0),
              updated_at = now()
            WHERE sku = ${variant.sku}
          `;

          continue;
        }

        if (item.product_id) {
          const productRows = await sql<
            {
              sku: string | null;
              stock: number | null;
            }[]
          >`
            SELECT
              sku,
              stock
            FROM public.products
            WHERE id = ${item.product_id}
            LIMIT 1
          `;
          const product = productRows[0];

          if (!product?.sku) {
            continue;
          }

          await sql`
            INSERT INTO public.inventory_items (sku, quantity)
            VALUES (${product.sku}, ${Math.max(0, product.stock ?? 0)})
            ON CONFLICT (sku) DO NOTHING
          `;

          await sql`
            UPDATE public.inventory_items
            SET
              quantity = GREATEST(COALESCE(quantity, 0) - ${item.quantity}, 0),
              updated_at = now()
            WHERE sku = ${product.sku}
          `;
        }
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
