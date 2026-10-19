-- 02021: profiles are readable by their owner and staff only, `role` is admin-only, and the
-- revision tables are staff-only.
--
-- Reported 2026-10-17 and reproduced 2026-10-19 on a local replay of this folder. The baseline
-- shipped three holes:
--
-- * profiles_read_policy was FOR SELECT USING (true) with no TO clause, so it applied to every
--   role. The anon key that ships in the site bundle could list every account's full_name,
--   phone, website, avatar_url and role (no e-mail: that stays in auth.users).
-- * profiles_update_policy let any signed-in account update its own row with no column
--   restriction, and nothing guarded `role`. One PATCH from a self-registered session set
--   role = 'ADMIN'; get_current_user_role(), proxy.ts and app/cms/layout.tsx all trust that
--   column, so the account became a full CMS admin.
-- * page_revisions, post_revisions and product_revisions were FOR SELECT TO authenticated
--   USING (true): any customer account could read every historical version of every page, post
--   and product, published or not.
--
-- The fix:
--
-- 1. The role lookup moves to private.current_user_role(), a SECURITY DEFINER function in a
--    schema PostgREST does not expose. Running as the table owner makes it independent of the
--    profiles policies below, which now call it themselves (as SECURITY INVOKER it would only
--    work because the OR in the new SELECT policy short-circuits on the caller's own row and a
--    function with a SET clause is never inlined). public.get_current_user_role() and
--    public.is_admin() keep their names and signatures as SECURITY INVOKER wrappers, so the
--    150 policies that call them are untouched, and the Supabase advisor lints
--    0028/0029 (SECURITY DEFINER function executable by anon/authenticated in an exposed
--    schema) stay quiet: policies run with the querying role's rights, so anon, authenticated
--    and service_role get USAGE on private and EXECUTE on the helper, but /rest/v1/rpc cannot
--    reach it. Both helpers pin search_path.
-- 2. profiles SELECT is TO authenticated: own row, or every row for ADMIN and WRITER (the users
--    screen, author pickers, revision history, dashboard counts). anon reads nothing. The
--    UPDATE policy keeps "own row or ADMIN", and its WITH CHECK pins `role` to its current
--    value unless the caller is ADMIN.
-- 3. A BEFORE UPDATE trigger rejects a role change made by a request that carries a user
--    session (auth.uid() is set) unless that user is an ADMIN. It keys off the session, not
--    the SQL role, so a future SECURITY DEFINER helper called from a USER session cannot
--    slip past it. service_role and postgres carry no session: the users screen, /setup, the
--    MCP route, the sandbox reset and migrations all write through them.
-- 4. The three revision tables read for ADMIN and WRITER only. Their writers were already
--    staff-only; no USER-role or anonymous code path reads them.
-- 5. The public site still shows who wrote an approved review, comment or staff reply.
--    ProductReviewsSection, PostCommentsSection and StaffReplies embed the name and avatar
--    from the browser client, i.e. as anon, so that read moves off profiles onto author(): a
--    PostgREST computed relationship on cms_interactions (`select=*,author(full_name,avatar_url)`)
--    that returns id, full_name and avatar_url, and only for an interaction that is approved.
--    Its row type is the profile_cards view, which is security_invoker: querying the view
--    directly yields exactly what profiles allows the caller, nothing more.
-- 6. user_security_settings loses its owner INSERT/UPDATE policies. evaluateTwoFactor()
--    trusts mfa_enabled / mfa_type to decide whether /cms asks for a second factor, and the
--    owner could rewrite both over REST with a first-factor-only session. The security
--    actions verify the code or TOTP first and write through the service role.
-- 7. Scheduled content stays private until its time. posts already checked published_at;
--    pages and products now do too, and products no longer list draft or archived rows (nor
--    their variants) to anyone but staff. The app already filtered these itself; the Data API
--    did not.
-- 8. generate_order_invoice_number() and assign_order_invoice_metadata() become service-role
--    only (any visitor, or any account, could burn a number from order_invoice_number_seq per
--    call; every real caller already goes through the service role), and anon loses EXECUTE
--    on upsert_product_with_variants(), whose is_admin() guard is NULL without a session and
--    relies on RLS. /setup's post-apply grant pass (lib/setup/schema-apply.ts) re-applies
--    these revokes after its blanket grants.
-- 9. TRUNCATE is revoked from anon and authenticated on every table: row-level security does
--    not govern it, and no API role has a reason to hold it.
-- 10. site_settings reads become an allow-list. The baseline denied seven secret keys and
--    published everything else to the public key: staff notification addresses, the business
--    invoice identity, SMTP host and sender, the 2FA posture, onboarding state, payment
--    public config. Now anon reads the keys the public site renders or routes on
--    (`is_admin_created` drives the /setup redirect in proxy.ts, `enabled_payment_providers`
--    every Buy button); a signed-in customer additionally reads `invoice_settings` for their
--    own invoices; ADMIN and WRITER read the keys the CMS shell loads; ADMIN reads
--    everything, so a key a future feature adds is ADMIN-only until this policy lists it.
--    Writes are unchanged.
--
-- Idempotent, and safe on a database that recorded the baseline without running it (docs/04 →
-- "How a squash crosses live databases"): every SELECT policy on profiles is dropped by name
-- from pg_policies before the replacement is created, so a generation-1 policy under another
-- name cannot keep the table open.

-- ---------------------------------------------------------------------------
-- 1. Role helpers: owner-privileged lookup in a non-exposed schema, invoker wrappers in public
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
-- Policies evaluate with the querying role's rights, and policies without a TO clause run
-- for anon too, so every API role can call the helper from inside a policy.
GRANT USAGE ON SCHEMA private TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.current_user_role() RETURNS public.user_role
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid();
$$;

REVOKE ALL ON FUNCTION private.current_user_role() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.current_user_role() TO anon, authenticated, service_role;

-- Same names, same signatures, same NULL-without-a-session semantics as the baseline.
CREATE OR REPLACE FUNCTION public.get_current_user_role() RETURNS public.user_role
    LANGUAGE sql STABLE SECURITY INVOKER
    SET search_path TO 'public'
    AS $$
  SELECT private.current_user_role();
$$;

CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY INVOKER
    SET search_path TO 'public'
    AS $$
  SELECT private.current_user_role() = 'ADMIN'::public.user_role;
$$;

REVOKE ALL ON FUNCTION public.get_current_user_role() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_current_user_role() TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. profiles: own row or staff reads, no anon, role pinned for non-admins
-- ---------------------------------------------------------------------------
DO $$
DECLARE p record;
BEGIN
  FOR p IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'profiles' AND cmd = 'SELECT'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.profiles', p.policyname);
  END LOOP;
END $$;

CREATE POLICY profiles_read_policy ON public.profiles
  FOR SELECT TO authenticated
  USING (
    id = (SELECT auth.uid())
    OR (SELECT public.get_current_user_role()) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])
  );

DROP POLICY IF EXISTS profiles_update_policy ON public.profiles;
CREATE POLICY profiles_update_policy ON public.profiles
  FOR UPDATE TO authenticated
  USING (
    id = (SELECT auth.uid())
    OR (SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role
  )
  WITH CHECK (
    (SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role
    OR (id = (SELECT auth.uid()) AND role = (SELECT public.get_current_user_role()))
  );

-- ---------------------------------------------------------------------------
-- 3. role changes from a user session are admin-only (backstop for the policy above)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.protect_profile_role() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role
     AND auth.uid() IS NOT NULL
     AND (SELECT public.get_current_user_role()) IS DISTINCT FROM 'ADMIN'::public.user_role
  THEN
    RAISE EXCEPTION 'Only an administrator can change a user''s role'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- Trigger functions are never called by API roles (02013).
REVOKE ALL ON FUNCTION public.protect_profile_role() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.protect_profile_role() TO service_role;

DROP TRIGGER IF EXISTS protect_profile_role ON public.profiles;
CREATE TRIGGER protect_profile_role
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  WHEN (OLD.role IS DISTINCT FROM NEW.role)
  EXECUTE FUNCTION public.protect_profile_role();

-- ---------------------------------------------------------------------------
-- 4. Revision tables: staff read only
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS page_revisions_read_policy ON public.page_revisions;
CREATE POLICY page_revisions_read_policy ON public.page_revisions
  FOR SELECT TO authenticated
  USING (
    (SELECT public.get_current_user_role()) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])
  );

DROP POLICY IF EXISTS post_revisions_read_policy ON public.post_revisions;
CREATE POLICY post_revisions_read_policy ON public.post_revisions
  FOR SELECT TO authenticated
  USING (
    (SELECT public.get_current_user_role()) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])
  );

DROP POLICY IF EXISTS product_revisions_read_policy ON public.product_revisions;
CREATE POLICY product_revisions_read_policy ON public.product_revisions
  FOR SELECT TO authenticated
  USING (
    (SELECT public.get_current_user_role()) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])
  );

-- ---------------------------------------------------------------------------
-- 5. Public author card: cms_interactions?select=*,author(full_name,avatar_url)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.profile_cards
  WITH (security_invoker = true) AS
  SELECT id, full_name, avatar_url FROM public.profiles;

GRANT SELECT ON public.profile_cards TO anon, authenticated, service_role;

-- One card per interaction row the caller can already see. The EXISTS re-reads the row so a
-- hand-built argument cannot turn the function into a name lookup for arbitrary ids. The
-- owner-privileged read lives in private (advisor lints 0028/0029, as in section 1); the
-- public function is the invoker wrapper PostgREST embeds as a computed relationship.
CREATE OR REPLACE FUNCTION private.author_card(p_interaction_id uuid, p_user_id uuid)
    RETURNS SETOF public.profile_cards ROWS 1
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT p.id, p.full_name, p.avatar_url
  FROM public.profiles p
  WHERE p.id = p_user_id
    AND EXISTS (
      SELECT 1 FROM public.cms_interactions ci
      WHERE ci.id = p_interaction_id
        AND ci.user_id = p_user_id
        AND ci.status = 'approved'::public.approval_status
    );
$$;

REVOKE ALL ON FUNCTION private.author_card(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.author_card(uuid, uuid) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.author(public.cms_interactions)
    RETURNS SETOF public.profile_cards ROWS 1
    LANGUAGE sql STABLE SECURITY INVOKER
    SET search_path TO 'public'
    AS $$
  SELECT * FROM private.author_card($1.id, $1.user_id);
$$;

REVOKE ALL ON FUNCTION public.author(public.cms_interactions) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.author(public.cms_interactions) TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. user_security_settings: written by the server only, read by its owner
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS user_security_settings_insert_own_policy ON public.user_security_settings;
DROP POLICY IF EXISTS user_security_settings_update_own_policy ON public.user_security_settings;

-- ---------------------------------------------------------------------------
-- 7. Scheduled, draft and archived content is staff-only until it is live
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS pages_anon_read_policy ON public.pages;
CREATE POLICY pages_anon_read_policy ON public.pages
  FOR SELECT TO anon
  USING (
    status = 'published'::public.page_status
    AND (published_at IS NULL OR published_at <= now())
  );

DROP POLICY IF EXISTS pages_read_policy ON public.pages;
CREATE POLICY pages_read_policy ON public.pages
  FOR SELECT TO authenticated
  USING (
    (status = 'published'::public.page_status AND (published_at IS NULL OR published_at <= now()))
    OR (author_id = (SELECT auth.uid()) AND status <> 'published'::public.page_status)
    OR (SELECT public.get_current_user_role()) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])
  );

DROP POLICY IF EXISTS "Public can view products" ON public.products;
CREATE POLICY "Public can view products" ON public.products
  FOR SELECT TO anon, authenticated
  USING (
    (status = 'active' AND (published_at IS NULL OR published_at <= now()))
    OR (SELECT public.get_current_user_role()) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])
  );

DROP POLICY IF EXISTS "Public read product_variants" ON public.product_variants;
CREATE POLICY "Public read product_variants" ON public.product_variants
  FOR SELECT TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.products p
      WHERE p.id = product_variants.product_id
        AND p.status = 'active'
        AND (p.published_at IS NULL OR p.published_at <= now())
    )
    OR (SELECT public.get_current_user_role()) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])
  );

-- ---------------------------------------------------------------------------
-- 8. Invoice numbering and the product upsert are not public RPCs
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.generate_order_invoice_number() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.assign_order_invoice_metadata(uuid, timestamp with time zone) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.order_invoice_number_seq FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.upsert_product_with_variants(jsonb) FROM PUBLIC, anon;

-- ---------------------------------------------------------------------------
-- 9. API roles never truncate
-- ---------------------------------------------------------------------------
REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 10. site_settings: read tiers instead of a deny-list
-- ---------------------------------------------------------------------------
-- Every SELECT policy goes, by name, so a generation-1 policy under another name cannot keep
-- the table open (same reasoning as profiles above).
DO $$
DECLARE p record;
BEGIN
  FOR p IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'site_settings' AND cmd = 'SELECT'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.site_settings', p.policyname);
  END LOOP;
END $$;

-- Keys the public site renders or routes on. Each one has an anonymous reader:
-- app/lib/site-settings.ts, app/layout.tsx, proxy.ts (language detection, is_admin_created),
-- app/robots.txt, app/llms.txt, components/BlockRenderer.tsx (bot protection), the logo
-- loader, libs/ecommerce payments/queries.ts and tax-calculation.ts, and the history-repair
-- tool's anon fallback for migration_baseline_generation.
CREATE POLICY site_settings_anon_read_policy ON public.site_settings
  FOR SELECT TO anon
  USING (
    key = ANY (ARRAY[
      'site_title', 'site_description', 'site_keywords', 'site_social_image',
      'footer_copyright', 'footer_show_attribution', 'global_css',
      'language_detection_settings', 'seo_robots_settings', 'bot_protection_public',
      'active_logo_id', 'is_admin_created', 'privacy_settings',
      'enabled_payment_providers', 'ecommerce_inventory_settings',
      'migration_baseline_generation'
    ])
  );

CREATE POLICY site_settings_read_policy ON public.site_settings
  FOR SELECT TO authenticated
  USING (
    key = ANY (ARRAY[
      'site_title', 'site_description', 'site_keywords', 'site_social_image',
      'footer_copyright', 'footer_show_attribution', 'global_css',
      'language_detection_settings', 'seo_robots_settings', 'bot_protection_public',
      'active_logo_id', 'is_admin_created', 'privacy_settings',
      'enabled_payment_providers', 'ecommerce_inventory_settings',
      'migration_baseline_generation',
      -- a customer's own invoice carries the seller block (libs/ecommerce invoice-server.ts)
      'invoice_settings'
    ])
    OR (
      -- loaded by the CMS shell and dashboard for every staff role
      key = ANY (ARRAY['security_settings', 'onboarding_state', 'email_public', 'cortex_ai_site_brief'])
      AND (SELECT public.get_current_user_role()) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])
    )
    OR (SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role
  );
