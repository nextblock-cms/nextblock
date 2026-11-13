import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ verifyPackageOnline: vi.fn() }));

vi.mock('@nextblock-cms/db/server', () => ({ verifyPackageOnline: mocks.verifyPackageOnline }));

import { shouldShowSandboxDemoPartner } from './sandbox-demo-partner';

describe('shouldShowSandboxDemoPartner', () => {
  beforeEach(() => {
    mocks.verifyPackageOnline.mockReset();
    mocks.verifyPackageOnline.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is false outside the sandbox, without reading the package activation', async () => {
    for (const value of ['', 'false', 'TRUE', '1']) {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      await expect(shouldShowSandboxDemoPartner()).resolves.toBe(false);
    }
    expect(mocks.verifyPackageOnline).not.toHaveBeenCalled();
  });

  it('follows the Affiliates activation on the sandbox (the demo partner is seeded only then)', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    await expect(shouldShowSandboxDemoPartner()).resolves.toBe(true);
    expect(mocks.verifyPackageOnline).toHaveBeenCalledWith('affiliates');

    mocks.verifyPackageOnline.mockResolvedValue(false);
    await expect(shouldShowSandboxDemoPartner()).resolves.toBe(false);
  });

  it('hides the demo partner when the activation check fails', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    mocks.verifyPackageOnline.mockRejectedValue(new Error('network down'));
    await expect(shouldShowSandboxDemoPartner()).resolves.toBe(false);
  });
});
