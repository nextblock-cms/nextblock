import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * submitFeedback (app/actions/feedback.ts): the CMS feedback modal's action. It mails the product
 * feedback inbox through sendEmail, which reads the SMTP settings and credentials with the service
 * role, and a server action never passes the CMS layout's 2FA redirect. Until 2026-11-13 its staff
 * check read the role through the cookie client, so a session whose enrolled second factor was still
 * pending passed it (findRoleReadsBeforeServiceRole in server-action-actors.test.ts listed it as
 * known). It now resolves getCmsActor(), and this file runs the real one, with evaluateTwoFactor()
 * behind it, against a faked cookie session, as app/actions/package-actions.test.ts does. Who may send
 * is unchanged: ADMIN and WRITER, to the inbox fixed in code, under the session's own identity.
 */

const INBOX = 'feedback-inbox@nextblock.example';

const mocks = vi.hoisted(() => ({
  user: { id: 'staff-1', email: 'sam@site.example' } as { id: string; email?: string } | null,
  role: 'WRITER' as string | null,
  fullName: 'Sam Staff' as string | null,
  /** The caller's `user_security_settings` row: the second factor they enrolled, if any. */
  mfa: null as { mfa_enabled: boolean; mfa_type: 'totp' | 'email' } | null,
  /** The assurance level of this session (a TOTP factor is verified at aal2). */
  aal: 'aal1' as 'aal1' | 'aal2',
  /** Every column list the cookie client was asked for on `profiles`, in order. */
  profileSelects: [] as string[],
  sendEmail: vi.fn(async (_message: Record<string, unknown>) => undefined),
  createCookieClient: vi.fn(),
  getServiceRoleSupabaseClient: vi.fn(),
}));

vi.mock('@nextblock-cms/db/server', () => ({
  createClient: mocks.createCookieClient,
  getServiceRoleSupabaseClient: mocks.getServiceRoleSupabaseClient,
}));
vi.mock('./email', () => ({
  PRODUCT_FEEDBACK_INBOX: 'feedback-inbox@nextblock.example',
  sendEmail: mocks.sendEmail,
}));
// No trusted-device or email-code cookie: the second factor counts only through the session itself.
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));
// Read only by the trusted-device and reminder paths, never on the way to these decisions.
vi.mock('../../lib/privacy/settings', () => ({
  getSecuritySettings: async () => ({ enforce_staff_2fa: false, trusted_device_days: 30 }),
}));

import { submitFeedback } from './feedback';

/** The cookie session: the signed-in user, their own profile row and second factor, the session's assurance level. */
function fakeCookieClient() {
  const read = async (table: string, columns: string) => {
    if (table === 'profiles') {
      mocks.profileSelects.push(columns);
      return { data: mocks.role ? { role: mocks.role, full_name: mocks.fullName } : null, error: null };
    }
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
      select: (columns: string) => ({
        eq: () => ({ maybeSingle: () => read(table, columns), single: () => read(table, columns) }),
      }),
    }),
  };
}

const FEEDBACK = { subject: 'Media grid', message: 'The grid jumps\nwhen I scroll.', url: '/cms/media' };

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocks.user = { id: 'staff-1', email: 'sam@site.example' };
  mocks.role = 'WRITER';
  mocks.fullName = 'Sam Staff';
  mocks.mfa = null;
  mocks.aal = 'aal1';
  mocks.profileSelects = [];
  mocks.sendEmail.mockReset().mockImplementation(async () => undefined);
  mocks.createCookieClient.mockReset().mockImplementation(() => fakeCookieClient());
  mocks.getServiceRoleSupabaseClient.mockReset().mockImplementation(() => {
    throw new Error('submitFeedback itself never takes the service role');
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('submitFeedback authorizes through getCmsActor()', () => {
  it('refuses a caller with no session', async () => {
    mocks.user = null;
    mocks.role = null;

    expect(await submitFeedback(FEEDBACK)).toEqual({ success: false, error: 'You must be signed in to send feedback.' });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('refuses a signed-in customer (USER)', async () => {
    mocks.role = 'USER';

    expect(await submitFeedback(FEEDBACK)).toEqual({ success: false, error: 'You do not have permission to send feedback.' });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it.each<readonly [string, () => void]>([
    ['an ADMIN whose enrolled authenticator app this session has not passed (aal1)', () => {
      mocks.role = 'ADMIN';
      mocks.mfa = { mfa_enabled: true, mfa_type: 'totp' };
    }],
    ['an ADMIN whose enrolled email code this session has not passed', () => {
      mocks.role = 'ADMIN';
      mocks.mfa = { mfa_enabled: true, mfa_type: 'email' };
    }],
    ['a WRITER whose enrolled authenticator app this session has not passed (aal1)', () => {
      mocks.mfa = { mfa_enabled: true, mfa_type: 'totp' };
    }],
    ['a WRITER whose enrolled email code this session has not passed', () => {
      mocks.mfa = { mfa_enabled: true, mfa_type: 'email' };
    }],
  ])('refuses %s, sending nothing', async (_label, arrange) => {
    arrange();

    expect(await submitFeedback(FEEDBACK)).toEqual({
      success: false,
      error: 'Complete two-factor verification, then try again.',
    });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    // The role was never read outside getCmsActor(), which stops at the pending factor.
    expect(mocks.profileSelects).toEqual([]);
  });

  it('sends for an ADMIN whose session passed the enrolled authenticator app (aal2)', async () => {
    mocks.role = 'ADMIN';
    mocks.mfa = { mfa_enabled: true, mfa_type: 'totp' };
    mocks.aal = 'aal2';

    expect(await submitFeedback(FEEDBACK)).toEqual({ success: true });
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendEmail.mock.calls[0][0]).toMatchObject({ to: INBOX, subject: '[CMS Feedback] Media grid' });
  });

  it('sends for a WRITER who enrolled no second factor, under the session identity and to the fixed inbox', async () => {
    const result = await submitFeedback({
      ...FEEDBACK,
      subject: 'Bug\r\nBcc: someone@else.example',
      userEmail: 'spoofed@else.example',
      userName: 'Someone Else',
    });

    expect(result).toEqual({ success: true });
    const message = mocks.sendEmail.mock.calls[0][0] as { to: string; subject: string; text: string; html: string };
    expect(message.to).toBe(INBOX);
    expect(message.subject).toBe('[CMS Feedback] Bug Bcc: someone@else.example');
    expect(message.text).toContain('From: Sam Staff (sam@site.example)');
    expect(message.text).not.toContain('Someone Else');
    expect(message.html).not.toContain('spoofed@else.example');
    // The role comes from getCmsActor() alone; the action itself reads only the display name.
    expect(mocks.profileSelects).toEqual(['role', 'full_name']);
  });

  it('still checks the message only after the caller is authorized', async () => {
    mocks.mfa = { mfa_enabled: true, mfa_type: 'totp' };

    expect(await submitFeedback({ subject: 'x', message: '   ' })).toEqual({
      success: false,
      error: 'Complete two-factor verification, then try again.',
    });

    mocks.aal = 'aal2';
    expect(await submitFeedback({ subject: 'x', message: '   ' })).toEqual({ success: false, error: 'Feedback message is empty.' });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});
