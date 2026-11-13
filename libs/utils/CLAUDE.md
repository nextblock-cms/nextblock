# libs/utils — @nextblock-cms/utils

Bottom of the stack (no `@nextblock-cms/*` deps): Zod contracts, the pure SEO engine, script
safety, publishing state, color/currency helpers, the package registry, a server-only R2/SMTP entry.

Entry points: `.` (curated barrel incl. all of `./seo`); `./server`; `./seo` (pure: `auditSeo`,
`buildSeoDocument`, redirects, robots); `./custom-blocks`; `./utils`; `./media-variants`;
`./media-url` (client-safe `resolveMediaUrl`, `BUNDLED_PUBLIC_MEDIA_KEYS`; ecommerce and the app's
`lib/media/resolveMediaUrl.ts` re-export use it). `./script-safety` and `./editor-blocks` (Tiptap
JSON schemas) resolve through the monorepo alias only, not in dist.

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

## Gotchas
- `server.{es,cjs}.js` + `server.d.ts` are compiled from `src/server.ts` like every other module.
  Never write JS output from `afterBuild`: it runs after the ESM files are written and before the
  CommonJS ones, so it overwrites real ESM output and its CommonJS files get overwritten (the
  hand-written server entry did both through 0.20).
- The stale tracked twins (`src/lib/server-utils.js`, `src/server.js`) are ignored:
  `resolve.extensions` puts `.ts` first here and in the root `vitest.config.ts`, so the `.ts`
  sources are what ships and what the tests run.
- `src/lib/server-utils.ts` is server-only but must never be a `"use server"` module: that would
  make `getEmailServerConfig()` (it returns the SMTP password) callable from the browser once a
  client component imports it. It throws in a browser instead; `server-utils.test.ts` guards it.

Commands: `npx vitest run libs/utils`, `npx nx typecheck utils`, `npx nx build utils`.
