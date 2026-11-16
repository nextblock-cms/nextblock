import { NextRequest } from 'next/server';
import { Readable } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * /api/process-image reads a stored object by key with the server's storage credentials and
 * writes six AVIF variants next to it. It is a staff tool (the media upload pipeline), so it
 * must refuse callers without a staff session, and it must never touch the partner upload
 * namespace (`affiliates/…`): processing a partner's object would read it and write variants
 * into their prefix, which counts against their upload caps (lib/affiliates/uploads.ts).
 * Before 2026-10-27 a WRITER could point it at any partner object. A route handler never passes the
 * CMS layout's 2FA redirect, so the staff session must also have passed its enrolled second factor
 * (getCmsActor(), run here for real with evaluateTwoFactor() behind it); until 2026-11-14 a
 * cookie-client role read let a staff password alone (the first factor) through.
 */

const mocks = vi.hoisted(() => ({
  /** The cookie session: the user, their own profile role, their enrolled factor, the session's assurance level. */
  session: {
    user: { id: 'writer-1' } as { id: string } | null,
    role: 'WRITER' as string | null,
    mfa: null as { mfa_enabled: boolean; mfa_type: 'totp' | 'email' } | null,
    aal: 'aal1' as 'aal1' | 'aal2',
  },
  getServiceRoleSupabaseClient: vi.fn(),
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
vi.mock('../../../lib/privacy/settings', () => ({
  getSecuritySettings: async () => ({ enforce_staff_2fa: false, trusted_device_days: 30 }),
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
import { ALLOWED_UPLOAD_CONTENT_TYPES, resolveExtension } from '../../../lib/storage/upload-policy';

function request(payload: unknown) {
  return new NextRequest('http://localhost/api/process-image', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function signIn(role: string | null, user: { id: string } | null = { id: 'writer-1' }) {
  mocks.session.user = user;
  mocks.session.role = role;
}

function expectNoStorageAccess() {
  expect(mocks.getS3Client).not.toHaveBeenCalled();
  expect(mocks.s3Send).not.toHaveBeenCalled();
  expect(mocks.supabaseDownloadObject).not.toHaveBeenCalled();
  expect(mocks.supabaseUploadObject).not.toHaveBeenCalled();
  expect(mocks.sharp).not.toHaveBeenCalled();
  expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
}

describe('POST /api/process-image', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
    signIn('WRITER');
    mocks.session.mfa = null;
    mocks.session.aal = 'aal1';
    vi.stubEnv('R2_ACCOUNT_ID', 'account');
    mocks.getStorageBackend.mockReturnValue('s3');
    mocks.getStorageBucket.mockReturnValue('media');
    mocks.resolveMediaBaseUrl.mockReturnValue('https://media.example');
    mocks.getS3Client.mockResolvedValue({ send: mocks.s3Send });
    // The processing stubs some tests install must not leak into the next one.
    for (const stub of [mocks.s3Send, mocks.supabaseDownloadObject, mocks.supabaseUploadObject, mocks.sharp, mocks.getPlaiceholder]) {
      stub.mockReset();
    }
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
    expect(await response.json()).toEqual({ error: 'Forbidden' });
    expectNoStorageAccess();
  });

  describe('second factor', () => {
    const SECOND_FACTOR = 'Complete two-factor verification, then try again.';

    describe.each(['s3', 'supabase'])('on the %s backend', (backend) => {
      beforeEach(() => {
        mocks.getStorageBackend.mockReturnValue(backend);
      });

      it.each([
        ['a WRITER whose enrolled authenticator app this session has not passed (aal1)', 'WRITER', 'totp'],
        ['an ADMIN whose enrolled email code this session has not passed', 'ADMIN', 'email'],
      ] as const)('refuses %s before reading the body or any object', async (_label, role, factor) => {
        signIn(role);
        mocks.session.mfa = { mfa_enabled: true, mfa_type: factor };
        const pending = request({ objectKey: 'uploads/photo.png', contentType: 'image/png' });

        const response = await POST(pending);

        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: SECOND_FACTOR });
        expect(pending.bodyUsed).toBe(false);
        expect(mocks.getStorageBackend).not.toHaveBeenCalled();
        expectNoStorageAccess();
      });
    });

    it('403s a USER past an enrolled second factor (aal2): the factor is not a role', async () => {
      signIn('USER');
      mocks.session.mfa = { mfa_enabled: true, mfa_type: 'totp' };
      mocks.session.aal = 'aal2';

      const response = await POST(request({ objectKey: 'uploads/photo.png', contentType: 'image/png' }));

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'Forbidden' });
      expectNoStorageAccess();
    });

    it.each(['WRITER', 'ADMIN'])('serves a %s whose session passed the enrolled authenticator app (aal2)', async (role) => {
      signIn(role);
      mocks.session.mfa = { mfa_enabled: true, mfa_type: 'totp' };
      mocks.session.aal = 'aal2';

      // The non-image path answers without decoding: enough to show the gate let the caller in.
      const response = await POST(request({ objectKey: 'uploads/brochure.pdf', contentType: 'application/pdf' }));

      expect(response.status).toBe(200);
      expect(mocks.getS3Client).toHaveBeenCalledTimes(1);
    });
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

    // 2026-11-14: on the native Supabase backend storage-js puts the raw key into the request URL
    // and the storage server decodes it, so these read a partner's object (or another bucket's)
    // and wrote six variants there, while the partner check never decoded '%xx'. No upload route
    // mints a '%', so any '%' is refused, as are '?' and '#' (they end the URL path early).
    it.each([
      '%61ffiliates/pages/0b7c5f6e-1111-4c2d-9e8f-123456789abc/20261027-abcd.jpg',
      'affiliates%2Fpages/0b7c5f6e-1111-4c2d-9e8f-123456789abc/20261027-abcd.jpg',
      'affiliates/pages%2F0b7c5f6e-1111-4c2d-9e8f-123456789abc/20261027-abcd.jpg',
      '%2561ffiliates/avatars/0b7c5f6e-1111-4c2d-9e8f-123456789abc/20261027-abcd.jpg',
      '%41FFILIATES/AVATARS/0b7c5f6e-1111-4c2d-9e8f-123456789abc/20261027-abcd.jpg',
      'uploads/%2e%2e/affiliates/pages/0b7c5f6e-1111-4c2d-9e8f-123456789abc/20261027-abcd.jpg',
      '%2e%2e/media/affiliates/pages/0b7c5f6e-1111-4c2d-9e8f-123456789abc/20261027-abcd.jpg',
      '%2e%2e/other-bucket/photo.png',
      'uploads/my%20photo_20261114101500.png',
      'uploads/victim_20261114101500.png?.png',
      'uploads/victim_20261114101500.png#.png',
      // No allowed media extension (every upload route mints one): the variants are named after the
      // text before the last '.', so these wrote `_xlarge.avif`… at the bucket root and
      // `uploads/2026_xlarge.avif`…, outside the original's folder.
      'uploads/nofile',
      'uploads/2026.11/photo',
    ])('400s the client key %j before any storage, decode or database call', async (objectKey) => {
      const response = await POST(request({ objectKey, contentType: 'image/jpeg' }));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Invalid objectKey.' });
      expect(mocks.s3Send).not.toHaveBeenCalled();
      expect(mocks.supabaseDownloadObject).not.toHaveBeenCalled();
      expect(mocks.supabaseUploadObject).not.toHaveBeenCalled();
      expect(mocks.sharp).not.toHaveBeenCalled();
      expect(mocks.getPlaiceholder).not.toHaveBeenCalled();
      expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
    });

    it('still reads and processes a key the upload route minted', async () => {
      const decoder = {
        metadata: vi.fn(async () => ({ width: 800, height: 600 })),
        clone: vi.fn(() => decoder),
        resize: vi.fn(() => decoder),
        toFormat: vi.fn(() => decoder),
        toBuffer: vi.fn(async () => Buffer.from('avif')),
      };
      mocks.sharp.mockImplementation(() => decoder);
      mocks.getPlaiceholder.mockResolvedValue({ base64: 'data:image/png;base64,AAAA' });
      mocks.supabaseDownloadObject.mockResolvedValue(Buffer.from('png'));
      mocks.s3Send.mockImplementation(async (command: { input: Record<string, unknown> }) =>
        'Body' in command.input ? {} : { Body: Readable.from([Buffer.from('png')]) }
      );
      const objectKey = 'uploads/photo_20261114101500.png';

      const response = await POST(request({ objectKey, contentType: 'image/png' }));

      expect(response.status).toBe(200);
      const body = (await response.json()) as { processedVariants: Array<{ objectKey: string }> };
      expect(body.processedVariants.map((variant) => variant.objectKey)).toEqual(
        ['xlarge', 'large', 'medium', 'small', 'thumbnail', 'original'].map(
          (label) => `uploads/photo_20261114101500_${label}.avif`
        )
      );
      if (backend === 'supabase') {
        expect(mocks.supabaseDownloadObject).toHaveBeenCalledWith(objectKey);
        expect(mocks.supabaseUploadObject).toHaveBeenCalledTimes(6);
      } else {
        expect(mocks.s3Send.mock.calls[0][0]).toMatchObject({ input: { Bucket: 'media', Key: objectKey } });
        expect(mocks.s3Send).toHaveBeenCalledTimes(7);
      }
    });

    it('refuses a percent-encoded partner key declared as a non-image too (no public URL is minted for it)', async () => {
      const response = await POST(
        request({ objectKey: '%61ffiliates/avatars/u1/avatar.pdf', contentType: 'application/pdf' })
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Invalid objectKey.' });
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

  // The key must end in an allowed media extension, and every type the upload routes accept mints
  // one (resolveExtension), so no non-image upload meets that refusal instead of the answer above.
  it.each(
    Object.entries(ALLOWED_UPLOAD_CONTENT_TYPES)
      .filter(([contentType]) => !contentType.startsWith('image/'))
      .flatMap(([contentType, extensions]) =>
        extensions.map((extension) => [
          contentType,
          `uploads/file_20261114101500.${resolveExtension(`file.${extension}`, contentType)}`,
        ])
      )
  )('still answers a %s upload (%s) without processing it', async (contentType, objectKey) => {
    const response = await POST(request({ objectKey, contentType }));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { originalImage: { objectKey: string } };
    expect(body.originalImage.objectKey).toBe(objectKey);
    expect(mocks.s3Send).not.toHaveBeenCalled();
    expect(mocks.supabaseDownloadObject).not.toHaveBeenCalled();
  });

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
