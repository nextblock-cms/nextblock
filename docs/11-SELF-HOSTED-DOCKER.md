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
2. Generates a root `.env` with secure random secrets and **properly-signed Supabase
   anon/service keys** (real HS256 JWTs derived from a generated `JWT_SECRET`). It asks no
   questions: Cloudflare Turnstile and SMTP stay blank (see "Optional integrations" below)
   and are configured later in the CMS.
3. Builds the app image and boots the whole stack.

When it finishes:

| What | Where |
| :--- | :--- |
| App | <http://localhost:3000> |
| Sign up | <http://localhost:3000/sign-up> — the **first account becomes ADMIN** |
| Supabase API gateway | <http://localhost:8000> |
| MinIO console | <http://localhost:9001> |

With no SMTP configured, accounts are **auto-confirmed** and the first sign-up lands
straight in `/cms/dashboard` — no confirmation email step.

## Headless (agent-driven) install

Docker is the default profile of `npm create nextblock -- --non-interactive --name … --email …`
(docs/06 → "Headless mode"). The CLI runs the same `docker-setup.mjs`, with three
differences:

- It hands `MCP_BEARER_TOKEN`, `NEXTBLOCK_LICENSE_KEY` and `NEXTBLOCK_LICENSE_KIND` to the
  script through the process environment; the script persists them into `.env` (a value
  already in `.env` wins, so re-runs never rotate a token the agent configs were written
  with) and `docker-compose.yml` passes them to the `nextblock-cms` container.
- It polls `GET /api/setup/status` on the app URL read back from `.env` (the port may have
  been remapped) until the migrate container has finished, then creates the first
  administrator through `POST /api/setup/bootstrap` instead of the browser wizard. The
  generated password is stored as `NEXTBLOCK_ADMIN_PASSWORD` in `.env` — the file the agent
  guardrails deny — and never printed.
- It writes `.mcp.json` / `.cursor/mcp.json` pointing at `http://localhost:<APP_PORT>/api/mcp`
  with the bearer token, so the agent's next session can operate the site over MCP.

By default (attended) the user then opens `/setup`, creates their account, and starts the
free Cortex AI trial on the welcome screen — the same Freemius overlay flow as any install.
That is why the Docker profile now runs as a **normal self-hosted install**: `docker:setup`
no longer writes `NEXT_PUBLIC_IS_SANDBOX` (unset means "not a sandbox") and drops a stale
`NEXT_PUBLIC_IS_SANDBOX=true` from an older `.env` on re-run. That flag, a leftover from the
first Docker experiments, made `/cms/welcome` redirect away and disabled license activation,
MCP token minting, and saving AI keys. Only the hosted demo at nextblock.dev sets it. In unattended
mode the Cortex AI license is activated inside the container from `NEXTBLOCK_LICENSE_KEY`
(docs/08 → "Headless bootstrap").

## Optional integrations (blank by default)

| Integration | Default on a fresh install |
| :--- | :--- |
| **Cloudflare Turnstile** (`NEXT_PUBLIC_TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY`) | **No captcha keys.** The bot-protection provider is `none`, so the sign-up and contact forms rely on the honeypot field (plus the contact form's per-IP throttle). Enable a real captcha in **CMS → Settings → Bot Protection** with keys from your Cloudflare account. |
| **SMTP** (`SMTP_HOST` + port / user / pass / from) | GoTrue **auto-confirms** sign-ups; no email is sent, and the first admin can sign in immediately. |

Provide real SMTP if you want actual confirmation emails — auto-confirm is then disabled,
exactly like the cloud flow.

> **Never use Cloudflare's Turnstile test keys** (the `1x…`, `2x…`, `3x…` site and secret
> keys) on an install. The `1x…` secret accepts every token, so a form renders a working-looking
> widget while passing every bot. Earlier versions of `docker:setup` wrote that pair into
> `.env` as the "skipped" default; it now writes blank values and drops any test key it finds in
> an existing `.env` on re-run (a yellow `Dropped Cloudflare Turnstile TEST key(s)` line). With
> blank keys, switching the provider to Turnstile without configuring keys **fails closed**
> ("Bot protection is misconfigured") instead of silently passing.

## What you get (the stack)

The root `docker-compose.yml` runs a trimmed, production-equivalent Supabase stack plus
the app. Every image tag is pinned and overridable via an env var (e.g. `SUPABASE_DB_IMAGE`).

| Service | Image (default) | Role |
| :--- | :--- | :--- |
| `db` | `supabase/postgres` | Postgres with the Supabase roles, schemas, and extensions. Named volume `nextblock_db_store`. |
| `auth` | `supabase/gotrue` | Auth: sessions, JWTs, the `auth.users` table. |
| `rest` | `postgrest/postgrest` | Instant REST API over the `public` / `graphql_public` schemas. |
| `kong` | `kong` | Edge gateway — maps `/auth/v1`, `/rest/v1`, `/graphql/v1` to port **8000**. |
| `minio` + `minio-init` | `quay.io/minio/minio`, `quay.io/minio/mc` (Docker Hub stopped serving `minio/*` in 2025) | S3-compatible media storage + a public `nextblock` bucket. Named volume `nextblock_media`. |
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

### Ports and host interfaces (override with env vars)

Only the app is published on every interface. Everything else binds to **`127.0.0.1`**, so it
is reachable from the Docker host itself (psql, the MinIO console, `http://localhost:8000` in
your browser) and from nothing else:

| Service | Host binding (default) | Interface var | Port var |
| :--- | :--- | :--- | :--- |
| `nextblock-cms` | `0.0.0.0:3000` — **public** | — | `APP_PORT` (3000) |
| `kong` | `127.0.0.1:8000` | `KONG_BIND_HOST` | `KONG_HTTP_PORT` (8000) |
| `minio` S3 API | `127.0.0.1:9000` | `MINIO_BIND_HOST` | `MINIO_S3_PORT` (9000) |
| `minio` admin console | `127.0.0.1:9001` | `MINIO_BIND_HOST` | `MINIO_CONSOLE_PORT` (9001) |
| `db` | `127.0.0.1:54322` | `DB_BIND_HOST` | `POSTGRES_PORT_EXTERNAL` (54322) |

Containers talk to each other over the compose network (`db:5432`, `kong:8000`, `minio:9000`),
and the app container reaches Kong and MinIO through its in-container `socat` proxy, so the
loopback binding changes nothing for the stack itself.

**Exposing a port deliberately.** Set the interface variable in `.env` and restart
(`npm run docker:up`), e.g. `DB_BIND_HOST=0.0.0.0` to let another machine run psql, or
`KONG_BIND_HOST=0.0.0.0` when browsers on other machines must reach the Supabase API directly
(they then also need `NEXT_PUBLIC_SUPABASE_URL` / `API_EXTERNAL_URL` pointing at that host,
which is baked into the app image at build time). For one-off psql or MinIO-console access, an
SSH tunnel is safer and needs no change at all:
`ssh -L 54322:127.0.0.1:54322 -L 9001:127.0.0.1:9001 user@server`, then connect to
`localhost:54322` / `http://localhost:9001` on your laptop.

### Hardening on a public server

The defaults are tuned for a workstation. On a VPS or any host with a public address:

- **Put a TLS reverse proxy (Caddy, nginx, Traefik) in front of `APP_PORT`** and point
  `NEXT_PUBLIC_URL` / `SITE_URL` at the public `https://` origin. Route `/auth/v1`,
  `/rest/v1` and `/graphql/v1` from the proxy to Kong on `127.0.0.1:8000` rather than
  publishing Kong itself, and serve media the same way (or from a CDN) rather than publishing
  MinIO.
- **A firewall is required, and it must be Docker-aware.** Docker inserts published ports into
  its own `DOCKER` iptables chain, which is evaluated *before* the `INPUT` chain where `ufw`
  / `firewalld` rules live — so `ufw deny 54322` does **not** block a port published on
  `0.0.0.0`. Keep the loopback bindings above (that is what makes the ports unreachable), and
  add host rules in the `DOCKER-USER` chain or a cloud security group that allows only 80/443
  (and your SSH port) inbound.
- **Rotate the MinIO root user.** `MINIO_ROOT_USER` defaults to `nextblock`; set a non-default
  value in `.env` before the first boot (the password is already crypto-random).
- **Never publish `9001` or `54322`.** The MinIO console carries the root credentials and
  Postgres holds every table; use the SSH tunnel above when you need them.

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
| Run command | `npm run dev` (monorepo :4200, scaffold :3000) / Vercel | `npm run docker:setup` |
| Config | `.env.local` (cloud keys) | `.env` (generated local secrets) |

> The R2 client already speaks S3, so MinIO is pointed at it via `R2_S3_ENDPOINT` /
> `R2_FORCE_PATH_STYLE`; uploads are signed for the browser via `R2_S3_PUBLIC_ENDPOINT`.
> A reference of every key the stack reads lives in `.env.docker.example`.

## Troubleshooting

- **"Docker is not installed or not running."** Start Docker Desktop and re-run
  `npm run docker:setup`.

- **`port is already allocated`.** Another process (often a previous stack) holds 8000 /
  9000 / 3000 / 54322. Stop it, or override the port env vars above.

- **Can't reach Postgres / MinIO / Kong from another machine.** By design: those ports bind to
  `127.0.0.1` (see "Ports and host interfaces"). Use an SSH tunnel, or set the matching
  `*_BIND_HOST=0.0.0.0` in `.env` and `npm run docker:up` — behind a firewall.

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
