import { describe, expect, it, vi } from 'vitest';

import {
  CORTEX_AI_MCP_SETTINGS_DEFAULTS,
  normalizeCortexAiMcpSettings,
  resolveCortexAiMcpTokenActor,
  revokeCortexAiMcpTokensForUser,
  shouldTrustLocalMcpRequest,
} from './mcp-tokens';

/**
 * These lock in the closed-by-default posture for the tokenless loopback path
 * (security remediation): a fresh install, or any install that never wrote the
 * `cortex_ai_mcp_settings` row, must require a bearer token on every origin. The
 * endpoint layers two more opt-ins on top (the NEXTBLOCK_MCP_TRUST_LOCALHOST
 * environment variable and a forwarded-peer-is-loopback check), but this is the
 * dashboard half, and it now starts off.
 */
describe('Cortex AI MCP localhost-trust defaults', () => {
  it('defaults allowLocalhostWithoutToken to false (and the server to disabled)', () => {
    expect(CORTEX_AI_MCP_SETTINGS_DEFAULTS.allowLocalhostWithoutToken).toBe(false);
    expect(CORTEX_AI_MCP_SETTINGS_DEFAULTS.enabled).toBe(false);
  });

  it('falls back to the closed default when the key is absent or not a boolean', () => {
    expect(normalizeCortexAiMcpSettings(undefined).allowLocalhostWithoutToken).toBe(false);
    expect(normalizeCortexAiMcpSettings({}).allowLocalhostWithoutToken).toBe(false);
    expect(normalizeCortexAiMcpSettings({ enabled: true }).allowLocalhostWithoutToken).toBe(false);
    expect(
      normalizeCortexAiMcpSettings({ allowLocalhostWithoutToken: 'yes' }).allowLocalhostWithoutToken
    ).toBe(false);
  });

  it('still honours an explicit opt-in so operators who turned it on keep it', () => {
    expect(
      normalizeCortexAiMcpSettings({ allowLocalhostWithoutToken: true }).allowLocalhostWithoutToken
    ).toBe(true);
  });

  it('refuses tokenless localhost trust under the default settings, even on loopback in dev', () => {
    try {
      vi.stubEnv('NODE_ENV', 'development');
      expect(
        shouldTrustLocalMcpRequest({
          hostHeader: 'localhost:4200',
          settings: { ...CORTEX_AI_MCP_SETTINGS_DEFAULTS },
        })
      ).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

function profileStub(profile: { role: string } | null, error: unknown = null) {
  const reads: Array<{ column: string; table: string; value: unknown }> = [];
  return {
    reads,
    supabase: {
      from: (table: string) => ({
        select: () => ({
          eq: (column: string, value: unknown) => {
            reads.push({ column, table, value });
            return { maybeSingle: async () => ({ data: profile, error }) };
          },
        }),
      }),
    },
  };
}

/**
 * 2026-10-21: the endpoint acted as `token.created_by` without re-reading that account's
 * role, so a token minted by an admin who was later demoted (or deleted, with a fallback
 * admin substituted) kept its full scope.
 */
describe('resolveCortexAiMcpTokenActor', () => {
  it('acts as the creator only while the creator is still an ADMIN', async () => {
    const admin = profileStub({ role: 'ADMIN' });
    await expect(resolveCortexAiMcpTokenActor(admin.supabase, { created_by: 'admin-1' })).resolves.toBe('admin-1');
    expect(admin.reads).toEqual([{ column: 'id', table: 'profiles', value: 'admin-1' }]);

    for (const role of ['WRITER', 'USER']) {
      await expect(
        resolveCortexAiMcpTokenActor(profileStub({ role }).supabase, { created_by: 'admin-1' })
      ).resolves.toBeNull();
    }

    await expect(resolveCortexAiMcpTokenActor(profileStub(null).supabase, { created_by: 'gone-1' })).resolves.toBeNull();
  });

  it('refuses an orphaned token instead of substituting another admin', async () => {
    const stub = profileStub({ role: 'ADMIN' });

    await expect(resolveCortexAiMcpTokenActor(stub.supabase, { created_by: null })).resolves.toBeNull();
    expect(stub.reads).toEqual([]);
  });

  it('throws on a lookup failure so the endpoint reports an outage, not a bad token', async () => {
    await expect(
      resolveCortexAiMcpTokenActor(profileStub(null, { message: 'connection reset' }).supabase, { created_by: 'admin-1' })
    ).rejects.toThrow(/connection reset/);
  });
});

describe('revokeCortexAiMcpTokensForUser', () => {
  it('stamps revoked_at on every live token the user minted', async () => {
    const calls: unknown[] = [];
    const chain = {
      eq: (column: string, value: unknown) => {
        calls.push(['eq', column, value]);
        return chain;
      },
      is: async (column: string, value: unknown) => {
        calls.push(['is', column, value]);
        return { error: null };
      },
    };
    const supabase = {
      from: (table: string) => {
        calls.push(['from', table]);
        return {
          update: (values: unknown) => {
            calls.push(['update', values]);
            return chain;
          },
        };
      },
    };
    const now = new Date('2026-10-21T12:00:00.000Z');

    await expect(revokeCortexAiMcpTokensForUser(supabase, 'admin-1', now)).resolves.toEqual({ error: null });
    expect(calls).toEqual([
      ['from', 'mcp_access_tokens'],
      ['update', { revoked_at: '2026-10-21T12:00:00.000Z' }],
      ['eq', 'created_by', 'admin-1'],
      ['is', 'revoked_at', null],
    ]);
  });

  it('reports a failed revoke', async () => {
    const supabase = {
      from: () => ({
        update: () => ({ eq: () => ({ is: async () => ({ error: { message: 'denied' } }) }) }),
      }),
    };

    await expect(revokeCortexAiMcpTokensForUser(supabase, 'admin-1')).resolves.toEqual({ error: 'denied' });
  });
});
