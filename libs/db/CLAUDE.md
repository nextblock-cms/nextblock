# libs/db — @nextblock-cms/db

Supabase layer: client factories, generated types, secret crypto, package activation, and the
migration tree (shipped in the npm package under `supabase/`).

Entry points: `@nextblock-cms/db` (browser `createClient`, Row types); `/server`
(`createClient()` cookie scope, `getSsgSupabaseClient()`, `getServiceRoleSupabaseClient()`,
`verifyPackageOnline()`, secret + config helpers); `/secrets`. Implementations live in
`src/lib/**`; `src/server.ts` is a barrel.

## Rules
- Every factory accepts the alias chain: URL `NEXT_PUBLIC_SUPABASE_URL → SUPABASE_URL`; anon
  `NEXT_PUBLIC_SUPABASE_ANON_KEY → SUPABASE_ANON_KEY → NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY →
  SUPABASE_PUBLISHABLE_KEY`; service `SUPABASE_SERVICE_ROLE_KEY → SUPABASE_SECRET_KEY`.
  Bracket-access undeclared names (`noPropertyAccessFromIndexSignature`).
- Encryption key chain: `NEXTBLOCK_ENCRYPTION_KEY → CORTEX_AI_ENCRYPTION_KEY → HMAC of the
  service key`; rotating the service key invalidates the derived key.
- Migrations `src/supabase/migrations/GGNNN_<snake_name>.sql` (GG = squash generation, NNN =
  sequence): `GG000_catchup_gen<G-1>` replays the retired generation version-aware (runs first),
  `GG001`–`GG004` are the generation's idempotent baseline (seed runs on empty databases only),
  `GG005+` are forward migrations. Next number = highest on disk + 1, same generation; `npm run db:migrate:check` prints
  it and fails on any other name shape. Rules + squash runbook: `docs/04-DATABASE-AND-AUTH.md`.
- `db:types` queries the remote project in `SUPABASE_PROJECT_ID`; unapplied migrations never
  reach `types.ts`.
- `nx build db` runs `vite build`, then `tools/scripts/copy-db-supabase.cjs`, which owns
  `dist/libs/db/supabase` (it refuses another destination, a link or a real-path overlap with the
  source), empties it and copies `SUPABASE_PACKAGE_ENTRIES` (`config.toml`, `migrations/`,
  `templates/`: what create-nextblock, `npm run update` and migrate-core read), no dot entry at
  any depth; a consumer reading a new entry means adding it there (`copy-db-supabase.test.ts`).
  `functions/` (the Deno edge function, also out of the dts step: `vite.config.ts` `exclude`) and
  the CLI's local state (`.temp/`, `.branches/`, local Studio's `snippets/`, `signing_keys.json`)
  never ship.
- The real-path check guards the copy only: vite's `emptyOutDir` empties `dist/libs/db` first,
  through any link, so never link `dist/` or a folder below it into the checkout.
- `verify-lib-dist.js` check 12 refuses a packed dot path; check 13 any other `supabase/` entry, a
  missing one or one in the wrong shape (`config.toml` a file, the other two folders); check 14 a
  `migrations/` file that is not a top-level `<digits>_*.sql` passing `validateMigrationNames`, a
  non-`.html` template, and packed migration names that differ from those the `/setup` bundle
  embeds (names only, not the SQL: run `npm run generate:migrations-bundle` after adding one).

Commands: `npx nx build db`, `npm run nx:lint:db`, `npx vitest run libs/db`.

Do not edit: `src/lib/supabase/types.ts` (generated), applied migrations, the stale tracked
`.js`/`.d.ts` twins beside `.ts` sources, `src/lib/supabase/middleware.ts` (unused).
