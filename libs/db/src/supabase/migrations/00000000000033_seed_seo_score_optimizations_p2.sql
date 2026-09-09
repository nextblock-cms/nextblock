-- Migration: 00000000000033_seed_seo_score_optimizations_p2.sql
-- Description: Complete 100/100 Page SEO optimization for shop/boutique, legal pages, and setup/updating posts.
-- Safety: Forward-only, content-guarded updates that only touch matching seeded copy.

DO $$
BEGIN
  -----------------------------------------------------------------------------
  -- 1. Post Metadata (Post 8 & Post 9)
  -----------------------------------------------------------------------------
  UPDATE public.posts
     SET meta_description = 'A single command keeps your NextBlock install updated on Docker, Supabase, or a cloned repo. Learn how it works and keeps your data safe.',
         updated_at = now()
   WHERE slug = 'how-updating-works'
     AND meta_description LIKE 'Update NextBlock in one step%';

  UPDATE public.posts
     SET meta_title = 'Mises à jour NextBlock : une commande pour chaque site',
         meta_description = 'Une seule commande met à jour NextBlock sur Docker, Supabase ou un dépôt cloné. Découvrez le fonctionnement et la protection de vos données.',
         updated_at = now()
   WHERE slug = 'comment-fonctionnent-les-mises-a-jour'
     AND meta_title LIKE 'Mettre à jour NextBlock%';

  -----------------------------------------------------------------------------
  -- 2. Post 4 Setup FR Card Headings (H3 -> H2 to prevent heading level skip)
  -----------------------------------------------------------------------------
  UPDATE public.blocks
     SET content = jsonb_set(content, '{html_content}', to_jsonb('<p class=''text-lg leading-8 text-slate-700 dark:text-slate-300''>NextBlock est un CMS open source et natif IA, construit sur Next.js et Supabase — et son installation ne passe plus par des fichiers de configuration, des assistants en ligne de commande ou du SQL manuel. Voici quatre façons de démarrer, <strong>classées de la plus simple à la plus technique</strong> : la première tient en un clic, la dernière donne le code source complet pour celles et ceux qui veulent participer à NextBlock. Elles aboutissent toutes au même endroit — un <strong>assistant de configuration</strong> dans le navigateur qui connecte votre base de données, configure le stockage des médias et crée votre compte administrateur.</p>

<div class=''mt-8 mb-6 flex items-center gap-4 text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400''>
  <span class=''flex-shrink-0''>Le plus simple</span>
  <span class=''h-1.5 flex-1 rounded-full bg-gradient-to-r from-blue-400 via-violet-400 to-emerald-400''></span>
  <span class=''flex-shrink-0''>Le plus de contrôle</span>
</div>

<div class=''grid gap-5 md:grid-cols-2 my-6''>
  <a href=''#one-click-vercel'' class=''block rounded-[1.75rem] border border-blue-200 bg-blue-50/70 p-6 no-underline transition-shadow hover:shadow-lg dark:border-blue-500/20 dark:bg-blue-500/10''>
    <div class=''flex items-center justify-between mb-4''>
      <span class=''flex h-9 w-9 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white''>1</span>
      <span class=''inline-flex items-center gap-1''><span class=''h-1.5 w-5 rounded-full bg-blue-500''></span><span class=''h-1.5 w-5 rounded-full bg-slate-200 dark:bg-white/10''></span><span class=''h-1.5 w-5 rounded-full bg-slate-200 dark:bg-white/10''></span><span class=''h-1.5 w-5 rounded-full bg-slate-200 dark:bg-white/10''></span></span>
    </div>
    <p class=''mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-blue-700 dark:text-blue-200''>Le plus simple &middot; un clic</p>
    <h2 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>Déployer sur Vercel</h2>
    <p class=''mb-0 text-sm leading-6 text-slate-600 dark:text-slate-300''>Un site de production en ligne avec une base de données gérée. Pas de terminal, aucun compte à configurer, rien à copier.</p>
  </a>
  <a href=''#npm-docker'' class=''block rounded-[1.75rem] border border-amber-200 bg-amber-50/70 p-6 no-underline transition-shadow hover:shadow-lg dark:border-amber-500/20 dark:bg-amber-500/10''>
    <div class=''flex items-center justify-between mb-4''>
      <span class=''flex h-9 w-9 items-center justify-center rounded-full bg-amber-500 text-sm font-bold text-white''>2</span>
      <span class=''inline-flex items-center gap-1''><span class=''h-1.5 w-5 rounded-full bg-amber-500''></span><span class=''h-1.5 w-5 rounded-full bg-amber-500''></span><span class=''h-1.5 w-5 rounded-full bg-slate-200 dark:bg-white/10''></span><span class=''h-1.5 w-5 rounded-full bg-slate-200 dark:bg-white/10''></span></span>
    </div>
    <p class=''mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-amber-700 dark:text-amber-200''>Facile &middot; 100 % local</p>
    <h2 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>npm create nextblock &rarr; Docker</h2>
    <p class=''mb-0 text-sm leading-6 text-slate-600 dark:text-slate-300''>Un seul prompt génère un projet et démarre toute la pile — base de données, auth, stockage, CMS — sur votre machine. Aucun compte cloud.</p>
  </a>
  <a href=''#npm-cloud'' class=''block rounded-[1.75rem] border border-violet-200 bg-violet-50/70 p-6 no-underline transition-shadow hover:shadow-lg dark:border-violet-500/20 dark:bg-violet-500/10''>
    <div class=''flex items-center justify-between mb-4''>
      <span class=''flex h-9 w-9 items-center justify-center rounded-full bg-violet-600 text-sm font-bold text-white''>3</span>
      <span class=''inline-flex items-center gap-1''><span class=''h-1.5 w-5 rounded-full bg-violet-500''></span><span class=''h-1.5 w-5 rounded-full bg-violet-500''></span><span class=''h-1.5 w-5 rounded-full bg-violet-500''></span><span class=''h-1.5 w-5 rounded-full bg-slate-200 dark:bg-white/10''></span></span>
    </div>
    <p class=''mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-violet-700 dark:text-violet-200''>Intermédiaire &middot; votre propre cloud</p>
    <h2 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>npm create nextblock &rarr; Supabase + R2</h2>
    <p class=''mb-0 text-sm leading-6 text-slate-600 dark:text-slate-300''>Générez une app autonome sur votre propre projet Supabase géré et Cloudflare R2, prête à déployer partout.</p>
  </a>
  <a href=''#git-clone'' class=''block rounded-[1.75rem] border border-emerald-200 bg-emerald-50/70 p-6 no-underline transition-shadow hover:shadow-lg dark:border-emerald-500/20 dark:bg-emerald-500/10''>
    <div class=''flex items-center justify-between mb-4''>
      <span class=''flex h-9 w-9 items-center justify-center rounded-full bg-emerald-600 text-sm font-bold text-white''>4</span>
      <span class=''inline-flex items-center gap-1''><span class=''h-1.5 w-5 rounded-full bg-emerald-500''></span><span class=''h-1.5 w-5 rounded-full bg-emerald-500''></span><span class=''h-1.5 w-5 rounded-full bg-emerald-500''></span><span class=''h-1.5 w-5 rounded-full bg-emerald-500''></span></span>
    </div>
    <p class=''mt-0 mb-0 text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200''>Avancé &middot; pour les contributeurs</p>
    <h2 class=''mt-2 mb-2 text-xl font-semibold text-slate-900 dark:text-white''>Cloner le dépôt</h2>
    <p class=''mb-0 text-sm leading-6 text-slate-600 dark:text-slate-300''>Faites tourner le monorepo complet — le CMS, tous les packages et la documentation. Pour celles et ceux qui veulent aider à construire NextBlock (Docker fonctionne ici aussi).</p>
  </a>
</div>

<p class=''text-sm text-slate-500 dark:text-slate-400''>Vous ne savez pas par où commencer ? Descendez la liste — choisissez la première option dont vous avez déjà les prérequis. La plupart des gens devraient commencer par <a href=''#one-click-vercel''>Vercel</a>.</p>

<figure class=''my-12 overflow-hidden rounded-[2rem] border border-slate-200/80 bg-slate-950 shadow-2xl dark:border-white/10''>
  <img src=''/images/included.webp'' alt=''Aperçu de la plateforme NextBlock : éditeur de blocs, tableau de bord CMS et intégrations incluses dans chaque installation'' class=''w-full h-auto object-cover'' />
  <figcaption class=''border-t border-white/10 px-6 py-4 text-sm text-slate-300''>Quel que soit le chemin choisi, vous obtenez le même éditeur de blocs, le même CMS et le même schéma de base de données.</figcaption>
</figure>

<h2 id=''one-click-vercel''>Option 1 : Déploiement Vercel en un clic</h2>
<p class=''mt-2 mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm''><span class=''inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-blue-700 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-200''>Étape 1 &middot; Le plus simple</span><span class=''text-slate-500 dark:text-slate-400''>Idéal pour un site en ligne avec le minimum d''effort — pas de terminal, aucun compte à configurer.</span></p>
<p>Le moyen le plus rapide d''obtenir un site NextBlock en production. Un seul bouton crée votre propre copie de NextBlock sur GitHub, provisionne une base de données Supabase gérée et déploie le site — sans jamais ouvrir un terminal ni copier la moindre clé.</p>
<ol class=''space-y-2''>
  <li><strong>Cliquez sur Deploy to Vercel</strong> et connectez-vous — Vercel clone NextBlock dans un nouveau dépôt qui vous appartient.</li>
  <li><strong>Nommez le dépôt — et rendez-le Public.</strong> À la première étape sur Vercel, vous choisissez le nom du dépôt ; réglez sa visibilité sur <strong>Public</strong> plutôt que Privé. Un dépôt public est ce qui débloque les mises à jour automatiques en un clic plus tard — c''est donc le choix recommandé.</li>
  <li><strong>Créez la base de données Supabase</strong> quand on vous le demande : choisissez un nom et une région. Vercel la connecte au projet et injecte les clés avant le premier build.</li>
  <li><strong>Ouvrez votre nouveau site</strong> une fois le build terminé. Toute nouvelle instance vous amène directement à l''assistant de configuration.</li>
  <li><strong>Créez votre compte administrateur.</strong> Il est confirmé instantanément — aucun email de vérification — et vous arrivez dans le tableau de bord du CMS.</li>
</ol>
<div class=''my-8''>
  <a href=''https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fnextblock-cms%2Fnextblock&amp;project-name=nextblock&amp;repository-name=nextblock&amp;stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22supabase%22%2C%22productSlug%22%3A%22supabase%22%7D%5D'' target=''_blank'' rel=''noopener'' class=''inline-flex items-center rounded-full bg-slate-900 px-6 py-3 text-sm font-semibold text-white no-underline shadow-lg hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200''>Déployer sur Vercel &rarr;</a>
</div>
<div class=''rounded-3xl border border-emerald-200 bg-emerald-50/80 p-6 my-8 dark:border-emerald-500/20 dark:bg-emerald-500/10''>
  <p class=''mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200''>Recommandé &middot; rendez le dépôt public</p>
  <p class=''mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200''>Quand Vercel vous demande de nommer le nouveau dépôt, choisissez <strong>Public</strong>. C''est gratuit, et c''est ce qui permet à l''étape <strong>Connect GitHub</strong> du tableau de bord d''installer un workflow quotidien qui garde votre site synchronisé avec la dernière version de NextBlock. Vous pourrez toujours passer un dépôt privé en public plus tard dans GitHub — mais démarrer en public est le chemin le plus simple vers les mises à jour automatiques.</p>
</div>
<div class=''rounded-3xl border border-blue-200 bg-blue-50/80 p-6 my-8 dark:border-blue-500/20 dark:bg-blue-500/10''>
  <p class=''mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-blue-700 dark:text-blue-200''>Zéro configuration</p>
  <p class=''mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200''>Aucune variable d''environnement à remplir. Le stockage des médias utilise automatiquement votre projet Supabase connecté, les secrets de sécurité sont dérivés pour vous, et les migrations de base de données s''exécutent automatiquement à chaque build de production. Un domaine personnalisé plus tard ? Définissez <code>NEXT_PUBLIC_URL</code> dans votre projet Vercel et redéployez.</p>
</div>

<h2 id=''npm-docker''>Option 2 : npm create nextblock &rarr; Docker (100 % local)</h2>
<p class=''mt-2 mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm''><span class=''inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200''>Étape 2 &middot; Facile</span><span class=''text-slate-500 dark:text-slate-400''>Idéal pour tout essayer sur votre machine sans aucun compte cloud. Nécessite Docker Desktop.</span></p>
<p>Faites tourner NextBlock entièrement sur votre machine, sans aucun compte cloud. Le CLI génère une application Next.js autonome puis démarre toute la pile dans Docker pour vous : les moteurs Postgres et auth de Supabase, une API PostgREST derrière une passerelle Kong, un stockage MinIO compatible S3 et le CMS lui-même — idéal pour les évaluations, les environnements isolés et la pleine propriété de vos données.</p>
<p>Avant de commencer, installez <a href=''https://nodejs.org'' target=''_blank'' rel=''noopener''>Node.js 20 ou plus récent</a> (npm inclus) et <a href=''https://www.docker.com/products/docker-desktop/'' target=''_blank'' rel=''noopener''>Docker Desktop</a>, et assurez-vous que Docker Desktop est démarré.</p>
<pre><code>npm create nextblock@latest mon-site</code></pre>
<ol class=''space-y-2''>
  <li><strong>Choisissez le profil d''hébergement.</strong> Au premier prompt, choisissez <em>Local Self-Hosted Docker Mode (One-Click Local Sandbox)</em>, puis confirmez que Docker Desktop est installé et démarré.</li>
  <li><strong>Laissez faire.</strong> Le CLI copie le template, installe les dépendances, génère des clés sécurisées et démarre toute la pile avec une seule commande Docker — sans aucune question. Le premier lancement télécharge les images et construit l''app, comptez donc quelques minutes ; chaque migration de base de données est appliquée automatiquement au démarrage de la pile.</li>
  <li><strong>Ouvrez <code>http://localhost:3000</code></strong> — vous êtes redirigé vers l''assistant de configuration. Comme la base de données et le stockage MinIO sont déjà connectés, les étapes de connexion et de stockage sont ignorées : il ne reste qu''à créer votre administrateur (confirmé instantanément, sans email). Vous arrivez dans le tableau de bord du CMS.</li>
</ol>
<div class=''rounded-3xl border border-amber-200 bg-amber-50/80 p-6 my-8 dark:border-amber-500/20 dark:bg-amber-500/10''>
  <p class=''mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-amber-700 dark:text-amber-200''>Commandes du quotidien</p>
  <pre class=''mt-4 mb-0''><code># reconstruire et redémarrer la pile
npm run docker:up

# arrêter la pile (vos données persistent dans les volumes Docker)
npm run docker:down

# suivre les logs de l''application
npm run docker:logs</code></pre>
  <p class=''mt-4 mb-0 text-sm text-slate-700 dark:text-slate-200''>Le mode Docker n''est proposé que dans le prompt interactif — ne passez pas <code>--yes</code>, qui force le mode cloud géré ci-dessous.</p>
</div>

<h2 id=''npm-cloud''>Option 3 : npm create nextblock &rarr; votre propre Supabase + Cloudflare</h2>
<p class=''mt-2 mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm''><span class=''inline-flex items-center gap-2 rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-violet-700 dark:border-violet-500/20 dark:bg-violet-500/10 dark:text-violet-200''>Étape 3 &middot; Intermédiaire</span><span class=''text-slate-500 dark:text-slate-400''>Idéal pour construire votre propre site sur du cloud géré. Nécessite un projet Supabase et un bucket R2.</span></p>
<p>Le meilleur point de départ pour construire votre propre site sur du cloud géré. Le CLI génère une application Next.js autonome avec NextBlock déjà intégré — sans monorepo ni outillage de workspace — reliée à un projet Supabase et un bucket Cloudflare R2 que vous contrôlez, et elle se déploie partout où Next.js tourne.</p>
<p>Avant de commencer, installez <a href=''https://nodejs.org'' target=''_blank'' rel=''noopener''>Node.js 20 ou plus récent</a>, créez un projet gratuit sur <a href=''https://supabase.com'' target=''_blank'' rel=''noopener''>supabase.com</a>, et configurez un bucket <a href=''https://developers.cloudflare.com/r2/'' target=''_blank'' rel=''noopener''>Cloudflare R2</a> pour vos images et fichiers.</p>
<pre><code>npm create nextblock@latest mon-site
cd mon-site
npm run dev</code></pre>
<p>Au premier prompt, choisissez <em>Managed Cloud Mode (Vercel + Supabase Cloud)</em> et nommez votre projet. Ouvrez ensuite <code>http://localhost:3000/setup</code> et laissez l''assistant faire le travail :</p>
<ol class=''space-y-2''>
  <li><strong>Connectez Supabase</strong> — collez l''URL du projet, la clé publiable (anon), la clé secrète (service role) et un jeton d''accès personnel pour que l''assistant applique le schéma de base de données à votre place.</li>
  <li><strong>Ajoutez Cloudflare R2</strong> — saisissez votre identifiant de compte R2, le nom du bucket, la clé d''accès (access key ID), la clé secrète et l''URL publique du bucket pour servir vos images et fichiers.</li>
  <li><strong>Créez votre administrateur</strong> — l''assistant applique toutes les migrations, génère les secrets de l''application, écrit <code>.env.local</code>, crée votre compte admin confirmé et vous connecte. Redémarrez ensuite <code>npm run dev</code> une fois pour que le nouvel environnement soit intégré à l''application.</li>
</ol>
<div class=''rounded-3xl border border-violet-200 bg-violet-50/80 p-6 my-8 dark:border-violet-500/20 dark:bg-violet-500/10''>
  <p class=''mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-violet-700 dark:text-violet-200''>Modules premium</p>
  <p class=''mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200''>Besoin d''une boutique ? Une seule commande ajoute produits, paiement, commandes et coupons — activés par clé de licence, prêts quand vous l''êtes : <code>npx create-nextblock activate ecommerce</code></p>
</div>

<h2 id=''git-clone''>Option 4 : Cloner le dépôt</h2>
<p class=''mt-2 mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm''><span class=''inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200''>Étape 4 &middot; Avancé</span><span class=''text-slate-500 dark:text-slate-400''>Idéal pour les contributeurs et les équipes qui veulent personnaliser la plateforme. Nécessite Node.js et git.</span></p>
<p>Faites tourner le monorepo Nx complet : l''application CMS, tous les packages partagés, le code du CLI et la documentation. C''est le chemin de celles et ceux qui veulent participer au projet — contributeurs, auteurs de plugins et équipes qui personnalisent la plateforme elle-même.</p>
<pre><code>git clone https://github.com/nextblock-cms/nextblock.git
cd nextblock
npm install
npx nx serve nextblock</code></pre>
<p>Ouvrez <code>http://localhost:4200</code> — une nouvelle installation redirige chaque page vers <code>/setup</code>, où le même assistant en trois étapes connecte Supabase, configure le stockage et crée votre admin. Il valide vos clés, écrit <code>.env.local</code> avec des secrets générés, et applique toutes les migrations via l''API de management Supabase — sans CLI Supabase.</p>
<div class=''rounded-3xl border border-emerald-200 bg-emerald-50/80 p-6 my-8 dark:border-emerald-500/20 dark:bg-emerald-500/10''>
  <p class=''mt-0 text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-200''>Vous préférez rester local ? Docker fonctionne ici aussi</p>
  <p class=''mt-3 mb-0 text-sm text-slate-700 dark:text-slate-200''>Pas besoin de comptes cloud pour développer sur le monorepo. Avec Docker Desktop démarré, une seule commande lance la même pile auto-hébergée que l''option 2 — Postgres, auth, stockage et le CMS — directement depuis votre clone :</p>
  <pre class=''mt-4 mb-0''><code>npm run docker:setup</code></pre>
  <p class=''mt-4 mb-0 text-sm text-slate-700 dark:text-slate-200''>Quand c''est terminé, ouvrez <code>http://localhost:3000</code> et créez votre administrateur. Notez que le monorepo n''a pas de <code>npm run dev</code> — utilisez <code>npx nx serve nextblock</code> (port 4200) pour le chemin cloud.</p>
</div>

<h2 id=''after-install''>Après l''installation : vos 10 premières minutes</h2>
<p>Chaque chemin vous dépose sur <code>/cms/dashboard</code>, connecté en tant que premier administrateur. Une checklist de démarrage intégrée vous guide pour la suite :</p>
<ul class=''space-y-2''>
  <li><strong>Ajoutez votre identité visuelle</strong> — téléversez votre logo et définissez le titre du site.</li>
  <li><strong>Réglez votre pied de page</strong> — mention de copyright et navigation du pied de page.</li>
  <li><strong>Configurez l''email (SMTP)</strong> — dans les réglages, pour que les réinitialisations de mot de passe et les invitations partent bien.</li>
  <li><strong>Extras optionnels</strong> — connectez vos outils d''analytics, activez la protection anti-bots et (sur Vercel) les mises à jour automatiques.</li>
</ul>
<p>Ensuite, découvrez comment la plateforme s''articule dans <a href=''/article/comment-nextblock-fonctionne''>Comment NextBlock fonctionne</a>, ou ajoutez une boutique avec le <a href=''/article/guide-commerce-nextblock''>guide Commerce</a>.</p>

<h2 id=''faq''>FAQ d''installation</h2>
<h3>Que dois-je installer ?</h3>
<p>Rien pour le chemin Vercel — tout se passe dans le navigateur. Pour <code>npm create nextblock</code> en mode Docker : <a href=''https://nodejs.org'' target=''_blank'' rel=''noopener''>Node.js 20+</a> et Docker Desktop. Pour le mode cloud géré : Node.js 20+ ainsi qu''un projet Supabase et un bucket Cloudflare R2. Pour le dépôt cloné : Node.js 20+ et git (ajoutez Docker Desktop si vous voulez faire tourner la pile locale).</p>
<h3>NextBlock est-il gratuit ?</h3>
<p>Oui — le cœur du CMS est 100 % gratuit et open source (AGPL). Les packages premium comme l''e-commerce et Cortex AI sont optionnels et s''activent avec une clé de licence. Vercel et Supabase proposent chacun une offre gratuite : un site de départ peut donc tourner sans frais.</p>
<h3>Ai-je besoin d''un compte Supabase ?</h3>
<p>Sur Vercel, la base de données est créée pour vous pendant le déploiement. Pour le chemin cloud géré <code>npm create nextblock</code> et le dépôt cloné, il vous faut un projet Supabase gratuit. Avec Docker — via le mode Docker du CLI ou <code>npm run docker:setup</code> dans le clone — aucun compte cloud n''est nécessaire.</p>
<h3>Dois-je exécuter des migrations ou du SQL à la main ?</h3>
<p>Non. L''assistant de configuration, le build Vercel et la pile Docker appliquent tous le schéma de base de données automatiquement — et relancer l''opération est toujours sans risque.</p>
<h3>Puis-je changer de chemin plus tard ?</h3>
<p>Oui. Chaque chemin exécute la même application et le même schéma de base de données : vous pouvez prototyper en local avec Docker aujourd''hui et déployer sur Vercel demain. NextBlock se déploie comme n''importe quelle app Next.js.</p>
<h3>Comment mettre à jour NextBlock ?</h3>
<p>Sur Vercel, l''étape Connect GitHub de la checklist active une synchronisation quotidienne automatique (cela nécessite un dépôt public). Sur un dépôt cloné, <code>git pull</code>, lancez <code>npm run db:migrate</code>, puis redémarrez (lors des builds de production, les migrations en attente s''appliquent automatiquement). Avec Docker, récupérez le dernier code et lancez <code>npm run docker:up</code>.</p>

<div class=''rounded-[2rem] border border-slate-200/80 bg-slate-50 p-8 my-12 text-center dark:border-white/10 dark:bg-white/5''>
  <p class=''mt-0 text-2xl font-semibold text-slate-900 dark:text-white''>Prêt à vous lancer ?</p>
  <p class=''text-sm text-slate-600 dark:text-slate-300''>Choisissez votre chemin ci-dessus, ou passez directement au plus rapide.</p>
  <div class=''mt-5 flex flex-wrap justify-center gap-3''>
    <a href=''https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fnextblock-cms%2Fnextblock&amp;project-name=nextblock&amp;repository-name=nextblock&amp;stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22supabase%22%2C%22productSlug%22%3A%22supabase%22%7D%5D'' target=''_blank'' rel=''noopener'' class=''inline-flex items-center rounded-full bg-slate-900 px-6 py-3 text-sm font-semibold text-white no-underline shadow-lg hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200''>Déployer sur Vercel</a>
    <a href=''https://github.com/nextblock-cms/nextblock'' target=''_blank'' rel=''noopener'' class=''inline-flex items-center rounded-full border border-slate-300 px-6 py-3 text-sm font-semibold text-slate-700 no-underline hover:border-slate-500 dark:border-white/20 dark:text-slate-200 dark:hover:border-white/50''>Voir sur GitHub</a>
  </div>
</div>'::text)),
         updated_at = now()
   WHERE post_id = 4
     AND content->>'html_content' LIKE '%NextBlock est un CMS open source et%';

  -----------------------------------------------------------------------------
  -- 3. Page 7 (Shop EN) & Page 8 (Boutique FR) Expanded Body Content (>= 300 words)
  -----------------------------------------------------------------------------
  UPDATE public.blocks
     SET content = jsonb_set(content, '{column_blocks,0,1,content,html_content}', to_jsonb('<p style="text-align: center; color: var(--background); opacity: 0.9">Discover our selection of official commercial add-ons and developer tools for NextBlock CMS.</p><div class=''mt-8 text-slate-300 space-y-4 max-w-3xl mx-auto text-left''><h2 class=''text-2xl font-bold text-white mb-4''>Power Up Your Web Projects</h2><p>Welcome to the official NextBlock™ digital store. Here you can purchase licenses for our premium packages, including NextBlock™ Commerce and NextBlock™ Cortex AI. Every commercial license helps fund full-time open-source development on our core CMS while giving your team advanced tools to launch high-performance websites faster.</p><p>Our premium modules are designed to feel native from day one. You get clean code that fits right into your existing NextBlock project without third-party plugins or complex configuration. When you purchase a license from our store, you receive instant access to everything you need:</p><ul class=''space-y-2 list-disc pl-5''><li><strong>Full Source Code:</strong> Inspect, customize, and adapt the modules to your exact requirements.</li><li><strong>Perpetual Use:</strong> Use the software for your project with full peace of mind.</li><li><strong>Automated Updates:</strong> Enjoy smooth updates that match each new release of NextBlock and Next.js.</li><li><strong>Secure Checkout:</strong> Payments are processed safely with Stripe and Freemius with instant receipt generation.</li></ul><p>Whether you need multi-currency store features, automated sales tax calculations, or AI block generation in your editor, our modules deliver tested solutions that keep your Lighthouse scores at 100%.</p><p>All purchases include dedicated onboarding resources, detailed developer docs, and friendly technical support. If you ever run into an issue or need help wiring up a provider webhook, our core engineers are ready to assist you. We also offer a thirty-day refund policy so you can try our tools risk-free.</p><p>Have questions about license tiers, volume pricing, team seats, or custom agency usage? Contact our support team anytime. Our team is here to answer your questions and help your developers succeed. We are happy to help you pick the best plan for your company. Browse our featured products below to get started today.</p></div>'::text)),
         updated_at = now()
   WHERE page_id = 7
     AND content#>>'{column_blocks,0,1,content,html_content}' LIKE '%Discover our premium selection%';

  UPDATE public.blocks
     SET content = jsonb_set(content, '{column_blocks,0,1,content,html_content}', to_jsonb('<p style="text-align: center; color: var(--background); opacity: 0.9">Découvrez nos extensions officielles et nos outils pour développeurs conçus pour le CMS NextBlock.</p><div class=''mt-8 text-slate-300 space-y-4 max-w-3xl mx-auto text-left''><h2 class=''text-2xl font-bold text-white mb-4''>Accélérez vos projets web</h2><p>Bienvenue sur la boutique officielle de NextBlock™. Vous pouvez acheter ici des licences pour nos modules professionnels, comme NextBlock™ Commerce et NextBlock™ Cortex AI. Chaque achat aide à financer le travail open-source sur le cœur du CMS. Il donne aussi à votre équipe des outils de pointe pour créer des sites rapides et fiables.</p><p>Nos modules premium s''intègrent sans effort à votre projet existant. Vous profitez d''un code propre et bien testé, sans plugin externe lourd ni réglage complexe. En choisissant nos outils, vous profitez immédiatement de nombreux avantages :</p><ul class=''space-y-2 list-disc pl-5''><li><strong>Code source complet :</strong> Lisez, adaptez et faites évoluer chaque bloc selon vos besoins métier.</li><li><strong>Licence perpétuelle :</strong> Utilisez le code sur votre projet en toute sérénité.</li><li><strong>Mises à jour suivies :</strong> Recevez les nouvelles versions au rythme de Next.js et de NextBlock.</li><li><strong>Paiement sécurisé :</strong> Les achats passent par Stripe et Freemius avec facture instantanée.</li></ul><p>Vous voulez vendre dans plusieurs devises ? Vous avez besoin du calcul automatique des taxes ? Vous voulez générer des blocs avec l''IA ? Nos modules offrent des solutions prêtes à l''emploi qui préservent vos scores Lighthouse à 100%.</p><p>Chaque commande donne accès à une documentation claire et à notre support technique. Si vous avez besoin d''aide pour brancher un webhook ou un mode de paiement, nos développeurs vous répondent rapidement. Notre équipe est à vos côtés pour vous faire gagner du temps. Nous proposons aussi une garantie satisfait ou remboursé de trente jours.</p><p>Vous avez des questions sur nos tarifs, les licences agence ou les remises en volume ? Écrivez à notre équipe à tout moment. Nous vous guiderons avec grand plaisir vers l''offre idéale pour votre entreprise. Découvrez dès aujourd''hui l''ensemble de nos produits ci-dessous pour bien démarrer votre projet.</p></div>'::text)),
         updated_at = now()
   WHERE page_id = 8
     AND content#>>'{column_blocks,0,1,content,html_content}' LIKE '%Decouvrez notre selection premium%';

  -----------------------------------------------------------------------------
  -- 4. Page 9 (Privacy EN), Page 10 (Politique FR), Page 12 (Conditions FR) Readability
  -----------------------------------------------------------------------------
  UPDATE public.blocks
     SET content = jsonb_set(content, '{html_content}', to_jsonb('
<h1>Privacy Policy</h1>
<p><em>Last updated: June 4, 2026</em></p>
<p>NextBlock™ CMS ("we", "us", or "our") respects your privacy. We protect your personal information under Quebec''s Law 25, the federal PIPEDA act, and Canada''s Anti-Spam Legislation (CASL).</p>

<h2>1. Person responsible for personal information</h2>
<p>Our Privacy Officer oversees our compliance with privacy laws. You can reach them at <a href="mailto:{{privacy_email}}">{{privacy_email}}</a>.</p>

<h2>2. What we collect</h2>
<ul>
  <li><strong>Account information:</strong> Your name, email address, and login details when you register.</li>
  <li><strong>Usage and device data:</strong> Collected only with your consent through analytics tools.</li>
  <li><strong>Communications:</strong> Messages you send us and your newsletter choices.</li>
</ul>

<h2>3. Why we collect it and your consent</h2>
<p>We collect personal information for clear reasons: to provide our services, keep accounts secure, and reply to your messages. We use analytics and marketing tools only with your direct, opt-in consent. Under Law 25, optional cookies stay off until you choose to accept them. You can withdraw your consent at any time.</p>

<h2>4. Cookies and tracking technologies</h2>
<p>Essential cookies keep the site running and require no consent. Analytics and marketing cookies load only after you opt in via our cookie banner. We record your choice to honor it and follow privacy rules.</p>

<h2>5. Disclosure and sharing</h2>
<p>We do not sell your personal data. We share it only with trusted service providers who help us run the platform under strict confidentiality agreements, or when required by law.</p>

<h2>6. Retention</h2>
<p>We keep personal information only as long as needed for the purposes described above or as required by law. After that, we securely delete or anonymize your data.</p>

<h2>7. Your rights</h2>
<p>Under privacy laws, you have the right to view, correct, and delete your personal information. You can also withdraw consent or ask for a portable copy of your data. To use these rights, write to our Privacy Officer at <a href="mailto:{{privacy_email}}">{{privacy_email}}</a>.</p>

<h2>8. Commercial electronic messages (CASL)</h2>
<p>We send commercial emails only with your permission. Every email clearly identifies us and includes an easy unsubscribe link that takes effect right away.</p>

<h2>9. Safeguards</h2>
<p>We use strong technical and physical protections to keep your data safe. These include encrypted connections and strict access controls to prevent loss, theft, and unauthorized access.</p>

<h2>10. Open-source software</h2>
<p>NextBlock™ CMS is free open-source software under the AGPLv3 license. When you self-host NextBlock, you control your own server. You are responsible for the personal data on your deployment, and this policy is a helpful model you can adapt.</p>

<h2>11. Changes to this policy</h2>
<p>We may update this policy over time. We announce important changes on our site and update the revision date at the top.</p>

<h2>12. Contact us</h2>
<p>Have questions or complaints? Contact NextBlock™ at <a href="mailto:{{privacy_email}}">{{privacy_email}}</a>. You can also contact the Commission d''accès à l''information du Québec or the Office of the Privacy Commissioner of Canada.</p>
'::text)),
         updated_at = now()
   WHERE page_id = 9
     AND content->>'html_content' LIKE '%respects your privacy and is committed%';

  UPDATE public.blocks
     SET content = jsonb_set(content, '{html_content}', to_jsonb('
<h1>Politique de confidentialité</h1>
<p><em>Dernière mise à jour : 4 juin 2026</em></p>
<p>NextBlock™ CMS (« nous ») respecte votre vie privée. Nous protégeons vos renseignements personnels selon la Loi 25 du Québec, la loi fédérale LPRPDE et les règles canadiennes anti-pourriel (LCAP).</p>

<h2>1. Responsable de la protection des renseignements personnels</h2>
<p>Notre responsable veille au respect des règles de confidentialité. Vous pouvez lui écrire à <a href="mailto:{{privacy_email}}">{{privacy_email}}</a>.</p>

<h2>2. Renseignements que nous recueillons</h2>
<ul>
  <li><strong>Renseignements de compte :</strong> Votre nom, votre courriel et vos accès lors de l''inscription.</li>
  <li><strong>Données d''utilisation et d''appareil :</strong> Recueillies avec votre accord via nos outils de mesure.</li>
  <li><strong>Communications :</strong> Vos messages reçus et vos choix de suivi par courriel.</li>
</ul>

<h2>3. Finalités et consentement</h2>
<p>Nous recueillons vos données pour des motifs clairs : faire fonctionner nos services, sécuriser les accès et vous répondre. Les outils d''analyse et de suivi ne s''activent qu''avec votre accord clair. Selon la Loi 25, les témoins optionnels restent coupés tant que vous ne les acceptez pas. Vous pouvez retirer votre accord en tout temps.</p>

<h2>4. Témoins et technologies de suivi</h2>
<p>Les témoins essentiels assurent le bon fonctionnement du site. Ils ne demandent aucun accord préalable. Les témoins d''analyse se chargent seulement après votre choix sur notre bandeau. Nous gardons votre choix en mémoire pour le respecter.</p>

<h2>5. Communication à des tiers</h2>
<p>Nous ne vendons jamais vos données personnelles. Nous les partageons uniquement avec des prestataires de confiance qui nous aident à faire tourner le site sous contrat de secret, ou si la loi l''impose.</p>

<h2>6. Conservation</h2>
<p>Nous gardons vos données seulement le temps utile pour les buts décrits ou selon la loi. Ensuite, nous les effaçons ou nous les rendons anonymes de façon sûre.</p>

<h2>7. Vos droits</h2>
<p>Vous avez le droit de lire, de corriger et de faire effacer vos données. Vous pouvez aussi retirer votre accord ou demander une copie de vos données. Pour exercer vos droits, écrivez à notre responsable à <a href="mailto:{{privacy_email}}">{{privacy_email}}</a>.</p>

<h2>8. Messages électroniques commerciaux (LCAP)</h2>
<p>Nous envoyons des courriels informatifs seulement avec votre accord. Chaque courriel montre notre nom et propose un lien simple pour vous désabonner d''un clic.</p>

<h2>9. Mesures de sécurité</h2>
<p>Nous utilisons des moyens techniques et physiques solides pour garder vos données en sûreté. Cela comprend des échanges chiffrés et un contrôle strict des accès contre toute fuite ou vol.</p>

<h2>10. Logiciel libre</h2>
<p>NextBlock™ CMS est un logiciel libre sous licence AGPLv3. Si vous hébergez NextBlock vous-même, vous gérez votre propre serveur. Vous êtes responsable des données sur votre instance, et ce texte est un modèle que vous pouvez adapter.</p>

<h2>11. Modifications</h2>
<p>Nous pouvons mettre à jour ce texte au fil du temps. Les changements notables seront affichés sur le site avec la nouvelle date en tête de page.</p>

<h2>12. Nous joindre</h2>
<p>Une question ou un avis ? Écrivez à NextBlock™ à <a href="mailto:{{privacy_email}}">{{privacy_email}}</a>. Vous pouvez aussi joindre la Commission d''accès à l''information du Québec.</p>
'::text)),
         updated_at = now()
   WHERE page_id = 10
     AND content->>'html_content' LIKE '%respecte votre vie privée et s''engage%';

  UPDATE public.blocks
     SET content = jsonb_set(content, '{html_content}', to_jsonb('
<h1>Conditions d''utilisation</h1>
<p><em>Dernière mise à jour : 4 juin 2026</em></p>

<h2>1. Acceptation des conditions</h2>
<p>En utilisant le CMS NextBlock™ et les services associés (les « Services »), vous acceptez ces conditions d''utilisation. Si vous refusez ces règles, veuillez ne pas utiliser les Services.</p>

<h2>2. Logiciel libre et à code source ouvert</h2>
<p>NextBlock™ CMS est un logiciel libre sous <strong>licence publique générale GNU Affero, version 3 (AGPL-3.0)</strong> ou toute version ultérieure. Vous pouvez lancer, étudier, copier et faire évoluer le code selon cette licence. Le texte complet se trouve avec le code et en ligne sur <a href="https://www.gnu.org/licenses/agpl-3.0.html">gnu.org/licenses/agpl-3.0.html</a>.</p>
<p>Droit d''auteur © 2025 NextBlock™ CMS.</p>

<h2>3. Disponibilité du code source</h2>
<p>Selon l''article 13 de la licence AGPL-3.0, si vous modifiez NextBlock™ CMS et le mettez en ligne pour des usagers sur un réseau, vous devez offrir l''accès libre et sans frais au code source de votre version modifiée.</p>

<h2>4. Marques de commerce</h2>
<p>La licence AGPL-3.0 donne de larges droits sur le code. Mais <strong>elle ne donne aucun droit</strong> sur nos noms et marques. Les termes « NextBlock™ », NextBlock™ CMS et les logos restent notre bien exclusif. Ils ne peuvent être repris sans accord écrit préalable.</p>

<h2>5. Comptes et utilisation acceptable</h2>
<p>Si vous ouvrez un compte, vous gardez la garde de vos accès et de toute action faite sous votre nom. Vous devez nous prévenir vite en cas d''usage non permis. Vous vous engagez à ne pas bloquer les Services, ne pas forcer les accès et ne pas agir contre la loi.</p>

<h2>6. Absence de garantie</h2>
<p>Selon l''article 15 de l''AGPL-3.0, le logiciel est fourni « tel quel », sans garantie d''aucune sorte, expresse ou tacite. Cela inclut les garanties de vente ou d''usage pour un besoin précis. Vous prenez sur vous les risques liés au bon emploi du logiciel.</p>

<h2>7. Limitation de responsabilité</h2>
<p>Selon l''article 16 de l''AGPL-3.0 et dans la limite permise par la loi, aucun auteur ou tiers modifiant le code ne peut être tenu pour responsable de vos pertes ou dommages liés à l''usage du logiciel.</p>

<h2>8. Droit applicable</h2>
<p>Ces conditions suivent les lois de la province de Québec et les lois du Canada applicables. Rien ici ne réduit vos droits stricts de consommateur selon ces lois.</p>

<h2>9. Modifications</h2>
<p>Nous pouvons adapter ces règles au fil du temps. Les changements notables passeront sur le site. Votre usage continu vaut accord avec les nouvelles règles.</p>

<h2>10. Nous joindre</h2>
<p>Une question sur ces conditions ? Écrivez à NextBlock™ CMS à <a href="mailto:{{privacy_email}}">{{privacy_email}}</a>.</p>
'::text)),
         updated_at = now()
   WHERE page_id = 12
     AND content->>'html_content' LIKE '%En accédant à NextBlock™ CMS et aux services%';

END $$;
