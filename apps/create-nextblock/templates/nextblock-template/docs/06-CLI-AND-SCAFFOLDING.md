# 06 CLI and Scaffolding

## Purpose

`apps/create-nextblock` is the onboarding surface for developers who want a
standalone NextBlock project without cloning the full monorepo.

The CLI scaffolds a package-based project from the current app template (interactively,
or headless for coding agents). It never installs premium packages: their code ships in
every scaffold and a license switches it on in the running site (see "Premium Packages").

## Source Application vs Template Output

The canonical application is still `apps/nextblock`.

The scaffold template under
`apps/create-nextblock/templates/nextblock-template` is copied output, not the
authoritative source. The sync pipeline refreshes that template by copying the
source app and applying a series of post-copy adjustments.

That means contributor workflow should be:

1. change the source app or shared libraries
2. update root docs and README entrypoints
3. run the template sync when you want the generated project to catch up

## CLI Entry Points

`apps/create-nextblock/bin/create-nextblock.js` defines one command,
`create [project-directory]` (the default), plus a hidden `activate [package]` that only
prints how to activate a premium package (see "Premium Packages").

The default create flow is what powers:

```bash
npm create nextblock@latest
```

## Headless mode (`--non-interactive`) for coding agents

A terminal agent (Claude Code, Cursor, Codex) can take one prompt — "build me a landing
page with NextBlock about X" — and scaffold, boot, and wire up the site, leaving the human
exactly two browser steps: create their administrator account and start the free Cortex AI
trial (a real Freemius trial, with its reminder emails). No personal details pass through
the agent:

```bash
npx create-nextblock@latest my-site --non-interactive
#                                     --mode docker|cloud   (default: docker)
#                                     --project-name <dir>  (same as the positional)
#                                     --name … --email …    (unattended: headless admin + vendor trial key)
#                                     --license-key <key>   (activate this key instead)
#                                     --no-trial            (unattended only: no license at all)
#                                     --skip-install
```

**Attended (default).** Without `--name`/`--email` the CLI scaffolds, boots (Docker), writes
the MCP client configs, and prints a `handoff` with the setup URL. The agent asks the user
to open `/setup`, create their account, and start the trial on the welcome screen that
follows, while polling `GET /api/setup/status` until `mcpReady`. The app knows it was
installed for an agent (the `MCP_BEARER_TOKEN` in its env): the wizard's admin step says a
coding agent is waiting, the welcome screen explains that the trial unlocks the agent's
MCP access, and once Cortex AI is active `/cms/welcome` tells the user to return to their
terminal instead of pushing the optional in-dashboard AI setup. The status route's
`nextSteps` carry the same guidance with absolute links (`handoff.setupUrl`,
`handoff.welcomeUrl`).

**Unattended.** With both `--name` and `--email` the CLI also creates the administrator
through `POST /api/setup/bootstrap` (Docker) and requests a trial key from the vendor. That
key is a plain 30-day expiring license, not a Freemius trial, so Freemius sends no trial
emails for it; use this only for demos and CI. Passing one of the two flags, or an invalid
email, exits 1 with `MISSING_ONBOARDING_CREDENTIALS`.

Always document the `npx` form. `npm create nextblock@latest -- my-site --non-interactive …`
is equivalent on bash/zsh/cmd, but **Windows PowerShell strips the bare `--`**, after which
npm treats `--non-interactive` as one of its own config flags ("Unknown cli config") and the
CLI silently starts the *interactive* prompts. `npx <package> <flags>` needs no `--`, so it
behaves the same on every shell (verified on PowerShell 5.1 with npm 11).

Two safety nets exist for that case. Every flag has an environment-variable twin that
survives any shell and any npm wrapper — `NEXTBLOCK_NON_INTERACTIVE=1`, `NEXTBLOCK_NAME`,
`NEXTBLOCK_EMAIL`, `NEXTBLOCK_MODE`, `NEXTBLOCK_PROJECT_NAME`, `NEXTBLOCK_LICENSE_KEY`,
`NEXTBLOCK_TRIAL=false` (flags win, variables fill the gaps, and the interactive flow
ignores them). And when npm has eaten the flag it still forwards it as
`npm_config_non_interactive=true`; the CLI detects that and exits 1 with a
`FLAGS_NOT_DELIVERED` JSON error naming the `npx` form, instead of dropping an agent into
prompts it cannot answer.

The contract is designed to be parsed, not read:

- **stdout carries exactly one JSON document** on success (project dir, app URL, the
  status URL, which agent config files were written, license and admin state, and
  `nextSteps`). Every progress line goes to **stderr**.
- **Any failure prints one JSON document on stderr and exits 1**, for example:

  ```json
  {"error":"DOCKER_UNAVAILABLE","message":"Docker is not installed or the Docker engine is not running. Start Docker Desktop and retry, or pass --mode cloud.","hint":"…"}
  ```

  Other codes: `MISSING_ONBOARDING_CREDENTIALS` (half a credential pair), `INVALID_MODE`, `INVALID_PROJECT_NAME`, `DIRECTORY_NOT_EMPTY`,
  `DOCKER_UNAVAILABLE` (engine not running — start Docker Desktop or pass `--mode cloud`),
  `DOCKER_SETUP_FAILED`, `STACK_NOT_READY`, `BOOTSTRAP_FAILED`, `SCAFFOLD_FAILED`. Every
  payload has `error`, `message`, and usually a `hint`.
- **Secrets are never printed.** The MCP bearer token (`crypto.randomBytes(32)` as hex),
  the license key, and the generated admin password are written to the project's env
  file only; the JSON names *where* they live (`.env (MCP_BEARER_TOKEN)`).

What happens, in order (`handleHeadlessCommand` in `bin/create-nextblock.js`, helpers in
`bin/lib/headless.js`):

1. Validate the flags (a known mode, a directory-safe project name; in unattended mode a
   name and a WHATWG-valid email). In Docker mode, preflight `docker info` before creating
   anything.
2. Scaffold exactly as the interactive flow does (`scaffoldProject`), including the agent
   guardrails every scaffold now gets: `.claude/settings.json` with
   `permissions.deny: ["Read(./.env)", "Read(./.env.*)"]` and a `.cursorignore` for the
   same files, so an agent cannot pull database or bearer credentials into its context.
   (`.claudeignore` is not a mechanism Claude Code has; the permission deny rule is.)
3. Unattended only: ask the NextBlock license service for a Cortex AI trial key —
   `POST ${NEXTBLOCK_LICENSE_SERVICE_URL:-https://nextblock.dev}/api/packages/provision-trial`
   with the name and email, 5-second abort. A refusal (trial already used for that
   email), a 404 (service not deployed), or a timeout is **reported, not fatal**: the
   site still scaffolds and boots, and the summary says the trial must be started from
   `/cms/settings/packages`. `--license-key` skips the request; `--no-trial` skips it and
   writes no key. Attended installs never call it: the browser trial is the real one.
4. Write `MCP_BEARER_TOKEN` (and, unattended, `NEXTBLOCK_LICENSE_KEY` +
   `NEXTBLOCK_LICENSE_KIND=trial`) to the env file. Docker: they travel through the
   process environment into `scripts/docker-setup.mjs`, which persists them into the
   `.env` compose reads (and `docker-compose.yml` passes them to the app container).
   Cloud: `.env.local`.
5. Docker only: boot the stack, read the app URL back from `.env` (docker-setup may
   remap port 3000), and poll `GET /api/setup/status` until `dbReady`. Attended: stop
   here and print the handoff. Unattended: `POST /api/setup/bootstrap` with the bearer
   token to create the first administrator (`--name` / `--email`, generated password
   stored as `NEXTBLOCK_ADMIN_PASSWORD` in `.env`) and activate the env license. Cloud
   mode stops after step 4 and tells the agent to run `npm run dev` and hand `/setup`
   to the user.
6. Write the MCP client configs with the literal token: `.mcp.json` (Claude Code —
   `"type": "http"` is mandatory) and `.cursor/mcp.json` (Cursor). Both are gitignored by
   the scaffold. The token is written literally because both clients expand `${VAR}`
   from the shell environment only, never from a project `.env`. Agents must restart
   their session to load the new server.

The app side of this contract lives in `apps/nextblock`: `app/api/setup/status`,
`app/api/setup/bootstrap`, `lib/packages/env-license.ts`, and the `MCP_BEARER_TOKEN`
auth path in `app/api/mcp/route.ts` — see `docs/08` → "Headless bootstrap". The vendor
side is `app/api/packages/provision-trial` (enabled only on nextblock.dev).

`bin/lib/headless.test.js` covers the validation, env editing, client config shapes,
trial request handling, readiness polling and bootstrap call
(`npx vitest run apps/create-nextblock/bin/lib/headless.test.js`).

## What the Create Flow Actually Does

When the CLI creates a project it currently:

1. prompts for a project name unless `--yes` is used
2. copies `templates/nextblock-template` into the new directory
3. removes backup artifacts
4. applies client component and provider adjustments
5. normalizes block-editor and UI imports
6. generates UI proxy modules
7. copies editor utility shims when needed
8. ensures `.gitignore`, `.env.example`, layout files, and config files are in
   the expected generated-project shape (`next.config.js` is the app's own file with
   anchored standalone patches applied by `bin/lib/next-config.js` — tracing root,
   the seven published packages to transpile, no build-time type-check of pre-built
   deps; a required anchor that disappears throws at scaffold time and fails
   `next-config.test.js`, which runs the patches against `apps/nextblock/next.config.js`)
   and `eslint.config.mjs` is replaced by the standalone config in
   `bin/lib/eslint-config.js`. The app's own config only loads inside the monorepo (it
   imports `@nx/eslint-plugin` and a `../../` root config), so before this every scaffold's
   `npm run lint` was dead. The standalone one is built on `eslint-config-next` and reports
   every rule the monorepo does not enforce as a warning, chiefly the React Compiler checks
   in `eslint-plugin-react-hooks` 7 (`rules-of-hooks` stays an error on both sides), so a
   fresh project lints green whenever `nx lint nextblock` does. `eslint-config.test.js` is
   the drift guard: it lints the real `apps/nextblock` code with exactly that config and
   fails on any error (about 2 minutes cold, under 20 s warm via an ESLint cache in the OS
   temp dir). The app's `lint` script is `eslint .`; Next 16 removed `next lint`.
   `sync-template.js` also writes the same standalone config into the template, because
   `npm run update` copies and 3-way-merges framework files from the template. Otherwise every
   update would put the unloadable monorepo config back. `tsconfig.json` no longer gets
   `baseUrl` (TypeScript 6 deprecates it, error TS5101); the `paths` entries are `./`-relative
   and need none. For projects scaffolded earlier, `npm run update` adds
   `"ignoreDeprecations": "6.0"` when their tsconfig still sets `baseUrl`, and keeps `baseUrl`,
   since their own code may import paths rooted at it.
9. rewrites `package.json` away from workspace dependencies and toward published
   packages
10. writes a project-level `.npmrc` for public package resolution
11. writes the coding-agent guardrails (`.claude/settings.json` deny rules for `.env*`,
    `.cursorignore`)
12. initializes git
13. optionally installs dependencies
14. Docker profile: runs `scripts/docker-setup.mjs`; otherwise points at the browser
    `/setup` wizard (headless mode continues with readiness polling, bootstrap and the
    MCP client configs — see above)

## Package Version Sources

The CLI resolves published package versions from the local monorepo package
metadata for:

- `@nextblock-cms/ui`
- `@nextblock-cms/utils`
- `@nextblock-cms/db`
- `@nextblock-cms/editor`
- `@nextblock-cms/sdk`
- `@nextblock-cms/cortex`

The ecommerce module's npm name differs from its import name, so
`apps/nextblock/package.json` (and therefore every scaffold) declares the alias
`"@nextblock-cms/ecommerce": "npm:@nextblock-cms/ecom@latest"`.

## Template Sync Workflow

`apps/create-nextblock/scripts/sync-template.js` is the authoritative source for
template generation inside the monorepo.

It currently:

- copies `apps/nextblock` into `templates/nextblock-template`
- skips `node_modules`, `.next`, backups, and other generated folders
- copies the root `docs/` folder into the template docs directory
- copies `.env.example` (the legacy `.env.exemple` spelling is still accepted as a fallback)
- rewrites imports for packaged library consumption
- removes the copied `project.json`
- syncs package versions
- normalizes global styles and UI proxy files

This is why the root docs and root/app README surfaces matter first: the
template inherits from them later through the sync step.

## Premium Packages

NextBlock CMS is free and open source (AGPL-3.0). Premium packages add to it, today
**Cortex AI** and **Commerce Pro**, with more to come. There is nothing to install: every
scaffold already depends on `@nextblock-cms/ecommerce` and `@nextblock-cms/cortex`, and
the premium routes and UI ship in the template, gated by `verifyPackageOnline()` (the
commerce CMS pages redirect to `/cms/settings/packages` while Commerce Pro is inactive). A
license switches that code on at runtime:

- **In the CMS.** Administration → Packages (`/cms/settings/packages`): start the free
  30-day trial of Cortex AI or Commerce Pro (no credit card), buy a license, or paste a
  key. See docs/08 → "Package Activation".
- **Headless.** Set `NEXTBLOCK_LICENSE_KEY` in the env file. `--non-interactive` writes it
  for you: the key given with `--license-key`, or, in unattended mode (`--name` /
  `--email`), the Cortex AI trial key the vendor mints. The app activates it on the next
  `GET /api/setup/status`, `POST /api/setup/bootstrap` or `/api/mcp` request
  (`lib/packages/env-license.ts`), never on a page view. The variable holds one key and
  defaults to Cortex AI; a Commerce Pro key also needs `NEXTBLOCK_LICENSE_PACKAGE=ecommerce`.
  Details: docs/08 → "Headless bootstrap" (Environment-seeded license).

`create-nextblock activate [package]` is a hidden signpost that prints these steps
(`bin/lib/activate.js`). It installs nothing, writes no file, and exits 1 only for an
unknown package name; it stays registered because commander would otherwise hand
`activate` to the default `create` command and scaffold a project named "activate". It
also names premium dependencies an older project's `package.json` lacks (update the
project instead of installing them one by one, docs/13) and any files an older `activate`
overwrote.

Up to create-nextblock 0.21.1 the command ran
`npm install @nextblock-cms/ecommerce@npm:@nextblock-cms/ecom@latest` (already a
dependency) and overwrote ten routes (`/cms/orders`, `/cms/orders/[id]`, `/cms/products`,
`/cms/products/new`, `/cms/products/[id]/edit`, `/cms/payments`, `/cms/coupons`,
`/cms/coupons/[id]/edit`, `/checkout/success`, `/api/checkout`) with wrappers that
imported page components from the package root, which only
`@nextblock-cms/ecommerce/server` exports, so the project stopped building. Restore such
files from git history or from a fresh scaffold of the same version.

## Publishing and Release Notes

A generated project installs the libraries from **npm**, so a feature only reaches
scaffolds after the libs are republished. (The monorepo's own Vercel deploy builds the
libs from source, so it sees changes immediately — only `npm create` scaffolds need a
republish.)

### Release commands

- `npm run release:all -- <version>` — build **and publish every package** at one
  synchronized version, in dependency order: `utils → ui → sdk → db → editor → ecom`,
  then `release-cli.js` (which stamps the root + template + `create-nextblock`, re-syncs
  the template, and publishes the CLI). Pass an explicit semver (e.g. `0.10.2`);
  `--dry-run` prints the plan only.
- `npm run build:<lib>` (`build:utils|ui|db|editor|sdk|ecom`) and
  `node tools/scripts/release-lib.js <lib> <version>` — build + publish a **single** lib
  (`<lib>` is the nx project name, so use `ecommerce`, which maps to the published
  `@nextblock-cms/ecom`). `npx nx build <lib>` only *compiles*, it does not publish.

### npm 2FA / OTP (and capturing a log)

Publishing requires a one-time password if the npm account has 2FA. **Piping the command
output breaks the interactive OTP prompt** — `npm run release:all -- … 2>&1 | Tee-Object …`
(or `| tee`) fails with `npm error code EOTP` because npm no longer has a TTY. Either:

- set an npm **Automation** token (`npm config set //registry.npmjs.org/:_authToken …`),
  which bypasses 2FA — then piping to a log file is fine; or
- capture with PowerShell `Start-Transcript -Path release.log; npm run release:all -- … ;
  Stop-Transcript`, which records the session while npm keeps its terminal.

`release:all` has no "already published" guard: if it dies partway, re-running the same
version re-publishes from the top and 403s on the first already-published lib. Finish a
partial release by running the **remaining** libs individually
(`node tools/scripts/release-lib.js <lib> <version>` … then `release-cli.js <version>`),
or bump to a fresh version and re-run the whole thing.

### The pre-publish check

`release-lib.js` builds with `NODE_ENV=production`, finalizes the premium libraries'
manifests, and then runs `tools/scripts/verify-lib-dist.js <lib>` before `npm publish`. A
failed check aborts the release and restores the version. The check must come AFTER the
manifest step: `ecommerce` builds with the raw source `package.json`, which has no `exports`
at all, so checking first rejected every subpath (that is what stopped the first 0.19.1
attempt). The two `exports` maps live in `tools/scripts/lib-publish-exports.js`, shared by
the release script and the check, so the check also works on a plain `nx build` output. Run
it by hand after any `nx build <lib>`:

```bash
node tools/scripts/verify-lib-dist.js ecommerce
```

It exists because a broken package is invisible inside the monorepo, where
`@nextblock-cms/*` resolves through tsconfig paths to TypeScript source. Only a scaffold,
which installs from npm, runs the compiled output. Each check is a failure that shipped
in 0.19.0 and broke `next build` in every generated project:

| Check | What went wrong |
| :-- | :-- |
| Development build | Without `NODE_ENV=production` a release build can run in development mode: `@nx/vite/plugin` resolves every Vite config in development mode while Nx computes the project graph, Vite then sets `NODE_ENV=development` in that process, and with plugin isolation off (as in `release-lib.js`) the build task inherits it. plugin-react then emits `jsxDEV(..., this)` with the builder's absolute paths, and `this` is illegal in a file with inline server actions ("Server Actions cannot use `this`"). |
| Consumed subpaths | With `preserveModules`, only modules reachable from a build entry are emitted. A module imported **only** through its subpath (`@nextblock-cms/utils/script-safety`) shipped a `.d.ts` and no JavaScript. Give it its own `build.lib.entry`. |
| Lost exports | `libs/db` and `libs/utils` track stale compiled twins (`foo.js` beside `foo.ts`). Vite resolves `.js` before `.ts` by default, so the package was assembled from months-old code. Both configs now set `resolve.extensions` with TypeScript first, and so does the root `vitest.config.ts`: until 0.21 the tests ran the twins too. |

A fourth check covers the declaration files, which fail silently in two ways (both shipped
through 0.19.2, and neither breaks a scaffold build because scaffolds compile with
`skipLibCheck`; the types just become `any`):

| Check | What went wrong |
| :-- | :-- |
| Missing declarations | vite-plugin-dts only LOGS TypeScript's declaration-emit errors and the build still exits 0. cortex logged `TS4058 ... 'NavigationNode' ... cannot be named` and wrote **no** `ai-global-agent-tools.d.ts`, while `index.d.ts` still re-exported it. Rule: a recursive type that appears in an exported function's inferred return type must itself be exported. |
| Sibling imports | By default the plugin rewrites tsconfig path aliases to relative paths, so a type imported from a sibling library was emitted as `../../../db/src/index.ts`, a path that exists only in this monorepo (58 such imports in `ecom`). Every lib config now sets `aliasesExclude: [new RegExp('^@nextblock-cms/')]`, and the check resolves each `@nextblock-cms/*` specifier found in a `.d.ts` through the sibling's own `exports` to a declaration file (that is why `db` now exports a types-only `./types`). |

A fifth check (added with the Vite 8 upgrade) reads what `npm publish` would really ship. It
runs `npm pack --dry-run --json` in the dist folder, parses every shipped `.js`/`.mjs`/`.cjs`/
`.d.ts` file with TypeScript (a regex flagged `import("./html_renderer")` inside a highlight.js
comment in the editor bundle), and fails when a relative import or an `exports` target is not
in the tarball. With no argument, `verify-lib-dist.js` now checks every built lib.

| Check | What went wrong |
| :-- | :-- |
| Tarball contents | Rolldown renamed `ui`'s lazy chunks from `index-[hash]` to `dist-*`, `es-*` and `rolldown-runtime-*`, and `index.mjs` imports the runtime chunk directly. The `files` whitelist still globbed `index-*.mjs`, so every consumer of `@nextblock-cms/ui` would have failed to import it, and every earlier check passed. It also catches a lib whose declarations silently disappear (next section). |

Check 6, Rolldown's `require()` shim, is described with the Vite 8 rules below. A seventh
check covers the CommonJS side of each package. Nothing in the monorepo or in a scaffold's
Next.js build loads it, so all three of these shipped through 0.20:

| Check | What went wrong |
| :-- | :-- |
| Module formats | `cortex` and `ecom` are `"type": "module"` and published their `require` entries as `index.cjs.js`, which Node parses as ESM ("exports is not defined in ES module scope"). `ui` and `editor` put `'use client'` back on `index.mjs` only, so their CommonJS `index.js` was a Server Component. `ui`'s `main`/`module` named `index.cjs.js`/`index.es.js`, files the build never wrote. The check requires `.cjs` for every CommonJS file and `require` target in a `"type": "module"` package, the same `'use client'`/`'use server'` directive at the top of both files of every export, and existing `main`/`module`/`types` files. |

An eighth check covers the npm package page, which nothing else looks at:

| Check | What went wrong |
| :-- | :-- |
| Package page | Through 0.20 only `sdk` published a README. The first fix published Nx's generated "This library was generated with Nx" stubs, `editor` and `sdk` linked to `../../docs/…` (a 404 on npmjs.com), the five manifests the builds write had no `license`, and `cortex` and `ecom` pointed `repository` at `nextblock-cms/packages`, which does not exist. The check requires a README in the tarball that is not the Nx stub and uses only absolute links, plus `license` and `repository` in the manifest. Every lib now has a real README, and every manifest points at `nextblock-cms/nextblock` with its `directory`. |

### How the libraries build

`npx nx build <lib>` runs the `vite build` target that `@nx/vite/plugin` infers from the lib's
Vite config, after the lib's `typecheck` target (`tsc --noEmit -p tsconfig.lib.json`, which the
old `@nx/vite:build` executor also ran first). Each `project.json` only sets
`"build": { "dependsOn": ["typecheck"] }`. That replaces the plugin's default `^build`: a lib
externalizes its siblings and reads their types from source, so it never needs them built.
`db`'s `build` is still `vite-build` (plain `vite build`) plus the step that copies
`src/supabase` into the dist. What the configs must now do themselves:

- Set `build.outDir: '../../dist/libs/<lib>'`, relative and with `/`. The plugin derives the
  target's cache outputs from it, and an absolute path came out with Windows backslashes.
  Set `emptyOutDir: true` too: Vite will not empty a folder outside the lib otherwise, and old
  chunks would stay in the tarball.
- Copy files the build does not write with `copyIntoDist()` from
  `tools/vite/lib-build-plugins.mjs`: `README.md`, and the raw `package.json` for `cortex` and
  `ecommerce`, which `release-lib.js` finalizes. `sdk` and `db` copy their README in
  `afterBuild` instead: their configs are `.ts`, which the root lint config checks with
  `@nx/enforce-module-boundaries`, and `tools/` belongs to the root project. The executor's
  `assets` option was not in its schema and never copied anything, so only `sdk` (through
  `nxCopyAssetsPlugin`) shipped a README before.
- A lib whose `afterBuild` writes its own manifest (`utils`, `ui`, `sdk`, `db`, `editor`)
  copies `license` and `repository` from its `package.json` into it. The README is the npm
  page, so link to docs with absolute GitHub URLs; check 8 rejects relative links.
- A lib that bundles into one chunk (`ui`, `editor`) adds `'use client'` with
  `clientDirectiveOnEntries()`. Rolldown drops module directives when it merges modules, and
  vite-plugin-dts's `afterBuild` runs after the ESM output is written but before the CommonJS
  one, so a file patch there never reaches the CommonJS entry. `preserveModules` libs keep
  their directives.
- A `"type": "module"` lib (`cortex`, `ecommerce`) names its CommonJS files `.cjs` through
  `build.lib.fileName`. The other libs have no `type` field, so their `.cjs.js` files are
  CommonJS already.
- Do not write build output from `afterBuild` that the CommonJS pass also writes. Through 0.20
  `utils` overwrote `server.es.js` and `server.d.ts` with a hand-written copy there, while the
  CommonJS pass shipped the compiled source. The copy had drifted (its `hasEnvVars()` ignored
  the Vercel integration's key aliases). Both formats are compiled from `src/server.ts` now.
- Keep `libs/utils/src/lib/server-utils.ts` free of `"use server"`. The directive would turn
  every export into a Server Action as soon as a client component imports one, and
  `getEmailServerConfig()` returns the SMTP password. The module throws when loaded in a
  browser instead, and a test checks both.

Nothing imports `nxViteTsPaths` or `nxCopyAssetsPlugin` any more: Nx 24 removes both, and
`sdk` was the only user.

### Library build gotchas (dts / tsconfig)

Each lib emits its `.d.ts` via `vite-plugin-dts` running tsc on `tsconfig.lib.json`. When a
lib imports a sibling (`ui`/`db` import `utils`; `ecom` imports all), how you wire the
tsconfig decides whether the build log is clean:

- A **composite** lib (`ui`, `db` — `db` inherits it) must **list the imported sibling's
  sources in `include`** (e.g. `"../utils/src/**/*.ts"`) and keep `"references": []`.
  Mirror `libs/editor`, which always built clean this way. A composite project
  `reference` to the sibling triggers `TS6305` ("output not built" — vite never produces
  the `tsc -b` out-tsc output); empty `references` *without* the `include` triggers
  `TS6307` ("file not listed"). Both are non-fatal log noise but should stay at zero.
- A **non-composite** lib (`ecom`, which extends `tsconfig.base.json`) just needs
  `"references": []` — no `include` of siblings.
- A **strict** lib (`db`/`sdk` set `noPropertyAccessFromIndexSignature`) compiles the
  sibling's *source* under its strict rules, so `libs/utils` must stay strict-clean
  (bracket-access undeclared keys, e.g. `process.env['R2_BUCKET_NAME']`).

Vite 8 (Rolldown) and vite-plugin-dts 5 added these rules:

- **`build.lib.entry` paths must be relative** (`'./src/index.ts'`), never
  `path.resolve(__dirname, …)`. `nx run <lib>:build` starts the Vite step from a lowercase
  `d:\` working directory, vite-plugin-dts 5 compares paths case-sensitively, and an absolute
  `D:\…` entry was silently skipped: `db` emitted 3 declaration files instead of 14, with no
  error. Check 5 above catches it.
- vite-plugin-dts 5 (a re-export of `unplugin-dts`) renamed the option `outDir` to
  `outDirs`. A leftover `outDir` is a TS2561 error and is ignored at runtime.
- Use `build.rolldownOptions`; `build.rollupOptions` is a deprecated alias. `external`,
  `output.preserveModules` and `preserveModulesRoot` behave exactly as before.
- Rolldown names shared chunks `dist-*`, `es-*` and `rolldown-runtime-*`, and adds a
  `_virtual/_rolldown/runtime` module, so a manifest `files` list must glob `*.mjs`/`*.js`
  rather than a chunk-name prefix.
- `[unplugin:dts] Outside emitted: dist/libs/<sibling>/src/...` log lines are expected. They
  are the sibling sources listed in `include`, reported and not written.
- **A bundled CommonJS module must never `require()` an external.** Rolldown keeps such a
  call as a `__require("react")` shim, where Vite 7's commonjs plugin rewrote it into an
  import. The shim throws "Calling `require` for "react" in an environment that doesn't expose
  the `require` function" in the browser and in any ESM consumer. It shipped in the first Vite 8
  builds of `editor` (`use-sync-external-store`, via `@tiptap/react`), `ui` (`react-color`'s
  `reactcss`, in the lazy SketchPicker chunk) and `cortex` (a lazy `require('next/cache')`).
  The fix is to keep the CommonJS package external and declare it in the lib's `package.json`
  `dependencies`: the editor and ui `afterBuild` hooks copy that field into the published
  manifest. Keep every React subpath external too (`/^react(\/|$)/`), which also stops
  `react/jsx-runtime` being bundled. For your own code, import statically instead (`cortex`
  now imports `next/cache` at module scope). Rolldown's `esmExternalRequirePlugin` does NOT work
  here: in library mode it left React bundled instead of external, in every placement tried.
  `verify-lib-dist.js` check 6 fails on the shim in any shipped ESM file.
- The root `vitest.config.ts` sets `oxc: { jsx: { runtime: 'automatic' } }`. Without it,
  Vite 8's Oxc honours `apps/nextblock/tsconfig.json` `"jsx": "preserve"` and every app test
  containing JSX fails to parse.

`vite-plugin-dts` `entryRoot: 'src'` keeps emission to the lib's own `src`, so listing
sibling sources does **not** leak their `.d.ts` into the tarball. The published `bin` path
in `apps/create-nextblock/package.json` should have **no leading `./`** (`bin/…`, not
`./bin/…`) or npm "auto-corrects" it with a publish warning.

If a generated project looks stale, check the sync script and template output (and whether
the libs were actually republished) before assuming the source app is missing the feature.
