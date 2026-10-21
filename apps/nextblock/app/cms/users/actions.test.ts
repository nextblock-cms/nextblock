import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-10-21: an MCP token acts as the admin who minted it, and nothing revoked it when
 * that admin was demoted or deleted. These drive updateUserProfile / deleteUserAndProfile
 * with mocked Supabase clients and assert the tokens are revoked first, and that a failed
 * revoke stops the change.
 */

const calls: string[] = [];

const mocks = vi.hoisted(() => ({
  currentRole: 'ADMIN' as string,
  revokeError: null as string | null,
}));

function serviceClient() {
  return {
    auth: {
      admin: {
        deleteUser: async (id: string) => {
          calls.push(`auth.deleteUser:${id}`);
          return { error: null };
        },
      },
    },
    from(table: string) {
      const state: { op: string; values?: unknown } = { op: 'select' };
      const chain: any = {
        select() {
          return chain;
        },
        update(values: unknown) {
          state.op = 'update';
          state.values = values;
          return chain;
        },
        eq(column: string, value: unknown) {
          if (state.op === 'update') calls.push(`${table}.update:${JSON.stringify(state.values)}:${column}=${value}`);
          return chain;
        },
        maybeSingle: async () => ({ data: { role: mocks.currentRole }, error: null }),
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve({ count: 2, data: null, error: null }).then(resolve);
        },
      };
      return chain;
    },
  };
}

vi.mock('@supabase/supabase-js', () => ({ createClient: () => serviceClient() }));

vi.mock('@nextblock-cms/db/server', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'admin-1' } }, error: null }) },
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: { role: 'ADMIN' }, error: null }) }) }),
    }),
  }),
}));

vi.mock('@nextblock-cms/cortex', () => ({
  revokeCortexAiMcpTokensForUser: async (_client: unknown, userId: string) => {
    calls.push(`revokeMcpTokens:${userId}`);
    return { error: mocks.revokeError };
  },
}));

vi.mock('@nextblock-cms/ecommerce', () => ({ normalizeCustomerAddress: (value: unknown) => value }));
vi.mock('@nextblock-cms/ecommerce/server', () => ({ upsertDefaultUserAddresses: async () => undefined }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { url });
  },
}));
vi.mock('../../../lib/setup/env-status', () => ({ resolveSupabaseUrl: () => 'https://db.example.test' }));
vi.mock('../../../lib/setup/service-key', () => ({ resolveSupabaseServiceKey: () => 'service-key' }));

import { deleteUserAndProfile, updateUserProfile } from './actions';

function profileForm(role: string) {
  const form = new FormData();
  form.set('role', role);
  form.set('full_name', 'Former Admin');
  return form;
}

beforeEach(() => {
  calls.length = 0;
  mocks.currentRole = 'ADMIN';
  mocks.revokeError = null;
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://db.example.test');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
});

describe('MCP token revocation on role changes', () => {
  it('revokes the user’s tokens before changing their role', async () => {
    await expect(updateUserProfile('user-2', profileForm('WRITER'))).rejects.toThrow('NEXT_REDIRECT');

    expect(calls[0]).toBe('revokeMcpTokens:user-2');
    expect(calls[1]).toMatch(/^profiles\.update:.*"role":"WRITER".*:id=user-2$/);
  });

  it('leaves tokens alone when the role does not change', async () => {
    await expect(updateUserProfile('user-2', profileForm('ADMIN'))).rejects.toThrow('NEXT_REDIRECT');

    expect(calls.some((call) => call.startsWith('revokeMcpTokens'))).toBe(false);
  });

  it('changes nothing when the revoke fails', async () => {
    mocks.revokeError = 'denied';

    await expect(updateUserProfile('user-2', profileForm('USER'))).resolves.toEqual({
      error: expect.stringMatching(/MCP tokens could not be revoked/),
    });
    expect(calls).toEqual(['revokeMcpTokens:user-2']);
  });
});

describe('MCP token revocation on delete', () => {
  it('revokes the user’s tokens before deleting the account', async () => {
    await expect(deleteUserAndProfile('user-2')).rejects.toThrow('NEXT_REDIRECT');

    expect(calls).toEqual(['revokeMcpTokens:user-2', 'auth.deleteUser:user-2']);
  });

  it('keeps the account when the revoke fails', async () => {
    mocks.revokeError = 'denied';

    await expect(deleteUserAndProfile('user-2')).resolves.toEqual({
      error: expect.stringMatching(/MCP tokens could not be revoked/),
    });
    expect(calls).toEqual(['revokeMcpTokens:user-2']);
  });
});
