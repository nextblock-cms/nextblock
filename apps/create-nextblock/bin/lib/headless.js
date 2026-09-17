// Headless (agent-driven) scaffolding helpers for `create-nextblock --non-interactive`.
//
// Everything here is plain Node with no prompts and no colours, so a coding agent that
// runs the CLI gets a deterministic contract: progress on stderr, one JSON document on
// stdout when the run succeeds, one JSON error document on stderr (exit code 1) when it
// does not. Secrets (the MCP bearer token, the license key, the admin password) are
// written to the project's env file and to the agent client configs; they are never
// printed.

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';

export const DEFAULT_LICENSE_SERVICE_URL = 'https://nextblock.dev';
export const TRIAL_REQUEST_TIMEOUT_MS = 5_000;
export const HEADLESS_MODES = ['docker', 'cloud'];
export const DEFAULT_HEADLESS_MODE = 'docker';
export const DEFAULT_PACKAGE_ID = 'cortex-ai';
export const MCP_SERVER_NAME = 'nextblock';

/**
 * The payload an agent reads when it passed only one of the unattended-mode credentials
 * (or an invalid email). Passing neither is not an error: the install then hands admin
 * creation and the Cortex AI trial to the browser setup wizard ("attended" mode).
 */
export const ONBOARDING_ERROR = Object.freeze({
  error: 'MISSING_ONBOARDING_CREDENTIALS',
  required: ['--name', '--email'],
  message:
    'Unattended mode needs both --name and a valid --email (they become the first administrator and the Cortex AI trial owner). Pass neither to let the user create their account and start the trial in the browser setup wizard instead.',
});

/**
 * Practical address check — the WHATWG form-validation pattern that browsers apply to
 * `<input type="email">`. A full RFC 5322 grammar accepts comments, quoted local parts
 * and addresses no mail server delivers to; this is what "valid email" means in practice.
 */
export const EMAIL_PATTERN =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

/** Directory-safe project names: no path separators, no leading dot, npm-ish characters. */
export const PROJECT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

/**
 * Environment-variable equivalents of the headless flags. They work through every shell
 * and every npm wrapper (`npm create`, `npm exec`, `npx`), which the flags do not: Windows
 * PowerShell strips the bare `--` that `npm create <pkg> -- --flag` relies on.
 */
export const HEADLESS_ENV_VARS = Object.freeze({
  email: 'NEXTBLOCK_EMAIL',
  licenseKey: 'NEXTBLOCK_LICENSE_KEY',
  mode: 'NEXTBLOCK_MODE',
  name: 'NEXTBLOCK_NAME',
  nonInteractive: 'NEXTBLOCK_NON_INTERACTIVE',
  projectName: 'NEXTBLOCK_PROJECT_NAME',
  trial: 'NEXTBLOCK_TRIAL',
});

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

function envFlag(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return TRUE_VALUES.has(normalized) ? true : FALSE_VALUES.has(normalized) ? false : undefined;
}

/** Read the headless inputs from the environment; absent variables are simply omitted. */
export function resolveHeadlessEnvOptions(env = process.env) {
  const resolved = {};
  const nonInteractive = envFlag(env[HEADLESS_ENV_VARS.nonInteractive]);

  if (nonInteractive !== undefined) {
    resolved.nonInteractive = nonInteractive;
  }

  for (const key of ['name', 'email', 'mode', 'projectName', 'licenseKey']) {
    const value = env[HEADLESS_ENV_VARS[key]];

    if (typeof value === 'string' && value.trim()) {
      resolved[key] = value.trim();
    }
  }

  const trial = envFlag(env[HEADLESS_ENV_VARS.trial]);

  if (trial !== undefined) {
    resolved.trial = trial;
  }

  return resolved;
}

/**
 * Command-line flags win; the environment fills whatever they left out. Only applied
 * once headless mode is on (by flag or by variable), so the interactive flow never
 * picks up stray variables.
 */
export function mergeHeadlessOptions(cliOptions = {}, env = process.env) {
  const fromEnv = resolveHeadlessEnvOptions(env);
  const nonInteractive = cliOptions.nonInteractive === true || fromEnv.nonInteractive === true;

  if (!nonInteractive) {
    return { ...cliOptions };
  }

  const merged = { ...cliOptions, nonInteractive: true };

  for (const key of ['name', 'email', 'mode', 'projectName', 'licenseKey']) {
    if ((merged[key] === undefined || merged[key] === '') && fromEnv[key] !== undefined) {
      merged[key] = fromEnv[key];
    }
  }

  // commander leaves `trial` undefined when `--no-trial` was not passed.
  if (merged.trial === undefined && fromEnv.trial !== undefined) {
    merged.trial = fromEnv.trial;
  }

  return merged;
}

/**
 * When a shell strips the `--` separator, npm parses `--non-interactive` as one of its own
 * config flags and forwards it as `npm_config_non_interactive=true` — while the CLI itself
 * never sees it. For an agent that would mean silently falling into interactive prompts,
 * so it is detected and refused with instructions instead.
 */
export function detectSwallowedHeadlessFlags(env = process.env) {
  return envFlag(env['npm_config_non_interactive']) === true;
}

export const SWALLOWED_FLAGS_ERROR = Object.freeze({
  error: 'FLAGS_NOT_DELIVERED',
  message:
    'npm consumed --non-interactive before it reached create-nextblock (Windows PowerShell strips the bare "--" in `npm create nextblock -- …`). Re-run as `npx create-nextblock@latest <dir> --non-interactive --name "<name>" --email <email>`, or set NEXTBLOCK_NON_INTERACTIVE=1, NEXTBLOCK_NAME and NEXTBLOCK_EMAIL in the environment.',
});

export class HeadlessError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'HeadlessError';
    this.code = code;
    this.extra = extra;
  }

  toPayload() {
    return { error: this.code, message: this.message, ...this.extra };
  }
}

export function isValidEmail(value) {
  return typeof value === 'string' && value.length <= 320 && EMAIL_PATTERN.test(value.trim());
}

/**
 * Validate the headless flags. Returns either the normalized values or the exact JSON
 * payload to print on stderr before exiting 1.
 */
export function validateHeadlessOptions(options = {}) {
  const name = typeof options.name === 'string' ? options.name.trim() : '';
  const email = typeof options.email === 'string' ? options.email.trim().toLowerCase() : '';

  // Neither given: attended mode — the human creates the administrator and starts the
  // trial in the browser, so no personal details ever pass through the agent.
  const attended = !name && !email;

  if (!attended && (!name || name.length > 120 || !isValidEmail(email))) {
    return { ok: false, error: { ...ONBOARDING_ERROR } };
  }

  const rawMode = typeof options.mode === 'string' ? options.mode.trim().toLowerCase() : '';
  const mode = rawMode || DEFAULT_HEADLESS_MODE;

  if (!HEADLESS_MODES.includes(mode)) {
    return {
      ok: false,
      error: {
        error: 'INVALID_MODE',
        allowed: HEADLESS_MODES,
        message: `--mode must be one of: ${HEADLESS_MODES.join(', ')} (received "${rawMode}").`,
      },
    };
  }

  const positional = typeof options.projectDirectory === 'string' ? options.projectDirectory.trim() : '';
  const flagged = typeof options.projectName === 'string' ? options.projectName.trim() : '';

  if (positional && flagged && positional !== flagged) {
    return {
      ok: false,
      error: {
        error: 'INVALID_PROJECT_NAME',
        message: `Conflicting project names: positional "${positional}" and --project-name "${flagged}". Pass one of them.`,
      },
    };
  }

  const projectName = flagged || positional || options.defaultProjectName || 'nextblock-cms';

  if (!PROJECT_NAME_PATTERN.test(projectName)) {
    return {
      ok: false,
      error: {
        error: 'INVALID_PROJECT_NAME',
        message: `"${projectName}" is not a valid project directory name (letters, digits, ".", "_" and "-" only).`,
      },
    };
  }

  const licenseKey =
    typeof options.licenseKey === 'string' && options.licenseKey.trim() ? options.licenseKey.trim() : null;

  return {
    ok: true,
    value: {
      attended,
      email: attended ? null : email,
      licenseKey,
      mode,
      name: attended ? null : name,
      projectName,
      // commander turns `--no-trial` into `trial: false`; absent means true. Attended
      // installs never request a vendor key: the browser trial is a real Freemius trial.
      trial: !attended && options.trial !== false,
    },
  };
}

/** One JSON document, one line, on stderr. Agents parse it; humans can still read it. */
export function emitJsonError(payload, stream = process.stderr) {
  stream.write(`${JSON.stringify(payload)}\n`);
}

export function emitJsonResult(payload, stream = process.stdout) {
  stream.write(`${JSON.stringify(payload, null, 2)}\n`);
}

/** 32 random bytes as hex: 64 characters, 256 bits of entropy. */
export function generateMcpBearerToken() {
  return randomBytes(32).toString('hex');
}

/** 24 URL-safe characters; comfortably above the 8-character minimum the app enforces. */
export function generateAdminPassword() {
  return randomBytes(18).toString('base64url');
}

/** Is a Docker engine reachable from this shell? Cheap preflight before any scaffolding. */
export function checkDockerAvailable({ spawn = spawnSync, platform = process.platform } = {}) {
  const shell = platform === 'win32';
  const info = spawn('docker', ['info'], { shell, stdio: 'ignore' });

  if (info.error || info.status !== 0) {
    return {
      ok: false,
      message:
        'Docker is not installed or the Docker engine is not running. Start Docker Desktop and retry, or pass --mode cloud.',
    };
  }

  const compose = spawn('docker', ['compose', 'version'], { shell, stdio: 'ignore' });

  if (compose.error || compose.status !== 0) {
    const legacy = spawn('docker-compose', ['version'], { shell, stdio: 'ignore' });

    if (legacy.error || legacy.status !== 0) {
      return {
        ok: false,
        message: 'Docker Compose was not found. Update Docker Desktop or install the Compose plugin.',
      };
    }
  }

  return { ok: true };
}

/**
 * Ask the NextBlock license service for a trial key. Never throws: every failure comes
 * back as `{ ok: false, code, message }` so the scaffold can carry on without a license
 * and tell the agent what happened. The 5-second budget is deliberate — a slow vendor
 * must not stall a local install.
 */
export async function requestTrialLicense({
  cliVersion = 'unknown',
  email,
  fetchImpl = globalThis.fetch,
  name,
  packageId = DEFAULT_PACKAGE_ID,
  serviceUrl = DEFAULT_LICENSE_SERVICE_URL,
  timeoutMs = TRIAL_REQUEST_TIMEOUT_MS,
} = {}) {
  const endpoint = `${String(serviceUrl).replace(/\/+$/, '')}/api/packages/provision-trial`;

  let response;

  try {
    response = await fetchImpl(endpoint, {
      body: JSON.stringify({ email, name, packageId }),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': `create-nextblock/${cliVersion}`,
      },
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';

    return {
      ok: false,
      code: timedOut ? 'TRIAL_REQUEST_TIMEOUT' : 'TRIAL_SERVICE_UNREACHABLE',
      message: timedOut
        ? `The license service did not answer within ${timeoutMs} ms.`
        : `The license service could not be reached: ${error?.message ?? 'network error'}.`,
    };
  }

  let body = null;

  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (response.ok && body?.ok && typeof body.licenseKey === 'string' && body.licenseKey.trim()) {
    return {
      ok: true,
      expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : null,
      kind: body.kind === 'paid' ? 'paid' : 'trial',
      licenseKey: body.licenseKey.trim(),
      packageId: typeof body.packageId === 'string' ? body.packageId : packageId,
      trialDays: Number.isFinite(body.trialDays) ? body.trialDays : null,
    };
  }

  const codeFromBody = typeof body?.code === 'string' ? body.code : null;
  const code =
    codeFromBody ??
    (response.status === 404
      ? 'TRIAL_SERVICE_UNAVAILABLE'
      : response.status === 429
        ? 'RATE_LIMITED'
        : response.status >= 500
          ? 'TRIAL_SERVICE_ERROR'
          : 'TRIAL_REQUEST_REJECTED');

  return {
    ok: false,
    code,
    message:
      typeof body?.error === 'string'
        ? body.error
        : `The license service answered ${response.status} without a usable body.`,
    status: response.status,
  };
}

/** Read a `KEY=` value from an .env body (tolerates surrounding quotes and CRLF). */
export function readEnvValue(content, key) {
  for (const line of String(content ?? '').split(/\r?\n/)) {
    if (line.startsWith(`${key}=`)) {
      return line.slice(key.length + 1).trim().replace(/^"(.*)"$/, '$1');
    }
  }

  return '';
}

/** Replace or append `KEY=value` lines. Keeps every other line exactly as it was. */
export function upsertEnvContent(content, values) {
  const pending = new Map(Object.entries(values).map(([key, value]) => [key, `${key}=${value ?? ''}`]));
  const original = String(content ?? '');
  const lines = original === '' ? [] : original.split(/\r?\n/);

  const merged = lines.map((line) => {
    for (const [key, replacement] of pending) {
      if (line.startsWith(`${key}=`)) {
        pending.delete(key);
        return replacement;
      }
    }

    return line;
  });

  while (merged.length > 0 && merged[merged.length - 1] === '') {
    merged.pop();
  }

  for (const replacement of pending.values()) {
    merged.push(replacement);
  }

  return `${merged.join('\n')}\n`;
}

export async function readEnvFile(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

export async function upsertEnvFile(path, values, { header } = {}) {
  const existing = await readEnvFile(path);
  const seed = existing || (header ? `${header}\n` : '');

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, upsertEnvContent(seed, values), 'utf8');
}

/** The app URL the Docker stack chose (docker-setup may remap port 3000 when it is taken). */
export function resolveAppUrlFromEnv(envContent, fallback = 'http://localhost:3000') {
  const explicit = readEnvValue(envContent, 'NEXT_PUBLIC_URL');

  if (explicit) {
    return explicit.replace(/\/+$/, '');
  }

  const port = parseInt(readEnvValue(envContent, 'APP_PORT'), 10);

  return Number.isInteger(port) && port > 0 ? `http://localhost:${port}` : fallback;
}

/* -------------------------------------------------------------------------- */
/* Agent client configuration                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Same shapes as the CMS's own copy-paste snippets (app/cms/settings/cortex-ai/
 * mcp-client-snippets.ts): Claude Code needs `"type": "http"` or it silently skips the
 * server; Cursor infers the transport from the URL. The token is written literally on
 * purpose — both clients expand `${VAR}` from the shell environment only, never from a
 * project `.env`, so a placeholder would never resolve.
 */
export function buildAgentMcpConfigs({ token, url }) {
  const headers = { Authorization: `Bearer ${token}` };

  return {
    claudeCode: {
      mcpServers: { [MCP_SERVER_NAME]: { headers, type: 'http', url } },
    },
    cursor: {
      mcpServers: { [MCP_SERVER_NAME]: { headers, url } },
    },
  };
}

/** Claude Code's supported way of keeping env files out of the model's context. */
export const CLAUDE_ENV_DENY_RULES = ['Read(./.env)', 'Read(./.env.*)'];

export function mergeClaudeSettings(existing) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {};
  const permissions =
    base.permissions && typeof base.permissions === 'object' && !Array.isArray(base.permissions)
      ? { ...base.permissions }
      : {};
  const deny = Array.isArray(permissions.deny) ? [...permissions.deny] : [];

  for (const rule of CLAUDE_ENV_DENY_RULES) {
    if (!deny.includes(rule)) {
      deny.push(rule);
    }
  }

  permissions.deny = deny;
  base.permissions = permissions;

  const enabled = Array.isArray(base.enabledMcpjsonServers) ? [...base.enabledMcpjsonServers] : [];

  if (!enabled.includes(MCP_SERVER_NAME)) {
    enabled.push(MCP_SERVER_NAME);
  }

  base.enabledMcpjsonServers = enabled;

  return base;
}

export const CURSOR_IGNORE_LINES = ['.env', '.env.*'];

export function mergeIgnoreFile(existing, lines) {
  const current = String(existing ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim());
  const additions = lines.filter((line) => !current.includes(line));

  if (additions.length === 0) {
    return existing ?? '';
  }

  const head = String(existing ?? '').replace(/\s+$/, '');

  return `${head ? `${head}\n` : ''}${additions.join('\n')}\n`;
}

async function readJsonIfExists(path) {
  if (!existsSync(path)) {
    return null;
  }

  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Guardrails that make sense on every scaffold, token or not: Claude Code is denied
 * reads of `.env*` through its permission system (there is no `.claudeignore`), and
 * Cursor gets a `.cursorignore` for the same files.
 */
export async function writeAgentGuardrails(projectDir) {
  const written = [];

  const claudeSettingsPath = resolve(projectDir, '.claude', 'settings.json');
  await writeJson(claudeSettingsPath, mergeClaudeSettings(await readJsonIfExists(claudeSettingsPath)));
  written.push('.claude/settings.json');

  const cursorIgnorePath = resolve(projectDir, '.cursorignore');
  const existingIgnore = existsSync(cursorIgnorePath) ? await readFile(cursorIgnorePath, 'utf8') : '';
  await writeFile(cursorIgnorePath, mergeIgnoreFile(existingIgnore, CURSOR_IGNORE_LINES), 'utf8');
  written.push('.cursorignore');

  return written;
}

/** The MCP client configs, only when a token exists. Both files are gitignored by the scaffold. */
export async function writeAgentMcpConfigs(projectDir, { token, url }) {
  const configs = buildAgentMcpConfigs({ token, url });

  await writeJson(resolve(projectDir, '.mcp.json'), configs.claudeCode);
  await writeJson(resolve(projectDir, '.cursor', 'mcp.json'), configs.cursor);

  return ['.mcp.json', '.cursor/mcp.json'];
}

/* -------------------------------------------------------------------------- */
/* Readiness and bootstrap                                                     */
/* -------------------------------------------------------------------------- */

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Poll GET /api/setup/status until `report[until]` is true. Network errors and non-JSON
 * answers are treated as "not yet" — the app container may still be starting.
 */
export async function waitForReadiness(
  statusUrl,
  { fetchImpl = globalThis.fetch, intervalMs = 3_000, onTick, timeoutMs = 5 * 60_000, until = 'dbReady' } = {}
) {
  const deadline = Date.now() + timeoutMs;
  let lastReport = null;
  let lastError = null;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt += 1;

    try {
      const response = await fetchImpl(statusUrl, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(Math.min(intervalMs * 3, 15_000)),
      });
      const body = await response.json().catch(() => null);

      if (body && typeof body === 'object') {
        lastReport = body;
        lastError = null;

        if (body[until] === true) {
          return { ok: true, attempts: attempt, report: body };
        }
      } else {
        lastError = `HTTP ${response.status} without a JSON body`;
      }
    } catch (error) {
      lastError = error?.message ?? 'network error';
    }

    if (typeof onTick === 'function') {
      onTick({ attempt, lastError, lastReport });
    }

    await sleep(intervalMs);
  }

  return {
    ok: false,
    attempts: attempt,
    code: 'STACK_NOT_READY',
    lastError,
    message: `Timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${statusUrl} to report ${until}=true.`,
    report: lastReport,
  };
}

/** POST /api/setup/bootstrap with the env token: creates the first admin, activates the license. */
export async function bootstrapInstance({ admin, appUrl, fetchImpl = globalThis.fetch, token, timeoutMs = 90_000 }) {
  const endpoint = `${String(appUrl).replace(/\/+$/, '')}/api/setup/bootstrap`;

  try {
    const response = await fetchImpl(endpoint, {
      body: JSON.stringify({ admin }),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json().catch(() => null);

    if (response.ok && body?.ok) {
      return { ok: true, body };
    }

    return {
      ok: false,
      code: 'BOOTSTRAP_FAILED',
      message:
        typeof body?.error === 'string' ? body.error : `The bootstrap endpoint answered ${response.status}.`,
      status: response.status,
      body,
    };
  } catch (error) {
    return {
      ok: false,
      code: 'BOOTSTRAP_FAILED',
      message: `The bootstrap request failed: ${error?.message ?? 'network error'}.`,
      status: null,
      body: null,
    };
  }
}

/** Strip anything secret-shaped out of a readiness report before echoing it to stdout. */
export function summarizeReadiness(report) {
  if (!report || typeof report !== 'object') {
    return null;
  }

  const { initialized, dbReady, mcpReady, channel, license, mcp, nextSteps } = report;

  return {
    channel: channel ?? null,
    dbReady: dbReady === true,
    initialized: initialized === true,
    license: license && typeof license === 'object' ? { cortexAi: license.cortexAi ?? null } : null,
    mcp:
      mcp && typeof mcp === 'object'
        ? { authMethods: Array.isArray(mcp.authMethods) ? mcp.authMethods : [], endpoint: mcp.endpoint ?? '/api/mcp' }
        : null,
    mcpReady: mcpReady === true,
    nextSteps: Array.isArray(nextSteps) ? nextSteps : [],
  };
}
