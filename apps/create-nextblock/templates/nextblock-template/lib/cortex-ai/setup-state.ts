/**
 * What the Cortex AI first-run wizard needs to know, and how the rest of the CMS
 * decides whether to send an admin there.
 *
 * The wizard exists because a freshly activated trial has no way to talk to a
 * model yet: the dashboard chat needs an OpenRouter key, and an external MCP
 * client needs the MCP server switched on with a token. Until one of those is
 * true — or the admin has explicitly finished or skipped the wizard — every path
 * into the site builder lands on the wizard instead of a red "no key" error.
 *
 * `deriveCortexSetupState` is pure so the rule is unit-testable; the async loader
 * below just gathers the inputs.
 */

export type CortexSetupPath = 'chat' | 'mcp' | 'later';

export type CortexSetupRecord = {
  completed: boolean;
  completedAt?: string;
  path?: CortexSetupPath;
};

export type CortexSetupInputs = {
  hasEnvOpenRouterKey: boolean;
  hasStoredOpenRouterKey: boolean;
  mcpEnabled: boolean;
  setup: CortexSetupRecord | null;
};

export type CortexSetupState = CortexSetupInputs & {
  /** A model key the dashboard chat can use exists (stored BYOK or env). */
  hasModelKey: boolean;
  /**
   * Nothing is configured and the wizard was never finished or skipped: the settings
   * page redirects to the wizard, and the chat sends a key-less admin there.
   */
  needsSetup: boolean;
};

/** The `onboarding_state.cortex_setup` sub-record, tolerant of anything on disk. */
export function readCortexSetupRecord(onboardingState: unknown): CortexSetupRecord | null {
  if (!onboardingState || typeof onboardingState !== 'object' || Array.isArray(onboardingState)) {
    return null;
  }

  const raw = (onboardingState as Record<string, unknown>)['cortex_setup'];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const path = record['path'];

  return {
    completed: record['completed'] === true,
    ...(typeof record['completedAt'] === 'string' ? { completedAt: record['completedAt'] } : {}),
    ...(path === 'chat' || path === 'mcp' || path === 'later' ? { path } : {}),
  };
}

export function deriveCortexSetupState(inputs: CortexSetupInputs): CortexSetupState {
  const hasModelKey = inputs.hasStoredOpenRouterKey || inputs.hasEnvOpenRouterKey;
  const completed = inputs.setup?.completed === true;

  return {
    ...inputs,
    hasModelKey,
    needsSetup: !completed && !hasModelKey && !inputs.mcpEnabled,
  };
}
