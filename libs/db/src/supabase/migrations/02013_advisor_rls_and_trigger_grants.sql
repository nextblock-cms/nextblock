-- 02013: clear the Supabase Advisor warnings on RLS policies and trigger-function grants.
--
-- Performance advisor
-- * auth_rls_initplan: cms_interactions_insert_policy called auth.uid() per candidate row.
--   Wrapped as (select auth.uid()) it becomes an InitPlan evaluated once per statement.
-- * multiple_permissive_policies: cms_redirects and site_scripts each had two SELECT
--   policies for `authenticated` ("Admins read all …" and "Public read active …"), and
--   form_endpoints had an admin FOR ALL policy overlapping the editor SELECT policy. Every
--   permissive policy that matches a role + command is evaluated for every row, so the
--   policies are re-cut so exactly one applies per role + command. Who can read or write
--   what is unchanged:
--     - anon reads active redirects / scripts;
--     - authenticated reads active rows, ADMIN reads all;
--     - form_endpoints: ADMIN + WRITER read, ADMIN writes (now three command-scoped
--       policies instead of FOR ALL), service_role unchanged.
--
-- Security advisor
-- * anon_/authenticated_security_definer_function_executable: handle_new_user() and
--   update_product_ratings() are SECURITY DEFINER trigger functions. Postgres checks
--   EXECUTE on a trigger function only at CREATE TRIGGER time, never when the trigger
--   fires (and PostgREST cannot call a `RETURNS trigger` function via /rpc anyway), so
--   anon and authenticated never needed the privilege. 02003 already revokes it on
--   handle_new_user() for fresh installs, but production recorded the baseline as applied
--   without running it (docs/04 → "How a squash crosses live databases"), so the
--   generation-1 grants were still live there. Idempotent: safe on a fresh install too.
--
-- The two Auth-dashboard warnings (leaked password protection, MFA options) are project
-- settings, not schema, and are not addressed here.

-- ---------------------------------------------------------------------------
-- cms_interactions: InitPlan-friendly auth.uid()
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS cms_interactions_insert_policy ON public.cms_interactions;
CREATE POLICY cms_interactions_insert_policy ON public.cms_interactions
  FOR INSERT TO authenticated
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
    AND (
      status = 'pending'::public.approval_status
      OR (SELECT public.get_current_user_role()) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])
    )
  );

-- ---------------------------------------------------------------------------
-- cms_redirects: one SELECT policy per role
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins read all redirects" ON public.cms_redirects;
DROP POLICY IF EXISTS "Public read active redirects" ON public.cms_redirects;
DROP POLICY IF EXISTS "Authenticated read redirects" ON public.cms_redirects;

CREATE POLICY "Public read active redirects" ON public.cms_redirects
  FOR SELECT TO anon
  USING (is_active);

CREATE POLICY "Authenticated read redirects" ON public.cms_redirects
  FOR SELECT TO authenticated
  USING (is_active OR (SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role);

-- ---------------------------------------------------------------------------
-- site_scripts: one SELECT policy per role
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins read all site scripts" ON public.site_scripts;
DROP POLICY IF EXISTS "Public read active site scripts" ON public.site_scripts;
DROP POLICY IF EXISTS "Authenticated read site scripts" ON public.site_scripts;

CREATE POLICY "Public read active site scripts" ON public.site_scripts
  FOR SELECT TO anon
  USING (is_active);

CREATE POLICY "Authenticated read site scripts" ON public.site_scripts
  FOR SELECT TO authenticated
  USING (is_active OR (SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role);

-- ---------------------------------------------------------------------------
-- form_endpoints: admin FOR ALL -> INSERT / UPDATE / DELETE, editor SELECT stays the only read
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS form_endpoints_admin_write_policy ON public.form_endpoints;
DROP POLICY IF EXISTS form_endpoints_admin_insert_policy ON public.form_endpoints;
DROP POLICY IF EXISTS form_endpoints_admin_update_policy ON public.form_endpoints;
DROP POLICY IF EXISTS form_endpoints_admin_delete_policy ON public.form_endpoints;

CREATE POLICY form_endpoints_admin_insert_policy ON public.form_endpoints
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role);

CREATE POLICY form_endpoints_admin_update_policy ON public.form_endpoints
  FOR UPDATE TO authenticated
  USING ((SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role)
  WITH CHECK ((SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role);

CREATE POLICY form_endpoints_admin_delete_policy ON public.form_endpoints
  FOR DELETE TO authenticated
  USING ((SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role);

-- ---------------------------------------------------------------------------
-- SECURITY DEFINER trigger functions: not callable by API roles
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role;

REVOKE EXECUTE ON FUNCTION public.update_product_ratings() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_product_ratings() TO service_role;
