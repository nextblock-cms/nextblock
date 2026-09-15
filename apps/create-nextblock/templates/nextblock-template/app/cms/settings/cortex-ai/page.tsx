import { redirect } from 'next/navigation';

import { listCortexAiCompatibleOpenRouterModels } from '@nextblock-cms/cortex';
import { getCortexSetupStatus } from '../../../../lib/cortex-ai/setup-status';
import { CORTEX_SETUP_PATH } from '../../../../lib/cortex-ai/site-builder-prompt';
import { getCortexAiSettingsStatus } from './actions';
import { CortexAiSettingsClient } from './CortexAiSettingsClient';
import { getMcpSettingsStatus, type McpSettingsStatus } from './mcp-actions';
import { McpServerSettingsCard } from './McpServerSettingsCard';
import { resolveLocalOrigin, resolveSiteOrigin } from './origins';

type CortexAiSettingsPageProps = {
  searchParams?: Promise<{
    error?: string;
    success?: string;
  }>;
};

const SANDBOX_MCP_NOTICE =
  'This is a shared sandbox, so the switches and the token list are locked — enabling a remote ' +
  'write surface or minting a token here would apply to every visitor at once. Everything else ' +
  'works: the endpoint and the client snippets below are exactly what you get on your own ' +
  'NextBlock install, where you flip the switch, mint a token, and paste the config into Claude ' +
  'Code, Claude Desktop, Cursor, or VS Code.';

export default async function CortexAiSettingsPage({
  searchParams,
}: CortexAiSettingsPageProps) {
  const status = await getCortexAiSettingsStatus();

  if (!status.isPackageActive) {
    redirect('/cms/dashboard');
  }

  const isSandbox = process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';

  // A freshly activated package with nothing configured gets the three-step wizard
  // instead of this page, until a key or the MCP server exists or the admin has
  // finished/skipped the wizard (which records itself in onboarding_state).
  if (!isSandbox) {
    const setup = await getCortexSetupStatus();

    if (setup.needsSetup) {
      redirect(CORTEX_SETUP_PATH);
    }
  }
  const params: { error?: string; success?: string } = searchParams
    ? await searchParams
    : {};

  let compatibleModels: Awaited<ReturnType<typeof listCortexAiCompatibleOpenRouterModels>> = [];
  let modelCatalogError: string | null = null;

  if (status.hasStoredOpenRouterKey || isSandbox) {
    try {
      compatibleModels = await listCortexAiCompatibleOpenRouterModels();
    } catch (error) {
      modelCatalogError =
        error instanceof Error ? error.message : 'Failed to load compatible OpenRouter models.';
    }
  }

  const [mcpStatus, siteOrigin, localOrigin] = await Promise.all([
    getMcpSettingsStatus(),
    resolveSiteOrigin(),
    resolveLocalOrigin(),
  ]);

  // The sandbox sees the card, the endpoint, and the snippets — but never the token
  // list. Those rows belong to whoever runs the sandbox, and every visitor here shares
  // one admin login, so listing another visitor's token names would be a leak with no
  // upside (the card is read-only anyway, so nothing in it is actionable).
  const visibleMcpStatus: McpSettingsStatus = isSandbox
    ? { settings: mcpStatus.settings, tokens: [] }
    : mcpStatus;

  return (
    <CortexAiSettingsClient
      isSandbox={isSandbox}
      compatibleModels={compatibleModels}
      isPackageActive={status.isPackageActive}
      hasEnvOpenRouterKey={status.hasEnvOpenRouterKey}
      maskedEnvOpenRouterKey={status.maskedEnvOpenRouterKey}
      hasStoredOpenRouterKey={status.hasStoredOpenRouterKey}
      maskedStoredOpenRouterKey={status.maskedStoredOpenRouterKey}
      selectedModel={status.selectedModel}
      hasEncryptionKey={status.hasEncryptionKey}
      modelCatalogError={modelCatalogError}
      activeStockProvider={status.activeStockProvider}
      hasStoredPexelsKey={status.hasStoredPexelsKey}
      maskedStoredPexelsKey={status.maskedStoredPexelsKey}
      hasStoredUnsplashKey={status.hasStoredUnsplashKey}
      maskedStoredUnsplashKey={status.maskedStoredUnsplashKey}
      hasEnvPexelsKey={status.hasEnvPexelsKey}
      hasEnvUnsplashKey={status.hasEnvUnsplashKey}
      unsplashAppName={status.unsplashAppName}
      agentSettings={status.agentSettings}
      setupGuideHref={isSandbox ? null : CORTEX_SETUP_PATH}
      successMessage={params.success}
      errorMessage={params.error}
    >
      <McpServerSettingsCard
        allowLocalhostWithoutToken={visibleMcpStatus.settings.allowLocalhostWithoutToken}
        enabled={visibleMcpStatus.settings.enabled}
        localMcpUrl={`${localOrigin}/api/mcp`}
        mcpUrl={`${siteOrigin}/api/mcp`}
        readOnly={isSandbox}
        readOnlyNotice={isSandbox ? SANDBOX_MCP_NOTICE : undefined}
        tokens={visibleMcpStatus.tokens}
      />
    </CortexAiSettingsClient>
  );
}
