'use server';

import { revalidatePath } from 'next/cache';

import {
  CORTEX_AI_OPENROUTER_MODEL_SELECTION_SETTING_KEY,
  CORTEX_AI_OPENROUTER_SETTING_KEY,
  CORTEX_AI_PEXELS_SETTING_KEY,
  CORTEX_AI_UNSPLASH_SETTING_KEY,
  createCortexAiStoredModelSelection,
  encryptStoredOpenRouterApiKey,
  getMaskedOpenRouterKey,
  getStoredOpenRouterKeyStatus,
  listCortexAiCompatibleOpenRouterModels,
  verifyOpenRouterApiKey,
  verifyPexelsApiKey,
  verifyUnsplashAccessKey,
  type CortexAiKeyVerification,
  type CortexAiStoredModelSelection,
} from '@nextblock-cms/cortex';

import type { CortexSetupPath } from '../../../../../lib/cortex-ai/setup-state';
import { createMcpAccessTokenAction, saveMcpSettingsAction } from '../mcp-actions';
import { requireAdminSupabaseClient } from '../require-admin';

/**
 * Server actions for the Cortex AI first-run wizard.
 *
 * Unlike `../actions.ts` these return results instead of redirecting with a
 * `?success=` banner: the wizard keeps the operator on one screen and renders the
 * outcome inline (a green check, or the exact reason a key was refused). Each key is
 * verified against its provider BEFORE it is stored, so nothing that fails here can
 * be saved by accident — except when the provider is unreachable and the operator
 * explicitly chooses "save anyway".
 */

const CORTEX_AI_SETTINGS_PATH = '/cms/settings/cortex-ai';
const ONBOARDING_STATE_KEY = 'onboarding_state';

type VerificationFailure = { reason: 'invalid' | 'unreachable' | 'error'; message: string };

function sandboxRejection(): VerificationFailure | null {
  if (process.env.NEXT_PUBLIC_IS_SANDBOX !== 'true') {
    return null;
  }

  return {
    message: 'The shared sandbox cannot store keys. Use the Cortex AI settings page, which keeps them in your browser.',
    reason: 'error',
  };
}

function toFailure(verification: Extract<CortexAiKeyVerification, { ok: false }>): VerificationFailure {
  return { message: verification.message, reason: verification.reason };
}

function revalidateCortexSurfaces() {
  revalidatePath(CORTEX_AI_SETTINGS_PATH);
  revalidatePath(`${CORTEX_AI_SETTINGS_PATH}/setup`);
  revalidatePath('/cms/dashboard');
  // The CMS layout passes the model-key bit to the chat drawer.
  revalidatePath('/cms', 'layout');
}

export type ConnectOpenRouterKeyResult =
  | {
      success: true;
      maskedKey: string;
      detail: string | null;
      /** Null when the key was stored unverified. */
      isFreeTier: boolean | null;
      verified: boolean;
    }
  | ({ success: false } & VerificationFailure);

export async function connectOpenRouterKeyAction(input: {
  apiKey: string;
  /** Store the key even though the provider could not be reached to verify it. */
  allowUnverified?: boolean;
}): Promise<ConnectOpenRouterKeyResult> {
  const rejected = sandboxRejection();
  if (rejected) return { success: false, ...rejected };

  try {
    const { supabase } = await requireAdminSupabaseClient();
    const apiKey = String(input.apiKey || '').trim();
    const verification = await verifyOpenRouterApiKey({ apiKey });

    if (!verification.ok && !(verification.reason === 'unreachable' && input.allowUnverified)) {
      return { success: false, ...toFailure(verification) };
    }

    const { error } = await supabase.from('site_settings').upsert({
      key: CORTEX_AI_OPENROUTER_SETTING_KEY,
      value: encryptStoredOpenRouterApiKey(apiKey),
    });

    if (error) {
      throw new Error(error.message);
    }

    revalidateCortexSurfaces();

    return {
      detail: verification.ok ? verification.detail : null,
      isFreeTier: verification.ok ? verification.isFreeTier : null,
      maskedKey: getMaskedOpenRouterKey(apiKey.slice(-4)),
      success: true,
      verified: verification.ok,
    };
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : 'Failed to save the OpenRouter key.',
      reason: 'error',
      success: false,
    };
  }
}

export type SelectModelForSetupResult =
  | { success: true; model: CortexAiStoredModelSelection | null }
  | { success: false; message: string };

/**
 * Pick the model the stored key should drive, or `null` for the automatic free-model
 * rotation. Mirrors `saveCortexAiModelSelectionAction` (which redirects) but returns a
 * result so the wizard can stay on its screen. The catalog is re-read so a stale or
 * hand-typed id can never be stored.
 */
export async function selectModelForSetupAction(input: {
  modelId: string | null;
}): Promise<SelectModelForSetupResult> {
  const rejected = sandboxRejection();
  if (rejected) return { message: rejected.message, success: false };

  try {
    const { supabase } = await requireAdminSupabaseClient();
    const modelId = String(input.modelId || '').trim();

    if (!modelId) {
      const { error } = await supabase
        .from('site_settings')
        .delete()
        .eq('key', CORTEX_AI_OPENROUTER_MODEL_SELECTION_SETTING_KEY);

      if (error) {
        throw new Error(error.message);
      }

      revalidateCortexSurfaces();
      return { model: null, success: true };
    }

    const { data: storedKeyRow } = await supabase
      .from('site_settings')
      .select('value')
      .eq('key', CORTEX_AI_OPENROUTER_SETTING_KEY)
      .maybeSingle();

    if (!getStoredOpenRouterKeyStatus(storedKeyRow?.value).hasStoredKey) {
      return { message: 'Connect an OpenRouter key before choosing a model.', success: false };
    }

    const catalog = await listCortexAiCompatibleOpenRouterModels();
    const model = catalog.find((entry) => entry.id === modelId);

    if (!model) {
      return {
        message: 'That model is no longer available for tool calling on OpenRouter. Pick another.',
        success: false,
      };
    }

    const selection = createCortexAiStoredModelSelection(model);
    const { error } = await supabase.from('site_settings').upsert({
      key: CORTEX_AI_OPENROUTER_MODEL_SELECTION_SETTING_KEY,
      value: selection,
    });

    if (error) {
      throw new Error(error.message);
    }

    revalidateCortexSurfaces();
    return { model: selection, success: true };
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : 'Failed to save the model choice.',
      success: false,
    };
  }
}

export type StockProviderId = 'pexels' | 'unsplash';

export type SaveStockPhotoKeysResult = {
  success: boolean;
  saved: StockProviderId[];
  errors: Partial<Record<StockProviderId, VerificationFailure>>;
  /** A general (non-provider) failure, e.g. the database write. */
  message?: string;
};

export async function saveStockPhotoKeysForSetupAction(input: {
  pexelsKey?: string;
  unsplashKey?: string;
  allowUnverified?: boolean;
}): Promise<SaveStockPhotoKeysResult> {
  const rejected = sandboxRejection();
  if (rejected) return { errors: {}, message: rejected.message, saved: [], success: false };

  const pexelsKey = String(input.pexelsKey || '').trim();
  const unsplashKey = String(input.unsplashKey || '').trim();

  if (!pexelsKey && !unsplashKey) {
    return { errors: {}, message: 'Enter a Pexels or an Unsplash key, or skip this step.', saved: [], success: false };
  }

  try {
    const { supabase } = await requireAdminSupabaseClient();
    const [pexels, unsplash] = await Promise.all([
      pexelsKey ? verifyPexelsApiKey({ apiKey: pexelsKey }) : null,
      unsplashKey ? verifyUnsplashAccessKey({ accessKey: unsplashKey }) : null,
    ]);

    const errors: SaveStockPhotoKeysResult['errors'] = {};
    const rows: Array<{ key: string; value: unknown }> = [];
    const saved: StockProviderId[] = [];

    const consider = (provider: StockProviderId, key: string, verification: CortexAiKeyVerification | null, settingKey: string) => {
      if (!verification) return;

      if (verification.ok || (verification.reason === 'unreachable' && input.allowUnverified)) {
        rows.push({ key: settingKey, value: encryptStoredOpenRouterApiKey(key) });
        saved.push(provider);
        return;
      }

      errors[provider] = toFailure(verification);
    };

    consider('pexels', pexelsKey, pexels, CORTEX_AI_PEXELS_SETTING_KEY);
    consider('unsplash', unsplashKey, unsplash, CORTEX_AI_UNSPLASH_SETTING_KEY);

    if (rows.length > 0) {
      const { error } = await supabase.from('site_settings').upsert(rows);

      if (error) {
        throw new Error(error.message);
      }

      revalidateCortexSurfaces();
    }

    return { errors, saved, success: Object.keys(errors).length === 0 };
  } catch (error) {
    return {
      errors: {},
      message: error instanceof Error ? error.message : 'Failed to save the stock photo keys.',
      saved: [],
      success: false,
    };
  }
}

export type EnableMcpForSetupResult =
  | { success: true; token: string; tokenPrefix: string }
  | { success: false; message: string };

/**
 * Switch the MCP server on and mint one read+write token for the operator's own
 * machine. Localhost trust is left exactly as it was: the wizard never widens access
 * beyond what the operator asked for.
 */
export async function enableMcpForSetupAction(input: {
  allowLocalhostWithoutToken: boolean;
  tokenName: string;
}): Promise<EnableMcpForSetupResult> {
  const rejected = sandboxRejection();
  if (rejected) return { message: rejected.message, success: false };

  const settings = await saveMcpSettingsAction({
    allowLocalhostWithoutToken: input.allowLocalhostWithoutToken,
    enabled: true,
  });

  if (!settings.success) {
    return { message: settings.error ?? 'Failed to enable the MCP server.', success: false };
  }

  const minted = await createMcpAccessTokenAction({
    expiresInDays: null,
    name: input.tokenName.trim() || 'My computer',
    scopes: ['read', 'write'],
  });

  if (!minted.success || !minted.token || !minted.tokenPrefix) {
    return { message: minted.error ?? 'Failed to create the access token.', success: false };
  }

  revalidateCortexSurfaces();

  return { success: true, token: minted.token, tokenPrefix: minted.tokenPrefix };
}

/**
 * Record that the wizard was finished (or deliberately skipped) so the settings
 * page stops redirecting here. Read-merge into the `onboarding_state` bag the
 * dashboard checklist already uses.
 */
export async function completeCortexSetupAction(input: {
  path: CortexSetupPath;
}): Promise<{ success: boolean; message?: string }> {
  if (process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') {
    // Nothing to persist for a shared sandbox; the wizard is not rendered there anyway.
    return { success: true };
  }

  try {
    const { supabase } = await requireAdminSupabaseClient();
    const { data: existing } = await supabase
      .from('site_settings')
      .select('value')
      .eq('key', ONBOARDING_STATE_KEY)
      .maybeSingle();

    const current =
      existing?.value && typeof existing.value === 'object' && !Array.isArray(existing.value)
        ? (existing.value as Record<string, unknown>)
        : {};

    const { error } = await supabase.from('site_settings').upsert({
      key: ONBOARDING_STATE_KEY,
      value: {
        ...current,
        cortex_setup: { completed: true, completedAt: new Date().toISOString(), path: input.path },
      },
    });

    if (error) {
      throw new Error(error.message);
    }

    revalidateCortexSurfaces();

    return { success: true };
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : 'Failed to record the setup state.',
      success: false,
    };
  }
}
