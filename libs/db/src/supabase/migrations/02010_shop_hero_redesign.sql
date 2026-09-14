-- 02010: shop hero redesign -- shorter copy, a product image, and a compact benefits
-- strip below the product grid (EN 'shop' and FR 'boutique').
--
-- The previous hero was a full-width primary-coloured block holding an h1, an intro
-- line, a second heading, two long paragraphs and a four-item bullet list: ~1,000 px
-- of text and no image, written to satisfy the SEO grader rather than a visitor. It
-- now mirrors the home hero: dark gradient, two columns, one h1, one sentence, two
-- CTAs, and the NextBlock Commerce storefront image (bundled `/images/commerce-wide.webp`,
-- which the rich-text renderer serves through next/image; as the first hero image it
-- is preloaded as the page's LCP element). The four purchase benefits move into a
-- compact card strip after the product grid so the page keeps its supporting copy
-- without it living in the hero.
--
-- Both languages ship together (bilingual content rule). Scoped by parent page +
-- position + a signature of the OLD copy, never by blocks.id: each UPDATE runs once
-- and a re-run matches nothing. The benefits strip is inserted once per page, guarded
-- by its `nb-store-benefits` sentinel. Identity sequences are re-synced first because
-- the seed inserts explicit ids.

DO $$
DECLARE
  v_en bigint;
  v_fr bigint;
  v_shop bigint;
  v_boutique bigint;
BEGIN
  SELECT id INTO v_en FROM public.languages WHERE code = 'en' LIMIT 1;
  SELECT id INTO v_fr FROM public.languages WHERE code = 'fr' LIMIT 1;
  IF v_en IS NULL THEN
    RAISE NOTICE '02010: no English language row; nothing to do.';
    RETURN;
  END IF;

  SELECT id INTO v_shop FROM public.pages WHERE slug = 'shop' AND language_id = v_en LIMIT 1;
  IF v_fr IS NOT NULL THEN
    SELECT id INTO v_boutique FROM public.pages WHERE slug = 'boutique' AND language_id = v_fr LIMIT 1;
  END IF;

  PERFORM setval('public.blocks_id_seq', COALESCE((SELECT MAX(id) FROM public.blocks), 0) + 1, false);

  -- ---------------------------------------------------------------- EN: /shop
  IF v_shop IS NOT NULL THEN
    UPDATE public.blocks
       SET content = $nb${"is_hero":true,"padding":{"top":"lg","bottom":"lg"},"background":{"type":"gradient","gradient":{"type":"linear","direction":"135deg","stops":[{"color":"#020817","position":0},{"color":"#0f172a","position":50},{"color":"#1e293b","position":100}]}},"column_gap":"xl","container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":2},"vertical_alignment":"center","column_blocks":[[{"block_type":"text","content":{"html_content":"<p class='text-xs uppercase tracking-[0.3em] text-cyan-300 font-semibold mb-3'>Official store</p><h1 class='text-4xl md:text-5xl font-extrabold text-white leading-tight mb-4'>NextBlock™ Store</h1><p class='text-lg text-slate-300 leading-relaxed mb-2'>Official licenses for NextBlock™ Commerce and Cortex AI. Instant access, full source code and secure checkout with Stripe and Freemius.</p>"}},{"block_type":"button","content":{"text":"Get NextBlock™ Commerce","url":"/product/nextblock-commerce-pro-commerce-license","variant":"default","size":"lg","position":"left"}},{"block_type":"button","content":{"text":"Start the free Cortex AI trial","url":"/product/nextblock-cortex-ai-cortex-ai-license","variant":"outline","size":"lg","position":"left"}}],[{"block_type":"text","content":{"html_content":"<div class='rounded-3xl overflow-hidden border border-white/10 bg-white/5 p-3 shadow-2xl'><img src='/images/commerce-wide.webp' alt='NextBlock™ Commerce storefront with catalog, cart and checkout' class='w-full h-auto rounded-2xl' /></div>"}}]]}$nb$::jsonb,
           updated_at = now()
     WHERE page_id = v_shop
       AND "order" = 0
       AND block_type = 'section'
       AND content::text LIKE '%Discover our selection of official commercial add-ons%';

    IF NOT EXISTS (SELECT 1 FROM public.blocks WHERE page_id = v_shop AND content::text LIKE '%nb-store-benefits%') THEN
      INSERT INTO public.blocks (page_id, language_id, block_type, content, "order")
      VALUES (v_shop, v_en, 'section', $nb${"padding":{"top":"lg","bottom":"xl"},"background":{"type":"none"},"column_gap":"md","container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":1},"vertical_alignment":"start","column_blocks":[[{"block_type":"text","content":{"html_content":"<div class='nb-store-benefits'><h2 class='text-2xl md:text-3xl font-bold text-foreground text-center mb-8'>Why buy from the official store</h2><div class='grid gap-6 md:grid-cols-2 lg:grid-cols-4'><div class='rounded-2xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900'><p class='text-2xl mb-3'>🧩</p><h3 class='text-base font-bold text-foreground mb-2'>Full source code</h3><p class='text-sm text-slate-600 dark:text-slate-400'>Inspect, customize and adapt every module to your exact requirements.</p></div><div class='rounded-2xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900'><p class='text-2xl mb-3'>♾️</p><h3 class='text-base font-bold text-foreground mb-2'>Perpetual use</h3><p class='text-sm text-slate-600 dark:text-slate-400'>Use the software on your project with full peace of mind.</p></div><div class='rounded-2xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900'><p class='text-2xl mb-3'>🔄</p><h3 class='text-base font-bold text-foreground mb-2'>Automated updates</h3><p class='text-sm text-slate-600 dark:text-slate-400'>Smooth updates that follow each release of NextBlock and Next.js.</p></div><div class='rounded-2xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900'><p class='text-2xl mb-3'>🔒</p><h3 class='text-base font-bold text-foreground mb-2'>Secure checkout</h3><p class='text-sm text-slate-600 dark:text-slate-400'>Payments processed safely by Stripe and Freemius, invoice included.</p></div></div></div>"}}]]}$nb$::jsonb, 2);
    END IF;
  END IF;

  -- ---------------------------------------------------------------- FR: /boutique
  IF v_boutique IS NOT NULL THEN
    UPDATE public.blocks
       SET content = $nb${"is_hero":true,"padding":{"top":"lg","bottom":"lg"},"background":{"type":"gradient","gradient":{"type":"linear","direction":"135deg","stops":[{"color":"#020817","position":0},{"color":"#0f172a","position":50},{"color":"#1e293b","position":100}]}},"column_gap":"xl","container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":2},"vertical_alignment":"center","column_blocks":[[{"block_type":"text","content":{"html_content":"<p class='text-xs uppercase tracking-[0.3em] text-cyan-300 font-semibold mb-3'>Boutique officielle</p><h1 class='text-4xl md:text-5xl font-extrabold text-white leading-tight mb-4'>Boutique NextBlock™</h1><p class='text-lg text-slate-300 leading-relaxed mb-2'>Licences officielles pour NextBlock™ Commerce et Cortex AI. Accès immédiat, code source complet et paiement sécurisé avec Stripe et Freemius.</p>"}},{"block_type":"button","content":{"text":"Obtenir NextBlock™ Commerce","url":"/product/nextblock-commerce-pro-commerce-license-fr","variant":"default","size":"lg","position":"left"}},{"block_type":"button","content":{"text":"Commencer l'essai gratuit de Cortex AI","url":"/product/nextblock-cortex-ai-cortex-ai-license-fr","variant":"outline","size":"lg","position":"left"}}],[{"block_type":"text","content":{"html_content":"<div class='rounded-3xl overflow-hidden border border-white/10 bg-white/5 p-3 shadow-2xl'><img src='/images/commerce-wide.webp' alt='Vitrine NextBlock™ Commerce avec catalogue, panier et paiement' class='w-full h-auto rounded-2xl' /></div>"}}]]}$nb$::jsonb,
           updated_at = now()
     WHERE page_id = v_boutique
       AND "order" = 0
       AND block_type = 'section'
       AND content::text LIKE '%nos extensions officielles et nos outils%';

    IF NOT EXISTS (SELECT 1 FROM public.blocks WHERE page_id = v_boutique AND content::text LIKE '%nb-store-benefits%') THEN
      INSERT INTO public.blocks (page_id, language_id, block_type, content, "order")
      VALUES (v_boutique, v_fr, 'section', $nb${"padding":{"top":"lg","bottom":"xl"},"background":{"type":"none"},"column_gap":"md","container_type":"container","responsive_columns":{"mobile":1,"tablet":1,"desktop":1},"vertical_alignment":"start","column_blocks":[[{"block_type":"text","content":{"html_content":"<div class='nb-store-benefits'><h2 class='text-2xl md:text-3xl font-bold text-foreground text-center mb-8'>Pourquoi acheter sur la boutique officielle</h2><div class='grid gap-6 md:grid-cols-2 lg:grid-cols-4'><div class='rounded-2xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900'><p class='text-2xl mb-3'>🧩</p><h3 class='text-base font-bold text-foreground mb-2'>Code source complet</h3><p class='text-sm text-slate-600 dark:text-slate-400'>Lisez, adaptez et faites évoluer chaque module selon vos besoins.</p></div><div class='rounded-2xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900'><p class='text-2xl mb-3'>♾️</p><h3 class='text-base font-bold text-foreground mb-2'>Licence perpétuelle</h3><p class='text-sm text-slate-600 dark:text-slate-400'>Utilisez le logiciel sur votre projet en toute sérénité.</p></div><div class='rounded-2xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900'><p class='text-2xl mb-3'>🔄</p><h3 class='text-base font-bold text-foreground mb-2'>Mises à jour suivies</h3><p class='text-sm text-slate-600 dark:text-slate-400'>Des mises à jour fluides qui suivent chaque version de NextBlock et de Next.js.</p></div><div class='rounded-2xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900'><p class='text-2xl mb-3'>🔒</p><h3 class='text-base font-bold text-foreground mb-2'>Paiement sécurisé</h3><p class='text-sm text-slate-600 dark:text-slate-400'>Paiements traités en toute sécurité par Stripe et Freemius, facture incluse.</p></div></div></div>"}}]]}$nb$::jsonb, 2);
    END IF;
  END IF;
END $$;
