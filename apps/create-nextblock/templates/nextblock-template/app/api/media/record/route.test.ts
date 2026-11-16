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
  cookieReads: [] as string[],
  getServiceRoleSupabaseClient: vi.fn(),
  mediaInsertSingle: vi.fn(),
  insert: vi.fn(),
  revalidatePath: vi.fn(),
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
    from: (table: string) => {
      if (table === 'media') {
        return {
          insert: (...args: unknown[]) => {
            mocks.insert(...args);
            return { select: () => ({ single: mocks.mediaInsertSingle }) };
          },
        };
      }
      return {
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
      };
    },
  }),
  getServiceRoleSupabaseClient: mocks.getServiceRoleSupabaseClient,
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
// No trusted-device or email-code cookie: a second factor counts only through the session itself.
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));
// Read only by the trusted-device and reminder paths, never on the way to these decisions.
vi.mock('../../../../lib/privacy/settings', () => ({
  getSecuritySettings: async () => ({ enforce_staff_2fa: false, trusted_device_days: 30 }),
}));

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
  mocks.session.user = user;
  mocks.session.role = role;
}

async function json(response: Response) {
  return (await response.json()) as { error?: string; success?: boolean };
}

const VALID = { fileName: 'photo.png', r2OriginalKey: 'uploads/photo_20260102030405.png' };

describe('POST /api/media/record', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
    signIn('WRITER');
    mocks.session.mfa = null;
    mocks.session.aal = 'aal1';
    mocks.cookieReads = [];
    mocks.mediaInsertSingle.mockResolvedValue({ data: { id: 'media-1' }, error: null });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  describe('access control', () => {
    it('401s without a session and never inserts', async () => {
      signIn(null, null);
      const response = await POST(request(VALID));
      expect(response.status).toBe(401);
      expect(await json(response)).toEqual({ error: 'User not authenticated.' });
      expect(mocks.insert).not.toHaveBeenCalled();
    });

    it('403s a signed-in customer (role USER)', async () => {
      signIn('USER');
      const response = await POST(request(VALID));
      expect(response.status).toBe(403);
      expect(await json(response)).toEqual({ error: 'Forbidden: Insufficient permissions to record media.' });
      expect(mocks.insert).not.toHaveBeenCalled();
    });

    // A route handler never passes the CMS layout's 2FA redirect. Until 2026-11-14 this route read
    // the role through the cookie client, so a staff password alone (the first factor) recorded rows.
    it.each([
      ['a WRITER whose enrolled authenticator app this session has not passed (aal1)', 'WRITER', 'totp'],
      ['an ADMIN whose enrolled email code this session has not passed', 'ADMIN', 'email'],
    ] as const)('refuses %s before reading the body or writing a row', async (_label, role, factor) => {
      signIn(role);
      mocks.session.mfa = { mfa_enabled: true, mfa_type: factor };
      const pending = request(VALID);

      const response = await POST(pending);

      expect(response.status).toBe(403);
      expect(await json(response)).toEqual({ error: 'Complete two-factor verification, then try again.' });
      expect(pending.bodyUsed).toBe(false);
      expect(mocks.cookieReads).not.toContain('profiles');
      expect(mocks.insert).not.toHaveBeenCalled();
      expect(mocks.revalidatePath).not.toHaveBeenCalled();
      expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
    });

    it('answers the pending factor before validating the payload', async () => {
      mocks.session.mfa = { mfa_enabled: true, mfa_type: 'totp' };
      const response = await POST(request({ fileName: 'a.png' }));
      expect(response.status).toBe(403);
    });

    it('403s a USER past an enrolled second factor (aal2): the factor is not a role', async () => {
      signIn('USER');
      mocks.session.mfa = { mfa_enabled: true, mfa_type: 'totp' };
      mocks.session.aal = 'aal2';
      const response = await POST(request(VALID));
      expect(response.status).toBe(403);
      expect(mocks.insert).not.toHaveBeenCalled();
    });

    it.each(['WRITER', 'ADMIN'])('records media for a %s whose session passed the enrolled authenticator app (aal2)', async (role) => {
      signIn(role, { id: 'staff-1' });
      mocks.session.mfa = { mfa_enabled: true, mfa_type: 'totp' };
      mocks.session.aal = 'aal2';
      const response = await POST(request(VALID));
      expect(response.status).toBe(201);
      const [row] = mocks.insert.mock.calls[0] as [{ uploader_id: string }];
      expect(row.uploader_id).toBe('staff-1');
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

    // Affiliates: partner avatars and storefront images live under affiliates/avatars/ and
    // affiliates/pages/. A media row that names one would let a WRITER delete a partner's file
    // through the media library (decoy row).
    it.each([
      { r2OriginalKey: 'affiliates/avatars/u1/avatar_20260102030405.avif' },
      { r2OriginalKey: '/affiliates/avatars/u1/avatar.png' },
      { r2OriginalKey: 'Affiliates/avatars/u1/avatar.png' },
      // The shared predicate (lib/storage/upload-policy) also drops leading whitespace.
      { r2OriginalKey: ' affiliates/avatars/u1/avatar.png' },
      {
        r2OriginalKey: 'uploads/photo_20260102030405.png',
        r2Variants: [{ objectKey: 'affiliates/pages/u1/hero_large.avif', variantLabel: 'large_avif' }],
      },
      {
        r2OriginalKey: 'uploads/photo_20260102030405.png',
        originalImageDetails: { objectKey: 'affiliates/avatars/u1/avatar.png', variantLabel: 'original_uploaded' },
      },
    ])('400s a payload naming a partner upload (%j) and never inserts', async (fields) => {
      const response = await POST(request({ fileName: 'avatar.png', ...fields }));
      expect(response.status).toBe(400);
      expect((await json(response)).error).toBe('Invalid object key.');
      expect(mocks.insert).not.toHaveBeenCalled();
    });

    // 2026-11-14: the partner check never decoded '%xx', and on the native Supabase backend the
    // storage server decodes a key storage-js puts into a URL, so '%61ffiliates/…' names the same
    // object as 'affiliates/…'. No upload route mints a '%' (or '?', '#'), so a recorded key with
    // one is refused outright, and an encoded partner key is refused in any field.
    it.each([
      { r2OriginalKey: '%61ffiliates/avatars/u1/avatar_20260102030405.png' },
      { r2OriginalKey: 'affiliates%2Fpages/u1/hero_20260102030405.png' },
      { r2OriginalKey: '%2561ffiliates/pages/u1/hero_20260102030405.png' },
      { r2OriginalKey: '%41FFILIATES/AVATARS/u1/avatar_20260102030405.png' },
      { r2OriginalKey: 'uploads/%2e%2e/affiliates/pages/u1/hero_20260102030405.png' },
      { r2OriginalKey: 'uploads/my%20photo_20260102030405.png' },
      { r2OriginalKey: 'uploads/photo_20260102030405.png?.png' },
      {
        r2OriginalKey: 'uploads/photo_20260102030405.png',
        r2Variants: [{ objectKey: 'affiliates/pages%2Fu1/hero_large.avif', variantLabel: 'large_avif' }],
      },
      {
        r2OriginalKey: 'uploads/photo_20260102030405.png',
        r2Variants: [{ objectKey: 'uploads/photo_20260102030405_large.avif', variantLabel: 'original_avif' }],
        originalImageDetails: { objectKey: '%61ffiliates/avatars/u1/avatar.png', variantLabel: 'original_uploaded' },
      },
      {
        // Not recorded (a variant is the primary), and refused all the same.
        r2OriginalKey: '%61ffiliates/avatars/u1/avatar.png',
        r2Variants: [{ objectKey: 'uploads/photo_20260102030405_large.avif', variantLabel: 'original_avif' }],
      },
    ])('400s %j before any database write', async (fields) => {
      const response = await POST(request({ fileName: 'photo.png', ...fields }));
      expect(response.status).toBe(400);
      expect((await json(response)).error).toBe('Invalid object key.');
      expect(mocks.insert).not.toHaveBeenCalled();
      expect(mocks.revalidatePath).not.toHaveBeenCalled();
      expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
    });

    // 2026-11-14: the original's key met only the partner check unless it became the primary (no
    // variant named one), so `uploads/…/victim.png?.png` was recorded (201) next to valid variants.
    // It meets the client-key policy now, whichever key ends up on the row.
    describe('the original key next to valid variants', () => {
      const VARIANTS = {
        r2Variants: [
          { objectKey: 'uploads/photo_20260102030405_original.avif', variantLabel: 'original_avif', fileType: 'image/avif' },
          { objectKey: 'uploads/photo_20260102030405_large.avif', variantLabel: 'large_avif', fileType: 'image/avif' },
        ],
        originalImageDetails: {
          objectKey: 'uploads/photo_20260102030405.png',
          variantLabel: 'original_uploaded',
          fileType: 'image/png',
        },
      };

      it.each([
        'uploads/verify3-ec277d/victim.png?.png',
        'uploads/victim.png#.png',
        'uploads/my photo_20260102030405.png',
        'uploads/evil.html',
        'uploads/nofile',
        'uploads/../victim.png',
        'uploads//photo_20260102030405.png',
        42,
      ])('400s %j before any database write', async (r2OriginalKey) => {
        const response = await POST(request({ fileName: 'photo.png', r2OriginalKey, ...VARIANTS }));
        expect(response.status).toBe(400);
        expect(await json(response)).toEqual({ error: 'Invalid object key.' });
        expect(mocks.insert).not.toHaveBeenCalled();
        expect(mocks.revalidatePath).not.toHaveBeenCalled();
        expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
      });

      it.each(['uploads/photo_20260102030405.png', '/uploads/photo_20260102030405.png'])(
        'still records them next to the minted original key %j',
        async (r2OriginalKey) => {
          const response = await POST(request({ fileName: 'photo.png', r2OriginalKey, ...VARIANTS }));
          expect(response.status).toBe(201);
          expect(mocks.insert).toHaveBeenCalledTimes(1);
          const [row] = mocks.insert.mock.calls[0] as [{ object_key: string }];
          expect(row.object_key).toBe('uploads/photo_20260102030405_original.avif');
        }
      );
    });

    it('still records a media key that merely contains "affiliates/" deeper in the path', async () => {
      const response = await POST(request({ fileName: 'a.png', r2OriginalKey: 'uploads/affiliates/a_20260102030405.png' }));
      expect(response.status).toBe(201);
    });

    it('records a media key under affiliates/ outside the partner namespaces (an ordinary folder)', async () => {
      const response = await POST(
        request({
          fileName: 'banner.png',
          r2OriginalKey: 'affiliates/banners/banner_20260102030405.png',
          r2Variants: [{ objectKey: 'affiliates/banners/banner_20260102030405_large.avif', variantLabel: 'large_avif' }],
        }),
      );
      expect(response.status).toBe(201);
      expect(mocks.insert).toHaveBeenCalledTimes(1);
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
