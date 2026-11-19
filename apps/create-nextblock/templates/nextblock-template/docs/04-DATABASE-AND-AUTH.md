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
- the unconfigured-client parts (`UNCONFIGURED_SUPABASE_URL`, `UNCONFIGURED_SUPABASE_KEY`,
  `unconfiguredSupabaseFetch`, `SUPABASE_NOT_CONFIGURED_CODE`; see "Unconfigured clients")
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

### Unconfigured clients

A project can build before anyone connects Supabase: the first `npm run build` or deploy of a
fresh scaffold or clone may come before `/setup` collects the credentials (`create-nextblock`
itself never builds, and its Docker profile builds with a URL and key). With no Supabase URL or no
key, `createClient()`
(server), `getSsgSupabaseClient()` and the app's `createStaticSupabaseClient()`
(`app/lib/site-settings.ts`) still return a client, built on `libs/db/src/lib/supabase/unconfigured.ts`
(exported from `@nextblock-cms/db/server`):

- its URL is `UNCONFIGURED_SUPABASE_URL` (`https://unconfigured.supabase.invalid`), which never
  resolves: RFC 2606 reserves `.invalid`;
- its `global.fetch` is `unconfiguredSupabaseFetch`, which answers every PostgREST, Auth, Storage
  and Functions request on the spot with HTTP 421 and the code `NEXTBLOCK_SUPABASE_NOT_CONFIGURED`
  (`SUPABASE_NOT_CONFIGURED_CODE`): no DNS lookup, no socket, no wait.

Callers treat that answer like any failed query and use their defaults, and while the install is
unconfigured the proxy redirects every request outside its setup allowlist to `/setup`. Half an
env (a URL without a key, or the reverse) counts as unconfigured, so stand-in credentials never
reach a real project.
`getServiceRoleSupabaseClient()` and the browser `createClient()` still throw.

Never fall back to a placeholder host. Until 0.23.5 the fallback was `https://dummy.supabase.co`,
on Supabase's real domain, and postgrest-js retries a failed GET three times, 1 s, 2 s and 4 s
apart: a fresh scaffold made about 1,300 connection attempts to it per build (2026-11-17). The
answer is a 4xx on purpose: auth-js retries any 5xx, postgrest-js a 503, a 520 or a rejected fetch,
and postgrest-js reads a 404 as an empty result. `libs/db/src/lib/supabase/unconfigured.test.ts`
and `apps/nextblock/app/lib/site-settings.test.ts` run each unconfigured client with the global
fetch stubbed and every socket refused, and `tools/scripts/supabase-host-literals.test.ts` fails
on a Supabase URL written into code in `apps/nextblock` (its build hook in `tools/` and its Node
`scripts/` included: both ship in every scaffold) or `libs`; tests, generated files, the stale
compiled `.js` twins beside `.ts` sources and the Deno edge function are out of its scope
(allow-list: `SUPABASE_HOST_LITERALS` in `tools/scripts/lib/supabase-host-literals.js`, with why).

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
  function) and `API_ROLE_REVOKE_SQL` (the explicit revokes of `02021`/`02022`/`02025`–`02028`/`02030`/`02035`–`02037`/`02043`/`02045`–`02047`) in
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
the lib's twin of the app's `requireCmsAdmin()` / `requireCmsStaff()` in `lib/auth/cms-actor.ts`;
both check the enrolled second factor, not just the role) at the top of every such action, or write
with the cookie client so RLS still applies. The 2026-10-19 pass found the inventory,
product-taxonomy, Freemius-sync and shipping-zone/rate actions and the checkout-success
order lookup all missing this; they now gate (financial order transitions are ADMIN-only, content
taxonomy is ADMIN/WRITER, checkout-success binds the order to its owner). Guest Freemius checkout
still works because the provider mints a capability token (HMAC of the order id,
`libs/ecommerce/src/lib/order-access-token.ts`) into the success redirect, which the action
accepts as a third authorization path alongside owner / staff. Since 2026-11-13 the staff path is
an ADMIN whose session passed its enrolled second factor (`getCmsActor()`), any other signed-in
account reads only its own orders, and a Stripe Checkout Session id reaches Stripe only when it is
well formed (`cs_test_` / `cs_live_`) and an order stores it in `stripe_session_id`, so made-up ids
never spend the operator's Stripe rate limit. Checkout hands out a session's URL only once its order
stores that id: when the write fails (an error, or no row updated) it expires the session (best
effort), marks the order `failed` and answers the keyed 503 `ecommerce.checkout_payments_unavailable`
instead, so a buyer never pays a session the success page would answer with "Order not found"
(`libs/ecommerce/src/lib/providers/stripe.ts`, `stripe/checkout.ts`).

**A server action takes the service-role client from a verified helper.** The helpers above check
the enrolled second factor and hand out the client; a role read through the cookie client followed
by a client the module builds itself checks the first factor alone. The dashboard package actions
(`app/actions/package-actions.ts`: `activatePackage`, `activatePurchasedPackage`,
`resendPurchasedLicenseEmail`, `deactivatePackage`) had that shape until 2026-11-13, so an ADMIN
password alone activated, deactivated and re-sent licenses. They now authorize with
`requireCmsAdmin()` after their sandbox refusal and write `package_activations` only with the
client it returns; a session whose enrolled factor is pending gets "Complete two-factor
verification, then try again." The check "server actions take the service-role client only from a
verified helper" in `tools/scripts/server-action-actors.test.ts` (in `security:check`) fails on any
`'use server'` module of the app or the libraries that builds a supabase-js client or resolves the
secret key itself, unless `OWN_SERVICE_CLIENT_ALLOWED` says why (`lib/setup/actions.ts`, the
`/setup` probe of the keys the operator typed), and on a listed module that no longer does.

**A role read is not a second factor.** A role read through the cookie client (or
`getProfileWithRoleServerSide()`) followed by `getServiceRoleSupabaseClient()` checks the first
factor alone just the same. Until 2026-11-13 six actions had that shape: `replyToInteraction` and
`updateInteractionStatus` (`app/actions/interactions.ts`), `updateLanguageDetectionSettings`,
`getFormEndpointForEditor`, `sendTestEmail` (`sendEmail` reads the SMTP credentials with the
service role) and `pollGithubConnect` (`markSyncWorkflowInstalled` writes `system_configuration`),
and the checkout success page's staff branch revealed any order the same way. The scan below then
found `submitFeedback` (`sendEmail` again) and the media delete and move actions
(`deleteMediaItem`, `deleteMultipleMediaItems`, `moveMultipleMediaItems` and `moveSingleMediaItem`:
storage deletes and copies with the deployment's credentials after the service-role
`media_storage_keys_in_use` read). They now resolve the actor with `getCmsActor()` /
`requireCmsAdmin()` (who may act did not change; a session whose enrolled factor is pending is
refused) and take the service-role client after it.
`findRoleReadsBeforeServiceRole` in the same test follows calls out of every server action under
`app/cms` and `app/actions` and fails one that can reach a role read (a `profiles` select naming
`role` or `*`, or `getProfileWithRoleServerSide()`) and the service role
(`getServiceRoleSupabaseClient()`, or a supabase-js client built from the secret key) but none of
`requireCmsAdmin`, `requireCmsStaff`, `getCmsActor`, `requireEcomAdmin`, `requireEcomStaff`,
`requireRetailer`, `requireRetailerPage` or `requireActorRole`. It is a presence check scoped to
those two trees (the public flows elsewhere reach the service role by design): it does not prove
the helper runs first or that its answer is honored, which the per-action tests do. Its reviewed
exceptions sit in `ROLE_READ_BEFORE_SERVICE_ROLE_ALLOWED`, each with why (a stale entry fails): the
one left is the security panel, whose `requireUser()` runs `evaluateTwoFactor()` itself.

**Route handlers check the second factor themselves.** A route handler never passes the CMS
layout's 2FA redirect either. Until 2026-11-14 the staff upload routes (`/api/media/r2-presigned`,
`/api/upload/presigned-url`, `/api/upload/proxy`, `/api/process-image`, `/api/media/record`) read
the role through the cookie client, so a staff password alone signed upload URLs, wrote and read
bucket objects and recorded media rows. Each now opens with `getCmsActor()` and refuses before it
reads the body or touches storage or the database: a signed-in user whose enrolled factor is
pending gets 403 "Complete two-factor verification, then try again.", no session gets 401, and a
role outside the route's rule gets 403 (who may upload did not change). `analyzeStaffRouteGates` in
`tools/scripts/server-action-actors.test.ts` checks that order from the code's structure for every
handler in `STAFF_UPLOAD_ROUTES`. It also fails a route module under `app/api/media/`,
`app/api/upload/` or `app/api/process-image/` that is neither listed nor reviewed
(`NOT_STAFF_UPLOAD_ROUTES`: the media picker's public read). `/api/media/record` still inserts with
the cookie client, so `media_insert_policy` applies too, but that policy checks the role, not the
factor (02028). Six more staff routes outside those folders read the role the same way until later
that day: `/api/cms/ecommerce/product-picker` (the catalog, drafts included, through the service
role), `/api/cms/check-updates` (`refreshUpstreamStatus()` writes `system_configuration` with the
service role) and `/api/ai/generate-blocks`, `/api/ai/seo/metadata`, `/api/ai/seo/alt-text` and
`/api/ai/cortex/build-widget` (the Cortex AI request quota, recorded with the service role, then the
operator's model key). They open with `getCmsActor()` too, with the same answers (the update check
stays ADMIN-only, the others ADMIN or WRITER), before the quota, the package check or the body.
`STAFF_ROUTES` holds them to the same structural check, with the Cortex AI client
(`createCortexAiOpenRouterClient`) as one more operation that must follow the refusals, and a route
module under `app/api/ai/` or `app/api/cms/` that is neither listed nor reviewed fails
(`NOT_STAFF_ROUTES`: the global agent and the full backup, which run `evaluateTwoFactor()`
themselves). Wherever a route lives, `findRouteRoleReadsBeforeServiceRole` in the same test follows
every HTTP handler of the app (through const aliases such as `export const PATCH = PUT` and
re-exports) and fails one that can reach a role read and the service role with none of the
second-factor helpers above; like the server-action check it is a presence check, and its reviewed
exceptions sit in `ROUTE_ROLE_READ_BEFORE_SERVICE_ROLE_ALLOWED`, each with why (the full-backup
restore, and the headless bootstrap, which authenticates with `MCP_BEARER_TOKEN` and reads the role
of the account it just created).

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

**A Freemius coupon push needs a verified admin.** The pushes (the exports of
`freemius-coupons.ts` that send a coupon, all listed in `FREEMIUS_COUPON_PUSHES`, or the test fails)
are signed with the Freemius developer key pair, which reaches every product of the account. Until
2026-11-13 four paths reached one with an ADMIN password alone: the coupon actions, the promotions
import, `createProductAction` and the visual-editing product publish. The same test
(`findUnauthorizedCouponPushes`) follows calls out of every server action through relative and
aliased imports, barrels, `export *`, namespace and dynamic imports, and functions
passed as arguments; method calls, `.call` / `.apply` / `.bind` and aliases are not followed, so
call a push directly. Every call toward a push must run after an awaited `requireEcomAdmin()` /
`requireCmsAdmin()`, judged by the code's structure, not by source position. The await is a whole
statement, a variable initializer or a plain `=` assignment, never behind `.catch()` / `.then()`,
`void`, `??=` or a ternary. It protects the later statements of its own block, so one inside an
if-branch or a loop protects only what follows inside it. Inside a try it counts only when the
catch ends in `return` or `throw` (it then also protects what follows the try), and never inside a
catch or finally. To reword a refusal, write
`let admin; try { admin = await requireCmsAdmin(); } catch { throw new Error('…'); }`, never
`requireCmsAdmin().catch(…)`. A wrapper counts only when every way it returns passes the check or
returns the helper's own promise, a name the function rebinds never counts, and a call inside a
nested function declaration counts from the start of its scope (hoisting).

**The public sandbox refuses what would outlive its reset.** Its admin login is published, and so
is the demo partner's once the Affiliates demo is configured (the second factor always reads
satisfied). Every reset:

- empties the bucket;
- deletes every auth user except the two preserved demo ids and `demo@nextblock.dev`, whatever its
  id (Step A of `tools/scripts/generate-sandbox-reset.ts`; their factors, sessions and identities
  go with them);
- rebuilds `public`, anchoring the kept users as `ADMIN` (Step E) and setting `is_admin_created`
  (Step F) inside the same transaction;
- restores the demo admin's password and deletes every second factor on it (`restoreDemoAdmin`),
  right after the SQL and before every later step (a failure in the bucket wipe, the seed upload or
  the SQL itself ends that run first);
- sets `is_admin_created` and the demo admin's `ADMIN` role itself (`pinSandboxAdmin`), the flag
  even when the restore failed, because a false flag sends every visitor to `/setup`. The proxy
  lets `/api/cron/reset-sandbox` through that gate, so the next run repairs such a state, and
  `provisionFirstAdmin` refuses on the sandbox, so `/setup` creates no account there (2026-11-13);
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
  timer it starts, a class's static field or block) is never accepted that way;
- a request signed with the Freemius developer key pair (`DEVELOPER_KEY_SIGNERS`) sits outside a
  refusal or a listed sandbox reader (`SANDBOX_DEVELOPER_READERS`: the reset's catalog reader), or a
  use of that reader, in any module, sits outside a refusal or a relay `DEVELOPER_KEY_CALLERS` names
  with its reason (`findDeveloperKeyProblems`). The sandbox env keeps the pair production depends
  on, for the reset alone: until 2026-11-13 the CMS Sync from Freemius spent it for any visitor.

Uploads stay open on the sandbox because the reset empties the bucket. The same file checks that
it still does. The reset logs an error (with a `warnings` entry in its JSON) whenever uploads
would land somewhere it does not empty: `STORAGE_PROVIDER` / `STORAGE_BUCKET` pointing elsewhere,
or an `R2_S3_ENDPOINT` / `R2_S3_PUBLIC_ENDPOINT` whose origin is not
`https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`.

**Authored HTML renders through `sanitizeAuthoredBlockHtml`.** It lives in
`@nextblock-cms/utils` (`libs/utils/src/lib/authored-html.ts`; `lib/blocks/inlineScriptNonce.ts`
re-exports it). Text blocks, product short descriptions, string `description_json`, custom-block
rich text and the CMS editors' previews pass through it. The editor's SVG node uses its sibling
`sanitizeAuthoredSvgMarkup`, the same allowlist reading an `<svg>`'s inner markup as SVG content
(inside an `<svg>` wrapper, so `<path/>` closes and `linearGradient` keeps its casing).

Since 2026-11-04 it is an allowlist on [sanitize-html](https://github.com/apostrophecms/sanitize-html)
(a dependency of `@nextblock-cms/utils`), not a strip. The regex strip it replaced was bypassed in
every review: `<scr<script>ipt>`, `src=x/onerror=`, a handler right after a quoted value, a tag
left open to run on into the page markup, entity-encoded and tab-split script URLs. Each time the
browser read the markup differently from the regexes, and every one of those inputs stays in the
tests. htmlparser2 reads the input the way the browser does: raw-text elements, SVG context and
its casing, character references in values. Only the listed elements and attributes are written
back out, with every text and attribute value escaped and every element closed, so the browser
reads the output as written.

- **Kept:** what the editor writes (widget `data-*` attributes, inline `style`, `class`, `id`);
  links on http, https, mailto, tel, sms, ftp and relative URLs; images (`data:` too); tables,
  lists, code, audio and video; inline SVG; `<style>` blocks (`StyleTagNode`); task-list
  checkboxes; and YouTube / Vimeo players over https, the `frame-src` hosts, with their attributes.
- **Dropped:** scripts, handlers, `srcdoc`, meta, base and link, plugins, and forms with every
  control but the checkbox. Every other iframe goes too, same-origin ones included:
  `frame-ancestors 'self'` would let a block frame the CMS. Also dropped: the `name`, `form` and
  `for` attributes (DOM clobbering, joining or toggling a CMS form), a `data-` or `aria-` attribute
  under a name the HTML spec forbids (a `:` as in `data-x:xlink:href`, a bare `data-`, or after
  `data-` anything but lowercase letters, digits, `.`, `_` and `-`, after `aria-` anything but
  lowercase letters), SVG `foreignObject`, `use` and animation, MathML, comments, and any other
  element or attribute (an unknown element keeps its text). Elements nested more than 100 deep are
  dropped and keep their text, because html-react-parser and React's server render recurse once
  per level.
- **A `<style>` whose text could open a tag** (`<` followed by a letter, `!`, `/` or `?`) is
  dropped whole. Inside `<svg>` the browser parses style text as markup, and sanitize-html wrote it
  through unescaped until 2.18.1; 2.18.2 writes a `<` in svg or math style text as the CSS escape
  `\3c ` (GHSA-6wrv-5cp6-h3c5), so this rule is defense in depth and the tests pin its exact output.
  A `<` that opens nothing (`@media (width < 600px)`) stays (inside svg or math the library writes
  it as `\3c `). CSS is authored content (`style-src 'unsafe-inline'`): it can restyle the page or
  overlay it, never run script.
- **`<style>`, `<title>` and `<iframe>` keep text only.** An element inside one is dropped whole.
  Inside `<svg>` they hold markup until a tag like `<p>` switches the browser back to HTML, where
  they hold raw text. A browser that serializes the DOM keeps `<` in attribute values, so
  `<svg><p></p><style><a id="</style><img onerror=…>">` would come back live on its next parse.
  The tests replay that round trip: parse into the page, serialize, parse again.
- **A tag left open at the end** is escaped first, so `if a<b` stays readable text.

It needs no DOM and no `eval` (the production CSP forbids it), so server components, client
components and the published lib run the same code and get the same output, with no hydration
drift. `authored-html.node.test.ts` runs it with no `window` at all. The CSP blocks inline
handlers and inline scripts but allows the script hosts it lists, and a meta refresh needs no
script, so this function is the boundary, not the CSP.

The cost is client bundle size. sanitize-html requires postcss as it loads but calls it only to
parse style attributes, which the sanitizer turns off, so `next.config.js` resolves `postcss` to the
empty `lib/browser-stubs/postcss.cjs` in browser bundles (`turbopack.resolveAlias`, the `browser`
condition only; the server keeps the real package as an external). `lib/browser-stubs/postcss.test.ts`
runs the sanitizer against the stub and fails the day sanitize-html needs postcss for anything else.
What is left (sanitize-html, htmlparser2's full entry point, launder with dayjs) is about 104 KB
minified, 41 KB gzipped, in any client bundle that imports the sanitizer. The client components that
do are `FeaturedProduct` and `ProductDetailsLayout` (through `ShortDescription` and
`SimpleTiptapRenderer`), the CMS block editors and custom-block previews, and the editor's Toolbar
and SvgNode.

Measured on `next build` (2026-11-04), the chunks the root layout loads grew by 39.4 KB gzipped on
`/`, `/[slug]`, `/article/[slug]` and `/product/[slug]`, and by 40.1 KB on the CMS page editor
(57.5 KB and 66.6 KB before the postcss alias). That was every public page, and the cause was the
`@nextblock-cms/utils` main barrel, not the ecommerce one (the code split had already taken that off
public routes, and the cost stayed): the barrel re-exports `./lib/authored-html`, the package
declares no `sideEffects`, and sanitize-html is CommonJS, so one value import of the barrel from
client code puts the sanitizer in that chunk, together with Zod and the custom-block schemas
(`custom-blocks.ts` runs `z.config()` at the top level). The root layout's own client modules
imported it (`TranslationsProvider`, `useTranslations`, `cn`), and so did every ui primitive (`cn`)
and most public client components. Since 0.23.4 client code on public routes, and the libraries'
ui, storefront and partner components, import utils through deep subpaths
(`@nextblock-cms/utils/utils` for `cn` and the currency helpers, `/translations-context`, `/color`,
…), which the package publishes through `./*`; the barrel keeps every export for published
libraries and user code. The sanitizer now reaches the browser only where it runs there: the CMS
and its block editors, the in-page visual editor, and the two lazy commerce chunks that render
authored HTML, those of the featured_product and product_details blocks (the product page renders
the latter; `ShortDescription` and `SimpleTiptapRenderer` import `sanitizeAuthoredBlockHtml` from
`@nextblock-cms/utils/authored-html`). The other chunks behind `LazyCommerceClients` (the product
grid, cart, checkout, reviews and contact form) carry neither the sanitizer nor Zod, and Zod
reaches a public page only with the in-page visual editor. Re-measured on 2026-11-14 the same way
(a production `next build`, then the
union of `entryJSFiles` in `.next/server/app/<route>/page_client-reference-manifest.js`, gzipped:
docs/05 → "Measure before and after"): no chunk the root layout loads on `/` holds sanitize-html or
Zod any more, those chunks fell from 242.5 KB to 112.3 KB gzipped, and the entry chunks of `/`,
`/[slug]`, `/cart`, `/checkout`, `/product/[slug]`, `/article/[slug]` and `/setup` each lost about
130 KB (`/`: 255.1 KB to 125.0 KB). The CMS dashboard and page editor, which load the sanitizer for
their editors anyway, gained 1.8 KB and 1.7 KB. `tools/scripts/root-layout-chunking.test.ts` fails
when the root layout's client graph, any public route's client graph, or any lazy chunk those load
for visitors (the in-page editors aside) reaches the barrel or Zod (`zod` or `zod/*`, a
`zod-config` module, `custom-blocks.ts`); when one reaches `authored-html` or sanitize-html outside
the lazy chunks its `SANITIZING_LAZY_CHUNKS` lists, each with why and each checked to be still
loaded and still sanitizing; and when a deep import names a module or an export the published
package does not ship.

A text block whose `html_content` is Tiptap JSON (`isTiptapJsonString`) skips the sanitizer in
`BlockRenderer` and `TextBlockRenderer` and renders through React (`SimpleTiptapRenderer`, whose
string fallback is sanitized). That exemption never goes inside the sanitizer: the raw sinks inject
JSON-parseable strings as HTML.
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

**The Content-Security-Policy backs the sanitizer up; it is not the boundary.** `proxy.ts`
(`createContentSecurityPolicy`) draws a nonce per request and sends the policy on every response
it handles, redirects and `/setup` included. It also puts the policy on the forwarded request,
where Next reads the nonce and stamps it on its own scripts. `script-src` is
`'self' 'nonce-…' 'strict-dynamic'`, then the fallback sources: `blob:`, Google Tag Manager and
Analytics (production only), the Vercel toolbar and insights, Turnstile, reCAPTCHA. A browser that supports
`'strict-dynamic'` (CSP3) ignores every host and scheme source. It runs a script only if the script
carries the nonce, or if a nonce'd script inserted it at runtime: Next's chunk loader, `next/script`
(the captcha loaders, GTM, GA), the tags GTM loads, the consented custom scripts. So a
`<script src>` in the markup without the nonce runs from no host at all. Until 2026-11-04 it ran
from any listed host: gtm.js serves any container, and www.google.com has JSONP endpoints.
Browsers without `'strict-dynamic'` (CSP2, such as Safari before 15.4) fall back to the host
list. Development uses the same model plus `'unsafe-eval'` for React's dev tooling, so a script
without the nonce fails locally first.

Two things it cannot stop are why the sanitizer stays. A script that a trusted script inserts runs
from any host: React 19 itself inserts every `<script async src>` it renders on the client. And a
meta refresh needs no script at all. For your own scripts:

- A script written into the markup needs the layout's nonce, as `SiteScripts` and the
  trusted-types bootstrap have.
- `next/script` after hydration inserts its script at runtime, which is trusted either way. Pass
  the nonce anyway: CSP2 browsers and inline bodies need it.
- JSON-LD (`type="application/ld+json"`) never runs, so the policy ignores it.
- Pages must stay dynamically rendered (the root layout reads `headers()`). A prerendered page has
  no nonce, so none of its scripts would run.
- Vercel injects its comments toolbar into preview deployments as a markup script without the
  nonce, so CSP3 browsers block it there (Vercel does not support `'strict-dynamic'` for it). The
  layout mounts the toolbar itself, with the nonce (`@vercel/toolbar`): in draft mode on Vercel, or
  anywhere with `NEXTBLOCK_VERCEL_TOOLBAR_ENABLED=true`.

`proxy.test.ts` ("Content-Security-Policy") pins both `script-src` lists, the forwarded nonce, and
the directives the model relies on: `script-src-attr 'none'`, `object-src 'none'`,
`base-uri 'self'`.

`02022` also carries these DB-level hardenings (second red-team pass):

- **`media` is owner-scoped for staff.** `media_update_policy` / `media_delete_policy` let a WRITER
  change or delete only rows where `uploader_id = (select auth.uid())`; ADMIN keeps every row. The
  CMS media actions (and, until 0.23.4 removed it, the product save's orphan-media sweep) do the DB write **first** and only touch
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
`tools/lib/migrate-core.mjs` for the build hook on every deploy and for `npm run update`, on the
copy its code update brought and even with nothing pending since 0.23.6's updater), which then
re-applies the revokes in `API_ROLE_REVOKE_SQL` so a deployed or wizard-installed database matches a
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
  `lib/affiliates/upload-keys.ts`). The staff upload routes refuse a folder inside them
  (`resolveUploadFolder`; `/api/media/r2-presigned` through `validateR2PresignedUploadPayload` and
  its signer, which signed such keys until 2026-11-14), and every staff key builder strips `%`, `?`
  and `#`, so an encoded folder becomes a literal one outside them. `/api/process-image` and
  `/api/media/record` take keys from the client, so both judge every key in the request with
  `isAcceptableClientObjectKey` (`lib/storage/upload-policy.ts`) and `requireAllowedExtension`:
  `isSafeObjectKey`, only the characters the builders mint (`[A-Za-z0-9._/-]`: no `%`, `?`, `#` or
  whitespace), an allowed media extension in the last segment, and no partner key, checked before
  any storage call or insert. `/api/media/record` judges `r2OriginalKey` too (leading slashes
  dropped, as for the primary), whether or not it ends up on the row. The character rule is what
  the native Supabase backend needs: storage-js puts the key into the request URL (raw, or for
  `upload()`, `update()` and `uploadToSignedUrl()` with repeated slashes collapsed), the URL
  parser resolves `..` and `%2e%2e` (so the URL can name another prefix or bucket) and ends the
  path at `?` or `#`, and the storage server decodes `%xx`. Until 2026-11-14
  `%61ffiliates/pages/<id>/x.jpg` passed `/api/process-image`, which read that partner's object and
  wrote six AVIF variants into their prefix, against their upload caps (R2/S3 were not affected:
  the SDK encodes the key); until the same day `/api/media/record` judged `r2OriginalKey` only
  against the partner namespaces unless it became the primary (`uploads/<folder>/victim.png?.png`
  was accepted next to valid variants), and `/api/process-image` took a key without a media
  extension and named its variants after the text before the last `.` (`uploads/photo` wrote
  `_xlarge.avif`… at the bucket root). The `/cms/media` delete and move actions skip partner keys
  and send stored keys literally (the S3 SDK encodes a key and the move its `CopySource`; on
  Supabase the delete puts keys in the request body and the move refuses), so the decoy-row trick
  `02028` closed for media cannot reach a partner's files either. A product save deletes no media
  since 0.23.4: `updateProduct()` only unlinks an image dropped from the gallery, and so does the
  draft publish's `publish_product_draft` (02043), which deletes no media row. Until then it
  deleted the row of every dropped image no product, post, logo or variant used and, on R2, every
  key that row listed, and took more ids from the draft's `explicitly_removed_media_ids`, so a
  WRITER's draft or decoy row could make an ADMIN's publish delete other uploaders' files and
  partner uploads, and on R2 an honest drop deleted the files of an image a page block still showed:
  no foreign key tracks a key copied into block content (2026-11-15). `isPartnerUploadKey`
  (re-exported by `lib/storage/media-object-keys.ts`) counts a key wherever storage could put it:
  a `?` or `#` in the key or after any decoding round counts outright (it does not model where the
  URL path ends); escapes decoded until none is left (4 rounds at most); tabs and newlines dropped,
  backslashes read as slashes, case ignored; the path counted as written and with its dot segments
  resolved; and the raw key also read in the URL parser's order, which resolves dot segments
  (`%2e` spellings included) before anything is decoded and keeps empty segments, then decoded,
  and that reading again on the key as `upload()` sends it (repeated slashes collapsed first, so
  `x%2fy//../affiliates/pages/<id>/…` counts); a malformed or still-encoded escape, or a `..` that
  leaves the bucket, counts as a partner key.
  Until 2026-11-14 the custom-block signer signed, for a payload nobody validated,
  `./affiliates/pages/<id>/x.jpg?/../../../..`, `affiliates//../pages/<id>/…` and
  `x%2fy/../affiliates/pages/<id>/…`, which all land in that prefix. No builder mints a `?` or
  `#`, so the delete and move also skip a stored key holding either.
  `lib/storage/partner-upload-namespaces.test.ts` holds every builder and the client-key predicate
  to 20 spellings per namespace (6 percent-encoded, 3 that end the URL path early) and the signer
  to every spelling storage itself reads into a namespace; `upload-policy.test.ts` checks the
  predicate against an offline model of the Supabase URL, for the raw-key calls and for `upload()`,
  over 9,520 generated spellings. The rest
  of `affiliates/` is ordinary media.

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
  envelopes (before 0.23.0) still open in any slot; each screen re-seals the ones it holds on
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

`02041` (2026-11-13) takes `is_admin_created` away from every API role. The flag tells the
proxy's first-boot gate that an administrator exists. While it is not `true`, every anonymous
request goes to `/setup`, and the wizard offers to create the first administrator. The
`is_admin_mfa()` write branch admitted it like any key that is not a secret. On the public
sandbox every visitor is the factor-less demo admin, so one PostgREST request could lock the demo
on `/setup`. That included the reset cron, which the gate also redirected until the same release.
On 2026-11-13 cms.nextblock.dev's flag read false; whether a visitor or a failed reset wrote it
is not known. Three RESTRICTIVE policies (`site_settings_admin_created_no_api_insert_policy`,
`…_update_policy`, `…_delete_policy`, `TO anon, authenticated`) are AND-ed with every permissive
policy, so no API session inserts, updates, renames another row into or deletes the flag. A later
change to the permissive tiers cannot reopen it. The app never wrote it with a user session:
`handle_new_user()` (definer), the seed and the sandbox reset (postgres) write it, and `/setup`
reads it with the service role. Reads are unchanged, and no grant changes.
`security-verify.sql` section 43 (7 assertions, 263 in the file) checks all of this, with
`anon` still reading the flag and the service role still writing it. Before `02041`, five of
its lines fail. Section 3's no-factor ADMIN probe moved to `store_contact`.

`02043` and `02044` (2026-11-18) make a product draft publish one call,
`public.publish_product_draft` (docs/09 → "Publishing: one transaction" and "Stock: only what the
editor changed"). It and `public.product_revision_content` are `SECURITY INVOKER` with
`search_path ''` and executable by `authenticated` and the service role only (both copies of
`API_ROLE_REVOKE_SQL` take `anon` back after the blanket grant); their three helpers live in
`private`, which the grant pass never touches. The publish refuses anyone but an ADMIN
(`is_admin()`), runs with the admin's RLS and deletes no media. 02044 also replaces two 02001
functions, statement for statement but one change each: `sync_inventory_cache_for_sku` holds a
product's total at 2147483647, and `apply_order_inventory_deduction` takes an order's SKUs in SKU
order, the order the publish locks inventory rows in. It adds `idx_product_variants_sku` and
`idx_products_sku`: every inventory write runs `sync_inventory_cache_for_sku` (its trigger), which
updates the variants and products carrying the SKU, and the inventory read policy checks each row
it reads against them, so without an index each of those lookups scanned the whole table, or the
whole `(product_id, sku)` key, under the caller's row policies, once per SKU a publish writes.
Measured on local replays, five hundred changed SKUs beside 50 other products take 10 s or more
without them and about 5 s with them on an idle machine (up to 9 s on a busy one, past the Data
API's 8 s statement timeout); beside 2,000 other products they still take 9 to 13 s, and a publish
past the timeout fails with nothing written (02046, below, runs the trigger once per statement). Both are a plain `CREATE INDEX IF NOT EXISTS` (a migration
runs in a transaction, where `CONCURRENTLY` cannot), which holds writes to its table until the
file's transaction commits, right after it.
`security-verify.sql` section 44 (10 assertions) checks the privileges and the behaviour, and
`tools/scripts/product-draft-publish.db.test.ts` runs the functions with several sessions at once
(CI db-posture job).

`02045` (2026-11-18) adds `public.media_usage(p_media jsonb) RETURNS jsonb`, the media library's
usage lookup (docs/03 → "Deleting media"). It is `SECURITY INVOKER` with `search_path ''`, and only
the service role executes it: the migration revokes it from `PUBLIC, anon, authenticated`, and both
copies of `API_ROLE_REVOKE_SQL` revoke it again after the blanket grant (`migrate-core.test.mjs`).
It reads every content table, drafts, revisions, partner pages and site settings included (never the
secret rows, which it skips by 02038's own rule: the seven named keys, and any key with a
secret-like suffix whatever its case), and returns their titles, so an answer limited to what RLS
lets a caller see would call a used image unused. The app calls it through `findMediaUsage`
(`lib/media/media-usage.ts`, `server-only`) after `getCmsActor()` has found staff past their second
factor (the media actions and pages), and shows a WRITER no label or record id for a place their own
session cannot read (`withoutAdminOnlyLabels`: partner storefronts, redirects, ADMIN-tier settings).
Given each media id and the keys its row owns (`ownedMediaStorageKeys`), it reports every foreign
key (gallery, variant image, feature image, logo) and every document that names the id or a key. It
reads each document as JSON text (a jsonb column's text, a plain text column through `to_json`): one
regex pass per document for uuids and, when a key was sent, one for runs of storage-key characters.
Before that pass a stored `\/` is read as `/` (two backslashes and a slash in the JSON text, which
one plain `replace()` turns into `/`), so JSON that escapes its slashes, as PHP's `json_encode`
writes it, names a key exactly where the same text unescaped would (a key directly followed by `\/`
and more key characters is part of a longer run, as `uploads/a.png/x` is); then every JSON escape
whose letter is a key character (a control character in a string: `\n`, `\t`, or `\u` and four hex
digits) and every escaped backslash becomes a space, read from the left so that an escaped backslash
stays one character (without these a key on its own line in a text field, or one written with
escaped slashes, was never found, so "Delete unused" deleted its file), and `%2F` is read as `/`;
each run is then split once into the suffixes after a `/` that could equal a key sent (none longer
than the longest key or with more segments than the deepest), a key matching such a token exactly.
Building every suffix cost the square of a run's length, and documents it reads are written outside
the staff too: one profile picture URL of 20,000 slashes (anyone who signs up sets one) made every
lookup take tens of seconds (36 to 85 s on local replays), far past the Data API's 8 s statement
timeout. Staff can write a media row's keys, so they are search strings chosen by the row's author:
the function ignores a key with a character outside `[A-Za-z0-9._/-]` or longer than 512 characters
(`MAX_OBJECT_KEY_LENGTH`, which `media-usage.test.ts` holds equal) and never searches for a
substring, and the app sends only keys an upload route could mint, no two spellings of one key and
at most 17 a row (a row breaking any of these is asked about by id alone and answered with one more
use, `unchecked_key`, never unused; a row that owns no key, a partner upload or a key over 512
characters, is asked about by id alone without `unchecked_key`: its delete removes no object). The
answer is one jsonb value, so PostgREST's `max_rows` never truncates it. Measured on a local replay:
about 30 ms for the seeded site, and about 4 to 5 s for a 57 MB site whose 5,000 blocks and 2,000
revisions name 1,000 media 140,000 times (14 s before the suffix bound; the escape pass about 0.3 s
and the escaped-slash replace about 0.1 s of it), less than twice the headroom under 8 s.
`security-verify.sql` section 45 (14 assertions, 287 in the file) checks the privileges, each kind
of use, the secret rows skipped, that a key with a space is not found where a document holds it
verbatim, that a key right after a JSON escape is found (after six control characters, and after an
escaped backslash in a text block and in a navigation link), that a key written with escaped slashes
is found (JSON-LD in a text block, where the backslashes before an escaped slash still end a key,
and a redirect target), and that a profile picture URL of 20,000 slashes answers within a 4 s
statement timeout with the key at its end still found; without the function all fourteen fail.

`02046` (2026-11-19) makes every stock write take `inventory_items` rows in SKU order, and the
inventory caches sync once per statement (docs/09 → "Stock: only what the editor changed", Limits
and Locks). The row-level `on_inventory_item_change` is replaced by three statement-level triggers
(`on_inventory_items_inserted`, `_updated`, `_deleted`, each with its transition table) calling
`public.handle_inventory_items_sync()`, which hands the statement's SKUs to
`private.sync_inventory_caches(text[], boolean)`: one write per carrier (the variants with those
SKUs, the products without variants with them, one total per product with a variant carrying one,
locked in id order first), only where the value changes, `products.updated_at` stamped where a
product's own stock or a variant's changes and where its total changes, except a total that only
rows a statement inserted changed (a repair: a row created from the stock its carriers show).
`public.sync_inventory_cache_for_sku` stays as a wrapper of it. Until then each row written summed
the product's variants again under the caller's row policies: five hundred changed SKUs took 12 to
27 s on local replays (past the Data API's 8 s statement timeout), about 0.7 s now. Three inventory
writers take their rows in SKU order in one statement: `public.upsert_inventory_items(p_rows jsonb,
p_on_conflict text)` (`'update'`, `'nothing'` or `'error'`), `public.update_inventory_quantities(p_skus
text[], p_quantity integer)` and `public.delete_inventory_items(p_skus text[])`; libs/ecommerce's
`upsertInventoryRows` (with a fallback to the PostgREST upsert where the function is unknown) and
Cortex's `execute_database_mutation` on `inventory_items` write through them. They and the sync are
`SECURITY INVOKER` with `search_path ''`: the `inventory_items` policies decide (an ADMIN or the
service role writes; a WRITER's insert is refused and its update or delete matches nothing), so they
can do nothing a caller could not do over PostgREST. The migration revokes EXECUTE on the three
writers and the sync from `PUBLIC, anon` and grants it to `authenticated` and `service_role`, and
both copies of `API_ROLE_REVOKE_SQL` take `anon` back after the blanket grant (the sync lives in
`private`, which the pass never touches). `apply_order_inventory_deduction` reads an order's lines
once, takes every row they name in one statement (`INSERT ... ON CONFLICT (sku) DO UPDATE ... WHERE
false`: a missing row is created, an existing one locked and not written), then deducts in one
statement, and the app's SQL fallback runs the same three statements (`order-inventory.test.ts` holds
them to the function's), so it now skips a SKU of spaces as the function does.
`publish_product_draft` takes its rows the same way before the products row, creating the missing
row of each SKU a sale could deduct of the products it can write. The file ends with a backfill:
every variant's SKU and the SKU of every product without variants that lacks a row gets one, at the
least stock its carriers show. `security-verify.sql` section 46 (6 assertions)
checks the triggers, the privileges and a WRITER's and an ADMIN's writes;
`tools/scripts/product-draft-publish.db.test.ts` runs the 500-SKU publish under the 8 s timeout and
each lock order with several sessions.

`02047` (2026-11-19) records which publish a product draft's stock baseline was loaded against
(docs/09 → "Which publish a baseline was loaded against"). `public.product_stock_publishes` holds one
row per product: `publish_count` and `stock` (`{ sku: { loaded, entered } }`, what the last
product-values publish did with each SKU), which `private.apply_product_draft_values` (replaced,
still `SECURITY INVOKER` with `search_path ''`) rewrites on every product-values publish and counts a
baseline loaded before that publish from. The publish trusts the row, so it is never the caller's to
write: row security on, `SELECT` for an ADMIN or a WRITER (as `product_drafts`: the edit page shows a
draft's stock from it), `INSERT` and `UPDATE` for an ADMIN (`is_admin()`, as the products and
inventory write policies: the publish runs as its ADMIN caller), no `DELETE` policy (the row goes with
its product, `ON DELETE CASCADE`); `anon` holds nothing, `authenticated` `SELECT`, `INSERT` and
`UPDATE`. Both copies of `API_ROLE_REVOKE_SQL` take back `anon`'s `SELECT` and `authenticated`'s
`DELETE` after the blanket grants (`migration-grants.test.ts` fails on a table the pass would widen).
A draft's own marker (`stock_baseline_publish_count`) is a WRITER's to write, like its baseline: a
value that is not a whole number below the product's count changes nothing, and one below it only
counts a SKU from the figure the last publish entered where the draft's baseline entry is the one that
publish used. `security-verify.sql` section 47 (5 assertions, 298 in the file) checks the privileges,
a WRITER's and anon's refusals, that a product-values publish records itself and an overlay publish
does not, and that the same values again after a sale leave the stock as the sale left it; before
`02047` the section stops at its first read of the table.

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
  (seed runs, marker set, catch-up skipped) and re-records the generation's versions. Only
  `public` is wiped: `private` keeps what the last run left, so every file must replay over it
  ("Production migration policy").
- **Downstream installs (Vercel, `npm create nextblock`, Docker):** nothing to do. The
  `/setup` wizard, the build hook, `npm run update` and the Docker runner all apply pending
  files in order and cross the squash automatically, as long as the history they read is the
  database's own (next bullet).
- **A database whose history was wiped**, or a dump of the `public` schema alone loaded into a
  new project (the dump leaves `supabase_migrations` behind): with nothing recorded every file is
  pending, the catch-up finds no retired version to skip, and it would replay the whole retired
  generation over content that already has it. The appliers stop there:
  - `db:migrate` refuses to apply the baseline over a completely empty remote history.
  - `/setup`, the build hook and `npm run update` refuse, before they write anything, when the
    history is empty and `public.site_settings` exists, and either
    `site_settings.migration_baseline_generation` is unset or below the folder's generation (the
    highest `GG`), or the list holds a file from a retired generation, which would run again as
    written whatever the marker says (a standalone project keeps the files it was scaffolded with
    in `supabase/migrations`, and the update only adds to that folder). That is
    `emptyHistoryRefusal`, the same in `apps/nextblock/tools/lib/migrate-core.mjs` and
    `apps/nextblock/lib/setup/schema-apply.ts` (`migrate-core.test.mjs` runs both). The build
    hook logs the refusal and the build goes on; `npm run update` fails and says what to do for
    the install. An empty database, and one born at or crossed to the folder's generation with
    only that generation's files, still get every file: each replays over a database that already
    ran it ("Production migration policy").
  - The Docker runner has no such refusal and needs none so far: its history,
    `public._nextblock_docker_migrations`, sits in `public`, so a dump of `public` carries it
    along and a dropped `public` takes it with the content.

  The remedy is the history: restore `supabase_migrations.schema_migrations` from a backup of the
  database, or copy it from the database the dump came from, then run the applier again. A
  standalone project whose database crossed already may instead remove the retired generation's
  files from `supabase/migrations`: nothing needs them there any more. On a database that never
  crossed, `npm run db:migrate:repair-history` is no way round: its auto-detect records only this
  generation's versions and leaves the catch-up pending, which then replays the whole retired
  generation, under `db:migrate` and the other appliers alike (their refusal covers an empty
  history only). Use `db:migrate:fresh` only if the database really is new.

### Production migration policy

NextBlock has live Supabase data. Treat migrations as append-only for any
production or shared database change.

- Do not edit, recycle, squash, reorder, or delete migration files that may
  already be recorded in a shared or production Supabase project.
- Add a new forward-only `.sql` file under
  `libs/db/src/supabase/migrations` for each new schema/data change.
- Keep migrations non-destructive by default. Avoid dropping or rewriting data
  that may include orders, users, payments, or customer records.
- **Every file must replay over a database that already ran it and every later file.** The
  sandbox reset (every 15 minutes) and `/setup`'s local reset (local development only; it also
  drops `supabase_migrations`) drop `public` and run the folder again, and the stale-history
  self-heal of `/setup` and of the build hook runs it all again once `public` was dropped some
  other way. Objects outside `public` survive with a later file's definition (`private`: 02021's
  role helpers, 02043's publish helpers). `CREATE OR REPLACE` cannot change a function's return
  type, parameter names or defaults, so a later file that changes one drops the function first,
  and the earlier file creates it in its final shape (dropping it first too when a database may
  hold an older shape). Until 2026-11-18 (before release) 02043 created
  `private.apply_product_draft_values` returning `void` and 02044 re-created it returning `jsonb`,
  so from its second run on the sandbox reset would have stopped at 02043 (42P13) and rolled back:
  02043 now creates it returning `jsonb` and drops it first, for a developer database that ran the
  earlier 02043. `tools/scripts/migration-replay.db.test.ts` (CI db-posture job) runs that replay
  on the migrated database in one rolled-back transaction and checks it ends with the first run's
  definitions.
- **The generated copies follow every migration change.** `/setup` applies
  `apps/nextblock/lib/setup/migrations-bundle.ts` where the migration folder is not on disk (a
  serverless host), and the sandbox reset replays
  `apps/nextblock/app/api/cron/reset-sandbox/sandboxResetSql.ts`: run
  `npm run generate:migrations-bundle && npm run generate:sandbox` after adding or editing a file.
  `tools/scripts/generated-migration-copies.test.ts` (in `security:check`) fails while either
  differs from the files, naming the stale file and the command.
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
  `npm run db:migrate:check`. It never marks the catch-up applied, whatever it detects. That
  suits a database at the folder's generation, where the catch-up left pending skips itself; on
  one that never crossed (`site_settings.migration_baseline_generation` unset), restore the
  history instead ("How a squash crosses live databases").
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

## Upload URLs

Two routes hand the browser a URL it PUTs a file to directly, so the bytes never pass through a
serverless function: `POST /api/upload/presigned-url` (media library, 10 MB; no in-app caller
since the media uploader moved to `/api/upload/proxy`) and `POST /api/media/r2-presigned`
(custom-block images from `ImageR2Picker`, 10 MB). Both are ADMIN/WRITER only, past their enrolled
second factor (`getCmsActor()` first, as in `/api/upload/proxy`, `/api/process-image` and
`/api/media/record`: a signed-in user whose factor is pending gets 403 "Complete two-factor
verification, then try again.", no session gets 401). `/api/media/r2-presigned` refuses a folder
inside the partner upload namespaces (400 "Invalid upload folder.", as `resolveUploadFolder` does on
the media library routes). Both require the file's declared `size` in the JSON body: a request
without it, or over the limit, gets 400 before anything is signed. `/api/upload/proxy` (25 MB) and the partner route
`/api/affiliates/upload` receive the bytes themselves and cap them while reading, so they sign
nothing.

**S3-compatible storage (R2, MinIO).** `presignBoundPut()` (`apps/nextblock/lib/storage/presigned-put.ts`)
is the only signer. It sets `ContentLength` to the declared size and signs `content-length` and
`content-type` along with the key, so `X-Amz-SignedHeaders` reads `content-length;content-type;host`.
Storage recomputes the signature from the PUT's own headers. For the URL's 300 seconds it
therefore accepts exactly the declared number of bytes of the declared type, and answers 403
`SignatureDoesNotMatch` to any other length, another type or a missing header. It also refuses
to hand out a URL that leaves either header unsigned. Before 2026-11-04 both routes signed only
`host` (the AWS presigner leaves `content-type` unsigned unless asked), so whoever held a URL
could PUT up to R2's 5 GB, as any `Content-Type` (a `.png` key served as `text/html`).

Both routes sign with `getS3PresignClient()` (`@nextblock-cms/utils/server`), a client of its
own built with `requestChecksumCalculation: 'WHEN_REQUIRED'`. With the AWS SDK's default
(`WHEN_SUPPORTED`, since 3.729) every presigned PutObject URL also signed
`x-amz-checksum-crc32=AAAAAA==`, the checksum of the empty body present at signing time. Storage
that validates checksums held the uploaded file to it and refused the upload. `getS3Client()`
keeps the default: server-side writes send the real body.

The response states the contract as `headers: { "Content-Type", "Content-Length" }`. A browser
sends `Content-Type` as given and lets the browser set `Content-Length` from the `File` body
(scripts may not set it). `presignedPutFetchHeaders()` (`lib/storage/presigned-put-client.ts`)
builds those fetch headers and refuses a file whose size is not the signed one.

**Native Supabase Storage.** Its signed upload URLs (`createSignedUploadUrl`, in
`lib/storage/supabase-storage.ts`) carry a token for one object key and bind neither the size
nor the type, so the routes return the same headers but the URL does not enforce them. On that
backend the bucket's own restrictions are the cap. NextBlock creates the `media` bucket with
`public: true` only, because a bucket limit cannot exceed the project's global file size limit,
which depends on the plan. So set them yourself, in the dashboard (Storage → the `media`
bucket's settings) or with `supabase.storage.updateBucket('media', { public: true,
fileSizeLimit, allowedMimeTypes })`:

- **File size limit:** 25 MB covers every NextBlock upload path (`/api/upload/proxy` is the
  largest; the presigned routes stop at 10 MB, but one bucket holds one limit).
- **Allowed MIME types** (optional): start from the media library's list
  (`ALLOWED_UPLOAD_CONTENT_TYPES` in `lib/storage/upload-policy.ts`) and also allow `image/*`.
  The external image importer (`lib/media/external-image-import.ts`: Cortex stock photos, URL
  imports) stores whatever image type the remote server sends.

Without a bucket limit, the project's global limit applies: at most 50 MB on the Free plan, up
to 500 GB on paid plans.

Gates:

- `lib/storage/presigned-put.test.ts` signs with the real SDK (offline) and checks each URL the
  way storage does. An honest PUT verifies; a 5 GB body, another type or a missing length does
  not; the old host-only signing would have accepted all three. It also checks that a URL
  leaving either header unsigned is never handed out, and fails when any module other than
  `presigned-put.ts` imports the presigner. With the routes' own client it also checks that no
  checksum is signed.
- `libs/utils/tests/s3-presign-client.test.ts` checks that the presign client signs no checksum,
  on R2 and on a MinIO public endpoint, and that the shared client still adds one (the control).
- The route tests (`app/api/upload/presigned-url/route.test.ts`, `lib/custom-block-r2-upload.test.ts`)
  refuse a missing or over-limit size before signing, on both backends, and read the signed
  headers off the URL each route returns.
- `sandbox-guards.test.ts` counts `presignBoundPut` callers as storage writers.
- `server-action-actors.test.ts` (`analyzeStaffRouteGates`, in `security:check`) fails a staff
  upload route whose handler does not open with `const actor = await getCmsActor()` and its two
  refusals before any body read, storage call, signer or database query. Each route test runs the
  real second-factor chain.

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
  anon key — an empty result sends every visitor to `/setup`; no API role writes it since
  `02041`), `privacy_settings`,
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
  without a migration. Also `is_admin_created` (`02041`, three RESTRICTIVE policies), which stays
  publicly readable: only `handle_new_user()`, the seed, the sandbox reset and the service role
  write it.

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
