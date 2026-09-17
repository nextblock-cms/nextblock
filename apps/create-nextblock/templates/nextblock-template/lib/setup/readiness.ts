// Pure assembly of the readiness report served by GET /api/setup/status. Kept free of
// I/O so the shape a coding agent polls for is unit-testable without a database.

import type { DeployChannel } from './env-status';
import type { ProvisioningStatus } from './provisioning';
import type { EnvLicenseStatus } from '../packages/env-license';

export type McpAuthMethod = 'admin-session' | 'db-token' | 'env-token' | 'localhost';

export type ReadinessInput = {
  /** NEXT_PUBLIC_URL when configured; links in `nextSteps` fall back to relative paths. */
  appUrl?: string | null;
  channel: DeployChannel;
  /** Whether Cortex AI is active right now (after any env-seeded activation attempt). */
  cortexAiActive: boolean;
  envLicense: EnvLicenseStatus;
  mcp: {
    /** The database `enabled` flag from CMS Settings → Cortex AI. */
    enabled: boolean;
    envTokenConfigured: boolean;
    /** Whether the settings would trust a loopback caller without a token. */
    localhostTrust: boolean;
  };
  provisioning: ProvisioningStatus;
  /** True when the process runs with NODE_ENV=production (localhost trust is off then). */
  production: boolean;
};

export type ReadinessReport = {
  /** Supabase connected, schema applied and a first admin exists. */
  initialized: boolean;
  /** Core tables exist (migrations applied). */
  dbReady: boolean;
  /** `/api/mcp` will accept a correctly authenticated call right now. */
  mcpReady: boolean;
  channel: DeployChannel;
  checkedAt: string;
  configured: boolean;
  hasAdmin: boolean;
  schemaReady: boolean;
  /**
   * Where a human finishes what an agent cannot: creating the administrator account
   * (`setupUrl`) and starting the free Cortex AI trial (`welcomeUrl`). Present so an
   * agent can relay exact links instead of guessing.
   */
  handoff: {
    /** True when MCP_BEARER_TOKEN is set — the install was made for an agent. */
    agentInitiated: boolean;
    setupUrl: string;
    welcomeUrl: string;
  };
  license: {
    cortexAi: 'active' | 'inactive';
    env: EnvLicenseStatus;
  };
  mcp: {
    authMethods: McpAuthMethod[];
    enabled: boolean;
    endpoint: '/api/mcp';
    envTokenConfigured: boolean;
  };
  nextSteps: string[];
};

/**
 * Which ways into `/api/mcp` are open, given the settings. Mirrors the priority order
 * in the route's `authenticateMcpRequest`, so this list is documentation the agent can
 * trust rather than a guess.
 */
export function resolveMcpAuthMethods(input: ReadinessInput['mcp'] & { production: boolean }): McpAuthMethod[] {
  const methods: McpAuthMethod[] = [];

  if (input.envTokenConfigured) {
    methods.push('env-token');
  }

  if (input.enabled) {
    methods.push('db-token', 'admin-session');

    if (input.localhostTrust && !input.production) {
      methods.push('localhost');
    }
  }

  return methods;
}

export function buildReadinessReport(input: ReadinessInput, now: Date = new Date()): ReadinessReport {
  const { provisioning } = input;
  const initialized = provisioning.configured && provisioning.schemaReady && provisioning.hasAdmin;
  const authMethods = resolveMcpAuthMethods({ ...input.mcp, production: input.production });
  const mcpReady = initialized && input.cortexAiActive && authMethods.length > 0;
  const agentInitiated = input.mcp.envTokenConfigured;
  const base = (input.appUrl ?? '').trim().replace(/\/+$/, '');
  const setupUrl = `${base}/setup`;
  const welcomeUrl = `${base}/cms/welcome`;

  const nextSteps: string[] = [];

  if (!provisioning.configured) {
    nextSteps.push(`Connect Supabase: open ${setupUrl} in a browser, or set NEXT_PUBLIC_SUPABASE_URL and the keys in .env.local and restart.`);
  } else if (!provisioning.schemaReady) {
    nextSteps.push(
      input.channel === 'docker'
        ? 'Database migrations are still being applied by the migrate container; poll again in a few seconds.'
        : `Apply the database schema: finish the setup wizard at ${setupUrl} (it runs the migrations) or run \`npm run db:migrate\`.`
    );
  } else if (!provisioning.hasAdmin) {
    nextSteps.push(
      agentInitiated
        ? `Ask the user to open ${setupUrl} in a browser and create their administrator account; the welcome screen that follows offers the free 30-day Cortex AI trial, which unlocks the MCP server. Keep polling this endpoint until "mcpReady" is true. (Unattended alternative when you already hold the user's name and email: POST /api/setup/bootstrap with the MCP_BEARER_TOKEN.)`
        : `Create the first administrator by finishing the setup wizard at ${setupUrl}.`
    );
  }

  if (initialized && !input.cortexAiActive) {
    if (input.envLicense.state === 'failed') {
      nextSteps.push(`The NEXTBLOCK_LICENSE_KEY could not be activated (${input.envLicense.error ?? 'unknown error'}). Start or activate the Cortex AI trial from ${welcomeUrl} or /cms/settings/packages.`);
    } else if (input.envLicense.state === 'unknown_package') {
      nextSteps.push('NEXTBLOCK_LICENSE_PACKAGE names an unknown package; use cortex-ai or ecommerce.');
    } else {
      nextSteps.push(
        agentInitiated
          ? `Cortex AI is not active yet. Ask the user to sign in and start the free 30-day trial (no credit card) at ${welcomeUrl}; the MCP server unlocks the moment it activates. Keep polling this endpoint until "mcpReady" is true.`
          : `Cortex AI is not active: start the free 30-day trial (or activate a key) from ${welcomeUrl} or /cms/settings/packages. The MCP server requires it.`
      );
    }
  }

  if (initialized && input.cortexAiActive && authMethods.length === 0) {
    nextSteps.push('Enable the MCP server and mint a token in CMS Settings → Cortex AI, or set MCP_BEARER_TOKEN in the environment and restart.');
  }

  if (mcpReady) {
    nextSteps.push('Ready: send JSON-RPC to POST /api/mcp with your bearer token (tools/list, then tools/call).');
  }

  return {
    channel: input.channel,
    checkedAt: now.toISOString(),
    configured: provisioning.configured,
    dbReady: provisioning.schemaReady,
    handoff: { agentInitiated, setupUrl, welcomeUrl },
    hasAdmin: provisioning.hasAdmin,
    initialized,
    license: {
      cortexAi: input.cortexAiActive ? 'active' : 'inactive',
      env: input.envLicense,
    },
    mcp: {
      authMethods,
      enabled: input.mcp.enabled,
      endpoint: '/api/mcp',
      envTokenConfigured: input.mcp.envTokenConfigured,
    },
    mcpReady,
    nextSteps,
    schemaReady: provisioning.schemaReady,
  };
}
