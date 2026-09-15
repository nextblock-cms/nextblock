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
 * schema (`cron`, `net` and `vault` are untouched).
 *
 * Reads `.env.local` at the repo root (the same file `npm run sandbox:reset` uses):
 *   NEXT_PUBLIC_IS_SANDBOX=true    refuses to run otherwise
 *   CRON_SECRET                    the bearer token the route expects
 *   POSTGRES_URL_NON_POOLING       (or POSTGRES_URL / DATABASE_URL) the sandbox database
 *   NEXT_PUBLIC_URL                the public sandbox origin, unless --url is given
 *
 *   npm run sandbox:schedule                          # install / update the job
 *   npm run sandbox:schedule -- --url https://cms.nextblock.dev
 *   npm run sandbox:schedule -- --schedule "*\/30 * * * *"
 *   npm run sandbox:schedule -- --status              # job + last runs + last responses
 *   npm run sandbox:schedule -- --remove              # unschedule and drop the secret
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

const envPath = path.resolve(__dirname, '../../.env.local');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

function fail(message) {
  console.error('\x1b[31m%s\x1b[0m', message);
  process.exit(1);
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function main() {
  if (process.env.NEXT_PUBLIC_IS_SANDBOX !== 'true') {
    fail('Refusing to touch the schedule because NEXT_PUBLIC_IS_SANDBOX is not true in .env.local.');
  }

  const dbUrl =
    option('--db') ||
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL;
  if (!dbUrl) fail('No database URL: set POSTGRES_URL_NON_POOLING (or POSTGRES_URL) or pass --db.');

  const sql = postgres(dbUrl, {
    max: 1,
    ssl: 'require',
    onnotice() {
      // "extension already exists" and "no job to remove" notices are expected on re-runs.
    },
  });

  try {
    if (flag('--status')) {
      await printStatus(sql);
      return;
    }

    if (flag('--remove')) {
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

    const cronSecret = (process.env.CRON_SECRET || '').trim();
    if (!cronSecret) fail('CRON_SECRET is not set in .env.local.');

    const siteUrl = option('--url') || process.env.NEXT_PUBLIC_URL;
    if (!siteUrl || !/^https:\/\//.test(siteUrl)) {
      fail('The sandbox origin must be an https URL: pass --url https://... or set NEXT_PUBLIC_URL.');
    }
    const resetUrl = new URL('/api/cron/reset-sandbox', siteUrl).href;
    const schedule = option('--schedule') || DEFAULT_SCHEDULE;

    await sql.unsafe('create extension if not exists pg_cron');
    await sql.unsafe('create extension if not exists pg_net');

    // Vault has no upsert by name; replace so a rotated CRON_SECRET takes effect.
    await sql.unsafe(`delete from vault.secrets where name = ${sqlLiteral(SECRET_NAME)}`);
    await sql.unsafe(
      `select vault.create_secret(${sqlLiteral(cronSecret)}, ${sqlLiteral(SECRET_NAME)}, 'Bearer token for /api/cron/reset-sandbox')`
    );

    const command = `
      select net.http_get(
        url := ${sqlLiteral(resetUrl)},
        headers := jsonb_build_object(
          'Authorization',
          'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = ${sqlLiteral(SECRET_NAME)})
        ),
        timeout_milliseconds := ${REQUEST_TIMEOUT_MS}
      )`;

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
