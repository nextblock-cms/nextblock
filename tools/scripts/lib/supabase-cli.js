'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Every Supabase CLI command the monorepo's database scripts run, built in one place with an
 * explicit target, plus the parser and the target guard for `supabase migration list`.
 *
 * Supabase CLI 3 points `migration list`, `migration repair`, `db push` and `gen types` at the LOCAL
 * stack unless `--remote` is passed, and never falls back between local and remote. A script that
 * left the target implicit would read or write whatever database the local default resolves to
 * (on a machine with a local stack up, a real one) while printing the production project's ref. So
 * each builder below names the project as `--remote=<ref>`: always the `=` form, because a bare
 * `--remote` followed by an operand (`migration repair 02005 --remote ...`) is ambiguous to the CLI,
 * and always a validated 20-letter ref, because CLI 3 looks any other value up as a BRANCH NAME of
 * whatever project the directory happens to be linked to.
 *
 * `--password` stays on every database command. Without one, CLI 3 mints a temporary login role
 * through the Management API (`read_only: false`); with a non-empty one it never does
 * (apps/cli/src/command-internal/db-config.layer.ts in the CLI). So an empty password is refused
 * here rather than passed through.
 *
 * `npm run db:migrate:check` runs exactly one of these: `migrationListArgs`. It is read-only by
 * construction (AGENTS.md; docs/04 → "Why `db:migrate:check` is read-only"):
 * push-db-migrations.test.ts pins its argv and the whole call sequence of the check path.
 */

/** A Supabase project ref: exactly 20 lowercase letters (the CLI's PROJECT_REF_PATTERN). */
const PROJECT_REF_RE = /^[a-z]{20}$/;

function assertProjectRef(ref, source = 'SUPABASE_PROJECT_ID') {
  if (typeof ref !== 'string' || !PROJECT_REF_RE.test(ref)) {
    throw new Error(
      `${source} must be a Supabase project ref: exactly 20 lowercase letters (got ${
        typeof ref === 'string' && ref.length > 0 ? `${ref.length} characters` : 'nothing'
      }). The Supabase CLI looks any other value up as a branch name of the linked project.`,
    );
  }
  return ref;
}

function assertPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error(
      'A database password is required. Without one the Supabase CLI mints a temporary login role through the Management API instead.',
    );
  }
  return password;
}

function assertWorkdir(workdir) {
  if (typeof workdir !== 'string' || workdir.length === 0) {
    throw new Error('A --workdir is required: the CLI otherwise searches upward from the current directory.');
  }
  return workdir;
}

/** `--remote=<ref>`: the one target form the scripts use. */
function remoteFlag(projectRef) {
  return `--remote=${assertProjectRef(projectRef)}`;
}

/**
 * `supabase migration list` against the project, as JSON. A pure read: the CLI marks it
 * "no consent", so it takes no `--yes`, and its JSON carries the `target` it actually read, which
 * `assertMigrationListTarget` checks.
 */
function migrationListArgs({ workdir, projectRef, password }) {
  return [
    'migration',
    'list',
    '--workdir',
    assertWorkdir(workdir),
    remoteFlag(projectRef),
    '--password',
    assertPassword(password),
    '--output-format',
    'json',
  ];
}

/**
 * `supabase link`. CLI 3 ignores `--password` here (and warns), never connects to the database,
 * and has no `--remote`: the ref is its target. It writes only `<workdir>/supabase/.temp/`.
 */
function linkArgs({ workdir, projectRef }) {
  return ['link', '--project-ref', assertProjectRef(projectRef), '--workdir', assertWorkdir(workdir)];
}

/** `supabase db push` to the project. `--yes` is the consent CLI 3 requires for a hosted write. */
function dbPushArgs({ workdir, projectRef, password }) {
  return [
    'db',
    'push',
    '--workdir',
    assertWorkdir(workdir),
    remoteFlag(projectRef),
    '--password',
    assertPassword(password),
    '--yes',
  ];
}

/** `supabase migration repair <versions> --status <status>` on the project's history table. */
function migrationRepairArgs({ versions, status, workdir, projectRef, password }) {
  if (!Array.isArray(versions) || versions.length === 0 || !versions.every((v) => /^\d+$/.test(v))) {
    throw new Error('migration repair needs at least one numeric version.');
  }
  if (status !== 'applied' && status !== 'reverted') {
    throw new Error('migration repair --status must be "applied" or "reverted".');
  }
  return [
    'migration',
    'repair',
    ...versions,
    '--status',
    status,
    '--workdir',
    assertWorkdir(workdir),
    remoteFlag(projectRef),
    '--password',
    assertPassword(password),
    '--yes',
  ];
}

/**
 * `supabase config push` to the project. A hosted-only command: with no `--remote` it would pick
 * SUPABASE_PROJECT_ID, then the link file; `--remote=<ref>` names the same project outright. CLI 3
 * also pushes any `SUPABASE_<PATH>` override set in the environment (docs/04 → "Supabase CLI 3").
 */
function configPushArgs({ workdir, projectRef }) {
  return ['config', 'push', '--workdir', assertWorkdir(workdir), remoteFlag(projectRef), '--yes'];
}

/**
 * `supabase gen types` for the project's `public` schema. No `--workdir` on purpose: with no link
 * in the current directory the CLI generates through the Management API, exactly as CLI 2's
 * `--project-id` did (in a linked workdir with a database password it would read the database
 * directly instead). Stdout is the TypeScript; the CLI's `Target:` line goes to stderr.
 */
function genTypesArgs({ projectRef, schema = 'public' }) {
  return ['gen', 'types', '--lang', 'typescript', '--schema', schema, remoteFlag(projectRef)];
}

/**
 * How to start the installed Supabase CLI with no shell: `{ command, prefix }`, run as
 * `spawnSync(command, [...prefix, ...args])` (never with `shell: true`).
 *
 * The `supabase` package's bin is a Node script in 2.117+ and 3.x (`dist/supabase.js`, which finds
 * the platform binary and starts it), so it runs under this Node; a package whose bin is the binary
 * itself has it started directly. Never `npx.cmd`: on Windows a `.cmd` file only starts with
 * `shell: true`, and cmd.exe then gets the arguments joined without escaping, the database password
 * included, so a password holding `&`, `|`, `<`, `>`, `^`, `%` or `"` breaks the command or runs part
 * of it as another one (Node 24+ warns: DEP0190). supabase-cli.test.ts holds the database scripts
 * to this.
 */
function supabaseCliInvocation({
  from = process.cwd(),
  resolvePackageJson = (dir) => require.resolve('supabase/package.json', { paths: [dir] }),
  readFile = (file) => fs.readFileSync(file, 'utf8'),
  exists = fs.existsSync,
  platform = process.platform,
  nodePath = process.execPath,
} = {}) {
  let packageJsonPath;
  try {
    packageJsonPath = resolvePackageJson(from);
  } catch {
    throw new Error('The Supabase CLI is not installed (no `supabase` package). Run `npm ci` first.');
  }
  const manifest = JSON.parse(readFile(packageJsonPath));
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin && manifest.bin.supabase;
  if (typeof bin !== 'string' || bin.length === 0) {
    throw new Error(`The installed supabase package (${manifest.version || 'unknown version'}) has no \`supabase\` bin.`);
  }
  const binPath = path.resolve(path.dirname(packageJsonPath), bin);
  if (/\.[cm]?js$/i.test(binPath)) {
    return { command: nodePath, prefix: [binPath] };
  }
  // The binary itself (a package whose postinstall downloaded it). Windows starts only a path with
  // its extension when no shell is involved.
  if (platform === 'win32' && !/\.exe$/i.test(binPath) && exists(`${binPath}.exe`)) {
    return { command: `${binPath}.exe`, prefix: [] };
  }
  return { command: binPath, prefix: [] };
}

/**
 * A Supabase CLI older than 3.0 refuses the flags these builders pass. Say "run npm ci" instead of
 * leaving the CLI's usage text as the only clue.
 */
function isStaleCliRefusal(output) {
  return /unknown flag: --(remote|output-format)/i.test(output || '');
}

/**
 * The reason in CLI 3's JSON error envelope (`{"target":{...},"_tag":"Error","error":{"code",
 * "message","suggestion"}}`, printed on stdout under `--output-format json`), or null. The CLI
 * never puts credentials in it.
 */
function describeCliError(output) {
  for (const line of String(output || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const error = parsed && parsed.error;
    if (!error || typeof error !== 'object' || typeof error.message !== 'string') continue;
    const code = typeof error.code === 'string' ? `${error.code}: ` : '';
    const suggestion = typeof error.suggestion === 'string' ? ` ${error.suggestion}` : '';
    return `${code}${error.message}${suggestion}`;
  }
  return null;
}

// --------------------------------------------------------------------------------------------
// `supabase migration list` output
// --------------------------------------------------------------------------------------------

// A version is any run of digits: the legacy generation-1 files were 14-digit, the
// GGNNN scheme is 5-digit, and the remote history can hold both at once during a squash.
const VERSION_PATTERN = /^\d+$/;

/** Column delimiters the CLI has shipped: ASCII pipe, and box-drawing verticals. */
const COLUMN_SPLIT = /[|│┃]/;

/**
 * CLI 2.109+ wraps every text-table cell in backticks (`02005`) and renders a blank cell as
 * a backticked space, so the backticks are stripped before a cell is compared.
 */
function splitRow(line) {
  return line.split(COLUMN_SPLIT).map((cell) => cell.trim().replace(/^`+|`+$/g, '').trim());
}

function classifyVersions(rows) {
  const pending = [];
  const applied = [];
  const remoteOnly = [];

  for (const { local, remote } of rows) {
    const hasLocal = VERSION_PATTERN.test(local);
    const hasRemote = VERSION_PATTERN.test(remote);

    if (hasLocal && hasRemote) {
      applied.push(local);
    } else if (hasLocal) {
      pending.push(local);
    } else if (hasRemote) {
      remoteOnly.push(remote);
    }
  }

  return { applied, pending, remoteOnly };
}

/** The JSON `target` object, kept only when it has the shape CLI 3 documents. */
function readTarget(value) {
  if (!value || typeof value !== 'object' || typeof value.kind !== 'string') {
    return null;
  }
  const target = { kind: value.kind };
  for (const key of ['project_ref', 'environment', 'host', 'port']) {
    if (value[key] !== undefined) target[key] = value[key];
  }
  return target;
}

/**
 * The JSON form of `supabase migration list`: one line on stdout,
 * `{"migrations":[{"local":"02000","remote":"02000","time":"02000"}, ...],"message":"...","target":{...}}`.
 * CLI 3 adds `target`, the database it actually read: `{"kind":"linked","project_ref":"<ref>",...}`
 * for a project, `{"kind":"local",...}` for the local stack, `{"kind":"db-url",...}` for a URL. The
 * keys stay `local` / `remote` whichever database was read, so only `target` tells a local history
 * from a remote one. Stderr lines such as "Target: project <ref>" are appended to the captured
 * output, so each line is parsed on its own. An empty local or remote value marks a pending file or
 * a remote-only version, as in the table.
 *
 * Returns null when no line holds a `migrations` array.
 */
function parseMigrationListJson(lines) {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) {
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (!parsed || !Array.isArray(parsed.migrations)) {
      continue;
    }

    return {
      ...classifyVersions(
        parsed.migrations.map((entry) => ({
          local: entry && entry.local != null ? String(entry.local).trim() : '',
          remote: entry && entry.remote != null ? String(entry.remote).trim() : '',
        })),
      ),
      target: readTarget(parsed.target),
    };
  }

  return null;
}

/**
 * Parse `supabase migration list` into local/remote sets plus the database it read.
 *
 * The JSON form (see parseMigrationListJson) is tried first. Otherwise the output is a
 * three-column table (Local | Remote | Time). A row with only a Local value is a migration
 * file that has never been applied; a row with only a Remote value is a history entry with
 * no file behind it. CLI 2.109+ wraps each table cell in backticks; splitRow strips them.
 * CLI 3 heads the database column `Local DB` when it read the local stack: that table parses with
 * `target: { kind: 'local' }`, and a `Remote` column with `target: { kind: 'remote' }` (no ref).
 *
 * Column positions come from the header row rather than from fixed indices 0 and 1. A table
 * rendered with an outer delimiter ("| 02005 | | |") shifts every cell by one, which would
 * classify each pending local migration as a retired remote version — and a retired version
 * is what `--reconcile-squash` reverts. Reading the header keeps the two columns identified
 * however the table is drawn.
 *
 * Returns NULL when neither a JSON `migrations` list nor a table header row is recognised.
 * Callers must treat that as a failed read and never as an empty history: "nothing parsed" and
 * "the database has no migrations" call for opposite actions, and conflating them makes this
 * command affirmatively lie about the database when the CLI changes its output.
 */
function parseMigrationList(output) {
  const lines = String(output || '').split('\n');

  const fromJson = parseMigrationListJson(lines);
  if (fromJson) {
    return fromJson;
  }

  let localIndex = -1;
  let remoteIndex = -1;
  let headerLine = -1;
  let target = null;

  for (let i = 0; i < lines.length; i += 1) {
    if (!COLUMN_SPLIT.test(lines[i])) {
      continue;
    }
    const cells = splitRow(lines[i]).map((cell) => cell.toLowerCase());
    const local = cells.indexOf('local');
    const remote = cells.indexOf('remote');
    const localDb = cells.indexOf('local db');
    if (local !== -1 && (remote !== -1 || localDb !== -1)) {
      localIndex = local;
      remoteIndex = remote !== -1 ? remote : localDb;
      target = { kind: remote !== -1 ? 'remote' : 'local' };
      headerLine = i;
      break;
    }
  }

  if (headerLine === -1) {
    return null;
  }

  const rows = [];

  for (let i = headerLine + 1; i < lines.length; i += 1) {
    if (!COLUMN_SPLIT.test(lines[i])) {
      continue;
    }

    const cells = splitRow(lines[i]);
    rows.push({ local: cells[localIndex] || '', remote: cells[remoteIndex] || '' });
  }

  return { ...classifyVersions(rows), target };
}

/**
 * Refuse a history that is not the project's: returns null when `status.target` is the project
 * `projectRef` names, otherwise the reason. A missing target counts as a refusal, because the
 * scripts always ask for JSON and CLI 3's JSON always names its target: without one there is no
 * telling a local read from a remote one (see parseMigrationListJson).
 */
function migrationListTargetProblem(status, projectRef) {
  const target = status && status.target;
  if (!target) {
    return 'The Supabase CLI did not say which database it read (no `target` in its output).';
  }
  if (target.kind === 'local') {
    return 'The Supabase CLI read the LOCAL database, not the remote project.';
  }
  if (target.kind !== 'linked') {
    return `The Supabase CLI read a ${target.kind} target, not the project ${projectRef}.`;
  }
  if (target.project_ref !== projectRef) {
    return `The Supabase CLI read project ${target.project_ref || '(unnamed)'}, not ${projectRef}.`;
  }
  return null;
}

module.exports = {
  PROJECT_REF_RE,
  assertProjectRef,
  configPushArgs,
  dbPushArgs,
  describeCliError,
  genTypesArgs,
  isStaleCliRefusal,
  linkArgs,
  migrationListArgs,
  migrationListTargetProblem,
  migrationRepairArgs,
  parseMigrationList,
  remoteFlag,
  supabaseCliInvocation,
};
