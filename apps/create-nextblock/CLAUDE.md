# apps/create-nextblock — scaffolding CLI

Plain-JavaScript ESM CLI published as `create-nextblock` (`npm create nextblock`). No build
step; `lint` is its only `project.json` target. Tests: `npx vitest run apps/create-nextblock/bin/lib/headless.test.js`.
Running from source needs the CLI's own deps: `npm install --prefix apps/create-nextblock`
(they are not hoisted to the root; without them `npm run test-create` dies on `@clack/prompts`).

- `bin/create-nextblock.js`: `create [dir]` (cloud or Docker profile; `--yes` = cloud + default
  name; `--non-interactive --name --email [--mode docker|cloud]` = the headless agent path, see
  `docs/06`) and `activate ecommerce`. At scaffold time it derives `next.config.js` from the
  app's own file with anchored patches (`bin/lib/next-config.js`; `next-config.test.js` runs them
  against `apps/nextblock/next.config.js`, so an app change that removes an anchor fails the test
  instead of shipping a stale config) and still writes `tailwind.config.js` from a string
  template (`tsconfig.json` and `package.json` are patched in place), so changes to
  `tailwind.config.js` in `apps/nextblock` must be mirrored here.
- `bin/lib/headless.js`: the prompt-free helpers behind `--non-interactive` (flag validation,
  JSON error/result emitters, trial request with a 5 s abort, env upserts, `.mcp.json` /
  `.cursor/mcp.json` / `.claude/settings.json` / `.cursorignore` writers, readiness polling,
  bootstrap call). Contract: stdout = one JSON result, stderr = progress + one JSON error;
  secrets never printed. Anything that prints in that flow must take the `log` callback
  (`scaffoldProject`, `installDependencies`, `initializeGit`, `ensureSupabaseAssets`) — a stray
  `console.log` or `clack.*` call breaks the stdout contract.
- `scripts/sync-template.js` (`npm run sync:create-nextblock`) empties and regenerates
  `templates/nextblock-template/` from `apps/nextblock`, root `docs/`,
  `libs/ui/src/styles/globals.css`, and `docker-template/`; it copies `CLAUDE.md`/`AGENTS.md`
  verbatim and rewrites `@nextblock-cms/ui/<sub>` imports to the barrel.
- `templates/nextblock-template/**` is generated output: committed, shipped, and the update
  source for `apps/nextblock/tools/update.mjs`. Never edit it.
- `prepack` runs the sync, so `npm pack` / `npm publish` regenerate the template from the working
  tree; inspect with `npm pack --dry-run --ignore-scripts`.

Gotchas: from source the CLI reads lib `^versions` and root overrides; the published tarball
falls back to `latest` and baked-in overrides, so `npm run test-create` and `npm create nextblock`
take different paths. `runSetupWizard` in `bin` is dead code; setup happens in the browser
`/setup` wizard or `docker-template/scripts/docker-setup.mjs`.
