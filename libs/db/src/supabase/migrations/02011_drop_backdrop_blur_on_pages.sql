-- 02011: remove `backdrop-blur-*` from page blocks (home EN/FR cards, articles heroes).
--
-- Every card sitting on the dark gradient heroes used `backdrop-filter: blur()` via
-- Tailwind's backdrop-blur utilities (`backdrop-blur-xl` on the home hero card and the
-- live-demo promo, `backdrop-blur` on the three MCP-step cards, `backdrop-blur-sm` on
-- the commerce card and the articles heroes). A backdrop blur forces the compositor to
-- read back and blur everything behind the element on every frame; in Lighthouse's
-- trace of the home page the GPU process spent ~390 ms drawing the very first frame,
-- which is the gap between the hero being laid out and the first contentful paint.
-- Behind these cards there is only a smooth gradient or a solid colour, so the blur has
-- no visible effect: `bg-white/5` alone gives the same translucent card.
--
-- Scoped to page blocks that carry the utility (posts and products never did), both
-- languages at once; `regexp_replace` strips the class token wherever it appears in a
-- class list. Idempotent: once stripped, the row no longer matches. page_revisions get
-- the same rewrite so restoring a revision cannot bring the blur back.

UPDATE public.blocks
   SET content = regexp_replace(content::text, '\sbackdrop-blur(-[a-z0-9]+)?', '', 'g')::jsonb,
       updated_at = now()
 WHERE page_id IS NOT NULL
   AND content::text ~ 'backdrop-blur';

UPDATE public.page_revisions
   SET content = regexp_replace(content::text, '\sbackdrop-blur(-[a-z0-9]+)?', '', 'g')::jsonb
 WHERE content::text ~ 'backdrop-blur';
