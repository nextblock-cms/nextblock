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
  baseline repair for an existing database whose schema is already present
- `npm run db:migrate:repair-history`: mark historical baseline migrations as
  applied without running their SQL
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
  then check again. If instead it shows retired 14-digit versions "recorded remotely with
  no local file" beside the pending baseline, the database has not crossed the squash:
  run `npm run db:migrate:repair-history:check -- --reconcile-squash`, then the same without
  `:check`. The expected result after either repair is that only new unapplied migrations remain.
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
- cron routes are protected with `Authorization: Bearer ${CRON_SECRET}`
- package activation and several system workflows require working server-side
  environment variables, not only public client keys

If you are configuring hosted Supabase auth email settings, use:

```bash
npm run configure:supabase-auth
```

## Current Repo Notes

Two repo facts are worth keeping in mind while contributing:

- the workspace import path is `@nextblock-cms/ecommerce`, but the current
  `libs/ecommerce/package.json` name is still `@nextblock-cms/ecom`
- a standalone `npx nx run ecommerce:build --skip-nx-cache` check is currently
  not green, so use app-level validation and targeted tracing until that build
  target is repaired
