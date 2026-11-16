# libs/ecommerce — package @nextblock-cms/ecom, imported as @nextblock-cms/ecommerce

Premium commerce: storefront cart/checkout components, Stripe (physical) and Freemius (digital)
providers + webhooks, multi-currency pricing, coupons, tax, shipping, inventory, invoices, and
the CMS commerce pages the app wraps behind `verifyPackageOnline('ecommerce')`.

Entry points: `.` (client-safe components, stores, providers, schemas); `/server` (the app's main
entry: providers, webhooks, `payment-config`, readiness, product actions, CMS pages); `/<path>` →
`src/lib/<path>`, reachable from a barrel or listed in `vite.config.mts` `build.lib.entry`.

## Rules
- The name mismatch (`ecom` package, `ecommerce` alias) is intentional; never rename either side.
- Provider is welded to product type: physical → Stripe, digital → Freemius (`types.ts`, DB CHECK).
- Credentials resolve DB-first from `site_settings` `payment_public` / `payment_secret`, env
  fallback (`payment-config.ts`). Freemius helpers read `process.env`, so every async entry must
  call `hydrateFreemiusEnvFromDb()` first. A field removed (CMS → Payments' remove boxes:
  `remove` on `savePaymentCredentials`, same actor and sandbox checks) or cleared in the database
  gives its name back to the deployment's value, or deletes it; a failed read takes nothing back,
  and a value hydration did not write is never touched (`payment-config.test.ts`).
- The Freemius developer key pair (one pair for every product; a master key for the account) is
  signed with ONLY in `freemius-developer-api.ts`: Freemius work goes through
  `freemiusDeveloperRequest` / `withFreemiusDeveloperScope` (product keys via
  `getFreemiusProductKeys`), ids through `toFreemiusId`, and the product-key path stays the
  fallback. On the public sandbox only the reset's catalog reader may send a request (the CMS Sync
  refuses there): every other entry refuses (`SANDBOX_GUARDS`), or `findDeveloperKeyProblems`
  fails. Never log a developer-scope response (plugins carry each product's keys), never write
  the pair into `process.env`, and keep `verifyFreemiusWebhookSignature` synchronous (0.23.3 route
  files call it). The route awaits `getFreemiusWebhookVerification` (an object: test
  `outcome === 'valid'`, answer 503 on `unverifiable`) and passes the verified `productId` to every
  handler. An order with no stored `freemius_product_id` is in scope only when its own items'
  products carry that id (then written to the order), never on the event's word
  (`freemius-webhook-product-scope.test.ts`). While the pair works, `null` from
  `getFreemiusProductKeys` is Freemius' answer (an
  answered product list lacks the id, or it gave no keys for a listed product: a 401/403/404, or
  the product's object without keys); an unanswered re-list, a 2xx without a `plugins` array
  included, throws `unavailable`, a product read answered with a 2xx that is not that product (no
  object, no `id`, another `id`) is unanswered too (the last keys stay), and so is a first catalog
  page that is not a list (Sync stops, never "0 products"). A working pair is refused only at two
  first-page 404s 30 s apart, and last-good secrets verify webhooks for
  `FREEMIUS_WEBHOOK_SECRET_MAX_AGE_MS` at most. docs/02 → "Freemius keys".
- Whether the one-product keys (`FREEMIUS_PUBLIC_KEY` / `FREEMIUS_SECRET_KEY`) may open a product's
  checkout or verify its webhooks is ONE policy module, `freemius-key-policy.ts`, shared by both:
  `freemiusKeysMayBeDeveloperPair` for the keys `FREEMIUS_PRODUCT_ID` binds,
  `decideFreemiusOneProductStandIn` for standing in (its legacy-only refused state asks
  `confirmFreemiusOneProductKeys`, the only request signed with those keys, which only a 2xx that IS
  the product confirms: its `id`, no `error` member; a webhook asks only once that secret matches).
  Never add another fallback to those names, which may hold the developer pair, and throttle log
  lines unauthenticated requests can cause (`createFreemiusLogThrottle`).
  `readFreemiusEnvValue` / `parseFreemiusCheckoutCredentialsMap` live there (re-exported from
  `providers/freemius`); the policy module must not import `providers/freemius`.
- A Freemius 401/403 to the store's own keys is a configuration error, never a missing record: log
  it with `logFreemiusCredentialsRefused` (`freemius-license-claim.ts`, throttled, no key), and
  never read an `@freemius/sdk` service's `null` as "not found" without its status
  (`watchFreemiusAnswers`). Eligibility checks (one trial per email) fail closed: an unanswered or
  unreadable lookup is a 502, never "none".
- A server action that reaches a Freemius coupon push (`syncCouponToFreemius`,
  `syncProductSaleCouponToFreemius`, `deleteCouponFromFreemius`) awaits `requireEcomAdmin()` (the
  app: `requireCmsAdmin()`) bare, as a statement, initializer or assignment, before every call
  toward the push: no `.catch()`. `server-action-actors.test.ts` fails otherwise.
- Store readiness is ONE predicate (`pages/cms/payments/queries.ts`); never fork it per surface. It
  never waits on Freemius (an unchecked or unreachable developer pair reads ready), so a screen that
  acts on it (the CMS Payments toggle) awaits the blocking `getFreemiusDeveloperStatus()` first.
  From memory it also reads not ready for one-product keys with a refused dedicated pair, no
  Product ID and no JSON entry with a `publicKey` (they open no checkout).
- Money is minor units; resolve prices via `currency.ts` (`price` is the fallback).
- The form's draft (`saveProductDraftMeta`) is ProductFormValues in MAJOR units stamped
  `form_version: 2`: the app checks only unstamped product values for the pre-0.23.4 damage, so
  every writer of product values stamps it. The app keeps its own copy of the literal (a 'use
  server' module exports only async functions): `product-draft-marker.test.ts` fails on drift.
- ProductForm autosaves 400 ms after anything React Hook Form marks dirty, so opening it must dirty
  nothing: its defaults and `EditProductPage`'s initial data carry every column a save writes back
  (`ProductForm.sale-window.test.tsx`, `EditProductPage.test.tsx`), `VariationsEditor` starts from
  `getValues` (never `initialData`) and remounts on every reset after the first, and
  `handleVariationChange` ignores an emission equal to the form on what a save writes
  (`SAVED_VARIANT_KEYS` and the term ids: what `serializeVariantsForRpc` sends, `id` aside).
  Guard: `ProductForm.variations-autosave.test.tsx`; docs/09 → "The product editor's autosave".
- The load repair (`repairLoadedVariants`, in `buildProductFormDefaults`) does three things, without
  notice: it leaves out variants with no terms and all but the first per term set (the next save
  and publish delete them), fills an empty SKU, and fills missing options, label or key. Any other
  variant `productSchema` refuses (a sale above its price; terms this store lacks and no options,
  in zod's default words) blocks every autosave, named on the status line, until it is fixed, a
  term toggle rebuilds the list or the draft is discarded. A draft variant that kept its options
  when its term was deleted saves, and that draft's publish fails on `variant_attribute_mapping`
  until a toggle rebuilds the list.
- `VariationsEditor` regenerates only when the selected terms change, by value (a currency change
  would too, but ProductForm remounts it on that reset): never on open or on the product's SKU,
  prices or sale, and only deselecting the last term empties the list (`VariationsEditor.test.tsx`).
  `generateVariantDrafts` keeps an existing variant's own price maps and sale, an empty one
  included (`previous ? previous.x ?? <empty> : base`, never `previous?.x ?? base`); only a new
  combination takes the form's amounts as they are, and the product's sale window only with a sale
  amount (`variation-utils.test.ts`).
- The product page (`ProductDetailsLayout`) shows a selected variant's own resolved sale price
  (`null`: no sale), the one Stripe checkout charges, never the product's; the product's only with
  no variant selected (`ProductDetailsLayout.test.tsx`).
- `updateProduct()` never deletes media: the gallery is one checked upsert of the listed images
  (deduplicated, only ids that still have a media row, checked before the first write) and one checked
  unlink of the rest; a top-level `media_id` and `explicitly_removed_media_ids` are ignored. Never add
  media deletion to a save path: image blocks, section backgrounds, text blocks and the social image
  keep their own copy of a key that no foreign key tracks, and a save's values can be a draft any
  WRITER can write (`product-actions.test.ts`).
- Every write that changes `products.title`, `short_description` or `description_json` sets
  `updated_at` (no trigger does; the sitemap and the app's pre-0.23.4 draft rule read it), as the
  product RPC, the Freemius sync and `copyProductFromLanguage` do (`providers/freemius.test.ts`,
  `product-actions.test.ts`).
- Stripe checkout (`providers/stripe.ts`, the standalone `stripe/checkout.ts`) hands out a
  session's URL only once its order stores `stripe_session_id`: the app's success page finds a
  Stripe order only through that column and asks Stripe about no other id. A failed write (error
  or no row) expires the session, fails the order and answers the keyed 503
  (`providers/stripe.test.ts`, `stripe/checkout.test.ts`).
- Storefront code imports `@nextblock-cms/utils` through deep subpaths (`/utils`,
  `/translations-context`, `/media-url`, …), never the barrel (it carries the authored-HTML
  sanitizer and Zod): `currency.ts` and every client component a public route loads, up front
  (`CurrencyProvider`, `CartIcon`, `ProductGrid`, `Checkout`, …) or behind the app's
  `LazyCommerceClients` (`FeaturedProduct`, `ProductDetailsLayout`, …). Only `ShortDescription` and
  `SimpleTiptapRenderer` import `/authored-html` (they sanitize in the browser), and no storefront
  client code imports Zod; the CMS screens (`pages/cms/**`) may keep the barrel. Guard:
  `tools/scripts/root-layout-chunking.test.ts`. Tests mock the module the code under test imports:
  vitest mocks by resolved file, so a barrel mock reaches only modules still on the barrel (the CMS
  screens, `freemius-pricing-server.ts`, `shipping-rate-currency.ts`, …).

## Gotchas
- A new app-imported subpath that no barrel re-exports must be added to `build.lib.entry`, or
  standalone installs break while the monorepo works.
- `npx nx build ecommerce` copies the raw `package.json` into a clean dist; only
  `tools/scripts/release-lib.js` writes the exports map. Validate commerce changes at the app level.
- The cart's `affiliateRef` (the Affiliates storefront token) lives exactly as long as the cart:
  set items through `withCartItems` (`cart-store.ts`) so every path that empties the cart drops
  it, and keep `pendingAffiliateRef` (a storefront link's token, promoted by the next successful
  add) out of `partialize`. `cart-store.test.ts` covers both (docs/15 → "The storefront token").
- An attributed order records its payment mode (`affiliate_livemode`): Stripe from the secret
  key's prefix (`stripeSecretKeyLivemode()`), Freemius from `FREEMIUS_SANDBOX_ENABLED`, read once
  per checkout. A test-mode sale is then only ever paid out by a test-mode transfer.

Commands: `npx vitest run libs/ecommerce`, `npx nx lint ecommerce`, `npx nx run ecommerce:build`
(excluded from `lib-builds` on purpose); `npm run build:ecom` publishes.
