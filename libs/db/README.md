# @nextblock-cms/db

The database layer of [NextBlock](https://github.com/nextblock-cms/nextblock), the open-core CMS
for Next.js and Supabase: Supabase clients for each trust level, the generated `Database` types,
secret encryption, and the premium-package license check. It also ships the NextBlock database
migrations.

Projects created with `npm create nextblock@latest` already depend on it. It is built for
NextBlock projects (Next.js 16, React 19, `@supabase/ssr`) rather than as a general-purpose
library.

```bash
npm install @nextblock-cms/db
```

## Entry points

| Import | Use it from | What it holds |
| :-- | :-- | :-- |
| `@nextblock-cms/db` | client | The browser Supabase client (`createClient`), the `Database` types, and client-side profile and language lookups |
| `@nextblock-cms/db/server` | server only | `createClient()` scoped to the request cookies, `getSsgSupabaseClient()` for public reads, `getServiceRoleSupabaseClient()` for admin work only (it bypasses Row Level Security), `verifyPackageOnline()`, secret encryption and config resolution |
| `@nextblock-cms/db/secrets` | server only | Secret encryption (`encryptSecret`, `decryptSecret`) and config resolution, without the Supabase clients |
| `@nextblock-cms/db/types` | types only | The generated `Database` types |

Pick the server client by trust level. Use the service-role client only in code that has
already checked the caller's role.

## Environment

The clients read `NEXT_PUBLIC_SUPABASE_URL` or `SUPABASE_URL`, the publishable (anon) key under
either its `NEXT_PUBLIC_` or its plain name, and, for the service-role client,
`SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_SECRET_KEY`. The alternative names are the ones the
Vercel Supabase integration injects.

## Migrations

The package includes `supabase/` with the NextBlock migrations. `npm run update` in a NextBlock
project copies them into the project's `supabase/migrations` and applies the pending ones.

## Documentation

- [Database and auth](https://github.com/nextblock-cms/nextblock/blob/master/docs/04-DATABASE-AND-AUTH.md)
- [Staying up to date](https://github.com/nextblock-cms/nextblock/blob/master/docs/13-STAYING-UP-TO-DATE.md)

## License

AGPL-3.0-or-later.
