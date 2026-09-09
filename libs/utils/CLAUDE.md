# libs/utils — @nextblock-cms/utils

Bottom of the stack (no `@nextblock-cms/*` deps): Zod contracts, the pure SEO engine, script
safety, publishing state, color/currency helpers, the package registry, a server-only R2/SMTP entry.

Entry points: `.` (curated barrel incl. all of `./seo`); `./server`; `./seo` (pure: `auditSeo`,
`buildSeoDocument`, redirects, robots); `./custom-blocks`; `./utils`. `./script-safety` and
`./editor-blocks` (Tiptap JSON schemas) resolve through the monorepo alias only, not in dist.

## Rules
- Stay strict-clean: `libs/db` compiles these sources under `noPropertyAccessFromIndexSignature`;
  read undeclared env with `process.env['NAME']`.
- `src/lib/seo/**` stays pure (no Zod, React, Supabase, DOM); it runs in the browser and `proxy.ts`.
- A published subpath must map to a FILE (`./*` → `lib/*.es.js`). A new `src/lib/<dir>/index.ts`
  barrel passes every local check and breaks standalone installs: add `lib/<dir>/index` to
  `build.lib.entry` plus an exports key in `vite.config.mts` afterBuild (see `./seo`).
- Published deps and the exports map are written in `vite.config.mts` afterBuild, not `package.json`.

## Gotchas
- `dist/libs/utils/server.{es,cjs}.js` + `server.d.ts` are hand-written templates in
  `vite.config.mts` afterBuild; mirror changes to `src/lib/server-utils.ts` there.
- The stale tracked twin `src/lib/server-utils.js` is what Vite bundles (`src/server.js` is
  unused); `.ts` edits do not ship until the twin is regenerated.

Commands: `npx vitest run libs/utils`, `npx nx typecheck utils`, `npx nx build utils`.
