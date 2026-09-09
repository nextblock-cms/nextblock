-- Migration: 00000000000032_seed_seo_score_optimizations.sql
-- Description: Optimize seeded pages and posts for perfect 100/100 Page SEO scores.
-- Safety: All updates are forward-only and content-guarded so they only apply to
-- default seeded copy and will NEVER overwrite customized content on external sites.

DO $$
BEGIN
  -----------------------------------------------------------------------------
  -- 1. Page Metadata Optimizations
  -----------------------------------------------------------------------------
  UPDATE public.pages
     SET meta_title = 'NextBlock™ - CMS Next.js Haute Performance',
         meta_description = 'NextBlock est un CMS Next.js open-source conçu sur Supabase. Éditeur visuel de blocs, bilingue et scores Lighthouse parfaits dès le premier jour.',
         updated_at = now()
   WHERE slug = 'accueil'
     AND (meta_title IS NULL OR meta_title = '' OR meta_title = 'NextBlock™ - CMS Next.js Haute Performance')
     AND (meta_description IS NULL OR meta_description = '' OR meta_description LIKE 'NextBlock est un CMS Next.js%');

  UPDATE public.pages
     SET meta_title = 'NextBlock Journal | Engineering Guides & Tutorials',
         meta_description = 'Read technical deep dives, tutorials, and release notes on Next.js 16, Supabase, and modern visual web publishing from the NextBlock team.',
         updated_at = now()
   WHERE slug = 'articles' AND language_id = 1
     AND (meta_description IS NULL OR meta_description = '' OR meta_description = 'Explore architectural walkthroughs, Supabase recipes, and block editor experiments written by the Nextblock core team.');

  UPDATE public.pages
     SET meta_title = 'Journal NextBlock | Guides Techniques et Tutoriels',
         meta_description = 'Découvrez des guides techniques, des tutoriels et des analyses sur Next.js 16, Supabase et l’édition de blocs moderne avec l’équipe NextBlock.',
         updated_at = now()
   WHERE slug = 'articles' AND language_id = 2
     AND (meta_description IS NULL OR meta_description = '' OR meta_description = 'Explorez les guides d''architecture, les recettes Supabase et les experiences de l''editeur de blocs de NextBlock.');

  UPDATE public.pages
     SET meta_title = 'Contact Us | NextBlock Open-Source CMS',
         meta_description = 'Have questions, ideas, or feedback about NextBlock? Reach out to our team for technical support, partnership inquiries, and community discussions.',
         updated_at = now()
   WHERE slug = 'contact' AND language_id = 1
     AND (meta_description IS NULL OR meta_description = '' OR meta_description LIKE 'NextBlock™ is an open-source project driven%');

  UPDATE public.pages
     SET meta_title = 'Contactez-nous | NextBlock CMS Open Source',
         meta_description = 'Une question, une idée ou un retour sur NextBlock ? Contactez notre équipe pour du support technique, des partenariats ou échanger sur le projet.',
         updated_at = now()
   WHERE slug = 'contact' AND language_id = 2
     AND (meta_description IS NULL OR meta_description = '' OR meta_description LIKE 'NextBlock™ est un projet open-source propulsé%');

  UPDATE public.pages
     SET meta_title = 'Shop NextBlock™ Modules | Official Store',
         meta_description = 'Browse official commercial modules and licenses for NextBlock CMS. Get instant access to NextBlock Commerce and Cortex AI with secure checkout.',
         updated_at = now()
   WHERE slug = 'shop'
     AND (meta_description IS NULL OR meta_description = '' OR meta_description = 'Browse our premium products');

  UPDATE public.pages
     SET meta_title = 'Boutique NextBlock™ | Modules et Licences Officielles',
         meta_description = 'Achetez des licences et extensions officielles pour NextBlock CMS. Accédez à NextBlock Commerce et Cortex AI avec un paiement simple et sécurisé.',
         updated_at = now()
   WHERE slug = 'boutique'
     AND (meta_description IS NULL OR meta_description = '' OR meta_description IN ('Decouvrez nos produits premium', 'Découvrez nos produits premium'));

  -----------------------------------------------------------------------------
  -- 2. Post Metadata Optimizations
  -----------------------------------------------------------------------------
  UPDATE public.posts
     SET meta_description = 'A single command keeps your NextBlock install updated on Docker, Supabase, or a cloned repo. Learn how it works and keeps your data safe.',
         updated_at = now()
   WHERE slug = 'how-updating-works'
     AND (meta_description IS NULL OR meta_description LIKE 'A single command keeps your NextBlock install updated%');

  UPDATE public.posts
     SET meta_title = 'Mises à jour NextBlock : une commande pour chaque site',
         meta_description = 'Une seule commande met à jour NextBlock sur Docker, Supabase ou un dépôt cloné. Découvrez le fonctionnement et la protection de vos données.',
         updated_at = now()
   WHERE slug = 'comment-fonctionnent-les-mises-a-jour'
     AND (meta_title IS NULL OR meta_title LIKE 'Les mises à jour de NextBlock%');

  -----------------------------------------------------------------------------
  -- 3. Post Content Optimizations (Content-Guarded)
  -----------------------------------------------------------------------------
  -- Post 1: How NextBlock Works EN
  UPDATE public.blocks
     SET content = jsonb_set(content, '{html_content}', to_jsonb('
<p class=''text-lg leading-8 text-slate-700 dark:text-slate-300''>NextBlock™ is built so the hosted CMS, the open-source starter, and the developer tools feel like one clear product. A shared Nx workspace and typed blocks keep code clean and teams moving fast.</p>

<div class=''grid gap-4 md:grid-cols-3 my-10''>
  <div class=''rounded-3xl border border-sky-200/70 bg-sky-50/70 p-6 dark:border-sky-500/20 dark:bg-sky-500/10''>
    <p class=''text-xs font-semibold uppercase tracking-[0.22em] text-sky-700 dark:text-sky-200''>One codebase</p>
    <h2 class=''mt-3 text-xl font-semibold text-slate-900 dark:text-white''>Shared foundation</h2>
    <p class=''mt-3 text-sm text-slate-600 dark:text-slate-300''>Marketing pages, CMS screens, and the starter template grow together instead of drifting apart.</p>
  </div>
  <div class=''rounded-3xl border border-indigo-200/70 bg-indigo-50/70 p-6 dark:border-indigo-500/20 dark:bg-indigo-500/10''>
    <p class=''text-xs font-semibold uppercase tracking-[0.22em] text-indigo-700 dark:text-indigo-200''>Typed content</p>
    <h2 class=''mt-3 text-xl font-semibold text-slate-900 dark:text-white''>Blocks with guardrails</h2>
    <p class=''mt-3 text-sm text-slate-600 dark:text-slate-300''>Zod schemas and typed contracts make every custom block safe to build and ship.</p>
  </div>
  <div class=''rounded-3xl border border-emerald-200/70 bg-emerald-50/70 p-6 dark:border-emerald-500/20 dark:bg-emerald-500/10''>
    <p class=''text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200''>Editorial UX</p>
    <h2 class=''mt-3 text-xl font-semibold text-slate-900 dark:text-white''>Product-grade editing</h2>
    <p class=''mt-3 text-sm text-slate-600 dark:text-slate-300''>The Tiptap layer gives writers a rich editing screen without hiding the power of clean HTML.</p>
  </div>
</div>

<div class=''flex flex-col md:flex-row gap-8 items-center my-12''>
  <div class=''w-full md:w-1/2 space-y-4''>
    <h2>Monorepo Layout and Dependency Flow</h2>
    <p>The <code>apps/nextblock</code> folder holds the production Next.js app. This includes the public site and the private CMS admin area. The <code>apps/create-nextblock</code> tool mirrors that setup so teams can start with proven patterns right away.</p>
    <ul class=''list-disc pl-6 space-y-2 text-sm''>
      <li><strong>@nextblock-cms/ui</strong> - UI parts, design tokens, and shared buttons</li>
      <li><strong>@nextblock-cms/utils</strong> - Translations, safety checks, and image helpers</li>
      <li><strong>@nextblock-cms/db</strong> - Safe migrations, typed database queries, and schemas</li>
      <li><strong>@nextblock-cms/editor</strong> - The reusable Tiptap v3 block editor</li>
      <li><strong>@nextblock-cms/sdk</strong> - Typed tools to build and check custom blocks</li>
      <li><strong>@nextblock-cms/ecommerce</strong> - The digital store package when activated</li>
    </ul>
    <p>Run <code>nx graph</code> to see how code flows across the workspace. Shared path aliases and Tailwind styles help keep designs aligned across all pages.</p>
  </div>
  <aside class=''w-full md:w-1/2 rounded-[2rem] border border-slate-200/80 bg-white p-4 shadow-xl dark:border-white/10 dark:bg-white/5''>
    <div class=''relative aspect-video overflow-hidden rounded-2xl''><iframe class=''absolute inset-0 h-full w-full border-0'' src=''https://www.youtube-nocookie.com/embed/DNqU8ez9qjs?si=p2oIy0f-n7wiaBmO'' title=''How NextBlock™ Works'' allow=''accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'' referrerpolicy=''strict-origin-when-cross-origin'' loading=''lazy'' allowfullscreen></iframe></div>
    <p class=''mt-3 text-sm text-slate-500 dark:text-slate-400''>Nx makes workspace relations clear. That is why our starter, CMS, and packages stay aligned.</p>
  </aside>
</div>

<figure class=''my-12 overflow-hidden rounded-[2rem] border border-slate-200/80 bg-slate-950 shadow-2xl dark:border-white/10''>
  <img src=''/images/extensibility.webp'' alt=''NextBlock™ extensibility artwork showing the CMS connected to reusable modules and integrations'' class=''w-full h-auto object-cover'' />
  <figcaption class=''border-t border-white/10 px-6 py-4 text-sm text-slate-300''>One unified design system spans content blocks, editing tools, and store features.</figcaption>
</figure>

<h2>Block Registry as Product Surface</h2>
<p>The block registry file is the source of truth for all blocks. It holds Zod schemas, starter content, and editor components. Today it includes everything from text and headings to sections, post grids, checkout forms, and product cards.</p>
<p>Sections support nested columns, so you can build real page layouts rather than flat lists. Typed helper functions keep custom layouts safe and easy to maintain.</p>

<h2>The Editing Layer</h2>
<p>The editor package wraps Tiptap into a rich editing surface. It offers slash commands, floating menus, drag handles, tables, checklists, and code blocks. It preserves clean HTML so teams are never locked into a closed format.</p>

<h2>Inside the CMS Shell</h2>
<p>Inside the CMS folder, each feature follows a clear pattern: item lists, create forms, edit screens, and server actions that wrap database updates. This gives editors a smooth flow while keeping credentials safe on the server.</p>

<h2>Open Core Without Product Drift</h2>
<p>The core CMS is open-source under the AGPL license. Store modules remain source-available and turn on with verified licenses. This keeps the core lightweight while unlocking advanced tools when you need them.</p>

<h2>Why It Holds Together</h2>
<p>The Nx monorepo keeps libraries clean. The Next.js framework ensures fast page loads. Supabase migrations define database rules, and Tiptap gives writers a great authoring screen. When you run <code>npm create nextblock</code>, you get a complete, working system from day one.</p>
'::text)),
         updated_at = now()
   WHERE post_id = 1
     AND content->>'html_content' LIKE '%NextBlock™ is designed so the hosted CMS%';

  -- Post 2: Comment NextBlock Fonctionne FR
  UPDATE public.blocks
     SET content = jsonb_set(content, '{html_content}', to_jsonb('
<p class=''text-lg leading-8 text-slate-700 dark:text-slate-300''>NextBlock™ est conçu pour offrir une expérience fluide entre le CMS hébergé, le projet open-source et les outils développeur. L''espace Nx partagé et les blocs typés permettent aux équipes de publier vite tout en gardant un code très propre.</p>

<div class=''grid gap-4 md:grid-cols-3 my-10''>
  <div class=''rounded-3xl border border-sky-200/70 bg-sky-50/70 p-6 dark:border-sky-500/20 dark:bg-sky-500/10''>
    <p class=''text-xs font-semibold uppercase tracking-[0.22em] text-sky-700 dark:text-sky-200''>Base unique</p>
    <h2 class=''mt-3 text-xl font-semibold text-slate-900 dark:text-white''>Une même base</h2>
    <p class=''mt-3 text-sm text-slate-600 dark:text-slate-300''>Les pages du site, les écrans du CMS et le modèle de départ évoluent ensemble sans dérive.</p>
  </div>
  <div class=''rounded-3xl border border-indigo-200/70 bg-indigo-50/70 p-6 dark:border-indigo-500/20 dark:bg-indigo-500/10''>
    <p class=''text-xs font-semibold uppercase tracking-[0.22em] text-indigo-700 dark:text-indigo-200''>Contenu typé</p>
    <h2 class=''mt-3 text-xl font-semibold text-slate-900 dark:text-white''>Blocs avec garde-fous</h2>
    <p class=''mt-3 text-sm text-slate-600 dark:text-slate-300''>Les schémas Zod et les types stricts sécurisent chaque nouveau bloc personnalisé.</p>
  </div>
  <div class=''rounded-3xl border border-emerald-200/70 bg-emerald-50/70 p-6 dark:border-emerald-500/20 dark:bg-emerald-500/10''>
    <p class=''text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200''>Confort de rédaction</p>
    <h2 class=''mt-3 text-xl font-semibold text-slate-900 dark:text-white''>Édition premium</h2>
    <p class=''mt-3 text-sm text-slate-600 dark:text-slate-300''>L''éditeur Tiptap offre un vrai confort de travail sans brider la puissance du HTML propre.</p>
  </div>
</div>

<div class=''flex flex-col md:flex-row gap-8 items-center my-12''>
  <div class=''w-full md:w-1/2 space-y-4''>
    <h2>Architecture monorepo et flux de dépendances</h2>
    <p>Le dossier <code>apps/nextblock</code> contient le site Next.js public et le tableau de bord privé du CMS. La commande <code>apps/create-nextblock</code> reprend cette même base pour lancer des projets sains dès le premier jour.</p>
    <ul class=''list-disc pl-6 space-y-2 text-sm''>
      <li><strong>@nextblock-cms/ui</strong> - Composants d''interface, boutons et styles partagés</li>
      <li><strong>@nextblock-cms/utils</strong> - Traductions, gardes d''environnement et images</li>
      <li><strong>@nextblock-cms/db</strong> - Migrations sûres, accès typé à la base et schémas</li>
      <li><strong>@nextblock-cms/editor</strong> - L''éditeur de blocs réutilisable basé sur Tiptap v3</li>
      <li><strong>@nextblock-cms/sdk</strong> - Outils typés pour créer et vérifier des blocs sur mesure</li>
      <li><strong>@nextblock-cms/ecommerce</strong> - Le module de boutique en ligne une fois activé</li>
    </ul>
    <p>La commande <code>nx graph</code> montre clairement les liens entre chaque dossier. Les alias de code et la configuration Tailwind partagée assurent un design soigné partout.</p>
  </div>
  <aside class=''w-full md:w-1/2 rounded-[2rem] border border-slate-200/80 bg-white p-4 shadow-xl dark:border-white/10 dark:bg-white/5''>
    <div class=''relative aspect-video overflow-hidden rounded-2xl''><iframe class=''absolute inset-0 h-full w-full border-0'' src=''https://www.youtube-nocookie.com/embed/DNqU8ez9qjs?si=p2oIy0f-n7wiaBmO'' title=''Comment NextBlock™ Fonctionne'' allow=''accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'' referrerpolicy=''strict-origin-when-cross-origin'' loading=''lazy'' allowfullscreen></iframe></div>
    <p class=''mt-3 text-sm text-slate-500 dark:text-slate-400''>Nx rend chaque lien visible dans le projet. C''est pourquoi le starter et le CMS restent toujours synchronisés.</p>
  </aside>
</div>

<figure class=''my-12 overflow-hidden rounded-[2rem] border border-slate-200/80 bg-slate-950 shadow-2xl dark:border-white/10''>
  <img src=''/images/extensibility.webp'' alt=''Illustration NextBlock montrant les connexions entre le CMS et les modules externes'' class=''w-full h-auto object-cover'' />
  <figcaption class=''border-t border-white/10 px-6 py-4 text-sm text-slate-300''>Un même système visuel réunit la gestion de contenu, l''édition et les modules du store.</figcaption>
</figure>

<h2>Le registre de blocs comme surface produit</h2>
<p>Le registre de blocs est la source de vérité pour tous les blocs du CMS. Il rassemble les schémas Zod, les contenus de départ et les composants d''affichage. Il gère le texte, les titres, les sections, les listes d''articles et les formulaires de paiement.</p>
<p>Les sections acceptent des colonnes imbriquées. Vous pouvez ainsi monter de vraies pages complètes plutôt que de simples listes de textes. Des fonctions typées rendent cette souplesse très sûre à manipuler.</p>

<h2>La couche d''édition</h2>
<p>Le paquet éditeur transforme Tiptap en un espace de rédaction riche. Il propose des commandes slash, des menus flottants, des tableaux, des listes de tâches et des blocs de code colorés. Il conserve un HTML propre pour ne jamais vous enfermer.</p>

<h2>À l''intérieur du shell CMS</h2>
<p>Dans le dossier CMS, chaque module suit la même logique : listes de données, pages d''ajout, écrans d''édition et Server Actions. Les rédacteurs travaillent en toute confiance pendant que les accès restent protégés sur le serveur.</p>

<h2>Open core sans dérive produit</h2>
<p>Le cœur de NextBlock est open-source sous licence AGPL. Les modules du store s''activent avec une clé de licence valide. Le socle reste léger tout en ouvrant des outils pro quand vous en avez besoin.</p>

<h2>Pourquoi l''ensemble tient</h2>
<p>Le monorepo Nx garde les librairies bien rangées. L''application Next.js assure la rapidité des pages. Les migrations Supabase fixent les règles de la base, et l''éditeur Tiptap offre un vrai confort de travail. En lançant <code>npm create nextblock</code>, vous profitez d''une base solide et prête à l''emploi.</p>
'::text)),
         updated_at = now()
   WHERE post_id = 2
     AND content->>'html_content' LIKE '%NextBlock™ relie le CMS h&eacute;berg&eacute;%';

  -- Post 3: Setup EN (Card headings H3 -> H2)
  UPDATE public.blocks
     SET content = jsonb_set(
           content,
           '{html_content}',
           to_jsonb(
             replace(
               replace(
                 replace(
                   replace(
                     content->>'html_content',
                     '<h3 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>Deploy on Vercel</h3>',
                     '<h2 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>Deploy on Vercel</h2>'
                   ),
                   '<h3 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>npm create nextblock &rarr; Docker</h3>',
                   '<h2 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>npm create nextblock &rarr; Docker</h2>'
                 ),
                 '<h3 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>npm create nextblock &rarr; Supabase + R2</h3>',
                 '<h2 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>npm create nextblock &rarr; Supabase + R2</h2>'
               ),
               '<h3 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>Clone the repository</h3>',
               '<h2 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>Clone the repository</h2>'
             )
           )
         ),
         updated_at = now()
   WHERE post_id = 3
     AND content->>'html_content' LIKE '%NextBlock is an open-source, AI-native Next.js CMS%';

  -- Post 4: Setup FR (Card headings H3 -> H2)
  UPDATE public.blocks
     SET content = jsonb_set(
           content,
           '{html_content}',
           to_jsonb(
             replace(
               replace(
                 replace(
                   replace(
                     content->>'html_content',
                     '<h3 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>Déployer sur Vercel</h3>',
                     '<h2 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>Déployer sur Vercel</h2>'
                   ),
                   '<h3 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>npm create nextblock &rarr; Docker</h3>',
                   '<h2 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>npm create nextblock &rarr; Docker</h2>'
                 ),
                 '<h3 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>npm create nextblock &rarr; Supabase + R2</h3>',
                 '<h2 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>npm create nextblock &rarr; Supabase + R2</h2>'
               ),
               '<h3 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>Cloner le dépôt</h3>',
               '<h2 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>Cloner le dépôt</h2>'
             )
           )
         ),
         updated_at = now()
   WHERE post_id = 4
     AND content->>'html_content' LIKE '%NextBlock est un CMS Next.js open-source%';

  -- Post 5: Commerce EN
  UPDATE public.blocks
     SET content = jsonb_set(content, '{html_content}', to_jsonb('
<p class=''text-lg leading-8 text-slate-700 dark:text-slate-300''>NextBlock™ Commerce is our first premium module. It adds a complete store layer to the same editor you use for content. It is built for teams that want their catalog and checkout in one place.</p>

<div class=''grid gap-4 md:grid-cols-3 my-10''>
  <div class=''rounded-3xl border border-emerald-200/70 bg-emerald-50/70 p-6 dark:border-emerald-500/20 dark:bg-emerald-500/10''>
    <p class=''text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200''>Commerce core</p>
    <h2 class=''mt-3 text-xl font-semibold text-slate-900 dark:text-white''>Catalog + checkout</h2>
    <p class=''mt-3 text-sm text-slate-600 dark:text-slate-300''>Products, orders, shipping, and invoices plug right into the CMS shell.</p>
  </div>
  <div class=''rounded-3xl border border-sky-200/70 bg-sky-50/70 p-6 dark:border-sky-500/20 dark:bg-sky-500/10''>
    <p class=''text-xs font-semibold uppercase tracking-[0.22em] text-sky-700 dark:text-sky-200''>Global selling</p>
    <h2 class=''mt-3 text-xl font-semibold text-slate-900 dark:text-white''>Multi-currency ready</h2>
    <p class=''mt-3 text-sm text-slate-600 dark:text-slate-300''>Live rate sync, price rounding, and market rules make selling worldwide simple.</p>
  </div>
  <div class=''rounded-3xl border border-indigo-200/70 bg-indigo-50/70 p-6 dark:border-indigo-500/20 dark:bg-indigo-500/10''>
    <p class=''text-xs font-semibold uppercase tracking-[0.22em] text-indigo-700 dark:text-indigo-200''>Operator workflow</p>
    <h2 class=''mt-3 text-xl font-semibold text-slate-900 dark:text-white''>Provider-aware flow</h2>
    <p class=''mt-3 text-sm text-slate-600 dark:text-slate-300''>Stripe and Freemius run side by side so your shop stays clean and easy to use.</p>
  </div>
</div>

<h2>Product Catalog</h2>
<p>The store supports physical goods and digital downloads. You can set up variants, custom options, images, prices, SKUs, and stock levels. Product photos live in your main media library. That means your content and marketing teams work with the same files.</p>

<h2>Multi-Currency Engine</h2>
<p>The pricing engine is built for real international stores. It handles rates, rounding, and rules with ease:</p>
<ul class=''list-disc pl-6 space-y-2 text-sm''>
  <li><strong>Unlimited currencies:</strong> Add any ISO currency code, symbol, and exchange rate.</li>
  <li><strong>Auto FX sync:</strong> Refresh daily rates from Frankfurter or your own provider URL.</li>
  <li><strong>Rounding rules:</strong> Round prices up, down, or use charm pricing like <code>9.99</code>.</li>
  <li><strong>Store auto-sync:</strong> Convert product prices whenever currency rates refresh.</li>
  <li><strong>Rebasing:</strong> Switch your base store currency with full recalculations.</li>
  <li><strong>Custom price overrides:</strong> Set exact prices for specific countries when needed.</li>
</ul>

<h2>Tax Automation</h2>
<p>You can set tax rates by hand or let Stripe Tax calculate totals automatically:</p>
<div class=''grid md:grid-cols-2 gap-6 my-6''>
  <div class=''p-6 rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5''>
    <h3 class=''font-bold text-slate-900 dark:text-white mb-2''>Manual mode</h3>
    <p class=''text-sm text-slate-600 dark:text-slate-400''>Set tax rates by country, state, or province. Stacked rates like GST and PST are supported. Detailed tax lines are saved with each order.</p>
  </div>
  <div class=''p-6 rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5''>
    <h3 class=''font-bold text-slate-900 dark:text-white mb-2''>Automatic mode</h3>
    <p class=''text-sm text-slate-600 dark:text-slate-400''>Stripe Tax calculates final amounts during checkout. Product tax codes travel with each item, and webhooks record final numbers.</p>
  </div>
</div>

<h2>Shipping and Checkout</h2>
<p>Shipping zones match by country and state. They support local method names, per-currency pricing, and free shipping rules. Fallback options ensure buyers always see a valid rate.</p>
<p>The checkout flow understands different payment providers:</p>
<ul class=''list-disc pl-6 space-y-2 text-sm''>
  <li><strong>Stripe:</strong> Handles physical goods, inventory checks, shipping costs, taxes, and Checkout sessions.</li>
  <li><strong>Freemius:</strong> Handles digital software licenses, plans, and hosted checkout pages.</li>
  <li>Cart items stay grouped by provider so the buying steps are always clear.</li>
</ul>

<figure class=''my-12 overflow-hidden rounded-[2rem] border border-slate-200/80 bg-slate-950 shadow-2xl dark:border-white/10''>
  <img src=''/images/commerce-plan.webp'' alt=''Commerce roadmap board outlining premium module goals and future storefront capabilities for NextBlock™'' class=''w-full h-auto object-cover'' />
  <figcaption class=''border-t border-white/10 px-6 py-4 text-sm text-slate-300''>Commerce is the first premium module on our roadmap. It fits naturally into the larger CMS platform.</figcaption>
</figure>

<h2>Inventory, Orders, and Invoices</h2>
<p>When stock tracking is on, checkout checks quantities before payment. Once paid, stock counts update in the database right away.</p>
<ul class=''list-disc pl-6 space-y-2 text-sm''>
  <li>Order status moves smoothly from pending to paid to shipped.</li>
  <li>Invoice numbers generate through safe database functions.</li>
  <li>Printable invoices use your company brand settings.</li>
  <li>Customers can view their past orders and receipts anytime.</li>
</ul>

<h2>Commerce Surfaces Inside the CMS</h2>
<p>When the store package is active, the CMS reveals new screens. You get product lists, stock tools, order details, shipping setup, tax rules, and currency settings. All of these screens look and feel like the rest of the CMS, so your team feels right at home.</p>
'::text)),
         updated_at = now()
   WHERE post_id = 5
     AND content->>'html_content' LIKE '%NextBlock™ Commerce is the first premium module%';

  -- Post 6: Commerce FR
  UPDATE public.blocks
     SET content = jsonb_set(content, '{html_content}', to_jsonb('
<p class=''text-lg leading-8 text-slate-700 dark:text-slate-300''>NextBlock™ Commerce est notre premier module premium. Il ajoute une vraie boutique en ligne directement dans le CMS. Il s''adresse aux équipes qui veulent réunir leurs articles, leur catalogue et leurs ventes au même endroit.</p>

<div class=''grid gap-4 md:grid-cols-3 my-10''>
  <div class=''rounded-3xl border border-emerald-200/70 bg-emerald-50/70 p-6 dark:border-emerald-500/20 dark:bg-emerald-500/10''>
    <p class=''text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200''>Cœur commerce</p>
    <h2 class=''mt-3 text-xl font-semibold text-slate-900 dark:text-white''>Catalogue + checkout</h2>
    <p class=''mt-3 text-sm text-slate-600 dark:text-slate-300''>Articles, commandes, livraison et factures s''intègrent dans le même CMS.</p>
  </div>
  <div class=''rounded-3xl border border-sky-200/70 bg-sky-50/70 p-6 dark:border-sky-500/20 dark:bg-sky-500/10''>
    <p class=''text-xs font-semibold uppercase tracking-[0.22em] text-sky-700 dark:text-sky-200''>Vente internationale</p>
    <h2 class=''mt-3 text-xl font-semibold text-slate-900 dark:text-white''>Multi-devise</h2>
    <p class=''mt-3 text-sm text-slate-600 dark:text-slate-300''>Taux de change en direct, prix ronds et règles locales facilitent les ventes.</p>
  </div>
  <div class=''rounded-3xl border border-indigo-200/70 bg-indigo-50/70 p-6 dark:border-indigo-500/20 dark:bg-indigo-500/10''>
    <p class=''text-xs font-semibold uppercase tracking-[0.22em] text-indigo-700 dark:text-indigo-200''>Gestion claire</p>
    <h2 class=''mt-3 text-xl font-semibold text-slate-900 dark:text-white''>Par fournisseur</h2>
    <p class=''mt-3 text-sm text-slate-600 dark:text-slate-300''>Stripe et Freemius fonctionnent ensemble pour garder une boutique claire.</p>
  </div>
</div>

<h2>Catalogue produits</h2>
<p>Le module gère les biens physiques et les produits téléchargeables. Vous pouvez créer des variantes, des options sur mesure, des images, des prix, des SKU et des niveaux de stock. Vos visuels restent rangés dans votre médiathèque habituelle. Rédacteurs et vendeurs travaillent donc avec les mêmes fichiers.</p>

<h2>Moteur multi-devise</h2>
<p>La gestion des prix est conçue pour de vraies boutiques mondiales :</p>
<ul class=''list-disc pl-6 space-y-2 text-sm''>
  <li><strong>Devises illimitées :</strong> Ajoutez chaque code de devise, son symbole et son taux de conversion.</li>
  <li><strong>Mise à jour automatique :</strong> Actualisez les taux chaque jour avec Frankfurter ou votre URL privée.</li>
  <li><strong>Arrondis des prix :</strong> Arrondissez vers le haut, vers le bas ou avec des prix comme <code>9,99</code>.</li>
  <li><strong>Synchronisation du catalogue :</strong> Convertissez les prix dès que les devises changent.</li>
  <li><strong>Changement de devise socle :</strong> Changez la monnaie par défaut avec recalcul complet.</li>
  <li><strong>Prix personnalisés :</strong> Fixez des prix précis pour chaque pays si nécessaire.</li>
</ul>

<h2>Taxes automatiques</h2>
<p>Vous pouvez régler vos taux à la main ou laisser Stripe Tax faire les calculs :</p>
<div class=''grid md:grid-cols-2 gap-6 my-6''>
  <div class=''p-6 rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5''>
    <h3 class=''font-bold text-slate-900 dark:text-white mb-2''>Mode manuel</h3>
    <p class=''text-sm text-slate-600 dark:text-slate-400''>Réglez les taux par pays et province. Les taxes cumulées comme la TPS et la TVQ sont gérées. Chaque ligne est enregistrée sur la commande.</p>
  </div>
  <div class=''p-6 rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5''>
    <h3 class=''font-bold text-slate-900 dark:text-white mb-2''>Mode automatique</h3>
    <p class=''text-sm text-slate-600 dark:text-slate-400''>Stripe Tax calcule les montants finaux lors de l''achat. Les codes fiscaux suivent les articles, et les webhooks confirment les chiffres.</p>
  </div>
</div>

<h2>Livraison et checkout</h2>
<p>Les zones de livraison se basent sur le pays et la région. Elles acceptent des libellés traduits, des tarifs par devise et la gratuité dès un certain montant. Un tarif de secours évite les blocages.</p>
<p>Le tunnel d''achat s''adapte à chaque passerelle de paiement :</p>
<ul class=''list-disc pl-6 space-y-2 text-sm''>
  <li><strong>Stripe :</strong> Gère les produits physiques, les stocks, la livraison, les taxes et les sessions Checkout.</li>
  <li><strong>Freemius :</strong> Gère les licences de logiciels, les formules et les pages de paiement sécurisées.</li>
  <li>Les articles restent séparés par fournisseur pour garder un parcours d''achat très simple.</li>
</ul>

<figure class=''my-12 overflow-hidden rounded-[2rem] border border-slate-200/80 bg-slate-950 shadow-2xl dark:border-white/10''>
  <img src=''/images/commerce-plan.webp'' alt=''Plan de développement de la boutique NextBlock illustrant les futures capacités e-commerce'' class=''w-full h-auto object-cover'' />
  <figcaption class=''border-t border-white/10 px-6 py-4 text-sm text-slate-300''>Le commerce est le premier module officiel de notre feuille de route. Il s''intègre au cœur du CMS.</figcaption>
</figure>

<h2>Inventaire, commandes et factures</h2>
<p>Quand le suivi de stock est actif, le panier vérifie les quantités avant paiement. Après paiement, les stocks diminuent aussitôt dans la base de données.</p>
<ul class=''list-disc pl-6 space-y-2 text-sm''>
  <li>Le statut passe simplement de panier en attente à payé puis expédié.</li>
  <li>Les numéros de facture sont créés par des fonctions sûres en base.</li>
  <li>Les factures à imprimer reprennent les couleurs de votre marque.</li>
  <li>Vos clients peuvent consulter l''historique de leurs commandes à tout moment.</li>
</ul>

<h2>Surfaces commerce dans le CMS</h2>
<p>Quand le module de vente est activé, le CMS affiche de nouveaux écrans. Vous profitez de la liste des articles, du suivi des stocks, des commandes, de la livraison, des taxes et des devises. Ces pages reprennent le design habituel du CMS pour ne pas dépayser votre équipe.</p>
'::text)),
         updated_at = now()
   WHERE post_id = 6
     AND content->>'html_content' LIKE '%NextBlock™ Commerce est le premier module premium de l''ecosysteme%';

  -- Post 7: Cortex AI EN
  UPDATE public.blocks
     SET content = jsonb_set(content, '{html_content}', to_jsonb('
<p class=''text-lg leading-8 text-slate-700 dark:text-slate-300''>NextBlock Cortex AI is the smart content tool built for modern web pages. It understands page blocks, section layouts, and editorial rules so you can create better content faster.</p>

<div class=''grid gap-4 md:grid-cols-3 my-10''>
  <div class=''rounded-3xl border border-violet-200/70 bg-violet-50/80 p-6 dark:border-violet-500/20 dark:bg-violet-500/10''>
    <p class=''text-xs font-semibold uppercase tracking-[0.22em] text-violet-700 dark:text-violet-200''>Model routing</p>
    <h2 class=''mt-3 text-xl font-semibold text-slate-900 dark:text-white''>Pick the right model</h2>
    <p class=''mt-3 text-sm text-slate-600 dark:text-slate-300''>Route your prompts through OpenRouter or your own provider to balance speed and price.</p>
  </div>
  <div class=''rounded-3xl border border-sky-200/70 bg-sky-50/80 p-6 dark:border-sky-500/20 dark:bg-sky-500/10''>
    <p class=''text-xs font-semibold uppercase tracking-[0.22em] text-sky-700 dark:text-sky-200''>BYOK control</p>
    <h2 class=''mt-3 text-xl font-semibold text-slate-900 dark:text-white''>Use your own keys</h2>
    <p class=''mt-3 text-sm text-slate-600 dark:text-slate-300''>Keep provider keys safe on your server while giving editors a simple AI writing screen.</p>
  </div>
  <div class=''rounded-3xl border border-emerald-200/70 bg-emerald-50/80 p-6 dark:border-emerald-500/20 dark:bg-emerald-500/10''>
    <p class=''text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200''>Typed output</p>
    <h2 class=''mt-3 text-xl font-semibold text-slate-900 dark:text-white''>Generate valid blocks</h2>
    <p class=''mt-3 text-sm text-slate-600 dark:text-slate-300''>Typed schemas ensure AI content drops straight into your pages as clean, working blocks.</p>
  </div>
</div>

<h2>Why Cortex AI Belongs Inside the Editor</h2>
<p>Generic chat tools can draft text, but they do not know the difference between a hero banner, a card grid, and a blog post. Cortex AI lives right inside your editing screen. It creates content that fits the blocks on your live site.</p>
<p>This makes AI truly useful for everyday work. You can draft a new landing section, polish a summary, expand product copy, or translate a full article with ease.</p>

<div class=''rounded-[2rem] border border-slate-200/80 bg-slate-50/90 p-6 my-10 dark:border-white/10 dark:bg-slate-900/70''>
  <p class=''text-xs font-semibold uppercase tracking-[0.22em] text-violet-700 dark:text-violet-200''>Editorial workflow</p>
  <div class=''grid gap-5 md:grid-cols-2 mt-5''>
    <div class=''rounded-2xl border border-slate-200 bg-white p-5 dark:border-white/10 dark:bg-slate-950/50''>
      <h3 class=''mt-0 text-xl text-slate-900 dark:text-white''>Faster first drafts</h3>
      <p class=''text-sm text-slate-600 dark:text-slate-300''>Start with a prompt and get a section, article draft, or product story that matches your tone.</p>
    </div>
    <div class=''rounded-2xl border border-slate-200 bg-white p-5 dark:border-white/10 dark:bg-slate-950/50''>
      <h3 class=''mt-0 text-xl text-slate-900 dark:text-white''>Cleaner revisions</h3>
      <p class=''text-sm text-slate-600 dark:text-slate-300''>Ask for shorter, clearer, or translated text without leaving your edit screen.</p>
    </div>
  </div>
</div>

<h2>Model Routing and Cost Control</h2>
<p>Cortex AI gives you full control over your models. You can pick fast models for quick drafts and stronger models for technical articles. You manage your API keys on the server, so your writers can focus on good content.</p>
<ul class=''list-disc pl-6 space-y-2 text-sm''>
  <li>Use quick models for rewrites, titles, and summaries.</li>
  <li>Use top models for long guides and difficult translations.</li>
  <li>Keep provider keys safe in your private server settings.</li>
  <li>Control costs without changing how pages display to visitors.</li>
</ul>

<h2>Block-Aware Generation</h2>
<p>Cortex AI does more than write plain text. It creates structured content that maps directly to NextBlock components. You get ready-to-use section copy, headings, buttons, and translated blocks. You spend less time fixing messy copy from external tools.</p>
<p>Because the generated content respects your block rules, everything looks consistent and runs fast on the web.</p>

<h2>Safer Team Workflows</h2>
<p>AI works best when humans stay in control. With Cortex AI, editors review every draft before publishing. Developers manage the model keys, and the CMS keeps all versions in your normal history log.</p>

<h2>A Practical Launch Flow</h2>
<ol class=''list-decimal pl-6 space-y-2 text-sm''>
  <li>Draft an article, landing section, or product story from a clear prompt.</li>
  <li>Refine the text to match your audience and brand tone.</li>
  <li>Create a translated version or shorter summary for social cards and search tags.</li>
  <li>Review the content in the editor, hit publish, and track your revisions over time.</li>
</ol>

<p>Cortex AI turns your CMS into a faster creative workshop. It does not replace human taste, but it helps you turn great ideas into finished pages in record time.</p>
'::text)),
         updated_at = now()
   WHERE post_id = 7
     AND content->>'html_content' LIKE '%NextBlock Cortex AI is the AI layer built%';

  -----------------------------------------------------------------------------
  -- 4. Page Block Content Optimizations (Content-Guarded)
  -----------------------------------------------------------------------------

  -- Page 1 Block Updates
  UPDATE public.blocks
     SET content = replace(content::text, 'Edge-rendered marketing sites, launches, and docs with uncompromising performance.', 'Fast edge-rendered sites, launches, and docs. Built for top speed and clean code.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'Edge-rendered marketing sites, launches,' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'NextBlock™ is the open-source, developer-first Next.js CMS that merges 100% Lighthouse scores with a powerful visual block editor.', 'NextBlock™ is the open-source Next.js CMS that pairs 100% Lighthouse scores with a visual block editor.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'NextBlock™ is the open-source, developer' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'NextBlock™ is a holistic platform that unites performance, editorial experience, and developer control so every stakeholder delivers their best work.', 'NextBlock™ brings speed, clear editing, and developer control together so your team can build better web pages.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'NextBlock™ is a holistic platform that u' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Built for 100% Lighthouse scores with global delivery and near-instant FCP.', 'Built for top Lighthouse scores, quick page loads, and fast global delivery.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'Built for 100% Lighthouse scores with gl' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'A low-code, Notion-style block editor empowers teams to ship pages without engineering help.', 'A clean block editor gives your team the power to create pages without writing code.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'A low-code, Notion-style block editor em' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Open-source control with a clean Nx monorepo and a typed SDK for limitless customization.', 'Full open-source control with a clean monorepo and typed tools to build custom blocks with ease.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'Open-source control with a clean Nx mono' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Every layer of NextBlock™ leans on proven developer-first technology so the platform feels familiar, performant, and trustworthy from day one.', 'NextBlock™ uses tools you already know and trust, so your site stays fast, safe, and easy to run.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'Every layer of NextBlock™ leans on prove' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'For Content Creators', 'For Writers and Editors')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'For Content Creators' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Drag-and-drop layouts with a Notion-like interface.', 'Drag and drop blocks in a clean, simple layout.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'Drag-and-drop layouts with a Notion-like' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Pre-built hero, feature, testimonial, and callout components.', 'Add heroes, galleries, and quotes with one click.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'Pre-built hero, feature, testimonial, an' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Drag-and-drop assets with folders, search, and alt text.', 'Keep your images organized with folders and tags.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'Drag-and-drop assets with folders, searc' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Audit trail with one-click restore for every change.', 'Restore any saved version with a single click.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'Audit trail with one-click restore for e' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Server Components, ISR, and Edge Functions ready out of the box.', 'Built with Server Components and fast edge caching.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'Server Components, ISR, and Edge Functio' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Postgres, Auth, Storage, and Row-Level Security fully wired.', 'Postgres database, user auth, and file storage ready to use.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'Postgres, Auth, Storage, and Row-Level S' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Nx-powered monorepo engineered for scale and clean separation.', 'An Nx workspace made for scale and clean code.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'Nx-powered monorepo engineered for scale' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'TypeScript SDK with Zod validation for building custom blocks.', 'Build and type new blocks in minutes.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'TypeScript SDK with Zod validation for b' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'NextBlock™ Commerce transforms your content platform into a complete e-commerce engine. Products, checkout, multi-currency, taxes, shipping, invoices — all natively integrated into the block editor you already know.', 'NextBlock™ Commerce turns your content site into a full online store. Sell products, take payments, handle taxes, and ship orders — all from the block editor you already use.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'NextBlock™ Commerce transforms your cont' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'NextBlock™ Commerce transforms your content platform into a complete e-commerce engine. Products, checkout, multi-currency, taxes, shipping, invoices — all natively integrated into the block editor you already know.', 'NextBlock™ Commerce turns your content site into a full online store. Sell products, take payments, handle taxes, and ship orders — all from the block editor you already use.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'NextBlock™ Commerce transforms your cont' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'NextBlock™ Commerce ships a complete e-commerce toolkit so you can go from catalog to checkout without third-party plugins.', 'NextBlock™ Commerce ships a complete online store toolkit so you can go from catalog to checkout with ease.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'NextBlock™ Commerce ships a complete e-c' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Live FX rates, rounding rules, and auto-sync across all currencies.', 'Live exchange rates, round prices, and auto-sync across all currencies.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'Live FX rates, rounding rules, and auto-' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Define custom rates or let Stripe Tax handle calculations automatically.', 'Set custom tax rates or let Stripe Tax calculate totals automatically.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'Define custom rates or let Stripe Tax ha' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Country and state-level zones with free shipping thresholds.', 'Set shipping rates by country and state, with free shipping rules.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'Country and state-level zones with free ' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Stripe for physical goods and Freemius for software licenses with seamless checkout.', 'Use Stripe for physical goods and Freemius for software licenses with simple checkout.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'Stripe for physical goods and Freemius f' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Automatic stock decrement on payment with variant-level tracking.', 'Update stock counts when an order is paid, with variant tracking.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'Automatic stock decrement on payment wit' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Order management, printable invoices, and customer receipts out of the box.', 'Manage orders, print invoices, and view customer reports with ease.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'Order management, printable invoices, an' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'NextBlock™ Cortex AI brings native block-level intelligence directly to your editor. Generate copy, refactor structures, and automate translations in one click, built directly on our high-performance architecture.', 'NextBlock™ Cortex AI helps you write, edit, and translate content right inside the block editor. Draft text, refine layouts, and switch languages with ease.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'NextBlock™ Cortex AI brings native block' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'NextBlock™ is building a sustainable open-core roadmap so the platform grows with your business.', 'NextBlock™ is built to grow with your business and help your team succeed.')::jsonb,
         updated_at = now()
   WHERE page_id = 1
     AND content::text LIKE '%' || 'NextBlock™ is building a sustainable ope' || '%';


  -- Page 2 Block Updates
  UPDATE public.blocks
     SET content = replace(content::text, 'NextBlock™ est le CMS Next.js open-source alliant scores Lighthouse parfaits et éditeur visuel puissant.', 'NextBlock™ est le CMS Next.js open-source alliant scores parfaits et éditeur de blocs visuel.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'NextBlock™ est le CMS Next.js open-sourc' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Sites marketing et docs rendus à l''edge avec des performances irréprochables.', 'Sites marketing et docs rendus à l''edge. Conçus pour la vitesse et un code propre.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Sites marketing et docs rendus à l''edge ' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'NextBlock™ unifie performances, expérience éditoriale et contrôle développeur pour que chaque équipe livre son meilleur travail.', 'NextBlock™ réunit la vitesse, la clarté d''édition et le contrôle développeur. Votre équipe peut ainsi créer de meilleures pages web.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'NextBlock™ unifie performances, expérien' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Pensé pour des scores Lighthouse parfaits avec une diffusion mondiale.', 'Conçu pour des scores élevés et une diffusion rapide.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Pensé pour des scores Lighthouse parfait' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Un éditeur façon Notion pour publier sans dépendre des développeurs.', 'Un éditeur simple pour publier sans coder.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Un éditeur façon Notion pour publier san' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Un socle Next.js + Supabase modulaire, extensible et auto-hébergeable.', 'Un socle moderne, souple et très simple à faire grandir.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Un socle Next.js + Supabase modulaire, e' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Chaque couche de NextBlock™ repose sur des technologies éprouvées pour une expérience familière et performante.', 'NextBlock™ s''appuie sur des outils fiables et éprouvés. Votre site reste rapide, robuste et facile à maintenir au quotidien.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Chaque couche de NextBlock™ repose sur d' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Glisser-déposer façon Notion.', 'Glissez et déposez vos blocs dans une mise en page claire.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Glisser-déposer façon Notion.' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Héros, galeries, témoignages.', 'Insérez des héros, des galeries et des avis clients en un clic.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Héros, galeries, témoignages.' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Dossiers, tags et actions groupées.', 'Rangez vos photos et médias avec des dossiers et des tags.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Dossiers, tags et actions groupées.' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Historique et restauration instantanée.', 'Retrouvez et restaurez vos versions précédentes sans stress.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Historique et restauration instantanée.' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Server Components, ISR et Edge prêts à l''emploi.', 'Conçu avec Server Components et un cache edge très rapide.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Server Components, ISR et Edge prêts à l' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Postgres, auth, stockage, temps réel.', 'Base Postgres, profils, auth et stockage de fichiers prêts à l''emploi.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Postgres, auth, stockage, temps réel.' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Dépendances lisibles et centrales.', 'Une structure claire et bien rangée faite pour grandir sereinement.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Dépendances lisibles et centrales.' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Widgets typés et extensibles.', 'Créez et typez vos nouveaux composants en un instant.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Widgets typés et extensibles.' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'NextBlock™ Commerce transforme votre plateforme de contenu en moteur e-commerce complet. Produits, checkout, multi-devises, taxes, expédition, factures — le tout intégré nativement dans l''éditeur de blocs que vous connaissez déjà.', 'NextBlock™ Commerce transforme votre site de contenu en vraie boutique en ligne. Vendez des articles et recevez des paiements en ligne. Gérez vos taxes et vos envois dans l''éditeur que vous connaissez déjà.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'NextBlock™ Commerce transforme votre pla' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'NextBlock™ Commerce livre une boîte à outils e-commerce complète pour aller du catalogue au paiement sans plugins tiers.', 'NextBlock™ Commerce propose une boîte à outils complète. Allez du catalogue au paiement sans aucun plugin externe.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'NextBlock™ Commerce livre une boîte à ou' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Taux de change en temps réel, modes d''arrondi, prix charme et synchronisation automatique sur toutes les devises.', 'Taux de change en direct, prix ronds et mise à jour automatique sur toutes les devises.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Taux de change en temps réel, modes d''ar' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Taux manuels empilés (TPS + TVQ) ou calcul automatique via Stripe Tax — à vous de choisir.', 'Définissez vos taxes ou laissez Stripe Tax calculer les montants finaux.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Taux manuels empilés (TPS + TVQ) ou calc' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Résolution par pays et état, tarification par devise et seuils de livraison gratuite.', 'Ajustez les frais de port par pays et état avec des règles d''envoi gratuit.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Résolution par pays et état, tarificatio' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Stripe pour les produits physiques, Freemius pour les licences numériques — checkout intelligent avec validation d''inventaire.', 'Paiement Stripe pour les biens et Freemius pour les licences logicielles.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Stripe pour les produits physiques, Free' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Déduction automatique des quantités au paiement avec gestion des stocks par variante.', 'Mettez à jour les stocks dès qu''un achat est validé, avec suivi des variantes.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Déduction automatique des quantités au p' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Gestion du cycle de vie des commandes, numérotation stable des factures et rapports de commandes exportables.', 'Suivez chaque commande, imprimez des factures et téléchargez vos bilans en toute simplicité.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Gestion du cycle de vie des commandes, n' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'NextBlock™ Cortex AI apporte une intelligence native au niveau des blocs directement dans votre éditeur. Générez du texte, restructurez vos contenus et automatisez les traductions en un clic, le tout propulsé par notre architecture haute performance.', 'NextBlock™ Cortex AI vous aide à rédiger, corriger et traduire vos textes au cœur de l''éditeur de blocs. Créez des ébauches, améliorez vos titres et passez d''une langue à l''autre en un clin d''œil.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'NextBlock™ Cortex AI apporte une intelli' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'NextBlock™ construit une feuille de route open-core durable qui évolue avec votre activité.', 'NextBlock™ est pensé pour accompagner la croissance de votre entreprise. Nous voulons faire réussir vos projets web.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'NextBlock™ construit une feuille de rout' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Le commerce arrive en premier, puis l''ecosysteme s''etend avec des plugins, des blocs et des modules construits par les partenaires.', 'Le commerce ouvre la voie. Notre écosystème grandit avec de nouveaux plugins, des blocs utiles et des modules partenaires.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Le commerce arrive en premier, puis l''ec' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Transformez votre site en vitrine composable avec produits, checkout, tarification multi-devise, taxes automatiques et blocs commerce relies a votre contenu editorial.', 'Ajoutez une boutique complète à côté de vos articles. Profitez de produits, du paiement en ligne, de devises et de taxes sans effort.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Transformez votre site en vitrine compos' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Une marketplace communautaire ouvrira la voie a la publication, la vente et la distribution de blocs, themes, integrations et modules partenaires.', 'Un espace partagé permet aux développeurs de publier et vendre des blocs sur mesure, des thèmes et des outils connectés.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'Une marketplace communautaire ouvrira la' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'NextBlock™ se construit en public. Ajoutez une étoile, partagez vos retours et façonnez l''avenir du CMS orienté performance.', 'NextBlock™ avance en public. Mettez une étoile sur le dépôt, partagez vos avis et façonnez la suite avec nous.')::jsonb,
         updated_at = now()
   WHERE page_id = 2
     AND content::text LIKE '%' || 'NextBlock™ se construit en public. Ajout' || '%';


  -- Page 3 Block Updates
  UPDATE public.blocks
     SET content = replace(content::text, '<h2 class=''text-4xl md:text-5xl font-bold text-white text-center md:text-left mb-6''>Deep dives into performance, DX, and visual editing.</h2>', '<h1 class=''text-4xl md:text-5xl font-bold text-white text-center md:text-left mb-6''>The NextBlock Journal: Performance, DX, and Visual Editing</h1>')::jsonb,
         updated_at = now()
   WHERE page_id = 3
     AND content::text LIKE '%' || '<h2 class=''text-4xl md:text-5xl font-bol' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<p class=''text-slate-300 text-lg max-w-xl mx-auto md:mx-0 text-center md:text-left leading-relaxed''>Explore architectural walkthroughs, Supabase recipes, and block editor experiments written by the Nextblock core team.</p>', '<p class=''text-slate-300 text-lg max-w-xl mx-auto md:mx-0 text-center md:text-left leading-relaxed''>Explore practical guides, architecture deep dives, and editor workflows written by the NextBlock team and community.</p> <div class=''mt-8 text-slate-300 space-y-4 max-w-3xl''> <p>Welcome to the NextBlock Journal. This is your home for in-depth technical guides, release notes, and real-world web architecture patterns. Whether you are launching your first Next.js site or scaling an online store, our articles give you clear, tested steps to help you build faster.</p> <p>We believe modern web projects need developer freedom and a simple editing experience. Our engineering posts show how to pair Next.js 16 with Supabase Postgres, edge caching, and server actions without complex glue code. You will learn how to keep your Lighthouse score at 100% while giving teams a rich, block-based writing experience.</p> <p>Here are the key topics we cover across our editorial library:</p> <ul class=''space-y-2 list-disc pl-5''> <li><strong>Getting Started Guides:</strong> Simple setup walkthroughs for one-click Vercel deploys, local Docker environments, and custom cloud stacks.</li> <li><strong>Architecture & Performance:</strong> Deep dives into fast page rendering, clean CSS delivery, image optimization, and safe database migrations.</li> <li><strong>E-Commerce Workflows:</strong> Practical patterns for multi-currency pricing, automated tax sync, stock tracking, and provider checkout flows.</li> <li><strong>AI Content Tools:</strong> How to use Cortex AI to generate structured blocks, manage provider keys, and speed up routine translation work.</li> </ul> <p>Our team updates this collection regularly as we release new core features and modules. We test our code on live sites before publishing. Each post includes full technical explanations and architecture diagrams so you can apply the solutions to your own web stack.</p> <p>Have a topic you want us to cover or want to share your own case study? Join our community on GitHub or reach out to our team anytime. We welcome questions, ideas, and pull requests from all builders. You can subscribe to updates or start reading our latest published articles below.</p> </div>')::jsonb,
         updated_at = now()
   WHERE page_id = 3
     AND content::text LIKE '%' || '<p class=''text-slate-300 text-lg max-w-x' || '%';


  -- Page 4 Block Updates
  UPDATE public.blocks
     SET content = replace(content::text, '<h2 class=''text-4xl md:text-5xl font-bold text-white text-center md:text-left mb-6''>Plongées dans la performance, l''expérience dev et l''édition visuelle.</h2>', '<h1 class=''text-4xl md:text-5xl font-bold text-white text-center md:text-left mb-6''>Le Journal NextBlock : Performance, Expérience Dev et Édition</h1>')::jsonb,
         updated_at = now()
   WHERE page_id = 4
     AND content::text LIKE '%' || '<h2 class=''text-4xl md:text-5xl font-bol' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<p class=''text-lg max-w-xl mx-auto md:mx-0 text-center md:text-left text-slate-300 leading-relaxed''>Walkthroughs d''architecture, recettes Supabase et expérimentations éditeur écrits par l''équipe Nextblock.</p>', '<p class=''text-lg max-w-xl mx-auto md:mx-0 text-center md:text-left text-slate-300 leading-relaxed''>Retrouvez des guides pratiques, des études d''architecture et des conseils pour éditer vos contenus avec NextBlock.</p> <div class=''mt-8 text-slate-300 space-y-4 max-w-3xl''> <p>Bienvenue sur le Journal NextBlock. Cet espace rassemble nos guides techniques détaillés. Vous y trouverez les nouveautés de chaque version et les meilleures pratiques du web moderne. Vous lancez votre premier site Next.js ? Vous faites grandir une boutique en ligne ? Nos articles vous donnent des étapes simples et vérifiées pour construire plus vite.</p> <p>Nous pensons qu''un bon site web doit offrir toute la liberté aux développeurs. Il doit aussi apporter une vraie simplicité aux équipes éditoriales. Nos articles techniques expliquent comment marier Next.js 16 avec Supabase Postgres, le cache edge et les Server Actions. Tout cela se fait sans code superflu. Vous découvrirez comment maintenir un score Lighthouse parfait. En même temps, votre équipe profite d''un éditeur de blocs visuel et très agréable.</p> <p>Voici les principaux sujets abordés dans notre bibliothèque éditoriale :</p> <ul class=''space-y-2 list-disc pl-5''> <li><strong>Guides de démarrage :</strong> Des tutoriels pas à pas pour déployer sur Vercel en un clic, lancer une pile Docker locale ou installer votre propre cloud.</li> <li><strong>Architecture et performance :</strong> Des explications claires sur le rendu rapide des pages, les styles en ligne, l''optimisation des images et les migrations sûres.</li> <li><strong>Commerce en ligne :</strong> Des conseils concrets pour gérer plusieurs devises, synchroniser les taxes, suivre les stocks et réussir vos paiements.</li> <li><strong>Outils IA pour le contenu :</strong> Comment utiliser Cortex AI pour créer des blocs bien typés, garder le contrôle de vos clés et traduire vos pages en un instant.</li> </ul> <p>Notre équipe enrichit cette collection au fil des mises à jour du projet. Nous testons chaque exemple de code sur des sites réels avant publication. Chaque tutoriel propose des explications complètes pour adapter facilement ces solutions à votre propre projet.</p> <p>Vous avez une idée de sujet ou un retour d''expérience à partager ? Rejoignez notre communauté sur GitHub ou contactez notre équipe. Nous accueillons avec grand plaisir vos questions, vos idées et vos contributions. Parcourez dès maintenant nos derniers articles ci-dessous.</p> </div>')::jsonb,
         updated_at = now()
   WHERE page_id = 4
     AND content::text LIKE '%' || '<p class=''text-lg max-w-xl mx-auto md:mx' || '%';


  -- Page 5 Block Updates
  UPDATE public.blocks
     SET content = replace(content::text, '<div class=''max-w-2xl mx-auto text-center''><h2 class=''text-2xl font-bold mb-4''>Open Source & Community Driven</h2><p class=''text-slate-600 dark:text-slate-400 mb-6''>NextBlock™ is built in the open. We rely on developers and editors like you to help us define the roadmap. Whether it''s a bug report, a feature request, or just a shoutout, every message helps us move faster.</p></div>', '<div class=''mt-10 text-slate-300 space-y-4 max-w-3xl mx-auto''> <h2 class=''text-2xl font-bold text-white mb-4 text-center''>Open Source & Community Driven</h2> <p>NextBlock™ is built entirely in the open. We work closely with developers, editors, and teams who use the platform every day. Whether you found a bug, want to request a new feature, or need advice on your project setup, our team is here to help you move forward.</p> <p>We read every message sent through this form. Here is what you can expect when reaching out to our team:</p> <ul class=''space-y-2 list-disc pl-5''> <li><strong>Fast Response Times:</strong> Our core maintainers typically review and reply to inquiries within one to two business days.</li> <li><strong>Technical Support:</strong> For public bugs or community questions, our GitHub Discussions and Issues boards offer fast answers from the entire community.</li> <li><strong>Partnership and Modules:</strong> If your team wants to sponsor a roadmap module or build a custom integration, we can schedule a direct call.</li> <li><strong>Security Disclosures:</strong> For responsible disclosure of potential security vulnerabilities, please flag your message as urgent so we can triage it immediately.</li> </ul> <p>Before submitting, please make sure your email address is typed correctly so our team can get back to you. If your question is about a specific code error, including your environment details and reproduction steps helps us find a solution much faster.</p> <p>You can also connect with us directly on GitHub, Discord, or X (formerly Twitter). We host regular community discussions and share sneak peeks of upcoming platform features. If you are building a custom client project with NextBlock, we would love to hear about your experience.</p> <p>We value your time and privacy. We never share your contact information or use your email for marketing without your consent. Send us a message using the form below and we will get back to you shortly.</p> </div>')::jsonb,
         updated_at = now()
   WHERE page_id = 5
     AND content::text LIKE '%' || '<div class=''max-w-2xl mx-auto text-cente' || '%';


  -- Page 6 Block Updates
  UPDATE public.blocks
     SET content = replace(content::text, '<div class=''max-w-2xl mx-auto text-center''><h2 class=''text-2xl font-bold mb-4''>Open Source & Communautaire</h2><p class=''text-slate-600 dark:text-slate-400 mb-6''>NextBlock™ est construit en public. Nous comptons sur les développeurs et éditeurs comme vous pour définir notre roadmap. Qu''il s''agisse d''un bug, d''une suggestion ou d''un simple salut, chaque message compte.</p></div>', '<div class=''mt-10 text-slate-300 space-y-4 max-w-3xl mx-auto''> <h2 class=''text-2xl font-bold text-white mb-4 text-center''>Open Source & Communautaire</h2> <p>NextBlock™ est construit entièrement en public. Nous travaillons avec des développeurs et des équipes qui utilisent le CMS chaque jour. Vous avez trouvé un bug ? Vous souhaitez suggérer une fonction ? Vous avez besoin d''aide pour votre installation ? Notre équipe est là pour vous guider.</p> <p>Nous lisons attentivement chaque message reçu via ce formulaire. Voici nos engagements pour vous répondre au mieux :</p> <ul class=''space-y-2 list-disc pl-5''> <li><strong>Délais de réponse rapides :</strong> Nos mainteneurs étudient et répondent aux demandes en un ou deux jours ouvrés.</li> <li><strong>Support technique :</strong> Pour toute question publique, nos forums GitHub Discussions et Issues offrent une aide rapide de la communauté.</li> <li><strong>Partenariats et modules :</strong> Votre équipe veut sponsoriser un module ou concevoir une intégration sur mesure ? Nous pouvons planifier un échange direct.</li> <li><strong>Signalements de sécurité :</strong> Pour toute alerte de sécurité, signalez votre message comme prioritaire pour un traitement immédiat.</li> </ul> <p>Avant d''envoyer votre message, vérifiez bien votre adresse email. Notre équipe pourra ainsi vous répondre rapidement. Si votre demande concerne une erreur technique, mentionnez votre environnement et les étapes pour la reproduire. Cela nous aide à trouver une solution efficace.</p> <p>Vous pouvez aussi échanger avec nous sur GitHub, Discord ou X. Nous y partageons des nouvelles et les coulisses des prochaines versions. Vous développez un projet client avec NextBlock ? Racontez-nous votre aventure. Notre équipe aime voir ce que vous créez au quotidien. Chaque projet est unique. Prenez le temps de nous dire ce qui vous plaît et ce qui vous manque. Vos retours nous aident à faire un meilleur outil pour tout le monde.</p> <p>Nous respectons votre vie privée. Vos coordonnées ne sont jamais cédées ni réutilisées sans votre accord. Écrivez-nous ci-dessous et nous vous répondrons très vite.</p> </div>')::jsonb,
         updated_at = now()
   WHERE page_id = 6
     AND content::text LIKE '%' || '<div class=''max-w-2xl mx-auto text-cente' || '%';


  -- Page 7 Block Updates
  UPDATE public.blocks
     SET content = replace(content::text, '<p style="text-align: center; color: var(--background); opacity: 0.9">Discover our premium selection of developer tools and digital commerce solutions.</p>', '<p style="text-align: center; color: var(--background); opacity: 0.9">Discover our selection of official commercial add-ons and developer tools for NextBlock CMS.</p> <div class=''mt-8 text-slate-300 space-y-4 max-w-3xl mx-auto text-left''> <h2 class=''text-2xl font-bold text-white mb-4''>Power Up Your Web Projects</h2> <p>Welcome to the official NextBlock™ digital store. Here you can purchase licenses for our premium packages, including NextBlock™ Commerce and NextBlock™ Cortex AI. Every commercial license helps fund full-time open-source development on our core CMS while giving your team advanced tools to launch high-performance websites faster.</p> <p>Our premium modules are designed to feel native from day one. You get clean code that fits right into your existing NextBlock project without third-party plugins or complex configuration. When you purchase a license from our store, you receive instant access to everything you need:</p> <ul class=''space-y-2 list-disc pl-5''> <li><strong>Full Source Code:</strong> Inspect, customize, and adapt the modules to your exact requirements.</li> <li><strong>Perpetual Use:</strong> Use the software for your project with full peace of mind.</li> <li><strong>Automated Updates:</strong> Enjoy smooth updates that match each new release of NextBlock and Next.js.</li> <li><strong>Secure Checkout:</strong> Payments are processed safely with Stripe and Freemius with instant receipt generation.</li> </ul> <p>Whether you need multi-currency store features, automated sales tax calculations, or AI block generation in your editor, our modules deliver tested solutions that keep your Lighthouse scores at 100%.</p> <p>All purchases include dedicated onboarding resources, detailed developer docs, and friendly technical support. If you ever run into an issue or need help wiring up a provider webhook, our core engineers are ready to assist you. We also offer a thirty-day refund policy so you can try our tools risk-free.</p> <p>Have questions about license tiers, volume pricing, team seats, or custom agency usage? Contact our support team anytime. Our team is here to answer your questions and help your developers succeed. We are happy to help you pick the best plan for your company. Browse our featured products below to get started today.</p> </div>')::jsonb,
         updated_at = now()
   WHERE page_id = 7
     AND content::text LIKE '%' || '<p style="text-align: center; color: var' || '%';


  -- Page 8 Block Updates
  UPDATE public.blocks
     SET content = replace(content::text, '<p style="text-align: center; color: var(--background); opacity: 0.9">Decouvrez notre selection premium d outils de developpement.</p>', '<p style="text-align: center; color: var(--background); opacity: 0.9">Découvrez nos extensions officielles et nos outils pour développeurs conçus pour le CMS NextBlock.</p> <div class=''mt-8 text-slate-300 space-y-4 max-w-3xl mx-auto text-left''> <h2 class=''text-2xl font-bold text-white mb-4''>Accélérez vos projets web</h2> <p>Bienvenue sur la boutique officielle de NextBlock™. Vous pouvez acheter ici des licences pour nos modules professionnels, comme NextBlock™ Commerce et NextBlock™ Cortex AI. Chaque achat aide à financer le travail open-source sur le cœur du CMS. Il donne aussi à votre équipe des outils de pointe pour créer des sites rapides et fiables.</p> <p>Nos modules premium s''intègrent sans effort à votre projet existant. Vous profitez d''un code propre et bien testé, sans plugin externe lourd ni réglage complexe. En choisissant nos outils, vous profitez immédiatement de nombreux avantages :</p> <ul class=''space-y-2 list-disc pl-5''> <li><strong>Code source complet :</strong> Lisez, adaptez et faites évoluer chaque bloc selon vos besoins métier.</li> <li><strong>Licence perpétuelle :</strong> Utilisez le code sur votre projet en toute sérénité.</li> <li><strong>Mises à jour suivies :</strong> Recevez les nouvelles versions au rythme de Next.js et de NextBlock.</li> <li><strong>Paiement sécurisé :</strong> Les achats passent par Stripe et Freemius avec facture instantanée.</li> </ul> <p>Vous voulez vendre dans plusieurs devises ? Vous avez besoin du calcul automatique des taxes ? Vous voulez générer des blocs avec l''IA ? Nos modules offrent des solutions prêtes à l''emploi qui préservent vos scores Lighthouse à 100%.</p> <p>Chaque commande donne accès à une documentation claire et à notre support technique. Si vous avez besoin d''aide pour brancher un webhook ou un mode de paiement, nos développeurs vous répondent rapidement. Notre équipe est à vos côtés pour vous faire gagner du temps. Nous proposons aussi une garantie satisfait ou remboursé de trente jours.</p> <p>Vous avez des questions sur nos tarifs, les licences agence ou les remises en volume ? Écrivez à notre équipe à tout moment. Nous vous guiderons avec grand plaisir vers l''offre idéale pour votre entreprise. Découvrez dès aujourd''hui l''ensemble de nos produits ci-dessous pour bien démarrer votre projet.</p> </div>')::jsonb,
         updated_at = now()
   WHERE page_id = 8
     AND content::text LIKE '%' || '<p style="text-align: center; color: var' || '%';


  -- Page 9 Block Updates
  UPDATE public.blocks
     SET content = replace(content::text, 'NextBlock™ CMS ("we", "us", or "our") respects your privacy and is committed to protecting your personal information in accordance with Quebec''s <em>Act respecting the protection of personal information in the private sector</em> (Law 25), the federal <em>Personal Information Protection and Electronic Documents Act</em> (PIPEDA), and Canada''s Anti-Spam Legislation (CASL).', 'NextBlock™ CMS ("we", "us", or "our") respects your privacy. We protect your personal information under Quebec''s Law 25, the federal PIPEDA act, and Canada''s Anti-Spam Legislation (CASL).')::jsonb,
         updated_at = now()
   WHERE page_id = 9
     AND content::text LIKE '%' || 'NextBlock™ CMS ("we", "us", or "our") re' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Our Privacy Officer is responsible for our compliance with applicable privacy laws. You may reach them at', 'Our Privacy Officer oversees our compliance with privacy laws. You can reach them at')::jsonb,
         updated_at = now()
   WHERE page_id = 9
     AND content::text LIKE '%' || 'Our Privacy Officer is responsible for o' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<li><strong>Account information</strong> &mdash; name, email address, and credentials when you register.</li>', '<li><strong>Account information:</strong> Your name, email address, and login details when you register.</li>')::jsonb,
         updated_at = now()
   WHERE page_id = 9
     AND content::text LIKE '%' || '<li><strong>Account information</strong>' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<li><strong>Usage and device data</strong> &mdash; collected only with your consent through analytics technologies.</li>', '<li><strong>Usage and device data:</strong> Collected only with your consent through analytics tools.</li>')::jsonb,
         updated_at = now()
   WHERE page_id = 9
     AND content::text LIKE '%' || '<li><strong>Usage and device data</stron' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<li><strong>Communications</strong> &mdash; messages you send us and your marketing preferences.</li>', '<li><strong>Communications:</strong> Messages you send us and your newsletter choices.</li>')::jsonb,
         updated_at = now()
   WHERE page_id = 9
     AND content::text LIKE '%' || '<li><strong>Communications</strong> &mda' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<h2>3. Why we collect it and your consent</h2>
<p>We collect personal information for clearly identified purposes: to provide and secure our services, to communicate with you, and &mdash; only with your express, opt-in consent &mdash; for analytics and marketing. Consistent with Law 25, non-essential cookies and trackers remain disabled until you actively accept them, and you may withdraw your consent at any time.</p>', '<h2>3. Why we collect data and your consent</h2> <p>We collect personal information for clear reasons: to provide our services, keep accounts secure, and reply to your messages. We use analytics and marketing tools only with your direct, opt-in consent. Under Law 25, optional cookies stay off until you choose to accept them. You can withdraw your consent at any time.</p>')::jsonb,
         updated_at = now()
   WHERE page_id = 9
     AND content::text LIKE '%' || '<h2>3. Why we collect it and your consen' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Strictly necessary cookies keep the site working and require no consent. Analytics and marketing technologies are loaded <strong>only after</strong> you opt in through our consent banner. Your choice is recorded so we can honour it and demonstrate accountability.', 'Essential cookies keep the site running and require no consent. Analytics and marketing cookies load only after you opt in via our cookie banner. We record your choice to honor it and follow privacy rules.')::jsonb,
         updated_at = now()
   WHERE page_id = 9
     AND content::text LIKE '%' || 'Strictly necessary cookies keep the site' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'We do not sell your personal information. We share it only with service providers who help us operate the platform under contractual confidentiality obligations, or where required by law.', 'We do not sell your personal data. We share it only with trusted service providers who help us run the platform under strict confidentiality agreements, or when required by law.')::jsonb,
         updated_at = now()
   WHERE page_id = 9
     AND content::text LIKE '%' || 'We do not sell your personal information' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<h2>6. Retention</h2>
<p>We keep personal information only for as long as necessary to fulfil the purposes described above or as required by law, after which it is securely destroyed or anonymized.</p>', '<h2>6. Data retention</h2> <p>We keep personal information only as long as needed for the purposes described above or as required by law. After that, we securely delete or anonymize your data.</p>')::jsonb,
         updated_at = now()
   WHERE page_id = 9
     AND content::text LIKE '%' || '<h2>6. Retention</h2>
<p>We keep person' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Subject to applicable law, you have the right to access, rectify, and delete your personal information, to withdraw consent, to data portability, and to be informed about automated processing. To exercise these rights, contact our Privacy Officer at', 'Under privacy laws, you have the right to view, correct, and delete your personal information. You can also withdraw consent or ask for a portable copy of your data. To use these rights, write to our Privacy Officer at')::jsonb,
         updated_at = now()
   WHERE page_id = 9
     AND content::text LIKE '%' || 'Subject to applicable law, you have the ' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<h2>8. Commercial electronic messages (CASL)</h2>
<p>We send commercial electronic messages only with your consent. Every message identifies us and includes a working unsubscribe mechanism that we honour promptly.</p>', '<h2>8. Commercial electronic messages</h2> <p>We send commercial emails only with your permission. Every email clearly identifies us and includes an easy unsubscribe link that takes effect right away.</p>')::jsonb,
         updated_at = now()
   WHERE page_id = 9
     AND content::text LIKE '%' || '<h2>8. Commercial electronic messages (C' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<h2>9. Safeguards</h2>
<p>We use appropriate physical, organizational, and technological measures &mdash; including encryption in transit and access controls &mdash; to protect personal information against loss, theft, and unauthorized access.</p>', '<h2>9. Security safeguards</h2> <p>We use strong technical and physical protections to keep your data safe. These include encrypted connections and strict access controls to prevent loss, theft, and unauthorized access.</p>')::jsonb,
         updated_at = now()
   WHERE page_id = 9
     AND content::text LIKE '%' || '<h2>9. Safeguards</h2>
<p>We use approp' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'NextBlock™ CMS is free, open-source software distributed under the GNU Affero General Public License v3. When you self-host NextBlock, you are the operator responsible for the personal information processed by your own deployment, and this policy serves as a starting point you may adapt to your organization.', 'NextBlock™ CMS is free open-source software under the AGPLv3 license. When you self-host NextBlock, you control your own server. You are responsible for the personal data on your deployment, and this policy is a helpful model you can adapt.')::jsonb,
         updated_at = now()
   WHERE page_id = 9
     AND content::text LIKE '%' || 'NextBlock™ CMS is free, open-source soft' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<h2>11. Changes to this policy</h2>
<p>We may update this policy from time to time. Material changes will be communicated through the site, and the "last updated" date will be revised.</p>', '<h2>11. Policy changes</h2> <p>We may update this policy over time. We announce important changes on our site and update the revision date at the top.</p>')::jsonb,
         updated_at = now()
   WHERE page_id = 9
     AND content::text LIKE '%' || '<h2>11. Changes to this policy</h2>
<p>' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Questions or complaints? Contact NextBlock™ CMS at <a href="mailto:{{privacy_email}}">{{privacy_email}}</a>. You may also contact the Commission d''accès à l''information du Québec or the Office of the Privacy Commissioner of Canada.', 'Have questions or complaints? Contact NextBlock™ at <a href="mailto:{{privacy_email}}">{{privacy_email}}</a>. You can also contact the Commission d''accès à l''information du Québec or the Office of the Privacy Commissioner of Canada.')::jsonb,
         updated_at = now()
   WHERE page_id = 9
     AND content::text LIKE '%' || 'Questions or complaints? Contact NextBlo' || '%';


  -- Page 10 Block Updates
  UPDATE public.blocks
     SET content = replace(content::text, 'NextBlock™ CMS (« nous ») respecte votre vie privée et s''engage à protéger vos renseignements personnels conformément à la <em>Loi sur la protection des renseignements personnels dans le secteur privé</em> du Québec (Loi 25), à la <em>Loi sur la protection des renseignements personnels et les documents électroniques</em> (LPRPDE) et à la Loi canadienne anti-pourriel (LCAP).', 'NextBlock™ CMS (« nous ») respecte votre vie privée. Nous protégeons vos renseignements personnels selon la Loi 25 du Québec, la loi fédérale LPRPDE et les règles canadiennes anti-pourriel (LCAP).')::jsonb,
         updated_at = now()
   WHERE page_id = 10
     AND content::text LIKE '%' || 'NextBlock™ CMS (« nous ») respecte votre' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Notre responsable de la protection des renseignements personnels veille au respect des lois applicables. Vous pouvez le joindre à', 'Notre responsable veille au respect des règles de confidentialité. Vous pouvez lui écrire à')::jsonb,
         updated_at = now()
   WHERE page_id = 10
     AND content::text LIKE '%' || 'Notre responsable de la protection des r' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<h2>2. Renseignements que nous recueillons</h2>
<ul>
  <li><strong>Renseignements de compte</strong> &mdash; nom, adresse courriel et identifiants lors de l''inscription.</li>
  <li><strong>Données d''utilisation et d''appareil</strong> &mdash; recueillies uniquement avec votre consentement au moyen de technologies d''analyse.</li>
  <li><strong>Communications</strong> &mdash; les messages que vous nous envoyez et vos préférences marketing.</li>
</ul>', '<h2>2. Renseignements recueillis</h2> <ul> <li><strong>Renseignements de compte :</strong> Votre nom, votre courriel et vos accès lors de l''inscription.</li> <li><strong>Données d''utilisation et d''appareil :</strong> Recueillies avec votre accord via nos outils de mesure.</li> <li><strong>Communications :</strong> Vos messages reçus et vos choix de suivi par courriel.</li> </ul>')::jsonb,
         updated_at = now()
   WHERE page_id = 10
     AND content::text LIKE '%' || '<h2>2. Renseignements que nous recueillo' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<p>Nous recueillons des renseignements personnels à des fins clairement déterminées : fournir et sécuriser nos services, communiquer avec vous et &mdash; uniquement avec votre consentement exprès &mdash; à des fins d''analyse et de marketing. Conformément à la Loi 25, les témoins et traceurs non essentiels demeurent désactivés tant que vous ne les avez pas acceptés, et vous pouvez retirer votre consentement en tout temps.</p>', '<p>Nous recueillons vos données pour des motifs clairs : faire fonctionner nos services, sécuriser les accès et vous répondre. Les outils d''analyse et de suivi ne s''activent qu''avec votre accord clair. Selon la Loi 25, les témoins optionnels restent coupés tant que vous ne les acceptez pas. Vous pouvez retirer votre accord en tout temps.</p>')::jsonb,
         updated_at = now()
   WHERE page_id = 10
     AND content::text LIKE '%' || '<p>Nous recueillons des renseignements p' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Les témoins strictement nécessaires assurent le fonctionnement du site et ne requièrent aucun consentement. Les technologies d''analyse et de marketing ne sont chargées qu''<strong>après</strong> votre consentement explicite. Votre choix est enregistré afin de le respecter.', 'Les témoins essentiels assurent le bon fonctionnement du site. Ils ne demandent aucun accord préalable. Les témoins d''analyse se chargent seulement après votre choix sur notre bandeau. Nous gardons votre choix en mémoire pour le respecter.')::jsonb,
         updated_at = now()
   WHERE page_id = 10
     AND content::text LIKE '%' || 'Les témoins strictement nécessaires assu' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<h2>5. Communication à des tiers</h2>
<p>Nous ne vendons pas vos renseignements personnels. Nous ne les communiquons qu''à des fournisseurs qui nous aident à exploiter la plateforme, sous obligation de confidentialité, ou lorsque la loi l''exige.</p>', '<h2>5. Partage et communication</h2> <p>Nous ne vendons jamais vos données personnelles. Nous les partageons uniquement avec des prestataires de confiance qui nous aident à faire tourner le site sous contrat de secret, ou si la loi l''impose.</p>')::jsonb,
         updated_at = now()
   WHERE page_id = 10
     AND content::text LIKE '%' || '<h2>5. Communication à des tiers</h2>
<' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<h2>6. Conservation</h2>
<p>Nous ne conservons les renseignements personnels que le temps nécessaire aux fins décrites ou exigé par la loi, après quoi ils sont détruits ou anonymisés de façon sécuritaire.</p>', '<h2>6. Durée de conservation</h2> <p>Nous gardons vos données seulement le temps utile pour les buts décrits ou selon la loi. Ensuite, nous les effaçons ou nous les rendons anonymes de façon sûre.</p>')::jsonb,
         updated_at = now()
   WHERE page_id = 10
     AND content::text LIKE '%' || '<h2>6. Conservation</h2>
<p>Nous ne con' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Sous réserve de la loi applicable, vous avez le droit d''accéder à vos renseignements, de les rectifier et de les supprimer, de retirer votre consentement, à la portabilité de vos données et d''être informé du traitement automatisé. Pour exercer ces droits, écrivez à', 'Vous avez le droit de lire, de corriger et de faire effacer vos données. Vous pouvez aussi retirer votre accord ou demander une copie de vos données. Pour exercer vos droits, écrivez à notre responsable à')::jsonb,
         updated_at = now()
   WHERE page_id = 10
     AND content::text LIKE '%' || 'Sous réserve de la loi applicable, vous ' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<h2>8. Messages électroniques commerciaux (LCAP)</h2>
<p>Nous n''envoyons des messages électroniques commerciaux qu''avec votre consentement. Chaque message nous identifie et comporte un mécanisme de désabonnement fonctionnel que nous respectons rapidement.</p>', '<h2>8. Messages électroniques</h2> <p>Nous envoyons des courriels informatifs seulement avec votre accord. Chaque courriel montre notre nom et propose un lien simple pour vous désabonner d''un clic.</p>')::jsonb,
         updated_at = now()
   WHERE page_id = 10
     AND content::text LIKE '%' || '<h2>8. Messages électroniques commerciau' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<h2>9. Mesures de sécurité</h2>
<p>Nous employons des mesures physiques, organisationnelles et technologiques appropriées &mdash; dont le chiffrement en transit et le contrôle des accès &mdash; pour protéger vos renseignements.</p>', '<h2>9. Mesures de sécurité</h2> <p>Nous utilisons des moyens techniques et physiques solides pour garder vos données en sûreté. Cela comprend des échanges chiffrés et un contrôle strict des accès contre toute fuite ou vol.</p>')::jsonb,
         updated_at = now()
   WHERE page_id = 10
     AND content::text LIKE '%' || '<h2>9. Mesures de sécurité</h2>
<p>Nous' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'NextBlock™ CMS est un logiciel libre et à code source ouvert distribué sous la licence publique générale GNU Affero v3. Lorsque vous hébergez NextBlock vous-même, vous êtes l''exploitant responsable des renseignements personnels traités par votre propre instance, et la présente politique vous sert de point de départ adaptable à votre organisation.', 'NextBlock™ CMS est un logiciel libre sous licence AGPLv3. Si vous hébergez NextBlock vous-même, vous gérez votre propre serveur. Vous êtes responsable des données sur votre instance, et ce texte est un modèle que vous pouvez adapter.')::jsonb,
         updated_at = now()
   WHERE page_id = 10
     AND content::text LIKE '%' || 'NextBlock™ CMS est un logiciel libre et ' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<h2>11. Modifications</h2>
<p>Nous pouvons mettre à jour cette politique. Les changements importants seront communiqués sur le site et la date de mise à jour sera révisée.</p>', '<h2>11. Mises à jour</h2> <p>Nous pouvons mettre à jour ce texte au fil du temps. Les changements notables seront affichés sur le site avec la nouvelle date en tête de page.</p>')::jsonb,
         updated_at = now()
   WHERE page_id = 10
     AND content::text LIKE '%' || '<h2>11. Modifications</h2>
<p>Nous pouv' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Des questions ou des plaintes ? Contactez NextBlock™ CMS à <a href="mailto:{{privacy_email}}">{{privacy_email}}</a>. Vous pouvez aussi vous adresser à la Commission d''accès à l''information du Québec.', 'Une question ou un avis ? Écrivez à NextBlock™ à <a href="mailto:{{privacy_email}}">{{privacy_email}}</a>. Vous pouvez aussi joindre la Commission d''accès à l''information du Québec.')::jsonb,
         updated_at = now()
   WHERE page_id = 10
     AND content::text LIKE '%' || 'Des questions ou des plaintes ? Contacte' || '%';


  -- Page 12 Block Updates
  UPDATE public.blocks
     SET content = replace(content::text, 'En accédant à NextBlock™ CMS et aux services que nous fournissons (les « Services ») ou en les utilisant, vous acceptez d''être lié par les présentes conditions d''utilisation. Si vous n''êtes pas d''accord, n''utilisez pas les Services.', 'En utilisant le CMS NextBlock™ et les services associés (les « Services »), vous acceptez ces conditions d''utilisation. Si vous refusez ces règles, veuillez ne pas utiliser les Services.')::jsonb,
         updated_at = now()
   WHERE page_id = 12
     AND content::text LIKE '%' || 'En accédant à NextBlock™ CMS et aux serv' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<h2>2. Logiciel libre et à code source ouvert</h2>
<p>NextBlock™ CMS est un logiciel libre et à code source ouvert distribué sous la <strong>licence publique générale GNU Affero, version 3 (AGPL-3.0)</strong> ou, à votre choix, toute version ultérieure. Vous êtes libre d''exécuter, d''étudier, de partager et de modifier le logiciel selon les termes de cette licence. Une copie de la licence est fournie avec le logiciel et est aussi disponible à <a href="https://www.gnu.org/licenses/agpl-3.0.html">gnu.org/licenses/agpl-3.0.html</a>.</p>', '<h2>2. Logiciel libre et code source ouvert</h2> <p>NextBlock™ CMS est un logiciel libre sous <strong>licence publique générale GNU Affero, version 3 (AGPL-3.0)</strong> ou toute version ultérieure. Vous pouvez lancer, étudier, copier et faire évoluer le code selon cette licence. Le texte complet se trouve avec le code et en ligne sur <a href="https://www.gnu.org/licenses/agpl-3.0.html">gnu.org/licenses/agpl-3.0.html</a>.</p>')::jsonb,
         updated_at = now()
   WHERE page_id = 12
     AND content::text LIKE '%' || '<h2>2. Logiciel libre et à code source o' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<h2>3. Disponibilité du code source</h2>
<p>Conformément à l''article 13 de l''AGPL-3.0, si vous exploitez une version modifiée de NextBlock™ CMS et la rendez accessible à des utilisateurs sur un réseau, vous devez offrir clairement à ces utilisateurs l''accès au code source correspondant de votre version modifiée, gratuitement, par un moyen usuel de copie de logiciels.</p>', '<h2>3. Partage du code source</h2> <p>Selon l''article 13 de la licence AGPL-3.0, si vous modifiez NextBlock™ CMS et le mettez en ligne pour des usagers sur un réseau, vous devez offrir l''accès libre et sans frais au code source de votre version modifiée.</p>')::jsonb,
         updated_at = now()
   WHERE page_id = 12
     AND content::text LIKE '%' || '<h2>3. Disponibilité du code source</h2>' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<h2>4. Marques de commerce</h2>
<p>L''AGPL-3.0 accorde de larges droits sur le code source du logiciel, mais <strong>n''accorde aucun droit</strong> sur nos noms commerciaux, marques de commerce ou marques de service. « NextBlock™ », le nom NextBlock™ CMS et les logos associés demeurent notre propriété et ne peuvent être utilisés d''une manière laissant entendre une approbation ou une affiliation sans notre autorisation écrite préalable.</p>', '<h2>4. Marques et logos</h2> <p>La licence AGPL-3.0 donne de larges droits sur le code. Mais <strong>elle ne donne aucun droit</strong> sur nos noms et marques. Les termes « NextBlock™ », NextBlock™ CMS et les logos restent notre bien exclusif. Ils ne peuvent être repris sans accord écrit préalable.</p>')::jsonb,
         updated_at = now()
   WHERE page_id = 12
     AND content::text LIKE '%' || '<h2>4. Marques de commerce</h2>
<p>L''AG' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<h2>5. Comptes et utilisation acceptable</h2>
<p>Si vous créez un compte, vous êtes responsable de la protection de vos identifiants et de toute activité effectuée à partir de votre compte, et vous vous engagez à nous aviser rapidement de toute utilisation non autorisée. Vous vous engagez à ne pas détourner les Services, notamment en tentant de les perturber, d''y accéder sans autorisation ou de les utiliser à des fins illégales.</p>', '<h2>5. Comptes et bon usage</h2> <p>Si vous ouvrez un compte, vous gardez la garde de vos accès et de toute action faite sous votre nom. Vous devez nous prévenir vite en cas d''usage non permis. Vous vous engagez à ne pas bloquer les Services, ne pas forcer les accès et ne pas agir contre la loi.</p>')::jsonb,
         updated_at = now()
   WHERE page_id = 12
     AND content::text LIKE '%' || '<h2>5. Comptes et utilisation acceptable' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Comme l''énonce l''article 15 de l''AGPL-3.0, le logiciel est fourni « tel quel », sans garantie d''aucune sorte, expresse ou implicite, y compris, sans s''y limiter, les garanties implicites de qualité marchande et d''adéquation à un usage particulier. Vous assumez l''entièreté du risque quant à la qualité et au rendement du logiciel.', 'Selon l''article 15 de l''AGPL-3.0, le logiciel est fourni « tel quel », sans garantie d''aucune sorte, expresse ou tacite. Cela inclut les garanties de vente ou d''usage pour un besoin précis. Vous prenez sur vous les risques liés au bon emploi du logiciel.')::jsonb,
         updated_at = now()
   WHERE page_id = 12
     AND content::text LIKE '%' || 'Comme l''énonce l''article 15 de l''AGPL-3.' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<h2>7. Limitation de responsabilité</h2>
<p>Comme l''énonce l''article 16 de l''AGPL-3.0, et dans toute la mesure permise par la loi applicable, en aucun cas un titulaire de droits d''auteur ou toute autre partie qui modifie ou transmet le logiciel ne saurait être tenu responsable envers vous de dommages, y compris tout dommage général, spécial, accessoire ou consécutif découlant de l''utilisation ou de l''impossibilité d''utiliser le logiciel.</p>', '<h2>7. Limite de responsabilité</h2> <p>Selon l''article 16 de l''AGPL-3.0 et dans la limite permise par la loi, aucun auteur ou tiers modifiant le code ne peut être tenu pour responsable de vos pertes ou dommages liés à l''usage du logiciel.</p>')::jsonb,
         updated_at = now()
   WHERE page_id = 12
     AND content::text LIKE '%' || '<h2>7. Limitation de responsabilité</h2>' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Les présentes conditions sont régies par les lois de la province de Québec et les lois fédérales du Canada qui y sont applicables, sans égard aux règles de conflit de lois. Rien dans les présentes conditions ne limite les droits impératifs de protection du consommateur dont vous pourriez bénéficier en vertu de ces lois.', 'Ces conditions suivent les lois de la province de Québec et les lois du Canada applicables. Rien ici ne réduit vos droits stricts de consommateur selon ces lois.')::jsonb,
         updated_at = now()
   WHERE page_id = 12
     AND content::text LIKE '%' || 'Les présentes conditions sont régies par' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, '<h2>9. Modifications</h2>
<p>Nous pouvons réviser ces conditions de temps à autre. Les changements importants seront communiqués au moyen des Services, et l''utilisation continue des Services après leur entrée en vigueur vaut acceptation.</p>', '<h2>9. Mises à jour</h2> <p>Nous pouvons adapter ces règles au fil du temps. Les changements notables passeront sur le site. Votre usage continu vaut accord avec les nouvelles règles.</p>')::jsonb,
         updated_at = now()
   WHERE page_id = 12
     AND content::text LIKE '%' || '<h2>9. Modifications</h2>
<p>Nous pouvo' || '%';

  UPDATE public.blocks
     SET content = replace(content::text, 'Des questions sur ces conditions ? Contactez NextBlock™ CMS à <a href="mailto:{{privacy_email}}">{{privacy_email}}</a>.', 'Une question sur ces conditions ? Écrivez à NextBlock™ CMS à <a href="mailto:{{privacy_email}}">{{privacy_email}}</a>.')::jsonb,
         updated_at = now()
   WHERE page_id = 12
     AND content::text LIKE '%' || 'Des questions sur ces conditions ? Conta' || '%';

END $$;
