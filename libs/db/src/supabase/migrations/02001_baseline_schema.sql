-- AUTO-GENERATED baseline: squash generation 2 (of migrations 00000000000000..00000000000042).
-- 001 · schema: enums, functions, tables, sequences, defaults
-- Idempotent; safe to replay. Regenerate via tools/scripts/rebaseline-transform.mjs — do not hand-edit.
-- Naming: GGNNN_name.sql (GG = squash generation, NNN = sequence). See docs/04-DATABASE-AND-AUTH.md.

SET check_function_bodies = false;

CREATE SCHEMA IF NOT EXISTS public;

COMMENT ON SCHEMA public IS 'standard public schema';

DO $rb$ BEGIN
CREATE TYPE public.approval_status AS ENUM (
    'pending',
    'approved',
    'denied'
);
EXCEPTION WHEN duplicate_object THEN null; END $rb$;

DO $rb$ BEGIN
CREATE TYPE public.interaction_type AS ENUM (
    'review',
    'comment'
);
EXCEPTION WHEN duplicate_object THEN null; END $rb$;

DO $rb$ BEGIN
CREATE TYPE public.menu_location AS ENUM (
    'HEADER',
    'FOOTER',
    'SIDEBAR'
);
EXCEPTION WHEN duplicate_object THEN null; END $rb$;

DO $rb$ BEGIN
CREATE TYPE public.page_status AS ENUM (
    'draft',
    'published',
    'archived'
);
EXCEPTION WHEN duplicate_object THEN null; END $rb$;

DO $rb$ BEGIN
CREATE TYPE public.revision_type AS ENUM (
    'snapshot',
    'diff'
);
EXCEPTION WHEN duplicate_object THEN null; END $rb$;

DO $rb$ BEGIN
CREATE TYPE public.user_role AS ENUM (
    'ADMIN',
    'WRITER',
    'USER'
);
EXCEPTION WHEN duplicate_object THEN null; END $rb$;

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

CREATE OR REPLACE FUNCTION public.assign_order_invoice_metadata(p_order_id uuid, p_paid_at timestamp with time zone DEFAULT now()) RETURNS TABLE(invoice_number text, paid_at timestamp with time zone)
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_effective_paid_at timestamptz;
BEGIN
  SELECT *
    INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order % not found', p_order_id;
  END IF;

  v_effective_paid_at := COALESCE(v_order.paid_at, p_paid_at, now(), v_order.created_at);

  UPDATE public.orders
  SET
    invoice_number = COALESCE(v_order.invoice_number, public.generate_order_invoice_number()),
    paid_at = v_effective_paid_at
  WHERE id = p_order_id
  RETURNING orders.invoice_number, orders.paid_at
  INTO invoice_number, paid_at;

  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.clear_currency_price_overrides(target_currency text) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
  v_target_currency text := upper(trim(target_currency));
BEGIN
  IF v_target_currency = '' THEN
    RETURN;
  END IF;

  UPDATE public.products
  SET
    prices = COALESCE(prices, '{}'::jsonb) - v_target_currency,
    sale_prices = CASE
      WHEN sale_prices IS NULL THEN NULL
      WHEN sale_prices - v_target_currency = '{}'::jsonb THEN NULL
      ELSE sale_prices - v_target_currency
    END,
    updated_at = now()
  WHERE COALESCE(prices, '{}'::jsonb) ? v_target_currency
     OR COALESCE(sale_prices, '{}'::jsonb) ? v_target_currency;

  UPDATE public.product_variants
  SET
    prices = COALESCE(prices, '{}'::jsonb) - v_target_currency,
    sale_prices = CASE
      WHEN sale_prices IS NULL THEN NULL
      WHEN sale_prices - v_target_currency = '{}'::jsonb THEN NULL
      ELSE sale_prices - v_target_currency
    END,
    updated_at = now()
  WHERE COALESCE(prices, '{}'::jsonb) ? v_target_currency
     OR COALESCE(sale_prices, '{}'::jsonb) ? v_target_currency;
END;
$$;

CREATE OR REPLACE FUNCTION public.is_valid_custom_block_fields(candidate jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $_$
  SELECT CASE
    WHEN jsonb_typeof(candidate) <> 'array' THEN false
    ELSE
      NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(candidate) AS field(value)
        WHERE jsonb_typeof(field.value) <> 'object'
          OR jsonb_typeof(field.value -> 'key') IS DISTINCT FROM 'string'
          OR jsonb_typeof(field.value -> 'label') IS DISTINCT FROM 'string'
          OR jsonb_typeof(field.value -> 'type') IS DISTINCT FROM 'string'
          OR field.value ->> 'key' !~ '^[a-z][a-z0-9_]*$'
          OR field.value ->> 'type' NOT IN ('text', 'rich-text', 'image_r2', 'db_relation')
      )
      AND (
        SELECT COUNT(*) = COUNT(DISTINCT field.value ->> 'key')
        FROM jsonb_array_elements(candidate) AS field(value)
      )
  END;
$_$;

CREATE OR REPLACE FUNCTION public.is_valid_custom_block_layout_schema(candidate jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  SELECT CASE
    WHEN jsonb_typeof(candidate) <> 'object' THEN false
    ELSE candidate ->> 'type' IN ('container', 'field_render')
  END;
$$;

CREATE TABLE IF NOT EXISTS public.custom_block_definitions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    fields jsonb DEFAULT '[]'::jsonb NOT NULL,
    layout_schema jsonb NOT NULL,
    is_original boolean DEFAULT true NOT NULL,
    CONSTRAINT custom_block_definitions_fields_check CHECK (public.is_valid_custom_block_fields(fields)),
    CONSTRAINT custom_block_definitions_layout_schema_check CHECK (public.is_valid_custom_block_layout_schema(layout_schema)),
    CONSTRAINT custom_block_definitions_name_check CHECK ((length(TRIM(BOTH FROM name)) > 0)),
    CONSTRAINT custom_block_definitions_slug_check CHECK ((slug ~ '^[a-z][a-z0-9-]*$'::text))
);

COMMENT ON TABLE public.custom_block_definitions IS 'Registry for user-created block definitions rendered from database JSONB without runtime code compilation.';

COMMENT ON COLUMN public.custom_block_definitions.fields IS 'Strict JSONB field declarations for data-rendered custom blocks.';

COMMENT ON COLUMN public.custom_block_definitions.layout_schema IS 'Open-ended recursive layout schema consumed by the dynamic layout renderer.';

COMMENT ON COLUMN public.custom_block_definitions.is_original IS 'False when a definition was created by duplicating an existing registry row.';

CREATE OR REPLACE FUNCTION public.duplicate_block_definition(target_id uuid) RETURNS public.custom_block_definitions
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $_$
DECLARE
  source_definition public.custom_block_definitions%ROWTYPE;
  copied_definition public.custom_block_definitions%ROWTYPE;
  base_slug text;
  copy_slug text;
  copy_index integer := 1;
BEGIN
  IF auth.role() <> 'service_role'
     AND COALESCE((SELECT public.get_current_user_role())::text, '') NOT IN ('ADMIN', 'WRITER') THEN
    RAISE EXCEPTION 'Not authorized to duplicate custom block definitions.'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO source_definition
  FROM public.custom_block_definitions
  WHERE id = target_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Custom block definition % not found.', target_id
      USING ERRCODE = 'P0002';
  END IF;

  base_slug := regexp_replace(source_definition.slug, '-copy(-[0-9]+)?$', '');
  copy_slug := base_slug || '-copy';

  WHILE EXISTS (
    SELECT 1
    FROM public.custom_block_definitions
    WHERE slug = copy_slug
  ) LOOP
    copy_index := copy_index + 1;
    copy_slug := base_slug || '-copy-' || copy_index;
  END LOOP;

  INSERT INTO public.custom_block_definitions (
    id,
    slug,
    name,
    description,
    fields,
    layout_schema,
    is_original
  )
  VALUES (
    gen_random_uuid(),
    copy_slug,
    source_definition.name || ' Copy',
    source_definition.description,
    source_definition.fields,
    source_definition.layout_schema,
    false
  )
  RETURNING *
    INTO copied_definition;

  RETURN copied_definition;
END;
$_$;

CREATE OR REPLACE FUNCTION public.format_order_invoice_number(p_value bigint) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  SELECT 'INV-' || lpad(p_value::text, 6, '0');
$$;

CREATE OR REPLACE FUNCTION public.generate_order_invoice_number() RETURNS text
    LANGUAGE sql
    SET search_path TO ''
    AS $$
  SELECT public.format_order_invoice_number(nextval('public.order_invoice_number_seq'));
$$;

CREATE OR REPLACE FUNCTION public.get_current_user_role() RETURNS public.user_role
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.get_default_currency_code() RETURNS text
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  SELECT COALESCE(
    (
      SELECT upper(code)
      FROM public.currencies
      WHERE is_default = true
      ORDER BY updated_at DESC, created_at DESC, code ASC
      LIMIT 1
    ),
    'USD'
  );
$$;

CREATE OR REPLACE FUNCTION public.get_ecommerce_track_quantities() RETURNS boolean
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
DECLARE
  v_value jsonb;
  v_raw text;
BEGIN
  SELECT value
    INTO v_value
  FROM public.site_settings
  WHERE key = 'ecommerce_inventory_settings';

  IF v_value IS NULL THEN
    RETURN true;
  END IF;

  IF jsonb_typeof(v_value) = 'object' THEN
    v_raw := NULLIF(v_value->>'track_quantities', '');
  ELSE
    v_raw := NULLIF(trim(BOTH '"' FROM v_value::text), '');
  END IF;

  IF v_raw IS NULL THEN
    RETURN true;
  END IF;

  IF lower(v_raw) IN ('false', 'f', '0', 'no', 'off') THEN
    RETURN false;
  END IF;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_my_claim(claim text) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  SELECT COALESCE(current_setting('request.jwt.claims', true)::jsonb ->> claim, NULL)::jsonb
$$;

CREATE OR REPLACE FUNCTION public.handle_blocks_update() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_coupon_freemius_mappings_write() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  NEW.freemius_product_id := btrim(NEW.freemius_product_id);
  NEW.freemius_coupon_code := upper(regexp_replace(btrim(NEW.freemius_coupon_code), '\s+', '', 'g'));
  NEW.sync_status := lower(btrim(COALESCE(NEW.sync_status, 'pending')));
  NEW.updated_at := now();

  IF NEW.created_at IS NULL THEN
    NEW.created_at := now();
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_coupons_write() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  NEW.code := upper(regexp_replace(btrim(NEW.code), '\s+', '', 'g'));
  NEW.name := btrim(NEW.name);
  NEW.provider_scope := lower(btrim(NEW.provider_scope));
  NEW.discount_type := lower(btrim(NEW.discount_type));
  NEW.freemius_sync_status := lower(btrim(COALESCE(NEW.freemius_sync_status, 'not_synced')));
  NEW.updated_at := now();

  IF NEW.created_at IS NULL THEN
    NEW.created_at := now();
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_default_currency_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.is_default THEN
      PERFORM public.sync_legacy_price_columns_for_currency(NEW.code);
    END IF;
  ELSIF NEW.is_default
        AND (
          OLD.is_default IS DISTINCT FROM NEW.is_default
          OR OLD.code IS DISTINCT FROM NEW.code
        ) THEN
    PERFORM public.sync_legacy_price_columns_for_currency(NEW.code);
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_default_theme_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  IF NEW.is_default THEN
    UPDATE public.site_themes
       SET is_default = false
     WHERE id <> NEW.id AND is_default;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_inventory_item_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  v_sku text := COALESCE(NEW.sku, OLD.sku);
BEGIN
  PERFORM public.sync_inventory_cache_for_sku(v_sku);
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_inventory_items_update() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_languages_update() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_media_update() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_navigation_items_update() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  admin_flag_set boolean := false;
  user_role public.user_role;
  v_full_name text;
  v_avatar_url text;
BEGIN
  INSERT INTO public.site_settings (key, value)
  VALUES ('is_admin_created', 'false'::jsonb)
  ON CONFLICT (key) DO NOTHING;

  SELECT COALESCE(value::jsonb::boolean, false)
    INTO admin_flag_set
  FROM public.site_settings
  WHERE key = 'is_admin_created'
  FOR UPDATE;

  IF admin_flag_set = false THEN
    user_role := 'ADMIN'::public.user_role;

    UPDATE public.site_settings
    SET value = 'true'::jsonb
    WHERE key = 'is_admin_created';
  ELSE
    user_role := 'USER'::public.user_role;
  END IF;

  v_full_name := NEW.raw_user_meta_data->>'full_name';
  v_avatar_url := NEW.raw_user_meta_data->>'avatar_url';

  INSERT INTO public.profiles (
    id,
    role,
    full_name,
    avatar_url
  )
  VALUES (
    NEW.id,
    user_role,
    v_full_name,
    v_avatar_url
  )
  ON CONFLICT (id) DO UPDATE SET
    full_name = EXCLUDED.full_name,
    avatar_url = EXCLUDED.avatar_url;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_pages_update() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_posts_update() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_product_freemius_sale_coupons_write() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  NEW.freemius_product_id := btrim(NEW.freemius_product_id);
  NEW.freemius_coupon_code := upper(regexp_replace(btrim(NEW.freemius_coupon_code), '\s+', '', 'g'));
  NEW.sync_status := lower(btrim(COALESCE(NEW.sync_status, 'pending')));
  NEW.updated_at := now();

  IF NEW.created_at IS NULL THEN
    NEW.created_at := now();
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_shipping_zone_locations_write() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  NEW.country_code = upper(btrim(NEW.country_code));
  NEW.state_code = CASE
    WHEN NEW.state_code IS NULL OR btrim(NEW.state_code) = '' THEN NULL
    ELSE upper(btrim(NEW.state_code))
  END;
  NEW.postal_code = CASE
    WHEN NEW.postal_code IS NULL OR btrim(NEW.postal_code) = '' THEN NULL
    ELSE upper(btrim(NEW.postal_code))
  END;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_tax_rates_write() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  NEW.country_code = upper(btrim(NEW.country_code));
  NEW.state_code = CASE
    WHEN NEW.state_code IS NULL OR btrim(NEW.state_code) = '' THEN NULL
    ELSE upper(btrim(NEW.state_code))
  END;
  NEW.tax_name = btrim(NEW.tax_name);
  NEW.updated_at = now();

  IF NEW.created_at IS NULL THEN
    NEW.created_at = now();
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_ucp_cart_sessions_update() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT role = 'ADMIN' FROM public.profiles WHERE id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.is_valid_currency_amount_map(amounts jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $_$
  SELECT CASE
    WHEN amounts IS NULL THEN false
    WHEN jsonb_typeof(amounts) <> 'object' THEN false
    WHEN amounts = '{}'::jsonb THEN false
    ELSE NOT EXISTS (
      SELECT 1
      FROM jsonb_each(amounts) AS entry
      WHERE entry.key !~ '^[A-Z]{3}$'
        OR jsonb_typeof(entry.value) <> 'number'
        OR entry.value::text !~ '^[0-9]+$'
    )
  END;
$_$;

CREATE OR REPLACE FUNCTION public.is_valid_sale_price_map(prices jsonb, sale_prices jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $_$
  SELECT CASE
    WHEN sale_prices IS NULL THEN true
    WHEN jsonb_typeof(sale_prices) <> 'object' THEN false
    WHEN sale_prices = '{}'::jsonb THEN true
    WHEN prices IS NULL OR jsonb_typeof(prices) <> 'object' THEN false
    ELSE NOT EXISTS (
      SELECT 1
      FROM jsonb_each(sale_prices) AS entry
      WHERE entry.key !~ '^[A-Z]{3}$'
        OR NOT (prices ? entry.key)
        OR jsonb_typeof(entry.value) <> 'number'
        OR entry.value::text !~ '^[0-9]+$'
        OR entry.value::text::numeric > (prices ->> entry.key)::numeric
    )
  END;
$_$;

CREATE OR REPLACE FUNCTION public.normalize_currency_amount_map(amounts jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $_$
  SELECT CASE
    WHEN amounts IS NULL THEN '{}'::jsonb
    WHEN jsonb_typeof(amounts) <> 'object' THEN amounts
    ELSE COALESCE(
      (
        SELECT jsonb_object_agg(
          upper(trim(entry.key)),
          CASE
            WHEN jsonb_typeof(entry.value) = 'number'
                 AND entry.value::text ~ '^[0-9]+$' THEN
              to_jsonb((entry.value::text)::bigint)
            ELSE
              entry.value
          END
        )
        FROM jsonb_each(amounts) AS entry
      ),
      '{}'::jsonb
    )
  END;
$_$;

CREATE OR REPLACE FUNCTION public.prevent_site_script_revision_rewrite() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  RAISE EXCEPTION 'site_script_revisions is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_system_theme_delete() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  IF OLD.is_system THEN
    RAISE EXCEPTION 'Theme "%" is a system theme and cannot be deleted', OLD.slug
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_thread_message_rewrite() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'thread_messages is append-only; DELETE is not permitted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.body IS DISTINCT FROM OLD.body
     OR NEW.direction IS DISTINCT FROM OLD.direction
     OR NEW.thread_id IS DISTINCT FROM OLD.thread_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'thread_messages content is append-only; only delivery flags may change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_currency_defaults() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  NEW.code := upper(trim(NEW.code));
  NEW.updated_at := now();

  IF NEW.is_default THEN
    NEW.is_active := true;
    NEW.exchange_rate := 1;
    NEW.auto_update_exchange_rate := false;
    NEW.auto_sync_product_prices := false;
    NEW.exchange_rate_source := COALESCE(NULLIF(NEW.exchange_rate_source, ''), 'store-default');
    NEW.exchange_rate_updated_at := COALESCE(NEW.exchange_rate_updated_at, now());

    UPDATE public.currencies
    SET is_default = false,
        updated_at = now()
    WHERE id IS DISTINCT FROM NEW.id
      AND is_default = true;
  ELSIF NULLIF(NEW.exchange_rate_source, '') IS NULL THEN
    NEW.exchange_rate_source := NULL;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_current_timestamp_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
  _new record;
BEGIN
  _new := NEW;
  _new.updated_at = now();
  RETURN _new;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_currency_price_maps() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
  v_default_currency text := public.get_default_currency_code();
  v_price_map_changed boolean := false;
  v_legacy_changed boolean := false;
BEGIN
  NEW.prices := public.normalize_currency_amount_map(COALESCE(NEW.prices, '{}'::jsonb));
  NEW.sale_prices := public.normalize_currency_amount_map(COALESCE(NEW.sale_prices, '{}'::jsonb));

  IF NEW.sale_prices = '{}'::jsonb THEN
    NEW.sale_prices := NULL;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    v_price_map_changed :=
      NEW.prices IS DISTINCT FROM OLD.prices
      OR NEW.sale_prices IS DISTINCT FROM OLD.sale_prices;
    v_legacy_changed :=
      NEW.price IS DISTINCT FROM OLD.price
      OR NEW.sale_price IS DISTINCT FROM OLD.sale_price;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.prices ? v_default_currency THEN
      NEW.price := (NEW.prices ->> v_default_currency)::integer;
    ELSE
      NEW.prices := NEW.prices || jsonb_build_object(
        v_default_currency,
        GREATEST(COALESCE(NEW.price, 0), 0)
      );
    END IF;

    IF NEW.sale_prices IS NOT NULL AND NEW.sale_prices ? v_default_currency THEN
      NEW.sale_price := (NEW.sale_prices ->> v_default_currency)::integer;
    ELSIF NEW.sale_price IS NOT NULL THEN
      NEW.sale_prices := COALESCE(NEW.sale_prices, '{}'::jsonb)
        || jsonb_build_object(v_default_currency, GREATEST(NEW.sale_price, 0));
    END IF;

    RETURN NEW;
  END IF;

  IF v_price_map_changed AND NOT v_legacy_changed THEN
    IF NOT (NEW.prices ? v_default_currency) THEN
      NEW.prices := NEW.prices || jsonb_build_object(
        v_default_currency,
        GREATEST(COALESCE(OLD.price, NEW.price, 0), 0)
      );
    END IF;

    NEW.price := (NEW.prices ->> v_default_currency)::integer;
    NEW.sale_price := CASE
      WHEN NEW.sale_prices IS NOT NULL AND NEW.sale_prices ? v_default_currency THEN
        (NEW.sale_prices ->> v_default_currency)::integer
      ELSE
        NULL
    END;

    RETURN NEW;
  END IF;

  NEW.prices := NEW.prices || jsonb_build_object(
    v_default_currency,
    GREATEST(COALESCE(NEW.price, 0), 0)
  );

  IF NEW.sale_price IS NULL THEN
    IF NEW.sale_prices IS NOT NULL THEN
      NEW.sale_prices := NEW.sale_prices - v_default_currency;

      IF NEW.sale_prices = '{}'::jsonb THEN
        NEW.sale_prices := NULL;
      END IF;
    END IF;
  ELSE
    NEW.sale_prices := COALESCE(NEW.sale_prices, '{}'::jsonb)
      || jsonb_build_object(v_default_currency, GREATEST(NEW.sale_price, 0));
  END IF;

  RETURN NEW;
END;
$$;

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
    stock = COALESCE((
      SELECT SUM(COALESCE(inventory.quantity, 0))
      FROM public.product_variants AS variants
      LEFT JOIN public.inventory_items AS inventory
        ON inventory.sku = variants.sku
      WHERE variants.product_id = products.id
    ), 0),
    updated_at = now()
  WHERE EXISTS (
    SELECT 1
    FROM public.product_variants AS variants
    WHERE variants.product_id = products.id
      AND variants.sku = p_sku
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_legacy_price_columns_for_currency(target_currency text) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
  v_target_currency text := upper(trim(target_currency));
BEGIN
  UPDATE public.products
  SET
    prices = CASE
      WHEN COALESCE(prices, '{}'::jsonb) ? v_target_currency THEN prices
      ELSE COALESCE(prices, '{}'::jsonb) || jsonb_build_object(v_target_currency, price)
    END,
    sale_prices = CASE
      WHEN sale_price IS NULL THEN sale_prices
      WHEN sale_prices IS NOT NULL AND sale_prices ? v_target_currency THEN sale_prices
      ELSE COALESCE(sale_prices, '{}'::jsonb) || jsonb_build_object(v_target_currency, sale_price)
    END,
    price = CASE
      WHEN COALESCE(prices, '{}'::jsonb) ? v_target_currency THEN
        (COALESCE(prices, '{}'::jsonb) ->> v_target_currency)::integer
      ELSE
        price
    END,
    sale_price = CASE
      WHEN sale_prices IS NOT NULL AND sale_prices ? v_target_currency THEN
        (sale_prices ->> v_target_currency)::integer
      ELSE
        sale_price
    END,
    updated_at = now()
  WHERE
    NOT (COALESCE(prices, '{}'::jsonb) ? v_target_currency)
    OR (
      sale_price IS NOT NULL
      AND (sale_prices IS NULL OR NOT (sale_prices ? v_target_currency))
    )
    OR (
      COALESCE(prices, '{}'::jsonb) ? v_target_currency
      AND price IS DISTINCT FROM (COALESCE(prices, '{}'::jsonb) ->> v_target_currency)::integer
    )
    OR (
      sale_prices IS NOT NULL
      AND sale_prices ? v_target_currency
      AND sale_price IS DISTINCT FROM (sale_prices ->> v_target_currency)::integer
    );

  UPDATE public.product_variants
  SET
    prices = CASE
      WHEN COALESCE(prices, '{}'::jsonb) ? v_target_currency THEN prices
      ELSE COALESCE(prices, '{}'::jsonb) || jsonb_build_object(v_target_currency, price)
    END,
    sale_prices = CASE
      WHEN sale_price IS NULL THEN sale_prices
      WHEN sale_prices IS NOT NULL AND sale_prices ? v_target_currency THEN sale_prices
      ELSE COALESCE(sale_prices, '{}'::jsonb) || jsonb_build_object(v_target_currency, sale_price)
    END,
    price = CASE
      WHEN COALESCE(prices, '{}'::jsonb) ? v_target_currency THEN
        (COALESCE(prices, '{}'::jsonb) ->> v_target_currency)::integer
      ELSE
        price
    END,
    sale_price = CASE
      WHEN sale_prices IS NOT NULL AND sale_prices ? v_target_currency THEN
        (sale_prices ->> v_target_currency)::integer
      ELSE
        sale_price
    END,
    updated_at = now()
  WHERE
    NOT (COALESCE(prices, '{}'::jsonb) ? v_target_currency)
    OR (
      sale_price IS NOT NULL
      AND (sale_prices IS NULL OR NOT (sale_prices ? v_target_currency))
    )
    OR (
      COALESCE(prices, '{}'::jsonb) ? v_target_currency
      AND price IS DISTINCT FROM (COALESCE(prices, '{}'::jsonb) ->> v_target_currency)::integer
    )
    OR (
      sale_prices IS NOT NULL
      AND sale_prices ? v_target_currency
      AND sale_price IS DISTINCT FROM (sale_prices ->> v_target_currency)::integer
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_shipping_method_currency_maps() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
  v_source_currency text;
BEGIN
  v_source_currency := upper(trim(COALESCE(NULLIF(NEW.cost_currency, ''), public.get_default_currency_code())));

  NEW.cost_currency := v_source_currency;
  NEW.currency_pricing_mode := COALESCE(NULLIF(lower(trim(NEW.currency_pricing_mode)), ''), 'auto');
  NEW.cost_amounts := public.normalize_currency_amount_map(COALESCE(NEW.cost_amounts, '{}'::jsonb));
  NEW.min_order_amounts := public.normalize_currency_amount_map(COALESCE(NEW.min_order_amounts, '{}'::jsonb));

  IF NEW.currency_pricing_mode NOT IN ('auto', 'manual') THEN
    RAISE EXCEPTION 'Unsupported shipping currency pricing mode: %', NEW.currency_pricing_mode;
  END IF;

  IF NEW.cost_amounts = '{}'::jsonb THEN
    NEW.cost_amounts := jsonb_build_object(v_source_currency, GREATEST(COALESCE(NEW.cost_amount, 0), 0));
  ELSIF NOT (NEW.cost_amounts ? v_source_currency) THEN
    NEW.cost_amounts := NEW.cost_amounts || jsonb_build_object(
      v_source_currency,
      GREATEST(COALESCE(NEW.cost_amount, 0), 0)
    );
  END IF;

  IF NEW.min_order_amounts = '{}'::jsonb THEN
    NEW.min_order_amounts := jsonb_build_object(
      v_source_currency,
      GREATEST(COALESCE(NEW.min_order_amount, 0), 0)
    );
  ELSIF NOT (NEW.min_order_amounts ? v_source_currency) THEN
    NEW.min_order_amounts := NEW.min_order_amounts || jsonb_build_object(
      v_source_currency,
      GREATEST(COALESCE(NEW.min_order_amount, 0), 0)
    );
  END IF;

  IF NEW.currency_pricing_mode = 'auto' THEN
    NEW.cost_amounts := jsonb_build_object(
      v_source_currency,
      GREATEST((NEW.cost_amounts ->> v_source_currency)::integer, 0)
    );
    NEW.min_order_amounts := jsonb_build_object(
      v_source_currency,
      GREATEST((NEW.min_order_amounts ->> v_source_currency)::integer, 0)
    );
  END IF;

  NEW.cost_amount := GREATEST((NEW.cost_amounts ->> v_source_currency)::integer, 0);
  NEW.min_order_amount := GREATEST((NEW.min_order_amounts ->> v_source_currency)::integer, 0);
  NEW.updated_at := now();

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_product_ratings() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_product_id uuid;
  v_avg numeric(3,2);
  v_count integer;
BEGIN
  -- Determine which product_id we need to update
  IF TG_OP = 'DELETE' THEN
    v_product_id := OLD.product_id;
  ELSE
    v_product_id := NEW.product_id;
  END IF;

  IF v_product_id IS NOT NULL THEN
    -- Calculate average and count of approved reviews for this product
    SELECT COALESCE(avg(rating), 0.00), count(*)
    INTO v_avg, v_count
    FROM public.cms_interactions
    WHERE product_id = v_product_id
      AND type = 'review'
      AND status = 'approved';

    -- Update products table
    UPDATE public.products
    SET average_rating = ROUND(COALESCE(v_avg, 0.00), 2),
        total_reviews = v_count
    WHERE id = v_product_id;
  END IF;

  -- Handle old product_id if it changed on UPDATE (e.g. transfer of reviews)
  IF TG_OP = 'UPDATE' AND OLD.product_id IS NOT NULL AND OLD.product_id <> NEW.product_id THEN
    SELECT COALESCE(avg(rating), 0.00), count(*)
    INTO v_avg, v_count
    FROM public.cms_interactions
    WHERE product_id = OLD.product_id
      AND type = 'review'
      AND status = 'approved';

    UPDATE public.products
    SET average_rating = ROUND(COALESCE(v_avg, 0.00), 2),
        total_reviews = v_count
    WHERE id = OLD.product_id;
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.upsert_product_with_variants(product_payload jsonb) RETURNS uuid
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  v_product_id uuid := NULLIF(product_payload->>'id', '')::uuid;
  v_translation_group_id uuid := NULLIF(product_payload->>'translation_group_id', '')::uuid;
  v_product_type text := CASE
    WHEN product_payload->>'product_type' IN ('physical', 'digital') THEN
      product_payload->>'product_type'
    WHEN NULLIF(product_payload->>'freemius_product_id', '') IS NOT NULL
      OR NULLIF(product_payload->>'freemius_plan_id', '') IS NOT NULL THEN
      'digital'
    ELSE
      'physical'
  END;
  v_payment_provider text := CASE
    WHEN v_product_type = 'digital' THEN 'freemius'
    ELSE 'stripe'
  END;
  v_variants jsonb := COALESCE(product_payload->'variants', '[]'::jsonb);
  v_variant jsonb;
  v_variant_id uuid;
  v_term_id text;
  v_has_variants boolean := jsonb_typeof(v_variants) = 'array' AND jsonb_array_length(v_variants) > 0;
  v_total_variant_stock integer := 0;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  IF v_has_variants THEN
    SELECT COALESCE(SUM(COALESCE((value->>'stock_quantity')::integer, 0)), 0)
      INTO v_total_variant_stock
    FROM jsonb_array_elements(v_variants);
  END IF;

  IF v_product_id IS NULL THEN
    INSERT INTO public.products (
      title,
      slug,
      sku,
      product_type,
      payment_provider,
      upc,
      stock,
      status,
      short_description,
      description_json,
      metadata,
      price,
      prices,
      sale_price,
      sale_prices,
      sale_start_at,
      sale_end_at,
      freemius_plan_id,
      freemius_product_id,
      trial_period_days,
      trial_requires_payment_method,
      language_id,
      translation_group_id
    )
    VALUES (
      product_payload->>'title',
      product_payload->>'slug',
      product_payload->>'sku',
      v_product_type,
      v_payment_provider,
      NULLIF(product_payload->>'upc', ''),
      CASE
        WHEN v_has_variants THEN v_total_variant_stock
        ELSE COALESCE((product_payload->>'stock')::integer, 0)
      END,
      COALESCE(product_payload->>'status', 'draft'),
      NULLIF(product_payload->>'short_description', ''),
      product_payload->'description_json',
      COALESCE(product_payload->'metadata', '{}'::jsonb),
      COALESCE((product_payload->>'price')::integer, 0),
      COALESCE(product_payload->'prices', '{}'::jsonb),
      CASE
        WHEN product_payload ? 'sale_price' AND product_payload->>'sale_price' <> '' THEN
          (product_payload->>'sale_price')::integer
        ELSE
          NULL
      END,
      CASE
        WHEN product_payload ? 'sale_prices' THEN COALESCE(product_payload->'sale_prices', '{}'::jsonb)
        ELSE NULL
      END,
      CASE
        WHEN product_payload ? 'sale_start_at' AND product_payload->>'sale_start_at' <> '' THEN
          (product_payload->>'sale_start_at')::timestamptz
        ELSE
          NULL
      END,
      CASE
        WHEN product_payload ? 'sale_end_at' AND product_payload->>'sale_end_at' <> '' THEN
          (product_payload->>'sale_end_at')::timestamptz
        ELSE
          NULL
      END,
      NULLIF(product_payload->>'freemius_plan_id', ''),
      NULLIF(product_payload->>'freemius_product_id', ''),
      COALESCE((product_payload->>'trial_period_days')::integer, 0),
      COALESCE((product_payload->>'trial_requires_payment_method')::boolean, false),
      (product_payload->>'language_id')::bigint,
      COALESCE(v_translation_group_id, gen_random_uuid())
    )
    RETURNING id INTO v_product_id;
  ELSE
    UPDATE public.products
    SET
      title = product_payload->>'title',
      slug = product_payload->>'slug',
      sku = product_payload->>'sku',
      product_type = v_product_type,
      payment_provider = v_payment_provider,
      upc = NULLIF(product_payload->>'upc', ''),
      stock = CASE
        WHEN v_has_variants THEN v_total_variant_stock
        ELSE COALESCE((product_payload->>'stock')::integer, 0)
      END,
      status = COALESCE(product_payload->>'status', status),
      short_description = NULLIF(product_payload->>'short_description', ''),
      description_json = product_payload->'description_json',
      metadata = COALESCE(product_payload->'metadata', '{}'::jsonb),
      price = COALESCE((product_payload->>'price')::integer, 0),
      prices = COALESCE(product_payload->'prices', '{}'::jsonb),
      sale_price = CASE
        WHEN product_payload ? 'sale_price' AND product_payload->>'sale_price' <> '' THEN
          (product_payload->>'sale_price')::integer
        ELSE
          NULL
      END,
      sale_prices = CASE
        WHEN product_payload ? 'sale_prices' THEN COALESCE(product_payload->'sale_prices', '{}'::jsonb)
        ELSE NULL
      END,
      sale_start_at = CASE
        WHEN product_payload ? 'sale_start_at' AND product_payload->>'sale_start_at' <> '' THEN
          (product_payload->>'sale_start_at')::timestamptz
        ELSE
          NULL
      END,
      sale_end_at = CASE
        WHEN product_payload ? 'sale_end_at' AND product_payload->>'sale_end_at' <> '' THEN
          (product_payload->>'sale_end_at')::timestamptz
        ELSE
          NULL
      END,
      freemius_plan_id = NULLIF(product_payload->>'freemius_plan_id', ''),
      freemius_product_id = NULLIF(product_payload->>'freemius_product_id', ''),
      trial_period_days = COALESCE((product_payload->>'trial_period_days')::integer, 0),
      trial_requires_payment_method = COALESCE((product_payload->>'trial_requires_payment_method')::boolean, false),
      language_id = COALESCE((product_payload->>'language_id')::bigint, language_id),
      translation_group_id = COALESCE(v_translation_group_id, translation_group_id),
      updated_at = now()
    WHERE id = v_product_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product not found';
    END IF;
  END IF;

  DELETE FROM public.variant_attribute_mapping
  WHERE variant_id IN (
    SELECT id
    FROM public.product_variants
    WHERE product_id = v_product_id
  );

  DELETE FROM public.product_variants
  WHERE product_id = v_product_id;

  IF v_has_variants THEN
    FOR v_variant IN
      SELECT value FROM jsonb_array_elements(v_variants)
    LOOP
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
        v_product_id,
        v_variant->>'sku',
        NULLIF(v_variant->>'upc', ''),
        COALESCE((v_variant->>'price')::integer, 0),
        COALESCE(v_variant->'prices', '{}'::jsonb),
        CASE
          WHEN v_variant ? 'sale_price' AND v_variant->>'sale_price' <> '' THEN
            (v_variant->>'sale_price')::integer
          ELSE
            NULL
        END,
        CASE
          WHEN v_variant ? 'sale_prices' THEN COALESCE(v_variant->'sale_prices', '{}'::jsonb)
          ELSE NULL
        END,
        CASE
          WHEN v_variant ? 'sale_start_at' AND v_variant->>'sale_start_at' <> '' THEN
            (v_variant->>'sale_start_at')::timestamptz
          ELSE
            NULL
        END,
        CASE
          WHEN v_variant ? 'sale_end_at' AND v_variant->>'sale_end_at' <> '' THEN
            (v_variant->>'sale_end_at')::timestamptz
          ELSE
            NULL
        END,
        COALESCE((v_variant->>'stock_quantity')::integer, 0),
        NULLIF(v_variant->>'main_media_id', '')::uuid
      )
      RETURNING id INTO v_variant_id;

      FOR v_term_id IN
        SELECT jsonb_array_elements_text(COALESCE(v_variant->'attribute_term_ids', '[]'::jsonb))
      LOOP
        INSERT INTO public.variant_attribute_mapping (variant_id, attribute_term_id)
        VALUES (v_variant_id, v_term_id::uuid);
      END LOOP;
    END LOOP;
  END IF;

  RETURN v_product_id;
END;
$$;

CREATE TABLE IF NOT EXISTS public.blocks (
    id bigint NOT NULL,
    page_id bigint,
    post_id bigint,
    language_id bigint NOT NULL,
    block_type text NOT NULL,
    content jsonb,
    "order" integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    product_id uuid,
    CONSTRAINT check_exactly_one_parent CHECK ((((page_id IS NOT NULL) AND (post_id IS NULL) AND (product_id IS NULL)) OR ((post_id IS NOT NULL) AND (page_id IS NULL) AND (product_id IS NULL)) OR ((product_id IS NOT NULL) AND (page_id IS NULL) AND (post_id IS NULL))))
);

COMMENT ON TABLE public.blocks IS 'Stores content blocks for pages and posts.';

COMMENT ON COLUMN public.blocks.block_type IS 'Type of the block, e.g., "text", "image".';

COMMENT ON COLUMN public.blocks.content IS 'JSONB content specific to the block_type.';

COMMENT ON COLUMN public.blocks."order" IS 'Sort order of the block.';

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.blocks'::regclass AND attname = 'id' AND attidentity <> '') THEN
    ALTER TABLE public.blocks ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
        SEQUENCE NAME public.blocks_id_seq
        START WITH 1
        INCREMENT BY 1
        NO MINVALUE
        NO MAXVALUE
        CACHE 1
    );
  END IF;
END $rb$;

CREATE TABLE IF NOT EXISTS public.categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    name_translations jsonb DEFAULT '{}'::jsonb NOT NULL,
    description_translations jsonb DEFAULT '{}'::jsonb NOT NULL
);

COMMENT ON TABLE public.categories IS 'Product categories for organizing catalog items.';

COMMENT ON COLUMN public.categories.name_translations IS 'Translated category names (e.g. {"fr": "Numérique"}).';

COMMENT ON COLUMN public.categories.description_translations IS 'Translated category descriptions.';

CREATE TABLE IF NOT EXISTS public.cms_interactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    type public.interaction_type NOT NULL,
    status public.approval_status DEFAULT 'pending'::public.approval_status NOT NULL,
    content text NOT NULL,
    rating integer,
    user_id uuid NOT NULL,
    product_id uuid,
    post_id bigint,
    reactions jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    parent_id uuid,
    CONSTRAINT check_product_or_post CHECK ((((product_id IS NOT NULL) AND (post_id IS NULL)) OR ((post_id IS NOT NULL) AND (product_id IS NULL)))),
    CONSTRAINT check_rating_only_for_review CHECK ((((type = 'review'::public.interaction_type) AND (rating IS NOT NULL) AND (rating >= 1) AND (rating <= 5)) OR ((type = 'comment'::public.interaction_type) AND (rating IS NULL)))),
    CONSTRAINT cms_interactions_reply_check CHECK (((parent_id IS NULL) OR ((parent_id <> id) AND (rating IS NULL) AND (type = 'comment'::public.interaction_type))))
);

COMMENT ON TABLE public.cms_interactions IS 'Stores user-submitted product reviews and blog post comments.';

COMMENT ON COLUMN public.cms_interactions.rating IS 'Star rating 1-5, only populated for product reviews.';

COMMENT ON COLUMN public.cms_interactions.user_id IS 'References public.profiles.id';

COMMENT ON COLUMN public.cms_interactions.reactions IS 'JSONB structure tracking counts of reactions (likes, etc.).';

COMMENT ON COLUMN public.cms_interactions.parent_id IS 'Set on a staff reply: points at the review or comment being answered. Replies are always type=comment with a NULL rating, and carry the parent''s product_id/post_id so check_product_or_post still holds.';

CREATE TABLE IF NOT EXISTS public.cms_redirects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_path text NOT NULL,
    destination_path text NOT NULL,
    status_code integer DEFAULT 301 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cms_redirects_destination_path_check CHECK (((destination_path ~ '^/'::text) OR (destination_path ~ '^https://'::text))),
    CONSTRAINT cms_redirects_no_self_redirect_check CHECK ((source_path <> destination_path)),
    CONSTRAINT cms_redirects_source_path_check CHECK ((source_path ~ '^/'::text)),
    CONSTRAINT cms_redirects_status_code_check CHECK ((status_code = ANY (ARRAY[301, 302])))
);

COMMENT ON TABLE public.cms_redirects IS 'Operator-managed 301/302 redirects resolved by apps/nextblock/proxy.ts before rendering. Only is_active rows are publicly readable; only ADMIN may write, because a redirect rule is an open-redirect surface.';

COMMENT ON COLUMN public.cms_redirects.source_path IS 'Exact site-relative path to match, normalized to a leading slash and no trailing slash (except root). No wildcards, by design.';

COMMENT ON COLUMN public.cms_redirects.destination_path IS 'Site-relative path or absolute https URL to send the visitor to.';

COMMENT ON COLUMN public.cms_redirects.status_code IS '301 permanent or 302 temporary. 307/308 are not offered by the admin UI.';

COMMENT ON COLUMN public.cms_redirects.is_active IS 'Only active rows are readable by anon, and only active rows are matched by the proxy.';

CREATE TABLE IF NOT EXISTS public.content_drafts (
    id bigint NOT NULL,
    parent_type text NOT NULL,
    parent_id bigint NOT NULL,
    author_id uuid,
    base_version integer DEFAULT 1 NOT NULL,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    blocks jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT content_drafts_blocks_array CHECK ((jsonb_typeof(blocks) = 'array'::text)),
    CONSTRAINT content_drafts_meta_object CHECK ((jsonb_typeof(meta) = 'object'::text)),
    CONSTRAINT content_drafts_parent_type_check CHECK ((parent_type = ANY (ARRAY['page'::text, 'post'::text])))
);

COMMENT ON TABLE public.content_drafts IS 'Draft snapshots used by Draft Mode and front-end visual editing before publishing to live page/post rows.';

COMMENT ON COLUMN public.content_drafts.parent_type IS 'The content table this draft belongs to: page or post.';

COMMENT ON COLUMN public.content_drafts.parent_id IS 'ID of the page or post being drafted.';

COMMENT ON COLUMN public.content_drafts.base_version IS 'Published page/post version the draft was created from.';

COMMENT ON COLUMN public.content_drafts.meta IS 'Draft page/post metadata snapshot.';

COMMENT ON COLUMN public.content_drafts.blocks IS 'Ordered draft block snapshot, including block ids, block types, content, language ids, and order values.';

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.content_drafts'::regclass AND attname = 'id' AND attidentity <> '') THEN
    ALTER TABLE public.content_drafts ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
        SEQUENCE NAME public.content_drafts_id_seq
        START WITH 1
        INCREMENT BY 1
        NO MINVALUE
        NO MAXVALUE
        CACHE 1
    );
  END IF;
END $rb$;

CREATE TABLE IF NOT EXISTS public.cortex_ai_db_mutation_audit (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    actor_user_id uuid,
    tool_name text NOT NULL,
    action_name text NOT NULL,
    target_tables text[] DEFAULT '{}'::text[] NOT NULL,
    operation_summary text NOT NULL,
    payload_hash text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    preview jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text NOT NULL,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cortex_ai_db_mutation_audit_status_check CHECK ((status = ANY (ARRAY['success'::text, 'failure'::text])))
);

COMMENT ON TABLE public.cortex_ai_db_mutation_audit IS 'Audit trail for confirmed Cortex AI database mutation attempts.';

COMMENT ON COLUMN public.cortex_ai_db_mutation_audit.payload IS 'Redacted tool input payload for the confirmed mutation attempt.';

COMMENT ON COLUMN public.cortex_ai_db_mutation_audit.preview IS 'Redacted confirmation preview shown before the mutation was confirmed.';

CREATE TABLE IF NOT EXISTS public.coupon_freemius_mappings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    coupon_id uuid NOT NULL,
    product_id uuid,
    freemius_product_id text NOT NULL,
    freemius_coupon_id text,
    freemius_coupon_code text NOT NULL,
    sync_status text DEFAULT 'pending'::text NOT NULL,
    sync_error text,
    remote_payload jsonb,
    last_synced_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT coupon_freemius_mappings_code_not_blank CHECK ((char_length(btrim(freemius_coupon_code)) > 0)),
    CONSTRAINT coupon_freemius_mappings_product_not_blank CHECK ((char_length(btrim(freemius_product_id)) > 0)),
    CONSTRAINT coupon_freemius_mappings_sync_status_valid CHECK ((sync_status = ANY (ARRAY['pending'::text, 'synced'::text, 'failed'::text, 'deleted'::text])))
);

CREATE TABLE IF NOT EXISTS public.coupon_products (
    coupon_id uuid NOT NULL,
    product_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public.coupon_products IS 'Optional product allow-list for coupons. No rows means all products in the provider scope are eligible.';

CREATE TABLE IF NOT EXISTS public.coupon_redemptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    coupon_id uuid,
    order_id uuid,
    coupon_code text NOT NULL,
    provider text NOT NULL,
    discount_total integer DEFAULT 0 NOT NULL,
    user_id uuid,
    customer_email text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    redeemed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT coupon_redemptions_code_not_blank CHECK ((char_length(btrim(coupon_code)) > 0)),
    CONSTRAINT coupon_redemptions_discount_total_check CHECK ((discount_total >= 0)),
    CONSTRAINT coupon_redemptions_provider_check CHECK ((provider = ANY (ARRAY['stripe'::text, 'freemius'::text])))
);

CREATE TABLE IF NOT EXISTS public.coupons (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    internal_note text,
    provider_scope text DEFAULT 'all'::text NOT NULL,
    discount_type text NOT NULL,
    discount_amount integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    starts_at timestamp with time zone,
    ends_at timestamp with time zone,
    redemption_limit integer,
    redemptions_count integer DEFAULT 0 NOT NULL,
    freemius_sync_status text DEFAULT 'not_synced'::text NOT NULL,
    freemius_sync_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT coupons_code_not_blank CHECK ((char_length(btrim(code)) > 0)),
    CONSTRAINT coupons_date_window_valid CHECK (((starts_at IS NULL) OR (ends_at IS NULL) OR (starts_at < ends_at))),
    CONSTRAINT coupons_discount_amount_positive CHECK ((discount_amount > 0)),
    CONSTRAINT coupons_discount_type_valid CHECK ((discount_type = ANY (ARRAY['percent'::text, 'fixed'::text]))),
    CONSTRAINT coupons_freemius_sync_status_valid CHECK ((freemius_sync_status = ANY (ARRAY['not_synced'::text, 'pending'::text, 'synced'::text, 'failed'::text, 'not_required'::text]))),
    CONSTRAINT coupons_name_not_blank CHECK ((char_length(btrim(name)) > 0)),
    CONSTRAINT coupons_percent_amount_valid CHECK (((discount_type <> 'percent'::text) OR (discount_amount <= 100))),
    CONSTRAINT coupons_provider_scope_valid CHECK ((provider_scope = ANY (ARRAY['all'::text, 'stripe'::text, 'freemius'::text]))),
    CONSTRAINT coupons_redemption_limit_positive CHECK (((redemption_limit IS NULL) OR (redemption_limit > 0))),
    CONSTRAINT coupons_redemptions_count_nonnegative CHECK ((redemptions_count >= 0))
);

COMMENT ON TABLE public.coupons IS 'Unified commerce coupons managed by NextBlock CMS and applied through provider-aware checkout.';

COMMENT ON COLUMN public.coupons.provider_scope IS 'Provider eligibility: all, stripe, or freemius.';

COMMENT ON COLUMN public.coupons.discount_amount IS 'Percent value for percent coupons, or fixed minor-unit amount for fixed coupons.';

COMMENT ON COLUMN public.coupons.freemius_sync_status IS 'Aggregate status for syncing this coupon to Freemius product coupon records.';

CREATE TABLE IF NOT EXISTS public.currencies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    symbol text NOT NULL,
    exchange_rate numeric(20,10) NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    rounding_mode text DEFAULT 'none'::text NOT NULL,
    rounding_increment integer DEFAULT 1 NOT NULL,
    rounding_charm_amount integer,
    auto_update_exchange_rate boolean DEFAULT true NOT NULL,
    exchange_rate_updated_at timestamp with time zone,
    exchange_rate_source text,
    auto_sync_product_prices boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT currencies_charm_requires_amount CHECK (((rounding_mode <> 'charm'::text) OR (rounding_charm_amount IS NOT NULL))),
    CONSTRAINT currencies_code_check CHECK ((code ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT currencies_default_auto_update_disabled CHECK (((NOT is_default) OR (auto_update_exchange_rate = false))),
    CONSTRAINT currencies_default_exchange_rate_is_one CHECK (((NOT is_default) OR (exchange_rate = (1)::numeric))),
    CONSTRAINT currencies_default_must_be_active CHECK (((NOT is_default) OR is_active)),
    CONSTRAINT currencies_default_product_price_sync_disabled CHECK (((NOT is_default) OR (auto_sync_product_prices = false))),
    CONSTRAINT currencies_exchange_rate_check CHECK ((exchange_rate > (0)::numeric)),
    CONSTRAINT currencies_rounding_charm_nonnegative CHECK (((rounding_charm_amount IS NULL) OR (rounding_charm_amount >= 0))),
    CONSTRAINT currencies_rounding_increment_positive CHECK ((rounding_increment > 0)),
    CONSTRAINT currencies_rounding_mode_valid CHECK ((rounding_mode = ANY (ARRAY['none'::text, 'nearest'::text, 'up'::text, 'down'::text, 'charm'::text])))
);

COMMENT ON TABLE public.currencies IS 'Store currencies available for storefront display and conversion.';

COMMENT ON COLUMN public.currencies.exchange_rate IS 'Relative to the current store default currency. The default currency should have exchange_rate = 1.';

COMMENT ON COLUMN public.currencies.rounding_mode IS 'Rounding strategy applied when prices are auto-converted into this currency.';

COMMENT ON COLUMN public.currencies.rounding_increment IS 'Rounding step in the currency smallest unit. Example: 5 means 0.05 for USD/CAD.';

COMMENT ON COLUMN public.currencies.rounding_charm_amount IS 'Charm ending in the currency smallest unit. Example: 90 means prices like 29.90.';

COMMENT ON COLUMN public.currencies.auto_update_exchange_rate IS 'Whether scheduled FX sync jobs should refresh this currency.';

COMMENT ON COLUMN public.currencies.exchange_rate_updated_at IS 'When this currency exchange rate was last refreshed or manually set.';

COMMENT ON COLUMN public.currencies.exchange_rate_source IS 'Human-readable source for the current exchange rate, such as a provider host or manual override.';

COMMENT ON COLUMN public.currencies.auto_sync_product_prices IS 'Whether storefront product and variant prices in this currency are derived automatically from the store default currency using FX and rounding rules.';

CREATE TABLE IF NOT EXISTS public.email_2fa_challenges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public.email_2fa_challenges IS 'Short-lived SHA-256 hashes of 6-digit email verification codes. Readable/writable only by the service role.';

CREATE TABLE IF NOT EXISTS public.form_endpoints (
    form_key uuid NOT NULL,
    label text DEFAULT 'Contact form'::text NOT NULL,
    recipient_email text,
    fields jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT form_endpoints_fields_array CHECK ((jsonb_typeof(fields) = 'array'::text)),
    CONSTRAINT form_endpoints_label_not_blank CHECK ((char_length(btrim(label)) > 0))
);

COMMENT ON TABLE public.form_endpoints IS 'Server-side destination and field manifest for a contact-form block, keyed by the non-secret form_key carried in block content. The address never reaches the browser.';

COMMENT ON COLUMN public.form_endpoints.form_key IS 'Non-secret opaque handle. Safe in the RSC payload: it grants nothing, it is only a lookup key.';

COMMENT ON COLUMN public.form_endpoints.recipient_email IS 'Per-form override. NULL means "use the site contact address" (CMS -> Messages, falling back to the first admin), which is the default and the usual case.';

COMMENT ON COLUMN public.form_endpoints.fields IS 'Snapshot of [{temp_id,label,field_type}] written by the CMS editor, so labels in emails and the inbox are server-trusted.';

CREATE TABLE IF NOT EXISTS public.freemius_plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    product_id uuid NOT NULL,
    name text NOT NULL,
    title text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.freemius_pricing (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    plan_id uuid NOT NULL,
    api_monthly_price numeric,
    api_annual_price numeric,
    api_lifetime_price numeric,
    override_monthly_price numeric,
    override_annual_price numeric,
    override_lifetime_price numeric,
    license_quota integer,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.inventory_items (
    sku text NOT NULL,
    quantity integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT inventory_items_quantity_check CHECK ((quantity >= 0))
);

COMMENT ON TABLE public.inventory_items IS 'Source-of-truth inventory records keyed by sellable SKU.';

COMMENT ON COLUMN public.inventory_items.sku IS 'Global sellable SKU. Matching products or variants share inventory.';

COMMENT ON COLUMN public.inventory_items.quantity IS 'Available quantity for this SKU.';

CREATE TABLE IF NOT EXISTS public.languages (
    id bigint NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public.languages IS 'Stores supported languages for the CMS.';

COMMENT ON COLUMN public.languages.code IS 'BCP 47 language code.';

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.languages'::regclass AND attname = 'id' AND attidentity <> '') THEN
    ALTER TABLE public.languages ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
        SEQUENCE NAME public.languages_id_seq
        START WITH 1
        INCREMENT BY 1
        NO MINVALUE
        NO MAXVALUE
        CACHE 1
    );
  END IF;
END $rb$;

CREATE TABLE IF NOT EXISTS public.logos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    media_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public.logos IS 'Stores company and brand logos.';

COMMENT ON COLUMN public.logos.name IS 'The name of the brand or company for the logo.';

COMMENT ON COLUMN public.logos.media_id IS 'Foreign key to the media table for the logo image.';

CREATE TABLE IF NOT EXISTS public.mcp_access_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    token_hash text NOT NULL,
    token_prefix text NOT NULL,
    scopes text[] DEFAULT ARRAY['read'::text, 'write'::text] NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone
);

COMMENT ON TABLE public.mcp_access_tokens IS 'Bearer tokens for the Cortex AI MCP server at /api/mcp. Stores SHA-256 hashes only; plaintext is displayed once at mint time.';

CREATE TABLE IF NOT EXISTS public.media (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    uploader_id uuid,
    file_name text NOT NULL,
    object_key text NOT NULL,
    file_type text,
    size_bytes bigint,
    description text,
    width integer,
    height integer,
    blur_data_url text,
    variants jsonb,
    file_path text,
    folder text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public.media IS 'Stores information about uploaded media assets.';

COMMENT ON COLUMN public.media.object_key IS 'Unique key (path) in Cloudflare R2.';

COMMENT ON COLUMN public.media.width IS 'Width of the image in pixels.';

COMMENT ON COLUMN public.media.height IS 'Height of the image in pixels.';

COMMENT ON COLUMN public.media.blur_data_url IS 'Base64 encoded string for image blur placeholders.';

COMMENT ON COLUMN public.media.variants IS 'Array of image variant objects.';

COMMENT ON COLUMN public.media.file_path IS 'Full path to the file in the storage bucket.';

COMMENT ON COLUMN public.media.folder IS 'Folder path prefix for the R2 object.';

CREATE TABLE IF NOT EXISTS public.message_threads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source text NOT NULL,
    subject_id uuid,
    form_key uuid,
    subject_label text DEFAULT 'Message'::text NOT NULL,
    sender_name text,
    sender_email text,
    locale text,
    fields jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    unread_for_admin boolean DEFAULT true NOT NULL,
    unread_for_visitor boolean DEFAULT false NOT NULL,
    token_hash text,
    token_expires_at timestamp with time zone,
    token_revoked_at timestamp with time zone,
    token_last_used_at timestamp with time zone,
    last_message_at timestamp with time zone DEFAULT now() NOT NULL,
    ip_masked text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT message_threads_fields_object CHECK ((jsonb_typeof(fields) = 'object'::text)),
    CONSTRAINT message_threads_source_check CHECK ((source = ANY (ARRAY['product_inquiry'::text, 'contact_form'::text]))),
    CONSTRAINT message_threads_status_check CHECK ((status = ANY (ARRAY['open'::text, 'closed'::text]))),
    CONSTRAINT message_threads_subject_check CHECK ((((source = 'product_inquiry'::text) AND (subject_id IS NOT NULL)) OR ((source = 'contact_form'::text) AND (form_key IS NOT NULL))))
);

COMMENT ON TABLE public.message_threads IS 'Private conversations with anonymous visitors (product enquiries and contact-form submissions). Written by the service role from public server actions; read by ADMINs only. Public reviews and comments are NOT here - they live in cms_interactions.';

COMMENT ON COLUMN public.message_threads.subject_id IS 'product_inquiries.id. Plain uuid, no FK: a conversation outlives the enquiry record it grew from.';

COMMENT ON COLUMN public.message_threads.token_hash IS 'SHA-256 hex of the visitor thread token. The raw token is never stored; it is minted on the first admin reply and mailed once.';

CREATE TABLE IF NOT EXISTS public.navigation_items (
    id bigint NOT NULL,
    language_id bigint NOT NULL,
    menu_key public.menu_location NOT NULL,
    label text NOT NULL,
    url text NOT NULL,
    parent_id bigint,
    "order" integer DEFAULT 0 NOT NULL,
    page_id bigint,
    translation_group_id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public.navigation_items IS 'Stores navigation menu items.';

COMMENT ON COLUMN public.navigation_items.menu_key IS 'Identifies the menu this item belongs to.';

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.navigation_items'::regclass AND attname = 'id' AND attidentity <> '') THEN
    ALTER TABLE public.navigation_items ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
        SEQUENCE NAME public.navigation_items_id_seq
        START WITH 1
        INCREMENT BY 1
        NO MINVALUE
        NO MAXVALUE
        CACHE 1
    );
  END IF;
END $rb$;

CREATE SEQUENCE IF NOT EXISTS public.order_invoice_number_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE IF NOT EXISTS public.order_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    product_id uuid,
    variant_id uuid,
    quantity integer NOT NULL,
    price_at_purchase integer NOT NULL
);

CREATE TABLE IF NOT EXISTS public.orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    total integer NOT NULL,
    stripe_session_id text,
    payment_intent_id text,
    customer_details jsonb,
    provider text DEFAULT 'stripe'::text,
    freemius_product_id text,
    freemius_plan_id text,
    freemius_license_id text,
    freemius_subscription_id text,
    freemius_trial_id text,
    freemius_user_id text,
    freemius_trial_ends_at timestamp with time zone,
    freemius_last_event_type text,
    freemius_last_synced_at timestamp with time zone,
    currency text DEFAULT 'USD'::text NOT NULL,
    subtotal integer,
    shipping_total integer,
    tax_total integer DEFAULT 0 NOT NULL,
    tax_details jsonb,
    exchange_rate_at_purchase numeric(20,10) DEFAULT 1 NOT NULL,
    inventory_deducted_at timestamp with time zone,
    invoice_number text,
    paid_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    coupon_id uuid,
    coupon_code text,
    discount_total integer DEFAULT 0 NOT NULL,
    discount_details jsonb,
    CONSTRAINT orders_discount_total_check CHECK ((discount_total >= 0)),
    CONSTRAINT orders_exchange_rate_at_purchase_positive CHECK ((exchange_rate_at_purchase > (0)::numeric)),
    CONSTRAINT orders_provider_check CHECK ((provider = ANY (ARRAY['stripe'::text, 'freemius'::text]))),
    CONSTRAINT orders_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'trial'::text, 'paid'::text, 'shipped'::text, 'cancelled'::text, 'refunded'::text])))
);

COMMENT ON COLUMN public.orders.freemius_license_id IS 'Freemius license ID used to reconcile checkout callbacks and webhooks.';

COMMENT ON COLUMN public.orders.freemius_subscription_id IS 'Freemius subscription ID when the order is associated with recurring billing.';

COMMENT ON COLUMN public.orders.freemius_trial_id IS 'Freemius trial ID when checkout starts in trial mode.';

COMMENT ON COLUMN public.orders.freemius_trial_ends_at IS 'Freemius trial expiration timestamp when supplied by checkout or webhook data.';

COMMENT ON COLUMN public.orders.freemius_last_event_type IS 'Last Freemius checkout callback or webhook event applied to the order.';

COMMENT ON COLUMN public.orders.freemius_last_synced_at IS 'Timestamp when Freemius metadata was last reconciled locally.';

COMMENT ON COLUMN public.orders.currency IS 'ISO currency code used for the order totals.';

COMMENT ON COLUMN public.orders.subtotal IS 'Subtotal before shipping and tax, in the smallest currency unit.';

COMMENT ON COLUMN public.orders.shipping_total IS 'Shipping amount before tax, in the smallest currency unit.';

COMMENT ON COLUMN public.orders.tax_total IS 'Total tax amount collected for the order, in the smallest currency unit.';

COMMENT ON COLUMN public.orders.tax_details IS 'Normalized tax breakdown payload sourced from manual rates or finalized Stripe tax data.';

COMMENT ON COLUMN public.orders.exchange_rate_at_purchase IS 'Exchange rate locked at purchase time relative to the store default currency.';

COMMENT ON COLUMN public.orders.invoice_number IS 'Stable printable invoice number assigned once when the order first becomes paid.';

COMMENT ON COLUMN public.orders.paid_at IS 'Timestamp when the order was first marked as paid.';

COMMENT ON COLUMN public.orders.coupon_code IS 'Coupon code applied to the order at checkout time.';

COMMENT ON COLUMN public.orders.discount_total IS 'Total discount applied to this order in the smallest currency unit.';

COMMENT ON COLUMN public.orders.discount_details IS 'Provider-aware coupon quote details captured at checkout.';

CREATE TABLE IF NOT EXISTS public.package_activations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    license_key text NOT NULL,
    instance_name text NOT NULL,
    package_id text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    meta jsonb DEFAULT '{}'::jsonb,
    last_validated_at timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.page_revisions (
    id bigint NOT NULL,
    page_id bigint NOT NULL,
    author_id uuid,
    version integer NOT NULL,
    revision_type public.revision_type NOT NULL,
    content jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public.page_revisions IS 'Hybrid (snapshot/diff) revisions for pages.';

COMMENT ON COLUMN public.page_revisions.content IS 'If snapshot: full content; if diff: JSON Patch array.';

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.page_revisions'::regclass AND attname = 'id' AND attidentity <> '') THEN
    ALTER TABLE public.page_revisions ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
        SEQUENCE NAME public.page_revisions_id_seq
        START WITH 1
        INCREMENT BY 1
        NO MINVALUE
        NO MAXVALUE
        CACHE 1
    );
  END IF;
END $rb$;

CREATE TABLE IF NOT EXISTS public.pages (
    id bigint NOT NULL,
    language_id bigint NOT NULL,
    author_id uuid,
    title text NOT NULL,
    slug text NOT NULL,
    status public.page_status DEFAULT 'draft'::public.page_status NOT NULL,
    meta_title text,
    meta_description text,
    version integer DEFAULT 1 NOT NULL,
    translation_group_id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    feature_image_id uuid,
    custom_canonical text,
    published_at timestamp with time zone
);

COMMENT ON TABLE public.pages IS 'Stores static pages for the website.';

COMMENT ON COLUMN public.pages.slug IS 'URL-friendly identifier, unique per language.';

COMMENT ON COLUMN public.pages.version IS 'Monotonic version number for hybrid revisions.';

COMMENT ON COLUMN public.pages.translation_group_id IS 'Groups different language versions of the same conceptual page.';

COMMENT ON COLUMN public.pages.feature_image_id IS 'ID of the media item to be used as the page feature image.';

COMMENT ON COLUMN public.pages.published_at IS 'Optional go-live moment. NULL = live as soon as status is published. A future value withholds the page from public reads until it passes (status stays "published"; the CMS renders that pair as "Scheduled").';

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.pages'::regclass AND attname = 'id' AND attidentity <> '') THEN
    ALTER TABLE public.pages ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
        SEQUENCE NAME public.pages_id_seq
        START WITH 1
        INCREMENT BY 1
        NO MINVALUE
        NO MAXVALUE
        CACHE 1
    );
  END IF;
END $rb$;

CREATE TABLE IF NOT EXISTS public.post_revisions (
    id bigint NOT NULL,
    post_id bigint NOT NULL,
    author_id uuid,
    version integer NOT NULL,
    revision_type public.revision_type NOT NULL,
    content jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public.post_revisions IS 'Hybrid (snapshot/diff) revisions for posts.';

COMMENT ON COLUMN public.post_revisions.content IS 'If snapshot: full content; if diff: JSON Patch array.';

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.post_revisions'::regclass AND attname = 'id' AND attidentity <> '') THEN
    ALTER TABLE public.post_revisions ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
        SEQUENCE NAME public.post_revisions_id_seq
        START WITH 1
        INCREMENT BY 1
        NO MINVALUE
        NO MAXVALUE
        CACHE 1
    );
  END IF;
END $rb$;

CREATE TABLE IF NOT EXISTS public.posts (
    id bigint NOT NULL,
    language_id bigint NOT NULL,
    author_id uuid,
    title text NOT NULL,
    slug text NOT NULL,
    label text,
    excerpt text,
    subtitle text,
    status public.page_status DEFAULT 'draft'::public.page_status NOT NULL,
    published_at timestamp with time zone,
    meta_title text,
    meta_description text,
    feature_image_id uuid,
    version integer DEFAULT 1 NOT NULL,
    translation_group_id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    custom_canonical text
);

COMMENT ON TABLE public.posts IS 'Stores blog posts or news articles.';

COMMENT ON COLUMN public.posts.slug IS 'URL-friendly identifier, unique per language.';

COMMENT ON COLUMN public.posts.label IS 'Short editorial label rendered as a pill on post hero and article cards.';

COMMENT ON COLUMN public.posts.excerpt IS 'Short editorial summary used in post metadata rows and post cards.';

COMMENT ON COLUMN public.posts.subtitle IS 'Longer deck shown under the post title.';

COMMENT ON COLUMN public.posts.feature_image_id IS 'ID of the media item to be used as the feature image.';

COMMENT ON COLUMN public.posts.version IS 'Monotonic version number for hybrid revisions.';

COMMENT ON COLUMN public.posts.translation_group_id IS 'Groups different language versions of the same conceptual post.';

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.posts'::regclass AND attname = 'id' AND attidentity <> '') THEN
    ALTER TABLE public.posts ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
        SEQUENCE NAME public.posts_id_seq
        START WITH 1
        INCREMENT BY 1
        NO MINVALUE
        NO MAXVALUE
        CACHE 1
    );
  END IF;
END $rb$;

CREATE TABLE IF NOT EXISTS public.privacy_consent_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    consent_token text NOT NULL,
    categories jsonb DEFAULT '{"analytics": false, "marketing": false, "necessary": true}'::jsonb NOT NULL,
    ip_masked text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT privacy_consent_logs_categories_check CHECK ((jsonb_typeof(categories) = 'object'::text))
);

COMMENT ON TABLE public.privacy_consent_logs IS 'Immutable audit log of visitor consent decisions for Quebec Law 25 / PIPEDA accountability.';

COMMENT ON COLUMN public.privacy_consent_logs.consent_token IS 'Opaque token also stored in the nb_consent_preference cookie to correlate a decision with its record.';

COMMENT ON COLUMN public.privacy_consent_logs.ip_masked IS 'Partially masked IP (e.g. 203.0.113.x) - never store a full address for an analytics/marketing consent log.';

CREATE TABLE IF NOT EXISTS public.product_attribute_terms (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    attribute_id uuid NOT NULL,
    value text NOT NULL,
    slug text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    value_translations jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.product_attributes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    name_translations jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.product_categories (
    product_id uuid NOT NULL,
    category_id uuid NOT NULL
);

COMMENT ON TABLE public.product_categories IS 'Junction table mapping products to multiple categories.';

CREATE TABLE IF NOT EXISTS public.product_drafts (
    id bigint NOT NULL,
    product_id uuid NOT NULL,
    author_id uuid,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    blocks jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT product_drafts_blocks_array CHECK ((jsonb_typeof(blocks) = 'array'::text)),
    CONSTRAINT product_drafts_meta_object CHECK ((jsonb_typeof(meta) = 'object'::text))
);

COMMENT ON TABLE public.product_drafts IS 'Draft product metadata snapshots used by Draft Mode and front-end visual editing before publishing to live product rows.';

COMMENT ON COLUMN public.product_drafts.product_id IS 'ID of the product being drafted.';

COMMENT ON COLUMN public.product_drafts.meta IS 'Draft product metadata snapshot. Front-end visual editing currently mutates visible title, short_description, and description_json fields.';

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.product_drafts'::regclass AND attname = 'id' AND attidentity <> '') THEN
    ALTER TABLE public.product_drafts ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
        SEQUENCE NAME public.product_drafts_id_seq
        START WITH 1
        INCREMENT BY 1
        NO MINVALUE
        NO MAXVALUE
        CACHE 1
    );
  END IF;
END $rb$;

CREATE TABLE IF NOT EXISTS public.product_freemius_sale_coupons (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    product_id uuid NOT NULL,
    freemius_product_id text NOT NULL,
    freemius_plan_id text,
    freemius_coupon_id text,
    freemius_coupon_code text NOT NULL,
    discount_percent integer,
    starts_at timestamp with time zone,
    ends_at timestamp with time zone,
    is_active boolean DEFAULT false NOT NULL,
    sync_status text DEFAULT 'pending'::text NOT NULL,
    sync_error text,
    remote_payload jsonb,
    last_synced_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT product_freemius_sale_coupons_code_not_blank CHECK ((char_length(btrim(freemius_coupon_code)) > 0)),
    CONSTRAINT product_freemius_sale_coupons_discount_valid CHECK (((discount_percent IS NULL) OR ((discount_percent > 0) AND (discount_percent <= 100)))),
    CONSTRAINT product_freemius_sale_coupons_fm_product_not_blank CHECK ((char_length(btrim(freemius_product_id)) > 0)),
    CONSTRAINT product_freemius_sale_coupons_sync_status_valid CHECK ((sync_status = ANY (ARRAY['pending'::text, 'synced'::text, 'failed'::text, 'deleted'::text]))),
    CONSTRAINT product_freemius_sale_coupons_window_valid CHECK (((starts_at IS NULL) OR (ends_at IS NULL) OR (starts_at < ends_at)))
);

COMMENT ON TABLE public.product_freemius_sale_coupons IS 'Auto-generated, time-bounded Freemius coupons that enforce a scheduled sale on a Freemius product at Freemius-hosted checkout.';

CREATE TABLE IF NOT EXISTS public.product_inquiries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    product_id uuid,
    product_slug text,
    product_title text,
    sender_name text NOT NULL,
    sender_email text NOT NULL,
    message text NOT NULL,
    locale text,
    ip_masked text,
    user_agent text,
    email_delivered boolean DEFAULT false NOT NULL,
    is_resolved boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT product_inquiries_message_not_blank CHECK ((char_length(btrim(message)) > 0)),
    CONSTRAINT product_inquiries_sender_email_not_blank CHECK ((char_length(btrim(sender_email)) > 0)),
    CONSTRAINT product_inquiries_sender_name_not_blank CHECK ((char_length(btrim(sender_name)) > 0))
);

COMMENT ON TABLE public.product_inquiries IS 'Visitor purchase enquiries raised when the store cannot take payment. Written by the service role from a public server action; read by ADMINs only.';

COMMENT ON COLUMN public.product_inquiries.product_id IS 'Plain uuid, no FK: an enquiry outlives the product it was about.';

COMMENT ON COLUMN public.product_inquiries.ip_masked IS 'Partially masked IP (e.g. 203.0.113.x) - never store a full address. Also backs the per-IP submission throttle.';

COMMENT ON COLUMN public.product_inquiries.email_delivered IS 'False when the owner notification could not be sent (e.g. SMTP unconfigured); the stored row is then the only record.';

CREATE TABLE IF NOT EXISTS public.product_media (
    product_id uuid NOT NULL,
    media_id uuid NOT NULL,
    sort_order integer DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.product_revisions (
    id bigint NOT NULL,
    product_id uuid NOT NULL,
    author_id uuid,
    version integer NOT NULL,
    revision_type public.revision_type NOT NULL,
    content jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public.product_revisions IS 'Hybrid (snapshot/diff) revisions for products.';

COMMENT ON COLUMN public.product_revisions.content IS 'If snapshot: full content; if diff: JSON Patch array.';

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.product_revisions'::regclass AND attname = 'id' AND attidentity <> '') THEN
    ALTER TABLE public.product_revisions ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
        SEQUENCE NAME public.product_revisions_id_seq
        START WITH 1
        INCREMENT BY 1
        NO MINVALUE
        NO MAXVALUE
        CACHE 1
    );
  END IF;
END $rb$;

CREATE TABLE IF NOT EXISTS public.product_variants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    product_id uuid NOT NULL,
    sku text NOT NULL,
    price_adjustment integer DEFAULT 0 NOT NULL,
    price integer DEFAULT 0 NOT NULL,
    prices jsonb DEFAULT '{}'::jsonb NOT NULL,
    sale_price integer,
    sale_prices jsonb,
    stock_quantity integer DEFAULT 0 NOT NULL,
    upc text,
    main_media_id uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    sale_start_at timestamp with time zone,
    sale_end_at timestamp with time zone,
    scheduled_price integer,
    scheduled_prices jsonb,
    scheduled_price_at timestamp with time zone,
    CONSTRAINT product_variants_prices_is_valid CHECK (public.is_valid_currency_amount_map(prices)),
    CONSTRAINT product_variants_sale_prices_are_valid CHECK (public.is_valid_sale_price_map(prices, sale_prices)),
    CONSTRAINT product_variants_sale_window_valid CHECK (((sale_start_at IS NULL) OR (sale_end_at IS NULL) OR (sale_start_at < sale_end_at)))
);

COMMENT ON COLUMN public.product_variants.prices IS 'Variant regular prices by ISO 4217 code in the smallest currency unit.';

COMMENT ON COLUMN public.product_variants.sale_prices IS 'Variant sale prices by ISO 4217 code in the smallest currency unit.';

COMMENT ON COLUMN public.product_variants.sale_start_at IS 'Inclusive start of the scheduled sale window (UTC) for this variant. NULL means no lower bound.';

COMMENT ON COLUMN public.product_variants.sale_end_at IS 'Exclusive end of the scheduled sale window (UTC) for this variant. NULL means no upper bound.';

COMMENT ON COLUMN public.product_variants.scheduled_price IS 'Pending regular price (smallest currency unit) applied once scheduled_price_at has passed.';

COMMENT ON COLUMN public.product_variants.scheduled_prices IS 'Pending multi-currency regular prices by ISO 4217 code, applied once scheduled_price_at has passed.';

COMMENT ON COLUMN public.product_variants.scheduled_price_at IS 'Effective timestamp (UTC) for the pending regular-price change.';

CREATE TABLE IF NOT EXISTS public.products (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    language_id bigint NOT NULL,
    translation_group_id uuid DEFAULT gen_random_uuid() NOT NULL,
    sku text NOT NULL,
    title text NOT NULL,
    slug text NOT NULL,
    product_type text NOT NULL,
    payment_provider text NOT NULL,
    price integer NOT NULL,
    prices jsonb DEFAULT '{}'::jsonb NOT NULL,
    sale_price integer,
    sale_prices jsonb,
    stock integer DEFAULT 0,
    status text DEFAULT 'draft'::text NOT NULL,
    meta_title text,
    meta_description text,
    short_description text,
    description_json jsonb,
    metadata jsonb,
    freemius_plan_id text,
    freemius_product_id text,
    trial_period_days integer DEFAULT 0 NOT NULL,
    trial_requires_payment_method boolean DEFAULT false NOT NULL,
    upc text,
    is_taxable boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    sale_start_at timestamp with time zone,
    sale_end_at timestamp with time zone,
    scheduled_price integer,
    scheduled_prices jsonb,
    scheduled_price_at timestamp with time zone,
    average_rating numeric(3,2) DEFAULT 0.00 NOT NULL,
    total_reviews integer DEFAULT 0 NOT NULL,
    custom_canonical text,
    published_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT products_payment_provider_check CHECK ((payment_provider = ANY (ARRAY['stripe'::text, 'freemius'::text]))),
    CONSTRAINT products_prices_is_valid CHECK (public.is_valid_currency_amount_map(prices)),
    CONSTRAINT products_product_type_check CHECK ((product_type = ANY (ARRAY['physical'::text, 'digital'::text]))),
    CONSTRAINT products_sale_prices_are_valid CHECK (public.is_valid_sale_price_map(prices, sale_prices)),
    CONSTRAINT products_sale_window_valid CHECK (((sale_start_at IS NULL) OR (sale_end_at IS NULL) OR (sale_start_at < sale_end_at))),
    CONSTRAINT products_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'archived'::text]))),
    CONSTRAINT products_trial_period_days_check CHECK ((trial_period_days >= 0)),
    CONSTRAINT products_type_provider_consistency_check CHECK ((((product_type = 'physical'::text) AND (payment_provider = 'stripe'::text)) OR ((product_type = 'digital'::text) AND (payment_provider = 'freemius'::text))))
);

COMMENT ON COLUMN public.products.prices IS 'Regular prices by ISO 4217 code in the smallest currency unit.';

COMMENT ON COLUMN public.products.sale_prices IS 'Sale prices by ISO 4217 code in the smallest currency unit.';

COMMENT ON COLUMN public.products.is_taxable IS 'When true, this product participates in Stripe tax calculation.';

COMMENT ON COLUMN public.products.sale_start_at IS 'Inclusive start of the scheduled sale window (UTC). NULL means no lower bound.';

COMMENT ON COLUMN public.products.sale_end_at IS 'Exclusive end of the scheduled sale window (UTC). NULL means no upper bound. Both NULL = always-on sale.';

COMMENT ON COLUMN public.products.scheduled_price IS 'Pending regular price (smallest currency unit) applied once scheduled_price_at has passed.';

COMMENT ON COLUMN public.products.scheduled_prices IS 'Pending multi-currency regular prices by ISO 4217 code, applied once scheduled_price_at has passed.';

COMMENT ON COLUMN public.products.scheduled_price_at IS 'Effective timestamp (UTC) for the pending regular-price change.';

COMMENT ON COLUMN public.products.average_rating IS 'Aggregated average 1-5 rating of approved reviews.';

COMMENT ON COLUMN public.products.total_reviews IS 'Total count of approved reviews for this product.';

COMMENT ON COLUMN public.products.published_at IS 'Optional go-live moment. NULL = live as soon as status is active. A future value withholds the product from public reads until it passes (status stays "active"; the CMS renders that pair as "Scheduled").';

COMMENT ON COLUMN public.products.version IS 'Monotonic version number for hybrid revisions.';

CREATE TABLE IF NOT EXISTS public.profiles (
    id uuid NOT NULL,
    updated_at timestamp with time zone,
    full_name text,
    avatar_url text,
    website text,
    phone text,
    role public.user_role DEFAULT 'USER'::public.user_role NOT NULL
);

COMMENT ON TABLE public.profiles IS 'Profile information for each user, extending auth.users.';

COMMENT ON COLUMN public.profiles.id IS 'References auth.users.id';

COMMENT ON COLUMN public.profiles.role IS 'User role for RBAC.';

CREATE TABLE IF NOT EXISTS public.shipping_zone_locations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    zone_id uuid NOT NULL,
    country_code text NOT NULL,
    state_code text,
    postal_code text,
    created_at timestamp with time zone DEFAULT now()
);

COMMENT ON COLUMN public.shipping_zone_locations.country_code IS 'ISO 3166-1 alpha-2 country code.';

COMMENT ON COLUMN public.shipping_zone_locations.state_code IS 'Optional state/province code within the selected country (for example CA, NY, ON, QC). NULL means the whole country.';

COMMENT ON COLUMN public.shipping_zone_locations.postal_code IS 'Optional exact postal code or wildcard pattern. NULL means all postal codes in the matched country/state.';

CREATE TABLE IF NOT EXISTS public.shipping_zone_methods (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    zone_id uuid NOT NULL,
    method_type text NOT NULL,
    cost_amount integer DEFAULT 0 NOT NULL,
    cost_currency text DEFAULT 'USD'::text NOT NULL,
    min_order_amount integer DEFAULT 0 NOT NULL,
    name text NOT NULL,
    name_translations jsonb DEFAULT '{}'::jsonb NOT NULL,
    currency_pricing_mode text DEFAULT 'auto'::text NOT NULL,
    cost_amounts jsonb DEFAULT '{}'::jsonb NOT NULL,
    min_order_amounts jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT shipping_zone_methods_cost_amounts_include_source CHECK ((cost_amounts ? upper(cost_currency))),
    CONSTRAINT shipping_zone_methods_cost_amounts_valid CHECK (public.is_valid_currency_amount_map(cost_amounts)),
    CONSTRAINT shipping_zone_methods_cost_currency_format CHECK ((cost_currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT shipping_zone_methods_currency_pricing_mode_valid CHECK ((currency_pricing_mode = ANY (ARRAY['auto'::text, 'manual'::text]))),
    CONSTRAINT shipping_zone_methods_method_type_check CHECK ((method_type = ANY (ARRAY['flat_rate'::text, 'free_shipping'::text]))),
    CONSTRAINT shipping_zone_methods_min_order_amounts_include_source CHECK ((min_order_amounts ? upper(cost_currency))),
    CONSTRAINT shipping_zone_methods_min_order_amounts_valid CHECK (public.is_valid_currency_amount_map(min_order_amounts))
);

COMMENT ON COLUMN public.shipping_zone_methods.name_translations IS 'Localized shipping method labels keyed by language code. Example: {"fr": "Livraison standard"}.';

COMMENT ON COLUMN public.shipping_zone_methods.currency_pricing_mode IS 'Whether this rate uses auto FX conversion from a single source currency or exact manual amounts per currency.';

COMMENT ON COLUMN public.shipping_zone_methods.cost_amounts IS 'Shipping costs by ISO 4217 code in the smallest currency unit.';

COMMENT ON COLUMN public.shipping_zone_methods.min_order_amounts IS 'Minimum order thresholds by ISO 4217 code in the smallest currency unit.';

CREATE TABLE IF NOT EXISTS public.shipping_zones (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    priority_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.site_script_revisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    script_id uuid,
    script_name text NOT NULL,
    revision_type text NOT NULL,
    actor_user_id uuid,
    source text DEFAULT 'cms'::text NOT NULL,
    summary text,
    snapshot jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT site_script_revisions_snapshot_is_object_check CHECK ((jsonb_typeof(snapshot) = 'object'::text)),
    CONSTRAINT site_script_revisions_source_check CHECK ((source = ANY (ARRAY['cms'::text, 'mcp'::text]))),
    CONSTRAINT site_script_revisions_type_check CHECK ((revision_type = ANY (ARRAY['create'::text, 'update'::text, 'delete'::text, 'revert'::text])))
);

COMMENT ON TABLE public.site_script_revisions IS 'Append-only audit log and undo history for site_scripts. Each row is a restorable snapshot. UPDATE and DELETE are blocked by trigger, including for the service role.';

CREATE TABLE IF NOT EXISTS public.site_scripts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    code text DEFAULT ''::text NOT NULL,
    src text,
    placement text DEFAULT 'body_end'::text NOT NULL,
    load_strategy text DEFAULT 'default'::text NOT NULL,
    is_active boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT site_scripts_has_payload_check CHECK (((src IS NOT NULL) OR (length(btrim(code)) > 0))),
    CONSTRAINT site_scripts_load_strategy_check CHECK ((load_strategy = ANY (ARRAY['default'::text, 'defer'::text, 'async'::text]))),
    CONSTRAINT site_scripts_placement_check CHECK ((placement = ANY (ARRAY['head'::text, 'body_start'::text, 'body_end'::text]))),
    CONSTRAINT site_scripts_src_scheme_check CHECK (((src IS NULL) OR (src ~ '^https://'::text)))
);

COMMENT ON TABLE public.site_scripts IS 'Admin-authored JavaScript injected into the public site by the root layout, with the request CSP nonce applied. Only is_active rows are publicly readable; only ADMIN may write. Distinct from privacy_settings.custom_scripts, which is consent-gated marketing tags.';

CREATE TABLE IF NOT EXISTS public.site_settings (
    key text NOT NULL,
    value jsonb
);

COMMENT ON TABLE public.site_settings IS 'Key-value store for global site settings. Sensitive keys (Cortex AI BYOK, Bot Protection Secret, Email secret, Payment secret) hold encrypted envelopes and are restricted to ADMIN via row-level policies.';

CREATE TABLE IF NOT EXISTS public.site_themes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    description text,
    icon text DEFAULT 'Palette'::text NOT NULL,
    color_scheme text DEFAULT 'light'::text NOT NULL,
    tokens jsonb DEFAULT '{}'::jsonb NOT NULL,
    extra_css text,
    is_system boolean DEFAULT false NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT site_themes_color_scheme_check CHECK ((color_scheme = ANY (ARRAY['light'::text, 'dark'::text]))),
    CONSTRAINT site_themes_slug_format_check CHECK ((slug ~ '^[a-z][a-z0-9-]{0,38}[a-z0-9]$'::text)),
    CONSTRAINT site_themes_tokens_is_object_check CHECK ((jsonb_typeof(tokens) = 'object'::text))
);

COMMENT ON TABLE public.site_themes IS 'Editable colour themes. Each row renders to a `:root.<slug>` CSS rule injected by the root layout. Publicly readable (anonymous visitors need the palette); only ADMIN may write.';

CREATE TABLE IF NOT EXISTS public.system_alerts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    alert_type text NOT NULL,
    title text NOT NULL,
    message text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_resolved boolean DEFAULT false NOT NULL,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT system_alerts_alert_type_check CHECK ((alert_type = ANY (ARRAY['merge_conflict'::text, 'runtime_update_available'::text])))
);

COMMENT ON TABLE public.system_alerts IS 'System notifications for the automated upstream-update architecture (merge conflicts, runtime updates available). Written by service-role; read by ADMINs.';

COMMENT ON COLUMN public.system_alerts.alert_type IS 'One of: merge_conflict, runtime_update_available.';

COMMENT ON COLUMN public.system_alerts.metadata IS 'Structured deep-link context for the dashboard banner CTA (repo/branch/action_url or latest_version/download_url).';

COMMENT ON COLUMN public.system_alerts.is_resolved IS 'When true the alert is hidden from the dashboard banner.';

CREATE TABLE IF NOT EXISTS public.system_configuration (
    id integer DEFAULT 1 NOT NULL,
    auto_accept_signups boolean DEFAULT false NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT system_configuration_singleton CHECK ((id = 1))
);

COMMENT ON TABLE public.system_configuration IS 'Singleton (id = 1) of global setup-wizard configuration. ADMIN-only via RLS; never store secrets in settings.';

CREATE TABLE IF NOT EXISTS public.tax_rates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    country_code text NOT NULL,
    state_code text,
    tax_name text NOT NULL,
    tax_rate numeric(7,4) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tax_rates_tax_name_check CHECK ((char_length(btrim(tax_name)) > 0)),
    CONSTRAINT tax_rates_tax_rate_check CHECK (((tax_rate >= (0)::numeric) AND (tax_rate <= (100)::numeric)))
);

COMMENT ON TABLE public.tax_rates IS 'Manual tax rates used for Stripe storefront orders. Multiple rows can exist per jurisdiction to support combined taxes such as GST + PST.';

COMMENT ON COLUMN public.tax_rates.country_code IS 'ISO 3166-1 alpha-2 country code.';

COMMENT ON COLUMN public.tax_rates.state_code IS 'Optional state/province code within country_code. NULL represents a country-wide or federal tax.';

COMMENT ON COLUMN public.tax_rates.tax_name IS 'Display name for the tax component, for example GST, PST, HST, or State Sales Tax.';

COMMENT ON COLUMN public.tax_rates.tax_rate IS 'Percent value, not decimal fraction. Example: 5.0000 means 5%.';

CREATE TABLE IF NOT EXISTS public.thread_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    thread_id uuid NOT NULL,
    direction text NOT NULL,
    body text NOT NULL,
    author_id uuid,
    author_name text,
    email_delivered boolean DEFAULT false NOT NULL,
    email_error text,
    ip_masked text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT thread_messages_body_not_blank CHECK ((char_length(btrim(body)) > 0)),
    CONSTRAINT thread_messages_direction_check CHECK ((direction = ANY (ARRAY['inbound'::text, 'outbound'::text])))
);

COMMENT ON TABLE public.thread_messages IS 'Turns of a private conversation. Content is append-only; only the delivery flags may change after insert.';

CREATE TABLE IF NOT EXISTS public.translations (
    key text NOT NULL,
    translations jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON COLUMN public.translations.key IS 'A unique, slugified identifier (e.g., "sign_in_button_text").';

COMMENT ON COLUMN public.translations.translations IS 'Stores translations as key-value pairs (e.g., {"en": "Sign In", "fr": "S''inscrire"}).';

CREATE TABLE IF NOT EXISTS public.ucp_cart_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    locale text,
    buyer_identity jsonb DEFAULT '{}'::jsonb NOT NULL,
    context jsonb DEFAULT '{}'::jsonb NOT NULL,
    signals jsonb DEFAULT '{}'::jsonb NOT NULL,
    attribution jsonb DEFAULT '{}'::jsonb NOT NULL,
    line_items jsonb DEFAULT '[]'::jsonb NOT NULL,
    totals jsonb DEFAULT '[]'::jsonb NOT NULL,
    checkout_url text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '7 days'::interval) NOT NULL,
    CONSTRAINT ucp_cart_sessions_attribution_object CHECK ((jsonb_typeof(attribution) = 'object'::text)),
    CONSTRAINT ucp_cart_sessions_buyer_identity_object CHECK ((jsonb_typeof(buyer_identity) = 'object'::text)),
    CONSTRAINT ucp_cart_sessions_context_object CHECK ((jsonb_typeof(context) = 'object'::text)),
    CONSTRAINT ucp_cart_sessions_line_items_array CHECK ((jsonb_typeof(line_items) = 'array'::text)),
    CONSTRAINT ucp_cart_sessions_metadata_object CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT ucp_cart_sessions_signals_object CHECK ((jsonb_typeof(signals) = 'object'::text)),
    CONSTRAINT ucp_cart_sessions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'cancelled'::text, 'completed'::text]))),
    CONSTRAINT ucp_cart_sessions_totals_array CHECK ((jsonb_typeof(totals) = 'array'::text))
);

CREATE TABLE IF NOT EXISTS public.user_addresses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    address_type text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    recipient_name text,
    company_name text,
    line1 text,
    line2 text,
    city text,
    state text,
    postal_code text,
    country_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_addresses_address_type_check CHECK ((address_type = ANY (ARRAY['billing'::text, 'shipping'::text])))
);

COMMENT ON COLUMN public.user_addresses.company_name IS 'Optional company or organization name for the address.';

CREATE TABLE IF NOT EXISTS public.user_security_settings (
    user_id uuid NOT NULL,
    mfa_enabled boolean DEFAULT false NOT NULL,
    mfa_type text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_security_settings_mfa_type_check CHECK ((mfa_type = ANY (ARRAY['totp'::text, 'email'::text])))
);

COMMENT ON TABLE public.user_security_settings IS 'Per-user multi-factor configuration. mfa_type is NULL until a factor is enrolled.';

CREATE TABLE IF NOT EXISTS public.user_trusted_devices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    device_hash text NOT NULL,
    browser_metadata text,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public.user_trusted_devices IS 'SHA-256 hashes of trusted-device tokens. A 2FA bypass is only honoured when a non-expired row matches the cookie token, so deleting a row instantly revokes trust.';

COMMENT ON COLUMN public.user_trusted_devices.device_hash IS 'SHA-256 of the raw token held in the nb_trusted_device cookie. The raw token is never stored.';

CREATE TABLE IF NOT EXISTS public.variant_attribute_mapping (
    variant_id uuid NOT NULL,
    attribute_term_id uuid NOT NULL
);
