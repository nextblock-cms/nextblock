-- Migration: 00000000000036_seed_posts_missing_seo_metadata.sql
-- Purpose: Set meta_title and meta_description for remaining seeded blog posts
--          (how-nextblock-works, comment-nextblock-fonctionne, nextblock-commerce-guide, guide-commerce-nextblock)
--          so all 9 seeded posts achieve a 100/100 SEO score.
-- Safety:  Append-only, forward-only, content-guarded updates.

BEGIN;

UPDATE public.posts
   SET meta_title = 'How NextBlock™ Works: Architecture & Under the Hood',
       meta_description = 'Explore the architecture behind NextBlock: monorepo packages, typed block registry, Supabase database, and modern Next.js editor stack.',
       updated_at = NOW()
 WHERE slug = 'how-nextblock-works'
   AND meta_title IS NULL;

UPDATE public.posts
   SET meta_title = 'Comment fonctionne NextBlock™ : Architecture et Moteur',
       meta_description = 'Découvrez les fondations de NextBlock : monorepo, registre de blocs typés, base de données Supabase et moteur d''édition Next.js moderne.',
       updated_at = NOW()
 WHERE slug = 'comment-nextblock-fonctionne'
   AND meta_title IS NULL;

UPDATE public.posts
   SET meta_title = 'The Complete NextBlock™ Commerce Guide | Headless Store',
       meta_description = 'Build global e-commerce with NextBlock: manage products, configure multi-currency pricing, and accept payments with headless Stripe checkout.',
       updated_at = NOW()
 WHERE slug = 'nextblock-commerce-guide'
   AND meta_title IS NULL;

UPDATE public.posts
   SET meta_title = 'Guide Complet du Commerce avec NextBlock™ | E-Commerce',
       meta_description = 'Développez votre boutique avec NextBlock : gestion de produits, tarifs multi-devises et tunnel de paiement headless avec Stripe Checkout.',
       updated_at = NOW()
 WHERE slug = 'guide-commerce-nextblock'
   AND meta_title IS NULL;

COMMIT;
