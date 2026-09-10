# NextBlock Agent Notes

## Production Migration Rule

NextBlock has launched against real Supabase data. Future schema and data
changes must be append-only, forward-only, and non-destructive by default.

> **Squash generations (since 2026-09-10).** Migration files are named `GGNNN_name.sql`:
> GG = squash generation (two digits), NNN = sequence inside it (three digits, contiguous from
> `000`). The folder holds exactly one generation. Its first five slots are fixed —
> `GG000_catchup_gen<G-1>` (replays the retired generation, version-aware, and runs FIRST so a
> database that sat behind reaches the end of that generation before the baseline touches it),
> `GG001_baseline_schema`, `GG002_baseline_constraints_and_indexes`,
> `GG003_baseline_security_and_grants`, `GG004_baseline_seed` (runs on EMPTY databases only)
> — and `GG005` onward are ordinary forward migrations. Generation 2 (current) was built on 2026-09-10 from the
> retired 14-digit generation-1 files `00000000000000`–`00000000000042`; generation 1 was itself
> the 2026-07 squash of the original 45 files. Every live database created before a squash still
> carries the retired versions in its history; that is expected, and
> `npm run db:migrate:repair-history -- --reconcile-squash` records the squash there without
> running SQL. **Do not squash casually** — the runbook in `docs/04` ("Squashing migrations")
> is the only supported way, and it always ships a catch-up because downstream installs exist.
>
> **Never trust a hardcoded "next migration is N" — list `libs/db/src/supabase/migrations`
> and take the highest sequence on disk + 1, in the same generation.** `npm run db:migrate:check`
> prints that number and refuses to run on a file that does not match the scheme (the Supabase
> CLI silently skips anything that is not `<digits>_name.sql`, and a wrong width sorts into the
> wrong place). Never use timestamps.
>
> Then confirm that number is actually free: `npm run db:migrate:check` prints the
> pending list and flags versions recorded remotely with no local file. **Supabase
> matches history by version only, never by content**, so a file reusing a recorded
> version is skipped in total silence. If you write a migration and the check says
> `Pending: 0`, your file will never run — renumber it.

- Do not rewrite, squash, reorder, delete, or recycle existing migration files
  once they may have been applied to any shared or production database.
- `npm run db:migrate:check` is read-only *by construction* — it runs only
  `supabase migration list`. It used to run `supabase link --yes` plus
  `db push --dry-run`, and on 2026-08-10 that applied a migration to production
  while printing "No database changes were applied". Do not reintroduce either
  call on the check path; see `docs/04` → "Why `db:migrate:check` is read-only".
- Add a new migration file under `libs/db/src/supabase/migrations` for each
  production schema/data change.
- Never use `db:reset`, `sandbox:reset`, `db:push:sandbox`, or a fresh baseline
  replay on production or any database containing orders, users, payments, or
  customer data.
- Use `npm run db:migrate:check` before `npm run db:migrate`.
- If a live database reports old baseline migrations, including
  `00000000000000_baseline_schema.sql`, as pending, use
  `npm run db:migrate:repair-history:check`, then
  `npm run db:migrate:repair-history` (pass `--through=00000000000003` — the
  baseline's top file creates no tables, so auto-detection stops at `000`), then
  rerun `npm run db:migrate:check`. This marks already-present baseline migrations
  as applied; it does not run their SQL.
- Only use `npm run db:migrate:fresh` for a brand-new empty database.

For more detail, read `docs/04-DATABASE-AND-AUTH.md` and
`docs/05-DEVELOPER-GUIDE.md` before touching migrations.

## Git & Execution Boundaries

- **Never run `git commit` or `git push`**: The user handles all commits, pushes, and git history modifications.
- **Git operations requiring approval**: Commands that alter git history or worktree state (e.g., `git merge`, removing tracked files/branches) require explicit confirmation beforehand. Read-only commands (e.g., `git status`, `git diff`, `git log`) are permitted.
- **Execution mode**: Reversible file edits, refactoring, and code changes are in fast/direct mode ("yolo mode") since the user can revert changes.
- **Non-revertable operations require confirmation**: Any destructive or irreversible operation (e.g., dropping database tables, permanent data deletions, external/remote side effects) must be confirmed with the user prior to execution.

