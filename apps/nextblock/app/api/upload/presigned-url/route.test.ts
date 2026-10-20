import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  profileSingle: vi.fn(),
  getStorageBackend: vi.fn(),
  getStorageBucket: vi.fn(),
  getS3PresignClient: vi.fn(),
  getSignedUrl: vi.fn(),
  supabaseCreateSignedUpload: vi.fn(),
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
  getS3PresignClient: mocks.getS3PresignClient,
}));
vi.mock('@aws-sdk/client-s3', () => ({
  PutObjectCommand: class PutObjectCommand {
    constructor(public readonly input: Record<string, unknown>) {}
  },
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mocks.getSignedUrl,
}));
vi.mock('../../../../lib/storage/provider', () => ({
  getStorageBackend: mocks.getStorageBackend,
  getStorageBucket: mocks.getStorageBucket,
}));
vi.mock('../../../../lib/storage/supabase-storage', () => ({
  supabaseCreateSignedUpload: mocks.supabaseCreateSignedUpload,
}));

import { POST } from './route';

const URL_ = 'http://localhost/api/upload/presigned-url';

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
  return (await response.json()) as { error?: string; objectKey?: string; presignedUrl?: string; method?: string };
}

const VALID = { filename: 'photo.png', contentType: 'image/png', size: 1024, folder: 'uploads/' };

describe('POST /api/upload/presigned-url', () => {
  beforeEach(() => {
    signIn('WRITER');
    mocks.getStorageBackend.mockReturnValue('s3');
    mocks.getStorageBucket.mockReturnValue('media');
    mocks.getS3PresignClient.mockResolvedValue({ kind: 'presign-client' });
    mocks.getSignedUrl.mockImplementation(async (_client: unknown, command: { input: { Key: string } }) => {
      return `https://r2.example/${command.input.Key}?signed=1`;
    });
    mocks.supabaseCreateSignedUpload.mockImplementation(async (key: string) => ({
      signedUrl: `https://supabase.example/upload/${key}?token=t`,
      token: 't',
    }));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('401s without a session', async () => {
    signIn(null, null);
    expect((await POST(request(VALID))).status).toBe(401);
  });

  it('403s a customer', async () => {
    signIn('USER');
    const response = await POST(request(VALID));
    expect(response.status).toBe(403);
    expect(mocks.getSignedUrl).not.toHaveBeenCalled();
  });

  it('signs a PUT for a staff member with a sanitized key', async () => {
    const response = await POST(request({ ...VALID, filename: 'My Photo.PNG', folder: 'pages/about/' }));

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.objectKey).toMatch(/^pages\/about\/my-photo_\d{14}\.png$/);
    expect(body.presignedUrl).toBe(`https://r2.example/${body.objectKey}?signed=1`);
    expect(body.method).toBe('PUT');

    const [, command, options] = mocks.getSignedUrl.mock.calls[0] as [unknown, { input: Record<string, unknown> }, { expiresIn: number }];
    expect(command.input).toMatchObject({
      Bucket: 'media',
      Key: body.objectKey,
      ContentType: 'image/png',
      Metadata: { 'uploader-user-id': 'writer-1' },
    });
    expect(options.expiresIn).toBe(300);
  });

  it('uses a Supabase signed upload URL on the native backend', async () => {
    mocks.getStorageBackend.mockReturnValue('supabase');
    const response = await POST(request(VALID));

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.objectKey).toMatch(/^uploads\/photo_\d{14}\.png$/);
    expect(mocks.supabaseCreateSignedUpload).toHaveBeenCalledWith(body.objectKey);
    expect(body.presignedUrl).toContain('https://supabase.example/upload/');
    expect(mocks.getS3PresignClient).not.toHaveBeenCalled();
  });

  it.each(['text/html', 'application/zip', 'application/octet-stream'])('415s %s', async (contentType) => {
    const response = await POST(request({ ...VALID, contentType }));
    expect(response.status).toBe(415);
    expect(mocks.getSignedUrl).not.toHaveBeenCalled();
  });

  it('normalises the content type before matching and signing', async () => {
    const response = await POST(request({ ...VALID, contentType: 'Image/JPEG; charset=binary', filename: 'a.jpg' }));
    expect(response.status).toBe(200);
    const [, command] = mocks.getSignedUrl.mock.calls[0] as [unknown, { input: Record<string, unknown> }];
    expect(command.input.ContentType).toBe('image/jpeg');
  });

  it('forces the key extension to agree with the content type', async () => {
    const body = await json(await POST(request({ ...VALID, filename: 'evil.html' })));
    expect(body.objectKey).toMatch(/^uploads\/evil_\d{14}\.png$/);
  });

  it.each([
    [{ ...VALID, size: 'abc' }, 400],
    [{ ...VALID, size: 0 }, 400],
    [{ ...VALID, size: -5 }, 400],
    [{ ...VALID, size: 1.5 }, 400],
    [{ ...VALID, size: 10 * 1024 * 1024 + 1 }, 400],
    [{ ...VALID, filename: '' }, 400],
    [{ ...VALID, filename: 'x'.repeat(256) + '.png' }, 400],
    [{ ...VALID, contentType: '' }, 400],
  ])('400s an invalid payload %j', async (payload, status) => {
    const response = await POST(request(payload));
    expect(response.status).toBe(status);
    expect(mocks.getSignedUrl).not.toHaveBeenCalled();
  });

  it('accepts a numeric string size and a file right at the cap', async () => {
    expect((await POST(request({ ...VALID, size: '2048' }))).status).toBe(200);
    expect((await POST(request({ ...VALID, size: 10 * 1024 * 1024 }))).status).toBe(200);
  });

  it.each(['../../etc', 'uploads/../x', './uploads', 'a..b', 'pages\\x', 'x\u0000y'])(
    '400s a traversal folder %j',
    async (folder) => {
      const response = await POST(request({ ...VALID, folder }));
      expect(response.status).toBe(400);
      expect((await json(response)).error).toBe('Invalid upload folder.');
      expect(mocks.getSignedUrl).not.toHaveBeenCalled();
    },
  );

  it('400s a body that is not a JSON object', async () => {
    expect((await POST(request('not json'))).status).toBe(400);
    expect((await POST(request([1, 2]))).status).toBe(400);
  });
});
