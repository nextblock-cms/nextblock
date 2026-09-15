import 'server-only';

import {
  getCortexAiEnvConfig,
  getStoredCortexAiModelSelection,
  listCortexAiCompatibleOpenRouterModels,
  readCortexSiteBrief,
  type CortexSiteBrief,
} from '@nextblock-cms/cortex';
import { createClient } from '@nextblock-cms/db/server';

import type { CortexSetupStatus } from '../../../../../lib/cortex-ai/setup-status';
import { getActiveLanguagesServerSide } from '../../languages/actions';
import { resolveLocalOrigin, resolveSiteOrigin } from '../origins';

/** A language the site brief form can offer: the public site's active languages. */
export type CortexSetupWizardLanguage = { code: string; name: string; isDefault: boolean };

/**
 * Everything `CortexSetupWizard` needs from the server, gathered once so the setup
 * route and the post-install welcome flow render the identical wizard.
 */
export async function loadCortexSetupWizardProps(status: CortexSetupStatus) {
  // The catalog is public (no key needed) and the wizard shows the model picker the
  // moment a key verifies, so it is loaded up front; a catalog outage degrades to
  // "free models" rather than blocking the wizard.
  const [siteOrigin, localOrigin, compatibleModels, selectedModel, languages, existingBrief] =
    await Promise.all([
      resolveSiteOrigin(),
      resolveLocalOrigin(),
      listCortexAiCompatibleOpenRouterModels().catch(() => null),
      status.hasStoredOpenRouterKey ? getStoredCortexAiModelSelection().catch(() => null) : null,
      getActiveLanguagesServerSide().catch(() => []),
      // The brief step prefills from a brief saved earlier (an interrupted wizard run,
      // or one Cortex wrote during a chat interview). A read failure just means "none".
      readCortexSiteBrief(createClient()).catch((): CortexSiteBrief | null => null),
    ]);

  const activeLanguages: CortexSetupWizardLanguage[] = languages.map((language) => ({
    code: language.code,
    isDefault: language.is_default === true,
    name: language.name,
  }));

  return {
    activeLanguages,
    allowLocalhostWithoutToken: status.allowLocalhostWithoutToken,
    compatibleModels: compatibleModels ?? [],
    existingBrief,
    hasEncryptionKey: getCortexAiEnvConfig().hasEncryptionKey,
    hasEnvOpenRouterKey: status.hasEnvOpenRouterKey,
    hasPexelsKey: status.hasPexelsKey,
    hasStoredOpenRouterKey: status.hasStoredOpenRouterKey,
    hasUnsplashKey: status.hasUnsplashKey,
    localMcpUrl: `${localOrigin}/api/mcp`,
    maskedStoredOpenRouterKey: status.maskedStoredOpenRouterKey,
    mcpEnabled: status.mcpEnabled,
    mcpUrl: `${siteOrigin}/api/mcp`,
    modelCatalogUnavailable: compatibleModels === null,
    selectedModel,
  };
}
