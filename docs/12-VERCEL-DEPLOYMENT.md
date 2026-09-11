# 12 · Cloud Deployment (Deploy to Vercel)

NextBlock ships a one-click **Deploy to Vercel** button (see the README) that brings
up a production instance already connected to a managed Supabase project. From there,
the in-app **First-Boot Setup Wizard** (`/setup`) finishes configuration in the
browser — there is no terminal step.

## How the button works

The badge links to `https://vercel.com/new/clone` with these query parameters:

| Parameter | Purpose |
| :--- | :--- |
| `repository-url` | The NextBlock repo to clone into the user's Git provider. |
| `project-name` / `repository-name` | Pre-fill the new Vercel project and Git repo names. |
| `stores=[{"type":"integration","integrationSlug":"supabase","productSlug":"supabase"}]` | Vercel's **native Supabase Marketplace integration**. During import you're prompted to **create a Supabase database** (name + region); Vercel **provisions it, connects it to the project, and injects the env vars before the first build**. |

There is deliberately **no `env=` parameter** — the deploy prompts for **zero** values you
have to type (see "No environment variables required" below). The only interaction is the
Supabase integration's "create database" step, which can't be skipped because provisioning
a Postgres DB requires choosing a region/plan.

> **Why `stores`, not `integration-ids`?** Both parameters are current — neither is
> deprecated — but they do different jobs, and only one of them provisions a database.
>
> **`integration-ids=oac_…`** ([docs](https://vercel.com/docs/deploy-button/integrations))
> only forces an integration to be **installed and authorized before the project can be
> imported** (up to three per project). Vercel's documentation makes no promise about
> environment variables either way: whether credentials land in the project is a property
> of that integration's own OAuth flow, not of the parameter. Supabase's flow does set
> them — the `vercel/next.js` `with-supabase` example states that "all relevant environment
> variables will be assigned to the project" after installation — so this route can work.
> It just isn't Vercel guaranteeing it, and it says nothing about *when* they land.
>
> **`stores`** ([docs](https://vercel.com/docs/deploy-button/source)) is the native
> Marketplace path: it creates the store **as part of the deployment** and creates the
> environment variables for it. That timing is what NextBlock actually depends on — the
> build-time migration hook needs `POSTGRES_URL` to exist *during* the first build, not
> after it. See "Build configuration" below.
>
> The deciding evidence is Vercel's own Template Gallery entry for the Supabase Starter,
> which ships the **exact `stores` payload** used above.
>
> **If you ever add an `integration-ids` fallback, the only correct Supabase value is
> `oac_VqOgBHqhEoFTPzGkPd7L0iH6`** — confirmed in `supabase/supabase`'s own example READMEs
> and in the Vercel record behind `vercel.com/templates/next.js/supabase`. A plausible
> lookalike, `oac_VqOgBHqhvvqGe2YujqqiW0wo`, circulates in AI-generated snippets and is
> **not a real integration id**; it shares only the first twelve characters. An unknown id
> makes Vercel refuse the import outright, which breaks the deploy completely.

## Connect the database (Supabase integration)

The `stores` parameter makes Vercel prompt you to create a Supabase database during import.
Pick a **name** and **region**, and Vercel **automatically injects** the integration's
environment variables into the project — you never copy a value. The native integration
injects the **new-style** Supabase key names, e.g.:

`NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` /
`SUPABASE_PUBLISHABLE_KEY` (the anon-equivalent), `SUPABASE_SECRET_KEY` (the
service-role-equivalent), and `POSTGRES_URL` (+ the other `POSTGRES_*` parts).

NextBlock reads **all** of these aliases (see `apps/nextblock/lib/setup/env-status.ts`):
it accepts `NEXT_PUBLIC_SUPABASE_URL` *or* `SUPABASE_URL`; anon *or* `PUBLISHABLE_KEY`;
`SUPABASE_SERVICE_ROLE_KEY` *or* `SUPABASE_SECRET_KEY`. So the wizard's connection step
auto-skips no matter which copy the integration set, and the browser client gets the
publishable key bridged in as the anon key at build time.

> If the database step still appears after a deploy that connected the store, the env vars
> landed **after** that build — **Redeploy** once (Vercel binds env vars at deploy time).
> With the `stores` flow they're injected *before* the first build, so this is rarely needed.

On that deploy the wizard skips the database-connection step, **auto-applies the schema**
(the migrations are embedded in the build — see `lib/setup/migrations-bundle.ts` — and run
via the injected `POSTGRES_URL`), uses the connected Supabase project for media storage,
and goes straight to creating the first administrator.

> Until the schema is applied and the first admin exists, **every route redirects to
> `/setup`** (the homepage does *not* 404). The middleware treats a "schema not applied yet"
> database error as *unprovisioned* and funnels traffic to the wizard.

## Build configuration (Nx monorepo)

NextBlock is an Nx monorepo — the Next.js app lives at `apps/nextblock`, not the repo
root — so a bare `next build` at the root fails with *"Couldn't find any `pages` or
`app` directory."* The root [`vercel.json`](../vercel.json) pins the correct build, so
the one-click deploy needs **no manual dashboard configuration**:

```json
{
  "buildCommand": "npx nx build nextblock --prod",
  "outputDirectory": "apps/nextblock/.next",
  "framework": "nextjs"
}
```

- **`buildCommand`** runs the Nx target from the repo root, which resolves the
  workspace libraries (`@nextblock-cms/*` via the TS path aliases) and builds the app.
- **`outputDirectory`** points at the app's `.next`. This `@nx/next` version emits it
  to `apps/nextblock/.next` — **not** `dist/apps/nextblock/.next` (which only receives
  the deploy wrapper: `package.json`, `next.config.js`, `public/`). Verify with
  `npx nx build nextblock --prod` then check `apps/nextblock/.next/BUILD_ID`.
- **`framework: nextjs`** keeps Vercel's first-class Next.js runtime (SSR/ISR
  functions, image optimization, the `proxy.ts` middleware).

Leave the Vercel project's **Root Directory unset** (the repo root) — the build command
already targets the app. Do **not** set Root Directory to `apps/nextblock`: the app
imports the workspace libraries one level up, which a custom Root Directory would hide
(Vercel forbids `..` above a custom root).

## No environment variables required

A Deploy-Button URL can carry environment variable **names** (`env`), and non-sensitive
**default values** (`envDefaults`) — but never secrets: Vercel's own docs warn that the URL
"is saved in the browser history, making it insecure" and to "never use default values for
sensitive data like passwords, API keys, tokens, database credentials." NextBlock sidesteps
the question entirely by resolving everything in-app, so the button prompts for nothing:

- **`NEXT_PUBLIC_URL`** — optional. When unset the app falls back to Vercel's
  production URL (`VERCEL_PROJECT_PRODUCTION_URL` server-side /
  `NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL` in the browser), i.e. your
  `*.vercel.app` domain. Sitemap, robots, and canonical links use it automatically.
  Add a custom domain later, set `NEXT_PUBLIC_URL=https://yourdomain.com` in the
  Vercel project, and redeploy (it is inlined at build time).
- **`DRAFT_MODE_SECRET`** and **`REVALIDATE_SECRET_TOKEN`** — optional. When unset they
  are derived deterministically from the Supabase service-role key (HMAC-SHA256), so
  Draft Mode and on-demand revalidation work out of the box. Setting either env var
  overrides the derived value — do this if you want a fixed `REVALIDATE_SECRET_TOKEN`
  to paste into a Supabase revalidation webhook. (See `apps/nextblock/lib/app-secrets.ts`.)
- **`CRON_SECRET`** — optional. The cron endpoints enforce the `Authorization: Bearer`
  header **only when it is set**. Leave it unset for a frictionless deploy, or set it
  in the Vercel project to lock the cron endpoints down. The destructive
  `/api/cron/reset-sandbox` job is independently gated to sandbox-mode only (404
  otherwise), so it never runs on a normal deploy.

## What the wizard does on Vercel

1. **Database** — already connected (integration-injected). The wizard verifies a
   first admin doesn't exist yet, otherwise it redirects to `/cms/dashboard`. The
   connection step is **auto-skipped**.
2. **Schema** — applied **automatically**. The Supabase integration creates the project
   but does **not** run NextBlock's migrations, so the wizard applies them itself on the
   final step: it runs the build-embedded migration bundle over the injected
   `POSTGRES_URL` (no CLI, no manual SQL). Idempotent — a re-run is a no-op. See
   [docs/04](./04-DATABASE-AND-AUTH.md) and [docs/05](./05-DEVELOPER-GUIDE.md).
3. **Storage** — **skipped on Vercel; nothing to configure.** Media uses **native
   Supabase Storage** through the already-connected project: the injected
   `SUPABASE_SECRET_KEY` authenticates uploads/downloads/deletes via the Supabase client
   (no S3 access keys required), a public `media` bucket is auto-created, and images are
   served from `<project>/storage/v1/object/public/media/…`. The storage backend is
   selected automatically (`apps/nextblock/lib/storage/provider.ts`): if S3/R2 keys are
   present it uses them; otherwise it falls back to native Supabase Storage. (Cloudflare
   R2 remains the default for non-Vercel installs — it has a more generous free storage
   tier; set the `R2_*` env vars to use it on Vercel instead.)

   > **Upload size:** the CMS media uploader proxies the file through a serverless
   > function (`/api/upload/proxy`), which is subject to Vercel's ~4.5 MB request-body
   > limit — larger single images fail on the Hobby/Pro serverless runtime regardless of
   > storage backend. This is a platform constraint, not a NextBlock one.
4. **Email / Bot protection / Sign-ups** — optional steps; bot-protection and the
   sign-up policy persist to the database and work immediately. SMTP, if used, is set
   as Vercel environment variables.
5. **Administrator** — create the first admin. The account is created already
   confirmed (`email_confirm: true`), so no verification email is required.

> Filesystem is read-only on Vercel, so the wizard never writes `.env.local` there —
> all configuration is environment variables (platform-managed) plus the database.

## Cron jobs and the Hobby plan

`vercel.json` declares two crons: `/api/cron/reset-sandbox` **every 15 minutes**
(`*/15 * * * *`) and `/api/cron/sync-currencies` daily at 18:00 UTC. The 15-minute
schedule is what keeps the public sandbox at `cms.nextblock.dev` fresh; that project
runs on **Vercel Pro**, which allows cron schedules down to once per minute with
per-minute precision.

Vercel’s **Hobby (free) tier only allows cron jobs that run at most once per day**
(timing is approximate, ±59 min), and **a sub-daily schedule fails the deployment**
outright. So on a Hobby project you must **delete the `reset-sandbox` entry from
`vercel.json`** before deploying. Nothing is lost: `reset-sandbox` only does work in
sandbox mode — it returns 404 otherwise — so on a normal deploy it is a harmless
no-op anyway. `sync-currencies` is daily and deploys fine on Hobby.

## After deploy

Visit the deployment URL — it redirects to `/setup` until the first admin exists.
Complete the wizard, then sign in at `/cms/dashboard`.

**Automatic updates.** The 1-click deploy creates a **new repository you own** (a copy —
*not* a GitHub fork) and ships a daily upstream-sync GitHub Action. Because it's your own
repo, **Actions are enabled by default — there's nothing to turn on**; the workflow runs
once it's on your **default branch**, and the dashboard onboarding step completes
automatically when GitHub registers it. We recommend keeping the repo **public** (fully
zero-config); a **private** repo additionally needs a `NEXTBLOCK_GITHUB_TOKEN` env var for
the in-CMS conflict banner. (Only a *manually-created GitHub fork* has Actions disabled
until you enable them on the Actions tab.) Full details — both tracks, conflict handling,
and build-time migrations — are in [docs/13](./13-STAYING-UP-TO-DATE.md).

> **This applies to the 1-click deploy specifically, not to "anything on Vercel".** The
> sync workflow merges the NextBlock **monorepo** into your repository, so it only works
> where your repository *is* that monorepo — a 1-click deploy, a GitHub fork, or a clone. A
> project created with `npm create nextblock` is the flattened standalone app; deploying it
> to Vercel does not change its shape, and NextBlock deliberately does not offer it the
> workflow (merging `apps/`, `libs/` and `nx.json` into it would wreck it). That kind of
> install updates with `npm run update` — see [docs/13](./13-STAYING-UP-TO-DATE.md).
