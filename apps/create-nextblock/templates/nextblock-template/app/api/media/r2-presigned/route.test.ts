import { S3Client } from '@aws-sdk/client-s3';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Who may call POST /api/media/r2-presigned (custom-block images): staff (ADMIN / WRITER) whose
 * session passed its enrolled second factor. The URL it signs is a bearer token for a key in the
 * deployment's bucket, and a route handler never passes the CMS layout's 2FA redirect. Until
 * 2026-11-14 the route read the role through the cookie client, so a password alone (the first
 * factor) was enough. It now resolves the caller with getCmsActor(), and this file runs the real
 * one, with evaluateTwoFactor() behind it, against a faked cookie session. Validation and signing
 * are covered by lib/custom-block-r2-upload.test.ts.
 */

const SECOND_FACTOR = 'Complete two-factor verification, then try again.';

const mocks = vi.hoisted(() => ({
  /** The cookie session: the user, their own profile role, their enrolled factor, the session's assurance level. */
  session: {
    user: { id: 'writer-1' } as { id: string } | null,
    role: 'WRITER' as string | null,
    mfa: null as { mfa_enabled: boolean; mfa_type: 'totp' | 'email' } | null,
    aal: 'aal1' as 'aal1' | 'aal2',
  },
  cookieReads: [] as string[],
  getServiceRoleSupabaseClient: vi.fn(),
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
            mocks.cookieReads.push(table);
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
vi.mock('@nextblock-cms/utils/server', () => ({ getS3PresignClient: mocks.getS3PresignClient }));
// The real SDK signs (offline, dummy credentials); getSignedUrl is wrapped only to observe it.
vi.mock('@aws-sdk/s3-request-presigner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/s3-request-presigner')>()),
  getSignedUrl: mocks.getSignedUrl,
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

const VALID = { contentType: 'image/png', filename: 'hero.png', folder: 'custom-blocks/hero', size: 2048 };

function request(body: unknown = VALID) {
  return new NextRequest('http://localhost/api/media/r2-presigned', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function signIn(role: string | null, user: { id: string } | null = { id: 'writer-1' }) {
  mocks.session.user = user;
  mocks.session.role = role;
}

function expectNothingSigned() {
  expect(mocks.getS3PresignClient).not.toHaveBeenCalled();
  expect(mocks.getSignedUrl).not.toHaveBeenCalled();
  expect(mocks.supabaseCreateSignedUpload).not.toHaveBeenCalled();
  expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  vi.stubEnv('STORAGE_PROVIDER', 's3');
  vi.stubEnv('R2_BUCKET_NAME', 'media');
  vi.stubEnv('NEXT_PUBLIC_R2_BASE_URL', 'https://cdn.example.test');
  signIn('WRITER');
  mocks.session.mfa = null;
  mocks.session.aal = 'aal1';
  mocks.cookieReads = [];
  mocks.getServiceRoleSupabaseClient.mockReset();
  mocks.getS3PresignClient.mockReset().mockResolvedValue(presignClient);
  mocks.getSignedUrl.mockReset().mockImplementation(realGetSignedUrl);
  mocks.supabaseCreateSignedUpload.mockReset().mockImplementation(async (key: string) => ({
    signedUrl: `https://project.supabase.co/storage/v1/object/upload/sign/media/${key}?token=t`,
    token: 't',
  }));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/media/r2-presigned: staff past their enrolled second factor', () => {
  it('401s without a session and signs nothing', async () => {
    signIn(null, null);

    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expectNothingSigned();
  });

  it.each([
    ['a customer (USER)', 'USER'],
    ['a partner (RTL)', 'RTL'],
    ['an account without a profile row', null],
  ])('403s %s and signs nothing', async (_label, role) => {
    signIn(role);

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden: Insufficient permissions' });
    expectNothingSigned();
  });

  it('403s a USER even past an enrolled second factor (aal2): the factor is not a role', async () => {
    signIn('USER');
    mocks.session.mfa = { mfa_enabled: true, mfa_type: 'totp' };
    mocks.session.aal = 'aal2';

    expect((await POST(request())).status).toBe(403);
    expectNothingSigned();
  });

  it.each([
    ['a WRITER whose enrolled authenticator app this session has not passed (aal1)', 'WRITER', 'totp'],
    ['an ADMIN whose enrolled authenticator app this session has not passed (aal1)', 'ADMIN', 'totp'],
    ['a WRITER whose enrolled email code this session has not passed', 'WRITER', 'email'],
  ] as const)('refuses %s before reading the body or signing anything', async (_label, role, factor) => {
    signIn(role);
    mocks.session.mfa = { mfa_enabled: true, mfa_type: factor };
    mocks.session.aal = 'aal1';
    const pending = request();

    const response = await POST(pending);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: SECOND_FACTOR });
    expect(pending.bodyUsed).toBe(false);
    // The second factor is checked before the role: the profile row is never read.
    expect(mocks.cookieReads).not.toContain('profiles');
    expectNothingSigned();
  });

  it('answers the pending factor before validating a bad body', async () => {
    mocks.session.mfa = { mfa_enabled: true, mfa_type: 'totp' };

    const response = await POST(request('not json'));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: SECOND_FACTOR });
  });

  it('refuses the pending factor on the native Supabase backend too', async () => {
    vi.stubEnv('STORAGE_PROVIDER', 'supabase');
    mocks.session.mfa = { mfa_enabled: true, mfa_type: 'totp' };

    expect((await POST(request())).status).toBe(403);
    expectNothingSigned();
  });

  it.each(['WRITER', 'ADMIN'])('signs for a %s whose session passed the enrolled authenticator app (aal2)', async (role) => {
    signIn(role);
    mocks.session.mfa = { mfa_enabled: true, mfa_type: 'totp' };
    mocks.session.aal = 'aal2';

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.objectKey).toMatch(/^custom-blocks\/hero\/hero-\d{17}-[a-f0-9-]+\.png$/);
    expect(new URL(body.presignedUrl).searchParams.get('x-amz-meta-uploader-user-id')).toBe('writer-1');
    expect(mocks.getSignedUrl).toHaveBeenCalledTimes(1);
  });

  it('signs for staff who enrolled no second factor', async () => {
    signIn('ADMIN', { id: 'admin-1' });

    const response = await POST(request());

    expect(response.status).toBe(200);
    const [, command] = mocks.getSignedUrl.mock.calls[0] as [unknown, { input: Record<string, unknown> }];
    expect(command.input.Metadata).toEqual({ 'uploader-user-id': 'admin-1' });
  });

  it('refuses a folder inside the partner upload namespaces even for staff past the factor', async () => {
    mocks.session.mfa = { mfa_enabled: true, mfa_type: 'totp' };
    mocks.session.aal = 'aal2';

    const response = await POST(request({ ...VALID, folder: 'affiliates/pages/0b7c5f6e-1111-4c2d-9e8f-123456789abc' }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid upload folder.' });
    expectNothingSigned();
  });
});
