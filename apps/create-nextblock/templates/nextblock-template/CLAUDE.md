@AGENTS.md

# apps/nextblock — the NextBlock app

Next.js 16 App Router app: public site, CMS under `app/cms`, API routes under `app/api`,
first-boot wizard under `app/setup`. Standalone projects are a copy of this directory with
`@nextblock-cms/*` installed from npm.

## Map
- `proxy.ts` (Next 16 middleware): `/setup` gate, DB redirects, CSP nonce, `/cms` session + role
  checks (`/cms/admin|users|settings` ADMIN-only); `app/cms/layout.tsx` adds 2FA.
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
