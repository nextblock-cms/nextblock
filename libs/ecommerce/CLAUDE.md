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
  call `hydrateFreemiusEnvFromDb()` first.
- Store readiness is ONE predicate (`pages/cms/payments/queries.ts`); never fork it per surface.
- Money is minor units; resolve prices via `currency.ts` (`price` is the fallback).

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
