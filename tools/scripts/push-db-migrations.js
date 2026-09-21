const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  dim: '\x1b[2m',
};

const repoRoot = path.resolve(__dirname, '../..');
const workdir = path.join(repoRoot, 'libs/db/src');
const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const args = new Set(process.argv.slice(2));
// File naming (GGNNN squash generations), the baseline/catch-up classification and the
// directory lint all live in one place so the CLI, the generators and the tests agree.
const {
  MIGRATION_FILE_RE,
  isBaselineMigration,
  validateMigrationNames,
} = require('./lib/migration-naming');

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function loadEnvFiles() {
  for (const envPath of [
    path.join(repoRoot, '.env.local'),
    path.join(repoRoot, '.env'),
  ]) {
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath, override: false, quiet: true });
    }
  }
}

function getDbPassword() {
  if (process.env.SUPABASE_DB_PASSWORD) {
    return process.env.SUPABASE_DB_PASSWORD;
  }

  if (process.env.POSTGRES_PASSWORD) {
    return process.env.POSTGRES_PASSWORD.replace(/^"(.*)"$/, '$1');
  }

  for (const key of ['POSTGRES_URL', 'DATABASE_URL']) {
    const value = process.env[key];
    if (!value) {
      continue;
    }

    try {
      const url = new URL(value);
      return decodeURIComponent(url.password);
    } catch {
      // Ignore malformed URLs; the missing env check will explain the issue.
    }
  }

  return null;
}

function requireEnv() {
  const missing = [];

  if (!process.env.SUPABASE_PROJECT_ID) {
    missing.push('SUPABASE_PROJECT_ID');
  }

  // Only the link step needs an access token, and the check path no longer links.
  const willLink = !args.has('--skip-link') && !args.has('--check') && !args.has('--dry-run');

  if (!process.env.SUPABASE_ACCESS_TOKEN && willLink) {
    missing.push('SUPABASE_ACCESS_TOKEN');
  }

  if (!getDbPassword()) {
    missing.push('SUPABASE_DB_PASSWORD, POSTGRES_PASSWORD, POSTGRES_URL, or DATABASE_URL');
  }

  if (missing.length > 0) {
    log(`Missing required environment variables: ${missing.join(', ')}`, colors.red);
    process.exit(1);
  }
}

function run(command, commandArgs, options = {}) {
  const { allowFailure = false, echoStdout = true, ...spawnOptions } = options;
  const printable = [command, ...commandArgs.map((arg) => {
    if (arg === getDbPassword()) {
      return '<db-password>';
    }
    return arg.includes(' ') ? `"${arg}"` : arg;
  })].join(' ');

  log(`Running: ${printable}`, colors.blue);
  const capture = options.capture === true;
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    env: process.env,
    shell: process.platform === 'win32',
    stdio: capture ? 'pipe' : 'inherit',
    encoding: capture ? 'utf8' : undefined,
    ...spawnOptions,
  });

  if (capture) {
    if (result.stdout && echoStdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
  }

  if (result.error) {
    if (allowFailure) {
      return { failed: true, output: '' };
    }
    log(result.error.message, colors.red);
    process.exit(1);
  }

  const output = `${result.stdout || ''}${result.stderr || ''}`;

  if (result.status !== 0) {
    if (allowFailure) {
      return { failed: true, output };
    }
    process.exit(result.status || 1);
  }

  return allowFailure ? { failed: false, output } : output;
}

function supabase(commandArgs, options = {}) {
  return run(npxBin, ['supabase', ...commandArgs], options);
}

function getMigrationVersion(fileName) {
  return fileName.split('_')[0];
}

function readLocalMigrationFiles() {
  const dir = path.join(workdir, 'supabase/migrations');

  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir)
    .filter((name) => MIGRATION_FILE_RE.test(name))
    .sort();
}

/**
 * Fail loudly on a badly named migration file before touching any database. The Supabase
 * CLI skips non-matching names in silence, and a wrong width would sort into the wrong
 * place, so this is the one check that has to run on every path.
 */
function assertMigrationNaming(localFiles) {
  const naming = validateMigrationNames(localFiles);
  if (naming.errors.length > 0) {
    log('Migration file names violate the GGNNN scheme (tools/scripts/lib/migration-naming.js):', colors.red);
    for (const error of naming.errors) {
      log(`  - ${error}`, colors.red);
    }
    process.exit(1);
  }
  log(
    `Migration generation ${String(naming.generation).padStart(2, '0')} on disk (${localFiles.length} files); the next new migration must be ${naming.next}_<name>.sql.`,
    colors.dim,
  );
  return naming;
}

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

/**
 * The JSON form of `supabase migration list`: one line on stdout,
 * `{"migrations":[{"local":"02000","remote":"02000","time":"02000"}, ...],"message":"..."}`,
 * printed for `--output-format json` and, from CLI 2.109, by default whenever the CLI detects
 * an AI agent (CLAUDECODE / AI_AGENT). Stderr lines such as "Connecting to remote database..."
 * are appended to the captured output, so each line is parsed on its own. An empty local or
 * remote value marks a pending file or a remote-only version, as in the table.
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

    return classifyVersions(
      parsed.migrations.map((entry) => ({
        local: entry && entry.local != null ? String(entry.local).trim() : '',
        remote: entry && entry.remote != null ? String(entry.remote).trim() : '',
      })),
    );
  }

  return null;
}

/**
 * Parse `supabase migration list` into local/remote sets.
 *
 * The JSON form (see parseMigrationListJson) is tried first. Otherwise the output is a
 * three-column table (Local | Remote | Time). A row with only a Local value is a migration
 * file that has never been applied; a row with only a Remote value is a history entry with
 * no file behind it. CLI 2.109+ wraps each table cell in backticks; splitRow strips them.
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
  const lines = output.split('\n');

  const fromJson = parseMigrationListJson(lines);
  if (fromJson) {
    return fromJson;
  }

  let localIndex = -1;
  let remoteIndex = -1;
  let headerLine = -1;

  for (let i = 0; i < lines.length; i += 1) {
    if (!COLUMN_SPLIT.test(lines[i])) {
      continue;
    }
    const cells = splitRow(lines[i]).map((cell) => cell.toLowerCase());
    const local = cells.indexOf('local');
    const remote = cells.indexOf('remote');
    if (local !== -1 && remote !== -1) {
      localIndex = local;
      remoteIndex = remote;
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

  return classifyVersions(rows);
}

/**
 * Ask the remote database which migrations it has already recorded.
 *
 * `supabase migration list` is a pure read. It deliberately replaces the older
 * `link` + `db push --dry-run` probe: `link` writes project state and, on 2026-08-10,
 * that probe applied migration 00000000000017 to production while printing
 * "DRY RUN: migrations will *not* be pushed". A command named `check` must not be
 * able to change anything, so the check path now runs only this.
 *
 * `--output-format json` (a global flag) pins the JSON form so a human terminal and an agent
 * session read the same thing. CLI 2.107 and 2.108 accept the flag but still print the text
 * table for this command, which parseMigrationList also reads.
 */
function readMigrationStatus(dbPassword, { allowFailure = false } = {}) {
  const result = supabase(
    ['migration', 'list', '--workdir', workdir, '--password', dbPassword, '--output-format', 'json'],
    { allowFailure, capture: true, echoStdout: false },
  );

  const output = allowFailure ? result.output : result;

  if (allowFailure && result.failed) {
    return null;
  }

  const status = parseMigrationList(output);

  if (!status) {
    // Printed on both paths: the command itself succeeded, so a missing link is not the cause.
    log('Could not recognise the output of `supabase migration list`.', colors.red);
    log(
      'Neither a JSON "migrations" list nor a "Local | Remote" header row was found, so the remote history was not read.',
      colors.yellow,
    );
    if (allowFailure) {
      return null;
    }
    log('Refusing to continue: an unreadable history must not be mistaken for an empty one.', colors.yellow);
    process.exit(1);
  }

  return status;
}

function describeVersion(version, localFiles) {
  const match = localFiles.find((file) => getMigrationVersion(file) === version);
  return match || `${version} (no local file)`;
}

function reportMigrationStatus(status, localFiles) {
  log('');

  if (status.pending.length === 0) {
    log('Pending migrations: 0 — the remote database already has every local migration.', colors.green);
  } else {
    log(`Pending migrations: ${status.pending.length}`, colors.yellow);
    for (const version of status.pending) {
      log(`  - ${describeVersion(version, localFiles)}`, colors.yellow);
    }
  }

  log(`Already applied: ${status.applied.length}`, colors.dim);

  if (status.remoteOnly.length > 0) {
    log('');
    log(
      `WARNING: ${status.remoteOnly.length} version(s) are recorded remotely with no local file:`,
      colors.red,
    );
    for (const version of status.remoteOnly) {
      log(`  - ${version}`, colors.red);
    }
    log(
      'A new migration file reusing one of those versions would be skipped silently.',
      colors.yellow,
    );
  }

  // Supabase matches history by version only and never by content, so a file whose
  // version is already recorded never runs — no error, no output, just silence.
  // Surfacing this is the whole point of printing the pending list.
  if (status.pending.length === 0 && localFiles.length > 0) {
    log('');
    log(
      'If you just added a migration and expected it here, its version is already in the remote history.',
      colors.yellow,
    );
    log(
      'Supabase matches migrations by version only (never by content), so that file will never run.',
      colors.yellow,
    );
    log('Renumber it above the highest recorded version and re-run this check.', colors.yellow);
  }
}

function main() {
  loadEnvFiles();
  requireEnv();

  const dbPassword = getDbPassword();
  const isCheck = args.has('--check') || args.has('--dry-run');
  const confirmed =
    args.has('--confirm') ||
    process.env.CI === 'true' ||
    process.env.CONFIRM_DB_MIGRATION === 'true';
  const allowBaselineReplay = args.has('--allow-baseline-replay');

  const localFiles = readLocalMigrationFiles();

  log(isCheck ? 'Supabase migration check (read-only)' : 'Supabase migration-only push', colors.green);
  assertMigrationNaming(localFiles);
  log(`Target project: ${process.env.SUPABASE_PROJECT_ID}`, colors.dim);
  log(
    isCheck
      ? 'This only reads the remote migration history. It links nothing, pushes nothing, and cannot change the database.'
      : 'This applies pending migration files only. It does not reset data, seed sandbox media, deploy functions, or push Supabase config.',
    colors.dim,
  );

  if (process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') {
    log(
      'NEXT_PUBLIC_IS_SANDBOX=true: you are targeting a sandbox-flavored environment.',
      colors.yellow,
    );
  }

  // The check path never links. `supabase link` writes project state, and it is one of
  // the two candidates for the 2026-08-10 incident where `--check` applied a migration
  // to production. Reading the history needs an existing link, so an unlinked repo is
  // told to link explicitly rather than having it done silently underneath a "check".
  if (isCheck) {
    const status = readMigrationStatus(dbPassword, { allowFailure: true });

    if (!status) {
      log('');
      log('Could not read the remote migration history.', colors.red);
      log(
        'If this project has never been linked, run `npx supabase link --project-ref <ref> --workdir libs/db/src` once.',
        colors.yellow,
      );
      log(
        'The check deliberately does not link for you, because linking changes local project state.',
        colors.yellow,
      );
      process.exit(1);
    }

    reportMigrationStatus(status, localFiles);
    log('');
    log('Check complete. Nothing was written — this ran a read-only history query.', colors.green);
    log('Apply the pending list above with `npm run db:migrate`.', colors.dim);
    return;
  }

  if (!args.has('--skip-link')) {
    supabase([
      'link',
      '--project-ref',
      process.env.SUPABASE_PROJECT_ID,
      '--password',
      dbPassword,
      '--workdir',
      workdir,
      '--yes',
    ]);
  }

  const pushArgs = [
    'db',
    'push',
    '--workdir',
    workdir,
    '--password',
    dbPassword,
    '--yes',
  ];

  // Compute the guard input from the history read rather than by regex-scraping
  // `db push --dry-run` output. Same reason as above, plus it is simply more reliable.
  const status = readMigrationStatus(dbPassword);
  reportMigrationStatus(status, localFiles);

  const pendingMigrations = status.pending.map((version) => describeVersion(version, localFiles));

  if (pendingMigrations.length === 0) {
    log('');
    log('Nothing to apply.', colors.green);
    return;
  }

  if (!confirmed) {
    log('');
    log('Refusing to apply migrations without --confirm.', colors.red);
    log('Run `npm run db:migrate:check` first, then `npm run db:migrate` when the pending list looks right.', colors.yellow);
    process.exit(1);
  }

  // The generation baseline (GG001..GG004) is idempotent DDL plus a seed that runs only on
  // an empty database, so replaying it on a live database is safe by design — that is how
  // an install crosses a squash. What is NOT safe is the catch-up (GG000) on a database
  // whose history was wiped: it decides what to replay from the recorded versions, and with
  // nothing recorded it would replay every retired migration. So refuse only when baseline
  // files are pending AND the remote history is completely empty: that is either a
  // brand-new database (db:migrate:fresh) or a live one that needs repair-history first.
  const pendingBaseline = pendingMigrations.filter(isBaselineMigration);
  const remoteHistoryEmpty = status.applied.length === 0 && status.remoteOnly.length === 0;

  if (pendingBaseline.length > 0 && remoteHistoryEmpty && !allowBaselineReplay) {
    log('Refusing to apply the baseline to a database with an empty migration history.', colors.red);
    log(
      `The pending list includes ${pendingBaseline.length} baseline file(s) and the remote history records nothing.`,
      colors.yellow,
    );
    log(
      'If this is an existing database whose history was wiped, repair it first with `npm run db:migrate:repair-history`.',
      colors.yellow,
    );
    log(
      'If this is a brand-new empty database, use `npm run db:migrate:fresh` instead.',
      colors.yellow,
    );
    process.exit(1);
  }

  // Refuse, do not merely warn. `supabase db push` hard-fails while retired versions remain,
  // so running it anyway buries this advice under a CLI stack trace and reads as "the tool is
  // broken". There is no legitimate push over a history the CLI rejects, so there is no
  // escape hatch here either — record the squash first.
  if (status.remoteOnly.length > 0) {
    log('');
    log(
      'The remote history holds versions with no local file (a migration squash retired them).',
      colors.red,
    );
    log(
      '`supabase db push` refuses to run while that is the case, so this command stops here.',
      colors.yellow,
    );
    log('Record the squash first — it reads the plan to you before changing anything:', colors.yellow);
    log('  npm run db:migrate:repair-history', colors.yellow);
    log(
      'It detects the retired versions and offers to switch to the squash reconcile. Then re-run this command.',
      colors.dim,
    );
    process.exit(1);
  }

  supabase(pushArgs);
  log('Database migrations applied without running a reset or sandbox seed.', colors.green);
}

// Pure helpers are exported for tests; `main()` runs only on direct execution so
// requiring this file never touches a database.
module.exports = { getMigrationVersion, isBaselineMigration, parseMigrationList };

if (require.main === module) {
  main();
}
