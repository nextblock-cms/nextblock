-- 02028: close the database holes the 2026-10-21 audit confirmed on a local replay (each one
-- reproduced over PostgREST: SET LOCAL ROLE authenticated + request.jwt.claims, rolled back).
-- Append-only, forward-only, idempotent: every policy is dropped by name and recreated, every
-- function is CREATE OR REPLACE, every grant is safe to repeat. 02022/02023 are the model.
--
--  1. site_settings: the WRITER write branch becomes an allow-list (HIGH).
--     02022/02023 let ADMIN *or WRITER* write every key outside a 13-key deny-list. A WRITER
--     could therefore PATCH `email_public` to point SMTP at their own server, and
--     lib/config/email-settings.ts combines that host with the decrypted ADMIN-only
--     `email_secret` credentials: the SMTP password and every outgoing mail (ADMIN email-2FA
--     codes included) went to the attacker. The same branch let a WRITER turn the captcha off
--     (`bot_protection_public`), rewrite payment and invoice settings, redirect the store,
--     form and moderation notification addresses, change `migration_baseline_generation`
--     (which 02000 trusts) and the Cortex agent settings. An unfiltered PATCH updated 13 rows.
--     Writes now fall into three tiers, and a key in none of the first two is in the third:
--       * WRITER tier (ADMIN or WRITER, first factor): exactly the keys staff code writes
--         through the cookie client — site identity (site_title, site_description,
--         site_keywords, site_social_image, active_logo_id: app/cms/settings/logos/actions.ts),
--         the footer (footer_copyright, footer_show_attribution: settings/copyright/actions.ts)
--         and onboarding_state (lib/onboarding/actions.ts, the dashboard's dismiss button).
--       * ADMIN tier (ADMIN, first factor): the two keys an ADMIN still writes through the
--         cookie client, enabled_payment_providers and ecommerce_inventory_settings
--         (libs/ecommerce payments, shipping, taxes). Moving those writes to the service role
--         lets them drop into the tier below (docs/04 lists it as a follow-up).
--       * everything else: ADMIN with a satisfied second factor (public.is_admin_mfa()). That
--         is the old deny-list plus email_public, bot_protection_public, payment_public,
--         invoice_settings, store_contact, forms_contact, interactions_notification_emails,
--         migration_baseline_generation, the cortex_ai_* settings and any key added later.
--         The app writes all of them with the service role after requireCmsAdmin() /
--         requireEcomAdmin(), Cortex too (its context is the service client); the three that
--         still used the cookie client move in the same change (logos/actions.ts
--         saveInvoiceSettings, cms/inquiries saveStoreContactEmail, the interactions
--         notification-address actions). The last two were already broken for an aal1 admin:
--         an upsert's ON CONFLICT path checks the read policy, and both keys sit above the
--         staff read tier. Reads are untouched (02021/02023 tiers).
--
--  2. The email second factor counts in RLS (HIGH).
--     private.meets_aal_requirement() passed whenever the caller had no verified row in
--     auth.mfa_factors. The app's email factor never creates one (only TOTP does), so for an
--     email-2FA ADMIN every is_admin_mfa() policy was a plain role check: a stolen password and
--     an aal1 JWT reached mcp_access_tokens (a persistent MCP bearer), package_activations,
--     the secret tier of site_settings and other accounts' profiles. The no-factor branch now
--     also requires that the caller has no enrolled factor in public.user_security_settings
--     (`mfa_enabled AND mfa_type IS NOT NULL`, written only by the service role since 02026).
--     An email factor never yields an aal2 Supabase session, so for those admins every
--     is_admin_mfa() row is now reachable only through the service role, after the app's own
--     check (lib/auth/cms-actor.ts getCmsActor() refuses a session whose factor is pending).
--     A TOTP admin keeps aal2, and an admin who enrolled nothing is never locked out.
--
--  3. ADMIN branches that skipped the second factor (MEDIUM).
--     site_scripts / site_script_revisions writes (scripts render with the CSP nonce on every
--     route, /cms included, so this was script injection into a real admin's session),
--     cms_redirects writes (an open redirect on any path), system_configuration (sign-up
--     policy) and the PII reads and updates on product_inquiries, message_threads and
--     thread_messages now use is_admin_mfa(). The CMS actions for all of them run on the
--     service role after requireCmsAdmin() (site scripts, redirects, registration/security,
--     messages); the public thread page and the contact paths already did. The public read
--     policies (active scripts, active redirects) are unchanged.
--
--  4. media: uploader_id is pinned on insert, and storage keys in use are visible (MEDIUM).
--     media_insert_policy only checked the role, so a WRITER could insert a row attributed to
--     anyone; nothing pins object_key or variants either, and app/cms/media/actions.ts deleted
--     every variants[].objectKey of a deleted row with server credentials. A WRITER could
--     insert a decoy row listing other uploaders' keys and delete their files. Insert now pins
--     uploader_id to the caller (ADMIN keeps any). The delete and move actions keep only the
--     keys derived from the row's own object_key (lib/storage/media-object-keys.ts) and ask
--     public.media_storage_keys_in_use() which keys another row still references, so a shared
--     key is never deleted. The function is SECURITY INVOKER and service-role only: the app
--     calls it after its own role check, and the API roles have no use for it.
--
--  5. package_activations: license keys are not readable over the API (MEDIUM, sandbox).
--     The public demo signs every visitor in as an ADMIN with no factor, so is_admin_mfa()
--     passes and "Staff read package activations" handed out the plaintext license key.
--     authenticated now holds SELECT on every column except license_key and meta (meta keeps
--     the Freemius activation response, install API token included). Every app read of the
--     table already uses the service role (packages page, dashboard, verifyPackageOnline,
--     revalidation, activation). Both apply paths repeat the column grant after their blanket
--     grants (API_ROLE_REVOKE_SQL), the same shape as profiles in 02025.
--
--  6. media_read_policy stays USING (true) for anon (LOW, decision recorded).
--     The bucket is public-read and every rendered image carries its object URL, so a media
--     row discloses nothing the object URL does not, beyond its file name, description and
--     uploader id. Scoping it to "media referenced by live content" would have to follow every
--     reference (image blocks, section backgrounds, posts, products, logos, site_settings) and
--     would break images on any path it missed. docs/04 records the decision.
--
-- tools/scripts/security-verify.sql sections 30-34 check every item above, before and after.

-- ---------------------------------------------------------------------------
-- 1. site_settings: three write tiers, WRITER on an allow-list
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS site_settings_insert_policy ON public.site_settings;
CREATE POLICY site_settings_insert_policy ON public.site_settings
  FOR INSERT TO authenticated
  WITH CHECK (
    ((key = ANY (ARRAY['site_title','site_description','site_keywords','site_social_image','active_logo_id','footer_copyright','footer_show_attribution','onboarding_state']::text[]))
      AND (SELECT public.get_current_user_role()) = ANY (ARRAY['ADMIN'::public.user_role,'WRITER'::public.user_role]))
    OR ((key = ANY (ARRAY['enabled_payment_providers','ecommerce_inventory_settings']::text[]))
      AND (SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role)
    OR ((SELECT public.is_admin_mfa()) IS TRUE)
  );

DROP POLICY IF EXISTS site_settings_update_policy ON public.site_settings;
CREATE POLICY site_settings_update_policy ON public.site_settings
  FOR UPDATE TO authenticated
  USING (
    ((key = ANY (ARRAY['site_title','site_description','site_keywords','site_social_image','active_logo_id','footer_copyright','footer_show_attribution','onboarding_state']::text[]))
      AND (SELECT public.get_current_user_role()) = ANY (ARRAY['ADMIN'::public.user_role,'WRITER'::public.user_role]))
    OR ((key = ANY (ARRAY['enabled_payment_providers','ecommerce_inventory_settings']::text[]))
      AND (SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role)
    OR ((SELECT public.is_admin_mfa()) IS TRUE)
  )
  WITH CHECK (
    ((key = ANY (ARRAY['site_title','site_description','site_keywords','site_social_image','active_logo_id','footer_copyright','footer_show_attribution','onboarding_state']::text[]))
      AND (SELECT public.get_current_user_role()) = ANY (ARRAY['ADMIN'::public.user_role,'WRITER'::public.user_role]))
    OR ((key = ANY (ARRAY['enabled_payment_providers','ecommerce_inventory_settings']::text[]))
      AND (SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role)
    OR ((SELECT public.is_admin_mfa()) IS TRUE)
  );

DROP POLICY IF EXISTS site_settings_delete_policy ON public.site_settings;
CREATE POLICY site_settings_delete_policy ON public.site_settings
  FOR DELETE TO authenticated
  USING (
    ((key = ANY (ARRAY['site_title','site_description','site_keywords','site_social_image','active_logo_id','footer_copyright','footer_show_attribution','onboarding_state']::text[]))
      AND (SELECT public.get_current_user_role()) = ANY (ARRAY['ADMIN'::public.user_role,'WRITER'::public.user_role]))
    OR ((key = ANY (ARRAY['enabled_payment_providers','ecommerce_inventory_settings']::text[]))
      AND (SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role)
    OR ((SELECT public.is_admin_mfa()) IS TRUE)
  );

-- ---------------------------------------------------------------------------
-- 2. meets_aal_requirement(): an enrolled email factor counts as a factor
-- ---------------------------------------------------------------------------
-- True when the session is aal2, or when the caller enrolled no second factor at all: no
-- verified Supabase factor (TOTP) AND no enabled factor in user_security_settings (TOTP or the
-- app's email codes). Same signature, owner and grants as 02022; CREATE OR REPLACE keeps the
-- is_admin_mfa() wrapper and every policy that calls it.
CREATE OR REPLACE FUNCTION private.meets_aal_requirement()
    RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT COALESCE((auth.jwt() ->> 'aal'), 'aal1') = 'aal2'
    OR (
      NOT EXISTS (
        SELECT 1 FROM auth.mfa_factors f
        WHERE f.user_id = auth.uid() AND f.status = 'verified'
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.user_security_settings s
        WHERE s.user_id = auth.uid() AND s.mfa_enabled AND s.mfa_type IS NOT NULL
      )
    );
$$;
REVOKE ALL ON FUNCTION private.meets_aal_requirement() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.meets_aal_requirement() TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Second factor on the remaining ADMIN branches
-- ---------------------------------------------------------------------------
-- site_scripts: INSERT / UPDATE / DELETE (the two read policies of 02013 are unchanged)
DROP POLICY IF EXISTS "Admins insert site scripts" ON public.site_scripts;
CREATE POLICY "Admins insert site scripts" ON public.site_scripts
  FOR INSERT TO authenticated WITH CHECK (((SELECT public.is_admin_mfa()) IS TRUE));
DROP POLICY IF EXISTS "Admins update site scripts" ON public.site_scripts;
CREATE POLICY "Admins update site scripts" ON public.site_scripts
  FOR UPDATE TO authenticated USING (((SELECT public.is_admin_mfa()) IS TRUE)) WITH CHECK (((SELECT public.is_admin_mfa()) IS TRUE));
DROP POLICY IF EXISTS "Admins delete site scripts" ON public.site_scripts;
CREATE POLICY "Admins delete site scripts" ON public.site_scripts
  FOR DELETE TO authenticated USING (((SELECT public.is_admin_mfa()) IS TRUE));

-- site_script_revisions: INSERT (UPDATE / DELETE have no policy and no grant since 02026)
DROP POLICY IF EXISTS "Admins insert site script revisions" ON public.site_script_revisions;
CREATE POLICY "Admins insert site script revisions" ON public.site_script_revisions
  FOR INSERT TO authenticated WITH CHECK (((SELECT public.is_admin_mfa()) IS TRUE));

-- cms_redirects: INSERT / UPDATE / DELETE (the two read policies of 02013 are unchanged)
DROP POLICY IF EXISTS "Admins insert redirects" ON public.cms_redirects;
CREATE POLICY "Admins insert redirects" ON public.cms_redirects
  FOR INSERT TO authenticated WITH CHECK (((SELECT public.is_admin_mfa()) IS TRUE));
DROP POLICY IF EXISTS "Admins update redirects" ON public.cms_redirects;
CREATE POLICY "Admins update redirects" ON public.cms_redirects
  FOR UPDATE TO authenticated USING (((SELECT public.is_admin_mfa()) IS TRUE)) WITH CHECK (((SELECT public.is_admin_mfa()) IS TRUE));
DROP POLICY IF EXISTS "Admins delete redirects" ON public.cms_redirects;
CREATE POLICY "Admins delete redirects" ON public.cms_redirects
  FOR DELETE TO authenticated USING (((SELECT public.is_admin_mfa()) IS TRUE));

-- system_configuration: every command (the sign-up path reads it with the service role)
DROP POLICY IF EXISTS system_configuration_admin_select ON public.system_configuration;
CREATE POLICY system_configuration_admin_select ON public.system_configuration
  FOR SELECT TO authenticated USING (((SELECT public.is_admin_mfa()) IS TRUE));
DROP POLICY IF EXISTS system_configuration_admin_insert ON public.system_configuration;
CREATE POLICY system_configuration_admin_insert ON public.system_configuration
  FOR INSERT TO authenticated WITH CHECK (((SELECT public.is_admin_mfa()) IS TRUE));
DROP POLICY IF EXISTS system_configuration_admin_update ON public.system_configuration;
CREATE POLICY system_configuration_admin_update ON public.system_configuration
  FOR UPDATE TO authenticated USING (((SELECT public.is_admin_mfa()) IS TRUE)) WITH CHECK (((SELECT public.is_admin_mfa()) IS TRUE));
DROP POLICY IF EXISTS system_configuration_admin_delete ON public.system_configuration;
CREATE POLICY system_configuration_admin_delete ON public.system_configuration
  FOR DELETE TO authenticated USING (((SELECT public.is_admin_mfa()) IS TRUE));

-- product_inquiries / message_threads: ADMIN read and update (INSERT / DELETE revoked in 02026)
DROP POLICY IF EXISTS product_inquiries_admin_read_policy ON public.product_inquiries;
CREATE POLICY product_inquiries_admin_read_policy ON public.product_inquiries
  FOR SELECT TO authenticated USING (((SELECT public.is_admin_mfa()) IS TRUE));
DROP POLICY IF EXISTS product_inquiries_admin_update_policy ON public.product_inquiries;
CREATE POLICY product_inquiries_admin_update_policy ON public.product_inquiries
  FOR UPDATE TO authenticated USING (((SELECT public.is_admin_mfa()) IS TRUE)) WITH CHECK (((SELECT public.is_admin_mfa()) IS TRUE));

DROP POLICY IF EXISTS message_threads_admin_read_policy ON public.message_threads;
CREATE POLICY message_threads_admin_read_policy ON public.message_threads
  FOR SELECT TO authenticated USING (((SELECT public.is_admin_mfa()) IS TRUE));
DROP POLICY IF EXISTS message_threads_admin_update_policy ON public.message_threads;
CREATE POLICY message_threads_admin_update_policy ON public.message_threads
  FOR UPDATE TO authenticated USING (((SELECT public.is_admin_mfa()) IS TRUE)) WITH CHECK (((SELECT public.is_admin_mfa()) IS TRUE));

-- thread_messages: ADMIN read (every write is the service role's, 02026)
DROP POLICY IF EXISTS thread_messages_admin_read_policy ON public.thread_messages;
CREATE POLICY thread_messages_admin_read_policy ON public.thread_messages
  FOR SELECT TO authenticated USING (((SELECT public.is_admin_mfa()) IS TRUE));

-- ---------------------------------------------------------------------------
-- 4. media: pin uploader_id on insert; which storage keys a row still references
-- ---------------------------------------------------------------------------
-- Same shape as 02022's update/delete policies: a WRITER inserts rows attributed to
-- themselves, an ADMIN may attribute a row to anyone (imports, restores).
DROP POLICY IF EXISTS media_insert_policy ON public.media;
CREATE POLICY media_insert_policy ON public.media
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT public.is_admin()) IS TRUE
    OR (uploader_id = (SELECT auth.uid())
        AND (SELECT public.get_current_user_role()) = ANY (ARRAY['ADMIN'::public.user_role,'WRITER'::public.user_role]))
  );

-- The keys of p_keys that some media row other than p_exclude_id references as its object_key,
-- its file_path or a variants[].objectKey. The CMS delete and move actions call it (service
-- role) after removing or claiming their own rows, and keep every key it returns.
CREATE OR REPLACE FUNCTION public.media_storage_keys_in_use(p_keys text[], p_exclude_id uuid DEFAULT NULL)
    RETURNS SETOF text
    LANGUAGE sql STABLE SECURITY INVOKER
    SET search_path TO ''
    AS $$
  SELECT DISTINCT k.key
    FROM unnest(p_keys) AS k(key)
   WHERE EXISTS (
     SELECT 1
       FROM public.media m
      WHERE m.id IS DISTINCT FROM p_exclude_id
        AND (m.object_key = k.key
             OR m.file_path = k.key
             OR m.variants @> jsonb_build_array(jsonb_build_object('objectKey', k.key)))
   );
$$;
REVOKE ALL ON FUNCTION public.media_storage_keys_in_use(text[], uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.media_storage_keys_in_use(text[], uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. package_activations: no license_key / meta for authenticated
-- ---------------------------------------------------------------------------
-- Table-level SELECT goes (revoking it also drops any column grant), then SELECT comes back on
-- every column except the two secrets. The column list is read from the catalog so the
-- statement matches API_ROLE_REVOKE_SQL; a new column is readable by an aal2 ADMIN, add it to
-- the exclusions there and here if it is sensitive.
DO $nb_package_activations$
DECLARE
  v_cols text;
BEGIN
  SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum)
    INTO v_cols
    FROM pg_attribute a
   WHERE a.attrelid = 'public.package_activations'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname NOT IN ('license_key', 'meta');
  REVOKE SELECT ON TABLE public.package_activations FROM authenticated;
  IF v_cols IS NOT NULL THEN
    EXECUTE format('GRANT SELECT (%s) ON TABLE public.package_activations TO authenticated', v_cols);
  END IF;
END
$nb_package_activations$;

-- ---------------------------------------------------------------------------
-- 6. media_read_policy: unchanged on purpose (see the header)
-- ---------------------------------------------------------------------------
