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
npm run dev              # = npx nx serve nextblock; then open http://localhost:4200/setup
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

`npm run dev` (the root alias for `npx nx serve nextblock`) serves the app at
**http://localhost:4200** (the target runs `next dev --port 4200`). Run it from the
repo root: `npm run dev` inside `apps/nextblock` is the standalone scaffold's plain
`next dev` (port 3000) and does not read the root `.env.local`. The wizard's last
step creates the first administrator with the email already confirmed
(`lib/setup/provision-admin.ts`), and the `handle_new_user` database trigger
promotes that first account to **ADMIN**. You are signed in and land on the
Cortex AI welcome offer (`/cms/welcome`), one click away from `/cms/dashboard`.
Every later sign-up gets the `USER` role.

## Common Commands

### App and library workflows

- `npm run dev` (= `npx nx serve nextblock`): start the main app in development
- `npm run lint`: run Nx lint targets across the workspace
- `npm run nx:lint:nextblock`: lint the main app only
- `npm run nx:lint:create-nextblock`: lint the CLI app only
- `npm run all-builds`: build workspace projects except the template output

### Database workflows

- `npm run db:link`: link the Supabase CLI to the target project
- `npm run db:migrate:check`: preview pending remote migrations without
  applying them; it also refuses a badly named file and a forward migration that
  creates a table, view or sequence without granting on it (docs/04 → "Row Level
  Security Patterns")
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
  images, and deploys the migration-ingest function. The config push turns public
  sign-ups back on (`config.toml` keeps `enable_signup = true` for local dev): turn
  "Allow new users to sign up" off again on the sandbox project afterwards (the reset
  logs an error while it is on; see "Sandbox Reset Operations")
- `npm run db:reset`: reset the local/linked Supabase database from the db
  workdir
- `npm run db:types`: regenerate typed Supabase definitions
- `npm run db:backup`
- `npm run db:restore`
- `npm run deploy:supabase`

### Sandbox and automation workflows

- `npm run generate:sandbox`: regenerate the checked-in sandbox reset payload
- `npm run sandbox:reset`: call the app's sandbox reset cron route locally
- `npm run stripe`: forward the store's six Stripe webhook events to the local webhook route
  (needs the Stripe CLI; it passes `--events`, which current CLI versions require)
- `npm run affiliates:schedule-payouts -- https://<site>`: install the daily pg_cron job that
  calls the affiliate payout route (`status`, `remove`, `print-sql`; docs/15 → "Scheduling");
  also an app script (`apps/nextblock/tools/schedule-affiliate-payouts.js`), so standalone
  projects have it

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
  by the `/setup` wizard. `CRON_SECRET` also protects the affiliate payout route
  (`/api/affiliates/cron/payouts`), which refuses every call (503) while it is unset or shorter
  than 16 characters (the sandbox reset refuses calls while it is unset; the FX sync stays open)

> **Supabase key aliases.** The names above are the local-dev canon, but the app also
> accepts the *new-style* names the hosted/Vercel Supabase Marketplace integration
> injects: `SUPABASE_URL` (non-prefixed), `SUPABASE_PUBLISHABLE_KEY` /
> `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (anon-equivalent), and `SUPABASE_SECRET_KEY`
> (service-role-equivalent). Resolution lives in `apps/nextblock/lib/setup/env-status.ts`
> (`resolveSupabaseUrl` / `resolveSupabaseAnonKey`) and, for the secret key, the
> server-only `apps/nextblock/lib/setup/service-key.ts` (`resolveSupabaseServiceKey`; client
> modules import env-status, so the secret is never named there, see docs/04 →
> "Service-role boundary"); read
> Supabase env through those (or the same inline alias chain in published libs) rather
> than a single raw name. `DRAFT_MODE_SECRET` / `REVALIDATE_SECRET_TOKEN` are optional in
> production — when unset they are derived from the service-role key (see
> `apps/nextblock/lib/app-secrets.ts`). See [12-VERCEL-DEPLOYMENT.md](./12-VERCEL-DEPLOYMENT.md).

Captured by the `/setup` wizard and needed for a complete CMS:

- R2 credentials for media storage. The app builds and serves without them, but
  uploads, image processing, and full-site backups return 500 until R2 is set. Full-site
  backup/restore also needs `pg_dump`/`psql` on the server process's PATH and
  `POSTGRES_URL`/`DATABASE_URL` (see docs/04 → "Full Site Backup and Restore").
- SMTP credentials for hosted auth email — required to deliver the first admin's
  sign-up confirmation on hosted Supabase.

Optional, per feature:

- Stripe keys for physical-product checkout, entered under CMS → Payments (stored values win);
  the env fallbacks the code reads are `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
  and `STRIPE_WEBHOOK_SECRET`. The secret key also pays affiliate partners (and is all payouts
  need), so a Freemius-only store that runs the partner program needs it too
- Freemius keys for digital-product checkout and product sync
- Stripe Connect (Express) on the platform account for automated affiliate payouts (docs/15;
  CMS → Affiliates → Stripe payouts tests the setup)
- PayPal Payouts for affiliate commissions routed to PayPal (02037, docs/15 → "Paying partners with
  PayPal"): the credentials saved under CMS → Affiliates → PayPal payouts win; the env fallbacks are
  `PAYPAL_CLIENT_ID` / `PAYPAL_SECRET_KEY` (sandbox), `PAYPAL_LIVE_CLIENT_ID` /
  `PAYPAL_LIVE_SECRET_KEY` (live) and `PAYPAL_ENVIRONMENT` (`live`, else sandbox). Server-only: never
  prefix them with `NEXT_PUBLIC_`. The public sandbox never reads them
- `FREEMIUS_ECOMMERCE_SANDBOX_KEY`, `FREEMIUS_AI_SANDBOX_KEY`, `FREEMIUS_AFFILIATES_SANDBOX_KEY`
  — the public sandbox only: its reset activates Commerce Pro, Cortex AI and Affiliates with them

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

## Dependency versions: what is held back, and why

Policy: every dependency sits at its npm `latest` unless the packages it has to work with
cannot take that version. The last full sweep (2026-09-21) moved 149 of 155 outdated
packages to latest and took `npm audit` from 104 findings (1 critical) to 0. Held
packages and temporary overrides are listed here because `package.json` cannot carry
comments. Re-check each row on the next sweep.

**Held below latest**

| Package | Held at | Latest | Why | Move when |
| :-- | :-- | :-- | :-- | :-- |
| `eslint`, `@eslint/js` | 9.39.5 (final 9.x) | 10.x | `eslint-plugin-react` 7.37.5, `eslint-plugin-import` 2.32.0 and `eslint-plugin-jsx-a11y` 6.10.2 (all at latest, loaded by Nx's `flat/react` and by `eslint-config-next`) exclude ESLint 10, and `eslint-plugin-react` crashes on it (it calls the removed `context.getFilename()`). Its maintainer asks users not to force it (jsx-eslint/eslint-plugin-react#3977). A peer-override plus `@eslint/compat` shim path works but was rejected for that reason. | All three plugins publish an ESLint 10 peer range. Then fix the ~34 findings from `@eslint/js` 10's new recommended rules (`no-useless-assignment`, `preserve-caught-error`). |
| `typescript` | `~6.0.3` | 7.0.x | TypeScript 7.0 is the native compiler and ships no JS compiler API (`require('typescript')` exports only the version), which typescript-eslint, vite-plugin-dts, Nx and `@swc-node/register` all need. typescript-eslint also caps its peer at `<6.1.0`, hence the tilde. | TypeScript 7.1 ships its API and typescript-eslint, `@nx/js` and `unplugin-dts` adopt it. |
| `@types/node` | `^22.20.4` | 26.x | Policy, not a block: the types must describe the oldest runtime we deploy (Docker `node:22-alpine`, Vercel 22/24). Newer types would type-check APIs that crash in production. | Docker and Vercel move to a newer Node major. |

**Temporary overrides in the root `package.json`**

| Override | Why | Remove when |
| :-- | :-- | :-- |
| `"@nx/vitest": { "vitest": "$vitest" }` | `@nx/vitest` 23.2.1 peers `vitest ^3 \|\| ^4`. Nx has merged the `^5` range (nrwl/nx#37055) but not published it. We use the plugin only to infer the `test` target, and the suite passes on Vitest 5. | `npm view @nx/vitest peerDependencies.vitest` includes `^5`. |
| `"smol-toml": "^1.8.0"` | Nx 23.2.1 pins 1.6.1, which has a high advisory (GHSA-7w5x-hrqm-74c2). | Nx pins 1.7.1 or later (the 23.3 line). |
| `esbuild`, `postcss` | Must equal the direct devDependency spec, or npm fails with `EOVERRIDE`. `next` still pins `postcss` 8.5.23 exactly. | Bump together with the devDependency. |
| `qs`, `fast-uri`, `js-yaml`, `body-parser`, `svgo@3`, `svgo@4`, `brace-expansion@*`, `glob`, `form-data`, `tmp`, `undici`, `@noble/hashes` | Security floors for transitive packages, each kept inside the major its consumers expect (`fast-uri` 3 and `js-yaml` 4, not their newer majors). | When `npm audit` stays clean without them. |

These overrides match nothing since Nx 23 dropped its webpack tree, and are kept as
guards against a vulnerable version coming back: `node-domexception`, `keygrip`,
`http-proxy-middleware`, `adm-zip`, `immutable`, `shell-quote`, `webpack-dev-server`. (`uuid`
is now a declared root dependency, and its override equals that spec.) For
the same reason the `@parcel/watcher` and `less` entries in `allowScripts` are currently
inert.

**Node.js floor.** 22.12. `supabase-js` 2.110+, AI SDK 7 and `@ai-sdk/*` need Node 22;
Vite 8, Vitest 5 and the `create-nextblock` CLI (`commander` 15, `execa` 10, `chalk` 6)
need 22.12, which the CLI declares in `engines`.

**How to run the next sweep.** `npm outdated`, then check each major's peer ranges and
migration guide before bumping. A plain `npm install` deadlocks on tightly pinned families
(`nx`/`@nx/*`, `@tiptap/*`, `typescript-eslint`/`@typescript-eslint/*`, `vitest`/`@vitest/*`,
`eslint`/`@eslint/*`): delete their `node_modules/...` entries from `package-lock.json`,
set the specs, and run `npm install`. No `--legacy-peer-deps` is needed. Validate the lock
against Docker's npm in a temp copy with `npx -y npm@10.9.8 ci --dry-run`. Then realign
`apps/nextblock/package.json` and the published libs' ranges (`libs/cortex`,
`libs/ecommerce`, and the hard-coded deps in `libs/utils/vite.config.mts`'s `afterBuild`) to
the root specs. Scaffolds install exactly what those manifests declare.

Raising a root override that scaffolds also get (`postcss`, `qs`, `uuid`, `glob`) takes two
more edits. Set the same value in `FALLBACK_OVERRIDES`
(`apps/create-nextblock/bin/lib/fallback-overrides.js`), which the published CLI writes into new
projects. Then, in `MANAGED_OVERRIDES` (`apps/nextblock/tools/lib/managed-overrides.mjs`), set
`current` to it and add the old value to `previous`, so `npm run update` moves existing projects
(docs/13). Append the new value to `SHIPPED` in `fallback-overrides.test.js`, which fails until
all four agree.

Finish with `npx nx build nextblock`, not just the type-check. The monorepo installs from the
ROOT `package.json`, so a package the app imports but only the app manifest declares resolves
solely as some other package's hoisted transitive. The app imported `uuid` that way, through
Nx 22's webpack tree. Nx 23 dropped that tree, and only Turbopack noticed ("Module not found:
Can't resolve 'uuid'"); the `@types/uuid` stub kept `tsc` green. `uuid` is now declared at the
root.

## Running the Main App

The canonical application is `apps/nextblock`.

Useful targets, all plain `nx:run-commands` in `apps/nextblock/project.json`:

| Target | Runs | Notes |
| :-- | :-- | :-- |
| `nx serve nextblock` | `next dev --port 4200` in `apps/nextblock` | `--configuration=production` runs `next start --port 4200` instead. |
| `nx build nextblock` | `tools/build-migrate.mjs`, then `nx run nextblock:build-base` (`next build` in `apps/nextblock`) | Output is `apps/nextblock/.next`. Other arguments reach both commands, so `nx build nextblock --debug` or `--webpack` reaches `next build`; the hook ignores them. Nx reads Vercel's `--prod` as `--configuration=production`, which the build targets do not define, so it does nothing. |
| `nx start nextblock` | `next start --port 4200` in `apps/nextblock` | Serves the last build. |
| `nx lint nextblock` | `eslint apps/nextblock --config apps/nextblock/eslint.config.mjs` from the repo root | The app config's paths are relative to the repo root. |

Nothing in the workspace uses an Nx executor that Nx 24 removes (`@nx/next:build`,
`@nx/next:server`, `@nx/vite:build`, `@nx/eslint:lint`) or the deprecated `nxViteTsPaths` /
`nxCopyAssetsPlugin` Vite plugins. The libraries build with the `vite build` target that
`@nx/vite/plugin` infers (docs/06 → "How the libraries build"). `nx build nextblock` no longer
writes `dist/apps/nextblock`: nothing read it, and the old `nx start nextblock` failed because
it ran `next start` there, where no `.next` exists.

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

The cron route then, in this order:

- returns 404 immediately unless `NEXT_PUBLIC_IS_SANDBOX=true`, 401 without the cron secret, and
  500 without its env (it requires the `R2_*` env)
- starts asking GoTrue (`/auth/v1/settings`, with the publishable key) whether public sign-ups are
  off, alongside the reset; while they are on it logs `[Sandbox Reset] GoTrue accepts public
  sign-ups` as an error and adds a `warnings` entry to its JSON. It never fails or delays the reset
  beyond 5 s
- checks that uploads go to the bucket and endpoint it empties (`getStorageBackend()` is `s3`,
  `getStorageBucket()` is `R2_BUCKET_NAME`, and `R2_S3_ENDPOINT` / `R2_S3_PUBLIC_ENDPOINT`, when
  set, share the origin of `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`), with the same
  error-and-warning alarm otherwise: one `warnings` entry for a backend or bucket mismatch, and one
  per endpoint variable whose origin differs
- empties the R2 bucket, so nothing a visitor uploaded outlives the run, uploads the seed assets,
  and executes the generated reset SQL (Step A deletes every auth user but the two preserved ids)
- restores the demo admin right away: re-creates `demo@nextblock.dev` when missing, otherwise
  re-asserts its published password and deletes every second factor on it (`auth.users` rows and
  `auth.mfa_factors` survive the SQL, and the demo session is public). A failure is logged, never
  thrown, and nothing that runs later can skip this step
- writes the core media rows
- with `FREEMIUS_ECOMMERCE_SANDBOX_KEY`: activates Commerce Pro, syncs the Freemius products, then
  dresses the catalog, shop pages and categories (an error here ends the run with a 500, except in
  the Affiliates product dressing, which runs in its own transaction and only logs)
- activates Cortex AI when its sandbox key is set, then seeds the store data (branding, the admin
  profile, demo orders)
- with `FREEMIUS_AFFILIATES_SANDBOX_KEY`: activates the package and seeds the demo partners
  (`partner@nextblock.dev` at `/partners/studio-nova`, and Atelier Boréal) in their own transaction
  after the reset committed (docs/15 → "Sandbox demo")

The app refuses every sign-up on the sandbox (docs/15 → "What a visitor can and cannot do
there"), but GoTrue itself still accepts one from anyone holding the publishable key and mails the
address they typed. On the sandbox's Supabase project, keep:

- **Authentication → Sign In / Providers → "Allow new users to sign up" off.** The reset's
  `auth.admin.createUser` works either way. `npm run db:push:sandbox` turns it back on.
- **Auth email on Supabase's built-in sender** (it delivers only to the organization's members),
  not the deployment's SMTP account, so an email change or recovery a visitor asks GoTrue for
  reaches no one else.
- **Its own SMTP account, or none.** On the sandbox `sendEmail` delivers only to
  `SANDBOX_CONTACT_EMAIL` and the product feedback inbox, so its `SMTP_*` env never needs the
  production login.
- **Its own stock-photo keys, or none.** The sandbox cannot save stock-photo keys in the CMS, so
  `PEXELS_API_KEY` and `UNSPLASH_ACCESS_KEY` in its env serve every visitor's Cortex runs. The
  admin agent's photo search has no per-request cap, the partner copilot runs at most 3 lookups a
  request, and each Cortex block save pings up to 20 Unsplash download triggers. Use dedicated
  sandbox apps whose rate limits you can afford to see exhausted, never the production keys.
- **`OPENROUTER_API_KEY` only if you accept the free-model traffic.** A visitor without their own
  key falls back to it, locked to free models for text and alt text.

## Deployment Notes

The repo currently assumes:

- the app is deployed as a Next.js application
- Supabase remains the database/auth backend
- cron routes are protected with `Authorization: Bearer ${CRON_SECRET}`, checked in constant
  time by `isCronRequestAuthorized()` (`lib/cron/cron-secret.ts`: SHA-256 of both sides and
  `timingSafeEqual`, never `===` on the header): `/api/cron/reset-sandbox` fails closed without
  the secret, `/api/cron/sync-currencies` stays open without it, and
  `/api/affiliates/cron/payouts` keeps its own 16-character rule; `vercel.json`
  on `master` declares none of them (Hobby 1-click installs fail on sub-daily
  schedules), the sandbox's 15-minute reset is a pg_cron job in the sandbox database
  (`npm run sandbox:schedule`, see docs/12), FX rates refresh from the CMS layout
  without a cron, and affiliate payouts run from the CMS and partner-portal layouts in
  `after()`, from `/api/affiliates/cron/payouts`, or from a pg_cron job
  (`npm run affiliates:schedule-payouts`, docs/15)
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
  so the client never needs the other locales. The layout reads only the site-wide rows (never
  `affiliates.*`, see docs/15 → "i18n"), in pages of 1000: PostgREST returns at most `max_rows`
  rows per request (1000 in `libs/db/src/supabase/config.toml` and on hosted Supabase) and drops
  the rest without an error. So every read of many `translations` rows goes through
  `readAllTranslationRows` (`lib/i18n/translation-pages.ts`, all or nothing), and
  `tools/scripts/translations-pagination.test.ts` fails on one that does not. A project that
  lowers `max_rows` below 1000 must lower `TRANSLATIONS_PAGE_SIZE` to match; the guard compares
  it with `config.toml`. CMS → Extra translations reads the same way, and its CSV import refuses
  to run when the existing rows cannot be read in full.
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
to the baseline seed. When an operator may have re-saved the block (the CMS editor
re-serialises the HTML and drops the space after a `<br>`), match it by its visible text
compared without spaces instead, as `02039` does for the home hero H1.

The home hero H1 (EN `home`, FR `accueil`, since `02039`) is a text block holding
`<div class='@container'><h1 …>`. Its size is `clamp(2.5rem, 8.5cqi, 3.75rem)` of its column,
behind a container variant (`@min-[1px]:`) over the old `text-5xl md:text-6xl`, so a stylesheet
built before the migration, or Safari 15, keeps the old sizes. It breaks the same way in every
column about 470px and wider (three lines). Narrower columns stay at 2.5rem, and
`<br class='@md:hidden' />` stacks the two sentences in columns under 28rem (four lines on
phones and two-column tablets). `mb-0` keeps the gap to the copy below at 16px, because the
container wrapper stops the H1's margin collapsing. The highlighted word is an inline-block (the
gradient pill), and CSS allows a line break after an inline-block even right before punctuation,
so the pill and the period after it share one `whitespace-nowrap` span. Keep a new line to three
lines in the 668px desktop column (measure it in the browser; the French second sentence fits in
about 29 characters), and use `&nbsp;` to keep short words with the next word ("The&nbsp;AI")
and the last two words together.

`/robots.txt` is a route handler (`app/robots.txt/route.ts`) that serves
`buildRobotsTxt` — the same function the SEO screen previews — with `force-static` and
an hourly revalidate. It is not an `app/robots.ts` metadata route because Next's
serialiser has no field for the per-rule `other` directives (`Clean-param`, a per-group
`Host`, …) the screen lets operators add; the metadata route dropped them silently.
`lib/seo/robots-txt.test.ts` pins both facts against Next's real serialiser.

## Partner referrals in `proxy.ts`

The proxy stamps the Affiliates referral cookie (`nb_affiliate_ref`, an httpOnly lowercase
handle) on a document navigation to `/partners/<handle>`, or to any page outside `/cms`, `/api`,
`/portal` and `/_next` with `?ref=<handle>`. The rules that matter when you touch the proxy
(the full list is in docs/15 → "Attribution"):

- **Only GET document navigations count.** RSC fetches, router prefetches, speculative loads and
  bots never set the cookie, so an in-app `<Link>` to a storefront sets nothing; the signed
  storefront token covers attribution there, including a product the shopper opens from the
  storefront (or picks options for) before adding it. Storefront links use `prefetch={false}`.
- **The decision is pure and taken once**, before the first response branch:
  `decideAffiliateReferral()` in `lib/affiliates/referral-cookie.ts`, which imports nothing.
  The proxy may not import server-only code, `@nextblock-cms/db/server` or a library barrel, so
  that file mirrors the lib's handle pattern, reserved handles and cookie name, and
  `referral-cookie.test.ts` fails when a copy drifts.
- **Three responses carry it**, through `withAffiliateReferral`: the final page response, the
  managed 301/302 redirect and the customer-name redirect to `/profile`. Never the intermediate
  response the Supabase cookie adapter rebuilds, never an auth gate. Each of them also gets
  `Cache-Control: private, no-store`, overriding the public caching the proxy gives HTML and
  301s, so a shared cache never stores one visitor's `Set-Cookie`.
- **The lifetime is the partner tier's `cookie_duration_days`**, read through the anon RPC
  `get_affiliate_referral_window` on the memoised plain anon client (no visitor JWT, 1.5 s
  abort) and cached per handle (5 minutes, 60 s for "no partner", 15 s for a failed lookup,
  which falls back to 30 days). A missing schema counts as "no partner".
- **A new cookie counts one click** with `record_affiliate_click` in `after()`, off the
  visitor's critical path. The visitor hash is a daily SHA-256 of the masked IP and the user
  agent; no IP is stored.
- **Consent wins.** A visitor whose consent cookie says `marketing: false` gets no cookie, and
  an existing one expires on their next page view.
- **It fails open.** Every step is wrapped; a broken referral never costs a page view.

`proxy.test.ts` drives `proxy()` end to end with mocked clients for these cases, and pins
`'/cms/affiliates': ['ADMIN']` in `cmsRoutePermissions`.

Two more Affiliates rules live in the proxy:

- **`/partenaires` renders in French.** The proxy pins the forwarded `X-User-Locale` to the
  active French code (as the languages table stores it, `fr-CA` for example) on exactly that
  path while French is an active language; the language cookie keeps the visitor's choice. The
  path comes from the import-free `lib/affiliates/partners-paths.ts`; `proxy.test.ts` pins the
  import list and covers the pinned, French-inactive and `/partners` cases.
- **The request path and query are forwarded.** Besides `x-nextblock-path`, the proxy sets
  `x-nextblock-search` (the request's query string), both overwritten on every request the proxy
  handles, so a client cannot plant either. The partner portal layout builds its sign-in return address from
  them (`buildAffiliatePortalReturnPath`, kept inside `/portal/retailer`).

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

The language switcher looks a path up as a CMS document only for `/<slug>`, `/article/<slug>`
and `/product/<slug>` (`contentLookupForPath` in `components/language-switcher-path.ts`); every
other code route (storefronts, the partner portal, checkout) refreshes in place. A code route
with its own address per language declares it with `CurrentContentSetter localePaths` (the
`/partners` landing page does, for `/partenaires`), and `CurrentContent.localePaths` wins over
the slug lookup.

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
