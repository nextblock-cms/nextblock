import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  profileSingle: vi.fn(),
  mediaInsertSingle: vi.fn(),
  insert: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('@nextblock-cms/db/server', () => ({
  createClient: () => ({
    auth: { getUser: mocks.getUser },
    from: (table: string) => {
      if (table === 'media') {
        return {
          insert: (...args: unknown[]) => {
            mocks.insert(...args);
            return { select: () => ({ single: mocks.mediaInsertSingle }) };
          },
        };
      }
      return { select: () => ({ eq: () => ({ single: mocks.profileSingle }) }) };
    },
  }),
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

import { POST } from './route';

const URL_ = 'http://localhost/api/media/record';

function request(payload: unknown) {
  return new NextRequest(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

function signIn(role: string | null, user: { id: string } | null = { id: 'writer-1' }) {
  mocks.getUser.mockResolvedValue({ data: { user }, error: null });
  mocks.profileSingle.mockResolvedValue({ data: role ? { role } : null, error: null });
}

async function json(response: Response) {
  return (await response.json()) as { error?: string; success?: boolean };
}

const VALID = { fileName: 'photo.png', r2OriginalKey: 'uploads/photo_20260102030405.png' };

describe('POST /api/media/record', () => {
  beforeEach(() => {
    signIn('WRITER');
    mocks.mediaInsertSingle.mockResolvedValue({ data: { id: 'media-1' }, error: null });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  describe('access control', () => {
    it('401s without a session and never inserts', async () => {
      signIn(null, null);
      const response = await POST(request(VALID));
      expect(response.status).toBe(401);
      expect(mocks.insert).not.toHaveBeenCalled();
    });

    it('403s a signed-in customer (role USER)', async () => {
      signIn('USER');
      const response = await POST(request(VALID));
      expect(response.status).toBe(403);
      expect(mocks.insert).not.toHaveBeenCalled();
    });

    it('403s when the profile row is missing', async () => {
      signIn(null);
      expect((await POST(request(VALID))).status).toBe(403);
    });

    it.each(['WRITER', 'ADMIN'])('records media for %s', async (role) => {
      signIn(role);
      const response = await POST(request(VALID));
      expect(response.status).toBe(201);
      expect(mocks.insert).toHaveBeenCalledTimes(1);
    });
  });

  describe('request shape', () => {
    it('400s when fileName is missing', async () => {
      const response = await POST(request({ r2OriginalKey: 'uploads/a.png' }));
      expect(response.status).toBe(400);
      expect(mocks.insert).not.toHaveBeenCalled();
    });

    it('400s when r2OriginalKey is missing', async () => {
      const response = await POST(request({ fileName: 'a.png' }));
      expect(response.status).toBe(400);
      expect(mocks.insert).not.toHaveBeenCalled();
    });
  });

  describe('object-key hardening', () => {
    it('records the sanitized primary key on the media row', async () => {
      const response = await POST(request({ ...VALID, r2OriginalKey: '/uploads/photo_20260102030405.png' }));
      expect(response.status).toBe(201);
      const [row] = mocks.insert.mock.calls[0] as [{ object_key: string; file_path: string }];
      // leading slashes stripped, key stored verbatim otherwise
      expect(row.object_key).toBe('uploads/photo_20260102030405.png');
      expect(row.file_path).toBe('uploads/photo_20260102030405.png');
    });

    it.each([
      '../../etc/passwd.png',
      'uploads/../secret.png',
      'uploads/\u0000.png',
      'a\\b.png',
    ])('400s a traversal/odd primary key %j and never inserts', async (r2OriginalKey) => {
      const response = await POST(request({ ...VALID, r2OriginalKey }));
      expect(response.status).toBe(400);
      expect((await json(response)).error).toBe('Invalid object key.');
      expect(mocks.insert).not.toHaveBeenCalled();
    });

    it.each(['uploads/evil.html', 'uploads/evil.js', 'uploads/nofile'])(
      '400s a primary key with a disallowed/missing extension %j',
      async (r2OriginalKey) => {
        const response = await POST(request({ ...VALID, r2OriginalKey }));
        expect(response.status).toBe(400);
        expect((await json(response)).error).toBe('Invalid object key.');
        expect(mocks.insert).not.toHaveBeenCalled();
      },
    );

    it('400s when any recorded variant key is unsafe, even with a safe primary', async () => {
      const response = await POST(
        request({
          ...VALID,
          r2Variants: [
            { objectKey: 'uploads/photo_20260102030405_large.avif', variantLabel: 'original_avif' },
            { objectKey: '../evil.avif', variantLabel: 'large_avif' },
          ],
        }),
      );
      expect(response.status).toBe(400);
      expect((await json(response)).error).toBe('Invalid object key.');
      expect(mocks.insert).not.toHaveBeenCalled();
    });

    it('accepts a normal image upload with avif variants', async () => {
      const response = await POST(
        request({
          ...VALID,
          r2Variants: [
            { objectKey: 'uploads/photo_20260102030405_original.avif', variantLabel: 'original_avif', fileType: 'image/avif' },
            { objectKey: 'uploads/photo_20260102030405_large.avif', variantLabel: 'large_avif', fileType: 'image/avif' },
          ],
          originalImageDetails: {
            objectKey: 'uploads/photo_20260102030405.png',
            variantLabel: 'original_uploaded',
            fileType: 'image/png',
          },
        }),
      );
      expect(response.status).toBe(201);
      expect(mocks.insert).toHaveBeenCalledTimes(1);
    });
  });
});
