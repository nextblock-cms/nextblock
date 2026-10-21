-- NextBlock DB security posture check (2026-10-19 red-team; migrations 02022, 02023, 02025-02028).
--
-- Self-contained before/after harness for the RLS / trigger fixes in
-- 02022_security_hardening_writer_boundary_and_aal.sql (sections 1-12), the aal2 widening
-- in 02023_aal2_for_orders_profiles_site_settings.sql (sections 13-17), catalog-level
-- posture plus the grant hardening of 02025_api_role_grant_hardening.sql (sections 18-25:
-- RLS on every table, SECURITY DEFINER functions in public, USING (true) policies on sensitive
-- tables, anon write grants, cortex_request_log grants, profiles.role column grants), and the
-- authenticated write grants of 02026_authenticated_write_grant_hardening.sql (sections 26-27:
-- no write grant that no policy uses, no write policy without its grant, behaviour), and the
-- read grants of 02027_api_role_select_grant_hardening.sql (sections 28-29: no SELECT that no
-- policy uses, no read policy without its grant, views, behaviour of the public site's reads), and
-- the 2026-10-21 audit fixes of 02028_writer_settings_allowlist_email_factor_aal_and_media_keys.sql
-- (sections 30-34: the WRITER allow-list on site_settings, the email second factor in RLS, the
-- aal2 floor on scripts/redirects/system_configuration/messages, media uploader and storage-key
-- pins, package_activations license columns). It creates throwaway fixtures, emulates PostgREST exactly (SET LOCAL ROLE + request.jwt.claims;
-- SET LOCAL reverts at each DO block's exit), prints PASS/FAIL per assertion, and ROLLS BACK so
-- the database is left untouched.
--
--   Before 02022:  several checks print FAIL.
--   After  02022:  sections 1-12 print PASS; the "aal1 is blocked" lines of 13-16 print FAIL.
--   After  02023:  sections 1-17 print PASS on a database migrated with the CLI. A database
--                  that also went through the post-apply grant pass (every Vercel deploy,
--                  /setup) fails the three cortex_request_log lines of section 10: that pass
--                  re-granted the table until 02025.
--   After  02025:  sections 1-25 print PASS, with or without the post-apply pass; five lines of
--                  26-27 print FAIL (authenticated still holds writes no policy uses).
--   After  02026:  sections 1-27 print PASS; three lines of 28-29 print FAIL (anon still holds
--                  SELECT on 29 tables no policy lets it read, authenticated on two).
--   After  02027:  sections 1-29 print PASS; the hole checks of 30-34 print FAIL (their
--                  regression guards pass either way). Run the file with psql to see that:
--                  security:db-posture's post-apply pass already carries 02028's
--                  package_activations revoke, so section 34 passes there before 02028.
--   After  02028:  every check prints PASS (134), with or without the post-apply pass. Run it on
--                  a database that went through that pass (a deployed one, or a replay followed
--                  by GRANTS_SQL from apps/nextblock/tools/lib/migrate-core.mjs): that is where
--                  grant regressions show up.
--
-- Usage (local replay or any non-production DB — NEVER production):
--   PGPASSWORD=... psql -h <host> -p <port> -U postgres -d postgres -f tools/scripts/security-verify.sql
--
-- Effectively read-only (one transaction, always rolled back). Needs the auth schema (GoTrue)
-- present for the auth.users / auth.mfa_factors inserts. The emulated roles require the running
-- role to be a member of anon/authenticated (the Supabase `postgres` role is).

\set ON_ERROR_STOP on
\pset pager off
SET client_min_messages TO notice;

BEGIN;

-- ---- fixtures (as the table owner) -------------------------------------------------------------
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
VALUES
  ('aa000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-000000000000','authenticated','authenticated','sv-admin@test.local','x',now(),now(),'{}','{"full_name":"SV Admin"}'),
  ('aa000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-000000000000','authenticated','authenticated','sv-writer@test.local','x',now(),now(),'{}','{"full_name":"SV Writer"}')
ON CONFLICT (id) DO NOTHING;
UPDATE public.profiles SET role='ADMIN'  WHERE id='aa000000-0000-0000-0000-0000000000a1';
UPDATE public.profiles SET role='WRITER' WHERE id='aa000000-0000-0000-0000-0000000000f1';
-- a draft product + its media/category/stock, and a live product's stock, to test anon scoping
INSERT INTO public.products (id, language_id, sku, title, slug, product_type, payment_provider, price, status, published_at)
VALUES
  ('aa000000-0000-0000-0000-00000000d001',1,'SV-DRAFT','SV draft','sv-draft','physical','stripe',1000,'draft',NULL),
  ('aa000000-0000-0000-0000-00000000d002',1,'SV-LIVE','SV live','sv-live','physical','stripe',1000,'active',NULL)
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.media (id, object_key, file_name, file_path, uploader_id)
VALUES ('aa000000-0000-0000-0000-00000000e001','sv/x.jpg','x.jpg','sv/x.jpg','aa000000-0000-0000-0000-0000000000a1') ON CONFLICT DO NOTHING;
INSERT INTO public.product_media (product_id, media_id, sort_order) VALUES ('aa000000-0000-0000-0000-00000000d001','aa000000-0000-0000-0000-00000000e001',0) ON CONFLICT DO NOTHING;
INSERT INTO public.inventory_items (sku, quantity) VALUES ('SV-DRAFT',99) ON CONFLICT (sku) DO UPDATE SET quantity=99;
INSERT INTO public.inventory_items (sku, quantity) VALUES ('SV-LIVE',99)  ON CONFLICT (sku) DO UPDATE SET quantity=99;
INSERT INTO public.package_activations (id, license_key, instance_name, package_id, status, meta, last_validated_at)
VALUES ('aa000000-0000-0000-0000-00000000c001','SV-KEY','sv','ecommerce','active','{}',now()) ON CONFLICT DO NOTHING;
-- media rows per uploader (02022 §9): e002 by the WRITER, e003/e004 by the ADMIN
INSERT INTO public.media (id, object_key, file_name, file_path, uploader_id)
VALUES
  ('aa000000-0000-0000-0000-00000000e002','sv/w.jpg','w.jpg','sv/w.jpg','aa000000-0000-0000-0000-0000000000f1'),
  ('aa000000-0000-0000-0000-00000000e003','sv/a3.jpg','a3.jpg','sv/a3.jpg','aa000000-0000-0000-0000-0000000000a1'),
  ('aa000000-0000-0000-0000-00000000e004','sv/a4.jpg','a4.jpg','sv/a4.jpg','aa000000-0000-0000-0000-0000000000a1')
ON CONFLICT DO NOTHING;
-- coupons for the atomic redemption function (02022 §8): limit 2, and an inactive one
INSERT INTO public.coupons (id, code, name, discount_type, discount_amount, is_active, redemption_limit, redemptions_count)
VALUES
  ('aa000000-0000-0000-0000-00000000c0a1','SVRACE','SV race','percent',10,true,2,0),
  ('aa000000-0000-0000-0000-00000000c0a2','SVOFF','SV inactive','percent',10,false,NULL,0)
ON CONFLICT (id) DO NOTHING;
-- a UCP cart holding buyer PII (02022 §7)
INSERT INTO public.ucp_cart_sessions (id, buyer_identity)
VALUES ('aa000000-0000-0000-0000-00000000ca01','{"email":"sv-buyer@test.local"}') ON CONFLICT (id) DO NOTHING;
-- 02023 fixtures: a second ADMIN who never enrols a factor (a2), a customer (cc01) with an
-- order, an order item and an address, and a secret-tier site_settings row. (a1 gets a
-- verified factor in check 5 and keeps it for the rest of the transaction.)
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
VALUES
  ('aa000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-000000000000','authenticated','authenticated','sv-admin2@test.local','x',now(),now(),'{}','{"full_name":"SV Admin 2"}'),
  ('aa000000-0000-0000-0000-00000000cc01','00000000-0000-0000-0000-000000000000','authenticated','authenticated','sv-customer@test.local','x',now(),now(),'{}','{"full_name":"SV Customer"}')
ON CONFLICT (id) DO NOTHING;
UPDATE public.profiles SET role='ADMIN' WHERE id='aa000000-0000-0000-0000-0000000000a2';
UPDATE public.profiles SET role='USER'  WHERE id='aa000000-0000-0000-0000-00000000cc01';
INSERT INTO public.orders (id, user_id, status, total, currency, provider)
VALUES ('aa000000-0000-0000-0000-00000000ad01','aa000000-0000-0000-0000-00000000cc01','paid',1000,'USD','stripe')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.order_items (id, order_id, product_id, quantity, price_at_purchase)
VALUES ('aa000000-0000-0000-0000-00000000ad11','aa000000-0000-0000-0000-00000000ad01','aa000000-0000-0000-0000-00000000d002',1,1000)
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.user_addresses (id, user_id, address_type, line1, city, country_code)
VALUES ('aa000000-0000-0000-0000-00000000ae01','aa000000-0000-0000-0000-00000000cc01','shipping','1 SV Street','Testville','CA')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.site_settings (key, value) VALUES ('email_secret','{"user":"sv"}'::jsonb) ON CONFLICT (key) DO NOTHING;

\echo ''
\echo '============ NextBlock security posture (02022 + 02023 + 02025-02027) ========'

-- 1. WRITER cannot write a sensitive site_settings key over the API
RESET ROLE;
DO $$
DECLARE denied boolean := true;
BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000f1","role":"authenticated"}',true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    UPDATE public.site_settings SET value=value WHERE key='is_admin_created';
    IF FOUND THEN denied := false; END IF;  -- a row updated = policy allowed it
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  RAISE NOTICE '%  WRITER cannot write site_settings.is_admin_created', CASE WHEN denied THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- 2. WRITER cannot INSERT a global_css <style> payload
RESET ROLE;
DO $$
DECLARE denied boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000f1","role":"authenticated"}',true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    INSERT INTO public.site_settings(key,value) VALUES ('global_css','"x</style><script>1</script>"'::jsonb);
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  RAISE NOTICE '%  WRITER cannot insert site_settings.global_css', CASE WHEN denied THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- 3. ADMIN (no MFA factor) CAN write a sensitive key
RESET ROLE;
DO $$
DECLARE allowed boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal1"}',true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  UPDATE public.site_settings SET value=value WHERE key='is_admin_created';
  allowed := FOUND;
  RAISE NOTICE '%  ADMIN (no factor) can write site_settings.is_admin_created', CASE WHEN allowed THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- 4. package_activations: WRITER reads nothing
RESET ROLE;
DO $$
DECLARE n integer;
BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000f1","role":"authenticated"}',true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO n FROM public.package_activations;
  RAISE NOTICE '%  WRITER cannot read package_activations (license keys)', CASE WHEN n=0 THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- 5. package_activations: ADMIN with a verified factor but an aal1 session is blocked; aal2 reads
RESET ROLE;
DO $$
DECLARE n_aal1 integer; n_aal2 integer;
BEGIN
  INSERT INTO auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
  VALUES (gen_random_uuid(),'aa000000-0000-0000-0000-0000000000a1','sv','totp','verified',now(),now(),'x') ON CONFLICT DO NOTHING;
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal1"}',true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO n_aal1 FROM public.package_activations;
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal2"}',true);
  SELECT count(*) INTO n_aal2 FROM public.package_activations;
  RAISE NOTICE '%  ADMIN with factor at aal1 is blocked from package_activations', CASE WHEN n_aal1=0 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN with factor at aal2 can read package_activations', CASE WHEN n_aal2>0 THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- 6. anon cannot see draft product media / category / stock; live stock stays visible
RESET ROLE;
DO $$
DECLARE n_media integer; n_draftstock integer; n_livestock integer;
BEGIN
  PERFORM set_config('request.jwt.claims','{"role":"anon"}',true);
  EXECUTE 'SET LOCAL ROLE anon';
  SELECT count(*) INTO n_media FROM public.product_media WHERE product_id='aa000000-0000-0000-0000-00000000d001';
  SELECT count(*) INTO n_draftstock FROM public.inventory_items WHERE sku='SV-DRAFT';
  SELECT count(*) INTO n_livestock FROM public.inventory_items WHERE sku='SV-LIVE';
  RAISE NOTICE '%  anon cannot see draft product media', CASE WHEN n_media=0 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  anon cannot see draft product stock', CASE WHEN n_draftstock=0 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  anon can still see live product stock', CASE WHEN n_livestock>0 THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- 7. handle_new_user one-shot: with an admin present, resetting the flag does not mint a 2nd admin
RESET ROLE;
DO $$
DECLARE new_role public.user_role; flag jsonb;
BEGIN
  UPDATE public.site_settings SET value='false'::jsonb WHERE key='is_admin_created';
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  VALUES ('aa000000-0000-0000-0000-00000000b001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','sv-escalate@test.local','x',now(),now(),'{}','{"full_name":"SV Esc"}');
  SELECT role INTO new_role FROM public.profiles WHERE id='aa000000-0000-0000-0000-00000000b001';
  SELECT value INTO flag FROM public.site_settings WHERE key='is_admin_created';
  RAISE NOTICE '%  new sign-up after is_admin_created reset is USER, not ADMIN', CASE WHEN new_role='USER'::public.user_role THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  is_admin_created self-heals to true', CASE WHEN flag='true'::jsonb THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- 8. redeem_coupon_atomically(): service_role stops exactly at the limit; API roles cannot EXECUTE
RESET ROLE;
DO $$
DECLARE r1 boolean; r2 boolean; r3 boolean; r_off boolean; r_missing boolean; n integer;
        denied_auth boolean := false; denied_anon boolean := false; exists_fn boolean;
BEGIN
  exists_fn := to_regprocedure('public.redeem_coupon_atomically(uuid)') IS NOT NULL;
  IF NOT exists_fn THEN
    RAISE NOTICE 'FAIL  redeem_coupon_atomically(uuid) exists';
    RETURN;
  END IF;
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  EXECUTE 'SET LOCAL ROLE service_role';
  SELECT public.redeem_coupon_atomically('aa000000-0000-0000-0000-00000000c0a1') INTO r1;
  SELECT public.redeem_coupon_atomically('aa000000-0000-0000-0000-00000000c0a1') INTO r2;
  SELECT public.redeem_coupon_atomically('aa000000-0000-0000-0000-00000000c0a1') INTO r3;
  SELECT public.redeem_coupon_atomically('aa000000-0000-0000-0000-00000000c0a2') INTO r_off;
  SELECT public.redeem_coupon_atomically('aa000000-0000-0000-0000-00000000c0ff') INTO r_missing;
  SELECT redemptions_count INTO n FROM public.coupons WHERE id='aa000000-0000-0000-0000-00000000c0a1';
  RAISE NOTICE '%  service_role redeems a limit-2 coupon exactly twice (true,true,false)', CASE WHEN r1 AND r2 AND r3 IS FALSE THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  redemptions_count stops at the limit (2)', CASE WHEN n=2 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  inactive / missing coupon returns false, never NULL', CASE WHEN r_off IS FALSE AND r_missing IS FALSE THEN 'PASS' ELSE 'FAIL' END;

  -- authenticated (ADMIN, the strongest API role) cannot execute it
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal2"}',true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    PERFORM public.redeem_coupon_atomically('aa000000-0000-0000-0000-00000000c0a2');
  EXCEPTION WHEN insufficient_privilege THEN denied_auth := true;
  END;
  PERFORM set_config('request.jwt.claims','{"role":"anon"}',true);
  EXECUTE 'SET LOCAL ROLE anon';
  BEGIN
    PERFORM public.redeem_coupon_atomically('aa000000-0000-0000-0000-00000000c0a2');
  EXCEPTION WHEN insufficient_privilege THEN denied_anon := true;
  END;
  RAISE NOTICE '%  authenticated cannot EXECUTE redeem_coupon_atomically', CASE WHEN denied_auth THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  anon cannot EXECUTE redeem_coupon_atomically', CASE WHEN denied_anon THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- 9. media ownership: WRITER touches only their own uploads; ADMIN keeps every row
RESET ROLE;
DO $$
DECLARE upd_other boolean; del_other boolean; del_own boolean; del_admin boolean; upd_own boolean;
        reassign_denied boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000f1","role":"authenticated"}',true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  UPDATE public.media SET description='sv' WHERE id='aa000000-0000-0000-0000-00000000e003';
  upd_other := FOUND;
  DELETE FROM public.media WHERE id='aa000000-0000-0000-0000-00000000e003';
  del_other := FOUND;
  UPDATE public.media SET description='mine' WHERE id='aa000000-0000-0000-0000-00000000e002';
  upd_own := FOUND;
  BEGIN
    UPDATE public.media SET uploader_id='aa000000-0000-0000-0000-0000000000a1' WHERE id='aa000000-0000-0000-0000-00000000e002';
  EXCEPTION WHEN insufficient_privilege THEN reassign_denied := true;
  END;
  DELETE FROM public.media WHERE id='aa000000-0000-0000-0000-00000000e002';
  del_own := FOUND;
  RAISE NOTICE '%  WRITER cannot update another uploader''s media row', CASE WHEN NOT upd_other THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  WRITER cannot delete another uploader''s media row', CASE WHEN NOT del_other THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  WRITER cannot re-assign uploader_id on their own row', CASE WHEN reassign_denied THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  WRITER can update their own media row', CASE WHEN upd_own THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  WRITER can delete their own media row', CASE WHEN del_own THEN 'PASS' ELSE 'FAIL' END;

  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal2"}',true);
  DELETE FROM public.media WHERE id='aa000000-0000-0000-0000-00000000e004';
  del_admin := FOUND;
  RAISE NOTICE '%  ADMIN can delete any media row', CASE WHEN del_admin THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- 10. cortex_request_log: service_role only (no grant and no policy for the API roles)
RESET ROLE;
DO $$
DECLARE n integer; sel_denied boolean := false; ins_denied boolean := false; anon_denied boolean := false;
BEGIN
  IF to_regclass('public.cortex_request_log') IS NULL THEN
    RAISE NOTICE 'FAIL  cortex_request_log exists';
    RETURN;
  END IF;
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  EXECUTE 'SET LOCAL ROLE service_role';
  INSERT INTO public.cortex_request_log (user_id, route) VALUES ('aa000000-0000-0000-0000-0000000000f1','generate-blocks');
  SELECT count(*) INTO n FROM public.cortex_request_log WHERE user_id='aa000000-0000-0000-0000-0000000000f1';
  RAISE NOTICE '%  service_role can insert and count cortex_request_log rows', CASE WHEN n>=1 THEN 'PASS' ELSE 'FAIL' END;

  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000f1","role":"authenticated"}',true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    SELECT count(*) INTO n FROM public.cortex_request_log;
  EXCEPTION WHEN insufficient_privilege THEN sel_denied := true;
  END;
  BEGIN
    DELETE FROM public.cortex_request_log WHERE user_id='aa000000-0000-0000-0000-0000000000f1';
  EXCEPTION WHEN insufficient_privilege THEN ins_denied := true;
  END;
  PERFORM set_config('request.jwt.claims','{"role":"anon"}',true);
  EXECUTE 'SET LOCAL ROLE anon';
  BEGIN
    SELECT count(*) INTO n FROM public.cortex_request_log;
  EXCEPTION WHEN insufficient_privilege THEN anon_denied := true;
  END;
  RAISE NOTICE '%  WRITER cannot read cortex_request_log', CASE WHEN sel_denied THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  WRITER cannot purge their own cortex_request_log rows', CASE WHEN ins_denied THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  anon cannot read cortex_request_log', CASE WHEN anon_denied THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- 11. ucp_cart_sessions: capability-token column present; API roles still see no cart row
RESET ROLE;
DO $$
DECLARE has_col boolean; n_auth integer := -1; n_anon integer := -1;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='ucp_cart_sessions' AND column_name='access_token_hash'
  ) INTO has_col;
  RAISE NOTICE '%  ucp_cart_sessions.access_token_hash exists', CASE WHEN has_col THEN 'PASS' ELSE 'FAIL' END;
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000f1","role":"authenticated"}',true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    SELECT count(*) INTO n_auth FROM public.ucp_cart_sessions WHERE id='aa000000-0000-0000-0000-00000000ca01';
  EXCEPTION WHEN insufficient_privilege THEN n_auth := 0;
  END;
  PERFORM set_config('request.jwt.claims','{"role":"anon"}',true);
  EXECUTE 'SET LOCAL ROLE anon';
  BEGIN
    SELECT count(*) INTO n_anon FROM public.ucp_cart_sessions WHERE id='aa000000-0000-0000-0000-00000000ca01';
  EXCEPTION WHEN insufficient_privilege THEN n_anon := 0;
  END;
  RAISE NOTICE '%  authenticated cannot read a UCP cart by id', CASE WHEN n_auth=0 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  anon cannot read a UCP cart by id', CASE WHEN n_anon=0 THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- 12. coupons: factor-enrolled ADMIN at aal1 blocked, aal2 allowed; WRITER never
RESET ROLE;
DO $$
DECLARE n_aal1 integer; n_aal2 integer; n_writer integer;
BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal1"}',true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO n_aal1 FROM public.coupons WHERE code LIKE 'SV%';
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal2"}',true);
  SELECT count(*) INTO n_aal2 FROM public.coupons WHERE code LIKE 'SV%';
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000f1","role":"authenticated"}',true);
  SELECT count(*) INTO n_writer FROM public.coupons WHERE code LIKE 'SV%';
  RAISE NOTICE '%  ADMIN with factor at aal1 is blocked from coupons', CASE WHEN n_aal1=0 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN with factor at aal2 can read coupons', CASE WHEN n_aal2>0 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  WRITER cannot read coupons', CASE WHEN n_writer=0 THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- 13. orders (02023): factor-enrolled ADMIN needs aal2; no-factor ADMIN, owner and WRITER unchanged
RESET ROLE;
DO $$
DECLARE n_aal1 integer; n_aal2 integer; n_nofactor integer; n_owner integer; n_writer integer;
        upd_aal1 boolean; upd_aal2 boolean;
BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal1"}',true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO n_aal1 FROM public.orders WHERE id='aa000000-0000-0000-0000-00000000ad01';
  UPDATE public.orders SET status=status WHERE id='aa000000-0000-0000-0000-00000000ad01';
  upd_aal1 := FOUND;
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal2"}',true);
  SELECT count(*) INTO n_aal2 FROM public.orders WHERE id='aa000000-0000-0000-0000-00000000ad01';
  UPDATE public.orders SET status=status WHERE id='aa000000-0000-0000-0000-00000000ad01';
  upd_aal2 := FOUND;
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000a2","role":"authenticated","aal":"aal1"}',true);
  SELECT count(*) INTO n_nofactor FROM public.orders WHERE id='aa000000-0000-0000-0000-00000000ad01';
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-00000000cc01","role":"authenticated","aal":"aal1"}',true);
  SELECT count(*) INTO n_owner FROM public.orders WHERE id='aa000000-0000-0000-0000-00000000ad01';
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000f1","role":"authenticated"}',true);
  SELECT count(*) INTO n_writer FROM public.orders WHERE id='aa000000-0000-0000-0000-00000000ad01';
  RAISE NOTICE '%  ADMIN with factor at aal1 is blocked from orders', CASE WHEN n_aal1=0 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN with factor at aal1 cannot update an order', CASE WHEN NOT upd_aal1 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN with factor at aal2 can read orders', CASE WHEN n_aal2=1 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN with factor at aal2 can update an order', CASE WHEN upd_aal2 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN without a factor reads orders at aal1 (never locked out)', CASE WHEN n_nofactor=1 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  customer still reads their own order', CASE WHEN n_owner=1 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  WRITER cannot read orders', CASE WHEN n_writer=0 THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- 14. order_items (02023): same shape as orders
RESET ROLE;
DO $$
DECLARE n_aal1 integer; n_aal2 integer; n_nofactor integer; n_owner integer; n_writer integer;
BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal1"}',true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO n_aal1 FROM public.order_items WHERE order_id='aa000000-0000-0000-0000-00000000ad01';
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal2"}',true);
  SELECT count(*) INTO n_aal2 FROM public.order_items WHERE order_id='aa000000-0000-0000-0000-00000000ad01';
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000a2","role":"authenticated","aal":"aal1"}',true);
  SELECT count(*) INTO n_nofactor FROM public.order_items WHERE order_id='aa000000-0000-0000-0000-00000000ad01';
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-00000000cc01","role":"authenticated","aal":"aal1"}',true);
  SELECT count(*) INTO n_owner FROM public.order_items WHERE order_id='aa000000-0000-0000-0000-00000000ad01';
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000f1","role":"authenticated"}',true);
  SELECT count(*) INTO n_writer FROM public.order_items WHERE order_id='aa000000-0000-0000-0000-00000000ad01';
  RAISE NOTICE '%  ADMIN with factor at aal1 is blocked from order_items', CASE WHEN n_aal1=0 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN with factor at aal2 can read order_items', CASE WHEN n_aal2=1 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN without a factor reads order_items at aal1', CASE WHEN n_nofactor=1 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  customer still reads their own order items', CASE WHEN n_owner=1 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  WRITER cannot read order_items', CASE WHEN n_writer=0 THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- 15. profiles (02023): other accounts' rows need aal2 for an ADMIN; own row, WRITER and customer unchanged
RESET ROLE;
DO $$
DECLARE n_aal1 integer; n_aal2 integer; n_nofactor integer; n_writer integer; n_customer integer;
        upd_other_aal1 boolean; upd_own_aal1 boolean; upd_other_aal2 boolean; upd_writer_other boolean;
BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal1"}',true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO n_aal1 FROM public.profiles;
  UPDATE public.profiles SET full_name=full_name WHERE id='aa000000-0000-0000-0000-00000000cc01';
  upd_other_aal1 := FOUND;
  UPDATE public.profiles SET full_name=full_name WHERE id='aa000000-0000-0000-0000-0000000000a1';
  upd_own_aal1 := FOUND;
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal2"}',true);
  SELECT count(*) INTO n_aal2 FROM public.profiles;
  UPDATE public.profiles SET full_name=full_name WHERE id='aa000000-0000-0000-0000-00000000cc01';
  upd_other_aal2 := FOUND;
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000a2","role":"authenticated","aal":"aal1"}',true);
  SELECT count(*) INTO n_nofactor FROM public.profiles;
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000f1","role":"authenticated"}',true);
  SELECT count(*) INTO n_writer FROM public.profiles;
  UPDATE public.profiles SET full_name=full_name WHERE id='aa000000-0000-0000-0000-00000000cc01';
  upd_writer_other := FOUND;
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-00000000cc01","role":"authenticated","aal":"aal1"}',true);
  SELECT count(*) INTO n_customer FROM public.profiles;
  RAISE NOTICE '%  ADMIN with factor at aal1 reads only their own profile row', CASE WHEN n_aal1=1 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN with factor at aal1 cannot update another profile', CASE WHEN NOT upd_other_aal1 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN with factor at aal1 can still update their own profile', CASE WHEN upd_own_aal1 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN with factor at aal2 reads every profile row', CASE WHEN n_aal2>1 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN with factor at aal2 can update another profile', CASE WHEN upd_other_aal2 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN without a factor reads every profile row at aal1', CASE WHEN n_nofactor>1 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  WRITER still reads every profile row (02021, unchanged)', CASE WHEN n_writer>1 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  WRITER still cannot update another profile', CASE WHEN NOT upd_writer_other THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  customer reads only their own profile row', CASE WHEN n_customer=1 THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- 16. site_settings (02023): the ADMIN tier needs aal2; staff tier and non-sensitive writes unchanged
RESET ROLE;
DO $$
DECLARE n_secret_aal1 integer; n_staff_aal1 integer; n_secret_aal2 integer; n_secret_nofactor integer; n_secret_writer integer;
        w_secret_aal1 boolean; w_plain_aal1 boolean; w_secret_aal2 boolean;
BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal1"}',true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO n_secret_aal1 FROM public.site_settings WHERE key='email_secret';
  SELECT count(*) INTO n_staff_aal1 FROM public.site_settings WHERE key='security_settings';
  UPDATE public.site_settings SET value=value WHERE key='email_secret';
  w_secret_aal1 := FOUND;
  UPDATE public.site_settings SET value=value WHERE key='site_title';
  w_plain_aal1 := FOUND;
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal2"}',true);
  SELECT count(*) INTO n_secret_aal2 FROM public.site_settings WHERE key='email_secret';
  UPDATE public.site_settings SET value=value WHERE key='email_secret';
  w_secret_aal2 := FOUND;
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000a2","role":"authenticated","aal":"aal1"}',true);
  SELECT count(*) INTO n_secret_nofactor FROM public.site_settings WHERE key='email_secret';
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000f1","role":"authenticated"}',true);
  SELECT count(*) INTO n_secret_writer FROM public.site_settings WHERE key='email_secret';
  RAISE NOTICE '%  ADMIN with factor at aal1 cannot read a secret-tier setting (email_secret)', CASE WHEN n_secret_aal1=0 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN with factor at aal1 still reads a staff-tier setting (security_settings)', CASE WHEN n_staff_aal1=1 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN with factor at aal1 cannot write a sensitive setting', CASE WHEN NOT w_secret_aal1 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN with factor at aal1 still writes a non-sensitive setting (site_title)', CASE WHEN w_plain_aal1 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN with factor at aal2 reads and writes the secret tier', CASE WHEN n_secret_aal2=1 AND w_secret_aal2 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN without a factor reads the secret tier at aal1', CASE WHEN n_secret_nofactor=1 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  WRITER cannot read the secret tier', CASE WHEN n_secret_writer=0 THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- 17. user_addresses: no ADMIN policy exists (owner + service role only), so nothing to gate
RESET ROLE;
DO $$
DECLARE n_admin integer; n_owner integer;
BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal2"}',true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO n_admin FROM public.user_addresses WHERE id='aa000000-0000-0000-0000-00000000ae01';
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-00000000cc01","role":"authenticated","aal":"aal1"}',true);
  SELECT count(*) INTO n_owner FROM public.user_addresses WHERE id='aa000000-0000-0000-0000-00000000ae01';
  RAISE NOTICE '%  user_addresses: even an aal2 ADMIN reads no other account''s address (owner-only table)', CASE WHEN n_admin=0 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  customer reads their own address', CASE WHEN n_owner=1 THEN 'PASS' ELSE 'FAIL' END;
END $$;

\echo ''
\echo '---------------- catalog posture + grant-level hardening (02025, 02026) ----------'

-- 18. every table in public has row-level security on (a table without it is fully exposed to
--     any role holding a grant on it, whatever its policies say)
RESET ROLE;
DO $$
DECLARE offenders text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO offenders
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity;
  RAISE NOTICE '%  every public table has relrowsecurity = true%', CASE WHEN offenders IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (RLS off: ' || offenders || ')', '');
END $$;

-- 19. SECURITY DEFINER functions in public (lints 0028/0029). PostgreSQL grants EXECUTE to PUBLIC
--     on every new function, and Supabase's default privileges grant it to anon and
--     authenticated by name, so a definer function is callable over /rpc unless revoked from
--     all three. v_anon_allow / v_auth_allow list the definer functions that may stay callable
--     by each role on purpose: none today. v_definer_allow lists the definer functions that may
--     exist in public at all: the two legacy trigger functions (02013/02024 revoke them).
RESET ROLE;
DO $$
DECLARE
  v_anon_allow    text[] := ARRAY[]::text[];
  v_auth_allow    text[] := ARRAY[]::text[];
  v_definer_allow text[] := ARRAY['handle_new_user()', 'update_product_ratings()'];
  anon_x text; auth_x text; unlisted text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO anon_x
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
     AND has_function_privilege('anon', p.oid, 'EXECUTE')
     AND NOT (p.oid::regprocedure::text = ANY (v_anon_allow));
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO auth_x
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
     AND NOT (p.oid::regprocedure::text = ANY (v_auth_allow));
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO unlisted
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
     AND NOT (p.oid::regprocedure::text = ANY (v_definer_allow));
  RAISE NOTICE '%  no SECURITY DEFINER function in public is executable by anon%', CASE WHEN anon_x IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (' || anon_x || ')', '');
  RAISE NOTICE '%  no SECURITY DEFINER function in public is executable by authenticated%', CASE WHEN auth_x IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (' || auth_x || ')', '');
  RAISE NOTICE '%  no SECURITY DEFINER function in public beyond the allowlisted trigger functions%', CASE WHEN unlisted IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (new: ' || unlisted || '; put it in schema private behind a SECURITY INVOKER wrapper, 02021)', '');
END $$;

-- 20. no USING (true) / WITH CHECK (true) policy on a sensitive table for an API role. Such a
--     policy publishes the table to that role (to anyone with the public key for anon/PUBLIC).
--     A policy with no USING / WITH CHECK clause stores NULL, which denies, so only a literal
--     true matters. Missing tables fail too, so a rename cannot silently empty the list.
RESET ROLE;
DO $$
DECLARE
  v_sensitive text[] := ARRAY[
    'profiles', 'orders', 'order_items', 'coupons', 'coupon_redemptions', 'coupon_products',
    'coupon_freemius_mappings', 'package_activations', 'mcp_access_tokens',
    'page_revisions', 'post_revisions', 'product_revisions', 'site_script_revisions',
    'user_addresses', 'user_security_settings', 'user_trusted_devices', 'email_2fa_challenges',
    'ucp_cart_sessions', 'privacy_consent_logs', 'cortex_request_log', 'cortex_ai_db_mutation_audit',
    'system_configuration', 'site_settings', 'message_threads', 'thread_messages', 'product_inquiries'];
  missing text; offenders text;
BEGIN
  SELECT string_agg(t, ', ' ORDER BY t) INTO missing
    FROM unnest(v_sensitive) AS t
   WHERE to_regclass('public.' || t) IS NULL;
  SELECT string_agg(format('%s.%s (%s)', p.tablename, p.policyname, p.cmd), ', ' ORDER BY p.tablename, p.policyname) INTO offenders
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = ANY (v_sensitive)
     AND p.roles && ARRAY['anon', 'authenticated', 'public']::name[]
     AND (regexp_replace(coalesce(p.qual, ''), '[()\s]', '', 'g') ILIKE 'true'
          OR regexp_replace(coalesce(p.with_check, ''), '[()\s]', '', 'g') ILIKE 'true');
  RAISE NOTICE '%  every sensitive table in the list exists%', CASE WHEN missing IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (missing: ' || missing || ')', '');
  RAISE NOTICE '%  no sensitive table has a USING/WITH CHECK (true) policy for anon/authenticated/PUBLIC%', CASE WHEN offenders IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (' || offenders || ')', '');
END $$;

-- 21. anon is read-only at the grant level (02025): no write privilege on any public table or
--     sequence, so RLS is never the only thing between the public key and a write
RESET ROLE;
DO $$
DECLARE tables_w text; seqs_w text;
BEGIN
  SELECT string_agg(DISTINCT table_name || ':' || privilege_type, ', ') INTO tables_w
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND grantee IN ('anon', 'PUBLIC')
     AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO seqs_w
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'S'
     AND (has_sequence_privilege('anon', c.oid, 'USAGE') OR has_sequence_privilege('anon', c.oid, 'UPDATE'));
  RAISE NOTICE '%  anon holds no INSERT/UPDATE/DELETE/TRUNCATE on any public table%', CASE WHEN tables_w IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (' || left(tables_w, 300) || ')', '');
  RAISE NOTICE '%  anon holds no USAGE/UPDATE on any public sequence%', CASE WHEN seqs_w IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (' || seqs_w || ')', '');
END $$;

-- 22. anon writes now fail on the grant, before RLS is consulted
RESET ROLE;
DO $$
DECLARE ins_denied boolean := false; upd_denied boolean := false; del_denied boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claims','{"role":"anon"}',true);
  EXECUTE 'SET LOCAL ROLE anon';
  BEGIN
    INSERT INTO public.translations (key, translations) VALUES ('sv.anon.probe', '{}'::jsonb);
  -- RLS rejects an INSERT with the same SQLSTATE (42501) as a missing grant; only the grant
  -- says "permission denied", so match the message to prove which layer refused it.
  EXCEPTION WHEN insufficient_privilege THEN ins_denied := SQLERRM LIKE 'permission denied%';
  END;
  BEGIN
    UPDATE public.site_settings SET value = value WHERE key = 'site_title';
  EXCEPTION WHEN insufficient_privilege THEN upd_denied := true;
  END;
  BEGIN
    DELETE FROM public.languages WHERE false;
  EXCEPTION WHEN insufficient_privilege THEN del_denied := true;
  END;
  RAISE NOTICE '%  anon INSERT (translations) is refused by the grant', CASE WHEN ins_denied THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  anon UPDATE (site_settings) is refused by the grant', CASE WHEN upd_denied THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  anon DELETE (languages) is refused by the grant', CASE WHEN del_denied THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- 23. cortex_request_log holds no grant for an API role (02022's design; the post-apply pass
--     re-granted it until 02025 and its API_ROLE_REVOKE_SQL entry)
RESET ROLE;
DO $$
DECLARE grants text;
BEGIN
  SELECT string_agg(grantee || ':' || privilege_type, ', ' ORDER BY grantee, privilege_type) INTO grants
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name = 'cortex_request_log'
     AND grantee IN ('anon', 'authenticated', 'PUBLIC');
  RAISE NOTICE '%  cortex_request_log grants nothing to anon/authenticated/PUBLIC%', CASE WHEN grants IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (' || grants || ')', '');
END $$;

-- 24. profiles.role is pinned by column grants (02025), not only by policy + trigger (02021)
RESET ROLE;
DO $$
DECLARE editable text; missing text;
BEGIN
  SELECT string_agg(c, ', ') INTO missing
    FROM unnest(ARRAY['full_name', 'avatar_url', 'website', 'phone', 'updated_at']) AS c
   WHERE NOT has_column_privilege('authenticated', 'public.profiles', c, 'UPDATE');
  RAISE NOTICE '%  authenticated cannot UPDATE profiles.role', CASE WHEN NOT has_column_privilege('authenticated', 'public.profiles', 'role', 'UPDATE') THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  authenticated cannot INSERT profiles.role', CASE WHEN NOT has_column_privilege('authenticated', 'public.profiles', 'role', 'INSERT') THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  authenticated cannot UPDATE profiles.id', CASE WHEN NOT has_column_privilege('authenticated', 'public.profiles', 'id', 'UPDATE') THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  authenticated holds no table-level INSERT/UPDATE/DELETE on profiles', CASE WHEN NOT (
      has_table_privilege('authenticated', 'public.profiles', 'INSERT')
      OR has_table_privilege('authenticated', 'public.profiles', 'UPDATE')
      OR has_table_privilege('authenticated', 'public.profiles', 'DELETE')) THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  authenticated can still UPDATE the self-service profile columns%', CASE WHEN missing IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (missing: ' || missing || ')', '');
END $$;

-- 25. profiles behaviour under the column grants: self-service edits work, role changes over the
--     API are refused even for an aal2 ADMIN, and the service role (app/cms/users) still sets roles
RESET ROLE;
DO $$
DECLARE own_upd boolean; self_promote_denied boolean := false; admin_role_denied boolean := false;
        admin_name boolean; svc_role boolean; r public.user_role;
BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-00000000cc01","role":"authenticated","aal":"aal1"}',true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  UPDATE public.profiles
     SET full_name = 'SV Customer', avatar_url = NULL, website = NULL, phone = '555', updated_at = now()
   WHERE id = 'aa000000-0000-0000-0000-00000000cc01';
  own_upd := FOUND;
  BEGIN
    UPDATE public.profiles SET role = 'ADMIN' WHERE id = 'aa000000-0000-0000-0000-00000000cc01';
  -- the policy WITH CHECK and the 02021 trigger refuse this with 42501 too; the column grant
  -- is the one that says "permission denied"
  EXCEPTION WHEN insufficient_privilege THEN self_promote_denied := SQLERRM LIKE 'permission denied%';
  END;
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal2"}',true);
  BEGIN
    UPDATE public.profiles SET role = 'WRITER' WHERE id = 'aa000000-0000-0000-0000-00000000cc01';
  EXCEPTION WHEN insufficient_privilege THEN admin_role_denied := SQLERRM LIKE 'permission denied%';
  END;
  UPDATE public.profiles SET full_name = full_name WHERE id = 'aa000000-0000-0000-0000-00000000cc01';
  admin_name := FOUND;
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  EXECUTE 'SET LOCAL ROLE service_role';
  UPDATE public.profiles SET role = 'WRITER' WHERE id = 'aa000000-0000-0000-0000-00000000cc01';
  SELECT role INTO r FROM public.profiles WHERE id = 'aa000000-0000-0000-0000-00000000cc01';
  svc_role := (r = 'WRITER'::public.user_role);
  UPDATE public.profiles SET role = 'USER' WHERE id = 'aa000000-0000-0000-0000-00000000cc01';
  RAISE NOTICE '%  customer updates their own name/avatar/website/phone/updated_at', CASE WHEN own_upd THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  customer cannot write their own role (refused by the column grant)', CASE WHEN self_promote_denied THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  aal2 ADMIN cannot change a role over the API (service role only)', CASE WHEN admin_role_denied THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  aal2 ADMIN still edits another account''s profile fields', CASE WHEN admin_name THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  service_role still changes a role (CMS users screen)', CASE WHEN svc_role THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- 26. authenticated holds a table write privilege only where a permissive RLS policy lets it
--     use it (02026), and every such policy has its grant (a grant the post-apply pass strips
--     turns the policy's feature into "permission denied"). INSERT/UPDATE count column grants
--     too (profiles, 02025). v_unused_allow lists 'table:COMMAND' pairs that may keep an unused
--     grant on purpose: none today. REFERENCES/TRIGGER only serve DDL, which no API request runs.
RESET ROLE;
DO $$
DECLARE
  v_unused_allow text[] := ARRAY[]::text[];
  unused text; ungranted text; ddl text;
BEGIN
  WITH t AS (
    SELECT c.oid, c.relname, cmd
      FROM pg_class c CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'DELETE']) AS cmd
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
  ), s AS (
    SELECT t.relname, t.cmd,
           CASE WHEN t.cmd = 'DELETE' THEN has_table_privilege('authenticated', t.oid, 'DELETE')
                ELSE has_any_column_privilege('authenticated', t.oid, t.cmd) END AS granted,
           EXISTS (SELECT 1 FROM pg_policies p
                    WHERE p.schemaname = 'public' AND p.tablename = t.relname
                      AND p.permissive = 'PERMISSIVE' AND p.cmd IN (t.cmd, 'ALL')
                      AND p.roles && ARRAY['authenticated', 'public']::name[]) AS policed
      FROM t
  )
  SELECT string_agg(relname || ':' || cmd, ', ' ORDER BY relname, cmd)
           FILTER (WHERE granted AND NOT policed AND NOT (relname || ':' || cmd = ANY (v_unused_allow))),
         string_agg(relname || ':' || cmd, ', ' ORDER BY relname, cmd) FILTER (WHERE policed AND NOT granted)
    INTO unused, ungranted
    FROM s;
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO ddl
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
     AND (has_any_column_privilege('authenticated', c.oid, 'REFERENCES') OR has_table_privilege('authenticated', c.oid, 'TRIGGER'));
  RAISE NOTICE '%  authenticated holds no INSERT/UPDATE/DELETE that no RLS policy lets it use%', CASE WHEN unused IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (unused: ' || unused || '; revoke it in a migration and in both copies of API_ROLE_REVOKE_SQL)', '');
  RAISE NOTICE '%  every INSERT/UPDATE/DELETE policy for authenticated has its grant%', CASE WHEN ungranted IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (no grant: ' || ungranted || '; is the table still in API_ROLE_REVOKE_SQL?)', '');
  RAISE NOTICE '%  authenticated holds no REFERENCES/TRIGGER on any public table%', CASE WHEN ddl IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (' || left(ddl, 300) || ')', '');
END $$;

-- 27. behaviour under 02026: writes on the service-role-only tables fail on the grant even for
--     an aal2 ADMIN, the commands that keep a policy still work, foreign-key actions still
--     cascade (they run as the referencing table's owner), and the service role still writes
RESET ROLE;
DO $$
DECLARE
  settings_denied boolean := false; license_denied boolean := false; redemption_denied boolean := false;
  own_device boolean; admin_thread boolean; cascaded boolean; svc_write boolean;
  n integer;
BEGIN
  -- fixtures (as the table owner): a trusted device and a message thread, a Freemius plan and
  -- price on the draft product, a second order with a coupon redemption
  INSERT INTO public.user_trusted_devices (id, user_id, device_hash, expires_at)
  VALUES ('aa000000-0000-0000-0000-00000000de01','aa000000-0000-0000-0000-00000000cc01','sv-device',now() + interval '1 day') ON CONFLICT DO NOTHING;
  INSERT INTO public.message_threads (id, source, subject_id, status)
  VALUES ('aa000000-0000-0000-0000-00000000d701','product_inquiry','aa000000-0000-0000-0000-00000000d002','open') ON CONFLICT DO NOTHING;
  INSERT INTO public.freemius_plans (id, product_id, name)
  VALUES ('aa000000-0000-0000-0000-00000000f701','aa000000-0000-0000-0000-00000000d001','sv') ON CONFLICT DO NOTHING;
  INSERT INTO public.freemius_pricing (id, plan_id)
  VALUES ('aa000000-0000-0000-0000-00000000f711','aa000000-0000-0000-0000-00000000f701') ON CONFLICT DO NOTHING;
  INSERT INTO public.orders (id, user_id, status, total, currency, provider)
  VALUES ('aa000000-0000-0000-0000-00000000ad02','aa000000-0000-0000-0000-00000000cc01','paid',900,'USD','stripe') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.coupon_redemptions (id, coupon_id, order_id, coupon_code, provider)
  VALUES ('aa000000-0000-0000-0000-00000000c701','aa000000-0000-0000-0000-00000000c0a1','aa000000-0000-0000-0000-00000000ad02','SVRACE','stripe') ON CONFLICT DO NOTHING;

  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-00000000cc01","role":"authenticated","aal":"aal1"}',true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    INSERT INTO public.user_security_settings (user_id, mfa_enabled) VALUES ('aa000000-0000-0000-0000-00000000cc01', false);
  -- RLS refuses this INSERT with 42501 too; only the grant says "permission denied"
  EXCEPTION WHEN insufficient_privilege THEN settings_denied := SQLERRM LIKE 'permission denied%';
  END;
  DELETE FROM public.user_trusted_devices WHERE id = 'aa000000-0000-0000-0000-00000000de01';
  own_device := FOUND;

  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal2"}',true);
  BEGIN
    INSERT INTO public.package_activations (license_key, instance_name, package_id) VALUES ('SV-PROBE','sv','ecommerce');
  EXCEPTION WHEN insufficient_privilege THEN license_denied := SQLERRM LIKE 'permission denied%';
  END;
  BEGIN
    UPDATE public.coupon_redemptions SET metadata = metadata WHERE id = 'aa000000-0000-0000-0000-00000000c701';
  EXCEPTION WHEN insufficient_privilege THEN redemption_denied := SQLERRM LIKE 'permission denied%';
  END;
  UPDATE public.message_threads SET status = 'closed' WHERE id = 'aa000000-0000-0000-0000-00000000d701';
  admin_thread := FOUND;
  DELETE FROM public.products WHERE id = 'aa000000-0000-0000-0000-00000000d001';
  DELETE FROM public.orders WHERE id = 'aa000000-0000-0000-0000-00000000ad02';

  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  EXECUTE 'SET LOCAL ROLE service_role';
  SELECT (SELECT count(*) FROM public.freemius_plans WHERE id = 'aa000000-0000-0000-0000-00000000f701')
       + (SELECT count(*) FROM public.freemius_pricing WHERE id = 'aa000000-0000-0000-0000-00000000f711')
       + (SELECT count(*) FROM public.coupon_redemptions WHERE id = 'aa000000-0000-0000-0000-00000000c701')
    INTO n;
  cascaded := (n = 0);
  INSERT INTO public.user_security_settings (user_id, mfa_enabled) VALUES ('aa000000-0000-0000-0000-00000000cc01', false)
  ON CONFLICT (user_id) DO UPDATE SET mfa_enabled = EXCLUDED.mfa_enabled;
  svc_write := FOUND;
  RAISE NOTICE '%  customer cannot write their own user_security_settings (refused by the grant)', CASE WHEN settings_denied THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  customer still deletes their own trusted device (owner DELETE policy)', CASE WHEN own_device THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  aal2 ADMIN cannot insert package_activations over the API (refused by the grant)', CASE WHEN license_denied THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  aal2 ADMIN cannot update coupon_redemptions over the API (refused by the grant)', CASE WHEN redemption_denied THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  aal2 ADMIN still updates message_threads (ADMIN UPDATE policy)', CASE WHEN admin_thread THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN deletes still cascade into freemius_plans/freemius_pricing/coupon_redemptions', CASE WHEN cascaded THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  service_role still writes user_security_settings (settings/security actions)', CASE WHEN svc_write THEN 'PASS' ELSE 'FAIL' END;
END $$;

\echo ''
\echo '---------------- read grants (02027) ---------------------------------------------'

-- 28. anon and authenticated hold SELECT on a table only where a permissive RLS policy needs it
--     (02027): a SELECT or ALL policy, or for authenticated an UPDATE/DELETE policy, whose WHERE
--     reads columns. A SELECT no policy uses leaves RLS as the only barrier: one permissive policy
--     added by mistake publishes the table to that role. The reverse fails too: a read policy
--     whose grant is missing turns the public page or CMS screen that relies on it into
--     "permission denied". Views: a view runs its base-table reads as the caller only when it is
--     security_invoker (otherwise as its owner, past RLS: advisor lint 0010), and a role may hold
--     SELECT on one only if it can read every table behind it. v_select_allow lists 'role:table'
--     pairs that may keep an unused SELECT on purpose: none today.
RESET ROLE;
DO $$
DECLARE
  v_select_allow text[] := ARRAY[]::text[];
  unused text; ungranted text; definer_views text; broken_views text;
BEGIN
  WITH t AS (
    SELECT c.oid, c.relname, r.role
      FROM pg_class c CROSS JOIN unnest(ARRAY['anon', 'authenticated']::name[]) AS r(role)
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
  ), s AS (
    SELECT t.role, t.relname,
           has_any_column_privilege(t.role, t.oid, 'SELECT') AS granted,
           EXISTS (SELECT 1 FROM pg_policies p
                    WHERE p.schemaname = 'public' AND p.tablename = t.relname
                      AND p.permissive = 'PERMISSIVE' AND p.cmd IN ('SELECT', 'ALL')
                      AND p.roles && ARRAY[t.role, 'public']::name[]) AS reads,
           EXISTS (SELECT 1 FROM pg_policies p
                    WHERE p.schemaname = 'public' AND p.tablename = t.relname
                      AND p.permissive = 'PERMISSIVE' AND p.cmd IN ('SELECT', 'ALL', 'UPDATE', 'DELETE')
                      AND p.roles && ARRAY[t.role, 'public']::name[]) AS needs
      FROM t
  )
  SELECT string_agg(role || ':' || relname, ', ' ORDER BY role, relname)
           FILTER (WHERE granted AND NOT needs AND NOT (role || ':' || relname = ANY (v_select_allow))),
         string_agg(role || ':' || relname, ', ' ORDER BY role, relname) FILTER (WHERE reads AND NOT granted)
    INTO unused, ungranted
    FROM s;
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO definer_views
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('v', 'm')
     AND NOT (c.relkind = 'v' AND coalesce(c.reloptions, '{}') && ARRAY['security_invoker=true', 'security_invoker=on']);
  SELECT string_agg(DISTINCT format('%s:%s (reads %s)', r.role, v.relname, b.relname), ', ') INTO broken_views
    FROM pg_class v
    CROSS JOIN unnest(ARRAY['anon', 'authenticated']::name[]) AS r(role)
    JOIN pg_rewrite rw ON rw.ev_class = v.oid
    JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = rw.oid AND d.refclassid = 'pg_class'::regclass
    JOIN pg_class b ON b.oid = d.refobjid AND b.oid <> v.oid AND b.relkind IN ('r', 'p', 'v', 'm', 'f')
   WHERE v.relnamespace = 'public'::regnamespace AND v.relkind IN ('v', 'm')
     AND has_table_privilege(r.role, v.oid, 'SELECT')
     AND NOT has_any_column_privilege(r.role, b.oid, 'SELECT');
  RAISE NOTICE '%  anon/authenticated hold no SELECT that no RLS policy uses%', CASE WHEN unused IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (unused: ' || left(unused, 400) || '; revoke it in a migration and in both copies of API_ROLE_REVOKE_SQL)', '');
  RAISE NOTICE '%  every SELECT policy for anon/authenticated/PUBLIC has its grant%', CASE WHEN ungranted IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (no grant: ' || ungranted || '; is the table still in API_ROLE_REVOKE_SQL?)', '');
  RAISE NOTICE '%  every view in public is security_invoker%', CASE WHEN definer_views IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (runs as its owner: ' || definer_views || ')', '');
  RAISE NOTICE '%  no role holds SELECT on a view over a table it cannot read%', CASE WHEN broken_views IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (' || broken_views || ')', '');
END $$;

-- 29. behaviour under 02027: anon reads of private tables fail on the grant, the public site's
--     reads still work (pages, posts, blocks, navigation, products with their variants, media
--     and Freemius plans, the approved review/comment author card through author()), a customer
--     still reads their own order, items, address and profile, and only the service role reads
--     2FA challenges and UCP carts.
RESET ROLE;
DO $$
DECLARE
  v_private text[] := ARRAY['orders', 'order_items', 'profiles', 'profile_cards', 'coupons', 'user_addresses',
                            'mcp_access_tokens', 'page_revisions', 'content_drafts', 'email_2fa_challenges'];
  v_public text[] := ARRAY['pages', 'posts', 'blocks', 'navigation_items', 'languages', 'translations',
                           'site_settings', 'site_themes', 'site_scripts', 'cms_redirects', 'logos', 'media',
                           'custom_block_definitions', 'cms_interactions', 'categories', 'products',
                           'product_variants', 'product_media', 'product_categories', 'product_attributes',
                           'product_attribute_terms', 'variant_attribute_mapping', 'inventory_items',
                           'freemius_plans', 'freemius_pricing', 'currencies', 'tax_rates', 'shipping_zones',
                           'shipping_zone_methods', 'shipping_zone_locations'];
  tbl text; n integer;
  readable text; refused text; card_name text; embed_ok boolean := false;
  own_order integer; own_item integer; own_address integer; own_profile integer; own_card integer;
  auth_2fa boolean := false; auth_cart boolean := false; svc_cart integer;
BEGIN
  -- fixture (as the table owner): the customer's approved review on the live product
  INSERT INTO public.cms_interactions (id, type, status, content, rating, user_id, product_id)
  VALUES ('aa000000-0000-0000-0000-00000000c901','review','approved','SV review',5,
          'aa000000-0000-0000-0000-00000000cc01','aa000000-0000-0000-0000-00000000d002') ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('request.jwt.claims','{"role":"anon"}',true);
  EXECUTE 'SET LOCAL ROLE anon';
  FOREACH tbl IN ARRAY v_private LOOP
    BEGIN
      EXECUTE format('SELECT count(*) FROM public.%I', tbl) INTO n;
      readable := concat_ws(', ', readable, tbl);
    -- RLS never raises on a SELECT; only a missing grant says "permission denied"
    EXCEPTION WHEN insufficient_privilege THEN
      IF SQLERRM NOT LIKE 'permission denied%' THEN readable := concat_ws(', ', readable, tbl); END IF;
    END;
  END LOOP;
  FOREACH tbl IN ARRAY v_public LOOP
    BEGIN
      EXECUTE format('SELECT count(*) FROM public.%I', tbl) INTO n;
    EXCEPTION WHEN insufficient_privilege THEN refused := concat_ws(', ', refused, tbl);
    END;
  END LOOP;
  -- the shape of a public product page (PostgREST embeds are correlated subqueries as the caller)
  BEGIN
    PERFORM p.id,
            (SELECT json_agg(v) FROM public.product_variants v WHERE v.product_id = p.id),
            (SELECT json_agg(pm) FROM public.product_media pm WHERE pm.product_id = p.id),
            (SELECT json_agg(fp) FROM public.freemius_plans fp
               LEFT JOIN public.freemius_pricing fpr ON fpr.plan_id = fp.id WHERE fp.product_id = p.id)
      FROM public.products p WHERE p.id = 'aa000000-0000-0000-0000-00000000d002';
    embed_ok := FOUND;
  EXCEPTION WHEN insufficient_privilege THEN embed_ok := false;
  END;
  SELECT a.full_name INTO card_name
    FROM public.cms_interactions ci CROSS JOIN LATERAL public.author(ci) AS a
   WHERE ci.id = 'aa000000-0000-0000-0000-00000000c901';

  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-00000000cc01","role":"authenticated","aal":"aal1"}',true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO own_order FROM public.orders WHERE id = 'aa000000-0000-0000-0000-00000000ad01';
  SELECT count(*) INTO own_item FROM public.order_items WHERE id = 'aa000000-0000-0000-0000-00000000ad11';
  SELECT count(*) INTO own_address FROM public.user_addresses WHERE id = 'aa000000-0000-0000-0000-00000000ae01';
  SELECT count(*) INTO own_profile FROM public.profiles WHERE id = 'aa000000-0000-0000-0000-00000000cc01';
  SELECT count(*) INTO own_card FROM public.profile_cards WHERE id = 'aa000000-0000-0000-0000-00000000cc01';
  BEGIN
    PERFORM 1 FROM public.email_2fa_challenges;
  EXCEPTION WHEN insufficient_privilege THEN auth_2fa := SQLERRM LIKE 'permission denied%';
  END;
  BEGIN
    PERFORM 1 FROM public.ucp_cart_sessions;
  EXCEPTION WHEN insufficient_privilege THEN auth_cart := SQLERRM LIKE 'permission denied%';
  END;

  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  EXECUTE 'SET LOCAL ROLE service_role';
  SELECT count(*) INTO svc_cart FROM public.ucp_cart_sessions WHERE id = 'aa000000-0000-0000-0000-00000000ca01';

  RAISE NOTICE '%  anon reads of orders, profiles, coupons, revisions, drafts, tokens, 2FA are refused by the grant%', CASE WHEN readable IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (still readable: ' || readable || ')', '');
  RAISE NOTICE '%  anon still reads every table the public site renders%', CASE WHEN refused IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (permission denied: ' || refused || ')', '');
  RAISE NOTICE '%  anon reads a live product with its variants, media and Freemius plans', CASE WHEN embed_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  anon reads an approved review''s author card through author() (no SELECT on profiles)', CASE WHEN card_name = 'SV Customer' THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  customer reads their own order and order item (order_items policy reads orders)', CASE WHEN own_order = 1 AND own_item = 1 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  customer reads their own address, profile and profile card', CASE WHEN own_address = 1 AND own_profile = 1 AND own_card = 1 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  authenticated cannot read email_2fa_challenges or ucp_cart_sessions (refused by the grant)', CASE WHEN auth_2fa AND auth_cart THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  service_role still reads UCP carts (UCP routes)', CASE WHEN svc_cart = 1 THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- 30. site_settings writes (02028 §1): WRITER on an allow-list, the rest ADMIN, and every key
--     outside the WRITER and ADMIN lists behind the second factor. a1 has a TOTP factor (check
--     5), a2 none. The unfiltered UPDATE is the audit's PATCH (it touched 13 rows).
RESET ROLE;
DO $$
DECLARE
  v_writer_keys text[] := ARRAY['site_title','site_description','site_keywords','site_social_image','active_logo_id','footer_copyright','footer_show_attribution','onboarding_state'];
  w_email boolean; w_captcha boolean; w_insert_denied boolean := false; offenders text; w_own boolean;
  a1_email boolean; a1_tier boolean; a2_email boolean;
BEGIN
  INSERT INTO public.site_settings (key, value) VALUES
    ('email_public', '{"host":"smtp.sv.local","port":587}'::jsonb),
    ('bot_protection_public', '{"provider":"turnstile"}'::jsonb),
    ('payment_public', '{}'::jsonb), ('enabled_payment_providers', '["stripe"]'::jsonb),
    ('ecommerce_inventory_settings', '{}'::jsonb), ('invoice_settings', '{}'::jsonb),
    ('store_contact', '{"email":"store@sv.local"}'::jsonb), ('forms_contact', '{}'::jsonb),
    ('interactions_notification_emails', '[]'::jsonb), ('migration_baseline_generation', '2'::jsonb),
    ('cortex_ai_agent_settings', '{}'::jsonb), ('cortex_ai_openrouter_model_selection', '{}'::jsonb),
    ('onboarding_state', '{}'::jsonb), ('site_title', '"SV"'::jsonb)
  ON CONFLICT (key) DO NOTHING;

  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000f1","role":"authenticated","aal":"aal1"}',true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  UPDATE public.site_settings SET value = '{"host":"evil.sv.local","port":25}'::jsonb WHERE key = 'email_public';
  w_email := FOUND;
  UPDATE public.site_settings SET value = '{"provider":"none"}'::jsonb WHERE key = 'bot_protection_public';
  w_captcha := FOUND;
  BEGIN
    INSERT INTO public.site_settings (key, value) VALUES ('sv_unlisted_key', '1'::jsonb);
  EXCEPTION WHEN insufficient_privilege THEN w_insert_denied := true;
  END;
  WITH u AS (UPDATE public.site_settings SET value = value RETURNING key)
  SELECT string_agg(key, ', ' ORDER BY key) FILTER (WHERE key <> ALL (v_writer_keys)) INTO offenders FROM u;
  UPDATE public.site_settings SET value = value WHERE key IN ('site_title', 'onboarding_state');
  w_own := FOUND;

  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal1"}',true);
  UPDATE public.site_settings SET value = value WHERE key = 'email_public';
  a1_email := FOUND;
  UPDATE public.site_settings SET value = value WHERE key = 'enabled_payment_providers';
  a1_tier := FOUND;
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000a2","role":"authenticated","aal":"aal1"}',true);
  UPDATE public.site_settings SET value = value WHERE key = 'email_public';
  a2_email := FOUND;

  RAISE NOTICE '%  WRITER cannot rewrite site_settings.email_public (SMTP host)', CASE WHEN NOT w_email THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  WRITER cannot switch the captcha off (bot_protection_public)', CASE WHEN NOT w_captcha THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  WRITER cannot insert a key outside the WRITER allow-list', CASE WHEN w_insert_denied THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  an unfiltered WRITER UPDATE reaches only allow-listed keys%', CASE WHEN offenders IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (also updated: ' || offenders || ')', '');
  RAISE NOTICE '%  WRITER still writes site_title and onboarding_state', CASE WHEN w_own THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN with factor at aal1 cannot rewrite email_public', CASE WHEN NOT a1_email THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN with factor at aal1 still writes a first-factor ADMIN key (enabled_payment_providers)', CASE WHEN a1_tier THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN without a factor writes email_public at aal1', CASE WHEN a2_email THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- 31. the app's email second factor counts in RLS (02028 §2). a3 is an ADMIN whose only factor
--     is the email code (user_security_settings, no auth.mfa_factors row), so every session is
--     aal1. a2 gets a disabled row: an admin who switched 2FA off is still not locked out.
RESET ROLE;
DO $$
DECLARE n_license integer; mint_denied boolean := false; n_secret integer; w_privacy boolean; w_security boolean;
        n_profiles integer; n_disabled integer;
BEGIN
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  VALUES ('aa000000-0000-0000-0000-0000000000a3','00000000-0000-0000-0000-000000000000','authenticated','authenticated','sv-admin3@test.local','x',now(),now(),'{}','{"full_name":"SV Admin 3"}')
  ON CONFLICT (id) DO NOTHING;
  UPDATE public.profiles SET role='ADMIN' WHERE id='aa000000-0000-0000-0000-0000000000a3';
  INSERT INTO public.user_security_settings (user_id, mfa_enabled, mfa_type) VALUES
    ('aa000000-0000-0000-0000-0000000000a3', true, 'email'),
    ('aa000000-0000-0000-0000-0000000000a2', false, NULL)
  ON CONFLICT (user_id) DO UPDATE SET mfa_enabled = EXCLUDED.mfa_enabled, mfa_type = EXCLUDED.mfa_type;
  INSERT INTO public.site_settings (key, value) VALUES ('privacy_settings', '{}'::jsonb), ('security_settings', '{}'::jsonb)
  ON CONFLICT (key) DO NOTHING;

  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000a3","role":"authenticated","aal":"aal1"}',true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO n_license FROM public.package_activations;
  BEGIN
    INSERT INTO public.mcp_access_tokens (name, token_hash, token_prefix, created_by)
    VALUES ('sv', 'sv-hash', 'sv', 'aa000000-0000-0000-0000-0000000000a3');
  EXCEPTION WHEN insufficient_privilege THEN mint_denied := true;
  END;
  SELECT count(*) INTO n_secret FROM public.site_settings WHERE key = 'email_secret';
  UPDATE public.site_settings SET value = value WHERE key = 'privacy_settings';
  w_privacy := FOUND;
  UPDATE public.site_settings SET value = value WHERE key = 'security_settings';
  w_security := FOUND;
  SELECT count(*) INTO n_profiles FROM public.profiles;
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000a2","role":"authenticated","aal":"aal1"}',true);
  SELECT count(*) INTO n_disabled FROM public.package_activations;

  RAISE NOTICE '%  email-2FA ADMIN at aal1 cannot read package_activations', CASE WHEN n_license=0 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  email-2FA ADMIN at aal1 cannot mint an MCP token', CASE WHEN mint_denied THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  email-2FA ADMIN at aal1 cannot read the secret tier (email_secret)', CASE WHEN n_secret=0 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  email-2FA ADMIN at aal1 cannot write privacy_settings or security_settings', CASE WHEN NOT w_privacy AND NOT w_security THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  email-2FA ADMIN at aal1 reads only their own profile row', CASE WHEN n_profiles=1 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN with 2FA switched off (mfa_enabled = false) still reads at aal1', CASE WHEN n_disabled>0 THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- 32. the remaining ADMIN branches need the second factor (02028 §3): a1 (TOTP) at aal1 is
--     refused on scripts, redirects, system_configuration and the message tables; at aal2 the
--     same statements work.
RESET ROLE;
DO $$
DECLARE script_denied boolean := false; revision_denied boolean := false; redirect_denied boolean := false;
        n_config integer; config_upd boolean; n_inquiries integer; n_threads integer; n_messages integer; thread_upd boolean;
        script_aal2 boolean := false; n_threads_aal2 integer; n_config_aal2 integer;
BEGIN
  INSERT INTO public.system_configuration (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.product_inquiries (id, sender_name, sender_email, message)
  VALUES ('aa000000-0000-0000-0000-00000000d801','SV Buyer','sv-buyer@test.local','sv question') ON CONFLICT DO NOTHING;
  INSERT INTO public.message_threads (id, source, subject_id, status, sender_email)
  VALUES ('aa000000-0000-0000-0000-00000000d702','product_inquiry','aa000000-0000-0000-0000-00000000d002','open','sv-buyer@test.local') ON CONFLICT DO NOTHING;
  INSERT INTO public.thread_messages (id, thread_id, direction, body)
  VALUES ('aa000000-0000-0000-0000-00000000d711','aa000000-0000-0000-0000-00000000d702','inbound','sv message') ON CONFLICT DO NOTHING;

  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal1"}',true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    INSERT INTO public.site_scripts (name, code, is_active) VALUES ('sv-probe', 'void 0', true);
  EXCEPTION WHEN insufficient_privilege THEN script_denied := true;
  END;
  BEGIN
    INSERT INTO public.site_script_revisions (script_name, revision_type, snapshot) VALUES ('sv-probe', 'create', '{}'::jsonb);
  EXCEPTION WHEN insufficient_privilege THEN revision_denied := true;
  END;
  BEGIN
    INSERT INTO public.cms_redirects (source_path, destination_path) VALUES ('/sv-probe', 'https://evil.sv.local/');
  EXCEPTION WHEN insufficient_privilege THEN redirect_denied := true;
  END;
  SELECT count(*) INTO n_config FROM public.system_configuration;
  UPDATE public.system_configuration SET auto_accept_signups = auto_accept_signups WHERE id = 1;
  config_upd := FOUND;
  SELECT count(*) INTO n_inquiries FROM public.product_inquiries WHERE id = 'aa000000-0000-0000-0000-00000000d801';
  SELECT count(*) INTO n_threads FROM public.message_threads WHERE id = 'aa000000-0000-0000-0000-00000000d702';
  SELECT count(*) INTO n_messages FROM public.thread_messages WHERE id = 'aa000000-0000-0000-0000-00000000d711';
  UPDATE public.message_threads SET status = 'closed' WHERE id = 'aa000000-0000-0000-0000-00000000d702';
  thread_upd := FOUND;

  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal2"}',true);
  INSERT INTO public.site_scripts (name, code, is_active) VALUES ('sv-probe-aal2', 'void 0', false);
  script_aal2 := FOUND;
  SELECT count(*) INTO n_threads_aal2 FROM public.message_threads WHERE id = 'aa000000-0000-0000-0000-00000000d702';
  SELECT count(*) INTO n_config_aal2 FROM public.system_configuration;

  RAISE NOTICE '%  ADMIN with factor at aal1 cannot write site_scripts', CASE WHEN script_denied THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN with factor at aal1 cannot write site_script_revisions', CASE WHEN revision_denied THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN with factor at aal1 cannot write cms_redirects', CASE WHEN redirect_denied THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN with factor at aal1 cannot read or update system_configuration', CASE WHEN n_config=0 AND NOT config_upd THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN with factor at aal1 cannot read product_inquiries / message_threads / thread_messages', CASE WHEN n_inquiries=0 AND n_threads=0 AND n_messages=0 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN with factor at aal1 cannot update message_threads', CASE WHEN NOT thread_upd THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN with factor at aal2 writes site_scripts and reads threads and system_configuration', CASE WHEN script_aal2 AND n_threads_aal2=1 AND n_config_aal2=1 THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- 33. media (02028 §4): insert pins uploader_id, and the service role can tell which storage
--     keys another row still references (the delete/move actions keep those). The function
--     is looked up first so a database without it prints FAIL instead of aborting the run.
RESET ROLE;
DO $$
DECLARE forged_denied boolean := false; own_insert boolean; fn regprocedure; in_use text[]; excluded text[];
        fn_ok boolean := false; api_x boolean := true;
BEGIN
  INSERT INTO public.media (id, object_key, file_name, file_path, uploader_id, variants)
  VALUES ('aa000000-0000-0000-0000-00000000e005','sv/victim.png','victim.png','sv/victim.png','aa000000-0000-0000-0000-0000000000a1',
          '[{"objectKey":"sv/victim_large.avif"},{"objectKey":"sv/victim_small.avif"}]'::jsonb)
  ON CONFLICT DO NOTHING;

  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000f1","role":"authenticated","aal":"aal1"}',true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    INSERT INTO public.media (object_key, file_name, file_path, uploader_id)
    VALUES ('sv/forged.png','forged.png','sv/forged.png','aa000000-0000-0000-0000-0000000000a1');
  EXCEPTION WHEN insufficient_privilege THEN forged_denied := true;
  END;
  INSERT INTO public.media (id, object_key, file_name, file_path, uploader_id, variants)
  VALUES ('aa000000-0000-0000-0000-00000000e006','sv/decoy.png','decoy.png','sv/decoy.png','aa000000-0000-0000-0000-0000000000f1',
          '[{"objectKey":"sv/victim_large.avif"}]'::jsonb);
  own_insert := FOUND;

  fn := to_regprocedure('public.media_storage_keys_in_use(text[], uuid)');
  IF fn IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
    EXECUTE 'SET LOCAL ROLE service_role';
    EXECUTE 'SELECT array_agg(k ORDER BY k COLLATE "C") FROM public.media_storage_keys_in_use($1, $2) AS k'
      INTO in_use USING ARRAY['sv/victim_small.avif','sv/victim.png','sv/nobody.png'], NULL::uuid;
    EXECUTE 'SELECT array_agg(k ORDER BY k COLLATE "C") FROM public.media_storage_keys_in_use($1, $2) AS k'
      INTO excluded USING ARRAY['sv/decoy.png','sv/victim_large.avif'], 'aa000000-0000-0000-0000-00000000e006'::uuid;
    fn_ok := in_use = ARRAY['sv/victim.png','sv/victim_small.avif']
             AND excluded = ARRAY['sv/victim_large.avif'];
    api_x := has_function_privilege('anon', fn, 'EXECUTE') OR has_function_privilege('authenticated', fn, 'EXECUTE');
  END IF;

  RAISE NOTICE '%  WRITER cannot insert a media row attributed to another uploader', CASE WHEN forged_denied THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  WRITER still inserts a media row of their own', CASE WHEN own_insert THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  media_storage_keys_in_use reports keys another row references (object_key, variants), minus the excluded row', CASE WHEN fn_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  anon / authenticated cannot EXECUTE media_storage_keys_in_use', CASE WHEN fn IS NOT NULL AND NOT api_x THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- 34. package_activations (02028 §5): no API role reads license_key or meta; an aal2 ADMIN
--     still lists which packages are active
RESET ROLE;
DO $$
DECLARE n integer; key_denied boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal2"}',true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO n FROM (SELECT package_id, status FROM public.package_activations) AS rows_visible;
  BEGIN
    PERFORM license_key FROM public.package_activations;
  EXCEPTION WHEN insufficient_privilege THEN key_denied := true;
  END;
  RAISE NOTICE '%  authenticated holds no SELECT on package_activations.license_key or .meta', CASE WHEN NOT has_column_privilege('authenticated', 'public.package_activations', 'license_key', 'SELECT')
    AND NOT has_column_privilege('authenticated', 'public.package_activations', 'meta', 'SELECT') THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  aal2 ADMIN reading license_key over the API is refused by the grant', CASE WHEN key_denied THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  aal2 ADMIN still reads package_id/status of package_activations', CASE WHEN n>0 THEN 'PASS' ELSE 'FAIL' END;
END $$;

\echo '==========================================================================='
\echo '(all fixtures rolled back below — database unchanged)'

ROLLBACK;
