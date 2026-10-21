#!/usr/bin/env node
// Database security posture gate: runs tools/scripts/security-verify.sql against a LOCAL
// database and exits non-zero unless every assertion printed PASS.
//
//   npm run security:db-posture -- --docker nb-redteam-pg
//   npm run security:db-posture -- --db-url postgresql://postgres:postgres@127.0.0.1:54322/postgres
//
// It first runs the post-apply grant pass (GRANTS_SQL from apps/nextblock/tools/lib/migrate-core.mjs),
// because every deployed database has been through it and grant regressions only show up
// afterwards: 02022's service-role-only cortex_request_log passed on a CLI replay and failed on
// every deployed database until 02025. That pass changes grants, so this runner refuses any host
// that is not this machine. Never point it at production or a shared database.
//
// Exit codes: 0 every assertion passed; 1 a FAIL, a psql error, or fewer PASS lines than the
// script has assertions (a section stopped early); 2 bad arguments or a refused target.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const SCRIPT_PATH = path.join(here, 'security-verify.sql');
const MIGRATE_CORE = path.join(repoRoot, 'apps/nextblock/tools/lib/migrate-core.mjs');
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const USAGE = `Usage: node tools/scripts/run-security-verify.mjs (--docker <container> | --db-url <postgresql://...@127.0.0.1:...>) [--skip-grant-pass]`;

/** Parse argv into { dbUrl, docker, skipGrantPass }; throws on unknown flags. */
export function parseArgs(argv) {
  const out = { dbUrl: null, docker: null, skipGrantPass: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--db-url') out.dbUrl = argv[++i] ?? null;
    else if (arg === '--docker') out.docker = argv[++i] ?? null;
    else if (arg === '--skip-grant-pass') out.skipGrantPass = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!out.dbUrl && !out.docker) out.dbUrl = process.env.SECURITY_VERIFY_DB_URL || null;
  if (Boolean(out.dbUrl) === Boolean(out.docker)) throw new Error('Pass exactly one of --docker or --db-url');
  return out;
}

/** Throws unless the connection URL points at this machine. */
export function assertLocalDatabaseUrl(dbUrl) {
  let url;
  try {
    url = new URL(dbUrl);
  } catch {
    throw new Error('--db-url must be a postgres:// or postgresql:// URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('--db-url must be a postgres:// or postgresql:// URL');
  }
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(
      `Refusing ${url.hostname}: this runner changes grants (the post-apply pass) and inserts throwaway fixtures. ` +
        'Use a local replay (127.0.0.1 / localhost) or --docker, never production or a shared database.',
    );
  }
}

/** Number of PASS/FAIL assertions the posture script contains (each prints exactly once). */
export function expectedAssertionCount(scriptSql) {
  return (scriptSql.match(/RAISE NOTICE '%  /g) || []).length;
}

/** PASS / FAIL lines and psql errors from the combined psql output. */
export function summarize(output, expected) {
  const passed = [];
  const failed = [];
  const errors = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /NOTICE:\s+(PASS|FAIL)\s+(.*)$/.exec(line);
    if (m) (m[1] === 'PASS' ? passed : failed).push(m[2].trim());
    else if (/\bERROR:/.test(line)) errors.push(line.trim());
  }
  const missing = Math.max(0, expected - passed.length - failed.length);
  return { passed, failed, errors, missing, ok: failed.length === 0 && errors.length === 0 && passed.length >= expected && expected > 0 };
}

function runPsql(target, sql) {
  const args = target.docker
    ? ['exec', '-i', target.docker, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1']
    : [target.dbUrl, '-X', '-v', 'ON_ERROR_STOP=1'];
  const bin = target.docker ? 'docker' : process.env.PSQL_BIN || 'psql';
  const result = spawnSync(bin, args, { input: sql, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`Could not run ${bin}: ${result.error.message}`);
  return { status: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}

async function main() {
  let target;
  try {
    target = parseArgs(process.argv.slice(2));
    if (target.dbUrl) assertLocalDatabaseUrl(target.dbUrl);
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    process.exit(2);
  }

  if (!target.skipGrantPass) {
    const { GRANTS_SQL } = await import(pathToFileURL(MIGRATE_CORE).href);
    const grants = runPsql(target, `${GRANTS_SQL}\n`);
    if (grants.status !== 0) {
      console.error(`The post-apply grant pass failed:\n${grants.output}`);
      process.exit(1);
    }
    console.log('Applied the post-apply grant pass (GRANTS_SQL), as every deploy does.');
  }

  const script = readFileSync(SCRIPT_PATH, 'utf8');
  const expected = expectedAssertionCount(script);
  const run = runPsql(target, script);
  const summary = summarize(run.output, expected);

  for (const line of summary.failed) console.log(`FAIL  ${line}`);
  for (const line of summary.errors) console.log(line);
  const verdict = `${summary.passed.length}/${expected} assertions passed, ${summary.failed.length} failed` +
    (summary.missing > 0 ? `, ${summary.missing} never ran (a section stopped early)` : '');
  if (summary.ok && run.status === 0) {
    console.log(`Security posture OK: ${verdict}.`);
    return;
  }
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=Database security posture::${verdict}`);
  console.error(`Security posture FAILED: ${verdict}.`);
  if (run.status !== 0 && summary.errors.length === 0) console.error(run.output.slice(-4000));
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
