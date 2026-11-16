import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The email settings actions (app/cms/settings/email/actions.ts).
 *
 * "Send test email" reads the SMTP settings and credentials with the service role and mails the
 * address an admin typed. Until 2026-11-13 its admin check read the role through the cookie client,
 * so an ADMIN password alone (the first factor) sent mail through the site's SMTP account to any
 * address: server actions never pass the CMS layout's 2FA redirect. The check now resolves
 * getCmsActor(), and this file runs the real one, with evaluateTwoFactor() behind it, against a
 * faked cookie session, as app/actions/package-actions.test.ts does. Who may act is unchanged:
 * ADMIN only.
 *
 * The sandbox's demo admin login is public (2026-11-03): "Send test email" must not mail an
 * arbitrary address on the deployment's SMTP account, and the settings form must not reach the
 * database there (saveEmailSettings refuses; its own tests cover that).
 */

const mocks = vi.hoisted(() => ({
  user: { id: 'admin-1' } as { id: string } | null,
  role: 'ADMIN' as string | null,
  /** The caller's `user_security_settings` row: the second factor they enrolled, if any. */
  mfa: null as { mfa_enabled: boolean; mfa_type: 'totp' | 'email' } | null,
  /** The assurance level of this session (a TOTP factor is verified at aal2). */
  aal: 'aal1' as 'aal1' | 'aal2',
  createCookieClient: vi.fn(),
  getServiceRoleSupabaseClient: vi.fn(),
  sendEmail: vi.fn(),
  saveEmailSettings: vi.fn(),
}));

vi.mock('@nextblock-cms/db/server', async () => ({
  createClient: mocks.createCookieClient,
  getServiceRoleSupabaseClient: mocks.getServiceRoleSupabaseClient,
  // The real predicate (a dependency-free module), so the env stub drives it.
  isSandboxEnvironment: (
    await vi.importActual<{ isSandboxEnvironment: () => boolean }>('../../../../../../libs/db/src/lib/config-resolve')
  ).isSandboxEnvironment,
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
// No trusted-device or email-code cookie: the second factor counts only through the session itself.
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));
vi.mock('../../../actions/email', () => ({ sendEmail: mocks.sendEmail }));
vi.mock('../../../../lib/config/email-settings', () => ({ saveEmailSettings: mocks.saveEmailSettings }));
// Read only by the trusted-device and reminder paths, never on the way to these decisions.
vi.mock('../../../../lib/privacy/settings', () => ({
  getSecuritySettings: async () => ({ enforce_staff_2fa: false, trusted_device_days: 30 }),
}));

import { sendTestEmail, updateEmailSettings } from './actions';

/** The cookie session: the signed-in user, their own profile role and second factor, the session's assurance level. */
function fakeCookieClient() {
  const read = async (table: string) => {
    if (table === 'profiles') return { data: mocks.role ? { role: mocks.role } : null, error: null };
    if (table === 'user_security_settings') return { data: mocks.mfa, error: null };
    throw new Error(`Unexpected cookie-client read of ${table}`);
  };
  return {
    auth: {
      getUser: async () => ({ data: { user: mocks.user }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: mocks.aal, nextLevel: 'aal2' }, error: null }),
      },
    },
    from: (table: string) => ({
      // `single` too: the pre-2026-11-13 admin check read the role that way, so a return to it is
      // judged by the refusals below rather than by a missing method.
      select: () => ({ eq: () => ({ maybeSingle: () => read(table), single: () => read(table) }) }),
    }),
  };
}

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  mocks.user = { id: 'admin-1' };
  mocks.role = 'ADMIN';
  mocks.mfa = null;
  mocks.aal = 'aal1';
  mocks.createCookieClient.mockReset().mockImplementation(() => fakeCookieClient());
  mocks.getServiceRoleSupabaseClient.mockReset();
  mocks.sendEmail.mockReset().mockResolvedValue({ messageId: 'm-1' });
  mocks.saveEmailSettings.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const SECOND_FACTOR = 'Complete two-factor verification, then try again.';

/** Callers adminCheck() refuses, each with the error the actions return. */
const REFUSED_CALLERS: ReadonlyArray<readonly [string, () => void, string]> = [
  ['a caller with no session', () => {
    mocks.user = null;
    mocks.role = null;
  }, 'You must be logged in to update settings.'],
  ['a WRITER', () => {
    mocks.role = 'WRITER';
  }, 'You do not have permission to perform this action.'],
  ['an ADMIN whose enrolled authenticator app this session has not passed (aal1)', () => {
    mocks.mfa = { mfa_enabled: true, mfa_type: 'totp' };
    mocks.aal = 'aal1';
  }, SECOND_FACTOR],
  ['an ADMIN whose enrolled email code this session has not passed', () => {
    mocks.mfa = { mfa_enabled: true, mfa_type: 'email' };
  }, SECOND_FACTOR],
];

describe('sendTestEmail', () => {
  it('refuses on the sandbox without sending anything', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    expect(await sendTestEmail(form({ to: 'anyone@example.org' }))).toEqual({
      ok: false,
      error: 'Test emails are turned off in the sandbox.',
    });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('sends one test message to the address an admin typed on a regular install', async () => {
    expect(await sendTestEmail(form({ to: 'owner@site.example' }))).toEqual({
      ok: true,
      message: 'Test email sent to owner@site.example.',
    });
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendEmail.mock.calls[0][0]).toMatchObject({ to: 'owner@site.example', subject: 'Test email' });
  });

  it.each(REFUSED_CALLERS)('refuses %s without sending anything', async (_label, arrange, message) => {
    arrange();

    expect(await sendTestEmail(form({ to: 'attacker@evil.example' }))).toEqual({ ok: false, error: message });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });

  it('sends for an ADMIN whose session passed the enrolled second factor (aal2)', async () => {
    mocks.mfa = { mfa_enabled: true, mfa_type: 'totp' };
    mocks.aal = 'aal2';

    expect(await sendTestEmail(form({ to: 'owner@site.example' }))).toEqual({
      ok: true,
      message: 'Test email sent to owner@site.example.',
    });
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
  });
});

describe('updateEmailSettings', () => {
  it("returns the save's refusal as the form's error", async () => {
    mocks.saveEmailSettings.mockRejectedValue(new Error('Email settings cannot be changed in the sandbox.'));

    expect(await updateEmailSettings(form({ host: 'smtp.attacker.example' }))).toEqual({
      ok: false,
      error: 'Email settings cannot be changed in the sandbox.',
    });
  });

  it.each(REFUSED_CALLERS)('refuses %s before the save', async (_label, arrange, message) => {
    arrange();

    expect(await updateEmailSettings(form({ host: 'smtp.attacker.example' }))).toEqual({ ok: false, error: message });
    expect(mocks.saveEmailSettings).not.toHaveBeenCalled();
  });

  it('saves for an ADMIN whose session passed the enrolled second factor (aal2)', async () => {
    mocks.mfa = { mfa_enabled: true, mfa_type: 'totp' };
    mocks.aal = 'aal2';

    expect(await updateEmailSettings(form({ host: 'smtp.site.example', port: '587' }))).toEqual({
      ok: true,
      message: 'Email settings saved.',
    });
    expect(mocks.saveEmailSettings).toHaveBeenCalledWith(expect.objectContaining({ host: 'smtp.site.example', port: '587' }));
  });
});
