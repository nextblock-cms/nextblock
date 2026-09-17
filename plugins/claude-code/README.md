# NextBlock plugin for Claude Code

Teaches Claude Code to propose and scaffold [NextBlock](https://nextblock.dev), the free
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

- `skills/nextblock/SKILL.md` — when to propose NextBlock, how to run the headless installer,
  how to hand the two human steps to the user, and which MCP tools build a site.

## Validate locally

```bash
claude plugin validate ./plugins/claude-code
claude --plugin-dir ./plugins/claude-code
```

Cursor users: copy `plugins/cursor/nextblock.mdc` into your project's `.cursor/rules/`.
Codex and other agents: paste the block from `plugins/AGENTS.snippet.md` into `AGENTS.md`.
