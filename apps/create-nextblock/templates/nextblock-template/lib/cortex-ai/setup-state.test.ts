import { describe, expect, it } from 'vitest';

import { deriveCortexSetupState, readCortexSetupRecord, resolveCortexWelcomeDestination } from './setup-state';

describe('readCortexSetupRecord', () => {
  it('returns null when the onboarding bag has no cortex_setup entry', () => {
    expect(readCortexSetupRecord(null)).toBeNull();
    expect(readCortexSetupRecord({ dismissed: true })).toBeNull();
    expect(readCortexSetupRecord({ cortex_setup: 'yes' })).toBeNull();
  });

  it('keeps only the fields it understands', () => {
    expect(
      readCortexSetupRecord({
        cortex_setup: { completed: true, completedAt: '2026-09-15T10:00:00Z', path: 'mcp', junk: 1 },
      })
    ).toEqual({ completed: true, completedAt: '2026-09-15T10:00:00Z', path: 'mcp' });
    expect(readCortexSetupRecord({ cortex_setup: { completed: 'true', path: 'other' } })).toEqual({
      completed: false,
    });
  });
});

describe('deriveCortexSetupState', () => {
  const base = {
    hasEnvOpenRouterKey: false,
    hasStoredOpenRouterKey: false,
    mcpEnabled: false,
    setup: null,
  };

  it('needs setup on a fresh activation', () => {
    expect(deriveCortexSetupState(base)).toMatchObject({ hasModelKey: false, needsSetup: true });
  });

  it('is satisfied by a stored key, an env key, or an enabled MCP server', () => {
    expect(deriveCortexSetupState({ ...base, hasStoredOpenRouterKey: true })).toMatchObject({
      hasModelKey: true,
      needsSetup: false,
    });
    expect(deriveCortexSetupState({ ...base, hasEnvOpenRouterKey: true })).toMatchObject({
      hasModelKey: true,
      needsSetup: false,
    });
    expect(deriveCortexSetupState({ ...base, mcpEnabled: true })).toMatchObject({
      hasModelKey: false,
      needsSetup: false,
    });
  });

  it('respects an explicit finish or skip even with nothing configured', () => {
    expect(
      deriveCortexSetupState({ ...base, setup: { completed: true, path: 'later' } })
    ).toMatchObject({ hasModelKey: false, needsSetup: false });
    expect(deriveCortexSetupState({ ...base, setup: { completed: false } })).toMatchObject({
      needsSetup: true,
    });
  });

  describe('readyForSiteBuilder', () => {
    const finished = { completed: true, path: 'chat' } as const;

    it('is false without any model key, whatever the wizard state', () => {
      expect(deriveCortexSetupState(base).readyForSiteBuilder).toBe(false);
      expect(deriveCortexSetupState({ ...base, setup: finished }).readyForSiteBuilder).toBe(false);
      expect(deriveCortexSetupState({ ...base, mcpEnabled: true, setup: finished }).readyForSiteBuilder).toBe(false);
    });

    it('is true for an env key even when the wizard was never run (self-host)', () => {
      const state = deriveCortexSetupState({ ...base, hasEnvOpenRouterKey: true });
      expect(state).toMatchObject({ hasModelKey: true, needsSetup: false, readyForSiteBuilder: true });
    });

    it('is false for a stored key while the wizard is unfinished (mid-wizard, step 1 saved the key)', () => {
      expect(deriveCortexSetupState({ ...base, hasStoredOpenRouterKey: true })).toMatchObject({
        hasModelKey: true,
        needsSetup: false,
        readyForSiteBuilder: false,
      });
      expect(
        deriveCortexSetupState({ ...base, hasStoredOpenRouterKey: true, setup: { completed: false } })
      ).toMatchObject({ hasModelKey: true, needsSetup: false, readyForSiteBuilder: false });
    });

    it('is true for a stored key once the wizard was finished or skipped', () => {
      expect(
        deriveCortexSetupState({ ...base, hasStoredOpenRouterKey: true, setup: finished })
      ).toMatchObject({ hasModelKey: true, needsSetup: false, readyForSiteBuilder: true });
      expect(
        deriveCortexSetupState({ ...base, hasStoredOpenRouterKey: true, setup: { completed: true, path: 'later' } })
      ).toMatchObject({ readyForSiteBuilder: true });
    });

    it('keeps the wizard when a key was stored mid-wizard even if an env key also exists', () => {
      expect(
        deriveCortexSetupState({ ...base, hasEnvOpenRouterKey: true, hasStoredOpenRouterKey: true })
      ).toMatchObject({ readyForSiteBuilder: false });
    });
  });
});

describe('resolveCortexWelcomeDestination', () => {
  const base = {
    hasEnvOpenRouterKey: false,
    hasStoredOpenRouterKey: false,
    mcpEnabled: false,
    setup: null,
  };
  const finished = { completed: true, path: 'mcp' } as const;
  const destinationFor = (inputs: Parameters<typeof deriveCortexSetupState>[0]) =>
    resolveCortexWelcomeDestination(deriveCortexSetupState(inputs));

  it('opens the site builder only when it is ready: an env key, or a stored key with the wizard finished', () => {
    expect(destinationFor({ ...base, hasEnvOpenRouterKey: true })).toBe('site-builder');
    expect(destinationFor({ ...base, hasStoredOpenRouterKey: true, setup: { completed: true, path: 'chat' } })).toBe(
      'site-builder'
    );
  });

  it('renders the wizard for every mid-wizard state, including MCP switched on by step 1', () => {
    expect(destinationFor(base)).toBe('wizard');
    expect(destinationFor({ ...base, hasStoredOpenRouterKey: true })).toBe('wizard');
    expect(destinationFor({ ...base, mcpEnabled: true })).toBe('wizard');
    expect(destinationFor({ ...base, mcpEnabled: true, setup: { completed: false } })).toBe('wizard');
  });

  it('goes to the dashboard once the wizard was finished or skipped without a model key', () => {
    expect(destinationFor({ ...base, setup: finished })).toBe('dashboard');
    expect(destinationFor({ ...base, mcpEnabled: true, setup: finished })).toBe('dashboard');
    expect(destinationFor({ ...base, setup: { completed: true, path: 'later' } })).toBe('dashboard');
  });
});
