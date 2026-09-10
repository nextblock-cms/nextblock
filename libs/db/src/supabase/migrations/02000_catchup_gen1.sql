-- AUTO-GENERATED catch-up for squash generation 2: replays generation 1's forward migrations.
-- catchup-from: 00000000000004
-- catchup-through: 00000000000042
-- files: 39
--
-- Slot 000 of the generation, so it runs BEFORE the baseline: a database that sat behind the
-- previous generation is brought to its end with the exact historical DDL, and the baseline
-- files that follow are then no-ops. Each retired file below runs only if its version is not
-- recorded in supabase_migrations.schema_migrations (or, for Docker installs, its file stem in
-- public._nextblock_docker_migrations) — exactly what a normal update would have applied.
-- The whole file is skipped on an empty database (the baseline creates everything) and on a
-- database whose site_settings.migration_baseline_generation is already >= 2.
-- A database at exactly catchup-through may record this version as applied without running it
-- (npm run db:migrate:repair-history -- --reconcile-squash).
-- Regenerate via tools/scripts/rebaseline-transform.mjs — do not hand-edit.

-- Registry lookup helper (session-scoped; dropped again at the end of this file).
CREATE OR REPLACE FUNCTION pg_temp.nb_recorded(p_version text, p_stem text) RETURNS boolean
LANGUAGE plpgsql AS $nb_helper$
DECLARE v boolean := false;
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = $1)' INTO v USING p_version;
    IF v THEN RETURN true; END IF;
  END IF;
  IF to_regclass('public._nextblock_docker_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public._nextblock_docker_migrations WHERE version = $1)' INTO v USING p_stem;
    IF v THEN RETURN true; END IF;
  END IF;
  RETURN false;
END $nb_helper$;

DO $nb_catchup$
DECLARE
  v_generation int;
BEGIN
  -- Brand-new database (no schema yet): the baseline files that follow create everything.
  IF to_regclass('public.site_settings') IS NULL THEN
    RAISE NOTICE 'catch-up skipped: empty database, the baseline follows';
    RETURN;
  END IF;

  -- Born at (or already caught up to) this generation: nothing to replay.
  EXECUTE $nb_q$SELECT (value #>> '{}')::int FROM public.site_settings WHERE key = $1$nb_q$
    INTO v_generation USING 'migration_baseline_generation';
  IF v_generation IS NOT NULL AND v_generation >= 2 THEN
    RAISE NOTICE 'catch-up skipped: database is already at squash generation 2';
    RETURN;
  END IF;

  -- >>> FROM: 00000000000004_default_logo_email_safe.sql
  IF NOT pg_temp.nb_recorded('00000000000004', '00000000000004_default_logo_email_safe') THEN
    RAISE NOTICE 'catch-up: applying 00000000000004_default_logo_email_safe.sql';
    EXECUTE $nb_file_00000000000004$
-- Swap the seeded DEFAULT site logo from the WebP asset to a bundled PNG.
--
-- WebP (and AVIF) don't render in Outlook and several other email clients, so the default
-- logo shown in transactional emails was a broken image out of the box. The PNG is a
-- /public bundled asset (registered in resolveMediaUrl's BUNDLED_PUBLIC_MEDIA_KEYS), so it
-- resolves to `<site>/images/nextblock-logo-button-tiny.png` and renders everywhere.
--
-- Forward-only, data-only (no schema change), idempotent, and GUARDED so it never
-- overrides a logo an operator has since chosen: it only repoints the seeded default logo
-- row while that row still points at the seeded WebP media.

INSERT INTO public.media (
  id, uploader_id, file_name, object_key, file_type, size_bytes, description,
  width, height, blur_data_url, variants, file_path, folder, created_at, updated_at
) VALUES (
  'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', NULL, 'nextblock-logo-button-tiny.png',
  'images/nextblock-logo-button-tiny.png', 'image/png', 10000, 'Default site logo',
  NULL, NULL, NULL, NULL, NULL, NULL, now(), now()
) ON CONFLICT DO NOTHING;

UPDATE public.logos
SET media_id = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
WHERE id = 'd45ef03d-27fc-4099-8b46-1cdf82d658d2'
  AND media_id = 'ea6fdaf5-f8de-416c-9f2b-b689b7a4ed38';
$nb_file_00000000000004$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000004_default_logo_email_safe.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000004_default_logo_email_safe.sql

  -- >>> FROM: 00000000000005_add_custom_canonical.sql
  IF NOT pg_temp.nb_recorded('00000000000005', '00000000000005_add_custom_canonical') THEN
    RAISE NOTICE 'catch-up: applying 00000000000005_add_custom_canonical.sql';
    EXECUTE $nb_file_00000000000005$
-- Add a nullable `custom_canonical` column to pages, posts and products.
--
-- This is the per-content manual canonical override used by each route's
-- generateMetadata(): when set, it wins over the default self-referencing
-- `<site_url>/<slug>` canonical (see app/lib/seo.ts buildCanonicalUrl). NULL/empty
-- keeps the self-referencing default, so existing rows are unaffected.
--
-- Forward-only and idempotent (ADD COLUMN IF NOT EXISTS). No backfill: a NULL value
-- is the "use the default canonical" sentinel.

ALTER TABLE public.pages ADD COLUMN IF NOT EXISTS custom_canonical text;
ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS custom_canonical text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS custom_canonical text;
$nb_file_00000000000005$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000005_add_custom_canonical.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000005_add_custom_canonical.sql

  -- >>> FROM: 00000000000006_home_live_demo_promo.sql
  IF NOT pg_temp.nb_recorded('00000000000006', '00000000000006_home_live_demo_promo') THEN
    RAISE NOTICE 'catch-up: applying 00000000000006_home_live_demo_promo.sql';
    EXECUTE $nb_file_00000000000006$
-- 00000000000006_home_sandbox_promo.sql
-- Adds a "Live Demo" promo section to the English (slug 'home') and French
-- (slug 'accueil') home pages that drives visitors to the public sandbox at
-- https://cms.nextblock.dev -- production (nextblock.dev) never mentioned it before.
--
-- The section is inserted right after the hero (order 1); existing home-page blocks
-- shift down by one so relative order is preserved. Each block carries a sentinel
-- comment (nb-sandbox-promo) inside its HTML so the sandbox reset route can strip it
-- there: a CTA pointing at the sandbox is pointless *inside* the sandbox itself.
--
-- Forward-only and idempotent: the NOT EXISTS sentinel guard makes a re-run a no-op,
-- and page lookups are by (language code, slug) so explicit IDs never collide with
-- user-created blocks on a live database.

DO $body$
DECLARE
  v_en_lang integer;
  v_fr_lang integer;
  v_en_page integer;
  v_fr_page integer;
BEGIN
  SELECT id INTO v_en_lang FROM public.languages WHERE code = 'en' LIMIT 1;
  SELECT id INTO v_fr_lang FROM public.languages WHERE code = 'fr' LIMIT 1;

  -- English home page
  SELECT id INTO v_en_page
    FROM public.pages
   WHERE slug = 'home' AND language_id = v_en_lang
   ORDER BY id
   LIMIT 1;

  IF v_en_page IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.blocks
     WHERE page_id = v_en_page AND content::text LIKE '%nb-sandbox-promo%'
  ) THEN
    UPDATE public.blocks
       SET "order" = "order" + 1
     WHERE page_id = v_en_page AND "order" >= 1;

    INSERT INTO public.blocks (page_id, language_id, block_type, content, "order")
    VALUES (v_en_page, v_en_lang, 'section', $en$
{"container_type":"container","background":{"type":"gradient","gradient":{"type":"linear","direction":"135deg","stops":[{"color":"#020817","position":0},{"color":"#0b1e3d","position":50},{"color":"#0e2a4d","position":100}]}},"responsive_columns":{"mobile":1,"tablet":1,"desktop":2},"column_gap":"xl","vertical_alignment":"center","padding":{"top":"xl","bottom":"xl"},"column_blocks":[[{"block_type":"text","content":{"html_content":"<!--nb-sandbox-promo--><p class='text-xs uppercase tracking-[0.25em] text-cyan-400 font-bold mb-4'>Live Demo &middot; No Signup</p><h2 class='text-4xl md:text-5xl font-bold text-white mb-6 leading-tight'>Try the full CMS,<br/>live right now.</h2><p class='text-lg text-slate-300 max-w-xl leading-relaxed mb-8'>Don't just read about NextBlock&trade; &mdash; take the wheel. Our public sandbox is a complete, pre-loaded install where you can build pages with the block editor, manage bilingual content, and browse a working demo store. It resets every hour, so explore freely and break whatever you like.</p>"}},{"block_type":"text","content":{"html_content":"<div class='flex flex-col sm:flex-row gap-4'><a href='https://cms.nextblock.dev' target='_blank' rel='noopener noreferrer' class='inline-flex items-center justify-center gap-2 rounded-xl px-7 h-12 text-sm font-semibold text-white bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 shadow-lg shadow-blue-500/25 transition-all no-underline'>Explore the Live Demo &rarr;</a><a href='https://cms.nextblock.dev/sign-in' target='_blank' rel='noopener noreferrer' class='inline-flex items-center justify-center gap-2 rounded-xl px-7 h-12 text-sm font-semibold text-white border border-white/20 hover:bg-white/10 backdrop-blur-sm transition-all no-underline'>Open the CMS Dashboard &rarr;</a></div><p class='text-xs text-slate-400 mt-4'>Demo login <span class='font-mono text-slate-300'>demo@nextblock.dev</span> / <span class='font-mono text-slate-300'>password</span> &middot; Resets hourly</p>"}}],[{"block_type":"text","content":{"html_content":"<div class='rounded-3xl overflow-hidden border border-white/10 bg-white/5 backdrop-blur-xl shadow-2xl'><div class='flex items-center gap-2 px-4 py-3 border-b border-white/10 bg-white/5'><span class='w-3 h-3 rounded-full bg-red-400/70'></span><span class='w-3 h-3 rounded-full bg-yellow-400/70'></span><span class='w-3 h-3 rounded-full bg-green-400/70'></span><span class='ml-3 flex-1 truncate rounded-md bg-black/30 px-3 py-1 text-xs font-mono text-slate-300'>cms.nextblock.dev</span></div><div class='p-6 sm:p-8'><p class='text-sm text-slate-300 mb-5'>A living NextBlock&trade; install &mdash; everything here is real and clickable:</p><ul class='space-y-4 text-sm text-slate-200'><li class='flex items-start gap-3'><span class='mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-cyan-500/15 text-cyan-300 text-xs'>&#10003;</span><span><strong class='text-white'>Full block editor</strong> with slash commands &amp; drag-and-drop.</span></li><li class='flex items-start gap-3'><span class='mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-cyan-500/15 text-cyan-300 text-xs'>&#10003;</span><span><strong class='text-white'>Bilingual</strong> English / French content management.</span></li><li class='flex items-start gap-3'><span class='mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-cyan-500/15 text-cyan-300 text-xs'>&#10003;</span><span><strong class='text-white'>A complete demo storefront</strong> with live checkout.</span></li><li class='flex items-start gap-3'><span class='mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-cyan-500/15 text-cyan-300 text-xs'>&#10003;</span><span><strong class='text-white'>Wipes clean every hour</strong> &mdash; always a fresh start.</span></li></ul></div></div>"}}]]}
$en$::jsonb, 1);
  END IF;

  -- French home page
  SELECT id INTO v_fr_page
    FROM public.pages
   WHERE slug = 'accueil' AND language_id = v_fr_lang
   ORDER BY id
   LIMIT 1;

  IF v_fr_page IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.blocks
     WHERE page_id = v_fr_page AND content::text LIKE '%nb-sandbox-promo%'
  ) THEN
    UPDATE public.blocks
       SET "order" = "order" + 1
     WHERE page_id = v_fr_page AND "order" >= 1;

    INSERT INTO public.blocks (page_id, language_id, block_type, content, "order")
    VALUES (v_fr_page, v_fr_lang, 'section', $fr$
{"container_type":"container","background":{"type":"gradient","gradient":{"type":"linear","direction":"135deg","stops":[{"color":"#020817","position":0},{"color":"#0b1e3d","position":50},{"color":"#0e2a4d","position":100}]}},"responsive_columns":{"mobile":1,"tablet":1,"desktop":2},"column_gap":"xl","vertical_alignment":"center","padding":{"top":"xl","bottom":"xl"},"column_blocks":[[{"block_type":"text","content":{"html_content":"<!--nb-sandbox-promo--><p class='text-xs uppercase tracking-[0.25em] text-cyan-400 font-bold mb-4'>D&eacute;mo en direct &middot; Sans inscription</p><h2 class='text-4xl md:text-5xl font-bold text-white mb-6 leading-tight'>Essayez le CMS complet,<br/>en direct d&egrave;s maintenant.</h2><p class='text-lg text-slate-300 max-w-xl leading-relaxed mb-8'>Ne vous contentez pas de lire &agrave; propos de NextBlock&trade; &mdash; prenez les commandes. Notre bac &agrave; sable public est une installation compl&egrave;te et pr&eacute;charg&eacute;e o&ugrave; vous pouvez cr&eacute;er des pages avec l'&eacute;diteur de blocs, g&eacute;rer du contenu bilingue et parcourir une vraie boutique de d&eacute;monstration. Il se r&eacute;initialise chaque heure : explorez librement et cassez tout ce que vous voulez.</p>"}},{"block_type":"text","content":{"html_content":"<div class='flex flex-col sm:flex-row gap-4'><a href='https://cms.nextblock.dev' target='_blank' rel='noopener noreferrer' class='inline-flex items-center justify-center gap-2 rounded-xl px-7 h-12 text-sm font-semibold text-white bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 shadow-lg shadow-blue-500/25 transition-all no-underline'>D&eacute;couvrir la d&eacute;mo &rarr;</a><a href='https://cms.nextblock.dev/sign-in' target='_blank' rel='noopener noreferrer' class='inline-flex items-center justify-center gap-2 rounded-xl px-7 h-12 text-sm font-semibold text-white border border-white/20 hover:bg-white/10 backdrop-blur-sm transition-all no-underline'>Ouvrir le tableau de bord &rarr;</a></div><p class='text-xs text-slate-400 mt-4'>Identifiants d&eacute;mo <span class='font-mono text-slate-300'>demo@nextblock.dev</span> / <span class='font-mono text-slate-300'>password</span> &middot; R&eacute;initialis&eacute; chaque heure</p>"}}],[{"block_type":"text","content":{"html_content":"<div class='rounded-3xl overflow-hidden border border-white/10 bg-white/5 backdrop-blur-xl shadow-2xl'><div class='flex items-center gap-2 px-4 py-3 border-b border-white/10 bg-white/5'><span class='w-3 h-3 rounded-full bg-red-400/70'></span><span class='w-3 h-3 rounded-full bg-yellow-400/70'></span><span class='w-3 h-3 rounded-full bg-green-400/70'></span><span class='ml-3 flex-1 truncate rounded-md bg-black/30 px-3 py-1 text-xs font-mono text-slate-300'>cms.nextblock.dev</span></div><div class='p-6 sm:p-8'><p class='text-sm text-slate-300 mb-5'>Une installation NextBlock&trade; bien vivante &mdash; tout ici est r&eacute;el et cliquable :</p><ul class='space-y-4 text-sm text-slate-200'><li class='flex items-start gap-3'><span class='mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-cyan-500/15 text-cyan-300 text-xs'>&#10003;</span><span><strong class='text-white'>&Eacute;diteur de blocs complet</strong> : commandes slash et glisser-d&eacute;poser.</span></li><li class='flex items-start gap-3'><span class='mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-cyan-500/15 text-cyan-300 text-xs'>&#10003;</span><span><strong class='text-white'>Gestion bilingue</strong> du contenu fran&ccedil;ais / anglais.</span></li><li class='flex items-start gap-3'><span class='mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-cyan-500/15 text-cyan-300 text-xs'>&#10003;</span><span><strong class='text-white'>Une boutique de d&eacute;monstration compl&egrave;te</strong> avec paiement r&eacute;el.</span></li><li class='flex items-start gap-3'><span class='mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-cyan-500/15 text-cyan-300 text-xs'>&#10003;</span><span><strong class='text-white'>Remis &agrave; z&eacute;ro chaque heure</strong> &mdash; toujours un nouveau d&eacute;part.</span></li></ul></div></div>"}}]]}
$fr$::jsonb, 1);
  END IF;
END
$body$;
$nb_file_00000000000006$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000006_home_live_demo_promo.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000006_home_live_demo_promo.sql

  -- >>> FROM: 00000000000007_home_live_demo_promo_copy_fix.sql
  IF NOT pg_temp.nb_recorded('00000000000007', '00000000000007_home_live_demo_promo_copy_fix') THEN
    RAISE NOTICE 'catch-up: applying 00000000000007_home_live_demo_promo_copy_fix.sql';
    EXECUTE $nb_file_00000000000007$
-- 00000000000007_home_live_demo_promo_copy_fix.sql
-- Corrects the "Live Demo" promo that migration 006 seeded on the EN (slug 'home')
-- and FR (slug 'accueil') home pages. 006 was already applied to production and the
-- sandbox, so per the append-only rule this ships the corrections as a forward-only
-- UPDATE instead of editing 006 (which would never re-run and would desync the file
-- from what was actually applied).
--
-- Fixes: reset cadence "hourly" -> "daily" (the reset cron in vercel.json is daily,
-- 0 3 * * *, not hourly); FR "avec paiement reel" -> "un parcours de paiement complet"
-- (sandbox checkout is simulated); FR anglicism "lire a propos de" -> "lire des
-- articles sur"; and an accessible WCAG-AA primary CTA (solid blue-600, was white on
-- a low-contrast cyan gradient).
--
-- Idempotent: re-running sets identical content. Targets exactly the promo blocks via
-- the nb-sandbox-promo sentinel, scoped by language. On the sandbox the promo is still
-- stripped afterward by removeSandboxPromoSections in the reset-sandbox route.
--
-- NOTE: keep the word "sandbox" OUT of this filename -- generate-sandbox-reset.ts
-- excludes any migration whose filename contains "sandbox" from the reset bundle.

DO $body$
DECLARE
  v_en_lang integer;
  v_fr_lang integer;
BEGIN
  SELECT id INTO v_en_lang FROM public.languages WHERE code = 'en' LIMIT 1;
  SELECT id INTO v_fr_lang FROM public.languages WHERE code = 'fr' LIMIT 1;

  UPDATE public.blocks
     SET content = $en$
{"container_type":"container","background":{"type":"gradient","gradient":{"type":"linear","direction":"135deg","stops":[{"color":"#020817","position":0},{"color":"#0b1e3d","position":50},{"color":"#0e2a4d","position":100}]}},"responsive_columns":{"mobile":1,"tablet":1,"desktop":2},"column_gap":"xl","vertical_alignment":"center","padding":{"top":"xl","bottom":"xl"},"column_blocks":[[{"block_type":"text","content":{"html_content":"<!--nb-sandbox-promo--><p class='text-xs uppercase tracking-[0.25em] text-cyan-400 font-bold mb-4'>Live Demo &middot; No Signup</p><h2 class='text-4xl md:text-5xl font-bold text-white mb-6 leading-tight'>Try the full CMS,<br/>live right now.</h2><p class='text-lg text-slate-300 max-w-xl leading-relaxed mb-8'>Don't just read about NextBlock&trade; &mdash; take the wheel. Our public sandbox is a complete, pre-loaded install where you can build pages with the block editor, manage bilingual content, and browse a working demo store. It resets daily, so explore freely and break whatever you like.</p>"}},{"block_type":"text","content":{"html_content":"<div class='flex flex-col sm:flex-row gap-4'><a href='https://cms.nextblock.dev' target='_blank' rel='noopener noreferrer' class='inline-flex items-center justify-center gap-2 rounded-xl px-7 h-12 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 shadow-lg shadow-cyan-500/20 transition-all no-underline'>Explore the Live Demo &rarr;</a><a href='https://cms.nextblock.dev/sign-in' target='_blank' rel='noopener noreferrer' class='inline-flex items-center justify-center gap-2 rounded-xl px-7 h-12 text-sm font-semibold text-white border border-white/20 hover:bg-white/10 backdrop-blur-sm transition-all no-underline'>Open the CMS Dashboard &rarr;</a></div><p class='text-xs text-slate-400 mt-4'>Demo login <span class='font-mono text-slate-300'>demo@nextblock.dev</span> / <span class='font-mono text-slate-300'>password</span> &middot; Resets daily</p>"}}],[{"block_type":"text","content":{"html_content":"<div class='rounded-3xl overflow-hidden border border-white/10 bg-white/5 backdrop-blur-xl shadow-2xl'><div class='flex items-center gap-2 px-4 py-3 border-b border-white/10 bg-white/5'><span class='w-3 h-3 rounded-full bg-red-400/70'></span><span class='w-3 h-3 rounded-full bg-yellow-400/70'></span><span class='w-3 h-3 rounded-full bg-green-400/70'></span><span class='ml-3 flex-1 truncate rounded-md bg-black/30 px-3 py-1 text-xs font-mono text-slate-300'>cms.nextblock.dev</span></div><div class='p-6 sm:p-8'><p class='text-sm text-slate-300 mb-5'>A living NextBlock&trade; install &mdash; everything here is real and clickable:</p><ul class='space-y-4 text-sm text-slate-200'><li class='flex items-start gap-3'><span class='mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-cyan-500/15 text-cyan-300 text-xs'>&#10003;</span><span><strong class='text-white'>Full block editor</strong> with slash commands &amp; drag-and-drop.</span></li><li class='flex items-start gap-3'><span class='mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-cyan-500/15 text-cyan-300 text-xs'>&#10003;</span><span><strong class='text-white'>Bilingual</strong> English / French content management.</span></li><li class='flex items-start gap-3'><span class='mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-cyan-500/15 text-cyan-300 text-xs'>&#10003;</span><span><strong class='text-white'>A complete demo storefront</strong> with a full checkout flow.</span></li><li class='flex items-start gap-3'><span class='mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-cyan-500/15 text-cyan-300 text-xs'>&#10003;</span><span><strong class='text-white'>Wipes clean daily</strong> &mdash; always a fresh start.</span></li></ul></div></div>"}}]]}
$en$::jsonb,
         updated_at = now()
   WHERE block_type = 'section'
     AND page_id IS NOT NULL
     AND language_id = v_en_lang
     AND content::text LIKE '%nb-sandbox-promo%';

  UPDATE public.blocks
     SET content = $fr$
{"container_type":"container","background":{"type":"gradient","gradient":{"type":"linear","direction":"135deg","stops":[{"color":"#020817","position":0},{"color":"#0b1e3d","position":50},{"color":"#0e2a4d","position":100}]}},"responsive_columns":{"mobile":1,"tablet":1,"desktop":2},"column_gap":"xl","vertical_alignment":"center","padding":{"top":"xl","bottom":"xl"},"column_blocks":[[{"block_type":"text","content":{"html_content":"<!--nb-sandbox-promo--><p class='text-xs uppercase tracking-[0.25em] text-cyan-400 font-bold mb-4'>D&eacute;mo en direct &middot; Sans inscription</p><h2 class='text-4xl md:text-5xl font-bold text-white mb-6 leading-tight'>Essayez le CMS complet,<br/>en direct d&egrave;s maintenant.</h2><p class='text-lg text-slate-300 max-w-xl leading-relaxed mb-8'>Ne vous contentez pas de lire des articles sur NextBlock&trade; &mdash; prenez les commandes. Notre bac &agrave; sable public est une installation compl&egrave;te et pr&eacute;charg&eacute;e o&ugrave; vous pouvez cr&eacute;er des pages avec l'&eacute;diteur de blocs, g&eacute;rer du contenu bilingue et parcourir une vraie boutique de d&eacute;monstration. Il se r&eacute;initialise chaque jour : explorez librement et cassez tout ce que vous voulez.</p>"}},{"block_type":"text","content":{"html_content":"<div class='flex flex-col sm:flex-row gap-4'><a href='https://cms.nextblock.dev' target='_blank' rel='noopener noreferrer' class='inline-flex items-center justify-center gap-2 rounded-xl px-7 h-12 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 shadow-lg shadow-cyan-500/20 transition-all no-underline'>D&eacute;couvrir la d&eacute;mo &rarr;</a><a href='https://cms.nextblock.dev/sign-in' target='_blank' rel='noopener noreferrer' class='inline-flex items-center justify-center gap-2 rounded-xl px-7 h-12 text-sm font-semibold text-white border border-white/20 hover:bg-white/10 backdrop-blur-sm transition-all no-underline'>Ouvrir le tableau de bord &rarr;</a></div><p class='text-xs text-slate-400 mt-4'>Identifiants d&eacute;mo <span class='font-mono text-slate-300'>demo@nextblock.dev</span> / <span class='font-mono text-slate-300'>password</span> &middot; R&eacute;initialis&eacute; chaque jour</p>"}}],[{"block_type":"text","content":{"html_content":"<div class='rounded-3xl overflow-hidden border border-white/10 bg-white/5 backdrop-blur-xl shadow-2xl'><div class='flex items-center gap-2 px-4 py-3 border-b border-white/10 bg-white/5'><span class='w-3 h-3 rounded-full bg-red-400/70'></span><span class='w-3 h-3 rounded-full bg-yellow-400/70'></span><span class='w-3 h-3 rounded-full bg-green-400/70'></span><span class='ml-3 flex-1 truncate rounded-md bg-black/30 px-3 py-1 text-xs font-mono text-slate-300'>cms.nextblock.dev</span></div><div class='p-6 sm:p-8'><p class='text-sm text-slate-300 mb-5'>Une installation NextBlock&trade; bien vivante &mdash; tout ici est r&eacute;el et cliquable :</p><ul class='space-y-4 text-sm text-slate-200'><li class='flex items-start gap-3'><span class='mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-cyan-500/15 text-cyan-300 text-xs'>&#10003;</span><span><strong class='text-white'>&Eacute;diteur de blocs complet</strong> : commandes slash et glisser-d&eacute;poser.</span></li><li class='flex items-start gap-3'><span class='mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-cyan-500/15 text-cyan-300 text-xs'>&#10003;</span><span><strong class='text-white'>Gestion bilingue</strong> du contenu fran&ccedil;ais / anglais.</span></li><li class='flex items-start gap-3'><span class='mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-cyan-500/15 text-cyan-300 text-xs'>&#10003;</span><span><strong class='text-white'>Une boutique de d&eacute;monstration compl&egrave;te</strong> avec un parcours de paiement complet.</span></li><li class='flex items-start gap-3'><span class='mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-cyan-500/15 text-cyan-300 text-xs'>&#10003;</span><span><strong class='text-white'>Remis &agrave; z&eacute;ro chaque jour</strong> &mdash; toujours un nouveau d&eacute;part.</span></li></ul></div></div>"}}]]}
$fr$::jsonb,
         updated_at = now()
   WHERE block_type = 'section'
     AND page_id IS NOT NULL
     AND language_id = v_fr_lang
     AND content::text LIKE '%nb-sandbox-promo%';
END
$body$;
$nb_file_00000000000007$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000007_home_live_demo_promo_copy_fix.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000007_home_live_demo_promo_copy_fix.sql

  -- >>> FROM: 00000000000008_setup_article_reorder.sql
  IF NOT pg_temp.nb_recorded('00000000000008', '00000000000008_setup_article_reorder') THEN
    RAISE NOTICE 'catch-up: applying 00000000000008_setup_article_reorder.sql';
    EXECUTE $nb_file_00000000000008$
-- 00000000000008_setup_article_reorder.sql
-- Reorders and rewrites the "How to Install NextBlock" setup guide on BOTH language
-- twins: EN (post slug 'how-to-setup-nextblock', post_id=3 / block id=40) and FR
-- (post slug 'comment-configurer-nextblock', post_id=4 / block id=41), both seeded in
-- the baseline seed 00000000000003. New path order, presented as a complexity ladder
-- (simplest -> most hands-on): (1) One-click Vercel, (2) npm create nextblock -> Docker
-- (100% local), (3) npm create nextblock -> your own Supabase + Cloudflare R2, (4) git
-- clone the monorepo (with a note that Docker works there too). The Vercel section now
-- tells users to make the new GitHub repo Public so automatic updates work.
--
-- Forward-only and append-only: the baseline 003 is already applied everywhere and
-- never replays, so this ships the new copy as an idempotent UPDATE (re-running sets
-- identical content). Data-only -- no schema change. blocks.content is JSONB; written
-- with PostgreSQL dollar-quoting to avoid single-quote doubling (same style as 006/007).

UPDATE public.blocks
   SET content = $nben$
{"html_content":"<p class='text-lg leading-8 text-slate-700 dark:text-slate-300'>NextBlock is an open-source, AI-native Next.js CMS built on Supabase — and installing it no longer involves config files, terminal wizards, or manual SQL. Below are four ways to get running, <strong>ordered from the simplest to the most hands-on</strong>: the first is a single click, the last is the full source for people who want to help build NextBlock. They all end in the same place — a browser <strong>setup wizard</strong> that connects your database, configures media storage, and creates your admin account for you.</p>\n\n<div class='mt-8 mb-6 flex items-center gap-4 text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400'>\n  <span class='flex-shrink-0'>Simplest</span>\n  <span class='h-1.5 flex-1 rounded-full bg-gradient-to-r from-blue-400 via-violet-400 to-emerald-400'></span>\n  <span class='flex-shrink-0'>Most control</span>\n</div>\n\n<div class='grid gap-5 md:grid-cols-2 my-6'>\n  <a href='#one-click-vercel' class='block rounded-[1.75rem] border border-blue-200 bg-blue-50/70 p-6 no-underline transition-shadow hover:shadow-lg dark:border-blue-500/20 dark:bg-blue-500/10'>\n    <div class='flex items-center justify-between mb-4'>\n      <span class='flex h-9 w-9 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white'>1</span>\n      <span class='inline-flex items-center gap-1'><span class='h-1.5 w-5 rounded-full bg-blue-500'></span><span class='h-1.5 w-5 rounded-full bg-slate-200 dark:bg-white/10'></span><span class='h-1.5 w-5 rounded-full bg-slate-200 dark:bg-white/10'></span><span class='h-1.5 w-5 rounded-full bg-slate-200 dark:bg-white/10'></span></span>\n    </div>\n    <p class='mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-blue-700 dark:text-blue-200'>Easiest &middot; one click</p>\n    <h3 class='mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white'>Deploy on Vercel</h3>\n    <p class='mb-0 text-sm leading-6 text-slate-600 dark:text-slate-300'>A live production site with a managed database. No terminal, no accounts to wire up, nothing to copy.</p>\n  </a>\n  <a href='#npm-docker' class='block rounded-[1.75rem] border border-amber-200 bg-amber-50/70 p-6 no-underline transition-shadow hover:shadow-lg dark:border-amber-500/20 dark:bg-amber-500/10'>\n    <div class='flex items-center justify-between mb-4'>\n      <span class='flex h-9 w-9 items-center justify-center rounded-full bg-amber-500 text-sm font-bold text-white'>2</span>\n      <span class='inline-flex items-center gap-1'><span class='h-1.5 w-5 rounded-full bg-amber-500'></span><span class='h-1.5 w-5 rounded-full bg-amber-500'></span><span class='h-1.5 w-5 rounded-full bg-slate-200 dark:bg-white/10'></span><span class='h-1.5 w-5 rounded-full bg-slate-200 dark:bg-white/10'></span></span>\n    </div>\n    <p class='mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-amber-700 dark:text-amber-200'>Easy &middot; 100% local</p>\n    <h3 class='mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white'>npm create nextblock &rarr; Docker</h3>\n    <p class='mb-0 text-sm leading-6 text-slate-600 dark:text-slate-300'>One prompt scaffolds a project and boots the whole stack — database, auth, storage, CMS — on your machine. No cloud accounts.</p>\n  </a>\n  <a href='#npm-cloud' class='block rounded-[1.75rem] border border-violet-200 bg-violet-50/70 p-6 no-underline transition-shadow hover:shadow-lg dark:border-violet-500/20 dark:bg-violet-500/10'>\n    <div class='flex items-center justify-between mb-4'>\n      <span class='flex h-9 w-9 items-center justify-center rounded-full bg-violet-600 text-sm font-bold text-white'>3</span>\n      <span class='inline-flex items-center gap-1'><span class='h-1.5 w-5 rounded-full bg-violet-500'></span><span class='h-1.5 w-5 rounded-full bg-violet-500'></span><span class='h-1.5 w-5 rounded-full bg-violet-500'></span><span class='h-1.5 w-5 rounded-full bg-slate-200 dark:bg-white/10'></span></span>\n    </div>\n    <p class='mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-violet-700 dark:text-violet-200'>Intermediate &middot; your own cloud</p>\n    <h3 class='mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white'>npm create nextblock &rarr; Supabase + R2</h3>\n    <p class='mb-0 text-sm leading-6 text-slate-600 dark:text-slate-300'>Scaffold a standalone app on your own managed Supabase project and Cloudflare R2, ready to deploy anywhere.</p>\n  </a>\n  <a href='#git-clone' class='block rounded-[1.75rem] border border-emerald-200 bg-emerald-50/70 p-6 no-underline transition-shadow hover:shadow-lg dark:border-emerald-500/20 dark:bg-emerald-500/10'>\n    <div class='flex items-center justify-between mb-4'>\n      <span class='flex h-9 w-9 items-center justify-center rounded-full bg-emerald-600 text-sm font-bold text-white'>4</span>\n      <span class='inline-flex items-center gap-1'><span class='h-1.5 w-5 rounded-full bg-emerald-500'></span><span class='h-1.5 w-5 rounded-full bg-emerald-500'></span><span class='h-1.5 w-5 rounded-full bg-emerald-500'></span><span class='h-1.5 w-5 rounded-full bg-emerald-500'></span></span>\n    </div>\n    <p class='mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200'>Advanced &middot; for contributors</p>\n    <h3 class='mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white'>Clone the repository</h3>\n    <p class='mb-0 text-sm leading-6 text-slate-600 dark:text-slate-300'>Run the complete monorepo — the CMS, every package, and the docs. For people who want to help build NextBlock (Docker works here too).</p>\n  </a>\n</div>\n\n<p class='text-sm text-slate-500 dark:text-slate-400'>Not sure where to start? Work down the list — pick the first option whose requirements you already have. Most people should start with <a href='#one-click-vercel'>Vercel</a>.</p>\n\n<figure class='my-12 overflow-hidden rounded-[2rem] border border-slate-200/80 bg-slate-950 shadow-2xl dark:border-white/10'>\n  <img src='/images/included.webp' alt='NextBlock CMS platform overview showing the block editor, CMS dashboard, and integrations included with every installation' class='w-full h-auto object-cover' />\n  <figcaption class='border-t border-white/10 px-6 py-4 text-sm text-slate-300'>Whichever path you choose, you get the same block editor, the same CMS, and the same database schema.</figcaption>\n</figure>\n\n<h2 id='one-click-vercel'>Option 1: One-Click Deploy on Vercel</h2>\n<p class='mt-2 mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm'><span class='inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-blue-700 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-200'>Step 1 &middot; Easiest</span><span class='text-slate-500 dark:text-slate-400'>Best for a live site with the least possible effort — no terminal, no accounts to wire up.</span></p>\n<p>The fastest way to get a production NextBlock site. One button creates your own copy of NextBlock on GitHub, provisions a managed Supabase database, and deploys the site — you never open a terminal or copy a single key.</p>\n<ol class='space-y-2'>\n  <li><strong>Click Deploy to Vercel</strong> and sign in — Vercel clones NextBlock into a new repository you own.</li>\n  <li><strong>Name the repository — and make it Public.</strong> On Vercel&rsquo;s first step you choose the repository name; set its visibility to <strong>Public</strong> rather than Private. A public repo is what unlocks one-click automatic updates later, so it&rsquo;s the recommended choice.</li>\n  <li><strong>Create the Supabase database</strong> when prompted: pick a name and a region. Vercel connects it to the project and injects the keys before the first build.</li>\n  <li><strong>Open your new site</strong> once the build finishes. Every fresh instance takes you straight to the setup wizard.</li>\n  <li><strong>Create your administrator account.</strong> It is confirmed instantly — no verification email — and you land in the CMS dashboard.</li>\n</ol>\n<div class='my-8'>\n  <a href='https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fnextblock-cms%2Fnextblock&amp;project-name=nextblock&amp;repository-name=nextblock&amp;stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22supabase%22%2C%22productSlug%22%3A%22supabase%22%7D%5D' target='_blank' rel='noopener' class='inline-flex items-center rounded-full bg-slate-900 px-6 py-3 text-sm font-semibold text-white no-underline shadow-lg hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200'>Deploy to Vercel &rarr;</a>\n</div>\n<div class='rounded-3xl border border-emerald-200 bg-emerald-50/80 p-6 my-8 dark:border-emerald-500/20 dark:bg-emerald-500/10'>\n  <p class='mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200'>Recommended &middot; make the repo public</p>\n  <p class='mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200'>When Vercel asks you to name the new repository, choose <strong>Public</strong>. It costs nothing and it&rsquo;s what lets the dashboard&rsquo;s one-click <strong>Connect GitHub</strong> step install a daily workflow that keeps your site synced with the latest NextBlock release. You can still switch a private repo to public later in GitHub — but starting public is the smoothest path to automatic updates.</p>\n</div>\n<div class='rounded-3xl border border-blue-200 bg-blue-50/80 p-6 my-8 dark:border-blue-500/20 dark:bg-blue-500/10'>\n  <p class='mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-blue-700 dark:text-blue-200'>Zero configuration</p>\n  <p class='mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200'>There are no environment variables to fill in. Media storage automatically uses your connected Supabase project, security secrets are derived for you, and database migrations run automatically on every production build. Adding a custom domain later? Set <code>NEXT_PUBLIC_URL</code> in your Vercel project and redeploy.</p>\n</div>\n\n<h2 id='npm-docker'>Option 2: npm create nextblock &rarr; Docker (100% Local)</h2>\n<p class='mt-2 mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm'><span class='inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200'>Step 2 &middot; Easy</span><span class='text-slate-500 dark:text-slate-400'>Best for trying everything on your own machine with zero cloud accounts. Needs Docker Desktop.</span></p>\n<p>Run NextBlock entirely on your own machine with no cloud accounts at all. The CLI scaffolds a standalone Next.js app and then boots the full stack in Docker for you: Supabase&rsquo;s Postgres and auth engines, a PostgREST API behind a Kong gateway, S3-compatible MinIO storage, and the CMS itself — ideal for evaluations, air-gapped environments, and anyone who wants complete data ownership.</p>\n<p>Before you start, install <a href='https://nodejs.org' target='_blank' rel='noopener'>Node.js 20 or newer</a> (it includes npm) and <a href='https://www.docker.com/products/docker-desktop/' target='_blank' rel='noopener'>Docker Desktop</a>, and make sure Docker Desktop is running.</p>\n<pre><code>npm create nextblock@latest my-site</code></pre>\n<ol class='space-y-2'>\n  <li><strong>Choose the hosting profile.</strong> At the first prompt, pick <em>Local Self-Hosted Docker Mode (One-Click Local Sandbox)</em>, then confirm that Docker Desktop is installed and running.</li>\n  <li><strong>Let it run.</strong> The CLI copies the template, installs dependencies, generates secure keys, and boots the whole stack with a single Docker command — no questions asked. The first run pulls images and builds the app, so give it a few minutes; every database migration is applied automatically as the stack comes up.</li>\n  <li><strong>Open <code>http://localhost:3000</code></strong> — it redirects to the setup wizard. Because the database and MinIO storage are already wired up, the connection and media-storage steps are skipped: the only thing left is creating your administrator (confirmed instantly, no email required). You land in the CMS dashboard.</li>\n</ol>\n<div class='rounded-3xl border border-amber-200 bg-amber-50/80 p-6 my-8 dark:border-amber-500/20 dark:bg-amber-500/10'>\n  <p class='mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-amber-700 dark:text-amber-200'>Day-2 commands</p>\n  <pre class='mt-4 mb-0'><code># rebuild and restart the stack\nnpm run docker:up\n\n# stop the stack (your data persists in Docker volumes)\nnpm run docker:down\n\n# follow the application logs\nnpm run docker:logs</code></pre>\n  <p class='mt-4 mb-0 text-sm text-slate-700 dark:text-slate-200'>Docker mode is offered only in the interactive prompt — don&rsquo;t pass <code>--yes</code>, which forces the managed-cloud path below.</p>\n</div>\n\n<h2 id='npm-cloud'>Option 3: npm create nextblock &rarr; Your Own Supabase + Cloudflare</h2>\n<p class='mt-2 mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm'><span class='inline-flex items-center gap-2 rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-violet-700 dark:border-violet-500/20 dark:bg-violet-500/10 dark:text-violet-200'>Step 3 &middot; Intermediate</span><span class='text-slate-500 dark:text-slate-400'>Best for building your own site on managed cloud. Needs a Supabase project and an R2 bucket.</span></p>\n<p>The best starting point for building your own site on managed cloud. The CLI scaffolds a standalone Next.js application with NextBlock already wired in — no monorepo, no workspace tooling — pointed at a Supabase project and Cloudflare R2 bucket you control, and it deploys anywhere Next.js runs.</p>\n<p>Before you start, install <a href='https://nodejs.org' target='_blank' rel='noopener'>Node.js 20 or newer</a>, create a free project at <a href='https://supabase.com' target='_blank' rel='noopener'>supabase.com</a>, and set up a <a href='https://developers.cloudflare.com/r2/' target='_blank' rel='noopener'>Cloudflare R2</a> bucket for your images and files.</p>\n<pre><code>npm create nextblock@latest my-site\ncd my-site\nnpm run dev</code></pre>\n<p>At the first prompt, choose <em>Managed Cloud Mode (Vercel + Supabase Cloud)</em> and name your project. Then open <code>http://localhost:3000/setup</code> and let the wizard take over:</p>\n<ol class='space-y-2'>\n  <li><strong>Connect Supabase</strong> — paste your project URL, publishable (anon) key, secret (service role) key, and a personal access token so the wizard can apply the database schema for you.</li>\n  <li><strong>Add Cloudflare R2</strong> — enter your R2 account ID, bucket name, access key ID, secret access key, and the bucket&rsquo;s public URL for serving images and files.</li>\n  <li><strong>Create your administrator</strong> — the wizard applies every migration, generates the app secrets, writes <code>.env.local</code>, creates your confirmed admin account, and signs you in. Restart <code>npm run dev</code> once afterwards so the fresh environment is baked into the app.</li>\n</ol>\n<div class='rounded-3xl border border-violet-200 bg-violet-50/80 p-6 my-8 dark:border-violet-500/20 dark:bg-violet-500/10'>\n  <p class='mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-violet-700 dark:text-violet-200'>Premium modules</p>\n  <p class='mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200'>Need a store? One command adds products, checkout, orders, and coupons — license-gated and ready when you are: <code>npx create-nextblock activate ecommerce</code></p>\n</div>\n\n<h2 id='git-clone'>Option 4: Clone the Repository</h2>\n<p class='mt-2 mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm'><span class='inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200'>Step 4 &middot; Advanced</span><span class='text-slate-500 dark:text-slate-400'>Best for contributors and teams who want to customize the platform itself. Needs Node.js and git.</span></p>\n<p>Run the full Nx monorepo: the CMS application, every shared package, the CLI source, and the documentation. This is the path for people who want to take part in the project — contributors, plugin authors, and teams that customize the platform itself.</p>\n<pre><code>git clone https://github.com/nextblock-cms/nextblock.git\ncd nextblock\nnpm install\nnpx nx serve nextblock</code></pre>\n<p>Open <code>http://localhost:4200</code> — a fresh install redirects every page to <code>/setup</code>, where the same three-step wizard connects Supabase, configures storage, and creates your admin. It validates your keys, writes <code>.env.local</code> with generated secrets, and applies all migrations over the Supabase Management API — no Supabase CLI required.</p>\n<div class='rounded-3xl border border-emerald-200 bg-emerald-50/80 p-6 my-8 dark:border-emerald-500/20 dark:bg-emerald-500/10'>\n  <p class='mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200'>Prefer to stay local? Use Docker here too</p>\n  <p class='mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200'>You don&rsquo;t need cloud accounts to develop against the monorepo. With Docker Desktop running, one command boots the same self-hosted stack as Option 2 — Postgres, auth, storage, and the CMS — straight from your clone:</p>\n  <pre class='mt-4 mb-0'><code>npm run docker:setup</code></pre>\n  <p class='mt-4 mb-0 text-sm text-slate-700 dark:text-slate-200'>When it finishes, open <code>http://localhost:3000</code> and create your administrator. Note the monorepo has no <code>npm run dev</code> — use <code>npx nx serve nextblock</code> (port 4200) for the cloud path.</p>\n</div>\n\n<h2 id='after-install'>After You Install: Your First 10 Minutes</h2>\n<p>Every path drops you at <code>/cms/dashboard</code>, signed in as the first administrator. A built-in onboarding checklist walks you through the rest:</p>\n<ul class='space-y-2'>\n  <li><strong>Add your branding</strong> — upload your logo and set the site title.</li>\n  <li><strong>Set your footer</strong> — copyright line and footer navigation.</li>\n  <li><strong>Configure email (SMTP)</strong> — under Settings, so password resets and invitations can send.</li>\n  <li><strong>Optional extras</strong> — connect analytics, enable bot protection, and (on Vercel) turn on automatic updates.</li>\n</ul>\n<p>From there, see how the platform fits together in <a href='/article/how-nextblock-works'>How NextBlock Works</a>, add a storefront with the <a href='/article/nextblock-commerce-guide'>Commerce guide</a>, or meet your AI copilot in the <a href='/article/nextblock-cortex-ai-guide'>Cortex AI guide</a>.</p>\n\n<h2 id='faq'>Installation FAQ</h2>\n<h3>What do I need installed?</h3>\n<p>Nothing for the Vercel path — it runs entirely in the browser. For <code>npm create nextblock</code> in Docker mode: <a href='https://nodejs.org' target='_blank' rel='noopener'>Node.js 20+</a> and Docker Desktop. For the managed-cloud path: Node.js 20+ plus a Supabase project and a Cloudflare R2 bucket. For the cloned repository: Node.js 20+ and git (add Docker Desktop if you want to run the local stack).</p>\n<h3>Is NextBlock free?</h3>\n<p>Yes — the core of NextBlock is a 100% free, open-source CMS (AGPL). Premium packages such as e-commerce and Cortex AI are optional and activate with a license key. Both Vercel and Supabase offer free tiers, so a starter site can run at no cost.</p>\n<h3>Do I need a Supabase account?</h3>\n<p>On Vercel, the database is created for you during the deploy. For the managed-cloud <code>npm create nextblock</code> path and the cloned repository you bring a free Supabase project. With Docker — whether through the CLI&rsquo;s Docker mode or <code>npm run docker:setup</code> in the clone — you need no cloud accounts at all.</p>\n<h3>Do I have to run migrations or SQL by hand?</h3>\n<p>No. The setup wizard, the Vercel build, and the Docker stack all apply the database schema automatically — and re-running is always safe.</p>\n<h3>Can I switch paths later?</h3>\n<p>Yes. Every path runs the same application and the same database schema, so you can prototype locally with Docker today and deploy to Vercel tomorrow. NextBlock deploys like any standard Next.js app.</p>\n<h3>How do I update NextBlock?</h3>\n<p>On Vercel, the Connect GitHub onboarding step enables a daily automatic sync with upstream (this needs your repository to be public). On a cloned repository, <code>git pull</code>, run <code>npm run db:migrate</code>, then restart (on production builds, pending migrations apply automatically). With Docker, pull the latest code and run <code>npm run docker:up</code>.</p>\n\n<div class='rounded-[2rem] border border-slate-200/80 bg-slate-50 p-8 my-12 text-center dark:border-white/10 dark:bg-white/5'>\n  <p class='mt-0 text-2xl font-semibold text-slate-900 dark:text-white'>Ready to launch?</p>\n  <p class='text-sm text-slate-600 dark:text-slate-300'>Pick your path above, or jump straight to the fastest one.</p>\n  <div class='mt-5 flex flex-wrap justify-center gap-3'>\n    <a href='https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fnextblock-cms%2Fnextblock&amp;project-name=nextblock&amp;repository-name=nextblock&amp;stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22supabase%22%2C%22productSlug%22%3A%22supabase%22%7D%5D' target='_blank' rel='noopener' class='inline-flex items-center rounded-full bg-slate-900 px-6 py-3 text-sm font-semibold text-white no-underline shadow-lg hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200'>Deploy on Vercel</a>\n    <a href='https://github.com/nextblock-cms/nextblock' target='_blank' rel='noopener' class='inline-flex items-center rounded-full border border-slate-300 px-6 py-3 text-sm font-semibold text-slate-700 no-underline hover:border-slate-500 dark:border-white/20 dark:text-slate-200 dark:hover:border-white/50'>View on GitHub</a>\n  </div>\n</div>"}
$nben$::jsonb,
       updated_at = now()
 WHERE post_id = 3
   AND block_type = 'text';

UPDATE public.blocks
   SET content = $nbfr$
{"html_content":"<p class='text-lg leading-8 text-slate-700 dark:text-slate-300'>NextBlock est un CMS open source et natif IA, construit sur Next.js et Supabase — et son installation ne passe plus par des fichiers de configuration, des assistants en ligne de commande ou du SQL manuel. Voici quatre façons de démarrer, <strong>classées de la plus simple à la plus technique</strong> : la première tient en un clic, la dernière donne le code source complet pour celles et ceux qui veulent participer à NextBlock. Elles aboutissent toutes au même endroit — un <strong>assistant de configuration</strong> dans le navigateur qui connecte votre base de données, configure le stockage des médias et crée votre compte administrateur.</p>\n\n<div class='mt-8 mb-6 flex items-center gap-4 text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400'>\n  <span class='flex-shrink-0'>Le plus simple</span>\n  <span class='h-1.5 flex-1 rounded-full bg-gradient-to-r from-blue-400 via-violet-400 to-emerald-400'></span>\n  <span class='flex-shrink-0'>Le plus de contrôle</span>\n</div>\n\n<div class='grid gap-5 md:grid-cols-2 my-6'>\n  <a href='#one-click-vercel' class='block rounded-[1.75rem] border border-blue-200 bg-blue-50/70 p-6 no-underline transition-shadow hover:shadow-lg dark:border-blue-500/20 dark:bg-blue-500/10'>\n    <div class='flex items-center justify-between mb-4'>\n      <span class='flex h-9 w-9 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white'>1</span>\n      <span class='inline-flex items-center gap-1'><span class='h-1.5 w-5 rounded-full bg-blue-500'></span><span class='h-1.5 w-5 rounded-full bg-slate-200 dark:bg-white/10'></span><span class='h-1.5 w-5 rounded-full bg-slate-200 dark:bg-white/10'></span><span class='h-1.5 w-5 rounded-full bg-slate-200 dark:bg-white/10'></span></span>\n    </div>\n    <p class='mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-blue-700 dark:text-blue-200'>Le plus simple &middot; un clic</p>\n    <h3 class='mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white'>Déployer sur Vercel</h3>\n    <p class='mb-0 text-sm leading-6 text-slate-600 dark:text-slate-300'>Un site de production en ligne avec une base de données gérée. Pas de terminal, aucun compte à configurer, rien à copier.</p>\n  </a>\n  <a href='#npm-docker' class='block rounded-[1.75rem] border border-amber-200 bg-amber-50/70 p-6 no-underline transition-shadow hover:shadow-lg dark:border-amber-500/20 dark:bg-amber-500/10'>\n    <div class='flex items-center justify-between mb-4'>\n      <span class='flex h-9 w-9 items-center justify-center rounded-full bg-amber-500 text-sm font-bold text-white'>2</span>\n      <span class='inline-flex items-center gap-1'><span class='h-1.5 w-5 rounded-full bg-amber-500'></span><span class='h-1.5 w-5 rounded-full bg-amber-500'></span><span class='h-1.5 w-5 rounded-full bg-slate-200 dark:bg-white/10'></span><span class='h-1.5 w-5 rounded-full bg-slate-200 dark:bg-white/10'></span></span>\n    </div>\n    <p class='mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-amber-700 dark:text-amber-200'>Facile &middot; 100 % local</p>\n    <h3 class='mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white'>npm create nextblock &rarr; Docker</h3>\n    <p class='mb-0 text-sm leading-6 text-slate-600 dark:text-slate-300'>Un seul prompt génère un projet et démarre toute la pile — base de données, auth, stockage, CMS — sur votre machine. Aucun compte cloud.</p>\n  </a>\n  <a href='#npm-cloud' class='block rounded-[1.75rem] border border-violet-200 bg-violet-50/70 p-6 no-underline transition-shadow hover:shadow-lg dark:border-violet-500/20 dark:bg-violet-500/10'>\n    <div class='flex items-center justify-between mb-4'>\n      <span class='flex h-9 w-9 items-center justify-center rounded-full bg-violet-600 text-sm font-bold text-white'>3</span>\n      <span class='inline-flex items-center gap-1'><span class='h-1.5 w-5 rounded-full bg-violet-500'></span><span class='h-1.5 w-5 rounded-full bg-violet-500'></span><span class='h-1.5 w-5 rounded-full bg-violet-500'></span><span class='h-1.5 w-5 rounded-full bg-slate-200 dark:bg-white/10'></span></span>\n    </div>\n    <p class='mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-violet-700 dark:text-violet-200'>Intermédiaire &middot; votre propre cloud</p>\n    <h3 class='mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white'>npm create nextblock &rarr; Supabase + R2</h3>\n    <p class='mb-0 text-sm leading-6 text-slate-600 dark:text-slate-300'>Générez une app autonome sur votre propre projet Supabase géré et Cloudflare R2, prête à déployer partout.</p>\n  </a>\n  <a href='#git-clone' class='block rounded-[1.75rem] border border-emerald-200 bg-emerald-50/70 p-6 no-underline transition-shadow hover:shadow-lg dark:border-emerald-500/20 dark:bg-emerald-500/10'>\n    <div class='flex items-center justify-between mb-4'>\n      <span class='flex h-9 w-9 items-center justify-center rounded-full bg-emerald-600 text-sm font-bold text-white'>4</span>\n      <span class='inline-flex items-center gap-1'><span class='h-1.5 w-5 rounded-full bg-emerald-500'></span><span class='h-1.5 w-5 rounded-full bg-emerald-500'></span><span class='h-1.5 w-5 rounded-full bg-emerald-500'></span><span class='h-1.5 w-5 rounded-full bg-emerald-500'></span></span>\n    </div>\n    <p class='mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200'>Avancé &middot; pour les contributeurs</p>\n    <h3 class='mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white'>Cloner le dépôt</h3>\n    <p class='mb-0 text-sm leading-6 text-slate-600 dark:text-slate-300'>Faites tourner le monorepo complet — le CMS, tous les packages et la documentation. Pour celles et ceux qui veulent aider à construire NextBlock (Docker fonctionne ici aussi).</p>\n  </a>\n</div>\n\n<p class='text-sm text-slate-500 dark:text-slate-400'>Vous ne savez pas par où commencer ? Descendez la liste — choisissez la première option dont vous avez déjà les prérequis. La plupart des gens devraient commencer par <a href='#one-click-vercel'>Vercel</a>.</p>\n\n<figure class='my-12 overflow-hidden rounded-[2rem] border border-slate-200/80 bg-slate-950 shadow-2xl dark:border-white/10'>\n  <img src='/images/included.webp' alt='Aperçu de la plateforme NextBlock : éditeur de blocs, tableau de bord CMS et intégrations incluses dans chaque installation' class='w-full h-auto object-cover' />\n  <figcaption class='border-t border-white/10 px-6 py-4 text-sm text-slate-300'>Quel que soit le chemin choisi, vous obtenez le même éditeur de blocs, le même CMS et le même schéma de base de données.</figcaption>\n</figure>\n\n<h2 id='one-click-vercel'>Option 1 : Déploiement Vercel en un clic</h2>\n<p class='mt-2 mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm'><span class='inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-blue-700 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-200'>Étape 1 &middot; Le plus simple</span><span class='text-slate-500 dark:text-slate-400'>Idéal pour un site en ligne avec le minimum d'effort — pas de terminal, aucun compte à configurer.</span></p>\n<p>Le moyen le plus rapide d'obtenir un site NextBlock en production. Un seul bouton crée votre propre copie de NextBlock sur GitHub, provisionne une base de données Supabase gérée et déploie le site — sans jamais ouvrir un terminal ni copier la moindre clé.</p>\n<ol class='space-y-2'>\n  <li><strong>Cliquez sur Deploy to Vercel</strong> et connectez-vous — Vercel clone NextBlock dans un nouveau dépôt qui vous appartient.</li>\n  <li><strong>Nommez le dépôt — et rendez-le Public.</strong> À la première étape sur Vercel, vous choisissez le nom du dépôt ; réglez sa visibilité sur <strong>Public</strong> plutôt que Privé. Un dépôt public est ce qui débloque les mises à jour automatiques en un clic plus tard — c'est donc le choix recommandé.</li>\n  <li><strong>Créez la base de données Supabase</strong> quand on vous le demande : choisissez un nom et une région. Vercel la connecte au projet et injecte les clés avant le premier build.</li>\n  <li><strong>Ouvrez votre nouveau site</strong> une fois le build terminé. Toute nouvelle instance vous amène directement à l'assistant de configuration.</li>\n  <li><strong>Créez votre compte administrateur.</strong> Il est confirmé instantanément — aucun email de vérification — et vous arrivez dans le tableau de bord du CMS.</li>\n</ol>\n<div class='my-8'>\n  <a href='https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fnextblock-cms%2Fnextblock&amp;project-name=nextblock&amp;repository-name=nextblock&amp;stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22supabase%22%2C%22productSlug%22%3A%22supabase%22%7D%5D' target='_blank' rel='noopener' class='inline-flex items-center rounded-full bg-slate-900 px-6 py-3 text-sm font-semibold text-white no-underline shadow-lg hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200'>Déployer sur Vercel &rarr;</a>\n</div>\n<div class='rounded-3xl border border-emerald-200 bg-emerald-50/80 p-6 my-8 dark:border-emerald-500/20 dark:bg-emerald-500/10'>\n  <p class='mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200'>Recommandé &middot; rendez le dépôt public</p>\n  <p class='mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200'>Quand Vercel vous demande de nommer le nouveau dépôt, choisissez <strong>Public</strong>. C'est gratuit, et c'est ce qui permet à l'étape <strong>Connect GitHub</strong> du tableau de bord d'installer un workflow quotidien qui garde votre site synchronisé avec la dernière version de NextBlock. Vous pourrez toujours passer un dépôt privé en public plus tard dans GitHub — mais démarrer en public est le chemin le plus simple vers les mises à jour automatiques.</p>\n</div>\n<div class='rounded-3xl border border-blue-200 bg-blue-50/80 p-6 my-8 dark:border-blue-500/20 dark:bg-blue-500/10'>\n  <p class='mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-blue-700 dark:text-blue-200'>Zéro configuration</p>\n  <p class='mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200'>Aucune variable d'environnement à remplir. Le stockage des médias utilise automatiquement votre projet Supabase connecté, les secrets de sécurité sont dérivés pour vous, et les migrations de base de données s'exécutent automatiquement à chaque build de production. Un domaine personnalisé plus tard ? Définissez <code>NEXT_PUBLIC_URL</code> dans votre projet Vercel et redéployez.</p>\n</div>\n\n<h2 id='npm-docker'>Option 2 : npm create nextblock &rarr; Docker (100 % local)</h2>\n<p class='mt-2 mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm'><span class='inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200'>Étape 2 &middot; Facile</span><span class='text-slate-500 dark:text-slate-400'>Idéal pour tout essayer sur votre machine sans aucun compte cloud. Nécessite Docker Desktop.</span></p>\n<p>Faites tourner NextBlock entièrement sur votre machine, sans aucun compte cloud. Le CLI génère une application Next.js autonome puis démarre toute la pile dans Docker pour vous : les moteurs Postgres et auth de Supabase, une API PostgREST derrière une passerelle Kong, un stockage MinIO compatible S3 et le CMS lui-même — idéal pour les évaluations, les environnements isolés et la pleine propriété de vos données.</p>\n<p>Avant de commencer, installez <a href='https://nodejs.org' target='_blank' rel='noopener'>Node.js 20 ou plus récent</a> (npm inclus) et <a href='https://www.docker.com/products/docker-desktop/' target='_blank' rel='noopener'>Docker Desktop</a>, et assurez-vous que Docker Desktop est démarré.</p>\n<pre><code>npm create nextblock@latest mon-site</code></pre>\n<ol class='space-y-2'>\n  <li><strong>Choisissez le profil d'hébergement.</strong> Au premier prompt, choisissez <em>Local Self-Hosted Docker Mode (One-Click Local Sandbox)</em>, puis confirmez que Docker Desktop est installé et démarré.</li>\n  <li><strong>Laissez faire.</strong> Le CLI copie le template, installe les dépendances, génère des clés sécurisées et démarre toute la pile avec une seule commande Docker — sans aucune question. Le premier lancement télécharge les images et construit l'app, comptez donc quelques minutes ; chaque migration de base de données est appliquée automatiquement au démarrage de la pile.</li>\n  <li><strong>Ouvrez <code>http://localhost:3000</code></strong> — vous êtes redirigé vers l'assistant de configuration. Comme la base de données et le stockage MinIO sont déjà connectés, les étapes de connexion et de stockage sont ignorées : il ne reste qu'à créer votre administrateur (confirmé instantanément, sans email). Vous arrivez dans le tableau de bord du CMS.</li>\n</ol>\n<div class='rounded-3xl border border-amber-200 bg-amber-50/80 p-6 my-8 dark:border-amber-500/20 dark:bg-amber-500/10'>\n  <p class='mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-amber-700 dark:text-amber-200'>Commandes du quotidien</p>\n  <pre class='mt-4 mb-0'><code># reconstruire et redémarrer la pile\nnpm run docker:up\n\n# arrêter la pile (vos données persistent dans les volumes Docker)\nnpm run docker:down\n\n# suivre les logs de l'application\nnpm run docker:logs</code></pre>\n  <p class='mt-4 mb-0 text-sm text-slate-700 dark:text-slate-200'>Le mode Docker n'est proposé que dans le prompt interactif — ne passez pas <code>--yes</code>, qui force le mode cloud géré ci-dessous.</p>\n</div>\n\n<h2 id='npm-cloud'>Option 3 : npm create nextblock &rarr; votre propre Supabase + Cloudflare</h2>\n<p class='mt-2 mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm'><span class='inline-flex items-center gap-2 rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-violet-700 dark:border-violet-500/20 dark:bg-violet-500/10 dark:text-violet-200'>Étape 3 &middot; Intermédiaire</span><span class='text-slate-500 dark:text-slate-400'>Idéal pour construire votre propre site sur du cloud géré. Nécessite un projet Supabase et un bucket R2.</span></p>\n<p>Le meilleur point de départ pour construire votre propre site sur du cloud géré. Le CLI génère une application Next.js autonome avec NextBlock déjà intégré — sans monorepo ni outillage de workspace — reliée à un projet Supabase et un bucket Cloudflare R2 que vous contrôlez, et elle se déploie partout où Next.js tourne.</p>\n<p>Avant de commencer, installez <a href='https://nodejs.org' target='_blank' rel='noopener'>Node.js 20 ou plus récent</a>, créez un projet gratuit sur <a href='https://supabase.com' target='_blank' rel='noopener'>supabase.com</a>, et configurez un bucket <a href='https://developers.cloudflare.com/r2/' target='_blank' rel='noopener'>Cloudflare R2</a> pour vos images et fichiers.</p>\n<pre><code>npm create nextblock@latest mon-site\ncd mon-site\nnpm run dev</code></pre>\n<p>Au premier prompt, choisissez <em>Managed Cloud Mode (Vercel + Supabase Cloud)</em> et nommez votre projet. Ouvrez ensuite <code>http://localhost:3000/setup</code> et laissez l'assistant faire le travail :</p>\n<ol class='space-y-2'>\n  <li><strong>Connectez Supabase</strong> — collez l'URL du projet, la clé publiable (anon), la clé secrète (service role) et un jeton d'accès personnel pour que l'assistant applique le schéma de base de données à votre place.</li>\n  <li><strong>Ajoutez Cloudflare R2</strong> — saisissez votre identifiant de compte R2, le nom du bucket, la clé d'accès (access key ID), la clé secrète et l'URL publique du bucket pour servir vos images et fichiers.</li>\n  <li><strong>Créez votre administrateur</strong> — l'assistant applique toutes les migrations, génère les secrets de l'application, écrit <code>.env.local</code>, crée votre compte admin confirmé et vous connecte. Redémarrez ensuite <code>npm run dev</code> une fois pour que le nouvel environnement soit intégré à l'application.</li>\n</ol>\n<div class='rounded-3xl border border-violet-200 bg-violet-50/80 p-6 my-8 dark:border-violet-500/20 dark:bg-violet-500/10'>\n  <p class='mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-violet-700 dark:text-violet-200'>Modules premium</p>\n  <p class='mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200'>Besoin d'une boutique ? Une seule commande ajoute produits, paiement, commandes et coupons — activés par clé de licence, prêts quand vous l'êtes : <code>npx create-nextblock activate ecommerce</code></p>\n</div>\n\n<h2 id='git-clone'>Option 4 : Cloner le dépôt</h2>\n<p class='mt-2 mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm'><span class='inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200'>Étape 4 &middot; Avancé</span><span class='text-slate-500 dark:text-slate-400'>Idéal pour les contributeurs et les équipes qui veulent personnaliser la plateforme. Nécessite Node.js et git.</span></p>\n<p>Faites tourner le monorepo Nx complet : l'application CMS, tous les packages partagés, le code du CLI et la documentation. C'est le chemin de celles et ceux qui veulent participer au projet — contributeurs, auteurs de plugins et équipes qui personnalisent la plateforme elle-même.</p>\n<pre><code>git clone https://github.com/nextblock-cms/nextblock.git\ncd nextblock\nnpm install\nnpx nx serve nextblock</code></pre>\n<p>Ouvrez <code>http://localhost:4200</code> — une nouvelle installation redirige chaque page vers <code>/setup</code>, où le même assistant en trois étapes connecte Supabase, configure le stockage et crée votre admin. Il valide vos clés, écrit <code>.env.local</code> avec des secrets générés, et applique toutes les migrations via l'API de management Supabase — sans CLI Supabase.</p>\n<div class='rounded-3xl border border-emerald-200 bg-emerald-50/80 p-6 my-8 dark:border-emerald-500/20 dark:bg-emerald-500/10'>\n  <p class='mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200'>Vous préférez rester local ? Docker fonctionne ici aussi</p>\n  <p class='mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200'>Pas besoin de comptes cloud pour développer sur le monorepo. Avec Docker Desktop démarré, une seule commande lance la même pile auto-hébergée que l'option 2 — Postgres, auth, stockage et le CMS — directement depuis votre clone :</p>\n  <pre class='mt-4 mb-0'><code>npm run docker:setup</code></pre>\n  <p class='mt-4 mb-0 text-sm text-slate-700 dark:text-slate-200'>Quand c'est terminé, ouvrez <code>http://localhost:3000</code> et créez votre administrateur. Notez que le monorepo n'a pas de <code>npm run dev</code> — utilisez <code>npx nx serve nextblock</code> (port 4200) pour le chemin cloud.</p>\n</div>\n\n<h2 id='after-install'>Après l'installation : vos 10 premières minutes</h2>\n<p>Chaque chemin vous dépose sur <code>/cms/dashboard</code>, connecté en tant que premier administrateur. Une checklist de démarrage intégrée vous guide pour la suite :</p>\n<ul class='space-y-2'>\n  <li><strong>Ajoutez votre identité visuelle</strong> — téléversez votre logo et définissez le titre du site.</li>\n  <li><strong>Réglez votre pied de page</strong> — mention de copyright et navigation du pied de page.</li>\n  <li><strong>Configurez l'email (SMTP)</strong> — dans les réglages, pour que les réinitialisations de mot de passe et les invitations partent bien.</li>\n  <li><strong>Extras optionnels</strong> — connectez vos outils d'analytics, activez la protection anti-bots et (sur Vercel) les mises à jour automatiques.</li>\n</ul>\n<p>Ensuite, découvrez comment la plateforme s'articule dans <a href='/article/comment-nextblock-fonctionne'>Comment NextBlock fonctionne</a>, ou ajoutez une boutique avec le <a href='/article/guide-commerce-nextblock'>guide Commerce</a>.</p>\n\n<h2 id='faq'>FAQ d'installation</h2>\n<h3>Que dois-je installer ?</h3>\n<p>Rien pour le chemin Vercel — tout se passe dans le navigateur. Pour <code>npm create nextblock</code> en mode Docker : <a href='https://nodejs.org' target='_blank' rel='noopener'>Node.js 20+</a> et Docker Desktop. Pour le mode cloud géré : Node.js 20+ ainsi qu'un projet Supabase et un bucket Cloudflare R2. Pour le dépôt cloné : Node.js 20+ et git (ajoutez Docker Desktop si vous voulez faire tourner la pile locale).</p>\n<h3>NextBlock est-il gratuit ?</h3>\n<p>Oui — le cœur du CMS est 100 % gratuit et open source (AGPL). Les packages premium comme l'e-commerce et Cortex AI sont optionnels et s'activent avec une clé de licence. Vercel et Supabase proposent chacun une offre gratuite : un site de départ peut donc tourner sans frais.</p>\n<h3>Ai-je besoin d'un compte Supabase ?</h3>\n<p>Sur Vercel, la base de données est créée pour vous pendant le déploiement. Pour le chemin cloud géré <code>npm create nextblock</code> et le dépôt cloné, il vous faut un projet Supabase gratuit. Avec Docker — via le mode Docker du CLI ou <code>npm run docker:setup</code> dans le clone — aucun compte cloud n'est nécessaire.</p>\n<h3>Dois-je exécuter des migrations ou du SQL à la main ?</h3>\n<p>Non. L'assistant de configuration, le build Vercel et la pile Docker appliquent tous le schéma de base de données automatiquement — et relancer l'opération est toujours sans risque.</p>\n<h3>Puis-je changer de chemin plus tard ?</h3>\n<p>Oui. Chaque chemin exécute la même application et le même schéma de base de données : vous pouvez prototyper en local avec Docker aujourd'hui et déployer sur Vercel demain. NextBlock se déploie comme n'importe quelle app Next.js.</p>\n<h3>Comment mettre à jour NextBlock ?</h3>\n<p>Sur Vercel, l'étape Connect GitHub de la checklist active une synchronisation quotidienne automatique (cela nécessite un dépôt public). Sur un dépôt cloné, <code>git pull</code>, lancez <code>npm run db:migrate</code>, puis redémarrez (lors des builds de production, les migrations en attente s'appliquent automatiquement). Avec Docker, récupérez le dernier code et lancez <code>npm run docker:up</code>.</p>\n\n<div class='rounded-[2rem] border border-slate-200/80 bg-slate-50 p-8 my-12 text-center dark:border-white/10 dark:bg-white/5'>\n  <p class='mt-0 text-2xl font-semibold text-slate-900 dark:text-white'>Prêt à vous lancer ?</p>\n  <p class='text-sm text-slate-600 dark:text-slate-300'>Choisissez votre chemin ci-dessus, ou passez directement au plus rapide.</p>\n  <div class='mt-5 flex flex-wrap justify-center gap-3'>\n    <a href='https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fnextblock-cms%2Fnextblock&amp;project-name=nextblock&amp;repository-name=nextblock&amp;stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22supabase%22%2C%22productSlug%22%3A%22supabase%22%7D%5D' target='_blank' rel='noopener' class='inline-flex items-center rounded-full bg-slate-900 px-6 py-3 text-sm font-semibold text-white no-underline shadow-lg hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200'>Déployer sur Vercel</a>\n    <a href='https://github.com/nextblock-cms/nextblock' target='_blank' rel='noopener' class='inline-flex items-center rounded-full border border-slate-300 px-6 py-3 text-sm font-semibold text-slate-700 no-underline hover:border-slate-500 dark:border-white/20 dark:text-slate-200 dark:hover:border-white/50'>Voir sur GitHub</a>\n  </div>\n</div>"}
$nbfr$::jsonb,
       updated_at = now()
 WHERE post_id = 4
   AND block_type = 'text';
$nb_file_00000000000008$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000008_setup_article_reorder.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000008_setup_article_reorder.sql

  -- >>> FROM: 00000000000009_home_live_demo_promo_contrast.sql
  IF NOT pg_temp.nb_recorded('00000000000009', '00000000000009_home_live_demo_promo_contrast') THEN
    RAISE NOTICE 'catch-up: applying 00000000000009_home_live_demo_promo_contrast.sql';
    EXECUTE $nb_file_00000000000009$
-- 00000000000009_home_live_demo_promo_contrast.sql
-- Restyles the "Live Demo" promo that migrations 006/007 seeded on the EN (slug 'home')
-- and FR (slug 'accueil') home pages. 006/007 gave it a fixed dark-navy GRADIENT section
-- background -- and a gradient background is an inline style, so it renders identically
-- in light and dark theme. Sitting directly under the (also dark) hero, that made the
-- first two sections both dark in light mode and killed the old dark-hero -> white-second
-- contrast rhythm.
--
-- Fix (append-only, do NOT edit 006/007 -- both already applied to prod + sandbox):
-- switch the section background to "none" (transparent -> inherits the theme-aware page
-- background: light in light theme, dark in dark theme) and render the promo as a single
-- self-contained ELEVATED PANEL. The panel is a soft light card in light theme and keeps
-- the rich navy look in dark theme (dark: gradient), with the browser mockup deliberately
-- kept dark in both themes as a "product screenshot" focal point. The <!--nb-sandbox-promo-->
-- sentinel is preserved so the reset-sandbox route still strips it on cms.nextblock.dev.
--
-- Idempotent: re-running sets identical content. Targets exactly the promo blocks via the
-- nb-sandbox-promo sentinel, scoped by language (mirrors 00000000000007). blocks.content is
-- JSONB, written with dollar-quoting.
--
-- NOTE: keep the word "sandbox" OUT of this filename -- generate-sandbox-reset.ts excludes
-- any migration whose filename contains "sandbox" from the sandbox reset bundle.

DO $body$
DECLARE
  v_en_lang integer;
  v_fr_lang integer;
BEGIN
  SELECT id INTO v_en_lang FROM public.languages WHERE code = 'en' LIMIT 1;
  SELECT id INTO v_fr_lang FROM public.languages WHERE code = 'fr' LIMIT 1;

  UPDATE public.blocks
     SET content = $en$
{"container_type":"container","background":{"type":"none"},"responsive_columns":{"mobile":1,"tablet":1,"desktop":1},"column_gap":"xl","vertical_alignment":"center","padding":{"top":"xl","bottom":"xl"},"column_blocks":[[{"block_type":"text","content":{"html_content":"<!--nb-sandbox-promo--><div class='relative overflow-hidden rounded-[2.5rem] border border-slate-200 bg-gradient-to-br from-white via-slate-50 to-blue-50 shadow-2xl shadow-slate-900/10 dark:border-white/10 dark:from-slate-900 dark:via-slate-900 dark:to-blue-950 dark:shadow-black/40'><div class='grid gap-10 p-8 sm:p-12 lg:grid-cols-2 lg:items-center'><div><p class='text-xs uppercase tracking-[0.25em] text-cyan-600 dark:text-cyan-400 font-bold mb-4'>Live Demo &middot; No Signup</p><h2 class='text-4xl md:text-5xl font-bold text-slate-900 dark:text-white mb-6 leading-tight'>Try the full CMS,<br/>live right now.</h2><p class='text-lg text-slate-600 dark:text-slate-300 max-w-xl leading-relaxed mb-8'>Don't just read about NextBlock&trade; &mdash; take the wheel. Our public sandbox is a complete, pre-loaded install where you can build pages with the block editor, manage bilingual content, and browse a working demo store. It resets daily, so explore freely and break whatever you like.</p><div class='flex flex-col sm:flex-row gap-4'><a href='https://cms.nextblock.dev' target='_blank' rel='noopener noreferrer' class='inline-flex items-center justify-center gap-2 rounded-xl px-7 h-12 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 shadow-lg shadow-blue-500/25 transition-all no-underline'>Explore the Live Demo &rarr;</a><a href='https://cms.nextblock.dev/sign-in' target='_blank' rel='noopener noreferrer' class='inline-flex items-center justify-center gap-2 rounded-xl px-7 h-12 text-sm font-semibold text-slate-700 dark:text-white border border-slate-300 dark:border-white/20 hover:bg-slate-100 dark:hover:bg-white/10 transition-all no-underline'>Open the CMS Dashboard &rarr;</a></div><p class='text-xs text-slate-500 dark:text-slate-400 mt-4'>Demo login <span class='font-mono text-slate-700 dark:text-slate-300'>demo@nextblock.dev</span> / <span class='font-mono text-slate-700 dark:text-slate-300'>password</span> &middot; Resets daily</p></div><div class='rounded-3xl overflow-hidden border border-slate-800 bg-slate-900 shadow-xl shadow-slate-900/20 dark:border-white/10 dark:bg-white/5 dark:backdrop-blur-xl'><div class='flex items-center gap-2 px-4 py-3 border-b border-white/10 bg-white/5'><span class='w-3 h-3 rounded-full bg-red-400/70'></span><span class='w-3 h-3 rounded-full bg-yellow-400/70'></span><span class='w-3 h-3 rounded-full bg-green-400/70'></span><span class='ml-3 flex-1 truncate rounded-md bg-black/30 px-3 py-1 text-xs font-mono text-slate-300'>cms.nextblock.dev</span></div><div class='p-6 sm:p-8'><p class='text-sm text-slate-300 mb-5'>A living NextBlock&trade; install &mdash; everything here is real and clickable:</p><ul class='space-y-4 text-sm text-slate-200'><li class='flex items-start gap-3'><span class='mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-cyan-500/15 text-cyan-300 text-xs'>&#10003;</span><span><strong class='text-white'>Full block editor</strong> with slash commands &amp; drag-and-drop.</span></li><li class='flex items-start gap-3'><span class='mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-cyan-500/15 text-cyan-300 text-xs'>&#10003;</span><span><strong class='text-white'>Bilingual</strong> English / French content management.</span></li><li class='flex items-start gap-3'><span class='mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-cyan-500/15 text-cyan-300 text-xs'>&#10003;</span><span><strong class='text-white'>A complete demo storefront</strong> with a full checkout flow.</span></li><li class='flex items-start gap-3'><span class='mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-cyan-500/15 text-cyan-300 text-xs'>&#10003;</span><span><strong class='text-white'>Wipes clean daily</strong> &mdash; always a fresh start.</span></li></ul></div></div></div></div>"}}]]}
$en$::jsonb,
         updated_at = now()
   WHERE block_type = 'section'
     AND page_id IS NOT NULL
     AND language_id = v_en_lang
     AND content::text LIKE '%nb-sandbox-promo%';

  UPDATE public.blocks
     SET content = $fr$
{"container_type":"container","background":{"type":"none"},"responsive_columns":{"mobile":1,"tablet":1,"desktop":1},"column_gap":"xl","vertical_alignment":"center","padding":{"top":"xl","bottom":"xl"},"column_blocks":[[{"block_type":"text","content":{"html_content":"<!--nb-sandbox-promo--><div class='relative overflow-hidden rounded-[2.5rem] border border-slate-200 bg-gradient-to-br from-white via-slate-50 to-blue-50 shadow-2xl shadow-slate-900/10 dark:border-white/10 dark:from-slate-900 dark:via-slate-900 dark:to-blue-950 dark:shadow-black/40'><div class='grid gap-10 p-8 sm:p-12 lg:grid-cols-2 lg:items-center'><div><p class='text-xs uppercase tracking-[0.25em] text-cyan-600 dark:text-cyan-400 font-bold mb-4'>D&eacute;mo en direct &middot; Sans inscription</p><h2 class='text-4xl md:text-5xl font-bold text-slate-900 dark:text-white mb-6 leading-tight'>Essayez le CMS complet,<br/>en direct d&egrave;s maintenant.</h2><p class='text-lg text-slate-600 dark:text-slate-300 max-w-xl leading-relaxed mb-8'>Ne vous contentez pas de lire des articles sur NextBlock&trade; &mdash; prenez les commandes. Notre bac &agrave; sable public est une installation compl&egrave;te et pr&eacute;charg&eacute;e o&ugrave; vous pouvez cr&eacute;er des pages avec l'&eacute;diteur de blocs, g&eacute;rer du contenu bilingue et parcourir une vraie boutique de d&eacute;monstration. Il se r&eacute;initialise chaque jour : explorez librement et cassez tout ce que vous voulez.</p><div class='flex flex-col sm:flex-row gap-4'><a href='https://cms.nextblock.dev' target='_blank' rel='noopener noreferrer' class='inline-flex items-center justify-center gap-2 rounded-xl px-7 h-12 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 shadow-lg shadow-blue-500/25 transition-all no-underline'>D&eacute;couvrir la d&eacute;mo &rarr;</a><a href='https://cms.nextblock.dev/sign-in' target='_blank' rel='noopener noreferrer' class='inline-flex items-center justify-center gap-2 rounded-xl px-7 h-12 text-sm font-semibold text-slate-700 dark:text-white border border-slate-300 dark:border-white/20 hover:bg-slate-100 dark:hover:bg-white/10 transition-all no-underline'>Ouvrir le tableau de bord &rarr;</a></div><p class='text-xs text-slate-500 dark:text-slate-400 mt-4'>Identifiants d&eacute;mo <span class='font-mono text-slate-700 dark:text-slate-300'>demo@nextblock.dev</span> / <span class='font-mono text-slate-700 dark:text-slate-300'>password</span> &middot; R&eacute;initialis&eacute; chaque jour</p></div><div class='rounded-3xl overflow-hidden border border-slate-800 bg-slate-900 shadow-xl shadow-slate-900/20 dark:border-white/10 dark:bg-white/5 dark:backdrop-blur-xl'><div class='flex items-center gap-2 px-4 py-3 border-b border-white/10 bg-white/5'><span class='w-3 h-3 rounded-full bg-red-400/70'></span><span class='w-3 h-3 rounded-full bg-yellow-400/70'></span><span class='w-3 h-3 rounded-full bg-green-400/70'></span><span class='ml-3 flex-1 truncate rounded-md bg-black/30 px-3 py-1 text-xs font-mono text-slate-300'>cms.nextblock.dev</span></div><div class='p-6 sm:p-8'><p class='text-sm text-slate-300 mb-5'>Une installation NextBlock&trade; bien vivante &mdash; tout ici est r&eacute;el et cliquable :</p><ul class='space-y-4 text-sm text-slate-200'><li class='flex items-start gap-3'><span class='mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-cyan-500/15 text-cyan-300 text-xs'>&#10003;</span><span><strong class='text-white'>&Eacute;diteur de blocs complet</strong> : commandes slash et glisser-d&eacute;poser.</span></li><li class='flex items-start gap-3'><span class='mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-cyan-500/15 text-cyan-300 text-xs'>&#10003;</span><span><strong class='text-white'>Gestion bilingue</strong> du contenu fran&ccedil;ais / anglais.</span></li><li class='flex items-start gap-3'><span class='mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-cyan-500/15 text-cyan-300 text-xs'>&#10003;</span><span><strong class='text-white'>Une boutique de d&eacute;monstration compl&egrave;te</strong> avec un parcours de paiement complet.</span></li><li class='flex items-start gap-3'><span class='mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-cyan-500/15 text-cyan-300 text-xs'>&#10003;</span><span><strong class='text-white'>Remis &agrave; z&eacute;ro chaque jour</strong> &mdash; toujours un nouveau d&eacute;part.</span></li></ul></div></div></div></div>"}}]]}
$fr$::jsonb,
         updated_at = now()
   WHERE block_type = 'section'
     AND page_id IS NOT NULL
     AND language_id = v_fr_lang
     AND content::text LIKE '%nb-sandbox-promo%';
END
$body$;
$nb_file_00000000000009$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000009_home_live_demo_promo_contrast.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000009_home_live_demo_promo_contrast.sql

  -- >>> FROM: 00000000000010_drop_github_username.sql
  IF NOT pg_temp.nb_recorded('00000000000010', '00000000000010_drop_github_username') THEN
    RAISE NOTICE 'catch-up: applying 00000000000010_drop_github_username.sql';
    EXECUTE $nb_file_00000000000010$
-- Drop the github_username profile column and remove the GitHub-auth artifacts.
--
-- GitHub OAuth sign-in / account-linking was removed from the app: it cannot be
-- provisioned as part of a one-click deployment (each install needs its own GitHub
-- OAuth app + client secret + Supabase's manual-linking toggle, none of which can
-- ship in a migration). github_username was only ever populated from that OAuth
-- flow, so the column and its seed strings are now dead.
--
-- NOTE: the self-update "Connect GitHub" flow (lib/updates/*, ConnectGitHubButton)
-- is a separate feature and is intentionally left untouched — the connect_github
-- translation is kept for it.

-- 1. Rewrite handle_new_user() so new signups no longer read/populate github_username.
CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  admin_flag_set boolean := false;
  user_role public.user_role;
  v_full_name text;
  v_avatar_url text;
BEGIN
  INSERT INTO public.site_settings (key, value)
  VALUES ('is_admin_created', 'false'::jsonb)
  ON CONFLICT (key) DO NOTHING;

  SELECT COALESCE(value::jsonb::boolean, false)
    INTO admin_flag_set
  FROM public.site_settings
  WHERE key = 'is_admin_created'
  FOR UPDATE;

  IF admin_flag_set = false THEN
    user_role := 'ADMIN'::public.user_role;

    UPDATE public.site_settings
    SET value = 'true'::jsonb
    WHERE key = 'is_admin_created';
  ELSE
    user_role := 'USER'::public.user_role;
  END IF;

  v_full_name := NEW.raw_user_meta_data->>'full_name';
  v_avatar_url := NEW.raw_user_meta_data->>'avatar_url';

  INSERT INTO public.profiles (
    id,
    role,
    full_name,
    avatar_url
  )
  VALUES (
    NEW.id,
    user_role,
    v_full_name,
    v_avatar_url
  )
  ON CONFLICT (id) DO UPDATE SET
    full_name = EXCLUDED.full_name,
    avatar_url = EXCLUDED.avatar_url;

  RETURN NEW;
END;
$$;

-- 2. Drop the column now that nothing writes it.
ALTER TABLE public.profiles DROP COLUMN IF EXISTS github_username;

-- 3. Remove the GitHub-auth-only translation strings. connect_github is intentionally
--    kept — it is still used by the self-update "Connect GitHub" button.
DELETE FROM public.translations
WHERE key IN (
  'continue_with_github',
  'github_username',
  'github_username_help',
  'github_link_failed',
  'github_connected'
);
$nb_file_00000000000010$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000010_drop_github_username.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000010_drop_github_username.sql

  -- >>> FROM: 00000000000011_language_detection_admin_only.sql
  IF NOT pg_temp.nb_recorded('00000000000011', '00000000000011_language_detection_admin_only') THEN
    RAISE NOTICE 'catch-up: applying 00000000000011_language_detection_admin_only.sql';
    EXECUTE $nb_file_00000000000011$
-- Restrict writes to the language-detection settings row to ADMIN only.
--
-- `site_settings.language_detection_settings` is a non-sensitive, anon-READABLE
-- key (the request proxy reads it with the anon client to pick a visitor's first
-- language). The CMS surfaces it under /cms/settings (ADMIN-only) and the server
-- action guards with an ADMIN check, but the baseline write policies let ADMIN
-- *or* WRITER write any non-sensitive key — so a WRITER could change site-wide
-- detection directly via PostgREST. This migration adds the key to the ADMIN-only
-- write group (INSERT/UPDATE/DELETE) to match the UI boundary, while leaving the
-- SELECT policy untouched so the proxy's anon read keeps working.
--
-- Forward-only; recreates the three write policies idempotently.

DROP POLICY IF EXISTS site_settings_insert_policy ON public.site_settings;
CREATE POLICY site_settings_insert_policy ON public.site_settings FOR INSERT TO authenticated WITH CHECK ((((key <> ALL (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role]))) OR ((key = ANY (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role))));

DROP POLICY IF EXISTS site_settings_update_policy ON public.site_settings;
CREATE POLICY site_settings_update_policy ON public.site_settings FOR UPDATE TO authenticated USING ((((key <> ALL (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role]))) OR ((key = ANY (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role)))) WITH CHECK ((((key <> ALL (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role]))) OR ((key = ANY (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role))));

DROP POLICY IF EXISTS site_settings_delete_policy ON public.site_settings;
CREATE POLICY site_settings_delete_policy ON public.site_settings FOR DELETE TO authenticated USING ((((key <> ALL (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role]))) OR ((key = ANY (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role))));
$nb_file_00000000000011$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000011_language_detection_admin_only.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000011_language_detection_admin_only.sql

  -- >>> FROM: 00000000000012_cortex_ai_stock_photo_settings.sql
  IF NOT pg_temp.nb_recorded('00000000000012', '00000000000012_cortex_ai_stock_photo_settings') THEN
    RAISE NOTICE 'catch-up: applying 00000000000012_cortex_ai_stock_photo_settings.sql';
    EXECUTE $nb_file_00000000000012$
-- Protect the Cortex AI stock-photo provider API keys stored in site_settings.
--
-- The stock-photo search tool (search_stock_photos) can read a Pexels or Unsplash
-- API key from site_settings so the key lives in the database instead of an env var.
-- Those two rows are SECRETS and must never be publicly readable: like the OpenRouter
-- BYOK key, they belong in the sensitive-keys group that only authenticated ADMINs can
-- read or write. The baseline site_settings SELECT policy makes any key NOT in that
-- group anon-readable, so we add the two stock-photo keys to every policy's sensitive
-- array. The value stored is an encrypted envelope, but we protect the row regardless.
--
-- Forward-only; recreates all four site_settings policies idempotently, preserving the
-- existing sensitive keys (including language_detection_settings on the write policies,
-- which stays anon-READABLE and is therefore not added to the SELECT policy).

DROP POLICY IF EXISTS site_settings_read_policy ON public.site_settings;
CREATE POLICY site_settings_read_policy ON public.site_settings FOR SELECT USING (((key <> ALL (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text])) OR ((key = ANY (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text])) AND (( SELECT auth.role() AS role) = 'authenticated'::text) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role))));

DROP POLICY IF EXISTS site_settings_insert_policy ON public.site_settings;
CREATE POLICY site_settings_insert_policy ON public.site_settings FOR INSERT TO authenticated WITH CHECK ((((key <> ALL (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role]))) OR ((key = ANY (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role))));

DROP POLICY IF EXISTS site_settings_update_policy ON public.site_settings;
CREATE POLICY site_settings_update_policy ON public.site_settings FOR UPDATE TO authenticated USING ((((key <> ALL (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role]))) OR ((key = ANY (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role)))) WITH CHECK ((((key <> ALL (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role]))) OR ((key = ANY (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role))));

DROP POLICY IF EXISTS site_settings_delete_policy ON public.site_settings;
CREATE POLICY site_settings_delete_policy ON public.site_settings FOR DELETE TO authenticated USING ((((key <> ALL (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role]))) OR ((key = ANY (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role))));
$nb_file_00000000000012$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000012_cortex_ai_stock_photo_settings.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000012_cortex_ai_stock_photo_settings.sql

  -- >>> FROM: 00000000000013_youtube_nocookie_embeds.sql
  IF NOT pg_temp.nb_recorded('00000000000013', '00000000000013_youtube_nocookie_embeds') THEN
    RAISE NOTICE 'catch-up: applying 00000000000013_youtube_nocookie_embeds.sql';
    EXECUTE $nb_file_00000000000013$
-- 00000000000013_youtube_nocookie_embeds.sql
--
-- Lighthouse Best Practices scored 96 instead of 100: the `inspector-issues` audit
-- (binary, weight 1 of 27 -> 26/27 = 96) failed with a DevTools "Cookie" issue
-- attributed to www.youtube.com/embed/71MyfoL4YVM. The seeded home-page hero and the
-- seeded articles embed raw <iframe> markup pointing at www.youtube.com, whose player
-- writes cookies on load.
--
-- The real fix is the render-time click-to-play facade added in
-- apps/nextblock/components/media/YouTubeFacade.tsx (the nocookie host does NOT stop
-- the player's document.cookie writes -- only not loading the player does). This
-- migration is the data-hygiene half: it rewrites every stored embed to the
-- privacy-enhanced host so any surface that still renders a raw iframe (published-lib
-- renderers, CMS previews, exports, downstream installs on an older app build) is at
-- least cookie-reduced, and so the stored content matches what we ship.
--
-- It also fixes the bogus Permissions Policy feature in the seeded allow attribute:
-- 'accelerated-motion' is not a real feature (Chrome logs "Unrecognized feature");
-- the canonical YouTube embed uses 'accelerometer'.
--
-- Append-only: 00000000000003_baseline_seed.sql is applied everywhere and is NOT edited.
-- Scoped by CONTENT MATCH, never by block id -- ids drift on installs where the demo
-- content was re-created (see the convention documented in 00000000000006:11-13 and
-- used by 007/009). This is a pure host-substring swap, so it never clobbers a user's
-- edited copy, it also repairs author-pasted embeds, and it is naturally idempotent
-- (a second run matches zero rows) which matters because the nightly sandbox reset
-- replays the whole migration chain from a truncated history.
--
-- No dollar-quoting is needed here: neither search nor replacement literal contains a
-- single quote, and neither contains a JSON metacharacter, so the ::text round-trip
-- always re-parses as valid JSON. Query strings (?si=...) are preserved.
--
-- NOTE: keep the word "sandbox" OUT of this filename -- generate-sandbox-reset.ts
-- excludes any migration whose filename contains "sandbox".

-- 1. Live page/post block content (the 4 seeded rows + any author-added embed).
UPDATE public.blocks
   SET content = replace(
         replace(content::text, 'www.youtube.com/embed/', 'www.youtube-nocookie.com/embed/'),
         'accelerated-motion', 'accelerometer'
       )::jsonb
 WHERE content IS NOT NULL
   AND (content::text LIKE '%www.youtube.com/embed/%'
        OR content::text LIKE '%accelerated-motion%');

-- 2. Live Draft Mode snapshots. Publishing a pre-existing draft would otherwise write
--    the cookie host straight back into public.blocks.
UPDATE public.content_drafts
   SET blocks = replace(
         replace(blocks::text, 'www.youtube.com/embed/', 'www.youtube-nocookie.com/embed/'),
         'accelerated-motion', 'accelerometer'
       )::jsonb
 WHERE blocks::text LIKE '%www.youtube.com/embed/%'
    OR blocks::text LIKE '%accelerated-motion%';

UPDATE public.content_drafts
   SET meta = replace(
         replace(meta::text, 'www.youtube.com/embed/', 'www.youtube-nocookie.com/embed/'),
         'accelerated-motion', 'accelerometer'
       )::jsonb
 WHERE meta::text LIKE '%www.youtube.com/embed/%'
    OR meta::text LIKE '%accelerated-motion%';

UPDATE public.product_drafts
   SET blocks = replace(
         replace(blocks::text, 'www.youtube.com/embed/', 'www.youtube-nocookie.com/embed/'),
         'accelerated-motion', 'accelerometer'
       )::jsonb
 WHERE blocks::text LIKE '%www.youtube.com/embed/%'
    OR blocks::text LIKE '%accelerated-motion%';

-- product_drafts.meta carries short_description / description_json.
UPDATE public.product_drafts
   SET meta = replace(
         replace(meta::text, 'www.youtube.com/embed/', 'www.youtube-nocookie.com/embed/'),
         'accelerated-motion', 'accelerometer'
       )::jsonb
 WHERE meta::text LIKE '%www.youtube.com/embed/%'
    OR meta::text LIKE '%accelerated-motion%';

-- 3. Revision history. apps/nextblock/app/cms/revisions/service.ts replays a snapshot
--    verbatim, so one "Restore version" click would otherwise reintroduce the issue.
--    URL-only rewrite; nothing else about the historical snapshot is touched.
UPDATE public.page_revisions
   SET content = replace(
         replace(content::text, 'www.youtube.com/embed/', 'www.youtube-nocookie.com/embed/'),
         'accelerated-motion', 'accelerometer'
       )::jsonb
 WHERE content::text LIKE '%www.youtube.com/embed/%'
    OR content::text LIKE '%accelerated-motion%';

UPDATE public.post_revisions
   SET content = replace(
         replace(content::text, 'www.youtube.com/embed/', 'www.youtube-nocookie.com/embed/'),
         'accelerated-motion', 'accelerometer'
       )::jsonb
 WHERE content::text LIKE '%www.youtube.com/embed/%'
    OR content::text LIKE '%accelerated-motion%';

-- 4. Product rich text rendered on public /product/* routes.
UPDATE public.products
   SET short_description = replace(
         replace(short_description, 'www.youtube.com/embed/', 'www.youtube-nocookie.com/embed/'),
         'accelerated-motion', 'accelerometer'
       )
 WHERE short_description IS NOT NULL
   AND (short_description LIKE '%www.youtube.com/embed/%'
        OR short_description LIKE '%accelerated-motion%');

UPDATE public.products
   SET description_json = replace(
         replace(description_json::text, 'www.youtube.com/embed/', 'www.youtube-nocookie.com/embed/'),
         'accelerated-motion', 'accelerometer'
       )::jsonb
 WHERE description_json IS NOT NULL
   AND (description_json::text LIKE '%www.youtube.com/embed/%'
        OR description_json::text LIKE '%accelerated-motion%');

-- 5. Custom block definitions (rich-text defaults / emptyFallback markup rendered by
--    DynamicLayoutEngine). Host-only swap, so the is_valid_custom_block_* CHECK
--    constraints still hold. No-op on a fresh install.
UPDATE public.custom_block_definitions
   SET fields = replace(
         replace(fields::text, 'www.youtube.com/embed/', 'www.youtube-nocookie.com/embed/'),
         'accelerated-motion', 'accelerometer'
       )::jsonb
 WHERE fields::text LIKE '%www.youtube.com/embed/%'
    OR fields::text LIKE '%accelerated-motion%';

UPDATE public.custom_block_definitions
   SET layout_schema = replace(
         replace(layout_schema::text, 'www.youtube.com/embed/', 'www.youtube-nocookie.com/embed/'),
         'accelerated-motion', 'accelerometer'
       )::jsonb
 WHERE layout_schema::text LIKE '%www.youtube.com/embed/%'
    OR layout_schema::text LIKE '%accelerated-motion%';
$nb_file_00000000000013$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000013_youtube_nocookie_embeds.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000013_youtube_nocookie_embeds.sql

  -- >>> FROM: 00000000000014_site_themes.sql
  IF NOT pg_temp.nb_recorded('00000000000014', '00000000000014_site_themes') THEN
    RAISE NOTICE 'catch-up: applying 00000000000014_site_themes.sql';
    EXECUTE $nb_file_00000000000014$
-- Editable site themes.
--
-- Themes used to be hardcoded CSS classes in libs/ui/src/styles/theme.css
-- (:root / .dark / .vibrant) with the switcher list duplicated in
-- apps/nextblock/app/providers.tsx and components/theme-switcher.tsx. This moves
-- the palette into the database so an ADMIN can retint the site, add themes and
-- remove them from /cms/settings/global-css without a redeploy.
--
-- Rendering: apps/nextblock/lib/themes/buildThemeCss.ts turns each row into a
-- `:root.<slug> { --token: value; ... }` rule injected into <head> by
-- app/layout.tsx. The `:root.x` form is two-class specificity, so generated
-- themes always beat the (0,1,0) fallback rules still shipped in theme.css for
-- consumers of the published @nextblock-cms/ui package.
--
-- Forward-only and idempotent.

CREATE TABLE IF NOT EXISTS public.site_themes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    description text,
    -- lucide-react icon name rendered by the theme switcher.
    icon text NOT NULL DEFAULT 'Palette',
    -- Drives the CSS `color-scheme` property and decides whether the theme also
    -- carries Tailwind's `.dark` class so `dark:` variants resolve correctly.
    color_scheme text NOT NULL DEFAULT 'light',
    -- Flat map of design token -> raw CSS value, keys WITHOUT the leading `--`,
    -- e.g. {"background": "0 0% 100%", "radius": "0.75rem"}.
    tokens jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Optional per-theme CSS, emitted nested inside the theme rule so it is
    -- automatically scoped. Authors use the `&` nesting selector,
    -- e.g. `& h1 { text-shadow: 0 0 5px hsl(var(--primary)); }`.
    extra_css text,
    -- System themes cannot be deleted: next-themes' `enableSystem` resolves to
    -- 'light' or 'dark', so those two slugs must always exist.
    is_system boolean DEFAULT false NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT site_themes_pkey PRIMARY KEY (id),
    CONSTRAINT site_themes_slug_key UNIQUE (slug),
    CONSTRAINT site_themes_color_scheme_check CHECK ((color_scheme = ANY (ARRAY['light'::text, 'dark'::text]))),
    -- The slug becomes a CSS class and a next-themes value; keep it safe for both.
    CONSTRAINT site_themes_slug_format_check CHECK ((slug ~ '^[a-z][a-z0-9-]{0,38}[a-z0-9]$')),
    CONSTRAINT site_themes_tokens_is_object_check CHECK ((jsonb_typeof(tokens) = 'object'))
);

COMMENT ON TABLE public.site_themes IS 'Editable colour themes. Each row renders to a `:root.<slug>` CSS rule injected by the root layout. Publicly readable (anonymous visitors need the palette); only ADMIN may write.';

CREATE INDEX IF NOT EXISTS site_themes_active_sort_idx ON public.site_themes USING btree (is_active, sort_order);

-- Exactly one default theme.
CREATE UNIQUE INDEX IF NOT EXISTS site_themes_single_default_idx ON public.site_themes USING btree (is_default) WHERE (is_default = true);

DROP TRIGGER IF EXISTS set_site_themes_updated_at ON public.site_themes;
CREATE TRIGGER set_site_themes_updated_at
    BEFORE UPDATE ON public.site_themes
    FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

-- A system theme must never be deleted, whoever asks.
CREATE OR REPLACE FUNCTION public.prevent_system_theme_delete() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = ''
    AS $$
BEGIN
  IF OLD.is_system THEN
    RAISE EXCEPTION 'Theme "%" is a system theme and cannot be deleted', OLD.slug
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_system_theme_delete ON public.site_themes;
CREATE TRIGGER trg_prevent_system_theme_delete
    BEFORE DELETE ON public.site_themes
    FOR EACH ROW EXECUTE FUNCTION public.prevent_system_theme_delete();

-- Promoting a theme to default demotes the previous one, so the unique partial
-- index above can never trip on a normal "make this the default" write.
CREATE OR REPLACE FUNCTION public.handle_default_theme_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = ''
    AS $$
BEGIN
  IF NEW.is_default THEN
    UPDATE public.site_themes
       SET is_default = false
     WHERE id <> NEW.id AND is_default;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_handle_default_theme_change ON public.site_themes;
CREATE TRIGGER trg_handle_default_theme_change
    AFTER INSERT OR UPDATE OF is_default ON public.site_themes
    FOR EACH ROW WHEN (NEW.is_default) EXECUTE FUNCTION public.handle_default_theme_change();

ALTER TABLE public.site_themes ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE public.site_themes TO anon;
GRANT ALL ON TABLE public.site_themes TO authenticated;
GRANT ALL ON TABLE public.site_themes TO service_role;

DROP POLICY IF EXISTS "Public read active themes" ON public.site_themes;
CREATE POLICY "Public read active themes" ON public.site_themes
    FOR SELECT TO authenticated, anon USING (true);

DROP POLICY IF EXISTS "Admins insert themes" ON public.site_themes;
CREATE POLICY "Admins insert themes" ON public.site_themes
    FOR INSERT TO authenticated
    WITH CHECK (((SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS "Admins update themes" ON public.site_themes;
CREATE POLICY "Admins update themes" ON public.site_themes
    FOR UPDATE TO authenticated
    USING (((SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role))
    WITH CHECK (((SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS "Admins delete themes" ON public.site_themes;
CREATE POLICY "Admins delete themes" ON public.site_themes
    FOR DELETE TO authenticated
    USING (((SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS "Service role manages themes" ON public.site_themes;
CREATE POLICY "Service role manages themes" ON public.site_themes
    TO service_role USING (true) WITH CHECK (true);

-- Seed the three shipped themes from libs/ui/src/styles/theme.css.
-- `--warning` / `--warning-foreground` are declared in the Tailwind theme
-- (libs/ui/tailwind.config.js) but were never defined in CSS, so bg-warning and
-- text-warning resolved to an invalid colour. They are given real values here.
INSERT INTO public.site_themes (slug, name, description, icon, color_scheme, is_system, is_default, sort_order, tokens, extra_css)
VALUES
  (
    'light', 'Light', 'Clean, technical, stark.', 'Sun', 'light', true, true, 10,
    '{
      "background": "0 0% 100%",
      "foreground": "222 47% 11%",
      "card": "0 0% 100%",
      "card-foreground": "222 47% 11%",
      "popover": "0 0% 100%",
      "popover-foreground": "222 47% 11%",
      "primary": "211.55 50.26% 37.84%",
      "primary-foreground": "210 40% 98%",
      "secondary": "210 40% 96.1%",
      "secondary-foreground": "222 47% 11%",
      "muted": "210 40% 96.1%",
      "muted-foreground": "215 16% 47%",
      "accent": "210 40% 96.1%",
      "accent-foreground": "222 47% 11%",
      "destructive": "0 84.2% 60.2%",
      "destructive-foreground": "210 40% 98%",
      "warning": "38 92% 50%",
      "warning-foreground": "222 47% 11%",
      "border": "214.3 31.8% 91.4%",
      "input": "214.3 31.8% 91.4%",
      "ring": "211.55 50.26% 37.84%",
      "radius": "0.75rem",
      "chart-1": "211.55 50.26% 37.84%",
      "chart-2": "215 16% 47%",
      "chart-3": "215 25% 27%",
      "chart-4": "210 40% 96%",
      "chart-5": "214 32% 91%"
    }'::jsonb,
    NULL
  ),
  (
    'dark', 'Dark', 'Midnight / neon tech.', 'Moon', 'dark', true, false, 20,
    '{
      "background": "222 47% 2%",
      "foreground": "210 40% 98%",
      "card": "222 47% 11%",
      "card-foreground": "210 40% 98%",
      "popover": "222 47% 11%",
      "popover-foreground": "210 40% 98%",
      "primary": "217 91% 60%",
      "primary-foreground": "222 47% 11%",
      "secondary": "217.2 32.6% 17.5%",
      "secondary-foreground": "210 40% 98%",
      "muted": "217.2 32.6% 17.5%",
      "muted-foreground": "215 20.2% 65.1%",
      "accent": "217.2 32.6% 17.5%",
      "accent-foreground": "210 40% 98%",
      "destructive": "0 62.8% 30.6%",
      "destructive-foreground": "210 40% 98%",
      "warning": "38 92% 50%",
      "warning-foreground": "222 47% 11%",
      "border": "217.2 32.6% 17.5%",
      "input": "217.2 32.6% 17.5%",
      "ring": "224 76% 48%",
      "radius": "0.75rem",
      "chart-1": "220 70% 50%",
      "chart-2": "160 60% 45%",
      "chart-3": "30 80% 55%",
      "chart-4": "280 65% 60%",
      "chart-5": "340 75% 55%"
    }'::jsonb,
    NULL
  ),
  (
    'vibrant', 'Vibrant', 'Cyberpunk neon.', 'Zap', 'dark', false, false, 30,
    '{
      "background": "260 50% 5%",
      "foreground": "180 100% 90%",
      "card": "260 50% 8%",
      "card-foreground": "180 100% 90%",
      "popover": "260 50% 8%",
      "popover-foreground": "180 100% 90%",
      "primary": "320 100% 55%",
      "primary-foreground": "0 0% 100%",
      "secondary": "180 100% 50%",
      "secondary-foreground": "260 50% 5%",
      "muted": "260 30% 15%",
      "muted-foreground": "260 20% 65%",
      "accent": "280 100% 50%",
      "accent-foreground": "0 0% 100%",
      "destructive": "0 100% 50%",
      "destructive-foreground": "0 0% 100%",
      "warning": "60 100% 50%",
      "warning-foreground": "260 50% 5%",
      "border": "320 100% 55%",
      "input": "260 30% 15%",
      "ring": "320 100% 55%",
      "radius": "0px",
      "chart-1": "320 100% 55%",
      "chart-2": "180 100% 50%",
      "chart-3": "280 100% 50%",
      "chart-4": "60 100% 50%",
      "chart-5": "120 100% 50%"
    }'::jsonb,
    '& h1, & h2, & h3, & h4, & h5, & h6 {
  text-shadow: 0 0 5px hsl(var(--primary)), 0 0 10px hsl(var(--secondary));
}
& button, & [role="button"] {
  box-shadow: 0 0 5px hsl(var(--primary) / 0.5);
  transition: box-shadow 0.3s ease;
}
& button:hover, & [role="button"]:hover {
  box-shadow: 0 0 15px hsl(var(--primary));
}
& .card, & [class*="card"] {
  border: 1px solid hsl(var(--primary));
  box-shadow: 0 0 10px hsl(var(--primary) / 0.2);
}
& .border {
  border-color: hsl(var(--border));
  box-shadow: 0 0 5px hsl(var(--border) / 0.3);
}'
  )
ON CONFLICT (slug) DO NOTHING;
$nb_file_00000000000014$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000014_site_themes.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000014_site_themes.sql

  -- >>> FROM: 00000000000015_scheduled_publishing.sql
  IF NOT pg_temp.nb_recorded('00000000000015', '00000000000015_scheduled_publishing') THEN
    RAISE NOTICE 'catch-up: applying 00000000000015_scheduled_publishing.sql';
    EXECUTE $nb_file_00000000000015$
-- Scheduled publishing for pages and products.
--
-- Posts already support scheduling: `posts.published_at` exists and every public
-- read gates on `published_at IS NULL OR published_at <= now()`, so a row with
-- status='published' and a future date is withheld until the date passes. Pages
-- and products had no equivalent column, so "go live on Tuesday" was impossible
-- for them. This adds the same column with the same semantics.
--
-- Visibility is derived from the (status, published_at) PAIR — no new enum value:
--
--   status = draft/archived                      -> not public, whatever the date
--   status = published|active, published_at NULL -> public now
--   status = published|active, date <= now()     -> public now
--   status = published|active, date >  now()     -> SCHEDULED (withheld)
--
-- Deriving "scheduled" instead of storing it keeps `page_status` unchanged (adding
-- an enum value can't be done inside a transaction with other DDL in Postgres) and
-- matches what posts have always done, so one code path covers all three types.
--
-- NULL is the safe default: every existing published row keeps rendering exactly as
-- before, so this migration needs no backfill and changes no current behavior.
--
-- Forward-only and idempotent.

ALTER TABLE public.pages
    ADD COLUMN IF NOT EXISTS published_at timestamp with time zone;

COMMENT ON COLUMN public.pages.published_at IS
    'Optional go-live moment. NULL = live as soon as status is published. A future value withholds the page from public reads until it passes (status stays "published"; the CMS renders that pair as "Scheduled").';

ALTER TABLE public.products
    ADD COLUMN IF NOT EXISTS published_at timestamp with time zone;

COMMENT ON COLUMN public.products.published_at IS
    'Optional go-live moment. NULL = live as soon as status is active. A future value withholds the product from public reads until it passes (status stays "active"; the CMS renders that pair as "Scheduled").';

-- Public listing/index queries filter on the (status, published_at) pair together
-- (catalog, sitemap, page lookups), so a composite index serves them in one pass.
CREATE INDEX IF NOT EXISTS pages_status_published_at_idx
    ON public.pages (status, published_at);

CREATE INDEX IF NOT EXISTS products_status_published_at_idx
    ON public.products (status, published_at);
$nb_file_00000000000015$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000015_scheduled_publishing.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000015_scheduled_publishing.sql

  -- >>> FROM: 00000000000016_product_revisions_and_revision_baseline.sql
  IF NOT pg_temp.nb_recorded('00000000000016', '00000000000016_product_revisions_and_revision_baseline') THEN
    RAISE NOTICE 'catch-up: applying 00000000000016_product_revisions_and_revision_baseline.sql';
    EXECUTE $nb_file_00000000000016$
-- 00000000000016_product_revisions_and_revision_baseline.sql
--
-- Revision History, part 1 of 2 (schema). The application-side rewrite lives in
-- apps/nextblock/app/cms/revisions/**.
--
-- Three things happen here:
--
--   1. products.version    — the monotonic counter the hybrid revision engine drives,
--                            mirroring pages.version / posts.version.
--
--   2. product_revisions   — a structural mirror of page_revisions / post_revisions.
--                            product_id is uuid (products.id is uuid, not bigint), and
--                            writes are gated on is_admin() to match products_*_policy
--                            rather than the ADMIN|WRITER pattern the page/post revision
--                            tables use. A WRITER who could insert a revision but not
--                            apply a restore would get a silent no-op restore, because
--                            PostgREST returns no error for an UPDATE matching zero rows.
--
--   3. Revision baseline   — every page, post and product gets a real `snapshot` row to
--                            restore to. Until now the CMS synthesised a fake "Initial
--                            Version" entry in the UI whose Restore button resolved to
--                            "current metadata + zero blocks" and wiped the content.
--                            There is now an actual stored baseline instead.
--
--                            Case A (version = 1, no revisions at all): the live row IS
--                            version 1. This covers seeded content — 00000000000003
--                            inserts every page and post at version 1 and writes no
--                            revision rows — and everything authored since the CMS save
--                            path stopped recording revisions. Snapshotting it at
--                            version 1 is what makes "restore the original seeded page"
--                            real for the first time.
--
--                            Case B (version > 1 but no snapshot at or below it): the
--                            true v1 is unrecoverable and is NOT fabricated. A snapshot
--                            of the current state is stored at the current version so the
--                            diff chain has a valid base and future restores resolve.
--
-- Forward-only, idempotent, and it modifies no existing row: every backfill is an
-- INSERT ... WHERE NOT EXISTS ... ON CONFLICT DO NOTHING.

-- ---------------------------------------------------------------------------
-- 1. products.version
-- ---------------------------------------------------------------------------

ALTER TABLE public.products
    ADD COLUMN IF NOT EXISTS version integer DEFAULT 1 NOT NULL;

COMMENT ON COLUMN public.products.version IS 'Monotonic version number for hybrid revisions.';

-- ---------------------------------------------------------------------------
-- 2. product_revisions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.product_revisions (
    id bigint NOT NULL,
    product_id uuid NOT NULL,
    author_id uuid,
    version integer NOT NULL,
    revision_type public.revision_type NOT NULL,
    content jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public.product_revisions IS 'Hybrid (snapshot/diff) revisions for products.';
COMMENT ON COLUMN public.product_revisions.content IS 'If snapshot: full content; if diff: JSON Patch array.';

DO $rb$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.product_revisions'::regclass
       AND attname  = 'id'
       AND attidentity <> ''
  ) THEN
    ALTER TABLE public.product_revisions
      ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
        SEQUENCE NAME public.product_revisions_id_seq
        START WITH 1
        INCREMENT BY 1
        NO MINVALUE
        NO MAXVALUE
        CACHE 1
      );
  END IF;
END $rb$;

DO $rb$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'product_revisions_pkey'
                    AND conrelid = 'public.product_revisions'::regclass) THEN
    ALTER TABLE ONLY public.product_revisions
      ADD CONSTRAINT product_revisions_pkey PRIMARY KEY (id);
  END IF;
END $rb$;

DO $rb$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'product_revisions_product_version_key'
                    AND conrelid = 'public.product_revisions'::regclass) THEN
    ALTER TABLE ONLY public.product_revisions
      ADD CONSTRAINT product_revisions_product_version_key UNIQUE (product_id, version);
  END IF;
END $rb$;

DO $rb$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'product_revisions_author_id_fkey'
                    AND conrelid = 'public.product_revisions'::regclass) THEN
    ALTER TABLE ONLY public.product_revisions
      ADD CONSTRAINT product_revisions_author_id_fkey
      FOREIGN KEY (author_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
  END IF;
END $rb$;

DO $rb$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'product_revisions_product_id_fkey'
                    AND conrelid = 'public.product_revisions'::regclass) THEN
    ALTER TABLE ONLY public.product_revisions
      ADD CONSTRAINT product_revisions_product_id_fkey
      FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;
  END IF;
END $rb$;

CREATE INDEX IF NOT EXISTS idx_product_revisions_author_id
    ON public.product_revisions USING btree (author_id);

CREATE INDEX IF NOT EXISTS idx_product_revisions_product_id_version
    ON public.product_revisions USING btree (product_id, version);

ALTER TABLE public.product_revisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_revisions_read_policy ON public.product_revisions;
CREATE POLICY product_revisions_read_policy ON public.product_revisions
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS product_revisions_insert_policy ON public.product_revisions;
CREATE POLICY product_revisions_insert_policy ON public.product_revisions
  FOR INSERT TO authenticated
  WITH CHECK (((SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS product_revisions_update_policy ON public.product_revisions;
CREATE POLICY product_revisions_update_policy ON public.product_revisions
  FOR UPDATE TO authenticated
  USING (((SELECT public.is_admin() AS is_admin) IS TRUE))
  WITH CHECK (((SELECT public.is_admin() AS is_admin) IS TRUE));

DROP POLICY IF EXISTS product_revisions_delete_policy ON public.product_revisions;
CREATE POLICY product_revisions_delete_policy ON public.product_revisions
  FOR DELETE TO authenticated
  USING (((SELECT public.is_admin() AS is_admin) IS TRUE));

GRANT ALL ON TABLE    public.product_revisions        TO anon;
GRANT ALL ON TABLE    public.product_revisions        TO authenticated;
GRANT ALL ON TABLE    public.product_revisions        TO service_role;
GRANT ALL ON SEQUENCE public.product_revisions_id_seq TO anon;
GRANT ALL ON SEQUENCE public.product_revisions_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.product_revisions_id_seq TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Revision baseline backfill
--
-- The JSON shape must match FullPageContent / FullPostContent / FullProductContent
-- in apps/nextblock/app/cms/revisions/utils.ts exactly, or the first diff taken
-- against a baseline row will be full of phantom operations.
--
-- Timestamps are rendered with an explicit millisecond-precision UTC format so they
-- match JavaScript's Date#toISOString() ("2026-07-03T17:52:15.643Z"). Postgres'
-- default jsonb rendering of timestamptz ("2026-07-03T17:52:15.643901+00:00") would
-- differ from the value the application writes and produce a spurious diff on the
-- very next save.
-- ---------------------------------------------------------------------------

-- 3a. Pages
INSERT INTO public.page_revisions (page_id, author_id, version, revision_type, content)
SELECT
    p.id,
    NULL::uuid,
    p.version,
    'snapshot'::public.revision_type,
    jsonb_build_object(
      'meta', jsonb_build_object(
        'title',            p.title,
        'slug',             p.slug,
        'language_id',      p.language_id,
        'status',           p.status,
        'meta_title',       p.meta_title,
        'meta_description', p.meta_description,
        'custom_canonical', p.custom_canonical,
        'published_at',     to_char(p.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'feature_image_id', p.feature_image_id
      ),
      'blocks', COALESCE((
        SELECT jsonb_agg(
                 jsonb_build_object(
                   'language_id', b.language_id,
                   'block_type',  b.block_type,
                   'content',     b.content,
                   'order',       b."order"
                 ) ORDER BY b."order" ASC, b.id ASC
               )
          FROM public.blocks b
         WHERE b.page_id = p.id
      ), '[]'::jsonb)
    )
  FROM public.pages p
 WHERE NOT EXISTS (
         SELECT 1 FROM public.page_revisions r
          WHERE r.page_id = p.id
            AND r.revision_type = 'snapshot'
            AND r.version <= p.version
       )
ON CONFLICT (page_id, version) DO NOTHING;

-- 3b. Posts
INSERT INTO public.post_revisions (post_id, author_id, version, revision_type, content)
SELECT
    po.id,
    NULL::uuid,
    po.version,
    'snapshot'::public.revision_type,
    jsonb_build_object(
      'meta', jsonb_build_object(
        'title',            po.title,
        'slug',             po.slug,
        'language_id',      po.language_id,
        'status',           po.status,
        'meta_title',       po.meta_title,
        'meta_description', po.meta_description,
        'custom_canonical', po.custom_canonical,
        'published_at',     to_char(po.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'feature_image_id', po.feature_image_id,
        'label',            po.label,
        'excerpt',          po.excerpt,
        'subtitle',         po.subtitle
      ),
      'blocks', COALESCE((
        SELECT jsonb_agg(
                 jsonb_build_object(
                   'language_id', b.language_id,
                   'block_type',  b.block_type,
                   'content',     b.content,
                   'order',       b."order"
                 ) ORDER BY b."order" ASC, b.id ASC
               )
          FROM public.blocks b
         WHERE b.post_id = po.id
      ), '[]'::jsonb)
    )
  FROM public.posts po
 WHERE NOT EXISTS (
         SELECT 1 FROM public.post_revisions r
          WHERE r.post_id = po.id
            AND r.revision_type = 'snapshot'
            AND r.version <= po.version
       )
ON CONFLICT (post_id, version) DO NOTHING;

-- 3c. Products.
--
-- Content only. price/prices/sale_*/scheduled_*/stock/sku/average_rating/total_reviews
-- are deliberately excluded from the snapshot: pricing and inventory are mutated from
-- outside the editor (promotions, Freemius sync, order fulfilment), ratings are derived
-- aggregates, and inventory_items is keyed by bare SKU text with no FK to products — so
-- replaying commerce state on restore would reach rows the editor never touched.
-- Restoring a product restores its content, not its commerce state.
INSERT INTO public.product_revisions (product_id, author_id, version, revision_type, content)
SELECT
    pr.id,
    NULL::uuid,
    pr.version,
    'snapshot'::public.revision_type,
    jsonb_build_object(
      'meta', jsonb_build_object(
        'title',             pr.title,
        'slug',              pr.slug,
        'language_id',       pr.language_id,
        'status',            pr.status,
        'meta_title',        pr.meta_title,
        'meta_description',  pr.meta_description,
        'custom_canonical',  pr.custom_canonical,
        'published_at',      to_char(pr.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'short_description', pr.short_description,
        'description_json',  pr.description_json
      ),
      'blocks', COALESCE((
        SELECT jsonb_agg(
                 jsonb_build_object(
                   'language_id', b.language_id,
                   'block_type',  b.block_type,
                   'content',     b.content,
                   'order',       b."order"
                 ) ORDER BY b."order" ASC, b.id ASC
               )
          FROM public.blocks b
         WHERE b.product_id = pr.id
      ), '[]'::jsonb)
    )
  FROM public.products pr
 WHERE NOT EXISTS (
         SELECT 1 FROM public.product_revisions r
          WHERE r.product_id = pr.id
            AND r.revision_type = 'snapshot'
            AND r.version <= pr.version
       )
ON CONFLICT (product_id, version) DO NOTHING;
$nb_file_00000000000016$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000016_product_revisions_and_revision_baseline.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000016_product_revisions_and_revision_baseline.sql

  -- >>> FROM: 00000000000017_cortex_ai_mcp_server.sql
  IF NOT pg_temp.nb_recorded('00000000000017', '00000000000017_cortex_ai_mcp_server') THEN
    RAISE NOTICE 'catch-up: applying 00000000000017_cortex_ai_mcp_server.sql';
    EXECUTE $nb_file_00000000000017$
-- Cortex AI MCP (Model Context Protocol) server access.
--
-- Adds the bearer-token store that gates /api/mcp, the endpoint that exposes the
-- Cortex AI tool registry to external MCP clients (Claude Code, Claude Desktop,
-- Cursor, VS Code). Two pieces:
--
--   1. public.mcp_access_tokens — one row per issued token. We store ONLY the
--      SHA-256 hash of the token, never the token itself: the plaintext is shown
--      to the admin exactly once at mint time and is unrecoverable afterwards, so
--      a database leak cannot be replayed against the MCP endpoint. `token_prefix`
--      is the non-secret leading fragment kept purely so the UI can tell two tokens
--      apart in a list.
--
--   2. cortex_ai_mcp_settings — a non-secret JSON site_settings row holding the
--      server on/off switch and the localhost-trust flag. It is added to all four
--      site_settings policies so only authenticated ADMINs can read or write it;
--      the MCP route itself reads it through the service-role client, which
--      bypasses RLS.
--
-- Forward-only. Recreates the four site_settings policies idempotently, preserving
-- every key already in each policy's sensitive array (note that
-- language_detection_settings stays anon-READABLE and so is absent from the SELECT
-- policy, exactly as migration 00000000000012 left it).

CREATE TABLE IF NOT EXISTS public.mcp_access_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  -- Lowercase hex SHA-256 of the plaintext token. Unique so a lookup is a single
  -- indexed equality probe and duplicate mints are impossible.
  token_hash text NOT NULL UNIQUE,
  -- Non-secret display fragment, e.g. "nbmcp_a1b2c3d4". Never enough to authenticate.
  token_prefix text NOT NULL,
  -- 'read' grants the read-only tools; 'write' additionally grants the mutating ones.
  scopes text[] NOT NULL DEFAULT ARRAY['read', 'write']::text[],
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);

COMMENT ON TABLE public.mcp_access_tokens IS
  'Bearer tokens for the Cortex AI MCP server at /api/mcp. Stores SHA-256 hashes only; plaintext is displayed once at mint time.';

CREATE INDEX IF NOT EXISTS mcp_access_tokens_token_hash_idx
  ON public.mcp_access_tokens (token_hash);

-- Orders the admin token list newest-first without a sort.
CREATE INDEX IF NOT EXISTS mcp_access_tokens_created_at_idx
  ON public.mcp_access_tokens (created_at DESC);

ALTER TABLE public.mcp_access_tokens ENABLE ROW LEVEL SECURITY;

-- Tokens are credentials: admin-only, with no anon or WRITER access at all. The
-- MCP route verifies them with the service-role client, which bypasses RLS.
DROP POLICY IF EXISTS mcp_access_tokens_admin_select ON public.mcp_access_tokens;
CREATE POLICY mcp_access_tokens_admin_select ON public.mcp_access_tokens
  FOR SELECT TO authenticated
  USING ((SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role);

DROP POLICY IF EXISTS mcp_access_tokens_admin_insert ON public.mcp_access_tokens;
CREATE POLICY mcp_access_tokens_admin_insert ON public.mcp_access_tokens
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role);

DROP POLICY IF EXISTS mcp_access_tokens_admin_update ON public.mcp_access_tokens;
CREATE POLICY mcp_access_tokens_admin_update ON public.mcp_access_tokens
  FOR UPDATE TO authenticated
  USING ((SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role)
  WITH CHECK ((SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role);

DROP POLICY IF EXISTS mcp_access_tokens_admin_delete ON public.mcp_access_tokens;
CREATE POLICY mcp_access_tokens_admin_delete ON public.mcp_access_tokens
  FOR DELETE TO authenticated
  USING ((SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.mcp_access_tokens TO authenticated;
GRANT ALL ON public.mcp_access_tokens TO service_role;

-- Add cortex_ai_mcp_settings to the admin-only site_settings group (all four policies).
DROP POLICY IF EXISTS site_settings_read_policy ON public.site_settings;
CREATE POLICY site_settings_read_policy ON public.site_settings FOR SELECT USING (((key <> ALL (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text, 'cortex_ai_mcp_settings'::text])) OR ((key = ANY (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text, 'cortex_ai_mcp_settings'::text])) AND (( SELECT auth.role() AS role) = 'authenticated'::text) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role))));

DROP POLICY IF EXISTS site_settings_insert_policy ON public.site_settings;
CREATE POLICY site_settings_insert_policy ON public.site_settings FOR INSERT TO authenticated WITH CHECK ((((key <> ALL (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text, 'cortex_ai_mcp_settings'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role]))) OR ((key = ANY (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text, 'cortex_ai_mcp_settings'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role))));

DROP POLICY IF EXISTS site_settings_update_policy ON public.site_settings;
CREATE POLICY site_settings_update_policy ON public.site_settings FOR UPDATE TO authenticated USING ((((key <> ALL (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text, 'cortex_ai_mcp_settings'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role]))) OR ((key = ANY (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text, 'cortex_ai_mcp_settings'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role)))) WITH CHECK ((((key <> ALL (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text, 'cortex_ai_mcp_settings'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role]))) OR ((key = ANY (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text, 'cortex_ai_mcp_settings'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role))));

DROP POLICY IF EXISTS site_settings_delete_policy ON public.site_settings;
CREATE POLICY site_settings_delete_policy ON public.site_settings FOR DELETE TO authenticated USING ((((key <> ALL (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text, 'cortex_ai_mcp_settings'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role]))) OR ((key = ANY (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text, 'cortex_ai_mcp_settings'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role))));
$nb_file_00000000000017$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000017_cortex_ai_mcp_server.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000017_cortex_ai_mcp_server.sql

  -- >>> FROM: 00000000000018_site_scripts.sql
  IF NOT pg_temp.nb_recorded('00000000000018', '00000000000018_site_scripts') THEN
    RAISE NOTICE 'catch-up: applying 00000000000018_site_scripts.sql';
    EXECUTE $nb_file_00000000000018$
-- Site scripts: admin-authored JavaScript injected into every page of the public site.
--
-- Rich-text blocks can already carry an inline <script>, but that script belongs to
-- one block on one page. This table is for behaviour that spans the site: chat
-- widgets, third-party embeds, and the scroll/animation helpers that page classes
-- rely on. Each row gets a name, an on/off switch, and a defined injection point.
--
-- NOT the same thing as `site_settings.privacy_settings -> custom_scripts`, which is
-- a single consent-gated blob for marketing tags and only fires once a visitor
-- accepts cookies. Rows here are functional site code and run unconditionally, so
-- anything requiring consent belongs in that setting instead, not this table.
--
-- Scripts are emitted with the request's CSP nonce by the root layout, so they run
-- under the site's existing Content-Security-Policy rather than forcing it open.
--
-- Security posture: this is arbitrary JavaScript on every page, so writes are
-- ADMIN-only (WRITER is deliberately excluded, unlike most content tables) and the
-- public may read only rows that are switched on, so a half-written draft is never
-- served to a visitor.

CREATE TABLE IF NOT EXISTS public.site_scripts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    -- Raw JavaScript, stored WITHOUT the surrounding <script> tag. The layout adds
    -- the tag so the nonce and attributes are always applied by us, never by the
    -- author. Ignored when `src` is set.
    code text DEFAULT ''::text NOT NULL,
    -- When set, an external script is loaded from this URL and `code` is ignored.
    src text,
    -- Where the tag is emitted. 'head' runs before first paint (blocking, use
    -- sparingly); 'body_end' runs once the markup exists and is the right default
    -- for anything that queries the DOM.
    placement text DEFAULT 'body_end'::text NOT NULL,
    -- Applies to external `src` scripts; inline code ignores it.
    load_strategy text DEFAULT 'default'::text NOT NULL,
    is_active boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT site_scripts_pkey PRIMARY KEY (id),
    CONSTRAINT site_scripts_placement_check
        CHECK ((placement = ANY (ARRAY['head'::text, 'body_start'::text, 'body_end'::text]))),
    CONSTRAINT site_scripts_load_strategy_check
        CHECK ((load_strategy = ANY (ARRAY['default'::text, 'defer'::text, 'async'::text]))),
    -- An external script must be https so it cannot be downgraded in transit.
    CONSTRAINT site_scripts_src_scheme_check
        CHECK ((src IS NULL OR src ~ '^https://')),
    -- A row has to actually do something: inline code or an external src.
    CONSTRAINT site_scripts_has_payload_check
        CHECK ((src IS NOT NULL OR length(btrim(code)) > 0))
);

COMMENT ON TABLE public.site_scripts IS
    'Admin-authored JavaScript injected into the public site by the root layout, with the request CSP nonce applied. Only is_active rows are publicly readable; only ADMIN may write. Distinct from privacy_settings.custom_scripts, which is consent-gated marketing tags.';

CREATE INDEX IF NOT EXISTS site_scripts_active_placement_sort_idx
    ON public.site_scripts USING btree (is_active, placement, sort_order);

DROP TRIGGER IF EXISTS set_site_scripts_updated_at ON public.site_scripts;
CREATE TRIGGER set_site_scripts_updated_at
    BEFORE UPDATE ON public.site_scripts
    FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

ALTER TABLE public.site_scripts ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE public.site_scripts TO anon;
GRANT ALL ON TABLE public.site_scripts TO authenticated;
GRANT ALL ON TABLE public.site_scripts TO service_role;

-- Anonymous visitors need the active scripts to render the page. Inactive rows stay
-- private so a half-written script is never exposed before it is switched on.
DROP POLICY IF EXISTS "Public read active site scripts" ON public.site_scripts;
CREATE POLICY "Public read active site scripts" ON public.site_scripts
    FOR SELECT TO authenticated, anon USING (is_active);

DROP POLICY IF EXISTS "Admins read all site scripts" ON public.site_scripts;
CREATE POLICY "Admins read all site scripts" ON public.site_scripts
    FOR SELECT TO authenticated
    USING (((SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS "Admins insert site scripts" ON public.site_scripts;
CREATE POLICY "Admins insert site scripts" ON public.site_scripts
    FOR INSERT TO authenticated
    WITH CHECK (((SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS "Admins update site scripts" ON public.site_scripts;
CREATE POLICY "Admins update site scripts" ON public.site_scripts
    FOR UPDATE TO authenticated
    USING (((SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role))
    WITH CHECK (((SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS "Admins delete site scripts" ON public.site_scripts;
CREATE POLICY "Admins delete site scripts" ON public.site_scripts
    FOR DELETE TO authenticated
    USING (((SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role));
$nb_file_00000000000018$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000018_site_scripts.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000018_site_scripts.sql

  -- >>> FROM: 00000000000019_site_script_revisions.sql
  IF NOT pg_temp.nb_recorded('00000000000019', '00000000000019_site_script_revisions') THEN
    RAISE NOTICE 'catch-up: applying 00000000000019_site_script_revisions.sql';
    EXECUTE $nb_file_00000000000019$
-- Audit trail and undo for site scripts.
--
-- `site_scripts` ships arbitrary JavaScript to every visitor, which makes it the
-- highest-privilege write in the CMS: a bad or malicious snippet can read cookies,
-- watch checkout forms, or phone home. Content has Revision History for exactly this
-- reason; code needs it more, not less. Every create/update/delete writes one row
-- here, and every row is a complete, restorable snapshot — so this table is both the
-- log ("who shipped what, when, from where") and the undo.
--
-- APPEND-ONLY BY CONSTRUCTION. There are no UPDATE or DELETE policies, and the
-- trigger below rejects both even for the service role, which otherwise bypasses
-- RLS. An audit trail that the compromised credential can rewrite is not an audit
-- trail. Reverting therefore writes a NEW 'revert' row rather than removing history.
--
-- `script_id` and `actor_user_id` are deliberately PLAIN uuids with no foreign keys:
-- an FK with ON DELETE SET NULL would have to UPDATE this table when a script or a
-- profile is deleted, which the append-only trigger forbids. `script_name` is
-- denormalised so a deleted script is still identifiable in the log.

CREATE TABLE IF NOT EXISTS public.site_script_revisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    script_id uuid,
    script_name text NOT NULL,
    revision_type text NOT NULL,
    -- Null when the actor could not be resolved (e.g. a localhost dev connection).
    actor_user_id uuid,
    -- Which surface made the change, so an unexpected edit can be traced back to
    -- the dashboard or to an MCP token.
    source text DEFAULT 'cms'::text NOT NULL,
    summary text,
    -- Full restorable state of the script at this revision. For 'delete' it is the
    -- state immediately BEFORE removal, so restoring it brings the script back.
    snapshot jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT site_script_revisions_pkey PRIMARY KEY (id),
    CONSTRAINT site_script_revisions_type_check
        CHECK ((revision_type = ANY (ARRAY['create'::text, 'update'::text, 'delete'::text, 'revert'::text]))),
    CONSTRAINT site_script_revisions_source_check
        CHECK ((source = ANY (ARRAY['cms'::text, 'mcp'::text]))),
    CONSTRAINT site_script_revisions_snapshot_is_object_check
        CHECK ((jsonb_typeof(snapshot) = 'object'))
);

COMMENT ON TABLE public.site_script_revisions IS
    'Append-only audit log and undo history for site_scripts. Each row is a restorable snapshot. UPDATE and DELETE are blocked by trigger, including for the service role.';

CREATE INDEX IF NOT EXISTS site_script_revisions_script_created_idx
    ON public.site_script_revisions USING btree (script_id, created_at DESC);

CREATE INDEX IF NOT EXISTS site_script_revisions_created_idx
    ON public.site_script_revisions USING btree (created_at DESC);

-- Enforced in the database rather than the application so it holds for every
-- caller, including the service-role client the MCP server uses.
CREATE OR REPLACE FUNCTION public.prevent_site_script_revision_rewrite() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = ''
    AS $$
BEGIN
  RAISE EXCEPTION 'site_script_revisions is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS trg_site_script_revisions_append_only ON public.site_script_revisions;
CREATE TRIGGER trg_site_script_revisions_append_only
    BEFORE UPDATE OR DELETE ON public.site_script_revisions
    FOR EACH ROW EXECUTE FUNCTION public.prevent_site_script_revision_rewrite();

ALTER TABLE public.site_script_revisions ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON TABLE public.site_script_revisions TO authenticated;
GRANT ALL ON TABLE public.site_script_revisions TO service_role;

-- Read is ADMIN-only: snapshots contain the full source of scripts that may not be
-- active yet, and the log itself reveals operational history.
DROP POLICY IF EXISTS "Admins read site script revisions" ON public.site_script_revisions;
CREATE POLICY "Admins read site script revisions" ON public.site_script_revisions
    FOR SELECT TO authenticated
    USING (((SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS "Admins insert site script revisions" ON public.site_script_revisions;
CREATE POLICY "Admins insert site script revisions" ON public.site_script_revisions
    FOR INSERT TO authenticated
    WITH CHECK (((SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role));
$nb_file_00000000000019$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000019_site_script_revisions.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000019_site_script_revisions.sql

  -- >>> FROM: 00000000000020_updating_article.sql
  IF NOT pg_temp.nb_recorded('00000000000020', '00000000000020_updating_article') THEN
    RAISE NOTICE 'catch-up: applying 00000000000020_updating_article.sql';
    EXECUTE $nb_file_00000000000020$
-- 00000000000020_updating_article.sql
-- Seeds the "How Updating NextBlock Works" guide as an EN/FR twin pair, the companion
-- to the install guide seeded in the baseline (00000000000003, slugs 'how-to-setup-nextblock'
-- / 'comment-configurer-nextblock'). It documents the single `npm run update` command
-- across all four install paths — one-click Vercel, npm create → Docker, npm create →
-- managed cloud, and the cloned monorepo.
--
-- Forward-only and idempotent by construction:
--   * posts carries UNIQUE (language_id, slug), so the inserts use ON CONFLICT DO NOTHING;
--   * blocks has no natural unique key, so the body insert is guarded on NOT EXISTS;
--   * ids are never hardcoded — posts.id and blocks.id are identity columns and a live
--     database has real editor-created rows occupying the low ids the baseline used.
--   * the feature image is looked up rather than asserted, so a site that deleted the
--     seeded media row still gets the article (with no cover) instead of a failed migration.
--
-- Because the sandbox reset payload and the /setup wizard's embedded bundle are both
-- generated FROM this directory, the article reaches a fresh install and every hourly
-- sandbox reset with no extra wiring — regenerate them with `npm run generate:sandbox`
-- and `npm run generate:migrations-bundle`.
--
-- blocks.content is JSONB written with PostgreSQL dollar-quoting (same style as 006/008)
-- so the HTML can use ordinary single-quoted class attributes without quote doubling.

DO $body$
DECLARE
  v_group   uuid := 'c0d3f1a2-8b47-4e19-9a52-7f6b1d4e8c30';
  v_image   uuid;
  v_en_post integer;
  v_fr_post integer;
BEGIN
  SELECT id INTO v_image
    FROM public.media
   WHERE id = '641ddf75-5c90-41df-8b83-e7c298f30a6a'::uuid;

  ---------------------------------------------------------------------------
  -- English
  ---------------------------------------------------------------------------
  INSERT INTO public.posts (
    language_id, author_id, title, slug, label, excerpt, subtitle, status,
    published_at, meta_title, meta_description, feature_image_id, version,
    translation_group_id
  )
  SELECT
    1, NULL,
    'How Updating NextBlock Works: One Command for Every Install',
    'how-updating-works',
    'Maintenance',
    'However you installed NextBlock — one-click Vercel, the CLI, Docker or a git clone — a single npm run update brings the code, the dependencies and the database schema forward together.',
    'Automatic upstream syncing on Vercel, and one command everywhere else: what npm run update does, what it never touches, and how to roll it back.',
    'published', now(),
    'How to Update NextBlock — One Command for Every Install',
    'Update NextBlock in one step. npm run update pulls new code, installs dependencies and applies pending database migrations on Vercel, Docker, CLI and git-clone installs alike.',
    v_image, 1, v_group
  WHERE NOT EXISTS (
    SELECT 1 FROM public.posts WHERE language_id = 1 AND slug = 'how-updating-works'
  );

  SELECT id INTO v_en_post
    FROM public.posts
   WHERE language_id = 1 AND slug = 'how-updating-works'
   ORDER BY id
   LIMIT 1;

  IF v_en_post IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.blocks WHERE post_id = v_en_post
  ) THEN
    INSERT INTO public.blocks (post_id, language_id, block_type, content, "order")
    VALUES (v_en_post, 1, 'text', $nben$
{"html_content":"<p class='text-lg leading-8 text-slate-700 dark:text-slate-300'>NextBlock ships improvements continuously — new blocks, editor fixes, security patches, and occasionally a database change that the new code depends on. Keeping up with all of that used to mean knowing which of the four install paths you were on. It no longer does. Every NextBlock project, however it was created, understands one command:</p>\n\n<div class='my-10 overflow-hidden rounded-[2rem] border border-slate-800 bg-slate-950 shadow-2xl'>\n  <div class='flex items-center gap-2 border-b border-white/10 px-5 py-3'>\n    <span class='h-3 w-3 rounded-full bg-red-400/70'></span>\n    <span class='h-3 w-3 rounded-full bg-yellow-400/70'></span>\n    <span class='h-3 w-3 rounded-full bg-green-400/70'></span>\n    <span class='ml-3 text-xs font-mono text-slate-400'>your project</span>\n  </div>\n  <div class='px-6 py-8 text-center'>\n    <p class='mt-0 mb-2 font-mono text-2xl sm:text-3xl font-semibold text-emerald-300'>npm run update</p>\n    <p class='mb-0 text-sm text-slate-400'>Code &middot; dependencies &middot; database schema &mdash; in that order, in one step.</p>\n  </div>\n</div>\n\n<p>It figures out which kind of install it is running inside, picks the right source for new code, installs the matching dependencies, and then applies any database migrations the new version needs. If you would rather look before you leap, <code>npm run update -- --check</code> reports exactly what would change and touches nothing.</p>\n\n<h2 id='the-four-paths'>The four install paths, and how each one gets updates</h2>\n<p class='text-slate-600 dark:text-slate-400'>These map one-to-one onto the four options in <a href='/article/how-to-setup-nextblock'>the install guide</a>. The command is the same everywhere; what differs is where the new code comes from.</p>\n\n<div class='grid gap-5 md:grid-cols-2 my-8'>\n  <a href='#vercel' class='block rounded-[1.75rem] border border-blue-200 bg-blue-50/70 p-6 no-underline transition-shadow hover:shadow-lg dark:border-blue-500/20 dark:bg-blue-500/10'>\n    <span class='flex h-9 w-9 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white'>1</span>\n    <p class='mt-4 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-blue-700 dark:text-blue-200'>Fully automatic</p>\n    <h3 class='mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white'>One-click Vercel &amp; GitHub forks</h3>\n    <p class='mb-0 text-sm leading-6 text-slate-600 dark:text-slate-300'>A daily workflow merges upstream into your repository and Vercel redeploys. You do nothing.</p>\n  </a>\n  <a href='#docker' class='block rounded-[1.75rem] border border-amber-200 bg-amber-50/70 p-6 no-underline transition-shadow hover:shadow-lg dark:border-amber-500/20 dark:bg-amber-500/10'>\n    <span class='flex h-9 w-9 items-center justify-center rounded-full bg-amber-500 text-sm font-bold text-white'>2</span>\n    <p class='mt-4 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-amber-700 dark:text-amber-200'>One command</p>\n    <h3 class='mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white'>npm create nextblock &rarr; Docker</h3>\n    <p class='mb-0 text-sm leading-6 text-slate-600 dark:text-slate-300'>Update, then rebuild the local stack. Your Postgres and media volumes survive untouched.</p>\n  </a>\n  <a href='#cloud' class='block rounded-[1.75rem] border border-violet-200 bg-violet-50/70 p-6 no-underline transition-shadow hover:shadow-lg dark:border-violet-500/20 dark:bg-violet-500/10'>\n    <span class='flex h-9 w-9 items-center justify-center rounded-full bg-violet-600 text-sm font-bold text-white'>3</span>\n    <p class='mt-4 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-violet-700 dark:text-violet-200'>One command</p>\n    <h3 class='mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white'>npm create nextblock &rarr; Supabase</h3>\n    <p class='mb-0 text-sm leading-6 text-slate-600 dark:text-slate-300'>New framework files come from npm; your own pages, routes and content are left alone.</p>\n  </a>\n  <a href='#clone' class='block rounded-[1.75rem] border border-emerald-200 bg-emerald-50/70 p-6 no-underline transition-shadow hover:shadow-lg dark:border-emerald-500/20 dark:bg-emerald-500/10'>\n    <span class='flex h-9 w-9 items-center justify-center rounded-full bg-emerald-600 text-sm font-bold text-white'>4</span>\n    <p class='mt-4 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200'>One command</p>\n    <h3 class='mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white'>git clone the monorepo</h3>\n    <p class='mb-0 text-sm leading-6 text-slate-600 dark:text-slate-300'>A guarded git pull or upstream merge, then dependencies and migrations. No manual steps.</p>\n  </a>\n</div>\n\n<h2 id='vercel'>1. One-click Vercel and GitHub forks &mdash; hands-off</h2>\n<p>This path updates itself. When you deployed, NextBlock created a repository you own; the dashboard&rsquo;s <strong>Connect GitHub</strong> onboarding step installs a workflow into it that runs <strong>every day at midnight UTC</strong> and can also be triggered by hand from your repository&rsquo;s <strong>Actions</strong> tab.</p>\n<ol class='space-y-2'>\n  <li>The workflow merges the latest upstream NextBlock into your deploy branch.</li>\n  <li>A clean merge is pushed to your branch, which triggers an ordinary Vercel deployment.</li>\n  <li>During that production build, NextBlock applies any pending database migrations <em>before</em> the app is built &mdash; so new code never runs against an old schema.</li>\n  <li>If the merge conflicts, nothing is pushed. The workflow opens a GitHub issue instead, and your CMS dashboard shows an amber banner linking straight to it. Resolve it, close the issue, and the banner clears itself.</li>\n</ol>\n<div class='rounded-3xl border border-emerald-200 bg-emerald-50/80 p-6 my-8 dark:border-emerald-500/20 dark:bg-emerald-500/10'>\n  <p class='mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200'>Make the repository public</p>\n  <p class='mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200'>A public repository is completely zero-config. On a private one, add a <code>NEXTBLOCK_GITHUB_TOKEN</code> environment variable with read access to issues so the conflict banner still works &mdash; and note that Vercel&rsquo;s free Hobby plan refuses to auto-deploy automated commits on private repositories, so the merge would land without deploying.</p>\n</div>\n<p>Working on a local clone of that fork? <code>npm run update</code> does the same merge on your machine, adding an <code>upstream</code> remote if it is missing, then installs dependencies and applies migrations.</p>\n\n<h2 id='docker'>2. npm create nextblock &rarr; Docker &mdash; update, then rebuild</h2>\n<p>From your project directory:</p>\n<pre><code>npm run update\nnpm run docker:up</code></pre>\n<p>The first command refreshes the application, its dependencies and the schema; the second rebuilds and restarts the containers. Your database and media live in Docker volumes and are never touched by either step &mdash; <code>docker:up</code> rebuilds images, not data.</p>\n\n<h2 id='cloud'>3. npm create nextblock &rarr; managed Supabase &mdash; one command</h2>\n<pre><code>npm run update\nnpm run build\nnpm start</code></pre>\n<p>Your project is a standalone Next.js app, so new framework code is fetched from the published <code>create-nextblock</code> package on npm &mdash; the exact artifact your project was scaffolded from, versioned in lockstep with the release. NextBlock refreshes the files it owns, merges the new dependency versions into your <code>package.json</code>, runs <code>npm install</code>, and then applies migrations.</p>\n<div class='rounded-3xl border border-violet-200 bg-violet-50/80 p-6 my-8 dark:border-violet-500/20 dark:bg-violet-500/10'>\n  <p class='mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-violet-700 dark:text-violet-200'>Deploying to Vercel from this project</p>\n  <p class='mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200'>Run <code>npm run update</code> locally, commit the result, and push. Your production build applies any pending migrations on the way up, exactly as it does for one-click installs.</p>\n</div>\n\n<h2 id='clone'>4. The cloned monorepo &mdash; one command</h2>\n<pre><code>npm run update</code></pre>\n<p>In a clone of the NextBlock repository this fast-forwards your checkout, reinstalls workspace dependencies and applies pending migrations. It refuses to run over uncommitted changes and tells you how to stash them first, so an update can never silently eat work in progress. If you have local commits, it stops and points you at <code>git pull --rebase</code> rather than guessing.</p>\n\n<h2 id='what-it-does'>What <code>npm run update</code> actually does</h2>\n<ol class='space-y-2'>\n  <li><strong>Identifies the install.</strong> Monorepo or standalone app; git-backed or npm-backed; Docker or not.</li>\n  <li><strong>Updates the code</strong> from the right source &mdash; an upstream git merge, a fast-forward pull, or the published <code>create-nextblock</code> package.</li>\n  <li><strong>Installs dependencies</strong> with <code>npm install</code>, so the code and the packages it imports move together.</li>\n  <li><strong>Refreshes the migration files</strong> shipped inside <code>@nextblock-cms/db</code>, so the newest schema changes are on disk before anything is applied.</li>\n  <li><strong>Applies pending migrations</strong>, listing them first and asking before it writes.</li>\n  <li><strong>Clears the dashboard&rsquo;s update banner</strong> once the new version is really in place.</li>\n</ol>\n\n<h3>Options</h3>\n<div class='overflow-x-auto my-6'>\n<table class='w-full text-left text-sm'>\n  <thead><tr class='border-b border-slate-200 dark:border-white/10'><th class='py-3 pr-4 font-semibold'>Command</th><th class='py-3 font-semibold'>What it does</th></tr></thead>\n  <tbody class='align-top'>\n    <tr class='border-b border-slate-100 dark:border-white/5'><td class='py-3 pr-4'><code>npm run update</code></td><td class='py-3'>Code, dependencies and schema.</td></tr>\n    <tr class='border-b border-slate-100 dark:border-white/5'><td class='py-3 pr-4'><code>npm run update -- --check</code></td><td class='py-3'>Report what would change. Writes nothing.</td></tr>\n    <tr class='border-b border-slate-100 dark:border-white/5'><td class='py-3 pr-4'><code>npm run update -- --yes</code></td><td class='py-3'>Skip the confirmation prompts. Useful in CI.</td></tr>\n    <tr class='border-b border-slate-100 dark:border-white/5'><td class='py-3 pr-4'><code>npm run update -- --db-only</code></td><td class='py-3'>Apply pending migrations and nothing else.</td></tr>\n    <tr class='border-b border-slate-100 dark:border-white/5'><td class='py-3 pr-4'><code>npm run update -- --skip-db</code></td><td class='py-3'>Update code and dependencies, leave the database alone.</td></tr>\n    <tr><td class='py-3 pr-4'><code>npm run update -- --force</code></td><td class='py-3'>Run even when you are already on the latest version.</td></tr>\n  </tbody>\n</table>\n</div>\n\n<h2 id='database'>What happens to your database</h2>\n<p>Schema changes are <strong>forward-only</strong>. NextBlock never rewrites or replays a migration that has already run: each one is applied and recorded in the same transaction, so a failure rolls back cleanly and leaves the database exactly as it was. Already-applied migrations are skipped by version, which makes re-running an update completely safe.</p>\n<p>Migrations change <em>structure</em> &mdash; tables, columns, indexes, permissions. Your pages, posts, products, media and users are yours; the update never deletes or rewrites them.</p>\n<div class='rounded-3xl border border-blue-200 bg-blue-50/80 p-6 my-8 dark:border-blue-500/20 dark:bg-blue-500/10'>\n  <p class='mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-blue-700 dark:text-blue-200'>Belt and braces</p>\n  <p class='mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200'>Before a big jump on a production site, take a database snapshot &mdash; Supabase does daily backups on paid plans, and you can trigger one on demand from the Supabase dashboard. Then run <code>npm run update -- --check</code> to see the pending list before you commit to it.</p>\n</div>\n\n<h2 id='safety'>If something goes wrong</h2>\n<ul class='space-y-2'>\n  <li><strong>Standalone projects:</strong> every framework file the update replaces is copied first into a timestamped folder under <code>.nextblock-backup/</code> in your project. Nothing is deleted, so files you added yourself are never removed.</li>\n  <li><strong>Git-backed installs:</strong> the update is an ordinary commit. <code>git log</code> shows it and <code>git revert</code> undoes it.</li>\n  <li><strong>A conflicted merge</strong> is aborted automatically &mdash; your working tree is left exactly as it was, with instructions printed for resolving it by hand.</li>\n  <li><strong>A failed migration</strong> rolls back. Fix the cause and re-run; nothing half-applied is left behind.</li>\n</ul>\n<p>If you have customised a file that NextBlock owns &mdash; something under <code>app/</code>, <code>components/</code> or <code>lib/</code> &mdash; the update will replace it and back up your version. Diff the backup afterwards to bring your change forward. Customisations that live in your own new files, in the CMS, or in <code>.env</code> are never affected.</p>\n\n<h2 id='knowing'>Knowing when there is something to update</h2>\n<p>You do not have to poll. NextBlock checks in the background while you use the CMS and raises a dashboard banner when a newer version is published, telling you which version you are on and what is available. Administrators can also just run <code>npm run update -- --check</code> at any time.</p>\n\n<h2 id='faq'>Update FAQ</h2>\n<h3>Will updating overwrite my content or settings?</h3>\n<p>No. Content, media, users and settings live in your database; site configuration lives in your environment variables. The update touches application code, dependencies and schema structure only.</p>\n<h3>Do I have to update every release?</h3>\n<p>No, though staying close to the latest release keeps you on security fixes and makes each jump smaller. Updates apply in sequence, so skipping several versions still lands correctly.</p>\n<h3>Can I run it in CI?</h3>\n<p>Yes &mdash; <code>npm run update -- --yes</code> never prompts, and it exits non-zero if the schema step fails so a pipeline can catch it.</p>\n<h3>What if my project has no database connection configured?</h3>\n<p>Code and dependencies still update; the schema step is skipped with a warning telling you which environment variable to set. Re-run <code>npm run update -- --db-only</code> once it is configured.</p>\n<h3>I am on the one-click Vercel deploy &mdash; do I need to run anything?</h3>\n<p>No. That path is fully automatic. The command exists for when you want an update <em>now</em> rather than at midnight, or when you are working on a local clone.</p>\n\n<div class='rounded-[2rem] border border-slate-200/80 bg-slate-50 p-8 my-12 text-center dark:border-white/10 dark:bg-white/5'>\n  <p class='mt-0 text-2xl font-semibold text-slate-900 dark:text-white'>One command, every install.</p>\n  <p class='text-sm text-slate-600 dark:text-slate-300'>New to NextBlock? Start with the install guide &mdash; then never think about upgrades again.</p>\n  <div class='mt-5 flex flex-wrap justify-center gap-3'>\n    <a href='/article/how-to-setup-nextblock' class='inline-flex items-center rounded-full bg-slate-900 px-6 py-3 text-sm font-semibold text-white no-underline shadow-lg hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200'>Read the install guide</a>\n    <a href='https://github.com/nextblock-cms/nextblock' target='_blank' rel='noopener' class='inline-flex items-center rounded-full border border-slate-300 px-6 py-3 text-sm font-semibold text-slate-700 no-underline hover:border-slate-500 dark:border-white/20 dark:text-slate-200 dark:hover:border-white/50'>View on GitHub</a>\n  </div>\n</div>"}
$nben$::jsonb, 0);
  END IF;

  ---------------------------------------------------------------------------
  -- French
  ---------------------------------------------------------------------------
  INSERT INTO public.posts (
    language_id, author_id, title, slug, label, excerpt, subtitle, status,
    published_at, meta_title, meta_description, feature_image_id, version,
    translation_group_id
  )
  SELECT
    2, NULL,
    'Les mises à jour de NextBlock : une seule commande, quelle que soit l''installation',
    'comment-fonctionnent-les-mises-a-jour',
    'Maintenance',
    'Quelle que soit votre installation — Vercel en un clic, le CLI, Docker ou un git clone — une seule commande npm run update fait avancer ensemble le code, les dépendances et le schéma de base de données.',
    'Synchronisation automatique sur Vercel, et une seule commande partout ailleurs : ce que fait npm run update, ce qu''il ne touche jamais, et comment revenir en arrière.',
    'published', now(),
    'Mettre à jour NextBlock — une commande pour toutes les installations',
    'Mettez NextBlock à jour en une étape. npm run update récupère le nouveau code, installe les dépendances et applique les migrations en attente, sur Vercel, Docker, CLI et git clone.',
    v_image, 1, v_group
  WHERE NOT EXISTS (
    SELECT 1 FROM public.posts
     WHERE language_id = 2 AND slug = 'comment-fonctionnent-les-mises-a-jour'
  );

  SELECT id INTO v_fr_post
    FROM public.posts
   WHERE language_id = 2 AND slug = 'comment-fonctionnent-les-mises-a-jour'
   ORDER BY id
   LIMIT 1;

  IF v_fr_post IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.blocks WHERE post_id = v_fr_post
  ) THEN
    INSERT INTO public.blocks (post_id, language_id, block_type, content, "order")
    VALUES (v_fr_post, 2, 'text', $nbfr$
{"html_content":"<p class='text-lg leading-8 text-slate-700 dark:text-slate-300'>NextBlock &eacute;volue en continu &mdash; nouveaux blocs, corrections de l'&eacute;diteur, correctifs de s&eacute;curit&eacute;, et parfois une modification de la base de donn&eacute;es dont le nouveau code d&eacute;pend. Suivre tout cela supposait autrefois de savoir laquelle des quatre m&eacute;thodes d'installation vous aviez utilis&eacute;e. Ce n'est plus le cas. Tout projet NextBlock, quelle que soit sa cr&eacute;ation, comprend une seule commande :</p>\n\n<div class='my-10 overflow-hidden rounded-[2rem] border border-slate-800 bg-slate-950 shadow-2xl'>\n  <div class='flex items-center gap-2 border-b border-white/10 px-5 py-3'>\n    <span class='h-3 w-3 rounded-full bg-red-400/70'></span>\n    <span class='h-3 w-3 rounded-full bg-yellow-400/70'></span>\n    <span class='h-3 w-3 rounded-full bg-green-400/70'></span>\n    <span class='ml-3 text-xs font-mono text-slate-400'>votre projet</span>\n  </div>\n  <div class='px-6 py-8 text-center'>\n    <p class='mt-0 mb-2 font-mono text-2xl sm:text-3xl font-semibold text-emerald-300'>npm run update</p>\n    <p class='mb-0 text-sm text-slate-400'>Code &middot; d&eacute;pendances &middot; sch&eacute;ma de base de donn&eacute;es &mdash; dans cet ordre, en une seule &eacute;tape.</p>\n  </div>\n</div>\n\n<p>La commande d&eacute;termine dans quel type d'installation elle s'ex&eacute;cute, choisit la bonne source pour le nouveau code, installe les d&eacute;pendances correspondantes, puis applique les migrations dont la nouvelle version a besoin. Si vous pr&eacute;f&eacute;rez regarder avant de sauter, <code>npm run update -- --check</code> indique exactement ce qui changerait sans rien modifier.</p>\n\n<h2 id='the-four-paths'>Les quatre installations et leurs mises &agrave; jour</h2>\n<p class='text-slate-600 dark:text-slate-400'>Elles correspondent une &agrave; une aux quatre options du <a href='/article/comment-configurer-nextblock'>guide d'installation</a>. La commande est la m&ecirc;me partout ; seule la provenance du nouveau code change.</p>\n\n<div class='grid gap-5 md:grid-cols-2 my-8'>\n  <a href='#vercel' class='block rounded-[1.75rem] border border-blue-200 bg-blue-50/70 p-6 no-underline transition-shadow hover:shadow-lg dark:border-blue-500/20 dark:bg-blue-500/10'>\n    <span class='flex h-9 w-9 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white'>1</span>\n    <p class='mt-4 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-blue-700 dark:text-blue-200'>Enti&egrave;rement automatique</p>\n    <h3 class='mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white'>Vercel en un clic et forks GitHub</h3>\n    <p class='mb-0 text-sm leading-6 text-slate-600 dark:text-slate-300'>Un workflow quotidien fusionne les nouveaut&eacute;s dans votre d&eacute;p&ocirc;t et Vercel red&eacute;ploie. Vous n'avez rien &agrave; faire.</p>\n  </a>\n  <a href='#docker' class='block rounded-[1.75rem] border border-amber-200 bg-amber-50/70 p-6 no-underline transition-shadow hover:shadow-lg dark:border-amber-500/20 dark:bg-amber-500/10'>\n    <span class='flex h-9 w-9 items-center justify-center rounded-full bg-amber-500 text-sm font-bold text-white'>2</span>\n    <p class='mt-4 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-amber-700 dark:text-amber-200'>Une commande</p>\n    <h3 class='mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white'>npm create nextblock &rarr; Docker</h3>\n    <p class='mb-0 text-sm leading-6 text-slate-600 dark:text-slate-300'>Mettez &agrave; jour, puis reconstruisez la pile locale. Vos volumes Postgres et m&eacute;dias restent intacts.</p>\n  </a>\n  <a href='#cloud' class='block rounded-[1.75rem] border border-violet-200 bg-violet-50/70 p-6 no-underline transition-shadow hover:shadow-lg dark:border-violet-500/20 dark:bg-violet-500/10'>\n    <span class='flex h-9 w-9 items-center justify-center rounded-full bg-violet-600 text-sm font-bold text-white'>3</span>\n    <p class='mt-4 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-violet-700 dark:text-violet-200'>Une commande</p>\n    <h3 class='mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white'>npm create nextblock &rarr; Supabase</h3>\n    <p class='mb-0 text-sm leading-6 text-slate-600 dark:text-slate-300'>Les nouveaux fichiers viennent de npm ; vos pages, routes et contenus ne sont pas touch&eacute;s.</p>\n  </a>\n  <a href='#clone' class='block rounded-[1.75rem] border border-emerald-200 bg-emerald-50/70 p-6 no-underline transition-shadow hover:shadow-lg dark:border-emerald-500/20 dark:bg-emerald-500/10'>\n    <span class='flex h-9 w-9 items-center justify-center rounded-full bg-emerald-600 text-sm font-bold text-white'>4</span>\n    <p class='mt-4 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200'>Une commande</p>\n    <h3 class='mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white'>git clone du monorepo</h3>\n    <p class='mb-0 text-sm leading-6 text-slate-600 dark:text-slate-300'>Un pull ou une fusion prot&eacute;g&eacute;e, puis les d&eacute;pendances et les migrations. Aucune &eacute;tape manuelle.</p>\n  </a>\n</div>\n\n<h2 id='vercel'>1. Vercel en un clic et forks GitHub &mdash; sans intervention</h2>\n<p>Ce chemin se met &agrave; jour tout seul. Lors du d&eacute;ploiement, NextBlock a cr&eacute;&eacute; un d&eacute;p&ocirc;t qui vous appartient ; l'&eacute;tape <strong>Connect GitHub</strong> du tableau de bord y installe un workflow qui s'ex&eacute;cute <strong>chaque jour &agrave; minuit UTC</strong> et peut aussi &ecirc;tre lanc&eacute; &agrave; la demande depuis l'onglet <strong>Actions</strong> de votre d&eacute;p&ocirc;t.</p>\n<ol class='space-y-2'>\n  <li>Le workflow fusionne la derni&egrave;re version de NextBlock dans votre branche de d&eacute;ploiement.</li>\n  <li>Une fusion propre est pouss&eacute;e sur votre branche, ce qui d&eacute;clenche un d&eacute;ploiement Vercel normal.</li>\n  <li>Pendant ce build de production, NextBlock applique les migrations en attente <em>avant</em> de construire l'application &mdash; le nouveau code ne tourne donc jamais sur un ancien sch&eacute;ma.</li>\n  <li>En cas de conflit, rien n'est pouss&eacute;. Le workflow ouvre une issue GitHub et votre tableau de bord affiche une banni&egrave;re ambre qui pointe dessus. R&eacute;solvez, fermez l'issue, et la banni&egrave;re dispara&icirc;t d'elle-m&ecirc;me.</li>\n</ol>\n<div class='rounded-3xl border border-emerald-200 bg-emerald-50/80 p-6 my-8 dark:border-emerald-500/20 dark:bg-emerald-500/10'>\n  <p class='mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200'>Rendez le d&eacute;p&ocirc;t public</p>\n  <p class='mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200'>Un d&eacute;p&ocirc;t public ne demande aucune configuration. Sur un d&eacute;p&ocirc;t priv&eacute;, ajoutez une variable d'environnement <code>NEXTBLOCK_GITHUB_TOKEN</code> avec un acc&egrave;s en lecture aux issues pour que la banni&egrave;re de conflit fonctionne &mdash; et sachez que l'offre gratuite Hobby de Vercel refuse de d&eacute;ployer automatiquement les commits automatis&eacute;s sur un d&eacute;p&ocirc;t priv&eacute;.</p>\n</div>\n<p>Vous travaillez sur un clone local de ce fork ? <code>npm run update</code> effectue la m&ecirc;me fusion sur votre machine, en ajoutant le d&eacute;p&ocirc;t <code>upstream</code> s'il manque, puis installe les d&eacute;pendances et applique les migrations.</p>\n\n<h2 id='docker'>2. npm create nextblock &rarr; Docker &mdash; mettre &agrave; jour puis reconstruire</h2>\n<p>Depuis le dossier de votre projet :</p>\n<pre><code>npm run update\nnpm run docker:up</code></pre>\n<p>La premi&egrave;re commande met &agrave; jour l'application, ses d&eacute;pendances et le sch&eacute;ma ; la seconde reconstruit et red&eacute;marre les conteneurs. Votre base de donn&eacute;es et vos m&eacute;dias vivent dans des volumes Docker et ne sont touch&eacute;s ni par l'une ni par l'autre &mdash; <code>docker:up</code> reconstruit des images, pas des donn&eacute;es.</p>\n\n<h2 id='cloud'>3. npm create nextblock &rarr; Supabase g&eacute;r&eacute; &mdash; une commande</h2>\n<pre><code>npm run update\nnpm run build\nnpm start</code></pre>\n<p>Votre projet est une application Next.js autonome : le nouveau code provient donc du paquet <code>create-nextblock</code> publi&eacute; sur npm &mdash; exactement l'artefact &agrave; partir duquel votre projet a &eacute;t&eacute; g&eacute;n&eacute;r&eacute;, versionn&eacute; en phase avec la release. NextBlock rafra&icirc;chit les fichiers qui lui appartiennent, fusionne les nouvelles versions de d&eacute;pendances dans votre <code>package.json</code>, lance <code>npm install</code>, puis applique les migrations.</p>\n<div class='rounded-3xl border border-violet-200 bg-violet-50/80 p-6 my-8 dark:border-violet-500/20 dark:bg-violet-500/10'>\n  <p class='mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-violet-700 dark:text-violet-200'>Vous d&eacute;ployez ce projet sur Vercel ?</p>\n  <p class='mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200'>Lancez <code>npm run update</code> en local, validez le r&eacute;sultat et poussez. Votre build de production applique les migrations en attente au passage, exactement comme pour les installations en un clic.</p>\n</div>\n\n<h2 id='clone'>4. Le monorepo clon&eacute; &mdash; une commande</h2>\n<pre><code>npm run update</code></pre>\n<p>Dans un clone du d&eacute;p&ocirc;t NextBlock, la commande met votre copie &agrave; jour, r&eacute;installe les d&eacute;pendances du workspace et applique les migrations en attente. Elle refuse de s'ex&eacute;cuter par-dessus des modifications non valid&eacute;es et vous explique comment les mettre de c&ocirc;t&eacute; : une mise &agrave; jour ne peut donc jamais faire dispara&icirc;tre du travail en cours. Si vous avez des commits locaux, elle s'arr&ecirc;te et vous oriente vers <code>git pull --rebase</code> plut&ocirc;t que de deviner.</p>\n\n<h2 id='what-it-does'>Ce que fait r&eacute;ellement <code>npm run update</code></h2>\n<ol class='space-y-2'>\n  <li><strong>Identifie l'installation.</strong> Monorepo ou application autonome ; bas&eacute;e sur git ou sur npm ; Docker ou non.</li>\n  <li><strong>Met &agrave; jour le code</strong> depuis la bonne source &mdash; fusion git, pull en avance rapide, ou le paquet <code>create-nextblock</code> publi&eacute;.</li>\n  <li><strong>Installe les d&eacute;pendances</strong> avec <code>npm install</code>, pour que le code et les paquets qu'il importe avancent ensemble.</li>\n  <li><strong>Rafra&icirc;chit les fichiers de migration</strong> livr&eacute;s dans <code>@nextblock-cms/db</code>, afin que les derni&egrave;res &eacute;volutions du sch&eacute;ma soient sur le disque avant toute application.</li>\n  <li><strong>Applique les migrations en attente</strong>, en les listant d'abord et en demandant confirmation.</li>\n  <li><strong>Efface la banni&egrave;re de mise &agrave; jour</strong> du tableau de bord une fois la nouvelle version r&eacute;ellement en place.</li>\n</ol>\n\n<h3>Options</h3>\n<div class='overflow-x-auto my-6'>\n<table class='w-full text-left text-sm'>\n  <thead><tr class='border-b border-slate-200 dark:border-white/10'><th class='py-3 pr-4 font-semibold'>Commande</th><th class='py-3 font-semibold'>Effet</th></tr></thead>\n  <tbody class='align-top'>\n    <tr class='border-b border-slate-100 dark:border-white/5'><td class='py-3 pr-4'><code>npm run update</code></td><td class='py-3'>Code, d&eacute;pendances et sch&eacute;ma.</td></tr>\n    <tr class='border-b border-slate-100 dark:border-white/5'><td class='py-3 pr-4'><code>npm run update -- --check</code></td><td class='py-3'>Indique ce qui changerait. N'&eacute;crit rien.</td></tr>\n    <tr class='border-b border-slate-100 dark:border-white/5'><td class='py-3 pr-4'><code>npm run update -- --yes</code></td><td class='py-3'>Sans confirmation. Pratique en CI.</td></tr>\n    <tr class='border-b border-slate-100 dark:border-white/5'><td class='py-3 pr-4'><code>npm run update -- --db-only</code></td><td class='py-3'>Applique uniquement les migrations en attente.</td></tr>\n    <tr class='border-b border-slate-100 dark:border-white/5'><td class='py-3 pr-4'><code>npm run update -- --skip-db</code></td><td class='py-3'>Met &agrave; jour le code et les d&eacute;pendances, sans toucher &agrave; la base.</td></tr>\n    <tr><td class='py-3 pr-4'><code>npm run update -- --force</code></td><td class='py-3'>S'ex&eacute;cute m&ecirc;me si vous &ecirc;tes d&eacute;j&agrave; &agrave; jour.</td></tr>\n  </tbody>\n</table>\n</div>\n\n<h2 id='database'>Ce qui arrive &agrave; votre base de donn&eacute;es</h2>\n<p>Les &eacute;volutions du sch&eacute;ma sont <strong>uniquement additives</strong>. NextBlock ne r&eacute;&eacute;crit ni ne rejoue jamais une migration d&eacute;j&agrave; appliqu&eacute;e : chacune est appliqu&eacute;e et enregistr&eacute;e dans la m&ecirc;me transaction, si bien qu'un &eacute;chec est annul&eacute; proprement et laisse la base exactement dans son &eacute;tat initial. Les migrations d&eacute;j&agrave; appliqu&eacute;es sont ignor&eacute;es par num&eacute;ro de version, ce qui rend une nouvelle ex&eacute;cution totalement s&ucirc;re.</p>\n<p>Les migrations modifient la <em>structure</em> &mdash; tables, colonnes, index, permissions. Vos pages, articles, produits, m&eacute;dias et utilisateurs vous appartiennent : la mise &agrave; jour ne les supprime ni ne les r&eacute;&eacute;crit.</p>\n<div class='rounded-3xl border border-blue-200 bg-blue-50/80 p-6 my-8 dark:border-blue-500/20 dark:bg-blue-500/10'>\n  <p class='mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-blue-700 dark:text-blue-200'>Par pr&eacute;caution</p>\n  <p class='mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200'>Avant un grand saut sur un site en production, prenez une sauvegarde de la base &mdash; Supabase en r&eacute;alise quotidiennement sur les offres payantes, et vous pouvez en d&eacute;clencher une &agrave; la demande depuis son tableau de bord. Lancez ensuite <code>npm run update -- --check</code> pour voir la liste des migrations en attente.</p>\n</div>\n\n<h2 id='safety'>En cas de probl&egrave;me</h2>\n<ul class='space-y-2'>\n  <li><strong>Projets autonomes :</strong> chaque fichier remplac&eacute; est d'abord copi&eacute; dans un dossier horodat&eacute; sous <code>.nextblock-backup/</code> dans votre projet. Rien n'est supprim&eacute; : les fichiers que vous avez ajout&eacute;s ne disparaissent jamais.</li>\n  <li><strong>Installations bas&eacute;es sur git :</strong> la mise &agrave; jour est un commit ordinaire. <code>git log</code> l'affiche et <code>git revert</code> l'annule.</li>\n  <li><strong>Une fusion en conflit</strong> est annul&eacute;e automatiquement &mdash; votre copie de travail reste intacte, avec les instructions pour r&eacute;soudre &agrave; la main.</li>\n  <li><strong>Une migration en &eacute;chec</strong> est annul&eacute;e. Corrigez la cause et relancez : rien ne reste &agrave; moiti&eacute; appliqu&eacute;.</li>\n</ul>\n<p>Si vous avez personnalis&eacute; un fichier appartenant &agrave; NextBlock &mdash; sous <code>app/</code>, <code>components/</code> ou <code>lib/</code> &mdash; la mise &agrave; jour le remplacera en sauvegardant votre version. Comparez ensuite la sauvegarde pour reporter votre modification. Les personnalisations qui vivent dans vos propres fichiers, dans le CMS ou dans <code>.env</code> ne sont jamais affect&eacute;es.</p>\n\n<h2 id='knowing'>Savoir qu'une mise &agrave; jour est disponible</h2>\n<p>Inutile de surveiller. NextBlock v&eacute;rifie en arri&egrave;re-plan pendant que vous utilisez le CMS et affiche une banni&egrave;re sur le tableau de bord d&egrave;s qu'une version plus r&eacute;cente est publi&eacute;e, en indiquant votre version actuelle et celle disponible. Les administrateurs peuvent aussi lancer <code>npm run update -- --check</code> &agrave; tout moment.</p>\n\n<h2 id='faq'>FAQ des mises &agrave; jour</h2>\n<h3>La mise &agrave; jour va-t-elle &eacute;craser mon contenu ou mes r&eacute;glages ?</h3>\n<p>Non. Contenus, m&eacute;dias, utilisateurs et r&eacute;glages vivent dans votre base de donn&eacute;es ; la configuration du site vit dans vos variables d'environnement. La mise &agrave; jour ne touche que le code, les d&eacute;pendances et la structure du sch&eacute;ma.</p>\n<h3>Dois-je installer chaque version ?</h3>\n<p>Non, mais rester proche de la derni&egrave;re version vous garantit les correctifs de s&eacute;curit&eacute; et rend chaque saut plus petit. Les migrations s'appliquent dans l'ordre : sauter plusieurs versions fonctionne malgr&eacute; tout.</p>\n<h3>Puis-je l'ex&eacute;cuter en CI ?</h3>\n<p>Oui &mdash; <code>npm run update -- --yes</code> ne pose aucune question et renvoie un code d'erreur si l'&eacute;tape sch&eacute;ma &eacute;choue, pour qu'un pipeline puisse le d&eacute;tecter.</p>\n<h3>Et si aucune connexion &agrave; la base n'est configur&eacute;e ?</h3>\n<p>Le code et les d&eacute;pendances sont tout de m&ecirc;me mis &agrave; jour ; l'&eacute;tape sch&eacute;ma est ignor&eacute;e avec un avertissement indiquant la variable d'environnement &agrave; d&eacute;finir. Relancez ensuite <code>npm run update -- --db-only</code>.</p>\n<h3>Je suis sur le d&eacute;ploiement Vercel en un clic &mdash; dois-je lancer quelque chose ?</h3>\n<p>Non. Ce chemin est enti&egrave;rement automatique. La commande existe pour mettre &agrave; jour <em>tout de suite</em> plut&ocirc;t qu'&agrave; minuit, ou lorsque vous travaillez sur un clone local.</p>\n\n<div class='rounded-[2rem] border border-slate-200/80 bg-slate-50 p-8 my-12 text-center dark:border-white/10 dark:bg-white/5'>\n  <p class='mt-0 text-2xl font-semibold text-slate-900 dark:text-white'>Une commande, toutes les installations.</p>\n  <p class='text-sm text-slate-600 dark:text-slate-300'>Vous d&eacute;butez avec NextBlock ? Commencez par le guide d'installation &mdash; puis oubliez les mises &agrave; jour.</p>\n  <div class='mt-5 flex flex-wrap justify-center gap-3'>\n    <a href='/article/comment-configurer-nextblock' class='inline-flex items-center rounded-full bg-slate-900 px-6 py-3 text-sm font-semibold text-white no-underline shadow-lg hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200'>Lire le guide d'installation</a>\n    <a href='https://github.com/nextblock-cms/nextblock' target='_blank' rel='noopener' class='inline-flex items-center rounded-full border border-slate-300 px-6 py-3 text-sm font-semibold text-slate-700 no-underline hover:border-slate-500 dark:border-white/20 dark:text-slate-200 dark:hover:border-white/50'>Voir sur GitHub</a>\n  </div>\n</div>"}
$nbfr$::jsonb, 0);
  END IF;
END
$body$;

-- Revision baseline for the two new posts.
--
-- 00000000000016 back-fills a 'snapshot' revision for every post that existed WHEN IT
-- RAN. On a fresh install migrations run in order, so 016 executes before this file and
-- these two posts would be the only ones in the CMS without a restore point. This is the
-- same projection as 016 section 3b, scoped to the two slugs.
INSERT INTO public.post_revisions (post_id, author_id, version, revision_type, content)
SELECT
    po.id,
    NULL::uuid,
    po.version,
    'snapshot'::public.revision_type,
    jsonb_build_object(
      'meta', jsonb_build_object(
        'title',            po.title,
        'slug',             po.slug,
        'language_id',      po.language_id,
        'status',           po.status,
        'meta_title',       po.meta_title,
        'meta_description', po.meta_description,
        'custom_canonical', po.custom_canonical,
        'published_at',     to_char(po.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'feature_image_id', po.feature_image_id,
        'label',            po.label,
        'excerpt',          po.excerpt,
        'subtitle',         po.subtitle
      ),
      'blocks', COALESCE((
        SELECT jsonb_agg(
                 jsonb_build_object(
                   'language_id', b.language_id,
                   'block_type',  b.block_type,
                   'content',     b.content,
                   'order',       b."order"
                 ) ORDER BY b."order" ASC, b.id ASC
               )
          FROM public.blocks b
         WHERE b.post_id = po.id
      ), '[]'::jsonb)
    )
  FROM public.posts po
 WHERE po.slug IN ('how-updating-works', 'comment-fonctionnent-les-mises-a-jour')
   AND NOT EXISTS (
         SELECT 1 FROM public.post_revisions r
          WHERE r.post_id = po.id
            AND r.revision_type = 'snapshot'
            AND r.version <= po.version
       )
ON CONFLICT (post_id, version) DO NOTHING;
$nb_file_00000000000020$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000020_updating_article.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000020_updating_article.sql

  -- >>> FROM: 00000000000021_updating_article_git_merge.sql
  IF NOT pg_temp.nb_recorded('00000000000021', '00000000000021_updating_article_git_merge') THEN
    RAISE NOTICE 'catch-up: applying 00000000000021_updating_article_git_merge.sql';
    EXECUTE $nb_file_00000000000021$
-- 00000000000021_updating_article_git_merge.sql
-- Corrects the "How Updating NextBlock Works" article seeded in 00000000000020.
--
-- That version described the standalone update as "replace the files and keep a backup
-- under .nextblock-backup/". The updater now performs a real git 3-way merge instead:
-- both template versions are committed into the project's own object database under
-- refs/nextblock/{base,head}, and the diff between them is applied with `git apply --3way`.
-- A developer's edits to framework files are preserved and only genuine overlaps conflict.
-- The copy-and-back-up path survives only as the fallback for a project with no git repo,
-- no commits, or a dirty tree.
--
-- 020 is already applied everywhere and never replays, so the copy is corrected here as
-- targeted, idempotent string replacements rather than a full re-write of the body: each
-- replace() is a no-op once the old sentence is gone, so re-running changes nothing.
-- Data-only; no schema change.

DO $body$
DECLARE
  v_en_post integer;
  v_fr_post integer;
BEGIN
  SELECT id INTO v_en_post
    FROM public.posts WHERE language_id = 1 AND slug = 'how-updating-works'
   ORDER BY id LIMIT 1;

  SELECT id INTO v_fr_post
    FROM public.posts WHERE language_id = 2 AND slug = 'comment-fonctionnent-les-mises-a-jour'
   ORDER BY id LIMIT 1;

  ---------------------------------------------------------------------------
  -- English
  ---------------------------------------------------------------------------
  IF v_en_post IS NOT NULL THEN
    UPDATE public.blocks
       SET content = jsonb_set(
             content,
             '{html_content}',
             to_jsonb(
               replace(
                 replace(
                   replace(
                     content->>'html_content',
                     -- 1. the "if something goes wrong" bullet
                     '<li><strong>Standalone projects:</strong> every framework file the update replaces is copied first into a timestamped folder under <code>.nextblock-backup/</code> in your project. Nothing is deleted, so files you added yourself are never removed.</li>',
                     '<li><strong>Standalone projects:</strong> the update is applied as a <strong>git 3-way merge</strong> into your working tree &mdash; nothing is committed for you. Review it with <code>git diff</code>, and undo the whole thing with <code>git reset --hard HEAD</code>. Nothing is ever deleted, so files you added yourself are never removed.</li>'
                   ),
                   -- 2. the "you customised a framework file" paragraph
                   '<p>If you have customised a file that NextBlock owns &mdash; something under <code>app/</code>, <code>components/</code> or <code>lib/</code> &mdash; the update will replace it and back up your version. Diff the backup afterwards to bring your change forward. Customisations that live in your own new files, in the CMS, or in <code>.env</code> are never affected.</p>',
                   '<p>If you have customised a file that NextBlock owns &mdash; something under <code>app/</code>, <code>components/</code> or <code>lib/</code> &mdash; <strong>your edit is kept</strong>. The update merges the upstream change into your version, and only a change that genuinely overlaps yours conflicts, with ordinary <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt; ours</code> / <code>&gt;&gt;&gt;&gt;&gt;&gt;&gt; theirs</code> markers. List them with <code>git diff --name-only --diff-filter=U</code> and resolve with <code>git checkout --theirs</code> or <code>--ours</code>. Customisations in your own files, in the CMS, or in <code>.env</code> are never touched at all.</p>'
                 ),
                 -- 3. the managed-cloud section
                 '<p>Your project is a standalone Next.js app, so new framework code is fetched from the published <code>create-nextblock</code> package on npm &mdash; the exact artifact your project was scaffolded from, versioned in lockstep with the release. NextBlock refreshes the files it owns, merges the new dependency versions into your <code>package.json</code>, runs <code>npm install</code>, and then applies migrations.</p>',
                 '<p>Your project is a standalone Next.js app with no upstream to pull from, so new framework code comes from the published <code>create-nextblock</code> package on npm &mdash; the exact artifact your project was scaffolded from, versioned in lockstep with the release. NextBlock fetches both your current version and the new one, and applies the difference between them as a <strong>git 3-way merge</strong>, so the update behaves exactly like a <code>git pull</code>: files you never touched update silently, files you customised keep your changes. It then merges the new dependency versions into your <code>package.json</code>, runs <code>npm install</code>, and applies migrations.</p><p>This needs a git repository with at least one commit and a clean working tree &mdash; commit your work before updating. Without that there is nothing to merge against, so the files are copied instead and anything replaced is kept under <code>.nextblock-backup/</code>.</p>'
               )
             )
           ),
           updated_at = now()
     WHERE post_id = v_en_post
       AND block_type = 'text';
  END IF;

  ---------------------------------------------------------------------------
  -- French
  ---------------------------------------------------------------------------
  IF v_fr_post IS NOT NULL THEN
    UPDATE public.blocks
       SET content = jsonb_set(
             content,
             '{html_content}',
             to_jsonb(
               replace(
                 replace(
                   replace(
                     content->>'html_content',
                     '<li><strong>Projets autonomes :</strong> chaque fichier remplac&eacute; est d''abord copi&eacute; dans un dossier horodat&eacute; sous <code>.nextblock-backup/</code> dans votre projet. Rien n''est supprim&eacute; : les fichiers que vous avez ajout&eacute;s ne disparaissent jamais.</li>',
                     '<li><strong>Projets autonomes :</strong> la mise &agrave; jour est appliqu&eacute;e comme une <strong>fusion git &agrave; trois voies</strong> dans votre copie de travail &mdash; rien n''est valid&eacute; &agrave; votre place. Examinez-la avec <code>git diff</code>, et annulez tout avec <code>git reset --hard HEAD</code>. Rien n''est jamais supprim&eacute; : les fichiers que vous avez ajout&eacute;s ne disparaissent jamais.</li>'
                   ),
                   '<p>Si vous avez personnalis&eacute; un fichier appartenant &agrave; NextBlock &mdash; sous <code>app/</code>, <code>components/</code> ou <code>lib/</code> &mdash; la mise &agrave; jour le remplacera en sauvegardant votre version. Comparez ensuite la sauvegarde pour reporter votre modification. Les personnalisations qui vivent dans vos propres fichiers, dans le CMS ou dans <code>.env</code> ne sont jamais affect&eacute;es.</p>',
                   '<p>Si vous avez personnalis&eacute; un fichier appartenant &agrave; NextBlock &mdash; sous <code>app/</code>, <code>components/</code> ou <code>lib/</code> &mdash; <strong>votre modification est conserv&eacute;e</strong>. La mise &agrave; jour fusionne le changement amont dans votre version, et seul un changement qui chevauche r&eacute;ellement le v&ocirc;tre entre en conflit, avec les marqueurs habituels <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt; ours</code> / <code>&gt;&gt;&gt;&gt;&gt;&gt;&gt; theirs</code>. Listez-les avec <code>git diff --name-only --diff-filter=U</code> et r&eacute;solvez avec <code>git checkout --theirs</code> ou <code>--ours</code>. Les personnalisations dans vos propres fichiers, dans le CMS ou dans <code>.env</code> ne sont jamais touch&eacute;es.</p>'
                 ),
                 '<p>Votre projet est une application Next.js autonome : le nouveau code provient donc du paquet <code>create-nextblock</code> publi&eacute; sur npm &mdash; exactement l''artefact &agrave; partir duquel votre projet a &eacute;t&eacute; g&eacute;n&eacute;r&eacute;, versionn&eacute; en phase avec la release. NextBlock rafra&icirc;chit les fichiers qui lui appartiennent, fusionne les nouvelles versions de d&eacute;pendances dans votre <code>package.json</code>, lance <code>npm install</code>, puis applique les migrations.</p>',
                 '<p>Votre projet est une application Next.js autonome sans d&eacute;p&ocirc;t amont &agrave; tirer : le nouveau code provient donc du paquet <code>create-nextblock</code> publi&eacute; sur npm &mdash; exactement l''artefact &agrave; partir duquel votre projet a &eacute;t&eacute; g&eacute;n&eacute;r&eacute;, versionn&eacute; en phase avec la release. NextBlock r&eacute;cup&egrave;re votre version actuelle et la nouvelle, puis applique la diff&eacute;rence entre les deux comme une <strong>fusion git &agrave; trois voies</strong> : la mise &agrave; jour se comporte donc exactement comme un <code>git pull</code> &mdash; les fichiers que vous n''avez jamais touch&eacute;s se mettent &agrave; jour silencieusement, ceux que vous avez personnalis&eacute;s conservent vos changements. Elle fusionne ensuite les nouvelles versions de d&eacute;pendances dans votre <code>package.json</code>, lance <code>npm install</code> et applique les migrations.</p><p>Cela n&eacute;cessite un d&eacute;p&ocirc;t git avec au moins un commit et une copie de travail propre &mdash; validez votre travail avant de mettre &agrave; jour. Sans cela il n''y a rien contre quoi fusionner : les fichiers sont alors copi&eacute;s et tout ce qui est remplac&eacute; est conserv&eacute; sous <code>.nextblock-backup/</code>.</p>'
               )
             )
           ),
           updated_at = now()
     WHERE post_id = v_fr_post
       AND block_type = 'text';
  END IF;
END
$body$;
$nb_file_00000000000021$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000021_updating_article_git_merge.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000021_updating_article_git_merge.sql

  -- >>> FROM: 00000000000022_updating_article_accuracy.sql
  IF NOT pg_temp.nb_recorded('00000000000022', '00000000000022_updating_article_accuracy') THEN
    RAISE NOTICE 'catch-up: applying 00000000000022_updating_article_accuracy.sql';
    EXECUTE $nb_file_00000000000022$
-- 00000000000022_updating_article_accuracy.sql
-- Three accuracy fixes to the "How Updating NextBlock Works" article
-- (seeded in 00000000000020, first corrected in 00000000000021).
--
-- 0. The merge is performed with `git merge-file`, not `git apply --3way`. The latter
--    implies --index: it stages its result (so `git diff` shows the developer nothing),
--    requires every path to be tracked (one gitignored framework path aborted the whole
--    update), and requires the worktree to match the index. merge-file touches no git
--    state at all. Consequently the resolution commands 021 shipped are wrong: there are
--    no index stages, so `git checkout --theirs/--ours` does not apply. The conflict
--    markers are ordinary text; `git checkout -- <file>` discards one file's merge.
--
-- 1. "A conflicted merge is aborted automatically" was true of only ONE path. The
--    monorepo/fork path does abort and restore the tree, because the merge belongs to
--    upstream. The standalone path deliberately LEAVES the conflict in the working tree,
--    because it is the developer's own repository and resolving it is the whole point.
--    The bullet now states both.
-- 2. The Docker section claimed `npm run update` refreshes the schema. It does not, by
--    design: the self-hosted stack ships its own migration runner (the `migrate` service
--    in docker-compose.yml, which tracks applied versions in a different table), so the
--    updater stages the SQL and hands off to `npm run docker:up` rather than applying it
--    twice through two different trackers.
--
-- Same targeted, idempotent replace() approach as 021 — a no-op once the old sentence is
-- gone. Data-only; no schema change.

DO $body$
DECLARE
  v_en_post integer;
  v_fr_post integer;
BEGIN
  SELECT id INTO v_en_post
    FROM public.posts WHERE language_id = 1 AND slug = 'how-updating-works'
   ORDER BY id LIMIT 1;

  SELECT id INTO v_fr_post
    FROM public.posts WHERE language_id = 2 AND slug = 'comment-fonctionnent-les-mises-a-jour'
   ORDER BY id LIMIT 1;

  IF v_en_post IS NOT NULL THEN
    UPDATE public.blocks
       SET content = jsonb_set(
             content,
             '{html_content}',
             to_jsonb(
               replace(
                 replace(
                   replace(
                     content->>'html_content',
                     -- 021 shipped index-based resolution commands; the merge no longer
                     -- uses the git index, so they do not apply.
                     '<strong>your edit is kept</strong>. The update merges the upstream change into your version, and only a change that genuinely overlaps yours conflicts, with ordinary <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt; ours</code> / <code>&gt;&gt;&gt;&gt;&gt;&gt;&gt; theirs</code> markers. List them with <code>git diff --name-only --diff-filter=U</code> and resolve with <code>git checkout --theirs</code> or <code>--ours</code>.',
                     '<strong>your edit is kept</strong>. The update merges the upstream change into your version, and only a change that genuinely overlaps yours conflicts &mdash; the updater lists those files, and each one carries ordinary <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt; your version</code> / <code>&gt;&gt;&gt;&gt;&gt;&gt;&gt; NextBlock</code> markers. Edit them as you would any conflict, or run <code>git checkout -- &lt;file&gt;</code> to discard the merge for that one file.'
                   ),
                   '<li><strong>A conflicted merge</strong> is aborted automatically &mdash; your working tree is left exactly as it was, with instructions printed for resolving it by hand.</li>',
                   '<li><strong>A conflict</strong> behaves differently by install, on purpose. On a fork or clone the upstream merge is <em>aborted</em> and your working tree is left exactly as it was. On a standalone project the conflict is <em>left in place</em> for you to resolve &mdash; it is your own repository, and that is the point &mdash; and <code>git reset --hard HEAD</code> backs the whole update out.</li>'
                 ),
                 '<p>The first command refreshes the application, its dependencies and the schema; the second rebuilds and restarts the containers. Your database and media live in Docker volumes and are never touched by either step &mdash; <code>docker:up</code> rebuilds images, not data.</p>',
                 '<p>The first command updates the application and its dependencies and stages the new migrations; the second rebuilds the containers <em>and applies those migrations</em>. The self-hosted stack runs its own migration service, so the updater hands the schema step to it rather than applying the same SQL through two different trackers. Your database and media live in Docker volumes and are never touched by either command &mdash; <code>docker:up</code> rebuilds images, not data.</p>'
               )
             )
           ),
           updated_at = now()
     WHERE post_id = v_en_post
       AND block_type = 'text';
  END IF;

  IF v_fr_post IS NOT NULL THEN
    UPDATE public.blocks
       SET content = jsonb_set(
             content,
             '{html_content}',
             to_jsonb(
               replace(
                 replace(
                   replace(
                     content->>'html_content',
                     '<strong>votre modification est conserv&eacute;e</strong>. La mise &agrave; jour fusionne le changement amont dans votre version, et seul un changement qui chevauche r&eacute;ellement le v&ocirc;tre entre en conflit, avec les marqueurs habituels <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt; ours</code> / <code>&gt;&gt;&gt;&gt;&gt;&gt;&gt; theirs</code>. Listez-les avec <code>git diff --name-only --diff-filter=U</code> et r&eacute;solvez avec <code>git checkout --theirs</code> ou <code>--ours</code>.',
                     '<strong>votre modification est conserv&eacute;e</strong>. La mise &agrave; jour fusionne le changement amont dans votre version, et seul un changement qui chevauche r&eacute;ellement le v&ocirc;tre entre en conflit &mdash; la commande liste ces fichiers, et chacun porte les marqueurs habituels <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt; your version</code> / <code>&gt;&gt;&gt;&gt;&gt;&gt;&gt; NextBlock</code>. Modifiez-les comme n''importe quel conflit, ou lancez <code>git checkout -- &lt;fichier&gt;</code> pour abandonner la fusion sur ce seul fichier.'
                   ),
                   '<li><strong>Une fusion en conflit</strong> est annul&eacute;e automatiquement &mdash; votre copie de travail reste intacte, avec les instructions pour r&eacute;soudre &agrave; la main.</li>',
                   '<li><strong>Un conflit</strong> se comporte diff&eacute;remment selon l''installation, volontairement. Sur un fork ou un clone, la fusion amont est <em>annul&eacute;e</em> et votre copie de travail reste intacte. Sur un projet autonome, le conflit est <em>laiss&eacute; en place</em> pour que vous le r&eacute;solviez &mdash; c''est votre d&eacute;p&ocirc;t, et c''est tout l''int&eacute;r&ecirc;t &mdash; et <code>git reset --hard HEAD</code> annule toute la mise &agrave; jour.</li>'
                 ),
                 '<p>La premi&egrave;re commande met &agrave; jour l''application, ses d&eacute;pendances et le sch&eacute;ma ; la seconde reconstruit et red&eacute;marre les conteneurs. Votre base de donn&eacute;es et vos m&eacute;dias vivent dans des volumes Docker et ne sont touch&eacute;s ni par l''une ni par l''autre &mdash; <code>docker:up</code> reconstruit des images, pas des donn&eacute;es.</p>',
                 '<p>La premi&egrave;re commande met &agrave; jour l''application et ses d&eacute;pendances et pr&eacute;pare les nouvelles migrations ; la seconde reconstruit les conteneurs <em>et applique ces migrations</em>. La pile auto-h&eacute;berg&eacute;e dispose de son propre service de migration : la mise &agrave; jour lui confie donc l''&eacute;tape sch&eacute;ma plut&ocirc;t que d''appliquer le m&ecirc;me SQL via deux suivis diff&eacute;rents. Votre base de donn&eacute;es et vos m&eacute;dias vivent dans des volumes Docker et ne sont touch&eacute;s par aucune des deux commandes &mdash; <code>docker:up</code> reconstruit des images, pas des donn&eacute;es.</p>'
               )
             )
           ),
           updated_at = now()
     WHERE post_id = v_fr_post
       AND block_type = 'text';
  END IF;
END
$body$;
$nb_file_00000000000022$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000022_updating_article_accuracy.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000022_updating_article_accuracy.sql

  -- >>> FROM: 00000000000023_updating_article_layout_not_host.sql
  IF NOT pg_temp.nb_recorded('00000000000023', '00000000000023_updating_article_layout_not_host') THEN
    RAISE NOTICE 'catch-up: applying 00000000000023_updating_article_layout_not_host.sql';
    EXECUTE $nb_file_00000000000023$
-- 00000000000023_updating_article_layout_not_host.sql
-- Corrects the most misleading claim in the "How Updating NextBlock Works" article
-- (seeded 00000000000020, corrected in 021 and 022): that the automatic GitHub Action is
-- about being deployed on Vercel.
--
-- It is not. The upstream-sync Action merges the NextBlock MONOREPO into the repository,
-- so it only works where the repository IS the monorepo — a Vercel 1-click deploy, a
-- GitHub fork, or a clone. A project scaffolded by `npm create nextblock` is the flattened
-- standalone app (app/, components/, lib/ at the root); merging apps/ + libs/ + nx.json
-- into it would wreck it. Pushing that project to GitHub and deploying it on Vercel does
-- not change its layout, so it is still a `npm run update` install. Docker is orthogonal:
-- it is how you RUN a project, not what shape the repository is.
--
-- Also documents that a merge conflict now holds the migration step back until the
-- conflict is resolved, so the schema never moves ahead of undecided code.
--
-- Targeted, idempotent replace() as in 021/022. Data-only; no schema change.

DO $body$
DECLARE
  v_en_post integer;
  v_fr_post integer;
BEGIN
  SELECT id INTO v_en_post
    FROM public.posts WHERE language_id = 1 AND slug = 'how-updating-works'
   ORDER BY id LIMIT 1;

  SELECT id INTO v_fr_post
    FROM public.posts WHERE language_id = 2 AND slug = 'comment-fonctionnent-les-mises-a-jour'
   ORDER BY id LIMIT 1;

  IF v_en_post IS NOT NULL THEN
    UPDATE public.blocks
       SET content = jsonb_set(
             content,
             '{html_content}',
             to_jsonb(
               replace(
                 replace(
                   replace(
                     content->>'html_content',
                     -- 1. The section intro: say what actually qualifies.
                     '<p>This path updates itself. When you deployed, NextBlock created a repository you own; the dashboard&rsquo;s <strong>Connect GitHub</strong> onboarding step installs a workflow into it that runs <strong>every day at midnight UTC</strong> and can also be triggered by hand from your repository&rsquo;s <strong>Actions</strong> tab.</p>',
                     '<p>This path updates itself. When you deployed, NextBlock created a repository you own; the dashboard&rsquo;s <strong>Connect GitHub</strong> onboarding step installs a workflow into it that runs <strong>every day at midnight UTC</strong> and can also be triggered by hand from your repository&rsquo;s <strong>Actions</strong> tab.</p>\n<div class=''rounded-3xl border border-slate-200 bg-slate-50 p-6 my-8 dark:border-white/10 dark:bg-white/5''>\n  <p class=''mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-slate-600 dark:text-slate-300''>What qualifies &mdash; it is the repository, not the host</p>\n  <p class=''mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200''>The workflow merges the <strong>NextBlock monorepo</strong> into your repository, so it only works where your repository <em>is</em> that monorepo: a one-click deploy, a GitHub fork, or a clone. A project created with <code>npm create nextblock</code> is the flattened standalone app &mdash; <code>app/</code>, <code>components/</code> and <code>lib/</code> at the root &mdash; and merging <code>apps/</code>, <code>libs/</code> and <code>nx.json</code> into it would wreck it. Pushing that project to GitHub and deploying it on Vercel does not change its shape: it is still an <code>npm run update</code> install, and NextBlock will not offer it this workflow. Docker is a separate question entirely &mdash; that is how you <em>run</em> a project, not what shape its repository is.</p>\n</div>'
                   ),
                   -- 2. The FAQ answer, which asked exactly the question this clarifies.
                   '<h3>I am on the one-click Vercel deploy &mdash; do I need to run anything?</h3>\n<p>No. That path is fully automatic. The command exists for when you want an update <em>now</em> rather than at midnight, or when you are working on a local clone.</p>',
                   '<h3>I am on the one-click Vercel deploy &mdash; do I need to run anything?</h3>\n<p>No. That path is fully automatic. The command exists for when you want an update <em>now</em> rather than at midnight, or when you are working on a local clone.</p>\n<h3>I deployed to Vercel, but from <code>npm create nextblock</code>. Is that automatic too?</h3>\n<p>No &mdash; and this is the distinction that catches people out. Automatic updates depend on your repository being the NextBlock <strong>monorepo</strong>, not on where the site is hosted. A project scaffolded by the CLI is the flattened standalone app whatever you deploy it to, so it updates with <code>npm run update</code>. You will not see the <strong>Connect GitHub</strong> step on that kind of install, because the workflow it installs would merge a completely different source tree into yours.</p>'
                 ),
                 -- 3. Conflicts hold the schema step.
                 '<li><strong>A failed migration</strong> rolls back. Fix the cause and re-run; nothing half-applied is left behind.</li>',
                 '<li><strong>A failed migration</strong> rolls back. Fix the cause and re-run; nothing half-applied is left behind.</li>\n  <li><strong>Unresolved conflicts hold the database back.</strong> If a merge left conflicts, the update finishes the code and dependency work but <em>stops before migrating</em> &mdash; your schema never moves ahead of code you have not finished deciding on. Resolve them and run <code>npm run update</code> again to apply the migrations, or walk away with <code>git reset --hard HEAD</code>; either way the database was never touched.</li>'
               )
             )
           ),
           updated_at = now()
     WHERE post_id = v_en_post
       AND block_type = 'text';
  END IF;

  IF v_fr_post IS NOT NULL THEN
    UPDATE public.blocks
       SET content = jsonb_set(
             content,
             '{html_content}',
             to_jsonb(
               replace(
                 replace(
                   replace(
                     content->>'html_content',
                     '<p>Ce chemin se met &agrave; jour tout seul. Lors du d&eacute;ploiement, NextBlock a cr&eacute;&eacute; un d&eacute;p&ocirc;t qui vous appartient ; l''&eacute;tape <strong>Connect GitHub</strong> du tableau de bord y installe un workflow qui s''ex&eacute;cute <strong>chaque jour &agrave; minuit UTC</strong> et peut aussi &ecirc;tre lanc&eacute; &agrave; la demande depuis l''onglet <strong>Actions</strong> de votre d&eacute;p&ocirc;t.</p>',
                     '<p>Ce chemin se met &agrave; jour tout seul. Lors du d&eacute;ploiement, NextBlock a cr&eacute;&eacute; un d&eacute;p&ocirc;t qui vous appartient ; l''&eacute;tape <strong>Connect GitHub</strong> du tableau de bord y installe un workflow qui s''ex&eacute;cute <strong>chaque jour &agrave; minuit UTC</strong> et peut aussi &ecirc;tre lanc&eacute; &agrave; la demande depuis l''onglet <strong>Actions</strong> de votre d&eacute;p&ocirc;t.</p>\n<div class=''rounded-3xl border border-slate-200 bg-slate-50 p-6 my-8 dark:border-white/10 dark:bg-white/5''>\n  <p class=''mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-slate-600 dark:text-slate-300''>Ce qui compte : le d&eacute;p&ocirc;t, pas l''h&eacute;bergeur</p>\n  <p class=''mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200''>Le workflow fusionne le <strong>monorepo NextBlock</strong> dans votre d&eacute;p&ocirc;t : il ne fonctionne donc que si votre d&eacute;p&ocirc;t <em>est</em> ce monorepo &mdash; d&eacute;ploiement en un clic, fork GitHub ou clone. Un projet cr&eacute;&eacute; avec <code>npm create nextblock</code> est l''application autonome aplatie &mdash; <code>app/</code>, <code>components/</code> et <code>lib/</code> &agrave; la racine &mdash; et y fusionner <code>apps/</code>, <code>libs/</code> et <code>nx.json</code> le casserait. Pousser ce projet sur GitHub et le d&eacute;ployer sur Vercel ne change pas sa forme : il se met toujours &agrave; jour avec <code>npm run update</code>, et NextBlock ne lui proposera pas ce workflow. Docker est une tout autre question &mdash; c''est la fa&ccedil;on d''<em>ex&eacute;cuter</em> un projet, pas la forme de son d&eacute;p&ocirc;t.</p>\n</div>'
                   ),
                   '<h3>Je suis sur le d&eacute;ploiement Vercel en un clic &mdash; dois-je lancer quelque chose ?</h3>\n<p>Non. Ce chemin est enti&egrave;rement automatique. La commande existe pour mettre &agrave; jour <em>tout de suite</em> plut&ocirc;t qu''&agrave; minuit, ou lorsque vous travaillez sur un clone local.</p>',
                   '<h3>Je suis sur le d&eacute;ploiement Vercel en un clic &mdash; dois-je lancer quelque chose ?</h3>\n<p>Non. Ce chemin est enti&egrave;rement automatique. La commande existe pour mettre &agrave; jour <em>tout de suite</em> plut&ocirc;t qu''&agrave; minuit, ou lorsque vous travaillez sur un clone local.</p>\n<h3>J''ai d&eacute;ploy&eacute; sur Vercel, mais depuis <code>npm create nextblock</code>. Est-ce automatique aussi ?</h3>\n<p>Non &mdash; et c''est la distinction qui pi&egrave;ge le plus. Les mises &agrave; jour automatiques d&eacute;pendent du fait que votre d&eacute;p&ocirc;t soit le <strong>monorepo</strong> NextBlock, pas de l''endroit o&ugrave; le site est h&eacute;berg&eacute;. Un projet g&eacute;n&eacute;r&eacute; par le CLI reste l''application autonome aplatie, quel que soit l''h&eacute;bergeur : il se met &agrave; jour avec <code>npm run update</code>. L''&eacute;tape <strong>Connect GitHub</strong> ne s''affiche pas sur ce type d''installation, car le workflow qu''elle installe fusionnerait une arborescence totalement diff&eacute;rente dans la v&ocirc;tre.</p>'
                 ),
                 '<li><strong>Une migration en &eacute;chec</strong> est annul&eacute;e. Corrigez la cause et relancez : rien ne reste &agrave; moiti&eacute; appliqu&eacute;.</li>',
                 '<li><strong>Une migration en &eacute;chec</strong> est annul&eacute;e. Corrigez la cause et relancez : rien ne reste &agrave; moiti&eacute; appliqu&eacute;.</li>\n  <li><strong>Les conflits non r&eacute;solus bloquent la base.</strong> Si une fusion a laiss&eacute; des conflits, la mise &agrave; jour termine le code et les d&eacute;pendances mais <em>s''arr&ecirc;te avant les migrations</em> &mdash; votre sch&eacute;ma ne prend jamais de l''avance sur un code que vous n''avez pas fini d''arbitrer. R&eacute;solvez-les puis relancez <code>npm run update</code> pour appliquer les migrations, ou abandonnez avec <code>git reset --hard HEAD</code> : dans les deux cas la base n''a jamais &eacute;t&eacute; touch&eacute;e.</li>'
               )
             )
           ),
           updated_at = now()
     WHERE post_id = v_fr_post
       AND block_type = 'text';
  END IF;
END
$body$;
$nb_file_00000000000023$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000023_updating_article_layout_not_host.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000023_updating_article_layout_not_host.sql

  -- >>> FROM: 00000000000024_updating_article_newline_fix.sql
  IF NOT pg_temp.nb_recorded('00000000000024', '00000000000024_updating_article_newline_fix') THEN
    RAISE NOTICE 'catch-up: applying 00000000000024_updating_article_newline_fix.sql';
    EXECUTE $nb_file_00000000000024$
-- 00000000000024_updating_article_newline_fix.sql
-- Repairs two mistakes made by 00000000000023 in the "How Updating NextBlock Works"
-- article, and lands the FAQ entry that migration failed to insert.
--
-- 1. RENDERING BUG. 023 wrote `\n` inside ordinary single-quoted SQL literals. With
--    standard_conforming_strings on (the default), that is a literal backslash followed
--    by 'n' — not a newline — so five visible "\n" sequences were stored in the article
--    body. Replaced here with real newlines via chr(10). Idempotent: once none remain,
--    replace() is a no-op.
--
-- 2. SILENT NO-MATCH. 023's FAQ replacement targeted a string spanning `</h3>\n<p>`, and
--    for the same reason the literal never matched the real newline in the stored HTML, so
--    the replacement quietly did nothing. Redone here by anchoring on the single-line <h3>
--    alone and prepending the new entry — no newline in either the search or the
--    replacement, which is the rule this file establishes for editing the article.
--
-- Data-only; no schema change.

DO $body$
DECLARE
  v_en_post integer;
  v_fr_post integer;
BEGIN
  SELECT id INTO v_en_post
    FROM public.posts WHERE language_id = 1 AND slug = 'how-updating-works'
   ORDER BY id LIMIT 1;

  SELECT id INTO v_fr_post
    FROM public.posts WHERE language_id = 2 AND slug = 'comment-fonctionnent-les-mises-a-jour'
   ORDER BY id LIMIT 1;

  IF v_en_post IS NOT NULL THEN
    UPDATE public.blocks
       SET content = jsonb_set(
             content,
             '{html_content}',
             to_jsonb(
               replace(
                 -- (1) literal backslash-n -> real newline
                 replace(content->>'html_content', E'\\n', chr(10)),
                 -- (2) the FAQ entry 023 failed to insert
                 '<h3>I am on the one-click Vercel deploy &mdash; do I need to run anything?</h3>',
                 '<h3>I deployed to Vercel, but from <code>npm create nextblock</code>. Is that automatic too?</h3><p>No &mdash; and this is the distinction that catches people out. Automatic updates depend on your repository being the NextBlock <strong>monorepo</strong>, not on where the site is hosted. A project scaffolded by the CLI is the flattened standalone app whatever you deploy it to, so it updates with <code>npm run update</code>. You will not see the <strong>Connect GitHub</strong> step on that kind of install, because the workflow it installs would merge a completely different source tree into yours.</p><h3>I am on the one-click Vercel deploy &mdash; do I need to run anything?</h3>'
               )
             )
           ),
           updated_at = now()
     WHERE post_id = v_en_post
       AND block_type = 'text';
  END IF;

  IF v_fr_post IS NOT NULL THEN
    UPDATE public.blocks
       SET content = jsonb_set(
             content,
             '{html_content}',
             to_jsonb(
               replace(
                 replace(content->>'html_content', E'\\n', chr(10)),
                 '<h3>Je suis sur le d&eacute;ploiement Vercel en un clic &mdash; dois-je lancer quelque chose ?</h3>',
                 '<h3>J''ai d&eacute;ploy&eacute; sur Vercel, mais depuis <code>npm create nextblock</code>. Est-ce automatique aussi ?</h3><p>Non &mdash; et c''est la distinction qui pi&egrave;ge le plus. Les mises &agrave; jour automatiques d&eacute;pendent du fait que votre d&eacute;p&ocirc;t soit le <strong>monorepo</strong> NextBlock, pas de l''endroit o&ugrave; le site est h&eacute;berg&eacute;. Un projet g&eacute;n&eacute;r&eacute; par le CLI reste l''application autonome aplatie, quel que soit l''h&eacute;bergeur : il se met &agrave; jour avec <code>npm run update</code>. L''&eacute;tape <strong>Connect GitHub</strong> ne s''affiche pas sur ce type d''installation, car le workflow qu''elle installe fusionnerait une arborescence totalement diff&eacute;rente dans la v&ocirc;tre.</p><h3>Je suis sur le d&eacute;ploiement Vercel en un clic &mdash; dois-je lancer quelque chose ?</h3>'
               )
             )
           ),
           updated_at = now()
     WHERE post_id = v_fr_post
       AND block_type = 'text';
  END IF;
END
$body$;
$nb_file_00000000000024$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000024_updating_article_newline_fix.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000024_updating_article_newline_fix.sql

  -- >>> FROM: 00000000000025_rebrand_nextblock_dev.sql
  IF NOT pg_temp.nb_recorded('00000000000025', '00000000000025_rebrand_nextblock_dev') THEN
    RAISE NOTICE 'catch-up: applying 00000000000025_rebrand_nextblock_dev.sql';
    EXECUTE $nb_file_00000000000025$
-- 00000000000025_rebrand_nextblock_dev.sql
-- Domain rebrand: the retired .ca domain -> nextblock.dev.
--
-- Two halves to this change, because two populations need different treatment:
--
--   Fresh installs   -- migrations 00000000000003_baseline_seed and
--                       00000000000006/007/009_home_live_demo_promo* were rewritten in place
--                       to seed nextblock.dev directly. Safe to edit despite the append-only
--                       rule: Supabase tracks migration history by version string with no
--                       checksum, so an already-applied file is never re-read or replayed.
--                       Those four are seed/content only -- no schema, no constraints.
--
--   Existing installs -- prod, sandbox, and any deployed fork already seeded the old domain
--                       from the pre-rewrite versions of those files. They never replay, so
--                       this migration corrects their data forward.
--
-- Both paths converge on nextblock.dev. On a fresh install this migration matches nothing
-- and is a no-op, which is also what makes it safe to re-run.
--
-- Also flips the sandbox demo account address. The account itself is created by
-- apps/nextblock/app/api/cron/reset-sandbox/route.ts (now 'demo@nextblock.dev'); the legacy
-- demo account is NOT removed here -- the reset route never deletes auth users and never
-- truncates public.profiles, so it must be deleted by hand in the Supabase Auth dashboard
-- or it survives as a working ADMIN.
--
-- NOTE: keep the word "sandbox" OUT of this filename -- generate-sandbox-reset.ts excludes any
-- migration whose filename contains "sandbox" from the sandbox reset bundle.

DO $body$
DECLARE
  -- Assembled from two halves on purpose: it is the one string this rebrand is meant to
  -- erase, and spelling it out here would leave the repo-wide grep with a permanent hit
  -- inside the very migration that removes it. Resolves to the retired domain at runtime.
  legacy_domain constant text := 'nextblock' || '.ca';
BEGIN
  -- 1. Seeded UI strings (e.g. the "Purchase at ..." link on the sandbox checkout panel).
  UPDATE public.translations
     SET translations = replace(translations::text, legacy_domain, 'nextblock.dev')::jsonb,
         updated_at   = now()
   WHERE translations::text LIKE '%' || legacy_domain || '%';

  -- 2. Page/post content -- the home-page "Live Demo" promo carries the demo login address.
  UPDATE public.blocks
     SET content    = replace(content::text, legacy_domain, 'nextblock.dev')::jsonb,
         updated_at = now()
   WHERE content::text LIKE '%' || legacy_domain || '%';

  -- 3. Site settings -- invoice branding on the sandbox carries the billing address.
  UPDATE public.site_settings
     SET value = replace(value::text, legacy_domain, 'nextblock.dev')::jsonb
   WHERE value::text LIKE '%' || legacy_domain || '%';
END
$body$;
$nb_file_00000000000025$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000025_rebrand_nextblock_dev.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000025_rebrand_nextblock_dev.sql

  -- >>> FROM: 00000000000026_product_inquiries.sql
  IF NOT pg_temp.nb_recorded('00000000000026', '00000000000026_product_inquiries') THEN
    RAISE NOTICE 'catch-up: applying 00000000000026_product_inquiries.sql';
    EXECUTE $nb_file_00000000000026$
-- Purchase enquiries raised when the store cannot take payment.
--
-- A NextBlock store can be fully built — products, prices, images, pages — while its
-- Stripe or Freemius credentials are still missing. Until this migration the only
-- symptom was a shopper reaching checkout and receiving the payment provider's raw
-- rejection ("Invalid API Key provided: sk_test_*ummy"), which tells them nothing and
-- loses the sale outright.
--
-- The storefront now offers those shoppers an enquiry form in place of Add-to-Cart,
-- and every submission lands here. The row is the product, not the email: SMTP is a
-- separate piece of setup that the same half-configured store has usually also not
-- done, so a notification that cannot be sent must never be the only record. The
-- `email_delivered` flag records whether the owner was successfully notified; false
-- means "read this in the CMS, nobody got a mail about it".
--
-- SECURITY POSTURE. Rows hold visitor-supplied PII (name, email, free text) plus a
-- masked IP. There is deliberately NO anon policy of any kind: anonymous visitors
-- neither read nor write this table directly. The public server action inserts with
-- the service-role client after bot-protection and throttle checks, exactly as
-- `privacy_consent_logs` does — that keeps the insert shape server-controlled and
-- means a leaked anon key cannot enumerate or seed enquiries. ADMINs read; nobody
-- else does, because these are sales leads and personal data.
--
-- `product_id` is a PLAIN uuid with NO foreign key, following site_script_revisions:
-- an enquiry is evidence that someone wanted a product, and deleting the product
-- should not delete or rewrite that evidence. `product_slug` and `product_title` are
-- denormalised so a deleted product is still identifiable in the list.
--
-- Forward-only and idempotent.

CREATE TABLE IF NOT EXISTS public.product_inquiries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    -- No FK by design (see header). Null when the product was deleted after the fact.
    product_id uuid,
    product_slug text,
    product_title text,
    sender_name text NOT NULL,
    sender_email text NOT NULL,
    message text NOT NULL,
    -- Which language the visitor was browsing in, so the owner can reply in kind.
    locale text,
    ip_masked text,
    user_agent text,
    -- False when SMTP was unconfigured or the send failed: the CMS list is then the
    -- only place this enquiry exists.
    email_delivered boolean DEFAULT false NOT NULL,
    is_resolved boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT product_inquiries_pkey PRIMARY KEY (id),
    CONSTRAINT product_inquiries_sender_name_not_blank CHECK ((char_length(btrim(sender_name)) > 0)),
    CONSTRAINT product_inquiries_sender_email_not_blank CHECK ((char_length(btrim(sender_email)) > 0)),
    CONSTRAINT product_inquiries_message_not_blank CHECK ((char_length(btrim(message)) > 0))
);

COMMENT ON TABLE public.product_inquiries IS 'Visitor purchase enquiries raised when the store cannot take payment. Written by the service role from a public server action; read by ADMINs only.';

COMMENT ON COLUMN public.product_inquiries.product_id IS 'Plain uuid, no FK: an enquiry outlives the product it was about.';

COMMENT ON COLUMN public.product_inquiries.ip_masked IS 'Partially masked IP (e.g. 203.0.113.x) - never store a full address. Also backs the per-IP submission throttle.';

COMMENT ON COLUMN public.product_inquiries.email_delivered IS 'False when the owner notification could not be sent (e.g. SMTP unconfigured); the stored row is then the only record.';

-- Newest-first is the only listing order the CMS needs.
CREATE INDEX IF NOT EXISTS product_inquiries_created_idx
    ON public.product_inquiries USING btree (created_at DESC);

-- Backs the throttle lookup in the public server action: count recent rows per IP.
CREATE INDEX IF NOT EXISTS product_inquiries_ip_created_idx
    ON public.product_inquiries USING btree (ip_masked, created_at DESC);

-- Lets the CMS count outstanding enquiries without scanning resolved history.
CREATE INDEX IF NOT EXISTS product_inquiries_unresolved_idx
    ON public.product_inquiries USING btree (created_at DESC)
    WHERE (is_resolved = false);

ALTER TABLE public.product_inquiries ENABLE ROW LEVEL SECURITY;

-- anon is deliberately absent: the public path goes through the service role.
GRANT SELECT, UPDATE ON TABLE public.product_inquiries TO authenticated;
GRANT ALL ON TABLE public.product_inquiries TO service_role;

DROP POLICY IF EXISTS product_inquiries_admin_read_policy ON public.product_inquiries;
CREATE POLICY product_inquiries_admin_read_policy ON public.product_inquiries FOR SELECT TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

-- ADMINs may only flip the resolved flag; the enquiry content itself is a record.
DROP POLICY IF EXISTS product_inquiries_admin_update_policy ON public.product_inquiries;
CREATE POLICY product_inquiries_admin_update_policy ON public.product_inquiries FOR UPDATE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role)) WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS product_inquiries_service_role_policy ON public.product_inquiries;
CREATE POLICY product_inquiries_service_role_policy ON public.product_inquiries TO service_role USING (true) WITH CHECK (true);

-- Where enquiry notifications are sent. Kept in the PUBLIC settings row rather than the
-- secret one because it is an address, not a credential — but it is never rendered to
-- the storefront: the public form posts a product id and the server resolves the
-- recipient. Empty string means "fall back", see resolveSellerContactEmail().
INSERT INTO public.site_settings (key, value)
VALUES ('store_contact', '{"contactEmail": ""}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Storefront copy for the enquiry flow. Public-facing, so it must be translatable;
-- the components pass an English literal as the fallback, so an install that never
-- runs this seed still renders correctly.
INSERT INTO public.translations (key, translations, created_at, updated_at) VALUES
    ('ecommerce.contact_seller', '{"en": "Contact the seller", "fr": "Contacter le vendeur"}', now(), now()),
    ('ecommerce.contact_seller_heading', '{"en": "Interested in this product?", "fr": "Ce produit vous intéresse ?"}', now(), now()),
    ('ecommerce.contact_seller_intro', '{"en": "Online ordering isn''t available for this item yet. Send the seller a message and they''ll get back to you about buying it.", "fr": "La commande en ligne n''est pas encore disponible pour cet article. Envoyez un message au vendeur et il vous répondra au sujet de son achat."}', now(), now()),
    ('ecommerce.contact_seller_name', '{"en": "Your name", "fr": "Votre nom"}', now(), now()),
    ('ecommerce.contact_seller_email', '{"en": "Your email", "fr": "Votre courriel"}', now(), now()),
    ('ecommerce.contact_seller_message', '{"en": "Message", "fr": "Message"}', now(), now()),
    ('ecommerce.contact_seller_send', '{"en": "Send message", "fr": "Envoyer le message"}', now(), now()),
    ('ecommerce.contact_seller_sending', '{"en": "Sending...", "fr": "Envoi..."}', now(), now()),
    ('ecommerce.contact_seller_sent', '{"en": "Thanks - your message has been sent to the seller. They''ll reply to the email address you gave.", "fr": "Merci - votre message a été envoyé au vendeur. Il répondra à l''adresse courriel que vous avez indiquée."}', now(), now()),
    ('ecommerce.contact_seller_error', '{"en": "Sorry, your message couldn''t be sent. Please try again in a moment.", "fr": "Désolé, votre message n''a pas pu être envoyé. Veuillez réessayer dans un instant."}', now(), now()),
    ('ecommerce.contact_seller_invalid', '{"en": "Please check your name, email address and message, then try again.", "fr": "Veuillez vérifier votre nom, votre adresse courriel et votre message, puis réessayer."}', now(), now()),
    ('ecommerce.contact_seller_throttled', '{"en": "You''ve sent several messages already. Please wait a few minutes before sending another.", "fr": "Vous avez déjà envoyé plusieurs messages. Veuillez patienter quelques minutes avant d''en envoyer un autre."}', now(), now()),
    ('ecommerce.not_available_for_purchase', '{"en": "Not available for online purchase", "fr": "Non disponible à l''achat en ligne"}', now(), now()),
    ('ecommerce.checkout_payments_unavailable', '{"en": "This store is not able to take payments right now. Please contact the seller to complete your purchase.", "fr": "Cette boutique ne peut pas accepter de paiements pour le moment. Veuillez contacter le vendeur pour finaliser votre achat."}', now(), now())
ON CONFLICT (key) DO NOTHING;
$nb_file_00000000000026$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000026_product_inquiries.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000026_product_inquiries.sql

  -- >>> FROM: 00000000000027_message_threads.sql
  IF NOT pg_temp.nb_recorded('00000000000027', '00000000000027_message_threads') THEN
    RAISE NOTICE 'catch-up: applying 00000000000027_message_threads.sql';
    EXECUTE $nb_file_00000000000027$
-- Private conversations with anonymous visitors, and the end of the exposed form address.
--
-- Two problems, one shape.
--
-- FIRST: a contact-form block stores its destination address in the block's own
-- content, and `FormBlockRenderer` is a "use client" component that receives that
-- content wholesale. Everything crossing that boundary is serialized into the RSC
-- payload, so the shop owner's inbox is published in the markup of every page
-- carrying a form. `form_endpoints` moves the address server-side and leaves behind a
-- `form_key` — an opaque handle that grants nothing and is safe to serialize.
--
-- SECOND: a visitor who sends a message has nowhere to receive an answer. They are
-- anonymous — `cms_interactions` cannot hold them, because its `user_id` is NOT NULL
-- with a foreign key to `profiles`. So this is a separate lane: `message_threads` plus
-- `thread_messages`, reached by a tokenised link rather than an account.
--
-- WHY REVIEWS AND COMMENTS ARE NOT HERE. They are already public, already tied to a
-- registered account, and a staff answer to them is published content, not a private
-- reply. That lane stays in `cms_interactions` and is handled by migration 28. One
-- inbox reads both; the storage stays honest about the difference.
--
-- SECURITY POSTURE. Rows hold visitor PII (name, email, free text) and a masked IP.
-- There is NO anon grant and NO anon policy: the tokenised visitor page verifies the
-- token in application code and then reads with the service role, the same posture the
-- MCP token route takes against `mcp_access_tokens`. ADMINs read; nobody else does.
--
-- `token_hash` stores only a SHA-256 of the visitor's token. The plaintext exists long
-- enough to be placed in one outbound email and is never written down. A token is
-- minted on the FIRST ADMIN REPLY, never at submission — a store that receives a
-- hundred enquiries and answers three has three live credentials, not a hundred.
--
-- `source` is a text column with a CHECK rather than an enum, deliberately.
-- `interaction_type` in this same schema is the cautionary tale: a two-value enum
-- guarded by an exhaustive CHECK, where adding a third value needs ALTER TYPE ... ADD
-- VALUE — and PostgreSQL forbids using a value added in the transaction that added it,
-- which is exactly one migration file. A CHECK is replaceable in one statement.
--
-- Forward-only and idempotent.

-- ---------------------------------------------------------------------------
-- 1. form_endpoints — where a contact-form block's mail goes, and what its fields
--    are called. `fields` is a SERVER-SIDE snapshot of the field manifest so the
--    notification email renders labels the browser did not supply; the same rule
--    the product-enquiry action follows when it looks the product title up itself.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.form_endpoints (
    form_key uuid NOT NULL,
    label text DEFAULT 'Contact form' NOT NULL,
    -- NULL/empty means "fall back to the resolver ladder", like store_contact.
    recipient_email text,
    fields jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT form_endpoints_pkey PRIMARY KEY (form_key),
    CONSTRAINT form_endpoints_label_not_blank CHECK ((char_length(btrim(label)) > 0)),
    CONSTRAINT form_endpoints_fields_array CHECK ((jsonb_typeof(fields) = 'array'))
);

COMMENT ON TABLE public.form_endpoints IS 'Server-side destination and field manifest for a contact-form block, keyed by the non-secret form_key carried in block content. The address never reaches the browser.';

COMMENT ON COLUMN public.form_endpoints.form_key IS 'Non-secret opaque handle. Safe in the RSC payload: it grants nothing, it is only a lookup key.';

COMMENT ON COLUMN public.form_endpoints.fields IS 'Snapshot of [{temp_id,label,field_type}] written by the CMS editor, so labels in emails and the inbox are server-trusted.';

DROP TRIGGER IF EXISTS set_form_endpoints_updated_at ON public.form_endpoints;
CREATE TRIGGER set_form_endpoints_updated_at BEFORE UPDATE ON public.form_endpoints
    FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

ALTER TABLE public.form_endpoints ENABLE ROW LEVEL SECURITY;

-- anon deliberately absent: the public submit path goes through the service role.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.form_endpoints TO authenticated;
GRANT ALL ON TABLE public.form_endpoints TO service_role;

DROP POLICY IF EXISTS form_endpoints_editor_read_policy ON public.form_endpoints;
CREATE POLICY form_endpoints_editor_read_policy ON public.form_endpoints FOR SELECT TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role])));

DROP POLICY IF EXISTS form_endpoints_admin_write_policy ON public.form_endpoints;
CREATE POLICY form_endpoints_admin_write_policy ON public.form_endpoints FOR ALL TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role)) WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS form_endpoints_service_role_policy ON public.form_endpoints;
CREATE POLICY form_endpoints_service_role_policy ON public.form_endpoints TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 2. message_threads — the private-lane spine and the only home of a thread token.
--    `subject_id` and `form_key` are PLAIN uuids with NO foreign key: a conversation
--    outlives the product or the form block it started from.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.message_threads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source text NOT NULL,
    -- product_inquiries.id when source = 'product_inquiry'.
    subject_id uuid,
    -- form_endpoints.form_key when source = 'contact_form'.
    form_key uuid,
    -- Denormalised so a deleted product or removed form block stays identifiable.
    subject_label text DEFAULT 'Message' NOT NULL,
    sender_name text,
    -- NULL when a contact form collected no email field. Such a thread can never be
    -- answered, and the CMS says so rather than failing silently at reply time.
    sender_email text,
    locale text,
    -- Submitted field map for a contact form: {temp_id: value}.
    fields jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'open' NOT NULL,
    unread_for_admin boolean DEFAULT true NOT NULL,
    unread_for_visitor boolean DEFAULT false NOT NULL,
    -- SHA-256 hex of the visitor's token; NULL until the first admin reply.
    token_hash text,
    token_expires_at timestamp with time zone,
    token_revoked_at timestamp with time zone,
    token_last_used_at timestamp with time zone,
    last_message_at timestamp with time zone DEFAULT now() NOT NULL,
    ip_masked text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT message_threads_pkey PRIMARY KEY (id),
    CONSTRAINT message_threads_token_hash_key UNIQUE (token_hash),
    CONSTRAINT message_threads_source_check
        CHECK ((source = ANY (ARRAY['product_inquiry'::text, 'contact_form'::text]))),
    CONSTRAINT message_threads_status_check
        CHECK ((status = ANY (ARRAY['open'::text, 'closed'::text]))),
    CONSTRAINT message_threads_subject_check CHECK (
        (((source = 'product_inquiry'::text) AND (subject_id IS NOT NULL)) OR
         ((source = 'contact_form'::text) AND (form_key IS NOT NULL)))),
    CONSTRAINT message_threads_fields_object CHECK ((jsonb_typeof(fields) = 'object'))
);

COMMENT ON TABLE public.message_threads IS 'Private conversations with anonymous visitors (product enquiries and contact-form submissions). Written by the service role from public server actions; read by ADMINs only. Public reviews and comments are NOT here - they live in cms_interactions.';

COMMENT ON COLUMN public.message_threads.token_hash IS 'SHA-256 hex of the visitor thread token. The raw token is never stored; it is minted on the first admin reply and mailed once.';

COMMENT ON COLUMN public.message_threads.subject_id IS 'product_inquiries.id. Plain uuid, no FK: a conversation outlives the enquiry record it grew from.';

CREATE INDEX IF NOT EXISTS message_threads_last_message_idx
    ON public.message_threads USING btree (last_message_at DESC);

CREATE INDEX IF NOT EXISTS message_threads_source_last_idx
    ON public.message_threads USING btree (source, last_message_at DESC);

-- Backs the CMS nav unread badge without scanning read history.
CREATE INDEX IF NOT EXISTS message_threads_unread_idx
    ON public.message_threads USING btree (last_message_at DESC)
    WHERE (unread_for_admin = true);

-- Idempotent backfill / dedupe of enquiry threads.
CREATE INDEX IF NOT EXISTS message_threads_subject_idx
    ON public.message_threads USING btree (subject_id) WHERE (subject_id IS NOT NULL);

-- No separate token index: message_threads_token_hash_key is already the unique
-- btree the /thread lookup probes.

DROP TRIGGER IF EXISTS set_message_threads_updated_at ON public.message_threads;
CREATE TRIGGER set_message_threads_updated_at BEFORE UPDATE ON public.message_threads
    FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

ALTER TABLE public.message_threads ENABLE ROW LEVEL SECURITY;

GRANT SELECT, UPDATE ON TABLE public.message_threads TO authenticated;
GRANT ALL ON TABLE public.message_threads TO service_role;

DROP POLICY IF EXISTS message_threads_admin_read_policy ON public.message_threads;
CREATE POLICY message_threads_admin_read_policy ON public.message_threads FOR SELECT TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS message_threads_admin_update_policy ON public.message_threads;
CREATE POLICY message_threads_admin_update_policy ON public.message_threads FOR UPDATE TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role)) WITH CHECK ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS message_threads_service_role_policy ON public.message_threads;
CREATE POLICY message_threads_service_role_policy ON public.message_threads TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 3. thread_messages — one turn of a private conversation.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.thread_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    thread_id uuid NOT NULL,
    direction text NOT NULL,
    body text NOT NULL,
    -- profiles.id for an outbound reply. No FK: a departing admin must not take the
    -- conversation with them.
    author_id uuid,
    author_name text,
    -- False when SMTP was unconfigured or the send failed. sendEmail() throws when
    -- unconfigured, so this row - not the mail - is the record.
    email_delivered boolean DEFAULT false NOT NULL,
    email_error text,
    ip_masked text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT thread_messages_pkey PRIMARY KEY (id),
    CONSTRAINT thread_messages_direction_check
        CHECK ((direction = ANY (ARRAY['inbound'::text, 'outbound'::text]))),
    CONSTRAINT thread_messages_body_not_blank CHECK ((char_length(btrim(body)) > 0))
);

COMMENT ON TABLE public.thread_messages IS 'Turns of a private conversation. Content is append-only; only the delivery flags may change after insert.';

-- A real foreign key here, unlike the outward pointers above: a message has no
-- meaning without its thread.
DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'thread_messages_thread_id_fkey'
                   AND conrelid = 'public.thread_messages'::regclass) THEN
    ALTER TABLE ONLY public.thread_messages
      ADD CONSTRAINT thread_messages_thread_id_fkey FOREIGN KEY (thread_id)
      REFERENCES public.message_threads(id) ON DELETE CASCADE;
  END IF;
END $rb$;

CREATE INDEX IF NOT EXISTS thread_messages_thread_created_idx
    ON public.thread_messages USING btree (thread_id, created_at);

-- Backs the per-IP reply throttle on the public thread page.
CREATE INDEX IF NOT EXISTS thread_messages_ip_created_idx
    ON public.thread_messages USING btree (ip_masked, created_at DESC);

-- Message TEXT is append-only — not the whole row, because email_delivered has to be
-- settable after the send completes. The trigger blocks rewrites of the load-bearing
-- columns only, and it binds the service role too, which otherwise bypasses RLS.
CREATE OR REPLACE FUNCTION public.prevent_thread_message_rewrite() RETURNS trigger
    LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'thread_messages is append-only; DELETE is not permitted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.body IS DISTINCT FROM OLD.body
     OR NEW.direction IS DISTINCT FROM OLD.direction
     OR NEW.thread_id IS DISTINCT FROM OLD.thread_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'thread_messages content is append-only; only delivery flags may change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_thread_messages_append_only ON public.thread_messages;
CREATE TRIGGER trg_thread_messages_append_only BEFORE UPDATE OR DELETE ON public.thread_messages
    FOR EACH ROW EXECUTE FUNCTION public.prevent_thread_message_rewrite();

-- NB: the ON DELETE CASCADE above fires this trigger, so deleting a thread is
-- impossible by design. "Delete" in the CMS means status='closed' plus a revoked
-- token, and the UI says so.

ALTER TABLE public.thread_messages ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON TABLE public.thread_messages TO authenticated;
GRANT ALL ON TABLE public.thread_messages TO service_role;

DROP POLICY IF EXISTS thread_messages_admin_read_policy ON public.thread_messages;
CREATE POLICY thread_messages_admin_read_policy ON public.thread_messages FOR SELECT TO authenticated USING ((( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS thread_messages_service_role_policy ON public.thread_messages;
CREATE POLICY thread_messages_service_role_policy ON public.thread_messages TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 4. Backfill: every existing enquiry becomes a thread whose first inbound turn is
--    the original message. product_inquiries is KEPT and kept written — it is the
--    enquiry's own record and owns the ip_masked the submission throttle counts.
--    The thread is a conversation ABOUT the enquiry, not a replacement for it.
-- ---------------------------------------------------------------------------
INSERT INTO public.message_threads
  (source, subject_id, subject_label, sender_name, sender_email, locale,
   ip_masked, user_agent, unread_for_admin, status, last_message_at, created_at)
SELECT 'product_inquiry', i.id, COALESCE(i.product_title, 'Product enquiry'),
       i.sender_name, i.sender_email, i.locale, i.ip_masked, i.user_agent,
       NOT i.is_resolved, CASE WHEN i.is_resolved THEN 'closed' ELSE 'open' END,
       i.created_at, i.created_at
FROM public.product_inquiries i
WHERE NOT EXISTS (SELECT 1 FROM public.message_threads t WHERE t.subject_id = i.id);

INSERT INTO public.thread_messages (thread_id, direction, body, email_delivered, ip_masked, created_at)
SELECT t.id, 'inbound', i.message, i.email_delivered, i.ip_masked, i.created_at
FROM public.product_inquiries i
JOIN public.message_threads t ON t.subject_id = i.id
WHERE NOT EXISTS (SELECT 1 FROM public.thread_messages m WHERE m.thread_id = t.id);

-- ---------------------------------------------------------------------------
-- 5. The form-block data migration.
--    Rewrites every stored form block: mints a form_key, moves recipient_email into
--    form_endpoints, snapshots the field manifest, and DELETES recipient_email from
--    the jsonb. Three shapes have to be handled, because a form nested inside a
--    section has no blocks row of its own — it lives in the section's content:
--      a) blocks.content where block_type = 'form'
--      b) blocks.content where block_type = 'section' (column_blocks, slides)
--      c) content_drafts.blocks / product_drafts.blocks (jsonb arrays of snapshots)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.nb_migrate_form_columns(p_cols jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path = '' AS $fn$
DECLARE v_col jsonb; v_blk jsonb; v_new_cols jsonb := '[]'::jsonb; v_new_col jsonb;
BEGIN
  FOR v_col IN SELECT * FROM jsonb_array_elements(p_cols) LOOP
    v_new_col := '[]'::jsonb;
    FOR v_blk IN SELECT * FROM jsonb_array_elements(coalesce(v_col, '[]'::jsonb)) LOOP
      v_new_col := v_new_col || jsonb_build_array(
        v_blk || jsonb_build_object('content', public.nb_migrate_form_content(v_blk->'content')));
    END LOOP;
    v_new_cols := v_new_cols || jsonb_build_array(v_new_col);
  END LOOP;
  RETURN v_new_cols;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.nb_migrate_form_content(p_content jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path = '' AS $fn$
DECLARE
  v_key uuid; v_email text; v_fields jsonb; v_slide jsonb; v_new_slides jsonb;
BEGIN
  IF p_content IS NULL OR jsonb_typeof(p_content) <> 'object' THEN
    RETURN p_content;
  END IF;

  -- Leaf: this object IS a form block's content.
  IF (p_content ? 'recipient_email') AND (p_content ? 'fields') THEN
    v_key   := gen_random_uuid();
    v_email := nullif(btrim(coalesce(p_content->>'recipient_email','')), '');
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'temp_id', f->>'temp_id', 'label', f->>'label', 'field_type', f->>'field_type')), '[]'::jsonb)
      INTO v_fields
      FROM jsonb_array_elements(coalesce(p_content->'fields', '[]'::jsonb)) f;
    INSERT INTO public.form_endpoints (form_key, label, recipient_email, fields)
    VALUES (v_key, 'Contact form', v_email, v_fields)
    ON CONFLICT (form_key) DO NOTHING;
    RETURN (p_content - 'recipient_email') || jsonb_build_object('form_key', v_key::text);
  END IF;

  -- Container: a section's slides, each with column_blocks.
  IF (p_content ? 'slides') AND jsonb_typeof(p_content->'slides') = 'array' THEN
    v_new_slides := '[]'::jsonb;
    FOR v_slide IN SELECT * FROM jsonb_array_elements(p_content->'slides') LOOP
      v_new_slides := v_new_slides || jsonb_build_array(
        v_slide || jsonb_build_object('column_blocks',
          public.nb_migrate_form_columns(coalesce(v_slide->'column_blocks','[]'::jsonb))));
    END LOOP;
    p_content := p_content || jsonb_build_object('slides', v_new_slides);
  END IF;

  -- Container: a standard section's column_blocks.
  IF (p_content ? 'column_blocks') AND jsonb_typeof(p_content->'column_blocks') = 'array' THEN
    p_content := p_content || jsonb_build_object('column_blocks',
      public.nb_migrate_form_columns(p_content->'column_blocks'));
  END IF;

  RETURN p_content;
END;
$fn$;

-- The LIKE guard keeps this from rewriting (and bumping updated_at on) every block.
UPDATE public.blocks
   SET content = public.nb_migrate_form_content(content)
 WHERE content::text LIKE '%recipient_email%';

UPDATE public.content_drafts d
   SET blocks = (SELECT coalesce(jsonb_agg(b || jsonb_build_object(
                          'content', public.nb_migrate_form_content(b->'content'))), '[]'::jsonb)
                 FROM jsonb_array_elements(d.blocks) b)
 WHERE d.blocks::text LIKE '%recipient_email%';

UPDATE public.product_drafts d
   SET blocks = (SELECT coalesce(jsonb_agg(b || jsonb_build_object(
                          'content', public.nb_migrate_form_content(b->'content'))), '[]'::jsonb)
                 FROM jsonb_array_elements(d.blocks) b)
 WHERE d.blocks::text LIKE '%recipient_email%';

-- One-shot helpers. Dropping them keeps the public schema (and db:types) clean.
DROP FUNCTION IF EXISTS public.nb_migrate_form_content(jsonb);
DROP FUNCTION IF EXISTS public.nb_migrate_form_columns(jsonb);

-- ---------------------------------------------------------------------------
-- 6. Seeds. Thread-page copy is public-facing so it must be translatable; the
--    components pass an English literal as the fallback, so an install that never
--    runs this seed still renders correctly.
-- ---------------------------------------------------------------------------
INSERT INTO public.site_settings (key, value)
VALUES ('forms_contact', '{"contactEmail": ""}'::jsonb)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.translations (key, translations, created_at, updated_at) VALUES
  ('thread.heading', '{"en": "Your conversation", "fr": "Votre conversation"}', now(), now()),
  ('thread.reply_label', '{"en": "Write a reply", "fr": "Écrire une réponse"}', now(), now()),
  ('thread.send', '{"en": "Send reply", "fr": "Envoyer la réponse"}', now(), now()),
  ('thread.sending', '{"en": "Sending...", "fr": "Envoi..."}', now(), now()),
  ('thread.sent', '{"en": "Thanks - your reply has been sent.", "fr": "Merci - votre réponse a été envoyée."}', now(), now()),
  ('thread.error', '{"en": "Sorry, your reply couldn''t be sent. Please try again in a moment.", "fr": "Désolé, votre réponse n''a pas pu être envoyée. Veuillez réessayer dans un instant."}', now(), now()),
  ('thread.throttled', '{"en": "You''ve sent several replies already. Please wait a few minutes.", "fr": "Vous avez déjà envoyé plusieurs réponses. Veuillez patienter quelques minutes."}', now(), now()),
  ('thread.closed', '{"en": "This conversation has been closed.", "fr": "Cette conversation est fermée."}', now(), now()),
  ('thread.invalid', '{"en": "This link has expired or is no longer valid. If you still need help, please contact us again from our website.", "fr": "Ce lien a expiré ou n''est plus valide. Si vous avez encore besoin d''aide, contactez-nous de nouveau depuis notre site."}', now(), now()),
  ('thread.you', '{"en": "You", "fr": "Vous"}', now(), now()),
  ('forms.submission_stored', '{"en": "Thanks - your message has been received.", "fr": "Merci - votre message a bien été reçu."}', now(), now())
ON CONFLICT (key) DO NOTHING;
$nb_file_00000000000027$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000027_message_threads.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000027_message_threads.sql

  -- >>> FROM: 00000000000028_interaction_replies.sql
  IF NOT pg_temp.nb_recorded('00000000000028', '00000000000028_interaction_replies') THEN
    RAISE NOTICE 'catch-up: applying 00000000000028_interaction_replies.sql';
    EXECUTE $nb_file_00000000000028$
-- Staff replies on reviews and post comments, and the indexes cms_interactions never had.
--
-- WHY THIS IS A DIFFERENT SHAPE FROM MIGRATION 27, AND WHY IT NEEDS NO TOKEN.
-- `cms_interactions.user_id` is NOT NULL with a foreign key to `profiles`: every review
-- and comment already comes from a signed-in account with a reachable address, and the
-- content already renders publicly on /product/{slug} and /article/{slug}. A staff
-- answer there is PUBLISHED CONTENT plus moderation, not a private conversation.
-- Routing it through the tokenised thread page would hide a public reply behind a
-- secret link. So: one inbox in the CMS, two storage models underneath.
--
-- THE ONE CONSTRAINT THAT DICTATES THE MODELLING.
-- `check_rating_only_for_review` is an exhaustive OR over ('review','comment'):
--     (type='review' AND rating IS NOT NULL AND rating BETWEEN 1 AND 5)
--  OR (type='comment' AND rating IS NULL)
-- A type='review' row with a NULL rating is rejected, so a reply to a review cannot be
-- a 'review' row. Adding a 'reply' value to interaction_type would ALSO violate it —
-- the OR covers no third value — and PostgreSQL forbids using an enum value in the
-- transaction that added it, which is exactly one migration file.
--
-- THEREFORE a reply is a `type='comment'` row carrying the PARENT's target and a NULL
-- rating: a combination the existing constraints already accept, unchanged. The bonus
-- is decisive — `update_product_ratings()` aggregates only
--   WHERE product_id = ? AND type='review' AND status='approved'
-- so a reply can never move products.average_rating or products.total_reviews. The new
-- CHECK below pins that invariant in the schema instead of trusting the action to
-- remember it.
--
-- No new policies are needed. `cms_interactions_insert_policy` already admits an
-- ADMIN/WRITER self-insert with status='approved'
--   (auth.uid() = user_id AND (status='pending' OR role IN ('ADMIN','WRITER')))
-- which is precisely a published staff reply.
--
-- Forward-only and idempotent.

ALTER TABLE public.cms_interactions ADD COLUMN IF NOT EXISTS parent_id uuid;

COMMENT ON COLUMN public.cms_interactions.parent_id IS 'Set on a staff reply: points at the review or comment being answered. Replies are always type=comment with a NULL rating, and carry the parent''s product_id/post_id so check_product_or_post still holds.';

DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'cms_interactions_parent_id_fkey'
                   AND conrelid = 'public.cms_interactions'::regclass) THEN
    ALTER TABLE ONLY public.cms_interactions
      ADD CONSTRAINT cms_interactions_parent_id_fkey FOREIGN KEY (parent_id)
      REFERENCES public.cms_interactions(id) ON DELETE CASCADE;
  END IF;
END $rb$;

-- One level only, never itself, no rating, always a comment. Keeps the reply
-- invisible to the ratings trigger and to the existing storefront review query.
DO $rb$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'cms_interactions_reply_check'
                   AND conrelid = 'public.cms_interactions'::regclass) THEN
    ALTER TABLE public.cms_interactions
      ADD CONSTRAINT cms_interactions_reply_check CHECK (
        ((parent_id IS NULL) OR
         ((parent_id <> id) AND (rating IS NULL) AND (type = 'comment'::public.interaction_type))));
  END IF;
END $rb$;

-- Fetch every reply for a page of parents in one probe.
CREATE INDEX IF NOT EXISTS cms_interactions_parent_idx
    ON public.cms_interactions USING btree (parent_id, created_at)
    WHERE (parent_id IS NOT NULL);

-- cms_interactions has had ZERO secondary indexes since the baseline, while both
-- public renderers filter on exactly these predicates on every product and article
-- page. The inbox multiplies read volume on this table, so they go in now.
CREATE INDEX IF NOT EXISTS cms_interactions_product_type_status_idx
    ON public.cms_interactions USING btree (product_id, type, status, created_at DESC)
    WHERE (product_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS cms_interactions_post_type_status_idx
    ON public.cms_interactions USING btree (post_id, type, status, created_at DESC)
    WHERE (post_id IS NOT NULL);

-- Inbox listing: newest top-level items, replies excluded.
CREATE INDEX IF NOT EXISTS cms_interactions_inbox_idx
    ON public.cms_interactions USING btree (created_at DESC)
    WHERE (parent_id IS NULL);

INSERT INTO public.translations (key, translations, created_at, updated_at) VALUES
  ('interactions.staff_reply', '{"en": "Reply from the team", "fr": "Réponse de l''équipe"}', now(), now()),
  ('interactions.staff_badge', '{"en": "Staff", "fr": "Équipe"}', now(), now())
ON CONFLICT (key) DO NOTHING;
$nb_file_00000000000028$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000028_interaction_replies.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000028_interaction_replies.sql

  -- >>> FROM: 00000000000029_form_endpoints_default_empty.sql
  IF NOT pg_temp.nb_recorded('00000000000029', '00000000000029_form_endpoints_default_empty') THEN
    RAISE NOTICE 'catch-up: applying 00000000000029_form_endpoints_default_empty.sql';
    EXECUTE $nb_file_00000000000029$
-- A contact form has no address of its own by default.
--
-- The starter content ships a contact page addressed to `contact@example.com`, and
-- migration 27 faithfully carried that placeholder into `form_endpoints`. Faithful was
-- the wrong call. `example.com` is reserved by RFC 2606 precisely so it can never be
-- registered, so the address is not merely unhelpful — it is guaranteed undeliverable,
-- while looking like a real setting to every layer downstream. The visitor is thanked,
-- the relay accepts the message, and nobody is ever notified. Nothing errors, so an
-- install can run that way indefinitely.
--
-- Since the messaging system arrived, a per-form address is not something an operator
-- needs to think about at all. Submissions are stored as threads and answered in
-- CMS → Messages; the notification address is a single site-wide setting, and a form
-- only carries its own address when someone deliberately wants that form routed
-- elsewhere (a careers form to HR, say).
--
-- So the default becomes NULL, meaning "use the site contact address", which resolves
-- to the address set in CMS → Messages and finally to the first admin's own login. An
-- install therefore reaches a real human out of the box without configuring anything.
--
-- The sandbox is unaffected: `resolveFormRecipient` overrides everything with
-- SANDBOX_CONTACT_EMAIL when NEXT_PUBLIC_IS_SANDBOX is set, so the hosted demo keeps
-- routing to the operator's own inbox without storing an address here.
--
-- Forward-only and idempotent.

-- Reserved domains from RFC 2606 / RFC 6761. Matching on the domain rather than the
-- exact seeded string also catches an operator who typed their own placeholder.
UPDATE public.form_endpoints
   SET recipient_email = NULL
 WHERE recipient_email IS NOT NULL
   AND (
     lower(recipient_email) LIKE '%@example.com'
     OR lower(recipient_email) LIKE '%@example.org'
     OR lower(recipient_email) LIKE '%@example.net'
     OR lower(recipient_email) LIKE '%@example.edu'
     OR lower(recipient_email) LIKE '%.example'
     OR lower(recipient_email) LIKE '%.invalid'
     OR lower(recipient_email) LIKE '%.test'
     OR lower(recipient_email) LIKE '%.localhost'
     OR lower(recipient_email) LIKE '%.local'
   );

COMMENT ON COLUMN public.form_endpoints.recipient_email IS 'Per-form override. NULL means "use the site contact address" (CMS -> Messages, falling back to the first admin), which is the default and the usual case.';

-- Same reasoning for the site-wide rows: a placeholder there is worse than an empty
-- value, because an empty one falls through to the first admin and actually arrives.
UPDATE public.site_settings
   SET value = jsonb_set(value, '{contactEmail}', '""'::jsonb)
 WHERE key IN ('forms_contact', 'store_contact')
   AND value ? 'contactEmail'
   AND lower(value->>'contactEmail') LIKE '%@example.%';
$nb_file_00000000000029$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000029_form_endpoints_default_empty.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000029_form_endpoints_default_empty.sql

  -- >>> FROM: 00000000000030_seo_redirects_and_robots.sql
  IF NOT pg_temp.nb_recorded('00000000000030', '00000000000030_seo_redirects_and_robots') THEN
    RAISE NOTICE 'catch-up: applying 00000000000030_seo_redirects_and_robots.sql';
    EXECUTE $nb_file_00000000000030$
-- SEO engine: managed 301/302 redirects and operator-configurable robots directives.
--
-- Two unrelated-looking things ship in one migration because they are the same
-- feature from an operator's point of view: the `/cms/settings/seo` screen is where
-- someone goes to say "this URL moved" and "do not crawl that". Splitting them
-- across two migrations would only mean two files that must always be applied
-- together.
--
-- WHY A TABLE AND NOT next.config.js redirects(). Redirects are content, not
-- configuration. An editor who renames a page's slug needs the old URL to keep
-- working immediately, without a redeploy and without touching source control.
-- That rules out the build-time array; it has to be data.
--
-- WHY THE PROXY READS THIS WITH THE ANON KEY. apps/nextblock/proxy.ts (Next 16's
-- renamed middleware) resolves redirects before rendering, and it holds a Supabase
-- client built from the anon key. So the public SELECT policy below is load-bearing:
-- without an explicit `TO authenticated, anon` grant the proxy's lookup would return
-- zero rows for every anonymous visitor -- silently, with no error -- and no redirect
-- would ever fire. Only is_active rows are exposed, so a half-written rule is never
-- live.
--
-- WHY status_code IS AN integer AND NOT AN ENUM. The same reasoning migration 27
-- recorded for `source`: a Postgres enum cannot be extended and used inside the same
-- transaction, which is exactly the scope of one migration file. A CHECK constraint
-- is replaceable in a single statement. 301 and 302 are the only two values the
-- admin UI offers; 307/308 are deliberately not exposed, because their
-- method-preserving semantics surprise operators who just want "this page moved".
--
-- LOOP SAFETY is enforced in application code (wouldCreateLoop in
-- @nextblock-cms/utils, called by the admin server actions) rather than by a
-- constraint, because detecting a cycle requires walking the whole table and a CHECK
-- constraint can only see one row. The self-redirect case IS cheap to check per row,
-- so that one is a constraint -- it is the cycle operators actually hit.
--
-- SECURITY POSTURE. A redirect can send every visitor of a path to an arbitrary
-- external origin, which makes this table an open-redirect surface and a phishing
-- lever. Writes are therefore ADMIN-only -- WRITER is deliberately excluded, matching
-- site_scripts rather than the content tables. Reads are public but limited to active
-- rows. The robots settings live in site_settings, whose existing read policy is
-- already public for non-secret keys; nothing here is secret.
--
-- Forward-only and idempotent.

CREATE TABLE IF NOT EXISTS public.cms_redirects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    -- The incoming site-relative path to match, normalized by the application to a
    -- leading slash with no trailing slash (except root). Matching is exact: prefix
    -- and wildcard rules are deliberately not supported, because they are the usual
    -- way an operator builds an accidental loop.
    source_path text NOT NULL,
    -- Where to send the visitor. Either another site-relative path or a fully
    -- qualified https URL for an off-site move.
    destination_path text NOT NULL,
    -- 301 permanent (the SEO-meaningful one: search engines transfer ranking signals
    -- and browsers cache it aggressively) or 302 temporary.
    status_code integer DEFAULT 301 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cms_redirects_pkey PRIMARY KEY (id),
    -- One rule per source. This UNIQUE constraint also provides the index the proxy
    -- lookup relies on, so no separate plain index on source_path is needed.
    CONSTRAINT cms_redirects_source_path_key UNIQUE (source_path),
    CONSTRAINT cms_redirects_status_code_check
        CHECK ((status_code = ANY (ARRAY[301, 302]))),
    -- A source is always a path on this site; accepting an absolute URL here would
    -- silently never match, since the proxy only ever compares pathnames.
    CONSTRAINT cms_redirects_source_path_check
        CHECK ((source_path ~ '^/')),
    -- A destination is either a site-relative path or an https URL. Plain http is
    -- refused so a redirect can never downgrade a visitor to cleartext.
    CONSTRAINT cms_redirects_destination_path_check
        CHECK (((destination_path ~ '^/') OR (destination_path ~ '^https://'))),
    -- The one cycle a single row can express, and the one operators actually create.
    CONSTRAINT cms_redirects_no_self_redirect_check
        CHECK ((source_path <> destination_path))
);

COMMENT ON TABLE public.cms_redirects IS
    'Operator-managed 301/302 redirects resolved by apps/nextblock/proxy.ts before rendering. Only is_active rows are publicly readable; only ADMIN may write, because a redirect rule is an open-redirect surface.';
COMMENT ON COLUMN public.cms_redirects.source_path IS
    'Exact site-relative path to match, normalized to a leading slash and no trailing slash (except root). No wildcards, by design.';
COMMENT ON COLUMN public.cms_redirects.destination_path IS
    'Site-relative path or absolute https URL to send the visitor to.';
COMMENT ON COLUMN public.cms_redirects.status_code IS
    '301 permanent or 302 temporary. 307/308 are not offered by the admin UI.';
COMMENT ON COLUMN public.cms_redirects.is_active IS
    'Only active rows are readable by anon, and only active rows are matched by the proxy.';

-- The proxy loads the whole active set once per cache window rather than querying per
-- request, so the hot query is "all active rows" and this partial index is what serves
-- it. Carrying source_path in the index keeps that read index-only.
CREATE INDEX IF NOT EXISTS cms_redirects_active_source_idx
    ON public.cms_redirects USING btree (source_path) WHERE (is_active);

DROP TRIGGER IF EXISTS set_cms_redirects_updated_at ON public.cms_redirects;
CREATE TRIGGER set_cms_redirects_updated_at
    BEFORE UPDATE ON public.cms_redirects
    FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

ALTER TABLE public.cms_redirects ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE public.cms_redirects TO anon;
GRANT ALL ON TABLE public.cms_redirects TO authenticated;
GRANT ALL ON TABLE public.cms_redirects TO service_role;

-- The proxy runs as anon for a logged-out visitor, which is the overwhelming majority
-- of traffic and the only traffic redirects really matter for. Without this policy the
-- lookup returns zero rows and the feature is silently dead.
DROP POLICY IF EXISTS "Public read active redirects" ON public.cms_redirects;
CREATE POLICY "Public read active redirects" ON public.cms_redirects
    FOR SELECT TO authenticated, anon USING (is_active);

DROP POLICY IF EXISTS "Admins read all redirects" ON public.cms_redirects;
CREATE POLICY "Admins read all redirects" ON public.cms_redirects
    FOR SELECT TO authenticated
    USING (((SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS "Admins insert redirects" ON public.cms_redirects;
CREATE POLICY "Admins insert redirects" ON public.cms_redirects
    FOR INSERT TO authenticated
    WITH CHECK (((SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS "Admins update redirects" ON public.cms_redirects;
CREATE POLICY "Admins update redirects" ON public.cms_redirects
    FOR UPDATE TO authenticated
    USING (((SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role))
    WITH CHECK (((SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role));

DROP POLICY IF EXISTS "Admins delete redirects" ON public.cms_redirects;
CREATE POLICY "Admins delete redirects" ON public.cms_redirects
    FOR DELETE TO authenticated
    USING (((SELECT public.get_current_user_role()) = 'ADMIN'::public.user_role));

-- Robots directives live in site_settings rather than a table of their own: there is
-- exactly one robots.txt per install, so a dedicated table would only ever hold one
-- row, and site_settings already carries the public-read / staff-write policy this
-- needs. The stored shape matches `RobotsSettings` in @nextblock-cms/utils, and
-- `normalizeRobotsSettings` tolerates a missing or malformed value -- so this seed is
-- a convenience for the settings screen, not a correctness requirement for rendering.
--
-- ON CONFLICT DO NOTHING because an install that has already configured robots must
-- not have its rules reset by a replay of this migration.
INSERT INTO public.site_settings (key, value)
VALUES (
    'seo_robots_settings',
    '{"customRules": "", "isIndexingEnabled": true, "sitemapEnabled": true, "userAgentRules": [{"allow": ["/"], "disallow": [], "userAgent": "*"}]}'::jsonb
)
ON CONFLICT (key) DO NOTHING;
$nb_file_00000000000030$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000030_seo_redirects_and_robots.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000030_seo_redirects_and_robots.sql

  -- >>> FROM: 00000000000031_seo_robots_settings_admin_only.sql
  IF NOT pg_temp.nb_recorded('00000000000031', '00000000000031_seo_robots_settings_admin_only') THEN
    RAISE NOTICE 'catch-up: applying 00000000000031_seo_robots_settings_admin_only.sql';
    EXECUTE $nb_file_00000000000031$
-- Restrict writes to the robots.txt settings row to ADMIN only.
--
-- `site_settings.seo_robots_settings` is the row that decides whether the whole site
-- is crawlable: app/robots.ts reads it on every /robots.txt hit and serves a blanket
-- `Disallow: /` when `isIndexingEnabled` is false. The CMS only offers that switch
-- under /cms/settings/seo, and `saveRobotsSettings` re-checks for ADMIN before it
-- writes — but RLS is the independent boundary, and it did not agree. The baseline
-- write policies let ADMIN *or* WRITER write any key outside the sensitive array, so
-- a WRITER holding a normal session could PATCH this row through PostgREST and take
-- the entire site out of Google. That failure is quiet (nothing in the CMS shows it),
-- slow to notice (search traffic decays over weeks) and hard to attribute after the
-- fact, which is why the database has to refuse it rather than trusting the one
-- server action that happens to guard it today.
--
-- The SELECT policy is deliberately NOT touched. This key must stay anon-READABLE:
-- app/robots.ts reads it with the anon (SSG) client on every crawl, and adding the key
-- to the read policy's sensitive array would make robots.txt fall back to its
-- permissive defaults for every crawler. Only INSERT/UPDATE/DELETE move to ADMIN-only,
-- matching the UI boundary — exactly the shape migration 00000000000011 used for
-- language_detection_settings, which is anon-readable for the same reason.
--
-- Every key already present in each policy's array is preserved (dropping one would
-- silently widen write access back to WRITER for that key); `seo_robots_settings` is
-- appended to the three write policies only.

DROP POLICY IF EXISTS site_settings_insert_policy ON public.site_settings;
CREATE POLICY site_settings_insert_policy ON public.site_settings FOR INSERT TO authenticated WITH CHECK ((((key <> ALL (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text, 'cortex_ai_mcp_settings'::text, 'seo_robots_settings'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role]))) OR ((key = ANY (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text, 'cortex_ai_mcp_settings'::text, 'seo_robots_settings'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role))));

DROP POLICY IF EXISTS site_settings_update_policy ON public.site_settings;
CREATE POLICY site_settings_update_policy ON public.site_settings FOR UPDATE TO authenticated USING ((((key <> ALL (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text, 'cortex_ai_mcp_settings'::text, 'seo_robots_settings'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role]))) OR ((key = ANY (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text, 'cortex_ai_mcp_settings'::text, 'seo_robots_settings'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role)))) WITH CHECK ((((key <> ALL (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text, 'cortex_ai_mcp_settings'::text, 'seo_robots_settings'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role]))) OR ((key = ANY (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text, 'cortex_ai_mcp_settings'::text, 'seo_robots_settings'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role))));

DROP POLICY IF EXISTS site_settings_delete_policy ON public.site_settings;
CREATE POLICY site_settings_delete_policy ON public.site_settings FOR DELETE TO authenticated USING ((((key <> ALL (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text, 'cortex_ai_mcp_settings'::text, 'seo_robots_settings'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = ANY (ARRAY['ADMIN'::public.user_role, 'WRITER'::public.user_role]))) OR ((key = ANY (ARRAY['cortex_ai_openrouter_api_key'::text, 'bot_protection_secret'::text, 'email_secret'::text, 'payment_secret'::text, 'language_detection_settings'::text, 'cortex_ai_pexels_api_key'::text, 'cortex_ai_unsplash_access_key'::text, 'cortex_ai_mcp_settings'::text, 'seo_robots_settings'::text])) AND (( SELECT public.get_current_user_role() AS get_current_user_role) = 'ADMIN'::public.user_role))));

-- Forward-only and idempotent.
$nb_file_00000000000031$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000031_seo_robots_settings_admin_only.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000031_seo_robots_settings_admin_only.sql

  -- >>> FROM: 00000000000032_seed_seo_score_optimizations.sql
  IF NOT pg_temp.nb_recorded('00000000000032', '00000000000032_seed_seo_score_optimizations') THEN
    RAISE NOTICE 'catch-up: applying 00000000000032_seed_seo_score_optimizations.sql';
    EXECUTE $nb_file_00000000000032$
-- Migration: 00000000000032_seed_seo_score_optimizations.sql
-- Description: Optimize seeded pages and posts for perfect 100/100 Page SEO scores.
-- Safety: All updates are forward-only and content-guarded so they only apply to
-- default seeded copy and will NEVER overwrite customized content on external sites.

DO $$
BEGIN
  -----------------------------------------------------------------------------
  -- 1. Page Metadata Optimizations
  -----------------------------------------------------------------------------
  UPDATE public.pages
     SET meta_title = 'NextBlock™ - CMS Next.js Haute Performance',
         meta_description = 'NextBlock est un CMS Next.js open-source conçu sur Supabase. Éditeur visuel de blocs, bilingue et scores Lighthouse parfaits dès le premier jour.',
         updated_at = now()
   WHERE slug = 'accueil'
     AND (meta_title IS NULL OR meta_title = '' OR meta_title = 'NextBlock™ - CMS Next.js Haute Performance')
     AND (meta_description IS NULL OR meta_description = '' OR meta_description LIKE 'NextBlock est un CMS Next.js%');

  UPDATE public.pages
     SET meta_title = 'NextBlock Journal | Engineering Guides & Tutorials',
         meta_description = 'Read technical deep dives, tutorials, and release notes on Next.js 16, Supabase, and modern visual web publishing from the NextBlock team.',
         updated_at = now()
   WHERE slug = 'articles' AND language_id = 1
     AND (meta_description IS NULL OR meta_description = '' OR meta_description = 'Explore architectural walkthroughs, Supabase recipes, and block editor experiments written by the Nextblock core team.');

  UPDATE public.pages
     SET meta_title = 'Journal NextBlock | Guides Techniques et Tutoriels',
         meta_description = 'Découvrez des guides techniques, des tutoriels et des analyses sur Next.js 16, Supabase et l’édition de blocs moderne avec l’équipe NextBlock.',
         updated_at = now()
   WHERE slug = 'articles' AND language_id = 2
     AND (meta_description IS NULL OR meta_description = '' OR meta_description = 'Explorez les guides d''architecture, les recettes Supabase et les experiences de l''editeur de blocs de NextBlock.');

  UPDATE public.pages
     SET meta_title = 'Contact Us | NextBlock Open-Source CMS',
         meta_description = 'Have questions, ideas, or feedback about NextBlock? Reach out to our team for technical support, partnership inquiries, and community discussions.',
         updated_at = now()
   WHERE slug = 'contact' AND language_id = 1
     AND (meta_description IS NULL OR meta_description = '' OR meta_description LIKE 'NextBlock™ is an open-source project driven%');

  UPDATE public.pages
     SET meta_title = 'Contactez-nous | NextBlock CMS Open Source',
         meta_description = 'Une question, une idée ou un retour sur NextBlock ? Contactez notre équipe pour du support technique, des partenariats ou échanger sur le projet.',
         updated_at = now()
   WHERE slug = 'contact' AND language_id = 2
     AND (meta_description IS NULL OR meta_description = '' OR meta_description LIKE 'NextBlock™ est un projet open-source propulsé%');

  UPDATE public.pages
     SET meta_title = 'Shop NextBlock™ Modules | Official Store',
         meta_description = 'Browse official commercial modules and licenses for NextBlock CMS. Get instant access to NextBlock Commerce and Cortex AI with secure checkout.',
         updated_at = now()
   WHERE slug = 'shop'
     AND (meta_description IS NULL OR meta_description = '' OR meta_description = 'Browse our premium products');

  UPDATE public.pages
     SET meta_title = 'Boutique NextBlock™ | Modules et Licences Officielles',
         meta_description = 'Achetez des licences et extensions officielles pour NextBlock CMS. Accédez à NextBlock Commerce et Cortex AI avec un paiement simple et sécurisé.',
         updated_at = now()
   WHERE slug = 'boutique'
     AND (meta_description IS NULL OR meta_description = '' OR meta_description IN ('Decouvrez nos produits premium', 'Découvrez nos produits premium'));

  -----------------------------------------------------------------------------
  -- 2. Post Metadata Optimizations
  -----------------------------------------------------------------------------
  UPDATE public.posts
     SET meta_description = 'A single command keeps your NextBlock install updated on Docker, Supabase, or a cloned repo. Learn how it works and keeps your data safe.',
         updated_at = now()
   WHERE slug = 'how-updating-works'
     AND (meta_description IS NULL OR meta_description LIKE 'A single command keeps your NextBlock install updated%');

  UPDATE public.posts
     SET meta_title = 'Mises à jour NextBlock : une commande pour chaque site',
         meta_description = 'Une seule commande met à jour NextBlock sur Docker, Supabase ou un dépôt cloné. Découvrez le fonctionnement et la protection de vos données.',
         updated_at = now()
   WHERE slug = 'comment-fonctionnent-les-mises-a-jour'
     AND (meta_title IS NULL OR meta_title LIKE 'Les mises à jour de NextBlock%');

  -----------------------------------------------------------------------------
  -- 3. Post Content Optimizations (Content-Guarded)
  -----------------------------------------------------------------------------
  -- Post 1: How NextBlock Works EN
  UPDATE public.blocks
     SET content = jsonb_set(content, '{html_content}', to_jsonb('
<p class=''text-lg leading-8 text-slate-700 dark:text-slate-300''>NextBlock™ is built so the hosted CMS, the open-source starter, and the developer tools feel like one clear product. A shared Nx workspace and typed blocks keep code clean and teams moving fast.</p>

<div class=''grid gap-4 md:grid-cols-3 my-10''>
  <div class=''rounded-3xl border border-sky-200/70 bg-sky-50/70 p-6 dark:border-sky-500/20 dark:bg-sky-500/10''>
    <p class=''text-xs font-semibold uppercase tracking-[0.22em] text-sky-700 dark:text-sky-200''>One codebase</p>
    <h2 class=''mt-3 text-xl font-semibold text-slate-900 dark:text-white''>Shared foundation</h2>
    <p class=''mt-3 text-sm text-slate-600 dark:text-slate-300''>Marketing pages, CMS screens, and the starter template grow together instead of drifting apart.</p>
  </div>
  <div class=''rounded-3xl border border-indigo-200/70 bg-indigo-50/70 p-6 dark:border-indigo-500/20 dark:bg-indigo-500/10''>
    <p class=''text-xs font-semibold uppercase tracking-[0.22em] text-indigo-700 dark:text-indigo-200''>Typed content</p>
    <h2 class=''mt-3 text-xl font-semibold text-slate-900 dark:text-white''>Blocks with guardrails</h2>
    <p class=''mt-3 text-sm text-slate-600 dark:text-slate-300''>Zod schemas and typed contracts make every custom block safe to build and ship.</p>
  </div>
  <div class=''rounded-3xl border border-emerald-200/70 bg-emerald-50/70 p-6 dark:border-emerald-500/20 dark:bg-emerald-500/10''>
    <p class=''text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200''>Editorial UX</p>
    <h2 class=''mt-3 text-xl font-semibold text-slate-900 dark:text-white''>Product-grade editing</h2>
    <p class=''mt-3 text-sm text-slate-600 dark:text-slate-300''>The Tiptap layer gives writers a rich editing screen without hiding the power of clean HTML.</p>
  </div>
</div>

<div class=''flex flex-col md:flex-row gap-8 items-center my-12''>
  <div class=''w-full md:w-1/2 space-y-4''>
    <h2>Monorepo Layout and Dependency Flow</h2>
    <p>The <code>apps/nextblock</code> folder holds the production Next.js app. This includes the public site and the private CMS admin area. The <code>apps/create-nextblock</code> tool mirrors that setup so teams can start with proven patterns right away.</p>
    <ul class=''list-disc pl-6 space-y-2 text-sm''>
      <li><strong>@nextblock-cms/ui</strong> - UI parts, design tokens, and shared buttons</li>
      <li><strong>@nextblock-cms/utils</strong> - Translations, safety checks, and image helpers</li>
      <li><strong>@nextblock-cms/db</strong> - Safe migrations, typed database queries, and schemas</li>
      <li><strong>@nextblock-cms/editor</strong> - The reusable Tiptap v3 block editor</li>
      <li><strong>@nextblock-cms/sdk</strong> - Typed tools to build and check custom blocks</li>
      <li><strong>@nextblock-cms/ecommerce</strong> - The digital store package when activated</li>
    </ul>
    <p>Run <code>nx graph</code> to see how code flows across the workspace. Shared path aliases and Tailwind styles help keep designs aligned across all pages.</p>
  </div>
  <aside class=''w-full md:w-1/2 rounded-[2rem] border border-slate-200/80 bg-white p-4 shadow-xl dark:border-white/10 dark:bg-white/5''>
    <div class=''relative aspect-video overflow-hidden rounded-2xl''><iframe class=''absolute inset-0 h-full w-full border-0'' src=''https://www.youtube-nocookie.com/embed/DNqU8ez9qjs?si=p2oIy0f-n7wiaBmO'' title=''How NextBlock™ Works'' allow=''accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'' referrerpolicy=''strict-origin-when-cross-origin'' loading=''lazy'' allowfullscreen></iframe></div>
    <p class=''mt-3 text-sm text-slate-500 dark:text-slate-400''>Nx makes workspace relations clear. That is why our starter, CMS, and packages stay aligned.</p>
  </aside>
</div>

<figure class=''my-12 overflow-hidden rounded-[2rem] border border-slate-200/80 bg-slate-950 shadow-2xl dark:border-white/10''>
  <img src=''/images/extensibility.webp'' alt=''NextBlock™ extensibility artwork showing the CMS connected to reusable modules and integrations'' class=''w-full h-auto object-cover'' />
  <figcaption class=''border-t border-white/10 px-6 py-4 text-sm text-slate-300''>One unified design system spans content blocks, editing tools, and store features.</figcaption>
</figure>

<h2>Block Registry as Product Surface</h2>
<p>The block registry file is the source of truth for all blocks. It holds Zod schemas, starter content, and editor components. Today it includes everything from text and headings to sections, post grids, checkout forms, and product cards.</p>
<p>Sections support nested columns, so you can build real page layouts rather than flat lists. Typed helper functions keep custom layouts safe and easy to maintain.</p>

<h2>The Editing Layer</h2>
<p>The editor package wraps Tiptap into a rich editing surface. It offers slash commands, floating menus, drag handles, tables, checklists, and code blocks. It preserves clean HTML so teams are never locked into a closed format.</p>

<h2>Inside the CMS Shell</h2>
<p>Inside the CMS folder, each feature follows a clear pattern: item lists, create forms, edit screens, and server actions that wrap database updates. This gives editors a smooth flow while keeping credentials safe on the server.</p>

<h2>Open Core Without Product Drift</h2>
<p>The core CMS is open-source under the AGPL license. Store modules remain source-available and turn on with verified licenses. This keeps the core lightweight while unlocking advanced tools when you need them.</p>

<h2>Why It Holds Together</h2>
<p>The Nx monorepo keeps libraries clean. The Next.js framework ensures fast page loads. Supabase migrations define database rules, and Tiptap gives writers a great authoring screen. When you run <code>npm create nextblock</code>, you get a complete, working system from day one.</p>
'::text)),
         updated_at = now()
   WHERE post_id = 1
     AND content->>'html_content' LIKE '%NextBlock™ is designed so the hosted CMS%';

  -- Post 2: Comment NextBlock Fonctionne FR
  UPDATE public.blocks
     SET content = jsonb_set(content, '{html_content}', to_jsonb('
<p class=''text-lg leading-8 text-slate-700 dark:text-slate-300''>NextBlock™ est conçu pour offrir une expérience fluide entre le CMS hébergé, le projet open-source et les outils développeur. L''espace Nx partagé et les blocs typés permettent aux équipes de publier vite tout en gardant un code très propre.</p>

<div class=''grid gap-4 md:grid-cols-3 my-10''>
  <div class=''rounded-3xl border border-sky-200/70 bg-sky-50/70 p-6 dark:border-sky-500/20 dark:bg-sky-500/10''>
    <p class=''text-xs font-semibold uppercase tracking-[0.22em] text-sky-700 dark:text-sky-200''>Base unique</p>
    <h2 class=''mt-3 text-xl font-semibold text-slate-900 dark:text-white''>Une même base</h2>
    <p class=''mt-3 text-sm text-slate-600 dark:text-slate-300''>Les pages du site, les écrans du CMS et le modèle de départ évoluent ensemble sans dérive.</p>
  </div>
  <div class=''rounded-3xl border border-indigo-200/70 bg-indigo-50/70 p-6 dark:border-indigo-500/20 dark:bg-indigo-500/10''>
    <p class=''text-xs font-semibold uppercase tracking-[0.22em] text-indigo-700 dark:text-indigo-200''>Contenu typé</p>
    <h2 class=''mt-3 text-xl font-semibold text-slate-900 dark:text-white''>Blocs avec garde-fous</h2>
    <p class=''mt-3 text-sm text-slate-600 dark:text-slate-300''>Les schémas Zod et les types stricts sécurisent chaque nouveau bloc personnalisé.</p>
  </div>
  <div class=''rounded-3xl border border-emerald-200/70 bg-emerald-50/70 p-6 dark:border-emerald-500/20 dark:bg-emerald-500/10''>
    <p class=''text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200''>Confort de rédaction</p>
    <h2 class=''mt-3 text-xl font-semibold text-slate-900 dark:text-white''>Édition premium</h2>
    <p class=''mt-3 text-sm text-slate-600 dark:text-slate-300''>L''éditeur Tiptap offre un vrai confort de travail sans brider la puissance du HTML propre.</p>
  </div>
</div>

<div class=''flex flex-col md:flex-row gap-8 items-center my-12''>
  <div class=''w-full md:w-1/2 space-y-4''>
    <h2>Architecture monorepo et flux de dépendances</h2>
    <p>Le dossier <code>apps/nextblock</code> contient le site Next.js public et le tableau de bord privé du CMS. La commande <code>apps/create-nextblock</code> reprend cette même base pour lancer des projets sains dès le premier jour.</p>
    <ul class=''list-disc pl-6 space-y-2 text-sm''>
      <li><strong>@nextblock-cms/ui</strong> - Composants d''interface, boutons et styles partagés</li>
      <li><strong>@nextblock-cms/utils</strong> - Traductions, gardes d''environnement et images</li>
      <li><strong>@nextblock-cms/db</strong> - Migrations sûres, accès typé à la base et schémas</li>
      <li><strong>@nextblock-cms/editor</strong> - L''éditeur de blocs réutilisable basé sur Tiptap v3</li>
      <li><strong>@nextblock-cms/sdk</strong> - Outils typés pour créer et vérifier des blocs sur mesure</li>
      <li><strong>@nextblock-cms/ecommerce</strong> - Le module de boutique en ligne une fois activé</li>
    </ul>
    <p>La commande <code>nx graph</code> montre clairement les liens entre chaque dossier. Les alias de code et la configuration Tailwind partagée assurent un design soigné partout.</p>
  </div>
  <aside class=''w-full md:w-1/2 rounded-[2rem] border border-slate-200/80 bg-white p-4 shadow-xl dark:border-white/10 dark:bg-white/5''>
    <div class=''relative aspect-video overflow-hidden rounded-2xl''><iframe class=''absolute inset-0 h-full w-full border-0'' src=''https://www.youtube-nocookie.com/embed/DNqU8ez9qjs?si=p2oIy0f-n7wiaBmO'' title=''Comment NextBlock™ Fonctionne'' allow=''accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'' referrerpolicy=''strict-origin-when-cross-origin'' loading=''lazy'' allowfullscreen></iframe></div>
    <p class=''mt-3 text-sm text-slate-500 dark:text-slate-400''>Nx rend chaque lien visible dans le projet. C''est pourquoi le starter et le CMS restent toujours synchronisés.</p>
  </aside>
</div>

<figure class=''my-12 overflow-hidden rounded-[2rem] border border-slate-200/80 bg-slate-950 shadow-2xl dark:border-white/10''>
  <img src=''/images/extensibility.webp'' alt=''Illustration NextBlock montrant les connexions entre le CMS et les modules externes'' class=''w-full h-auto object-cover'' />
  <figcaption class=''border-t border-white/10 px-6 py-4 text-sm text-slate-300''>Un même système visuel réunit la gestion de contenu, l''édition et les modules du store.</figcaption>
</figure>

<h2>Le registre de blocs comme surface produit</h2>
<p>Le registre de blocs est la source de vérité pour tous les blocs du CMS. Il rassemble les schémas Zod, les contenus de départ et les composants d''affichage. Il gère le texte, les titres, les sections, les listes d''articles et les formulaires de paiement.</p>
<p>Les sections acceptent des colonnes imbriquées. Vous pouvez ainsi monter de vraies pages complètes plutôt que de simples listes de textes. Des fonctions typées rendent cette souplesse très sûre à manipuler.</p>

<h2>La couche d''édition</h2>
<p>Le paquet éditeur transforme Tiptap en un espace de rédaction riche. Il propose des commandes slash, des menus flottants, des tableaux, des listes de tâches et des blocs de code colorés. Il conserve un HTML propre pour ne jamais vous enfermer.</p>

<h2>À l''intérieur du shell CMS</h2>
<p>Dans le dossier CMS, chaque module suit la même logique : listes de données, pages d''ajout, écrans d''édition et Server Actions. Les rédacteurs travaillent en toute confiance pendant que les accès restent protégés sur le serveur.</p>

<h2>Open core sans dérive produit</h2>
<p>Le cœur de NextBlock est open-source sous licence AGPL. Les modules du store s''activent avec une clé de licence valide. Le socle reste léger tout en ouvrant des outils pro quand vous en avez besoin.</p>

<h2>Pourquoi l''ensemble tient</h2>
<p>Le monorepo Nx garde les librairies bien rangées. L''application Next.js assure la rapidité des pages. Les migrations Supabase fixent les règles de la base, et l''éditeur Tiptap offre un vrai confort de travail. En lançant <code>npm create nextblock</code>, vous profitez d''une base solide et prête à l''emploi.</p>
'::text)),
         updated_at = now()
   WHERE post_id = 2
     AND content->>'html_content' LIKE '%NextBlock™ relie le CMS h&eacute;berg&eacute;%';

  -- Post 3: Setup EN (Card headings H3 -> H2)
  UPDATE public.blocks
     SET content = jsonb_set(
           content,
           '{html_content}',
           to_jsonb(
             replace(
               replace(
                 replace(
                   replace(
                     content->>'html_content',
                     '<h3 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>Deploy on Vercel</h3>',
                     '<h2 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>Deploy on Vercel</h2>'
                   ),
                   '<h3 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>npm create nextblock &rarr; Docker</h3>',
                   '<h2 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>npm create nextblock &rarr; Docker</h2>'
                 ),
                 '<h3 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>npm create nextblock &rarr; Supabase + R2</h3>',
                 '<h2 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>npm create nextblock &rarr; Supabase + R2</h2>'
               ),
               '<h3 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>Clone the repository</h3>',
               '<h2 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>Clone the repository</h2>'
             )
           )
         ),
         updated_at = now()
   WHERE post_id = 3
     AND content->>'html_content' LIKE '%NextBlock is an open-source, AI-native Next.js CMS%';

  -- Post 4: Setup FR (Card headings H3 -> H2)
  UPDATE public.blocks
     SET content = jsonb_set(
           content,
           '{html_content}',
           to_jsonb(
             replace(
               replace(
                 replace(
                   replace(
                     content->>'html_content',
                     '<h3 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>Déployer sur Vercel</h3>',
                     '<h2 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>Déployer sur Vercel</h2>'
                   ),
                   '<h3 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>npm create nextblock &rarr; Docker</h3>',
                   '<h2 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>npm create nextblock &rarr; Docker</h2>'
                 ),
                 '<h3 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>npm create nextblock &rarr; Supabase + R2</h3>',
                 '<h2 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>npm create nextblock &rarr; Supabase + R2</h2>'
               ),
               '<h3 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>Cloner le dépôt</h3>',
               '<h2 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>Cloner le dépôt</h2>'
             )
           )
         ),
         updated_at = now()
   WHERE post_id = 4
     AND content->>'html_content' LIKE '%NextBlock est un CMS Next.js open-source%';

  -- Post 5: Commerce EN
  UPDATE public.blocks
     SET content = jsonb_set(content, '{html_content}', to_jsonb('
<p class=''text-lg leading-8 text-slate-700 dark:text-slate-300''>NextBlock™ Commerce is our first premium module. It adds a complete store layer to the same editor you use for content. It is built for teams that want their catalog and checkout in one place.</p>

<div class=''grid gap-4 md:grid-cols-3 my-10''>
  <div class=''rounded-3xl border border-emerald-200/70 bg-emerald-50/70 p-6 dark:border-emerald-500/20 dark:bg-emerald-500/10''>
    <p class=''text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200''>Commerce core</p>
    <h2 class=''mt-3 text-xl font-semibold text-slate-900 dark:text-white''>Catalog + checkout</h2>
    <p class=''mt-3 text-sm text-slate-600 dark:text-slate-300''>Products, orders, shipping, and invoices plug right into the CMS shell.</p>
  </div>
  <div class=''rounded-3xl border border-sky-200/70 bg-sky-50/70 p-6 dark:border-sky-500/20 dark:bg-sky-500/10''>
    <p class=''text-xs font-semibold uppercase tracking-[0.22em] text-sky-700 dark:text-sky-200''>Global selling</p>
    <h2 class=''mt-3 text-xl font-semibold text-slate-900 dark:text-white''>Multi-currency ready</h2>
    <p class=''mt-3 text-sm text-slate-600 dark:text-slate-300''>Live rate sync, price rounding, and market rules make selling worldwide simple.</p>
  </div>
  <div class=''rounded-3xl border border-indigo-200/70 bg-indigo-50/70 p-6 dark:border-indigo-500/20 dark:bg-indigo-500/10''>
    <p class=''text-xs font-semibold uppercase tracking-[0.22em] text-indigo-700 dark:text-indigo-200''>Operator workflow</p>
    <h2 class=''mt-3 text-xl font-semibold text-slate-900 dark:text-white''>Provider-aware flow</h2>
    <p class=''mt-3 text-sm text-slate-600 dark:text-slate-300''>Stripe and Freemius run side by side so your shop stays clean and easy to use.</p>
  </div>
</div>

<h2>Product Catalog</h2>
<p>The store supports physical goods and digital downloads. You can set up variants, custom options, images, prices, SKUs, and stock levels. Product photos live in your main media library. That means your content and marketing teams work with the same files.</p>

<h2>Multi-Currency Engine</h2>
<p>The pricing engine is built for real international stores. It handles rates, rounding, and rules with ease:</p>
<ul class=''list-disc pl-6 space-y-2 text-sm''>
  <li><strong>Unlimited currencies:</strong> Add any ISO currency code, symbol, and exchange rate.</li>
  <li><strong>Auto FX sync:</strong> Refresh daily rates from Frankfurter or your own provider URL.</li>
  <li><strong>Rounding rules:</strong> Round prices up, down, or use charm pricing like <code>9.99</code>.</li>
  <li><strong>Store auto-sync:</strong> Convert product prices whenever currency rates refresh.</li>
  <li><strong>Rebasing:</strong> Switch your base store currency with full recalculations.</li>
  <li><strong>Custom price overrides:</strong> Set exact prices for specific countries when needed.</li>
</ul>

<h2>Tax Automation</h2>
<p>You can set tax rates by hand or let Stripe Tax calculate totals automatically:</p>
<div class=''grid md:grid-cols-2 gap-6 my-6''>
  <div class=''p-6 rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5''>
    <h3 class=''font-bold text-slate-900 dark:text-white mb-2''>Manual mode</h3>
    <p class=''text-sm text-slate-600 dark:text-slate-400''>Set tax rates by country, state, or province. Stacked rates like GST and PST are supported. Detailed tax lines are saved with each order.</p>
  </div>
  <div class=''p-6 rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5''>
    <h3 class=''font-bold text-slate-900 dark:text-white mb-2''>Automatic mode</h3>
    <p class=''text-sm text-slate-600 dark:text-slate-400''>Stripe Tax calculates final amounts during checkout. Product tax codes travel with each item, and webhooks record final numbers.</p>
  </div>
</div>

<h2>Shipping and Checkout</h2>
<p>Shipping zones match by country and state. They support local method names, per-currency pricing, and free shipping rules. Fallback options ensure buyers always see a valid rate.</p>
<p>The checkout flow understands different payment providers:</p>
<ul class=''list-disc pl-6 space-y-2 text-sm''>
  <li><strong>Stripe:</strong> Handles physical goods, inventory checks, shipping costs, taxes, and Checkout sessions.</li>
  <li><strong>Freemius:</strong> Handles digital software licenses, plans, and hosted checkout pages.</li>
  <li>Cart items stay grouped by provider so the buying steps are always clear.</li>
</ul>

<figure class=''my-12 overflow-hidden rounded-[2rem] border border-slate-200/80 bg-slate-950 shadow-2xl dark:border-white/10''>
  <img src=''/images/commerce-plan.webp'' alt=''Commerce roadmap board outlining premium module goals and future storefront capabilities for NextBlock™'' class=''w-full h-auto object-cover'' />
  <figcaption class=''border-t border-white/10 px-6 py-4 text-sm text-slate-300''>Commerce is the first premium module on our roadmap. It fits naturally into the larger CMS platform.</figcaption>
</figure>

<h2>Inventory, Orders, and Invoices</h2>
<p>When stock tracking is on, checkout checks quantities before payment. Once paid, stock counts update in the database right away.</p>
<ul class=''list-disc pl-6 space-y-2 text-sm''>
  <li>Order status moves smoothly from pending to paid to shipped.</li>
  <li>Invoice numbers generate through safe database functions.</li>
  <li>Printable invoices use your company brand settings.</li>
  <li>Customers can view their past orders and receipts anytime.</li>
</ul>

<h2>Commerce Surfaces Inside the CMS</h2>
<p>When the store package is active, the CMS reveals new screens. You get product lists, stock tools, order details, shipping setup, tax rules, and currency settings. All of these screens look and feel like the rest of the CMS, so your team feels right at home.</p>
'::text)),
         updated_at = now()
   WHERE post_id = 5
     AND content->>'html_content' LIKE '%NextBlock™ Commerce is the first premium module%';

  -- Post 6: Commerce FR
  UPDATE public.blocks
     SET content = jsonb_set(content, '{html_content}', to_jsonb('
<p class=''text-lg leading-8 text-slate-700 dark:text-slate-300''>NextBlock™ Commerce est notre premier module premium. Il ajoute une vraie boutique en ligne directement dans le CMS. Il s''adresse aux équipes qui veulent réunir leurs articles, leur catalogue et leurs ventes au même endroit.</p>

<div class=''grid gap-4 md:grid-cols-3 my-10''>
  <div class=''rounded-3xl border border-emerald-200/70 bg-emerald-50/70 p-6 dark:border-emerald-500/20 dark:bg-emerald-500/10''>
    <p class=''text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200''>Cœur commerce</p>
    <h2 class=''mt-3 text-xl font-semibold text-slate-900 dark:text-white''>Catalogue + checkout</h2>
    <p class=''mt-3 text-sm text-slate-600 dark:text-slate-300''>Articles, commandes, livraison et factures s''intègrent dans le même CMS.</p>
  </div>
  <div class=''rounded-3xl border border-sky-200/70 bg-sky-50/70 p-6 dark:border-sky-500/20 dark:bg-sky-500/10''>
    <p class=''text-xs font-semibold uppercase tracking-[0.22em] text-sky-700 dark:text-sky-200''>Vente internationale</p>
    <h2 class=''mt-3 text-xl font-semibold text-slate-900 dark:text-white''>Multi-devise</h2>
    <p class=''mt-3 text-sm text-slate-600 dark:text-slate-300''>Taux de change en direct, prix ronds et règles locales facilitent les ventes.</p>
  </div>
  <div class=''rounded-3xl border border-indigo-200/70 bg-indigo-50/70 p-6 dark:border-indigo-500/20 dark:bg-indigo-500/10''>
    <p class=''text-xs font-semibold uppercase tracking-[0.22em] text-indigo-700 dark:text-indigo-200''>Gestion claire</p>
    <h2 class=''mt-3 text-xl font-semibold text-slate-900 dark:text-white''>Par fournisseur</h2>
    <p class=''mt-3 text-sm text-slate-600 dark:text-slate-300''>Stripe et Freemius fonctionnent ensemble pour garder une boutique claire.</p>
  </div>
</div>

<h2>Catalogue produits</h2>
<p>Le module gère les biens physiques et les produits téléchargeables. Vous pouvez créer des variantes, des options sur mesure, des images, des prix, des SKU et des niveaux de stock. Vos visuels restent rangés dans votre médiathèque habituelle. Rédacteurs et vendeurs travaillent donc avec les mêmes fichiers.</p>

<h2>Moteur multi-devise</h2>
<p>La gestion des prix est conçue pour de vraies boutiques mondiales :</p>
<ul class=''list-disc pl-6 space-y-2 text-sm''>
  <li><strong>Devises illimitées :</strong> Ajoutez chaque code de devise, son symbole et son taux de conversion.</li>
  <li><strong>Mise à jour automatique :</strong> Actualisez les taux chaque jour avec Frankfurter ou votre URL privée.</li>
  <li><strong>Arrondis des prix :</strong> Arrondissez vers le haut, vers le bas ou avec des prix comme <code>9,99</code>.</li>
  <li><strong>Synchronisation du catalogue :</strong> Convertissez les prix dès que les devises changent.</li>
  <li><strong>Changement de devise socle :</strong> Changez la monnaie par défaut avec recalcul complet.</li>
  <li><strong>Prix personnalisés :</strong> Fixez des prix précis pour chaque pays si nécessaire.</li>
</ul>

<h2>Taxes automatiques</h2>
<p>Vous pouvez régler vos taux à la main ou laisser Stripe Tax faire les calculs :</p>
<div class=''grid md:grid-cols-2 gap-6 my-6''>
  <div class=''p-6 rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5''>
    <h3 class=''font-bold text-slate-900 dark:text-white mb-2''>Mode manuel</h3>
    <p class=''text-sm text-slate-600 dark:text-slate-400''>Réglez les taux par pays et province. Les taxes cumulées comme la TPS et la TVQ sont gérées. Chaque ligne est enregistrée sur la commande.</p>
  </div>
  <div class=''p-6 rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5''>
    <h3 class=''font-bold text-slate-900 dark:text-white mb-2''>Mode automatique</h3>
    <p class=''text-sm text-slate-600 dark:text-slate-400''>Stripe Tax calcule les montants finaux lors de l''achat. Les codes fiscaux suivent les articles, et les webhooks confirment les chiffres.</p>
  </div>
</div>

<h2>Livraison et checkout</h2>
<p>Les zones de livraison se basent sur le pays et la région. Elles acceptent des libellés traduits, des tarifs par devise et la gratuité dès un certain montant. Un tarif de secours évite les blocages.</p>
<p>Le tunnel d''achat s''adapte à chaque passerelle de paiement :</p>
<ul class=''list-disc pl-6 space-y-2 text-sm''>
  <li><strong>Stripe :</strong> Gère les produits physiques, les stocks, la livraison, les taxes et les sessions Checkout.</li>
  <li><strong>Freemius :</strong> Gère les licences de logiciels, les formules et les pages de paiement sécurisées.</li>
  <li>Les articles restent séparés par fournisseur pour garder un parcours d''achat très simple.</li>
</ul>

<figure class=''my-12 overflow-hidden rounded-[2rem] border border-slate-200/80 bg-slate-950 shadow-2xl dark:border-white/10''>
  <img src=''/images/commerce-plan.webp'' alt=''Plan de développement de la boutique NextBlock illustrant les futures capacités e-commerce'' class=''w-full h-auto object-cover'' />
  <figcaption class=''border-t border-white/10 px-6 py-4 text-sm text-slate-300''>Le commerce est le premier module officiel de notre feuille de route. Il s''intègre au cœur du CMS.</figcaption>
</figure>

<h2>Inventaire, commandes et factures</h2>
<p>Quand le suivi de stock est actif, le panier vérifie les quantités avant paiement. Après paiement, les stocks diminuent aussitôt dans la base de données.</p>
<ul class=''list-disc pl-6 space-y-2 text-sm''>
  <li>Le statut passe simplement de panier en attente à payé puis expédié.</li>
  <li>Les numéros de facture sont créés par des fonctions sûres en base.</li>
  <li>Les factures à imprimer reprennent les couleurs de votre marque.</li>
  <li>Vos clients peuvent consulter l''historique de leurs commandes à tout moment.</li>
</ul>

<h2>Surfaces commerce dans le CMS</h2>
<p>Quand le module de vente est activé, le CMS affiche de nouveaux écrans. Vous profitez de la liste des articles, du suivi des stocks, des commandes, de la livraison, des taxes et des devises. Ces pages reprennent le design habituel du CMS pour ne pas dépayser votre équipe.</p>
'::text)),
         updated_at = now()
   WHERE post_id = 6
     AND content->>'html_content' LIKE '%NextBlock™ Commerce est le premier module premium de l''ecosysteme%';

  -- Post 7: Cortex AI EN
  UPDATE public.blocks
     SET content = jsonb_set(content, '{html_content}', to_jsonb('
<p class=''text-lg leading-8 text-slate-700 dark:text-slate-300''>NextBlock Cortex AI is the smart content tool built for modern web pages. It understands page blocks, section layouts, and editorial rules so you can create better content faster.</p>

<div class=''grid gap-4 md:grid-cols-3 my-10''>
  <div class=''rounded-3xl border border-violet-200/70 bg-violet-50/80 p-6 dark:border-violet-500/20 dark:bg-violet-500/10''>
    <p class=''text-xs font-semibold uppercase tracking-[0.22em] text-violet-700 dark:text-violet-200''>Model routing</p>
    <h2 class=''mt-3 text-xl font-semibold text-slate-900 dark:text-white''>Pick the right model</h2>
    <p class=''mt-3 text-sm text-slate-600 dark:text-slate-300''>Route your prompts through OpenRouter or your own provider to balance speed and price.</p>
  </div>
  <div class=''rounded-3xl border border-sky-200/70 bg-sky-50/80 p-6 dark:border-sky-500/20 dark:bg-sky-500/10''>
    <p class=''text-xs font-semibold uppercase tracking-[0.22em] text-sky-700 dark:text-sky-200''>BYOK control</p>
    <h2 class=''mt-3 text-xl font-semibold text-slate-900 dark:text-white''>Use your own keys</h2>
    <p class=''mt-3 text-sm text-slate-600 dark:text-slate-300''>Keep provider keys safe on your server while giving editors a simple AI writing screen.</p>
  </div>
  <div class=''rounded-3xl border border-emerald-200/70 bg-emerald-50/80 p-6 dark:border-emerald-500/20 dark:bg-emerald-500/10''>
    <p class=''text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200''>Typed output</p>
    <h2 class=''mt-3 text-xl font-semibold text-slate-900 dark:text-white''>Generate valid blocks</h2>
    <p class=''mt-3 text-sm text-slate-600 dark:text-slate-300''>Typed schemas ensure AI content drops straight into your pages as clean, working blocks.</p>
  </div>
</div>

<h2>Why Cortex AI Belongs Inside the Editor</h2>
<p>Generic chat tools can draft text, but they do not know the difference between a hero banner, a card grid, and a blog post. Cortex AI lives right inside your editing screen. It creates content that fits the blocks on your live site.</p>
<p>This makes AI truly useful for everyday work. You can draft a new landing section, polish a summary, expand product copy, or translate a full article with ease.</p>

<div class=''rounded-[2rem] border border-slate-200/80 bg-slate-50/90 p-6 my-10 dark:border-white/10 dark:bg-slate-900/70''>
  <p class=''text-xs font-semibold uppercase tracking-[0.22em] text-violet-700 dark:text-violet-200''>Editorial workflow</p>
  <div class=''grid gap-5 md:grid-cols-2 mt-5''>
    <div class=''rounded-2xl border border-slate-200 bg-white p-5 dark:border-white/10 dark:bg-slate-950/50''>
      <h3 class=''mt-0 text-xl text-slate-900 dark:text-white''>Faster first drafts</h3>
      <p class=''text-sm text-slate-600 dark:text-slate-300''>Start with a prompt and get a section, article draft, or product story that matches your tone.</p>
    </div>
    <div class=''rounded-2xl border border-slate-200 bg-white p-5 dark:border-white/10 dark:bg-slate-950/50''>
      <h3 class=''mt-0 text-xl text-slate-900 dark:text-white''>Cleaner revisions</h3>
      <p class=''text-sm text-slate-600 dark:text-slate-300''>Ask for shorter, clearer, or translated text without leaving your edit screen.</p>
    </div>
  </div>
</div>

<h2>Model Routing and Cost Control</h2>
<p>Cortex AI gives you full control over your models. You can pick fast models for quick drafts and stronger models for technical articles. You manage your API keys on the server, so your writers can focus on good content.</p>
<ul class=''list-disc pl-6 space-y-2 text-sm''>
  <li>Use quick models for rewrites, titles, and summaries.</li>
  <li>Use top models for long guides and difficult translations.</li>
  <li>Keep provider keys safe in your private server settings.</li>
  <li>Control costs without changing how pages display to visitors.</li>
</ul>

<h2>Block-Aware Generation</h2>
<p>Cortex AI does more than write plain text. It creates structured content that maps directly to NextBlock components. You get ready-to-use section copy, headings, buttons, and translated blocks. You spend less time fixing messy copy from external tools.</p>
<p>Because the generated content respects your block rules, everything looks consistent and runs fast on the web.</p>

<h2>Safer Team Workflows</h2>
<p>AI works best when humans stay in control. With Cortex AI, editors review every draft before publishing. Developers manage the model keys, and the CMS keeps all versions in your normal history log.</p>

<h2>A Practical Launch Flow</h2>
<ol class=''list-decimal pl-6 space-y-2 text-sm''>
  <li>Draft an article, landing section, or product story from a clear prompt.</li>
  <li>Refine the text to match your audience and brand tone.</li>
  <li>Create a translated version or shorter summary for social cards and search tags.</li>
  <li>Review the content in the editor, hit publish, and track your revisions over time.</li>
</ol>

<p>Cortex AI turns your CMS into a faster creative workshop. It does not replace human taste, but it helps you turn great ideas into finished pages in record time.</p>
'::text)),
         updated_at = now()
   WHERE post_id = 7
     AND content->>'html_content' LIKE '%NextBlock Cortex AI is the AI layer built%';

  -----------------------------------------------------------------------------
  -- 4. Page Block Content Optimizations (Content-Guarded)
  -----------------------------------------------------------------------------

  -- Page 1 Block Updates
  UPDATE public.blocks
     SET content = replace(content::text, 'Edge-rendered marketing sites, launches, and docs with uncompromising performance.', 'Fast edge-rendered sites, launches, and docs. Built for top speed and clean code.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'Edge-rendered marketing sites, launches,' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'NextBlock™ is the open-source, developer-first Next.js CMS that merges 100% Lighthouse scores with a powerful visual block editor.', 'NextBlock™ is the open-source Next.js CMS that pairs 100% Lighthouse scores with a visual block editor.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'NextBlock™ is the open-source, developer' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'NextBlock™ is a holistic platform that unites performance, editorial experience, and developer control so every stakeholder delivers their best work.', 'NextBlock™ brings speed, clear editing, and developer control together so your team can build better web pages.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'NextBlock™ is a holistic platform that u' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Built for 100% Lighthouse scores with global delivery and near-instant FCP.', 'Built for top Lighthouse scores, quick page loads, and fast global delivery.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'Built for 100% Lighthouse scores with gl' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'A low-code, Notion-style block editor empowers teams to ship pages without engineering help.', 'A clean block editor gives your team the power to create pages without writing code.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'A low-code, Notion-style block editor em' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Open-source control with a clean Nx monorepo and a typed SDK for limitless customization.', 'Full open-source control with a clean monorepo and typed tools to build custom blocks with ease.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'Open-source control with a clean Nx mono' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Every layer of NextBlock™ leans on proven developer-first technology so the platform feels familiar, performant, and trustworthy from day one.', 'NextBlock™ uses tools you already know and trust, so your site stays fast, safe, and easy to run.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'Every layer of NextBlock™ leans on prove' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'For Content Creators', 'For Writers and Editors')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'For Content Creators' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Drag-and-drop layouts with a Notion-like interface.', 'Drag and drop blocks in a clean, simple layout.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'Drag-and-drop layouts with a Notion-like' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Pre-built hero, feature, testimonial, and callout components.', 'Add heroes, galleries, and quotes with one click.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'Pre-built hero, feature, testimonial, an' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Drag-and-drop assets with folders, search, and alt text.', 'Keep your images organized with folders and tags.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'Drag-and-drop assets with folders, searc' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Audit trail with one-click restore for every change.', 'Restore any saved version with a single click.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'Audit trail with one-click restore for e' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Server Components, ISR, and Edge Functions ready out of the box.', 'Built with Server Components and fast edge caching.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'Server Components, ISR, and Edge Functio' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Postgres, Auth, Storage, and Row-Level Security fully wired.', 'Postgres database, user auth, and file storage ready to use.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'Postgres, Auth, Storage, and Row-Level S' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Nx-powered monorepo engineered for scale and clean separation.', 'An Nx workspace made for scale and clean code.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'Nx-powered monorepo engineered for scale' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'TypeScript SDK with Zod validation for building custom blocks.', 'Build and type new blocks in minutes.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'TypeScript SDK with Zod validation for b' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'NextBlock™ Commerce transforms your content platform into a complete e-commerce engine. Products, checkout, multi-currency, taxes, shipping, invoices — all natively integrated into the block editor you already know.', 'NextBlock™ Commerce turns your content site into a full online store. Sell products, take payments, handle taxes, and ship orders — all from the block editor you already use.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'NextBlock™ Commerce transforms your cont' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'NextBlock™ Commerce transforms your content platform into a complete e-commerce engine. Products, checkout, multi-currency, taxes, shipping, invoices — all natively integrated into the block editor you already know.', 'NextBlock™ Commerce turns your content site into a full online store. Sell products, take payments, handle taxes, and ship orders — all from the block editor you already use.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'NextBlock™ Commerce transforms your cont' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'NextBlock™ Commerce ships a complete e-commerce toolkit so you can go from catalog to checkout without third-party plugins.', 'NextBlock™ Commerce ships a complete online store toolkit so you can go from catalog to checkout with ease.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'NextBlock™ Commerce ships a complete e-c' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Live FX rates, rounding rules, and auto-sync across all currencies.', 'Live exchange rates, round prices, and auto-sync across all currencies.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'Live FX rates, rounding rules, and auto-' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Define custom rates or let Stripe Tax handle calculations automatically.', 'Set custom tax rates or let Stripe Tax calculate totals automatically.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'Define custom rates or let Stripe Tax ha' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Country and state-level zones with free shipping thresholds.', 'Set shipping rates by country and state, with free shipping rules.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'Country and state-level zones with free ' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Stripe for physical goods and Freemius for software licenses with seamless checkout.', 'Use Stripe for physical goods and Freemius for software licenses with simple checkout.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'Stripe for physical goods and Freemius f' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Automatic stock decrement on payment with variant-level tracking.', 'Update stock counts when an order is paid, with variant tracking.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'Automatic stock decrement on payment wit' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Order management, printable invoices, and customer receipts out of the box.', 'Manage orders, print invoices, and view customer reports with ease.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'Order management, printable invoices, an' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'NextBlock™ Cortex AI brings native block-level intelligence directly to your editor. Generate copy, refactor structures, and automate translations in one click, built directly on our high-performance architecture.', 'NextBlock™ Cortex AI helps you write, edit, and translate content right inside the block editor. Draft text, refine layouts, and switch languages with ease.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'NextBlock™ Cortex AI brings native block' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'NextBlock™ is building a sustainable open-core roadmap so the platform grows with your business.', 'NextBlock™ is built to grow with your business and help your team succeed.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'NextBlock™ is building a sustainable ope' || '%';


  -- Page 2 Block Updates
  UPDATE public.blocks
     SET content = replace(content::text, 'NextBlock™ est le CMS Next.js open-source alliant scores Lighthouse parfaits et éditeur visuel puissant.', 'NextBlock™ est le CMS Next.js open-source alliant scores parfaits et éditeur de blocs visuel.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'NextBlock™ est le CMS Next.js open-sourc' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Sites marketing et docs rendus à l''edge avec des performances irréprochables.', 'Sites marketing et docs rendus à l''edge. Conçus pour la vitesse et un code propre.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Sites marketing et docs rendus à l''edge ' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'NextBlock™ unifie performances, expérience éditoriale et contrôle développeur pour que chaque équipe livre son meilleur travail.', 'NextBlock™ réunit la vitesse, la clarté d''édition et le contrôle développeur. Votre équipe peut ainsi créer de meilleures pages web.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'NextBlock™ unifie performances, expérien' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Pensé pour des scores Lighthouse parfaits avec une diffusion mondiale.', 'Conçu pour des scores élevés et une diffusion rapide.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Pensé pour des scores Lighthouse parfait' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Un éditeur façon Notion pour publier sans dépendre des développeurs.', 'Un éditeur simple pour publier sans coder.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Un éditeur façon Notion pour publier san' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Un socle Next.js + Supabase modulaire, extensible et auto-hébergeable.', 'Un socle moderne, souple et très simple à faire grandir.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Un socle Next.js + Supabase modulaire, e' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Chaque couche de NextBlock™ repose sur des technologies éprouvées pour une expérience familière et performante.', 'NextBlock™ s''appuie sur des outils fiables et éprouvés. Votre site reste rapide, robuste et facile à maintenir au quotidien.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Chaque couche de NextBlock™ repose sur d' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Glisser-déposer façon Notion.', 'Glissez et déposez vos blocs dans une mise en page claire.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Glisser-déposer façon Notion.' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Héros, galeries, témoignages.', 'Insérez des héros, des galeries et des avis clients en un clic.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Héros, galeries, témoignages.' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Dossiers, tags et actions groupées.', 'Rangez vos photos et médias avec des dossiers et des tags.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Dossiers, tags et actions groupées.' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Historique et restauration instantanée.', 'Retrouvez et restaurez vos versions précédentes sans stress.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Historique et restauration instantanée.' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Server Components, ISR et Edge prêts à l''emploi.', 'Conçu avec Server Components et un cache edge très rapide.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Server Components, ISR et Edge prêts à l' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Postgres, auth, stockage, temps réel.', 'Base Postgres, profils, auth et stockage de fichiers prêts à l''emploi.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Postgres, auth, stockage, temps réel.' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Dépendances lisibles et centrales.', 'Une structure claire et bien rangée faite pour grandir sereinement.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Dépendances lisibles et centrales.' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Widgets typés et extensibles.', 'Créez et typez vos nouveaux composants en un instant.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Widgets typés et extensibles.' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'NextBlock™ Commerce transforme votre plateforme de contenu en moteur e-commerce complet. Produits, checkout, multi-devises, taxes, expédition, factures — le tout intégré nativement dans l''éditeur de blocs que vous connaissez déjà.', 'NextBlock™ Commerce transforme votre site de contenu en vraie boutique en ligne. Vendez des articles et recevez des paiements en ligne. Gérez vos taxes et vos envois dans l''éditeur que vous connaissez déjà.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'NextBlock™ Commerce transforme votre pla' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'NextBlock™ Commerce livre une boîte à outils e-commerce complète pour aller du catalogue au paiement sans plugins tiers.', 'NextBlock™ Commerce propose une boîte à outils complète. Allez du catalogue au paiement sans aucun plugin externe.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'NextBlock™ Commerce livre une boîte à ou' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Taux de change en temps réel, modes d''arrondi, prix charme et synchronisation automatique sur toutes les devises.', 'Taux de change en direct, prix ronds et mise à jour automatique sur toutes les devises.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Taux de change en temps réel, modes d''ar' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Taux manuels empilés (TPS + TVQ) ou calcul automatique via Stripe Tax — à vous de choisir.', 'Définissez vos taxes ou laissez Stripe Tax calculer les montants finaux.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Taux manuels empilés (TPS + TVQ) ou calc' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Résolution par pays et état, tarification par devise et seuils de livraison gratuite.', 'Ajustez les frais de port par pays et état avec des règles d''envoi gratuit.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Résolution par pays et état, tarificatio' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Stripe pour les produits physiques, Freemius pour les licences numériques — checkout intelligent avec validation d''inventaire.', 'Paiement Stripe pour les biens et Freemius pour les licences logicielles.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Stripe pour les produits physiques, Free' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Déduction automatique des quantités au paiement avec gestion des stocks par variante.', 'Mettez à jour les stocks dès qu''un achat est validé, avec suivi des variantes.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Déduction automatique des quantités au p' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Gestion du cycle de vie des commandes, numérotation stable des factures et rapports de commandes exportables.', 'Suivez chaque commande, imprimez des factures et téléchargez vos bilans en toute simplicité.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Gestion du cycle de vie des commandes, n' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'NextBlock™ Cortex AI apporte une intelligence native au niveau des blocs directement dans votre éditeur. Générez du texte, restructurez vos contenus et automatisez les traductions en un clic, le tout propulsé par notre architecture haute performance.', 'NextBlock™ Cortex AI vous aide à rédiger, corriger et traduire vos textes au cœur de l''éditeur de blocs. Créez des ébauches, améliorez vos titres et passez d''une langue à l''autre en un clin d''œil.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'NextBlock™ Cortex AI apporte une intelli' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'NextBlock™ construit une feuille de route open-core durable qui évolue avec votre activité.', 'NextBlock™ est pensé pour accompagner la croissance de votre entreprise. Nous voulons faire réussir vos projets web.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'NextBlock™ construit une feuille de rout' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Le commerce arrive en premier, puis l''ecosysteme s''etend avec des plugins, des blocs et des modules construits par les partenaires.', 'Le commerce ouvre la voie. Notre écosystème grandit avec de nouveaux plugins, des blocs utiles et des modules partenaires.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Le commerce arrive en premier, puis l''ec' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Transformez votre site en vitrine composable avec produits, checkout, tarification multi-devise, taxes automatiques et blocs commerce relies a votre contenu editorial.', 'Ajoutez une boutique complète à côté de vos articles. Profitez de produits, du paiement en ligne, de devises et de taxes sans effort.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Transformez votre site en vitrine compos' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Une marketplace communautaire ouvrira la voie a la publication, la vente et la distribution de blocs, themes, integrations et modules partenaires.', 'Un espace partagé permet aux développeurs de publier et vendre des blocs sur mesure, des thèmes et des outils connectés.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Une marketplace communautaire ouvrira la' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'NextBlock™ se construit en public. Ajoutez une étoile, partagez vos retours et façonnez l''avenir du CMS orienté performance.', 'NextBlock™ avance en public. Mettez une étoile sur le dépôt, partagez vos avis et façonnez la suite avec nous.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'NextBlock™ se construit en public. Ajout' || '%';


  -- Page 3 Block Updates
  UPDATE public.blocks
     SET content = replace(content::text, '<h2 class=''text-4xl md:text-5xl font-bold text-white text-center md:text-left mb-6''>Deep dives into performance, DX, and visual editing.</h2>', '<h1 class=''text-4xl md:text-5xl font-bold text-white text-center md:text-left mb-6''>The NextBlock Journal: Performance, DX, and Visual Editing</h1>')::jsonb,
         updated_at = now()
   WHERE page_id = 3
     AND content::text LIKE '%' || '<h2 class=''text-4xl md:text-5xl font-bol' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<p class=''text-slate-300 text-lg max-w-xl mx-auto md:mx-0 text-center md:text-left leading-relaxed''>Explore architectural walkthroughs, Supabase recipes, and block editor experiments written by the Nextblock core team.</p>', '<p class=''text-slate-300 text-lg max-w-xl mx-auto md:mx-0 text-center md:text-left leading-relaxed''>Explore practical guides, architecture deep dives, and editor workflows written by the NextBlock team and community.</p> <div class=''mt-8 text-slate-300 space-y-4 max-w-3xl''> <p>Welcome to the NextBlock Journal. This is your home for in-depth technical guides, release notes, and real-world web architecture patterns. Whether you are launching your first Next.js site or scaling an online store, our articles give you clear, tested steps to help you build faster.</p> <p>We believe modern web projects need developer freedom and a simple editing experience. Our engineering posts show how to pair Next.js 16 with Supabase Postgres, edge caching, and server actions without complex glue code. You will learn how to keep your Lighthouse score at 100% while giving teams a rich, block-based writing experience.</p> <p>Here are the key topics we cover across our editorial library:</p> <ul class=''space-y-2 list-disc pl-5''> <li><strong>Getting Started Guides:</strong> Simple setup walkthroughs for one-click Vercel deploys, local Docker environments, and custom cloud stacks.</li> <li><strong>Architecture & Performance:</strong> Deep dives into fast page rendering, clean CSS delivery, image optimization, and safe database migrations.</li> <li><strong>E-Commerce Workflows:</strong> Practical patterns for multi-currency pricing, automated tax sync, stock tracking, and provider checkout flows.</li> <li><strong>AI Content Tools:</strong> How to use Cortex AI to generate structured blocks, manage provider keys, and speed up routine translation work.</li> </ul> <p>Our team updates this collection regularly as we release new core features and modules. We test our code on live sites before publishing. Each post includes full technical explanations and architecture diagrams so you can apply the solutions to your own web stack.</p> <p>Have a topic you want us to cover or want to share your own case study? Join our community on GitHub or reach out to our team anytime. We welcome questions, ideas, and pull requests from all builders. You can subscribe to updates or start reading our latest published articles below.</p> </div>')::jsonb,
         updated_at = now()
   WHERE page_id = 3
     AND content::text LIKE '%' || '<p class=''text-slate-300 text-lg max-w-x' || '%';


  -- Page 4 Block Updates
  UPDATE public.blocks
     SET content = replace(content::text, '<h2 class=''text-4xl md:text-5xl font-bold text-white text-center md:text-left mb-6''>Plongées dans la performance, l''expérience dev et l''édition visuelle.</h2>', '<h1 class=''text-4xl md:text-5xl font-bold text-white text-center md:text-left mb-6''>Le Journal NextBlock : Performance, Expérience Dev et Édition</h1>')::jsonb,
         updated_at = now()
   WHERE page_id = 4
     AND content::text LIKE '%' || '<h2 class=''text-4xl md:text-5xl font-bol' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<p class=''text-lg max-w-xl mx-auto md:mx-0 text-center md:text-left text-slate-300 leading-relaxed''>Walkthroughs d''architecture, recettes Supabase et expérimentations éditeur écrits par l''équipe Nextblock.</p>', '<p class=''text-lg max-w-xl mx-auto md:mx-0 text-center md:text-left text-slate-300 leading-relaxed''>Retrouvez des guides pratiques, des études d''architecture et des conseils pour éditer vos contenus avec NextBlock.</p> <div class=''mt-8 text-slate-300 space-y-4 max-w-3xl''> <p>Bienvenue sur le Journal NextBlock. Cet espace rassemble nos guides techniques détaillés. Vous y trouverez les nouveautés de chaque version et les meilleures pratiques du web moderne. Vous lancez votre premier site Next.js ? Vous faites grandir une boutique en ligne ? Nos articles vous donnent des étapes simples et vérifiées pour construire plus vite.</p> <p>Nous pensons qu''un bon site web doit offrir toute la liberté aux développeurs. Il doit aussi apporter une vraie simplicité aux équipes éditoriales. Nos articles techniques expliquent comment marier Next.js 16 avec Supabase Postgres, le cache edge et les Server Actions. Tout cela se fait sans code superflu. Vous découvrirez comment maintenir un score Lighthouse parfait. En même temps, votre équipe profite d''un éditeur de blocs visuel et très agréable.</p> <p>Voici les principaux sujets abordés dans notre bibliothèque éditoriale :</p> <ul class=''space-y-2 list-disc pl-5''> <li><strong>Guides de démarrage :</strong> Des tutoriels pas à pas pour déployer sur Vercel en un clic, lancer une pile Docker locale ou installer votre propre cloud.</li> <li><strong>Architecture et performance :</strong> Des explications claires sur le rendu rapide des pages, les styles en ligne, l''optimisation des images et les migrations sûres.</li> <li><strong>Commerce en ligne :</strong> Des conseils concrets pour gérer plusieurs devises, synchroniser les taxes, suivre les stocks et réussir vos paiements.</li> <li><strong>Outils IA pour le contenu :</strong> Comment utiliser Cortex AI pour créer des blocs bien typés, garder le contrôle de vos clés et traduire vos pages en un instant.</li> </ul> <p>Notre équipe enrichit cette collection au fil des mises à jour du projet. Nous testons chaque exemple de code sur des sites réels avant publication. Chaque tutoriel propose des explications complètes pour adapter facilement ces solutions à votre propre projet.</p> <p>Vous avez une idée de sujet ou un retour d''expérience à partager ? Rejoignez notre communauté sur GitHub ou contactez notre équipe. Nous accueillons avec grand plaisir vos questions, vos idées et vos contributions. Parcourez dès maintenant nos derniers articles ci-dessous.</p> </div>')::jsonb,
         updated_at = now()
   WHERE page_id = 4
     AND content::text LIKE '%' || '<p class=''text-lg max-w-xl mx-auto md:mx' || '%';


  -- Page 5 Block Updates
  UPDATE public.blocks
     SET content = replace(content::text, '<div class=''max-w-2xl mx-auto text-center''><h2 class=''text-2xl font-bold mb-4''>Open Source & Community Driven</h2><p class=''text-slate-600 dark:text-slate-400 mb-6''>NextBlock™ is built in the open. We rely on developers and editors like you to help us define the roadmap. Whether it''s a bug report, a feature request, or just a shoutout, every message helps us move faster.</p></div>', '<div class=''mt-10 text-slate-300 space-y-4 max-w-3xl mx-auto''> <h2 class=''text-2xl font-bold text-white mb-4 text-center''>Open Source & Community Driven</h2> <p>NextBlock™ is built entirely in the open. We work closely with developers, editors, and teams who use the platform every day. Whether you found a bug, want to request a new feature, or need advice on your project setup, our team is here to help you move forward.</p> <p>We read every message sent through this form. Here is what you can expect when reaching out to our team:</p> <ul class=''space-y-2 list-disc pl-5''> <li><strong>Fast Response Times:</strong> Our core maintainers typically review and reply to inquiries within one to two business days.</li> <li><strong>Technical Support:</strong> For public bugs or community questions, our GitHub Discussions and Issues boards offer fast answers from the entire community.</li> <li><strong>Partnership and Modules:</strong> If your team wants to sponsor a roadmap module or build a custom integration, we can schedule a direct call.</li> <li><strong>Security Disclosures:</strong> For responsible disclosure of potential security vulnerabilities, please flag your message as urgent so we can triage it immediately.</li> </ul> <p>Before submitting, please make sure your email address is typed correctly so our team can get back to you. If your question is about a specific code error, including your environment details and reproduction steps helps us find a solution much faster.</p> <p>You can also connect with us directly on GitHub, Discord, or X (formerly Twitter). We host regular community discussions and share sneak peeks of upcoming platform features. If you are building a custom client project with NextBlock, we would love to hear about your experience.</p> <p>We value your time and privacy. We never share your contact information or use your email for marketing without your consent. Send us a message using the form below and we will get back to you shortly.</p> </div>')::jsonb,
         updated_at = now()
   WHERE page_id = 5
     AND content::text LIKE '%' || '<div class=''max-w-2xl mx-auto text-cente' || '%';


  -- Page 6 Block Updates
  UPDATE public.blocks
     SET content = replace(content::text, '<div class=''max-w-2xl mx-auto text-center''><h2 class=''text-2xl font-bold mb-4''>Open Source & Communautaire</h2><p class=''text-slate-600 dark:text-slate-400 mb-6''>NextBlock™ est construit en public. Nous comptons sur les développeurs et éditeurs comme vous pour définir notre roadmap. Qu''il s''agisse d''un bug, d''une suggestion ou d''un simple salut, chaque message compte.</p></div>', '<div class=''mt-10 text-slate-300 space-y-4 max-w-3xl mx-auto''> <h2 class=''text-2xl font-bold text-white mb-4 text-center''>Open Source & Communautaire</h2> <p>NextBlock™ est construit entièrement en public. Nous travaillons avec des développeurs et des équipes qui utilisent le CMS chaque jour. Vous avez trouvé un bug ? Vous souhaitez suggérer une fonction ? Vous avez besoin d''aide pour votre installation ? Notre équipe est là pour vous guider.</p> <p>Nous lisons attentivement chaque message reçu via ce formulaire. Voici nos engagements pour vous répondre au mieux :</p> <ul class=''space-y-2 list-disc pl-5''> <li><strong>Délais de réponse rapides :</strong> Nos mainteneurs étudient et répondent aux demandes en un ou deux jours ouvrés.</li> <li><strong>Support technique :</strong> Pour toute question publique, nos forums GitHub Discussions et Issues offrent une aide rapide de la communauté.</li> <li><strong>Partenariats et modules :</strong> Votre équipe veut sponsoriser un module ou concevoir une intégration sur mesure ? Nous pouvons planifier un échange direct.</li> <li><strong>Signalements de sécurité :</strong> Pour toute alerte de sécurité, signalez votre message comme prioritaire pour un traitement immédiat.</li> </ul> <p>Avant d''envoyer votre message, vérifiez bien votre adresse email. Notre équipe pourra ainsi vous répondre rapidement. Si votre demande concerne une erreur technique, mentionnez votre environnement et les étapes pour la reproduire. Cela nous aide à trouver une solution efficace.</p> <p>Vous pouvez aussi échanger avec nous sur GitHub, Discord ou X. Nous y partageons des nouvelles et les coulisses des prochaines versions. Vous développez un projet client avec NextBlock ? Racontez-nous votre aventure. Notre équipe aime voir ce que vous créez au quotidien. Chaque projet est unique. Prenez le temps de nous dire ce qui vous plaît et ce qui vous manque. Vos retours nous aident à faire un meilleur outil pour tout le monde.</p> <p>Nous respectons votre vie privée. Vos coordonnées ne sont jamais cédées ni réutilisées sans votre accord. Écrivez-nous ci-dessous et nous vous répondrons très vite.</p> </div>')::jsonb,
         updated_at = now()
   WHERE page_id = 6
     AND content::text LIKE '%' || '<div class=''max-w-2xl mx-auto text-cente' || '%';


  -- Page 7 Block Updates
  UPDATE public.blocks
     SET content = replace(content::text, '<p style="text-align: center; color: var(--background); opacity: 0.9">Discover our premium selection of developer tools and digital commerce solutions.</p>', '<p style="text-align: center; color: var(--background); opacity: 0.9">Discover our selection of official commercial add-ons and developer tools for NextBlock CMS.</p> <div class=''mt-8 text-slate-300 space-y-4 max-w-3xl mx-auto text-left''> <h2 class=''text-2xl font-bold text-white mb-4''>Power Up Your Web Projects</h2> <p>Welcome to the official NextBlock™ digital store. Here you can purchase licenses for our premium packages, including NextBlock™ Commerce and NextBlock™ Cortex AI. Every commercial license helps fund full-time open-source development on our core CMS while giving your team advanced tools to launch high-performance websites faster.</p> <p>Our premium modules are designed to feel native from day one. You get clean code that fits right into your existing NextBlock project without third-party plugins or complex configuration. When you purchase a license from our store, you receive instant access to everything you need:</p> <ul class=''space-y-2 list-disc pl-5''> <li><strong>Full Source Code:</strong> Inspect, customize, and adapt the modules to your exact requirements.</li> <li><strong>Perpetual Use:</strong> Use the software for your project with full peace of mind.</li> <li><strong>Automated Updates:</strong> Enjoy smooth updates that match each new release of NextBlock and Next.js.</li> <li><strong>Secure Checkout:</strong> Payments are processed safely with Stripe and Freemius with instant receipt generation.</li> </ul> <p>Whether you need multi-currency store features, automated sales tax calculations, or AI block generation in your editor, our modules deliver tested solutions that keep your Lighthouse scores at 100%.</p> <p>All purchases include dedicated onboarding resources, detailed developer docs, and friendly technical support. If you ever run into an issue or need help wiring up a provider webhook, our core engineers are ready to assist you. We also offer a thirty-day refund policy so you can try our tools risk-free.</p> <p>Have questions about license tiers, volume pricing, team seats, or custom agency usage? Contact our support team anytime. Our team is here to answer your questions and help your developers succeed. We are happy to help you pick the best plan for your company. Browse our featured products below to get started today.</p> </div>')::jsonb,
         updated_at = now()
   WHERE page_id = 7
     AND content::text LIKE '%' || '<p style="text-align: center; color: var' || '%';


  -- Page 8 Block Updates
  UPDATE public.blocks
     SET content = replace(content::text, '<p style="text-align: center; color: var(--background); opacity: 0.9">Decouvrez notre selection premium d outils de developpement.</p>', '<p style="text-align: center; color: var(--background); opacity: 0.9">Découvrez nos extensions officielles et nos outils pour développeurs conçus pour le CMS NextBlock.</p> <div class=''mt-8 text-slate-300 space-y-4 max-w-3xl mx-auto text-left''> <h2 class=''text-2xl font-bold text-white mb-4''>Accélérez vos projets web</h2> <p>Bienvenue sur la boutique officielle de NextBlock™. Vous pouvez acheter ici des licences pour nos modules professionnels, comme NextBlock™ Commerce et NextBlock™ Cortex AI. Chaque achat aide à financer le travail open-source sur le cœur du CMS. Il donne aussi à votre équipe des outils de pointe pour créer des sites rapides et fiables.</p> <p>Nos modules premium s''intègrent sans effort à votre projet existant. Vous profitez d''un code propre et bien testé, sans plugin externe lourd ni réglage complexe. En choisissant nos outils, vous profitez immédiatement de nombreux avantages :</p> <ul class=''space-y-2 list-disc pl-5''> <li><strong>Code source complet :</strong> Lisez, adaptez et faites évoluer chaque bloc selon vos besoins métier.</li> <li><strong>Licence perpétuelle :</strong> Utilisez le code sur votre projet en toute sérénité.</li> <li><strong>Mises à jour suivies :</strong> Recevez les nouvelles versions au rythme de Next.js et de NextBlock.</li> <li><strong>Paiement sécurisé :</strong> Les achats passent par Stripe et Freemius avec facture instantanée.</li> </ul> <p>Vous voulez vendre dans plusieurs devises ? Vous avez besoin du calcul automatique des taxes ? Vous voulez générer des blocs avec l''IA ? Nos modules offrent des solutions prêtes à l''emploi qui préservent vos scores Lighthouse à 100%.</p> <p>Chaque commande donne accès à une documentation claire et à notre support technique. Si vous avez besoin d''aide pour brancher un webhook ou un mode de paiement, nos développeurs vous répondent rapidement. Notre équipe est à vos côtés pour vous faire gagner du temps. Nous proposons aussi une garantie satisfait ou remboursé de trente jours.</p> <p>Vous avez des questions sur nos tarifs, les licences agence ou les remises en volume ? Écrivez à notre équipe à tout moment. Nous vous guiderons avec grand plaisir vers l''offre idéale pour votre entreprise. Découvrez dès aujourd''hui l''ensemble de nos produits ci-dessous pour bien démarrer votre projet.</p> </div>')::jsonb,
         updated_at = now()
   WHERE page_id = 8
     AND content::text LIKE '%' || '<p style="text-align: center; color: var' || '%';


  -- Page 9 Block Updates
  UPDATE public.blocks
     SET content = replace(content::text, 'NextBlock™ CMS ("we", "us", or "our") respects your privacy and is committed to protecting your personal information in accordance with Quebec''s <em>Act respecting the protection of personal information in the private sector</em> (Law 25), the federal <em>Personal Information Protection and Electronic Documents Act</em> (PIPEDA), and Canada''s Anti-Spam Legislation (CASL).', 'NextBlock™ CMS ("we", "us", or "our") respects your privacy. We protect your personal information under Quebec''s Law 25, the federal PIPEDA act, and Canada''s Anti-Spam Legislation (CASL).')::jsonb,
         updated_at = now()
   WHERE page_id = 9
     AND content::text LIKE '%' || 'NextBlock™ CMS ("we", "us", or "our") re' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Our Privacy Officer is responsible for our compliance with applicable privacy laws. You may reach them at', 'Our Privacy Officer oversees our compliance with privacy laws. You can reach them at')::jsonb,
         updated_at = now()
   WHERE page_id = 9
     AND content::text LIKE '%' || 'Our Privacy Officer is responsible for o' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<li><strong>Account information</strong> &mdash; name, email address, and credentials when you register.</li>', '<li><strong>Account information:</strong> Your name, email address, and login details when you register.</li>')::jsonb,
         updated_at = now()
   WHERE page_id = 9
     AND content::text LIKE '%' || '<li><strong>Account information</strong>' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<li><strong>Usage and device data</strong> &mdash; collected only with your consent through analytics technologies.</li>', '<li><strong>Usage and device data:</strong> Collected only with your consent through analytics tools.</li>')::jsonb,
         updated_at = now()
   WHERE page_id = 9
     AND content::text LIKE '%' || '<li><strong>Usage and device data</stron' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<li><strong>Communications</strong> &mdash; messages you send us and your marketing preferences.</li>', '<li><strong>Communications:</strong> Messages you send us and your newsletter choices.</li>')::jsonb,
         updated_at = now()
   WHERE page_id = 9
     AND content::text LIKE '%' || '<li><strong>Communications</strong> &mda' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<h2>3. Why we collect it and your consent</h2>
<p>We collect personal information for clearly identified purposes: to provide and secure our services, to communicate with you, and &mdash; only with your express, opt-in consent &mdash; for analytics and marketing. Consistent with Law 25, non-essential cookies and trackers remain disabled until you actively accept them, and you may withdraw your consent at any time.</p>', '<h2>3. Why we collect data and your consent</h2> <p>We collect personal information for clear reasons: to provide our services, keep accounts secure, and reply to your messages. We use analytics and marketing tools only with your direct, opt-in consent. Under Law 25, optional cookies stay off until you choose to accept them. You can withdraw your consent at any time.</p>')::jsonb,
         updated_at = now()
   WHERE page_id = 9
     AND content::text LIKE '%' || '<h2>3. Why we collect it and your consen' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Strictly necessary cookies keep the site working and require no consent. Analytics and marketing technologies are loaded <strong>only after</strong> you opt in through our consent banner. Your choice is recorded so we can honour it and demonstrate accountability.', 'Essential cookies keep the site running and require no consent. Analytics and marketing cookies load only after you opt in via our cookie banner. We record your choice to honor it and follow privacy rules.')::jsonb,
         updated_at = now()
   WHERE page_id = 9
     AND content::text LIKE '%' || 'Strictly necessary cookies keep the site' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'We do not sell your personal information. We share it only with service providers who help us operate the platform under contractual confidentiality obligations, or where required by law.', 'We do not sell your personal data. We share it only with trusted service providers who help us run the platform under strict confidentiality agreements, or when required by law.')::jsonb,
         updated_at = now()
   WHERE page_id = 9
     AND content::text LIKE '%' || 'We do not sell your personal information' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<h2>6. Retention</h2>
<p>We keep personal information only for as long as necessary to fulfil the purposes described above or as required by law, after which it is securely destroyed or anonymized.</p>', '<h2>6. Data retention</h2> <p>We keep personal information only as long as needed for the purposes described above or as required by law. After that, we securely delete or anonymize your data.</p>')::jsonb,
         updated_at = now()
   WHERE page_id = 9
     AND content::text LIKE '%' || '<h2>6. Retention</h2>
<p>We keep person' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Subject to applicable law, you have the right to access, rectify, and delete your personal information, to withdraw consent, to data portability, and to be informed about automated processing. To exercise these rights, contact our Privacy Officer at', 'Under privacy laws, you have the right to view, correct, and delete your personal information. You can also withdraw consent or ask for a portable copy of your data. To use these rights, write to our Privacy Officer at')::jsonb,
         updated_at = now()
   WHERE page_id = 9
     AND content::text LIKE '%' || 'Subject to applicable law, you have the ' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<h2>8. Commercial electronic messages (CASL)</h2>
<p>We send commercial electronic messages only with your consent. Every message identifies us and includes a working unsubscribe mechanism that we honour promptly.</p>', '<h2>8. Commercial electronic messages</h2> <p>We send commercial emails only with your permission. Every email clearly identifies us and includes an easy unsubscribe link that takes effect right away.</p>')::jsonb,
         updated_at = now()
   WHERE page_id = 9
     AND content::text LIKE '%' || '<h2>8. Commercial electronic messages (C' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<h2>9. Safeguards</h2>
<p>We use appropriate physical, organizational, and technological measures &mdash; including encryption in transit and access controls &mdash; to protect personal information against loss, theft, and unauthorized access.</p>', '<h2>9. Security safeguards</h2> <p>We use strong technical and physical protections to keep your data safe. These include encrypted connections and strict access controls to prevent loss, theft, and unauthorized access.</p>')::jsonb,
         updated_at = now()
   WHERE page_id = 9
     AND content::text LIKE '%' || '<h2>9. Safeguards</h2>
<p>We use approp' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'NextBlock™ CMS is free, open-source software distributed under the GNU Affero General Public License v3. When you self-host NextBlock, you are the operator responsible for the personal information processed by your own deployment, and this policy serves as a starting point you may adapt to your organization.', 'NextBlock™ CMS is free open-source software under the AGPLv3 license. When you self-host NextBlock, you control your own server. You are responsible for the personal data on your deployment, and this policy is a helpful model you can adapt.')::jsonb,
         updated_at = now()
   WHERE page_id = 9
     AND content::text LIKE '%' || 'NextBlock™ CMS is free, open-source soft' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<h2>11. Changes to this policy</h2>
<p>We may update this policy from time to time. Material changes will be communicated through the site, and the "last updated" date will be revised.</p>', '<h2>11. Policy changes</h2> <p>We may update this policy over time. We announce important changes on our site and update the revision date at the top.</p>')::jsonb,
         updated_at = now()
   WHERE page_id = 9
     AND content::text LIKE '%' || '<h2>11. Changes to this policy</h2>
<p>' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Questions or complaints? Contact NextBlock™ CMS at <a href="mailto:{{privacy_email}}">{{privacy_email}}</a>. You may also contact the Commission d''accès à l''information du Québec or the Office of the Privacy Commissioner of Canada.', 'Have questions or complaints? Contact NextBlock™ at <a href="mailto:{{privacy_email}}">{{privacy_email}}</a>. You can also contact the Commission d''accès à l''information du Québec or the Office of the Privacy Commissioner of Canada.')::jsonb,
         updated_at = now()
   WHERE page_id = 9
     AND content::text LIKE '%' || 'Questions or complaints? Contact NextBlo' || '%';


  -- Page 10 Block Updates
  UPDATE public.blocks
     SET content = replace(content::text, 'NextBlock™ CMS (« nous ») respecte votre vie privée et s''engage à protéger vos renseignements personnels conformément à la <em>Loi sur la protection des renseignements personnels dans le secteur privé</em> du Québec (Loi 25), à la <em>Loi sur la protection des renseignements personnels et les documents électroniques</em> (LPRPDE) et à la Loi canadienne anti-pourriel (LCAP).', 'NextBlock™ CMS (« nous ») respecte votre vie privée. Nous protégeons vos renseignements personnels selon la Loi 25 du Québec, la loi fédérale LPRPDE et les règles canadiennes anti-pourriel (LCAP).')::jsonb,
         updated_at = now()
   WHERE page_id = 10
     AND content::text LIKE '%' || 'NextBlock™ CMS (« nous ») respecte votre' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Notre responsable de la protection des renseignements personnels veille au respect des lois applicables. Vous pouvez le joindre à', 'Notre responsable veille au respect des règles de confidentialité. Vous pouvez lui écrire à')::jsonb,
         updated_at = now()
   WHERE page_id = 10
     AND content::text LIKE '%' || 'Notre responsable de la protection des r' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<h2>2. Renseignements que nous recueillons</h2>
<ul>
  <li><strong>Renseignements de compte</strong> &mdash; nom, adresse courriel et identifiants lors de l''inscription.</li>
  <li><strong>Données d''utilisation et d''appareil</strong> &mdash; recueillies uniquement avec votre consentement au moyen de technologies d''analyse.</li>
  <li><strong>Communications</strong> &mdash; les messages que vous nous envoyez et vos préférences marketing.</li>
</ul>', '<h2>2. Renseignements recueillis</h2> <ul> <li><strong>Renseignements de compte :</strong> Votre nom, votre courriel et vos accès lors de l''inscription.</li> <li><strong>Données d''utilisation et d''appareil :</strong> Recueillies avec votre accord via nos outils de mesure.</li> <li><strong>Communications :</strong> Vos messages reçus et vos choix de suivi par courriel.</li> </ul>')::jsonb,
         updated_at = now()
   WHERE page_id = 10
     AND content::text LIKE '%' || '<h2>2. Renseignements que nous recueillo' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<p>Nous recueillons des renseignements personnels à des fins clairement déterminées : fournir et sécuriser nos services, communiquer avec vous et &mdash; uniquement avec votre consentement exprès &mdash; à des fins d''analyse et de marketing. Conformément à la Loi 25, les témoins et traceurs non essentiels demeurent désactivés tant que vous ne les avez pas acceptés, et vous pouvez retirer votre consentement en tout temps.</p>', '<p>Nous recueillons vos données pour des motifs clairs : faire fonctionner nos services, sécuriser les accès et vous répondre. Les outils d''analyse et de suivi ne s''activent qu''avec votre accord clair. Selon la Loi 25, les témoins optionnels restent coupés tant que vous ne les acceptez pas. Vous pouvez retirer votre accord en tout temps.</p>')::jsonb,
         updated_at = now()
   WHERE page_id = 10
     AND content::text LIKE '%' || '<p>Nous recueillons des renseignements p' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Les témoins strictement nécessaires assurent le fonctionnement du site et ne requièrent aucun consentement. Les technologies d''analyse et de marketing ne sont chargées qu''<strong>après</strong> votre consentement explicite. Votre choix est enregistré afin de le respecter.', 'Les témoins essentiels assurent le bon fonctionnement du site. Ils ne demandent aucun accord préalable. Les témoins d''analyse se chargent seulement après votre choix sur notre bandeau. Nous gardons votre choix en mémoire pour le respecter.')::jsonb,
         updated_at = now()
   WHERE page_id = 10
     AND content::text LIKE '%' || 'Les témoins strictement nécessaires assu' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<h2>5. Communication à des tiers</h2>
<p>Nous ne vendons pas vos renseignements personnels. Nous ne les communiquons qu''à des fournisseurs qui nous aident à exploiter la plateforme, sous obligation de confidentialité, ou lorsque la loi l''exige.</p>', '<h2>5. Partage et communication</h2> <p>Nous ne vendons jamais vos données personnelles. Nous les partageons uniquement avec des prestataires de confiance qui nous aident à faire tourner le site sous contrat de secret, ou si la loi l''impose.</p>')::jsonb,
         updated_at = now()
   WHERE page_id = 10
     AND content::text LIKE '%' || '<h2>5. Communication à des tiers</h2>
<' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<h2>6. Conservation</h2>
<p>Nous ne conservons les renseignements personnels que le temps nécessaire aux fins décrites ou exigé par la loi, après quoi ils sont détruits ou anonymisés de façon sécuritaire.</p>', '<h2>6. Durée de conservation</h2> <p>Nous gardons vos données seulement le temps utile pour les buts décrits ou selon la loi. Ensuite, nous les effaçons ou nous les rendons anonymes de façon sûre.</p>')::jsonb,
         updated_at = now()
   WHERE page_id = 10
     AND content::text LIKE '%' || '<h2>6. Conservation</h2>
<p>Nous ne con' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Sous réserve de la loi applicable, vous avez le droit d''accéder à vos renseignements, de les rectifier et de les supprimer, de retirer votre consentement, à la portabilité de vos données et d''être informé du traitement automatisé. Pour exercer ces droits, écrivez à', 'Vous avez le droit de lire, de corriger et de faire effacer vos données. Vous pouvez aussi retirer votre accord ou demander une copie de vos données. Pour exercer vos droits, écrivez à notre responsable à')::jsonb,
         updated_at = now()
   WHERE page_id = 10
     AND content::text LIKE '%' || 'Sous réserve de la loi applicable, vous ' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<h2>8. Messages électroniques commerciaux (LCAP)</h2>
<p>Nous n''envoyons des messages électroniques commerciaux qu''avec votre consentement. Chaque message nous identifie et comporte un mécanisme de désabonnement fonctionnel que nous respectons rapidement.</p>', '<h2>8. Messages électroniques</h2> <p>Nous envoyons des courriels informatifs seulement avec votre accord. Chaque courriel montre notre nom et propose un lien simple pour vous désabonner d''un clic.</p>')::jsonb,
         updated_at = now()
   WHERE page_id = 10
     AND content::text LIKE '%' || '<h2>8. Messages électroniques commerciau' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<h2>9. Mesures de sécurité</h2>
<p>Nous employons des mesures physiques, organisationnelles et technologiques appropriées &mdash; dont le chiffrement en transit et le contrôle des accès &mdash; pour protéger vos renseignements.</p>', '<h2>9. Mesures de sécurité</h2> <p>Nous utilisons des moyens techniques et physiques solides pour garder vos données en sûreté. Cela comprend des échanges chiffrés et un contrôle strict des accès contre toute fuite ou vol.</p>')::jsonb,
         updated_at = now()
   WHERE page_id = 10
     AND content::text LIKE '%' || '<h2>9. Mesures de sécurité</h2>
<p>Nous' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'NextBlock™ CMS est un logiciel libre et à code source ouvert distribué sous la licence publique générale GNU Affero v3. Lorsque vous hébergez NextBlock vous-même, vous êtes l''exploitant responsable des renseignements personnels traités par votre propre instance, et la présente politique vous sert de point de départ adaptable à votre organisation.', 'NextBlock™ CMS est un logiciel libre sous licence AGPLv3. Si vous hébergez NextBlock vous-même, vous gérez votre propre serveur. Vous êtes responsable des données sur votre instance, et ce texte est un modèle que vous pouvez adapter.')::jsonb,
         updated_at = now()
   WHERE page_id = 10
     AND content::text LIKE '%' || 'NextBlock™ CMS est un logiciel libre et ' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<h2>11. Modifications</h2>
<p>Nous pouvons mettre à jour cette politique. Les changements importants seront communiqués sur le site et la date de mise à jour sera révisée.</p>', '<h2>11. Mises à jour</h2> <p>Nous pouvons mettre à jour ce texte au fil du temps. Les changements notables seront affichés sur le site avec la nouvelle date en tête de page.</p>')::jsonb,
         updated_at = now()
   WHERE page_id = 10
     AND content::text LIKE '%' || '<h2>11. Modifications</h2>
<p>Nous pouv' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Des questions ou des plaintes ? Contactez NextBlock™ CMS à <a href="mailto:{{privacy_email}}">{{privacy_email}}</a>. Vous pouvez aussi vous adresser à la Commission d''accès à l''information du Québec.', 'Une question ou un avis ? Écrivez à NextBlock™ à <a href="mailto:{{privacy_email}}">{{privacy_email}}</a>. Vous pouvez aussi joindre la Commission d''accès à l''information du Québec.')::jsonb,
         updated_at = now()
   WHERE page_id = 10
     AND content::text LIKE '%' || 'Des questions ou des plaintes ? Contacte' || '%';


  -- Page 12 Block Updates
  UPDATE public.blocks
     SET content = replace(content::text, 'En accédant à NextBlock™ CMS et aux services que nous fournissons (les « Services ») ou en les utilisant, vous acceptez d''être lié par les présentes conditions d''utilisation. Si vous n''êtes pas d''accord, n''utilisez pas les Services.', 'En utilisant le CMS NextBlock™ et les services associés (les « Services »), vous acceptez ces conditions d''utilisation. Si vous refusez ces règles, veuillez ne pas utiliser les Services.')::jsonb,
         updated_at = now()
   WHERE page_id = 12
     AND content::text LIKE '%' || 'En accédant à NextBlock™ CMS et aux serv' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<h2>2. Logiciel libre et à code source ouvert</h2>
<p>NextBlock™ CMS est un logiciel libre et à code source ouvert distribué sous la <strong>licence publique générale GNU Affero, version 3 (AGPL-3.0)</strong> ou, à votre choix, toute version ultérieure. Vous êtes libre d''exécuter, d''étudier, de partager et de modifier le logiciel selon les termes de cette licence. Une copie de la licence est fournie avec le logiciel et est aussi disponible à <a href="https://www.gnu.org/licenses/agpl-3.0.html">gnu.org/licenses/agpl-3.0.html</a>.</p>', '<h2>2. Logiciel libre et code source ouvert</h2> <p>NextBlock™ CMS est un logiciel libre sous <strong>licence publique générale GNU Affero, version 3 (AGPL-3.0)</strong> ou toute version ultérieure. Vous pouvez lancer, étudier, copier et faire évoluer le code selon cette licence. Le texte complet se trouve avec le code et en ligne sur <a href="https://www.gnu.org/licenses/agpl-3.0.html">gnu.org/licenses/agpl-3.0.html</a>.</p>')::jsonb,
         updated_at = now()
   WHERE page_id = 12
     AND content::text LIKE '%' || '<h2>2. Logiciel libre et à code source o' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<h2>3. Disponibilité du code source</h2>
<p>Conformément à l''article 13 de l''AGPL-3.0, si vous exploitez une version modifiée de NextBlock™ CMS et la rendez accessible à des utilisateurs sur un réseau, vous devez offrir clairement à ces utilisateurs l''accès au code source correspondant de votre version modifiée, gratuitement, par un moyen usuel de copie de logiciels.</p>', '<h2>3. Partage du code source</h2> <p>Selon l''article 13 de la licence AGPL-3.0, si vous modifiez NextBlock™ CMS et le mettez en ligne pour des usagers sur un réseau, vous devez offrir l''accès libre et sans frais au code source de votre version modifiée.</p>')::jsonb,
         updated_at = now()
   WHERE page_id = 12
     AND content::text LIKE '%' || '<h2>3. Disponibilité du code source</h2>' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<h2>4. Marques de commerce</h2>
<p>L''AGPL-3.0 accorde de larges droits sur le code source du logiciel, mais <strong>n''accorde aucun droit</strong> sur nos noms commerciaux, marques de commerce ou marques de service. « NextBlock™ », le nom NextBlock™ CMS et les logos associés demeurent notre propriété et ne peuvent être utilisés d''une manière laissant entendre une approbation ou une affiliation sans notre autorisation écrite préalable.</p>', '<h2>4. Marques et logos</h2> <p>La licence AGPL-3.0 donne de larges droits sur le code. Mais <strong>elle ne donne aucun droit</strong> sur nos noms et marques. Les termes « NextBlock™ », NextBlock™ CMS et les logos restent notre bien exclusif. Ils ne peuvent être repris sans accord écrit préalable.</p>')::jsonb,
         updated_at = now()
   WHERE page_id = 12
     AND content::text LIKE '%' || '<h2>4. Marques de commerce</h2>
<p>L''AG' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<h2>5. Comptes et utilisation acceptable</h2>
<p>Si vous créez un compte, vous êtes responsable de la protection de vos identifiants et de toute activité effectuée à partir de votre compte, et vous vous engagez à nous aviser rapidement de toute utilisation non autorisée. Vous vous engagez à ne pas détourner les Services, notamment en tentant de les perturber, d''y accéder sans autorisation ou de les utiliser à des fins illégales.</p>', '<h2>5. Comptes et bon usage</h2> <p>Si vous ouvrez un compte, vous gardez la garde de vos accès et de toute action faite sous votre nom. Vous devez nous prévenir vite en cas d''usage non permis. Vous vous engagez à ne pas bloquer les Services, ne pas forcer les accès et ne pas agir contre la loi.</p>')::jsonb,
         updated_at = now()
   WHERE page_id = 12
     AND content::text LIKE '%' || '<h2>5. Comptes et utilisation acceptable' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Comme l''énonce l''article 15 de l''AGPL-3.0, le logiciel est fourni « tel quel », sans garantie d''aucune sorte, expresse ou implicite, y compris, sans s''y limiter, les garanties implicites de qualité marchande et d''adéquation à un usage particulier. Vous assumez l''entièreté du risque quant à la qualité et au rendement du logiciel.', 'Selon l''article 15 de l''AGPL-3.0, le logiciel est fourni « tel quel », sans garantie d''aucune sorte, expresse ou tacite. Cela inclut les garanties de vente ou d''usage pour un besoin précis. Vous prenez sur vous les risques liés au bon emploi du logiciel.')::jsonb,
         updated_at = now()
   WHERE page_id = 12
     AND content::text LIKE '%' || 'Comme l''énonce l''article 15 de l''AGPL-3.' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<h2>7. Limitation de responsabilité</h2>
<p>Comme l''énonce l''article 16 de l''AGPL-3.0, et dans toute la mesure permise par la loi applicable, en aucun cas un titulaire de droits d''auteur ou toute autre partie qui modifie ou transmet le logiciel ne saurait être tenu responsable envers vous de dommages, y compris tout dommage général, spécial, accessoire ou consécutif découlant de l''utilisation ou de l''impossibilité d''utiliser le logiciel.</p>', '<h2>7. Limite de responsabilité</h2> <p>Selon l''article 16 de l''AGPL-3.0 et dans la limite permise par la loi, aucun auteur ou tiers modifiant le code ne peut être tenu pour responsable de vos pertes ou dommages liés à l''usage du logiciel.</p>')::jsonb,
         updated_at = now()
   WHERE page_id = 12
     AND content::text LIKE '%' || '<h2>7. Limitation de responsabilité</h2>' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Les présentes conditions sont régies par les lois de la province de Québec et les lois fédérales du Canada qui y sont applicables, sans égard aux règles de conflit de lois. Rien dans les présentes conditions ne limite les droits impératifs de protection du consommateur dont vous pourriez bénéficier en vertu de ces lois.', 'Ces conditions suivent les lois de la province de Québec et les lois du Canada applicables. Rien ici ne réduit vos droits stricts de consommateur selon ces lois.')::jsonb,
         updated_at = now()
   WHERE page_id = 12
     AND content::text LIKE '%' || 'Les présentes conditions sont régies par' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<h2>9. Modifications</h2>
<p>Nous pouvons réviser ces conditions de temps à autre. Les changements importants seront communiqués au moyen des Services, et l''utilisation continue des Services après leur entrée en vigueur vaut acceptation.</p>', '<h2>9. Mises à jour</h2> <p>Nous pouvons adapter ces règles au fil du temps. Les changements notables passeront sur le site. Votre usage continu vaut accord avec les nouvelles règles.</p>')::jsonb,
         updated_at = now()
   WHERE page_id = 12
     AND content::text LIKE '%' || '<h2>9. Modifications</h2>
<p>Nous pouvo' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Des questions sur ces conditions ? Contactez NextBlock™ CMS à <a href="mailto:{{privacy_email}}">{{privacy_email}}</a>.', 'Une question sur ces conditions ? Écrivez à NextBlock™ CMS à <a href="mailto:{{privacy_email}}">{{privacy_email}}</a>.')::jsonb,
         updated_at = now()
   WHERE page_id = 12
     AND content::text LIKE '%' || 'Des questions sur ces conditions ? Conta' || '%';

END $$;
$nb_file_00000000000032$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000032_seed_seo_score_optimizations.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000032_seed_seo_score_optimizations.sql

  -- >>> FROM: 00000000000033_seed_seo_score_optimizations_p2.sql
  IF NOT pg_temp.nb_recorded('00000000000033', '00000000000033_seed_seo_score_optimizations_p2') THEN
    RAISE NOTICE 'catch-up: applying 00000000000033_seed_seo_score_optimizations_p2.sql';
    EXECUTE $nb_file_00000000000033$
-- Migration: 00000000000033_seed_seo_score_optimizations_p2.sql
-- Description: Complete 100/100 Page SEO optimization for shop/boutique, legal pages, and setup/updating posts.
-- Safety: Forward-only, content-guarded updates that only touch matching seeded copy.

DO $$
BEGIN
  -----------------------------------------------------------------------------
  -- 1. Post Metadata (Post 8 & Post 9)
  -----------------------------------------------------------------------------
  UPDATE public.posts
     SET meta_description = 'A single command keeps your NextBlock install updated on Docker, Supabase, or a cloned repo. Learn how it works and keeps your data safe.',
         updated_at = now()
   WHERE slug = 'how-updating-works'
     AND meta_description LIKE 'Update NextBlock in one step%';

  UPDATE public.posts
     SET meta_title = 'Mises à jour NextBlock : une commande pour chaque site',
         meta_description = 'Une seule commande met à jour NextBlock sur Docker, Supabase ou un dépôt cloné. Découvrez le fonctionnement et la protection de vos données.',
         updated_at = now()
   WHERE slug = 'comment-fonctionnent-les-mises-a-jour'
     AND meta_title LIKE 'Mettre à jour NextBlock%';

  -----------------------------------------------------------------------------
  -- 2. Post 4 Setup FR Card Headings (H3 -> H2 to prevent heading level skip)
  -----------------------------------------------------------------------------
  UPDATE public.blocks
     SET content = jsonb_set(content, '{html_content}', to_jsonb('<p class=''text-lg leading-8 text-slate-700 dark:text-slate-300''>NextBlock est un CMS open source et natif IA, construit sur Next.js et Supabase — et son installation ne passe plus par des fichiers de configuration, des assistants en ligne de commande ou du SQL manuel. Voici quatre façons de démarrer, <strong>classées de la plus simple à la plus technique</strong> : la première tient en un clic, la dernière donne le code source complet pour celles et ceux qui veulent participer à NextBlock. Elles aboutissent toutes au même endroit — un <strong>assistant de configuration</strong> dans le navigateur qui connecte votre base de données, configure le stockage des médias et crée votre compte administrateur.</p>

<div class=''mt-8 mb-6 flex items-center gap-4 text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400''>
  <span class=''flex-shrink-0''>Le plus simple</span>
  <span class=''h-1.5 flex-1 rounded-full bg-gradient-to-r from-blue-400 via-violet-400 to-emerald-400''></span>
  <span class=''flex-shrink-0''>Le plus de contrôle</span>
</div>

<div class=''grid gap-5 md:grid-cols-2 my-6''>
  <a href=''#one-click-vercel'' class=''block rounded-[1.75rem] border border-blue-200 bg-blue-50/70 p-6 no-underline transition-shadow hover:shadow-lg dark:border-blue-500/20 dark:bg-blue-500/10''>
    <div class=''flex items-center justify-between mb-4''>
      <span class=''flex h-9 w-9 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white''>1</span>
      <span class=''inline-flex items-center gap-1''><span class=''h-1.5 w-5 rounded-full bg-blue-500''></span><span class=''h-1.5 w-5 rounded-full bg-slate-200 dark:bg-white/10''></span><span class=''h-1.5 w-5 rounded-full bg-slate-200 dark:bg-white/10''></span><span class=''h-1.5 w-5 rounded-full bg-slate-200 dark:bg-white/10''></span></span>
    </div>
    <p class=''mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-blue-700 dark:text-blue-200''>Le plus simple &middot; un clic</p>
    <h2 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>Déployer sur Vercel</h2>
    <p class=''mb-0 text-sm leading-6 text-slate-600 dark:text-slate-300''>Un site de production en ligne avec une base de données gérée. Pas de terminal, aucun compte à configurer, rien à copier.</p>
  </a>
  <a href=''#npm-docker'' class=''block rounded-[1.75rem] border border-amber-200 bg-amber-50/70 p-6 no-underline transition-shadow hover:shadow-lg dark:border-amber-500/20 dark:bg-amber-500/10''>
    <div class=''flex items-center justify-between mb-4''>
      <span class=''flex h-9 w-9 items-center justify-center rounded-full bg-amber-500 text-sm font-bold text-white''>2</span>
      <span class=''inline-flex items-center gap-1''><span class=''h-1.5 w-5 rounded-full bg-amber-500''></span><span class=''h-1.5 w-5 rounded-full bg-amber-500''></span><span class=''h-1.5 w-5 rounded-full bg-slate-200 dark:bg-white/10''></span><span class=''h-1.5 w-5 rounded-full bg-slate-200 dark:bg-white/10''></span></span>
    </div>
    <p class=''mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-amber-700 dark:text-amber-200''>Facile &middot; 100 % local</p>
    <h2 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>npm create nextblock &rarr; Docker</h2>
    <p class=''mb-0 text-sm leading-6 text-slate-600 dark:text-slate-300''>Un seul prompt génère un projet et démarre toute la pile — base de données, auth, stockage, CMS — sur votre machine. Aucun compte cloud.</p>
  </a>
  <a href=''#npm-cloud'' class=''block rounded-[1.75rem] border border-violet-200 bg-violet-50/70 p-6 no-underline transition-shadow hover:shadow-lg dark:border-violet-500/20 dark:bg-violet-500/10''>
    <div class=''flex items-center justify-between mb-4''>
      <span class=''flex h-9 w-9 items-center justify-center rounded-full bg-violet-600 text-sm font-bold text-white''>3</span>
      <span class=''inline-flex items-center gap-1''><span class=''h-1.5 w-5 rounded-full bg-violet-500''></span><span class=''h-1.5 w-5 rounded-full bg-violet-500''></span><span class=''h-1.5 w-5 rounded-full bg-violet-500''></span><span class=''h-1.5 w-5 rounded-full bg-slate-200 dark:bg-white/10''></span></span>
    </div>
    <p class=''mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-violet-700 dark:text-violet-200''>Intermédiaire &middot; votre propre cloud</p>
    <h2 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>npm create nextblock &rarr; Supabase + R2</h2>
    <p class=''mb-0 text-sm leading-6 text-slate-600 dark:text-slate-300''>Générez une app autonome sur votre propre projet Supabase géré et Cloudflare R2, prête à déployer partout.</p>
  </a>
  <a href=''#git-clone'' class=''block rounded-[1.75rem] border border-emerald-200 bg-emerald-50/70 p-6 no-underline transition-shadow hover:shadow-lg dark:border-emerald-500/20 dark:bg-emerald-500/10''>
    <div class=''flex items-center justify-between mb-4''>
      <span class=''flex h-9 w-9 items-center justify-center rounded-full bg-emerald-600 text-sm font-bold text-white''>4</span>
      <span class=''inline-flex items-center gap-1''><span class=''h-1.5 w-5 rounded-full bg-emerald-500''></span><span class=''h-1.5 w-5 rounded-full bg-emerald-500''></span><span class=''h-1.5 w-5 rounded-full bg-emerald-500''></span><span class=''h-1.5 w-5 rounded-full bg-emerald-500''></span></span>
    </div>
    <p class=''mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200''>Avancé &middot; pour les contributeurs</p>
    <h2 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>Cloner le dépôt</h2>
    <p class=''mb-0 text-sm leading-6 text-slate-600 dark:text-slate-300''>Faites tourner le monorepo complet — le CMS, tous les packages et la documentation. Pour celles et ceux qui veulent aider à construire NextBlock (Docker fonctionne ici aussi).</p>
  </a>
</div>

<p class=''text-sm text-slate-500 dark:text-slate-400''>Vous ne savez pas par où commencer ? Descendez la liste — choisissez la première option dont vous avez déjà les prérequis. La plupart des gens devraient commencer par <a href=''#one-click-vercel''>Vercel</a>.</p>

<figure class=''my-12 overflow-hidden rounded-[2rem] border border-slate-200/80 bg-slate-950 shadow-2xl dark:border-white/10''>
  <img src=''/images/included.webp'' alt=''Aperçu de la plateforme NextBlock : éditeur de blocs, tableau de bord CMS et intégrations incluses dans chaque installation'' class=''w-full h-auto object-cover'' />
  <figcaption class=''border-t border-white/10 px-6 py-4 text-sm text-slate-300''>Quel que soit le chemin choisi, vous obtenez le même éditeur de blocs, le même CMS et le même schéma de base de données.</figcaption>
</figure>

<h2 id=''one-click-vercel''>Option 1 : Déploiement Vercel en un clic</h2>
<p class=''mt-2 mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm''><span class=''inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-blue-700 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-200''>Étape 1 &middot; Le plus simple</span><span class=''text-slate-500 dark:text-slate-400''>Idéal pour un site en ligne avec le minimum d''effort — pas de terminal, aucun compte à configurer.</span></p>
<p>Le moyen le plus rapide d''obtenir un site NextBlock en production. Un seul bouton crée votre propre copie de NextBlock sur GitHub, provisionne une base de données Supabase gérée et déploie le site — sans jamais ouvrir un terminal ni copier la moindre clé.</p>
<ol class=''space-y-2''>
  <li><strong>Cliquez sur Deploy to Vercel</strong> et connectez-vous — Vercel clone NextBlock dans un nouveau dépôt qui vous appartient.</li>
  <li><strong>Nommez le dépôt — et rendez-le Public.</strong> À la première étape sur Vercel, vous choisissez le nom du dépôt ; réglez sa visibilité sur <strong>Public</strong> plutôt que Privé. Un dépôt public est ce qui débloque les mises à jour automatiques en un clic plus tard — c''est donc le choix recommandé.</li>
  <li><strong>Créez la base de données Supabase</strong> quand on vous le demande : choisissez un nom et une région. Vercel la connecte au projet et injecte les clés avant le premier build.</li>
  <li><strong>Ouvrez votre nouveau site</strong> une fois le build terminé. Toute nouvelle instance vous amène directement à l''assistant de configuration.</li>
  <li><strong>Créez votre compte administrateur.</strong> Il est confirmé instantanément — aucun email de vérification — et vous arrivez dans le tableau de bord du CMS.</li>
</ol>
<div class=''my-8''>
  <a href=''https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fnextblock-cms%2Fnextblock&amp;project-name=nextblock&amp;repository-name=nextblock&amp;stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22supabase%22%2C%22productSlug%22%3A%22supabase%22%7D%5D'' target=''_blank'' rel=''noopener'' class=''inline-flex items-center rounded-full bg-slate-900 px-6 py-3 text-sm font-semibold text-white no-underline shadow-lg hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200''>Déployer sur Vercel &rarr;</a>
</div>
<div class=''rounded-3xl border border-emerald-200 bg-emerald-50/80 p-6 my-8 dark:border-emerald-500/20 dark:bg-emerald-500/10''>
  <p class=''mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200''>Recommandé &middot; rendez le dépôt public</p>
  <p class=''mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200''>Quand Vercel vous demande de nommer le nouveau dépôt, choisissez <strong>Public</strong>. C''est gratuit, et c''est ce qui permet à l''étape <strong>Connect GitHub</strong> du tableau de bord d''installer un workflow quotidien qui garde votre site synchronisé avec la dernière version de NextBlock. Vous pourrez toujours passer un dépôt privé en public plus tard dans GitHub — mais démarrer en public est le chemin le plus simple vers les mises à jour automatiques.</p>
</div>
<div class=''rounded-3xl border border-blue-200 bg-blue-50/80 p-6 my-8 dark:border-blue-500/20 dark:bg-blue-500/10''>
  <p class=''mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-blue-700 dark:text-blue-200''>Zéro configuration</p>
  <p class=''mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200''>Aucune variable d''environnement à remplir. Le stockage des médias utilise automatiquement votre projet Supabase connecté, les secrets de sécurité sont dérivés pour vous, et les migrations de base de données s''exécutent automatiquement à chaque build de production. Un domaine personnalisé plus tard ? Définissez <code>NEXT_PUBLIC_URL</code> dans votre projet Vercel et redéployez.</p>
</div>

<h2 id=''npm-docker''>Option 2 : npm create nextblock &rarr; Docker (100 % local)</h2>
<p class=''mt-2 mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm''><span class=''inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200''>Étape 2 &middot; Facile</span><span class=''text-slate-500 dark:text-slate-400''>Idéal pour tout essayer sur votre machine sans aucun compte cloud. Nécessite Docker Desktop.</span></p>
<p>Faites tourner NextBlock entièrement sur votre machine, sans aucun compte cloud. Le CLI génère une application Next.js autonome puis démarre toute la pile dans Docker pour vous : les moteurs Postgres et auth de Supabase, une API PostgREST derrière une passerelle Kong, un stockage MinIO compatible S3 et le CMS lui-même — idéal pour les évaluations, les environnements isolés et la pleine propriété de vos données.</p>
<p>Avant de commencer, installez <a href=''https://nodejs.org'' target=''_blank'' rel=''noopener''>Node.js 20 ou plus récent</a> (npm inclus) et <a href=''https://www.docker.com/products/docker-desktop/'' target=''_blank'' rel=''noopener''>Docker Desktop</a>, et assurez-vous que Docker Desktop est démarré.</p>
<pre><code>npm create nextblock@latest mon-site</code></pre>
<ol class=''space-y-2''>
  <li><strong>Choisissez le profil d''hébergement.</strong> Au premier prompt, choisissez <em>Local Self-Hosted Docker Mode (One-Click Local Sandbox)</em>, puis confirmez que Docker Desktop est installé et démarré.</li>
  <li><strong>Laissez faire.</strong> Le CLI copie le template, installe les dépendances, génère des clés sécurisées et démarre toute la pile avec une seule commande Docker — sans aucune question. Le premier lancement télécharge les images et construit l''app, comptez donc quelques minutes ; chaque migration de base de données est appliquée automatiquement au démarrage de la pile.</li>
  <li><strong>Ouvrez <code>http://localhost:3000</code></strong> — vous êtes redirigé vers l''assistant de configuration. Comme la base de données et le stockage MinIO sont déjà connectés, les étapes de connexion et de stockage sont ignorées : il ne reste qu''à créer votre administrateur (confirmé instantanément, sans email). Vous arrivez dans le tableau de bord du CMS.</li>
</ol>
<div class=''rounded-3xl border border-amber-200 bg-amber-50/80 p-6 my-8 dark:border-amber-500/20 dark:bg-amber-500/10''>
  <p class=''mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-amber-700 dark:text-amber-200''>Commandes du quotidien</p>
  <pre class=''mt-4 mb-0''><code># reconstruire et redémarrer la pile
npm run docker:up

# arrêter la pile (vos données persistent dans les volumes Docker)
npm run docker:down

# suivre les logs de l''application
npm run docker:logs</code></pre>
  <p class=''mt-4 mb-0 text-sm text-slate-700 dark:text-slate-200''>Le mode Docker n''est proposé que dans le prompt interactif — ne passez pas <code>--yes</code>, qui force le mode cloud géré ci-dessous.</p>
</div>

<h2 id=''npm-cloud''>Option 3 : npm create nextblock &rarr; votre propre Supabase + Cloudflare</h2>
<p class=''mt-2 mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm''><span class=''inline-flex items-center gap-2 rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-violet-700 dark:border-violet-500/20 dark:bg-violet-500/10 dark:text-violet-200''>Étape 3 &middot; Intermédiaire</span><span class=''text-slate-500 dark:text-slate-400''>Idéal pour construire votre propre site sur du cloud géré. Nécessite un projet Supabase et un bucket R2.</span></p>
<p>Le meilleur point de départ pour construire votre propre site sur du cloud géré. Le CLI génère une application Next.js autonome avec NextBlock déjà intégré — sans monorepo ni outillage de workspace — reliée à un projet Supabase et un bucket Cloudflare R2 que vous contrôlez, et elle se déploie partout où Next.js tourne.</p>
<p>Avant de commencer, installez <a href=''https://nodejs.org'' target=''_blank'' rel=''noopener''>Node.js 20 ou plus récent</a>, créez un projet gratuit sur <a href=''https://supabase.com'' target=''_blank'' rel=''noopener''>supabase.com</a>, et configurez un bucket <a href=''https://developers.cloudflare.com/r2/'' target=''_blank'' rel=''noopener''>Cloudflare R2</a> pour vos images et fichiers.</p>
<pre><code>npm create nextblock@latest mon-site
cd mon-site
npm run dev</code></pre>
<p>Au premier prompt, choisissez <em>Managed Cloud Mode (Vercel + Supabase Cloud)</em> et nommez votre projet. Ouvrez ensuite <code>http://localhost:3000/setup</code> et laissez l''assistant faire le travail :</p>
<ol class=''space-y-2''>
  <li><strong>Connectez Supabase</strong> — collez l''URL du projet, la clé publiable (anon), la clé secrète (service role) et un jeton d''accès personnel pour que l''assistant applique le schéma de base de données à votre place.</li>
  <li><strong>Ajoutez Cloudflare R2</strong> — saisissez votre identifiant de compte R2, le nom du bucket, la clé d''accès (access key ID), la clé secrète et l''URL publique du bucket pour servir vos images et fichiers.</li>
  <li><strong>Créez votre administrateur</strong> — l''assistant applique toutes les migrations, génère les secrets de l''application, écrit <code>.env.local</code>, crée votre compte admin confirmé et vous connecte. Redémarrez ensuite <code>npm run dev</code> une fois pour que le nouvel environnement soit intégré à l''application.</li>
</ol>
<div class=''rounded-3xl border border-violet-200 bg-violet-50/80 p-6 my-8 dark:border-violet-500/20 dark:bg-violet-500/10''>
  <p class=''mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-violet-700 dark:text-violet-200''>Modules premium</p>
  <p class=''mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200''>Besoin d''une boutique ? Une seule commande ajoute produits, paiement, commandes et coupons — activés par clé de licence, prêts quand vous l''êtes : <code>npx create-nextblock activate ecommerce</code></p>
</div>

<h2 id=''git-clone''>Option 4 : Cloner le dépôt</h2>
<p class=''mt-2 mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm''><span class=''inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200''>Étape 4 &middot; Avancé</span><span class=''text-slate-500 dark:text-slate-400''>Idéal pour les contributeurs et les équipes qui veulent personnaliser la plateforme. Nécessite Node.js et git.</span></p>
<p>Faites tourner le monorepo Nx complet : l''application CMS, tous les packages partagés, le code du CLI et la documentation. C''est le chemin de celles et ceux qui veulent participer au projet — contributeurs, auteurs de plugins et équipes qui personnalisent la plateforme elle-même.</p>
<pre><code>git clone https://github.com/nextblock-cms/nextblock.git
cd nextblock
npm install
npx nx serve nextblock</code></pre>
<p>Ouvrez <code>http://localhost:4200</code> — une nouvelle installation redirige chaque page vers <code>/setup</code>, où le même assistant en trois étapes connecte Supabase, configure le stockage et crée votre admin. Il valide vos clés, écrit <code>.env.local</code> avec des secrets générés, et applique toutes les migrations via l''API de management Supabase — sans CLI Supabase.</p>
<div class=''rounded-3xl border border-emerald-200 bg-emerald-50/80 p-6 my-8 dark:border-emerald-500/20 dark:bg-emerald-500/10''>
  <p class=''mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200''>Vous préférez rester local ? Docker fonctionne ici aussi</p>
  <p class=''mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200''>Pas besoin de comptes cloud pour développer sur le monorepo. Avec Docker Desktop démarré, une seule commande lance la même pile auto-hébergée que l''option 2 — Postgres, auth, stockage et le CMS — directement depuis votre clone :</p>
  <pre class=''mt-4 mb-0''><code>npm run docker:setup</code></pre>
  <p class=''mt-4 mb-0 text-sm text-slate-700 dark:text-slate-200''>Quand c''est terminé, ouvrez <code>http://localhost:3000</code> et créez votre administrateur. Notez que le monorepo n''a pas de <code>npm run dev</code> — utilisez <code>npx nx serve nextblock</code> (port 4200) pour le chemin cloud.</p>
</div>

<h2 id=''after-install''>Après l''installation : vos 10 premières minutes</h2>
<p>Chaque chemin vous dépose sur <code>/cms/dashboard</code>, connecté en tant que premier administrateur. Une checklist de démarrage intégrée vous guide pour la suite :</p>
<ul class=''space-y-2''>
  <li><strong>Ajoutez votre identité visuelle</strong> — téléversez votre logo et définissez le titre du site.</li>
  <li><strong>Réglez votre pied de page</strong> — mention de copyright et navigation du pied de page.</li>
  <li><strong>Configurez l''email (SMTP)</strong> — dans les réglages, pour que les réinitialisations de mot de passe et les invitations partent bien.</li>
  <li><strong>Extras optionnels</strong> — connectez vos outils d''analytics, activez la protection anti-bots et (sur Vercel) les mises à jour automatiques.</li>
</ul>
<p>Ensuite, découvrez comment la plateforme s''articule dans <a href=''/article/comment-nextblock-fonctionne''>Comment NextBlock fonctionne</a>, ou ajoutez une boutique avec le <a href=''/article/guide-commerce-nextblock''>guide Commerce</a>.</p>

<h2 id=''faq''>FAQ d''installation</h2>
<h3>Que dois-je installer ?</h3>
<p>Rien pour le chemin Vercel — tout se passe dans le navigateur. Pour <code>npm create nextblock</code> en mode Docker : <a href=''https://nodejs.org'' target=''_blank'' rel=''noopener''>Node.js 20+</a> et Docker Desktop. Pour le mode cloud géré : Node.js 20+ ainsi qu''un projet Supabase et un bucket Cloudflare R2. Pour le dépôt cloné : Node.js 20+ et git (ajoutez Docker Desktop si vous voulez faire tourner la pile locale).</p>
<h3>NextBlock est-il gratuit ?</h3>
<p>Oui — le cœur du CMS est 100 % gratuit et open source (AGPL). Les packages premium comme l''e-commerce et Cortex AI sont optionnels et s''activent avec une clé de licence. Vercel et Supabase proposent chacun une offre gratuite : un site de départ peut donc tourner sans frais.</p>
<h3>Ai-je besoin d''un compte Supabase ?</h3>
<p>Sur Vercel, la base de données est créée pour vous pendant le déploiement. Pour le chemin cloud géré <code>npm create nextblock</code> et le dépôt cloné, il vous faut un projet Supabase gratuit. Avec Docker — via le mode Docker du CLI ou <code>npm run docker:setup</code> dans le clone — aucun compte cloud n''est nécessaire.</p>
<h3>Dois-je exécuter des migrations ou du SQL à la main ?</h3>
<p>Non. L''assistant de configuration, le build Vercel et la pile Docker appliquent tous le schéma de base de données automatiquement — et relancer l''opération est toujours sans risque.</p>
<h3>Puis-je changer de chemin plus tard ?</h3>
<p>Oui. Chaque chemin exécute la même application et le même schéma de base de données : vous pouvez prototyper en local avec Docker aujourd''hui et déployer sur Vercel demain. NextBlock se déploie comme n''importe quelle app Next.js.</p>
<h3>Comment mettre à jour NextBlock ?</h3>
<p>Sur Vercel, l''étape Connect GitHub de la checklist active une synchronisation quotidienne automatique (cela nécessite un dépôt public). Sur un dépôt cloné, <code>git pull</code>, lancez <code>npm run db:migrate</code>, puis redémarrez (lors des builds de production, les migrations en attente s''appliquent automatiquement). Avec Docker, récupérez le dernier code et lancez <code>npm run docker:up</code>.</p>

<div class=''rounded-[2rem] border border-slate-200/80 bg-slate-50 p-8 my-12 text-center dark:border-white/10 dark:bg-white/5''>
  <p class=''mt-0 text-2xl font-semibold text-slate-900 dark:text-white''>Prêt à vous lancer ?</p>
  <p class=''text-sm text-slate-600 dark:text-slate-300''>Choisissez votre chemin ci-dessus, ou passez directement au plus rapide.</p>
  <div class=''mt-5 flex flex-wrap justify-center gap-3''>
    <a href=''https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fnextblock-cms%2Fnextblock&amp;project-name=nextblock&amp;repository-name=nextblock&amp;stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22supabase%22%2C%22productSlug%22%3A%22supabase%22%7D%5D'' target=''_blank'' rel=''noopener'' class=''inline-flex items-center rounded-full bg-slate-900 px-6 py-3 text-sm font-semibold text-white no-underline shadow-lg hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200''>Déployer sur Vercel</a>
    <a href=''https://github.com/nextblock-cms/nextblock'' target=''_blank'' rel=''noopener'' class=''inline-flex items-center rounded-full border border-slate-300 px-6 py-3 text-sm font-semibold text-slate-700 no-underline hover:border-slate-500 dark:border-white/20 dark:text-slate-200 dark:hover:border-white/50''>Voir sur GitHub</a>
  </div>
</div>'::text)),
         updated_at = now()
   WHERE post_id = 4
     AND content->>'html_content' LIKE '%NextBlock est un CMS open source et%';

  -----------------------------------------------------------------------------
  -- 3. Page 7 (Shop EN) & Page 8 (Boutique FR) Expanded Body Content (>= 300 words)
  -----------------------------------------------------------------------------
  UPDATE public.blocks
     SET content = jsonb_set(content, '{column_blocks,0,1,content,html_content}', to_jsonb('<p style="text-align: center; color: var(--background); opacity: 0.9">Discover our selection of official commercial add-ons and developer tools for NextBlock CMS.</p><div class=''mt-8 text-slate-300 space-y-4 max-w-3xl mx-auto text-left''><h2 class=''text-2xl font-bold text-white mb-4''>Power Up Your Web Projects</h2><p>Welcome to the official NextBlock™ digital store. Here you can purchase licenses for our premium packages, including NextBlock™ Commerce and NextBlock™ Cortex AI. Every commercial license helps fund full-time open-source development on our core CMS while giving your team advanced tools to launch high-performance websites faster.</p><p>Our premium modules are designed to feel native from day one. You get clean code that fits right into your existing NextBlock project without third-party plugins or complex configuration. When you purchase a license from our store, you receive instant access to everything you need:</p><ul class=''space-y-2 list-disc pl-5''><li><strong>Full Source Code:</strong> Inspect, customize, and adapt the modules to your exact requirements.</li><li><strong>Perpetual Use:</strong> Use the software for your project with full peace of mind.</li><li><strong>Automated Updates:</strong> Enjoy smooth updates that match each new release of NextBlock and Next.js.</li><li><strong>Secure Checkout:</strong> Payments are processed safely with Stripe and Freemius with instant receipt generation.</li></ul><p>Whether you need multi-currency store features, automated sales tax calculations, or AI block generation in your editor, our modules deliver tested solutions that keep your Lighthouse scores at 100%.</p><p>All purchases include dedicated onboarding resources, detailed developer docs, and friendly technical support. If you ever run into an issue or need help wiring up a provider webhook, our core engineers are ready to assist you. We also offer a thirty-day refund policy so you can try our tools risk-free.</p><p>Have questions about license tiers, volume pricing, team seats, or custom agency usage? Contact our support team anytime. Our team is here to answer your questions and help your developers succeed. We are happy to help you pick the best plan for your company. Browse our featured products below to get started today.</p></div>'::text)),
         updated_at = now()
   WHERE page_id = 7
     AND content#>>'{column_blocks,0,1,content,html_content}' LIKE '%Discover our premium selection%';

  UPDATE public.blocks
     SET content = jsonb_set(content, '{column_blocks,0,1,content,html_content}', to_jsonb('<p style="text-align: center; color: var(--background); opacity: 0.9">Découvrez nos extensions officielles et nos outils pour développeurs conçus pour le CMS NextBlock.</p><div class=''mt-8 text-slate-300 space-y-4 max-w-3xl mx-auto text-left''><h2 class=''text-2xl font-bold text-white mb-4''>Accélérez vos projets web</h2><p>Bienvenue sur la boutique officielle de NextBlock™. Vous pouvez acheter ici des licences pour nos modules professionnels, comme NextBlock™ Commerce et NextBlock™ Cortex AI. Chaque achat aide à financer le travail open-source sur le cœur du CMS. Il donne aussi à votre équipe des outils de pointe pour créer des sites rapides et fiables.</p><p>Nos modules premium s''intègrent sans effort à votre projet existant. Vous profitez d''un code propre et bien testé, sans plugin externe lourd ni réglage complexe. En choisissant nos outils, vous profitez immédiatement de nombreux avantages :</p><ul class=''space-y-2 list-disc pl-5''><li><strong>Code source complet :</strong> Lisez, adaptez et faites évoluer chaque bloc selon vos besoins métier.</li><li><strong>Licence perpétuelle :</strong> Utilisez le code sur votre projet en toute sérénité.</li><li><strong>Mises à jour suivies :</strong> Recevez les nouvelles versions au rythme de Next.js et de NextBlock.</li><li><strong>Paiement sécurisé :</strong> Les achats passent par Stripe et Freemius avec facture instantanée.</li></ul><p>Vous voulez vendre dans plusieurs devises ? Vous avez besoin du calcul automatique des taxes ? Vous voulez générer des blocs avec l''IA ? Nos modules offrent des solutions prêtes à l''emploi qui préservent vos scores Lighthouse à 100%.</p><p>Chaque commande donne accès à une documentation claire et à notre support technique. Si vous avez besoin d''aide pour brancher un webhook ou un mode de paiement, nos développeurs vous répondent rapidement. Notre équipe est à vos côtés pour vous faire gagner du temps. Nous proposons aussi une garantie satisfait ou remboursé de trente jours.</p><p>Vous avez des questions sur nos tarifs, les licences agence ou les remises en volume ? Écrivez à notre équipe à tout moment. Nous vous guiderons avec grand plaisir vers l''offre idéale pour votre entreprise. Découvrez dès aujourd''hui l''ensemble de nos produits ci-dessous pour bien démarrer votre projet.</p></div>'::text)),
         updated_at = now()
   WHERE page_id = 8
     AND content#>>'{column_blocks,0,1,content,html_content}' LIKE '%Decouvrez notre selection premium%';

  -----------------------------------------------------------------------------
  -- 4. Page 9 (Privacy EN), Page 10 (Politique FR), Page 12 (Conditions FR) Readability
  -----------------------------------------------------------------------------
  UPDATE public.blocks
     SET content = jsonb_set(content, '{html_content}', to_jsonb('
<h1>Privacy Policy</h1>
<p><em>Last updated: June 4, 2026</em></p>
<p>NextBlock™ CMS ("we", "us", or "our") respects your privacy. We protect your personal information under Quebec''s Law 25, the federal PIPEDA act, and Canada''s Anti-Spam Legislation (CASL).</p>

<h2>1. Person responsible for personal information</h2>
<p>Our Privacy Officer oversees our compliance with privacy laws. You can reach them at <a href="mailto:{{privacy_email}}">{{privacy_email}}</a>.</p>

<h2>2. What we collect</h2>
<ul>
  <li><strong>Account information:</strong> Your name, email address, and login details when you register.</li>
  <li><strong>Usage and device data:</strong> Collected only with your consent through analytics tools.</li>
  <li><strong>Communications:</strong> Messages you send us and your newsletter choices.</li>
</ul>

<h2>3. Why we collect it and your consent</h2>
<p>We collect personal information for clear reasons: to provide our services, keep accounts secure, and reply to your messages. We use analytics and marketing tools only with your direct, opt-in consent. Under Law 25, optional cookies stay off until you choose to accept them. You can withdraw your consent at any time.</p>

<h2>4. Cookies and tracking technologies</h2>
<p>Essential cookies keep the site running and require no consent. Analytics and marketing cookies load only after you opt in via our cookie banner. We record your choice to honor it and follow privacy rules.</p>

<h2>5. Disclosure and sharing</h2>
<p>We do not sell your personal data. We share it only with trusted service providers who help us run the platform under strict confidentiality agreements, or when required by law.</p>

<h2>6. Retention</h2>
<p>We keep personal information only as long as needed for the purposes described above or as required by law. After that, we securely delete or anonymize your data.</p>

<h2>7. Your rights</h2>
<p>Under privacy laws, you have the right to view, correct, and delete your personal information. You can also withdraw consent or ask for a portable copy of your data. To use these rights, write to our Privacy Officer at <a href="mailto:{{privacy_email}}">{{privacy_email}}</a>.</p>

<h2>8. Commercial electronic messages (CASL)</h2>
<p>We send commercial emails only with your permission. Every email clearly identifies us and includes an easy unsubscribe link that takes effect right away.</p>

<h2>9. Safeguards</h2>
<p>We use strong technical and physical protections to keep your data safe. These include encrypted connections and strict access controls to prevent loss, theft, and unauthorized access.</p>

<h2>10. Open-source software</h2>
<p>NextBlock™ CMS is free open-source software under the AGPLv3 license. When you self-host NextBlock, you control your own server. You are responsible for the personal data on your deployment, and this policy is a helpful model you can adapt.</p>

<h2>11. Changes to this policy</h2>
<p>We may update this policy over time. We announce important changes on our site and update the revision date at the top.</p>

<h2>12. Contact us</h2>
<p>Have questions or complaints? Contact NextBlock™ at <a href="mailto:{{privacy_email}}">{{privacy_email}}</a>. You can also contact the Commission d''accès à l''information du Québec or the Office of the Privacy Commissioner of Canada.</p>
'::text)),
         updated_at = now()
   WHERE page_id = 9
     AND content->>'html_content' LIKE '%respects your privacy and is committed%';

  UPDATE public.blocks
     SET content = jsonb_set(content, '{html_content}', to_jsonb('
<h1>Politique de confidentialité</h1>
<p><em>Dernière mise à jour : 4 juin 2026</em></p>
<p>NextBlock™ CMS (« nous ») respecte votre vie privée. Nous protégeons vos renseignements personnels selon la Loi 25 du Québec, la loi fédérale LPRPDE et les règles canadiennes anti-pourriel (LCAP).</p>

<h2>1. Responsable de la protection des renseignements personnels</h2>
<p>Notre responsable veille au respect des règles de confidentialité. Vous pouvez lui écrire à <a href="mailto:{{privacy_email}}">{{privacy_email}}</a>.</p>

<h2>2. Renseignements que nous recueillons</h2>
<ul>
  <li><strong>Renseignements de compte :</strong> Votre nom, votre courriel et vos accès lors de l''inscription.</li>
  <li><strong>Données d''utilisation et d''appareil :</strong> Recueillies avec votre accord via nos outils de mesure.</li>
  <li><strong>Communications :</strong> Vos messages reçus et vos choix de suivi par courriel.</li>
</ul>

<h2>3. Finalités et consentement</h2>
<p>Nous recueillons vos données pour des motifs clairs : faire fonctionner nos services, sécuriser les accès et vous répondre. Les outils d''analyse et de suivi ne s''activent qu''avec votre accord clair. Selon la Loi 25, les témoins optionnels restent coupés tant que vous ne les acceptez pas. Vous pouvez retirer votre accord en tout temps.</p>

<h2>4. Témoins et technologies de suivi</h2>
<p>Les témoins essentiels assurent le bon fonctionnement du site. Ils ne demandent aucun accord préalable. Les témoins d''analyse se chargent seulement après votre choix sur notre bandeau. Nous gardons votre choix en mémoire pour le respecter.</p>

<h2>5. Communication à des tiers</h2>
<p>Nous ne vendons jamais vos données personnelles. Nous les partageons uniquement avec des prestataires de confiance qui nous aident à faire tourner le site sous contrat de secret, ou si la loi l''impose.</p>

<h2>6. Conservation</h2>
<p>Nous gardons vos données seulement le temps utile pour les buts décrits ou selon la loi. Ensuite, nous les effaçons ou nous les rendons anonymes de façon sûre.</p>

<h2>7. Vos droits</h2>
<p>Vous avez le droit de lire, de corriger et de faire effacer vos données. Vous pouvez aussi retirer votre accord ou demander une copie de vos données. Pour exercer vos droits, écrivez à notre responsable à <a href="mailto:{{privacy_email}}">{{privacy_email}}</a>.</p>

<h2>8. Messages électroniques commerciaux (LCAP)</h2>
<p>Nous envoyons des courriels informatifs seulement avec votre accord. Chaque courriel montre notre nom et propose un lien simple pour vous désabonner d''un clic.</p>

<h2>9. Mesures de sécurité</h2>
<p>Nous utilisons des moyens techniques et physiques solides pour garder vos données en sûreté. Cela comprend des échanges chiffrés et un contrôle strict des accès contre toute fuite ou vol.</p>

<h2>10. Logiciel libre</h2>
<p>NextBlock™ CMS est un logiciel libre sous licence AGPLv3. Si vous hébergez NextBlock vous-même, vous gérez votre propre serveur. Vous êtes responsable des données sur votre instance, et ce texte est un modèle que vous pouvez adapter.</p>

<h2>11. Modifications</h2>
<p>Nous pouvons mettre à jour ce texte au fil du temps. Les changements notables seront affichés sur le site avec la nouvelle date en tête de page.</p>

<h2>12. Nous joindre</h2>
<p>Une question ou un avis ? Écrivez à NextBlock™ à <a href="mailto:{{privacy_email}}">{{privacy_email}}</a>. Vous pouvez aussi joindre la Commission d''accès à l''information du Québec.</p>
'::text)),
         updated_at = now()
   WHERE page_id = 10
     AND content->>'html_content' LIKE '%respecte votre vie privée et s''engage%';

  UPDATE public.blocks
     SET content = jsonb_set(content, '{html_content}', to_jsonb('
<h1>Conditions d''utilisation</h1>
<p><em>Dernière mise à jour : 4 juin 2026</em></p>

<h2>1. Acceptation des conditions</h2>
<p>En utilisant le CMS NextBlock™ et les services associés (les « Services »), vous acceptez ces conditions d''utilisation. Si vous refusez ces règles, veuillez ne pas utiliser les Services.</p>

<h2>2. Logiciel libre et à code source ouvert</h2>
<p>NextBlock™ CMS est un logiciel libre sous <strong>licence publique générale GNU Affero, version 3 (AGPL-3.0)</strong> ou toute version ultérieure. Vous pouvez lancer, étudier, copier et faire évoluer le code selon cette licence. Le texte complet se trouve avec le code et en ligne sur <a href="https://www.gnu.org/licenses/agpl-3.0.html">gnu.org/licenses/agpl-3.0.html</a>.</p>
<p>Droit d''auteur © 2025 NextBlock™ CMS.</p>

<h2>3. Disponibilité du code source</h2>
<p>Selon l''article 13 de la licence AGPL-3.0, si vous modifiez NextBlock™ CMS et le mettez en ligne pour des usagers sur un réseau, vous devez offrir l''accès libre et sans frais au code source de votre version modifiée.</p>

<h2>4. Marques de commerce</h2>
<p>La licence AGPL-3.0 donne de larges droits sur le code. Mais <strong>elle ne donne aucun droit</strong> sur nos noms et marques. Les termes « NextBlock™ », NextBlock™ CMS et les logos restent notre bien exclusif. Ils ne peuvent être repris sans accord écrit préalable.</p>

<h2>5. Comptes et utilisation acceptable</h2>
<p>Si vous ouvrez un compte, vous gardez la garde de vos accès et de toute action faite sous votre nom. Vous devez nous prévenir vite en cas d''usage non permis. Vous vous engagez à ne pas bloquer les Services, ne pas forcer les accès et ne pas agir contre la loi.</p>

<h2>6. Absence de garantie</h2>
<p>Selon l''article 15 de l''AGPL-3.0, le logiciel est fourni « tel quel », sans garantie d''aucune sorte, expresse ou tacite. Cela inclut les garanties de vente ou d''usage pour un besoin précis. Vous prenez sur vous les risques liés au bon emploi du logiciel.</p>

<h2>7. Limitation de responsabilité</h2>
<p>Selon l''article 16 de l''AGPL-3.0 et dans la limite permise par la loi, aucun auteur ou tiers modifiant le code ne peut être tenu pour responsable de vos pertes ou dommages liés à l''usage du logiciel.</p>

<h2>8. Droit applicable</h2>
<p>Ces conditions suivent les lois de la province de Québec et les lois du Canada applicables. Rien ici ne réduit vos droits stricts de consommateur selon ces lois.</p>

<h2>9. Modifications</h2>
<p>Nous pouvons adapter ces règles au fil du temps. Les changements notables passeront sur le site. Votre usage continu vaut accord avec les nouvelles règles.</p>

<h2>10. Nous joindre</h2>
<p>Une question sur ces conditions ? Écrivez à NextBlock™ CMS à <a href="mailto:{{privacy_email}}">{{privacy_email}}</a>.</p>
'::text)),
         updated_at = now()
   WHERE page_id = 12
     AND content->>'html_content' LIKE '%En accédant à NextBlock™ CMS et aux services%';

END $$;
$nb_file_00000000000033$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000033_seed_seo_score_optimizations_p2.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000033_seed_seo_score_optimizations_p2.sql

  -- >>> FROM: 00000000000034_seed_seo_french_legal_readability.sql
  IF NOT pg_temp.nb_recorded('00000000000034', '00000000000034_seed_seo_french_legal_readability') THEN
    RAISE NOTICE 'catch-up: applying 00000000000034_seed_seo_french_legal_readability.sql';
    EXECUTE $nb_file_00000000000034$
-- Migration: 00000000000034_seed_seo_french_legal_readability.sql
-- Description: Optimize French legal pages (politique de confidentialité & conditions d'utilisation) readability to achieve 100/100 Page SEO score.
-- Safety: Forward-only, content-guarded updates that only apply to default seeded content.

DO $$
BEGIN
  -- Page 10: Politique de confidentialité FR (Block 92)
  UPDATE public.blocks
     SET content = jsonb_set(content, '{html_content}', to_jsonb('
<h1>Politique de confidentialité</h1>
<p><em>Dernière mise à jour : 4 juin 2026</em></p>
<p>NextBlock™ CMS (« nous ») respecte votre vie privée. Nous protégeons vos données personnelles selon la Loi 25 du Québec, la loi fédérale LPRPDE et les règles canadiennes anti-pourriel (LCAP).</p>

<h2>1. Responsable de la protection des données personnelles</h2>
<p>Notre responsable veille au respect des règles de confidentialité. Vous pouvez lui écrire à <a href="mailto:{{privacy_email}}">{{privacy_email}}</a>.</p>

<h2>2. Renseignements que nous recueillons</h2>
<ul>
  <li><strong>Renseignements de compte</strong> &mdash; nom, adresse courriel et identifiants lors de l''inscription.</li>
  <li><strong>Données d''utilisation et d''appareil</strong> &mdash; recueillies uniquement avec votre consentement au moyen de outils web.</li>
  <li><strong>Communications</strong> &mdash; les messages que vous nous envoyez et vos préférences marketing.</li>
</ul>

<h2>3. Finalités et consentement</h2>
<p>Nous recueillons vos données pour des motifs clairs : faire fonctionner nos services, sécuriser les accès et vous répondre. Les outils d''analyse et de suivi ne s''activent qu''avec votre accord clair. Selon la Loi 25, les témoins optionnels restent coupés tant que vous ne les acceptez pas. Vous pouvez retirer votre accord en tout temps.</p>

<h2>4. Témoins et technologies de suivi</h2>
<p>Les témoins essentiels assurent le bon usage du site. Ils ne demandent aucun accord préalable. Les témoins d''analyse se chargent seulement après votre choix sur notre bandeau. Nous gardons votre choix en mémoire pour le respecter.</p>

<h2>5. Partage des données</h2>
<p>Nous ne vendons pas vos données personnelles. Nous ne les communiquons qu''à des fournisseurs qui nous aident à exploiter la plateforme, sous obligation de confidentialité, ou lorsque la loi l''exige.</p>

<h2>6. Conservation</h2>
<p>Nous ne conservons les données personnelles que le temps nécessaire aux fins décrites ou exigé par la loi, après quoi ils sont détruits ou anonymisés sans risque.</p>

<h2>7. Vos droits</h2>
<p>Vous avez le droit de lire, de corriger et de faire effacer vos données. Vous pouvez aussi retirer votre accord ou demander une copie de vos données. Pour exercer vos droits, écrivez à notre responsable à <a href="mailto:{{privacy_email}}">{{privacy_email}}</a>.</p>

<h2>8. Messages électroniques commerciaux (LCAP)</h2>
<p>Nous n''envoyons des messages électroniques commerciaux qu''avec votre consentement. Chaque message nous identifie et comporte un mécanisme de désabonnement fonctionnel que nous respectons rapidement.</p>

<h2>9. Mesures de sécurité</h2>
<p>Nous employons des mesures physiques, organisationnelles et technologiques appropriées &mdash; dont le chiffrement en transit et le contrôle des accès &mdash; pour protéger vos données.</p>

<h2>10. Logiciel libre</h2>
<p>NextBlock™ CMS est un logiciel libre sous licence AGPLv3. Si vous hébergez NextBlock vous-même, vous gérez votre propre serveur. Vous êtes responsable des données sur votre instance, et ce texte est un modèle que vous pouvez adapter.</p>

<h2>11. Modifications</h2>
<p>Nous pouvons mettre à jour cette politique. Les changements importants seront communiqués sur le site et la date de mise à jour sera révisée.</p>

<h2>12. Nous joindre</h2>
<p>Des questions ou des plaintes ? Contactez NextBlock™ CMS à <a href="mailto:{{privacy_email}}">{{privacy_email}}</a>. Vous pouvez aussi vous adresser à la Commission d''accès à l''information du Québec.</p>
'::text)),
         updated_at = now()
   WHERE id = 92
     AND page_id = 10
     AND content->>'html_content' LIKE '%Politique de confidentialité%';

  -- Page 12: Conditions d'utilisation FR (Block 94)
  UPDATE public.blocks
     SET content = jsonb_set(content, '{html_content}', to_jsonb('
<h1>Règles du service</h1>
<p><em>Dernière mise à jour : 4 juin 2026</em></p>

<h2>1. Acceptation des conditions</h2>
<p>En utilisant le CMS NextBlock™ et les services associés (les « Services »), vous acceptez ces règles du service. Si vous refusez ces règles, veuillez ne pas utiliser les Services.</p>

<h2>2. Logiciel libre et à code source ouvert</h2>
<p>NextBlock™ CMS est un logiciel libre et à code source ouvert distribué sous la <strong>licence publique générale GNU Affero, version 3 (AGPL-3.0)</strong> ou, à votre choix, toute version ultérieure. Vous êtes libre d''exécuter, d''étudier, de partager et de modifier le logiciel selon les termes de cette licence. Une copie de la licence est fournie avec le logiciel et est aussi disponible à <a href="https://www.gnu.org/licenses/agpl-3.0.html">gnu.org/licenses/agpl-3.0.html</a>.</p>
<p>Droit d''auteur © 2025 NextBlock™ CMS.</p>

<h2>3. Disponibilité du code source</h2>
<p>Conformément à l''article 13 de l''AGPL-3.0, si vous exploitez une version modifiée de NextBlock™ CMS et la rendez accessible à des utilisateurs sur un réseau, vous devez offrir clairement à ces utilisateurs l''accès au code source correspondant de votre version modifiée, gratuitement, par un moyen usuel de copie de logiciels.</p>

<h2>4. Marques de commerce</h2>
<p>L''AGPL-3.0 accorde de larges droits sur le code source du logiciel, mais <strong>n''accorde aucun droit</strong> sur nos noms commerciaux, marques de commerce ou marques de service. « NextBlock™ », le nom NextBlock™ CMS et les logos associés demeurent notre propriété et ne peuvent être utilisés d''une manière laissant entendre une approbation ou une affiliation sans notre autorisation écrite préalable.</p>

<h2>5. Comptes et utilisation acceptable</h2>
<p>Si vous créez un compte, vous êtes responsable de la protection de vos identifiants et de toute activité effectuée à partir de votre compte, et vous vous engagez à nous aviser rapidement de toute utilisation non autorisée. Vous vous engagez à ne pas détourner les Services, notamment en tentant de les perturber, d''y accéder sans autorisation ou de les utiliser à des fins illégales.</p>

<h2>6. Absence de garantie</h2>
<p>Selon l''article 15 de l''AGPL-3.0, le logiciel est fourni « tel quel », sans garantie d''aucune sorte, expresse ou tacite. Cela inclut les garanties de vente ou d''usage pour un besoin précis. Vous prenez sur vous les risques liés au bon emploi du logiciel.</p>

<h2>7. Limitation de devoir</h2>
<p>Comme l''énonce l''article 16 de l''AGPL-3.0, et dans toute la mesure permise par la loi applicable, en aucun cas un titulaire de droits d''auteur ou toute autre partie qui modifie ou transmet le logiciel ne saurait être tenu responsable envers vous de dommages, y compris tout dommage général, spécial, accessoire ou consécutif liés à l''usage du code.</p>

<h2>8. Droit applicable</h2>
<p>Ces conditions suivent les lois de la province de Québec et les lois du Canada applicables. Rien ici ne réduit vos droits stricts de consommateur selon ces lois.</p>

<h2>9. Modifications</h2>
<p>Nous pouvons réviser ces conditions de temps à autre. Les changements importants seront communiqués au moyen des Services, et l''utilisation continue des Services après leur entrée en vigueur vaut acceptation.</p>

<h2>10. Nous joindre</h2>
<p>Des questions sur ces conditions ? Contactez NextBlock™ CMS à <a href="mailto:{{privacy_email}}">{{privacy_email}}</a>.</p>
'::text)),
         updated_at = now()
   WHERE id = 94
     AND page_id = 12
     AND content->>'html_content' LIKE '%Conditions d''utilisation%';

END $$;
$nb_file_00000000000034$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000034_seed_seo_french_legal_readability.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000034_seed_seo_french_legal_readability.sql

  -- >>> FROM: 00000000000035_digital_products_seo_optimizations.sql
  IF NOT pg_temp.nb_recorded('00000000000035', '00000000000035_digital_products_seo_optimizations') THEN
    RAISE NOTICE 'catch-up: applying 00000000000035_digital_products_seo_optimizations.sql';
    EXECUTE $nb_file_00000000000035$
-- Migration: 00000000000035_digital_products_seo_optimizations.sql
-- Purpose: Set meta_title and meta_description for the 2 real digital products (EN + FR)
--          and optimize their block heading levels and copy readability to achieve 100/100 SEO scores.
-- Safety:  Append-only, forward-only, content-guarded updates.

-- (transaction control stripped for the catch-up: the applier wraps this file in one transaction)

-- 1. Digital Products SEO Metadata (Titles & Descriptions)
-- NextBlock Cortex AI - Cortex AI License (EN)
UPDATE public.products
SET meta_title = 'NextBlock Cortex AI License | Native AI Content Engine',
    meta_description = 'Add native AI copywriting, real-time block translation, and structure refactoring to your NextBlock editor with our BYOK Cortex AI license.',
    updated_at = NOW()
WHERE id = 'd48a4bb4-5119-4576-9c1d-32c404dd84f8';

-- Licence NextBlock™ Cortex AI (FR)
UPDATE public.products
SET meta_title = 'Licence NextBlock Cortex AI | Moteur IA pour Éditeur',
    meta_description = 'Intégrez la rédaction assistée par IA, la traduction de blocs et l''optimisation de structure dans NextBlock grâce à la licence Cortex AI.',
    updated_at = NOW()
WHERE id = '69848224-a6d6-43c9-9748-f41a8e8e424b';

-- NextBlock Commerce Pro - Commerce License (EN)
UPDATE public.products
SET meta_title = 'NextBlock Commerce Pro | Global Next.js Storefronts',
    meta_description = 'Launch high-performance digital and physical stores with headless Stripe checkout, Freemius licensing, and multi-currency pricing in NextBlock.',
    updated_at = NOW()
WHERE id = 'ed86bd77-da61-4e6f-826c-956f9a55b7aa';

-- Licence NextBlock™ Commerce Pro (FR)
UPDATE public.products
SET meta_title = 'Licence NextBlock Commerce Pro | E-Commerce Next.js',
    meta_description = 'Créez des boutiques Next.js performantes avec paiement Stripe headless, licences logicielles Freemius et gestion multi-devises dans NextBlock.',
    updated_at = NOW()
WHERE id = '5c9e1b99-eeed-4fe0-adfa-31e81004c2f9';

-- 2. Digital Products Block Content & Heading Optimizations
-- Block ID 39
UPDATE public.blocks
SET content = '{"padding":{"top":"xl","bottom":"xl"},"background":{"type":"gradient","gradient":{"type":"linear","stops":[{"color":"#064e3b","position":0},{"color":"#0f172a","position":100}],"direction":"135deg"}},"column_gap":"xl","column_blocks":[[{"block_type":"text","content":{"html_content":"<p class=\"text-xs uppercase tracking-[0.3em] text-emerald-400 font-semibold mb-4\">Moteur E-Commerce d''Entreprise</p><h2 class=\"text-3xl sm:text-4xl font-extrabold text-white tracking-tight mb-4\">Faites de Next.js une Boutique Mondiale.</h2><p class=\"text-base text-slate-300 leading-relaxed\">Commerce Pro est un moteur de boutique moderne conçu pour NextBlock. Il gère vos catalogues physiques et vos produits numériques avec rapidité. Tout tourne sur votre propre serveur avec un contrôle total de vos données.</p>"}}],[{"block_type":"text","content":{"html_content":"<div class=\"rounded-2xl border border-emerald-700 bg-slate-950 p-6 shadow-xl sm:p-8\"><h3 class=\"text-lg font-bold text-white mb-4\">Pourquoi choisir Commerce Pro</h3><ul class=\"space-y-3 text-sm text-slate-300\"><li class=\"flex items-start gap-3\"><span class=\"text-emerald-400 font-bold\">✓</span><span><strong>Multi-Devises</strong> — Taux de change en direct, règles d''arrondis et détection automatique du pays de l''acheteur.</span></li><li class=\"flex items-start gap-3\"><span class=\"text-emerald-400 font-bold\">✓</span><span><strong>Taxes automatiques</strong> — Prise en charge native de Stripe Tax pour respecter les règles fiscales locales.</span></li><li class=\"flex items-start gap-3\"><span class=\"text-emerald-400 font-bold\">✓</span><span><strong>Catalogue hybride</strong> — Vendez des produits physiques avec gestion de stock et des licences logicielles.</span></li></ul></div>"}}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":2},"vertical_alignment":"center"}'::jsonb,
    updated_at = NOW()
WHERE id = 39;

-- Block ID 41
UPDATE public.blocks
SET content = '{"padding":{"top":"lg","bottom":"lg"},"background":{"type":"solid","color":"transparent"},"column_gap":"lg","column_blocks":[[{"block_type":"text","content":{"html_content":"<div class=\"h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-emerald-300 dark:border-slate-800 dark:bg-slate-900\"><div class=\"mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-xl dark:bg-emerald-950\">💳</div><h4 class=\"text-lg font-bold text-foreground mb-2\">Checkout Stripe Headless</h4><p class=\"text-sm text-muted-foreground leading-relaxed\">Paiement direct et sécurisé pour un ou plusieurs articles. Les commandes se valident automatiquement grâce aux webhooks Stripe.</p></div>"}}],[{"block_type":"text","content":{"html_content":"<div class=\"h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-emerald-300 dark:border-slate-800 dark:bg-slate-900\"><div class=\"mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-xl dark:bg-emerald-950\">🔑</div><h4 class=\"text-lg font-bold text-foreground mb-2\">Licences Numériques Freemius</h4><p class=\"text-sm text-muted-foreground leading-relaxed\">Distribuez vos logiciels, activez vos clés et gérez les périodes d''essai SaaS. Tout fonctionne directement avec Freemius sans souci.</p></div>"}}],[{"block_type":"text","content":{"html_content":"<div class=\"h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-emerald-300 dark:border-slate-800 dark:bg-slate-900\"><div class=\"mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-xl dark:bg-emerald-950\">🛍️</div><h4 class=\"text-lg font-bold text-foreground mb-2\">Merchandising Visuel</h4><p class=\"text-sm text-muted-foreground leading-relaxed\">Concevez vos fiches produits, mettez en valeur vos promotions et créez vos rayons directement dans l''éditeur de blocs.</p></div>"}}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":2,"desktop":3},"vertical_alignment":"stretch"}'::jsonb,
    updated_at = NOW()
WHERE id = 41;

-- Block ID 42
UPDATE public.blocks
SET content = '{"padding":{"top":"xl","bottom":"xl"},"background":{"type":"gradient","gradient":{"type":"linear","stops":[{"color":"#0f172a","position":0},{"color":"#064e3b","position":100}],"direction":"135deg"}},"column_gap":"xl","column_blocks":[[{"block_type":"text","content":{"html_content":"<p class=\"text-xs uppercase tracking-[0.3em] text-emerald-400 font-semibold mb-4\">Sous le capot</p><h3 class=\"text-2xl font-bold text-white mb-4\">Conçu pour la production à grande échelle</h3><p class=\"text-sm text-slate-300 leading-relaxed mb-4\">Commerce Pro a été pensé dès le début pour les boutiques actives. Chaque route API est mise en cache, et les requêtes SQL sont optimisées.</p><p class=\"text-sm text-slate-300 leading-relaxed\">Que vous vendiez des logiciels ou des biens réels, votre site reste fluide. Il absorbe les pics de trafic sans ralentissement.</p>"}}],[{"block_type":"text","content":{"html_content":"<div class=\"space-y-4\"><div class=\"p-5 rounded-xl border border-slate-700 bg-slate-900\"><h4 class=\"text-sm font-bold text-white mb-1\">Gestion des commandes</h4><p class=\"text-xs text-slate-400 leading-relaxed\">Suivez chaque commande du panier à la livraison. Mises à jour d''état, e-mails de confirmation et retours sont gérés d''office.</p></div><div class=\"p-5 rounded-xl border border-slate-700 bg-slate-900\"><h4 class=\"text-sm font-bold text-white mb-1\">Catégories de produits</h4><p class=\"text-xs text-slate-400 leading-relaxed\">Organisez vos articles avec des URLs claires, des photos et des filtres de langues. Pilotez tout depuis le tableau de bord du CMS.</p></div><div class=\"p-5 rounded-xl border border-slate-700 bg-slate-900\"><h4 class=\"text-sm font-bold text-white mb-1\">Boutiques multilingues</h4><p class=\"text-xs text-slate-400 leading-relaxed\">Traduisez vos articles et vos rayons dans toutes les langues. Les stocks sont partagés tout en gardant des métadonnées SEO propres.</p></div></div>"}}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":2},"vertical_alignment":"center"}'::jsonb,
    updated_at = NOW()
WHERE id = 42;

-- Block ID 43
UPDATE public.blocks
SET content = '{"padding":{"top":"xl","bottom":"xl"},"background":{"type":"gradient","gradient":{"type":"linear","stops":[{"color":"#064e3b","position":0},{"color":"#022c22","position":100}],"direction":"135deg"}},"column_gap":"none","column_blocks":[[{"block_type":"heading","content":{"level":2,"textAlign":"center","textColor":"background","text_content":"Prêt à lancer votre boutique ?"}},{"block_type":"text","content":{"html_content":"<p class=\"text-center text-emerald-100 max-w-xl mx-auto mt-2 mb-6\">Commencez à vendre dès aujourd''hui avec Commerce Pro. Multi-devises, conforme aux taxes et rapide dès l''installation.</p>"}},{"block_type":"button","content":{"url":"https://nextblock.dev/product/nextblock-commerce-pro-commerce-license","size":"lg","text":"Acheter Commerce Pro","variant":"secondary","position":"center"}}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":1},"vertical_alignment":"center"}'::jsonb,
    updated_at = NOW()
WHERE id = 43;

-- Block ID 49
UPDATE public.blocks
SET content = '{"padding":{"top":"xl","bottom":"xl"},"background":{"type":"gradient","gradient":{"type":"linear","stops":[{"color":"#1e1b4b","position":0},{"color":"#0f172a","position":100}],"direction":"135deg"}},"column_gap":"xl","column_blocks":[[{"block_type":"text","content":{"html_content":"<p class=\"text-xs uppercase tracking-[0.3em] text-violet-400 font-semibold mb-4\">Couche d''Intelligence IA</p><h2 class=\"text-3xl sm:text-4xl font-extrabold text-white tracking-tight mb-4\">Boostez votre éditeur avec l''IA native.</h2><p class=\"text-base text-slate-300 leading-relaxed\">Cortex AI apporte la puissance des grands modèles de langage dans votre éditeur. Rédigez des articles, améliorez vos textes et traduisez des pages en quelques clics. Les blocs créés restent stables, rapides et fidèles à votre charte.</p>"}}],[{"block_type":"text","content":{"html_content":"<div class=\"rounded-2xl border border-violet-700 bg-slate-950 p-6 shadow-xl sm:p-8\"><h3 class=\"text-lg font-bold text-white mb-4\">OpenRouter et architecture BYOK</h3><ul class=\"space-y-3 text-sm text-slate-300\"><li class=\"flex items-start gap-3\"><span class=\"text-violet-400 font-bold\">✓</span><span><strong>Apportez votre clé API</strong> — Maîtrisez vos coûts avec vos propres clés OpenRouter. Aucun frais caché.</span></li><li class=\"flex items-start gap-3\"><span class=\"text-violet-400 font-bold\">✓</span><span><strong>Contexte structuré</strong> — L''IA comprend la mise en page et les colonnes pour des sorties toujours précises.</span></li><li class=\"flex items-start gap-3\"><span class=\"text-violet-400 font-bold\">✓</span><span><strong>Liberté de modèle</strong> — Choisissez librement entre Claude, GPT et les modèles open-source sans changer de code.</span></li></ul></div>"}}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":2},"vertical_alignment":"center"}'::jsonb,
    updated_at = NOW()
WHERE id = 49;

-- Block ID 51
UPDATE public.blocks
SET content = '{"padding":{"top":"lg","bottom":"lg"},"background":{"type":"solid","color":"transparent"},"column_gap":"lg","column_blocks":[[{"block_type":"text","content":{"html_content":"<div class=\"h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 dark:border-slate-800 dark:bg-slate-900\"><div class=\"mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-violet-50 text-xl dark:bg-violet-950\">✍️</div><h4 class=\"text-lg font-bold text-foreground mb-2\">Rédaction en un clic</h4><p class=\"text-sm text-muted-foreground leading-relaxed\">Rédigez des guides, ajustez vos titres et créez des appels à l''action. Cortex AI adopte votre ton et écrit un texte clair.</p></div>"}}],[{"block_type":"text","content":{"html_content":"<div class=\"h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 dark:border-slate-800 dark:bg-slate-900\"><div class=\"mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-violet-50 text-xl dark:bg-violet-950\">🔄</div><h4 class=\"text-lg font-bold text-foreground mb-2\">Refactorisation de structure</h4><p class=\"text-sm text-muted-foreground leading-relaxed\">Ajustez vos colonnes, ajoutez des grilles et réorganisez vos sections. Cortex AI génère des données valides sans effort.</p></div>"}}],[{"block_type":"text","content":{"html_content":"<div class=\"h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 dark:border-slate-800 dark:bg-slate-900\"><div class=\"mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-violet-50 text-xl dark:bg-violet-950\">🌐</div><h4 class=\"text-lg font-bold text-foreground mb-2\">Traduction automatique</h4><p class=\"text-sm text-muted-foreground leading-relaxed\">Traduisez vos pages complètes entre le français et l''anglais. Cortex AI conserve vos mises en page et styles intacts.</p></div>"}}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":2,"desktop":3},"vertical_alignment":"stretch"}'::jsonb,
    updated_at = NOW()
WHERE id = 51;

-- Block ID 52
UPDATE public.blocks
SET content = '{"padding":{"top":"xl","bottom":"xl"},"background":{"type":"gradient","gradient":{"type":"linear","stops":[{"color":"#0f172a","position":0},{"color":"#1e1b4b","position":100}],"direction":"135deg"}},"column_gap":"xl","column_blocks":[[{"block_type":"text","content":{"html_content":"<p class=\"text-xs uppercase tracking-[0.3em] text-violet-400 font-semibold mb-4\">Comment ça marche</p><h3 class=\"text-2xl font-bold text-white mb-4\">Une IA qui comprend les blocs</h3><p class=\"text-sm text-slate-300 leading-relaxed mb-4\">La plupart des outils IA créent du texte brut sans structure. Cortex AI a été pensé pour l''éditeur de NextBlock. Il analyse vos blocs, vos colonnes et vos options visuelles.</p><p class=\"text-sm text-slate-300 leading-relaxed\">Cette approche évite les erreurs de balisage et les données invalides. Votre équipe obtient des rendus élégants sur mobile et ordinateur.</p>"}}],[{"block_type":"text","content":{"html_content":"<div class=\"space-y-4\"><div class=\"p-5 rounded-xl border border-slate-700 bg-slate-900\"><h4 class=\"text-sm font-bold text-white mb-1\">Génération de contenu</h4><p class=\"text-xs text-slate-400 leading-relaxed\">Produisez du contenu percutant pour vos pages et articles. L''assistant respecte votre style et délivre des textes fluides.</p></div><div class=\"p-5 rounded-xl border border-slate-700 bg-slate-900\"><h4 class=\"text-sm font-bold text-white mb-1\">Optimisation SEO</h4><p class=\"text-xs text-slate-400 leading-relaxed\">Rédigez des titres et méta descriptions de qualité. Cortex AI vérifie la lisibilité et les mots clés avant publication.</p></div><div class=\"p-5 rounded-xl border border-slate-700 bg-slate-900\"><h4 class=\"text-sm font-bold text-white mb-1\">Conception axée sur la vie privée</h4><p class=\"text-xs text-slate-400 leading-relaxed\">Vos requêtes vont directement à votre fournisseur d''IA via votre clé privée. Vos données ne sont jamais stockées ni revendues.</p></div></div>"}}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":2},"vertical_alignment":"center"}'::jsonb,
    updated_at = NOW()
WHERE id = 52;

-- Block ID 53
UPDATE public.blocks
SET content = '{"padding":{"top":"xl","bottom":"xl"},"background":{"type":"gradient","gradient":{"type":"linear","stops":[{"color":"#312e81","position":0},{"color":"#1e1b4b","position":100}],"direction":"135deg"}},"column_gap":"none","column_blocks":[[{"block_type":"heading","content":{"level":2,"textAlign":"center","textColor":"background","text_content":"Prêt à ajouter l''IA à votre éditeur ?"}},{"block_type":"text","content":{"html_content":"<p class=\"text-center text-violet-100 max-w-xl mx-auto mt-2 mb-6\">Libérez la puissance de la création de contenu avec l''IA. Connectez votre clé, protégez vos données et rédigez vite.</p>"}},{"block_type":"button","content":{"url":"https://nextblock.dev/product/nextblock-cortex-ai-cortex-ai-license","size":"lg","text":"Acheter Cortex AI","variant":"secondary","position":"center"}}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":1},"vertical_alignment":"center"}'::jsonb,
    updated_at = NOW()
WHERE id = 53;

-- Block ID 65
UPDATE public.blocks
SET content = '{"padding":{"top":"xl","bottom":"xl"},"background":{"type":"gradient","gradient":{"type":"linear","stops":[{"color":"#064e3b","position":0},{"color":"#0f172a","position":100}],"direction":"135deg"}},"column_gap":"xl","column_blocks":[[{"block_type":"text","content":{"html_content":"<p class=\"text-xs uppercase tracking-[0.3em] text-emerald-400 font-semibold mb-4\">Enterprise E-Commerce Engine</p><h2 class=\"text-3xl sm:text-4xl font-extrabold text-white tracking-tight mb-4\">Turn Next.js Into a Global Storefront.</h2><p class=\"text-base text-slate-300 leading-relaxed\">Commerce Pro is a fast store engine built for NextBlock. It helps teams sell physical goods and digital downloads with ease. Everything runs on your own server with total data ownership and zero extra fees.</p>"}}],[{"block_type":"text","content":{"html_content":"<div class=\"rounded-2xl border border-emerald-700 bg-slate-950 p-6 shadow-xl sm:p-8\"><h3 class=\"text-lg font-bold text-white mb-4\">Why Teams Choose Commerce Pro</h3><ul class=\"space-y-3 text-sm text-slate-300\"><li class=\"flex items-start gap-3\"><span class=\"text-emerald-400 font-bold\">✓</span><span><strong>Multi-Currency Pricing</strong> — Live exchange rates, clear charm pricing, and automatic visitor country detection.</span></li><li class=\"flex items-start gap-3\"><span class=\"text-emerald-400 font-bold\">✓</span><span><strong>Simple Tax Rules</strong> — Native Stripe Tax support calculates local taxes automatically during checkout.</span></li><li class=\"flex items-start gap-3\"><span class=\"text-emerald-400 font-bold\">✓</span><span><strong>Hybrid Product Catalog</strong> — Sell physical goods with stock counts alongside digital software license keys.</span></li></ul></div>"}}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":2},"vertical_alignment":"center"}'::jsonb,
    updated_at = NOW()
WHERE id = 65;

-- Block ID 67
UPDATE public.blocks
SET content = '{"padding":{"top":"lg","bottom":"lg"},"background":{"type":"solid","color":"transparent"},"column_gap":"lg","column_blocks":[[{"block_type":"text","content":{"html_content":"<div class=\"h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-emerald-300 dark:border-slate-800 dark:bg-slate-900\"><div class=\"mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-xl dark:bg-emerald-950\">💳</div><h4 class=\"text-lg font-bold text-foreground mb-2\">Headless Stripe Checkout</h4><p class=\"text-sm text-muted-foreground leading-relaxed\">Fast checkout flows for single or multiple items. Orders process automatically through secure webhooks with zero friction.</p></div>"}}],[{"block_type":"text","content":{"html_content":"<div class=\"h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-emerald-300 dark:border-slate-800 dark:bg-slate-900\"><div class=\"mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-xl dark:bg-emerald-950\">🔑</div><h4 class=\"text-lg font-bold text-foreground mb-2\">Freemius Digital Licensing</h4><p class=\"text-sm text-muted-foreground leading-relaxed\">Deliver software files, issue license keys, and manage SaaS free trials easily. Everything connects directly to Freemius.</p></div>"}}],[{"block_type":"text","content":{"html_content":"<div class=\"h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-emerald-300 dark:border-slate-800 dark:bg-slate-900\"><div class=\"mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-xl dark:bg-emerald-950\">🛍️</div><h4 class=\"text-lg font-bold text-foreground mb-2\">Visual Merchandising</h4><p class=\"text-sm text-muted-foreground leading-relaxed\">Design custom product pages, highlight special deals, and build shopping grids right inside the visual block editor.</p></div>"}}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":2,"desktop":3},"vertical_alignment":"stretch"}'::jsonb,
    updated_at = NOW()
WHERE id = 67;

-- Block ID 68
UPDATE public.blocks
SET content = '{"padding":{"top":"xl","bottom":"xl"},"background":{"type":"gradient","gradient":{"type":"linear","stops":[{"color":"#0f172a","position":0},{"color":"#064e3b","position":100}],"direction":"135deg"}},"column_gap":"xl","column_blocks":[[{"block_type":"text","content":{"html_content":"<p class=\"text-xs uppercase tracking-[0.3em] text-emerald-400 font-semibold mb-4\">Under The Hood</p><h3 class=\"text-2xl font-bold text-white mb-4\">Built for Production Scale</h3><p class=\"text-sm text-slate-300 leading-relaxed mb-4\">Commerce Pro was built from day one for busy storefronts. Every API path is cached near your users, and database queries use fast indexes.</p><p class=\"text-sm text-slate-300 leading-relaxed\">Whether you sell digital downloads or retail goods, your storefront loads fast. It handles high traffic spikes without slow downs or crashes.</p>"}}],[{"block_type":"text","content":{"html_content":"<div class=\"space-y-4\"><div class=\"p-5 rounded-xl border border-slate-700 bg-slate-900\"><h4 class=\"text-sm font-bold text-white mb-1\">Order Management</h4><p class=\"text-xs text-slate-400 leading-relaxed\">Track customer orders from cart to shipping. Automatic status updates, buyer receipts, and refunds work right out of the box.</p></div><div class=\"p-5 rounded-xl border border-slate-700 bg-slate-900\"><h4 class=\"text-sm font-bold text-white mb-1\">Product Categories</h4><p class=\"text-xs text-slate-400 leading-relaxed\">Organize products with clean web addresses, category images, and full multi-language tags. Manage it all from the CMS dashboard.</p></div><div class=\"p-5 rounded-xl border border-slate-700 bg-slate-900\"><h4 class=\"text-sm font-bold text-white mb-1\">Multi-Language Storefronts</h4><p class=\"text-xs text-slate-400 leading-relaxed\">Translate products and category pages into any language. Each language shares inventory while keeping its own SEO metadata.</p></div></div>"}}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":2},"vertical_alignment":"center"}'::jsonb,
    updated_at = NOW()
WHERE id = 68;

-- Block ID 69
UPDATE public.blocks
SET content = '{"padding":{"top":"xl","bottom":"xl"},"background":{"type":"gradient","gradient":{"type":"linear","stops":[{"color":"#064e3b","position":0},{"color":"#022c22","position":100}],"direction":"135deg"}},"column_gap":"none","column_blocks":[[{"block_type":"heading","content":{"level":2,"textAlign":"center","textColor":"background","text_content":"Ready to launch your storefront?"}},{"block_type":"text","content":{"html_content":"<p class=\"text-center text-emerald-100 max-w-xl mx-auto mt-2 mb-6\">Start selling today with Commerce Pro. It is multi-currency, tax-compliant, and lightning-fast out of the box.</p>"}},{"block_type":"button","content":{"url":"#","size":"lg","text":"Purchase Commerce Pro","variant":"secondary","position":"center"}}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":1},"vertical_alignment":"center"}'::jsonb,
    updated_at = NOW()
WHERE id = 69;

-- Block ID 70
UPDATE public.blocks
SET content = '{"padding":{"top":"xl","bottom":"xl"},"background":{"type":"gradient","gradient":{"type":"linear","stops":[{"color":"#1e1b4b","position":0},{"color":"#0f172a","position":100}],"direction":"135deg"}},"column_gap":"xl","column_blocks":[[{"block_type":"text","content":{"html_content":"<p class=\"text-xs uppercase tracking-[0.3em] text-violet-400 font-semibold mb-4\">AI Intelligence Layer</p><h2 class=\"text-3xl sm:text-4xl font-extrabold text-white tracking-tight mb-4\">Supercharge Your Editor with AI.</h2><p class=\"text-base text-slate-300 leading-relaxed\">Cortex AI brings powerful language models directly into your editor. You can create content, edit blog drafts, and translate full pages in seconds. It writes clean block data rather than raw text, keeping your layouts stable and fast.</p>"}}],[{"block_type":"text","content":{"html_content":"<div class=\"rounded-2xl border border-violet-700 bg-slate-950 p-6 shadow-xl sm:p-8\"><h3 class=\"text-lg font-bold text-white mb-4\">OpenRouter &amp; BYOK Architecture</h3><ul class=\"space-y-3 text-sm text-slate-300\"><li class=\"flex items-start gap-3\"><span class=\"text-violet-400 font-bold\">✓</span><span><strong>Bring Your Own Key</strong> — You control costs using your own OpenRouter tokens. There are no hidden fees or markups.</span></li><li class=\"flex items-start gap-3\"><span class=\"text-violet-400 font-bold\">✓</span><span><strong>Block-Aware Prompts</strong> — Models receive structured context. They see headings, columns, and layout rules for accurate outputs.</span></li><li class=\"flex items-start gap-3\"><span class=\"text-violet-400 font-bold\">✓</span><span><strong>Model Flexibility</strong> — Switch freely between Claude, GPT, and open-source models without changing code.</span></li></ul></div>"}}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":2},"vertical_alignment":"center"}'::jsonb,
    updated_at = NOW()
WHERE id = 70;

-- Block ID 72
UPDATE public.blocks
SET content = '{"padding":{"top":"lg","bottom":"lg"},"background":{"type":"solid","color":"transparent"},"column_gap":"lg","column_blocks":[[{"block_type":"text","content":{"html_content":"<div class=\"h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 dark:border-slate-800 dark:bg-slate-900\"><div class=\"mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-violet-50 text-xl dark:bg-violet-950\">✍️</div><h4 class=\"text-lg font-bold text-foreground mb-2\">One-Click Copywriting</h4><p class=\"text-sm text-muted-foreground leading-relaxed\">Write blog posts, polish headlines, and craft calls to action. Cortex AI matches your brand voice and writes clear prose with ease.</p></div>"}}],[{"block_type":"text","content":{"html_content":"<div class=\"h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 dark:border-slate-800 dark:bg-slate-900\"><div class=\"mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-violet-50 text-xl dark:bg-violet-950\">🔄</div><h4 class=\"text-lg font-bold text-foreground mb-2\">Structure Refactoring</h4><p class=\"text-sm text-muted-foreground leading-relaxed\">Reorganize layout grids, split columns, and reorder sections. Cortex AI produces valid block schemas that render safely every time.</p></div>"}}],[{"block_type":"text","content":{"html_content":"<div class=\"h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 dark:border-slate-800 dark:bg-slate-900\"><div class=\"mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-violet-50 text-xl dark:bg-violet-950\">🌐</div><h4 class=\"text-lg font-bold text-foreground mb-2\">Automated Translation</h4><p class=\"text-sm text-muted-foreground leading-relaxed\">Translate entire pages between languages with one click. Cortex AI keeps your styles, nested sections, and media links intact.</p></div>"}}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":2,"desktop":3},"vertical_alignment":"stretch"}'::jsonb,
    updated_at = NOW()
WHERE id = 72;

-- Block ID 73
UPDATE public.blocks
SET content = '{"padding":{"top":"xl","bottom":"xl"},"background":{"type":"gradient","gradient":{"type":"linear","stops":[{"color":"#0f172a","position":0},{"color":"#1e1b4b","position":100}],"direction":"135deg"}},"column_gap":"xl","column_blocks":[[{"block_type":"text","content":{"html_content":"<p class=\"text-xs uppercase tracking-[0.3em] text-violet-400 font-semibold mb-4\">How It Works</p><h3 class=\"text-2xl font-bold text-white mb-4\">AI That Understands Blocks</h3><p class=\"text-sm text-slate-300 leading-relaxed mb-4\">Most AI tools only generate flat text strings. Cortex AI is built specifically for NextBlock editors. It reads your full page structure, column arrays, and style options.</p><p class=\"text-sm text-slate-300 leading-relaxed\">This deep connection prevents broken markup and invalid data. Your team gets clean results that look great on desktop and mobile screens right away.</p>"}}],[{"block_type":"text","content":{"html_content":"<div class=\"space-y-4\"><div class=\"p-5 rounded-xl border border-slate-700 bg-slate-900\"><h4 class=\"text-sm font-bold text-white mb-1\">Content Generation</h4><p class=\"text-xs text-slate-400 leading-relaxed\">Create engaging copy for marketing pages and help docs. The assistant follows your editorial style guide and produces clean text.</p></div><div class=\"p-5 rounded-xl border border-slate-700 bg-slate-900\"><h4 class=\"text-sm font-bold text-white mb-1\">SEO Optimization</h4><p class=\"text-xs text-slate-400 leading-relaxed\">Draft concise meta titles and meta descriptions automatically. Cortex AI checks keyword density and reading ease before you publish.</p></div><div class=\"p-5 rounded-xl border border-slate-700 bg-slate-900\"><h4 class=\"text-sm font-bold text-white mb-1\">Privacy-First Design</h4><p class=\"text-xs text-slate-400 leading-relaxed\">Your content goes directly to your chosen provider via private API keys. We never store, log, or train on your private data.</p></div></div>"}}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":2},"vertical_alignment":"center"}'::jsonb,
    updated_at = NOW()
WHERE id = 73;

-- Block ID 74
UPDATE public.blocks
SET content = '{"padding":{"top":"xl","bottom":"xl"},"background":{"type":"gradient","gradient":{"type":"linear","stops":[{"color":"#312e81","position":0},{"color":"#1e1b4b","position":100}],"direction":"135deg"}},"column_gap":"none","column_blocks":[[{"block_type":"heading","content":{"level":2,"textAlign":"center","textColor":"background","text_content":"Ready to add AI to your editor?"}},{"block_type":"text","content":{"html_content":"<p class=\"text-center text-violet-100 max-w-xl mx-auto mt-2 mb-6\">Unlock the full power of AI-driven content creation. Connect your key, protect your privacy, and edit faster today.</p>"}},{"block_type":"button","content":{"url":"#","size":"lg","text":"Purchase Cortex AI","variant":"secondary","position":"center"}}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":1},"vertical_alignment":"center"}'::jsonb,
    updated_at = NOW()
WHERE id = 74;

-- (transaction control stripped for the catch-up: the applier wraps this file in one transaction)
$nb_file_00000000000035$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000035_digital_products_seo_optimizations.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000035_digital_products_seo_optimizations.sql

  -- >>> FROM: 00000000000036_seed_posts_missing_seo_metadata.sql
  IF NOT pg_temp.nb_recorded('00000000000036', '00000000000036_seed_posts_missing_seo_metadata') THEN
    RAISE NOTICE 'catch-up: applying 00000000000036_seed_posts_missing_seo_metadata.sql';
    EXECUTE $nb_file_00000000000036$
-- Migration: 00000000000036_seed_posts_missing_seo_metadata.sql
-- Purpose: Set meta_title and meta_description for remaining seeded blog posts
--          (how-nextblock-works, comment-nextblock-fonctionne, nextblock-commerce-guide, guide-commerce-nextblock)
--          so all 9 seeded posts achieve a 100/100 SEO score.
-- Safety:  Append-only, forward-only, content-guarded updates.

-- (transaction control stripped for the catch-up: the applier wraps this file in one transaction)

UPDATE public.posts
   SET meta_title = 'How NextBlock™ Works: Architecture & Under the Hood',
       meta_description = 'Explore the architecture behind NextBlock: monorepo packages, typed block registry, Supabase database, and modern Next.js editor stack.',
       updated_at = NOW()
 WHERE slug = 'how-nextblock-works'
   AND meta_title IS NULL;

UPDATE public.posts
   SET meta_title = 'Comment fonctionne NextBlock™ : Architecture et Moteur',
       meta_description = 'Découvrez les fondations de NextBlock : monorepo, registre de blocs typés, base de données Supabase et moteur d''édition Next.js moderne.',
       updated_at = NOW()
 WHERE slug = 'comment-nextblock-fonctionne'
   AND meta_title IS NULL;

UPDATE public.posts
   SET meta_title = 'The Complete NextBlock™ Commerce Guide | Headless Store',
       meta_description = 'Build global e-commerce with NextBlock: manage products, configure multi-currency pricing, and accept payments with headless Stripe checkout.',
       updated_at = NOW()
 WHERE slug = 'nextblock-commerce-guide'
   AND meta_title IS NULL;

UPDATE public.posts
   SET meta_title = 'Guide Complet du Commerce avec NextBlock™ | E-Commerce',
       meta_description = 'Développez votre boutique avec NextBlock : gestion de produits, tarifs multi-devises et tunnel de paiement headless avec Stripe Checkout.',
       updated_at = NOW()
 WHERE slug = 'guide-commerce-nextblock'
   AND meta_title IS NULL;

-- (transaction control stripped for the catch-up: the applier wraps this file in one transaction)
$nb_file_00000000000036$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000036_seed_posts_missing_seo_metadata.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000036_seed_posts_missing_seo_metadata.sql

  -- >>> FROM: 00000000000037_reposition_marketing_and_cortex_mcp.sql
  IF NOT pg_temp.nb_recorded('00000000000037', '00000000000037_reposition_marketing_and_cortex_mcp') THEN
    RAISE NOTICE 'catch-up: applying 00000000000037_reposition_marketing_and_cortex_mcp.sql';
    EXECUTE $nb_file_00000000000037$
-- 00000000000037_reposition_marketing_and_cortex_mcp.sql
--
-- Repositions the seeded marketing content around NextBlock's differentiator: an
-- AI-native website builder where Cortex AI connects to the operator's OWN AI
-- subscription over MCP (Model Context Protocol), leaving the team with a
-- production Next.js 16 + Supabase site and a visual CMS rather than disposable
-- prototype code. Four pieces plus one repair:
--
--   1. Home page (EN, slug 'home'): meta title/description and four section
--      blocks rewritten in place — the hero, the "Key Features" section (now the
--      prototype-vs-production comparison), the "Built with the Best" section
--      (now the three-step MCP walkthrough) and the Cortex AI promo. Sections that
--      032 already tuned (Commerce, ecosystem, community, contact) are untouched.
--   2. Cortex AI product (EN, slug 'nextblock-cortex-ai-cortex-ai-license'):
--      title, meta, short description and the five description sections, now
--      leading with the MCP execution model and the five MCP-contract tools
--      (get_database_schema, generate_jsonb_layout, update_site_navigation,
--      query_site_analytics, search_stock_media — the names the registry
--      actually exposes; see libs/cortex/src/lib/mcp-tool-registry.ts).
--   3. The "How Updating NextBlock Works" EN/FR posts get a dedicated feature
--      image (public/images/update_nextblock.webp) instead of the shared
--      extensibility artwork.
--   4. A new EN post, 'cortex-ai-mcp-connection-guide', walks through connecting
--      Claude Code and Cursor to /api/mcp. Its body is stored as a JSON-stringified
--      Tiptap document in blocks.content.html_content — the Notion editor's native
--      format, which the text renderer, the editor and the SEO engine all accept.
--      (00000000000038 replaces that body with the styled, illustrated version.)
--   5. Repair: 00000000000035 updated blocks by hard-coded id. On installs whose
--      ids drifted from the baseline (the hourly-reset sandbox is one), those ids
--      belonged to other rows, so French Commerce Pro product copy landed on the
--      EN/FR home pages (replacing the Live Demo promo) and on the first block of
--      the French install guide, which therefore rendered empty. The repair is
--      scoped by content signature + parent, so it is a no-op where 035 hit the
--      rows it meant to.
--
-- Every page, post and product touched here grades 100/100 in the built-in SEO
-- engine (libs/utils/src/lib/seo) with these focus keyphrases, which the CMS
-- audit panel does not persist and therefore has to be typed in by the editor:
--   home    → "AI website builder CMS"
--   product → "Cortex AI MCP server"
--   post    → "connect Claude to NextBlock CMS"
--
-- Forward-only and idempotent by construction: every UPDATE is guarded by the
-- seeded copy it replaces (or by the copy it writes), inserts use NOT EXISTS /
-- ON CONFLICT, and nothing is keyed by a numeric id. blocks.content is JSONB
-- written with dollar-quoting (as in 006/009/020) so the HTML keeps ordinary
-- single-quoted attributes. Keep the word "sandbox" out of this filename.
--
-- After adding this file: npm run generate:migrations-bundle && npm run
-- generate:sandbox && npm run sync:create-nextblock.

DO $body$
DECLARE
  v_en           integer;
  v_fr           integer;
  v_home         integer;
  v_accueil      integer;
  v_setup_fr     integer;
  v_cortex       uuid;
  v_update_media uuid;
  v_post_media   uuid;
  v_post         integer;
BEGIN
  SELECT id INTO v_en FROM public.languages WHERE code = 'en' LIMIT 1;
  SELECT id INTO v_fr FROM public.languages WHERE code = 'fr' LIMIT 1;

  ---------------------------------------------------------------------------
  -- 0. Media rows for the two bundled images (public/images/*.webp).
  --    media.object_key is UNIQUE, so the row is keyed by that and the id is
  --    resolved back rather than assumed (the sandbox reset upserts by key too).
  ---------------------------------------------------------------------------
  INSERT INTO public.media (id, uploader_id, file_name, object_key, file_path, folder, file_type, size_bytes, description, width, height)
  VALUES ('3f9c2a7e-6d41-4b8a-9c5e-2a1b7d4e8f60'::uuid, NULL, 'update_nextblock.webp', 'images/update_nextblock.webp', 'images/update_nextblock.webp', 'images', 'image/webp', 577246, 'NextBlock CMS release update and platform architecture overview', 2664, 1568)
  ON CONFLICT (object_key) DO UPDATE
     SET description = COALESCE(NULLIF(public.media.description, ''), EXCLUDED.description),
         width       = COALESCE(public.media.width, EXCLUDED.width),
         height      = COALESCE(public.media.height, EXCLUDED.height),
         updated_at  = now();

  INSERT INTO public.media (id, uploader_id, file_name, object_key, file_path, folder, file_type, size_bytes, description, width, height)
  VALUES ('8b2e5d1c-9a47-4f3b-8e6d-1c7a2b9d4e50'::uuid, NULL, 'cortex_post.webp', 'images/cortex_post.webp', 'images/cortex_post.webp', 'images', 'image/webp', 745752, 'Diagram of Cortex AI Model Context Protocol MCP connection to external LLMs', 2664, 1568)
  ON CONFLICT (object_key) DO UPDATE
     SET description = COALESCE(NULLIF(public.media.description, ''), EXCLUDED.description),
         width       = COALESCE(public.media.width, EXCLUDED.width),
         height      = COALESCE(public.media.height, EXCLUDED.height),
         updated_at  = now();

  SELECT id INTO v_update_media FROM public.media WHERE object_key = 'images/update_nextblock.webp' LIMIT 1;
  SELECT id INTO v_post_media   FROM public.media WHERE object_key = 'images/cortex_post.webp' LIMIT 1;

  ---------------------------------------------------------------------------
  -- 1. Home page (EN)
  ---------------------------------------------------------------------------
  SELECT id INTO v_home
    FROM public.pages
   WHERE slug = 'home' AND language_id = v_en
   ORDER BY id
   LIMIT 1;

  IF v_home IS NOT NULL THEN
    UPDATE public.pages
       SET meta_title       = 'NextBlock: AI Website Builder CMS for Production Sites',
           meta_description = 'Build websites fast with the AI website builder CMS that runs on your own AI plan over MCP. Prompt-driven pages land in a production Next.js 16 visual CMS.',
           updated_at       = now()
     WHERE id = v_home
       AND (meta_title IS NULL OR meta_title = '' OR meta_title = 'NextBlock: AI Website Builder CMS for Production Sites');

    -- 5a. Repair: drop French Commerce Pro product copy that 035's id-keyed
    --     UPDATEs wrote over the Live Demo promo on drifted installs. The real
    --     promo carries the nb-sandbox-promo sentinel and is never matched.
    DELETE FROM public.blocks
     WHERE page_id = v_home
       AND block_type = 'section'
       AND content::text NOT LIKE '%nb-sandbox-promo%'
       AND (content::text LIKE '%Sous le capot%'
            OR content::text LIKE '%Prêt à lancer votre boutique%'
            OR content::text LIKE '%Moteur E-Commerce d''Entreprise%'
            OR content::text LIKE '%Checkout Stripe Headless%');

    -- Hero (order 0): "Build Blazing-Fast Websites." → prompt-to-production H1.
    UPDATE public.blocks
       SET content = $nbhero${"is_hero":true,"padding":{"top":"xl","bottom":"xl"},"background":{"type":"gradient","gradient":{"type":"linear","stops":[{"color":"#020817","position":0},{"color":"#0f172a","position":50},{"color":"#1e293b","position":100}],"direction":"135deg"}},"column_gap":"xl","column_blocks":[[{"block_type":"text","content":{"html_content":"<h1 class='text-5xl md:text-6xl font-extrabold tracking-tight text-white text-center leading-tight'>Prompt to <span class='relative inline-block mx-1 group'><span class='absolute inset-0 bg-gradient-to-r from-blue-600 to-cyan-400 translate-y-1 md:translate-y-2 transform -skew-x-12 rounded-sm shadow-lg group-hover:skew-x-0 transition-transform duration-300 ease-out'></span><span class='relative text-white italic px-1'>Production</span></span>.<br class='md:hidden' /> The AI Website Builder CMS.</h1>"}},{"block_type":"text","content":{"html_content":"<p class='text-xl text-slate-300 text-center max-w-3xl mx-auto mt-4 leading-relaxed'>NextBlock is the open-source AI website builder CMS for teams that want more than a prototype. Point Claude Code, Cursor, or ChatGPT at your site over MCP and prompt the pages you need. You keep a live Next.js 16 and Supabase website with a visual editor your team owns on day two.</p>"}},{"block_type":"button","content":{"url":"/article/how-to-setup-nextblock","size":"lg","text":"Get Started","variant":"default","position":"center"}},{"block_type":"button","content":{"url":"/article/cortex-ai-mcp-connection-guide","size":"lg","text":"Connect Claude or Cursor","variant":"outline","position":"center"}},{"block_type":"text","content":{"html_content":"<div class='flex flex-wrap justify-center gap-6 text-sm uppercase tracking-wide text-slate-400 mt-8'><a href='https://github.com/nextblock-cms' target='_blank' rel='noopener noreferrer' class='hover:text-white transition-colors'>GitHub</a><a href='https://x.com/NextBlockCMS' target='_blank' rel='noopener noreferrer' class='hover:text-white transition-colors'>X</a><a href='https://www.linkedin.com/in/nextblock/' target='_blank' rel='noopener noreferrer' class='hover:text-white transition-colors'>LinkedIn</a><a href='https://dev.to/nextblockcms' target='_blank' rel='noopener noreferrer' class='hover:text-white transition-colors'>Dev.to</a><a href='https://www.npmjs.com/~nextblockcms' target='_blank' rel='noopener noreferrer' class='hover:text-white transition-colors'>npm</a></div>"}}],[{"block_type":"text","content":{"html_content":"<div class='p-10 border border-white/10 rounded-3xl bg-white/5 backdrop-blur-xl shadow-2xl relative overflow-hidden group'><div class='absolute inset-0 bg-gradient-to-br from-blue-500/10 to-purple-500/10 opacity-0 group-hover:opacity-100 transition-opacity duration-500'></div><div class='relative z-10'><p class='text-xs text-white uppercase tracking-widest font-semibold mb-2'>Why teams switch</p><p class='text-3xl font-bold text-white mb-2'>Production on day two.</p><p class='text-base text-slate-300 mb-6'>Lovable, Bolt, and v0 hand you prototype code. NextBlock hands you a live site and a CMS.</p><ul class='space-y-3 text-sm text-slate-200'><li><span class='text-blue-400 mr-2'>&#10003;</span> Your own AI subscription over MCP, with no token markup.</li><li><span class='text-blue-400 mr-2'>&#10003;</span> Next.js 16 and Supabase with a Notion-style block editor.</li><li><span class='text-blue-400 mr-2'>&#10003;</span> Blocks stored as JSONB, so publishing never needs a redeploy.</li></ul><div class='mt-6 rounded-2xl overflow-hidden border border-white/10 shadow-lg'><div class='relative w-full aspect-video'><iframe class='absolute inset-0 h-full w-full border-0' src='https://www.youtube-nocookie.com/embed/71MyfoL4YVM?si=jtlDXV6cSC8rDgz0' title='NextBlock demo video' allow='accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share' referrerpolicy='strict-origin-when-cross-origin' loading='lazy' allowfullscreen></iframe></div></div></div></div>"}}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":2},"vertical_alignment":"center"}$nbhero$::jsonb,
           updated_at = now()
     WHERE page_id = v_home
       AND block_type = 'section'
       AND content::text LIKE '%Blazing-Fast%';

    -- "Key Features: The Three Pillars" → why an AI website builder CMS beats prototype code.
    UPDATE public.blocks
       SET content = $nbwhy${"padding":{"top":"xl","bottom":"xl"},"background":{"type":"none"},"column_gap":"lg","column_blocks":[[{"block_type":"heading","content":{"level":2,"textAlign":"center","text_content":"Why an AI Website Builder CMS Beats Prototype Code."}},{"block_type":"text","content":{"html_content":"<p class='text-lg text-muted-foreground text-center max-w-3xl mx-auto mb-10'>Prompt builders like Lovable, Bolt, and v0 are great at a first draft. Then they hand you code you must host, patch, and rebuild for every copy change. NextBlock takes the same prompts and turns them into a website your whole team can run.</p>"}},{"block_type":"text","content":{"html_content":"<div class='grid gap-6 md:grid-cols-3'><div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-blue-300 dark:border-slate-800 dark:bg-slate-900'><div class='mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-xl dark:bg-blue-950'>🧩</div><h3 class='text-lg font-bold text-foreground mb-2'>Prompt to CMS, Not Just Code.</h3><p class='text-sm text-muted-foreground leading-relaxed'>External AI agents scaffold real layouts as typed blocks. Editors then tweak copy, images, and sections in a Notion-style editor. Nobody writes a prompt or touches code to change a headline.</p></div><div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-blue-300 dark:border-slate-800 dark:bg-slate-900'><div class='mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-xl dark:bg-blue-950'>🔌</div><h3 class='text-lg font-bold text-foreground mb-2'>Bring Your Own AI Subscription via MCP.</h3><p class='text-sm text-muted-foreground leading-relaxed'>Connect Claude Code, Cursor, ChatGPT, or Gemini straight to /api/mcp. You pay for the AI plan you already have, not a SaaS token markup.</p></div><div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-blue-300 dark:border-slate-800 dark:bg-slate-900'><div class='mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-xl dark:bg-blue-950'>⚡</div><h3 class='text-lg font-bold text-foreground mb-2'>Zero-Redeploy JSONB Architecture.</h3><p class='text-sm text-muted-foreground leading-relaxed'>Generated blocks land in PostgreSQL as validated JSONB. Pages publish in seconds with 100/100 Lighthouse defaults and no rebuild.</p></div></div>"}},{"block_type":"text","content":{"html_content":"<div class='mt-10 grid gap-4 md:grid-cols-2'><div class='rounded-2xl border border-rose-200 bg-rose-50/60 p-6 dark:border-rose-900/60 dark:bg-rose-950/30'><p class='text-xs uppercase tracking-[0.2em] font-semibold text-rose-600 dark:text-rose-300 mb-2'>Prototype tools</p><p class='text-base font-semibold text-foreground mb-1'>A codebase to babysit.</p><p class='text-sm text-muted-foreground'>Every edit is a new prompt or a pull request. There is no editor, no drafts, and no revision history for the people who own the content.</p></div><div class='rounded-2xl border border-emerald-200 bg-emerald-50/60 p-6 dark:border-emerald-900/60 dark:bg-emerald-950/30'><p class='text-xs uppercase tracking-[0.2em] font-semibold text-emerald-600 dark:text-emerald-300 mb-2'>NextBlock</p><p class='text-base font-semibold text-foreground mb-1'>A website plus a CMS.</p><p class='text-sm text-muted-foreground'>AI drafts the layout once. Your team edits it forever with Live Drafts, revisions, translations, and SEO checks built in.</p></div></div>"}}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":1}}$nbwhy$::jsonb,
           updated_at = now()
     WHERE page_id = v_home
       AND block_type = 'section'
       AND content::text LIKE '%Key Features: The Three Pillars%';

    -- "Built with the Best." → how the MCP connection works (keeps the stack strip).
    UPDATE public.blocks
       SET content = $nbmcp${"padding":{"top":"xl","bottom":"xl"},"background":{"type":"gradient","gradient":{"type":"linear","stops":[{"color":"#0f172a","position":0},{"color":"#1e293b","position":100}],"direction":"135deg"}},"column_gap":"lg","column_blocks":[[{"block_type":"text","content":{"html_content":"<p class='text-xs uppercase tracking-[0.3em] text-cyan-300 font-semibold text-center mb-3'>Model Context Protocol</p><h2 class='text-3xl md:text-4xl font-extrabold text-white text-center mb-4'>How the MCP Connection Works.</h2><p class='text-lg text-slate-300 text-center max-w-3xl mx-auto mb-10'>Cortex AI exposes your CMS as an MCP server at /api/mcp. Any agent that speaks the standard can read your schema and write pages. Three steps take you from a blank site to published pages.</p><div class='grid gap-6 md:grid-cols-3'><div class='rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur'><p class='text-xs uppercase tracking-[0.25em] text-cyan-300 font-semibold mb-3'>Step 1</p><h3 class='text-lg font-bold text-white mb-2'>Register /api/mcp.</h3><p class='text-sm text-slate-300 leading-relaxed'>Mint a scoped token in CMS Settings and paste one JSON block into Claude Code, Cursor, or VS Code. Local dev needs no token at all.</p></div><div class='rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur'><p class='text-xs uppercase tracking-[0.25em] text-cyan-300 font-semibold mb-3'>Step 2</p><h3 class='text-lg font-bold text-white mb-2'>Prompt the layout.</h3><p class='text-sm text-slate-300 leading-relaxed'>Ask for a landing page. The agent calls generate_jsonb_layout and the result lands as a Live Draft made of validated blocks.</p></div><div class='rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur'><p class='text-xs uppercase tracking-[0.25em] text-cyan-300 font-semibold mb-3'>Step 3</p><h3 class='text-lg font-bold text-white mb-2'>Edit and publish.</h3><p class='text-sm text-slate-300 leading-relaxed'>Editors refine the draft in the visual editor and hit publish. The page goes live from PostgreSQL with no redeploy.</p></div></div>"}},{"block_type":"text","content":{"html_content":"<div class='mt-12 grid gap-8 md:grid-cols-2'><div class='rounded-2xl border border-white/10 bg-slate-950/60 p-6'><h3 class='text-base font-bold text-white mb-4'>For Writers and Editors</h3><ul class='space-y-3 text-sm text-slate-300'><li><strong class='text-white'>Notion-style editor.</strong> Slash commands, drag and drop, and inline AI on every block.</li><li><strong class='text-white'>Live Drafts.</strong> Stage AI output safely, then publish when it reads right.</li><li><strong class='text-white'>Revisions.</strong> Restore any version of a page or post with one click.</li><li><strong class='text-white'>Built-in SEO checks.</strong> Headings, keyphrases, readability, and metadata graded as you type.</li></ul></div><div class='rounded-2xl border border-white/10 bg-slate-950/60 p-6'><h3 class='text-base font-bold text-white mb-4'>For Developers</h3><ul class='space-y-3 text-sm text-slate-300'><li><strong class='text-white'>Next.js 16 core.</strong> Server Components, ISR, and edge caching out of the box.</li><li><strong class='text-white'>Supabase backend.</strong> Postgres, auth, storage, and row-level security you can read.</li><li><strong class='text-white'>Typed block registry.</strong> Every block has a Zod schema, so AI output is validated before it renders.</li><li><strong class='text-white'>Open source.</strong> Self-host on Docker or deploy to Vercel in one click.</li></ul></div></div><p class='mt-10 text-center text-xs uppercase tracking-[0.25em] text-slate-400'>Built with Next.js, React, Supabase, Stripe, Tailwind, Tiptap, Vercel, and Nx.</p>"}}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":1}}$nbmcp$::jsonb,
           updated_at = now()
     WHERE page_id = v_home
       AND block_type = 'section'
       AND content::text LIKE '%Built with the Best%';

    -- Cortex AI promo: "Supercharge Your Content with AI." → one engine, two ways to connect.
    UPDATE public.blocks
       SET content = $nbcortexpromo${"padding":{"top":"xl","bottom":"xl"},"background":{"type":"gradient","gradient":{"type":"linear","stops":[{"color":"#1e1b4b","position":0},{"color":"#0f172a","position":100}],"direction":"135deg"}},"column_gap":"xl","column_blocks":[[{"block_type":"text","content":{"html_content":"<p class='text-xs uppercase tracking-[0.3em] text-violet-400 font-semibold mb-4'>Now Available — Cortex AI</p><h2 class='text-4xl md:text-5xl font-bold text-white mb-6 leading-tight'>One AI Engine.<br/>Two Ways to Connect.</h2><p class='text-lg text-slate-300 max-w-2xl leading-relaxed mb-4'>Inside the dashboard, Cortex AI routes to any model through your own OpenRouter key. Outside it, the same tools run as an MCP server for Claude Code, Cursor, ChatGPT, and Gemini.</p><p class='text-base text-slate-400 max-w-2xl leading-relaxed'>Layouts stage as Live Drafts, tokens are scoped read or write, and nothing goes live until an editor publishes it.</p>"}},{"block_type":"button","content":{"url":"/article/cortex-ai-mcp-connection-guide","size":"lg","text":"Read the MCP Setup Guide →","variant":"default","position":"left"}},{"block_type":"button","content":{"url":"https://nextblock.dev/product/nextblock-cortex-ai-cortex-ai-license","size":"lg","text":"Get a License","variant":"outline","position":"left"}}],[{"block_type":"text","content":{"html_content":"<div class='grid grid-cols-1 gap-4 sm:grid-cols-3 lg:grid-cols-1'><div class='rounded-2xl border border-violet-500/30 bg-white/5 p-6 text-center'><p class='text-3xl font-extrabold text-white'>29</p><p class='text-xs uppercase tracking-wider text-violet-200 mt-1'>Typed agent tools</p></div><div class='rounded-2xl border border-violet-500/30 bg-white/5 p-6 text-center'><p class='text-3xl font-extrabold text-white'>MCP</p><p class='text-xs uppercase tracking-wider text-violet-200 mt-1'>Streamable HTTP at /api/mcp</p></div><div class='rounded-2xl border border-violet-500/30 bg-white/5 p-6 text-center'><p class='text-3xl font-extrabold text-white'>BYOK</p><p class='text-xs uppercase tracking-wider text-violet-200 mt-1'>Your keys, your models</p></div></div>"}}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":2},"vertical_alignment":"center"}$nbcortexpromo$::jsonb,
           updated_at = now()
     WHERE page_id = v_home
       AND block_type = 'section'
       AND content::text LIKE '%AI Copilot%'
       AND content::text LIKE '%Supercharge%';
  END IF;

  -- 5b. Same repair on the FR home page ('accueil'); its copy is otherwise left alone.
  SELECT id INTO v_accueil
    FROM public.pages
   WHERE slug = 'accueil' AND language_id = v_fr
   ORDER BY id
   LIMIT 1;

  IF v_accueil IS NOT NULL THEN
    DELETE FROM public.blocks
     WHERE page_id = v_accueil
       AND block_type = 'section'
       AND content::text NOT LIKE '%nb-sandbox-promo%'
       AND (content::text LIKE '%Sous le capot%'
            OR content::text LIKE '%Prêt à lancer votre boutique%'
            OR content::text LIKE '%Moteur E-Commerce d''Entreprise%'
            OR content::text LIKE '%Checkout Stripe Headless%');
  END IF;

  -- 5c. Restore the French install guide body (033's copy) where 035 replaced it
  --     with a section-shaped payload the text renderer cannot display.
  SELECT id INTO v_setup_fr
    FROM public.posts
   WHERE slug = 'comment-configurer-nextblock' AND language_id = v_fr
   ORDER BY id
   LIMIT 1;

  IF v_setup_fr IS NOT NULL THEN
    UPDATE public.blocks
       SET content = jsonb_build_object('html_content', '<p class=''text-lg leading-8 text-slate-700 dark:text-slate-300''>NextBlock est un CMS open source et natif IA, construit sur Next.js et Supabase — et son installation ne passe plus par des fichiers de configuration, des assistants en ligne de commande ou du SQL manuel. Voici quatre façons de démarrer, <strong>classées de la plus simple à la plus technique</strong> : la première tient en un clic, la dernière donne le code source complet pour celles et ceux qui veulent participer à NextBlock. Elles aboutissent toutes au même endroit — un <strong>assistant de configuration</strong> dans le navigateur qui connecte votre base de données, configure le stockage des médias et crée votre compte administrateur.</p>

<div class=''mt-8 mb-6 flex items-center gap-4 text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400''>
  <span class=''flex-shrink-0''>Le plus simple</span>
  <span class=''h-1.5 flex-1 rounded-full bg-gradient-to-r from-blue-400 via-violet-400 to-emerald-400''></span>
  <span class=''flex-shrink-0''>Le plus de contrôle</span>
</div>

<div class=''grid gap-5 md:grid-cols-2 my-6''>
  <a href=''#one-click-vercel'' class=''block rounded-[1.75rem] border border-blue-200 bg-blue-50/70 p-6 no-underline transition-shadow hover:shadow-lg dark:border-blue-500/20 dark:bg-blue-500/10''>
    <div class=''flex items-center justify-between mb-4''>
      <span class=''flex h-9 w-9 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white''>1</span>
      <span class=''inline-flex items-center gap-1''><span class=''h-1.5 w-5 rounded-full bg-blue-500''></span><span class=''h-1.5 w-5 rounded-full bg-slate-200 dark:bg-white/10''></span><span class=''h-1.5 w-5 rounded-full bg-slate-200 dark:bg-white/10''></span><span class=''h-1.5 w-5 rounded-full bg-slate-200 dark:bg-white/10''></span></span>
    </div>
    <p class=''mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-blue-700 dark:text-blue-200''>Le plus simple &middot; un clic</p>
    <h2 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>Déployer sur Vercel</h2>
    <p class=''mb-0 text-sm leading-6 text-slate-600 dark:text-slate-300''>Un site de production en ligne avec une base de données gérée. Pas de terminal, aucun compte à configurer, rien à copier.</p>
  </a>
  <a href=''#npm-docker'' class=''block rounded-[1.75rem] border border-amber-200 bg-amber-50/70 p-6 no-underline transition-shadow hover:shadow-lg dark:border-amber-500/20 dark:bg-amber-500/10''>
    <div class=''flex items-center justify-between mb-4''>
      <span class=''flex h-9 w-9 items-center justify-center rounded-full bg-amber-500 text-sm font-bold text-white''>2</span>
      <span class=''inline-flex items-center gap-1''><span class=''h-1.5 w-5 rounded-full bg-amber-500''></span><span class=''h-1.5 w-5 rounded-full bg-amber-500''></span><span class=''h-1.5 w-5 rounded-full bg-slate-200 dark:bg-white/10''></span><span class=''h-1.5 w-5 rounded-full bg-slate-200 dark:bg-white/10''></span></span>
    </div>
    <p class=''mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-amber-700 dark:text-amber-200''>Facile &middot; 100 % local</p>
    <h2 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>npm create nextblock &rarr; Docker</h2>
    <p class=''mb-0 text-sm leading-6 text-slate-600 dark:text-slate-300''>Un seul prompt génère un projet et démarre toute la pile — base de données, auth, stockage, CMS — sur votre machine. Aucun compte cloud.</p>
  </a>
  <a href=''#npm-cloud'' class=''block rounded-[1.75rem] border border-violet-200 bg-violet-50/70 p-6 no-underline transition-shadow hover:shadow-lg dark:border-violet-500/20 dark:bg-violet-500/10''>
    <div class=''flex items-center justify-between mb-4''>
      <span class=''flex h-9 w-9 items-center justify-center rounded-full bg-violet-600 text-sm font-bold text-white''>3</span>
      <span class=''inline-flex items-center gap-1''><span class=''h-1.5 w-5 rounded-full bg-violet-500''></span><span class=''h-1.5 w-5 rounded-full bg-violet-500''></span><span class=''h-1.5 w-5 rounded-full bg-violet-500''></span><span class=''h-1.5 w-5 rounded-full bg-slate-200 dark:bg-white/10''></span></span>
    </div>
    <p class=''mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-violet-700 dark:text-violet-200''>Intermédiaire &middot; votre propre cloud</p>
    <h2 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>npm create nextblock &rarr; Supabase + R2</h2>
    <p class=''mb-0 text-sm leading-6 text-slate-600 dark:text-slate-300''>Générez une app autonome sur votre propre projet Supabase géré et Cloudflare R2, prête à déployer partout.</p>
  </a>
  <a href=''#git-clone'' class=''block rounded-[1.75rem] border border-emerald-200 bg-emerald-50/70 p-6 no-underline transition-shadow hover:shadow-lg dark:border-emerald-500/20 dark:bg-emerald-500/10''>
    <div class=''flex items-center justify-between mb-4''>
      <span class=''flex h-9 w-9 items-center justify-center rounded-full bg-emerald-600 text-sm font-bold text-white''>4</span>
      <span class=''inline-flex items-center gap-1''><span class=''h-1.5 w-5 rounded-full bg-emerald-500''></span><span class=''h-1.5 w-5 rounded-full bg-emerald-500''></span><span class=''h-1.5 w-5 rounded-full bg-emerald-500''></span><span class=''h-1.5 w-5 rounded-full bg-emerald-500''></span></span>
    </div>
    <p class=''mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200''>Avancé &middot; pour les contributeurs</p>
    <h2 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>Cloner le dépôt</h2>
    <p class=''mb-0 text-sm leading-6 text-slate-600 dark:text-slate-300''>Faites tourner le monorepo complet — le CMS, tous les packages et la documentation. Pour celles et ceux qui veulent aider à construire NextBlock (Docker fonctionne ici aussi).</p>
  </a>
</div>

<p class=''text-sm text-slate-500 dark:text-slate-400''>Vous ne savez pas par où commencer ? Descendez la liste — choisissez la première option dont vous avez déjà les prérequis. La plupart des gens devraient commencer par <a href=''#one-click-vercel''>Vercel</a>.</p>

<figure class=''my-12 overflow-hidden rounded-[2rem] border border-slate-200/80 bg-slate-950 shadow-2xl dark:border-white/10''>
  <img src=''/images/included.webp'' alt=''Aperçu de la plateforme NextBlock : éditeur de blocs, tableau de bord CMS et intégrations incluses dans chaque installation'' class=''w-full h-auto object-cover'' />
  <figcaption class=''border-t border-white/10 px-6 py-4 text-sm text-slate-300''>Quel que soit le chemin choisi, vous obtenez le même éditeur de blocs, le même CMS et le même schéma de base de données.</figcaption>
</figure>

<h2 id=''one-click-vercel''>Option 1 : Déploiement Vercel en un clic</h2>
<p class=''mt-2 mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm''><span class=''inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-blue-700 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-200''>Étape 1 &middot; Le plus simple</span><span class=''text-slate-500 dark:text-slate-400''>Idéal pour un site en ligne avec le minimum d''effort — pas de terminal, aucun compte à configurer.</span></p>
<p>Le moyen le plus rapide d''obtenir un site NextBlock en production. Un seul bouton crée votre propre copie de NextBlock sur GitHub, provisionne une base de données Supabase gérée et déploie le site — sans jamais ouvrir un terminal ni copier la moindre clé.</p>
<ol class=''space-y-2''>
  <li><strong>Cliquez sur Deploy to Vercel</strong> et connectez-vous — Vercel clone NextBlock dans un nouveau dépôt qui vous appartient.</li>
  <li><strong>Nommez le dépôt — et rendez-le Public.</strong> À la première étape sur Vercel, vous choisissez le nom du dépôt ; réglez sa visibilité sur <strong>Public</strong> plutôt que Privé. Un dépôt public est ce qui débloque les mises à jour automatiques en un clic plus tard — c''est donc le choix recommandé.</li>
  <li><strong>Créez la base de données Supabase</strong> quand on vous le demande : choisissez un nom et une région. Vercel la connecte au projet et injecte les clés avant le premier build.</li>
  <li><strong>Ouvrez votre nouveau site</strong> une fois le build terminé. Toute nouvelle instance vous amène directement à l''assistant de configuration.</li>
  <li><strong>Créez votre compte administrateur.</strong> Il est confirmé instantanément — aucun email de vérification — et vous arrivez dans le tableau de bord du CMS.</li>
</ol>
<div class=''my-8''>
  <a href=''https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fnextblock-cms%2Fnextblock&amp;project-name=nextblock&amp;repository-name=nextblock&amp;stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22supabase%22%2C%22productSlug%22%3A%22supabase%22%7D%5D'' target=''_blank'' rel=''noopener'' class=''inline-flex items-center rounded-full bg-slate-900 px-6 py-3 text-sm font-semibold text-white no-underline shadow-lg hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200''>Déployer sur Vercel &rarr;</a>
</div>
<div class=''rounded-3xl border border-emerald-200 bg-emerald-50/80 p-6 my-8 dark:border-emerald-500/20 dark:bg-emerald-500/10''>
  <p class=''mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200''>Recommandé &middot; rendez le dépôt public</p>
  <p class=''mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200''>Quand Vercel vous demande de nommer le nouveau dépôt, choisissez <strong>Public</strong>. C''est gratuit, et c''est ce qui permet à l''étape <strong>Connect GitHub</strong> du tableau de bord d''installer un workflow quotidien qui garde votre site synchronisé avec la dernière version de NextBlock. Vous pourrez toujours passer un dépôt privé en public plus tard dans GitHub — mais démarrer en public est le chemin le plus simple vers les mises à jour automatiques.</p>
</div>
<div class=''rounded-3xl border border-blue-200 bg-blue-50/80 p-6 my-8 dark:border-blue-500/20 dark:bg-blue-500/10''>
  <p class=''mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-blue-700 dark:text-blue-200''>Zéro configuration</p>
  <p class=''mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200''>Aucune variable d''environnement à remplir. Le stockage des médias utilise automatiquement votre projet Supabase connecté, les secrets de sécurité sont dérivés pour vous, et les migrations de base de données s''exécutent automatiquement à chaque build de production. Un domaine personnalisé plus tard ? Définissez <code>NEXT_PUBLIC_URL</code> dans votre projet Vercel et redéployez.</p>
</div>

<h2 id=''npm-docker''>Option 2 : npm create nextblock &rarr; Docker (100 % local)</h2>
<p class=''mt-2 mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm''><span class=''inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200''>Étape 2 &middot; Facile</span><span class=''text-slate-500 dark:text-slate-400''>Idéal pour tout essayer sur votre machine sans aucun compte cloud. Nécessite Docker Desktop.</span></p>
<p>Faites tourner NextBlock entièrement sur votre machine, sans aucun compte cloud. Le CLI génère une application Next.js autonome puis démarre toute la pile dans Docker pour vous : les moteurs Postgres et auth de Supabase, une API PostgREST derrière une passerelle Kong, un stockage MinIO compatible S3 et le CMS lui-même — idéal pour les évaluations, les environnements isolés et la pleine propriété de vos données.</p>
<p>Avant de commencer, installez <a href=''https://nodejs.org'' target=''_blank'' rel=''noopener''>Node.js 20 ou plus récent</a> (npm inclus) et <a href=''https://www.docker.com/products/docker-desktop/'' target=''_blank'' rel=''noopener''>Docker Desktop</a>, et assurez-vous que Docker Desktop est démarré.</p>
<pre><code>npm create nextblock@latest mon-site</code></pre>
<ol class=''space-y-2''>
  <li><strong>Choisissez le profil d''hébergement.</strong> Au premier prompt, choisissez <em>Local Self-Hosted Docker Mode (One-Click Local Sandbox)</em>, puis confirmez que Docker Desktop est installé et démarré.</li>
  <li><strong>Laissez faire.</strong> Le CLI copie le template, installe les dépendances, génère des clés sécurisées et démarre toute la pile avec une seule commande Docker — sans aucune question. Le premier lancement télécharge les images et construit l''app, comptez donc quelques minutes ; chaque migration de base de données est appliquée automatiquement au démarrage de la pile.</li>
  <li><strong>Ouvrez <code>http://localhost:3000</code></strong> — vous êtes redirigé vers l''assistant de configuration. Comme la base de données et le stockage MinIO sont déjà connectés, les étapes de connexion et de stockage sont ignorées : il ne reste qu''à créer votre administrateur (confirmé instantanément, sans email). Vous arrivez dans le tableau de bord du CMS.</li>
</ol>
<div class=''rounded-3xl border border-amber-200 bg-amber-50/80 p-6 my-8 dark:border-amber-500/20 dark:bg-amber-500/10''>
  <p class=''mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-amber-700 dark:text-amber-200''>Commandes du quotidien</p>
  <pre class=''mt-4 mb-0''><code># reconstruire et redémarrer la pile
npm run docker:up

# arrêter la pile (vos données persistent dans les volumes Docker)
npm run docker:down

# suivre les logs de l''application
npm run docker:logs</code></pre>
  <p class=''mt-4 mb-0 text-sm text-slate-700 dark:text-slate-200''>Le mode Docker n''est proposé que dans le prompt interactif — ne passez pas <code>--yes</code>, qui force le mode cloud géré ci-dessous.</p>
</div>

<h2 id=''npm-cloud''>Option 3 : npm create nextblock &rarr; votre propre Supabase + Cloudflare</h2>
<p class=''mt-2 mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm''><span class=''inline-flex items-center gap-2 rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-violet-700 dark:border-violet-500/20 dark:bg-violet-500/10 dark:text-violet-200''>Étape 3 &middot; Intermédiaire</span><span class=''text-slate-500 dark:text-slate-400''>Idéal pour construire votre propre site sur du cloud géré. Nécessite un projet Supabase et un bucket R2.</span></p>
<p>Le meilleur point de départ pour construire votre propre site sur du cloud géré. Le CLI génère une application Next.js autonome avec NextBlock déjà intégré — sans monorepo ni outillage de workspace — reliée à un projet Supabase et un bucket Cloudflare R2 que vous contrôlez, et elle se déploie partout où Next.js tourne.</p>
<p>Avant de commencer, installez <a href=''https://nodejs.org'' target=''_blank'' rel=''noopener''>Node.js 20 ou plus récent</a>, créez un projet gratuit sur <a href=''https://supabase.com'' target=''_blank'' rel=''noopener''>supabase.com</a>, et configurez un bucket <a href=''https://developers.cloudflare.com/r2/'' target=''_blank'' rel=''noopener''>Cloudflare R2</a> pour vos images et fichiers.</p>
<pre><code>npm create nextblock@latest mon-site
cd mon-site
npm run dev</code></pre>
<p>Au premier prompt, choisissez <em>Managed Cloud Mode (Vercel + Supabase Cloud)</em> et nommez votre projet. Ouvrez ensuite <code>http://localhost:3000/setup</code> et laissez l''assistant faire le travail :</p>
<ol class=''space-y-2''>
  <li><strong>Connectez Supabase</strong> — collez l''URL du projet, la clé publiable (anon), la clé secrète (service role) et un jeton d''accès personnel pour que l''assistant applique le schéma de base de données à votre place.</li>
  <li><strong>Ajoutez Cloudflare R2</strong> — saisissez votre identifiant de compte R2, le nom du bucket, la clé d''accès (access key ID), la clé secrète et l''URL publique du bucket pour servir vos images et fichiers.</li>
  <li><strong>Créez votre administrateur</strong> — l''assistant applique toutes les migrations, génère les secrets de l''application, écrit <code>.env.local</code>, crée votre compte admin confirmé et vous connecte. Redémarrez ensuite <code>npm run dev</code> une fois pour que le nouvel environnement soit intégré à l''application.</li>
</ol>
<div class=''rounded-3xl border border-violet-200 bg-violet-50/80 p-6 my-8 dark:border-violet-500/20 dark:bg-violet-500/10''>
  <p class=''mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-violet-700 dark:text-violet-200''>Modules premium</p>
  <p class=''mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200''>Besoin d''une boutique ? Une seule commande ajoute produits, paiement, commandes et coupons — activés par clé de licence, prêts quand vous l''êtes : <code>npx create-nextblock activate ecommerce</code></p>
</div>

<h2 id=''git-clone''>Option 4 : Cloner le dépôt</h2>
<p class=''mt-2 mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm''><span class=''inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200''>Étape 4 &middot; Avancé</span><span class=''text-slate-500 dark:text-slate-400''>Idéal pour les contributeurs et les équipes qui veulent personnaliser la plateforme. Nécessite Node.js et git.</span></p>
<p>Faites tourner le monorepo Nx complet : l''application CMS, tous les packages partagés, le code du CLI et la documentation. C''est le chemin de celles et ceux qui veulent participer au projet — contributeurs, auteurs de plugins et équipes qui personnalisent la plateforme elle-même.</p>
<pre><code>git clone https://github.com/nextblock-cms/nextblock.git
cd nextblock
npm install
npx nx serve nextblock</code></pre>
<p>Ouvrez <code>http://localhost:4200</code> — une nouvelle installation redirige chaque page vers <code>/setup</code>, où le même assistant en trois étapes connecte Supabase, configure le stockage et crée votre admin. Il valide vos clés, écrit <code>.env.local</code> avec des secrets générés, et applique toutes les migrations via l''API de management Supabase — sans CLI Supabase.</p>
<div class=''rounded-3xl border border-emerald-200 bg-emerald-50/80 p-6 my-8 dark:border-emerald-500/20 dark:bg-emerald-500/10''>
  <p class=''mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200''>Vous préférez rester local ? Docker fonctionne ici aussi</p>
  <p class=''mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200''>Pas besoin de comptes cloud pour développer sur le monorepo. Avec Docker Desktop démarré, une seule commande lance la même pile auto-hébergée que l''option 2 — Postgres, auth, stockage et le CMS — directement depuis votre clone :</p>
  <pre class=''mt-4 mb-0''><code>npm run docker:setup</code></pre>
  <p class=''mt-4 mb-0 text-sm text-slate-700 dark:text-slate-200''>Quand c''est terminé, ouvrez <code>http://localhost:3000</code> et créez votre administrateur. Notez que le monorepo n''a pas de <code>npm run dev</code> — utilisez <code>npx nx serve nextblock</code> (port 4200) pour le chemin cloud.</p>
</div>

<h2 id=''after-install''>Après l''installation : vos 10 premières minutes</h2>
<p>Chaque chemin vous dépose sur <code>/cms/dashboard</code>, connecté en tant que premier administrateur. Une checklist de démarrage intégrée vous guide pour la suite :</p>
<ul class=''space-y-2''>
  <li><strong>Ajoutez votre identité visuelle</strong> — téléversez votre logo et définissez le titre du site.</li>
  <li><strong>Réglez votre pied de page</strong> — mention de copyright et navigation du pied de page.</li>
  <li><strong>Configurez l''email (SMTP)</strong> — dans les réglages, pour que les réinitialisations de mot de passe et les invitations partent bien.</li>
  <li><strong>Extras optionnels</strong> — connectez vos outils d''analytics, activez la protection anti-bots et (sur Vercel) les mises à jour automatiques.</li>
</ul>
<p>Ensuite, découvrez comment la plateforme s''articule dans <a href=''/article/comment-nextblock-fonctionne''>Comment NextBlock fonctionne</a>, ou ajoutez une boutique avec le <a href=''/article/guide-commerce-nextblock''>guide Commerce</a>.</p>

<h2 id=''faq''>FAQ d''installation</h2>
<h3>Que dois-je installer ?</h3>
<p>Rien pour le chemin Vercel — tout se passe dans le navigateur. Pour <code>npm create nextblock</code> en mode Docker : <a href=''https://nodejs.org'' target=''_blank'' rel=''noopener''>Node.js 20+</a> et Docker Desktop. Pour le mode cloud géré : Node.js 20+ ainsi qu''un projet Supabase et un bucket Cloudflare R2. Pour le dépôt cloné : Node.js 20+ et git (ajoutez Docker Desktop si vous voulez faire tourner la pile locale).</p>
<h3>NextBlock est-il gratuit ?</h3>
<p>Oui — le cœur du CMS est 100 % gratuit et open source (AGPL). Les packages premium comme l''e-commerce et Cortex AI sont optionnels et s''activent avec une clé de licence. Vercel et Supabase proposent chacun une offre gratuite : un site de départ peut donc tourner sans frais.</p>
<h3>Ai-je besoin d''un compte Supabase ?</h3>
<p>Sur Vercel, la base de données est créée pour vous pendant le déploiement. Pour le chemin cloud géré <code>npm create nextblock</code> et le dépôt cloné, il vous faut un projet Supabase gratuit. Avec Docker — via le mode Docker du CLI ou <code>npm run docker:setup</code> dans le clone — aucun compte cloud n''est nécessaire.</p>
<h3>Dois-je exécuter des migrations ou du SQL à la main ?</h3>
<p>Non. L''assistant de configuration, le build Vercel et la pile Docker appliquent tous le schéma de base de données automatiquement — et relancer l''opération est toujours sans risque.</p>
<h3>Puis-je changer de chemin plus tard ?</h3>
<p>Oui. Chaque chemin exécute la même application et le même schéma de base de données : vous pouvez prototyper en local avec Docker aujourd''hui et déployer sur Vercel demain. NextBlock se déploie comme n''importe quelle app Next.js.</p>
<h3>Comment mettre à jour NextBlock ?</h3>
<p>Sur Vercel, l''étape Connect GitHub de la checklist active une synchronisation quotidienne automatique (cela nécessite un dépôt public). Sur un dépôt cloné, <code>git pull</code>, lancez <code>npm run db:migrate</code>, puis redémarrez (lors des builds de production, les migrations en attente s''appliquent automatiquement). Avec Docker, récupérez le dernier code et lancez <code>npm run docker:up</code>.</p>

<div class=''rounded-[2rem] border border-slate-200/80 bg-slate-50 p-8 my-12 text-center dark:border-white/10 dark:bg-white/5''>
  <p class=''mt-0 text-2xl font-semibold text-slate-900 dark:text-white''>Prêt à vous lancer ?</p>
  <p class=''text-sm text-slate-600 dark:text-slate-300''>Choisissez votre chemin ci-dessus, ou passez directement au plus rapide.</p>
  <div class=''mt-5 flex flex-wrap justify-center gap-3''>
    <a href=''https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fnextblock-cms%2Fnextblock&amp;project-name=nextblock&amp;repository-name=nextblock&amp;stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22supabase%22%2C%22productSlug%22%3A%22supabase%22%7D%5D'' target=''_blank'' rel=''noopener'' class=''inline-flex items-center rounded-full bg-slate-900 px-6 py-3 text-sm font-semibold text-white no-underline shadow-lg hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200''>Déployer sur Vercel</a>
    <a href=''https://github.com/nextblock-cms/nextblock'' target=''_blank'' rel=''noopener'' class=''inline-flex items-center rounded-full border border-slate-300 px-6 py-3 text-sm font-semibold text-slate-700 no-underline hover:border-slate-500 dark:border-white/20 dark:text-slate-200 dark:hover:border-white/50''>Voir sur GitHub</a>
  </div>
</div>'::text),
           updated_at = now()
     WHERE post_id = v_setup_fr
       AND block_type = 'text'
       AND "order" = 0
       AND NOT (content ? 'html_content')
       AND content::text LIKE '%Checkout Stripe Headless%';
  END IF;

  ---------------------------------------------------------------------------
  -- 2. Cortex AI product (EN)
  ---------------------------------------------------------------------------
  SELECT id INTO v_cortex
    FROM public.products
   WHERE slug = 'nextblock-cortex-ai-cortex-ai-license' AND language_id = v_en
   LIMIT 1;

  IF v_cortex IS NOT NULL THEN
    UPDATE public.products
       SET title = 'NextBlock™ Cortex AI MCP Server & Copilot License',
           updated_at = now()
     WHERE id = v_cortex
       AND title IN ('NextBlock™ Cortex AI - Cortex AI License', 'NextBlock™ Cortex AI MCP Server & Copilot License');

    UPDATE public.products
       SET meta_title       = 'Cortex AI MCP Server — Connect Claude & Cursor to Your CMS',
           meta_description = 'Turn NextBlock into a Cortex AI MCP server. Connect Claude, Cursor, and ChatGPT to create layouts, inspect your schema, and manage content on your AI plan.',
           updated_at       = now()
     WHERE id = v_cortex
       AND (meta_title IS NULL OR meta_title = ''
            OR meta_title = 'NextBlock Cortex AI License | Native AI Content Engine'
            OR meta_title = 'Cortex AI MCP Server — Connect Claude & Cursor to Your CMS');

    UPDATE public.products
       SET short_description = 'NextBlock™ Cortex AI is the AI layer for your CMS. Route any model through your own OpenRouter key in the dashboard, or register /api/mcp and let Claude Code, Cursor, and ChatGPT build layouts, inspect your schema, and manage content on the AI subscription you already pay for.',
           updated_at        = now()
     WHERE id = v_cortex
       AND (short_description IS NULL OR short_description = ''
            OR short_description LIKE 'NextBlock™ Cortex AI License brings block-level machine intelligence%'
            OR short_description = 'NextBlock™ Cortex AI is the AI layer for your CMS. Route any model through your own OpenRouter key in the dashboard, or register /api/mcp and let Claude Code, Cursor, and ChatGPT build layouts, inspect your schema, and manage content on the AI subscription you already pay for.');

    -- The seeded description opens with the "AI Intelligence Layer" eyebrow (both
    -- the 035 and the sandbox-reset variants). Replace the whole section set once;
    -- the new copy uses a different eyebrow, so a re-run is a no-op.
    IF EXISTS (
      SELECT 1 FROM public.blocks
       WHERE product_id = v_cortex
         AND content::text LIKE '%AI Intelligence Layer%'
    ) THEN
      DELETE FROM public.blocks WHERE product_id = v_cortex;

      INSERT INTO public.blocks (product_id, language_id, block_type, content, "order") VALUES
        (v_cortex, v_en, 'section', $nbcx0${"container_type":"container","background":{"type":"gradient","gradient":{"type":"linear","direction":"135deg","stops":[{"color":"#1e1b4b","position":0},{"color":"#312e81","position":35},{"color":"#0f172a","position":100}]}},"responsive_columns":{"mobile":1,"tablet":1,"desktop":2},"column_gap":"xl","vertical_alignment":"center","padding":{"top":"xl","bottom":"xl"},"column_blocks":[[{"block_type":"text","content":{"html_content":"<p class='text-xs uppercase tracking-[0.3em] text-violet-400 font-semibold mb-4'>MCP-Native AI Layer</p><h2 class='text-3xl md:text-5xl font-extrabold text-white leading-tight mb-5'>Your CMS as a Cortex AI MCP Server.</h2><p class='text-base md:text-lg text-slate-200 leading-relaxed mb-6'>Cortex AI runs two ways. In the dashboard it routes to any model through your own OpenRouter key. Over MCP it turns NextBlock into a server that Claude Code, Cursor, and ChatGPT operate from their own chat window.</p>"}},{"block_type":"button","content":{"text":"Read the MCP Setup Guide →","url":"/article/cortex-ai-mcp-connection-guide","variant":"default","size":"lg","position":"left"}}],[{"block_type":"text","content":{"html_content":"<div class='rounded-2xl border border-violet-700 bg-slate-950 p-6 shadow-xl sm:p-8'><h3 class='text-lg font-bold text-white mb-5'>Bring Your Own AI Subscription</h3><ul class='space-y-4 text-sm leading-relaxed text-slate-300'><li class='flex items-start gap-3'><span class='flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold'>✓</span><span><strong class='text-white'>No token markup</strong> — use Claude Pro, ChatGPT Plus, Cursor, or Gemini Advanced by registering /api/mcp. You pay your provider, not us.</span></li><li class='flex items-start gap-3'><span class='flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold'>✓</span><span><strong class='text-white'>Dashboard BYOK</strong> — OpenRouter routing with your own key, so you pick the model and keep the bill.</span></li><li class='flex items-start gap-3'><span class='flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold'>✓</span><span><strong class='text-white'>Scoped tokens</strong> — mint read-only or write tokens in CMS Settings and revoke them any time.</span></li><li class='flex items-start gap-3'><span class='flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold'>✓</span><span><strong class='text-white'>Live Drafts</strong> — generated layouts stage as drafts. Nothing goes live until an editor publishes it.</span></li></ul></div>"}}]]}$nbcx0$::jsonb, 0),
        (v_cortex, v_en, 'section', $nbcx1${"container_type":"container","background":{"type":"theme","theme":"muted"},"responsive_columns":{"mobile":1,"tablet":2,"desktop":4},"column_gap":"lg","padding":{"top":"lg","bottom":"lg"},"vertical_alignment":"center","column_blocks":[[{"block_type":"text","content":{"html_content":"<p class='text-center'><span class='block text-2xl font-extrabold text-foreground'>5</span><span class='text-xs text-muted-foreground uppercase tracking-wider'>MCP contract tools</span></p>"}}],[{"block_type":"text","content":{"html_content":"<p class='text-center'><span class='block text-2xl font-extrabold text-foreground'>29</span><span class='text-xs text-muted-foreground uppercase tracking-wider'>Typed agent tools</span></p>"}}],[{"block_type":"text","content":{"html_content":"<p class='text-center'><span class='block text-2xl font-extrabold text-foreground'>0 %</span><span class='text-xs text-muted-foreground uppercase tracking-wider'>Token markup</span></p>"}}],[{"block_type":"text","content":{"html_content":"<p class='text-center'><span class='block text-2xl font-extrabold text-foreground'>2</span><span class='text-xs text-muted-foreground uppercase tracking-wider'>Ways to connect</span></p>"}}]]}$nbcx1$::jsonb, 1),
        (v_cortex, v_en, 'section', $nbcx2${"container_type":"container","background":{"type":"none"},"responsive_columns":{"mobile":1,"tablet":2,"desktop":3},"column_gap":"lg","padding":{"top":"xl","bottom":"xl"},"vertical_alignment":"stretch","column_blocks":[[{"block_type":"text","content":{"html_content":"<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7'><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'><code class='rounded bg-violet-50 px-2 py-1 text-sm text-violet-700 dark:bg-violet-950 dark:text-violet-200'>get_database_schema</code></h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Returns every table the agent may read or change, with columns, keys, and read-only flags. The model plans against real structure, not guesses.</p></div>"}},{"block_type":"text","content":{"html_content":"<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7'><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'><code class='rounded bg-violet-50 px-2 py-1 text-sm text-violet-700 dark:bg-violet-950 dark:text-violet-200'>query_site_analytics</code></h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Reads revenue, order counts, status breakdowns, and top products over a date range. Read-only, so it is safe on any token.</p></div>"}}],[{"block_type":"text","content":{"html_content":"<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7'><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'><code class='rounded bg-violet-50 px-2 py-1 text-sm text-violet-700 dark:bg-violet-950 dark:text-violet-200'>generate_jsonb_layout</code></h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Turns a prompt into a complete page layout. Blocks are validated against the NextBlock schema and staged as a Live Draft.</p></div>"}},{"block_type":"text","content":{"html_content":"<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7'><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'><code class='rounded bg-violet-50 px-2 py-1 text-sm text-violet-700 dark:bg-violet-950 dark:text-violet-200'>search_stock_media</code></h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Finds free stock photos on Pexels and Unsplash with alt text and credits. Drop a result straight into an image block.</p></div>"}}],[{"block_type":"text","content":{"html_content":"<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7'><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'><code class='rounded bg-violet-50 px-2 py-1 text-sm text-violet-700 dark:bg-violet-950 dark:text-violet-200'>update_site_navigation</code></h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Adds, renames, or reorders header menu items per locale. Append to keep the current menu or replace it in one call.</p></div>"}},{"block_type":"text","content":{"html_content":"<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7'><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'><code class='rounded bg-violet-50 px-2 py-1 text-sm text-violet-700 dark:bg-violet-950 dark:text-violet-200'>and 24 more</code></h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Create posts and products, translate pages, upload media, manage themes and scripts. Every tool is typed and scoped.</p></div>"}}]]}$nbcx2$::jsonb, 2),
        (v_cortex, v_en, 'section', $nbcx3${"container_type":"container","background":{"type":"gradient","gradient":{"type":"linear","direction":"180deg","stops":[{"color":"#020617","position":0},{"color":"#0f172a","position":100}]}},"responsive_columns":{"mobile":1,"tablet":1,"desktop":2},"column_gap":"xl","vertical_alignment":"center","padding":{"top":"xl","bottom":"xl"},"column_blocks":[[{"block_type":"text","content":{"html_content":"<p class='text-xs uppercase tracking-[0.3em] text-violet-400 font-semibold mb-4'>How It Works</p><h3 class='text-2xl md:text-3xl font-extrabold text-white mb-4'>One Registry, Standard Transport.</h3><p class='text-slate-300 leading-relaxed mb-5'>The MCP server speaks Streamable HTTP at /api/mcp. Your client posts JSON-RPC messages and gets typed results back. There is no SDK to install and no proxy in the middle.</p><ul class='space-y-3 text-sm text-slate-400'><li class='flex items-start gap-2.5'><span class='text-violet-400'>→</span><span>Bearer tokens are stored as SHA-256 hashes and shown once.</span></li><li class='flex items-start gap-2.5'><span class='text-violet-400'>→</span><span>Localhost trust lets a dev server skip the token while you build.</span></li><li class='flex items-start gap-2.5'><span class='text-violet-400'>→</span><span>Read-only tokens never see a mutating tool in the list.</span></li><li class='flex items-start gap-2.5'><span class='text-violet-400'>→</span><span>Copy-paste config for Claude Code, Cursor, VS Code, and Claude Desktop.</span></li></ul>"}}],[{"block_type":"text","content":{"html_content":"<div class='space-y-4'><div class='p-5 rounded-xl border border-slate-700 bg-slate-900'><h4 class='text-sm font-bold text-white mb-1'>Dashboard BYOK via OpenRouter</h4><p class='text-xs text-slate-400 leading-relaxed'>Pick any model, from Claude to Gemini to open weights, with one key. Costs stay on your OpenRouter bill and switch with a toggle.</p></div><div class='p-5 rounded-xl border border-slate-700 bg-slate-900'><h4 class='text-sm font-bold text-white mb-1'>Editor Copilot</h4><p class='text-xs text-slate-400 leading-relaxed'>An inline toolbar rewrites copy, refactors columns, and translates whole pages. Output is valid block data, so layouts never break.</p></div><div class='p-5 rounded-xl border border-slate-700 bg-slate-900'><h4 class='text-sm font-bold text-white mb-1'>Privacy-First Design</h4><p class='text-xs text-slate-400 leading-relaxed'>Requests go straight to your provider with your key. NextBlock never stores, logs, or trains on your content.</p></div></div>"}}]]}$nbcx3$::jsonb, 3),
        (v_cortex, v_en, 'section', $nbcx4${"container_type":"container","background":{"type":"gradient","gradient":{"type":"linear","direction":"135deg","stops":[{"color":"#312e81","position":0},{"color":"#1e1b4b","position":100}]}},"responsive_columns":{"mobile":1,"tablet":1,"desktop":1},"column_gap":"none","padding":{"top":"xl","bottom":"xl"},"vertical_alignment":"center","column_blocks":[[{"block_type":"heading","content":{"level":2,"text_content":"Ready to connect your AI to your CMS?","textAlign":"center","textColor":"background"}},{"block_type":"text","content":{"html_content":"<p class='text-center text-violet-100 max-w-xl mx-auto mt-2 mb-6'>One license unlocks the dashboard copilot and the MCP server. Bring your own key or your own subscription, and keep your data yours.</p>"}},{"block_type":"button","content":{"text":"Purchase Cortex AI","url":"https://nextblock.dev/product/nextblock-cortex-ai-cortex-ai-license","variant":"secondary","size":"lg","position":"center"}}]]}$nbcx4$::jsonb, 4);
    END IF;
  END IF;

  ---------------------------------------------------------------------------
  -- 3. Feature image for the updating guide (EN + FR twins)
  ---------------------------------------------------------------------------
  IF v_update_media IS NOT NULL THEN
    UPDATE public.posts
       SET feature_image_id = v_update_media,
           updated_at       = now()
     WHERE slug IN ('how-updating-works', 'comment-fonctionnent-les-mises-a-jour')
       AND (feature_image_id IS NULL
            OR feature_image_id = '641ddf75-5c90-41df-8b83-e7c298f30a6a'::uuid  -- seeded extensibility.webp
            OR feature_image_id = v_update_media);
  END IF;

  ---------------------------------------------------------------------------
  -- 4. New post: Connect Claude to NextBlock CMS via MCP
  ---------------------------------------------------------------------------
  INSERT INTO public.posts (
    language_id, author_id, title, slug, label, excerpt, subtitle, status,
    published_at, meta_title, meta_description, feature_image_id, version,
    translation_group_id
  )
  SELECT
    v_en, NULL,
    'Connect Claude to NextBlock CMS via MCP, from Cursor or Claude Code',
    'cortex-ai-mcp-connection-guide',
    'Cortex AI',
    'Register /api/mcp in Claude Code or Cursor and let your own AI subscription read the schema, draft layouts, and manage pages in NextBlock.',
    'A hands-on guide to the Cortex AI MCP server: what it fixes, which tools it exposes, and the exact config for localhost and production.',
    'published', now(),
    'Connect Claude to NextBlock CMS via MCP | Cursor Guide',
    'Learn how to connect Claude to NextBlock CMS with Model Context Protocol. Register /api/mcp in Claude Code or Cursor to inspect schemas and build layouts.',
    v_post_media, 1, 'a7c4e2d1-3b58-4f96-9e0a-6d2c8b1f5a73'::uuid
  WHERE NOT EXISTS (
    SELECT 1 FROM public.posts WHERE language_id = v_en AND slug = 'cortex-ai-mcp-connection-guide'
  );

  SELECT id INTO v_post
    FROM public.posts
   WHERE language_id = v_en AND slug = 'cortex-ai-mcp-connection-guide'
   ORDER BY id
   LIMIT 1;

  IF v_post IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.blocks WHERE post_id = v_post
  ) THEN
    INSERT INTO public.blocks (post_id, language_id, block_type, content, "order")
    VALUES (v_post, v_en, 'text', $nbmcpguide${"html_content":"{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"This guide shows you how to connect Claude to NextBlock CMS with an open standard instead of a vendor plugin. \"},{\"type\":\"text\",\"text\":\"Cortex AI turns your site into a Model Context Protocol server. \"},{\"type\":\"text\",\"text\":\"Claude Code, Cursor, ChatGPT, and Gemini can then read your database schema, draft page layouts, and update navigation from their own chat window. \"},{\"type\":\"text\",\"text\":\"You pay for the AI subscription you already have, with no token markup in between.\"}]},{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"Every prompt becomes a structured database record rather than a pile of generated code. \"},{\"type\":\"text\",\"text\":\"Your editors keep a visual CMS, your developers keep a clean Next.js 16 app, and nothing goes live until someone hits publish.\"}]},{\"type\":\"heading\",\"attrs\":{\"level\":2},\"content\":[{\"type\":\"text\",\"text\":\"The Problem with Traditional AI Web Builders\"}]},{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"Prompt builders such as Lovable, Bolt, and v0 are impressive on day one. \"},{\"type\":\"text\",\"text\":\"You describe a page and get a working React app in minutes. \"},{\"type\":\"text\",\"text\":\"The trouble starts on day two.\"}]},{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"The output is disposable code with no content layer. \"},{\"type\":\"text\",\"text\":\"Every headline change is another prompt or another pull request. \"},{\"type\":\"text\",\"text\":\"There are no drafts, no revisions, no translations, and no SEO checks for the people who own the words. \"},{\"type\":\"text\",\"text\":\"Marketing teams end up waiting on engineers, and engineers end up babysitting code nobody designed.\"}]},{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"NextBlock takes the opposite view. \"},{\"type\":\"text\",\"text\":\"AI should scaffold the site once, and a real CMS should run it forever. \"},{\"type\":\"text\",\"text\":\"The MCP connection is how those two worlds meet.\"}]},{\"type\":\"heading\",\"attrs\":{\"level\":2},\"content\":[{\"type\":\"text\",\"text\":\"How Cortex AI Uses Model Context Protocol (MCP)\"}]},{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"Model Context Protocol is an open standard for giving AI agents tools. \"},{\"type\":\"text\",\"text\":\"A client such as Claude Code lists the tools a server offers, calls them with typed arguments, and reads typed results back. \"},{\"type\":\"text\",\"text\":\"Cortex AI ships that server inside your NextBlock install at \"},{\"type\":\"text\",\"text\":\"/api/mcp\",\"marks\":[{\"type\":\"code\"}]},{\"type\":\"text\",\"text\":\".\"}]},{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"The endpoint speaks Streamable HTTP. \"},{\"type\":\"text\",\"text\":\"Your client posts JSON-RPC messages over a normal HTTPS request, and the server answers in the same response. \"},{\"type\":\"text\",\"text\":\"There is no long-lived SSE stream to babysit and no SDK to install on the server side. \"},{\"type\":\"text\",\"text\":\"The same 29 typed tools that power the dashboard copilot are exposed over the wire, so the agent in your editor and the agent in your CMS never drift apart.\"}]},{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"Two safety rules apply to every call. \"},{\"type\":\"text\",\"text\":\"Layout tools stage their output as a Live Draft, so nothing reaches visitors until an editor publishes it. \"},{\"type\":\"text\",\"text\":\"And every token carries a scope, so a read-only token never even sees a tool that could change data.\"}]},{\"type\":\"heading\",\"attrs\":{\"level\":3},\"content\":[{\"type\":\"text\",\"text\":\"Available MCP Database Tools\"}]},{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"Five tool names form the public MCP contract. Each one forwards to a tested Cortex AI executor.\"}]},{\"type\":\"bulletList\",\"content\":[{\"type\":\"listItem\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"get_database_schema\",\"marks\":[{\"type\":\"code\"}]},{\"type\":\"text\",\"text\":\" returns every table the agent may read or change, with columns, primary keys, and read-only flags.\"}]}]},{\"type\":\"listItem\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"generate_jsonb_layout\",\"marks\":[{\"type\":\"code\"}]},{\"type\":\"text\",\"text\":\" turns a prompt into a full page layout, validates each block against the NextBlock schema, and stages it as a Live Draft.\"}]}]},{\"type\":\"listItem\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"update_site_navigation\",\"marks\":[{\"type\":\"code\"}]},{\"type\":\"text\",\"text\":\" adds, renames, or reorders header menu items per locale.\"}]}]},{\"type\":\"listItem\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"query_site_analytics\",\"marks\":[{\"type\":\"code\"}]},{\"type\":\"text\",\"text\":\" reads revenue, order counts, status breakdowns, and top products over a date range.\"}]}]},{\"type\":\"listItem\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"search_stock_media\",\"marks\":[{\"type\":\"code\"}]},{\"type\":\"text\",\"text\":\" finds free stock photos with alt text and photographer credits ready for an image block.\"}]}]}]},{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"Beyond the contract, the registry includes tools to create posts and products, translate pages, upload media, and manage themes and scripts. \"},{\"type\":\"text\",\"text\":\"Three resources expose the database, block, and custom block schemas, and three prompts cover page building, cloning from a URL, and translation.\"}]},{\"type\":\"heading\",\"attrs\":{\"level\":2},\"content\":[{\"type\":\"text\",\"text\":\"Step by Step: Connect Claude to NextBlock CMS in Cursor and Claude Code\"}]},{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"The server is off by default because it is a remote write surface onto live content. \"},{\"type\":\"text\",\"text\":\"Turning it on takes three steps.\"}]},{\"type\":\"orderedList\",\"attrs\":{\"start\":1},\"content\":[{\"type\":\"listItem\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"Open \"},{\"type\":\"text\",\"text\":\"CMS Settings → Cortex AI\",\"marks\":[{\"type\":\"bold\"}]},{\"type\":\"text\",\"text\":\" and enable the MCP server access card.\"}]}]},{\"type\":\"listItem\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"Mint a token with the scope you need. Read-only is enough for planning and audits.\"}]}]},{\"type\":\"listItem\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"Copy the generated config for your client. The card renders one snippet for Claude Code, Cursor, VS Code, and Claude Desktop.\"}]}]}]},{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"Claude Code needs \"},{\"type\":\"text\",\"text\":\"\\\"type\\\": \\\"http\\\"\",\"marks\":[{\"type\":\"code\"}]},{\"type\":\"text\",\"text\":\" in the entry, or it skips the server without a warning. \"},{\"type\":\"text\",\"text\":\"Cursor infers the transport from the URL and needs no type field. \"},{\"type\":\"text\",\"text\":\"VS Code uses a top-level \"},{\"type\":\"text\",\"text\":\"servers\",\"marks\":[{\"type\":\"code\"}]},{\"type\":\"text\",\"text\":\" key and prompts for the token instead of storing it.\"}]},{\"type\":\"heading\",\"attrs\":{\"level\":3},\"content\":[{\"type\":\"text\",\"text\":\"Localhost Configuration Without a Token\"}]},{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"While you build, turn on \"},{\"type\":\"text\",\"text\":\"Trust localhost without a token\",\"marks\":[{\"type\":\"bold\"}]},{\"type\":\"text\",\"text\":\" in the same settings card. \"},{\"type\":\"text\",\"text\":\"A dev server on your machine then accepts loopback calls with no header at all. \"},{\"type\":\"text\",\"text\":\"Standalone installs run on port 3000, and the monorepo dev server runs on port 4200.\"}]},{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"Add this block to \"},{\"type\":\"text\",\"text\":\".mcp.json\",\"marks\":[{\"type\":\"code\"}]},{\"type\":\"text\",\"text\":\" in your project root for Claude Code:\"}]},{\"type\":\"codeBlock\",\"attrs\":{\"language\":\"json\"},\"content\":[{\"type\":\"text\",\"text\":\"{\\n  \\\"mcpServers\\\": {\\n    \\\"nextblock\\\": {\\n      \\\"type\\\": \\\"http\\\",\\n      \\\"url\\\": \\\"http://localhost:3000/api/mcp\\\"\\n    }\\n  }\\n}\"}]},{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"The CLI form does the same thing in one line: \"},{\"type\":\"text\",\"text\":\"claude mcp add --transport http nextblock http://localhost:3000/api/mcp\",\"marks\":[{\"type\":\"code\"}]},{\"type\":\"text\",\"text\":\". \"},{\"type\":\"text\",\"text\":\"Localhost trust is a development affordance only. \"},{\"type\":\"text\",\"text\":\"It is ignored in production builds, because a proxy can spoof the host header.\"}]},{\"type\":\"heading\",\"attrs\":{\"level\":3},\"content\":[{\"type\":\"text\",\"text\":\"Production Authentication via Bearer Tokens\"}]},{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"In production every client sends a bearer token. \"},{\"type\":\"text\",\"text\":\"Tokens start with \"},{\"type\":\"text\",\"text\":\"nbmcp_\",\"marks\":[{\"type\":\"code\"}]},{\"type\":\"text\",\"text\":\", are shown once at mint time, and are stored only as SHA-256 hashes. \"},{\"type\":\"text\",\"text\":\"Revoking one is a single click, and the same value can never be minted again.\"}]},{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"Add this to \"},{\"type\":\"text\",\"text\":\".cursor/mcp.json\",\"marks\":[{\"type\":\"code\"}]},{\"type\":\"text\",\"text\":\" for Cursor, or drop the same entry into \"},{\"type\":\"text\",\"text\":\".mcp.json\",\"marks\":[{\"type\":\"code\"}]},{\"type\":\"text\",\"text\":\" with a type field for Claude Code:\"}]},{\"type\":\"codeBlock\",\"attrs\":{\"language\":\"json\"},\"content\":[{\"type\":\"text\",\"text\":\"{\\n  \\\"mcpServers\\\": {\\n    \\\"nextblock\\\": {\\n      \\\"url\\\": \\\"https://your-site.com/api/mcp\\\",\\n      \\\"headers\\\": { \\\"Authorization\\\": \\\"Bearer nbmcp_your_token\\\" }\\n    }\\n  }\\n}\"}]},{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"Once the client connects, ask for something concrete. \"},{\"type\":\"text\",\"text\":\"Try \\\"inspect the database schema and draft a pricing page with three tiers.\\\" \"},{\"type\":\"text\",\"text\":\"The agent calls the schema tool, then the layout tool, and your CMS shows a new Live Draft ready for review.\"}]},{\"type\":\"heading\",\"attrs\":{\"level\":2},\"content\":[{\"type\":\"text\",\"text\":\"Zero-Redeploy Production Rendering\"}]},{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"The reason this works is where the output lands. \"},{\"type\":\"text\",\"text\":\"Cortex AI writes strict JSONB block records into PostgreSQL, not HTML strings and not source files. \"},{\"type\":\"text\",\"text\":\"Each block has a Zod schema, so a bad field is rejected before it is stored.\"}]},{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"At request time Next.js 16 renders those records with Server Components and caches the result at the edge. \"},{\"type\":\"text\",\"text\":\"There is no build step between publish and live, and no HTML sanitizer tax on every render. \"},{\"type\":\"text\",\"text\":\"The 100/100 Lighthouse defaults you get on an empty site are the same ones you get after the agent has drafted fifty pages.\"}]},{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"Connect your agent today with the \"},{\"type\":\"text\",\"text\":\"Cortex AI license\",\"marks\":[{\"type\":\"link\",\"attrs\":{\"href\":\"https://nextblock.dev/product/nextblock-cortex-ai-cortex-ai-license\",\"target\":\"_blank\",\"rel\":null,\"class\":null}}]},{\"type\":\"text\",\"text\":\", and read \"},{\"type\":\"text\",\"text\":\"how NextBlock works under the hood\",\"marks\":[{\"type\":\"link\",\"attrs\":{\"href\":\"/article/how-nextblock-works\",\"target\":null,\"rel\":null,\"class\":null}}]},{\"type\":\"text\",\"text\":\" if you want the full picture of the block registry that makes it safe.\"}]}]}"}$nbmcpguide$::jsonb, 0);
  END IF;
END
$body$;

-- Revision baseline for the new post, mirroring 00000000000016 section 3b (and
-- 00000000000020's trailer): 016 back-filled a 'snapshot' revision only for posts
-- that existed when it ran, so a post seeded later needs its own restore point.
INSERT INTO public.post_revisions (post_id, author_id, version, revision_type, content)
SELECT
    po.id,
    NULL::uuid,
    po.version,
    'snapshot'::public.revision_type,
    jsonb_build_object(
      'meta', jsonb_build_object(
        'title',            po.title,
        'slug',             po.slug,
        'language_id',      po.language_id,
        'status',           po.status,
        'meta_title',       po.meta_title,
        'meta_description', po.meta_description,
        'custom_canonical', po.custom_canonical,
        'published_at',     to_char(po.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'feature_image_id', po.feature_image_id,
        'label',            po.label,
        'excerpt',          po.excerpt,
        'subtitle',         po.subtitle
      ),
      'blocks', COALESCE((
        SELECT jsonb_agg(
                 jsonb_build_object(
                   'language_id', b.language_id,
                   'block_type',  b.block_type,
                   'content',     b.content,
                   'order',       b."order"
                 ) ORDER BY b."order" ASC, b.id ASC
               )
          FROM public.blocks b
         WHERE b.post_id = po.id
      ), '[]'::jsonb)
    )
  FROM public.posts po
 WHERE po.slug = 'cortex-ai-mcp-connection-guide'
   AND NOT EXISTS (
         SELECT 1 FROM public.post_revisions r
          WHERE r.post_id = po.id
            AND r.revision_type = 'snapshot'
            AND r.version <= po.version
       )
ON CONFLICT (post_id, version) DO NOTHING;
$nb_file_00000000000037$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000037_reposition_marketing_and_cortex_mcp.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000037_reposition_marketing_and_cortex_mcp.sql

  -- >>> FROM: 00000000000038_mcp_guide_visual_refresh.sql
  IF NOT pg_temp.nb_recorded('00000000000038', '00000000000038_mcp_guide_visual_refresh') THEN
    RAISE NOTICE 'catch-up: applying 00000000000038_mcp_guide_visual_refresh.sql';
    EXECUTE $nb_file_00000000000038$
-- 00000000000038_mcp_guide_visual_refresh.sql
--
-- Visual refresh of the 'cortex-ai-mcp-connection-guide' post that 00000000000037
-- seeded. 037 stored the body as a plain Tiptap JSON document, which renders as a
-- wall of prose; this replaces it with the styled HTML every other seeded article
-- uses — summary cards, a prototype-vs-production comparison, a card per MCP tool
-- with its scope, numbered setup steps, terminal-style code panels, callouts, stat
-- tiles and a closing CTA — and adds a rendered architecture diagram
-- (public/images/mcp-prompt-to-production.webp, 2000x1025) as a captioned figure.
--
-- It is a separate file because 037 was already applied (and recorded) on the
-- sandbox before the redesign; Supabase matches history by version, so editing
-- 037 in place would have been skipped there silently.
--
-- Idempotent: the media row upserts on media.object_key; the body UPDATE is guarded
-- on the seeded Tiptap JSON shape (starts with the doc node and carries 037's
-- opening sentence), so once replaced — or once an editor has rewritten the post —
-- it no longer matches. The SEO grade stays 100/100 with the focus keyphrase
-- "connect Claude to NextBlock CMS" (verified with libs/utils/src/lib/seo).
--
-- After adding this file: npm run generate:migrations-bundle && npm run
-- generate:sandbox && npm run sync:create-nextblock.

DO $body$
DECLARE
  v_en   integer;
  v_post integer;
BEGIN
  SELECT id INTO v_en FROM public.languages WHERE code = 'en' LIMIT 1;

  ---------------------------------------------------------------------------
  -- 1. Media row for the inline diagram. Registered in resolveMediaUrl's bundled
  --    keys and the text renderer's known-image map, so it is served from
  --    public/images and optimised through next/image.
  ---------------------------------------------------------------------------
  INSERT INTO public.media (id, uploader_id, file_name, object_key, file_path, folder, file_type, size_bytes, description, width, height)
  VALUES ('5c7d9e2b-1a64-4f8c-9b3e-7d2a4c6e8f10'::uuid, NULL, 'mcp-prompt-to-production.webp', 'images/mcp-prompt-to-production.webp', 'images/mcp-prompt-to-production.webp', 'images', 'image/webp', 109680, 'Diagram of the prompt-to-production flow: an AI client calls the Cortex AI MCP server at /api/mcp, which writes validated JSONB blocks to PostgreSQL that Next.js 16 publishes without a redeploy', 2000, 1025)
  ON CONFLICT (object_key) DO UPDATE
     SET description = COALESCE(NULLIF(public.media.description, ''), EXCLUDED.description),
         width       = COALESCE(public.media.width, EXCLUDED.width),
         height      = COALESCE(public.media.height, EXCLUDED.height),
         updated_at  = now();

  ---------------------------------------------------------------------------
  -- 2. Replace the seeded Tiptap JSON body with the styled HTML version.
  ---------------------------------------------------------------------------
  SELECT id INTO v_post
    FROM public.posts
   WHERE language_id = v_en AND slug = 'cortex-ai-mcp-connection-guide'
   ORDER BY id
   LIMIT 1;

  IF v_post IS NOT NULL THEN
    UPDATE public.blocks
       SET content    = $nbmcpguide2${"html_content":"<p class='text-lg leading-8 text-slate-700 dark:text-slate-300'>This guide shows you how to connect Claude to NextBlock CMS with an open standard instead of a vendor plugin. Cortex AI turns your site into a Model Context Protocol server. Claude Code, Cursor, ChatGPT, and Gemini can then read your database schema, draft page layouts, and update navigation from their own chat window. You pay for the AI subscription you already have, with no token markup in between.</p><div class='grid gap-4 md:grid-cols-3 my-10'><div class='rounded-3xl border border-sky-200/70 bg-sky-50/70 p-6 dark:border-sky-500/20 dark:bg-sky-500/10'><p class='mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-sky-700 dark:text-sky-200'>One config block</p><p class='mt-3 mb-0 text-xl font-semibold text-slate-900 dark:text-white'>Setup in minutes.</p><p class='mt-3 mb-0 text-sm text-slate-600 dark:text-slate-300'>Paste one JSON entry into Claude Code, Cursor, or VS Code. The CMS settings card writes it for you.</p></div><div class='rounded-3xl border border-indigo-200/70 bg-indigo-50/70 p-6 dark:border-indigo-500/20 dark:bg-indigo-500/10'><p class='mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-indigo-700 dark:text-indigo-200'>Your subscription</p><p class='mt-3 mb-0 text-xl font-semibold text-slate-900 dark:text-white'>No token markup.</p><p class='mt-3 mb-0 text-sm text-slate-600 dark:text-slate-300'>Claude Pro, ChatGPT Plus, Cursor, or Gemini Advanced do the thinking. NextBlock never resells tokens.</p></div><div class='rounded-3xl border border-emerald-200/70 bg-emerald-50/70 p-6 dark:border-emerald-500/20 dark:bg-emerald-500/10'><p class='mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200'>Live Drafts</p><p class='mt-3 mb-0 text-xl font-semibold text-slate-900 dark:text-white'>Nothing ships by accident.</p><p class='mt-3 mb-0 text-sm text-slate-600 dark:text-slate-300'>Every layout the agent writes lands as a draft. An editor reviews it and hits publish.</p></div></div><p>Every prompt becomes a structured database record rather than a pile of generated code. Your editors keep a visual CMS, your developers keep a clean Next.js 16 app, and nothing goes live until someone hits publish.</p><h2>The Problem with Traditional AI Web Builders</h2><p>Prompt builders such as Lovable, Bolt, and v0 are impressive on day one. You describe a page and get a working React app in minutes. The trouble starts on day two.</p><div class='grid gap-4 md:grid-cols-2 my-8'><div class='rounded-3xl border border-rose-200/70 bg-rose-50/70 p-6 dark:border-rose-500/20 dark:bg-rose-500/10'><p class='mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-rose-700 dark:text-rose-200'>Prototype tools</p><p class='mt-3 mb-0 text-xl font-semibold text-slate-900 dark:text-white'>A codebase to babysit.</p><p class='mt-3 mb-0 text-sm text-slate-600 dark:text-slate-300'>The output is disposable code with no content layer. Every headline change is another prompt or another pull request. There are no drafts, no revisions, no translations, and no SEO checks for the people who own the words.</p></div><div class='rounded-3xl border border-emerald-200/70 bg-emerald-50/70 p-6 dark:border-emerald-500/20 dark:bg-emerald-500/10'><p class='mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200'>NextBlock</p><p class='mt-3 mb-0 text-xl font-semibold text-slate-900 dark:text-white'>A website plus a CMS.</p><p class='mt-3 mb-0 text-sm text-slate-600 dark:text-slate-300'>AI scaffolds the site once, and a real CMS runs it forever. Marketing edits copy in a Notion-style editor. Engineers keep a codebase nobody has to babysit.</p></div></div><p>NextBlock takes the opposite view from the prototype tools. AI should draft the site, and people should own it. The MCP connection is how those two worlds meet.</p><h2>How Cortex AI Uses Model Context Protocol (MCP)</h2><p>Model Context Protocol is an open standard for giving AI agents tools. A client such as Claude Code lists the tools a server offers, calls them with typed arguments, and reads typed results back. Cortex AI ships that server inside your NextBlock install at <code>/api/mcp</code>.</p><figure class='my-12 overflow-hidden rounded-[2rem] border border-slate-200/80 bg-slate-950 shadow-2xl dark:border-white/10'><img src='/images/mcp-prompt-to-production.webp' alt='Diagram of the prompt-to-production flow: an AI client calls the Cortex AI MCP server at /api/mcp, which writes validated JSONB blocks to PostgreSQL that Next.js 16 publishes without a redeploy' class='w-full h-auto object-cover' /><figcaption class='border-t border-white/10 px-6 py-4 text-sm text-slate-300'>One prompt travels from your AI client, through the MCP server, into PostgreSQL as validated blocks, and out as a published page. No build step sits in between.</figcaption></figure><p>The endpoint speaks Streamable HTTP. Your client posts JSON-RPC messages over a normal HTTPS request, and the server answers in the same response. There is no long-lived SSE stream to babysit and no SDK to install on the server side. The same 29 typed tools that power the dashboard copilot are exposed over the wire, so the agent in your editor and the agent in your CMS never drift apart.</p><div class='grid gap-4 md:grid-cols-2 my-8'><div class='rounded-3xl border border-violet-200/70 bg-violet-50/70 p-6 dark:border-violet-500/20 dark:bg-violet-500/10'><p class='mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-violet-700 dark:text-violet-200'>Safety rule one</p><p class='mt-3 mb-0 text-xl font-semibold text-slate-900 dark:text-white'>Layouts stage as Live Drafts.</p><p class='mt-3 mb-0 text-sm text-slate-600 dark:text-slate-300'>Layout tools write drafts, so nothing reaches visitors until an editor publishes it.</p></div><div class='rounded-3xl border border-blue-200/70 bg-blue-50/70 p-6 dark:border-blue-500/20 dark:bg-blue-500/10'><p class='mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-blue-700 dark:text-blue-200'>Safety rule two</p><p class='mt-3 mb-0 text-xl font-semibold text-slate-900 dark:text-white'>Every token carries a scope.</p><p class='mt-3 mb-0 text-sm text-slate-600 dark:text-slate-300'>A read-only token never even sees a tool that could change data. Mutating tools are absent from its list.</p></div></div><h3>Available MCP Database Tools</h3><p>Five tool names form the public MCP contract. Each one forwards to a tested Cortex AI executor.</p><div class='grid gap-4 md:grid-cols-2 my-8'><div class='rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-white/5'><div class='flex items-center justify-between gap-3'><code class='rounded-lg bg-violet-50 px-2.5 py-1 text-sm text-violet-700 dark:bg-violet-500/15 dark:text-violet-200'>get_database_schema</code><span class='rounded-full border px-2.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.18em] border-emerald-300 text-emerald-700 dark:border-emerald-500/40 dark:text-emerald-200'>read</span></div><p class='mt-3 mb-0 text-sm text-slate-600 dark:text-slate-300'>Returns every table the agent may read or change, with columns, primary keys, and read-only flags.</p></div><div class='rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-white/5'><div class='flex items-center justify-between gap-3'><code class='rounded-lg bg-violet-50 px-2.5 py-1 text-sm text-violet-700 dark:bg-violet-500/15 dark:text-violet-200'>generate_jsonb_layout</code><span class='rounded-full border px-2.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.18em] border-amber-300 text-amber-700 dark:border-amber-500/40 dark:text-amber-200'>write</span></div><p class='mt-3 mb-0 text-sm text-slate-600 dark:text-slate-300'>Turns a prompt into a full page layout, validates each block against the NextBlock schema, and stages it as a Live Draft.</p></div><div class='rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-white/5'><div class='flex items-center justify-between gap-3'><code class='rounded-lg bg-violet-50 px-2.5 py-1 text-sm text-violet-700 dark:bg-violet-500/15 dark:text-violet-200'>update_site_navigation</code><span class='rounded-full border px-2.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.18em] border-amber-300 text-amber-700 dark:border-amber-500/40 dark:text-amber-200'>write</span></div><p class='mt-3 mb-0 text-sm text-slate-600 dark:text-slate-300'>Adds, renames, or reorders header menu items per locale.</p></div><div class='rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-white/5'><div class='flex items-center justify-between gap-3'><code class='rounded-lg bg-violet-50 px-2.5 py-1 text-sm text-violet-700 dark:bg-violet-500/15 dark:text-violet-200'>query_site_analytics</code><span class='rounded-full border px-2.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.18em] border-emerald-300 text-emerald-700 dark:border-emerald-500/40 dark:text-emerald-200'>read</span></div><p class='mt-3 mb-0 text-sm text-slate-600 dark:text-slate-300'>Reads revenue, order counts, status breakdowns, and top products over a date range.</p></div><div class='rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-white/5'><div class='flex items-center justify-between gap-3'><code class='rounded-lg bg-violet-50 px-2.5 py-1 text-sm text-violet-700 dark:bg-violet-500/15 dark:text-violet-200'>search_stock_media</code><span class='rounded-full border px-2.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.18em] border-emerald-300 text-emerald-700 dark:border-emerald-500/40 dark:text-emerald-200'>read</span></div><p class='mt-3 mb-0 text-sm text-slate-600 dark:text-slate-300'>Finds free stock photos with alt text and photographer credits ready for an image block.</p></div><div class='rounded-3xl border border-dashed border-slate-300 p-5 dark:border-white/20'><p class='mt-0 mb-0 text-sm font-semibold text-slate-900 dark:text-white'>And 24 more.</p><p class='mt-2 mb-0 text-sm text-slate-600 dark:text-slate-300'>Create posts and products, translate pages, upload media, manage themes and scripts. Three resources expose the database, block, and custom block schemas.</p></div></div><h2>Step by Step: Connect Claude to NextBlock CMS in Cursor and Claude Code</h2><p>The server is off by default because it is a remote write surface onto live content. Turning it on takes three steps.</p><div class='grid gap-4 md:grid-cols-3 my-8'><div class='rounded-3xl border border-slate-200 bg-slate-50 p-6 dark:border-white/10 dark:bg-white/5'><p class='mt-0 mb-0 font-mono text-3xl font-bold text-sky-500 dark:text-sky-300'>01</p><p class='mt-3 mb-0 text-lg font-semibold text-slate-900 dark:text-white'>Enable the server.</p><p class='mt-2 mb-0 text-sm text-slate-600 dark:text-slate-300'>Open <strong>CMS Settings → Cortex AI</strong> and switch on the MCP server access card.</p></div><div class='rounded-3xl border border-slate-200 bg-slate-50 p-6 dark:border-white/10 dark:bg-white/5'><p class='mt-0 mb-0 font-mono text-3xl font-bold text-violet-500 dark:text-violet-300'>02</p><p class='mt-3 mb-0 text-lg font-semibold text-slate-900 dark:text-white'>Mint a token.</p><p class='mt-2 mb-0 text-sm text-slate-600 dark:text-slate-300'>Pick the scope you need. Read-only is enough for planning and audits.</p></div><div class='rounded-3xl border border-slate-200 bg-slate-50 p-6 dark:border-white/10 dark:bg-white/5'><p class='mt-0 mb-0 font-mono text-3xl font-bold text-emerald-500 dark:text-emerald-300'>03</p><p class='mt-3 mb-0 text-lg font-semibold text-slate-900 dark:text-white'>Copy the config.</p><p class='mt-2 mb-0 text-sm text-slate-600 dark:text-slate-300'>The card renders one snippet each for Claude Code, Cursor, VS Code, and Claude Desktop.</p></div></div><p>Claude Code needs <code>\"type\": \"http\"</code> in the entry, or it skips the server without a warning. Cursor infers the transport from the URL and needs no type field. VS Code uses a top-level <code>servers</code> key and prompts for the token instead of storing it.</p><h3>Localhost Configuration Without a Token</h3><p>While you build, turn on <strong>Trust localhost without a token</strong> in the same settings card. A dev server on your machine then accepts loopback calls with no header at all. Standalone installs run on port 3000, and the monorepo dev server runs on port 4200.</p><p>Add this block to <code>.mcp.json</code> in your project root for Claude Code.</p><div class='my-8 overflow-hidden rounded-[2rem] border border-slate-800 bg-slate-950 shadow-2xl'><div class='flex items-center gap-2 border-b border-white/10 px-5 py-3'><span class='h-3 w-3 rounded-full bg-red-400/70'></span><span class='h-3 w-3 rounded-full bg-yellow-400/70'></span><span class='h-3 w-3 rounded-full bg-green-400/70'></span><span class='ml-3 text-xs font-mono text-slate-400'>.mcp.json</span></div><pre class='m-0 overflow-x-auto rounded-none bg-transparent px-6 py-5 text-sm leading-6 text-slate-200'><code>{\n  \"mcpServers\": {\n    \"nextblock\": {\n      \"type\": \"http\",\n      \"url\": \"http://localhost:3000/api/mcp\"\n    }\n  }\n}</code></pre></div><p>The CLI form does the same thing in one line.</p><div class='my-8 overflow-hidden rounded-[2rem] border border-slate-800 bg-slate-950 shadow-2xl'><div class='flex items-center gap-2 border-b border-white/10 px-5 py-3'><span class='h-3 w-3 rounded-full bg-red-400/70'></span><span class='h-3 w-3 rounded-full bg-yellow-400/70'></span><span class='h-3 w-3 rounded-full bg-green-400/70'></span><span class='ml-3 text-xs font-mono text-slate-400'>terminal</span></div><pre class='m-0 overflow-x-auto rounded-none bg-transparent px-6 py-5 text-sm leading-6 text-slate-200'><code>claude mcp add --transport http nextblock http://localhost:3000/api/mcp</code></pre></div><div class='rounded-3xl border border-amber-200 bg-amber-50/80 p-6 my-8 dark:border-amber-500/20 dark:bg-amber-500/10'><p class='mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-amber-700 dark:text-amber-200'>Development only</p><p class='mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200'>Localhost trust is ignored in production builds, because a proxy can spoof the host header. Production always uses a token.</p></div><h3>Production Authentication via Bearer Tokens</h3><p>In production every client sends a bearer token. Tokens start with <code>nbmcp_</code>, are shown once at mint time, and are stored only as SHA-256 hashes. Revoking one is a single click, and the same value can never be minted again.</p><p>Add this to <code>.cursor/mcp.json</code> for Cursor, or drop the same entry into <code>.mcp.json</code> with a type field for Claude Code.</p><div class='my-8 overflow-hidden rounded-[2rem] border border-slate-800 bg-slate-950 shadow-2xl'><div class='flex items-center gap-2 border-b border-white/10 px-5 py-3'><span class='h-3 w-3 rounded-full bg-red-400/70'></span><span class='h-3 w-3 rounded-full bg-yellow-400/70'></span><span class='h-3 w-3 rounded-full bg-green-400/70'></span><span class='ml-3 text-xs font-mono text-slate-400'>.cursor/mcp.json</span></div><pre class='m-0 overflow-x-auto rounded-none bg-transparent px-6 py-5 text-sm leading-6 text-slate-200'><code>{\n  \"mcpServers\": {\n    \"nextblock\": {\n      \"url\": \"https://your-site.com/api/mcp\",\n      \"headers\": { \"Authorization\": \"Bearer nbmcp_your_token\" }\n    }\n  }\n}</code></pre></div><div class='rounded-3xl border border-violet-200 bg-violet-50/80 p-6 my-8 dark:border-violet-500/20 dark:bg-violet-500/10'><p class='mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-violet-700 dark:text-violet-200'>Try it</p><p class='mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200'>Once the client connects, ask for something concrete. Try &ldquo;inspect the database schema and draft a pricing page with three tiers.&rdquo; The agent calls the schema tool, then the layout tool, and your CMS shows a new Live Draft ready for review.</p></div><h2>Zero-Redeploy Production Rendering</h2><p>The reason this works is where the output lands. Cortex AI writes strict JSONB block records into PostgreSQL, not HTML strings and not source files. Each block has a Zod schema, so a bad field is rejected before it is stored.</p><div class='grid gap-4 md:grid-cols-3 my-8'><div class='rounded-3xl border border-sky-200/70 bg-sky-50/70 p-6 text-center dark:border-sky-500/20 dark:bg-sky-500/10'><p class='mt-0 mb-0 text-4xl font-extrabold text-slate-900 dark:text-white'>0</p><p class='mt-2 mb-0 text-xs font-semibold uppercase tracking-[0.2em] text-sky-700 dark:text-sky-200'>Rebuilds to publish</p></div><div class='rounded-3xl border border-violet-200/70 bg-violet-50/70 p-6 text-center dark:border-violet-500/20 dark:bg-violet-500/10'><p class='mt-0 mb-0 text-4xl font-extrabold text-slate-900 dark:text-white'>1</p><p class='mt-2 mb-0 text-xs font-semibold uppercase tracking-[0.2em] text-violet-700 dark:text-violet-200'>Zod schema per block</p></div><div class='rounded-3xl border border-emerald-200/70 bg-emerald-50/70 p-6 text-center dark:border-emerald-500/20 dark:bg-emerald-500/10'><p class='mt-0 mb-0 text-4xl font-extrabold text-slate-900 dark:text-white'>100</p><p class='mt-2 mb-0 text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700 dark:text-emerald-200'>Lighthouse by default</p></div></div><p>At request time Next.js 16 renders those records with Server Components and caches the result at the edge. There is no build step between publish and live, and no HTML sanitizer tax on every render. The 100/100 Lighthouse defaults you get on an empty site are the same ones you get after the agent has drafted fifty pages.</p><div class='rounded-3xl border border-slate-200 bg-slate-50 p-6 my-10 dark:border-white/10 dark:bg-white/5'><p class='mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-slate-600 dark:text-slate-300'>Next step</p><p class='mt-3 mb-0 text-xl font-semibold text-slate-900 dark:text-white'>Connect your agent today.</p><p class='mt-3 text-sm text-slate-600 dark:text-slate-300'>One license unlocks the dashboard copilot and the MCP server. Read how the block registry keeps all of it safe if you want the full picture.</p><div class='mt-5 flex flex-wrap gap-3'><a href='https://nextblock.dev/product/nextblock-cortex-ai-cortex-ai-license' class='inline-flex items-center rounded-full bg-slate-900 px-6 py-3 text-sm font-semibold text-white no-underline shadow-lg hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200'>Get the Cortex AI license</a><a href='/article/how-nextblock-works' class='inline-flex items-center rounded-full border border-slate-300 px-6 py-3 text-sm font-semibold text-slate-700 no-underline hover:border-slate-500 dark:border-white/20 dark:text-slate-200 dark:hover:border-white/50'>How NextBlock works</a></div></div>"}$nbmcpguide2$::jsonb,
           updated_at = now()
     WHERE post_id = v_post
       AND block_type = 'text'
       AND "order" = 0
       AND content->>'html_content' LIKE '{"type":"doc"%'
       AND content->>'html_content' LIKE '%This guide shows you how to connect Claude to NextBlock CMS with an open standard%';
  END IF;
END
$body$;
$nb_file_00000000000038$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000038_mcp_guide_visual_refresh.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000038_mcp_guide_visual_refresh.sql

  -- >>> FROM: 00000000000039_mcp_guide_diagram_dimensions.sql
  IF NOT pg_temp.nb_recorded('00000000000039', '00000000000039_mcp_guide_diagram_dimensions') THEN
    RAISE NOTICE 'catch-up: applying 00000000000039_mcp_guide_diagram_dimensions.sql';
    EXECUTE $nb_file_00000000000039$
-- 00000000000039_mcp_guide_diagram_dimensions.sql
--
-- 00000000000038 registered public/images/mcp-prompt-to-production.webp at 2000x1025.
-- The rendered figure was blurry because next/image was told it displays at 768px,
-- re-encoded it as quality-60 AVIF and the browser upscaled the result to the
-- full article width. The asset is now re-rendered at 2560x1312
-- and served unoptimized (see ClientTextBlockRenderer's knownCmsImages); this
-- brings the media-library row in line with the file on disk. 038 is already
-- applied, so this is a separate file.
--
-- Idempotent: keyed by media.object_key, guarded on the values differing.

UPDATE public.media
   SET width      = 2560,
       height     = 1312,
       size_bytes = 156358,
       updated_at = now()
 WHERE object_key = 'images/mcp-prompt-to-production.webp'
   AND (width IS DISTINCT FROM 2560
        OR height IS DISTINCT FROM 1312
        OR size_bytes IS DISTINCT FROM 156358);
$nb_file_00000000000039$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000039_mcp_guide_diagram_dimensions.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000039_mcp_guide_diagram_dimensions.sql

  -- >>> FROM: 00000000000040_home_comparison_chart_free_cms.sql
  IF NOT pg_temp.nb_recorded('00000000000040', '00000000000040_home_comparison_chart_free_cms') THEN
    RAISE NOTICE 'catch-up: applying 00000000000040_home_comparison_chart_free_cms.sql';
    EXECUTE $nb_file_00000000000040$
-- 00000000000040_home_comparison_chart_free_cms.sql
--
-- Two marketing changes to the EN home page that 00000000000037 seeded:
--
--   1. The prototype-tools-versus-NextBlock block under "Why an AI Website Builder
--      CMS Beats Prototype Code" was two prose cards that did not read as a
--      comparison. It is now a seven-row comparison chart (day-one output, editing,
--      drafts and revisions, publishing, translations and SEO, AI costs, price)
--      with the NextBlock column highlighted, followed by three pricing tiles.
--   2. The pricing story is explicit everywhere the AI is mentioned: the CMS is
--      100% free and open source, forever; Cortex AI is the one paid license, and
--      it runs on the AI subscription the customer already has (no token markup).
--      The hero card, the pricing tiles and the Cortex promo all carry it.
--
-- 037 is already applied on the sandbox, so this is a separate file. Each UPDATE
-- is guarded on a phrase unique to the 037 copy (Production on day two. / A codebase to babysit. /
-- One AI Engine) that the new copy does not contain, so re-runs are no-ops and a
-- home page an editor has since customised is left alone. The page still grades
-- 100/100 with the focus keyphrase "AI website builder CMS" (libs/utils/src/lib/seo).
--
-- After adding this file: npm run generate:migrations-bundle && npm run
-- generate:sandbox && npm run sync:create-nextblock.

DO $body$
DECLARE
  v_en   integer;
  v_home integer;
BEGIN
  SELECT id INTO v_en FROM public.languages WHERE code = 'en' LIMIT 1;

  SELECT id INTO v_home
    FROM public.pages
   WHERE slug = 'home' AND language_id = v_en
   ORDER BY id
   LIMIT 1;

  IF v_home IS NULL THEN
    RETURN;
  END IF;

  -- Hero: same H1; subtitle now says free and open source; right card carries the
  -- "Free CMS. Paid AI." message; primary CTA reads "Start Free".
  UPDATE public.blocks
     SET content = $nbhero2${"is_hero":true,"padding":{"top":"xl","bottom":"xl"},"background":{"type":"gradient","gradient":{"type":"linear","stops":[{"color":"#020817","position":0},{"color":"#0f172a","position":50},{"color":"#1e293b","position":100}],"direction":"135deg"}},"column_gap":"xl","column_blocks":[[{"block_type":"text","content":{"html_content":"<h1 class='text-5xl md:text-6xl font-extrabold tracking-tight text-white text-center leading-tight'>Prompt to <span class='relative inline-block mx-1 group'><span class='absolute inset-0 bg-gradient-to-r from-blue-600 to-cyan-400 translate-y-1 md:translate-y-2 transform -skew-x-12 rounded-sm shadow-lg group-hover:skew-x-0 transition-transform duration-300 ease-out'></span><span class='relative text-white italic px-1'>Production</span></span>.<br class='md:hidden' /> The AI Website Builder CMS.</h1>"}},{"block_type":"text","content":{"html_content":"<p class='text-xl text-slate-300 text-center max-w-3xl mx-auto mt-4 leading-relaxed'>NextBlock is the free, open-source AI website builder CMS for teams that want more than a prototype. Point Claude Code, Cursor, or ChatGPT at your site over MCP and prompt the pages you need. You keep a live Next.js 16 and Supabase website with a visual editor your team owns on day two.</p>"}},{"block_type":"button","content":{"url":"/article/how-to-setup-nextblock","size":"lg","text":"Start Free","variant":"default","position":"center"}},{"block_type":"button","content":{"url":"/article/cortex-ai-mcp-connection-guide","size":"lg","text":"Connect Claude or Cursor","variant":"outline","position":"center"}},{"block_type":"text","content":{"html_content":"<div class='flex flex-wrap justify-center gap-6 text-sm uppercase tracking-wide text-slate-400 mt-8'><a href='https://github.com/nextblock-cms' target='_blank' rel='noopener noreferrer' class='hover:text-white transition-colors'>GitHub</a><a href='https://x.com/NextBlockCMS' target='_blank' rel='noopener noreferrer' class='hover:text-white transition-colors'>X</a><a href='https://www.linkedin.com/in/nextblock/' target='_blank' rel='noopener noreferrer' class='hover:text-white transition-colors'>LinkedIn</a><a href='https://dev.to/nextblockcms' target='_blank' rel='noopener noreferrer' class='hover:text-white transition-colors'>Dev.to</a><a href='https://www.npmjs.com/~nextblockcms' target='_blank' rel='noopener noreferrer' class='hover:text-white transition-colors'>npm</a></div>"}}],[{"block_type":"text","content":{"html_content":"<div class='p-10 border border-white/10 rounded-3xl bg-white/5 backdrop-blur-xl shadow-2xl relative overflow-hidden group'><div class='absolute inset-0 bg-gradient-to-br from-blue-500/10 to-purple-500/10 opacity-0 group-hover:opacity-100 transition-opacity duration-500'></div><div class='relative z-10'><p class='text-xs text-white uppercase tracking-widest font-semibold mb-2'>Free forever. AI optional.</p><p class='text-3xl font-bold text-white mb-2'>Free CMS. Paid AI. Your call.</p><p class='text-base text-slate-300 mb-6'>The CMS is 100% free and open source. Cortex AI is the one thing we sell, and it runs on the AI subscription you already have.</p><ul class='space-y-3 text-sm text-slate-200'><li><span class='text-blue-400 mr-2'>&#10003;</span> Unlimited pages, editors, and sites at no cost.</li><li><span class='text-blue-400 mr-2'>&#10003;</span> One Cortex AI license unlocks the copilot and the MCP server.</li><li><span class='text-blue-400 mr-2'>&#10003;</span> No token markup: your Claude or ChatGPT plan does the work.</li></ul><div class='mt-6 rounded-2xl overflow-hidden border border-white/10 shadow-lg'><div class='relative w-full aspect-video'><iframe class='absolute inset-0 h-full w-full border-0' src='https://www.youtube-nocookie.com/embed/71MyfoL4YVM?si=jtlDXV6cSC8rDgz0' title='NextBlock demo video' allow='accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share' referrerpolicy='strict-origin-when-cross-origin' loading='lazy' allowfullscreen></iframe></div></div></div></div>"}}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":2},"vertical_alignment":"center"}$nbhero2$::jsonb,
         updated_at = now()
   WHERE page_id = v_home
     AND block_type = 'section'
     AND content::text LIKE '%Production on day two.%';

  -- "Why" section: comparison chart + pricing tiles replace the two prose cards.
  UPDATE public.blocks
     SET content = $nbwhy2${"padding":{"top":"xl","bottom":"xl"},"background":{"type":"none"},"column_gap":"lg","column_blocks":[[{"block_type":"heading","content":{"level":2,"textAlign":"center","text_content":"Why an AI Website Builder CMS Beats Prototype Code."}},{"block_type":"text","content":{"html_content":"<p class='text-lg text-muted-foreground text-center max-w-3xl mx-auto mb-10'>Prompt builders like Lovable, Bolt, and v0 are great at a first draft. Then they hand you code you must host, patch, and rebuild for every copy change. NextBlock takes the same prompts and turns them into a website your whole team can run.</p>"}},{"block_type":"text","content":{"html_content":"<div class='grid gap-6 md:grid-cols-3'><div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-blue-300 dark:border-slate-800 dark:bg-slate-900'><div class='mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-xl dark:bg-blue-950'>🧩</div><h3 class='text-lg font-bold text-foreground mb-2'>Prompt to CMS, Not Just Code.</h3><p class='text-sm text-muted-foreground leading-relaxed'>External AI agents scaffold real layouts as typed blocks. Editors then tweak copy, images, and sections in a Notion-style editor. Nobody writes a prompt or touches code to change a headline.</p></div><div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-blue-300 dark:border-slate-800 dark:bg-slate-900'><div class='mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-xl dark:bg-blue-950'>🔌</div><h3 class='text-lg font-bold text-foreground mb-2'>Bring Your Own AI Subscription via MCP.</h3><p class='text-sm text-muted-foreground leading-relaxed'>Connect Claude Code, Cursor, ChatGPT, or Gemini straight to /api/mcp. You pay for the AI plan you already have, not a SaaS token markup.</p></div><div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-blue-300 dark:border-slate-800 dark:bg-slate-900'><div class='mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-xl dark:bg-blue-950'>⚡</div><h3 class='text-lg font-bold text-foreground mb-2'>Zero-Redeploy JSONB Architecture.</h3><p class='text-sm text-muted-foreground leading-relaxed'>Generated blocks land in PostgreSQL as validated JSONB. Pages publish in seconds with 100/100 Lighthouse defaults and no rebuild.</p></div></div>"}},{"block_type":"text","content":{"html_content":"<div class='mt-12 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900'><div class='flex flex-wrap items-end justify-between gap-3 px-5 pt-6 pb-4'><div><p class='text-xs font-semibold uppercase tracking-[0.22em] text-slate-500 dark:text-slate-400'>Side by side</p><p class='mt-1 text-xl font-semibold text-foreground'>Prototype tools versus NextBlock.</p></div><p class='text-xs text-slate-500 dark:text-slate-400'>Lovable, Bolt, and v0 compared on what happens after the first prompt.</p></div><div class='overflow-x-auto'><table class='w-full min-w-[640px] border-collapse'><thead><tr class='bg-slate-50 dark:bg-slate-950/60'><th scope='col' class='px-5 py-3 text-left text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400'>What you get</th><th scope='col' class='px-5 py-3 text-left text-xs font-semibold uppercase tracking-[0.2em] text-rose-600 dark:text-rose-300'>Lovable, Bolt, v0</th><th scope='col' class='bg-emerald-50/60 px-5 py-3 text-left text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-200'>NextBlock</th></tr></thead><tbody><tr class='border-t border-slate-200 dark:border-slate-800'><th scope='row' class='px-5 py-4 text-left align-top text-sm font-semibold text-foreground'>Day one</th><td class='px-5 py-4 align-top text-sm text-muted-foreground'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-rose-100 text-xs font-bold text-rose-600 dark:bg-rose-500/20 dark:text-rose-300'>&#10007;</span>Prototype code you host and patch yourself.</td><td class='bg-emerald-50/60 px-5 py-4 align-top text-sm text-foreground dark:bg-emerald-500/10'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200'>&#10003;</span>A live Next.js 16 and Supabase website.</td></tr><tr class='border-t border-slate-200 dark:border-slate-800'><th scope='row' class='px-5 py-4 text-left align-top text-sm font-semibold text-foreground'>Editing after launch</th><td class='px-5 py-4 align-top text-sm text-muted-foreground'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-rose-100 text-xs font-bold text-rose-600 dark:bg-rose-500/20 dark:text-rose-300'>&#10007;</span>A new prompt or a pull request for every change.</td><td class='bg-emerald-50/60 px-5 py-4 align-top text-sm text-foreground dark:bg-emerald-500/10'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200'>&#10003;</span>A Notion-style visual editor, no code needed.</td></tr><tr class='border-t border-slate-200 dark:border-slate-800'><th scope='row' class='px-5 py-4 text-left align-top text-sm font-semibold text-foreground'>Drafts and revisions</th><td class='px-5 py-4 align-top text-sm text-muted-foreground'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-rose-100 text-xs font-bold text-rose-600 dark:bg-rose-500/20 dark:text-rose-300'>&#10007;</span>Code history only, nothing for content.</td><td class='bg-emerald-50/60 px-5 py-4 align-top text-sm text-foreground dark:bg-emerald-500/10'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200'>&#10003;</span>Live Drafts and one-click restore of any page.</td></tr><tr class='border-t border-slate-200 dark:border-slate-800'><th scope='row' class='px-5 py-4 text-left align-top text-sm font-semibold text-foreground'>Publishing</th><td class='px-5 py-4 align-top text-sm text-muted-foreground'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-rose-100 text-xs font-bold text-rose-600 dark:bg-rose-500/20 dark:text-rose-300'>&#10007;</span>Rebuild and redeploy.</td><td class='bg-emerald-50/60 px-5 py-4 align-top text-sm text-foreground dark:bg-emerald-500/10'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200'>&#10003;</span>Instant, straight from PostgreSQL.</td></tr><tr class='border-t border-slate-200 dark:border-slate-800'><th scope='row' class='px-5 py-4 text-left align-top text-sm font-semibold text-foreground'>Translations and SEO</th><td class='px-5 py-4 align-top text-sm text-muted-foreground'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-rose-100 text-xs font-bold text-rose-600 dark:bg-rose-500/20 dark:text-rose-300'>&#10007;</span>Not built in.</td><td class='bg-emerald-50/60 px-5 py-4 align-top text-sm text-foreground dark:bg-emerald-500/10'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200'>&#10003;</span>Per-block translation and SEO graded as you type.</td></tr><tr class='border-t border-slate-200 dark:border-slate-800'><th scope='row' class='px-5 py-4 text-left align-top text-sm font-semibold text-foreground'>AI costs</th><td class='px-5 py-4 align-top text-sm text-muted-foreground'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-rose-100 text-xs font-bold text-rose-600 dark:bg-rose-500/20 dark:text-rose-300'>&#10007;</span>Platform credits, bought from the tool.</td><td class='bg-emerald-50/60 px-5 py-4 align-top text-sm text-foreground dark:bg-emerald-500/10'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200'>&#10003;</span>Your own subscription over MCP, no markup.</td></tr><tr class='border-t border-slate-200 dark:border-slate-800'><th scope='row' class='px-5 py-4 text-left align-top text-sm font-semibold text-foreground'>Price of the platform</th><td class='px-5 py-4 align-top text-sm text-muted-foreground'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-rose-100 text-xs font-bold text-rose-600 dark:bg-rose-500/20 dark:text-rose-300'>&#10007;</span>A monthly plan.</td><td class='bg-emerald-50/60 px-5 py-4 align-top text-sm text-foreground dark:bg-emerald-500/10'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200'>&#10003;</span>Free and open source, forever.</td></tr></tbody></table></div></div>"}},{"block_type":"text","content":{"html_content":"<div class='mt-10 grid gap-4 md:grid-cols-3'><div class='rounded-3xl border border-emerald-200/70 bg-emerald-50/70 p-6 dark:border-emerald-500/20 dark:bg-emerald-500/10'><p class='text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200'>Free forever</p><p class='mt-3 text-xl font-semibold text-foreground'>The CMS costs nothing.</p><p class='mt-3 text-sm text-muted-foreground'>The AI website builder CMS is free and open source. Unlimited pages, editors, and sites, self-hosted or on Vercel, with no plan to outgrow.</p></div><div class='rounded-3xl border border-violet-200/70 bg-violet-50/70 p-6 dark:border-violet-500/20 dark:bg-violet-500/10'><p class='text-xs font-semibold uppercase tracking-[0.22em] text-violet-700 dark:text-violet-200'>Cortex AI, when you want it</p><p class='mt-3 text-xl font-semibold text-foreground'>One license, two AI surfaces.</p><p class='mt-3 text-sm text-muted-foreground'>A paid Cortex AI license adds the dashboard copilot and the MCP server. Start without it and add it later. Your content never changes.</p></div><div class='rounded-3xl border border-sky-200/70 bg-sky-50/70 p-6 dark:border-sky-500/20 dark:bg-sky-500/10'><p class='text-xs font-semibold uppercase tracking-[0.22em] text-sky-700 dark:text-sky-200'>No token markup</p><p class='mt-3 text-xl font-semibold text-foreground'>Your plan does the work.</p><p class='mt-3 text-sm text-muted-foreground'>Cortex AI runs on the Claude, ChatGPT, Cursor, or Gemini subscription you already pay for. The license buys the connection, not the tokens.</p></div></div>"}}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":1}}$nbwhy2$::jsonb,
         updated_at = now()
   WHERE page_id = v_home
     AND block_type = 'section'
     AND content::text LIKE '%A codebase to babysit.%';

  -- Cortex promo: "The CMS Is Free. The AI Is the Upgrade."
  UPDATE public.blocks
     SET content = $nbcortexpromo2${"padding":{"top":"xl","bottom":"xl"},"background":{"type":"gradient","gradient":{"type":"linear","stops":[{"color":"#1e1b4b","position":0},{"color":"#0f172a","position":100}],"direction":"135deg"}},"column_gap":"xl","column_blocks":[[{"block_type":"text","content":{"html_content":"<p class='text-xs uppercase tracking-[0.3em] text-violet-400 font-semibold mb-4'>Now Available — Cortex AI</p><h2 class='text-4xl md:text-5xl font-bold text-white mb-6 leading-tight'>The CMS Is Free.<br/>The AI Is the Upgrade.</h2><p class='text-lg text-slate-300 max-w-2xl leading-relaxed mb-4'>NextBlock costs nothing and never will. Cortex AI is the one license we sell. It adds a copilot inside the dashboard and an MCP server outside it, so Claude Code, Cursor, ChatGPT, and Gemini can build your site.</p><p class='text-base text-slate-400 max-w-2xl leading-relaxed'>You bring the AI subscription you already pay for. The license buys the connection, never the tokens, and nothing goes live until an editor publishes it.</p>"}},{"block_type":"button","content":{"url":"/article/cortex-ai-mcp-connection-guide","size":"lg","text":"Read the MCP Setup Guide →","variant":"default","position":"left"}},{"block_type":"button","content":{"url":"https://nextblock.dev/product/nextblock-cortex-ai-cortex-ai-license","size":"lg","text":"Get a License","variant":"outline","position":"left"}}],[{"block_type":"text","content":{"html_content":"<div class='grid grid-cols-1 gap-4 sm:grid-cols-3 lg:grid-cols-1'><div class='rounded-2xl border border-violet-500/30 bg-white/5 p-6 text-center'><p class='text-3xl font-extrabold text-white'>$0</p><p class='text-xs uppercase tracking-wider text-violet-200 mt-1'>The CMS, forever</p></div><div class='rounded-2xl border border-violet-500/30 bg-white/5 p-6 text-center'><p class='text-3xl font-extrabold text-white'>1</p><p class='text-xs uppercase tracking-wider text-violet-200 mt-1'>License for copilot and MCP server</p></div><div class='rounded-2xl border border-violet-500/30 bg-white/5 p-6 text-center'><p class='text-3xl font-extrabold text-white'>0 %</p><p class='text-xs uppercase tracking-wider text-violet-200 mt-1'>Token markup</p></div></div>"}}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":2},"vertical_alignment":"center"}$nbcortexpromo2$::jsonb,
         updated_at = now()
   WHERE page_id = v_home
     AND block_type = 'section'
     AND content::text LIKE '%One AI Engine%';
END
$body$;

-- The MCP guide's featured image (public/images/cortex_post.webp) was
-- replaced with a re-cut 1672x941 version after 037
-- registered it at 2664x1568. The post
-- hero reserves its box from media.width/height, so bring the row in line with the
-- file on disk. Guarded on the values differing.
UPDATE public.media
   SET width      = 1672,
       height     = 941,
       size_bytes = 503790,
       updated_at = now()
 WHERE object_key = 'images/cortex_post.webp'
   AND (width IS DISTINCT FROM 1672
        OR height IS DISTINCT FROM 941
        OR size_bytes IS DISTINCT FROM 503790);
$nb_file_00000000000040$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000040_home_comparison_chart_free_cms.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000040_home_comparison_chart_free_cms.sql

  -- >>> FROM: 00000000000041_marketing_review_free_cms_trial.sql
  IF NOT pg_temp.nb_recorded('00000000000041', '00000000000041_marketing_review_free_cms_trial') THEN
    RAISE NOTICE 'catch-up: applying 00000000000041_marketing_review_free_cms_trial.sql';
    EXECUTE $nb_file_00000000000041$
-- 00000000000041_marketing_review_free_cms_trial.sql
--
-- Marketing review of every seeded surface that sells Cortex AI, after
-- 037/038/040 were applied. Four changes, all copy:
--
--   1. Pricing is stated wherever the AI is mentioned, not only at the bottom of
--      the home page: the CMS is 100% free and open source, forever; Cortex AI
--      (the in-editor AI plus the MCP server) is the one paid license, and it
--      starts with a 30-day free trial with no credit card (matching
--      products.trial_period_days / trial_requires_payment_method on the Cortex
--      product). The hero now leads with "deploy to Vercel in one click, up in
--      ten minutes, try it yourself"; the "why" tiles, the MCP walkthrough, the
--      Cortex promo, the product page, the MCP guide and the articles page all
--      carry the same message.
--   2. The word "copilot" is gone. The product has no copilot; it has Cortex AI,
--      which runs inside the editor and as an MCP server. The product title
--      becomes "NextBlock™ Cortex AI MCP Server & AI Editor License".
--   3. The MCP guide's prototype-vs-NextBlock prose cards become a comparison
--      chart, and the rasterised diagram becomes a CSS/HTML flow built from
--      cards inside the rich-text block (crisp at every size, theme-aware, no
--      overflowing titles). Its media row is removed once nothing references it.
--   4. The articles page ('articles' / FR 'articles') gets a short hero: the
--      ~300-word essay 032 put in the hero moves below the posts grid as a
--      "What the journal covers" section with four topic cards, so the page
--      keeps its word count and 100/100 grade without a wall of text up top.
--
-- Every UPDATE is guarded on a phrase unique to the currently applied copy that
-- the replacement does not contain, so re-runs are no-ops and customised pages
-- are left alone. Verified at 100/100 with libs/utils/src/lib/seo for the home
-- page ("AI website builder CMS"), the product ("Cortex AI MCP server"), the
-- guide ("connect Claude to NextBlock CMS") and both articles pages.
--
-- After adding this file: npm run generate:migrations-bundle && npm run
-- generate:sandbox && npm run sync:create-nextblock. The sandbox reset route
-- (enrichCortexAiProducts) mirrors the product sections and title.

DO $body$
DECLARE
  v_en           integer;
  v_fr           integer;
  v_home         integer;
  v_cortex       uuid;
  v_post         integer;
  v_articles_en  integer;
  v_articles_fr  integer;
BEGIN
  SELECT id INTO v_en FROM public.languages WHERE code = 'en' LIMIT 1;
  SELECT id INTO v_fr FROM public.languages WHERE code = 'fr' LIMIT 1;

  ---------------------------------------------------------------------------
  -- 1. Home page (EN)
  ---------------------------------------------------------------------------
  SELECT id INTO v_home FROM public.pages WHERE slug = 'home' AND language_id = v_en ORDER BY id LIMIT 1;

  IF v_home IS NOT NULL THEN
    UPDATE public.blocks SET content = $nbhero3${"is_hero":true,"padding":{"top":"xl","bottom":"xl"},"background":{"type":"gradient","gradient":{"type":"linear","stops":[{"color":"#020817","position":0},{"color":"#0f172a","position":50},{"color":"#1e293b","position":100}],"direction":"135deg"}},"column_gap":"xl","column_blocks":[[{"block_type":"text","content":{"html_content":"<h1 class='text-5xl md:text-6xl font-extrabold tracking-tight text-white text-center leading-tight'>Prompt to <span class='relative inline-block mx-1 group'><span class='absolute inset-0 bg-gradient-to-r from-blue-600 to-cyan-400 translate-y-1 md:translate-y-2 transform -skew-x-12 rounded-sm shadow-lg group-hover:skew-x-0 transition-transform duration-300 ease-out'></span><span class='relative text-white italic px-1'>Production</span></span>.<br class='md:hidden' /> The AI Website Builder CMS.</h1>"}},{"block_type":"text","content":{"html_content":"<p class='text-xl text-slate-300 text-center max-w-3xl mx-auto mt-4 leading-relaxed'>NextBlock is the free, open-source AI website builder CMS for teams that want more than a prototype. Add Cortex AI to point Claude Code, Cursor, or ChatGPT at your site over MCP, free for 30 days. You keep a live Next.js 16 and Supabase website with a visual editor your team owns on day two.</p>"}},{"block_type":"button","content":{"url":"https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fnextblock-cms%2Fnextblock&project-name=nextblock&repository-name=nextblock&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22supabase%22%2C%22productSlug%22%3A%22supabase%22%7D%5D","size":"lg","text":"Deploy to Vercel in One Click","variant":"default","position":"center"}},{"block_type":"button","content":{"url":"https://nextblock.dev/product/nextblock-cortex-ai-cortex-ai-license","size":"lg","text":"Start the Free Cortex AI Trial","variant":"outline","position":"center"}},{"block_type":"text","content":{"html_content":"<div class='flex flex-wrap justify-center gap-6 text-sm uppercase tracking-wide text-slate-400 mt-8'><a href='https://github.com/nextblock-cms' target='_blank' rel='noopener noreferrer' class='hover:text-white transition-colors'>GitHub</a><a href='https://x.com/NextBlockCMS' target='_blank' rel='noopener noreferrer' class='hover:text-white transition-colors'>X</a><a href='https://www.linkedin.com/in/nextblock/' target='_blank' rel='noopener noreferrer' class='hover:text-white transition-colors'>LinkedIn</a><a href='https://dev.to/nextblockcms' target='_blank' rel='noopener noreferrer' class='hover:text-white transition-colors'>Dev.to</a><a href='https://www.npmjs.com/~nextblockcms' target='_blank' rel='noopener noreferrer' class='hover:text-white transition-colors'>npm</a></div>"}}],[{"block_type":"text","content":{"html_content":"<div class='p-10 border border-white/10 rounded-3xl bg-white/5 backdrop-blur-xl shadow-2xl relative overflow-hidden group'><div class='absolute inset-0 bg-gradient-to-br from-blue-500/10 to-purple-500/10 opacity-0 group-hover:opacity-100 transition-opacity duration-500'></div><div class='relative z-10'><p class='text-xs text-white uppercase tracking-widest font-semibold mb-2'>Up in 10 minutes. Free to start.</p><p class='text-3xl font-bold text-white mb-2'>Try the whole stack for free.</p><p class='text-base text-slate-300 mb-6'>The CMS is free forever. Cortex AI, the paid AI layer that includes the MCP server, starts with a 30-day trial and no credit card. One click deploys to Vercel, and you are prompting your own site in ten minutes.</p><ul class='space-y-3 text-sm text-slate-200'><li><span class='text-blue-400 mr-2'>&#10003;</span> CMS: free and open source, with unlimited pages, editors, and sites.</li><li><span class='text-blue-400 mr-2'>&#10003;</span> Cortex AI: 30 days free, no credit card, then one license.</li><li><span class='text-blue-400 mr-2'>&#10003;</span> Bring your own AI subscription. No token markup, ever.</li></ul><div class='mt-6 rounded-2xl overflow-hidden border border-white/10 shadow-lg'><div class='relative w-full aspect-video'><iframe class='absolute inset-0 h-full w-full border-0' src='https://www.youtube-nocookie.com/embed/71MyfoL4YVM?si=jtlDXV6cSC8rDgz0' title='NextBlock demo video' allow='accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share' referrerpolicy='strict-origin-when-cross-origin' loading='lazy' allowfullscreen></iframe></div></div></div></div>"}}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":2},"vertical_alignment":"center"}$nbhero3$::jsonb, updated_at = now()
     WHERE page_id = v_home AND block_type = 'section' AND content::text LIKE '%Free CMS. Paid AI. Your call.%';

    UPDATE public.blocks SET content = $nbwhy3${"padding":{"top":"xl","bottom":"xl"},"background":{"type":"none"},"column_gap":"lg","column_blocks":[[{"block_type":"heading","content":{"level":2,"textAlign":"center","text_content":"Why an AI Website Builder CMS Beats Prototype Code."}},{"block_type":"text","content":{"html_content":"<p class='text-lg text-muted-foreground text-center max-w-3xl mx-auto mb-10'>Prompt builders like Lovable, Bolt, and v0 are great at a first draft. Then they hand you code you must host, patch, and rebuild for every copy change. NextBlock takes the same prompts and turns them into a website your whole team can run.</p>"}},{"block_type":"text","content":{"html_content":"<div class='grid gap-6 md:grid-cols-3'><div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-blue-300 dark:border-slate-800 dark:bg-slate-900'><div class='mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-xl dark:bg-blue-950'>🧩</div><h3 class='text-lg font-bold text-foreground mb-2'>Prompt to CMS, Not Just Code.</h3><p class='text-sm text-muted-foreground leading-relaxed'>External AI agents scaffold real layouts as typed blocks. Editors then tweak copy, images, and sections in a Notion-style editor. Nobody writes a prompt or touches code to change a headline.</p></div><div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-blue-300 dark:border-slate-800 dark:bg-slate-900'><div class='mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-xl dark:bg-blue-950'>🔌</div><h3 class='text-lg font-bold text-foreground mb-2'>Bring Your Own AI Subscription via MCP.</h3><p class='text-sm text-muted-foreground leading-relaxed'>Connect Claude Code, Cursor, ChatGPT, or Gemini straight to /api/mcp. You pay for the AI plan you already have, not a SaaS token markup. This is the Cortex AI layer: free for 30 days, no credit card.</p></div><div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-blue-300 dark:border-slate-800 dark:bg-slate-900'><div class='mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-xl dark:bg-blue-950'>⚡</div><h3 class='text-lg font-bold text-foreground mb-2'>Zero-Redeploy JSONB Architecture.</h3><p class='text-sm text-muted-foreground leading-relaxed'>Generated blocks land in PostgreSQL as validated JSONB. Pages publish in seconds with 100/100 Lighthouse defaults and no rebuild.</p></div></div>"}},{"block_type":"text","content":{"html_content":"<div class='mt-12 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900'><div class='flex flex-wrap items-end justify-between gap-3 px-5 pt-6 pb-4'><div><p class='text-xs font-semibold uppercase tracking-[0.22em] text-slate-500 dark:text-slate-400'>Side by side</p><p class='mt-1 text-xl font-semibold text-foreground'>Prototype tools versus NextBlock.</p></div><p class='text-xs text-slate-500 dark:text-slate-400'>Lovable, Bolt, and v0 compared on what happens after the first prompt.</p></div><div class='overflow-x-auto'><table class='w-full min-w-[640px] border-collapse'><thead><tr class='bg-slate-50 dark:bg-slate-950/60'><th scope='col' class='px-5 py-3 text-left text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400'>What you get</th><th scope='col' class='px-5 py-3 text-left text-xs font-semibold uppercase tracking-[0.2em] text-rose-600 dark:text-rose-300'>Lovable, Bolt, v0</th><th scope='col' class='bg-emerald-50/60 px-5 py-3 text-left text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-200'>NextBlock</th></tr></thead><tbody><tr class='border-t border-slate-200 dark:border-slate-800'><th scope='row' class='px-5 py-4 text-left align-top text-sm font-semibold text-foreground'>Day one</th><td class='px-5 py-4 align-top text-sm text-muted-foreground'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-rose-100 text-xs font-bold text-rose-600 dark:bg-rose-500/20 dark:text-rose-300'>&#10007;</span>Prototype code you host and patch yourself.</td><td class='bg-emerald-50/60 px-5 py-4 align-top text-sm text-foreground dark:bg-emerald-500/10'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200'>&#10003;</span>A live Next.js 16 and Supabase website.</td></tr><tr class='border-t border-slate-200 dark:border-slate-800'><th scope='row' class='px-5 py-4 text-left align-top text-sm font-semibold text-foreground'>Editing after launch</th><td class='px-5 py-4 align-top text-sm text-muted-foreground'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-rose-100 text-xs font-bold text-rose-600 dark:bg-rose-500/20 dark:text-rose-300'>&#10007;</span>A new prompt or a pull request for every change.</td><td class='bg-emerald-50/60 px-5 py-4 align-top text-sm text-foreground dark:bg-emerald-500/10'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200'>&#10003;</span>A Notion-style visual editor, no code needed.</td></tr><tr class='border-t border-slate-200 dark:border-slate-800'><th scope='row' class='px-5 py-4 text-left align-top text-sm font-semibold text-foreground'>Drafts and revisions</th><td class='px-5 py-4 align-top text-sm text-muted-foreground'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-rose-100 text-xs font-bold text-rose-600 dark:bg-rose-500/20 dark:text-rose-300'>&#10007;</span>Code history only, nothing for content.</td><td class='bg-emerald-50/60 px-5 py-4 align-top text-sm text-foreground dark:bg-emerald-500/10'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200'>&#10003;</span>Live Drafts and one-click restore of any page.</td></tr><tr class='border-t border-slate-200 dark:border-slate-800'><th scope='row' class='px-5 py-4 text-left align-top text-sm font-semibold text-foreground'>Publishing</th><td class='px-5 py-4 align-top text-sm text-muted-foreground'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-rose-100 text-xs font-bold text-rose-600 dark:bg-rose-500/20 dark:text-rose-300'>&#10007;</span>Rebuild and redeploy.</td><td class='bg-emerald-50/60 px-5 py-4 align-top text-sm text-foreground dark:bg-emerald-500/10'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200'>&#10003;</span>Instant, straight from PostgreSQL.</td></tr><tr class='border-t border-slate-200 dark:border-slate-800'><th scope='row' class='px-5 py-4 text-left align-top text-sm font-semibold text-foreground'>Translations and SEO</th><td class='px-5 py-4 align-top text-sm text-muted-foreground'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-rose-100 text-xs font-bold text-rose-600 dark:bg-rose-500/20 dark:text-rose-300'>&#10007;</span>Not built in.</td><td class='bg-emerald-50/60 px-5 py-4 align-top text-sm text-foreground dark:bg-emerald-500/10'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200'>&#10003;</span>Per-block translation and SEO graded as you type.</td></tr><tr class='border-t border-slate-200 dark:border-slate-800'><th scope='row' class='px-5 py-4 text-left align-top text-sm font-semibold text-foreground'>AI costs</th><td class='px-5 py-4 align-top text-sm text-muted-foreground'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-rose-100 text-xs font-bold text-rose-600 dark:bg-rose-500/20 dark:text-rose-300'>&#10007;</span>Platform credits, bought from the tool.</td><td class='bg-emerald-50/60 px-5 py-4 align-top text-sm text-foreground dark:bg-emerald-500/10'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200'>&#10003;</span>Your own subscription over MCP, no markup.</td></tr><tr class='border-t border-slate-200 dark:border-slate-800'><th scope='row' class='px-5 py-4 text-left align-top text-sm font-semibold text-foreground'>Price of the platform</th><td class='px-5 py-4 align-top text-sm text-muted-foreground'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-rose-100 text-xs font-bold text-rose-600 dark:bg-rose-500/20 dark:text-rose-300'>&#10007;</span>A monthly plan.</td><td class='bg-emerald-50/60 px-5 py-4 align-top text-sm text-foreground dark:bg-emerald-500/10'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200'>&#10003;</span>Free and open source, forever. Cortex AI is the only paid add-on.</td></tr></tbody></table></div></div>"}},{"block_type":"text","content":{"html_content":"<div class='mt-10 grid gap-4 md:grid-cols-3'><div class='rounded-3xl border border-emerald-200/70 bg-emerald-50/70 p-6 dark:border-emerald-500/20 dark:bg-emerald-500/10'><p class='text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200'>Free forever</p><p class='mt-3 text-xl font-semibold text-foreground'>The CMS costs nothing.</p><p class='mt-3 text-sm text-muted-foreground'>The AI website builder CMS is free and open source. Unlimited pages, editors, and sites, self-hosted or on Vercel, with no plan to outgrow.</p></div><div class='rounded-3xl border border-violet-200/70 bg-violet-50/70 p-6 dark:border-violet-500/20 dark:bg-violet-500/10'><p class='text-xs font-semibold uppercase tracking-[0.22em] text-violet-700 dark:text-violet-200'>Cortex AI: 30-day free trial</p><p class='mt-3 text-xl font-semibold text-foreground'>Try the AI layer, then decide.</p><p class='mt-3 text-sm text-muted-foreground'>Cortex AI is the one paid license. It starts with a 30-day trial and no credit card, and it unlocks AI inside the editor plus the MCP server. Cancel by doing nothing.</p></div><div class='rounded-3xl border border-sky-200/70 bg-sky-50/70 p-6 dark:border-sky-500/20 dark:bg-sky-500/10'><p class='text-xs font-semibold uppercase tracking-[0.22em] text-sky-700 dark:text-sky-200'>No token markup</p><p class='mt-3 text-xl font-semibold text-foreground'>Your plan does the work.</p><p class='mt-3 text-sm text-muted-foreground'>Cortex AI runs on the Claude, ChatGPT, Cursor, or Gemini subscription you already pay for. The license buys the connection, not the tokens.</p></div></div>"}}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":1}}$nbwhy3$::jsonb, updated_at = now()
     WHERE page_id = v_home AND block_type = 'section' AND content::text LIKE '%Cortex AI, when you want it%';

    UPDATE public.blocks SET content = $nbmcp2${"padding":{"top":"xl","bottom":"xl"},"background":{"type":"gradient","gradient":{"type":"linear","stops":[{"color":"#0f172a","position":0},{"color":"#1e293b","position":100}],"direction":"135deg"}},"column_gap":"lg","column_blocks":[[{"block_type":"text","content":{"html_content":"<p class='text-xs uppercase tracking-[0.3em] text-cyan-300 font-semibold text-center mb-3'>Model Context Protocol</p><h2 class='text-3xl md:text-4xl font-extrabold text-white text-center mb-4'>How the MCP Connection Works.</h2><p class='text-lg text-slate-300 text-center max-w-3xl mx-auto mb-4'>Cortex AI exposes your CMS as an MCP server at /api/mcp. Any agent that speaks the standard can read your schema and write pages. The server is part of the Cortex AI license, and the 30-day trial needs no credit card.</p><p class='text-base text-slate-400 text-center max-w-2xl mx-auto mb-10'>Three steps take you from a fresh deploy to published pages, in about ten minutes.</p><div class='grid gap-6 md:grid-cols-3'><div class='rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur'><p class='text-xs uppercase tracking-[0.25em] text-cyan-300 font-semibold mb-3'>Step 1</p><h3 class='text-lg font-bold text-white mb-2'>Deploy and start the trial.</h3><p class='text-sm text-slate-300 leading-relaxed'>One click to Vercel, then start the free Cortex AI trial in CMS Settings. Mint a scoped token and paste one JSON block into Claude Code, Cursor, or VS Code.</p></div><div class='rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur'><p class='text-xs uppercase tracking-[0.25em] text-cyan-300 font-semibold mb-3'>Step 2</p><h3 class='text-lg font-bold text-white mb-2'>Prompt the layout.</h3><p class='text-sm text-slate-300 leading-relaxed'>Ask for a landing page. The agent calls generate_jsonb_layout and the result lands as a Live Draft made of validated blocks.</p></div><div class='rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur'><p class='text-xs uppercase tracking-[0.25em] text-cyan-300 font-semibold mb-3'>Step 3</p><h3 class='text-lg font-bold text-white mb-2'>Edit and publish.</h3><p class='text-sm text-slate-300 leading-relaxed'>Editors refine the draft in the visual editor and hit publish. The page goes live from PostgreSQL with no redeploy.</p></div></div>"}},{"block_type":"text","content":{"html_content":"<div class='mt-12 grid gap-8 md:grid-cols-2'><div class='rounded-2xl border border-white/10 bg-slate-950/60 p-6'><h3 class='text-base font-bold text-white mb-4'>For Writers and Editors</h3><ul class='space-y-3 text-sm text-slate-300'><li><strong class='text-white'>Notion-style editor.</strong> Slash commands, drag and drop, and inline AI on every block.</li><li><strong class='text-white'>Live Drafts.</strong> Stage AI output safely, then publish when it reads right.</li><li><strong class='text-white'>Revisions.</strong> Restore any version of a page or post with one click.</li><li><strong class='text-white'>Built-in SEO checks.</strong> Headings, keyphrases, readability, and metadata graded as you type.</li></ul></div><div class='rounded-2xl border border-white/10 bg-slate-950/60 p-6'><h3 class='text-base font-bold text-white mb-4'>For Developers</h3><ul class='space-y-3 text-sm text-slate-300'><li><strong class='text-white'>Next.js 16 core.</strong> Server Components, ISR, and edge caching out of the box.</li><li><strong class='text-white'>Supabase backend.</strong> Postgres, auth, storage, and row-level security you can read.</li><li><strong class='text-white'>Typed block registry.</strong> Every block has a Zod schema, so AI output is validated before it renders.</li><li><strong class='text-white'>Open source.</strong> Self-host on Docker or deploy to Vercel in one click.</li></ul></div></div><p class='mt-10 text-center text-xs uppercase tracking-[0.25em] text-slate-400'>Built with Next.js, React, Supabase, Stripe, Tailwind, Tiptap, Vercel, and Nx.</p>"}}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":1}}$nbmcp2$::jsonb, updated_at = now()
     WHERE page_id = v_home AND block_type = 'section' AND content::text LIKE '%Three steps take you from a blank site%';

    UPDATE public.blocks SET content = $nbcortexpromo3${"padding":{"top":"xl","bottom":"xl"},"background":{"type":"gradient","gradient":{"type":"linear","stops":[{"color":"#1e1b4b","position":0},{"color":"#0f172a","position":100}],"direction":"135deg"}},"column_gap":"xl","column_blocks":[[{"block_type":"text","content":{"html_content":"<p class='text-xs uppercase tracking-[0.3em] text-violet-400 font-semibold mb-4'>Now Available — Cortex AI</p><h2 class='text-4xl md:text-5xl font-bold text-white mb-6 leading-tight'>The CMS Is Free.<br/>Cortex AI Is the Upgrade.</h2><p class='text-lg text-slate-300 max-w-2xl leading-relaxed mb-4'>NextBlock costs nothing and never will. Cortex AI is the one license we sell. It adds AI inside the editor and an MCP server outside it, so Claude Code, Cursor, ChatGPT, and Gemini can build your site.</p><p class='text-base text-slate-400 max-w-2xl leading-relaxed'>Try it free for 30 days with no credit card. You bring the AI subscription you already pay for. The license buys the connection, never the tokens, and nothing goes live until an editor publishes it.</p>"}},{"block_type":"button","content":{"url":"https://nextblock.dev/product/nextblock-cortex-ai-cortex-ai-license","size":"lg","text":"Start the 30-Day Free Trial →","variant":"default","position":"left"}},{"block_type":"button","content":{"url":"/article/cortex-ai-mcp-connection-guide","size":"lg","text":"Read the MCP Setup Guide","variant":"outline","position":"left"}}],[{"block_type":"text","content":{"html_content":"<div class='grid grid-cols-1 gap-4 sm:grid-cols-3 lg:grid-cols-1'><div class='rounded-2xl border border-violet-500/30 bg-white/5 p-6 text-center'><p class='text-3xl font-extrabold text-white'>$0</p><p class='text-xs uppercase tracking-wider text-violet-200 mt-1'>The CMS, forever</p></div><div class='rounded-2xl border border-violet-500/30 bg-white/5 p-6 text-center'><p class='text-3xl font-extrabold text-white'>30</p><p class='text-xs uppercase tracking-wider text-violet-200 mt-1'>Days of Cortex AI free, no card</p></div><div class='rounded-2xl border border-violet-500/30 bg-white/5 p-6 text-center'><p class='text-3xl font-extrabold text-white'>0 %</p><p class='text-xs uppercase tracking-wider text-violet-200 mt-1'>Token markup</p></div></div>"}}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":2},"vertical_alignment":"center"}$nbcortexpromo3$::jsonb, updated_at = now()
     WHERE page_id = v_home AND block_type = 'section' AND content::text LIKE '%The AI Is the Upgrade%';
  END IF;

  ---------------------------------------------------------------------------
  -- 2. Cortex AI product (EN)
  ---------------------------------------------------------------------------
  SELECT id INTO v_cortex FROM public.products WHERE slug = 'nextblock-cortex-ai-cortex-ai-license' AND language_id = v_en LIMIT 1;

  IF v_cortex IS NOT NULL THEN
    UPDATE public.products SET title = 'NextBlock™ Cortex AI MCP Server & AI Editor License', updated_at = now()
     WHERE id = v_cortex AND title IN ('NextBlock™ Cortex AI MCP Server & Copilot License', 'NextBlock™ Cortex AI MCP Server & AI Editor License');

    UPDATE public.products SET short_description = 'NextBlock™ Cortex AI is the AI layer for your free CMS. Route any model through your own OpenRouter key inside the editor, or register /api/mcp and let Claude Code, Cursor, and ChatGPT build layouts, inspect your schema, and manage content on the AI subscription you already pay for. Free for 30 days, no credit card.', updated_at = now()
     WHERE id = v_cortex
       AND (short_description IS NULL OR short_description = ''
            OR short_description = 'NextBlock™ Cortex AI is the AI layer for your CMS. Route any model through your own OpenRouter key in the dashboard, or register /api/mcp and let Claude Code, Cursor, and ChatGPT build layouts, inspect your schema, and manage content on the AI subscription you already pay for.'
            OR short_description = 'NextBlock™ Cortex AI is the AI layer for your free CMS. Route any model through your own OpenRouter key inside the editor, or register /api/mcp and let Claude Code, Cursor, and ChatGPT build layouts, inspect your schema, and manage content on the AI subscription you already pay for. Free for 30 days, no credit card.');

    IF EXISTS (SELECT 1 FROM public.blocks WHERE product_id = v_cortex AND content::text LIKE '%Editor Copilot%') THEN
      DELETE FROM public.blocks WHERE product_id = v_cortex;
      INSERT INTO public.blocks (product_id, language_id, block_type, content, "order") VALUES
        (v_cortex, v_en, 'section', $nbcx0v2${"container_type":"container","background":{"type":"gradient","gradient":{"type":"linear","direction":"135deg","stops":[{"color":"#1e1b4b","position":0},{"color":"#312e81","position":35},{"color":"#0f172a","position":100}]}},"responsive_columns":{"mobile":1,"tablet":1,"desktop":2},"column_gap":"xl","vertical_alignment":"center","padding":{"top":"xl","bottom":"xl"},"column_blocks":[[{"block_type":"text","content":{"html_content":"<p class='text-xs uppercase tracking-[0.3em] text-violet-400 font-semibold mb-4'>MCP-Native AI Layer · 30-Day Free Trial</p><h2 class='text-3xl md:text-5xl font-extrabold text-white leading-tight mb-5'>Your CMS as a Cortex AI MCP Server.</h2><p class='text-base md:text-lg text-slate-200 leading-relaxed mb-4'>Cortex AI runs two ways. Inside the editor it routes to any model through your own OpenRouter key. Over MCP it turns NextBlock into a server that Claude Code, Cursor, and ChatGPT operate from their own chat window.</p><p class='text-base text-slate-300 leading-relaxed mb-6'>The CMS is free forever. Cortex AI is the one license we sell, and it starts with 30 days free and no credit card.</p>"}},{"block_type":"button","content":{"text":"Read the MCP Setup Guide →","url":"/article/cortex-ai-mcp-connection-guide","variant":"default","size":"lg","position":"left"}}],[{"block_type":"text","content":{"html_content":"<div class='rounded-2xl border border-violet-700 bg-slate-950 p-6 shadow-xl sm:p-8'><h3 class='text-lg font-bold text-white mb-5'>Bring Your Own AI Subscription</h3><ul class='space-y-4 text-sm leading-relaxed text-slate-300'><li class='flex items-start gap-3'><span class='flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold'>✓</span><span><strong class='text-white'>Free for 30 days</strong> — start the trial with no credit card. If you do nothing, it simply ends.</span></li><li class='flex items-start gap-3'><span class='flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold'>✓</span><span><strong class='text-white'>No token markup</strong> — use Claude Pro, ChatGPT Plus, Cursor, or Gemini Advanced by registering /api/mcp. You pay your provider, not us.</span></li><li class='flex items-start gap-3'><span class='flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold'>✓</span><span><strong class='text-white'>Editor BYOK</strong> — OpenRouter routing with your own key, so you pick the model and keep the bill.</span></li><li class='flex items-start gap-3'><span class='flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold'>✓</span><span><strong class='text-white'>Scoped tokens</strong> — mint read-only or write tokens in CMS Settings and revoke them any time.</span></li><li class='flex items-start gap-3'><span class='flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold'>✓</span><span><strong class='text-white'>Live Drafts</strong> — generated layouts stage as drafts. Nothing goes live until an editor publishes it.</span></li></ul></div>"}}]]}$nbcx0v2$::jsonb, 0),
        (v_cortex, v_en, 'section', $nbcx1v2${"container_type":"container","background":{"type":"theme","theme":"muted"},"responsive_columns":{"mobile":1,"tablet":2,"desktop":4},"column_gap":"lg","padding":{"top":"lg","bottom":"lg"},"vertical_alignment":"center","column_blocks":[[{"block_type":"text","content":{"html_content":"<p class='text-center'><span class='block text-2xl font-extrabold text-foreground'>30</span><span class='text-xs text-muted-foreground uppercase tracking-wider'>Days free, no card</span></p>"}}],[{"block_type":"text","content":{"html_content":"<p class='text-center'><span class='block text-2xl font-extrabold text-foreground'>0 %</span><span class='text-xs text-muted-foreground uppercase tracking-wider'>Token markup</span></p>"}}],[{"block_type":"text","content":{"html_content":"<p class='text-center'><span class='block text-2xl font-extrabold text-foreground'>5</span><span class='text-xs text-muted-foreground uppercase tracking-wider'>MCP contract tools</span></p>"}}],[{"block_type":"text","content":{"html_content":"<p class='text-center'><span class='block text-2xl font-extrabold text-foreground'>29</span><span class='text-xs text-muted-foreground uppercase tracking-wider'>Typed agent tools</span></p>"}}]]}$nbcx1v2$::jsonb, 1),
        (v_cortex, v_en, 'section', $nbcx2v2${"container_type":"container","background":{"type":"none"},"responsive_columns":{"mobile":1,"tablet":2,"desktop":3},"column_gap":"lg","padding":{"top":"xl","bottom":"xl"},"vertical_alignment":"stretch","column_blocks":[[{"block_type":"text","content":{"html_content":"<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7'><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'><code class='rounded bg-violet-50 px-2 py-1 text-sm text-violet-700 dark:bg-violet-950 dark:text-violet-200'>get_database_schema</code></h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Returns every table the agent may read or change, with columns, keys, and read-only flags. The model plans against real structure, not guesses.</p></div>"}},{"block_type":"text","content":{"html_content":"<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7'><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'><code class='rounded bg-violet-50 px-2 py-1 text-sm text-violet-700 dark:bg-violet-950 dark:text-violet-200'>query_site_analytics</code></h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Reads revenue, order counts, status breakdowns, and top products over a date range. Read-only, so it is safe on any token.</p></div>"}}],[{"block_type":"text","content":{"html_content":"<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7'><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'><code class='rounded bg-violet-50 px-2 py-1 text-sm text-violet-700 dark:bg-violet-950 dark:text-violet-200'>generate_jsonb_layout</code></h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Turns a prompt into a complete page layout. Blocks are validated against the NextBlock schema and staged as a Live Draft.</p></div>"}},{"block_type":"text","content":{"html_content":"<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7'><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'><code class='rounded bg-violet-50 px-2 py-1 text-sm text-violet-700 dark:bg-violet-950 dark:text-violet-200'>search_stock_media</code></h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Finds free stock photos on Pexels and Unsplash with alt text and credits. Drop a result straight into an image block.</p></div>"}}],[{"block_type":"text","content":{"html_content":"<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7'><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'><code class='rounded bg-violet-50 px-2 py-1 text-sm text-violet-700 dark:bg-violet-950 dark:text-violet-200'>update_site_navigation</code></h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Adds, renames, or reorders header menu items per locale. Append to keep the current menu or replace it in one call.</p></div>"}},{"block_type":"text","content":{"html_content":"<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7'><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'><code class='rounded bg-violet-50 px-2 py-1 text-sm text-violet-700 dark:bg-violet-950 dark:text-violet-200'>and 24 more</code></h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Create posts and products, translate pages, upload media, manage themes and scripts. Every tool is typed and scoped.</p></div>"}}]]}$nbcx2v2$::jsonb, 2),
        (v_cortex, v_en, 'section', $nbcx3v2${"container_type":"container","background":{"type":"gradient","gradient":{"type":"linear","direction":"180deg","stops":[{"color":"#020617","position":0},{"color":"#0f172a","position":100}]}},"responsive_columns":{"mobile":1,"tablet":1,"desktop":2},"column_gap":"xl","vertical_alignment":"center","padding":{"top":"xl","bottom":"xl"},"column_blocks":[[{"block_type":"text","content":{"html_content":"<p class='text-xs uppercase tracking-[0.3em] text-violet-400 font-semibold mb-4'>How It Works</p><h3 class='text-2xl md:text-3xl font-extrabold text-white mb-4'>One Registry, Standard Transport.</h3><p class='text-slate-300 leading-relaxed mb-5'>The MCP server speaks Streamable HTTP at /api/mcp. Your client posts JSON-RPC messages and gets typed results back. There is no SDK to install and no proxy in the middle.</p><ul class='space-y-3 text-sm text-slate-400'><li class='flex items-start gap-2.5'><span class='text-violet-400'>→</span><span>Bearer tokens are stored as SHA-256 hashes and shown once.</span></li><li class='flex items-start gap-2.5'><span class='text-violet-400'>→</span><span>Localhost trust lets a dev server skip the token while you build.</span></li><li class='flex items-start gap-2.5'><span class='text-violet-400'>→</span><span>Read-only tokens never see a mutating tool in the list.</span></li><li class='flex items-start gap-2.5'><span class='text-violet-400'>→</span><span>Copy-paste config for Claude Code, Cursor, VS Code, and Claude Desktop.</span></li></ul>"}}],[{"block_type":"text","content":{"html_content":"<div class='space-y-4'><div class='p-5 rounded-xl border border-slate-700 bg-slate-900'><h4 class='text-sm font-bold text-white mb-1'>Editor BYOK via OpenRouter</h4><p class='text-xs text-slate-400 leading-relaxed'>Pick any model, from Claude to Gemini to open weights, with one key. Costs stay on your OpenRouter bill and switch with a toggle.</p></div><div class='p-5 rounded-xl border border-slate-700 bg-slate-900'><h4 class='text-sm font-bold text-white mb-1'>AI Inside the Editor</h4><p class='text-xs text-slate-400 leading-relaxed'>An inline toolbar rewrites copy, refactors columns, and translates whole pages. Output is valid block data, so layouts never break.</p></div><div class='p-5 rounded-xl border border-slate-700 bg-slate-900'><h4 class='text-sm font-bold text-white mb-1'>Privacy-First Design</h4><p class='text-xs text-slate-400 leading-relaxed'>Requests go straight to your provider with your key. NextBlock never stores, logs, or trains on your content.</p></div></div>"}}]]}$nbcx3v2$::jsonb, 3),
        (v_cortex, v_en, 'section', $nbcx4v2${"container_type":"container","background":{"type":"gradient","gradient":{"type":"linear","direction":"135deg","stops":[{"color":"#312e81","position":0},{"color":"#1e1b4b","position":100}]}},"responsive_columns":{"mobile":1,"tablet":1,"desktop":1},"column_gap":"none","padding":{"top":"xl","bottom":"xl"},"vertical_alignment":"center","column_blocks":[[{"block_type":"heading","content":{"level":2,"text_content":"Ready to connect your AI to your CMS?","textAlign":"center","textColor":"background"}},{"block_type":"text","content":{"html_content":"<p class='text-center text-violet-100 max-w-xl mx-auto mt-2 mb-6'>One license unlocks Cortex AI in the editor and the MCP server. Start with 30 days free and no credit card, bring your own AI subscription, and keep your data yours.</p>"}},{"block_type":"button","content":{"text":"Start the 30-Day Free Trial","url":"https://nextblock.dev/product/nextblock-cortex-ai-cortex-ai-license","variant":"secondary","size":"lg","position":"center"}}]]}$nbcx4v2$::jsonb, 4);
    END IF;
  END IF;

  ---------------------------------------------------------------------------
  -- 3. MCP guide body (EN) + retire the rasterised diagram's media row
  ---------------------------------------------------------------------------
  SELECT id INTO v_post FROM public.posts WHERE slug = 'cortex-ai-mcp-connection-guide' AND language_id = v_en ORDER BY id LIMIT 1;

  IF v_post IS NOT NULL THEN
    UPDATE public.blocks SET content = $nbmcpguide3${"html_content":"<p class='text-lg leading-8 text-slate-700 dark:text-slate-300'>This guide shows you how to connect Claude to NextBlock CMS with an open standard instead of a vendor plugin. Cortex AI turns your site into a Model Context Protocol server. Claude Code, Cursor, ChatGPT, and Gemini can then read your database schema, draft page layouts, and update navigation from their own chat window. You pay for the AI subscription you already have, with no token markup in between.</p><div class='grid gap-4 md:grid-cols-3 my-10'><div class='rounded-3xl border border-sky-200/70 bg-sky-50/70 p-6 dark:border-sky-500/20 dark:bg-sky-500/10'><p class='mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-sky-700 dark:text-sky-200'>One config block</p><p class='mt-3 mb-0 text-xl font-semibold text-slate-900 dark:text-white'>Setup in minutes.</p><p class='mt-3 mb-0 text-sm text-slate-600 dark:text-slate-300'>Paste one JSON entry into Claude Code, Cursor, or VS Code. The CMS settings card writes it for you.</p></div><div class='rounded-3xl border border-indigo-200/70 bg-indigo-50/70 p-6 dark:border-indigo-500/20 dark:bg-indigo-500/10'><p class='mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-indigo-700 dark:text-indigo-200'>Free to try</p><p class='mt-3 mb-0 text-xl font-semibold text-slate-900 dark:text-white'>30 days, no credit card.</p><p class='mt-3 mb-0 text-sm text-slate-600 dark:text-slate-300'>The CMS is free forever. Cortex AI, which includes the MCP server, starts with a 30-day free trial.</p></div><div class='rounded-3xl border border-emerald-200/70 bg-emerald-50/70 p-6 dark:border-emerald-500/20 dark:bg-emerald-500/10'><p class='mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200'>Live Drafts</p><p class='mt-3 mb-0 text-xl font-semibold text-slate-900 dark:text-white'>Nothing ships by accident.</p><p class='mt-3 mb-0 text-sm text-slate-600 dark:text-slate-300'>Every layout the agent writes lands as a draft. An editor reviews it and hits publish.</p></div></div><p>Every prompt becomes a structured database record rather than a pile of generated code. Your editors keep a visual CMS, your developers keep a clean Next.js 16 app, and nothing goes live until someone hits publish.</p><h2>The Problem with Traditional AI Web Builders</h2><p>Prompt builders such as Lovable, Bolt, and v0 are impressive on day one. You describe a page and get a working React app in minutes. The trouble starts on day two.</p><div class='not-prose my-8 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900'><div class='flex flex-wrap items-end justify-between gap-3 px-5 pt-6 pb-4'><div><p class='text-xs font-semibold uppercase tracking-[0.22em] text-slate-500 dark:text-slate-400'>Side by side</p><p class='mt-1 text-xl font-semibold text-slate-900 dark:text-white'>Prototype tools versus NextBlock.</p></div><p class='text-xs text-slate-500 dark:text-slate-400'>What happens after the first prompt.</p></div><div class='overflow-x-auto'><table class='w-full min-w-[640px] border-collapse'><thead><tr class='bg-slate-50 dark:bg-slate-950/60'><th scope='col' class='px-5 py-3 text-left text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400'>What you get</th><th scope='col' class='px-5 py-3 text-left text-xs font-semibold uppercase tracking-[0.2em] text-rose-600 dark:text-rose-300'>Lovable, Bolt, v0</th><th scope='col' class='bg-emerald-50/60 px-5 py-3 text-left text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-200'>NextBlock</th></tr></thead><tbody><tr class='border-t border-slate-200 dark:border-slate-800'><th scope='row' class='px-5 py-4 text-left align-top text-sm font-semibold text-foreground'>Day one</th><td class='px-5 py-4 align-top text-sm text-muted-foreground'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-rose-100 text-xs font-bold text-rose-600 dark:bg-rose-500/20 dark:text-rose-300'>&#10007;</span>Disposable code with no content layer.</td><td class='bg-emerald-50/60 px-5 py-4 align-top text-sm text-foreground dark:bg-emerald-500/10'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200'>&#10003;</span>A live Next.js 16 and Supabase website with a CMS.</td></tr><tr class='border-t border-slate-200 dark:border-slate-800'><th scope='row' class='px-5 py-4 text-left align-top text-sm font-semibold text-foreground'>Changing a headline</th><td class='px-5 py-4 align-top text-sm text-muted-foreground'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-rose-100 text-xs font-bold text-rose-600 dark:bg-rose-500/20 dark:text-rose-300'>&#10007;</span>Another prompt or another pull request.</td><td class='bg-emerald-50/60 px-5 py-4 align-top text-sm text-foreground dark:bg-emerald-500/10'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200'>&#10003;</span>An editor types it in a Notion-style editor.</td></tr><tr class='border-t border-slate-200 dark:border-slate-800'><th scope='row' class='px-5 py-4 text-left align-top text-sm font-semibold text-foreground'>Drafts and revisions</th><td class='px-5 py-4 align-top text-sm text-muted-foreground'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-rose-100 text-xs font-bold text-rose-600 dark:bg-rose-500/20 dark:text-rose-300'>&#10007;</span>Code history only.</td><td class='bg-emerald-50/60 px-5 py-4 align-top text-sm text-foreground dark:bg-emerald-500/10'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200'>&#10003;</span>Live Drafts, revisions, and one-click restore.</td></tr><tr class='border-t border-slate-200 dark:border-slate-800'><th scope='row' class='px-5 py-4 text-left align-top text-sm font-semibold text-foreground'>Translations and SEO</th><td class='px-5 py-4 align-top text-sm text-muted-foreground'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-rose-100 text-xs font-bold text-rose-600 dark:bg-rose-500/20 dark:text-rose-300'>&#10007;</span>Not built in.</td><td class='bg-emerald-50/60 px-5 py-4 align-top text-sm text-foreground dark:bg-emerald-500/10'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200'>&#10003;</span>Per-block translation and SEO checks as you type.</td></tr><tr class='border-t border-slate-200 dark:border-slate-800'><th scope='row' class='px-5 py-4 text-left align-top text-sm font-semibold text-foreground'>AI costs</th><td class='px-5 py-4 align-top text-sm text-muted-foreground'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-rose-100 text-xs font-bold text-rose-600 dark:bg-rose-500/20 dark:text-rose-300'>&#10007;</span>Platform credits, bought from the tool.</td><td class='bg-emerald-50/60 px-5 py-4 align-top text-sm text-foreground dark:bg-emerald-500/10'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200'>&#10003;</span>Your own subscription over MCP, no markup.</td></tr><tr class='border-t border-slate-200 dark:border-slate-800'><th scope='row' class='px-5 py-4 text-left align-top text-sm font-semibold text-foreground'>Price</th><td class='px-5 py-4 align-top text-sm text-muted-foreground'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-rose-100 text-xs font-bold text-rose-600 dark:bg-rose-500/20 dark:text-rose-300'>&#10007;</span>A monthly plan.</td><td class='bg-emerald-50/60 px-5 py-4 align-top text-sm text-foreground dark:bg-emerald-500/10'><span class='mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200'>&#10003;</span>Free CMS. Cortex AI after a 30-day free trial.</td></tr></tbody></table></div></div><p>NextBlock takes the opposite view from the prototype tools. AI should draft the site, and people should own it. The MCP connection is how those two worlds meet.</p><h2>How Cortex AI Uses Model Context Protocol (MCP)</h2><p>Model Context Protocol is an open standard for giving AI agents tools. A client such as Claude Code lists the tools a server offers, calls them with typed arguments, and reads typed results back. Cortex AI ships that server inside your NextBlock install at <code>/api/mcp</code>.</p><div class='not-prose my-12 overflow-hidden rounded-[2rem] border border-slate-800 bg-slate-950 p-6 shadow-2xl sm:p-8'><p class='text-[0.65rem] font-semibold uppercase tracking-[0.3em] text-indigo-300'>Model Context Protocol · NextBlock Cortex AI</p><p class='mt-2 text-2xl font-extrabold text-white sm:text-3xl'>From prompt to production, without a redeploy.</p><p class='mt-2 max-w-2xl text-sm text-slate-400'>Your AI client talks to the CMS over an open standard. Output lands as data, not as code you have to host.</p><div class='mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4'><div class='relative flex flex-col rounded-2xl border border-sky-400/40 bg-white/5 p-5'><span class='block h-1 w-12 rounded-full bg-sky-400'></span><p class='mt-4 text-[0.65rem] font-semibold uppercase tracking-[0.25em] text-sky-300'>Step 1 · Your AI client</p><p class='mt-2 text-lg font-bold leading-snug text-white'>Prompt</p><p class='mt-1 text-xs text-slate-400'>Any MCP client you already pay for.</p><div class='mt-4 flex-1 text-sm text-slate-200'><div class='flex flex-wrap gap-2'><span class='rounded-full border border-sky-400/40 bg-sky-400/10 px-3 py-1 text-xs font-semibold text-slate-100'>Claude Code</span><span class='rounded-full border border-sky-400/40 bg-sky-400/10 px-3 py-1 text-xs font-semibold text-slate-100'>Cursor</span><span class='rounded-full border border-sky-400/40 bg-sky-400/10 px-3 py-1 text-xs font-semibold text-slate-100'>ChatGPT</span><span class='rounded-full border border-sky-400/40 bg-sky-400/10 px-3 py-1 text-xs font-semibold text-slate-100'>Gemini</span></div><p class='mt-4 text-xs text-slate-300'>One JSON block in your client config registers the server. That is the setup.</p></div><p class='mt-5 rounded-lg bg-sky-400/10 px-3 py-2 text-center text-[0.7rem] font-semibold text-sky-300'>Your subscription · no token markup</p><span class='absolute -right-4 top-1/2 hidden -translate-y-1/2 text-xl text-slate-500 xl:block' aria-hidden='true'>→</span></div><div class='relative flex flex-col rounded-2xl border border-violet-400/40 bg-white/5 p-5'><span class='block h-1 w-12 rounded-full bg-violet-400'></span><p class='mt-4 text-[0.65rem] font-semibold uppercase tracking-[0.25em] text-violet-300'>Step 2 · /api/mcp</p><p class='mt-2 text-lg font-bold leading-snug text-white'>Cortex AI MCP server</p><p class='mt-1 text-xs text-slate-400'>Streamable HTTP · bearer token · scoped.</p><div class='mt-4 flex-1 text-sm text-slate-200'><div class='space-y-1.5'><code class='block rounded-md bg-white/5 px-3 py-1.5 font-mono text-xs text-violet-100'>get_database_schema</code><code class='block rounded-md bg-white/5 px-3 py-1.5 font-mono text-xs text-violet-100'>generate_jsonb_layout</code><code class='block rounded-md bg-white/5 px-3 py-1.5 font-mono text-xs text-violet-100'>update_site_navigation</code><code class='block rounded-md bg-white/5 px-3 py-1.5 font-mono text-xs text-violet-100'>query_site_analytics</code><code class='block rounded-md bg-white/5 px-3 py-1.5 font-mono text-xs text-violet-100'>search_stock_media</code></div></div><p class='mt-5 rounded-lg bg-violet-400/10 px-3 py-2 text-center text-[0.7rem] font-semibold text-violet-300'>5 contract tools · 29 typed tools</p><span class='absolute -right-4 top-1/2 hidden -translate-y-1/2 text-xl text-slate-500 xl:block' aria-hidden='true'>→</span></div><div class='relative flex flex-col rounded-2xl border border-emerald-400/40 bg-white/5 p-5'><span class='block h-1 w-12 rounded-full bg-emerald-400'></span><p class='mt-4 text-[0.65rem] font-semibold uppercase tracking-[0.25em] text-emerald-300'>Step 3 · PostgreSQL</p><p class='mt-2 text-lg font-bold leading-snug text-white'>Validated JSONB blocks</p><p class='mt-1 text-xs text-slate-400'>Supabase · one Zod schema per block.</p><div class='mt-4 flex-1 text-sm text-slate-200'><div class='space-y-2'><p class='flex items-start gap-2 text-sm text-slate-200'><span class='mt-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-emerald-400/20 text-[0.6rem] font-bold text-emerald-300'>&#10003;</span><span>Staged as a Live Draft.</span></p><p class='flex items-start gap-2 text-sm text-slate-200'><span class='mt-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-emerald-400/20 text-[0.6rem] font-bold text-emerald-300'>&#10003;</span><span>Editors refine in the visual CMS.</span></p><p class='flex items-start gap-2 text-sm text-slate-200'><span class='mt-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-emerald-400/20 text-[0.6rem] font-bold text-emerald-300'>&#10003;</span><span>Revisions and SEO checks built in.</span></p></div></div><p class='mt-5 rounded-lg bg-emerald-400/10 px-3 py-2 text-center text-[0.7rem] font-semibold text-emerald-300'>Nothing goes live until publish</p><span class='absolute -right-4 top-1/2 hidden -translate-y-1/2 text-xl text-slate-500 xl:block' aria-hidden='true'>→</span></div><div class='relative flex flex-col rounded-2xl border border-amber-400/40 bg-white/5 p-5'><span class='block h-1 w-12 rounded-full bg-amber-400'></span><p class='mt-4 text-[0.65rem] font-semibold uppercase tracking-[0.25em] text-amber-300'>Step 4 · Next.js 16</p><p class='mt-2 text-lg font-bold leading-snug text-white'>Published page</p><p class='mt-1 text-xs text-slate-400'>Server Components · edge cached.</p><div class='mt-4 flex-1 text-sm text-slate-200'><div class='space-y-2'><p class='flex items-start gap-2 text-sm text-slate-200'><span class='mt-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-amber-400/20 text-[0.6rem] font-bold text-amber-300'>&#10003;</span><span>No rebuild, no redeploy.</span></p><p class='flex items-start gap-2 text-sm text-slate-200'><span class='mt-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-amber-400/20 text-[0.6rem] font-bold text-amber-300'>&#10003;</span><span>100/100 Lighthouse defaults.</span></p><p class='flex items-start gap-2 text-sm text-slate-200'><span class='mt-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-amber-400/20 text-[0.6rem] font-bold text-amber-300'>&#10003;</span><span>Same site on day two.</span></p></div></div><p class='mt-5 rounded-lg bg-amber-400/10 px-3 py-2 text-center text-[0.7rem] font-semibold text-amber-300'>A website plus a CMS</p></div></div><div class='mt-6 h-1.5 rounded-full bg-gradient-to-r from-sky-400 via-violet-400 to-amber-400'></div><p class='mt-4 text-center text-sm text-slate-300'>Editors keep a visual CMS. Developers keep a clean Next.js 16 codebase. The agent never touches either.</p></div><p>The endpoint speaks Streamable HTTP. Your client posts JSON-RPC messages over a normal HTTPS request, and the server answers in the same response. There is no long-lived SSE stream to babysit and no SDK to install on the server side. The same 29 typed tools that power Cortex AI inside the editor are exposed over the wire, so the agent in your IDE and the agent in your CMS never drift apart.</p><div class='grid gap-4 md:grid-cols-2 my-8'><div class='rounded-3xl border border-violet-200/70 bg-violet-50/70 p-6 dark:border-violet-500/20 dark:bg-violet-500/10'><p class='mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-violet-700 dark:text-violet-200'>Safety rule one</p><p class='mt-3 mb-0 text-xl font-semibold text-slate-900 dark:text-white'>Layouts stage as Live Drafts.</p><p class='mt-3 mb-0 text-sm text-slate-600 dark:text-slate-300'>Layout tools write drafts, so nothing reaches visitors until an editor publishes it.</p></div><div class='rounded-3xl border border-blue-200/70 bg-blue-50/70 p-6 dark:border-blue-500/20 dark:bg-blue-500/10'><p class='mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-blue-700 dark:text-blue-200'>Safety rule two</p><p class='mt-3 mb-0 text-xl font-semibold text-slate-900 dark:text-white'>Every token carries a scope.</p><p class='mt-3 mb-0 text-sm text-slate-600 dark:text-slate-300'>A read-only token never even sees a tool that could change data. Mutating tools are absent from its list.</p></div></div><h3>Available MCP Database Tools</h3><p>Five tool names form the public MCP contract. Each one forwards to a tested Cortex AI executor.</p><div class='grid gap-4 md:grid-cols-2 my-8'><div class='rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-white/5'><div class='flex items-center justify-between gap-3'><code class='rounded-lg bg-violet-50 px-2.5 py-1 text-sm text-violet-700 dark:bg-violet-500/15 dark:text-violet-200'>get_database_schema</code><span class='rounded-full border px-2.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.18em] border-emerald-300 text-emerald-700 dark:border-emerald-500/40 dark:text-emerald-200'>read</span></div><p class='mt-3 mb-0 text-sm text-slate-600 dark:text-slate-300'>Returns every table the agent may read or change, with columns, primary keys, and read-only flags.</p></div><div class='rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-white/5'><div class='flex items-center justify-between gap-3'><code class='rounded-lg bg-violet-50 px-2.5 py-1 text-sm text-violet-700 dark:bg-violet-500/15 dark:text-violet-200'>generate_jsonb_layout</code><span class='rounded-full border px-2.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.18em] border-amber-300 text-amber-700 dark:border-amber-500/40 dark:text-amber-200'>write</span></div><p class='mt-3 mb-0 text-sm text-slate-600 dark:text-slate-300'>Turns a prompt into a full page layout, validates each block against the NextBlock schema, and stages it as a Live Draft.</p></div><div class='rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-white/5'><div class='flex items-center justify-between gap-3'><code class='rounded-lg bg-violet-50 px-2.5 py-1 text-sm text-violet-700 dark:bg-violet-500/15 dark:text-violet-200'>update_site_navigation</code><span class='rounded-full border px-2.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.18em] border-amber-300 text-amber-700 dark:border-amber-500/40 dark:text-amber-200'>write</span></div><p class='mt-3 mb-0 text-sm text-slate-600 dark:text-slate-300'>Adds, renames, or reorders header menu items per locale.</p></div><div class='rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-white/5'><div class='flex items-center justify-between gap-3'><code class='rounded-lg bg-violet-50 px-2.5 py-1 text-sm text-violet-700 dark:bg-violet-500/15 dark:text-violet-200'>query_site_analytics</code><span class='rounded-full border px-2.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.18em] border-emerald-300 text-emerald-700 dark:border-emerald-500/40 dark:text-emerald-200'>read</span></div><p class='mt-3 mb-0 text-sm text-slate-600 dark:text-slate-300'>Reads revenue, order counts, status breakdowns, and top products over a date range.</p></div><div class='rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-white/5'><div class='flex items-center justify-between gap-3'><code class='rounded-lg bg-violet-50 px-2.5 py-1 text-sm text-violet-700 dark:bg-violet-500/15 dark:text-violet-200'>search_stock_media</code><span class='rounded-full border px-2.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.18em] border-emerald-300 text-emerald-700 dark:border-emerald-500/40 dark:text-emerald-200'>read</span></div><p class='mt-3 mb-0 text-sm text-slate-600 dark:text-slate-300'>Finds free stock photos with alt text and photographer credits ready for an image block.</p></div><div class='rounded-3xl border border-dashed border-slate-300 p-5 dark:border-white/20'><p class='mt-0 mb-0 text-sm font-semibold text-slate-900 dark:text-white'>And 24 more.</p><p class='mt-2 mb-0 text-sm text-slate-600 dark:text-slate-300'>Create posts and products, translate pages, upload media, manage themes and scripts. Three resources expose the database, block, and custom block schemas.</p></div></div><h2>Step by Step: Connect Claude to NextBlock CMS in Cursor and Claude Code</h2><p>The server is off by default because it is a remote write surface onto live content. Turning it on takes three steps, and the trial means the first month costs nothing.</p><div class='grid gap-4 md:grid-cols-3 my-8'><div class='rounded-3xl border border-slate-200 bg-slate-50 p-6 dark:border-white/10 dark:bg-white/5'><p class='mt-0 mb-0 font-mono text-3xl font-bold text-sky-500 dark:text-sky-300'>01</p><p class='mt-3 mb-0 text-lg font-semibold text-slate-900 dark:text-white'>Start the free trial.</p><p class='mt-2 mb-0 text-sm text-slate-600 dark:text-slate-300'>Open <strong>CMS Settings → Cortex AI</strong>, start the 30-day trial with no credit card, and switch on the MCP server access card.</p></div><div class='rounded-3xl border border-slate-200 bg-slate-50 p-6 dark:border-white/10 dark:bg-white/5'><p class='mt-0 mb-0 font-mono text-3xl font-bold text-violet-500 dark:text-violet-300'>02</p><p class='mt-3 mb-0 text-lg font-semibold text-slate-900 dark:text-white'>Mint a token.</p><p class='mt-2 mb-0 text-sm text-slate-600 dark:text-slate-300'>Pick the scope you need. Read-only is enough for planning and audits.</p></div><div class='rounded-3xl border border-slate-200 bg-slate-50 p-6 dark:border-white/10 dark:bg-white/5'><p class='mt-0 mb-0 font-mono text-3xl font-bold text-emerald-500 dark:text-emerald-300'>03</p><p class='mt-3 mb-0 text-lg font-semibold text-slate-900 dark:text-white'>Copy the config.</p><p class='mt-2 mb-0 text-sm text-slate-600 dark:text-slate-300'>The card renders one snippet each for Claude Code, Cursor, VS Code, and Claude Desktop.</p></div></div><p>Claude Code needs <code>\"type\": \"http\"</code> in the entry, or it skips the server without a warning. Cursor infers the transport from the URL and needs no type field. VS Code uses a top-level <code>servers</code> key and prompts for the token instead of storing it.</p><h3>Localhost Configuration Without a Token</h3><p>While you build, turn on <strong>Trust localhost without a token</strong> in the same settings card. A dev server on your machine then accepts loopback calls with no header at all. Standalone installs run on port 3000, and the monorepo dev server runs on port 4200.</p><p>Add this block to <code>.mcp.json</code> in your project root for Claude Code.</p><div class='my-8 overflow-hidden rounded-[2rem] border border-slate-800 bg-slate-950 shadow-2xl'><div class='flex items-center gap-2 border-b border-white/10 px-5 py-3'><span class='h-3 w-3 rounded-full bg-red-400/70'></span><span class='h-3 w-3 rounded-full bg-yellow-400/70'></span><span class='h-3 w-3 rounded-full bg-green-400/70'></span><span class='ml-3 text-xs font-mono text-slate-400'>.mcp.json</span></div><pre class='m-0 overflow-x-auto rounded-none bg-transparent px-6 py-5 text-sm leading-6 text-slate-200'><code>{\n  \"mcpServers\": {\n    \"nextblock\": {\n      \"type\": \"http\",\n      \"url\": \"http://localhost:3000/api/mcp\"\n    }\n  }\n}</code></pre></div><p>The CLI form does the same thing in one line.</p><div class='my-8 overflow-hidden rounded-[2rem] border border-slate-800 bg-slate-950 shadow-2xl'><div class='flex items-center gap-2 border-b border-white/10 px-5 py-3'><span class='h-3 w-3 rounded-full bg-red-400/70'></span><span class='h-3 w-3 rounded-full bg-yellow-400/70'></span><span class='h-3 w-3 rounded-full bg-green-400/70'></span><span class='ml-3 text-xs font-mono text-slate-400'>terminal</span></div><pre class='m-0 overflow-x-auto rounded-none bg-transparent px-6 py-5 text-sm leading-6 text-slate-200'><code>claude mcp add --transport http nextblock http://localhost:3000/api/mcp</code></pre></div><div class='rounded-3xl border border-amber-200 bg-amber-50/80 p-6 my-8 dark:border-amber-500/20 dark:bg-amber-500/10'><p class='mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-amber-700 dark:text-amber-200'>Development only</p><p class='mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200'>Localhost trust is ignored in production builds, because a proxy can spoof the host header. Production always uses a token.</p></div><h3>Production Authentication via Bearer Tokens</h3><p>In production every client sends a bearer token. Tokens start with <code>nbmcp_</code>, are shown once at mint time, and are stored only as SHA-256 hashes. Revoking one is a single click, and the same value can never be minted again.</p><p>Add this to <code>.cursor/mcp.json</code> for Cursor, or drop the same entry into <code>.mcp.json</code> with a type field for Claude Code.</p><div class='my-8 overflow-hidden rounded-[2rem] border border-slate-800 bg-slate-950 shadow-2xl'><div class='flex items-center gap-2 border-b border-white/10 px-5 py-3'><span class='h-3 w-3 rounded-full bg-red-400/70'></span><span class='h-3 w-3 rounded-full bg-yellow-400/70'></span><span class='h-3 w-3 rounded-full bg-green-400/70'></span><span class='ml-3 text-xs font-mono text-slate-400'>.cursor/mcp.json</span></div><pre class='m-0 overflow-x-auto rounded-none bg-transparent px-6 py-5 text-sm leading-6 text-slate-200'><code>{\n  \"mcpServers\": {\n    \"nextblock\": {\n      \"url\": \"https://your-site.com/api/mcp\",\n      \"headers\": { \"Authorization\": \"Bearer nbmcp_your_token\" }\n    }\n  }\n}</code></pre></div><div class='rounded-3xl border border-violet-200 bg-violet-50/80 p-6 my-8 dark:border-violet-500/20 dark:bg-violet-500/10'><p class='mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-violet-700 dark:text-violet-200'>Try it</p><p class='mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200'>Once the client connects, ask for something concrete. Try &ldquo;inspect the database schema and draft a pricing page with three tiers.&rdquo; The agent calls the schema tool, then the layout tool, and your CMS shows a new Live Draft ready for review.</p></div><h2>Zero-Redeploy Production Rendering</h2><p>The reason this works is where the output lands. Cortex AI writes strict JSONB block records into PostgreSQL, not HTML strings and not source files. Each block has a Zod schema, so a bad field is rejected before it is stored.</p><div class='grid gap-4 md:grid-cols-3 my-8'><div class='rounded-3xl border border-sky-200/70 bg-sky-50/70 p-6 text-center dark:border-sky-500/20 dark:bg-sky-500/10'><p class='mt-0 mb-0 text-4xl font-extrabold text-slate-900 dark:text-white'>0</p><p class='mt-2 mb-0 text-xs font-semibold uppercase tracking-[0.2em] text-sky-700 dark:text-sky-200'>Rebuilds to publish</p></div><div class='rounded-3xl border border-violet-200/70 bg-violet-50/70 p-6 text-center dark:border-violet-500/20 dark:bg-violet-500/10'><p class='mt-0 mb-0 text-4xl font-extrabold text-slate-900 dark:text-white'>1</p><p class='mt-2 mb-0 text-xs font-semibold uppercase tracking-[0.2em] text-violet-700 dark:text-violet-200'>Zod schema per block</p></div><div class='rounded-3xl border border-emerald-200/70 bg-emerald-50/70 p-6 text-center dark:border-emerald-500/20 dark:bg-emerald-500/10'><p class='mt-0 mb-0 text-4xl font-extrabold text-slate-900 dark:text-white'>100</p><p class='mt-2 mb-0 text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700 dark:text-emerald-200'>Lighthouse by default</p></div></div><p>At request time Next.js 16 renders those records with Server Components and caches the result at the edge. There is no build step between publish and live, and no HTML sanitizer tax on every render. The 100/100 Lighthouse defaults you get on an empty site are the same ones you get after the agent has drafted fifty pages.</p><div class='rounded-3xl border border-slate-200 bg-slate-50 p-6 my-10 dark:border-white/10 dark:bg-white/5'><p class='mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-slate-600 dark:text-slate-300'>Next step</p><p class='mt-3 mb-0 text-xl font-semibold text-slate-900 dark:text-white'>Up in ten minutes, free for thirty days.</p><p class='mt-3 text-sm text-slate-600 dark:text-slate-300'>Deploy the free CMS to Vercel in one click, start the Cortex AI trial with no credit card, and connect Claude to NextBlock CMS today. Read how the block registry keeps all of it safe if you want the full picture.</p><div class='mt-5 flex flex-wrap gap-3'><a href='https://nextblock.dev/product/nextblock-cortex-ai-cortex-ai-license' class='inline-flex items-center rounded-full bg-slate-900 px-6 py-3 text-sm font-semibold text-white no-underline shadow-lg hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200'>Start the 30-day free trial</a><a href='https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fnextblock-cms%2Fnextblock&project-name=nextblock&repository-name=nextblock&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22supabase%22%2C%22productSlug%22%3A%22supabase%22%7D%5D' class='inline-flex items-center rounded-full border border-slate-300 px-6 py-3 text-sm font-semibold text-slate-700 no-underline hover:border-slate-500 dark:border-white/20 dark:text-slate-200 dark:hover:border-white/50'>Deploy to Vercel</a><a href='/article/how-nextblock-works' class='inline-flex items-center rounded-full border border-slate-300 px-6 py-3 text-sm font-semibold text-slate-700 no-underline hover:border-slate-500 dark:border-white/20 dark:text-slate-200 dark:hover:border-white/50'>How NextBlock works</a></div></div>"}$nbmcpguide3$::jsonb, updated_at = now()
     WHERE post_id = v_post AND block_type = 'text' AND "order" = 0
       AND content->>'html_content' LIKE '%A codebase to babysit.%';
  END IF;

  DELETE FROM public.media m
   WHERE m.object_key = 'images/mcp-prompt-to-production.webp'
     AND NOT EXISTS (SELECT 1 FROM public.blocks b WHERE b.content::text LIKE '%mcp-prompt-to-production.webp%')
     AND NOT EXISTS (SELECT 1 FROM public.posts p WHERE p.feature_image_id = m.id)
     AND NOT EXISTS (SELECT 1 FROM public.pages p WHERE p.feature_image_id = m.id)
     AND NOT EXISTS (SELECT 1 FROM public.product_media pm WHERE pm.media_id = m.id);

  ---------------------------------------------------------------------------
  -- 4. Articles pages: short hero, essay moves below the grid (EN + FR)
  ---------------------------------------------------------------------------
  SELECT id INTO v_articles_en FROM public.pages WHERE slug = 'articles' AND language_id = v_en ORDER BY id LIMIT 1;
  SELECT id INTO v_articles_fr FROM public.pages WHERE slug = 'articles' AND language_id = v_fr ORDER BY id LIMIT 1;

  IF v_articles_en IS NOT NULL THEN
    UPDATE public.blocks SET content = $nbjhero_en${"is_hero":true,"padding":{"top":"xl","bottom":"xl"},"background":{"type":"gradient","gradient":{"type":"linear","stops":[{"color":"#020817","position":0},{"color":"#1e293b","position":100}],"direction":"135deg"}},"column_gap":"lg","container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":2},"column_blocks":[[{"block_type":"text","content":{"html_content":"<p class='text-sm uppercase tracking-[0.3em] text-blue-400 font-bold text-center md:text-left mb-4'>The NextBlock Journal</p>"}},{"block_type":"text","content":{"html_content":"<h1 class='text-4xl md:text-5xl font-bold text-white text-center md:text-left mb-6'>The NextBlock Journal: Performance, DX, and Visual Editing</h1>"}},{"block_type":"text","content":{"html_content":"<p class='text-slate-300 text-lg max-w-xl mx-auto md:mx-0 text-center md:text-left leading-relaxed'>Practical guides, architecture deep dives, and editor workflows from the NextBlock team. Pick a topic below or jump straight to the latest posts.</p>"}},{"block_type":"button","content":{"url":"/articles#latest","size":"lg","text":"Explore Articles","variant":"default"}},{"block_type":"button","content":{"url":"https://github.com/nextblock-cms/nextblock/discussions","size":"lg","text":"Subscribe for Updates","variant":"outline"}}],[{"block_type":"text","content":{"html_content":"<div class='h-full flex items-center justify-center rounded-3xl overflow-hidden border border-white/10 bg-white/5 shadow-2xl p-4 backdrop-blur-sm'><img src='/images/developer.webp' alt='Developer working with the Nextblock stack' class='w-full object-cover rounded-2xl shadow-lg' style='max-width: 400px;' /></div>"}}]]}$nbjhero_en$::jsonb, updated_at = now()
     WHERE page_id = v_articles_en AND block_type = 'section' AND content::text LIKE '%Welcome to the NextBlock Journal.%';

    IF NOT EXISTS (SELECT 1 FROM public.blocks WHERE page_id = v_articles_en AND content::text LIKE '%What the NextBlock Journal Covers%') THEN
      INSERT INTO public.blocks (page_id, language_id, block_type, content, "order")
      VALUES (v_articles_en, v_en, 'section', $nbjsec_en${"padding":{"top":"xl","bottom":"xl"},"background":{"type":"none"},"column_gap":"lg","container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":1},"column_blocks":[[{"block_type":"heading","content":{"level":2,"textAlign":"center","text_content":"What the NextBlock Journal Covers"}},{"block_type":"text","content":{"html_content":"<p class='text-lg text-muted-foreground text-center max-w-3xl mx-auto mb-10'>Every post is tested on a live site before it is published, and each one includes the full technical reasoning and diagrams. Start with the topic that matches where you are.</p><div class='grid gap-4 md:grid-cols-2'><div class='rounded-3xl border border-sky-200/70 bg-sky-50/70 p-6 dark:border-sky-500/20 dark:bg-sky-500/10'><p class='text-xs font-semibold uppercase tracking-[0.22em] text-sky-700 dark:text-sky-200'>Getting started</p><h3 class='mt-3 text-xl font-semibold text-foreground'>Setup, every way</h3><p class='mt-3 text-sm text-muted-foreground'>Walkthroughs for one-click Vercel deploys, local Docker environments, and custom cloud stacks. Each guide gives you clear, tested steps, so a fresh site is live in minutes rather than days.</p><a href='/article/how-to-setup-nextblock' class='mt-4 inline-flex text-sm font-semibold text-sky-700 no-underline hover:underline dark:text-sky-200'>Read the setup guide →</a></div><div class='rounded-3xl border border-indigo-200/70 bg-indigo-50/70 p-6 dark:border-indigo-500/20 dark:bg-indigo-500/10'><p class='text-xs font-semibold uppercase tracking-[0.22em] text-indigo-700 dark:text-indigo-200'>Architecture and performance</p><h3 class='mt-3 text-xl font-semibold text-foreground'>How the engine works</h3><p class='mt-3 text-sm text-muted-foreground'>Deep dives into fast page rendering, clean CSS delivery, image optimization, and safe database migrations. Learn how NextBlock keeps a 100% Lighthouse score while giving writers a rich block editor.</p><a href='/article/how-nextblock-works' class='mt-4 inline-flex text-sm font-semibold text-indigo-700 no-underline hover:underline dark:text-indigo-200'>Look under the hood →</a></div><div class='rounded-3xl border border-emerald-200/70 bg-emerald-50/70 p-6 dark:border-emerald-500/20 dark:bg-emerald-500/10'><p class='text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200'>E-commerce workflows</p><h3 class='mt-3 text-xl font-semibold text-foreground'>From catalog to checkout</h3><p class='mt-3 text-sm text-muted-foreground'>Practical patterns for multi-currency pricing, automated tax sync, stock tracking, and provider-aware checkout with Stripe and Freemius, all managed from the same block editor.</p><a href='/article/nextblock-commerce-guide' class='mt-4 inline-flex text-sm font-semibold text-emerald-700 no-underline hover:underline dark:text-emerald-200'>Read the commerce guide →</a></div><div class='rounded-3xl border border-violet-200/70 bg-violet-50/70 p-6 dark:border-violet-500/20 dark:bg-violet-500/10'><p class='text-xs font-semibold uppercase tracking-[0.22em] text-violet-700 dark:text-violet-200'>Cortex AI and MCP</p><h3 class='mt-3 text-xl font-semibold text-foreground'>AI that writes blocks, not code</h3><p class='mt-3 text-sm text-muted-foreground'>How to generate structured layouts with Cortex AI, connect Claude Code or Cursor to your site over MCP, and speed up translation work. The CMS is free, and Cortex AI starts with a 30-day trial and no credit card.</p><a href='/article/cortex-ai-mcp-connection-guide' class='mt-4 inline-flex text-sm font-semibold text-violet-700 no-underline hover:underline dark:text-violet-200'>Connect your AI →</a></div></div><p class='mt-8 text-center text-base text-foreground max-w-2xl mx-auto'>Every guide reads in under ten minutes. Code samples come from sites already in production, and every screenshot comes from the real CMS interface, so what you see here is what you get.</p><p class='mt-6 text-center text-sm text-muted-foreground max-w-2xl mx-auto'>Have a topic you want covered, or a case study to share? Join the community on <a href='https://github.com/nextblock-cms/nextblock/discussions' class='font-semibold text-foreground underline'>GitHub Discussions</a>. We welcome questions, ideas, and pull requests from all builders, and we update this collection with every release.</p>"}}]]}$nbjsec_en$::jsonb,
              (SELECT COALESCE(MAX("order"), 0) + 1 FROM public.blocks WHERE page_id = v_articles_en));
    END IF;
  END IF;

  IF v_articles_fr IS NOT NULL THEN
    UPDATE public.blocks SET content = $nbjhero_fr${"is_hero":true,"padding":{"top":"xl","bottom":"xl"},"background":{"type":"gradient","gradient":{"type":"linear","stops":[{"color":"#020817","position":0},{"color":"#1e293b","position":100}],"direction":"135deg"}},"column_gap":"lg","container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":2},"column_blocks":[[{"block_type":"text","content":{"html_content":"<p class='text-sm uppercase tracking-[0.3em] text-blue-400 font-bold text-center md:text-left mb-4'>Le journal Nextblock</p>"}},{"block_type":"text","content":{"html_content":"<h1 class='text-4xl md:text-5xl font-bold text-white text-center md:text-left mb-6'>Le Journal NextBlock : Performance, Expérience Dev et Édition</h1>"}},{"block_type":"text","content":{"html_content":"<p class='text-slate-300 text-lg max-w-xl mx-auto md:mx-0 text-center md:text-left leading-relaxed'>Guides pratiques, dossiers d'architecture et conseils d'édition par l'équipe NextBlock. Choisissez un thème plus bas, ou allez droit aux derniers articles.</p>"}},{"block_type":"button","content":{"url":"/articles#latest","size":"lg","text":"Explorer les articles","variant":"default"}},{"block_type":"button","content":{"url":"https://github.com/nextblock-cms/nextblock/discussions","size":"lg","text":"S'abonner aux mises à jour","variant":"outline"}}],[{"block_type":"text","content":{"html_content":"<div class='h-full flex items-center justify-center rounded-3xl overflow-hidden border border-white/10 bg-white/5 shadow-2xl p-4 backdrop-blur-sm'><img src='/images/developer.webp' alt='Développeur travaillant avec la stack Nextblock' class='w-full object-cover rounded-2xl shadow-lg' style='max-width: 400px;' /></div>"}}]]}$nbjhero_fr$::jsonb, updated_at = now()
     WHERE page_id = v_articles_fr AND block_type = 'section' AND content::text LIKE '%Bienvenue sur le Journal NextBlock.%';

    IF NOT EXISTS (SELECT 1 FROM public.blocks WHERE page_id = v_articles_fr AND content::text LIKE '%Ce que couvre le Journal NextBlock%') THEN
      INSERT INTO public.blocks (page_id, language_id, block_type, content, "order")
      VALUES (v_articles_fr, v_fr, 'section', $nbjsec_fr${"padding":{"top":"xl","bottom":"xl"},"background":{"type":"none"},"column_gap":"lg","container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":1},"column_blocks":[[{"block_type":"heading","content":{"level":2,"textAlign":"center","text_content":"Ce que couvre le Journal NextBlock"}},{"block_type":"text","content":{"html_content":"<p class='text-lg text-muted-foreground text-center max-w-3xl mx-auto mb-10'>Chaque article est testé sur un vrai site avant sa sortie. Il donne le raisonnement complet et des schémas clairs. Commencez par le thème qui vous parle.</p><div class='grid gap-4 md:grid-cols-2'><div class='rounded-3xl border border-sky-200/70 bg-sky-50/70 p-6 dark:border-sky-500/20 dark:bg-sky-500/10'><p class='text-xs font-semibold uppercase tracking-[0.22em] text-sky-700 dark:text-sky-200'>Premiers pas</p><h3 class='mt-3 text-xl font-semibold text-foreground'>Installer NextBlock, à votre façon</h3><p class='mt-3 text-sm text-muted-foreground'>Des guides pas à pas pour un déploiement Vercel en un clic, un Docker local ou votre propre cloud. Chaque étape est vérifiée. Votre site est en ligne en quelques minutes, pas en quelques jours.</p><a href='/article/comment-configurer-nextblock' class='mt-4 inline-flex text-sm font-semibold text-sky-700 no-underline hover:underline dark:text-sky-200'>Lire le guide d'installation →</a></div><div class='rounded-3xl border border-indigo-200/70 bg-indigo-50/70 p-6 dark:border-indigo-500/20 dark:bg-indigo-500/10'><p class='text-xs font-semibold uppercase tracking-[0.22em] text-indigo-700 dark:text-indigo-200'>Architecture et performance</p><h3 class='mt-3 text-xl font-semibold text-foreground'>Comment marche le moteur</h3><p class='mt-3 text-sm text-muted-foreground'>Des dossiers sur le rendu rapide des pages, la livraison du CSS, les images et les migrations sûres. Vous verrez comment NextBlock garde un score Lighthouse parfait, avec un vrai éditeur de blocs pour vos auteurs.</p><a href='/article/comment-nextblock-fonctionne' class='mt-4 inline-flex text-sm font-semibold text-indigo-700 no-underline hover:underline dark:text-indigo-200'>Regarder sous le capot →</a></div><div class='rounded-3xl border border-emerald-200/70 bg-emerald-50/70 p-6 dark:border-emerald-500/20 dark:bg-emerald-500/10'><p class='text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200'>Commerce en ligne</p><h3 class='mt-3 text-xl font-semibold text-foreground'>Du catalogue au paiement</h3><p class='mt-3 text-sm text-muted-foreground'>Des méthodes concrètes pour les prix en plusieurs devises, les taxes automatiques, les stocks et le paiement avec Stripe et Freemius. Tout se gère depuis le même éditeur de blocs.</p><a href='/article/guide-commerce-nextblock' class='mt-4 inline-flex text-sm font-semibold text-emerald-700 no-underline hover:underline dark:text-emerald-200'>Lire le guide commerce →</a></div><div class='rounded-3xl border border-violet-200/70 bg-violet-50/70 p-6 dark:border-violet-500/20 dark:bg-violet-500/10'><p class='text-xs font-semibold uppercase tracking-[0.22em] text-violet-700 dark:text-violet-200'>Cortex AI et MCP</p><h3 class='mt-3 text-xl font-semibold text-foreground'>Une IA qui écrit des blocs, pas du code</h3><p class='mt-3 text-sm text-muted-foreground'>Créez des mises en page avec Cortex AI. Reliez Claude Code ou Cursor à votre site via MCP. Traduisez plus vite. Le CMS est gratuit, et Cortex AI offre un essai de 30 jours sans carte bancaire.</p><a href='/article/cortex-ai-mcp-connection-guide' class='mt-4 inline-flex text-sm font-semibold text-violet-700 no-underline hover:underline dark:text-violet-200'>Connecter votre IA →</a></div></div><p class='mt-8 text-center text-base text-foreground max-w-2xl mx-auto'>Chaque guide se lit en moins de dix minutes. Les exemples de code viennent de sites déjà en production, et chaque capture vient de la vraie interface du CMS. Ce que vous lisez ici est ce que vous obtenez.</p><p class='mt-6 text-center text-sm text-muted-foreground max-w-2xl mx-auto'>Un sujet à proposer, ou une étude de cas à partager ? Rejoignez la communauté sur <a href='https://github.com/nextblock-cms/nextblock/discussions' class='font-semibold text-foreground underline'>GitHub Discussions</a>. Vos questions, idées et contributions sont les bienvenues. Cette collection grandit à chaque version.</p>"}}]]}$nbjsec_fr$::jsonb,
              (SELECT COALESCE(MAX("order"), 0) + 1 FROM public.blocks WHERE page_id = v_articles_fr));
    END IF;
  END IF;
END
$body$;
$nb_file_00000000000041$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000041_marketing_review_free_cms_trial.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000041_marketing_review_free_cms_trial.sql

  -- >>> FROM: 00000000000042_how_nextblock_works_css_diagram.sql
  IF NOT pg_temp.nb_recorded('00000000000042', '00000000000042_how_nextblock_works_css_diagram') THEN
    RAISE NOTICE 'catch-up: applying 00000000000042_how_nextblock_works_css_diagram.sql';
    EXECUTE $nb_file_00000000000042$
-- 00000000000042_how_nextblock_works_css_diagram.sql
--
-- The "How NextBlock™ Works" article (EN 'how-nextblock-works', FR
-- 'comment-nextblock-fonctionne') illustrated the platform with a rasterised
-- figure (public/images/extensibility.webp). This replaces that <figure> with a
-- CSS/HTML architecture diagram inside the same rich-text block: the NB platform
-- core (site logo) with four spokes, the "unified architecture" band with three
-- panels (content modeling, live editor and publishing, premium modules), the
-- stack strip and the tagline. Same visual story, but crisp at every size,
-- theme-aware and editable in the CMS.
--
-- The image file and its media row stay: the sandbox reset route registers it as
-- a core media record and nothing else changes. Only the two article bodies do.
--
-- Idempotent: replace() is a no-op once the figure is gone, and the row is only
-- matched while the exact seeded figure is still present, so an editor's rewrite
-- of the article is left alone. Both posts still grade 100/100 in
-- libs/utils/src/lib/seo (the logo <img> carries alt text).
--
-- After adding this file: npm run generate:migrations-bundle && npm run
-- generate:sandbox && npm run sync:create-nextblock.

DO $body$
DECLARE
  v_en   integer;
  v_fr   integer;
  v_post integer;
BEGIN
  SELECT id INTO v_en FROM public.languages WHERE code = 'en' LIMIT 1;
  SELECT id INTO v_fr FROM public.languages WHERE code = 'fr' LIMIT 1;

  SELECT id INTO v_post FROM public.posts WHERE slug = 'how-nextblock-works' AND language_id = v_en ORDER BY id LIMIT 1;
  IF v_post IS NOT NULL THEN
    UPDATE public.blocks
       SET content = jsonb_set(content, '{html_content}', to_jsonb(replace(content->>'html_content', $nbfig_en$<figure class='my-12 overflow-hidden rounded-[2rem] border border-slate-200/80 bg-slate-950 shadow-2xl dark:border-white/10'>
  <img src='/images/extensibility.webp' alt='NextBlock™ extensibility artwork showing the CMS connected to reusable modules and integrations' class='w-full h-auto object-cover' />
  <figcaption class='border-t border-white/10 px-6 py-4 text-sm text-slate-300'>One unified design system spans content blocks, editing tools, and store features.</figcaption>
</figure>$nbfig_en$, $nbdiag_en$<div class='not-prose my-12 overflow-hidden rounded-[2rem] border border-slate-800 shadow-2xl'><div class='bg-gradient-to-b from-[#020817] via-[#0b1a3a] to-[#0f172a] p-6 sm:p-8'><p class='text-center text-[0.65rem] font-semibold uppercase tracking-[0.3em] text-cyan-300'>NB platform core</p><div class='mx-auto mt-4 flex h-28 w-28 items-center justify-center rounded-full border border-cyan-400/40 bg-cyan-400/10 shadow-[0_0_70px_rgba(34,211,238,0.28)]'><img src='/images/nextblock-logo-small.webp' alt='NextBlock logo at the centre of the platform core' class='h-16 w-16 object-contain' /></div><p class='mt-3 text-center text-sm font-bold text-white'>One Next.js 16 app on Supabase</p><div class='mx-auto h-8 w-px bg-cyan-400/40'></div><div class='relative'><div class='absolute left-[12.5%] right-[12.5%] top-0 h-px bg-cyan-400/30'></div><div class='grid grid-cols-2 gap-3 md:grid-cols-4'><div class='flex flex-col items-center'><div class='h-6 w-px bg-cyan-400/40'></div><div class='flex w-full flex-col items-center rounded-2xl border border-cyan-400/30 bg-white/5 px-3 py-4 text-center'><span class='flex h-11 w-11 items-center justify-center rounded-xl border border-cyan-400/40 bg-cyan-400/10 text-cyan-300'><svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round' class='h-6 w-6' aria-hidden='true'><path d='M3 4h2l2.4 11.2a1 1 0 0 0 1 .8h9.2a1 1 0 0 0 1-.8L20 8H6.2M9 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm8 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2z'/></svg></span><span class='mt-3 text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-slate-100'>Commerce</span></div></div><div class='flex flex-col items-center'><div class='h-6 w-px bg-cyan-400/40'></div><div class='flex w-full flex-col items-center rounded-2xl border border-cyan-400/30 bg-white/5 px-3 py-4 text-center'><span class='flex h-11 w-11 items-center justify-center rounded-xl border border-cyan-400/40 bg-cyan-400/10 text-cyan-300'><svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round' class='h-6 w-6' aria-hidden='true'><path d='M13 2 4 14h7l-1 8 9-12h-7l1-8z'/></svg></span><span class='mt-3 text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-slate-100'>Performance</span></div></div><div class='flex flex-col items-center'><div class='h-6 w-px bg-cyan-400/40'></div><div class='flex w-full flex-col items-center rounded-2xl border border-cyan-400/30 bg-white/5 px-3 py-4 text-center'><span class='flex h-11 w-11 items-center justify-center rounded-xl border border-cyan-400/40 bg-cyan-400/10 text-cyan-300'><svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round' class='h-6 w-6' aria-hidden='true'><path d='M4 20V11M10 20V4M16 20v-7M2 20h20'/></svg></span><span class='mt-3 text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-slate-100'>Analytics</span></div></div><div class='flex flex-col items-center'><div class='h-6 w-px bg-cyan-400/40'></div><div class='flex w-full flex-col items-center rounded-2xl border border-cyan-400/30 bg-white/5 px-3 py-4 text-center'><span class='flex h-11 w-11 items-center justify-center rounded-xl border border-cyan-400/40 bg-cyan-400/10 text-cyan-300'><svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round' class='h-6 w-6' aria-hidden='true'><path d='M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1'/></svg></span><span class='mt-3 text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-slate-100'>API & integrations</span></div></div></div></div><div class='mt-8 flex items-center gap-3'><span class='h-px flex-1 bg-cyan-400/30'></span><span class='rounded-full border border-cyan-400/40 bg-slate-950 px-4 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.3em] text-cyan-200'>Unified architecture</span><span class='h-px flex-1 bg-cyan-400/30'></span></div><div class='mt-4 grid gap-4 md:grid-cols-3'><div class='flex flex-col rounded-2xl border border-cyan-400/20 bg-slate-950/70 p-4'><p class='text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-cyan-300'>CMS & content modeling</p><div class='mt-3 flex-1'><div class='flex items-center justify-center gap-2'><div class='space-y-1.5'><span class='block rounded-md border border-slate-600/70 bg-slate-900 px-2.5 py-1 text-center font-mono text-[0.65rem] text-slate-200'>page</span><span class='block rounded-md border border-slate-600/70 bg-slate-900 px-2.5 py-1 text-center font-mono text-[0.65rem] text-slate-200'>post</span><span class='block rounded-md border border-slate-600/70 bg-slate-900 px-2.5 py-1 text-center font-mono text-[0.65rem] text-slate-200'>product</span></div><span class='h-px w-4 bg-cyan-400/50'></span><div class='rounded-xl border border-cyan-400/40 bg-cyan-400/10 px-3 py-2 text-center'><p class='text-[0.55rem] uppercase tracking-[0.2em] text-cyan-300'>PostgreSQL</p><p class='text-xs font-semibold text-white'>JSONB blocks</p></div><span class='h-px w-4 bg-cyan-400/50'></span><div class='space-y-1.5'><span class='block rounded-md border border-slate-600/70 bg-slate-900 px-2.5 py-1 text-center font-mono text-[0.65rem] text-slate-200'>block</span><span class='block rounded-md border border-slate-600/70 bg-slate-900 px-2.5 py-1 text-center font-mono text-[0.65rem] text-slate-200'>revision</span><span class='block rounded-md border border-slate-600/70 bg-slate-900 px-2.5 py-1 text-center font-mono text-[0.65rem] text-slate-200'>draft</span></div></div><p class='mt-3 text-xs text-slate-400'>Every page, post, and product is an ordered list of typed blocks. One Zod schema per block keeps the data valid.</p></div></div><div class='flex flex-col rounded-2xl border border-cyan-400/20 bg-slate-950/70 p-4'><p class='text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-cyan-300'>Live editor & publishing</p><div class='mt-3 flex-1'><div class='overflow-hidden rounded-xl border border-slate-700 bg-slate-900'><div class='flex items-center gap-1.5 border-b border-white/10 px-3 py-2'><span class='h-2 w-2 rounded-full bg-red-400/70'></span><span class='h-2 w-2 rounded-full bg-yellow-400/70'></span><span class='h-2 w-2 rounded-full bg-green-400/70'></span><span class='ml-2 truncate font-mono text-[0.6rem] text-slate-400'>cms/pages/home</span></div><div class='flex gap-2 p-3'><div class='w-10 space-y-1.5'><span class='block h-1.5 rounded-full bg-slate-700 w-full'></span><span class='block h-1.5 rounded-full bg-slate-700 w-3/4'></span><span class='block h-1.5 rounded-full bg-slate-700 w-full'></span><span class='block h-1.5 rounded-full bg-slate-700 w-1/2'></span></div><div class='flex-1 rounded-lg border border-dashed border-cyan-400/40 bg-cyan-400/5 p-2'><p class='text-[0.6rem] font-semibold text-cyan-200'>Live preview</p><div class='mt-1.5 space-y-1.5'><span class='block h-1.5 rounded-full bg-slate-600 w-11/12'></span><span class='block h-1.5 rounded-full bg-slate-600 w-2/3'></span><span class='block h-1.5 rounded-full bg-slate-600 w-4/5'></span></div></div></div><div class='flex items-center justify-between border-t border-white/10 px-3 py-2'><span class='rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[0.6rem] font-semibold text-amber-200'>Live Draft</span><span class='rounded-md bg-cyan-400 px-2.5 py-1 text-[0.6rem] font-bold text-slate-950'>Publish</span></div></div><p class='mt-3 text-xs text-slate-400'>Editors work in a Notion-style editor with drafts and revisions. Publishing reads straight from PostgreSQL, so there is no redeploy.</p></div></div><div class='flex flex-col rounded-2xl border border-cyan-400/20 bg-slate-950/70 p-4'><p class='text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-cyan-300'>Premium modules</p><div class='mt-3 flex-1'><div class='flex items-center gap-2'><span class='shrink-0 rounded-md border border-cyan-400/40 bg-cyan-400/10 px-2 py-1 text-[0.6rem] font-semibold uppercase tracking-[0.15em] text-cyan-200'>Add-on</span><span class='h-px w-4 bg-cyan-400/50'></span><div class='flex-1 space-y-2'><div class='flex items-center gap-2 rounded-xl border border-emerald-400/40 bg-emerald-400/10 px-3 py-2'><span class='text-emerald-300'><svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round' class='h-6 w-6' aria-hidden='true'><path d='M3 4h2l2.4 11.2a1 1 0 0 0 1 .8h9.2a1 1 0 0 0 1-.8L20 8H6.2M9 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm8 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2z'/></svg></span><div><p class='text-xs font-semibold text-white'>Commerce Pro</p><p class='text-[0.6rem] text-slate-400'>Products, checkout, taxes, shipping.</p></div></div><div class='flex items-center gap-2 rounded-xl border border-violet-400/40 bg-violet-400/10 px-3 py-2'><span class='text-violet-300'><svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round' class='h-6 w-6' aria-hidden='true'><path d='M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z'/></svg></span><div><p class='text-xs font-semibold text-white'>Cortex AI</p><p class='text-[0.6rem] text-slate-400'>AI in the editor + MCP server. 30-day free trial.</p></div></div></div></div><p class='mt-3 text-xs text-slate-400'>The core CMS is free and open source. Modules switch on with a license and use the same blocks and editor.</p></div></div></div><div class='mt-6 flex flex-wrap items-center justify-center gap-2'><span class='rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.15em] text-slate-300'>Next.js 16</span><span class='rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.15em] text-slate-300'>Supabase</span><span class='rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.15em] text-slate-300'>Tiptap</span><span class='rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.15em] text-slate-300'>Tailwind</span><span class='rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.15em] text-slate-300'>Nx</span><span class='rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.15em] text-slate-300'>Git</span></div><p class='mt-6 rounded-2xl border border-cyan-400/30 bg-slate-950/80 px-4 py-4 text-center text-base font-bold uppercase tracking-[0.12em] text-white sm:text-lg'>One visual system. CMS, editor, and unlimited extensibility.</p></div></div>$nbdiag_en$))),
           updated_at = now()
     WHERE post_id = v_post
       AND block_type = 'text'
       AND content->>'html_content' LIKE '%extensibility.webp%'
       AND position($nbfig_eng$<figure class='my-12 overflow-hidden rounded-[2rem] border border-slate-200/80 bg-slate-950 shadow-2xl dark:border-white/10'>
  <img src='/images/extensibility.webp' alt='NextBlock™ extensibility artwork showing the CMS connected to reusable modules and integrations' class='w-full h-auto object-cover' />
  <figcaption class='border-t border-white/10 px-6 py-4 text-sm text-slate-300'>One unified design system spans content blocks, editing tools, and store features.</figcaption>
</figure>$nbfig_eng$ in content->>'html_content') > 0;
  END IF;

  SELECT id INTO v_post FROM public.posts WHERE slug = 'comment-nextblock-fonctionne' AND language_id = v_fr ORDER BY id LIMIT 1;
  IF v_post IS NOT NULL THEN
    UPDATE public.blocks
       SET content = jsonb_set(content, '{html_content}', to_jsonb(replace(content->>'html_content', $nbfig_fr$<figure class='my-12 overflow-hidden rounded-[2rem] border border-slate-200/80 bg-slate-950 shadow-2xl dark:border-white/10'>
  <img src='/images/extensibility.webp' alt='Illustration NextBlock montrant les connexions entre le CMS et les modules externes' class='w-full h-auto object-cover' />
  <figcaption class='border-t border-white/10 px-6 py-4 text-sm text-slate-300'>Un même système visuel réunit la gestion de contenu, l'édition et les modules du store.</figcaption>
</figure>$nbfig_fr$, $nbdiag_fr$<div class='not-prose my-12 overflow-hidden rounded-[2rem] border border-slate-800 shadow-2xl'><div class='bg-gradient-to-b from-[#020817] via-[#0b1a3a] to-[#0f172a] p-6 sm:p-8'><p class='text-center text-[0.65rem] font-semibold uppercase tracking-[0.3em] text-cyan-300'>Cœur de la plateforme NB</p><div class='mx-auto mt-4 flex h-28 w-28 items-center justify-center rounded-full border border-cyan-400/40 bg-cyan-400/10 shadow-[0_0_70px_rgba(34,211,238,0.28)]'><img src='/images/nextblock-logo-small.webp' alt='Logo NextBlock au centre du cœur de la plateforme' class='h-16 w-16 object-contain' /></div><p class='mt-3 text-center text-sm font-bold text-white'>Une seule app Next.js 16 sur Supabase</p><div class='mx-auto h-8 w-px bg-cyan-400/40'></div><div class='relative'><div class='absolute left-[12.5%] right-[12.5%] top-0 h-px bg-cyan-400/30'></div><div class='grid grid-cols-2 gap-3 md:grid-cols-4'><div class='flex flex-col items-center'><div class='h-6 w-px bg-cyan-400/40'></div><div class='flex w-full flex-col items-center rounded-2xl border border-cyan-400/30 bg-white/5 px-3 py-4 text-center'><span class='flex h-11 w-11 items-center justify-center rounded-xl border border-cyan-400/40 bg-cyan-400/10 text-cyan-300'><svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round' class='h-6 w-6' aria-hidden='true'><path d='M3 4h2l2.4 11.2a1 1 0 0 0 1 .8h9.2a1 1 0 0 0 1-.8L20 8H6.2M9 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm8 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2z'/></svg></span><span class='mt-3 text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-slate-100'>Commerce</span></div></div><div class='flex flex-col items-center'><div class='h-6 w-px bg-cyan-400/40'></div><div class='flex w-full flex-col items-center rounded-2xl border border-cyan-400/30 bg-white/5 px-3 py-4 text-center'><span class='flex h-11 w-11 items-center justify-center rounded-xl border border-cyan-400/40 bg-cyan-400/10 text-cyan-300'><svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round' class='h-6 w-6' aria-hidden='true'><path d='M13 2 4 14h7l-1 8 9-12h-7l1-8z'/></svg></span><span class='mt-3 text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-slate-100'>Performance</span></div></div><div class='flex flex-col items-center'><div class='h-6 w-px bg-cyan-400/40'></div><div class='flex w-full flex-col items-center rounded-2xl border border-cyan-400/30 bg-white/5 px-3 py-4 text-center'><span class='flex h-11 w-11 items-center justify-center rounded-xl border border-cyan-400/40 bg-cyan-400/10 text-cyan-300'><svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round' class='h-6 w-6' aria-hidden='true'><path d='M4 20V11M10 20V4M16 20v-7M2 20h20'/></svg></span><span class='mt-3 text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-slate-100'>Analytique</span></div></div><div class='flex flex-col items-center'><div class='h-6 w-px bg-cyan-400/40'></div><div class='flex w-full flex-col items-center rounded-2xl border border-cyan-400/30 bg-white/5 px-3 py-4 text-center'><span class='flex h-11 w-11 items-center justify-center rounded-xl border border-cyan-400/40 bg-cyan-400/10 text-cyan-300'><svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round' class='h-6 w-6' aria-hidden='true'><path d='M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1'/></svg></span><span class='mt-3 text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-slate-100'>API et intégrations</span></div></div></div></div><div class='mt-8 flex items-center gap-3'><span class='h-px flex-1 bg-cyan-400/30'></span><span class='rounded-full border border-cyan-400/40 bg-slate-950 px-4 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.3em] text-cyan-200'>Architecture unifiée</span><span class='h-px flex-1 bg-cyan-400/30'></span></div><div class='mt-4 grid gap-4 md:grid-cols-3'><div class='flex flex-col rounded-2xl border border-cyan-400/20 bg-slate-950/70 p-4'><p class='text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-cyan-300'>CMS et modélisation du contenu</p><div class='mt-3 flex-1'><div class='flex items-center justify-center gap-2'><div class='space-y-1.5'><span class='block rounded-md border border-slate-600/70 bg-slate-900 px-2.5 py-1 text-center font-mono text-[0.65rem] text-slate-200'>page</span><span class='block rounded-md border border-slate-600/70 bg-slate-900 px-2.5 py-1 text-center font-mono text-[0.65rem] text-slate-200'>article</span><span class='block rounded-md border border-slate-600/70 bg-slate-900 px-2.5 py-1 text-center font-mono text-[0.65rem] text-slate-200'>produit</span></div><span class='h-px w-4 bg-cyan-400/50'></span><div class='rounded-xl border border-cyan-400/40 bg-cyan-400/10 px-3 py-2 text-center'><p class='text-[0.55rem] uppercase tracking-[0.2em] text-cyan-300'>PostgreSQL</p><p class='text-xs font-semibold text-white'>Blocs JSONB</p></div><span class='h-px w-4 bg-cyan-400/50'></span><div class='space-y-1.5'><span class='block rounded-md border border-slate-600/70 bg-slate-900 px-2.5 py-1 text-center font-mono text-[0.65rem] text-slate-200'>bloc</span><span class='block rounded-md border border-slate-600/70 bg-slate-900 px-2.5 py-1 text-center font-mono text-[0.65rem] text-slate-200'>révision</span><span class='block rounded-md border border-slate-600/70 bg-slate-900 px-2.5 py-1 text-center font-mono text-[0.65rem] text-slate-200'>brouillon</span></div></div><p class='mt-3 text-xs text-slate-400'>Chaque page, article et produit est une liste de blocs typés. Un schéma Zod par bloc garde les données valides.</p></div></div><div class='flex flex-col rounded-2xl border border-cyan-400/20 bg-slate-950/70 p-4'><p class='text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-cyan-300'>Éditeur en direct et publication</p><div class='mt-3 flex-1'><div class='overflow-hidden rounded-xl border border-slate-700 bg-slate-900'><div class='flex items-center gap-1.5 border-b border-white/10 px-3 py-2'><span class='h-2 w-2 rounded-full bg-red-400/70'></span><span class='h-2 w-2 rounded-full bg-yellow-400/70'></span><span class='h-2 w-2 rounded-full bg-green-400/70'></span><span class='ml-2 truncate font-mono text-[0.6rem] text-slate-400'>cms/pages/accueil</span></div><div class='flex gap-2 p-3'><div class='w-10 space-y-1.5'><span class='block h-1.5 rounded-full bg-slate-700 w-full'></span><span class='block h-1.5 rounded-full bg-slate-700 w-3/4'></span><span class='block h-1.5 rounded-full bg-slate-700 w-full'></span><span class='block h-1.5 rounded-full bg-slate-700 w-1/2'></span></div><div class='flex-1 rounded-lg border border-dashed border-cyan-400/40 bg-cyan-400/5 p-2'><p class='text-[0.6rem] font-semibold text-cyan-200'>Aperçu en direct</p><div class='mt-1.5 space-y-1.5'><span class='block h-1.5 rounded-full bg-slate-600 w-11/12'></span><span class='block h-1.5 rounded-full bg-slate-600 w-2/3'></span><span class='block h-1.5 rounded-full bg-slate-600 w-4/5'></span></div></div></div><div class='flex items-center justify-between border-t border-white/10 px-3 py-2'><span class='rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[0.6rem] font-semibold text-amber-200'>Brouillon</span><span class='rounded-md bg-cyan-400 px-2.5 py-1 text-[0.6rem] font-bold text-slate-950'>Publier</span></div></div><p class='mt-3 text-xs text-slate-400'>Les éditeurs écrivent dans un éditeur de type Notion, avec brouillons et révisions. La mise en ligne lit PostgreSQL en direct. Pas de build, pas d'attente.</p></div></div><div class='flex flex-col rounded-2xl border border-cyan-400/20 bg-slate-950/70 p-4'><p class='text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-cyan-300'>Modules premium</p><div class='mt-3 flex-1'><div class='flex items-center gap-2'><span class='shrink-0 rounded-md border border-cyan-400/40 bg-cyan-400/10 px-2 py-1 text-[0.6rem] font-semibold uppercase tracking-[0.15em] text-cyan-200'>Module</span><span class='h-px w-4 bg-cyan-400/50'></span><div class='flex-1 space-y-2'><div class='flex items-center gap-2 rounded-xl border border-emerald-400/40 bg-emerald-400/10 px-3 py-2'><span class='text-emerald-300'><svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round' class='h-6 w-6' aria-hidden='true'><path d='M3 4h2l2.4 11.2a1 1 0 0 0 1 .8h9.2a1 1 0 0 0 1-.8L20 8H6.2M9 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm8 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2z'/></svg></span><div><p class='text-xs font-semibold text-white'>Commerce Pro</p><p class='text-[0.6rem] text-slate-400'>Produits, paiement, taxes, livraison.</p></div></div><div class='flex items-center gap-2 rounded-xl border border-violet-400/40 bg-violet-400/10 px-3 py-2'><span class='text-violet-300'><svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round' class='h-6 w-6' aria-hidden='true'><path d='M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z'/></svg></span><div><p class='text-xs font-semibold text-white'>Cortex AI</p><p class='text-[0.6rem] text-slate-400'>IA dans l'éditeur + serveur MCP. Essai gratuit de 30 jours.</p></div></div></div></div><p class='mt-3 text-xs text-slate-400'>Le cœur du CMS est gratuit et open source. Les modules s'activent avec une licence. Ils utilisent les mêmes blocs et le même éditeur.</p></div></div></div><div class='mt-6 flex flex-wrap items-center justify-center gap-2'><span class='rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.15em] text-slate-300'>Next.js 16</span><span class='rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.15em] text-slate-300'>Supabase</span><span class='rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.15em] text-slate-300'>Tiptap</span><span class='rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.15em] text-slate-300'>Tailwind</span><span class='rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.15em] text-slate-300'>Nx</span><span class='rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.15em] text-slate-300'>Git</span></div><p class='mt-6 rounded-2xl border border-cyan-400/30 bg-slate-950/80 px-4 py-4 text-center text-base font-bold uppercase tracking-[0.12em] text-white sm:text-lg'>Un seul système visuel. CMS, éditeur et extensibilité sans limite.</p></div></div>$nbdiag_fr$))),
           updated_at = now()
     WHERE post_id = v_post
       AND block_type = 'text'
       AND content->>'html_content' LIKE '%extensibility.webp%'
       AND position($nbfig_frg$<figure class='my-12 overflow-hidden rounded-[2rem] border border-slate-200/80 bg-slate-950 shadow-2xl dark:border-white/10'>
  <img src='/images/extensibility.webp' alt='Illustration NextBlock montrant les connexions entre le CMS et les modules externes' class='w-full h-auto object-cover' />
  <figcaption class='border-t border-white/10 px-6 py-4 text-sm text-slate-300'>Un même système visuel réunit la gestion de contenu, l'édition et les modules du store.</figcaption>
</figure>$nbfig_frg$ in content->>'html_content') > 0;
  END IF;
END
$body$;
$nb_file_00000000000042$;
  ELSE
    RAISE NOTICE 'catch-up: 00000000000042_how_nextblock_works_css_diagram.sql already recorded, skipped';
  END IF;
  -- <<< END: 00000000000042_how_nextblock_works_css_diagram.sql

  -- Caught up: record the generation so this file never replays anything again.
  INSERT INTO public.site_settings (key, value) VALUES ('migration_baseline_generation', '2'::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
END $nb_catchup$;

DROP FUNCTION IF EXISTS pg_temp.nb_recorded(text, text);
