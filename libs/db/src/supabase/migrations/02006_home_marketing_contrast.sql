-- 02006: home marketing copy -- fix two WCAG AA colour-contrast failures.
--
-- Lighthouse Accessibility dropped from 100 to 97 on the home page after the
-- marketing revamp, on two seeded elements (EN 'home' and FR 'accueil'):
--
--   1. The competitor column header of the comparison table
--      ("Lovable, Bolt, v0"): text-rose-600 (#ec003f) on the thead's bg-slate-50
--      (#f8fafc) is 4.32:1 at 12px; AA needs 4.5:1. text-rose-700 gives ~5.8:1.
--   2. The small caption under each of the three pillar cards ("mt-10 grid ...
--      md:grid-cols-3"): text-slate-500 (#65758b) on the violet card's tinted
--      background (#f8f7ff) is 4.41:1 at 14px. text-slate-600 gives ~7:1, and is
--      just as legible on the emerald and sky cards, so all three move together.
--
-- Both strings already shipped through 02000 (catch-up) / 02004 (baseline) and live
-- on real installs, so per the append-only rule this is a forward-only data fix
-- instead of an edit to those files. Dark-mode classes are untouched.
--
-- Targets the blocks by content signature + parent (never blocks.id: ids drift on
-- every install) and rewrites only the two class strings with replace(), leaving the
-- rest of the block untouched. page_revisions rows carrying the same markup get the
-- same rewrite so restoring a seeded revision cannot bring the failures back.
-- Idempotent: a second run matches zero rows (content already equals the rewritten
-- text).

CREATE OR REPLACE FUNCTION pg_temp.nb_home_marketing_contrast(src text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT replace(replace(src,
    'tracking-[0.2em] text-rose-600 dark:text-rose-300',
    'tracking-[0.2em] text-rose-700 dark:text-rose-300'),
    '<p class=''mt-3 text-sm text-slate-500 dark:text-slate-400''>',
    '<p class=''mt-3 text-sm text-slate-600 dark:text-slate-400''>')
$fn$;

UPDATE public.blocks
   SET content = pg_temp.nb_home_marketing_contrast(content::text)::jsonb,
       updated_at = now()
 WHERE block_type IN ('section', 'text')
   AND page_id IS NOT NULL
   AND (
     content::text LIKE '%tracking-[0.2em] text-rose-600 dark:text-rose-300%'
     OR content::text LIKE '%<p class=''mt-3 text-sm text-slate-500 dark:text-slate-400''>%'
   )
   AND content::text <> pg_temp.nb_home_marketing_contrast(content::text);

UPDATE public.page_revisions
   SET content = pg_temp.nb_home_marketing_contrast(content::text)::jsonb
 WHERE (
     content::text LIKE '%tracking-[0.2em] text-rose-600 dark:text-rose-300%'
     OR content::text LIKE '%<p class=''mt-3 text-sm text-slate-500 dark:text-slate-400''>%'
   )
   AND content::text <> pg_temp.nb_home_marketing_contrast(content::text);

DROP FUNCTION IF EXISTS pg_temp.nb_home_marketing_contrast(text);
