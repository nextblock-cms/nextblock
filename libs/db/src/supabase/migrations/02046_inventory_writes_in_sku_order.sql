-- 02046: stock writes take inventory rows in SKU order, and the inventory caches sync once per
-- statement. Append-only, forward-only, re-runnable: the inventory trigger replaced (one row-level
-- trigger by three statement-level ones, section 1), three inventory write functions added (section 2),
-- the sale's deduction and the product draft publish replaced (sections 3 and 4), and a backfill of the
-- missing inventory rows (section 5). No table, policy or column change. Closes what 02044 left open
-- ("Not covered", "Not addressed").
--
-- 1. A publish that changes many SKUs. on_inventory_item_change ran public.sync_inventory_cache_for_sku
--    once per inventory row written, and each run summed the variants of every product carrying the SKU
--    again under the caller's row policies, so a publish's cost grew with the square of the SKUs it
--    wrote. Measured 2026-11-19 on a local replay, as the ADMIN through `authenticated`, one product
--    with 500 variants whose stock all changed: beside 50 other products 12 to 16 s, beside 2,000 other
--    products 15 to 27 s, past the Data API's 8 s statement timeout for `authenticated` (57014: nothing
--    written, the draft kept). Without the trigger the same publish took 0.9 to 2 s; with the inventory
--    read policy checking the staff role first, 4.6 s (still a sum per SKU). Now three statement-level
--    triggers (insert, update, delete, each with its transition table) hand the statement's SKUs to
--    private.sync_inventory_caches, which writes each carrier once: the variants with those SKUs, the
--    products without variants with them, and one total per product with a variant carrying one. The same
--    publish: 0.9 to 1.5 s beside 50 products, 1.9 to 2.5 s beside 2,000 (0.6 to 0.8 s with this file
--    applied on an idle machine). It also writes only what changes (a carrier already at the SKU's
--    quantity keeps its row and its updated_at, so it is not locked either, and a publish is no longer
--    refused NBP03 for a write that changed no stock), and it locks the products whose total it writes in
--    id order before reading their variants: two syncs of two SKUs of one product (translations sharing
--    both) took those rows in plan order, and the total read the other SKU's quantity from the
--    statement's snapshot. A product is stamped (updated_at) when its own stock or one of its variants'
--    changes, as 02001 stamped every carrier, and when only its total changes, except for rows a
--    statement inserted: a row created from the stock its carriers show changes only a total the
--    trigger computed while a variant had no row (a repair, not an edit), and stamped, the publish that
--    created such a row refused itself (NBP03). A row inserted at another quantity than a carrier shows
--    stamps that carrier's product, and a sale still trips a publish's NBP03.
--    public.sync_inventory_cache_for_sku stays (nothing calls it now) as a wrapper of the same function.
--
-- 2. Multi-row inventory writers in another order. publish_product_draft and the sale lock inventory
--    rows in SKU order (ORDER BY sku, the column's collation: a JavaScript sort does not reproduce it).
--    upsertInventoryRows in libs/ecommerce sent its rows to PostgREST in the order it was handed:
--    createProduct() writes a new product's variant SKUs in form order (a translation created on the
--    CMS's new-product page carries its source's SKUs), and the Inventory screen writes its missing rows
--    in title order. Cortex's execute_database_mutation inserted or upserted up to 20 rows in the given
--    order, and updated or deleted by filter in plan order. Each could hold a later SKU of a publish while
--    the publish held an earlier one (40P01). Now they write through these functions, which take the rows
--    in SKU order in one statement:
--      * public.upsert_inventory_items(p_rows jsonb, p_on_conflict text): rows { sku, quantity }, each SKU
--        once; p_on_conflict 'update' (an upsert: the quantity), 'nothing' (only the missing rows, the
--        others neither written nor locked) or 'error' (a plain insert: 23505 on an existing row);
--      * public.update_inventory_quantities(p_skus text[], p_quantity integer): one quantity on those
--        rows, locked in SKU order first;
--      * public.delete_inventory_items(p_skus text[]): those rows, locked in SKU order first.
--    All three are SECURITY INVOKER: the inventory_items policies decide (an ADMIN writes, the service
--    role writes, nobody else: their write fails or touches nothing), so they can do nothing a caller
--    could not do over PostgREST, only in SKU order. Each answers the rows it wrote. EXECUTE is revoked
--    from PUBLIC and anon here and in API_ROLE_REVOKE_SQL (both copies), granted to authenticated and
--    service_role.
--
-- 3. Two sales of one product's variants (since 02001). A sale locked each SKU's inventory row as it
--    deducted it, and the row's trigger then wrote the product row, so a sale holding the product row
--    could wait for an inventory row another sale held, whose trigger waited for that product row.
--    public.apply_order_inventory_deduction now reads the order's lines once (each line's SKU as it was
--    when the deduction started), takes every inventory row they name first, in SKU order and in one
--    statement (a missing row is created from the stock its line's variant or product shows, as the loop
--    did; a row there is locked: ON CONFLICT ... DO UPDATE ... WHERE false updates nothing and fires no
--    update trigger, but locks the row), and only then deducts, in one statement, so it never holds a
--    product row while it waits for an inventory row. The app's SQL fallback
--    (applyOrderInventoryDeductionViaSql) runs the same three statements, so it skips the same SKUs too:
--    one that is empty once trim() removes its spaces (until now the fallback deducted a SKU of spaces
--    that the function skips).
--
-- 4. A SKU with no inventory row when a publish starts. The publish locked only the rows that existed,
--    and its values helper created the missing ones last, so a sale that created such a row (its first
--    sale) and then waited for a row the publish held deadlocked with it. publish_product_draft now takes
--    its rows in one statement too: every SKU a sale could deduct of the products whose rows it can write
--    (each variant's, and a product's own without variants, as stored) is created when it is missing and
--    locked when it is there, and every other SKU of 02044's set is locked when it has a row (never
--    created: a parent SKU of a product with variants, a SKU only the values carry). A row created there
--    holds this product's stock as the values helper reads it (its first variant with the SKU, else its
--    own stock), so the plan reads what it read before, or the least stock of the other products carrying
--    it (as the Inventory screen creates one). It changes no carrier of this product, so the sync leaves
--    this product's updated_at as it is (section 1) and the row never trips the publish's own NBP03.
--    Everything else is 02044's, statement for statement.
--
-- 5. The backfill: every SKU a sale could deduct (each variant's, and a product's own without variants,
--    as stored, blank ones aside) gets the inventory row it lacks, holding the least stock its carriers
--    show, in one statement, so section 4 rarely needs to create one. Rows that exist are not touched.
--
-- Still not covered: a SKU another session adds to one of a publish's products between the publish's read
-- of them and its locks; two writers creating the same new SKU at once (a publish adding a variant whose
-- SKU a new product takes at the same moment); writers of products or variant rows that take several
-- rows in another order (Cortex's execute_database_mutation on products or product_variants); cycles
-- through other sessions. The database aborts one transaction of such a cycle (40P01), which writes
-- nothing; createProduct() retries its stock write and reports a product it created but could not finish
-- as created (libs/ecommerce product-actions.ts).
--
-- tools/scripts/product-draft-publish.db.test.ts runs these: the triggers' shape and a 500-SKU publish
-- beside 2,000 products under the 8 s timeout, the caches every kind of write leaves (variants, a product
-- without variants, totals, a delete, a statement that changes nothing, an insert that repairs a total
-- unstamped, one at another figure stamped so a publish that read before it refuses), each writer in
-- SKU order against a held row, two sales of one product's variants, a first
-- sale against a publish of a SKU with no row, the backfill, and the SQL fallback's SKU of spaces; without
-- a database, it holds section 4 to 02044's text but its one statement, and section 3 to its three steps.
-- libs/ecommerce order-inventory.test.ts holds the SQL fallback to section 3's statements, and
-- tools/scripts/migration-replay.db.test.ts replays every file over a migrated database.

CREATE SCHEMA IF NOT EXISTS private;

-- ---------------------------------------------------------------------------
-- 1. The inventory caches, synced once per statement
-- ---------------------------------------------------------------------------
-- 02001's sync_inventory_cache_for_sku for a set of SKUs, in three statements: each SKU's quantity (0
-- without a row, as for a deleted one) to the variants carrying it and to the products without variants
-- carrying it; then each product with a variant carrying one takes the total of its variants' rows, held
-- at 2147483647 (02044). A carrier already at its value is left out (not written, not locked). The
-- products whose total it writes are locked in id order first, and the totals read after that lock.
-- Stamps: a product whose own stock changes (a product without variants), or one of whose variants'
-- stock changes, gets updated_at = now(), as 02001 stamped every carrier. A product whose only change
-- is its total is stamped too unless `p_stamp_products` is false, which the trigger passes for the rows
-- a statement inserted: a row created from the stock its carriers already show (a sale's first one, a
-- kept SKU at publish, the Inventory screen's and section 5's backfills) changes no carrier's own stock,
-- only a total the trigger computed while a variant had no row, a repair rather than an edit; stamped,
-- it made the publish that created the row refuse itself (NBP03). A row inserted at another quantity
-- than a carrier shows (the Inventory screen or Cortex creating a row for a carried SKU) changes that
-- carrier and stamps its product. SECURITY INVOKER: the caller's row policies, as 02001's (an ADMIN or
-- the service role; anyone else cannot write inventory_items).
CREATE OR REPLACE FUNCTION private.sync_inventory_caches(p_skus text[], p_stamp_products boolean DEFAULT true)
    RETURNS void
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path TO ''
    AS $$
DECLARE
  v_skus text[];
  v_changed_products uuid[];
BEGIN
  SELECT array_agg(DISTINCT s.sku)
    INTO v_skus
    FROM unnest(p_skus) AS s(sku)
   WHERE NULLIF(trim(s.sku), '') IS NOT NULL;

  IF v_skus IS NULL THEN
    RETURN;
  END IF;

  WITH changed AS (
    UPDATE public.product_variants AS v
       SET stock_quantity = COALESCE(i.quantity, 0),
           updated_at = now()
      FROM unnest(v_skus) AS s(sku)
      LEFT JOIN public.inventory_items AS i ON i.sku = s.sku
     WHERE v.sku = s.sku
       AND v.stock_quantity IS DISTINCT FROM COALESCE(i.quantity, 0)
    RETURNING v.product_id
  )
  SELECT COALESCE(array_agg(DISTINCT changed.product_id), '{}')
    INTO v_changed_products
    FROM changed;

  UPDATE public.products AS p
     SET stock = COALESCE(i.quantity, 0),
         updated_at = now()
    FROM unnest(v_skus) AS s(sku)
    LEFT JOIN public.inventory_items AS i ON i.sku = s.sku
   WHERE p.sku = s.sku
     AND NOT EXISTS (SELECT 1 FROM public.product_variants AS v WHERE v.product_id = p.id)
     AND p.stock IS DISTINCT FROM COALESCE(i.quantity, 0);

  PERFORM 1
     FROM public.products AS p
    WHERE p.id IN (SELECT v.product_id FROM public.product_variants AS v WHERE v.sku = ANY (v_skus))
    ORDER BY p.id
      FOR UPDATE;

  UPDATE public.products AS p
     SET stock = totals.total,
         updated_at = CASE WHEN p_stamp_products OR p.id = ANY (v_changed_products) THEN now() ELSE p.updated_at END
    FROM (
      SELECT v.product_id,
             LEAST(COALESCE(SUM(COALESCE(i.quantity, 0)), 0), 2147483647)::integer AS total
        FROM public.product_variants AS v
        LEFT JOIN public.inventory_items AS i ON i.sku = v.sku
       WHERE v.product_id IN (SELECT c.product_id FROM public.product_variants AS c WHERE c.sku = ANY (v_skus))
       GROUP BY v.product_id
    ) AS totals
   WHERE p.id = totals.product_id
     AND (p.stock IS DISTINCT FROM totals.total OR p.id = ANY (v_changed_products));
END;
$$;

REVOKE ALL ON FUNCTION private.sync_inventory_caches(text[], boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.sync_inventory_caches(text[], boolean) TO authenticated, service_role;

-- The statement's SKUs: the rows it inserted or updated (any column, as stored after the update), or the
-- rows it deleted. A statement that wrote no row syncs nothing. For inserted rows a product whose only
-- change is its total keeps its updated_at (see private.sync_inventory_caches).
CREATE OR REPLACE FUNCTION public.handle_inventory_items_sync()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
  v_skus text[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT array_agg(o.sku) INTO v_skus FROM old_rows AS o;
  ELSE
    SELECT array_agg(n.sku) INTO v_skus FROM new_rows AS n;
  END IF;

  PERFORM private.sync_inventory_caches(v_skus, TG_OP <> 'INSERT');
  RETURN NULL;
END;
$$;

-- A transition table needs a trigger per event. public.handle_inventory_item_change (02001's row-level
-- function) stays: 02003 names it, and a replay creates that trigger again before this file drops it.
DROP TRIGGER IF EXISTS on_inventory_item_change ON public.inventory_items;

DROP TRIGGER IF EXISTS on_inventory_items_inserted ON public.inventory_items;
CREATE TRIGGER on_inventory_items_inserted
  AFTER INSERT ON public.inventory_items
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.handle_inventory_items_sync();

DROP TRIGGER IF EXISTS on_inventory_items_updated ON public.inventory_items;
CREATE TRIGGER on_inventory_items_updated
  AFTER UPDATE ON public.inventory_items
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.handle_inventory_items_sync();

DROP TRIGGER IF EXISTS on_inventory_items_deleted ON public.inventory_items;
CREATE TRIGGER on_inventory_items_deleted
  AFTER DELETE ON public.inventory_items
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.handle_inventory_items_sync();

-- Replaced, not dropped: the signature and the grants stay.
CREATE OR REPLACE FUNCTION public.sync_inventory_cache_for_sku(p_sku text) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  PERFORM private.sync_inventory_caches(ARRAY[p_sku]);
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Inventory writes in SKU order
-- ---------------------------------------------------------------------------
-- `p_rows`: a list of { "sku": text, "quantity": whole number }, nothing else, each SKU once (a blank
-- SKU, a missing quantity or another key is refused, 22023; a repeated SKU 21000). The SKU is written
-- as given (upsertInventoryRows trims its own). The rows are taken in SKU order in one statement.
CREATE OR REPLACE FUNCTION public.upsert_inventory_items(p_rows jsonb, p_on_conflict text DEFAULT 'update')
    RETURNS SETOF public.inventory_items
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path TO ''
    AS $$
DECLARE
  v_row record;
  v_repeated text;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'The inventory rows are not a list.' USING ERRCODE = '22023';
  END IF;
  IF p_on_conflict IS NULL OR p_on_conflict NOT IN ('update', 'nothing', 'error') THEN
    RAISE EXCEPTION 'The conflict rule is ''update'', ''nothing'' or ''error'', not %.', COALESCE(p_on_conflict, 'null')
      USING ERRCODE = '22023';
  END IF;

  FOR v_row IN
    SELECT item.value, item.ordinality FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS item(value, ordinality)
  LOOP
    IF jsonb_typeof(v_row.value) <> 'object' THEN
      RAISE EXCEPTION 'Inventory row % is not an object.', v_row.ordinality USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_row.value->'sku') IS DISTINCT FROM 'string' OR NULLIF(trim(v_row.value->>'sku'), '') IS NULL THEN
      RAISE EXCEPTION 'Inventory row % has no SKU.', v_row.ordinality USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_row.value->'quantity') IS NULL OR jsonb_typeof(v_row.value->'quantity') = 'null' THEN
      RAISE EXCEPTION 'Inventory row % (%) has no quantity.', v_row.ordinality, v_row.value->>'sku' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_row.value) AS k(key) WHERE k.key NOT IN ('sku', 'quantity')) THEN
      RAISE EXCEPTION 'Inventory row % (%) sets more than a SKU and a quantity.', v_row.ordinality, v_row.value->>'sku'
        USING ERRCODE = '22023';
    END IF;
  END LOOP;

  SELECT item.value->>'sku'
    INTO v_repeated
    FROM jsonb_array_elements(p_rows) AS item(value)
   GROUP BY item.value->>'sku'
  HAVING count(*) > 1
   LIMIT 1;
  IF v_repeated IS NOT NULL THEN
    RAISE EXCEPTION 'SKU % appears more than once.', v_repeated USING ERRCODE = '21000';
  END IF;

  IF p_on_conflict = 'update' THEN
    RETURN QUERY
    INSERT INTO public.inventory_items AS inventory (sku, quantity)
    SELECT item.value->>'sku', (item.value->>'quantity')::integer
      FROM jsonb_array_elements(p_rows) AS item(value)
     ORDER BY item.value->>'sku'
        ON CONFLICT (sku) DO UPDATE SET quantity = EXCLUDED.quantity
    RETURNING inventory.*;
  ELSIF p_on_conflict = 'nothing' THEN
    RETURN QUERY
    INSERT INTO public.inventory_items AS inventory (sku, quantity)
    SELECT item.value->>'sku', (item.value->>'quantity')::integer
      FROM jsonb_array_elements(p_rows) AS item(value)
     ORDER BY item.value->>'sku'
        ON CONFLICT (sku) DO NOTHING
    RETURNING inventory.*;
  ELSE
    RETURN QUERY
    INSERT INTO public.inventory_items AS inventory (sku, quantity)
    SELECT item.value->>'sku', (item.value->>'quantity')::integer
      FROM jsonb_array_elements(p_rows) AS item(value)
     ORDER BY item.value->>'sku'
    RETURNING inventory.*;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_inventory_items(jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_inventory_items(jsonb, text) TO authenticated, service_role;

-- One quantity on the rows of `p_skus` (as stored), locked in SKU order before the update. A SKU
-- without a row is skipped.
CREATE OR REPLACE FUNCTION public.update_inventory_quantities(p_skus text[], p_quantity integer)
    RETURNS SETOF public.inventory_items
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path TO ''
    AS $$
BEGIN
  IF p_skus IS NULL THEN
    RAISE EXCEPTION 'No SKUs to update.' USING ERRCODE = '22023';
  END IF;
  IF p_quantity IS NULL THEN
    RAISE EXCEPTION 'No quantity to set.' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
     FROM public.inventory_items AS inventory
    WHERE inventory.sku = ANY (p_skus)
    ORDER BY inventory.sku
      FOR UPDATE;

  RETURN QUERY
  UPDATE public.inventory_items AS inventory
     SET quantity = p_quantity
   WHERE inventory.sku = ANY (p_skus)
  RETURNING inventory.*;
END;
$$;

REVOKE ALL ON FUNCTION public.update_inventory_quantities(text[], integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_inventory_quantities(text[], integer) TO authenticated, service_role;

-- The rows of `p_skus` (as stored), locked in SKU order before the delete. A SKU without a row is skipped.
CREATE OR REPLACE FUNCTION public.delete_inventory_items(p_skus text[])
    RETURNS SETOF public.inventory_items
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path TO ''
    AS $$
BEGIN
  IF p_skus IS NULL THEN
    RAISE EXCEPTION 'No SKUs to delete.' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
     FROM public.inventory_items AS inventory
    WHERE inventory.sku = ANY (p_skus)
    ORDER BY inventory.sku
      FOR UPDATE;

  RETURN QUERY
  DELETE FROM public.inventory_items AS inventory
   WHERE inventory.sku = ANY (p_skus)
  RETURNING inventory.*;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_inventory_items(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_inventory_items(text[]) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. The sale's deduction: the order's lines read once, its inventory rows taken first
-- ---------------------------------------------------------------------------
-- 02044's public.apply_order_inventory_deduction (the order row lock, the inventory_deducted_at guard, the
-- track-quantities switch, a line's SKU: its variant's when variant_id is set, else its product's, skipped
-- when trim() leaves it empty), in three steps instead of a loop that read, locked and deducted each line
-- in turn:
--   1. the order's lines are read once: per (product, variant), the SKU, the stock its variant or product
--      shows and the quantity bought, in SKU order (02044's order). Read once, the SKUs are the ones the
--      lines had when the deduction started: a line read again after a wait (a publish that dropped or
--      renamed its variant meanwhile) gave the parent's SKU or the new one;
--   2. one statement takes every row those SKUs name, in SKU order (see the header);
--   3. one statement deducts each SKU's total from its row, never below 0 (the rows are held, so
--      nothing waits; 02044 deducted line by line, which ends the same).
-- Replaced, not dropped: the signature, the attributes (invoker, search_path) and the grants stay. The
-- app's SQL fallback (applyOrderInventoryDeductionViaSql) runs the same three statements.
CREATE OR REPLACE FUNCTION public.apply_order_inventory_deduction(p_order_id uuid) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  v_track_quantities boolean := public.get_ecommerce_track_quantities();
  v_inventory_deducted_at timestamptz;
  v_skus text[];
  v_current_quantities integer[];
  v_quantities integer[];
BEGIN
  SELECT inventory_deducted_at
    INTO v_inventory_deducted_at
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND OR v_inventory_deducted_at IS NOT NULL THEN
    RETURN;
  END IF;

  IF NOT v_track_quantities THEN
    UPDATE public.orders
    SET inventory_deducted_at = now()
    WHERE id = p_order_id;

    RETURN;
  END IF;

  SELECT array_agg(line.sku ORDER BY line.sku, line.product_id, line.variant_id),
         array_agg(line.current_quantity ORDER BY line.sku, line.product_id, line.variant_id),
         array_agg(line.quantity ORDER BY line.sku, line.product_id, line.variant_id)
    INTO v_skus, v_current_quantities, v_quantities
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
       WHERE order_items.order_id = p_order_id
       GROUP BY order_items.product_id, order_items.variant_id, v.sku, v.stock_quantity, p.sku, p.stock
    ) AS line
   WHERE NULLIF(trim(line.sku), '') IS NOT NULL;

  IF v_skus IS NOT NULL THEN
    INSERT INTO public.inventory_items AS inventory (sku, quantity)
    SELECT DISTINCT ON (line.sku) line.sku, line.current_quantity
      FROM unnest(v_skus, v_current_quantities) WITH ORDINALITY AS line(sku, current_quantity, position)
     ORDER BY line.sku, line.position
        ON CONFLICT (sku) DO UPDATE SET quantity = inventory.quantity WHERE false;

    UPDATE public.inventory_items AS inventory
       SET quantity = GREATEST(COALESCE(inventory.quantity, 0) - bought.quantity, 0),
           updated_at = now()
      FROM (
        SELECT line.sku, SUM(line.quantity)::integer AS quantity
          FROM unnest(v_skus, v_quantities) AS line(sku, quantity)
         GROUP BY line.sku
      ) AS bought
     WHERE inventory.sku = bought.sku;
  END IF;

  UPDATE public.orders
  SET inventory_deducted_at = now()
  WHERE id = p_order_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. The publish: its inventory rows taken in one statement, missing ones created
-- ---------------------------------------------------------------------------
-- 02044's public.publish_product_draft, statement for statement, but the statement that takes the
-- inventory rows (see the header). Replaced, not dropped: the signature, the return type, the
-- attributes and the grants stay, and so does its entry in API_ROLE_REVOKE_SQL.
CREATE OR REPLACE FUNCTION public.publish_product_draft(
    p_product_id uuid,
    p_draft_id bigint,
    p_draft_updated_at timestamp with time zone,
    p_product_updated_at timestamp with time zone,
    p_values jsonb,
    p_overlay jsonb,
    p_blocks jsonb
)
    RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path TO ''
    AS $$
DECLARE
  v_product public.products%ROWTYPE;
  v_draft public.product_drafts%ROWTYPE;
  v_before jsonb;
  v_after jsonb;
  v_revision jsonb;
  v_values_result jsonb;
  v_slug text;
  v_payment_provider text;
  v_value_variants jsonb;
  v_stock_skus text[];
  v_stock_products uuid[];
BEGIN
  IF NOT COALESCE(public.is_admin(), false) THEN
    RAISE EXCEPTION 'Only an administrator can publish products.' USING ERRCODE = '42501';
  END IF;

  IF p_values IS NOT NULL AND jsonb_typeof(p_values) <> 'object' THEN
    RAISE EXCEPTION 'The product values to publish are not an object.' USING ERRCODE = 'NBP04';
  END IF;
  IF p_overlay IS NOT NULL AND jsonb_typeof(p_overlay) <> 'object' THEN
    RAISE EXCEPTION 'The fields to publish are not an object.' USING ERRCODE = 'NBP04';
  END IF;
  IF p_values IS NOT NULL AND p_overlay IS NOT NULL AND p_overlay <> '{}'::jsonb THEN
    RAISE EXCEPTION 'A publish writes product values or overlay fields, not both.' USING ERRCODE = 'NBP04';
  END IF;
  IF p_blocks IS NULL OR jsonb_typeof(p_blocks) <> 'array' THEN
    RAISE EXCEPTION 'The description blocks to publish are not a list.' USING ERRCODE = 'NBP04';
  END IF;

  -- Inventory rows, before the products row and in SKU order (02044's set): one statement creates the
  -- missing row of each SKU a sale could deduct of those products (a variant's, or a product's own
  -- without variants, as stored) and locks every row of the set that is there. A SKU of the set no sale
  -- deducts (a parent SKU, one only the values carry) is locked when it has a row and never created.
  -- ON CONFLICT ... DO UPDATE ... WHERE false writes nothing to an existing row and fires no update
  -- trigger, but locks it. A row it creates holds this product's own stock for this product's SKUs, so
  -- its sync (at the end of the statement) changes no carrier of this product and leaves its updated_at
  -- as it is (02046 section 1): the product check below is not tripped by it.
  IF p_values IS NOT NULL THEN
    v_value_variants := COALESCE(p_values->'variants', '[]'::jsonb);
    IF jsonb_typeof(v_value_variants) = 'array' THEN
      v_stock_skus := ARRAY(
        SELECT value_sku.sku
          FROM (
            SELECT btrim(item.value->>'sku') FROM jsonb_array_elements(v_value_variants) AS item(value)
            UNION
            SELECT btrim(p_values->>'sku') WHERE jsonb_array_length(v_value_variants) = 0
          ) AS value_sku(sku)
         WHERE value_sku.sku <> ''
      );
      v_stock_products := ARRAY(
        SELECT p_product_id
        UNION
        SELECT p.id FROM public.products p WHERE p.sku = p_values->>'sku'
        UNION
        SELECT v.product_id FROM public.product_variants v WHERE v.sku = ANY (v_stock_skus)
      );
      v_stock_skus := v_stock_skus || ARRAY(
        SELECT p.sku FROM public.products p WHERE p.id = ANY (v_stock_products) AND btrim(p.sku) <> ''
        UNION
        SELECT v.sku FROM public.product_variants v WHERE v.product_id = ANY (v_stock_products) AND btrim(v.sku) <> ''
      );
      INSERT INTO public.inventory_items AS inventory (sku, quantity)
      SELECT slot.sku, slot.quantity
        FROM (
          SELECT DISTINCT ON (candidate.sku) candidate.sku, candidate.quantity
            FROM (
              SELECT v.sku, GREATEST(COALESCE(v.stock_quantity, 0), 0) AS quantity,
                     v.product_id = p_product_id AS own, v.created_at, v.id
                FROM public.product_variants v
               WHERE v.product_id = ANY (v_stock_products)
              UNION ALL
              SELECT p.sku, GREATEST(COALESCE(p.stock, 0), 0), p.id = p_product_id, p.created_at, p.id
                FROM public.products p
               WHERE p.id = ANY (v_stock_products)
                 AND NOT EXISTS (SELECT 1 FROM public.product_variants v WHERE v.product_id = p.id)
              UNION ALL
              SELECT i.sku, i.quantity, false, NULL::timestamp with time zone, NULL::uuid
                FROM public.inventory_items i
               WHERE i.sku = ANY (v_stock_skus)
            ) AS candidate
           WHERE btrim(candidate.sku) <> ''
           -- A missing row of this product's SKU holds this product's stock as the values helper reads it
           -- (its first variant with the SKU, else its own stock), so the plan reads what it read before
           -- this file; one only other products carry holds the least of theirs.
           ORDER BY candidate.sku,
                    candidate.own DESC,
                    CASE WHEN candidate.own THEN candidate.created_at END,
                    CASE WHEN candidate.own THEN candidate.id END,
                    candidate.quantity
        ) AS slot
       ORDER BY slot.sku
          ON CONFLICT (sku) DO UPDATE SET quantity = inventory.quantity WHERE false;
    END IF;
  END IF;

  -- The products row first, then the draft row, in every publish: two publishes queue here, and the
  -- second finds the draft gone.
  SELECT * INTO v_product FROM public.products WHERE id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product not found.' USING ERRCODE = 'NBP05';
  END IF;

  SELECT * INTO v_draft FROM public.product_drafts WHERE product_id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No draft exists for this product.' USING ERRCODE = 'NBP01';
  END IF;
  IF v_draft.id IS DISTINCT FROM p_draft_id OR v_draft.updated_at IS DISTINCT FROM p_draft_updated_at THEN
    RAISE EXCEPTION 'The draft changed after it was read.' USING ERRCODE = 'NBP02';
  END IF;
  IF v_product.updated_at IS DISTINCT FROM p_product_updated_at THEN
    RAISE EXCEPTION 'The product changed after it was read.' USING ERRCODE = 'NBP03';
  END IF;

  v_before := public.product_revision_content(p_product_id);

  IF p_values IS NOT NULL THEN
    v_values_result := private.apply_product_draft_values(p_product_id, p_values);
  ELSIF p_overlay IS NOT NULL AND (p_overlay ? 'title' OR p_overlay ? 'short_description' OR p_overlay ? 'description_json') THEN
    UPDATE public.products
       SET title = CASE WHEN p_overlay ? 'title' THEN p_overlay->>'title' ELSE title END,
           short_description = CASE WHEN p_overlay ? 'short_description' THEN p_overlay->>'short_description' ELSE short_description END,
           description_json = CASE
             WHEN p_overlay ? 'description_json' THEN NULLIF(p_overlay->'description_json', 'null'::jsonb)
             ELSE description_json
           END,
           updated_at = now()
     WHERE id = p_product_id;
  END IF;

  DELETE FROM public.blocks WHERE product_id = p_product_id;

  INSERT INTO public.blocks (page_id, post_id, product_id, language_id, block_type, content, "order")
  SELECT NULL,
         NULL,
         p_product_id,
         (b.value->>'language_id')::bigint,
         b.value->>'block_type',
         NULLIF(b.value->'content', 'null'::jsonb),
         COALESCE((b.value->>'order')::integer, (b.ordinality - 1)::integer)
    FROM jsonb_array_elements(p_blocks) WITH ORDINALITY AS b(value, ordinality)
   ORDER BY b.ordinality;

  v_after := public.product_revision_content(p_product_id);
  v_revision := private.record_product_revision(p_product_id, v_before, v_after);

  DELETE FROM public.product_drafts WHERE id = v_draft.id;

  SELECT p.slug, p.payment_provider INTO v_slug, v_payment_provider FROM public.products p WHERE p.id = p_product_id;

  RETURN jsonb_build_object(
    'product_id', p_product_id,
    'previous_slug', v_product.slug,
    'slug', v_slug,
    'payment_provider', v_payment_provider,
    'wrote_values', p_values IS NOT NULL,
    'stock_adjusted', COALESCE(v_values_result->'stock_adjusted', '[]'::jsonb),
    'revision', v_revision
  );
END;
$$;

REVOKE ALL ON FUNCTION public.publish_product_draft(uuid, bigint, timestamp with time zone, timestamp with time zone, jsonb, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.publish_product_draft(uuid, bigint, timestamp with time zone, timestamp with time zone, jsonb, jsonb, jsonb) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Backfill: every SKU a sale could deduct gets its inventory row
-- ---------------------------------------------------------------------------
-- Each variant's SKU and the SKU of each product without variants, as stored, blank ones aside, that has
-- no row: one holding the least stock its carriers show (as the Inventory screen creates one), in SKU
-- order, in one statement (section 1 then syncs their carriers once). A row that exists is not touched.
INSERT INTO public.inventory_items (sku, quantity)
SELECT missing.sku, missing.quantity
  FROM (
    SELECT carrier.sku, MIN(carrier.quantity) AS quantity
      FROM (
        SELECT v.sku, GREATEST(COALESCE(v.stock_quantity, 0), 0) AS quantity
          FROM public.product_variants v
        UNION ALL
        SELECT p.sku, GREATEST(COALESCE(p.stock, 0), 0)
          FROM public.products p
         WHERE NOT EXISTS (SELECT 1 FROM public.product_variants v WHERE v.product_id = p.id)
      ) AS carrier
     WHERE NULLIF(trim(carrier.sku), '') IS NOT NULL
     GROUP BY carrier.sku
  ) AS missing
 WHERE NOT EXISTS (SELECT 1 FROM public.inventory_items i WHERE i.sku = missing.sku)
 ORDER BY missing.sku
    ON CONFLICT (sku) DO NOTHING;
