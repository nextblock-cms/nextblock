-- 02027: anon and authenticated hold SELECT only where an RLS policy lets them read
-- (2026-10-21, the read side of 02025/02026).
--
-- 02025 made anon read-only and 02026 left authenticated only the writes some policy uses.
-- SELECT was still granted to both roles on every table in `public` (the baseline 02003, then
-- `grant select on all tables in schema public to anon` and `grant all ... to authenticated` in
-- the post-apply pass on every deploy). On the tables below no permissive SELECT or ALL policy
-- reaches the role (or PUBLIC), so RLS was the only barrier between the public key and orders,
-- profiles, coupons, licenses, MCP tokens, revisions, drafts, 2FA challenges, carts and
-- messages: one permissive policy added by mistake, or a table created with RLS off, would
-- have published it to anyone holding that key.
--
--   anon: every table that only staff, an owner or the service role reads (29, listed below).
--   authenticated: email_2fa_challenges and ucp_cart_sessions, whose only policy is TO
--     service_role (lib/auth/twoFactor and the UCP routes read them with the service role;
--     02026 already took authenticated's writes on both).
--   profile_cards (02021): anon loses SELECT, authenticated loses INSERT/UPDATE/DELETE. It is a
--     security_invoker view over profiles, so anon could only ever read it through a SELECT on
--     profiles, which goes here. The public author card does not read the view: author()
--     returns its row type from private.author_card(), a SECURITY DEFINER function, so
--     `cms_interactions?select=*,author(full_name,avatar_url)` keeps working for anon (checked
--     through PostgREST on 2026-10-21). The view is a read card; nothing writes through it.
--
-- Unlike a write, a SELECT can be needed on a table the request never names: a policy
-- subquery (`EXISTS (SELECT ... FROM x)`), a security_invoker view, an invoker function or a
-- PostgREST embed (`select=*,x(...)`) all read x as the calling role, and they fail with 42501
-- once the grant is gone, where RLS used to return no row (or a null embed). The census behind
-- this list (a replay through 02026 plus the post-apply pass, 2026-10-21) found:
--   - one policy that reads another of these tables, order_items' owner policy (orders): it is
--     TO authenticated, which keeps SELECT on orders;
--   - one view, profile_cards (above);
--   - invoker functions reading them: apply_order_inventory_deduction (orders, order_items),
--     called by the app only with the service role and already refused to anon by its
--     SELECT ... FOR UPDATE since 02025 (FOR UPDATE needs UPDATE), and the trigger functions of
--     site_script_revisions / thread_messages, which fire only on writes anon cannot make;
--   - no anonymous query in the app (getSsgSupabaseClient, the browser client, the cookie client
--     on signed-out paths) embeds a listed table; the public author card goes through author().
--     The anonymous paths that need one of these tables (checkout success, order access tokens,
--     contact seller, threads, consent, forms, UCP, MCP tokens, the sign-up read of
--     system_configuration) read it with the service role after their own checks. The few
--     cookie-client reads a signed-out request can reach (a draft lookup in draft mode or with
--     NEXTBLOCK_VISUAL_EDITING_ENABLED, verifyPackageOnline on an install with no service key,
--     the MCP route's revision capture, a custom block's `profiles` relation) already got no
--     row and handle the error the same way: no draft, not licensed, no revision, no record.
-- Behaviour-neutral for every request that worked: an anon or authenticated read of a listed
-- table returned no row before and is refused by the grant now. The pre-flight block re-checks
-- the catalog side on the target database and aborts without changing anything if a policy
-- lets the role read a listed table, if a policy the role is subject to reads one, or if a view
-- the role can read depends on one.
--
-- Both apply paths repeat these revokes after their blanket grants (API_ROLE_REVOKE_SQL). To let
-- one of these roles read a listed table later, add the policy and GRANT SELECT in the same
-- migration and take the table out of both copies of that list, or the next deploy revokes it
-- again. tools/scripts/security-verify.sql sections 28-29 fail on a SELECT grant no policy uses
-- and on a read policy whose grant is missing. Idempotent: safe to re-run.

DO $nb_preflight$
DECLARE
  offenders text;
BEGIN
  WITH l(role, tbl) AS (
    SELECT 'anon'::name, t
      FROM unnest(ARRAY[
        'content_drafts', 'cortex_ai_db_mutation_audit', 'coupon_freemius_mappings',
        'coupon_products', 'coupon_redemptions', 'coupons', 'email_2fa_challenges',
        'form_endpoints', 'mcp_access_tokens', 'message_threads', 'order_items', 'orders',
        'package_activations', 'page_revisions', 'post_revisions', 'privacy_consent_logs',
        'product_drafts', 'product_freemius_sale_coupons', 'product_inquiries',
        'product_revisions', 'profile_cards', 'profiles', 'site_script_revisions',
        'system_alerts', 'system_configuration', 'thread_messages', 'ucp_cart_sessions',
        'user_addresses', 'user_security_settings', 'user_trusted_devices']::name[]) AS t
    UNION ALL
    SELECT 'authenticated'::name, t
      FROM unnest(ARRAY['email_2fa_challenges', 'ucp_cart_sessions']::name[]) AS t
  ), r AS (
    SELECT l.role, l.tbl, to_regclass('public.' || quote_ident(l.tbl)) AS oid FROM l
  ), hits(what) AS (
    -- a policy that lets the role read a listed table
    SELECT format('%s reads %s through policy %s', r.role, r.tbl, p.policyname)
      FROM r
      JOIN pg_policies p
        ON p.schemaname = 'public' AND p.tablename = r.tbl
       AND p.permissive = 'PERMISSIVE' AND p.cmd IN ('SELECT', 'ALL')
       AND p.roles && ARRAY[r.role, 'public']::name[]
    UNION ALL
    -- a policy the role is subject to, on any other table, whose expression reads a listed table
    SELECT format('policy %s on %s reads %s as %s', pol.polname, pol.polrelid::regclass, r.tbl, r.role)
      FROM r
      JOIN pg_depend d
        ON d.classid = 'pg_policy'::regclass AND d.refclassid = 'pg_class'::regclass AND d.refobjid = r.oid
      JOIN pg_policy pol ON pol.oid = d.objid
     WHERE pol.polrelid <> r.oid
       AND (0::oid = ANY (pol.polroles) OR (SELECT oid FROM pg_roles WHERE rolname = r.role) = ANY (pol.polroles))
    UNION ALL
    -- a view the role keeps SELECT on that reads a listed table
    SELECT format('view %s reads %s and stays readable by %s', rw.ev_class::regclass, r.tbl, r.role)
      FROM r
      JOIN pg_depend d
        ON d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass AND d.refobjid = r.oid
      JOIN pg_rewrite rw ON rw.oid = d.objid
     WHERE rw.ev_class <> r.oid
       AND has_table_privilege(r.role, rw.ev_class, 'SELECT')
       AND NOT EXISTS (SELECT 1 FROM r r2 WHERE r2.role = r.role AND r2.oid = rw.ev_class)
  )
  SELECT string_agg(DISTINCT what, '; ') INTO offenders FROM hits;
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION '02027 would revoke a SELECT that a request still needs: %. Nothing was changed; drop that table from this file and from API_ROLE_REVOKE_SQL, or change the policy or view.', offenders;
  END IF;
END
$nb_preflight$;

-- 1. anon: SELECT on every table no policy lets anon read
REVOKE SELECT ON TABLE
  public.content_drafts,
  public.cortex_ai_db_mutation_audit,
  public.coupon_freemius_mappings,
  public.coupon_products,
  public.coupon_redemptions,
  public.coupons,
  public.email_2fa_challenges,
  public.form_endpoints,
  public.mcp_access_tokens,
  public.message_threads,
  public.order_items,
  public.orders,
  public.package_activations,
  public.page_revisions,
  public.post_revisions,
  public.privacy_consent_logs,
  public.product_drafts,
  public.product_freemius_sale_coupons,
  public.product_inquiries,
  public.product_revisions,
  public.profiles,
  public.site_script_revisions,
  public.system_alerts,
  public.system_configuration,
  public.thread_messages,
  public.ucp_cart_sessions,
  public.user_addresses,
  public.user_security_settings,
  public.user_trusted_devices
  FROM anon;

-- 2. authenticated: the two tables only the service role reads
REVOKE SELECT ON TABLE public.email_2fa_challenges, public.ucp_cart_sessions FROM authenticated;

-- 3. profile_cards: a read card for staff and owners (through profiles' policies)
REVOKE SELECT ON TABLE public.profile_cards FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.profile_cards FROM authenticated;
