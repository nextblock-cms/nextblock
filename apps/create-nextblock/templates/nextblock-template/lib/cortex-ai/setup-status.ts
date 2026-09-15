import 'server-only';

import { createClient } from '@nextblock-cms/db/server';
import {
  CORTEX_AI_MCP_SETTINGS_KEY,
  CORTEX_AI_OPENROUTER_SETTING_KEY,
  CORTEX_AI_PEXELS_SETTING_KEY,
  CORTEX_AI_UNSPLASH_SETTING_KEY,
  getCortexAiEnvConfig,
  getPexelsEnvApiKey,
  getStoredOpenRouterKeyStatus,
  getUnsplashEnvApiKey,
  normalizeCortexAiMcpSettings,
} from '@nextblock-cms/cortex';

import {
  deriveCortexSetupState,
  readCortexSetupRecord,
  type CortexSetupState,
} from './setup-state';

const ONBOARDING_STATE_KEY = 'onboarding_state';

export type CortexSetupStatus = CortexSetupState & {
  allowLocalhostWithoutToken: boolean;
  hasPexelsKey: boolean;
  hasUnsplashKey: boolean;
  maskedStoredOpenRouterKey: string | null;
};

/**
 * One round-trip for everything the wizard and its redirects need. Reads through
 * the caller's cookie session: the secret rows are admin-only under RLS, and every
 * caller of this function is on an admin-gated surface.
 */
export async function getCortexSetupStatus(): Promise<CortexSetupStatus> {
  const supabase = createClient();
  const { data: rows } = await supabase
    .from('site_settings')
    .select('key, value')
    .in('key', [
      CORTEX_AI_MCP_SETTINGS_KEY,
      CORTEX_AI_OPENROUTER_SETTING_KEY,
      CORTEX_AI_PEXELS_SETTING_KEY,
      CORTEX_AI_UNSPLASH_SETTING_KEY,
      ONBOARDING_STATE_KEY,
    ]);

  const byKey = new Map((rows ?? []).map((row) => [row.key, row.value]));
  const storedKey = getStoredOpenRouterKeyStatus(byKey.get(CORTEX_AI_OPENROUTER_SETTING_KEY));
  const mcpSettings = normalizeCortexAiMcpSettings(byKey.get(CORTEX_AI_MCP_SETTINGS_KEY));
  const env = getCortexAiEnvConfig();

  return {
    ...deriveCortexSetupState({
      hasEnvOpenRouterKey: env.hasOpenRouterEnvKey,
      hasStoredOpenRouterKey: storedKey.hasStoredKey,
      mcpEnabled: mcpSettings.enabled,
      setup: readCortexSetupRecord(byKey.get(ONBOARDING_STATE_KEY)),
    }),
    allowLocalhostWithoutToken: mcpSettings.allowLocalhostWithoutToken,
    hasPexelsKey:
      getStoredOpenRouterKeyStatus(byKey.get(CORTEX_AI_PEXELS_SETTING_KEY)).hasStoredKey ||
      Boolean(getPexelsEnvApiKey()),
    hasUnsplashKey:
      getStoredOpenRouterKeyStatus(byKey.get(CORTEX_AI_UNSPLASH_SETTING_KEY)).hasStoredKey ||
      Boolean(getUnsplashEnvApiKey()),
    maskedStoredOpenRouterKey: storedKey.maskedKey,
  };
}

/**
 * The single bit the CMS layout needs for the chat drawer: can the dashboard chat
 * reach a model at all? Cheap enough to run on every CMS render for admins.
 */
export async function hasCortexModelKey(): Promise<boolean> {
  if (getCortexAiEnvConfig().hasOpenRouterEnvKey) {
    return true;
  }

  const supabase = createClient();
  const { data } = await supabase
    .from('site_settings')
    .select('value')
    .eq('key', CORTEX_AI_OPENROUTER_SETTING_KEY)
    .maybeSingle();

  return getStoredOpenRouterKeyStatus(data?.value).hasStoredKey;
}
