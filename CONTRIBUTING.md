# Contributing to NextBlock

Thanks for helping build NextBlock. This file covers what you need to get a
working checkout and the handful of repo-specific rules that are easy to trip
over. The deeper reference lives in [`docs/`](./docs/README.md) —
[docs/05-DEVELOPER-GUIDE.md](./docs/05-DEVELOPER-GUIDE.md) is the one to read
first.

By participating you agree to abide by our
[Code of Conduct](./CODE_OF_CONDUCT.md). Security issues go through
[SECURITY.md](./SECURITY.md), **not** the public issue tracker.

## What this repository is

NextBlock is an Nx monorepo. A single Next.js 16 app serves both the public
website and the authenticated CMS; the rest is shared libraries and a
scaffolding CLI.

| Path | What it is |
| :--- | :--------- |
| `apps/nextblock` | The canonical application — public site, CMS (`app/cms/*`), API/cron routes |
| `apps/create-nextblock` | The `create-nextblock` CLI and the template sync pipeline |
| `libs/db` | Supabase clients, generated types, and the migration tree |
| `libs/editor` | Reusable Tiptap editor |
| `libs/ecommerce` | Premium commerce package |
| `libs/cortex` | Premium Cortex AI package |
| `libs/ui`, `libs/utils` | Shared primitives, helpers, Zod schemas |

Cross-package imports use `@nextblock-cms/*` aliases resolved by
`tsconfig.base.json`.

### How to build and run it (the Nx bit)

**The Next.js app is at `apps/nextblock`, not the repo root.** A bare `next build`
at the root fails with *"Couldn't find any `pages` or `app` directory"* — there is
no Next app there to find. Everything goes through Nx, which resolves the
workspace libraries via the `tsconfig.base.json` path aliases.

The root scripts delegate to Nx, so the usual commands do the obvious thing:

| Command | Runs | Notes |
| :------ | :--- | :---- |
| `npm run dev` | `nx serve nextblock` | http://localhost:4200 |
| `npm run build` | `nx build nextblock --prod` | identical to what Vercel runs |
| `npm run start` | `nx start nextblock` | serves a production build |

`npm run build` deliberately mirrors `vercel.json`'s `buildCommand` **character
for character**, so a local build reproduces the deploy build. If a deploy fails
and a local build passes, the difference is environment, not command. (`--prod`
does nothing — Nx reads it as `--configuration=production`, which the build
targets do not define, and `next build` always builds for production — but it is
kept so the two stay literally identical.)

> **⚠️ `npm run build` can write to your database.** The Nx build target runs
> `tools/build-migrate.mjs` first, and that hook loads `.env.local` **before** it
> evaluates its gate — so if your `.env.local` contains `NEXTBLOCK_BUILD_MIGRATE=1`
> (the `/setup` wizard and the Docker bootstrap both write it), a local build applies
> pending migrations to whatever database that file points at. Run
> `npm run db:migrate:check` first if you are not certain what is pending, and never
> point `.env.local` at a shared or production database while building locally.

`nx build nextblock` is a two-step `run-commands` target: it runs
`tools/build-migrate.mjs` first, then the real Next build. That ordering is why
build-time migrations work on Vercel — and why the hook must be wired into the
**Nx target**, not the npm `prebuild` script, since Nx does not fire npm
lifecycle hooks.

> **Deploying to Vercel?** Leave the project's **Root Directory unset** (the repo
> root). The build command already targets the app, and the app imports workspace
> libraries one level up — a custom Root Directory would hide them, and Vercel
> forbids `..` above a custom root. See
> [docs/12-VERCEL-DEPLOYMENT.md](./docs/12-VERCEL-DEPLOYMENT.md).

## Getting set up

**Prerequisites:** Node.js 22.12 or newer (Vitest 5, Vite 8 and the CLI require it),
npm 10+, and a Supabase project. Git.

```bash
git clone https://github.com/nextblock-cms/nextblock.git
cd nextblock
npm install
npm run setup          # prints the next steps — it asks nothing
npm run dev            # then open http://localhost:4200/setup
```

Configuration happens in the browser, not the terminal: the **First-Boot Setup Wizard**
at `/setup` connects Supabase, applies the schema, configures storage and email, and
creates the first administrator. A fresh instance redirects every route there until an
admin exists. (`npm run setup` is informational only — it writes no files and prompts
for nothing.)

**Prefer no cloud accounts?** `npm run docker:setup` boots the entire stack
locally — Postgres, GoTrue, PostgREST, Kong, MinIO, and the app — and applies
migrations automatically. See
[docs/11-SELF-HOSTED-DOCKER.md](./docs/11-SELF-HOSTED-DOCKER.md).

## Everyday commands

```bash
npm run dev                     # dev server (= npx nx serve nextblock)
npx nx build nextblock          # production build
npm run lint                    # lint the workspace
npm run nx:lint:nextblock       # lint just the app
npx vitest run                  # run all tests once
npx vitest run path/to/file.test.ts   # a single test file
npm run lib-builds              # build the publishable libs
```

Single tests run through Vitest directly, not Nx. There is no root `test` npm
script.

Some subsystems have focused verification scripts that are faster and more
targeted than the full suite — prefer them when you touch those areas:

```bash
npm run verify:cortex-ai-routing
npm run verify:editor-block-schema
```

## Rules that are easy to get wrong

These are the ones that cause real damage or wasted work. Please read them.

### 1. Migrations are append-only

NextBlock runs against live Supabase data. **Never edit, reorder, squash, or
delete a migration file that may already have been applied.** Add a new
forward-only `.sql` file under `libs/db/src/supabase/migrations`.

```bash
npm run db:migrate:check   # ALWAYS run this first — it is read-only by construction
npm run db:migrate         # apply pending migrations
npm run db:types           # regenerate Supabase types
```

Do not run `db:reset`, `sandbox:reset`, `db:push:sandbox`, or
`db:migrate:fresh` against a shared or production database.

**Do not trust any hardcoded "the next migration is N" you find in docs.** List
the folder and take the number after the highest file on disk, then confirm it
is free — `npm run db:migrate:check` flags versions recorded remotely with no
local file. Supabase matches history **by version only, never by content**, so a
file reusing a recorded version is skipped in total silence. If your new
migration doesn't appear in the pending list, renumber it.

Read [AGENTS.md](./AGENTS.md) and
[docs/04-DATABASE-AND-AUTH.md](./docs/04-DATABASE-AND-AUTH.md) before touching
migrations.

### 2. After a schema or seed change, regenerate all three derived artifacts

```bash
npm run db:types                     # Supabase TypeScript types
npm run generate:migrations-bundle   # the /setup wizard's serverless fallback
npm run generate:sandbox             # the sandbox reset payload
```

The last two generators fail **silently by omission** — they emit no error when they
skip a migration. The bundle once sat three
migrations behind, which would have left a serverless `/setup` applying an
incomplete schema. Regenerate all three, every time.

### 3. The template is generated — never hand-edit it

Everything under `apps/create-nextblock/templates/nextblock-template/**`
(including its `docs/` copy) is produced by:

```bash
npm run sync:create-nextblock
```

Make your change in `apps/nextblock`, `libs/*`, or root `docs/`, then run the
sync to propagate it. Edits made directly to the template are overwritten on the
next sync.

### 4. Pick the right Supabase client

From `libs/db/src/server.ts`:

- `createClient()` — request-scoped, cookie auth
- `getSsgSupabaseClient()` — public, static-ish reads
- `getServiceRoleSupabaseClient()` — admin/system work only

### 5. Read Supabase env vars through the resolvers

Never read them raw. Vercel's Supabase Marketplace integration injects
*different* names (`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`,
`SUPABASE_SECRET_KEY`) alongside the legacy `NEXT_PUBLIC_SUPABASE_*` names. App
code goes through `apps/nextblock/lib/setup/env-status.ts`
(`resolveSupabaseUrl` / `resolveSupabaseAnonKey` / `resolveSupabaseServiceKey`).
Published libs can't import that, so they inline the same ordered alias chain —
if you add or touch any inline Supabase client factory, accept every alias. See
[docs/12-VERCEL-DEPLOYMENT.md](./docs/12-VERCEL-DEPLOYMENT.md).

### 6. Two other things that look like bugs but aren't

- **The ecommerce alias mismatch is intentional.** The import path is
  `@nextblock-cms/ecommerce` while `libs/ecommerce/package.json` is named
  `@nextblock-cms/ecom`. Don't "fix" it. A standalone `nx build ecommerce` is
  known not to be green — validate commerce changes at the app level.
- **A custom block's `slug` is a public contract.** Renaming one orphans every
  page and post that references the old slug; they render "Unsupported block
  type" until re-pointed.

## Making a change

1. **Open an issue first** for anything non-trivial, so we can agree on the
   approach before you invest time.
2. **Branch from `master`.**
3. **Keep the change focused.** Match the surrounding code's style, naming, and
   comment density — the repo is formatted with Prettier and linted with ESLint.
4. **Add or update tests** for behavior changes. Vitest lives alongside the code
   it tests.
5. **Verify before you push:**
   ```bash
   npm run lint
   npx vitest run
   npx nx build nextblock
   ```
6. **Update the docs.** The numbered files in root `docs/` are the maintained
   reference set. If your change makes one of them wrong, fix it in the same PR
   — and run `npm run sync:create-nextblock` so the template copy follows.
7. **Open the PR** against `master` with a description of what changed and why,
   plus how you verified it. Note explicitly if you touched migrations, the
   template pipeline, or published-lib entry points.

## Licensing of contributions

NextBlock is licensed under **AGPL-3.0-or-later** (see [LICENSE.md](./LICENSE.md)).
By submitting a contribution you agree that it is licensed under the same terms.
Premium modules (`libs/ecommerce`, `libs/cortex`) are published publicly under
the same license and gated at runtime by license-key activation — contributions
there are treated identically.

## Questions

- **Docs:** [docs/README.md](./docs/README.md) — audience-based index
- **Bugs and features:** [GitHub issues](https://github.com/nextblock-cms/nextblock/issues)
- **Security:** [SECURITY.md](./SECURITY.md) — never the public tracker
