# 05 Developer Guide

## Local Setup

The root developer workflow is defined by the workspace `package.json` and the
setup helper in `tools/scripts/setup.mjs`.

### Prerequisites

Configuration happens in the browser, not the terminal — but the wizard asks for
credentials from these services, so have them ready:

1. **Supabase project** (https://supabase.com/dashboard) — Reference ID
   (Project Settings → General), connection string (Connect → Direct connection →
   URI), anon + service_role keys (Project Settings → API Keys), and a Personal
   Access Token (Account → Access Tokens → Generate new token).
2. **Cloudflare R2 bucket** (https://dash.cloudflare.com → R2) — create a bucket,
   enable its Public Development URL (Bucket → Settings → General), and create an
   Account API token (R2 → Manage API Tokens) with Object Read & Write. Copy the
   Access Key ID and Secret Access Key (the secret is shown only once).
3. **SMTP credentials** (SMTP2GO works very well) — required so Supabase can send
   the confirmation email the first admin needs to sign in.

### Run it

```bash
npm install
npm run setup            # prints the next steps — it asks nothing
npx nx serve nextblock   # then open http://localhost:4200/setup
```

`npm run setup` (`tools/scripts/setup.mjs`) is **informational only**. It writes
no files, prompts for nothing, and touches no database — it just points you at
the browser wizard. Terminal-based configuration was removed; everything below
now happens in the **First-Boot Setup Wizard** at `/setup`:

- connecting Supabase and saving the credentials
- applying the schema to the new database
- configuring media storage (R2, or the connected Supabase project's storage)
  and outbound email
- creating the first administrator

A fresh instance redirects every route to `/setup` until an admin exists, so you
cannot miss it.

> **Self-hosted Docker is the exception** — `npm run docker:setup` is a real,
> one-command, non-interactive bootstrap that brings up the whole stack and
> applies migrations. See [11-SELF-HOSTED-DOCKER.md](./11-SELF-HOSTED-DOCKER.md).

If you would rather configure by hand, the root sample file `.env.example` is the
reference template for a manual `.env.local`.

### First login

`npx nx serve nextblock` serves the app at **http://localhost:4200** (the
`@nx/next:server` default port). Open `/sign-up` and register: the **first**
account to sign up is automatically promoted to **ADMIN** by a database trigger
(`handle_new_user`). Email confirmation is enabled by default, so click the
confirmation link (delivered through the SMTP you configured) — or confirm the
user manually in Supabase → Authentication → Users. After signing in you land in
the CMS at `/cms/dashboard`. Every later sign-up gets the `USER` role.

## Common Commands

### App and library workflows

- `npx nx serve nextblock`: start the main app in development
- `npm run lint`: run Nx lint targets across the workspace
- `npm run nx:lint:nextblock`: lint the main app only
- `npm run nx:lint:create-nextblock`: lint the CLI app only
- `npm run all-builds`: build workspace projects except the template output

### Database workflows

- `npm run db:link`: link the Supabase CLI to the target project
- `npm run db:migrate:check`: preview pending remote migrations without
  applying them
- `npm run db:migrate`: apply pending migration files only; this is the
  production-safe path for live databases
- `npm run db:migrate:fresh`: apply the full migration baseline to a
  brand-new empty database
- `npm run db:migrate:repair-history:check`: preview the migration-history
  baseline repair for an existing database whose schema is already present. When the
  remote history still lists retired versions it detects the squash and shows the
  squash-reconcile plan instead
- `npm run db:migrate:repair-history`: mark historical baseline migrations as
  applied without running their SQL; on a squashed history it asks `[Y/n]` and switches
  to the reconcile (revert the retired versions, record the new generation)
- `npm run db:migrate:repair-history:revert:check <version>` /
  `npm run db:migrate:repair-history:revert <version>`: un-record a version so its file
  runs again — the undo for a repair that marked the wrong thing applied
- `npm run db:push`: alias for `npm run db:migrate`
- `npm run db:push:sandbox`: legacy sandbox bootstrap path that pushes
  migrations with `--include-all`, pushes Supabase config, seeds sandbox
  images, and deploys the migration-ingest function
- `npm run db:reset`: reset the local/linked Supabase database from the db
  workdir
- `npm run db:types`: regenerate typed Supabase definitions
- `npm run db:backup`
- `npm run db:restore`
- `npm run deploy:supabase`

### Sandbox and automation workflows

- `npm run generate:sandbox`: regenerate the checked-in sandbox reset payload
- `npm run sandbox:reset`: call the app's sandbox reset cron route locally
- `npm run stripe`: forward Stripe events to the local webhook route

## Environment Expectations

The exact set of env vars depends on which surfaces you use, but the current
repo expects at least:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_PROJECT_ID` for Supabase CLI migration tooling
- `SUPABASE_ACCESS_TOKEN` for Supabase CLI linking
- `POSTGRES_URL` or `DATABASE_URL` for SQL fallback paths and db tooling
- `NEXT_PUBLIC_URL` — set by the `/setup` wizard
- `CRON_SECRET`, `DRAFT_MODE_SECRET`, `REVALIDATE_SECRET_TOKEN` — auto-generated
  by the `/setup` wizard

> **Supabase key aliases.** The names above are the local-dev canon, but the app also
> accepts the *new-style* names the hosted/Vercel Supabase Marketplace integration
> injects: `SUPABASE_URL` (non-prefixed), `SUPABASE_PUBLISHABLE_KEY` /
> `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (anon-equivalent), and `SUPABASE_SECRET_KEY`
> (service-role-equivalent). Resolution lives in `apps/nextblock/lib/setup/env-status.ts`
> (`resolveSupabaseUrl` / `resolveSupabaseAnonKey` / `resolveSupabaseServiceKey`); read
> Supabase env through those (or the same inline alias chain in published libs) rather
> than a single raw name. `DRAFT_MODE_SECRET` / `REVALIDATE_SECRET_TOKEN` are optional in
> production — when unset they are derived from the service-role key (see
> `apps/nextblock/lib/app-secrets.ts`). See [12-VERCEL-DEPLOYMENT.md](./12-VERCEL-DEPLOYMENT.md).

Captured by the `/setup` wizard and needed for a complete CMS:

- R2 credentials for media storage. The app builds and serves without them, but
  uploads, image processing, and full-site backups return 500 until R2 is set.
- SMTP credentials for hosted auth email — required to deliver the first admin's
  sign-up confirmation on hosted Supabase.

Optional, per feature:

- Stripe keys for physical-product checkout
- Freemius keys for digital-product checkout and product sync

## Dependency install scripts (`allowScripts`)

Recent npm (11.13+, what Vercel's build image runs) blocks dependency install scripts
(`preinstall` / `install` / `postinstall`) by default. Any package with such a script that
is not listed under `allowScripts` in the **workspace root** `package.json` has its script
silently skipped, and every install ends with:

```txt
npm warn allow-scripts N packages have install scripts not yet covered by allowScripts
```

The root `package.json` therefore carries an explicit policy. Entries are keyed by package
name (`"esbuild": true` — any version) or exact version (`"esbuild@0.28.1": true`); semver
ranges are rejected, `false` denies, and only the root's field is read in a workspace.

| Package | Policy | Why |
| --- | --- | --- |
| `esbuild`, `@swc/core`, `unrs-resolver` | allow | postinstall verifies/installs the platform binary the build tooling uses |
| `sharp` | allow | checks the prebuilt image binary and builds it only when no prebuilt exists (`node install/check.js \|\| npm run build`) |
| `supabase` | allow | the Supabase CLI downloads its binary in postinstall; `npm run db:*` needs it |
| `nx` | allow | its own post-install bookkeeping (no-op in CI) |
| `@parcel/watcher` | deny | only compiles from source when `npm_config_build_from_source=true`; prebuilt binaries arrive as optional deps |
| `less` | deny | its postinstall tries `pnpm exec playwright install` on any non-CI machine; irrelevant and fails here |

Name-only entries were chosen on purpose: a pinned `pkg@1.2.3` re-triggers the warning
(and re-skips the script) on every routine version bump. When you add a dependency with a
native or binary postinstall, add it here **and** in `apps/nextblock/package.json`, which
becomes the root of a standalone `create-nextblock` project. `npm install-scripts ls` (or
`npm approve-scripts --allow-scripts-pending`) lists anything still unreviewed. The
`.npmrc` also sets `fund=false` so the funding notice stays out of build logs.

## Running the Main App

The canonical application is `apps/nextblock`.

Useful targets:

- `nx serve nextblock`
- `nx build nextblock`
- `nx lint nextblock`

The CMS and public site share the same Next.js app, so one dev server covers:

- public pages and posts
- CMS routes
- checkout routes
- webhook routes
- cron routes

## Database and Migration Workflow

The migration source of truth is:

`libs/db/src/supabase/migrations`

Normal contributor workflow:

1. update code and migrations together
2. run `npm run db:migrate:check`
3. run `npm run db:migrate` against the intended Supabase project
4. regenerate db types if the schema changed
5. verify the app routes or server actions against the new shape

Production rule:

- NextBlock now has live data. New production/shared database changes must be
  append-only, forward-only, and non-destructive by default.
- Do not edit migration files that have already been applied to production.
- Add a new forward-only `.sql` file under
  `libs/db/src/supabase/migrations` for each production schema/data change.
- Use `npm run db:migrate:check` before `npm run db:migrate`.
- Migration files are named `GGNNN_<snake_name>.sql` (GG = squash generation, NNN =
  sequence, contiguous). The next number is the highest sequence on disk + 1 in the same
  generation; `db:migrate:check` prints it and fails on any other name shape. See
  [04-DATABASE-AND-AUTH.md](./04-DATABASE-AND-AUTH.md) → "Migration Structure".
- If `db:migrate:check` lists the generation baseline (`02001_baseline_schema.sql` …) as
  pending on an existing database whose history is empty, do not run `db:migrate` yet.
  Run `npm run db:migrate:repair-history:check`, then `npm run db:migrate:repair-history`,
  then check again. The same two commands also handle the other shape — retired 14-digit
  versions "recorded remotely with no local file" beside the pending baseline, meaning the
  database has not crossed the squash: they detect it and offer to switch to the squash
  reconcile. The expected result after either repair is that only new unapplied migrations
  remain.

  > **Windows:** PowerShell strips a bare `--`, so `npm run <script> -- --flag` silently runs
  > the script's default mode (npm warns `Unknown cli config`). Invoke the script directly
  > instead — `node tools/scripts/repair-db-migration-history.js --check --reconcile-squash`,
  > `node apps/nextblock/tools/update.mjs --db-only`. A bare trailing argument is forwarded
  > fine, so `npm run db:migrate:repair-history:revert 02000` works as written.
- Do not use `npm run db:reset`, `npm run sandbox:reset`,
  `npm run db:migrate:fresh`, or `npm run db:push:sandbox` against production.

Fresh local and sandbox rebuilds may still use the reset/bootstrap flow when
the target database is disposable.

The migration-only script:

- loads `.env.local` and `.env`
- links the Supabase CLI to `SUPABASE_PROJECT_ID`
- uses `SUPABASE_DB_PASSWORD`, `POSTGRES_PASSWORD`, `POSTGRES_URL`, or
  `DATABASE_URL` for the database password
- runs `supabase db push` without `--include-all`
- never runs a reset, seed script, function deploy, or config push

The migration set is a squashed baseline (one generation at a time — see
[04-DATABASE-AND-AUTH.md](./04-DATABASE-AND-AUTH.md) → "Migration Structure"). Treat the
baseline files as grouped domains and append every new production change as a new
`GGNNN` migration; never edit the baseline or the catch-up.

## Sandbox Reset Operations

The sandbox automation is code-driven.

`npm run generate:sandbox`:

- reads the migration folder
- concatenates the SQL in lexical order
- writes the generated payload to
  `apps/nextblock/app/api/cron/reset-sandbox/sandboxResetSql.ts`

`npm run sandbox:reset`:

- loads `.env.local`
- refuses to run unless `NEXT_PUBLIC_IS_SANDBOX=true`
- reads `NEXT_PUBLIC_URL` and `CRON_SECRET`
- calls `GET /api/cron/reset-sandbox`

The cron route then:

- returns 404 immediately unless `NEXT_PUBLIC_IS_SANDBOX=true`
- executes the generated reset SQL
- reseeds media assets
- reseeds commerce content
- triggers Freemius sync helpers for sandbox data

## Deployment Notes

The repo currently assumes:

- the app is deployed as a Next.js application
- Supabase remains the database/auth backend
- cron routes are protected with `Authorization: Bearer ${CRON_SECRET}`; `vercel.json`
  on `master` declares none of them (Hobby 1-click installs fail on sub-daily
  schedules), the sandbox's 15-minute reset is a pg_cron job in the sandbox database
  (`npm run sandbox:schedule`, see docs/12), and FX rates refresh from the CMS layout
  without a cron
- package activation and several system workflows require working server-side
  environment variables, not only public client keys

If you are configuring hosted Supabase auth email settings, use:

```bash
npm run configure:supabase-auth
```

## Public Page Performance Budget

Every public route is rendered per request (the CSP nonce and the locale cookie make
the layout dynamic), and Next.js streams the whole page as one burst after the data
arrives, followed by the inline React Server Components payload
(`self.__next_f.push(...)`). That inline script blocks the HTML parser while it is
evaluated, so the already-parsed hero does not paint until it finishes: on the home
page a 214 KB payload cost ~250 ms of blank viewport at 1x CPU and ~800 ms at 4x.
Everything a server component hands to a client component is serialized into it, so
keep these rules when touching the public surface:

- **Only pass a client component what it reads.** `PageClientContent` receives the
  page row with `blocks: []`; the blocks are already rendered as `children`. The
  article route still passes `blocks` because `PostClientContent` derives the read
  time from them.
- **Translations are trimmed per locale.** `app/layout.tsx` passes the `translations`
  table through `lib/i18n/slim-translations.ts` (active locale + `en` fallback, no
  timestamps). A language switch uses `router.refresh()`, which re-runs the layout,
  so the client never needs the other locales.
- **Above-the-fold media gets `priority`.** `BlockRenderer` flags the first top-level
  block and `SectionBlockRenderer` flags hero sections; text renderers forward it so
  the first YouTube embed in that HTML preloads its poster instead of lazy-loading it
  (`components/media/youtube-embed-replace.tsx`). The poster is routinely the LCP
  element.
- **Public reads are cached, and `fetchCache` is off-limits.** `getPageDataBySlug`,
  `getPostDataBySlug`, the translated-slug maps and the bot-protection site key sit
  behind `unstable_cache` (`lib/public-content-cache.ts`: 5 min, the same lifetime as
  the layout's navigation/translations/themes), each wrapped in React `cache()` so
  `generateMetadata` and the page body share one Data Cache hop per request. The
  layout fetches its locale-independent chrome in a single `Promise.all`; on Vercel
  every sequential `unstable_cache` read is a network round trip, and a cold refill
  showed up in Lighthouse as a 633 ms body delay. Draft mode bypasses the cache
  automatically.
- **Keep the first frame cheap for the compositor.** `SectionBlockRenderer` promotes a
  section to its own GPU layer (`transform-gpu`, `preserve-3d`) only when it has a
  background image; every other section is a plain `isolate`. Hero cards must not use
  `backdrop-blur-*` (02011/02012 stripped them): behind them is a smooth gradient, so
  the blur is invisible, yet in Lighthouse's trace the GPU process spent ~390 ms drawing
  the first frame — the gap between the hero being laid out and the first contentful
  paint. The next lever is the 613 KB stylesheet: `lib/custom-block-safelist.ts` forces
  every colour utility (gradient stops alone are ~200 KB) so DB-authored classes work
  without a redeploy; narrowing it is a product decision, not a bug fix.
  Eviction is `revalidatePath('/<slug>')` (implicit route tags, which every writer and
  every Cortex/MCP tool already call) plus `revalidatePublicContent('pages' | 'posts')`
  from the CMS writers, because one page can be served from several paths (any
  homepage variant is also `/`). A direct database edit that revalidates nothing is
  visible within 60 s. Never add `export const fetchCache = 'force-no-store'` to a public
  segment: Next disables `unstable_cache` under it — that single line had switched off
  all layout caching on `/[slug]`, `/article/[slug]` and `/product/[slug]`.
- **Measure before and after.** `npx lighthouse <url> --preset=desktop` (and the
  default mobile run) against a production build; decode the payload size from the
  `__next_f` script and check `observedFirstContentfulPaint` vs `observedFirstPaint`
  in the JSON — a gap there is the parser-blocking symptom above. Locally, start the
  build with `next start apps/nextblock` (the Nx `dist/` copy can be stale from another
  checkout, and `next start` on a stale copy crashes in `setupFsCheck`).

Seeded marketing copy is content, not code: colour-contrast or markup fixes to it are
forward-only data migrations scoped by content signature (see `02006`), never edits
to the baseline seed.

`/robots.txt` is a route handler (`app/robots.txt/route.ts`) that serves
`buildRobotsTxt` — the same function the SEO screen previews — with `force-static` and
an hourly revalidate. It is not an `app/robots.ts` metadata route because Next's
serialiser has no field for the per-rule `other` directives (`Clean-param`, a per-group
`Host`, …) the screen lets operators add; the metadata route dropped them silently.
`lib/seo/robots-txt.test.ts` pins both facts against Next's real serialiser.

## Bilingual Content Rule

The public site ships in English and French; only `/cms` is English-only. Any migration
that adds or rewrites content on a page, post or product must carry the French equivalent
in the same file: same `translation_group_id`, same block sequence and markup, translated
text nodes and attribute copy (`alt`, `title`, `aria-label`), and links pointing at the
French slugs (`/accueil`, `/boutique`, `/article/<fr-slug>`, `…-license-fr`). A French row
that does not exist yet is inserted, guarded by translation group + language so a re-run
or an already-translated install inserts nothing; `posts_id_seq` / `blocks_id_seq` are
re-synced first because the seed inserts explicit ids.

`02008_home_fr_parity.sql` and `02009_fr_cortex_posts.sql` are the reference: the English
block JSON was tokenised into tags and text, every text node translated through a
text-to-text map, and the markup regenerated untouched, so the French page renders the
exact same components. Audit parity with the anon REST API (`pages`, `posts`, `products`
grouped by `translation_group_id`, then `blocks` per row) before shipping a content
migration — that is how the missing French Cortex posts were found.

## Public UI Copy and Accessibility

UI strings live in `public.translations` (`key`, `{ "en": …, "fr": … }`) and reach components
through `useTranslations()`. Two rules keep raw keys and English out of French pages:

- **`t(key)` answers an unseeded key with the key itself**, so `t('x') || 'Fallback'` never
  falls back. In the app use `useLabel()` (`lib/i18n/use-label.ts`):
  `label('pagination.next', 'Next', 'Suivant')`. In `libs/ecommerce` use
  `translateOrFallback(t, key, fallback)`. In `libs/ui`, which must also work without a
  provider, use `useOptionalTranslations()`.
- **Every new key is seeded in English and French by a forward migration.** `02015` is the
  model: French corrections guarded by the exact seeded text, `ON CONFLICT DO NOTHING` for
  new keys, verified idempotent. Write `…`, never three dots, in loading copy.

Shop prices go through `usePriceFormatter()` (`libs/ecommerce/src/lib/use-price-formatter.ts`),
which binds `formatPrice` to the visitor's locale; the bare helper defaults to `en-US`.

The public surface was audited against Vercel's Web Interface Guidelines in September 2026.
The full `file:line` report, what was fixed and what is still open, is in
`tools/audits/web-interface-guidelines-2026-09-17.md`. The parts that are easy to undo by
accident:

- `libs/ui/src/styles/animations.css` holds the one global `prefers-reduced-motion` rule.
  Motion driven from JavaScript (slider autoplay, `scrollIntoView({ behavior: 'smooth' })`)
  must check the media query itself: an explicit `behavior` beats the stylesheet.
- Tailwind 4: write `max-h-(--some-var)`, not the v3 `max-h-[--some-var]` (it compiles to
  invalid CSS and silently does nothing), and `outline-hidden`, not `outline-none` (which no
  longer leaves a transparent outline for forced-colors mode).
- Anything that replaces a form with a confirmation moves focus to it (`tabIndex={-1}` +
  `role="status"`), and a server action that can fail echoes the typed `values` back:
  React 19 resets an uncontrolled form when its action settles.
- The honeypot field name lives in `lib/botProtection/fields.ts` and is deliberately not
  email-like: browser autofill filled the old `verification_secondary_email`, and the server
  then discarded a real visitor's sign-up or message with a fake success.
- Grid pagination is real links (`?page=N`, `components/blocks/GridPagination.tsx`). The page
  routes read the parameter and put it in a request-scoped store
  (`lib/blocks/requested-page.ts`, React `cache`), and the posts and product grid server
  components render that page, so page 2 works with JavaScript off and has its own URL. The
  routes were already per-request (locale cookie), so this did not change how they render.
  With JavaScript the client cancels the link and swaps the items in place
  (`hooks/usePageParam.ts` keeps Back/Forward working). A page past the end falls back to 1.
- Button hover and pressed states (`libs/ui/src/lib/button.tsx`) move the surface away from
  its own text colour: `color-mix` (12 % on hover, 20 % pressed) toward the button text with
  its lightness inverted, `oklch(from hsl(var(--surface-foreground)) calc(1 - l) 0 0)`. Light
  text darkens the surface, dark text lightens it, so contrast rises in every theme; the old
  `/90` fade lowered it in whichever theme had the darker page (dark theme: 4.9 → 4.1).
  Measured in Chrome on the seeded palettes: dark 4.9 → 5.4, vibrant 4.9 → 6.5; light
  computes to 6.4 → 7.6. Browsers without relative colour syntax keep the rest colour on
  hover. Spell such class names out in full: Tailwind only generates a utility it finds
  verbatim in a source file, never one assembled from two strings. `02016` deepens the four
  seeded tokens that failed AA at rest (dark focus ring, vibrant primary and destructive, light
  destructive), guarded by the seeded values so a recoloured theme is left alone;
  `libs/ui/src/styles/theme.css` carries the same values.
- The header logo's `alt` is the site title on purpose: the logo is the home link, and
  `media` has no alt column (`description` defaults to the upload's file name).
- `products.short_description` renders through `ShortDescription`
  (`libs/ecommerce/src/lib/components/ShortDescription.tsx`) everywhere: HTML when the row
  contains markup (older rows carry embeds), otherwise escaped text with line breaks.

## Current Repo Notes

Two repo facts are worth keeping in mind while contributing:

- the workspace import path is `@nextblock-cms/ecommerce`, but the current
  `libs/ecommerce/package.json` name is still `@nextblock-cms/ecom`
- a standalone `npx nx run ecommerce:build --skip-nx-cache` check is currently
  not green, so use app-level validation and targeted tracing until that build
  target is repaired
