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
npm run update -- --db-only # apply pending migrations only
```

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
and is versioned in lockstep with the app by `tools/scripts/release-cli.js`.

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
`index.d.ts`, `next-env.d.ts`, `postcss.config.js`, `eslint.config.mjs`, `Dockerfile`,
`docker-compose.yml`, `.dockerignore`, `AGENTS.md`, `CLAUDE.md`.

**Never touched**: `.env*`, `public/`, `README.md`, `.gitignore`, `.npmrc`, and the four
files the scaffolder generates per project — `next.config.js`, `tailwind.config.js`,
`tsconfig.json`, and `package.json` (which is **merged**, never replaced).

**It never deletes.** Files you added yourself survive; a file removed upstream is left in
place rather than pruned (`--diff-filter=ACMR`).

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
fail with `EOVERRIDE`.

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
GitHub Releases as a fallback and as the source of release-notes/archive links. npm is
authoritative because releases are cut by hand and have in practice sat several minor
versions behind the real version — which silently disabled this check entirely. Whichever
source is ahead wins.

Dismissing the banner is respected: the dedupe key is the *version*, not the unresolved
state, so a dismissed alert is not re-inserted on the next poll, while a genuinely newer
version still raises a fresh one.

### How the dashboard stays current (no cron)

The CMS refreshes update/conflict status **in the background after a dashboard page
loads** (throttled to ~6 hours), so it works on Vercel's Hobby plan without consuming a
cron slot. Admins can also force a check immediately:

```
POST /api/cms/check-updates      # admin-only; returns the version + conflict status
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

### Conflicts hold the schema back

If a standalone merge left conflicts, `npm run update` finishes the code and dependency
work — merged files, `npm install`, the refreshed migration SQL, the version stamp — and
then **stops before migrating**. The schema never moves ahead of code the developer has not
finished deciding on, and it stays untouched if they abandon the update entirely.

Resolving is the only extra step; there is no separate resume command. Re-running
`npm run update` sees the code is already current, skips straight to the schema step, and
applies the migrations. Before it does, it re-checks with
`git grep -lE '^<<<<<<< your version$'` and refuses while any marker remains — the label is
the one `mergeTemplates()` passes to `git merge-file`, so it cannot be confused with a
conflict from the developer's own git work, and it is anchored to the start of a line so
source that merely mentions the string does not trip it.

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

> **Edge case:** if your project's migration history is empty/inconsistent, the hook skips
> rather than risk misapplying. Run `npm run db:migrate:repair-history` then
> `npm run db:migrate` once to reconcile (see [docs/04](./04-DATABASE-AND-AUTH.md)).

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
`/setup` applying an incomplete schema. Treat the block above as one unit of work.

---

## Quick reference

| You want… | Do this |
| :--- | :--- |
| To update **any** install | `npm run update` |
| To see what would change first | `npm run update -- --check` |
| Fully hands-off updates | Fork **public**, deploy on Vercel, **enable Actions** once. |
| To update a **Docker** install | `npm run update` then `npm run docker:up` |
| To apply only pending migrations | `npm run update -- --db-only` |
| Conflict banners on a **private** fork | Also set `NEXTBLOCK_GITHUB_TOKEN`. |
| To force an update check now | Dashboard (admin) → it polls in the background; or `POST /api/cms/check-updates`. |
| To resolve a sync conflict | Open the linked GitHub issue, merge upstream locally, fix, push, close the issue. |
| To undo an update | Standalone: `git reset --hard HEAD` (or restore from `.nextblock-backup/` if the fallback ran). Git-backed: `git revert`. |
| To keep your edits to a framework file | Commit before updating — the merge preserves them and conflicts only on real overlaps. |
