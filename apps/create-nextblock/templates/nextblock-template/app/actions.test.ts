import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The public sandbox publishes its demo logins (2026-11-03): it creates no accounts and sends no
 * account email. signUpAction and forgotPasswordAction refuse there before any Supabase call (the
 * cookie client, the service role, the system configuration and the bot check all reach it) and
 * answer the way each form shows errors. Off the sandbox both behave exactly as before.
 *
 * resetPasswordAction changed the signed-in user's password with no sandbox guard; it now refuses
 * there first, as its twin changePasswordAction does. forgotPasswordAction followed any
 * `callbackUrl` form value (an open redirect); it now follows only a site-relative path.
 */

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getServiceRoleSupabaseClient: vi.fn(),
  headers: vi.fn(),
  getSystemConfiguration: vi.fn(),
  verifyBotProtection: vi.fn(),
  signUp: vi.fn(),
  signInWithPassword: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  updateUser: vi.fn(),
  createUser: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${url};307;` });
  }),
}));

vi.mock('@nextblock-cms/db/server', async () => {
  const { isSandboxEnvironment } = await vi.importActual<typeof import('../../../libs/db/src/lib/config-resolve')>(
    '../../../libs/db/src/lib/config-resolve'
  );
  return {
    createClient: mocks.createClient,
    getServiceRoleSupabaseClient: mocks.getServiceRoleSupabaseClient,
    isSandboxEnvironment,
  };
});
vi.mock('next/headers', () => ({ headers: mocks.headers }));
vi.mock('next/server', () => ({ after: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('../lib/setup/system-config', () => ({ getSystemConfiguration: mocks.getSystemConfiguration }));
vi.mock('../lib/botProtection/verify', () => ({ verifyBotProtection: mocks.verifyBotProtection }));
vi.mock('../lib/auth/twoFactor', () => ({ createEmailChallenge: vi.fn(), evaluateTwoFactor: vi.fn() }));
vi.mock('../lib/auth/cookies', () => ({
  REMEMBER_INTENT_COOKIE: 'remember',
  TWO_FACTOR_COOKIE: 'two-factor',
  clearCookie: vi.fn(),
  setSecureCookie: vi.fn(),
}));
vi.mock('./actions/twoFactorEmail', () => ({ sendTwoFactorCodeEmail: vi.fn() }));

import { forgotPasswordAction, resetPasswordAction, signUpAction } from './actions';

/** NEXT_PUBLIC_IS_SANDBOX values that are not the sandbox: only the exact string 'true' is. */
const OFF_SANDBOX = ['', 'false', 'TRUE', '1'] as const;

const VISITOR = { email: 'visitor@example.com', password: 'correct horse battery' };

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

/** No call that could create an account, send an email or read the database happened. */
function expectNoSupabaseCall() {
  expect(mocks.createClient).not.toHaveBeenCalled();
  expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
  expect(mocks.getSystemConfiguration).not.toHaveBeenCalled();
  expect(mocks.verifyBotProtection).not.toHaveBeenCalled();
  expect(mocks.headers).not.toHaveBeenCalled();
  expect(mocks.signUp).not.toHaveBeenCalled();
  expect(mocks.createUser).not.toHaveBeenCalled();
  expect(mocks.signInWithPassword).not.toHaveBeenCalled();
  expect(mocks.resetPasswordForEmail).not.toHaveBeenCalled();
  expect(mocks.updateUser).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  vi.stubEnv('NEXT_PUBLIC_URL', '');
  mocks.redirect.mockClear();
  mocks.createClient.mockReset().mockReturnValue({
    auth: {
      signUp: mocks.signUp,
      signInWithPassword: mocks.signInWithPassword,
      resetPasswordForEmail: mocks.resetPasswordForEmail,
      updateUser: mocks.updateUser,
    },
  });
  mocks.getServiceRoleSupabaseClient.mockReset().mockReturnValue({ auth: { admin: { createUser: mocks.createUser } } });
  mocks.headers.mockReset().mockResolvedValue({ get: (name: string) => (name === 'origin' ? 'https://site.example' : null) });
  mocks.getSystemConfiguration.mockReset().mockResolvedValue({ auto_accept_signups: false, settings: {} });
  mocks.verifyBotProtection.mockReset().mockResolvedValue({ ok: true });
  mocks.signUp.mockReset().mockResolvedValue({ data: { session: null }, error: null });
  mocks.signInWithPassword.mockReset().mockResolvedValue({ data: {}, error: null });
  mocks.resetPasswordForEmail.mockReset().mockResolvedValue({ error: null });
  mocks.updateUser.mockReset().mockResolvedValue({ data: {}, error: null });
  mocks.createUser.mockReset().mockResolvedValue({ error: null });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('signUpAction', () => {
  it('refuses on the sandbox before any Supabase call, with the sign-up form error', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    await expect(signUpAction(form(VISITOR))).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.redirect).toHaveBeenCalledTimes(1);
    expect(mocks.redirect).toHaveBeenCalledWith('/sign-up?error=sandbox_signup_disabled');
    expectNoSupabaseCall();
  });

  it('refuses on the sandbox even when auto-approve is on and the honeypot is filled', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    mocks.getSystemConfiguration.mockResolvedValue({ auto_accept_signups: true, settings: {} });
    mocks.verifyBotProtection.mockResolvedValue({ ok: false, reason: 'honeypot' });

    await expect(signUpAction(form(VISITOR))).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.redirect).toHaveBeenCalledWith('/sign-up?error=sandbox_signup_disabled');
    expectNoSupabaseCall();
  });

  it('off the sandbox, signs up through Supabase with the confirmation link', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'false');

    await expect(signUpAction(form(VISITOR))).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.verifyBotProtection).toHaveBeenCalledTimes(1);
    expect(mocks.signUp).toHaveBeenCalledWith({
      ...VISITOR,
      options: { emailRedirectTo: 'https://site.example/auth/callback?redirect_to=/profile' },
    });
    expect(mocks.redirect).toHaveBeenCalledWith('/sign-up?success=auth.signup_check_email_profile');
    expect(mocks.createUser).not.toHaveBeenCalled();
  });

  it('off the sandbox, auto-approve still creates a confirmed account and signs it in', async () => {
    mocks.getSystemConfiguration.mockResolvedValue({ auto_accept_signups: true, settings: {} });

    await expect(signUpAction(form(VISITOR))).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.createUser).toHaveBeenCalledWith({ ...VISITOR, email_confirm: true });
    expect(mocks.signInWithPassword).toHaveBeenCalledWith(VISITOR);
    expect(mocks.redirect).toHaveBeenCalledWith('/post-sign-in');
    expect(mocks.signUp).not.toHaveBeenCalled();
  });

  it('off the sandbox, keeps the existing errors', async () => {
    await expect(signUpAction(form({ email: VISITOR.email }))).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.redirect).toHaveBeenLastCalledWith('/sign-up?error=Email%20and%20password%20are%20required');

    mocks.signUp.mockResolvedValue({ data: { session: null }, error: { code: '429', message: 'Email rate limit exceeded' } });
    await expect(signUpAction(form(VISITOR))).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.redirect).toHaveBeenLastCalledWith('/sign-up?error=auth.signup_rate_limit');
  });
});

describe('forgotPasswordAction', () => {
  it('refuses on the sandbox before any Supabase call, and never follows the callback URL', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    await expect(
      forgotPasswordAction(form({ email: 'demo@nextblock.dev', callbackUrl: 'https://elsewhere.example/' }))
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.redirect).toHaveBeenCalledTimes(1);
    expect(mocks.redirect).toHaveBeenCalledWith('/forgot-password?error=sandbox_signup_disabled');
    expectNoSupabaseCall();
  });

  it('off the sandbox, sends the reset link through Supabase', async () => {
    await expect(forgotPasswordAction(form({ email: 'owner@site.example' }))).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.resetPasswordForEmail).toHaveBeenCalledWith('owner@site.example', {
      redirectTo: 'https://site.example/auth/callback?redirect_to=/profile/password',
    });
    expect(mocks.redirect).toHaveBeenCalledWith(
      `/forgot-password?success=${encodeURIComponent('Check your email for a link to reset your password.')}`
    );
  });

  it('off the sandbox, keeps the existing errors', async () => {
    await expect(forgotPasswordAction(form({}))).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.redirect).toHaveBeenLastCalledWith('/forgot-password?error=Email%20is%20required');
    expect(mocks.resetPasswordForEmail).not.toHaveBeenCalled();

    mocks.resetPasswordForEmail.mockResolvedValue({ error: { message: 'smtp down' } });
    await expect(forgotPasswordAction(form({ email: 'owner@site.example' }))).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.redirect).toHaveBeenLastCalledWith('/forgot-password?error=Could%20not%20reset%20password');
  });
});

describe('forgotPasswordAction callbackUrl (an open redirect off the sandbox)', () => {
  // No form sets callbackUrl today (ForgotPasswordForm posts only the email); a site-relative
  // path still works, anything that leaves the site falls back to the normal success message.
  const SUCCESS = `/forgot-password?success=${encodeURIComponent('Check your email for a link to reset your password.')}`;

  it.each([
    ['an absolute URL', 'https://elsewhere.example/phish'],
    ['a scheme-relative URL', '//elsewhere.example/phish'],
    ['a backslash authority', '/\\elsewhere.example/phish'],
    ['an encoded leading slash', '/%2F/elsewhere.example'],
    ['a javascript: URL', 'javascript:alert(1)'],
  ])('ignores %s and shows the success message', async (_label, callbackUrl) => {
    await expect(forgotPasswordAction(form({ email: 'owner@site.example', callbackUrl }))).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.resetPasswordForEmail).toHaveBeenCalledTimes(1);
    expect(mocks.redirect).toHaveBeenCalledTimes(1);
    expect(mocks.redirect).toHaveBeenCalledWith(SUCCESS);
  });

  it.each(['/sign-in?reset=sent', '/profile/password'])('still follows the site-relative path %j', async (callbackUrl) => {
    await expect(forgotPasswordAction(form({ email: 'owner@site.example', callbackUrl }))).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.redirect).toHaveBeenCalledTimes(1);
    expect(mocks.redirect).toHaveBeenCalledWith(callbackUrl);
  });
});

describe('resetPasswordAction', () => {
  const PASSWORDS = { password: 'new correct horse', confirmPassword: 'new correct horse' };

  it.each([
    ['matching passwords', PASSWORDS],
    ['mismatched passwords', { password: 'one', confirmPassword: 'two' }],
    ['no passwords', {}],
  ])('refuses on the sandbox with %s before any Supabase call, as changePasswordAction does', async (_label, values) => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    await expect(resetPasswordAction(form(values))).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.redirect).toHaveBeenCalledTimes(1);
    expect(mocks.redirect).toHaveBeenCalledWith('/profile');
    expectNoSupabaseCall();
  });

  it.each(OFF_SANDBOX)('off the sandbox (NEXT_PUBLIC_IS_SANDBOX=%j), updates the password and redirects', async (value) => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);

    await expect(resetPasswordAction(form(PASSWORDS))).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.createClient).toHaveBeenCalledTimes(1);
    expect(mocks.updateUser).toHaveBeenCalledExactlyOnceWith({ password: PASSWORDS.password });
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith('/profile/password?success=Password%20updated');
  });

  it.each([
    ['mismatched passwords', { password: 'one', confirmPassword: 'two' }, 'Passwords%20do%20not%20match'],
    ['a missing confirmation', { password: 'one' }, 'Password%20and%20confirm%20password%20are%20required'],
    ['no passwords', {}, 'Password%20and%20confirm%20password%20are%20required'],
  ])('off the sandbox, stops at %s without changing the password (before 2026-11-03 it fell through)', async (_label, values, error) => {
    await expect(resetPasswordAction(form(values))).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.updateUser).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith(`/profile/password?error=${error}`);
  });

  it('off the sandbox, reports a failed update instead of claiming success', async () => {
    mocks.updateUser.mockResolvedValueOnce({ data: null, error: new Error('weak password') });

    await expect(resetPasswordAction(form(PASSWORDS))).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith('/profile/password?error=Password%20update%20failed');
  });
});
