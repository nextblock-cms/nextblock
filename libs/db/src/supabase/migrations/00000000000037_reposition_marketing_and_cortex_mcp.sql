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
