import { describe, expect, it } from 'vitest';

import { deriveCortexSetupState, readCortexSetupRecord } from './setup-state';

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
});
