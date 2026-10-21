-- 02025: grant-level hardening for the API roles (2026-10-21 posture review of 02021-02024).
--
-- Grants decide whether a role may touch a table at all; RLS decides which rows. This file
-- removes three places where RLS had become the only barrier. It changes no row a legitimate
-- request can reach: every statement below takes away a privilege that no RLS policy lets the
-- role use.
--
-- 1. anon is read-only at the grant level.
--    Supabase's historical default privileges, and the baseline (02003), granted anon
--    INSERT/UPDATE/DELETE/REFERENCES/TRIGGER on every table in `public`. No policy in the
--    schema lets anon write anything (checked against pg_policies on 2026-10-21: zero
--    INSERT/UPDATE/DELETE/ALL policies reach anon or PUBLIC), so those grants only meant that
--    a single permissive policy added by mistake would publish a table for writing to anyone
--    with the public key. Every anonymous write path in the app (forms, consent, comments,
--    checkout) already goes through a server route with the service role. Sequence USAGE and
--    UPDATE go too: without INSERT, anon never draws a value.
--
-- 2. cortex_request_log is service-role only again.
--    02022 created it with REVOKE ALL FROM anon, authenticated and no API policy. The
--    post-apply pass of both apply paths (lib/setup/schema-apply.ts and the build hook in
--    tools/lib/migrate-core.mjs) then ran `grant all on all tables ... to authenticated` and
--    `grant select ... to anon` on every deploy, handing the table back to both roles. RLS
--    still returned no row, but a signed-in WRITER could issue DELETEs against the counter
--    that rate-limits the AI routes, and tools/scripts/security-verify.sql failed three checks
--    on any deployed database. Both apply paths now repeat this revoke (API_ROLE_REVOKE_SQL).
--
-- 3. profiles.role is pinned by grants, not only by policy and trigger.
--    The column was protected by profiles_update_policy's WITH CHECK and the
--    protect_profile_role trigger (02021). authenticated now holds INSERT and UPDATE on every
--    profiles column EXCEPT `role` (and `id` on UPDATE), so a policy regression can no longer
--    reopen self-promotion to ADMIN. User-session writes only ever touch full_name,
--    avatar_url, website, phone and updated_at (account page, checkout autofill); role changes
--    go through the service role in app/cms/users/actions.ts, which these grants do not
--    affect. DELETE, REFERENCES and TRIGGER on profiles are revoked from the API roles: no
--    policy grants DELETE to them and account deletion runs through auth.admin. The column
--    list is read from the catalog so a column added later keeps today's behaviour.
--
-- Both apply paths repeat all three after their blanket grants, so a deploy cannot undo
-- them; tools/scripts/security-verify.sql asserts them. Idempotent: safe to re-run.

-- 1. anon: read-only at the grant level
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE USAGE, UPDATE ON ALL SEQUENCES IN SCHEMA public FROM anon;

-- 2. cortex_request_log: service_role only (its SELECT, INSERT, DELETE grant from 02022 stays)
REVOKE ALL ON TABLE public.cortex_request_log FROM PUBLIC, anon, authenticated;

-- 3. profiles: every column but `role` (and `id` on UPDATE) for authenticated
DO $nb_profiles$
DECLARE
  v_insert_cols text;
  v_update_cols text;
BEGIN
  SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) FILTER (WHERE a.attname <> 'role'),
         string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) FILTER (WHERE a.attname NOT IN ('id', 'role'))
    INTO v_insert_cols, v_update_cols
    FROM pg_attribute a
   WHERE a.attrelid = 'public.profiles'::regclass AND a.attnum > 0 AND NOT a.attisdropped;

  -- Revoking the table-level privilege also revokes every column-level grant of that kind,
  -- so the column grants below are the complete list afterwards.
  REVOKE INSERT, UPDATE, DELETE, REFERENCES, TRIGGER ON TABLE public.profiles FROM PUBLIC, anon, authenticated;
  EXECUTE format('GRANT INSERT (%s) ON TABLE public.profiles TO authenticated', v_insert_cols);
  EXECUTE format('GRANT UPDATE (%s) ON TABLE public.profiles TO authenticated', v_update_cols);
END
$nb_profiles$;
