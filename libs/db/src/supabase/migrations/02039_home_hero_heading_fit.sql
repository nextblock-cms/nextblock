-- 02039: home hero H1, EN + FR -- the period stays with the highlighted word, the French heading
-- fits in three lines, and the heading is sized by its column. Copy and markup only; no schema.
--
-- Measured in Chrome on nextblock.dev with the site's own CSS and font (2026-11-12):
-- * The highlighted word ("Production" / "production") is a relative inline-block (the gradient
--   pill). CSS Text 3 puts a soft wrap opportunity after every atomic inline, even right before
--   punctuation, so with the H1's text-wrap: balance the period after the pill wrapped to the
--   start of the next line (". The AI Website"). The pill and its period now sit in one
--   whitespace-nowrap span, which takes that break opportunity away.
-- * French ran to four lines at every desktop width: "Du prompt à la production." (776px at 60px)
--   never fits the 668px column, and "Le CMS constructeur de sites web par l'IA." is 42 characters.
--   The new second sentence, "L'IA bâtit, le CMS publie." (26: the AI builds, the CMS publishes),
--   keeps it at three lines, like English, and carries the prompt-to-production story on; the
--   first sentence of the copy below still holds the full keyphrase ("le CMS constructeur de sites
--   web par l'IA"). No-break spaces keep each clause on one line ("L'IA&nbsp;bâtit," /
--   "le&nbsp;CMS&nbsp;publie."), "The&nbsp;AI" together (narrower fonts such as Roboto otherwise
--   end line 1 on "The") and the English last two words together ("Builder&nbsp;CMS").
-- * The H1 was 60px (md:text-6xl) at every two-column width, where the column is 345px to 668px
--   wide: six to eight lines on tablets, four lines in English at 1280-1365px. It is now sized by
--   its column, clamp(2.5rem, 8.5cqi, 3.75rem) inside an @container wrapper, so it breaks the same
--   way in every column from about 470px wide up (three lines in each language; narrower columns
--   stay at 2.5rem and stack to four). The size sits behind a container variant
--   (@min-[1px]:) over the old text-5xl md:text-6xl, so a stylesheet built before this migration
--   (the deploy window) or a browser without container queries (Safari 15) keeps the old sizes. The
--   line break after the first sentence follows the column too (@md:hidden: it stacks the two
--   sentences in columns under 28rem) instead of the viewport (md:hidden), which left French at
--   four lines from 640px to 767px and a dangling "The" on tablets. mb-0 keeps the gap to the copy
--   below at 16px: the container wrapper stops the H1's bottom margin collapsing into it.
-- * nextblock.dev's English H1 had been edited by hand to drop the period and the <br> ("Prompt
--   to Production The AI Website Builder CMS."). It gets the same new markup, period restored.
--
-- How: per page (EN 'home', FR 'accueil'; never blocks.id, ids drift on every install), the hero
-- section's H1 text block is found by its visible text -- tags dropped (a <br> counts as a space),
-- entities decoded, compared without spaces -- so the seeded markup, a re-serialised copy of the
-- same words (the CMS editor drops the space after a <br>) and nextblock.dev's hand edit all match,
-- while an H1 an operator has reworded is left alone and a NOTICE names the page. Its html_content is
-- replaced whole. Only when a page matched, the same rewrite runs on its Live Draft rows
-- (content_drafts), so publishing a draft started before this migration cannot bring the old H1
-- back, and every old H1 string found (plus the seeded ones) is replaced in its page_revisions, so
-- restoring a revision cannot either. Idempotent: a second run finds nothing to change.
--
-- NOTE: keep the word "sandbox" OUT of this filename -- generate-sandbox-reset.ts excludes any
-- migration whose filename contains "sandbox" from the reset bundle.

-- The visible text of an HTML fragment: a <br> read as a space, other tags dropped, the entities a
-- heading may carry decoded, whitespace (no-break spaces included) collapsed to single spaces.
CREATE OR REPLACE FUNCTION pg_temp.nb_02039_visible_text(src text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT btrim(regexp_replace(
    replace(replace(replace(replace(replace(replace(replace(
      regexp_replace(regexp_replace(COALESCE(src, ''), '<br[^>]*>', ' ', 'gi'), '<[^>]*>', '', 'g'),
      '&nbsp;', ' '), '&#160;', ' '), chr(160), ' '),
      '&#39;', ''''), '&apos;', ''''), chr(8217), ''''),
      '&amp;', '&'),
    '\s+', ' ', 'g'))
$fn$;

-- A string JSON-escaped exactly as Postgres prints it inside jsonb::text, without the quotes.
CREATE OR REPLACE FUNCTION pg_temp.nb_02039_json_inner(src text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT substr(to_jsonb(src)::text, 2, length(to_jsonb(src)::text) - 2)
$fn$;

-- One section's content with every H1 text block whose visible text, compared without spaces, is
-- one of p_old_texts replaced by p_new_html, plus the html it replaced. Anything that is not a hero
-- section, or holds no such H1, comes back unchanged with an empty list.
CREATE OR REPLACE FUNCTION pg_temp.nb_02039_section(
  p_content jsonb, p_old_texts text[], p_new_html text,
  OUT new_content jsonb, OUT old_html text[])
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_cols jsonb;
  v_html text;
  c int;
  i int;
BEGIN
  new_content := p_content;
  old_html := ARRAY[]::text[];
  IF jsonb_typeof(p_content) IS DISTINCT FROM 'object'
     OR (p_content ->> 'is_hero') IS DISTINCT FROM 'true' THEN
    RETURN;
  END IF;
  v_cols := p_content -> 'column_blocks';
  IF jsonb_typeof(v_cols) IS DISTINCT FROM 'array' THEN
    RETURN;
  END IF;
  FOR c IN 0 .. jsonb_array_length(v_cols) - 1 LOOP
    CONTINUE WHEN jsonb_typeof(v_cols -> c) IS DISTINCT FROM 'array';
    FOR i IN 0 .. jsonb_array_length(v_cols -> c) - 1 LOOP
      CONTINUE WHEN (v_cols -> c -> i ->> 'block_type') IS DISTINCT FROM 'text';
      v_html := v_cols -> c -> i -> 'content' ->> 'html_content';
      CONTINUE WHEN v_html IS NULL
                 OR v_html = p_new_html
                 OR position('<h1' IN lower(v_html)) = 0
                 OR NOT (replace(pg_temp.nb_02039_visible_text(v_html), ' ', '')
                         = ANY (ARRAY(SELECT replace(t, ' ', '') FROM unnest(p_old_texts) AS t)));
      new_content := jsonb_set(new_content,
        ARRAY['column_blocks', c::text, i::text, 'content', 'html_content'], to_jsonb(p_new_html));
      old_html := array_append(old_html, v_html);
    END LOOP;
  END LOOP;
END
$fn$;

-- Rewrites the hero H1 of one page, all or nothing: its live blocks first; only if one of them
-- matched, its Live Draft rows and its revisions. Returns the number of live H1s rewritten.
CREATE OR REPLACE FUNCTION pg_temp.nb_02039_page(
  p_slug text, p_lang text, p_old_texts text[], p_new_html text, p_seeded_html text[])
RETURNS integer
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_page bigint;
  r record;
  s record;
  v_blocks jsonb;
  v_changed boolean;
  k int;
  v_found text[] := ARRAY[]::text[];
  v_hits int := 0;
  v_old text;
  v_new_inner text := pg_temp.nb_02039_json_inner(p_new_html);
BEGIN
  SELECT p.id INTO v_page
    FROM public.pages AS p
    JOIN public.languages AS l ON l.id = p.language_id
   WHERE p.slug = p_slug AND l.code = p_lang
   ORDER BY p.id
   LIMIT 1;
  IF v_page IS NULL THEN
    RAISE NOTICE '02039: no % page "%"; nothing to do.', p_lang, p_slug;
    RETURN 0;
  END IF;

  FOR r IN
    SELECT b.id, b.content
      FROM public.blocks AS b
     WHERE b.page_id = v_page
       AND b.block_type = 'section'
       AND b.content ->> 'is_hero' = 'true'
     ORDER BY b."order", b.id
  LOOP
    SELECT * INTO s FROM pg_temp.nb_02039_section(r.content, p_old_texts, p_new_html);
    IF cardinality(s.old_html) > 0 THEN
      UPDATE public.blocks SET content = s.new_content, updated_at = now() WHERE id = r.id;
      v_found := v_found || s.old_html;
      v_hits := v_hits + cardinality(s.old_html);
    END IF;
  END LOOP;

  IF v_hits = 0 THEN
    -- A re-run finds the new H1 already in place: nothing to say.
    IF NOT EXISTS (
         SELECT 1 FROM public.blocks AS b
          WHERE b.page_id = v_page AND b.block_type = 'section'
            AND position(v_new_inner IN b.content::text) > 0) THEN
      RAISE NOTICE '02039: the % page "%" has no hero H1 with the shipped wording; left unchanged.', p_lang, p_slug;
    END IF;
    RETURN 0;
  END IF;

  -- Live Draft rows (their on_content_drafts_update trigger stamps updated_at).
  FOR r IN
    SELECT d.id, d.blocks
      FROM public.content_drafts AS d
     WHERE d.parent_type = 'page' AND d.parent_id = v_page
  LOOP
    v_blocks := r.blocks;
    v_changed := false;
    FOR k IN 0 .. jsonb_array_length(r.blocks) - 1 LOOP
      CONTINUE WHEN (r.blocks -> k ->> 'block_type') IS DISTINCT FROM 'section';
      SELECT * INTO s FROM pg_temp.nb_02039_section(r.blocks -> k -> 'content', p_old_texts, p_new_html);
      CONTINUE WHEN cardinality(s.old_html) = 0;
      v_blocks := jsonb_set(v_blocks, ARRAY[k::text, 'content'], s.new_content);
      v_found := v_found || s.old_html;
      v_changed := true;
    END LOOP;
    IF v_changed THEN
      UPDATE public.content_drafts SET blocks = v_blocks WHERE id = r.id;
    END IF;
  END LOOP;

  -- Revisions (snapshots and JSON Patch diffs alike) hold the H1 as a JSON string: replace every
  -- old string found above, and the seeded ones, wherever they appear verbatim.
  FOR v_old IN
    SELECT DISTINCT x FROM unnest(v_found || p_seeded_html) AS x WHERE x IS DISTINCT FROM p_new_html
  LOOP
    UPDATE public.page_revisions
       SET content = replace(content::text, pg_temp.nb_02039_json_inner(v_old), v_new_inner)::jsonb
     WHERE page_id = v_page
       AND position(pg_temp.nb_02039_json_inner(v_old) IN content::text) > 0;
  END LOOP;

  RETURN v_hits;
END
$fn$;

DO $nb_02039$
BEGIN
  PERFORM pg_temp.nb_02039_page(
    'home', 'en',
    ARRAY[
      'Prompt to Production. The AI Website Builder CMS.',
      'Prompt to Production The AI Website Builder CMS.'
    ],
    replace($en_h1$<div class='@container'><h1 class='text-5xl md:text-6xl @min-[1px]:text-[length:clamp(2.5rem,8.5cqi,3.75rem)] mb-0 font-extrabold tracking-tight text-white text-center leading-tight'>Prompt to <span class='whitespace-nowrap'><span class='relative inline-block mx-1 group'><span class='absolute inset-0 bg-gradient-to-r from-blue-600 to-cyan-400 translate-y-1 md:translate-y-2 transform -skew-x-12 rounded-sm shadow-lg group-hover:skew-x-0 transition-transform duration-300 ease-out'></span><span class='relative text-white italic px-1'>Production</span></span>.</span><br class='@md:hidden' /> The&nbsp;AI Website Builder&nbsp;CMS.</h1></div>$en_h1$, chr(13), ''),
    ARRAY[replace($en_seed$<h1 class='text-5xl md:text-6xl font-extrabold tracking-tight text-white text-center leading-tight'>Prompt to <span class='relative inline-block mx-1 group'><span class='absolute inset-0 bg-gradient-to-r from-blue-600 to-cyan-400 translate-y-1 md:translate-y-2 transform -skew-x-12 rounded-sm shadow-lg group-hover:skew-x-0 transition-transform duration-300 ease-out'></span><span class='relative text-white italic px-1'>Production</span></span>.<br class='md:hidden' /> The AI Website Builder CMS.</h1>$en_seed$, chr(13), '')]);

  PERFORM pg_temp.nb_02039_page(
    'accueil', 'fr',
    ARRAY[
      'Du prompt à la production. Le CMS constructeur de sites web par l''IA.',
      'Du prompt à la production Le CMS constructeur de sites web par l''IA.'
    ],
    replace($fr_h1$<div class='@container'><h1 class='text-5xl md:text-6xl @min-[1px]:text-[length:clamp(2.5rem,8.5cqi,3.75rem)] mb-0 font-extrabold tracking-tight text-white text-center leading-tight'>Du prompt à la <span class='whitespace-nowrap'><span class='relative inline-block mx-1 group'><span class='absolute inset-0 bg-gradient-to-r from-blue-600 to-cyan-400 translate-y-1 md:translate-y-2 transform -skew-x-12 rounded-sm shadow-lg group-hover:skew-x-0 transition-transform duration-300 ease-out'></span><span class='relative text-white italic px-1'>production</span></span>.</span><br class='@md:hidden' /> L'IA&nbsp;bâtit, le&nbsp;CMS&nbsp;publie.</h1></div>$fr_h1$, chr(13), ''),
    ARRAY[replace($fr_seed$<h1 class='text-5xl md:text-6xl font-extrabold tracking-tight text-white text-center leading-tight'>Du prompt à la <span class='relative inline-block mx-1 group'><span class='absolute inset-0 bg-gradient-to-r from-blue-600 to-cyan-400 translate-y-1 md:translate-y-2 transform -skew-x-12 rounded-sm shadow-lg group-hover:skew-x-0 transition-transform duration-300 ease-out'></span><span class='relative text-white italic px-1'>production</span></span>.<br class='md:hidden' /> Le CMS constructeur de sites web par l'IA.</h1>$fr_seed$, chr(13), '')]);
END
$nb_02039$;

DROP FUNCTION IF EXISTS pg_temp.nb_02039_page(text, text, text[], text, text[]);
DROP FUNCTION IF EXISTS pg_temp.nb_02039_section(jsonb, text[], text);
DROP FUNCTION IF EXISTS pg_temp.nb_02039_json_inner(text);
DROP FUNCTION IF EXISTS pg_temp.nb_02039_visible_text(text);
