-- 02047: a product draft's stock baseline says which publish it was loaded against.
-- Append-only, forward-only, re-runnable: one table (public.product_stock_publishes, with its row policies
-- and grants) and one function replaced (private.apply_product_draft_values), no data change.
--
-- 02044 applies the editor's stock change (the draft's quantity minus its `stock_baseline`, the stock the
-- edit page loaded, per SKU) to the SKU's current stock. A draft started again after a publish (an
-- autosave queued behind it, or a tab opened before it, found the draft gone and saved the form's values
-- into a new one) still carries the baseline from before that publish, and nothing said so:
--   * once the stock moved after that publish, the change was applied again: loaded 5, typed 10 and
--     published, one sold, then the same values published 14 (02044 left the SKU alone only while the
--     stock still equalled the published figure, `already_live`);
--   * a figure typed while the publish ran read as a change from the older baseline: 10 published from a
--     load of 5, then 12 typed on that form, 17;
--   * a variant added before that publish is in no baseline, so its figure was written again, every sale
--     of it since that publish undone.
--
-- The marker. public.product_stock_publishes holds one row per product that has had a product-values
-- publish since this file: `publish_count`, how many there have been, and `stock`, what the last one did
-- with each SKU of its values, { "<sku>": { "loaded": <its baseline entry, or null>, "entered": <the
-- quantity its values carried> } } ({} when the values carried no baseline: a CMS draft import's stock is
-- the file's, no editor's change to count from). The edit page reads the row before the product (a publish
-- landing between the two reads then makes its baseline look older than it is, never newer), records its
-- publish_count beside the baseline (`stock_baseline_publish_count` in the product values: ProductForm
-- carries it unseen, the autosave stores it, buildProductDraftPublishValues sends it), and this function
-- moves the count and rewrites `stock` on every product-values publish, under the products row lock
-- public.publish_product_draft takes first, so two publishes of a product never interleave here.
--
-- The rules. A baseline counts as loaded before the last publish when the values carry a marker that is a
-- whole number below the product's publish_count. For such a baseline, a SKU whose baseline entry is the
-- one the last publish used (the same number, or none in both: a variant added before that publish, which
-- the app sends as a null entry once the live product stocks it) counts from the quantity that publish
-- entered instead of from its baseline entry: the change since that publish is the draft's quantity minus
-- that figure. Every other SKU, and every SKU of values whose marker equals the count or is missing or
-- unreadable (a draft saved before this file), counts from its baseline entry, as in 02044. Per SKU, in
-- order ("counted from" is that figure; none for a SKU without a baseline entry that is not counted from
-- the last publish):
--   * equal to its baseline entry (the editor left it alone): kept, as in 02044;
--   * counted from a figure and equal to the current quantity: kept, and named `already_live`, as in 02044
--     (the user's rule: keep it, and warn);
--   * counted from the last publish's figure and equal to it: kept, and named `already_published`: that
--     publish made this change live, and whatever moved the stock since stays;
--   * counted from a figure, with a current quantity: the change applied to the current quantity, never
--     below 0, and named `moved` when that is not the figure typed (02044's rule, from that figure);
--   * otherwise: the draft's quantity, as in 02044.
-- So the examples above publish 9 (`already_published`), 12, and the variant's current stock
-- (`already_published`). An answer entry counted from the last publish's figure carries
-- `from_last_publish: true`, and its `loaded` is that figure (published = current + entered - loaded holds
-- for `moved` either way).
--
-- What a hand-written marker can do. The marker is the draft's, so any product_drafts writer (a WRITER over
-- PostgREST included) can write it, as it can write the baseline and the quantities. One equal to the
-- count, missing, not a whole number, or not below the count gives 02044's rules. One below the count
-- changes a SKU only where the draft's baseline entry is the one the last publish used, and then only to
-- count from the quantity that publish entered, which this function recorded (no API role but an ADMIN
-- writes the table, and the app writes it only here). No marker skips the stock: every SKU is decided by
-- the rules above, and every one published at another figure than the one typed, or kept where the draft's
-- figure is not its baseline entry, is named in `stock_adjusted`. The edit page decides each SKU by the
-- same rules from the same row (reconcileProductDraftStock in apps/nextblock/app/cms/products/
-- productFormData.ts), so it shows what a publish writes.
--
-- Not covered: only the last publish's figures are kept, so a draft whose change went live in an earlier
-- publish, with another publish from another page since (one that loaded a different stock for the SKU),
-- counts from its own baseline entry, as in 02044, and its change is applied again (named `moved`). A tab
-- loaded at the same stock as the page whose draft the last publish made live counts from that publish's
-- figure too: two tabs loaded at 5, 10 published from one, then 12 typed in the other publishes 12 (that
-- tab's figure replaces the other's change), not 17.
--
-- Grants. Row security on; SELECT for an ADMIN or a WRITER (as product_drafts: the edit page shows a
-- draft's stock from the row, and WRITERs edit drafts), INSERT and UPDATE for an ADMIN (is_admin(), as the
-- products and inventory_items write policies: the publish runs as its ADMIN caller), no DELETE (the row
-- goes with its product, ON DELETE CASCADE, which runs as the table owner). anon holds nothing,
-- authenticated SELECT, INSERT and UPDATE, service_role everything. The post-apply grant pass grants anon
-- SELECT and authenticated every command on every table in public, so API_ROLE_REVOKE_SQL
-- (apps/nextblock/tools/lib/migrate-core.mjs and apps/nextblock/lib/setup/schema-apply.ts) takes anon's
-- SELECT and authenticated's DELETE back. The helper keeps 02044's grants (CREATE OR REPLACE), restated
-- below. public.publish_product_draft is unchanged: it passes `stock_baseline_publish_count` through in
-- p_values and returns the helper's `stock_adjusted`.
--
-- tools/scripts/product-draft-publish.db.test.ts runs the marker against a real database (the three cases
-- above, a marker equal to the count or unreadable, a marker below it beside a baseline the last publish
-- did not use, two publishes since the load, a values publish without a baseline, the row's privileges);
-- tools/scripts/security-verify.sql section 47 checks the table's privileges and policies.

CREATE SCHEMA IF NOT EXISTS private;

-- ---------------------------------------------------------------------------
-- 1. The last product-values publish of each product
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.product_stock_publishes (
  product_id uuid NOT NULL,
  publish_count integer NOT NULL,
  stock jsonb DEFAULT '{}'::jsonb NOT NULL,
  CONSTRAINT product_stock_publishes_pkey PRIMARY KEY (product_id),
  CONSTRAINT product_stock_publishes_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products (id) ON DELETE CASCADE,
  CONSTRAINT product_stock_publishes_publish_count_check CHECK (publish_count > 0),
  CONSTRAINT product_stock_publishes_stock_check CHECK (jsonb_typeof(stock) = 'object')
);

COMMENT ON TABLE public.product_stock_publishes IS
  'One row per product: how many product-values publishes it has had since migration 02047, and what the last one did with each SKU ({ sku: { loaded, entered } }). Written by private.apply_product_draft_values only.';

ALTER TABLE public.product_stock_publishes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_stock_publishes_select_policy ON public.product_stock_publishes;
CREATE POLICY product_stock_publishes_select_policy ON public.product_stock_publishes
  FOR SELECT TO authenticated
  USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

DROP POLICY IF EXISTS product_stock_publishes_insert_policy ON public.product_stock_publishes;
CREATE POLICY product_stock_publishes_insert_policy ON public.product_stock_publishes
  FOR INSERT TO authenticated
  WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS product_stock_publishes_update_policy ON public.product_stock_publishes;
CREATE POLICY product_stock_publishes_update_policy ON public.product_stock_publishes
  FOR UPDATE TO authenticated
  USING ((( SELECT public.is_admin() AS is_admin) IS TRUE))
  WITH CHECK ((( SELECT public.is_admin() AS is_admin) IS TRUE));

-- Supabase grants nothing on a new table in public; local images and older projects grant everything by
-- default privilege, so what no API role may hold is revoked first.
REVOKE ALL ON TABLE public.product_stock_publishes FROM PUBLIC, anon;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.product_stock_publishes FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.product_stock_publishes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.product_stock_publishes TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Product values: 02044's, counting a baseline loaded before the last publish from that publish
-- ---------------------------------------------------------------------------
-- Called only by public.publish_product_draft(), once it has locked the inventory rows of the values'
-- SKUs (and the others a sale could hold against it: 02044's header) and then the products row. `p_values`
-- is built by buildProductDraftPublishValues (libs/ecommerce product-actions.ts): the RPC payload of
-- updateProduct() (minor units) without `id`, `status`, `metadata` and `payment_provider`, plus the SEO
-- fields, `gallery_media_ids` (null: leave the gallery as it is), `category_ids` (null: leave the
-- categories as they are), `stock_baseline` (null: none; a null entry: a SKU the live product stocks that
-- the draft's baseline lacks) and `stock_baseline_publish_count` (null: none). Returns
-- { stock_adjusted: [{ sku, reason, entered, loaded, current, published[, from_last_publish] }] } (02044's
-- header, and this file's). Everything but the marker (the stock plan's figure to count from, the
-- `already_published` rule and the row written at the end) is 02044's, statement for statement.
CREATE OR REPLACE FUNCTION private.apply_product_draft_values(p_product_id uuid, p_values jsonb)
    RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path TO ''
    AS $$
DECLARE
  v_uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  -- DECIMAL_TEXT_PATTERN of productFormData.ts, with ASCII digits spelled out
  -- (tools/scripts/stock-quantity-pattern.test.ts compares the two).
  v_quantity_pattern constant text := '^[ \t\n\v\f\r]*[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?[ \t\n\v\f\r]*$';
  v_max_quantity constant numeric := 2147483647;
  v_variants jsonb := COALESCE(p_values->'variants', '[]'::jsonb);
  v_baseline jsonb;
  v_has_variants boolean;
  v_total_variant_stock integer := 0;
  v_product_stock integer;
  v_product_entered integer := 0;
  v_read integer[] := '{}';
  v_item record;
  v_number numeric;
  v_product_type text;
  v_translation_group_id uuid;
  v_saved record;
  v_sku_group uuid[];
  v_siblings uuid[];
  v_gallery uuid[];
  v_slot record;
  v_entered integer;
  v_loaded integer;
  v_live integer;
  v_mode text;
  v_quantity integer;
  v_steps integer := 0;
  v_plan_skus text[] := '{}';
  v_plan_modes text[] := '{}';
  v_plan_quantities integer[] := '{}';
  v_adjusted_count integer := 0;
  v_adjusted jsonb[] := '{}';
  -- 02047: the marker.
  v_marker integer;
  v_publish_count integer;
  v_last_stock jsonb;
  v_stale boolean;
  v_last jsonb;
  v_last_loaded integer;
  v_last_entered integer;
  v_reference integer;
  v_from_last boolean;
  v_plan_loaded integer[] := '{}';
  v_plan_entered integer[] := '{}';
  v_record jsonb;
BEGIN
  IF p_values IS NULL OR jsonb_typeof(p_values) <> 'object' THEN
    RAISE EXCEPTION 'The draft''s product values are not an object.' USING ERRCODE = 'NBP04';
  END IF;
  IF jsonb_typeof(v_variants) <> 'array' THEN
    RAISE EXCEPTION 'The draft''s variants are not a list.' USING ERRCODE = 'NBP04';
  END IF;
  -- private.sync_product_draft_variants refuses one too; the stock plan below reads them first.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_variants) AS item(value) WHERE jsonb_typeof(item.value) <> 'object') THEN
    RAISE EXCEPTION 'A draft variant is not an object.' USING ERRCODE = 'NBP04';
  END IF;

  v_has_variants := jsonb_array_length(v_variants) > 0;
  v_baseline := CASE WHEN jsonb_typeof(p_values->'stock_baseline') = 'object' THEN p_values->'stock_baseline' END;
  v_translation_group_id := CASE
    WHEN lower(COALESCE(p_values->>'translation_group_id', '')) ~ v_uuid_pattern THEN (p_values->>'translation_group_id')::uuid
  END;
  v_product_type := CASE
    WHEN p_values->>'product_type' IN ('physical', 'digital') THEN p_values->>'product_type'
    WHEN NULLIF(p_values->>'freemius_product_id', '') IS NOT NULL
      OR NULLIF(p_values->>'freemius_plan_id', '') IS NOT NULL THEN 'digital'
    ELSE 'physical'
  END;

  -- 02047: the publish count the baseline was loaded at (a whole number from 0, else none), and this
  -- product's last product-values publish (none yet: a count of 0). publish_product_draft locked the
  -- products row before calling this function, so no other publish of the product reads or writes the
  -- row until this one commits. A baseline counts as loaded before the last publish only with a marker
  -- below the count: one equal to it, above it, or missing gives 02044's rules.
  v_marker := CASE WHEN jsonb_typeof(p_values->'stock_baseline_publish_count') = 'number' THEN
    CASE
      WHEN (p_values->>'stock_baseline_publish_count')::numeric BETWEEN 0 AND v_max_quantity
       AND (p_values->>'stock_baseline_publish_count')::numeric = trunc((p_values->>'stock_baseline_publish_count')::numeric)
      THEN (p_values->>'stock_baseline_publish_count')::integer
    END
  END;
  SELECT recorded.publish_count, recorded.stock
    INTO v_publish_count, v_last_stock
    FROM public.product_stock_publishes recorded
   WHERE recorded.product_id = p_product_id;
  v_publish_count := COALESCE(v_publish_count, 0);
  v_last_stock := CASE WHEN jsonb_typeof(v_last_stock) = 'object' THEN v_last_stock ELSE '{}'::jsonb END;
  v_stale := v_baseline IS NOT NULL AND v_marker IS NOT NULL AND v_marker < v_publish_count;

  -- Every stock quantity the values carry (each variant's, or the product's without variants): a JSON
  -- number, or text matching v_quantity_pattern (the edit page's DECIMAL_TEXT_PATTERN; where the two
  -- readers still part, see 02044's header), cut to its whole part and held between 0 and 2147483647; null
  -- or none is 0; anything else is refused before anything is written. Each quantity read is kept by its
  -- variant's position (v_read), and the variants are rebuilt once below with it or the planned one, so
  -- everything after the plan (the stock total, the variant rows) reads whole numbers.
  FOR v_item IN
    SELECT item.ordinality AS position, btrim(item.value->>'sku') AS sku, item.value->'stock_quantity' AS quantity
      FROM jsonb_array_elements(v_variants) WITH ORDINALITY AS item(value, ordinality)
    UNION ALL
    SELECT 0, btrim(p_values->>'sku'), p_values->'stock'
     WHERE NOT v_has_variants
  LOOP
    v_number := CASE
      WHEN v_item.quantity IS NULL OR jsonb_typeof(v_item.quantity) = 'null' THEN 0
      WHEN jsonb_typeof(v_item.quantity) = 'number' THEN v_item.quantity::numeric
    END;
    IF jsonb_typeof(v_item.quantity) = 'string' AND (v_item.quantity #>> '{}') ~ v_quantity_pattern THEN
      BEGIN
        v_number := (v_item.quantity #>> '{}')::numeric;
      EXCEPTION WHEN numeric_value_out_of_range THEN
        -- More digits than numeric holds ('1e200000'): refused below like any other unreadable text.
        v_number := NULL;
      END;
    END IF;
    IF v_number IS NULL THEN
      RAISE EXCEPTION 'The draft''s stock for % is not a number: %.',
        CASE
          WHEN COALESCE(v_item.sku, '') <> '' THEN 'SKU ' || v_item.sku
          WHEN v_item.position = 0 THEN 'the product'
          ELSE 'variant ' || v_item.position || ' (no SKU)'
        END,
        left(v_item.quantity::text, 40)
        USING ERRCODE = 'NBP04';
    END IF;
    v_quantity := GREATEST(0, LEAST(v_max_quantity, trunc(v_number)))::integer;
    IF v_item.position = 0 THEN
      v_product_entered := v_quantity;
    ELSE
      -- In place (an expanded array): a jsonb_set on the whole list here copied it once per variant.
      v_read[v_item.position] := v_quantity;
    END IF;
  END LOOP;

  -- The stock, planned before anything is written: one entry per SKU the values carry (each variant's,
  -- or the product's without variants; a later variant with the same SKU wins, as there is one
  -- inventory row per SKU), in code-point SKU order (the order of the answer's entries), with the SKU's
  -- current quantity read in the same query: its inventory row (publish_product_draft locked it before
  -- the products row, so it is written below as it is read here), or without one the stock the live
  -- rows show (a product saved before shared inventory), as apply_order_inventory_deduction reads it;
  -- NULL when nothing live carries the SKU. One query, not one per SKU: the inventory row policy's
  -- checks cost a scan of the variants per statement.
  FOR v_slot IN
    SELECT slot.sku, slot.entered, COALESCE(i.quantity, live.quantity) AS live
      FROM (
        SELECT DISTINCT ON (s.sku) s.sku, s.entered
          FROM (
            SELECT btrim(item.value->>'sku') AS sku, v_read[item.ordinality] AS entered, item.ordinality
              FROM jsonb_array_elements(v_variants) WITH ORDINALITY AS item(value, ordinality)
             WHERE v_has_variants
            UNION ALL
            SELECT btrim(p_values->>'sku'), v_product_entered, 1
             WHERE NOT v_has_variants
          ) s
         WHERE COALESCE(s.sku, '') <> ''
         ORDER BY s.sku, s.ordinality DESC
      ) slot
      LEFT JOIN public.inventory_items i ON i.sku = slot.sku
      LEFT JOIN (
        (SELECT DISTINCT ON (btrim(v.sku)) btrim(v.sku) AS sku, GREATEST(COALESCE(v.stock_quantity, 0), 0) AS quantity
           FROM public.product_variants v
          WHERE v_has_variants
            AND v.product_id = p_product_id
          ORDER BY btrim(v.sku), v.created_at, v.id)
        UNION ALL
        SELECT btrim(p.sku), GREATEST(COALESCE(p.stock, 0), 0)
          FROM public.products p
         WHERE NOT v_has_variants
           AND p.id = p_product_id
           AND NOT EXISTS (SELECT 1 FROM public.product_variants v WHERE v.product_id = p.id)
      ) live ON live.sku = slot.sku
     ORDER BY slot.sku COLLATE "C"
  LOOP
    v_entered := v_slot.entered;
    v_live := v_slot.live;
    v_loaded := CASE WHEN jsonb_typeof(v_baseline->v_slot.sku) = 'number' THEN
      CASE
        WHEN (v_baseline->>v_slot.sku)::numeric BETWEEN 0 AND v_max_quantity
         AND (v_baseline->>v_slot.sku)::numeric = trunc((v_baseline->>v_slot.sku)::numeric)
        THEN (v_baseline->>v_slot.sku)::integer
      END
    END;

    -- 02047: the figure the change counts from. The baseline entry; or, for a baseline loaded before the
    -- last publish whose entry for this SKU is the one that publish used (the same whole number, or a null
    -- entry where that publish had none), the quantity that publish entered. An entry of the row that is
    -- not a whole number (the table is written here only) is never counted from.
    v_reference := v_loaded;
    v_from_last := false;
    IF v_stale THEN
      v_last := v_last_stock->v_slot.sku;
      v_last_entered := CASE WHEN jsonb_typeof(v_last->'entered') = 'number' THEN
        CASE
          WHEN (v_last->>'entered')::numeric BETWEEN 0 AND v_max_quantity
           AND (v_last->>'entered')::numeric = trunc((v_last->>'entered')::numeric)
          THEN (v_last->>'entered')::integer
        END
      END;
      v_last_loaded := CASE WHEN jsonb_typeof(v_last->'loaded') = 'number' THEN
        CASE
          WHEN (v_last->>'loaded')::numeric BETWEEN 0 AND v_max_quantity
           AND (v_last->>'loaded')::numeric = trunc((v_last->>'loaded')::numeric)
          THEN (v_last->>'loaded')::integer
        END
      END;
      IF v_last_entered IS NOT NULL
         AND (v_last_loaded IS NOT NULL OR jsonb_typeof(v_last->'loaded') = 'null')
         AND (v_loaded IS NOT NULL OR jsonb_typeof(v_baseline->v_slot.sku) = 'null')
         AND v_loaded IS NOT DISTINCT FROM v_last_loaded THEN
        v_reference := v_last_entered;
        v_from_last := true;
      END IF;
    END IF;

    IF v_loaded IS NOT NULL AND v_entered = v_loaded THEN
      -- Not changed by the editor: the current quantity, whatever sold or changed since the page load.
      v_mode := 'keep';
      v_quantity := COALESCE(v_live, v_entered);
    ELSIF v_reference IS NOT NULL AND v_entered = v_live THEN
      -- Changed to the current quantity: already live, so applying the change again would count it
      -- twice. A sale that reached the same quantity looks the same, so the answer names the SKU.
      v_mode := 'keep';
      v_quantity := v_live;
      v_adjusted_count := v_adjusted_count + 1;
      v_adjusted[v_adjusted_count] := jsonb_build_object(
        'sku', v_slot.sku,
        'reason', 'already_live',
        'entered', v_entered,
        'loaded', v_reference,
        'current', v_live,
        'published', v_live
      ) || CASE WHEN v_from_last THEN jsonb_build_object('from_last_publish', true) ELSE '{}'::jsonb END;
    ELSIF v_from_last AND v_live IS NOT NULL AND v_entered = v_reference THEN
      -- 02047: the quantity the last publish entered, from a baseline loaded before it: that publish made
      -- this change live, and what moved the stock since (a sale, the Inventory screen) stays. Named:
      -- a figure meant to replace the stock as it now is looks the same.
      v_mode := 'keep';
      v_quantity := v_live;
      v_adjusted_count := v_adjusted_count + 1;
      v_adjusted[v_adjusted_count] := jsonb_build_object(
        'sku', v_slot.sku,
        'reason', 'already_published',
        'entered', v_entered,
        'loaded', v_reference,
        'current', v_live,
        'published', v_live,
        'from_last_publish', true
      );
    ELSIF v_reference IS NOT NULL AND v_live IS NOT NULL THEN
      -- Changed: the editor's change, applied to the current quantity.
      v_mode := 'change';
      v_quantity := GREATEST(0, LEAST(v_max_quantity, v_live::numeric + v_entered - v_reference))::integer;
      IF v_quantity <> v_entered THEN
        v_adjusted_count := v_adjusted_count + 1;
        v_adjusted[v_adjusted_count] := jsonb_build_object(
          'sku', v_slot.sku,
          'reason', 'moved',
          'entered', v_entered,
          'loaded', v_reference,
          'current', v_live,
          'published', v_quantity
        ) || CASE WHEN v_from_last THEN jsonb_build_object('from_last_publish', true) ELSE '{}'::jsonb END;
      END IF;
    ELSE
      -- No figure to count from (a new SKU, values without a baseline) or nothing live: the draft's.
      v_mode := 'set';
      v_quantity := v_entered;
    END IF;

    v_steps := v_steps + 1;
    v_plan_skus[v_steps] := v_slot.sku;
    v_plan_modes[v_steps] := v_mode;
    v_plan_quantities[v_steps] := v_quantity;
    -- 02047: what the row written below records for this SKU: the draft's own baseline entry (never the
    -- figure counted from, so a draft started again from the same page keeps matching it) and its quantity.
    v_plan_loaded[v_steps] := v_loaded;
    v_plan_entered[v_steps] := v_entered;
  END LOOP;

  -- The variants and the product row carry the planned quantities (a variant without a SKU keeps the
  -- one read above); the trigger on inventory_items writes the same ones back for every SKU written
  -- below. The product's stock beside variants is their total, held at 2147483647 (an integer column).
  IF v_has_variants THEN
    SELECT jsonb_agg(jsonb_set(item.value, '{stock_quantity}', to_jsonb(COALESCE(planned.quantity, v_read[item.ordinality])))
                     ORDER BY item.ordinality),
           LEAST(COALESCE(SUM(COALESCE(planned.quantity, v_read[item.ordinality])), 0), v_max_quantity)::integer
      INTO v_variants, v_total_variant_stock
      FROM jsonb_array_elements(v_variants) WITH ORDINALITY AS item(value, ordinality)
      LEFT JOIN unnest(v_plan_skus, v_plan_quantities) AS planned(sku, quantity) ON planned.sku = btrim(item.value->>'sku');
  ELSE
    v_product_stock := COALESCE(v_plan_quantities[array_position(v_plan_skus, btrim(COALESCE(p_values->>'sku', '')))], v_product_entered);
  END IF;

  -- The product row.
  UPDATE public.products
     SET title = p_values->>'title',
         slug = p_values->>'slug',
         sku = p_values->>'sku',
         product_type = v_product_type,
         payment_provider = CASE WHEN v_product_type = 'digital' THEN 'freemius' ELSE 'stripe' END,
         upc = NULLIF(p_values->>'upc', ''),
         stock = CASE
           WHEN v_has_variants THEN v_total_variant_stock
           ELSE v_product_stock
         END,
         short_description = NULLIF(p_values->>'short_description', ''),
         description_json = NULLIF(p_values->'description_json', 'null'::jsonb),
         price = COALESCE((p_values->>'price')::integer, 0),
         prices = COALESCE(p_values->'prices', '{}'::jsonb),
         sale_price = CASE
           WHEN p_values ? 'sale_price' AND p_values->>'sale_price' <> '' THEN (p_values->>'sale_price')::integer
         END,
         sale_prices = CASE
           WHEN p_values ? 'sale_prices' THEN COALESCE(p_values->'sale_prices', '{}'::jsonb)
         END,
         sale_start_at = CASE
           WHEN p_values ? 'sale_start_at' AND p_values->>'sale_start_at' <> '' THEN (p_values->>'sale_start_at')::timestamptz
         END,
         sale_end_at = CASE
           WHEN p_values ? 'sale_end_at' AND p_values->>'sale_end_at' <> '' THEN (p_values->>'sale_end_at')::timestamptz
         END,
         freemius_plan_id = NULLIF(p_values->>'freemius_plan_id', ''),
         freemius_product_id = NULLIF(p_values->>'freemius_product_id', ''),
         trial_period_days = COALESCE((p_values->>'trial_period_days')::integer, 0),
         trial_requires_payment_method = COALESCE((p_values->>'trial_requires_payment_method')::boolean, false),
         is_taxable = COALESCE((p_values->>'is_taxable')::boolean, is_taxable),
         meta_title = NULLIF(btrim(p_values->>'meta_title'), ''),
         meta_description = NULLIF(btrim(p_values->>'meta_description'), ''),
         custom_canonical = NULLIF(btrim(p_values->>'custom_canonical'), ''),
         language_id = COALESCE((p_values->>'language_id')::bigint, language_id),
         translation_group_id = COALESCE(v_translation_group_id, translation_group_id),
         updated_at = now()
   WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product not found.' USING ERRCODE = 'NBP05';
  END IF;

  -- The variants (02043 section 2), with the planned quantities.
  PERFORM private.sync_product_draft_variants(p_product_id, v_variants);

  -- The gallery: the listed images that still have a media row, each once, in their order, then the
  -- images it no longer lists unlinked. A dropped image keeps its media row and its files.
  IF jsonb_typeof(p_values->'gallery_media_ids') = 'array' THEN
    SELECT COALESCE(array_agg(listed.media_id ORDER BY listed.position), '{}')
      INTO v_gallery
      FROM (
        SELECT candidate.media_id, min(candidate.ordinality) AS position
          FROM (
            SELECT CASE WHEN lower(item.value) ~ v_uuid_pattern THEN lower(item.value)::uuid END AS media_id,
                   item.ordinality
              FROM jsonb_array_elements_text(p_values->'gallery_media_ids') WITH ORDINALITY AS item(value, ordinality)
          ) candidate
         WHERE candidate.media_id IS NOT NULL
         GROUP BY candidate.media_id
      ) listed
     WHERE EXISTS (SELECT 1 FROM public.media m WHERE m.id = listed.media_id);

    INSERT INTO public.product_media (product_id, media_id, sort_order)
    SELECT p_product_id, g.media_id, (g.n - 1)::integer
      FROM unnest(v_gallery) WITH ORDINALITY AS g(media_id, n)
        ON CONFLICT (product_id, media_id) DO UPDATE SET sort_order = EXCLUDED.sort_order;

    DELETE FROM public.product_media
     WHERE product_id = p_product_id
       AND NOT (media_id = ANY (v_gallery));
  END IF;

  -- The sale schedule belongs to the SKU: the saved row's canonical sale amounts (the currency trigger
  -- has normalised them) and its window go to every product sharing the SKU (its translations), and
  -- each variant's to the variants with its SKU in those products.
  SELECT p.sku, p.sale_price, p.sale_prices, p.sale_start_at, p.sale_end_at, p.translation_group_id
    INTO v_saved
    FROM public.products p
   WHERE p.id = p_product_id;

  SELECT COALESCE(array_agg(p.id), ARRAY[p_product_id])
    INTO v_sku_group
    FROM public.products p
   WHERE p.sku = v_saved.sku;

  UPDATE public.products
     SET sale_price = v_saved.sale_price,
         sale_prices = v_saved.sale_prices,
         sale_start_at = v_saved.sale_start_at,
         sale_end_at = v_saved.sale_end_at,
         updated_at = now()
   WHERE id = ANY (v_sku_group);

  IF v_has_variants THEN
    UPDATE public.product_variants AS target
       SET sale_price = source.sale_price,
           sale_prices = source.sale_prices,
           sale_start_at = source.sale_start_at,
           sale_end_at = source.sale_end_at,
           updated_at = now()
      FROM public.product_variants AS source
     WHERE source.product_id = p_product_id
       AND target.sku = source.sku
       AND target.product_id = ANY (v_sku_group);
  END IF;

  -- The shared inventory, by the plan above, in two statements. A kept SKU is never written; one
  -- without a row gets one holding its current quantity (NOT EXISTS reads committed rows, so a row
  -- another session created and committed since the publish took its locks is left as it is; one it is
  -- still inserting is waited for: 02044's SKU with no inventory row). Every other SKU takes its
  -- planned quantity: the rows were locked before the plan read them, so there is nothing to read
  -- again. The trigger writes each quantity it sets back to every variant and product with that SKU
  -- (translations included).
  INSERT INTO public.inventory_items (sku, quantity)
  SELECT step.sku, step.quantity
    FROM unnest(v_plan_skus, v_plan_modes, v_plan_quantities) AS step(sku, mode, quantity)
   WHERE step.mode = 'keep'
     AND NOT EXISTS (SELECT 1 FROM public.inventory_items i WHERE i.sku = step.sku)
   ORDER BY step.sku
      ON CONFLICT (sku) DO NOTHING;

  INSERT INTO public.inventory_items (sku, quantity)
  SELECT step.sku, step.quantity
    FROM unnest(v_plan_skus, v_plan_modes, v_plan_quantities) AS step(sku, mode, quantity)
   WHERE step.mode <> 'keep'
   ORDER BY step.sku
      ON CONFLICT (sku) DO UPDATE SET quantity = EXCLUDED.quantity;

  -- 02047: this publish, as the next one reads it. The count moves on every product-values publish (one
  -- without a baseline included: a baseline loaded before it is older than the stock it wrote); the stock
  -- entries are the plan's SKUs with the draft's own baseline entry and the quantity it entered, when the
  -- values carry a baseline ({} otherwise: a CMS draft import's figures are no editor's change to count
  -- from).
  SELECT COALESCE(jsonb_object_agg(step.sku, jsonb_build_object('loaded', step.loaded, 'entered', step.entered)), '{}'::jsonb)
    INTO v_record
    FROM unnest(v_plan_skus, v_plan_loaded, v_plan_entered) AS step(sku, loaded, entered)
   WHERE v_baseline IS NOT NULL;

  INSERT INTO public.product_stock_publishes AS recorded (product_id, publish_count, stock)
  VALUES (p_product_id, v_publish_count + 1, v_record)
      ON CONFLICT (product_id) DO UPDATE
     SET publish_count = recorded.publish_count + 1,
         stock = EXCLUDED.stock;

  -- Categories belong to the translation group: every product in it gets the listed categories that
  -- still exist.
  IF jsonb_typeof(p_values->'category_ids') = 'array' THEN
    SELECT COALESCE(array_agg(p.id), ARRAY[p_product_id])
      INTO v_siblings
      FROM public.products p
     WHERE p.translation_group_id = v_saved.translation_group_id;

    DELETE FROM public.product_categories WHERE product_id = ANY (v_siblings);

    INSERT INTO public.product_categories (product_id, category_id)
    SELECT sibling.id, category.id
      FROM unnest(v_siblings) AS sibling(id)
     CROSS JOIN (
       SELECT DISTINCT c.id
         FROM (
           SELECT CASE WHEN lower(item.value) ~ v_uuid_pattern THEN lower(item.value)::uuid END AS category_id
             FROM jsonb_array_elements_text(p_values->'category_ids') AS item(value)
         ) requested
         JOIN public.categories c ON c.id = requested.category_id
     ) category;
  END IF;

  RETURN jsonb_build_object('stock_adjusted', to_jsonb(v_adjusted));
END;
$$;

REVOKE ALL ON FUNCTION private.apply_product_draft_values(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.apply_product_draft_values(uuid, jsonb) TO authenticated, service_role;
