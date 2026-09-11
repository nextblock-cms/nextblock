<div align="center">

<img src="./apps/nextblock/public/assets/nextblock-banner.jpg" alt="NextBlock CMS — the open-source, full-stack AI-native CMS for Next.js 16, Supabase and Tailwind CSS" width="100%" />

# NextBlock™ CMS

**The open-source, full-stack AI-native CMS for Next.js 16, Supabase, and Tailwind CSS.**

<p align="center">
  <a href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fnextblock-cms%2Fnextblock&project-name=nextblock&repository-name=nextblock&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22supabase%22%2C%22productSlug%22%3A%22supabase%22%7D%5D"><img src="https://vercel.com/button" alt="Deploy with Vercel" height="40" /></a>
</p>

<p align="center">
  <strong>Deploy a production Next.js 16 + Supabase website and CMS in one click.</strong><br/>
  Vercel provisions the database and injects its keys before the first build, NextBlock applies its own<br/>
  schema during that build, and the in-app wizard asks only for your admin account.<br/>
  <strong>No environment variables to fill in.</strong>
</p>

<p align="center">
  <a href="https://cms.nextblock.dev/"><strong>Live Sandbox</strong></a>
  &nbsp;·&nbsp;
  <a href="./docs/README.md"><strong>Documentation</strong></a>
  &nbsp;·&nbsp;
  <a href="./docs/12-VERCEL-DEPLOYMENT.md"><strong>Deploy Guide</strong></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/nextblock-cms/nextblock"><strong>GitHub</strong></a>
</p>

<p align="center">
  <a href="https://nextjs.org"><img src="https://img.shields.io/badge/Next.js-16-black?style=for-the-badge&logo=next.js" alt="Next.js 16"></a>
  <a href="https://supabase.com"><img src="https://img.shields.io/badge/Supabase-Database-3ecf8e?style=for-the-badge&logo=supabase" alt="Supabase"></a>
  <a href="https://tailwindcss.com"><img src="https://img.shields.io/badge/Tailwind-CSS-38bdf8?style=for-the-badge&logo=tailwindcss" alt="Tailwind CSS"></a>
  <a href="https://nx.dev"><img src="https://img.shields.io/badge/Nx-Monorepo-blue?style=for-the-badge&logo=nx" alt="Nx"></a>
  <a href="./LICENSE.md"><img src="https://img.shields.io/badge/License-AGPL%20v3-blue?style=for-the-badge" alt="License: AGPL v3"></a>
</p>

<p align="center">
  <sub>Sandbox resets every 15 minutes &nbsp;·&nbsp; <strong>User:</strong> demo@nextblock.dev &nbsp;·&nbsp; <strong>Pass:</strong> password</sub>
</p>

</div>

---

## 🚀 Why NextBlock™?

Tired of slow WordPress sites? Finding headless CMSs too complex? **NextBlock™** is the sweet spot.

We combined the **flexibility of a Block Editor** with the **raw power of Next.js 16 Server Components**. The result is a CMS that feels like a static site but manages like a dynamic platform.

### ✨ Key Features

- **▲ Next.js 16 App Router + React 19 Server Components**: the public site renders on the server — page, article and product routes are all Server Components — with client components reserved for cart, checkout, forms and the CMS dashboard.
- **🗄️ Supabase PostgreSQL with JSONB block storage**: every content block is a row in `public.blocks` with a `jsonb` `content` column. User-defined block types live in `custom_block_definitions` (`fields` / `layout_schema` as `jsonb`, guarded by Postgres CHECK constraints) and render without a rebuild.
- **🚀 Zero-config 1-click migrations**: the Vercel Supabase integration provisions the database and injects its keys before the first build; NextBlock then applies its own forward-only migrations *during that build* (`tools/build-migrate.mjs`), with a runtime fallback in the `/setup` wizard. Nothing to run, nothing to paste.
- **⚡ [100/100 Lighthouse](./docs/assets/lighthouse-scores.png)**: Perfect scores across Performance, Accessibility, Best Practices and SEO — 0.3 s FCP, 0.8 s LCP, **0 ms** Total Blocking Time and **0** Cumulative Layout Shift on a production build. AVIF/WebP images with a one-year cache TTL, critical-CSS inlining and tree-shaken imports are the defaults, not plugins.
- **🤖 Built for AI Agents**: Our codebase is documented and structured specifically to be easily read and extended by AI coding assistants.
- **🛍️ E-Commerce Ready**: Premium commerce package for digital products, checkout providers, currency, tax, and shipping management.
- **🧱 Visual Block Editor**: A reusable Tiptap-powered Notion-style editor that your clients will actually enjoy using.
- **🔓 Open-Core Model**: The core is 100% Free & Open Source (AGPL). Premium features are activated via License Keys.

## 🆚 The NextBlock™ Advantage

| Feature          | NextBlock™ CMS                 | WordPress                 | Payload / Strapi        |
| :--------------- | :----------------------------- | :------------------------ | :---------------------- |
| **Tech Stack**   | Next.js 16 + Supabase          | PHP + MySQL               | React / Node.js         |
| **Architecture** | Nx Monorepo                    | Monolith                  | Monolith / Workspaces   |
| **Performance**  | 🟢 **100/100 (Default)**       | 🔴 Bloated (Plugins)      | 🟡 Spec-dependent       |
| **Security**     | 🔒 Static/Edge First           | 🔓 Plugin vulnerabilities | 🔒 Secure               |
| **DX**           | 💎 **React Server Components** | 📜 Legacy PHP Hooks       | 🧩 Config Heavy         |
| **AI Ready**     | ✅ **Native**                  | ❌ No                     | 🟡 Integration required |

## 🏁 Get Started

### ☁️ Option 1 — Deploy to the cloud in one click (recommended)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fnextblock-cms%2Fnextblock&project-name=nextblock&repository-name=nextblock&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22supabase%22%2C%22productSlug%22%3A%22supabase%22%7D%5D)

During import, Vercel's native **Supabase Marketplace integration** (the `stores`
button parameter) prompts you to create a Supabase database (name + region), then
**provisions it, connects it to the project, and injects its keys before the first
build** — you never copy a value, and there are **no environment variables to fill in**
(the site URL defaults to your `*.vercel.app` URL and the app secrets are derived
automatically). The app boots with the database already connected: the wizard
auto-skips the connection step, applies the schema for you, uses the connected Supabase
project for media storage, and leaves just "create your admin." Full walkthrough:
[docs/12-VERCEL-DEPLOYMENT.md](./docs/12-VERCEL-DEPLOYMENT.md).

> **Tip — keep the new repo public.** When Vercel asks, leave **"Create private Git
> Repository" unchecked**. On the free (Hobby) plan, automatic upstream updates only deploy
> from a **public** repo — Hobby blocks bot-authored deploys on private repos — and public
> also makes update checks fully tokenless. You can change visibility later in the repo's
> GitHub settings if you change your mind. Details: [docs/13](./docs/13-STAYING-UP-TO-DATE.md).

### 💻 Option 2 — Scaffold locally with the CLI

Stop cloning heavy repos. Start with our CLI and get a production-ready app instantly.

```bash
npm create nextblock@latest
```

This runs the `create-nextblock` CLI, which scaffolds the canonical application. The CLI no longer asks for credentials in the terminal — once the project is created, start it and finish setup in your browser:

```bash
npm run dev   # then open http://localhost:4200/setup
```

The **First-Boot Setup Wizard** at `/setup` walks you through connecting Supabase, configuring storage / email, and creating the first administrator. Every fresh instance redirects there automatically until an admin exists.

> **Want a fully local, zero-config sandbox?** Use **Local Self-Hosted Docker Mode** — one command spins up the entire stack (Supabase engines + S3 storage + the app) on your own machine, with **no cloud accounts**. The app boots straight into the `/setup` wizard with MinIO storage pre-filled. See [docs/11-SELF-HOSTED-DOCKER.md](./docs/11-SELF-HOSTED-DOCKER.md).

---

## 🏗️ For Contributors: The Factory

> **Note:** You are currently looking at the **Nx Monorepo** (The Factory), not the generated product template.
>
> NextBlock™ is an Nx monorepo for a Next.js 16 CMS backed by Supabase. The repo contains the canonical application, the `create-nextblock` CLI, shared editor and UI packages, the database and migration layer, and the premium ecommerce module.

### 🧩 Main Surfaces

- `apps/nextblock`: canonical public site and CMS application
- `apps/create-nextblock`: scaffolding CLI and template sync pipeline
- `libs/db`: Supabase clients, package activation checks, migrations, and db types
- `libs/editor`: reusable Tiptap editor package
- `libs/ecommerce`: premium commerce package and CMS commerce screens
- `libs/sdk`: typed block extensibility contract
- `libs/ui`, `libs/utils`: shared primitives and helpers

### ⚡ Developer Quickstart

**Prerequisites** — configuration happens in the browser, but the `/setup` wizard asks for these, so create them first:

1. **Supabase project** ([dashboard](https://supabase.com/dashboard)) — you'll need the **Reference ID** (Project Settings → General), the **connection string** (Connect → Direct connection → URI), the **anon** + **service_role** keys (Project Settings → API Keys), and a **Personal Access Token** (Account → Access Tokens → Generate new token).
2. **Cloudflare R2 bucket** ([dashboard](https://dash.cloudflare.com) → R2) — create a bucket, enable its **Public Development URL** (Bucket → Settings → General), then create an **Account API token** (R2 → Manage API Tokens) with _Object Read & Write_. Copy the **Access Key ID** and **Secret Access Key** — the secret is shown only once.
3. **SMTP credentials** ([SMTP2GO](https://www.smtp2go.com) works very well) — required so Supabase can email the confirmation link your first admin needs to sign in.

Then run:

```bash
git clone https://github.com/nextblock-cms/nextblock.git
cd nextblock
npm install
npm run setup
npx nx serve nextblock
```

`npm run setup` is informational only — it prompts for nothing and writes no files. Open **http://localhost:4200/setup** and the browser wizard connects Supabase, applies the schema, configures storage / email, and creates your first administrator.

**First login:** the dev server runs at **http://localhost:4200**. Open `/sign-up` and create your account — the **first** account to register automatically becomes the **ADMIN**. Click the confirmation email (or confirm the user in Supabase → Authentication → Users), then sign in to reach the CMS at `/cms/dashboard`.

#### 🐳 Or: one-click local stack (no cloud accounts)

Prefer to run everything on your machine? With **Docker Desktop** running:

```bash
git clone https://github.com/nextblock-cms/nextblock.git
cd nextblock
npm install
npm run docker:setup     # or: npm run setup → pick "Local Self-Hosted Docker Mode"
```

This builds and boots the full self-hosted stack (Postgres + GoTrue + PostgREST + Kong, MinIO for media, and the app) and applies migrations automatically — the only prompts are optional Turnstile and SMTP. The app runs at **http://localhost:3000** and the first sign-up becomes ADMIN (auto-confirmed, no email step). Manage it with `npm run docker:up` / `docker:down` / `docker:logs`. Full guide: [docs/11-SELF-HOSTED-DOCKER.md](./docs/11-SELF-HOSTED-DOCKER.md).

### 🔄 Keeping an install up to date

Whichever way NextBlock was installed, one command brings the code, the dependencies and the
database schema forward together:

```bash
npm run update              # code + dependencies + schema
npm run update -- --check   # report what would change; write nothing
```

- **One-click Vercel / GitHub fork / clone** — already automatic: a daily GitHub Action
  merges upstream and Vercel redeploys. Run the command when you want it *now*.
- **`npm create nextblock` projects** — new framework code comes from the published
  `create-nextblock` package and is applied as a **git 3-way merge**, so your edits to
  framework files survive and only genuine overlaps conflict. Docker installs follow it with
  `npm run docker:up`.

The automatic Action depends on your repository being this monorepo — not on where the site
is hosted. See **[docs/13](./docs/13-STAYING-UP-TO-DATE.md)** for the full picture.

### 🛠️ Useful Commands

- `npm run update` - Update code, dependencies and database schema (any install type)
- `npm run update -- --check` - Preview an update without changing anything
- `npx nx serve nextblock` - Start the local development server for the CMS
- `npm run lint` - Lint the monorepo
- `npm run db:types` - Generate Supabase types
- `npm run db:migrate:check` - Preview pending Supabase migrations safely
- `npm run db:migrate` / `npm run db:push` - Apply pending migration files only, without resets or sandbox seeding
- `npm run db:migrate:repair-history:check` - Preview baseline migration-history repair for existing live databases
- `npm run generate:sandbox` - Generate sandbox data
- `npm run sandbox:reset` - Reset the sandbox environment

### 📚 Documentation Index

The root `docs/` folder is the maintained reference set for both contributors and AI agents.

_The template docs are copied from the root docs through the sync pipeline, so this root docs set is the place to maintain first._

| Document                                                                           | Purpose                                                                                  |
| :--------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------- |
| [docs/01-PROJECT-OVERVIEW.md](./docs/01-PROJECT-OVERVIEW.md)                       | Monorepo structure, runtime model, and where each subsystem lives                        |
| [docs/02-ECOMMERCE-CAPABILITIES.md](./docs/02-ECOMMERCE-CAPABILITIES.md)           | Verified commerce features, checkout providers, currency, tax, shipping, and fulfillment |
| [docs/03-CMS-AND-EDITOR.md](./docs/03-CMS-AND-EDITOR.md)                           | Tiptap editor, page builder, widgets, and built-in block system                          |
| [docs/04-DATABASE-AND-AUTH.md](./docs/04-DATABASE-AND-AUTH.md)                     | Supabase clients, auth flow, schema overview, RLS, and migration map                     |
| [docs/05-DEVELOPER-GUIDE.md](./docs/05-DEVELOPER-GUIDE.md)                         | Local setup, scripts, db workflow, sandbox reset, and contributor operations             |
| [docs/06-CLI-AND-SCAFFOLDING.md](./docs/06-CLI-AND-SCAFFOLDING.md)                 | `create-nextblock`, template sync, and generated-project behavior                        |
| [docs/07-BLOCK-SDK-AND-EXTENSIBILITY.md](./docs/07-BLOCK-SDK-AND-EXTENSIBILITY.md) | SDK contract and extensibility model                                                     |
| [docs/08-NEXTBLOCK-CORTEX-AI-ARCHITECTURE.md](./docs/08-NEXTBLOCK-CORTEX-AI-ARCHITECTURE.md) | Premium Cortex AI package: model routing, BYOK, inline editor and global agent tools |
| [docs/09-LIVE-DRAFT-MODE.md](./docs/09-LIVE-DRAFT-MODE.md)                         | Real-time visual editing and non-destructive draft previewing                            |
| [docs/10-CUSTOM-BLOCKS.md](./docs/10-CUSTOM-BLOCKS.md)                             | Data-driven custom blocks: schema, CRUD, dynamic rendering, and import/export            |
| [docs/11-SELF-HOSTED-DOCKER.md](./docs/11-SELF-HOSTED-DOCKER.md)                   | One-click local self-hosted Docker stack: Supabase engines, MinIO storage, migration runner, and how it maps to cloud |
| [docs/12-VERCEL-DEPLOYMENT.md](./docs/12-VERCEL-DEPLOYMENT.md)                     | One-click cloud deploy, the browser setup wizard, and Supabase env-var aliases            |
| [docs/13-STAYING-UP-TO-DATE.md](./docs/13-STAYING-UP-TO-DATE.md)                   | `npm run update` for all four installs, the daily upstream-sync Action, and how migrations reach a deployed site |
| [docs/README.md](./docs/README.md)                                                 | Audience-based docs index                                                                |

> **Under the hood note:** The migration folder under `libs/db/src/supabase/migrations` is the best source of truth for current platform capabilities.

---

## 🤝 Contributing

NextBlock is open source under [AGPL-3.0-or-later](./LICENSE.md), and contributions are welcome.

- **[CONTRIBUTING.md](./CONTRIBUTING.md)** — setup, everyday commands, and the repo-specific rules that are easy to trip over (append-only migrations, the generated template, the derived artifacts).
- **[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)** — Contributor Covenant v2.1.
- **[SECURITY.md](./SECURITY.md)** — how to report a vulnerability privately. Please never use the public issue tracker for security reports.

---

## 🌐 Connect With Us

Join the community and stay updated on the latest features.

- **X (Twitter):** [@NextBlockCMS](https://x.com/NextBlockCMS)
- **LinkedIn:** [NextBlock™](https://www.linkedin.com/in/nextblock/)
- **GitHub:** [nextblock-cms/nextblock](https://github.com/nextblock-cms/nextblock)
- **Medium:** [@nextblockcms](https://medium.com/@nextblockcms)
- **Dev.to:** [nextblockcms](https://dev.to/nextblockcms)

---

## 🙏 Acknowledgements

Thanks to [Vercel](https://vercel.com) for their support of open-source software.

---

<p align="center">
  <sub>Built with ❤️ by the NextBlock™ Team. Licensed under AGPLv3.</sub>
</p>
