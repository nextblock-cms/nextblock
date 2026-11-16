-- 02041: site_settings.is_admin_created is written only by the database and the service role.
-- Append-only, forward-only, idempotent: three RESTRICTIVE policies (insert, update, delete), dropped
-- by name and recreated. Reads are untouched: anon reads the flag (the proxy's first-boot gate and
-- /setup). No grant changes, so the post-apply grant pass (API_ROLE_REVOKE_SQL) is untouched.
--
-- The hole (2026-11-13, the public sandbox). The flag tells the proxy that a first administrator
-- exists. While it is not true, every anonymous request is redirected to /setup, and the wizard
-- offers to create the first administrator. The ADMIN branch of the site_settings write policies
-- (`public.is_admin_mfa()`, which an ADMIN passes on an aal2 session, and at aal1 when they enrolled
-- no second factor) admitted the flag like any other key that is not a secret, so such a session
-- could set it to false or delete it over PostgREST. On the public sandbox every visitor holds that
-- session (the demo admin's login is published and the reset removes its factors), so one request
-- locked the whole demo on /setup. That included the 15-minute reset that would have repaired it:
-- the proxy redirected its call too. And it opened the first-admin wizard to anyone. On 2026-11-13
-- cms.nextblock.dev's flag read false; whether a visitor or a failed reset wrote it is not known.
--
-- Who writes the flag, none of them through an API role:
--   * public.handle_new_user() (SECURITY DEFINER, the auth.users trigger) sets it on the first account;
--   * the baseline seed and the sandbox reset (postgres) seed it, and the reset sets it again;
--   * /setup and POST /api/setup/bootstrap only read it, with the service role
--     (apps/nextblock/lib/setup/provisioning.ts), and create the admin through the trigger.
-- The app never writes it with a user session, and Cortex's DB tools already refuse it
-- (WRITE_PROTECTED_SITE_SETTING_KEYS in libs/cortex/src/lib/ai-global-agent-db-tools.ts).
--
-- The fix: RESTRICTIVE policies, AND-ed with every permissive one, so no API role inserts, updates,
-- renames another row into, or deletes the flag, whatever a later migration does to the permissive
-- tiers (the shape 02037 gave affiliates_paypal_secret). The service role and the table owner bypass
-- RLS. In code, same release: the proxy lets /api/cron/reset-sandbox through its first-boot gate, the
-- reset sets the flag and the demo admin's role itself, and provisionFirstAdmin refuses on the sandbox.
--
-- tools/scripts/security-verify.sql section 43 checks all of the above; section 3 now probes the
-- ADMIN tier with store_contact.

DROP POLICY IF EXISTS site_settings_admin_created_no_api_insert_policy ON public.site_settings;
CREATE POLICY site_settings_admin_created_no_api_insert_policy ON public.site_settings
  AS RESTRICTIVE
  FOR INSERT TO anon, authenticated
  WITH CHECK (key <> 'is_admin_created');

DROP POLICY IF EXISTS site_settings_admin_created_no_api_update_policy ON public.site_settings;
CREATE POLICY site_settings_admin_created_no_api_update_policy ON public.site_settings
  AS RESTRICTIVE
  FOR UPDATE TO anon, authenticated
  USING (key <> 'is_admin_created')
  WITH CHECK (key <> 'is_admin_created');

DROP POLICY IF EXISTS site_settings_admin_created_no_api_delete_policy ON public.site_settings;
CREATE POLICY site_settings_admin_created_no_api_delete_policy ON public.site_settings
  AS RESTRICTIVE
  FOR DELETE TO anon, authenticated
  USING (key <> 'is_admin_created');
