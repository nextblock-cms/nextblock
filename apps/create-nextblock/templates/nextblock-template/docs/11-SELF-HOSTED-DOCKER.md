# 11 Self-Hosted Docker Mode

## Purpose

NextBlock can run as a complete, fully local stack with one command — **no Supabase
Cloud, Vercel, Cloudflare R2, or SMTP account required**. It mirrors the production
topology (Next.js 16 app + Supabase API behind a gateway + S3 object storage) on your
own machine, so the **same application code runs locally and in the cloud with no
variations** — only environment values differ.

This is the "one-click local sandbox": pick Docker, and the installer drop-ships a
hardened multi-stage app image alongside the core Supabase engines, an automated
migration runner, and S3-compatible storage.

## Choosing it

Both initializers offer the choice up front:

- **Monorepo / `git clone`:** `npm run setup` → select **"Local Self-Hosted Docker Mode"**
- **Standalone CLI:** `npm create nextblock` → the same selector
- **Direct:** `npm run docker:setup`

In every case the work is driven by a single root hook: **`npm run docker:setup`**.

## Prerequisites

- **Docker Desktop** installed and running (<https://www.docker.com/products/docker-desktop>).
- That's it. No cloud accounts, keys, or manual migrations.

## Quick start

```bash
# Monorepo
git clone https://github.com/nextblock-cms/nextblock.git
cd nextblock
npm install
npm run docker:setup          # or: npm run setup  →  pick Docker

# Standalone project
npm create nextblock          # →  pick "Local Self-Hosted Docker Mode"
```

`docker:setup` then:

1. Verifies Docker is installed and running.
2. Asks **two optional questions** (Cloudflare Turnstile, SMTP) — both skippable with Enter.
3. Generates a root `.env` with secure random secrets and **properly-signed Supabase
   anon/service keys** (real HS256 JWTs derived from a generated `JWT_SECRET`).
4. Builds the app image and boots the whole stack.

When it finishes:

| What | Where |
| :--- | :--- |
| App | <http://localhost:3000> |
| Sign up | <http://localhost:3000/sign-up> — the **first account becomes ADMIN** |
| Supabase API gateway | <http://localhost:8000> |
| MinIO console | <http://localhost:9001> |

With no SMTP configured, accounts are **auto-confirmed** and the first sign-up lands
straight in `/cms/dashboard` — no confirmation email step.

## The two optional prompts

| Prompt | If you skip it |
| :--- | :--- |
| **Cloudflare Turnstile** site + secret key | Uses Cloudflare's official "always pass" test keys — forms work, with no real bot protection. |
| **SMTP** host (+ port / user / pass / from) | GoTrue **auto-confirms** sign-ups; no email is sent, and the first admin can sign in immediately. |

Provide real SMTP if you want actual confirmation emails — auto-confirm is then disabled,
exactly like the cloud flow.

## What you get (the stack)

The root `docker-compose.yml` runs a trimmed, production-equivalent Supabase stack plus
the app. Every image tag is pinned and overridable via an env var (e.g. `SUPABASE_DB_IMAGE`).

| Service | Image (default) | Role |
| :--- | :--- | :--- |
| `db` | `supabase/postgres` | Postgres with the Supabase roles, schemas, and extensions. Named volume `nextblock_db_store`. |
| `auth` | `supabase/gotrue` | Auth: sessions, JWTs, the `auth.users` table. |
| `rest` | `postgrest/postgrest` | Instant REST API over the `public` / `graphql_public` schemas. |
| `kong` | `kong` | Edge gateway — maps `/auth/v1`, `/rest/v1`, `/graphql/v1` to port **8000**. |
| `minio` + `minio-init` | `minio/minio`, `minio/mc` | S3-compatible media storage + a public `nextblock` bucket. Named volume `nextblock_media`. |
| `migrate` | `postgres:alpine` | Applies `libs/db/src/supabase/migrations` in order, **once**, then exits. |
| `nextblock-cms` | built locally | The Next.js standalone app on **3000**. Boots **only after `migrate` succeeds**. |

Both named volumes persist your database and uploaded media across restarts.

### Commands

| Command | Does |
| :--- | :--- |
| `npm run docker:setup` | Generate `.env` → build → up. The one-click entry point. |
| `npm run docker:up` | Rebuild and (re)start the stack. |
| `npm run docker:down` | Stop the stack. Add `-v` to also delete the volumes (wipes local data). |
| `npm run docker:logs` | Follow the app logs (`docker compose logs -f nextblock-cms`). |
| `npm run update` | Update the app, its dependencies and the staged migration SQL. Follow it with `docker:up`, which is what applies the migrations — see below. |

> **Updating a Docker install: `npm run update` then `npm run docker:up`.** The updater
> deliberately does *not* apply migrations here. This stack ships its own migration runner
> (the `migrate` service, which mounts `supabase/migrations` and records applied versions in
> `public._nextblock_docker_migrations` — a different tracker from the one every other
> install uses), so applying the same SQL from the updater as well would run it through two
> trackers. The updater refreshes the SQL on disk and hands the schema step to the stack.
> Full details in [docs/13](./13-STAYING-UP-TO-DATE.md). Migration squashes (new
> `GG000`–`GG004` generations, see [docs/04](./04-DATABASE-AND-AUTH.md)) need nothing
> extra here: the generation's catch-up file consults `public._nextblock_docker_migrations`
> by file stem, so it replays only what this stack never applied.

### Ports (override with env vars)

`APP_PORT` (3000), `KONG_HTTP_PORT` (8000), `MINIO_S3_PORT` (9000),
`MINIO_CONSOLE_PORT` (9001), `POSTGRES_PORT_EXTERNAL` (54322).

## How it works

The interesting part is making one codebase work unchanged in both modes. A few
mechanisms make that possible:

- **Standalone build.** The app Dockerfile is multi-stage (deps → builder → hardened
  non-root runner) and builds with Next.js `output: 'standalone'`, gated on a
  `DOCKER_BUILD` env var so normal/Vercel builds are untouched. The runner ships only the
  traced server tree, `.next/static`, and `public`.

- **One URL + an in-container loopback proxy.** The browser reaches Supabase at
  `http://localhost:8000`, and that value is inlined into the build. Server-side code runs
  *inside* the container, where `localhost` has nothing — so the runner starts a tiny
  `socat` proxy that forwards in-container `127.0.0.1:8000 → kong:8000` and
  `127.0.0.1:9000 → minio:9000`. Browser and server therefore use the **same URL**, which
  also keeps the Supabase auth-cookie key (derived from the URL host) identical on both
  sides so SSR can read the session.

- **Storage on `127.0.0.1`.** Media URLs use `http://127.0.0.1:9000` (not `localhost`).
  On `localhost`, cookies are not port-scoped, so the browser would otherwise send the
  app's auth cookies to MinIO and trip its header-size limit. `127.0.0.1` is a different
  cookie host, so MinIO always receives clean image requests.

- **Migration runner.** The `migrate` service waits for the database to be healthy and
  for GoTrue to create `auth.users` (the schema FKs to it), then applies each migration in
  order inside a transaction. It records applied versions, so restarts never re-run a
  migration.

- **Generated keys.** `docker:setup` generates a `JWT_SECRET` and derives valid HS256
  `anon` and `service_role` JWTs from it (using Node's built-in `crypto`), so GoTrue,
  PostgREST, and Kong all validate against the same secret out of the box.

## Cloud vs Docker — same code, different env

There are **no application code paths** specific to Docker. The difference is purely
configuration:

| | Managed Cloud | Self-Hosted Docker |
| :--- | :--- | :--- |
| Database / Auth | Supabase Cloud | `supabase/postgres` + `supabase/gotrue` |
| Object storage | Cloudflare R2 | MinIO (S3-compatible) |
| Email | Required SMTP | Optional — GoTrue auto-confirms without it |
| Run command | `npx nx serve nextblock` / Vercel | `npm run docker:setup` |
| Config | `.env.local` (cloud keys) | `.env` (generated local secrets) |

> The R2 client already speaks S3, so MinIO is pointed at it via `R2_S3_ENDPOINT` /
> `R2_FORCE_PATH_STYLE`; uploads are signed for the browser via `R2_S3_PUBLIC_ENDPOINT`.
> A reference of every key the stack reads lives in `.env.docker.example`.

## Troubleshooting

- **"Docker is not installed or not running."** Start Docker Desktop and re-run
  `npm run docker:setup`.

- **`port is already allocated`.** Another process (often a previous stack) holds 8000 /
  9000 / 3000 / 54322. Stop it, or override the port env vars above.

- **GoTrue fails with `password authentication failed for user "supabase_auth_admin"`
  (28P01) after a re-clone.** A leftover named volume from a previous install still holds
  the old password, while your new `.env` has fresh secrets. Postgres only runs its
  credential-setting init scripts on an *empty* volume. Fix:
  `docker compose down -v && npm run docker:up`. (`docker:setup` does this automatically
  when it generates a brand-new `.env`.)

- **Re-running `docker:setup`.** If a `.env` already exists it **reuses your secrets and
  keeps your data** — safe to re-run to rebuild after pulling changes.

- **Wipe everything and start clean.** `docker compose down -v` removes the containers and
  both named volumes (database + media).
</content>
