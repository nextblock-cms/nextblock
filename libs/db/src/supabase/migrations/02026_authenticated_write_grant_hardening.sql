-- 02026: authenticated holds no table write privilege that no RLS policy lets it use
-- (2026-10-21, the follow-up 02025 left open).
--
-- 02025 made anon read-only at the grant level. authenticated still held SELECT, INSERT,
-- UPDATE, DELETE, REFERENCES and TRIGGER on every table in `public` (the baseline 02003, then
-- `grant all on all tables in schema public to authenticated` in the post-apply pass on every
-- deploy). On the tables below RLS was the only barrier between a signed-in session and a
-- write: no permissive policy for authenticated or PUBLIC covers the listed commands, only a
-- `TO service_role` policy or none at all. Every app write to them runs server-side with the
-- service role after its own checks: 2FA challenges, trusted devices and security settings
-- (lib/auth, settings/security), consent logs, contact-seller enquiries and message threads,
-- UCP carts, coupon redemptions (checkout providers), license activations (lib/packages),
-- the Freemius catalog sync, the update checker's alerts and Cortex's mutation audit.
--
-- Behaviour-neutral by construction: authenticated could never use a revoked privilege. Its
-- INSERT failed the RLS check and its UPDATE or DELETE matched no row; now the grant refuses
-- the statement before RLS is consulted, and no row any request reaches changes. (One CMS
-- action, updateFreemiusOverride in libs/ecommerce, updates freemius_pricing through the
-- cookie client: RLS has always discarded that UPDATE while the action reported success, and
-- it now reports the permission error instead.) Every command that has a policy keeps its
-- grant: the ADMIN UPDATE on message_threads, product_inquiries and system_alerts, the ADMIN
-- INSERT on site_script_revisions, the owner DELETE on user_trusted_devices, and every SELECT.
-- The pre-flight block re-checks that against pg_policies on the target database and aborts
-- without changing anything if a policy has appeared since this list was taken (a replay
-- through 02025 plus the post-apply pass, 2026-10-21).
--
-- REFERENCES and TRIGGER go from every table, as 02025 did for anon: they only let a role
-- create a foreign key or a trigger, and no API request runs DDL. Foreign-key actions are not
-- affected by any of this: ON DELETE CASCADE / SET NULL run as the owner of the referencing
-- table, so an ADMIN deleting a product still removes its freemius_plans and freemius_pricing
-- rows, and deleting an order still removes its coupon_redemptions.
--
-- Both apply paths repeat these revokes after their blanket grants (API_ROLE_REVOKE_SQL). To
-- give authenticated one of these privileges later, add the policy and the GRANT in the same
-- migration and take the table out of both copies of that list, or the next deploy revokes it
-- again. tools/scripts/security-verify.sql sections 26-27 fail on a write grant no policy uses
-- and on a write policy whose grant is missing. Idempotent: safe to re-run.

DO $nb_preflight$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(format('%s %s (policy %s)', l.tbl, r.cmd, p.policyname), ', ' ORDER BY l.tbl, r.cmd, p.policyname)
    INTO offenders
    FROM (VALUES
      ('cortex_ai_db_mutation_audit', ARRAY['INSERT', 'UPDATE', 'DELETE']),
      ('coupon_redemptions',          ARRAY['INSERT', 'UPDATE', 'DELETE']),
      ('email_2fa_challenges',        ARRAY['INSERT', 'UPDATE', 'DELETE']),
      ('freemius_plans',              ARRAY['INSERT', 'UPDATE', 'DELETE']),
      ('freemius_pricing',            ARRAY['INSERT', 'UPDATE', 'DELETE']),
      ('package_activations',         ARRAY['INSERT', 'UPDATE', 'DELETE']),
      ('privacy_consent_logs',        ARRAY['INSERT', 'UPDATE', 'DELETE']),
      ('thread_messages',             ARRAY['INSERT', 'UPDATE', 'DELETE']),
      ('ucp_cart_sessions',           ARRAY['INSERT', 'UPDATE', 'DELETE']),
      ('user_security_settings',      ARRAY['INSERT', 'UPDATE', 'DELETE']),
      ('message_threads',             ARRAY['INSERT', 'DELETE']),
      ('product_inquiries',           ARRAY['INSERT', 'DELETE']),
      ('system_alerts',               ARRAY['INSERT', 'DELETE']),
      ('site_script_revisions',       ARRAY['UPDATE', 'DELETE']),
      ('user_trusted_devices',        ARRAY['INSERT', 'UPDATE'])
    ) AS l(tbl, cmds)
    CROSS JOIN LATERAL unnest(l.cmds) AS r(cmd)
    JOIN pg_policies p
      ON p.schemaname = 'public' AND p.tablename = l.tbl
     AND p.permissive = 'PERMISSIVE' AND p.cmd IN (r.cmd, 'ALL')
     AND p.roles && ARRAY['authenticated', 'public']::name[];
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION '02026 would revoke a privilege that an RLS policy lets authenticated use: %. Nothing was changed; drop that table/command from this file and from API_ROLE_REVOKE_SQL, or drop the policy.', offenders;
  END IF;
END
$nb_preflight$;

-- 1. writes that no policy lets authenticated use
REVOKE INSERT, UPDATE, DELETE ON TABLE
  public.cortex_ai_db_mutation_audit,
  public.coupon_redemptions,
  public.email_2fa_challenges,
  public.freemius_plans,
  public.freemius_pricing,
  public.package_activations,
  public.privacy_consent_logs,
  public.thread_messages,
  public.ucp_cart_sessions,
  public.user_security_settings
  FROM authenticated;
REVOKE INSERT, DELETE ON TABLE public.message_threads, public.product_inquiries, public.system_alerts FROM authenticated;
REVOKE UPDATE, DELETE ON TABLE public.site_script_revisions FROM authenticated;
REVOKE INSERT, UPDATE ON TABLE public.user_trusted_devices FROM authenticated;

-- 2. REFERENCES / TRIGGER: DDL-only, unused by every API request
REVOKE REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM authenticated;
