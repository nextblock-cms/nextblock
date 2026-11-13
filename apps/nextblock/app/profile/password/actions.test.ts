import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * changePasswordAction (/profile/password). The sandbox publishes its demo logins (2026-11-03), so
 * a visitor who changed the shared admin's password would lock every later visitor out until the
 * next reset. On the sandbox the action redirects to /profile before it builds a Supabase client,
 * so auth.updateUser never runs. Off the sandbox it changes the password as before.
 */

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getUser: vi.fn(),
  updateUser: vi.fn(),
  encodedRedirect: vi.fn(),
  // What next/navigation's redirect() throws inside a server action.
  redirect: vi.fn((url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;push;${url};307;` });
  }),
}));

vi.mock('@nextblock-cms/db/server', async () => ({
  createClient: mocks.createClient,
  // The real predicate (a dependency-free module), so the env stub drives it.
  isSandboxEnvironment: (
    await vi.importActual<{ isSandboxEnvironment: () => boolean }>('../../../../../libs/db/src/lib/config-resolve')
  ).isSandboxEnvironment,
}));
vi.mock('@nextblock-cms/utils/server', () => ({ encodedRedirect: mocks.encodedRedirect }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import { changePasswordAction } from './actions';

const NEW_PASSWORD = { password: 'a-new-password-1234', confirmPassword: 'a-new-password-1234' };

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  mocks.redirect.mockClear();
  mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: 'admin-1' } }, error: null });
  mocks.updateUser.mockReset().mockResolvedValue({ error: null });
  mocks.createClient
    .mockReset()
    .mockImplementation(() => ({ auth: { getUser: mocks.getUser, updateUser: mocks.updateUser } }));
  mocks.encodedRedirect.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('changePasswordAction', () => {
  it('redirects to /profile on the sandbox before building a client, so the password never changes', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    await expect(changePasswordAction(form(NEW_PASSWORD))).rejects.toMatchObject({
      message: 'NEXT_REDIRECT',
      digest: 'NEXT_REDIRECT;push;/profile;307;',
    });
    expect(mocks.redirect).toHaveBeenCalledTimes(1);
    expect(mocks.redirect).toHaveBeenCalledWith('/profile');
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.updateUser).not.toHaveBeenCalled();
    expect(mocks.encodedRedirect).not.toHaveBeenCalled();
  });

  it('changes the password anywhere else (only the exact value "true" is the sandbox)', async () => {
    for (const value of ['', 'false', 'TRUE', '1']) {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      mocks.updateUser.mockClear();

      await changePasswordAction(form(NEW_PASSWORD));

      expect(mocks.updateUser, value).toHaveBeenCalledTimes(1);
      expect(mocks.updateUser, value).toHaveBeenCalledWith({ password: 'a-new-password-1234' });
      expect(mocks.encodedRedirect, value).toHaveBeenLastCalledWith(
        'success',
        '/profile/password',
        'password_updated_success'
      );
    }
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
