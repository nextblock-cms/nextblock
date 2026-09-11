-- 02005: home "Live Demo" promo copy -- reset cadence "daily" -> "every 15 minutes".
--
-- cms.nextblock.dev now runs on Vercel Pro and its reset cron in vercel.json is
-- */15 * * * * (was 0 3 * * *, daily). The promo section on the EN ('home') and FR
-- ('accueil') home pages still advertises a daily reset; it already shipped through
-- 02000 (catch-up) / 02004 (baseline) and lives on real installs, so per the append-only
-- rule this is a forward-only data fix instead of an edit to those files.
--
-- Targets the promo by its nb-sandbox-promo sentinel + parent page (never blocks.id:
-- ids drift on every install) and rewrites only the six cadence phrases (EN + FR) with
-- replace(), leaving the rest of the block untouched. page_revisions rows carrying the
-- sentinel get the same rewrite so restoring a seeded revision cannot bring the "daily"
-- copy back. Idempotent: a second run matches zero rows (content already equals the
-- rewritten text). On the sandbox the promo is still stripped afterward by
-- removeSandboxPromoSections in the reset-sandbox route.
--
-- NOTE: keep the word "sandbox" OUT of this filename -- generate-sandbox-reset.ts
-- excludes any migration whose filename contains "sandbox" from the reset bundle.

CREATE OR REPLACE FUNCTION pg_temp.nb_promo_cadence_15min(src text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT replace(replace(replace(replace(replace(replace(src,
    'It resets daily, so explore',
    'It resets every 15 minutes, so explore'),
    '&middot; Resets daily</p>',
    '&middot; Resets every 15 minutes</p>'),
    'Wipes clean daily</strong>',
    'Wipes clean every 15 minutes</strong>'),
    'Il se r&eacute;initialise chaque jour :',
    'Il se r&eacute;initialise toutes les 15 minutes :'),
    'R&eacute;initialis&eacute; chaque jour</p>',
    'R&eacute;initialis&eacute; toutes les 15 minutes</p>'),
    'Remis &agrave; z&eacute;ro chaque jour</strong>',
    'Remis &agrave; z&eacute;ro toutes les 15 minutes</strong>')
$fn$;

UPDATE public.blocks
   SET content = pg_temp.nb_promo_cadence_15min(content::text)::jsonb,
       updated_at = now()
 WHERE block_type = 'section'
   AND page_id IS NOT NULL
   AND content::text LIKE '%nb-sandbox-promo%'
   AND content::text <> pg_temp.nb_promo_cadence_15min(content::text);

UPDATE public.page_revisions
   SET content = pg_temp.nb_promo_cadence_15min(content::text)::jsonb
 WHERE content::text LIKE '%nb-sandbox-promo%'
   AND content::text <> pg_temp.nb_promo_cadence_15min(content::text);

DROP FUNCTION IF EXISTS pg_temp.nb_promo_cadence_15min(text);
