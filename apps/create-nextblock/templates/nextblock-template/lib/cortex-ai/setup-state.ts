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
  /**
   * The site builder may open straight away, without showing the wizard first.
   *
   * Stricter than `hasModelKey` on purpose. An ENV key means a self-host that never
   * needed the wizard. A STORED key is only "ready" once the wizard was finished or
   * skipped: the key is saved on step 1, before the operator has picked a model, added
   * photo keys, or clicked "Start building", so a stored key with the wizard unfinished
   * must render the wizard (step 1 shows the connected key and the model picker), never
   * the chat. `/cms/welcome` and the setup page redirect on this flag, not on
   * `hasModelKey`.
   */
  readyForSiteBuilder: boolean;
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
    readyForSiteBuilder: hasModelKey && !(inputs.hasStoredOpenRouterKey && !completed),
  };
}

export type CortexWelcomeDestination = 'site-builder' | 'dashboard' | 'wizard';

/**
 * Where `/cms/welcome` sends an administrator whose Cortex package is active.
 *
 * Pure so the rule is unit-testable, and — the property that matters — STABLE
 * ACROSS THE WIZARD'S OWN SAVES. That page re-runs on the server whenever the
 * client router re-fetches the current route while the wizard is mounted on it,
 * which happens not only after a server action that revalidates (none of the
 * wizard's do) but also after ANY server action that writes a cookie, such as the
 * Supabase session refresh that any action can trigger once the access token has
 * aged. So every state the wizard can put the install into mid-flow must map to
 * `'wizard'`:
 *
 *   key       wizard finished/skipped   MCP on   ->  destination
 *   env       any                       any          site-builder  (self-host; the wizard is never needed)
 *   stored    yes                       any          site-builder
 *   stored    no                        any          wizard        (step 1 stored the key; model, photos, brief still to come)
 *   none      no                        yes          wizard        (step 1 switched MCP on; the client config is still to come)
 *   none      no                        no           wizard        (nothing configured yet)
 *   none      yes                       any          dashboard     (finished or skipped: nothing left to ask)
 *
 * The "MCP on, wizard unfinished" row is the one an earlier version sent to the
 * dashboard — exactly the state after step 1 on the MCP path, so a session-cookie
 * refresh during the brief form threw the operator out of the wizard before the
 * build step.
 */
export function resolveCortexWelcomeDestination(state: CortexSetupState): CortexWelcomeDestination {
  if (state.readyForSiteBuilder) {
    return 'site-builder';
  }

  if (state.setup?.completed === true) {
    return 'dashboard';
  }

  return 'wizard';
}
