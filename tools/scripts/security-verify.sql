-- NextBlock DB security posture check (2026-10-19 red-team; migrations 02022, 02023, 02025-02028, 02030, 02035, 02036, 02037, 02038).
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
-- pins, package_activations license columns), and the Affiliates & Creator Storefronts package of
-- 02030_affiliates_schema.sql (sections 35-38: grants, column pins and function privileges; sign-up
-- and the partner / anon seats; the commission ledger and payouts, with 37b for key modes, the
-- retry minimum, refund shares and dispute holds; repairs, sweeps and deletes;
-- their tables also join the lists of sections 20 and 29), and the tier moves and the rate at
-- payment of 02035_affiliate_tier_rate_at_payment.sql (section 39: the service-role tier RPC and
-- its outcomes, the orders rate trigger, the tier_changed_at pin, a commission recorded after a
-- move keeping the rate of its payment, a dispute opened before its commission holding it), and the
-- manual payouts of 02036_affiliate_manual_payouts.sql (section 40: the manual payout lifecycle and
-- the gateway-filtered claim are service-role only, a manual payout is prepared or recorded and never
-- carries a Stripe field, payout_email is server-written and formula-safe, the claim reserves exactly
-- what is owed and keeps a refund or dispute that arrives while it is prepared in flight, the record
-- completes exactly the prepared payout, the cancel hands it back, the Stripe RPCs never touch a
-- manual payout, the claim never takes a gateway paid by hand, the recovery advice after a refund;
-- section 35 pins the new claim signature), and the PayPal payouts of 02037_affiliate_paypal_payouts.sql
-- (section 41: the PayPal payout lifecycle is service-role only, a PayPal payout names its recipient and
-- never carries a Stripe field, it can be FAILED (a paypal_ reason only) while a manual one still cannot,
-- payout_email_kind and payout_email_saved_at are server-written, the CMS-saved PayPal credentials row
-- is service-role only, the claim reserves exactly the commissions of the PayPal gateways and the
-- environment's mode, completion is exactly once, a failure hands the commissions back, the Stripe RPCs
-- never fail, release, complete or re-send a PayPal payout, the admin release waits an hour after the
-- last send of an unconfirmed batch and a week for an acknowledged one PayPal does not hold, the PayPal
-- refund advice), and the secret rows of site_settings of
-- 02038_site_settings_secret_rows_service_role_only.sql (section 42: service role only, whatever
-- the admin's second factor). It creates throwaway fixtures, emulates PostgREST exactly (SET LOCAL ROLE + request.jwt.claims;
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
--   After  02028:  sections 1-34 print PASS except section 20's "every sensitive table exists" and
--                  section 29's "anon still reads every table the public site renders" (the
--                  affiliate tables are missing); sections 35-38 stop at their first line with an
--                  uncounted FAIL, so the runner reports their 72 assertions as never run.
--   After  02030:  sections 1-38 print PASS (206), with or without the post-apply pass; section 39
--                  stops at its first line with an uncounted FAIL (the 02035 objects are missing),
--                  so the runner reports its 12 assertions as never run.
--   After  02035:  sections 1-34 and 36-39 print PASS; section 35 stops at its first line with an
--                  uncounted FAIL (the five-argument claim_affiliate_payout of 02036 is missing),
--                  and so does section 40, so the runner reports their 28 assertions as never run.
--   After  02036:  sections 1-40 print PASS (231); section 41 stops at its first line with an
--                  uncounted FAIL (the 02037 columns and functions are missing), so the runner
--                  reports its 15 assertions as never run.
--   After  02037:  every check prints PASS (246 of 256) except seven lines of section 42: an ADMIN at
--                  aal2, or without a factor, still reads, updates, copies, inserts, upserts and
--                  deletes the secret rows, and those deletes also fail its service-role line
--                  (section 42 prints the same seven FAIL lines at every level above).
--   After  02038:  every check prints PASS (256), with or without the post-apply pass. Run it on
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
-- order, an order item and an address, a secret site_settings row and an ADMIN-tier one. (a1
-- gets a verified factor in check 5 and keeps it for the rest of the transaction.)
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
INSERT INTO public.site_settings (key, value) VALUES ('email_secret','{"user":"sv"}'::jsonb), ('store_contact','{"email":"store@sv.local"}'::jsonb) ON CONFLICT (key) DO NOTHING;

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

-- 16. site_settings (02023): the ADMIN tier needs aal2; staff tier and non-sensitive writes unchanged.
--     The aal2 and no-factor lines probe store_contact: since 02038 no API session reaches a
--     secret row like email_secret at all (section 42).
RESET ROLE;
DO $$
DECLARE n_secret_aal1 integer; n_staff_aal1 integer; n_tier_aal2 integer; n_tier_nofactor integer; n_secret_writer integer;
        w_secret_aal1 boolean; w_plain_aal1 boolean; w_tier_aal2 boolean;
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
  SELECT count(*) INTO n_tier_aal2 FROM public.site_settings WHERE key='store_contact';
  UPDATE public.site_settings SET value=value WHERE key='store_contact';
  w_tier_aal2 := FOUND;
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000a2","role":"authenticated","aal":"aal1"}',true);
  SELECT count(*) INTO n_tier_nofactor FROM public.site_settings WHERE key='store_contact';
  PERFORM set_config('request.jwt.claims','{"sub":"aa000000-0000-0000-0000-0000000000f1","role":"authenticated"}',true);
  SELECT count(*) INTO n_secret_writer FROM public.site_settings WHERE key='email_secret';
  RAISE NOTICE '%  ADMIN with factor at aal1 cannot read a secret-tier setting (email_secret)', CASE WHEN n_secret_aal1=0 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN with factor at aal1 still reads a staff-tier setting (security_settings)', CASE WHEN n_staff_aal1=1 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN with factor at aal1 cannot write a sensitive setting', CASE WHEN NOT w_secret_aal1 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN with factor at aal1 still writes a non-sensitive setting (site_title)', CASE WHEN w_plain_aal1 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN with factor at aal2 reads and writes the ADMIN tier (store_contact)', CASE WHEN n_tier_aal2=1 AND w_tier_aal2 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN without a factor reads the ADMIN tier at aal1 (store_contact)', CASE WHEN n_tier_nofactor=1 THEN 'PASS' ELSE 'FAIL' END;
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
    'system_configuration', 'site_settings', 'message_threads', 'thread_messages', 'product_inquiries',
    'affiliate_profiles', 'affiliate_pages', 'affiliate_commissions', 'affiliate_payouts',
    'affiliate_click_events', 'affiliate_payout_runs'];
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
                            'mcp_access_tokens', 'page_revisions', 'content_drafts', 'email_2fa_challenges',
                            'affiliate_profiles', 'affiliate_pages', 'affiliate_commissions', 'affiliate_payouts',
                            'affiliate_click_events', 'affiliate_payout_runs'];
  v_public text[] := ARRAY['pages', 'posts', 'blocks', 'navigation_items', 'languages', 'translations',
                           'site_settings', 'site_themes', 'site_scripts', 'cms_redirects', 'logos', 'media',
                           'custom_block_definitions', 'cms_interactions', 'categories', 'products',
                           'product_variants', 'product_media', 'product_categories', 'product_attributes',
                           'product_attribute_terms', 'variant_attribute_mapping', 'inventory_items',
                           'freemius_plans', 'freemius_pricing', 'currencies', 'tax_rates', 'shipping_zones',
                           'shipping_zone_methods', 'shipping_zone_locations', 'affiliate_tiers'];
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
    EXCEPTION
      WHEN insufficient_privilege THEN
        IF SQLERRM NOT LIKE 'permission denied%' THEN readable := concat_ws(', ', readable, tbl); END IF;
      -- a table a later migration adds (affiliates, 02030) is missing before it: section 20 says so
      WHEN undefined_table THEN NULL;
    END;
  END LOOP;
  FOREACH tbl IN ARRAY v_public LOOP
    BEGIN
      EXECUTE format('SELECT count(*) FROM public.%I', tbl) INTO n;
    EXCEPTION
      WHEN insufficient_privilege THEN refused := concat_ws(', ', refused, tbl);
      WHEN undefined_table THEN refused := concat_ws(', ', refused, tbl || ' (missing)');
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

  RAISE NOTICE '%  anon reads of orders, profiles, coupons, revisions, drafts, tokens, 2FA and the affiliate ledger are refused by the grant%', CASE WHEN readable IS NULL THEN 'PASS' ELSE 'FAIL' END,
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

\echo ''
\echo '---------------- affiliates & creator storefronts (02030) -----------------------'

-- 35. affiliates (02030): grants, column pins and function privileges. anon reads the active
--     tier ladder and nothing else; authenticated reads through the owner / ADMIN policies and
--     writes only the self-service profile and draft columns; the ledger, the click log and the
--     payout-run claims take no API write; one permissive policy per role and command; every
--     money RPC and ledger helper is service-role only; the four storefront RPCs are public.
RESET ROLE;
DO $$
DECLARE
  v_tables text[] := ARRAY['affiliate_tiers', 'affiliate_profiles', 'affiliate_pages', 'affiliate_commissions',
                           'affiliate_payouts', 'affiliate_click_events', 'affiliate_payout_runs'];
  v_service_rpcs text[] := ARRAY[
    'public.create_affiliate_account(uuid, text, text, text, text, text, jsonb, text)',
    'public.promote_cleared_affiliate_commissions()',
    -- 02036 replaced the four-argument claim with this one (p_gateways); section 40 checks the rest of 02036
    'public.claim_affiliate_payout(uuid, text, bigint, text, public.affiliate_gateway[])',
    'public.complete_affiliate_payout(uuid, text)',
    'public.fail_affiliate_payout(uuid, text)',
    'public.prepare_affiliate_payout_retry(uuid, bigint)',
    'public.release_affiliate_payout(uuid)',
    'public.claim_affiliate_payout_run(date, text)',
    'public.finish_affiliate_payout_run(date, jsonb)',
    'public.claim_affiliate_commission_notifications(integer)',
    'public.apply_affiliate_refund(public.affiliate_gateway, uuid, bigint, bigint, boolean)',
    'public.set_affiliate_commission_dispute(public.affiliate_gateway, uuid, boolean)',
    'public.reconcile_affiliate_commissions(integer)'];
  v_public_rpcs text[] := ARRAY[
    'public.get_affiliate_storefront(text)', 'public.list_affiliate_storefronts(integer)',
    'public.get_affiliate_referral_window(text)', 'public.record_affiliate_click(text, text)',
    'private.get_affiliate_storefront(text)', 'private.list_affiliate_storefronts(integer)',
    'private.get_affiliate_referral_window(text)', 'private.record_affiliate_click(text, text)'];
  v_private_fns text[] := ARRAY[
    'private.affiliate_record_commission(uuid)', 'private.affiliate_void_commission_for_order(uuid, text)',
    'private.affiliate_void_order_commissions(uuid, text)',
    'private.affiliate_alert_refund_after_payout(uuid, uuid, uuid, uuid, text)',
    'private.affiliate_apply_pending_payout_work(uuid)', 'private.affiliate_on_order_change()',
    'private.affiliate_on_order_delete()', 'private.affiliate_profile_guard()', 'private.affiliate_page_guard()',
    'private.affiliate_tier_member_count()', 'private.affiliate_normalize_email(text)',
    'private.affiliate_currency_factor(text)', 'private.affiliate_refund_share(bigint, bigint, bigint, bigint, bigint)'];
  v_profile_server text[] := ARRAY['id', 'user_id', 'tier_id', 'handle', 'status', 'suspended_reason', 'avatar_object_key',
    'onboarding_step', 'stripe_connect_account_id', 'stripe_connect_livemode', 'stripe_connect_onboarding_complete',
    'stripe_connect_details_submitted', 'stripe_connect_payouts_enabled', 'stripe_connect_checked_at', 'total_clicks',
    'last_click_at', 'total_earned_cents', 'total_paid_cents', 'profile_completed_at', 'payout_configured_at',
    'page_submitted_at', 'first_published_at', 'signup_ip_masked', 'created_at', 'updated_at'];
  v_page_server text[] := ARRAY['id', 'affiliate_id', 'user_id', 'published_content', 'published_title',
    'published_meta_description', 'published_profile', 'published_featured_product_ids', 'approval_status',
    'admin_feedback_note', 'draft_version', 'draft_updated_at', 'submitted_at', 'submitted_version', 'reviewed_at',
    'reviewed_by', 'published_at', 'created_at', 'updated_at'];
  missing text; anon_x text; auth_read text; ledger_w text; account_w text; profile_cols text; page_cols text;
  self_cols text; svc_tables text; policy_dups text; stray_policies text; rpc_api text; rpc_svc text;
  rpc_public text; helper_api text; n_retry_overloads integer;
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  SELECT string_agg(m.f, ', ') INTO missing
    FROM (SELECT 'public.' || t AS f FROM unnest(v_tables) AS t WHERE to_regclass('public.' || t) IS NULL
          UNION ALL
          SELECT f FROM unnest(v_service_rpcs || v_public_rpcs || v_private_fns) AS f WHERE to_regprocedure(f) IS NULL) AS m;
  IF missing IS NOT NULL THEN
    RAISE NOTICE 'FAIL  the affiliate tables and functions exist (missing: %)', missing;
    RETURN;
  END IF;

  SELECT string_agg(format('%s:%s', t, p), ', ' ORDER BY t, p) INTO anon_x
    FROM unnest(v_tables) AS t
    CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
   WHERE NOT (t = 'affiliate_tiers' AND p = 'SELECT')
     AND CASE WHEN p IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
              THEN has_any_column_privilege('anon', ('public.' || t)::regclass, p)
              ELSE has_table_privilege('anon', ('public.' || t)::regclass, p) END;
  SELECT string_agg(t, ', ' ORDER BY t) INTO auth_read
    FROM unnest(v_tables) AS t
   WHERE has_table_privilege('authenticated', ('public.' || t)::regclass, 'SELECT')
         IS DISTINCT FROM (t NOT IN ('affiliate_click_events', 'affiliate_payout_runs'));
  SELECT string_agg(format('%s:%s', t, p), ', ' ORDER BY t, p) INTO ledger_w
    FROM unnest(ARRAY['affiliate_commissions', 'affiliate_payouts', 'affiliate_click_events', 'affiliate_payout_runs']) AS t
    CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p
   WHERE CASE WHEN p IN ('INSERT', 'UPDATE')
              THEN has_any_column_privilege('authenticated', ('public.' || t)::regclass, p)
              ELSE has_table_privilege('authenticated', ('public.' || t)::regclass, p) END;
  SELECT string_agg(format('%s:%s', t, p), ', ' ORDER BY t, p) INTO account_w
    FROM unnest(ARRAY['affiliate_profiles', 'affiliate_pages']) AS t
    CROSS JOIN unnest(ARRAY['INSERT', 'DELETE', 'UPDATE', 'TRUNCATE']) AS p
   WHERE CASE WHEN p = 'INSERT'
              THEN has_any_column_privilege('authenticated', ('public.' || t)::regclass, p)
              ELSE has_table_privilege('authenticated', ('public.' || t)::regclass, p) END;
  SELECT string_agg(c, ', ') INTO profile_cols FROM unnest(v_profile_server) AS c
   WHERE has_column_privilege('authenticated', 'public.affiliate_profiles', c, 'UPDATE');
  SELECT string_agg(c, ', ') INTO page_cols FROM unnest(v_page_server) AS c
   WHERE has_column_privilege('authenticated', 'public.affiliate_pages', c, 'UPDATE');
  SELECT string_agg(s.x, ', ') INTO self_cols
    FROM (SELECT 'affiliate_profiles.' || c AS x FROM unnest(ARRAY['display_name', 'bio', 'social_links', 'preferred_locale']) AS c
           WHERE NOT has_column_privilege('authenticated', 'public.affiliate_profiles', c, 'UPDATE')
          UNION ALL
          SELECT 'affiliate_pages.' || c FROM unnest(ARRAY['title', 'meta_description', 'draft_content', 'featured_product_ids']) AS c
           WHERE NOT has_column_privilege('authenticated', 'public.affiliate_pages', c, 'UPDATE')) AS s;
  SELECT string_agg(format('%s:%s', t, p), ', ' ORDER BY t, p) INTO svc_tables
    FROM unnest(v_tables) AS t CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p
   WHERE NOT has_table_privilege('service_role', ('public.' || t)::regclass, p);
  SELECT string_agg(format('%s %s %s (x%s)', d.tablename, d.role, d.cmd, d.n), ', ') INTO policy_dups
    FROM (SELECT p.tablename, r.role, p.cmd, count(*) AS n
            FROM pg_policies p CROSS JOIN LATERAL unnest(p.roles) AS r(role)
           WHERE p.schemaname = 'public' AND p.tablename = ANY (v_tables) AND p.permissive = 'PERMISSIVE'
           GROUP BY p.tablename, r.role, p.cmd
          HAVING count(*) > 1) AS d;
  SELECT string_agg(format('%s.%s (%s)', p.tablename, p.policyname, p.cmd), ', ' ORDER BY p.tablename, p.policyname) INTO stray_policies
    FROM pg_policies p
   WHERE p.schemaname = 'public'
     AND (p.tablename IN ('affiliate_click_events', 'affiliate_payout_runs')
          OR (p.tablename IN ('affiliate_commissions', 'affiliate_payouts') AND p.cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL'))
          OR (p.tablename IN ('affiliate_profiles', 'affiliate_pages') AND p.cmd IN ('INSERT', 'DELETE', 'ALL')));
  SELECT string_agg(format('%s to %s', f, r.role), ', ') INTO rpc_api
    FROM unnest(v_service_rpcs) AS f CROSS JOIN unnest(ARRAY['anon', 'authenticated']::name[]) AS r(role)
   WHERE has_function_privilege(r.role, to_regprocedure(f), 'EXECUTE');
  SELECT string_agg(f, ', ') INTO rpc_svc
    FROM unnest(v_service_rpcs || v_public_rpcs) AS f
   WHERE NOT has_function_privilege('service_role', to_regprocedure(f), 'EXECUTE');
  SELECT string_agg(format('%s to %s', f, r.role), ', ') INTO rpc_public
    FROM unnest(v_public_rpcs) AS f CROSS JOIN unnest(ARRAY['anon', 'authenticated']::name[]) AS r(role)
   WHERE NOT has_function_privilege(r.role, to_regprocedure(f), 'EXECUTE');
  SELECT string_agg(format('%s to %s', f, r.role), ', ') INTO helper_api
    FROM unnest(v_private_fns) AS f CROSS JOIN unnest(ARRAY['anon', 'authenticated']::name[]) AS r(role)
   WHERE has_function_privilege(r.role, to_regprocedure(f), 'EXECUTE');
  SELECT count(*) INTO n_retry_overloads
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'prepare_affiliate_payout_retry';

  RAISE NOTICE '%  anon holds no grant on a partner table but SELECT on affiliate_tiers%', CASE WHEN anon_x IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (' || anon_x || ')', '');
  RAISE NOTICE '%  authenticated reads tiers, profiles, pages, commissions and payouts (policies) and not the service-role tables%', CASE WHEN auth_read IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (wrong SELECT grant: ' || auth_read || ')', '');
  RAISE NOTICE '%  authenticated holds no INSERT/UPDATE/DELETE/TRUNCATE on commissions, payouts, click events or payout runs (A6)%', CASE WHEN ledger_w IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (' || ledger_w || ')', '');
  RAISE NOTICE '%  authenticated holds no INSERT, DELETE or table-level UPDATE on affiliate_profiles / affiliate_pages (A6)%', CASE WHEN account_w IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (' || account_w || ')', '');
  RAISE NOTICE '%  authenticated cannot UPDATE affiliate_profiles tier_id, stripe_connect_account_id, handle, status, avatar_object_key or any other server column%', CASE WHEN profile_cols IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (updatable: ' || profile_cols || ')', '');
  RAISE NOTICE '%  authenticated cannot UPDATE affiliate_pages published_content, approval_status, published_profile or any other review column%', CASE WHEN page_cols IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (updatable: ' || page_cols || ')', '');
  RAISE NOTICE '%  authenticated still UPDATEs the self-service profile and draft columns%', CASE WHEN self_cols IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (missing: ' || self_cols || ')', '');
  RAISE NOTICE '%  service_role reads and writes every affiliate table%', CASE WHEN svc_tables IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (missing: ' || svc_tables || ')', '');
  RAISE NOTICE '%  one permissive policy per role and command on the affiliate tables%', CASE WHEN policy_dups IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (' || policy_dups || ')', '');
  RAISE NOTICE '%  no policy on the click log or payout runs, no write policy on the ledger, no INSERT/DELETE policy on partner accounts%', CASE WHEN stray_policies IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (' || stray_policies || ')', '');
  RAISE NOTICE '%  anon / authenticated cannot EXECUTE any service-role affiliate RPC%', CASE WHEN rpc_api IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (' || rpc_api || ')', '');
  RAISE NOTICE '%  service_role can EXECUTE every affiliate RPC%', CASE WHEN rpc_svc IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (missing: ' || rpc_svc || ')', '');
  RAISE NOTICE '%  anon and authenticated can EXECUTE the four storefront RPCs and their private definers%', CASE WHEN rpc_public IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (missing: ' || rpc_public || ')', '');
  RAISE NOTICE '%  anon / authenticated cannot EXECUTE the private ledger helpers and affiliate trigger functions%', CASE WHEN helper_api IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (' || helper_api || ')', '');
  RAISE NOTICE '%  prepare_affiliate_payout_retry has one overload (uuid, bigint), so a one-argument call resolves (no PGRST203)%', CASE WHEN n_retry_overloads = 1 THEN 'PASS' ELSE 'FAIL' END,
    CASE WHEN n_retry_overloads = 1 THEN '' ELSE format(' (%s overloads)', n_retry_overloads) END;
END $$;

-- 36. affiliates (02030): sign-up and the Data API seats. create_affiliate_account() as the
--     service role (tier choice and spots, role RTL, the starter page, its error codes), then
--     each seat: a partner (RTL) reads and edits only its own self-service columns and draft,
--     the column grants and the guards refuse everything else, and the anonymous storefront
--     reads return only an ACTIVE, approved partner's approved snapshot.
RESET ROLE;
DO $$
DECLARE
  v_rtl1 uuid := 'aa000000-0000-0000-0000-00000000af01';
  v_rtl2 uuid := 'aa000000-0000-0000-0000-00000000af02';
  v_rtl3 uuid := 'aa000000-0000-0000-0000-00000000af03';
  v_user4 uuid := 'aa000000-0000-0000-0000-00000000af04';
  v_writer uuid := 'aa000000-0000-0000-0000-0000000000f1';
  v_doc jsonb := '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"SV storefront"}]}]}';
  v_snapshot jsonb := '{"display_name":"SV Partner One","bio":null,"avatar_object_key":null,"social_links":{}}';
  v_hash1 text := '0123456789abcdef0123456789abcdef';
  v_hash2 text := 'fedcba9876543210';
  r record; n integer; tbl text;
  v_expected_tier uuid; v_cap integer; v_members integer;
  signup_ok boolean := false; account_ok boolean := false; v_role text;
  err_exists text; err_role text; err_handle text; err_dup text; errors_ok boolean;
  v_step text; own_profiles integer; own_pages integer; self_edit boolean;
  tier_denied boolean := false; status_denied boolean := false; handle_denied boolean := false; ins_denied boolean := false;
  draft_edit boolean; v_version integer; v_page_status text; approve_denied boolean := false; publish_denied boolean := false;
  other_read integer; other_edit boolean; pending_rls boolean; pending_guard boolean := false;
  guard_profile boolean := false; guard_page boolean := false;
  profile_pending boolean := false; links_pending boolean := false; locale_pending boolean; server_pending boolean;
  n_tiers integer; n_retired integer; readable text;
  n_one integer; content_ok boolean; snapshot_ok boolean; n_two integer; n_three integer; n_bad integer; v_listed text[];
  window_one integer; window_two integer; window_three integer; v_cookie_days integer;
  v_clicks integer; v_events integer;
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  IF to_regclass('public.affiliate_profiles') IS NULL
     OR to_regprocedure('public.create_affiliate_account(uuid, text, text, text, text, text, jsonb, text)') IS NULL THEN
    RAISE NOTICE 'FAIL  affiliate_profiles and create_affiliate_account(uuid, text, text, text, text, text, jsonb, text) exist';
    RETURN;
  END IF;

  -- fixtures (as the table owner): three partner accounts, a spare shopper, a retired tier
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  VALUES
    (v_rtl1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sv.partner@gmail.com', 'x', now(), now(), '{}', '{"full_name":"SV Partner One"}'),
    (v_rtl2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sv-partner2@test.local', 'x', now(), now(), '{}', '{"full_name":"SV Partner Two"}'),
    (v_rtl3, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sv-partner3@test.local', 'x', now(), now(), '{}', '{"full_name":"SV Partner Three"}'),
    (v_user4, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sv-shopper4@test.local', 'x', now(), now(), '{}', '{"full_name":"SV Shopper"}')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.affiliate_tiers (name, slug, commission_percentage, sort_order, is_active, badge_color)
  VALUES ('SV Retired', 'sv-retired-tier', 5, 99, false, 'rose')
  ON CONFLICT (slug) DO NOTHING;
  -- where the first sign-up must land: the function's ordering, first active tier with room
  SELECT t.id, t.max_ambassadors_cap, t.member_count INTO v_expected_tier, v_cap, v_members
    FROM public.affiliate_tiers t
   WHERE t.is_active AND (t.max_ambassadors_cap IS NULL OR t.member_count < t.max_ambassadors_cap)
   ORDER BY t.is_default_signup_tier DESC, CASE WHEN t.is_default_signup_tier THEN -t.sort_order ELSE t.sort_order END, t.created_at
   LIMIT 1;

  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  SELECT * INTO r FROM public.create_affiliate_account(v_rtl1, ' SV-Partner-One ', 'SV Partner One', 'fr-CA', 'SV picks',
                                                         'SV meta description', v_doc, '203.0.113.0/24');
  signup_ok := r.tier_id = v_expected_tier AND r.affiliate_id IS NOT NULL AND r.page_id IS NOT NULL
    AND r.spots_remaining IS NOT DISTINCT FROM (CASE WHEN v_cap IS NULL THEN NULL ELSE v_cap - v_members - 1 END);
  SELECT pr.role::text INTO v_role FROM public.profiles pr WHERE pr.id = v_rtl1;
  SELECT count(*) INTO n
    FROM public.affiliate_profiles p
    JOIN public.affiliate_pages pg ON pg.affiliate_id = p.id AND pg.user_id = p.user_id
   WHERE p.user_id = v_rtl1 AND p.id = r.affiliate_id AND pg.id = r.page_id
     AND p.handle = 'sv-partner-one' AND p.preferred_locale = 'fr' AND p.status::text = 'ACTIVE'
     AND p.signup_ip_masked = '203.0.113.0/24' AND pg.draft_content = v_doc AND pg.title = 'SV picks'
     AND pg.approval_status::text = 'DRAFT';
  account_ok := v_role = 'RTL' AND n = 1;
  PERFORM public.create_affiliate_account(v_rtl2, 'sv-partner-two', 'SV Partner Two', 'en', '', '', NULL, NULL);
  PERFORM public.create_affiliate_account(v_rtl3, 'sv-partner-three', 'SV Partner Three', 'en', 'SV three', '', v_doc, NULL);
  BEGIN
    PERFORM public.create_affiliate_account(v_rtl1, 'sv-partner-uno', 'SV Partner One', 'en', '', '', NULL, NULL);
  EXCEPTION WHEN raise_exception THEN err_exists := SQLERRM;
  END;
  BEGIN
    PERFORM public.create_affiliate_account(v_writer, 'sv-writer-shop', 'SV Writer', 'en', '', '', NULL, NULL);
  EXCEPTION WHEN raise_exception THEN err_role := SQLERRM;
  END;
  BEGIN
    PERFORM public.create_affiliate_account(v_user4, 'Not A Handle!', 'SV Shopper', 'en', '', '', NULL, NULL);
  EXCEPTION WHEN raise_exception THEN err_handle := SQLERRM;
  END;
  BEGIN
    PERFORM public.create_affiliate_account(v_user4, 'sv-partner-two', 'SV Shopper', 'en', '', '', NULL, NULL);
  EXCEPTION WHEN unique_violation THEN err_dup := SQLSTATE;
  END;
  errors_ok := err_exists = 'affiliate_exists' AND err_role = 'affiliate_role_conflict'
    AND err_handle = 'affiliate_handle_invalid' AND err_dup = '23505';

  -- the review flow's writes (as the table owner): partner one approved and live, three
  -- approved, live and then suspended, two never published
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  UPDATE public.affiliate_profiles
     SET page_submitted_at = now() - interval '3 days', first_published_at = now() - interval '2 days'
   WHERE user_id = v_rtl1;
  UPDATE public.affiliate_pages
     SET published_content = v_doc, published_title = 'SV picks', published_meta_description = 'SV meta description',
         published_profile = v_snapshot, approval_status = 'PUBLISHED', published_at = now() - interval '1 day',
         reviewed_at = now() - interval '1 day'
   WHERE user_id = v_rtl1;
  UPDATE public.affiliate_profiles
     SET first_published_at = now() - interval '2 days', status = 'SUSPENDED', suspended_reason = 'SV posture'
   WHERE user_id = v_rtl3;
  UPDATE public.affiliate_pages SET published_content = v_doc, approval_status = 'PUBLISHED', published_at = now() WHERE user_id = v_rtl3;
  SELECT p.onboarding_step::text INTO v_step FROM public.affiliate_profiles p WHERE p.user_id = v_rtl1;

  -- partner one's own session
  PERFORM set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated","aal":"aal1"}', v_rtl1), true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO own_profiles FROM public.affiliate_profiles;
  SELECT count(*) INTO own_pages FROM public.affiliate_pages;
  UPDATE public.affiliate_profiles SET display_name = 'SV Partner Uno', bio = 'SV partner bio' WHERE user_id = v_rtl1;
  self_edit := FOUND;
  BEGIN
    UPDATE public.affiliate_profiles SET tier_id = tier_id WHERE user_id = v_rtl1;
  EXCEPTION WHEN insufficient_privilege THEN tier_denied := SQLERRM LIKE 'permission denied%';
  END;
  BEGIN
    UPDATE public.affiliate_profiles SET status = 'ACTIVE' WHERE user_id = v_rtl1;
  EXCEPTION WHEN insufficient_privilege THEN status_denied := SQLERRM LIKE 'permission denied%';
  END;
  BEGIN
    UPDATE public.affiliate_profiles SET handle = 'sv-hijacked' WHERE user_id = v_rtl1;
  EXCEPTION WHEN insufficient_privilege THEN handle_denied := SQLERRM LIKE 'permission denied%';
  END;
  BEGIN
    INSERT INTO public.affiliate_commissions (affiliate_id, gateway, order_currency, order_net_amount_minor,
                                              net_order_amount_cents, commission_rate_snapshot, commission_amount_cents)
    SELECT p.id, 'STRIPE', 'USD', 100000, 100000, 50, 50000 FROM public.affiliate_profiles p WHERE p.user_id = v_rtl1;
  EXCEPTION WHEN insufficient_privilege THEN ins_denied := SQLERRM LIKE 'permission denied%';
  END;
  UPDATE public.affiliate_pages SET draft_content = '{"type":"doc","content":[]}'::jsonb WHERE user_id = v_rtl1;
  draft_edit := FOUND;
  SELECT pg.draft_version, pg.approval_status::text INTO v_version, v_page_status FROM public.affiliate_pages pg WHERE pg.user_id = v_rtl1;
  BEGIN
    UPDATE public.affiliate_pages SET approval_status = 'PUBLISHED' WHERE user_id = v_rtl1;
  EXCEPTION WHEN insufficient_privilege THEN approve_denied := SQLERRM LIKE 'permission denied%';
  END;
  BEGIN
    UPDATE public.affiliate_pages SET published_content = draft_content WHERE user_id = v_rtl1;
  EXCEPTION WHEN insufficient_privilege THEN publish_denied := SQLERRM LIKE 'permission denied%';
  END;

  -- partner two's session against partner one's page
  PERFORM set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated","aal":"aal1"}', v_rtl2), true);
  SELECT count(*) INTO other_read FROM public.affiliate_pages WHERE user_id = v_rtl1;
  UPDATE public.affiliate_pages SET title = 'SV hijack' WHERE user_id = v_rtl1;
  other_edit := FOUND;

  -- submitted for review: nobody edits the draft until it is withdrawn
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  UPDATE public.affiliate_pages
     SET approval_status = 'PENDING_REVIEW', submitted_at = now(), submitted_version = draft_version
   WHERE user_id = v_rtl1;
  PERFORM set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated","aal":"aal1"}', v_rtl1), true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  UPDATE public.affiliate_pages SET title = 'SV while pending' WHERE user_id = v_rtl1;
  pending_rls := NOT FOUND;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  BEGIN
    UPDATE public.affiliate_pages SET title = 'SV while pending' WHERE user_id = v_rtl1;
  EXCEPTION WHEN object_not_in_prerequisite_state THEN pending_guard := SQLERRM = 'affiliate_page_pending_review';
  END;
  -- the guards behind the grants: table rights (service role) but a partner's session
  PERFORM set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated","aal":"aal1"}', v_rtl1), true);
  BEGIN
    UPDATE public.affiliate_profiles SET total_earned_cents = total_earned_cents + 100000 WHERE user_id = v_rtl1;
  EXCEPTION WHEN insufficient_privilege THEN guard_profile := SQLERRM = 'affiliate_profile_field_protected';
  END;
  BEGIN
    UPDATE public.affiliate_pages SET approval_status = 'PUBLISHED' WHERE user_id = v_rtl1;
  EXCEPTION WHEN insufficient_privilege THEN guard_page := SQLERRM = 'affiliate_page_field_protected';
  END;
  -- the review lock covers the profile Approve snapshots too (finding A): the partner's own
  -- session cannot rewrite its name, bio or links over the Data API while the page waits; the
  -- e-mail language stays writable, and a server write (no session) is left to the app
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    UPDATE public.affiliate_profiles SET bio = 'SV unreviewed bio' WHERE user_id = v_rtl1;
  EXCEPTION WHEN object_not_in_prerequisite_state THEN profile_pending := SQLERRM = 'affiliate_profile_pending_review';
  END;
  BEGIN
    UPDATE public.affiliate_profiles SET social_links = '{"website":"https://sv-unreviewed.example"}'::jsonb WHERE user_id = v_rtl1;
  EXCEPTION WHEN object_not_in_prerequisite_state THEN links_pending := SQLERRM = 'affiliate_profile_pending_review';
  END;
  UPDATE public.affiliate_profiles SET preferred_locale = 'en' WHERE user_id = v_rtl1;
  locale_pending := FOUND;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  UPDATE public.affiliate_profiles SET bio = 'SV partner bio, saved by the server' WHERE user_id = v_rtl1;
  server_pending := FOUND;

  -- the public key
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  EXECUTE 'SET LOCAL ROLE anon';
  SELECT count(*) INTO n_tiers FROM public.affiliate_tiers
   WHERE slug IN ('starter-partner', 'growth-partner', 'elite-partner', 'founding-ambassador');
  SELECT count(*) INTO n_retired FROM public.affiliate_tiers WHERE slug = 'sv-retired-tier';
  FOREACH tbl IN ARRAY ARRAY['affiliate_profiles', 'affiliate_pages', 'affiliate_commissions', 'affiliate_payouts'] LOOP
    BEGIN
      EXECUTE format('SELECT count(*) FROM public.%I', tbl) INTO n;
      readable := concat_ws(', ', readable, tbl);
    EXCEPTION WHEN insufficient_privilege THEN
      IF SQLERRM NOT LIKE 'permission denied%' THEN readable := concat_ws(', ', readable, tbl); END IF;
    END;
  END LOOP;
  SELECT count(*), bool_and(s.published_content = v_doc AND s.handle = 'sv-partner-one'), bool_and(s.published_profile = v_snapshot)
    INTO n_one, content_ok, snapshot_ok
    FROM public.get_affiliate_storefront('SV-Partner-One') AS s;
  SELECT count(*) INTO n_two FROM public.get_affiliate_storefront('sv-partner-two') AS s;
  SELECT count(*) INTO n_three FROM public.get_affiliate_storefront('sv-partner-three') AS s;
  SELECT count(*) INTO n_bad FROM public.get_affiliate_storefront('../sv-partner-one') AS s;
  SELECT array_agg(s.handle ORDER BY s.handle) INTO v_listed FROM public.list_affiliate_storefronts(5000) AS s;
  window_one := public.get_affiliate_referral_window('sv-partner-one');
  window_two := public.get_affiliate_referral_window('sv-partner-two');
  window_three := public.get_affiliate_referral_window('sv-partner-three');
  PERFORM public.record_affiliate_click('sv-partner-one', v_hash1);
  PERFORM public.record_affiliate_click('SV-PARTNER-ONE', v_hash1);  -- the same visitor again
  PERFORM public.record_affiliate_click('sv-partner-one', v_hash2);  -- a second visitor
  PERFORM public.record_affiliate_click('sv-partner-one', 'not-a-visitor-hash');
  PERFORM public.record_affiliate_click('sv-partner-three', v_hash1); -- suspended
  PERFORM public.record_affiliate_click('sv-partner-two', v_hash1);   -- not approved yet

  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  SELECT p.total_clicks INTO v_clicks FROM public.affiliate_profiles p WHERE p.user_id = v_rtl1;
  SELECT count(*) INTO v_events
    FROM public.affiliate_click_events e JOIN public.affiliate_profiles p ON p.id = e.affiliate_id
   WHERE p.user_id IN (v_rtl1, v_rtl2, v_rtl3);
  SELECT t.cookie_duration_days INTO v_cookie_days
    FROM public.affiliate_tiers t JOIN public.affiliate_profiles p ON p.tier_id = t.id WHERE p.user_id = v_rtl1;

  RAISE NOTICE '%  create_affiliate_account puts the first partner in the expected sign-up tier and reports its spots left', CASE WHEN signup_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  the new account is RTL and owns one DRAFT page with the starter document, normalised handle and locale', CASE WHEN account_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  create_affiliate_account refuses an existing partner, a staff role, a malformed handle and a taken handle (23505)%', CASE WHEN errors_ok THEN 'PASS' ELSE 'FAIL' END,
    CASE WHEN errors_ok THEN '' ELSE format(' (got %s / %s / %s / %s)', coalesce(err_exists, '-'), coalesce(err_role, '-'), coalesce(err_handle, '-'), coalesce(err_dup, '-')) END;
  RAISE NOTICE '%  the profile guard derives onboarding_step from the lifecycle timestamps (ACTIVE_PUBLISHED)', CASE WHEN v_step = 'ACTIVE_PUBLISHED' THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  a partner reads only its own profile and page', CASE WHEN own_profiles = 1 AND own_pages = 1 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  a partner edits its own display name and bio over the Data API', CASE WHEN self_edit THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  a partner cannot change its tier, status or handle (refused by the column grant)', CASE WHEN tier_denied AND status_denied AND handle_denied THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  a partner cannot insert a commission (refused by the grant)', CASE WHEN ins_denied THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  a partner edits its own draft: draft_version + 1 and PUBLISHED back to DRAFT', CASE WHEN draft_edit AND v_version = 2 AND v_page_status = 'DRAFT' THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  a partner cannot approve or publish its own page (refused by the column grant)', CASE WHEN approve_denied AND publish_denied THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  another partner can neither read nor edit that page', CASE WHEN other_read = 0 AND NOT other_edit THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  while PENDING_REVIEW the partner''s draft update matches no row (RLS)', CASE WHEN pending_rls THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  the page guard refuses a draft edit while PENDING_REVIEW, service role included (55000)', CASE WHEN pending_guard THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  the guards refuse protected profile and page fields from a non-admin session even with table rights', CASE WHEN guard_profile AND guard_page THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  while PENDING_REVIEW the profile guard refuses the partner''s bio and links edits (55000); preferred_locale and server writes still go through', CASE WHEN profile_pending AND links_pending AND locale_pending AND server_pending THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  anon reads the active tier ladder but not a retired tier', CASE WHEN n_tiers = 4 AND n_retired = 0 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  anon reads of affiliate_profiles / pages / commissions / payouts are refused by the grant%', CASE WHEN readable IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (still readable: ' || readable || ')', '');
  RAISE NOTICE '%  get_affiliate_storefront returns the approved document and profile snapshot of an ACTIVE, approved partner', CASE WHEN n_one = 1 AND content_ok AND snapshot_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  the storefront reads hide a suspended partner, a never-published page and a malformed handle', CASE WHEN n_two = 0 AND n_three = 0 AND n_bad = 0
    AND v_listed @> ARRAY['sv-partner-one'] AND NOT (v_listed && ARRAY['sv-partner-two', 'sv-partner-three']) THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  get_affiliate_referral_window gives an approved partner its tier''s cookie days, NULL otherwise', CASE WHEN window_one = v_cookie_days AND window_two IS NULL AND window_three IS NULL THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  record_affiliate_click counts one click per visitor per day and ignores malformed, suspended and unapproved input%', CASE WHEN v_clicks = 2 AND v_events = 2 THEN 'PASS' ELSE 'FAIL' END,
    CASE WHEN v_clicks = 2 AND v_events = 2 THEN '' ELSE format(' (total_clicks %s, events %s)', v_clicks, v_events) END;
END $$;

-- 37. affiliates (02030): the commission ledger. The orders trigger records exactly one
--     commission when paid_at is set (base currency, subtotal minus discount, the tier's rate and
--     clearance hold) and voids it when the order is refunded; self-referrals earn nothing;
--     foreign currencies convert; apply_affiliate_refund adjusts monotonically on the charge
--     without its shipping share (the fixtures pass the real charge: USD 90 of goods, 10 of
--     shipping, 13 of tax), voids, alerts and leaves a tombstone; payouts go claim -> complete and
--     fail -> retry -> release, and a void requested while a payout was in flight is applied when
--     that payout fails. The fixture orders were paid in test mode, like the Connect account.
RESET ROLE;
DO $$
DECLARE
  v_rtl1 uuid := 'aa000000-0000-0000-0000-00000000af01';
  v_cust uuid := 'aa000000-0000-0000-0000-00000000cc01';
  v_o1 uuid := 'aa000000-0000-0000-0000-00000000b101';
  v_o2 uuid := 'aa000000-0000-0000-0000-00000000b102';
  v_o3 uuid := 'aa000000-0000-0000-0000-00000000b103';
  v_o4 uuid := 'aa000000-0000-0000-0000-00000000b104';
  v_o5 uuid := 'aa000000-0000-0000-0000-00000000b105';
  v_o6 uuid := 'aa000000-0000-0000-0000-00000000b106';
  v_o7 uuid := 'aa000000-0000-0000-0000-00000000b107';
  v_o8 uuid := 'aa000000-0000-0000-0000-00000000b108';
  v_o9 uuid := 'aa000000-0000-0000-0000-00000000b109';
  v_o9j uuid := 'aa000000-0000-0000-0000-00000000b10f';
  r record; n integer; n2 integer;
  v_aff uuid; v_pct numeric; v_hold integer; v_expected bigint; v_amount bigint; v_amount2 bigint;
  v_earned0 bigint; v_earned1 bigint; v_earned2 bigint; v_paid0 bigint; v_paid1 bigint;
  v_c_status text; v_c_currency text; v_c_gateway text; v_clears_ok boolean; v_reason text; v_refunded bigint; v_pending bigint;
  v_net9 bigint; v_comm9 bigint; v_ocur9 text; v_cur9 text; v_rate9 numeric; v_net9j bigint; v_comm9j bigint;
  res1 text; res2 text; res3 text; res4 text;
  recorded_ok boolean := false; earned_ok boolean := false; void_ok boolean := false; self_ok boolean := false;
  fx_ok boolean := false; partial_ok boolean := false; full_ok boolean := false; tomb_ok boolean := false;
  promote_n integer; promote_ok boolean := false; claim_ok boolean := false; alerted_ok boolean := false; complete_ok boolean := false;
  v_payout uuid; done1 boolean; done2 boolean; v_transfer text; v_p_status text; v_p_paid boolean;
  v_payout2 uuid; f1 boolean; f2 boolean; rel boolean; done3 boolean; v_fail_status text; v_fail_reason text;
  v_attempt integer; v_retry_status text; v_rel_reason text; v_c7_status text; v_c7_payout uuid; cycle_ok boolean := false;
  v_payout3 uuid; v_c8 uuid; v_flagged boolean; v_c8_before text; f3 boolean; v_c8_status text; v_c8_payout uuid;
  retry3 integer; v_reason3 text; pending_ok boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  IF to_regclass('public.affiliate_profiles') IS NULL THEN
    RAISE NOTICE 'FAIL  affiliate_profiles exists';
    RETURN;
  END IF;
  SELECT p.id INTO v_aff FROM public.affiliate_profiles p WHERE p.user_id = v_rtl1;
  IF v_aff IS NULL THEN
    RAISE NOTICE 'FAIL  the section 36 partner exists';
    RETURN;
  END IF;
  SELECT t.commission_percentage, t.clearance_hold_days INTO v_pct, v_hold
    FROM public.affiliate_tiers t JOIN public.affiliate_profiles p ON p.tier_id = t.id
   WHERE p.id = v_aff;
  v_expected := round(9000 * v_pct / 100);

  -- fixtures (as the table owner): partner one is onboarded to Connect with a test-mode account;
  -- attributed orders paid in test mode (affiliate_livemode false, as a Stripe test key writes)
  UPDATE public.affiliate_profiles
     SET stripe_connect_account_id = 'acct_svposture1', stripe_connect_livemode = false,
         stripe_connect_onboarding_complete = true, payout_configured_at = now()
   WHERE id = v_aff;
  INSERT INTO public.orders (id, user_id, status, total, subtotal, discount_total, shipping_total, tax_total, currency, provider,
                             customer_details, affiliate_id, affiliate_source, affiliate_base_currency, exchange_rate_at_purchase,
                             affiliate_livemode)
  VALUES
    (v_o1, v_cust, 'paid', 11300, 10000, 1000, 1000, 1300, 'USD', 'stripe', '{"email":"sv-customer@test.local"}', v_aff, 'storefront', 'USD', 1, false),
    (v_o2, NULL, 'paid', 11300, 10000, 1000, 1000, 1300, 'USD', 'stripe', '{"email":" SVPartner+deal@GoogleMail.com"}', v_aff, 'referral_link', 'USD', 1, false),
    (v_o3, v_rtl1, 'paid', 11300, 10000, 1000, 1000, 1300, 'USD', 'stripe', '{"email":"sv-elsewhere@test.local"}', v_aff, 'referral_link', 'USD', 1, false),
    (v_o4, v_cust, 'paid', 11300, 10000, 1000, 1000, 1300, 'USD', 'stripe', '{"email":"sv-customer@test.local"}', v_aff, 'storefront', 'USD', 1, false),
    (v_o5, v_cust, 'pending', 11300, 10000, 1000, 1000, 1300, 'USD', 'freemius', '{"email":"sv-customer@test.local"}', v_aff, 'storefront', 'USD', 1, false),
    (v_o6, v_cust, 'paid', 11300, 10000, 1000, 1000, 1300, 'USD', 'stripe', '{"email":"sv-customer@test.local"}', v_aff, 'storefront', 'USD', 1, false),
    (v_o7, v_cust, 'paid', 11300, 10000, 1000, 1000, 1300, 'USD', 'stripe', '{"email":"sv-customer@test.local"}', v_aff, 'storefront', 'USD', 1, false),
    (v_o8, v_cust, 'paid', 11300, 10000, 1000, 1000, 1300, 'USD', 'stripe', '{"email":"sv-customer@test.local"}', v_aff, 'storefront', 'USD', 1, false),
    (v_o9, v_cust, 'paid', 9000, 9000, 0, 0, 0, 'EUR', 'stripe', '{"email":"sv-customer@test.local"}', v_aff, 'storefront', 'USD', 0.9, false),
    (v_o9j, v_cust, 'paid', 1000, 1000, 0, 0, 0, 'JPY', 'stripe', '{"email":"sv-customer@test.local"}', v_aff, 'storefront', 'USD', 150, false)
  ON CONFLICT (id) DO NOTHING;

  -- every "mark paid" path ends in assign_order_invoice_metadata(), called by the service role
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  SELECT p.total_earned_cents INTO v_earned0 FROM public.affiliate_profiles p WHERE p.id = v_aff;
  PERFORM public.assign_order_invoice_metadata(v_o1, now());
  PERFORM public.assign_order_invoice_metadata(v_o1, now());  -- a second "mark paid" keeps paid_at
  UPDATE public.orders SET status = 'shipped' WHERE id = v_o1;
  SELECT count(*), max(c.commission_amount_cents), max(c.status::text), max(c.currency), max(c.gateway::text),
         bool_and(c.clears_at BETWEEN now() + make_interval(days => v_hold) - interval '1 minute'
                                  AND now() + make_interval(days => v_hold) + interval '1 minute')
    INTO n, v_amount, v_c_status, v_c_currency, v_c_gateway, v_clears_ok
    FROM public.affiliate_commissions c WHERE c.order_id = v_o1;
  recorded_ok := n = 1 AND v_amount = v_expected AND v_c_status = 'PENDING_CLEARANCE' AND v_c_currency = 'USD'
    AND v_c_gateway = 'STRIPE' AND v_clears_ok;
  SELECT p.total_earned_cents INTO v_earned1 FROM public.affiliate_profiles p WHERE p.id = v_aff;
  earned_ok := v_earned1 = v_earned0 + v_expected;
  UPDATE public.orders SET status = 'refunded' WHERE id = v_o1;
  SELECT c.status::text, c.void_reason INTO v_c_status, v_reason FROM public.affiliate_commissions c WHERE c.order_id = v_o1;
  SELECT p.total_earned_cents INTO v_earned2 FROM public.affiliate_profiles p WHERE p.id = v_aff;
  void_ok := v_c_status = 'VOIDED_REFUND' AND v_reason = 'refunded' AND v_earned2 = v_earned0;

  -- self-referral: the partner's own account, and the same mailbox behind +tag / googlemail / dots
  PERFORM public.assign_order_invoice_metadata(v_o2, now());
  PERFORM public.assign_order_invoice_metadata(v_o3, now());
  SELECT count(*) INTO n FROM public.affiliate_commissions c WHERE c.order_id IN (v_o2, v_o3);
  self_ok := n = 0;

  -- EUR 90.00 at 0.9 per USD is USD 100.00; JPY 1000 (no minor unit) at 150 is USD 6.67
  PERFORM public.assign_order_invoice_metadata(v_o9, now());
  PERFORM public.assign_order_invoice_metadata(v_o9j, now());
  SELECT c.net_order_amount_cents, c.commission_amount_cents, c.order_currency, c.currency, c.exchange_rate_snapshot
    INTO v_net9, v_comm9, v_ocur9, v_cur9, v_rate9
    FROM public.affiliate_commissions c WHERE c.order_id = v_o9;
  SELECT c.net_order_amount_cents, c.commission_amount_cents INTO v_net9j, v_comm9j
    FROM public.affiliate_commissions c WHERE c.order_id = v_o9j;
  fx_ok := v_net9 = 10000 AND v_comm9 = round(10000 * v_pct / 100) AND v_ocur9 = 'EUR' AND v_cur9 = 'USD' AND v_rate9 = 0.9
    AND v_net9j = 667 AND v_comm9j = round(667 * v_pct / 100);

  -- partial refunds are pro rata on the charge without its shipping share (finding I: 2575 of
  -- 11300 is a quarter of the goods and their tax) and monotonic; refunding everything but the
  -- shipping takes the whole commission, and the shipping refund after it changes nothing
  PERFORM public.assign_order_invoice_metadata(v_o4, now());
  SELECT c.commission_amount_cents INTO v_amount FROM public.affiliate_commissions c WHERE c.order_id = v_o4;
  SELECT p.total_earned_cents INTO v_earned0 FROM public.affiliate_profiles p WHERE p.id = v_aff;
  res1 := public.apply_affiliate_refund('STRIPE', v_o4, 2575, 11300, false);
  res2 := public.apply_affiliate_refund('STRIPE', v_o4, 1000, 11300, false);  -- an older, smaller event
  SELECT c.refunded_amount_cents INTO v_refunded FROM public.affiliate_commissions c WHERE c.order_id = v_o4;
  SELECT p.total_earned_cents INTO v_earned1 FROM public.affiliate_profiles p WHERE p.id = v_aff;
  partial_ok := res1 = 'adjusted' AND res2 = 'none' AND v_refunded = round(v_amount * 0.25) AND v_earned1 = v_earned0 - v_refunded;
  res3 := public.apply_affiliate_refund('STRIPE', v_o4, 10300, 11300, false);
  SELECT c.status::text INTO v_c_status FROM public.affiliate_commissions c WHERE c.order_id = v_o4;
  SELECT p.total_earned_cents INTO v_earned2 FROM public.affiliate_profiles p WHERE p.id = v_aff;
  res4 := public.apply_affiliate_refund('STRIPE', v_o4, 11300, 11300, false);
  full_ok := res3 = 'voided' AND v_c_status = 'VOIDED_REFUND' AND v_earned2 = v_earned0 - v_amount AND res4 = 'none';

  -- refunded before it was ever paid: a tombstone the paid trigger cannot overwrite
  res1 := public.apply_affiliate_refund('FREEMIUS', v_o5, 11300, 11300, true);
  SELECT count(*), max(c.status::text), max(c.void_reason), max(c.commission_amount_cents)
    INTO n, v_c_status, v_reason, v_amount2
    FROM public.affiliate_commissions c WHERE c.order_id = v_o5;
  UPDATE public.orders SET status = 'paid' WHERE id = v_o5;
  PERFORM public.assign_order_invoice_metadata(v_o5, now());
  SELECT count(*) INTO n2 FROM public.affiliate_commissions c WHERE c.order_id = v_o5;
  tomb_ok := res1 = 'voided' AND n = 1 AND v_c_status = 'VOIDED_REFUND' AND v_reason = 'refunded_before_commission'
    AND v_amount2 = 0 AND n2 = 1;

  -- clearance, claim, a refund while the transfer is in flight, completion
  PERFORM public.assign_order_invoice_metadata(v_o6, now());
  UPDATE public.affiliate_commissions SET clears_at = now() - interval '1 minute' WHERE order_id = v_o6;
  promote_n := public.promote_cleared_affiliate_commissions();
  SELECT c.status::text, c.commission_amount_cents INTO v_c_status, v_amount FROM public.affiliate_commissions c WHERE c.order_id = v_o6;
  promote_ok := promote_n >= 1 AND v_c_status = 'CLEARED';
  SELECT p.id, p.status::text AS status, p.amount_cents, p.stripe_destination_account, p.trigger, p.attempt_count
    INTO r
    FROM public.claim_affiliate_payout(v_aff, 'usd', 1, 'admin') AS p;
  v_payout := r.id;
  SELECT count(*) INTO n FROM public.affiliate_commissions c WHERE c.payout_id = v_payout AND c.order_id = v_o6;
  SELECT count(*) INTO n2 FROM public.affiliate_commissions c WHERE c.payout_id = v_payout;
  claim_ok := v_payout IS NOT NULL AND r.status = 'PROCESSING' AND r.amount_cents = v_amount
    AND r.stripe_destination_account = 'acct_svposture1' AND r.trigger = 'admin' AND r.attempt_count = 1 AND n = 1 AND n2 = 1;
  res1 := public.apply_affiliate_refund('STRIPE', v_o6, 2575, 11300, false);
  res2 := public.apply_affiliate_refund('STRIPE', v_o6, 5150, 11300, false);
  SELECT c.refund_pending_cents, c.refunded_amount_cents INTO v_pending, v_refunded FROM public.affiliate_commissions c WHERE c.order_id = v_o6;
  SELECT count(*) INTO n
    FROM public.system_alerts a
   WHERE a.alert_type = 'affiliate_refund_after_payout' AND NOT a.is_resolved
     AND a.metadata ->> 'order_id' = v_o6::text
     AND a.title = 'Refund after an affiliate payout' AND a.message LIKE 'Order % was refunded after its commission was paid or queued.%'
     AND a.metadata ->> 'action_url' = '/cms/affiliates/payouts' AND a.metadata ->> 'action_label' = 'Review payouts';
  alerted_ok := res1 = 'alerted' AND res2 = 'alerted' AND v_pending = round(v_amount * 0.5) AND v_refunded = 0 AND n = 1;
  SELECT p.total_paid_cents INTO v_paid0 FROM public.affiliate_profiles p WHERE p.id = v_aff;
  done1 := public.complete_affiliate_payout(v_payout, 'tr_svposture_0001');
  done2 := public.complete_affiliate_payout(v_payout, 'tr_svposture_0001');
  SELECT c.status::text, c.stripe_transfer_id INTO v_c_status, v_transfer FROM public.affiliate_commissions c WHERE c.order_id = v_o6;
  SELECT po.status::text, po.paid_at IS NOT NULL INTO v_p_status, v_p_paid FROM public.affiliate_payouts po WHERE po.id = v_payout;
  SELECT p.total_paid_cents INTO v_paid1 FROM public.affiliate_profiles p WHERE p.id = v_aff;
  complete_ok := done1 AND NOT done2 AND v_c_status = 'PAID' AND v_transfer = 'tr_svposture_0001'
    AND v_p_status = 'COMPLETED' AND v_p_paid AND v_paid1 = v_paid0 + v_amount;

  -- a failed transfer: fail, retry (attempt 2), fail again
  PERFORM public.assign_order_invoice_metadata(v_o7, now());
  UPDATE public.affiliate_commissions SET clears_at = now() - interval '1 minute' WHERE order_id = v_o7;
  PERFORM public.promote_cleared_affiliate_commissions();
  SELECT p.id INTO v_payout2 FROM public.claim_affiliate_payout(v_aff, 'USD', 1, 'cron') AS p;
  f1 := public.fail_affiliate_payout(v_payout2, 'balance_insufficient');
  SELECT po.status::text, po.failure_reason INTO v_fail_status, v_fail_reason FROM public.affiliate_payouts po WHERE po.id = v_payout2;
  SELECT p.attempt_count, p.status::text INTO v_attempt, v_retry_status FROM public.prepare_affiliate_payout_retry(v_payout2) AS p;
  f2 := public.fail_affiliate_payout(v_payout2, 'balance_insufficient');

  -- a full refund while another payout is in flight: flagged, then applied when it fails
  PERFORM public.assign_order_invoice_metadata(v_o8, now());
  UPDATE public.affiliate_commissions SET clears_at = now() - interval '1 minute' WHERE order_id = v_o8;
  PERFORM public.promote_cleared_affiliate_commissions();
  SELECT p.id INTO v_payout3 FROM public.claim_affiliate_payout(v_aff, 'USD', 1, 'cron') AS p;
  SELECT c.id INTO v_c8 FROM public.affiliate_commissions c WHERE c.order_id = v_o8;
  res1 := public.apply_affiliate_refund('STRIPE', v_o8, 11300, 11300, true);
  SELECT c.void_requested_at IS NOT NULL, c.status::text INTO v_flagged, v_c8_before FROM public.affiliate_commissions c WHERE c.id = v_c8;
  f3 := public.fail_affiliate_payout(v_payout3, 'account_invalid');
  SELECT c.status::text, c.payout_id INTO v_c8_status, v_c8_payout FROM public.affiliate_commissions c WHERE c.id = v_c8;
  SELECT count(*) INTO retry3 FROM public.prepare_affiliate_payout_retry(v_payout3) AS p;
  SELECT po.failure_reason INTO v_reason3 FROM public.affiliate_payouts po WHERE po.id = v_payout3;
  pending_ok := res1 = 'alerted' AND v_flagged AND v_c8_before = 'CLEARED' AND f3 AND v_c8_status = 'VOIDED_REFUND'
    AND v_c8_payout IS NULL AND retry3 = 0 AND v_reason3 = 'nothing_to_pay';

  -- the first failed payout is given up: its commission is claimable again, the payout is dead
  rel := public.release_affiliate_payout(v_payout2);
  SELECT count(*) INTO n FROM public.affiliate_commissions c WHERE c.payout_id = v_payout2;
  SELECT po.failure_reason INTO v_rel_reason FROM public.affiliate_payouts po WHERE po.id = v_payout2;
  done3 := public.complete_affiliate_payout(v_payout2, 'tr_svposture_0002');
  SELECT c.status::text, c.payout_id INTO v_c7_status, v_c7_payout FROM public.affiliate_commissions c WHERE c.order_id = v_o7;
  cycle_ok := f1 AND v_fail_status = 'FAILED' AND v_fail_reason = 'balance_insufficient' AND v_attempt = 2
    AND v_retry_status = 'PROCESSING' AND f2 AND rel AND n = 0 AND v_rel_reason = 'released' AND NOT done3
    AND v_c7_status = 'CLEARED' AND v_c7_payout IS NULL;

  RAISE NOTICE '%  the orders trigger records one commission when paid_at is set: subtotal minus discount, tier rate, clearance hold, base currency', CASE WHEN recorded_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  recording a commission raises the partner''s total_earned_cents by its amount', CASE WHEN earned_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  a refunded order voids its commission and takes it back out of total_earned_cents', CASE WHEN void_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  self-referrals earn nothing (the partner''s account, or its mailbox after +tag, case and gmail dot folding)', CASE WHEN self_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  a foreign-currency order converts with its purchase rate and minor-unit factors (EUR, JPY)', CASE WHEN fx_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  a partial refund raises refunded_amount_cents pro rata on the charge without its shipping share, and an older, smaller event never lowers it', CASE WHEN partial_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  refunding everything but the shipping voids the commission and the rest of its earnings; the full refund after it changes nothing', CASE WHEN full_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  a full refund before any commission leaves a zero tombstone the paid trigger never overwrites', CASE WHEN tomb_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  promote_cleared_affiliate_commissions clears a commission past its hold', CASE WHEN promote_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  claim_affiliate_payout attaches the cleared commissions to one PROCESSING payout with the Connect account snapshot', CASE WHEN claim_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  a refund while a payout is in flight keeps the amounts, records refund_pending_cents and raises one complete alert', CASE WHEN alerted_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  complete_affiliate_payout completes once: payout COMPLETED, commissions PAID with the transfer id, total_paid_cents up', CASE WHEN complete_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  fail, retry (attempt 2), fail, release: the commission is claimable again and the released payout cannot complete', CASE WHEN cycle_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  a void requested while a payout is in flight is applied when it fails; the retry has nothing to pay', CASE WHEN pending_ok THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- 37b. affiliates (02030): key modes, the retry minimum, refund shares and dispute holds (the
--      2026-10-27 review). A sale is only ever paid by a transfer of its own key mode and a
--      payout is never retried in the other one (C); an automatic retry whose remainder fell
--      below the minimum hands its commissions back (Z); a refund is measured on the charge
--      without its shipping share (I), and one that arrives before the commission exists is kept
--      on the order and taken off when the commission is recorded (Y); an open dispute holds the
--      commission (L). Continues section 37's ledger: partner one, test-mode account
--      acct_svposture1, and the cleared commission of v_o7 that section 37 released.
RESET ROLE;
DO $$
DECLARE
  v_rtl1 uuid := 'aa000000-0000-0000-0000-00000000af01';
  v_cust uuid := 'aa000000-0000-0000-0000-00000000cc01';
  v_oy uuid := 'aa000000-0000-0000-0000-00000000b111';
  v_oyv uuid := 'aa000000-0000-0000-0000-00000000b11a';
  v_ou uuid := 'aa000000-0000-0000-0000-00000000b112';
  v_oz1 uuid := 'aa000000-0000-0000-0000-00000000b113';
  v_oz2 uuid := 'aa000000-0000-0000-0000-00000000b114';
  v_od1 uuid := 'aa000000-0000-0000-0000-00000000b115';
  v_od2 uuid := 'aa000000-0000-0000-0000-00000000b116';
  v_op uuid := 'aa000000-0000-0000-0000-00000000b117';
  v_ot uuid := 'aa000000-0000-0000-0000-00000000b118';
  v_ol uuid := 'aa000000-0000-0000-0000-00000000b119';
  v_email jsonb := '{"email":"sv-customer@test.local"}';
  v_aff uuid; n integer; n2 integer; f1 boolean; done1 boolean; rel boolean;
  v_amount bigint; v_refunded bigint; v_c_status text; v_livemode boolean; v_reason text; v_kept bigint; v_kept_total bigint;
  v_earned0 bigint; v_earned1 bigint;
  res1 text; res2 text; res3 text; res4 text; res5 text; res6 text;
  share_ok boolean := false; kept_ok boolean := false; kept_void_ok boolean := false; unattributed_ok boolean := false;
  v_cz1 bigint; v_pz uuid; v_pz_amount bigint;
  v_admin_status text; v_admin_amount bigint; v_admin_attempt integer;
  v_pz_status text; v_pz_reason text; v_pz_attempt integer; v_z2_status text; v_z2_payout uuid;
  min_ok boolean := false; admin_ok boolean := false;
  v_cd2 bigint; v_d1_status text; v_d1_payout uuid; v_d1_held boolean; v_d2_status text; v_d2_payout uuid; v_d2_held boolean;
  v_pl2 uuid; v_retry_amount bigint; v_retry_status text;
  hold_ok boolean := false; release_ok boolean := false; retry_hold_ok boolean := false; paid_hold_ok boolean := false;
  v_cp bigint; v_pp uuid; v_pending bigint; v_p_status text; v_p_payout uuid; pending_void_ok boolean := false;
  v_ct bigint; v_cl bigint; v_pt uuid; v_pt_amount bigint; v_pt_live boolean; v_t_status text; v_t_payout uuid;
  v_l_status text; v_l_payout uuid; v_pt_status text; v_pt_dest text; v_pt_attempt integer; v_pt_reason text;
  v_pl uuid; v_pl_amount bigint; v_pl_live boolean; v_pl_dest text; v_retry_rows integer; v_unknown_rows integer;
  mode_claim_ok boolean := false; mode_retry_ok boolean := false; mode_unknown_ok boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  IF to_regprocedure('public.set_affiliate_commission_dispute(public.affiliate_gateway, uuid, boolean)') IS NULL
     OR to_regprocedure('public.prepare_affiliate_payout_retry(uuid, bigint)') IS NULL
     OR to_regprocedure('private.affiliate_refund_share(bigint, bigint, bigint, bigint, bigint)') IS NULL THEN
    RAISE NOTICE 'FAIL  set_affiliate_commission_dispute, prepare_affiliate_payout_retry(uuid, bigint) and affiliate_refund_share exist';
    RETURN;
  END IF;
  SELECT p.id INTO v_aff FROM public.affiliate_profiles p WHERE p.user_id = v_rtl1;
  IF v_aff IS NULL THEN
    RAISE NOTICE 'FAIL  the section 36 partner exists';
    RETURN;
  END IF;

  -- I: the share rule (a commission of 4500 on USD 90 of goods; a charge of 113 with 10 of shipping)
  share_ok := private.affiliate_refund_share(4500, 10300, 11300, 11300, 1000) = 4500  -- everything but the shipping
    AND private.affiliate_refund_share(4500, 5150, 11300, 11300, 1000) = 2250          -- half the goods and their tax
    AND private.affiliate_refund_share(4500, 1000, 11300, 11300, 1000) = 437           -- a shipping-sized refund
    AND private.affiliate_refund_share(4500, 2500, 10000, 10000, NULL) = 1125          -- no shipping: the plain ratio
    AND private.affiliate_refund_share(4500, 20000, 10000, 10000, 0) = 4500            -- never above the commission
    AND private.affiliate_refund_share(4500, 0, 11300, 11300, 1000) = 0
    AND private.affiliate_refund_share(4500, 5000, 0, 11300, 1000) = 0;

  -- fixtures (as the table owner): partner one's orders, paid in test mode but v_ol (live);
  -- v_ou was referred by nobody
  INSERT INTO public.orders (id, user_id, status, total, subtotal, discount_total, shipping_total, tax_total, currency, provider,
                             customer_details, affiliate_id, affiliate_source, affiliate_base_currency, exchange_rate_at_purchase,
                             affiliate_livemode)
  VALUES
    (v_oy, v_cust, 'pending', 10000, 10000, 0, 0, 0, 'USD', 'stripe', v_email, v_aff, 'storefront', 'USD', 1, false),
    (v_oyv, v_cust, 'pending', 11300, 10000, 1000, 1000, 1300, 'USD', 'stripe', v_email, v_aff, 'storefront', 'USD', 1, false),
    (v_ou, v_cust, 'paid', 10000, 10000, 0, 0, 0, 'USD', 'stripe', v_email, NULL, NULL, NULL, 1, NULL),
    (v_oz1, v_cust, 'paid', 10000, 10000, 0, 0, 0, 'USD', 'stripe', v_email, v_aff, 'storefront', 'USD', 1, false),
    (v_oz2, v_cust, 'paid', 400, 400, 0, 0, 0, 'USD', 'stripe', v_email, v_aff, 'storefront', 'USD', 1, false),
    (v_od1, v_cust, 'paid', 2000, 2000, 0, 0, 0, 'USD', 'stripe', v_email, v_aff, 'storefront', 'USD', 1, false),
    (v_od2, v_cust, 'paid', 3000, 3000, 0, 0, 0, 'USD', 'stripe', v_email, v_aff, 'storefront', 'USD', 1, false),
    (v_op, v_cust, 'paid', 11300, 10000, 1000, 1000, 1300, 'USD', 'stripe', v_email, v_aff, 'storefront', 'USD', 1, false),
    (v_ot, v_cust, 'paid', 4000, 4000, 0, 0, 0, 'USD', 'stripe', v_email, v_aff, 'referral_link', 'USD', 1, false),
    (v_ol, v_cust, 'paid', 6000, 6000, 0, 0, 0, 'USD', 'stripe', v_email, v_aff, 'referral_link', 'USD', 1, true)
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';

  -- Y: the refund event beat the paid event; the commission recorded later starts from it
  res1 := public.apply_affiliate_refund('STRIPE', v_oy, 5000, 10000, false);
  res2 := public.apply_affiliate_refund('STRIPE', v_oy, 2000, 10000, false);  -- an older, smaller event
  SELECT o.affiliate_refunded_minor, o.affiliate_refund_total_minor INTO v_kept, v_kept_total FROM public.orders o WHERE o.id = v_oy;
  SELECT p.total_earned_cents INTO v_earned0 FROM public.affiliate_profiles p WHERE p.id = v_aff;
  UPDATE public.orders SET status = 'paid' WHERE id = v_oy;
  PERFORM public.assign_order_invoice_metadata(v_oy, now());
  SELECT c.commission_amount_cents, c.refunded_amount_cents, c.status::text, c.livemode
    INTO v_amount, v_refunded, v_c_status, v_livemode
    FROM public.affiliate_commissions c WHERE c.order_id = v_oy;
  SELECT p.total_earned_cents INTO v_earned1 FROM public.affiliate_profiles p WHERE p.id = v_aff;
  kept_ok := res1 = 'none' AND res2 = 'none' AND v_kept = 5000 AND v_kept_total = 10000
    AND v_c_status = 'PENDING_CLEARANCE' AND v_amount > 0 AND v_refunded = round(v_amount * 0.5)
    AND v_earned1 = v_earned0 + v_amount - v_refunded AND v_livemode IS FALSE;

  -- Y: everything but the shipping came back before the payment: the commission is born voided
  res3 := public.apply_affiliate_refund('STRIPE', v_oyv, 10300, 11300, false);
  SELECT p.total_earned_cents INTO v_earned0 FROM public.affiliate_profiles p WHERE p.id = v_aff;
  UPDATE public.orders SET status = 'paid' WHERE id = v_oyv;
  PERFORM public.assign_order_invoice_metadata(v_oyv, now());
  SELECT count(*), max(c.status::text), max(c.void_reason), max(c.commission_amount_cents - c.refunded_amount_cents)
    INTO n, v_c_status, v_reason, v_amount
    FROM public.affiliate_commissions c WHERE c.order_id = v_oyv;
  SELECT p.total_earned_cents INTO v_earned1 FROM public.affiliate_profiles p WHERE p.id = v_aff;
  kept_void_ok := res3 = 'none' AND n = 1 AND v_c_status = 'VOIDED_REFUND' AND v_reason = 'refunded' AND v_amount = 0
    AND v_earned1 = v_earned0;

  -- Y: an order nobody referred keeps nothing
  res4 := public.apply_affiliate_refund('STRIPE', v_ou, 5000, 10000, false);
  SELECT o.affiliate_refunded_minor, o.affiliate_refund_total_minor INTO v_kept, v_kept_total FROM public.orders o WHERE o.id = v_ou;
  unattributed_ok := res4 = 'none' AND v_kept IS NULL AND v_kept_total IS NULL;

  -- Z: a payout that met the minimum (v_o7's commission plus two) fails, the biggest order is
  -- refunded meanwhile, and what is left is below the minimum
  PERFORM public.assign_order_invoice_metadata(v_oz1, now());
  PERFORM public.assign_order_invoice_metadata(v_oz2, now());
  UPDATE public.affiliate_commissions SET clears_at = now() - interval '1 minute' WHERE order_id IN (v_oz1, v_oz2);
  PERFORM public.promote_cleared_affiliate_commissions();
  SELECT c.commission_amount_cents INTO v_cz1 FROM public.affiliate_commissions c WHERE c.order_id = v_oz1;
  SELECT p.id, p.amount_cents INTO v_pz, v_pz_amount FROM public.claim_affiliate_payout(v_aff, 'USD', v_cz1, 'cron') AS p;
  f1 := public.fail_affiliate_payout(v_pz, 'balance_insufficient');
  UPDATE public.orders SET status = 'refunded' WHERE id = v_oz1;
  -- an admin Retry passes no minimum and sends what is left (run, then rolled back)
  BEGIN
    SELECT p.status::text, p.amount_cents, p.attempt_count INTO v_admin_status, v_admin_amount, v_admin_attempt
      FROM public.prepare_affiliate_payout_retry(v_pz) AS p;
    RAISE EXCEPTION 'sv_rollback_admin_retry';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  -- the automatic retry passes the program minimum
  SELECT count(*) INTO n FROM public.prepare_affiliate_payout_retry(v_pz, v_cz1) AS p;
  SELECT po.status::text, po.failure_reason, po.attempt_count INTO v_pz_status, v_pz_reason, v_pz_attempt
    FROM public.affiliate_payouts po WHERE po.id = v_pz;
  SELECT count(*) INTO n2 FROM public.affiliate_commissions c WHERE c.payout_id = v_pz;
  SELECT c.status::text, c.payout_id INTO v_z2_status, v_z2_payout FROM public.affiliate_commissions c WHERE c.order_id = v_oz2;
  done1 := public.complete_affiliate_payout(v_pz, 'tr_svposture_z001');
  min_ok := v_pz IS NOT NULL AND f1 AND n = 0 AND v_pz_status = 'FAILED' AND v_pz_reason = 'below_minimum'
    AND v_pz_attempt = 1 AND n2 = 0 AND v_z2_status = 'CLEARED' AND v_z2_payout IS NULL AND NOT done1;
  admin_ok := v_admin_status = 'PROCESSING' AND v_admin_attempt = 2 AND v_admin_amount = v_pz_amount - v_cz1;

  -- L: an open dispute holds the commission, whether it is still clearing or cleared
  PERFORM public.assign_order_invoice_metadata(v_od1, now());
  PERFORM public.assign_order_invoice_metadata(v_od2, now());
  SELECT c.commission_amount_cents INTO v_cd2 FROM public.affiliate_commissions c WHERE c.order_id = v_od2;
  res1 := public.set_affiliate_commission_dispute('STRIPE', v_od1, true);
  UPDATE public.affiliate_commissions SET clears_at = now() - interval '1 minute' WHERE order_id IN (v_od1, v_od2);
  PERFORM public.promote_cleared_affiliate_commissions();
  res2 := public.set_affiliate_commission_dispute('STRIPE', v_od2, true);
  res3 := public.set_affiliate_commission_dispute('STRIPE', v_od2, true);  -- a redelivery
  PERFORM public.claim_affiliate_payout(v_aff, 'USD', 1, 'cron');           -- takes the rest, not v_od2
  SELECT c.status::text INTO v_d1_status FROM public.affiliate_commissions c WHERE c.order_id = v_od1;
  SELECT c.status::text, c.payout_id INTO v_d2_status, v_d2_payout FROM public.affiliate_commissions c WHERE c.order_id = v_od2;
  hold_ok := res1 = 'held' AND res2 = 'held' AND res3 = 'held' AND v_d1_status = 'PENDING_CLEARANCE'
    AND v_d2_status = 'CLEARED' AND v_d2_payout IS NULL;

  -- L: the dispute is won: the holds go, and both are promoted and claimed together
  res4 := public.set_affiliate_commission_dispute('STRIPE', v_od1, false);
  res5 := public.set_affiliate_commission_dispute('STRIPE', v_od2, false);
  res6 := public.set_affiliate_commission_dispute('STRIPE', v_od2, false);  -- nothing held any more
  PERFORM public.promote_cleared_affiliate_commissions();
  SELECT p.id INTO v_pl2 FROM public.claim_affiliate_payout(v_aff, 'USD', 1, 'cron') AS p;
  SELECT count(*) INTO n FROM public.affiliate_commissions c WHERE c.payout_id = v_pl2 AND c.order_id IN (v_od1, v_od2);
  SELECT count(*) INTO n2 FROM public.affiliate_commissions c WHERE c.payout_id = v_pl2;
  release_ok := res4 = 'released' AND res5 = 'released' AND res6 = 'none' AND v_pl2 IS NOT NULL AND n = 2 AND n2 = 2;

  -- L: a dispute opened on a commission of a FAILED payout: the retry detaches it, sends the rest
  f1 := public.fail_affiliate_payout(v_pl2, 'balance_insufficient');
  res1 := public.set_affiliate_commission_dispute('STRIPE', v_od1, true);
  SELECT p.amount_cents, p.status::text INTO v_retry_amount, v_retry_status FROM public.prepare_affiliate_payout_retry(v_pl2, 1) AS p;
  SELECT c.status::text, c.payout_id, c.disputed_at IS NOT NULL INTO v_d1_status, v_d1_payout, v_d1_held
    FROM public.affiliate_commissions c WHERE c.order_id = v_od1;
  retry_hold_ok := f1 AND res1 = 'held' AND v_retry_status = 'PROCESSING' AND v_retry_amount = v_cd2
    AND v_d1_status = 'CLEARED' AND v_d1_payout IS NULL AND v_d1_held;

  -- L: a dispute opened while the transfer is in flight does not stop it; winning it clears the
  -- mark from the PAID row; a PAID commission, or an order without one, answers none
  res2 := public.set_affiliate_commission_dispute('STRIPE', v_od2, true);
  done1 := public.complete_affiliate_payout(v_pl2, 'tr_svposture_l002');
  SELECT c.status::text, c.disputed_at IS NOT NULL INTO v_d2_status, v_d2_held FROM public.affiliate_commissions c WHERE c.order_id = v_od2;
  res3 := public.set_affiliate_commission_dispute('STRIPE', v_od2, true);
  res4 := public.set_affiliate_commission_dispute('STRIPE', v_od2, false);
  SELECT count(*) INTO n FROM public.affiliate_commissions c WHERE c.order_id = v_od2 AND c.disputed_at IS NULL;
  res5 := public.set_affiliate_commission_dispute('STRIPE', v_ou, true);
  paid_hold_ok := res2 = 'held' AND done1 AND v_d2_status = 'PAID' AND v_d2_held AND res3 = 'none' AND res4 = 'released'
    AND n = 1 AND res5 = 'none';

  -- I: everything but the shipping refunded while the payout is in flight: flagged, then voided
  -- when that payout fails (never a net-zero row left to claim)
  PERFORM public.assign_order_invoice_metadata(v_op, now());
  UPDATE public.affiliate_commissions SET clears_at = now() - interval '1 minute' WHERE order_id = v_op;
  PERFORM public.promote_cleared_affiliate_commissions();
  SELECT c.commission_amount_cents INTO v_cp FROM public.affiliate_commissions c WHERE c.order_id = v_op;
  SELECT p.id INTO v_pp FROM public.claim_affiliate_payout(v_aff, 'USD', 1, 'cron') AS p;
  SELECT count(*) INTO n FROM public.affiliate_commissions c WHERE c.payout_id = v_pp AND c.order_id = v_op;
  res1 := public.apply_affiliate_refund('STRIPE', v_op, 10300, 11300, false);
  SELECT c.refund_pending_cents INTO v_pending FROM public.affiliate_commissions c WHERE c.order_id = v_op;
  SELECT p.total_earned_cents INTO v_earned0 FROM public.affiliate_profiles p WHERE p.id = v_aff;
  f1 := public.fail_affiliate_payout(v_pp, 'account_invalid');
  SELECT c.status::text, c.payout_id INTO v_p_status, v_p_payout FROM public.affiliate_commissions c WHERE c.order_id = v_op;
  SELECT p.total_earned_cents INTO v_earned1 FROM public.affiliate_profiles p WHERE p.id = v_aff;
  pending_void_ok := n = 1 AND res1 = 'alerted' AND v_pending = v_cp AND f1 AND v_p_status = 'VOIDED_REFUND'
    AND v_p_payout IS NULL AND v_earned1 = v_earned0 - v_cp;

  -- C: the test-mode account claims the test-mode sale; the live sale stays cleared
  PERFORM public.assign_order_invoice_metadata(v_ot, now());
  PERFORM public.assign_order_invoice_metadata(v_ol, now());
  UPDATE public.affiliate_commissions SET clears_at = now() - interval '1 minute' WHERE order_id IN (v_ot, v_ol);
  PERFORM public.promote_cleared_affiliate_commissions();
  SELECT c.commission_amount_cents INTO v_ct FROM public.affiliate_commissions c WHERE c.order_id = v_ot;
  SELECT c.commission_amount_cents, c.livemode INTO v_cl, v_livemode FROM public.affiliate_commissions c WHERE c.order_id = v_ol;
  SELECT p.id, p.amount_cents, p.livemode INTO v_pt, v_pt_amount, v_pt_live FROM public.claim_affiliate_payout(v_aff, 'USD', 1, 'cron') AS p;
  SELECT c.payout_id INTO v_t_payout FROM public.affiliate_commissions c WHERE c.order_id = v_ot;
  SELECT c.status::text, c.payout_id INTO v_l_status, v_l_payout FROM public.affiliate_commissions c WHERE c.order_id = v_ol;
  mode_claim_ok := v_livemode IS TRUE AND v_pt IS NOT NULL AND v_pt_live IS FALSE AND v_pt_amount = v_ct
    AND v_t_payout = v_pt AND v_l_status = 'CLEARED' AND v_l_payout IS NULL;

  -- C: the test payout fails, the store goes live and the partner onboards a live account: the
  -- test payout is never re-sent to it, and the live claim takes only the live sale
  f1 := public.fail_affiliate_payout(v_pt, 'balance_insufficient');
  UPDATE public.affiliate_profiles SET stripe_connect_account_id = 'acct_svposturelive', stripe_connect_livemode = true WHERE id = v_aff;
  SELECT count(*) INTO v_retry_rows FROM public.prepare_affiliate_payout_retry(v_pt) AS p;
  SELECT po.status::text, po.stripe_destination_account, po.attempt_count, po.failure_reason
    INTO v_pt_status, v_pt_dest, v_pt_attempt, v_pt_reason
    FROM public.affiliate_payouts po WHERE po.id = v_pt;
  SELECT count(*) INTO n FROM public.affiliate_commissions c WHERE c.payout_id = v_pt;
  SELECT p.id, p.amount_cents, p.livemode, p.stripe_destination_account INTO v_pl, v_pl_amount, v_pl_live, v_pl_dest
    FROM public.claim_affiliate_payout(v_aff, 'USD', 1, 'cron') AS p;
  SELECT count(*) INTO n2 FROM public.affiliate_commissions c WHERE c.payout_id = v_pl;
  mode_retry_ok := f1 AND v_retry_rows = 0 AND v_pt_status = 'FAILED' AND v_pt_dest = 'acct_svposture1' AND v_pt_attempt = 1
    AND v_pt_reason = 'balance_insufficient' AND n = 1 AND v_pl IS NOT NULL AND v_pl_live IS TRUE
    AND v_pl_dest = 'acct_svposturelive' AND v_pl_amount = v_cl AND n2 = 1;

  -- C: an account whose key mode is unknown claims nothing, whatever is cleared
  rel := public.release_affiliate_payout(v_pt);
  UPDATE public.affiliate_profiles SET stripe_connect_livemode = NULL WHERE id = v_aff;
  SELECT count(*) INTO v_unknown_rows FROM public.claim_affiliate_payout(v_aff, 'USD', 1, 'cron') AS p;
  SELECT c.status::text, c.payout_id INTO v_t_status, v_t_payout FROM public.affiliate_commissions c WHERE c.order_id = v_ot;
  mode_unknown_ok := rel AND v_unknown_rows = 0 AND v_t_status = 'CLEARED' AND v_t_payout IS NULL;

  RAISE NOTICE '%  affiliate_refund_share measures a refund on the charge without its shipping share: everything but the shipping takes the whole commission, no shipping keeps the plain ratio', CASE WHEN share_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  a partial refund before the commission exists is kept on the order (never lowered), and the commission recorded at payment starts from it in the sale''s key mode', CASE WHEN kept_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  a refund of everything but the shipping before the payment records the commission voided, earning nothing', CASE WHEN kept_void_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  a partial refund of an order nobody referred keeps nothing on it', CASE WHEN unattributed_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  an automatic retry below the minimum stays FAILED (below_minimum, attempt 1), hands its commissions back and can no longer complete', CASE WHEN min_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  an admin retry (no minimum) still sends what is left', CASE WHEN admin_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  an open dispute holds the commission: not promoted while clearing, not claimed once cleared', CASE WHEN hold_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  a won dispute releases the hold: the commission is promoted and claimed again', CASE WHEN release_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  a dispute on a commission of a FAILED payout makes the retry detach it and send the rest', CASE WHEN retry_hold_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  a dispute never stops a transfer in flight; winning it clears the mark from the PAID row; a PAID or missing commission answers none', CASE WHEN paid_hold_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  everything but the shipping refunded while a payout is in flight voids the commission when that payout fails', CASE WHEN pending_void_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  a test-mode account claims only test-mode sales and its payout records livemode false; a live sale stays cleared', CASE WHEN mode_claim_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  after a switch to a live account the FAILED test payout is not retried (no row, nothing changed) and the live claim takes only the live sale', CASE WHEN mode_retry_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  a Connect account of unknown key mode claims nothing', CASE WHEN mode_unknown_ok THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- 38. affiliates (02030): repairs, sweeps and deletes. reconcile_affiliate_commissions() records
--     the commission of a paid order the trigger never saw and voids a live one whose order was
--     refunded behind its back; the notification claim skips voided rows and tombstones and never
--     hands a row out twice; a payout day is claimed once; deleting an order voids its live
--     commission (A10); deleting a partner's auth user cascades through its account and ledger
--     (A24: the sandbox reset deletes auth users first) and frees its tier spot.
RESET ROLE;
DO $$
DECLARE
  v_rtl1 uuid := 'aa000000-0000-0000-0000-00000000af01';
  v_cust uuid := 'aa000000-0000-0000-0000-00000000cc01';
  v_o1 uuid := 'aa000000-0000-0000-0000-00000000b101';
  v_o5 uuid := 'aa000000-0000-0000-0000-00000000b105';
  v_o10 uuid := 'aa000000-0000-0000-0000-00000000b10a';
  v_o11 uuid := 'aa000000-0000-0000-0000-00000000b10b';
  v_o12 uuid := 'aa000000-0000-0000-0000-00000000b10c';
  v_o13 uuid := 'aa000000-0000-0000-0000-00000000b10d';
  v_aff uuid; v_tier uuid; v_members integer; v_members_after integer;
  v_result jsonb; n integer; v_status text; v_reason text;
  rec_ok boolean := false; void_ok boolean := false;
  v_res13 text; v_n13 integer; v_c13 bigint; v_r13 bigint; v_s13 text; rec_refund_ok boolean := false;
  v_c10 uuid; v_tomb uuid; v_void1 uuid; v_claimed uuid[]; v_claimed_again uuid[]; notify_ok boolean := false;
  run1 boolean; run2 boolean; v_finished boolean; run_ok boolean := false;
  v_c12 uuid; v_c12_order uuid; delete_ok boolean := false;
  email_ok boolean := false; n_left integer; n_orders integer; cascade_ok boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  IF to_regclass('public.affiliate_profiles') IS NULL THEN
    RAISE NOTICE 'FAIL  affiliate_profiles exists';
    RETURN;
  END IF;
  SELECT p.id, p.tier_id INTO v_aff, v_tier FROM public.affiliate_profiles p WHERE p.user_id = v_rtl1;
  IF v_aff IS NULL THEN
    RAISE NOTICE 'FAIL  the section 36 partner exists';
    RETURN;
  END IF;
  -- fixtures (as the table owner): an order inserted already paid (no trigger saw it), a
  -- refunded order whose live commission was written behind the trigger's back, an order to delete
  INSERT INTO public.orders (id, user_id, status, total, subtotal, discount_total, currency, provider, customer_details,
                             affiliate_id, affiliate_source, affiliate_base_currency, paid_at)
  VALUES
    (v_o10, v_cust, 'paid', 5000, 5000, 0, 'USD', 'stripe', '{"email":"sv-customer@test.local"}', v_aff, 'storefront', 'USD', now() - interval '1 hour'),
    (v_o11, v_cust, 'refunded', 5000, 5000, 0, 'USD', 'stripe', '{"email":"sv-customer@test.local"}', v_aff, 'storefront', 'USD', now() - interval '2 hours'),
    (v_o12, v_cust, 'paid', 5000, 5000, 0, 'USD', 'stripe', '{"email":"sv-customer@test.local"}', v_aff, 'storefront', 'USD', NULL)
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.affiliate_commissions (affiliate_id, order_id, gateway, order_currency, order_net_amount_minor,
                                            net_order_amount_cents, commission_rate_snapshot, commission_amount_cents, currency)
  VALUES (v_aff, v_o11, 'STRIPE', 'USD', 5000, 5000, 50, 2500, 'USD')
  ON CONFLICT ON CONSTRAINT affiliate_commissions_order_gateway_key DO NOTHING;
  -- finding Y through reconcile: the partner is suspended when v_o13 is paid (the trigger records
  -- nothing), a partial refund of 40 % arrives, then the partner is reactivated
  UPDATE public.affiliate_profiles SET status = 'SUSPENDED', suspended_reason = 'SV posture' WHERE id = v_aff;
  INSERT INTO public.orders (id, user_id, status, total, subtotal, discount_total, currency, provider, customer_details,
                             affiliate_id, affiliate_source, affiliate_base_currency, affiliate_livemode)
  VALUES (v_o13, v_cust, 'paid', 5000, 5000, 0, 'USD', 'stripe', '{"email":"sv-customer@test.local"}', v_aff, 'storefront', 'USD', false)
  ON CONFLICT (id) DO NOTHING;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  PERFORM public.assign_order_invoice_metadata(v_o13, now());
  SELECT count(*) INTO v_n13 FROM public.affiliate_commissions c WHERE c.order_id = v_o13;
  v_res13 := public.apply_affiliate_refund('STRIPE', v_o13, 2000, 5000, false);
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  UPDATE public.affiliate_profiles SET status = 'ACTIVE', suspended_reason = NULL WHERE id = v_aff;

  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  v_result := public.reconcile_affiliate_commissions(200);
  SELECT c.commission_amount_cents, c.refunded_amount_cents, c.status::text INTO v_c13, v_r13, v_s13
    FROM public.affiliate_commissions c WHERE c.order_id = v_o13;
  rec_refund_ok := v_n13 = 0 AND v_res13 = 'none' AND v_c13 > 0 AND v_r13 = round(v_c13 * 0.4) AND v_s13 = 'PENDING_CLEARANCE';
  SELECT count(*) INTO n FROM public.affiliate_commissions c WHERE c.order_id = v_o10 AND c.status::text = 'PENDING_CLEARANCE';
  rec_ok := coalesce((v_result ->> 'recorded')::integer, 0) >= 1 AND n = 1;
  SELECT c.status::text, c.void_reason INTO v_status, v_reason FROM public.affiliate_commissions c WHERE c.order_id = v_o11;
  void_ok := coalesce((v_result ->> 'voided')::integer, 0) >= 1 AND v_status = 'VOIDED_REFUND' AND v_reason = 'refunded';

  SELECT c.id INTO v_c10 FROM public.affiliate_commissions c WHERE c.order_id = v_o10;
  SELECT c.id INTO v_tomb FROM public.affiliate_commissions c WHERE c.order_id = v_o5;
  SELECT c.id INTO v_void1 FROM public.affiliate_commissions c WHERE c.order_id = v_o1;
  SELECT array_agg(c.id) INTO v_claimed FROM public.claim_affiliate_commission_notifications(200) AS c;
  SELECT array_agg(c.id) INTO v_claimed_again FROM public.claim_affiliate_commission_notifications(200) AS c;
  notify_ok := v_c10 IS NOT NULL AND v_tomb IS NOT NULL AND v_void1 IS NOT NULL
    AND v_claimed @> ARRAY[v_c10] AND NOT (v_claimed && ARRAY[v_tomb, v_void1])
    AND NOT (coalesce(v_claimed_again, '{}'::uuid[]) && ARRAY[v_c10]);

  run1 := public.claim_affiliate_payout_run('2099-12-31', 'cron');
  run2 := public.claim_affiliate_payout_run('2099-12-31', 'auto');
  PERFORM public.finish_affiliate_payout_run('2099-12-31', '{"claimed": 0}'::jsonb);
  SELECT pr.finished_at IS NOT NULL AND pr.summary = '{"claimed": 0}'::jsonb AND pr.trigger = 'cron' INTO v_finished
    FROM public.affiliate_payout_runs pr WHERE pr.run_date = '2099-12-31';
  run_ok := run1 AND NOT run2 AND v_finished;

  PERFORM public.assign_order_invoice_metadata(v_o12, now());
  SELECT c.id INTO v_c12 FROM public.affiliate_commissions c WHERE c.order_id = v_o12;
  DELETE FROM public.orders WHERE id = v_o12;
  SELECT c.status::text, c.void_reason, c.order_id INTO v_status, v_reason, v_c12_order
    FROM public.affiliate_commissions c WHERE c.id = v_c12;
  delete_ok := v_c12 IS NOT NULL AND v_status = 'VOIDED_REFUND' AND v_reason = 'order_deleted' AND v_c12_order IS NULL;

  email_ok := private.affiliate_normalize_email('  M.E+Promo@GoogleMail.COM ') = 'me@gmail.com'
    AND private.affiliate_normalize_email('First.Last+x@Example.com') = 'first.last@example.com'
    AND private.affiliate_normalize_email('no-at-sign') = 'no-at-sign'
    AND private.affiliate_normalize_email('   ') IS NULL;

  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  SELECT t.member_count INTO v_members FROM public.affiliate_tiers t WHERE t.id = v_tier;
  -- Section 37's self-referral order has partner one as its buyer. A row inserted in the current
  -- transaction has every foreign key re-checked on any update, so the cascade's user_id SET NULL
  -- on it would re-check affiliate_id against the profile the same cascade deletes. A deployed
  -- database never meets that (its orders predate the delete, checked on a local replay), so the
  -- fixture order loses its buyer first.
  UPDATE public.orders SET user_id = NULL WHERE user_id = v_rtl1;
  DELETE FROM auth.users WHERE id = v_rtl1;
  SELECT (SELECT count(*) FROM public.affiliate_profiles WHERE id = v_aff)
       + (SELECT count(*) FROM public.affiliate_pages WHERE affiliate_id = v_aff)
       + (SELECT count(*) FROM public.affiliate_commissions WHERE affiliate_id = v_aff)
       + (SELECT count(*) FROM public.affiliate_payouts WHERE affiliate_id = v_aff)
       + (SELECT count(*) FROM public.affiliate_click_events WHERE affiliate_id = v_aff)
    INTO n_left;
  SELECT count(*) INTO n_orders FROM public.orders o WHERE o.affiliate_id = v_aff;
  SELECT t.member_count INTO v_members_after FROM public.affiliate_tiers t WHERE t.id = v_tier;
  cascade_ok := n_left = 0 AND n_orders = 0 AND v_members_after = v_members - 1;

  RAISE NOTICE '%  reconcile_affiliate_commissions records the commission of a paid, attributed order the trigger never saw', CASE WHEN rec_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  reconcile_affiliate_commissions voids a live commission whose order is refunded', CASE WHEN void_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  a partial refund kept while the partner was suspended reduces the commission reconcile records after reactivation', CASE WHEN rec_refund_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  the notification claim hands out each earned commission once and skips voided rows and tombstones', CASE WHEN notify_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  claim_affiliate_payout_run claims a day once and finish_affiliate_payout_run records its summary', CASE WHEN run_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  deleting an order voids its live commission (order_deleted) and keeps the ledger row', CASE WHEN delete_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  affiliate_normalize_email folds case, whitespace, +tags and gmail dots (the lib mirrors it)', CASE WHEN email_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  deleting a partner''s auth user cascades through its account and ledger and frees its tier spot', CASE WHEN cascade_ok THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- 39. affiliates (02035): tier changes and the rate at payment. change_affiliate_partner_tier()
--     is service-role only and answers every outcome under row locks: a paused partner moves, a
--     full capped tier takes the partner only when the caller allows it, member counts follow and
--     the profile guard stamps tier_changed_at, which a partner session cannot write. The orders
--     BEFORE trigger stores the tier's rate and hold on an attributed order when it is paid, so a
--     commission recorded later (reconcile, after a pause) keeps the rate of the payment, not the
--     tier of the recording or a rate edited since, and its hold counts from the payment. A
--     dispute that opens before such a late commission exists is kept on the order, so the
--     commission starts held instead of clearing (and being paid) in the run that records it.
--     Uses section 36's partners two (ACTIVE, never approved) and three (approved, paused there).
RESET ROLE;
DO $$
DECLARE
  v_rtl2 uuid := 'aa000000-0000-0000-0000-00000000af02';
  v_rtl3 uuid := 'aa000000-0000-0000-0000-00000000af03';
  v_cust uuid := 'aa000000-0000-0000-0000-00000000cc01';
  v_oa uuid := 'aa000000-0000-0000-0000-00000000b131';  -- paid at tier A while paused, recorded after the move
  v_ob uuid := 'aa000000-0000-0000-0000-00000000b132';  -- paid at tier B by the paid trigger
  v_oc uuid := 'aa000000-0000-0000-0000-00000000b133';  -- inserted paid 40 days ago (tier B), recorded late
  v_od uuid := 'aa000000-0000-0000-0000-00000000b134';  -- inserted paid with its own rate and hold
  v_oe uuid := 'aa000000-0000-0000-0000-00000000b135';  -- like v_oc, disputed while paused, before its commission
  v_of uuid := 'aa000000-0000-0000-0000-00000000b136';  -- like v_oe, its dispute won before the resume
  v_email jsonb := '{"email":"sv-customer@test.local"}';
  v_rpc text := 'public.change_affiliate_partner_tier(uuid, uuid, boolean)';
  v_trg text := 'private.affiliate_snapshot_order_rate()';
  missing text; rpc_api text; rpc_svc boolean; trig_ok boolean; col_grant boolean;
  denied_grant boolean := false; denied_guard boolean := false;
  v_aff2 uuid; v_aff3 uuid; v_tier0 uuid; v_tier_a uuid; v_tier_b uuid; v_tier_full uuid; v_tier_off uuid;
  v_m0 integer; v_m0_after integer; v_ma integer; v_mfull_over integer; v_mfull_after integer;
  res_missing text; res_no_tier text; res_off text; res_full text; res_full_explicit text; res_over text;
  res_a text; res_same text; res_b text; v_still uuid; v_tier_now uuid; v_status3 text;
  v_changed0 timestamptz; v_changed1 timestamptz;
  v_rate_unpaid numeric; v_hold_unpaid integer; v_rate_a numeric; v_hold_a integer; v_paid_a timestamptz; n_paused integer;
  v_rate_d numeric; v_hold_d integer; v_result jsonb;
  ca record; cb record; cc record; cd record; ce record; cf record; v_promoted integer;
  dis_open text; dis_again text; dis_won_open text; dis_won_close text; dis_close text;
  v_flag_e timestamptz; v_flag_f timestamptz; v_flag_e_after timestamptz; n_disputed integer;
  v_e_held_after boolean; v_e_status_after text;
  outcomes_ok boolean := false; over_ok boolean := false; moved_ok boolean := false; stored_ok boolean := false;
  kept_ok boolean := false; new_rate_ok boolean := false; late_ok boolean := false;
  dispute_hold_ok boolean := false; dispute_release_ok boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  SELECT string_agg(m.f, ', ') INTO missing
    FROM (SELECT f FROM unnest(ARRAY[v_rpc, v_trg]) AS f WHERE to_regprocedure(f) IS NULL
          UNION ALL
          SELECT c FROM unnest(ARRAY['orders.affiliate_commission_rate', 'orders.affiliate_clearance_hold_days',
                                     'orders.affiliate_disputed_at', 'affiliate_profiles.tier_changed_at']) AS c
           WHERE NOT EXISTS (
             SELECT 1 FROM pg_attribute a
              WHERE a.attrelid = to_regclass('public.' || split_part(c, '.', 1))
                AND a.attname = split_part(c, '.', 2) AND a.attnum > 0 AND NOT a.attisdropped)) AS m;
  IF missing IS NOT NULL THEN
    RAISE NOTICE 'FAIL  the 02035 columns and functions exist (missing: %)', missing;
    RETURN;
  END IF;
  SELECT p.id INTO v_aff2 FROM public.affiliate_profiles p WHERE p.user_id = v_rtl2;
  SELECT p.id, p.tier_id INTO v_aff3, v_tier0 FROM public.affiliate_profiles p WHERE p.user_id = v_rtl3;
  IF v_aff2 IS NULL OR v_aff3 IS NULL THEN
    RAISE NOTICE 'FAIL  the section 36 partners two and three exist';
    RETURN;
  END IF;

  -- the catalog: who may call what, the trigger's shape, the column pin
  SELECT string_agg(format('%s to %s', f, r.role), ', ') INTO rpc_api
    FROM unnest(ARRAY[v_rpc, v_trg]) AS f CROSS JOIN unnest(ARRAY['anon', 'authenticated']::name[]) AS r(role)
   WHERE has_function_privilege(r.role, to_regprocedure(f), 'EXECUTE');
  rpc_svc := has_function_privilege('service_role', to_regprocedure(v_rpc), 'EXECUTE');
  -- tgtype 23 = ROW (1) | BEFORE (2) | INSERT (4) | UPDATE (16); the UPDATE column list is paid_at alone.
  -- tgattr is an int2vector, whose array cast is zero-based ([0:0]={n}): rebuild it as an ordinary
  -- one-based array before comparing, or the equality is always false.
  SELECT count(*) = 1 INTO trig_ok
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.orders'::regclass AND t.tgname = 'affiliate_snapshot_order_rate' AND NOT t.tgisinternal
     AND t.tgtype = 23 AND t.tgenabled <> 'D' AND t.tgfoid = to_regprocedure(v_trg)
     AND ARRAY(SELECT unnest(t.tgattr::int2[])) = ARRAY[(SELECT a.attnum FROM pg_attribute a
                                    WHERE a.attrelid = 'public.orders'::regclass AND a.attname = 'paid_at')]::int2[];
  col_grant := has_column_privilege('authenticated', 'public.affiliate_profiles', 'tier_changed_at', 'UPDATE');

  -- a partner session cannot write tier_changed_at: the column grant refuses it, and the profile
  -- guard behind it refuses it with table rights (the service role) under the partner's session
  PERFORM set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated","aal":"aal1"}', v_rtl2), true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    UPDATE public.affiliate_profiles SET tier_changed_at = now() - interval '1 year' WHERE user_id = v_rtl2;
  EXCEPTION WHEN insufficient_privilege THEN denied_grant := SQLERRM LIKE 'permission denied%';
  END;
  EXECUTE 'SET LOCAL ROLE service_role';
  BEGIN
    UPDATE public.affiliate_profiles SET tier_changed_at = now() - interval '1 year' WHERE user_id = v_rtl2;
  EXCEPTION WHEN insufficient_privilege THEN denied_guard := SQLERRM = 'affiliate_profile_field_protected';
  END;

  -- fixtures (as the table owner): tier A (12.5 %, 10-day hold), tier B (40 %, 20 days), a capped
  -- tier with no room and an inactive tier
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  INSERT INTO public.affiliate_tiers (name, slug, commission_percentage, clearance_hold_days, sort_order, is_active, max_ambassadors_cap, badge_color)
  VALUES
    ('SV Tier A', 'sv-tier-a', 12.5, 10, 90, true, NULL, 'sky'),
    ('SV Tier B', 'sv-tier-b', 40, 20, 91, true, NULL, 'violet'),
    ('SV Tier Full', 'sv-tier-full', 30, 30, 92, true, 0, 'rose'),
    ('SV Tier Off', 'sv-tier-off', 25, 30, 93, false, NULL, 'slate')
  ON CONFLICT (slug) DO NOTHING;
  SELECT t.id INTO v_tier_a FROM public.affiliate_tiers t WHERE t.slug = 'sv-tier-a';
  SELECT t.id INTO v_tier_b FROM public.affiliate_tiers t WHERE t.slug = 'sv-tier-b';
  SELECT t.id INTO v_tier_full FROM public.affiliate_tiers t WHERE t.slug = 'sv-tier-full';
  SELECT t.id INTO v_tier_off FROM public.affiliate_tiers t WHERE t.slug = 'sv-tier-off';
  SELECT p.tier_changed_at INTO v_changed0 FROM public.affiliate_profiles p WHERE p.id = v_aff3;
  SELECT t.member_count INTO v_m0 FROM public.affiliate_tiers t WHERE t.id = v_tier0;

  -- the CMS move, as the service role: every refusal, the cap, then paused partner three to tier A
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  res_missing := public.change_affiliate_partner_tier(gen_random_uuid(), v_tier_a);
  res_no_tier := public.change_affiliate_partner_tier(v_aff3, gen_random_uuid());
  res_off := public.change_affiliate_partner_tier(v_aff3, v_tier_off);
  res_full := public.change_affiliate_partner_tier(v_aff3, v_tier_full);
  res_full_explicit := public.change_affiliate_partner_tier(v_aff3, v_tier_full, false);
  SELECT p.tier_id INTO v_still FROM public.affiliate_profiles p WHERE p.id = v_aff3;
  res_over := public.change_affiliate_partner_tier(v_aff3, v_tier_full, true);
  SELECT t.member_count INTO v_mfull_over FROM public.affiliate_tiers t WHERE t.id = v_tier_full;
  res_a := public.change_affiliate_partner_tier(v_aff3, v_tier_a);
  res_same := public.change_affiliate_partner_tier(v_aff3, v_tier_a, true);
  SELECT p.tier_id, p.tier_changed_at, p.status::text INTO v_tier_now, v_changed1, v_status3
    FROM public.affiliate_profiles p WHERE p.id = v_aff3;
  SELECT t.member_count INTO v_m0_after FROM public.affiliate_tiers t WHERE t.id = v_tier0;
  SELECT t.member_count INTO v_ma FROM public.affiliate_tiers t WHERE t.id = v_tier_a;
  SELECT t.member_count INTO v_mfull_after FROM public.affiliate_tiers t WHERE t.id = v_tier_full;

  -- an attributed order paid while partner three is paused, at tier A (as every "mark paid" path:
  -- assign_order_invoice_metadata, here with a payment three days old)
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  INSERT INTO public.orders (id, user_id, status, total, subtotal, discount_total, currency, provider, customer_details,
                             affiliate_id, affiliate_source, affiliate_base_currency, affiliate_livemode)
  VALUES (v_oa, v_cust, 'paid', 10000, 10000, 0, 'USD', 'stripe', v_email, v_aff3, 'storefront', 'USD', false)
  ON CONFLICT (id) DO NOTHING;
  SELECT o.affiliate_commission_rate, o.affiliate_clearance_hold_days INTO v_rate_unpaid, v_hold_unpaid
    FROM public.orders o WHERE o.id = v_oa;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  PERFORM public.assign_order_invoice_metadata(v_oa, now() - interval '3 days');
  PERFORM public.assign_order_invoice_metadata(v_oa, now());  -- a second "mark paid" keeps paid_at and the rate
  SELECT o.affiliate_commission_rate, o.affiliate_clearance_hold_days, o.paid_at INTO v_rate_a, v_hold_a, v_paid_a
    FROM public.orders o WHERE o.id = v_oa;
  SELECT count(*) INTO n_paused FROM public.affiliate_commissions c WHERE c.order_id = v_oa;
  -- still paused, the partner moves to tier B
  res_b := public.change_affiliate_partner_tier(v_aff3, v_tier_b);

  -- as the table owner: tier A's rate is edited after that payment; orders arrive already paid
  -- 40 days ago (tier B now: v_oc, v_oe, v_of), another carrying its own rate and hold
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  UPDATE public.affiliate_tiers SET commission_percentage = 15 WHERE id = v_tier_a;
  INSERT INTO public.orders (id, user_id, status, total, subtotal, discount_total, currency, provider, customer_details,
                             affiliate_id, affiliate_source, affiliate_base_currency, affiliate_livemode, paid_at,
                             affiliate_commission_rate, affiliate_clearance_hold_days)
  VALUES
    (v_oc, v_cust, 'paid', 5000, 5000, 0, 'USD', 'stripe', v_email, v_aff3, 'referral_link', 'USD', false, now() - interval '40 days', NULL, NULL),
    (v_od, v_cust, 'paid', 5000, 5000, 0, 'USD', 'stripe', v_email, v_aff3, 'referral_link', 'USD', false, now() - interval '1 day', 5, 0),
    (v_oe, v_cust, 'paid', 5000, 5000, 0, 'USD', 'stripe', v_email, v_aff3, 'referral_link', 'USD', false, now() - interval '40 days', NULL, NULL),
    (v_of, v_cust, 'paid', 5000, 5000, 0, 'USD', 'stripe', v_email, v_aff3, 'referral_link', 'USD', false, now() - interval '40 days', NULL, NULL)
  ON CONFLICT (id) DO NOTHING;
  SELECT o.affiliate_commission_rate, o.affiliate_clearance_hold_days INTO v_rate_d, v_hold_d FROM public.orders o WHERE o.id = v_od;

  -- still paused, so no commission exists yet: a chargeback opens on v_oe (redelivered once) and
  -- stays open; one on v_of is won before the resume. Both are kept on the order, not dropped.
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  dis_open := public.set_affiliate_commission_dispute('STRIPE', v_oe, true);
  dis_again := public.set_affiliate_commission_dispute('STRIPE', v_oe, true);
  dis_won_open := public.set_affiliate_commission_dispute('STRIPE', v_of, true);
  dis_won_close := public.set_affiliate_commission_dispute('STRIPE', v_of, false);
  SELECT o.affiliate_disputed_at INTO v_flag_e FROM public.orders o WHERE o.id = v_oe;
  SELECT o.affiliate_disputed_at INTO v_flag_f FROM public.orders o WHERE o.id = v_of;
  SELECT count(*) INTO n_disputed FROM public.affiliate_commissions c WHERE c.order_id IN (v_oe, v_of);

  -- then the partner is resumed, long after those payments' hold (20 days) has passed
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  UPDATE public.affiliate_profiles SET status = 'ACTIVE', suspended_reason = NULL WHERE id = v_aff3;
  INSERT INTO public.orders (id, user_id, status, total, subtotal, discount_total, currency, provider, customer_details,
                             affiliate_id, affiliate_source, affiliate_base_currency, affiliate_livemode)
  VALUES (v_ob, v_cust, 'paid', 10000, 10000, 0, 'USD', 'stripe', v_email, v_aff3, 'storefront', 'USD', false)
  ON CONFLICT (id) DO NOTHING;

  -- the next payout cycle: reconcile credits the orders paid while the partner was paused or never
  -- seen by the paid trigger; a payment now is recorded by the trigger; then the clearance sweep
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  v_result := public.reconcile_affiliate_commissions(200);
  PERFORM public.assign_order_invoice_metadata(v_ob, now());
  v_promoted := public.promote_cleared_affiliate_commissions();
  SELECT c.commission_rate_snapshot AS rate, c.commission_amount_cents AS amount, c.clears_at, c.status::text AS status
    INTO ca FROM public.affiliate_commissions c WHERE c.order_id = v_oa;
  SELECT c.commission_rate_snapshot AS rate, c.commission_amount_cents AS amount, c.clears_at, c.status::text AS status, o.paid_at
    INTO cb FROM public.affiliate_commissions c JOIN public.orders o ON o.id = c.order_id WHERE c.order_id = v_ob;
  SELECT c.commission_rate_snapshot AS rate, c.commission_amount_cents AS amount, c.clears_at, c.status::text AS status, o.paid_at
    INTO cc FROM public.affiliate_commissions c JOIN public.orders o ON o.id = c.order_id WHERE c.order_id = v_oc;
  SELECT c.commission_rate_snapshot AS rate, c.commission_amount_cents AS amount, c.status::text AS status
    INTO cd FROM public.affiliate_commissions c WHERE c.order_id = v_od;
  SELECT c.status::text AS status, c.disputed_at, c.clears_at INTO ce FROM public.affiliate_commissions c WHERE c.order_id = v_oe;
  SELECT c.status::text AS status, c.disputed_at INTO cf FROM public.affiliate_commissions c WHERE c.order_id = v_of;
  -- v_oe's dispute closes without a loss: the order's mark and the commission's hold go together,
  -- and the next promote clears it
  dis_close := public.set_affiliate_commission_dispute('STRIPE', v_oe, false);
  PERFORM public.promote_cleared_affiliate_commissions();
  SELECT o.affiliate_disputed_at INTO v_flag_e_after FROM public.orders o WHERE o.id = v_oe;
  SELECT c.disputed_at IS NOT NULL, c.status::text INTO v_e_held_after, v_e_status_after
    FROM public.affiliate_commissions c WHERE c.order_id = v_oe;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);

  outcomes_ok := res_missing = 'not_found' AND res_no_tier = 'tier_not_found' AND res_off = 'tier_inactive'
    AND res_full = 'tier_full' AND res_full_explicit = 'tier_full' AND v_still = v_tier0;
  over_ok := res_over = 'moved' AND v_mfull_over = 1;
  moved_ok := res_a = 'moved' AND res_same = 'unchanged' AND v_tier_now = v_tier_a AND v_status3 = 'SUSPENDED'
    AND v_changed0 IS NULL AND v_changed1 = now() AND v_m0_after = v_m0 - 1 AND v_ma = 1 AND v_mfull_after = 0;
  stored_ok := v_rate_unpaid IS NULL AND v_hold_unpaid IS NULL AND v_rate_a = 12.5 AND v_hold_a = 10
    AND v_paid_a = now() - interval '3 days' AND n_paused = 0 AND v_rate_d = 5 AND v_hold_d = 0;
  kept_ok := res_b = 'moved' AND coalesce((v_result ->> 'recorded')::integer, 0) >= 3
    AND ca.rate = 12.5 AND ca.amount = 1250 AND ca.clears_at = v_paid_a + make_interval(days => 10) AND ca.status = 'PENDING_CLEARANCE';
  new_rate_ok := cb.rate = 40 AND cb.amount = 4000 AND cb.clears_at = cb.paid_at + make_interval(days => 20)
    AND cb.status = 'PENDING_CLEARANCE';
  late_ok := v_promoted >= 2 AND cc.rate = 40 AND cc.amount = 2000 AND cc.clears_at = cc.paid_at + make_interval(days => 20)
    AND cc.clears_at <= now() AND cc.status = 'CLEARED' AND cd.rate = 5 AND cd.amount = 250 AND cd.status = 'CLEARED';
  dispute_hold_ok := dis_open = 'held' AND dis_again = 'held' AND v_flag_e IS NOT NULL AND n_disputed = 0
    AND ce.status = 'PENDING_CLEARANCE' AND ce.disputed_at = v_flag_e AND ce.clears_at <= now();
  dispute_release_ok := dis_won_open = 'held' AND dis_won_close = 'released' AND v_flag_f IS NULL
    AND cf.status = 'CLEARED' AND cf.disputed_at IS NULL
    AND dis_close = 'released' AND v_flag_e_after IS NULL AND v_e_held_after IS FALSE AND v_e_status_after = 'CLEARED';

  RAISE NOTICE '%  anon / authenticated cannot EXECUTE change_affiliate_partner_tier or the orders rate trigger function; service_role can EXECUTE the RPC%', CASE WHEN rpc_api IS NULL AND rpc_svc THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (' || rpc_api || ')', '');
  RAISE NOTICE '%  the rate trigger fires BEFORE INSERT OR UPDATE OF paid_at on orders, for each row, enabled', CASE WHEN trig_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  a partner session cannot write tier_changed_at: refused by the column grant, and by the profile guard behind it', CASE WHEN NOT col_grant AND denied_grant AND denied_guard THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  change_affiliate_partner_tier answers not_found, tier_not_found, tier_inactive and tier_full, and moves nobody%', CASE WHEN outcomes_ok THEN 'PASS' ELSE 'FAIL' END,
    CASE WHEN outcomes_ok THEN '' ELSE format(' (got %s / %s / %s / %s / %s)', coalesce(res_missing, '-'), coalesce(res_no_tier, '-'), coalesce(res_off, '-'), coalesce(res_full, '-'), coalesce(res_full_explicit, '-')) END;
  RAISE NOTICE '%  a full capped tier takes the partner only with p_allow_over_cap (member_count then above the cap)', CASE WHEN over_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  a paused partner moves (moved, then unchanged): member counts follow and the guard stamps tier_changed_at', CASE WHEN moved_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  the orders trigger stores the tier''s rate and hold when an attributed order is paid, a paused partner''s too (no commission then), and keeps a rate the statement wrote', CASE WHEN stored_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  a commission recorded after a tier move and a rate edit (reconcile, after the pause) keeps the rate of the payment, and its hold counts from the payment', CASE WHEN kept_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  an order paid after the move earns the new tier''s rate, with the new hold from its payment (the paid trigger)', CASE WHEN new_rate_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  a commission recorded after its hold has passed clears at the next promote, and a rate stored on the order wins over the tier''s', CASE WHEN late_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  a dispute that opens before the order has a commission is kept on the order (held), and the commission reconcile records after the pause starts held: not promoted, though its hold has passed', CASE WHEN dispute_hold_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  closing that dispute without a loss lifts the order''s mark and the commission''s hold (then promoted); one won before the commission leaves no hold', CASE WHEN dispute_release_ok THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- 40. affiliates (02036): commissions paid outside Stripe. The manual payout lifecycle
--     (claim_manual_affiliate_payout, record_manual_affiliate_payout, cancel_manual_affiliate_payout)
--     and the five-argument claim_affiliate_payout() are service-role only (one claim overload, no
--     stale record overload); a manual payout is prepared (PROCESSING) or recorded (COMPLETED), never
--     FAILED, carries no Stripe field, names its channel and reference once recorded, and there is
--     one prepared per partner and currency; a Stripe payout keeps its destination; payout_email is
--     written by the server only (no API grant; the profile guard refuses it from a partner session;
--     no leading = + - @) and nobody but the service role writes a payout column. The claim refuses
--     an unknown, paused or unapproved partner, bad input and a sum below the minimum, and reserves
--     exactly the live, cleared, unattached, undisputed commissions of the gateways it is given; what
--     clears later stays out, a refund while prepared is flagged and alerted with the "prepared"
--     advice, a dispute only holds. The record completes exactly the prepared payout (even for a
--     partner paused since), marks its commissions PAID and moves total_paid_cents; it refuses bad
--     input, an unknown or Stripe payout, a second record and a reused reference. The cancel applies
--     the pending refund, hands the rest back and deletes the row; it refuses a recorded payout. The
--     Stripe RPCs can neither complete, fail, retry nor release a manual payout. The claim with
--     p_gateways => '{STRIPE}' never takes a Freemius commission; a refund after a recorded manual
--     payout alerts with the recovery advice. Uses its own partner (five), live-mode orders (test
--     mode for one), and section 36's partner two.
RESET ROLE;
DO $$
DECLARE
  v_rtl5 uuid := 'aa000000-0000-0000-0000-00000000af05';
  v_rtl2 uuid := 'aa000000-0000-0000-0000-00000000af02';
  v_cust uuid := 'aa000000-0000-0000-0000-00000000cc01';
  v_admin uuid := 'aa000000-0000-0000-0000-0000000000a1';
  v_f1 uuid := 'aa000000-0000-0000-0000-00000000b141';  -- Freemius, live: prepared, recorded, then refunded
  v_f2 uuid := 'aa000000-0000-0000-0000-00000000b142';  -- Freemius, live: refunded while its payout was prepared
  v_ft uuid := 'aa000000-0000-0000-0000-00000000b143';  -- Freemius, test mode: never paid with real money
  v_fd uuid := 'aa000000-0000-0000-0000-00000000b144';  -- Freemius, live, disputed: held
  v_s1 uuid := 'aa000000-0000-0000-0000-00000000b145';  -- Stripe, live: left to the Stripe claim
  v_f4 uuid := 'aa000000-0000-0000-0000-00000000b146';  -- Freemius, live, cleared before the Stripe claim
  v_f3 uuid := 'aa000000-0000-0000-0000-00000000b147';  -- Freemius, live, cleared after the first payout was prepared
  v_email jsonb := '{"email":"sv-customer@test.local"}';
  v_claim_manual text := 'public.claim_manual_affiliate_payout(uuid, text, bigint, public.affiliate_gateway[])';
  v_rec text := 'public.record_manual_affiliate_payout(uuid, text, text, text, uuid)';
  v_cancel text := 'public.cancel_manual_affiliate_payout(uuid)';
  v_claim text := 'public.claim_affiliate_payout(uuid, text, bigint, text, public.affiliate_gateway[])';
  v_freemius public.affiliate_gateway[] := ARRAY['FREEMIUS']::public.affiliate_gateway[];
  v_prepared_advice text := 'Its manual payout is prepared but not recorded yet: if you have not sent it, cancel it under Pay manually and prepare it again; if you already sent it, record it, then recover the amount from the partner, for example by asking them to send it back.';
  v_recorded_advice text := 'Recover the amount from the partner, for example by asking them to send it back.';
  missing text; rpc_api text; rpc_svc boolean; n_claims integer; v_aff5 uuid; v_aff2 uuid; v_old_record regprocedure;
  col_grants text; email_grant_denied boolean := false; email_guard_denied boolean := false; email_other_denied boolean := false;
  email_anon_denied boolean := false; email_server_ok boolean := false; email_check_ok boolean := false; email_formula_refused boolean := false;
  payout_update_denied boolean := false; payout_insert_denied boolean := false; payout_anon_denied boolean := false; v_own_read integer;
  manual_failed_refused boolean := false; manual_dest_refused boolean := false; manual_unrecorded_refused boolean := false;
  stripe_dest_refused boolean := false; prepared_unique_refused boolean := false;
  res_missing jsonb; res_paused jsonb; res_unapproved jsonb; res_currency jsonb; res_below jsonb;
  res_prepared jsonb; res_again jsonb; res_prep2 jsonb; res_prep3 jsonb;
  res_r_channel jsonb; res_r_reference jsonb; res_r_missing jsonb; res_r_stripe jsonb; res_recorded jsonb; res_r_again jsonb; res_dup jsonb;
  res_cancel jsonb; res_cancel_recorded jsonb; res_cancel_missing jsonb; res_cancel_stripe jsonb; res_cancel3 jsonb;
  res_refund2 text; res_refund3 text; res_refund text; res_dispute_open text; res_dispute_close text;
  v_sum bigint; v_paid0 bigint; v_paid1 bigint; v_payouts_before integer; v_payouts_after_below integer;
  v_payout uuid; v_payout2 uuid; v_payout3 uuid; v_stripe_payout uuid; p record; v_f3_net bigint; v_f3_after record;
  complete_refused boolean := false; fail_refused boolean := false; n_retry integer; v_released boolean; v_p3_after record;
  v_claimed record; v_s1_payout uuid; v_f4_after_stripe uuid; v_default_claim uuid; v_f4_after_default uuid;
  n_alert integer; n_alert_prepared integer;
  catalog_ok boolean := false; rows_ok boolean := false; email_ok boolean := false; payout_cols_ok boolean := false;
  claim_refusals_ok boolean := false; claim_scope_ok boolean := false; in_flight_ok boolean := false;
  record_refusals_ok boolean := false; recorded_ok boolean := false; cancel_ok boolean := false;
  stripe_guard_ok boolean := false; claim_ok boolean := false; alert_ok boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  SELECT string_agg(m.f, ', ') INTO missing
    FROM (SELECT f FROM unnest(ARRAY[v_claim_manual, v_rec, v_cancel, v_claim]) AS f WHERE to_regprocedure(f) IS NULL
          UNION ALL
          SELECT c FROM unnest(ARRAY['affiliate_payouts.method', 'affiliate_payouts.manual_channel', 'affiliate_payouts.external_reference',
                                     'affiliate_payouts.note', 'affiliate_payouts.recorded_by', 'affiliate_profiles.payout_email']) AS c
           WHERE NOT EXISTS (
             SELECT 1 FROM pg_attribute a
              WHERE a.attrelid = to_regclass('public.' || split_part(c, '.', 1))
                AND a.attname = split_part(c, '.', 2) AND a.attnum > 0 AND NOT a.attisdropped)) AS m;
  IF missing IS NOT NULL THEN
    RAISE NOTICE 'FAIL  the 02036 columns and functions exist (missing: %)', missing;
    RETURN;
  END IF;
  SELECT p2.id INTO v_aff2 FROM public.affiliate_profiles p2 WHERE p2.user_id = v_rtl2;
  IF v_aff2 IS NULL THEN
    RAISE NOTICE 'FAIL  the section 36 partner two exists';
    RETURN;
  END IF;

  -- the catalog: who may call what, one claim overload, no record overload of the first 02036 draft
  SELECT string_agg(format('%s to %s', f, r.role), ', ') INTO rpc_api
    FROM unnest(ARRAY[v_claim_manual, v_rec, v_cancel, v_claim]) AS f CROSS JOIN unnest(ARRAY['anon', 'authenticated']::name[]) AS r(role)
   WHERE has_function_privilege(r.role, to_regprocedure(f), 'EXECUTE');
  rpc_svc := has_function_privilege('service_role', to_regprocedure(v_claim_manual), 'EXECUTE')
    AND has_function_privilege('service_role', to_regprocedure(v_rec), 'EXECUTE')
    AND has_function_privilege('service_role', to_regprocedure(v_cancel), 'EXECUTE')
    AND has_function_privilege('service_role', to_regprocedure(v_claim), 'EXECUTE');
  SELECT count(*) INTO n_claims FROM pg_proc pr WHERE pr.pronamespace = 'public'::regnamespace AND pr.proname = 'claim_affiliate_payout';
  v_old_record := to_regprocedure('public.record_manual_affiliate_payout(uuid, text, bigint, text, text, text, uuid, public.affiliate_gateway[])');
  SELECT string_agg(format('%s.%s %s to %s', t, c, priv, r.role), ', ') INTO col_grants
    FROM (VALUES ('affiliate_profiles', 'payout_email'), ('affiliate_payouts', 'method'), ('affiliate_payouts', 'manual_channel'),
                 ('affiliate_payouts', 'external_reference'), ('affiliate_payouts', 'note'), ('affiliate_payouts', 'recorded_by')) AS x(t, c)
    CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE']) AS priv
    CROSS JOIN unnest(ARRAY['anon', 'authenticated']::name[]) AS r(role)
   WHERE has_column_privilege(r.role, ('public.' || t)::regclass, c, priv);
  catalog_ok := rpc_api IS NULL AND rpc_svc AND n_claims = 1 AND v_old_record IS NULL;

  -- fixtures (as the table owner): partner five, signed up as the service role and approved
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  VALUES (v_rtl5, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sv-partner5@test.local', 'x', now(), now(), '{}', '{"full_name":"SV Partner Five"}')
  ON CONFLICT (id) DO NOTHING;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  PERFORM public.create_affiliate_account(v_rtl5, 'sv-partner-five', 'SV Partner Five', 'en', 'SV five', '', NULL, NULL);
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  UPDATE public.affiliate_profiles
     SET page_submitted_at = now() - interval '3 days', first_published_at = now() - interval '2 days'
   WHERE user_id = v_rtl5;
  SELECT p5.id INTO v_aff5 FROM public.affiliate_profiles p5 WHERE p5.user_id = v_rtl5;

  -- payout rows: a manual one is never FAILED, never carries a Stripe field and names its channel and
  -- reference once COMPLETED; a Stripe one keeps its destination
  BEGIN
    INSERT INTO public.affiliate_payouts (affiliate_id, amount_cents, currency, method, status, failure_reason)
    VALUES (v_aff5, 100, 'USD', 'manual', 'FAILED', 'released');
  EXCEPTION WHEN check_violation THEN manual_failed_refused := true;
  END;
  BEGIN
    INSERT INTO public.affiliate_payouts (affiliate_id, amount_cents, currency, method, status, stripe_destination_account)
    VALUES (v_aff5, 100, 'USD', 'manual', 'PROCESSING', 'acct_svposture5');
  EXCEPTION WHEN check_violation THEN manual_dest_refused := true;
  END;
  BEGIN
    INSERT INTO public.affiliate_payouts (affiliate_id, amount_cents, currency, method, status, paid_at)
    VALUES (v_aff5, 100, 'USD', 'manual', 'COMPLETED', now());
  EXCEPTION WHEN check_violation THEN manual_unrecorded_refused := true;
  END;
  BEGIN
    INSERT INTO public.affiliate_payouts (affiliate_id, amount_cents, currency, method, status, stripe_destination_account)
    VALUES (v_aff5, 100, 'USD', 'stripe_connect', 'PROCESSING', NULL);
  EXCEPTION WHEN check_violation THEN stripe_dest_refused := true;
  END;

  -- payout_email: refused for partner five's own session (the grant, then the guard behind it with
  -- table rights), for partner two and for anon; the server writes it, and its CHECK refuses a
  -- malformed address and one a spreadsheet would read as a formula
  PERFORM set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated","aal":"aal1"}', v_rtl5), true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    UPDATE public.affiliate_profiles SET payout_email = 'sv-five@paypal.example' WHERE user_id = v_rtl5;
  EXCEPTION WHEN insufficient_privilege THEN email_grant_denied := SQLERRM LIKE 'permission denied%';
  END;
  BEGIN
    UPDATE public.affiliate_payouts SET note = 'SV forged note' WHERE affiliate_id = v_aff5;
  EXCEPTION WHEN insufficient_privilege THEN payout_update_denied := SQLERRM LIKE 'permission denied%';
  END;
  BEGIN
    INSERT INTO public.affiliate_payouts (affiliate_id, amount_cents, currency, method, manual_channel, external_reference, status, paid_at)
    VALUES (v_aff5, 999999, 'USD', 'manual', 'paypal', 'SV-FORGED', 'COMPLETED', now());
  EXCEPTION WHEN insufficient_privilege THEN payout_insert_denied := SQLERRM LIKE 'permission denied%';
  END;
  EXECUTE 'SET LOCAL ROLE service_role';
  BEGIN
    UPDATE public.affiliate_profiles SET payout_email = 'sv-five@paypal.example' WHERE user_id = v_rtl5;
  EXCEPTION WHEN insufficient_privilege THEN email_guard_denied := SQLERRM = 'affiliate_profile_field_protected';
  END;
  PERFORM set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated","aal":"aal1"}', v_rtl2), true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    UPDATE public.affiliate_profiles SET payout_email = 'sv-hijack@paypal.example' WHERE user_id = v_rtl5;
  EXCEPTION WHEN insufficient_privilege THEN email_other_denied := SQLERRM LIKE 'permission denied%';
  END;
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  EXECUTE 'SET LOCAL ROLE anon';
  BEGIN
    UPDATE public.affiliate_profiles SET payout_email = 'sv-hijack@paypal.example' WHERE user_id = v_rtl5;
  EXCEPTION WHEN insufficient_privilege THEN email_anon_denied := SQLERRM LIKE 'permission denied%';
  END;
  BEGIN
    UPDATE public.affiliate_payouts SET note = 'SV forged note' WHERE affiliate_id = v_aff5;
  EXCEPTION WHEN insufficient_privilege THEN payout_anon_denied := SQLERRM LIKE 'permission denied%';
  END;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  PERFORM set_config('request.jwt.claims', '', true);
  UPDATE public.affiliate_profiles SET payout_email = 'sv-five@paypal.example' WHERE user_id = v_rtl5;
  email_server_ok := FOUND;
  BEGIN
    UPDATE public.affiliate_profiles SET payout_email = 'two words@paypal.example' WHERE user_id = v_rtl5;
  EXCEPTION WHEN check_violation THEN email_check_ok := true;
  END;
  BEGIN
    UPDATE public.affiliate_profiles SET payout_email = '+sv-five@paypal.example' WHERE user_id = v_rtl5;
  EXCEPTION WHEN check_violation THEN email_formula_refused := true;
  END;
  email_ok := col_grants IS NULL AND email_grant_denied AND email_guard_denied AND email_other_denied AND email_anon_denied
    AND email_server_ok AND email_check_ok AND email_formula_refused
    AND (SELECT pe.payout_email FROM public.affiliate_profiles pe WHERE pe.id = v_aff5) = 'sv-five@paypal.example';

  -- live orders paid to partner five (one in test mode), each recorded by the paid trigger, then cleared
  EXECUTE 'RESET ROLE';
  INSERT INTO public.orders (id, user_id, status, total, subtotal, discount_total, currency, provider, customer_details,
                             affiliate_id, affiliate_source, affiliate_base_currency, affiliate_livemode)
  VALUES
    (v_f1, v_cust, 'paid', 10000, 10000, 0, 'USD', 'freemius', v_email, v_aff5, 'storefront', 'USD', true),
    (v_f2, v_cust, 'paid', 6000, 6000, 0, 'USD', 'freemius', v_email, v_aff5, 'storefront', 'USD', true),
    (v_ft, v_cust, 'paid', 7000, 7000, 0, 'USD', 'freemius', v_email, v_aff5, 'storefront', 'USD', false),
    (v_fd, v_cust, 'paid', 8000, 8000, 0, 'USD', 'freemius', v_email, v_aff5, 'storefront', 'USD', true),
    (v_s1, v_cust, 'paid', 9000, 9000, 0, 'USD', 'stripe', v_email, v_aff5, 'referral_link', 'USD', true)
  ON CONFLICT (id) DO NOTHING;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  PERFORM public.assign_order_invoice_metadata(o, now()) FROM unnest(ARRAY[v_f1, v_f2, v_ft, v_fd, v_s1]) AS o;
  UPDATE public.affiliate_commissions SET clears_at = now() - interval '1 minute' WHERE order_id IN (v_f1, v_f2, v_ft, v_fd, v_s1);
  PERFORM public.promote_cleared_affiliate_commissions();
  PERFORM public.set_affiliate_commission_dispute('FREEMIUS', v_fd, true);
  SELECT coalesce(sum(c.commission_amount_cents - c.refunded_amount_cents), 0)::bigint INTO v_sum
    FROM public.affiliate_commissions c WHERE c.order_id IN (v_f1, v_f2);
  SELECT pr5.total_paid_cents INTO v_paid0 FROM public.affiliate_profiles pr5 WHERE pr5.id = v_aff5;
  SELECT count(*) INTO v_payouts_before FROM public.affiliate_payouts po WHERE po.affiliate_id = v_aff5;

  -- the claim's refusals: unknown partner, paused, never approved, bad currency, below the minimum
  res_missing := public.claim_manual_affiliate_payout(gen_random_uuid(), 'USD', 0, v_freemius);
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  UPDATE public.affiliate_profiles SET status = 'SUSPENDED', suspended_reason = 'SV posture' WHERE id = v_aff5;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  res_paused := public.claim_manual_affiliate_payout(v_aff5, 'USD', 0, v_freemius);
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  UPDATE public.affiliate_profiles SET status = 'ACTIVE', suspended_reason = NULL WHERE id = v_aff5;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  res_unapproved := public.claim_manual_affiliate_payout(v_aff2, 'USD', 0, NULL);
  res_currency := public.claim_manual_affiliate_payout(v_aff5, 'US', 0, v_freemius);
  res_below := public.claim_manual_affiliate_payout(v_aff5, 'USD', v_sum + 1, v_freemius);
  SELECT count(*) INTO v_payouts_after_below FROM public.affiliate_payouts po WHERE po.affiliate_id = v_aff5;
  claim_refusals_ok := res_missing ->> 'status' = 'not_found' AND res_paused ->> 'status' = 'not_eligible'
    AND res_unapproved ->> 'status' = 'not_eligible' AND res_currency ->> 'status' = 'invalid_input'
    AND res_below ->> 'status' = 'below_minimum' AND (res_below ->> 'amount_cents')::bigint = v_sum
    AND (res_below ->> 'commission_count')::integer = 2 AND v_payouts_after_below = v_payouts_before;

  -- the claim: exactly v_f1 and v_f2 (live, cleared, undisputed, Freemius) reserved in one PROCESSING manual payout
  res_prepared := public.claim_manual_affiliate_payout(v_aff5, 'usd', 0, v_freemius);
  v_payout := (res_prepared ->> 'payout_id')::uuid;
  SELECT po.method, po.status::text AS status, po.manual_channel, po.external_reference, po.livemode, po.stripe_destination_account,
         po.stripe_transfer_id, po.amount_cents, po.paid_at, po.trigger
    INTO p FROM public.affiliate_payouts po WHERE po.id = v_payout;
  res_again := public.claim_manual_affiliate_payout(v_aff5, 'USD', 0, v_freemius);
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    INSERT INTO public.affiliate_payouts (affiliate_id, amount_cents, currency, method, status)
    VALUES (v_aff5, 100, 'USD', 'manual', 'PROCESSING');
  EXCEPTION WHEN unique_violation THEN prepared_unique_refused := true;
  END;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  rows_ok := manual_failed_refused AND manual_dest_refused AND manual_unrecorded_refused AND stripe_dest_refused AND prepared_unique_refused;
  claim_scope_ok := res_prepared ->> 'status' = 'prepared' AND (res_prepared ->> 'amount_cents')::bigint = v_sum
    AND (res_prepared ->> 'commission_count')::integer = 2
    AND p.method = 'manual' AND p.status = 'PROCESSING' AND p.manual_channel IS NULL AND p.external_reference IS NULL AND p.livemode
    AND p.stripe_destination_account IS NULL AND p.stripe_transfer_id IS NULL AND p.amount_cents = v_sum AND p.paid_at IS NULL
    AND p.trigger = 'admin'
    AND (SELECT count(*) FROM public.affiliate_commissions c
          WHERE c.payout_id = v_payout AND c.order_id IN (v_f1, v_f2) AND c.status = 'CLEARED'::public.affiliate_commission_status) = 2
    AND (SELECT count(*) FROM public.affiliate_commissions c WHERE c.payout_id = v_payout) = 2
    AND (SELECT count(*) FROM public.affiliate_commissions c WHERE c.order_id IN (v_ft, v_fd, v_s1) AND c.payout_id IS NULL) = 3
    AND (SELECT pr5.total_paid_cents FROM public.affiliate_profiles pr5 WHERE pr5.id = v_aff5) = v_paid0
    AND res_again ->> 'status' = 'already_prepared' AND (res_again ->> 'payout_id')::uuid = v_payout;

  -- while it is prepared: a commission that clears later stays out of it; a full refund flags and
  -- alerts (the "prepared" advice, payout_status PROCESSING); a dispute holds and its release keeps
  -- the commission in the payout (it never comes back to what is owed)
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  INSERT INTO public.orders (id, user_id, status, total, subtotal, discount_total, currency, provider, customer_details,
                             affiliate_id, affiliate_source, affiliate_base_currency, affiliate_livemode)
  VALUES (v_f3, v_cust, 'paid', 5000, 5000, 0, 'USD', 'freemius', v_email, v_aff5, 'storefront', 'USD', true)
  ON CONFLICT (id) DO NOTHING;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  PERFORM public.assign_order_invoice_metadata(v_f3, now());
  UPDATE public.affiliate_commissions SET clears_at = now() - interval '1 minute' WHERE order_id = v_f3;
  PERFORM public.promote_cleared_affiliate_commissions();
  SELECT c.commission_amount_cents - c.refunded_amount_cents INTO v_f3_net FROM public.affiliate_commissions c WHERE c.order_id = v_f3;
  res_refund2 := public.apply_affiliate_refund('FREEMIUS', v_f2, 6000, 6000, true);
  SELECT count(*) INTO n_alert_prepared
    FROM public.system_alerts a
    JOIN public.affiliate_commissions c ON c.id::text = a.metadata ->> 'commission_id'
   WHERE a.alert_type = 'affiliate_refund_after_payout' AND NOT a.is_resolved AND c.order_id = v_f2
     AND a.metadata ->> 'payout_method' = 'manual' AND a.metadata ->> 'payout_status' = 'PROCESSING'
     AND a.metadata ->> 'payout_id' = v_payout::text
     AND a.message = format('Order %s was refunded after its commission was paid or queued. %s', v_f2, v_prepared_advice)
     AND c.void_requested_at IS NOT NULL AND c.status = 'CLEARED'::public.affiliate_commission_status AND c.payout_id = v_payout;
  res_dispute_open := public.set_affiliate_commission_dispute('FREEMIUS', v_f1, true);
  res_dispute_close := public.set_affiliate_commission_dispute('FREEMIUS', v_f1, false);
  in_flight_ok := v_f3_net > 0
    AND (SELECT c.payout_id IS NULL AND c.status = 'CLEARED'::public.affiliate_commission_status FROM public.affiliate_commissions c WHERE c.order_id = v_f3)
    AND (SELECT po.amount_cents FROM public.affiliate_payouts po WHERE po.id = v_payout) = v_sum
    AND res_refund2 = 'alerted' AND n_alert_prepared = 1
    AND res_dispute_open = 'held' AND res_dispute_close = 'released'
    AND (SELECT c.payout_id = v_payout AND c.disputed_at IS NULL FROM public.affiliate_commissions c WHERE c.order_id = v_f1);

  -- the record's refusals: an unknown channel, an empty reference, an unknown payout, a Stripe payout
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  INSERT INTO public.affiliate_payouts (affiliate_id, amount_cents, currency, stripe_destination_account, status)
  VALUES (v_aff5, 100, 'USD', 'acct_svposture5', 'FAILED')
  RETURNING id INTO v_stripe_payout;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  res_r_channel := public.record_manual_affiliate_payout(v_payout, 'venmo', 'SV-REF-001', NULL, v_admin);
  res_r_reference := public.record_manual_affiliate_payout(v_payout, 'paypal', '   ', NULL, v_admin);
  res_r_missing := public.record_manual_affiliate_payout(gen_random_uuid(), 'paypal', 'SV-REF-001', NULL, v_admin);
  res_r_stripe := public.record_manual_affiliate_payout(v_stripe_payout, 'paypal', 'SV-REF-001', NULL, v_admin);
  res_cancel_stripe := public.cancel_manual_affiliate_payout(v_stripe_payout);
  record_refusals_ok := res_r_channel ->> 'status' = 'invalid_input' AND res_r_reference ->> 'status' = 'reference_required'
    AND res_r_missing ->> 'status' = 'not_found' AND res_r_stripe ->> 'status' = 'not_found'
    AND res_cancel_stripe ->> 'status' = 'not_found'
    AND (SELECT po.status::text = 'PROCESSING' FROM public.affiliate_payouts po WHERE po.id = v_payout)
    AND (SELECT po.status::text = 'FAILED' AND po.method = 'stripe_connect' FROM public.affiliate_payouts po WHERE po.id = v_stripe_payout);
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  DELETE FROM public.affiliate_payouts WHERE id = v_stripe_payout;

  -- the record of exactly that payout, for a partner paused since it was prepared (the money left)
  UPDATE public.affiliate_profiles SET status = 'SUSPENDED', suspended_reason = 'SV posture' WHERE id = v_aff5;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  res_recorded := public.record_manual_affiliate_payout(v_payout, 'PAYPAL', ' SV-REF-001 ', ' SV note ', v_admin);
  res_r_again := public.record_manual_affiliate_payout(v_payout, 'paypal', 'SV-REF-009', NULL, v_admin);
  SELECT po.method, po.status::text AS status, po.manual_channel, po.external_reference, po.note, po.recorded_by, po.livemode,
         po.stripe_destination_account, po.stripe_transfer_id, po.amount_cents, po.paid_at
    INTO p FROM public.affiliate_payouts po WHERE po.id = v_payout;
  SELECT pr5.total_paid_cents INTO v_paid1 FROM public.affiliate_profiles pr5 WHERE pr5.id = v_aff5;
  recorded_ok := res_recorded ->> 'status' = 'recorded' AND (res_recorded ->> 'payout_id')::uuid = v_payout
    AND (res_recorded ->> 'affiliate_id')::uuid = v_aff5 AND (res_recorded ->> 'amount_cents')::bigint = v_sum
    AND res_recorded ->> 'currency' = 'USD' AND (res_recorded ->> 'commission_count')::integer = 2
    AND p.method = 'manual' AND p.status = 'COMPLETED' AND p.manual_channel = 'paypal' AND p.external_reference = 'SV-REF-001'
    AND p.note = 'SV note' AND p.recorded_by = v_admin AND p.livemode AND p.stripe_destination_account IS NULL
    AND p.stripe_transfer_id IS NULL AND p.amount_cents = v_sum AND p.paid_at IS NOT NULL
    AND (SELECT count(*) FROM public.affiliate_commissions c
          WHERE c.payout_id = v_payout AND c.order_id IN (v_f1, v_f2) AND c.status = 'PAID'::public.affiliate_commission_status
            AND c.paid_at IS NOT NULL) = 2
    AND (SELECT c.payout_id IS NULL AND c.status = 'CLEARED'::public.affiliate_commission_status FROM public.affiliate_commissions c WHERE c.order_id = v_f3)
    AND v_paid1 = v_paid0 + v_sum
    AND res_r_again ->> 'status' = 'already_recorded';
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  UPDATE public.affiliate_profiles SET status = 'ACTIVE', suspended_reason = NULL WHERE id = v_aff5;

  -- the partner reads its own manual payout, note included
  PERFORM set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated","aal":"aal1"}', v_rtl5), true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_own_read FROM public.affiliate_payouts po WHERE po.method = 'manual' AND po.note = 'SV note';
  payout_cols_ok := payout_update_denied AND payout_insert_denied AND payout_anon_denied AND v_own_read = 1;

  -- a second prepared payout (v_f3): a reused reference is refused (case ignored); a partial refund while
  -- it is prepared is applied by the cancel, which hands the commission back and deletes the payout
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  res_prep2 := public.claim_manual_affiliate_payout(v_aff5, 'USD', 0, v_freemius);
  v_payout2 := (res_prep2 ->> 'payout_id')::uuid;
  res_dup := public.record_manual_affiliate_payout(v_payout2, 'interac', ' sv-ref-001 ', NULL, v_admin);
  res_refund3 := public.apply_affiliate_refund('FREEMIUS', v_f3, 2500, 5000, false);
  res_cancel := public.cancel_manual_affiliate_payout(v_payout2);
  res_cancel_recorded := public.cancel_manual_affiliate_payout(v_payout);
  res_cancel_missing := public.cancel_manual_affiliate_payout(v_payout2);
  SELECT c.payout_id, c.status::text AS status, c.refunded_amount_cents, c.refund_pending_cents, c.commission_amount_cents
    INTO v_f3_after FROM public.affiliate_commissions c WHERE c.order_id = v_f3;
  cancel_ok := res_prep2 ->> 'status' = 'prepared' AND (res_prep2 ->> 'amount_cents')::bigint = v_f3_net
    AND (res_prep2 ->> 'commission_count')::integer = 1
    AND res_dup ->> 'status' = 'duplicate_reference'
    AND res_refund3 = 'alerted'
    AND res_cancel ->> 'status' = 'cancelled' AND (res_cancel ->> 'commission_count')::integer = 1
    AND NOT EXISTS (SELECT 1 FROM public.affiliate_payouts po WHERE po.id = v_payout2)
    AND v_f3_after.payout_id IS NULL AND v_f3_after.status = 'CLEARED'
    AND v_f3_after.refunded_amount_cents > 0 AND v_f3_after.refunded_amount_cents < v_f3_after.commission_amount_cents
    AND v_f3_after.refunded_amount_cents = v_f3_after.refund_pending_cents
    AND res_cancel_recorded ->> 'status' = 'already_recorded'
    AND res_cancel_missing ->> 'status' = 'not_found'
    AND (SELECT po.status::text = 'COMPLETED' FROM public.affiliate_payouts po WHERE po.id = v_payout);

  -- the Stripe RPCs never complete, fail, retry or release a manual payout (a third one, then cancelled)
  res_prep3 := public.claim_manual_affiliate_payout(v_aff5, 'USD', 0, v_freemius);
  v_payout3 := (res_prep3 ->> 'payout_id')::uuid;
  BEGIN
    PERFORM public.complete_affiliate_payout(v_payout3, 'tr_svposture5');
  EXCEPTION WHEN check_violation THEN complete_refused := true;
  END;
  BEGIN
    PERFORM public.fail_affiliate_payout(v_payout3, 'stale');
  EXCEPTION WHEN check_violation THEN fail_refused := true;
  END;
  SELECT count(*) INTO n_retry FROM public.prepare_affiliate_payout_retry(v_payout3, 0) AS r;
  v_released := public.release_affiliate_payout(v_payout3);
  SELECT po.status::text AS status, po.stripe_transfer_id,
         (SELECT count(*) FROM public.affiliate_commissions c WHERE c.payout_id = po.id) AS attached
    INTO v_p3_after FROM public.affiliate_payouts po WHERE po.id = v_payout3;
  res_cancel3 := public.cancel_manual_affiliate_payout(v_payout3);
  stripe_guard_ok := res_prep3 ->> 'status' = 'prepared' AND complete_refused AND fail_refused AND n_retry = 0 AND v_released = false
    AND v_p3_after.status = 'PROCESSING' AND v_p3_after.stripe_transfer_id IS NULL AND v_p3_after.attached = 1
    AND res_cancel3 ->> 'status' = 'cancelled';

  -- the Stripe claim of the gateways routed to Stripe: a Connect account (live), a Freemius commission cleared since
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  UPDATE public.affiliate_profiles
     SET stripe_connect_account_id = 'acct_svposture5', stripe_connect_livemode = true,
         stripe_connect_onboarding_complete = true, payout_configured_at = now()
   WHERE id = v_aff5;
  INSERT INTO public.orders (id, user_id, status, total, subtotal, discount_total, currency, provider, customer_details,
                             affiliate_id, affiliate_source, affiliate_base_currency, affiliate_livemode)
  VALUES (v_f4, v_cust, 'paid', 5000, 5000, 0, 'USD', 'freemius', v_email, v_aff5, 'storefront', 'USD', true)
  ON CONFLICT (id) DO NOTHING;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  PERFORM public.assign_order_invoice_metadata(v_f4, now());
  UPDATE public.affiliate_commissions SET clears_at = now() - interval '1 minute' WHERE order_id = v_f4;
  PERFORM public.promote_cleared_affiliate_commissions();
  SELECT po.id, po.amount_cents INTO v_claimed
    FROM public.claim_affiliate_payout(v_aff5, 'USD', 1, 'cron', ARRAY['STRIPE']::public.affiliate_gateway[]) AS po;
  SELECT c.payout_id INTO v_s1_payout FROM public.affiliate_commissions c WHERE c.order_id = v_s1;
  SELECT c.payout_id INTO v_f4_after_stripe FROM public.affiliate_commissions c WHERE c.order_id = v_f4;
  -- without p_gateways (four arguments, as before 02036): every gateway
  SELECT po.id INTO v_default_claim FROM public.claim_affiliate_payout(v_aff5, 'USD', 1, 'cron') AS po;
  SELECT c.payout_id INTO v_f4_after_default FROM public.affiliate_commissions c WHERE c.order_id = v_f4;
  claim_ok := v_claimed.id IS NOT NULL AND v_s1_payout = v_claimed.id AND v_f4_after_stripe IS NULL
    AND v_claimed.amount_cents = (SELECT c.commission_amount_cents - c.refunded_amount_cents FROM public.affiliate_commissions c WHERE c.order_id = v_s1)
    AND v_default_claim IS NOT NULL AND v_f4_after_default = v_default_claim;

  -- a full refund of an order whose commission a recorded manual payout paid: flagged and alerted with the recovery advice
  res_refund := public.apply_affiliate_refund('FREEMIUS', v_f1, 10000, 10000, true);
  SELECT count(*) INTO n_alert
    FROM public.system_alerts a
    JOIN public.affiliate_commissions c ON c.id::text = a.metadata ->> 'commission_id'
   WHERE a.alert_type = 'affiliate_refund_after_payout' AND NOT a.is_resolved AND c.order_id = v_f1
     AND a.metadata ->> 'payout_method' = 'manual' AND a.metadata ->> 'payout_status' = 'COMPLETED'
     AND a.metadata ->> 'payout_id' = v_payout::text
     AND a.message = format('Order %s was refunded after its commission was paid or queued. %s', v_f1, v_recorded_advice)
     AND c.void_requested_at IS NOT NULL AND c.status = 'PAID'::public.affiliate_commission_status;
  alert_ok := res_refund = 'alerted' AND n_alert = 1;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);

  RAISE NOTICE '%  anon / authenticated cannot EXECUTE the manual payout RPCs (claim, record, cancel) or the five-argument claim; service_role can; one claim overload, no stale record overload%', CASE WHEN catalog_ok THEN 'PASS' ELSE 'FAIL' END,
    CASE WHEN catalog_ok THEN '' ELSE format(' (%s; %s claim overloads)', coalesce(rpc_api, 'no API grant'), n_claims) END;
  RAISE NOTICE '%  a manual payout cannot be FAILED, carry a Stripe destination or be COMPLETED without its channel and reference; one prepared per partner and currency; a Stripe payout cannot lack its destination', CASE WHEN rows_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  payout_email and the payout columns hold no anon / authenticated write grant; a partner session (its own row: the grant, then the guard), another partner and anon cannot write payout_email; the server can, and its CHECK refuses a malformed address and a leading = + - @%', CASE WHEN email_ok THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (granted: ' || col_grants || ')', '');
  RAISE NOTICE '%  partners and anon write no payout row (UPDATE / INSERT refused by the grant); the partner reads its own manual payout with its note', CASE WHEN payout_cols_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  claim_manual_affiliate_payout refuses an unknown partner, a paused or never approved partner, a bad currency and a sum below the minimum (nothing reserved)%', CASE WHEN claim_refusals_ok THEN 'PASS' ELSE 'FAIL' END,
    CASE WHEN claim_refusals_ok THEN '' ELSE format(' (got %s / %s / %s / %s / %s)', res_missing, res_paused, res_unapproved, res_currency, res_below) END;
  RAISE NOTICE '%  a prepared manual payout reserves exactly the live, cleared, undisputed commissions of the gateways given (never test-mode, disputed or Stripe-routed), PROCESSING with no Stripe field, total_paid_cents unchanged; a second claim answers already_prepared', CASE WHEN claim_scope_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  while prepared: a commission cleared later stays out of it, a full refund is flagged and alerted with the prepared advice, a won dispute keeps the commission in the payout', CASE WHEN in_flight_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  record_manual_affiliate_payout refuses an unknown channel, an empty reference, an unknown payout and a Stripe payout (cancel refuses a Stripe payout too)%', CASE WHEN record_refusals_ok THEN 'PASS' ELSE 'FAIL' END,
    CASE WHEN record_refusals_ok THEN '' ELSE format(' (got %s / %s / %s / %s / %s)', res_r_channel, res_r_reference, res_r_missing, res_r_stripe, res_cancel_stripe) END;
  RAISE NOTICE '%  a recorded manual payout is that prepared payout COMPLETED (channel, reference, note, recorded_by, paid_at; partner paused since or not), its commissions PAID, total_paid_cents up by its amount; a second record answers already_recorded', CASE WHEN recorded_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  a reused reference is refused (case ignored); cancel applies a refund flagged while prepared, hands the commission back and deletes the payout, and refuses a recorded one', CASE WHEN cancel_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  complete_affiliate_payout, fail_affiliate_payout, prepare_affiliate_payout_retry and release_affiliate_payout never change a manual payout', CASE WHEN stripe_guard_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  claim_affiliate_payout with p_gateways => {STRIPE} never claims a FREEMIUS commission; the four-argument call still claims every gateway', CASE WHEN claim_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  a refund after a recorded manual payout is flagged and alerted with the recovery advice (payout_method manual, payout_status COMPLETED), not the Stripe reversal', CASE WHEN alert_ok THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- 41. affiliates (02037): commissions paid from the operator's PayPal balance. The PayPal payout
--     lifecycle (claim_paypal_affiliate_payout, record_paypal_affiliate_payout_batch,
--     note_paypal_affiliate_payout_item, complete_paypal_affiliate_payout, fail_paypal_affiliate_payout,
--     release_paypal_affiliate_payout) is service-role only; a PayPal payout names its recipient,
--     carries no Stripe field, names its item and transaction once COMPLETED, can be FAILED only with a
--     paypal_ reason (02036's manual status CHECK, scoped to manual payouts, still refuses a FAILED
--     manual one), and there is one in flight per partner, currency and mode; a payout of another method
--     carries no PayPal field; payout_email_kind and payout_email_saved_at are written by the server only
--     (no API grant, the profile guard, a CHECK for the kind); the CMS-saved PayPal credentials
--     (site_settings.affiliates_paypal_secret) are readable and writable by the service role only, an
--     aal2 ADMIN included; nobody but the service role writes a PayPal payout column. The claim refuses
--     an unknown, paused or unapproved partner, a partner without a PayPal payout email (none, or an
--     Interac one), bad input and a sum below the minimum, and reserves exactly the cleared, unattached
--     commissions of the gateways and the mode it is given (live PayPal never takes a test-mode
--     commission, the PayPal sandbox never a live one); the batch ids are saved and never overwritten;
--     completion is exactly once (commissions PAID, total_paid_cents up, transaction id and fee kept, a
--     transaction id on one payout only); a failure applies the refund flagged in flight and hands the
--     other commissions back, which a new claim takes again; complete_affiliate_payout,
--     fail_affiliate_payout, release_affiliate_payout and prepare_affiliate_payout_retry (its re-send and
--     its give-up branch, for a partner with a ready Connect account and a commission still attached)
--     never complete, fail, release or re-send a PayPal payout; the admin release waits an hour after the
--     last send of a batch PayPal never acknowledged (a resend stamps it again) and a week for one PayPal
--     acknowledged, refuses one whose item PayPal holds, and hands the commissions back; a refund while a
--     PayPal payout is in flight, and after it completed, alerts with the PayPal advice. Uses its own
--     partners (six: PayPal, seven: Interac), section 36's partner two, live and test-mode orders.
RESET ROLE;
DO $$
DECLARE
  v_rtl6 uuid := 'aa000000-0000-0000-0000-00000000af06';
  v_rtl7 uuid := 'aa000000-0000-0000-0000-00000000af07';
  v_rtl2 uuid := 'aa000000-0000-0000-0000-00000000af02';
  v_cust uuid := 'aa000000-0000-0000-0000-00000000cc01';
  v_g1 uuid := 'aa000000-0000-0000-0000-00000000b151';  -- Freemius, live: paid by the first PayPal payout, then refunded
  v_g2 uuid := 'aa000000-0000-0000-0000-00000000b152';  -- Freemius, live: paid by the first PayPal payout
  v_gt uuid := 'aa000000-0000-0000-0000-00000000b153';  -- Freemius, test mode: only a PayPal sandbox payout takes it
  v_gs uuid := 'aa000000-0000-0000-0000-00000000b154';  -- Stripe, live: never a PayPal payout of {FREEMIUS}
  v_g3 uuid := 'aa000000-0000-0000-0000-00000000b155';  -- Freemius, live: refunded while its PayPal payout is in flight
  v_g4 uuid := 'aa000000-0000-0000-0000-00000000b156';  -- Freemius, live: handed back when that payout fails, claimed again
  v_g7 uuid := 'aa000000-0000-0000-0000-00000000b157';  -- Freemius, live, partner seven (Interac): never a PayPal payout
  v_email jsonb := '{"email":"sv-customer@test.local"}';
  v_claim text := 'public.claim_paypal_affiliate_payout(uuid, text, bigint, public.affiliate_gateway[], boolean, text)';
  v_batch text := 'public.record_paypal_affiliate_payout_batch(uuid[], text, text)';
  v_note text := 'public.note_paypal_affiliate_payout_item(uuid, text, text, bigint)';
  v_complete text := 'public.complete_paypal_affiliate_payout(uuid, text, text, bigint, text)';
  v_fail text := 'public.fail_paypal_affiliate_payout(uuid, text, text)';
  v_release text := 'public.release_paypal_affiliate_payout(uuid)';
  v_freemius public.affiliate_gateway[] := ARRAY['FREEMIUS']::public.affiliate_gateway[];
  v_in_flight_advice text := 'Its PayPal payout is still in flight: if PayPal returns it or it fails, the refund is applied then; if it completes, recover the amount from the partner, for example by asking them to send it back.';
  v_recovery_advice text := 'Recover the amount from the partner, for example by asking them to send it back.';
  missing text; rpc_api text; rpc_svc boolean; n_overloads integer; v_aff6 uuid; v_aff7 uuid; v_aff2 uuid; col_grants text;
  paypal_dest_refused boolean := false; paypal_receiver_refused boolean := false; paypal_unpaid_refused boolean := false;
  stripe_paypal_field_refused boolean := false; paypal_id_refused boolean := false; in_flight_unique_refused boolean := false;
  kind_grant_denied boolean := false; kind_guard_denied boolean := false; kind_other_denied boolean := false; kind_anon_denied boolean := false;
  kind_server_ok boolean := false; kind_check_ok boolean := false;
  secret_anon_read integer; secret_anon_write_denied boolean := false; secret_writer_read integer; secret_writer_write boolean;
  secret_writer_insert_denied boolean := false; secret_nofactor_read integer; secret_nofactor_write boolean; secret_aal2_read integer;
  secret_aal2_write boolean; secret_aal2_delete boolean; secret_aal2_insert_denied boolean := false; secret_service_read integer;
  payout_col_denied boolean := false; payout_col_anon_denied boolean := false; v_own_read integer;
  res_missing jsonb; res_paused jsonb; res_unapproved jsonb; res_interac jsonb; res_no_gateway jsonb; res_currency jsonb; res_below jsonb;
  res_claim jsonb; res_again jsonb; res_sandbox jsonb; res_b1 jsonb; res_b2 jsonb; res_b3 jsonb; res_b4 jsonb; res_bad_batch jsonb;
  res_n1 jsonb; res_n2 jsonb; res_n3 jsonb; res_done jsonb; res_done_again jsonb; res_done_stripe jsonb; res_done_bad jsonb; res_dup jsonb;
  res_claim3 jsonb; res_refund3 text; res_fail jsonb; res_fail_again jsonb; res_done_failed jsonb; res_claim4 jsonb; res_refund1 text;
  v_sum bigint; v_paid0 bigint; v_paid1 bigint; v_payouts_before integer; v_payouts_after_below integer; v_test_net bigint;
  v_payout uuid; v_sandbox_payout uuid; v_payout3 uuid; v_payout4 uuid; v_stripe_payout uuid; p record; v_g3_after record; v_g4_after record;
  complete_refused boolean := false; retry_refused boolean := false; v_p3_after record; n_alert_in_flight integer; n_alert_done integer;
  stripe_fail_refused boolean := false; stripe_release_refused boolean := false; retry_giveup_refused boolean := false;
  paypal_failed_allowed boolean := false; paypal_foreign_reason_refused boolean := false; manual_failed_refused boolean := false; v_failed_probe uuid;
  saved_grant_denied boolean := false; saved_guard_denied boolean := false; saved_server_ok boolean := false;
  res_rel_recent jsonb; res_rel_unconfirmed jsonb; res_rel_done jsonb; res_rel_failed jsonb; res_rel_missing jsonb;
  res_claim5 jsonb; res_s5a jsonb; res_s5b jsonb; res_rel_resent jsonb; res_rel_ack_recent jsonb; res_rel_held jsonb; res_rel_ack jsonb;
  v_payout5 uuid; v_p4_released record; v_p5_after record; v_g4_released record; v_attempts_before integer;
  catalog_ok boolean := false; rows_ok boolean := false; kind_ok boolean := false; secret_ok boolean := false; payout_cols_ok boolean := false;
  claim_refusals_ok boolean := false; claim_scope_ok boolean := false; batch_ok boolean := false; complete_ok boolean := false;
  fail_ok boolean := false; stripe_guard_ok boolean := false; alert_ok boolean := false; failed_rows_ok boolean := false;
  saved_at_ok boolean := false; release_ok boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  SELECT string_agg(m.f, ', ') INTO missing
    FROM (SELECT f FROM unnest(ARRAY[v_claim, v_batch, v_note, v_complete, v_fail, v_release]) AS f WHERE to_regprocedure(f) IS NULL
          UNION ALL
          SELECT c FROM unnest(ARRAY['affiliate_payouts.paypal_receiver', 'affiliate_payouts.paypal_sender_batch_id', 'affiliate_payouts.paypal_batch_id',
                                     'affiliate_payouts.paypal_item_id', 'affiliate_payouts.paypal_transaction_id', 'affiliate_payouts.paypal_item_status',
                                     'affiliate_payouts.paypal_fee_cents', 'affiliate_payouts.paypal_checked_at', 'affiliate_profiles.payout_email_kind',
                                     'affiliate_profiles.payout_email_saved_at']) AS c
           WHERE NOT EXISTS (
             SELECT 1 FROM pg_attribute a
              WHERE a.attrelid = to_regclass('public.' || split_part(c, '.', 1))
                AND a.attname = split_part(c, '.', 2) AND a.attnum > 0 AND NOT a.attisdropped)) AS m;
  IF missing IS NOT NULL THEN
    RAISE NOTICE 'FAIL  the 02037 columns and functions exist (missing: %)', missing;
    RETURN;
  END IF;
  SELECT p2.id INTO v_aff2 FROM public.affiliate_profiles p2 WHERE p2.user_id = v_rtl2;
  IF v_aff2 IS NULL THEN
    RAISE NOTICE 'FAIL  the section 36 partner two exists';
    RETURN;
  END IF;

  -- the catalog: who may call what, one signature each
  SELECT string_agg(format('%s to %s', f, r.role), ', ') INTO rpc_api
    FROM unnest(ARRAY[v_claim, v_batch, v_note, v_complete, v_fail, v_release]) AS f CROSS JOIN unnest(ARRAY['anon', 'authenticated']::name[]) AS r(role)
   WHERE has_function_privilege(r.role, to_regprocedure(f), 'EXECUTE');
  SELECT bool_and(has_function_privilege('service_role', to_regprocedure(f), 'EXECUTE')) INTO rpc_svc
    FROM unnest(ARRAY[v_claim, v_batch, v_note, v_complete, v_fail, v_release]) AS f;
  SELECT count(*) INTO n_overloads FROM pg_proc pr
   WHERE pr.pronamespace = 'public'::regnamespace
     AND pr.proname IN ('claim_paypal_affiliate_payout', 'record_paypal_affiliate_payout_batch', 'note_paypal_affiliate_payout_item',
                        'complete_paypal_affiliate_payout', 'fail_paypal_affiliate_payout', 'release_paypal_affiliate_payout');
  SELECT string_agg(format('%s.%s %s to %s', t, c, priv, r.role), ', ') INTO col_grants
    FROM (VALUES ('affiliate_profiles', 'payout_email_kind'), ('affiliate_profiles', 'payout_email_saved_at'), ('affiliate_payouts', 'paypal_receiver'),
                 ('affiliate_payouts', 'paypal_transaction_id'), ('affiliate_payouts', 'paypal_item_status'), ('affiliate_payouts', 'paypal_fee_cents')) AS x(t, c)
    CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE']) AS priv
    CROSS JOIN unnest(ARRAY['anon', 'authenticated']::name[]) AS r(role)
   WHERE has_column_privilege(r.role, ('public.' || t)::regclass, c, priv);
  catalog_ok := rpc_api IS NULL AND coalesce(rpc_svc, false) AND n_overloads = 6;

  -- fixtures (as the table owner): partners six (PayPal) and seven (Interac), signed up as the service role and approved
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  VALUES
    (v_rtl6, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sv-partner6@test.local', 'x', now(), now(), '{}', '{"full_name":"SV Partner Six"}'),
    (v_rtl7, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sv-partner7@test.local', 'x', now(), now(), '{}', '{"full_name":"SV Partner Seven"}')
  ON CONFLICT (id) DO NOTHING;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  PERFORM public.create_affiliate_account(v_rtl6, 'sv-partner-six', 'SV Partner Six', 'en', 'SV six', '', NULL, NULL);
  PERFORM public.create_affiliate_account(v_rtl7, 'sv-partner-seven', 'SV Partner Seven', 'en', 'SV seven', '', NULL, NULL);
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  UPDATE public.affiliate_profiles
     SET page_submitted_at = now() - interval '3 days', first_published_at = now() - interval '2 days'
   WHERE user_id IN (v_rtl6, v_rtl7);
  SELECT p6.id INTO v_aff6 FROM public.affiliate_profiles p6 WHERE p6.user_id = v_rtl6;
  SELECT p7.id INTO v_aff7 FROM public.affiliate_profiles p7 WHERE p7.user_id = v_rtl7;
  UPDATE public.affiliate_profiles SET payout_email = 'sv-seven@interac.example', payout_email_kind = 'interac' WHERE id = v_aff7;

  -- payout rows: a PayPal one names its recipient, never carries a Stripe destination, is COMPLETED only with
  -- its item and transaction; a Stripe one never carries a PayPal field; PayPal's ids keep a safe shape
  BEGIN
    INSERT INTO public.affiliate_payouts (affiliate_id, amount_cents, currency, method, status, paypal_receiver, stripe_destination_account)
    VALUES (v_aff6, 100, 'USD', 'paypal', 'PROCESSING', 'sv-six@paypal.example', 'acct_svposture6');
  EXCEPTION WHEN check_violation THEN paypal_dest_refused := true;
  END;
  BEGIN
    INSERT INTO public.affiliate_payouts (affiliate_id, amount_cents, currency, method, status)
    VALUES (v_aff6, 100, 'USD', 'paypal', 'PROCESSING');
  EXCEPTION WHEN check_violation THEN paypal_receiver_refused := true;
  END;
  BEGIN
    INSERT INTO public.affiliate_payouts (affiliate_id, amount_cents, currency, method, status, paypal_receiver, paid_at)
    VALUES (v_aff6, 100, 'USD', 'paypal', 'COMPLETED', 'sv-six@paypal.example', now());
  EXCEPTION WHEN check_violation THEN paypal_unpaid_refused := true;
  END;
  BEGIN
    INSERT INTO public.affiliate_payouts (affiliate_id, amount_cents, currency, stripe_destination_account, status, paypal_item_status)
    VALUES (v_aff6, 100, 'USD', 'acct_svposture6', 'FAILED', 'SUCCESS');
  EXCEPTION WHEN check_violation THEN stripe_paypal_field_refused := true;
  END;
  BEGIN
    INSERT INTO public.affiliate_payouts (affiliate_id, amount_cents, currency, method, status, paypal_receiver, paypal_batch_id)
    VALUES (v_aff6, 100, 'USD', 'paypal', 'PROCESSING', 'sv-six@paypal.example', '../v1/oauth2/token');
  EXCEPTION WHEN check_violation THEN paypal_id_refused := true;
  END;
  -- a PayPal payout can be FAILED (02036's manual status CHECK no longer applies to it), with a paypal_
  -- reason only (the Stripe RPCs write 'released', a Stripe code, 'nothing_to_pay'); a manual one never
  BEGIN
    INSERT INTO public.affiliate_payouts (affiliate_id, amount_cents, currency, method, status, paypal_receiver, failure_reason)
    VALUES (v_aff6, 100, 'USD', 'paypal', 'FAILED', 'sv-six@paypal.example', 'paypal_returned')
    RETURNING id INTO v_failed_probe;
    paypal_failed_allowed := v_failed_probe IS NOT NULL;
    DELETE FROM public.affiliate_payouts WHERE id = v_failed_probe;
  EXCEPTION WHEN check_violation THEN paypal_failed_allowed := false;
  END;
  BEGIN
    INSERT INTO public.affiliate_payouts (affiliate_id, amount_cents, currency, method, status, paypal_receiver, failure_reason)
    VALUES (v_aff6, 100, 'USD', 'paypal', 'FAILED', 'sv-six@paypal.example', 'released');
  EXCEPTION WHEN check_violation THEN paypal_foreign_reason_refused := true;
  END;
  BEGIN
    INSERT INTO public.affiliate_payouts (affiliate_id, amount_cents, currency, method, status, failure_reason)
    VALUES (v_aff6, 100, 'USD', 'manual', 'FAILED', 'paypal_returned');
  EXCEPTION WHEN check_violation THEN manual_failed_refused := true;
  END;
  failed_rows_ok := paypal_failed_allowed AND paypal_foreign_reason_refused AND manual_failed_refused
    AND NOT EXISTS (SELECT 1 FROM public.affiliate_payouts po WHERE po.affiliate_id = v_aff6 AND po.status = 'FAILED'::public.affiliate_payout_status);

  -- payout_email_kind: refused for partner six's own session (the grant, then the guard behind it with
  -- table rights), for partner seven and for anon; the server writes it, and its CHECK refuses another kind
  PERFORM set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated","aal":"aal1"}', v_rtl6), true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    UPDATE public.affiliate_profiles SET payout_email_kind = 'interac' WHERE user_id = v_rtl6;
  EXCEPTION WHEN insufficient_privilege THEN kind_grant_denied := SQLERRM LIKE 'permission denied%';
  END;
  BEGIN
    UPDATE public.affiliate_payouts SET paypal_transaction_id = 'SVFORGED1' WHERE affiliate_id = v_aff6;
  EXCEPTION WHEN insufficient_privilege THEN payout_col_denied := SQLERRM LIKE 'permission denied%';
  END;
  BEGIN
    UPDATE public.affiliate_profiles SET payout_email_saved_at = now() WHERE user_id = v_rtl6;
  EXCEPTION WHEN insufficient_privilege THEN saved_grant_denied := SQLERRM LIKE 'permission denied%';
  END;
  EXECUTE 'SET LOCAL ROLE service_role';
  BEGIN
    UPDATE public.affiliate_profiles SET payout_email_kind = 'interac' WHERE user_id = v_rtl6;
  EXCEPTION WHEN insufficient_privilege THEN kind_guard_denied := SQLERRM = 'affiliate_profile_field_protected';
  END;
  BEGIN
    UPDATE public.affiliate_profiles SET payout_email_saved_at = now() WHERE user_id = v_rtl6;
  EXCEPTION WHEN insufficient_privilege THEN saved_guard_denied := SQLERRM = 'affiliate_profile_field_protected';
  END;
  PERFORM set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated","aal":"aal1"}', v_rtl7), true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    UPDATE public.affiliate_profiles SET payout_email_kind = 'paypal' WHERE user_id = v_rtl6;
  EXCEPTION WHEN insufficient_privilege THEN kind_other_denied := SQLERRM LIKE 'permission denied%';
  END;
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  EXECUTE 'SET LOCAL ROLE anon';
  BEGIN
    UPDATE public.affiliate_profiles SET payout_email_kind = 'interac' WHERE user_id = v_rtl6;
  EXCEPTION WHEN insufficient_privilege THEN kind_anon_denied := SQLERRM LIKE 'permission denied%';
  END;
  BEGIN
    UPDATE public.affiliate_payouts SET paypal_transaction_id = 'SVFORGED1' WHERE affiliate_id = v_aff6;
  EXCEPTION WHEN insufficient_privilege THEN payout_col_anon_denied := SQLERRM LIKE 'permission denied%';
  END;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  PERFORM set_config('request.jwt.claims', '', true);
  UPDATE public.affiliate_profiles SET payout_email = 'SV-Six@PayPal.example', payout_email_kind = 'paypal' WHERE user_id = v_rtl6;
  kind_server_ok := FOUND;
  BEGIN
    UPDATE public.affiliate_profiles SET payout_email_kind = 'venmo' WHERE user_id = v_rtl6;
  EXCEPTION WHEN check_violation THEN kind_check_ok := true;
  END;
  kind_ok := col_grants IS NULL AND kind_grant_denied AND kind_guard_denied AND kind_other_denied AND kind_anon_denied
    AND kind_server_ok AND kind_check_ok
    AND (SELECT pk.payout_email_kind FROM public.affiliate_profiles pk WHERE pk.id = v_aff6) = 'paypal';
  -- payout_email_saved_at (a save after a PayPal return lifts the block): the server stamps it, a partner session never
  UPDATE public.affiliate_profiles SET payout_email_saved_at = now() - interval '1 day' WHERE user_id = v_rtl6;
  saved_server_ok := FOUND;
  saved_at_ok := col_grants IS NULL AND saved_grant_denied AND saved_guard_denied AND saved_server_ok
    AND (SELECT ps.payout_email_saved_at < now() FROM public.affiliate_profiles ps WHERE ps.id = v_aff6);

  -- site_settings.affiliates_paypal_secret: anon, a WRITER, a factor-less ADMIN and an aal2 ADMIN neither read nor write it
  EXECUTE 'RESET ROLE';
  INSERT INTO public.site_settings (key, value) VALUES ('affiliates_paypal_secret', '{"environment":"sandbox"}'::jsonb) ON CONFLICT (key) DO NOTHING;
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  EXECUTE 'SET LOCAL ROLE anon';
  SELECT count(*) INTO secret_anon_read FROM public.site_settings WHERE key = 'affiliates_paypal_secret';
  BEGIN
    UPDATE public.site_settings SET value = '{"environment":"live"}'::jsonb WHERE key = 'affiliates_paypal_secret';
  EXCEPTION WHEN insufficient_privilege THEN secret_anon_write_denied := true;
  END;
  PERFORM set_config('request.jwt.claims', '{"sub":"aa000000-0000-0000-0000-0000000000f1","role":"authenticated","aal":"aal1"}', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO secret_writer_read FROM public.site_settings WHERE key = 'affiliates_paypal_secret';
  UPDATE public.site_settings SET value = '{"environment":"live"}'::jsonb WHERE key = 'affiliates_paypal_secret';
  secret_writer_write := FOUND;
  BEGIN
    INSERT INTO public.site_settings (key, value) VALUES ('affiliates_paypal_secret', '{}'::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
  EXCEPTION WHEN insufficient_privilege THEN secret_writer_insert_denied := true;
  END;
  PERFORM set_config('request.jwt.claims', '{"sub":"aa000000-0000-0000-0000-0000000000a2","role":"authenticated","aal":"aal1"}', true);
  SELECT count(*) INTO secret_nofactor_read FROM public.site_settings WHERE key = 'affiliates_paypal_secret';
  UPDATE public.site_settings SET value = '{"environment":"live"}'::jsonb WHERE key = 'affiliates_paypal_secret';
  secret_nofactor_write := FOUND;
  PERFORM set_config('request.jwt.claims', '{"sub":"aa000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal2"}', true);
  SELECT count(*) INTO secret_aal2_read FROM public.site_settings WHERE key = 'affiliates_paypal_secret';
  UPDATE public.site_settings SET value = '{"environment":"live"}'::jsonb WHERE key = 'affiliates_paypal_secret';
  secret_aal2_write := FOUND;
  DELETE FROM public.site_settings WHERE key = 'affiliates_paypal_secret';
  secret_aal2_delete := FOUND;
  BEGIN
    INSERT INTO public.site_settings (key, value) VALUES ('affiliates_paypal_secret', '{"environment":"live"}'::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
  EXCEPTION WHEN insufficient_privilege THEN secret_aal2_insert_denied := true;
  END;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  SELECT count(*) INTO secret_service_read FROM public.site_settings WHERE key = 'affiliates_paypal_secret' AND value ->> 'environment' = 'sandbox';
  secret_ok := secret_anon_read = 0 AND secret_anon_write_denied AND secret_writer_read = 0 AND NOT secret_writer_write
    AND secret_writer_insert_denied AND secret_nofactor_read = 0 AND NOT secret_nofactor_write AND secret_aal2_read = 0
    AND NOT secret_aal2_write AND NOT secret_aal2_delete AND secret_aal2_insert_denied AND secret_service_read = 1;

  -- orders paid to partners six and seven (one in test mode), recorded by the paid trigger, then cleared
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  INSERT INTO public.orders (id, user_id, status, total, subtotal, discount_total, currency, provider, customer_details,
                             affiliate_id, affiliate_source, affiliate_base_currency, affiliate_livemode)
  VALUES
    (v_g1, v_cust, 'paid', 10000, 10000, 0, 'USD', 'freemius', v_email, v_aff6, 'storefront', 'USD', true),
    (v_g2, v_cust, 'paid', 6000, 6000, 0, 'USD', 'freemius', v_email, v_aff6, 'storefront', 'USD', true),
    (v_gt, v_cust, 'paid', 7000, 7000, 0, 'USD', 'freemius', v_email, v_aff6, 'storefront', 'USD', false),
    (v_gs, v_cust, 'paid', 9000, 9000, 0, 'USD', 'stripe', v_email, v_aff6, 'referral_link', 'USD', true),
    (v_g7, v_cust, 'paid', 8000, 8000, 0, 'USD', 'freemius', v_email, v_aff7, 'storefront', 'USD', true)
  ON CONFLICT (id) DO NOTHING;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  PERFORM public.assign_order_invoice_metadata(o, now()) FROM unnest(ARRAY[v_g1, v_g2, v_gt, v_gs, v_g7]) AS o;
  UPDATE public.affiliate_commissions SET clears_at = now() - interval '1 minute' WHERE order_id IN (v_g1, v_g2, v_gt, v_gs, v_g7);
  PERFORM public.promote_cleared_affiliate_commissions();
  SELECT coalesce(sum(c.commission_amount_cents - c.refunded_amount_cents), 0)::bigint INTO v_sum
    FROM public.affiliate_commissions c WHERE c.order_id IN (v_g1, v_g2);
  SELECT c.commission_amount_cents - c.refunded_amount_cents INTO v_test_net FROM public.affiliate_commissions c WHERE c.order_id = v_gt;
  SELECT pr6.total_paid_cents INTO v_paid0 FROM public.affiliate_profiles pr6 WHERE pr6.id = v_aff6;
  SELECT count(*) INTO v_payouts_before FROM public.affiliate_payouts po WHERE po.affiliate_id = v_aff6;

  -- the claim's refusals: unknown, paused, never approved, an Interac email, no gateway, a bad currency, below the minimum
  res_missing := public.claim_paypal_affiliate_payout(gen_random_uuid(), 'USD', 0, v_freemius, true, 'cron');
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  UPDATE public.affiliate_profiles SET status = 'SUSPENDED', suspended_reason = 'SV posture' WHERE id = v_aff6;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  res_paused := public.claim_paypal_affiliate_payout(v_aff6, 'USD', 0, v_freemius, true, 'cron');
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  UPDATE public.affiliate_profiles SET status = 'ACTIVE', suspended_reason = NULL WHERE id = v_aff6;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  res_unapproved := public.claim_paypal_affiliate_payout(v_aff2, 'USD', 0, v_freemius, true, 'cron');
  res_interac := public.claim_paypal_affiliate_payout(v_aff7, 'USD', 0, v_freemius, true, 'cron');
  res_no_gateway := public.claim_paypal_affiliate_payout(v_aff6, 'USD', 0, ARRAY[]::public.affiliate_gateway[], true, 'cron');
  res_currency := public.claim_paypal_affiliate_payout(v_aff6, 'US', 0, v_freemius, true, 'cron');
  res_below := public.claim_paypal_affiliate_payout(v_aff6, 'USD', v_sum + 1, v_freemius, true, 'cron');
  SELECT count(*) INTO v_payouts_after_below FROM public.affiliate_payouts po WHERE po.affiliate_id = v_aff6;
  claim_refusals_ok := res_missing ->> 'status' = 'not_found' AND res_paused ->> 'status' = 'not_eligible'
    AND res_unapproved ->> 'status' = 'not_eligible' AND res_interac ->> 'status' = 'no_paypal_email'
    AND res_no_gateway ->> 'status' = 'invalid_input' AND res_currency ->> 'status' = 'invalid_input'
    AND res_below ->> 'status' = 'below_minimum' AND (res_below ->> 'amount_cents')::bigint = v_sum
    AND (res_below ->> 'commission_count')::integer = 2 AND v_payouts_after_below = v_payouts_before
    AND (SELECT c.payout_id IS NULL FROM public.affiliate_commissions c WHERE c.order_id = v_g7);

  -- the live claim: exactly v_g1 and v_g2 (live, cleared, Freemius) in one PROCESSING PayPal payout to the
  -- partner's email (lower-cased); a second claim answers already_in_flight; the PayPal sandbox takes only v_gt
  res_claim := public.claim_paypal_affiliate_payout(v_aff6, 'usd', 0, v_freemius, true, 'auto');
  v_payout := (res_claim ->> 'payout_id')::uuid;
  SELECT po.method, po.status::text AS status, po.paypal_receiver, po.livemode, po.stripe_destination_account, po.stripe_transfer_id,
         po.amount_cents, po.paid_at, po.trigger, po.paypal_sender_batch_id
    INTO p FROM public.affiliate_payouts po WHERE po.id = v_payout;
  res_again := public.claim_paypal_affiliate_payout(v_aff6, 'USD', 0, v_freemius, true, 'cron');
  res_sandbox := public.claim_paypal_affiliate_payout(v_aff6, 'USD', 0, v_freemius, false, 'admin');
  v_sandbox_payout := (res_sandbox ->> 'payout_id')::uuid;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    INSERT INTO public.affiliate_payouts (affiliate_id, amount_cents, currency, method, status, paypal_receiver, livemode)
    VALUES (v_aff6, 100, 'USD', 'paypal', 'PROCESSING', 'sv-six@paypal.example', true);
  EXCEPTION WHEN unique_violation THEN in_flight_unique_refused := true;
  END;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  rows_ok := paypal_dest_refused AND paypal_receiver_refused AND paypal_unpaid_refused AND stripe_paypal_field_refused
    AND paypal_id_refused AND in_flight_unique_refused;
  claim_scope_ok := res_claim ->> 'status' = 'claimed' AND (res_claim ->> 'amount_cents')::bigint = v_sum
    AND (res_claim ->> 'commission_count')::integer = 2 AND res_claim ->> 'receiver' = 'sv-six@paypal.example'
    AND p.method = 'paypal' AND p.status = 'PROCESSING' AND p.paypal_receiver = 'sv-six@paypal.example' AND p.livemode
    AND p.stripe_destination_account IS NULL AND p.stripe_transfer_id IS NULL AND p.amount_cents = v_sum AND p.paid_at IS NULL
    AND p.trigger = 'auto' AND p.paypal_sender_batch_id IS NULL
    AND (SELECT count(*) FROM public.affiliate_commissions c
          WHERE c.payout_id = v_payout AND c.order_id IN (v_g1, v_g2) AND c.status = 'CLEARED'::public.affiliate_commission_status) = 2
    AND (SELECT count(*) FROM public.affiliate_commissions c WHERE c.payout_id = v_payout) = 2
    AND (SELECT c.payout_id IS NULL FROM public.affiliate_commissions c WHERE c.order_id = v_gs)
    AND (SELECT pr6.total_paid_cents FROM public.affiliate_profiles pr6 WHERE pr6.id = v_aff6) = v_paid0
    AND res_again ->> 'status' = 'already_in_flight' AND (res_again ->> 'payout_id')::uuid = v_payout
    AND res_sandbox ->> 'status' = 'claimed' AND (res_sandbox ->> 'amount_cents')::bigint = v_test_net
    AND (res_sandbox ->> 'commission_count')::integer = 1
    AND (SELECT c.payout_id = v_sandbox_payout FROM public.affiliate_commissions c WHERE c.order_id = v_gt)
    AND (SELECT po.livemode = false FROM public.affiliate_payouts po WHERE po.id = v_sandbox_payout);

  -- the batch ids: the sender id saved before the create call, never replaced; PayPal's batch id after it; the item noted
  res_b1 := public.record_paypal_affiliate_payout_batch(ARRAY[v_payout], 'sv-batch-1', NULL);
  res_b2 := public.record_paypal_affiliate_payout_batch(ARRAY[v_payout], 'sv-batch-2', NULL);
  res_b3 := public.record_paypal_affiliate_payout_batch(ARRAY[v_payout], 'sv-batch-1', 'SVPAYPALBATCH1');
  res_b4 := public.record_paypal_affiliate_payout_batch(ARRAY[v_payout], 'sv-batch-1', 'SVPAYPALBATCH2');
  res_bad_batch := public.record_paypal_affiliate_payout_batch(ARRAY[v_payout], 'sv batch/../1', NULL);
  res_n1 := public.note_paypal_affiliate_payout_item(v_payout, 'SVITEM1', 'pending', 25);
  res_n2 := public.note_paypal_affiliate_payout_item(v_payout, 'SVITEM2', 'UNCLAIMED', NULL);
  res_n3 := public.note_paypal_affiliate_payout_item(v_payout, 'SVITEM1', 'not a status', NULL);
  SELECT po.paypal_sender_batch_id, po.paypal_batch_id, po.paypal_item_id, po.paypal_item_status, po.paypal_fee_cents, po.paypal_checked_at
    INTO p FROM public.affiliate_payouts po WHERE po.id = v_payout;
  batch_ok := res_b1 ->> 'status' = 'recorded' AND (res_b1 ->> 'count')::integer = 1
    AND res_b2 ->> 'status' = 'recorded' AND (res_b2 ->> 'count')::integer = 0
    AND (res_b3 ->> 'count')::integer = 1 AND (res_b4 ->> 'count')::integer = 0
    AND res_bad_batch ->> 'status' = 'invalid_input'
    AND res_n1 ->> 'status' = 'noted' AND res_n2 ->> 'status' = 'not_found' AND res_n3 ->> 'status' = 'invalid_input'
    AND p.paypal_sender_batch_id = 'sv-batch-1' AND p.paypal_batch_id = 'SVPAYPALBATCH1' AND p.paypal_item_id = 'SVITEM1'
    AND p.paypal_item_status = 'PENDING' AND p.paypal_fee_cents = 25 AND p.paypal_checked_at IS NOT NULL;

  -- completion, exactly once: COMPLETED with the transaction and fee, commissions PAID, total_paid_cents up
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  INSERT INTO public.affiliate_payouts (affiliate_id, amount_cents, currency, stripe_destination_account, status)
  VALUES (v_aff6, 100, 'USD', 'acct_svposture6', 'PROCESSING')
  RETURNING id INTO v_stripe_payout;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  res_done_bad := public.complete_paypal_affiliate_payout(v_payout, 'SVITEM1', 'tx/../1', 25, 'SUCCESS');
  res_done_stripe := public.complete_paypal_affiliate_payout(v_stripe_payout, 'SVITEM9', 'SVTX9', NULL, 'SUCCESS');
  res_done := public.complete_paypal_affiliate_payout(v_payout, 'SVITEM1', 'SVTX1', 25, 'SUCCESS');
  res_done_again := public.complete_paypal_affiliate_payout(v_payout, 'SVITEM1', 'SVTX1', 25, 'SUCCESS');
  res_dup := public.complete_paypal_affiliate_payout(v_sandbox_payout, 'SVITEM3', 'SVTX1', NULL, 'SUCCESS');
  SELECT po.status::text AS status, po.paypal_transaction_id, po.paypal_item_id, po.paypal_item_status, po.paypal_fee_cents, po.paid_at
    INTO p FROM public.affiliate_payouts po WHERE po.id = v_payout;
  SELECT pr6.total_paid_cents INTO v_paid1 FROM public.affiliate_profiles pr6 WHERE pr6.id = v_aff6;
  complete_ok := res_done_bad ->> 'status' = 'invalid_input' AND res_done_stripe ->> 'status' = 'not_found'
    AND res_done ->> 'status' = 'completed' AND (res_done ->> 'payout_id')::uuid = v_payout AND (res_done ->> 'affiliate_id')::uuid = v_aff6
    AND (res_done ->> 'amount_cents')::bigint = v_sum AND res_done ->> 'currency' = 'USD'
    AND (res_done ->> 'commission_count')::integer = 2 AND res_done ->> 'transaction_id' = 'SVTX1'
    AND p.status = 'COMPLETED' AND p.paypal_transaction_id = 'SVTX1' AND p.paypal_item_id = 'SVITEM1' AND p.paypal_item_status = 'SUCCESS'
    AND p.paypal_fee_cents = 25 AND p.paid_at IS NOT NULL
    AND (SELECT count(*) FROM public.affiliate_commissions c
          WHERE c.payout_id = v_payout AND c.status = 'PAID'::public.affiliate_commission_status AND c.paid_at IS NOT NULL) = 2
    AND v_paid1 = v_paid0 + v_sum
    AND res_done_again ->> 'status' = 'already_completed'
    AND res_dup ->> 'status' = 'duplicate_transaction'
    AND (SELECT po.status::text = 'PROCESSING' FROM public.affiliate_payouts po WHERE po.id = v_sandbox_payout);
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  DELETE FROM public.affiliate_payouts WHERE id = v_stripe_payout;

  -- failure: a third live payout (v_g3, v_g4); a full refund of v_g3 while it is in flight is flagged and
  -- alerted with the PayPal advice; failing it voids v_g3 and hands v_g4 back, which a new claim takes again
  INSERT INTO public.orders (id, user_id, status, total, subtotal, discount_total, currency, provider, customer_details,
                             affiliate_id, affiliate_source, affiliate_base_currency, affiliate_livemode)
  VALUES
    (v_g3, v_cust, 'paid', 5000, 5000, 0, 'USD', 'freemius', v_email, v_aff6, 'storefront', 'USD', true),
    (v_g4, v_cust, 'paid', 4000, 4000, 0, 'USD', 'freemius', v_email, v_aff6, 'storefront', 'USD', true)
  ON CONFLICT (id) DO NOTHING;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  PERFORM public.assign_order_invoice_metadata(o, now()) FROM unnest(ARRAY[v_g3, v_g4]) AS o;
  UPDATE public.affiliate_commissions SET clears_at = now() - interval '1 minute' WHERE order_id IN (v_g3, v_g4);
  PERFORM public.promote_cleared_affiliate_commissions();
  res_claim3 := public.claim_paypal_affiliate_payout(v_aff6, 'USD', 0, v_freemius, true, 'cron');
  v_payout3 := (res_claim3 ->> 'payout_id')::uuid;
  res_refund3 := public.apply_affiliate_refund('FREEMIUS', v_g3, 5000, 5000, true);
  SELECT count(*) INTO n_alert_in_flight
    FROM public.system_alerts a
    JOIN public.affiliate_commissions c ON c.id::text = a.metadata ->> 'commission_id'
   WHERE a.alert_type = 'affiliate_refund_after_payout' AND NOT a.is_resolved AND c.order_id = v_g3
     AND a.metadata ->> 'payout_method' = 'paypal' AND a.metadata ->> 'payout_status' = 'PROCESSING'
     AND a.metadata ->> 'payout_id' = v_payout3::text
     AND a.message = format('Order %s was refunded after its commission was paid or queued. %s', v_g3, v_in_flight_advice)
     AND c.void_requested_at IS NOT NULL AND c.payout_id = v_payout3;
  res_fail := public.fail_paypal_affiliate_payout(v_payout3, 'paypal_returned', 'RETURNED');
  res_fail_again := public.fail_paypal_affiliate_payout(v_payout3, 'paypal_failed', NULL);
  res_done_failed := public.complete_paypal_affiliate_payout(v_payout3, 'SVITEM4', 'SVTX4', NULL, 'SUCCESS');
  SELECT c.payout_id, c.status::text AS status INTO v_g3_after FROM public.affiliate_commissions c WHERE c.order_id = v_g3;
  SELECT c.payout_id, c.status::text AS status INTO v_g4_after FROM public.affiliate_commissions c WHERE c.order_id = v_g4;
  SELECT po.status::text AS status, po.failure_reason, po.paypal_item_status INTO v_p3_after FROM public.affiliate_payouts po WHERE po.id = v_payout3;
  res_claim4 := public.claim_paypal_affiliate_payout(v_aff6, 'USD', 0, v_freemius, true, 'cron');
  v_payout4 := (res_claim4 ->> 'payout_id')::uuid;
  fail_ok := res_claim3 ->> 'status' = 'claimed' AND (res_claim3 ->> 'commission_count')::integer = 2
    AND res_refund3 = 'alerted'
    AND res_fail ->> 'status' = 'failed' AND (res_fail ->> 'commission_count')::integer = 1
    AND res_fail_again ->> 'status' = 'already_failed' AND res_done_failed ->> 'status' = 'not_processing'
    AND v_g3_after.payout_id IS NULL AND v_g3_after.status = 'VOIDED_REFUND'
    AND v_g4_after.payout_id IS NULL AND v_g4_after.status = 'CLEARED'
    AND v_p3_after.status = 'FAILED' AND v_p3_after.failure_reason = 'paypal_returned' AND v_p3_after.paypal_item_status = 'RETURNED'
    AND res_claim4 ->> 'status' = 'claimed' AND (res_claim4 ->> 'commission_count')::integer = 1
    AND (SELECT c.payout_id = v_payout4 FROM public.affiliate_commissions c WHERE c.order_id = v_g4);

  -- the Stripe RPCs never complete, fail, release or re-send a PayPal payout. Partner six gets a ready
  -- live Connect account (so prepare_affiliate_payout_retry passes its eligibility check) and the failed
  -- v_payout3 a commission still attached (v_gs, so the retry reaches its re-send and give-up branches)
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  UPDATE public.affiliate_profiles
     SET stripe_connect_account_id = 'acct_svposture6', stripe_connect_livemode = true, stripe_connect_onboarding_complete = true
   WHERE id = v_aff6;
  UPDATE public.affiliate_commissions SET payout_id = v_payout3 WHERE order_id = v_gs;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  BEGIN
    PERFORM public.complete_affiliate_payout(v_payout4, 'tr_svposture6');
  EXCEPTION WHEN check_violation THEN complete_refused := true;
  END;
  BEGIN
    PERFORM public.fail_affiliate_payout(v_payout4, 'stale');
  EXCEPTION WHEN check_violation THEN stripe_fail_refused := true;
  END;
  BEGIN
    PERFORM public.release_affiliate_payout(v_payout3);
  EXCEPTION WHEN check_violation THEN stripe_release_refused := true;
  END;
  BEGIN
    PERFORM count(*) FROM public.prepare_affiliate_payout_retry(v_payout3, 0) AS r;
  EXCEPTION WHEN check_violation THEN retry_refused := true;
  END;
  BEGIN
    PERFORM count(*) FROM public.prepare_affiliate_payout_retry(v_payout3, 1000000000) AS r;
  EXCEPTION WHEN check_violation THEN retry_giveup_refused := true;
  END;
  stripe_guard_ok := complete_refused AND stripe_fail_refused AND stripe_release_refused AND retry_refused AND retry_giveup_refused
    AND (SELECT po.status::text = 'PROCESSING' AND po.stripe_transfer_id IS NULL AND po.failure_reason IS NULL
           FROM public.affiliate_payouts po WHERE po.id = v_payout4)
    AND (SELECT c.payout_id = v_payout4 FROM public.affiliate_commissions c WHERE c.order_id = v_g4)
    AND (SELECT po.status::text = 'FAILED' AND po.stripe_destination_account IS NULL AND po.failure_reason = 'paypal_returned'
           FROM public.affiliate_payouts po WHERE po.id = v_payout3)
    AND (SELECT c.payout_id = v_payout3 FROM public.affiliate_commissions c WHERE c.order_id = v_gs);
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  UPDATE public.affiliate_commissions SET payout_id = NULL WHERE order_id = v_gs;
  UPDATE public.affiliate_profiles
     SET stripe_connect_account_id = NULL, stripe_connect_livemode = NULL, stripe_connect_onboarding_complete = false
   WHERE id = v_aff6;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';

  -- the admin release: an unconfirmed payout (v_payout4: no batch id) only an hour after its last send;
  -- a completed, a failed or an unknown payout is refused
  res_rel_recent := public.release_paypal_affiliate_payout(v_payout4);
  res_rel_done := public.release_paypal_affiliate_payout(v_payout);
  res_rel_failed := public.release_paypal_affiliate_payout(v_payout3);
  res_rel_missing := public.release_paypal_affiliate_payout(gen_random_uuid());
  EXECUTE 'RESET ROLE';
  UPDATE public.affiliate_payouts SET last_attempt_at = now() - interval '2 hours' WHERE id = v_payout4;
  EXECUTE 'SET LOCAL ROLE service_role';
  res_rel_unconfirmed := public.release_paypal_affiliate_payout(v_payout4);
  SELECT po.status::text AS status, po.failure_reason INTO v_p4_released FROM public.affiliate_payouts po WHERE po.id = v_payout4;
  SELECT c.payout_id, c.status::text AS status INTO v_g4_released FROM public.affiliate_commissions c WHERE c.order_id = v_g4;
  -- v_g4 claimed again (v_payout5), saved under a sender id: a resend (the same id saved again) stamps the
  -- send, so the release waits an hour after the LAST send; once PayPal acknowledged the batch, a week,
  -- and never while PayPal lists a status it holds money in
  res_claim5 := public.claim_paypal_affiliate_payout(v_aff6, 'USD', 0, v_freemius, true, 'cron');
  v_payout5 := (res_claim5 ->> 'payout_id')::uuid;
  res_s5a := public.record_paypal_affiliate_payout_batch(ARRAY[v_payout5], 'sv-batch-5', NULL);
  SELECT po.attempt_count INTO v_attempts_before FROM public.affiliate_payouts po WHERE po.id = v_payout5;
  EXECUTE 'RESET ROLE';
  UPDATE public.affiliate_payouts SET last_attempt_at = now() - interval '2 hours' WHERE id = v_payout5;
  EXECUTE 'SET LOCAL ROLE service_role';
  res_s5b := public.record_paypal_affiliate_payout_batch(ARRAY[v_payout5], 'sv-batch-5', NULL);
  res_rel_resent := public.release_paypal_affiliate_payout(v_payout5);
  PERFORM public.record_paypal_affiliate_payout_batch(ARRAY[v_payout5], 'sv-batch-5', 'SVPAYPALBATCH5');
  EXECUTE 'RESET ROLE';
  UPDATE public.affiliate_payouts SET last_attempt_at = now() - interval '2 hours' WHERE id = v_payout5;
  EXECUTE 'SET LOCAL ROLE service_role';
  res_rel_ack_recent := public.release_paypal_affiliate_payout(v_payout5);
  PERFORM public.note_paypal_affiliate_payout_item(v_payout5, 'SVITEM5', 'PENDING', NULL);
  EXECUTE 'RESET ROLE';
  UPDATE public.affiliate_payouts SET last_attempt_at = now() - interval '8 days' WHERE id = v_payout5;
  EXECUTE 'SET LOCAL ROLE service_role';
  res_rel_held := public.release_paypal_affiliate_payout(v_payout5);
  EXECUTE 'RESET ROLE';
  UPDATE public.affiliate_payouts SET paypal_item_status = 'MYSTERY' WHERE id = v_payout5;
  EXECUTE 'SET LOCAL ROLE service_role';
  res_rel_ack := public.release_paypal_affiliate_payout(v_payout5);
  SELECT po.status::text AS status, po.failure_reason, po.attempt_count INTO v_p5_after FROM public.affiliate_payouts po WHERE po.id = v_payout5;
  release_ok := res_rel_recent ->> 'status' = 'too_recent' AND res_rel_done ->> 'status' = 'already_completed'
    AND res_rel_failed ->> 'status' = 'already_failed' AND res_rel_missing ->> 'status' = 'not_found'
    AND res_rel_unconfirmed ->> 'status' = 'released' AND (res_rel_unconfirmed ->> 'acknowledged')::boolean = false
    AND (res_rel_unconfirmed ->> 'commission_count')::integer = 1
    AND v_p4_released.status = 'FAILED' AND v_p4_released.failure_reason = 'paypal_released_by_admin'
    AND v_g4_released.payout_id IS NULL AND v_g4_released.status = 'CLEARED'
    AND res_claim5 ->> 'status' = 'claimed'
    AND (res_s5a ->> 'count')::integer = 1 AND (res_s5b ->> 'count')::integer = 1 AND v_attempts_before = 1
    AND res_rel_resent ->> 'status' = 'too_recent'
    AND res_rel_ack_recent ->> 'status' = 'too_recent' AND res_rel_held ->> 'status' = 'held_by_paypal'
    AND res_rel_ack ->> 'status' = 'released' AND (res_rel_ack ->> 'acknowledged')::boolean = true
    AND v_p5_after.status = 'FAILED' AND v_p5_after.failure_reason = 'paypal_released_by_admin' AND v_p5_after.attempt_count = 2
    AND (SELECT c.payout_id IS NULL AND c.status = 'CLEARED' FROM public.affiliate_commissions c WHERE c.order_id = v_g4);

  -- a full refund of v_g1, paid by the completed PayPal payout: flagged and alerted with the recovery advice
  res_refund1 := public.apply_affiliate_refund('FREEMIUS', v_g1, 10000, 10000, true);
  SELECT count(*) INTO n_alert_done
    FROM public.system_alerts a
    JOIN public.affiliate_commissions c ON c.id::text = a.metadata ->> 'commission_id'
   WHERE a.alert_type = 'affiliate_refund_after_payout' AND NOT a.is_resolved AND c.order_id = v_g1
     AND a.metadata ->> 'payout_method' = 'paypal' AND a.metadata ->> 'payout_status' = 'COMPLETED'
     AND a.metadata ->> 'payout_id' = v_payout::text
     AND a.message = format('Order %s was refunded after its commission was paid or queued. %s', v_g1, v_recovery_advice)
     AND c.void_requested_at IS NOT NULL AND c.status = 'PAID'::public.affiliate_commission_status;
  alert_ok := n_alert_in_flight = 1 AND res_refund1 = 'alerted' AND n_alert_done = 1;

  -- the partner reads its own PayPal payouts
  PERFORM set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated","aal":"aal1"}', v_rtl6), true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_own_read FROM public.affiliate_payouts po WHERE po.method = 'paypal' AND po.affiliate_id = v_aff6;
  payout_cols_ok := payout_col_denied AND payout_col_anon_denied AND v_own_read >= 4;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);

  RAISE NOTICE '%  anon / authenticated cannot EXECUTE the PayPal payout RPCs (claim, batch, note, complete, fail, release); service_role can; one signature each%', CASE WHEN catalog_ok THEN 'PASS' ELSE 'FAIL' END,
    CASE WHEN catalog_ok THEN '' ELSE format(' (%s; %s overloads)', coalesce(rpc_api, 'no API grant'), n_overloads) END;
  RAISE NOTICE '%  a PayPal payout cannot carry a Stripe destination, lack its recipient, be COMPLETED without its item and transaction or hold a path-like PayPal id; a Stripe payout cannot carry a PayPal field; one in flight per partner, currency and mode', CASE WHEN rows_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  a PayPal payout can be FAILED with a paypal_ reason (the 02036 manual status CHECK is scoped to manual payouts), not with another reason; a manual payout still cannot be FAILED', CASE WHEN failed_rows_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  payout_email_saved_at holds no anon / authenticated write grant; a partner session cannot write it (the grant, then the guard behind it); the server stamps it', CASE WHEN saved_at_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  payout_email_kind and the PayPal payout columns hold no anon / authenticated write grant; a partner session (its own row: the grant, then the guard), another partner and anon cannot write payout_email_kind; the server can, and its CHECK refuses another kind%', CASE WHEN kind_ok THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (granted: ' || col_grants || ')', '');
  RAISE NOTICE '%  site_settings.affiliates_paypal_secret is service-role only: anon, a WRITER, a factor-less ADMIN and an aal2 ADMIN neither read nor write it', CASE WHEN secret_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  partners and anon write no PayPal payout column (refused by the grant); the partner reads its own PayPal payouts', CASE WHEN payout_cols_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  claim_paypal_affiliate_payout refuses an unknown, paused or never approved partner, an Interac payout email, no gateway, a bad currency and a sum below the minimum (nothing reserved)%', CASE WHEN claim_refusals_ok THEN 'PASS' ELSE 'FAIL' END,
    CASE WHEN claim_refusals_ok THEN '' ELSE format(' (got %s / %s / %s / %s / %s / %s / %s)', res_missing, res_paused, res_unapproved, res_interac, res_no_gateway, res_currency, res_below) END;
  RAISE NOTICE '%  a PayPal claim reserves exactly the cleared commissions of the gateways and the mode given (live never takes a test-mode or Stripe-routed commission, the sandbox only a test-mode one), PROCESSING to the lower-cased PayPal email with no Stripe field; a second claim answers already_in_flight', CASE WHEN claim_scope_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  the sender_batch_id is saved before the create call and never replaced, PayPal''s batch and item ids likewise; malformed ids are refused', CASE WHEN batch_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  complete_paypal_affiliate_payout completes exactly once (transaction id and fee kept, commissions PAID, total_paid_cents up by its amount), refuses a Stripe payout, a malformed id and a transaction id another payout carries', CASE WHEN complete_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  fail_paypal_affiliate_payout applies a refund flagged in flight, hands the other commissions back (a new claim takes them again), then refuses a second failure and a completion', CASE WHEN fail_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  complete_affiliate_payout, fail_affiliate_payout, release_affiliate_payout and prepare_affiliate_payout_retry (re-send and give-up, with a ready Connect account and a commission attached) never complete, fail, release or re-send a PayPal payout', CASE WHEN stripe_guard_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  release_paypal_affiliate_payout releases an unconfirmed payout only an hour after its last send (a resend stamps it again), an acknowledged one only a week after it and never while PayPal holds its item; it refuses a completed, failed or unknown payout and hands the commissions back', CASE WHEN release_ok THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  a refund while a PayPal payout is in flight alerts with the PayPal advice, and after it completed with the recovery advice (payout_method paypal)', CASE WHEN alert_ok THEN 'PASS' ELSE 'FAIL' END;
END $$;

-- 42. site_settings secret rows (02038): only the service role reaches them. a1 has a TOTP factor
--     (check 5) and signs in at aal2 here; a2 enrolled none (section 31 switched it off), so
--     is_admin_mfa() passes for both and both keep the rest of the ADMIN tier. Neither reaches a
--     secret row by any command, nor a key added later under a secret's name. Before 02038 the
--     hole checks printed FAIL: the 2026-11-04 review copied payment_secret's envelopes into
--     email_secret.pass exactly like the UPDATE below, then had "Send test email" deliver them to
--     its own SMTP host through SMTP AUTH.
RESET ROLE;
DO $$
DECLARE
  v_secret_keys text[] := ARRAY[
    'email_secret', 'payment_secret', 'bot_protection_secret', 'cortex_ai_openrouter_api_key',
    'cortex_ai_pexels_api_key', 'cortex_ai_unsplash_access_key', 'cortex_ai_mcp_settings',
    'sv_later_secret', 'sv_later_api_key', 'sv_later_access_key', 'sv_later_private_key',
    'sv_later_token', 'sv_later_password', 'sv_later_credentials'];
  v_admins text[] := ARRAY[
    '{"sub":"aa000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal2"}',
    '{"sub":"aa000000-0000-0000-0000-0000000000a2","role":"authenticated","aal":"aal1"}'];
  v_email_before jsonb;
  i integer;
  n integer;
  k text;
  step text;
  n_read integer := 0;
  upd_offenders text;
  ins_offenders text;
  del_offenders text;
  copied boolean := false;
  upsert_denied boolean := true;
  tier_a1 boolean;
  tier_a2 boolean;
  n_anon integer;
  n_service integer;
  w_service boolean;
  n_left integer;
BEGIN
  INSERT INTO public.site_settings (key, value) VALUES
    ('payment_secret', '{"stripeSecretKey":{"ciphertext":"sv-stripe-envelope"}}'::jsonb),
    ('bot_protection_secret', '{"secretKey":{"ciphertext":"sv-captcha-envelope"}}'::jsonb),
    ('cortex_ai_openrouter_api_key', '{"ciphertext":"sv-openrouter-envelope"}'::jsonb),
    ('cortex_ai_pexels_api_key', '{"ciphertext":"sv-pexels-envelope"}'::jsonb),
    ('cortex_ai_unsplash_access_key', '{"ciphertext":"sv-unsplash-envelope"}'::jsonb),
    ('cortex_ai_mcp_settings', '{"enabled":false}'::jsonb),
    ('sv_later_secret', '"x"'::jsonb), ('sv_later_api_key', '"x"'::jsonb),
    ('sv_later_access_key', '"x"'::jsonb), ('sv_later_private_key', '"x"'::jsonb),
    ('sv_later_token', '"x"'::jsonb), ('sv_later_password', '"x"'::jsonb),
    ('sv_later_credentials', '"x"'::jsonb)
  ON CONFLICT (key) DO NOTHING;
  SELECT value INTO v_email_before FROM public.site_settings WHERE key = 'email_secret';

  FOR i IN 1 .. array_length(v_admins, 1) LOOP
    PERFORM set_config('request.jwt.claims', v_admins[i], true);
    EXECUTE 'SET LOCAL ROLE authenticated';

    SELECT count(*) INTO n FROM public.site_settings WHERE key = ANY (v_secret_keys);
    n_read := n_read + n;

    -- An unfiltered PATCH: every row the UPDATE policy lets through.
    WITH u AS (UPDATE public.site_settings SET value = value RETURNING key)
    SELECT string_agg(key, ', ' ORDER BY key) FILTER (WHERE key = ANY (v_secret_keys)) INTO step FROM u;
    upd_offenders := NULLIF(concat_ws(', ', upd_offenders, step), '');

    -- The exfiltration: the Stripe key's envelope into the SMTP password.
    UPDATE public.site_settings
       SET value = jsonb_build_object('user', 'sv', 'pass',
             (SELECT s.value -> 'stripeSecretKey' FROM public.site_settings s WHERE s.key = 'payment_secret'))
     WHERE key = 'email_secret';
    copied := copied OR FOUND;

    FOREACH k IN ARRAY ARRAY['_new_secret', '_new_secret_key', '_new_api_key', '_new_access_key',
                             '_new_private_key', '_new_token', '_new_password', '_new_credential',
                             '_new_credentials', '_NEW_API_KEY'] LOOP
      BEGIN
        INSERT INTO public.site_settings (key, value) VALUES (format('sv%s%s', i, k), '"x"'::jsonb);
        ins_offenders := concat_ws(', ', ins_offenders, format('sv%s%s', i, k));
      EXCEPTION WHEN insufficient_privilege THEN NULL;
      END;
    END LOOP;

    BEGIN
      INSERT INTO public.site_settings (key, value) VALUES ('payment_secret', '{}'::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
      upsert_denied := false;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;

    WITH d AS (DELETE FROM public.site_settings WHERE key = ANY (v_secret_keys) RETURNING key)
    SELECT string_agg(key, ', ' ORDER BY key) INTO step FROM d;
    del_offenders := NULLIF(concat_ws(', ', del_offenders, step), '');

    EXECUTE 'RESET ROLE';
  END LOOP;
  SELECT count(*) INTO n_left FROM public.site_settings WHERE key = ANY (v_secret_keys);

  -- What must still work: the rest of the ADMIN tier for both, nothing for anon, all for the
  -- service role (every CMS screen reads and writes the secret rows with it).
  PERFORM set_config('request.jwt.claims', v_admins[1], true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO n FROM public.site_settings WHERE key = 'store_contact';
  UPDATE public.site_settings SET value = value WHERE key = 'store_contact';
  tier_a1 := n = 1 AND FOUND;
  PERFORM set_config('request.jwt.claims', v_admins[2], true);
  SELECT count(*) INTO n FROM public.site_settings WHERE key = 'payment_public';
  UPDATE public.site_settings SET value = value WHERE key = 'payment_public';
  tier_a2 := n = 1 AND FOUND;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  EXECUTE 'SET LOCAL ROLE anon';
  SELECT count(*) INTO n_anon FROM public.site_settings WHERE key = ANY (v_secret_keys);
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  SELECT count(*) INTO n_service FROM public.site_settings WHERE key = ANY (v_secret_keys);
  UPDATE public.site_settings SET value = value WHERE key = 'email_secret';
  w_service := FOUND;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);

  RAISE NOTICE '%  ADMIN at aal2, or without a factor, reads no secret row of site_settings (keys named like a secret included)', CASE WHEN n_read = 0 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  an unfiltered ADMIN UPDATE reaches no secret row%', CASE WHEN upd_offenders IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (also updated: ' || upd_offenders || ')', '');
  RAISE NOTICE '%  ADMIN cannot copy payment_secret''s envelope into email_secret (the 2026-11-04 exfiltration)', CASE WHEN NOT copied AND (SELECT s.value FROM public.site_settings s WHERE s.key = 'email_secret') = v_email_before THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN cannot insert a key named like a secret (_secret, _api_key, _access_key, _private_key, _token, _password, _credential)%', CASE WHEN ins_offenders IS NULL THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (inserted: ' || ins_offenders || ')', '');
  RAISE NOTICE '%  ADMIN cannot upsert over a secret row', CASE WHEN upsert_denied THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN cannot delete a secret row%', CASE WHEN del_offenders IS NULL AND n_left = array_length(v_secret_keys, 1) THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(' (deleted: ' || del_offenders || ')', '');
  RAISE NOTICE '%  ADMIN at aal2 still reads and writes the rest of the ADMIN tier (store_contact)', CASE WHEN tier_a1 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  ADMIN without a factor still reads and writes the rest of the ADMIN tier (payment_public)', CASE WHEN tier_a2 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  anon reads no secret row', CASE WHEN n_anon = 0 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  the service role still reads and writes every secret row', CASE WHEN n_service = array_length(v_secret_keys, 1) AND w_service THEN 'PASS' ELSE 'FAIL' END;
END $$;

\echo '==========================================================================='
\echo '(all fixtures rolled back below — database unchanged)'

ROLLBACK;
