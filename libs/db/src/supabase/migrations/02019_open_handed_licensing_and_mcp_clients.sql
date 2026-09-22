-- 02019: open-handed licensing copy and accurate MCP client names, EN + FR. Copy only; no schema.
--
-- * Licensing. The home page (EN 'home' / FR 'accueil') said Cortex AI is "the one paid license",
--   "the only paid add-on" and "the one license we sell", while the same page sells Commerce Pro.
--   It now says what is true and leaves room for more: the CMS is free and open source; Cortex AI
--   and Commerce Pro are optional premium modules, each with a 30-day free trial, and more may
--   follow. The Commerce promo gains its trial line (FR also stops calling products "articles").
-- * MCP clients. /api/mcp authenticates with a static bearer token and has no OAuth. The ChatGPT
--   web chat and the Gemini app only add OAuth (or no-auth) servers, so they cannot connect;
--   Codex (OpenAI's agent, included with ChatGPT plans), Claude Code, Cursor and VS Code can. The
--   home page and the MCP guide ('cortex-ai-mcp-connection-guide' / 'guide-connexion-mcp-cortex-ai')
--   now name those, the guide says why the chat apps cannot connect, and it lists the CMS card's
--   new Codex tab. "One JSON block" becomes "one config entry" (Codex's config is TOML).
-- * Cortex AI license product (nextblock.dev only; see the section at the end).
--
-- How: the fragment queue of 02018, all or nothing per post/page: an item is rewritten only if
-- every seeded fragment is still present, together with its revision snapshots. Items that point
-- at the install guide's Option 5 require it. Carriage returns are stripped from every
-- replacement. Idempotent: a second run finds nothing to replace.
--
-- NOTE: keep the word "sandbox" OUT of this filename -- generate-sandbox-reset.ts excludes any
-- migration whose filename contains "sandbox" from the reset bundle.

-- JSON-escapes a raw HTML fragment exactly as Postgres prints it inside content::text, so a
-- fragment written below as plain HTML matches the stored jsonb text form. Carriage returns are
-- dropped first: a Windows checkout can hand this file over with CRLF endings, and the stored
-- copy must be LF on every install.
CREATE OR REPLACE FUNCTION pg_temp.nb_02019_json_inner(src text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT substr(to_jsonb(replace(src, chr(13), ''))::text, 2,
                length(to_jsonb(replace(src, chr(13), ''))::text) - 2)
$fn$;

DROP TABLE IF EXISTS pg_temp.nb_02019_edits;
CREATE TEMP TABLE nb_02019_edits (
  seq bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('post', 'page', 'product')),
  slug text NOT NULL,
  lang text NOT NULL,
  old_html text NOT NULL,
  new_html text NOT NULL,
  unless_html text
);

DROP TABLE IF EXISTS pg_temp.nb_02019_fields;
CREATE TEMP TABLE nb_02019_fields (
  seq bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('post', 'page', 'product')),
  slug text NOT NULL,
  lang text NOT NULL,
  field text NOT NULL CHECK (field IN ('title', 'label', 'excerpt', 'subtitle', 'meta_title', 'meta_description')),
  old_value text NOT NULL,
  new_value text NOT NULL
);

-- Applies every queued edit of one post, page or product, all or nothing. The edits are
-- replayed in order against the item's blocks in memory; only if every one of them finds its
-- seeded fragment are the blocks written back, followed by the same fragments in the revision
-- snapshots and the queued fields (row + snapshot meta, each only while it still holds the
-- seeded value). An item an operator has edited, even by re-saving it in the editor (which
-- re-serialises the HTML), is left untouched as a whole, so it never ends up half old, half
-- new. A second run finds nothing to replace and is a no-op.
-- p_needs_agent_guide: the item points readers at the install guide's Option 5
-- (#ai-agent); it is rewritten only if that guide, in the same language, has the section.
CREATE OR REPLACE FUNCTION pg_temp.nb_02019_item(
  p_kind text, p_slug text, p_lang text, p_needs_agent_guide boolean)
RETURNS boolean
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_table text := CASE p_kind WHEN 'post' THEN 'posts' WHEN 'page' THEN 'pages' ELSE 'products' END;
  v_fk text := CASE p_kind WHEN 'post' THEN 'post_id' WHEN 'page' THEN 'page_id' ELSE 'product_id' END;
  v_revisions text := CASE p_kind WHEN 'post' THEN 'post_revisions' WHEN 'page' THEN 'page_revisions' ELSE 'product_revisions' END;
  v_parent text;
  v_ids bigint[];
  v_texts text[];
  v_guide_slug text := CASE WHEN p_lang = 'fr' THEN 'comment-configurer-nextblock' ELSE 'how-to-setup-nextblock' END;
  v_marker text := pg_temp.nb_02019_json_inner('<h2 id=''ai-agent''>');
  e record;
  f record;
  i int;
  v_hit boolean;
  v_total int := 0;
  v_missing int := 0;
  v_old text;
  v_new text;
  v_unless text;
BEGIN
  EXECUTE format(
    'SELECT p.id::text FROM public.%I AS p JOIN public.languages AS l ON l.id = p.language_id
      WHERE p.slug = $1 AND l.code = $2 ORDER BY p.id LIMIT 1', v_table)
    INTO v_parent USING p_slug, p_lang;
  IF v_parent IS NULL THEN
    RETURN false;
  END IF;

  IF p_needs_agent_guide AND NOT EXISTS (
       SELECT 1 FROM public.blocks AS b
         JOIN public.posts AS p ON p.id = b.post_id
         JOIN public.languages AS l ON l.id = p.language_id
        WHERE p.slug = v_guide_slug AND l.code = p_lang
          AND position(v_marker IN b.content::text) > 0) THEN
    RAISE NOTICE '02019: % % (%) left unchanged: the install guide has no Option 5 section.', p_kind, p_slug, p_lang;
    RETURN false;
  END IF;

  EXECUTE format(
    'SELECT array_agg(b.id ORDER BY b.id), array_agg(b.content::text ORDER BY b.id)
       FROM public.blocks AS b WHERE b.%I::text = $1', v_fk)
    INTO v_ids, v_texts USING v_parent;

  FOR e IN SELECT * FROM pg_temp.nb_02019_edits
            WHERE kind = p_kind AND slug = p_slug AND lang = p_lang ORDER BY seq LOOP
    v_total := v_total + 1;
    v_hit := false;
    v_old := pg_temp.nb_02019_json_inner(e.old_html);
    v_new := pg_temp.nb_02019_json_inner(e.new_html);
    v_unless := CASE WHEN e.unless_html IS NULL THEN NULL ELSE pg_temp.nb_02019_json_inner(e.unless_html) END;
    FOR i IN 1 .. COALESCE(array_length(v_ids, 1), 0) LOOP
      IF position(v_old IN v_texts[i]) > 0 AND (v_unless IS NULL OR position(v_unless IN v_texts[i]) = 0) THEN
        v_texts[i] := replace(v_texts[i], v_old, v_new);
        v_hit := true;
      END IF;
    END LOOP;
    IF NOT v_hit THEN
      v_missing := v_missing + 1;
    END IF;
  END LOOP;

  IF v_total = 0 OR v_missing > 0 THEN
    IF v_missing < v_total THEN
      RAISE NOTICE '02019: % % (%) differs from the seeded copy (% of % fragments not found); left unchanged.',
        p_kind, p_slug, p_lang, v_missing, v_total;
    END IF;
    RETURN false;
  END IF;

  FOR i IN 1 .. array_length(v_ids, 1) LOOP
    UPDATE public.blocks SET content = v_texts[i]::jsonb, updated_at = now()
     WHERE id = v_ids[i] AND content::text IS DISTINCT FROM v_texts[i];
  END LOOP;

  FOR e IN SELECT * FROM pg_temp.nb_02019_edits
            WHERE kind = p_kind AND slug = p_slug AND lang = p_lang ORDER BY seq LOOP
    v_old := pg_temp.nb_02019_json_inner(e.old_html);
    v_new := pg_temp.nb_02019_json_inner(e.new_html);
    v_unless := CASE WHEN e.unless_html IS NULL THEN NULL ELSE pg_temp.nb_02019_json_inner(e.unless_html) END;
    EXECUTE format(
      'UPDATE public.%I SET content = replace(content::text, $1, $2)::jsonb
        WHERE %I::text = $3 AND position($1 IN content::text) > 0
          AND ($4::text IS NULL OR position($4 IN content::text) = 0)', v_revisions, v_fk)
      USING v_old, v_new, v_parent, v_unless;
  END LOOP;

  FOR f IN SELECT * FROM pg_temp.nb_02019_fields
            WHERE kind = p_kind AND slug = p_slug AND lang = p_lang ORDER BY seq LOOP
    EXECUTE format('UPDATE public.%I SET %I = $1, updated_at = now() WHERE id::text = $2 AND %I = $3',
                   v_table, f.field, f.field)
      USING replace(f.new_value, chr(13), ''), v_parent, f.old_value;
    EXECUTE format('UPDATE public.%I SET content = jsonb_set(content, $1, to_jsonb($2::text))
                     WHERE %I::text = $3 AND revision_type = ''snapshot'' AND content #>> $1 = $4',
                   v_revisions, v_fk)
      USING ARRAY['meta', f.field], replace(f.new_value, chr(13), ''), v_parent, f.old_value;
  END LOOP;

  RETURN true;
END
$fn$;

-- ========================================================================================
-- copy
-- ========================================================================================

INSERT INTO pg_temp.nb_02019_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'home', 'en',
  $o$Add Cortex AI to point Claude Code, Cursor, or ChatGPT at your site over MCP, free for 30 days.$o$,
  $n$Add Cortex AI to point Claude Code, Cursor, or Codex at your site over MCP, free for 30 days.$n$,
  NULL);

INSERT INTO pg_temp.nb_02019_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'home', 'en',
  $o$Cortex AI, the paid AI layer that includes the MCP server, starts with a 30-day trial and no credit card.$o$,
  $n$Cortex AI, an optional premium module that includes the MCP server, starts with a 30-day trial and no credit card.$n$,
  NULL);

INSERT INTO pg_temp.nb_02019_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'home', 'en',
  $o$Cortex AI: 30 days free, no credit card, then one license.$o$,
  $n$Cortex AI: 30 days free, no credit card, then a license only if you keep it.$n$,
  NULL);

INSERT INTO pg_temp.nb_02019_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'home', 'en',
  $o$Connect Claude Code, Cursor, ChatGPT, or Gemini straight to /api/mcp.$o$,
  $n$Connect Claude Code, Codex, Cursor, or VS Code straight to /api/mcp.$n$,
  NULL);

INSERT INTO pg_temp.nb_02019_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'home', 'en',
  $o$Free and open source, forever. Cortex AI is the only paid add-on.$o$,
  $n$Free and open source, forever. Premium modules are optional, each with a 30-day free trial.$n$,
  NULL);

INSERT INTO pg_temp.nb_02019_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'home', 'en',
  $o$Cortex AI is the one paid license.$o$,
  $n$Cortex AI is an optional premium module.$n$,
  NULL);

INSERT INTO pg_temp.nb_02019_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'home', 'en',
  $o$Over MCP, Cortex AI runs on the Claude, ChatGPT, Cursor, or Gemini subscription you already pay for.$o$,
  $n$Over MCP, Cortex AI runs on the AI plan you already pay for, through Claude Code, Codex, or Cursor.$n$,
  NULL);

INSERT INTO pg_temp.nb_02019_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'home', 'en',
  $o$Mint a scoped token and paste one JSON block into Claude Code, Cursor, or VS Code.$o$,
  $n$Mint a scoped token and paste one config entry into Claude Code, Codex, Cursor, or VS Code.$n$,
  NULL);

INSERT INTO pg_temp.nb_02019_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'home', 'en',
  $o$Sell products, take payments, handle taxes, and ship orders — all from the block editor you already use.</p>$o$,
  $n$Sell products, take payments, handle taxes, and ship orders — all from the block editor you already use. Try it free for 30 days, no credit card.</p>$n$,
  NULL);

INSERT INTO pg_temp.nb_02019_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'home', 'en',
  $o$Cortex AI Is the Upgrade.$o$,
  $n$Cortex AI Is the AI Upgrade.$n$,
  NULL);

INSERT INTO pg_temp.nb_02019_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'home', 'en',
  $o$NextBlock costs nothing and never will. Cortex AI is the one license we sell. It adds AI inside the editor and an MCP server outside it, so Claude Code, Cursor, ChatGPT, and Gemini can build your site.$o$,
  $n$The NextBlock CMS costs nothing and never will. Cortex AI is one of our premium modules, alongside Commerce Pro, and more may follow. It adds AI inside the editor and an MCP server outside it, so Claude Code, Codex, Cursor, and VS Code can build your site.$n$,
  NULL);

INSERT INTO pg_temp.nb_02019_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'accueil', 'fr',
  $o$Ajoutez Cortex AI pour brancher Claude Code, Cursor ou ChatGPT sur votre site via MCP, gratuitement pendant 30 jours.$o$,
  $n$Ajoutez Cortex AI pour brancher Claude Code, Cursor ou Codex sur votre site via MCP, gratuitement pendant 30 jours.$n$,
  NULL);

INSERT INTO pg_temp.nb_02019_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'accueil', 'fr',
  $o$Cortex AI, la couche IA payante qui inclut le serveur MCP, commence par un essai de 30 jours sans carte de crédit.$o$,
  $n$Cortex AI, un module premium facultatif qui inclut le serveur MCP, commence par un essai de 30 jours sans carte de crédit.$n$,
  NULL);

INSERT INTO pg_temp.nb_02019_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'accueil', 'fr',
  $o$Cortex AI : 30 jours gratuits, sans carte de crédit, puis une seule licence.$o$,
  $n$Cortex AI : 30 jours gratuits, sans carte de crédit, puis une licence seulement si vous le gardez.$n$,
  NULL);

INSERT INTO pg_temp.nb_02019_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'accueil', 'fr',
  $o$Connectez Claude Code, Cursor, ChatGPT ou Gemini directement à /api/mcp.$o$,
  $n$Connectez Claude Code, Codex, Cursor ou VS Code directement à /api/mcp.$n$,
  NULL);

INSERT INTO pg_temp.nb_02019_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'accueil', 'fr',
  $o$Gratuit et open source, pour toujours. Cortex AI est le seul module payant.$o$,
  $n$Gratuit et open source, pour toujours. Les modules premium sont facultatifs, chacun avec un essai gratuit de 30 jours.$n$,
  NULL);

INSERT INTO pg_temp.nb_02019_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'accueil', 'fr',
  $o$Cortex AI est la seule licence payante. Elle commence par$o$,
  $n$Cortex AI est un module premium facultatif. Il commence par$n$,
  NULL);

INSERT INTO pg_temp.nb_02019_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'accueil', 'fr',
  $o$Via MCP, Cortex AI fonctionne avec l'abonnement Claude, ChatGPT, Cursor ou Gemini que vous payez déjà.$o$,
  $n$Via MCP, Cortex AI fonctionne avec le forfait IA que vous payez déjà, depuis Claude Code, Codex ou Cursor.$n$,
  NULL);

INSERT INTO pg_temp.nb_02019_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'accueil', 'fr',
  $o$Générez un jeton à portée limitée et collez un seul bloc JSON dans Claude Code, Cursor ou VS Code.$o$,
  $n$Générez un jeton à portée limitée et collez une seule entrée de configuration dans Claude Code, Codex, Cursor ou VS Code.$n$,
  NULL);

INSERT INTO pg_temp.nb_02019_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'accueil', 'fr',
  $o$Vendez des articles et recevez des paiements en ligne. Gérez vos taxes et vos envois dans l'éditeur que vous connaissez déjà.</p>$o$,
  $n$Vendez des produits et recevez des paiements en ligne. Gérez vos taxes et vos envois dans l'éditeur que vous connaissez déjà. Essayez-le gratuitement pendant 30 jours, sans carte de crédit.</p>$n$,
  NULL);

INSERT INTO pg_temp.nb_02019_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'accueil', 'fr',
  $o$Cortex AI est la mise à niveau.$o$,
  $n$Cortex AI est la mise à niveau IA.$n$,
  NULL);

INSERT INTO pg_temp.nb_02019_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'accueil', 'fr',
  $o$NextBlock ne coûte rien et ne coûtera jamais rien. Cortex AI est la seule licence que nous vendons. Elle ajoute l'IA dans l'éditeur et un serveur MCP à l'extérieur, pour que Claude Code, Cursor, ChatGPT et Gemini puissent bâtir votre site.$o$,
  $n$Le CMS NextBlock ne coûte rien et ne coûtera jamais rien. Cortex AI est l'un de nos modules premium, aux côtés de Commerce Pro, et d'autres pourraient suivre. Il ajoute l'IA dans l'éditeur et un serveur MCP à l'extérieur, pour que Claude Code, Codex, Cursor et VS Code puissent bâtir votre site.$n$,
  NULL);

INSERT INTO pg_temp.nb_02019_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'accueil', 'fr',
  $o$Essayez-la gratuitement pendant 30 jours, sans carte de crédit.$o$,
  $n$Essayez-le gratuitement pendant 30 jours, sans carte de crédit.$n$,
  NULL);

INSERT INTO pg_temp.nb_02019_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'cortex-ai-mcp-connection-guide', 'en',
  $o$Claude Code, Cursor, ChatGPT, and Gemini can then read your database schema, draft page layouts, and update navigation from their own chat window.$o$,
  $n$Claude Code, Codex, Cursor, and VS Code can then read your database schema, draft page layouts, and update navigation from their own chat window. The ChatGPT and Gemini chat apps only connect to servers that sign in with OAuth, which /api/mcp does not offer yet. Codex, included with ChatGPT plans, works today.$n$,
  NULL);

INSERT INTO pg_temp.nb_02019_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'cortex-ai-mcp-connection-guide', 'en',
  $o$text-slate-100'>ChatGPT</span>$o$,
  $n$text-slate-100'>Codex</span>$n$,
  NULL);

INSERT INTO pg_temp.nb_02019_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'cortex-ai-mcp-connection-guide', 'en',
  $o$text-slate-100'>Gemini</span>$o$,
  $n$text-slate-100'>VS Code</span>$n$,
  NULL);

INSERT INTO pg_temp.nb_02019_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'cortex-ai-mcp-connection-guide', 'en',
  $o$One JSON block in your client config registers the server.$o$,
  $n$One config entry in your client registers the server.$n$,
  NULL);

INSERT INTO pg_temp.nb_02019_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'cortex-ai-mcp-connection-guide', 'en',
  $o$Paste one JSON entry into Claude Code, Cursor, or VS Code.$o$,
  $n$Paste one config entry into Claude Code, Codex, Cursor, or VS Code.$n$,
  NULL);

INSERT INTO pg_temp.nb_02019_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'cortex-ai-mcp-connection-guide', 'en',
  $o$Claude Code (terminal), Claude Code in VS Code, Claude Desktop, Cursor, and VS Code (Copilot).$o$,
  $n$Claude Code (terminal), Claude Code in VS Code, Claude Desktop, Codex, Cursor, and VS Code (Copilot).$n$,
  NULL);

INSERT INTO pg_temp.nb_02019_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-connexion-mcp-cortex-ai', 'fr',
  $o$Claude Code, Cursor, ChatGPT et Gemini peuvent ensuite lire le schéma de votre base de données, ébaucher des mises en page et mettre à jour la navigation depuis leur propre fenêtre de clavardage.$o$,
  $n$Claude Code, Codex, Cursor et VS Code peuvent ensuite lire le schéma de votre base de données, ébaucher des mises en page et mettre à jour la navigation depuis leur propre fenêtre de clavardage. Les applications de clavardage ChatGPT et Gemini ne se connectent qu'aux serveurs qui s'authentifient par OAuth, ce que /api/mcp n'offre pas encore. Codex, inclus dans les forfaits ChatGPT, fonctionne dès aujourd'hui.$n$,
  NULL);

INSERT INTO pg_temp.nb_02019_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-connexion-mcp-cortex-ai', 'fr',
  $o$text-slate-100'>ChatGPT</span>$o$,
  $n$text-slate-100'>Codex</span>$n$,
  NULL);

INSERT INTO pg_temp.nb_02019_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-connexion-mcp-cortex-ai', 'fr',
  $o$text-slate-100'>Gemini</span>$o$,
  $n$text-slate-100'>VS Code</span>$n$,
  NULL);

INSERT INTO pg_temp.nb_02019_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-connexion-mcp-cortex-ai', 'fr',
  $o$Un seul bloc JSON dans la configuration de votre client enregistre le serveur.$o$,
  $n$Une seule entrée dans la configuration de votre client enregistre le serveur.$n$,
  NULL);

INSERT INTO pg_temp.nb_02019_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-connexion-mcp-cortex-ai', 'fr',
  $o$Collez une seule entrée JSON dans Claude Code, Cursor ou VS Code.$o$,
  $n$Collez une seule entrée de configuration dans Claude Code, Codex, Cursor ou VS Code.$n$,
  NULL);

INSERT INTO pg_temp.nb_02019_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-connexion-mcp-cortex-ai', 'fr',
  $o$Claude Desktop, Cursor et VS Code (Copilot).$o$,
  $n$Claude Desktop, Codex, Cursor et VS Code (Copilot).$n$,
  NULL);

-- ========================================================================================
-- Post and page fields (applied with their item, each only while it holds the seeded value)
-- ========================================================================================

-- ========================================================================================
-- Apply, item by item. Install guides first: items that point at Option 5 require it.
-- ========================================================================================

DO $nb_02019_items$
BEGIN
  PERFORM pg_temp.nb_02019_item('page', 'home', 'en', false);
  PERFORM pg_temp.nb_02019_item('page', 'accueil', 'fr', false);
  PERFORM pg_temp.nb_02019_item('post', 'cortex-ai-mcp-connection-guide', 'en', false);
  PERFORM pg_temp.nb_02019_item('post', 'guide-connexion-mcp-cortex-ai', 'fr', false);
END
$nb_02019_items$;

-- ==========================================================================================
-- Cortex AI license product (vendor-only rows: nextblock.dev has them, fresh installs do not, so
-- this is a no-op everywhere else). The EN sections still carry the 5 / 29 / "and 24 more" tool
-- counts, "the one license we sell" and ChatGPT/Gemini as MCP clients; the FR sections are an
-- older copy that predates the MCP server (GPT-4o switching, "< 2s", no trial, no meta). Both are
-- replaced wholesale with the copy in apps/nextblock/app/api/cron/reset-sandbox/cortex-product-copy.ts
-- (the sandbox reset re-inserts the same sections from that module after every reset), but only
-- while they still carry the shipped signature: a product the vendor rewrote is left alone.
-- ==========================================================================================

DO $nb_02019_products$
DECLARE
  v_id uuid;
  v_lang bigint;
BEGIN

  -- English
  v_id := NULL;
  SELECT p.id, p.language_id INTO v_id, v_lang
    FROM public.products AS p JOIN public.languages AS l ON l.id = p.language_id
   WHERE p.slug = 'nextblock-cortex-ai-cortex-ai-license' AND l.code = 'en'
   ORDER BY p.id LIMIT 1;
  IF v_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.blocks WHERE product_id = v_id AND content::text LIKE $t$%and 24 more%$t$)
       AND NOT EXISTS (SELECT 1 FROM public.blocks WHERE product_id = v_id AND content::text LIKE $t$%and 45 more%$t$) THEN
      DELETE FROM public.blocks WHERE product_id = v_id;
      INSERT INTO public.blocks (product_id, language_id, block_type, content, "order") VALUES
        (v_id, v_lang, 'section', $nbcx0en${"padding":{"top":"xl","bottom":"xl"},"background":{"type":"gradient","gradient":{"type":"linear","stops":[{"color":"#1e1b4b","position":0},{"color":"#312e81","position":35},{"color":"#0f172a","position":100}],"direction":"135deg"}},"column_gap":"xl","column_blocks":[[{"content":{"html_content":"<p class='text-xs uppercase tracking-[0.3em] text-violet-400 font-semibold mb-4'>MCP-Native AI Layer · 30-Day Free Trial</p><h2 class='text-3xl md:text-5xl font-extrabold text-white leading-tight mb-5'>Your CMS as a Cortex AI MCP Server.</h2><p class='text-base md:text-lg text-slate-200 leading-relaxed mb-4'>Cortex AI runs two ways. Inside the editor it runs on the OpenRouter model you choose, with your own key. Over MCP it turns NextBlock into a server that Claude Code, Cursor, VS Code, and Codex operate from their own chat.</p><p class='text-base text-slate-300 leading-relaxed mb-6'>The CMS is free and open source under the AGPL. Cortex AI is a premium module, like Commerce Pro, and it starts with a 30-day free trial and no credit card.</p>"},"block_type":"text"},{"content":{"url":"/article/cortex-ai-mcp-connection-guide","size":"lg","text":"Read the MCP Setup Guide →","variant":"default","position":"left"},"block_type":"button"}],[{"content":{"html_content":"<div class='rounded-2xl border border-violet-700 bg-slate-950 p-6 shadow-xl sm:p-8'><h3 class='text-lg font-bold text-white mb-5'>Bring Your Own AI Subscription</h3><ul class='space-y-4 text-sm leading-relaxed text-slate-300'><li class='flex items-start gap-3'><span class='flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold'>✓</span><span><strong class='text-white'>Free for 30 days</strong> — start the trial with no credit card. If you do nothing, it simply ends.</span></li><li class='flex items-start gap-3'><span class='flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold'>✓</span><span><strong class='text-white'>No token markup</strong> — register /api/mcp in Claude Code, Cursor, VS Code, or Codex, and the agent runs on the AI plan you already pay for, such as Claude Pro or ChatGPT Plus. You pay your provider, not us.</span></li><li class='flex items-start gap-3'><span class='flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold'>✓</span><span><strong class='text-white'>Editor BYOK</strong> — one OpenRouter key, free models included. You pick the model and keep the bill.</span></li><li class='flex items-start gap-3'><span class='flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold'>✓</span><span><strong class='text-white'>Scoped tokens</strong> — mint read-only or write tokens on the MCP server access card and revoke them any time.</span></li><li class='flex items-start gap-3'><span class='flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold'>✓</span><span><strong class='text-white'>Drafts and revisions</strong> — page rewrites stage as Live Drafts, and new pages stay drafts unless you ask to publish. Other write tools can change live content, and page, post, and product edits are saved as revisions you can restore.</span></li></ul></div>"},"block_type":"text"}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":2},"vertical_alignment":"center"}$nbcx0en$::jsonb, 0),
        (v_id, v_lang, 'section', $nbcx1en${"padding":{"top":"lg","bottom":"lg"},"background":{"type":"theme","theme":"muted"},"column_gap":"lg","column_blocks":[[{"content":{"html_content":"<p class='text-center'><span class='block text-2xl font-extrabold text-foreground'>30</span><span class='text-xs text-muted-foreground uppercase tracking-wider'>Days free, no card</span></p>"},"block_type":"text"}],[{"content":{"html_content":"<p class='text-center'><span class='block text-2xl font-extrabold text-foreground'>0 %</span><span class='text-xs text-muted-foreground uppercase tracking-wider'>Token markup</span></p>"},"block_type":"text"}],[{"content":{"html_content":"<p class='text-center'><span class='block text-2xl font-extrabold text-foreground'>6</span><span class='text-xs text-muted-foreground uppercase tracking-wider'>MCP contract tools</span></p>"},"block_type":"text"}],[{"content":{"html_content":"<p class='text-center'><span class='block text-2xl font-extrabold text-foreground'>50</span><span class='text-xs text-muted-foreground uppercase tracking-wider'>Typed agent tools</span></p>"},"block_type":"text"}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":2,"desktop":4},"vertical_alignment":"center"}$nbcx1en$::jsonb, 1),
        (v_id, v_lang, 'section', $nbcx2en${"padding":{"top":"xl","bottom":"xl"},"background":{"type":"none"},"column_gap":"lg","column_blocks":[[{"content":{"html_content":"<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7'><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'><code class='rounded bg-violet-50 px-2 py-1 text-sm text-violet-700 dark:bg-violet-950 dark:text-violet-200'>get_database_schema</code></h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Returns every table the agent may read or change, with columns, keys, and read-only flags. The model plans against real structure, not guesses.</p></div>"},"block_type":"text"},{"content":{"html_content":"<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7'><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'><code class='rounded bg-violet-50 px-2 py-1 text-sm text-violet-700 dark:bg-violet-950 dark:text-violet-200'>query_site_analytics</code></h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Reads revenue, order counts, status breakdowns, and top products over a date range. Read-only, so it is safe on any token.</p></div>"},"block_type":"text"}],[{"content":{"html_content":"<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7'><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'><code class='rounded bg-violet-50 px-2 py-1 text-sm text-violet-700 dark:bg-violet-950 dark:text-violet-200'>generate_jsonb_layout</code></h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Rewrites an existing page or post as a complete layout. Blocks are validated against the NextBlock schema and staged as a Live Draft.</p></div>"},"block_type":"text"},{"content":{"html_content":"<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7'><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'><code class='rounded bg-violet-50 px-2 py-1 text-sm text-violet-700 dark:bg-violet-950 dark:text-violet-200'>search_stock_media</code></h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Finds free stock photos on Pexels or Unsplash, with alt text and credits, using your free API key. Drop a result straight into an image block.</p></div>"},"block_type":"text"}],[{"content":{"html_content":"<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7'><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'><code class='rounded bg-violet-50 px-2 py-1 text-sm text-violet-700 dark:bg-violet-950 dark:text-violet-200'>update_site_navigation</code></h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Adds, renames, or reorders header menu items per locale. Append to keep the current menu or replace it in one call.</p></div>"},"block_type":"text"},{"content":{"html_content":"<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7'><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'><code class='rounded bg-violet-50 px-2 py-1 text-sm text-violet-700 dark:bg-violet-950 dark:text-violet-200'>and 45 more</code></h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>create_page_layout builds a new page from validated blocks in one call. The rest create posts and products, translate pages, upload media, and manage themes, menus, and scripts. Every tool is typed and scoped.</p></div>"},"block_type":"text"}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":2,"desktop":3},"vertical_alignment":"stretch"}$nbcx2en$::jsonb, 2),
        (v_id, v_lang, 'section', $nbcx3en${"padding":{"top":"xl","bottom":"xl"},"background":{"type":"gradient","gradient":{"type":"linear","stops":[{"color":"#020617","position":0},{"color":"#0f172a","position":100}],"direction":"180deg"}},"column_gap":"xl","column_blocks":[[{"content":{"html_content":"<p class='text-xs uppercase tracking-[0.3em] text-violet-400 font-semibold mb-4'>How It Works</p><h3 class='text-2xl md:text-3xl font-extrabold text-white mb-4'>One Registry, Standard Transport.</h3><p class='text-slate-300 leading-relaxed mb-5'>The Cortex AI MCP server speaks Streamable HTTP at /api/mcp. Your client posts JSON-RPC messages and gets typed results back. There is no SDK to install on your server and no proxy in the middle.</p><ul class='space-y-3 text-sm text-slate-400'><li class='flex items-start gap-2.5'><span class='text-violet-400'>→</span><span>Bearer tokens are stored as SHA-256 hashes and shown once.</span></li><li class='flex items-start gap-2.5'><span class='text-violet-400'>→</span><span>Optional localhost trust lets a local dev server skip the token. It never applies in production.</span></li><li class='flex items-start gap-2.5'><span class='text-violet-400'>→</span><span>Read-only tokens never see a mutating tool in the list.</span></li><li class='flex items-start gap-2.5'><span class='text-violet-400'>→</span><span>Copy-paste config for Claude Code, Codex, Cursor, VS Code, and Claude Desktop.</span></li></ul>"},"block_type":"text"}],[{"content":{"html_content":"<div class='space-y-4'><div class='p-5 rounded-xl border border-slate-700 bg-slate-900'><h4 class='text-sm font-bold text-white mb-1'>Editor BYOK via OpenRouter</h4><p class='text-xs text-slate-400 leading-relaxed'>Choose one model for the whole site in Cortex AI settings, from Claude or Gemini to open weights, with one key. Free models are included, and paid usage stays on your OpenRouter bill.</p></div><div class='p-5 rounded-xl border border-slate-700 bg-slate-900'><h4 class='text-sm font-bold text-white mb-1'>AI Inside the Editor</h4><p class='text-xs text-slate-400 leading-relaxed'>The inline assistant writes and rewrites copy in any text block. The dashboard chat edits sections, builds pages, and translates whole pages, and every block is validated before it is saved.</p></div><div class='p-5 rounded-xl border border-slate-700 bg-slate-900'><h4 class='text-sm font-bold text-white mb-1'>Privacy-First Design</h4><p class='text-xs text-slate-400 leading-relaxed'>Editor requests go from your own server to OpenRouter with your key, and MCP traffic runs between your AI app and your site. NextBlock never sees, stores, or trains on your content.</p></div></div>"},"block_type":"text"}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":2},"vertical_alignment":"center"}$nbcx3en$::jsonb, 3),
        (v_id, v_lang, 'section', $nbcx4en${"padding":{"top":"xl","bottom":"xl"},"background":{"type":"gradient","gradient":{"type":"linear","stops":[{"color":"#312e81","position":0},{"color":"#1e1b4b","position":100}],"direction":"135deg"}},"column_gap":"none","column_blocks":[[{"content":{"level":2,"textAlign":"center","textColor":"background","text_content":"Ready to connect your AI to your CMS?"},"block_type":"heading"},{"content":{"html_content":"<p class='text-center text-violet-100 max-w-xl mx-auto mt-2 mb-6'>One license unlocks Cortex AI in the editor and the MCP server. Start with 30 days free and no credit card, bring your own AI subscription, and keep your data yours.</p>"},"block_type":"text"},{"content":{"url":"https://nextblock.dev/product/nextblock-cortex-ai-cortex-ai-license","size":"lg","text":"Start the 30-Day Free Trial","variant":"secondary","position":"center"},"block_type":"button"}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":1},"vertical_alignment":"center"}$nbcx4en$::jsonb, 4);
      UPDATE public.products
         SET title = $t$NextBlock™ Cortex AI MCP Server & AI Editor License$t$,
             short_description = $t$NextBlock™ Cortex AI is the AI layer for your free, open-source CMS. Pick an OpenRouter model for the editor with your own key, or register /api/mcp so Claude Code, Cursor, VS Code, or Codex can build layouts, inspect your schema, and manage content on the AI plan you already pay for. Free for 30 days, no credit card.$t$,
             meta_title = $t$Cortex AI MCP Server — Connect Claude & Cursor to Your CMS$t$,
             meta_description = $t$Turn NextBlock into a Cortex AI MCP server. Connect Claude Code, Cursor, or Codex to create layouts, inspect your schema, and manage content on your AI plan.$t$,
             updated_at = now()
       WHERE id = v_id;
    ELSIF NOT EXISTS (SELECT 1 FROM public.blocks WHERE product_id = v_id AND content::text LIKE $t$%and 45 more%$t$) THEN
      RAISE NOTICE '02019: product nextblock-cortex-ai-cortex-ai-license (en) differs from the shipped copy; left unchanged.';
    END IF;
  END IF;


  -- French
  v_id := NULL;
  SELECT p.id, p.language_id INTO v_id, v_lang
    FROM public.products AS p JOIN public.languages AS l ON l.id = p.language_id
   WHERE p.slug = 'nextblock-cortex-ai-cortex-ai-license-fr' AND l.code = 'fr'
   ORDER BY p.id LIMIT 1;
  IF v_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.blocks WHERE product_id = v_id AND content::text LIKE $t$%Couche d'Intelligence IA%$t$)
       AND NOT EXISTS (SELECT 1 FROM public.blocks WHERE product_id = v_id AND content::text LIKE $t$%Couche IA native MCP%$t$) THEN
      DELETE FROM public.blocks WHERE product_id = v_id;
      INSERT INTO public.blocks (product_id, language_id, block_type, content, "order") VALUES
        (v_id, v_lang, 'section', $nbcx0fr${"padding":{"top":"xl","bottom":"xl"},"background":{"type":"gradient","gradient":{"type":"linear","stops":[{"color":"#1e1b4b","position":0},{"color":"#312e81","position":35},{"color":"#0f172a","position":100}],"direction":"135deg"}},"column_gap":"xl","column_blocks":[[{"content":{"html_content":"<p class='text-xs uppercase tracking-[0.3em] text-violet-400 font-semibold mb-4'>Couche IA native MCP · Essai gratuit de 30 jours</p><h2 class='text-3xl md:text-5xl font-extrabold text-white leading-tight mb-5'>Votre CMS devient un serveur MCP Cortex AI.</h2><p class='text-base md:text-lg text-slate-200 leading-relaxed mb-4'>Cortex AI fonctionne de deux façons. Dans l'éditeur, il utilise le modèle OpenRouter de votre choix, avec votre propre clé. Via MCP, il fait de NextBlock un serveur que Claude Code, Cursor, VS Code et Codex pilotent depuis leur propre fenêtre de discussion.</p><p class='text-base text-slate-300 leading-relaxed mb-6'>Le CMS est gratuit et open source sous licence AGPL. Cortex AI est un module premium, comme Commerce Pro, et il commence par un essai gratuit de 30 jours, sans carte de crédit.</p>"},"block_type":"text"},{"content":{"url":"/article/guide-connexion-mcp-cortex-ai","size":"lg","text":"Lire le guide de configuration MCP →","variant":"default","position":"left"},"block_type":"button"}],[{"content":{"html_content":"<div class='rounded-2xl border border-violet-700 bg-slate-950 p-6 shadow-xl sm:p-8'><h3 class='text-lg font-bold text-white mb-5'>Utilisez votre propre abonnement IA</h3><ul class='space-y-4 text-sm leading-relaxed text-slate-300'><li class='flex items-start gap-3'><span class='flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold'>✓</span><span><strong class='text-white'>Gratuit pendant 30 jours</strong> — lancez l'essai sans carte de crédit. Si vous ne faites rien, il prend simplement fin.</span></li><li class='flex items-start gap-3'><span class='flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold'>✓</span><span><strong class='text-white'>Aucune majoration sur les jetons</strong> — enregistrez /api/mcp dans Claude Code, Cursor, VS Code ou Codex, et l'agent fonctionne avec le forfait IA que vous payez déjà, comme Claude Pro ou ChatGPT Plus. Vous payez votre fournisseur, pas nous.</span></li><li class='flex items-start gap-3'><span class='flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold'>✓</span><span><strong class='text-white'>Votre clé dans l'éditeur</strong> — une seule clé OpenRouter, modèles gratuits compris. Vous choisissez le modèle et gardez la facture.</span></li><li class='flex items-start gap-3'><span class='flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold'>✓</span><span><strong class='text-white'>Jetons à portée limitée</strong> — créez des jetons en lecture seule ou en écriture dans la carte MCP server access du CMS, et révoquez-les à tout moment.</span></li><li class='flex items-start gap-3'><span class='flex-shrink-0 w-6 h-6 rounded-full bg-violet-950 flex items-center justify-center text-violet-300 text-xs font-bold'>✓</span><span><strong class='text-white'>Brouillons et révisions</strong> — les réécritures de page arrivent en brouillon en direct, et les nouvelles pages restent en brouillon sauf si vous demandez de les publier. D'autres outils d'écriture peuvent modifier le contenu en ligne, et les modifications des pages, articles et produits sont enregistrées comme des révisions que vous pouvez restaurer.</span></li></ul></div>"},"block_type":"text"}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":2},"vertical_alignment":"center"}$nbcx0fr$::jsonb, 0),
        (v_id, v_lang, 'section', $nbcx1fr${"padding":{"top":"lg","bottom":"lg"},"background":{"type":"theme","theme":"muted"},"column_gap":"lg","column_blocks":[[{"content":{"html_content":"<p class='text-center'><span class='block text-2xl font-extrabold text-foreground'>30</span><span class='text-xs text-muted-foreground uppercase tracking-wider'>Jours gratuits, sans carte</span></p>"},"block_type":"text"}],[{"content":{"html_content":"<p class='text-center'><span class='block text-2xl font-extrabold text-foreground'>0 %</span><span class='text-xs text-muted-foreground uppercase tracking-wider'>Majoration sur les jetons</span></p>"},"block_type":"text"}],[{"content":{"html_content":"<p class='text-center'><span class='block text-2xl font-extrabold text-foreground'>6</span><span class='text-xs text-muted-foreground uppercase tracking-wider'>Outils de contrat MCP</span></p>"},"block_type":"text"}],[{"content":{"html_content":"<p class='text-center'><span class='block text-2xl font-extrabold text-foreground'>50</span><span class='text-xs text-muted-foreground uppercase tracking-wider'>Outils d'agent typés</span></p>"},"block_type":"text"}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":2,"desktop":4},"vertical_alignment":"center"}$nbcx1fr$::jsonb, 1),
        (v_id, v_lang, 'section', $nbcx2fr${"padding":{"top":"xl","bottom":"xl"},"background":{"type":"none"},"column_gap":"lg","column_blocks":[[{"content":{"html_content":"<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7'><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'><code class='rounded bg-violet-50 px-2 py-1 text-sm text-violet-700 dark:bg-violet-950 dark:text-violet-200'>get_database_schema</code></h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Renvoie chaque table que l'agent peut lire ou modifier, avec ses colonnes, ses clés et ses indicateurs de lecture seule. Le modèle planifie sur la vraie structure, pas sur des suppositions.</p></div>"},"block_type":"text"},{"content":{"html_content":"<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7'><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'><code class='rounded bg-violet-50 px-2 py-1 text-sm text-violet-700 dark:bg-violet-950 dark:text-violet-200'>query_site_analytics</code></h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Lit les revenus, le nombre de commandes, la répartition par statut et les meilleurs produits sur une période. En lecture seule, donc sans risque avec n'importe quel jeton.</p></div>"},"block_type":"text"}],[{"content":{"html_content":"<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7'><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'><code class='rounded bg-violet-50 px-2 py-1 text-sm text-violet-700 dark:bg-violet-950 dark:text-violet-200'>generate_jsonb_layout</code></h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Réécrit une page ou un article existant en mise en page complète. Chaque bloc est validé contre le schéma NextBlock, puis mis en attente comme brouillon en direct.</p></div>"},"block_type":"text"},{"content":{"html_content":"<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7'><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'><code class='rounded bg-violet-50 px-2 py-1 text-sm text-violet-700 dark:bg-violet-950 dark:text-violet-200'>search_stock_media</code></h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Trouve des photos libres de droits sur Pexels ou Unsplash, avec texte alternatif et crédits, grâce à votre clé API gratuite. Déposez un résultat directement dans un bloc image.</p></div>"},"block_type":"text"}],[{"content":{"html_content":"<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7'><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'><code class='rounded bg-violet-50 px-2 py-1 text-sm text-violet-700 dark:bg-violet-950 dark:text-violet-200'>update_site_navigation</code></h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>Ajoute, renomme ou réordonne les éléments du menu d'en-tête, par langue. Ajoutez des liens en gardant le menu actuel, ou remplacez-le en un seul appel.</p></div>"},"block_type":"text"},{"content":{"html_content":"<div class='h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-violet-300 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-950 dark:hover:border-violet-500 sm:p-7'><h3 class='text-base font-bold text-slate-900 dark:text-white mb-2'><code class='rounded bg-violet-50 px-2 py-1 text-sm text-violet-700 dark:bg-violet-950 dark:text-violet-200'>et 45 autres</code></h3><p class='text-sm text-slate-600 dark:text-slate-300 leading-relaxed'>create_page_layout crée une nouvelle page à partir de blocs validés, en un seul appel. Les autres créent des articles et des produits, traduisent des pages, téléversent des médias et gèrent thèmes, menus et scripts. Chaque outil est typé et limité par la portée du jeton.</p></div>"},"block_type":"text"}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":2,"desktop":3},"vertical_alignment":"stretch"}$nbcx2fr$::jsonb, 2),
        (v_id, v_lang, 'section', $nbcx3fr${"padding":{"top":"xl","bottom":"xl"},"background":{"type":"gradient","gradient":{"type":"linear","stops":[{"color":"#020617","position":0},{"color":"#0f172a","position":100}],"direction":"180deg"}},"column_gap":"xl","column_blocks":[[{"content":{"html_content":"<p class='text-xs uppercase tracking-[0.3em] text-violet-400 font-semibold mb-4'>Comment ça marche</p><h3 class='text-2xl md:text-3xl font-extrabold text-white mb-4'>Un seul registre, un transport standard.</h3><p class='text-slate-300 leading-relaxed mb-5'>Le serveur MCP Cortex AI parle Streamable HTTP à l'adresse /api/mcp. Votre client envoie des messages JSON-RPC et reçoit des résultats typés. Aucun SDK à installer sur votre serveur, aucun intermédiaire.</p><ul class='space-y-3 text-sm text-slate-400'><li class='flex items-start gap-2.5'><span class='text-violet-400'>→</span><span>Les jetons Bearer sont stockés sous forme de hachages SHA-256 et affichés une seule fois.</span></li><li class='flex items-start gap-2.5'><span class='text-violet-400'>→</span><span>La confiance localhost, facultative, permet à un serveur de développement local de se passer du jeton. Elle ne s'applique jamais en production.</span></li><li class='flex items-start gap-2.5'><span class='text-violet-400'>→</span><span>Un jeton en lecture seule ne voit jamais d'outil d'écriture dans la liste.</span></li><li class='flex items-start gap-2.5'><span class='text-violet-400'>→</span><span>Configuration à copier-coller pour Claude Code, Codex, Cursor, VS Code et Claude Desktop.</span></li></ul>"},"block_type":"text"}],[{"content":{"html_content":"<div class='space-y-4'><div class='p-5 rounded-xl border border-slate-700 bg-slate-900'><h4 class='text-sm font-bold text-white mb-1'>Votre clé OpenRouter dans l'éditeur</h4><p class='text-xs text-slate-400 leading-relaxed'>Choisissez un modèle pour tout le site dans les réglages de Cortex AI, de Claude ou Gemini aux modèles ouverts, avec une seule clé. Les modèles gratuits sont inclus, et l'usage payant reste sur votre facture OpenRouter.</p></div><div class='p-5 rounded-xl border border-slate-700 bg-slate-900'><h4 class='text-sm font-bold text-white mb-1'>L'IA dans l'éditeur</h4><p class='text-xs text-slate-400 leading-relaxed'>L'assistant intégré écrit et réécrit le texte de n'importe quel bloc de texte. Le chat du tableau de bord modifie les sections, construit des pages et traduit des pages entières, et chaque bloc est validé avant d'être enregistré.</p></div><div class='p-5 rounded-xl border border-slate-700 bg-slate-900'><h4 class='text-sm font-bold text-white mb-1'>Conçu pour la confidentialité</h4><p class='text-xs text-slate-400 leading-relaxed'>Les requêtes de l'éditeur partent de votre propre serveur vers OpenRouter avec votre clé, et le trafic MCP circule entre votre application IA et votre site. NextBlock ne voit jamais votre contenu, ne le stocke pas et ne s'en sert pas pour entraîner des modèles.</p></div></div>"},"block_type":"text"}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":2},"vertical_alignment":"center"}$nbcx3fr$::jsonb, 3),
        (v_id, v_lang, 'section', $nbcx4fr${"padding":{"top":"xl","bottom":"xl"},"background":{"type":"gradient","gradient":{"type":"linear","stops":[{"color":"#312e81","position":0},{"color":"#1e1b4b","position":100}],"direction":"135deg"}},"column_gap":"none","column_blocks":[[{"content":{"level":2,"textAlign":"center","textColor":"background","text_content":"Prêt à connecter votre IA à votre CMS ?"},"block_type":"heading"},{"content":{"html_content":"<p class='text-center text-violet-100 max-w-xl mx-auto mt-2 mb-6'>Une licence débloque à la fois Cortex AI dans l'éditeur et le serveur MCP. Commencez avec 30 jours gratuits, sans carte de crédit, apportez votre propre abonnement IA et gardez la maîtrise de vos données.</p>"},"block_type":"text"},{"content":{"url":"https://nextblock.dev/product/nextblock-cortex-ai-cortex-ai-license-fr","size":"lg","text":"Commencer l'essai gratuit de 30 jours","variant":"secondary","position":"center"},"block_type":"button"}]],"container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":1},"vertical_alignment":"center"}$nbcx4fr$::jsonb, 4);
      UPDATE public.products
         SET title = $t$Licence NextBlock™ du serveur MCP Cortex AI et de l'IA dans l'éditeur$t$,
             short_description = $t$NextBlock™ Cortex AI est la couche IA de votre CMS gratuit et open source. Choisissez un modèle OpenRouter pour l'éditeur avec votre propre clé, ou enregistrez /api/mcp pour que Claude Code, Cursor, VS Code ou Codex construisent des mises en page, lisent votre schéma et gèrent votre contenu avec le forfait IA que vous payez déjà. Gratuit pendant 30 jours, sans carte de crédit.$t$,
             meta_title = $t$Serveur MCP Cortex AI — Claude et Cursor dans votre CMS$t$,
             meta_description = $t$Faites de NextBlock un serveur MCP Cortex AI. Connectez Claude Code, Cursor ou Codex pour créer des mises en page et gérer votre contenu avec votre forfait IA.$t$,
             updated_at = now()
       WHERE id = v_id;
    ELSIF NOT EXISTS (SELECT 1 FROM public.blocks WHERE product_id = v_id AND content::text LIKE $t$%Couche IA native MCP%$t$) THEN
      RAISE NOTICE '02019: product nextblock-cortex-ai-cortex-ai-license-fr (fr) differs from the shipped copy; left unchanged.';
    END IF;
  END IF;

END
$nb_02019_products$;

DROP FUNCTION IF EXISTS pg_temp.nb_02019_item(text, text, text, boolean);
DROP FUNCTION IF EXISTS pg_temp.nb_02019_json_inner(text);
DROP TABLE IF EXISTS pg_temp.nb_02019_edits;
DROP TABLE IF EXISTS pg_temp.nb_02019_fields;
