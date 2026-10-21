import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-10-21: the importer fetched with `redirect: 'follow'` and checked the host only after
 * the last hop, reported an internal hop's status ("HTTP 403"), buffered the whole body
 * before the 15 MB cap, and kept its own blocklist without 100.64.0.0/10, 198.18.0.0/15 or
 * 64:ff9b::/96. It now downloads through Cortex's `guardedFetch`, whose behaviour against a
 * real server (hops, pinned DNS, caps, ranges) is tested in
 * libs/cortex/src/lib/ai-global-agent-ssrf.test.ts. These pin the importer to it.
 */

const mocks = vi.hoisted(() => {
  class GuardedFetchError extends Error {
    constructor(
      readonly reason: string,
      message: string,
      readonly redirects = 0
    ) {
      super(message);
    }
  }

  return {
    GuardedFetchError,
    guardedFetch: vi.fn(),
    recorded: [] as Array<{ actorUserId: string; payload: unknown }>,
    roles: { 'admin-1': 'ADMIN', 'user-1': 'USER' } as Record<string, string>,
    uploads: [] as string[],
  };
});

vi.mock('@nextblock-cms/cortex', () => ({
  GuardedFetchError: mocks.GuardedFetchError,
  guardedFetch: mocks.guardedFetch,
}));

vi.mock('@nextblock-cms/db/server', () => ({
  getServiceRoleSupabaseClient: () => ({
    from: () => ({
      select: () => ({
        eq: (_column: string, id: string) => ({
          maybeSingle: async () => ({ data: mocks.roles[id] ? { role: mocks.roles[id] } : null, error: null }),
        }),
      }),
    }),
  }),
  recordMediaUploadAsActor: async (payload: unknown, actorUserId: string) => {
    mocks.recorded.push({ actorUserId, payload });
    return {
      data: { blur_data_url: null, description: 'alt', height: 1, id: 'media-1', object_key: 'k', width: 1 },
      success: true,
    };
  },
}));

vi.mock('sharp', () => ({
  default: () => ({
    metadata: async () => ({ format: 'png', height: 1, width: 1 }),
    resize: () => ({ webp: () => ({ toBuffer: async () => Buffer.from('blur') }) }),
  }),
}));
vi.mock('@aws-sdk/client-s3', () => ({
  PutObjectCommand: class {
    constructor(readonly input: { Key: string }) {}
  },
}));
vi.mock('@nextblock-cms/utils/server', () => ({
  getS3Client: async () => ({
    send: async (command: { input: { Key: string } }) => {
      mocks.uploads.push(command.input.Key);
    },
  }),
}));
vi.mock('../storage/provider', () => ({ getStorageBackend: () => 's3', getStorageBucket: () => 'bucket' }));
vi.mock('../storage/supabase-storage', () => ({ supabaseUploadObject: vi.fn() }));
vi.mock('./resolveMediaUrl', () => ({ resolveMediaUrl: (key: string) => `https://cdn.example.test/${key}` }));

import { importExternalImageAsActor } from './external-image-import';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function answer(status: number, contentType: string, readBody: () => Promise<Uint8Array> = async () => PNG) {
  const discard = vi.fn();
  return {
    discard,
    response: {
      discard,
      headers: { 'content-type': contentType },
      mediaType: contentType,
      readBody,
      status,
      url: new URL('https://images.example.test/a.png'),
    },
  };
}

beforeEach(() => {
  mocks.guardedFetch.mockReset();
  mocks.recorded.length = 0;
  mocks.uploads.length = 0;
});

describe('importExternalImageAsActor', () => {
  it('downloads through guardedFetch under the 15 MB cap and records as the actor', async () => {
    mocks.guardedFetch.mockResolvedValue(answer(200, 'image/png').response);

    const result = await importExternalImageAsActor({ actorUserId: 'admin-1', url: 'https://images.example.test/a.png' });

    expect(result).toMatchObject({ media: { id: 'media-1' }, success: true });
    expect(mocks.guardedFetch).toHaveBeenCalledWith(
      new URL('https://images.example.test/a.png'),
      expect.objectContaining({ maxBytes: 15 * 1024 * 1024 })
    );
    expect(mocks.uploads).toHaveLength(1);
    expect(mocks.recorded).toEqual([{ actorUserId: 'admin-1', payload: expect.any(Object) }]);
  });

  it('refuses an actor without a CMS role before fetching anything', async () => {
    await expect(
      importExternalImageAsActor({ actorUserId: 'user-1', url: 'https://images.example.test/a.png' })
    ).resolves.toEqual({ error: 'You do not have permission to import media.' });
    expect(mocks.guardedFetch).not.toHaveBeenCalled();
  });

  it('reports a refused hop without any status, and uploads nothing', async () => {
    mocks.guardedFetch.mockRejectedValueOnce(new mocks.GuardedFetchError('blocked', 'private', 1));
    await expect(
      importExternalImageAsActor({ actorUserId: 'admin-1', url: 'https://images.example.test/to-internal' })
    ).resolves.toEqual({ error: 'The image URL redirected to a blocked internal address.' });

    mocks.guardedFetch.mockRejectedValueOnce(new mocks.GuardedFetchError('blocked', 'private', 0));
    await expect(importExternalImageAsActor({ actorUserId: 'admin-1', url: 'http://100.64.0.1/a.png' })).resolves.toEqual({
      error: 'Refusing to fetch a local, private, or internal address.',
    });
    expect(mocks.uploads).toEqual([]);
  });

  it('stops at the byte cap', async () => {
    mocks.guardedFetch.mockResolvedValue(
      answer(200, 'image/png', async () => {
        throw new mocks.GuardedFetchError('too_large', 'too large');
      }).response
    );

    await expect(
      importExternalImageAsActor({ actorUserId: 'admin-1', url: 'https://images.example.test/huge.png' })
    ).resolves.toEqual({ error: 'The image is too large to import (max 15MB).' });
    expect(mocks.uploads).toEqual([]);
  });

  it('drops the body of a failed or non-image answer unread', async () => {
    const missing = answer(404, 'text/html');
    mocks.guardedFetch.mockResolvedValueOnce(missing.response);
    await expect(
      importExternalImageAsActor({ actorUserId: 'admin-1', url: 'https://images.example.test/missing.png' })
    ).resolves.toEqual({ error: 'The image URL responded with HTTP 404.' });
    expect(missing.discard).toHaveBeenCalled();

    const page = answer(200, 'text/html', async () => {
      throw new Error('read');
    });
    mocks.guardedFetch.mockResolvedValueOnce(page.response);
    await expect(
      importExternalImageAsActor({ actorUserId: 'admin-1', url: 'https://images.example.test/page' })
    ).resolves.toEqual({ error: 'The URL is not an image (content-type: text/html).' });
    expect(page.discard).toHaveBeenCalled();
  });
});
