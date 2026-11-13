import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Cortex AI settings actions (/cms/settings/cortex-ai). The sandbox's demo admin login is
 * public (2026-11-03): an AI key stored in its database would be spent by every visitor, and
 * on the sandbox each visitor's own key stays in their browser. Every action that writes refuses
 * there with an `?error=` redirect before the admin check, the encryption or any database call.
 * Off the sandbox each one reaches its write and redirects with its `?success=` banner.
 */

const SETTINGS_PATH = '/cms/settings/cortex-ai';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  from: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
  read: vi.fn(),
  encrypt: vi.fn((value: string) => `enc:${value}`),
  // Seals for a named key row (each Cortex key is bound to its own row since 0.23.1).
  encryptFor: vi.fn((_settingKey: string, value: string) => `enc:${value}`),
  reseal: vi.fn(async () => 0),
  getStoredKeyStatus: vi.fn(),
  listModels: vi.fn(),
  createSelection: vi.fn(),
  normalizeAgentSettings: vi.fn((raw: unknown) => raw),
  verifyPackageOnline: vi.fn(),
  revalidatePath: vi.fn(),
  // What next/navigation's redirect() throws inside a server action.
  redirect: vi.fn((url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;push;${url};307;` });
  }),
}));

/** The service-role client requireAdminSupabaseClient hands back. */
const client = {
  from: (table: string) => {
    mocks.from(table);
    return {
      upsert: (rows: unknown) => mocks.upsert(table, rows),
      delete: () => ({
        in: (column: string, values: string[]) => mocks.remove(table, column, values),
        eq: (column: string, value: string) => mocks.remove(table, column, value),
      }),
      select: () => ({
        eq: (_column: string, key: string) => ({ maybeSingle: () => mocks.read(table, key) }),
      }),
    };
  },
};

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@nextblock-cms/db/server', async () => ({
  verifyPackageOnline: mocks.verifyPackageOnline,
  // The real predicate (a dependency-free module), so the env stub drives it.
  isSandboxEnvironment: (
    await vi.importActual<{ isSandboxEnvironment: () => boolean }>('../../../../../../libs/db/src/lib/config-resolve')
  ).isSandboxEnvironment,
}));
vi.mock('./require-admin', () => ({ requireAdminSupabaseClient: mocks.requireAdmin }));
vi.mock('@nextblock-cms/cortex', () => ({
  CORTEX_AI_AGENT_SETTINGS_DEFAULTS: { maxOutputTokens: 16000, maxSteps: 8, responseTimeoutMs: 120000, temperature: 0.1 },
  CORTEX_AI_AGENT_SETTINGS_KEY: 'cortex_ai_agent_settings',
  CORTEX_AI_OPENROUTER_MODEL_SELECTION_SETTING_KEY: 'cortex_ai_openrouter_model_selection',
  CORTEX_AI_OPENROUTER_SETTING_KEY: 'cortex_ai_openrouter_api_key',
  CORTEX_AI_PACKAGE_ID: 'cortex-ai',
  CORTEX_AI_PEXELS_SETTING_KEY: 'cortex_ai_pexels_api_key',
  CORTEX_AI_UNSPLASH_APP_NAME_SETTING_KEY: 'cortex_ai_unsplash_app_name',
  CORTEX_AI_UNSPLASH_SETTING_KEY: 'cortex_ai_unsplash_access_key',
  createCortexAiStoredModelSelection: mocks.createSelection,
  encryptStoredCortexAiSecret: mocks.encryptFor,
  encryptStoredOpenRouterApiKey: mocks.encrypt,
  getCortexAiEnvConfig: () => ({ hasEncryptionKey: true, hasOpenRouterEnvKey: false }),
  getEnvOpenRouterKeyStatus: () => ({ maskedEnvOpenRouterKey: null }),
  getStoredOpenRouterKeyStatus: mocks.getStoredKeyStatus,
  listCortexAiCompatibleOpenRouterModels: mocks.listModels,
  normalizeCortexAiAgentSettings: mocks.normalizeAgentSettings,
  resealStoredCortexAiSecrets: mocks.reseal,
  safeParseCortexAiModelSelection: () => null,
}));

import * as actions from './actions';

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

type GuardedAction = {
  name: string;
  run: () => Promise<unknown>;
  sandboxError: string;
  success: string;
  /** The write the action exists for, reached off the sandbox. */
  expectWrite: () => void;
};

const GUARDED: GuardedAction[] = [
  {
    name: 'saveOpenRouterApiKeyAction',
    run: () => actions.saveOpenRouterApiKeyAction(form({ openrouter_api_key: ' sk-or-v1-visitor ' })),
    sandboxError: 'Sandbox environment cannot save keys to the database.',
    success: 'OpenRouter key saved.',
    expectWrite: () => {
      expect(mocks.encrypt).toHaveBeenCalledWith('sk-or-v1-visitor');
      expect(mocks.upsert).toHaveBeenCalledWith('site_settings', {
        key: 'cortex_ai_openrouter_api_key',
        value: 'enc:sk-or-v1-visitor',
      });
      expect(mocks.reseal).toHaveBeenCalledWith(client);
    },
  },
  {
    name: 'clearOpenRouterApiKeyAction',
    run: () => actions.clearOpenRouterApiKeyAction(),
    sandboxError: 'Sandbox environment cannot clear keys from the database.',
    success: 'Stored OpenRouter key cleared.',
    expectWrite: () => {
      expect(mocks.remove).toHaveBeenCalledWith('site_settings', 'key', [
        'cortex_ai_openrouter_api_key',
        'cortex_ai_openrouter_model_selection',
      ]);
    },
  },
  {
    name: 'saveStockPhotoKeysAction',
    run: () =>
      actions.saveStockPhotoKeysAction(
        form({ pexels_api_key: 'px-visitor', unsplash_access_key: 'us-visitor', unsplash_app_name: 'Visitor App' })
      ),
    sandboxError: 'Sandbox environment cannot save keys to the database.',
    success: 'Stock photo API key saved.',
    expectWrite: () => {
      expect(mocks.upsert).toHaveBeenCalledWith('site_settings', [
        { key: 'cortex_ai_pexels_api_key', value: 'enc:px-visitor' },
        { key: 'cortex_ai_unsplash_access_key', value: 'enc:us-visitor' },
        { key: 'cortex_ai_unsplash_app_name', value: 'Visitor App' },
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
    name: 'clearStockPhotoKeysAction',
    run: () => actions.clearStockPhotoKeysAction(),
    sandboxError: 'Sandbox environment cannot clear keys from the database.',
    success: 'Stock photo API keys cleared.',
    expectWrite: () => {
      expect(mocks.remove).toHaveBeenCalledWith('site_settings', 'key', [
        'cortex_ai_pexels_api_key',
        'cortex_ai_unsplash_access_key',
      ]);
    },
  },
  {
    name: 'saveCortexAiAgentSettingsAction',
    run: () =>
      actions.saveCortexAiAgentSettingsAction(
        form({ max_output_tokens: '8000', max_steps: '12', response_timeout_seconds: '90', temperature: '0.3' })
      ),
    sandboxError: 'Sandbox environment cannot save settings to the database.',
    success: 'Advanced agent settings saved.',
    expectWrite: () => {
      expect(mocks.upsert).toHaveBeenCalledWith('site_settings', {
        key: 'cortex_ai_agent_settings',
        value: { maxOutputTokens: 8000, maxSteps: 12, responseTimeoutMs: 90000, temperature: 0.3 },
      });
      expect(mocks.reseal).toHaveBeenCalledWith(client);
    },
  },
  {
    name: 'resetCortexAiAgentSettingsAction',
    run: () => actions.resetCortexAiAgentSettingsAction(),
    sandboxError: 'Sandbox environment cannot change settings in the database.',
    success: 'Advanced agent settings reset to defaults.',
    expectWrite: () => {
      expect(mocks.remove).toHaveBeenCalledWith('site_settings', 'key', 'cortex_ai_agent_settings');
    },
  },
  {
    name: 'saveCortexAiModelSelectionAction',
    run: () => actions.saveCortexAiModelSelectionAction(form({ openrouter_model_id: 'vendor/model-a' })),
    sandboxError: 'Sandbox environment cannot save model selection to the database.',
    success: 'Cortex AI model selection saved.',
    expectWrite: () => {
      expect(mocks.listModels).toHaveBeenCalled();
      expect(mocks.upsert).toHaveBeenCalledWith('site_settings', {
        key: 'cortex_ai_openrouter_model_selection',
        value: { modelId: 'vendor/model-a' },
      });
      expect(mocks.reseal).toHaveBeenCalledWith(client);
    },
  },
  {
    name: 'clearCortexAiModelSelectionAction',
    run: () => actions.clearCortexAiModelSelectionAction(),
    sandboxError: 'Sandbox environment cannot clear model selection from the database.',
    success: 'Cortex AI model selection cleared.',
    expectWrite: () => {
      expect(mocks.remove).toHaveBeenCalledWith('site_settings', 'key', 'cortex_ai_openrouter_model_selection');
    },
  },
];

function resetCalls() {
  mocks.redirect.mockClear();
  mocks.requireAdmin.mockClear();
  mocks.from.mockClear();
  mocks.upsert.mockClear();
  mocks.remove.mockClear();
  mocks.read.mockClear();
  mocks.encrypt.mockClear();
  mocks.encryptFor.mockClear();
  mocks.reseal.mockClear();
  mocks.getStoredKeyStatus.mockClear();
  mocks.listModels.mockClear();
  mocks.createSelection.mockClear();
  mocks.normalizeAgentSettings.mockClear();
  mocks.revalidatePath.mockClear();
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  mocks.requireAdmin.mockReset().mockResolvedValue({ supabase: client, userId: 'admin-1' });
  mocks.upsert.mockReset().mockResolvedValue({ error: null });
  mocks.remove.mockReset().mockResolvedValue({ error: null });
  mocks.read.mockReset().mockResolvedValue({ data: { value: { encrypted: 'envelope' } }, error: null });
  mocks.getStoredKeyStatus.mockReset().mockReturnValue({ hasStoredKey: true, maskedKey: '••••abcd', updatedAt: null });
  mocks.listModels.mockReset().mockResolvedValue([{ id: 'vendor/model-a' }, { id: 'vendor/model-b' }]);
  mocks.createSelection.mockReset().mockImplementation((model: { id: string }) => ({ modelId: model.id }));
  resetCalls();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('covers every exported action except the read-only status loader', () => {
  expect(Object.keys(actions).sort()).toEqual(
    ['getCortexAiSettingsStatus', ...GUARDED.map((action) => action.name)].sort()
  );
});

describe.each(GUARDED)('$name', ({ run, sandboxError, success, expectWrite }) => {
  it('refuses on the sandbox before the admin check, the encryption or any database call', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    await expect(run()).rejects.toThrow('NEXT_REDIRECT');

    expect(mocks.redirect).toHaveBeenCalledTimes(1);
    expect(mocks.redirect).toHaveBeenCalledWith(`${SETTINGS_PATH}?error=${encodeURIComponent(sandboxError)}`);
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.encrypt).not.toHaveBeenCalled();
    expect(mocks.encryptFor).not.toHaveBeenCalled();
    expect(mocks.reseal).not.toHaveBeenCalled();
    expect(mocks.listModels).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('reaches its write anywhere else (only the exact value "true" is the sandbox)', async () => {
    for (const value of ['', 'false', 'TRUE', '1']) {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      resetCalls();

      await expect(run(), value).rejects.toThrow('NEXT_REDIRECT');

      expect(mocks.requireAdmin, value).toHaveBeenCalledTimes(1);
      expectWrite();
      expect(mocks.redirect, value).toHaveBeenCalledTimes(1);
      expect(mocks.redirect, value).toHaveBeenCalledWith(`${SETTINGS_PATH}?success=${encodeURIComponent(success)}`);
      expect(mocks.revalidatePath, value).toHaveBeenCalledWith(SETTINGS_PATH);
    }
  });
});
