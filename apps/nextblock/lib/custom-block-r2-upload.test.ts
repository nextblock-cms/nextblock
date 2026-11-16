import { S3Client } from '@aws-sdk/client-s3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  getS3PresignClientMock: vi.fn(),
  getSignedUrlMock: vi.fn(),
  getServiceRoleSupabaseClientMock: vi.fn(),
  supabaseCreateSignedUploadMock: vi.fn(),
  /**
   * The cookie session the route's getCmsActor() reads (the real one, with evaluateTwoFactor()
   * behind it): the user, their own profile role, the second factor they enrolled, the session's
   * assurance level. app/api/media/r2-presigned/route.test.ts covers who may call the route.
   */
  session: {
    user: null as { id: string } | null,
    role: null as string | null,
    mfa: null as { mfa_enabled: boolean; mfa_type: 'totp' | 'email' } | null,
    aal: 'aal1' as 'aal1' | 'aal2',
  },
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
          // `single` too: the pre-2026-11-14 route read the role that way.
          return { maybeSingle: read, single: read };
        },
      }),
    }),
  }),
  getServiceRoleSupabaseClient: mocks.getServiceRoleSupabaseClientMock,
}));
// No trusted-device or email-code cookie: a second factor counts only through the session itself.
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));
// Read only by the trusted-device and reminder paths, never on the way to these decisions.
vi.mock('./privacy/settings', () => ({
  getSecuritySettings: async () => ({ enforce_staff_2fa: false, trusted_device_days: 30 }),
}));

vi.mock('@nextblock-cms/utils/server', () => ({
  getS3PresignClient: mocks.getS3PresignClientMock,
}));

// The real SDK signs (offline, dummy credentials); getSignedUrl is wrapped only to observe it.
vi.mock('@aws-sdk/s3-request-presigner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/s3-request-presigner')>()),
  getSignedUrl: mocks.getSignedUrlMock,
}));

vi.mock('./storage/supabase-storage', () => ({
  supabaseCreateSignedUpload: mocks.supabaseCreateSignedUploadMock,
}));

import {
  buildR2UploadObjectKey,
  createR2PresignedUpload,
  R2PresignedUploadError,
  validateR2PresignedUploadPayload,
} from './custom-block-r2-upload';
import { validateR2PresignedUploadPayload as validateR2PresignedUploadShape } from './custom-block-r2-upload-shared';
import { POST } from '../app/api/media/r2-presigned/route';

const { getSignedUrl: realGetSignedUrl } =
  await vi.importActual<typeof import('@aws-sdk/s3-request-presigner')>('@aws-sdk/s3-request-presigner');
const presignClient = new S3Client({
  region: 'auto',
  endpoint: 'https://account.r2.cloudflarestorage.com',
  credentials: { accessKeyId: 'TESTACCESSKEYID', secretAccessKey: 'test-secret-not-a-real-key' },
});

function presignRequest(body: unknown) {
  return new Request('https://nextblock.test/api/media/r2-presigned', {
    body: typeof body === 'string' ? body : JSON.stringify(body),
    method: 'POST',
  }) as any;
}

function signInAs(role: string) {
  mocks.session.user = { id: 'user-1' };
  mocks.session.role = role;
}

describe('custom block R2 presigned upload flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.session.user = null;
    mocks.session.role = null;
    mocks.session.mfa = null;
    mocks.session.aal = 'aal1';
    process.env.R2_BUCKET_NAME = 'nextblock-test';
    process.env.NEXT_PUBLIC_R2_BASE_URL = 'https://cdn.nextblock.test';
    vi.stubEnv('STORAGE_PROVIDER', 's3');
    mocks.getS3PresignClientMock.mockResolvedValue(presignClient);
    mocks.getSignedUrlMock.mockImplementation(realGetSignedUrl);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('validates and sanitizes image upload keys', () => {
    const payload = validateR2PresignedUploadPayload({
      contentType: 'image/webp',
      filename: 'Hero Portrait!!!.webp',
      folder: '../custom blocks//testimonials',
      size: 1024,
    });

    expect(payload.folder).toBe('custom-blocks/testimonials/');
    expect(
      buildR2UploadObjectKey(payload, {
        nonce: 'abc123',
        now: new Date('2026-05-28T12:34:56.789Z'),
      })
    ).toBe('custom-blocks/testimonials/hero-portrait-20260528123456789-abc123.webp');
  });

  it('rejects anonymous users before creating an upload URL', async () => {
    const response = await POST(
      new Request('https://nextblock.test/api/media/r2-presigned', {
        body: JSON.stringify({}),
        method: 'POST',
      }) as any
    );

    expect(response.status).toBe(401);
    expect(mocks.getS3PresignClientMock).not.toHaveBeenCalled();
  });

  it('rejects oversized files for authorized writers', async () => {
    signInAs('WRITER');

    const response = await POST(
      new Request('https://nextblock.test/api/media/r2-presigned', {
        body: JSON.stringify({
          contentType: 'image/png',
          filename: 'too-large.png',
          size: 11 * 1024 * 1024,
        }),
        method: 'POST',
      }) as any
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toContain('10 MB');
    expect(mocks.getS3PresignClientMock).not.toHaveBeenCalled();
  });

  it('returns a direct PUT upload space for authorized writers', async () => {
    signInAs('ADMIN');

    const response = await POST(
      presignRequest({
        contentType: 'image/jpeg',
        filename: 'Customer Headshot.jpg',
        folder: 'custom-blocks/testimonials',
        size: 512_000,
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '512000' },
      method: 'PUT',
    });
    expect(payload.uploadUrl).toBe(payload.presignedUrl);
    expect(payload.objectKey).toMatch(
      /^custom-blocks\/testimonials\/customer-headshot-\d{17}-[a-f0-9-]+\.jpg$/
    );
    expect(new URL(payload.presignedUrl).pathname).toBe(`/${payload.objectKey}`);
    expect(payload.publicUrl).toContain('https://cdn.nextblock.test/custom-blocks/testimonials/');
  });

  it('signs the declared size and type into the upload URL', async () => {
    signInAs('WRITER');

    const payload = await (
      await POST(presignRequest({ contentType: 'image/png', filename: 'badge.png', size: 2048 }))
    ).json();
    const url = new URL(payload.uploadUrl);

    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(payload.headers).toEqual({ 'Content-Type': 'image/png', 'Content-Length': '2048' });
    const [, command] = mocks.getSignedUrlMock.mock.calls[0] as [unknown, { input: Record<string, unknown> }];
    expect(command.input).toMatchObject({ ContentLength: 2048, ContentType: 'image/png' });
  });

  it.each(['s3', 'supabase'])('refuses a request without a size before signing anything (%s)', async (backend) => {
    vi.stubEnv('STORAGE_PROVIDER', backend);
    signInAs('WRITER');

    const response = await POST(presignRequest({ contentType: 'image/png', filename: 'badge.png' }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('A positive file size is required.');
    expect(mocks.getSignedUrlMock).not.toHaveBeenCalled();
    expect(mocks.supabaseCreateSignedUploadMock).not.toHaveBeenCalled();
  });

  it('refuses a size one byte over the 10 MB limit before signing anything', async () => {
    signInAs('WRITER');

    const response = await POST(
      presignRequest({ contentType: 'image/png', filename: 'badge.png', size: 10 * 1024 * 1024 + 1 })
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('Image uploads are limited to 10 MB.');
    expect(mocks.getSignedUrlMock).not.toHaveBeenCalled();
  });

  it.each(['not json', 'null', '[1,2]'])('refuses a body that is not a JSON object: %s', async (body) => {
    signInAs('WRITER');

    const response = await POST(presignRequest(body));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('Expected a JSON body.');
    expect(mocks.getSignedUrlMock).not.toHaveBeenCalled();
  });

  it('returns the same headers on the native Supabase backend', async () => {
    vi.stubEnv('STORAGE_PROVIDER', 'supabase');
    mocks.supabaseCreateSignedUploadMock.mockResolvedValueOnce({
      signedUrl: 'https://project.supabase.co/storage/v1/object/upload/sign/media/k?token=t',
      token: 't',
    });
    signInAs('WRITER');

    const payload = await (
      await POST(presignRequest({ contentType: 'image/webp', filename: 'hero.webp', size: 4096 }))
    ).json();

    // Supabase's URL binds neither; the bucket's file_size_limit caps what it accepts (docs/04).
    expect(payload.headers).toEqual({ 'Content-Type': 'image/webp', 'Content-Length': '4096' });
    expect(payload.uploadUrl).toContain('/storage/v1/object/upload/sign/');
    expect(mocks.getSignedUrlMock).not.toHaveBeenCalled();
  });

  // Partner uploads (affiliates/avatars/<id>/, affiliates/pages/<id>/) are counted against that
  // partner's caps by the partner upload route. Until 2026-11-14 this route signed a PUT into them
  // for any staff session (the 0.23.4 verification's F1); the other staff upload routes already
  // refused such a folder. lib/storage/partner-upload-namespaces.test.ts holds every builder to it.
  describe('partner upload namespaces', () => {
    const PARTNER_FOLDERS = [
      'affiliates/pages/0b7c5f6e-1111-4c2d-9e8f-123456789abc',
      'Affiliates/avatars/x',
      '/affiliates//pages/abc/',
      'affiliates\\avatars\\u1',
      ' affiliates/pages ',
    ];

    it.each(PARTNER_FOLDERS)('refuses the folder %j in validation with a 400', (folder) => {
      expect(() =>
        validateR2PresignedUploadPayload({ contentType: 'image/png', filename: 'a.png', folder, size: 1 })
      ).toThrow(R2PresignedUploadError);
      try {
        validateR2PresignedUploadPayload({ contentType: 'image/png', filename: 'a.png', folder, size: 1 });
      } catch (error) {
        expect(error).toMatchObject({ status: 400, message: 'Invalid upload folder.' });
      }
    });

    it('leaves the shared shape check alone (scripts import it under plain Node)', () => {
      expect(
        validateR2PresignedUploadShape({ contentType: 'image/png', filename: 'a.png', folder: 'affiliates/pages/x', size: 1 })
          .folder
      ).toBe('affiliates/pages/x/');
    });

    it.each(
      PARTNER_FOLDERS.flatMap((folder) => [
        ['s3', folder],
        ['supabase', folder],
      ])
    )('answers 400 on the %s backend for %j and signs nothing', async (backend, folder) => {
      vi.stubEnv('STORAGE_PROVIDER', backend);
      signInAs('WRITER');

      const response = await POST(presignRequest({ contentType: 'image/png', filename: 'a.png', folder, size: 1 }));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Invalid upload folder.' });
      expect(mocks.getS3PresignClientMock).not.toHaveBeenCalled();
      expect(mocks.getSignedUrlMock).not.toHaveBeenCalled();
      expect(mocks.supabaseCreateSignedUploadMock).not.toHaveBeenCalled();
    });

    it('never signs a partner key for a payload that skipped validation', async () => {
      await expect(
        createR2PresignedUpload(
          { contentType: 'image/png', filename: 'a.png', folder: 'affiliates/pages/0b7c5f6e/', size: 1 },
          { userId: 'user-1' }
        )
      ).rejects.toMatchObject({ name: 'R2PresignedUploadError', status: 400, message: 'Invalid upload folder.' });
      expect(mocks.getS3PresignClientMock).not.toHaveBeenCalled();
      expect(mocks.getSignedUrlMock).not.toHaveBeenCalled();
    });

    // On the native Supabase backend the signed key goes into the request URL raw: the storage server
    // decodes its escapes and the URL parser resolves dot segments, so for a payload nobody validated
    // these folders would sign a URL inside a partner's prefix. The shared predicate decodes and
    // resolves them (lib/storage/upload-policy.ts, 2026-11-14).
    it.each(
      [
        '%61ffiliates/pages/0b7c5f6e/',
        'affiliates%2Fpages/0b7c5f6e/',
        'affiliates/avatars%2F0b7c5f6e/',
        '%2561ffiliates/pages/0b7c5f6e/',
        'uploads/%2e%2e/affiliates/pages/0b7c5f6e/',
      ].flatMap((folder) => [
        ['s3', folder],
        ['supabase', folder],
      ])
    )('never signs a percent-encoded partner key for a payload that skipped validation (%s, %j)', async (backend, folder) => {
      vi.stubEnv('STORAGE_PROVIDER', backend);

      await expect(
        createR2PresignedUpload({ contentType: 'image/png', filename: 'a.png', folder, size: 1 }, { userId: 'user-1' })
      ).rejects.toMatchObject({ name: 'R2PresignedUploadError', status: 400, message: 'Invalid upload folder.' });
      expect(mocks.getS3PresignClientMock).not.toHaveBeenCalled();
      expect(mocks.getSignedUrlMock).not.toHaveBeenCalled();
      expect(mocks.supabaseCreateSignedUploadMock).not.toHaveBeenCalled();
    });

    it('cleans a percent-encoded folder in the route into a literal one: no escape reaches a signed key', async () => {
      vi.stubEnv('STORAGE_PROVIDER', 'supabase');
      mocks.supabaseCreateSignedUploadMock.mockImplementationOnce(async (key: string) => ({
        signedUrl: `https://project.supabase.co/storage/v1/object/upload/sign/nextblock-test/${key}?token=t`,
        token: 't',
      }));
      signInAs('WRITER');

      const response = await POST(
        presignRequest({ contentType: 'image/png', filename: 'a%2e%2e.png', folder: '%61ffiliates/pages/0b7c5f6e', size: 64 })
      );
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.objectKey).toMatch(/^61ffiliates\/pages\/0b7c5f6e\/a2e2e-\d{17}-[a-f0-9-]+\.png$/);
      expect(mocks.supabaseCreateSignedUploadMock).toHaveBeenCalledWith(payload.objectKey);
    });

    it('still signs an ordinary affiliates/ folder', async () => {
      signInAs('WRITER');

      const response = await POST(
        presignRequest({ contentType: 'image/png', filename: 'banner.png', folder: 'affiliates/banners', size: 64 })
      );
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.objectKey).toMatch(/^affiliates\/banners\/banner-\d{17}-[a-f0-9-]+\.png$/);
      expect(mocks.getSignedUrlMock).toHaveBeenCalledTimes(1);
    });
  });
});
