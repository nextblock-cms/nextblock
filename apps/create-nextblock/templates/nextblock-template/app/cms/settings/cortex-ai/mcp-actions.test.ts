import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The MCP server card's actions. The sandbox's demo admin login is public (2026-11-03), and an
 * MCP token minted there would let whoever holds it drive the shared admin from outside the site.
 * The card renders read-only on the sandbox, so these actions are reachable from a sandbox page:
 * each refuses with its result before the admin check, the service-role client, token creation
 * or any write. Off the sandbox each one reaches its write.
 */

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getServiceRoleSupabaseClient: vi.fn(),
  settingsUpsert: vi.fn(),
  tokenCount: vi.fn(),
  tokenInsert: vi.fn(),
  tokenUpdate: vi.fn(),
  mint: vi.fn(),
  normalizeSettings: vi.fn((raw: { allowLocalhostWithoutToken: boolean; enabled: boolean }) => ({ ...raw })),
  revalidatePath: vi.fn(),
}));

/** The client requireAdminSupabaseClient hands back (the `site_settings` row). */
const settingsClient = {
  from: (table: string) => ({ upsert: (row: unknown) => mocks.settingsUpsert(table, row) }),
};

/** The service-role client the token table is reached with. */
const tokenClient = {
  from: (table: string) => ({
    select: () => ({ is: () => mocks.tokenCount(table) }),
    insert: (row: unknown) => mocks.tokenInsert(table, row),
    update: (patch: unknown) => ({ eq: (column: string, value: string) => mocks.tokenUpdate(table, patch, column, value) }),
  }),
};

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@nextblock-cms/db/server', async () => ({
  getServiceRoleSupabaseClient: mocks.getServiceRoleSupabaseClient,
  // The real predicate (a dependency-free module), so the env stub drives it.
  isSandboxEnvironment: (
    await vi.importActual<{ isSandboxEnvironment: () => boolean }>('../../../../../../libs/db/src/lib/config-resolve')
  ).isSandboxEnvironment,
}));
vi.mock('./require-admin', () => ({ requireAdminSupabaseClient: mocks.requireAdmin }));
vi.mock('@nextblock-cms/cortex', () => ({
  CORTEX_AI_MCP_SETTINGS_KEY: 'cortex_ai_mcp_settings',
  CORTEX_AI_MCP_TOKENS_TABLE: 'mcp_access_tokens',
  mintCortexAiMcpToken: mocks.mint,
  normalizeCortexAiMcpSettings: mocks.normalizeSettings,
}));

import { createMcpAccessTokenAction, revokeMcpAccessTokenAction, saveMcpSettingsAction } from './mcp-actions';

type GuardedAction = {
  name: string;
  run: () => Promise<unknown>;
  sandboxResult: { error: string; success: false };
  successResult: Record<string, unknown>;
  /** The write the action exists for, reached off the sandbox. */
  expectWrite: () => void;
};

const GUARDED: GuardedAction[] = [
  {
    name: 'saveMcpSettingsAction',
    run: () => saveMcpSettingsAction({ allowLocalhostWithoutToken: true, enabled: true }),
    sandboxResult: { error: 'Sandbox environment cannot change MCP server settings.', success: false },
    successResult: { success: true },
    expectWrite: () => {
      expect(mocks.settingsUpsert).toHaveBeenCalledWith('site_settings', {
        key: 'cortex_ai_mcp_settings',
        value: { allowLocalhostWithoutToken: true, enabled: true },
      });
    },
  },
  {
    name: 'createMcpAccessTokenAction',
    run: () => createMcpAccessTokenAction({ expiresInDays: null, name: 'Visitor laptop', scopes: ['read', 'write'] }),
    sandboxResult: { error: 'Sandbox environment cannot mint MCP access tokens.', success: false },
    successResult: { success: true, token: 'nbmcp_full-secret-token', tokenPrefix: 'nbmcp_full' },
    expectWrite: () => {
      expect(mocks.mint).toHaveBeenCalledTimes(1);
      expect(mocks.tokenInsert).toHaveBeenCalledWith('mcp_access_tokens', {
        created_by: 'admin-1',
        expires_at: null,
        name: 'Visitor laptop',
        scopes: ['read', 'write'],
        token_hash: 'hash-of-token',
        token_prefix: 'nbmcp_full',
      });
    },
  },
  {
    name: 'revokeMcpAccessTokenAction',
    run: () => revokeMcpAccessTokenAction({ id: 'token-1' }),
    sandboxResult: { error: 'Sandbox environment cannot revoke MCP access tokens.', success: false },
    successResult: { success: true },
    expectWrite: () => {
      expect(mocks.tokenUpdate).toHaveBeenCalledWith(
        'mcp_access_tokens',
        { revoked_at: expect.any(String) },
        'id',
        'token-1'
      );
    },
  },
];

function resetCalls() {
  for (const spy of [
    mocks.requireAdmin,
    mocks.getServiceRoleSupabaseClient,
    mocks.settingsUpsert,
    mocks.tokenCount,
    mocks.tokenInsert,
    mocks.tokenUpdate,
    mocks.mint,
    mocks.normalizeSettings,
    mocks.revalidatePath,
  ]) {
    spy.mockClear();
  }
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  mocks.requireAdmin.mockReset().mockResolvedValue({ supabase: settingsClient, userId: 'admin-1' });
  mocks.getServiceRoleSupabaseClient.mockReset().mockReturnValue(tokenClient);
  mocks.settingsUpsert.mockReset().mockResolvedValue({ error: null });
  mocks.tokenCount.mockReset().mockResolvedValue({ count: 0, error: null });
  mocks.tokenInsert.mockReset().mockResolvedValue({ error: null });
  mocks.tokenUpdate.mockReset().mockResolvedValue({ error: null });
  mocks.mint
    .mockReset()
    .mockReturnValue({ token: 'nbmcp_full-secret-token', tokenHash: 'hash-of-token', tokenPrefix: 'nbmcp_full' });
  resetCalls();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe.each(GUARDED)('$name', ({ run, sandboxResult, successResult, expectWrite }) => {
  it('refuses on the sandbox before the admin check, the service-role client, token creation or any write', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    expect(await run()).toEqual(sandboxResult);

    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
    expect(mocks.normalizeSettings).not.toHaveBeenCalled();
    expect(mocks.settingsUpsert).not.toHaveBeenCalled();
    expect(mocks.tokenCount).not.toHaveBeenCalled();
    expect(mocks.mint).not.toHaveBeenCalled();
    expect(mocks.tokenInsert).not.toHaveBeenCalled();
    expect(mocks.tokenUpdate).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('reaches its write anywhere else (only the exact value "true" is the sandbox)', async () => {
    for (const value of ['', 'false', 'TRUE', '1']) {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      resetCalls();

      expect(await run(), value).toEqual(successResult);

      expect(mocks.requireAdmin, value).toHaveBeenCalledTimes(1);
      expectWrite();
      expect(mocks.revalidatePath, value).toHaveBeenCalledWith('/cms/settings/cortex-ai');
    }
  });
});
