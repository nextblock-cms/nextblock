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
named `@nextblock-cms/ecom`, while the workspace and CLI activation flow expose
the package through the `@nextblock-cms/ecommerce` alias.

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
- `GET /api/cron/sync-currencies`, guarded by `CRON_SECRET`

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
- inserts a pending `orders` row plus `order_items`
- stores currency, subtotal, shipping, tax, and exchange-rate data
- creates the Stripe Checkout Session and stores `stripe_session_id`

### Webhook flow

`app/api/webhooks/stripe/route.ts` passes the raw body to
`handleStripeWebhook()`.

On `checkout.session.completed`, the sync layer:

- reloads the session with tax breakdown details
- finds the existing order
- stores payment intent, customer details, and finalized totals
- normalizes tax details from Stripe
- updates saved customer addresses
- assigns invoice metadata
- applies inventory deduction

## Freemius Licensing and Product Sync

Freemius currently handles digital-product checkout and product synchronization.

### Checkout behavior

`FreemiusProvider.createCheckoutSession()`:

- only allows one item per checkout
- loads the product from Supabase
- requires `freemius_product_id` and `freemius_plan_id`
- resolves pricing in the chosen currency
- inserts a pending order and order item
- optionally syncs default addresses and profile fields for the current user
- builds a Freemius checkout URL, including sandbox parameters when enabled

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

### Current webhook limitation

`app/api/webhooks/freemius/route.ts` currently verifies the webhook signature
and acknowledges selected event types, but it does not yet reconcile license or
order state back into the local database.

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
deduction when an order is moved to `paid`.

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
