import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sandbox's demo admin login is public (2026-11-03): "Send test email" must not mail an
 * arbitrary address on the deployment's SMTP account, and the settings form must not reach the
 * database there (saveEmailSettings refuses; its own tests cover that).
 */

const mocks = vi.hoisted(() => ({
  role: 'ADMIN' as string | null,
  sendEmail: vi.fn(),
  saveEmailSettings: vi.fn(),
}));

vi.mock('@nextblock-cms/db/server', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: mocks.role ? { id: 'admin-1' } : null } }) },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: mocks.role ? { role: mocks.role } : null, error: null }),
        }),
      }),
    }),
  }),
  isSandboxEnvironment: () => process.env['NEXT_PUBLIC_IS_SANDBOX'] === 'true',
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../../../actions/email', () => ({ sendEmail: mocks.sendEmail }));
vi.mock('../../../../lib/config/email-settings', () => ({ saveEmailSettings: mocks.saveEmailSettings }));

import { sendTestEmail, updateEmailSettings } from './actions';

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

beforeEach(() => {
  mocks.role = 'ADMIN';
  mocks.sendEmail.mockReset().mockResolvedValue({ messageId: 'm-1' });
  mocks.saveEmailSettings.mockReset().mockResolvedValue(undefined);
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

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

  it('refuses a caller who is not an admin', async () => {
    mocks.role = 'WRITER';

    expect(await sendTestEmail(form({ to: 'owner@site.example' }))).toMatchObject({ ok: false });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
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
});
