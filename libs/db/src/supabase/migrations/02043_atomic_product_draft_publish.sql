-- 02043: a product draft publishes in one transaction, under a row lock.
-- Append-only, forward-only: five functions (CREATE OR REPLACE, the values helper dropped first), no
-- table, policy or data change. The file also replays over a database where it and 02044 already ran:
-- the sandbox reset and the stale-history self-heal drop only `public`, so the three `private` helpers
-- stay, the values helper as 02044 left it. CREATE OR REPLACE cannot change a return type, so that
-- helper returns jsonb here too and is dropped before it is created (section 3);
-- tools/scripts/migration-replay.db.test.ts replays every file that way. Every function is SECURITY
-- INVOKER: it runs with the caller's rights and RLS, so it can do nothing the caller could not already
-- do over PostgREST, only all of it at once or none of it.
--
-- Until now publishProductVisualEditingDraft (apps/nextblock/lib/visual-editing/product-drafts.ts) sent
-- a dozen PostgREST requests with no transaction around them: a claim on the draft (an UPDATE on its id
-- and updated_at), upsert_product_with_variants, the gallery upsert and unlink, taxability, SEO, the
-- sale schedule across the SKU group, the shared inventory (with the service role), the categories, a
-- block insert, a block delete, a revision and the draft delete. The limits 0.23.4 accepted for that:
--   * two publishes (two tabs or two admins) could leave the description blocks twice;
--   * a save that landed after the claim reported success and was deleted with the draft;
--   * a failure after the RPC (the gallery, the inventory, the blocks...) was reported as a failed
--     publish while prices and variants were already live, and nothing was revalidated;
--   * every product-values publish deleted and re-created the variants: new ids, so past order items
--     lost their variant link (order_items.variant_id ON DELETE SET NULL) and a cart line added before
--     the publish was refused at checkout as unavailable;
--   * pending scheduled variant prices (scheduled_price, scheduled_prices, scheduled_price_at, written
--     by the promotions import) were dropped by every product-values publish;
--   * History recorded nothing for a publish that only changed prices, variants, stock, the sale window
--     or the gallery: the revision content held the product columns and the blocks only.
--
-- public.publish_product_draft() replaces all of it with one call, made by the app after
-- requireCmsAdmin() (an ADMIN past the second factor). It refuses anyone but an ADMIN (is_admin(), as
-- every products write policy does: a remembered device is an aal1 session, so is_admin_mfa() would
-- refuse admins the app lets in), locks the products row and then the draft row (FOR UPDATE, always in
-- that order), and refuses with nothing written when:
--   * the draft is gone (NBP01): another publish or a discard deleted it first; a second publish that
--     waited on the lock lands here, so the description is replaced once;
--   * the draft changed since the app read it (NBP02: another id, or another updated_at, which
--     on_product_drafts_update moves on every UPDATE): a save that landed before the lock is kept in
--     the draft, and one that waits on the lock finds the row deleted (the app's save paths check the
--     rows their UPDATE returned and say so, or start a new draft);
--   * the product changed since the app read it (NBP03: another updated_at), because the values the
--     app completed from that read (completeProductDraftValues, planProductDraftOverlayPublish's
--     updated_at rule for a pre-0.23.4 snapshot) would revert the change.
-- Then it writes the product values (or the overlay fields), replaces the description blocks with the
-- draft's, records History when the content changed, and deletes the draft. Any error rolls all of it
-- back: nothing is half-published, and the draft stays for another try.
--
-- Product values (private.apply_product_draft_values) do what updateProduct() did, in the same order,
-- with these differences:
--   * variants are matched to the live ones by their set of attribute terms (the draft's own variant
--     id breaks a tie between live variants with the same set): a match is updated in place, keeping
--     its id, its order item links and its pending scheduled prices; only a live variant the draft no
--     longer has is deleted, and only a draft variant with a new term set is inserted;
--   * a variant image or gallery image that no longer has a media row is left out (the gallery already
--     was since 0.23.4), and so is a category that no longer exists, instead of failing the publish;
--   * products.status (visibility belongs to the row) and products.metadata are never written;
--   * the shared inventory is written through the caller's ADMIN session (inventory_items has ADMIN
--     write policies) instead of the service role.
-- A save path still never deletes media: the gallery is one upsert of the listed images and one unlink
-- of the rest; no media row is ever deleted here.
--
-- public.product_revision_content() is the History content of a product, in one place: the app's
-- getFullProductContent() (apps/nextblock/app/cms/revisions/utils.ts) reads it too. It keeps the
-- `meta` and `blocks` of earlier revisions and adds `commerce`: SKU, UPC, type and provider, prices,
-- sale prices and the sale window, pending scheduled prices, stock, taxability, the Freemius ids and
-- trial, the gallery's media ids, the category ids, and each variant's values and terms (by SKU,
-- without ids). A restore still replays only the title, descriptions, SEO fields and blocks.
--
-- Grants: EXECUTE for authenticated and service_role only. The post-apply grant pass grants EXECUTE on
-- every function in `public` to anon, so both public functions are also in API_ROLE_REVOKE_SQL
-- (apps/nextblock/tools/lib/migrate-core.mjs and apps/nextblock/lib/setup/schema-apply.ts). The three
-- helpers live in `private` (not exposed by PostgREST; the pass never touches it); the invoker needs
-- EXECUTE on them. tools/scripts/security-verify.sql section 44 checks the privileges and the behaviour,
-- and tools/scripts/product-draft-publish.db.test.ts runs two sessions against each other.

CREATE SCHEMA IF NOT EXISTS private;

-- ---------------------------------------------------------------------------
-- 1. The History content of a product
-- ---------------------------------------------------------------------------
-- Timestamps are written as Date#toISOString() writes them (millisecond precision, `Z`), as the app's
-- snapshots always were, so a value that round-trips through the database is never a phantom change.
CREATE OR REPLACE FUNCTION public.product_revision_content(p_product_id uuid)
    RETURNS jsonb
    LANGUAGE sql STABLE SECURITY INVOKER
    SET search_path TO ''
    AS $$
  SELECT jsonb_build_object(
    'meta', jsonb_build_object(
      'title', p.title,
      'slug', p.slug,
      'language_id', p.language_id,
      'status', p.status,
      'meta_title', p.meta_title,
      'meta_description', p.meta_description,
      'custom_canonical', p.custom_canonical,
      'published_at', to_char(p.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'short_description', p.short_description,
      'description_json', p.description_json
    ),
    -- Ordered by "order" then id: revision blocks carry no id, so their position is their identity.
    'blocks', COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'language_id', b.language_id,
                 'block_type', b.block_type,
                 'content', b.content,
                 'order', b."order"
               )
               ORDER BY b."order", b.id
             )
        FROM public.blocks b
       WHERE b.product_id = p.id
    ), '[]'::jsonb),
    'commerce', jsonb_build_object(
      'sku', p.sku,
      'upc', p.upc,
      'product_type', p.product_type,
      'payment_provider', p.payment_provider,
      'price', p.price,
      'prices', p.prices,
      'sale_price', p.sale_price,
      'sale_prices', p.sale_prices,
      'sale_start_at', to_char(p.sale_start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'sale_end_at', to_char(p.sale_end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'scheduled_price', p.scheduled_price,
      'scheduled_prices', p.scheduled_prices,
      'scheduled_price_at', to_char(p.scheduled_price_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'stock', p.stock,
      'is_taxable', p.is_taxable,
      'freemius_product_id', p.freemius_product_id,
      'freemius_plan_id', p.freemius_plan_id,
      'trial_period_days', p.trial_period_days,
      'trial_requires_payment_method', p.trial_requires_payment_method,
      'gallery', COALESCE((
        SELECT jsonb_agg(pm.media_id ORDER BY pm.sort_order NULLS LAST, pm.media_id)
          FROM public.product_media pm
         WHERE pm.product_id = p.id
      ), '[]'::jsonb),
      'category_ids', COALESCE((
        SELECT jsonb_agg(pc.category_id ORDER BY pc.category_id)
          FROM public.product_categories pc
         WHERE pc.product_id = p.id
      ), '[]'::jsonb),
      'variants', COALESCE((
        SELECT jsonb_agg(
                 jsonb_build_object(
                   'sku', v.sku,
                   'upc', v.upc,
                   'price', v.price,
                   'prices', v.prices,
                   'sale_price', v.sale_price,
                   'sale_prices', v.sale_prices,
                   'sale_start_at', to_char(v.sale_start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                   'sale_end_at', to_char(v.sale_end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                   'scheduled_price', v.scheduled_price,
                   'scheduled_prices', v.scheduled_prices,
                   'scheduled_price_at', to_char(v.scheduled_price_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                   'stock_quantity', v.stock_quantity,
                   'main_media_id', v.main_media_id,
                   'attribute_term_ids', COALESCE((
                     SELECT jsonb_agg(m.attribute_term_id ORDER BY m.attribute_term_id)
                       FROM public.variant_attribute_mapping m
                      WHERE m.variant_id = v.id
                   ), '[]'::jsonb)
                 )
                 ORDER BY v.sku, v.id
               )
          FROM public.product_variants v
         WHERE v.product_id = p.id
      ), '[]'::jsonb)
    )
  )
  FROM public.products p
  WHERE p.id = p_product_id;
$$;

REVOKE ALL ON FUNCTION public.product_revision_content(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.product_revision_content(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Variants, matched to the live ones by their attribute terms
-- ---------------------------------------------------------------------------
-- Called only by private.apply_product_draft_values(). `p_variants` is the draft's list in minor units
-- (serializeVariantsForRpc in libs/ecommerce product-actions.ts). A draft variant takes the first live
-- variant not yet taken whose set of attribute terms equals its own, preferring the live variant with
-- the draft variant's own id; that row is updated in place (same id, so order items keep their link,
-- carts keep their line, and scheduled prices stay pending). Live variants left over are deleted (their
-- mappings cascade), and draft variants left over are inserted with their mappings. A kept variant
-- whose SKU changes first takes a temporary SKU, because product_variants_product_id_sku_key is
-- checked row by row and two kept variants may swap SKUs.
CREATE OR REPLACE FUNCTION private.sync_product_draft_variants(p_product_id uuid, p_variants jsonb)
    RETURNS void
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path TO ''
    AS $$
DECLARE
  v_uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_live_ids uuid[];
  v_live_keys text[];
  v_taken boolean[];
  v_live_count integer;
  v_variant jsonb;
  v_key text;
  v_draft_id uuid;
  v_match integer;
  v_i integer;
  v_matched_ids uuid[] := '{}';
  v_matched_variants jsonb[] := '{}';
  v_new_variants jsonb[] := '{}';
  v_delete_ids uuid[];
  v_variant_id uuid;
BEGIN
  IF p_variants IS NULL OR jsonb_typeof(p_variants) <> 'array' THEN
    RAISE EXCEPTION 'The draft''s variants are not a list.' USING ERRCODE = 'NBP04';
  END IF;

  -- The live variants and their term sets, oldest first.
  SELECT COALESCE(array_agg(v.id ORDER BY v.created_at, v.id), '{}'),
         COALESCE(array_agg(COALESCE(k.term_key, '') ORDER BY v.created_at, v.id), '{}')
    INTO v_live_ids, v_live_keys
    FROM public.product_variants v
    LEFT JOIN LATERAL (
      SELECT string_agg(m.attribute_term_id::text, ',' ORDER BY m.attribute_term_id) AS term_key
        FROM public.variant_attribute_mapping m
       WHERE m.variant_id = v.id
    ) k ON true
   WHERE v.product_id = p_product_id;

  v_live_count := COALESCE(array_length(v_live_ids, 1), 0);
  v_taken := array_fill(false, ARRAY[v_live_count]);

  FOR v_variant IN SELECT value FROM jsonb_array_elements(p_variants) LOOP
    IF jsonb_typeof(v_variant) <> 'object' THEN
      RAISE EXCEPTION 'A draft variant is not an object.' USING ERRCODE = 'NBP04';
    END IF;

    v_key := COALESCE((
      SELECT string_agg(t.term_id::text, ',' ORDER BY t.term_id)
        FROM (
          SELECT DISTINCT value::uuid AS term_id
            FROM jsonb_array_elements_text(COALESCE(v_variant->'attribute_term_ids', '[]'::jsonb))
        ) t
    ), '');

    v_draft_id := CASE
      WHEN lower(COALESCE(v_variant->>'id', '')) ~ v_uuid_pattern THEN (v_variant->>'id')::uuid
    END;

    v_match := NULL;
    IF v_draft_id IS NOT NULL THEN
      v_i := array_position(v_live_ids, v_draft_id);
      IF v_i IS NOT NULL AND NOT v_taken[v_i] AND v_live_keys[v_i] = v_key THEN
        v_match := v_i;
      END IF;
    END IF;
    IF v_match IS NULL THEN
      FOR v_i IN 1 .. v_live_count LOOP
        IF NOT v_taken[v_i] AND v_live_keys[v_i] = v_key THEN
          v_match := v_i;
          EXIT;
        END IF;
      END LOOP;
    END IF;

    IF v_match IS NULL THEN
      v_new_variants := array_append(v_new_variants, v_variant);
    ELSE
      v_taken[v_match] := true;
      v_matched_ids := array_append(v_matched_ids, v_live_ids[v_match]);
      v_matched_variants := array_append(v_matched_variants, v_variant);
    END IF;
  END LOOP;

  -- 1. Live variants the draft no longer has. Their order items keep the line and lose the link
  --    (order_items_variant_id_fkey is ON DELETE SET NULL), as before.
  SELECT COALESCE(array_agg(l.id), '{}')
    INTO v_delete_ids
    FROM unnest(v_live_ids) WITH ORDINALITY AS l(id, n)
   WHERE NOT v_taken[l.n::integer];

  IF COALESCE(array_length(v_delete_ids, 1), 0) > 0 THEN
    DELETE FROM public.product_variants
     WHERE product_id = p_product_id
       AND id = ANY (v_delete_ids);
  END IF;

  -- 2. A kept variant whose SKU changes gives its old SKU up first.
  FOR v_i IN 1 .. COALESCE(array_length(v_matched_ids, 1), 0) LOOP
    UPDATE public.product_variants
       SET sku = '__nextblock_publish_' || id::text
     WHERE id = v_matched_ids[v_i]
       AND sku IS DISTINCT FROM (v_matched_variants[v_i]->>'sku');
  END LOOP;

  -- 3. Kept variants take the draft's values on the same row; scheduled prices stay as they are.
  FOR v_i IN 1 .. COALESCE(array_length(v_matched_ids, 1), 0) LOOP
    v_variant := v_matched_variants[v_i];
    UPDATE public.product_variants
       SET sku = v_variant->>'sku',
           upc = NULLIF(v_variant->>'upc', ''),
           price = COALESCE((v_variant->>'price')::integer, 0),
           prices = COALESCE(v_variant->'prices', '{}'::jsonb),
           sale_price = CASE
             WHEN v_variant ? 'sale_price' AND v_variant->>'sale_price' <> '' THEN (v_variant->>'sale_price')::integer
           END,
           sale_prices = CASE
             WHEN v_variant ? 'sale_prices' THEN COALESCE(v_variant->'sale_prices', '{}'::jsonb)
           END,
           sale_start_at = CASE
             WHEN v_variant ? 'sale_start_at' AND v_variant->>'sale_start_at' <> '' THEN (v_variant->>'sale_start_at')::timestamptz
           END,
           sale_end_at = CASE
             WHEN v_variant ? 'sale_end_at' AND v_variant->>'sale_end_at' <> '' THEN (v_variant->>'sale_end_at')::timestamptz
           END,
           stock_quantity = COALESCE((v_variant->>'stock_quantity')::integer, 0),
           main_media_id = (
             SELECT m.id
               FROM public.media m
              WHERE m.id = CASE
                WHEN lower(COALESCE(v_variant->>'main_media_id', '')) ~ v_uuid_pattern THEN lower(v_variant->>'main_media_id')::uuid
              END
           ),
           updated_at = now()
     WHERE id = v_matched_ids[v_i];
  END LOOP;

  -- 4. Draft variants with a term set no live variant has.
  FOREACH v_variant IN ARRAY v_new_variants LOOP
    INSERT INTO public.product_variants (
      product_id,
      sku,
      upc,
      price,
      prices,
      sale_price,
      sale_prices,
      sale_start_at,
      sale_end_at,
      stock_quantity,
      main_media_id
    )
    VALUES (
      p_product_id,
      v_variant->>'sku',
      NULLIF(v_variant->>'upc', ''),
      COALESCE((v_variant->>'price')::integer, 0),
      COALESCE(v_variant->'prices', '{}'::jsonb),
      CASE WHEN v_variant ? 'sale_price' AND v_variant->>'sale_price' <> '' THEN (v_variant->>'sale_price')::integer END,
      CASE WHEN v_variant ? 'sale_prices' THEN COALESCE(v_variant->'sale_prices', '{}'::jsonb) END,
      CASE WHEN v_variant ? 'sale_start_at' AND v_variant->>'sale_start_at' <> '' THEN (v_variant->>'sale_start_at')::timestamptz END,
      CASE WHEN v_variant ? 'sale_end_at' AND v_variant->>'sale_end_at' <> '' THEN (v_variant->>'sale_end_at')::timestamptz END,
      COALESCE((v_variant->>'stock_quantity')::integer, 0),
      (
        SELECT m.id
          FROM public.media m
         WHERE m.id = CASE
           WHEN lower(COALESCE(v_variant->>'main_media_id', '')) ~ v_uuid_pattern THEN lower(v_variant->>'main_media_id')::uuid
         END
      )
    )
    RETURNING id INTO v_variant_id;

    INSERT INTO public.variant_attribute_mapping (variant_id, attribute_term_id)
    SELECT DISTINCT v_variant_id, value::uuid
      FROM jsonb_array_elements_text(COALESCE(v_variant->'attribute_term_ids', '[]'::jsonb));
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION private.sync_product_draft_variants(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.sync_product_draft_variants(uuid, jsonb) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Product values: what updateProduct() wrote, in one statement list
-- ---------------------------------------------------------------------------
-- Called only by public.publish_product_draft(). `p_values` is built by buildProductDraftPublishValues
-- (libs/ecommerce product-actions.ts): the RPC payload of updateProduct() (minor units) without `id`,
-- `status`, `metadata` and `payment_provider`, plus the SEO fields, `gallery_media_ids` (null: leave the
-- gallery as it is) and `category_ids` (null: leave the categories as they are). The product row takes
-- the columns upsert_product_with_variants took (`payment_provider` follows `product_type`, the stock
-- of a product with variants is their sum), taxability and the SEO fields (blank becomes NULL).
-- It answers { stock_adjusted: [] }, which the publish below ignores: 02044 re-creates this helper to
-- answer the stock it adjusted, and a replay runs this file over that version (see the header). The
-- helper is dropped first all the same: a developer's database that ran this file before 2026-11-18,
-- and not yet 02044, holds a version returning void (no shared database ran it), and CREATE OR REPLACE
-- fails over another return type (42P13), which rolls a whole replay back. Nothing depends on the
-- helper (a plpgsql body is not tracked: the publish below calls it by name), so the drop takes
-- nothing else with it, and the grants after it are set again on the new one.
DROP FUNCTION IF EXISTS private.apply_product_draft_values(uuid, jsonb);

CREATE OR REPLACE FUNCTION private.apply_product_draft_values(p_product_id uuid, p_values jsonb)
    RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path TO ''
    AS $$
DECLARE
  v_uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_variants jsonb := COALESCE(p_values->'variants', '[]'::jsonb);
  v_has_variants boolean;
  v_total_variant_stock integer := 0;
  v_product_type text;
  v_translation_group_id uuid;
  v_saved record;
  v_sku_group uuid[];
  v_siblings uuid[];
  v_gallery uuid[];
  v_inventory_sku text;
BEGIN
  IF p_values IS NULL OR jsonb_typeof(p_values) <> 'object' THEN
    RAISE EXCEPTION 'The draft''s product values are not an object.' USING ERRCODE = 'NBP04';
  END IF;
  IF jsonb_typeof(v_variants) <> 'array' THEN
    RAISE EXCEPTION 'The draft''s variants are not a list.' USING ERRCODE = 'NBP04';
  END IF;

  v_has_variants := jsonb_array_length(v_variants) > 0;
  v_translation_group_id := CASE
    WHEN lower(COALESCE(p_values->>'translation_group_id', '')) ~ v_uuid_pattern THEN (p_values->>'translation_group_id')::uuid
  END;
  v_product_type := CASE
    WHEN p_values->>'product_type' IN ('physical', 'digital') THEN p_values->>'product_type'
    WHEN NULLIF(p_values->>'freemius_product_id', '') IS NOT NULL
      OR NULLIF(p_values->>'freemius_plan_id', '') IS NOT NULL THEN 'digital'
    ELSE 'physical'
  END;

  IF v_has_variants THEN
    SELECT COALESCE(SUM(COALESCE((value->>'stock_quantity')::integer, 0)), 0)
      INTO v_total_variant_stock
      FROM jsonb_array_elements(v_variants);
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
           ELSE COALESCE((p_values->>'stock')::integer, 0)
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

  -- The variants (section 2).
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

  -- The shared inventory: one row per SKU (a later variant with the same SKU wins). Its trigger writes
  -- the quantity back to every variant and product with that SKU.
  IF v_has_variants THEN
    INSERT INTO public.inventory_items (sku, quantity)
    SELECT DISTINCT ON (stock.sku) stock.sku, stock.quantity
      FROM (
        SELECT btrim(item.value->>'sku') AS sku,
               GREATEST(0, trunc(COALESCE((item.value->>'stock_quantity')::numeric, 0)))::integer AS quantity,
               item.ordinality
          FROM jsonb_array_elements(v_variants) WITH ORDINALITY AS item(value, ordinality)
      ) stock
     WHERE stock.sku <> ''
     ORDER BY stock.sku, stock.ordinality DESC
        ON CONFLICT (sku) DO UPDATE SET quantity = EXCLUDED.quantity;
  ELSE
    v_inventory_sku := btrim(p_values->>'sku');
    IF v_inventory_sku <> '' THEN
      INSERT INTO public.inventory_items (sku, quantity)
      VALUES (v_inventory_sku, GREATEST(0, trunc(COALESCE((p_values->>'stock')::numeric, 0)))::integer)
          ON CONFLICT (sku) DO UPDATE SET quantity = EXCLUDED.quantity;
    END IF;
  END IF;

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

  RETURN jsonb_build_object('stock_adjusted', '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION private.apply_product_draft_values(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.apply_product_draft_values(uuid, jsonb) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. History: one snapshot per publish that changed the content
-- ---------------------------------------------------------------------------
-- Called only by public.publish_product_draft(), with the content before and after its writes. A
-- revision chain needs a base: when no snapshot sits at or below the current version, the content
-- before is recorded first at that version (createRevisionInternal's ensureBaseSnapshot). The new
-- revision is always a full snapshot (the app's reader replays either kind), at the next free
-- version, and products.version moves to it. Another writer taking that version first (the app's
-- revision engine does not lock the product row) only moves this one to the next.
CREATE OR REPLACE FUNCTION private.record_product_revision(p_product_id uuid, p_before jsonb, p_after jsonb)
    RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path TO ''
    AS $$
DECLARE
  v_current integer;
  v_next integer;
  v_attempts integer := 0;
BEGIN
  SELECT COALESCE(p.version, 1) INTO v_current FROM public.products p WHERE p.id = p_product_id;

  IF p_after IS NULL OR p_before IS NOT DISTINCT FROM p_after THEN
    RETURN jsonb_build_object('recorded', false, 'version', v_current);
  END IF;

  IF p_before IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM public.product_revisions r
     WHERE r.product_id = p_product_id
       AND r.version <= v_current
       AND r.revision_type = 'snapshot'
  ) THEN
    INSERT INTO public.product_revisions (product_id, author_id, version, revision_type, content)
    VALUES (p_product_id, auth.uid(), v_current, 'snapshot', p_before)
        ON CONFLICT (product_id, version) DO NOTHING;
  END IF;

  LOOP
    SELECT GREATEST(v_current, COALESCE(max(r.version), 0)) + 1
      INTO v_next
      FROM public.product_revisions r
     WHERE r.product_id = p_product_id;

    BEGIN
      INSERT INTO public.product_revisions (product_id, author_id, version, revision_type, content)
      VALUES (p_product_id, auth.uid(), v_next, 'snapshot', p_after);
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_attempts := v_attempts + 1;
      IF v_attempts >= 5 THEN
        RAISE;
      END IF;
    END;
  END LOOP;

  UPDATE public.products SET version = v_next WHERE id = p_product_id;

  RETURN jsonb_build_object('recorded', true, 'version', v_next);
END;
$$;

REVOKE ALL ON FUNCTION private.record_product_revision(uuid, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.record_product_revision(uuid, jsonb, jsonb) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. The publish
-- ---------------------------------------------------------------------------
-- p_draft_id / p_draft_updated_at: the draft row as the app read it. p_product_updated_at: the products
-- row's updated_at as the app read it (NULL when the column is NULL). p_values: the product values
-- (section 3), or NULL for a draft that holds none. p_overlay: { title?, short_description?,
-- description_json? } for an overlay or a pre-0.23.4 snapshot (planProductDraftOverlayPublish: only
-- the fields to write; nothing else in it is read), or NULL. p_blocks: the draft's description blocks
-- as [{ language_id, block_type, content, order }], which replace the live ones ([] deletes them).
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
  v_slug text;
  v_payment_provider text;
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
    PERFORM private.apply_product_draft_values(p_product_id, p_values);
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
    'revision', v_revision
  );
END;
$$;

REVOKE ALL ON FUNCTION public.publish_product_draft(uuid, bigint, timestamp with time zone, timestamp with time zone, jsonb, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.publish_product_draft(uuid, bigint, timestamp with time zone, timestamp with time zone, jsonb, jsonb, jsonb) TO authenticated, service_role;
