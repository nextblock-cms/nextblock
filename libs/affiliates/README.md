# @nextblock-cms/affiliates

NextBlock Affiliates & Creator Storefronts, a premium module of
[NextBlock](https://github.com/nextblock-cms/nextblock), the open-core CMS for Next.js and
Supabase. Partners sign up at `/partners` (`/partenaires` in French), get one co-branded
storefront page at `/partners/<handle>` that an admin approves before it goes live, and earn a
commission on the orders they refer. Commissions wait out a refund window, then are paid the way
the operator chose for each kind of sale: a Stripe Connect Express transfer to the partner's bank,
a PayPal Payouts payment from the operator's PayPal balance to the partner's PayPal account (both
automatic, in the daily payout run), or a payout the operator sends by hand (PayPal, Interac
e-Transfer, Wise or a bank transfer) and records in the CMS. Partners who prefer Interac
e-Transfer are paid by hand. A sale is only ever paid with money of its own mode (a test-mode sale
is never paid with live money), and an open payment dispute holds its commission.

What the package holds:

- the domain contract: row types, tier and commission math in integer minor units, handles,
  onboarding progress, social-link and email normalization;
- the bilingual (English and Québec French) UI copy, with a provider and hook that read operator
  overrides from the CMS translations;
- the restricted storefront document: an allowlist sanitizer and a React renderer for the Tiptap
  JSON partners author (no raw HTML, no styles, no scripts);
- the storefront editor, a scoped Tiptap editor with a `/promote` product-grid command;
- server code: repository reads and the signup RPC, lifecycle email and alert templates, the
  storefront copilot tools, checkout attribution, refunds and dispute holds, the Stripe payout
  cycle, the manual and PayPal payout database calls, and Stripe Connect Express onboarding.

Projects created with `npm create nextblock@latest` already depend on it. It needs React 19
(peer dependency) and the NextBlock database schema that `@nextblock-cms/db` ships (migrations
02029 to 02037).

## Licensing

The source is public under AGPL-3.0-or-later, and the features are license-gated under the
package id `affiliates`. It is an add-on to NextBlock Commerce Pro (package id `ecommerce`):
partners earn a share of store sales, so the program needs the shop. A NextBlock project turns
on the partner pages, the partner portal and the affiliate CMS screens only while both packages
are active, and keeps every partner, storefront and commission while either is off. The app
checks both with `verifyPackageOnline()` from `@nextblock-cms/db/server`, reading the
requirement from `NEXTBLOCK_PACKAGES.affiliates.requires` in `@nextblock-cms/utils`. Like the
other packages it is sold through Freemius: once Commerce Pro is active, start the free 30-day
trial (no credit card), buy a license or paste a key under CMS → Administration → Packages. The
public demo activates it with the sandbox key below.

## Entry points

| Import | Use it from | What it holds |
| :-- | :-- | :-- |
| `@nextblock-cms/affiliates` | client or server | Types, constants and pure helpers (handles, tiers, money, onboarding, social links, email normalization), the copy dictionaries with `createAffiliatesCopy`, `AffiliatesCopyProvider` and `useAffiliatesCopy`, and the storefront sanitizer, helpers and `StorefrontRenderer` |
| `@nextblock-cms/affiliates/editor` | client only | `StorefrontEditor`, the restricted Tiptap editor, its product picker and extensions |
| `@nextblock-cms/affiliates/server` | server only | Everything from the root entry plus the repository, notification templates, copilot tools, attribution, refunds and dispute holds, the Stripe payout cycle, the manual and PayPal payout database calls and the Stripe Connect helpers. It imports `server-only`. |

Server functions take the Supabase client (and, for Stripe payouts and Connect, a Stripe client
that matches the structural `AffiliatesStripeLike` interface) as arguments; the package never
builds a client, imports `stripe`, calls PayPal or reads a secret itself (the NextBlock app holds
the PayPal Payouts REST client). Every money write goes through the database functions of
migrations 02030, 02036 (manual payouts) and 02037 (PayPal Payouts). Each module keeps its
`'use client'` directive, so the
consuming Next.js build splits client and server code correctly. `package.json` declares
`sideEffects` (only the server entry and the zod configuration), so a bundler drops every module
a page does not use: a client island that imports one helper from the root entry does not ship
the storefront renderer.

## Environment

- `FREEMIUS_AFFILIATES_SANDBOX_KEY`: set on the public sandbox deployment only, beside
  `FREEMIUS_ECOMMERCE_SANDBOX_KEY` (the program needs Commerce Pro). The sandbox reset activates
  the package with it and seeds a demo partner storefront. Stripe Connect, PayPal Payouts and
  every other payout stay disabled in the sandbox.

## Documentation

- [Affiliates and creator storefronts](https://github.com/nextblock-cms/nextblock/blob/master/docs/15-AFFILIATES-AND-STOREFRONTS.md)
- [Database and auth](https://github.com/nextblock-cms/nextblock/blob/master/docs/04-DATABASE-AND-AUTH.md)
- [Project overview](https://github.com/nextblock-cms/nextblock/blob/master/docs/01-PROJECT-OVERVIEW.md)

## License

AGPL-3.0-or-later.
