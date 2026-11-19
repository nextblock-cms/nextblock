-- 02045: public.media_usage(p_media jsonb), where each media item is used, for the media library.
-- Append-only, forward-only, idempotent (CREATE OR REPLACE). One read-only function: no table,
-- policy or data change. EXECUTE belongs to the service role alone: revoked here from PUBLIC, anon
-- and authenticated, and again after every deploy's blanket grant (API_ROLE_REVOKE_SQL in
-- apps/nextblock/tools/lib/migrate-core.mjs and apps/nextblock/lib/setup/schema-apply.ts), the
-- shape 02028 gave media_storage_keys_in_use. The app calls it after its own staff and
-- second-factor check (apps/nextblock/lib/media/media-usage.ts).
--
-- Why (the 0.23.4 follow-up). Since 0.23.4 a product save never deletes media: an image dropped from
-- a gallery is only unlinked, because nothing told whether a page block, a section background, a
-- text block or the social image still showed it (they keep their own copy of the key, and no
-- foreign key tracks them). Media is deleted only from the media library, where someone chooses it.
-- This function tells that person where an item is used before they choose: the delete dialogs list
-- it, the library's "Unused" view lists the items nothing here names, and "Delete unused" checks
-- again at delete time. It is a lookup, not a proof: a reference outside the database (another site,
-- a sent email, a social network's cached preview) is invisible to it.
--
-- Input: { "<media id>": ["<storage key>", ...] }: each media row's id and the keys the app's delete
-- would remove (ownedMediaStorageKeys in apps/nextblock/lib/storage/media-object-keys.ts: the row's
-- object_key and the variants of the same upload). The app computes the keys, so this function keeps
-- no copy of that rule. An entry whose name is not a uuid is ignored, and so is a key that is not a
-- string, holds a character outside [A-Za-z0-9._/-] (the characters the upload routes mint) or is
-- longer than 512 characters (MAX_OBJECT_KEY_LENGTH in apps/nextblock/lib/storage/upload-policy.ts:
-- isSafeObjectKey refuses a longer key, so no upload route mints one, and the app never sends one).
-- Staff can write a media row's keys (a WRITER inserts their own row over PostgREST), so the keys are
-- search strings chosen by the row's author: the app sends only minted keys, at most 17 a row (a row
-- holding any other is asked about by id alone and reported as not checked, never unused:
-- findMediaUsage in apps/nextblock/lib/media/media-usage.ts), and this function matches keys only as
-- whole tokens. It never searches a document for a substring: that would let a row's author probe
-- documents they cannot read (ADMIN-tier settings, partner drafts, inactive redirects), and it costs a
-- full scan of every document per key, so one crafted row could make every lookup that included it
-- time out.
--
-- An item is used where:
--   * a foreign key names its id: product galleries (product_media), variant images
--     (product_variants.main_media_id), page and post feature images, logos;
--   * a document names its id or one of its keys anywhere in its text: blocks (nested sections and
--     their backgrounds, text block HTML, testimonial and custom block fields), content and product
--     drafts (meta and blocks), products (description_json, metadata, short_description),
--     site_settings (site_social_image, the branding and CSS rows), custom block definitions,
--     navigation item URLs, redirect destinations, category descriptions, theme tokens and CSS,
--     profile pictures, partner storefront pages (draft, published and the published profile), and
--     page, post and product revisions, which the app shows as history, not as a use.
-- The secret rows of site_settings are never read: the rows 02038 keeps for the service role alone,
-- by its own rule (the seven named keys, cortex_ai_mcp_settings among them, and any key ending like a
-- secret, in any case). They hold envelopes and settings, never media, and a match there would name
-- a secret row to the caller.
-- Each document is read once, as JSON text: a jsonb column's ::text, and a plain text column
-- through to_json, so a backslash in any document starts an escape. Its uuids are read in any case.
-- When a key was sent, every run of storage-key characters ([A-Za-z0-9._/-]) holding a dot and an
-- extension is also cut into the suffixes that start after a '/' (or at the run's start), with
-- '%2F' read as '/' first (Next's image optimizer URLs): a key sits at the end of its URL's path,
-- after the media base. Before that, every JSON escape whose letter is a storage-key character
-- becomes a space, and so does every escaped backslash, read left to right so that one stays a
-- single character. A control character in a string is written as such an escape (\n, \t, \r, \b,
-- \f, or \u and four hex digits), and its letter used to glue to the key after it: a key on its own
-- line in a text field was never found, so its file was listed as unused and "Delete unused"
-- deleted it. An escaped quote needs nothing (a quote is no key character), and neither do uuids:
-- their pattern has no boundaries, so an escape's letter before one (b and f are hex) never hides
-- it. Before even that, a stored \/ (a backslash right before a slash) is read as '/': JSON pasted
-- into a text field may escape every slash (JSON-LD as PHP's json_encode writes it,
-- https:\/\/cdn.example.com\/uploads\/a.png), and the escaped backslash before each slash cut the
-- run there, so uploads/a.png was never found and "Delete unused" deleted its file. Text with
-- escaped slashes now names a key exactly where the same text without those backslashes would. That
-- is not only more matches: a key directly followed by \/ and more key characters is part of a
-- longer run and not found, as uploads/a.png/x already is not. Any other backslash still separates
-- (in a stored \\/ the first one does). A key matches one of those tokens exactly, so only a suffix
-- that could equal a key sent is built: none longer than the longest key (at most 512 characters,
-- above) and none with more '/'-separated segments than the deepest key has, and each run is split
-- once. Building every suffix cost the square of a run's length, and non-staff write documents read
-- here (a profile picture URL, which anyone who signs up sets; a partner's storefront draft): one
-- avatar_url of 20,000 slashes made every lookup take tens of seconds (36 to 85 s on local
-- replays), far past the Data API's 8 s statement timeout, so the Unused view listed nothing and
-- "Delete unused" deleted nothing. Now a lookup grows with the length of the documents.
-- Limits: a key glued into a longer run (uploads/a.png.bak) is not found, and a key at the bucket
-- root matches that file name under any URL (counted as a use: the safe direction). A key right
-- after an escape whose letter is a key character (a \b, \f, \n, \r, \t or \u escape) inside a JSON
-- string stored as text (a JSON-LD \n right before it: a backslash, an n, then the key) is not found
-- either, since that letter glues to the key: reading a stored backslash and a letter as a separator
-- would lose nature.png in the text C:\nature.png, where it is found. After an escaped quote,
-- backslash or slash the key is found.
--
-- Output: { "<media id>": { "total": n, "by_kind": { "<kind>": n }, "sites": [ up to 50 of
-- { kind, record_id, parent_type, parent_id, label, language } ] } }, one entry per uuid in the input
-- (lowercased; total 0 when nothing names it). Live uses come first, then drafts, then revisions.
-- One jsonb value, so PostgREST's max_rows (1000 rows a response) never truncates the answer.
--
-- tools/scripts/security-verify.sql section 45 checks the privileges, each kind of use, the secret
-- rows skipped, a key with another character never searched, a key right after a JSON escape found
-- (the pass reads every \b, \f, \n, \r, \t and \uXXXX escape as a separator; the section plants six
-- control characters, a newline, a carriage return, a tab, a backspace, a form feed and U+0001, and
-- an escaped backslash read as one character, in a text block and in a plain text column), a key
-- written with escaped slashes found (JSON-LD in a text block, where a backslash before an escaped
-- slash still separates, and a redirect target), and a profile picture URL of 20,000 slashes
-- answered within a 4 s statement timeout.

CREATE OR REPLACE FUNCTION public.media_usage(p_media jsonb)
    RETURNS jsonb
    LANGUAGE sql STABLE SECURITY INVOKER
    SET search_path TO ''
    AS $$
WITH input AS (
  SELECT lower(e.key) AS media_id, e.value AS keys
    FROM jsonb_each(CASE WHEN jsonb_typeof(p_media) = 'object' THEN p_media ELSE '{}'::jsonb END) AS e
   WHERE e.key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
),
targets AS (
  SELECT DISTINCT i.media_id FROM input i
),
key_needles AS (
  SELECT i.media_id, k.value #>> '{}' AS needle
    FROM input i
   CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(i.keys) = 'array' THEN i.keys ELSE '[]'::jsonb END) AS k(value)
   WHERE jsonb_typeof(k.value) = 'string'
     AND k.value #>> '{}' ~ '^[A-Za-z0-9._/-]+$'
     -- MAX_OBJECT_KEY_LENGTH (apps/nextblock/lib/storage/upload-policy.ts): the key tokens below are
     -- never longer than the longest key, so this caps what one run can cost.
     AND length(k.value #>> '{}') <= 512
),
needles AS (
  SELECT t.media_id, t.media_id AS needle
    FROM targets t
  UNION
  SELECT k.media_id, k.needle
    FROM key_needles k
),
key_limits AS (
  -- A token longer than the longest key sent, or with more '/'-separated segments than the deepest
  -- one has, equals no key: the key tokens stop there.
  SELECT max(length(k.needle)) AS max_length,
         max(cardinality(string_to_array(k.needle, '/'))) AS max_segments
    FROM key_needles k
),
docs AS (
  -- Every body is JSON text: a jsonb column's ::text, a plain text column through to_json (its
  -- backslashes escaped too), so a backslash in a body always starts an escape (the key tokens below).
  SELECT 'block'::text AS kind, b.id::text AS record_id,
         CASE WHEN b.page_id IS NOT NULL THEN 'page'
              WHEN b.post_id IS NOT NULL THEN 'post'
              WHEN b.product_id IS NOT NULL THEN 'product' END AS parent_type,
         coalesce(b.page_id::text, b.post_id::text, b.product_id::text) AS parent_id,
         b.content::text AS body
    FROM public.blocks b
   WHERE b.content IS NOT NULL
  UNION ALL
  SELECT 'content_draft', d.id::text, d.parent_type, d.parent_id::text, concat_ws(' ', d.meta::text, d.blocks::text)
    FROM public.content_drafts d
  UNION ALL
  SELECT 'product_draft', d.id::text, 'product', d.product_id::text, concat_ws(' ', d.meta::text, d.blocks::text)
    FROM public.product_drafts d
  UNION ALL
  SELECT 'product', p.id::text, 'product', p.id::text,
         concat_ws(' ', p.description_json::text, p.metadata::text, to_json(p.short_description)::text)
    FROM public.products p
  UNION ALL
  SELECT 'site_setting', s.key, NULL, NULL, s.value::text
    FROM public.site_settings s
   WHERE s.value IS NOT NULL
     -- 02038's secret rows, by site_settings_read_policy's own rule: keep the two in step.
     AND s.key <> ALL (ARRAY['email_secret','payment_secret','bot_protection_secret','cortex_ai_openrouter_api_key','cortex_ai_pexels_api_key','cortex_ai_unsplash_access_key','cortex_ai_mcp_settings']::text[])
     AND s.key !~* '(_secret|_secret_key|_api_key|_access_key|_private_key|_token|_password|_credentials?)$'
  UNION ALL
  SELECT 'custom_block', c.id::text, NULL, NULL, concat_ws(' ', c.fields::text, c.layout_schema::text)
    FROM public.custom_block_definitions c
  UNION ALL
  SELECT 'navigation_item', n.id::text, NULL, NULL, to_json(n.url)::text
    FROM public.navigation_items n
  UNION ALL
  SELECT 'redirect', r.id::text, NULL, NULL, to_json(r.destination_path)::text
    FROM public.cms_redirects r
  UNION ALL
  SELECT 'category', c.id::text, NULL, NULL, concat_ws(' ', to_json(c.description)::text, c.description_translations::text)
    FROM public.categories c
  UNION ALL
  SELECT 'site_theme', t.id::text, NULL, NULL, concat_ws(' ', t.tokens::text, to_json(t.extra_css)::text)
    FROM public.site_themes t
  UNION ALL
  SELECT 'profile', pr.id::text, NULL, NULL, to_json(pr.avatar_url)::text
    FROM public.profiles pr
   WHERE pr.avatar_url IS NOT NULL
  UNION ALL
  SELECT 'partner_page', ap.id::text, NULL, NULL,
         concat_ws(' ', ap.draft_content::text, ap.published_content::text, ap.published_profile::text)
    FROM public.affiliate_pages ap
  UNION ALL
  SELECT 'page_revision', r.id::text, 'page', r.page_id::text, r.content::text
    FROM public.page_revisions r
  UNION ALL
  SELECT 'post_revision', r.id::text, 'post', r.post_id::text, r.content::text
    FROM public.post_revisions r
  UNION ALL
  SELECT 'product_revision', r.id::text, 'product', r.product_id::text, r.content::text
    FROM public.product_revisions r
),
tokens AS (
  SELECT d.kind, d.record_id, d.parent_type, d.parent_id, lower(m.found[1]) AS token
    FROM docs d
   CROSS JOIN LATERAL regexp_matches(
           d.body, '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}', 'g') AS m(found)
  -- UNION ALL: sites below removes the duplicates, among far fewer rows (only the tokens that equal an
  -- id or a key), so the tokens of every document are not sorted first (on a large site, a sort that
  -- spilled to disk).
  UNION ALL
  -- The suffixes of a run that could equal a key: its last max_length + 1 characters hold them all (a
  -- key and the '/' before it), the suffix from their first part counts only when the run is no
  -- longer than max_length (it is then the whole run), and a suffix has at most max_segments parts.
  -- rtrim and string_to_array are function calls in FROM, so each runs once per run: as subquery
  -- columns they were inlined and evaluated again for every suffix, re-reading the whole run each time.
  -- Before the runs are cut, an escaped slash becomes a slash, then each JSON escape whose letter is a
  -- key character (\n, \t, \r, \b, \f, \u and four hex digits) and each escaped backslash becomes a
  -- space, matched left to right, so an escaped backslash is consumed whole: the text C:\\nb/a.png (a
  -- backslash, then nb/a.png) gives the run nb/a.png, and \nb/a.png (a newline, then b/a.png) gives
  -- b/a.png. Without it the escape's letter glued to the key after it. An escaped quote stays: neither
  -- of its characters belongs to a run.
  -- The escaped slash: a stored \/ is \\/ in the JSON text, an escaped backslash and the slash, and
  -- replace() turns those three characters into '/'. That keeps the left-to-right pairing: jsonb and
  -- to_json never write \/, so the run of backslashes before a '/' in the JSON text is always even (two
  -- for each stored backslash), and replace(), scanning left to right, takes its last pair, which is
  -- one whole escaped backslash; the pairs before it stay for the escape pass, as before (\\\\/, a
  -- stored \\/, gives ' /': the first stored backslash still separates). A plain replace() costs less
  -- than one more regex.
  SELECT d.kind, d.record_id, d.parent_type, d.parent_id, array_to_string(w.parts[i.n:], '/')
    FROM docs d
   CROSS JOIN key_limits kl
   CROSS JOIN LATERAL regexp_matches(
           replace(replace(regexp_replace(replace(d.body, '\\/', '/'), '\\([\\bfnrt]|u[0-9A-Fa-f]{4})', ' ', 'g'), '%2F', '/'), '%2f', '/'),
           '[A-Za-z0-9._/-]*\.[A-Za-z0-9][A-Za-z0-9._/-]*', 'g') AS m(found)
   CROSS JOIN LATERAL rtrim(m.found[1], '._/-') AS r(run)
   CROSS JOIN LATERAL string_to_array(right(r.run, kl.max_length + 1), '/') AS w(parts)
   CROSS JOIN LATERAL generate_series(
           greatest(CASE WHEN length(r.run) > kl.max_length THEN 2 ELSE 1 END,
                    cardinality(w.parts) - kl.max_segments + 1),
           cardinality(w.parts)) AS i(n)
   -- No key sent (an id-only lookup): no document is cut into runs.
   WHERE EXISTS (SELECT 1 FROM key_needles)
),
sites AS (
  SELECT n.media_id, t.kind, t.record_id, t.parent_type, t.parent_id
    FROM tokens t
    JOIN needles n ON n.needle = t.token
  UNION
  SELECT t.media_id, 'product_gallery', pm.product_id::text, 'product', pm.product_id::text
    FROM targets t
    JOIN public.product_media pm ON pm.media_id = t.media_id::uuid
  UNION
  SELECT t.media_id, 'product_variant', v.id::text, 'product', v.product_id::text
    FROM targets t
    JOIN public.product_variants v ON v.main_media_id = t.media_id::uuid
  UNION
  SELECT t.media_id, 'page_feature_image', p.id::text, 'page', p.id::text
    FROM targets t
    JOIN public.pages p ON p.feature_image_id = t.media_id::uuid
  UNION
  SELECT t.media_id, 'post_feature_image', p.id::text, 'post', p.id::text
    FROM targets t
    JOIN public.posts p ON p.feature_image_id = t.media_id::uuid
  UNION
  SELECT t.media_id, 'logo', l.id::text, NULL, NULL
    FROM targets t
    JOIN public.logos l ON l.media_id = t.media_id::uuid
),
labeled AS (
  SELECT s.media_id, s.kind, s.record_id, s.parent_type, s.parent_id,
         CASE s.parent_type
           WHEN 'page' THEN (SELECT pg.title FROM public.pages pg WHERE pg.id = s.parent_id::bigint)
           WHEN 'post' THEN (SELECT po.title FROM public.posts po WHERE po.id = s.parent_id::bigint)
           WHEN 'product' THEN (SELECT pr.title FROM public.products pr WHERE pr.id = s.parent_id::uuid)
           ELSE CASE s.kind
             WHEN 'logo' THEN (SELECT l.name FROM public.logos l WHERE l.id = s.record_id::uuid)
             WHEN 'custom_block' THEN (SELECT c.name FROM public.custom_block_definitions c WHERE c.id = s.record_id::uuid)
             WHEN 'navigation_item' THEN (SELECT n.label FROM public.navigation_items n WHERE n.id = s.record_id::bigint)
             WHEN 'redirect' THEN (SELECT r.source_path FROM public.cms_redirects r WHERE r.id = s.record_id::uuid)
             WHEN 'category' THEN (SELECT c.name FROM public.categories c WHERE c.id = s.record_id::uuid)
             WHEN 'site_theme' THEN (SELECT th.name FROM public.site_themes th WHERE th.id = s.record_id::uuid)
             WHEN 'site_setting' THEN s.record_id
             WHEN 'partner_page' THEN (
               SELECT af.handle FROM public.affiliate_pages ap
                 JOIN public.affiliate_profiles af ON af.id = ap.affiliate_id
                WHERE ap.id = s.record_id::uuid)
           END
         END AS label,
         CASE s.parent_type
           WHEN 'page' THEN (SELECT lg.code FROM public.pages pg JOIN public.languages lg ON lg.id = pg.language_id WHERE pg.id = s.parent_id::bigint)
           WHEN 'post' THEN (SELECT lg.code FROM public.posts po JOIN public.languages lg ON lg.id = po.language_id WHERE po.id = s.parent_id::bigint)
           WHEN 'product' THEN (SELECT lg.code FROM public.products pr JOIN public.languages lg ON lg.id = pr.language_id WHERE pr.id = s.parent_id::uuid)
         END AS language,
         CASE
           WHEN s.kind IN ('page_revision', 'post_revision', 'product_revision') THEN 3
           WHEN s.kind IN ('content_draft', 'product_draft') THEN 2
           ELSE 1
         END AS tier
    FROM sites s
),
ranked AS (
  SELECT l.*,
         row_number() OVER (PARTITION BY l.media_id ORDER BY l.tier, l.kind, l.label NULLS LAST, l.record_id) AS rn
    FROM labeled l
),
per_kind AS (
  SELECT c.media_id, jsonb_object_agg(c.kind, c.n) AS by_kind, sum(c.n)::integer AS total
    FROM (SELECT r.media_id, r.kind, count(*)::integer AS n FROM ranked r GROUP BY r.media_id, r.kind) c
   GROUP BY c.media_id
),
per_site AS (
  SELECT r.media_id,
         jsonb_agg(jsonb_build_object(
           'kind', r.kind,
           'record_id', r.record_id,
           'parent_type', r.parent_type,
           'parent_id', r.parent_id,
           'label', r.label,
           'language', r.language) ORDER BY r.rn) AS sites
    FROM ranked r
   WHERE r.rn <= 50
   GROUP BY r.media_id
)
SELECT coalesce(
         jsonb_object_agg(
           t.media_id,
           jsonb_build_object(
             'total', coalesce(k.total, 0),
             'by_kind', coalesce(k.by_kind, '{}'::jsonb),
             'sites', coalesce(s.sites, '[]'::jsonb))),
         '{}'::jsonb)
  FROM targets t
  LEFT JOIN per_kind k ON k.media_id = t.media_id
  LEFT JOIN per_site s ON s.media_id = t.media_id;
$$;

COMMENT ON FUNCTION public.media_usage(jsonb) IS
  'Where each media item is used: { "<id>": ["<owned key>", ...] } in, { "<id>": { total, by_kind, sites } } out. Service role only (02045).';

REVOKE ALL ON FUNCTION public.media_usage(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.media_usage(jsonb) TO service_role;
