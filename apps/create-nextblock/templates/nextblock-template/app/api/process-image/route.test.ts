import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * /api/process-image reads a stored object by key with the server's storage credentials and
 * writes six AVIF variants next to it. It is a staff tool (the media upload pipeline), so it
 * must refuse callers without a staff session, and it must never touch the partner upload
 * namespace (`affiliates/…`): processing a partner's object would read it and write variants
 * into their prefix, which counts against their upload caps (lib/affiliates/uploads.ts).
 * Before 2026-10-27 a WRITER could point it at any partner object.
 */

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  profileSingle: vi.fn(),
  getStorageBackend: vi.fn(),
  getStorageBucket: vi.fn(),
  resolveMediaBaseUrl: vi.fn(),
  getS3Client: vi.fn(),
  s3Send: vi.fn(),
  supabaseDownloadObject: vi.fn(),
  supabaseUploadObject: vi.fn(),
  sharp: vi.fn(),
  getPlaiceholder: vi.fn(),
}));

vi.mock('@nextblock-cms/db/server', () => ({
  createClient: () => ({
    auth: { getUser: mocks.getUser },
    from: () => ({
      select: () => ({
        eq: () => ({ single: mocks.profileSingle }),
      }),
    }),
  }),
}));
vi.mock('@nextblock-cms/utils/server', () => ({
  getS3Client: mocks.getS3Client,
}));
vi.mock('@aws-sdk/client-s3', () => ({
  GetObjectCommand: class GetObjectCommand {
    constructor(public readonly input: Record<string, unknown>) {}
  },
  PutObjectCommand: class PutObjectCommand {
    constructor(public readonly input: Record<string, unknown>) {}
  },
}));
vi.mock('sharp', () => ({ default: mocks.sharp }));
vi.mock('plaiceholder', () => ({ getPlaiceholder: mocks.getPlaiceholder }));
vi.mock('../../../lib/storage/provider', () => ({
  getStorageBackend: mocks.getStorageBackend,
  getStorageBucket: mocks.getStorageBucket,
  resolveMediaBaseUrl: mocks.resolveMediaBaseUrl,
}));
vi.mock('../../../lib/storage/supabase-storage', () => ({
  supabaseDownloadObject: mocks.supabaseDownloadObject,
  supabaseUploadObject: mocks.supabaseUploadObject,
}));

import { POST } from './route';

function request(payload: unknown) {
  return new NextRequest('http://localhost/api/process-image', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function signIn(role: string | null, user: { id: string } | null = { id: 'writer-1' }) {
  mocks.getUser.mockResolvedValue({ data: { user }, error: null });
  mocks.profileSingle.mockResolvedValue({ data: role ? { role } : null, error: null });
}

function expectNoStorageAccess() {
  expect(mocks.getS3Client).not.toHaveBeenCalled();
  expect(mocks.s3Send).not.toHaveBeenCalled();
  expect(mocks.supabaseDownloadObject).not.toHaveBeenCalled();
  expect(mocks.supabaseUploadObject).not.toHaveBeenCalled();
  expect(mocks.sharp).not.toHaveBeenCalled();
}

describe('POST /api/process-image', () => {
  beforeEach(() => {
    signIn('WRITER');
    vi.stubEnv('R2_ACCOUNT_ID', 'account');
    mocks.getStorageBackend.mockReturnValue('s3');
    mocks.getStorageBucket.mockReturnValue('media');
    mocks.resolveMediaBaseUrl.mockReturnValue('https://media.example');
    mocks.getS3Client.mockResolvedValue({ send: mocks.s3Send });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('401s without a session and never touches storage', async () => {
    signIn(null, null);
    const response = await POST(request({ objectKey: 'uploads/photo.png', contentType: 'image/png' }));

    expect(response.status).toBe(401);
    expectNoStorageAccess();
  });

  it.each(['USER', null])('403s a non-staff caller (%s) and never touches storage', async (role) => {
    signIn(role);
    const response = await POST(request({ objectKey: 'uploads/photo.png', contentType: 'image/png' }));

    expect(response.status).toBe(403);
    expectNoStorageAccess();
  });

  describe.each(['s3', 'supabase'])('on the %s backend', (backend) => {
    beforeEach(() => {
      mocks.getStorageBackend.mockReturnValue(backend);
    });

    it.each([
      'affiliates/pages/0b7c5f6e-1111-4c2d-9e8f-123456789abc/20261027-abcd.jpg',
      'affiliates/avatars/0b7c5f6e-1111-4c2d-9e8f-123456789abc/20261027-abcd.jpg',
      'Affiliates/avatars/u1/avatar.jpg',
      ' affiliates/avatars/u1/avatar.jpg',
      'affiliates\\pages\\u1\\hero.jpg',
    ])('400s the partner upload key %j before reading or writing anything', async (objectKey) => {
      const response = await POST(request({ objectKey, contentType: 'image/jpeg' }));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Invalid objectKey.' });
      expect(mocks.s3Send).not.toHaveBeenCalled();
      expect(mocks.supabaseDownloadObject).not.toHaveBeenCalled();
      expect(mocks.supabaseUploadObject).not.toHaveBeenCalled();
      expect(mocks.sharp).not.toHaveBeenCalled();
    });

    it('also refuses a partner key declared as a non-image', async () => {
      const response = await POST(request({ objectKey: 'affiliates/avatars/u1/avatar.pdf', contentType: 'application/pdf' }));

      expect(response.status).toBe(400);
      expect(mocks.s3Send).not.toHaveBeenCalled();
      expect(mocks.supabaseDownloadObject).not.toHaveBeenCalled();
    });
  });

  it.each(['uploads/brochure.pdf', 'uploads/affiliates/brochure.pdf'])(
    'still serves a media key such as %j (the non-image path answers without processing)',
    async (objectKey) => {
      const response = await POST(request({ objectKey, contentType: 'application/pdf' }));

      expect(response.status).toBe(200);
      const body = (await response.json()) as { originalImage: { objectKey: string; url: string } };
      expect(body.originalImage.objectKey).toBe(objectKey);
      expect(body.originalImage.url).toBe(`https://media.example/${objectKey}`);
      expect(mocks.s3Send).not.toHaveBeenCalled();
    }
  );

  it.each([
    '../secrets/x.png',
    '/uploads/x.png',
    'https://evil.example/x.png',
    // Dot and empty segments would dodge the partner-namespace check (2026-10-29 fix review).
    './affiliates/pages/0b7c5f6e-1111-4c2d-9e8f-123456789abc/hero.jpg',
    'affiliates/./pages/0b7c5f6e-1111-4c2d-9e8f-123456789abc/hero.jpg',
    'uploads//photo.png',
  ])(
    'keeps refusing an out-of-namespace key %j',
    async (objectKey) => {
      const response = await POST(request({ objectKey, contentType: 'image/png' }));

      expect(response.status).toBe(400);
      expect(mocks.s3Send).not.toHaveBeenCalled();
    }
  );
});
