# 15 · Affiliates & Creator Storefronts

NextBlock Affiliates & Creator Storefronts is a premium package (package id `affiliates`,
library `@nextblock-cms/affiliates` in `libs/affiliates`). It lets a store recruit partners who
earn a commission on the orders they refer:

- A visitor signs up at `/partners` (`/partenaires` in French) and becomes a **partner**
  (database role `RTL`, shown as "partner" / "partenaire" in the UI).
- Each partner gets exactly one co-branded storefront page, `/partners/<handle>`, edited in a
  restricted editor. An admin approves every version before it goes live.
- Referral links (`?ref=<handle>`) and the storefront set a first-party cookie; checkout credits
  the partner.
- A commission is recorded when a referred order is first paid. It waits out a refund-protection
  hold, then Stripe Connect Express pays it to the partner's bank automatically.
- Partners can use a sandboxed Cortex AI copilot that only writes their bio and storefront copy.

Code is the authority over this file: `libs/affiliates/src/**`, `apps/nextblock/lib/affiliates/**`
and `libs/db/src/supabase/migrations/02029_user_role_rtl.sql`, `02030_affiliates_schema.sql`.

## At a glance

| Who | Where | What |
| :-- | :-- | :-- |
| Visitor | `/partners` | Landing page with the tier ladder, revenue calculator and signup form |
| Visitor | `/partenaires` | The same landing page, always in French |
| Visitor | `/partners/terms`, `/partenaires/conditions` | The built-in partner terms (or a redirect to the operator's own page) |
| Visitor | `/partners/<handle>` | A partner's approved storefront |
| Visitor | any public page `?ref=<handle>` | Referral link: sets the referral cookie |
| Partner | `/portal/retailer` | Overview: onboarding steps, stats, share tools, recent commissions |
| Partner | `/portal/retailer/storefront` | Storefront studio: profile, page settings, editor, preview, copilot |
| Partner | `/portal/retailer/payouts` | Stripe Connect onboarding, balances, commissions, payout history |
| ADMIN | `/cms/affiliates` | Overview, partner table, activity feed, program settings |
| ADMIN | `/cms/affiliates/tiers` | Tier CRUD |
| ADMIN | `/cms/affiliates/approvals`, `/approvals/<pageId>` | Review queue and the side-by-side review |
| ADMIN | `/cms/affiliates/payouts` | Commission ledger, payouts, Retry / Release, "Run payouts now", Pay manually (prepare, record or cancel a payout, the PayPal payouts file) |
| ADMIN | `/cms/affiliates/stripe` | Stripe payouts: who pays partners, the key facts, "Test connection", balance vs what is owed, keeping money in Stripe, automation, setup guide |

The CMS screens are English-only. Everything a visitor or partner sees is English and Québec
French.

## Package gating and activation

Affiliates is an add-on to Commerce Pro: partners earn a share of store sales, so without the
shop there is nothing to sell. The registry says so (`NEXTBLOCK_PACKAGES.affiliates.requires` is
`['ecommerce']`), and the program runs only while both packages are active.
`isAffiliatesProgramActive()` (`lib/affiliates/package-state.ts`, React `cache`) checks
`AFFILIATES_PACKAGE_ID` and every package it requires through `verifyPackageOnline` (cached
60 s), counts a failed check as inactive, and gates every surface. Below, "inactive" means either
package is off or its check failed. A dormant program deletes nothing: partners, storefronts and
the ledger are back as they were once both packages are active again. `package-state.test.ts`
fails on a direct `verifyPackageOnline('affiliates')` or `isPackageActive(AFFILIATES_PACKAGE_ID)`
anywhere in `app`, `lib` or `components`, since that check would skip Commerce Pro.

- `/partners` and `/partenaires`: while the program is inactive they serve the CMS page with that
  slug (`partners`, `partenaires`) when one is published, else 404. A static route always beats
  `app/[slug]`, so the program route calls the `[slug]` page module itself (the page and
  `generateMetadata`, with the same `searchParams`). `/partners/<handle>` and its social card
  answer 404 (checked before the lowercase redirect). One gate serves all of them:
  `app/(public)/partners/_components/package-gate.ts` (`isAffiliatesPackageActive`, React `cache`
  over `isAffiliatesProgramActive`).
- The portal, its actions and routes: `requireRetailer()` throws `PackageInactive`;
  `requireRetailerPage()` sends a signed-in partner to the home page (every sign-in sends a
  partner to the portal, so a 404 there would greet every partner who signs in to shop). The
  header's "Partner portal" link is hidden.
- **The header and footer links of 02034** ("Become a partner" / "Devenir partenaire" in the
  header, "Partner program" / "Programme de partenaires" in the footer) are hidden.
  - The root layout drops both seeded translation groups, and every row nested under them,
    through `hideDormantPartnerProgramNav` (`lib/affiliates/partner-program-nav.ts`).
  - The filter keys on the groups, never on the URL, so a site's own `/partners` CMS link stays.
  - While the program runs, the header row renders as a highlighted pill with a "New" badge (from
    `lg` up; compact at `md`) and the footer row gets the same badge.
  - Operators edit or delete the rows in /cms/navigation (a delete removes both languages).
  - Rows that Cortex's footer or navigation tools recreate lose the group and become plain links.
- **The home-page section of 02034** (below "More Than a CMS. An Ecosystem." since 02040, which
  moved it from right after the Cortex AI section; sentinel class `nb-partner-program`) is seeded
  content, not code: it stays visible.
  - Its buttons are absolute `https://nextblock.dev` links, like the other seeded promos, so they
    work on every install.
  - It shipped to every install that still had the seeded Cortex AI section. A customized home
    page was left alone.
- `/cms/affiliates/**`: redirects to `/cms/settings/packages`. The sidebar's Partners group, the
  approvals badge and the affiliate banner alerts are hidden.
- Checkout attribution, the commission sweep, the payout runs and the sitemap entries are
  skipped; the copilot route answers 403 (it also needs `cortex-ai`). "Run payouts now", Retry
  and Release answer `package_inactive` ("The affiliate program is paused: it needs both the
  Affiliates package and Commerce Pro to be active.") while the program is inactive: the payout
  runner checks it for every trigger (cron and admin) and for both admin payout actions, because
  a server action is its own POST endpoint whatever page it came from. So a stuck payout cannot
  be retried or released while either license has lapsed; `PROCESSING` payouts are reconciled
  after reactivation.
- Refunds and disputes always reach the ledger (`apply_affiliate_refund`,
  `set_affiliate_commission_dispute`), like the order trigger does. One skipped while the license
  check failed or the license lapsed would be lost for good (nothing re-derives a partial
  refund), and the unreduced commission would be paid on reactivation.

The proxy cannot check the package (it has no service role). On a deactivated install that still
has approved partners it keeps setting the referral cookie and counting clicks, but checkout
ignores the cookie. An install without the schema sets nothing (the referral RPC is missing,
which counts as "no partner").

### The Freemius product

`NEXTBLOCK_PACKAGES.affiliates` (`libs/utils/src/lib/nextblock-packages.ts`) points at Freemius
product 43273, plan 75655 (single-site pricing 110047; an "Apps & Software" product of the
"NextBlock CMS" store, like Commerce Pro and Cortex AI). Its `pricing` is the add-on price, USD
200 a year or 20 a month (450 a year together with Commerce Pro's 250), and its `trial` the usual
30 days without a card. Keep the registry in step with the plan: the dashboard quotes the
registry, the checkout charges the plan. With both ids set:

- `/cms/settings/packages` offers the free trial and the checkout for Affiliates once Commerce
  Pro is active (see "On the packages screen"). A pasted license key, or `NEXTBLOCK_LICENSE_KEY`
  with `NEXTBLOCK_LICENSE_PACKAGE=affiliates`, activates it through
  `activateLicenseKeyWithFreemius` (`lib/packages/activate-license.ts`). Activation calls
  Freemius' public license API: an install needs no Freemius key.
- The vendor routes accept it: `POST /api/packages/claim-license` (hands the buyer's CMS its key
  right after a dashboard purchase or trial) and `POST /api/packages/provision-trial` (headless
  trials) look the product up in the registry deployed on nextblock.dev, so nextblock.dev must run
  this registry before anyone buys. Both read the license with that product's Freemius keys
  (`resolveFreemiusCheckoutCredentials`): the one product saved under CMS → Payments, else its
  entry in `FREEMIUS_CHECKOUT_PRODUCTS_JSON` (`"43273": {"publicKey", "secretKey", "apiKey"}`, the
  apiKey being the Bearer token). Without them the claim fails and the buyer pastes the key
  Freemius emailed them; the purchase itself and the activation are unaffected.
- An install sees the ids only once it runs a `@nextblock-cms/utils` that carries them: an older
  one cannot activate an Affiliates key at all. Publish that release as a minor version, since
  scaffolds pin `^0.x.y` and an older packages screen would otherwise offer Affiliates to installs
  that lack its code.
- `create-nextblock activate affiliates` says Affiliates is an add-on for Commerce Pro
  (`PREMIUM_PACKAGES` in `apps/create-nextblock/bin/lib/activate.js` mirrors `requires` and
  `dashboardCheckout`; `activate.test.js` fails on drift).

A package without a Freemius product (`fm_product_id: ''`, as Affiliates was before 43273) gets no
trial, checkout or license-key activation: `hasPackageCheckout()` is false, its card says "Not sold
in the dashboard yet" and links to its guide, and `getPackageByFreemiusId('')` never matches.

### Freemius setup (vendor checklist)

What the product was set up with on 2026-10-29, and what is left (dashboard labels change):

1. **Product** (done): "Apps & Software", type Extension (Freemius' pricing page puts plugins and
   add-ons in its WordPress fee group), store "NextBlock CMS", title
   `NextBlock Affiliates & Creator Storefronts`, icon `apps/nextblock/public/images/affiliates-icon.png`.
   It belongs to the developer account in `FREEMIUS_DEVELOPER_ID`, which the store sync reads.
2. **One plan** (done): single-site pricing at USD 20 a month and 200 a year (no lifetime, no bulk
   or unlimited tier), a 30-day trial with "Require Credit Card or PayPal" off, "Release plans to
   users" on, a features list for the checkout. Keep exactly one plan: the store sync and the
   sandbox reset turn every plan into its own active product. The plan description becomes the
   store's short description. Never rename the product or plan title: the store slug, and so
   `purchase_url`, is built from both.
3. **Refund policy** 30 days (the store copy promises it); license keys shown to customers.
4. **Keys** for the claim route, as above, then the **webhook** listener
   (`https://nextblock.dev/api/webhooks/freemius`, all events) once the product's secret is
   deployed: until then every delivery answers 401.

The store page is migration `02032` (vendor-only: it runs where the Commerce Pro store product
exists, which is nextblock.dev). It creates the English product the way the Freemius store sync
would (SKU `FM-43273-75655`, slug `nextblock-affiliates-creator-storefronts-affiliates-license`,
price 200, the plan and its single-site pricing), its French twin (`…-fr`), the copy of
`affiliates-product-copy.ts`, the bundled cover and the Software category, both rows as **drafts**:
publish them under CMS → Products at launch. Never sync the product from Freemius afterwards: a
sync rewrites title, slug, short description, price and status. `purchase_url` is that page.
Deploy nextblock.dev with the whole Affiliates release before anyone buys, then publish the
libraries in order, `@nextblock-cms/affiliates` for the first time, before the CLI.

The public sandbox imports every product of the developer account at each reset and dresses
Affiliates like Cortex AI (see "Sandbox demo"). Set `FREEMIUS_AFFILIATES_SANDBOX_KEY` there to a
placeholder such as `sandbox-affiliates-demo`: the reset writes it into `package_activations` as
is and never sends it to Freemius, and its last four characters show on the card, so never use a
real key.

### On the packages screen

`missingPackageRequirements()` (same registry file) lists the required packages that are not
active; `/cms/settings/packages` passes them to each `PackageCard` as `missingRequirements`. The
Affiliates card always says "Add-on for Commerce Pro." While Commerce Pro is not active:

- An inactive Affiliates card adds "Requires Commerce Pro. Activate Commerce Pro first." Its trial
  and buy button stays disabled and reads "Requires Commerce Pro", and the checkout dialog is not
  mounted.
- An active Affiliates card shows a **Paused** badge instead of Active, with "Paused until
  Commerce Pro is active: nothing runs, and its data is kept." The license and **Deactivate
  License** stay.

### Activating it

Commerce Pro must be active too (start its trial on Administration → Packages); without it the
Affiliates package stays paused.

- **Any install:** Administration → Packages → Affiliates → start the free 30-day trial, buy a
  license, or paste a key ("Already have a license key?").
- **A license for your own site:** the trial link `https://checkout.freemius.com/app/43273/plan/75655/?trial=free`
  with your email gives you a 30-day key and makes you a user of the product, so Licenses →
  Create License can then issue one for you. The API needs no user at all:
  `POST https://api.freemius.com/v1/products/43273/plans/75655/pricing/110047/licenses.json` with
  the product's Bearer token and `{"expires_at": null}` returns an ownerless lifetime license
  (`secret_key` is the key); Freemius registers the owner when the key is activated.
- **Public sandbox:** the reset route activates it with `FREEMIUS_AFFILIATES_SANDBOX_KEY`, after
  Commerce Pro (`FREEMIUS_ECOMMERCE_SANDBOX_KEY`; see "Sandbox demo").
- **Local or development database:** insert the activation row yourself, the way the sandbox
  does. Run it as `postgres` (Supabase SQL editor or `psql`); the API roles cannot write
  `package_activations`.

```sql
-- Development databases only. Switches the Affiliates package on.
INSERT INTO public.package_activations (package_id, license_key, status, instance_name, last_validated_at)
VALUES ('affiliates', 'local-affiliates', 'active', 'http://localhost:4200', now())
ON CONFLICT (license_key, package_id) DO UPDATE
SET status = 'active', last_validated_at = now();
```

On a development database without a Commerce Pro license, run it again with `'ecommerce'` and
`'local-ecommerce'`. A package reads as active within 60 s (the `verifyPackageOnline` cache). The
daily license re-validation leaves such a row alone (it has no Freemius uid). **Deactivate** on
Administration → Packages removes it again.

## Architecture

### The library (`libs/affiliates`)

| Entry | File | Holds |
| :-- | :-- | :-- |
| `@nextblock-cms/affiliates` | `src/index.ts` | Client-safe: core (types, constants, handles, tiers, money, onboarding, social links, email normalization, status lists, payout methods), i18n (dictionaries, `createAffiliatesCopy`, `AffiliatesCopyProvider`, `useAffiliatesCopy`), storefront (document types, limits, URL rules, sanitizer, helpers, starter documents, block diff, `StorefrontRenderer`) |
| `@nextblock-cms/affiliates/editor` | `src/editor.ts` | Client-only: `StorefrontEditor`, the product picker, the Tiptap extensions and commands |
| `@nextblock-cms/affiliates/server` | `src/server.ts` | `import 'server-only'`, then the root entry plus repository, notifications, copilot, attribution, payouts and connect |

Each area lives in `src/lib/<area>/` with its own `index.ts`; the entry files only `export *`
the areas. The lib never builds a Supabase or Stripe client and never reads a secret: server
functions take the client as an argument (`AffiliateRepositoryClient` = `SupabaseClient<any>`)
and, for payouts and Connect, a structural Stripe client (`AffiliatesStripeLike`; the real
`stripe` client is assignable to it). `src/lib/lib-structure.test.ts` keeps the shape honest:
`'use client'` on line 1 of every client module, one declaration per exported name, no
`core/constants.ts` name declared again elsewhere, no `next/*` import, a root and editor graph
that never reaches `server-only`, `ai`, Stripe, Node builtins or the server entry, and
`server.ts` starting with `import 'server-only'`. Among the NextBlock libraries it depends on
`@nextblock-cms/utils` and `@nextblock-cms/ui` only (React 19 is a peer).

`package.json` declares `sideEffects`: only `src/server.ts` (its `import 'server-only'`) and
`src/lib/zod-config.ts` (`z.config({ jitless: true })`), each as source (`./src/...`, read by the
monorepo, which compiles the lib through tsconfig paths) and in both dist forms
(`./server.es.js`, `./server.cjs`, `./lib/zod-config.es.js`, `./lib/zod-config.cjs`). A bundler
may drop every other module, so a client island that imports one helper from the root entry
(the `/partners` calculator and signup form) does not ship `StorefrontRenderer` and the
sanitizer. `lib-structure.test.ts` fails when a
module gains or loses a top-level side effect (a bare import, a top-level call or control flow)
and the list does not follow; `verify-lib-dist.js` check 10 refuses a dist manifest that lost the
list or names a file the tarball lacks. The build emits no JavaScript for the pure
`lib/<area>/index` barrels (their `.d.ts` remain): the entries import the leaf modules directly.

Import the editor entry statically from a `'use client'` component. A dynamic `import()` makes
Nx treat the whole lib as lazy-loaded and fails `enforce-module-boundaries` on every static
import; for the same reason app tests mock lib modules with `vi.importActual`, never `import()`.

### App modules

`apps/nextblock/lib/affiliates/` (every module imports `'server-only'` except the pure
`referral-cookie.ts`, `partners-paths.ts`, `portal-return-path.ts` and `paypal-payouts-csv.ts`):

| Module | Job |
| :-- | :-- |
| `package-state.ts` | `isAffiliatesProgramActive()`: the Affiliates package and Commerce Pro are both active; the only package check the app makes for the program |
| `retailer-actor.ts` | `getRetailerActor()`, `requireRetailer()`, `requireRetailerPage()`: the partner equivalent of `lib/auth/cms-actor.ts` |
| `referral-cookie.ts` | Dependency-free referral rules for `proxy.ts`: request decision, window cache, cookie, visitor hash, the consent parser and the IP masker |
| `partners-paths.ts` | Dependency-free paths for `proxy.ts` and the routes: the landing (`/partners`, `/partenaires`) and terms (`/partners/terms`, `/partenaires/conditions`) addresses, the French pin (`isFrenchPartnersPath`), canonical and hreflang paths, and where a terms link points (`partnersTermsHref`: the operator's page, else the built-in terms) |
| `portal-return-path.ts` | `buildAffiliatePortalReturnPath()`: the sign-in return address of a portal page, kept inside `/portal/retailer` |
| `storefront-token.ts` | Signed storefront attribution tokens |
| `attribution.ts` | `resolveAttributionForCheckout()` for `/api/checkout` |
| `refunds.ts` | Stripe and Freemius refund and dispute handlers (run whatever the package state), `scheduleAffiliateCommissionSweep()` |
| `payout-runner.ts` | The daily fallback, "Run payouts now", Retry / Release, platform info; since 02036 only the gateways paid through Stripe go to the cycle, and the ledger repair runs without Stripe |
| `manual-payouts.ts` (02036) | Pay manually: what is owed and not prepared (`loadAffiliateManualPayoutQueue`), the prepared payouts (`loadAffiliatePreparedManualPayouts`), prepare (`prepareManualAffiliatePayoutNow`, `prepareManualAffiliatePayPalPayoutsNow`), record (`recordManualAffiliatePayoutNow`), cancel (`cancelManualAffiliatePayoutNow`) and the PayPal file (`buildAffiliatePayPalPayoutsFileNow`), each after `requireCmsAdmin()` |
| `paypal-payouts-csv.ts` (02036) | Pure: the PayPal Payouts upload CSV, its spreadsheet-formula neutralization, and `isAffiliatePayPalRecipientSafe()` (a recipient is never rewritten) |
| `paypal/client.ts` (02037) | The PayPal Payouts REST client: fixed hosts, token cache, create / read / cancel, zod on every answer, `AffiliatePayPalError`; refuses on the sandbox before any fetch |
| `paypal/credentials.ts` (02037) | Where the PayPal credentials come from (the CMS row, then the `PAYPAL_*` env), the encrypted save after `requireCmsAdmin()`, the facts the CMS may show; nothing on the sandbox |
| `paypal/engine.ts`, `paypal/runner.ts` (02037) | The PayPal step of every payout run (sync, resend, claim and send) and the CMS Stop payment / Release; the runner wires it to the service role, the credentials, the events and the alerts |
| `paypal/events.ts` (02037) | The partner and admin notifications of PayPal payout events, and the operator alerts |
| `paypal/admin.ts` (02037) | The PayPal payouts screen: overview, Test connection, verify-then-save credentials, Check PayPal status now, Stop payment / Release; each after `requireCmsAdmin()`, refused on the sandbox |
| `payout-setup.ts` | The Stripe payouts screen: the read-only "Test connection" checks and the page's data (keys, balance vs what is owed, schedule, automation, the Connect setup alert) |
| `connect-service.ts` | Stripe Connect onboarding, status refresh and dashboard links for the portal; the partner country list and the Connect setup alert |
| `notify.ts` | Lifecycle alerts and emails, the "you earned" sweep |
| `settings.ts` | The `affiliates_settings` site setting: `getAffiliatesSettings()` for display, `readAffiliatesSettingsStrict()` for the payout runner, `getPublicAffiliatesProgramSettings()` for the public pages (terms links, minimum payout, payout switch, how partners are paid since 02036; cached, never the notification addresses), and the terms-link rules (`parseAffiliateTermsUrl`, `normalizeAffiliateTermsUrl`) |
| `signup.ts` | The `/partners` signup service and handle availability check |
| `sandbox-demo-partner.ts` | `shouldShowSandboxDemoPartner()`: whether the sandbox sign-in and sign-up pages list the demo partner |
| `storefront-data.ts`, `storefront-products.ts` | Cached anonymous reads for the public pages |
| `portal-data.ts`, `uploads.ts`, `upload-keys.ts`, `avatar-cleanup.ts` | Portal loaders and catalog search (since 02036 the payouts loader splits each figure by how its gateway is paid: `payoutMode`, `computeRetailerManualPayout`); partner image processing and storage; the server-built upload keys (no sharp, no I/O); the approval's removal of the avatar its snapshot replaced |
| `review.ts`, `admin-data.ts` | CMS approve / request changes / moderation (pause, resume, remove), and the CMS loaders (the Storefronts list, partner emails for the visible rows) |
| `affiliate-deletion-guard.ts` | `checkAffiliateUserDeletion()`: whether a partner has ledger history, asked by the `/cms/users` delete and by "Remove partner" |
| `partner-contact.ts` | The CMS "Email" link: the subject ("Your partner storefront on {site name}") and an RFC 6068 `mailto:` |
| `copilot-stock-images.ts` | The copilot's stock photo search (Cortex's provider keys) |
| `image-origins.ts`, `request-locale.ts`, `server-copy.ts`, `cache.ts` | Image origin allowlist, request locale, server copy and overrides, cache eviction |

Also: `lib/i18n/affiliate-translation-rows.ts`, `lib/i18n/cached-translations.ts` and
`lib/i18n/translation-pages.ts` (the translations split and the paged `translations` reader, see
"i18n"), `components/language-switcher-path.ts`
(which paths the language switcher looks up as CMS documents), and the client components in
`components/affiliates/` (`StorefrontCopilotPanel`, `public/PartnerSignupForm`,
`public/PartnerRevenueCalculator`, and `public/PartnerTermsLink`, the new-tab terms link the
signup checkbox and the portal share).

### Routes

| Route | File | Access |
| :-- | :-- | :-- |
| `/partners` | `app/(public)/partners/page.tsx` (binds the path to `_components/partners-route.tsx`: `renderPartnersRoute`, `buildPartnersRouteMetadata`; + `layout.tsx`, `actions.ts`) | Public |
| `/partenaires` | `app/(public)/partenaires/page.tsx` (the same route module; `layout.tsx` re-exports the `/partners` layout) | Public |
| `/partners/terms` | `app/(public)/partners/terms/page.tsx` (binds the path to `_components/partners-terms-route.tsx`: `renderPartnersTermsRoute`, `buildPartnersTermsRouteMetadata`; the view is `_components/partners-terms-view.tsx`) | Public; 404 while the program is inactive |
| `/partenaires/conditions` | `app/(public)/partenaires/conditions/page.tsx` (the same route module) | Public; 404 while the program is inactive or French is not active |
| `/partners/<handle>` | `app/(public)/partners/[handle]/page.tsx`, `opengraph-image.tsx` | Public |
| `/portal/retailer/**` | `app/(portal)/portal/retailer/**` (+ `retailer/loading.tsx`, and `portal/error.tsx` one segment up) | `requireRetailerPage()` (layout: suspended partners read-only; its sign-in or two-factor redirect returns to the requested portal page and query, read from the proxy's `x-nextblock-path` / `x-nextblock-search` and kept inside `/portal/retailer` by `buildAffiliatePortalReturnPath`) |
| `GET /portal/retailer/payouts/connect/refresh` | `payouts/connect/refresh/route.ts` | `requireRetailer()`; Stripe's `refresh_url` |
| `POST /api/affiliates/upload` | `app/api/affiliates/upload/route.ts` | `requireRetailer()` + same-origin |
| `POST /api/affiliates/cortex` | `app/api/affiliates/cortex/route.ts` | `requireRetailer({ allowAdmin: true })` |
| `GET` / `POST /api/affiliates/cron/payouts` | `app/api/affiliates/cron/payouts/route.ts` | `Authorization: Bearer <CRON_SECRET>` |
| `/cms/affiliates/**` | `app/cms/affiliates/**` | ADMIN (`proxy.ts` and `requireCmsAdmin()`) |
| `GET /cms/affiliates/payouts/paypal?currency=XXX` | `app/cms/affiliates/payouts/paypal/route.ts` (02036) | ADMIN: `requireCmsAdmin()` inside `buildAffiliatePayPalPayoutsFileNow` before any read; a CSV download, `private, no-store` |
| `/cms/affiliates/paypal` | `app/cms/affiliates/paypal/page.tsx` + `actions.ts` (02037) | ADMIN (proxy, layout, page, every action); the PayPal payouts screen; its actions refuse on the sandbox right after the admin check |

Route groups do not change URLs. `_components/` under `/partners` is a private folder, so it can
never collide with a handle; `terms` is a static segment, which wins over `[handle]`, and the
handles `terms` and `conditions` are reserved.

### Who is a partner

`requireRetailer(options)` resolves the caller the same way as `getCmsActor()`: the cookie
session, an enrolled second factor (`evaluateTwoFactor()`), and the role from the caller's own
`profiles` row, compared with `String(role) === 'RTL'` (the generated `user_role` type predates
02029). Only then does the service role load the affiliate profile and page (matched on both the
affiliate id and the user id). It throws `Unauthorized` (no session or a pending factor),
`Forbidden` (another role, or an RTL without an affiliate row), `PackageInactive`, `Suspended`,
or `AffiliateLookupFailed` (a database error, failing closed); ADMIN passes only with
`allowAdmin`, a suspended partner only with
`allowSuspended`. No service-role client exists before a refusal (tested in
`retailer-actor.test.ts`). `requireRetailerPage(path)` answers with a navigation instead:
`/sign-in?redirect=…`, `/two-factor?redirect_to=…`, `/partners` (customer, or RTL without an
account), `/unauthorized?reason=retailer_only` (staff), `/unauthorized?reason=retailer_suspended`,
or `/` (package inactive; an unknown reason is a 404).

Elsewhere: after sign-in an RTL account lands on `/portal/retailer` (a requested safe path is
kept, a `/cms/dashboard` target is not); `useAuth().isRetailer` and `isPartnerPortalActive` drive
a "Partner portal" link in the header, hidden while the package is inactive. The root layout reads
the activation (cached 60 s) for every visitor since 02034, because the seeded partner program
links depend on it too, but the portal link still shows to signed-in visitors only.
`/cms/users` can create and edit RTL accounts. Partners have no CMS access.

## Data model

Three migrations:

- **`02029_user_role_rtl.sql`** adds `RTL` to `public.user_role`, alone in its file: PostgreSQL
  refuses a new enum label inside the transaction that added it, and every apply path runs one
  transaction per file.
- **`02030_affiliates_schema.sql`** holds the schema: enums, seven tables, the `orders` and
  `system_alerts` additions, triggers, functions, RLS, grants and comments. It starts with
  `SET check_function_bodies = on` (02001 turns it off for the session).
- **`02031_affiliates_ui_translations.sql`** seeds the UI copy (see "i18n").

Two forward migrations followed on 2026-11-10:

- **`02033_affiliate_tier_goals.sql`** adds the display-only tier goals.
- **`02034_partner_program_nav_and_home.sql`** adds the header and footer links and the home-page
  section announcing the program.

And two on 2026-11-11:

- **`02035_affiliate_tier_rate_at_payment.sql`** lets an admin change a partner's tier at any time
  with the new rate applying only to orders paid from then on: the rate and hold are stored on
  each attributed order when it is paid (`orders.affiliate_commission_rate` /
  `affiliate_clearance_hold_days`), commissions are recorded at that rate whenever they are
  recorded, the hold counts from the payment, `affiliate_profiles.tier_changed_at` dates the last
  move, and `change_affiliate_partner_tier()` is the locked, service-role move. Because a late
  commission can now clear the moment it is recorded, a dispute that opens before the order has a
  commission is kept on the order (`orders.affiliate_disputed_at`, written by
  `set_affiliate_commission_dispute()`) and holds that commission from its recording. It also seeds
  the portal's "Tier since" copy and the reworded terms clause (see "The amount", "The ledger side"
  and "The CMS screens").
- **`02036_affiliate_manual_payouts.sql`** lets the operator pay a gateway's commissions outside
  Stripe (PayPal, Interac e-Transfer, Wise, a bank transfer), prepared before the money is sent
  and recorded after: the
  `affiliate_payouts` method and manual columns (a manual payout carries no Stripe field, is
  `PROCESSING` while prepared and `COMPLETED` once recorded, never `FAILED`; one prepared per
  partner and currency), `affiliate_profiles.payout_email` (server-written, protected by the profile
  guard, no leading `=` `+` `-` `@`), a `p_gateways` filter on `claim_affiliate_payout()` so the
  Stripe cycle claims only the gateways Stripe pays, the manual payout lifecycle
  (`claim_manual_affiliate_payout()` reserves the commissions before any money is sent,
  `record_manual_affiliate_payout()` completes that exact payout, `cancel_manual_affiliate_payout()`
  hands it back; locked and service-role only), and refund-after-payout advice that follows the
  payout's method and status (see "Paying partners manually"). Its section 7 seeds the partner
  portal and terms copy of the partner side.

And one on 2026-11-13:

- **`02040_home_partner_section_after_ecosystem.sql`** moves the home-page partner section (EN
  `home`, FR `accueil`) one section down, below "More Than a CMS. An Ecosystem." (the light section
  that also holds "Join Our Community."), so it no longer sits back to back with the Cortex AI
  section's identical dark layout and leads into the FAQ instead. It swaps the order
  of the partner and Ecosystem sections only on the layout 02034 left (found by content signature),
  makes the same swap in the page's Live Draft rows, and leaves a rearranged home page alone with a
  NOTICE.

**Roles are compared as text in SQL.** The sandbox reset replays every migration in one
transaction, where the `RTL` label is never committed before 02030 runs. Policies use
`(SELECT public.get_current_user_role())::text = 'RTL'`, functions `role::text = 'RTL'`, and
`'RTL'` is assigned only inside a plpgsql body (`create_affiliate_account()`). The migration lint
(`findEnumRtlLiterals` in `tools/scripts/lib/migration-grants.js`) refuses
`'RTL'::public.user_role` (any quoting, `CAST('RTL' AS user_role)`, array literals) outside a
plpgsql function body in every forward migration of generation 02 and later.

### Enums

| Type | Values |
| :-- | :-- |
| `affiliate_onboarding_step` | `SIGNED_UP`, `PROFILE_COMPLETED`, `PAYOUT_CONFIGURED`, `PAGE_SUBMITTED`, `ACTIVE_PUBLISHED` |
| `affiliate_status` | `ACTIVE`, `SUSPENDED` |
| `affiliate_page_status` | `DRAFT`, `PENDING_REVIEW`, `PUBLISHED`, `CHANGES_REQUESTED` |
| `affiliate_gateway` | `STRIPE`, `FREEMIUS` |
| `affiliate_commission_status` | `PENDING_CLEARANCE`, `CLEARED`, `PAID`, `VOIDED_REFUND` |
| `affiliate_payout_status` | `PROCESSING`, `COMPLETED`, `FAILED` |

### Tables

**`affiliate_tiers`**: the commission ladder. `name` (1–80 characters) plus `name_translations`
(`{"fr": "…"}`), unique `slug`, `commission_percentage` (0–100), `cookie_duration_days` (1–365,
default 30: the referral cookie and storefront-token window), `clearance_hold_days` (0–365,
default 30: the refund-protection hold), `is_default_signup_tier`, `is_limited_time_promo`,
`max_ambassadors_cap` (NULL = unlimited), `member_count` (kept by a trigger), `sort_order`,
`badge_color` (violet, indigo, blue, sky, emerald, amber, orange, rose, slate), `is_active`.

`goal` (1–160 characters, NULL = no goal line) plus `goal_translations` were added by 02033.
They hold what a partner aims for to reach the tier, shown on `/partners` under each tier.

- **Display only.** No SQL reads them and nothing promotes a partner when a goal is met. An admin
  moves partners by hand (Overview → change tier), and the page says only confirmed sales count.
- **Seeded wording.** 02033 seeds the four launch tiers below, only where `goal IS NULL`.

The table is granted at the table level, which covers the new columns: no grant changed.

Seeded once (`ON CONFLICT (slug) DO NOTHING`), with the 02033 goals:

| Tier | Slug | Rate | Sort | Default | Promo | Cap | French |
| :-- | :-- | --: | --: | :-- | :-- | --: | :-- |
| Starter Partner | `starter-partner` | 10 % | 1 | no | no | – | Partenaire Départ |
| Growth Partner | `growth-partner` | 20 % | 2 | no | no | – | Partenaire Croissance |
| Elite Partner | `elite-partner` | 35 % | 3 | no | no | – | Partenaire Élite |
| Founding Ambassador | `founding-ambassador` | 50 % | 4 | yes | yes | 50 | Ambassadeur fondateur |

| Tier | Goal (EN) | Goal (FR) |
| :-- | :-- | :-- |
| Starter Partner | Simply sign up! | Inscrivez-vous, tout simplement! |
| Growth Partner | Make 8 confirmed sales, then contact us for a meeting to grow. | Réalisez 8 ventes confirmées, puis contactez-nous pour une rencontre de croissance. |
| Elite Partner | Make 30 confirmed sales and get a call from our CEO. | Réalisez 30 ventes confirmées et recevez un appel de notre PDG. |
| Founding Ambassador | Join while the founding spots last. | Inscrivez-vous tant qu'il reste des places fondatrices. |

A signup takes the first active tier with room, default tiers first (highest `sort_order` first
among them), then the others by `sort_order`. With the seed: the first 50 partners are Founding
Ambassadors, then signups land in Starter Partner. The launch-offer tier must carry the highest
`sort_order` among the default tiers: a default tier ranked above it takes every signup, and the
partners page then drops the offer (`selectAffiliatePromoTier` features the promo only while it
is the signup tier).

**`affiliate_profiles`**: one per partner account (`user_id` unique, cascades from `auth.users`).
`tier_id` (ON DELETE RESTRICT), unique `handle` (`^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$`, so
3–32 characters), `display_name` (1–80), `bio` (≤ 2000), `avatar_object_key` (a storage key the
upload route sets: `affiliates/avatars/…` or `images/…`, no `..` or `//`; never a URL),
`social_links` (jsonb, ≤ 4000 bytes), `preferred_locale`, `onboarding_step` (derived), `status`
and `suspended_reason`, the `stripe_connect_*` columns (unique `acct_…` id, key mode, onboarding,
details, payouts, last check), `total_clicks` / `last_click_at`, `total_earned_cents` /
`total_paid_cents` (base currency, minor units), the lifecycle timestamps
`profile_completed_at`, `payout_configured_at`, `page_submitted_at`, `first_published_at`, and
`signup_ip_masked` (the /24 or /48 network, stored as `203.0.113.0/24` or `2001:db8:85a3::/48`,
never the full address). `tier_changed_at` (02035) is stamped by the profile guard whenever
`tier_id` changes, by any writer; NULL means the partner is still in their sign-up tier (since
`created_at`). The CMS and the portal show it as "Tier since".
`payout_email` (02036, NULL = none) is where the operator sends a manual payment: at most 254
characters with one `@` and no whitespace (a CHECK; the app normalizes with
`normalizeAffiliatePayoutEmail`, `libs/affiliates` `core/payout-methods.ts`: the HTML email grammar,
lower-cased). The owner (and an MFA ADMIN session) reads it through the table's SELECT grant and
RLS, like every other column. No API role can write it (no column grant): the partner portal
writes it with the service role after `requireRetailer()` (`saveRetailerPayoutEmail`, the payout
email form of the payouts page; see "Payouts page"), and the profile guard also refuses a
non-admin session changing it. `payout_email_kind` (02037, `paypal` by default, or `interac`) says
what the address is for; the same action writes it the same way, with the partner's choice, and
stamps `payout_email_saved_at` (02037) on every save, the same address included: a PayPal payout
returned from an address keeps the run off it until a save after that return.

**`affiliate_pages`**: exactly one storefront per partner (unique `affiliate_id`, unique
`user_id`, and a composite foreign key `(affiliate_id, user_id)` → `affiliate_profiles (id,
user_id)`). The draft: `title` (≤ 120), `meta_description` (≤ 300), `draft_content` (Tiptap
JSON, ≤ 256 KiB as Postgres prints it, `octet_length(draft_content::text)`, where jsonb text puts
a space after every `:` and `,`; **untrusted**), `featured_product_ids` (≤ 24). The approved
snapshot: `published_content` (the same limit), `published_title`, `published_meta_description`,
`published_profile` (`{display_name, bio, avatar_object_key, social_links, locale}`), and
`published_featured_product_ids`. The snapshot's `locale` (`en` | `fr`) is the partner's
`preferred_locale` at approval (`buildAffiliatePublishedProfile`, `review.ts`). It is app-built
JSONB with no schema change: a snapshot approved without it renders as before.
Review state: `approval_status`, `admin_feedback_note`, `draft_version`, `draft_updated_at`,
`submitted_at`, `submitted_version`, `reviewed_at`, `reviewed_by`, `published_at`.

**`affiliate_commissions`**: the ledger, one row per `(order_id, gateway)`. `order_currency`,
`order_net_amount_minor` and `exchange_rate_snapshot` record the order side;
`net_order_amount_cents`, `commission_rate_snapshot`, `commission_amount_cents`,
`refunded_amount_cents` (monotonic, ≤ the commission) and `currency` are in the store base
currency. `refund_pending_cents` and `void_requested_at` record a refund that arrived while the
money was paid or in flight. `livemode` is the mode the sale was paid in (copied from
`orders.affiliate_livemode`, true when unknown), and `disputed_at` marks a commission an open
payment dispute holds. Then `status`, `clears_at`, `cleared_at`, `paid_at`, `voided_at`,
`void_reason` (`refunded`, `cancelled`, `order_deleted`, `refunded_before_commission`),
`payout_id`, `stripe_transfer_id`, `notified_at`. `order_id` goes NULL when the order is deleted.
`commission_rate_snapshot` is the rate stored on the order when it was paid (02035; the partner's
tier rate at recording for an order paid before 02035), and `clears_at` is the order's `paid_at`
plus the hold stored with it.

**`affiliate_payouts`**: one Stripe transfer attempt chain. `amount_cents` (> 0), `currency`,
`stripe_destination_account` (snapshot, refreshed on retry), `livemode` (the key mode of the
destination account at claim), `stripe_transfer_id` (unique, NULL until completed), `status`,
`attempt_count`, `last_attempt_at`, `failure_reason` (a Stripe error code, `stale`,
`nothing_to_pay`, `below_minimum`, `released`, or `failed`), `trigger` (`cron`, `admin`, `auto`),
`paid_at`.
02036 adds the method: `method` (`stripe_connect`, the default every older row takes, or
`manual`), and for a manual payment `manual_channel` (`paypal`, `interac`, `wise`,
`bank_transfer`, `other`; required when manual), `external_reference` (≤ 120, the PayPal
transaction id, e-Transfer or bank reference), `note` (≤ 500, shown to the partner) and
`recorded_by` (the ADMIN who recorded it, → `auth.users`, ON DELETE SET NULL).
`stripe_destination_account` is nullable since 02036; CHECKs keep it required for
`stripe_connect` and keep a manual row `COMPLETED` (it records money already sent, so it never
enters the PROCESSING / FAILED chain). A unique index on `(affiliate_id, lower(external_reference))`
for manual rows refuses the same reference twice for one partner.

**`affiliate_click_events`** (service role only): `affiliate_id`, `visitor_hash`, `created_at`;
pruned after 30 days. **`affiliate_payout_runs`** (service role only): one row per UTC day
(`run_date`), `trigger`, `started_at`, `finished_at`, `summary`.

**`orders`** gains `affiliate_id` (→ `affiliate_profiles`, ON DELETE SET NULL),
`affiliate_source` (`storefront` or `referral_link`), `affiliate_base_currency` (the store
default at checkout) and `affiliate_livemode` (false for a Stripe test key or the Freemius
sandbox, true for live, NULL when unknown and treated as live), all written with the attribution
at checkout. `affiliate_refunded_minor` and `affiliate_refund_total_minor` hold the largest
cumulative partial refund seen before the order had a commission, and the charge it was measured
against. `apply_affiliate_refund` writes them together (CHECKed ≥ 0 and > 0, both set or both
NULL). `affiliate_commission_rate` (0–100) and `affiliate_clearance_hold_days` (0–365), added by
02035, are the partner's tier rate and hold copied onto an attributed order the moment it is paid
(the `affiliate_snapshot_order_rate` trigger); NULL on an unattributed order and on one paid
before 02035. `affiliate_disputed_at` (02035) marks an open payment dispute on an attributed
order that has no commission yet; the commission recorded later copies it into `disputed_at`, and
a dispute closed without a loss clears both. Partial indexes cover `affiliate_id` and
`payment_intent_id`.
**`system_alerts.alert_type`** also allows `affiliate_signed_up`, `affiliate_profile_completed`,
`affiliate_payout_configured`, `affiliate_page_submitted`, `affiliate_payout_failed` and
`affiliate_refund_after_payout`.

### Triggers

| Trigger | On | Does |
| :-- | :-- | :-- |
| `affiliate_profile_guard` | profiles, BEFORE INSERT OR UPDATE | A session (`auth.uid()` set) that is not `is_admin_mfa()` may change only `display_name`, `bio`, `social_links`, `preferred_locale` (and the click counters): anything else, `tier_changed_at` (02035) and `payout_email` (02036) included, raises `affiliate_profile_field_protected` (42501). While the partner's page is `PENDING_REVIEW`, the same session changing `display_name`, `bio` or `social_links` raises `affiliate_profile_pending_review` (55000, hint "Withdraw the submission before editing the public profile."). Server writes without a session (portal actions, the upload route, the sandbox) are not locked here; the app's Approve pins the profile the reviewer saw. Then, for every writer: a `tier_id` change sets `tier_changed_at = now()` (02035), the handle is lower-cased and `onboarding_step` derived from the lifecycle timestamps. |
| `affiliate_tier_member_count` | profiles, AFTER INSERT / DELETE / UPDATE OF tier_id | Keeps `affiliate_tiers.member_count` (never below 0) |
| `affiliate_page_guard` | pages, BEFORE UPDATE | (1) a non-admin session changing anything but the four draft columns (`title`, `meta_description`, `draft_content`, `featured_product_ids`) raises `affiliate_page_field_protected` (42501); (2) any draft edit while `PENDING_REVIEW` raises `affiliate_page_pending_review` (55000) for every writer, the service role included; (3) a draft edit bumps `draft_version` and `draft_updated_at` and sends `PUBLISHED` / `CHANGES_REQUESTED` back to `DRAFT` unless the statement set the status itself |
| `affiliate_snapshot_order_rate` (02035) | orders, BEFORE INSERT OR UPDATE OF paid_at, when the order is attributed and paid | `paid_at` NULL → set (or an order inserted already paid) copies the partner's tier `commission_percentage` and `clearance_hold_days` onto `affiliate_commission_rate` / `affiliate_clearance_hold_days`, unless the statement wrote them. Takes the profile row lock after the order's, like the recorder; never checks the partner's status (a paused partner's order keeps the rate of its payment); errors only raise a WARNING. A BEFORE trigger, so it always runs before the AFTER trigger below records the commission. |
| `affiliate_on_order_change` | orders, AFTER UPDATE OF paid_at, status | `paid_at` NULL → set records the commission (errors only raise a WARNING: recording never fails an order update); status → `refunded` / `cancelled` voids (errors propagate) |
| `affiliate_on_order_delete` | orders, BEFORE DELETE | Voids the order's live commissions (`order_deleted`) |

Never write `onboarding_step` or `member_count`; the triggers derive them.

### Functions

Anonymous reads (a `SECURITY DEFINER` function in `private` behind a `SECURITY INVOKER`
wrapper in `public`, the 02021 pattern; EXECUTE for `anon`, `authenticated`, `service_role`):

| RPC | Returns |
| :-- | :-- |
| `get_affiliate_storefront(p_handle)` | 0 or 1 row: the approved snapshot of an ACTIVE, approved partner, with the tier name, translations, badge and promo flag. `updated_at` is the last approval, so a draft autosave never moves a public `lastmod`. |
| `list_affiliate_storefronts(p_limit = 5000)` | Handles and dates of every live storefront (the sitemap) |
| `get_affiliate_referral_window(p_handle)` | The tier's `cookie_duration_days` for an ACTIVE, approved partner, else NULL |
| `record_affiliate_click(p_handle, p_visitor_hash)` | Counts one click per visitor hash per partner per 24 h; at most 60 events per hash per hour, 500 per partner per day, 2000 overall per minute; prunes up to 500 events older than 30 days. VOLATILE. |

Service-role RPCs (`SECURITY INVOKER` in `public`, revoked from `PUBLIC`, `anon` and
`authenticated` in 02030 (02035 for the tier move, 02036 for the manual payout lifecycle and the
claim's new signature) and again in both copies of `API_ROLE_REVOKE_SQL`):

| RPC | Does |
| :-- | :-- |
| `create_affiliate_account(...)` | Signup in one transaction: locks the `profiles` row (must be `USER` or `RTL`), picks the tier under a row lock, inserts the profile and the page with the starter document, promotes `USER` → `RTL`. Errors: `affiliate_role_conflict`, `affiliate_exists`, `affiliate_handle_invalid`, `affiliate_program_full` (P0001); a taken handle is 23505. |
| `promote_cleared_affiliate_commissions()` | `PENDING_CLEARANCE` past `clears_at` → `CLEARED` (skips a commission an open dispute holds; voids those whose order is refunded or cancelled) |
| `claim_affiliate_payout(affiliate, currency, min, trigger, gateways = NULL)` | Locks the partner and its `CLEARED` unattached commissions of the partner's Connect account mode (`livemode = stripe_connect_livemode`) that no open dispute holds; nothing when the account's mode is unknown; creates a `PROCESSING` payout (with that `livemode`) of sum(commission − refunded) when it reaches the minimum. `gateways` (02036, `affiliate_gateway[]`) limits every step to those gateways' commissions; NULL keeps every gateway. 02036 dropped the four-argument signature and created this one (a new parameter is a new function), so the four-argument revoke in `API_ROLE_REVOKE_SQL` stays, guarded, for databases not yet at 02036. |
| `claim_manual_affiliate_payout(affiliate, currency, min = 0, gateways = NULL)` (02036) | Prepares a manual payout BEFORE any money is sent. Checks the currency (`invalid_input`), locks the profile (`not_found`; `not_eligible` unless ACTIVE and published once), refuses a second prepared payout of that partner and currency (`already_prepared`, with its `payout_id` and `amount_cents`; read under the lock, a unique partial index behind it), locks the `CLEARED` unattached live-mode (`livemode = true`) commissions of that currency and those gateways that no open dispute holds, voids those of refunded or cancelled orders first, then answers `nothing_owed`, `below_minimum` (sum under `min`, nothing reserved) or `prepared`: one `PROCESSING` manual payout (`trigger = 'admin'`, no Stripe field, no channel or reference yet) with those commissions attached, still `CLEARED`. |
| `record_manual_affiliate_payout(payout, channel, reference, note, recorded_by)` (02036) | Records that the money of a prepared manual payout left. Checks the channel and lengths (`invalid_input`) and the reference (`reference_required`), finds the manual payout (`not_found`), locks the profile, its commissions and the payout (`complete_affiliate_payout`'s order), refuses one already `COMPLETED` (`already_recorded`) and a reference another manual payout of this partner has (`duplicate_reference`, case-insensitive, under the lock and by the unique index), then: `COMPLETED` with the channel, reference, note, `recorded_by` and `paid_at`, its commissions `PAID`, `total_paid_cents` grown by its amount (`recorded`, with the payout and partner ids, amount, currency and count). No amount or eligibility check: the amount was fixed when it was prepared and the money left. |
| `cancel_manual_affiliate_payout(payout)` (02036) | Gives up a prepared manual payout that was never sent: `not_found` unless it is a manual payout, `already_recorded` once `COMPLETED`; otherwise, under the same locks, the work its commissions owe (a refund flagged while it was prepared voids or reduces its commission, A8) is applied, the rest are detached (back in the cleared balance) and the row is deleted (`cancelled`, with the count handed back). |
| `complete_affiliate_payout(payout, transfer)` | `PROCESSING` (or `FAILED`, unless released, emptied or handed back below the minimum) → `COMPLETED`; commissions → `PAID`; `total_paid_cents` grows. Never a manual payout: it writes a transfer id, which a manual row's CHECK refuses (02036). |
| `fail_affiliate_payout(payout, reason)` | `PROCESSING` → `FAILED`, after applying pending refunds and voids. Never a manual payout (a manual row is never `FAILED`, 02036), nor a PayPal payout (a FAILED PayPal row needs a `paypal_` reason, 02037: it raises). |
| `prepare_affiliate_payout_retry(payout, min = 0)` | `FAILED` → `PROCESSING` (attempt + 1, destination refreshed) after re-checking eligibility and the key mode (no row and no change when the account's mode differs from the payout's `livemode`); commissions an open dispute holds are detached; nothing left → stays `FAILED` with `nothing_to_pay`; less than `min` left → stays `FAILED` with `below_minimum` (attempt unchanged); either way every commission is detached (back in the cleared balance). On a PayPal payout both branches raise (02037: a destination, or a reason that is not `paypal_`) |
| `release_affiliate_payout(payout)` | `FAILED` given up: commissions detached (claimable again), `failure_reason = 'released'`. Raises on a PayPal payout (02037), whose `paypal_` reason keeps the run off an address PayPal returned a payout from |
| `claim_affiliate_payout_run(date, trigger)`, `finish_affiliate_payout_run(date, summary)` | One payout run per UTC day |
| `claim_affiliate_commission_notifications(limit)` | Atomically claims up to 200 commissions still owed a "you earned" email (`SKIP LOCKED`; skips voided rows and tombstones) |
| `apply_affiliate_refund(gateway, order, refunded, total, full)` | Refund handling, returns `voided`, `adjusted`, `alerted` or `none` (see "Refunds and disputes") |
| `set_affiliate_commission_dispute(gateway, order, open)` | Dispute hold: `open` sets `disputed_at` on the order's `PENDING_CLEARANCE` / `CLEARED` commission (`held`; also one already in a `PROCESSING` payout, whose transfer is not stopped); an attributed order with no commission yet keeps the dispute itself (`orders.affiliate_disputed_at`, `held`, since 02035), and the commission recorded later starts held; closing without a loss clears the hold whatever the status, the order's included (`released`); `none` otherwise. A lost dispute is a full refund through `apply_affiliate_refund`. Takes the order row lock first, like `apply_affiliate_refund`. |
| `reconcile_affiliate_commissions(limit = 200)` | Records the commission of a paid, attributed order the trigger missed (last 120 days; a partial refund kept on the order is taken off; at the rate and hold stored on the order when it was paid, and held by a dispute kept on the order, since 02035) and voids live commissions of refunded or cancelled orders; returns `{recorded, voided}` |
| `change_affiliate_partner_tier(affiliate, tier, allow_over_cap = false)` (02035) | The CMS tier move: locks the profile, then both tier rows in the order `create_affiliate_account()` locks tiers, re-checks under those locks and answers `not_found`, `unchanged`, `tier_not_found`, `tier_inactive`, `tier_full` (a capped tier at its cap, unless `allow_over_cap`) or `moved` (only `tier_id` written; the triggers move `member_count` and stamp `tier_changed_at`). Never checks the partner's status: a paused partner can be moved. |

Private helpers (service role only): `affiliate_record_commission`, `affiliate_void_order_commissions`
(and its `void`-returning wrapper `affiliate_void_commission_for_order`),
`affiliate_alert_refund_after_payout`, `affiliate_apply_pending_payout_work`,
`affiliate_refund_share` (the refund share rule, see "The ledger side"),
`affiliate_currency_factor` (1 for BIF CLP DJF GNF JPY KMF KRW MGA PYG RWF UGX VND VUV XAF XOF
XPF, else 100; mirrors `getCurrencyMinorUnitFactor`), `affiliate_normalize_email`, and the
orders trigger function `affiliate_snapshot_order_rate` (02035). Since 02036
`affiliate_alert_refund_after_payout` reads the payout's `method` and status: after a recorded
manual payout its advice is to recover the amount from the partner ("for example by asking them to
send it back": nothing deducts it from a later payout, which would only record an amount that was
never sent); while the manual payout is only prepared, to cancel it and prepare it again if the
money has not left, or to record it and recover the amount if it has; otherwise to reverse the
Stripe transfer. The alert's metadata carries `payout_method` and `payout_status`.

Every money function takes its locks in one order: the order row when it needs one
(`apply_affiliate_refund` and, since 02035, `set_affiliate_commission_dispute` take it first, as
the orders triggers already hold it), then the
partner profile row, then its commission rows, then the payout row in a separate statement. None
aggregates under `FOR UPDATE`. The tier move locks the profile row, then the two tier rows (in
the sign-up order, so it never deadlocks with a concurrent sign-up); the rate trigger takes the
profile after the order row, so a payment and a tier move serialize: the order gets the old rate
or the new one, never a mix. The manual payout functions (02036) keep the claim's order: the
profile row, then the commission rows (the void loop re-locks rows it already holds), then the
payout. Two admins preparing the same partner at once serialize on the profile row and the second
one gets `already_prepared`; two recording the same prepared payout serialize the same way and
the second one gets `already_recorded`. A commission is attached to one payout at a time, so it is
never prepared, recorded or claimed by Stripe twice.

### RLS and grants

| Table | `anon` | `authenticated` policies | `authenticated` grants |
| :-- | :-- | :-- | :-- |
| `affiliate_tiers` | SELECT active tiers | SELECT active (all for ADMIN); INSERT / UPDATE / DELETE for ADMIN | SELECT, INSERT, UPDATE, DELETE |
| `affiliate_profiles` | nothing | SELECT own row or ADMIN; UPDATE own row while RTL and ACTIVE, or ADMIN; the profile guard refuses name, bio and link edits while the page is `PENDING_REVIEW` | SELECT; UPDATE (`display_name`, `bio`, `social_links`, `preferred_locale`) |
| `affiliate_pages` | nothing | SELECT own page or ADMIN; UPDATE own page while RTL, profile ACTIVE and not `PENDING_REVIEW`, or ADMIN | SELECT; UPDATE (`title`, `meta_description`, `draft_content`, `featured_product_ids`) |
| `affiliate_commissions`, `affiliate_payouts` | nothing | SELECT own (through the profile) or ADMIN | SELECT |
| `affiliate_click_events`, `affiliate_payout_runs` | nothing | none (RLS on, no API policy) | none |

Every ADMIN branch is `(SELECT public.is_admin_mfa()) IS TRUE`, every policy names its role,
and there is one permissive policy per role and command. Nobody INSERTs or DELETEs a profile or
page over the API (accounts come only from `create_affiliate_account()`; deleting one would erase
the ledger), and the ledger has no write policy at all.

These policies and column grants are defense in depth. The app writes through server actions on
the service role after `requireRetailer()` or `requireCmsAdmin()`, where RLS is not a boundary.
Every reader therefore treats `draft_content` as untrusted: an RTL can PATCH it over the Data API.

`API_ROLE_REVOKE_SQL` (byte-identical in `apps/nextblock/tools/lib/migrate-core.mjs` and
`apps/nextblock/lib/setup/schema-apply.ts`) re-applies all of this after the post-apply grant
pass on every deploy: SELECT revoked from `anon` on profiles, pages, commissions and payouts;
INSERT / UPDATE / DELETE revoked from `authenticated` on those four, with the two column UPDATE
grants given back; everything revoked on the click log and the payout runs; EXECUTE revoked on
each service-role RPC by exact signature, `change_affiliate_partner_tier(uuid, uuid, boolean)`
(02035) included. `tier_changed_at` is not among the self-service columns, so no API role can
write it. `tools/scripts/security-verify.sql` sections 35–38, with 37b (72 assertions), check
grants, column pins, function privileges, the seats, the ledger, payouts, key modes, the retry
minimum, refund shares, dispute holds, repairs and deletes on a local replay; section 39 (02035,
12 assertions) checks the tier move's privileges and every outcome, the rate trigger's shape and
privileges, the `tier_changed_at` pin, that a commission recorded after a move and a rate edit
keeps the rate of its payment with its hold counted from the payment, and that a dispute opened
before such a late commission existed holds it (not promoted past its hold) until it is won.

02036 adds four guarded entries at the end of the list: EXECUTE revoked from `public`, `anon` and
`authenticated` on the five-argument `claim_affiliate_payout(uuid, text, bigint, text,
public.affiliate_gateway[])` and on the manual payout lifecycle,
`claim_manual_affiliate_payout(uuid, text, bigint, public.affiliate_gateway[])`,
`record_manual_affiliate_payout(uuid, text, text, text, uuid)` and
`cancel_manual_affiliate_payout(uuid)`, each inside `to_regprocedure(...) is not null`. The
four-argument claim's entry stays (guarded the same way): the migration lint
(`findRevokesUndoneByGrantPass`) holds 02030's revoke of it to the pass, and a database still before
02036 has it. `payout_email` gets no grant at all, so there is nothing to revoke for it.
`migrate-core.test.mjs` checks the four entries, their guards and their order. Section 40 of
`tools/scripts/security-verify.sql` (02036, 13 assertions) checks that the four RPCs are
service-role only (one claim overload left, no record overload of the first 02036 draft), the payout
row CHECKs (a manual row is never `FAILED`, never carries a Stripe destination, names its channel
and reference once `COMPLETED`; one prepared per partner and currency; a Stripe row keeps its
destination), that `payout_email` is server-written (no write grant; the partner's own session,
another partner and `anon` cannot write it; the server can, and its CHECK refuses a malformed
address and a leading `=` `+` `-` `@`), that no API role writes a payout row while the partner
reads its own manual payout with its note, every refusal of the claim (unknown, paused or
unapproved partner, bad currency, below the minimum), the claim's exact scope (never a test-mode,
disputed or Stripe-routed commission; a second claim answers `already_prepared`), the in-flight
rules while a payout is prepared (a commission cleared later stays out; a full refund is flagged
and alerted with the prepared advice; a won dispute keeps the commission in the payout), every
refusal of the record (unknown channel, empty reference, unknown or Stripe payout), the record of
exactly the prepared payout (even for a partner paused since) with `total_paid_cents` up and a
second record refused, a reused reference refused and the cancel (pending refund applied,
commission handed back, row deleted, a recorded payout refused), that `complete_`, `fail_`,
`prepare_affiliate_payout_retry` and `release_affiliate_payout` never change a manual payout,
that the claim with `p_gateways => '{STRIPE}'` never takes a Freemius commission while the
four-argument call still takes every gateway, and the recovery advice of the refund alert after a
recorded manual payout. Section 35 now pins the five-argument claim signature. After 02036 the
script prints 231 PASS lines.

02037 (PayPal Payouts) adds six guarded entries after the manual ones: EXECUTE revoked from
`public`, `anon` and `authenticated` on `claim_paypal_affiliate_payout(uuid, text, bigint,
public.affiliate_gateway[], boolean, text)`, `record_paypal_affiliate_payout_batch(uuid[], text,
text)`, `note_paypal_affiliate_payout_item(uuid, text, text, bigint)`,
`complete_paypal_affiliate_payout(uuid, text, text, bigint, text)`,
`fail_paypal_affiliate_payout(uuid, text, text)` and `release_paypal_affiliate_payout(uuid)` (all
`SECURITY INVOKER`, `search_path ''`, granted to `service_role` only). The new
`affiliate_payouts.paypal_*` columns and `affiliate_profiles.payout_email_kind` /
`payout_email_saved_at` ride the tables' existing grants (no API write; the profile guard pins both),
and a RESTRICTIVE policy on `site_settings` keeps the `affiliates_paypal_secret` row away from `anon`
and `authenticated` (an aal2 ADMIN included). 02037 also replaces 02036's manual status CHECK by name
(it kept every non-Stripe payout PROCESSING or COMPLETED, so a PayPal payout could never fail: it now
holds for `method = 'manual'` only) and adds `affiliate_payouts_paypal_failure_reason_check` (a FAILED
PayPal payout carries a `paypal_` reason, so the Stripe RPCs raise on a PayPal payout). Section 41 of
`security-verify.sql` (15 assertions) checks the RPCs' privileges, the PayPal CHECKs and indexes
(a PayPal payout can be FAILED with a `paypal_` reason only, a manual one still never), the
`payout_email_kind` and `payout_email_saved_at` pins, that the secret row is service-role only, that
no API role writes a PayPal column, every claim refusal and its exact scope, the batch ids and item
notes, the exactly-once completion (a duplicate transaction refused), the failure (refund applied,
the rest handed back, a reclaim), that `complete_affiliate_payout`, `fail_affiliate_payout`,
`release_affiliate_payout` and `prepare_affiliate_payout_retry` (both its branches, with a ready
Connect account and a commission attached) never touch a PayPal payout, the admin release (an hour
after the last send, which a resend stamps again; a week for an acknowledged batch; never while
PayPal holds the item), and the refund alerts (in flight and paid). After 02037 the script prints
246 PASS lines.

| RPC (02037, service role) | Returns |
| :-- | :-- |
| `claim_paypal_affiliate_payout(affiliate, currency, min, gateways, livemode, trigger)` | Locks the profile, then the commissions, and attaches the partner's cleared, unattached, undisputed commissions of the PayPal gateways and mode to one `PROCESSING` PayPal payout with `paypal_receiver` (the payout email, kind `paypal`): `claimed` (id, amount, count, receiver), or `invalid_input`, `not_found`, `not_eligible` (paused, unapproved), `no_paypal_email`, `already_in_flight`, `nothing_owed`, `below_minimum`. |
| `record_paypal_affiliate_payout_batch(payouts, sender_batch_id, batch_id)` | Saves the `sender_batch_id` (before the create call) and PayPal's batch id (after it) on in-flight PayPal payouts; never overwrites a different id. Every call without a batch id stamps the send (`last_attempt_at`; `attempt_count + 1` when the same sender id is saved again before a resend). `count` says how many payouts carry the ids now. |
| `note_paypal_affiliate_payout_item(payout, item, status, fee)` | Notes PayPal's item id, status and fee on an in-flight PayPal payout, with `paypal_checked_at`. |
| `complete_paypal_affiliate_payout(payout, item, transaction, fee, status)` | Completes exactly that payout once (commissions `PAID`, `total_paid_cents` up): `completed`, `already_completed`, `not_processing`, `item_mismatch`, `duplicate_transaction`, `not_found`, `invalid_input`. |
| `fail_paypal_affiliate_payout(payout, reason, status)` | Fails it (the reason prefixed `paypal_failed:` unless it starts with `paypal_`), applies the refund work flagged while it was in flight, hands the rest back (cleared, unattached): `failed`, `already_failed`, `already_completed`, `not_found`. |
| `release_paypal_affiliate_payout(payout)` | The CMS Release, under the claim's locks: a payout PayPal never acknowledged (no batch id) an hour after its last send, one it acknowledged a week after it unless PayPal lists SUCCESS, PENDING, ONHOLD or UNCLAIMED for its item; then as a failure (`paypal_released_by_admin`): `released` (with `acknowledged`), `too_recent`, `held_by_paypal`, `already_failed`, `already_completed`, `not_found`. |

### State machines

Storefront page (`approval_status`):

| From | Event | To |
| :-- | :-- | :-- |
| `DRAFT`, `CHANGES_REQUESTED` | the partner submits (a title and non-empty content) | `PENDING_REVIEW` |
| `PUBLISHED` | the partner submits, only when the profile (its language included) changed since approval | `PENDING_REVIEW` |
| `PENDING_REVIEW` | the partner withdraws | `DRAFT` |
| `PENDING_REVIEW` | an admin approves (at the reviewed `draft_version` and profile fingerprint) | `PUBLISHED` |
| `PENDING_REVIEW` | an admin requests changes (with a note) | `CHANGES_REQUESTED` |
| `PUBLISHED`, `CHANGES_REQUESTED` | any draft edit (the page guard) | `DRAFT` |

While `PENDING_REVIEW` nothing edits the draft (the page guard, for every writer), and no
partner session edits the name, bio or links (the profile guard; the avatar is server-only); the
portal refuses both too. Approve publishes exactly the profile snapshot the review screen showed: the
screen carries a fingerprint of it (`fingerprintAffiliatePublishedProfile`, the sha256 of the
snapshot's canonical JSON, so every field counts, `locale` included). A stale Approve after any
profile change (over the Data API, or a withdraw, profile edit, avatar upload and resubmit, none
of which moves `draft_version`) is refused with "The partner changed this storefront after you
opened it". `profiles.updated_at` is deliberately not the pin (every counted click bumps it).
Whatever was approved before stays live through every state (the avatar too: the upload route
never deletes the snapshot's avatar).

Commission (`status`):

| From | Event | To |
| :-- | :-- | :-- |
| – | an attributed order is first paid and the partner may earn | `PENDING_CLEARANCE` (`refunded_amount_cents` starts from a partial refund kept on the order) |
| – | the same, when the partial refund kept on the order already takes the whole commission | `VOIDED_REFUND` (`refunded`, earning nothing) |
| – | a full refund of an attributed order that has no commission yet | `VOIDED_REFUND` tombstone (all amounts 0, `refunded_before_commission`), so the paid trigger never records one later |
| `PENDING_CLEARANCE` | `clears_at` passed (`promote_cleared_affiliate_commissions`) | `CLEARED` |
| `CLEARED` | claimed by a payout of the sale's key mode | `CLEARED` with `payout_id` |
| `CLEARED` with `payout_id` | the payout completes | `PAID` |
| `CLEARED` (unattached, live mode, undisputed, of a gateway paid manually) | an admin prepares a manual payout (`claim_manual_affiliate_payout`, 02036) | `CLEARED` with `payout_id` (the prepared manual payout) |
| `CLEARED` with the `payout_id` of a prepared manual payout | the admin records it (`record_manual_affiliate_payout`) | `PAID` |
| `CLEARED` with the `payout_id` of a prepared manual payout | the admin cancels it (`cancel_manual_affiliate_payout`) | `CLEARED`, detached (a refund flagged meanwhile applied first: voided or reduced) |
| `PENDING_CLEARANCE`, `CLEARED` | a dispute opens | held (`disputed_at`): not promoted, claimed or re-sent by a retry (detached from a `FAILED` payout); released when the dispute is won or closed without a loss |
| – | an attributed order recorded after a dispute opened on it, before it had a commission (02035) | `PENDING_CLEARANCE` held from the start (`disputed_at` from `orders.affiliate_disputed_at`), whatever its `clears_at` |
| `PENDING_CLEARANCE`, `CLEARED` (unattached, or on a `FAILED` payout) | full refund, cancellation, order deleted | `VOIDED_REFUND` (detached) |
| `PENDING_CLEARANCE`, `CLEARED` | partial refund | unchanged; `refunded_amount_cents` rises (to the whole commission → `VOIDED_REFUND`) |
| `PAID`, or attached to a `PROCESSING` / `COMPLETED` payout | any refund | unchanged amounts; `void_requested_at` or `refund_pending_cents` set and an `affiliate_refund_after_payout` alert raised; applied if that payout fails (a pending refund that reached the whole commission voids it) |

Payout (`status`):

| From | Event | To |
| :-- | :-- | :-- |
| – | `claim_affiliate_payout` | `PROCESSING` |
| `PROCESSING` | the transfer is created and `complete_affiliate_payout` runs | `COMPLETED` |
| `PROCESSING` | a definitive Stripe refusal, or no transfer found after 15 minutes (`stale`) | `FAILED` |
| `FAILED` | Retry, or the automatic retry of `balance_insufficient` / `stale`, with a key of the payout's mode | `PROCESSING` (attempt + 1) |
| `FAILED` | a retry finds nothing left to pay | `FAILED` (`nothing_to_pay`, commissions detached) |
| `FAILED` | an automatic retry finds less than the minimum left | `FAILED` (`below_minimum`, commissions detached) |
| `FAILED` | Release | `FAILED` (`released`, commissions detached and claimable again) |
| `FAILED` (not released, emptied or below the minimum) | a reconcile finds the transfer after all | `COMPLETED` |
| – | `claim_manual_affiliate_payout` (02036, "Prepare payout") | `PROCESSING` (`method = 'manual'`, no Stripe field) |
| `PROCESSING` (manual) | `record_manual_affiliate_payout` ("Record payout", once the money left) | `COMPLETED` with channel, reference, note, `recorded_by` |
| `PROCESSING` (manual) | `cancel_manual_affiliate_payout` ("Cancel", never sent) | deleted, commissions detached |
| `PROCESSING` (manual) | the Stripe reconcile, retry or release | nothing: the cycle reads only Stripe payouts, the admin actions refuse it (`manual_payout`), and a manual row's CHECKs refuse `FAILED`, a destination and a transfer id |
| – | `claim_paypal_affiliate_payout` (02037, the PayPal step) | `PROCESSING` (`method = 'paypal'`, `paypal_receiver`) |
| `PROCESSING` (PayPal) | PayPal's item is SUCCESS: `complete_paypal_affiliate_payout` | `COMPLETED` with the transaction id and fee |
| `PROCESSING` (PayPal) | PayPal will not pay it, a definitive refusal of a first send, or the admin's Stop payment: `fail_paypal_affiliate_payout` | `FAILED` (`paypal_…`, commissions detached) |
| `PROCESSING` (PayPal) | Release (`release_paypal_affiliate_payout`: unacknowledged an hour after the last send, acknowledged a week after it and not held by PayPal) | `FAILED` (`paypal_released_by_admin`, commissions detached) |
| `PROCESSING` / `FAILED` (PayPal) | the Stripe reconcile, fail, retry or release | nothing: the cycle reads only Stripe payouts, the admin actions refuse it (`paypal_payout`), and the CHECKs refuse a destination, a transfer id and a FAILED PayPal row without a `paypal_` reason |

Onboarding (`onboarding_step`) is derived: `ACTIVE_PUBLISHED` once `first_published_at` is set,
else `PAGE_SUBMITTED`, `PAYOUT_CONFIGURED`, `PROFILE_COMPLETED`, `SIGNED_UP`.

## Attribution

### The referral cookie (`proxy.ts`)

The decision is a pure function in `lib/affiliates/referral-cookie.ts`, taken once per request
before the proxy's first response branch:

- Only a top-level **GET document navigation** counts (`Sec-Fetch-Dest: document`, or an
  `Accept` asking for HTML when the header is absent). RSC fetches, router prefetches,
  speculative loads (`Sec-Purpose`, `Purpose`, `X-Purpose`, `X-Moz` saying prefetch, prerender
  or preview) and bots (`userAgent(request).isBot`) never do.
- The handle comes from the path when it is exactly `/partners/<handle>` (optional trailing
  slash; never a sub-path such as the Open Graph image), else from `?ref=<handle>` on any path
  outside `/cms`, `/api`, `/portal` and `/_next`. It must match the handle pattern and not be
  reserved (`RESERVED_AFFILIATE_HANDLES`, `core/handle.ts`: route segments under `/partners` such
  as `apply`, `opengraph-image`, `sitemap` and `terms`, the French terms segment `conditions`, and
  names that would impersonate the store or its staff). So `/partners/terms` is never read as a
  storefront, and a `?ref=` on it still counts.
- A visitor whose consent cookie (`nb_consent_preference`) says `marketing: false` gets no
  referral, and an existing referral cookie expires on their next document navigation. Checkout
  applies the same rule to the storefront token and to a referral cookie that has not expired
  yet (see "Checkout resolution").
- A request that already carries a cookie for the same handle refreshes it but counts no click.

The cookie is `nb_affiliate_ref`: the lowercase handle and nothing else, httpOnly,
`SameSite=Lax`, `Secure` in production, path `/`, lifetime = the tier's `cookie_duration_days`.
The last click wins. The window comes from `get_affiliate_referral_window` on the proxy's
memoised plain anon client (no visitor JWT, 1.5 s abort), cached per handle: 5 minutes for a
window, 60 s for "no ACTIVE, approved partner" (NULL: no cookie), 15 s for a failed lookup,
which falls back to 30 days. At most 1000 handles are cached and 100 lookups run at once.

One helper (`withAffiliateReferral`) applies the cookie to exactly three responses: the final
page response, the managed 301/302 redirect and the customer-name redirect to `/profile`. Each
also gets `Cache-Control: private, no-store`, so a shared cache never stores one visitor's
`Set-Cookie`. A new cookie schedules `record_affiliate_click` in `after()` with a visitor hash:
the first 32 hex characters of SHA-256(`<UTC date>|<IP masked to /24 or /48>|<first 200
characters of the user agent>`). No raw IP is sent or stored. Nothing in this path throws.

`referral-cookie.ts` imports nothing: the proxy must not import server-only code,
`@nextblock-cms/db/server` or a library barrel. It mirrors the lib's handle pattern, reserved
list, cookie name and fallback window, and `referral-cookie.test.ts` fails when a copy drifts.

### The storefront token

A client-side navigation never sets the cookie, and cookies can be blocked, so the storefront
hands a signed token to the cart. Each render of `/partners/<handle>` mints one token
(`mintAffiliateStorefrontToken`): `v1.<handle>.<issuedAtSeconds>.<base64url HMAC-SHA256>`, keyed
by `HMAC(service key, 'nextblock:affiliate-storefront-token')`. The token carries a handle and a
time, never an affiliate id.

Product grids pass it to every card. The card's "Add to cart" stores it on the cart
(`affiliateRef`) when the add succeeds. The card's title, image and "Select options" links (a
product with variants has no add button in the grid) call `rememberStorefrontAffiliateRef()` on
click: the token waits in memory (`pendingAffiliateRef`, never persisted) and the next successful
add, normally the one on the product page, makes it the cart's `affiliateRef`. A failed add
leaves it pending; a click with no add stores nothing. A grid add with its own token still sets
it after the add, so the last storefront wins. Product links also keep `?ref=<handle>`, for
reloads and shared links (a document navigation, so the proxy sets the referral cookie), and so
do the site-internal links in the partner's own text: `StorefrontRenderer` adds `ref=<handle>`
to every relative or same-origin link when the public page passes `referralHandle` (never in the
portal preview or the review screen, never to `mailto:` or a link that already names a ref).

The page mints no token at all for a visitor whose consent cookie says `marketing: false`, so
the cart never stores one without consent; checkout also ignores a token stored earlier while
the decline lasts (below).

`affiliateRef` is persisted with the cart and dropped whenever the cart empties: `removeItem`,
`updateQuantity(…, 0)`, `setItems([])` and `clearCart` all end it, so the paid checkout whose
success page removes the last line ends it too. While lines remain (the second provider step of
a mixed Stripe and Freemius cart) the token stays, so it lives exactly as long as the cart it
was carried for. `Checkout.tsx` sends `affiliateRef` to `/api/checkout`. The server verifies it
with `timingSafeEqual` (strict format, at most 160 characters, 5 minutes of clock skew, at most
365 days old). Rotating the service key invalidates outstanding tokens; the cookie still works.

### Checkout resolution

`resolveAttributionForCheckout()` (`lib/affiliates/attribution.ts`, package-gated) first reads
the request's cookies once: the referral cookie (at most 64 characters) and the consent record
(`nb_consent_preference`). A visitor whose record says `marketing: false` is not attributed at
all: checkout ignores the storefront token and any referral cookie the proxy has not expired yet
(the proxy expires it only on the next document navigation, and `/checkout` is usually reached by
a client-side one). It uses the proxy's own parser (`hasDeclinedAffiliateMarketingConsent`), so
the decoded and percent-encoded spellings both count. No consent cookie, an unreadable one, a
record without a marketing answer or an unreadable cookie store keeps attributing (fail open,
like the proxy). Otherwise it verifies the token and hands both to the lib's
`resolveCheckoutAttribution()`, which decides against the database:

1. A verified token (from a storefront add made since the cart last emptied) wins when its
   partner is ACTIVE and approved and `issuedAt` is within the tier's `cookie_duration_days`:
   `affiliate_source = 'storefront'`.
2. Otherwise the cookie's partner, when ACTIVE and approved: `referral_link`.
3. A self-referral attributes nothing, with no fallback to the other candidate.

Checkout never reads an affiliate id from the request body, and nothing here ever blocks a
checkout: any error leaves the order unattributed. Both providers add `affiliate_id`,
`affiliate_source`, `affiliate_base_currency` and `affiliate_livemode` to the pending order only
when an attribution was resolved, and retry the insert without them on PGRST204 / 42703 (an
install without 02030, or a local database that applied an older 02030 and must be replayed) or a
23503 / 23514 naming an affiliate column. The mode comes from the payment setup: Stripe reads the
prefix of the secret key that creates the session (`resolveStripeKeyLivemode()` /
`stripeSecretKeyLivemode()` in `libs/ecommerce/src/lib/stripe/client.ts`: `sk_live_` / `rk_live_`
true, `sk_test_` / `rk_test_` false, anything else NULL, recorded as live); Freemius records
`!FREEMIUS_SANDBOX_ENABLED`, read once after `hydrateFreemiusEnvFromDb()` and used for both the
order and the checkout URL. Stripe sessions add `metadata.affiliateId` when the stored order
carries it, and always `payment_intent_data.metadata.orderId`.

### Who earns

- **Approved partners only.** A partner is approved once `first_published_at` is set (the first
  storefront approval). Until then there is no referral cookie, no counted click, no commission
  and no payout.
- **ACTIVE partners only.** A suspension ("Pause partner" in the CMS) stops new commissions and
  payout claims; recorded commissions stay in the ledger and keep clearing. While a partner is
  paused, checkout attributes nothing to them, so an order placed then never earns, even after a
  resume. An order attributed before the pause and paid during it gets no commission at payment
  (the paid trigger requires an ACTIVE partner); once the partner is resumed,
  `reconcile_affiliate_commissions` (the first step of every payout cycle: attributed paid or
  shipped orders of the last 120 days without a commission) records it, at the rate and hold the
  order stored when it was paid (02035), whatever tier the partner is in by then. So the pause dialog says
  "Orders placed before the pause and paid during it are credited at the first payout run after
  you resume (orders up to 120 days old)", and the PARTNER_REACTIVATED email says the same; both
  hold while payout runs happen: the daily run (the first CMS or portal visit of the UTC day, or the
  cron route) records them whether automatic Stripe transfers are on or off (02036), and so does
  Run payouts now.
- **No self-referral:** not when the buyer is the partner's own account, nor when the buyer's
  email matches the partner's sign-in email after normalization (`normalizeAffiliateEmail` /
  `private.affiliate_normalize_email`: trimmed and lower-cased, split at the last `@`, a `+tag`
  dropped, and for gmail.com / googlemail.com every dot dropped and the domain read as
  gmail.com). Checkout applies the rule, and the paid trigger applies it again.
- **First payment only.** One commission per order, recorded when the order is first paid
  (`paid_at` goes from NULL to a value, which `assign_order_invoice_metadata()` does once under a
  row lock for every "mark paid" path). Renewals and later subscription payments never earn; a
  trial earns when its order becomes paid. The portal FAQ and the `/partners` FAQ say so.

### The amount

Commissions are recorded and paid in the **store base currency**
(`COALESCE(orders.affiliate_base_currency, the current default currency, the order currency)`).
The base is the order's net amount without tax or shipping:
`GREATEST(COALESCE(subtotal, total) − discount_total, 0)`. A foreign-currency order converts
with `orders.exchange_rate_at_purchase`:
`round((net_minor / factor(order currency)) / rate × factor(base currency))`. The commission is
`round(net_base × rate % / 100)`; nothing is recorded when it rounds to 0. The TypeScript mirrors
(`computeAffiliateCommissionMinor`, `convertAffiliateAmountToBaseMinor`) use the same formulas,
and `core/sql-parity.test.ts` checks them against the definition that runs (02035's).

**The rate is the one in effect when the order is paid** (02035). The `affiliate_snapshot_order_rate`
trigger copies the partner's tier `commission_percentage` and `clearance_hold_days` onto the order
(`affiliate_commission_rate`, `affiliate_clearance_hold_days`) the moment `paid_at` is set, and
`affiliate_record_commission` records `coalesce(the stored rate, the current tier's rate)`, so:

- **A tier move** (CMS → Change tier) or **a rate edit** (CMS → Tiers) applies only to orders paid
  afterwards, however late their commission is recorded (reconcile after a pause, a trigger that
  failed). Commissions already recorded keep `commission_rate_snapshot`.
- **The hold counts from the payment:** `clears_at` = `paid_at` + the stored hold. A commission
  recorded after its hold has passed (a late reconcile) clears at the next promote, which runs in
  the same payout cycle; the hold protects against refunds, and refunds keep being applied after
  it (a paid or in-flight commission is flagged and alerted). An open dispute still holds it: a
  dispute that opened before the commission existed is kept on the order
  (`orders.affiliate_disputed_at`) and recorded as the commission's `disputed_at`, so it is not
  promoted, claimed or paid until the dispute closes (see "The ledger side"). Its "you earned"
  email gives no clearance date once that date has passed (only a date still ahead is shown).
- **Orders paid before 02035** carry no stored rate: those still waiting for a commission are
  recorded at the tier's rate in effect when reconcile reaches them, as before, but their hold
  (the tier's) now counts from `paid_at` too. There is no backfill: the tier in effect at their
  payment was never recorded, and neither was a dispute opened before 02035 (it was answered
  `none`). Commissions already recorded keep their rate, hold and `clears_at`.

The terms say "A rate change applies only to orders paid after the change."

## Refunds and disputes

### Stripe

The Stripe endpoint must send six events (CMS → Payments lists them):
`checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed`, `charge.refunded`, `charge.dispute.created` and
`charge.dispute.closed`.

> **Upgrade note.** Existing Stripe webhook endpoints must add `charge.refunded`,
> `charge.dispute.created` and `charge.dispute.closed` in the Stripe dashboard. Until then
> refunds reach neither the order status nor the commissions, and disputes never hold a
> commission. Locally, `npm run stripe` (the `stripe listen --events …` command the CMS screens
> print) forwards exactly these events.

`handleStripeWebhook()` verifies the signature and returns the verified event; the app route
(`app/api/webhooks/stripe/route.ts`) handles refunds and disputes itself:

- The order is found by `payment_intent_id`, else by the `orderId` metadata on the charge or its
  PaymentIntent (a Stripe order whose recorded PaymentIntent, if any, matches).
- A full refund (`charge.refunded === true` or `amount_refunded >= amount`) or a lost
  `charge.dispute.closed` moves a paid or shipped order to `refunded` in one conditional
  update (the order trigger voids the commission), then calls `apply_affiliate_refund` with
  `full`.
- A partial refund calls `apply_affiliate_refund` with the charge's **cumulative**
  `amount_refunded` and its `amount`, so replays and out-of-order deliveries are harmless,
  including a partial refund that arrives before the order is paid or before its commission
  exists.
- `charge.dispute.created` (inquiries too) holds the order's commission
  (`set_affiliate_commission_dispute(open)`, which sets `disputed_at`): it is not promoted or
  claimed, and a `FAILED` payout detaches it on its next retry. When the order has no commission
  yet (its partner was paused at payment, or the paid trigger failed), the dispute is kept on the
  order (`affiliate_disputed_at`) and the commission recorded later starts held.
  `charge.dispute.closed` with any status but `lost` releases it; a lost dispute is a full refund
  as before (it voids the commission). An open dispute never changes the order status. The order
  is found exactly like a refund's (`syncStripeOrderDisputeFromEvent` reuses the refund lookup).
- A failure answers 500 and Stripe redelivers. `syncStripeOrderFromSession` never moves a
  `refunded` (or `shipped`) order back to `paid`, so a success-page revisit cannot revive it.

### Freemius

`app/api/webhooks/freemius/route.ts` verifies the signature, then handles `payment.refund`,
`payment.refunded`, `payment.dispute.lost` and `payment.dispute.closed` **instead of** the order
sync (whose purchase-data path would read the refunded purchase as paid). Every one is a full
refund: the order is found by license id, moved to `refunded` when paid or shipped
(`applyFreemiusOrderState` pins `refunded`), and `apply_affiliate_refund(full)` runs. A refund of
a renewal payment (`is_renewal`) changes nothing, because renewals never earned.
`payment.dispute.created` holds the commission and `payment.dispute.won` releases it
(`syncFreemiusOrderDisputeFromWebhookEvent` finds the order by license). Neither is synced, so
the order keeps its status, and a dispute on a renewal payment concerns no commission. The
response is `{ received, type, handled, orderId }`.

### The ledger side

`apply_affiliate_refund` returns:

- `voided`: a full refund (or a total ≤ 0, or refunded ≥ total) voided the live commission, or
  left a tombstone for an attributed order that had none yet. Also a partial refund whose share
  takes the whole commission (everything but the shipping came back) when the commission is not
  in flight.
- `adjusted`: a partial refund raised `refunded_amount_cents` to the share
  `private.affiliate_refund_share()` computes: base = the charge minus the order's shipping share
  (`total × shipping_total / order total`; the goods and their tax), share =
  `LEAST(commission, round(commission × LEAST(refunded, base) / base))`. Without shipping it is
  the plain ratio refunded / charge. It never falls, and `total_earned_cents` follows.
- `alerted`: the commission was paid or in flight; amounts unchanged, the refund is flagged and
  one `affiliate_refund_after_payout` alert is raised ("Reverse the transfer in Stripe if
  needed"; after a recorded manual payout, 02036: "Recover the amount from the partner, for example
  by asking them to send it back."; while the manual payout is only prepared: "Its manual payout is
  prepared but not recorded yet: if you have not sent it, cancel it under Pay manually and prepare
  it again; if you already sent it, record it, then recover the amount from the partner, for example
  by asking them to send it back."). Nothing deducts a refund from a later payout: a manual payout
  has no transfer to reverse, and a record always books exactly the amount that was prepared.
- `none`: nothing to do, or a partial refund of an attributed order that has no commission yet.
  That refund is kept on the order (`affiliate_refunded_minor`, only ever raised). The commission
  recorded later (paid trigger or reconcile) starts from it with the same share rule, and is
  recorded `VOIDED_REFUND` when that share is the whole commission.

A partial refund recorded while the payout was in flight (`refund_pending_cents`) that takes the
whole commission voids it when that payout fails (fail, release or retry), like
`void_requested_at`. A held commission (`disputed_at`) is not promoted or claimed, and is
detached from a `FAILED` payout on retry. A hold on a commission in a `PROCESSING` payout does
not stop that transfer (it is marked `PAID` if it completes), and a release clears the flag
whatever the status. Every dispute answer (`held`, `released`, `none`) is a webhook success.

A dispute that opens before the order has a commission (02035) is kept like an early partial
refund: `set_affiliate_commission_dispute` answers `held` and sets `orders.affiliate_disputed_at`
(the first date is kept on a redelivery), and the commission recorded later (paid trigger or
reconcile) is born with that `disputed_at`. This matters because the hold counts from the
payment: without it, a commission reconcile records after a long pause, with its hold already
over, would be promoted, claimed and transferred in the payout run that records it, on a
disputed sale. Closing the dispute without a loss clears the order's mark (`released`) and, once
the commission exists, its hold too. A lost dispute is a full refund, whose tombstone keeps the
commission from ever being recorded. The function takes the order row lock first, then the
profile, then re-reads the commission, so it serializes with the paid trigger (which holds the
order row) and with reconcile (which records under the profile lock).

The webhooks call `apply_affiliate_refund` and `set_affiliate_commission_dispute` (through the
lib's `applyAffiliateRefund()` and `setAffiliateCommissionDispute()`,
`@nextblock-cms/affiliates/server`) on every refund and dispute, whatever the package state, with
`throwOnError`, so a ledger failure answers 5xx and the provider redelivers. An order without a
partner answers `none`, and so does a database without the RPCs. Moving an order to `refunded` or `cancelled` from the CMS also voids its
commission through the trigger, and deleting an order voids it (A10).
`reconcile_affiliate_commissions` repairs what a trigger missed.

## Payouts

### Stripe Connect Express

The portal's payouts page creates the partner's Express account
(`ensureAffiliateExpressAccount`): `type: 'express'`, the `transfers` capability, the partner's
email, a country from a curated list of 44 limited to where the platform can pay (default: the
platform's country; see below),
`business_profile.url` (the storefront, when the site has a public https address) and, for a
country other than the platform's, `tos_acceptance.service_agreement = 'recipient'`. The create
call uses the idempotency key `affiliate-connect-<affiliateId>`, and the id is stored with a
conditional UPDATE, so two concurrent clicks end with one account. The server action returns the
onboarding URL (https on `stripe.com` only) and the client navigates to it. Stripe's
`return_url` is `/portal/retailer/payouts?connected=1`; its `refresh_url` is the GET route
`/portal/retailer/payouts/connect/refresh`, which mints a new link and redirects.

Readiness comes only from `accounts.retrieve()`: `details_submitted && payouts_enabled &&
capabilities.transfers === 'active'`, never from `?connected=1`. `syncAffiliateConnectStatus`
writes the `stripe_connect_*` columns and sets `payout_configured_at` the first time the account
is ready (PAYOUT_CONFIGURED). The key mode is tracked (`stripe_connect_livemode`, read from
`balance.retrieve().livemode`): an account of the other mode is treated as missing, so a
test ↔ live key switch means the partner onboards again.

A sale paid with a Stripe test key or in the Freemius sandbox is only ever paid by a test-mode
transfer, and a live sale only by a live one: claims take only commissions of the account's
mode, and a payout is retried, reconciled or released only with a key of the mode it was claimed
in. The CMS Retry or Release of a payout of the other mode answers "This payout was made with
the other Stripe key (test or live). Switch back to that key to retry or release it."
(`other_mode`), and the CMS payouts table marks test-mode payouts ("Test mode (made with a
Stripe test key)").

The Stripe client is `getStripeClient()` from `@nextblock-cms/ecommerce/server` (the CMS-stored
secret key first, `STRIPE_SECRET_KEY` as the fallback): payouts use the same Stripe account and
secret key as physical-product checkout, and need nothing else from Payments. A restricted key
must allow `balance.retrieve`, `accounts.retrieve`, `accounts.create`, `accounts.createLoginLink`,
`accountLinks.create`, `transfers.create` and `transfers.list` (and `webhookEndpoints.list` for
the CMS connection test).

**Partner countries.** Stripe transfers money to a connected account in another country only
inside one region: the US, Canada, the UK, the EEA and Switzerland
(`AFFILIATE_CONNECT_CROSS_BORDER_COUNTRY_CODES`, `libs/affiliates/src/lib/connect/countries.ts`).
`getAffiliateConnectCountryOptions()` therefore offers, through
`filterAffiliateConnectCountriesForPlatform`: the region's supported countries when the platform
account is in the region (33 of the 44); only the platform's own country when it is elsewhere
(nothing when that country has no Express accounts); and the whole list while the platform
country is unknown (no key, Stripe unreachable). The portal's Connect action accepts only a
country of that list, and `startAffiliateConnectOnboarding` refuses any other as well.

**Connect setup alert.** A definitive Stripe refusal of a partner's Connect step (platform lookup,
account creation, onboarding or refresh link, status check) answers the partner
`connect_unavailable` and raises one `affiliate_payout_failed` alert per UTC day (`metadata.kind
= 'connect_setup'`, `alert_date`, the step, Stripe's error code, never its message; an unresolved
alert of the day counts, like the insufficient-balance alert). A 403 (`StripePermissionError`, a
restricted key) gets the key's advice: allow Balance (read), Accounts and Account links (write) and
Login links (write), or use a standard secret key. Any other refusal says to check Connect is
enabled, the platform profile is complete, Connect branding (name, colour, icon) is set, Accounts
v1 support is on, and the partner's country is allowed for Express onboarding. The alert is about
the platform, so the partner who hit the refusal is stored as `metadata.first_affiliate_id`, never
`affiliate_id`: nothing keyed on a partner (removing them) closes it. It links
`/cms/affiliates/stripe`, which shows the latest one, and sends no email; the Overview activity
feed labels it "Stripe Connect setup" and links the same screen.

**Setting Stripe up** (the Stripe payouts screen has the same guide):

1. In the Stripe Dashboard, in test mode: Developers → API keys (`pk_test_…`, `sk_test_…`).
2. Enable Connect on the account (partners get Express accounts) and complete the platform
   profile Connect asks for.
3. Connect branding (Settings → Connect → Branding): a business name, a brand colour and an icon;
   Express onboarding needs all three.
4. The countries allowed for Express onboarding (see "Partner countries").
5. If Stripe refuses to create accounts, turn on the "Accounts v1" option in the Connect settings.
6. On the site: paste the keys under CMS → Payments and keep `NEXT_PUBLIC_IS_SANDBOX` off. For
   webhooks on your own computer, run the Stripe CLI command the Stripe payouts screen prints,
   `stripe listen --events <the six events> --forward-to <site>/api/webhooks/stripe` (current CLI
   versions refuse `listen` without `--events`; in the monorepo `npm run stripe` runs it for
   `localhost:4200`, a standalone project has no such script), and save the `whsec_…` signing secret it prints as the
   webhook secret under CMS → Payments; on a public site, add the endpoint in the Stripe Dashboard
   instead. Then **Test connection** on the Stripe payouts screen.
7. A test payout: turn automatic payouts off while testing and use "Run payouts now". Before the
   test order, give a test partner a tier with a 0-day clearance hold (a test tier; a hold changed
   later does not move a commission already recorded), have them submit their storefront and
   approve it (no referral cookie is set for an unapproved partner), and have them finish Express
   onboarding while the site uses the test key (so their account's mode matches the test sale).
   Then, in a browser not signed in as the partner, open their referral link without declining
   marketing cookies and pay a test order with another email and the card `4000 0000 0000 0077`
   (its funds are available at once) for at least the minimum payout's commission. Remove the test
   tier, or restore its hold, before going live.

### The daily cycle

`runAffiliatePayoutCycle()` (lib) runs, in order:

1. `reconcile_affiliate_commissions`, `promote_cleared_affiliate_commissions`, then the "you
   earned" email sweep.
2. `balance.retrieve()`: the available balance per currency (the `card` source when present) and
   the key mode. Without it no Stripe work follows (the stale reconcile is skipped too), because
   every later step only touches payouts and commissions of that mode (`livemode =
   balance.livemode`).
3. Stale reconcile: `PROCESSING` payouts of the key's mode untouched for 15 minutes are matched
   against `transfers.list({ destination, transfer_group })`. A transfer found completes the
   payout (a different amount or currency raises a PAYOUT_FAILED alert describing the mismatch);
   none found fails it as `stale`.
4. Automatic retries of `FAILED` payouts of the key's mode whose reason is
   `balance_insufficient` or `stale`: at most 5 attempts, at least 12 hours after the last one,
   only when the balance covers them. An automatic retry passes the program minimum, and one whose
   remainder after refunds fell below it is handed back (`below_minimum`, counted in
   `skippedBelowMinimum`) instead of sent. An admin **Retry** passes no minimum and sends whatever
   is left (Stripe may refuse a tiny amount as `amount_too_small`).
5. Claims for ACTIVE, approved partners with a Connect account: `CLEARED` commissions of the
   key's mode that no open dispute holds, amount at or above the minimum, covered by the
   balance, a matching account mode, readiness from Stripe. Then `claim_affiliate_payout` →
   `transfers.create` → `complete_affiliate_payout`.
6. At most one "Insufficient Stripe balance" alert per UTC day.

Since 02036 the cycle takes `gateways` (`AffiliatePayoutCycleDeps.gateways`), the gateways Program
settings route to Stripe Connect (`affiliateGatewaysPaidByStripe`): the claimable sums of step 5,
the balance check and `claim_affiliate_payout(..., p_gateways)` see only those gateways'
commissions, so a commission paid manually is never transferred. `undefined` / `null` keeps every
gateway (the behaviour before 02036); an empty list skips every Stripe step (no
`balance.retrieve`), leaving step 1. Step 1 alone is exported as `runAffiliateLedgerRepair()`
(`AffiliateLedgerRepairDeps`: the client, the trigger and the hooks, no Stripe client), which the
app runs when no Stripe client is needed or none is configured (see "Scheduling"). While some
gateway is paid through Stripe, the stale reconcile (step 3) and the automatic retries (step 4) act
on every existing Stripe payout, whatever its commissions' gateway; once no gateway is, the daily
run no longer touches older Stripe payouts, and the admin retries or releases them from the
payouts list (with the Stripe key; a Stripe payout still `PROCESSING` 15 minutes after its last
attempt gets the buttons too). Steps 3 and 4 read only Stripe payouts (`method =
'stripe_connect'`): a prepared manual payout is `PROCESSING` as well, but it has no transfer to
find, so it is never failed as `stale` or retried through Stripe (the engine answers
`other_mode` for one, the admin Retry and Release refuse it with `manual_payout`, and a manual
row's CHECKs refuse `FAILED`, a destination and a transfer id).

Each call handles at most 25 partners (`remaining` reports the rest), stops on a Stripe
authentication error or 3 transient Stripe failures in a row, never throws, and records short
error codes only.

### Idempotency and failures

Every transfer is `transfers.create({ amount, currency, destination, transfer_group:
'affiliate_payout_<payoutId>', metadata: { payout_id, affiliate_id, attempt } }, {
idempotencyKey: 'affiliate-payout-<payoutId>-<attempt>' })`. The payout row is claimed before
the transfer (`PROCESSING`), so a crash leaves a row the next cycle reconciles. Only a
definitive refusal (an invalid-request, permission or card error, or any 400 / 402 / 403 / 404)
fails a payout; connection, 5xx, rate-limit, idempotency and authentication errors, and a failed
completion, leave it `PROCESSING`. Retry and Release (CMS) read the balance (the key mode) before
any other Stripe call, so a Release also costs one `balance.retrieve` call, then reconcile: when
Stripe already holds the transfer, the payout is completed and neither happens.

A transfer found for a payout whose completion is refused is judged on the payout as it is after
the refusal, not on the copy the run started with. A payout `FAILED` for good (released, emptied
or handed back below the minimum) raises a `released` PAYOUT_FAILED alert ("its commissions may
be paid again"). A payout another run completed meanwhile (the cron route and the `after()`
fallback, or a Retry during a cycle) raises none, unless its transfer group holds two live
transfers (a `duplicate` alert). The admin then sees `transfer_exists`.

### Balance and currency

Transfers come out of the platform's Stripe balance in the store base currency: plain
`transfers.create` calls without `source_transaction`, drawing on the available `card`-source
balance (`readAffiliateTransferableBalance`). The cycle checks that balance before it claims, so a
short balance claims nothing, and raises the day's "Insufficient Stripe balance" alert. The CMS
Payouts and Stripe payouts screens show the platform's country, settlement currency and key mode,
the transferable balance and what is pending, and warn when the settlement currency differs from
the store base currency; the Stripe payouts screen also compares the balance with what is owed.

Every commission routed to Stripe Connect is paid from that balance, including commissions on
Freemius sales while they are routed there (the default): Freemius pays the store, never the
partners, and its sales never add money to the Stripe balance. A store paid by Freemius on PayPal
routes them to "Manually" instead (02036, see "Paying partners manually"). And Stripe's
own payouts (daily by default) sweep the available balance to the store's bank while commissions
wait out their tier's hold. To keep the money there, set the Stripe payout schedule to Manual, or
keep a Minimum balance of at least a month of commissions (Stripe Dashboard → Settings → Payouts).
Top-ups (adding funds to the balance) exist only in some countries (US, UK and Japan; a private
preview in Canada). The insufficient-balance alert and the admin "payout failed" email give the
same advice. Only the automatic run retries by itself (a payout failed for a short balance, while
attempts are left), so the alert promises "The next automatic payout run tries again." only while
automatic payouts are on (an admin's "Run payouts now" also runs with them off), and the email,
sent once a low-balance payout's retries are used up, says to retry or release it.

### Paying partners manually

Since 02036 the operator chooses, per sale gateway, how its commissions are paid. The case it
exists for: Freemius pays the store (on PayPal, for example) and never into the Stripe balance,
while a Stripe Connect transfer can only draw on that balance, and PayPal cannot send money into a
partner's Stripe Express account (an Express account receives Stripe transfers from the platform,
not PayPal payments). So Freemius commissions are routed to "Manually", the operator pays them from
PayPal, Interac e-Transfer, Wise or a bank, and records each payment in the CMS. Nothing in the CMS
moves money on that path.

**The setting.** `affiliates_settings.payoutMethods` is `{ stripeSales, freemiusSales }`, each
`'stripe_connect'` (the default, the behaviour before 02036) or `'manual'`. Every read normalizes
it (`normalizeAffiliatePayoutMethods`: a missing or unknown value is `stripe_connect`, so an older
row keeps paying through Stripe); a save goes through the strict zod schema (both keys required,
each one of the two values; leaving `payoutMethods` out keeps the stored value). The helpers live
in `libs/affiliates` `core/payout-methods.ts` (client-safe): `defaultAffiliatePayoutMethods()`,
`affiliatePayoutMethodForGateway(settings, gateway)`, `affiliateGatewaysPaidByStripe(settings)` and
`affiliateGatewaysPaidManually(settings)` (gateways in `AFFILIATE_GATEWAYS` order). The public
projection (`AffiliatesPublicProgramSettings`, `lib/affiliates/settings.ts`) carries
`payoutMethods` too, for partner-facing copy.

**What a manual gateway changes.**

- The daily cycle, "Run payouts now" and the cron route claim only the gateways paid through Stripe
  (see "The daily cycle"); with none left they run the ledger repair alone (see "Scheduling").
- Its commissions still wait out their hold and clear with the daily run (whatever the automatic
  transfers switch says, see "Scheduling"), then wait, `CLEARED`, under Payouts → **Pay manually**
  until the operator prepares a payout for them.
- The Stripe payouts screen leaves them out of what Stripe must cover and shows them on their own
  ("Paid manually: <amount> owed"; `owedManuallyCents` from `loadAffiliatePayoutObligations`).
- Partner emails say how the money comes (see "Notifications"); a refund after a manual payout
  alerts with the recovery advice (see "The ledger side").
- The partner portal says which commissions go through Stripe and which the store sends by hand,
  takes the partner's payout email, shows a prepared payout as "Being sent to you directly." and
  recorded ones as "PayPal · Ref. …" (see "Payouts page"); the built-in terms name the method per kind of sale (see "`/partners/terms` and
  `/partenaires/conditions`").

**Prepare, send, record.** A manual payout follows the Stripe path's order, so the money sent and
the money recorded are the same commissions. The first 02036 draft recorded "whatever is owed
when the admin clicks Record" after the money had left; anything that changed in between (a
commission that cleared, a refund, a dispute opened or won, a pause, a gateway switched back to
Stripe) then booked commissions that were never paid, hid an overpayment or paid one twice. Now:

1. **Prepare** (`ManualPayoutPrepareButton`, or `ManualPayPalPrepareButton` for a whole currency,
   `components/ManualPayoutActions.tsx`). `claim_manual_affiliate_payout` attaches the partner's
   `CLEARED`, unattached, live-mode, undisputed commissions of the manual gateways in that currency
   to a `PROCESSING` manual payout. Its amount is fixed from then on. A commission that clears
   later waits for the next payout; a refund, a lost dispute, a cancellation or a deleted order
   that reaches a reserved commission takes the in-flight path (`void_requested_at` /
   `refund_pending_cents` and a refund-after-payout alert, with the "prepared" advice); a dispute
   only holds it (`disputed_at`). A reserved commission is in no queue and no Stripe claim, so it is
   never paid twice. "Prepare payout" passes no minimum (the admin chose the partner); "Prepare
   PayPal payouts" prepares every PayPal-ready partner of a currency (payable, a payout email PayPal
   can take as is, at the program minimum), each claimed with the minimum, at most 250 per click
   (`AFFILIATE_MANUAL_PAYOUT_PREPARE_BATCH`; the toast says how many wait). One prepared payout per
   partner and currency (`already_prepared`).
2. **Send** the exact amount outside the CMS: PayPal (the PayPal payouts file lists the prepared
   payouts), Interac e-Transfer, Wise or a bank.
3. **Record** (`ManualPayoutRecordButton`) once the payment is complete, or **Cancel**
   (`ManualPayoutCancelButton`) if it was never sent.

**Recording a payment.** The dialog's first step shows the prepared amount, its commissions
(flagged ones first, at most 25, `AFFILIATE_MANUAL_PAYOUT_SAMPLE_LIMIT`: date, order, gateway,
amount, "refunded since it was prepared" / "disputed since it was prepared"), a warning when a
refund or a dispute reached it since it was prepared ("If you have not sent it yet, cancel it and
prepare it again: the new payout leaves them out. If you already sent it, record it; for a
refund, recover the amount from the partner (the alert says so)."), the partner's payout email (or
"No payout email yet: ask the partner where to send it."), **Sent with** (PayPal, Interac
e-Transfer, Wise, Bank transfer, Other), **Reference** (required, at most 120 characters; "The
PayPal transaction ID, e-Transfer reference or bank reference") and **Note** (optional, at most
500; "Visible to the partner"). The second step confirms: "Record {amount} paid to {name} by
{channel}? This marks {n} commissions as paid. It does not send any money. This cannot be undone."
The button's accessible name starts with its visible text ("Record payout of {amount} to @handle",
WCAG 2.5.3), as do "Prepare payout of …" and "Cancel payout of …".
`recordManualAffiliatePayoutAction({ payoutIdToRecord, channel, reference, note? })`
(`app/cms/affiliates/actions.ts`) authorizes the ADMIN, refuses on the sandbox right after,
validates strict zod and calls `recordManualAffiliatePayoutNow` (`lib/affiliates/manual-payouts.ts`,
`server-only`), which runs `requireCmsAdmin()` itself (the recorder is that session's user, never a
value from the request), refuses on the sandbox and while the program is inactive, then calls
`record_manual_affiliate_payout`. It reads no settings: a payout prepared before its gateway went
back to Stripe Connect is still recorded or cancelled here. The answers:

- `recorded`: "Payout recorded: {amount}, {n} commissions marked as paid. The partner gets an
  email." The PAYOUT_SENT email (manual variant) is scheduled, and the payouts and Stripe screens
  are revalidated.
- `already_recorded`, `not_found`, `duplicate_reference`, `reference_required`, `invalid_input`:
  one fixed sentence each, never database text.

`prepareManualAffiliatePayoutAction({ affiliateIdToPay, currency })`,
`prepareManualAffiliatePayPalPayoutsAction({ currency })` and
`cancelManualAffiliatePayoutAction({ payoutIdToCancel })` follow the same pattern (ADMIN, sandbox,
strict zod, the `server-only` implementation re-checking the ADMIN, the sandbox and the package; the
prepare paths also need readable settings and a manual gateway, `settings_unavailable` /
`not_manual`). A prepare answers "Payout prepared: {amount} for {n} commissions. Send exactly this
amount, then record it with its reference."; a cancel "Payout cancelled. {n} commissions went back
to what is owed."

Only live sales appear: a test-mode sale (Stripe test key, Freemius sandbox) is never paid with real
money, and the section says so. The minimum payout does not bind a manual payout (the row says
whether it is reached, and "Prepare PayPal payouts" takes only partners who reach it): the operator
decides when to pay. A recorded manual payout cannot be undone or edited in the CMS; a prepared one
can be cancelled.

**The queues.** `loadAffiliateManualPayoutQueue` ("Owed, not prepared yet") reads the claim's own
commission query (`readAffiliateClaimableCommissionPage` with `livemode: true`, the manual gateways
and `afterId`: keyset paging by id, so a commission that clears, is claimed or is released between
two page reads shifts nothing, and a seen-id set counts each commission once), 1,000 rows a page up
to 50 pages ("Some commissions stopped at a read limit and may be missing." past that), grouped per
partner and currency, profiles read in chunks of 100. Rows sort payable first, then those reaching
the minimum, then by amount and handle; the table pages with `manualPage` / `manualPageSize`.
`loadAffiliatePreparedManualPayouts` ("Prepared payouts: send them, then record them") reads the
`PROCESSING` manual payouts keyset by id (never one twice: the PayPal file pays what it returns),
their commissions in chunks of 100 payouts with their flags, and the partners; it is read on every
visit, so a payout prepared before every gateway went back to Stripe stays recordable ("No
commission is paid manually anymore; finish or cancel the payouts already prepared."). It pages with
`preparedPage` / `preparedPageSize`. A prepared row of a partner paused since says "Paused since it
was prepared: cancel it unless you already sent it." and is left out of the PayPal file.

**The PayPal payouts file.** "Download PayPal payouts file ({currency}, {n} payouts, {amount})"
is `GET /cms/affiliates/payouts/paypal?currency=XXX` (`app/cms/affiliates/payouts/paypal/route.ts`,
Node runtime, dynamic), built by `buildAffiliatePayPalPayoutsFileNow`, which runs
`requireCmsAdmin()` before it reads anything (403), and answers 400 for a bad currency, 404 while
the program is inactive, 409 when no prepared payout of that currency goes to a payout email PayPal
can take ("Prepare the PayPal payouts first.") and 500 when a read fails (fixed sentences). It only
reads (a GET never changes the ledger): the CSV lists the PREPARED manual payouts of that currency
whose partner is ACTIVE and has a payout email PayPal can take as is, at the amount prepared, and
goes out with `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff` and
`Content-Disposition: attachment; filename="paypal-payouts-<currency>-<date>.csv"`. Past 5,000
prepared payouts the section says the file holds the first 5,000 (record those, then download it
again). The format (`lib/affiliates/paypal-payouts-csv.ts`)
follows PayPal's Payouts web upload as documented on 2026-11-11 (developer.paypal.com → Payouts →
"Use Web UI"): no header row, one currency per file, at most 5,000 rows, CRLF line ends, and per
row: the recipient email, the amount (a dot decimal; `"12,50"` with a comma for EUR and BRL, as
PayPal's example writes them; whole units for a zero-decimal currency), the currency, the
customer ID (the partner's handle, at most 30 characters), the note to the recipient in the
partner's language ("{site} partner commissions ({n} orders)" / "Commissions de partenaire {site}
({n} commandes)", at most 400 characters, no link) and the wallet `PAYPAL`. Every text cell that
starts (after spaces) with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading
apostrophe, so nothing a partner typed runs as a spreadsheet formula; storefront links never
appear. The recipient email is never rewritten that way (an apostrophe or quotes would make PayPal
pay a different, still valid address): a row whose email would need escaping is left out
(`isAffiliatePayPalRecipientSafe`; the builder lists its handle in `skipped`, and the CMS never
counts such a payout as PayPal-ready). The portal (`normalizeAffiliatePayoutEmail`) refuses such an
address in the first place (no leading `=` `+` `-` `@`, no quote, comma or whitespace), and the
database CHECK refuses the leading characters and whitespace. The operator uploads the file under
PayPal Business → Pay & Get Paid → Payouts, checks the payments PayPal shows before it sends
anything, then records each payout with its PayPal transaction ID once its payment is complete
(PayPal shows it as Completed; a payment nobody claims within 30 days goes back to the store's
PayPal balance, and a prepared payout can still be cancelled until it is recorded).

### Paying partners with PayPal

Since 02037 a gateway's commissions can also be paid automatically with PayPal Payouts, from the
operator's PayPal balance: `payoutMethods` takes a third value, `'paypal'` ("PayPal (automatic,
from your PayPal balance)" under Program settings → How partners are paid; the help recommends
PayPal or Manually for Freemius sales). `affiliateGatewaysPaidByPayPal()` lists those gateways,
`affiliateGatewaysPaidOutsideStripe()` the PayPal and manual ones together (what never needs the
Stripe balance: the Stripe payouts screen counts them as "Paid outside Stripe", outside Needed).

**Credentials** (`lib/affiliates/paypal/credentials.ts`, server-only). The CMS-saved configuration
wins: `site_settings.affiliates_paypal_secret` holds the environment new payouts go out in and, per
environment, a client id and the secret encrypted with the app's secret envelope
(`encryptWithEnvKey`), sealed for its own field (`siteSettingSecretSlot('affiliates_paypal_secret',
'<environment>_secret')`, 02038): a sandbox secret never opens as the live one. The row is
service-role only: 02037 adds a RESTRICTIVE policy that no API role (an aal2 ADMIN included) reads or
writes that key through, and 02038's secret-name rule (`_secret` at the end) covers it too. The environment variables are the
fallback: `PAYPAL_CLIENT_ID` / `PAYPAL_SECRET_KEY` (sandbox), `PAYPAL_LIVE_CLIENT_ID` /
`PAYPAL_LIVE_SECRET_KEY` (live), and `PAYPAL_ENVIRONMENT` (`live`; anything else, or unset, is the
sandbox) while the CMS saved none. The CMS sees the environment, where the credentials come from and
the client id's last 4 characters, never a secret. A save verifies the pair with PayPal first (a
fresh token): credentials PayPal rejects, or that cannot be checked, are not saved.

**The client** (`paypal/client.ts`): OAuth2 client credentials (`POST /v1/oauth2/token`), the token
cached per environment and credentials until five minutes before it expires; `createPayoutBatch`
(`POST /v1/payments/payouts`, `PayPal-Request-Id` = the `sender_batch_id`, recipient type EMAIL,
wallet PAYPAL, purpose SERVICES (PayPal records GOODS when it is left out), ASCII email subject), `getPayoutBatch` / `getPayoutBatchItems` (every page,
`total_required`), `getPayoutItem`, `cancelPayoutItem` (`POST …/cancel`, UNCLAIMED items only) and
`getBalances` (`GET /v1/reporting/balances`, needs the balances permission). The host comes only
from the environment (api-m.sandbox.paypal.com or api-m.paypal.com), paths are fixed `/v1/` routes,
ids are checked before they reach a path, redirects are refused, every call has a timeout, every
answer is capped and validated with zod. Errors become `AffiliatePayPalError` kinds the engine acts
on (`credentials`, `not_enabled`, `insufficient_funds`, `rate_limited`, `duplicate_batch` with the
linked original batch, `not_found`, `refused`, `unavailable`, `malformed`); a 401 on an API call
retries once with a fresh token. A 2xx create answer that fails the schema is adopted by its
`batch_header.payout_batch_id` when that id has PayPal's shape (PayPal created the batch), else it is
`malformed`. The client sends only PayPal's 24 Payouts currencies
(`AFFILIATE_PAYPAL_PAYOUT_CURRENCIES`) and HUF, JPY and TWD in whole units (the store keeps HUF and TWD
in hundredths: `formatAffiliatePayPalApiAmount` answers null for a fraction); anything else is
refused before any request (`CURRENCY_NOT_SUPPORTED`, `NOT_WHOLE_UNITS`). `sendAffiliatePayPalRequest`
refuses on the public sandbox before any fetch.

**The run** (`paypal/engine.ts`, wired by `paypal/runner.ts`): every payout run ends with the PayPal
step (the daily `after()` fallback, the cron route, "Run payouts now"; on the sandbox it returns
before anything).

1. Sync, always: every PayPal payout in flight whose batch PayPal acknowledged is checked with the
   credentials of its own environment. Item SUCCESS completes it (`complete_paypal_affiliate_payout`,
   exactly once, with PayPal's transaction id and fee; PAYOUT_SENT; SUCCESS without a transaction id
   is noted as SUCCESS, so the payout can never be released, and waits for the next check); FAILED,
   BLOCKED, RETURNED, REFUNDED, REVERSED fail it and hand its commissions back
   (`fail_paypal_affiliate_payout`, which applies refunds flagged meanwhile; PAYOUT_FAILED, or an
   operator alert when the cause is the PayPal balance); a DENIED or CANCELED batch fails its payouts
   whose item PayPal never processed (missing, no status, PENDING, NEW), while an item PayPal did
   process (UNCLAIMED, ONHOLD, a final status) follows its own status; PENDING, ONHOLD and UNCLAIMED
   keep it in flight with the status noted (PAYPAL_UNCLAIMED the first time); an unknown status keeps
   it and raises an alert. A batch PayPal will not show (a 404 or 403 after the credentials moved to
   another PayPal account, an answer that fails the schema) raises `paypal_batch_unresolved`
   (`cause: 'unreadable'`, the batch id); a timeout, a 5xx or a rate limit is tried again silently.
2. Only while automatic payouts are on (or "Run payouts now"): a batch whose create call had an
   unknown outcome (a timeout, a 5xx, an unreadable 2xx: its payouts carry the saved
   `sender_batch_id` and no batch id) is sent again with the same id; a reused id PayPal refuses with
   a link to the original batch is adopted. Before each resend the send is stamped on its payouts
   (`record_paypal_affiliate_payout_batch` with no batch id: `last_attempt_at`, `attempt_count + 1`)
   and the payouts that still carry the id with no batch id are read again: exactly those are sent,
   so a payout an admin released meanwhile is not. A resend PayPal refuses before it could look at
   the first batch (rejected credentials, Payouts not enabled, INSUFFICIENT_FUNDS) never releases
   anything: PayPal may hold and pay the first send, so the payouts stay in flight with
   `paypal_batch_unresolved` naming the cause and the sender id (credentials and not enabled also
   stop the step), and they are sent again once the cause is fixed. PayPal forgets a sender id after
   30 days, so a batch first claimed over `AFFILIATE_PAYPAL_RESEND_MAX_AGE_DAYS` (25) days ago is
   never sent again: it stays in flight with `paypal_batch_unresolved` (`cause: 'expired'`; "Check
   PayPal status now" reports it too) for the admin to check in PayPal.
3. Then, for the gateways paid with PayPal: the active environment's token must carry the Payouts
   scope; every ACTIVE, approved partner whose payout email is a PayPal account PayPal can take
   (`payout_email_kind = 'paypal'`, `isAffiliatePayPalPayoutReceiver`), and whose last PayPal payout
   was not returned to that same address since they last saved it (`payout_email_saved_at`), is
   claimed for each currency whose cleared commissions reach the minimum
   (`claim_paypal_affiliate_payout`) and that PayPal can send exactly (`canAffiliatePayPalSendAmount`;
   otherwise one `paypal_currency_unsupported` alert per currency, `CURRENCY_NOT_SUPPORTED` or
   `NOT_WHOLE_UNITS`, and nothing is claimed). One batch per currency and language gets a new
   `sender_batch_id`, saved on its payouts BEFORE the create call; PayPal's batch id is saved after
   (a payout of the batch that no longer takes it, released meanwhile, raises
   `paypal_batch_unresolved` with `cause: 'not_recorded'`). A definitive refusal of a first send fails
   the batch's payouts and hands their commissions back (an empty PayPal balance raises "PayPal
   balance too low", Payouts not enabled or rejected credentials stop the step and raise their alert).

A live payout pays live-mode commissions only and a PayPal sandbox payout test-mode ones (the claim
filters on `livemode`), so a real sale is never marked paid with sandbox money. The run never
throws; its summary (`paypal` on "Run payouts now") counts what it did. Operator problems are one
`affiliate_payout_failed` alert per kind (and currency) and UTC day, linking the PayPal payouts
screen.

**Partners PayPal cannot pay** (an Interac e-Transfer payout email, none, one PayPal cannot take as
is, one PayPal returned a payout from and not saved since, or a currency PayPal Payouts does not
send) are paid by hand: their commissions of the PayPal gateways join Pay manually
(`loadAffiliateManualPayoutQueue` with `paypalGateways`; each row says why, `payPalFallback`
`currency` / `interac` / `no_email` / `invalid_email` / `returned`, and which gateways a prepared
payout reserves). `affiliate_profiles.payout_email_kind` (`paypal`, the default, or `interac`) records
what the payout email is for, and `payout_email_saved_at` when the partner last saved it (every
save, the same address included); both are pinned by the profile guard like `payout_email`. A
receiver failure (`isAffiliatePayPalReceiverFailureReason`: returned, blocked, refunded, reversed,
cancelled, refused for the receiver) keeps the run off that address until a save after it: a new
address, or the same one once the partner opened or confirmed their PayPal account ("I checked it:
try PayPal again" in the portal).

**The CMS screen** (`/cms/affiliates/paypal`, ADMIN only, program-gated): status (environment,
credentials source, client id's last 4, whether the token carries the Payouts scope, marked as a
sandbox app's when it is one, the gateways paid with PayPal), warnings when PayPal is in Sandbox while
gateways are routed to it (live sales then wait: they are neither sent nor listed under Pay manually)
and when the store currency is one PayPal Payouts does not send (or sends in whole units only), the
open PayPal alerts, the credentials form (verify before save), "Test connection" (a fresh token, the
Payouts scope, the app id, the balance when readable; nothing is sent), the payouts in flight with
"Check PayPal status now" (the sync alone; it promises a resend of the batches with no answer only
while automatic payouts are on) and **Stop payment** (an UNCLAIMED item, cancelled at PayPal, then its
commissions go back and the partner, not the admins, is emailed; renamed from "Cancel" so it never
sits beside the dialog's own Cancel; when PayPal answers the cancel with an error, the screen names it and its
debug id and nothing changes: PayPal's sandbox answered 500 INTERNAL_SERVICE_ERROR to every cancel of an
unclaimed item on 2026-11-12, so an unclaimed sandbox payout waits for its 30-day return) or **Release** (`release_paypal_affiliate_payout`, after the admin
checked PayPal paid nothing: a payout PayPal never confirmed, an hour after its last send, or one it
accepted and never settled, a week after it while PayPal lists no SUCCESS, PENDING, ONHOLD or
UNCLAIMED status; the database checks the rule under the payout lock), the recent failures and a setup
checklist (a verified business account; Payouts access, done only from a live app's token since a
sandbox app always carries the scope; the REST app (Merchant) under Sandbox, then Live; credentials;
routing; the balance in the store currency, about US$0.25 per payout to Canada or the US and 2% (at
most US$20) elsewhere from a Canadian or US account, partners pay nothing, about 4% conversion from
another currency; a first small live payout as the only proof of live approval). The Payouts screen
shows PayPal history rows ("PayPal · {status} · Transaction {id}", the PayPal fee, the receiver); a
PayPal payout is never retried or released through Stripe, and the database refuses that too: a
FAILED PayPal payout must carry a `paypal_` reason, so `fail_affiliate_payout`,
`release_affiliate_payout` and `prepare_affiliate_payout_retry` raise on one.

**The partner side.** The partner chooses PayPal or Interac e-Transfer in the portal and types a new
PayPal email twice (`payout_email_kind`, saved by `saveRetailerPayoutEmail`, which stamps
`payout_email_saved_at`); the payouts page shows the next PayPal payout and reads PayPal history rows
as "PayPal · {status}" (see "Payouts page"). `dispatchAffiliatePayPalPayoutEvent`
(`paypal/events.ts`) receives every PayPal payout event after the ledger changed: PAYOUT_SENT mails the
partner ("We sent you {amount} by PayPal.", PayPal's transaction id), PAYOUT_FAILED mails the admins
and, as PAYPAL_PAYOUT_FAILED, the partner (an admin's own Stop payment mails only the partner), and
PAYPAL_UNCLAIMED mails the partner where PayPal sent its claim email (see "Notifications"). The
built-in terms name PayPal Payouts per kind of sale (see "`/partners/terms` and
`/partenaires/conditions`").

### Scheduling

There are three ways a cycle runs, and no `vercel.json` cron (it ships to every 1-click install;
CLAUDE.md forbids crons there) and no committed GitHub workflow (every fork inherits
`.github/`):

- **The fallback, nothing to set up.** The CMS and portal layouts call
  `maybeRunAffiliatePayouts()` in `after()`. It returns at once unless a run is due (package
  active, not the sandbox, and, when Stripe transfers are on and some gateway is paid through
  Stripe, a Stripe client that did not fail for a transient reason), checks at most every
  5 minutes per instance, claims the UTC day (`claim_affiliate_payout_run`) so only one
  instance runs it, gives itself 20 s, continues the day's run 15 minutes later while partners
  are left, and takes over a run abandoned for 30 minutes. Payouts therefore happen the first
  time someone opens the CMS or the portal on a given day. Settings it cannot read mean no run
  (it tries again at its next 5-minute check).
- **The cron route.** `GET` or `POST /api/affiliates/cron/payouts` with
  `Authorization: Bearer <CRON_SECRET>`. It fails closed: 404 in the sandbox, 503 while
  `CRON_SECRET` is unset or shorter than 16 characters, 401 for a missing or wrong bearer
  (SHA-256 of both sides compared with `timingSafeEqual`), `{ ok: true, skipped:
  'package_inactive' }` when the package is off. Every response is `Cache-Control: no-store`.
  It honours the automatic transfers switch for Stripe transfers only (switched off, it runs the
  ledger repair and answers `skipped: 'disabled'`), repeats passes of 25 partners for up to 45 s
  (8 passes) within `maxDuration` 60, and records the day so the fallback does not run again.
- **"Run payouts now"** on `/cms/affiliates/payouts` (re-checks ADMIN, runs even when
  automatic payouts are off; skipped while the package is inactive and while the program
  settings cannot be read).

**Without Stripe (02036).** The three runs ask for a Stripe client only when Stripe transfers are
on (the fallback and the cron route honour the switch; "Run payouts now" always sends) and some
gateway is paid through Stripe Connect (`affiliateGatewaysPaidByStripe`). Otherwise, or when no
Stripe secret key is configured, they still run the ledger repair (`runAffiliateLedgerRepair`: late
commissions recorded, refunded orders voided, cleared commissions promoted, the "you earned"
sweep), so commissions clear every day on a store that pays its partners by hand, with the switch
on or off (a store that turned it off because it has no Stripe transfers no longer stalls its
commissions in `PENDING_CLEARANCE`, or loses late ones past the 120-day reconcile window). Such a
day is claimed with the trigger `repair`: the fallback re-checks it hourly, and once transfers can
run (the switch turned on, a key added, a gateway back on Stripe) it takes the day over for them
(renamed `auto`, a fresh summary) instead of waiting for the next day; an explicit Stripe run on a
repair-only day renames it to its own trigger, so the fallback sends no second run. An explicit run
records the day too, unless Stripe was needed and only unreachable (`unavailable`), when the
fallback should still try the transfers later that day. "Run payouts now" reports the repair: with
every gateway paid manually it succeeds with "Commissions checked: 3 cleared, 1 recorded late." (or
"No commission was due to clear.") and "Every commission is paid manually, so nothing was sent
through Stripe: prepare, send and record each payout under Pay manually." (`stripeTransfers:
'not_needed'`); with Stripe needed and missing or unreachable it answers the usual error followed
by what the repair cleared (`stripeTransfers: 'skipped'`). The settings form names the switch "Send
Stripe transfers automatically every day" and says the daily run clears commissions either way.

A run is skipped when the program settings cannot be read (`settings_unavailable`; the CMS
button says "The program settings could not be read, so nothing was sent. Try again in a few
minutes."). The defaults (automatic payouts on, minimum 100) apply only while no settings row was
ever saved: a read error, a throwing client or a stored value that is not an object never turns
payouts back on or lowers the minimum (`readAffiliatesSettingsStrict()` in
`lib/affiliates/settings.ts`; display and notification reads keep the lenient
`getAffiliatesSettings()`).

To call the route on a schedule from Supabase:

```bash
npm run affiliates:schedule-payouts -- https://shop.example.com            # install or update (daily 06:00 UTC)
npm run affiliates:schedule-payouts -- https://shop.example.com print-sql  # SQL for the SQL editor instead
npm run affiliates:schedule-payouts -- --hour=4 https://shop.example.com   # or --schedule="30 7 * * *"
npm run affiliates:schedule-payouts -- status                              # job, last runs, last responses
npm run affiliates:schedule-payouts -- remove                              # unschedule, drop the Vault secret
```

The installer ships with the app: `tools/schedule-affiliate-payouts.js` in a standalone
project, `apps/nextblock/tools/schedule-affiliate-payouts.js` in the monorepo (the root
`npm run affiliates:schedule-payouts` runs that file; `tools/scripts/schedule-affiliate-payouts.js`
is a thin alias for running it by path). The same command works in both layouts, and
`npm run update` brings it to existing standalone projects (it is a framework script). It reads
`CRON_SECRET` (16+ characters), `POSTGRES_URL_NON_POOLING` (or `POSTGRES_URL` / `DATABASE_URL`)
and `NEXT_PUBLIC_URL` from `.env.local`, then `.env`, in the directory it runs from (npm runs it
from the project root, the repo root in the monorepo), never overriding a variable already set.
It installs one pg_cron job (`affiliate-payouts`) that POSTs the route through `pg_net` with the
bearer read from Vault (`affiliate_payouts_cron_secret`, never in the job command), refuses
`http://` except for a local development host, and refuses a sandbox env. Any other scheduler
that can send the header works too.

### Sandbox

`NEXT_PUBLIC_IS_SANDBOX=true` disables Connect account creation and transfers: the runner skips
(`sandbox`), the cron route answers 404 and the portal shows a notice. Its Stripe key comes from
the deployment's env and belongs to the operator, so the Stripe payouts screen asks Stripe nothing
there: no key facts (`getStripeKeyDiagnostics()` reads nothing), no balance or schedule, and
**Test connection** answers before any Stripe call (`testAffiliateStripeSetup`,
`testAffiliateStripeSetupNow` and `loadAffiliateStripePayoutsOverview` are in `SANDBOX_GUARDS`).
The ledger's demo figures still show. A manual payout is never prepared, recorded or cancelled
there either: the demo partners are shared by every visitor, so the four manual payout actions
(`prepareManualAffiliatePayoutAction`, `prepareManualAffiliatePayPalPayoutsAction`,
`recordManualAffiliatePayoutAction`, `cancelManualAffiliatePayoutAction`) refuse right after the
admin check and their implementations (`prepareManualAffiliatePayoutNow`,
`prepareManualAffiliatePayPalPayoutsNow`, `recordManualAffiliatePayoutNow`,
`cancelManualAffiliatePayoutNow`) refuse by themselves (all eight in `SANDBOX_GUARDS`), and
**Prepare payout**, **Prepare PayPal payouts**, **Record payout** and **Cancel** are disabled with
"Payouts are disabled in the sandbox." The PayPal file only reads (the demo partners have no payout
email, so nothing is ever prepared for PayPal there). Nor can a visitor give the demo partner one:
the portal's payout email form is read-only there with "Payouts are turned off in this demo.", and
`saveRetailerPayoutEmail` refuses right after the partner check (`SANDBOX_GUARDS`), since an
address saved on the shared account would be shown to every later visitor and listed in the
PayPal file.

PayPal Payouts (02037) are never called there: `sendAffiliatePayPalRequest` throws before any
fetch, the run's PayPal step and the engine return before they read anything, no PayPal credential
is read or saved (the env pair belongs to the operator, and a visitor's own app would pay out of an
account of their choosing for every later visitor), and the PayPal payouts screen shows no
credential fact and nothing to act on; its four actions refuse right after the admin check. The
scanner (`tools/scripts/lib/sandbox-guards.js`) treats a non-GET fetch in a module naming a PayPal
REST host, and the client's `createPayoutBatch` / `cancelPayoutItem` anywhere, as payment-provider
writes, so new PayPal code cannot skip the question.

## The partner portal

`retailer/loading.tsx` shows a skeleton of the content area (`components/PortalLoading.tsx`: one
localized `role="status"` line, `affiliates.common.loading`, and an `aria-hidden` block that
pulses only under `motion-safe`) inside the retailer layout, so the header and nav stay while a
page renders. The nav links keep `prefetch={false}` (a prefetch would render the layout and its
`after()` payout trigger) and show a decorative pending dot through `useLinkStatus()`, faded in
after 150 ms so fast navigations do not flash it.

`app/(portal)/portal/error.tsx` is the portal's error boundary. It sits one segment above
`retailer/` because an `error.tsx` never wraps its own segment's layout, so it also catches a
failed partner lookup in `retailer/layout.tsx`, not only page errors. Its copy comes from the
common dictionary in the site language (the portal's copy provider lives in the layout that
failed): `affiliates.common.error_generic` as the heading and a "Try again" button
(`affiliates.common.retry`) that calls `retry()`. It never shows the error message or digest.

### Onboarding

The overview tracks four steps: **account** (signup), **profile** (display name and a bio of at
least 40 characters; sets `profile_completed_at`), **payouts** (Stripe Connect ready; sets
`payout_configured_at`) and **storefront** (first approval; sets `first_published_at`). Each of
the first steps notifies the admins (SIGNED_UP, PROFILE_COMPLETED, PAYOUT_CONFIGURED), and every
submission does (PAGE_SUBMITTED); a withdrawn submission can be sent again only 10 minutes after
it was made. Since 02036 the **payouts** step is also done, while the program pays some gateway's
commissions by hand or (02037) with PayPal Payouts (`payoutMethods`, `affiliateGatewaysPaidOutsideStripe`),
once the partner saved a payout email, a PayPal account or an Interac e-Transfer address alike
(`computeAffiliateOnboardingProgress({ profile, page, payoutMethods })`, `core/onboarding.ts`; the
overview loader reads the settings for it). That case stamps no timestamp and mails no admin: the
database's `onboarding_step`, and so the CMS partner list, still follow Stripe Connect only. The
step reads "Payouts set up" (FR "Versements configurés"), its link "Set up my payouts", the welcome
banner "…set up your payouts…" and the cleared figure's line "Cleared commissions waiting for the
next payout." (all reworded by 02036: none of them promises a bank transfer through Stripe). Under its heading the overview shows the partner's tier and rate and "Tier since
{date}" (FR "À ce niveau depuis le {date}"; `affiliates.portal.overview_tier_since`, seeded by
02035: `tier_changed_at`, else the sign-up date). It also shows the welcome, changes-requested,
in-review and "links don't earn until the first approval" banners, referral visits and balances,
the storefront address and a same-site `?ref=` link builder (it refuses other sites, `/cms`,
`/api`, `/portal` and `/_next`), and the five latest commissions.

A suspended partner still enters the portal, read-only, with the suspension reason; every
action refuses them.

### Storefront studio

- **Profile:** avatar upload, display name, bio (counter and the 40-character hint), eight
  social links (website, Instagram, TikTok, YouTube, X, Facebook, Pinterest, LinkedIn; https
  only, each on its network's own hosts; any https site for the website) and the language
  ("Language" / "Langue": of our emails and of the storefront; a change reaches the live page
  at its next approval).
- **Page settings:** title (≤ 120) and meta description (≤ 300).
- **Featured products:** an explicit list chosen with the product picker (12 through the UI,
  24 on the server), re-validated as active public products on every save. The public page shows
  it after the content, without the products a grid already shows.
- **Editor:** `StorefrontEditor`, read-only while the page is in review, the partner is
  suspended or saving is blocked.
- **Autosave:** a 1.5 s debounce, one save at a time, optimistic concurrency on `draft_version`.
  A conflict (another tab saved) shows a reload prompt and blocks saving. Every save re-runs the
  sanitizer. A save that a size CHECK refuses (23514; defense in depth, since the sanitizer keeps
  the document under the limit) returns `too_large`: the autosave status then says the page is
  too large (`affiliates.portal.error_storefront_too_large`), and the save is retried with the
  next edit.
- **Preview:** `StorefrontRenderer` of the sanitized draft, exactly as the public page renders.
- **Submit / Withdraw:** submit needs the stored version, a title and non-empty content; a
  published page is resubmittable only when the profile (its language included) changed since
  approval. Withdraw returns the page to `DRAFT` and closes the page's open review alert. A
  submission the partner withdrew can be resubmitted only 10 minutes after it was made
  (`rate_limited`, `affiliates.portal.error_submit_cooldown`); after an admin decision the
  partner can resubmit at once. The cooldown is part of the conditional UPDATE (first submission
  `submitted_at IS NULL`, after a decision `submitted_at <= reviewed_at`, after a withdrawal
  `submitted_at` older than 10 minutes), so parallel requests cannot bypass it. Every submission
  emails the admins, and a scripted withdraw and submit loop needs no admin in between, so
  without the cooldown it mailed every admin recipient on every round through the store's SMTP
  account. Neither submit nor withdraw evicts a public cache: nothing public changes until an
  approval.
- **Review lock:** while `PENDING_REVIEW`, draft, profile and avatar changes are refused
  (withdraw to edit). The database refuses a partner's own name, bio and link edits over the Data
  API too (55000). Approve publishes exactly the profile the reviewer saw; if it changed since the
  review screen loaded, the approval is refused and the admin reloads.
- **Copilot:** the `StorefrontCopilotPanel` beside the editor (see "The storefront copilot").

### Uploads

`POST /api/affiliates/upload` (multipart, `file` + `kind=avatar|image`) checks, in order:
`requireRetailer()`, a same-origin request, not `PENDING_REVIEW` (409), 30 uploads per hour per
partner (per process), then a streaming body cap. Files are at most 2 MB (avatar) or 5 MB (image).
Only JPEG, PNG, WebP, AVIF and GIF pass, recognised by their magic bytes before sharp sees them
(this sharp build decodes SVG, which must never reach it), then decoded by sharp (50 M pixels, or
12 M for AVIF, which libheif decodes at about 25 bytes per pixel; `failOn: 'error'`; a 30 s
processing timeout; for AVIF the bound is also checked against the coded size the container
declares in its `ispe` properties, read before any decoder runs, because sharp reports the size
after a clean-aperture crop and libheif still decodes the full coded frame; an AVIF whose
extents cannot be read is refused), one decode at a time per process (`createAffiliateUploadDecodeGate()`), and
re-encoded to a metadata-free JPEG: a 512 × 512 cover crop at quality 85 for an avatar, at most
1600 px wide and 4000 px tall at quality 82 for an image. Keys are built on the server,
`affiliates/avatars/<affiliateId>/…` or `affiliates/pages/<affiliateId>/…`
(`lib/affiliates/upload-keys.ts`, which loads no sharp, so the CMS approval can check keys
cheaply), and checked with the media library's key policy. Page images are capped at 200 per
partner and 30 per hour across instances (storage listing).

A new avatar updates `avatar_object_key`. It deletes the previous one only when that is the
partner's own avatar object (`affiliates/avatars/<id>/`) and not the approved snapshot's avatar
(`published_profile.avatar_object_key`): the live storefront's header, JSON-LD and Open Graph
card show the snapshot's avatar until the next approval. The approval that publishes a newer
snapshot then deletes the old snapshot's avatar if it is the partner's own object and no longer
the profile's avatar (`lib/affiliates/avatar-cleanup.ts`; best effort, logged on failure). So a
partner keeps at most two avatars: the approved one and a newer one waiting for review.

These objects are not media-library rows, and no staff path touches the partner namespaces
`affiliates/avatars/` and `affiliates/pages/` (`PARTNER_UPLOAD_NAMESPACES` and
`isPartnerUploadKey`, one definition in `lib/storage/upload-policy.ts`, which also collapses
repeated slashes): `/api/upload/proxy` and `/api/upload/presigned-url` refuse a folder inside them
(`resolveUploadFolder`), `/api/process-image` refuses such a key (it would read the partner's
object and write six variants into their prefix), `/api/media/record` refuses to record one, and
the `/cms/media` delete and move actions never touch one or move media into them
(`lib/storage/media-object-keys.ts`). So a WRITER cannot fill a partner's upload caps, plant files
in their prefix, or remove their files through a decoy media row. The rest of `affiliates/` is an
ordinary media folder: an install that already keeps its own media there (the media library
takes free-text folders) keeps its upload, move and delete paths. `media-object-keys.test.ts`
fails when the partner pipeline builds a key outside `PARTNER_UPLOAD_NAMESPACES`.

### Payouts page

The Connect card (not connected: country select and "Connect bank account (automated
payouts)"; incomplete or under review; ready: the Express dashboard link; sandbox notice;
unavailable), balance cards (pending in the refund window, cleared and awaiting payout, paid
out, the next automated payout), the commissions table (date, short order reference, amount and
refunds, rate, status, clears on), payout history and an FAQ. `?connected=1` makes the page ask
Stripe for the status; `?connect_error=1` shows an error. After a sign-in the partner comes back
with `?connected=1` / `?connect_error=1` intact (the page passes its own query to
`requireRetailerPage` too). The next payout is an estimate: paused when automatic payouts are off
or the store has no Stripe account, not eligible before the first approval, Connect required,
else the next daily run once the cleared balance reaches the minimum, or the day after the
pending commission that would reach it clears.

The cleared card counts every commission attached to a payout, so its line separates a failed
transfer from one still running (`retailerClearedBalanceHint`, `lib/affiliates/portal-data.ts`).
Money in a running transfer is "on its way to your bank"; money in a manual payout the store has
prepared but not recorded yet (02036, `manualSendingCents`: the partner's `PROCESSING` manual
payouts in the base currency) reads "We're sending you {amount} directly." (`on_its_way_manual`).
Money held by a FAILED payout is a transfer that failed, and the line and that payout's history
row promise "We'll try again
automatically" only when the daily cycle really will (`isAffiliatePayoutAutoRetryable`: a
transient reason with attempts left, automated payouts on, Stripe configured, not the sandbox,
some gateway still paid through Stripe (with none, the daily run only repairs the ledger), the
partner payable). Otherwise they say "We'll look into it and send it again": the payout waits
for an admin's Retry or Release.

**Manual payouts** (02036). `loadRetailerPayoutsData` reads `payoutMethods` from the settings and
returns `payoutMode`: `stripe` (every gateway through Stripe Connect, the default: the page above,
unchanged), `manual` (every gateway paid by hand) or `mixed`. The open commissions (pending and
cleared, base currency, paged by id past the 1,000-row cap) are split by how their gateway is
paid, so each figure sees only its own money: the Stripe estimate (`nextPayout`, null in `manual`)
counts the Stripe-routed commissions only, as `claim_affiliate_payout`'s `p_gateways` does, and
`manualPayout` (`computeRetailerManualPayout`, null in `stripe`) the others. When some gateway is
paid by hand the page changes as follows:

- **"How you get paid"** (`components/PayoutMethodsCard.tsx`, above the Connect card): in `manual`
  one sentence ("{site} sends your commissions to you directly, by PayPal or Interac e-Transfer.");
  in `mixed` "How a commission is paid depends on how the order was paid." and one line per kind
  of order ("Orders paid through Stripe" / "Orders paid through Freemius": "Your commissions are
  transferred to your Stripe account." or "Your commissions are sent to you directly by {site}, by
  PayPal or Interac e-Transfer."). `{site}` is the site title (else the default title).
- **The payout email form** (`components/PayoutEmailForm.tsx`, in that card): since 02037 it asks
  PayPal or Interac e-Transfer first, with a label, help and (for a new PayPal address) a
  confirmation per choice (see "PayPal Payouts" below); Save, and Remove once one is saved
  (saving an empty field removes it too). It skips the browser's validation so the message is the
  portal's ("Enter a valid email address, like name@example.com."), and refreshes the page after a
  save. `saveRetailerPayoutEmail` (`retailer/actions.ts`) runs `requireRetailer()` first (a
  suspended partner is refused), refuses on the sandbox right after (`SANDBOX_GUARDS`), takes a
  strict `{ payoutEmail, payoutEmailKind }` (the address at most 1,024 characters raw; the kind
  `paypal` or `interac`, 02037), normalizes the address with
  `normalizeAffiliatePayoutEmail` (trimmed, lower-cased, HTML's email grammar with a dot in the
  domain: no whitespace, quote, comma or angle bracket, and no first character a spreadsheet reads
  as a formula, `=` `+` `-` `@`, which the PayPal file could only carry by changing the address;
  the column's CHECK refuses those too) and checks it against zod's email rule at
  most 254 characters (`invalid_payout_email`, else `invalid_input`), then writes
  `{ payout_email, payout_email_kind }` (the address or null) with the service role filtered on the
  actor's affiliate id and user id, and revalidates the portal. It mails nobody. The form is
  read-only on the sandbox ("Payouts are turned off in this demo.") and for a suspended partner.
- **The Connect card** shows only while some gateway is paid through Stripe; in `mixed` its intro
  and ready text speak of "the commissions we pay through Stripe" (`connect_intro_partial`,
  `connect_ready_body_partial`), and the FAQ answer points at "How you get paid" for which kind of
  order that is, so both stay true whichever gateway the settings route to Stripe.
- **Figures.** The description, the cleared figure's line and the FAQ answer follow the mode:
  "Paid by {site} once it reaches {min}." in `manual`, "{stripe} goes by Stripe transfer and
  {manual} is paid by {site}, each once it reaches {min}." in `mixed` (a failed or running Stripe
  transfer still comes first). "Next payout from {site}" replaces (`manual`) or joins (`mixed`,
  then the grid has three columns) "Next automated payout": after your first approval; "Add your
  payout email" ("{site} needs it to send your payouts."); "Paid by {site}" with "{site} sends your
  cleared balance to {email} by PayPal or Interac e-Transfer." once the cleared balance reaches the
  minimum, or "Sent to {email} by PayPal or Interac e-Transfer once your cleared balance reaches
  {min}." while pending commissions will bring it there; below the minimum; "Nothing to pay out
  yet". A payout the store has prepared comes first: "{site} is sending you {amount}."
  (`next_payout_manual_sending_hint`), shown in `stripe` mode too when it was prepared before every
  gateway went back to Stripe. No date: the store decides when it sends. "No earnings yet" became "Nothing to pay out
  yet" (02036) for every figure, since a partner paid in full, or paid the other way, has earnings.
- **Tables.** In `mixed` the commissions table gets a **Payout** column ("Stripe transfer" / "Sent
  directly"): an open commission by its gateway's method, one attached to a payout by that
  payout's `method` (payouts not on the page are read in one query; a failed read shows a dash
  rather than a guess), a voided one a dash. A payout recorded by hand reads "{Channel} · Ref.
  {reference}" ("PayPal · Ref. 5TY…"; PayPal, Interac e-Transfer, Wise, Bank transfer, Other
  method) and, below, "Note: {note}" when the admin wrote one, in every mode; one the store has
  prepared but not recorded yet (`PROCESSING`) reads "Being sent to you directly."
  (`payout_manual_sending_note`); Stripe payouts keep "Ref. {transfer id}".

**PayPal Payouts** (02037). A gateway routed to `paypal` counts as paid outside Stripe for
`payoutMode` (the card shows, the Connect card only while another gateway uses Stripe). Which way a
partner's commissions really go is `payoutRoutes` (`retailerPayoutRoutesOf`): `stripe` for the
Stripe gateways, `paypal` for the PayPal gateways while PayPal can pay this partner (their payout
email is a PayPal account PayPal can take as is, `isAffiliatePayPalPayoutReceiver`, and PayPal did
not return the last payout sent to that same address since they last saved it,
`loadAffiliatePayPalBlockedReceivers` with `payout_email_saved_at`, the run's and the CMS's own rule), `manual` for the gateways the store pays by hand (a gateway routed to
"Manually", or a PayPal gateway for a partner PayPal cannot pay: an Interac e-Transfer address, none,
or a returned one). The open commissions are split three ways (`clearedByMethod` has `paypalCents`),
and:

- **"How you get paid"** names the method of each kind of order: a PayPal gateway reads "Your
  commissions are sent to your PayPal account automatically, or by Interac e-Transfer if you choose
  it." (`payout_methods_by_paypal`, also the one sentence when every kind of order is paid with
  PayPal; the card must never fall back to the Stripe line for a PayPal gateway). When PayPal
  returned the last payout sent to the partner's current address (and they have not saved it since),
  an amber notice says so (`payout_paypal_returned_notice`: "PayPal returned the last payout sent to
  {email}. Check that it is the email of your PayPal account (or open and confirm a PayPal account
  with it), then save it again below, or choose Interac e-Transfer. Until you do, {site} pays you by
  hand."; `paypalReturnedTo`). A new address lifts it, and so does the same address saved again: the
  form then offers "I checked it: try PayPal again" (`payout_email_retry_paypal`; the form's
  `paypalReturned`), which saves it unchanged ("Saved: PayPal is tried at this address again with
  your next payout."), stamping `payout_email_saved_at` later than the return.
- **The header and the FAQ** name each method the program pays with: every kind of order with
  PayPal (`payouts_description_paypal`, `faq_payout_answer_paypal`), Stripe and PayPal
  (`payouts_description_stripe_paypal`: "…go to your bank through Stripe, or to your PayPal account
  automatically (or by Interac e-Transfer if you choose it)."; `faq_payout_answer_stripe_paypal`: each
  kind is sent in the daily payout run once it reaches {min}), PayPal and the store by hand
  (`payouts_description_paypal_manual`, `faq_payout_answer_paypal_manual`), otherwise the manual,
  mixed (Stripe and by hand) or Stripe wording as before.
- **The payout email form** asks first "How do you want to receive your payouts?" (the reworded
  `payout_email_label`, a `fieldset` with two radios, PayPal and Interac e-Transfer, from
  `payout_email_kind`), then "Email of your PayPal account" with the warning "Use the email of your
  PayPal account. A payout to an address without a confirmed PayPal account waits 30 days to be
  claimed, then returns." (the reworded `payout_email_help`), or "Email for Interac e-Transfers" with
  "Interac e-Transfers are sent by {site} by hand, usually less often." (`payout_email_interac_help`;
  `payout_email_interac_help_manual`, "{site} sends Interac e-Transfers by hand.", while no gateway is
  paid with PayPal). A PayPal email PayPal has not been given for this partner yet (a new address,
  or one saved for Interac) shows "Confirm your PayPal email", announced under the email ("A new
  PayPal email is typed twice: confirm it in the next field.", `payout_email_paypal_confirm_hint`, in
  the email's `aria-describedby`); an empty confirmation ("Type your PayPal email again to confirm
  it.") or a mismatch ("The two email addresses don't match.") is refused before the server is called
  and moves the focus to the confirmation field (a refused address moves it to the email).
  `saveRetailerPayoutEmail` takes a strict `{ payoutEmail, payoutEmailKind }` (`paypal` | `interac`,
  both required), refuses on the sandbox right after `requireRetailer()` as before, refuses a PayPal
  address PayPal could not take (`invalid_payout_email`: over 127 characters, PayPal's receiver
  limit), writes `{ payout_email, payout_email_kind, payout_email_saved_at }` on the actor's own row
  with the service role and answers `{ ok, payoutEmail, payoutEmailKind }`. A PayPal payout already
  in flight keeps the address it was sent to (`paypal_receiver`); the next one uses the new one.
- **Figures.** "Next PayPal payout" (`paypalPayout`, `computeRetailerPayPalPayout`) joins the
  figures while PayPal pays this partner or holds a payout of theirs: a payout PayPal holds first,
  "Waiting for you to claim it" with "Claim it in PayPal: check the email PayPal sent to {email}."
  (the payout's own `paypal_receiver`) or "On its way" with "{amount} is on its way to your PayPal
  account."; else the Stripe estimate's arithmetic, since the same daily run sends PayPal payouts:
  paused while automatic payouts are off or the active PayPal environment has no credentials
  (`getAffiliatePayPalCredentialStatus`, booleans only), not eligible before the first approval, the
  next daily run or the day after the clearing commission (a date, "Estimate. Payouts run
  automatically once a day."), below the minimum, or "Nothing to pay out yet" with "Sent by PayPal on
  the next daily run once you reach {min}." (`next_payout_paypal_hint`). "Next payout from {site}"
  shows only while some commission is paid by hand (`payoutRoutes.manual`) or a manual payout is
  prepared. The grid has three columns once two next-payout figures show. The cleared card's line
  reads, after a failed or running Stripe transfer, "{amount} is waiting for you to claim it in
  PayPal." or "{amount} is on its way to your PayPal account." (`paypalSendingCents`,
  `paypalUnclaimed`: PayPal payouts in flight are no longer counted in `manualSendingCents`), else by
  route: "Sent by PayPal once it reaches {min}.", "{stripe} goes by Stripe transfer and {paypal} by
  PayPal, each once it reaches {min}." or "{paypal} goes by PayPal and {manual} is paid by {site},
  each once it reaches {min}.". With every kind of order paid with PayPal the description reads
  "…then go to your PayPal account automatically, or by Interac e-Transfer if you choose it." and the
  FAQ answer "Once your cleared balance reaches {min}, the next daily payout run sends it to your
  PayPal account. If you chose Interac e-Transfer, {site} sends it by hand instead."
- **Tables.** The commissions table's Payout column shows whenever the partner's commissions go two
  ways (`countRetailerPayoutRoutes > 1`), and reads "PayPal" for a commission PayPal pays or paid (an
  open one of a PayPal gateway reads "Sent directly" for a partner PayPal cannot pay). A PayPal payout
  in the history reads "PayPal · {status}": "Sent" (PayPal has it), "Waiting for you to claim it"
  (item UNCLAIMED, with the claim line), "Paid" with "Transaction {id}", "Returned" (RETURNED,
  REFUNDED, REVERSED, or cancelled before it was claimed) or "Not sent" (any other failure), the last
  two with "The amount went back to your balance." It never gets a Stripe note ("Being sent to your
  bank.", "The transfer failed…"), and the store's PayPal fee is never shown.

The card is **unavailable** when no Stripe secret key is configured
(`isAffiliateConnectConfigured()` in `lib/affiliates/connect-service.ts`: false only for
`stripe_not_configured`, never in the sandbox, never for a transient failure). It then says
"Bank payouts aren't available on this store yet. Once the store finishes setting up its payment
account, you can connect your bank account here. The commissions you earn until then are kept."
(`affiliates.portal.connect_not_configured`) instead of offering "Connect bank account", and the
next-payout card shows "Paused". The Connect actions answer `payouts_not_configured`
(`affiliates.portal.error_payouts_not_configured`) in that case, and keep the transient "We
couldn't reach Stripe right now" (`connect_unavailable`) for real Stripe failures.

### The storefront editor

`@nextblock-cms/affiliates/editor` is a restricted Tiptap editor, not `NotionEditor`: the
NotionEditor kit preserves arbitrary HTML, which is unsafe for untrusted authors.

- **Schema:** exactly the storefront allowlist. Blocks: paragraph, heading (levels 2 and 3),
  bullet and ordered list, blockquote, horizontal rule, image, `storefrontCallout` (tone info,
  tip or highlight) and `affiliateProductGrid` (`productIds`, `title`, `columns` 2 / 3 / 4).
  Inline: text and hard break. Marks: bold, italic, underline, strike, link. Quotes hold only
  paragraphs, list items a paragraph followed by paragraphs or lists (two levels at most), so the
  editor can never hold something the sanitizer would drop.
- **Links** pass `sanitizeStorefrontHref` everywhere they enter (dialog, autolink, paste); pasted
  `target`, `rel`, `class` and `title` are reset; `rel` is `nofollow ugc noopener noreferrer`.
- **Images** come only from the allowed origins: paste and drop from elsewhere are dropped, the
  `![alt](src)` input rule is removed, base64 is off, upload results are checked again, and a
  photo credit survives editing.
- **Slash menu** (`/`, its own `storefrontSlash` plugin key): headings, lists, quote, divider,
  callout, image (only with an upload function) and products. `/promote`, `/products` and
  `/produits` insert a product grid and open the picker.
- **Product picker:** 250 ms debounced search through a server action, at most 12 products per
  grid and 24 different products per page, kept in the order picked.
- **Replacing text** (`replaceStorefrontSelection`, the copilot's "Replace selection"): only
  text inside ONE text block (a paragraph, a heading, a list item's paragraph or a callout) is
  replaced, keeping that block and the formatting that spans the selection. A selection edge that
  only touches the next block (a drag ending at the start of the following line), or the very
  end of the previous one, is dropped. A node selection, text across blocks, or a range holding a
  product grid, an image or a divider is refused: nothing changes and the call returns false, so
  blocks are never merged and nothing is deleted. `StorefrontEditorApi.replaceSelection()`
  returns that boolean, and `canReplaceSelection()` (`canReplaceStorefrontSelection`) answers the
  same question beforehand (structure only; it does not check that the editor is editable).
- `trailingNode` is disabled: Tiptap would add a trailing paragraph on the first click into a page
  that ends with a grid, image or list, and the autosave would send a `PUBLISHED` page back to
  `DRAFT` with no real edit. The insert commands add a paragraph after new blocks instead.
- Node definitions are React-free (so `getSchema()` works in tests); the grid's React node view
  is attached on the client.
- `immediatelyRender: false` and `enableContentCheck`: if the stored document fails to load, the
  editor shows an error, becomes read-only and never calls `onChange`, so an empty fallback can
  never overwrite the draft. Every change is emitted as a sanitized document.

### The storefront document

Partner JSON is untrusted wherever it is read. `sanitizeStorefrontDoc()` is the XSS boundary: a
hand-written allowlist walk that never throws, keeps only the node, mark and attribute set above
with validated values, and enforces `STOREFRONT_LIMITS` by truncation (200 top-level blocks,
depth 6, 5000 characters per text node and 60,000 in total, 12 grids of 12 products, 24 distinct
products, 30 images, 256 KiB measured as jsonb text, the CHECK's unit
(`storefrontJsonbTextByteLength`; compact JSON undercounts it by up to about 10% on a mark- and
link-dense page), 2000-character hrefs, 250-character alt text). String input over
1 MiB, 50,000 nodes or 48 levels is refused before the walk. Hrefs allow https, http, one
`mailto:` address and safe site paths. Images must be on an exact allowed origin or a `/images/…`
path. A photo credit is kept only for Pexels or Unsplash, with its links held to the provider's
own site (an Unsplash download trigger only on `api.unsplash.com/photos/`). Run it at
read time, with this deployment's image origins (`getStorefrontImageOrigins()`, server-only, so
compute it in RSC or route code and pass it down), before anything renders or saves.

`StorefrontRenderer` is pure React (no hooks, no directive, no raw-HTML prop, no `style`, literal
Tailwind classes) and re-validates every href, src and credit. Links get
`rel="nofollow ugc noopener noreferrer"` and `target="_blank"` only for absolute links to another
origin. The first image is eager with `fetchPriority="high"`, later ones lazy. A heading or
callout without visible text (only spaces, NBSP, zero-width or other invisible characters, or
line breaks) renders nothing (`hasStorefrontVisibleText`); the sanitizer and the stored document
keep it.

## The CMS screens

All of `/cms/affiliates/**` is ADMIN-only: `'/cms/affiliates': ['ADMIN']` in
`cmsRoutePermissions` (`proxy.ts`), the sidebar's Partners group (`adminOnly`, with a badge
counting storefronts in review), and every page and action calls `requireCmsAdmin()` first (session,
enrolled second factor, ADMIN) and reads and writes with the service role. The server actions
in `app/cms/affiliates/actions.ts` take no actor or client argument, validate strict zod input
(targets named `pageIdToApprove`, `affiliateIdToUpdate`, `affiliateIdToRemove`, `payoutIdToRetry`,
`affiliateIdToPay`, …) and return `{ ok, message | error }` without database text.

- **Overview** (`/cms/affiliates`): headline numbers and the onboarding funnel; the partner
  table (escaped search, filters, each partner's email, their tier with "Tier since" (the date of
  the last move, `tier_changed_at`, else the sign-up), **Change tier** (see below), **Pause
  partner** with an optional reason, **Resume partner**, and a link to every partner's review page: "Review now"
  while their page waits for review, "Open review" otherwise, so a partner who never submitted
  is reachable too; a paused partner's published page reads "Paused", not "Published"); the
  activity feed of affiliate alerts with "Done" (the platform-wide Stripe alerts, by
  `metadata.kind`: "Stripe Connect setup" and "Stripe balance", link the Stripe payouts screen like
  the banner; other payout alerts link the payouts list); **program settings** (`affiliates_settings`:
  up to 10 notification emails, the minimum payout, 50 to 1,000,000 minor units, default 100,
  the daily Stripe transfers switch ("Send Stripe transfers automatically every day": the daily
  run clears commissions past their hold either way, and with it off sends no Stripe transfer),
  **How partners are paid** (see below), and the partner terms
  pages, see below); the payout endpoint URL, whether `CRON_SECRET` is set, and the
  `npm run affiliates:schedule-payouts` command.

**How partners are paid** (02036, a fieldset of `components/ProgramSettingsForm.tsx`): two selects,
"Commissions on Stripe sales" and "Commissions on Freemius sales", each "Stripe Connect (automatic
transfers)" or "Manually (PayPal, Interac e-Transfer, bank transfer)" (`AFFILIATE_PAYOUT_METHOD_LABEL`),
described by "Freemius pays you, not your partners: choose Manually for Freemius sales unless you
keep enough money in Stripe. Freemius pays you on the 10th of the second month after a sale." and
"Commissions paid manually are left out of the Stripe transfers: prepare each payout under
Payouts → Pay manually, send it yourself, then record it." The minimum's help adds that for
commissions paid manually it decides who is ready under Pay manually and whom "Prepare PayPal
payouts" includes. The form always sends both values
(`payoutMethods`); the Overview page's remount key includes them, so a save from another tab
re-seeds the form. A save revalidates the Stripe payouts screen as well. See "Paying partners
manually".

**Change tier** (`components/PartnerTierControl.tsx`, a button labelled "Change tier", accessible
name "Change tier of @handle", on every Overview row and in the review page's Partner card). The
admin can move a partner at any time, paused or not. The dialog lists every tier: active ones are
selectable, inactive ones are listed disabled with the reason ("Inactive tiers can't take
partners: activate one on the Tiers screen first."), and a full capped tier stays selectable
behind an **Assign over the cap** box ("{tier} is full. The cap only limits public sign-ups and
the spots-left count on the partners page. Tick it to move them anyway."), which the move waits
for. **Email the partner** (off by default) sends the TIER_CHANGED notice once the move went
through. The confirmation reads "From now on, orders paid earn {rate}. Commissions already
recorded keep their rate."; it sits in an always-present polite, atomic live region (announced
when a tier is picked) and describes **Move partner**. `changeAffiliatePartnerTierAction` (strict
zod: the two ids plus the optional `allowOverCap` and `notifyPartner` booleans; refused on the
sandbox right after the admin check) calls `changeAffiliatePartnerTier` (`lib/affiliates/review.ts`,
which refuses on the sandbox too), which reads the partner and the tier for the wording, then
moves them with the `change_affiliate_partner_tier` RPC, which re-checks everything under row
locks. Each answer has a CMS sentence; a real move evicts the storefront and tier caches,
schedules the email only when asked, and the action revalidates the overview, the approvals list,
every review page and the Tiers screen. The toast: "{name} moved to {tier}. Orders paid from now
on earn {rate}%." Since the dialog sends `allowOverCap` for any tier the page shows as full,
`tier_full` only comes back when the tier filled up after the page loaded (a public sign-up into
a capped default tier, another admin's move): it reads "That tier filled up in the meantime. Tick
"Assign over the cap" to move this partner anyway, or raise the tier's partner cap on the Tiers
screen.", and the action revalidates the same screens on that refusal (and on `tier_inactive`,
`tier_not_found` and a missing partner), so the page re-renders in the action's response and the
open dialog keeps its selection and shows the box.

**Partner terms pages** (`termsUrlEn`, `termsUrlFr`; empty by default). "Partner terms page
(English)" and "(French)" replace the built-in terms (`/partners/terms`, `/partenaires/conditions`)
with the operator's own page; the help text says the built-in terms are a starting template, not
legal advice, that they take the legal name and the support email from Settings → Privacy &
Consent (linked), and, while the built-in terms are in use (no English page) and that screen gives
them no contact address, that partners see none (`loadAffiliateTermsOperatorIdentity`,
`lib/affiliates/terms-identity.ts`, the terms route's own rule). A "Preview built-in terms" link
opens `/partners/terms?builtin=1` in a new tab: the built-in terms even while a page replaces them,
for a signed-in ADMIN only (see the terms route below). A value is `''`, a site path that passes
`isSafeInternalPath` (`lib/auth-redirects.ts`: one leading `/`, no backslash, whitespace or control
character, no encoded leading slash) and holds whole, plain segments (no `//`, no `.` / `..` or
`%2e` segment, no `%2f` / `%5c`: Next and browsers would rewrite those into another address), or an
absolute `https://` URL with a host and no credentials; at most 2,048 characters, trimmed
(`parseAffiliateTermsUrl`). The stored form is canonical, the way a browser requests it:
percent-encoded ASCII (`’` → `%E2%80%99`, an IDN host in punycode, a lowercase scheme and host),
because the terms page redirects there and Node refuses a `Location` header with a character above
U+00FF (every request a 500). A built-in terms address is refused however it is spelled, as a path
or as an https URL on this site's host (`resolveSiteUrl()`, `www.` ignored):
`isAffiliateTermsUrlBuiltIn` → `isBuiltInPartnersTermsTarget` (`partners-paths.ts` decodes ASCII
escapes, collapses slashes and resolves dot segments before it compares), since the page would
redirect to itself. `saveAffiliatesProgramSettings` checks both after `requireCmsAdmin()` and strict
zod (both fields optional: omitted keeps the stored value) and answers a readable error; every read
normalizes again with the same rules and reads an invalid stored value, or a built-in address, as
`''` (`normalizeAffiliateTermsUrl`), so the terms route, the sign-up and portal links and the
sitemap agree. The French page falls back to the English one. A save evicts the public projection
(`evictAffiliateProgramSettingsCache`: the tag, both terms addresses, both landing addresses and
the sitemap). On the public sandbox a non-empty link is refused right after the admin check (the
other settings save as before), the form shows both fields disabled with that sentence, and every
read drops a stored link, whatever wrote it (`SANDBOX_GUARDS`: the action, `normalizeAffiliateTermsUrl`
and `getPublicAffiliatesProgramSettings`).
- **Tiers** (`/cms/affiliates/tiers`): every column but `member_count`, with configuration
  warnings (no active tier, no default tier, several promo tiers, a promo tier that is not the
  default, a default tier ranked ahead of the promo tier (`promo_shadowed`: signups skip the
  launch offer), default tiers full, program full). The form's help texts say that new partners
  fill the default tier with the highest sort order first. A tier with partners cannot be deleted
  (move them or deactivate it). Moving a partner into an inactive tier is refused; a full capped
  tier takes a partner only with "Assign over the cap" (the cap holds for sign-ups, and the
  spots-left count shows no negative). The dialog says that rate and hold changes apply to orders
  paid from now on; recorded commissions keep the rate they were earned at.
  - **Goals.** The editor has "Goal (English)" and "Goal (French)" fields (02033, up to 160
    characters, blank hides the line). The help text says reaching a goal moves nobody.
  - **Partners column.** It explains itself: "1 of 50 spots taken" with "49 left", "Full" and
    where new partners go next, or "No partners yet". A badge marks the tier new partners join
    (`selectAffiliateSignupTier`, the rule `/partners` and the signup RPC use). Paused partners
    (status `SUSPENDED`) keep their spot until they are moved or deleted.
- **Approvals** (`/cms/affiliates/approvals`): the queue (with each partner's email; "First
  publication" when the partner has no `first_published_at`, as on the review page, else "Update
  to a live storefront", or "Update to a paused storefront" for a paused partner), the last
  reviewed pages (a paused partner's published page reads "Paused", not "Published"), and
  **Storefronts**: every storefront that has been published (`published_content` set), newest
  approval first, paged with `.order().range()` and an exact count under its own parameters
  (`?storefronts=`, `?storefrontsPageSize=`; `loadAffiliateStorefrontsAdmin`). Each row shows the
  partner, the handle as plain text, Live / Paused (with the reason) / Not published yet, the
  last approval date, and Pause / Resume, Email and Open review. Both lists shrink (reviews,
  removals), so a stale page number is not an error: PostgREST's 416 `PGRST103` (an offset past
  the last row, which carries no count) is read as an empty page whose total comes from a head
  count, and the screen says "This page is past the last storefront" with a link to the first
  page instead of claiming that nothing was published.
  **Review** (`/approvals/<pageId>`): Live and Proposed side by side with changed blocks
  highlighted, product grids as chips (hidden or missing products flagged), profile changes
  (name, bio, avatar, links and language), title and meta changes, featured products added or
  removed, what the sanitizer removes, and a JSON diff. Its **Partner** card shows Live / Paused
  (with the reason) / Not published yet, the sign-in address with Email and Copy, the tier with
  its rate and "Tier since", **Change tier**, Pause / Resume, and **Remove partner**. The summary
  says "Update to a paused storefront" for a paused partner.
- **Payouts** (`/cms/affiliates/payouts`): Stripe platform facts and the currency warning, the
  commission ledger with the clearance countdown and order links, the payouts table (test-mode
  payouts marked) with **Retry** (another attempt, reconciling first) and **Release** (give up
  and make the commissions claimable again) on `FAILED` rows that are not closed (released,
  emptied or below the minimum), and **Run payouts now**. The platform card reads the same
  `getAffiliatePayoutPlatformInfo()` as the Stripe payouts screen: the key mode, the platform
  country, the transferable (card-source) balance with what is pending, and "Key rejected by
  Stripe" (`error: 'stripe_authentication'`) instead of "Configured" when Stripe refuses the key.
  When **Run payouts now** is off, the reason shows under the button with a link (sandbox; no key:
  Payments; a rejected key: Stripe payouts).
  Since 02036 the screen follows **How partners are paid**. The platform card adds that fact
  ("Stripe Connect", "Manually (every sale)" or "Stripe sales: Stripe Connect · Freemius sales:
  manually"); the page description and the **Run payouts now** confirmation describe what a run
  does for that routing (with every gateway manual: "Clears commissions past their hold and records
  any the order trigger missed. Every commission is paid manually, so nothing is sent through
  Stripe: prepare, send and record each payout under Pay manually."); and while some gateway is
  paid manually, only the sandbox disables the button (a missing or rejected key no longer does:
  the run then does the ledger repair). **Pay manually** (shown while some gateway is paid
  manually, and while a prepared payout waits or could not be read) names the three steps
  (prepare, send, record) and says only live sales appear, then:
  - **Prepared payouts: send them, then record them**: per-currency totals ("{amount} in {n}
    prepared payouts"), each with "Download PayPal payouts file ({currency}, {n} payouts,
    {amount})" (or "None of them goes to a payout email PayPal can take: send them by Interac
    e-Transfer, Wise or bank transfer.", and a note past PayPal's 5,000 payments per file), then a
    paged table (partner, payout email, the amount fixed when it was prepared, the commission
    count, when it was prepared, and "Changed since it was prepared: open Record payout for what
    to do." or "Paused since it was prepared: cancel it unless you already sent it." when it
    applies) with **Record payout** and **Cancel** on every row, and the PayPal upload
    instructions.
  - **Owed, not prepared yet** (while some gateway is paid manually): per-currency totals
    ("{amount} owed to {n} partners"), each with **Prepare PayPal payouts** (or why there is
    nothing to prepare for PayPal), then a paged table (partner and paused badge, payout email or
    "No payout email yet", owed, the minimum "Reached" or "Below {minimum}", the commission count)
    with **Prepare payout** on each payable row ("Paused partners are not paid: resume them first."
    otherwise).

  See "Paying partners manually". The payouts table shows a manual payout as "Prepared manually"
  ("Prepared, not recorded yet: send it, then record it (or cancel it if it was never sent) under
  Pay manually.") or "Recorded manually", its amount with "{Channel} · Ref. {reference}" and "Note
  to the partner: {note}", never Retry or Release. With every gateway manual no daily run
  reconciles a Stripe transfer, so a Stripe payout still `PROCESSING` 15 minutes after its last
  attempt gets **Retry** and **Release** there, and the failed-payouts banner says "No commission is
  paid through Stripe now, so failed payouts are not retried: Release one to move its commissions
  to Pay manually, or Retry it." (with a mix it adds that a failed Stripe payout keeps its
  commissions out of Pay manually until it is released; the Release dialog says where they go).
- **Stripe payouts** (`/cms/affiliates/stripe`, `AFFILIATE_CMS_STRIPE_PATH`; page
  `app/cms/affiliates/stripe/page.tsx`, data `lib/affiliates/payout-setup.ts`). There is no
  second key store: the keys are the shop's (CMS → Payments, else the env), and this screen
  only reads them.
  - **Who pays your partners**: customers pay through Freemius (digital) and Stripe (physical);
    partners are always paid by Stripe Connect transfers from the Stripe balance, their
    commissions on Freemius sales included, and Freemius sales never add money to that balance.
    Payouts need only the secret key; the publishable key and webhook secret serve checkout and
    refunds. Since 02036 the card follows **How partners are paid**: with everything on Stripe
    Connect it keeps that wording and adds how to pay Freemius commissions from PayPal or Interac
    instead (Manually, Overview → Program settings); with every gateway manual it says Stripe
    Connect sends nothing and payments are recorded on the Payouts screen; with a mix it names
    which sales go which way.
  - **Stripe keys** (`getStripeKeyDiagnostics()` in `libs/ecommerce/src/lib/payment-config.ts`):
    the source of the secret key (CMS or `STRIPE_SECRET_KEY`), a CMS key this deployment cannot
    decrypt, the mode from the prefix, a restricted key, the last 4 characters (nothing more of
    any key leaves that function), whether the publishable key is present and of the same mode
    (a mismatch only when the secret key has a mode), and whether a webhook secret is set; what
    Stripe says (a restricted key that can't read the balance reads "Key accepted, but it can't
    read everything payouts need", never "Couldn't reach Stripe"); and the platform's country and
    settlement currency beside the store's ("CA · Store USD · Stripe CAD", as on Payouts).
    **Edit keys in Payments** links `/cms/payments`.
  - **Test connection** (`testAffiliateStripeSetup()` → `testAffiliateStripeSetupNow()`): read-only
    calls, each in its own try/catch, answered as checks (`pass` / `warn` / `fail` / `skip`) with
    fixed wording: `balance.retrieve()` (the key, its mode against the prefix, transferable and
    pending per currency); `accounts.retrieve()` of the platform (country, settlement currency,
    name, charges and payouts enabled, the payout schedule, Connect branding: name, colour and
    icon); the store currency against the account and the balance; `webhookEndpoints.list({ limit:
    100 })` (an enabled endpoint for `<site>/api/webhooks/stripe` with every event of
    `STRIPE_REQUIRED_WEBHOOK_EVENTS`, or `*`; skipped without a configured site address, and for
    an address Stripe can't reach: loopback, private or link-local, `.local`, `.localhost`,
    `.test`, `0.0.0.0` or a dotless host (`isPubliclyRoutableSiteUrl`), with the Stripe CLI
    command for it, `stripeCliListenCommand()`: `stripe listen --events <the six events>
    --forward-to <site>/api/webhooks/stripe` (`npm run stripe` only in the monorepo), and the `whsec_…` secret to save); `transfers.list({ limit: 1 })`; and
    `accounts.retrieve(<one partner's account of this mode>)` (skipped until a partner connects).
    A rejected key skips the rest. Errors read "Stripe rejected this key", "This restricted key
    can't read …" or "Couldn't reach Stripe"; Stripe's messages and raw errors are never returned,
    the log gets codes only,
    and the result ends "Nothing was charged or transferred." On the sandbox the action answers
    before any Stripe call (its key belongs to the operator).
  - **Balance vs what you owe** (`loadAffiliatePayoutObligations()` in
    `libs/affiliates/src/lib/payouts/obligations.ts`), per currency in the key's mode (from the
    balance, else the key prefix, else live): owed now (every partner's cleared commissions through
    the cycle's own claimable query, `readAffiliateClaimableCommissionPage`, split into Stripe and
    Freemius sales; the next run pays only the part of active, approved, onboarded partners at or
    above the minimum, while the balance covers it), in flight
    (`PROCESSING`), waiting to retry (`FAILED` and `isAffiliatePayoutAutoRetryable`), needing a
    Retry or Release (the other `FAILED` payouts that still hold commissions), and clearing within
    30 days; needed = owed now + waiting to retry + needing you + clearing; against the
    transferable (card-source) available plus pending balance: **Covered** or **Short by
    <amount>**. A settlement currency that differs from the store's gets the Payouts screen's
    warning above the table. The sandbox shows the ledger figures but no Stripe figure.
    Since 02036 every figure counts only the gateways paid through Stripe (`gateways` option;
    the clearing window too), and the commissions paid manually show under owed now as "Paid
    manually: <amount> owed" (`owedManuallyCents`, live-mode sales), outside Needed; while some
    gateway is manual, the Stripe / Freemius split and the advice to pay Freemius commissions
    manually are left out. With no gateway left on Stripe a failed transfer counts as needing you,
    never as waiting to retry (`automatedPayoutsRunning` is false then: the daily run only repairs
    the ledger).
  - **Keep money in Stripe**: Stripe sweeps the available balance to the bank on its payout
    schedule (daily by default) while commissions wait out their hold. A schedule that is not
    manual gets advice, not an alert, because a Minimum balance also keeps the money there and the
    screen can't read one: unless a Minimum balance of at least a month of commissions is kept
    (the last 30 days' figure given), set the schedule to Manual (Dashboard → Settings → Payouts).
    Plus top-ups (US, UK and Japan; a private preview in Canada) and Freemius funding.
  - **Automation**: "Automatic Stripe transfers" On or Off and the minimum (linking Overview →
    Program settings), `CRON_SECRET` configured, too short (under 16 characters) or missing
    (length only; the visit fallback is promised everywhere but the sandbox, since the daily run
    always clears commissions, 02036), the last run (its trigger label, none for a repair-only day,
    the day's totals, partners left and why it stopped; "Could not be read" when the run table
    can't be read) and the next one (06:00 UTC with a scheduler, else the first CMS or portal visit
    of the UTC day, followed by "(it clears commissions; it sends no Stripe transfer: …)" and why
    when it sends none: automatic Stripe transfers off, every commission paid manually, or no
    Stripe secret key), and the
    Connect return URL (`affiliateConnectReturnUrls()`), with a warning when the key is live and
    that URL is not https or no site URL is configured.
  - The latest unresolved **Connect setup alert** (with Done), and a collapsible **Set up Stripe
    for payouts** guide (see "Stripe Connect Express"): its webhook step is the Stripe CLI command
    for this site while Stripe can't reach it, else a Dashboard endpoint, and its test payout steps
    come in the order a payout needs them.

**Approve & Publish** succeeds only while the page is still `PENDING_REVIEW` at the
`draft_version` the admin reviewed (the UPDATE is conditional on both), and while the partner's
public profile still matches the fingerprint of the snapshot the review screen showed (checked
before any write: no `first_published_at` mark, page update, alert, email or eviction on a
mismatch; the snapshot that matched is the one published). It re-sanitizes the draft with this
site's image origins and refuses an empty result, copies title, meta description and featured
ids (uuids, deduped, at most 24) into `published_*` with the profile snapshot (re-sanitized
social links, and the partner's language), writes no draft column, sets `reviewed_*` and
`published_at`, and clears the admin note. `first_published_at` is set only if empty, just before
the page write, and undone if that write fails. It is refused for a paused partner (resume
first). Then it closes the page's review alerts, emails the partner (PAGE_PUBLISHED), evicts the
storefront cache, and deletes the avatar of the snapshot it replaced when that is the partner's
own object and no longer the profile's avatar. **Request changes** needs a note (≤ 2000), keeps
whatever was published live and emails the partner (CHANGES_REQUESTED); it publishes nothing, so
it needs no fingerprint.

**Pause / Resume** are the CMS's words for the partner-level suspension: the enum keeps
`SUSPENDED` / `ACTIVE` and the partner's portal keeps "suspended" (`affiliates.portal.suspended_*`),
while the CMS buttons read "Pause partner" / "Resume partner" and the SUSPENDED badge reads
"Paused". `suspendAffiliatePartnerAction` takes an optional reason (≤ 500, `suspended_reason`,
which the partner reads in the portal and in the PARTNER_SUSPENDED email);
`reactivateAffiliatePartnerAction` clears it. One component (`components/PartnerStatusControls.tsx`)
serves the Overview table, the Storefronts list and the review page. A pause takes the storefront
off the public site at once (the cache is evicted) and stops the referral cookie, click counting,
new attribution, commission recording and payouts; recorded commissions keep clearing, and orders
placed before the pause and paid during it are credited at the first payout run after the resume,
up to 120 days old (see "Who earns"). The partner is emailed on each change of status, never for a
reason edited on a partner who stays paused.

The dialogs and the pause toast follow whether the partner was ever approved (`isApproved`:
`first_published_at` is set; the Overview row's `isApproved`, the review page's profile, the
Storefronts row's partner, and `isApproved` in the moderation result). An approved partner's
pause says their storefront goes offline and their links stop earning, and their resume says the
last approved storefront comes back; before a first approval nothing of theirs is public and
nothing earns, so the pause says "{name} can't edit or submit their storefront until you resume"
and the resume "{name} can edit their storefront again and submit it for review", as the
PARTNER_SUSPENDED / PARTNER_REACTIVATED emails already did (`storefrontLive`).

**Remove partner** (the review page's Partner card, which the Overview links for every partner):
a destructive dialog that needs the handle typed out,
`removeAffiliatePartnerAction({ affiliateIdToRemove, confirmHandle })` →
`removeAffiliatePartner` (`lib/affiliates/review.ts`). The action authorizes like its siblings,
refuses on the sandbox right after, then parses strict input. The function refuses on the sandbox
too, loads the partner and compares the handle (trimmed, one `@` and case aside), then:

1. **pauses** the partner first (`status = SUSPENDED`): every 02030 money function requires an
   ACTIVE partner, so no commission or payout can be recorded between the check and the delete
   (commission and payout rows cascade from the profile);
2. **re-checks the ledger** with `checkAffiliateUserDeletion` (`lib/affiliates/affiliate-deletion-guard.ts`,
   shared with `/cms/users`: any payout, or any commission but a zero-amount refund tombstone). A
   partner with history, or a ledger that cannot be read, **stays paused**: "{name} has commission
   or payout history, so they were paused instead of removed." (and gets the PARTNER_SUSPENDED
   notice when this call paused them);
3. otherwise **deletes** the `affiliate_profiles` row, only while it is still SUSPENDED
   (`.eq('id', …).eq('status', 'SUSPENDED')`; a resume in between answers "changed in the
   meantime"): the page and the click events cascade, the tier's `member_count` drops by
   trigger, and attributed orders keep their rows with `affiliate_id` set to NULL;
4. moves `profiles.role` from RTL back to USER (read and compared as text, the update guarded on
   RTL, so a role another admin changed is kept), resolves the partner's open lifecycle alerts
   (signed up, profile completed, payouts connected, storefront submitted:
   `AFFILIATE_REMOVAL_RESOLVED_ALERT_TYPES`; never `affiliate_payout_failed`, because the Connect
   setup alert is such a row carrying the id of the partner who hit the failure while it describes
   the platform's Stripe setup), and evicts the storefront and tier caches; the action revalidates
   the approvals, overview and tiers screens and the CMS chrome (sidebar badge), and also the
   approvals and overview screens when the removal failed after the pause.

The sign-in account stays (a customer again), and so do the Stripe Connect account and the
partner's uploaded images (`affiliates/avatars/<id>/`, `affiliates/pages/<id>/`), as the dialog
says. No email goes out for a removal. The review page runs the ledger check before rendering and
shows the button disabled with the reason while the ledger is not empty (the action checks again):
"pause them instead to keep those records", or "Keep them paused to keep those records" for a
partner who already is.

**Email.** Partner addresses live in `auth.users`, so no screen showed them before.
`loadAffiliatePartnerEmails(db, userIds)` reads them for the visible rows only (the review page,
the queue and Storefronts rows, the Overview's partner rows) through the service role's
`auth.admin.getUserById`, at most 10 at a time (as `lib/commerce/seller-contact.ts` does), keeping
only addresses the notifier would mail (`normalizeAffiliateNotificationEmail`, no reserved
placeholder domain). An account read with an unusable address maps to `null` ("No usable email");
a failed lookup leaves the id out of the map ("Email unavailable right now", never "no address":
every partner signs up with one) and is logged once per call by its code. Each address shows as a
same-tab "Email" link
(`mailto:` with the subject "Your partner storefront on {site name}"; `lib/affiliates/partner-contact.ts`
percent-encodes the address's local part, so one holding `?`, `&` or `#` cannot add a recipient
in the admin's mail client) and a Copy button. Only the review page prints the address, so
elsewhere a failed copy says "Copy failed. The review page shows the address." The site itself
sends nothing.

Neither the CMS nor the admin emails link to `/partners/<handle>`: the review page and the
SIGNED_UP / PAGE_SUBMITTED emails print it as a bare path, and the Storefronts list shows the
handle as plain text (no link, and no full URL, which mail clients would turn into a link). An
admin visit would set the referral cookie, and the admin's own test orders would earn the partner
a commission.

**Banner.** Affiliate alerts reach the global CMS banner from their own query, at most 5, and only
the actionable types (storefront submitted, payout failed, refund after a payout), so a burst of
partner activity never pushes out an update or merge-conflict alert. They are hidden while the
package is inactive. Their links must be `/cms/` paths (checked after resolving `..`), rendered
with `next/link` in the same tab; the two older alert types now need https links. The
informational types (signed up, profile completed, payouts connected) appear on the overview only.

## The storefront copilot

`POST /api/affiliates/cortex` (`runtime = 'nodejs'`, `dynamic = 'force-dynamic'`,
`maxDuration = 60`), mounted in the studio as `StorefrontCopilotPanel`. Gates, in order:

1. `requireRetailer({ allowAdmin: true })`: any refusal is one generic 403.
2. `enforceRetailerCopilotRequestQuotas({ role, userId })`: one `cortex_request_log` row for
   route `affiliates/cortex`, checked against the per-user cap (RTL 30 requests an hour, ADMIN
   300) and then the cap shared by every account (600 an hour). Both answer 429 when exceeded and
   fail closed with 503 when the log cannot be used. A request either cap refuses, or that the
   route turns away before the model call (Cortex AI off 403, invalid body 400, missing
   credentials 503, unexpected 500), is taken back out of the log (`release()`, run in the
   route's `finally`). So the shared window counts only requests that went on to a model call and
   keeps admitting about 600 an hour under sustained demand (refused attempts that stayed logged
   would hold its slots until it admitted no one).
3. Both packages active (`affiliates` and `cortex-ai`: the copilot spends the operator's Cortex
   credential), else 403.
4. A strict body read with a 128 KiB cap: 1–12 messages of `user` / `assistant`, 4000 characters
   each, the last one the partner's; `locale` `en` | `fr`; an optional selection of at most
   4000 characters.

The model gets exactly three tools (`RETAILER_COPILOT_TOOL_NAMES`), all output-only: they never
touch the database.

| Tool | Output |
| :-- | :-- |
| `generate_retailer_bio` | A bio (80–1200 characters, plain text, with the affiliate disclosure) and a meta description (70–160) |
| `generate_storefront_section` | Restricted storefront blocks from a flat, strict schema: a section title (H2) and up to 12 blocks (heading, paragraph, bullet list, callout, image, product grid). The server converts `**bold**`, `*italic*` and `[label](https://…)`, keeps only catalog product ids, resolves at most 3 stock photos per request (one budget held by the request's tool set, shared by every section call, parallel or in later steps), drafts at most 3 sections per request (a further call answers `section_limit` before any work, so it looks up no photo; a failed draft gives its slot back), and runs the sanitizer. |
| `rewrite_storefront_copy` | A rewrite of the selected text |

No Cortex admin tool, database tool, navigation or analytics tool is registered. The
instructions limit the assistant to the partner's bio, meta description, storefront sections and
selected copy, and make it politely refuse everything else: store sales, revenue, order counts,
analytics and other business figures, other customers or partners, navigation, other pages,
settings, payouts, code, and its own prompt or tools. It must not invent prices, discounts or
claims, uses only catalog product ids, writes Canadian French for `fr`, and discloses the
affiliate relationship naturally. Every value a partner or the store wrote (profile, bio, page
title, selection, catalog) reaches the prompt only inside the request's untrusted-data markers.

The catalog is up to 40 active, published products (anonymous client), the partner's language
first, one per translation group, with the regular price in the store default currency. The call
is `streamText` with `isStepCount(3)`, `toolCallConcurrency: 1` (the tool calls of a step run one
at a time, in the order the model made them), 3000 output tokens, temperature 0.5 and no
retries; at most 3 models are tried, and only while no tool has run, so a fallback never
duplicates a suggestion; each attempt gets a 30 s idle timeout and the stream a 50 s deadline.
One tool set per request (`createRetailerCopilotTools`) holds the request's budgets, and the
instructions tell the model the same limits (at most 3 sections and 3 stock photos per reply).

The response is a server-sent event stream: `status` (a 5 s heartbeat), `tool-call`,
`tool-result` (a failure is reduced to `{ ok: false, error }`, with `invalid_input`,
`empty_output`, `empty_section` or `section_limit`), `tool-error`, `text-delta` (the reply, sent
once, at most 4000 characters), `error` (`code` `timeout` or `failed`) and `finish`. It never
sends `meta`, the model id, the credential source or raw error text; missing OpenRouter
credentials answer a generic 503. The panel shows one notice per failure kind per message. It
previews a section with `StorefrontRenderer` and inserts it through the editor (sanitized
again), applies a bio to the profile form, and replaces a selection inside one paragraph,
heading or list item; the autosave writes `draft_content`. A selection across blocks, or one
holding a product grid, a photo or a divider, is refused with a notice
(`affiliates.copilot.replace_single_block`). The "Polish the selected text" quick action checks
the same thing before it sends anything (`affiliates.copilot.polish_single_block`), so no request
is spent on a rewrite that could not be applied. When the editor replaces nothing, the suggestion
stays usable (not marked done). Unsplash download pings (`maybeTriggerStockPhotoDownloads`) run in
`after()`, only for `https://api.unsplash.com/photos/` triggers of the sections the route
delivered, at most 3 per request (`MAX_UNSPLASH_DOWNLOADS` = the photo budget), so every
delivered Unsplash photo is pinged.

## Notifications

`notifyAffiliateLifecycle()` (`lib/affiliates/notify.ts`) never throws; callers defer it past
the response with `scheduleAffiliateNotification()` (an `after()` wrapper).

| Event | Raised by | Admin alert | Email to |
| :-- | :-- | :-- | :-- |
| SIGNED_UP (tier, founding spots left) | signup | yes | admins |
| PROFILE_COMPLETED | profile save | yes | admins |
| PAYOUT_CONFIGURED | Connect status (portal or payout run) | yes | admins |
| PAGE_SUBMITTED (links to `/cms/affiliates/approvals`) | submit | yes, banner | admins |
| PAYOUT_FAILED | payout run (definitive failure, retries exhausted, transfer mismatch) | yes, banner | admins |
| REFUND_AFTER_PAYOUT | the database (02030 inserts the alert) | yes, banner | admins (the refund alert sweep) |
| PAGE_PUBLISHED (share links: X, Facebook, LinkedIn, Pinterest, email) | approve | no | partner |
| CHANGES_REQUESTED (the admin's note) | request changes | no | partner |
| COMMISSION_EARNED ("You just earned {rate} ({amount}) — it clears on {date}."; the date only while it is ahead: a commission recorded after its hold passed, or a burst whose every date passed, gets "You just earned {rate} ({amount})." and a burst shows its earliest date still ahead) | the sweep | no | partner |
| PAYOUT_SENT ("Your automated payout of {amount} has been sent to your bank via Stripe."; a manual payout, 02036: "We sent you {amount} by {channel}. Reference: {reference}."; a PayPal payout, 02037: "We sent you {amount} by PayPal.", see below) | payout run; Record payout (`recordManualAffiliatePayoutNow`, after `recorded`); the PayPal step once PayPal paid the item | no | partner |
| PAYPAL_UNCLAIMED (02037: "Your PayPal payment of {amount} is waiting: claim it from the email PayPal sent to {email}, or update your payout email in the portal."; a new address applies from the next payout) | the PayPal step, the first time an item is seen UNCLAIMED | no | partner |
| PAYPAL_PAYOUT_FAILED (02037: "Your PayPal payout of {amount} could not be sent: {reason}. Check your payout email in the portal; we'll try again on the next run.", or, for a failure caused by the address, "… was not paid: {reason}. … save it again, or choose Interac e-Transfer. Until then, we pay you by hand."; the admins get PAYOUT_FAILED for the same payout, except after their own Stop payment) | the PayPal step or the CMS Stop payment, after `fail_paypal_affiliate_payout` (never for the store's own causes, such as its PayPal balance) | no | partner |
| PARTNER_SUSPENDED (the reason, as "Reason given"; storefront offline and links paused, or editing off before a first approval) | Pause partner, or a Remove partner that kept the partner (`setPartnerStatus` / `removeAffiliatePartner`, after the write) | no | partner |
| PARTNER_REACTIVATED (storefront back online and links earning again, and orders placed before the suspension and paid during it credited at the next payout run, up to 120 days old; or editing back before a first approval) | Resume partner | no | partner |
| TIER_CHANGED (the new tier, named in the partner's language, and its rate; "The new rate applies to orders paid after this change. Commissions already recorded keep their rate.", like the terms: the rate changes at the move, not at the start of that day) | Change tier with "Email the partner" ticked, after a real move (`changeAffiliatePartnerTier`) | no | partner |

- **Pause notices:** sent only when the status really changes (a reason edited on a partner who
  stays paused sends nothing). Both use the portal's words (the account is "suspended", the
  storefront and links "paused") and `storefrontLive` (the partner has `first_published_at`) to
  pick their wording. A removal sends nothing. Like every partner event, they mail nobody on the
  sandbox.
- **Manual payouts (02036):** PAYOUT_SENT carries `payout.method`, `channel`, `reference` and
  `note` (`AffiliateEmailData.payoutMethod` / `payoutChannel` / `payoutReference` /
  `payoutNote`). The manual variant reads "We sent you {amount}" (subject), "Your payout was sent",
  "We sent you {amount} by {channel}. Reference: {reference}." (without a reference, or an amount,
  the shorter `manual_line_no_reference` / `manual_line_generic`), a timing line ("Depending on the
  service, the money can take a few business days to reach you. Contact us if it has not arrived
  by then."), the amount and the reference as detail rows, the admin's note under "Note from our
  team", and the "View your payouts" button (the portal's payouts page); the channel is a phrase
  per language (`payout_sent.channel_*`: "Interac e-Transfer" / "virement
  Interac", "bank transfer" / "virement bancaire", "another payment method" for `other`), never
  the raw code. COMMISSION_EARNED explains how the money will come: a commission on a gateway paid
  manually gets `commission_earned.explain_manual` ("…then paid to you directly (by PayPal,
  Interac e-Transfer or bank transfer) and recorded in your partner portal."), and the sweep groups
  commissions by payout method as well as partner, currency and rate
  (`affiliatePayoutMethodForGateway` with the lenient settings read). The admin
  REFUND_AFTER_PAYOUT email and the alert built in TypeScript say "Recover the amount from the
  partner, for example by asking them to send it back." after a recorded manual payout and, while
  the manual payout is only prepared (`payoutPrepared`), "Its manual payout is prepared but not
  recorded yet: if you have not sent it, cancel it under Pay manually and prepare it again; if you
  already sent it, record it, then recover the amount from the partner, for example by asking them
  to send it back." (the refund alert payload reads the payout's `method` and `status`; the
  database alert's metadata carries `payout_status`), like the database's own alert. Nothing
  deducts a refund from a later payout: a manual payout records exactly the amount it reserved, so a
  deduction would make the record, this email and the portal show money the partner never received.
  PROFILE_COMPLETED says "Their next step is setting up their payouts." (a payout email, when they
  are paid by hand), never Stripe.
- **PayPal payouts (02037):** `dispatchAffiliatePayPalPayoutEvent` (`paypal/events.ts`) schedules
  them. PAYOUT_SENT of a PayPal payout carries `method: 'paypal'` and PayPal's transaction id
  (`AffiliateEmailData.payoutMethod = 'paypal'`, `payoutReference`): "We sent you {amount} by PayPal"
  (subject), "Your PayPal payout arrived", "We sent you {amount} by PayPal.", "The money is in your
  PayPal account now." (it is sent only once PayPal reports the item SUCCESS), the amount and
  "PayPal transaction" detail rows. PAYPAL_UNCLAIMED and PAYPAL_PAYOUT_FAILED are partner events
  (`AffiliateRetailerLifecycleEvent`, no alert, the payouts page as their button). PAYPAL_UNCLAIMED
  carries the payout's `paypal_receiver` (`payout.receiver` → `AffiliateEmailData.payoutEmail`) and
  adds "PayPal keeps an unclaimed payment for 30 days, then returns it to us. A new payout email is
  used from your next payout: once this one comes back, the amount goes back to your balance and is
  sent to your new address." (a new address never redirects the waiting payment); without the
  address it says "the email PayPal sent you". PAYPAL_PAYOUT_FAILED carries the run's reason code
  (`payout.reason`, e.g. `paypal_returned`, `paypal_failed:receiver_unregistered`), which the template
  words per locale and never prints (`affiliatePayPalFailureReasonKey`: "nobody claimed it within 30
  days", "this email has no PayPal account", "PayPal could not pay this account", "it was cancelled
  before it was claimed", "PayPal blocked it", else "PayPal could not complete it"), then "The amount
  is back in your balance." A failure caused by the address (`isAffiliatePayPalReceiverFailureReason`,
  the run's own rule: returned, blocked, refunded, reversed, cancelled, refused for the receiver) reads
  "Your PayPal payout of {amount} was not paid: {reason}. In the portal, check that your payout email
  is the email of your PayPal account and save it again, or choose Interac e-Transfer. Until then, we
  pay you by hand." (`paypal_payout_failed.line_receiver`): the run does not try PayPal at that address
  again until the partner saves it. Only the other failures keep "Check your payout email in the
  portal; we'll try again on the next run." The partner is also mailed when an admin stopped their
  unclaimed payout (the admins are not: they did it). COMMISSION_EARNED for a commission the program
  pays with PayPal keeps the manual explanation.
- **Tier notices** are opt-in: Change tier sends TIER_CHANGED only when the admin ticks "Email the
  partner" and the move really happened (not for an unchanged tier or a refusal). The payload
  carries the tier name already localized (`affiliateTierDisplayName` with the partner's
  `preferred_locale`) and `tierRatePercent`; the button opens the portal overview.
- **Admin recipients:** `affiliates_settings.notificationEmails`, else the store contact address
  ladder (`resolveSellerContactEmail()`). Admin emails are English. Partner emails go to the
  partner's sign-in address in their `preferred_locale` (English or Québec French).
- **Templates:** `buildAffiliateEmail()` and `buildAffiliateSystemAlert()` in the lib
  (`src/lib/notifications/`): every value escaped, one-line subjects of at most 150 characters,
  a table layout with the `{{brand_header}}` token that `sendEmail()` replaces, the button URL
  also printed as text, and buttons limited to the event's own screen on the site's origin. Admin
  emails never carry a storefront link or full URL (the address appears as a bare path), so an
  admin's click cannot set a partner's referral cookie. The email copy is an internal dictionary,
  not seeded into `translations`; its French gets the same no-break spaces as the UI
  (`applyAffiliatesFrenchTypography`, see "i18n").
- **Dedupe:** an unresolved alert with the same key is reused (the payout for PAYOUT_FAILED, the
  partner for the one-time onboarding steps; PAGE_SUBMITTED closes the page's older submission
  alerts), and each alert is emailed at most once (`metadata.emailed_at`). PAGE_SUBMITTED alerts
  and emails are bounded by the resubmission cooldown (one per page per 10 minutes without an
  admin decision in between), and a withdraw resolves the page's alert, so at most one unresolved
  PAGE_SUBMITTED alert exists per page.
- **The sweep:** `sweepAffiliateCommissionNotifications()` claims commissions through
  `claim_affiliate_commission_notifications` (atomic, so overlapping sweeps never double-send)
  and sends one email per partner, currency and rate. Commissions older than 14 days are claimed
  without an email. It runs after paid or refund webhooks, on the checkout success page, and in
  every payout cycle, only while the package is active.
- **Refund alerts:** the database raises `affiliate_refund_after_payout` on paths that never call
  the notifier (the webhooks, the CMS order status actions, an order delete), so
  `sweepAffiliateRefundAlertEmails()` emails the admins about every unresolved one not yet mailed.
  It claims an alert first (`metadata.email_claimed_at`, compare-and-set, lapses after 15
  minutes so a failed send is retried) and stamps `metadata.emailed_at` after the send. Alerts
  older than 14 days are left to the banner. It runs with the commission sweep (after the payment
  webhooks and on the checkout success page) and in every payout cycle, so an alert raised by a
  CMS status change or an order delete is mailed by the next cycle at the latest.
- **Mail only with a real address:** nothing is sent when the site address is the invented
  default (set `NEXT_PUBLIC_URL`), except in development. Emails need SMTP
  (`app/actions/email.ts`, DB-first settings).
- **No mail on the sandbox:** `createNotifyContext()` records every alert there but sets
  `canSendEmail` off. Its admin login is public, so its notification addresses (up to 10) are
  whatever a visitor typed, and each submit or review round would mail all of them.

The daily insufficient-balance alert is an `affiliate_payout_failed` row without an email; it
advises keeping a minimum balance in Stripe or switching Stripe payouts to manual (Freemius sales
never fund the balance), links the Stripe payouts screen, and ends "The next automatic payout run
tries again." only while automatic payouts are on ("Automatic payouts are off: run payouts again
once the balance is funded." otherwise). The Connect setup alert (`metadata.kind =
'connect_setup'`, one a day, see "Stripe Connect Express") is the same kind of row; the Overview
activity feed labels both by kind and links the Stripe payouts screen. The admin "payout failed"
email (`payout_failed.advice`) gives the same balance advice, then says to retry or release the
payout once the cause is fixed: it promises no automatic retry, because a low-balance failure is
mailed only once its automatic retries are used up.

## The public pages

### `/partners` and `/partenaires`

While the package is active the layout mounts `AffiliatesCopyProvider` with the operator's
overrides for the common, partners and storefront areas; while it is off the layout is a
pass-through and the route renders the CMS page `partners` (404 when there is none). The page:
one h1 ("Earn up to X%…", the best rate a new partner can still get: it counts the standard tiers
and the signup tier, never a promo tier signups cannot get because it is sold out or ranked
behind another default tier), the launch-offer badge, the tier ladder (a decorative locked slider
hidden from screen readers, repeated as text), the revenue calculator (monthly referrals 1–100
and an average order value, comparing the launch-offer rate with the base tier, or the signup
tier with the base tier when there is no offer, in the store base currency), how it works,
benefits, the FAQ, and the signup form. The badge names the promo tier by its current localized
name with the spots left ("Only 49 Founding Ambassador Spots Left!" / "il ne reste que 49 places
au niveau Ambassadeur fondateur!"), so a renamed tier is never contradicted. It shows only while
the promo tier is the tier a new signup gets: it has room and no other default tier ranks ahead
of it.

Since 2026-11-10 the page also carries:

- **The hero's example card** (`_components/partners-hero-visual.tsx`, a server component).
  It shows the calculator's starting point worked out: its default monthly sales (10) times its
  default order value at the rate a signup gets. That is "$1,250 a month" for 10 sales of a $250
  license at 50%. Around it:
  - six bars of growth;
  - a short example ledger (pending, cleared, paid) built from the store's own products and
    commissions;
  - the promo tier's spots meter (a native `<progress>`);
  - "An example, not a promise."

  It animates with CSS only (tailwindcss-animate `animate-in`, every class behind
  `motion-safe:`), so it renders its final state without JavaScript and never flashes on
  hydration. The rolling digits are drawn with `content: attr(data-digit)`, so the page text
  (what crawlers and the SEO grade read) holds the amount once. The amount is repeated as
  `sr-only` text, and the card is a `<figure>`, never an `<aside>` (the sandbox guide is the
  page's only aside).
- **A "Goal" line on each tier card** (`affiliate_tiers.goal`, 02033) and, when any tier has a
  goal, a note under the ladder: goals count confirmed sales only, and the team reviews every
  move up. Nothing promotes a partner automatically.
- **A product picker in the calculator** ("What your referrals buy", `lib/affiliates/partners-showcase.ts`):
  - It lists the store's three priciest active, published products in the visitor's language,
    plus "All 3 together".
  - A Freemius license is priced from its plan's entry tier: the yearly price, with the monthly
    price beside it. Any other product shows its current price.
  - The order value slider starts at the priciest product and reaches the products' sum.
  - On a first view from below the fold, the sliders sweep up to their starting values, and a
    pick glides the order value to its price. Both stop when the visitor drags, and both are
    skipped with `prefers-reduced-motion`.
  - The results lead with the monthly income, then the yearly one.
  - The note says estimates use yearly prices and that only an order's first payment earns.
- **Six benefits** (the sixth: your own storefront page), a closing call-to-action band above the
  FAQ, and three checks under the hero buttons.

**Payout wording.** Since 02036 a store may pay some commissions by hand (PayPal, Interac
e-Transfer), so nothing on the page, or in its meta description, says payouts go through Stripe or
come automatically: the description ends "…get paid once your commissions clear." (FR "…et recevez
vos versements."), the hero subtitle "We track each sale and pay your commissions.", the third hero
check and the benefit "Payouts come to you" ("Payouts sent by our team" while automatic payouts are
off; the key keeps its name `hero_point_payouts_stripe`), the how-it-works step "Set up your
payouts" / "Tell us once where to send your money. After that, your payouts come to you.", the FAQ
"…a way to receive your payouts." and "…We send your payout once your cleared balance reaches the
minimum. Your partner portal shows how you get paid." The wording holds in every setup, so the page
reads no payout method from the settings (the partner terms do). 02036 rewords these rows in place,
guarded by the 02031 text; `partners-route.test.tsx` fails on "Stripe" or "automati…" in the page or
the description, in English and French, with and without manual payouts.

The landing page has two addresses and one implementation (`_components/partners-route.tsx`):
`/partners` speaks the visitor's language (cookie, then detection), and `/partenaires` is always
French. `proxy.ts` pins `X-User-Locale` to the active French code on that path and every path
below it (`isFrenchPartnersPath`, so `/partenaires/conditions` too, never `/partenairesx`;
`frenchPartnersLocale`), so the root layout, the copy provider and the page all render French.
The language cookie is left alone (a prefetch never switches anyone's language); a real visit
persists French through `LanguageProvider`, as any French page does. While French is not an
active language, `/partenaires` serves the CMS page `partenaires` instead (404 when none). Each
address declares the canonical URL of the language it rendered in (`/partners` rendered in
French declares `/partenaires`), hreflang `en` / `fr` / `x-default` (`x-default` = `/partners`)
while both exist, and uses that URL for `og:url` and the JSON-LD `url`; `og:locale` follows the
copy language. The signup form's sign-in and two-factor links return to the address that was
served. The landing root carries `lang="<copy language>"`, which can differ from `<html lang>`
(a site language the copy does not cover, or a client-side navigation to `/partenaires`). The
language switcher goes to the other address (`CurrentContentSetter localePaths`). Storefronts
keep the single `/partners/<handle>` address; the storefront's join link points at
`/partenaires` for a French visitor.

Signup (`submitPartnerSignup`, a public server action backed by `lib/affiliates/signup.ts`)
checks, in order: package → bot protection (honeypot plus Turnstile / reCAPTCHA) → handle shape →
the visitor's own session (a signed-in customer is upgraded without a new auth user; staff are
refused; a pending second factor is refused; an existing partner gets "already a partner") →
5 partner accounts per hour per masked /24 or /48 → handle pre-check → a tier with room (a full
program is refused, `program_full`, before any auth user exists). The masker is the referral
fingerprint's (`maskAffiliateVisitorIp`): `203.0.113.0/24` or `2001:db8:85a3::/48`, an
IPv4-mapped IPv6 address counts as IPv4, and ports and brackets are dropped.
`x-vercel-forwarded-for` is trusted only on Vercel (`VERCEL=1`); elsewhere the proxy's
`X-Real-IP` comes first, then the first `X-Forwarded-For` hop.

The partner account (tier seat, handle, page, SIGNED_UP) is created at once
(`create_affiliate_account`, with the starter page in the visitor's language) only when the
visitor has a session: a signed-in customer, an auto-accepted signup, or a project without email
confirmation. Otherwise only the auth user is created, exactly like `signUpAction`, with the
handle kept in its `user_metadata.affiliate_handle`. The confirmation link
(`/auth/callback?redirect_to=/partners`) lands on `/partners`, where the upgrade form is
prefilled with that handle (normalized; a prefill only, the RPC validates the submitted handle
again) and "Become a partner" creates the account under the new session. An unconfirmed signup
never holds a seat or a handle. On the auto-accept and session paths, an auth user created in
that request is deleted again when the RPC refuses. An account that already existed is never
attached from an anonymous request and gets the same "check your email" answer (no enumeration).
Success schedules SIGNED_UP, evicts the tier cache, and sends a visitor with a session to
`/portal/retailer?welcome=1`. The handle check allows 40 checks per 5 minutes per address (per
process).

The form's required terms checkbox links the terms it accepts: "I accept the {terms}. …"
(`affiliates.partners.signup_terms_accept`, a new key: the earlier `signup_terms_label` was seeded
without `{terms}`, and that older row would read as an operator override) is split at `{terms}` by
`splitAffiliatesCopyAtPlaceholder` (copy stays plain text; React renders the link), and
`affiliates.partners.signup_terms_link` is the link text. The link (`PartnerTermsLink`) opens in
a new tab with an aria-hidden external-link icon and a screen-reader "(opens in a new tab)": a
`next/link` without prefetch for the built-in terms, a plain anchor with `rel="noopener noreferrer"`
for the operator's https page, and plain text for anything else. `termsHref` is computed on the
server (`partnersTermsHref`): the operator's page for the language the page rendered in (French
falling back to English), else `/partners/terms` or `/partenaires/conditions`. An override that
drops `{terms}` gets the link after its text.

### `/partners/terms` and `/partenaires/conditions`

The built-in partner terms, one implementation (`_components/partners-terms-route.tsx`, view in
`partners-terms-view.tsx`) at two addresses like the landing page: `/partners/terms` in the
visitor's language, `/partenaires/conditions` always French (the proxy pin above). 404 while the
program is inactive (no CMS fallback), and on the French address while French is not active.
`dynamic = 'force-dynamic'`, never `fetchCache`. Metadata: title and description from the copy, a
canonical per rendered language, hreflang `en` / `fr` / `x-default` while both exist and neither
language has the operator's own page (the sitemap's rule: an alternate that redirects away is
ignored by search engines; a French page alone counts, since the French address then redirects),
social metadata through `buildSocialMetadata`. No JSON-LD and no HTML sink: everything is React
text. The language switcher goes to the other address (`CurrentContentSetter localePaths`). The
Program details table sits in a named, focusable scroll region (`role="region"`, the caption as
`aria-label`, `tabIndex={0}`, the portal's `TableFrame` pattern): it scrolls sideways on a phone and
holds no focusable element.

- **The clauses** are the `affiliates.terms.*` area (one key per heading, paragraph or list item),
  written to say what the code does: who runs the program, free to join, review before
  publication and again after edits, attribution (referral link or storefront within the tier's
  window, a storefront add first, else the last link; nothing for a declined marketing consent or
  a self-referral), the base (after discounts, without tax or shipping), first payment only,
  conversion at the order's rate, a rate change only for orders paid after it, the hold, disputes on
  hold, refunds and lost disputes, recovery after a payout (a Stripe transfer reversal, asking the
  partner to send it back, or a deduction from a later payout), payouts into a Stripe account
  (Stripe Connect Express), into the partner's PayPal account with PayPal Payouts, or sent directly
  by the operator (for example PayPal or Interac e-Transfer) depending on the sale (02036, 02037:
  the Stripe setup for the first, a payout email in the portal with PayPal or Interac e-Transfer
  chosen for the others; a PayPal payout to an address without a confirmed PayPal account waits to be
  claimed for a limited time, then comes back to the balance; Interac e-Transfers are sent by hand;
  the PayPal account is PayPal's own agreement), in the store currency above the minimum on the
  operator's schedule (late when a payment service is down or the Stripe or PayPal balance is too
  low), taxes,
  disclosure, what is forbidden, the content licence, suspension (storefront offline, no new
  commissions or payouts, the balance kept and paid after reactivation, records kept, portal still
  readable; "suspended" in English too, the partner-facing word of the portal and the
  PARTNER_SUSPENDED email, while "Pause" stays the CMS button; the keys keep `pause_`), leaving
  (contact the operator; no self-service deletion), changes, governing law ("the laws of the place
  where {company} is established"), privacy (what Connect onboarding sends Stripe: the email, the
  country and the storefront address, `business_profile.url`; and, for a payout sent directly, the
  payout email, the amount and the handle the CMS PayPal payouts file hands the payment service) and
  contact. They hold no numbers
  (`dictionary.test.ts` checks). `{company}` is the legal name from CMS → Settings → Privacy, else
  the site title.
- **"Last updated"** is `AFFILIATE_TERMS_VERSION` (`core/constants.ts`, `2026-11-11`: the rate
  clause now says "orders paid after the change", seeded by 02035; the payout and recovery clauses
  of 02036 and the PayPal clauses of 02037 date from the same day, so the version stayed), formatted
  per language in a `<time>`. Move it whenever the meaning of a clause changes.
- **Program details** (live): every active tier (localized name, commission, referral window and
  hold, in days with French singular for 0 and 1), the store currency, the minimum payout
  (`formatAffiliateMoney` in the store base currency), the payout method and the schedule. The
  method comes from the public projection's `payoutMethods` (02036; the route projects nothing
  else private): one "Payout method" row, "Transfer to your Stripe account (Stripe Connect
  Express)", "Sent to your PayPal account by PayPal Payouts, or by Interac e-Transfer if you choose
  it" (02037) or "Sent directly by us, for example by PayPal or Interac e-Transfer", when every sale
  is paid the same way, else one row per kind of sale ("Payout method, orders paid through Stripe"
  / "…through Freemius"). The schedule follows the pair of methods (`PAYOUT_SCHEDULE_KEYS`, the
  daily switch sending both Stripe transfers and PayPal payouts): "Automatic, every day" / "When we
  run them" for Stripe transfers only; "When we send them" when every sale is paid by hand; "Stripe
  transfers: automatic, every day. Direct payouts: when we send them." (or "…when we run them. …")
  for Stripe and by hand; "PayPal payouts: automatic, every day. Interac e-Transfers: when we send
  them." for PayPal only; "Stripe transfers and PayPal payouts: automatic, every day. Interac
  e-Transfers: when we send them." for Stripe and PayPal; "PayPal payouts: automatic, every day.
  Direct payouts: when we send them." for PayPal and by hand (each "…when we run them…" while the
  switch is off). When the settings cannot be read, the minimum, the method and the schedule are all
  left out rather than guessed.
- **Privacy** links the privacy policy the way the consent banner resolves it: the site
  translation `privacy.consent.privacy_policy_href` for the page's language (a site path or an
  https URL), else `/privacy-policy` / `/politique-de-confidentialite`.
- **Contact** shows the privacy address the `{{privacy_email}}` merge tag would use
  (`resolvePrivacyEmail` on the privacy settings' support email) as a `mailto:` link. The section
  is left out when there is none: no address, a malformed one, or the `privacy@example.com`
  placeholder (any RFC 2606 `example.com/.net/.org` address), which is the default on a fresh
  install; the CMS program settings then say so next to the terms fields. One rule for both:
  `lib/affiliates/terms-identity.ts`.
- **The operator's own page**: when the program settings name one for the rendered language
  (French falling back to English), both the page and its metadata redirect there (307). The one
  exception is the CMS preview: `?builtin` (any value) from a signed-in ADMIN whose second factor
  is satisfied (`getCmsActor()`, read only when a redirect would otherwise happen) renders the
  built-in terms with `robots: noindex, nofollow`; everyone else, a WRITER included, is redirected,
  so the replaced template (which names the operator as a party) stays off the public web. A target
  that leads back to a built-in terms address is never followed, however it is spelled
  (`//`, `.` / `..`, ASCII escapes, as a path or an https URL on the canonical host or the
  request's host, `www.` ignored: `isBuiltInPartnersTermsTarget`), which would loop. The settings
  come from `getPublicAffiliatesProgramSettings()` (`unstable_cache`, 5 minutes, tag
  `public-affiliate-program-settings`), already canonical (percent-encoded ASCII), and
  `partners-paths.ts` hands out nothing but printable ASCII as a last check; it carries no override
  on the sandbox, so nothing redirects there.

The partner portal links the same terms from the payouts page FAQ ("Where are the program
rules?", `affiliates.portal.faq_terms_question` / `faq_terms_link`, new tab).

### `/partners/<handle>`

404 while the package is off (checked before the lowercase redirect) or nothing is approved; a
mixed-case handle gets a 308 to lowercase. The page renders only the approved snapshot
(`get_affiliate_storefront`, cached 300 s), sanitized again at read time with this deployment's
image origins. The header shows the avatar (from the server-set key only), the display name as
the only h1, the localized tier badge, the bio, social links (`rel="nofollow ugc noopener
noreferrer"`) and the affiliate disclosure. Each product grid is the shop's `ProductGrid` with
the signed token and the handle; featured products follow, without those a grid already shows;
product sections render only while the ecommerce package is active. The heading outline is
normalized under the h1 (an h3 before any h2 renders as an h2; an untitled grid gets a visually
hidden h2; a heading without visible text is skipped and never counts as the page's h2).

The partner's text is marked with the snapshot's language where it differs from the page's
(WCAG 3.1.2): `lang` on the bio and on the document, while the shop's product cards inside the
document carry the visitor's `lang` (the catalog is loaded in the visitor's language), and the
chrome (labels, disclosure, featured products) follows the visitor. JSON-LD `inLanguage` and
`og:locale` declare the snapshot's language.

The Open Graph card (`opengraph-image.tsx`, 1200 × 630) shows the name, address, tier, a tagline
and the site name; the tier name and tagline use the snapshot's language (the site language for a
snapshot without one). The avatar is fetched only from this deployment's media origin: no
redirects, a 5 s timeout, at most 2 MB, PNG or JPEG only (content type and file signature), else
initials. Its alt text (`og:image:alt`, and `twitter:image:alt` through Next's Twitter fallback)
is the social title (the page title with the site name, as `og:title`), from the file's
`generateImageMetadata` (one entry, id `card`, so the card URL is
`/partners/<handle>/opengraph-image-<hash>/card`). No card is named when nothing is published; a
failed storefront read throws (a 5xx), never "no card". Under `next dev` that card URL resolves
to the app's not-found page (dev never compiles the `[__metadata_id__]` route, even with a clean
`.next/dev`); production builds serve it (checked on a local build: 200, `image/png`,
`public, max-age=0, must-revalidate`, and a profile change shows on the next request).

### SEO and performance

- `/partners` and `/partenaires`: localized title (≤ 60 characters) and description (70–160), a
  canonical per rendered language and hreflang `en` / `fr` / `x-default`, social images from
  `buildSocialMetadata`, WebPage and FAQPage JSON-LD with the CSP nonce. The sitemap lists both
  addresses with reciprocal `xhtml:link` alternates (`lib/affiliates/partners-paths.ts`:
  `buildPartnersLocalePaths`, `partnersHreflangPaths`). `partners-seo.test.tsx` renders the real
  page and asserts a score of 100 on the SEO engine, in English and French, with the offer and
  with the spots sold out (the signup checkbox's terms link included).
- `/partners/terms` and `/partenaires/conditions`: listed by the sitemap under the same gate, with
  reciprocal alternates while both are listed and `AFFILIATE_TERMS_VERSION` as `lastmod`
  (`buildPartnersTermsLocalePaths`). An address the operator's own page replaces (it redirects)
  is left out.
- While the package is active the sitemap drops CMS page entries at the addresses the program
  answers and strips them from other translations' alternates (`excludeCodeRoutePaths`,
  `app/lib/sitemap-utils.ts`); while it is inactive they stay (the CMS page is served there).
- Storefronts: metadata without image keys (the card comes from `opengraph-image.tsx`, with
  `og:image:alt` set from the social title), `twitter.card = summary_large_image`, `metadataBase`
  set, ProfilePage JSON-LD, and the sitemap lists every live storefront with its last approval as
  `lastmod`.
- Every partner route is `dynamic = 'force-dynamic'` (CSP nonce, locale, a fresh token per
  render) with its reads in `unstable_cache` (300 s, tags `public-affiliate-storefronts` and
  `public-affiliate-tiers`) inside React `cache()`. Never add `fetchCache`. Writers evict with
  `evictAffiliateStorefrontCache` / `evictAffiliateTiersCache` (`updateTag` in server actions,
  `revalidateTag(tag, { expire: 0 })` in routes and jobs): approval, request changes, suspension,
  reactivation, tier changes, signup, deleting a partner's user in `/cms/users` and the sandbox
  reset; never a submission or a withdrawal, which change nothing public.
  `evictAffiliateTiersCache` evicts both landing addresses. No `backdrop-blur` in heroes.
- The `/partners` islands import from the root entry; the package's `sideEffects` list keeps the
  storefront renderer and sanitizer out of that page's JavaScript.
- Only the first product grid of a storefront loads its first row of images eagerly
  (`ProductGrid`'s `eagerFirstRow`; the featured section only when the page has no grid), so
  images below the fold never compete with the first paint.
- In-app links to a storefront use `prefetch={false}`.

## i18n

Every string on `/partners`, the storefront, the portal, the editor and the copilot panel comes
from the lib's dictionaries (`src/lib/i18n/copy/<area>.ts`, areas `common`, `partners`,
`storefront`, `portal`, `editor`, `copilot`, `sandbox`, `terms`: the built-in partner terms, server
rendered only). Keys are `affiliates.<area>.<name>`,
each `{ en, fr }`; Québec French; `…`, never `...`; each `{placeholder}` at most once per
string; a space before `:` and `%` in French. That space is written as a plain space in the
dictionaries, the 02031 seed and CMS edits (the seed generator refuses invisible characters).
`createAffiliatesCopy` renders it as a no-break space (U+00A0, what `Intl` fr-CA writes in
`50 %`) before `:`, `%` and `»` and after `«` (`applyAffiliatesFrenchTypography`). It applies the
rule before interpolation, so inserted values are untouched; the partner emails apply the same
rule. `src/lib/i18n/dictionary.test.ts` lints every area file (raw French keeps a plain space;
rendered French has no breakable space before `:`, `%` or `»`, or after `«`), and the portal and
copilot tests fail on a key that is used but missing, or defined but unused.

- **Client:** a layout mounts `AffiliatesCopyProvider({ locale, overrides })`; an island calls
  `useAffiliatesCopy(<its own area dictionary>)` → `{ t, locale }`. Islands never import the
  merged `AFFILIATES_COPY`, so a client chunk carries only its own strings.
- **Server:** `createAffiliatesCopy({ locale, dictionary, overrides })`, or
  `getServerAffiliatesCopy()` in the app. Resolution: the override for the locale → the French
  dictionary string for `fr` → an English override → the English string → the key.
- **Overrides:** operators edit the strings in the CMS translations screen like any other key.
  `getAffiliateCopyOverrides()` reads the affiliates-only cached entry
  (`getRequestCachedAffiliateTranslations`), loads only the rows of the areas a layout renders,
  keeps the request locale, and drops rows that merely repeat the shipped string.
- **The root payload:** ordinary pages never carry the portal's strings. The root layout never
  reads them: `getCachedTranslations` (`lib/i18n/cached-translations.ts`) selects every key
  except `affiliates.%`, and `excludeAffiliateTranslationRows`
  (`lib/i18n/affiliate-translation-rows.ts`) stays as a second filter before
  `compactTranslationsForLocale`. The partner pages read the `affiliates.%` rows through their own
  cached entry (`getCachedAffiliateTranslations`), under the same `public-layout-translations`
  tag, so a CMS translation edit evicts both. Both reads page through PostgREST's 1000-row cap
  (`readAllTranslationRows`, `lib/i18n/translation-pages.ts`): 02031 takes a fresh install to
  about 1,100 rows, and a single read silently lost the keys that sort last (raw `sign_in`,
  `sign_up` and `theme_switcher` on every page). A failed read throws, so the cache keeps its last good rows
  instead of caching an empty list.
- **Seed:** `02031_affiliates_ui_translations.sql` seeds `AFFILIATES_COPY` (EN + FR,
  `ON CONFLICT (key) DO NOTHING`), generated from the merged dictionary.
  - It also seeds the site-wide keys of `AFFILIATE_GLOBAL_TRANSLATIONS`
    (`lib/i18n/global-affiliate-keys.ts`):
    - the auth surfaces (`partner_portal`, `unauthorized.retailer_only`,
      `unauthorized.retailer_suspended`);
    - the sandbox demo strings;
    - the header and footer badge `nav.badge_new` ("New" / "Nouveau").
  - Their components pass EN / FR fallbacks to their label helper, so they render before the seed
    too.
  - The email copy and the CMS screens are not seeded.
  - Copy whose wording changed got a new key rather than new text under the old key, because an
    older 02031 row that differs from the dictionary reads as an operator override:
    `calculator_intro_monthly`, `calculator_summary_monthly` and
    `calculator_summary_single_monthly`; `signup_terms_accept` (was `signup_terms_label`, seeded
    without `{terms}`).
  - Once 02031 may have run, copy changes ship in a forward migration in the forms its header
    prescribes (`translations-migration.test.ts` replays them). 02035 adds
    `affiliates.portal.overview_tier_since` (`INSERT … ON CONFLICT (key) DO NOTHING`) and rewords
    `affiliates.terms.earning_rate_changes` in place, one `UPDATE … FROM (VALUES …)` per language
    guarded by the exact text 02031 seeded, so a clause an operator edited stays theirs. 02036
    (section 7) does the same for manual payouts: 48 new keys (the portal's "How you get paid"
    card, payout email form, manual figures, the "being sent" lines of a prepared payout, Payout
    column and history rows; the terms' direct
    payout and privacy clauses and Program details rows) and 21 reworded rows, each language
    guarded by its 02031 text (the landing page's payout lines, the payout and recovery clauses,
    the terms description, the onboarding step, its link, the welcome banner, the overview's
    cleared line and "Nothing to pay out yet"). 02037 (section 7) does it for PayPal Payouts: 40 new
    keys (the portal's PayPal or Interac e-Transfer choice and its labels, the confirmation and its
    mismatch message, the PayPal card line and returned notice, the PayPal figure, cleared and
    in-flight lines, the PayPal description and FAQ answer, the "PayPal · {status}" history rows; the
    terms' PayPal, Interac and PayPal agreement clauses and the PayPal Program details rows) and 6
    reworded rows, each language guarded by the text 02036 seeded (`payout_email_label` and
    `payout_email_help`, which became the choice's question and the PayPal warning, and the
    `payouts_stripe`, `payouts_direct`, `payouts_schedule` and `refunds_after_payout` clauses). The
    landing page needed nothing: its payout lines name no payment service.
- **Locale:** `getRequestLocale()` follows the root layout: `x-user-locale` → `NEXT_USER_LOCALE`
  → `NEXT_LOCALE` → Accept-Language → the default language → `en`, each checked against the
  active languages. `fr*` maps to French, everything else to English. `/partenaires` and every
  path below it (`/partenaires/conditions`) pin French in the proxy (`isFrenchPartnersPath` in
  `lib/affiliates/partners-paths.ts`, import-free like `referral-cookie.ts`;
  `partners-paths.test.ts` fails when its mirrors of `AFFILIATE_PARTNERS_PATH` /
  `AFFILIATE_PARTNERS_PATH_FR` / `AFFILIATE_PARTNERS_TERMS_PATH` / `AFFILIATE_PARTNERS_TERMS_PATH_FR`
  drift). `getActiveRequestLanguages()` (`request-locale.ts`) is the
  cached language list the canonical, hreflang and sitemap use.
- **Language switcher:** it looks a path up as a CMS document only for `/<slug>`,
  `/article/<slug>` and `/product/<slug>` (`contentLookupForPath`,
  `components/language-switcher-path.ts`); storefronts, the portal, checkout and every other code
  route refresh in place, so a storefront handle is never read as a page slug. A code route with
  its own address per language declares it with `CurrentContentSetter localePaths` (the landing
  page does), and `CurrentContent.localePaths` wins over the slug lookup.

## Sandbox demo

The public sandbox (`NEXT_PUBLIC_IS_SANDBOX=true`, reset every 15 minutes) seeds two demo partners
when `FREEMIUS_AFFILIATES_SANDBOX_KEY` is set on the deployment. The program runs there only
while `FREEMIUS_ECOMMERCE_SANDBOX_KEY` is set as well (Affiliates is a Commerce Pro add-on):

- Partner portal: sign in as **partner@nextblock.dev** / **password** (the sandbox sign-in and
  sign-up pages list it while the Affiliates package is active there:
  `shouldShowSandboxDemoPartner()` in `lib/affiliates/sandbox-demo-partner.ts`; `/sign-in` is a
  server page around the client `SignInForm.tsx`, like `/sign-up`).
- Storefront: **`/partners/studio-nova`** ("Studio Nova", a Founding Ambassador).
- Second storefront: **`/partners/atelier-boreal`** ("Atelier Boréal", a Growth Partner, in
  French). An edit of it waits in `/cms/affiliates/approvals`; its login is never shown.

After the reset SQL has committed, the reset route activates the package
(`activateSandboxPackage`) and calls `seedSandboxAffiliateDemo()`
(`app/api/cron/reset-sandbox/affiliate-demo.ts`) right after the store data, in a transaction of
its own: inside the one-transaction replay the `RTL` label is not committed yet. Then it evicts
both storefronts' cached reads. Neither partner is a preserved user, so every reset deletes both
accounts and recreates them. The seed is idempotent and non-fatal (a failure is logged and rolled
back), and Atelier Boréal seeds inside a savepoint: a failure in its own writes rolls back only its
rows, never Studio Nova's.

Studio Nova's storefront shows three of the seeded apparel products. Its ledger is written
directly on orders bought by the demo admin:

- one paid commission on a completed payout (placeholder transfer id), one cleared and one
  pending;
- one cleared commission held by a FAILED payout (`balance_insufficient`, 5 attempts, the last 78
  hours ago, as the daily retries would leave it) on an order the seed owns, with the unresolved
  `affiliate_payout_failed` alert the payout runner would raise. Retry and Release show on
  `/cms/affiliates/payouts`; both answer `sandbox` there;
- one unpaid storefront order credited to Studio Nova: marking it paid in `/cms/orders` makes the
  order trigger record its commission, and deducts its stock until the next reset.

The statement that attributes an order also back-dates it to its commission (one non-null
`paid_at` to another, so the trigger takes neither branch). Every demo order, commission and
payout is in live mode, which is also how the SQL treats a sale whose key mode checkout could not
tell (checkout itself is refused on the sandbox).

Atelier Boréal signs in with a reserved `@example.com` address and a random password. Its page
keeps the version approved 16 days ago live while an edited draft and bio wait for review, with
its `affiliate_signed_up` and `affiliate_page_submitted` alerts. It is skipped, with a warning,
when its account cannot be created or its tier is missing, inactive or full. Every row is marked
notified or mailed, so no sweep emails anyone. Stripe Connect and payouts stay off in the sandbox.

### What a visitor can and cannot do there

Every visitor shares the demo logins, so the sandbox shows nearly every screen but refuses anything
that would outlive the reset or reach someone outside it (accounts, mail, money, provider writes),
and anything later visitors would run or read (scripts, stored secrets); ordinary content edits and
uploads still show to other visitors until the next reset, by design. The screens it does not show:
`/forgot-password` and `/profile/password` answer 404 there (their links are hidden), and
Settings → Security shows a notice instead of its panel. In the program itself:

- **Partner sign-up** runs every real check (captcha, handle, throttle, tier room) and stops before
  any write: no account, no email, no alert (`kind: 'sandbox_demo'` from `submitAffiliateSignup`).
  The form says so above its fields, and a demo panel replaces it at the end. `/partners` and
  `/partenaires` open with a guide card (storefront, portal, admin; `affiliates.sandbox.*` copy),
  and the portal shows a "Shared demo account" notice on every page.
- **The shared accounts stay as seeded.** `/cms/affiliates` cannot pause, resume or remove a
  partner or move one to another tier (the buttons on the Overview, the Storefronts list and the
  review page are disabled with a note, and `removeAffiliatePartner` and `changeAffiliatePartnerTier`
  refuse there by themselves too),
  and `/cms/users` creates, changes and deletes no user. Partner emails still show: the demo
  partners' addresses are the published demo logins, and a `mailto:` sends nothing from the site.
- **The built-in terms only.** A partner terms link would send every later visitor (the terms
  redirect, the signup checkbox, the portal FAQ) to an address a visitor chose: Program settings
  refuses a non-empty one and shows both fields disabled, and every read drops a stored link
  (`normalizeAffiliateTermsUrl`), so `/partners/terms` never redirects there.
- **No mail.** Affiliate notices mail nobody, and `sendEmail` delivers only to
  `SANDBOX_CONTACT_EMAIL` and the product feedback inbox. The request-changes message and dialog
  say the partner reads the note in the portal.
- **No money.** `/api/checkout` answers 403 (the storefront simulates checkout), payouts,
  manual payouts (prepare, record, cancel) and Stripe Connect refuse, and coupons, sale prices and promotions are saved locally but never sent
  to Freemius: the sandbox's products carry the operator's real Freemius ids, so a pushed coupon
  would work at the real checkout and outlive the reset (`freemius-coupons.ts`).
- **The copilot** takes the visitor's own OpenRouter key in a field above its quick actions
  (docs/08 → "One settings UI, sandbox included"). Sign-out forgets it.
- **A tour.** `/cms/affiliates` lists what to try: the waiting storefront in Approvals, Studio
  Nova's pending order, a tier rate, the ledger and the failed payout.

`tools/scripts/sandbox-guards.test.ts` (in `security:check`) lists every refusal with the test
that proves it. The operator steps (public sign-ups off on the sandbox's Supabase project) are in
docs/05 → "Sandbox Reset Operations".

The reset also dresses the store product, like Cortex AI's. `enrichAffiliatesProducts()`
(`app/api/cron/reset-sandbox/route.ts`) reads `NEXTBLOCK_PACKAGES.affiliates.fm_product_id` and
`fm_plan_id`, takes the synced English row of that plan, and writes the title, short description,
meta and five `section` blocks from `affiliates-product-copy.ts`. It then inserts the French twin
(`<slug>-fr`, same `translation_group_id`), attaches `images/affiliates-square.webp` to both rows
and files both under Software. The final call to action links to the nextblock.dev store page
once `purchase_url` is one, else to the product's own page (`/product/<slug>`, `-fr` in French);
the hero's live-demo button (`AFFILIATES_DEMO_URLS`) is dropped while
`FREEMIUS_AFFILIATES_SANDBOX_KEY` is unset, since the partner pages would answer 404. The step
runs in its own transaction after Cortex AI and never stops the reset: an empty registry id or a
product the sync did not bring is a warning, any other failure is logged and rolled back, and the
cover is an optional seed asset (a deploy without the file dresses the product without it).

## Security model

- **Two seats, two helpers.** Partners pass `requireRetailer()` / `requireRetailerPage()`, admins
  `requireCmsAdmin()`: session, enrolled second factor, own role, then the service role. Both are
  service-role markers in `tools/scripts/lib/service-role-boundary.js`, so every module that calls
  them must import `'server-only'`.
- **RLS is defense in depth, not the boundary.** Column grants, policies and guard triggers stop
  a partner who talks to the Data API directly; server code under the service role authorizes in
  code.
- **Server actions take no principal.** No portal or CMS action takes an actor, a user id, an
  affiliate id or a client: `affiliateid` and `retailerid` joined the identity names of
  `server-action-actors.test.ts`, and admin targets are named `…ToUpdate` / `…ToApprove` (a
  manual payout is prepared for `affiliateIdToPay`, then recorded or cancelled by
  `payoutIdToRecord` / `payoutIdToCancel`).
- **Partner content is untrusted** wherever it is read: sanitize at read time, render through
  `StorefrontRenderer`, edit with the restricted editor, never `NotionEditor` and never raw HTML.
  Partner uploads are re-encoded with server-built keys and never become media rows.
- **Nothing from the client decides money.** Checkout reads no affiliate id; tokens are signed
  and last only as long as the cart they were carried for; eligibility, rates and amounts come
  from the database; every money write is one RPC or trigger under row locks taken in one order;
  a sale is only ever paid by a transfer of its own key mode; transfers are idempotent and
  reconciled.
- **A manual payout records, it never pays** (02036). Only an ADMIN prepares, records or cancels
  one, through `requireCmsAdmin()` in the action and again in its `…Now` implementation;
  `recorded_by` is that session's user, never a request value. Which commissions a payout covers
  (cleared, unattached, live mode, undisputed, of the manual gateways) is decided in SQL under the
  profile and commission locks when it is prepared, before any money leaves; the record takes only
  a payout id, a channel, a reference and a note, and books exactly what was reserved, so nothing
  that changes after the money was sent (a commission that clears, a refund, a dispute, a pause, a
  gateway switched back) changes what it records. A commission is attached to one payout at a time
  (a prepared payout's commissions are in no queue and no Stripe claim), there is one prepared
  payout per partner and currency (a unique partial index), and a reference is required and unique
  per partner (a check under the lock and a unique index), so a double submit prepares or records
  one payout. Manual payout rows are never `FAILED` and never carry a Stripe destination or
  transfer (CHECKs), the Stripe cycle reads only `stripe_connect` payouts, and the admin Retry and
  Release refuse a manual one (`manual_payout`), so no Stripe path can send money for them. The
  PayPal file is ADMIN-only, `private, no-store`, read-only (the prepared payouts at their fixed
  amounts), neutralizes spreadsheet formulas in every text cell, never rewrites a recipient (a row
  whose email would need it is left out; the portal and the column's CHECK refuse such an
  address), and carries no storefront link.
- **Approval publishes what was reviewed.** Approve is pinned to the reviewed `draft_version` and
  to a fingerprint of the profile snapshot the review screen showed, and the profile guard refuses
  a partner's own name, bio and link edits while the page is in review.
- **Public reads expose only approved snapshots**, through definer functions in `private` behind
  invoker wrappers; the click counter is rate-limited inside the database.
- **Privacy:** referral cookies and storefront tokens honour the marketing consent (checkout
  attributes nothing once a visitor declined); clicks store a daily hash, never an IP; signups
  store a /24 or /48 network.
- **The copilot** is isolated: three output-only tools, untrusted-data markers, per-user and
  global quotas that fail closed and count only requests that reached a model, per-request
  budgets (3 sections, 3 stock photo lookups), no model or credential leakage.
- **Deleting a partner's account** is refused while it has payouts or real commissions
  (`lib/affiliates/affiliate-deletion-guard.ts`): "Pause the partner in Affiliates instead." A
  delete that goes through evicts the storefront and the tier list.
- **Removing a partner** (`removeAffiliatePartner`) asks the same guard, but only after it has
  paused the partner, so no commission or payout can be recorded between the check and the
  delete; the delete is conditional on the partner still being SUSPENDED, and a partner with any
  ledger history (or an unreadable ledger) stays paused instead. The role moves from RTL to USER
  compared as text. It refuses on the sandbox (in the action and in the function, both in
  `SANDBOX_GUARDS`), and its input names its target (`affiliateIdToRemove`).
- **Partner emails** reach CMS pages only for the visible rows, through the service role after
  `requireCmsAdmin()`, and only as a `mailto:` whose address is percent-encoded (no added
  recipients). No admin screen links a storefront: the Storefronts list prints the handle as text.

The guards: `findEnumRtlLiterals` (`migration-grants.test.ts`), posture sections 35–38 (with
37b), the 02030 block of `migrate-core.test.mjs`, `core/sql-parity.test.ts` (the ledger rules),
the payout tests (`payouts.test.ts`, `payout-runner.test.ts`, `settings.test.ts`, `refunds.test.ts`
and the webhook route tests), `retailer-actor.test.ts`, `referral-cookie.test.ts` and
`proxy.test.ts`, `attribution.test.ts` (consent) and `cart-store.test.ts` (the token's lifetime),
the storefront tests (`sanitize.test.ts`, `renderer.test.tsx`, `urls.test.ts`,
`editor-schema.test.ts`), `lib-structure.test.ts`, the approval and moderation tests
(`review.test.ts`: remove pauses first, keeps a partner with history, refuses a wrong handle and
the sandbox, closes only the partner's lifecycle alerts (never the Connect setup alert), and
answers its failures; `admin-data.test.ts`, `admin-data-moderation.test.ts`, `partner-contact.test.ts`,
`cms/affiliates/actions.test.ts`, `cms/affiliates/pages.test.tsx`: a `mailto:`, never a
storefront link; the dialog tests `RemovePartnerControl.test.tsx` and
`PartnerStatusControls.test.tsx`), the portal actions tests (the
resubmission cooldown), `notifications/templates.test.ts` (no storefront link in admin mail),
`signup.test.ts`, the upload tests (`upload/route.test.ts`, `uploads.test.ts`,
`avatar-cleanup.test.ts`, `upload-policy.test.ts`), the copilot tests (`request-quota.test.ts`,
`tools.test.ts`, the route tests), `cms/users/actions.test.ts`, `media/record/route.test.ts`,
`media-object-keys.test.ts` and `server-action-actors.test.ts`. For 02036: posture section 40
(and section 35's claim pin), the 02036 test in `migrate-core.test.mjs`, the
`02036_affiliate_manual_payouts.sql rules` block of `core/sql-parity.test.ts` (the claim body is
02030's plus the gateway filter, the record's statuses and locks, the constraints against the lib
constants, the guard and the alert advice), `core/payout-methods.test.ts`, the gateway tests in
`payouts.test.ts` and `obligations.test.ts`, `manual-payouts.test.ts` (ADMIN first, the sandbox,
`recorded_by` from the session, every status), `paypal-payouts-csv.test.ts` (format and formula
neutralization), `payouts/paypal/route.test.ts` (headers, refusals), the manual cases of
`payout-runner.test.ts`, `payout-setup.test.ts`, `notify.test.ts`, `templates.test.ts`,
`alerts.test.ts`, `actions.test.ts` and `pages.test.tsx`, and two `SANDBOX_GUARDS` entries; on
the partner side the `saveRetailerPayoutEmail` cases of the portal `actions.test.ts`
(`requireRetailer()` first, the sandbox, strict input, the caller's own row only, no database
text), its `SANDBOX_GUARDS` entry, `PayoutEmailForm.test.tsx`, the manual cases of
`portal-data.test.ts` (each figure sees only its own method's commissions) and
`retailer/payouts/page.test.tsx`, and `core/onboarding.test.ts`. For the partner side of 02037: the
kind cases of the same `actions.test.ts` block (the kind required and strict, a PayPal address over
127 characters refused, the sandbox), `PayoutEmailForm.test.tsx` (the choice, the confirmation, the
help per choice), the PayPal blocks of `portal-data.test.ts`, `retailer/payouts/page.test.tsx` and
`LedgerTables.test.tsx`, `paypal/events.test.ts` (which notice goes to whom), the PayPal cases of
`notify.test.ts` and `notifications/templates.test.ts` (no PayPal code reaches the partner), the
PayPal blocks of `partners-terms-route.test.tsx`, and the PayPal cases of `core/onboarding.test.ts`.
`docs/04` → "Row Level Security Patterns" and `.claude/skills/nextblock-security/SKILL.md` carry
the database and checklist details.

## Operational checklist

1. **Schema.** `npm run db:migrate:check` must list 02029, 02030 and 02031 as pending (and 02032,
   the vendor's store page, which skips on every other install; plus 02033, the tier goals,
   02034, the header, footer and home announcement, 02035, the rate at payment and the tier
   move, and 02036, the manual payouts); then
   `npm run db:migrate` and `npm run db:types`. Deployed installs apply them through the build
   hook or `/setup` (one transaction per file).
2. **Reserved addresses.** Activating the package takes over `/partners` (and `/partenaires`
   while French is an active language). A published CMS page with one of those slugs is no
   longer served there and leaves the sitemap while the package is active; rename it before
   activating (it is served again if the package is turned off).
3. **Activate** Commerce Pro, then the package (see "Activating it").
4. **Stripe.** Enable Connect (Express) on the platform account, complete the platform profile and
   Connect branding (name, colour, icon), allow your partners' countries, add `charge.refunded`,
   `charge.dispute.created` and `charge.dispute.closed` to the webhook endpoint, and give a
   restricted key the calls listed under "Stripe Connect Express". Then run **Test connection**
   on CMS → Affiliates → Stripe payouts. A store that sells only through Freemius still needs a
   Stripe secret key under Payments while Stripe pays its partners (the default); one that pays
   every commission manually (Program settings → How partners are paid, see "Paying partners
   manually") needs no Connect setup at all.
5. **Going live.** Cancel the test orders (CMS → Orders) before switching to live keys, and never
   leave `FREEMIUS_SANDBOX_ENABLED` on in a live store: its purchases are recorded as test mode,
   and only a test-mode payout would pay them.
6. **Currency and balance.** Keep the Stripe settlement currency equal to the store base currency
   and the balance funded: set Stripe payouts to Manual or keep a Minimum balance of at least a
   month of commissions (Freemius sales never fund it). The Stripe payouts screen compares the
   transferable balance with what you owe and warns otherwise. If Freemius pays you outside
   Stripe (PayPal), route Freemius commissions to "Manually" instead and pay them from there
   (Payouts → Pay manually: prepare each payout, send it, then record it).
7. **Scheduling.** Rely on the `after()` fallback, or set `CRON_SECRET` (16+ characters) and run
   `npm run affiliates:schedule-payouts -- https://<your site>` (in a standalone project too) or
   another scheduler.
8. **Email.** Configure SMTP and a real site address (`NEXT_PUBLIC_URL`, or the Vercel
   production URL); add notification addresses under Program settings.
9. **Storage** must be configured for avatar and image uploads.
10. **Tiers and settings.** Review the seeded tiers (the launch-offer tier keeps the highest sort
    order among the default tiers), their goals (02033 seeds generic wording such as "Make 8
    confirmed sales…"; reword them under CMS → Affiliates → Tiers), the minimum payout and the
    daily Stripe transfers switch ("Send Stripe transfers automatically every day"). Turning it
    off stops every scheduled Stripe transfer, even through database hiccups; the daily run still
    clears commissions (02036).
11. **Copilot (optional):** Cortex AI active with an OpenRouter credential; stock photo keys for
    copilot images.
12. **Consent.** Partners' links and storefront purchases honour the cookie banner's marketing
    choice (a visitor who declines is never attributed); say so in your privacy policy.

## Deviations from the original prompt

The design started from `docs/prompts/Affiliate-Master-Prompt.md`. Where it changed, this is
what ships and why.

| The prompt said | What ships | Why |
| :-- | :-- | :-- |
| `packages/affiliates`, `@nextblock/affiliates` | `libs/affiliates`, `@nextblock-cms/affiliates`, package id `affiliates` | The repository's convention for every library |
| Next.js 16 Edge Middleware | `apps/nextblock/proxy.ts` | Next 16 renamed middleware to proxy |
| One migration | 02029 (the `RTL` label alone), 02030 (schema), 02031 (UI copy) | Postgres refuses a new enum label inside the transaction that added it |
| `'RTL'` compared as an enum | Compared as text; a lint refuses the cast | The sandbox replays every migration in one transaction |
| `avatar_url` | `avatar_object_key`, set by the upload route | A user-writable URL is a tracking and SSRF vector |
| Payouts `COMPLETED` / `FAILED`, transfer id required | `PROCESSING` / `COMPLETED` / `FAILED`, nullable unique transfer id, attempts, failure reason | A failed transfer has no id; claiming before the transfer needs `PROCESSING` for crash safety |
| Commission in the order amount and currency | The store base currency, from subtotal minus discounts (no tax, no shipping); the order-currency amount is kept | One settlement currency keeps balances and totals coherent |
| Webhooks insert commissions | A database trigger records it when the order is first paid | Every path that marks an order paid ends in `assign_order_invoice_metadata()`, which sets `paid_at` once under a row lock |
| Refunds void a pending commission | Full refunds void, partial refunds reduce pro rata (on the charge without its shipping share), a refund after payout raises an alert | Voiding a whole commission for a small refund is wrong, and paid money cannot be voided silently |
| Freemius `payment.refunded` | `payment.refund` (plus `payment.refunded`, `payment.dispute.lost`, `payment.dispute.closed`), always a full refund; `payment.dispute.created` / `payment.dispute.won` hold and release the commission | Freemius' real event names |
| Stripe `checkout.session.completed` only | Also `charge.refunded`, `charge.dispute.created` and `charge.dispute.closed` | Refunds and lost disputes have to reach the ledger, and open disputes hold the commission |
| Cron via Vercel Cron or GitHub Actions | A fail-closed cron route, an `after()` fallback, "Run payouts now" and an optional pg_cron installer | `vercel.json` on master must never declare crons, and every fork inherits `.github/` |
| Cookie lifetime 30 days or the tier's | The tier's window through a cached anonymous lookup; unknown partner: no cookie; lookup failure: 30 days | The proxy has no service role and must stay fast |
| Middleware increments `total_clicks` | A database function counts one click per visitor per day, scheduled after the response | `anon` has no write grant; flood limits live in the database |
| Partners edit through RLS | Server actions on the service role; RLS and column grants kept as defense in depth | RLS is not a boundary under the service role |
| The storefront shows the live profile | It shows the profile snapshot approved with the page | Otherwise a partner could change the bio or avatar without review, and the snapshot is pinned to what the reviewer saw |
| Embed `affiliate_id` in the checkout payload | A signed storefront token (handle and time), valid within the tier window and only as long as the cart it was carried for, winning over the cookie | A raw id in the cart could be swapped for any partner |
| Every referred order earns | Only ACTIVE partners whose first storefront was approved; never on their own orders (account or normalized email); first payment only | Prevents unreviewed and self-referral earnings; renewals never earned |
| `cms_settings` SMTP mailer | `sendEmail()` (`app/actions/email.ts`, DB-first SMTP) | `cms_settings` does not exist |
| ADMIN full CRUD on every table | Tiers over the Data API with a second factor; everything else through the CMS on the service role after `requireCmsAdmin()`; no API insert or delete of accounts, a read-only ledger | Creating accounts outside signup or deleting them would break the ledger |
| Constrained JSONB decoding of Tiptap | Strict flat tool schemas; the server builds the restricted document and sanitizes it | Models fail at nested editor JSON |
| The copilot writes `draft_content` | Output-only tools; the portal inserts into the open editor, whose autosave saves | No race with unsaved editor state; a retry never duplicates a write |
| `?connected=true` return | `?connected=1`, and readiness read from Stripe, never from the URL | The URL is attacker-controlled |
| Signup with name, email, password | Also a terms checkbox and bot protection; a signed-in customer is upgraded in place | Abuse protection; no duplicate accounts |
| The server action creates the RTL user, assigns the tier and redirects | With email confirmation on, the tier, handle and page are assigned when the confirmed visitor claims the prefilled handle on `/partners` | An unconfirmed signup would otherwise hold a capped seat and its handle forever |
| "— Limited to our First [remaining_spots] Founding Ambassadors!" | "— Only {spots} {tier} Spots Left!" (FR "— il ne reste que {spots} places au niveau {tier}!"), with the promo tier's current localized name | Admins rename tiers, and a free-form name cannot be pluralized safely (French compound names); the number is the spots remaining, not the cap |
| Buy from the dashboard | Yes, through Freemius product 43273 / plan 75655, once Commerce Pro is active | Sold like the other packages, as Commerce Pro's add-on |
| A standalone premium package | An add-on to Commerce Pro: it requires it, costs USD 200 a year or 20 a month (450 a year with Commerce Pro), and stays dormant while Commerce Pro is off | Partners earn a share of store sales: without the shop there is nothing to sell |

## Known limitations and follow-ups

- **PayPal Payouts (02037) poll; no webhooks.** PayPal's answer arrives with the next payout run (or
  "Check PayPal status now"), not when PayPal settles an item. A resend PayPal refuses (without
  naming the original batch, or before it could look at it: credentials, Payouts access, balance)
  keeps its payouts in flight with a "A PayPal payout batch needs checking" alert: the admin checks
  PayPal and uses Release (an hour after the last send, which every resend stamps again), since
  releasing on a guess could pay twice. The run summary is not stored in `affiliate_payout_runs`
  (only the Stripe/repair summary is).
- **No "record as paid" for a PayPal payout this site cannot read.** A batch first claimed over 25
  days ago that PayPal never confirmed is not sent again (PayPal forgets the id after 30 days), and a
  batch PayPal will not show (the credentials moved to another PayPal account) stays in flight: when
  PayPal did NOT pay it, the admin releases it (an hour after the last send for an unconfirmed batch,
  a week for an acknowledged one); when PayPal DID pay it, restore the credentials of the account that
  sent it so the sync records it. An unconfirmed batch that PayPal paid after the 25 days has no batch
  id to read: leave its payouts in flight (releasing them would pay the partner again) and record the
  payment in the database by hand (`complete_paypal_affiliate_payout` with PayPal's item and
  transaction ids, as the service role).
- **The portal's PayPal estimate does not model the PayPal environment's mode.** A live PayPal
  environment pays live-mode commissions only and the PayPal sandbox test-mode ones; the portal's
  "Next PayPal payout" counts every open commission of the PayPal gateways (as the Stripe estimate
  ignores the Connect account's mode) and shows "paused" only while automatic payouts are off or the
  active environment has no credentials. The PayPal payouts screen and "Run payouts now" warn while
  PayPal is in Sandbox with gateways routed to it (live sales then wait, neither sent nor listed under
  Pay manually). Switch the environment to live before routing real sales to PayPal.
- **PayPal Payouts currencies.** PayPal sends 24 currencies, HUF, JPY and TWD in whole units only. A
  store currency PayPal does not send is skipped by the run (an alert) and its partners' PayPal
  commissions are listed under Pay manually; a HUF or TWD amount with a fraction is skipped with an
  alert and stays owed until the admin routes those sales to Manually.
- **A payout email saved before 02037 reads as a PayPal account** (`payout_email_kind` defaults to
  `paypal`). A partner who saved an Interac e-Transfer address under 02036 should choose "Interac
  e-Transfer" in the portal before a gateway goes to PayPal; otherwise PayPal is sent to that address,
  holds it unclaimed for 30 days and returns it, and the partner is then paid by hand (and mailed
  PAYPAL_UNCLAIMED, then PAYPAL_PAYOUT_FAILED). A returned address stays with the store's Pay
  manually list until the partner saves their payout email again: a different address, or the same
  one once a PayPal account can take it ("I checked it: try PayPal again"; `payout_email_saved_at`
  later than the return lifts it). If PayPal returns it again, the block comes back.
- **Tier goals are display only.** Nothing counts a partner's progress toward a goal or promotes
  anyone; an admin moves partners by hand. A progress bar in the partner portal (confirmed sales
  toward the next goal) would need a structured target (a sales count) next to the text.
- **Tier history:** only the date of the last move is kept (`tier_changed_at`). Each paid order
  keeps its rate and each commission `commission_rate_snapshot`, but nothing logs who moved a
  partner, from which tier, or the earlier moves.
- **The calculator's products are the three priciest.** On a large catalog that is the store's
  most expensive items, not its best sellers. The order value slider still lets the visitor try
  any amount.
- **Headless activation:** `NEXTBLOCK_LICENSE_KEY` activates one package
  (`NEXTBLOCK_LICENSE_PACKAGE`), so a headless install whose key is for Affiliates still needs
  Commerce Pro activated in the dashboard, and the CLI only requests Cortex AI trials.
- **Store page:** migration `02032` creates the nextblock.dev page as drafts, so until the vendor
  publishes them, `purchase_url` and the sandbox's call to action answer 404.
- **Bundles:** the registry prices each package on its own; a Commerce Pro + Affiliates bundle
  (or an all-in bundle with Cortex AI) would be a Freemius plan of its own, which the registry
  cannot describe yet.
- **Refund after a payout** raises an alert and emails the admins, but the transfer must be
  reversed in Stripe by hand. An alert raised outside a webhook (a CMS status change, an order
  delete) is mailed by the next payout cycle. The insufficient-balance alert sends no email.
- **Manual payouts (02036) have no clawback.** A refund after a recorded manual payout only
  alerts with the advice to recover the amount from the partner (for example by asking them to send
  it back); nothing deducts it from a later manual payout, which records exactly the amount it
  reserved (the built-in terms still state the right to deduct it; doing so outside the CMS would
  make the record show money the partner never received). A refund that reaches a prepared payout
  before it is recorded is flagged on it: cancel it and prepare it again if the money has not
  left. A payout reserves every cleared commission of the manual gateways for that partner and
  currency at once (no partial payment, no per-commission pick); a recorded manual payout cannot
  be undone or edited from the CMS (a wrong record is a database fix), and a prepared one can be
  cancelled only until it is recorded: cancel it only if the money never left, or a later payout
  pays the same commissions again.
- **Switching a gateway to manual leaves Stripe payouts as they are.** Commissions already in a
  `PROCESSING` or `FAILED` Stripe payout stay attached to it: let it complete, or **Release** the
  failed payout (Payouts list, with the Stripe key) so its commissions are cleared again and appear
  under Pay manually before you prepare them. Switching back to Stripe Connect makes the gateway's
  unpaid cleared commissions claimable by the next run; a manual payout prepared before the switch
  keeps its commissions until it is recorded or cancelled (Pay manually stays on the screen while
  one waits). With no gateway left on Stripe the daily run no longer reconciles or retries older
  Stripe payouts (see "The daily cycle"): a stale `PROCESSING` one gets Retry and Release on the
  payouts table.
- **The payout email is the partner's word.** The portal saves it (`saveRetailerPayoutEmail`, see
  "Payouts page") without a confirmation email (a new PayPal address is only typed twice), so a typo
  sends money to the wrong address: check the name PayPal shows before it sends. Saving one notifies no admin and stamps no timestamp, so
  the CMS partner list's onboarding step (the database's `onboarding_step`) still follows Stripe
  Connect only, while the portal's tracker counts the email. Until a partner has one, the CMS shows
  "No payout email yet", and "Prepare PayPal payouts" and the PayPal file leave them out. The CMS
  commissions table shows no transfer id for a commission paid manually.
- **The PayPal file** lists at most 5,000 prepared payouts per currency (PayPal's limit; the
  section says so past that, and the rest come in the next file once those payouts are recorded).
  It is built from what PayPal documented on 2026-11-11; PayPal shows every payment before sending,
  which is where a format change would show. A PayPal payment nobody claims within 30 days goes back
  to the store's PayPal balance: its prepared payout then waits to be sent again and recorded, or
  cancelled. Only PayPal gets a file here: the other channels are sent outside the CMS by whatever
  means they offer and recorded the same way.
- **Test-mode commissions are never paid manually** (a Stripe test key or the Freemius sandbox):
  they stay cleared and unpaid under a manual gateway. Cancel test orders before going live.
- **Refund shares:** a Stripe refund carries no breakdown. Shipping is assumed refunded last and
  tax with the goods, so a shipping-only refund still reduces the commission pro rata (by the
  shipping's share of the base), and a refund of goods without their tax leaves a small
  remainder.
- **Disputes:** a dispute opened after the payout still only alerts when it is lost (reverse the
  transfer by hand). Since 02035 a dispute that opens before the order's commission exists (a
  commission that reconcile records later) is kept on the order and holds that commission; one
  that opened before 02035 was answered `none` and is not known, so such a commission, recorded
  late with its hold already over, can still clear and be paid in the run that records it (a lost
  dispute then only alerts). A hold whose closing event never arrives keeps the commission unpaid
  until a `charge.dispute.closed` / `payment.dispute.won` is delivered; there is no CMS release
  button yet. The portal's pending balance and next-payout estimate include held commissions.
- **Deleting a partner's user** checks the ledger, then deletes: an order paid in between could
  still cascade away. A database guard would need a migration. The partner's storage objects
  (`affiliates/avatars/<id>/`, `affiliates/pages/<id>/`) are not removed. The public storefront,
  the sitemap and the tier list (member count, founding spots) are evicted with the delete.
- **Removing a partner** in `/cms/affiliates` leaves the Stripe Connect account (close it in the
  Stripe dashboard if needed) and the partner's storage objects (`affiliates/avatars/<id>/`,
  `affiliates/pages/<id>/`) in place, sends the partner no email (write to them first: the Email
  link on the review page), and unlinks their attributed orders (`orders.affiliate_id` becomes
  NULL), so an order that waited for a resume is never credited. Only a partner without ledger
  history can be removed; the others stay paused. There is no undo, and removal bans nobody: the
  person can sign up again from `/partners` as a new partner (pause them instead to keep them
  out). Remove lives on the review page only; every partner has a page from signup on, and the
  Overview links it for each one ("Review now" or "Open review").
- **Pausing** keeps the partner's tier seat (and counts toward its cap) until they are moved or
  removed. Orders placed before a pause and paid during it are credited by the payout cycle's
  reconcile, so not until a payout run happens (the daily run, whatever the automatic Stripe
  transfers switch says, or Run payouts now), and not for orders older than 120 days by then; an
  order placed during the pause never earns.
- **Partner emails** cost one GoTrue admin call per visible row (at most 10 at a time, 200 per
  page view); the Overview and the approvals screen look them up on every render.
- **Changing a partner's role** away from `RTL` in `/cms/users` removes portal access but does
  not pause the affiliate profile; pause in `/cms/affiliates`.
- **Proxy `after()`** (the click count) is covered only by tests with a mocked `after()` so far.
  If clicks stay at 0 on a live install, check that first.
- **Signup with email confirmation:** the handle is not held between signup and confirmation
  (someone else can claim it; the form then shows it as taken), the tier is decided when the
  confirmed visitor claims it (the next tier if the launch offer filled up meanwhile), and
  confirming takes one more click ("Become a partner"). The masked-IP throttle counts partner
  accounts, so it does not count unconfirmed signups; GoTrue's email limit and bot protection
  still apply, as for `/sign-up`. The confirmation link always returns to `/partners`, never
  `/partenaires`. `user_metadata.affiliate_handle` stays on the auth user after the claim (a
  prefill only).
- **Client IP:** the rest of the app (the form, contact-seller, consent and thread actions, the
  coupon server, and the provision-trial and claim-license routes) still reads
  `x-vercel-forwarded-for` first on every host, and `contactSellerActions` keeps the old masker;
  both should move to one shared client-IP helper.
- **Storefront token scope:** the token belongs to the whole cart, not to a line. A shopper who
  removes the storefront product but keeps other lines keeps the token until the cart empties,
  and a non-storefront line added to that cart is credited to the storefront too (as the referral
  cookie would credit it).
- **Storefront link hand-off is in memory:** if the shopper reloads the product page (or opens it
  in a new tab) before adding, the pending token is gone and attribution falls back to the
  referral cookie that document load sets (none when cookies are blocked or marketing was
  declined). A shopper who opens a storefront product and then adds a different product in the
  same tab credits the storefront, as the referral cookie would.
- **Copilot:** whether every provider accepts strict tool schemas with length keywords is
  unverified. Unsplash downloads are pinged when a section is generated, not when it is inserted.
  A rewrite applies to one paragraph, heading or list item at a time, and line breaks inside the
  rewrite are flattened to spaces (the tool returns one line). A request that asks for more than
  3 sections gets the first 3 and a notice.
- **Copilot capacity:** the shared cap is first come, first served: about 20 partner accounts at
  their own 30-an-hour cap can use all of it; pause abusive partners in `/cms/affiliates`. It
  admits 599 requests per sliding hour (the request's own row is counted, `count < 600`). Under a
  burst of concurrent requests at the edge of the cap, insert-then-count can refuse the whole
  burst although one slot was free (it never over-admits). Stock photos use the operator's Pexels
  / Unsplash keys, which the admin agent shares: at 3 lookups per request, one partner at the
  30-request cap can make 90 lookups an hour and the shared cap allows up to 1,800, so heavy
  partner use can still exhaust a free key's hourly quota (Pexels 200, Unsplash demo 50). There
  is no per-partner hourly lookup cap (it would need its own accounting: `cortex_request_log`
  counts per user across every AI route).
- **Payouts:** transfers draw from the `card` source balance (an ACH-only platform would show
  shortfalls). After going live, commissions of test-mode sales stay `CLEARED` in the ledger, in
  partner balance cards and in CMS totals, and are never paid with live money; cancel the test
  orders in CMS → Orders to void them. A payout of the other mode waits (`PROCESSING` or
  `FAILED`) until a key of its mode is configured again. The Connect `business_profile.url`
  points at a storefront that 404s until the first approval; a cron run stops after 8 passes or
  45 s and the rest waits for the fallback or the next day.
- **Cross-border payouts:** Stripe transfers to a partner abroad only inside the US, Canada, the
  UK, the EEA and Switzerland, so a platform elsewhere can pay only partners of its own country
  (the portal offers no other). The region list is ours (`AFFILIATE_CONNECT_CROSS_BORDER_COUNTRY_CODES`):
  if Stripe changes it, update it there.
- **Funding:** nothing adds money to the Stripe balance for payouts. Top-ups exist only in some
  countries (US, UK and Japan; a private preview in Canada), Freemius sales never reach Stripe, and
  a Stripe payout schedule that is not manual can empty the balance before commissions clear; the
  Stripe payouts screen advises (it cannot read a Minimum balance, so it cannot tell whether one is
  kept), but it cannot change the schedule or top up for you. Its "owed"
  figures cover the key's mode only, and the payout schedule shown is read fresh on each visit
  (the platform facts are cached for 10 minutes).
- **Reconcile** judges a missed commission by the partner's current status and tier (a partial
  refund kept on the order is taken off), and re-evaluates skipped orders on every run (bounded,
  newest first).
- **Lock order:** `apply_affiliate_refund` locks the order row before the partner, like the
  orders triggers, while `reconcile_affiliate_commissions` and deleting a partner's user take the
  partner first. A refund webhook racing either one on the same order can deadlock; Postgres
  aborts one of them, the webhook answers 5xx and is redelivered, and reconcile retries on its
  next run.
- **Out-of-order events:** a full refund delivered while the order is still pending leaves it
  pending (only paid or shipped orders become refunded); the tombstone still blocks a commission.
  A partial refund that arrives before the commission exists is kept on the order and taken off
  when the commission is recorded (paid trigger or reconcile). A later failed refund
  (`charge.refund.updated`) is not handled; the commission stays reduced. Freemius trial
  conversions are assumed not to be flagged `is_renewal`.
- **Uploads:** the 30-per-hour avatar throttle is per process; page images also have the
  storage-listing caps. Decode memory is bounded per upload (about 0.35 GB in the worst case),
  and decodes are serialized per process, so concurrent uploads on one instance wait instead of
  multiplying that. An AVIF over 12 MP gets the generic "That file couldn't be read as an image"
  message (`affiliates.portal.upload_error_invalid`; no dedicated copy key yet). A replaced approved avatar is deleted only by the approval that
  replaces it: until the partner resubmits and is approved, both the approved avatar and the newer
  one are stored. The upload route reads the approved snapshot when the request starts, so a
  submission and an approval that both land while one avatar upload is running could still let
  that upload delete the newly approved avatar.
- **Storefronts:** one setting (`preferred_locale`) is both the email language and the storefront
  language. An approved title longer than 60 characters is used as is. Lighthouse has not been
  measured on `/partners` or a storefront yet; the SEO engine score is what the tests assert.
- **Partner addresses:** nothing warns an editor that the slugs `partners` / `partenaires` are
  taken while the package is active (no page-editor check, no notice on `/cms/affiliates`). On a
  site whose default language is French, crawlers get `/partners` in French (canonical
  `/partenaires`), so the English copy has no indexable address. A client-side navigation to
  `/partenaires` keeps the previous language's header and footer until the next full load (the
  page itself and its `lang` are French). The proxy cannot check the package, so it pins French on
  `/partenaires` and below even while the package is off (the CMS page `partenaires` then renders
  with French chrome, and every other path below it is a French 404).
- **Partner terms:**
  - Acceptance is not recorded: no terms version is stored per partner yet (it needs a
    migration). The signup checkbox is required, but nothing keeps which version a partner
    accepted or when.
  - Nothing tells partners when the terms change: "Last updated" (`AFFILIATE_TERMS_VERSION`) moves
    only with a code change, and an operator's edit of the `affiliates.terms.*` copy in the CMS
    translations screen leaves that date as it was.
  - A partner who claimed the handle `terms` before it was reserved loses `/partners/terms` to the
    terms page (the static route wins) until an admin changes the handle in the database.
  - The built-in terms are a template that describes this code, not legal advice; the CMS says so
    next to the fields that replace them.
- **Error pages:** outside the partner portal the app has no `error.tsx` / `loading.tsx` yet; an
  error in the CMS, the shop or the public pages shows Next's built-in English page.
- **The next payout date** in the portal is an estimate.
- **Existing standalone projects** get `@nextblock-cms/affiliates` from `npm run update`, but
  `next.config.js` and `tailwind.config.js` are never touched: add it to `transpilePackages` (the
  updater warns) and the Tailwind `content` list yourself (docs/13).

## Related docs

- [02-ECOMMERCE-CAPABILITIES.md](./02-ECOMMERCE-CAPABILITIES.md): checkout, webhooks, order
  statuses.
- [04-DATABASE-AND-AUTH.md](./04-DATABASE-AND-AUTH.md): the RLS and grant model, the posture
  script, the migration rules.
- [05-DEVELOPER-GUIDE.md](./05-DEVELOPER-GUIDE.md): environment variables and the proxy notes.
- [08-NEXTBLOCK-CORTEX-AI-ARCHITECTURE.md](./08-NEXTBLOCK-CORTEX-AI-ARCHITECTURE.md): Cortex AI,
  quotas, untrusted data, the copilot route.
- [12-VERCEL-DEPLOYMENT.md](./12-VERCEL-DEPLOYMENT.md): why no `vercel.json` crons.
