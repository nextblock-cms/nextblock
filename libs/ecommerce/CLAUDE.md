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
  Its UPDATE selects the row back: none means a publish (or a discard) deleted the draft after the
  read, and the values start a new draft instead of being reported saved. The values carry
  `stock_baseline` (`productSchema`, lenient on purpose: a hidden field that refused a value would
  block every autosave), the stock the app's edit page loaded per SKU, and since 02047
  `stock_baseline_publish_count`, the product's publish count when the page loaded it (lenient the
  same way): `ProductForm` passes both from `initialData` through unseen and never computes either
  (only the page knows whether its data is live or a draft's, and which publish it read). With a
  draft open the page records the live stock as the baseline, with the count it read, and shows
  what that draft's publish would write (docs/09 → "Stock: only what the editor changed").
- A product draft publishes through `public.publish_product_draft` (migration 02043: one
  transaction under the product and draft row locks), with `buildProductDraftPublishValues(values)`
  as `p_values`: `updateProduct()`'s RPC payload in minor units without `id`, `status`, `metadata`
  or the provider, plus the SEO fields, `gallery_media_ids` and `category_ids` (null leaves the
  gallery or categories as they are). The function (`private.apply_product_draft_values`) keeps
  each variant row whose attribute term set matches (id, order item links, cart lines, scheduled
  prices) and writes what `updateProduct()` wrote, in its order, except the stock: since 02044 the
  values carry `stock_baseline` (serialized SKU-trimmed, whole quantities only; null without one),
  and the function, once it has locked the inventory rows a sale could hold against it, leaves a
  SKU's `inventory_items` row alone when the draft's quantity equals the loaded one or the current
  one, applies the difference to the current quantity otherwise (a sale made while the page was
  open stays sold), writes a SKU the baseline lacks as typed, refuses a quantity that is not a
  number, plain decimal text or null (NBP04), and answers `stock_adjusted` (`already_live`,
  `moved`), which the app warns of (docs/09 → "Stock: only what the editor changed"). Since 02047
  the baseline may hold a null entry (a SKU the live product stocks that the draft's baseline lacks,
  which the app's publish adds) and the values carry `stock_baseline_publish_count` (whole numbers
  only, else null): below the product's count in `public.product_stock_publishes`, which the
  function rewrites on every product-values publish, a SKU whose entry the last publish used counts
  from the figure that publish entered (`already_published` when equal, `from_last_publish` on an
  entry so counted). The sale's deduction takes an order's SKUs in the order the publish locks
  them in, since 02044, and since 02046 reads its lines once, takes every row in one statement,
  then deducts in one: keep
  `applyOrderInventoryDeductionViaSql` (`order-inventory.ts`) running the same three statements
  (`order-inventory.test.ts`).
- Every write of `inventory_items` takes its rows in SKU order in one statement (migration 02046;
  a publish and a sale lock them in that order, the column's collation, which a JavaScript sort
  does not reproduce): write through `upsertInventoryRows` (`shared-inventory.ts`, which calls
  `public.upsert_inventory_items`, retries a write that lost a lock race and falls back to the
  PostgREST upsert where the function is unknown), never `.from('inventory_items')` with several
  rows. `createProduct()` runs every step after its product RPC and throws
  `ProductCreatedIncompleteError` (product id, failed steps) for a product it created but could not
  finish; `createProductAction` then opens its edit page with `?created_incomplete=`
  (`buildProductCreatedIncompleteNotice`), never a failed create.
  A field added to the values changes both sides: `tools/scripts/product-draft-publish.db.test.ts`
  runs the builder against the function on a real database. `updateProduct()` is not the publish
  path any more (nothing in the app calls it; its RPC still re-creates every variant, and with
  `syncSharedInventoryForSavedProduct` it writes every quantity it is handed).
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
  until a toggle rebuilds the list. A list field that is not a list loads empty (`listOrEmpty`,
  `repairLoadedVariants`), and variation attributes, a variant's label and key, and its options
  load only as the form can read them (`readVariationAttributes`, `isReadableVariantOption`; else
  from its terms), as `buildVariantSku` reads only text: each threw on mount or blocked every
  autosave (`ProductForm.list-fields.test.tsx`). `serializeVariantsForRpc` passes a variant list
  that is not a list on for the function to refuse (NBP04), never as no variants, which would
  delete every live variant.
- `VariationsEditor` regenerates only when the selected terms change, by value (a currency change
  would too, but ProductForm remounts it on that reset): never on open or on the product's SKU,
  prices or sale, and only deselecting the last term empties the list (`VariationsEditor.test.tsx`).
  It opens on the variation attributes it can read and, when none selects a term, on the selection
  the variants' own options make, as `ProductForm`'s change check assumes.
  `generateVariantDrafts` keeps an existing variant's own price maps and sale, an empty one
  included (`previous ? previous.x ?? <empty> : base`, never `previous?.x ?? base`); only a new
  combination takes the form's amounts as they are, and the product's sale window only with a sale
  amount (`variation-utils.test.ts`).
- The product page (`ProductDetailsLayout`) shows a selected variant's own resolved sale price
  (`null`: no sale), the one Stripe checkout charges, never the product's; the product's only with
  no variant selected (`ProductDetailsLayout.test.tsx`).
- `updateProduct()` and the draft publish never delete media: the gallery is one upsert of the
  listed images (deduplicated, only ids that still have a media row) and one unlink of the rest,
  each checked in `updateProduct()` (the ids resolved before its first write) and inside the
  publish's transaction; a top-level `media_id` and `explicitly_removed_media_ids` are ignored
  (`buildProductDraftPublishValues` has no field for either). Never add media deletion to a save
  path: image blocks, section backgrounds, text blocks and the social image keep their own copy of a
  key that no foreign key tracks, and a save's values can be a draft any WRITER can write
  (`product-actions.test.ts`, `product-drafts-media-removal.test.ts`, security-verify.sql section 44).
- A gallery has one reading, `product-gallery.ts` (import-free, subpath `/product-gallery`):
  `normalizeProductGallery` (the list's order, ids lowercased and once, uuids only; an entry's
  `sort_order` and embedded `media` count for nothing) for `updateProduct()`, the form's draft save
  (`toProductGalleryDraftEntries`: bare `{ media_id }`) and the app's edit page and draft checks;
  `publish_product_draft` reads `gallery_media_ids` by the same rules in SQL (02043), then keeps only
  ids with a media row, as the edit page draws only those (a `product_media` that is not a list
  publishes no gallery: the live one stays, and the edit page shows it);
  `orderProductGalleryEntries` for the order ProductForm shows and saves. Never draw a tile from a
  draft's own entry, or read a gallery another way: the edit page once showed a WRITER-written
  draft's embedded live images while publish wrote another main image (the app's
  `gallery-parity.test.tsx`).
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
- `npx nx build ecommerce` copies the raw `package.json` into a clean dist; only the release
  build (`tools/scripts/lib/release-steps.js`, run by `release-all.js` and `release-lib.js`) writes
  the exports map. Validate commerce changes at the app level.
- The cart's `affiliateRef` (the Affiliates storefront token) lives exactly as long as the cart:
  set items through `withCartItems` (`cart-store.ts`) so every path that empties the cart drops
  it, and keep `pendingAffiliateRef` (a storefront link's token, promoted by the next successful
  add) out of `partialize`. `cart-store.test.ts` covers both (docs/15 → "The storefront token").
- An attributed order records its payment mode (`affiliate_livemode`): Stripe from the secret
  key's prefix (`stripeSecretKeyLivemode()`), Freemius from `FREEMIUS_SANDBOX_ENABLED`, read once
  per checkout. A test-mode sale is then only ever paid out by a test-mode transfer.

Commands: `npx vitest run libs/ecommerce`, `npx nx lint ecommerce`, `npx nx run ecommerce:build`
(excluded from `lib-builds` on purpose); `npm run build:ecom` publishes.
