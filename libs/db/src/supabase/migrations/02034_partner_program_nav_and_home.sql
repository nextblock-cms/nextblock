-- 02034: tell visitors the partner program is open. Adds a "Become a partner" link to the header,
-- a "Partner program" link to the footer, and a home-page section that promotes the partner
-- program and the Affiliates & Creator Storefronts module. English and Quebec French ship together.
--
-- 1. Navigation rows (HEADER and FOOTER, EN and FR).
--    - Each menu has one fixed translation group, shared by its EN and FR rows (as the seeded footer
--      links are), so the CMS language switcher pairs them and a CMS delete removes both languages.
--      The two group ids are mirrored in apps/nextblock/lib/affiliates/partner-program-nav.ts, which
--      styles the header row as a highlighted pill and gives both rows a "New" badge;
--      partner-program-nav.test.ts pins the ids, URLs and labels to this file.
--    - Insert-only. A row is skipped when its language already has a row in that group, or when the
--      same menu already links /partners or /partenaires in that language. Nothing is updated or
--      deleted, so a label, order or deletion an operator chose in /cms/navigation stands.
--    - Languages are looked up by code, and a missing language is skipped. page_id is NULL: the
--      program's addresses are app routes, not CMS pages. Each row goes after the last top-level
--      item of its menu.
--    - The rows ship to every install, and the root layout (app/layout.tsx) hides both groups, and
--      anything nested under them, while the program is inactive (isAffiliatesProgramActive():
--      the Affiliates package AND Commerce Pro), so a site without the program never shows a link
--      that would 404. Operators still see the rows in /cms/navigation, where they can edit or
--      delete them.
--
-- 2. Home section (EN page 'home', FR page 'accueil'), inserted right after the seeded Cortex AI
--    section, which is found by content signature (never by id or position). A home page without
--    that section (a customized home) is left alone, and so is one that already holds the sentinel
--    class 'nb-partner-program'. Later blocks move down by one, so their relative order is kept.
--    Like the other seeded promos (the Cortex AI and Commerce sections), the buttons use absolute
--    https://nextblock.dev links, so they work on every install whether or not it runs the program
--    itself. No prices (they go stale) and no images.
--
-- Forward-only, idempotent and non-destructive: a re-run finds the rows and the sentinel and does
-- nothing. The identity sequences only ever move forward (the 02018 form). This file writes no UI
-- strings: the badge key nav.badge_new is seeded by the 02031 generator, from
-- apps/nextblock/lib/i18n/global-affiliate-keys.ts.

DO $partner_nav$
DECLARE
  c_header_group constant uuid := 'e130cf70-04d2-4201-ba44-f8ac22fc071b';
  c_footer_group constant uuid := '78a4685e-c6ee-4065-9e8b-b257887256f9';
  r record;
BEGIN
  -- The seed inserts explicit ids. Only ever move the sequence forward: rewinding it would hand a
  -- deleted row's id to this insert, or collide with a concurrent CMS insert on a live site.
  PERFORM setval('public.navigation_items_id_seq',
    GREATEST(COALESCE((SELECT MAX(id) FROM public.navigation_items), 1),
             (SELECT last_value FROM public.navigation_items_id_seq)), true);

  FOR r IN
    SELECT l.id AS language_id, x.menu_key, x.group_id, x.label, x.url
      FROM (VALUES
        ('en', 'HEADER'::public.menu_location, c_header_group, 'Become a partner', '/partners'),
        ('fr', 'HEADER'::public.menu_location, c_header_group, 'Devenir partenaire', '/partenaires'),
        ('en', 'FOOTER'::public.menu_location, c_footer_group, 'Partner program', '/partners'),
        ('fr', 'FOOTER'::public.menu_location, c_footer_group, 'Programme de partenaires', '/partenaires')
      ) AS x (code, menu_key, group_id, label, url)
      JOIN public.languages AS l ON l.code = x.code
  LOOP
    -- Already there (this group in this language), or the menu already links the program.
    CONTINUE WHEN EXISTS (
      SELECT 1
        FROM public.navigation_items AS n
       WHERE n.language_id = r.language_id
         AND (n.translation_group_id = r.group_id
              OR (n.menu_key = r.menu_key
                  AND rtrim(lower(btrim(n.url)), '/') IN ('/partners', '/partenaires')))
    );

    INSERT INTO public.navigation_items
      (language_id, menu_key, label, url, parent_id, "order", page_id, translation_group_id)
    SELECT r.language_id, r.menu_key, r.label, r.url, NULL,
           COALESCE(MAX(n."order"), -1) + 1, NULL, r.group_id
      FROM public.navigation_items AS n
     WHERE n.menu_key = r.menu_key
       AND n.language_id = r.language_id
       AND n.parent_id IS NULL;
  END LOOP;
END
$partner_nav$;

DO $partner_home$
DECLARE
  r record;
  v_page bigint;
  v_lang bigint;
  v_anchor integer;
BEGIN
  PERFORM setval('public.blocks_id_seq',
    GREATEST(COALESCE((SELECT MAX(id) FROM public.blocks), 1),
             (SELECT last_value FROM public.blocks_id_seq)), true);

  FOR r IN
    SELECT *
      FROM (VALUES
        ('en', 'home', '%Now Available — Cortex AI%', '%Cortex AI Is the%',
         $en${"padding":{"top":"xl","bottom":"xl"},"background":{"type":"gradient","gradient":{"type":"linear","stops":[{"color":"#0c1a3d","position":0},{"color":"#172554","position":50},{"color":"#0f172a","position":100}],"direction":"135deg"}},"column_gap":"xl","column_blocks":[[{"content":{"html_content":"<div class='nb-partner-program'><p class='text-xs uppercase tracking-[0.3em] text-amber-300 font-semibold mb-4'>New — Partner Program Now Open</p><h2 class='text-4xl md:text-5xl font-bold text-white mb-6 leading-tight'>Share NextBlock.<br/>Earn 50% on Every Sale.</h2><p class='text-lg text-slate-300 max-w-2xl leading-relaxed mb-4'>Our partner program is open. Founding Ambassadors earn 50% of every sale they refer, on all three premium modules: Commerce Pro, Cortex AI, and the new Affiliates & Creator Storefronts. Founding spots are capped at 50.</p><p class='text-base text-slate-400 max-w-2xl leading-relaxed'>Want the same program for your own store? NextBlock™ Affiliates & Creator Storefronts adds partner sign-up, approved storefronts, commission tiers, and automatic Stripe payouts to Commerce Pro. Try it free for 30 days, no credit card.</p></div>"},"block_type":"text"},{"content":{"url":"https://nextblock.dev/partners","size":"lg","text":"Become a Partner →","variant":"default","position":"left"},"block_type":"button"},{"content":{"url":"https://nextblock.dev/product/nextblock-affiliates-creator-storefronts-affiliates-license","size":"lg","text":"Get the Affiliates Module","variant":"outline","position":"left"},"block_type":"button"}],[{"content":{"html_content":"<div class='grid grid-cols-1 gap-4 sm:grid-cols-3 lg:grid-cols-1'><div class='rounded-2xl border border-amber-400/30 bg-white/5 p-6 text-center'><p class='text-3xl font-extrabold text-white'>50%</p><p class='text-xs uppercase tracking-wider text-amber-100 mt-1'>Founding commission</p></div><div class='rounded-2xl border border-amber-400/30 bg-white/5 p-6 text-center'><p class='text-3xl font-extrabold text-white'>3</p><p class='text-xs uppercase tracking-wider text-amber-100 mt-1'>Premium modules to sell</p></div><div class='rounded-2xl border border-amber-400/30 bg-white/5 p-6 text-center'><p class='text-3xl font-extrabold text-white'>30</p><p class='text-xs uppercase tracking-wider text-amber-100 mt-1'>Day referral window</p></div></div>"},"block_type":"text"}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":2},"vertical_alignment":"center"}$en$),
        ('fr', 'accueil', '%Maintenant disponible — Cortex AI%', '%Cortex AI est la mise%',
         $fr${"padding":{"top":"xl","bottom":"xl"},"background":{"type":"gradient","gradient":{"type":"linear","stops":[{"color":"#0c1a3d","position":0},{"color":"#172554","position":50},{"color":"#0f172a","position":100}],"direction":"135deg"}},"column_gap":"xl","column_blocks":[[{"content":{"html_content":"<div class='nb-partner-program'><p class='text-xs uppercase tracking-[0.3em] text-amber-300 font-semibold mb-4'>Nouveau — le programme de partenaires est ouvert</p><h2 class='text-4xl md:text-5xl font-bold text-white mb-6 leading-tight'>Recommandez NextBlock.<br/>Gagnez 50 % sur chaque vente.</h2><p class='text-lg text-slate-300 max-w-2xl leading-relaxed mb-4'>Notre programme de partenaires est ouvert. Les ambassadeurs fondateurs touchent 50 % de chaque vente qu'ils recommandent, sur les trois modules premium : Commerce Pro, Cortex AI et le nouveau module Affiliates & Creator Storefronts. Les places fondatrices sont limitées à 50.</p><p class='text-base text-slate-400 max-w-2xl leading-relaxed'>Vous voulez le même programme pour votre boutique? NextBlock™ Affiliates & Creator Storefronts ajoute à Commerce Pro l'inscription des partenaires, des vitrines approuvées, des niveaux de commission et des versements Stripe automatiques. Essayez-le gratuitement pendant 30 jours, sans carte de crédit.</p></div>"},"block_type":"text"},{"content":{"url":"https://nextblock.dev/partenaires","size":"lg","text":"Devenir partenaire →","variant":"default","position":"left"},"block_type":"button"},{"content":{"url":"https://nextblock.dev/product/nextblock-affiliates-creator-storefronts-affiliates-license-fr","size":"lg","text":"Obtenir le module Affiliates","variant":"outline","position":"left"},"block_type":"button"}],[{"content":{"html_content":"<div class='grid grid-cols-1 gap-4 sm:grid-cols-3 lg:grid-cols-1'><div class='rounded-2xl border border-amber-400/30 bg-white/5 p-6 text-center'><p class='text-3xl font-extrabold text-white'>50 %</p><p class='text-xs uppercase tracking-wider text-amber-100 mt-1'>Commission fondatrice</p></div><div class='rounded-2xl border border-amber-400/30 bg-white/5 p-6 text-center'><p class='text-3xl font-extrabold text-white'>3</p><p class='text-xs uppercase tracking-wider text-amber-100 mt-1'>Modules premium à vendre</p></div><div class='rounded-2xl border border-amber-400/30 bg-white/5 p-6 text-center'><p class='text-3xl font-extrabold text-white'>30</p><p class='text-xs uppercase tracking-wider text-amber-100 mt-1'>Jours de fenêtre de recommandation</p></div></div>"},"block_type":"text"}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":2},"vertical_alignment":"center"}$fr$)
      ) AS t (code, slug, anchor, anchor_fallback, body)
  LOOP
    SELECT p.id, p.language_id
      INTO v_page, v_lang
      FROM public.pages AS p
      JOIN public.languages AS l ON l.id = p.language_id
     WHERE p.slug = r.slug
       AND l.code = r.code
     ORDER BY p.id
     LIMIT 1;
    CONTINUE WHEN v_page IS NULL;

    -- Already promoted: a re-run, or the section is there and an operator kept or edited it.
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM public.blocks
       WHERE page_id = v_page
         AND content::text LIKE '%nb-partner-program%'
    );

    SELECT MAX(b."order") INTO v_anchor
      FROM public.blocks AS b
     WHERE b.page_id = v_page
       AND b.block_type = 'section'
       AND b.content::text LIKE r.anchor;
    IF v_anchor IS NULL THEN
      SELECT MAX(b."order") INTO v_anchor
        FROM public.blocks AS b
       WHERE b.page_id = v_page
         AND b.block_type = 'section'
         AND b.content::text LIKE r.anchor_fallback;
    END IF;
    -- No seeded Cortex AI section: a customized home page, left exactly as the operator built it.
    CONTINUE WHEN v_anchor IS NULL;

    UPDATE public.blocks
       SET "order" = "order" + 1,
           updated_at = now()
     WHERE page_id = v_page
       AND "order" > v_anchor;

    INSERT INTO public.blocks (page_id, language_id, block_type, content, "order")
    VALUES (v_page, v_lang, 'section', replace(r.body, chr(13), '')::jsonb, v_anchor + 1);
  END LOOP;
END
$partner_home$;
