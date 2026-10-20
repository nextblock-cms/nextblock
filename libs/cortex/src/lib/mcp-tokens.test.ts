import { describe, expect, it, vi } from 'vitest';

import {
  CORTEX_AI_MCP_SETTINGS_DEFAULTS,
  normalizeCortexAiMcpSettings,
  shouldTrustLocalMcpRequest,
} from './mcp-tokens';

/**
 * These lock in the closed-by-default posture for the tokenless loopback path
 * (security remediation): a fresh install, or any install that never wrote the
 * `cortex_ai_mcp_settings` row, must require a bearer token on every origin. The
 * endpoint layers two more opt-ins on top (the NEXTBLOCK_MCP_TRUST_LOCALHOST
 * environment variable and a forwarded-peer-is-loopback check), but this is the
 * dashboard half, and it now starts off.
 */
describe('Cortex AI MCP localhost-trust defaults', () => {
  it('defaults allowLocalhostWithoutToken to false (and the server to disabled)', () => {
    expect(CORTEX_AI_MCP_SETTINGS_DEFAULTS.allowLocalhostWithoutToken).toBe(false);
    expect(CORTEX_AI_MCP_SETTINGS_DEFAULTS.enabled).toBe(false);
  });

  it('falls back to the closed default when the key is absent or not a boolean', () => {
    expect(normalizeCortexAiMcpSettings(undefined).allowLocalhostWithoutToken).toBe(false);
    expect(normalizeCortexAiMcpSettings({}).allowLocalhostWithoutToken).toBe(false);
    expect(normalizeCortexAiMcpSettings({ enabled: true }).allowLocalhostWithoutToken).toBe(false);
    expect(
      normalizeCortexAiMcpSettings({ allowLocalhostWithoutToken: 'yes' }).allowLocalhostWithoutToken
    ).toBe(false);
  });

  it('still honours an explicit opt-in so operators who turned it on keep it', () => {
    expect(
      normalizeCortexAiMcpSettings({ allowLocalhostWithoutToken: true }).allowLocalhostWithoutToken
    ).toBe(true);
  });

  it('refuses tokenless localhost trust under the default settings, even on loopback in dev', () => {
    try {
      vi.stubEnv('NODE_ENV', 'development');
      expect(
        shouldTrustLocalMcpRequest({
          hostHeader: 'localhost:4200',
          settings: { ...CORTEX_AI_MCP_SETTINGS_DEFAULTS },
        })
      ).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
