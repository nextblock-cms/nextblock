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
(`ProductCard`, `FeaturedProduct`, `ProductDetailsLayout`, UCP). The CMS edit
form exposes the window per-product and per-variant (`SaleScheduleFields`); the
bulk **Promotions** admin (`/cms/promotions`, `apps/nextblock/lib/promotions/`)
imports/exports sales and price changes via CSV.

> **Gotchas for future agents (these caused real revert/display bugs):**
>
> 1. **`generateVariantDrafts` (`variation-utils.ts`) must carry over every
>    per-variant field**, including `sale_start_at`/`sale_end_at`. It re-runs on
>    editor mount/attribute change; an omitted field resets to null and is then
>    autosaved away ("dates revert after publish").
> 2. **Storefront block mappers must pass the window through** on *both* the
>    product and each variant — `ProductGridBlock`, `FeaturedProductBlock`,
>    `app/product/[slug]/page.tsx`. If the window is dropped, `isSaleWindowActive`
>    sees both bounds null and treats the sale as always-on, so an inactive sale
>    price shows (e.g. a "$25 – $32" range before the sale starts).
> 3. **`getVariantEffectivePriceRange` is window-aware** — pass
>    `sale_start_at`/`sale_end_at` per variant or it ignores the schedule.
> 4. **Persisting on save/publish does not rely on the RPC.** Products are
>    written via `upsert_product_with_variants`, but some databases run a stale
>    copy of that function. `persistProductSaleSchedule` (`product-actions.ts`)
>    writes the window columns with a direct `update` right after the RPC (same
>    pattern as `persistProductTaxability`), matching variants by SKU.
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
secret key to run the partner program, and while the Affiliates program is active the Payments
screen says so (the app passes `isAffiliatesProgramActive()` to `PaymentsPage({ partnerPayouts })`;
a store without the add-on sees the plain "Stripe (physical products)" heading). CMS → Affiliates
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
- creates the Stripe Checkout Session and stores `stripe_session_id`; the session sets
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
- finds the existing order
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
`NEXTBLOCK_LICENSE_CLAIM_ENABLED=true` and the vendor Freemius credentials in
`FREEMIUS_CHECKOUT_PRODUCTS_JSON` — which verifies the claim
(`claimFreemiusLicenseKey` in `libs/ecommerce/src/lib/freemius-license-claim.ts`) and
returns the key so the buyer's install activates automatically. Details:
docs/08 → "Buying from the dashboard".

## Freemius Licensing and Product Sync

Freemius currently handles digital-product checkout and product synchronization.

### Freemius keys (CMS → Payments)

Freemius gives every product its own public key, secret key and API bearer token (the product →
Settings → API & Keys). The Payments screen holds ONE product's keys (`FREEMIUS_PUBLIC_KEY`,
`FREEMIUS_SECRET_KEY`, `FREEMIUS_API_KEY` after hydration). A store selling several Freemius
products also lists each product's keys in `FREEMIUS_CHECKOUT_PRODUCTS_JSON`: webhooks are signed
with the selling product's secret key (`getFreemiusWebhookSecretCandidates` tries every known secret),
and license and coupon calls use that product's token. The global Product ID is optional: checkout,
orders, licenses, coupons and webhooks use the `freemius_product_id` / `freemius_plan_id` saved on
each product, and readiness needs only the public and secret keys. The Developer ID is used only by
Sync from Freemius (developer-scope calls). The screen says all of this beside the fields.

### Checkout behavior

`FreemiusProvider.createCheckoutSession()`:

- only allows one item per checkout
- loads the product from Supabase
- requires `freemius_product_id` and `freemius_plan_id`
- resolves the unit amount with `resolveFreemiusUnitAmount`
  (`libs/ecommerce/src/lib/freemius-pricing-server.ts`), described below
- inserts a pending order and order item
- optionally syncs default addresses and profile fields for the current user
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

Supported credential sources include:

- product-scoped JSON map
- single-product sandbox overrides
- single-product env vars
- legacy shared env vars

### Product sync

`syncFreemiusProductsToSupabase()` and `syncSingleFreemiusProduct()`:

- call the Freemius API with signed requests
- fetch plugins, plans, and pricing
- upsert digital products into `products`
- upsert related `freemius_plans` and `freemius_pricing`

These flows are surfaced in the CMS product actions and the sandbox reset route.

### Webhook flow

`app/api/webhooks/freemius/route.ts` verifies the signature (`x-signature`) over the raw body
on every install, then:

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

The deduction flow is resilient:

- first it calls the database RPC `apply_order_inventory_deduction`
- if that fails, it falls back to a direct SQL reconciliation path using
  `POSTGRES_URL` or `DATABASE_URL`

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
CMS server action that builds its own service-role client.

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
