-- 02024: clear the Supabase Security Advisor warnings that came back after the 02022/02023
-- deploys, and move a `pg_net` that was installed in `public` into `extensions`.
--
-- Why the SECURITY DEFINER warnings (lints 0028/0029) returned
--   02013 revoked anon/authenticated EXECUTE on the two SECURITY DEFINER trigger functions
--   (handle_new_user(), update_product_ratings()) and the advisor was clean. But every
--   production build runs apps/nextblock/tools/build-migrate.mjs, whose migrate-core.mjs
--   ends with a blanket `grant execute on all functions in schema public to anon,
--   authenticated, service_role` and, unlike lib/setup/schema-apply.ts (the /setup path),
--   had no pass taking that EXECUTE back off trigger functions or re-applying the API-role
--   revokes of 02021/02022. So each deploy silently handed the privilege back. The hook is
--   fixed in the same change (and a test now keeps the two files' SQL identical); this
--   migration repairs the databases that were already re-granted. Postgres checks EXECUTE
--   on a trigger function only at CREATE TRIGGER time, never when the trigger fires, and
--   PostgREST cannot call a `RETURNS trigger` function via /rpc, so nothing loses access.
--
-- Why `pg_net` (lint 0014, "Extension in Public")
--   A bare `create extension pg_net` lands in `public` (the first search_path entry), which
--   exposes its objects through the API schema. pg_net is NOT relocatable, so the lint's
--   `alter extension … set schema` is refused; the only way out is drop + re-create WITH
--   SCHEMA extensions. Its own objects live in the `net` schema either way; only the
--   extension's registration moves, and the request queue / response log are transient.
--   pg_cron job commands are plain text (no dependency), so a scheduled `net.http_get`
--   keeps working. Guarded: a database without pg_net, or with it already outside
--   `public`, is untouched. Same statement tools/scripts/schedule-sandbox-reset.js runs.
--
-- Everything here is idempotent and safe on a fresh install, the sandbox replay and a
-- /setup-installed database. The two Auth-dashboard warnings (leaked password protection,
-- MFA options) are project settings, not schema, and are not addressed here.

-- ---------------------------------------------------------------------------
-- 1. Trigger functions: the API roles never need EXECUTE
--    (identical to the post-apply pass in migrate-core.mjs / schema-apply.ts)
-- ---------------------------------------------------------------------------
do $nb_trg$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_type t on t.oid = p.prorettype
     where p.pronamespace = 'public'::regnamespace and t.typname = 'trigger'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
  end loop;
end $nb_trg$;

-- The two the advisor names, stated explicitly so the intent survives a grep (02013 parity).
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role;

REVOKE EXECUTE ON FUNCTION public.update_product_ratings() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_product_ratings() TO service_role;

-- ---------------------------------------------------------------------------
-- 2. The API-role revokes of 02021 / 02022 that the same blanket grant handed back
--    (identical to API_ROLE_REVOKE_SQL in migrate-core.mjs / schema-apply.ts)
-- ---------------------------------------------------------------------------
do $nb_api$
begin
  revoke truncate on all tables in schema public from anon, authenticated;
  if to_regprocedure('public.generate_order_invoice_number()') is not null then
    revoke execute on function public.generate_order_invoice_number() from public, anon, authenticated;
  end if;
  if to_regprocedure('public.assign_order_invoice_metadata(uuid, timestamp with time zone)') is not null then
    revoke execute on function public.assign_order_invoice_metadata(uuid, timestamp with time zone) from public, anon, authenticated;
  end if;
  if to_regclass('public.order_invoice_number_seq') is not null then
    revoke all on sequence public.order_invoice_number_seq from anon, authenticated;
  end if;
  if to_regprocedure('public.upsert_product_with_variants(jsonb)') is not null then
    revoke execute on function public.upsert_product_with_variants(jsonb) from public, anon;
  end if;
  if to_regprocedure('public.bump_email_2fa_attempts(uuid)') is not null then
    revoke execute on function public.bump_email_2fa_attempts(uuid) from public, anon, authenticated;
  end if;
  if to_regprocedure('public.redeem_coupon_atomically(uuid)') is not null then
    revoke execute on function public.redeem_coupon_atomically(uuid) from public, anon, authenticated;
  end if;
end $nb_api$;

-- ---------------------------------------------------------------------------
-- 3. pg_net out of `public` (not relocatable: drop + re-create WITH SCHEMA extensions)
-- ---------------------------------------------------------------------------
do $nb_pg_net$
declare
  v_version text;
begin
  select e.extversion
    into v_version
    from pg_extension e
   where e.extname = 'pg_net'
     and e.extnamespace = 'public'::regnamespace;

  if v_version is null then
    return; -- not installed, or already registered outside public
  end if;

  if to_regnamespace('extensions') is null then
    raise notice '02024: pg_net % is registered in schema public and this database has no extensions schema; reinstall it by hand with `create extension pg_net with schema <schema>`', v_version;
    return;
  end if;

  -- The pg_net worker holds net.http_request_queue while a request is in flight. Fail fast
  -- rather than queue behind it; re-running the migration is cheap.
  perform set_config('lock_timeout', '15s', true);

  drop extension pg_net;
  create extension pg_net with schema extensions;

  raise notice '02024: pg_net re-registered in schema extensions (was % in public, now %)',
    v_version, (select extversion from pg_extension where extname = 'pg_net');
end $nb_pg_net$;
