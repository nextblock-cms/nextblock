// Environment-aware, zero-config build-time schema migration hook.
//
// Runs BEFORE `next build` (wired in apps/nextblock/project.json for nx/Vercel and in
// the app's `prebuild` script for standalone/Docker `npm run build`). It applies any
// pending, forward-only migrations to the tenant's Postgres so the deployed app and its
// schema move together — additively, transactionally, and tracked exactly like the
// Supabase CLI in supabase_migrations.schema_migrations.
//
// Gating (no manual config required):
//   * On Vercel: run only when VERCEL_ENV === 'production'. Preview/development builds
//     are skipped so feature previews never touch live data structures.
//   * Off Vercel (npm create / local / Docker): run only when NEXTBLOCK_BUILD_MIGRATE === '1'
//     (the /setup wizard and the create/docker setup scripts write this into .env).
//
// Safety: this NEVER fails the build. A missing flag, a missing connection string, an
// unreachable database, an empty migration history the engine refuses to apply over — or
// even a broken ./lib/migrate-core.mjs — logs a warning and exits 0 so static packaging
// always proceeds. That is why the engine is loaded with a
// guarded dynamic import rather than a top-level one: an unresolvable top-level import
// is a hard ESM error that no try/catch inside main() could contain.
//
// The engine itself (discovery + the two backends) lives in ./lib/migrate-core.mjs and is
// shared with `npm run update` (tools/update.mjs), so the two can no longer drift.

const log = (msg) => console.log(`[build-migrate] ${msg}`);

/** Decide whether the hook should run, with a human-readable reason for the log. */
function evaluateGate() {
  const vercelEnv = process.env.VERCEL_ENV;
  if (vercelEnv) {
    return vercelEnv === 'production'
      ? { run: true, reason: 'VERCEL_ENV=production' }
      : { run: false, reason: `VERCEL_ENV=${vercelEnv} — preview/development build, skipping` };
  }
  if (process.env.NEXTBLOCK_BUILD_MIGRATE === '1') {
    return { run: true, reason: 'NEXTBLOCK_BUILD_MIGRATE=1' };
  }
  return { run: false, reason: 'NEXTBLOCK_BUILD_MIGRATE is not set — skipping' };
}

async function main() {
  let core;
  try {
    core = await import('./lib/migrate-core.mjs');
  } catch (err) {
    log(`WARNING: could not load the migration engine: ${err?.message ?? err}.`);
    log('Continuing the build — apply later with "npm run update".');
    return;
  }

  // Load .env BEFORE the gate: off Vercel, NEXTBLOCK_BUILD_MIGRATE is never a real process
  // env var — it lives in .env.local / .env, written there by the /setup wizard and the
  // create/docker setup scripts. Evaluating the gate first would read `undefined` and
  // silently skip every build-time migration on standalone and local installs.
  await core.loadEnvFiles(process.cwd());

  const gate = evaluateGate();
  if (!gate.run) {
    log(`Skipping build-time migrations (${gate.reason}).`);
    return;
  }
  log(`Build-time migrations enabled (${gate.reason}).`);

  const backend = core.describeBackend();
  if (backend.kind === 'none') {
    log(`No database connection is configured (${backend.detail}) — skipping.`);
    log('Apply the schema with the /setup wizard or "npm run update".');
    return;
  }

  const { files, sources } = core.collectMigrations(process.cwd());
  if (files.length === 0) {
    log('Could not locate any migrations — skipping.');
    return;
  }
  for (const source of sources) {
    if (source.contributed > 0) {
      log(`Using ${source.contributed} migration(s) from the ${source.label} copy (${source.dir}).`);
    }
  }

  const result = await core.applyMigrations(files);
  if (result.ok) {
    log(
      result.applied > 0
        ? `Applied ${result.applied} pending migration(s) via ${result.backend}.`
        : 'Schema already up to date.',
    );
  } else if (result.refusal) {
    // The engine refused an empty migration history: this database holds content, and the run would
    // replay a retired squash generation over it (emptyHistoryRefusal in ./lib/migrate-core.mjs). It
    // wrote nothing, and "npm run update" refuses the same way, so the log says what to restore instead
    // of sending the reader there.
    log(`WARNING: migrations not applied. ${result.error}`);
    log('Continuing the build; the database was not changed.');
  } else {
    log(`WARNING: could not apply migrations: ${result.error}.`);
    log('Continuing the build — apply later with "npm run update".');
  }
}

// Guarantee a clean exit code regardless of outcome: infrastructure issues must never
// break web packaging.
main()
  .catch((err) => {
    log(`WARNING: ${err instanceof Error ? err.message : String(err)}.`);
  })
  .finally(() => {
    process.exit(0);
  });
