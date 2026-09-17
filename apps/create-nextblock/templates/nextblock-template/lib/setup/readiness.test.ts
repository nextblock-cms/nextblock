import { describe, expect, it } from 'vitest';

import { buildReadinessReport, resolveMcpAuthMethods, type ReadinessInput } from './readiness';

const envLicense = (state: ReadinessInput['envLicense']['state'], error: string | null = null) => ({
  attemptedAt: null,
  configured: state !== 'not_configured',
  error,
  kind: null,
  packageId: 'cortex-ai',
  state,
});

const base = (overrides: Partial<ReadinessInput> = {}): ReadinessInput => ({
  channel: 'docker',
  cortexAiActive: true,
  envLicense: envLicense('active'),
  mcp: { enabled: false, envTokenConfigured: true, localhostTrust: true },
  production: true,
  provisioning: { configured: true, schemaReady: true, hasAdmin: true },
  ...overrides,
});

describe('resolveMcpAuthMethods', () => {
  it('lists the env token whether or not the database flag is on', () => {
    expect(resolveMcpAuthMethods({ enabled: false, envTokenConfigured: true, localhostTrust: true, production: true })).toEqual([
      'env-token',
    ]);
  });

  it('adds database tokens and admin sessions once enabled, and localhost only outside production', () => {
    expect(resolveMcpAuthMethods({ enabled: true, envTokenConfigured: false, localhostTrust: true, production: true })).toEqual([
      'db-token',
      'admin-session',
    ]);
    expect(resolveMcpAuthMethods({ enabled: true, envTokenConfigured: false, localhostTrust: true, production: false })).toEqual([
      'db-token',
      'admin-session',
      'localhost',
    ]);
    expect(resolveMcpAuthMethods({ enabled: false, envTokenConfigured: false, localhostTrust: true, production: false })).toEqual([]);
  });
});

describe('buildReadinessReport', () => {
  it('is ready when the instance is initialized, licensed and has an auth method', () => {
    const report = buildReadinessReport(base(), new Date('2026-09-17T12:00:00Z'));

    expect(report).toMatchObject({
      initialized: true,
      dbReady: true,
      mcpReady: true,
      checkedAt: '2026-09-17T12:00:00.000Z',
      license: { cortexAi: 'active' },
      mcp: { authMethods: ['env-token'], endpoint: '/api/mcp', envTokenConfigured: true },
    });
    expect(report.nextSteps[0]).toMatch(/^Ready/);
  });

  it('is not initialized before the first admin exists and tells the agent to hand off to the browser', () => {
    const report = buildReadinessReport(
      base({ appUrl: 'http://localhost:3000/', provisioning: { configured: true, schemaReady: true, hasAdmin: false } })
    );

    expect(report.initialized).toBe(false);
    expect(report.dbReady).toBe(true);
    expect(report.mcpReady).toBe(false);
    expect(report.handoff).toEqual({
      agentInitiated: true,
      setupUrl: 'http://localhost:3000/setup',
      welcomeUrl: 'http://localhost:3000/cms/welcome',
    });
    expect(report.nextSteps[0]).toContain('Ask the user to open http://localhost:3000/setup');
    expect(report.nextSteps[0]).toContain('/api/setup/bootstrap');
  });

  it('tells the agent to have the user start the trial once the admin exists', () => {
    const report = buildReadinessReport(base({ cortexAiActive: false, envLicense: envLicense('not_configured') }));

    expect(report.mcpReady).toBe(false);
    expect(report.nextSteps[0]).toContain('/cms/welcome');
    expect(report.nextSteps[0]).toContain('Keep polling');
  });

  it('uses relative links and plain wording when no agent token is configured', () => {
    const report = buildReadinessReport(
      base({
        mcp: { enabled: true, envTokenConfigured: false, localhostTrust: false },
        provisioning: { configured: true, schemaReady: true, hasAdmin: false },
      })
    );

    expect(report.handoff.agentInitiated).toBe(false);
    expect(report.handoff.setupUrl).toBe('/setup');
    expect(report.nextSteps[0]).toBe('Create the first administrator by finishing the setup wizard at /setup.');
  });

  it('points a Docker install at the migrate container while the schema is missing', () => {
    const report = buildReadinessReport(
      base({ provisioning: { configured: true, schemaReady: false, hasAdmin: false } })
    );

    expect(report.dbReady).toBe(false);
    expect(report.nextSteps[0]).toContain('migrate container');
  });

  it('reports a failed environment license instead of a generic trial hint', () => {
    const report = buildReadinessReport(
      base({ cortexAiActive: false, envLicense: envLicense('failed', 'invalid key') })
    );

    expect(report.mcpReady).toBe(false);
    expect(report.license.cortexAi).toBe('inactive');
    expect(report.nextSteps[0]).toContain('invalid key');
  });

  it('asks for a token when licensed but with no way to authenticate', () => {
    const report = buildReadinessReport(
      base({ mcp: { enabled: false, envTokenConfigured: false, localhostTrust: false } })
    );

    expect(report.mcpReady).toBe(false);
    expect(report.mcp.authMethods).toEqual([]);
    expect(report.nextSteps[0]).toContain('MCP_BEARER_TOKEN');
  });

  it('never echoes secrets: the report carries only booleans, states and guidance', () => {
    const report = buildReadinessReport(base());
    const serialized = JSON.stringify(report);

    expect(serialized).not.toMatch(/token_hash|secret|password/i);
  });
});
