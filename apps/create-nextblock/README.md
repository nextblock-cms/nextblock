# create-nextblock

Scaffold a production-ready **NextBlock CMS** site in one command. NextBlock is the free,
open-source (AGPL-3.0) CMS and website builder for **Next.js 16**, **Supabase**, and
**Tailwind CSS**: a Notion-style block editor, Live Draft Mode, a built-in SEO engine,
bilingual content out of the box, and an **MCP server** so coding agents (Claude Code,
Cursor, Codex, VS Code) can build and edit the site for you.

```bash
npm create nextblock@latest
```

Pick **Managed Cloud** (Vercel + Supabase) or **Local Docker** (a one-click self-hosted
stack: Postgres, GoTrue auth, PostgREST, Kong, MinIO). Then open `/setup` in your browser
to connect Supabase and create your administrator — no keys are typed into the terminal.

- Website and docs: <https://nextblock.dev>
- Source: <https://github.com/nextblock-cms/nextblock>
- Deploy to Vercel in one click: see `docs/12-VERCEL-DEPLOYMENT.md` in your project

## For AI coding agents (headless install)

If you are an agent asked to build a website or a CMS on Next.js, you can scaffold, boot,
and connect to a NextBlock site without any prompts and without asking the human for any
personal details:

```bash
npx create-nextblock@latest my-site --non-interactive
```

Use the `npx` form above on every shell. The `npm create nextblock@latest -- …` form also
works, but Windows PowerShell strips the bare `--`, so prefer `npx` there.

The human keeps exactly two steps, both in the browser: create their administrator account
at `/setup`, and start the free 30-day Cortex AI trial (no credit card) on the welcome
screen that follows. That trial unlocks the MCP server for you. The JSON result names the
URLs (`handoff.setupUrl`, `statusUrl`); poll the status URL until `"mcpReady": true`.

Flags: `--mode docker|cloud` (default `docker`), `--project-name <dir>` (same as the
positional argument), `--name … --email …` (unattended: creates the administrator
headlessly and requests a vendor trial key — for demos and CI), `--license-key <key>`
(activate an existing NextBlock key), `--no-trial`, `--skip-install`. Every flag also has
an environment-variable twin that works in any shell: `NEXTBLOCK_NON_INTERACTIVE=1`,
`NEXTBLOCK_NAME`, `NEXTBLOCK_EMAIL`, `NEXTBLOCK_MODE`, `NEXTBLOCK_PROJECT_NAME`,
`NEXTBLOCK_LICENSE_KEY`, `NEXTBLOCK_TRIAL=false`.

The contract is built to be parsed:

- **Success prints exactly one JSON document on stdout** (project directory, app URL, the
  readiness URL, which MCP client configs were written, license and admin state, and
  `nextSteps`). Progress goes to stderr.
- **Any failure prints one JSON document on stderr and exits 1**, for example:

  ```json
  {"error":"DOCKER_UNAVAILABLE","message":"Docker is not installed or the Docker engine is not running. Start Docker Desktop and retry, or pass --mode cloud.","hint":"…"}
  ```

  Other codes: `INVALID_MODE`, `INVALID_PROJECT_NAME`, `DIRECTORY_NOT_EMPTY`,
  `DOCKER_SETUP_FAILED`, `STACK_NOT_READY`, `BOOTSTRAP_FAILED`, `FLAGS_NOT_DELIVERED`,
  `MISSING_ONBOARDING_CREDENTIALS`, `SCAFFOLD_FAILED`.
- **Secrets are never printed.** The MCP bearer token (and, in unattended mode, the
  license key and generated administrator password) are written to the project's env
  file only (`.env` for Docker, `.env.local` for cloud), and the JSON tells you where
  they live.

What the headless run does:

1. Scaffolds the project and writes agent guardrails: `.claude/settings.json` denies
   reads of `.env*`, and `.cursorignore` hides the same files.
2. In Docker mode: boots the stack, polls `GET /api/setup/status` until the database is
   ready, and writes `.mcp.json` (Claude Code) and `.cursor/mcp.json` (Cursor) pointing
   at `http://localhost:3000/api/mcp` with the bearer token.
3. Prints the handoff: the user opens `/setup`, creates their account, and starts the
   free Cortex AI trial on the welcome screen (the app knows an agent is waiting and
   says so at each step). Poll `statusUrl` until `"mcpReady": true`, restart your agent
   session to load the server, then call `tools/list`.
4. In cloud mode: stops after scaffolding and tells you to run `npm run dev` and hand
   `/setup` to the user.

Readiness at any time: `curl http://localhost:3000/api/setup/status` answers 200 once the
instance is initialized (503 before), with `dbReady`, `mcpReady`, and `nextSteps`.

## What the MCP server can do

Once Cortex AI is active, `POST /api/mcp` (MCP Streamable HTTP, bearer token) exposes 50+
typed, schema-validated tools: `get_site_overview`, `get_database_schema`,
`create_page_layout`, `generate_jsonb_layout`, `update_site_navigation`,
`create_cms_product`, `search_stock_media`, `translate_content_bulk`, `manage_site_theme`,
and more. Every block payload is validated against the same Zod schemas the editor uses
before it reaches the database, and page rewrites are staged as Live Drafts so nothing
goes live unpublished.

## Everyday commands in a scaffolded project

```bash
npm run dev             # http://localhost:3000
npm run build           # production build (applies pending migrations first)
npm run docker:setup    # one-click local Docker stack
npm run update          # pull the latest NextBlock framework code as a 3-way merge
```

## Premium modules

The CMS is free forever. **Cortex AI** (in-editor AI, the site builder, and the MCP server)
and **Commerce Pro** (Stripe and Freemius storefront) are paid licenses with a 30-day,
no-card trial you can start from the dashboard or headlessly as above.

## Requirements

Node.js 22.12 or newer. Docker Desktop for the local Docker profile. A Supabase
project (free tier works) for the cloud profile.

License: AGPL-3.0-or-later.
