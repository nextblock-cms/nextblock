import { describe, expect, it } from 'vitest';
import { mediaKeyStem, ownedMediaStorageKeys, withoutKeysInUse } from './media-object-keys';

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
});
