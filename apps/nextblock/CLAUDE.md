@AGENTS.md

# apps/nextblock — the NextBlock app

Next.js 16 App Router app: public site, CMS under `app/cms`, API routes under `app/api`,
first-boot wizard under `app/setup`. Standalone projects are a copy of this directory with
`@nextblock-cms/*` installed from npm.

## Map
- `proxy.ts` (Next 16 middleware): `/setup` gate, DB redirects, CSP nonce, `/cms` session + role
  checks (`/cms/admin|users|settings|affiliates` ADMIN-only); `app/cms/layout.tsx` adds 2FA. It
  also sets the partner referral cookie `nb_affiliate_ref` (GET document navigations to
  `/partners/<handle>` or `?ref=`; `private, no-store` on those responses), pins `X-User-Locale`
  to French on `/partenaires` and every path below it (`isFrenchPartnersPath`), and forwards
  `x-nextblock-path` / `x-nextblock-search`; the rules live in the import-free
  `lib/affiliates/referral-cookie.ts` and `partners-paths.ts`.
- Affiliates (docs/15): `app/(public)/partners` (signup, storefronts, `/partners/terms`),
  `app/(public)/partenaires` (the French landing and `/partenaires/conditions`),
  `app/(portal)/portal/retailer` (partner portal, `requireRetailerPage()` / `requireRetailer()`),
  `app/cms/affiliates`, `app/api/affiliates/*` (upload, copilot, payout cron); server modules in
  `lib/affiliates/` (`lib/affiliates/paypal/`: PayPal Payouts, 02037: the REST client, the
  CMS-or-env credentials, the payout run's PayPal step and `/cms/affiliates/paypal`'s work; PayPal
  is never called on the public sandbox). Every surface gates on
  `isAffiliatesProgramActive()` (`lib/affiliates/package-state.ts`: the package AND Commerce Pro,
  which it is an add-on to). Partner JSON is untrusted: sanitize at read time, render with
  `StorefrontRenderer`.
- `lib/cron/cron-secret.ts`: `isCronRequestAuthorized()` for any route that checks `CRON_SECRET`
  (constant-time; never compare the header with `===`).
- `lib/i18n/translation-pages.ts`: `readAllTranslationRows()` for any read of many
  `translations` rows (PostgREST stops at 1000).
- `lib/blocks/blockRegistry.ts` + `blockTypes.ts`: built-in block schemas and defaults.
  `components/BlockRenderer.tsx` resolves `block_type` via `components/blocks/publicRendererLoaders.ts`,
  then the ecommerce loaders, then custom blocks; unknown types render null unless editing.
- Block row writes (delete+insert): `app/actions/visualEditingActions.ts`, `app/cms/revisions/service.ts`,
  `lib/cms-transfer/server.ts`, `lib/visual-editing/product-drafts.ts`.
- `lib/setup/env-status.ts` resolves Supabase env; keep it free of Node/Supabase imports.

## Commands
Monorepo: `npx nx serve nextblock`, `npx nx build nextblock`, `npx vitest run apps/nextblock/<file>`.
Standalone: `npm run dev`, `npm run build`.

## Rules
- Import `z` from `lib/zod-config.ts` (jitless; the prod CSP bans eval).
- Server modules `import 'server-only'`; set `export const runtime = 'nodejs'` on Node-only route handlers.
- Generated, never edit: `lib/setup/migrations-bundle.ts`, `app/api/cron/reset-sandbox/sandboxResetSql.ts`,
  `lib/custom-block-safelist.ts`, `next-env.d.ts`, the Next block in `AGENTS.md`.
