# 01 Project Overview

## What NextBlock Is

NextBlock is an Nx monorepo centered on a Next.js 16 application
(`apps/nextblock`) backed by Supabase. The public site, authenticated CMS,
shared editor, shared database helpers, shared UI primitives, and CLI scaffold
all live in one workspace.

The repository currently contains:

- `apps/nextblock`: the canonical application. This is the runtime source of
  truth for the public site, CMS, checkout routes, cron routes, and auth
  callback behavior.
- `apps/create-nextblock`: the CLI that copies a sanitized template from the
  source app and rewrites it for package-based distribution.
- `libs/db`: Supabase clients, package activation checks, generated database
  types, and the migration tree under `libs/db/src/supabase/migrations`.
- `libs/editor`: the reusable Tiptap-based editor package used by the CMS and
  by scaffolded projects.
- `libs/ecommerce`: the premium commerce package that provides storefront UI,
  checkout providers, order handling, shipping, tax, currency, and CMS pages.
- `libs/sdk`: the block authoring contract used for typed extensibility.
- `libs/ui` and `libs/utils`: shared UI components, styles, and helper
  utilities consumed throughout the workspace.

## Runtime Model

The `apps/nextblock/app` tree is split into a few clear surfaces:

- Public routes: `app/[slug]`, `app/article/[slug]`, `app/product/*`,
  `app/cart`, `app/checkout`, and the shared public `app/layout.tsx`.
- Auth routes: `app/(auth-pages)/*` plus `app/auth/callback/route.ts`.
- CMS routes: `app/cms/*`.
- Operational routes: `app/api/checkout/route.ts`,
  `app/api/webhooks/*`, `app/api/cron/*`, `robots.txt`, and `sitemap.xml`.

The public root layout loads shared UI and editor styles, resolves cached
layout data from Supabase, injects the storefront cart drawer, and reads the
storefront currency cookie. The CMS layout checks whether the ecommerce package
is active so the client-side CMS shell can show or hide store navigation.

## CMS and Public Site Split

The public application and CMS are not separate projects. They share the same
Next.js app and database, but expose different route groups and different
authorization requirements:

- Public content is driven by published pages, posts, navigation, products, and
  translations stored in Supabase.
- CMS routes are guarded in the client layout and expect an authenticated user
  whose profile role is `ADMIN` or `WRITER`.
- Commerce CMS routes such as products, orders, shipping, taxes, and payments
  are only meaningful when the ecommerce package is active.

## Package Activation Gating

Premium functionality is gated through `package_activations` and
`verifyPackageOnline()` in `libs/db/src/lib/package-validation.ts`.

Today that gate is used directly in the app for things like:

- CMS ecommerce navigation visibility.
- The checkout API.
- Premium route wrappers (`app/cms/orders`, `products`, `payments`, `coupons`, …), which redirect to
  `/cms/settings/packages` while the package is inactive.

If a package gate and the actual route behavior disagree, the route file wins.

## Nx Workspace Shape

Nx is used for project graph management, builds, linting, Vite-based library
output, and Next.js app targets. A few practical notes matter when navigating
the repo:

- `nextblock` is the main application target.
- Public libraries such as `db`, `editor`, `sdk`, `ui`, and `utils` are normal
  Nx projects.
- `ecommerce` is an Nx library tagged `scope:premium`.
- The scaffold template under
  `apps/create-nextblock/templates/nextblock-template` is intentionally copied
  output, not a normal Nx project.

## Where to Start

- For overall architecture: read [04-DATABASE-AND-AUTH.md](./04-DATABASE-AND-AUTH.md)
  after this file.
- For day-to-day setup and commands: read
  [05-DEVELOPER-GUIDE.md](./05-DEVELOPER-GUIDE.md).
- For CLI behavior and template sync: read
  [06-CLI-AND-SCAFFOLDING.md](./06-CLI-AND-SCAFFOLDING.md).
- For editor and block work: read
  [03-CMS-AND-EDITOR.md](./03-CMS-AND-EDITOR.md).
- For commerce work: read
  [02-ECOMMERCE-CAPABILITIES.md](./02-ECOMMERCE-CAPABILITIES.md).
