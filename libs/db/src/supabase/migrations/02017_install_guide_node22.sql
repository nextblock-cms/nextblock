-- 02017: install guide (EN + FR) -- Node.js floor 20 -> 22.12.
--
-- The "How to Install NextBlock" post ('how-to-setup-nextblock', EN) and its French twin
-- ('comment-configurer-nextblock', FR) still tell readers to install Node.js 20. The
-- upgraded dependencies no longer run there: supabase-js >= 2.110 and AI SDK 7 declare
-- node >= 22, and both paths the guide describes need 22.12 -- the create-nextblock CLI
-- (engines >= 22.12.0) and the cloned repository's Vitest 5 / Vite 8 toolchain. Node 20
-- has been end-of-life since 2026-04-30. The copy shipped through 02000 (catch-up) / 02004
-- (baseline) and lives on real installs, so per the append-only rule this is a
-- forward-only data fix instead of an edit to those files.
--
-- Targets the text block of each guide post by parent (post resolved by slug + language
-- code; never blocks.id: ids drift on every install) plus the 'Node.js 20' signature, and
-- rewrites only the eight seeded phrases (four EN, four FR; "or newer" / "ou plus récent"
-- appears twice per language) with replace(), leaving the rest of the block and any
-- operator-edited wording untouched. post_revisions rows of the same posts get the same
-- rewrite so restoring a seeded revision cannot bring the Node.js 20 copy back.
-- Idempotent: a second run matches zero rows (the rewritten text no longer contains
-- 'Node.js 20').
--
-- NOTE: keep the word "sandbox" OUT of this filename -- generate-sandbox-reset.ts
-- excludes any migration whose filename contains "sandbox" from the reset bundle.

CREATE OR REPLACE FUNCTION pg_temp.nb_install_guide_node22(src text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT replace(replace(replace(replace(replace(replace(replace(replace(src,
    '>Node.js 20 or newer</a>',
    '>Node.js 22.12 or newer</a>'),
    '>Node.js 20+</a> and Docker Desktop',
    '>Node.js 22.12+</a> and Docker Desktop'),
    'managed-cloud path: Node.js 20+ plus',
    'managed-cloud path: Node.js 22.12+ plus'),
    'cloned repository: Node.js 20+ and git',
    'cloned repository: Node.js 22.12+ and git'),
    '>Node.js 20 ou plus récent</a>',
    '>Node.js 22.12 ou plus récent</a>'),
    '>Node.js 20+</a> et Docker Desktop',
    '>Node.js 22.12+</a> et Docker Desktop'),
    'Node.js 20+ ainsi qu',
    'Node.js 22.12+ ainsi qu'),
    'Node.js 20+ et git',
    'Node.js 22.12+ et git')
$fn$;

UPDATE public.blocks AS b
   SET content = pg_temp.nb_install_guide_node22(b.content::text)::jsonb,
       updated_at = now()
  FROM public.posts AS p
  JOIN public.languages AS l ON l.id = p.language_id
 WHERE b.post_id = p.id
   AND b.block_type = 'text'
   AND ((p.slug = 'how-to-setup-nextblock' AND l.code = 'en')
     OR (p.slug = 'comment-configurer-nextblock' AND l.code = 'fr'))
   AND b.content::text LIKE '%Node.js 20%'
   AND b.content::text <> pg_temp.nb_install_guide_node22(b.content::text);

UPDATE public.post_revisions AS r
   SET content = pg_temp.nb_install_guide_node22(r.content::text)::jsonb
  FROM public.posts AS p
  JOIN public.languages AS l ON l.id = p.language_id
 WHERE r.post_id = p.id
   AND ((p.slug = 'how-to-setup-nextblock' AND l.code = 'en')
     OR (p.slug = 'comment-configurer-nextblock' AND l.code = 'fr'))
   AND r.content::text LIKE '%Node.js 20%'
   AND r.content::text <> pg_temp.nb_install_guide_node22(r.content::text);

DROP FUNCTION IF EXISTS pg_temp.nb_install_guide_node22(text);
