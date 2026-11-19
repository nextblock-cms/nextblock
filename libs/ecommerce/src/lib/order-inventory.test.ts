import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * applyOrderInventoryDeductionViaSql (the fallback applyOrderInventoryDeduction runs when the RPC fails)
 * runs the steps of public.apply_order_inventory_deduction in its own transaction, so it must take an
 * order's SKUs in the same order: the order of the SKU each line locks, which publish_product_draft
 * locks inventory rows in too (migration 02044). In GROUP BY order a deduction holding a later SKU and
 * waiting for an earlier one deadlocked with a publish, or with another deduction taking them the other
 * way round. tools/scripts/product-draft-publish.db.test.ts runs both paths on a database.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(HERE, '../../../db/src/supabase/migrations/02044_product_draft_publish_stock_baseline.sql');

/** Whitespace collapsed, case kept (the SQL compared is written the same way in both places). */
const squeeze = (text: string) => text.replace(/\s+/g, ' ').trim();

/** The fallback's query of the order's lines: the template literal reading public.order_items grouped by line. */
function fallbackLinesQuery(): string {
  const source = readFileSync(path.join(HERE, 'order-inventory.ts'), 'utf8');
  const queries = [...source.matchAll(/`([^`]*)`/g)].map((match) => match[1]).filter((text) => /FROM public\.order_items/.test(text));
  expect(queries, 'one query of public.order_items in order-inventory.ts').toHaveLength(1);
  return queries[0];
}

/** public.apply_order_inventory_deduction as 02044 replaces it, comments dropped. */
function functionLinesQuery(): string {
  const sql = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n').replace(/--[^\n]*/g, '');
  const start = sql.search(/create\s+or\s+replace\s+function\s+public\.apply_order_inventory_deduction\s*\(/i);
  expect(start, '02044 replaces public.apply_order_inventory_deduction').toBeGreaterThan(-1);
  const body = sql.slice(start, sql.indexOf('$$;', start));
  const loop = body.match(/FOR v_item IN([\s\S]*?)\n\s*LOOP\b/);
  expect(loop, 'the function loops over the order lines').not.toBeNull();
  return (loop as RegExpMatchArray)[1];
}

/** The ORDER BY clause of a lines query, to its end. */
function orderBy(query: string): string {
  const at = query.search(/\bORDER BY\b/);
  return at === -1 ? '' : squeeze(query.slice(at));
}

const BY_LOCKED_SKU =
  'ORDER BY CASE WHEN order_items.variant_id IS NOT NULL THEN (SELECT v.sku FROM public.product_variants v WHERE v.id = order_items.variant_id) ' +
  'ELSE (SELECT p.sku FROM public.products p WHERE p.id = order_items.product_id) END, product_id, variant_id';

describe('the order lines applyOrderInventoryDeductionViaSql deducts', () => {
  it("come in the order of the SKU each line locks (the variant's when variant_id is set, else the product's)", () => {
    const query = squeeze(fallbackLinesQuery());
    expect(query).toContain('GROUP BY product_id, variant_id ORDER BY');
    expect(orderBy(fallbackLinesQuery())).toBe(BY_LOCKED_SKU);
  });

  it('come in the order public.apply_order_inventory_deduction takes them since 02044, so the RPC and its fallback lock alike', () => {
    expect(orderBy(functionLinesQuery())).toBe(BY_LOCKED_SKU);
    expect(squeeze(fallbackLinesQuery()).replace(/\$\{orderId\}/, 'p_order_id')).toBe(squeeze(functionLinesQuery()));
  });
});
