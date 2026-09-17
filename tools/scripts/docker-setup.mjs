// `npm run docker:setup` — one entry point for the Local Self-Hosted Docker Mode.
//
// Non-interactive bootstrap: preflights Docker, generates a root `.env` with secure random
// secrets and PROPERLY-SIGNED Supabase anon/service keys, then builds and starts the full stack
// (Postgres + GoTrue + PostgREST + Kong + MinIO + the migration runner + the Next.js app) via
// docker-compose.yml. Integrations (Cloudflare Turnstile, SMTP) and the first admin are now
// configured in the browser First-Boot Setup Wizard at /setup — there are no terminal prompts.
// Re-runnable: existing generated secrets are reused so your data/keys stay stable across runs.

import fs from 'fs-extra';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import chalk from 'chalk';
import {
  generateSecret,
  generateSupabaseKeys,
  readEnvValue,
  upsertEnv,
} from './lib/supabase-keys.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');
const ENV_PATH = resolve(REPO_ROOT, '.env');

// Cloudflare's official "always passes" Turnstile test keys — the skip / sandbox fallback.
const TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA';
const TURNSTILE_TEST_SECRET_KEY = '1x0000000000000000000000000000000AA';

async function ensureDockerRunning() {
  try {
    await execa('docker', ['info']);
    return true;
  } catch {
    return false;
  }
}

async function detectComposeCommand() {
  // Prefer Docker Compose v2 (`docker compose`); fall back to the legacy `docker-compose`.
  try {
    await execa('docker', ['compose', 'version']);
    return { cmd: 'docker', args: ['compose'] };
  } catch {
    /* try legacy next */
  }
  try {
    await execa('docker-compose', ['version']);
    return { cmd: 'docker-compose', args: [] };
  } catch {
    return null;
  }
}

async function main() {
  console.log(chalk.bold.green('🐳 NextBlock™ CMS — Local Self-Hosted Docker Setup'));
  console.log(
    chalk.gray(
      'Generates a root .env with secure local secrets and boots the full Supabase + app stack.',
    ),
  );
  console.log('');

  // 0. Preflight.
  if (!(await ensureDockerRunning())) {
    console.error(chalk.red('✗ Docker does not appear to be installed or running.'));
    console.log(
      chalk.gray(
        '  Install Docker Desktop (https://www.docker.com/products/docker-desktop), start it, then re-run `npm run docker:setup`.',
      ),
    );
    process.exit(1);
  }
  const compose = await detectComposeCommand();
  if (!compose) {
    console.error(
      chalk.red('✗ Could not find Docker Compose. Update Docker Desktop or install the Compose plugin.'),
    );
    process.exit(1);
  }

  // 1. Read any existing .env first so we can preserve previously generated secrets AND any
  //    integration values already set (idempotent re-runs).
  let existing = '';
  if (await fs.pathExists(ENV_PATH)) {
    existing = await fs.readFile(ENV_PATH, 'utf8');
    console.log(chalk.blue('✓ Found existing .env — reusing previously generated secrets where present.'));
  }

  // Older installs wrote NEXT_PUBLIC_IS_SANDBOX=true, a leftover from the first Docker builds.
  // A self-hosted install is not the shared demo sandbox — that flag disables license activation
  // (the Cortex AI trial), MCP token minting, saving AI keys and the post-setup welcome flow —
  // so a stale line is dropped rather than carried forward. Unset means "not a sandbox".
  existing = existing
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('NEXT_PUBLIC_IS_SANDBOX='))
    .join('\n');

  // Integrations (Cloudflare Turnstile, SMTP) and the first admin are configured later in the
  // browser /setup wizard, not here. Default to Turnstile test keys (always pass) and no SMTP so
  // the stack boots cleanly and the first admin can be created without an email round-trip
  // (GoTrue auto-confirms). Existing .env values are preserved.
  const turnstileSiteKey =
    readEnvValue(existing, 'NEXT_PUBLIC_TURNSTILE_SITE_KEY') || TURNSTILE_TEST_SITE_KEY;
  const turnstileSecretKey =
    readEnvValue(existing, 'TURNSTILE_SECRET_KEY') || TURNSTILE_TEST_SECRET_KEY;
  const smtp = {
    host: readEnvValue(existing, 'SMTP_HOST'),
    port: readEnvValue(existing, 'SMTP_PORT'),
    user: readEnvValue(existing, 'SMTP_USER'),
    pass: readEnvValue(existing, 'SMTP_PASS'),
    fromEmail: readEnvValue(existing, 'SMTP_FROM_EMAIL'),
    fromName: readEnvValue(existing, 'SMTP_FROM_NAME'),
  };
  const mailerAutoconfirm = smtp.host ? 'false' : 'true';
  console.log(
    chalk.gray(
      '  → Turnstile test keys + no SMTP (auto-confirm). Configure real values later in /setup or CMS settings.',
    ),
  );

  // 2. Assemble .env, reusing already-generated secrets so re-runs are idempotent.
  const reuse = (key, gen) => readEnvValue(existing, key) || gen();

  const postgresPassword = reuse('POSTGRES_PASSWORD', generateSecret);
  // anon/service keys MUST be signed with JWT_SECRET, so regenerate the trio together unless all
  // three already exist (keeping them consistent with each other).
  let jwtSecret = readEnvValue(existing, 'JWT_SECRET');
  let anonKey = readEnvValue(existing, 'ANON_KEY');
  let serviceRoleKey = readEnvValue(existing, 'SERVICE_ROLE_KEY');
  if (!jwtSecret || !anonKey || !serviceRoleKey) {
    ({ jwtSecret, anonKey, serviceRoleKey } = generateSupabaseKeys());
  }
  const cronSecret = reuse('CRON_SECRET', generateSecret);
  const draftSecret = reuse('DRAFT_MODE_SECRET', generateSecret);
  const revalidateSecret = reuse('REVALIDATE_SECRET_TOKEN', generateSecret);
  const minioUser = readEnvValue(existing, 'MINIO_ROOT_USER') || 'nextblock';
  const minioPassword = reuse('MINIO_ROOT_PASSWORD', generateSecret);
  const bucket = readEnvValue(existing, 'STORAGE_BUCKET') || 'nextblock';

  // Headless install parity with the standalone template's docker-setup: an MCP bearer token
  // and a package key handed over through the process environment land in the same .env
  // compose reads. A value already in .env wins so re-runs never rotate a token.
  const fromEnv = (key) => (process.env[key] || '').trim();
  const mcpBearerToken = readEnvValue(existing, 'MCP_BEARER_TOKEN') || fromEnv('MCP_BEARER_TOKEN');
  const licenseKey = readEnvValue(existing, 'NEXTBLOCK_LICENSE_KEY') || fromEnv('NEXTBLOCK_LICENSE_KEY');
  const licenseKind = readEnvValue(existing, 'NEXTBLOCK_LICENSE_KIND') || fromEnv('NEXTBLOCK_LICENSE_KIND');

  const replacements = {
    POSTGRES_PASSWORD: `POSTGRES_PASSWORD=${postgresPassword}`,
    POSTGRES_DB: 'POSTGRES_DB=postgres',
    JWT_SECRET: `JWT_SECRET=${jwtSecret}`,
    JWT_EXP: 'JWT_EXP=3600',
    ANON_KEY: `ANON_KEY=${anonKey}`,
    SERVICE_ROLE_KEY: `SERVICE_ROLE_KEY=${serviceRoleKey}`,
    NEXT_PUBLIC_SUPABASE_URL: 'NEXT_PUBLIC_SUPABASE_URL=http://localhost:8000',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: `NEXT_PUBLIC_SUPABASE_ANON_KEY=${anonKey}`,
    SUPABASE_SERVICE_ROLE_KEY: `SUPABASE_SERVICE_ROLE_KEY=${serviceRoleKey}`,
    API_EXTERNAL_URL: 'API_EXTERNAL_URL=http://localhost:8000',
    SITE_URL: 'SITE_URL=http://localhost:3000',
    NEXT_PUBLIC_URL: 'NEXT_PUBLIC_URL=http://localhost:3000',
    NEXTBLOCK_BUILD_MIGRATE: 'NEXTBLOCK_BUILD_MIGRATE=1',
    CRON_SECRET: `CRON_SECRET=${cronSecret}`,
    DRAFT_MODE_SECRET: `DRAFT_MODE_SECRET=${draftSecret}`,
    REVALIDATE_SECRET_TOKEN: `REVALIDATE_SECRET_TOKEN=${revalidateSecret}`,
    MINIO_ROOT_USER: `MINIO_ROOT_USER=${minioUser}`,
    MINIO_ROOT_PASSWORD: `MINIO_ROOT_PASSWORD=${minioPassword}`,
    STORAGE_BUCKET: `STORAGE_BUCKET=${bucket}`,
    R2_ACCOUNT_ID: 'R2_ACCOUNT_ID=minio',
    R2_REGION: 'R2_REGION=us-east-1',
    R2_S3_ENDPOINT: 'R2_S3_ENDPOINT=http://minio:9000',
    // Storage URLs use 127.0.0.1 (NOT localhost) on purpose: on localhost, cookies aren't
    // port-scoped, so the browser would send the app's Supabase auth cookies to MinIO too — and
    // MinIO rejects oversized header sets (MetadataTooLarge), breaking image display once cookies
    // grow. 127.0.0.1 is a different cookie host, so the browser never sends them there.
    R2_S3_PUBLIC_ENDPOINT: 'R2_S3_PUBLIC_ENDPOINT=http://127.0.0.1:9000',
    R2_FORCE_PATH_STYLE: 'R2_FORCE_PATH_STYLE=true',
    NEXT_PUBLIC_R2_BASE_URL: `NEXT_PUBLIC_R2_BASE_URL=http://127.0.0.1:9000/${bucket}`,
    NEXT_PUBLIC_R2_PUBLIC_URL: `NEXT_PUBLIC_R2_PUBLIC_URL=http://127.0.0.1:9000/${bucket}`,
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: `NEXT_PUBLIC_TURNSTILE_SITE_KEY=${turnstileSiteKey}`,
    TURNSTILE_SECRET_KEY: `TURNSTILE_SECRET_KEY=${turnstileSecretKey}`,
    GOTRUE_MAILER_AUTOCONFIRM: `GOTRUE_MAILER_AUTOCONFIRM=${mailerAutoconfirm}`,
    SMTP_HOST: `SMTP_HOST=${smtp.host}`,
    SMTP_PORT: `SMTP_PORT=${smtp.port}`,
    SMTP_USER: `SMTP_USER=${smtp.user}`,
    SMTP_PASS: `SMTP_PASS=${smtp.pass}`,
    SMTP_FROM_EMAIL: `SMTP_FROM_EMAIL=${smtp.fromEmail}`,
    SMTP_FROM_NAME: `SMTP_FROM_NAME=${smtp.fromName}`,
    MCP_BEARER_TOKEN: `MCP_BEARER_TOKEN=${mcpBearerToken}`,
    NEXTBLOCK_LICENSE_KEY: `NEXTBLOCK_LICENSE_KEY=${licenseKey}`,
    NEXTBLOCK_LICENSE_KIND: `NEXTBLOCK_LICENSE_KIND=${licenseKind}`,
  };

  const seed =
    existing ||
    '# Generated by `npm run docker:setup` — local self-hosted secrets. Do not commit.\n';
  let nextEnv = upsertEnv(seed, replacements);
  if (!nextEnv.endsWith('\n')) nextEnv += '\n';
  await fs.writeFile(ENV_PATH, nextEnv, 'utf8');
  console.log(
    chalk.green('✓ Wrote .env (Postgres, JWT secret + signed anon/service keys, MinIO, app secrets).'),
  );

  // 3. Build + start.
  // A brand-new .env means brand-new secrets. Postgres only runs its init scripts (which set the
  // role passwords) on an EMPTY volume, so a leftover volume from a previous install would still
  // hold the old credentials — and GoTrue/PostgREST could not log in. Reset volumes in that case.
  if (!existing) {
    console.log(
      chalk.gray(
        'Fresh configuration — clearing any previous local sandbox volume so the database matches the new credentials...',
      ),
    );
    try {
      await execa(compose.cmd, [...compose.args, 'down', '-v'], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
      });
    } catch {
      /* nothing to tear down — fine */
    }
  }

  console.log(
    chalk.blue(
      '\nBuilding and starting the stack (first run pulls images + builds the app — give it a few minutes)...',
    ),
  );
  try {
    await execa(compose.cmd, [...compose.args, 'up', '-d', '--build'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
  } catch {
    console.error(chalk.red('\n✗ docker compose failed — see the output above.'));
    process.exit(1);
  }

  // 4. Next steps.
  const composeStr = `${compose.cmd} ${compose.args.join(' ')}`.trim();
  console.log(chalk.green('\n🎉 Stack is up!'));
  console.log('');
  console.log(chalk.bold('Next steps:'));
  console.log(`  1. Open the app:    ${chalk.cyan('http://localhost:3000')}`);
  console.log(
    `  2. Finish setup:    ${chalk.gray('it redirects to')} ${chalk.cyan('http://localhost:3000/setup')}`,
  );
  console.log(
    chalk.gray(
      '     The First-Boot Setup Wizard creates your first administrator (storage is pre-filled with MinIO).',
    ),
  );
  console.log(
    `  3. Supabase API:    ${chalk.cyan('http://localhost:8000')}   ${chalk.gray('MinIO console:')} ${chalk.cyan('http://localhost:9001')}`,
  );
  console.log('');
  console.log(
    chalk.gray(
      `  Logs: ${composeStr} logs -f nextblock-cms   |   Stop: ${composeStr} down   (add -v to wipe data)`,
    ),
  );
}

main().catch((err) => {
  console.error(chalk.red('Unexpected error:'), err);
  process.exit(1);
});
