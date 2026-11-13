#!/usr/bin/env node
/**
 * Schedules the daily affiliate payout run (NextBlock Affiliates & Creator Storefronts) as a
 * pg_cron job inside the project's own Supabase database, so no cron has to live in
 * `vercel.json` (it ships to every 1-click install, and Hobby fails any deployment with a
 * sub-daily schedule) or in `.github/` (every fork inherits it).
 *
 * The job POSTs `/api/affiliates/cron/payouts` through pg_net with the CRON_SECRET read from
 * Supabase Vault (never written into the job command). Default schedule: daily at 06:00 UTC.
 * Without a scheduler the payouts still run: the CMS and partner portal layouts run a due day
 * after their response (`maybeRunAffiliatePayouts`), and the CMS has a "Run payouts now" button.
 *
 * It ships with the app, so a standalone project (`npm create nextblock`) has the same
 * `npm run affiliates:schedule-payouts` the CMS offers to copy; in the monorepo the root script
 * runs this file. Same shape as the monorepo's tools/scripts/schedule-sandbox-reset.js. pg_net
 * is created in `extensions` when it is missing; an existing install is left where it is (unlike
 * the sandbox, nothing here drops `public`, and other jobs or webhooks may use it).
 *
 * Reads `.env.local`, then `.env`, from the directory it runs in (npm runs a script from the
 * project root: the repo root in the monorepo), never overriding a variable already set:
 *   CRON_SECRET                    the bearer token the route expects (16+ characters)
 *   POSTGRES_URL_NON_POOLING       (or POSTGRES_URL / DATABASE_URL) the project database
 *   NEXT_PUBLIC_URL                the public site origin, unless given on the command line
 *   NEXT_PUBLIC_IS_SANDBOX=true    refuses to run (payouts are off in the sandbox)
 *
 *   npm run affiliates:schedule-payouts -- https://shop.example.com               # install / update
 *   npm run affiliates:schedule-payouts -- https://shop.example.com print-sql     # SQL for the dashboard
 *   npm run affiliates:schedule-payouts -- --schedule="30 7 * * *" https://shop.example.com
 *   npm run affiliates:schedule-payouts -- --hour=4 https://shop.example.com      # daily at 04:00 UTC
 *   npm run affiliates:schedule-payouts -- status    # job + last runs + last HTTP responses
 *   npm run affiliates:schedule-payouts -- remove    # unschedule and drop the Vault secret
 *   (the --status / --remove / --print-sql spellings work where npm passes them through)
 *
 * An http:// origin is refused except for a local development host (localhost, 127.0.0.1, [::1],
 * *.localhost, host.docker.internal for a local Supabase reaching the dev server).
 */
const fs = require('fs');
const path = require('path');

const JOB_NAME = 'affiliate-payouts';
const SECRET_NAME = 'affiliate_payouts_cron_secret';
const ROUTE_PATH = '/api/affiliates/cron/payouts';
const DEFAULT_SCHEDULE = '0 6 * * *';
// The route allows itself 60 s; pg_net's default 5 s would abandon the request mid-run.
const REQUEST_TIMEOUT_MS = 90_000;
const MIN_SECRET_LENGTH = 16;
const LOCAL_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', 'host.docker.internal']);

const ENSURE_PG_NET_SQL = 'create extension if not exists pg_net with schema extensions';

class ScheduleError extends Error {}

function fail(message) {
  console.error('\x1b[31m%s\x1b[0m', message);
  process.exit(1);
}

/** npm on some shells (PowerShell in particular) swallows "--flag" even after "--": accept every spelling. */
function parseArgs(argv) {
  const flags = new Set();
  const options = {};
  let positionalUrl;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        options[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--') && !/^https?:\/\//.test(argv[i + 1]) && !isModeWord(argv[i + 1])) {
        options[arg.slice(2)] = argv[i + 1];
        i += 1;
      } else {
        flags.add(arg.slice(2));
      }
    } else if (/^https?:\/\//.test(arg)) {
      positionalUrl = arg;
    } else if (isModeWord(arg)) {
      flags.add(arg);
    }
  }
  return { flags, options, positionalUrl };
}

function isModeWord(value) {
  return ['status', 'remove', 'print-sql'].includes(value);
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function isLocalHttpHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return LOCAL_HTTP_HOSTS.has(host) || host.endsWith('.localhost');
}

/** The cron route URL on `origin`; https, or http only for a local development host. */
function resolveCronUrl(origin) {
  let url;
  try {
    url = new URL(String(origin || ''));
  } catch {
    throw new ScheduleError('The site origin must be a URL, e.g.: npm run affiliates:schedule-payouts -- https://shop.example.com');
  }
  if (url.username || url.password) throw new ScheduleError('The site origin must not contain credentials.');
  if (url.protocol === 'http:' && !isLocalHttpHost(url.hostname)) {
    throw new ScheduleError(`Refusing http://${url.host}: the bearer token would travel in clear text. Use https.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ScheduleError('The site origin must be an https URL.');
  }
  return new URL(ROUTE_PATH, url.origin).href;
}

const CRON_FIELD = /^(\*|\d{1,2}(-\d{1,2})?)(\/\d{1,2})?(,(\*|\d{1,2}(-\d{1,2})?)(\/\d{1,2})?)*$/;

/** A five-field cron expression (digits, ranges, steps, lists), or the default. */
function resolveSchedule(options) {
  if (options.schedule !== undefined) {
    const schedule = String(options.schedule).trim().replace(/\s+/g, ' ');
    const fields = schedule.split(' ');
    if (fields.length !== 5 || !fields.every((field) => CRON_FIELD.test(field))) {
      throw new ScheduleError(`Not a five-field cron expression: "${options.schedule}" (example: "0 6 * * *").`);
    }
    return schedule;
  }
  if (options.hour !== undefined) {
    const hour = Number(options.hour);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new ScheduleError('--hour must be 0-23 (UTC).');
    return `0 ${hour} * * *`;
  }
  return DEFAULT_SCHEDULE;
}

/** The job command: POST with the bearer read from Vault at run time. */
function buildCommand(cronUrl) {
  return `
      select net.http_post(
        url := ${sqlLiteral(cronUrl)},
        body := '{}'::jsonb,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization',
          'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = ${sqlLiteral(SECRET_NAME)})
        ),
        timeout_milliseconds := ${REQUEST_TIMEOUT_MS}
      )`;
}

function scheduleInputs({ env, options, positionalUrl }) {
  const cronSecret = String(env.CRON_SECRET || '').trim();
  if (!cronSecret) throw new ScheduleError('CRON_SECRET is not set in .env.local.');
  if (cronSecret.length < MIN_SECRET_LENGTH) {
    throw new ScheduleError(`CRON_SECRET must be at least ${MIN_SECRET_LENGTH} characters (the route refuses shorter secrets).`);
  }
  const siteUrl = options.url || positionalUrl || env.NEXT_PUBLIC_URL;
  if (!siteUrl) {
    throw new ScheduleError('No site origin: npm run affiliates:schedule-payouts -- https://shop.example.com (or set NEXT_PUBLIC_URL).');
  }
  const cronUrl = resolveCronUrl(siteUrl);
  const schedule = resolveSchedule(options);
  return { cronSecret, cronUrl, schedule, command: buildCommand(cronUrl) };
}

/** The same statements the connected path runs, for pasting into the Supabase SQL editor. */
function buildPrintSql(inputs) {
  const { cronSecret, schedule, command } = inputs;
  return [
    "-- Paste into the project's SQL editor (Supabase dashboard -> SQL). Safe to re-run.",
    'create extension if not exists pg_cron;',
    `${ENSURE_PG_NET_SQL};`,
    `delete from vault.secrets where name = ${sqlLiteral(SECRET_NAME)};`,
    `select vault.create_secret(${sqlLiteral(cronSecret)}, ${sqlLiteral(SECRET_NAME)}, 'Bearer token for ${ROUTE_PATH}');`,
    `select cron.schedule(${sqlLiteral(JOB_NAME)}, ${sqlLiteral(schedule)}, $cmd$${command}\n$cmd$);`,
    '',
  ].join('\n');
}

/** The env files the script reads, in priority order, from the directory it runs in. */
function envFilesFor(cwd) {
  return [path.join(cwd, '.env.local'), path.join(cwd, '.env')];
}

/**
 * Loads the env files that exist in `cwd` (the first one to set a variable wins, and nothing
 * overrides the real environment). Returns the files it read.
 */
function loadEnvFiles(cwd = process.cwd()) {
  const loaded = [];
  for (const file of envFilesFor(cwd)) {
    if (!fs.existsSync(file)) continue;
    require('dotenv').config({ path: file, override: false, quiet: true });
    loaded.push(file);
  }
  return loaded;
}

function isLocalDatabaseUrl(dbUrl) {
  try {
    const host = new URL(dbUrl).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

async function printStatus(sql) {
  const jobs = await sql.unsafe(`select jobid, schedule, active from cron.job where jobname = ${sqlLiteral(JOB_NAME)}`);

  if (jobs.length === 0) {
    console.log(`No ${JOB_NAME} job is scheduled.`);
    return;
  }

  const job = jobs[0];
  console.log(`${JOB_NAME}: job ${job.jobid}, schedule "${job.schedule}" (UTC), active=${job.active}`);

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
    console.log('\nLast HTTP responses (pg_net, all jobs):');
    for (const response of responses) {
      console.log(
        `  ${response.created?.toISOString?.() ?? response.created}  ${response.status_code ?? '-'}  ${response.error_msg ?? ''}`
      );
    }
  } catch {
    console.log('\n(pg_net response log not readable)');
  }
}

async function main() {
  loadEnvFiles(process.cwd());

  if (process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') {
    fail('Refusing to schedule payouts: NEXT_PUBLIC_IS_SANDBOX is true (payouts never run in the sandbox).');
  }

  const { flags, options, positionalUrl } = parseArgs(process.argv.slice(2));
  const flag = (name) => flags.has(name);

  if (flag('print-sql')) {
    process.stdout.write(buildPrintSql(scheduleInputs({ env: process.env, options, positionalUrl })));
    return;
  }

  const dbUrl = options.db || process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!dbUrl) fail('No database URL: set POSTGRES_URL_NON_POOLING (or POSTGRES_URL) or pass --db=...');

  const postgres = require('postgres');
  const sql = postgres(dbUrl, {
    max: 1,
    ssl: isLocalDatabaseUrl(dbUrl) ? false : 'require',
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

    const inputs = scheduleInputs({ env: process.env, options, positionalUrl });

    await sql.unsafe('create extension if not exists pg_cron');
    await sql.unsafe(ENSURE_PG_NET_SQL);

    // Vault has no upsert by name; replace so a rotated CRON_SECRET takes effect.
    await sql.unsafe(`delete from vault.secrets where name = ${sqlLiteral(SECRET_NAME)}`);
    await sql.unsafe(
      `select vault.create_secret(${sqlLiteral(inputs.cronSecret)}, ${sqlLiteral(SECRET_NAME)}, 'Bearer token for ${ROUTE_PATH}')`
    );

    // cron.schedule replaces an existing job of the same name, so re-running is safe.
    const [{ schedule: jobId }] = await sql.unsafe(
      `select cron.schedule(${sqlLiteral(JOB_NAME)}, ${sqlLiteral(inputs.schedule)}, ${sqlLiteral(inputs.command)})`
    );

    console.log('\x1b[32m%s\x1b[0m', `Scheduled ${JOB_NAME} (job ${jobId}): "${inputs.schedule}" (UTC) -> POST ${inputs.cronUrl}`);
    console.log('Check it with: npm run affiliates:schedule-payouts -- status');
  } finally {
    await sql.end();
  }
}

/** The command-line entry: runs `main()`, exits 1 with a red message when it fails. */
function runCli() {
  return main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}

module.exports = {
  JOB_NAME,
  SECRET_NAME,
  DEFAULT_SCHEDULE,
  ScheduleError,
  parseArgs,
  resolveCronUrl,
  resolveSchedule,
  buildCommand,
  buildPrintSql,
  scheduleInputs,
  envFilesFor,
  loadEnvFiles,
  isLocalDatabaseUrl,
  runCli,
};

if (require.main === module) {
  runCli();
}
