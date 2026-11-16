import { S3Client } from '@aws-sdk/client-s3';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  /**
   * The cookie session the route's getCmsActor() reads (the real one, with evaluateTwoFactor()
   * behind it): the user, their own profile role, the second factor they enrolled, the session's
   * assurance level.
   */
  session: {
    user: { id: 'writer-1' } as { id: string } | null,
    role: 'WRITER' as string | null,
    mfa: null as { mfa_enabled: boolean; mfa_type: 'totp' | 'email' } | null,
    aal: 'aal1' as 'aal1' | 'aal2',
  },
  getServiceRoleSupabaseClient: vi.fn(),
  getStorageBackend: vi.fn(),
  getStorageBucket: vi.fn(),
  getS3PresignClient: vi.fn(),
  getSignedUrl: vi.fn(),
  supabaseCreateSignedUpload: vi.fn(),
}));

vi.mock('@nextblock-cms/db/server', () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: mocks.session.user }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({
          data: { currentLevel: mocks.session.aal, nextLevel: 'aal2' },
          error: null,
        }),
      },
    },
    from: (table: string) => ({
      select: () => ({
        eq: () => {
          const read = async () => {
            if (table === 'profiles') {
              return { data: mocks.session.role ? { role: mocks.session.role } : null, error: null };
            }
            if (table === 'user_security_settings') return { data: mocks.session.mfa, error: null };
            throw new Error(`Unexpected cookie-client read of ${table}`);
          };
          // `single` too: the pre-2026-11-14 route read the role that way, so a return to it is
          // judged by the refusals below rather than by a missing method.
          return { maybeSingle: read, single: read };
        },
      }),
    }),
  }),
  getServiceRoleSupabaseClient: mocks.getServiceRoleSupabaseClient,
}));
// No trusted-device or email-code cookie: a second factor counts only through the session itself.
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));
// Read only by the trusted-device and reminder paths, never on the way to these decisions.
vi.mock('../../../../lib/privacy/settings', () => ({
  getSecuritySettings: async () => ({ enforce_staff_2fa: false, trusted_device_days: 30 }),
}));
vi.mock('@nextblock-cms/utils/server', () => ({
  getS3PresignClient: mocks.getS3PresignClient,
}));
// The real SDK signs (offline, dummy credentials), so the URL a test reads is the one storage would
// check. getSignedUrl is wrapped only to see its arguments or stand in for one call.
vi.mock('@aws-sdk/s3-request-presigner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/s3-request-presigner')>()),
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

const { getSignedUrl: realGetSignedUrl } =
  await vi.importActual<typeof import('@aws-sdk/s3-request-presigner')>('@aws-sdk/s3-request-presigner');
const presignClient = new S3Client({
  region: 'auto',
  endpoint: 'https://account.r2.cloudflarestorage.com',
  credentials: { accessKeyId: 'TESTACCESSKEYID', secretAccessKey: 'test-secret-not-a-real-key' },
});

const URL_ = 'http://localhost/api/upload/presigned-url';

function request(payload: unknown) {
  return new NextRequest(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

function signIn(role: string | null, user: { id: string } | null = { id: 'writer-1' }) {
  mocks.session.user = user;
  mocks.session.role = role;
}

async function json(response: Response) {
  return (await response.json()) as {
    error?: string;
    objectKey?: string;
    presignedUrl?: string;
    method?: string;
    headers?: Record<string, string>;
  };
}

function signedHeadersOf(url: string | undefined) {
  return new URL(url ?? '').searchParams.get('X-Amz-SignedHeaders');
}

const VALID = { filename: 'photo.png', contentType: 'image/png', size: 1024, folder: 'uploads/' };

describe('POST /api/upload/presigned-url', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
    signIn('WRITER');
    mocks.session.mfa = null;
    mocks.session.aal = 'aal1';
    mocks.getStorageBackend.mockReturnValue('s3');
    mocks.getStorageBucket.mockReturnValue('media');
    mocks.getS3PresignClient.mockResolvedValue(presignClient);
    mocks.getSignedUrl.mockImplementation(realGetSignedUrl);
    mocks.supabaseCreateSignedUpload.mockImplementation(async (key: string) => ({
      signedUrl: `https://supabase.example/upload/${key}?token=t`,
      token: 't',
    }));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('401s without a session', async () => {
    signIn(null, null);
    const response = await POST(request(VALID));
    expect(response.status).toBe(401);
    expect(await json(response)).toEqual({ error: 'Unauthorized' });
  });

  it('403s a customer', async () => {
    signIn('USER');
    const response = await POST(request(VALID));
    expect(response.status).toBe(403);
    expect(await json(response)).toEqual({ error: 'Forbidden: Insufficient permissions' });
    expect(mocks.getSignedUrl).not.toHaveBeenCalled();
  });

  // A route handler never passes the CMS layout's 2FA redirect. Until 2026-11-14 this route read
  // the role through the cookie client, so a password alone (the first factor) got a signed URL.
  describe('second factor', () => {
    const SECOND_FACTOR = 'Complete two-factor verification, then try again.';

    function expectNothingSigned() {
      expect(mocks.getS3PresignClient).not.toHaveBeenCalled();
      expect(mocks.getSignedUrl).not.toHaveBeenCalled();
      expect(mocks.supabaseCreateSignedUpload).not.toHaveBeenCalled();
      expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
    }

    it.each([
      ['a WRITER whose enrolled authenticator app this session has not passed (aal1)', 'WRITER', 'totp', 's3'],
      ['an ADMIN whose enrolled email code this session has not passed', 'ADMIN', 'email', 's3'],
      ['a WRITER with a pending authenticator app on the native Supabase backend', 'WRITER', 'totp', 'supabase'],
    ] as const)('refuses %s before reading the body or signing anything', async (_label, role, factor, backend) => {
      signIn(role);
      mocks.session.mfa = { mfa_enabled: true, mfa_type: factor };
      mocks.getStorageBackend.mockReturnValue(backend);
      const pending = request(VALID);

      const response = await POST(pending);

      expect(response.status).toBe(403);
      expect(await json(response)).toEqual({ error: SECOND_FACTOR });
      expect(pending.bodyUsed).toBe(false);
      expect(mocks.getStorageBackend).not.toHaveBeenCalled();
      expectNothingSigned();
    });

    it('403s a USER past an enrolled second factor (aal2): the factor is not a role', async () => {
      signIn('USER');
      mocks.session.mfa = { mfa_enabled: true, mfa_type: 'totp' };
      mocks.session.aal = 'aal2';

      const response = await POST(request(VALID));

      expect(response.status).toBe(403);
      expect(await json(response)).toEqual({ error: 'Forbidden: Insufficient permissions' });
      expectNothingSigned();
    });

    it.each(['WRITER', 'ADMIN'])('signs for a %s whose session passed the enrolled authenticator app (aal2)', async (role) => {
      signIn(role, { id: 'staff-1' });
      mocks.session.mfa = { mfa_enabled: true, mfa_type: 'totp' };
      mocks.session.aal = 'aal2';

      const response = await POST(request(VALID));

      expect(response.status).toBe(200);
      const [, command] = mocks.getSignedUrl.mock.calls[0] as [unknown, { input: Record<string, unknown> }];
      expect(command.input.Metadata).toEqual({ 'uploader-user-id': 'staff-1' });
    });
  });

  it('signs a PUT for a staff member with a sanitized key', async () => {
    const response = await POST(request({ ...VALID, filename: 'My Photo.PNG', folder: 'pages/about/' }));

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.objectKey).toMatch(/^pages\/about\/my-photo_\d{14}\.png$/);
    expect(body.method).toBe('PUT');

    const url = new URL(body.presignedUrl ?? '');
    expect(url.pathname).toBe(`/${body.objectKey}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('x-amz-meta-uploader-user-id')).toBe('writer-1');

    const [, command] = mocks.getSignedUrl.mock.calls[0] as [unknown, { input: Record<string, unknown> }];
    expect(command.input).toMatchObject({
      Bucket: 'media',
      Key: body.objectKey,
      ContentType: 'image/png',
      ContentLength: 1024,
      Metadata: { 'uploader-user-id': 'writer-1' },
    });
  });

  it('signs the declared size and type into the URL and returns them as the headers to send', async () => {
    const body = await json(await POST(request({ ...VALID, size: 4096 })));

    expect(signedHeadersOf(body.presignedUrl)).toBe('content-length;content-type;host');
    expect(body.headers).toEqual({ 'Content-Type': 'image/png', 'Content-Length': '4096' });
  });

  it.each(['s3', 'supabase'])('refuses a request without a size before signing anything (%s)', async (backend) => {
    mocks.getStorageBackend.mockReturnValue(backend);
    const response = await POST(request({ filename: 'photo.png', contentType: 'image/png', folder: 'uploads/' }));

    expect(response.status).toBe(400);
    expect((await json(response)).error).toBe('Missing filename, contentType, or size');
    expect(mocks.getSignedUrl).not.toHaveBeenCalled();
    expect(mocks.supabaseCreateSignedUpload).not.toHaveBeenCalled();
  });

  it.each(['s3', 'supabase'])('refuses a size over the 10 MB limit before signing anything (%s)', async (backend) => {
    mocks.getStorageBackend.mockReturnValue(backend);
    const response = await POST(request({ ...VALID, size: 10 * 1024 * 1024 + 1 }));

    expect(response.status).toBe(400);
    expect((await json(response)).error).toBe('File size exceeds limit of 10MB.');
    expect(mocks.getSignedUrl).not.toHaveBeenCalled();
    expect(mocks.supabaseCreateSignedUpload).not.toHaveBeenCalled();
  });

  it('hands out no URL when the signature would not bind the size', async () => {
    mocks.getSignedUrl.mockResolvedValueOnce('https://media.account.r2.cloudflarestorage.com/k?X-Amz-SignedHeaders=host');
    const response = await POST(request(VALID));

    expect(response.status).toBe(500);
    expect((await json(response)).presignedUrl).toBeUndefined();
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
    // Same contract as on S3; Supabase's URL itself binds neither (the bucket's file_size_limit does).
    expect(body.headers).toEqual({ 'Content-Type': 'image/png', 'Content-Length': '1024' });
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

  // Partner uploads live under affiliates/ and count against that partner's upload caps
  // (lib/affiliates/uploads.ts): no signed upload URL may point there.
  it.each([
    'affiliates/pages/0b7c5f6e-1111-4c2d-9e8f-123456789abc/',
    'Affiliates/avatars/u1',
    '/affiliates//pages',
    ' affiliates/avatars ',
  ])('400s the partner upload folder %j without signing', async (folder) => {
    const response = await POST(request({ ...VALID, folder }));
    expect(response.status).toBe(400);
    expect((await json(response)).error).toBe('Invalid upload folder.');
    expect(mocks.getSignedUrl).not.toHaveBeenCalled();
    expect(mocks.supabaseCreateSignedUpload).not.toHaveBeenCalled();
  });

  it('400s the partner upload folder on the native Supabase backend too', async () => {
    mocks.getStorageBackend.mockReturnValue('supabase');
    const response = await POST(request({ ...VALID, folder: 'affiliates/avatars/u1/' }));
    expect(response.status).toBe(400);
    expect(mocks.supabaseCreateSignedUpload).not.toHaveBeenCalled();
  });

  it('400s a body that is not a JSON object', async () => {
    expect((await POST(request('not json'))).status).toBe(400);
    expect((await POST(request([1, 2]))).status).toBe(400);
  });
});
