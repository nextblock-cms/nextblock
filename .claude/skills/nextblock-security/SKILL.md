---
name: nextblock-security
description: NextBlock's security gate. Use before finishing ANY change that touches a migration, RLS policy, GRANT/REVOKE, Postgres function or trigger, the post-apply grant pass, auth/2FA/roles, a server action ('use server'), an API route handler, the service-role client, uploads or server-side fetches of user URLs, webhooks, checkout/pricing/coupons/orders, Cortex tools or the MCP server, rendered HTML, or anything a 'use client' component imports. Runs the automated gates and walks the checklist of every vulnerability class found in the 2026-10 red-team.
---

# NextBlock security gate

Every item below is a real hole that shipped at least once (2026-10-17 → 11-03). The automated
gates catch most of them; the checklist covers what they cannot see. A change is not done until
the gates pass and every checklist line that applies has been answered.

## 1. Run the gates

```bash
npm run security:check        # service-role boundary, action actors, sandbox guards, HTML sinks, migration lint, posture runner guard, grant-pass lockstep (~20 s)
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

A Stop hook (`.claude/settings.json` → `tools/scripts/claude-security-stop-hook.mjs`) runs
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
- Partner portal (Affiliates): every page, action and route calls `requireRetailerPage()` /
  `requireRetailer()` (`lib/affiliates/retailer-actor.ts`) first: session, enrolled second
  factor, role `RTL` from the caller's own `profiles` row (`String(role)`), the program active
  (`isAffiliatesProgramActive()`: Affiliates and the Commerce Pro it requires, failing closed;
  never `verifyPackageOnline('affiliates')` alone, which `package-state.test.ts` refuses), not
  suspended. The actor's affiliate is the only one it may touch; filter every write on its id
  and user id.
- An approval publishes exactly what the reviewer saw: pin every field it copies, not only the
  one an edit bumps (storefront Approve checks `draft_version` and a fingerprint of the profile
  snapshot, `fingerprintAffiliatePublishedProfile`). A per-page action that mails admins has a
  rate limit inside its conditional UPDATE (the resubmission cooldown).
- A route handler that mutates with cookies needs the same checks. Cron routes check their secret
  with `isCronRequestAuthorized()` (`lib/cron/cron-secret.ts`: SHA-256 of both sides +
  `timingSafeEqual`; never compare the header with `===` / `!==`) and fail closed without it; the
  FX sync (`/api/cron/sync-currencies`) is the one documented route that stays open while
  `CRON_SECRET` is unset, and the payout route (`/api/affiliates/cron/payouts`) also refuses a
  secret under 16 characters.

**Service-role client** (bypasses every RLS policy)
- A module that builds, hands out or keys it imports `'server-only'`; the key is read only by
  `lib/setup/service-key.ts`; import types from server modules with `import type`; no secret
  behind `NEXT_PUBLIC_` or `next.config.js` `env`. Gate: `service-role-boundary.test.ts`.
- Under the service role RLS is not a boundary: the in-code role check IS the authorization.

**Stored secrets** (`libs/db/src/lib/secret-crypto.ts`)
- Seal and open every stored secret for its slot, the row and field it lives in:
  `encryptWithEnvKey(value, siteSettingSecretSlot(key, field))`, `tryDecryptWithEnvKey(envelope,
  sameSlot)`. Never one decrypt helper for several rows (Cortex opened its three keys with the
  OpenRouter one): an envelope copied into another row must read as missing there, above all where
  the plaintext leaves the server (SMTP AUTH to a saved host, a form that shows it).
- A new secret row is named `<feature>_secret` or `<feature>_api_key`: 02038's pattern then keeps
  it service-role only with no migration. Its screen re-seals version 1 envelopes on save
  (`resealWithEnvKey`). Gates: posture §42, `secret-crypto.test.ts`.

**RLS policies**
- Every policy names its roles (`TO authenticated` …); one without `TO` also applies to `anon`.
- No `USING (true)` / `WITH CHECK (true)` for `anon`/`authenticated` on a table holding users,
  orders, coupons, licenses, tokens, revisions, settings, 2FA, carts or messages.
- An authorization column (`profiles.role`) is pinned by column grants first (02025), then
  `WITH CHECK` and a trigger. A self-service `FOR UPDATE` policy covers every granted column.
- ADMIN branches on orders, profiles (other rows), the site_settings ADMIN tier and the commerce
  tables use `is_admin_mfa()` (aal2 when a factor is enrolled, 02023); CMS screens read those
  rows with the service role after the in-code check, never through the cookie client. The
  site_settings secret rows answer to no API session at all (02038): `is_admin_mfa()` also passes
  an admin who enrolled no factor, so it is no boundary for a secret.
- Draft/scheduled/archived rows and their children (media, stock, categories) stay staff-only.
- Roles in SQL are compared as text (`(SELECT public.get_current_user_role())::text = 'RTL'`,
  `role::text = 'RTL'`): the sandbox replays every migration in one transaction, where 02029's
  label is not committed. `findEnumRtlLiterals` refuses an `'RTL'::public.user_role` cast outside
  a plpgsql body.

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
- Authored HTML renders through `sanitizeAuthoredBlockHtml` (`@nextblock-cms/utils`; the app's
  `lib/blocks/inlineScriptNonce.ts` re-exports it) wherever it is written into a page: React
  `dangerouslySetInnerHTML`, html-react-parser, `innerHTML`, a `text/html` Blob. This covers a CMS
  preview too, and lib components sanitize inside themselves (the app wrappers never see the
  value). The CSP is no backstop: `script-src` keeps host sources (Google Tag Manager serves any
  container) without `'strict-dynamic'`, and a meta refresh needs no script. Gate:
  `html-sinks.test.ts` (every sink listed in `HTML_SINKS` with why it is safe; a sanitized sink
  must still call the sanitizer; a component marked `noCallers` may not be imported or used). A text
  block holding Tiptap JSON (`isTiptapJsonString`) skips the sanitizer in its callers and renders
  through React; never put that exemption inside the sanitizer, because raw sinks inject
  JSON-parseable strings as HTML. Redirect targets go through `lib/auth-redirects.ts`.
- Partner storefront JSON (`affiliate_pages.draft_content`, which a partner can PATCH over the
  Data API, `published_content`, copilot sections) is untrusted wherever it is read: run
  `sanitizeStorefrontDoc` at read time with `getStorefrontImageOrigins()` (server-side, passed
  down as a prop), render only through `StorefrontRenderer`, and edit only with
  `@nextblock-cms/affiliates/editor`. Never load partner JSON into `NotionEditor` (its kit keeps
  arbitrary HTML) and never render it as HTML.
- Partner uploads go through `/api/affiliates/upload` only: `requireRetailer()`, same-origin,
  refused while the page is in review, byte-capped before buffering, magic-byte sniffed (SVG
  never reaches sharp), decoded under a pixel cap (12 MP for AVIF, which costs about 25 bytes a
  pixel; 50 MP otherwise), one decode at a time per process with a 30 s timeout, re-encoded to a
  metadata-free JPEG, keys built on the server under `affiliates/{avatars|pages}/<affiliateId>/`.
  An upload never deletes the avatar the approved snapshot shows. No staff path touches the
  partner namespaces `affiliates/avatars/` and `affiliates/pages/` (`PARTNER_UPLOAD_NAMESPACES` /
  `isPartnerUploadKey` in `lib/storage/upload-policy.ts`): the staff upload routes refuse a folder
  inside them (`resolveUploadFolder`), `/api/process-image` and `/api/media/record` refuse such a
  key, and the media delete and move actions never touch one. The rest of `affiliates/` is
  ordinary media.
- A proxy response that sets a per-visitor cookie (the referral cookie) is
  `Cache-Control: private, no-store`, so no shared cache replays it to someone else. No admin
  surface (a CMS page, an admin email) links a storefront: an admin's click would set the
  referral cookie. Checkout honours a declined marketing consent too (`attribution.ts`), for the
  storefront token and for a referral cookie the proxy has not expired yet.
- A secret from the environment goes only where the environment says: credentials from `SMTP_USER`
  / `SMTP_PASS` go only to `SMTP_HOST` whenever `SMTP_HOST` is set (`resolveEmailServerConfig`),
  never to a host saved in the database. Their port is the CMS port saved for that same server,
  else `SMTP_PORT`, else 587. A CMS port that moves them off the env's own port must be encrypted
  (TLS required, a loopback relay aside) and the toggle can only raise TLS: the database may pick
  the port, never the server, and never less encryption than the env alone. Failing closed there
  stopped all mail (2FA codes too). With `SMTP_HOST` unset they still pair with the CMS host: the
  split legacy setup `email-settings.test.ts` pins, ADMIN-only and never on the sandbox. On the
  sandbox (public admin login, second factor always satisfied) nothing in the database may steer
  an outbound send: email settings are neither saved nor read, test emails are off, affiliate
  notices mail nobody, and `sendEmail` delivers only to `SANDBOX_CONTACT_EMAIL` and the product
  feedback inbox. Payment rows are neither saved nor read there either (`loadPaymentRows`), so a
  row written over PostgREST never reaches `process.env`.
- The public sandbox (`NEXT_PUBLIC_IS_SANDBOX=true`) publishes its admin login, and the demo
  partner's once the Affiliates demo is configured. Every reset empties the bucket, deletes every
  auth user but the two preserved demo ids, rebuilds `public`, and restores the demo admin
  (password re-asserted, every second factor deleted) right after the SQL. Out of its reach: the
  rest of those two `auth.users` rows, GoTrue's settings, sent mail, anything at a payment provider
  (a Freemius coupon), and what another visitor already read. Anything a visitor can trigger there
  that would outlive the reset or reach someone outside it, or that later visitors would run or
  read, stops before that step: as the first statement or right after the admin check (read-only
  checks may run first, as partner sign-up's do):
  - accounts (sign-up, partner sign-up, `/cms/users`, password changes, second-factor enrollment,
    a full-backup restore);
  - mail (at the send: `sendEmail`);
  - money and provider writes (checkout, payouts, Connect, coupons pushed to Freemius, license
    activation and resend);
  - secrets later visitors would read or spend (payment rows, captcha, AI keys, MCP tokens, the
    full-backup export);
  - scripts or markup every visitor runs (site scripts, custom scripts, a GTM container: refused
    where they render, not only where they are saved; authored HTML is sanitized everywhere);
  - the shared demo accounts.

  By design, ordinary content edits and uploads still reach other visitors until the next reset,
  and Cortex model, stock-photo and web-fetch calls still leave the site on the deployment's env
  keys (docs/05 → "Sandbox Reset Operations" lists what to provision there).

  List each refusal in `SANDBOX_GUARDS` (`tools/scripts/lib/sandbox-guards.js`) with a test that
  sets the flag to `'true'` (`vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true')`) and runs the function.
  A new mail transport, GoTrue account or second-factor call (on any client, stored handle or
  GoTrue-typed parameter), storage write or payment-provider write (Stripe, Freemius) goes into
  `MAIL_SENDERS` / `ACCOUNT_WRITERS` / `STORAGE_WRITERS` / `VENDOR_WRITERS` with how it behaves
  there. For mail, accounts and payment providers each call must sit in a guarded function, a
  private helper or class only those reach, or a function or class exempted by name with a reason;
  code that runs at import never qualifies. Gate: `sandbox-guards.test.ts`.
- Webhooks verify the signature over the raw body before parsing, and are idempotent. A refund
  or dispute reaches the affiliate ledger whatever the package state: one skipped while the
  license check failed is lost for good.
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
| 2026-10-27 | The CMS order status actions (`requireOrderManager()` in the ecommerce lib, and the app's own `markOrderAsPaid`) read the role with the cookie client and built the service-role client themselves, without the second factor, so a first factor alone could mark an order paid, refunded or cancelled (since 02030 also recording or voiding affiliate commissions) | `requireEcomStaff()` / `requireEcomAdmin()` in `pages/cms/orders/server-actions.ts` and `requireCmsAdmin()` in `app/cms/orders/actions.ts`; `pages/cms/orders/server-actions.test.ts`, `app/cms/orders/actions.test.ts`; the "CMS server actions" check in `server-action-actors.test.ts` (no `'use server'` module under `app/cms` or a lib's `pages/cms` builds a supabase-js client, reads the secret key or resolves it) |
| 2026-10-27 | `/cms/users` actions skipped the second factor (`verifyAdmin`); deleting a partner's account would erase the commission ledger (it cascades from `auth.users`); decoy media rows could name partner uploads; actions could take `affiliateId` / `retailerId` | `cms/users/actions.test.ts` (`requireCmsAdmin()`, RTL, the A24 delete guard), `media/record/route.test.ts` (partner-namespace keys refused), `media-object-keys.test.ts` + `cms/media/actions.test.ts` (`isPartnerUploadKey`: delete and move never touch them), `server-action-actors.test.ts` (`affiliateid`, `retailerid`) |
| 2026-10-27 | New surface, Affiliates schema (02029/02030): an `'RTL'::public.user_role` cast would break the one-transaction sandbox replay; the partner, ledger and click tables and twelve service-role RPCs need their revokes and column pins re-applied after every deploy | `findEnumRtlLiterals` (`migration-grants.test.ts`); the 02030 block of `migrate-core.test.mjs`; posture §35–38 (206 checks in all) |
| 2026-10-27 | New surface, partner-authored storefront JSON (PATCH-able over the Data API): script nodes, `javascript:` / `data:` links, foreign images, unknown nodes, depth and size bombs, prototype pollution | `sanitizeStorefrontDoc` as the XSS boundary: `storefront/sanitize.test.ts`, `renderer.test.tsx`, `urls.test.ts`, `editor-schema.test.ts`; `lib-structure.test.ts` (client entries never reach server code) |
| 2026-10-27 | Staff upload paths reached the partner namespace: `/api/upload/proxy` and `/api/upload/presigned-url` accepted an `affiliates/…` folder and `/api/process-image` read a partner's object and wrote six variants beside it, so a WRITER could fill a partner's upload caps or plant files in their prefix | `resolveUploadFolder` refuses the partner namespaces and `/api/process-image` refuses the key (`isPartnerUploadKey`, one definition in `lib/storage/upload-policy.ts`): `upload-policy.test.ts`, `upload/proxy/route.test.ts`, `upload/presigned-url/route.test.ts`, `process-image/route.test.ts` |
| 2026-10-27 | New surface, partner portal and referrals: helpers that hand out the service role to partners; a referral `Set-Cookie` a shared cache could replay | `service-role-boundary.test.ts` (`requireRetailer`, `requireRetailerPage` markers), `retailer-actor.test.ts` (no service client before a refusal), `proxy.test.ts` + `referral-cookie.test.ts` (`private, no-store`, import-free module) |
| 2026-10-29 | Affiliates ledger: test-mode and Freemius-sandbox sales could be paid with live money after a key switch; automatic retries sent less than the minimum; partial refunds were pro-rated on the gross charge (shipping included); a partial refund that came before the commission was dropped; open disputes did not hold commissions; partners rewrote name, bio and links over the Data API while in review | 02030 in place: `livemode` on orders, commissions and payouts with a mode-matched claim and retry, `prepare_affiliate_payout_retry(uuid, bigint)` (`below_minimum`), `private.affiliate_refund_share`, `orders.affiliate_refunded_minor`, `set_affiliate_commission_dispute` + `disputed_at`, the profile guard's review lock; posture §35–38 + 37b (206 checks in all); `sql-parity.test.ts` (ledger rules); the `migrate-core.test.mjs` signature list |
| 2026-10-29 | Affiliates payout runner and webhooks: "Run payouts now", Retry and Release worked while the package was inactive; a settings read error ran payouts with the defaults (automatic payouts on, minimum 100); a refused completion was judged on the run's stale copy of the payout (concurrent retries raised a false "its commissions may be paid again" alert); refunds skipped the ledger while the license check failed or the license lapsed, so the unreduced commission was paid on reactivation; cycles, retries and releases ignored the Stripe key's mode | `payout-runner.test.ts` (`package_inactive`, `settings_unavailable`), `settings.test.ts` (`readAffiliatesSettingsStrict`), `payouts.test.ts` (key modes, `below_minimum`, the refused completion judged on the current row), `refunds.test.ts` and the Stripe and Freemius webhook route tests (refunds and disputes applied whatever the package state), `attribution/dispute.test.ts`, `stripe/client.test.ts` and the provider tests (the key mode recorded at checkout) |
| 2026-10-29 | Approve published the partner's live profile, not the reviewed one (a profile edit never moves `draft_version`); a scripted withdraw and submit loop mailed every admin on every round and evicted every storefront cache; admin emails linked the live storefront (an admin's click set the partner's referral cookie); deleting a partner's user left the storefront cached | `fingerprintAffiliatePublishedProfile` pin: `review.test.ts`, `admin-data.test.ts`, `cms/affiliates/actions.test.ts` (plus the profile guard's review lock and its posture assertion); the resubmission cooldown in the conditional UPDATE: `portal/retailer/actions.test.ts`; `notifications/templates.test.ts` (no `/partners/` href or full URL in admin mail); `cms/users/actions.test.ts` (eviction on delete) |
| 2026-10-29 | Partner signup: unconfirmed signups took capped tier seats and handles for good; the signup IP bucket kept a full IPv4 for IPv4-mapped addresses and per-address buckets for compressed IPv6, and trusted a client-sent `x-vercel-forwarded-for` off Vercel | `signup.test.ts` ("creates only the auth user while the address is unconfirmed", "refuses a full program before creating an auth user", "trusts x-vercel-forwarded-for only on Vercel, where the platform sets it", the /24 and /48 masking cases) |
| 2026-10-29 | The storefront token in the cart, and a referral cookie the proxy had not expired yet, attributed checkouts of visitors who had declined marketing cookies; the token was never cleared after checkout, so one storefront add overrode every later referral for the whole tier window | `attribution.test.ts` ("marketing consent"), the declined-consent case in `app/api/checkout/route.test.ts`; `cart-store.test.ts` ("the token lives as long as the cart it was carried for"), `checkout/success/page.test.tsx` |
| 2026-10-29 | An avatar upload deleted the approved avatar that `/partners/<handle>` and its Open Graph card still showed | `upload/route.test.ts` (PUBLISHED, DRAFT and CHANGES_REQUESTED pages keep the snapshot's avatar), `avatar-cleanup.test.ts`, `review.test.ts` ("the avatar the new snapshot replaces") |
| 2026-10-29 | An AVIF whose clean-aperture crop declared a small image over a huge coded frame passed the 12 MP cap (sharp reports the cropped size) and was decoded in full | `largestAvifCodedPixels` reads the container's `ispe` extents before any decoder runs: `uploads.test.ts` (a real AVIF re-labelled 7000x7000 refused; no readable extents refused) |
| 2026-10-29 | `/api/process-image` checked partner keys without the shared key policy, so `./affiliates/pages/…` and other dot or empty segments dodged the partner check | `isSafeObjectKey` in the route: `process-image/route.test.ts` |
| 2026-10-29 | The storefront page minted the attribution token for visitors who had declined marketing, so the cart stored it without consent; `/api/cron/sync-currencies` (open while CRON_SECRET is unset) echoed provider and database error text | `storefront-page.test.tsx` (no token on a declined record); `sync-currencies/route.test.ts` (fixed 500 message) |
| 2026-10-29 | A ~1 KB, 49 MP AVIF decoded to about 0.9–1.2 GB under the 50 M pixel cap, and concurrent uploads multiplied it (a partner could exhaust the server's memory) | `uploads.test.ts` (a real AVIF just over 12 MP refused for both kinds while the same-size JPEG passes; the decode gate never overlaps; the processing timeout is set) |
| 2026-10-29 | The whole `affiliates/` folder was reserved on every install, so media an install already kept there lost its storage on delete (orphans), could not be moved and refused uploads | `upload-policy.test.ts`, `media-object-keys.test.ts` (namespace parity with the partner pipeline), `media/record/route.test.ts`, `cms/media/actions.test.ts` |
| 2026-10-29 | `/api/cron/reset-sandbox` and `/api/cron/sync-currencies` compared the bearer with a plain `!==` against `` `Bearer ${CRON_SECRET}` `` (length and content leak through timing) | `lib/cron/cron-secret.ts` (`isCronRequestAuthorized`: SHA-256 + `timingSafeEqual`, per-route `whenUnset`); `lib/cron/cron-secret.test.ts` (also fails on any plain `Bearer ${…}` comparison under `app/`, `lib/`, `components/`); `api/cron/reset-sandbox/route.test.ts`, `api/cron/sync-currencies/route.test.ts` |
| 2026-10-29 | Partner copilot: under sustained demand, refused attempts kept the shared request window full, so it stopped admitting anyone for the whole store; one request could run up to 72 stock photo lookups on the operator's provider keys (eight parallel section calls a step, three steps) | `request-quota.test.ts` (a three-hour over-demand simulation; refused and turned-away requests leave the window), the copilot `route.test.ts` (`release()` on every early return; one budget of 3 sections and 3 lookups per request), `tools.test.ts` (the budgets hold through an AI SDK run with eight parallel section calls) |
| 2026-11-03 | On the public sandbox the demo admin (published login, second factor always satisfied) could save the SMTP host while the username and password fell back to `SMTP_USER` / `SMTP_PASS`: pointing the host at their own server captured the deployment's SMTP login on the next send. "Send test email" and affiliate notices to up to 10 visitor-chosen addresses also made the sandbox a mail relay | `lib/config/email-settings.test.ts` (the sandbox saves nothing and reads only its env; env credentials go only to `SMTP_HOST`, also with one stored credential), `app/cms/settings/email/actions.test.ts` (sandbox test send refused), `lib/affiliates/notify.test.ts` (the sandbox records alerts but mails nobody) |
| 2026-11-03 | On the public sandbox a visitor could create live accounts and mail an address they typed (sign-up and forgot password, partner sign-up, `/cms/users`), relay mail through the deployment's SMTP account (message replies and retries, comment notices, a stored form recipient), break the shared demo accounts (partner suspend or tier, a user's role or deletion, a second factor enrolled on the demo admin that outlived every reset), and open real checkouts | `sandbox-guards.test.ts` (in `security:check`: every refusal listed with the test that sets the flag, and every mail transport, GoTrue account call and storage write must say how it behaves on the sandbox); `app/actions.test.ts`, `lib/affiliates/signup.test.ts`, `app/cms/users/actions.test.ts`, `app/actions/email.test.ts`, `lib/messages/thread-reference.test.ts`, `app/cms/settings/security/actions.test.ts`, `app/api/checkout/route.test.ts`, `app/cms/affiliates/actions.test.ts`, `app/api/cron/reset-sandbox/route.test.ts` (the demo admin's factors removed on every run; an error while GoTrue accepts public sign-ups) |
| 2026-11-03 | The sandbox let a visitor plant a site script, custom script or GTM container that ran nonce-blessed for every later visitor, `/cms` and the partner portal included, and could read the OpenRouter keys visitors keep in `localStorage`; keep a captcha secret later visitors read, and payment ids that `hydrateFreemiusEnvFromDb` copied into `process.env`; and leave a visitor's key and Cortex chat in the browser after sign-out | `components/SiteScripts.test.tsx` and `components/privacy/ConsentGatedAnalytics.test.tsx` (nothing renders on the sandbox), `site-scripts/actions.test.ts`, `google-analytics/actions.test.ts`, `bot-protection/actions.test.ts`, `libs/ecommerce/src/lib/payment-config.test.ts` (the sandbox neither saves nor reads the payment rows), `lib/cortex-ai/sandbox-headers.test.ts` (with the scan that every sign-out clears first) |
| 2026-11-03 | `forgotPasswordAction` redirected to an unchecked `callbackUrl` (open redirect), and `resetPasswordAction` (unused, shipped to scaffolds) let a missing or mismatched confirmation reach `updateUser` because its redirects were not returned | `app/actions.test.ts` (absolute, `//host`, `/\host`, `javascript:` fall back; every early exit returns before `updateUser`) |
| 2026-11-03 | On the sandbox, coupon, sale-price and promotion saves pushed live coupons (any code, up to 100% off) to the operator's real Freemius products with the deployment's bearer, and the reset dropped the mapping that would delete them; a `payment_public` row written over PostgREST or a Cortex DB tool still reached `process.env` through `hydrateFreemiusEnvFromDb`; the full backup exported every password hash and its restore wrote accounts through a stored `auth.admin` handle; a visitor could have Freemius resend a license email | `libs/ecommerce/src/lib/freemius-coupons.test.ts` (no fetch; `not_synced` on the sandbox, a Stripe-only coupon `not_required`), `payment-config.test.ts` (no read, env untouched), `lib/full-backup/server.test.ts` (403), `app/actions/package-actions.test.ts` |
| 2026-11-03 | Authored HTML reached the page raw: a product short description and a string `description_json` (lib components), custom-block rich text, the section editor's drag preview, the editor's SVG node and its Preview button (which ran WRITER scripts with the clicker's CMS session). The sanitizer missed an `on*` handler or `srcdoc` right after a quoted value, a tag left open at the end, and a script URL behind character references, a tab or a quote of the other kind (`&#x6A;avascript:`, `java&#9;script:`). Under the CSP a `<script src>` from Google Tag Manager or a meta refresh still worked. `HtmlContent` (exported by `@nextblock-cms/editor`) and `HtmlScriptExecutor` ran every script in the HTML they were given | `html-sinks.test.ts` (in `security:check`; a `noCallers` component may not be imported, or destructured or re-exported under another name; `HtmlContent` and `HtmlScriptExecutor` deleted 2026-11-04), `libs/utils/src/lib/authored-html.test.ts`, `ShortDescription.test.tsx`, `SimpleTiptapRenderer.test.tsx`, `DynamicLayoutEngine.test.tsx`, `SectionBlockEditor.test.tsx`, `SvgNode.test.ts`, `Toolbar.test.tsx`, `ClientTextBlockRenderer.test.tsx` (Tiptap JSON text blocks render as authored; the sanitizer's unclosed-value and quote-adjacent rules neutralise names; URL values are decoded before the scheme check) |
| 2026-11-03 | Alt-text vision routing gave an env OpenRouter credential (the sandbox's `OPENROUTER_API_KEY`, behind every visitor) the whole vision registry, so a 429 on the free models retried down the paid ones on the operator's key; `maybeTriggerStockPhotoDownloads` sent the operator's Unsplash key to whatever `attribution.downloadLocation` a block held (any host, redirects followed, no cap): a key leak and SSRF from a block any WRITER or sandbox visitor could save. A Freemius trial could be minted from the sandbox if the vendor flag was copied there | `libs/cortex/src/lib/ai-vision.test.ts` (env: only `:free` ids, a requested id dropped), `ai-global-agent-tools-unsplash-downloads.test.ts` (only `https://api.unsplash.com/photos/`, `redirect: 'error'`, a timeout, 20 per call), `app/api/packages/provision-trial/route.test.ts`, `lib/packages/revalidate-activations.test.ts`; `sandbox-guards.test.ts` now also scans Stripe and Freemius writes (`VENDOR_WRITERS`) |
| 2026-11-03 | The sandbox reset restored the demo admin only after the Commerce Pro steps, so a failing Freemius sync left a visitor's password and second factor in place; nothing tied the emptied bucket to the upload bucket; a Cortex reply still streaming at sign-out wrote the chat back. The gate itself exempted whole modules, missed GoTrue calls on stored handles and the MFA API, accepted a test that only mentioned the flag, never checked payment-provider writes call by call, missed a Stripe client carried in an object or a Freemius write through the shared URL constant or the SDK's services, and accepted code that runs at import inside a callback, a timer or a class's static field | `app/api/cron/reset-sandbox/route.test.ts` (restored first; upload-target alarm), `CortexGlobalAgentChat.test.tsx`, `sandbox-headers.test.ts`, `sandbox-guards.test.ts` (call-site check for mail, accounts and payment providers; stored, aliased and indexed handles; carried Stripe clients; Freemius constant and SDK services; import-time code; flag set + use per listed function) |
| 2026-11-04 | An ADMIN on an aal2 session, or one who enrolled no factor, read and wrote every secret row of `site_settings` over PostgREST (`is_admin_mfa()` branches of 02023/02028), and the envelopes were not bound to their row: copying the Stripe, Freemius, captcha or Cortex envelopes into `email_secret.user` / `.pass`, saving an SMTP host of one's own and clicking "Send test email" delivered the plaintext through SMTP AUTH (an XSS as that admin could too; not the sandbox, where mail never reads the database) | 02038: the secret rows (7 keys and any key named like a secret) are service-role only; version 2 envelopes sealed for their slot (`siteSettingSecretSlot`, AES-GCM associated data, 16-byte tag; version 1 still read and re-sealed on save); posture §42 + §16 (216 checks; with the pre-02038 policies restored, seven lines of §42 fail); `secret-crypto.test.ts` (copied, swapped, relabelled and truncated envelopes), `email-settings.test.ts` (a copied Stripe envelope never reaches SMTP AUTH), `payment-config.test.ts`, `botProtection/secret.test.ts`, `botProtection/verify.test.ts`, `bot-protection/actions.test.ts` (the form never shows a copied envelope), `ai-key-crypto.test.ts`, `ai-config-secrets.test.ts` (stock-photo rows, the compare-and-swap re-seal) |
| 2026-11-11 | A dispute opened before an order's commission existed was dropped, so a commission recorded late (reconcile after a pause) could clear and be paid while its order was disputed; a late recording also took the partner's tier at recording time instead of at payment, and the CMS tier move checked the cap without a lock | 02035 (`orders.affiliate_disputed_at`, rate and hold stored on the order at payment, locked `change_affiliate_partner_tier` revoked from the API roles); posture §39; `sql-parity.test.ts`; `migrate-core.test.mjs` |
| 2026-11-11 | Manual payouts, caught before 02036 shipped: "Record payout" booked whatever was owed when the admin clicked, after the money had left, so a commission that cleared, a refund, a dispute, a pause or a gateway switched back in between recorded commissions never paid or hid an overpayment; the queue and the PayPal file could count a partner's commissions twice across 1,000-row pages; a payout email starting with `=` `+` `-` `@` reached the PayPal file behind an apostrophe, which PayPal pays as a different address; a prepared manual payout would look like a stale Stripe transfer to the reconcile, retry and release paths | Claim-first lifecycle (`claim_` / `record_` / `cancel_manual_affiliate_payout`, the manual-row CHECKs and the one-prepared index, Stripe paths filtered on `method`): posture §40 (13 assertions, 231 checks in all), `sql-parity.test.ts`, `payouts.test.ts` ("a prepared manual payout is never a Stripe payout"), `manual-payouts.test.ts` (keyset dedupe; the file lists prepared payouts only), `obligations.test.ts`; `payout-methods.test.ts` and `paypal-payouts-csv.test.ts` (formula-first recipients refused and left out) plus the `payout_email` CHECK; the `migrate-core.test.mjs` signature list |
| 2026-11-11 | New surface, PayPal Payouts (02037): real money from the operator's PayPal balance, with credentials saved in the CMS. A sandbox visitor could otherwise save their own PayPal app or spend the operator's env pair, an API role could reach the five PayPal RPCs after a deploy's grant pass, the encrypted secret row could be read over the Data API, and a resend after an unknown outcome could pay a batch twice | `sandbox-guards.js` detects PayPal writes (a non-GET fetch in a module naming a PayPal REST host, and the client's `createPayoutBatch` / `cancelPayoutItem` anywhere) and lists the PayPal client, credentials, engine, runner, admin module and CMS actions in SANDBOX_GUARDS (`sandbox-guards.test.ts`); the five RPCs in `API_ROLE_REVOKE_SQL` of both files (`migrate-core.test.mjs`); posture §41 (12 assertions, 243 checks in all: RPC privileges, the RESTRICTIVE `site_settings` policy on `affiliates_paypal_secret`, no API write of a PayPal column, the `payout_email_kind` pin, exactly-once completion); `paypal/client.test.ts` (fixed hosts, `/v1/` paths, the sender_batch_id as PayPal-Request-Id, zod on every answer), `paypal/engine.test.ts` (the sender id saved before the create call, the same id on a resend), `paypal/credentials.test.ts` (no secret leaves the module), `paypal/admin.test.ts`, `cms/affiliates/paypal/actions.test.ts` |
| 2026-11-11 | PayPal Payouts review, caught before 02037 shipped: 02036's manual status CHECK refused a FAILED PayPal payout, so every PayPal failure, stop and release raised, kept the commissions reserved and blocked the partner for good; a resend refused for credentials, Payouts access or balance released payouts PayPal may already hold (paid twice once claimed again); Release checked "an hour after the last send" in TypeScript only while a resend never stamped the send, and a resend sent the run's stale snapshot (a payout released meanwhile); an unconfirmed batch was resent past PayPal's 30-day idempotency window; the Stripe `fail_` / `release_affiliate_payout` and `prepare_affiliate_payout_retry` could fail a PayPal payout with its commissions attached or rewrite the reason that keeps PayPal off a returned address | 02037: the manual status CHECK scoped to `method = 'manual'`, `affiliate_payouts_paypal_failure_reason_check` (a FAILED PayPal payout carries a `paypal_` reason), `release_paypal_affiliate_payout` (the release rule under the payout lock) in `API_ROLE_REVOKE_SQL` of both files (`migrate-core.test.mjs`), the resend stamp in `record_paypal_affiliate_payout_batch`; posture §41 (15 assertions, 246 checks in all: a PayPal payout can be FAILED with a `paypal_` reason only, the four Stripe RPCs raise on one with a ready Connect account and an attached commission, the release windows and the resend stamp, the `payout_email_saved_at` pin); `sql-parity.test.ts`; `paypal/engine.test.ts` (a refused resend never calls the fail RPC, the stamp precedes the create call and a payout released meanwhile is not sent, no resend past 25 days, Release only through the release RPC) |
