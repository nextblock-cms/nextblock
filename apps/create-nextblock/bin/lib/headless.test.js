import { describe, expect, it } from 'vitest';

import {
  CLAUDE_ENV_DENY_RULES,
  ONBOARDING_ERROR,
  SWALLOWED_FLAGS_ERROR,
  buildAgentMcpConfigs,
  bootstrapInstance,
  detectSwallowedHeadlessFlags,
  mergeHeadlessOptions,
  resolveHeadlessEnvOptions,
  generateAdminPassword,
  generateMcpBearerToken,
  isValidEmail,
  mergeClaudeSettings,
  mergeIgnoreFile,
  readEnvValue,
  requestTrialLicense,
  resolveAppUrlFromEnv,
  summarizeReadiness,
  upsertEnvContent,
  validateHeadlessOptions,
  waitForReadiness,
} from './headless.js';

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe('validateHeadlessOptions', () => {
  it('runs attended when neither credential is given: no trial request, the browser does the rest', () => {
    const result = validateHeadlessOptions({});

    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({ attended: true, email: null, name: null, trial: false, mode: 'docker' });
  });

  it('refuses a half-given or invalid credential pair with the agent-facing payload', () => {
    expect(validateHeadlessOptions({ name: 'Test Developer' })).toEqual({ ok: false, error: ONBOARDING_ERROR });
    expect(validateHeadlessOptions({ email: 'dev@example.com' })).toEqual({ ok: false, error: ONBOARDING_ERROR });
    expect(validateHeadlessOptions({ name: 'Test Developer', email: 'not-an-email' })).toEqual({
      ok: false,
      error: ONBOARDING_ERROR,
    });
    expect(validateHeadlessOptions({ name: '   ', email: 'dev@example.com' })).toEqual({
      ok: false,
      error: ONBOARDING_ERROR,
    });
  });

  it('runs unattended with both credentials, defaults to docker mode and normalizes the email', () => {
    const result = validateHeadlessOptions({ name: ' Test Developer ', email: 'Dev@Example.com' });

    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({
      attended: false,
      email: 'dev@example.com',
      mode: 'docker',
      name: 'Test Developer',
      projectName: 'nextblock-cms',
      trial: true,
      licenseKey: null,
    });
  });

  it('rejects an unknown mode', () => {
    const result = validateHeadlessOptions({ name: 'T', email: 'dev@example.com', mode: 'k8s' });

    expect(result.ok).toBe(false);
    expect(result.error.error).toBe('INVALID_MODE');
    expect(result.error.allowed).toEqual(['docker', 'cloud']);
  });

  it('accepts --project-name or the positional argument, but not two different ones', () => {
    expect(
      validateHeadlessOptions({ name: 'T', email: 'dev@example.com', projectName: 'my-site' }).value.projectName
    ).toBe('my-site');
    expect(
      validateHeadlessOptions({ name: 'T', email: 'dev@example.com', projectDirectory: 'my-site' }).value
        .projectName
    ).toBe('my-site');

    const conflict = validateHeadlessOptions({
      name: 'T',
      email: 'dev@example.com',
      projectDirectory: 'a',
      projectName: 'b',
    });
    expect(conflict.ok).toBe(false);
    expect(conflict.error.error).toBe('INVALID_PROJECT_NAME');
  });

  it('rejects project names that are paths', () => {
    const result = validateHeadlessOptions({ name: 'T', email: 'dev@example.com', projectName: '../escape' });

    expect(result.ok).toBe(false);
    expect(result.error.error).toBe('INVALID_PROJECT_NAME');
  });

  it('honours --no-trial and --license-key', () => {
    const result = validateHeadlessOptions({
      name: 'T',
      email: 'dev@example.com',
      trial: false,
      licenseKey: ' sk_test ',
    });

    expect(result.value.trial).toBe(false);
    expect(result.value.licenseKey).toBe('sk_test');
  });
});

describe('environment-variable inputs', () => {
  it('reads the NEXTBLOCK_* variables and ignores blanks', () => {
    expect(
      resolveHeadlessEnvOptions({
        NEXTBLOCK_NON_INTERACTIVE: '1',
        NEXTBLOCK_NAME: ' Ada ',
        NEXTBLOCK_EMAIL: 'ada@example.com',
        NEXTBLOCK_MODE: 'cloud',
        NEXTBLOCK_PROJECT_NAME: '',
        NEXTBLOCK_TRIAL: 'false',
      })
    ).toEqual({ nonInteractive: true, name: 'Ada', email: 'ada@example.com', mode: 'cloud', trial: false });
    expect(resolveHeadlessEnvOptions({})).toEqual({});
  });

  it('lets flags win and fills the gaps from the environment only in headless mode', () => {
    const merged = mergeHeadlessOptions(
      { nonInteractive: true, name: 'Flag Name', skipInstall: true },
      { NEXTBLOCK_NAME: 'Env Name', NEXTBLOCK_EMAIL: 'env@example.com', NEXTBLOCK_TRIAL: '0' }
    );

    expect(merged).toEqual({
      nonInteractive: true,
      name: 'Flag Name',
      email: 'env@example.com',
      skipInstall: true,
      trial: false,
    });

    // Headless switched on by the variable alone.
    expect(mergeHeadlessOptions({}, { NEXTBLOCK_NON_INTERACTIVE: 'true', NEXTBLOCK_EMAIL: 'x@example.com' })).toEqual({
      nonInteractive: true,
      email: 'x@example.com',
    });

    // Interactive runs never pick up stray variables.
    expect(mergeHeadlessOptions({ yes: true }, { NEXTBLOCK_EMAIL: 'x@example.com' })).toEqual({ yes: true });
  });

  it('detects a --non-interactive flag that npm swallowed', () => {
    expect(detectSwallowedHeadlessFlags({ npm_config_non_interactive: 'true' })).toBe(true);
    expect(detectSwallowedHeadlessFlags({})).toBe(false);
    expect(SWALLOWED_FLAGS_ERROR.error).toBe('FLAGS_NOT_DELIVERED');
    expect(SWALLOWED_FLAGS_ERROR.message).toContain('npx create-nextblock@latest');
  });
});

describe('email validation', () => {
  it('accepts ordinary addresses and rejects the usual mistakes', () => {
    expect(isValidEmail('dev@example.com')).toBe(true);
    expect(isValidEmail('first.last+tag@sub.example.co.uk')).toBe(true);
    expect(isValidEmail('dev@localhost')).toBe(false);
    expect(isValidEmail('dev@@example.com')).toBe(false);
    expect(isValidEmail('dev example@example.com')).toBe(false);
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail(undefined)).toBe(false);
  });
});

describe('secrets', () => {
  it('generates a 64-hex-character MCP token and a password above the 8-character minimum', () => {
    expect(generateMcpBearerToken()).toMatch(/^[0-9a-f]{64}$/);
    expect(generateMcpBearerToken()).not.toBe(generateMcpBearerToken());
    expect(generateAdminPassword().length).toBeGreaterThanOrEqual(20);
  });
});

describe('env file editing', () => {
  it('replaces existing keys, appends new ones, and preserves other lines', () => {
    const next = upsertEnvContent('A=1\nMCP_BEARER_TOKEN=old\n# comment\n', {
      MCP_BEARER_TOKEN: 'new',
      NEXTBLOCK_LICENSE_KEY: 'key',
    });

    expect(next).toBe('A=1\nMCP_BEARER_TOKEN=new\n# comment\nNEXTBLOCK_LICENSE_KEY=key\n');
    expect(readEnvValue(next, 'MCP_BEARER_TOKEN')).toBe('new');
    expect(readEnvValue('X="quoted"\r\n', 'X')).toBe('quoted');
  });

  it('starts an empty file cleanly', () => {
    expect(upsertEnvContent('', { A: '1' })).toBe('A=1\n');
  });

  it('reads the app URL the Docker stack chose, including a remapped port', () => {
    expect(resolveAppUrlFromEnv('NEXT_PUBLIC_URL=http://localhost:13000/\n')).toBe('http://localhost:13000');
    expect(resolveAppUrlFromEnv('APP_PORT=13001\n')).toBe('http://localhost:13001');
    expect(resolveAppUrlFromEnv('')).toBe('http://localhost:3000');
  });
});

describe('agent client configuration', () => {
  it('writes the Claude Code shape with type http and the Cursor shape without it', () => {
    const configs = buildAgentMcpConfigs({ token: 'abc', url: 'http://localhost:3000/api/mcp' });

    expect(configs.claudeCode).toEqual({
      mcpServers: {
        nextblock: {
          headers: { Authorization: 'Bearer abc' },
          type: 'http',
          url: 'http://localhost:3000/api/mcp',
        },
      },
    });
    expect(configs.cursor.mcpServers.nextblock).not.toHaveProperty('type');
    expect(configs.cursor.mcpServers.nextblock.headers.Authorization).toBe('Bearer abc');
  });

  it('adds the env deny rules and the server approval to existing Claude settings without clobbering them', () => {
    const merged = mergeClaudeSettings({
      permissions: { allow: ['Bash(npm test)'], deny: ['Read(./.env)'] },
      model: 'opus',
    });

    expect(merged.model).toBe('opus');
    expect(merged.permissions.allow).toEqual(['Bash(npm test)']);
    expect(merged.permissions.deny).toEqual(CLAUDE_ENV_DENY_RULES);
    expect(merged.enabledMcpjsonServers).toEqual(['nextblock']);
    expect(mergeClaudeSettings(null).permissions.deny).toEqual(CLAUDE_ENV_DENY_RULES);
  });

  it('appends ignore lines only once', () => {
    const once = mergeIgnoreFile('node_modules\n', ['.env', '.env.*']);
    expect(once).toBe('node_modules\n.env\n.env.*\n');
    expect(mergeIgnoreFile(once, ['.env', '.env.*'])).toBe(once);
  });
});

describe('requestTrialLicense', () => {
  it('returns the key on success and never throws on failure', async () => {
    const ok = await requestTrialLicense({
      email: 'dev@example.com',
      name: 'Test Developer',
      serviceUrl: 'https://vendor.test/',
      fetchImpl: async (url, init) => {
        expect(url).toBe('https://vendor.test/api/packages/provision-trial');
        expect(JSON.parse(init.body)).toEqual({ email: 'dev@example.com', name: 'Test Developer', packageId: 'cortex-ai' });
        return jsonResponse(200, { ok: true, licenseKey: 'sk_trial', kind: 'trial', expiresAt: '2026-10-17 00:00:00', trialDays: 30 });
      },
    });
    expect(ok).toEqual({
      ok: true,
      expiresAt: '2026-10-17 00:00:00',
      kind: 'trial',
      licenseKey: 'sk_trial',
      packageId: 'cortex-ai',
      trialDays: 30,
    });

    const used = await requestTrialLicense({
      email: 'dev@example.com',
      name: 'T',
      fetchImpl: async () => jsonResponse(409, { ok: false, code: 'TRIAL_ALREADY_USED', error: 'already used' }),
    });
    expect(used).toMatchObject({ ok: false, code: 'TRIAL_ALREADY_USED', status: 409 });

    const missing = await requestTrialLicense({
      email: 'dev@example.com',
      name: 'T',
      fetchImpl: async () => jsonResponse(404, { ok: false, error: 'Not found.' }),
    });
    expect(missing).toMatchObject({ ok: false, code: 'TRIAL_SERVICE_UNAVAILABLE' });

    const down = await requestTrialLicense({
      email: 'dev@example.com',
      name: 'T',
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(down).toMatchObject({ ok: false, code: 'TRIAL_SERVICE_UNREACHABLE' });
  });

  it('gives up after the timeout budget', async () => {
    const result = await requestTrialLicense({
      email: 'dev@example.com',
      name: 'T',
      timeoutMs: 20,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        }),
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('TRIAL_REQUEST_TIMEOUT');
  });
});

describe('readiness polling and bootstrap', () => {
  it('polls until the requested flag is true, tolerating connection errors first', async () => {
    let calls = 0;
    const result = await waitForReadiness('http://localhost:3000/api/setup/status', {
      intervalMs: 1,
      timeoutMs: 2_000,
      until: 'dbReady',
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) throw new Error('ECONNREFUSED');
        if (calls === 2) return jsonResponse(503, { initialized: false, dbReady: false });
        return jsonResponse(503, { initialized: false, dbReady: true });
      },
    });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(3);
    expect(result.report.dbReady).toBe(true);
  });

  it('times out with the last report attached', async () => {
    const result = await waitForReadiness('http://localhost:3000/api/setup/status', {
      intervalMs: 1,
      timeoutMs: 15,
      until: 'mcpReady',
      fetchImpl: async () => jsonResponse(503, { mcpReady: false, nextSteps: ['x'] }),
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('STACK_NOT_READY');
    expect(result.report.nextSteps).toEqual(['x']);
  });

  it('sends the bearer token and the admin payload to the bootstrap route', async () => {
    const result = await bootstrapInstance({
      admin: { email: 'dev@example.com', fullName: 'Test Developer', password: 'p'.repeat(12) },
      appUrl: 'http://localhost:3000/',
      token: 'tok',
      fetchImpl: async (url, init) => {
        expect(url).toBe('http://localhost:3000/api/setup/bootstrap');
        expect(init.headers.Authorization).toBe('Bearer tok');
        expect(JSON.parse(init.body).admin.email).toBe('dev@example.com');
        return jsonResponse(200, { ok: true, admin: { created: true } });
      },
    });

    expect(result.ok).toBe(true);
    expect(result.body.admin.created).toBe(true);

    const refused = await bootstrapInstance({
      admin: {},
      appUrl: 'http://localhost:3000',
      token: 'tok',
      fetchImpl: async () => jsonResponse(401, { ok: false, error: 'nope' }),
    });
    expect(refused).toMatchObject({ ok: false, code: 'BOOTSTRAP_FAILED', status: 401, message: 'nope' });
  });

  it('strips everything but the readiness facts from a report', () => {
    expect(
      summarizeReadiness({
        initialized: true,
        dbReady: true,
        mcpReady: false,
        channel: 'docker',
        license: { cortexAi: 'inactive', env: { error: 'secret-ish detail' } },
        mcp: { authMethods: ['env-token'], endpoint: '/api/mcp', envTokenConfigured: true },
        nextSteps: ['do x'],
        extra: 'dropped',
      })
    ).toEqual({
      channel: 'docker',
      dbReady: true,
      initialized: true,
      license: { cortexAi: 'inactive' },
      mcp: { authMethods: ['env-token'], endpoint: '/api/mcp' },
      mcpReady: false,
      nextSteps: ['do x'],
    });
  });
});
