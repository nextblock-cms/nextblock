-- 02040: home page, EN + FR -- the partner program section (02034) moves one section down, below
-- "More Than a CMS. An Ecosystem.". 02034 put it right after the Cortex AI section, so two dark
-- gradient sections with the same text-and-stat-cards layout sat back to back. One section lower,
-- the light Ecosystem section (which also holds "Join Our Community.") separates them, and the
-- partner section becomes the call to action before the FAQ ("Have Questions?"), whose centred
-- layout does not repeat it. Order only; no copy, no schema.
--
-- How: per page (EN 'home', FR 'accueil'; never blocks.id, ids drift on every install) the three
-- sections are found by content signature: the partner section by its sentinel class
-- 'nb-partner-program', the Cortex AI section by the anchors 02034 used, the Ecosystem section by
-- its heading ("More Than a CMS. An Ecosystem." / "Plus qu'un CMS. Un écosystème."). The move runs
-- only on the layout 02034 left: the block right before the partner section is the Cortex AI section
-- and the block right after it is the Ecosystem section. The partner and Ecosystem sections swap
-- their "order" values, so no other block moves. A home page an operator rearranged is left alone
-- and a NOTICE names it; a page whose partner section already follows the Ecosystem section (a
-- re-run, or an operator who moved it there) is left alone silently.
--
-- Live Draft rows (content_drafts) of a page that moved get the same swap when their block list
-- holds the same three sections in the same order, so publishing a draft started before this
-- migration cannot put the section back. A draft block's position is its "order" when that is a
-- number and its index otherwise (buildBlockInsertPayload in app/actions/visualEditingActions.ts),
-- so the two swapped blocks get explicit "order" values. Revisions are left as they are: restoring
-- one is an explicit choice of that layout.
--
-- Idempotent and non-destructive: a second run finds the partner section after the Ecosystem
-- section and changes nothing.
--
-- NOTE: keep the word "sandbox" OUT of this filename -- generate-sandbox-reset.ts excludes any
-- migration whose filename contains "sandbox" from the reset bundle.

DO $nb_02040_partner_section$
DECLARE
  r record;
  d record;
  v_page bigint;
  v_partner_count integer;
  v_partner_id bigint;
  v_partner_order integer;
  v_prev_id bigint;
  v_prev_type text;
  v_prev_body text;
  v_next_id bigint;
  v_next_order integer;
  v_next_type text;
  v_next_body text;
  v_n integer;
  v_eff numeric[];
  v_i integer;
  v_prev_k integer;
  v_next_k integer;
  v_blocks jsonb;
BEGIN
  FOR r IN
    SELECT *
      FROM (VALUES
        ('en', 'home', '%Now Available — Cortex AI%', '%Cortex AI Is the%',
         '%More Than a CMS. An Ecosystem.%'),
        -- "_" stands for the apostrophe (straight or typographic) and the accented letters.
        ('fr', 'accueil', '%Maintenant disponible — Cortex AI%', '%Cortex AI est la mise%',
         '%Plus qu_un CMS. Un _cosyst_me.%')
      ) AS t (code, slug, anchor, anchor_fallback, ecosystem)
  LOOP
    v_page := NULL;
    SELECT p.id
      INTO v_page
      FROM public.pages AS p
      JOIN public.languages AS l ON l.id = p.language_id
     WHERE p.slug = r.slug
       AND l.code = r.code
     ORDER BY p.id
     LIMIT 1;
    CONTINUE WHEN v_page IS NULL;

    SELECT count(*), min(b.id)
      INTO v_partner_count, v_partner_id
      FROM public.blocks AS b
     WHERE b.page_id = v_page
       AND b.block_type = 'section'
       AND b.content::text LIKE '%nb-partner-program%';
    -- No partner section: 02034 left this (customized) home page alone, so there is nothing to move.
    CONTINUE WHEN v_partner_count = 0;
    IF v_partner_count > 1 THEN
      RAISE NOTICE '02040: the % page "%" has % partner program sections; left unchanged.',
        r.code, r.slug, v_partner_count;
      CONTINUE;
    END IF;

    SELECT b."order" INTO v_partner_order FROM public.blocks AS b WHERE b.id = v_partner_id;

    v_prev_id := NULL; v_prev_type := NULL; v_prev_body := NULL;
    SELECT b.id, b.block_type, b.content::text
      INTO v_prev_id, v_prev_type, v_prev_body
      FROM public.blocks AS b
     WHERE b.page_id = v_page
       AND b."order" < v_partner_order
     ORDER BY b."order" DESC, b.id DESC
     LIMIT 1;

    -- Already below the Ecosystem section: a re-run, or an operator moved it there.
    CONTINUE WHEN v_prev_type = 'section' AND v_prev_body LIKE r.ecosystem;

    v_next_id := NULL; v_next_order := NULL; v_next_type := NULL; v_next_body := NULL;
    SELECT b.id, b."order", b.block_type, b.content::text
      INTO v_next_id, v_next_order, v_next_type, v_next_body
      FROM public.blocks AS b
     WHERE b.page_id = v_page
       AND b."order" > v_partner_order
     ORDER BY b."order", b.id
     LIMIT 1;

    IF v_prev_id IS NULL OR v_next_id IS NULL
       OR v_prev_type IS DISTINCT FROM 'section'
       OR NOT (v_prev_body LIKE r.anchor OR v_prev_body LIKE r.anchor_fallback)
       OR v_next_type IS DISTINCT FROM 'section'
       OR v_next_body NOT LIKE r.ecosystem
       OR EXISTS (SELECT 1 FROM public.blocks AS b
                   WHERE b.page_id = v_page AND b."order" = v_partner_order AND b.id <> v_partner_id) THEN
      RAISE NOTICE '02040: the partner program section of the % page "%" is not between the Cortex AI and Ecosystem sections; left where it is.',
        r.code, r.slug;
      CONTINUE;
    END IF;

    UPDATE public.blocks SET "order" = v_next_order, updated_at = now() WHERE id = v_partner_id;
    UPDATE public.blocks SET "order" = v_partner_order, updated_at = now() WHERE id = v_next_id;

    -- Live Draft rows of this page (their on_content_drafts_update trigger stamps updated_at).
    FOR d IN
      SELECT c.id, c.blocks
        FROM public.content_drafts AS c
       WHERE c.parent_type = 'page' AND c.parent_id = v_page
    LOOP
      v_n := jsonb_array_length(d.blocks);
      CONTINUE WHEN v_n < 3;

      -- Each draft block's position: its "order" when that is a number, else its index.
      v_eff := ARRAY(
        SELECT CASE WHEN jsonb_typeof(d.blocks -> i -> 'order') = 'number'
                    THEN (d.blocks -> i ->> 'order')::numeric ELSE i END
          FROM generate_series(0, v_n - 1) AS i
         ORDER BY i);

      v_partner_count := 0; v_i := NULL;
      SELECT count(*), min(i)
        INTO v_partner_count, v_i
        FROM generate_series(0, v_n - 1) AS i
       WHERE d.blocks -> i ->> 'block_type' = 'section'
         AND (d.blocks -> i -> 'content')::text LIKE '%nb-partner-program%';
      CONTINUE WHEN v_partner_count <> 1;
      CONTINUE WHEN EXISTS (SELECT 1 FROM generate_series(0, v_n - 1) AS i
                             WHERE i <> v_i AND v_eff[i + 1] = v_eff[v_i + 1]);

      v_prev_k := NULL; v_next_k := NULL;
      SELECT i INTO v_prev_k
        FROM generate_series(0, v_n - 1) AS i
       WHERE v_eff[i + 1] < v_eff[v_i + 1]
       ORDER BY v_eff[i + 1] DESC, i DESC
       LIMIT 1;
      SELECT i INTO v_next_k
        FROM generate_series(0, v_n - 1) AS i
       WHERE v_eff[i + 1] > v_eff[v_i + 1]
       ORDER BY v_eff[i + 1], i
       LIMIT 1;
      CONTINUE WHEN v_prev_k IS NULL OR v_next_k IS NULL;
      CONTINUE WHEN (d.blocks -> v_prev_k ->> 'block_type') IS DISTINCT FROM 'section'
                 OR NOT ((d.blocks -> v_prev_k -> 'content')::text LIKE r.anchor
                         OR (d.blocks -> v_prev_k -> 'content')::text LIKE r.anchor_fallback);
      CONTINUE WHEN (d.blocks -> v_next_k ->> 'block_type') IS DISTINCT FROM 'section'
                 OR (d.blocks -> v_next_k -> 'content')::text NOT LIKE r.ecosystem;

      v_blocks := jsonb_set(d.blocks, ARRAY[v_i::text, 'order'], to_jsonb(v_eff[v_next_k + 1]));
      v_blocks := jsonb_set(v_blocks, ARRAY[v_next_k::text, 'order'], to_jsonb(v_eff[v_i + 1]));
      UPDATE public.content_drafts SET blocks = v_blocks WHERE id = d.id;
    END LOOP;
  END LOOP;
END
$nb_02040_partner_section$;
