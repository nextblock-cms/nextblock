import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Media UPDATE/DELETE is row-scoped to the uploader (or ADMIN) by RLS (migration 02022 §9).
 * The cookie-client CMS actions must therefore mutate the DB row FIRST and only touch the
 * storage objects for rows RLS actually returned: a non-owner WRITER matches zero rows, so
 * destroying the object up front would leave the row behind (an orphan) while the UI reported
 * success. These tests drive deleteMediaItem / deleteMultipleMediaItems / moveMultipleMediaItems
 * with a mocked Supabase + storage client and assert the DB-first ordering and the zero-row gate.
 *
 * Since migration 02028 a row also owns only the objects derived from its own object_key (the
 * upload pipeline's `<base>_<label>.avif` variants), and no key another media row still
 * references is deleted: the actions ask `media_storage_keys_in_use` (service role) and keep
 * every key it returns, or every key at all when the check fails. Without that, a WRITER's decoy
 * row listing another uploader's keys deleted their files.
 */

const callLog: string[] = [];

const mocks = vi.hoisted(() => ({
  // Configured per test: the rows the media WRITE (delete/update ... .select()) returns.
  mediaWrite: { data: [] as any[] | null, error: null as any },
  role: 'WRITER' as string | null,
  user: { id: 'user-1' } as { id: string } | null,
  backend: 's3' as 's3' | 'supabase',
  bucket: 'test-bucket' as string,
  // What media_storage_keys_in_use returns (keys another row references), and its error.
  inUse: [] as string[],
  inUseError: null as { message: string } | null,
  rpcCalls: [] as Array<{ fn: string; args: any }>,
}));

const s3Send = vi.fn(async (cmd: any) => {
  callLog.push(`s3.send:${cmd.__type}`);
  if (cmd.__type === 'HeadObject') {
    throw Object.assign(new Error('NotFound'), { name: 'NotFound' });
  }
  if (cmd.__type === 'DeleteObjects') {
    return { Errors: [] };
  }
  return {};
});

const supabaseRemoveObjects = vi.fn(async () => {
  callLog.push('supabase.removeObjects');
});

const encodedRedirect = vi.fn((type: string, path: string, message: string) => ({
  __redirect: { type, path, message },
}));

function makeSupabaseClient() {
  function resolve(state: any) {
    if (state.table === 'profiles') {
      return { data: mocks.role ? { role: mocks.role } : null, error: null };
    }
    if (state.table === 'media') {
      if (state.op === 'delete') {
        callLog.push('media.delete');
        return { data: mocks.mediaWrite.data, error: mocks.mediaWrite.error };
      }
      if (state.op === 'update') {
        callLog.push('media.update');
        return { data: mocks.mediaWrite.data, error: mocks.mediaWrite.error };
      }
      return { data: [], error: null };
    }
    return { data: [], error: null };
  }

  function builder(table: string) {
    const state: any = { table, op: 'select', filters: [] };
    const chain: any = {
      select(arg?: any) { state.selectArg = arg; return chain; },
      insert(v: any) { state.op = 'insert'; state.values = v; return chain; },
      update(v: any) { state.op = 'update'; state.values = v; return chain; },
      delete() { state.op = 'delete'; return chain; },
      eq(col: string, val: any) { state.filters.push(['eq', col, val]); return chain; },
      in(col: string, val: any) { state.filters.push(['in', col, val]); return chain; },
      order() { return chain; },
      range() { return chain; },
      single() { return Promise.resolve(resolve(state)); },
      maybeSingle() { return Promise.resolve(resolve(state)); },
      then(res: any, rej: any) { return Promise.resolve(resolve(state)).then(res, rej); },
    };
    return chain;
  }

  return {
    auth: { getUser: async () => ({ data: { user: mocks.user }, error: null }) },
    from: (t: string) => builder(t),
    rpc: vi.fn(),
  };
}

vi.mock('@nextblock-cms/db/server', () => ({
  createClient: () => makeSupabaseClient(),
  getServiceRoleSupabaseClient: () => ({
    rpc: async (fn: string, args: any) => {
      callLog.push(`rpc:${fn}`);
      mocks.rpcCalls.push({ fn, args });
      return { data: mocks.inUseError ? null : mocks.inUse, error: mocks.inUseError };
    },
  }),
}));

vi.mock('@nextblock-cms/db', () => ({
  recordMediaUpload: vi.fn(),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

vi.mock('@nextblock-cms/utils/server', () => ({
  encodedRedirect: (type: string, path: string, message: string) =>
    encodedRedirect(type, path, message),
  getS3Client: async () => ({ send: s3Send }),
}));

vi.mock('../../../lib/storage/provider', () => ({
  getStorageBackend: () => mocks.backend,
  getStorageBucket: () => mocks.bucket,
}));

vi.mock('../../../lib/storage/supabase-storage', () => ({
  supabaseRemoveObjects: (keys: string[]) => supabaseRemoveObjects(keys),
}));

vi.mock('@aws-sdk/client-s3', () => {
  const make = (type: string) =>
    class {
      input: any;
      __type = type;
      constructor(input: any) { this.input = input; }
    };
  return {
    DeleteObjectsCommand: make('DeleteObjects'),
    DeleteObjectCommand: make('DeleteObject'),
    CopyObjectCommand: make('CopyObject'),
    ListObjectsV2Command: make('ListObjectsV2'),
    HeadObjectCommand: make('HeadObject'),
  };
});

import {
  deleteMediaItem,
  deleteMultipleMediaItems,
  moveMultipleMediaItems,
} from './actions';

beforeEach(() => {
  vi.clearAllMocks();
  callLog.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocks.role = 'WRITER';
  mocks.user = { id: 'user-1' };
  mocks.backend = 's3';
  mocks.bucket = 'test-bucket';
  mocks.mediaWrite = { data: [], error: null };
  mocks.inUse = [];
  mocks.inUseError = null;
  mocks.rpcCalls = [];
});

describe('deleteMediaItem', () => {
  it('deletes the DB row before storage, and only for keys the row returned', async () => {
    mocks.mediaWrite = {
      data: [{ object_key: 'uploads/a.avif', variants: [{ objectKey: 'uploads/a_thumbnail.avif' }] }],
      error: null,
    };

    await deleteMediaItem('media-1', 'uploads/a.avif');

    // DB delete happened, then the in-use check, then the storage call.
    expect(callLog).toEqual(['media.delete', 'rpc:media_storage_keys_in_use', 's3.send:DeleteObjects']);
    // The storage call used the keys from the returned row (object + variant).
    expect(s3Send).toHaveBeenCalledTimes(1);
    expect(s3Send.mock.calls[0][0].input.Delete.Objects).toEqual([
      { Key: 'uploads/a.avif' },
      { Key: 'uploads/a_thumbnail.avif' },
    ]);
    expect(encodedRedirect).toHaveBeenLastCalledWith('success', '/cms/media', expect.any(String));
  });

  it("a decoy row never deletes another upload's objects (the 2026-10-21 audit)", async () => {
    // A WRITER's own row whose variants name a victim's objects, plus a key outside the media
    // namespace; the victim's row still references its own primary key.
    mocks.mediaWrite = {
      data: [
        {
          object_key: 'uploads/decoy_1.png',
          variants: [
            { objectKey: 'uploads/victim_2_large.avif' },
            { objectKey: 'backups/full.zip' },
            { objectKey: 'uploads/decoy_1_small.avif' },
          ],
        },
      ],
      error: null,
    };

    await deleteMediaItem('decoy', 'uploads/victim_2.png');

    expect(mocks.rpcCalls).toEqual([
      { fn: 'media_storage_keys_in_use', args: { p_keys: ['uploads/decoy_1.png', 'uploads/decoy_1_small.avif'], p_exclude_id: null } },
    ]);
    expect(s3Send.mock.calls[0][0].input.Delete.Objects).toEqual([
      { Key: 'uploads/decoy_1.png' },
      { Key: 'uploads/decoy_1_small.avif' },
    ]);
  });

  it('keeps a key that another media row still references', async () => {
    mocks.mediaWrite = {
      data: [{ object_key: 'uploads/a.avif', variants: [{ objectKey: 'uploads/a_small.avif' }] }],
      error: null,
    };
    mocks.inUse = ['uploads/a_small.avif'];

    await deleteMediaItem('media-1');

    expect(s3Send.mock.calls[0][0].input.Delete.Objects).toEqual([{ Key: 'uploads/a.avif' }]);
  });

  it('deletes no object when the in-use check fails (fails closed)', async () => {
    mocks.mediaWrite = { data: [{ object_key: 'uploads/a.avif', variants: [] }], error: null };
    mocks.inUseError = { message: 'function does not exist' };

    await deleteMediaItem('media-1');

    expect(s3Send).not.toHaveBeenCalled();
    expect(supabaseRemoveObjects).not.toHaveBeenCalled();
    // The row is gone, so the action still reports the delete; the object is an orphan.
    expect(encodedRedirect).toHaveBeenLastCalledWith('success', '/cms/media', expect.any(String));
  });

  it('a non-owner WRITER (zero rows deleted) touches no storage and reports not-permitted', async () => {
    mocks.mediaWrite = { data: [], error: null }; // RLS removed nothing

    await deleteMediaItem('media-1', 'uploads/a.avif');

    expect(callLog).toEqual(['media.delete']); // DB attempted, no storage call
    expect(s3Send).not.toHaveBeenCalled();
    expect(supabaseRemoveObjects).not.toHaveBeenCalled();
    expect(encodedRedirect).toHaveBeenLastCalledWith(
      'error',
      '/cms/media',
      'Media item not found or you do not have permission to delete it.',
    );
  });
});

describe('deleteMultipleMediaItems', () => {
  it('deletes DB rows first, then storage keys drawn from the returned rows', async () => {
    mocks.mediaWrite = {
      data: [
        { object_key: 'uploads/a.avif', variants: [] },
        { object_key: 'uploads/b.avif', variants: [{ objectKey: 'uploads/b_small.avif' }, { objectKey: 'uploads/c.avif' }] },
      ],
      error: null,
    };

    const res = await deleteMultipleMediaItems([
      { id: 'a', objectKey: 'uploads/a.avif' },
      { id: 'b', objectKey: 'uploads/b.avif' },
    ]);

    expect(callLog).toEqual(['media.delete', 'rpc:media_storage_keys_in_use', 's3.send:DeleteObjects']);
    // b's listed `uploads/c.avif` belongs to another upload and is left alone.
    expect(s3Send.mock.calls[0][0].input.Delete.Objects).toEqual([
      { Key: 'uploads/a.avif' },
      { Key: 'uploads/b.avif' },
      { Key: 'uploads/b_small.avif' },
    ]);
    expect(res).toEqual({ success: expect.stringContaining('deleted successfully') });
  });

  it('a non-owner WRITER (zero rows) deletes no objects and returns an error', async () => {
    mocks.mediaWrite = { data: [], error: null };

    const res = await deleteMultipleMediaItems([
      { id: 'a', objectKey: 'uploads/a.avif' },
      { id: 'b', objectKey: 'uploads/b.avif' },
    ]);

    expect(callLog).toEqual(['media.delete']);
    expect(s3Send).not.toHaveBeenCalled();
    expect(res.error).toMatch(/not found, or you do not have permission/i);
  });

  it('reports a partial result when RLS skips some of the selected rows', async () => {
    mocks.mediaWrite = {
      data: [{ object_key: 'uploads/a.avif', variants: [] }], // only 1 of 2 owned
      error: null,
    };

    const res = await deleteMultipleMediaItems([
      { id: 'a', objectKey: 'uploads/a.avif' },
      { id: 'b', objectKey: 'uploads/b.avif' },
    ]);

    // Only the owned object is removed from storage; the other is left intact.
    expect(s3Send.mock.calls[0][0].input.Delete.Objects).toEqual([{ Key: 'uploads/a.avif' }]);
    expect(res.success).toMatch(/1 could not be deleted/i);
  });
});

describe('moveMultipleMediaItems', () => {
  it('claims the row with an ownership-scoped write before moving storage objects', async () => {
    mocks.mediaWrite = {
      data: [{ id: 'a', object_key: 'uploads/a.avif', file_type: 'image/avif', variants: [] }],
      error: null,
    };

    const res = await moveMultipleMediaItems(
      [{ id: 'a', objectKey: 'uploads/a.avif' }],
      'photos',
    );

    // The claim (media.update) came first, before any S3 traffic.
    expect(callLog[0]).toBe('media.update');
    const firstS3 = callLog.findIndex((c) => c.startsWith('s3.send:'));
    expect(firstS3).toBeGreaterThan(0);
    expect(res).toEqual({ success: expect.stringContaining('Moved 1 item') });
  });

  it('a non-owner WRITER (zero rows claimed) moves no storage objects', async () => {
    mocks.mediaWrite = { data: [], error: null };

    const res = await moveMultipleMediaItems(
      [{ id: 'a', objectKey: 'uploads/a.avif' }],
      'photos',
    );

    expect(callLog).toEqual(['media.update']); // claim attempted, nothing returned
    expect(s3Send).not.toHaveBeenCalled();
    expect(res.error).toMatch(/not found, or you do not have permission to move/i);
  });

  it("moves only the row's own objects and never deletes a source another row references", async () => {
    mocks.mediaWrite = {
      data: [
        {
          id: 'a',
          object_key: 'uploads/a.avif',
          file_type: 'image/avif',
          variants: [{ objectKey: 'uploads/a_small.avif' }, { objectKey: 'uploads/victim_large.avif' }],
        },
      ],
      error: null,
    };
    mocks.inUse = ['uploads/a_small.avif'];

    await moveMultipleMediaItems([{ id: 'a', objectKey: 'uploads/a.avif' }], 'photos');

    expect(mocks.rpcCalls).toEqual([
      { fn: 'media_storage_keys_in_use', args: { p_keys: ['uploads/a.avif', 'uploads/a_small.avif'], p_exclude_id: 'a' } },
    ]);
    const sent = s3Send.mock.calls.map((c) => `${c[0].__type}:${c[0].input.Key}`);
    expect(sent).toContain('CopyObject:photos/a_small.avif');
    expect(sent).toContain('DeleteObject:uploads/a.avif');
    expect(sent).not.toContain('DeleteObject:uploads/a_small.avif');
    expect(sent.some((c) => c.includes('victim'))).toBe(false);
  });

  it('refuses to move a row whose object_key is not a media path', async () => {
    mocks.mediaWrite = {
      data: [{ id: 'a', object_key: 'backups/full.zip', file_type: 'application/zip', variants: [] }],
      error: null,
    };

    const res = await moveMultipleMediaItems([{ id: 'a', objectKey: 'backups/full.zip' }], 'photos');

    expect(s3Send).not.toHaveBeenCalled();
    expect(res.error).toMatch(/does not point at a media file/i);
  });
});
