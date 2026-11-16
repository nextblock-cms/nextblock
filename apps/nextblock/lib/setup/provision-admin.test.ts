import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * provisionFirstAdmin() backs the /setup wizard and POST /api/setup/bootstrap. On the public
 * sandbox it refuses before anything else: the sandbox's administrator is the published demo
 * account every reset restores. On 2026-11-13 cms.nextblock.dev's first-admin flag read false,
 * and /setup offered any visitor an account with an address of their choice.
 */

const mocks = vi.hoisted(() => ({
  getServiceRoleSupabaseClient: vi.fn(),
  assertNotProvisioned: vi.fn(),
  getProvisioningStatus: vi.fn(),
  applyMigrations: vi.fn(),
  resetDatabase: vi.fn(),
  setSystemConfigurationServiceRole: vi.fn(),
  getStorageBackend: vi.fn(),
  ensureStorageBucket: vi.fn(),
}));

vi.mock('@nextblock-cms/db/server', () => ({ getServiceRoleSupabaseClient: mocks.getServiceRoleSupabaseClient }));
vi.mock('./provisioning', () => ({
  assertNotProvisioned: mocks.assertNotProvisioned,
  getProvisioningStatus: mocks.getProvisioningStatus,
}));
vi.mock('./schema-apply', () => ({ applyMigrations: mocks.applyMigrations, resetDatabase: mocks.resetDatabase }));
vi.mock('./system-config', () => ({ setSystemConfigurationServiceRole: mocks.setSystemConfigurationServiceRole }));
vi.mock('../storage/provider', () => ({ getStorageBackend: mocks.getStorageBackend }));
vi.mock('../storage/supabase-storage', () => ({ ensureStorageBucket: mocks.ensureStorageBucket }));

import { provisionFirstAdmin } from './provision-admin';

const ADMIN = { email: 'visitor@example.com', fullName: 'A Visitor', password: 'long-enough-password' };

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('provisionFirstAdmin on the public sandbox', () => {
  it('refuses before it reads the provisioning state, builds the service client or touches an account', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    const result = await provisionFirstAdmin(ADMIN);

    expect(result).toMatchObject({ ok: false, code: 'sandbox' });
    expect(mocks.assertNotProvisioned).not.toHaveBeenCalled();
    expect(mocks.getProvisioningStatus).not.toHaveBeenCalled();
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
    expect(mocks.applyMigrations).not.toHaveBeenCalled();
    expect(mocks.resetDatabase).not.toHaveBeenCalled();
  });

  it('refuses a "clean database" reinstall there too', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    const result = await provisionFirstAdmin({ ...ADMIN, resetFirst: true });

    expect(result).toMatchObject({ ok: false, code: 'sandbox' });
    expect(mocks.resetDatabase).not.toHaveBeenCalled();
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });

  it('keeps the one-shot check everywhere else: a provisioned site refuses with already_provisioned', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'false');
    mocks.assertNotProvisioned.mockRejectedValueOnce(new Error('Setup has already been completed.'));

    const result = await provisionFirstAdmin(ADMIN);

    expect(result).toMatchObject({ ok: false, code: 'already_provisioned' });
    expect(mocks.assertNotProvisioned).toHaveBeenCalledTimes(1);
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });
});
