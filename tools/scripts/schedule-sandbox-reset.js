#!/usr/bin/env node
/**
 * Schedules the public sandbox's 15-minute reset as a pg_cron job inside the sandbox's
 * own Supabase database, so no cron has to live in `vercel.json`.
 *
 * Why not a Vercel cron: `vercel.json` ships to every 1-click install, and a Hobby
 * account fails the whole deployment on any schedule more frequent than once a day.
 * A branch that carries the cron does not help either — every project on the repo builds
 * every branch. The sandbox database is the one place only the sandbox has.
 *
 * The job calls `GET /api/cron/reset-sandbox` through pg_net with the CRON_SECRET read
 * from Supabase Vault. It survives the reset itself, which drops only the `public`
 * schema (`cron`, `net` and `vault` are untouched) — PROVIDED pg_net is registered in
 * the `extensions` schema. A bare `create extension pg_net` lands it in `public` (the
 * postgres role's first search_path entry), and then `DROP SCHEMA public CASCADE` tries to
 * drop pg_net itself while the pg_net worker still holds the request that triggered the
 * reset: the two wait on each other until Vercel times the route out (504 every run).
 * This script installs pg_net WITH SCHEMA extensions and moves an existing public copy.
 *
 * Run it ONCE from any machine whose `.env.local` points at the sandbox database (or
 * paste the `--print-sql` output into the Supabase SQL editor). The job then lives in
 * the database; nothing runs on Vercel. Reads from `.env.local` at the repo root:
 *   NEXT_PUBLIC_IS_SANDBOX=true    refuses to run otherwise
 *   CRON_SECRET                    the bearer token the route expects
 *   POSTGRES_URL_NON_POOLING       (or POSTGRES_URL / DATABASE_URL) the sandbox database
 *   SANDBOX_URL / NEXT_PUBLIC_URL  the public sandbox origin, unless given on the command line
 *
 *   npm run sandbox:schedule -- https://cms.nextblock.dev              # install / update
 *   npm run sandbox:schedule -- https://cms.nextblock.dev print-sql    # SQL for the dashboard
 *   npm run sandbox:schedule -- --schedule="*\/30 * * * *" https://cms.nextblock.dev
 *   npm run sandbox:schedule -- status       # job + last runs + last HTTP responses
 *   npm run sandbox:schedule -- remove       # unschedule and drop the Vault secret
 *   (the --status / --remove / --print-sql spellings work where npm passes them through)
 */
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const postgres = require('postgres');

const JOB_NAME = 'sandbox-reset';
const SECRET_NAME = 'sandbox_cron_secret';
const DEFAULT_SCHEDULE = '*/15 * * * *';
// The reset takes up to a minute; pg_net's default 5 s would abandon the request.
const REQUEST_TIMEOUT_MS = 90_000;

// pg_net is not relocatable, so a copy that landed in `public` has to be dropped and
// re-created in `extensions` (its own objects live in the `net` schema either way; only the
// request/response log is lost). Blocks for up to a request timeout if the worker is
// mid-request, so run it between reset ticks.
const ENSURE_PG_NET_SQL = `
      do $nb_pg_net$
      begin
        if exists (
          select 1 from pg_extension
           where extname = 'pg_net' and extnamespace = 'public'::regnamespace
        ) then
          raise notice 'pg_net is installed in schema public; reinstalling it in extensions';
          drop extension pg_net;
        end if;
        create extension if not exists pg_net with schema extensions;
      end $nb_pg_net$`;

const envPath = path.resolve(__dirname, '../../.env.local');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

// npm on some shells (PowerShell in particular) swallows "--flag" even after "--", so
// accept every spelling: bare words (status, remove, print-sql), a bare https URL,
// --url=value / --schedule=value, or SANDBOX_URL in the environment.
const args = process.argv.slice(2);
const flags = new Set();
const options = {};
let positionalUrl;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg.startsWith('--')) {
    const eq = arg.indexOf('=');
    if (eq > 0) {
      options[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else if (i + 1 < args.length && !args[i + 1].startsWith('--') && !/^https?:\/\//.test(args[i + 1])) {
      options[arg.slice(2)] = args[i + 1];
      i += 1;
    } else {
      flags.add(arg.slice(2));
    }
  } else if (/^https?:\/\//.test(arg)) {
    positionalUrl = arg;
  } else if (['status', 'remove', 'print-sql'].includes(arg)) {
    // npm on PowerShell drops "--status" even after "--", so bare words work too.
    flags.add(arg);
  }
}
const flag = (name) => flags.has(name);
const option = (name) => options[name];

function fail(message) {
  console.error('\x1b[31m%s\x1b[0m', message);
  process.exit(1);
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function scheduleInputs() {
  const cronSecret = (process.env.CRON_SECRET || '').trim();
  if (!cronSecret) fail('CRON_SECRET is not set in .env.local.');

  const siteUrl = option('url') || positionalUrl || process.env.SANDBOX_URL || process.env.NEXT_PUBLIC_URL;
  if (!siteUrl || !/^https:\/\//.test(siteUrl)) {
    fail('The sandbox origin must be an https URL, e.g.: npm run sandbox:schedule -- https://cms.nextblock.dev');
  }
  const resetUrl = new URL('/api/cron/reset-sandbox', siteUrl).href;
  const schedule = option('schedule') || DEFAULT_SCHEDULE;
  const command = `
      select net.http_get(
        url := ${sqlLiteral(resetUrl)},
        headers := jsonb_build_object(
          'Authorization',
          'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = ${sqlLiteral(SECRET_NAME)})
        ),
        timeout_milliseconds := ${REQUEST_TIMEOUT_MS}
      )`;

  return { cronSecret, resetUrl, schedule, command };
}

/** The same statements the connected path runs, for pasting into the Supabase SQL editor. */
function printSql() {
  const { cronSecret, schedule, command } = scheduleInputs();
  process.stdout.write(
    [
      "-- Paste into the sandbox project's SQL editor (Supabase dashboard -> SQL). Safe to re-run.",
      'create extension if not exists pg_cron;',
      `${ENSURE_PG_NET_SQL};`,
      `delete from vault.secrets where name = ${sqlLiteral(SECRET_NAME)};`,
      `select vault.create_secret(${sqlLiteral(cronSecret)}, ${sqlLiteral(SECRET_NAME)}, 'Bearer token for /api/cron/reset-sandbox');`,
      `select cron.schedule(${sqlLiteral(JOB_NAME)}, ${sqlLiteral(schedule)}, $cmd$${command}\n$cmd$);`,
      '',
    ].join('\n')
  );
}

async function main() {
  if (process.env.NEXT_PUBLIC_IS_SANDBOX !== 'true') {
    fail('Refusing to touch the schedule because NEXT_PUBLIC_IS_SANDBOX is not true in .env.local.');
  }

  if (flag('print-sql')) {
    printSql();
    return;
  }

  const dbUrl =
    option('db') ||
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL;
  if (!dbUrl) fail('No database URL: set POSTGRES_URL_NON_POOLING (or POSTGRES_URL) or pass --db=...');

  const sql = postgres(dbUrl, {
    max: 1,
    ssl: 'require',
    onnotice() {
      // "extension already exists" and "no job to remove" notices are expected on re-runs.
    },
  });

  try {
    if (flag('status')) {
      await printStatus(sql);
      return;
    }

    if (flag('remove')) {
      await sql.unsafe(`
        do $$
        begin
          perform cron.unschedule(${sqlLiteral(JOB_NAME)});
        exception when others then
          raise notice 'no job to remove';
        end $$;
      `);
      await sql.unsafe(`delete from vault.secrets where name = ${sqlLiteral(SECRET_NAME)}`);
      console.log('\x1b[32m%s\x1b[0m', `Removed the ${JOB_NAME} job and its Vault secret.`);
      return;
    }

    const { cronSecret, resetUrl, schedule, command } = scheduleInputs();

    await sql.unsafe('create extension if not exists pg_cron');
    await sql.unsafe(ENSURE_PG_NET_SQL);

    // Vault has no upsert by name; replace so a rotated CRON_SECRET takes effect.
    await sql.unsafe(`delete from vault.secrets where name = ${sqlLiteral(SECRET_NAME)}`);
    await sql.unsafe(
      `select vault.create_secret(${sqlLiteral(cronSecret)}, ${sqlLiteral(SECRET_NAME)}, 'Bearer token for /api/cron/reset-sandbox')`
    );

    // cron.schedule replaces an existing job of the same name, so re-running is safe.
    const [{ schedule: jobId }] = await sql.unsafe(
      `select cron.schedule(${sqlLiteral(JOB_NAME)}, ${sqlLiteral(schedule)}, ${sqlLiteral(command)})`
    );

    console.log('\x1b[32m%s\x1b[0m', `Scheduled ${JOB_NAME} (job ${jobId}): "${schedule}" -> ${resetUrl}`);
    console.log('Check it with: npm run sandbox:schedule -- --status');
  } finally {
    await sql.end();
  }
}

async function printStatus(sql) {
  const jobs = await sql.unsafe(
    `select jobid, schedule, active from cron.job where jobname = ${sqlLiteral(JOB_NAME)}`
  );

  if (jobs.length === 0) {
    console.log(`No ${JOB_NAME} job is scheduled.`);
    return;
  }

  const job = jobs[0];
  console.log(`${JOB_NAME}: job ${job.jobid}, schedule "${job.schedule}", active=${job.active}`);

  const runs = await sql.unsafe(
    `select status, return_message, start_time, end_time
       from cron.job_run_details where jobid = ${Number(job.jobid)}
      order by start_time desc limit 5`
  );
  console.log('\nLast cron runs:');
  for (const run of runs) {
    console.log(`  ${run.start_time?.toISOString?.() ?? run.start_time}  ${run.status}  ${run.return_message ?? ''}`);
  }

  try {
    const responses = await sql.unsafe(
      `select id, status_code, error_msg, created
         from net._http_response order by id desc limit 5`
    );
    console.log('\nLast HTTP responses (pg_net):');
    for (const response of responses) {
      console.log(
        `  ${response.created?.toISOString?.() ?? response.created}  ${response.status_code ?? '-'}  ${response.error_msg ?? ''}`
      );
    }
  } catch {
    console.log('\n(pg_net response log not readable)');
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
