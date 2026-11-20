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
const args = new Set(process.argv.slice(2));
// File naming (GGNNN squash generations), the baseline/catch-up classification and the
// directory lint all live in one place so the CLI, the generators and the tests agree.
const {
  MIGRATION_FILE_RE,
  isBaselineMigration,
  validateMigrationNames,
} = require('./lib/migration-naming');
const { validateMigrationGrants } = require('./lib/migration-grants');
// Every Supabase CLI command below comes from one module, each with an explicit `--remote=<ref>`:
// CLI 3 targets the LOCAL stack when a script leaves the target out.
const {
  PROJECT_REF_RE,
  dbPushArgs,
  describeCliError,
  isStaleCliRefusal,
  linkArgs,
  migrationListArgs,
  migrationListTargetProblem,
  parseMigrationList,
  supabaseCliInvocation,
} = require('./lib/supabase-cli');

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
  } else if (!PROJECT_REF_RE.test(process.env.SUPABASE_PROJECT_ID)) {
    // The CLI would look any other value up as a branch name of the linked project.
    log('SUPABASE_PROJECT_ID must be the project ref: exactly 20 lowercase letters (Project Settings → General).', colors.red);
    process.exit(1);
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

/**
 * The environment the CLI runs with: this process's, minus `SUPABASE_YES`. A `SUPABASE_YES` that
 * dotenv copied in from `.env.local` would count as shell consent to CLI 3, and consent here is
 * only ever the explicit `--yes` on the one command that writes.
 */
function cliEnv() {
  const env = { ...process.env };
  delete env.SUPABASE_YES;
  return env;
}

/**
 * Runs a command with no shell (lib/supabase-cli.js → supabaseCliInvocation: cmd.exe would get the
 * database password unescaped). `shownAs` is what the log prints in place of the real argv.
 */
function run(command, commandArgs, options = {}) {
  const { allowFailure = false, echoStdout = true, shownAs, ...spawnOptions } = options;
  const printable = (shownAs || [command, ...commandArgs]).map((arg) => {
    if (arg === getDbPassword()) {
      return '<db-password>';
    }
    return arg.includes(' ') ? `"${arg}"` : arg;
  }).join(' ');

  log(`Running: ${printable}`, colors.blue);
  const capture = options.capture === true;
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    env: cliEnv(),
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
  let cli;
  try {
    cli = supabaseCliInvocation({ from: repoRoot });
  } catch (error) {
    log(error.message, colors.red);
    process.exit(1);
  }
  return run(cli.command, [...cli.prefix, ...commandArgs], { ...options, shownAs: ['supabase', ...commandArgs] });
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

/**
 * Refuse a forward migration that creates a table or sequence without granting on it
 * (tools/scripts/lib/migration-grants.js). Supabase grants nothing on new objects in `public`
 * (projects created since 2026-05-30, every project from 2026-10-30), so such a file would
 * ship an object the Data API cannot reach.
 */
function assertMigrationGrants(localFiles) {
  const dir = path.join(workdir, 'supabase/migrations');
  const grants = validateMigrationGrants(localFiles, (file) => fs.readFileSync(path.join(dir, file), 'utf8'));
  if (grants.errors.length > 0) {
    log('Forward migrations create objects without explicit grants (tools/scripts/lib/migration-grants.js):', colors.red);
    for (const error of grants.errors) {
      log(`  - ${error}`, colors.red);
    }
    process.exit(1);
  }
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
 * The argv comes from `migrationListArgs` (tools/scripts/lib/supabase-cli.js): `--remote=<ref>`
 * names the project, because Supabase CLI 3 reads the LOCAL stack when no target is given, and
 * `--output-format json` pins the form whose `target` says which database the CLI actually read.
 * A history whose target is not this project is refused (`migrationListTargetProblem`), so a local
 * read can never be reported as the production history. A CLI older than 3.0 rejects `--remote`
 * outright; that is reported as "run npm ci", never retried with an implicit target.
 *
 * `runSupabase(args, options)` is injectable so the tests can pin every CLI call the check path
 * makes. Returns `{ status }` or `{ error }`; it never exits.
 */
function readMigrationStatus({ projectRef, dbPassword, runSupabase = supabase }) {
  const result = runSupabase(migrationListArgs({ workdir, projectRef, password: dbPassword }), {
    allowFailure: true,
    capture: true,
    echoStdout: false,
  });

  if (result.failed) {
    if (isStaleCliRefusal(result.output)) {
      return {
        error: 'This Supabase CLI predates 3.0 (it has no --remote). Run `npm ci` to install the version package.json pins.',
      };
    }
    const reason = describeCliError(result.output);
    return { error: `The \`supabase migration list\` command failed${reason ? `: ${reason}` : '.'}` };
  }

  const status = parseMigrationList(result.output);

  if (!status) {
    // The command itself succeeded, so a missing link is not the cause.
    return {
      error:
        'Could not recognise the output of `supabase migration list`: no JSON "migrations" list and no "Local | Remote" header row, so the remote history was not read.',
    };
  }

  const targetProblem = migrationListTargetProblem(status, projectRef);
  if (targetProblem) {
    return { error: `${targetProblem} Refusing to report it as the history of ${projectRef}.` };
  }

  return { status };
}

/**
 * The whole `--check` path after the local file checks: one read-only `migration list`, nothing
 * else. Exported for push-db-migrations.test.ts, which runs it with a recording `runSupabase` and
 * pins the exact calls. Returns `{ status }` or `{ error }`.
 */
function runCheck({ projectRef, dbPassword, runSupabase = supabase }) {
  return readMigrationStatus({ projectRef, dbPassword, runSupabase });
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
  const projectRef = process.env.SUPABASE_PROJECT_ID;
  const isCheck = args.has('--check') || args.has('--dry-run');
  const confirmed =
    args.has('--confirm') ||
    process.env.CI === 'true' ||
    process.env.CONFIRM_DB_MIGRATION === 'true';
  const allowBaselineReplay = args.has('--allow-baseline-replay');

  const localFiles = readLocalMigrationFiles();

  log(isCheck ? 'Supabase migration check (read-only)' : 'Supabase migration-only push', colors.green);
  assertMigrationNaming(localFiles);
  assertMigrationGrants(localFiles);
  log(`Target project: ${projectRef} (every Supabase CLI call below passes --remote=${projectRef})`, colors.dim);
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
    const { status, error } = runCheck({ projectRef, dbPassword });

    if (!status) {
      log('');
      log(error, colors.red);
      log('Could not read the remote migration history.', colors.red);
      log(
        'If this project has never been linked, run `npm run db:link` once: on a network without IPv6 the CLI reaches the database through the pooler URL the link saves (or, failing that, through SUPABASE_ACCESS_TOKEN).',
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
    supabase(linkArgs({ workdir, projectRef }));
  }

  // `--remote=<ref>` names the project the history was just read from; `--yes` is CLI 3's
  // consent for a hosted write, given only once --confirm (below) has been checked.
  const pushArgs = dbPushArgs({ workdir, projectRef, password: dbPassword });

  // Compute the guard input from the history read rather than by regex-scraping
  // `db push --dry-run` output. Same reason as above, plus it is simply more reliable.
  const { status, error } = readMigrationStatus({ projectRef, dbPassword });
  if (!status) {
    log(error, colors.red);
    log('Refusing to continue: an unreadable history must not be mistaken for an empty one.', colors.yellow);
    process.exit(1);
  }
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
module.exports = {
  cliEnv,
  getMigrationVersion,
  isBaselineMigration,
  isStaleCliRefusal,
  parseMigrationList,
  readMigrationStatus,
  runCheck,
  workdir,
};

if (require.main === module) {
  main();
}
