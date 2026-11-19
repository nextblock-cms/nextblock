-- 02044: a product-values publish writes a SKU's stock only when the editor changed it.
-- Append-only, forward-only, re-runnable: four functions replaced (the helper dropped and created
-- again, see below) and two indexes added (section 5), no table, policy or data change.
--
-- Until now private.apply_product_draft_values (02043) wrote the stock the product form had loaded back
-- into inventory_items for every SKU of the draft (each variant's stock_quantity, or the product's stock
-- without variants), as updateProduct() and syncSharedInventoryForSavedProduct did through 0.23.5. The
-- form loads the stock when the edit page opens and its autosave stores it in the draft, so a unit sold
-- between the page load and Publish (apply_order_inventory_deduction lowers inventory_items, whose
-- trigger writes the quantity back to the variants and the product) was put back by the publish, and so
-- was a change made meanwhile on the Inventory screen, by an import or by the publish of a translation
-- sharing the SKU. NBP03 could not catch it: it refuses a write after the read the server action makes
-- when Publish is pressed, while the draft's stock dates from the page load, and the draft's values win.
--
-- The draft now records the stock the form loaded, per SKU: `stock_baseline` in the product values,
-- { "<sku>": <quantity> } (the edit page builds it, ProductForm carries it, the autosave stores it and
-- buildProductDraftPublishValues sends it). The publish compares each SKU's quantity in the draft with
-- it:
--   * the same (the editor did not change it): inventory_items is left as it is, and the variant rows
--     and the product row take the SKU's current quantity (its inventory row, or without one the live
--     variant's or product's stock, as apply_order_inventory_deduction reads it), never the draft's
--     copy. A SKU without an inventory row gets one holding that quantity;
--   * changed, to the SKU's current quantity: left alone the same way, because the change is already
--     live. A draft started again after its publish (an autosave that ran after the commit, another
--     tab) still carries the baseline from before it: loaded 5, typed 10 and published, the same values
--     again would publish 15 by the next rule, and they publish 10. A baseline written by hand does
--     nothing here either. But the values cannot tell a change already published from a quantity that
--     sales or another stock update (the Inventory screen, an import, a translation's publish) reached
--     meanwhile, and that one is left alone too: loaded 10, 9 typed for a damaged unit, one sold
--     meanwhile: 9 stays, where 8 was meant. So the answer names every SKU this rule decides
--     (`already_live`), and the app warns;
--   * changed otherwise: the change (the draft's quantity minus the loaded one) is applied to the SKU's
--     current quantity, never below 0, so a sale made meanwhile keeps its deduction and the editor's
--     change still lands (loaded 5, typed 15, one sold meanwhile: 14). With nothing in between, that is
--     the typed quantity; otherwise the answer names the SKU (`moved`), and the app warns;
--   * not in the baseline (a variant the editor added, a SKU the editor renamed), or values without
--     one (a draft saved before this migration, a CMS draft import, whose stock is the file's): the
--     draft's quantity, as before.
-- The answer's `stock_adjusted` lists { sku, reason, entered, loaded, current, published } in code-point
-- SKU order (COLLATE "C" compares the UTF-8 bytes, which is code-point order, as the edit page sorts its
-- notes; the page and the warning then name the same first SKUs): reason `already_live` for each SKU the
-- second rule decided (published = current = entered), `moved` for each change published at another
-- quantity than the one typed (published = current + entered - loaded, held between 0 and 2147483647).
-- A SKU left as loaded and a SKU written as typed are not listed. What the rules cannot see, since
-- nothing records which publish a baseline was loaded against: a draft started again after its
-- publish whose stock moved again before its own publish (published 10, one sold, then the same values
-- publish 14, `moved`), and a figure typed again on a form loaded before that publish (published 10,
-- then 12 typed there: 17).
-- A baseline entry that is not a whole number from 0 to 2147483647 counts as missing. A baseline changes
-- only what the publish writes for the stock, which any product_drafts writer (a WRITER over PostgREST
-- included) could already set to anything, and only an ADMIN publishes; beside a quantity equal to the
-- live stock it changes nothing, and the answer says so.
--
-- Lock order. A sale (apply_order_inventory_deduction; the app's SQL fallback runs the same steps)
-- locks each SKU's inventory row, and the row's trigger (sync_inventory_cache_for_sku) then writes the
-- variant and product rows carrying that SKU: a sale holds a product's rows only through the inventory
-- row of one of the product's SKUs. Until 2026-11-18 the publish locked the products row first and wrote
-- the inventory rows last, so a sale made while it ran could deadlock with it, and PostgreSQL aborted
-- one of the two (40P01): the publish failed, or the sale's deduction fell back to the app's SQL path
-- (caught before release). Now, before the products row, public.publish_product_draft locks in SKU
-- order the inventory rows of every SKU of every product whose rows it can write: this product (a
-- variant the draft drops or renames included), the products with the values' product SKU (the sale
-- schedule writes them: its translations, a SKU only a translation carries included) and the products
-- carrying one of the values' SKUs (the inventory trigger writes them), each SKU as stored (the row a
-- sale locks), plus the values' SKUs trimmed (the rows the helper writes). And a sale takes an order's
-- SKUs in SKU order too (section 4), so neither ever holds an inventory row the other needs before one
-- it already has. A sale that holds one of those rows is waited for before the publish locks anything
-- else; its trigger moves the updated_at of the products carrying the SKU, so a publish of one of them
-- then refuses with nothing written (NBP03), and the next publish applies the editor's change to what
-- the sale left. A sale that comes later waits for the publish and deducts from what it wrote. Two
-- publishes sharing SKUs (translations) take them in the same order: the second waits, then refuses
-- (NBP03) when the first wrote its row (always when they share the product SKU: the sale schedule).
-- The plan below reads the locked rows, so each SKU is written as it was read (no second read at write
-- time). Not covered: a SKU with no inventory row when the publish starts (a product from before shared
-- inventory that nothing has sold or published since; a publish by this file gives every SKU in its
-- values a row), whose first sale may still deadlock with the publish; a SKU another session adds to one
-- of those products between the publish's read of them and its locks; a writer that takes several of
-- those inventory rows in one statement in another order (upsertInventoryRows in libs/ecommerce, which
-- createProduct() runs with a new product's variant SKUs in form order, as when a translation created
-- on the CMS's new-product page carries its source's SKUs, and Cortex's execute_database_mutation,
-- which can upsert or update several inventory rows at once); and cycles through other sessions. Two
-- sales of one product's variants can deadlock with each other, as with 02001's deduction: one holds
-- the product row through its trigger and waits for an inventory row the other holds, whose trigger
-- waits for that product row. Either way the database aborts one transaction of the cycle, which writes
-- nothing (when that is createProduct()'s upsert, the product it saved first stays, and the CMS reports
-- the create as failed).
--
-- Every stock quantity in the values (each variant's, and the product's without variants) is read like
-- the edit page's reader (readDraftStockQuantity in apps/nextblock/app/cms/products/productFormData.ts)
-- reads one: a JSON number, or text matching the same pattern (DECIMAL_TEXT_PATTERN there,
-- v_quantity_pattern here: a plain decimal number, with surrounding spaces, a sign, a fraction, an
-- exponent; tools/scripts/stock-quantity-pattern.test.ts holds the two to the same strings), cut to its
-- whole part and held between 0 and 2147483647; null or none reads as 0. Anything else is refused with
-- nothing written (NBP04, naming the SKU). Until 2026-11-18 the plan cast the text to numeric, which also
-- reads 'NaN' (it sorts above every number, so the clamp wrote 2147483647), 'Infinity' and 'inf' (the
-- same) and, since PostgreSQL 16, '0x10' and '1_000': text the edit page cannot read either (it shows the
-- live stock in its place, and publish refuses such a draft before calling this function:
-- findUnreadableProductDraftValues), which any product_drafts writer can store. The two readers part
-- only at edges the app never sends here, since it sends every quantity as a whole number
-- (completeProductDraftValues) and refuses a draft holding one it cannot read: a JSON number or text
-- from about 1.8e308 (where JavaScript reads Infinity) up to numeric's limit (below 1e131072) reads
-- 2147483647 here, which the page refuses; text numeric cannot hold (131072 digits before the point at
-- most, 16383 after it) is refused here, and the page refuses it too when it is too large ('1e200000')
-- but reads a number when the extra digits are after the point ('1e-20000' as 0); and text with more
-- digits than a double carries ('4.99999999999999999') is cut exactly here (4), where the page rounds
-- it first (5). A product's stock beside variants is their total, held at 2147483647 (it raised 22003
-- above it), and so is the total the inventory trigger writes (section 3).
--
-- private.apply_product_draft_values now answers the stock it adjusted (02043's answers an empty list)
-- and public.publish_product_draft returns it as `stock_adjusted`. The helper is dropped and created
-- again, not replaced: a database whose 02043 ran before 2026-11-18 holds a version returning void, and
-- CREATE OR REPLACE cannot change a return type. Everything else in both functions is 02043's,
-- statement for statement, but the stock and the inventory locks. Sections 3 and 4 replace two 02001
-- functions, statement for statement but one change each: the inventory trigger's product total held,
-- and the sale's SKU order.
--
-- Not addressed: a publish that changes many SKUs at once still runs the inventory trigger once per SKU,
-- and each run sums the product's variants again under the ADMIN's row policies, so its cost grows with
-- the square of the SKUs it changes, and with the catalog. With the SKU indexes (section 5) five hundred
-- changed SKUs beside 50 other products take about 5 s on an idle machine, under the Data API's 8 s
-- statement timeout for `authenticated` but not by much, and up to 9 s on a busy one, past it (10 s or
-- more without them); beside 2,000 other products they take 9 to 13 s. Past it the publish fails
-- (57014: nothing written, the draft stays).
--
-- Grants: as 02043. The re-created private function starts with PostgreSQL's default EXECUTE for PUBLIC,
-- so it is revoked from PUBLIC and anon and granted to authenticated and service_role (the publish runs
-- it as its caller). public.publish_product_draft keeps its grants (CREATE OR REPLACE) and its entry in
-- API_ROLE_REVOKE_SQL; public.sync_inventory_cache_for_sku and public.apply_order_inventory_deduction
-- keep theirs too.
-- tools/scripts/product-draft-publish.db.test.ts runs these functions: a sale between the page load and
-- the publish, an edited stock, both at once, a draft started again after its publish, a crafted
-- baseline, what the answer names (`already_live`, `moved`, both in one publish, in code-point order),
-- the quantities it reads and refuses, two variants of 2147483647, which inventory rows a publish locks
-- (a product without variants, an overlay, a variant the draft drops, the product SKU, a SKU only a
-- translation carries, another SKU of a product sharing one of the values, a padded SKU as stored and
-- trimmed), a sale or a translation's publish running against a publish (each could deadlock until
-- 2026-11-18: a sale holding the row, a sale part way, two translations, a variant the draft drops or
-- renames, a SKU only a translation carries, a product sharing a SKU), and the sale's deduction by the
-- function and by the app's SQL fallback (every SKU of an order once, in SKU order, two sales in
-- opposite orders), and section 5's indexes; without a database, it holds sections 3 and 4 to 02001's
-- text but their one change each, and section 5 to a plain CREATE INDEX IF NOT EXISTS.
-- tools/scripts/migration-replay.db.test.ts upgrades a void helper with this file and replays every
-- file over a migrated database.

CREATE SCHEMA IF NOT EXISTS private;

DROP FUNCTION IF EXISTS private.apply_product_draft_values(uuid, jsonb);

-- ---------------------------------------------------------------------------
-- 1. Product values: 02043's, with the stock written only where the editor changed it
-- ---------------------------------------------------------------------------
-- Called only by public.publish_product_draft(), once it has locked the inventory rows of the values'
-- SKUs (and the others a sale could hold against it: see the header). `p_values` is built by
-- buildProductDraftPublishValues (libs/ecommerce product-actions.ts): the RPC payload of updateProduct()
-- (minor units) without `id`, `status`, `metadata` and `payment_provider`, plus the SEO fields,
-- `gallery_media_ids` (null: leave the gallery as it is), `category_ids` (null: leave the categories as
-- they are) and `stock_baseline` (null: none). Returns
-- { stock_adjusted: [{ sku, reason, entered, loaded, current, published }] } (see the header).
CREATE FUNCTION private.apply_product_draft_values(p_product_id uuid, p_values jsonb)
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

  -- Every stock quantity the values carry (each variant's, or the product's without variants): a JSON
  -- number, or text matching v_quantity_pattern (the edit page's DECIMAL_TEXT_PATTERN; where the two
  -- readers still part, see the header), cut to its whole part and held between 0 and 2147483647; null
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

    IF v_loaded IS NOT NULL AND v_entered = v_loaded THEN
      -- Not changed by the editor: the current quantity, whatever sold or changed since the page load.
      v_mode := 'keep';
      v_quantity := COALESCE(v_live, v_entered);
    ELSIF v_loaded IS NOT NULL AND v_entered = v_live THEN
      -- Changed to the current quantity: already live (a draft started again after its publish keeps
      -- the baseline from before it), so applying the change again would count it twice. A sale that
      -- reached the same quantity looks the same, so the answer names the SKU.
      v_mode := 'keep';
      v_quantity := v_live;
      v_adjusted_count := v_adjusted_count + 1;
      v_adjusted[v_adjusted_count] := jsonb_build_object(
        'sku', v_slot.sku,
        'reason', 'already_live',
        'entered', v_entered,
        'loaded', v_loaded,
        'current', v_live,
        'published', v_live
      );
    ELSIF v_loaded IS NOT NULL AND v_live IS NOT NULL THEN
      -- Changed: the editor's change, applied to the current quantity.
      v_mode := 'change';
      v_quantity := GREATEST(0, LEAST(v_max_quantity, v_live::numeric + v_entered - v_loaded))::integer;
      IF v_quantity <> v_entered THEN
        v_adjusted_count := v_adjusted_count + 1;
        v_adjusted[v_adjusted_count] := jsonb_build_object(
          'sku', v_slot.sku,
          'reason', 'moved',
          'entered', v_entered,
          'loaded', v_loaded,
          'current', v_live,
          'published', v_quantity
        );
      END IF;
    ELSE
      -- No loaded quantity (a new SKU, values without a baseline) or nothing live: the draft's.
      v_mode := 'set';
      v_quantity := v_entered;
    END IF;

    v_steps := v_steps + 1;
    v_plan_skus[v_steps] := v_slot.sku;
    v_plan_modes[v_steps] := v_mode;
    v_plan_quantities[v_steps] := v_quantity;
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
  -- still inserting is waited for: the header's SKU with no inventory row). Every other SKU takes its
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

-- ---------------------------------------------------------------------------
-- 2. The publish: 02043's, locking the inventory rows first and answering the stock it adjusted
-- ---------------------------------------------------------------------------
-- As in 02043 (section 5), plus the inventory row locks (see the header) and `stock_adjusted` in the
-- answer: [] for an overlay publish.
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

  -- Inventory rows, before the products row and in SKU order (see the header). A sale locks a SKU's
  -- inventory row, then its trigger writes the variant and product rows carrying that SKU, so it holds a
  -- product's rows only through the row of one of that product's SKUs. Every product or variant row this
  -- publish writes belongs to this product (a variant the draft drops or renames included), to a product
  -- with the values' product SKU (the sale schedule) or to a product carrying one of the values' SKUs
  -- (the inventory trigger; one without variants carries only its own SKU, one of the values'). So it
  -- locks the row of every SKU those products carry, as stored (the row a sale locks), and of every SKU
  -- the values carry, trimmed (the rows private.apply_product_draft_values writes: each variant's, or
  -- the product's without variants). A SKU without a row has nothing to lock, and an overlay publish,
  -- which writes no stock and no other product's row, locks none. Values whose variants are not a list
  -- are refused by the helper.
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
      PERFORM 1
         FROM public.inventory_items i
        WHERE i.sku = ANY (v_stock_skus)
        ORDER BY i.sku
          FOR UPDATE;
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
-- 3. The inventory trigger's product total, held at 2147483647
-- ---------------------------------------------------------------------------
-- 02001's public.sync_inventory_cache_for_sku, which on_inventory_item_change runs for every
-- inventory row written (a sale, the Inventory screen, an import, a publish), statement for statement,
-- but the stock of a product with variants: the total of their inventory rows, an integer column,
-- now held at 2147483647. Above it the sum raised 22003 and failed the write that fired it, so a
-- publish of two variants of 2147483647 failed here once the helper's own total was held. Replaced,
-- not dropped: the trigger and the grants stay.
CREATE OR REPLACE FUNCTION public.sync_inventory_cache_for_sku(p_sku text) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  v_quantity integer := 0;
BEGIN
  IF NULLIF(trim(p_sku), '') IS NULL THEN
    RETURN;
  END IF;

  SELECT quantity
    INTO v_quantity
  FROM public.inventory_items
  WHERE sku = p_sku
  LIMIT 1;

  v_quantity := COALESCE(v_quantity, 0);

  UPDATE public.product_variants
  SET
    stock_quantity = v_quantity,
    updated_at = now()
  WHERE sku = p_sku;

  UPDATE public.products AS products
  SET
    stock = v_quantity,
    updated_at = now()
  WHERE products.sku = p_sku
    AND NOT EXISTS (
      SELECT 1
      FROM public.product_variants
      WHERE product_id = products.id
    );

  UPDATE public.products AS products
  SET
    stock = LEAST(COALESCE((
      SELECT SUM(COALESCE(inventory.quantity, 0))
      FROM public.product_variants AS variants
      LEFT JOIN public.inventory_items AS inventory
        ON inventory.sku = variants.sku
      WHERE variants.product_id = products.id
    ), 0), 2147483647),
    updated_at = now()
  WHERE EXISTS (
    SELECT 1
    FROM public.product_variants AS variants
    WHERE variants.product_id = products.id
      AND variants.sku = p_sku
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. The sale's deduction, taking an order's SKUs in SKU order
-- ---------------------------------------------------------------------------
-- 02001's public.apply_order_inventory_deduction (what checkout's order syncs call for a paid order),
-- statement for statement, but its loop takes the order's lines in the order of the SKU each one locks
-- (the variant's when variant_id is set, else the product's): the order publish_product_draft locks
-- inventory rows in (both sort by the sku columns' own collation). In GROUP BY order, a sale part way
-- through its SKUs when a publish started deadlocked with it whenever it held a later SKU of the
-- publish's but not an earlier one, and two sales taking the same two SKUs in opposite orders could
-- deadlock too. The app's SQL fallback (applyOrderInventoryDeductionViaSql in libs/ecommerce
-- order-inventory.ts) orders its lines the same way. A padded SKU (' X ') is matched here as stored and
-- trimmed by the publish, as before this file: a sale of the variant ' X ' lowers the row ' X ', and a
-- publish writes the row 'X' (its lock set holds both). Replaced, not dropped: the signature, the
-- attributes (invoker, search_path) and the grants stay; the track-quantities switch and the
-- inventory_deducted_at guard are 02001's.
CREATE OR REPLACE FUNCTION public.apply_order_inventory_deduction(p_order_id uuid) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  v_track_quantities boolean := public.get_ecommerce_track_quantities();
  v_item record;
  v_inventory_deducted_at timestamptz;
  v_sku text;
  v_current_quantity integer;
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

  FOR v_item IN
    SELECT
      product_id,
      variant_id,
      SUM(quantity)::integer AS quantity
    FROM public.order_items
    WHERE order_id = p_order_id
    GROUP BY product_id, variant_id
    ORDER BY CASE
               WHEN order_items.variant_id IS NOT NULL
                 THEN (SELECT v.sku FROM public.product_variants v WHERE v.id = order_items.variant_id)
               ELSE (SELECT p.sku FROM public.products p WHERE p.id = order_items.product_id)
             END,
             product_id,
             variant_id
  LOOP
    v_sku := NULL;
    v_current_quantity := 0;

    IF v_item.variant_id IS NOT NULL THEN
      SELECT
        sku,
        GREATEST(COALESCE(stock_quantity, 0), 0)
        INTO v_sku,
             v_current_quantity
      FROM public.product_variants
      WHERE id = v_item.variant_id
      LIMIT 1;
    ELSIF v_item.product_id IS NOT NULL THEN
      SELECT
        sku,
        GREATEST(COALESCE(stock, 0), 0)
        INTO v_sku,
             v_current_quantity
      FROM public.products
      WHERE id = v_item.product_id
      LIMIT 1;
    END IF;

    IF NULLIF(trim(v_sku), '') IS NULL THEN
      CONTINUE;
    END IF;

    INSERT INTO public.inventory_items (sku, quantity)
    VALUES (v_sku, v_current_quantity)
    ON CONFLICT (sku) DO NOTHING;

    UPDATE public.inventory_items
    SET
      quantity = GREATEST(COALESCE(quantity, 0) - v_item.quantity, 0),
      updated_at = now()
    WHERE sku = v_sku;
  END LOOP;

  UPDATE public.orders
  SET inventory_deducted_at = now()
  WHERE id = p_order_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Indexes on the SKU columns the inventory trigger and the row policies look up
-- ---------------------------------------------------------------------------
-- Every inventory write runs sync_inventory_cache_for_sku, which updates the variants and the product
-- carrying the SKU (WHERE sku = ...), and the inventory read policy checks each row it reads against the
-- products and the variants carrying its SKU. Neither column had an index of its own (the unique keys
-- start with product_id and language_id), so each of those lookups scanned the whole table, or the whole
-- (product_id, sku) key, under the caller's row policies, once per SKU a publish writes. Measured
-- 2026-11-18 on local replays, as the ADMIN through `authenticated`: five hundred changed SKUs beside 50
-- other products took 10 s or more without them and about 5 s with both on an idle machine, up to 9 s on
-- a busy one (the variants one alone: 5 to 9 s), fifty changed SKUs beside 2,000 other products 0.8 to
-- 2.1 s, then 0.2 to 0.3 s. A plain CREATE INDEX (a migration runs in a transaction, where CONCURRENTLY
-- cannot): it holds writes to each table until this file's transaction commits, right after it, a
-- moment for a store's catalog.
CREATE INDEX IF NOT EXISTS idx_product_variants_sku ON public.product_variants USING btree (sku);
CREATE INDEX IF NOT EXISTS idx_products_sku ON public.products USING btree (sku);
