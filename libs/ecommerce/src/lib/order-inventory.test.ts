import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * applyOrderInventoryDeductionViaSql (the fallback applyOrderInventoryDeduction runs when the RPC fails)
 * runs public.apply_order_inventory_deduction (migration 02046) in its own transaction, so it must take an
 * order's inventory rows the same way: the lines read once (a line read again after a wait could name the
 * SKU a publish gave its variant meanwhile), every row they name taken in SKU order and in one statement
 * (a sale that locked its rows one by one could hold a product row, through the inventory trigger, while
 * it waited for an inventory row another sale or a publish held), then the deduction in one statement.
 * The order of SKUs is the one publish_product_draft locks inventory rows in (02044), and the lines query
 * skips the same SKUs: none, or nothing but spaces (until 2026-11-19 the fallback deducted a SKU of spaces
 * the function skips). tools/scripts/product-draft-publish.db.test.ts runs both paths on a database.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The migration that last replaced public.apply_order_inventory_deduction. */
const MIGRATION = path.resolve(HERE, '../../../db/src/supabase/migrations/02046_inventory_writes_in_sku_order.sql');

/** Whitespace collapsed, case kept (the SQL compared is written the same way in both places). */
const squeeze = (text: string) => text.replace(/\s+/g, ' ').trim();

/** order-inventory.ts with LF line endings (a Windows checkout may have CRLF). */
function fallbackSource(): string {
  return readFileSync(path.join(HERE, 'order-inventory.ts'), 'utf8').replace(/\r\n/g, '\n');
}

/** The fallback's one template literal matching `pattern`. */
function fallbackStatement(pattern: RegExp, label: string): string {
  const statements = [...fallbackSource().matchAll(/`([^`]*)`/g)].map((match) => match[1]).filter((text) => pattern.test(text));
  expect(statements, `one ${label} in order-inventory.ts`).toHaveLength(1);
  return statements[0];
}

/** public.apply_order_inventory_deduction as 02046 replaces it, comments dropped. */
function functionBody(): string {
  const sql = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n').replace(/--[^\n]*/g, '');
  const start = sql.search(/create\s+or\s+replace\s+function\s+public\.apply_order_inventory_deduction\s*\(/i);
  expect(start, '02046 replaces public.apply_order_inventory_deduction').toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('$$;', start));
}

/** The function's statement starting at `marker`, to its semicolon. */
function functionStatement(marker: string): string {
  const body = functionBody();
  const start = body.indexOf(marker);
  expect(start, `the function runs ${marker}`).toBeGreaterThan(-1);
  return body.slice(start, body.indexOf(';', start));
}

/** A fallback statement with its parameters named as the function's variables. */
function asFunctionText(statement: string): string {
  return squeeze(
    statement
      .replace(/\$\{orderId\}/g, 'p_order_id')
      .replace(/\$\{skus\}::text\[\]/g, 'v_skus')
      .replace(/\$\{currentQuantities\}::integer\[\]/g, 'v_current_quantities')
      .replace(/\$\{quantities\}::integer\[\]/g, 'v_quantities')
  );
}

const LINES_ORDER = 'line.sku, line.product_id, line.variant_id';

describe('the order lines applyOrderInventoryDeductionViaSql reads', () => {
  it("are the function's: per (product, variant) the SKU, the stock its variant or product shows and the quantity, read once", () => {
    const fallback = asFunctionText(fallbackStatement(/FROM public\.order_items/, 'query of the order lines'));
    const fn = squeeze(functionStatement('SELECT array_agg(line.sku'));
    // Everything from the subquery to its filter is the same text.
    const filter = "WHERE NULLIF(trim(line.sku), '') IS NOT NULL";
    const from = (text: string) => {
      const start = text.indexOf('FROM ( SELECT order_items.product_id');
      const end = text.indexOf(filter);
      expect(start, 'the lines subquery').toBeGreaterThan(-1);
      expect(end, 'its filter').toBeGreaterThan(start);
      return text.slice(start, end + filter.length);
    };
    expect(from(fallback)).toBe(from(fn));
    expect(from(fn)).toContain('CASE WHEN order_items.variant_id IS NOT NULL THEN v.sku ELSE p.sku END AS sku');
    expect(from(fn)).toContain("WHERE NULLIF(trim(line.sku), '') IS NOT NULL");
  });

  it('come in SKU order, the order publish_product_draft locks inventory rows in, as the function aggregates them', () => {
    const fallback = asFunctionText(fallbackStatement(/FROM public\.order_items/, 'query of the order lines'));
    expect(fallback.endsWith(`ORDER BY ${LINES_ORDER}`)).toBe(true);
    const fn = squeeze(functionStatement('SELECT array_agg(line.sku'));
    for (const column of ['line.sku', 'line.current_quantity', 'line.quantity']) {
      expect(fn).toContain(`array_agg(${column} ORDER BY ${LINES_ORDER})`);
    }
  });
});

describe('the inventory rows applyOrderInventoryDeductionViaSql takes before deducting (migration 02046)', () => {
  it("are the function's statement: every row the lines name, in SKU order, missing ones created, the rest locked", () => {
    const fallback = asFunctionText(fallbackStatement(/INSERT INTO public\.inventory_items AS inventory/, 'statement taking the rows'));
    expect(fallback).toContain('ORDER BY line.sku, line.position ON CONFLICT (sku) DO UPDATE SET quantity = inventory.quantity WHERE false');
    expect(fallback).toBe(squeeze(functionStatement('INSERT INTO public.inventory_items AS inventory')));
  });

  it("then deduct in the function's one statement, never below 0", () => {
    const fallback = asFunctionText(fallbackStatement(/UPDATE public\.inventory_items AS inventory/, 'deduction'));
    expect(fallback).toContain('GREATEST(COALESCE(inventory.quantity, 0) - bought.quantity, 0)');
    expect(fallback).toBe(squeeze(functionStatement('UPDATE public.inventory_items AS inventory')));
  });

  it('read the lines, take the rows, then deduct, in that order, in both', () => {
    const body = functionBody();
    const source = fallbackSource();
    for (const text of [body, source]) {
      const lines = text.indexOf('FROM public.order_items');
      const rows = text.indexOf('INSERT INTO public.inventory_items AS inventory');
      const deduction = text.indexOf('UPDATE public.inventory_items AS inventory');
      expect(lines).toBeGreaterThan(-1);
      expect(rows).toBeGreaterThan(lines);
      expect(deduction).toBeGreaterThan(rows);
    }
    // No other inventory write in the fallback: the per-line reads, inserts and updates are gone.
    expect(source.match(/public\.inventory_items/g)).toHaveLength(2);
  });
});
