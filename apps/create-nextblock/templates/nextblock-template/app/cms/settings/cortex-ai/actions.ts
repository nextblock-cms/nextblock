'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import type { Json } from '@nextblock-cms/db';
import { verifyPackageOnline } from '@nextblock-cms/db/server';

import { requireAdminSupabaseClient as requireAdminAccess } from './require-admin';

import {
  CORTEX_AI_AGENT_SETTINGS_DEFAULTS,
  CORTEX_AI_AGENT_SETTINGS_KEY,
  CORTEX_AI_OPENROUTER_MODEL_SELECTION_SETTING_KEY,
  CORTEX_AI_OPENROUTER_SETTING_KEY,
  CORTEX_AI_PACKAGE_ID,
  CORTEX_AI_PEXELS_SETTING_KEY,
  CORTEX_AI_UNSPLASH_APP_NAME_SETTING_KEY,
  CORTEX_AI_UNSPLASH_SETTING_KEY,
  createCortexAiStoredModelSelection,
  encryptStoredOpenRouterApiKey,
  getCortexAiEnvConfig,
  getEnvOpenRouterKeyStatus,
  getStoredOpenRouterKeyStatus,
  listCortexAiCompatibleOpenRouterModels,
  normalizeCortexAiAgentSettings,
  safeParseCortexAiModelSelection,
  type CortexAiAgentSettings,
  type CortexAiStoredModelSelection,
} from '@nextblock-cms/cortex';

const CORTEX_AI_SETTINGS_PATH = '/cms/settings/cortex-ai';

type CortexAiSettingsStatus = {
  activeKeySource: 'env' | 'stored' | 'none';
  activeStockProvider: 'pexels' | 'unsplash' | null;
  agentSettings: CortexAiAgentSettings;
  hasEncryptionKey: boolean;
  hasEnvOpenRouterKey: boolean;
  hasEnvPexelsKey: boolean;
  hasEnvUnsplashKey: boolean;
  hasStoredOpenRouterKey: boolean;
  hasStoredPexelsKey: boolean;
  hasStoredUnsplashKey: boolean;
  isPackageActive: boolean;
  maskedEnvOpenRouterKey: string | null;
  maskedStoredOpenRouterKey: string | null;
  maskedStoredPexelsKey: string | null;
  maskedStoredUnsplashKey: string | null;
  selectedModel: CortexAiStoredModelSelection | null;
  stockKeysUpdatedAt: string | null;
  storedOpenRouterKeyUpdatedAt: string | null;
  unsplashAppName: string | null;
};

/**
 * How every action in this file reports back: the page reads `?success=` / `?error=` and
 * renders it. These are plain `<form action={fn}>` submissions, so a return value would be
 * discarded and a thrown error would take out the page (with its message replaced by a
 * generic string in production).
 *
 * Must be called OUTSIDE the try blocks below. `redirect()` signals itself by throwing
 * NEXT_REDIRECT, so calling this inside a `try` would have the `catch` swallow the
 * navigation and re-redirect with the framework's digest as the user-facing message.
 */
function redirectWithStatus(status: 'success' | 'error', message: string): never {
  redirect(`${CORTEX_AI_SETTINGS_PATH}?${status}=${encodeURIComponent(message)}`);
}

async function requireAdminSupabaseClient() {
  const { supabase } = await requireAdminAccess();

  return supabase;
}

export async function getCortexAiSettingsStatus(): Promise<CortexAiSettingsStatus> {
  const supabase = await requireAdminSupabaseClient();
  const env = getCortexAiEnvConfig();
  const envKeyStatus = getEnvOpenRouterKeyStatus();

  const [
    { data: storedKeyRow },
    { data: selectedModelRow },
    { data: storedPexelsRow },
    { data: storedUnsplashRow },
    { data: unsplashAppNameRow },
    { data: agentSettingsRow },
    isPackageActive,
  ] = await Promise.all([
    supabase
      .from('site_settings')
      .select('value')
      .eq('key', CORTEX_AI_OPENROUTER_SETTING_KEY)
      .maybeSingle(),
    supabase
      .from('site_settings')
      .select('value')
      .eq('key', CORTEX_AI_OPENROUTER_MODEL_SELECTION_SETTING_KEY)
      .maybeSingle(),
    supabase
      .from('site_settings')
      .select('value')
      .eq('key', CORTEX_AI_PEXELS_SETTING_KEY)
      .maybeSingle(),
    supabase
      .from('site_settings')
      .select('value')
      .eq('key', CORTEX_AI_UNSPLASH_SETTING_KEY)
      .maybeSingle(),
    supabase
      .from('site_settings')
      .select('value')
      .eq('key', CORTEX_AI_UNSPLASH_APP_NAME_SETTING_KEY)
      .maybeSingle(),
    supabase
      .from('site_settings')
      .select('value')
      .eq('key', CORTEX_AI_AGENT_SETTINGS_KEY)
      .maybeSingle(),
    verifyPackageOnline(CORTEX_AI_PACKAGE_ID).catch(() => false),
  ]);

  const storedKeyStatus = getStoredOpenRouterKeyStatus(storedKeyRow?.value);
  const selectedModel = safeParseCortexAiModelSelection(selectedModelRow?.value);
  const pexelsStatus = getStoredOpenRouterKeyStatus(storedPexelsRow?.value);
  const unsplashStatus = getStoredOpenRouterKeyStatus(storedUnsplashRow?.value);
  const hasEnvPexelsKey = Boolean(process.env.PEXELS_API_KEY?.trim());
  const hasEnvUnsplashKey = Boolean(process.env.UNSPLASH_ACCESS_KEY?.trim());
  const activeStockProvider: 'pexels' | 'unsplash' | null = pexelsStatus.hasStoredKey
    ? 'pexels'
    : unsplashStatus.hasStoredKey
      ? 'unsplash'
      : hasEnvPexelsKey
        ? 'pexels'
        : hasEnvUnsplashKey
          ? 'unsplash'
          : null;

  return {
    activeKeySource: storedKeyStatus.hasStoredKey
      ? 'stored'
      : env.hasOpenRouterEnvKey
        ? 'env'
        : 'none',
    activeStockProvider,
    hasEncryptionKey: env.hasEncryptionKey,
    hasEnvOpenRouterKey: env.hasOpenRouterEnvKey,
    hasEnvPexelsKey,
    hasEnvUnsplashKey,
    hasStoredOpenRouterKey: storedKeyStatus.hasStoredKey,
    hasStoredPexelsKey: pexelsStatus.hasStoredKey,
    hasStoredUnsplashKey: unsplashStatus.hasStoredKey,
    isPackageActive,
    maskedEnvOpenRouterKey: envKeyStatus.maskedEnvOpenRouterKey,
    maskedStoredOpenRouterKey: storedKeyStatus.maskedKey,
    maskedStoredPexelsKey: pexelsStatus.maskedKey,
    maskedStoredUnsplashKey: unsplashStatus.maskedKey,
    agentSettings: normalizeCortexAiAgentSettings(agentSettingsRow?.value),
    selectedModel: storedKeyStatus.hasStoredKey ? selectedModel : null,
    stockKeysUpdatedAt: pexelsStatus.updatedAt || unsplashStatus.updatedAt || null,
    storedOpenRouterKeyUpdatedAt: storedKeyStatus.updatedAt,
    unsplashAppName:
      typeof unsplashAppNameRow?.value === 'string' && unsplashAppNameRow.value.trim()
        ? unsplashAppNameRow.value.trim()
        : null,
  };
}

export async function saveOpenRouterApiKeyAction(formData: FormData) {
  if (process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') {
    redirectWithStatus('error', 'Sandbox environment cannot save keys to the database.');
  }

  try {
    const supabase = await requireAdminSupabaseClient();
    const apiKey = String(formData.get('openrouter_api_key') || '').trim();

    if (!apiKey) {
      throw new Error('OpenRouter API key is required.');
    }

    const encryptedKey = encryptStoredOpenRouterApiKey(apiKey);
    const { error } = await supabase.from('site_settings').upsert({
      key: CORTEX_AI_OPENROUTER_SETTING_KEY,
      value: encryptedKey,
    });

    if (error) {
      throw new Error(error.message);
    }
  } catch (error) {
    redirectWithStatus(
      'error',
      error instanceof Error ? error.message : 'Failed to save OpenRouter key.'
    );
  }

  revalidatePath(CORTEX_AI_SETTINGS_PATH);
  redirectWithStatus('success', 'OpenRouter key saved.');
}

export async function clearOpenRouterApiKeyAction() {
  if (process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') {
    redirectWithStatus('error', 'Sandbox environment cannot clear keys from the database.');
  }

  try {
    const supabase = await requireAdminSupabaseClient();
    const { error } = await supabase
      .from('site_settings')
      .delete()
      .in('key', [
        CORTEX_AI_OPENROUTER_SETTING_KEY,
        CORTEX_AI_OPENROUTER_MODEL_SELECTION_SETTING_KEY,
      ]);

    if (error) {
      throw new Error(error.message);
    }
  } catch (error) {
    redirectWithStatus(
      'error',
      error instanceof Error ? error.message : 'Failed to clear OpenRouter key.'
    );
  }

  revalidatePath(CORTEX_AI_SETTINGS_PATH);
  redirectWithStatus('success', 'Stored OpenRouter key cleared.');
}

export async function saveStockPhotoKeysAction(formData: FormData) {
  if (process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') {
    redirectWithStatus('error', 'Sandbox environment cannot save keys to the database.');
  }

  try {
    const supabase = await requireAdminSupabaseClient();
    const pexelsKey = String(formData.get('pexels_api_key') || '').trim();
    const unsplashKey = String(formData.get('unsplash_access_key') || '').trim();
    const unsplashAppName = String(formData.get('unsplash_app_name') || '').trim();

    if (!pexelsKey && !unsplashKey && !unsplashAppName) {
      throw new Error('Enter a Pexels or Unsplash API key, or an Unsplash app name.');
    }

    const rows: Array<{ key: string; value: unknown }> = [];

    if (pexelsKey) {
      rows.push({
        key: CORTEX_AI_PEXELS_SETTING_KEY,
        value: encryptStoredOpenRouterApiKey(pexelsKey),
      });
    }

    if (unsplashKey) {
      rows.push({
        key: CORTEX_AI_UNSPLASH_SETTING_KEY,
        value: encryptStoredOpenRouterApiKey(unsplashKey),
      });
    }

    // Non-secret: the registered Unsplash app name for attribution utm_source.
    if (unsplashAppName) {
      rows.push({ key: CORTEX_AI_UNSPLASH_APP_NAME_SETTING_KEY, value: unsplashAppName });
    }

    const { error } = await supabase
      .from('site_settings')
      .upsert(rows as Array<{ key: string; value: Json }>);

    if (error) {
      throw new Error(error.message);
    }
  } catch (error) {
    redirectWithStatus(
      'error',
      error instanceof Error ? error.message : 'Failed to save stock photo keys.'
    );
  }

  revalidatePath(CORTEX_AI_SETTINGS_PATH);
  redirectWithStatus('success', 'Stock photo API key saved.');
}

export async function clearStockPhotoKeysAction() {
  if (process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') {
    redirectWithStatus('error', 'Sandbox environment cannot clear keys from the database.');
  }

  try {
    const supabase = await requireAdminSupabaseClient();
    const { error } = await supabase
      .from('site_settings')
      .delete()
      .in('key', [CORTEX_AI_PEXELS_SETTING_KEY, CORTEX_AI_UNSPLASH_SETTING_KEY]);

    if (error) {
      throw new Error(error.message);
    }
  } catch (error) {
    redirectWithStatus(
      'error',
      error instanceof Error ? error.message : 'Failed to clear stock photo keys.'
    );
  }

  revalidatePath(CORTEX_AI_SETTINGS_PATH);
  redirectWithStatus('success', 'Stock photo API keys cleared.');
}

export async function saveCortexAiAgentSettingsAction(formData: FormData) {
  if (process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') {
    redirectWithStatus('error', 'Sandbox environment cannot save settings to the database.');
  }

  try {
    const supabase = await requireAdminSupabaseClient();
    const unlimited = String(formData.get('max_output_unlimited') || '') === 'on';
    const rawMaxOutput = String(formData.get('max_output_tokens') || '').trim();
    const rawTimeoutSeconds = Number(formData.get('response_timeout_seconds'));

    // normalizeCortexAiAgentSettings clamps everything to safe bounds.
    const settings = normalizeCortexAiAgentSettings({
      maxOutputTokens: unlimited
        ? null
        : rawMaxOutput
          ? Number(rawMaxOutput)
          : CORTEX_AI_AGENT_SETTINGS_DEFAULTS.maxOutputTokens,
      maxSteps: Number(formData.get('max_steps')),
      responseTimeoutMs: Number.isFinite(rawTimeoutSeconds)
        ? rawTimeoutSeconds * 1000
        : CORTEX_AI_AGENT_SETTINGS_DEFAULTS.responseTimeoutMs,
      temperature: Number(formData.get('temperature')),
    });

    const { error } = await supabase.from('site_settings').upsert({
      key: CORTEX_AI_AGENT_SETTINGS_KEY,
      value: settings,
    });

    if (error) {
      throw new Error(error.message);
    }
  } catch (error) {
    redirectWithStatus(
      'error',
      error instanceof Error ? error.message : 'Failed to save advanced settings.'
    );
  }

  revalidatePath(CORTEX_AI_SETTINGS_PATH);
  redirectWithStatus('success', 'Advanced agent settings saved.');
}

export async function resetCortexAiAgentSettingsAction() {
  if (process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') {
    redirectWithStatus('error', 'Sandbox environment cannot change settings in the database.');
  }

  try {
    const supabase = await requireAdminSupabaseClient();
    const { error } = await supabase
      .from('site_settings')
      .delete()
      .eq('key', CORTEX_AI_AGENT_SETTINGS_KEY);

    if (error) {
      throw new Error(error.message);
    }
  } catch (error) {
    redirectWithStatus(
      'error',
      error instanceof Error ? error.message : 'Failed to reset advanced settings.'
    );
  }

  revalidatePath(CORTEX_AI_SETTINGS_PATH);
  redirectWithStatus('success', 'Advanced agent settings reset to defaults.');
}

export async function saveCortexAiModelSelectionAction(formData: FormData) {
  if (process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') {
    redirectWithStatus('error', 'Sandbox environment cannot save model selection to the database.');
  }

  try {
    const supabase = await requireAdminSupabaseClient();
    const modelId = String(formData.get('openrouter_model_id') || '').trim();

    if (!modelId) {
      throw new Error('Choose an OpenRouter model before saving.');
    }

    const { data: storedKeyRow, error: storedKeyError } = await supabase
      .from('site_settings')
      .select('value')
      .eq('key', CORTEX_AI_OPENROUTER_SETTING_KEY)
      .maybeSingle();

    if (storedKeyError) {
      throw new Error(storedKeyError.message);
    }

    const storedKeyStatus = getStoredOpenRouterKeyStatus(storedKeyRow?.value);

    if (!storedKeyStatus.hasStoredKey) {
      throw new Error('Save a stored OpenRouter BYOK before choosing a paid model.');
    }

    const compatibleModels = await listCortexAiCompatibleOpenRouterModels();
    const selectedModel = compatibleModels.find((model) => model.id === modelId);

    if (!selectedModel) {
      throw new Error(
        'The selected model is no longer eligible for Cortex AI structured output and tool calling.'
      );
    }

    const { error } = await supabase.from('site_settings').upsert({
      key: CORTEX_AI_OPENROUTER_MODEL_SELECTION_SETTING_KEY,
      value: createCortexAiStoredModelSelection(selectedModel) as unknown as Json,
    });

    if (error) {
      throw new Error(error.message);
    }
  } catch (error) {
    redirectWithStatus(
      'error',
      error instanceof Error ? error.message : 'Failed to save Cortex AI model selection.'
    );
  }

  revalidatePath(CORTEX_AI_SETTINGS_PATH);
  redirectWithStatus('success', 'Cortex AI model selection saved.');
}

export async function clearCortexAiModelSelectionAction() {
  if (process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') {
    redirectWithStatus('error', 'Sandbox environment cannot clear model selection from the database.');
  }

  try {
    const supabase = await requireAdminSupabaseClient();
    const { error } = await supabase
      .from('site_settings')
      .delete()
      .eq('key', CORTEX_AI_OPENROUTER_MODEL_SELECTION_SETTING_KEY);

    if (error) {
      throw new Error(error.message);
    }
  } catch (error) {
    redirectWithStatus(
      'error',
      error instanceof Error ? error.message : 'Failed to clear Cortex AI model selection.'
    );
  }

  revalidatePath(CORTEX_AI_SETTINGS_PATH);
  redirectWithStatus('success', 'Cortex AI model selection cleared.');
}
