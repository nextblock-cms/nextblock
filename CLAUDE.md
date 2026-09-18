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
- Headless installs (`create-nextblock --non-interactive`, docs/06): `GET /api/setup/status`
  (public readiness), `POST /api/setup/bootstrap` (first admin, bearer = `MCP_BEARER_TOKEN`),
  `NEXTBLOCK_LICENSE_KEY` activated on first use by `lib/packages/env-license.ts`, and the
  env-token auth path in `app/api/mcp/route.ts`. The vendor mints the trial key in
  `app/api/packages/provision-trial`. Docs/08 → "Headless bootstrap".

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
- Migrations are append-only and named `GGNNN_<snake_name>.sql` (GG = squash generation, NNN =
  sequence): `02000_catchup_gen1` replays the retired generation (version-aware, runs first),
  `02001`–`02004` are the generation's baseline, `02005+` are ordinary forward migrations. Next number = highest on disk + 1
  in the same generation; `npm run db:migrate:check` prints it, fails on any other shape, and
  must list the new file as pending (Supabase matches history by version only; a reused
  version is skipped silently). Never use timestamps. Squash runbook: `docs/04` →
  "Squashing migrations".
- Seed data-fix migrations scope UPDATEs by content signature + parent (`page_id = v_home AND
  content::text LIKE '%…%'`), never by `blocks.id`; ids drift on every install (035 clobbered
  the home promo that way, 037 repairs it). Verify copy with the SEO engine before writing SQL.
- The public site is bilingual: every content change to a page, post or product ships its French
  equivalent in the same migration (same `translation_group_id`, same block structure, translated
  text, links to the `-fr` / French slugs). Only `/cms` is English-only. `02008`/`02009` are the
  model: translate text nodes, keep markup, insert missing FR rows guarded by group + language.
- After schema or seed changes regenerate all three artifacts (`db:types`,
  `generate:migrations-bundle`, `generate:sandbox`); the generators fail silently by omission.
- Server-only modules throw in a browser: Cortex on call, S3 and `server-only` imports on import.
- UI copy: `t(key)` returns the KEY for an unseeded key, so `t('x') || 'Fallback'` never falls
  back. Use `useLabel()` (app, EN + FR fallbacks), `translateOrFallback` (ecommerce) or
  `useOptionalTranslations()` (ui), and seed every new key EN + FR in a forward migration
  (`02015` is the model). Shop prices go through `usePriceFormatter()`, never bare `formatPrice`.
  Accessibility traps and the audit: docs/05 → "Public UI Copy and Accessibility".

## Gotchas

- npm ≥ 11.13 blocks dependency install scripts unless the ROOT `package.json` lists the
  package under `allowScripts` (`"name": true`, or `"name@1.2.3": true`; semver ranges are
  rejected, and only the root's field counts in the workspace). Adding a dependency with a
  native/binary postinstall means adding it there, or every install logs "N packages have
  install scripts not yet covered by allowScripts" and silently skips them. Mirror the entry
  in `apps/nextblock/package.json` (it becomes the standalone template's root).
- `@nextblock-cms/ecommerce` is the alias; the package is `@nextblock-cms/ecom`. Intentional.
- Cortex's package id is `cortex-ai`, never `ai`. Cortex calls OpenRouter via the Vercel AI SDK
  and the operator picks the model; never assume a provider.
- Renaming a custom block `slug` orphans every block instance that references it.
- A new `libs/utils` directory barrel needs its own build entry + `exports` key in
  `vite.config.mts` (see `./seo`); the published `./*` wildcard only maps files.
- Lib declarations fail silently (the build exits 0, scaffolds use `skipLibCheck`, the type
  becomes `any`): a recursive type in an exported function's inferred return type must be
  exported (else TS4058 and NO `.d.ts` for that module), and every lib's dts plugin keeps
  `aliasesExclude` for `@nextblock-cms/*`. `tools/scripts/verify-lib-dist.js` checks both.
- Publish order utils → ui → sdk → db → editor → ecommerce → cortex → CLI; npm 2FA needs
  an OTP per publish and piping output breaks the prompt (`EOTP`).
- Public reads (page/post data, translated slugs, layout chrome) go through `unstable_cache`
  (`lib/public-content-cache.ts`, 5 min, evicted by `revalidatePath` + `revalidatePublicContent`)
  wrapped in React `cache()`. `export const fetchCache = 'force-no-store'` on a route segment
  silently disables every `unstable_cache` under it, the layout's included; `dynamic =
  'force-dynamic'` is enough. Hero content must not use `backdrop-blur-*`, and sections only
  get GPU-layer classes when they have a background image (first-frame compositing cost).
- `vercel.json` on `master` must never declare `crons`: it ships to every Vercel 1-click
  install and Hobby fails the deployment on any sub-daily schedule. The sandbox's 15-min
  reset is a pg_cron job in the sandbox DB (`npm run sandbox:schedule`, not a branch:
  every Vercel project builds every branch); FX rates refresh from the CMS layout via
  `after()` (`lib/commerce/currency-rates-refresh.ts`).
- `/robots.txt` is a route handler (`app/robots.txt/route.ts`) serving `buildRobotsTxt`, not an
  `app/robots.ts` metadata route: Next's serialiser drops the per-rule `other` directives the
  SEO screen lets operators add. The two cannot coexist.

## Do not modify

- `apps/create-nextblock/templates/nextblock-template/**` (regenerated by the sync).
- Generated: applied migrations, `libs/db/src/lib/supabase/types.ts`, `apps/nextblock/lib/setup/migrations-bundle.ts`,
  `apps/nextblock/app/api/cron/reset-sandbox/sandboxResetSql.ts`, `apps/nextblock/lib/custom-block-safelist.ts`.
- Stale compiled `.js`/`.d.ts` twins beside `.ts` sources in `libs/db` and `libs/utils`.
- The `nextjs-agent-rules` block in `apps/nextblock/AGENTS.md` (rewritten by `next dev`).
- Never run `db:reset`, `sandbox:reset`, `db:push:sandbox`, or `db:migrate:fresh` on a shared DB.
