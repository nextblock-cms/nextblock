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

/** The first version the catch-up replays, from the same header block. */
function readCatchupFrom(filePath) {
  const head = fs.readFileSync(filePath, 'utf8').slice(0, 4000);
  const match = /^--\s*catchup-from:\s*(\d+)/m.exec(head);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// --reconcile-squash: record a migration squash on a live database WITHOUT running SQL.
//
// After a squash the folder holds one generation (GG000 catch-up, GG001..GG004 baseline,
// GG005+ forward) while the remote history still lists the retired versions of the previous
// generation. The Supabase CLI refuses to push while remote versions have no local file, so:
//   1. the baseline GG001..GG004 is marked `applied` (its DDL is already present; the seed
//      would skip a populated database anyway);
//   2. the catch-up GG000 is marked `applied` ONLY when the database was at the end of the
//      previous generation (its highest retired version equals the catch-up's
//      `catchup-through` header). A database that sat behind must cross the squash with the
//      lenient applier first (`node apps/nextblock/tools/update.mjs --db-only`): that applier
//      tolerates retired history rows, and the catch-up decides what to replay from those rows
//      — reverting them first would make it replay every retired migration;
//   3. THEN every remote-only (retired) version is marked `reverted` (its history row goes
//      away). This is last on purpose: it is the irreversible step, and it is only safe once
//      the catch-up is either recorded or proven to have run;
//   4. nothing else changes: GG005+ stay pending or applied exactly as the history says.
//
// "Proven to have run" means site_settings.migration_baseline_generation, not the history —
// a version recorded by `migration repair` is indistinguishable from one an applier recorded,
// and conflating the two is what strands a catch-up.
// ---------------------------------------------------------------------------
async function reconcileSquash({ dbPassword, isCheck, confirmed, assumeYes, migrations, status: preread }) {
  const files = migrations.map((m) => m.fileName);
  const naming = validateMigrationNames(files);
  if (naming.errors.length > 0) {
    log('Migration file names violate the GGNNN scheme (tools/scripts/lib/migration-naming.js):', colors.red);
    naming.errors.forEach((error) => log(`  - ${error}`, colors.red));
    process.exit(1);
  }

  log('Squash reconcile — records the squash in the remote history; runs no migration SQL', colors.green);
  log(`Target project: ${process.env.SUPABASE_PROJECT_ID}`, colors.dim);

  const status = preread || readRemoteStatus(dbPassword);
  if (!status) {
    log('Could not read the remote migration history.', colors.red);
    log('If this project has never been linked, run `npx supabase link --project-ref <ref> --workdir libs/db/src` once.', colors.yellow);
    process.exit(1);
  }
  const pending = new Set(status.pending);

  const baselineVersions = files.filter(isBaselineMigration).map((f) => f.split('_')[0]);
  const catchupFile = files.find(isCatchupMigration);
  const catchupVersion = catchupFile ? catchupFile.split('_')[0] : null;
  const through = catchupFile ? readCatchupThrough(path.join(migrationsDir, catchupFile)) : null;

  const retired = [...status.remoteOnly].sort();
  const highestRetired = retired.length > 0 ? retired[retired.length - 1] : null;

  const markApplied = baselineVersions.filter((v) => pending.has(v));
  const catchupPending = Boolean(catchupVersion && pending.has(catchupVersion));
  let catchupNote = null;

  // Everything below is about whether it is safe to REVERT the retired rows, so it must not
  // depend on the catch-up still being pending. An auto-detect repair can record the catch-up
  // as applied without running it (its ceiling filter is a blind `version <= ceiling`); gating
  // these checks on `pending` would then skip them in exactly the state that needs them most,
  // and revert the rows the catch-up still has to read.
  if (retired.length > 0 && catchupVersion) {
    if (!through) {
      // Reverting without knowing where the catch-up ends is never safe: the catch-up decides
      // what to replay from the recorded versions, so an empty history replays the whole
      // generation onto a live database.
      log(`Cannot read the catchup-through header of ${catchupFile}.`, colors.red);
      log('Refusing to revert retired versions without it — the catch-up decides what to replay from', colors.yellow);
      log('what is recorded, so reverting first would replay the entire retired generation.', colors.yellow);
      log(`Restore the "-- catchup-through: <version>" header line (regenerate via tools/scripts/rebaseline-transform.mjs).`, colors.yellow);
      process.exit(1);
    } else if (highestRetired > through) {
      log(`The remote history records ${highestRetired}, newer than this checkout's catchup-through ${through}.`, colors.red);
      log('This checkout is older than the database. Update the checkout before reconciling.', colors.yellow);
      process.exit(1);
    } else if (highestRetired < through) {
      // The history alone cannot tell "the catch-up ran and brought this database to the end of
      // the generation" from "a repair recorded the catch-up without running it" — in BOTH the
      // catch-up is applied and highestRetired is still below catchup-through, because the
      // catch-up replays retired files without recording a history row for each. Only the
      // generation marker distinguishes them, and getting this wrong is expensive in both
      // directions: refuse when it did run and the documented recovery dead-ends; proceed when
      // it did not and the retired rows the catch-up needs are gone for good.
      const { readable, generation } = await readBaselineGeneration();
      const crossed = generation !== null && generation >= naming.generation;

      if (!readable) {
        log(`This database is behind catchup-through ${through} (highest retired ${highestRetired}),`, colors.red);
        log(`and site_settings.migration_baseline_generation could not be read to tell whether ${catchupVersion} has run.`, colors.red);
        log('Refusing to revert the retired versions without that: they are the catch-up\'s only input.', colors.yellow);
        log('Set NEXT_PUBLIC_SUPABASE_URL + a Supabase key in the environment and re-run.', colors.yellow);
        process.exit(1);
      }

      if (crossed) {
        catchupNote = `${catchupVersion} has run (site_settings.migration_baseline_generation = ${generation}), so the retired rows have done their job and are safe to remove`;
      } else if (catchupPending) {
        log(`This database is BEHIND the previous generation: highest recorded retired version ${highestRetired} < catchup-through ${through}.`, colors.red);
        log('Reverting the retired versions now would make the catch-up replay every retired migration (it reads what is recorded).', colors.yellow);
        log('Cross the squash with the lenient applier first — it tolerates retired history rows and records what it applies:', colors.yellow);
        log('  node apps/nextblock/tools/update.mjs --db-only', colors.yellow);
        log('then re-run this command to clean the retired rows out of the history.', colors.yellow);
        process.exit(1);
      } else {
        log(`${catchupVersion} is recorded as APPLIED but this database never ran it: the generation marker`, colors.red);
        log(`site_settings.migration_baseline_generation is ${generation === null ? 'unset' : generation}, and the catch-up writes it as its last statement.`, colors.red);
        log('An earlier auto-detect repair recorded it without running SQL. Every applier matches by', colors.yellow);
        log('version, so the catch-up is unreachable until it is un-recorded:', colors.yellow);
        log(`  npm run db:migrate:repair-history:revert ${catchupVersion}`, colors.yellow);
        log('then cross the squash with the lenient applier:', colors.yellow);
        log('  node apps/nextblock/tools/update.mjs --db-only', colors.yellow);
        log('then re-run this command to clean the retired rows out of the history.', colors.yellow);
        process.exit(1);
      }
    } else if (catchupPending) {
      // highestRetired === through: the database sits at the end of the previous generation,
      // so the catch-up has nothing to replay and may be recorded without running.
      markApplied.push(catchupVersion);
      catchupNote = `database was at ${through}, the end of the previous generation — recorded as applied without running`;
    }
  } else if (catchupPending) {
    catchupNote = 'no retired versions in the remote history; leaving it pending (db:migrate runs it — it replays only unrecorded versions)';
  }

  if (retired.length === 0 && markApplied.length === 0) {
    log('Nothing to reconcile: no retired versions in the remote history and no baseline or catch-up pending.', colors.green);
    return;
  }

  const stillPending = status.pending.filter((v) => !markApplied.includes(v));
  log('Plan:', colors.dim);
  log(`  revert (remove from history) ${retired.length} retired version(s)${retired.length > 0 ? `: ${retired[0]} … ${highestRetired}` : ''}`, colors.dim);
  log(`  mark applied (no SQL runs)   ${markApplied.length} file(s): ${[...markApplied].sort().join(', ') || '—'}`, colors.dim);
  if (catchupNote) log(`  catch-up: ${catchupNote}`, colors.dim);
  log(stillPending.length > 0 ? `  left for \`npm run db:migrate\`: ${stillPending.join(', ')}` : '  nothing left pending afterwards', colors.dim);

  if (isCheck || !confirmed) {
    if (!isCheck) {
      log('Dry run only. To apply:', colors.yellow);
      log('  node tools/scripts/repair-db-migration-history.js --confirm --reconcile-squash', colors.yellow);
    }
    return;
  }

  const ok = await confirmDestructive(
    `${colors.yellow}Record the squash on project ${process.env.SUPABASE_PROJECT_ID} as planned above? [y/N] ${colors.reset}`,
    assumeYes,
  );
  if (!ok) {
    log('Aborted. No changes made.', colors.yellow);
    process.exit(1);
  }

  supabase(['link', '--project-ref', process.env.SUPABASE_PROJECT_ID, '--password', dbPassword, '--workdir', workdir, '--yes']);

  // Additive write FIRST, destructive write second. `--status` takes one value, so these cannot
  // be a single call, and run() exits the process on a non-zero status — an expired token or a
  // network blip between them leaves a half-done reconcile. Marking applied first makes that
  // half-state harmless: the retired rows are still recorded, the catch-up is still a no-op, and
  // re-running recomputes markApplied from `pending` idempotently. The other order would leave
  // the retired rows gone with the catch-up still pending, which arms a full-generation replay.
  if (markApplied.length > 0) {
    supabase(['migration', 'repair', ...markApplied, '--status', 'applied', '--password', dbPassword, '--workdir', workdir, '--yes']);
  }
  if (retired.length > 0) {
    supabase(['migration', 'repair', ...retired, '--status', 'reverted', '--password', dbPassword, '--workdir', workdir, '--yes']);
  }
  log('Squash recorded. Run `npm run db:migrate:check` next.', colors.green);
}

// ---------------------------------------------------------------------------
// Routing. The auto-detect mode below is for a database whose history table was WIPED; a
// history that still lists retired versions is a squash, a different problem with a different
// remedy. Auto-detecting into a squash is what records the catch-up as applied without running
// it, which strands every retired migration the database has not crossed yet — and because the
// ceiling is a blind `version <= ceiling` filter, it happens with no warning and no error.
//
// So: read the history first and route. Nobody should have to remember `--reconcile-squash`.
// Returns true when this function has handled the run.
// ---------------------------------------------------------------------------
async function routeSquashOrAutoDetect(options) {
  const status = readRemoteStatus(options.dbPassword);

  if (!status) {
    // Auto-detect never needed a link (it probes PostgREST), so an unreadable history is not
    // fatal here — but it does mean the squash check could not run. Say so rather than imply
    // the history was checked and found clean.
    log('Could not read the remote migration history, so the squash check was skipped.', colors.yellow);
    log('If this project has never been linked, run `npx supabase link --project-ref <ref> --workdir libs/db/src` once.', colors.dim);
    log('');
    return false;
  }

  if (status.remoteOnly.length === 0) {
    return false;
  }

  const retired = [...status.remoteOnly].sort();
  log('');
  log(`The remote history lists ${retired.length} version(s) with no local file (${retired[0]} … ${retired[retired.length - 1]}).`, colors.yellow);
  log('That is a migration squash, not a wiped history — and the auto-detect repair is the wrong', colors.yellow);
  log('tool for it: it records the catch-up as applied without running it, which silently strands', colors.yellow);
  log('any retired migration this database has not crossed yet.', colors.yellow);
  log('');

  // --through says the operator is naming the level themselves. Honour that, but do not go
  // quiet about the retired rows — the warning is the part that matters.
  if (options.warnOnly) {
    log('--through given, so the auto-detect level below is yours. The retired versions above are', colors.yellow);
    log('still there and `supabase db push` will keep refusing until they are reconciled.', colors.yellow);
    log('');
    return false;
  }

  if (options.isCheck) {
    log('Showing the squash reconcile plan instead:', colors.green);
    log('');
    await reconcileSquash({ ...options, status });
    return true;
  }

  if (!options.assumeYes && !process.stdin.isTTY) {
    log('Not switching automatically: this is not an interactive terminal, so there is nobody', colors.red);
    log('to ask. Re-run with --reconcile-squash to record the squash explicitly.', colors.yellow);
    process.exit(1);
  }

  const ok = options.assumeYes
    ? true
    : await promptYesNo(`${colors.yellow}Switch to the squash reconcile instead? [Y/n] ${colors.reset}`, true);
  if (!ok) {
    log('Aborted. Nothing was changed.', colors.yellow);
    log('The auto-detect repair is unsafe while retired versions remain in the history; it is', colors.dim);
    log('only for a database whose history table was wiped.', colors.dim);
    process.exit(1);
  }
  log('');
  await reconcileSquash({ ...options, status });
  return true;
}

// ---------------------------------------------------------------------------
// --revert <version...>: un-record versions from the remote history.
//
// The undo for a repair that marked the wrong versions applied — most often a catch-up that
// the auto-detect mode recorded without running. Every applier matches by version and never by
// content, so a wrongly-recorded version is skipped forever until it is un-recorded. Nothing
// else in the repo does this, and by hand it needs the raw CLI plus credentials from .env.local.
// ---------------------------------------------------------------------------
async function revertVersions({ dbPassword, isCheck, confirmed, assumeYes, migrations }) {
  const versions = argv.filter((a) => /^\d+$/.test(a));

  if (versions.length === 0) {
    log('No version given. Usage:', colors.red);
    log('  npm run db:migrate:repair-history:revert <version> [more versions...]', colors.yellow);
    log('  npm run db:migrate:repair-history:revert:check <version>   # plan only', colors.yellow);
    process.exit(1);
  }

  log('Un-record migration versions (supabase migration repair --status reverted)', colors.green);
  log(`Target project: ${process.env.SUPABASE_PROJECT_ID}`, colors.dim);
  log('This removes history rows only. It runs no migration SQL and changes no table data.', colors.dim);
  log('');

  // Every classification below needs the real history. Reverting is not symmetric: what a row
  // means depends on whether it is a local file (un-recording makes it run again) or a retired
  // version (un-recording changes what the CATCH-UP replays), and a version recorded nowhere
  // silently does nothing at all while the command still reports success.
  const status = readRemoteStatus(dbPassword);
  if (!status) {
    log('Could not read the remote migration history, and this command must not guess.', colors.red);
    log('If this project has never been linked, run `npx supabase link --project-ref <ref> --workdir libs/db/src` once.', colors.yellow);
    process.exit(1);
  }

  const recorded = new Set([...status.applied, ...status.remoteOnly]);
  const naming = validateMigrationNames(migrations.map((m) => m.fileName));
  const force = args.has('--force');

  // "Recorded with no local file" is NOT the same as "retired". It also covers a version
  // applied from a checkout NEWER than this one, which is routine on a team. Only a row the
  // catch-up would actually consult counts as retired, so classify by its declared range —
  // otherwise one teammate's newer migration silently disarms the guard below.
  const catchupFileName = migrations.map((m) => m.fileName).find(isCatchupMigration);
  const catchupPath = catchupFileName ? path.join(migrationsDir, catchupFileName) : null;
  const rangeFrom = catchupPath ? readCatchupFrom(catchupPath) : null;
  const rangeThrough = catchupPath ? readCatchupThrough(catchupPath) : null;
  const isRetired = (v) => Boolean(rangeFrom && rangeThrough && v >= rangeFrom && v <= rangeThrough);
  const retiredSet = new Set(status.remoteOnly.filter(isRetired));
  const newerThanCheckout = status.remoteOnly.filter((v) => !isRetired(v));

  const unknown = versions.filter((v) => !recorded.has(v));
  if (unknown.length > 0) {
    log(`Not recorded in the remote history: ${unknown.join(', ')}`, colors.red);
    log('Reverting them would do nothing while this command still printed success, so it stops here.', colors.yellow);
    log('Check the version against `npm run db:migrate:check` — a typo is the usual cause.', colors.yellow);
    process.exit(1);
  }

  for (const version of versions) {
    const local = migrations.find((m) => m.version === version);
    const label = retiredSet.has(version)
      ? '(retired version — the catch-up reads this row to decide what to replay)'
      : local
        ? local.fileName
        : '(recorded, no local file — newer than this checkout?)';
    log(`  ${version}  ${label}`, colors.dim);
  }
  log('');

  // Un-recording a catch-up is the documented recovery from an auto-detect repair — but only
  // while something still stops it replaying the whole retired generation. Two things can:
  // the retired rows themselves, or the generation marker it self-skips on.
  const catchupRequested = versions.filter((v) => {
    const local = migrations.find((m) => m.version === v);
    return local && isCatchupMigration(local.fileName);
  });

  if (catchupRequested.length > 0 && retiredSet.size === 0) {
    const { readable, generation } = await readBaselineGeneration();
    const selfSkips = generation !== null && generation >= naming.generation;
    if (!selfSkips && !force) {
      log(`${catchupRequested.join(', ')} is a catch-up, and this history has no retired versions left`, colors.red);
      log(
        newerThanCheckout.length > 0
          ? `(${newerThanCheckout.length} remote-only version(s) are recorded, but all are outside ${rangeFrom}..${rangeThrough}, so the catch-up ignores them).`
          : 'for it to skip on.',
        colors.red,
      );
      log('With nothing recorded for it to skip, running it again would replay the ENTIRE retired', colors.red);
      log('generation over live content.', colors.red);
      log(
        readable
          ? `site_settings.migration_baseline_generation is ${generation === null ? 'unset' : generation}, so it would not self-skip either.`
          : 'site_settings.migration_baseline_generation could not be read to confirm it would self-skip.',
        colors.yellow,
      );
      log('Refusing. If you have read the catch-up and know it is a no-op here, force it with:', colors.yellow);
      log(`  node tools/scripts/repair-db-migration-history.js --confirm --revert ${catchupRequested.join(' ')} --force`, colors.yellow);
      log('(npm consumes --force itself, so that one has to go through node directly.)', colors.dim);
      process.exit(1);
    }
    if (selfSkips) {
      log(`Catch-up self-skips (migration_baseline_generation = ${generation}), so re-running it is a no-op.`, colors.dim);
    }
  }

  const retiredRequested = versions.filter((v) => retiredSet.has(v));
  if (retiredRequested.length > 0 && !force) {
    log(`${retiredRequested.length} of these are RETIRED versions, not local files.`, colors.red);
    log('Removing a retired row does not just tidy the history: that row is exactly what tells the', colors.red);
    log('catch-up the migration has already run, so removing it makes the catch-up replay it.', colors.red);
    log('Use `npm run db:migrate:repair-history` to reconcile a squash properly — it removes them', colors.yellow);
    log('in the right order, after the catch-up. To remove them anyway:', colors.yellow);
    log(`  node tools/scripts/repair-db-migration-history.js --confirm --revert ${retiredRequested.join(' ')} --force`, colors.yellow);
    log('(npm consumes --force itself, so that one has to go through node directly.)', colors.dim);
    process.exit(1);
  }

  log(
    versions.some((v) => migrations.some((m) => m.version === v))
      ? 'A local file listed above becomes PENDING again, so the next applier will run it.'
      : 'These have no local file, so nothing becomes pending.',
    colors.dim,
  );

  if (isCheck || !confirmed) {
    if (!isCheck) {
      log('Dry run only. Re-run without :check to apply.', colors.yellow);
    }
    return;
  }

  const ok = await confirmDestructive(
    `${colors.yellow}Un-record ${versions.length} version(s) on project ${process.env.SUPABASE_PROJECT_ID}? [y/N] ${colors.reset}`,
    assumeYes,
  );
  if (!ok) {
    log('Aborted. No changes made.', colors.yellow);
    process.exit(1);
  }

  supabase(['link', '--project-ref', process.env.SUPABASE_PROJECT_ID, '--password', dbPassword, '--workdir', workdir, '--yes']);
  supabase(['migration', 'repair', ...versions, '--status', 'reverted', '--password', dbPassword, '--workdir', workdir, '--yes']);

  // Re-read rather than assume. The CLI exits 0 for a version it did not actually remove, and
  // "it said Repaired" is what makes an operator move on to the next, destructive step.
  const after = readRemoteStatus(dbPassword);
  if (!after) {
    log('The repair reported success, but the history could not be re-read — nothing was verified.', colors.red);
    log('Run `npm run db:migrate:check` and confirm the version is gone BEFORE any reconcile.', colors.yellow);
    process.exit(1);
  }
  const stillThere = versions.filter((v) => [...after.applied, ...after.remoteOnly].includes(v));
  if (stillThere.length > 0) {
    log(`Still recorded after the repair: ${stillThere.join(', ')}`, colors.red);
    log('The history did not change as expected — do not continue with a reconcile.', colors.yellow);
    process.exit(1);
  }
  log('Versions un-recorded. Run `npm run db:migrate:check` next.', colors.green);
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

/**
 * Remove dollar-quoted bodies ($tag$ … $tag$). A catch-up embeds each retired migration
 * verbatim inside one, and that inner SQL sits at line start — so the line-anchored scan below
 * would attribute the retired files' tables to the catch-up and could then "detect" a catch-up
 * as applied on a database that has never run it.
 */
function stripDollarQuoted(sql) {
  return sql.replace(/\$([a-z0-9_]*)\$[\s\S]*?\$\1\$/gi, ' ');
}

function getLocalMigrations() {
  return fs
    .readdirSync(migrationsDir)
    .filter((fileName) => MIGRATION_FILE_RE.test(fileName))
    .sort()
    .map((fileName) => {
      const version = fileName.split('_')[0];
      const sql = stripDollarQuoted(stripSqlComments(fs.readFileSync(path.join(migrationsDir, fileName), 'utf8')));
      const createdTables = [];
      // A catch-up creates nothing of its own — it only replays retired files whose tables the
      // baseline also creates. Claiming its tables would let the detector mark it applied on a
      // database that never ran it, which is the one mistake this whole script must not make.
      if (!isCatchupMigration(fileName)) {
        // Anchor to line start so CREATE TABLE inside seed string literals is ignored.
        const re = /^\s*create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gim;
        let match;
        while ((match = re.exec(sql)) !== null) {
          createdTables.push(match[1]);
        }
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

function promptYesNo(question, defaultYes = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (trimmed === '') {
        resolve(defaultYes);
        return;
      }
      resolve(/^y(es)?$/i.test(trimmed));
    });
  });
}

/**
 * Confirm a step that rewrites the remote migration history.
 *
 * `--yes` (or CI=true) answers for you. Otherwise this prompts — and when there is no terminal
 * to prompt on it REFUSES rather than proceeding. Every caller below rewrites
 * supabase_migrations.schema_migrations irreversibly, and the npm scripts pass `--confirm`, so
 * treating "no TTY" as consent would let a run under nohup, a redirected stdin, or a CI job
 * revert a migration history with no confirmation anywhere.
 */
async function confirmDestructive(question, assumeYes) {
  if (assumeYes) {
    return true;
  }
  if (!process.stdin.isTTY) {
    log('Cannot ask for confirmation: this is not an interactive terminal.', colors.red);
    log('Re-run with --yes if you really mean to rewrite the migration history unattended.', colors.yellow);
    process.exit(1);
  }
  return promptYesNo(question);
}

/**
 * Has the catch-up actually RUN on this database?
 *
 * `supabase_migrations` cannot answer that. A version recorded by `migration repair` looks
 * exactly like one recorded by an applier — that indistinguishability is the whole incident
 * this script exists to prevent. The catch-up writes `site_settings.migration_baseline_generation`
 * as its last statement, and the baseline seed writes it only on an empty database, so that key
 * is the one honest signal that the SQL really executed.
 *
 * Returns { readable, generation }. `readable: false` means we could not tell, which callers
 * must treat as "do not proceed with a destructive step", never as "not crossed".
 */
async function readBaselineGeneration() {
  const rest = getSupabaseRest();
  if (!rest) {
    return { readable: false, generation: null };
  }
  try {
    const res = await fetch(
      `${rest.url}/rest/v1/site_settings?key=eq.migration_baseline_generation&select=value`,
      { headers: { apikey: rest.key, Authorization: `Bearer ${rest.key}` } },
    );
    if (!res.ok) {
      return { readable: false, generation: null };
    }
    const rows = await res.json();
    if (!Array.isArray(rows)) {
      return { readable: false, generation: null };
    }
    if (rows.length === 0) {
      return { readable: true, generation: null }; // key absent: the catch-up has not run
    }
    const parsed = Number.parseInt(String(rows[0] && rows[0].value).replace(/"/g, ''), 10);
    return { readable: true, generation: Number.isFinite(parsed) ? parsed : null };
  } catch {
    return { readable: false, generation: null };
  }
}

/** One read of the remote history, shared by the router and the reconcile. Null when unreadable. */
function readRemoteStatus(dbPassword) {
  const { parseMigrationList } = require('./push-db-migrations.js');
  const listing = runCapture(npxBin, ['supabase', 'migration', 'list', '--workdir', workdir, '--password', dbPassword]);
  return listing ? parseMigrationList(listing) : null;
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
  const assumeYes = args.has('--yes') || process.env.CI === 'true';

  const migrations = getLocalMigrations();
  if (migrations.length === 0) {
    log('No migration files found.', colors.red);
    process.exit(1);
  }

  const modeOptions = { dbPassword, isCheck, confirmed, assumeYes, migrations };

  if (args.has('--revert')) {
    await revertVersions(modeOptions);
    return;
  }

  if (args.has('--reconcile-squash')) {
    await reconcileSquash(modeOptions);
    return;
  }

  const override = getArgValue('through');

  // Versions are compared as strings, so an unpadded or short override silently sweeps the
  // whole folder: '02000' <= '2014' is true for every file, which would mark the catch-up and
  // the entire baseline applied without running any of them. Only an exact local version is
  // meaningful, so reject anything else instead of acting on it.
  if (override && !migrations.some((m) => m.version === override)) {
    log(`--through=${override} is not a migration version in this folder.`, colors.red);
    if (/^\d{14}$/.test(override)) {
      log('That is a retired 14-digit version from an earlier squash generation. Those are', colors.yellow);
      log('meaningless to this folder; a database still on one has to cross the squash first:', colors.yellow);
      log('  node apps/nextblock/tools/update.mjs --db-only', colors.yellow);
    } else {
      log('Versions are compared as plain strings, so a short or unpadded value would sweep', colors.yellow);
      log('every file in the folder — including the catch-up and the baseline.', colors.yellow);
    }
    log(`Valid versions: ${migrations.map((m) => m.version).join(', ')}`, colors.dim);
    process.exit(1);
  }

  if (await routeSquashOrAutoDetect({ ...modeOptions, warnOnly: Boolean(override) })) {
    return;
  }
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

  // NEVER include the catch-up, whatever the ceiling says. Leaving it pending is always safe —
  // it self-skips on an empty database and on one already at this generation — whereas recording
  // it without running it cannot be detected afterwards and strands every retired migration it
  // would have replayed. That asymmetry is the whole lesson of this script, so it is enforced
  // here rather than left to the ceiling arithmetic or to whoever passed --through.
  const catchupVersions = migrations.filter((m) => isCatchupMigration(m.fileName)).map((m) => m.version);
  const versionsToMark = migrations
    .filter((m) => !isCatchupMigration(m.fileName))
    .map((m) => m.version)
    .filter((version) => version <= ceiling);
  const pendingAfter = migrations
    .map((m) => m.version)
    .filter((version) => version > ceiling || catchupVersions.includes(version));

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
  if (catchupVersions.length > 0) {
    log(
      `Leaving the catch-up (${catchupVersions.join(', ')}) pending on purpose — it must run, never be recorded.`,
      colors.dim,
    );
  }
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

  const ok = await confirmDestructive(
    `${colors.yellow}Mark every migration through ${ceiling} as applied on project ${process.env.SUPABASE_PROJECT_ID}? [y/N] ${colors.reset}`,
    assumeYes,
  );
  if (!ok) {
    log('Aborted. No changes made.', colors.yellow);
    process.exit(1);
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
