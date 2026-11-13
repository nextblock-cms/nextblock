import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sandbox's demo admin login is public (2026-11-03): turning auto-approve on there would let
 * anyone create live, confirmed accounts without an email round trip. updateRegistrationSettings
 * refuses on the sandbox before it reads the session or writes system_configuration.
 */

const mocks = vi.hoisted(() => ({
  role: 'ADMIN' as string | null,
  createClient: vi.fn(),
  updateSystemConfiguration: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('@nextblock-cms/db/server', () => ({ createClient: mocks.createClient }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('../../../../lib/setup/system-config', () => ({
  getSystemConfiguration: vi.fn(),
  updateSystemConfiguration: mocks.updateSystemConfiguration,
}));

import { updateRegistrationSettings } from './actions';

function form(autoAcceptSignups: string): FormData {
  const data = new FormData();
  data.set('autoAcceptSignups', autoAcceptSignups);
  return data;
}

beforeEach(() => {
  mocks.role = 'ADMIN';
  mocks.createClient.mockReset().mockImplementation(() => ({
    auth: { getUser: async () => ({ data: { user: mocks.role ? { id: 'admin-1' } : null } }) },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: mocks.role ? { role: mocks.role } : null, error: null }),
        }),
      }),
    }),
  }));
  mocks.updateSystemConfiguration.mockReset().mockResolvedValue(undefined);
  mocks.revalidatePath.mockReset();
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('updateRegistrationSettings', () => {
  it('refuses on the sandbox without reading the session or writing anything', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    for (const value of ['on', '']) {
      expect(await updateRegistrationSettings(form(value))).toEqual({
        ok: false,
        error: 'Sign-up settings are disabled in the sandbox.',
      });
    }
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.updateSystemConfiguration).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('off the sandbox, saves the switch for an admin', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'false');

    expect(await updateRegistrationSettings(form('on'))).toEqual({ ok: true, message: 'Registration settings saved.' });
    expect(mocks.updateSystemConfiguration).toHaveBeenCalledWith({ auto_accept_signups: true });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/cms/settings/registration');

    await updateRegistrationSettings(form(''));
    expect(mocks.updateSystemConfiguration).toHaveBeenLastCalledWith({ auto_accept_signups: false });
  });

  it('off the sandbox, still refuses a caller who is not an admin', async () => {
    mocks.role = 'WRITER';

    expect(await updateRegistrationSettings(form('on'))).toEqual({
      ok: false,
      error: 'You do not have permission to perform this action.',
    });
    expect(mocks.updateSystemConfiguration).not.toHaveBeenCalled();
  });
});
