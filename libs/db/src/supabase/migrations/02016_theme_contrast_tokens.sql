-- Theme tokens that failed WCAG AA on the seeded palettes (measured against the seeded pairs):
--   dark    ring        224 76% 48%  -> 213 94% 68%   focus ring 2.7:1 on a card -> 7.1:1 (8.1:1 on the page)
--   vibrant primary     320 100% 55% -> 320 100% 42%  white button text 3.5:1 -> 4.9:1
--   vibrant destructive 0 100% 50%   -> 0 100% 42%    white button text 4.0:1 -> 5.4:1
--   light   destructive 0 84.2% 60.2% -> 0 72.2% 50.6% light button text 3.6:1 -> 4.6:1
-- Each update is guarded by the seeded value, so a theme an operator has already recoloured in
-- the CMS theme editor is left exactly as they set it. libs/ui/src/styles/theme.css carries the
-- same values for standalone consumers of the UI package.

UPDATE public.site_themes
   SET tokens = tokens || '{"ring": "213 94% 68%"}'::jsonb,
       updated_at = now()
 WHERE slug = 'dark'
   AND tokens->>'ring' = '224 76% 48%';

UPDATE public.site_themes
   SET tokens = tokens || '{"primary": "320 100% 42%"}'::jsonb,
       updated_at = now()
 WHERE slug = 'vibrant'
   AND tokens->>'primary' = '320 100% 55%';

UPDATE public.site_themes
   SET tokens = tokens || '{"destructive": "0 100% 42%"}'::jsonb,
       updated_at = now()
 WHERE slug = 'vibrant'
   AND tokens->>'destructive' = '0 100% 50%';

UPDATE public.site_themes
   SET tokens = tokens || '{"destructive": "0 72.2% 50.6%"}'::jsonb,
       updated_at = now()
 WHERE slug = 'light'
   AND tokens->>'destructive' = '0 84.2% 60.2%';
