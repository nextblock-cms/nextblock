import { describe, expect, it } from 'vitest';

import { findOriginalUploadVariant, pickOriginalUploadObjectKey } from './media-variants';

const avif = 'uploads/photo_20260916_original.avif';
const original = 'uploads/photo_20260916_original_uploaded.jpg';

describe('pickOriginalUploadObjectKey', () => {
  it('prefers the untouched upload over the AVIF derivative', () => {
    expect(
      pickOriginalUploadObjectKey({
        object_key: avif,
        variants: [
          { objectKey: avif, variantLabel: 'original_avif' },
          { objectKey: original, variantLabel: 'original_uploaded', width: 1600, height: 900 },
        ],
      })
    ).toBe(original);
  });

  it('falls back to the row key when no original was kept', () => {
    expect(pickOriginalUploadObjectKey({ object_key: avif, variants: [] })).toBe(avif);
    expect(pickOriginalUploadObjectKey({ object_key: avif, variants: null })).toBe(avif);
    expect(pickOriginalUploadObjectKey({ file_path: avif })).toBe(avif);
  });

  it('ignores malformed variant entries', () => {
    expect(
      pickOriginalUploadObjectKey({
        object_key: avif,
        variants: [null, 'nope', { variantLabel: 'original_uploaded' }, { objectKey: '', variantLabel: 'original_uploaded' }],
      })
    ).toBe(avif);
  });

  it('returns null for nothing at all', () => {
    expect(pickOriginalUploadObjectKey(null)).toBeNull();
    expect(pickOriginalUploadObjectKey({})).toBeNull();
  });

  it('exposes the variant so callers can read its real dimensions', () => {
    expect(
      findOriginalUploadVariant({
        object_key: avif,
        variants: [{ objectKey: original, variantLabel: 'original_uploaded', width: 1600, height: 900 }],
      })
    ).toMatchObject({ height: 900, objectKey: original, width: 1600 });
  });
});
