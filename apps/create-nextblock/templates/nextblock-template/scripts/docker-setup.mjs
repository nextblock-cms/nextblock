#!/usr/bin/env node
// Zero-dependency Docker setup for a standalone NextBlock project. Runs via `npm run docker:setup`
// (and is invoked automatically when you pick Docker mode in `npm create nextblock`). Uses only
// Node built-ins so it works before any host `npm install`.
//
// Self-hosted Supabase (GoTrue + PostgREST) validates REAL HS256 JWTs, so we generate a JWT
// secret and derive properly-signed anon/service_role keys from it — a random string is not a
// usable key. Then it writes .env and boots the stack via docker compose.

import { randomBytes, createHmac } from 'node:crypto';
import { readFile, writeFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const ENV_PATH = resolve(PROJECT_ROOT, '.env');

const TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA';
const TURNSTILE_TEST_SECRET_KEY = '1x0000000000000000000000000000000AA';

const generateSecret = () => randomBytes(32).toString('hex');
const base64url = (value) =>
  Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

function signJwtHS256(payload, secret) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  return `${data}.${base64url(createHmac('sha256', secret).update(data).digest())}`;
}

function generateSupabaseKeys() {
  const jwtSecret = generateSecret();
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 60 * 60 * 24 * 365 * 10;
  return {
    jwtSecret,
    anonKey: signJwtHS256({ role: 'anon', iss: 'supabase', iat, exp }, jwtSecret),
    serviceRoleKey: signJwtHS256({ role: 'service_role', iss: 'supabase', iat, exp }, jwtSecret),
  };
}

function readEnvValue(content, key) {
  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith(`${key}=`)) {
      return line.slice(key.length + 1).trim().replace(/^"(.*)"$/, '$1');
    }
  }
  return '';
}

function upsertEnv(content, replacements) {
  const applied = new Set();
  const lines = content.split(/\r?\n/).map((line) => {
    for (const [key, value] of Object.entries(replacements)) {
      if (line.startsWith(`${key}=`)) {
        applied.add(key);
        return value;
      }
    }
    return line;
  });
  for (const [key, value] of Object.entries(replacements)) {
    if (!applied.has(key)) lines.push(value);
  }
  return lines.join('\n');
}

const pathExists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

const commandWorks = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;

// Can the host PUBLISH (bind) this TCP port? Docker publishes on 0.0.0.0, and on Windows the
// Hyper-V/WinNAT excluded port ranges (which sit in the 49152+ ephemeral band — e.g. the default
// Postgres port 54322) or any process already holding the port make the bind fail with
// EACCES ("access permissions") / EADDRINUSE — exactly what `docker compose up` fails on. Probing
// here lets us pick a working host port BEFORE compose tries and aborts the whole stack.
function canBindPort(port) {
  return new Promise((res) => {
    const srv = createServer();
    srv.once('error', () => res(false));
    srv.once('listening', () => srv.close(() => res(true)));
    try {
      srv.listen(port, '0.0.0.0');
    } catch {
      res(false);
    }
  });
}

// Prefer the conventional port; if it's unavailable, fall back into the registered-port band
// (1024–49151, below the ephemeral range WinNAT reserves) rather than just incrementing — a
// reserved/used port often sits inside a contiguous block, so +1 tends to be taken too.
async function findAvailablePort(preferred, fallbackBase, taken) {
  const candidates = [preferred];
  for (let i = 0; i < 100; i++) candidates.push(fallbackBase + i);
  for (const p of candidates) {
    if (taken.has(p)) continue;
    if (await canBindPort(p)) {
      taken.add(p);
      return p;
    }
  }
  taken.add(preferred);
  return preferred; // give up gracefully — let compose surface the real error
}

function detectCompose() {
  if (commandWorks('docker', ['compose', 'version'])) return { cmd: 'docker', args: ['compose'] };
  if (commandWorks('docker-compose', ['version'])) return { cmd: 'docker-compose', args: [] };
  return null;
}

const run = (cmd, args, opts = {}) =>
  new Promise((res, rej) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      ...opts,
    });
    child.on('error', rej);
    child.on('close', (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited with ${code}`))));
  });

async function main() {
  console.log('🐳 NextBlock — Local Self-Hosted Docker Setup\n');

  if (!commandWorks('docker', ['info'])) {
    console.error('✗ Docker is not installed or not running. Start Docker Desktop, then re-run `npm run docker:setup`.');
    process.exit(1);
  }
  const compose = detectCompose();
  if (!compose) {
    console.error('✗ Docker Compose not found. Update Docker Desktop or install the Compose plugin.');
    process.exit(1);
  }

  // No CLI prompts. Bot protection (Turnstile) and SMTP are configured later in the browser
  // /setup wizard and CMS settings. Default to Turnstile TEST keys (always pass) and no SMTP,
  // so GoTrue auto-confirms new accounts and the first admin can sign in immediately.
  const turnstileSiteKey = TURNSTILE_TEST_SITE_KEY;
  const turnstileSecretKey = TURNSTILE_TEST_SECRET_KEY;
  const smtp = { host: '', port: '', user: '', pass: '', fromEmail: '', fromName: '' };
  const mailerAutoconfirm = 'true';

  let existing = '';
  if (await pathExists(ENV_PATH)) {
    existing = await readFile(ENV_PATH, 'utf8');
    console.log('\n✓ Found existing .env — reusing previously generated secrets where present.');
  }

  // Older installs wrote NEXT_PUBLIC_IS_SANDBOX=true, a leftover from the first Docker builds.
  // A self-hosted install is not the shared demo sandbox — that flag disables license activation
  // (the Cortex AI trial), MCP token minting, saving AI keys and the post-setup welcome flow —
  // so a stale line is dropped rather than carried forward. Unset means "not a sandbox".
  existing = existing
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('NEXT_PUBLIC_IS_SANDBOX='))
    .join('\n');

  const reuse = (key, gen) => readEnvValue(existing, key) || gen();

  const postgresPassword = reuse('POSTGRES_PASSWORD', generateSecret);
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

  // Headless install (`npm create nextblock -- --non-interactive`): the CLI hands its MCP
  // bearer token and the provisioned package key over through the process environment so
  // they land in the same .env compose reads. A value already in .env wins so re-runs never
  // rotate a token the agent configs were written with. Blank on a hand-driven install.
  const fromEnv = (key) => (process.env[key] || '').trim();
  const mcpBearerToken = readEnvValue(existing, 'MCP_BEARER_TOKEN') || fromEnv('MCP_BEARER_TOKEN');
  const licenseKey = readEnvValue(existing, 'NEXTBLOCK_LICENSE_KEY') || fromEnv('NEXTBLOCK_LICENSE_KEY');
  const licenseKind = readEnvValue(existing, 'NEXTBLOCK_LICENSE_KIND') || fromEnv('NEXTBLOCK_LICENSE_KIND');

  // Resolve host ports up front so a port that's in use or reserved by the OS (very common on
  // Windows for the default Postgres port 54322) never aborts `docker compose up`. Reuse a port
  // already encoded in .env — the explicit *_PORT* var, else the port parsed from a coupled URL —
  // so re-runs stay stable and never disturb an already-running stack; only a FRESH install probes
  // for free ports. Coupled ports (Kong/MinIO/app) also drive the URLs + loopback proxy below.
  const takenPorts = new Set();
  const reusedPort = (key, urlKey) => {
    const direct = parseInt(readEnvValue(existing, key), 10);
    if (Number.isInteger(direct) && direct > 0) return direct;
    if (urlKey) {
      const m = readEnvValue(existing, urlKey).match(/:(\d{2,5})(?:\/|$)/);
      if (m) return parseInt(m[1], 10);
    }
    return null;
  };
  const resolvePort = async (key, preferred, fallbackBase, urlKey) => {
    const prev = reusedPort(key, urlKey);
    if (prev) {
      takenPorts.add(prev);
      return prev;
    }
    if (existing) {
      // An existing .env with no recorded port: keep the default rather than reshuffle a setup
      // the user may already be running.
      takenPorts.add(preferred);
      return preferred;
    }
    return findAvailablePort(preferred, fallbackBase, takenPorts);
  };
  const appPort = await resolvePort('APP_PORT', 3000, 13000, 'NEXT_PUBLIC_URL');
  const kongPort = await resolvePort('KONG_HTTP_PORT', 8000, 18000, 'NEXT_PUBLIC_SUPABASE_URL');
  const minioS3Port = await resolvePort('MINIO_S3_PORT', 9000, 19000, 'R2_S3_PUBLIC_ENDPOINT');
  const minioConsolePort = await resolvePort('MINIO_CONSOLE_PORT', 9001, 19001, null);
  const dbPort = await resolvePort('POSTGRES_PORT_EXTERNAL', 54322, 15432, null);

  const replacements = {
    POSTGRES_PASSWORD: `POSTGRES_PASSWORD=${postgresPassword}`,
    POSTGRES_DB: 'POSTGRES_DB=postgres',
    JWT_SECRET: `JWT_SECRET=${jwtSecret}`,
    JWT_EXP: 'JWT_EXP=3600',
    ANON_KEY: `ANON_KEY=${anonKey}`,
    SERVICE_ROLE_KEY: `SERVICE_ROLE_KEY=${serviceRoleKey}`,
    // Host port mappings (compose reads these) + the coupled public URLs, kept in lockstep so a
    // remapped port stays consistent everywhere it's referenced.
    APP_PORT: `APP_PORT=${appPort}`,
    KONG_HTTP_PORT: `KONG_HTTP_PORT=${kongPort}`,
    MINIO_S3_PORT: `MINIO_S3_PORT=${minioS3Port}`,
    MINIO_CONSOLE_PORT: `MINIO_CONSOLE_PORT=${minioConsolePort}`,
    POSTGRES_PORT_EXTERNAL: `POSTGRES_PORT_EXTERNAL=${dbPort}`,
    // In-container loopback: server code hits localhost:<kongPort> / 127.0.0.1:<minioS3Port> and
    // socat forwards to the real service. Left ports MUST match the URLs below.
    LOOPBACK_PROXIES: `LOOPBACK_PROXIES=${kongPort}:kong:8000 ${minioS3Port}:minio:9000`,
    NEXT_PUBLIC_SUPABASE_URL: `NEXT_PUBLIC_SUPABASE_URL=http://localhost:${kongPort}`,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: `NEXT_PUBLIC_SUPABASE_ANON_KEY=${anonKey}`,
    SUPABASE_SERVICE_ROLE_KEY: `SUPABASE_SERVICE_ROLE_KEY=${serviceRoleKey}`,
    API_EXTERNAL_URL: `API_EXTERNAL_URL=http://localhost:${kongPort}`,
    SITE_URL: `SITE_URL=http://localhost:${appPort}`,
    NEXT_PUBLIC_URL: `NEXT_PUBLIC_URL=http://localhost:${appPort}`,
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
    R2_S3_PUBLIC_ENDPOINT: `R2_S3_PUBLIC_ENDPOINT=http://127.0.0.1:${minioS3Port}`,
    R2_FORCE_PATH_STYLE: 'R2_FORCE_PATH_STYLE=true',
    NEXT_PUBLIC_R2_BASE_URL: `NEXT_PUBLIC_R2_BASE_URL=http://127.0.0.1:${minioS3Port}/${bucket}`,
    NEXT_PUBLIC_R2_PUBLIC_URL: `NEXT_PUBLIC_R2_PUBLIC_URL=http://127.0.0.1:${minioS3Port}/${bucket}`,
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

  const seed = existing || '# Generated by `npm run docker:setup` — local self-hosted secrets. Do not commit.\n';
  let nextEnv = upsertEnv(seed, replacements);
  if (!nextEnv.endsWith('\n')) nextEnv += '\n';
  await writeFile(ENV_PATH, nextEnv, 'utf8');
  console.log('✓ Wrote .env (Postgres, JWT secret + signed anon/service keys, MinIO, app secrets).\n');

  const remapped = [
    appPort !== 3000 && `app ${appPort} (default 3000)`,
    kongPort !== 8000 && `Supabase API ${kongPort} (default 8000)`,
    minioS3Port !== 9000 && `MinIO S3 ${minioS3Port} (default 9000)`,
    minioConsolePort !== 9001 && `MinIO console ${minioConsolePort} (default 9001)`,
    dbPort !== 54322 && `Postgres ${dbPort} (default 54322)`,
  ].filter(Boolean);
  if (remapped.length) {
    console.log(
      `↔ Some default host ports were unavailable (in use, or reserved by the OS — common on Windows).\n  Remapped to free ports: ${remapped.join(', ')}.\n`,
    );
  }

  // A brand-new .env means brand-new secrets. Postgres only runs its init scripts (which set role
  // passwords) on an EMPTY volume, so a leftover volume from a previous install would keep the old
  // credentials and GoTrue/PostgREST could not log in. Reset volumes when the config is fresh.
  if (!existing) {
    console.log('Fresh configuration — clearing any previous local sandbox volume so the database matches the new credentials...');
    try {
      await run(compose.cmd, [...compose.args, 'down', '-v'], { cwd: PROJECT_ROOT });
    } catch {
      /* nothing to tear down */
    }
  }

  console.log('Building and starting the stack (first run pulls images + builds the app — a few minutes)...');
  await run(compose.cmd, [...compose.args, 'up', '-d', '--build'], { cwd: PROJECT_ROOT });

  console.log('\n🎉 Stack is up!');
  console.log(`  1. Open the app:    http://localhost:${appPort}`);
  console.log(`  2. Finish setup:    complete the browser wizard at http://localhost:${appPort}/setup`);
  console.log('                      (creates your first admin — auto-confirmed, no email needed).');
  console.log(`  3. Supabase API:    http://localhost:${kongPort}    MinIO console: http://localhost:${minioConsolePort}`);
  const composeStr = `${compose.cmd} ${compose.args.join(' ')}`.trim();
  console.log(`\n  Logs: ${composeStr} logs -f nextblock-cms   |   Stop: ${composeStr} down   (add -v to wipe data)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
