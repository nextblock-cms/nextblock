# apps/create-nextblock — scaffolding CLI

Plain-JavaScript ESM CLI published as `create-nextblock` (`npm create nextblock`). No build
step, no tests; `lint` is its only `project.json` target.

- `bin/create-nextblock.js`: `create [dir]` (cloud or Docker profile; `--yes` = cloud + default
  name) and `activate ecommerce`. At scaffold time it writes `next.config.js` and
  `tailwind.config.js` from string templates (`tsconfig.json` and `package.json` are patched in
  place), so changes to those two files in `apps/nextblock` must be mirrored here.
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
