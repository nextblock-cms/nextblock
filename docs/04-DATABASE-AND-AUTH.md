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

`00000000000005_setup_functions_and_triggers.sql` defines:

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

Defined primarily in `00000000000001_setup_cms_core.sql`:

- `site_settings`
- `profiles`
- `user_addresses`
- `languages`
- `media`
- `translations`
- `logos`

### Content tables

Defined primarily in `00000000000002_setup_content_tables.sql`:

- `posts`
- `pages`
- `blocks`
- `navigation_items`
- `page_revisions`
- `post_revisions`
- `product_revisions` (added in `00000000000016`, alongside `products.version`)

### Commerce tables

All defined in the baseline schema `00000000000000` (the numbers `00000000000003`/
`00000000000004` in earlier revisions of this doc were pre-re-baseline file names):

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

### Post-baseline tables

Added after the squashed baseline by later migrations:

- `categories` and `product_categories` — catalog organization
  (migration `00000000000019`; translated via `00000000000020`)
- `custom_block_definitions` — data-driven custom block registry
  (migration `00000000000023`; see [10-CUSTOM-BLOCKS.md](./10-CUSTOM-BLOCKS.md))
- `ucp_cart_sessions` — persisted cart sessions (migration `00000000000024`)
- a `blocks` JSONB column plus `product_id` link for block-based product
  descriptions (migration `00000000000017`)

## Row Level Security Patterns

`00000000000006_setup_rls_and_grants.sql` is the consolidated RLS file.

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

### Current reality

The folder was **re-baselined in 2026-07**: the previous 45 migrations
(`00000000000000`–`00000000000044`) were squashed into a four-file idempotent
baseline, generated from a fresh-apply `pg_dump` by
`tools/scripts/rebaseline-transform.mjs` and verified byte-identical to the old
tree. The current sequence is:

- `00000000000000_baseline_schema.sql` — enums, functions, tables, sequences
  (all `IF NOT EXISTS` / `CREATE OR REPLACE`) plus the re-attached `auth.users`
  → `handle_new_user` trigger.
- `00000000000001_baseline_constraints_and_indexes.sql` — primary/unique/check
  and foreign-key constraints (guarded) plus all indexes.
- `00000000000002_baseline_security_and_grants.sql` — RLS enablement, policies
  (`DROP … IF EXISTS` first), triggers, and grants.
- `00000000000003_baseline_seed.sql` — canonical demo content, `ON CONFLICT DO
  NOTHING` (no users, no secrets).

Every file is fully idempotent. Existing databases already have versions
`000`–`003` recorded, so both appliers skip the baseline — it only runs on a
fresh/empty database.

Seed *data-fix* migrations (the `seed_seo_*` series, `reposition_marketing_*`) must scope
every UPDATE by **content signature and parent** (`WHERE page_id = v_home AND content::text
LIKE '%Blazing-Fast%'`), never by a numeric `blocks.id`. `blocks`, `pages` and `posts` ids
are identity columns, so any install that created or deleted a row since the baseline has
different ids from the one the migration was written against — including the sandbox, which
re-creates rows on every reset. `00000000000035` keyed its product-block updates by id and,
on drifted installs, wrote French Commerce Pro copy over the home-page Live Demo promo and
over the first block of the French install guide; `00000000000037` carries the
signature-scoped repair. Signature guards also make a migration idempotent for free: once
the copy is replaced, the guard no longer matches.

`00000000000004` was the first migration appended after that re-baseline, not the
one still to be written — the folder has grown well past it. **To find the next
number, list `libs/db/src/supabase/migrations` and take the one after the highest
file on disk.** Never copy a hardcoded "next is N" out of a doc.

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
- If an existing database lists old baseline files such as
  `00000000000000_baseline_schema.sql` as pending, do not replay them. Use
  `npm run db:migrate:repair-history:check`, then
  `npm run db:migrate:repair-history --through=00000000000003` (the baseline's
  top file creates no tables, so auto-detection otherwise stops at `000`), then
  rerun `npm run db:migrate:check`.
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

### Category map

| Migration file | Domain | What it covers |
| :-- | :-- | :-- |
| `00000000000000_baseline_schema.sql` | Core, CMS, Commerce | all enums, 40 functions, 49 tables + sequences (idempotent), and the `auth.users` → `handle_new_user` bootstrap trigger |
| `00000000000001_baseline_constraints_and_indexes.sql` | Core, CMS, Commerce | all primary/unique/check + foreign-key constraints (guarded) and every index |
| `00000000000002_baseline_security_and_grants.sql` | Security | RLS enablement on every table, all policies, timestamp/business triggers, grants |
| `00000000000003_baseline_seed.sql` | Seeds | canonical demo content — languages, currencies, site settings, translations, media, pages/posts/blocks, navigation, shipping defaults — all `ON CONFLICT DO NOTHING` |

The pre-2026-07 history (foundation/enums, cms_core, content_tables, catalog,
fulfillment, functions_and_triggers, rls_and_grants, indexes, the seed files, and
later additions like custom block definitions, product blocks, categories, cart
sessions, drafts, privacy/MFA, system alerts, interactions) is all folded into the
four files above; the earlier per-file boundaries survive only as comment headers
inside the generated SQL.

### How to read the folder

Read the migrations in lexical order from `00000000000000` upward.

That sequence is the cleanest under-the-hood blueprint for:

- which tables exist
- what triggers and functions are available
- what security rules are enforced
- what default content and configuration are seeded

If you need to understand whether the platform really supports something, check
the migration file first, then trace the corresponding route or library code.

## Important Site Settings in Active Use

These keys are actively referenced by the current codebase:

- `enabled_payment_providers`
- `ecommerce_inventory_settings`
- `invoice_settings`
- `footer_copyright`
- `is_admin_created`

There are many more seeded settings, but these are the most important ones for
understanding current runtime behavior.
