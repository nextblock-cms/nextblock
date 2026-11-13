import sharp from 'sharp';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * POST /api/affiliates/upload: who may upload (partners only, never suspended or in review),
 * what may be uploaded (byte caps, raster formats re-encoded by the real sharp, never SVG), where
 * it lands (server-built keys under the affiliate's prefix) and what an avatar replaces.
 */

const mocks = vi.hoisted(() => ({
  requireRetailer: vi.fn(),
  s3Send: vi.fn(),
  getS3Client: vi.fn(),
  profileUpdate: vi.fn(),
  listed: [] as Array<{ Key: string; LastModified: Date }>,
}));

vi.mock('../../../../lib/affiliates/retailer-actor', () => ({ requireRetailer: mocks.requireRetailer }));
// The row normalizers only (the real portal-data pulls in the catalog and ledger reads).
vi.mock('../../../../lib/affiliates/portal-data', async () => {
  const rows = (await vi.importActual('../../../../../../libs/affiliates/src/lib/repository/rows')) as Record<
    string,
    (raw: unknown) => unknown
  >;
  return {
    readRetailerPortalAccount: (actor: { affiliate?: unknown; page?: unknown } | null) => {
      const profile = rows['normalizeAffiliateProfileRow']?.(actor?.affiliate ?? null);
      return profile ? { profile, page: rows['normalizeAffiliatePageRow']?.(actor?.page ?? null) ?? null } : null;
    },
  };
});
vi.mock('../../../../lib/storage/provider', () => ({
  getStorageBackend: () => 's3',
  getStorageBucket: () => 'media',
  resolveMediaBaseUrl: () => 'https://media.test',
}));
vi.mock('../../../../lib/storage/supabase-storage', () => ({ supabaseUploadObject: vi.fn(), supabaseRemoveObjects: vi.fn() }));
vi.mock('@nextblock-cms/utils/server', () => ({ getS3Client: mocks.getS3Client }));
vi.mock('@nextblock-cms/db/server', () => ({ getServiceRoleSupabaseClient: vi.fn() }));
vi.mock('@aws-sdk/client-s3', () => {
  const command = (name: string) =>
    class {
      readonly name = name;
      constructor(public readonly input: Record<string, unknown>) {}
    };
  return {
    PutObjectCommand: command('Put'),
    DeleteObjectCommand: command('Delete'),
    ListObjectsV2Command: command('List'),
  };
});

import { POST } from './route';

const URL_ = 'https://shop.test/api/affiliates/upload';
const USER = 'u-1';

let affiliateSeq = 0;
function affiliateId() {
  affiliateSeq += 1;
  return `0f8a1c2e-3b4d-4e5f-8a9b-${String(affiliateSeq).padStart(12, '0')}`;
}

type SentCommand = { name: string; input: Record<string, unknown> };
const sent = (name: string) => mocks.s3Send.mock.calls.map(([cmd]) => cmd as SentCommand).filter((cmd) => cmd.name === name);

function serviceDb() {
  return {
    from: (table: string) => ({
      update: (payload: Record<string, unknown>) => {
        const filters: Array<[string, unknown]> = [];
        const builder = {
          eq: (column: string, value: unknown) => {
            filters.push([column, value]);
            return builder;
          },
          select: () => builder,
          maybeSingle: async () => mocks.profileUpdate(table, payload, filters),
        };
        return builder;
      },
    }),
  };
}

function signInPartner(
  overrides: { status?: string; approval?: string; avatar?: string | null; id?: string; publishedAvatar?: string | null } = {},
) {
  const id = overrides.id ?? affiliateId();
  mocks.requireRetailer.mockResolvedValue({
    supabase: serviceDb(),
    actor: {
      userId: USER,
      email: 'jane@shop.test',
      role: 'RTL',
      affiliate: {
        id,
        user_id: USER,
        handle: 'jane',
        display_name: 'Jane',
        status: overrides.status ?? 'ACTIVE',
        avatar_object_key: overrides.avatar ?? null,
        social_links: {},
      },
      page: {
        id: 'p-1',
        affiliate_id: id,
        user_id: USER,
        approval_status: overrides.approval ?? 'DRAFT',
        // The approved snapshot the live storefront renders (set once a page was approved).
        published_profile:
          overrides.publishedAvatar === undefined
            ? null
            : { display_name: 'Jane', bio: null, avatar_object_key: overrides.publishedAvatar, social_links: {} },
      },
    },
  });
  return id;
}

async function png(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: '#3366aa' } }).png().toBuffer();
}

function uploadRequest(parts: { kind?: string; bytes?: Uint8Array; type?: string; name?: string }, headers: Record<string, string> = {}) {
  const form = new FormData();
  if (parts.kind !== undefined) form.append('kind', parts.kind);
  if (parts.bytes) {
    form.append('file', new File([new Uint8Array(parts.bytes)], parts.name ?? 'photo.png', { type: parts.type ?? 'image/png' }));
  }
  return new NextRequest(URL_, { method: 'POST', body: form, headers });
}

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

describe('POST /api/affiliates/upload', () => {
  beforeEach(() => {
    mocks.getS3Client.mockResolvedValue({ send: mocks.s3Send });
    mocks.listed = [];
    mocks.s3Send.mockImplementation(async (command: SentCommand) =>
      command.name === 'List' ? { Contents: mocks.listed, KeyCount: mocks.listed.length, IsTruncated: false } : {},
    );
    mocks.profileUpdate.mockResolvedValue({ data: { id: 'ok' }, error: null });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  describe('who may upload', () => {
    it.each([
      ['Unauthorized', 401, 'unauthorized'],
      ['Forbidden', 403, 'forbidden'],
      ['Suspended', 403, 'suspended'],
      ['PackageInactive', 403, 'package_inactive'],
    ])('%s → %i before reading anything or touching storage', async (message, status, error) => {
      mocks.requireRetailer.mockRejectedValue(new Error(message));
      const response = await POST(uploadRequest({ kind: 'image', bytes: await png(10, 10) }));
      expect(response.status).toBe(status);
      expect(await body(response)).toEqual({ ok: false, error });
      expect(mocks.getS3Client).not.toHaveBeenCalled();
      expect(mocks.s3Send).not.toHaveBeenCalled();
    });

    it('refuses a cross-site browser request', async () => {
      signInPartner();
      const response = await POST(uploadRequest({ kind: 'image', bytes: await png(10, 10) }, { 'sec-fetch-site': 'cross-site' }));
      expect(response.status).toBe(403);
      expect(mocks.s3Send).not.toHaveBeenCalled();
    });

    it('refuses while the storefront is in review', async () => {
      signInPartner({ approval: 'PENDING_REVIEW' });
      const response = await POST(uploadRequest({ kind: 'avatar', bytes: await png(10, 10) }));
      expect(response.status).toBe(409);
      expect(await body(response)).toEqual({ ok: false, error: 'pending_review' });
      expect(mocks.s3Send).not.toHaveBeenCalled();
    });

    it('throttles a partner to 30 uploads an hour', async () => {
      signInPartner();
      for (let attempt = 0; attempt < 30; attempt += 1) {
        // Empty requests still spend the allowance (they are refused after it).
        expect((await POST(new NextRequest(URL_, { method: 'POST' }))).status).toBe(400);
      }
      const response = await POST(uploadRequest({ kind: 'image', bytes: await png(10, 10) }));
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('3600');
    });
  });

  describe('what may be uploaded', () => {
    it('413s an oversized Content-Length before reading the body', async () => {
      signInPartner();
      const request = new NextRequest(URL_, {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(6 * 1024 * 1024) },
        body: 'tiny',
      });
      const response = await POST(request);
      expect(response.status).toBe(413);
      expect(await body(response)).toEqual({ ok: false, error: 'too_large' });
    });

    it('caps an avatar at 2 MB even though the body may carry 5 MB', async () => {
      signInPartner();
      const big = new Uint8Array(2 * 1024 * 1024 + 10);
      big.set(await png(4, 4));
      const response = await POST(uploadRequest({ kind: 'avatar', bytes: big }));
      expect(response.status).toBe(413);
      expect(mocks.s3Send).not.toHaveBeenCalled();
    });

    it('refuses SVG whatever it claims to be, without decoding it', async () => {
      signInPartner();
      const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)" width="10" height="10"/>');
      for (const type of ['image/svg+xml', 'image/png']) {
        const response = await POST(uploadRequest({ kind: 'image', bytes: svg, type, name: 'x.svg' }));
        expect(response.status).toBe(415);
        expect(await body(response)).toEqual({ ok: false, error: 'unsupported_type' });
      }
      expect(sent('Put')).toHaveLength(0);
    });

    it('refuses bytes that are not an image, and a corrupt image', async () => {
      signInPartner();
      const text = await POST(uploadRequest({ kind: 'image', bytes: new TextEncoder().encode('just some text, not pixels'), type: 'image/png' }));
      expect(text.status).toBe(415);
      const real = await png(40, 40);
      const corrupt = await POST(uploadRequest({ kind: 'image', bytes: new Uint8Array([...real.subarray(0, 40), ...new Uint8Array(300).fill(9)]) }));
      expect(corrupt.status).toBe(422);
      expect(await body(corrupt)).toEqual({ ok: false, error: 'invalid_image' });
      expect(sent('Put')).toHaveLength(0);
    });

    it('400s a missing file or an unknown kind', async () => {
      signInPartner();
      expect((await POST(uploadRequest({ kind: 'image' }))).status).toBe(400);
      expect((await POST(uploadRequest({ kind: 'banner', bytes: await png(5, 5) }))).status).toBe(400);
    });
  });

  describe('successful uploads', () => {
    it('stores a page image as a re-encoded JPEG under the affiliate’s pages prefix', async () => {
      const id = signInPartner();
      const response = await POST(uploadRequest({ kind: 'image', bytes: await png(3000, 1000), name: '../../evil.html' }));
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const json = await body(response);
      expect(json).toMatchObject({ ok: true, width: 1600, height: 533 });
      expect(String(json['objectKey'])).toMatch(new RegExp(`^affiliates/pages/${id}/\\d{14}-[0-9a-f]{8}\\.jpg$`));
      expect(json['src']).toBe(`https://media.test/${String(json['objectKey'])}`);

      const [put] = sent('Put');
      expect(put?.input).toMatchObject({ Bucket: 'media', Key: json['objectKey'], ContentType: 'image/jpeg' });
      expect((await sharp(put?.input['Body'] as Buffer).metadata()).format).toBe('jpeg');
      expect(sent('List')[0]?.input).toMatchObject({ Prefix: `affiliates/pages/${id}/` });
      expect(mocks.profileUpdate).not.toHaveBeenCalled();
    });

    it('refuses a page image once the storefront holds 200', async () => {
      signInPartner();
      mocks.listed = Array.from({ length: 200 }, (_, index) => ({ Key: `k${index}`, LastModified: new Date(0) }));
      const response = await POST(uploadRequest({ kind: 'image', bytes: await png(10, 10) }));
      expect(response.status).toBe(409);
      expect(await body(response)).toEqual({ ok: false, error: 'image_limit' });
      expect(sent('Put')).toHaveLength(0);
    });

    it('replaces the avatar and deletes only the previous avatar of this affiliate', async () => {
      const previous = 'affiliates/avatars/PLACEHOLDER/20260101000000-aaaaaaaa.jpg';
      const id = affiliateId();
      signInPartner({ id, avatar: previous.replace('PLACEHOLDER', id) });
      const response = await POST(uploadRequest({ kind: 'avatar', bytes: await png(800, 600) }));
      expect(response.status).toBe(200);
      const json = await body(response);
      expect(json).toMatchObject({ ok: true, width: 512, height: 512 });
      expect(String(json['objectKey'])).toMatch(new RegExp(`^affiliates/avatars/${id}/`));

      expect(mocks.profileUpdate).toHaveBeenCalledWith('affiliate_profiles', { avatar_object_key: json['objectKey'] }, [
        ['id', id],
        ['user_id', USER],
      ]);
      expect(sent('Delete').map((cmd) => cmd.input['Key'])).toEqual([previous.replace('PLACEHOLDER', id)]);
      // Avatars are not counted against the page-image cap.
      expect(sent('List')).toHaveLength(0);
    });

    it.each(['PUBLISHED', 'DRAFT', 'CHANGES_REQUESTED'])(
      'keeps the avatar the approved storefront still shows (page %s), and still saves the new one',
      async (approval) => {
        const id = affiliateId();
        const approved = `affiliates/avatars/${id}/20260101000000-aaaaaaaa.jpg`;
        signInPartner({ id, approval, avatar: approved, publishedAvatar: approved });
        const response = await POST(uploadRequest({ kind: 'avatar', bytes: await png(64, 64) }));
        expect(response.status).toBe(200);
        const json = await body(response);
        expect(mocks.profileUpdate).toHaveBeenCalledWith('affiliate_profiles', { avatar_object_key: json['objectKey'] }, [
          ['id', id],
          ['user_id', USER],
        ]);
        // /partners/<handle> and its Open Graph card render the snapshot's key until the next approval.
        expect(sent('Delete')).toHaveLength(0);
      },
    );

    it('still deletes an unapproved previous avatar, never the approved one', async () => {
      const id = affiliateId();
      const approved = `affiliates/avatars/${id}/20260101000000-aaaaaaaa.jpg`;
      const unapproved = `affiliates/avatars/${id}/20260102000000-bbbbbbbb.jpg`;
      signInPartner({ id, approval: 'PUBLISHED', avatar: unapproved, publishedAvatar: approved });
      expect((await POST(uploadRequest({ kind: 'avatar', bytes: await png(64, 64) }))).status).toBe(200);
      expect(sent('Delete').map((cmd) => cmd.input['Key'])).toEqual([unapproved]);
    });

    it('never deletes an avatar outside the affiliate’s own prefix (seeded or another partner’s)', async () => {
      for (const previous of ['images/seeded-avatar.webp', 'affiliates/avatars/99999999-9999-4999-8999-999999999999/x.jpg']) {
        mocks.s3Send.mockClear();
        signInPartner({ avatar: previous });
        expect((await POST(uploadRequest({ kind: 'avatar', bytes: await png(64, 64) }))).status).toBe(200);
        expect(sent('Delete')).toHaveLength(0);
      }
    });

    it('removes the new object again when the profile update fails, and says nothing more', async () => {
      signInPartner();
      mocks.profileUpdate.mockResolvedValue({ data: null, error: { message: 'relation "affiliate_profiles" violates check' } });
      const response = await POST(uploadRequest({ kind: 'avatar', bytes: await png(64, 64) }));
      expect(response.status).toBe(500);
      expect(await body(response)).toEqual({ ok: false, error: 'upload_failed' });
      const [put] = sent('Put');
      expect(sent('Delete').map((cmd) => cmd.input['Key'])).toEqual([put?.input['Key']]);
    });

    it('never echoes a storage error', async () => {
      signInPartner();
      mocks.s3Send.mockImplementation(async (command: SentCommand) => {
        if (command.name === 'List') return { Contents: [], IsTruncated: false };
        throw new Error('AccessDenied: secret-bucket-policy arn:aws:iam::123');
      });
      const response = await POST(uploadRequest({ kind: 'image', bytes: await png(20, 20) }));
      expect(response.status).toBe(500);
      expect(JSON.stringify(await body(response))).not.toContain('AccessDenied');
    });
  });
});
