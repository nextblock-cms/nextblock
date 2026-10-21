import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-10-21: `recordMediaUpload` is a server action (a public POST endpoint) that took the
 * uploader from `payload.actorUserId` and wrote with the service role; the session
 * cross-check ran only when a session existed, so a cookieless POST naming an admin's id
 * (public via posts.author_id) recorded media as that admin. The action now takes the
 * uploader from the session only, and the actor variant lives in a module that is not a
 * server action.
 */

const mocks = vi.hoisted(() => ({
  inserts: [] as Array<{ client: string; row: Record<string, unknown> }>,
  roles: {} as Record<string, string>,
  serviceClientBuilt: 0,
  sessionUser: null as { id: string } | null,
}));

function client(name: 'cookie' | 'service') {
  return {
    auth: {
      getUser: async () => ({ data: { user: name === 'cookie' ? mocks.sessionUser : null }, error: null }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal1' } }) },
    },
    from(table: string) {
      const state: { id?: unknown; row?: Record<string, unknown> } = {};
      const chain: any = {
        select: () => chain,
        eq: (_column: string, value: unknown) => {
          state.id = value;
          return chain;
        },
        insert: (row: Record<string, unknown>) => {
          state.row = row;
          mocks.inserts.push({ client: name, row });
          return chain;
        },
        maybeSingle: async () => resolve(),
        single: async () => resolve(),
      };
      const resolve = () => {
        if (table === 'profiles') {
          const role = mocks.roles[String(state.id)];
          return { data: role ? { role } : null, error: null };
        }
        if (table === 'media') {
          return { data: { id: 'media-1', ...state.row }, error: null };
        }
        return { data: null, error: null };
      };
      return chain;
    },
  };
}

vi.mock('./supabase/server', () => ({
  createClient: () => client('cookie'),
  getServiceRoleSupabaseClient: () => {
    mocks.serviceClientBuilt += 1;
    return client('service');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@nextblock-cms/utils/server', () => ({
  encodedRedirect: (type: string, path: string, message: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { message, path, type });
  },
}));

import { recordMediaUpload } from './media-actions';
import { recordMediaUploadAsActor } from './media-record';

const GATE = Symbol.for('nextblock.cms.secondFactorGate');

const variant = {
  fileType: 'image/png',
  height: 10,
  objectKey: 'uploads/a.png',
  sizeBytes: 100,
  url: 'https://cdn.example.test/uploads/a.png',
  variantLabel: 'original',
  width: 10,
};
const payload = { fileName: 'a.png', originalImageDetails: variant, r2OriginalKey: 'uploads/a.png', r2Variants: [variant] };

beforeEach(() => {
  mocks.inserts.length = 0;
  mocks.serviceClientBuilt = 0;
  mocks.sessionUser = null;
  mocks.roles = { 'admin-1': 'ADMIN', 'user-1': 'USER', 'writer-1': 'WRITER' };
  (globalThis as Record<symbol, unknown>)[GATE] = async () => true;
});

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[GATE];
});

describe('recordMediaUpload (server action)', () => {
  it('refuses a cookieless POST that names an admin as the actor', async () => {
    const result = await recordMediaUpload({ ...payload, actorUserId: 'admin-1' } as typeof payload, true);

    expect(result).toEqual({ error: 'User not authenticated for media record.' });
    expect(mocks.inserts).toEqual([]);
    expect(mocks.serviceClientBuilt).toBe(0);
  });

  it('attributes the row to the session user, whatever the payload says', async () => {
    mocks.sessionUser = { id: 'writer-1' };

    const result = await recordMediaUpload({ ...payload, actorUserId: 'admin-1' } as typeof payload, true);

    expect(result).toMatchObject({ success: true });
    expect(mocks.inserts).toEqual([{ client: 'cookie', row: expect.objectContaining({ uploader_id: 'writer-1' }) }]);
    expect(mocks.serviceClientBuilt).toBe(0);
  });

  it('refuses a session without the CMS role or the second factor', async () => {
    mocks.sessionUser = { id: 'user-1' };
    await expect(recordMediaUpload(payload, true)).resolves.toEqual({
      error: 'Forbidden: Insufficient permissions to record media.',
    });

    mocks.sessionUser = { id: 'admin-1' };
    (globalThis as Record<symbol, unknown>)[GATE] = async () => false;
    await expect(recordMediaUpload(payload, true)).resolves.toEqual({
      error: 'Forbidden: Insufficient permissions to record media.',
    });
    expect(mocks.inserts).toEqual([]);
  });
});

describe('recordMediaUploadAsActor (server-only, not an action)', () => {
  it('records as an authenticated staff actor and refuses anyone else', async () => {
    await expect(recordMediaUploadAsActor(payload, 'user-1')).resolves.toEqual({
      error: 'Forbidden: Insufficient permissions to record media.',
    });
    await expect(recordMediaUploadAsActor(payload, 'nobody')).resolves.toMatchObject({ error: expect.any(String) });
    expect(mocks.inserts).toEqual([]);

    await expect(recordMediaUploadAsActor(payload, 'admin-1')).resolves.toMatchObject({ success: true });
    expect(mocks.inserts).toEqual([{ client: 'service', row: expect.objectContaining({ uploader_id: 'admin-1' }) }]);
  });
});
