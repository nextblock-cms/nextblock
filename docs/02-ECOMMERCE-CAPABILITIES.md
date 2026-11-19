# 02 Ecommerce Capabilities

## Scope and Source of Truth

The commerce feature set is implemented across:

- `libs/ecommerce/src/lib/*`
- `libs/db/src/supabase/migrations/00000000000003` through `00000000000006`
- `apps/nextblock/app/api/checkout/route.ts`
- `apps/nextblock/app/api/webhooks/*`
- `apps/nextblock/app/cms/products`, `orders`, `shipping`, `payments`, and
  `settings/taxes`

In workspace code, the developer-facing import paths are:

- `@nextblock-cms/ecommerce`
- `@nextblock-cms/ecommerce/server`
- `@nextblock-cms/ecommerce/actions`

One packaging discrepancy exists today: `libs/ecommerce/package.json` is still
named `@nextblock-cms/ecom`, while the workspace (tsconfig paths) and every scaffold's
`package.json` (`"@nextblock-cms/ecommerce": "npm:@nextblock-cms/ecom@latest"`) expose it as
`@nextblock-cms/ecommerce`.

## Commerce Data Model

The commerce schema spans:

- Catalog: `products`, `product_media`, `product_attributes`,
  `product_attribute_terms`, `product_variants`,
  `variant_attribute_mapping`, `categories`, `product_categories`
  (categories and their translations were added by migrations
  `00000000000019` and `00000000000020`)
- Inventory and licensing: `inventory_items`, `package_activations`,
  `freemius_plans`, `freemius_pricing`
- Checkout and fulfillment: `orders`, `order_items`, `shipping_zones`,
  `shipping_zone_locations`, `shipping_zone_methods`, `tax_rates`,
  `currencies`

With the Affiliates package (migration `02030`), `orders` also carries `affiliate_id` (the
partner credited, `ON DELETE SET NULL`), `affiliate_source` (`storefront` or `referral_link`),
`affiliate_base_currency` (the store default currency at checkout, the commission currency) and
`affiliate_livemode` (the payment mode: false for a Stripe test key or the Freemius sandbox, true
for live, NULL when unknown and treated as live). Both providers write them only when checkout
resolved an attribution. `affiliate_refunded_minor` and `affiliate_refund_total_minor` are
written by the refund webhooks, not by checkout: a partial refund that arrives before the order
has a commission is kept there and taken off when the commission is recorded. See
[15-AFFILIATES-AND-STOREFRONTS.md](./15-AFFILIATES-AND-STOREFRONTS.md) → "Attribution".

`products` can be physical or digital. The current provider selection logic
resolves:

- physical -> Stripe
- digital -> Freemius

Mixed-provider carts are rejected by `app/api/checkout/route.ts`.

## Multi-Currency

The multi-currency implementation is real and fairly deep.

### Store currencies

`currencies` stores:

- ISO code and symbol
- exchange rate relative to the current store default
- default and active flags
- rounding mode, rounding increment, and optional charm ending
- automatic FX refresh flag
- automatic product price sync flag
- last exchange-rate source and refresh timestamp

Supported rounding modes in code are:

- `none`
- `nearest`
- `up`
- `down`
- `charm`

### Product and variant pricing

Products and variants support:

- legacy single-currency `price` and `sale_price`
- multi-currency `prices` and `sale_prices`

The pricing helpers resolve amounts by:

1. looking for an explicit amount in the selected currency
2. falling back to the base price
3. converting from the default currency when store-managed auto-sync pricing is
   enabled

The CMS product editor respects that distinction. Store-managed currencies can
be displayed in forms, but their saved overrides are stripped before
persisting.

### Scheduled sales, price changes, and promotions

Products and variants carry a scheduled-pricing layer (migration
`libs/db/src/supabase/migrations/02001_baseline_schema.sql` (originally `00000000000025_add_sale_schedule_columns`, folded in by the generation-2 squash)):

- `sale_start_at` / `sale_end_at` — the time window during which `sale_price` /
  `sale_prices` apply. Both null = always-on (back-compat with static sales).
- `scheduled_price` / `scheduled_prices` / `scheduled_price_at` — a pending,
  permanent regular-price change applied once `scheduled_price_at` passes
  (bulk/Stripe-oriented; Freemius regular prices are owned by Freemius).
- `product_freemius_sale_coupons` — maps a product to an auto-generated,
  time-bounded Freemius coupon so a scheduled Freemius sale is actually enforced
  at Freemius-hosted checkout (Freemius enforces the coupon's start/end dates).

**Enforcement is read-time, not cron-driven.** The helpers in
`libs/ecommerce/src/lib/currency.ts` decide what applies *now*:

- `isSaleWindowActive({ saleStartAt, saleEndAt, now })`
- `resolveEffectivePriceForCurrency({ ..., saleStartAt, saleEndAt, scheduledPrice*, now })`
  — wraps `resolvePriceForCurrency`, gating the sale by its window and swapping in
  a due scheduled price. A sale outside its window resolves to `sale_price: null`.

Every place that computes a payable or displayed amount goes through the
window-aware helper: checkout providers (`providers/stripe.ts`,
`providers/freemius.ts`), cart/tax/coupon math, and storefront components
(`ProductCard`, `FeaturedProduct`, `ProductDetailsLayout`, UCP). One exception
is a known follow-up: the product page's JSON-LD offer price
(`app/product/[slug]/page.tsx`) is the product row's `sale_price ?? price`,
whatever the sale window and the variants. The CMS edit form exposes the window
per-product and per-variant (`SaleScheduleFields`); the bulk **Promotions** admin
(`/cms/promotions`, `apps/nextblock/lib/promotions/`) imports/exports sales and
price changes via CSV.

> **Gotchas for future agents (these caused real revert/display bugs):**
>
> 1. **`generateVariantDrafts` (`variation-utils.ts`) must carry over every
>    per-variant field**, including `sale_start_at`/`sale_end_at`, and keep an
>    existing variant's own price maps, sale and sale window even when they
>    are empty (a variant without a sale price keeps none; an empty SKU, by
>    contrast, is rebuilt from the product's SKU and the term slugs). The
>    variations editor re-runs it only when the selected terms change (a
>    toggle, compared by value), never on open or on a change to the product's
>    SKU, prices or sale (a currency change would, but `ProductForm` remounts
>    the editor on that reset); an omitted field resets and is then autosaved
>    away ("dates revert after publish"). Only a new combination takes the
>    product's values: its form amounts as they are (never `normalizePriceMap`,
>    which is for minor units and rounds), and the product's sale window only
>    with a sale amount.
> 2. **Storefront block mappers must pass the window through** on *both* the
>    product and each variant — `ProductGridBlock`, `FeaturedProductBlock`,
>    `app/product/[slug]/page.tsx`. If the window is dropped, `isSaleWindowActive`
>    sees both bounds null and treats the sale as always-on, so an inactive sale
>    price shows (e.g. a "$25 – $32" range before the sale starts).
> 3. **`getVariantEffectivePriceRange` is window-aware** — pass
>    `sale_start_at`/`sale_end_at` per variant or it ignores the schedule.
> 4. **Persisting on publish writes the window across the SKU.** A product
>    draft publishes through `publish_product_draft` (migration 02043, one
>    transaction: docs/09 → "Publishing: one transaction"), which writes the
>    product's sale price and window to every product sharing its SKU and each
>    variant's to the variants sharing its SKU, as `persistProductSaleSchedule`
>    (`product-actions.ts`) does after `upsert_product_with_variants` for
>    `updateProduct()`, which the app no longer calls.
> 5. **Autosave must not `reset()` the form or revalidate the edit route.** The
>    edit-form autosave (`ProductForm.tsx`) uses a serialized-snapshot guard to
>    avoid a render loop; `updateProductAction` writes only the draft (no
>    `revalidatePath`). Re-rendering mid-edit resets native datetime inputs.

### FX sync and rebasing

`libs/ecommerce/src/lib/currency-sync.ts` implements two separate operations:

- `syncStoreCurrencyRates()`: pulls fresh FX rates from `https://api.frankfurter.dev`
  unless `FX_API_BASE_URL` overrides the provider.
- `rebaseStoreCurrencyExchangeRates()`: when an admin changes the default
  currency, every stored rate is rebased so the new default becomes `1`.

The app exposes both through:

- CMS currency settings actions in
  `apps/nextblock/app/cms/settings/currencies/actions.ts`
- a daily background refresh from the CMS layout
  (`apps/nextblock/lib/commerce/currency-rates-refresh.ts`, `after()`-based so it needs
  no cron), active only while the ecommerce package is on
- `GET /api/cron/sync-currencies`, guarded by `CRON_SECRET` when it is set (constant-time
  compare, `isCronRequestAuthorized()` in `apps/nextblock/lib/cron/cron-secret.ts`), for
  operators who prefer an explicit external schedule (it is no longer declared in `vercel.json`)

## Tax Calculation

Tax behavior is driven by the `ecommerce_inventory_settings` site setting,
loaded through `getEcommerceInventorySettings()`.

The current settings shape is:

- `trackQuantities`
- `enableTaxes`
- `taxCalculationMode`

Supported tax modes are:

- `manual`
- `automatic`

### Manual mode

Manual mode uses `tax_rates` rows keyed by country and optional state/province.
Multiple rows can exist for the same jurisdiction, so stacked taxes such as GST
plus PST are supported.

During checkout:

- only taxable products are included
- the destination is normalized from shipping or billing data
- matching `tax_rates` are loaded
- tax lines are calculated and stored in `orders.tax_details`

### Automatic mode

Automatic mode defers final tax calculation to Stripe Tax.

In this mode:

- checkout still records a tax intent in `orders.tax_details`
- the Stripe provider marks product and shipping tax codes on line items
- the webhook resync step replaces provisional tax data with finalized Stripe
  checkout data

## Shipping Zones and Rate Resolution

Shipping is backed by:

- `shipping_zones`
- `shipping_zone_locations`
- `shipping_zone_methods`

Each method stores:

- base amount and currency
- localized names
- per-currency amount maps and threshold maps
- `currency_pricing_mode` of `auto` or `manual`

### Current resolver behavior

`libs/ecommerce/src/lib/shipping/resolver.ts` currently:

1. loads active currencies
2. queries zone locations by destination country
3. prefers a state match when one exists
4. otherwise prefers a country-wide match
5. otherwise falls back to the first zone by `priority_order`
6. filters methods by the cart total and minimum threshold
7. converts method prices into the shopper currency
8. returns only the cheapest valid method

Important implementation detail: `shipping_zone_locations.postal_code` exists in
schema, but the current resolver does not yet use postal code matching during
runtime resolution.

The storefront calls this through
`libs/ecommerce/src/lib/server-actions/shipping-actions.ts`.

## Stripe Integration

Stripe is the current payment flow for physical products.

The keys are entered once, under CMS → Payments (`site_settings` `payment_public` /
`payment_secret`, DB first), with `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` and
`STRIPE_WEBHOOK_SECRET` as env fallbacks (`libs/ecommerce/src/lib/payment-config.ts`). The same
Stripe account and secret key also pay affiliate partners: payouts are Stripe Connect transfers
from the platform balance, including the commissions on Freemius sales (Freemius pays the store,
never the partners). Payouts need only the secret key; the publishable key and the webhook secret
serve checkout and refunds. So a store that sells only digital products still needs a Stripe
secret key to run the partner program while its Freemius sales' commissions go through Stripe
Connect (the default routing, `affiliates_settings.payoutMethods`, 02036/02037). The Payments
screen follows that routing: the app passes `PaymentsPage({ partnerPayouts, digitalPartnerPayouts })`,
`partnerPayouts` when the program is active and at least one sale type is paid through Stripe
Connect (`affiliateGatewaysPaidByStripe`), `digitalPartnerPayouts` when Freemius sales are among
them (unreadable settings count as the default routing). A store that pays every gateway by hand or
with PayPal (its payout run never calls Stripe), like one without the add-on, sees the plain
"Stripe (physical products)" heading; one that pays only physical sales through Stripe Connect is
told digital commissions are paid outside Stripe. CMS → Affiliates
→ Stripe payouts shows the key facts (`getStripeKeyDiagnostics()`: source, mode, last 4
characters, the publishable key's mode, the webhook secret) and runs a read-only connection test
(docs/15 → "The CMS screens"). The event list the endpoint must send is
`STRIPE_REQUIRED_WEBHOOK_EVENTS` (`stripe/webhook-events.ts`), shared by the Payments screen and
that test. Locally, `stripe listen --events <those six events, comma-separated> --forward-to
localhost:<port>/api/webhooks/stripe` forwards them (`stripeCliListenCommand()` builds it, and
`npm run stripe` runs it for port 4200 in the monorepo); current Stripe CLI versions refuse
`stripe listen` without `--events`. Its printed `whsec_…` secret is then the webhook secret.

### Checkout flow

`app/api/checkout/route.ts`:

- verifies the ecommerce package is active
- rejects carts without provider-aware items
- rejects mixed-provider carts
- requires a billing address
- refuses before any provider write when the provider is not ready (`getProviderReadiness`, the
  store's one readiness predicate): the keyed 503 `ecommerce.checkout_payments_unavailable`. Its log
  line ("Checkout blocked: … is not ready (missing: …)") is written at most once a minute per
  provider and missing set, because the route is public and such a store refuses every POST
- resolves the provider through `getPaymentProvider()`

`StripeProvider.createCheckoutSession()` then:

- loads currencies and store settings
- validates products and variants against the database
- validates inventory before session creation when quantity tracking is enabled
- resolves shipping cost from the selected shipping method
- calculates tax in manual or automatic mode
- upserts a Stripe customer when an email is available
- inserts a pending `orders` row plus `order_items` (with the affiliate attribution columns when
  an attribution was resolved; the insert is retried without them on an install that lacks
  them)
- stores currency, subtotal, shipping, tax, and exchange-rate data
- creates the Stripe Checkout Session and stores `stripe_session_id` on the order before it
  returns the URL (the success page finds a Stripe order only through that column); when that write
  fails (an error, or no row updated) it expires the session, marks the order `failed` and answers
  the keyed 503 `ecommerce.checkout_payments_unavailable` instead of the URL. The session sets
  `payment_intent_data.metadata.orderId` (so a refund can find the order) and
  `metadata.affiliateId` when the order is attributed

### Webhook flow

The Stripe webhook endpoint must send these events (CMS → Payments lists them):

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `charge.refunded`
- `charge.dispute.created`
- `charge.dispute.closed`

> **Upgrade note.** Endpoints created before the Affiliates release must add
> `charge.refunded`, `charge.dispute.created` and `charge.dispute.closed` in the Stripe
> dashboard; until then refunds and lost disputes reach neither the order status nor the
> affiliate commissions, and an open dispute never holds a commission. Locally, `npm run stripe`
> forwards exactly these events.

`app/api/webhooks/stripe/route.ts` passes the raw body to
`handleStripeWebhook()`, which verifies the signature and returns the verified event.

On a settled `checkout.session.completed` or `checkout.session.async_payment_succeeded` (the
payment has arrived), the sync layer:

- reloads the session with tax breakdown details
- finds the existing order (by the session's `metadata.orderId`, else by `stripe_session_id`)
- stores payment intent, customer details, and finalized totals
- normalizes tax details from Stripe
- updates saved customer addresses
- assigns invoice metadata (this sets `paid_at`, which records an attributed order's affiliate
  commission through the `orders` trigger)
- applies inventory deduction

`syncStripeOrderFromSession` never moves a `refunded` or `shipped` order back to `paid`, so a
replayed event or a success-page revisit cannot revive it.

Refunds and disputes are applied by the app route itself (`syncStripeOrderRefundFromEvent`,
`syncStripeOrderDisputeFromEvent` and `lib/affiliates/refunds.ts`):

- The order is found by `payment_intent_id`, else by the `orderId` metadata of the charge or its
  PaymentIntent.
- `charge.refunded` with the whole charge refunded (`refunded === true` or
  `amount_refunded >= amount`), or `charge.dispute.closed` with `status === 'lost'`, moves a paid
  or shipped order to `refunded` in one conditional update. Other statuses are left alone.
- `apply_affiliate_refund` then voids or reduces the commission on every refund, whatever the
  Affiliates package state: full refunds void it, partial refunds reduce it pro rata from the
  charge's cumulative `amount_refunded`, measured on the charge without its shipping share, and a
  refund after the commission was paid out raises an alert.
- An opened dispute (`charge.dispute.created`) holds the order's affiliate commission, and one
  closed without a loss releases it; the order status does not change.
- A failure answers 500, so Stripe redelivers.

## NextBlock package purchases (vendor side)

NextBlock's own premium packages (Commerce Pro 24851, Cortex AI 28609, Affiliates 43273) are sold through
Freemius as well, and every CMS can buy them from `/cms/settings/packages`. The buyer's
CMS cannot read the license key from the checkout callback, so the vendor deployment
(nextblock.dev) exposes `POST /api/packages/claim-license` — enabled only with
`NEXTBLOCK_LICENSE_CLAIM_ENABLED=true` and the vendor's Freemius developer key pair, which
reaches all three products (see "Freemius keys" below), never on the public sandbox (404 before it
reads the request), limited per client network, per license and per instance — which verifies the claim
(`claimFreemiusLicenseKey` in `libs/ecommerce/src/lib/freemius-license-claim.ts`) and
returns the key so the buyer's install activates automatically. Details:
docs/08 → "Buying from the dashboard".

## Freemius Licensing and Product Sync

Freemius currently handles digital-product checkout and product synchronization.

### Freemius keys (CMS → Payments)

**One developer key pair covers every product.** Freemius gives the developer account a key pair
(My Profile → Keys) that reaches every product of the account at developer scope. Enter it under
CMS → Payments (Developer ID, developer public key, developer secret key; the secret is sealed for
`payment_secret.freemiusDeveloperSecretKey`) or set `FREEMIUS_DEVELOPER_ID`,
`FREEMIUS_DEVELOPER_PUBLIC_KEY` and `FREEMIUS_DEVELOPER_SECRET_KEY`. With it no product needs keys
of its own: `libs/ecommerce/src/lib/freemius-developer-api.ts` reads each product's public and
secret keys on demand (`getFreemiusProductKeys`: `GET /v1/developers/{dev}/plugins/{product}.json`,
kept in memory ten minutes, never persisted or logged) and does the post-sale work at developer
scope (`freemiusDeveloperRequest`, paths under `/v1/developers/{dev}/plugins/{product}/`):

| Work | What it uses |
|---|---|
| Checkout public key, Freemius sandbox token | the product's keys (`resolveFreemiusProductCredentials`, source `developer-api`) |
| Webhook signature | HMAC with the secret of the event's `plugin_id` product, and no other; an event without one is refused (`getFreemiusWebhookVerification`, below) |
| Checkout verification, order status | `licenses/{l}.json`, `licenses/{l}/subscription.json` (404: none), `users/{u}.json` |
| License key on orders (cached, "License keys on order pages"), vendor claim | `licenses/{l}.json`, `users/{u}.json` |
| Trials | `users.json?email=`, `users/{u}/licenses.json`, `plans/{plan}/pricing.json`, POST `plans/{plan}/pricing/{id}/licenses.json`, PUT `licenses.json` |
| Coupons | POST, PUT, DELETE `coupons[/{id}].json`, pushed only by an ADMIN past the second factor (below) |

A pair is used only once Freemius accepts it: `resolveVerifiedDeveloper` lists the account's
products (`plugins.json`) and caches the verdict for ten minutes, per pair and Developer ID (a
changed ID is checked afresh). A 401/403 or another 4xx is a refusal, checked again after ten
minutes. So is a 404 on the first page of that list (no such developer for these keys, such as a
wrong Developer ID) for a pair with no working verdict on record: its first check, or after a
refusal, a Sync or a key save. A pair on record as working is refused only at a second first-page
404 in a row, at least 30 seconds after the first, which counts as unanswered (an answered list
ends the run, an unanswered check does not): one misrouted 404 took every Freemius flow offline for
ten minutes. A 429, a 5xx, a timeout, a 404 on a later page, or a 2xx whose body is not a product
list (an HTML page, an empty body, `{}`, `{"plugins": null}`) is Freemius failing to answer. A
check that goes unanswered keeps the last verdict and its list (a working pair keeps working, a
refused one stays refused) and is retried after 30 seconds; only a first check that goes unanswered
reads `unreachable`.

The candidates, most authoritative first (`resolveFreemiusDeveloperCredentialCandidates` in
`payment-config.ts`): the CMS developer fields, the developer env names, then the single-product
names, CMS and env. Installs that run Sync from Freemius kept the developer pair under
`FREEMIUS_PUBLIC_KEY` / `FREEMIUS_SECRET_KEY`, and those names stay a supported home for it: the env
value is read as the deployment set it, even after `hydrateFreemiusEnvFromDb` wrote the CMS
single-product keys over the same names, and the Payments screen only says the pair comes from
there. It asks to move a pair only out of the CMS one-product fields, under the developer fields.
The key policy below keeps a pair it knows from opening checkouts or verifying webhooks as a
product's keys: one that works, one that shares a key with a dedicated pair, or one Freemius
accepted earlier in this instance's life. For the product `FREEMIUS_PRODUCT_ID` binds, the one gap
is an instance that has not yet seen Freemius accept that pair: one started after a revocation, or
one whose developer checks Freemius has not answered yet (a cold start during a throttle or an
outage). So set no Product ID while the pair sits in the one-product names; to put one product's
keys there (with its Product ID), first move the pair to the developer names (the 0.23.4 upgrade
notes say how). After you rotate the developer pair, delete the old one from every field, the
one-product names included.
A route still on the synchronous check accepts that secret in any state ("Webhook flow").

**Removing a stored key.** A blank field keeps its stored secret. To delete one, tick the remove
box CMS → Payments shows under each stored secret (the developer secret key, the one-product secret
key and API key, the Stripe secret key and webhook signing secret) and save:
`savePaymentCredentials` deletes it from `payment_secret` (`remove`, behind `requireEcomAdmin()`;
refused on the public sandbox, and when the row cannot be read), and a key typed into the same
field replaces it instead. Removing a secret, or clearing a public field (Product ID, public key,
Developer ID), gives its `FREEMIUS_*` name back to the deployment's own value, or deletes the name
when the deployment set none, at each instance's next `hydrateFreemiusEnvFromDb` once its
60-second cache of the payment rows expires; until 0.23.4 the old value stayed in `process.env`
until the process restarted. A value hydration did not write is never touched, and a failed read
takes nothing back. An env name that still holds the old key keeps applying, so clear those too.

A product the account does not list is never read (a webhook's `plugin_id` only chooses among the
account's own products). An id the list lacks re-reads it at most once a minute, whatever Freemius
answers, so a product added in Freemius works after that re-read, or at once after a Sync, which
drops the cached list. An id missing from a list whose latest re-read went unanswered (or is
throttled right after one) never reads as "not owned": `getFreemiusProductKeys` throws
`unavailable`, so a webhook answers 503 (`product_key_read_failed`, logged) and checkout uses only
the product's bound keys. While the pair works, `null` from it is an answer Freemius gave: a
product list (not just any 2xx, above) that lacks the id, or no keys for a product the list holds
(a 401/403/404 to its read, or that product's object without keys), which the policy below treats
as owned.

When Freemius fails to answer a product read (429, 5xx, a timeout, or a 2xx that is not that
product: no object, no `id`, another product's `id`), the last keys it returned stay in use and it
is asked again after 30 seconds. An unanswered read is remembered and concurrent reads share one
request, so forged webhooks reach Freemius at most once a window; a `maxAgeMs`
re-read (a rotated secret) goes out at most once a minute per product and throws rather than pass
the old keys off as fresh. Checkout keeps the last public key with no limit, but a webhook accepts
the last secret for `FREEMIUS_WEBHOOK_SECRET_MAX_AGE_MS` at most: the ten-minute TTL plus one hour,
70 minutes after Freemius last returned it. A secret rotated because it leaked must not keep
verifying forged payments and refunds while reads fail, and the shared developer key can be pushed
into 429s on purpose. Past that only the product's bound secrets verify its events; otherwise they
answer 503 (`product_key_read_failed`) until Freemius answers.

Requests are signed like the official PHP SDK (`signFreemiusRequest`: HMAC-SHA256 of the method,
Content-MD5, Content-Type, Date and the path without its query string; base64url of the hex digest;
`FS <dev>:<public>:<signature>`; `freemius-developer-api.test.ts` holds vectors computed with the
SDK's own code). Every id in a path is digits only (`toFreemiusId`), redirects are refused, answers
are capped at 4 MB and never cached by Next. Failures are a `FreemiusApiError`: `auth` (401/403, a
configuration problem), `not_found` (404), `rejected` (another 4xx, recorded as Freemius words it)
or `unavailable` (429, 5xx, network).

**The product keys remain the fallback**, for installs without a developer pair and for products of
another Freemius account: the screen's one-product fields (`FREEMIUS_PUBLIC_KEY`,
`FREEMIUS_SECRET_KEY`, `FREEMIUS_API_KEY` after hydration), `FREEMIUS_CHECKOUT_PRODUCTS_JSON` for more
products, and the bearer `@freemius/sdk` calls. CMS → Payments folds those fields into a closed
"One product’s keys (optional)" section while the developer pair works and none of them holds a
value (Product ID, public key, a stored secret or API key); otherwise it stays open. The closed
section still posts its fields, all blank, so a save changes nothing there. A 401/403 on the
developer pair, which refuses
before anything is written, hands a read or a coupon write over to them; a trial does so only before
its license exists. A `FREEMIUS_CHECKOUT_PRODUCTS_JSON` that is not JSON holds no entries, and is
logged once per value with the error's name and position only: V8's message quotes the text around
the fault, which can be part of a key.

**Which keys a product may use is one policy** (`freemius-key-policy.ts`), which checkout
(`resolveFreemiusProductCredentials`) and the webhook check (`getFreemiusWebhookVerification`) both
follow, so a key opens a product's checkout exactly when it may verify that product's webhooks:

1. Its own keys, read with the developer pair when the account owns the product. A webhook of an
   owned product is checked against them and nothing else while that read works (a mismatch
   re-reads them at most once a minute, for a rotated secret).
2. Its bound keys: its `FREEMIUS_CHECKOUT_PRODUCTS_JSON` entry, always (an entry is all the
   product has: one without a `publicKey` opens no checkout), or the one-product keys when
   `FREEMIUS_PRODUCT_ID` names it (their sandbox overrides in Freemius sandbox mode, each key set
   judged on its own), unless `freemiusKeysMayBeDeveloperPair` says they are, or may be, a
   developer pair: the working pair comes from the one-product names and holds one of their keys,
   a dedicated pair holds one, or Freemius accepted one at developer scope earlier in this
   instance's life (SHA-256 per key, memory only: it outlives a Sync, a save and a changed
   Developer ID, and a cold start forgets it). It reads configuration and memory only, so a binding
   it leaves standing works offline, and it refuses when those facts cannot be read. After a
   failed read in step 1, nothing else.
3. The one-product keys standing in for a product with no bound keys (no entry, Product ID empty),
   by the developer pair's state (`decideFreemiusOneProductStandIn`):
   - no pair (`missing`), or the public sandbox: yes, as on a one-product install;
   - `working`: only for a product the account does not own, as an answered list shows; never when
     the working pair comes from the one-product names (they ARE the developer pair, as on
     nextblock.dev today) or when they are, or may be, a developer pair (step 2's predicate);
   - `refused`: only when every configured pair is made of the one-product names (a one-product
     install that also filled in its Developer ID), Freemius never accepted those keys at
     developer scope in this instance's life, and Freemius confirms they are this product's own
     (below). Never while a dedicated pair (the CMS developer fields, `FREEMIUS_DEVELOPER_*`) is
     refused, so a rotated or revoked pair never lets the one-product secret verify every
     product's webhooks;
   - `unreachable`, or a state that cannot be read: never.

The confirmation (`confirmFreemiusOneProductKeys`) is the only request signed with the one-product
keys: `GET /v1/plugins/{product}.json` at that product's own scope (`FS <product>:<public>:<sig>`),
so a revoked developer pair left under those names stands in for no product unless Freemius
answers it there as that product's own keys. Only a 200 that is the product confirms them: an
object naming that product's `id` (and that public key, when the answer has one) with no `error`
member. A 401/403/404, or an answer naming another product or public key, refuses them; either
answer is kept ten minutes per product and keys. A body with an `error` member is an error
whatever the HTTP status, as the PHP SDK reads it: one stating 401, 403 or 404 (`error.http`, or a
numeric `error.code`) refuses, any other is unknown. A 429, a 5xx, a timeout or any other answer
that is not the product (`{}`, `{"id": null}`, a list) is unknown, asked again after 30 seconds,
and keeps an earlier confirmation for `FREEMIUS_WEBHOOK_SECRET_MAX_AGE_MS` at most: a 200 `{}` used
to confirm a revoked pair for every product. Product ids reach it from webhooks signed with those
keys, so each instance sends at most 10 a minute (past that the answer is unknown and nothing is
sent; a re-check of confirmed keys always goes), keeps 64 answers at most (a current confirmation
is dropped last), shares concurrent requests and sends nothing on the public sandbox. A webhook
asks only once its signature matches the one-product secret.

Otherwise the product has no configured keys: its checkout answers the keyed 503 before any write
("Checkout behavior"), and its webhooks answer 401, or 503 when the developer pair owns or may own
the product, is refused or cannot be asked, or Freemius did not answer whether the one-product keys
an event matches are this product's ("Webhook flow").

The global Product ID is optional: checkout, orders, licenses, coupons and webhooks use the
`freemius_product_id` / `freemius_plan_id` saved on each product. Fill it in
(`FREEMIUS_PRODUCT_ID`), or give the product a JSON entry, whenever the one-product fields hold a
product's keys, a product outside the developer account included: bound keys work for that product
only, need no confirmation and keep working while Freemius is slow or throttled, where a stand-in
waits on the developer pair's state (and, for a product outside the account, on an answered product
list: while a re-read goes unanswered its checkout and webhooks answer 503). Leave it empty only on
a one-product store without a Developer ID, where the keys stand in for every product. The
developer pair belongs in the developer fields, never in the one-product fields. With the Product
ID set, another product without an entry, and without a developer pair that reaches it, has no
configured keys: its checkout answers the keyed 503 and its webhooks are refused (401, or 503 while
a configured developer pair is refused or cannot be asked). The screen says this beside the
fields.

Readiness (`getPaymentConfigStatus`, the one predicate behind `pages/cms/payments/queries.ts`)
needs the one-product public and secret keys, or a configured developer pair, and never waits on
Freemius, because it runs during public renders (buy buttons, product pages, the checkout
preflight). It asks `getFreemiusDeveloperStatus({ wait: false })`, which answers from memory and
checks the pair after the response (`after()`): a `working`, `unchecked` (never checked yet) or
`unreachable` pair reads as ready, a `refused` or `missing` one does not, and on the public sandbox
a configured env pair is enough (its checkout is simulated). With the one-product keys set it reads
not ready in one state only, known from memory: the Product ID is empty (CMS and env), the JSON has
no entry with a `publicKey`, a dedicated pair is configured and the developer status is `refused`,
so the policy lets those keys open no checkout at all (missing: "Developer key pair Freemius
accepts, or a Product ID"). A JSON entry without a `publicKey` counts only through the pair: it
opens its product's checkout only with keys the developer pair reads, and it keeps the one-product
keys from standing in for that product. It asks about the pair only when a dedicated one exists.
CMS → Payments awaits the blocking `getFreemiusDeveloperStatus()` first and only then reads
readiness. Its toggle action keeps the readiness its render saw, and otherwise, on the first visit
after a cold start or after a key save (which forgets the verdicts), a pair Freemius refuses would
read as unchecked, so ready, and the admin could switch Freemius on with it.

**Coupon pushes need an ADMIN past the second factor.** A push (`syncCouponToFreemius`,
`syncProductSaleCouponToFreemius`, `deleteCouponFromFreemius`) is signed with the developer pair,
and a coupon with no product scope applies to every product of the account. Every path that
reaches one awaits `requireEcomAdmin()` / `requireCmsAdmin()` before any call toward the push: the
CMS coupon actions, the promotions import (`/cms/promotions`), `createProductAction` and the visual
editor's product publish, which checks first whatever the draft holds (only a product-values draft
sends product values to `publish_product_draft` and reaches the push, after the publish commits:
docs/09 → "Product Drafts").
`tools/scripts/server-action-actors.test.ts` enforces it (docs/04 → "A Freemius coupon push needs
a verified admin").

**The public sandbox** uses the pair for its 15-minute reset's store sync only: the catalog reader
(`openFreemiusCatalogReader`: GET, products, plans and pricing only) is the one developer-scope
entry that runs there, and only the reset calls it. Sync from Freemius (`triggerFreemiusSync`,
`triggerSingleProductSync`) refuses there right after the admin check ("Sync from Freemius is
turned off on the public demo; the demo resets every 15 minutes.") and the products page disables
its Sync Full Store button: the sandbox env holds the pair production depends on, and a visitor
clicking or scripting Sync (22 signed GETs a click) could push it into 429s. Every other entry
refuses before it resolves or sends a key ("The Freemius developer key isn't used in the sandbox,
apart from the demo's own 15-minute catalog reset."), and order pages read no license there.
`SANDBOX_GUARDS` pins each refusal with a test that sets the flag, and `findDeveloperKeyProblems`
(`tools/scripts/lib/sandbox-guards.js`, in `security:check`) fails on a request of
`freemius-developer-api.ts` outside a refusal or a listed reader, and on a caller of the reader
outside a refusal or a relay named with its reason (`DEVELOPER_KEY_CALLERS`).

### Checkout behavior

`FreemiusProvider.createCheckoutSession()`:

- only allows one item per checkout
- loads the product from Supabase
- requires `freemius_product_id` and `freemius_plan_id`
- resolves the unit amount with `resolveFreemiusUnitAmount`
  (`libs/ecommerce/src/lib/freemius-pricing-server.ts`), described below
- resolves the product's checkout keys before writing anything (below): with no public key (or,
  in Freemius sandbox mode, no secret key) it answers the keyed 503
  `ecommerce.checkout_payments_unavailable` and leaves no pending order, profile write or coupon
  redemption behind (a developer-scope key read can fail while readiness is green)
- inserts a pending order and order item
- optionally syncs default addresses and profile fields for the current user
- reserves the coupon redemption (`recordCouponRedemption` → `redeem_coupon_atomically`, which
  never gives a slot back) and fails the order when the slot is gone
- builds a Freemius checkout URL with the validated `billing_cycle`, including
  sandbox parameters when enabled

Freemius charges its own plan price for the cycle the checkout opens on, so the
order records that price, not `products.price`. The sync sets `products.price`
to the annual price, falling back to monthly or lifetime only when there is no
annual price, so it is wrong for a monthly purchase. The resolver:

- reads `freemius_pricing` for the plans of the product and its translation
  siblings, picks the active tier with the lowest `license_quota`
  (`ORDER BY license_quota, id`), and uses its `api_*` price, never an
  `override_*` display price
- validates `billing_cycle` (`monthly`, `annual`, `lifetime`). It rejects
  unknown values and cycles the tier has no price for with
  `ecommerce.checkout_invalid_items`. A missing cycle defaults to annual, then
  monthly, then lifetime, matching Freemius and the product page.
- converts from the default currency into the selected one through
  `currency.ts`
- takes an active sale off as the same percent the Freemius sale coupon carries
- falls back to `products.price` / `prices` only when the product has no pricing
  rows

`getCouponQuote` prices Freemius lines with the same resolver, so a percent
coupon is computed on the price of the cycle being bought.
`SubscriptionSelector` uses the same tier rule (`pickFreemiusPricingTier` in
`freemius-pricing.ts`).

Checkout credential sources (`resolveFreemiusProductCredentials`, the key policy of "Freemius
keys"), in order:

- the product's own keys, read with the developer key pair (`developer-api`)
- its bound keys: its JSON entry with a `publicKey` (`product-map`), or, when
  `FREEMIUS_PRODUCT_ID` names the product, the single-product sandbox overrides
  (`single-product-sandbox-env`) or the single-product keys (`single-product-env`), these two only
  when `freemiusKeysMayBeDeveloperPair` says no (otherwise `none`,
  `one_product_keys_are_developer_pair`)
- the one-product keys standing in (`legacy-env`), only where the policy allows it: in the
  legacy-only `refused` state, only after Freemius confirms they are that product's keys
- otherwise none (`none`): the keyed 503 above

A failed developer key read leaves bound keys only, and bound one-product keys count only when they
cannot be a developer pair, so neither a failed read of `plugins/{product}.json` nor a Product ID
opens a checkout with a developer public key this instance knows (working, dedicated, or accepted
by Freemius earlier in its life). For the product `FREEMIUS_PRODUCT_ID` names, the one gap is an
instance that has not yet seen Freemius accept that pair: one started after a revocation, or one
whose developer checks Freemius has not answered yet (a cold start during a throttle or an outage).
So set no Product ID while the pair sits in the one-product names, and after you rotate the
developer pair, delete the old one from every field, the one-product names included
(`freemius-keys-end-to-end.test.ts` pins this residual). The blocked log
line names the product id, the source and the policy reason (enum values, never key material, such
as `one_product_keys_are_developer_pair`, `one_product_keys_not_this_product` or
`one_product_keys_unconfirmed`); it and the key-read warning are written at most once per product
a minute. A product whose JSON entry has no `publicKey`, or one without an entry while
`FREEMIUS_PRODUCT_ID` names another product, gets the 503 rather than another product's keys.

In Freemius sandbox mode the token is the documented MD5 (`buildFreemiusSandboxToken`); the SDK
path runs first only when an API key is configured.

### Checkout sync (browser callback)

`POST /api/checkout/freemius/sync` (`app/api/checkout/freemius/sync/route.ts`) receives the
license the Freemius overlay reports and trusts nothing in the body: the caller must hold the
order access token (an HMAC of the order id, `order-access-token.ts`, which `POST /api/checkout`
hands to whoever checks out and which never expires), and `syncFreemiusCheckoutOrder` links a
license only after Freemius confirms it belongs to the order (`evaluateFreemiusCheckoutLicense`).
Each sync asks Freemius about the license (one or two reads; with a developer pair, on the key
every Freemius flow of the store shares), so a flood of them could push that key into Freemius's
rate limit and stop license links, claims, trials and coupon pushes with it. Syncs are therefore
limited, per process, counting only once the token verifies and only a sync that every limit
admits:

- 5 per order a minute;
- 20 per client network every 10 minutes (an IPv4 /24 or an IPv6 /48, `maskAffiliateVisitorIp`),
  and one shared bucket of 60 for callers whose address cannot be read;
- 60 a minute per instance, all callers together (one log line a minute while it refuses).

A refusal answers 429 with `Retry-After` (the seconds left in that window). The address is
`x-vercel-forwarded-for` only on Vercel (`VERCEL=1`), then `x-real-ip`, then the first
`x-forwarded-for` hop; a directly exposed `next start` keeps a client-sent `x-forwarded-for`, where
the instance limit still holds. `Checkout.tsx` sends one memoized sync per checkout, so buyers
never meet a limit; a sync refused during a flood leaves that order pending.

### License keys on order pages

The success page (`fulfillOrderAction`, which the order access token alone unlocks) and a
customer's order pages show the order's license key (`getFreemiusOrderLicense` in
`freemius-license.ts`), read from Freemius when shown and never stored. Each read is one request
(with a developer pair, on the key every Freemius flow shares), and one free-trial checkout gives
anyone a page to reload, so reads go through memory, per instance: a license Freemius returned is
reused for five minutes and a miss (a 404, no credentials, a failed read) for 30 seconds, in 500
entries at most (oldest out first); concurrent visits share one request; at most 30 uncached reads
start a minute, and past that a visit shows the "key sent by email" fallback (one warning a
minute). A cached license is still checked against each order on every visit (its product, created
after the order). A failed read logs its kind and status only, and no key is ever logged. The
public sandbox reads no license at all: its demo admin can point an order at any license over
PostgREST, so a read there could show a real customer's key, and every visit would spend the
operator's keys.

### Product sync

`syncFreemiusProductsToSupabase()` and `syncSingleFreemiusProduct()`:

- hydrate the CMS settings first, then read with the first developer pair Freemius accepts
  (`openFreemiusCatalogReader`, GET requests to products, plans and pricing only), moving on to
  the next pair when Freemius refuses one (401/403, another 4xx, a 404 to the first product list)
  and stopping when it fails to answer, a 2xx first page that is not a product list included (read
  as an empty catalog, it reported 0 products and dropped every cached verdict and key)
- fetch plugins, plans, and pricing
- upsert digital products into `products`
- upsert related `freemius_plans` and `freemius_pricing`
- drop the cached product list and keys, so a product added in Freemius works at once

These flows are surfaced in the CMS product actions (refused on the public sandbox) and the
sandbox reset route, the only sync there. The plugin objects are never logged: at developer scope
they carry each product's keys.

### Webhook flow

`app/api/webhooks/freemius/route.ts` checks the signature (`x-signature`) over the raw body on
every install, before the event is parsed: it awaits `getFreemiusWebhookVerification` ("Freemius
keys" says which secret checks which product), whose outcome is an object, so only
`outcome === 'valid'` lets an event through.

- `invalid` (a malformed signature, no `plugin_id`, a mismatch) answers 401.
- `unverifiable` (the developer pair owns or may own the product and its secret could not be read:
  `product_key_read_failed`, `product_keys_unavailable`, `developer_pair_unreachable`,
  `developer_pair_refused`; or the event matches the one-product secret and Freemius did not answer
  whether those keys are this product's: `one_product_keys_unconfirmed`) answers 503 with
  `Retry-After: 60`, so Freemius redelivers it, and processes nothing. Its log line is written at
  most once per reason per minute, naming the first event's product and counting the 503s it left
  out; the lib logs a failed key read at most once per product per minute, for 50 products a minute
  at most (`plugin_id` is whatever the sender wrote).
- `valid` carries the verified product id, which goes to every handler explicitly (`productId` on
  `syncFreemiusOrderFromWebhookEvent`, `{ productId }` on `handleFreemiusRefundWebhookEvent` /
  `handleFreemiusDisputeWebhookEvent`) and is stamped on the event as `plugin_id`. An order of
  another product is skipped (`product_mismatch`, logged, answered 200). An order that stores no
  `freemius_product_id` (placed before checkout stored it on 2026-05-07, or imported) is the
  verified product's only when its own items prove it: every `order_items` row names a product
  whose `freemius_product_id` is that id. The proven id is then written to the order, whichever
  handler runs (a dispute or a renewal's refund included). Items that name another product or two
  products, or prove none (no items, an item whose product is gone, a product without a Freemius
  Product ID), skip the order (`product_mismatch`); the unprovable case is logged at most once a
  minute per order, with its id and what to fill in. The event's own objects never decide it, and
  an item or product read error answers 500 so Freemius redelivers.

The bound-secret step drops a `FREEMIUS_PRODUCT_ID`-bound secret whose key set may be a developer
pair's (`resolveFreemiusBoundWebhookSecrets`, the checkout's predicate). In the legacy-only
`refused` state only an event that matches the one-product secret asks Freemius to confirm those
keys: confirmed is `valid`, refused `invalid` (401), no answer `one_product_keys_unconfirmed` (503).
Any other event sends nothing and answers 503 (`developer_pair_refused`), so a forger without that
secret makes no request.

`verifyFreemiusWebhookRequest` is the boolean form of the same check for route files written
before it (401 on `unverifiable`). `verifyFreemiusWebhookSignature` stays synchronous for route
files of 0.23.3 and older, which scaffolds keep when they upgrade the libs (an async one would let
their `if (!verify…)` pass every forgery). It never reads developer keys or asks Freemius, so it
keeps its old acceptance: the product's bound secrets (a `FREEMIUS_PRODUCT_ID`-bound developer
secret included), and the one-product secret for a product without bound keys whatever the
developer state. Such a route should move to `getFreemiusWebhookVerification` (docs/13 → "Upgrade
notes").

Once verified:

- `payment.dispute.created` and `payment.dispute.won` are never synced (the order keeps its
  status); they hold and release the order's affiliate commission
  (`syncFreemiusOrderDisputeFromWebhookEvent`, `FREEMIUS_DISPUTE_EVENT_TYPES`).
- `payment.refund` (Freemius' name), `payment.refunded`, `payment.dispute.lost` and
  `payment.dispute.closed` are handled **instead of** the order sync, as full refunds: the order
  is found by license id and moved to `refunded` when it is paid or shipped
  (`syncFreemiusOrderRefundFromWebhookEvent`), then `apply_affiliate_refund` voids its
  commission, whatever the Affiliates package state. The refund of a renewal payment
  (`is_renewal`) changes nothing: affiliate commissions are earned on the first payment only.
- Every other event goes to `syncFreemiusOrderFromWebhookEvent`, which finds the order by
  license id and updates its status from the event and the purchase data (paid on a positive
  payment or a trial conversion, `trial` for a no-card trial, cancelled when a pending or trial
  license is cancelled or expires). `applyFreemiusOrderState` keeps a `paid` order paid and a
  `refunded` order refunded.

A failure answers 500, so Freemius redelivers.

## Inventory Management and Fulfillment

Inventory behavior is controlled by `trackQuantities`.

When tracking is enabled:

- checkout validates requested quantity against `inventory_items`
- if a SKU is not yet cached there, product or variant stock fields are used as
  fallback
- a paid order triggers `apply_order_inventory_deduction()`
- publishing a product draft writes a SKU's stock only when the editor changed it
  in the product form and the live stock does not already show the new quantity
  (the publish warning names such a SKU), and then as a change to the current
  quantity (migration 02044: docs/09 → "Stock: only what the editor changed"), so
  an order deducted while the edit page was open stays deducted; until then every
  publish wrote back the stock the page had loaded
- since 02044 the deduction takes an order's SKUs in SKU order, and a product
  publish first locks, in the same order and before the product row, the inventory
  rows of every SKU of the products whose rows it writes, so a deduction and a
  publish wait for each other instead of deadlocking, apart from the rarer cases
  docs/09 lists
- since 02046 every writer of `inventory_items` takes its rows in SKU order in one
  statement before it writes any variant or product row: the deduction (all of an
  order's rows, then the deduction in one statement, so two sales of one
  product's variants no longer deadlock), the publish (creating a missing row of
  its product's SKUs there), the product create and the Inventory screen
  (`public.upsert_inventory_items`) and Cortex's database tool. The inventory
  caches (variant stock, product stock and totals) sync once per statement, so a
  publish that changes hundreds of SKUs stays well inside the 8 s statement
  timeout, and every SKU a sale can deduct has an inventory row (02046's backfill)

The deduction flow is resilient:

- first it calls the database RPC `apply_order_inventory_deduction`
- if that fails, it falls back to a direct SQL reconciliation path using
  `POSTGRES_URL` or `DATABASE_URL`, which runs the function's statements (it
  skips the same SKUs, a SKU of spaces included, since 02046)

Order statuses currently supported in code are:

- `pending`
- `paid`
- `shipped`
- `cancelled`
- `refunded`

Manual CMS order status changes also trigger invoice assignment and inventory
deduction when an order is moved to `paid`. The status actions
(`libs/ecommerce/src/lib/pages/cms/orders/server-actions.ts`) authorize with
`requireEcomStaff()` / `requireEcomAdmin()`, so the enrolled second factor is required: `paid`,
`cancelled` and `refunded` are ADMIN-only, and a WRITER may move an order through fulfillment.
The app's own `markOrderAsPaid` (`apps/nextblock/app/cms/orders/actions.ts`) takes its client
from `requireCmsAdmin()` the same way; `tools/scripts/server-action-actors.test.ts` fails on any
`'use server'` module, in the CMS or elsewhere, that builds its own service-role client (docs/04).

With the Affiliates package, the `orders` triggers of `02030` follow these changes: the first
time `paid_at` is set on an attributed order a commission is recorded, moving an order to
`refunded` or `cancelled` voids it, and deleting an order voids it too. A commission that was
already paid out is never voided silently: it is flagged and raises an alert, which is emailed
to the affiliate notification addresses (docs/15).

## Invoice and Order Presentation

The order/invoice layer includes:

- stable invoice numbering through database functions
- `invoice_settings` in `site_settings`
- printable invoice presentation data via `invoice-server.ts`
- UI components such as `InvoiceDocument` and `InvoiceViewerShell`
- customer order history and invoice access through `customer-orders.ts`

## CMS Commerce Surfaces

The active ecommerce CMS surface includes:

- product list, create, edit, media, attribute, and variation management
- inventory management
- orders list and detail management
- shipping zones and shipping rate management
- payment-provider enablement
- tax settings and manual tax-rate management
- currency settings under `/cms/settings/currencies`

The CMS shell only exposes these store sections when the ecommerce package is
reported as active.
