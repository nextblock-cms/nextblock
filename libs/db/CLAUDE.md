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
- Migrations `src/supabase/migrations/<14 digits>_<name>.sql`: `000`–`003` are the non-replayable
  baseline; next number = highest on disk + 1; confirm with `npm run db:migrate:check`.
- `db:types` queries the remote project in `SUPABASE_PROJECT_ID`; unapplied migrations never
  reach `types.ts`.

Commands: `npx nx build db`, `npm run nx:lint:db`, `npx vitest run libs/db`.

Do not edit: `src/lib/supabase/types.ts` (generated), applied migrations, the stale tracked
`.js`/`.d.ts` twins beside `.ts` sources, `src/lib/supabase/middleware.ts` (unused).
