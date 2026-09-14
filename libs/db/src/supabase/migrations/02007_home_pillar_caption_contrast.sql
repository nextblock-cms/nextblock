-- 02007: home pillar cards -- caption colour-contrast fix (follow-up to 02006).
--
-- 02006 targeted `text-slate-500` captions, but the three pillar cards on the home
-- page ("Free forever" / "No token markup" / the violet one; EN 'home' and FR 'accueil')
-- carry their caption as
--   <p class='mt-3 text-sm text-muted-foreground'>
-- `--muted-foreground` (hsl 215 16% 47%, #65758b) on the violet card's tinted
-- background (#f8f7ff) is 4.41:1 at 14px; WCAG AA needs 4.5:1, and Lighthouse
-- Accessibility stayed at 96 because of it. text-slate-600 is ~7:1 there and reads
-- the same on the emerald and sky cards; dark:text-slate-400 keeps the dark theme,
-- where `text-muted-foreground` was already fine, at the same lightness.
--
-- Scoped to blocks that contain the pillar-card signature (`bg-violet-50/70`) and a
-- parent page, never by blocks.id (ids drift on every install); the class string is
-- rewritten with replace() and nothing else in the block changes. page_revisions rows
-- carrying the same markup get the same rewrite so restoring a seeded revision cannot
-- bring the failure back. Idempotent: a second run matches zero rows.

CREATE OR REPLACE FUNCTION pg_temp.nb_home_pillar_caption_contrast(src text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT replace(src,
    '<p class=''mt-3 text-sm text-muted-foreground''>',
    '<p class=''mt-3 text-sm text-slate-600 dark:text-slate-400''>')
$fn$;

UPDATE public.blocks
   SET content = pg_temp.nb_home_pillar_caption_contrast(content::text)::jsonb,
       updated_at = now()
 WHERE block_type IN ('section', 'text')
   AND page_id IS NOT NULL
   AND content::text LIKE '%bg-violet-50/70%'
   AND content::text LIKE '%<p class=''mt-3 text-sm text-muted-foreground''>%'
   AND content::text <> pg_temp.nb_home_pillar_caption_contrast(content::text);

UPDATE public.page_revisions
   SET content = pg_temp.nb_home_pillar_caption_contrast(content::text)::jsonb
 WHERE content::text LIKE '%bg-violet-50/70%'
   AND content::text LIKE '%<p class=''mt-3 text-sm text-muted-foreground''>%'
   AND content::text <> pg_temp.nb_home_pillar_caption_contrast(content::text);

DROP FUNCTION IF EXISTS pg_temp.nb_home_pillar_caption_contrast(text);
