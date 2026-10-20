-- 02022: close the privilege and disclosure holes the 2026-10-19 red-team confirmed on a local
-- replay of this folder. Append-only, idempotent, forward-only (02021 is the prior fix; see its
-- header and docs/04 "Row Level Security Patterns"). Every policy is dropped by name before it is
-- recreated so a generation-1 policy under a different name cannot keep the old behaviour.
--
-- What this migration fixes (DB layer only; the matching app-code changes ship in the same PR):
--
--  1. site_settings write tiers. 02021 tiered READS by key but WRITES still let any WRITER write
--     every non-"secret" key. Four of those keys are security-sensitive sinks a WRITER could abuse
--     over PostgREST with only a first-factor session:
--       * privacy_settings.custom_scripts  -> site-wide stored XSS (executes for visitors and in /cms)
--       * global_css                        -> site-wide raw <style> injection (incl. /cms)
--       * is_admin_created                  -> reset it to re-open the first-admin bootstrap
--                                              (WRITER -> ADMIN) AND to funnel all traffic to /setup
--                                              (full-site DoS; proxy.ts reads it)
--       * security_settings                 -> flip enforce_staff_2fa / stretch trusted_device_days
--     They move into the ADMIN-only branch of the three write policies. Reads are unchanged
--     (02021 still lets anon read privacy_settings/global_css/is_admin_created for the public site
--     and the /setup redirect; security_settings stays ADMIN/WRITER-read).
--
--  2. handle_new_user() becomes a true one-shot. The baseline granted ADMIN to a new sign-up
--     whenever site_settings.is_admin_created was false, trusting a mutable flag. Now it also
--     requires that NO admin profile exists yet, so resetting the flag (section 1 already blocks
--     that for a WRITER, this is defense in depth) or a concurrent first-boot race can never mint a
--     second ADMIN. Self-heals the flag either way. service_role/postgres writes are unaffected
--     (the trigger runs as the table owner regardless of caller).
--
--  3. package_activations holds PLAINTEXT license keys. 02014 let ADMIN *and* WRITER read them;
--     a content-role account does not need vendor license keys. Read drops to ADMIN, and is gated
--     by a satisfied second factor (section 5).
--
--  4. Scheduled/draft/archived product rows still leaked their media links and category links to
--     anon (02021 re-cut products + product_variants but not these), and inventory_items published
--     every SKU's stock. Each anon read is scoped to a product that is actually live, matching the
--     product_variants policy 02021 already ships. Staff still read everything.
--
--  5. aal2-in-RLS for the sharpest ADMIN-only tables. The app enforces 2FA only in proxy.ts /
--     app/cms/layout.tsx, so an ADMIN session JWT used directly against PostgREST reaches every
--     ADMIN-gated table with a first factor alone. private.meets_aal_requirement() + the
--     public.is_admin_mfa() invoker wrapper (same private/public split as 02021's role helpers, to
--     keep advisor lints 0028/0029 quiet) require aal2 ONLY for a user who actually enrolled a
--     factor, so a no-MFA admin is never locked out. Applied here to mcp_access_tokens (self-minting
--     a usable bearer is a persistence primitive) and package_activations (plaintext keys). Widening
--     is_admin_mfa() to the other ADMIN policies is a larger, separately-reviewed change (docs/04).
--
--  6. email_2fa_challenges.attempts: a failure counter so lib/auth/twoFactor.ts can lock a code
--     pool after a few wrong guesses (the email factor had no attempt limit).
--
--  7. ucp_cart_sessions.access_token_hash: sha256 of a per-cart capability token the UCP routes
--     now require, so a cart UUID alone no longer reads/overwrites/cancels a cart (buyer PII).
--
--  8. redeem_coupon_atomically(uuid): one locked UPDATE that re-checks redemption_limit and
--     increments redemptions_count in SQL (the app's read-then-write lost updates past the cap).
--     service_role-only.
--
--  9. media update/delete bound to the uploader: a WRITER touches only rows they uploaded (and
--     cannot re-assign uploader_id); ADMIN keeps every row.
--
-- 10. cortex_request_log: service-role-only per-user accounting the /api/ai/* routes use to cap
--     a WRITER's OpenRouter spend (no rate or budget cap existed).

-- ---------------------------------------------------------------------------
-- 1. site_settings: move four sensitive keys into the ADMIN-only write tier
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS site_settings_insert_policy ON public.site_settings;
CREATE POLICY site_settings_insert_policy ON public.site_settings
  FOR INSERT TO authenticated
  WITH CHECK (
    (key <> ALL (ARRAY['cortex_ai_openrouter_api_key','bot_protection_secret','email_secret','payment_secret','language_detection_settings','cortex_ai_pexels_api_key','cortex_ai_unsplash_access_key','cortex_ai_mcp_settings','seo_robots_settings','privacy_settings','is_admin_created','global_css','security_settings']::text[])
      AND (SELECT public.get_current_user_role()) = ANY (ARRAY['ADMIN'::public.user_role,'WRITER'::public.user_role]))
    OR (key = ANY (ARRAY['cortex_ai_openrouter_api_key','bot_protection_secret','email_secret','payment_secret','language_detection_settings','cortex_ai_pexels_api_key','cortex_ai_unsplash_access_key','cortex_ai_mcp_settings','seo_robots_settings','privacy_settings','is_admin_created','global_css','security_settings']::text[])
      AND (SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role)
  );

DROP POLICY IF EXISTS site_settings_update_policy ON public.site_settings;
CREATE POLICY site_settings_update_policy ON public.site_settings
  FOR UPDATE TO authenticated
  USING (
    (key <> ALL (ARRAY['cortex_ai_openrouter_api_key','bot_protection_secret','email_secret','payment_secret','language_detection_settings','cortex_ai_pexels_api_key','cortex_ai_unsplash_access_key','cortex_ai_mcp_settings','seo_robots_settings','privacy_settings','is_admin_created','global_css','security_settings']::text[])
      AND (SELECT public.get_current_user_role()) = ANY (ARRAY['ADMIN'::public.user_role,'WRITER'::public.user_role]))
    OR (key = ANY (ARRAY['cortex_ai_openrouter_api_key','bot_protection_secret','email_secret','payment_secret','language_detection_settings','cortex_ai_pexels_api_key','cortex_ai_unsplash_access_key','cortex_ai_mcp_settings','seo_robots_settings','privacy_settings','is_admin_created','global_css','security_settings']::text[])
      AND (SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role)
  )
  WITH CHECK (
    (key <> ALL (ARRAY['cortex_ai_openrouter_api_key','bot_protection_secret','email_secret','payment_secret','language_detection_settings','cortex_ai_pexels_api_key','cortex_ai_unsplash_access_key','cortex_ai_mcp_settings','seo_robots_settings','privacy_settings','is_admin_created','global_css','security_settings']::text[])
      AND (SELECT public.get_current_user_role()) = ANY (ARRAY['ADMIN'::public.user_role,'WRITER'::public.user_role]))
    OR (key = ANY (ARRAY['cortex_ai_openrouter_api_key','bot_protection_secret','email_secret','payment_secret','language_detection_settings','cortex_ai_pexels_api_key','cortex_ai_unsplash_access_key','cortex_ai_mcp_settings','seo_robots_settings','privacy_settings','is_admin_created','global_css','security_settings']::text[])
      AND (SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role)
  );

DROP POLICY IF EXISTS site_settings_delete_policy ON public.site_settings;
CREATE POLICY site_settings_delete_policy ON public.site_settings
  FOR DELETE TO authenticated
  USING (
    (key <> ALL (ARRAY['cortex_ai_openrouter_api_key','bot_protection_secret','email_secret','payment_secret','language_detection_settings','cortex_ai_pexels_api_key','cortex_ai_unsplash_access_key','cortex_ai_mcp_settings','seo_robots_settings','privacy_settings','is_admin_created','global_css','security_settings']::text[])
      AND (SELECT public.get_current_user_role()) = ANY (ARRAY['ADMIN'::public.user_role,'WRITER'::public.user_role]))
    OR (key = ANY (ARRAY['cortex_ai_openrouter_api_key','bot_protection_secret','email_secret','payment_secret','language_detection_settings','cortex_ai_pexels_api_key','cortex_ai_unsplash_access_key','cortex_ai_mcp_settings','seo_robots_settings','privacy_settings','is_admin_created','global_css','security_settings']::text[])
      AND (SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role)
  );

-- ---------------------------------------------------------------------------
-- 2. handle_new_user(): ADMIN only for the genuine first account, never again
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public'
    AS $function$
DECLARE
  admin_flag_set boolean := false;
  admin_exists boolean := false;
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

  -- The flag alone is not trusted: a reset (now ADMIN-only to write, but defense in depth) or a
  -- concurrent first-boot must never mint a second ADMIN. Promotion requires BOTH that the flag is
  -- unset AND that no admin profile exists yet. The FOR UPDATE above serialises concurrent sign-ups.
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE role = 'ADMIN'::public.user_role)
    INTO admin_exists;

  IF admin_flag_set = false AND admin_exists = false THEN
    user_role := 'ADMIN'::public.user_role;
  ELSE
    user_role := 'USER'::public.user_role;
  END IF;

  -- Always mark bootstrap complete once any account is created, so a drifted/reset flag self-heals.
  UPDATE public.site_settings
  SET value = 'true'::jsonb
  WHERE key = 'is_admin_created' AND value IS DISTINCT FROM 'true'::jsonb;

  v_full_name := NEW.raw_user_meta_data->>'full_name';
  v_avatar_url := NEW.raw_user_meta_data->>'avatar_url';

  INSERT INTO public.profiles (id, role, full_name, avatar_url)
  VALUES (NEW.id, user_role, v_full_name, v_avatar_url)
  ON CONFLICT (id) DO UPDATE SET
    full_name = EXCLUDED.full_name,
    avatar_url = EXCLUDED.avatar_url;

  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5a. aal2-in-RLS helpers (defined before section 3/5b use them)
-- ---------------------------------------------------------------------------
-- True unless the caller has a verified MFA factor but the current session is not aal2. A user
-- who never enrolled a factor always passes, so no admin is ever locked out by enabling this.
CREATE OR REPLACE FUNCTION private.meets_aal_requirement()
    RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT COALESCE((auth.jwt() ->> 'aal'), 'aal1') = 'aal2'
    OR NOT EXISTS (
      SELECT 1 FROM auth.mfa_factors f
      WHERE f.user_id = auth.uid() AND f.status = 'verified'
    );
$$;
REVOKE ALL ON FUNCTION private.meets_aal_requirement() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.meets_aal_requirement() TO anon, authenticated, service_role;

-- SECURITY INVOKER public wrapper (never a SECURITY DEFINER function in public — advisor 0028/0029).
CREATE OR REPLACE FUNCTION public.is_admin_mfa()
    RETURNS boolean
    LANGUAGE sql STABLE SECURITY INVOKER
    SET search_path TO 'public'
    AS $$
  SELECT public.is_admin() AND private.meets_aal_requirement();
$$;
REVOKE ALL ON FUNCTION public.is_admin_mfa() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin_mfa() TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. package_activations: ADMIN read only, second factor required
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Staff read package activations" ON public.package_activations;
CREATE POLICY "Staff read package activations" ON public.package_activations
  FOR SELECT TO authenticated
  USING ((SELECT public.is_admin_mfa()));

-- ---------------------------------------------------------------------------
-- 4. Draft/archived/scheduled products: media, categories and stock stay staff-only
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Public can view product media" ON public.product_media;
CREATE POLICY "Public can view product media" ON public.product_media
  FOR SELECT TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.products p
      WHERE p.id = product_media.product_id
        AND p.status = 'active'
        AND (p.published_at IS NULL OR p.published_at <= now())
    )
    OR (SELECT public.get_current_user_role()) = ANY (ARRAY['ADMIN'::public.user_role,'WRITER'::public.user_role])
  );

DROP POLICY IF EXISTS "Public can view product_categories" ON public.product_categories;
CREATE POLICY "Public can view product_categories" ON public.product_categories
  FOR SELECT TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.products p
      WHERE p.id = product_categories.product_id
        AND p.status = 'active'
        AND (p.published_at IS NULL OR p.published_at <= now())
    )
    OR (SELECT public.get_current_user_role()) = ANY (ARRAY['ADMIN'::public.user_role,'WRITER'::public.user_role])
  );

DROP POLICY IF EXISTS "Public can view inventory items" ON public.inventory_items;
CREATE POLICY "Public can view inventory items" ON public.inventory_items
  FOR SELECT TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.products p
      WHERE p.sku = inventory_items.sku
        AND p.status = 'active'
        AND (p.published_at IS NULL OR p.published_at <= now())
    )
    OR EXISTS (
      SELECT 1 FROM public.product_variants v
      JOIN public.products p ON p.id = v.product_id
      WHERE v.sku = inventory_items.sku
        AND p.status = 'active'
        AND (p.published_at IS NULL OR p.published_at <= now())
    )
    OR (SELECT public.get_current_user_role()) = ANY (ARRAY['ADMIN'::public.user_role,'WRITER'::public.user_role])
  );

-- ---------------------------------------------------------------------------
-- 5b. aal2 for mcp_access_tokens (token self-mint is a persistence primitive)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS mcp_access_tokens_admin_select ON public.mcp_access_tokens;
CREATE POLICY mcp_access_tokens_admin_select ON public.mcp_access_tokens
  FOR SELECT TO authenticated USING ((SELECT public.is_admin_mfa()));

DROP POLICY IF EXISTS mcp_access_tokens_admin_insert ON public.mcp_access_tokens;
CREATE POLICY mcp_access_tokens_admin_insert ON public.mcp_access_tokens
  FOR INSERT TO authenticated WITH CHECK ((SELECT public.is_admin_mfa()));

DROP POLICY IF EXISTS mcp_access_tokens_admin_update ON public.mcp_access_tokens;
CREATE POLICY mcp_access_tokens_admin_update ON public.mcp_access_tokens
  FOR UPDATE TO authenticated USING ((SELECT public.is_admin_mfa())) WITH CHECK ((SELECT public.is_admin_mfa()));

DROP POLICY IF EXISTS mcp_access_tokens_admin_delete ON public.mcp_access_tokens;
CREATE POLICY mcp_access_tokens_admin_delete ON public.mcp_access_tokens
  FOR DELETE TO authenticated USING ((SELECT public.is_admin_mfa()));

-- ---------------------------------------------------------------------------
-- 6. Email-2FA brute force: give each challenge a failure counter
-- ---------------------------------------------------------------------------
-- The email second-factor had no attempt limit: a party holding a victim's password (first
-- factor) could iterate all 10^6 codes against the unthrottled verify path. The counter lets
-- lib/auth/twoFactor.ts lock the live code pool after a few wrong guesses. Column only; no grant
-- needed (table already granted), and the table is service-role/owner-written.
ALTER TABLE public.email_2fa_challenges ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;

-- Atomic failure-counter bump so concurrent wrong guesses cannot each read the same count and
-- overwrite one another (a read-then-write in app code is racy). Increments every live code for
-- the user under the row locks and returns the new maximum; the server burns the pool when that
-- reaches the limit. SECURITY DEFINER in `private` (never callable over /rpc) and service_role-only.
CREATE OR REPLACE FUNCTION private.bump_email_2fa_attempts(p_user_id uuid)
    RETURNS integer
    LANGUAGE sql VOLATILE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  WITH bumped AS (
    UPDATE public.email_2fa_challenges
       SET attempts = attempts + 1
     WHERE user_id = p_user_id
       AND consumed_at IS NULL
       AND expires_at > now()
    RETURNING attempts
  )
  SELECT COALESCE(MAX(attempts), 0)::integer FROM bumped;
$$;
REVOKE ALL ON FUNCTION private.bump_email_2fa_attempts(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.bump_email_2fa_attempts(uuid) TO service_role;

-- SECURITY INVOKER public wrapper so the server can call it through PostgREST rpc with the
-- service-role client (the private function is not itself API-reachable). Not granted to anon.
CREATE OR REPLACE FUNCTION public.bump_email_2fa_attempts(p_user_id uuid)
    RETURNS integer
    LANGUAGE sql VOLATILE SECURITY INVOKER
    SET search_path TO 'public'
    AS $$
  SELECT private.bump_email_2fa_attempts(p_user_id);
$$;
REVOKE ALL ON FUNCTION public.bump_email_2fa_attempts(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bump_email_2fa_attempts(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 7. UCP carts: a per-cart capability token (ucp-cart-idor)
-- ---------------------------------------------------------------------------
-- /ucp/v1/carts/{id} authorised on the cart UUID alone through the service-role client, so anyone
-- who learned an id could read the buyer PII in buyer_identity, overwrite or cancel the cart. The
-- app now mints a random capability token when it creates a cart, returns it once, and stores
-- only its sha256 hex here; every later read/write must present it. Nullable so carts created
-- before this column stay readable by the app's legacy path until they expire (7 days). Column
-- only; the table is already granted and its sole policy is service_role-only (anon /
-- authenticated hold table grants but no policy, so RLS denies them every row).
ALTER TABLE public.ucp_cart_sessions ADD COLUMN IF NOT EXISTS access_token_hash text;

-- ---------------------------------------------------------------------------
-- 8. Coupons: atomic, limit-aware redemption counter (coupon-redemption-race)
-- ---------------------------------------------------------------------------
-- libs/ecommerce coupon-server.ts incremented redemptions_count with a SELECT then an UPDATE that
-- wrote an app-computed literal, and checked the limit against the lagging read: concurrent
-- checkouts each passed the gate and overwrote each other's increment, so a redemption_limit=N
-- coupon could be redeemed well past N. This single UPDATE takes the row lock, re-checks the
-- limit under it and increments in SQL, so exactly N calls return true. It returns false (never
-- NULL) when the coupon is missing, inactive or exhausted. SECURITY INVOKER and service_role-only:
-- the checkout server calls it with the service client (RLS bypass is intended there); no browser
-- or PostgREST caller may bump a counter directly.
CREATE OR REPLACE FUNCTION public.redeem_coupon_atomically(p_coupon_id uuid)
    RETURNS boolean
    LANGUAGE sql
    SECURITY INVOKER
    SET search_path TO 'public'
    AS $$
  WITH redeemed AS (
    UPDATE public.coupons
    SET redemptions_count = COALESCE(redemptions_count, 0) + 1,
        updated_at = now()
    WHERE id = p_coupon_id
      AND is_active
      AND (redemption_limit IS NULL OR COALESCE(redemptions_count, 0) < redemption_limit)
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM redeemed);
$$;
REVOKE ALL ON FUNCTION public.redeem_coupon_atomically(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_coupon_atomically(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 9. media: a WRITER edits and deletes only their own uploads (media-no-ownership-binding)
-- ---------------------------------------------------------------------------
-- media_update_policy / media_delete_policy let any WRITER overwrite or delete ANY media row
-- (nothing bound the row to its uploader), and the UPDATE check let a WRITER re-assign
-- uploader_id. ADMIN keeps every row. A WRITER keeps rows where uploader_id is their own id, and
-- WITH CHECK keeps uploader_id pinned to them on update. The /cms/media actions use the cookie
-- client, so this is enforced for the UI as well as for raw PostgREST. media_insert_policy and
-- media_read_policy are unchanged (the app sets uploader_id = the session user on insert).
DROP POLICY IF EXISTS media_update_policy ON public.media;
CREATE POLICY media_update_policy ON public.media
  FOR UPDATE TO authenticated
  USING (
    (SELECT public.is_admin()) IS TRUE
    OR (uploader_id = (SELECT auth.uid())
        AND (SELECT public.get_current_user_role()) = ANY (ARRAY['ADMIN'::public.user_role,'WRITER'::public.user_role]))
  )
  WITH CHECK (
    (SELECT public.is_admin()) IS TRUE
    OR (uploader_id = (SELECT auth.uid())
        AND (SELECT public.get_current_user_role()) = ANY (ARRAY['ADMIN'::public.user_role,'WRITER'::public.user_role]))
  );

DROP POLICY IF EXISTS media_delete_policy ON public.media;
CREATE POLICY media_delete_policy ON public.media
  FOR DELETE TO authenticated
  USING (
    (SELECT public.is_admin()) IS TRUE
    OR (uploader_id = (SELECT auth.uid())
        AND (SELECT public.get_current_user_role()) = ANY (ARRAY['ADMIN'::public.user_role,'WRITER'::public.user_role]))
  );

-- ---------------------------------------------------------------------------
-- 10. cortex_request_log: per-user request accounting for the AI routes (writer-openrouter-cost-abuse)
-- ---------------------------------------------------------------------------
-- The four /api/ai/* routes accepted unlimited calls from any WRITER with no per-user rate or
-- spend cap, each one billed to the operator's OpenRouter key. The routes now record one row per
-- accepted request (service client) and refuse with 429 once a user exceeds the window budget;
-- the index serves that count. Service-role only: RLS is ON with NO anon/authenticated policy
-- (service_role bypasses RLS), and whatever Supabase's default privileges granted at CREATE is
-- revoked before the exact grant below, so a browser session can neither read other users'
-- activity nor pad or purge its own counter. Old rows are pruned by the same server path
-- (DELETE granted for that).
CREATE TABLE IF NOT EXISTS public.cortex_request_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  route text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cortex_request_log_user_created_idx
  ON public.cortex_request_log (user_id, created_at DESC);
ALTER TABLE public.cortex_request_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cortex_request_log FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, DELETE ON TABLE public.cortex_request_log TO service_role;

-- ---------------------------------------------------------------------------
-- 11. Seed the shopper-facing copy the new checkout/coupon guards return (EN + FR)
-- ---------------------------------------------------------------------------
-- The coupon validation path now returns one uniform key for every rejection (so it is not an
-- existence oracle), and the server-side shipping re-validation adds two keys. t(key) returns the
-- KEY for an unseeded key, so these must ship or shoppers see a raw key. Bilingual per CLAUDE.md.
INSERT INTO public.translations (key, translations, created_at, updated_at)
VALUES
  ('ecommerce.coupon_invalid', '{"en":"This coupon code is invalid or can''t be applied to your cart.","fr":"Ce code promo est invalide ou ne peut pas être appliqué à votre panier."}'::jsonb, now(), now()),
  ('ecommerce.checkout_invalid_shipping_method', '{"en":"That shipping method is not available for your address. Please choose another.","fr":"Ce mode de livraison n''est pas disponible pour votre adresse. Veuillez en choisir un autre."}'::jsonb, now(), now()),
  ('ecommerce.checkout_shipping_address_required', '{"en":"A shipping address is required to calculate shipping.","fr":"Une adresse de livraison est requise pour calculer les frais d''expédition."}'::jsonb, now(), now())
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 12. order_items: a database backstop for the positive-quantity checkout guard
-- ---------------------------------------------------------------------------
-- The providers now clamp quantity, but apply_order_inventory_deduction and any other writer
-- still trust SUM(order_items.quantity). A CHECK closes every path. NOT VALID first so the add is
-- instant and cannot fail on any pre-existing bad row; VALIDATE separately (safe if all rows pass,
-- and this is a fresh constraint). Idempotent.
ALTER TABLE public.order_items DROP CONSTRAINT IF EXISTS order_items_quantity_positive;
ALTER TABLE public.order_items ADD CONSTRAINT order_items_quantity_positive CHECK (quantity > 0) NOT VALID;
ALTER TABLE public.order_items VALIDATE CONSTRAINT order_items_quantity_positive;

-- ---------------------------------------------------------------------------
-- 13. cms_interactions: cap how fast one account can create pending interactions
-- ---------------------------------------------------------------------------
-- cms_interactions_insert_policy admits unlimited own-user pending rows; a signed-up account can
-- flood the moderation queue straight through PostgREST (the app-layer limit never sees that path).
-- A BEFORE INSERT trigger enforces the cap in the DB for ordinary users only; staff and the
-- service role (moderation, replies) are exempt. SECURITY DEFINER in private, not API-callable.
CREATE OR REPLACE FUNCTION private.enforce_cms_interaction_rate_limit()
    RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  recent_count integer;
  pending_total integer;
BEGIN
  -- Only ordinary signed-in users are limited; service_role/postgres carry no session, staff are trusted.
  IF auth.uid() IS NULL
     OR (SELECT public.get_current_user_role()) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role]) THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO recent_count
  FROM public.cms_interactions
  WHERE user_id = auth.uid()
    AND status = 'pending'::public.approval_status
    AND created_at > now() - interval '10 minutes';
  IF recent_count >= 5 THEN
    RAISE EXCEPTION 'Too many submissions. Please wait a few minutes and try again.'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*) INTO pending_total
  FROM public.cms_interactions
  WHERE user_id = auth.uid()
    AND status = 'pending'::public.approval_status;
  IF pending_total >= 50 THEN
    RAISE EXCEPTION 'You have too many submissions awaiting review.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.enforce_cms_interaction_rate_limit() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS enforce_cms_interaction_rate_limit ON public.cms_interactions;
CREATE TRIGGER enforce_cms_interaction_rate_limit
  BEFORE INSERT ON public.cms_interactions
  FOR EACH ROW
  EXECUTE FUNCTION private.enforce_cms_interaction_rate_limit();

-- ---------------------------------------------------------------------------
-- 14. aal2 for coupons and coupon_redemptions (money-adjacent, app reads them via service role)
-- ---------------------------------------------------------------------------
-- Widens the section-5 posture to the next tier whose app access never uses the cookie client
-- (CMS coupon pages and the storefront validator both use the service role), so gating the
-- authenticated admin policies behind is_admin_mfa() closes the direct-PostgREST aal1 path
-- without locking a "remember this device" admin out of any screen. Tables the CMS still reads
-- with the cookie client (orders, user_addresses, site_settings secrets, profiles) are left on the
-- plain role check until those reads move to the service role (docs/04).
DROP POLICY IF EXISTS coupons_admin_select_policy ON public.coupons;
CREATE POLICY coupons_admin_select_policy ON public.coupons
  FOR SELECT TO authenticated USING (((SELECT public.is_admin_mfa()) IS TRUE));
DROP POLICY IF EXISTS coupons_admin_insert_policy ON public.coupons;
CREATE POLICY coupons_admin_insert_policy ON public.coupons
  FOR INSERT TO authenticated WITH CHECK (((SELECT public.is_admin_mfa()) IS TRUE));
DROP POLICY IF EXISTS coupons_admin_update_policy ON public.coupons;
CREATE POLICY coupons_admin_update_policy ON public.coupons
  FOR UPDATE TO authenticated USING (((SELECT public.is_admin_mfa()) IS TRUE)) WITH CHECK (((SELECT public.is_admin_mfa()) IS TRUE));
DROP POLICY IF EXISTS coupons_admin_delete_policy ON public.coupons;
CREATE POLICY coupons_admin_delete_policy ON public.coupons
  FOR DELETE TO authenticated USING (((SELECT public.is_admin_mfa()) IS TRUE));
DROP POLICY IF EXISTS coupon_redemptions_admin_select_policy ON public.coupon_redemptions;
CREATE POLICY coupon_redemptions_admin_select_policy ON public.coupon_redemptions
  FOR SELECT TO authenticated USING (((SELECT public.is_admin_mfa()) IS TRUE));
