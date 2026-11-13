-- 02038: the secret rows of site_settings are reachable only through the service role.
-- Append-only, forward-only, idempotent: the four authenticated policies are dropped by name and
-- recreated with the predicates 02023 (read) and 02028 (writes) left, plus one exclusion. No grant
-- changes, so the post-apply grant pass (API_ROLE_REVOKE_SQL) is untouched.
--
-- The hole (2026-11-04 review of the SMTP credential handling). The ADMIN branch of every
-- site_settings policy is `public.is_admin_mfa()`, which an ADMIN passes on an aal2 session, and
-- also at aal1 when they enrolled no second factor. That branch admitted every key, the secret rows
-- included, so such a session could read and write them straight over PostgREST:
--   * email_secret              { user, pass }: the SMTP login (envelopes)
--   * payment_secret            { stripeSecretKey, stripeWebhookSecret, freemiusSecretKey,
--                                 freemiusApiKey, freemiusSandboxSecretKey } (envelopes)
--   * bot_protection_secret     { secretKey }: the Turnstile / reCAPTCHA secret (envelope)
--   * cortex_ai_openrouter_api_key, cortex_ai_pexels_api_key, cortex_ai_unsplash_access_key
--                               (the row value is the envelope)
--   * cortex_ai_mcp_settings    the MCP server's on/off switch and localhost trust (no credential,
--                               but the database has always kept it next to the secrets)
-- The envelopes (libs/db secret-crypto.ts, AES-256-GCM) were not bound to the row and field they
-- were sealed for, so copying the payment_secret, bot_protection_secret or Cortex envelopes into
-- email_secret.user / .pass, saving an SMTP host of one's own and clicking "Send test email" handed
-- the plaintext to that host through SMTP AUTH. The CMS shows those secrets as last4 at most; an XSS
-- running as such an admin could do the same. Not reachable on the public sandbox: mail never reads
-- the database there (apps/nextblock/lib/config/email-settings.ts).
--
-- The fix, in two layers:
--   1. This migration. The is_admin_mfa() branch of the read, insert, update and delete policies no
--      longer reaches a secret row: the seven keys above by name, and any later key named like a
--      secret (`_secret`, `_secret_key`, `_api_key`, `_access_key`, `_private_key`, `_token`,
--      `_password`, `_credential(s)` at the end, case-insensitive; the same pattern Cortex's DB tools
--      already refuse, libs/cortex ai-global-agent-db-tools.ts PROTECTED_SITE_SETTING_KEY_PATTERN).
--      The WRITER allow-list and the first-factor ADMIN keys (02028) name no secret, so nothing else
--      changes. Every reader and writer of these rows in the app and the libs already uses the
--      service role after its own role check (requireCmsAdmin / requireAdminSupabaseClient /
--      requireEcomAdmin, and the resolvers' own service client), so no screen goes empty.
--   2. In code (same release): v2 envelopes carry their slot (`site_settings:<key>:<field>`) as
--      AES-GCM associated data and each reader opens only its own slot. v1 envelopes still open and
--      are re-sealed as v2 the next time their screen is saved.
--
-- What stays the same: anon reads (02021), the staff read tier, the WRITER allow-list, the first-
-- factor ADMIN keys, and the second factor on every other ADMIN-tier key (email_public,
-- payment_public, store_contact, the cortex_ai_* settings, ...). The service role bypasses RLS.
--
-- tools/scripts/security-verify.sql section 42 checks all of the above; section 16 now probes the
-- ADMIN tier with a key that is not a secret.

-- ---------------------------------------------------------------------------
-- site_settings: the ADMIN branch stops at the secret rows
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS site_settings_read_policy ON public.site_settings;
CREATE POLICY site_settings_read_policy ON public.site_settings
  FOR SELECT TO authenticated
  USING (
    (key = ANY (ARRAY['site_title','site_description','site_keywords','site_social_image','footer_copyright','footer_show_attribution','global_css','language_detection_settings','seo_robots_settings','bot_protection_public','active_logo_id','is_admin_created','privacy_settings','enabled_payment_providers','ecommerce_inventory_settings','migration_baseline_generation','invoice_settings']::text[]))
    OR ((key = ANY (ARRAY['security_settings','onboarding_state','email_public','cortex_ai_site_brief']::text[]))
      AND (SELECT public.get_current_user_role()) = ANY (ARRAY['ADMIN'::public.user_role,'WRITER'::public.user_role]))
    OR (((SELECT public.is_admin_mfa()) IS TRUE)
      AND key <> ALL (ARRAY['email_secret','payment_secret','bot_protection_secret','cortex_ai_openrouter_api_key','cortex_ai_pexels_api_key','cortex_ai_unsplash_access_key','cortex_ai_mcp_settings']::text[])
      AND key !~* '(_secret|_secret_key|_api_key|_access_key|_private_key|_token|_password|_credentials?)$')
  );

DROP POLICY IF EXISTS site_settings_insert_policy ON public.site_settings;
CREATE POLICY site_settings_insert_policy ON public.site_settings
  FOR INSERT TO authenticated
  WITH CHECK (
    ((key = ANY (ARRAY['site_title','site_description','site_keywords','site_social_image','active_logo_id','footer_copyright','footer_show_attribution','onboarding_state']::text[]))
      AND (SELECT public.get_current_user_role()) = ANY (ARRAY['ADMIN'::public.user_role,'WRITER'::public.user_role]))
    OR ((key = ANY (ARRAY['enabled_payment_providers','ecommerce_inventory_settings']::text[]))
      AND (SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role)
    OR (((SELECT public.is_admin_mfa()) IS TRUE)
      AND key <> ALL (ARRAY['email_secret','payment_secret','bot_protection_secret','cortex_ai_openrouter_api_key','cortex_ai_pexels_api_key','cortex_ai_unsplash_access_key','cortex_ai_mcp_settings']::text[])
      AND key !~* '(_secret|_secret_key|_api_key|_access_key|_private_key|_token|_password|_credentials?)$')
  );

DROP POLICY IF EXISTS site_settings_update_policy ON public.site_settings;
CREATE POLICY site_settings_update_policy ON public.site_settings
  FOR UPDATE TO authenticated
  USING (
    ((key = ANY (ARRAY['site_title','site_description','site_keywords','site_social_image','active_logo_id','footer_copyright','footer_show_attribution','onboarding_state']::text[]))
      AND (SELECT public.get_current_user_role()) = ANY (ARRAY['ADMIN'::public.user_role,'WRITER'::public.user_role]))
    OR ((key = ANY (ARRAY['enabled_payment_providers','ecommerce_inventory_settings']::text[]))
      AND (SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role)
    OR (((SELECT public.is_admin_mfa()) IS TRUE)
      AND key <> ALL (ARRAY['email_secret','payment_secret','bot_protection_secret','cortex_ai_openrouter_api_key','cortex_ai_pexels_api_key','cortex_ai_unsplash_access_key','cortex_ai_mcp_settings']::text[])
      AND key !~* '(_secret|_secret_key|_api_key|_access_key|_private_key|_token|_password|_credentials?)$')
  )
  WITH CHECK (
    ((key = ANY (ARRAY['site_title','site_description','site_keywords','site_social_image','active_logo_id','footer_copyright','footer_show_attribution','onboarding_state']::text[]))
      AND (SELECT public.get_current_user_role()) = ANY (ARRAY['ADMIN'::public.user_role,'WRITER'::public.user_role]))
    OR ((key = ANY (ARRAY['enabled_payment_providers','ecommerce_inventory_settings']::text[]))
      AND (SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role)
    OR (((SELECT public.is_admin_mfa()) IS TRUE)
      AND key <> ALL (ARRAY['email_secret','payment_secret','bot_protection_secret','cortex_ai_openrouter_api_key','cortex_ai_pexels_api_key','cortex_ai_unsplash_access_key','cortex_ai_mcp_settings']::text[])
      AND key !~* '(_secret|_secret_key|_api_key|_access_key|_private_key|_token|_password|_credentials?)$')
  );

DROP POLICY IF EXISTS site_settings_delete_policy ON public.site_settings;
CREATE POLICY site_settings_delete_policy ON public.site_settings
  FOR DELETE TO authenticated
  USING (
    ((key = ANY (ARRAY['site_title','site_description','site_keywords','site_social_image','active_logo_id','footer_copyright','footer_show_attribution','onboarding_state']::text[]))
      AND (SELECT public.get_current_user_role()) = ANY (ARRAY['ADMIN'::public.user_role,'WRITER'::public.user_role]))
    OR ((key = ANY (ARRAY['enabled_payment_providers','ecommerce_inventory_settings']::text[]))
      AND (SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role)
    OR (((SELECT public.is_admin_mfa()) IS TRUE)
      AND key <> ALL (ARRAY['email_secret','payment_secret','bot_protection_secret','cortex_ai_openrouter_api_key','cortex_ai_pexels_api_key','cortex_ai_unsplash_access_key','cortex_ai_mcp_settings']::text[])
      AND key !~* '(_secret|_secret_key|_api_key|_access_key|_private_key|_token|_password|_credentials?)$')
  );

COMMENT ON TABLE public.site_settings IS 'Key-value store for global site settings. The secret rows (email_secret, payment_secret, bot_protection_secret, the cortex_ai_* API keys, cortex_ai_mcp_settings, and any key ending in _secret, _api_key, _access_key, _private_key, _token, _password or _credential(s)) hold encrypted envelopes and are reachable only through the service role (02038).';
