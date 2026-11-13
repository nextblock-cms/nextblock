import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The writes of /cms/settings/security on the sandbox. Its demo admin login is public (2026-11-03),
 * so each one refuses there before it reads the session or writes anything: the sign-up policy card
 * (updateAutoAcceptSignups, system_configuration), the global security policy card
 * (updateGlobalSecuritySettings: trusted-device days and staff 2FA enforcement), and the
 * second-factor enrollment and device actions (a factor enrolled on a shared demo account would make
 * the database ask every other visitor for a second factor until the next reset deletes it). Off the
 * sandbox (any value but the exact
 * string 'true') each one still reaches the session check, and the two policy cards still save.
 */

const mocks = vi.hoisted(() => ({
  role: 'ADMIN' as string | null,
  twoFactor: 'satisfied' as string,
  createClient: vi.fn(),
  getServiceRoleSupabaseClient: vi.fn(),
  evaluateTwoFactor: vi.fn(),
  updateSystemConfiguration: vi.fn(),
  saveSecuritySettings: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('@nextblock-cms/db/server', () => ({
  createClient: mocks.createClient,
  getServiceRoleSupabaseClient: mocks.getServiceRoleSupabaseClient,
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('../../../actions/twoFactorEmail', () => ({ sendTwoFactorCodeEmail: vi.fn() }));
vi.mock('../../../../lib/privacy/settings', () => ({
  getSecuritySettings: vi.fn(),
  saveSecuritySettings: mocks.saveSecuritySettings,
}));
vi.mock('../../../../lib/auth/twoFactor', () => ({
  createEmailChallenge: vi.fn(),
  evaluateTwoFactor: mocks.evaluateTwoFactor,
  getEmailResendCooldownSeconds: vi.fn(),
  issueTwoFactorVerifiedCookie: vi.fn(),
  clearTwoFactorVerifiedCookie: vi.fn(),
  verifyEmailChallenge: vi.fn(),
}));
vi.mock('../../../../lib/auth/trustedDevices', () => ({
  listTrustedDevices: vi.fn(),
  revokeAllTrustedDevices: vi.fn(),
  revokeTrustedDevice: vi.fn(),
}));
vi.mock('../../../../lib/setup/system-config', () => ({
  getSystemConfiguration: vi.fn(),
  updateSystemConfiguration: mocks.updateSystemConfiguration,
}));
vi.mock('../../../../lib/config/email-settings', () => ({ isEmailConfigured: vi.fn() }));

import {
  disableMfa,
  revokeTrustedDeviceAction,
  sendEmailEnrollmentCode,
  startTotpEnrollment,
  updateAutoAcceptSignups,
  updateGlobalSecuritySettings,
  verifyEmailEnrollment,
  verifyTotpEnrollment,
} from './actions';

function form(enabled: boolean): FormData {
  const data = new FormData();
  data.set('auto_accept_signups', String(enabled));
  return data;
}

function policyForm(trustedDeviceDays: string, enforceStaff2fa: boolean): FormData {
  const data = new FormData();
  data.set('trusted_device_days', trustedDeviceDays);
  data.set('enforce_staff_2fa', String(enforceStaff2fa));
  return data;
}

beforeEach(() => {
  mocks.role = 'ADMIN';
  mocks.twoFactor = 'satisfied';
  mocks.createClient.mockReset().mockImplementation(() => ({
    auth: { getUser: async () => ({ data: { user: { id: 'admin-1' } } }) },
    from: () => ({
      select: () => ({
        eq: () => ({ single: async () => ({ data: mocks.role ? { role: mocks.role } : null, error: null }) }),
      }),
    }),
  }));
  mocks.getServiceRoleSupabaseClient.mockReset();
  mocks.evaluateTwoFactor.mockReset().mockImplementation(async () => ({ status: mocks.twoFactor }));
  mocks.updateSystemConfiguration.mockReset().mockResolvedValue(undefined);
  mocks.saveSecuritySettings.mockReset().mockResolvedValue(undefined);
  mocks.revalidatePath.mockReset();
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('updateAutoAcceptSignups', () => {
  it('refuses on the sandbox without reading the session or writing anything', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    for (const enabled of [true, false]) {
      expect(await updateAutoAcceptSignups(form(enabled))).toEqual({
        ok: false,
        error: 'Sign-up settings are disabled in the sandbox.',
      });
    }
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.evaluateTwoFactor).not.toHaveBeenCalled();
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
    expect(mocks.updateSystemConfiguration).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('off the sandbox, saves the policy for an admin', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'false');

    expect(await updateAutoAcceptSignups(form(true))).toEqual({
      ok: true,
      message: 'New sign-ups will be auto-approved without email verification.',
    });
    expect(mocks.updateSystemConfiguration).toHaveBeenCalledWith({ auto_accept_signups: true });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/cms/settings/security');

    expect(await updateAutoAcceptSignups(form(false))).toEqual({
      ok: true,
      message: 'New sign-ups now require email verification.',
    });
    expect(mocks.updateSystemConfiguration).toHaveBeenLastCalledWith({ auto_accept_signups: false });
  });

  it('off the sandbox, still refuses a non-admin and a session that owes its second factor', async () => {
    mocks.role = 'WRITER';
    expect(await updateAutoAcceptSignups(form(true))).toEqual({
      ok: false,
      error: 'Only administrators can change the sign-up policy.',
    });

    mocks.role = 'ADMIN';
    mocks.twoFactor = 'totp_required';
    expect(await updateAutoAcceptSignups(form(true))).toEqual({
      ok: false,
      error: 'Verify your second factor before changing security settings.',
    });
    expect(mocks.updateSystemConfiguration).not.toHaveBeenCalled();
  });
});

describe('updateGlobalSecuritySettings', () => {
  // The sandbox refusal is in the ACTIONS table below; this is what it must not cost elsewhere.
  it('off the sandbox, saves the policy for an admin (only the exact value "true" is the sandbox)', async () => {
    for (const value of ['', 'false', 'TRUE', '1']) {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      mocks.saveSecuritySettings.mockClear();
      mocks.revalidatePath.mockClear();

      expect(await updateGlobalSecuritySettings(policyForm('7', true)), value).toEqual({
        ok: true,
        message: 'Security policy saved.',
      });
      expect(mocks.saveSecuritySettings, value).toHaveBeenCalledWith({ trusted_device_days: 7, enforce_staff_2fa: true });
      expect(mocks.revalidatePath, value).toHaveBeenCalledWith('/cms/settings/security');
    }
  });

  it('off the sandbox, still refuses a non-admin without saving', async () => {
    mocks.role = 'WRITER';
    expect(await updateGlobalSecuritySettings(policyForm('7', true))).toEqual({
      ok: false,
      error: 'Only administrators can change the global security policy.',
    });
    expect(mocks.saveSecuritySettings).not.toHaveBeenCalled();
  });
});

describe('global policy, second-factor enrollment and devices', () => {
  const codeForm = () => {
    const data = new FormData();
    data.set('factorId', 'factor-1');
    data.set('code', '123456');
    data.set('id', 'device-1');
    return data;
  };
  const ACTIONS: Array<[string, () => Promise<unknown>]> = [
    ['updateGlobalSecuritySettings', () => updateGlobalSecuritySettings(policyForm('7', true))],
    ['startTotpEnrollment', () => startTotpEnrollment()],
    ['verifyTotpEnrollment', () => verifyTotpEnrollment(codeForm())],
    ['sendEmailEnrollmentCode', () => sendEmailEnrollmentCode()],
    ['verifyEmailEnrollment', () => verifyEmailEnrollment(codeForm())],
    ['disableMfa', () => disableMfa()],
    ['revokeTrustedDeviceAction', () => revokeTrustedDeviceAction(codeForm())],
  ];

  it.each(ACTIONS)('%s refuses on the sandbox before the session, MFA or the service role', async (_name, run) => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    await expect(run()).resolves.toEqual({ ok: false, error: 'Security settings are disabled in the sandbox environment.' });

    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.evaluateTwoFactor).not.toHaveBeenCalled();
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
    expect(mocks.saveSecuritySettings).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it.each(ACTIONS)('%s gets past the refusal off the sandbox (only the exact value "true" is the sandbox)', async (_name, run) => {
    for (const value of ['', 'false', 'TRUE', '1']) {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      mocks.createClient.mockClear();

      const result = await run().catch((error: unknown) => ({ thrown: error }));

      expect(result, value).not.toEqual({ ok: false, error: 'Security settings are disabled in the sandbox environment.' });
      expect(mocks.createClient, value).toHaveBeenCalled();
    }
  });
});
