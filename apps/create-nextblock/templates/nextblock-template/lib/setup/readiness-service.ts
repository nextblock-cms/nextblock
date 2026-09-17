import 'server-only';
// Collects everything the readiness report needs. Shared by GET /api/setup/status and the
// bootstrap route so both answer with the same shape.

import { getServiceRoleSupabaseClient, verifyPackageOnline } from '@nextblock-cms/db/server';
import {
  CORTEX_AI_PACKAGE_ID,
  readCortexAiMcpEnvToken,
  resolveCortexAiMcpSettings,
} from '@nextblock-cms/cortex';

import { ensureEnvLicenseActivation } from '../packages/env-license';
import { detectChannel, isFullyConfigured } from './env-status';
import { getProvisioningStatus } from './provisioning';
import { buildReadinessReport, type ReadinessReport } from './readiness';

export async function collectReadinessReport(): Promise<ReadinessReport> {
  const provisioning = await getProvisioningStatus();

  // Nothing below can work without a schema; report early rather than trip over
  // missing tables and mislabel the failure.
  const appUrl = process.env['NEXT_PUBLIC_URL'] ?? null;

  if (!provisioning.configured || !provisioning.schemaReady) {
    return buildReadinessReport({
      appUrl,
      channel: detectChannel(),
      cortexAiActive: false,
      envLicense: {
        attemptedAt: null,
        configured: Boolean(process.env['NEXTBLOCK_LICENSE_KEY']?.trim()),
        error: null,
        kind: null,
        packageId: CORTEX_AI_PACKAGE_ID,
        state: 'not_configured',
      },
      mcp: {
        enabled: false,
        envTokenConfigured: readCortexAiMcpEnvToken() !== null,
        localhostTrust: false,
      },
      production: process.env.NODE_ENV === 'production',
      provisioning,
    });
  }

  // Activates NEXTBLOCK_LICENSE_KEY on demand; a no-op read when nothing is configured
  // or the package is already active. Needs the service role to write the row.
  const envLicense = isFullyConfigured()
    ? await ensureEnvLicenseActivation()
    : {
        attemptedAt: null,
        configured: Boolean(process.env['NEXTBLOCK_LICENSE_KEY']?.trim()),
        error: 'The service-role key is required to activate an environment license.',
        kind: null,
        packageId: CORTEX_AI_PACKAGE_ID,
        state: 'failed' as const,
      };

  const [cortexAiActive, mcpSettings] = await Promise.all([
    verifyPackageOnline(CORTEX_AI_PACKAGE_ID),
    resolveCortexAiMcpSettings(safeServiceClient()),
  ]);

  return buildReadinessReport({
    appUrl,
    channel: detectChannel(),
    cortexAiActive,
    envLicense,
    mcp: {
      enabled: mcpSettings.enabled,
      envTokenConfigured: readCortexAiMcpEnvToken() !== null,
      localhostTrust: mcpSettings.allowLocalhostWithoutToken,
    },
    production: process.env.NODE_ENV === 'production',
    provisioning,
  });
}

function safeServiceClient() {
  try {
    return getServiceRoleSupabaseClient();
  } catch {
    return null;
  }
}
