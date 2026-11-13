# libs/affiliates — @nextblock-cms/affiliates (Affiliates & Creator Storefronts, package id `affiliates`)

Premium package, an add-on to Commerce Pro (`NEXTBLOCK_PACKAGES.affiliates.requires`; the app
gates on both through `isAffiliatesProgramActive()`, `apps/nextblock/lib/affiliates/package-state.ts`):
partner signup, one admin-approved storefront page per partner, commissions
with a refund-protection hold, and automated Stripe Connect payouts. The schema is migrations
02029 (`RTL` role, alone because Postgres refuses a new enum value inside the transaction that
adds it), 02030 (tables, RLS, RPCs, triggers) and 02031 (UI copy); 02033 adds the display-only
tier goals (`goal` / `goal_translations`, `affiliateTierDisplayGoal`); 02035 stores the tier rate
and hold on the order at payment (a tier move applies to orders paid after it), `tier_changed_at`,
the locked `change_affiliate_partner_tier` RPC and `orders.affiliate_disputed_at`; 02036 lets a
gateway's commissions be paid by hand (`payoutMethods`, `payout_email`, and the claim-first
`claim_` / `record_` / `cancel_manual_affiliate_payout` RPCs: a manual payout is prepared before
the money is sent, then recorded); 02037 adds automatic PayPal Payouts (`payoutMethods` value
`paypal`, `payout_email_kind`, `payout_email_saved_at`, the `paypal_*` payout columns and the
`claim_` / `record_…_batch` / `note_…_item` / `complete_` / `fail_` / `release_paypal_affiliate_payout`
RPCs; a FAILED PayPal payout always carries a `paypal_` reason; the PayPal client and run live in the
app, `apps/nextblock/lib/affiliates/paypal/`). Reference: docs/15.

## Entry points
- `.` (`src/index.ts`): client-safe. core, i18n, storefront. Never reaches `server-only`, `ai`,
  Tiptap, Stripe, service-role or Node code.
- `./editor` (`src/editor.ts`): the client-only storefront Tiptap editor. Import it statically
  from a client component (a dynamic import trips Nx `noImportsOfLazyLoadedLibraries` for every
  static importer; app tests mock lib modules with `vi.importActual`, never `import()`).
- `./server` (`src/server.ts`): `import 'server-only'` first, then the root entry plus
  repository, notifications, copilot, attribution, payouts and connect.

Each area lives in `src/lib/<area>/` and exposes its API from its own `index.ts`; the three entry
files only `export *` the areas.

## Areas
- `core`: row and domain types (hand-written: the generated `Database` type lacks these tables
  until `db:types` runs), `constants.ts` (package id, `RTL`, cookie name, cache tags, paths, alert
  types, copilot tool names), handles + reserved list, tier selection and earnings projection,
  money, onboarding progress, social links, email normalization, status lists.
- `i18n`: per-area dictionaries in `copy/<area>.ts`, `createAffiliatesCopy`,
  `AffiliatesCopyProvider` + `useAffiliatesCopy(dictionary)` (`'use client'`), override helpers.
- `storefront`: document types, `STOREFRONT_LIMITS`, URL rules, `sanitizeStorefrontDoc` /
  `sanitizeStorefrontBlocks` (the XSS boundary), helpers, EN/FR starter documents,
  `diffStorefrontBlocks`, `StorefrontRenderer` (pure React: no hooks, no directive, no raw HTML,
  no `style`, literal classes; first image eager + `fetchPriority="high"`).
- `editor`: `StorefrontEditor`, the product picker, `storefrontCallout` / `affiliateProductGrid`
  nodes, the `/promote` slash command, insert commands, and a replace that only works inside one
  text block (`canReplaceStorefrontSelection`; never merges blocks or deletes a grid, image or
  divider).
- `repository`: reads, ledger balances and `createAffiliateAccountViaRpc` (+ `mapAffiliateRpcError`).
- `notifications`: `buildAffiliateEmail` (EN/FR partner mail, English admin mail, internal copy,
  not seeded; admin mail never links a storefront) and `buildAffiliateSystemAlert`.
- `copilot`: `createRetailerCopilotTools` (`: ToolSet`, exactly the three output-only tools,
  `strict: true`, literal descriptions; build one per request: it holds the request's photo
  budget and section cap, 3 each), flat strict zod schemas, markdown-lite, section → blocks,
  `buildRetailerCopilotInstructions` (throws without a `wrapUntrusted`).
- `attribution`: `resolveCheckoutAttribution` (token > cookie, ACTIVE + approved, self-referral),
  `applyAffiliateRefund`, `setAffiliateCommissionDispute` (dispute hold and release).
- `payouts`: `AffiliatesStripeLike` (structural; the real `stripe` client is assignable, the lib
  never imports `stripe`), `classifyAffiliateStripeError` (only refused requests are definitive),
  `runAffiliatePayoutCycle`, `retryAffiliatePayout` / `releaseAffiliatePayout` (reconcile first),
  run summaries, and the `*ViaRpc` wrappers: every money write is a 02030 (or 02036 manual payout,
  or 02037 PayPal payout) RPC. A cycle, retry or release only touches payouts and commissions of the
  Stripe key's mode (`livemode`), and only Stripe payouts (`method = 'stripe_connect'`): a prepared
  manual payout or a PayPal payout in flight is `PROCESSING` too, but it is settled by the CMS or by
  PayPal's answer, never reconciled or retried through Stripe.
- `connect`: Express accounts (`ensureAffiliateExpressAccount`, idempotent, conditional store),
  readiness from `accounts.retrieve` only, onboarding / dashboard links (https on stripe.com),
  platform facts, the 44 supported countries.

## Rules
- Barrels use `export *`: every exported name is unique across the lib and prefixed
  (`Affiliate…`, `Storefront…`, `RetailerCopilot…`). Constants live in `core/constants.ts`;
  import them, never re-declare them (TS2308). `src/lib/lib-structure.test.ts` enforces both.
- `'use client';` is the literal first line of a client module (no comment above it): the build's
  `reapplyDirectives` only sees it there. Same test. `editor/index.ts` has no directive (Next
  refuses `export *` in a client boundary); every module below it carries its own.
- The lib never builds a Supabase or Stripe client and never reads a secret: server functions
  take the client as a parameter (`AffiliateRepositoryClient`, and `AffiliatesStripeLike` for
  payouts and Connect), and the app picks it after authorizing (`requireRetailer()` /
  `requireCmsAdmin()`). RLS is not a boundary under the service role, so nothing here may
  assume it is. Nothing in the lib authorizes a caller.
- `draft_content` (and anything else a partner authored) is untrusted: it goes through
  `sanitizeStorefrontDoc` and renders only through `StorefrontRenderer`. Never raw HTML, never
  `@nextblock-cms/editor`'s `NotionEditor` (its kit keeps arbitrary HTML). Image origins come in
  as props (`allowedImageOrigins`); the app computes them server-side.
- The editor schema is the sanitizer's allowlist (headings 2/3, lists two levels deep, quotes of
  paragraphs, image, callout, product grid; bold, italic, underline, strike, link from one
  StarterKit). `trailingNode` stays off (it would autosave a no-op edit and unpublish a page);
  node definitions stay React-free; a failed content load makes the editor read-only and stops
  `onChange`. Picker limits: 12 products per grid, 24 distinct per page.
- Money is integer minor units in the store base currency; the TS formulas
  (`computeAffiliateCommissionMinor`, `convertAffiliateAmountToBaseMinor`,
  `normalizeAffiliateEmail`) mirror the SQL in 02030 exactly; change both or neither
  (`core/sql-parity.test.ts`).
- `user_role` stays `'ADMIN'|'WRITER'|'USER'` in the generated types until `db:types` runs:
  compare roles with `String(role) === AFFILIATE_RETAILER_ROLE`.
- Import `z` from `src/lib/zod-config.ts` (jitless). No `next/*` imports: the lib is React-only.
  Read undeclared env as `process.env['X']`.
- UI copy: keys `affiliates.<area>.<snake_name>` in `src/lib/i18n/copy/<area>.ts`, EN + Québec
  French, `…` not `...`, each `{placeholder}` at most once per string, a space before `:` and `%`
  in French (a plain space in source; `createAffiliatesCopy` and the email templates render it as
  a no-break space through `applyAffiliatesFrenchTypography`). Client islands pass their own area
  dictionary to `useAffiliatesCopy()`; the merged `AFFILIATES_COPY` is for the server, the 02031
  generator and tests. `src/lib/i18n/dictionary.test.ts` lints every area file. A new or changed
  key needs the seed too: `tools/scripts/generate-affiliates-translations.ts --write` while 02031
  is unapplied, a new forward migration after that (the generator's header says how);
  `translations-migration.test.ts` fails until they agree.
- A module with a top-level side effect (a bare `import 'x'`, a call or control flow outside a
  declaration) must be listed in `package.json` `sideEffects` as `./src/<m>.ts`, `./<m>.es.js`
  and `./<m>.cjs`; `src/lib/lib-structure.test.ts` enforces the exact list. Keep registrations
  out of `const` initializers: the test cannot see them, and bundlers drop them.
- Every bare import is declared in `package.json` (and the root `package.json`):
  `@nx/dependency-checks` fails the lint otherwise.

## Commands
`npx vitest run libs/affiliates`, `npx nx typecheck affiliates`, `npx nx lint affiliates`,
`npx nx build affiliates`, `node tools/scripts/verify-lib-dist.js affiliates` after a build.
Release: `npm run build:affiliates` (publish order: after cortex, before the CLI).
