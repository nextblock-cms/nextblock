import { describe, expect, it, vi } from 'vitest';

// lib/affiliates/uploads.ts builds the real partner keys (parity test below); stub the I/O
// modules it imports so loading it reaches no storage, database or S3 client.
vi.mock('@nextblock-cms/db/server', () => ({ getServiceRoleSupabaseClient: vi.fn() }));
vi.mock('@nextblock-cms/utils/server', () => ({ getS3Client: vi.fn() }));
vi.mock('./provider', () => ({
  getStorageBackend: () => 's3',
  getStorageBucket: () => 'media',
  resolveMediaBaseUrl: () => 'https://media.test',
}));
vi.mock('./supabase-storage', () => ({ supabaseUploadObject: vi.fn(), supabaseRemoveObjects: vi.fn() }));

import { affiliateUploadPrefix, buildAffiliateUploadKey } from '../affiliates/uploads';
import {
  PARTNER_UPLOAD_KEY_PREFIX,
  PARTNER_UPLOAD_NAMESPACES,
  isPartnerUploadKey,
  mediaKeyStem,
  ownedMediaStorageKeys,
  withoutKeysInUse,
} from './media-object-keys';

const AFFILIATE = '0f8a1c2e-3b4d-4e5f-8a9b-1c2d3e4f5a6b';
const AVATAR = `affiliates/avatars/${AFFILIATE}/20261027101500-0a1b2c3d.jpg`;
const PAGE_IMAGE = `affiliates/pages/${AFFILIATE}/20261027101501-4e5f6a7b.jpg`;

describe('isPartnerUploadKey', () => {
  it('recognises partner uploads whatever the case, leading slashes, whitespace, backslashes or doubled slashes', () => {
    for (const key of [
      AVATAR,
      PAGE_IMAGE,
      `Affiliates/avatars/${AFFILIATE}/a.jpg`,
      `AFFILIATES/pages/${AFFILIATE}/a.jpg`,
      `/affiliates/avatars/${AFFILIATE}/a.jpg`,
      `//affiliates/pages/${AFFILIATE}/a.jpg`,
      ` affiliates/pages/${AFFILIATE}/a.jpg`,
      `\\affiliates\\avatars\\${AFFILIATE}\\a.jpg`,
      `affiliates//avatars/${AFFILIATE}/a.jpg`,
      'affiliates/avatars/',
      'affiliates/pages',
    ]) {
      expect(isPartnerUploadKey(key), key).toBe(true);
    }
  });

  it('leaves every other key alone, the rest of affiliates/ included', () => {
    for (const key of [
      'uploads/affiliates/a.jpg',
      'affiliates-old/a.jpg',
      'affiliates.jpg',
      'affiliates',
      'affiliates/',
      'affiliates/banner_1.png',
      'affiliates/banners/b.png',
      'affiliates/pages-old/a.png',
      'affiliates/avatars.png',
      'uploads/a.png',
      '',
    ]) {
      expect(isPartnerUploadKey(key), key).toBe(false);
    }
    expect(isPartnerUploadKey(null)).toBe(false);
    expect(isPartnerUploadKey(42)).toBe(false);
  });

  it('matches the keys the partner upload route really builds (lib/affiliates/uploads.ts)', () => {
    const now = new Date('2026-10-27T10:15:00Z');
    for (const kind of ['avatar', 'image'] as const) {
      const prefix = affiliateUploadPrefix(kind, AFFILIATE);
      const key = buildAffiliateUploadKey(kind, AFFILIATE, now, '0a1b2c3d');
      expect(prefix?.startsWith(PARTNER_UPLOAD_KEY_PREFIX)).toBe(true);
      // A new partner namespace must be added to PARTNER_UPLOAD_NAMESPACES (or staff paths reach it).
      expect(PARTNER_UPLOAD_NAMESPACES.some((namespace) => prefix?.startsWith(namespace)), String(prefix)).toBe(true);
      expect(key).not.toBeNull();
      expect(isPartnerUploadKey(key)).toBe(true);
      expect(isPartnerUploadKey(prefix)).toBe(true);
      expect(mediaKeyStem(key)).toBeNull();
    }
  });
});

describe('mediaKeyStem', () => {
  it('maps the original, the AVIF original and every size variant to one stem', () => {
    const stem = 'uploads/photo_20261021101500';
    expect(mediaKeyStem(`${stem}.png`)).toBe(stem);
    expect(mediaKeyStem(`${stem}_original.avif`)).toBe(stem);
    expect(mediaKeyStem(`${stem}_xlarge.avif`)).toBe(stem);
    expect(mediaKeyStem(`${stem}_large.avif`)).toBe(stem);
    expect(mediaKeyStem(`${stem}_medium.avif`)).toBe(stem);
    expect(mediaKeyStem(`${stem}_small.avif`)).toBe(stem);
    expect(mediaKeyStem(`${stem}_thumbnail.avif`)).toBe(stem);
  });

  it('accepts the older `_<label>_avif` spelling', () => {
    expect(mediaKeyStem('uploads/photo_1_large_avif.avif')).toBe('uploads/photo_1');
    expect(mediaKeyStem('uploads/photo_1_original_uploaded.jpg')).toBe('uploads/photo_1');
  });

  it('keeps the folder, so the same file name elsewhere is another stem', () => {
    expect(mediaKeyStem('a/photo_1.png')).not.toBe(mediaKeyStem('b/photo_1.png'));
  });

  it('refuses keys that are not plain media paths', () => {
    expect(mediaKeyStem('../secret.png')).toBeNull();
    expect(mediaKeyStem('/uploads/a.png')).toBeNull();
    expect(mediaKeyStem('backups/full-backup.zip')).toBeNull();
    expect(mediaKeyStem('uploads/no-extension')).toBeNull();
    expect(mediaKeyStem(null)).toBeNull();
    expect(mediaKeyStem(42)).toBeNull();
  });

  it('refuses partner uploads, which are never media-library keys', () => {
    expect(mediaKeyStem(AVATAR)).toBeNull();
    expect(mediaKeyStem(PAGE_IMAGE)).toBeNull();
    expect(mediaKeyStem(`Affiliates/pages/${AFFILIATE}/photo_1_large.avif`)).toBeNull();
  });
});

describe('ownedMediaStorageKeys', () => {
  const own = 'uploads/mine_20261021';

  it('returns the primary key and the variants of the same upload', () => {
    expect(
      ownedMediaStorageKeys({
        object_key: `${own}_original.avif`,
        variants: [
          { objectKey: `${own}.png` },
          { objectKey: `${own}_large.avif` },
          { objectKey: `${own}_original.avif` },
        ],
      }),
    ).toEqual([`${own}_original.avif`, `${own}.png`, `${own}_large.avif`]);
  });

  it("drops variants that name another upload's objects (the decoy-row attack)", () => {
    expect(
      ownedMediaStorageKeys({
        object_key: `${own}.png`,
        variants: [
          { objectKey: 'uploads/victim_20261020_large.avif' },
          { objectKey: 'other-folder/mine_20261021_large.avif' },
          { objectKey: 'brand/logo.png' },
          { objectKey: `${own}_small.avif` },
        ],
      }),
    ).toEqual([`${own}.png`, `${own}_small.avif`]);
  });

  it('owns nothing when the primary key is not a media path', () => {
    expect(ownedMediaStorageKeys({ object_key: 'backups/db.sql', variants: [{ objectKey: 'backups/db.png' }] })).toEqual([]);
    expect(ownedMediaStorageKeys({ object_key: null })).toEqual([]);
  });

  it("a decoy row naming a partner's upload owns nothing (affiliates/ keys)", () => {
    // object_key is the partner's avatar, variants its storefront images: the row was written
    // over PostgREST by a WRITER, so none of it may reach a storage delete or move.
    expect(
      ownedMediaStorageKeys({
        object_key: AVATAR,
        variants: [{ objectKey: AVATAR }, { objectKey: PAGE_IMAGE }],
      }),
    ).toEqual([]);
    expect(ownedMediaStorageKeys({ object_key: `AFFILIATES/avatars/${AFFILIATE}/x.jpg` })).toEqual([]);
    // A real media row that also lists a partner key keeps only its own objects.
    expect(
      ownedMediaStorageKeys({
        object_key: `${own}.png`,
        variants: [{ objectKey: PAGE_IMAGE }, { objectKey: `${own}_small.avif` }],
      }),
    ).toEqual([`${own}.png`, `${own}_small.avif`]);
  });

  it('owns an ordinary media upload kept in an affiliates/ folder outside the partner namespaces', () => {
    expect(mediaKeyStem('affiliates/banner_1.png')).toBe('affiliates/banner_1');
    expect(
      ownedMediaStorageKeys({
        object_key: 'affiliates/banner_1.png',
        variants: [{ objectKey: 'affiliates/banner_1_large.avif' }, { objectKey: PAGE_IMAGE }],
      }),
    ).toEqual(['affiliates/banner_1.png', 'affiliates/banner_1_large.avif']);
    expect(withoutKeysInUse(['affiliates/banner_1.png', AVATAR], [])).toEqual(['affiliates/banner_1.png']);
  });

  it('tolerates a missing or malformed variants column', () => {
    expect(ownedMediaStorageKeys({ object_key: `${own}.png`, variants: null })).toEqual([`${own}.png`]);
    expect(ownedMediaStorageKeys({ object_key: `${own}.png`, variants: { objectKey: 'x' } })).toEqual([`${own}.png`]);
    expect(ownedMediaStorageKeys({ object_key: `${own}.png`, variants: [null, 3, { objectKey: 7 }] })).toEqual([`${own}.png`]);
  });
});

describe('withoutKeysInUse', () => {
  it('keeps only the keys no other media row references', () => {
    expect(withoutKeysInUse(['a.png', 'b.png', 'c.png'], ['b.png'])).toEqual(['a.png', 'c.png']);
    expect(withoutKeysInUse(['a.png'], [])).toEqual(['a.png']);
  });

  it('never returns a partner upload, even one no media row references', () => {
    expect(withoutKeysInUse(['uploads/a.png', AVATAR, `/Affiliates/pages/${AFFILIATE}/b.jpg`, PAGE_IMAGE], [])).toEqual([
      'uploads/a.png',
    ]);
  });
});
