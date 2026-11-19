# libs/utils — @nextblock-cms/utils

Bottom of the stack (no `@nextblock-cms/*` deps): Zod contracts, the pure SEO engine, script
safety, the authored-HTML sanitizer, publishing state, color/currency helpers, the package registry,
a server-only R2/SMTP entry.

Entry points: `.` (curated barrel incl. all of `./seo`); `./server`; `./seo` (pure: `auditSeo`,
`buildSeoDocument`, redirects, robots); `./script-safety`; and, through `./*` (`lib/*.es.js`),
every module the barrel re-exports: `./utils` (`cn`, currency helpers), `./translations-context`,
`./translation-workspace`, `./color`, `./client-utils`, `./custom-blocks`, `./nextblock-packages`,
`./publishing`, `./media-variants`, `./media-url` (client-safe `resolveMediaUrl`,
`BUNDLED_PUBLIC_MEDIA_KEYS`; ecommerce and the app's `lib/media/resolveMediaUrl.ts` re-export use
it), `./authored-html`. `./editor-blocks` (Tiptap JSON schemas) resolves through the monorepo alias
only: no build entry reaches it, so the package ships no JavaScript for it.

## Rules
- Stay strict-clean: `libs/db` compiles these sources under `noPropertyAccessFromIndexSignature`;
  read undeclared env with `process.env['NAME']`. A `NEXT_PUBLIC_*` var a client bundle needs is
  declared in `libs/environment.d.ts` and read with dot access, the form Next inlines
  (`NEXT_PUBLIC_R2_BASE_URL` in `media-url.ts`).
- `media-url.ts` is the only display-URL builder for media keys: a key in
  `BUNDLED_PUBLIC_MEDIA_KEYS` (a file in `apps/nextblock/public/images`) resolves to `/images/…`,
  every other key to the public media base. Add a key there when a migration, the seed or the
  sandbox reset points a media row at a new bundled file; `tools/scripts/media-url-builders.test.ts`
  fails on code that joins the base by hand.
- `src/lib/seo/**` stays pure (no Zod, React, Supabase, DOM); it runs in the browser and `proxy.ts`.
- A published subpath must map to a FILE (`./*` → `lib/*.es.js`). A new `src/lib/<dir>/index.ts`
  barrel passes every local check and breaks standalone installs: add `lib/<dir>/index` to
  `build.lib.entry` plus an exports key in `vite.config.mts` afterBuild (see `./seo`).
- Published deps and the exports map are written in `vite.config.mts` afterBuild, not `package.json`.
  `react` and `next` are optional peers there: create-nextblock installs this package (through
  `@nextblock-cms/db`) and npm would install a required peer. Declarations leave tests out
  (`exclude` in the dts options).
- Client code on public routes imports deep subpaths (`@nextblock-cms/utils/utils`,
  `/translations-context`, `/color`, …), never `.`: the barrel re-exports `authored-html`, whose
  sanitize-html (CommonJS, about 39 KB gzipped with htmlparser2) no bundler drops, plus Zod and the
  custom-block schemas (`custom-blocks.ts` calls `z.config()` at load), and this package declares
  no `sideEffects` (pure modules such as the SEO engine were tree-shaken even so). Keep the
  barrel's exports: published libs and user code import from it. A deep import ships only for a
  module a build entry reaches and a name an entry exports (preserveModules drops the rest).
  `tools/scripts/root-layout-chunking.test.ts` checks the public routes' client graphs and the
  lazy chunks they load (no barrel or Zod; the sanitizer only in its `SANITIZING_LAZY_CHUNKS`), and
  every deep import's names.

## Gotchas
- `server.{es,cjs}.js` + `server.d.ts` are compiled from `src/server.ts` like every other module.
  Never write JS output from `afterBuild`: it runs after the ESM files are written and before the
  CommonJS ones, so it overwrites real ESM output and its CommonJS files get overwritten (the
  hand-written server entry did both through 0.20).
- The stale tracked twins (`src/lib/server-utils.js`, `src/server.js`) are ignored:
  `resolve.extensions` puts `.ts` first here and in the root `vitest.config.ts`, so the `.ts`
  sources are what ships and what the tests run.
- `src/lib/authored-html.ts` is the boundary for authored HTML (an allowlist on `sanitize-html`; it
  imports nothing else and touches no DOM). The library writes allowed `<style>` text unescaped
  (since 2.18.2 a `<` inside svg or math becomes `\3c `), so never allow `script`, and keep the
  TAG_OPENER and TEXT_ONLY_ELEMENTS rules in `exclusiveFilter`: without them `<svg><style>`
  round-trips into a live element (the tests replay it and pin the exact output). The `'*'`
  transform drops a `data-` / `aria-` name the HTML spec forbids (`data-x:xlink:href`) before the
  globs see it. Raise the sanitize-html range in the root `package.json` and in the dist manifest
  (`vite.config.mts`) together, so scaffolds never resolve an older version than the tests ran
  (`tests/published-dependencies.test.ts` fails when they differ). Run
  `npx vitest run libs/utils/src/lib/authored-html` after any change to the options.
- `src/lib/server-utils.ts` is server-only but must never be a `"use server"` module: that would
  make `getEmailServerConfig()` (it returns the SMTP password) callable from the browser once a
  client component imports it. It throws in a browser instead; `server-utils.test.ts` guards it.

Commands: `npx vitest run libs/utils`, `npx nx typecheck utils`, `npx nx build utils`.
