const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const readline = require('readline');

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
const migrationsDir = path.join(workdir, 'supabase/migrations');
const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const argv = process.argv.slice(2);
const args = new Set(argv);
const {
  MIGRATION_FILE_RE,
  isBaselineMigration,
  isCatchupMigration,
  validateMigrationNames,
} = require('./lib/migration-naming');

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function getArgValue(name) {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(`--${name}=`.length);
  const idx = argv.indexOf(`--${name}`);
  if (idx !== -1 && argv[idx + 1] && !argv[idx + 1].startsWith('--')) {
    return argv[idx + 1];
  }
  return null;
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
  if (!process.env.SUPABASE_ACCESS_TOKEN) {
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

function run(command, commandArgs) {
  const dbPassword = getDbPassword();
  const printable = [command, ...commandArgs.map((arg) => {
    if (arg === dbPassword) {
      return '<db-password>';
    }
    return arg.includes(' ') ? `"${arg}"` : arg;
  })].join(' ');

  log(`Running: ${printable}`, colors.blue);
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    env: process.env,
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });

  if (result.error) {
    log(result.error.message, colors.red);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function supabase(commandArgs) {
  run(npxBin, ['supabase', ...commandArgs]);
}

/** Like run(), but returns the output (null on failure) instead of inheriting stdio. */
function runCapture(command, commandArgs) {
  const dbPassword = getDbPassword();
  const printable = [command, ...commandArgs.map((arg) => (arg === dbPassword ? '<db-password>' : arg))].join(' ');
  log(`Running: ${printable}`, colors.blue);
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    env: process.env,
    shell: process.platform === 'win32',
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    return null;
  }
  return `${result.stdout || ''}${result.stderr || ''}`;
}

/** The catch-up file names the last version it replays in a header line. */
function readCatchupThrough(filePath) {
  const head = fs.readFileSync(filePath, 'utf8').slice(0, 4000);
  const match = /^--\s*catchup-through:\s*(\d+)/m.exec(head);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// --reconcile-squash: record a migration squash on a live database WITHOUT running SQL.
//
// After a squash the folder holds one generation (GG000 catch-up, GG001..GG004 baseline,
// GG005+ forward) while the remote history still lists the retired versions of the previous
// generation. The Supabase CLI refuses to push while remote versions have no local file, so:
//   1. every remote-only (retired) version is marked `reverted` (its history row goes away);
//   2. the baseline GG001..GG004 is marked `applied` (its DDL is already present; the seed
//      would skip a populated database anyway);
//   3. the catch-up GG000 is marked `applied` ONLY when the database was at the end of the
//      previous generation (its highest retired version equals the catch-up's
//      `catchup-through` header). A database that sat behind must cross the squash with the
//      lenient applier first (`npm run update -- --db-only`): that applier tolerates retired
//      history rows, and the catch-up decides what to replay from those rows — reverting them
//      first would make it replay every retired migration.
//   4. nothing else changes: GG005+ stay pending or applied exactly as the history says.
// ---------------------------------------------------------------------------
async function reconcileSquash({ dbPassword, isCheck, confirmed, skipPrompt, migrations }) {
  // Pure helper from the push script; requiring it never touches a database.
  const { parseMigrationList } = require('./push-db-migrations.js');

  const files = migrations.map((m) => m.fileName);
  const naming = validateMigrationNames(files);
  if (naming.errors.length > 0) {
    log('Migration file names violate the GGNNN scheme (tools/scripts/lib/migration-naming.js):', colors.red);
    naming.errors.forEach((error) => log(`  - ${error}`, colors.red));
    process.exit(1);
  }

  log('Squash reconcile — records the squash in the remote history; runs no migration SQL', colors.green);
  log(`Target project: ${process.env.SUPABASE_PROJECT_ID}`, colors.dim);

  const listing = runCapture(npxBin, ['supabase', 'migration', 'list', '--workdir', workdir, '--password', dbPassword]);
  if (!listing) {
    log('Could not read the remote migration history.', colors.red);
    log('If this project has never been linked, run `npx supabase link --project-ref <ref> --workdir libs/db/src` once.', colors.yellow);
    process.exit(1);
  }
  const status = parseMigrationList(listing);
  const pending = new Set(status.pending);

  const baselineVersions = files.filter(isBaselineMigration).map((f) => f.split('_')[0]);
  const catchupFile = files.find(isCatchupMigration);
  const catchupVersion = catchupFile ? catchupFile.split('_')[0] : null;
  const through = catchupFile ? readCatchupThrough(path.join(migrationsDir, catchupFile)) : null;

  const retired = [...status.remoteOnly].sort();
  const highestRetired = retired.length > 0 ? retired[retired.length - 1] : null;

  const markApplied = baselineVersions.filter((v) => pending.has(v));
  let catchupNote = null;
  if (catchupVersion && pending.has(catchupVersion)) {
    if (!through) {
      catchupNote = `cannot read the catchup-through header of ${catchupFile}; leaving it pending`;
    } else if (retired.length === 0) {
      catchupNote = 'no retired versions in the remote history; leaving it pending (db:migrate runs it — it replays only unrecorded versions)';
    } else if (highestRetired === through) {
      markApplied.push(catchupVersion);
      catchupNote = `database was at ${through}, the end of the previous generation — recorded as applied without running`;
    } else if (highestRetired < through) {
      log(`This database is BEHIND the previous generation: highest recorded retired version ${highestRetired} < catchup-through ${through}.`, colors.red);
      log('Reverting the retired versions now would make the catch-up replay every retired migration (it reads what is recorded).', colors.yellow);
      log('Cross the squash with the lenient applier first — it tolerates retired history rows and records what it applies:', colors.yellow);
      log('  npm run update -- --db-only', colors.yellow);
      log('then re-run this command to clean the retired rows out of the history.', colors.yellow);
      process.exit(1);
    } else {
      log(`The remote history records ${highestRetired}, newer than this checkout's catchup-through ${through}.`, colors.red);
      log('This checkout is older than the database. Update the checkout before reconciling.', colors.yellow);
      process.exit(1);
    }
  }

  if (retired.length === 0 && markApplied.length === 0) {
    log('Nothing to reconcile: no retired versions in the remote history and no baseline or catch-up pending.', colors.green);
    return;
  }

  const stillPending = status.pending.filter((v) => !markApplied.includes(v));
  log('Plan:', colors.dim);
  log(`  revert (remove from history) ${retired.length} retired version(s)${retired.length > 0 ? `: ${retired[0]} … ${highestRetired}` : ''}`, colors.dim);
  log(`  mark applied (no SQL runs)   ${markApplied.length} file(s): ${markApplied.join(', ') || '—'}`, colors.dim);
  if (catchupNote) log(`  catch-up: ${catchupNote}`, colors.dim);
  log(stillPending.length > 0 ? `  left for \`npm run db:migrate\`: ${stillPending.join(', ')}` : '  nothing left pending afterwards', colors.dim);

  if (isCheck || !confirmed) {
    if (!isCheck) {
      log('Dry run only. Run `npm run db:migrate:repair-history -- --reconcile-squash` to apply.', colors.yellow);
    }
    return;
  }

  if (!skipPrompt) {
    const ok = await promptYesNo(
      `${colors.yellow}Record the squash on project ${process.env.SUPABASE_PROJECT_ID} as planned above? [y/N] ${colors.reset}`,
    );
    if (!ok) {
      log('Aborted. No changes made.', colors.yellow);
      process.exit(1);
    }
  }

  supabase(['link', '--project-ref', process.env.SUPABASE_PROJECT_ID, '--password', dbPassword, '--workdir', workdir, '--yes']);
  if (retired.length > 0) {
    supabase(['migration', 'repair', ...retired, '--status', 'reverted', '--password', dbPassword, '--workdir', workdir, '--yes']);
  }
  if (markApplied.length > 0) {
    supabase(['migration', 'repair', ...markApplied, '--status', 'applied', '--password', dbPassword, '--workdir', workdir, '--yes']);
  }
  log('Squash recorded. Run `npm run db:migrate:check` next.', colors.green);
}

// ---------------------------------------------------------------------------
// Auto-detection of the applied high-water mark.
//
// Migrations apply as a contiguous prefix (000, 001, … N), so the only unknown
// when the history table has been wiped is the single highest applied version N.
// We discover it by parsing each migration's CREATE TABLE statements and asking
// the live database (via the PostgREST schema) which of those tables exist. The
// newest migration whose table exists is the high-water mark. This needs no
// per-migration upkeep, and `--through=<version>` overrides it when a tail of
// table-less (data-only) migrations is also applied.
// ---------------------------------------------------------------------------

function stripSqlComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/--[^\n]*/g, ' '); // line comments
}

function getLocalMigrations() {
  return fs
    .readdirSync(migrationsDir)
    .filter((fileName) => MIGRATION_FILE_RE.test(fileName))
    .sort()
    .map((fileName) => {
      const version = fileName.split('_')[0];
      const sql = stripSqlComments(fs.readFileSync(path.join(migrationsDir, fileName), 'utf8'));
      const createdTables = [];
      // Anchor to line start so CREATE TABLE inside seed string literals is ignored.
      const re = /^\s*create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gim;
      let match;
      while ((match = re.exec(sql)) !== null) {
        createdTables.push(match[1]);
      }
      return { version, fileName, createdTables };
    });
}

function getSupabaseRest() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ''), key };
}

async function fetchExposedTables(rest) {
  // The PostgREST root returns an OpenAPI spec listing every exposed table in
  // one request — cheaper than probing each table individually.
  try {
    const res = await fetch(`${rest.url}/rest/v1/`, {
      headers: { apikey: rest.key, Authorization: `Bearer ${rest.key}` },
    });
    if (!res.ok) return null;
    const spec = await res.json();
    const names = new Set();
    if (spec && spec.definitions) {
      Object.keys(spec.definitions).forEach((name) => names.add(name));
    }
    if (spec && spec.paths) {
      Object.keys(spec.paths).forEach((p) => {
        const m = p.match(/^\/([A-Za-z0-9_]+)$/);
        if (m) names.add(m[1]);
      });
    }
    return names.size > 0 ? names : null;
  } catch {
    return null;
  }
}

async function tableExists(rest, table) {
  try {
    const res = await fetch(`${rest.url}/rest/v1/${encodeURIComponent(table)}?select=*&limit=1`, {
      headers: { apikey: rest.key, Authorization: `Bearer ${rest.key}` },
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function detectHighWater(migrations, rest) {
  const exposed = await fetchExposedTables(rest);
  for (let i = migrations.length - 1; i >= 0; i -= 1) {
    const migration = migrations[i];
    for (const table of migration.createdTables) {
      // eslint-disable-next-line no-await-in-loop
      const exists = exposed ? exposed.has(table) : await tableExists(rest, table);
      if (exists) {
        return { version: migration.version, table };
      }
    }
  }
  return null;
}

function promptYesNo(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

async function main() {
  loadEnvFiles();
  requireEnv();

  const dbPassword = getDbPassword();
  const isCheck = args.has('--check');
  const confirmed =
    args.has('--confirm') ||
    process.env.CI === 'true' ||
    process.env.CONFIRM_DB_MIGRATION_REPAIR === 'true';
  const skipPrompt =
    args.has('--yes') || process.env.CI === 'true' || !process.stdin.isTTY;

  const migrations = getLocalMigrations();
  if (migrations.length === 0) {
    log('No migration files found.', colors.red);
    process.exit(1);
  }

  if (args.has('--reconcile-squash')) {
    await reconcileSquash({ dbPassword, isCheck, confirmed, skipPrompt, migrations });
    return;
  }

  const override = getArgValue('through');
  let ceiling = override;
  let detection = null;

  if (!ceiling) {
    const rest = getSupabaseRest();
    if (!rest) {
      log('Cannot auto-detect the applied level: missing Supabase URL or API key in the environment.', colors.red);
      log('Set NEXT_PUBLIC_SUPABASE_URL + a Supabase key, or pass --through=<version> explicitly.', colors.yellow);
      process.exit(1);
    }
    log('Auto-detecting the applied migration high-water mark from the remote schema...', colors.dim);
    detection = await detectHighWater(migrations, rest);
    if (!detection) {
      log('No applied migrations detected — none of the migration tables exist remotely.', colors.yellow);
      log('This looks like a brand-new database: use `npm run db:migrate:fresh` instead,', colors.yellow);
      log('or pass --through=<version> if you know the schema is further along.', colors.yellow);
      process.exit(1);
    }
    ceiling = detection.version;
  }

  const versionsToMark = migrations
    .map((m) => m.version)
    .filter((version) => version <= ceiling);
  const pendingAfter = migrations.map((m) => m.version).filter((version) => version > ceiling);

  if (versionsToMark.length === 0) {
    log(`No migrations at or below ${ceiling} — nothing to repair.`, colors.yellow);
    process.exit(1);
  }

  log('Supabase migration history repair (auto-detect)', colors.green);
  log(`Target project: ${process.env.SUPABASE_PROJECT_ID}`, colors.dim);
  if (detection) {
    log(`Detected applied through ${detection.version} (remote table "${detection.table}" exists).`, colors.dim);
  } else {
    log(`Using --through override: ${ceiling}.`, colors.dim);
  }
  log(
    `Will mark ${versionsToMark.length} migration(s) as applied (${versionsToMark[0]} … ${versionsToMark[versionsToMark.length - 1]}). This does not run migration SQL.`,
    colors.dim,
  );
  log(
    pendingAfter.length > 0
      ? `Left for \`npm run db:migrate\` to apply: ${pendingAfter.join(', ')}`
      : 'No newer migrations remain to apply afterward.',
    colors.dim,
  );

  if (isCheck || !confirmed) {
    if (!confirmed && !isCheck) {
      log('Dry run only. Run `npm run db:migrate:repair-history` to apply (override with --through=<version>).', colors.yellow);
    }
    return;
  }

  if (!skipPrompt) {
    const ok = await promptYesNo(
      `${colors.yellow}Mark every migration through ${ceiling} as applied on project ${process.env.SUPABASE_PROJECT_ID}? [y/N] ${colors.reset}`,
    );
    if (!ok) {
      log('Aborted. No changes made.', colors.yellow);
      process.exit(1);
    }
  }

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

  supabase([
    'migration',
    'repair',
    ...versionsToMark,
    '--status',
    'applied',
    '--password',
    dbPassword,
    '--workdir',
    workdir,
    '--yes',
  ]);

  log('Migration history repaired. Run `npm run db:migrate:check` next.', colors.green);
}

main().catch((error) => {
  log(error instanceof Error ? error.stack || error.message : String(error), colors.red);
  process.exit(1);
});
