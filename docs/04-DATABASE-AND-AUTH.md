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

Sign-up is public on every install (`/sign-up`; `system_configuration.auto_accept_signups`
only decides whether e-mail confirmation is skipped), so every policy granted to
`authenticated` is reachable by anyone who registers. After creation, `profiles.role` changes
only through an `ADMIN` session or the service role (`protect_profile_role` trigger, `02021`).

### CMS authorization

The CMS shell in `app/cms/CmsClientLayout.tsx` currently expects:

- an authenticated user
- a resolved profile role of `ADMIN` or `WRITER`

Writers and admins can enter the CMS. Admin-only navigation is used for
settings such as payments, shipping, users, and some branding/config surfaces.

`proxy.ts`, `app/cms/layout.tsx` and every `get_current_user_role()` policy trust
`profiles.role`, which is why that column is guarded at the database (see "Row Level
Security Patterns"). The role lookup itself is `private.current_user_role()`, a
`SECURITY DEFINER` function the API roles can execute from inside a policy but cannot call
over REST; `public.get_current_user_role()` and `public.is_admin()` are its invoker wrappers.

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

- public read access for languages, media, translations, live content (status published or
  active, `published_at` null or past — scheduled rows are staff-only until then), and
  several storefront commerce tables
- `profiles` (`02021`): a signed-in user reads and edits their own row, `ADMIN` and `WRITER`
  read every row, the public key reads nothing. Public review, comment and staff-reply cards
  get the author's name and avatar through `author()`, a computed relationship on
  `cms_interactions` (`select=*,author(full_name,avatar_url)`) that answers only for approved
  rows. `role` changes are `ADMIN` or service-role only: the update policy's `WITH CHECK`
  pins the column and the `protect_profile_role` trigger backs it; the users screen already
  writes through the service role.
- authenticated self-service access for user addresses and customer-owned orders.
  `user_security_settings` is read by its owner but written only by the server: the
  security actions verify the factor first, then upsert with the service role.
- `ADMIN` or `WRITER` write access for most CMS authoring tables, and staff-only reads of
  revisions and drafts
- `site_settings` reads tiered by key (public / signed-in / staff / `ADMIN`, see "Important
  Site Settings in Active Use" below); writes tiered since `02022` (the sensitive keys are
  `ADMIN`-only); since `02023` the `ADMIN` tier of both requires a satisfied second factor
  (`is_admin_mfa()`), so the CMS reads and writes it with the service role after its own
  role check
- `ADMIN`-only write access for higher-risk configuration surfaces
- `service_role` full access where background jobs or system syncs need it

Commerce-specific policy highlights include:

- public read access for live products and their variants (the rows of draft, archived and
  scheduled products are staff-only; their media links, stock rows and category links stay
  public), product media, product attributes, shipping zones, shipping methods, tax rates,
  and active currencies. A customer's own invoice looks the purchased products up with the
  service role, so an archived product still appears on it.
- customer-scoped read access for `orders` and `order_items`
- service-role management access for orders, order items, inventory, taxes, and
  currencies; invoice numbering (`generate_order_invoice_number()`,
  `assign_order_invoice_metadata()`) is callable by the service role only

Supabase Advisor hygiene (kept clean since `02013`; re-check the dashboard after any policy
change):

- Call `auth.uid()` / `auth.jwt()` / `get_current_user_role()` inside a policy as
  `(select …)` so Postgres evaluates it once per statement instead of once per row.
- Keep exactly one permissive policy per role + command. A `FOR ALL` admin policy overlaps
  a `FOR SELECT` editor policy; a "Public read active" policy `TO anon, authenticated`
  overlaps an "Admins read all" policy `TO authenticated`. Split by role (`TO anon` /
  `TO authenticated USING (is_active OR admin)`) or by command instead.
- `SECURITY DEFINER` trigger functions (`handle_new_user()`, `update_product_ratings()`)
  must not be executable by `anon` or `authenticated`. Triggers fire regardless of the
  caller's EXECUTE privilege, so revoke it. Note that a database which recorded the
  baseline without running it (production after a squash) keeps the old grants until a
  forward migration revokes them. Both apply paths end with a blanket
  `grant execute on all functions in schema public` to the API roles, so each path must
  take it back in the same pass: `TRIGGER_FUNCTION_REVOKE_SQL` (every `RETURNS trigger`
  function) and `API_ROLE_REVOKE_SQL` (the explicit revokes of `02021`/`02022`) in
  `lib/setup/schema-apply.ts` (`/setup`) and `tools/lib/migrate-core.mjs` (the build-time
  hook). The hook lacked both until 2026-10-20, so every production deploy re-granted the
  triggers and the advisor flagged them again; `02024` repairs the databases that were
  re-granted, and `tools/lib/migrate-core.test.mjs` fails when the two copies drift. A
  migration that revokes EXECUTE from an API role must add the function to
  `API_ROLE_REVOKE_SQL` in both files, or the next deploy hands it back.
- Lint 0014 (`extension_in_public`): a bare `create extension` lands in `public`. For a
  relocatable extension `alter extension … set schema extensions` is enough; `pg_net` is
  not relocatable, so `02024` drops and re-creates it `with schema extensions` when it
  finds it in `public` (its objects live in `net` either way; the request queue and
  response log are transient, and pg_cron commands are plain text). Install extensions
  `with schema extensions` from the start.
- A `CREATE POLICY` without a `TO` clause applies to PUBLIC, `anon` included, and
  `USING (true)` on such a policy publishes the table to anyone holding the site's public
  key. The baseline's `profiles_read_policy` was exactly that (every account's name, phone,
  website and role); `02021` re-cuts it `TO authenticated`. When the public site needs one
  field of a private row, give it a computed relationship that returns only that field
  (`author()`), not a policy on the table.
- A self-service `FOR UPDATE ... USING (id = auth.uid())` policy covers every column the
  role is granted, so a row that carries an authorization column (`profiles.role`) needs
  the `WITH CHECK` to pin that column and a trigger guard behind it
  (`protect_profile_role()`): before `02021`, any self-registered account could `PATCH` its
  own `role` to `ADMIN` through PostgREST and walk into `/cms` as an administrator.
- Helpers that a policy on `profiles` itself must call read the table as its owner. They are
  `SECURITY DEFINER` functions in the non-exposed `private` schema
  (`private.current_user_role()`, `private.author_card()`), and `public.get_current_user_role()`,
  `public.is_admin()` and `public.author()` are `SECURITY INVOKER` wrappers that keep the old
  names. Advisor lints 0028/0029 flag a `SECURITY DEFINER` function in an exposed schema that
  `anon` or `authenticated` can execute, and a policy runs with the querying role's rights, so
  the API roles keep `USAGE` on `private` and `EXECUTE` on the helpers while PostgREST cannot
  RPC them. Never create a `SECURITY DEFINER` function in `public`.
- Row-level security does not govern `TRUNCATE`; `02021` revokes it from `anon` and
  `authenticated` on every table that exists at that point, and `/setup`'s grant pass repeats
  the revoke. A later migration that grants on a new table grants `SELECT, INSERT, UPDATE,
  DELETE` rather than `ALL` (the lint accepts either; the convention is the guard).
- `ADMIN` and `WRITER` read every `profiles` row, phone and website included, and staff are
  trusted with the customer contact data the CMS already shows them. Customers never read
  another account's row. Since `02023` the `ADMIN` half of that read (and the admin
  INSERT/UPDATE) goes through `is_admin_mfa()`, so an ADMIN on an `aal1` "remember this device"
  session sees only their own row through the cookie client: the dashboard, the revision lists
  and the inbox resolve author names, and the users screen counts admins, with the service role
  after a staff check (`lib/auth/cms-actor.ts`). The `WRITER` half is unchanged.
- A table whose row decides authorization elsewhere (`user_security_settings` drives the
  second-factor gate) gets no owner write policy at all; the server verifies, then writes
  with the service role.

`02022` (second red-team pass, 2026-10-19) hardens the writer boundary and adds a second-factor
check inside RLS:

- **`site_settings` writes are tiered like reads.** `privacy_settings` (carries
  `custom_scripts`), `global_css`, `is_admin_created` and `security_settings` join the ADMIN-only
  write array of the three write policies. A `WRITER` could previously write them over PostgREST:
  `custom_scripts`/`global_css` are injected site-wide (stored XSS across the WRITER→visitor/ADMIN
  boundary), `is_admin_created` gates both the first-admin bootstrap and the `/setup` redirect
  (reset it → self-promote on next sign-up, or funnel all traffic to `/setup`), and
  `security_settings` holds `enforce_staff_2fa`. Reads are unchanged.
- **`handle_new_user()` is a one-shot.** It grants `ADMIN` only when the flag is unset AND no
  `ADMIN` profile exists, and always self-heals the flag to `true`. A reset flag or a concurrent
  first-boot can no longer mint a second administrator.
- **Second factor inside RLS.** `private.meets_aal_requirement()` (owner-privileged, in `private`)
  is true unless the caller has a verified MFA factor but the session is not `aal2`;
  `public.is_admin_mfa()` is the `SECURITY INVOKER` wrapper (`is_admin()` AND the aal check). A
  no-MFA admin is never locked out. Applied to `mcp_access_tokens` (self-minting a bearer is a
  persistence primitive) and `package_activations` (plaintext license keys, now ADMIN-only read),
  so an `aal1` ADMIN session JWT used directly against PostgREST cannot reach them. The app
  enforces 2FA only in `proxy.ts`/`app/cms/layout.tsx`, so this closes the Data-API path; `02023`
  widens `is_admin_mfa()` to the remaining ADMIN policies (below). The MCP route's
  admin-session path and the full-backup export/restore routes enforce the same second factor in
  code (`evaluateTwoFactor()`).
- **Draft content: media, categories and stock are staff-only until the product is live.** 02021
  re-cut `products`/`product_variants`; `02022` does the same for `product_media`,
  `product_categories` and `inventory_items` (an `EXISTS` on an active, published product; stock is
  matched by SKU against products and variants). `tax_rates`/`shipping_*` stay public (checkout
  needs them).

**Server actions enforce their own authorization — RLS is not a backstop for them.** A Next.js
server action is a public POST dispatched by its action id regardless of route, and `proxy.ts`
only gates `/cms` *URLs*, so an action bundled into a public page runs for anyone who has the id
(the id ships in the client bundle). An action that reaches for `getServiceRoleSupabaseClient()`
(which bypasses RLS) therefore has **no** guard unless it checks the caller itself. Use
`requireEcomAdmin()` / `requireEcomStaff()` (`libs/ecommerce/src/lib/server-actions/require-ecom-role.ts`,
mirroring `requireAdminActor()` in `app/actions/package-actions.ts`) at the top of every such
action, or write with the cookie client so RLS still applies. The 2026-10-19 pass found the
inventory, product-taxonomy, Freemius-sync and shipping-zone/rate actions and the checkout-success
order lookup all missing this; they now gate (financial order transitions are ADMIN-only, content
taxonomy is ADMIN/WRITER, checkout-success binds the order to its owner). Guest Freemius checkout
still works because the provider mints a capability token (HMAC of the order id,
`libs/ecommerce/src/lib/order-access-token.ts`) into the success redirect, which the action
accepts as a third authorization path alongside owner / staff.

`02022` also carries these DB-level hardenings (second red-team pass):

- **`media` is owner-scoped for staff.** `media_update_policy` / `media_delete_policy` let a WRITER
  change or delete only rows where `uploader_id = (select auth.uid())`; ADMIN keeps every row. The
  CMS media actions and the product orphan-media sweep now do the DB write **first** and only touch
  storage for the rows RLS actually returned, so a non-owner's request can no longer destroy a
  storage object while orphaning its row.
- **Atomic, limit-aware coupon redemption.** `public.redeem_coupon_atomically(uuid)` (service-role
  only) increments `coupons.redemptions_count` under the row lock and returns false past the limit;
  the Stripe and Freemius providers fail the order and abort checkout when it returns false, so a
  `redemption_limit = N` coupon can never be redeemed past N.
- **`order_items.quantity > 0` CHECK** backstops the checkout quantity clamp for every writer.
- **`cms_interactions` flood trigger** (`private.enforce_cms_interaction_rate_limit`, BEFORE INSERT)
  caps how many pending interactions one ordinary user can create (staff and the service role are
  exempt), closing the direct-PostgREST flood the app-layer limit could not see.
- **Email-2FA lockout** is atomic: `public.bump_email_2fa_attempts(uuid)` (service-role only)
  increments every live code's `attempts` under its lock and returns the new maximum; the server
  burns the live pool once it reaches the cap, so the 10^6 code space cannot be iterated.
- **`ucp_cart_sessions.access_token_hash`** holds the sha256 of a per-cart capability token the app
  now requires on every read/modify/cancel, closing the cart IDOR.
- **`cortex_request_log`** (service-role only, RLS on, no API-role policy) backs a per-role hourly
  quota on the AI routes so a WRITER cannot drain the operator's model key.
- **aal2 reaches the app's own reads correctly.** Because `is_admin_mfa()` requires an `aal2`
  session for a factor-enrolled admin, the CMS pages that read `package_activations` /
  `mcp_access_tokens` now read with the service-role client behind the existing `/cms` 2FA gate, so
  a "remember this device" (aal1) admin is not locked out of their own screens while the Data-API
  path stays gated. The tokenless-localhost MCP trust now defaults off and requires the
  `NEXTBLOCK_MCP_TRUST_LOCALHOST` opt-in.

`02023` (2026-10-20) finishes the aal2-in-RLS pass. `public.is_admin_mfa()` replaces `is_admin()`
in every ADMIN branch of `orders`, `order_items`, `profiles` (other accounts' rows, and the admin
INSERT/UPDATE) and `site_settings` (reads above the staff tier, writes of the sensitive keys). The
owner branches, the `WRITER` branches, the staff tier and the anon policy are untouched, and
`user_addresses` has no ADMIN policy at all (owner + service role), so nothing changes there. An
ADMIN session JWT carrying only a first factor now reaches no order, no other account's profile
row and no setting above the staff tier over the Data API, and cannot write any of them. Every
policy is dropped by name and recreated, so the file re-runs cleanly.

The app rule that makes this possible: **a CMS read or write of one of those rows goes through
the service role after an in-code role check, never through the cookie client**, because a
"remember this device" admin passes the app's 2FA gate on an `aal1` Supabase session and would
otherwise see their own screens empty. `apps/nextblock/lib/auth/cms-actor.ts` is the app helper:
`getCmsActor()` reads the caller's own profile row (the one branch no aal check touches) and is
memoised per request with React `cache`, so the layout, the page and every helper they call
resolve the actor once; `requireCmsAdmin()` / `requireCmsStaff()` throw `Unauthorized` /
`Forbidden` and return the service-role client. `getEcomActorRole()` / `requireEcomAdmin()` in
`libs/ecommerce/.../server-actions/require-ecom-role.ts` are the lib equivalents. Users: the
dashboard (orders and the ledger profiles for ADMIN, the user count and recent-post authors for
staff), the orders list, order detail and report export, the revision lists and the inbox (author
names), the users screen's last-admin count, the Cortex and SEO admin gates (`require-admin.ts`
now returns the service-role client), the Cortex setup/chat status helpers, and the email,
payment, bot-protection, privacy/security, language-detection and global-CSS settings writers.
Where a WRITER could already open the screen (the orders list, the payments credentials view)
a non-ADMIN keeps the empty result RLS gave them instead of meeting an error page; nothing a
WRITER can see or do has widened. `tools/scripts/security-verify.sql` sections 13–17 assert the
policies from five seats: an ADMIN with a verified factor at `aal1` and at `aal2`, an ADMIN who
never enrolled a factor, a WRITER and a customer.

Explicit grants on every new table, view and sequence. Supabase no longer grants `anon`,
`authenticated` and `service_role` on new objects in `public` — the default for projects
created since 2026-05-30 and for every existing project from 2026-10-30 (changelog 45329:
"new tables in the public schema are no longer automatically exposed to the Data API";
existing tables "keep their current grants and stay reachable"). A forward migration that
creates a table, view or sequence ships its `GRANT ... ON TABLE public.x TO anon,
authenticated, service_role` (and `ON SEQUENCE`, including the implicit sequence of a serial or
identity column) plus `ENABLE ROW LEVEL SECURITY` and policies in the same file, exactly as
`02003` does for the baseline; without the grant PostgREST answers 42501 whatever the policies
say. `npm run db:migrate:check` and `npm run generate:migrations-bundle` refuse a forward
migration that creates such an object without granting on it to an API role, and (since `02022`)
without an `ALTER TABLE … ENABLE ROW LEVEL SECURITY` for each new table in the same file — an
API-reachable table with RLS off exposes every row to the public key
(`tools/scripts/lib/migration-grants.js`: `findUngrantedObjects` + `findTablesWithoutRls`). Two places still apply blanket grants afterwards:
the sandbox reset (`ALTER DEFAULT PRIVILEGES ... GRANT ALL` in `generate-sandbox-reset.ts`) and
`/setup`'s post-apply pass (`lib/setup/schema-apply.ts`, which then re-applies the `02021`
revokes so a wizard-installed database matches a CLI-migrated one).

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
  `npm run db:migrate:repair-history:check` prints the plan, the same command without `:check`
  applies it. Both detect the retired versions themselves and switch to the squash reconcile,
  asking `[Y/n]` first; you do not have to pass `--reconcile-squash`. The reconcile reverts the
  retired versions and marks `02000`–`02004` applied. `supabase db push` refuses to run while
  retired versions remain in the remote history, so this comes first; `db:migrate:check` says so.
- **A database that sat behind generation 1:** cross with the lenient applier first —
  `node apps/nextblock/tools/update.mjs --db-only` — which tolerates retired history rows (the
  catch-up reads them to decide what to replay) and records what it applies; then reconcile as
  above. The reconcile detects this case and refuses to revert too early: when the highest
  recorded retired version is below the catch-up's `catchup-through`, it reads
  `site_settings.migration_baseline_generation` to decide what to do. The history alone cannot
  tell it — a version recorded by `migration repair` looks exactly like one an applier
  recorded — but the catch-up writes that marker as its last statement, so it is the one
  honest signal that the SQL ran:
  - marker at this generation → the catch-up ran; the retired rows have done their job and the
    reconcile proceeds. **This is the normal state after crossing**, and it stays true even
    though the highest retired version never moves (the catch-up replays retired files without
    recording a row for each).
  - marker unset, catch-up still pending → cross the squash first; it refuses.
  - marker unset, catch-up already recorded → an earlier auto-detect repair recorded it without
    running it. It refuses and prints the `:revert` command to un-record it.
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
  (it auto-detects the applied high-water mark from the tables that exist), then rerun
  `npm run db:migrate:check`. It never marks the catch-up applied, whatever it detects.
- `--through=<version>` overrides the detected level. It must name an exact version in the
  current folder — versions are compared as strings, so `2014` would sort above every `02xxx`
  and sweep the whole generation, and a retired 14-digit version is meaningless here; both are
  rejected. It is only for a database whose history table is empty, and it does not silence
  the retired-version warning.
- That auto-detect mode is **only** for a wiped history. On a history that still lists retired
  versions it would record the catch-up as applied without running it, and because every applier
  matches by version and never by content, the catch-up would then be unreachable forever. The
  command detects that shape and offers to switch, so this is enforced rather than remembered.
- If the check shows retired 14-digit versions "recorded remotely with no local file" next to
  a pending `02000`–`02004`, the database has not crossed the squash yet — see "How a
  squash crosses live databases" above.

- Use `npm run db:migrate:fresh` only for a brand-new empty database.

#### Undoing a repair that marked the wrong versions applied

A version recorded in the history is skipped by every applier, forever, until it is un-recorded
— there is no "re-run this migration" because nothing matches on content. To take a version
back out of the history:

```bash
npm run db:migrate:repair-history:revert:check 02000   # plan only
npm run db:migrate:repair-history:revert 02000         # apply
```

The file becomes pending again and the next applier runs it. The common case is a catch-up that
the auto-detect mode recorded without running: the reconcile detects exactly that and prints
this command. Un-record the catch-up **before** reverting the retired rows — it reads them to
decide what to replay, so an empty history makes it replay the whole retired generation.

It refuses three things: a version recorded nowhere (usually a typo, and reverting it would
print success while doing nothing), a retired version (that row is what tells the catch-up the
migration already ran), and a catch-up when no retired rows remain in its
`catchup-from`..`catchup-through` range and `site_settings.migration_baseline_generation` does
not show it would self-skip. Override with `--force`, which npm consumes itself, so it has to
go through node:

```bash
node tools/scripts/repair-db-migration-history.js --confirm --revert <version> --force
```

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
- The read is `supabase migration list --output-format json`, and `parseMigrationList`
  reads the JSON line first, then falls back to the text table. Supabase CLI 2.109
  changed that command's output twice over: the text table wraps every cell in
  backticks, and a detected coding agent (`CLAUDECODE`/`AI_AGENT`) gets JSON by
  default. The old parser read the first as "0 pending" (so `db:migrate` said
  "Nothing to apply" with migrations outstanding) and failed the second as "never been
  linked". Output the parser cannot recognise returns `null`, never an empty history.
  `repair-db-migration-history.js` reuses the same parser and flag.
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
   (`sed $'s/\r$//'`, or `dos2unix`), never the working tree as-is: with `core.autocrlf=true` the tree mixes
   CRLF (git checkouts) and LF (tool-written files), and a multi-line `replace()` pattern
   only matches content seeded with the same line endings — building generation 2 from the
   raw tree silently lost migration 042's copy change. The git-canonical form is LF.
3. **Dump.** Schema: `pg_dump -n public -n private -s --no-owner --no-tablespaces --no-security-labels
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

## Full Site Backup and Restore

The CMS "Full ZIP backup" (`apps/nextblock/lib/full-backup/`, routes under
`app/api/cms/full-backup/`) is the whole-site migration path: it moves a site, accounts
included, to another Supabase project the way an all-in-one WordPress migration plugin does.
Export and restore are ADMIN-only and require a satisfied second factor. The archive holds:

- `database/dump.sql` — `pg_dump --clean --if-exists --no-owner` of the **application schemas
  only**: `public`, `private` and `supabase_migrations` (so the restored site knows which
  migrations it has). `auth`, `storage`, `extensions`, … are owned by Supabase's own roles
  (`supabase_auth_admin`, …); the `postgres` role the restore runs as cannot recreate them, so
  they are not dumped. (Before this scoping the dump carried them and the restore, run without
  error-stop, skipped every failing `auth.*` statement in silence while reporting success.)
- `users/auth-users.json` — one record per live `auth.users` row: id, email/phone and their
  confirmation state, the **original password hash** (`encrypted_password`), user metadata, ban,
  identity providers, and whether a TOTP factor was verified. No tokens, sessions or TOTP secrets.
- `content/nextblock-content-backup.json` (the content-transfer bundle) and every R2 object.

A restore runs in this order and fails loudly at the first problem instead of skipping it:

1. **Accounts first.** The dump re-adds every foreign key to `auth.users` after loading
   `profiles`/`orders`/…, so the ids must already exist. Each backup account is recreated through
   the GoTrue admin API with its original `id` and `password_hash` (`POST /admin/users` honours
   both); an account that already exists here under the same id is updated instead. An account on
   this site that holds an email the backup needs under a different id is removed first.
   `planUserRestore()` in `users.ts` is the pure planner.
2. **SQL restore** as one `psql --single-transaction -v ON_ERROR_STOP=1` script
   (`database.ts`): a preamble detaches every trigger that sits on a table outside the
   application schemas but fires a function inside them (`auth.users` → `public.handle_new_user`;
   otherwise the dump's `DROP FUNCTION` fails on the dependency — the role holds `TRIGGER` on
   `auth.users`, which is how `02003` attaches it); then the dump rewritten by
   `prepareDumpForRestore()` — schema-level `DROP/CREATE SCHEMA`, `ALTER DEFAULT PRIVILEGES`
   (`FOR ROLE supabase_admin` needs membership the role lacks) and `OWNER TO` statements are
   removed, every object outside the three schemas is dropped by pg_dump's own object headers
   (COPY data is never inspected), `CREATE SCHEMA` becomes `IF NOT EXISTS`, and version-specific
   settings such as pg_dump 17's `transaction_timeout` are stripped; then one
   `UPDATE auth.users SET encrypted_password` per restored account (`PUT /admin/users/{id}`
   ignores `password_hash` in GoTrue v2.189, so an account that already existed here would
   otherwise keep this site's password); then a postamble that re-attaches the triggers and
   switches off authenticator-app enrolment in `user_security_settings` for any account without a
   verified TOTP factor on this project. Either everything applies or nothing does, and the
   failing statement is in the error message.
3. Media URL rewrite (unchanged), then every account on this site that is not in the backup is
   removed — including the one that ran the restore if it was not part of the backup (its
   `profiles` row is gone with the dump anyway). The result reports what was recreated, updated,
   removed and skipped.

Consequences: after a migration everybody signs in with the password they had on the source
site, so a restored backup still needs the original admin password (the maintainer's chosen
security property for a feature that deliberately keeps accounts in the archive). Social-login
links, SSO and anonymous accounts do not cross (listed as skipped or warned). TOTP users must
re-enrol; email codes keep working. Archives exported before accounts were included restore
content only and keep this site's accounts; the restore then fails on the `auth.users` foreign
keys if the content references accounts that do not exist here, which is the correct outcome.
`pg_dump`/`psql` must be on the server process's PATH, `POSTGRES_URL`/`DATABASE_URL` must point
at the database, and the `postgres` role needs `INSERT`/`UPDATE`/`TRIGGER` on `auth.users`
(every Supabase project grants them). The rewrite and planning logic is pure and unit-tested
(`database.test.ts`, `users.test.ts`, `manifest.test.ts`); the full cycle was verified on a local
Supabase replay: export → change a password, delete and add accounts, change content → restore
→ original passwords work, ids preserved, the extra account is gone, the trigger is re-attached
and still creates profiles, and a dump with a failing statement rolls back completely.

## Important Site Settings in Active Use

These keys are actively referenced by the current codebase:

- `enabled_payment_providers`
- `ecommerce_inventory_settings`
- `invoice_settings`
- `footer_copyright`
- `is_admin_created`

There are many more seeded settings, but these are the most important ones for
understanding current runtime behavior.

Reads are tiered by key (`02021`; the baseline published every non-secret key to the public
key). The two policies on `site_settings` are the only place the tiers live, so a new key is
`ADMIN`-only until one of them lists it:

- public (anon and every signed-in user): `site_title`, `site_description`, `site_keywords`,
  `site_social_image`, `footer_copyright`, `footer_show_attribution`, `global_css`,
  `language_detection_settings`, `seo_robots_settings`, `bot_protection_public`,
  `active_logo_id`, `is_admin_created` (the `/setup` redirect in `proxy.ts` reads it with the
  anon key — an empty result sends every visitor to `/setup`), `privacy_settings`,
  `enabled_payment_providers` (an empty result disables every Buy button),
  `ecommerce_inventory_settings`, `migration_baseline_generation`
- any signed-in user: `invoice_settings` (a customer's own invoice page renders the seller
  block with the cookie client)
- `ADMIN` and `WRITER`: `security_settings`, `onboarding_state`, `email_public`,
  `cortex_ai_site_brief` (loaded by the CMS shell and dashboard for every staff role)
- `ADMIN`: everything else — the secrets (`*_secret`, `*_api_key`, `cortex_ai_mcp_settings`),
  `interactions_notification_emails`, `payment_public`, `store_contact`, `forms_contact`,
  the Cortex model/agent keys and any key not listed above. Since `02023` this tier (and the
  ADMIN-only write tier) answers only to `is_admin_mfa()`: an ADMIN with a verified second factor
  must be on an `aal2` session, so CMS code reads and writes it with the service role after
  `requireCmsAdmin()` (`lib/auth/cms-actor.ts`) or `requireEcomAdmin()`, never with the cookie
  client (a "remember this device" admin is on `aal1` and would get nothing).

Server code that reads a key for the public site with the service role is unaffected; code that
reads one with the cookie or SSG client for a visitor must use a public-tier key, or the loader
caches its fallback value (`unstable_cache` keeps whatever the first read returned).
