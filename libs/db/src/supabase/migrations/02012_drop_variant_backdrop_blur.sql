-- 02012: follow-up to 02011 -- also strip variant-prefixed backdrop blurs.
--
-- 02011 removed bare `backdrop-blur*` tokens, but the live-demo promo card on the EN
-- and FR home pages carries `dark:backdrop-blur-xl`, whose token starts with a variant
-- prefix and so did not match `\sbackdrop-blur`. Same reasoning as 02011: the card sits
-- on a solid slate background in dark mode, the blur is invisible and costs a GPU
-- read-back per frame. Idempotent and scoped exactly like 02011.

UPDATE public.blocks
   SET content = regexp_replace(content::text, '\s([a-z]+:)?backdrop-blur(-[a-z0-9]+)?', '', 'g')::jsonb,
       updated_at = now()
 WHERE page_id IS NOT NULL
   AND content::text ~ 'backdrop-blur';

UPDATE public.page_revisions
   SET content = regexp_replace(content::text, '\s([a-z]+:)?backdrop-blur(-[a-z0-9]+)?', '', 'g')::jsonb
 WHERE content::text ~ 'backdrop-blur';
