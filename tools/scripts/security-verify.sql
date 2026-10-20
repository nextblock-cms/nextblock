-- NextBlock DB security posture check (2026-10-19 red-team; migrations 02022 and 02023).
--
-- Self-contained before/after harness for the RLS / trigger fixes in
-- 02022_security_hardening_writer_boundary_and_aal.sql (sections 1-12) and the aal2 widening
-- in 02023_aal2_for_orders_profiles_site_settings.sql (sections 13-17). It creates throwaway
-- fixtures, emulates PostgREST exactly (SET LOCAL ROLE + request.jwt.claims; SET LOCAL reverts
-- at each DO block's exit), prints PASS/FAIL per assertion, and ROLLS BACK so the database is
-- left untouched.
--
--   Before 02022:  several checks print FAIL.
--   After  02022:  sections 1-12 print PASS; the "aal1 is blocked" lines of 13-16 print FAIL.
--   After  02023:  every check prints PASS.
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
\echo '================ NextBlock security posture (02022 + 02023) ================'

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

\echo '==========================================================================='
\echo '(all fixtures rolled back below — database unchanged)'

ROLLBACK;
