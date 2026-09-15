import 'server-only';

import { createClient } from '@nextblock-cms/db/server';
import {
  CORTEX_AI_OPENROUTER_SETTING_KEY,
  CORTEX_AI_SITE_BRIEF_SETTING_KEY,
  getCortexAiEnvConfig,
  getStoredOpenRouterKeyStatus,
  isCortexSiteBriefComplete,
  safeParseCortexSiteBrief,
} from '@nextblock-cms/cortex';

export type CortexChatStatus = {
  /** The dashboard chat can reach a model (stored BYOK key or env key). */
  hasModelKey: boolean;
  /**
   * A complete site brief (name + description) is saved, so the site builder can skip
   * the interview. Same predicate as the chat route and the wizard, so the kickoff
   * prompt never contradicts the system prompt.
   */
  hasSiteBrief: boolean;
};

/**
 * The two bits the CMS layout hands to the chat drawer, in ONE query through the
 * caller's cookie session (the key row is admin-only under RLS; every caller is on
 * an admin-gated surface). Cheap enough to run on every CMS render for admins.
 */
export async function getCortexChatStatus(): Promise<CortexChatStatus> {
  const supabase = createClient();
  const { data: rows } = await supabase
    .from('site_settings')
    .select('key, value')
    .in('key', [CORTEX_AI_OPENROUTER_SETTING_KEY, CORTEX_AI_SITE_BRIEF_SETTING_KEY]);

  const byKey = new Map((rows ?? []).map((row) => [row.key, row.value]));

  return {
    hasModelKey:
      getCortexAiEnvConfig().hasOpenRouterEnvKey ||
      getStoredOpenRouterKeyStatus(byKey.get(CORTEX_AI_OPENROUTER_SETTING_KEY)).hasStoredKey,
    hasSiteBrief: isCortexSiteBriefComplete(safeParseCortexSiteBrief(byKey.get(CORTEX_AI_SITE_BRIEF_SETTING_KEY))),
  };
}
