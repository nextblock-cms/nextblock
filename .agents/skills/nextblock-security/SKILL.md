---
name: nextblock-security
description: NextBlock's security gate. Use before finishing ANY change that touches a migration, RLS policy, GRANT/REVOKE, Postgres function or trigger, the post-apply grant pass, auth/2FA/roles, a server action ('use server'), an API route handler, the service-role client, uploads or server-side fetches of user URLs, webhooks, checkout/pricing/coupons/orders, Cortex tools or the MCP server, rendered HTML, or anything a 'use client' component imports. Runs the automated gates and walks the checklist of every vulnerability class found in the 2026-10 red-team.
---

# NextBlock security gate

Every item below is a real hole that shipped at least once (2026-10-17 → 10-21). The automated
gates catch most of them; the checklist covers what they cannot see. A change is not done until
the gates pass and every checklist line that applies has been answered.

## 1. Run the gates

```bash
npm run security:check        # service-role boundary, migration lint, grant-pass lockstep (~5 s)
npx vitest run <paths you touched>
```

For a migration, a policy, a grant, or anything in `GRANTS_SQL`, also:

```bash
npm run db:migrate:check      # read-only; the new file must be listed as pending
# replay every migration into a disposable local database, then the posture gate:
SUPABASE_PROJECT_ID=nextblock-ci npx supabase start --workdir libs/db/src -x realtime,storage-api,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor
npm run security:db-posture -- --db-url postgresql://postgres:postgres@127.0.0.1:54322/postgres
npx supabase stop --workdir libs/db/src --no-backup
```

`security:db-posture` runs the post-apply grant pass first (every deploy does) and fails on any
FAIL or skipped assertion; it refuses non-local hosts. Never run it, or `security-verify.sql`,
against production. CI (`.github/workflows/security.yml`) runs all of this on every push and PR,
but run it before handing work back: CI only reports after the push.

A Stop hook (`.Codex/settings.json` → `tools/scripts/Codex-security-stop-hook.mjs`) runs
`security:check` whenever a turn ends with code changes and sends you back if it fails. Fix the
cause; never weaken a check, add an allowlist entry or a grandfather entry to make it pass
without saying so to the user.

## 2. Checklist

**Server actions and routes**
- Every exported function of a `'use server'` file is a public POST endpoint, reachable from any
  route (`proxy.ts` only gates `/cms` URLs). It authenticates and authorizes itself BEFORE any
  read: `requireCmsAdmin()` / `requireCmsStaff()` (`lib/auth/cms-actor.ts`), `requireEcomAdmin()` /
  `requireEcomStaff()` (`libs/ecommerce/.../require-ecom-role.ts`), Cortex `requireActorRole`.
- Never trust an id, price, role, owner or token from the client. Re-derive ownership on the
  server (order access tokens: `order-access-token.ts`; UCP carts: `access_token_hash`).
- A payment provider's browser callback is attacker-controlled. Verify every id it names with the
  provider's API before storing it, and never let it set a product, plan or paid state
  (`evaluateFreemiusCheckoutLicense`: a guest could attach any license to their order and read its
  key). A page that reveals a secret (license key) re-checks that it belongs to the order.
- A helper that returns the service-role client enforces the enrolled second factor, not just the
  role: server actions never pass the CMS layout's 2FA redirect. Use `getCmsActor()`; the
  ecommerce lib uses the gate the app registers (`lib/auth/second-factor-gate.ts`).
- A route handler that mutates with cookies needs the same checks; cron routes check their secret
  with a timing-safe compare.

**Service-role client** (bypasses every RLS policy)
- A module that builds, hands out or keys it imports `'server-only'`; the key is read only by
  `lib/setup/service-key.ts`; import types from server modules with `import type`; no secret
  behind `NEXT_PUBLIC_` or `next.config.js` `env`. Gate: `service-role-boundary.test.ts`.
- Under the service role RLS is not a boundary: the in-code role check IS the authorization.

**RLS policies**
- Every policy names its roles (`TO authenticated` …); one without `TO` also applies to `anon`.
- No `USING (true)` / `WITH CHECK (true)` for `anon`/`authenticated` on a table holding users,
  orders, coupons, licenses, tokens, revisions, settings, 2FA, carts or messages.
- An authorization column (`profiles.role`) is pinned by column grants first (02025), then
  `WITH CHECK` and a trigger. A self-service `FOR UPDATE` policy covers every granted column.
- ADMIN branches on orders, profiles (other rows), site_settings secret tier and the commerce
  tables use `is_admin_mfa()` (aal2 when a factor is enrolled, 02023); CMS screens read those
  rows with the service role after the in-code check, never through the cookie client.
- Draft/scheduled/archived rows and their children (media, stock, categories) stay staff-only.

**Grants** (decide whether a role may touch a table at all; RLS decides which rows)
- New table: `ENABLE ROW LEVEL SECURITY`, `GRANT SELECT … TO anon` only if publicly readable,
  writes to `authenticated, service_role` only. `anon` holds no write grant anywhere (02025).
- Any revoke from `anon`/`authenticated` that the blanket grants of `GRANTS_SQL` hand back goes
  into `API_ROLE_REVOKE_SQL` in BOTH `apps/nextblock/tools/lib/migrate-core.mjs` and
  `apps/nextblock/lib/setup/schema-apply.ts`, or the next deploy undoes it (02013 → 02024,
  02022 → 02025). Gates: `migration-grants.test.ts`, `migrate-core.test.mjs`, the posture job.

**Functions**
- No `SECURITY DEFINER` function in `public`: put it in `private` with a `SECURITY INVOKER`
  wrapper (02021). Any definer function sets `search_path`, and the file revokes EXECUTE from
  `PUBLIC, anon, authenticated` (Postgres grants PUBLIC on create; Supabase grants anon and
  authenticated by name). Service-role-only RPCs go into `API_ROLE_REVOKE_SQL` too.
- Atomic counters and limits (coupon redemptions, 2FA attempts) are one `UPDATE … RETURNING`.
- Extensions go in `extensions`, never `public` (advisor 0014).

**Inputs that reach the network, the filesystem or the page**
- Server-side fetch of a user-supplied URL calls `guardedFetch` (`libs/cortex/src/lib/fetch-host-guard.ts`:
  private ranges, every redirect hop, pinned DNS, streamed byte cap); never `fetch()` with
  `redirect: 'follow'`, never report a refused hop's status. Uploads go through `lib/storage/upload-policy.ts`.
- Author CSS in a `<style>` element goes through `escapeStyleElementText` (`lib/themes/style-element-text.ts`).
- A `'use server'` export never takes the actor (`actorUserId`, `authorId`, `userId`) or a
  database client as an argument; actor-taking variants live in server-only modules called by
  routes after they authenticate. Gate: `server-action-actors.test.ts`.
- Authored HTML renders through `sanitizeAuthoredBlockHtml` (`lib/blocks/inlineScriptNonce.ts`);
  never `dangerouslySetInnerHTML` raw content. Redirect targets go through `lib/auth-redirects.ts`.
- Webhooks verify the signature over the raw body before parsing, and are idempotent.
- Checkout recomputes every price, discount, shipping and tax amount from the database, and a
  discount is computed on the quantities actually paid for (`reconcileCouponContextItems`).
- User input never becomes a LIKE/ILIKE pattern unescaped (`%` matched every coupon code); look
  secrets up with an exact match.
- An order becomes paid only on a settled payment (`payment_status` paid / no_payment_required,
  or `async_payment_succeeded`), never on `checkout.session.completed` alone.
- Cortex: web and DB tool results are untrusted (`lib/cortex-ai/untrusted-tool-results.ts`); AI
  routes are quota-limited per user (`lib/cortex-ai/request-quota.ts`).

## 3. Every fix ships its guard

When you fix a security bug, add the check that would have caught it in the same change: a unit
test, a lint rule in `tools/scripts/lib/migration-grants.js`, a marker in
`tools/scripts/lib/service-role-boundary.js`, or an assertion in `tools/scripts/security-verify.sql`
(each `RAISE NOTICE '%  …'` line is counted by the posture gate). Then add a row below.

| Date | Hole | Guard |
|---|---|---|
| 2026-10-17 | `profiles` readable by anon; any user could PATCH own `role` to ADMIN | 02021; posture §15, §24–25; column grants 02025 |
| 2026-10-19 | WRITER could write sensitive `site_settings`, read license keys, burn coupons, flood AI routes | 02022; posture §1–12 |
| 2026-10-20 | Factor-enrolled ADMIN reached orders/profiles/secrets at aal1 | 02023; posture §13–17 |
| 2026-10-20 | Deploy hook re-granted EXECUTE on definer triggers (advisor 0028/0029) | 02024; `migrate-core.test.mjs` |
| 2026-10-21 | Deploy pass re-granted `cortex_request_log`; anon held writes on every table; 74 service-role modules without `server-only` | 02025; `findRevokesUndoneByGrantPass`; posture §18–25; `service-role-boundary.test.ts`; CI |
| 2026-10-21 | Guest could read any Freemius license key via the checkout-sync callback | `freemius-checkout-license.test.ts`; display re-check in `freemius-license.ts` |
| 2026-10-21 | Coupon context quantities and `%` wildcard codes; Stripe paid on unsettled sessions | `coupons.test.ts`; wildcard case in `coupon-server.test.ts`; `stripe/webhooks.test.ts` |
| 2026-10-21 | Service-role helpers skipped the second factor (regression of 96a80a00); unauthenticated currency actions; WRITER product CSV import; `/two-factor` open redirect; sanitizer bypasses | `cms-actor.test.ts`, `require-ecom-role.test.ts`, `inlineScriptNonce.test.ts` |
| 2026-10-21 | WRITER rewrote `email_public` (SMTP host, so SMTP creds + 2FA mail) and 12 more non-secret `site_settings` keys; email-2FA ADMIN passed `is_admin_mfa()` at aal1; scripts/redirects/`system_configuration`/message ADMIN branches without aal2; media decoy rows deleted other uploaders' files; demo ADMIN read license keys | 02028; posture §30–34; `media-object-keys.test.ts`; `cms/media/actions.test.ts` |
| 2026-10-21 | Cortex DB tools: write-protected `site_settings` (`is_admin_created`, `security_settings`) reachable through `in`/`ilike` filters and deletes; `license_key` returned by `read_database_records` | `ai-global-agent-db-tools.test.ts` |
| 2026-10-21 | MCP tokens kept full write after their creator was demoted or deleted; only site/theming tools re-checked the role; `update_global_css` allowed WRITER | `ai-global-agent-tools-roles.test.ts`, `mcp-tokens.test.ts`, `cms/users/actions.test.ts`, `ai-global-agent-theming-tools.test.ts` |
| 2026-10-21 | `global_css` rendered raw into `<style>` (`</style>` broke out on every page); SSRF through redirects in `fetch_url_content` and the media importer (internal hop requested and its status reported, whole body buffered, CGNAT/198.18/NAT64 unblocked) | `style-element-text.test.ts`; `ai-global-agent-ssrf.test.ts` (local server), `lib/media/external-image-import.test.ts` |
| 2026-10-21 | `importExternalImageToMedia` / `recordMediaUpload` server actions trusted a caller-supplied `actorUserId` (cookieless POST as any admin); stock photos, site overview and media list did not taint a build turn | `cms/media/import-external-image.test.ts`, `libs/db/src/lib/media-actions.test.ts`; `untrusted-tool-results.test.ts` |
| 2026-10-21 | `revisions/service.ts` was `'use server'` (every export took a caller-supplied `authorId` and `client`); `validateCheckoutEligibility` read the profile of any user id the caller named; no check stopped an action from taking its actor as an argument | `server-action-actors.test.ts` (in `security:check`); `customer-actions.test.ts` |
