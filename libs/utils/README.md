# @nextblock-cms/utils

Shared helpers for [NextBlock](https://github.com/nextblock-cms/nextblock), the open-core CMS
for Next.js and Supabase: class-name and price utilities, the translation context, custom-block
schemas, the SEO engine, and the NextBlock package registry.

Projects created with `npm create nextblock@latest` already depend on it. It is built for
NextBlock projects (Next.js 16, React 19) rather than as a general-purpose library.

```bash
npm install @nextblock-cms/utils
```

## Entry points

| Import | Use it from | What it holds |
| :-- | :-- | :-- |
| `@nextblock-cms/utils` | client or server | `cn`, price formatting, `TranslationsProvider` / `useTranslations`, custom-block schemas, publishing helpers, the package registry (`NEXTBLOCK`, `getPackageById`), colour and media-variant helpers, the SEO engine |
| `@nextblock-cms/utils/seo` | client or server | The SEO engine alone (`auditSeo` and its helpers). It has no Zod, React or Supabase imports, so it also runs in middleware. |
| `@nextblock-cms/utils/server` | server only | S3 / Cloudflare R2 clients (`getS3Client`, `getS3PresignClient`, `deleteMediaFiles`), `encodedRedirect`, `getEmailServerConfig`, `hasEnvVars` |
| `@nextblock-cms/utils/<module>` | depends on the module | One compiled module from `lib/`, for example `@nextblock-cms/utils/script-safety` |

`@nextblock-cms/utils/server` throws if a Client Component imports it. It is not a
`"use server"` module, so none of its functions can be called from the browser as a Server
Action.

## Environment

The server entry reads the storage variables (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, optional `R2_S3_ENDPOINT` / `R2_S3_PUBLIC_ENDPOINT`)
and the SMTP variables (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM_EMAIL`).
`hasEnvVars()` accepts both the `NEXT_PUBLIC_SUPABASE_*` names and the `SUPABASE_URL` /
`SUPABASE_PUBLISHABLE_KEY` names the Vercel Supabase integration injects.

## Documentation

- [Developer guide](https://github.com/nextblock-cms/nextblock/blob/master/docs/05-DEVELOPER-GUIDE.md)
- [Custom blocks](https://github.com/nextblock-cms/nextblock/blob/master/docs/10-CUSTOM-BLOCKS.md)
- [CMS and editor](https://github.com/nextblock-cms/nextblock/blob/master/docs/03-CMS-AND-EDITOR.md)

## License

AGPL-3.0-or-later.
