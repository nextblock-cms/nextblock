-- 02018: seeded content refresh, EN + FR -- the fifth install path (an AI coding agent),
-- `npm run dev` in the monorepo, and audited accuracy fixes across the seeded posts and the
-- home / articles pages. Copy and metadata only; no schema change.
--
-- * Install guide ('how-to-setup-nextblock' / 'comment-configurer-nextblock'): Option 5, "let
--   your AI coding agent install it" (`npx create-nextblock@latest my-site --non-interactive`,
--   the two browser steps, the MCP server, the Claude Code / Cursor / Codex plugin); the clone
--   starts with `npm run dev` (root alias of `npx nx serve nextblock` since 2026-08-21, the copy
--   still said the monorepo had none); the post-setup Cortex AI welcome screen; Cloudflare R2 is
--   optional; Commerce Pro activates from Administration -> Packages (the CLI `activate` command
--   overwrites working routes); the update FAQ points at `npm run update`; no "copilot".
-- * Updating guide ('how-updating-works' / 'comment-fonctionnent-les-mises-a-jour'): five install
--   paths, four update paths; `npm run update:check` (PowerShell strips a bare `--`, so
--   `npm run update -- --check` ran a full update); the first commit a new scaffold needs;
--   rollback commands that work (merge commits need `git revert -m 1`); backups; migrations do
--   fix seeded data.
-- * MCP guide ('cortex-ai-mcp-connection-guide' / 'guide-connexion-mcp-cortex-ai'): where the
--   trial starts, what the agent can publish (drafts are not the only path), 6 contract tools /
--   50 typed tools, five client tabs, ports, a "starting from nothing?" pointer to Option 5.
-- * Cortex AI guide ('nextblock-cortex-ai-guide'): label 'Cortex AI', OpenRouter-only single
--   model setting, the two surfaces (editor + MCP server), the 30-day trial; and its French twin
--   'guide-cortex-ai-nextblock' (below), which 02009 never managed to insert.
-- * Architecture and commerce posts, home and articles pages: premium modules are AGPL too,
--   @nextblock-cms/cortex, per-currency price overrides, Stripe Tax wording, daily FX sync, no ISR
--   claim, linked translations, the agent path on the home page, FR link/alt/meta fixes, and the
--   English home's duplicate block "order".
--
-- How: every fragment is queued with its post or page (slug + language; never blocks.id, ids
-- drift on every install) and applied by pg_temp.nb_02018_item, all or nothing per post/page:
-- only if every seeded fragment of that item is still present are its blocks rewritten, then
-- the same fragments in its revision snapshots, then its fields (row and snapshot meta, each
-- only while it still holds the seeded value). An item an operator edited, even by re-saving
-- it in the editor (which re-serialises the HTML), is left exactly as it is, never half
-- rewritten; a NOTICE names it. Items that point at the install guide's Option 5 (#ai-agent)
-- run only if that guide, in the same language, has the section. Patterns are single-line and
-- carriage returns are stripped from every replacement, so the stored copy is LF whatever line
-- endings this file arrives with. Idempotent: a second run finds nothing to replace.
--
-- NOTE: keep the word "sandbox" OUT of this filename -- generate-sandbox-reset.ts excludes any
-- migration whose filename contains "sandbox" from the reset bundle.

-- JSON-escapes a raw HTML fragment exactly as Postgres prints it inside content::text, so a
-- fragment written below as plain HTML matches the stored jsonb text form. Carriage returns are
-- dropped first: a Windows checkout can hand this file over with CRLF endings, and the stored
-- copy must be LF on every install.
CREATE OR REPLACE FUNCTION pg_temp.nb_02018_json_inner(src text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT substr(to_jsonb(replace(src, chr(13), ''))::text, 2,
                length(to_jsonb(replace(src, chr(13), ''))::text) - 2)
$fn$;

DROP TABLE IF EXISTS pg_temp.nb_02018_edits;
CREATE TEMP TABLE nb_02018_edits (
  seq bigserial PRIMARY KEY,
  kind text NOT NULL,
  slug text NOT NULL,
  lang text NOT NULL,
  old_html text NOT NULL,
  new_html text NOT NULL,
  unless_html text
);

DROP TABLE IF EXISTS pg_temp.nb_02018_fields;
CREATE TEMP TABLE nb_02018_fields (
  seq bigserial PRIMARY KEY,
  kind text NOT NULL,
  slug text NOT NULL,
  lang text NOT NULL,
  field text NOT NULL CHECK (field IN ('title', 'label', 'excerpt', 'subtitle', 'meta_title', 'meta_description')),
  old_value text NOT NULL,
  new_value text NOT NULL
);

-- Rewrites one fragment in every block and revision snapshot of a post or page, where it is
-- still present (and, for insertions, where the marker is absent).
CREATE OR REPLACE FUNCTION pg_temp.nb_02018_fragment(
  p_kind text, p_slug text, p_lang text, p_old text, p_new text, p_unless text)
RETURNS void
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_old text := pg_temp.nb_02018_json_inner(p_old);
  v_new text := pg_temp.nb_02018_json_inner(p_new);
  v_unless text := CASE WHEN p_unless IS NULL THEN NULL ELSE pg_temp.nb_02018_json_inner(p_unless) END;
  v_parent bigint;
BEGIN
  IF p_kind = 'post' THEN
    SELECT p.id INTO v_parent FROM public.posts AS p JOIN public.languages AS l ON l.id = p.language_id
     WHERE p.slug = p_slug AND l.code = p_lang ORDER BY p.id LIMIT 1;
    UPDATE public.blocks SET content = replace(content::text, v_old, v_new)::jsonb, updated_at = now()
     WHERE post_id = v_parent AND position(v_old IN content::text) > 0
       AND (v_unless IS NULL OR position(v_unless IN content::text) = 0);
    UPDATE public.post_revisions SET content = replace(content::text, v_old, v_new)::jsonb
     WHERE post_id = v_parent AND position(v_old IN content::text) > 0
       AND (v_unless IS NULL OR position(v_unless IN content::text) = 0);
  ELSE
    SELECT p.id INTO v_parent FROM public.pages AS p JOIN public.languages AS l ON l.id = p.language_id
     WHERE p.slug = p_slug AND l.code = p_lang ORDER BY p.id LIMIT 1;
    UPDATE public.blocks SET content = replace(content::text, v_old, v_new)::jsonb, updated_at = now()
     WHERE page_id = v_parent AND position(v_old IN content::text) > 0
       AND (v_unless IS NULL OR position(v_unless IN content::text) = 0);
    UPDATE public.page_revisions SET content = replace(content::text, v_old, v_new)::jsonb
     WHERE page_id = v_parent AND position(v_old IN content::text) > 0
       AND (v_unless IS NULL OR position(v_unless IN content::text) = 0);
  END IF;
END
$fn$;

-- Applies every queued edit of one post or page, all or nothing. The edits are replayed in
-- order against the item's blocks in memory; only if every one of them finds its seeded
-- fragment are the blocks written back, followed by the same fragments in the revision
-- snapshots and the queued fields (row + snapshot meta, each only while it still holds the
-- seeded value). An item an operator has edited, even by re-saving it in the editor (which
-- re-serialises the HTML), is left untouched as a whole, so it never ends up half old, half
-- new. A second run finds nothing to replace and is a no-op.
-- p_needs_agent_guide: the item points readers at the install guide's Option 5
-- (#ai-agent); it is rewritten only if that guide, in the same language, has the section.
CREATE OR REPLACE FUNCTION pg_temp.nb_02018_item(
  p_kind text, p_slug text, p_lang text, p_needs_agent_guide boolean)
RETURNS boolean
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_parent bigint;
  v_ids bigint[];
  v_texts text[];
  v_guide_slug text := CASE WHEN p_lang = 'fr' THEN 'comment-configurer-nextblock' ELSE 'how-to-setup-nextblock' END;
  v_marker text := pg_temp.nb_02018_json_inner('<h2 id=''ai-agent''>');
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
  IF p_kind = 'post' THEN
    SELECT p.id INTO v_parent FROM public.posts AS p JOIN public.languages AS l ON l.id = p.language_id
     WHERE p.slug = p_slug AND l.code = p_lang ORDER BY p.id LIMIT 1;
  ELSE
    SELECT p.id INTO v_parent FROM public.pages AS p JOIN public.languages AS l ON l.id = p.language_id
     WHERE p.slug = p_slug AND l.code = p_lang ORDER BY p.id LIMIT 1;
  END IF;
  IF v_parent IS NULL THEN
    RETURN false;
  END IF;

  IF p_needs_agent_guide AND NOT EXISTS (
       SELECT 1 FROM public.blocks AS b
         JOIN public.posts AS p ON p.id = b.post_id
         JOIN public.languages AS l ON l.id = p.language_id
        WHERE p.slug = v_guide_slug AND l.code = p_lang
          AND position(v_marker IN b.content::text) > 0) THEN
    RAISE NOTICE '02018: % % (%) left unchanged: the install guide has no Option 5 section.', p_kind, p_slug, p_lang;
    RETURN false;
  END IF;

  SELECT array_agg(b.id ORDER BY b.id), array_agg(b.content::text ORDER BY b.id)
    INTO v_ids, v_texts
    FROM public.blocks AS b
   WHERE (p_kind = 'post' AND b.post_id = v_parent) OR (p_kind = 'page' AND b.page_id = v_parent);

  FOR e IN SELECT * FROM pg_temp.nb_02018_edits
            WHERE kind = p_kind AND slug = p_slug AND lang = p_lang ORDER BY seq LOOP
    v_total := v_total + 1;
    v_hit := false;
    v_old := pg_temp.nb_02018_json_inner(e.old_html);
    v_new := pg_temp.nb_02018_json_inner(e.new_html);
    v_unless := CASE WHEN e.unless_html IS NULL THEN NULL ELSE pg_temp.nb_02018_json_inner(e.unless_html) END;
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
      RAISE NOTICE '02018: % % (%) differs from the seeded copy (% of % fragments not found); left unchanged.',
        p_kind, p_slug, p_lang, v_missing, v_total;
    END IF;
    RETURN false;
  END IF;

  FOR i IN 1 .. array_length(v_ids, 1) LOOP
    UPDATE public.blocks SET content = v_texts[i]::jsonb, updated_at = now()
     WHERE id = v_ids[i] AND content::text IS DISTINCT FROM v_texts[i];
  END LOOP;

  FOR e IN SELECT * FROM pg_temp.nb_02018_edits
            WHERE kind = p_kind AND slug = p_slug AND lang = p_lang ORDER BY seq LOOP
    v_old := pg_temp.nb_02018_json_inner(e.old_html);
    v_new := pg_temp.nb_02018_json_inner(e.new_html);
    v_unless := CASE WHEN e.unless_html IS NULL THEN NULL ELSE pg_temp.nb_02018_json_inner(e.unless_html) END;
    IF p_kind = 'post' THEN
      UPDATE public.post_revisions SET content = replace(content::text, v_old, v_new)::jsonb
       WHERE post_id = v_parent AND position(v_old IN content::text) > 0
         AND (v_unless IS NULL OR position(v_unless IN content::text) = 0);
    ELSE
      UPDATE public.page_revisions SET content = replace(content::text, v_old, v_new)::jsonb
       WHERE page_id = v_parent AND position(v_old IN content::text) > 0
         AND (v_unless IS NULL OR position(v_unless IN content::text) = 0);
    END IF;
  END LOOP;

  FOR f IN SELECT * FROM pg_temp.nb_02018_fields
            WHERE kind = p_kind AND slug = p_slug AND lang = p_lang ORDER BY seq LOOP
    EXECUTE format('UPDATE public.%I SET %I = $1, updated_at = now() WHERE id = $2 AND %I = $3',
                   CASE WHEN p_kind = 'post' THEN 'posts' ELSE 'pages' END, f.field, f.field)
      USING replace(f.new_value, chr(13), ''), v_parent, f.old_value;
    EXECUTE format('UPDATE public.%I SET content = jsonb_set(content, $1, to_jsonb($2::text))
                     WHERE %I = $3 AND revision_type = ''snapshot'' AND content #>> $1 = $4',
                   CASE WHEN p_kind = 'post' THEN 'post_revisions' ELSE 'page_revisions' END,
                   CASE WHEN p_kind = 'post' THEN 'post_id' ELSE 'page_id' END)
      USING ARRAY['meta', f.field], replace(f.new_value, chr(13), ''), v_parent, f.old_value;
  END LOOP;

  RETURN true;
END
$fn$;

-- ========================================================================================
-- architecture-commerce
-- ========================================================================================

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-nextblock-works', 'en',
  $o$the hosted CMS, the open-source starter$o$,
  $n$the CMS you deploy, the open-source starter$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-nextblock-works', 'en',
  $o$The <code>apps/create-nextblock</code> tool mirrors that setup$o$,
  $n$The <code>apps/create-nextblock</code> tool (published on npm as <code>create-nextblock</code>) mirrors that setup$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-nextblock-works', 'en',
  $o$<li><strong>@nextblock-cms/ecommerce</strong> - The digital store package when activated</li>$o$,
  $n$<li><strong>@nextblock-cms/ecommerce</strong> - The digital store package when activated</li>
      <li><strong>@nextblock-cms/cortex</strong> - Cortex AI: AI inside the editor and the MCP server, when activated</li>$n$,
  $u$@nextblock-cms/cortex$u$);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-nextblock-works', 'en',
  $o$Run <code>nx graph</code> to see$o$,
  $n$In the monorepo clone, run <code>npx nx graph</code> to see$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-nextblock-works', 'en',
  $o$the source of truth for all blocks.$o$,
  $n$the source of truth for the built-in blocks.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-nextblock-works', 'en',
  $o$checkout forms, and product cards.</p>$o$,
  $n$checkout forms, and product cards. Custom blocks you design in the CMS live in the database and go through the same block renderer.</p>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-nextblock-works', 'en',
  $o$The core CMS is open-source under the AGPL license. Store modules remain source-available and turn on with verified licenses. This keeps the core lightweight while unlocking advanced tools when you need them.$o$,
  $n$The core CMS is free and open source under the AGPL. The premium modules, Commerce Pro and Cortex AI, are public AGPL code too, and their features switch on with a license key. This keeps the core lightweight while unlocking advanced tools when you need them. Each module starts with a 30-day free trial, no credit card required.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-nextblock-works', 'en',
  $o$you get a complete, working system from day one.</p>$o$,
  $n$you get a complete, working system from day one. A coding agent such as Claude Code or Cursor can also scaffold the project for you, as <a href='/article/how-to-setup-nextblock#ai-agent'>the install guide</a> explains.</p>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-nextblock-fonctionne', 'fr',
  $o$le CMS hébergé, le projet open-source$o$,
  $n$le CMS que vous déployez, le projet open-source$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-nextblock-fonctionne', 'fr',
  $o$La commande <code>apps/create-nextblock</code> reprend$o$,
  $n$L'outil <code>apps/create-nextblock</code> (publié sur npm sous le nom <code>create-nextblock</code>) reprend$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-nextblock-fonctionne', 'fr',
  $o$<li><strong>@nextblock-cms/ecommerce</strong> - Le module de boutique en ligne une fois activé</li>$o$,
  $n$<li><strong>@nextblock-cms/ecommerce</strong> - Le module de boutique en ligne une fois activé</li>
      <li><strong>@nextblock-cms/cortex</strong> - Cortex AI : l'IA dans l'éditeur et le serveur MCP, une fois activé</li>$n$,
  $u$@nextblock-cms/cortex$u$);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-nextblock-fonctionne', 'fr',
  $o$La commande <code>nx graph</code> montre$o$,
  $n$Dans le clone du monorepo, la commande <code>npx nx graph</code> montre$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-nextblock-fonctionne', 'fr',
  $o$la source de vérité pour tous les blocs du CMS.$o$,
  $n$la source de vérité pour les blocs intégrés du CMS.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-nextblock-fonctionne', 'fr',
  $o$les listes d'articles et les formulaires de paiement.</p>$o$,
  $n$les listes d'articles et les formulaires de paiement. Les blocs personnalisés conçus dans le CMS sont stockés dans la base de données et passent par le même moteur de rendu.</p>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-nextblock-fonctionne', 'fr',
  $o$des menus flottants, des tableaux$o$,
  $n$des menus flottants, des poignées de glisser-déposer, des tableaux$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-nextblock-fonctionne', 'fr',
  $o$Le cœur de NextBlock est open-source sous licence AGPL. Les modules du store s'activent avec une clé de licence valide. Le socle reste léger tout en ouvrant des outils pro quand vous en avez besoin.$o$,
  $n$Le cœur de NextBlock est gratuit et open source sous licence AGPL. Les modules premium, Commerce Pro et Cortex AI, sont eux aussi publiés sous AGPL, et leurs fonctions s'activent avec une clé de licence. Le socle reste léger tout en ouvrant des outils pro quand vous en avez besoin. Chaque module propose un essai gratuit de 30 jours, sans carte de crédit.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-nextblock-fonctionne', 'fr',
  $o$vous profitez d'une base solide et prête à l'emploi.</p>$o$,
  $n$vous profitez d'une base solide et prête à l'emploi. Un agent de code, par exemple Claude Code ou Cursor, peut aussi créer le projet à votre place : le <a href='/article/comment-configurer-nextblock#ai-agent'>guide d'installation</a> explique comment.</p>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'nextblock-commerce-guide', 'en',
  $o$want their catalog and checkout in one place.</p>$o$,
  $n$want their catalog and checkout in one place. NextBlock™ Commerce Pro comes with a 30-day free trial, no credit card required. Start it from <strong>Administration &rarr; Packages</strong> in the CMS.</p>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'nextblock-commerce-guide', 'en',
  $o$Live rate sync, price rounding, and market rules make selling worldwide simple.$o$,
  $n$Automatic rate sync, rounding rules, and per-currency prices make selling worldwide simple.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'nextblock-commerce-guide', 'en',
  $o$Set exact prices for specific countries when needed.$o$,
  $n$Set an exact price in any currency you do not auto-sync, instead of the converted one.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'nextblock-commerce-guide', 'en',
  $o$Fallback options ensure buyers always see a valid rate.$o$,
  $n$When no state-specific zone matches, the country-wide zone applies, and checkout offers the cheapest valid rate.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'nextblock-commerce-guide', 'en',
  $o$Commerce is the first premium module on our roadmap. It fits naturally into the larger CMS platform.$o$,
  $n$Commerce Pro was our first premium module, and Cortex AI followed. Both plug into the same CMS.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-commerce-nextblock', 'fr',
  $o$leur catalogue et leurs ventes au même endroit.</p>$o$,
  $n$leur catalogue et leurs ventes au même endroit. NextBlock™ Commerce Pro propose un essai gratuit de 30 jours, sans carte de crédit. Lancez-le depuis <strong>Administration &rarr; Packages</strong> dans le CMS.</p>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-commerce-nextblock', 'fr',
  $o$Articles, commandes, livraison et factures s'intègrent$o$,
  $n$Produits, commandes, livraison et factures s'intègrent$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-commerce-nextblock', 'fr',
  $o$Taux de change en direct, prix ronds et règles locales facilitent les ventes.$o$,
  $n$Taux de change synchronisés, règles d'arrondi et prix par devise facilitent les ventes.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-commerce-nextblock', 'fr',
  $o$Fixez des prix précis pour chaque pays si nécessaire.$o$,
  $n$Fixez un prix précis dans toute devise non synchronisée automatiquement, au lieu du prix converti.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-commerce-nextblock', 'fr',
  $o$Un tarif de secours évite les blocages.$o$,
  $n$Sans zone propre à la région, la zone du pays s'applique, et le tunnel d'achat propose le tarif valide le moins cher.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-commerce-nextblock', 'fr',
  $o$Le commerce est le premier module officiel de notre feuille de route. Il s'intègre au cœur du CMS.$o$,
  $n$Commerce Pro a été notre premier module premium, puis Cortex AI a suivi. Les deux s'intègrent au cœur du CMS.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-commerce-nextblock', 'fr',
  $o$Les factures à imprimer reprennent les couleurs de votre marque.$o$,
  $n$Les factures à imprimer reprennent le logo et les coordonnées de votre entreprise.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-commerce-nextblock', 'fr',
  $o$la liste des articles, du suivi des stocks$o$,
  $n$la liste des produits, du suivi des stocks$n$,
  NULL);

-- ========================================================================================
-- cortex-mcp
-- ========================================================================================

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'cortex-ai-mcp-connection-guide', 'en',
  $o$Per-block translation and SEO checks as you type.$o$,
  $n$Linked translations for every page and SEO checks as you type.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'cortex-ai-mcp-connection-guide', 'en',
  $o$Server Components · edge cached.$o$,
  $n$Server Components · cache cleared on publish.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'cortex-ai-mcp-connection-guide', 'en',
  $o$renders those records with Server Components and caches the result at the edge.$o$,
  $n$renders those records with Server Components, from a public content cache that clears the moment you publish.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'cortex-ai-mcp-connection-guide', 'en',
  $o$with an open standard instead of a vendor plugin.$o$,
  $n$over an open standard, no proprietary connector required.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'cortex-ai-mcp-connection-guide', 'en',
  $o$The CMS is free forever. Cortex AI, which includes the MCP server$o$,
  $n$The CMS is free forever and open source. Cortex AI, which includes the MCP server$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'cortex-ai-mcp-connection-guide', 'en',
  $o$>Nothing ships by accident.<$o$,
  $n$>You stay in control.<$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'cortex-ai-mcp-connection-guide', 'en',
  $o$Every layout the agent writes lands as a draft. An editor reviews it and hits publish.$o$,
  $n$Page rewrites land as Live Drafts, and new pages stay drafts unless you ask to publish. Your MCP client&rsquo;s approval prompt and the token scope decide what the agent may change.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'cortex-ai-mcp-connection-guide', 'en',
  $o$Your editors keep a visual CMS, your developers keep a clean Next.js 16 app, and nothing goes live until someone hits publish.$o$,
  $n$Your editors keep a visual CMS, and your developers keep a clean Next.js 16 app. Agent edits to pages, posts, and products are saved as revisions you can restore.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'cortex-ai-mcp-connection-guide', 'en',
  $o$get_database_schema</code><code class='block rounded-md bg-white/5 px-3 py-1.5 font-mono text-xs text-violet-100'>generate_jsonb_layout</code>$o$,
  $n$get_database_schema</code><code class='block rounded-md bg-white/5 px-3 py-1.5 font-mono text-xs text-violet-100'>create_page_layout</code><code class='block rounded-md bg-white/5 px-3 py-1.5 font-mono text-xs text-violet-100'>generate_jsonb_layout</code>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'cortex-ai-mcp-connection-guide', 'en',
  $o$5 contract tools · 29 typed tools$o$,
  $n$6 contract tools · 50 typed tools$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'cortex-ai-mcp-connection-guide', 'en',
  $o$>Staged as a Live Draft.<$o$,
  $n$>Rewrites staged as Live Drafts.<$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'cortex-ai-mcp-connection-guide', 'en',
  $o$Nothing goes live until publish$o$,
  $n$Draft or publish, with revisions$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'cortex-ai-mcp-connection-guide', 'en',
  $o$The same 29 typed tools$o$,
  $n$The same 50 typed tools$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'cortex-ai-mcp-connection-guide', 'en',
  $o$>Layouts stage as Live Drafts.<$o$,
  $n$>Page rewrites stage as Live Drafts.<$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'cortex-ai-mcp-connection-guide', 'en',
  $o$Layout tools write drafts, so nothing reaches visitors until an editor publishes it.$o$,
  $n$<code>generate_jsonb_layout</code> stages a Live Draft, and <code>create_page_layout</code> saves new pages as drafts unless told otherwise. Other write tools can publish or edit live content, so keep your MCP client&rsquo;s tool-approval prompt on for them.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'cortex-ai-mcp-connection-guide', 'en',
  $o$Five tool names form the public MCP contract.$o$,
  $n$Six tool names form the public MCP contract.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'cortex-ai-mcp-connection-guide', 'en',
  $o$with columns, primary keys, and read-only flags.</p></div>$o$,
  $n$with columns, primary keys, and read-only flags.</p></div><div class='rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-white/5'><div class='flex items-center justify-between gap-3'><code class='rounded-lg bg-violet-50 px-2.5 py-1 text-sm text-violet-700 dark:bg-violet-500/15 dark:text-violet-200'>create_page_layout</code><span class='rounded-full border px-2.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.18em] border-amber-300 text-amber-700 dark:border-amber-500/40 dark:text-amber-200'>write</span></div><p class='mt-3 mb-0 text-sm text-slate-600 dark:text-slate-300'>Creates a new page from a slug, a title, and validated blocks in one call. It stays a draft unless you ask to publish it.</p></div>$n$,
  $u$>create_page_layout</code><span$u$);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'cortex-ai-mcp-connection-guide', 'en',
  $o$<div class='rounded-3xl border border-dashed border-slate-300 p-5 dark:border-white/20'>$o$,
  $n$<div class='rounded-3xl border border-dashed border-slate-300 p-5 md:col-span-2 dark:border-white/20'>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'cortex-ai-mcp-connection-guide', 'en',
  $o$And 24 more.$o$,
  $n$And 44 more.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'cortex-ai-mcp-connection-guide', 'en',
  $o$Three resources expose the database, block, and custom block schemas.</p>$o$,
  $n$Three resources expose the database, block, and custom block schemas. Four prompts (build-site, build-page, clone-from-url, translate-content) script the common jobs.</p>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'cortex-ai-mcp-connection-guide', 'en',
  $o$Open <strong>CMS Settings → Cortex AI</strong>, start the 30-day trial with no credit card, and switch on the MCP server access card.$o$,
  $n$Start the 30-day trial, no credit card, from the welcome screen, the dashboard checklist, or <strong>Administration → Packages</strong>. The Cortex AI setup guide comes next. After activating from Packages, click <strong>Cortex AI</strong> in the sidebar to open it.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'cortex-ai-mcp-connection-guide', 'en',
  $o$Pick the scope you need. Read-only is enough for planning and audits.$o$,
  $n$In the guide, choose <strong>Use my own AI app (MCP)</strong>, then <strong>Enable MCP &amp; continue</strong>. That switches the server on and mints a read + write token. For a read-only token, enough for planning and audits, untick <strong>Allow writes</strong> when you create one on the <strong>MCP server access</strong> card.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'cortex-ai-mcp-connection-guide', 'en',
  $o$The card renders one snippet each for Claude Code, Cursor, VS Code, and Claude Desktop.$o$,
  $n$A tab per client holds values ready to copy: Claude Code (terminal), Claude Code in VS Code, Claude Desktop, Cursor, and VS Code (Copilot).$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'cortex-ai-mcp-connection-guide', 'en',
  $o$<h3>Localhost Configuration Without a Token</h3>$o$,
  $n$<div class='rounded-3xl border border-emerald-200 bg-emerald-50/80 p-6 my-8 dark:border-emerald-500/20 dark:bg-emerald-500/10'><p class='mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200'>Starting from nothing?</p><p class='mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200'>Ask your coding agent to build a site with NextBlock. In Claude Code, first add the plugin that teaches it the steps: <code>/plugin marketplace add nextblock-cms/nextblock</code>, then <code>/plugin install nextblock@nextblock</code>. The agent runs <code>npx create-nextblock@latest my-site --non-interactive</code>, which writes <code>.mcp.json</code> and <code>.cursor/mcp.json</code> with its token. You only create your admin account and start the free 30-day Cortex AI trial in the browser. Then reopen the agent in the project folder so it loads the connection. <a href='/article/how-to-setup-nextblock#ai-agent'>See the agent install steps</a>.</p></div><h3>Localhost Configuration Without a Token</h3>$n$,
  $u$Starting from nothing?$u$);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'cortex-ai-mcp-connection-guide', 'en',
  $o$turn on <strong>Trust localhost without a token</strong> in the same settings card.$o$,
  $n$keep <strong>Trust localhost without a token</strong> checked on the <strong>MCP server access</strong> card (the default).$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'cortex-ai-mcp-connection-guide', 'en',
  $o$Standalone installs run on port 3000, and the monorepo dev server runs on port 4200.$o$,
  $n$In a project scaffolded with create-nextblock, <code>npm run dev</code> serves port 3000. In the monorepo clone, <code>npm run dev</code> (it runs <code>nx serve nextblock</code>) serves port 4200. The local Docker stack also answers on port 3000 by default. It runs a production build, so localhost trust does not apply and every client needs a token. The agent install already writes one into <code>.mcp.json</code> and <code>.cursor/mcp.json</code>.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'cortex-ai-mcp-connection-guide', 'en',
  $o$The agent calls the schema tool, then the layout tool, and your CMS shows a new Live Draft ready for review.$o$,
  $n$The agent reads the schema, then creates the page as a draft with <code>create_page_layout</code>, ready for review in your CMS.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'cortex-ai-mcp-connection-guide', 'en',
  $o$not HTML strings and not source files.$o$,
  $n$not source files.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-connexion-mcp-cortex-ai', 'fr',
  $o$Traduction bloc par bloc et vérifications SEO pendant que vous écrivez.$o$,
  $n$Traductions liées pour chaque page et vérifications SEO pendant que vous écrivez.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-connexion-mcp-cortex-ai', 'fr',
  $o$Server Components · cache en périphérie.$o$,
  $n$Server Components · cache vidé à chaque publication.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-connexion-mcp-cortex-ai', 'fr',
  $o$rend ces enregistrements avec des Server Components et met le résultat en cache en périphérie.$o$,
  $n$rend ces enregistrements avec des Server Components, à partir d'un cache de contenu public vidé à chaque publication.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-connexion-mcp-cortex-ai', 'fr',
  $o$avec un standard ouvert plutôt qu'un plugin propriétaire.$o$,
  $n$avec un standard ouvert, sans connecteur propriétaire.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-connexion-mcp-cortex-ai', 'fr',
  $o$Le CMS est gratuit pour toujours. Cortex AI, qui inclut le serveur MCP$o$,
  $n$Le CMS est gratuit pour toujours et open source. Cortex AI, qui inclut le serveur MCP$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-connexion-mcp-cortex-ai', 'fr',
  $o$>Rien ne part par accident.<$o$,
  $n$>Vous gardez la main.<$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-connexion-mcp-cortex-ai', 'fr',
  $o$Chaque mise en page écrite par l'agent arrive sous forme de brouillon. Un éditeur la révise et clique sur Publier.$o$,
  $n$Les réécritures de page arrivent en brouillon en direct, et les nouvelles pages restent en brouillon sauf si vous demandez de les publier. L'invite d'approbation de votre client MCP et la portée du jeton décident de ce que l'agent peut modifier.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-connexion-mcp-cortex-ai', 'fr',
  $o$Vos éditeurs gardent un CMS visuel, vos développeurs gardent une application Next.js 16 propre, et rien n'est mis en ligne tant que quelqu'un ne clique pas sur Publier.$o$,
  $n$Vos éditeurs gardent un CMS visuel, et vos développeurs gardent une application Next.js 16 propre. Les modifications de l'agent sur les pages, les articles et les produits sont enregistrées comme des révisions que vous pouvez restaurer.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-connexion-mcp-cortex-ai', 'fr',
  $o$get_database_schema</code><code class='block rounded-md bg-white/5 px-3 py-1.5 font-mono text-xs text-violet-100'>generate_jsonb_layout</code>$o$,
  $n$get_database_schema</code><code class='block rounded-md bg-white/5 px-3 py-1.5 font-mono text-xs text-violet-100'>create_page_layout</code><code class='block rounded-md bg-white/5 px-3 py-1.5 font-mono text-xs text-violet-100'>generate_jsonb_layout</code>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-connexion-mcp-cortex-ai', 'fr',
  $o$5 outils de contrat · 29 outils typés$o$,
  $n$6 outils de contrat · 50 outils typés$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-connexion-mcp-cortex-ai', 'fr',
  $o$>Mis en attente comme brouillon en direct.<$o$,
  $n$>Réécritures mises en attente comme brouillon en direct.<$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-connexion-mcp-cortex-ai', 'fr',
  $o$Rien n'est en ligne avant la publication$o$,
  $n$Brouillon ou publication, avec révisions$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-connexion-mcp-cortex-ai', 'fr',
  $o$Les mêmes 29 outils typés$o$,
  $n$Les mêmes 50 outils typés$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-connexion-mcp-cortex-ai', 'fr',
  $o$>Les mises en page attendent en brouillon en direct.<$o$,
  $n$>Les réécritures de page attendent en brouillon en direct.<$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-connexion-mcp-cortex-ai', 'fr',
  $o$Les outils de mise en page écrivent des brouillons : rien n'atteint les visiteurs tant qu'un éditeur ne publie pas.$o$,
  $n$<code>generate_jsonb_layout</code> prépare un brouillon en direct, et <code>create_page_layout</code> enregistre les nouvelles pages en brouillon sauf indication contraire. D'autres outils d'écriture peuvent publier ou modifier du contenu en ligne : gardez activée l'invite d'approbation des outils de votre client MCP.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-connexion-mcp-cortex-ai', 'fr',
  $o$Cinq noms d'outils forment le contrat MCP public.$o$,
  $n$Six noms d'outils forment le contrat MCP public.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-connexion-mcp-cortex-ai', 'fr',
  $o$avec colonnes, clés primaires et indicateurs de lecture seule.</p></div>$o$,
  $n$avec colonnes, clés primaires et indicateurs de lecture seule.</p></div><div class='rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-white/5'><div class='flex items-center justify-between gap-3'><code class='rounded-lg bg-violet-50 px-2.5 py-1 text-sm text-violet-700 dark:bg-violet-500/15 dark:text-violet-200'>create_page_layout</code><span class='rounded-full border px-2.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.18em] border-amber-300 text-amber-700 dark:border-amber-500/40 dark:text-amber-200'>écriture</span></div><p class='mt-3 mb-0 text-sm text-slate-600 dark:text-slate-300'>Crée une nouvelle page à partir d'un slug, d'un titre et de blocs validés, en un seul appel. Elle reste en brouillon, sauf si vous demandez de la publier.</p></div>$n$,
  $u$>create_page_layout</code><span$u$);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-connexion-mcp-cortex-ai', 'fr',
  $o$<div class='rounded-3xl border border-dashed border-slate-300 p-5 dark:border-white/20'>$o$,
  $n$<div class='rounded-3xl border border-dashed border-slate-300 p-5 md:col-span-2 dark:border-white/20'>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-connexion-mcp-cortex-ai', 'fr',
  $o$Et 24 autres.$o$,
  $n$Et 44 autres.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-connexion-mcp-cortex-ai', 'fr',
  $o$Trois ressources exposent les schémas de la base de données, des blocs et des blocs personnalisés.</p>$o$,
  $n$Trois ressources exposent les schémas de la base de données, des blocs et des blocs personnalisés. Quatre prompts (build-site, build-page, clone-from-url, translate-content) automatisent les tâches courantes.</p>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-connexion-mcp-cortex-ai', 'fr',
  $o$Ouvrez <strong>Réglages du CMS → Cortex AI</strong>, lancez l'essai de 30 jours sans carte de crédit et activez la carte d'accès au serveur MCP.$o$,
  $n$Lancez l'essai de 30 jours, sans carte de crédit, depuis l'écran d'accueil, la checklist de démarrage du tableau de bord ou <strong>Administration → Packages</strong>. Le guide de configuration de Cortex AI s'affiche ensuite. Après une activation depuis Packages, cliquez sur <strong>Cortex AI</strong> dans la barre latérale pour l'ouvrir.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-connexion-mcp-cortex-ai', 'fr',
  $o$Choisissez la portée dont vous avez besoin. La lecture seule suffit pour la planification et les audits.$o$,
  $n$Dans le guide, choisissez <strong>Use my own AI app (MCP)</strong>, puis <strong>Enable MCP &amp; continue</strong>. Le serveur s'active et un jeton lecture + écriture est créé. Pour un jeton en lecture seule, suffisant pour la planification et les audits, décochez <strong>Allow writes</strong> en le créant dans la carte <strong>MCP server access</strong>.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-connexion-mcp-cortex-ai', 'fr',
  $o$La carte affiche un extrait pour chacun : Claude Code, Cursor, VS Code et Claude Desktop.$o$,
  $n$Un onglet par client offre des valeurs prêtes à copier : Claude Code (terminal), Claude Code dans VS Code, Claude Desktop, Cursor et VS Code (Copilot).$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-connexion-mcp-cortex-ai', 'fr',
  $o$<h3>Configuration localhost sans jeton</h3>$o$,
  $n$<div class='rounded-3xl border border-emerald-200 bg-emerald-50/80 p-6 my-8 dark:border-emerald-500/20 dark:bg-emerald-500/10'><p class='mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200'>Vous partez de zéro ?</p><p class='mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200'>Demandez à votre agent de code de créer un site avec NextBlock. Dans Claude Code, ajoutez d'abord le plugin qui lui apprend la marche à suivre : <code>/plugin marketplace add nextblock-cms/nextblock</code>, puis <code>/plugin install nextblock@nextblock</code>. L'agent lance <code>npx create-nextblock@latest mon-site --non-interactive</code>, qui écrit <code>.mcp.json</code> et <code>.cursor/mcp.json</code> avec son jeton. Il ne vous reste qu'à créer votre compte administrateur et à lancer l'essai gratuit de 30 jours de Cortex AI dans le navigateur. Rouvrez ensuite l'agent dans le dossier du projet pour qu'il charge la connexion. <a href='/article/comment-configurer-nextblock#ai-agent'>Voir les étapes de l'installation par agent</a>.</p></div><h3>Configuration localhost sans jeton</h3>$n$,
  $u$Vous partez de zéro ?$u$);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-connexion-mcp-cortex-ai', 'fr',
  $o$activez <strong>Faire confiance à localhost sans jeton</strong> dans la même carte de réglages.$o$,
  $n$laissez cochée l'option <strong>Trust localhost without a token</strong> (faire confiance à localhost sans jeton), activée par défaut dans la carte <strong>MCP server access</strong>.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-connexion-mcp-cortex-ai', 'fr',
  $o$Les installations autonomes tournent sur le port 3000, et le serveur de développement du monorepo sur le port 4200.$o$,
  $n$Dans un projet créé avec create-nextblock, <code>npm run dev</code> utilise le port 3000. Dans le clone du monorepo, <code>npm run dev</code> (qui lance <code>nx serve nextblock</code>) utilise le port 4200. La pile Docker locale répond aussi sur le port 3000 par défaut. Elle exécute un build de production : la confiance localhost ne s'y applique pas, et chaque client doit fournir un jeton. L'installation par agent en écrit déjà un dans <code>.mcp.json</code> et <code>.cursor/mcp.json</code>.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-connexion-mcp-cortex-ai', 'fr',
  $o$L'agent appelle l'outil de schéma, puis l'outil de mise en page, et votre CMS affiche un nouveau brouillon en direct prêt pour la révision.$o$,
  $n$L'agent lit le schéma, puis crée la page en brouillon avec <code>create_page_layout</code>, prête à être relue dans votre CMS.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'guide-connexion-mcp-cortex-ai', 'fr',
  $o$pas des chaînes HTML ni des fichiers source.$o$,
  $n$pas des fichiers source.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'nextblock-cortex-ai-guide', 'en',
  $o$>Model routing</p>$o$,
  $n$>Model choice</p>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'nextblock-cortex-ai-guide', 'en',
  $o$Route your prompts through OpenRouter or your own provider to balance speed and price.$o$,
  $n$Plug in your own OpenRouter key and pick one model for the whole site: free models with automatic fallback, or a paid model you choose.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'nextblock-cortex-ai-guide', 'en',
  $o$<h2>Model Routing and Cost Control</h2>$o$,
  $n$<h2>Model Choice and Cost Control</h2>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'nextblock-cortex-ai-guide', 'en',
  $o$Cortex AI gives you full control over your models. You can pick fast models for quick drafts and stronger models for technical articles. You manage your API keys on the server, so your writers can focus on good content.$o$,
  $n$Cortex AI runs on OpenRouter, and you pick one model for the whole site in the Cortex AI settings. Free models are the default, with automatic fallback when one is busy. They still need an OpenRouter key, but a free OpenRouter account is enough. To pick a paid model, save your key in the CMS. You manage that key on the server, so your writers can focus on good content.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'nextblock-cortex-ai-guide', 'en',
  $o$<li>Use quick models for rewrites, titles, and summaries.</li>$o$,
  $n$<li>Start on free models at no model cost.</li>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'nextblock-cortex-ai-guide', 'en',
  $o$<li>Use top models for long guides and difficult translations.</li>$o$,
  $n$<li>Switch the site to a stronger paid model whenever you need more quality.</li>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'nextblock-cortex-ai-guide', 'en',
  $o$<li>Keep provider keys safe in your private server settings.</li>$o$,
  $n$<li>Keep your OpenRouter key encrypted in the CMS settings.</li>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'nextblock-cortex-ai-guide', 'en',
  $o$<p>Cortex AI turns your CMS into a faster creative workshop.$o$,
  $n$<h2>Two Ways to Use Cortex AI</h2>
<p>Cortex AI works in two places. <strong>AI inside the editor</strong> drafts, rewrites, and translates blocks with your own OpenRouter key, free models included. <strong>The MCP server</strong> lets your own AI app, such as Claude Code or Cursor, build pages on the plan you already pay for. <a href='/article/cortex-ai-mcp-connection-guide'>Connect your AI app over MCP</a>.</p>
<p>The NextBlock CMS is free and open source under the AGPL. Both surfaces are part of Cortex AI, which starts with a 30-day free trial and needs no credit card.</p>

<p>Cortex AI turns your CMS into a faster creative workshop.$n$,
  $u$<h2>Two Ways to Use Cortex AI</h2>$u$);

-- ========================================================================================
-- home-articles
-- ========================================================================================

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'home', 'en',
  $o$then start the free Cortex AI trial in CMS Settings.$o$,
  $n$then start the free Cortex AI trial from the welcome screen or Administration &rarr; Packages.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'home', 'en',
  $o$Ask for a landing page. The agent calls generate_jsonb_layout and the result lands as a Live Draft made of validated blocks.$o$,
  $n$Ask for a new page. The agent calls create_page_layout and the page is saved as a draft made of validated blocks.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'home', 'en',
  $o$One click deploys to Vercel, and you are prompting your own site in ten minutes.$o$,
  $n$One click deploys to Vercel, and you are prompting your own site in ten minutes. You can also let Claude Code, Cursor, or Codex build it for you.$n$,
  $u$let Claude Code, Cursor, or Codex build it$u$);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'home', 'en',
  $o$Per-block translation and SEO graded as you type.$o$,
  $n$Linked translations for every page and SEO graded as you type.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'home', 'en',
  $o$>Cortex AI runs on the Claude, ChatGPT, Cursor, or Gemini subscription you already pay for. The license$o$,
  $n$>Over MCP, Cortex AI runs on the Claude, ChatGPT, Cursor, or Gemini subscription you already pay for. Inside the editor, it uses your own OpenRouter key, free models included. The license$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'home', 'en',
  $o$mx-auto mb-10'>Three steps take you from a fresh deploy to published pages, in about ten minutes.</p>$o$,
  $n$mx-auto mb-4'>Three steps take you from a fresh deploy to published pages, in about ten minutes.</p><p class='text-base text-slate-400 text-center max-w-2xl mx-auto mb-10'>Rather let an agent do the install? Ask Claude Code or Cursor to build your site with NextBlock. The agent runs <code class='rounded bg-white/10 px-1.5 py-0.5 font-mono text-xs text-cyan-200'>npx create-nextblock@latest my-site --non-interactive</code>, which starts the site on Docker by default and writes the MCP config the agent needs. You create your admin account and start the free Cortex AI trial in the browser, then the agent builds your pages over MCP. <a href='/article/how-to-setup-nextblock#ai-agent' class='font-semibold text-cyan-300 underline hover:text-white'>Read the agent install guide</a>.</p>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'home', 'en',
  $o$Slash commands, drag and drop, and inline AI on every block.$o$,
  $n$Slash commands, drag and drop, and inline Cortex AI in every text block.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'home', 'en',
  $o$Server Components, ISR, and edge caching out of the box.$o$,
  $n$Server Components, a public content cache that clears the moment you publish, and long-lived CDN caching for images.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'home', 'en',
  $o$Real-time FX rates, rounding modes$o$,
  $n$Daily FX rate sync, rounding modes$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'home', 'en',
  $o$The license buys the connection, never the tokens, and nothing goes live until an editor publishes it.$o$,
  $n$The license buys the connection, never the tokens. A read-only MCP token never even sees the write tools, and page edits are saved as revisions you can restore.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'home', 'en',
  $o$A community marketplace gives developers room to publish$o$,
  $n$A planned community marketplace will give developers room to publish$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'accueil', 'fr',
  $o$puis lancez l'essai gratuit de Cortex AI dans les réglages du CMS.$o$,
  $n$puis lancez l'essai gratuit de Cortex AI depuis l'écran d'accueil ou Administration &rarr; Packages.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'accueil', 'fr',
  $o$Demandez une page d'accueil. L'agent appelle generate_jsonb_layout et le résultat arrive sous forme de brouillon en direct composé de blocs validés.$o$,
  $n$Demandez une nouvelle page. L'agent appelle create_page_layout et la page est enregistrée en brouillon, composée de blocs validés.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'accueil', 'fr',
  $o$Un clic déploie sur Vercel, et vous promptez votre propre site en dix minutes.$o$,
  $n$Un clic déploie sur Vercel, et vous promptez votre propre site en dix minutes. Vous pouvez aussi laisser Claude Code, Cursor ou Codex le bâtir pour vous.$n$,
  $u$laisser Claude Code, Cursor ou Codex le bâtir$u$);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'accueil', 'fr',
  $o$Traduction bloc par bloc et SEO noté pendant que vous écrivez.$o$,
  $n$Traductions liées pour chaque page et SEO noté pendant que vous écrivez.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'accueil', 'fr',
  $o$>Cortex AI fonctionne avec l'abonnement Claude, ChatGPT, Cursor ou Gemini que vous payez déjà. La licence$o$,
  $n$>Via MCP, Cortex AI fonctionne avec l'abonnement Claude, ChatGPT, Cursor ou Gemini que vous payez déjà. Dans l'éditeur, l'IA utilise votre propre clé OpenRouter, modèles gratuits compris. La licence$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'accueil', 'fr',
  $o$mx-auto mb-10'>Trois étapes vous mènent d'un déploiement neuf à des pages publiées, en une dizaine de minutes.</p>$o$,
  $n$mx-auto mb-4'>Trois étapes vous mènent d'un déploiement neuf à des pages publiées, en une dizaine de minutes.</p><p class='text-base text-slate-400 text-center max-w-2xl mx-auto mb-10'>Vous préférez confier l'installation à un agent ? Demandez à Claude Code ou à Cursor de créer votre site avec NextBlock. L'agent lance <code class='rounded bg-white/10 px-1.5 py-0.5 font-mono text-xs text-cyan-200'>npx create-nextblock@latest mon-site --non-interactive</code>, qui démarre le site sur Docker par défaut et écrit la configuration MCP dont l'agent a besoin. Vous créez votre compte administrateur et lancez l'essai gratuit de Cortex AI dans le navigateur, puis l'agent bâtit vos pages via MCP. <a href='/article/comment-configurer-nextblock#ai-agent' class='font-semibold text-cyan-300 underline hover:text-white'>Lire le guide d'installation par agent</a>.</p>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'accueil', 'fr',
  $o$Commandes slash, glisser-déposer et IA intégrée sur chaque bloc.$o$,
  $n$Commandes slash, glisser-déposer et Cortex AI directement dans chaque bloc de texte.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'accueil', 'fr',
  $o$Server Components, ISR et cache en périphérie, prêts à l'emploi.$o$,
  $n$Server Components, cache de contenu public vidé à chaque publication et cache CDN longue durée pour les images.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'accueil', 'fr',
  $o$https://nextblock.dev/product/nextblock-commerce-pro-commerce-license$o$,
  $n$https://nextblock.dev/product/nextblock-commerce-pro-commerce-license-fr$n$,
  $u$commerce-license-fr$u$);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'accueil', 'fr',
  $o$Taux de change en temps réel, modes d'arrondi$o$,
  $n$Taux de change synchronisés chaque jour, modes d'arrondi$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'accueil', 'fr',
  $o$La licence achète la connexion, jamais les jetons, et rien n'est mis en ligne tant qu'un éditeur ne l'a pas publié.$o$,
  $n$La licence achète la connexion, jamais les jetons. Un jeton MCP en lecture seule ne voit même pas les outils d'écriture, et les modifications de pages sont enregistrées sous forme de révisions que vous pouvez restaurer.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'accueil', 'fr',
  $o$alt='Tableau de roadmap montrant la direction de l'ecosysteme NextBlock™ et des modules premium'$o$,
  $n$alt='Feuille de route montrant la direction de l&rsquo;écosystème NextBlock™ et des modules premium'$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'accueil', 'fr',
  $o$Un espace partagé permet aux développeurs$o$,
  $n$Un futur espace partagé permettra aux développeurs$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'articles', 'en',
  $o$alt='Developer working with the Nextblock stack'$o$,
  $n$alt='Developer working with the NextBlock stack'$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'articles', 'en',
  $o$Walkthroughs for one-click Vercel deploys, local Docker environments, and custom cloud stacks.$o$,
  $n$Walkthroughs for a one-click Vercel deploy, the npm create nextblock CLI (local Docker, or your own Supabase project with optional Cloudflare R2), and a git clone. You can also let Claude Code, Cursor, or Codex install NextBlock and build the site for you.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'articles', 'fr',
  $o$Cortex AI offre un essai de 30 jours sans carte bancaire.$o$,
  $n$Cortex AI offre un essai gratuit de 30 jours, sans carte de crédit.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'articles', 'fr',
  $o$Le journal Nextblock$o$,
  $n$Le journal NextBlock$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'articles', 'fr',
  $o$alt='Développeur travaillant avec la stack Nextblock'$o$,
  $n$alt='Développeur travaillant avec la stack NextBlock'$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'articles', 'fr',
  $o$Des guides pas à pas pour un déploiement Vercel en un clic, un Docker local ou votre propre cloud.$o$,
  $n$Des guides pas à pas pour un déploiement Vercel en un clic, le CLI npm create nextblock (Docker local, ou votre propre projet Supabase avec Cloudflare R2 facultatif) et un clone du dépôt. Vous pouvez aussi laisser Claude Code, Cursor ou Codex installer NextBlock et bâtir le site pour vous.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('page', 'articles', 'fr',
  $o$href='/article/cortex-ai-mcp-connection-guide'$o$,
  $n$href='/article/guide-connexion-mcp-cortex-ai'$n$,
  NULL);

-- ========================================================================================
-- install-guide
-- ========================================================================================

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-to-setup-nextblock', 'en',
  $o$Below are four ways to get running, <strong>ordered from the simplest to the most hands-on</strong>: the first is a single click, the last is the full source for people who want to help build NextBlock.$o$,
  $n$Below are five ways to get running. The first four are <strong>ordered from the simplest to the most hands-on</strong>: the first is a single click, the fourth is the full source for people who want to help build NextBlock. The fifth hands the whole job to the AI coding agent you already use.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-to-setup-nextblock', 'en',
  $o$<h2 class='mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white'>npm create nextblock &rarr; Supabase + R2</h2>$o$,
  $n$<h2 class='mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white'>npm create nextblock &rarr; your own Supabase</h2>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-to-setup-nextblock', 'en',
  $o$Scaffold a standalone app on your own managed Supabase project and Cloudflare R2, ready to deploy anywhere.$o$,
  $n$Scaffold a standalone app on your own managed Supabase project (Cloudflare R2 optional), ready to deploy anywhere.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-to-setup-nextblock', 'en',
  $o$<p class='mb-0 text-sm leading-6 text-slate-600 dark:text-slate-300'>Run the complete monorepo — the CMS, every package, and the docs. For people who want to help build NextBlock (Docker works here too).</p>$o$,
  $n$<p class='mb-0 text-sm leading-6 text-slate-600 dark:text-slate-300'>Run the complete monorepo — the CMS, every package, and the docs. For people who want to help build NextBlock (Docker works here too).</p>
  </a>
  <a href='#ai-agent' class='block rounded-[1.75rem] border border-rose-200 bg-rose-50/70 p-6 no-underline transition-shadow hover:shadow-lg md:col-span-2 dark:border-rose-500/20 dark:bg-rose-500/10'>
    <div class='flex items-center justify-between mb-4'>
      <span class='flex h-9 w-9 items-center justify-center rounded-full bg-rose-600 text-sm font-bold text-white'>5</span>
      <span class='rounded-full border border-rose-300 px-3 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-rose-700 dark:border-rose-500/20 dark:text-rose-200'>New</span>
    </div>
    <p class='mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-rose-700 dark:text-rose-200'>Hands-off &middot; your AI coding agent</p>
    <h2 class='mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white'>Ask your coding agent to build it</h2>
    <p class='mb-0 text-sm leading-6 text-slate-600 dark:text-slate-300'>Ask Claude Code, Cursor, or Codex for a website. It installs NextBlock, you create your admin in the browser, and it builds the pages over MCP.</p>$n$,
  $u$<a href='#ai-agent' class=$u$);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-to-setup-nextblock', 'en',
  $o$Most people should start with <a href='#one-click-vercel'>Vercel</a>.</p>$o$,
  $n$Most people should start with <a href='#one-click-vercel'>Vercel</a>. Already working with an AI coding agent? Jump to <a href='#ai-agent'>Option 5</a>.</p>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-to-setup-nextblock', 'en',
  $o$It is confirmed instantly — no verification email — and you land in the CMS dashboard.</li>$o$,
  $n$It is confirmed instantly — no verification email — and you land on a welcome screen that offers the free 30-day Cortex AI trial. Choose <em>Not now, take me to my CMS</em> to go straight to the dashboard.</li>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-to-setup-nextblock', 'en',
  $o$the only thing left is creating your administrator (confirmed instantly, no email required). You land in the CMS dashboard.</li>$o$,
  $n$the only thing left is creating your administrator (confirmed instantly, no email required). You then land on the same welcome screen and its Cortex AI trial offer.</li>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-to-setup-nextblock', 'en',
  $o$Docker mode is offered only in the interactive prompt — don&rsquo;t pass <code>--yes</code>, which forces the managed-cloud path below.$o$,
  $n$Don&rsquo;t pass <code>--yes</code> here: it skips the prompt and takes the managed-cloud path below. The agent-oriented <code>--non-interactive</code> flag in <a href='#ai-agent'>Option 5</a> is different: it boots this Docker stack by default.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-to-setup-nextblock', 'en',
  $o$<h2 id='npm-cloud'>Option 3: npm create nextblock &rarr; Your Own Supabase + Cloudflare</h2>$o$,
  $n$<h2 id='npm-cloud'>Option 3: npm create nextblock &rarr; Your Own Supabase Cloud</h2>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-to-setup-nextblock', 'en',
  $o$Best for building your own site on managed cloud. Needs a Supabase project and an R2 bucket.$o$,
  $n$Best for building your own site on managed cloud. Needs a Supabase project; a Cloudflare R2 bucket is optional.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-to-setup-nextblock', 'en',
  $o$pointed at a Supabase project and Cloudflare R2 bucket you control, and it deploys anywhere Next.js runs.$o$,
  $n$pointed at a Supabase project you control (plus an optional Cloudflare R2 bucket for media), and it deploys anywhere Next.js runs.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-to-setup-nextblock', 'en',
  $o$, create a free project at <a href='https://supabase.com' target='_blank' rel='noopener'>supabase.com</a>, and set up a <a href='https://developers.cloudflare.com/r2/' target='_blank' rel='noopener'>Cloudflare R2</a> bucket for your images and files.</p>$o$,
  $n$ and create a free project at <a href='https://supabase.com' target='_blank' rel='noopener'>supabase.com</a>. A <a href='https://developers.cloudflare.com/r2/' target='_blank' rel='noopener'>Cloudflare R2</a> bucket for images and files is optional but recommended, because its free tier is larger. Without one, media is stored in your project&rsquo;s Supabase Storage.</p>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-to-setup-nextblock', 'en',
  $o$At the first prompt, choose <em>Managed Cloud Mode (Vercel + Supabase Cloud)</em> and name your project.$o$,
  $n$At the first prompt, choose <em>Managed Cloud Mode (Vercel + Supabase Cloud)</em>; the project takes the folder name you passed (<code>my-site</code>).$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-to-setup-nextblock', 'en',
  $o$<li><strong>Add Cloudflare R2</strong> — enter your R2 account ID, bucket name, access key ID, secret access key, and the bucket&rsquo;s public URL for serving images and files.</li>$o$,
  $n$<li><strong>Media storage (optional)</strong> — to use Cloudflare R2, enter your R2 account ID, bucket name, access key ID, secret access key, and the bucket&rsquo;s public URL. Leave the fields blank to keep media in your project&rsquo;s Supabase Storage.</li>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-to-setup-nextblock', 'en',
  $o$creates your confirmed admin account, and signs you in. Restart <code>npm run dev</code> once afterwards so the fresh environment is baked into the app.</li>$o$,
  $n$creates your confirmed admin account, and signs you in. No restart is needed unless you serve media from a custom domain.</li>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-to-setup-nextblock', 'en',
  $o$Need a store? One command adds products, checkout, orders, and coupons — license-gated and ready when you are: <code>npx create-nextblock activate ecommerce</code>$o$,
  $n$Need a store? <strong>NextBlock™ Commerce Pro</strong> — products, checkout, orders, and coupons — already ships in every install. Start its free 30-day trial (no credit card) or enter a license key in the CMS under <strong>Administration &rarr; Packages</strong>.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-to-setup-nextblock', 'en',
  $o$npx nx serve nextblock</code></pre>$o$,
  $n$npm run dev</code></pre>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-to-setup-nextblock', 'en',
  $o$<p>Open <code>http://localhost:4200</code> — a fresh install redirects every page to <code>/setup</code>$o$,
  $n$<p><code>npm run dev</code> starts the CMS through Nx (it runs <code>npx nx serve nextblock</code> for you). Open <code>http://localhost:4200</code> — a fresh install redirects every page to <code>/setup</code>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-to-setup-nextblock', 'en',
  $o$Note the monorepo has no <code>npm run dev</code> — use <code>npx nx serve nextblock</code> (port 4200) for the cloud path.$o$,
  $n$For the cloud path instead, <code>npm run dev</code> starts the app on <code>http://localhost:4200</code>.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-to-setup-nextblock', 'en',
  $o$<h2 id='after-install'>After You Install: Your First 10 Minutes</h2>$o$,
  $n$<h2 id='ai-agent'>Option 5: Let Your AI Coding Agent Install It</h2>
<p class='mt-2 mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm'><span class='inline-flex items-center gap-2 rounded-full border border-rose-200 bg-rose-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-200'>Step 5 &middot; Hands-off</span><span class='text-slate-500 dark:text-slate-400'>Best if you already work with Claude Code, Cursor, or Codex. Needs Node.js and Docker Desktop.</span></p>
<p>You can skip every step above and simply ask. A coding agent that runs commands on your computer can install NextBlock, connect itself to the CMS, and build your pages from a plain-language brief. Try this: &ldquo;Build me a landing page for my bakery with NextBlock.&rdquo; Behind the scenes, the agent runs the installer&rsquo;s hands-free mode:</p>
<pre><code>npx create-nextblock@latest my-site --non-interactive</code></pre>
<ol class='space-y-2'>
  <li><strong>The agent installs the site.</strong> The installer scaffolds the project, boots the local Docker stack, and writes the MCP connection files the agent needs.</li>
  <li><strong>You do two things in the browser.</strong> Open the setup link the agent gives you (usually <code>http://localhost:3000/setup</code>) and create your administrator account. Then start the free 30-day Cortex AI trial on the welcome screen, with no credit card. Your name, email, and password never pass through the agent.</li>
  <li><strong>The agent builds your pages.</strong> Once the site reports ready, reopen the agent in the new project folder so it loads that connection. It then creates pages, menus, and images through the <a href='/article/cortex-ai-mcp-connection-guide'>NextBlock MCP server</a>, and you keep editing everything in the CMS.</li>
</ol>
<div class='rounded-3xl border border-rose-200 bg-rose-50/70 p-6 my-8 dark:border-rose-500/20 dark:bg-rose-500/10'>
  <p class='mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-rose-700 dark:text-rose-200'>Recommended &middot; add the NextBlock plugin</p>
  <p class='mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200'>With the plugin, your agent knows the whole routine and suggests NextBlock when you ask it for a website. In Claude Code, run <code>/plugin marketplace add nextblock-cms/nextblock</code>, then <code>/plugin install nextblock@nextblock</code>.</p>
  <p class='mt-4 mb-0 text-sm text-slate-700 dark:text-slate-200'>In Cursor, add it from the NextBlock GitHub repository under <strong>Customize &rarr; Plugins</strong>. For Codex and other agents, paste <a href='https://github.com/nextblock-cms/nextblock/blob/master/plugins/AGENTS.snippet.md' target='_blank' rel='noopener'>this snippet</a> into your <code>AGENTS.md</code>. No plugin? Name NextBlock in your request, and point the agent to <code>nextblock.dev/llms.txt</code> if it needs the steps.</p>
</div>
<p>You need Node.js 22.12+, a coding agent, and Docker Desktop running. No Docker? Ask for <code>--mode cloud</code>. The agent scaffolds the project and starts it with <code>npm run dev</code>, and you connect your own Supabase project in the setup wizard, as in Option 3. The MCP server is part of Cortex AI, which is why the trial comes first. The CMS itself stays free either way.</p>

<h2 id='after-install'>After You Install: Your First 10 Minutes</h2>$n$,
  $u$<h2 id='ai-agent'>$u$);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-to-setup-nextblock', 'en',
  $o$Every path drops you at <code>/cms/dashboard</code>, signed in as the first administrator. A built-in onboarding checklist walks you through the rest:$o$,
  $n$Every path signs you in as the first administrator and opens a welcome screen that offers the free 30-day Cortex AI trial (no credit card). Start it, or choose <em>Not now, take me to my CMS</em> to go to <code>/cms/dashboard</code>. A built-in onboarding checklist walks you through the rest:$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-to-setup-nextblock', 'en',
  $o$<li><strong>Add your branding</strong> — upload your logo and set the site title.</li>$o$,
  $n$<li><strong>Build your site with Cortex AI</strong> — answer a few questions, and Cortex replaces the sample content with your own pages, menus, and branding (free 30-day trial, no credit card).</li>
  <li><strong>Add your branding</strong> — upload your logo and set the site title.</li>$n$,
  $u$<li><strong>Build your site with Cortex AI</strong>$u$);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-to-setup-nextblock', 'en',
  $o$and (on Vercel) turn on automatic updates.</li>$o$,
  $n$and (on a Vercel one-click deploy or a GitHub fork) turn on automatic updates.</li>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-to-setup-nextblock', 'en',
  $o$or meet your AI copilot in the <a href='/article/nextblock-cortex-ai-guide'>Cortex AI guide</a>.$o$,
  $n$or put Cortex AI to work with the <a href='/article/nextblock-cortex-ai-guide'>Cortex AI guide</a> and the <a href='/article/cortex-ai-mcp-connection-guide'>MCP connection guide</a>.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-to-setup-nextblock', 'en',
  $o$For the managed-cloud path: Node.js 22.12+ plus a Supabase project and a Cloudflare R2 bucket.$o$,
  $n$For the managed-cloud path: Node.js 22.12+ plus a Supabase project (a Cloudflare R2 bucket is optional).$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-to-setup-nextblock', 'en',
  $o$(add Docker Desktop if you want to run the local stack).</p>$o$,
  $n$(add Docker Desktop if you want to run the local stack). For your coding agent: Node.js 22.12+ and Docker Desktop, or a Supabase project with <code>--mode cloud</code>.</p>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-to-setup-nextblock', 'en',
  $o$Premium packages such as e-commerce and Cortex AI are optional and activate with a license key.$o$,
  $n$The premium packages, Commerce Pro and Cortex AI, are optional: each starts with a free 30-day trial (no credit card) and then needs a license key.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-to-setup-nextblock', 'en',
  $o$<h3>How do I update NextBlock?</h3>$o$,
  $n$<h3>Can an AI agent install and build my site?</h3>
<p>Yes. Claude Code, Cursor, Codex, and other coding agents can run the installer for you, then build every page over the MCP server. You only create your admin account and start the Cortex AI trial. See <a href='#ai-agent'>Option 5</a>.</p>
<h3>How do I update NextBlock?</h3>$n$,
  $u$<h3>Can an AI agent install and build my site?</h3>$u$);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-to-setup-nextblock', 'en',
  $o$On a cloned repository, <code>git pull</code>, run <code>npm run db:migrate</code>, then restart (on production builds, pending migrations apply automatically). With Docker, pull the latest code and run <code>npm run docker:up</code>.$o$,
  $n$Everywhere else, one command updates the code, the dependencies, and the database schema: <code>npm run update</code>. On Docker, follow it with <code>npm run docker:up</code>. <a href='/article/how-updating-works'>How Updating NextBlock Works</a> covers every path.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-configurer-nextblock', 'fr',
  $o$Voici quatre façons de démarrer, <strong>classées de la plus simple à la plus technique</strong> : la première tient en un clic, la dernière donne le code source complet pour celles et ceux qui veulent participer à NextBlock.$o$,
  $n$Voici cinq façons de démarrer. Les quatre premières sont <strong>classées de la plus simple à la plus technique</strong> : la première tient en un clic, la quatrième donne le code source complet pour celles et ceux qui veulent participer à NextBlock. La cinquième confie tout le travail à l'agent de code IA que vous utilisez déjà.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-configurer-nextblock', 'fr',
  $o$<h2 class='mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white'>npm create nextblock &rarr; Supabase + R2</h2>$o$,
  $n$<h2 class='mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white'>npm create nextblock &rarr; votre propre Supabase</h2>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-configurer-nextblock', 'fr',
  $o$Générez une app autonome sur votre propre projet Supabase géré et Cloudflare R2, prête à déployer partout.$o$,
  $n$Générez une app autonome sur votre propre projet Supabase géré (Cloudflare R2 facultatif), prête à déployer partout.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-configurer-nextblock', 'fr',
  $o$<p class='mb-0 text-sm leading-6 text-slate-600 dark:text-slate-300'>Faites tourner le monorepo complet — le CMS, tous les packages et la documentation. Pour celles et ceux qui veulent aider à construire NextBlock (Docker fonctionne ici aussi).</p>$o$,
  $n$<p class='mb-0 text-sm leading-6 text-slate-600 dark:text-slate-300'>Faites tourner le monorepo complet — le CMS, tous les packages et la documentation. Pour celles et ceux qui veulent aider à construire NextBlock (Docker fonctionne ici aussi).</p>
  </a>
  <a href='#ai-agent' class='block rounded-[1.75rem] border border-rose-200 bg-rose-50/70 p-6 no-underline transition-shadow hover:shadow-lg md:col-span-2 dark:border-rose-500/20 dark:bg-rose-500/10'>
    <div class='flex items-center justify-between mb-4'>
      <span class='flex h-9 w-9 items-center justify-center rounded-full bg-rose-600 text-sm font-bold text-white'>5</span>
      <span class='rounded-full border border-rose-300 px-3 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-rose-700 dark:border-rose-500/20 dark:text-rose-200'>Nouveau</span>
    </div>
    <p class='mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-rose-700 dark:text-rose-200'>Sans effort &middot; votre agent de code IA</p>
    <h2 class='mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white'>Demandez à votre agent de le construire</h2>
    <p class='mb-0 text-sm leading-6 text-slate-600 dark:text-slate-300'>Demandez un site web à Claude Code, Cursor ou Codex. Il installe NextBlock, vous créez votre admin dans le navigateur, et il construit les pages via MCP.</p>$n$,
  $u$<a href='#ai-agent' class=$u$);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-configurer-nextblock', 'fr',
  $o$La plupart des gens devraient commencer par <a href='#one-click-vercel'>Vercel</a>.</p>$o$,
  $n$La plupart des gens devraient commencer par <a href='#one-click-vercel'>Vercel</a>. Vous travaillez déjà avec un agent de code IA ? Passez directement à l'<a href='#ai-agent'>option 5</a>.</p>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-configurer-nextblock', 'fr',
  $o$Il est confirmé instantanément — aucun email de vérification — et vous arrivez dans le tableau de bord du CMS.</li>$o$,
  $n$Il est confirmé instantanément — aucun email de vérification — et vous arrivez sur un écran d'accueil qui propose l'essai gratuit de 30 jours de Cortex AI. Choisissez <em>Not now, take me to my CMS</em> pour aller directement au tableau de bord.</li>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-configurer-nextblock', 'fr',
  $o$il ne reste qu'à créer votre administrateur (confirmé instantanément, sans email). Vous arrivez dans le tableau de bord du CMS.</li>$o$,
  $n$il ne reste qu'à créer votre administrateur (confirmé instantanément, sans email). Vous arrivez ensuite sur le même écran d'accueil et son offre d'essai de Cortex AI.</li>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-configurer-nextblock', 'fr',
  $o$Le mode Docker n'est proposé que dans le prompt interactif — ne passez pas <code>--yes</code>, qui force le mode cloud géré ci-dessous.$o$,
  $n$Ne passez pas <code>--yes</code> ici : il saute le prompt et prend le mode cloud géré ci-dessous. L'option <code>--non-interactive</code> de l'<a href='#ai-agent'>option 5</a>, pensée pour les agents, est différente : elle démarre cette pile Docker par défaut.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-configurer-nextblock', 'fr',
  $o$<h2 id='npm-cloud'>Option 3 : npm create nextblock &rarr; votre propre Supabase + Cloudflare</h2>$o$,
  $n$<h2 id='npm-cloud'>Option 3 : npm create nextblock &rarr; votre propre Supabase</h2>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-configurer-nextblock', 'fr',
  $o$Idéal pour construire votre propre site sur du cloud géré. Nécessite un projet Supabase et un bucket R2.$o$,
  $n$Idéal pour construire votre propre site sur du cloud géré. Nécessite un projet Supabase ; un bucket Cloudflare R2 est facultatif.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-configurer-nextblock', 'fr',
  $o$reliée à un projet Supabase et un bucket Cloudflare R2 que vous contrôlez, et elle se déploie partout où Next.js tourne.$o$,
  $n$reliée à un projet Supabase que vous contrôlez (plus un bucket Cloudflare R2 facultatif pour les médias), et elle se déploie partout où Next.js tourne.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-configurer-nextblock', 'fr',
  $o$, créez un projet gratuit sur <a href='https://supabase.com' target='_blank' rel='noopener'>supabase.com</a>, et configurez un bucket <a href='https://developers.cloudflare.com/r2/' target='_blank' rel='noopener'>Cloudflare R2</a> pour vos images et fichiers.</p>$o$,
  $n$ et créez un projet gratuit sur <a href='https://supabase.com' target='_blank' rel='noopener'>supabase.com</a>. Un bucket <a href='https://developers.cloudflare.com/r2/' target='_blank' rel='noopener'>Cloudflare R2</a> pour vos images et fichiers est facultatif mais recommandé, car son offre gratuite est plus généreuse. Sans lui, les médias sont stockés dans le Supabase Storage de votre projet.</p>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-configurer-nextblock', 'fr',
  $o$Au premier prompt, choisissez <em>Managed Cloud Mode (Vercel + Supabase Cloud)</em> et nommez votre projet.$o$,
  $n$Au premier prompt, choisissez <em>Managed Cloud Mode (Vercel + Supabase Cloud)</em> ; le projet prend le nom du dossier indiqué (<code>mon-site</code>).$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-configurer-nextblock', 'fr',
  $o$<li><strong>Ajoutez Cloudflare R2</strong> — saisissez votre identifiant de compte R2, le nom du bucket, la clé d'accès (access key ID), la clé secrète et l'URL publique du bucket pour servir vos images et fichiers.</li>$o$,
  $n$<li><strong>Stockage des médias (facultatif)</strong> — pour utiliser Cloudflare R2, saisissez votre identifiant de compte R2, le nom du bucket, la clé d'accès (access key ID), la clé secrète et l'URL publique du bucket. Laissez les champs vides pour garder les médias dans le Supabase Storage de votre projet.</li>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-configurer-nextblock', 'fr',
  $o$crée votre compte admin confirmé et vous connecte. Redémarrez ensuite <code>npm run dev</code> une fois pour que le nouvel environnement soit intégré à l'application.</li>$o$,
  $n$crée votre compte admin confirmé et vous connecte. Aucun redémarrage n'est nécessaire, sauf si vous servez les médias depuis un domaine personnalisé.</li>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-configurer-nextblock', 'fr',
  $o$Besoin d'une boutique ? Une seule commande ajoute produits, paiement, commandes et coupons — activés par clé de licence, prêts quand vous l'êtes : <code>npx create-nextblock activate ecommerce</code>$o$,
  $n$Besoin d'une boutique ? <strong>NextBlock™ Commerce Pro</strong> — produits, paiement, commandes et coupons — est déjà inclus dans chaque installation. Lancez son essai gratuit de 30 jours (sans carte de crédit) ou saisissez une clé de licence dans le CMS, sous <strong>Administration &rarr; Packages</strong>.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-configurer-nextblock', 'fr',
  $o$npx nx serve nextblock</code></pre>$o$,
  $n$npm run dev</code></pre>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-configurer-nextblock', 'fr',
  $o$<p>Ouvrez <code>http://localhost:4200</code> — une nouvelle installation redirige chaque page vers <code>/setup</code>$o$,
  $n$<p><code>npm run dev</code> démarre le CMS via Nx (il lance <code>npx nx serve nextblock</code> pour vous). Ouvrez <code>http://localhost:4200</code> — une nouvelle installation redirige chaque page vers <code>/setup</code>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-configurer-nextblock', 'fr',
  $o$Notez que le monorepo n'a pas de <code>npm run dev</code> — utilisez <code>npx nx serve nextblock</code> (port 4200) pour le chemin cloud.$o$,
  $n$Pour le chemin cloud, <code>npm run dev</code> lance plutôt l'application sur <code>http://localhost:4200</code>.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-configurer-nextblock', 'fr',
  $o$<h2 id='after-install'>Après l'installation : vos 10 premières minutes</h2>$o$,
  $n$<h2 id='ai-agent'>Option 5 : Confiez l'installation à votre agent de code IA</h2>
<p class='mt-2 mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm'><span class='inline-flex items-center gap-2 rounded-full border border-rose-200 bg-rose-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-200'>Étape 5 &middot; Sans effort</span><span class='text-slate-500 dark:text-slate-400'>Idéal si vous travaillez déjà avec Claude Code, Cursor ou Codex. Nécessite Node.js et Docker Desktop.</span></p>
<p>Vous pouvez sauter toutes les étapes ci-dessus et simplement demander. Un agent de code qui exécute des commandes sur votre ordinateur peut installer NextBlock, se connecter au CMS et construire vos pages à partir d'une simple description. Essayez : « Crée-moi une page d'accueil pour ma boulangerie avec NextBlock. » En coulisses, l'agent lance l'installateur en mode sans intervention :</p>
<pre><code>npx create-nextblock@latest mon-site --non-interactive</code></pre>
<ol class='space-y-2'>
  <li><strong>L'agent installe le site.</strong> L'installateur crée le projet, démarre la pile Docker locale et écrit les fichiers de connexion MCP dont l'agent a besoin.</li>
  <li><strong>Vous faites deux choses dans le navigateur.</strong> Ouvrez le lien de configuration que l'agent vous donne (en général <code>http://localhost:3000/setup</code>) et créez votre compte administrateur. Démarrez ensuite l'essai gratuit de 30 jours de Cortex AI sur l'écran d'accueil, sans carte de crédit. Votre nom, votre email et votre mot de passe ne passent jamais par l'agent.</li>
  <li><strong>L'agent construit vos pages.</strong> Quand le site se déclare prêt, rouvrez l'agent dans le dossier du nouveau projet pour qu'il charge cette connexion. Il crée alors pages, menus et images via le <a href='/article/guide-connexion-mcp-cortex-ai'>serveur MCP de NextBlock</a>, et vous continuez à tout modifier dans le CMS.</li>
</ol>
<div class='rounded-3xl border border-rose-200 bg-rose-50/70 p-6 my-8 dark:border-rose-500/20 dark:bg-rose-500/10'>
  <p class='mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-rose-700 dark:text-rose-200'>Recommandé &middot; ajoutez le plugin NextBlock</p>
  <p class='mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200'>Avec le plugin, votre agent connaît toute la marche à suivre et propose NextBlock quand vous lui demandez un site web. Dans Claude Code, lancez <code>/plugin marketplace add nextblock-cms/nextblock</code>, puis <code>/plugin install nextblock@nextblock</code>.</p>
  <p class='mt-4 mb-0 text-sm text-slate-700 dark:text-slate-200'>Dans Cursor, ajoutez-le depuis le dépôt GitHub de NextBlock sous <strong>Customize &rarr; Plugins</strong>. Pour Codex et les autres agents, collez <a href='https://github.com/nextblock-cms/nextblock/blob/master/plugins/AGENTS.snippet.md' target='_blank' rel='noopener'>cet extrait</a> dans votre <code>AGENTS.md</code>. Pas de plugin ? Nommez NextBlock dans votre demande et, au besoin, indiquez à l'agent <code>nextblock.dev/llms.txt</code>, qui décrit la marche à suivre.</p>
</div>
<p>Il vous faut Node.js 22.12+, un agent de code et Docker Desktop en marche. Pas de Docker ? Demandez l'option <code>--mode cloud</code>. L'agent crée le projet et le démarre avec <code>npm run dev</code>, puis vous connectez votre propre projet Supabase dans l'assistant, comme à l'option 3. Le serveur MCP fait partie de Cortex AI, d'où l'essai en premier. Le CMS lui-même reste gratuit dans tous les cas.</p>

<h2 id='after-install'>Après l'installation : vos 10 premières minutes</h2>$n$,
  $u$<h2 id='ai-agent'>$u$);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-configurer-nextblock', 'fr',
  $o$Chaque chemin vous dépose sur <code>/cms/dashboard</code>, connecté en tant que premier administrateur. Une checklist de démarrage intégrée vous guide pour la suite :$o$,
  $n$Chaque chemin vous connecte en tant que premier administrateur et ouvre un écran d'accueil qui propose l'essai gratuit de 30 jours de Cortex AI (sans carte de crédit). Démarrez-le, ou choisissez <em>Not now, take me to my CMS</em> pour aller sur <code>/cms/dashboard</code>. Une checklist de démarrage intégrée vous guide pour la suite :$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-configurer-nextblock', 'fr',
  $o$<li><strong>Ajoutez votre identité visuelle</strong> — téléversez votre logo et définissez le titre du site.</li>$o$,
  $n$<li><strong>Construisez votre site avec Cortex AI</strong> — répondez à quelques questions, et Cortex remplace le contenu d'exemple par vos propres pages, menus et identité visuelle (essai gratuit de 30 jours, sans carte de crédit).</li>
  <li><strong>Ajoutez votre identité visuelle</strong> — téléversez votre logo et définissez le titre du site.</li>$n$,
  $u$<li><strong>Construisez votre site avec Cortex AI</strong>$u$);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-configurer-nextblock', 'fr',
  $o$et (sur Vercel) les mises à jour automatiques.</li>$o$,
  $n$et (sur un déploiement Vercel en un clic ou un fork GitHub) les mises à jour automatiques.</li>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-configurer-nextblock', 'fr',
  $o$, ou ajoutez une boutique avec le <a href='/article/guide-commerce-nextblock'>guide Commerce</a>.</p>$o$,
  $n$, ajoutez une boutique avec le <a href='/article/guide-commerce-nextblock'>guide Commerce</a>, ou mettez Cortex AI au travail avec le <a href='/article/guide-connexion-mcp-cortex-ai'>guide de connexion MCP</a>.</p>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-configurer-nextblock', 'fr',
  $o$Pour le mode cloud géré : Node.js 22.12+ ainsi qu'un projet Supabase et un bucket Cloudflare R2.$o$,
  $n$Pour le mode cloud géré : Node.js 22.12+ ainsi qu'un projet Supabase (un bucket Cloudflare R2 est facultatif).$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-configurer-nextblock', 'fr',
  $o$(ajoutez Docker Desktop si vous voulez faire tourner la pile locale).</p>$o$,
  $n$(ajoutez Docker Desktop si vous voulez faire tourner la pile locale). Pour votre agent de code : Node.js 22.12+ et Docker Desktop, ou un projet Supabase avec <code>--mode cloud</code>.</p>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-configurer-nextblock', 'fr',
  $o$Les packages premium comme l'e-commerce et Cortex AI sont optionnels et s'activent avec une clé de licence.$o$,
  $n$Les packages premium, Commerce Pro et Cortex AI, sont optionnels : chacun démarre par un essai gratuit de 30 jours (sans carte de crédit), puis s'active avec une clé de licence.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-configurer-nextblock', 'fr',
  $o$<h3>Comment mettre à jour NextBlock ?</h3>$o$,
  $n$<h3>Un agent IA peut-il installer et construire mon site ?</h3>
<p>Oui. Claude Code, Cursor, Codex et d'autres agents de code peuvent lancer l'installateur pour vous, puis construire chaque page via le serveur MCP. Il vous reste seulement à créer votre compte administrateur et à démarrer l'essai de Cortex AI. Voir l'<a href='#ai-agent'>option 5</a>.</p>
<h3>Comment mettre à jour NextBlock ?</h3>$n$,
  $u$<h3>Un agent IA peut-il installer et construire mon site ?</h3>$u$);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-configurer-nextblock', 'fr',
  $o$Sur un dépôt cloné, <code>git pull</code>, lancez <code>npm run db:migrate</code>, puis redémarrez (lors des builds de production, les migrations en attente s'appliquent automatiquement). Avec Docker, récupérez le dernier code et lancez <code>npm run docker:up</code>.$o$,
  $n$Partout ailleurs, une seule commande met à jour le code, les dépendances et le schéma de base de données : <code>npm run update</code>. Avec Docker, enchaînez avec <code>npm run docker:up</code>. Le <a href='/article/comment-fonctionnent-les-mises-a-jour'>guide des mises à jour</a> détaille chaque cas de figure.$n$,
  NULL);

-- ========================================================================================
-- updating-guide
-- ========================================================================================

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-updating-works', 'en',
  $o$used to mean knowing which of the four install paths you were on.$o$,
  $n$used to mean knowing which install path you were on.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-updating-works', 'en',
  $o$If you would rather look before you leap, <code>npm run update -- --check</code> reports exactly what would change and touches nothing.$o$,
  $n$If you would rather look before you leap, <code>npm run update:check</code> lists what would change and touches nothing.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-updating-works', 'en',
  $o$<h2 id='the-four-paths'>The four install paths, and how each one gets updates</h2>$o$,
  $n$<h2 id='the-four-paths'>Five ways to install, four ways to update</h2>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-updating-works', 'en',
  $o$These map one-to-one onto the four options in <a href='/article/how-to-setup-nextblock'>the install guide</a>.$o$,
  $n$The first four options in <a href='/article/how-to-setup-nextblock'>the install guide</a> map one-to-one onto the paths below. The fifth, where an AI coding agent builds the site, updates like path 2 or 3.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-updating-works', 'en',
  $o$dark:text-blue-200'>Fully automatic</p>$o$,
  $n$dark:text-blue-200'>Automatic after setup</p>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-updating-works', 'en',
  $o$A daily workflow merges upstream into your repository and Vercel redeploys. You do nothing.$o$,
  $n$One-time setup: <strong>Connect GitHub</strong> in the dashboard, or enable Actions on a manual fork. Then a daily workflow merges upstream and Vercel redeploys.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-updating-works', 'en',
  $o$<h2 id='vercel'>1. One-click Vercel and GitHub forks &mdash; hands-off</h2>$o$,
  $n$<div class='rounded-3xl border border-slate-200 bg-slate-50 p-6 my-8 dark:border-white/10 dark:bg-white/5'>
  <p class='mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-slate-600 dark:text-slate-300'>Installed by an AI coding agent?</p>
  <p class='mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200'>Then you have an ordinary <code>npm create nextblock</code> project. The agent runs <code>npx create-nextblock@latest my-site --non-interactive</code>, which scaffolds the same standalone app. It runs in Docker by default, so it updates like <a href='#docker'>path 2</a>. With <code>--mode cloud</code> it uses managed Supabase and updates like <a href='#cloud'>path 3</a>. If the agent runs the update for you, have it use <code>node tools/update.mjs --yes</code>. Its shell is not an interactive terminal, so without that flag the updater declines. More on this route in <a href='/article/how-to-setup-nextblock#ai-agent'>the install guide</a>.</p>
</div>

<h2 id='vercel'>1. One-click Vercel and GitHub forks &mdash; hands-off</h2>$n$,
  $u$Installed by an AI coding agent?$u$);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-updating-works', 'en',
  $o$When you deployed, NextBlock created a repository you own;$o$,
  $n$When you deployed, Vercel created a repository you own;$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-updating-works', 'en',
  $o$triggered by hand from your repository&rsquo;s <strong>Actions</strong> tab.</p>$o$,
  $n$triggered by hand from your repository&rsquo;s <strong>Actions</strong> tab. A manual GitHub fork already carries the workflow, but GitHub disables Actions on forks. Enable them once from the fork&rsquo;s <strong>Actions</strong> tab.</p>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-updating-works', 'en',
  $o$anything replaced is kept under <code>.nextblock-backup/</code>.</p>$o$,
  $n$anything replaced is kept under <code>.nextblock-backup/</code>.</p>
<p>A new project needs that first commit. The <code>create-nextblock</code> CLI runs <code>git init</code> but commits nothing, in Docker mode too and when an AI agent runs it. So commit once before your first update: <code>git add -A</code>, then <code>git commit -m initial</code>. The generated <code>.gitignore</code> already keeps your <code>.env</code> files and the agent&rsquo;s MCP configs out of git.</p>$n$,
  $u$git commit -m initial$u$);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-updating-works', 'en',
  $o$<pre><code>npm run update</code></pre>$o$,
  $n$<pre><code>npm run update
npm run dev</code></pre>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-updating-works', 'en',
  $o$points you at <code>git pull --rebase</code> rather than guessing.</p>$o$,
  $n$points you at <code>git pull --rebase</code> rather than guessing. When it finishes, restart the dev server with <code>npm run dev</code> (port 4200).</p>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-updating-works', 'en',
  $o$<td class='py-3 pr-4'><code>npm run update -- --check</code></td>$o$,
  $n$<td class='py-3 pr-4'><code>npm run update:check</code></td>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-updating-works', 'en',
  $o$<h2 id='database'>What happens to your database</h2>$o$,
  $n$<p class='text-sm'>On <strong>PowerShell</strong>, a bare <code>--</code> is stripped, so the flagged forms above run as a plain <code>npm run update</code>, with its confirmation prompts. npm keeps the flag for itself: it warns <code>Unknown cli config</code> for <code>--check</code>, <code>--db-only</code> and <code>--skip-db</code>, but <code>--yes</code> and <code>--force</code> are npm options too, so it takes them without that warning. To preview, use <code>npm run update:check</code>. For the other options, call the script directly. For example, in a project made with <code>npm create nextblock</code>, run <code>node tools/update.mjs --db-only</code>; in the monorepo, <code>node apps/nextblock/tools/update.mjs --db-only</code>. Command Prompt (<code>cmd.exe</code>) and macOS or Linux shells are not affected.</p>

<h2 id='database'>What happens to your database</h2>$n$,
  $u$node apps/nextblock/tools/update.mjs --db-only$u$);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-updating-works', 'en',
  $o$<p>Migrations change <em>structure</em> &mdash; tables, columns, indexes, permissions. Your pages, posts, products, media and users are yours; the update never deletes or rewrites them.</p>$o$,
  $n$<p>Migrations mostly change <em>structure</em> &mdash; tables, columns, indexes, permissions. A few also fix data. They refresh the demo content, theme colours and interface strings NextBlock seeded, usually only where these still match what NextBlock shipped. Rarely, one applies a narrow mechanical fix across all content. Examples: moving YouTube embeds to youtube-nocookie, or removing a CSS class that slowed the first paint. No migration deletes your pages, posts, products, media or users.</p>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-updating-works', 'en',
  $o$Before a big jump on a production site, take a database snapshot &mdash; Supabase does daily backups on paid plans, and you can trigger one on demand from the Supabase dashboard. Then run <code>npm run update -- --check</code> to see the pending list before you commit to it.$o$,
  $n$Before a big jump on a production site, take a database snapshot. Supabase keeps daily backups on paid plans, which you restore from <strong>Database &rarr; Backups</strong> in its dashboard. For a copy of your own, use <code>pg_dump</code> with your database connection string. With the Supabase CLI, <code>supabase db dump</code> saves only the schema; run <code>supabase db dump --data-only</code> as well for the rows. On Docker, run <code>pg_dump</code> inside the <code>db</code> container. Then run <code>npm run update:check</code> to preview the update before you commit to it.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-updating-works', 'en',
  $o$Review it with <code>git diff</code>, and undo the whole thing with <code>git reset --hard HEAD</code>. Nothing is ever deleted, so files you added yourself are never removed.$o$,
  $n$Review it with <code>git status</code>, which lists the files it added, and <code>git diff</code>. To back the code out, run <code>git reset --hard HEAD</code> and <code>git clean -fd</code>, then <code>npm install</code> to restore your dependencies. <code>git clean</code> removes the files the update added, plus any untracked file you created since; preview it with <code>git clean -nd</code>. Migrations that already ran stay applied: restore your snapshot if you need the old schema. The update itself never deletes a file, so files you added yourself are never removed.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-updating-works', 'en',
  $o$<li><strong>Git-backed installs:</strong> the update is an ordinary commit. <code>git log</code> shows it and <code>git revert</code> undoes it.</li>$o$,
  $n$<li><strong>Git-backed installs:</strong> the daily workflow lands each update as a merge commit. <code>git log</code> shows it and <code>git revert -m 1 &lt;merge-commit&gt;</code> undoes it. Git then treats those upstream changes as already merged, so later syncs will not bring them back until you revert that revert. Ran <code>npm run update</code> yourself, on a clone or a local copy of your fork? Right after it, <code>git reset --hard ORIG_HEAD</code> takes the code back and <code>npm install</code> restores the previous dependencies. Migrations already applied stay applied.</li>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-updating-works', 'en',
  $o$and <code>git reset --hard HEAD</code> backs the whole update out.$o$,
  $n$and <code>git reset --hard HEAD</code>, <code>git clean -fd</code> and <code>npm install</code> back the whole update out.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-updating-works', 'en',
  $o$or walk away with <code>git reset --hard HEAD</code>; either way the database was never touched.$o$,
  $n$or walk away with <code>git reset --hard HEAD</code>, <code>git clean -fd</code> and <code>npm install</code>; either way the database was never touched. Skip the last two and the new migration files stay on disk, where a later update or rebuild can apply them.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-updating-works', 'en',
  $o$Customisations in your own files, in the CMS, or in <code>.env</code> are never touched at all.$o$,
  $n$Customisations in your own files or in <code>.env</code> are never touched at all.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-updating-works', 'en',
  $o$Administrators can also just run <code>npm run update -- --check</code> at any time.$o$,
  $n$Projects made with <code>npm create nextblock</code> get this banner, including sites built by an AI agent. One-click deploys and forks on Vercel do not, because the daily workflow merges updates for them. Administrators can also just run <code>npm run update:check</code> at any time.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-updating-works', 'en',
  $o$The update touches application code, dependencies and schema structure only.</p>$o$,
  $n$The update changes application code, dependencies and the database schema. A few migrations also make targeted data fixes, mostly to the demo content, translations and theme colours NextBlock seeded (see <a href='#database'>What happens to your database</a>). None of them deletes your content.</p>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-updating-works', 'en',
  $o$it exits non-zero if the schema step fails so a pipeline can catch it.</p>$o$,
  $n$it exits non-zero if the schema step fails so a pipeline can catch it. Setting <code>CI=true</code> also skips the prompts, in any shell.</p>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'how-updating-works', 'en',
  $o$<p>No. That path is fully automatic. The command exists for when you want an update <em>now</em> rather than at midnight, or when you are working on a local clone.</p>$o$,
  $n$<p>No command. Once the dashboard&rsquo;s <strong>Connect GitHub</strong> step is green, that path is fully automatic. To update <em>now</em> rather than at midnight, open your repository&rsquo;s <strong>Actions</strong> tab and click <strong>Run workflow</strong> under <strong>NextBlock Upstream Sync</strong>. Or run the command on a local clone and push.</p>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-fonctionnent-les-mises-a-jour', 'fr',
  $o$savoir laquelle des quatre m&eacute;thodes d'installation vous aviez utilis&eacute;e.$o$,
  $n$savoir quelle m&eacute;thode d'installation vous aviez utilis&eacute;e.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-fonctionnent-les-mises-a-jour', 'fr',
  $o$<code>npm run update -- --check</code> indique exactement ce qui changerait sans rien modifier.$o$,
  $n$<code>npm run update:check</code> indique ce qui changerait sans rien modifier.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-fonctionnent-les-mises-a-jour', 'fr',
  $o$<h2 id='the-four-paths'>Les quatre installations et leurs mises &agrave; jour</h2>$o$,
  $n$<h2 id='the-four-paths'>Cinq fa&ccedil;ons d'installer, quatre fa&ccedil;ons de mettre &agrave; jour</h2>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-fonctionnent-les-mises-a-jour', 'fr',
  $o$Elles correspondent une &agrave; une aux quatre options du <a href='/article/comment-configurer-nextblock'>guide d'installation</a>.$o$,
  $n$Les quatre premi&egrave;res options du <a href='/article/comment-configurer-nextblock'>guide d'installation</a> correspondent une &agrave; une aux chemins ci-dessous. La cinqui&egrave;me, o&ugrave; un agent de code IA cr&eacute;e le site, se met &agrave; jour comme le chemin 2 ou 3.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-fonctionnent-les-mises-a-jour', 'fr',
  $o$dark:text-blue-200'>Enti&egrave;rement automatique</p>$o$,
  $n$dark:text-blue-200'>Automatique apr&egrave;s configuration</p>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-fonctionnent-les-mises-a-jour', 'fr',
  $o$Un workflow quotidien fusionne les nouveaut&eacute;s dans votre d&eacute;p&ocirc;t et Vercel red&eacute;ploie. Vous n'avez rien &agrave; faire.$o$,
  $n$Configuration unique : <strong>Connect GitHub</strong> dans le tableau de bord, ou activation des Actions sur un fork manuel. Ensuite, un workflow quotidien fusionne les nouveaut&eacute;s et Vercel red&eacute;ploie.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-fonctionnent-les-mises-a-jour', 'fr',
  $o$<h2 id='vercel'>1. Vercel en un clic et forks GitHub &mdash; sans intervention</h2>$o$,
  $n$<div class='rounded-3xl border border-slate-200 bg-slate-50 p-6 my-8 dark:border-white/10 dark:bg-white/5'>
  <p class='mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-slate-600 dark:text-slate-300'>Install&eacute; par un agent de code IA ?</p>
  <p class='mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200'>Vous avez alors un projet <code>npm create nextblock</code> ordinaire. L'agent lance <code>npx create-nextblock@latest mon-site --non-interactive</code>, qui g&eacute;n&egrave;re la m&ecirc;me application autonome. Par d&eacute;faut, elle tourne sous Docker et se met &agrave; jour comme le <a href='#docker'>chemin 2</a>. Avec <code>--mode cloud</code>, elle utilise Supabase g&eacute;r&eacute; et se met &agrave; jour comme le <a href='#cloud'>chemin 3</a>. Si l'agent lance la mise &agrave; jour pour vous, demandez-lui d'utiliser <code>node tools/update.mjs --yes</code>. Son terminal n'est pas interactif : sans cette option, la commande refuse de continuer. Plus de d&eacute;tails dans le <a href='/article/comment-configurer-nextblock#ai-agent'>guide d'installation</a>.</p>
</div>

<h2 id='vercel'>1. Vercel en un clic et forks GitHub &mdash; sans intervention</h2>$n$,
  $u$Install&eacute; par un agent de code IA ?$u$);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-fonctionnent-les-mises-a-jour', 'fr',
  $o$Lors du d&eacute;ploiement, NextBlock a cr&eacute;&eacute; un d&eacute;p&ocirc;t qui vous appartient ;$o$,
  $n$Lors du d&eacute;ploiement, Vercel a cr&eacute;&eacute; un d&eacute;p&ocirc;t qui vous appartient ;$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-fonctionnent-les-mises-a-jour', 'fr',
  $o$&agrave; la demande depuis l'onglet <strong>Actions</strong> de votre d&eacute;p&ocirc;t.</p>$o$,
  $n$&agrave; la demande depuis l'onglet <strong>Actions</strong> de votre d&eacute;p&ocirc;t. Un fork GitHub manuel contient d&eacute;j&agrave; le workflow, mais GitHub y d&eacute;sactive les Actions. Activez-les une fois depuis l'onglet <strong>Actions</strong> du fork.</p>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-fonctionnent-les-mises-a-jour', 'fr',
  $o$les commits automatis&eacute;s sur un d&eacute;p&ocirc;t priv&eacute;.</p>$o$,
  $n$les commits automatis&eacute;s sur un d&eacute;p&ocirc;t priv&eacute;. La fusion arriverait alors sans &ecirc;tre d&eacute;ploy&eacute;e.</p>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-fonctionnent-les-mises-a-jour', 'fr',
  $o$tout ce qui est remplac&eacute; est conserv&eacute; sous <code>.nextblock-backup/</code>.</p>$o$,
  $n$tout ce qui est remplac&eacute; est conserv&eacute; sous <code>.nextblock-backup/</code>.</p>
<p>Un nouveau projet a besoin de ce premier commit. Le CLI <code>create-nextblock</code> lance <code>git init</code> mais ne cr&eacute;e aucun commit, y compris en mode Docker et lorsqu'un agent IA l'ex&eacute;cute. Validez donc une fois avant votre premi&egrave;re mise &agrave; jour : <code>git add -A</code>, puis <code>git commit -m initial</code>. Le <code>.gitignore</code> g&eacute;n&eacute;r&eacute; exclut d&eacute;j&agrave; vos fichiers <code>.env</code> et les configurations MCP de l'agent.</p>$n$,
  $u$git commit -m initial$u$);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-fonctionnent-les-mises-a-jour', 'fr',
  $o$<pre><code>npm run update</code></pre>$o$,
  $n$<pre><code>npm run update
npm run dev</code></pre>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-fonctionnent-les-mises-a-jour', 'fr',
  $o$vous oriente vers <code>git pull --rebase</code> plut&ocirc;t que de deviner.</p>$o$,
  $n$vous oriente vers <code>git pull --rebase</code> plut&ocirc;t que de deviner. Une fois la mise &agrave; jour termin&eacute;e, relancez le serveur de d&eacute;veloppement avec <code>npm run dev</code> (port 4200).</p>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-fonctionnent-les-mises-a-jour', 'fr',
  $o$<td class='py-3 pr-4'><code>npm run update -- --check</code></td>$o$,
  $n$<td class='py-3 pr-4'><code>npm run update:check</code></td>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-fonctionnent-les-mises-a-jour', 'fr',
  $o$<h2 id='database'>Ce qui arrive &agrave; votre base de donn&eacute;es</h2>$o$,
  $n$<p class='text-sm'>Sous <strong>PowerShell</strong>, un <code>--</code> isol&eacute; est supprim&eacute; : les formes avec option ci-dessus s'ex&eacute;cutent alors comme un simple <code>npm run update</code>, avec ses confirmations. npm garde l'option pour lui : il affiche l'avertissement <code>Unknown cli config</code> pour <code>--check</code>, <code>--db-only</code> et <code>--skip-db</code>, mais <code>--yes</code> et <code>--force</code> sont aussi des options de npm, qu'il prend sans cet avertissement. Pour un aper&ccedil;u, utilisez <code>npm run update:check</code>. Pour les autres options, appelez le script directement. Par exemple, dans un projet cr&eacute;&eacute; avec <code>npm create nextblock</code>, lancez <code>node tools/update.mjs --db-only</code> ; dans le monorepo, <code>node apps/nextblock/tools/update.mjs --db-only</code>. L'invite de commandes (<code>cmd.exe</code>) et les terminaux macOS et Linux ne sont pas concern&eacute;s.</p>

<h2 id='database'>Ce qui arrive &agrave; votre base de donn&eacute;es</h2>$n$,
  $u$node apps/nextblock/tools/update.mjs --db-only$u$);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-fonctionnent-les-mises-a-jour', 'fr',
  $o$Les &eacute;volutions du sch&eacute;ma sont <strong>uniquement additives</strong>.$o$,
  $n$Les &eacute;volutions du sch&eacute;ma vont <strong>uniquement vers l'avant</strong>.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-fonctionnent-les-mises-a-jour', 'fr',
  $o$<p>Les migrations modifient la <em>structure</em> &mdash; tables, colonnes, index, permissions. Vos pages, articles, produits, m&eacute;dias et utilisateurs vous appartiennent : la mise &agrave; jour ne les supprime ni ne les r&eacute;&eacute;crit.</p>$o$,
  $n$<p>Les migrations modifient surtout la <em>structure</em> &mdash; tables, colonnes, index, permissions. Quelques-unes corrigent aussi des donn&eacute;es. Elles rafra&icirc;chissent le contenu de d&eacute;monstration, les couleurs de th&egrave;me et les textes d'interface fournis par NextBlock, en g&eacute;n&eacute;ral seulement l&agrave; o&ugrave; ils sont encore tels que livr&eacute;s. Plus rarement, une migration applique une correction m&eacute;canique cibl&eacute;e &agrave; tout le contenu. Par exemple : passer les vid&eacute;os YouTube int&eacute;gr&eacute;es sur youtube-nocookie, ou retirer une classe CSS qui ralentissait le premier affichage. Aucune migration ne supprime vos pages, articles, produits, m&eacute;dias ou utilisateurs.</p>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-fonctionnent-les-mises-a-jour', 'fr',
  $o$Avant un grand saut sur un site en production, prenez une sauvegarde de la base &mdash; Supabase en r&eacute;alise quotidiennement sur les offres payantes, et vous pouvez en d&eacute;clencher une &agrave; la demande depuis son tableau de bord. Lancez ensuite <code>npm run update -- --check</code> pour voir la liste des migrations en attente.$o$,
  $n$Avant un grand saut sur un site en production, prenez une sauvegarde de la base. Supabase en conserve une par jour sur les offres payantes, &agrave; restaurer depuis <strong>Database &rarr; Backups</strong> dans son tableau de bord. Pour votre propre copie, utilisez <code>pg_dump</code> avec la cha&icirc;ne de connexion de votre base. Avec le CLI Supabase, <code>supabase db dump</code> ne sauvegarde que le sch&eacute;ma : lancez aussi <code>supabase db dump --data-only</code> pour les donn&eacute;es. Sous Docker, lancez <code>pg_dump</code> dans le conteneur <code>db</code>. Lancez ensuite <code>npm run update:check</code> pour pr&eacute;visualiser la mise &agrave; jour avant de vous lancer.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-fonctionnent-les-mises-a-jour', 'fr',
  $o$Examinez-la avec <code>git diff</code>, et annulez tout avec <code>git reset --hard HEAD</code>. Rien n'est jamais supprim&eacute; : les fichiers que vous avez ajout&eacute;s ne disparaissent jamais.$o$,
  $n$Examinez-la avec <code>git status</code>, qui liste les fichiers ajout&eacute;s, et <code>git diff</code>. Pour annuler le code, lancez <code>git reset --hard HEAD</code> et <code>git clean -fd</code>, puis <code>npm install</code> pour r&eacute;tablir vos d&eacute;pendances. <code>git clean</code> supprime les fichiers ajout&eacute;s par la mise &agrave; jour, ainsi que tout fichier non suivi cr&eacute;&eacute; depuis : v&eacute;rifiez d'abord avec <code>git clean -nd</code>. Les migrations d&eacute;j&agrave; appliqu&eacute;es le restent : restaurez votre sauvegarde si vous avez besoin de l'ancien sch&eacute;ma. La mise &agrave; jour elle-m&ecirc;me ne supprime jamais de fichier : ceux que vous avez ajout&eacute;s ne disparaissent jamais.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-fonctionnent-les-mises-a-jour', 'fr',
  $o$<li><strong>Installations bas&eacute;es sur git :</strong> la mise &agrave; jour est un commit ordinaire. <code>git log</code> l'affiche et <code>git revert</code> l'annule.</li>$o$,
  $n$<li><strong>Installations bas&eacute;es sur git :</strong> le workflow quotidien applique chaque mise &agrave; jour sous forme de commit de fusion. <code>git log</code> l'affiche et <code>git revert -m 1 &lt;commit-de-fusion&gt;</code> l'annule. Git consid&egrave;re alors ces changements comme d&eacute;j&agrave; fusionn&eacute;s. Les synchronisations suivantes ne les r&eacute;appliqueront donc pas tant que vous n'aurez pas annul&eacute; ce revert. Vous avez lanc&eacute; <code>npm run update</code> vous-m&ecirc;me, sur un clone ou une copie locale de votre fork ? Juste apr&egrave;s, <code>git reset --hard ORIG_HEAD</code> ram&egrave;ne le code en arri&egrave;re et <code>npm install</code> r&eacute;tablit les d&eacute;pendances pr&eacute;c&eacute;dentes. Les migrations d&eacute;j&agrave; appliqu&eacute;es le restent.</li>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-fonctionnent-les-mises-a-jour', 'fr',
  $o$et <code>git reset --hard HEAD</code> annule toute la mise &agrave; jour.$o$,
  $n$et <code>git reset --hard HEAD</code>, <code>git clean -fd</code> puis <code>npm install</code> annulent toute la mise &agrave; jour.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-fonctionnent-les-mises-a-jour', 'fr',
  $o$ou abandonnez avec <code>git reset --hard HEAD</code> : dans les deux cas la base n'a jamais &eacute;t&eacute; touch&eacute;e.$o$,
  $n$ou abandonnez avec <code>git reset --hard HEAD</code>, <code>git clean -fd</code> puis <code>npm install</code> : dans les deux cas la base n'a jamais &eacute;t&eacute; touch&eacute;e. Sans ces deux derni&egrave;res commandes, les nouveaux fichiers de migration restent sur le disque, et une prochaine mise &agrave; jour ou reconstruction peut les appliquer.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-fonctionnent-les-mises-a-jour', 'fr',
  $o$Les personnalisations dans vos propres fichiers, dans le CMS ou dans <code>.env</code> ne sont jamais touch&eacute;es.$o$,
  $n$Les personnalisations dans vos propres fichiers ou dans <code>.env</code> ne sont jamais touch&eacute;es.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-fonctionnent-les-mises-a-jour', 'fr',
  $o$Les administrateurs peuvent aussi lancer <code>npm run update -- --check</code> &agrave; tout moment.$o$,
  $n$Les projets cr&eacute;&eacute;s avec <code>npm create nextblock</code> affichent cette banni&egrave;re, y compris ceux cr&eacute;&eacute;s par un agent IA. Les d&eacute;ploiements en un clic et les forks sur Vercel ne l'affichent pas : le workflow quotidien fusionne les mises &agrave; jour pour eux. Les administrateurs peuvent aussi lancer <code>npm run update:check</code> &agrave; tout moment.$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-fonctionnent-les-mises-a-jour', 'fr',
  $o$La mise &agrave; jour ne touche que le code, les d&eacute;pendances et la structure du sch&eacute;ma.</p>$o$,
  $n$La mise &agrave; jour modifie le code, les d&eacute;pendances et le sch&eacute;ma de la base. Quelques migrations apportent aussi des corrections cibl&eacute;es aux donn&eacute;es, surtout au contenu de d&eacute;monstration, aux traductions et aux couleurs de th&egrave;me fournis par NextBlock (voir <a href='#database'>Ce qui arrive &agrave; votre base de donn&eacute;es</a>). Aucune ne supprime votre contenu.</p>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-fonctionnent-les-mises-a-jour', 'fr',
  $o$pour qu'un pipeline puisse le d&eacute;tecter.</p>$o$,
  $n$pour qu'un pipeline puisse le d&eacute;tecter. D&eacute;finir <code>CI=true</code> d&eacute;sactive aussi les confirmations, quel que soit le terminal.</p>$n$,
  NULL);

INSERT INTO pg_temp.nb_02018_edits (kind, slug, lang, old_html, new_html, unless_html) VALUES ('post', 'comment-fonctionnent-les-mises-a-jour', 'fr',
  $o$<p>Non. Ce chemin est enti&egrave;rement automatique. La commande existe pour mettre &agrave; jour <em>tout de suite</em> plut&ocirc;t qu'&agrave; minuit, ou lorsque vous travaillez sur un clone local.</p>$o$,
  $n$<p>Aucune commande. Une fois l'&eacute;tape <strong>Connect GitHub</strong> du tableau de bord valid&eacute;e, ce chemin est enti&egrave;rement automatique. Pour mettre &agrave; jour <em>tout de suite</em> plut&ocirc;t qu'&agrave; minuit, ouvrez l'onglet <strong>Actions</strong> de votre d&eacute;p&ocirc;t et cliquez sur <strong>Run workflow</strong> sous <strong>NextBlock Upstream Sync</strong>. Vous pouvez aussi lancer la commande sur un clone local, puis pousser le r&eacute;sultat.</p>$n$,
  NULL);

-- ========================================================================================
-- Post and page fields (applied with their item, each only while it holds the seeded value)
-- ========================================================================================

INSERT INTO pg_temp.nb_02018_fields (kind, slug, lang, field, old_value, new_value) VALUES ('post', 'comment-nextblock-fonctionne', 'fr', 'subtitle',
  $o$Une visite guidee du monorepo, du registre de blocs, de l editeur et de l architecture open-core de NextBlock.$o$,
  $n$Une visite guidée du monorepo, du registre de blocs, de l'éditeur et de l'architecture open-core de NextBlock.$n$);

INSERT INTO pg_temp.nb_02018_fields (kind, slug, lang, field, old_value, new_value) VALUES ('post', 'comment-nextblock-fonctionne', 'fr', 'excerpt',
  $o$Sous le capot du monorepo, du registre de blocs et de l editeur qui propulsent NextBlock.$o$,
  $n$Sous le capot du monorepo, du registre de blocs et de l'éditeur qui propulsent NextBlock.$n$);

INSERT INTO pg_temp.nb_02018_fields (kind, slug, lang, field, old_value, new_value) VALUES ('post', 'nextblock-commerce-guide', 'en', 'title',
  $o$NextBlock™ Commerce: Multi-Currency, Tax Sync & Beyond$o$,
  $n$NextBlock™ Commerce: Multi-Currency, Automatic Tax & Beyond$n$);

INSERT INTO pg_temp.nb_02018_fields (kind, slug, lang, field, old_value, new_value) VALUES ('post', 'nextblock-commerce-guide', 'en', 'subtitle',
  $o$A closer look at the commerce module, from multi-currency and tax sync to shipping, inventory, and provider-aware checkout.$o$,
  $n$A closer look at the commerce module, from multi-currency pricing and automatic Stripe Tax to shipping, inventory, and provider-aware checkout.$n$);

INSERT INTO pg_temp.nb_02018_fields (kind, slug, lang, field, old_value, new_value) VALUES ('post', 'nextblock-commerce-guide', 'en', 'meta_title',
  $o$The Complete NextBlock™ Commerce Guide | Headless Store$o$,
  $n$The Complete NextBlock™ Commerce Guide | Next.js Store$n$);

INSERT INTO pg_temp.nb_02018_fields (kind, slug, lang, field, old_value, new_value) VALUES ('post', 'nextblock-commerce-guide', 'en', 'meta_description',
  $o$Build global e-commerce with NextBlock: manage products, configure multi-currency pricing, and accept payments with headless Stripe checkout.$o$,
  $n$Build a global store with NextBlock: products, multi-currency pricing, Stripe Tax, shipping zones, and Stripe or Freemius checkout.$n$);

INSERT INTO pg_temp.nb_02018_fields (kind, slug, lang, field, old_value, new_value) VALUES ('post', 'guide-commerce-nextblock', 'fr', 'meta_description',
  $o$Développez votre boutique avec NextBlock : gestion de produits, tarifs multi-devises et tunnel de paiement headless avec Stripe Checkout.$o$,
  $n$Développez votre boutique avec NextBlock : produits, tarifs multi-devises, Stripe Tax, zones de livraison et paiement Stripe ou Freemius.$n$);

INSERT INTO pg_temp.nb_02018_fields (kind, slug, lang, field, old_value, new_value) VALUES ('post', 'guide-commerce-nextblock', 'fr', 'subtitle',
  $o$Un apercu du module commerce : multi-devises, sync taxes, expedition, inventaire et paiements connectes.$o$,
  $n$Un aperçu du module commerce : multi-devises, taxes automatiques avec Stripe Tax, expédition, inventaire et paiements connectés.$n$);

INSERT INTO pg_temp.nb_02018_fields (kind, slug, lang, field, old_value, new_value) VALUES ('post', 'guide-commerce-nextblock', 'fr', 'excerpt',
  $o$Architecture boutique, parcours de paiement et fonctions commerce premium au coeur de NextBlock.$o$,
  $n$Architecture boutique, parcours de paiement et fonctions commerce premium au cœur de NextBlock.$n$);

INSERT INTO pg_temp.nb_02018_fields (kind, slug, lang, field, old_value, new_value) VALUES ('post', 'guide-connexion-mcp-cortex-ai', 'fr', 'meta_description',
  $o$Apprenez à connecter Claude à NextBlock CMS avec le Model Context Protocol. Enregistrez /api/mcp dans Claude Code ou Cursor pour inspecter les schémas et bâtir des mises en page.$o$,
  $n$Connectez Claude à NextBlock CMS via le Model Context Protocol. Enregistrez /api/mcp dans Claude Code ou Cursor pour lire les schémas et bâtir des pages.$n$);

INSERT INTO pg_temp.nb_02018_fields (kind, slug, lang, field, old_value, new_value) VALUES ('post', 'nextblock-cortex-ai-guide', 'en', 'label',
  $o$AI Copilot$o$,
  $n$Cortex AI$n$);

INSERT INTO pg_temp.nb_02018_fields (kind, slug, lang, field, old_value, new_value) VALUES ('post', 'nextblock-cortex-ai-guide', 'en', 'subtitle',
  $o$See how Cortex AI brings structured generation, provider choice, and safer content workflows directly into the NextBlock editor.$o$,
  $n$See how Cortex AI brings structured generation, model choice, and safer content workflows directly into the NextBlock editor.$n$);

INSERT INTO pg_temp.nb_02018_fields (kind, slug, lang, field, old_value, new_value) VALUES ('post', 'nextblock-cortex-ai-guide', 'en', 'excerpt',
  $o$A practical guide to Cortex AI, the block-aware assistant for model routing, BYOK controls, and faster editorial production inside NextBlock.$o$,
  $n$A practical guide to Cortex AI: block-aware AI in the NextBlock editor with your own OpenRouter key, plus an MCP server for your AI app.$n$);

INSERT INTO pg_temp.nb_02018_fields (kind, slug, lang, field, old_value, new_value) VALUES ('post', 'nextblock-cortex-ai-guide', 'en', 'meta_description',
  $o$Learn how NextBlock Cortex AI helps teams generate, refine, and translate structured block content with model routing and BYOK controls.$o$,
  $n$Learn how NextBlock Cortex AI helps teams generate, refine, and translate block content with your own OpenRouter key, or over MCP from your AI app.$n$);

INSERT INTO pg_temp.nb_02018_fields (kind, slug, lang, field, old_value, new_value) VALUES ('page', 'accueil', 'fr', 'meta_title',
  $o$NextBlock CMS$o$,
  $n$NextBlock : CMS constructeur de sites web par l'IA$n$);

INSERT INTO pg_temp.nb_02018_fields (kind, slug, lang, field, old_value, new_value) VALUES ('page', 'accueil', 'fr', 'meta_description',
  $o$NextBlock™ est le CMS Next.js open source pensé pour les développeurs, qui allie des scores Lighthouse de 100 % à un puissant éditeur visuel par blocs.$o$,
  $n$Créez vite vos sites web avec le CMS constructeur par l'IA, relié à votre abonnement IA via MCP. Vos prompts deviennent des pages Next.js 16 en production.$n$);

INSERT INTO pg_temp.nb_02018_fields (kind, slug, lang, field, old_value, new_value) VALUES ('page', 'articles', 'en', 'meta_description',
  $o$Read technical deep dives, tutorials, and release notes on Next.js 16, Supabase, and modern visual web publishing from the NextBlock team.$o$,
  $n$Read technical deep dives and step-by-step guides on installing, updating, and extending NextBlock with Next.js 16, Supabase, Cortex AI, and MCP.$n$);

INSERT INTO pg_temp.nb_02018_fields (kind, slug, lang, field, old_value, new_value) VALUES ('page', 'articles', 'fr', 'meta_description',
  $o$Découvrez des guides techniques, des tutoriels et des analyses sur Next.js 16, Supabase et l’édition de blocs moderne avec l’équipe NextBlock.$o$,
  $n$Découvrez des analyses techniques et des guides pas à pas pour installer, mettre à jour et étendre NextBlock avec Next.js 16, Supabase, Cortex AI et MCP.$n$);

INSERT INTO pg_temp.nb_02018_fields (kind, slug, lang, field, old_value, new_value) VALUES ('post', 'how-to-setup-nextblock', 'en', 'subtitle',
  $o$Four ways to launch NextBlock: a one-click Vercel deploy, npm create nextblock, git clone with the browser setup wizard, or a fully local Docker stack.$o$,
  $n$Five ways to launch NextBlock: a one-click Vercel deploy, npm create nextblock, git clone with the browser setup wizard, a fully local Docker stack, or your AI coding agent.$n$);

INSERT INTO pg_temp.nb_02018_fields (kind, slug, lang, field, old_value, new_value) VALUES ('post', 'how-to-setup-nextblock', 'en', 'excerpt',
  $o$Every way to install NextBlock — one-click cloud deploy, CLI scaffold, git clone, or self-hosted Docker — with copy-paste steps for each.$o$,
  $n$Every way to install NextBlock — one-click cloud deploy, CLI scaffold, git clone, self-hosted Docker, or your AI coding agent — with copy-paste steps for each.$n$);

INSERT INTO pg_temp.nb_02018_fields (kind, slug, lang, field, old_value, new_value) VALUES ('post', 'how-to-setup-nextblock', 'en', 'meta_title',
  $o$How to Install NextBlock CMS — Vercel, CLI, Git or Docker$o$,
  $n$Install NextBlock CMS: Vercel, CLI, Git, Docker or AI Agent$n$);

INSERT INTO pg_temp.nb_02018_fields (kind, slug, lang, field, old_value, new_value) VALUES ('post', 'how-to-setup-nextblock', 'en', 'meta_description',
  $o$Install NextBlock in minutes — one-click Vercel deploy, npm create nextblock, git clone, or self-hosted Docker. No config files, no manual SQL.$o$,
  $n$Install NextBlock in minutes: one-click Vercel deploy, npm create nextblock, git clone, self-hosted Docker, or your AI coding agent. No manual SQL.$n$);

INSERT INTO pg_temp.nb_02018_fields (kind, slug, lang, field, old_value, new_value) VALUES ('post', 'comment-configurer-nextblock', 'fr', 'subtitle',
  $o$Quatre façons de lancer NextBlock : déploiement Vercel en un clic, npm create nextblock, git clone avec l'assistant dans le navigateur, ou une pile Docker 100 % locale.$o$,
  $n$Cinq façons de lancer NextBlock : déploiement Vercel en un clic, npm create nextblock, git clone avec l'assistant dans le navigateur, une pile Docker 100 % locale ou votre agent de code IA.$n$);

INSERT INTO pg_temp.nb_02018_fields (kind, slug, lang, field, old_value, new_value) VALUES ('post', 'comment-configurer-nextblock', 'fr', 'excerpt',
  $o$Toutes les façons d'installer NextBlock — cloud en un clic, CLI, git clone ou Docker auto-hébergé — avec les étapes à copier-coller.$o$,
  $n$Toutes les façons d'installer NextBlock — cloud en un clic, CLI, git clone, Docker auto-hébergé ou votre agent de code IA — avec les étapes à copier-coller.$n$);

INSERT INTO pg_temp.nb_02018_fields (kind, slug, lang, field, old_value, new_value) VALUES ('post', 'comment-configurer-nextblock', 'fr', 'meta_title',
  $o$Installer NextBlock — Vercel, CLI, Git ou Docker$o$,
  $n$Installer NextBlock : Vercel, CLI, Git, Docker ou agent IA$n$);

INSERT INTO pg_temp.nb_02018_fields (kind, slug, lang, field, old_value, new_value) VALUES ('post', 'comment-configurer-nextblock', 'fr', 'meta_description',
  $o$Installez NextBlock en quelques minutes : déploiement Vercel en un clic, npm create nextblock, git clone ou Docker auto-hébergé. Sans config ni SQL.$o$,
  $n$Installez NextBlock en quelques minutes : Vercel en un clic, npm create nextblock, git clone, Docker auto-hébergé ou votre agent IA. Sans SQL manuel.$n$);

-- ========================================================================================
-- Apply, item by item. Install guides first: items that point at Option 5 require it.
-- ========================================================================================

DO $nb_02018_items$
BEGIN
  PERFORM pg_temp.nb_02018_item('post', 'how-to-setup-nextblock', 'en', false);
  PERFORM pg_temp.nb_02018_item('post', 'comment-configurer-nextblock', 'fr', false);
  PERFORM pg_temp.nb_02018_item('post', 'how-nextblock-works', 'en', true);
  PERFORM pg_temp.nb_02018_item('post', 'comment-nextblock-fonctionne', 'fr', true);
  PERFORM pg_temp.nb_02018_item('post', 'nextblock-commerce-guide', 'en', false);
  PERFORM pg_temp.nb_02018_item('post', 'guide-commerce-nextblock', 'fr', false);
  PERFORM pg_temp.nb_02018_item('post', 'cortex-ai-mcp-connection-guide', 'en', true);
  PERFORM pg_temp.nb_02018_item('post', 'guide-connexion-mcp-cortex-ai', 'fr', true);
  PERFORM pg_temp.nb_02018_item('post', 'nextblock-cortex-ai-guide', 'en', false);
  PERFORM pg_temp.nb_02018_item('page', 'home', 'en', true);
  PERFORM pg_temp.nb_02018_item('page', 'accueil', 'fr', true);
  PERFORM pg_temp.nb_02018_item('page', 'articles', 'en', false);
  PERFORM pg_temp.nb_02018_item('page', 'articles', 'fr', false);
  PERFORM pg_temp.nb_02018_item('post', 'how-updating-works', 'en', true);
  PERFORM pg_temp.nb_02018_item('post', 'comment-fonctionnent-les-mises-a-jour', 'fr', true);
END
$nb_02018_items$;

-- ==========================================================================================
-- French Cortex AI guide ('guide-cortex-ai-nextblock'), the insert 02009 meant to make.
-- 02009 keyed it on translation group dbe2a06f-…, but the seeded English post
-- 'nextblock-cortex-ai-guide' lives in group 669489e7-…, so its guard never matched and the
-- French twin exists nowhere. The English row is resolved here by slug + language, and the
-- French row takes its translation group, feature image, status and publish date, so it is
-- exactly as visible as the English original (a drafted or archived English guide yields a
-- drafted or archived French twin). Inserted once: skipped when that group already has a
-- French row or the French slug is taken.
-- ==========================================================================================

DO $nb_02018_fr_cortex$
DECLARE
  v_fr bigint;
  v_en record;
  v_post bigint;
BEGIN
  SELECT id INTO v_fr FROM public.languages WHERE code = 'fr' LIMIT 1;
  SELECT p.id, p.translation_group_id, p.feature_image_id, p.published_at, p.status
    INTO v_en
    FROM public.posts AS p
    JOIN public.languages AS l ON l.id = p.language_id
   WHERE p.slug = 'nextblock-cortex-ai-guide' AND l.code = 'en'
   ORDER BY p.id
   LIMIT 1;

  IF v_fr IS NULL OR v_en.id IS NULL OR v_en.translation_group_id IS NULL THEN
    RAISE NOTICE '02018: no French language or no English Cortex AI guide; French guide not inserted.';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM public.posts WHERE translation_group_id = v_en.translation_group_id AND language_id = v_fr)
     OR EXISTS (SELECT 1 FROM public.posts WHERE slug = 'guide-cortex-ai-nextblock' AND language_id = v_fr) THEN
    RETURN;
  END IF;

  -- The seed inserts explicit ids; make sure the identity sequences are past them. Only ever
  -- move a sequence forward: rewinding would hand a deleted row's id to this insert (and to
  -- every later CMS insert), and could collide with a concurrent insert on a live site.
  PERFORM setval('public.posts_id_seq',
    GREATEST(COALESCE((SELECT MAX(id) FROM public.posts), 1), (SELECT last_value FROM public.posts_id_seq)), true);
  PERFORM setval('public.blocks_id_seq',
    GREATEST(COALESCE((SELECT MAX(id) FROM public.blocks), 1), (SELECT last_value FROM public.blocks_id_seq)), true);

  INSERT INTO public.posts
    (language_id, author_id, title, slug, label, excerpt, subtitle, status, published_at,
     meta_title, meta_description, feature_image_id, version, translation_group_id)
  VALUES
    (v_fr, NULL, $o$Guide NextBlock Cortex AI$o$, 'guide-cortex-ai-nextblock', $o$Cortex AI$o$,
     $o$Un guide pratique de Cortex AI : l'IA qui comprend vos blocs, dans l'éditeur NextBlock, avec votre propre clé OpenRouter, plus un serveur MCP pour votre application IA.$o$,
     $o$Découvrez comment Cortex AI apporte la génération structurée, le choix du modèle et des flux de contenu plus sûrs directement dans l'éditeur NextBlock.$o$,
     v_en.status, v_en.published_at,
     $o$Guide NextBlock Cortex AI$o$,
     $o$Découvrez comment NextBlock Cortex AI aide les équipes à générer, affiner et traduire du contenu par blocs, avec votre clé OpenRouter ou via MCP.$o$,
     v_en.feature_image_id, 1, v_en.translation_group_id)
  RETURNING id INTO v_post;

  INSERT INTO public.blocks (post_id, language_id, block_type, content, "order")
  VALUES (v_post, v_fr, 'text', jsonb_build_object('html_content', replace($h$
<p class='text-lg leading-8 text-slate-700 dark:text-slate-300'>NextBlock Cortex AI est l'outil de contenu intelligent conçu pour les pages web modernes. Il comprend les blocs de page, les mises en page de sections et les règles éditoriales, pour que vous créiez un meilleur contenu, plus vite.</p>

<div class='grid gap-4 md:grid-cols-3 my-10'>
  <div class='rounded-3xl border border-violet-200/70 bg-violet-50/80 p-6 dark:border-violet-500/20 dark:bg-violet-500/10'>
    <p class='text-xs font-semibold uppercase tracking-[0.22em] text-violet-700 dark:text-violet-200'>Choix du modèle</p>
    <h2 class='mt-3 text-xl font-semibold text-slate-900 dark:text-white'>Choisissez le bon modèle</h2>
    <p class='mt-3 text-sm text-slate-600 dark:text-slate-300'>Branchez votre propre clé OpenRouter et choisissez un seul modèle pour tout le site : des modèles gratuits avec bascule automatique, ou le modèle payant de votre choix.</p>
  </div>
  <div class='rounded-3xl border border-sky-200/70 bg-sky-50/80 p-6 dark:border-sky-500/20 dark:bg-sky-500/10'>
    <p class='text-xs font-semibold uppercase tracking-[0.22em] text-sky-700 dark:text-sky-200'>Contrôle BYOK</p>
    <h2 class='mt-3 text-xl font-semibold text-slate-900 dark:text-white'>Utilisez vos propres clés</h2>
    <p class='mt-3 text-sm text-slate-600 dark:text-slate-300'>Gardez les clés des fournisseurs en sécurité sur votre serveur tout en offrant aux éditeurs un écran de rédaction IA tout simple.</p>
  </div>
  <div class='rounded-3xl border border-emerald-200/70 bg-emerald-50/80 p-6 dark:border-emerald-500/20 dark:bg-emerald-500/10'>
    <p class='text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200'>Sortie typée</p>
    <h2 class='mt-3 text-xl font-semibold text-slate-900 dark:text-white'>Générez des blocs valides</h2>
    <p class='mt-3 text-sm text-slate-600 dark:text-slate-300'>Des schémas typés garantissent que le contenu IA s'insère directement dans vos pages sous forme de blocs propres et fonctionnels.</p>
  </div>
</div>

<h2>Pourquoi Cortex AI a sa place dans l'éditeur</h2>
<p>Les outils de clavardage génériques peuvent rédiger du texte, mais ils ne font pas la différence entre une bannière héros, une grille de cartes et un article de blogue. Cortex AI vit directement dans votre écran d'édition. Il crée du contenu qui s'ajuste aux blocs de votre site en ligne.</p>
<p>L'IA devient ainsi vraiment utile au quotidien. Vous pouvez ébaucher une nouvelle section d'accueil, peaufiner un résumé, enrichir une fiche produit ou traduire un article complet en toute simplicité.</p>

<div class='rounded-[2rem] border border-slate-200/80 bg-slate-50/90 p-6 my-10 dark:border-white/10 dark:bg-slate-900/70'>
  <p class='text-xs font-semibold uppercase tracking-[0.22em] text-violet-700 dark:text-violet-200'>Flux éditorial</p>
  <div class='grid gap-5 md:grid-cols-2 mt-5'>
    <div class='rounded-2xl border border-slate-200 bg-white p-5 dark:border-white/10 dark:bg-slate-950/50'>
      <h3 class='mt-0 text-xl text-slate-900 dark:text-white'>Des premiers jets plus rapides</h3>
      <p class='text-sm text-slate-600 dark:text-slate-300'>Partez d'un prompt et obtenez une section, un brouillon d'article ou une histoire de produit qui respecte votre ton.</p>
    </div>
    <div class='rounded-2xl border border-slate-200 bg-white p-5 dark:border-white/10 dark:bg-slate-950/50'>
      <h3 class='mt-0 text-xl text-slate-900 dark:text-white'>Des révisions plus nettes</h3>
      <p class='text-sm text-slate-600 dark:text-slate-300'>Demandez un texte plus court, plus clair ou traduit, sans quitter votre écran d'édition.</p>
    </div>
  </div>
</div>

<h2>Choix du modèle et contrôle des coûts</h2>
<p>Cortex AI fonctionne avec OpenRouter, et vous choisissez un seul modèle pour tout le site dans les réglages de Cortex AI. Les modèles gratuits sont proposés par défaut, avec une bascule automatique quand l'un d'eux est occupé. Ils demandent quand même une clé OpenRouter, mais un compte OpenRouter gratuit suffit. Pour choisir un modèle payant, enregistrez votre clé dans le CMS. Vous gérez cette clé sur le serveur, pour que vos rédacteurs se concentrent sur le contenu.</p>
<ul class='list-disc pl-6 space-y-2 text-sm'>
  <li>Commencez avec les modèles gratuits, sans frais de modèle.</li>
  <li>Passez tout le site à un modèle payant plus puissant quand vous visez plus de qualité.</li>
  <li>Gardez votre clé OpenRouter chiffrée dans les réglages du CMS.</li>
  <li>Maîtrisez les coûts sans changer l'affichage des pages pour les visiteurs.</li>
</ul>

<h2>Une génération pensée pour vos blocs</h2>
<p>Cortex AI fait plus qu'écrire du texte brut. Il crée du contenu structuré qui correspond directement aux composants NextBlock. Vous obtenez des textes de section, des titres, des boutons et des blocs traduits prêts à l'emploi. Vous passez moins de temps à remettre en forme des textes approximatifs venus d'outils externes.</p>
<p>Comme le contenu généré respecte vos règles de blocs, tout reste cohérent et rapide sur le web.</p>

<h2>Des flux d'équipe plus sûrs</h2>
<p>L'IA donne le meilleur d'elle-même quand les humains gardent le contrôle. Avec Cortex AI, les éditeurs révisent chaque brouillon avant publication. Les développeurs gèrent les clés des modèles, et le CMS conserve toutes les versions dans votre historique habituel.</p>

<h2>Un flux de lancement concret</h2>
<ol class='list-decimal pl-6 space-y-2 text-sm'>
  <li>Ébauchez un article, une section d'accueil ou une histoire de produit à partir d'un prompt clair.</li>
  <li>Affinez le texte pour qu'il colle à votre public et au ton de votre marque.</li>
  <li>Créez une version traduite ou un résumé plus court pour les cartes sociales et les balises de recherche.</li>
  <li>Révisez le contenu dans l'éditeur, publiez, puis suivez vos révisions au fil du temps.</li>
</ol>

<h2>Deux façons d'utiliser Cortex AI</h2>
<p>Cortex AI travaille à deux endroits. <strong>L'IA dans l'éditeur</strong> ébauche, réécrit et traduit vos blocs avec votre propre clé OpenRouter, modèles gratuits compris. <strong>Le serveur MCP</strong> permet à votre propre application IA, comme Claude Code ou Cursor, de bâtir vos pages avec l'abonnement que vous payez déjà. <a href='/article/guide-connexion-mcp-cortex-ai'>Connectez votre application IA via MCP</a>.</p>
<p>Le CMS NextBlock est gratuit et open source, sous licence AGPL. Ces deux usages font partie de Cortex AI, qui commence par un essai gratuit de 30 jours, sans carte de crédit.</p>

<p>Cortex AI transforme votre CMS en atelier créatif plus rapide. Il ne remplace pas le goût humain, mais il vous aide à transformer de bonnes idées en pages finies en un temps record.</p>$h$, chr(13), '')), 0);
END
$nb_02018_fr_cortex$;

-- French install guide -> French Cortex AI guide. Linked only once that guide exists and is
-- published (inserted above, or an operator's own translation in the same group under its own
-- slug), and only where the install guide was rewritten above.
DO $nb_02018_fr_cortex_link$
DECLARE
  v_group uuid;
  v_slug text;
BEGIN
  SELECT p.translation_group_id INTO v_group
    FROM public.posts AS p JOIN public.languages AS l ON l.id = p.language_id
   WHERE p.slug = 'nextblock-cortex-ai-guide' AND l.code = 'en'
   ORDER BY p.id LIMIT 1;

  SELECT p.slug INTO v_slug
    FROM public.posts AS p JOIN public.languages AS l ON l.id = p.language_id
   WHERE l.code = 'fr' AND p.status = 'published'
     AND ((v_group IS NOT NULL AND p.translation_group_id = v_group) OR p.slug = 'guide-cortex-ai-nextblock')
   ORDER BY (p.translation_group_id IS NOT DISTINCT FROM v_group) DESC, p.id
   LIMIT 1;

  IF v_slug IS NULL THEN
    RETURN;
  END IF;

  PERFORM pg_temp.nb_02018_fragment('post', 'comment-configurer-nextblock', 'fr',
    $o$, ou mettez Cortex AI au travail avec le <a href='/article/guide-connexion-mcp-cortex-ai'>guide de connexion MCP</a>.</p>$o$,
    format($n$, ou mettez Cortex AI au travail avec le <a href='/article/%s'>guide Cortex AI</a> et le <a href='/article/guide-connexion-mcp-cortex-ai'>guide de connexion MCP</a>.</p>$n$, v_slug),
    $u$guide Cortex AI</a> et le <a href='/article/guide-connexion-mcp-cortex-ai'>$u$);
END
$nb_02018_fr_cortex_link$;

-- ==========================================================================================
-- English home: the 'More Than a CMS' community section and the 'Have Questions?' CTA both
-- carry "order" = 7 (the French home uses 7 and 8), and the public query orders by "order"
-- alone, so which one renders first is undefined. Move the CTA after the community section,
-- as in French. Matched by page + content signature; skipped once order 8 is taken.
-- ==========================================================================================

UPDATE public.blocks AS b
   SET "order" = 8,
       updated_at = now()
  FROM public.pages AS p
  JOIN public.languages AS l ON l.id = p.language_id
 WHERE b.page_id = p.id AND p.slug = 'home' AND l.code = 'en'
   AND b.block_type = 'section' AND b."order" = 7
   AND b.content::text LIKE '%Have Questions?%'
   AND EXISTS (SELECT 1 FROM public.blocks AS o WHERE o.page_id = p.id AND o.id <> b.id AND o."order" = 7)
   AND NOT EXISTS (SELECT 1 FROM public.blocks AS o WHERE o.page_id = p.id AND o."order" = 8);

DROP FUNCTION IF EXISTS pg_temp.nb_02018_item(text, text, text, boolean);
DROP FUNCTION IF EXISTS pg_temp.nb_02018_fragment(text, text, text, text, text, text);
DROP FUNCTION IF EXISTS pg_temp.nb_02018_json_inner(text);
DROP TABLE IF EXISTS pg_temp.nb_02018_edits;
DROP TABLE IF EXISTS pg_temp.nb_02018_fields;
