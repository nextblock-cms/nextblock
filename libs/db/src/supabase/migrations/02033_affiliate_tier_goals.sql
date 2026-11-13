-- 02033: a per-tier goal on affiliate_tiers, shown under each tier on the /partners ladder
-- ("Make 8 confirmed sales, then contact us…"). English lives in goal, other languages in
-- goal_translations ({"fr": "..."}), like name / name_translations (02030 section 2). Edited under
-- CMS -> Affiliates -> Tiers.
--
-- Display only: no SQL reads it and nothing moves a partner when a goal is met. Tier changes stay
-- an admin decision (CMS -> Affiliates -> Overview, "Change tier"), and the page says goals count
-- confirmed sales only (a refunded order does not count).
--
-- Append-only, forward-only, idempotent: ADD COLUMN IF NOT EXISTS, each CHECK dropped by name
-- before it is added, and the seed fills a launch tier (matched by slug, never by id) only while
-- its goal is still NULL, so a goal an operator wrote, or cleared to '' and back, is never touched.
-- The seeded wording is generic ("cleared sales", the page's word for a sale past its refund hold;
-- no product name, no person): the four launch tiers of 02030 exist on every install, and each
-- store edits its goals in the CMS.
--
-- Vendor only: on nextblock.dev (the store that sells NextBlock's modules; detected the way 02032
-- does, by the Commerce Pro license product, Freemius 24851) the Growth and Elite goals then take
-- the vendor's own wording, only while they still read exactly as seeded. Elsewhere, and on the
-- sandbox replay (no products exist yet when it runs), they keep the generic wording.
--
-- Grants: none. affiliate_tiers is granted at the table level (02030 section 14: anon SELECT,
-- authenticated and service_role CRUD under RLS), which covers columns added later; it has no
-- column grant to extend, and the post-apply pass (API_ROLE_REVOKE_SQL) never touches it
-- (migrate-core.test.mjs asserts that). RLS is unchanged: anon still reads active tiers only.

ALTER TABLE public.affiliate_tiers
  ADD COLUMN IF NOT EXISTS goal text NULL,
  ADD COLUMN IF NOT EXISTS goal_translations jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.affiliate_tiers DROP CONSTRAINT IF EXISTS affiliate_tiers_goal_check;
ALTER TABLE public.affiliate_tiers
  ADD CONSTRAINT affiliate_tiers_goal_check
  CHECK (goal IS NULL OR char_length(btrim(goal)) BETWEEN 1 AND 160);

ALTER TABLE public.affiliate_tiers DROP CONSTRAINT IF EXISTS affiliate_tiers_goal_translations_check;
ALTER TABLE public.affiliate_tiers
  ADD CONSTRAINT affiliate_tiers_goal_translations_check
  CHECK (jsonb_typeof(goal_translations) = 'object' AND octet_length(goal_translations::text) <= 2000);

-- The four launch tiers of 02030, English and Quebec French together. French is written with a
-- plain space before ":" (the display helper turns it into a no-break space); none is needed here.
UPDATE public.affiliate_tiers AS t
   SET goal = s.goal_en,
       goal_translations = CASE
         WHEN nullif(btrim(t.goal_translations ->> 'fr'), '') IS NULL
           THEN t.goal_translations || jsonb_build_object('fr', s.goal_fr)
         ELSE t.goal_translations
       END
  FROM (VALUES
    ('starter-partner', 'Simply sign up!', 'Inscrivez-vous, tout simplement!'),
    ('growth-partner', 'Make 8 cleared sales, then contact us to talk about your growth.', 'Réalisez 8 ventes confirmées, puis contactez-nous pour discuter de votre croissance.'),
    ('elite-partner', 'Make 30 cleared sales and get a personal call from our team.', 'Réalisez 30 ventes confirmées et recevez un appel personnel de notre équipe.'),
    ('founding-ambassador', 'Join during the launch offer.', 'Inscrivez-vous pendant l''offre de lancement.')
  ) AS s (slug, goal_en, goal_fr)
 WHERE t.slug = s.slug
   AND t.goal IS NULL;

-- nextblock.dev's own wording (see the header). Both languages move together, and only from the
-- exact seeded text above, so a goal the vendor already edited is left alone. The partners page
-- says that refunded orders never count toward a goal.
DO $nb_02033_vendor_goals$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.products WHERE freemius_product_id = '24851') THEN
    RETURN;
  END IF;

  UPDATE public.affiliate_tiers AS t
     SET goal = v.goal_en,
         goal_translations = jsonb_set(t.goal_translations, '{fr}', to_jsonb(v.goal_fr))
    FROM (VALUES
      ('growth-partner',
       'Make 8 cleared sales, then contact us to talk about your growth.',
       'Réalisez 8 ventes confirmées, puis contactez-nous pour discuter de votre croissance.',
       'Sell 8 modules, then contact us for a meeting to grow.',
       'Vendez 8 modules, puis prenez rendez-vous avec nous pour grandir ensemble.'),
      ('elite-partner',
       'Make 30 cleared sales and get a personal call from our team.',
       'Réalisez 30 ventes confirmées et recevez un appel personnel de notre équipe.',
       'Sell 30 modules and get a call from our CEO.',
       'Vendez 30 modules et recevez un appel de notre PDG.')
    ) AS v (slug, seeded_en, seeded_fr, goal_en, goal_fr)
   WHERE t.slug = v.slug
     AND t.goal = v.seeded_en
     AND t.goal_translations ->> 'fr' = v.seeded_fr;
END
$nb_02033_vendor_goals$;

COMMENT ON COLUMN public.affiliate_tiers.goal IS 'What a partner aims for to reach this tier, shown on the /partners ladder (English; NULL = no goal line). Display only: tier changes stay an admin decision.';
COMMENT ON COLUMN public.affiliate_tiers.goal_translations IS 'Localized goals, e.g. {"fr": "Réalisez 8 ventes confirmées"}; English lives in goal.';
