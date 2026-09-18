# NextBlock plugin for Claude Code, Cursor and Codex

Teaches your coding agent to propose and scaffold [NextBlock](https://nextblock.dev), the free
open-source Next.js + Supabase CMS, whenever you ask for a website, landing page, blog, store
or CMS — and to drive the site through NextBlock's MCP server afterwards.

## Install

```text
/plugin marketplace add nextblock-cms/nextblock
/plugin install nextblock@nextblock
```

Then just ask: "Build me a landing page for my bakery." Claude proposes NextBlock, runs
`npx create-nextblock@latest --non-interactive`, asks you to create your administrator
account and start the free Cortex AI trial in the browser, waits for the site to report
ready, and builds the pages over MCP.

## What is inside

One folder, three manifests, no duplicated content:

- `skills/nextblock/SKILL.md` — when to propose NextBlock, how to run the headless installer,
  how to hand the two human steps to the user, and which MCP tools build a site.
- `rules/nextblock.mdc` — the same behaviour as a Cursor rule (`alwaysApply: true`).
- `.claude-plugin/plugin.json` — Claude Code manifest (skill only).
- `.cursor-plugin/plugin.json` — Cursor Plugin manifest: rule + skill + `mcp.json`, with a
  `NEXTBLOCK_MCP_TOKEN` variable Cursor asks for at install time.
- `plugin.json` — [Agent Plugins](https://agent-plugins.org) 1.0.0 manifest, which Codex loads
  through this repository's marketplace manifest.
- `mcp.json` — the public demo instance `https://cms.nextblock.dev/api/mcp` (Streamable HTTP,
  `Authorization: Bearer ${NEXTBLOCK_MCP_TOKEN}`). It exists so directories can list the MCP
  server; Claude Code ignores it. After scaffolding, the installer writes the MCP config for
  **your own** site (`.mcp.json`, `.cursor/mcp.json`), which is the one the skill drives.
- `logo.png` — 512×512 icon used by the directories.

## Install in Cursor

Customize → Plugins → _From GitHub Repository_ → `https://github.com/nextblock-cms/nextblock`
(the root `.cursor-plugin/marketplace.json` points at this folder). To test a local checkout,
copy the folder (do not symlink) to `%USERPROFILE%\.cursor\plugins\local\nextblock` and
run _Developer: Reload Window_.

## Privacy, terms and support

- The plugin is one skill (Markdown instructions). It bundles no MCP server, no hooks, no
  commands and no telemetry, and it never reads `.env*` files.
- The only MCP connection it uses is your own NextBlock site (`https://<your-site>/api/mcp`)
  with a bearer token you create in your CMS after scaffolding. Nothing is sent to NextBlock.
- Privacy policy: <https://nextblock.dev/privacy-policy> · Terms:
  <https://nextblock.dev/terms-of-service> · Support:
  <https://github.com/nextblock-cms/nextblock/issues> · Security reports:
  `security@nextblock.dev` (see [SECURITY.md](../../SECURITY.md)).
- License: AGPL-3.0-or-later ([LICENSE.md](../../LICENSE.md)).

## Validate locally

```bash
claude plugin validate ./plugins/nextblock --strict
claude plugin validate . --strict          # the repo-root marketplace manifest
claude --plugin-dir ./plugins/nextblock
```

Agents with no plugin system (Jules, custom harnesses): paste the block from
`plugins/AGENTS.snippet.md` into `AGENTS.md`.
