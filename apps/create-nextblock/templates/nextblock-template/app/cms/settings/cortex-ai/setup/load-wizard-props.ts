import 'server-only';

import {
  getCortexAiEnvConfig,
  getStoredCortexAiModelSelection,
  listCortexAiCompatibleOpenRouterModels,
} from '@nextblock-cms/cortex';

import type { CortexSetupStatus } from '../../../../../lib/cortex-ai/setup-status';
import { resolveLocalOrigin, resolveSiteOrigin } from '../origins';

/**
 * Everything `CortexSetupWizard` needs from the server, gathered once so the setup
 * route and the post-install welcome flow render the identical wizard.
 */
export async function loadCortexSetupWizardProps(status: CortexSetupStatus) {
  // The catalog is public (no key needed) and the wizard shows the model picker the
  // moment a key verifies, so it is loaded up front; a catalog outage degrades to
  // "free models" rather than blocking the wizard.
  const [siteOrigin, localOrigin, compatibleModels, selectedModel] = await Promise.all([
    resolveSiteOrigin(),
    resolveLocalOrigin(),
    listCortexAiCompatibleOpenRouterModels().catch(() => null),
    status.hasStoredOpenRouterKey ? getStoredCortexAiModelSelection().catch(() => null) : null,
  ]);

  return {
    allowLocalhostWithoutToken: status.allowLocalhostWithoutToken,
    compatibleModels: compatibleModels ?? [],
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
