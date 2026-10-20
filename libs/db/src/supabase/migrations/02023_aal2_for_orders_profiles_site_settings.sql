-- 02023: the second factor inside RLS reaches the last ADMIN-only rows: orders, order_items,
-- profiles (other accounts' rows, admin writes) and the ADMIN tier of site_settings.
--
-- 02022 (sections 5 and 14) introduced public.is_admin_mfa() -- ADMIN, and an aal2 session
-- whenever the account has a verified MFA factor; an admin who never enrolled one always
-- passes -- and applied it where the app never reads with the cookie client (mcp_access_tokens,
-- package_activations, coupons, coupon_redemptions). It deliberately left orders, order_items,
-- profiles and the site_settings secret tier on the plain public.is_admin() check: the CMS read
-- them with the cookie-scoped client, and an ADMIN who signed in with "remember this device"
-- passes the app's own 2FA gate (proxy.ts / app/cms/layout.tsx) while the Supabase session
-- stays aal1, so gating those rows would have emptied the admin's own screens.
--
-- Those reads and writes now go through the service-role client after an in-code role check
-- (apps/nextblock/lib/auth/cms-actor.ts; libs/ecommerce .../server-actions/require-ecom-role.ts;
-- docs/04 "Row Level Security Patterns"), so this migration can put is_admin_mfa() in every
-- ADMIN branch of those tables. DB-side effect: an ADMIN session JWT carrying only a first
-- factor, used directly against PostgREST, reaches no order, no other account's profile row and
-- no setting above the staff tier, and cannot write any of them. Nothing else moves:
--
--   * owner semantics are unchanged: a customer still reads their own orders and order items,
--     every signed-in account still reads and edits its own profile row (role pinned, exactly
--     as 02021 left it);
--   * WRITER is unchanged: still reads every profiles row (02021), still nothing on orders,
--     still the public + staff tiers of site_settings and nothing above them;
--   * the anon read policy on site_settings is untouched, and the staff-tier keys stay
--     readable and the non-sensitive keys writable by an aal1 ADMIN (the ADMIN branch only
--     governs what lies above the staff tier);
--   * user_addresses has no ADMIN policy at all (owner + service role), so there is nothing
--     to gate there;
--   * the service-role policies are untouched.
--
-- Every policy is dropped by name and recreated, so the file is idempotent and re-runnable.
-- tools/scripts/security-verify.sql (sections 13-17) checks every assertion above.

-- ---------------------------------------------------------------------------
-- 1. orders: ADMIN branch requires the second factor; owner branch unchanged
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view own orders" ON public.orders;
CREATE POLICY "Users can view own orders" ON public.orders
  FOR SELECT TO authenticated
  USING (((SELECT public.is_admin_mfa()) IS TRUE) OR (user_id = (SELECT auth.uid())));

DROP POLICY IF EXISTS orders_insert_policy ON public.orders;
CREATE POLICY orders_insert_policy ON public.orders
  FOR INSERT TO authenticated
  WITH CHECK (((SELECT public.is_admin_mfa()) IS TRUE));

DROP POLICY IF EXISTS orders_update_policy ON public.orders;
CREATE POLICY orders_update_policy ON public.orders
  FOR UPDATE TO authenticated
  USING (((SELECT public.is_admin_mfa()) IS TRUE))
  WITH CHECK (((SELECT public.is_admin_mfa()) IS TRUE));

DROP POLICY IF EXISTS orders_delete_policy ON public.orders;
CREATE POLICY orders_delete_policy ON public.orders
  FOR DELETE TO authenticated
  USING (((SELECT public.is_admin_mfa()) IS TRUE));

-- ---------------------------------------------------------------------------
-- 2. order_items: same shape; the owner branch still walks through the parent order
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view own order items" ON public.order_items;
CREATE POLICY "Users can view own order items" ON public.order_items
  FOR SELECT TO authenticated
  USING (
    ((SELECT public.is_admin_mfa()) IS TRUE)
    OR EXISTS (
      SELECT 1 FROM public.orders
      WHERE orders.id = order_items.order_id
        AND orders.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS order_items_insert_policy ON public.order_items;
CREATE POLICY order_items_insert_policy ON public.order_items
  FOR INSERT TO authenticated
  WITH CHECK (((SELECT public.is_admin_mfa()) IS TRUE));

DROP POLICY IF EXISTS order_items_update_policy ON public.order_items;
CREATE POLICY order_items_update_policy ON public.order_items
  FOR UPDATE TO authenticated
  USING (((SELECT public.is_admin_mfa()) IS TRUE))
  WITH CHECK (((SELECT public.is_admin_mfa()) IS TRUE));

DROP POLICY IF EXISTS order_items_delete_policy ON public.order_items;
CREATE POLICY order_items_delete_policy ON public.order_items
  FOR DELETE TO authenticated
  USING (((SELECT public.is_admin_mfa()) IS TRUE));

-- ---------------------------------------------------------------------------
-- 3. profiles: own row as before, WRITER as before (02021), ADMIN needs the second factor
-- ---------------------------------------------------------------------------
-- 02021 wrote the staff branch as "role IN (ADMIN, WRITER)". It is split here so that the
-- WRITER half keeps its plain role check (unchanged visibility for a content role) while the
-- ADMIN half goes through is_admin_mfa(). The helpers run as the table owner (private schema,
-- SECURITY DEFINER), so a policy on profiles itself may call them without recursion.
DROP POLICY IF EXISTS profiles_read_policy ON public.profiles;
CREATE POLICY profiles_read_policy ON public.profiles
  FOR SELECT TO authenticated
  USING (
    (id = (SELECT auth.uid()))
    OR ((SELECT public.get_current_user_role()) = 'WRITER'::public.user_role)
    OR ((SELECT public.is_admin_mfa()) IS TRUE)
  );

DROP POLICY IF EXISTS profiles_insert_policy ON public.profiles;
CREATE POLICY profiles_insert_policy ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK (((SELECT public.is_admin_mfa()) IS TRUE));

-- An account edits its own row with `role` pinned to its current value (02021); an ADMIN on a
-- satisfied second factor edits any row. The protect_profile_role trigger stays behind both.
DROP POLICY IF EXISTS profiles_update_policy ON public.profiles;
CREATE POLICY profiles_update_policy ON public.profiles
  FOR UPDATE TO authenticated
  USING ((id = (SELECT auth.uid())) OR ((SELECT public.is_admin_mfa()) IS TRUE))
  WITH CHECK (
    ((SELECT public.is_admin_mfa()) IS TRUE)
    OR ((id = (SELECT auth.uid())) AND (role = (SELECT public.get_current_user_role())))
  );

-- ---------------------------------------------------------------------------
-- 4. site_settings: the ADMIN tier (reads above staff, writes of the sensitive keys)
-- ---------------------------------------------------------------------------
-- The key arrays are verbatim from 02021 (read tiers) and 02022 (write tiers); only the ADMIN
-- branch changes. The anon read policy is not touched.
DROP POLICY IF EXISTS site_settings_read_policy ON public.site_settings;
CREATE POLICY site_settings_read_policy ON public.site_settings
  FOR SELECT TO authenticated
  USING (
    (key = ANY (ARRAY['site_title','site_description','site_keywords','site_social_image','footer_copyright','footer_show_attribution','global_css','language_detection_settings','seo_robots_settings','bot_protection_public','active_logo_id','is_admin_created','privacy_settings','enabled_payment_providers','ecommerce_inventory_settings','migration_baseline_generation','invoice_settings']::text[]))
    OR ((key = ANY (ARRAY['security_settings','onboarding_state','email_public','cortex_ai_site_brief']::text[]))
      AND (SELECT public.get_current_user_role()) = ANY (ARRAY['ADMIN'::public.user_role,'WRITER'::public.user_role]))
    OR ((SELECT public.is_admin_mfa()) IS TRUE)
  );

DROP POLICY IF EXISTS site_settings_insert_policy ON public.site_settings;
CREATE POLICY site_settings_insert_policy ON public.site_settings
  FOR INSERT TO authenticated
  WITH CHECK (
    (key <> ALL (ARRAY['cortex_ai_openrouter_api_key','bot_protection_secret','email_secret','payment_secret','language_detection_settings','cortex_ai_pexels_api_key','cortex_ai_unsplash_access_key','cortex_ai_mcp_settings','seo_robots_settings','privacy_settings','is_admin_created','global_css','security_settings']::text[])
      AND (SELECT public.get_current_user_role()) = ANY (ARRAY['ADMIN'::public.user_role,'WRITER'::public.user_role]))
    OR (key = ANY (ARRAY['cortex_ai_openrouter_api_key','bot_protection_secret','email_secret','payment_secret','language_detection_settings','cortex_ai_pexels_api_key','cortex_ai_unsplash_access_key','cortex_ai_mcp_settings','seo_robots_settings','privacy_settings','is_admin_created','global_css','security_settings']::text[])
      AND ((SELECT public.is_admin_mfa()) IS TRUE))
  );

DROP POLICY IF EXISTS site_settings_update_policy ON public.site_settings;
CREATE POLICY site_settings_update_policy ON public.site_settings
  FOR UPDATE TO authenticated
  USING (
    (key <> ALL (ARRAY['cortex_ai_openrouter_api_key','bot_protection_secret','email_secret','payment_secret','language_detection_settings','cortex_ai_pexels_api_key','cortex_ai_unsplash_access_key','cortex_ai_mcp_settings','seo_robots_settings','privacy_settings','is_admin_created','global_css','security_settings']::text[])
      AND (SELECT public.get_current_user_role()) = ANY (ARRAY['ADMIN'::public.user_role,'WRITER'::public.user_role]))
    OR (key = ANY (ARRAY['cortex_ai_openrouter_api_key','bot_protection_secret','email_secret','payment_secret','language_detection_settings','cortex_ai_pexels_api_key','cortex_ai_unsplash_access_key','cortex_ai_mcp_settings','seo_robots_settings','privacy_settings','is_admin_created','global_css','security_settings']::text[])
      AND ((SELECT public.is_admin_mfa()) IS TRUE))
  )
  WITH CHECK (
    (key <> ALL (ARRAY['cortex_ai_openrouter_api_key','bot_protection_secret','email_secret','payment_secret','language_detection_settings','cortex_ai_pexels_api_key','cortex_ai_unsplash_access_key','cortex_ai_mcp_settings','seo_robots_settings','privacy_settings','is_admin_created','global_css','security_settings']::text[])
      AND (SELECT public.get_current_user_role()) = ANY (ARRAY['ADMIN'::public.user_role,'WRITER'::public.user_role]))
    OR (key = ANY (ARRAY['cortex_ai_openrouter_api_key','bot_protection_secret','email_secret','payment_secret','language_detection_settings','cortex_ai_pexels_api_key','cortex_ai_unsplash_access_key','cortex_ai_mcp_settings','seo_robots_settings','privacy_settings','is_admin_created','global_css','security_settings']::text[])
      AND ((SELECT public.is_admin_mfa()) IS TRUE))
  );

DROP POLICY IF EXISTS site_settings_delete_policy ON public.site_settings;
CREATE POLICY site_settings_delete_policy ON public.site_settings
  FOR DELETE TO authenticated
  USING (
    (key <> ALL (ARRAY['cortex_ai_openrouter_api_key','bot_protection_secret','email_secret','payment_secret','language_detection_settings','cortex_ai_pexels_api_key','cortex_ai_unsplash_access_key','cortex_ai_mcp_settings','seo_robots_settings','privacy_settings','is_admin_created','global_css','security_settings']::text[])
      AND (SELECT public.get_current_user_role()) = ANY (ARRAY['ADMIN'::public.user_role,'WRITER'::public.user_role]))
    OR (key = ANY (ARRAY['cortex_ai_openrouter_api_key','bot_protection_secret','email_secret','payment_secret','language_detection_settings','cortex_ai_pexels_api_key','cortex_ai_unsplash_access_key','cortex_ai_mcp_settings','seo_robots_settings','privacy_settings','is_admin_created','global_css','security_settings']::text[])
      AND ((SELECT public.is_admin_mfa()) IS TRUE))
  );
