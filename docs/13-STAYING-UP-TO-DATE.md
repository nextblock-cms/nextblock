# 13 · Staying Up to Date (Updates & Upstream Sync)

Every NextBlock install — however it was created — understands one command:

```bash
npm run update
```

It detects which kind of install it is running inside, updates the **code** from the right
source, installs the matching **dependencies**, and then applies any pending **database
migrations**. One step, in that order, so the schema never lags behind the code.

```bash
npm run update              # code + dependencies + schema
npm run update -- --check   # report what would change; write nothing
npm run update -- --yes     # never prompt (implied by CI=true)
npm run update -- --force   # run even when already on the latest version
npm run update -- --skip-db # code + dependencies only
npm run update -- --db-only # schema only: pending migrations and the database grants
```

> **Windows (PowerShell):** a bare `--` is stripped by the shell, so every flagged form above
> silently runs a *full* update instead. Invoke the script directly, from the project root:
>
> ```powershell
> # a project made with npm create nextblock
> node tools/update.mjs --check
> node tools/update.mjs --db-only
> # the monorepo (Vercel 1-click, fork or clone)
> node apps/nextblock/tools/update.mjs --check
> node apps/nextblock/tools/update.mjs --db-only
> ```

Implementation: [`apps/nextblock/tools/update.mjs`](../apps/nextblock/tools/update.mjs)
(synced into the standalone template as `tools/update.mjs`), on top of the shared engine
[`apps/nextblock/tools/lib/migrate-core.mjs`](../apps/nextblock/tools/lib/migrate-core.mjs).

---

## The four installs and their code channel

| # | Install | Layout | Code channel `npm run update` uses | Also updates itself? |
| :-- | :--- | :--- | :--- | :--- |
| 1 | Vercel 1-click / GitHub fork | Nx monorepo | `git merge upstream/master` | **Yes** — daily GitHub Action |
| 2 | `npm create nextblock` → Docker | flat app | `create-nextblock@latest` on npm | No |
| 3 | `npm create nextblock` → managed cloud | flat app | `create-nextblock@latest` on npm | No |
| 4 | `git clone` the monorepo | Nx monorepo | `git pull --ff-only origin` | No |

> **The Action is about layout, not hosting.** `nextblock-sync.yml` merges the **monorepo**
> into your repository, so it only works where your repository *is* the monorepo (rows 1
> and 4). Pushing a `npm create nextblock` project to GitHub and deploying it on Vercel does
> **not** make it eligible — its tree is `app/`, `components/`, `lib/` at the root, and
> merging `apps/`, `libs/` and `nx.json` into that would wreck it. Docker is orthogonal: it
> is how you *run* a project, not what shape its repository is.
>
> This is enforced, not just documented. `isMonorepoInstall()` in
> `apps/nextblock/lib/updates/check-upstream.ts` reads the `nextblock.install` marker in the
> bundled `package.json` (`"monorepo"` in `apps/nextblock`, overwritten to `"standalone"` by
> the scaffolder), so it works on a serverless filesystem where neither `nx.json` nor
> `.github/` is traced into the function. Both the update-track classification and the
> dashboard's **Connect GitHub** step key off it. They previously keyed off
> `process.env.VERCEL === '1'`, which meant a standalone app on Vercel was offered a
> workflow that would have merged the monorepo into it — *and* had its update banner
> suppressed, leaving it silently frozen with nothing to update it.

Detection is structural, not configured: a workspace with `nx.json` **and**
`libs/db/src/supabase/migrations` is the monorepo; anything else is a standalone project.
Within the monorepo, an `origin` pointing at `nextblock-cms/nextblock` is a contributor
clone (fast-forward pull); any other origin is a fork (merge from an `upstream` remote,
added automatically if missing).

### Why standalone installs update from npm, not from a GitHub release

A standalone project's layout is `app/`, `components/`, `lib/` at the root. A GitHub source
archive of this repository is the **monorepo** layout (`apps/`, `libs/`, `tools/`) — it
cannot be unpacked over a flat project at all, and the project has no remote to pull from
(`npm create nextblock` runs `git init`, with no initial commit and no remote). The
published `create-nextblock` package, by contrast, ships the complete standalone template
under `templates/nextblock-template/` — the exact artifact the project was scaffolded from —
and is versioned in lockstep with the app by the release scripts (`tools/scripts/release-all.js`,
or `release-cli.js` for a CLI-only release).

### Standalone updates are a real 3-way merge, not an overwrite

`npm run update` gives a standalone project the same experience as `git pull`, without an
upstream to pull from. It downloads the template for the version you are **on**
(`package.json` → `nextblock.version`) and the template for the **new** version, then walks
every framework file and picks the cheapest correct action:

| Situation | What happens |
| :--- | :--- |
| You don't have the file | Upstream added it — copied in. |
| Upstream didn't change it | Left completely alone, edits and all. |
| You never edited it | Replaced with the new version. |
| **Both** changed it | Real 3-way merge via `git merge-file`; conflicts get markers. |

So a file you never touched updates silently; a file you **customised keeps your edit**; and
only a change that genuinely overlaps yours conflicts — with ordinary
`<<<<<<< your version` / `>>>>>>> NextBlock <version>` markers. The updater lists the
conflicted files by name. Resolve them as you would any conflict, discard one file's merge
with `git checkout -- <file>`, or undo everything with `git reset --hard HEAD`.

Nothing is committed or staged for you: the result is plain working-tree changes you review
with `git status` and `git diff`, then commit yourself.

> **Why `git merge-file` and not `git apply --3way`?** `--3way` implies `--index`, which
> drags in three couplings this has no need of: it *stages* its result (so `git diff` shows
> you nothing), it requires every patched path to be tracked (a single framework path your
> project happens to `.gitignore` aborts the entire update with
> `does not exist in index`), and it requires the worktree to match the index (so a dev
> server regenerating `next-env.d.ts` mid-run aborts it too). `git merge-file` is plain
> file-in/file-out and touches no git state at all. Binary files are never merged
> textually — yours is kept and the updater says so.

Requirements: a git repository, at least one commit, and a clean working tree. Those are for
*reviewability*, not for the merge itself — they are what make `git diff` and
`git reset --hard HEAD` mean something. Cleanliness is re-checked immediately before the
merge, because staging the base runs a network download and the confirmation prompt can wait
on a human.

**Framework-owned paths** (what the merge covers): `app/`, `components/`, `context/`,
`hooks/`, `lib/`, `types/`, `tools/`, `scripts/`, `docker/`, `docs/`, `proxy.ts`,
`instrumentation.ts`, `index.d.ts`, `next-env.d.ts`, `postcss.config.js`, `eslint.config.mjs`,
`.browserslistrc`, `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `AGENTS.md`, `CLAUDE.md`.
`instrumentation.ts` (which registers the CMS second-factor check on a cold server) and
`.browserslistrc` joined the list in 0.23.6. A project that lacks either (scaffolded before the file
shipped, and updated since) gets it from the first file sync that a 0.23.6 or later updater runs.
That is not the update that reaches 0.23.6, which still runs the previous updater, nor a plain
`npm run update` once on 0.23.6, which finds the code current and syncs nothing: it is
`npm run update -- --force` after that update, or the update to the next release ("Upgrade notes"
→ 0.23.6 below).

**Never replaced**: `.env*`, `public/`, `README.md`, `.gitignore`, `.npmrc`, and the four
files the scaffolder generates per project — `next.config.js`, `tailwind.config.js`,
`tsconfig.json`, and `package.json`. `package.json` is **merged** (below), and two of the others
get one edit each. `next.config.js` gains the `postcss` browser alias when it lacks it, an anchored
edit ("The `postcss` browser alias" below). `tsconfig.json` gains `"ignoreDeprecations": "6.0"`
when `package.json` names TypeScript 6 or later and the file still sets `baseUrl`: the updater
parses it, adds the option and writes the whole file back as two-space-indented JSON (your own
layout is not kept), and a `tsconfig.json` that is not plain JSON (comments, trailing commas) is
left alone for you to edit. The rest of those files is yours.

**It never deletes.** Files you added yourself survive; a file removed upstream is left in
place rather than pruned (the updater walks only the new release's framework files).

#### The fallback

If there is no git repository, no commits yet, or the tree is dirty, there is nothing to
merge *against*, so the updater copies the files instead and puts a copy of anything it
replaced under `.nextblock-backup/<timestamp>/` (self-ignoring, via a nested `.gitignore`).
This is the degraded path, not the normal one — committing your work first is what gets you
the merge. A file that cannot be merged (a binary asset, or a `git merge-file` failure) is
never clobbered: your version is kept and the updater names it in the output.

`package.json` merge rules: third-party ranges (`next`, `react`, `tailwindcss`, …) are taken
verbatim from the new template — that is the dependency update. `@nextblock-cms/*` entries
already present are left alone (the scaffolder writes floating ranges, so `npm install`
picks up new libs on its own); new ones are added as `latest`. Your `name`, `version`,
`overrides` and any scripts or dependencies you added are preserved, and direct
dependencies are re-aligned to their `overrides` spec afterwards so `npm install` cannot
fail with `EOVERRIDE`. The framework's own scripts (`dev`, `build`, `start`, `lint`, `update`,
`deploy:supabase`, `affiliates:schedule-payouts`, the `docker:*` scripts and the rest of
`FRAMEWORK_SCRIPTS` in `tools/update.mjs`) are taken from the template;
`tools/scripts/schedule-affiliate-payouts.test.ts` fails when the app declares a script that
list does not name.

One exception to keeping your `overrides`: an override NextBlock wrote itself. `create-nextblock`
gives every project a few `overrides` (`postcss`, `qs`, `uuid`, `glob`, …), and a later release
may raise them. An override still set to one of NextBlock's earlier values moves to the current
one, together with the direct dependency the scaffolder aligned to it; the log prints each move.
Any other value is yours and wins over the template, and the log says so ("uuid stays at ^11.0.0:
your overrides.uuid pins it").
The known values live in `tools/lib/managed-overrides.mjs`. An update runs the updater that
was already on disk, so the update that brings a project to 0.21 still uses the old rules. Run
`npm run update` once more afterwards: it moves the overrides and reinstalls.

A release that adds a library (for example `@nextblock-cms/affiliates`, the Affiliates
package) reaches an existing project's `package.json` on its own, but the updater adds
no package to `next.config.js` or `tailwind.config.js` (its only `next.config.js` edit is the
`postcss` alias below). It warns when `next.config.js` does not name a NextBlock package the
project depends on; add that package to `transpilePackages`, and add the library to
`tailwind.config.js` `content` the way a new scaffold has it
(`'./node_modules/@nextblock-cms/affiliates/**/*.{js,cjs,mjs}'`), or its classes are not
generated.

**The `postcss` browser alias.** Since 0.23.4, browser bundles resolve `postcss` to the empty
`lib/browser-stubs/postcss.cjs` through `turbopack.resolveAlias` in `next.config.js` (docs/04 →
"Authored HTML renders through `sanitizeAuthoredBlockHtml`"). A new scaffold inherits the entry
from the app's config. For an existing project the updater adds
`postcss: { browser: './lib/browser-stubs/postcss.cjs' },` when `next.config.js` does not mention
`browser-stubs/postcss` and the project has the stub: into the file's only
`turbopack.resolveAlias` (scaffolds from 0.19 to 0.23.3), or as a new `resolveAlias` inside its
only `turbopack` block (older ones). It keeps the old file under
`.nextblock-backup/<timestamp>/next.config.js` and prints what it changed; `--check` reports the
edit and writes nothing. A file it cannot patch safely (no single `turbopack: { … }` object, a
second `turbopack` or `resolveAlias`, a quoted key, a spread or a one-line object to extend, an
ES module, a `next.config.ts`) is left alone, and the updater prints the entry to add by hand. A
file that mentions `browser-stubs/postcss` anywhere, a commented-out entry included, is never
touched. The step also runs when the code is already current, because the update that reaches
0.23.4 still runs the previous updater, which never edits `next.config.js`
(`tools/lib/postcss-browser-alias.mjs`).

**Block editors the CMS cannot open.** Since 0.23.4 `EditableBlock.tsx` and `ColumnEditor.tsx`
open a block's editor file only through `BLOCK_EDITOR_LOADERS` in
`app/cms/blocks/components/blockEditorLoaders.ts`, keyed by the registry's
`editorComponentFilename` without its extension; through 0.23.3 they imported any module in
`app/cms/blocks/editors/` by that name. A block of your own whose definition sets
`EditorComponent` is not affected: both open that component instead. An editor you added to that
folder (docs/07) comes through the update without a conflict, and the CMS then opens nothing for
its block (the browser console says "No editor component found" and prints the line to add). So
the updater reads each `editorComponentFilename` that `lib/blocks/blockRegistry.ts` writes as a
string literal, leaves out a filename whose own object literal also sets `EditorComponent` (a
property, a method or the shorthand; a bare `undefined` or `null` value sets nothing, and a spread,
on either side, is not followed), keeps the names that have a `.tsx`, `.ts`, `.jsx` or `.js` file
in `app/cms/blocks/editors/` (subfolders included), and warns for each one the map has no key for,
with the line to add: `FaqBlockEditor: () => import('../editors/FaqBlockEditor'),`, or
`'faq/FaqBlockEditor': () => import('../editors/faq/FaqBlockEditor'),` for a name that is not an
identifier. It skips test, spec, story and declaration files (a name that ends in `.test`, `.spec`,
`.story`, `.stories` or `.d` once its extension is off), which a mapping would bundle into the CMS,
and any name other than ASCII letters, digits, `_`, `$`, `-` and single dots inside a folder or
file name, with `/` between folders (so no `./` or `../`). Registry names with no file (the cart,
checkout and product details editors, the testimonial placeholder) are skipped too, so an
unmodified project gets no warning (`findUnlistedBlockEditors` in `tools/update.mjs`).

The update that reaches 0.23.4 still runs the previous updater, which has no such check, so the run
after it is the first to warn. On a standalone project the check runs after a code update is
applied and on a run that finds the code already current, `--check` included. After the
file-replacement fallback, which also replaces a `lib/blocks/blockRegistry.ts` you edited, restore
your entries from `.nextblock-backup/` and run `npm run update` again so the check sees them. In
the monorepo (a fork, a 1-click deploy or a clone), `npm run update` runs it under `apps/nextblock/`
after it merges (or pulls) upstream and when there is nothing to merge, but not under `--check`;
the daily sync workflow (`nextblock-sync.yml`) does not run the updater, and `--db-only` skips the
check everywhere. It only warns: it edits nothing and never fails the update. It says nothing for
a project without `blockEditorLoaders.ts` (before 0.23.4), the registry or that folder, or whose
registry or map it cannot parse (an error reading either file costs one dim line), which includes
a map entry other than `name: value` or `'name': value` (a spread, a shorthand, a method, an
accessor or a computed key). When either file still holds a merge conflict (a line that starts with
`<<<<<<<` or `>>>>>>>`, alone or followed by a space, or a line of seven `=` that is code, not text
in a string, a template literal or a comment), it prints one line instead: resolve the conflict in
that file, then run `npm run update` again.

### The version stamp

`package.json` carries `nextblock.version` — the NextBlock release the project is on,
written by the scaffolder and re-written by each successful update. The project's own
`version` field belongs to you; the moment you bump it for your own site, comparing a
release against it would be meaningless. Both `npm run update` and the dashboard's update
check read the stamp, falling back to `version` only for projects created before it existed.

---

## Track A — Git-backed installs update themselves

The workflow lives at [`.github/workflows/nextblock-sync.yml`](../.github/workflows/nextblock-sync.yml).
It runs **daily at 00:00 UTC** and on demand (**Actions → NextBlock Upstream Sync → Run
workflow**). Each run:

1. Merges the upstream release branch into your deploy branch.
2. **Clean merge** → commits and pushes to your branch, which triggers a normal Vercel
   deployment. Any open conflict issue is auto-closed.
3. **Conflict** → aborts the merge and opens (or updates) a GitHub Issue carrying the hidden
   marker `<!-- nextblock-sync-conflict -->`. The CMS mirrors that issue into an **amber
   banner** on the dashboard with a link to resolve it. Once you resolve and **close the
   issue**, the banner clears automatically.

Running `npm run update` on a local clone of that fork performs the same merge immediately,
rather than waiting for midnight.

### One-click install (Connect GitHub)

Vercel's 1-click deploy creates your repo through an integration whose token lacks the
GitHub **`workflow`** scope, so GitHub **strips `.github/workflows/`** from the copy — your
new repo won't have the sync workflow even though the template ships it. To fix that with no
token to create, the dashboard onboarding step shows a **Connect GitHub** button:

1. Click **Connect GitHub** — a short code appears.
2. Click **Authorize on GitHub**, enter the code, approve.
3. NextBlock installs `.github/workflows/nextblock-sync.yml` into your repo for you, and the
   step turns green.

This uses GitHub's **device flow** — no token to create, no per-site callback, nothing to
configure (the public client id ships with NextBlock). The authorization requests the
`repo` + `workflow` scopes because GitHub requires them to write a workflow file; NextBlock
uses the grant once to install the file and does **not** store it. Revoke it anytime at
GitHub → **Settings → Applications**.

### Do you need to enable GitHub Actions?

It depends on how the repository was created:

- **Vercel 1-click deploy** creates a **new repository you own** (a copy, *not* a GitHub
  fork). GitHub **enables Actions by default** on repos you own — **there's nothing to turn
  on**. The sync workflow runs automatically once it lands on your repo's **default branch**.
- **A manual GitHub _fork_** (the "Fork" button) has Actions **disabled** by default. Enable
  them once: your repo → **Actions** tab → **"I understand my workflows, go ahead and enable
  them."**

> **Seeing GitHub's "Get started with Actions / choose a workflow" page?** That only means
> your Actions tab is **empty** — `.github/workflows/nextblock-sync.yml` isn't on your
> **default branch** yet (scheduled workflows only run from the default branch). Once it is,
> the tab shows **NextBlock Upstream Sync** with a **Run workflow** button. There is no
> separate "enable" button on an owned repo because Actions are already on.

### No GitHub secrets required (public forks)

The conflict signal uses the **`GITHUB_TOKEN` that GitHub provides to every workflow
automatically** — you do **not** add any Supabase secret to GitHub. The app writes the
dashboard alert itself using the Supabase key it already has, and reads your repo's
conflict issues over the public GitHub API.

> **We recommend forking to a _public_ repository** — it's fully zero-config.

### Private forks

If your fork is **private**, the public GitHub API can't read its issues, so add **one**
environment variable to your deployment (Vercel project → Settings → Environment
Variables, or your `.env`):

| Variable | Value |
| :--- | :--- |
| `NEXTBLOCK_GITHUB_TOKEN` | A GitHub token with **read access to issues** on your fork (a fine-grained PAT scoped to the repo, or a classic token with `repo`). |

With that set, the dashboard conflict banner works on private forks too. (The workflow
itself still needs no extra secret — `GITHUB_TOKEN` covers it either way.)

> **⚠️ Vercel Hobby (free) plan + a private repo blocks auto-deploys.** On Hobby, Vercel only
> deploys **private**-repo commits authored by the project owner and rejects automated
> (bot/collaborator) commits — so the auto-merge push won't deploy (*"Hobby Plan does not
> support collaboration for private repositories"*). Either **make the repo public**
> (recommended — it also makes the conflict banner tokenless) or upgrade to **Vercel Pro**.
> Public repos have no such restriction on Hobby.

---

## Track B — the "update available" banner

Standalone installs aren't wired to a GitHub Action, so the CMS polls for a newer release
and records a `runtime_update_available` alert — an **indigo banner** on the dashboard
naming the version you're on, the version available, and the command to run.

The version signal is the **npm registry** (`create-nextblock`'s `latest` dist-tag), with
GitHub's latest release as a fallback. npm is authoritative because releases are cut by hand,
for some versions only, and have in practice sat several minor versions behind the real
version — which silently disabled this check entirely. Whichever source is ahead wins.

The banner's links are always for the version it announces (`resolveUpdateLinks` in
`lib/updates/check-upstream.ts`). **Release notes** link GitHub's latest release only when it is
that version. **Download latest** is in the project's own layout (`isMonorepoInstall()`):

| Layout | Download latest |
| :--- | :--- |
| Standalone project (flat app) | `create-nextblock-<version>.tgz` from npm, the standalone template `npm run update` installs; none while a GitHub release is ahead of npm |
| Nx monorepo (shows this banner only when the app cannot resolve its GitHub repository, or with `NEXTBLOCK_UPDATE_TRACK=standalone`) | the latest release's source archive when the release is that version, else the source archive of the tag `v<version>`, unless GitHub answers that the tag does not exist (as for 0.23.2 and 0.23.3): then none |

A standalone project is never offered a GitHub source archive, and a monorepo never the npm
tarball: each is the other's layout, which cannot be unpacked over it (see "Why standalone installs
update from npm, not from a GitHub release" above). Through 0.23.5 both links came from GitHub's
latest release whatever its version, so with npm ahead an install on 0.23.4 was told 0.23.5 was out
and offered the 0.23.4 archive and notes. The tag is looked up (one more GitHub API request) only
for a monorepo about to record an alert whose latest release is not that version. When GitHub
cannot answer (the unauthenticated API allows 60 requests an hour per address), the tag's archive is
linked all the same: archive downloads are outside that limit and work as soon as the tag exists.
An alert keeps the links it was recorded with (a release cut later for the same version does not
change them), so a poll between the npm publish and the tag push records a monorepo alert with no
download link; the banner still names the version and `npm run update`, which merges upstream in a
git clone.

Dismissing the banner is respected: the dedupe key is the *version*, not the unresolved
state, so a dismissed alert is not re-inserted on the next poll, while a genuinely newer
version still raises a fresh one.

### How the dashboard stays current (no cron)

The CMS refreshes update/conflict status **in the background after a dashboard page
loads** (throttled to ~6 hours), so it works on Vercel's Hobby plan without consuming a
cron slot. Admins can also force a check immediately:

```
POST /api/cms/check-updates      # ADMIN past the enrolled second factor; returns the version + conflict status
```

---

## Where the migration SQL lives (and why that used to bite)

The `.sql` files in `libs/db/src/supabase/migrations` are the source of truth, and they
reach a running install through **four** carriers:

| Carrier | Produced by | Read by |
| :--- | :--- | :--- |
| `libs/db/src/supabase/migrations/*.sql` | hand-authored | the monorepo: `npm run update`, `npm run db:migrate`, the build hook |
| inside the `@nextblock-cms/db` npm package | `tools/scripts/copy-db-supabase.cjs` | `npm run update` on a standalone project |
| `<project>/supabase/migrations` | the CLI, at scaffold time | the build hook, and the Docker `migrate` service |
| `apps/nextblock/lib/setup/migrations-bundle.ts` | `npm run generate:migrations-bundle` | the `/setup` wizard on serverless hosts |

`<project>/supabase/migrations` is materialized **once**, when the project is created.
Nothing used to refresh it, so upgrading `@nextblock-cms/db` moved the generated TypeScript
types forward while leaving the schema behind — the app would then fail at runtime with
`column "…" does not exist`. Two changes close that gap:

- `npm run update` re-copies the package's migrations into `<project>/supabase/migrations`
  **after** `npm install` and **before** applying anything.
- `migrate-core.collectMigrations()` **unions** all reachable directories (monorepo →
  project → `node_modules/@nextblock-cms/db`), deduping by version, so even a user who only
  ran `npm install` gets the new SQL.

> **Migration squashes.** Every so often the folder is squashed into a new *generation*
> (`02000`–`02004`, then `02005+`; see [docs/04](./04-DATABASE-AND-AUTH.md) → "Migration
> Structure"). An install crosses a squash with no manual step: the new generation's files
> are simply pending, its `GG000_catchup_*` file replays only the retired migrations this
> database never recorded, the baseline DDL is idempotent, and the seed skips any database
> that already holds content. Retired files that linger in `<project>/supabase/migrations`
> are harmless — they are already recorded, so nothing applies them twice.

### Build-time migrations

A build-time hook ([`apps/nextblock/tools/build-migrate.mjs`](../apps/nextblock/tools/build-migrate.mjs))
applies pending, forward-only migrations **before** `next build`, so a new version's code
never runs against an old schema:

- **Vercel:** runs automatically when `VERCEL_ENV=production`; **preview/development
  builds are skipped** so they never touch live data.
- **Standalone / local / Docker:** gated on `NEXTBLOCK_BUILD_MIGRATE=1`, which the
  `/setup` wizard and the create/Docker setup scripts write into your env automatically.

It is **non-destructive and never breaks the build** — if the database is unreachable it
logs a warning and continues. That guarantee is why it loads `migrate-core.mjs` through a
*guarded dynamic import*: an unresolvable top-level import is a hard ESM error no `try`
could contain.

After the pending files, this hook, `npm run update` and `/setup` run the same post-apply grant
pass (`GRANTS_SQL` in `migrate-core.mjs` and `lib/setup/schema-apply.ts`): blanket grants on
`public` for the API roles, then the revokes those grants would otherwise undo (EXECUTE on
every trigger function, and the explicit list in `API_ROLE_REVOKE_SQL`). The two copies must
stay identical; `tools/lib/migrate-core.test.mjs` fails when they drift. Until 2026-10-20
the hook had the grants without the revokes, which is how the Security Advisor's
SECURITY DEFINER warnings came back after every deploy (`02024` repairs that).

The hook runs the pass whenever it runs, even with nothing pending. From 0.23.6's updater on,
`npm run update` does too (with nothing pending, `npm run update -- --db-only` re-applies the
grants alone), and it runs its schema step on the `migrate-core.mjs` its code update brought.
Earlier updaters ran the pass only after applying a migration, and with the copy they had loaded
before the update: a release's migrations got the previous release's revoke list, and a function
the new release revokes stayed callable by the API roles until the next build with the hook on
(see the 0.23.6 note). If the new copy does not load, the update says so, applies what is pending
with the copy it loaded first (and that copy's grant pass), and with nothing pending runs no grant
pass. A conflict the update left, in that file or any other, holds the whole schema step before
the new copy is loaded ("Conflicts hold the schema back" below).

### Conflicts hold the schema back

If a standalone merge left conflicts, `npm run update` finishes the code and dependency
work — merged files, `npm install`, the refreshed migration SQL, the version stamp — and
then **stops before migrating**. The schema never moves ahead of code the developer has not
finished deciding on, and it stays untouched if they abandon the update entirely.

Resolving is the only extra step; there is no separate resume command. Re-running
`npm run update` sees the code is already current, skips straight to the schema step, and
applies the migrations. Before it does, it re-checks with
`git grep -lE '^<<<<<<< your version\r?$'` (the updater passes a real carriage return for `\r`;
typed into a shell, `\r` reaches git as a plain `r`, so to look yourself run
`git grep -l "^<<<<<<< your version"`) and refuses while any marker remains — the label is the
one `mergeTemplates()` passes to `git merge-file`, so it cannot be confused with a conflict from
the developer's own git work, and it is anchored to the start of a line so source that merely
mentions the string does not trip it. The optional carriage return is for files with CRLF line
endings: `git merge-file` writes the marker lines with CRLF when the three files it merges (yours
and the two published copies) all use CRLF, and about half the template files create-nextblock has
published do (the updater and the migration engine among them), so a project made with
`npm create nextblock` has such files on any system. Through 0.23.5 the pattern ended in `$`
alone, so a conflict in such a file held nothing and the migrations were applied over it. The
update that reaches 0.23.6 still runs your previous updater and its check, so CRLF files count
from the run after it.

`git reset --hard HEAD` walks away from the whole thing; the database was never touched.

### The contract every applier honours

Whether SQL is applied by `npm run update`, the build hook, the `/setup` wizard or the
Supabase CLI, the rules are the same:

- **Forward-only.** Applied versions are skipped by version number, so re-running is safe.
- **One transaction per file.** Each migration and its history row commit together; a
  failure rolls back and leaves the database exactly as it was.
- **Tracked in `supabase_migrations.schema_migrations`**, identically to the Supabase CLI.
- **Two backends**, preferred in order: the Supabase Management API (when
  `SUPABASE_ACCESS_TOKEN` + a project ref are available — robust on IPv4 build networks),
  otherwise a direct Postgres connection via `POSTGRES_URL` / `DATABASE_URL`.

> **Edge case: a history these appliers did not write.** `npm run update`, the build hook and
> `/setup` apply each file whose version is not recorded, so a recorded version with no file, like
> the ones a squash retires, changes nothing for them (the catch-up, `GG000_catchup_*`, reads those
> rows to decide what to replay), and recorded versions without `public.site_settings` (the schema
> was dropped) are cleared so every file runs again. Since 0.23.7 they refuse one shape, before
> writing anything: an **empty** history over a database that has `public.site_settings`, when
> `site_settings.migration_baseline_generation` is unset or below the folder's generation (it never
> crossed the last squash, so the catch-up would replay the whole retired generation over its
> content), or when the list holds a retired generation's file (it would run again as written). The
> build hook logs it and the build goes on, `npm run update` fails and says what to do, and `/setup`
> shows it. An empty database, and one born at or crossed to the current generation, still get every
> file (docs/04 → "Production migration policy"). The way out is the history: restore
> `supabase_migrations.schema_migrations` from a backup, or copy it from the database a
> `public`-only dump came from (docs/04 → "How a squash crosses live databases"). What else to do
> depends on the install:
>
> - **Monorepo:** `npm run db:migrate` is stricter: it refuses to apply the baseline over an
>   empty history, and it stops while retired versions remain, which the `supabase db push` it
>   runs would refuse. Run `npm run db:migrate:repair-history` then `npm run db:migrate` once to
>   reconcile (see [docs/04](./04-DATABASE-AND-AUTH.md)). If the history still lists versions
>   retired by a squash, `repair-history` detects that and offers to reconcile the squash instead
>   — take the offer; the plain repair is for a wiped history on a database at the current
>   generation. On one that never crossed the last squash, restore the history instead: the repair
>   records only this generation's versions, and the catch-up would then replay the retired one.
>   Since 0.23.9 `repair-history` refuses that database itself (`--check` says so too).
> - **Standalone project** (`npm create nextblock`): `db:migrate` and `db:migrate:repair-history`
>   exist only in the monorepo's root `package.json`, and nothing here needs them. Leave retired
>   versions in the history (`npm run update` lists them on every run). An empty history over a
>   database at the current generation replays and records every file again, which every migration
>   is written to survive (docs/04 → "Production migration policy"), and the catch-up skips itself
>   there. One the appliers refuse needs its history restored, or, when the refusal names only
>   retired files on a database that crossed already, those files removed from
>   `supabase/migrations` (they came with the scaffold; nothing needs them). Since 0.23.9 every
>   `npm run update` moves NextBlock's own retired files (by exact name) to
>   `supabase/migrations-retired`, which nothing reads, before its schema step; a file of your own
>   stays, whatever its number. Their versions then have no file, which is the state the Supabase CLI
>   objects to below. Only the Supabase CLI objects to retired versions: if you run it on this
>   database, `supabase db push` refuses while they remain and prints the
>   `supabase migration repair --status reverted …` command that removes them. Run it only once
>   the catch-up has run (it is recorded, and `site_settings.migration_baseline_generation` holds
>   the current generation, `2` today): until then those rows are its only record of what not to
>   replay. Never record the catch-up with `--status applied`, as a recorded version never runs
>   ([docs/04](./04-DATABASE-AND-AUTH.md) → "How a squash crosses live databases").
>
> **Windows:** PowerShell strips a bare `--`, so `npm run update -- --db-only` runs a full
> update instead of the database-only one. Use `node tools/update.mjs --db-only` (in the
> monorepo, `node apps/nextblock/tools/update.mjs --db-only`).

---

## Adding a migration (maintainers)

Migrations are **append-only**. List the folder and take the number after the highest file
on disk — do not trust a number hardcoded in any doc:

```bash
ls libs/db/src/supabase/migrations | tail -1
```

After adding one, regenerate everything derived from the folder:

```bash
npm run db:migrate:check          # read-only preview of the pending list
npm run db:migrate                # apply
npm run db:types                  # regenerate Supabase TypeScript types
npm run generate:migrations-bundle # refresh the /setup wizard's embedded copy
npm run generate:sandbox          # refresh the sandbox reset payload
npm run sync:create-nextblock     # propagate into the standalone template
```

`generate:migrations-bundle` and `generate:sandbox` are easy to forget and fail silently —
the bundle sat three migrations behind for a while, which would have left a serverless
`/setup` applying an incomplete schema. Treat the block above as one unit of work. A `db`
release now refuses a bundle that lacks a packed migration or embeds one the package does not
ship: `verify-lib-dist.js` check 14 compares the file names (not the SQL).

---

## Upgrade notes

Most releases need nothing beyond `npm run update`. These ask for a step of your own.

### 0.23.11 — `npm run deploy:supabase` without a shell

- `tools/deploy-supabase.js` (updated by `npm run update`) now starts the Supabase CLI directly
  instead of running one shell command string. A database password holding `&`, `|`, `$`, `;`, `"`
  or another shell character broke the command (or ran part of it as another one), and the script
  printed the password in its log; both are fixed, and the log shows `<db-password>`. It runs your
  project's installed CLI, or `npm exec --yes -- supabase` through npm when none is installed.
  Nothing to do.

### 0.23.10 — Docker images on Node 26, dependency refresh, Supabase CLI 3, `postgres` 4

- **Docker installs run Node 26 LTS.** The `Dockerfile` (one of the files `npm run update` manages)
  now builds and runs on `node:26-alpine` instead of `node:22-alpine`. After `npm run update`,
  `npm run docker:up` rebuilds the image on it; there is nothing else to do. Cloud installs keep the
  Node version their Vercel project settings pick, and a project created with `create-nextblock`
  still runs on Node 22.12 or later.
- **Dependencies moved to their latest compatible versions** (Next.js 16.4.6, Tiptap 3.35, Vite 8.3,
  Vitest 5.1, Stripe 23.2, AI SDK 7.0.177, among others). `npm run update` installs them. The
  versions still held back, and why, are in docs/05 → "Dependency versions".
- **The `postgres` database driver moves to version 4** (porsager/postgres `^4.1.1`). `npm run update`
  installs it, and NextBlock's own code (`/setup`, the build-time migrations, backups, the checkout's
  stock fallback, the two `schedule-*` scripts) needs nothing from you. Code of your own that uses
  `postgres` may: the server now types every parameter, so a `Date` where the query does not decide
  the type needs a cast (`${date}::timestamptz`) and a `Date` written to a `timestamp` or `date`
  column is taken as UTC; the package is an ES module, so `require('postgres')` returns
  `{ default }` (use `(await import('postgres')).default`); `sql.array()` is gone; a `begin` sent
  outside `sql.begin()` on a pool now fails; and a connection with no `ssl` option reads
  `PGSSLMODE`. The driver's README ("Upgrading from v3") lists the rest.
- **Supabase CLI 3.** It changed which database a command acts on: `db push`, `migration list`,
  `migration repair`, `db pull`, `db dump` and `gen types` now act on the LOCAL stack unless given
  `--remote`, every change to a hosted project needs `--yes` when the CLI cannot ask (Enter now means
  No, and a piped `y` no longer confirms), and the CLI reads your `.env.local` itself: a
  `SUPABASE_<PATH>` variable there overrides that key of `supabase/config.toml`, and `config push`
  sends the overridden value.
  - **New projects** (`npm create nextblock`) get the `supabase` devDependency at ^3.2.0 and a
    `supabase/config.toml` written for it. The setup wizard pushes the schema with
    `db push --include-all --remote=<your ref> --yes` (its own "Apply the database schema" question
    is your yes) and now refuses a Project ID that is not the 20-letter Reference ID.
  - **Existing projects need nothing.** `npm run update` changes neither your `supabase`
    devDependency (a `^2` range never installs 3.x) nor your `supabase/config.toml`. It does update
    `tools/deploy-supabase.js` (`npm run deploy:supabase`), which now reads the installed CLI's
    version: on 2.x it runs `db push --linked` as before, on 3.x it names your project with
    `--remote=<SUPABASE_PROJECT_ID>`. It also refuses a `SUPABASE_PROJECT_ID` that is not a
    20-letter ref: CLI 3 looks any other value up as a branch name of the linked project.
  - **To move a project to CLI 3 yourself** (optional):
    1. `npm install --save-dev supabase@^3.2.0`.
    2. In `supabase/config.toml`, rename the `[inbucket]` section to `[local_smtp]` (CLI 3 refuses
       the old name for `start`, `stop`, `status` and every database command), and under
       `[auth.email]` and `[auth.sms]` rename `enable_signup` to `enabled` (same meaning; the old
       name still works, with a warning). `npx supabase config validate` lists anything else.
    3. Add `--remote` to any Supabase CLI database command you run yourself against your hosted
       project (`npx supabase migration list --remote`, `npx supabase db push --remote`), and
       `--yes` where a script runs it. Without `--remote` the command reads or writes your local
       stack, or fails when none is running.
    4. Check what your `.env.local` overrides: `SUPABASE_AUTH_RATE_LIMIT_EMAIL_SENT=30` (written by
       the scaffolder) now sets `auth.rate_limit.email_sent`, which `config.toml` also sets to 30.
  - Docker installs do not use the Supabase CLI and are unaffected.

### 0.23.9 — Retired migration files set aside, times in your own time zone, media libraries past 1,000 files

- **Migration 02048** adds UI copy only (the store's notices for add-on licenses, EN + FR) and
  applies like any other migration ("Build-time migrations" above). Copy you edited under CMS →
  Translations stays as it is. The notices show only on a store that carries NextBlock's own
  license products (nextblock.dev, and the public sandbox, whose reset imports them): no other store
  changes.
- **Retired migration files leave `supabase/migrations`** (projects made with `npm create
  nextblock`). A project scaffolded before a migration squash still holds the retired generation's
  files there, which nothing needs ("The contract every applier honours" above). `npm run update`
  now moves NextBlock's own (exact names, `tools/lib/retired-migrations.mjs`) to
  `supabase/migrations-retired` before its schema step, and leaves your own migrations alone,
  whatever their numbers. The update that brings 0.23.9 runs the updater you had, which does not
  do this, so **run `npm run update` once more afterwards** (`--check` lists what it would move).
  Commit the move with the rest; the new folder is safe to delete. Their versions stay recorded in
  the migration history, which the updater, the build hook and `/setup` ignore. If you also run the
  Supabase CLI on that database, `supabase db push` now refuses while those versions have no file:
  once the catch-up has run (`site_settings.migration_baseline_generation` holds `2`), run the
  `supabase migration repair --status reverted …` command it prints ("The contract every applier
  honours" above).
- **`npm run db:migrate:repair-history` refuses a database that never crossed the last squash**
  (monorepo installs): restore the migration history instead (docs/04 → "How a squash crosses live
  databases").
- **Times in your own time zone.** The CMS Messages and Interactions screens, the Site Scripts
  history, the trusted devices under Security, the trial end on the Packages screen and the public
  message thread (`/thread/…`) printed times the way the server formats them (UTC on Vercel), or
  could make React rebuild the page (error #418). They now show the server's UTC text while the page
  loads, then the viewer's own.
- **Media libraries past 1,000 files.** The library listed only the newest 1,000 files, a folder
  holding only older files vanished from its navigator, and the counts stopped there; the CMS
  transfer's media map stopped there too. All of it reads every row now, and the "Unused files"
  view asks about them in batches of 500. A library of many thousands of files lists them all on
  one page: narrow it with a folder or a search.
- **Working in the monorepo:** use Node 22.18 or later (`.nvmrc`). Lib builds on an older Node
  print a warning: Vite's native config loader, which it will make its default, cannot read the
  `vite.config.mts` files there (docs/05 → "Node.js floor").

### 0.23.7 — Product stock at scale, a stock backfill, a published change applied once, products created in part

These concern every install. Migration 02046 changes how stock is written (it adds no table, column
or policy), and 02047 adds one table, `product_stock_publishes`, that the stock rule counts from.

- **Migrations 02046 and 02047.** They apply like any other migration ("Build-time migrations"
  above): `npm run update` applies them when it has a database connection, after copying them into
  `supabase/migrations` in a project made with `npm create nextblock` (a monorepo install gets them
  through the merge); otherwise the build hook does at the next production build. A Docker project
  applies them on `npm run docker:up`. `npm run update` asks first ("Apply N migration(s) now?", unless
  you pass `--yes` or `CI=true` is set); the build hook and `npm run docker:up` do not. Run the query
  in the backfill bullet below before any of them.
  - **Coming from 0.23.5 or earlier, outside Docker,** also take the 0.23.6 grant step below
    (rebuild with the build hook on, or run `npm run update -- --db-only` once): the updater you came
    from applies 02046 and 02047 with its own grant pass, which leaves `anon` able to call the three
    functions 02046 adds (`upsert_inventory_items`, `update_inventory_quantities`,
    `delete_inventory_items`), and `anon` a SELECT and `authenticated` a DELETE on 02047's
    `product_stock_publishes`, until this release's pass takes that back. The functions run with the
    caller's own rights and `anon` can write no inventory, so such a call fails, and the table's row
    policies still refuse those reads and deletes. Coming from 0.23.6 needs nothing more: its updater runs
    this release's grant pass.
  - **Until they are applied:** Cortex AI and MCP clients cannot write `inventory_items` (the call
    answers that the function is missing); the CMS writes stock as in 0.23.6, and a publish counts a
    draft's stock as 0.23.6 did.
  - **By hand:** an install that applies migrations itself (the monorepo's `npm run db:migrate`)
    runs `npm run db:migrate:check` first, confirms 02046 and 02047 are listed as pending, then runs
    `npm run db:migrate`.
- **The backfill gives shared stock its lowest figure.** 02046 gives every SKU a sale can deduct
  (each variant's, and the SKU of each product without variants; blank ones aside) the inventory row
  it lacks, holding the lowest stock among the variants and products that carry the SKU, and from
  then on they all show that figure. The CMS Inventory screen does the same for the SKUs it lists
  each time it opens, so where staff use that screen few such SKUs are left. Where a SKU's carriers
  agree, its stock stays as it was; where several carry it at different figures (translations whose
  stock drifted apart, two products sharing a SKU), the higher ones are replaced by the lowest. A
  product with variants that carries one of those SKUs then shows as its total the sum of its
  variants' inventory rows, as every stock change computes it: a total last computed while a variant
  had no row now counts that variant, and a variant with a blank SKU counts 0. Before you update, run
  this read-only query in the Supabase SQL editor. It lists each SKU whose carriers disagree, the
  figure they will all show and the highest one now:

  ```sql
  WITH carrier AS (
    SELECT v.sku, GREATEST(COALESCE(v.stock_quantity, 0), 0) AS quantity
      FROM public.product_variants v
    UNION ALL
    SELECT p.sku, GREATEST(COALESCE(p.stock, 0), 0)
      FROM public.products p
     WHERE NOT EXISTS (SELECT 1 FROM public.product_variants v WHERE v.product_id = p.id)
  )
  SELECT c.sku, min(c.quantity) AS stock_after, max(c.quantity) AS highest_now, count(*) AS carriers
    FROM carrier c
   WHERE NULLIF(trim(c.sku), '') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.inventory_items i WHERE i.sku = c.sku)
   GROUP BY c.sku
  HAVING min(c.quantity) <> max(c.quantity)
   ORDER BY c.sku;
  ```

  No rows: nothing to do. Otherwise keep the list, update, then set the stock of each listed SKU on
  the Inventory screen where the lowest figure is wrong. An install that updates itself ("Track A"
  above) applies 02046 at its next build, so run the query before then if you can: afterwards it
  lists nothing, and the higher figures survive only in a database backup from before the update.
  Then check, on the Inventory screen, the stock of SKUs that translations or several products share.
- **Large stock publishes no longer time out.** Once 02046 has run, the 0.23.6 note's warning that a
  product publish changing the stock of hundreds of SKUs can pass the 8 s statement timeout no longer
  applies: the inventory trigger now runs once per statement, not once per row. On local replays a
  publish changing 500 SKUs beside 2,000 other products took about 0.7 s, and a thousand SKUs 2 to
  4 s. A draft that failed to publish that way can be published again. Two orders paid at the same
  moment for variants of one product no longer deadlock in their stock deduction, nor does a stock
  write from the CMS or Cortex AI with a publish (docs/09 → "Stock: only what the editor changed"
  lists the cases left).
- **A change already published is not applied again** (02047). An autosave that lands just after a
  publish, or a tab opened before it, starts the draft again with the stock its page loaded before
  that publish, and through 0.23.6 a publish of that draft applied the change again once a sale had
  moved the stock. The edit page now records which publish it loaded the stock after, and the publish
  counts such a draft's figures from the ones that publish entered: the same figures again leave the
  stock as the store has it, sales since included (loaded 5, typed 10 and published, one sold: 9
  stays, where 14 was written before), with a warning naming each such SKU, and a figure typed after
  that publish lands as typed (12 after 10 was published from a load of 5: 12, where 17 was written
  before). Drafts saved before the upgrade carry no such record and publish as before.
- **A product created in part opens its edit page.** Through 0.23.6, when the CMS created a product
  and its stock write then failed (it could lose a lock race with a publish or a sale of a SKU it
  shares, as a translation's does), the page reported a failed create although the product existed,
  and its categories were not saved. Now every step after the product row is checked (images, tax
  setting, SEO fields, sale schedule, stock, categories), the stock write is retried, and a product
  created in part opens on its edit page with a notice naming what was not saved: set the stock on
  the Inventory screen, check the rest on the page, then save. Cortex AI's `create_cms_product`
  reports such a product as created, naming the steps that failed. A product whose create reported a
  failure before the update may exist without its categories: check the product list before you
  create it again.
- **Cortex AI and MCP clients write inventory rows in SKU order.** `execute_database_mutation` and
  `execute_database_action_plan` write `inventory_items` through 02046's functions: a row carries
  only `sku` and `quantity`, and an update sets only `quantity`. A call that names another column
  (`created_at`, `updated_at`) is refused before confirmation.
- **An empty migration history over an older database is refused.** `npm run update`, the build hook
  and `/setup` now stop before writing anything when `supabase_migrations.schema_migrations` is
  empty on a database that has content but never crossed the last squash, or when the migration list
  holds a file from a retired generation: the catch-up would have replayed the whole retired
  generation over that content. The build hook logs it and the build goes on; `npm run update` fails
  and says what to do ("The contract every applier honours" above). A database whose history is
  recorded sees no change. A project made with `npm create nextblock` whose history holds versions a
  squash retired is no longer told to run the monorepo's `db:migrate` scripts: leave those rows.

### 0.23.6 — Supabase Storage on your own domain, two scripts, two missing files, product stock, media usage

The first three are for projects made with `npm create nextblock`; monorepo installs (a fork, a
1-click deploy, a clone) get them through the merge. The last three concern every install.

- **Images from Supabase Storage on a domain other than `*.supabase.co`.** A project that keeps
  its media in native Supabase Storage (`STORAGE_PROVIDER=supabase`, or no `STORAGE_PROVIDER` and
  not both `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`) and sets no `NEXT_PUBLIC_R2_BASE_URL`
  serves its media from `<Supabase URL>/storage/v1/object/public/<bucket>`, and `next.config.js` let
  Next's image optimizer fetch from that host only on Supabase Cloud (`**.supabase.co`). On a
  self-hosted Supabase or a Supabase custom domain, every image served through the optimizer
  (`/_next/image`) answered 400 `"url" parameter is not allowed`. New projects allow that host, on
  the bucket's public path only, but `npm run update` never replaces `next.config.js`, so make one
  of these two changes, then rebuild and restart (`npm run build`, then `npm start`):
  - In `next.config.js`, find the block under `// Add R2 Custom Domain URL` in
    `getRemotePatterns()`, `if (process.env.NEXT_PUBLIC_R2_BASE_URL) { … }`, and replace its closing
    `}` with the branch below, as new projects have it. It calls `computeSupabaseMediaBaseUrl()`,
    which the same file defines and which returns nothing while both R2 keys are set, even with
    `STORAGE_PROVIDER=supabase`: the branch then adds no host. With both keys set, or if your file
    has no such function, use the variable below instead.

    ```js
      } else {
        // No explicit base: `env` inlines the native Supabase Storage endpoint as the media base,
        // so allow its host too, on the public bucket path only.
        const supabaseMediaBase = computeSupabaseMediaBaseUrl();
        if (supabaseMediaBase) {
          try {
            const parsed = new URL(supabaseMediaBase);
            patterns.push({
              protocol: parsed.protocol === 'https:' ? 'https' : 'http',
              hostname: parsed.hostname,
              pathname: `${parsed.pathname.replace(/\/+$/, '')}/**`,
            });
          } catch {
            // ignore a malformed Supabase URL
          }
        }
      }
    ```

  - Or set `NEXT_PUBLIC_R2_BASE_URL` to that address, for example
    `NEXT_PUBLIC_R2_BASE_URL=https://supabase.example.com/storage/v1/object/public/media` (the
    bucket is your `STORAGE_BUCKET`, else your `R2_BUCKET_NAME`, else `media`). This is the fix for
    `STORAGE_PROVIDER=supabase` with both R2 keys set. The block above already allows the host of an
    explicit base, and the app builds its media URLs on the same address as before. It allows the
    whole host, though, not only the bucket's public path, so the optimizer will also try any other
    URL on your Supabase domain it is asked for (it serves only images).

  A project on `*.supabase.co`, one on R2 or other S3 storage, and a Docker project (its setup sets
  `NEXT_PUBLIC_R2_BASE_URL`) need neither. A Supabase at a loopback or private address stays
  refused either way: Next's optimizer fetches from no local IP unless
  `images.dangerouslyAllowLocalIP` is set.
- **Delete two maintainer scripts.** `scripts/validate-editor-block-schema.ts` and
  `scripts/verify-custom-block-definitions.ts` are tools for the NextBlock repository, where they
  now live in `tools/scripts/`. In a project they import `../../../libs/utils/src/lib/editor-blocks`
  and `../../../schemas/custom-blocks`, paths outside it, so the project's own `tsc` reports a
  TS2307 (Cannot find module) for each; `next build` never stopped on them, since scaffolds set
  `typescript.ignoreBuildErrors`. Nothing in a project uses them, and `npm run update` never deletes
  a file, so delete both.
- **Projects scaffolded before 0.22.3: add `instrumentation.ts` and `.browserslistrc`.** Until 0.23.6
  the updater synced neither file, so a project scaffolded before one shipped (`instrumentation.ts`
  in 0.22.3, `.browserslistrc` in May 2026) has never had it, however often it updated. Without
  `instrumentation.ts`, the store's server actions (products, inventory, orders, coupons, shipping,
  payment settings) on a server instance that has not loaded a CMS page yet fall back to a stricter
  second-factor check, which refuses staff whose second factor is an email code or a remembered
  device. Without `.browserslistrc`, the build compiles for Next's default browsers (Chrome, Edge
  and Firefox 111, Safari 16.4) instead of NextBlock's list, which reaches back to Safari and iOS
  15.4 and Chrome 109. The update that reaches 0.23.6 still runs your previous updater, which skips
  both, and a plain `npm run update` on 0.23.6 finds the code current and syncs nothing. So, once on
  0.23.6, commit your work and run `npm run update -- --force` (in PowerShell,
  `node tools/update.mjs --force`): on a clean tree it merges 0.23.6 again, which adds the missing
  files and leaves the files you edited alone. Without git, or with uncommitted changes, it instead
  replaces every framework file that differs from 0.23.6 (it asks first, and keeps copies in
  `.nextblock-backup/`). Either way it then merges `package.json` again, as every update does: each
  third-party range the template lists (except a package you pin in `overrides`, which keeps your
  pin, unless the pin is a value an earlier NextBlock release wrote there, which moves to 0.23.6's)
  and each framework script (`dev`, `build`, `start`, …) is set to 0.23.6's, so a range or a
  framework script you changed after reaching 0.23.6 goes back. The log
  names each range it changes, but not the scripts, and no copy of `package.json` is kept: check
  `git diff package.json` before you commit, put back what you had changed, and run `npm install`
  (without git, note those changes before you run it). Or copy both files into the project root from
  the NextBlock repository's `apps/nextblock/` folder
  (<https://github.com/nextblock-cms/nextblock/blob/master/apps/nextblock/instrumentation.ts> and
  `.browserslistrc` beside it), which changes nothing else. The update to the next release adds them
  as well.
- **Migrations 02043, 02044 and 02045.** 02043 publishes a product draft in one transaction
  (`public.publish_product_draft`; variants keep their rows, and History now records prices, stock
  and variants too), 02044 is the stock rule and 02045 the media usage lookup below. They apply like
  any other migration ("Build-time migrations" above): `npm run update` applies them when it has a
  database connection ("Two backends" above), after copying them into `supabase/migrations` in a
  project made with `npm create nextblock` (a monorepo install gets them through the merge);
  otherwise the build hook does at the next production build. A Docker project applies them on
  `npm run docker:up`.
  - **Outside Docker, rebuild after the update or re-apply the grants.** The update that reaches
    0.23.6 runs your previous updater, which applies them with the grant pass of the release you came
    from (it loads that pass before its file sync or merge). That pass leaves `anon` able to call
    `publish_product_draft` and `product_revision_content`, and `anon` and `authenticated` able to
    call `media_usage`, until the 0.23.6 pass takes that back. So after `npm run update`, even when it
    applied them, rebuild or redeploy with the build hook on (`NEXTBLOCK_BUILD_MIGRATE=1` off Vercel),
    or run `npm run update -- --db-only` once (in PowerShell, `node tools/update.mjs --db-only`, or
    `node apps/nextblock/tools/update.mjs --db-only` in a monorepo): on 0.23.6 it re-applies the
    grants even with nothing pending. All three functions run with the caller's own rights, so
    nothing beyond the caller's own access is exposed, but each `media_usage` call reads every table
    the caller can see. From 0.23.6's updater on, an update runs a release's migrations with the
    engine and grant pass that release brings, so later releases need no such step.
  - **Until they are applied:** without 02043, publishing a product draft is refused with nothing
    written, Product History cannot compare a version with the product ("Failed to fetch current
    content."), and a live CMS import, Cortex AI or an MCP client that changes a product records no
    History for it; without 02045, the media library cannot say where files are used and lists none
    as unused.
  - **By hand:** an install that applies migrations itself (the monorepo's `npm run db:migrate`)
    runs `npm run db:migrate:check` first, confirms 02043 to 02045 are listed as pending, then runs
    `npm run db:migrate`.
- **A product publish writes only the stock the editor changed** (02044). Through 0.23.5,
  publishing a product form draft wrote back the stock its edit page had loaded, so a unit sold
  while the page was open was put back (and so was any other stock change made meanwhile). Now the
  draft records the stock the page loaded: a figure left alone stays as the store has it, and an
  edited one is applied as a change to the stock at publishing, never below 0 (loaded 5, typed 15,
  one sold meanwhile: 14), with a warning naming each such SKU whose stock had moved; if the
  editor's figure already counted that (a count made after the sale), correct the stock. A figure the
  store already shows is left alone, also when the edit was meant to come on top of what moved the
  stock (loaded 10, 9 typed for a damaged unit, one sold meanwhile: 9 stays, not 8), and the warning
  names each such SKU too: correct the stock then. The warning names the first five SKUs of each
  kind, then how many more. Reopening a draft shows the stock its publish would write, and a note
  above the form names, with the figures, each SKU it shows applied to a stock that moved or already
  live (the next autosave records the stock it loaded, after which a publish sees neither). A draft
  saved before the upgrade recorded no loaded stock, so its publish still writes the figures it
  holds (its edit page shows them), whatever was sold since: compare them with the Inventory screen
  before you publish one. A publish that changes the stock of hundreds of SKUs at once can still
  pass the database's 8 s statement timeout, in a large catalog or on a busy database (on local
  replays five hundred took about 5 s beside 50 other products, up to 9 s on a busy machine, and 9
  to 13 s beside 2,000); it then fails with nothing written, and the draft is kept.
- **The media library shows where each file is used** (02045). Deleting a file first shows where
  it is used (blocks, feature images, galleries, drafts, settings, logos, partner storefronts and
  more), linked to the screens that edit them, and the button reads "Delete anyway" when something
  uses it or the check failed. "Delete Selected" names the selected files in use and offers "Delete
  only the unused" or "Delete all". A new "Unused files" tab lists what nothing uses, with "Delete
  all N unused": a way to clear out the images that product publishes have only unlinked since
  0.23.4 (below). The media edit page shows "Where this file is used". Both unused deletes check
  each file again on the server and delete nothing when that check fails. "Delete all N unused"
  works in batches of 500 and stops at the first batch that fails, and the files of the batches
  before it stay deleted (the message says how many, then why it stopped, or only why when none
  were deleted before it). Drafts count as uses; a file only revisions name counts as unused
  (restoring such a revision then shows a missing image). The check cannot see a link from another
  site, a sent email or a cached social preview.

### 0.23.4 — Standalone builds, product drafts, Freemius keys, license recheck, CSP, uploads

- **Standalone builds work again.** A project made with `npm create nextblock` 0.23.0 to 0.23.3
  (cloud or Docker), or a standalone project that ran `npm run update` to one of those versions,
  fails `npm run build` and the Docker image build with `Module not found: Can't resolve 'vitest'`
  in `./app/cms/blocks/editors/SectionBlockEditor.test.tsx`. The CMS loaded its block editors with
  `` import(`../editors/${filename}`) ``, which Turbopack turns into a bundle of every file in that
  folder, this test (new in 0.23.0) and its `vitest` import included, and a standalone project does
  not install vitest. `npm run update` to 0.23.4 fixes it: it updates `EditableBlock.tsx` and
  `ColumnEditor.tsx` in `app/cms/blocks/components/` and adds `blockEditorLoaders.ts` beside them,
  which imports each editor by name. If you edited either file and the update reports a conflict
  there, keep the 0.23.4 side of the editor loading. If you added a block editor of your own in
  `app/cms/blocks/editors/` (docs/07), also give it a line in `BLOCK_EDITOR_LOADERS` in
  `blockEditorLoaders.ts`, such as `FaqBlockEditor: () => import('../editors/FaqBlockEditor'),`, or
  the CMS opens nothing for its block; a block of your own whose definition sets `EditorComponent`
  needs no line, because the CMS opens that component. Run `npm run update` once more after the
  update that reaches 0.23.4 (a standalone project does so for the `postcss` browser alias anyway,
  below): that run prints the line for each such editor it finds ("Block editors the CMS cannot
  open" above). Until you can update, deleting
  `app/cms/blocks/editors/SectionBlockEditor.test.tsx` also lets the build pass (nothing imports
  it; the next update brings it back, which is harmless from 0.23.4 on). Monorepo installs built,
  because vitest is a root devDependency there.
- **Check products published after a description-block or in-page edit (deploys of master from
  2026-05-22, npm 0.8.11 through 0.23.3).** In those versions the first change to a product's
  description blocks (adding, editing, moving or deleting one under Product Description Blocks, or
  editing one on the storefront) created the product's draft with a copy of the product row: prices
  in cents, the stock of that moment, no variants, gallery or sale window, and from 2026-05-27 no
  description. So did the first in-page edit of its title, short description or description.
  Publishing that draft, from the editor's draft bar, the visibility control when it also published
  pending edits, or the storefront toolbar, saved the copy as product form values:
  - Every price, sale price and currency price was multiplied by 100, and a Freemius product's sale
    coupon was pushed to Freemius from those prices.
  - Every variant was deleted with its stock and attribute options, and the product's stock and its
    SKU's shared inventory went back to the stock the draft was created with.
  - The description was cleared (a draft created before 2026-05-28 could set it back to its copy
    instead).
  - The sale window was cleared on the product and on every translation sharing its SKU, and those
    translations got the inflated sale prices.
  - The title, slug, short description, SKU and UPC, the taxable flag, the product type (and with it
    the payment provider), the SEO fields and the Freemius and trial settings went back to their
    values when the draft was created.
  - If the product form autosaved into the draft first (the editor showed the copy: prices 100 times
    too high, no variants, no gallery), the gallery was emptied too, and images no other product,
    post, logo or variant used were deleted from the media library; on R2 (or any S3 storage) their
    files were deleted too (on native Supabase Storage the files are still in the bucket). A page
    whose feature image was one of them lost its feature image, and image blocks, section
    backgrounds and the social image that used one kept a reference to it (a broken image where the
    files went). The queries below find most of them; text and testimonial blocks name an image by
    URL only, which no query finds.

  Only an administrator could publish such a draft: the product RPC refused anyone else. 0.23.4
  creates drafts without product values, completes a partial draft from the live product, and lets
  only an administrator past the second factor publish a product draft.

  Every such publish set the product's `updated_at`, and the app's later writes only move it
  forward (before 0.23.4 Cortex's raw database tools could set any value, and a write through the
  Data API or SQL still can), so the products to check are among those changed since 2026-05-21,
  the day drafts began copying the product row; the list also holds products changed in other ways.
  Publishes from 0.14.5 (2026-08-10) on also recorded a product revision (`has_revision`); earlier
  ones recorded none, because `product_revisions` did not exist yet:

  ```sql
  select p.id, p.title, p.slug, l.code as language, p.updated_at,
         exists (
           select 1 from product_revisions r
           where r.product_id = p.id and r.created_at >= '2026-05-21'
         ) as has_revision
  from products p
  join languages l on l.id = p.language_id
  where p.updated_at >= '2026-05-21'
  order by p.updated_at desc;
  ```

  Open each in CMS → Products and compare its prices in each currency, sale price and window,
  stock, variants and their stock, description, gallery, title, slug, short description, SKU and
  UPC, taxable flag, product type, SEO fields and Freemius and trial settings, and its translations'
  sale prices and windows, with what you expect, and the feature images of your pages. Correct them in the form and publish; for a Freemius product
  that pushes the sale coupon again. Restoring a product revision puts the title, slug, short
  description, description, SEO fields and description blocks back to that version, so restoring
  the version from before the bad publish brings the description back but also undoes every later
  change to those fields (later publishes, imports, Cortex edits; a slug change moves the public
  URL), and discards any open draft. Restore only when nothing changed since the bad publish, and
  otherwise re-enter the description by hand (every earlier recorded version stays restorable, but a
  change that recorded no version, such as Copy from language, the Freemius sync or a Data API or
  SQL write, is lost). A product damaged before 0.14.5 has no revision to restore, so
  re-enter its description as well. Prices, variants, stock, the gallery, deleted images
  and the sale window are in no revision: re-enter them, or take them from a database backup (on R2
  a database backup brings back media rows, not their files: upload the image again).

  To find what deleted images left behind (both queries only read): pages that lost their feature
  image, and blocks and the social image still naming a deleted media row. No version of a page
  whose content names a deleted feature image can be restored, which is every version since the
  image was set (the latest included, until the page is published again): the restore fails on the
  missing media row. Uploading the image again gives it a new id, so it does not help those
  versions; bringing the media row back with its original id from a database backup does. To fix
  the page itself, upload the image again and pick it in CMS → Pages; re-pick a block's or the
  social image's image in its editor. On native Supabase Storage the files are still in the bucket,
  so those blocks still display; only the media-library entry is gone.

  ```sql
  -- Pages whose revisions name a feature image whose media row is gone
  select distinct p.id, p.slug, refs.media_id
  from pages p
  join page_revisions r on r.page_id = p.id
  cross join lateral (
    select r.content #>> '{meta,feature_image_id}' as media_id
    where r.revision_type = 'snapshot'
    union all
    select op ->> 'value'
    from jsonb_array_elements(case when jsonb_typeof(r.content) = 'array' then r.content else '[]'::jsonb end) op
    where r.revision_type = 'diff' and op ->> 'path' = '/meta/feature_image_id'
  ) refs
  where p.feature_image_id is null
    and refs.media_id is not null
    and not exists (select 1 from media m where m.id::text = refs.media_id);

  -- Blocks (nested section columns and backgrounds included) and the social image naming a deleted media row
  select distinct b.id as block_id, b.block_type, b.page_id, b.post_id, b.product_id, j.media_id #>> '{}' as media_id
  from blocks b
  cross join lateral jsonb_path_query(b.content, 'lax $.**.media_id') as j(media_id)
  where jsonb_typeof(j.media_id) = 'string'
    and j.media_id #>> '{}' <> ''  -- an image background with no image picked stores ''
    and not exists (select 1 from media m where m.id::text = j.media_id #>> '{}');

  select s.value ->> 'media_id' as media_id, s.value ->> 'object_key' as object_key
  from site_settings s
  where s.key = 'site_social_image'
    and s.value ->> 'media_id' is not null
    and not exists (select 1 from media m where m.id::text = s.value ->> 'media_id');
  ```
- **Check sale windows and variant sale prices on products published from the form (npm 0.8.11
  through 0.23.3).** Until 0.23.4 the product form never loaded a product's sale window, so
  publishing a form draft in which the editor had not entered both dates cleared the window on the
  product and on every translation sharing its SKU (a date entered in that session was kept, the
  other cleared). A sale price without a window applies at all times: a scheduled sale went live at
  once and never ended, and an expired one came back. The old variations editor also rebuilt the
  variants when it opened and whenever the SKU or a base price changed: a variant without a sale
  price took the product's, with no window; a missing combination was added at the product's price
  with no stock, its currency amounts rounded to whole units. The first query above lists these
  products too (sale scheduling arrived on 2026-06-04): check the sale price and window of each,
  of its variants and of its translations, and enter windows again in the form or with the
  Promotions CSV.
- **Removing an image from a product's gallery no longer deletes it.** A product publish only unlinks
  the image: it stays in the media library with its files. Through 0.23.3 a publish deleted every
  image dropped from a gallery that no product, post, logo or variant used, even one a page block,
  a page's feature image or the social image still used (on R2 its files went too), and a WRITER's
  draft could choose what it deleted. Delete images you no longer need from CMS → Media once nothing
  uses them: that delete removes the image from every gallery, clears any page or post feature
  image, logo or variant image using it, removes its files, and leaves image blocks, section
  backgrounds, text and testimonial blocks and the social image pointing at a missing image. The
  media library showed no usage until 0.23.6 (above).
- **Check the categories of products you translated.** Since categories arrived (2026-05-26),
  "Create <language> Translation" opened the new product with no categories, and saving it removed
  the categories of every product in the translation group (categories are shared by the group).
  0.23.4 opens the translation with the group's categories. Assign any missing ones on one of the
  products and publish: the group gets them back.
- **Review product drafts saved before the upgrade.** A draft the product form autosaved over such
  a copy holds its prices 100 times too high (cents saved as dollars), the stock of the day the copy
  was made, and no variants, gallery or description (a copy made before 2026-05-28 could keep the
  description); variants the old editor rebuilt in it came from the inflated price, with no stock. A
  CMS import in draft mode wrote product values too, storing every column the file lacked as a blank
  or a default: a file without media, variant or description columns left an empty gallery, no
  variants and no description. 0.23.4 stamps the product-values drafts it writes (the form's
  autosave and a CMS import in draft mode: `form_version` in `product_drafts.meta`) and checks only
  unstamped ones, against the live product; stamped drafts are never checked. What the check reads
  (the exact rules are in docs/09 → "Product Drafts (`product_drafts`)"):
  - **An unstamped autosave** (the form always stored `variation_attributes`) reads as saved over a
    copy when an amount is a live amount in cents read as dollars (equal to it, or at least 20 times
    the live amount: the price, the sale price, a currency price that has cents, a variant's amounts
    against its live variant), when its price is one of the product's Freemius plan prices in cents,
    or when it has no variants for a physical product that has some, an empty gallery where the live
    product has one, or an empty description where the live product has one. Publishing it is
    refused, naming every group whose values differ from the live product: the prices and sale
    prices (always together), a physical product's variants, and its stock when the draft or the
    live product has no variants, the gallery when it leaves out a live image, and the description
    when it is empty where the live product has one. The product editor shows the live values for
    those groups (the stock beside repaired variants included), with a note above the form that
    names them and says the draft's other fields (title, slug, descriptions, SEO fields, categories,
    SKU and UPC, and the Freemius and trial settings) are a copy from when it was saved.
  - **An unstamped CMS draft import the old editor never saved** (no `variation_attributes`) is
    checked only for what that import left empty where the live product has it: an empty gallery,
    no variants for a physical product that has some, and a description it left out or left empty.
    Publishing it is refused for those and the product editor shows the live values for them, both
    saying what the import did; its prices stay the file's, and so does its stock unless the live
    variants are shown (the stock beside them is theirs). The other columns the file lacked are not
    checked and publish as the import stored them: blank (the short description, the SEO title and
    description, the UPC, the sale price, the currency price and sale-price maps, which leaves only
    the default currency's price, the Freemius product and plan ids, and the categories, which the
    product's translations lose too) or a default (no trial, taxable, and, without product type and
    payment provider columns, a physical product sold through Stripe). Its description blocks are
    the file's as well, so where the file gave none, publishing deletes the live ones. Check those
    before you publish.
  - **Limits.** The check can miss a copy. The amounts reveal one only while the live amount is
    above zero and at most five times what it was when the copy was made, and a variant the live
    product lacks reveals one only while the product's live price is unchanged or the draft's own
    price is the copy's in dollars. A Freemius product's plan prices reveal a copy whatever its
    price became, unless they changed too (a plan made free) or the plan price is above 5000, which
    the sync stores as cents. Currencies without cents (JPY, KRW, …) are left out of the amount
    checks, and so are the price and sale price (the product's and each variant's) and the plan
    prices of a product whose live row shows its default currency may be one of them (an amount
    without cents equal to the price or sale price of the product or of a variant). The check can
    also refuse a clean draft: an unstamped autosave the old editor saved over the live product is
    refused the same way when an amount is 20 times the live one for another reason (a price an
    editor raised 20-fold or more, a live price or sale price that fell to a twentieth or less
    since), when it adds a variant priced at the product's live amount in cents or at 100 times the
    draft's price (a $1.00 product with a new $100 variant), or when its variants, gallery or
    description were emptied on purpose: every group that differs then shows live, so enter that
    draft's changes again. So is a draft import the old editor autosaved: any edit there stored
    `variation_attributes` and kept the import's empty gallery, variants or description, so it
    reads as an autosave over a copy, its prices and stock show live too, and the note calls its
    other fields a copy: enter the file's values again.

  To list the unstamped product-values drafts (row copies left out; `form_autosave` is false for a
  CMS draft import the old editor never saved; `price_looks_x100` applies the 20-fold rule to the
  price alone, and is true for every form autosave (`form_autosave` true) on a store whose default
  currency has no cents; compare
  the draft and live stock, variant and image counts):

  ```sql
  select p.id, p.title, p.slug, d.created_at, d.updated_at,
         coalesce(jsonb_typeof(d.meta -> 'variation_attributes') = 'array', false) as form_autosave,
         case when jsonb_typeof(d.meta -> 'price') = 'number' and p.price > 0
              then (d.meta ->> 'price')::numeric * 100 >= 20 * p.price::numeric
         end as price_looks_x100,
         d.meta -> 'stock' as draft_stock,
         p.stock as live_stock,
         case when jsonb_typeof(d.meta -> 'variants') = 'array'
              then jsonb_array_length(d.meta -> 'variants')
         end as draft_variants,
         (select count(*) from product_variants v where v.product_id = p.id) as live_variants,
         case when jsonb_typeof(d.meta -> 'product_media') = 'array'
              then jsonb_array_length(d.meta -> 'product_media')
         end as draft_images,
         (select count(*) from product_media m where m.product_id = p.id) as live_images
  from product_drafts d
  join products p on p.id = d.product_id
  where not d.meta ? 'form_version'
    and not d.meta ? 'id'
    and (jsonb_typeof(d.meta -> 'sku') = 'string' or jsonb_typeof(d.meta -> 'price') = 'number')
  order by d.updated_at desc;
  ```

  Open each in CMS → Products, compare the shown values and the rest of the draft with the live
  product, enter again any change of that draft you still want in a group shown live, save a change
  (or discard the draft), then publish. Until then the in-page editor refuses to save into a draft
  that publishing refuses, with the same advice. It also refuses to empty the description of an
  unstamped product-values draft (an earlier version's form autosave or CMS import) when the live
  product has one, since publishing would then refuse the draft: clear that description in the CMS
  editor. Opening the form leaves out, without a notice, the variants that lost every term (their
  attribute or terms were deleted) and all but the first of variants left with the same terms; the
  next save and publish remove them from the product. A stored variant the form cannot repair (a
  sale price above its price, or terms this store does not have and no options, as in a draft
  import from another install) blocks every save, with the error on the status line, until it is
  fixed, a term toggle rebuilds the variants or the draft is discarded. A draft variant whose term
  was deleted after the draft was saved, and that kept its options, still saves, but the draft's
  publish then fails until a term toggle rebuilds the variants (docs/09 → "The product editor's
  autosave").

  A draft that a description-block or in-page edit created before the upgrade (the copy of the
  product row above, which the query leaves out) is no longer published as product values: it
  publishes its blocks, and its title and short description only if the product has not changed
  since the draft was created. The same holds for its description if the draft was created before
  2026-05-28; in a later draft the description can only be an in-page edit, and it publishes. The
  first time you edit one of those fields in the page after the upgrade, that edit publishes. The
  draft's other fields that would publish at that moment are kept: its title, its short description
  and a description from a draft created before 2026-05-28 still publish only while the product
  stays unchanged, and a later draft's description publishes. Those that would not publish are
  dropped. The product editor's note names the fields of such a draft that publishing would leave
  live, and so does publish's warning.
- **Fill in the Product ID** (CMS → Payments, or `FREEMIUS_PRODUCT_ID`) whenever the one-product
  fields hold a product's keys, a product outside your developer account included, or give that
  product a `FREEMIUS_CHECKOUT_PRODUCTS_JSON` entry. Bound keys work offline and while Freemius is
  slow or throttled. A one-product install that also set a Developer ID and left the Product ID
  empty now has Freemius confirm its keys first (one request per product, cached ten minutes; only
  an answer that names the product confirms them), and answers 503 at checkout and to webhooks
  while Freemius cannot answer.
- **Wrong developer keys now stop a one-product checkout.** With one product's keys, no Product ID
  and no JSON entry with a `publicKey`, a developer key pair Freemius refuses means no checkout
  opens and webhooks answer 503; CMS → Payments reads not ready ("Developer key pair Freemius
  accepts, or a Product ID"). Fix or clear the developer keys, or fill in the Product ID.
- **No more guessing.** Without a developer pair that reaches it, a product the Product ID does not
  name (a mistyped ID included) and that has no JSON entry, or whose JSON entry lacks a `publicKey`,
  now answers 503 at checkout and 401 to webhooks (503 while a configured developer pair is refused
  or cannot be asked) instead of using the one-product keys.
- **The developer pair may stay in the one-product env names** (`FREEMIUS_PUBLIC_KEY` /
  `FREEMIUS_SECRET_KEY`), where installs that ran Sync from Freemius kept it: it still works as
  the pair, but no longer opens checkouts or verifies webhooks as a product's keys, Product ID or
  not. So set no Product ID while it sits there: for the product a Product ID binds, the one gap
  is an instance that has not yet seen Freemius accept that pair (one started after a revocation,
  or one whose developer checks Freemius has not answered yet: a cold start during a throttle or
  an outage). To use those names for one product's keys (with its Product ID), first move the
  pair into the developer fields or `FREEMIUS_DEVELOPER_*`. A pair typed into the CMS one-product
  fields belongs in the developer fields above them; when the env names hold the same pair,
  removing the CMS copy is enough. After you rotate the developer pair, delete the old one from
  every field, the one-product names included: in CMS → Payments clear the public key fields that hold
  it, tick the remove box under each stored secret it fills (developer secret key, one-product
  secret key, API key) and save, then clear the env names that hold it. Each instance drops the
  removed values at its next Freemius request once its 60-second cache expires, giving each name
  back to the deployment's own value. Fill in both CMS one-product keys: a CMS public key over an
  env secret that is the developer secret counts as the pair.
- **Give every Freemius product you sell its own webhook listener**
  (`https://<your site>/api/webhooks/freemius`, all events). A delivery now verifies only with the
  secret of its own product (its `plugin_id`; an event without one answers 401). With the developer
  pair the app reads each product's secret from Freemius, so nothing is pasted per product; without
  it, each product needs its own keys (a `FREEMIUS_CHECKOUT_PRODUCTS_JSON` entry, or the one-product
  keys with its Product ID). A product with no listener gets no refund, dispute or renewal events.
- **Adopt the current webhook route.** A project that edited `app/api/webhooks/freemius/route.ts`,
  or upgraded the libraries without `npm run update`, keeps the 0.23.3 route, whose synchronous
  `verifyFreemiusWebhookSignature` cannot apply the key policy. The current route awaits
  `getFreemiusWebhookVerification`, answers 503 on `unverifiable` and passes the verified
  `productId` to every handler (docs/02 → "Webhook flow").
- **Older Freemius orders.** The handlers act only on orders of the verified product. An order that
  stores no `freemius_product_id` (placed before checkout stored it on 2026-05-07, or imported)
  counts only when every one of its items names a product carrying the verified Freemius Product
  ID, and that id is then written to the order. Otherwise its refunds, disputes and cancellations
  are skipped and logged with the order id: fill in the Freemius Product ID of the product it sold
  (CMS → Products), or the order's `freemius_product_id`, for later events to apply.
- **More CMS actions need the second factor.** Activating, deactivating and re-sending a license
  under Administration → Packages, replying to and moderating reviews and comments, the language
  settings, the email settings and "Send test email", connecting GitHub, deleting and moving media,
  sending product feedback, the staff upload routes (`/api/upload/proxy`,
  `/api/upload/presigned-url`, `/api/media/r2-presigned`, `/api/process-image` and
  `/api/media/record`: uploading to the media library or a custom block, processing an image,
  recording an upload), the Product Grid block's product picker
  (`/api/cms/ecommerce/product-picker`), the admin update check (`POST /api/cms/check-updates`),
  and Cortex AI's editor generation, SEO metadata, image alt text and widget builder
  (`/api/ai/generate-blocks`, `/api/ai/seo/metadata`, `/api/ai/seo/alt-text`,
  `/api/ai/cortex/build-widget`) now need a session past its enrolled second factor (who may act is
  unchanged). Otherwise they answer "Complete two-factor verification, then try again." (the
  routes with a 403). Two status codes moved with it: those four AI routes answer a request without
  a session with 401 (it was 403), and the update check answers a signed-in non-admin with 403 (it
  was 401). `/api/media/r2-presigned` also refuses, with a 400, a folder inside the
  partner upload namespaces (`affiliates/avatars/`, `affiliates/pages/`), like the other staff
  upload routes. `/api/process-image` and `/api/media/record` accept only a key made of the
  characters the upload routes mint (`[A-Za-z0-9._/-]`: no `%`, space, `?` or `#`) that ends in a
  media extension the upload routes allow, and answer 400 to any other (`/api/media/record` checks
  `r2OriginalKey` too, even when it records a variant as the primary), so code of your own that
  calls them passes the key the upload route returned. The checkout success page shows staff an
  order only for an ADMIN past it; any other signed-in account sees only its own orders there.
- **The license recheck now runs from public pages.** The root layout starts it after the response
  (`after()`): each process sweeps at most once every 10 minutes and asks Freemius about each
  activated package at most once a day, so a store gets past its renewal date while nobody opens
  the CMS. Its first sweep switches off packages whose licenses Freemius has already cancelled or
  expired, after a 10-day renewal grace for a paid license; a trial ends on its end date. A JSON 4xx
  saying the key or license is gone (`not_found`, `invalid_license*`, `license_expired`, …) also
  counts as definitive; network errors, 5xx and 429 never do. Before you upgrade, check each
  install's activated keys (Administration → Packages) against Freemius, and renew any that lapsed.
  On the vendor side, check first that lapsed licenses block features: the sweep reads each
  license's own `is_block_features` (Freemius sets it from the plan's "block features at expiry"
  setting and allows per-license overrides), so check existing licenses (the Licenses list or the
  API) for `is_block_features: false` as well as each plan's setting. A license with it off keeps
  its package for good once it lapses; with it on the sweep ends it after the grace (docs/08 →
  "Trial expiry is enforced on the buyer's CMS").
- **The CSP's `script-src` carries `'strict-dynamic'`.** A CSP3 browser runs a script only when it
  carries the layout's nonce (`x-nonce`) or a nonce'd script inserted it at runtime. A
  `<script src>` written into the markup without the nonce no longer runs from any listed host, and
  a `document.write`'d script needs the nonce too: give your own scripts the nonce, as `SiteScripts`
  does, or load them with `next/script`. Scripts that a trusted script inserts at runtime now run
  from any host (GTM container tags, loaders inside consented custom scripts), but their fetch/XHR
  calls still need their host in `connect-src` (`proxy.ts`). Pages must stay dynamically rendered: a
  prerendered page has no nonce. Vercel injects its comments toolbar into preview deployments
  without the nonce, so CSP3 browsers block it there outside draft mode: set
  `NEXTBLOCK_VERCEL_TOOLBAR_ENABLED=true` on the Preview environment and the layout mounts it with
  the nonce (docs/04 → "The Content-Security-Policy backs the sanitizer up").
- **Authored HTML goes through an allowlist** (sanitize-html `^2.18.2`, now a dependency of
  `@nextblock-cms/utils`). Text blocks, product descriptions and custom-block rich text keep what
  the editor writes, but hand-written forms (task-list checkboxes aside), iframes other than YouTube
  and Vimeo players, the `name` / `form` / `for` attributes, SVG `foreignObject` / `use` / animation,
  MathML, comments and `data-` / `aria-` attributes whose names the HTML spec forbids are dropped
  when the page renders. Rebuild a hand-written form as a form block. Client bundles resolve
  `postcss` to the empty `lib/browser-stubs/postcss.cjs` through a `turbopack.resolveAlias` entry
  in `next.config.js`; without it they ship about 18 KB gzipped of postcss the sanitizer never
  calls, and nothing fails (docs/04 → "Authored HTML renders through `sanitizeAuthoredBlockHtml`").
  On a project made with `npm create nextblock` (cloud or Docker), run `npm run update` once more
  after the update that reaches 0.23.4: that update still runs your previous updater, which never
  edits `next.config.js`, and the second run adds the entry ("The `postcss` browser alias" above)
  or prints it for you to add under `turbopack.resolveAlias`:
  `postcss: { browser: './lib/browser-stubs/postcss.cjs' },`. A project that picked up the 0.23.4
  libraries without `npm run update` (a Docker image rebuilt without a lockfile) needs the update,
  then that second run. Monorepo installs get the entry through the merge; if you edited
  `next.config.js`, check that the merge kept it.
- **Client code imports utils through deep subpaths.** Since 0.23.4 the authored-HTML sanitizer
  that the `@nextblock-cms/utils` barrel re-exports runs on sanitize-html (about 39 KB gzipped), so
  a client component that imports the barrel puts it and Zod into every page that renders it.
  Through 0.23.3 the root layout's barrel imports put Zod on every page. In 0.23.4 the app, the ui
  primitives and the storefront and partner components import the module instead: Zod reaches a
  public page only with the in-page visual editor, and the sanitizer only with that editor and in
  the lazy chunks of the featured_product and product_details blocks (the product page renders the
  latter), whose `ShortDescription` and `SimpleTiptapRenderer` sanitize in the browser (docs/05 →
  "Public Page Performance Budget"). Do the same in your own client code
  (`@nextblock-cms/utils/utils` for `cn`, `/translations-context` for `useTranslations`). A test
  that mocked the barrel's `useTranslations` for an app component now mocks
  `@nextblock-cms/utils/translations-context`.
- **Upload URLs bind the file.** On R2 and other S3-compatible storage, `/api/upload/presigned-url`
  and `/api/media/r2-presigned` now sign the declared size and type, so storage refuses any other,
  and no longer sign an empty-body checksum (storage that validates checksums refused those
  uploads). Code of your own that PUTs to these URLs sends exactly the `headers` the route
  returns. Native Supabase Storage signed upload URLs bind neither: set the `media` bucket's file
  size limit (25 MB) and, optionally, its allowed MIME types (docs/04 → "Upload URLs", docs/12 →
  "Bucket limits").
- **A "Cookie settings" button in the footer.** With the consent banner on (CMS → Settings →
  Privacy), the public footer shows a button that reopens the banner on the visitor's current
  choice, so consent can be changed or withdrawn later. Withdrawing a category the visitor had
  granted (analytics or marketing) tells Google's tags that consent is denied, expires Google's
  cookies (`_ga*`, `_gid`, `_gcl_*` and the rest, `_ga` and `_gid` even when only marketing is
  withdrawn) and reloads the page once; granting more never reloads. After the reload, GA, GTM and
  the consented custom scripts load only while analytics is granted. The app gates no tag on
  marketing and sets no Consent Mode default, so when marketing alone is withdrawn and analytics
  stays granted they load again, and a GTM container's advertising tags follow that container's
  own consent settings. Migration 02042 seeds its English and French copy. A project that replaced
  the footer of `components/AppShell.tsx` adds `CookieSettingsButton` itself; one that replaced
  `components/privacy/ConsentBanner.tsx` calls `withdrawConsent` (`lib/privacy/consent-withdrawal.ts`)
  when a granted category is refused.
- **New projects get the full `.env.example` and `.env.docker.example`.** Earlier
  `create-nextblock` packages left both out (npm packed the template by the app's `.gitignore`), so
  a project made with `npm create nextblock` got a short placeholder `.env.example` and no
  `.env.docker.example`, and `npm run update` never touches `.env*` files. For the variables this
  release documents (`FREEMIUS_DEVELOPER_PUBLIC_KEY` / `FREEMIUS_DEVELOPER_SECRET_KEY`,
  `NEXTBLOCK_VERCEL_TOOLBAR_ENABLED`), open the full file in the NextBlock repository,
  <https://github.com/nextblock-cms/nextblock/blob/master/.env.example>, and copy what you need.
- **Migrations 02041 and 02042.** 02041 lets no API role write `site_settings.is_admin_created`, the
  flag behind the `/setup` gate (it locked the public sandbox on `/setup`); 02042 is the copy above.
  They apply like any other migration ("Build-time migrations" above). An install that applies
  migrations by hand (the monorepo's `npm run db:migrate`) runs `npm run db:migrate:check` first,
  confirms 02041 and 02042 are listed as pending (Supabase matches history by version only and
  skips a reused version in silence), then runs `npm run db:migrate`. Nothing else to do unless
  your own code wrote that flag through the Data API: write it with the service role.
- **Vendor routes and the CLI.** On the deployment that sells the packages
  (`NEXTBLOCK_LICENSE_CLAIM_ENABLED=true`), `POST /api/packages/provision-trial` now mints Cortex AI
  trials only (any other package answers 400 `UNKNOWN_PACKAGE`); it and
  `POST /api/packages/claim-license` answer 404 on the public sandbox and are limited per client
  network and per instance; and a Freemius 401/403 to the vendor's own keys logs
  `[Freemius] Configuration error: …` at most once a minute per credential and product instead of
  reading as a missing license. `create-nextblock --non-interactive` now honours
  `NEXTBLOCK_TRIAL=false` (commander's default for `--no-trial` used to hide it).

---

## Quick reference

| You want… | Do this |
| :--- | :--- |
| To update **any** install | `npm run update` |
| To see what would change first | `npm run update -- --check` |
| To know what a release asks of you after updating | "Upgrade notes" above (0.23.7: a read-only query, run before the update, that lists the SKUs whose stock migration 02046's backfill lowers, then the Inventory screen, and the 0.23.6 grant step when coming from 0.23.5 or earlier; 0.23.6: Supabase Storage images on a domain other than `*.supabase.co` (a `next.config.js` edit or one `.env` value), two monorepo scripts to delete, `npm run update -- --force` once for projects scaffolded before 0.22.3 (then check `package.json`), a rebuild or `npm run update -- --db-only` after the update that applies migrations 02043 to 02045, and a stock check of product drafts saved before the upgrade; 0.23.4: standalone builds that failed on `vitest`, the check of products published after a description-block or in-page edit (master from 2026-05-22, npm 0.8.11 through 0.23.3), the review of product drafts saved before the upgrade, the Freemius Product ID and webhook listeners, the license recheck, the `media` bucket limits, a second `npm run update` for the `postcss` browser alias, which also names block editors of your own that need a loader line). |
| Fully hands-off updates | Fork **public**, deploy on Vercel, **enable Actions** once. |
| To update a **Docker** install | `npm run update` then `npm run docker:up` |
| To apply only pending migrations, or re-apply the database grants | `npm run update -- --db-only` |
| Conflict banners on a **private** fork | Also set `NEXTBLOCK_GITHUB_TOKEN`. |
| To force an update check now | Dashboard (admin) → it polls in the background; or `POST /api/cms/check-updates`. |
| To resolve a sync conflict | Open the linked GitHub issue, merge upstream locally, fix, push, close the issue. |
| To undo an update | Standalone: `git reset --hard HEAD` (or restore from `.nextblock-backup/` if the fallback ran). Git-backed: `git revert`. |
| To keep your edits to a framework file | Commit before updating — the merge preserves them and conflicts only on real overlaps. |
