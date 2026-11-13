import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Cortex AI first-run wizard's actions. The sandbox's demo admin login is public
 * (2026-11-03): a key stored there would be spent by every visitor, and an MCP token minted
 * there would drive the shared admin from outside the site. Each action answers the sandbox
 * with its result before the admin check, any provider verification (which sends the key out),
 * the encryption, a database call or the MCP actions it delegates to; completeCortexSetupAction
 * answers success and persists nothing. Off the sandbox each one reaches its write.
 */

const SANDBOX_MESSAGE =
  'The shared sandbox cannot store keys. Use the Cortex AI settings page, which keeps them in your browser.';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getServiceRoleSupabaseClient: vi.fn(),
  from: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
  read: vi.fn(),
  encrypt: vi.fn((value: string) => `enc:${value}`),
  // Seals for a named key row (each Cortex key is bound to its own row since 0.23.1).
  encryptFor: vi.fn((_settingKey: string, value: string) => `enc:${value}`),
  reseal: vi.fn(async () => 0),
  verifyOpenRouter: vi.fn(),
  verifyPexels: vi.fn(),
  verifyUnsplash: vi.fn(),
  getStoredKeyStatus: vi.fn(),
  listModels: vi.fn(),
  createSelection: vi.fn(),
  saveMcpSettings: vi.fn(),
  createMcpToken: vi.fn(),
}));

/** One fake for both the client requireAdminSupabaseClient hands back and the service-role client. */
const client = {
  from: (table: string) => {
    mocks.from(table);
    return {
      upsert: (rows: unknown) => mocks.upsert(table, rows),
      delete: () => ({ eq: (column: string, value: string) => mocks.remove(table, column, value) }),
      select: () => ({ eq: (_column: string, key: string) => ({ maybeSingle: () => mocks.read(table, key) }) }),
    };
  },
};

vi.mock('@nextblock-cms/db/server', async () => ({
  getServiceRoleSupabaseClient: mocks.getServiceRoleSupabaseClient,
  // The real predicate (a dependency-free module), so the env stub drives it.
  isSandboxEnvironment: (
    await vi.importActual<{ isSandboxEnvironment: () => boolean }>('../../../../../../../libs/db/src/lib/config-resolve')
  ).isSandboxEnvironment,
}));
vi.mock('../require-admin', () => ({ requireAdminSupabaseClient: mocks.requireAdmin }));
// The delegated MCP actions refuse on the sandbox themselves (mcp-actions.test.ts); stubbing them
// here proves the wizard refuses before it reaches them.
vi.mock('../mcp-actions', () => ({
  createMcpAccessTokenAction: mocks.createMcpToken,
  saveMcpSettingsAction: mocks.saveMcpSettings,
}));
vi.mock('@nextblock-cms/cortex', () => ({
  CORTEX_AI_MCP_TOKENS_TABLE: 'mcp_access_tokens',
  CORTEX_AI_OPENROUTER_MODEL_SELECTION_SETTING_KEY: 'cortex_ai_openrouter_model_selection',
  CORTEX_AI_OPENROUTER_SETTING_KEY: 'cortex_ai_openrouter_api_key',
  CORTEX_AI_PEXELS_SETTING_KEY: 'cortex_ai_pexels_api_key',
  CORTEX_AI_UNSPLASH_SETTING_KEY: 'cortex_ai_unsplash_access_key',
  createCortexAiStoredModelSelection: mocks.createSelection,
  encryptStoredCortexAiSecret: mocks.encryptFor,
  encryptStoredOpenRouterApiKey: mocks.encrypt,
  getMaskedOpenRouterKey: (last4: string) => `••••${last4}`,
  getStoredOpenRouterKeyStatus: mocks.getStoredKeyStatus,
  listCortexAiCompatibleOpenRouterModels: mocks.listModels,
  resealStoredCortexAiSecrets: mocks.reseal,
  verifyOpenRouterApiKey: mocks.verifyOpenRouter,
  verifyPexelsApiKey: mocks.verifyPexels,
  verifyUnsplashAccessKey: mocks.verifyUnsplash,
}));

import * as actions from './actions';

type GuardedAction = {
  name: string;
  run: () => Promise<unknown>;
  sandboxResult: Record<string, unknown>;
  successResult: Record<string, unknown>;
  /** The write the action exists for, reached off the sandbox. */
  expectWrite: () => void;
};

const GUARDED: GuardedAction[] = [
  {
    name: 'connectOpenRouterKeyAction',
    run: () => actions.connectOpenRouterKeyAction({ apiKey: ' sk-or-v1-visitor-abcd ' }),
    sandboxResult: { message: SANDBOX_MESSAGE, reason: 'error', success: false },
    successResult: { detail: 'Paid account', isFreeTier: false, maskedKey: '••••abcd', success: true, verified: true },
    expectWrite: () => {
      expect(mocks.verifyOpenRouter).toHaveBeenCalledWith({ apiKey: 'sk-or-v1-visitor-abcd' });
      expect(mocks.upsert).toHaveBeenCalledWith('site_settings', {
        key: 'cortex_ai_openrouter_api_key',
        value: 'enc:sk-or-v1-visitor-abcd',
      });
      expect(mocks.reseal).toHaveBeenCalledWith(client);
    },
  },
  {
    name: 'selectModelForSetupAction',
    run: () => actions.selectModelForSetupAction({ modelId: 'vendor/model-a' }),
    sandboxResult: { message: SANDBOX_MESSAGE, success: false },
    successResult: { model: { modelId: 'vendor/model-a' }, success: true },
    expectWrite: () => {
      expect(mocks.listModels).toHaveBeenCalled();
      expect(mocks.upsert).toHaveBeenCalledWith('site_settings', {
        key: 'cortex_ai_openrouter_model_selection',
        value: { modelId: 'vendor/model-a' },
      });
    },
  },
  {
    // Kept under 40 characters: vitest truncates a longer `$name` in the test title.
    name: 'selectModelForSetupAction (automatic)',
    run: () => actions.selectModelForSetupAction({ modelId: null }),
    sandboxResult: { message: SANDBOX_MESSAGE, success: false },
    successResult: { model: null, success: true },
    expectWrite: () => {
      expect(mocks.remove).toHaveBeenCalledWith('site_settings', 'key', 'cortex_ai_openrouter_model_selection');
    },
  },
  {
    name: 'saveStockPhotoKeysForSetupAction',
    run: () => actions.saveStockPhotoKeysForSetupAction({ pexelsKey: ' px-visitor ', unsplashKey: 'us-visitor' }),
    sandboxResult: { errors: {}, message: SANDBOX_MESSAGE, saved: [], success: false },
    successResult: { errors: {}, saved: ['pexels', 'unsplash'], success: true },
    expectWrite: () => {
      expect(mocks.verifyPexels).toHaveBeenCalledWith({ apiKey: 'px-visitor' });
      expect(mocks.verifyUnsplash).toHaveBeenCalledWith({ accessKey: 'us-visitor' });
      expect(mocks.upsert).toHaveBeenCalledWith('site_settings', [
        { key: 'cortex_ai_pexels_api_key', value: 'enc:px-visitor' },
        { key: 'cortex_ai_unsplash_access_key', value: 'enc:us-visitor' },
      ]);
      expect(mocks.encryptFor.mock.calls).toEqual([
        ['cortex_ai_pexels_api_key', 'px-visitor'],
        ['cortex_ai_unsplash_access_key', 'us-visitor'],
      ]);
      expect(mocks.encrypt).not.toHaveBeenCalled();
      expect(mocks.reseal).toHaveBeenCalledWith(client);
    },
  },
  {
    name: 'enableMcpForSetupAction',
    run: () => actions.enableMcpForSetupAction({ allowLocalhostWithoutToken: false, tokenName: 'Visitor laptop' }),
    sandboxResult: { message: SANDBOX_MESSAGE, success: false },
    successResult: { success: true, token: 'nbmcp_full-secret-token', tokenPrefix: 'nbmcp_full' },
    expectWrite: () => {
      expect(mocks.saveMcpSettings).toHaveBeenCalledWith(
        { allowLocalhostWithoutToken: false, enabled: true },
        { revalidate: false }
      );
      expect(mocks.createMcpToken).toHaveBeenCalledWith(
        { expiresInDays: null, name: 'Visitor laptop', scopes: ['read', 'write'] },
        { revalidate: false }
      );
    },
  },
  {
    name: 'reuseExistingMcpTokenForSetupAction',
    run: () => actions.reuseExistingMcpTokenForSetupAction({ allowLocalhostWithoutToken: true, tokenId: 'token-1' }),
    sandboxResult: { message: SANDBOX_MESSAGE, success: false },
    successResult: { name: 'Owner laptop', success: true, tokenPrefix: 'nbmcp_own' },
    expectWrite: () => {
      expect(mocks.getServiceRoleSupabaseClient).toHaveBeenCalled();
      expect(mocks.read).toHaveBeenCalledWith('mcp_access_tokens', 'token-1');
      expect(mocks.saveMcpSettings).toHaveBeenCalledWith(
        { allowLocalhostWithoutToken: true, enabled: true },
        { revalidate: false }
      );
    },
  },
  {
    name: 'completeCortexSetupAction',
    run: () => actions.completeCortexSetupAction({ path: 'mcp' }),
    // A no-op success, not an error: the wizard is not rendered on the sandbox anyway.
    sandboxResult: { success: true },
    successResult: { success: true },
    expectWrite: () => {
      expect(mocks.read).toHaveBeenCalledWith('site_settings', 'onboarding_state');
      expect(mocks.upsert).toHaveBeenCalledWith('site_settings', {
        key: 'onboarding_state',
        value: {
          dashboard_checklist: { dismissed: true },
          cortex_setup: { completed: true, completedAt: expect.any(String), path: 'mcp' },
        },
      });
    },
  },
];

function resetCalls() {
  for (const spy of [
    mocks.requireAdmin,
    mocks.getServiceRoleSupabaseClient,
    mocks.from,
    mocks.upsert,
    mocks.remove,
    mocks.read,
    mocks.encrypt,
    mocks.encryptFor,
    mocks.reseal,
    mocks.verifyOpenRouter,
    mocks.verifyPexels,
    mocks.verifyUnsplash,
    mocks.getStoredKeyStatus,
    mocks.listModels,
    mocks.createSelection,
    mocks.saveMcpSettings,
    mocks.createMcpToken,
  ]) {
    spy.mockClear();
  }
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  mocks.requireAdmin.mockReset().mockResolvedValue({ supabase: client, userId: 'admin-1' });
  mocks.getServiceRoleSupabaseClient.mockReset().mockReturnValue(client);
  mocks.upsert.mockReset().mockResolvedValue({ error: null });
  mocks.remove.mockReset().mockResolvedValue({ error: null });
  mocks.read.mockReset().mockImplementation(async (table: string, key: string) => {
    if (table === 'mcp_access_tokens') {
      return {
        data: { expires_at: null, id: key, name: 'Owner laptop', revoked_at: null, token_prefix: 'nbmcp_own' },
        error: null,
      };
    }
    if (key === 'onboarding_state') return { data: { value: { dashboard_checklist: { dismissed: true } } }, error: null };
    return { data: { value: { encrypted: 'envelope' } }, error: null };
  });
  mocks.verifyOpenRouter.mockReset().mockResolvedValue({ detail: 'Paid account', isFreeTier: false, ok: true });
  mocks.verifyPexels.mockReset().mockResolvedValue({ detail: null, ok: true });
  mocks.verifyUnsplash.mockReset().mockResolvedValue({ detail: null, ok: true });
  mocks.getStoredKeyStatus.mockReset().mockReturnValue({ hasStoredKey: true, maskedKey: '••••abcd', updatedAt: null });
  mocks.listModels.mockReset().mockResolvedValue([{ id: 'vendor/model-a' }]);
  mocks.createSelection.mockReset().mockImplementation((model: { id: string }) => ({ modelId: model.id }));
  mocks.saveMcpSettings.mockReset().mockResolvedValue({ success: true });
  mocks.createMcpToken
    .mockReset()
    .mockResolvedValue({ success: true, token: 'nbmcp_full-secret-token', tokenPrefix: 'nbmcp_full' });
  resetCalls();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('covers every exported action', () => {
  expect(Object.keys(actions).sort()).toEqual([...new Set(GUARDED.map((action) => action.name.split(' ')[0]))].sort());
});

describe.each(GUARDED)('$name', ({ run, sandboxResult, successResult, expectWrite }) => {
  it('answers the sandbox before the admin check, any key verification, the encryption or any write', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    expect(await run()).toEqual(sandboxResult);

    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.encrypt).not.toHaveBeenCalled();
    expect(mocks.encryptFor).not.toHaveBeenCalled();
    expect(mocks.reseal).not.toHaveBeenCalled();
    expect(mocks.verifyOpenRouter).not.toHaveBeenCalled();
    expect(mocks.verifyPexels).not.toHaveBeenCalled();
    expect(mocks.verifyUnsplash).not.toHaveBeenCalled();
    expect(mocks.listModels).not.toHaveBeenCalled();
    expect(mocks.saveMcpSettings).not.toHaveBeenCalled();
    expect(mocks.createMcpToken).not.toHaveBeenCalled();
  });

  it('reaches its write anywhere else (only the exact value "true" is the sandbox)', async () => {
    for (const value of ['', 'false', 'TRUE', '1']) {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      resetCalls();

      expect(await run(), value).toEqual(successResult);

      expectWrite();
    }
  });
});
