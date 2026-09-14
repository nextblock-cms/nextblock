-- 02014: package_activations is readable by staff only.
--
-- The baseline granted SELECT on package_activations to every authenticated user
-- ("Allow authenticated read access" USING (true)). Public sign-up creates USER-role
-- accounts, so any storefront customer could read the plaintext license keys and the
-- Freemius install handles (meta.fm_uid / meta.fm_install_id) of the premium packages —
-- and the dashboard now buys and stores those keys itself. Only staff surfaces read
-- this table with the cookie client (the dashboard stats for ADMIN and WRITER, the
-- packages page for ADMIN); everything else goes through the service role, which is
-- unaffected. Writes were never allowed to authenticated users and stay that way.

DROP POLICY IF EXISTS "Allow authenticated read access" ON public.package_activations;

CREATE POLICY "Staff read package activations" ON public.package_activations
  FOR SELECT TO authenticated
  USING (
    (SELECT public.get_current_user_role()) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])
  );
