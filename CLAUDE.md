# NextBlock — Claude Code guide

Nx monorepo for an open-core CMS: one Next.js 16 app on Supabase, shared libs, a scaffolding
CLI. Code is the authority over `docs/NN-*.md` (the maintained reference set: read the file for
your subsystem, update it when you change that subsystem). Per-project `CLAUDE.md` files load
on demand when you work inside a project.

## Layout

- `apps/nextblock` — the only runtime: site, CMS (`app/cms`), API (`app/api`), `/setup`, `proxy.ts`.
- `apps/create-nextblock` — CLI; `templates/nextblock-template/**` is generated from the app.
- `libs/db` — Supabase clients, generated types, migrations, secret crypto.
- `libs/utils` — Zod schemas (editor JSON, custom blocks), SEO engine, package registry.
- `libs/ui` — primitives, Tailwind preset, styles. `libs/editor` — Tiptap `NotionEditor`.
- `libs/sdk` — types-only block-authoring contract.
- `libs/ecommerce` (premium) — Stripe/Freemius checkout, products, orders, shipping, tax.
- `libs/cortex` (premium) — Cortex AI: OpenRouter routing, agent tools, MCP server.

Dependencies: `utils` → `ui` → `editor`; `utils` → `db`; `db,ui,utils` → `ecommerce`;
`db,utils,ecommerce` → `cortex`; the app consumes all; libs never import the app. Import via
`@nextblock-cms/*` (`tsconfig.base.json` paths; `vitest.config.ts` mirrors all but
`db/secrets` and `db/types`).

## Content model (Postgres JSONB)

- A page, post, or product owns ordered `blocks` rows `{ block_type, content jsonb, "order",
  language_id, page_id | post_id | product_id }` with exactly one parent.
- `block_type` is a built-in from `availableBlockTypes` (`apps/nextblock/lib/blocks/blockTypes.ts`:
  `text, heading, image, button, posts_grid, video_embed, section, form, testimonial` + ecommerce
  `product_grid, featured_product, cart, checkout, product_details`) whose `content` shape is the
  Zod schema in `blockRegistry.ts`, or a `custom_block_definitions.slug` whose `content` is a flat
  `{ field_key: value }` map rendered by `DynamicLayoutEngine` from that row's `fields` and
  `layout_schema` JSONB.
- `section.content.column_blocks` is `Block[][]`; a hero is a `section` with `is_hero: true`.
  Rich text is HTML in `text.content.html_content`; product `description_json` is Tiptap JSON
  (stored unvalidated; schemas in `libs/utils/src/lib/editor-blocks.ts`).
- Live Draft Mode stages edits in `content_drafts` / `product_drafts` (`meta`, `blocks` jsonb).
  `site_settings` is a `key → value jsonb` bag. Pages, posts, products, and nav rows carry
  `language_id` + `translation_group_id`.

## Auth and data access

- `apps/nextblock/proxy.ts` (Next 16's renamed middleware) gates `/cms` by session and role and
  redirects to `/setup` when unconfigured. `app/cms/layout.tsx` enforces 2FA;
  `CmsClientLayout.tsx` only redirects client-side.
- From `@nextblock-cms/db/server` pick by trust level: `createClient()` cookie scope,
  `getSsgSupabaseClient()` public reads, `getServiceRoleSupabaseClient()` admin only.
- Read Supabase env through the resolvers in `apps/nextblock/lib/setup/env-status.ts`; hosted
  installs inject `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` beside the
  legacy `NEXT_PUBLIC_SUPABASE_*` names. Libs inline the same alias chain.
- Premium gating: `verifyPackageOnline('ecommerce' | 'cortex-ai')` (cached 60 s).

## Commands

```bash
npx nx serve nextblock              # dev on :4200
npx nx build nextblock              # prebuild migration hook never fails a build
npm run lint                        # or npx nx lint <project>
npx vitest run <path>               # ALWAYS pass a path (a bare run also collects the template copy); no per-project nx test targets
npm run db:migrate:check            # ALWAYS first; read-only by construction
npm run db:migrate && npm run db:types
npm run generate:migrations-bundle && npm run generate:sandbox   # after any schema/seed change
npm run sync:create-nextblock       # regenerate the CLI template from apps/nextblock
```

## Conventions

- Import `z` from the nearest `zod-config.ts` (jitless; the prod CSP forbids eval), not from `zod`.
- Migrations are append-only: `libs/db/src/supabase/migrations/<14 digits>_<name>.sql`; next
  number = highest file on disk + 1, then confirm `db:migrate:check` lists it as pending
  (Supabase matches history by version only; a reused version is skipped silently).
- After schema or seed changes regenerate all three artifacts (`db:types`,
  `generate:migrations-bundle`, `generate:sandbox`); the generators fail silently by omission.
- Server-only modules throw in a browser: Cortex on call, S3 and `server-only` imports on import.

## Gotchas

- `@nextblock-cms/ecommerce` is the alias; the package is `@nextblock-cms/ecom`. Intentional.
- Cortex's package id is `cortex-ai`, never `ai`. Cortex calls OpenRouter via the Vercel AI SDK
  and the operator picks the model; never assume a provider.
- Renaming a custom block `slug` orphans every block instance that references it.
- A new `libs/utils` directory barrel needs its own build entry + `exports` key in
  `vite.config.mts` (see `./seo`); the published `./*` wildcard only maps files.
- Publish order utils → ui → sdk → db → editor → ecommerce → cortex → CLI; npm 2FA needs
  an OTP per publish and piping output breaks the prompt (`EOTP`).

## Do not modify

- `apps/create-nextblock/templates/nextblock-template/**` (regenerated by the sync).
- Generated: applied migrations, `libs/db/src/lib/supabase/types.ts`, `apps/nextblock/lib/setup/migrations-bundle.ts`,
  `apps/nextblock/app/api/cron/reset-sandbox/sandboxResetSql.ts`, `apps/nextblock/lib/custom-block-safelist.ts`.
- Stale compiled `.js`/`.d.ts` twins beside `.ts` sources in `libs/db` and `libs/utils`.
- The `nextjs-agent-rules` block in `apps/nextblock/AGENTS.md` (rewritten by `next dev`).
- Never run `db:reset`, `sandbox:reset`, `db:push:sandbox`, or `db:migrate:fresh` on a shared DB.
