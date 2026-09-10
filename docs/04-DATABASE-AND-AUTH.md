# 04 Database and Auth

## Source of Truth

The database and auth implementation is spread across:

- `libs/db/src/lib/supabase/*`
- `libs/db/src/lib/package-validation.ts`
- `libs/db/src/supabase/config.toml`
- `libs/db/src/supabase/migrations/*`
- `apps/nextblock/app/auth/callback/route.ts`
- `apps/nextblock/app/cms/*`

When documentation and a migration disagree, the migration folder is the final
authority for schema, triggers, grants, and policies.

## Supabase Client Surfaces

`libs/db/src/server.ts` currently exports:

- `createClient()`: request-scoped server client using auth cookies
- `getProfileWithRoleServerSide()`
- `getActiveLanguagesServerSide()`
- `getServiceRoleSupabaseClient()`
- `getSsgSupabaseClient()`
- package activation helpers such as `verifyPackageOnline()`

Practical usage in the app is split by trust level:

- normal server routes and components use `createClient()`
- public static-ish reads often use `getSsgSupabaseClient()`
- admin or system workflows use `getServiceRoleSupabaseClient()`

## Auth Flow

### Session exchange

`app/auth/callback/route.ts` handles Supabase auth callback exchanges:

1. read the `code` query parameter
2. exchange it for a session with `supabase.auth.exchangeCodeForSession()`
3. load the user's profile and role
4. redirect through `resolvePostAuthRedirect()`

### Profile creation

The first-user and profile bootstrap logic lives in the database, not in React
code.

`02001_baseline_schema.sql` (functions) and `02003_baseline_security_and_grants.sql`
(the trigger) define:

- `handle_new_user()`
- `on_auth_user_created` trigger on `auth.users`

That trigger:

- creates the first local admin automatically
- creates later users as `USER`
- inserts or updates `profiles`
- copies selected metadata such as `full_name`, avatar URL, and GitHub username

### CMS authorization

The CMS shell in `app/cms/CmsClientLayout.tsx` currently expects:

- an authenticated user
- a resolved profile role of `ADMIN` or `WRITER`

Writers and admins can enter the CMS. Admin-only navigation is used for
settings such as payments, shipping, users, and some branding/config surfaces.

### No live app middleware file

There is a generic Supabase middleware helper in `libs/db/src/lib/supabase`,
but there is no live `apps/nextblock/middleware.ts` file in the current app.
Document the callback, layout, and RLS model as the active auth path rather
than assuming middleware-based route protection is in use.

## Schema Overview

### Core platform tables

Defined in `02001_baseline_schema.sql`:

- `site_settings`
- `profiles`
- `user_addresses`
- `languages`
- `media`
- `translations`
- `logos`

### Content tables

Defined in `02001_baseline_schema.sql`:

- `posts`
- `pages`
- `blocks`
- `navigation_items`
- `page_revisions`
- `post_revisions`
- `product_revisions` (alongside `products.version`)

### Commerce tables

All defined in the baseline schema `02001_baseline_schema.sql` (every table is — the
per-migration numbers quoted in earlier revisions of this doc were retired by the squashes):

- `products`
- `product_media`
- `product_attributes`
- `product_attribute_terms`
- `product_variants`
- `inventory_items`
- `variant_attribute_mapping`
- `package_activations`
- `freemius_plans`
- `freemius_pricing`
- `orders`
- `order_items`
- `shipping_zones`
- `shipping_zone_locations`
- `shipping_zone_methods`
- `tax_rates`
- `currencies`

### Tables that arrived after the original schema

All folded into `02001_baseline_schema.sql` by the squashes; listed here because they are
easy to miss when reading the schema as one blob (their origin migrations live only in git
history now):

- `categories` and `product_categories` — catalog organization
- `custom_block_definitions` — data-driven custom block registry
  (see [10-CUSTOM-BLOCKS.md](./10-CUSTOM-BLOCKS.md))
- `ucp_cart_sessions` — persisted cart sessions
- a `blocks` JSONB column plus `product_id` link for block-based product descriptions
- `site_themes`, `site_scripts` + `site_script_revisions`, `product_revisions`,
  `mcp_access_tokens`, `product_inquiries`, `message_threads` + `thread_messages`,
  `cms_redirects`, `system_alerts` — generation-1 additions (2026-07 → 2026-09)

## Row Level Security Patterns

`02003_baseline_security_and_grants.sql` is the consolidated RLS file.

The high-level access model is:

- public read access for languages, media, translations, published content, and
  several storefront commerce tables
- authenticated self-service access for user addresses and customer-owned
  orders
- `ADMIN` or `WRITER` write access for most CMS authoring tables
- `ADMIN`-only write access for higher-risk configuration surfaces
- `service_role` full access where background jobs or system syncs need it

Commerce-specific policy highlights include:

- public read access for products, product media, product attributes, variants,
  shipping zones, shipping methods, tax rates, and active currencies
- customer-scoped read access for `orders` and `order_items`
- service-role management access for orders, order items, inventory, taxes, and
  currencies

## Migration Structure

### Current reality: squash generations (`GGNNN`)

The folder holds exactly **one squash generation**. File names are `GGNNN_name.sql`:
`GG` is the generation (two digits, `02` and up), `NNN` the sequence inside it (three
digits, contiguous from `000`), `name` lowercase snake case. The first five slots of every
generation are fixed:

| File | What it is |
| :-- | :-- |
| `02000_catchup_gen1.sql` | generation 1's forward migrations, replayed **once and version-aware** on databases that sit behind; runs first so the baseline below is a no-op afterwards (details below) |
| `02001_baseline_schema.sql` | enums, functions, tables, sequences, defaults (`IF NOT EXISTS` / `CREATE OR REPLACE`) plus the re-attached `auth.users` → `handle_new_user` trigger |
| `02002_baseline_constraints_and_indexes.sql` | primary/unique/check + foreign-key constraints (catalog-guarded) and every index |
| `02003_baseline_security_and_grants.sql` | RLS enablement, policies (`DROP … IF EXISTS` first), triggers, grants |
| `02004_baseline_seed.sql` | canonical demo content (no users, no secrets), `ON CONFLICT DO NOTHING`; runs **only on an empty database** and then records the generation it was born at in `site_settings.migration_baseline_generation` |
| `02005_…` onward | ordinary forward migrations, appended one at a time |

Generation 2 was built on 2026-09-10 from generation 1 — the retired 14-digit files
`00000000000000`–`00000000000042`, themselves the 2026-07 squash of the original 45 — by
`tools/scripts/rebaseline-transform.mjs` from a fresh-apply `pg_dump`, and verified against
that fresh apply (schema byte-identical; data identical except the generation marker). The
retired files live only in git history.

**The next number is the highest sequence on disk + 1, in the same generation.**
`npm run db:migrate:check` prints it and refuses to run on a file that does not match the
scheme (`tools/scripts/lib/migration-naming.js`; the same lint runs in both generators and
in `tools/scripts/migration-naming.test.ts` against the real folder). Never copy a "next is
N" out of a doc or a memory, and never use timestamps.

Why the scheme looks like this:

- **Digits only.** The Supabase CLI silently skips any file that is not `<digits>_name.sql`
  (verified on CLI 2.107: `squash2_000_x.sql` is skipped with a warning; `02000_x.sql` is
  accepted). The CLI is still on the production path (`db:migrate`, history repair).
- **Fixed width.** Every applier — the CLI's pending walk, Postgres' `ORDER BY` on
  `supabase_migrations.schema_migrations`, this repo's own appliers — compares versions as
  plain strings, so `020` and `0200` would interleave.
- **Second digit never 0.** Every database created before the generation-2 squash still
  carries the legacy `000000000000xx` versions in its history; `0G…` with `G ≥ 1` sorts
  after all of them. Timestamps (`2026…`) would still sort after every generation below 20,
  but the lint rejects them so nobody has to reason about that.

### How a squash crosses live databases

A new generation gets **new versions**, so every one of its files is pending on every
existing database (production, the sandbox, every downstream install). That is by design,
and it is safe because of three properties:

- **The catch-up replays only what is missing.** `02000_catchup_gen1.sql` is one
  `DO` block; each retired file is embedded as a dollar-quoted string and executed only if
  its version is not recorded in `supabase_migrations.schema_migrations` (or, for Docker
  installs, its file stem in `public._nextblock_docker_migrations`). A verbatim replay would
  be wrong: a migration whose guard is "insert unless X exists" fires again once a later
  migration removed X (generation 1's home promo), and copy-fix chains re-apply on rewritten
  content — both were observed on a replay over a fully migrated database during the build.
  The whole block is skipped on an empty database (no schema yet — the baseline follows) and
  on a database whose `migration_baseline_generation` is already ≥ 2; it sets that marker
  when it finishes. It runs first because the baseline DDL is idempotent only against the
  final schema: `CREATE TABLE IF NOT EXISTS` skips an old-shape table and the next comment
  or index on a newer column fails (observed on a database stopped at generation-1 `020`).
- **The baseline DDL is idempotent** against the final schema, so on a database the
  catch-up has just brought to the end of generation 1 it changes nothing.
- **The seed is guarded.** It runs only when `languages` and `site_settings` are both
  empty. Its explicit-id `INSERT`s would otherwise re-create demo rows an operator deleted.

What each kind of database needs:

- **Production (was at the end of generation 1):** record the squash, run nothing —
  `npm run db:migrate:repair-history:check -- --reconcile-squash` prints the plan, the same
  command without `:check` reverts the retired versions and marks `02000`–`02004` applied.
  `supabase db push` refuses to run while retired versions remain in the remote history, so
  this comes first; `db:migrate:check` says so.
- **A database that sat behind generation 1:** cross with the lenient applier first —
  `npm run update -- --db-only` — which tolerates retired history rows (the catch-up reads
  them to decide what to replay) and records what it applies; then reconcile as above.
  `--reconcile-squash` detects this case and refuses to revert too early.
- **The sandbox:** its reset payload wipes `public`, replays the folder from empty
  (seed runs, marker set, catch-up skipped) and re-records the generation's versions.
- **Downstream installs (Vercel, `npm create nextblock`, Docker):** nothing to do. The
  `/setup` wizard, the build hook, `npm run update` and the Docker runner all apply pending
  files in order and cross the squash automatically.
- **A database whose history was wiped:** `db:migrate` refuses to apply the baseline when
  the remote history is completely empty, because the catch-up would then replay everything.
  Repair the history first (`npm run db:migrate:repair-history`), or use
  `db:migrate:fresh` if the database really is new.

### Production migration policy

NextBlock has live Supabase data. Treat migrations as append-only for any
production or shared database change.

- Do not edit, recycle, squash, reorder, or delete migration files that may
  already be recorded in a shared or production Supabase project.
- Add a new forward-only `.sql` file under
  `libs/db/src/supabase/migrations` for each new schema/data change.
- Keep migrations non-destructive by default. Avoid dropping or rewriting data
  that may include orders, users, payments, or customer records.
- Run `npm run db:migrate:check` before `npm run db:migrate`. **Read its pending
  list** — do not just look for a success line. If you added a migration and the
  check reports `Pending: 0`, that file will never run (see below).
- **Supabase matches migration history by version only, never by content.** A file
  whose 14-digit version is already recorded remotely is skipped in silence — no
  error, no output. That is why the check prints the pending list and warns when a
  version is recorded remotely with no local file behind it.
- If an existing database whose history was wiped lists the baseline files
  (`02001_baseline_schema.sql` …) as pending, do not replay them blindly. Use
  `npm run db:migrate:repair-history:check`, then `npm run db:migrate:repair-history`
  (it auto-detects the applied high-water mark from the tables that exist; override with
  `--through=<version>`), then rerun `npm run db:migrate:check`.
- If the check shows retired 14-digit versions "recorded remotely with no local file" next to
  a pending `02000`–`02004`, the database has not crossed the squash yet — see "How a
  squash crosses live databases" above.
- Use `npm run db:migrate:fresh` only for a brand-new empty database.

#### Why `db:migrate:check` is read-only by construction

On 2026-08-10 the check applied migration `00000000000017` to the production
project while printing `DRY RUN: migrations will *not* be pushed` and `Dry run
complete. No database changes were applied.` The `--check` path then ran
`supabase link --yes` followed by `supabase db push --dry-run` (Supabase CLI
v2.107); which of the two executed the SQL was never established, and the decisive
probe would have written a row to the production migration history.

`tools/scripts/push-db-migrations.js` no longer runs either on the check path. It
now runs only `supabase migration list` — a pure read — and derives the pending set
by diffing local files against remote history. Consequences worth keeping:

- The check links nothing. An unlinked repo is told to run `supabase link` itself
  rather than having project state written underneath a command called "check".
- The check needs no `SUPABASE_ACCESS_TOKEN`, because only linking did.
- The apply path derives its baseline-replay guard from the same read instead of
  regex-scraping `db push --dry-run` output, and returns early when nothing is
  pending, so `db push` is never invoked without work to do.
- `parseMigrationList` is unit-tested in `tools/scripts/push-db-migrations.test.ts`.

If a future CLI upgrade tempts you back toward `db push --dry-run` for previewing:
don't. A command named `check` must not be able to write.

### How to read the folder

Read `02001_baseline_schema.sql`, then `02002` and `02003`, then the seed — in that
order they are the cleanest under-the-hood blueprint for:

- which tables exist
- what triggers and functions are available
- what security rules are enforced
- what default content and configuration are seeded

Skip `02000_catchup_gen1.sql` unless you are debugging an upgrade: it is generation 1's
history, kept only so databases that sat behind can converge. Everything from `02005`
upward is an ordinary forward migration and reads as a changelog.

If you need to understand whether the platform really supports something, check the
migration file first, then trace the corresponding route or library code.

### Squashing migrations (re-baseline runbook)

Do this rarely — a squash retires every forward migration written since the last one, and
every live database has to cross it. Downstream installs exist, so **a squash always ships a
catch-up**. Generation `G` replaces generation `G-1`; the steps below produced generation 2
and are what the next squash repeats with `G = 3`.

1. **Preconditions.** Production and the sandbox are at the last version of the current
   generation and `npm run db:migrate:check` is clean. Docker Desktop is running.
   `psql` and `pg_dump` 17 are on `PATH`. Nothing in this runbook touches a shared
   database.
2. **Fresh-apply the current generation** to a throwaway database. The repo's compose file
   is the easiest source of a real Supabase-shaped Postgres with `auth.users`:
   `docker compose -p nbsquash --env-file <scratch>/.env up -d db auth` with an env file
   holding `POSTGRES_PASSWORD`, `JWT_SECRET` (≥ 32 chars), `POSTGRES_PORT_EXTERNAL`
   (pick a port outside `netsh interface ipv4 show excludedportrange protocol=tcp`; 54329
   is Hyper-V-reserved on this machine, 15432 worked) and dummy values for the other
   interpolated variables. Wait until `select to_regclass('auth.users')` is non-null, then
   apply every file in order with `psql -v ON_ERROR_STOP=1 -1 -f`, recording each version
   in `supabase_migrations.schema_migrations` exactly like the real appliers do — the
   catch-up reads that table, so the harness must fill it. **Apply LF-normalized copies**
   (`tr -d ''`), never the working tree as-is: with `core.autocrlf=true` the tree mixes
   CRLF (git checkouts) and LF (tool-written files), and a multi-line `replace()` pattern
   only matches content seeded with the same line endings — building generation 2 from the
   raw tree silently lost migration 042's copy change. The git-canonical form is LF.
3. **Dump.** Schema: `pg_dump -n public -s --no-owner --no-tablespaces --no-security-labels
   --no-publications --no-subscriptions -T public._nextblock_docker_migrations > schema.sql`.
   Data: `pg_dump -n public -a --column-inserts --on-conflict-do-nothing --no-owner
   --exclude-table-data=public.profiles -T public._nextblock_docker_migrations > data.sql`.
4. **Transform.** `node tools/scripts/rebaseline-transform.mjs <dumpDir> <outDir>
   --generation G --catchup-from libs/db/src/supabase/migrations --catchup-after <the
   current generation's seed version, e.g. 02004>`. It classifies every statement, adds the
   idempotency guards, wraps the seed in its empty-database guard, builds the version-aware
   catch-up, normalizes install-state rows (`is_admin_created` → `false`,
   `system_configuration` → `{}`), drops `profiles` data and the Docker tracking table,
   and strips every carriage return (see the comments in the script for why each of these
   exists — every one closes a defect found while building generation 2). It prints object
   counts and flags anything it could not classify.
5. **Validate — all of these, every time.** Recreate the throwaway stack between runs
   (`docker compose -p nbsquash … down -v`). Apply LF files everywhere and compare
   `pg_dump` output with comments dropped, carriage returns stripped, apply-time values
   masked (SQL and JSON timestamps, `form_key`s and `form_endpoints` keys, `site_themes`
   ids — all generated at seed time), and `INSERT`s sorted. `tools/scripts/rebaseline-harness.sh`
   does all of this:
   - fresh new generation **==** fresh old generation (schema identical; data identical
     except the `migration_baseline_generation` row);
   - re-applying all five files on that database changes nothing;
   - old generation applied part-way (e.g. through its 20th file, versions recorded) then
     the new generation **==** fresh old generation;
   - old generation applied fully then the new generation **==** fresh old generation;
   - the same part-way case with versions recorded only in
     `public._nextblock_docker_migrations` (Docker installs) **==** fresh old generation;
   - negative seed test: delete a `site_settings` row on a populated database, re-run the
     seed file, the row stays deleted.
6. **Swap the folder.** Delete every file of the old generation, copy the five new ones in,
   run `npx vitest run tools/scripts` (the naming test now enforces the new generation).
7. **Regenerate the artifacts:** `npm run generate:migrations-bundle && npm run
   generate:sandbox`. A squash never changes the schema, so `npm run db:types` must
   produce no diff.
8. **Update the docs:** this section (generation number, date, the table above),
   `CLAUDE.md`, `libs/db/CLAUDE.md`, `AGENTS.md`, `docs/05`, the migration table in the
   technical specification, and any code comment that cites a retired file name.
9. **Ship:** republish `@nextblock-cms/db` (minor bump — standalone installs get the
   folder from the package), `npm run sync:create-nextblock`, commit. Publish the package
   before pushing the template, or `npm create nextblock` pins a version that does not exist.
10. **Cross the live databases** as described in "How a squash crosses live databases":
    production via `--reconcile-squash`, the sandbox via its reset.
11. **The first new migration is `G005`.** Never reuse a retired number.

## Important Site Settings in Active Use

These keys are actively referenced by the current codebase:

- `enabled_payment_providers`
- `ecommerce_inventory_settings`
- `invoice_settings`
- `footer_copyright`
- `is_admin_created`

There are many more seeded settings, but these are the most important ones for
understanding current runtime behavior.
