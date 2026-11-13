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

Whatever the client, PostgREST returns at most `max_rows` rows per request (`[api] max_rows =
1000` in `libs/db/src/supabase/config.toml`, and 1000 on hosted Supabase) and drops the rest
without an error. A read of a table that can grow past 1000 rows pages with
`.order(<unique column>).range()`, and treats only an EMPTY page as the end: a hosted project's
"Max rows" can be lowered in the dashboard, and a short page may just be capped. `translations`
passed 1000 rows with `02031`: its readers go through `readAllTranslationRows`
(`apps/nextblock/lib/i18n/translation-pages.ts`, which moves on by the rows it received and stops
on an empty page), and `tools/scripts/translations-pagination.test.ts` fails on a
`.from('translations')` read of many rows without `.range()`.

### Service-role boundary

The service-role / secret key bypasses every RLS policy, so the code that holds it stays on
the server, enforced at three levels:

- **`import 'server-only'` in every module that builds, hands out or keys a service-role
  client**: `libs/db/src/lib/supabase/server.ts` (the factory), the verified-role-then-service-
  role helpers (`lib/auth/cms-actor.ts`, `require-ecom-role.ts`, the `require-admin.ts` gates),
  every server action, page and route that calls them, and the ecommerce providers that build
  their own client from `SUPABASE_SERVICE_ROLE_KEY`. Next.js fails the build the moment such a
  module lands in a client graph. A `'use server'` module may carry it too: a client component
  that imports an action receives a reference, never the module body.
- **One secret resolver, server-only.** `resolveSupabaseServiceKey()` and
  `isFullyConfigured()` live in `apps/nextblock/lib/setup/service-key.ts`.
  `lib/setup/env-status.ts` resolves only the public names, because the proxy, `next.config.js`
  and client modules (the language REST client, the app-icon context) import it.
- **`tools/scripts/service-role-boundary.test.ts`** (`tools/scripts/lib/service-role-boundary.js`)
  fails when a module that uses the service role lacks `'server-only'` (the verified helpers
  `requireCmsAdmin()`, `requireEcomAdmin()`, `requireRetailer()`, `requireRetailerPage()` and
  friends count as service-role use); when any `'use client'`
  file or client-safe library entry (`@nextblock-cms/db`, `/ecommerce`, `/cortex/client`, `/ui`,
  `/editor`, `/utils`, `/sdk`, `/affiliates`, `/affiliates/editor`; every `exports` subpath
  except the declared server entries) reaches server-only or service-role code through value imports
  (it stops at `'use server'` modules and skips `import type`); and when a secret is named
  `NEXT_PUBLIC_*` or appears in `next.config.js` `env` (both are inlined into the browser
  bundle). The library entries matter because Vite builds them without Next's check, so a leak
  there would only fail in a downstream install. Import a type from a server module with
  `import type`; a plain import that happens to name only a type is a value import to the check
  and one edit away from a real one.

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
settings such as payments, shipping, users, affiliates, and some branding/config surfaces.

The fourth role, `RTL` (`02029`), is an Affiliates partner. It has no CMS access: partners use
the portal at `/portal/retailer`, whose pages, actions and routes authorize with
`requireRetailer()` / `requireRetailerPage()` (`apps/nextblock/lib/affiliates/retailer-actor.ts`,
the partner equivalent of `getCmsActor()`: session, enrolled second factor, own `profiles` row,
then the service role). After sign-in `resolvePostAuthRedirect()` sends an RTL account to the
portal. See docs/15.

`/cms/users` (the list, the edit page and the three actions in `app/cms/users/actions.ts`) runs
on `requireCmsAdmin()` since 2026-10-27; the actions' old `verifyAdmin` checked the role but not
the enrolled second factor, and the pages read the service key from env themselves. The actions
validate with zod (UUID ids, every field bounded), return `{ ok: false, error }` without database
text, manage `ADMIN`, `WRITER`, `USER` and `RTL`, and keep the last-admin check. Deleting a user
whose partner account has any payout, or any commission other than a zero-amount tombstone, is
refused ("Pause the partner in Affiliates instead";
`lib/affiliates/affiliate-deletion-guard.ts`, which "Remove partner" in `/cms/affiliates` asks too),
because the affiliate tables cascade from
`auth.users` and the delete would erase the ledger. The guard fails closed on a read error and
runs before the account's MCP tokens are revoked.

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

### Affiliates tables

Defined in `02030_affiliates_schema.sql` (the Affiliates package, docs/15):
`affiliate_tiers`, `affiliate_profiles`, `affiliate_pages`, `affiliate_commissions`,
`affiliate_payouts`, `affiliate_click_events` and `affiliate_payout_runs`, plus
`orders.affiliate_id` / `affiliate_source` / `affiliate_base_currency` / `affiliate_livemode` /
`affiliate_refunded_minor` / `affiliate_refund_total_minor` and six affiliate `system_alerts`
types. `02033` adds `affiliate_tiers.goal` / `goal_translations`; `02035` adds
`orders.affiliate_commission_rate` / `affiliate_clearance_hold_days` (the tier's rate and hold
stored when an attributed order is paid) and `affiliate_profiles.tier_changed_at`; `02036` adds
`affiliate_payouts.method` / `manual_channel` / `external_reference` / `note` / `recorded_by`
(payouts paid by hand: prepared before the money is sent, then recorded;
`stripe_destination_account` becomes nullable) and `affiliate_profiles.payout_email`.

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
  rows. `role` changes are service-role only: since `02025` `authenticated` holds INSERT and
  UPDATE on every `profiles` column except `role` (and `id` on UPDATE), so the update
  policy's `WITH CHECK` and the `protect_profile_role` trigger (`02021`) are the second and
  third layer, not the only one; the users screen writes roles through the service role.
- authenticated self-service access for user addresses and customer-owned orders.
  `user_security_settings` is read by its owner but written only by the server: the
  security actions verify the factor first, then upsert with the service role (since `02026`
  `authenticated` holds no INSERT, UPDATE or DELETE grant on it).
- `ADMIN` or `WRITER` write access for most CMS authoring tables, and staff-only reads of
  revisions and drafts
- `site_settings` reads tiered by key (public / signed-in / staff / `ADMIN`, see "Important
  Site Settings in Active Use" below); writes tiered since `02022`, and since `02028` a
  `WRITER` writes only an allow-list of keys; since `02023` the `ADMIN` tier of both requires a
  satisfied second factor (`is_admin_mfa()`), so the CMS reads and writes it with the service
  role after its own role check; since `02038` the secret rows answer to no API session at all,
  only to the service role
- `media` is readable by the public key on purpose (`media_read_policy USING (true)`, decision
  recorded in `02028`): the bucket is public-read and every rendered image carries its object
  URL, so a row adds only its file name, description and uploader id. Scoping it to media that
  live content references would have to follow every reference (blocks, sections, posts,
  products, logos, settings) and would break images on any path it missed. Inserts pin
  `uploader_id` to the caller (ADMIN excepted) since `02028`; updates and deletes are bound to
  the uploader since `02022`
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
- `SECURITY DEFINER` functions never live in `public` except the two legacy trigger functions
  below; a new one goes in `private` behind a `SECURITY INVOKER` wrapper (`02021`). The lint
  refuses a forward migration that creates (or ALTERs to) a definer function in `public`
  without `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated` in the same file, or that grants
  it back: Postgres grants EXECUTE to PUBLIC on every new function and Supabase's default
  privileges grant it to `anon` and `authenticated` by name, so revoking from PUBLIC alone
  leaves it callable over `/rpc`. `security-verify.sql` section 19 fails on any definer
  function in `public` outside its allowlist or executable by either API role.
- `SECURITY DEFINER` trigger functions (`handle_new_user()`, `update_product_ratings()`)
  must not be executable by `anon` or `authenticated`. Triggers fire regardless of the
  caller's EXECUTE privilege, so revoke it. Note that a database which recorded the
  baseline without running it (production after a squash) keeps the old grants until a
  forward migration revokes them. Both apply paths end with a blanket
  `grant execute on all functions in schema public` to the API roles, so each path must
  take it back in the same pass: `TRIGGER_FUNCTION_REVOKE_SQL` (every `RETURNS trigger`
  function) and `API_ROLE_REVOKE_SQL` (the explicit revokes of `02021`/`02022`/`02025`–`02028`/`02030`/`02035`–`02037`) in
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
  the revoke. A later migration that grants on a new table grants `SELECT` to `anon` (only if
  the table is publicly readable) and `SELECT, INSERT, UPDATE, DELETE` to `authenticated,
  service_role`, never `ALL`; since `02025` the lint refuses a write grant to `anon` or PUBLIC.
  Since `02026` `authenticated` gets only the writes a policy lets it use: a table (or command)
  written only by the service role revokes the rest from `authenticated` in the same migration
  and in both copies of `API_ROLE_REVOKE_SQL` (the post-apply pass grants `ALL` on every table
  to `authenticated` on each deploy); `security-verify.sql` section 26 fails otherwise.
  Since `02027` the same holds for SELECT: `anon` reads only tables a policy lets it read, and a
  service-role-only table revokes SELECT from `authenticated` too. The pass grants `anon` SELECT
  on every table, so a new table or view whose migration grants less than the pass (a
  service-role-only table, a staff-only view) needs its revoke in both copies of
  `API_ROLE_REVOKE_SQL`; `findGrantsWidenedByGrantPass` and section 28 fail otherwise.
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
  is true unless the caller has a verified MFA factor but the session is not `aal2` (since
  `02028` an enabled factor in `user_security_settings` counts too, which covers the app's
  email codes: see `02028` below);
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

**A server action takes no principal from its arguments.** The actor is the cookie session's
user; an argument naming one (`actorUserId`, `authorId`, `uploaderId`, `userId`) or handing in
the database client lets any caller choose who they are. Until 2026-10-21 `recordMediaUpload`
and `importExternalImageToMedia` took `actorUserId`, wrote with the service role, and checked the
session only when one existed, so a cookieless POST naming a staff id (public via approved
comments) wrote media as that admin. Routes that authenticate another way (the MCP bearer token)
call a helper that is not a server action and pass the actor they verified:
`recordMediaUploadAsActor` (`@nextblock-cms/db/server`), `importExternalImageAsActor`
(`lib/media/external-image-import.ts`). Helpers that take an author id or a client, like
`app/cms/revisions/service.ts`, are `server-only` modules, never `'use server'`. A target id an
admin acts on goes under a name that says so (`userIdToUpdate`).
`tools/scripts/server-action-actors.test.ts` (in `security:check`) parses every `'use server'`
module and inline action, follows each parameter's type into the module that declares it, and
fails on an identity or client name.

**The public sandbox refuses what would outlive its reset.** Its admin login is published, and so
is the demo partner's once the Affiliates demo is configured (the second factor always reads
satisfied). Every reset:

- empties the bucket;
- deletes every auth user except the two preserved demo ids (Step A of
  `tools/scripts/generate-sandbox-reset.ts`; their factors, sessions and identities go with them);
- rebuilds `public`;
- restores the demo admin's password and deletes every second factor on it (`restoreDemoAdmin`),
  right after the SQL and before every later step (a failure in the bucket wipe, the seed upload or
  the SQL itself ends that run first);
- re-creates the demo partners when `FREEMIUS_AFFILIATES_SANDBOX_KEY` is set (the program itself
  runs only with `FREEMIUS_ECOMMERCE_SANDBOX_KEY` too: Affiliates needs Commerce Pro).

Out of its reach: the rest of the two preserved `auth.users` rows, GoTrue's settings, mail already
sent, coupons or money at a payment provider, and anything another visitor already read.

Until 2026-11-03 a visitor could:

- create accounts and mail an address they typed (sign-up, partner sign-up, `/cms/users`);
- relay mail through the deployment's SMTP account;
- plant a script that read other visitors' OpenRouter keys (a site script, a GTM container, or
  markup in a product description or custom block);
- push live coupons to the operator's real Freemius products;
- enroll a second factor on the shared admin that survived every reset;
- open real checkouts, export the full backup.

Each of those now stops before the step that would outlive the reset:

- Some refuse as their first statement, others right after their admin check.
- Partner sign-up first runs its read-only checks (docs/15 → "What a visitor can and cannot do
  there").
- Mail stops at the send: `sendEmail` delivers only to `SANDBOX_CONTACT_EMAIL` and the product
  feedback inbox.
- Payment settings are neither saved nor read there, so a row written over PostgREST never reaches
  `process.env`.
- Site scripts, custom scripts and tag managers render nothing.
- A second factor enrolled through GoTrue directly is deleted by the next reset.

`tools/scripts/sandbox-guards.test.ts` (in `security:check`) holds the list, `SANDBOX_GUARDS` in
`tools/scripts/lib/sandbox-guards.js`, and fails when:

- a listed function stops reading `NEXT_PUBLIC_IS_SANDBOX` (directly, through
  `isSandboxEnvironment()` or through a helper of its module);
- a listed function's test never sets the flag to `'true'` (`vi.stubEnv` or a direct
  `process.env` assignment), or never uses the function (a comment, a title or a type does not
  count);
- a module that creates a mail transport, calls a GoTrue account, second-factor or auth-mail API
  (`signUp`, `createUser`, `mfa.enroll`, … on any client, stored handle or GoTrue-typed parameter,
  aliases and `SupabaseClient['auth']` included), writes to object storage, or writes to a payment
  provider is missing from `MAIL_SENDERS`, `ACCOUNT_WRITERS`, `STORAGE_WRITERS` or
  `VENDOR_WRITERS`, the lists that say how each behaves there. A payment-provider write is a
  Stripe call that is not a read (`retrieve`, `list`, `search`) on a Stripe client (a stored or
  typed handle, a member named `stripe` such as `context.stripe` or `this.stripe`, or a Stripe
  loader's result), a `fetch` that is not a GET or HEAD in a module that names Freemius in code
  (unless its URL is a literal for this site or another host), or a Freemius SDK
  `POST`/`PUT`/`PATCH`/`DELETE`, typed-service write (`api.license.update`,
  `api.subscription.cancel`) or customer-portal processor;
- for mail, accounts and payment providers, a call site sits outside a `SANDBOX_GUARDS` function of
  its module, a private helper or class only those reach, or a function or class the list exempts
  by name with a reason. Code that runs at import (a top-level initializer, an IIFE, a callback or
  timer it starts, a class's static field or block) is never accepted that way.

Uploads stay open on the sandbox because the reset empties the bucket. The same file checks that
it still does. The reset logs an error (with a `warnings` entry in its JSON) whenever uploads
would land somewhere it does not empty: `STORAGE_PROVIDER` / `STORAGE_BUCKET` pointing elsewhere,
or an `R2_S3_ENDPOINT` / `R2_S3_PUBLIC_ENDPOINT` whose origin is not
`https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`.

**Authored HTML renders through `sanitizeAuthoredBlockHtml`.** It lives in
`@nextblock-cms/utils` (`libs/utils/src/lib/authored-html.ts`; `lib/blocks/inlineScriptNonce.ts`
re-exports it). Text blocks, product short descriptions, string `description_json`, custom-block
rich text, the CMS editors' previews and the editor's SVG node all pass through it. It strips
script, meta, base, link, object and embed elements, every complete `on*` handler and `srcdoc`,
and `javascript:` / `vbscript:` / `data:text/html` URLs in URL attributes (read the way the URL
parser reads them: character references decoded, spaces, tabs and newlines dropped, so
`&#x6A;avascript:` and `java&#9;script:` count), and it escapes a tag left open at the end. A handler or `srcdoc` name it
cannot delete whole (right after a quoted value, or with a quoted value that never closes) is
neutralised instead (`onerror` → `&#111;nerror`): the reference decodes in text and values, so
look-alike text reads as authored, but never in an attribute name. A text block whose
`html_content` is Tiptap JSON (`isTiptapJsonString`) skips the sanitizer in `BlockRenderer` and
`TextBlockRenderer` and renders through React (`SimpleTiptapRenderer`, whose string fallback is
sanitized). That exemption never goes inside the sanitizer: the raw sinks inject JSON-parseable
strings as HTML.
`tools/scripts/html-sinks.test.ts` (in `security:check`) fails on a module that writes HTML into a
page without an `HTML_SINKS` entry (`tools/scripts/lib/html-sinks.js`), and on a sanitized sink
that stops calling the sanitizer. Covered sinks: `dangerouslySetInnerHTML`, `srcDoc` / `srcdoc`
(props, keys and `setAttribute`), html-react-parser, `innerHTML` / `outerHTML` / `srcdoc`
assignments, `insertAdjacentHTML`, `setHTMLUnsafe` / `parseHTMLUnsafe`, `createContextualFragment`,
`DOMParser`, `write` / `writeln` on a document, `execCommand('insertHTML')`, a `text/html` Blob. A
module that only renders HTML its callers sanitized (`ClientTextBlockRenderer`) may be imported by
those callers alone. `HtmlContent` (`@nextblock-cms/editor`) and `HtmlScriptExecutor` (the app),
which ran every script in the HTML they were given, were deleted on 2026-11-04 (editor 0.23.0). A
component like them would be listed with `noCallers`: then any import or value use of it fails
(dynamic imports, namespace members and destructured keys included; a type-only import does not
count; the match is by name), and a barrel in its `allowedImporters` may re-export it only under
its own name.

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
  quota on the AI routes so a WRITER cannot drain the operator's model key. Until `02025` the
  post-apply grant pass re-granted it to `anon` and `authenticated` on every deploy (RLS still
  returned nothing, but a WRITER could issue DELETEs against their own counter); both apply
  paths now revoke it again.
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
`Forbidden` and return the service-role client. Since 2026-10-21 `getCmsActor()` is also null for
a session that has not passed an enrolled second factor (`evaluateTwoFactor()`; trusted devices
pass): the service role ignores every aal2 policy and a server action never goes through the CMS
layout's 2FA redirect, so the helper itself must enforce it. `getEcomActorRole()` /
`requireEcomAdmin()` in `libs/ecommerce/.../server-actions/require-ecom-role.ts` are the lib
equivalents; they apply the same rule through the gate the app registers
(`lib/auth/second-factor-gate.ts`, from `cms-actor.ts` and `instrumentation.ts`) and, with no gate
registered, fail closed for any enrolled account that is not a TOTP session at aal2. Users: the
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
creates a table, view or sequence ships its `GRANT SELECT ON TABLE public.x TO anon` (only
for a publicly readable table) and `GRANT SELECT, INSERT, UPDATE, DELETE ... TO authenticated,
service_role` (and `ON SEQUENCE`, including the implicit sequence of a serial or identity
column, to `authenticated, service_role`) plus `ENABLE ROW LEVEL SECURITY` and policies in the same file, exactly as
`02003` does for the baseline; without the grant PostgREST answers 42501 whatever the policies
say. `npm run db:migrate:check` and `npm run generate:migrations-bundle` refuse a forward
migration that creates such an object without granting on it to an API role, and (since `02022`)
without an `ALTER TABLE … ENABLE ROW LEVEL SECURITY` for each new table in the same file — an
API-reachable table with RLS off exposes every row to the public key
(`tools/scripts/lib/migration-grants.js`: `findUngrantedObjects` + `findTablesWithoutRls`). Two places still apply blanket grants afterwards:
the sandbox reset (`ALTER DEFAULT PRIVILEGES ... GRANT ALL` in `generate-sandbox-reset.ts`) and
the post-apply pass of both apply paths (`lib/setup/schema-apply.ts` for `/setup`,
`tools/lib/migrate-core.mjs` for the build hook on every deploy), which then re-applies the
revokes in `API_ROLE_REVOKE_SQL` so a deployed or wizard-installed database matches a
CLI-migrated one.

`02025` (2026-10-21, grant-level hardening after review of `02021`–`02024`) removes three places
where RLS had become the only barrier, without changing any row a legitimate request reaches:

- **`anon` is read-only at the grant level.** The baseline and Supabase's historical default
  privileges gave `anon` INSERT/UPDATE/DELETE/REFERENCES/TRIGGER on every table, and no policy
  lets `anon` write anything (every anonymous write path runs server-side with the service
  role). Those grants, and `anon`'s USAGE/UPDATE on sequences, are revoked; one permissive
  policy added by mistake can no longer publish a table for writing to the public key.
- **`cortex_request_log` is service-role only again** (see `02022` above).
- **`profiles.role` is pinned by column grants** (see `profiles` above). The column list is
  read from the catalog, so a column added later stays owner-editable as before; add a new
  sensitive column to the exclusions in the migration that creates it and in both copies of
  `API_ROLE_REVOKE_SQL`.

`02026` (2026-10-21, the follow-up `02025` left open) does the same for `authenticated`, which
still held SELECT, INSERT, UPDATE, DELETE, REFERENCES and TRIGGER on every table:

- **No write grant that no policy uses.** Where no permissive policy for `authenticated` or
  PUBLIC covers a command, the grant goes: INSERT/UPDATE/DELETE on `cortex_ai_db_mutation_audit`,
  `coupon_redemptions`, `email_2fa_challenges`, `freemius_plans`, `freemius_pricing`,
  `package_activations`, `privacy_consent_logs`, `thread_messages`, `ucp_cart_sessions` and
  `user_security_settings`; INSERT/DELETE on `message_threads`, `product_inquiries` and
  `system_alerts` (their ADMIN UPDATE stays); UPDATE/DELETE on `site_script_revisions` (append-only;
  the ADMIN INSERT stays); INSERT/UPDATE on `user_trusted_devices` (the owner DELETE stays). SELECT
  is untouched everywhere. Every app write to these runs server-side with the service role, so
  the only visible change is that such a statement over the cookie client now fails with
  "permission denied" instead of RLS matching no row. One CMS action did that silently:
  `updateFreemiusOverride` (`libs/ecommerce/.../products/actions.ts`) had always reported success
  while RLS dropped its UPDATE, and now reports the error.
- **REFERENCES and TRIGGER** are revoked on every table (DDL-only; no API request uses them).
- Foreign-key actions are unaffected: `ON DELETE CASCADE` / `SET NULL` run as the owner of the
  referencing table, so deleting a product or an order still removes its Freemius plans, prices
  and coupon redemptions.
- The migration opens with a pre-flight that re-reads `pg_policies` and aborts, changing
  nothing, if a policy now covers any command it would revoke. The tables `currencies`,
  `inventory_items`, `form_endpoints`, `coupon_freemius_mappings` and `system_configuration` are
  not on the list: they carry ADMIN write policies for `authenticated`, so they keep their
  grants.

`02027` (2026-10-21, the read side) does the same for SELECT, which both roles still held on every
table:

- **No SELECT that no policy uses.** `anon` loses SELECT on the 29 tables no permissive policy lets
  it read: `content_drafts`, `cortex_ai_db_mutation_audit`, `coupon_freemius_mappings`,
  `coupon_products`, `coupon_redemptions`, `coupons`, `email_2fa_challenges`, `form_endpoints`,
  `mcp_access_tokens`, `message_threads`, `order_items`, `orders`, `package_activations`,
  `page_revisions`, `post_revisions`, `privacy_consent_logs`, `product_drafts`,
  `product_freemius_sale_coupons`, `product_inquiries`, `product_revisions`, `profiles`,
  `site_script_revisions`, `system_alerts`, `system_configuration`, `thread_messages`,
  `ucp_cart_sessions`, `user_addresses`, `user_security_settings` and `user_trusted_devices`.
  `authenticated` loses it on `email_2fa_challenges` and `ucp_cart_sessions` (service role only).
  The public site keeps every table it renders (pages, posts, blocks, navigation, products and
  their variants, media, Freemius plans, currencies, shipping and tax, site settings and themes).
- **A read reaches tables the request never names.** A policy subquery (`EXISTS (SELECT … FROM
  x)`), a `security_invoker` view, an invoker function and a PostgREST embed
  (`select=*,x(...)`) read `x` as the calling role, and fail with 42501 once its SELECT is gone,
  where RLS used to return no row or a null embed (a failed embed fails the whole request). The
  census before the revoke found one such policy (`order_items`' owner policy reads `orders`; it
  is `TO authenticated`, which keeps SELECT on `orders`), one view (`profile_cards`), one
  invoker RPC (`apply_order_inventory_deduction`, service role only in the app), no anonymous
  embed of a listed table, and a few signed-out cookie-client reads (draft lookups in draft mode
  or with `NEXTBLOCK_VISUAL_EDITING_ENABLED`, `verifyPackageOnline` without a service key, the
  MCP route's revision capture, a custom block's `profiles` relation) that already got no row
  and handle the error the same way.
- **The author card needs no SELECT on `profiles`.** `author()` returns `profile_cards` rows from
  `private.author_card()` (`SECURITY DEFINER`), so `cms_interactions?select=*,author(...)` keeps
  working for `anon` (checked through PostgREST). `profile_cards` itself is a `security_invoker`
  view over `profiles`, so it loses `anon` SELECT and `authenticated` INSERT/UPDATE/DELETE. A direct
  `profiles(...)` embed as `anon` now answers 42501 instead of `null`: use `author()`.
- The pre-flight aborts, changing nothing, if a policy lets the role read a listed table, a
  policy the role is subject to reads one, or a view the role can read depends on one. Function
  bodies are not in the catalog's dependency graph; check invoker functions by hand when adding
  a table to the list.

`API_ROLE_REVOKE_SQL` lists these tables by name, not from `pg_policies`: computed from the
policies, the pass would hand a table back on the deploy after a permissive policy was added
by mistake, which is exactly the failure grant-level hardening exists to stop. To open one of
these privileges to a role, add the policy and the GRANT in a migration and remove the table
from both copies of the list.

Both apply paths repeat these revokes after their blanket grants. A revoke a forward migration
makes from `anon` or `authenticated` that the blanket grants hand back must be added to
`API_ROLE_REVOKE_SQL` in both files; `tools/scripts/migration-grants.test.ts`
(`findRevokesUndoneByGrantPass`) fails until it is, and replays the `cortex_request_log` case
against the pre-`02025` pass to prove it would have caught it. A table or view a forward
migration creates with narrower grants than the pass (granted to `service_role` alone, say) is
widened without any revoke to undo; `findGrantsWidenedByGrantPass` compares what the migrations
grant `anon` and `authenticated` on it with what is left after `GRANTS_SQL`, and replays
`02021`'s `profile_cards` (whose writes the pass handed `authenticated` until `02027`) against the
pre-`02027` pass. `security-verify.sql` sections
18–25 are catalog-level assertions run on top of the behavioural ones: RLS on every `public`
table, no `SECURITY DEFINER` function in `public` callable by an API role or outside the
allowlist, no `USING (true)` / `WITH CHECK (true)` policy for `anon`, `authenticated` or
PUBLIC on the sensitive tables (profiles, orders, order items, coupons, license activations, MCP
tokens, revision history, 2FA, addresses, carts, consent and AI logs, site settings, messages),
`anon` write grants, the `cortex_request_log` grants and the `profiles` column grants. Sections
26–27 (`02026`) assert that `authenticated` holds an INSERT/UPDATE/DELETE only where a policy
lets it use it, that every such policy has its grant (a table left in `API_ROLE_REVOKE_SQL`
after its policy was added), and no REFERENCES/TRIGGER, then check the behaviour (grant-level
denials even for an `aal2` ADMIN, the kept policies, FK cascades, service-role writes). Sections
28–29 (`02027`) do the same for SELECT (no grant without a SELECT/ALL policy, or for
`authenticated` an UPDATE/DELETE policy whose WHERE reads columns; no read policy without its
grant; every view `security_invoker` and readable only by roles that can read its tables), then
check that the public site's tables, a product page's embeds and the `author()` card still read
for `anon` while orders, profiles, coupons, revisions, drafts, tokens and 2FA do not. Run the
script on a database that went through the post-apply pass (a deployed one, or a replay followed
by `GRANTS_SQL`): that is where grant regressions appear.

`02028` (2026-10-21 audit, each hole reproduced over PostgREST on a local replay) closes five
more:

- **`site_settings` writes: `WRITER` on an allow-list.** The `WRITER` branch of the three write
  policies was a deny-list, so a `WRITER` could `PATCH site_settings?key=eq.email_public` to
  point SMTP at their own server; `lib/config/email-settings.ts` pairs that host with the
  decrypted ADMIN-only `email_secret`, so the SMTP password and every outgoing mail (ADMIN email
  2FA codes included) went to them. Captcha, payment, invoice, notification-address,
  `migration_baseline_generation` and Cortex keys were open the same way. Writes now have three
  tiers (see "Important Site Settings in Active Use"): the `WRITER` allow-list, two `ADMIN`
  keys, and every other key, new ones included, behind `is_admin_mfa()`. The three ADMIN
  actions that still upserted an above-staff key with the cookie client moved to the service
  role after `requireCmsAdmin()` (`saveInvoiceSettings`, `saveStoreContactEmail`, the
  interactions notification addresses); two of them had failed for an `aal1` admin since
  `02023`, because an upsert's `ON CONFLICT` path checks the read policy.
- **The email second factor counts in RLS.** `meets_aal_requirement()` treated "no verified
  `auth.mfa_factors` row" as "no factor", but the app's email factor never creates one (only
  TOTP does), so for an email-2FA ADMIN every `is_admin_mfa()` policy was a plain role check:
  a stolen password and an `aal1` JWT minted MCP tokens and read license keys, secrets and
  other profiles. The no-factor branch now also requires that no `user_security_settings` row
  has `mfa_enabled AND mfa_type IS NOT NULL`. An email factor never yields an `aal2` Supabase
  session, so for those admins the `is_admin_mfa()` rows are reachable only through the service
  role after `getCmsActor()` (which refuses a session whose factor is pending). Every CMS screen
  reads them that way (the "remember this device" TOTP admin needed the same since `02023`).
- **The remaining ADMIN branches need the second factor:** `site_scripts` and
  `site_script_revisions` writes (scripts carry the CSP nonce on every route, `/cms` included),
  `cms_redirects` writes, every command on `system_configuration`, and the reads and updates of
  `product_inquiries`, `message_threads` and `thread_messages`. Their CMS actions run on the
  service role after `requireCmsAdmin()` / `getCmsActor()` (site scripts,
  `updateSystemConfiguration`, the SEO redirects, `app/cms/messages/require-admin.ts`).
- **`media` keys.** `media_insert_policy` pins `uploader_id` to the caller (ADMIN may attribute
  a row to anyone). Nothing pins `object_key` or `variants`, so the delete and move actions in
  `app/cms/media/actions.ts` only touch the keys derived from the row's own `object_key`
  (`lib/storage/media-object-keys.ts`: same folder and base name, as the upload pipeline writes
  them) and never delete a key another row still references
  (`public.media_storage_keys_in_use(keys, exclude_id)`, `SECURITY INVOKER`, service-role only;
  the actions keep every key if the check cannot run). Before, a `WRITER` could insert a decoy
  row listing another uploader's keys and delete their files.
- **`package_activations.license_key` and `.meta`** are no longer readable by `authenticated`
  (the public demo signs visitors in as a factor-less ADMIN). Table SELECT goes and comes back
  per column, from the catalog, like `profiles` in `02025`; `meta` holds the Freemius activation
  response (install API token). Every app read uses the service role.

`security-verify.sql` sections 30–34 cover these. Their hole checks print FAIL on a replay
through `02027` when the script runs under `psql`; under `npm run security:db-posture` the
post-apply pass already carries the `package_activations` revoke, so section 34 passes there
before the migration.

Left open by `02028`: `enabled_payment_providers` and `ecommerce_inventory_settings` are still
written with the cookie client (`libs/ecommerce` payments, shipping and taxes actions); moving
those writes to the service role lets them join the `is_admin_mfa()` tier. A `WRITER` can still
delete an unreferenced media-extension object whose key they guess, by inserting a row that
names it and deleting the row.

`02029` / `02030` (2026-10-27, the Affiliates & Creator Storefronts package; the full reference
is [15-AFFILIATES-AND-STOREFRONTS.md](./15-AFFILIATES-AND-STOREFRONTS.md)):

- **The `RTL` role and the text-compare rule.** `02029` adds `RTL` to `public.user_role` and
  nothing else: PostgreSQL refuses to use an enum label inside the transaction that added it
  ("unsafe use of new value"), and every apply path runs one transaction per file. The sandbox
  reset replays every migration in ONE transaction, though, where the label is never committed
  before `02030` runs. So no migration resolves the label at create or apply time: policies
  compare `(SELECT public.get_current_user_role())::text = 'RTL'`, functions
  `role::text = 'RTL'`, and `'RTL'` is assigned only inside a plpgsql body, which resolves it
  when the function runs. `findEnumRtlLiterals` (`tools/scripts/lib/migration-grants.js`,
  tested in `migration-grants.test.ts`) refuses `'RTL'::public.user_role` (any quoting or
  spacing, `CAST('RTL' AS user_role)`, a `'{…RTL…}'::user_role[]` literal) outside a plpgsql
  function body in every forward migration of generation 02 and later. In TypeScript the
  generated `user_role` type lacks `RTL` until `npm run db:types` runs against a migrated
  project, so app code compares `String(role) === 'RTL'` and writes the value through an untyped
  client or the RPC.
- **Who reads and writes.** `anon` reads the active tiers and nothing else of the package.
  `authenticated` reads tiers, profiles, pages, commissions and payouts through owner-or-ADMIN
  policies (`is_admin_mfa()`), and writes only tier CRUD (ADMIN, aal2) and the self-service
  columns: `UPDATE (display_name, bio, social_links, preferred_locale)` on `affiliate_profiles`
  while the caller is an ACTIVE RTL, `UPDATE (title, meta_description, draft_content,
  featured_product_ids)` on `affiliate_pages` while the caller is an RTL with an ACTIVE profile
  and the page is not in review. No API role
  inserts or deletes a profile or page (accounts come only from `create_affiliate_account()`;
  deleting one would erase the ledger), the ledger has no write policy at all, and the click log
  and the payout runs are service-role only (RLS on, no API policy).
- **Guards behind the grants.** `private.affiliate_profile_guard()` refuses a session that is not
  `is_admin_mfa()` changing any other profile column (42501), and changing `display_name`, `bio`
  or `social_links` while the partner's page is `PENDING_REVIEW` (55000, the review lock; server
  writes without a session are held by the app, whose Approve pins the profile the reviewer saw).
  `private.affiliate_page_guard()` refuses it on review and publication columns (42501) and
  refuses every draft write while the page is `PENDING_REVIEW` (55000, the service role
  included).
- **Functions.** Every definer is in `private` with `search_path ''`. The four anonymous
  storefront reads (`get_affiliate_storefront`, `list_affiliate_storefronts`,
  `get_affiliate_referral_window`, `record_affiliate_click`) are invoker wrappers in `public`
  that revoke from PUBLIC only and grant the API roles (revoking from `anon` /
  `authenticated` and granting back is not credited by the lint). The thirteen money, dispute and
  signup RPCs are `SECURITY INVOKER` in `public`, revoked from PUBLIC, `anon` and
  `authenticated`, and granted to `service_role`. The orders triggers record a commission once
  when `paid_at` is set and void it on `refunded` / `cancelled` or a delete.
- **The grant pass.** Both copies of `API_ROLE_REVOKE_SQL` carry the `02030` blocks: `anon`
  loses SELECT on profiles, pages, commissions and payouts; `authenticated` loses INSERT, UPDATE
  and DELETE on those four, with the two column UPDATE grants given back; every privilege on the
  click log and the payout runs is revoked; EXECUTE is revoked on each service-role RPC by exact
  signature (`to_regprocedure('public.apply_affiliate_refund(public.affiliate_gateway, uuid,
  bigint, bigint, boolean)')`), including `set_affiliate_commission_dispute(public.affiliate_gateway,
  uuid, boolean)` and `prepare_affiliate_payout_retry(uuid, bigint)` (the retry's old `(uuid)`
  overload is dropped, so a one-argument call still resolves). `migrate-core.test.mjs` pins the
  `02030` block.
- **Posture.** `security-verify.sql` sections 35–38 with 37b (72 assertions; 206 in the file then,
  218 since `02035`'s section 39)
  check it all on a local replay: §35 grants, column pins, function privileges (the retry has one
  overload) and one permissive policy per role and command; §36 sign-up through
  `create_affiliate_account()`, the partner and anon seats and the profile review lock; §37 the
  ledger (one commission per paid order, refunds that adjust, void, alert or leave a tombstone,
  the refund share on the charge without its shipping share, the plus-address self-referral,
  claim → complete, fail → retry → release); §37b key modes (a test-mode account claims only
  test-mode sales, a `FAILED` payout is never retried in the other mode, an account of unknown
  mode claims nothing), the retry minimum (`below_minimum`), a partial refund kept on the order
  before the commission exists, and dispute holds; §38 reconcile (a refund kept while the partner
  was suspended reduces the commission reconcile records), the notification claim, the payout-day
  claim, order and partner deletes. The affiliate tables also joined the sensitive-table list of
  §20 and the lists of §29. On a database before `02030`, §20 and §29 fail and §35–38 stop at
  their first line.
- **The app rule.** These policies are defense in depth. Portal and CMS writes run on the service
  role after `requireRetailer()` / `requireCmsAdmin()`, where RLS is not a boundary, and every
  reader treats `affiliate_pages.draft_content` as untrusted: a partner can PATCH it over the
  Data API.
- **Partner uploads are not media.** Avatars and storefront images live under
  `affiliates/avatars/…` and `affiliates/pages/…` (`PARTNER_UPLOAD_NAMESPACES`; server-built keys,
  `lib/affiliates/upload-keys.ts`). `/api/media/record` refuses any such key and the `/cms/media`
  delete and move actions skip them (`isPartnerUploadKey` in `lib/storage/upload-policy.ts`,
  re-exported by `lib/storage/media-object-keys.ts`), so the decoy-row trick `02028` closed for
  media cannot reach a partner's files either. The rest of `affiliates/` is ordinary media.

`02032` (2026-11-03) is data only: the Affiliates license product page on nextblock.dev, EN + FR.
It runs only on a database that holds the NextBlock Commerce Pro store product (Freemius
`24851`), which only the vendor store has, so it skips on every other install and on the sandbox
replay (the reset route dresses the sandbox's product). It creates the English row the way the
Freemius store sync would (SKU `FM-43273-75655`, a draft), with its plan and single-site pricing,
the French twin in the same translation group, the bundled cover and the Software category, and
writes the copy of `affiliates-product-copy.ts` only to rows it created, rows without
description blocks, or rows still carrying that copy. `tools/scripts/affiliates-product-migration.test.ts`
fails when the migration and the copy file, or the migration and the package registry, drift.

`02035` (2026-11-11, the Affiliates tier move; docs/15 → "The amount" and "The CMS screens"):

- **The rate at payment.** `private.affiliate_snapshot_order_rate()` (a `SECURITY DEFINER`
  trigger function in `private`, `search_path ''`, revoked from PUBLIC, `anon` and
  `authenticated`) runs BEFORE INSERT OR UPDATE OF `paid_at` on `orders` and copies the partner's
  tier rate and hold onto an attributed order when it is paid; it swallows every error, so an
  order write never fails because of it. `private.affiliate_record_commission()` is replaced with
  02030's body except that it records the stored rate (else the current tier's), clears at
  `paid_at` + the stored hold, and starts the commission held (`disputed_at`) when the order kept
  a dispute from before the commission existed. The new `orders` columns ride the existing table
  grants (an aal2 ADMIN already writes every `orders` column; customers write none).
- **Disputes before the commission.** `public.set_affiliate_commission_dispute(...)` is replaced
  with 02030's body (same signature, `SECURITY INVOKER`, `search_path ''`, revoke restated; its
  `API_ROLE_REVOKE_SQL` entry dates from 02030) plus one branch: an attributed order with no
  commission yet keeps an open dispute in `orders.affiliate_disputed_at` (cleared when it closes
  without a loss), so a late commission whose hold, counted from the payment, has already passed
  is not promoted and paid in the run that records it. It takes the order row lock first, then the
  profile, like `apply_affiliate_refund`.
- **The tier move.** `public.change_affiliate_partner_tier(uuid, uuid, boolean)` is `SECURITY
  INVOKER`, revoked from PUBLIC, `anon` and `authenticated`, granted to `service_role`, and added
  to both copies of `API_ROLE_REVOKE_SQL` (`migrate-core.test.mjs` pins the entry,
  `migration-grants.test.ts` fails without it).
- **`tier_changed_at`** is stamped by `private.affiliate_profile_guard()` (replaced, 02030's body
  plus the stamp) for every writer, and joins the columns a non-admin session may not change; it
  is not one of the four self-service UPDATE column grants, so the Data API never writes it.
- **Posture.** `security-verify.sql` section 39 (12 assertions; 218 in the file) checks the RPC's
  and the trigger function's privileges, the trigger's shape, the `tier_changed_at` pin (column
  grant and guard), every RPC outcome on a paused partner, that a commission recorded after a
  move and a rate edit keeps the rate of its payment, and that a dispute opened before a late
  commission existed holds it past its hold until the dispute is won. On a database before
  `02035`, section 39 stops at its first line.

`02036` (2026-11-11, Affiliates commissions paid outside Stripe; docs/15 → "Paying partners
manually"):

- **A new claim signature.** A new parameter makes a new function, so the migration drops
  `public.claim_affiliate_payout(uuid, text, bigint, text)` and creates
  `claim_affiliate_payout(uuid, text, bigint, text, public.affiliate_gateway[] DEFAULT NULL)`
  (02030's body plus the gateway filter; `SECURITY INVOKER`, `search_path ''`, revoked from PUBLIC,
  `anon` and `authenticated`, granted to `service_role`). A four-argument call still resolves to it.
- **The manual payout lifecycle.** Three service-role RPCs of the same kind (`SECURITY
  INVOKER`, `search_path ''`, revoked from PUBLIC, `anon` and `authenticated`, granted to
  `service_role`), so the commissions a manual payout covers are fixed before any money leaves:
  `public.claim_manual_affiliate_payout(uuid, text, bigint, public.affiliate_gateway[])` locks the
  profile, then the commissions, and attaches the partner's cleared, unattached, live-mode,
  undisputed commissions of the manual gateways to one `PROCESSING` manual payout;
  `public.record_manual_affiliate_payout(uuid, text, text, text, uuid)` locks the profile, the
  commissions and the payout (`complete_affiliate_payout`'s order) and completes exactly that
  payout with its channel, reference, note and `recorded_by`; `public.cancel_manual_affiliate_payout(uuid)`
  applies the refund work flagged while it was prepared, detaches the rest and deletes the row.
  `recorded_by` comes from the CMS session in the app, never from the request.
- **The grant pass.** Both copies of `API_ROLE_REVOKE_SQL` add guarded (`to_regprocedure(...)`)
  EXECUTE revokes for the five-argument claim and the three manual payout functions, after the
  existing four-argument claim entry, which stays: `findRevokesUndoneByGrantPass` holds 02030's
  revoke of it to the pass, and a database before 02036 still has that overload.
  `migrate-core.test.mjs` pins the entries.
- **No new grant.** The new `affiliate_payouts` columns ride the table's existing grants (SELECT
  for `authenticated`, own rows through the profile; no API write). `affiliate_profiles.payout_email`
  gets no column grant (the four self-service UPDATE columns are unchanged), so only the service
  role writes it (the portal's `saveRetailerPayoutEmail`, after `requireRetailer()`, on the
  actor's own row, refused on the sandbox), and `private.affiliate_profile_guard()` (replaced:
  02035's body plus the new column in the protected list) refuses a non-admin session changing
  it; its CHECK refuses whitespace and a first character a spreadsheet reads as a formula (`=`
  `+` `-` `@`), which the PayPal file could only carry by changing the address. CHECKs keep a
  manual payout `PROCESSING` or `COMPLETED` (never `FAILED`), free of any Stripe destination or
  transfer id, with a channel, reference and `paid_at` once `COMPLETED`, and a Stripe payout with
  its destination; a unique index on `(affiliate_id, lower(external_reference))` refuses a reused
  reference, and a unique partial index on `(affiliate_id, currency)` of the `PROCESSING` manual
  payouts keeps one prepared payout per partner and currency.
- **The refund alert.** `private.affiliate_alert_refund_after_payout()` is replaced with 02030's
  body plus advice by the payout's method and status (recover the amount from the partner after a
  recorded manual payout; cancel and prepare again, or record and recover, while it is only
  prepared) and `metadata.payout_method` / `payout_status`; definer in `private`, revoked from
  PUBLIC, `anon` and `authenticated`.
- **Posture.** `security-verify.sql` section 40 (13 assertions; 231 in the file) checks the four
  RPCs' privileges (one claim overload, no record overload of the first 02036 draft), the payout
  CHECKs and the one-prepared index, the `payout_email` pin (no write grant, the guard, a CHECK on
  the server write, a leading formula character refused), that no API role writes a payout row,
  every refusal of the claim and of the record, the claim's exact scope, the in-flight rules while
  a payout is prepared, the record and the cancel, that `complete_`, `fail_`,
  `prepare_affiliate_payout_retry` and `release_affiliate_payout` never change a manual payout,
  that the claim with `{STRIPE}` never takes a Freemius commission, and the refund advice; section
  35 pins the five-argument claim. On a database at `02035`, sections 35 and 40 stop at their
  first line.
- **UI copy.** Section 7 of 02036 writes only `public.translations` (data, no grant): 48 new
  `affiliates.portal.*` / `affiliates.terms.*` keys with `ON CONFLICT (key) DO NOTHING`, and 21
  reworded rows, one `UPDATE … FROM (VALUES …)` per language guarded by the text 02031 seeded
  (docs/15 → "i18n").

`02037` (2026-11-11, Affiliates automatic PayPal Payouts; docs/15 → "Paying partners with
PayPal"):

- **Six service-role RPCs** (`SECURITY INVOKER`, `search_path ''`, `#variable_conflict
  use_column`, revoked from PUBLIC, `anon` and `authenticated`, granted to `service_role`):
  `public.claim_paypal_affiliate_payout(uuid, text, bigint, public.affiliate_gateway[], boolean,
  text)` (profile, then commissions; the PayPal gateways and the environment's `livemode`; the
  payout email snapshot as `paypal_receiver`), `record_paypal_affiliate_payout_batch(uuid[], text,
  text)` (a call without a batch id stamps the send: `last_attempt_at`, `attempt_count` on a resend),
  `note_paypal_affiliate_payout_item(uuid, text, text, bigint)`,
  `complete_paypal_affiliate_payout(uuid, text, text, bigint, text)` (exactly once; a transaction id
  is never recorded twice), `fail_paypal_affiliate_payout(uuid, text, text)` (applies the refund
  work flagged in flight, then hands the rest back; always a `paypal_` reason) and
  `release_paypal_affiliate_payout(uuid)` (the CMS Release, with its rule checked under the payout
  lock: an unacknowledged batch an hour after its last send, an acknowledged one a week after it while
  PayPal holds no money for its item).
- **The grant pass.** Both copies of `API_ROLE_REVOKE_SQL` add guarded EXECUTE revokes for the six
  functions after the 02036 entries; `migrate-core.test.mjs` pins them (and that `GRANTS_SQL` never
  names the PayPal columns, the payout email columns or the secret key).
- **No new grant.** The `affiliate_payouts.paypal_*` columns and
  `affiliate_profiles.payout_email_kind` / `payout_email_saved_at` ride the tables' existing grants
  (no API write), the method CHECK accepts `paypal`, 02036's manual status CHECK is replaced by name
  and scoped to `method = 'manual'` (it refused a FAILED PayPal payout, so the PayPal failure path
  could never run), PayPal CHECKs keep the fields to PayPal rows (ids and statuses in PayPal's shape,
  a completed payout with its transaction id, a FAILED one with a `paypal_` reason, which makes the
  Stripe `fail_` / `release_affiliate_payout` and `prepare_affiliate_payout_retry` raise on a PayPal
  payout), unique partial indexes keep one payout in flight per partner, currency and mode and each
  item and transaction once, and `private.affiliate_profile_guard()` (replaced: 02036's body plus
  `payout_email_kind` and `payout_email_saved_at`) refuses a non-admin session changing them.
- **The secret row.** A RESTRICTIVE policy `site_settings_paypal_secret_service_only_policy` (FOR
  ALL TO `anon`, `authenticated`) excludes the `affiliates_paypal_secret` key, so only the service
  role reads or writes the PayPal credentials (the secret itself is the app's encrypted envelope).
- **The refund alert.** `private.affiliate_alert_refund_after_payout()` is replaced with 02036's
  body plus the PayPal advice (in flight: applied if PayPal returns or fails it; paid: recover it)
  and `metadata.payout_method = 'paypal'`.
- **Posture.** `security-verify.sql` section 41 (15 assertions; 246 in the file). On a database at
  `02036`, section 41 stops at its first line.
- **UI copy.** Section 7 of 02037 writes only `public.translations` (data, no grant): 48 new
  `affiliates.portal.*` / `affiliates.terms.*` keys with `ON CONFLICT (key) DO NOTHING` (the
  partner portal's PayPal or Interac e-Transfer choice and PayPal wording, "try PayPal again", the
  header and FAQ of programs mixing Stripe or manual payouts with PayPal, the terms' PayPal clauses
  and Program details rows) and 6 reworded rows, one `UPDATE … FROM (VALUES …)` per language guarded
  by the text 02036 seeded (docs/15 → "i18n"). The CMS is English-only and the email copy is internal.

`02038` (2026-11-04 review of the SMTP credential handling) takes the secret rows of
`site_settings` away from every API session. The `is_admin_mfa()` branch of the read, insert,
update and delete policies admitted every key, so an ADMIN on an `aal2` session (or one who never
enrolled a factor, at `aal1`) could read and write `email_secret`, `payment_secret`,
`bot_protection_secret` and the Cortex AI keys over PostgREST. The envelopes were not bound to
their row, so copying the Stripe key's envelope into `email_secret.pass`, saving an SMTP host of
their own and clicking "Send test email" delivered the plaintext through SMTP AUTH; an XSS running
as that admin could do the same. Mail never reads the database on the sandbox, so it was not
reachable there. Two layers close it:

- **The secret rows are service-role only.** The `is_admin_mfa()` branch of all four policies now
  stops at `email_secret`, `payment_secret`, `bot_protection_secret`,
  `cortex_ai_openrouter_api_key`, `cortex_ai_pexels_api_key`, `cortex_ai_unsplash_access_key`,
  `cortex_ai_mcp_settings`, and any key whose name ends like a secret (`_secret`, `_secret_key`,
  `_api_key`, `_access_key`, `_private_key`, `_token`, `_password`, `_credential(s)`, any case;
  the pattern Cortex's DB tools already refuse). Nothing else moves: the rest of the ADMIN tier
  keeps the second factor, and no grant changes, so `API_ROLE_REVOKE_SQL` is untouched. Every
  reader and writer of these rows already ran on the service role after its own role check
  (email, payments, bot protection, the Cortex settings, wizard and MCP actions, the resolvers).
- **Envelopes are bound to their slot** (`libs/db/src/lib/secret-crypto.ts`). A version 2
  envelope is sealed with its slot as AES-GCM associated data: `site_settings:<key>:<field>` for a
  field of the row (`site_settings:email_secret:pass`), `site_settings:<key>` when the row's value
  is the envelope (the Cortex AI keys). Build slots with `siteSettingSecretSlot()`; every sealer
  and reader must pass one (TypeScript requires it, and sealing without one throws), so each reader
  opens only its own slot and an envelope copied elsewhere reads as missing. The tag must be 16
  bytes, and relabelling a version 2 envelope as version 1 does not drop the binding. Version 1
  envelopes (before 0.23.1) still open in any slot; each screen re-seals the ones it holds on
  every save (`resealWithEnvKey`: email and payments on their form's save, bot protection when
  its field is submitted empty, `resealStoredCortexAiSecrets` on every save of the Cortex AI
  screen and the wizard's key steps). So after upgrading, save each of those screens once: until
  then a copied version 1 envelope still opens, but only the service role can copy one.

`security-verify.sql` section 42 (10 assertions, 256 in the file) checks that an ADMIN at `aal2`
and one without a factor read, update, copy, insert, upsert and delete no secret row, keys named
like a secret included, while both keep the rest of the ADMIN tier, `anon` reads none and the
service role reads and writes all of them. With the pre-`02038` policies restored on a replay,
seven of its lines fail. Section 16's aal2 and no-factor probes moved to `store_contact`. Not
covered by either layer: the Bot Protection screen shows the stored captcha secret in clear
(`getBotProtectionSettings`), where the other screens show at most its last four characters.

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
Export and restore are ADMIN-only and require a satisfied second factor. On the public sandbox
both answer 403 (`FULL_BACKUP_SANDBOX_MESSAGE`, refused at the end of `requireAdminUser()`): the
archive would hand out every account's password hash, and a restore writes accounts through
GoTrue. The archive holds:

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
- `ADMIN`: everything else — `interactions_notification_emails`, `payment_public`,
  `store_contact`, `forms_contact`, `affiliates_settings` (read and written with the service role:
  the notifier and the payout runner have no session), the Cortex model/agent keys and any key not
  listed above. Since `02023` this tier (and the
  ADMIN-only write tier) answers only to `is_admin_mfa()`: an ADMIN with a verified second factor
  must be on an `aal2` session, so CMS code reads and writes it with the service role after
  `requireCmsAdmin()` (`lib/auth/cms-actor.ts`) or `requireEcomAdmin()`, never with the cookie
  client (a "remember this device" admin is on `aal1` and would get nothing).
- the service role only (`02038`): the secret rows, `email_secret`, `payment_secret`,
  `bot_protection_secret`, `cortex_ai_openrouter_api_key`, `cortex_ai_pexels_api_key`,
  `cortex_ai_unsplash_access_key`, `cortex_ai_mcp_settings`, and any key ending in `_secret`,
  `_secret_key`, `_api_key`, `_access_key`, `_private_key`, `_token`, `_password` or
  `_credential(s)`. No API session reads or writes them, whatever its role or second factor; each
  holds envelopes bound to their slot (`02038` above).

Server code that reads a key for the public site with the service role is unaffected; code that
reads one with the cookie or SSG client for a visitor must use a public-tier key, or the loader
caches its fallback value (`unstable_cache` keeps whatever the first read returned).

Writes are tiered separately (`02028`; the three write policies are the only place these lists
live, and a key on neither list is in the last tier):

- `ADMIN` and `WRITER`: `site_title`, `site_description`, `site_keywords`, `site_social_image`,
  `active_logo_id`, `footer_copyright`, `footer_show_attribution`, `onboarding_state` — the keys
  staff code writes with the cookie client (site identity, footer, the dashboard's dismiss).
- `ADMIN`: `enabled_payment_providers`, `ecommerce_inventory_settings` — the keys ADMIN code
  still writes with the cookie client (`libs/ecommerce`).
- `is_admin_mfa()`: everything else but the secret rows, `email_public`, `bot_protection_public`,
  `payment_public`, `invoice_settings`, `store_contact`, `forms_contact`,
  `interactions_notification_emails`, `migration_baseline_generation`, `privacy_settings`,
  `global_css`, `security_settings` and the other `cortex_ai_*` keys among them. The app writes all
  of these with the service role after its own ADMIN check; a key a `WRITER` must write through
  the cookie client goes on the first list in a migration, never by widening the default.
- the service role only: the secret rows of the read list above (`02038`). A new secret goes
  under a name that ends like one (`<feature>_secret`, `<feature>_api_key`), so it lands here
  without a migration.

SMTP (`lib/config/email-settings.ts`) resolves `email_public` and `email_secret` DB-first with an
env fallback. A stored username or password counts only when it opens from its own field
(`site_settings:email_secret:user` / `:pass`, 2026-11-04): an envelope copied in from another row
reads as missing, so it never reaches SMTP AUTH. Two more rules apply (2026-11-03). Whenever `SMTP_HOST` is set, a username or password
taken from `SMTP_USER` / `SMTP_PASS` goes only to `SMTP_HOST`: SMTP AUTH hands the credentials to
whatever server the transport connects to, so a host saved in the CMS must not carry the
deployment's login. The port is the one saved in the CMS for that same server (no CMS host, or
`SMTP_HOST` itself, compared without case), else `SMTP_PORT`, else 587. A value that is not a port
(digits, 1 to 65535) counts as unset, except that with implicit TLS switched on for `SMTP_HOST` it
reads as 465, as nodemailer read it; the Email form refuses one on save. The CMS TLS toggle counts
only when the CMS host names `SMTP_HOST`, and it can only raise TLS above what the env alone gives.
A CMS port that moves the login off the env's own port must be encrypted (implicit TLS, or a
required STARTTLS; a loopback relay aside). So the database can neither move the login nor lower its
protection. Until 2026-11-04 an unset `SMTP_PORT` there sent no mail at all, email sign-in codes
included. Credentials saved in the CMS still go to the CMS host, and the Email screen says when a
saved host and port are ignored. One exception is kept for existing installs: with `SMTP_HOST` unset
(a split legacy setup, login in the env and host saved in the CMS), the env login still goes to the
CMS host, so an ADMIN who can save that host receives it (and picks its port and TLS, as before).
Set `SMTP_HOST`, or save the login in the CMS, to close it. On the sandbox, whose admin login is
public, the database is never read for mail, `saveEmailSettings` refuses before writing, and test
emails are off. `sendEmail` (`app/actions/email.ts`), the one mail transport, delivers there only to
`SANDBOX_CONTACT_EMAIL` and the product feedback inbox (`PRODUCT_FEEDBACK_INBOX`): every address in
`to` must be one of them, or it throws before reading the SMTP config. So a message reply, a comment
notice or a stored form recipient cannot mail an address a visitor chose.
