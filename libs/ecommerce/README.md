# @nextblock-cms/ecom

The premium commerce module of [NextBlock](https://github.com/nextblock-cms/nextblock), the
open-core CMS for Next.js and Supabase: products and variants, cart and checkout, orders,
coupons, currencies, shipping zones, tax rates and invoices. Physical products are paid through
Stripe and digital products through Freemius.

NextBlock projects install it under the alias `@nextblock-cms/ecommerce`, and every import uses
that name. Projects created with `npm create nextblock@latest` already have it:

```json
"@nextblock-cms/ecommerce": "npm:@nextblock-cms/ecom@latest"
```

It needs Next.js 16 and React 19 (peer dependencies), plus the NextBlock database schema that
`@nextblock-cms/db` ships.

## Licensing

The source is public under AGPL-3.0-or-later, and the features are license-gated. A NextBlock
project turns on its checkout API and commerce CMS screens only after an ecommerce license is
active: start a trial or buy one in the CMS under **Settings → Packages**. The app checks it
with `verifyPackageOnline('ecommerce')` from `@nextblock-cms/db/server`.

## Entry points

| Import | Use it from | What it holds |
| :-- | :-- | :-- |
| `@nextblock-cms/ecommerce` | client or server | Storefront and account components (`Cart`, `CartDrawer`, `Checkout`, `ProductGrid`, `ProductCard`, `FeaturedProduct`, `AddToCartButton`, `CurrencySwitcher`, …), the cart store, `CurrencyProvider`, and the CMS `ProductForm` |
| `@nextblock-cms/ecommerce/server` | server only | Stripe checkout, webhooks and order sync, payment configuration, inventory, invoices, tax details and coupons |
| `@nextblock-cms/ecommerce/<module>` | depends on the module | One compiled module, for example `@nextblock-cms/ecommerce/cart-store`, `/components/Cart` or `/server-actions/product-actions` |

The package keeps each module's `'use client'` or `'use server'` directive, so the consuming
Next.js build splits client and server code correctly.

## Documentation

- [Ecommerce capabilities](https://github.com/nextblock-cms/nextblock/blob/master/docs/02-ECOMMERCE-CAPABILITIES.md)
- [Project overview](https://github.com/nextblock-cms/nextblock/blob/master/docs/01-PROJECT-OVERVIEW.md)

## License

AGPL-3.0-or-later.
