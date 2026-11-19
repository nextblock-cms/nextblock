import { describe, expect, it } from 'vitest';
import {
  normalizeProductGallery,
  orderProductGalleryEntries,
  PRODUCT_MEDIA_ID_PATTERN,
  toProductGalleryDraftEntries,
} from './product-gallery';

/**
 * The one reading of a product gallery that the save (updateProduct), the form's draft save and the
 * edit page share (security review 2026-11-15, the 0.23.4 follow-up): a draft's `product_media` is
 * whatever its writer put there, and the edit page used to show a draft's gallery differently from
 * how publish wrote it. A draft publish applies the same rule in SQL (publish_product_draft, migration
 * 02043): the app's gallery-parity.test.tsx holds the edit page to it.
 */

const A = 'a1111111-1111-4111-8111-11111111111a';
const B = 'b2222222-2222-4222-8222-22222222222b';

describe('normalizeProductGallery', () => {
  it('reads no gallery from a value that is not a list (a save then leaves the gallery as it is)', () => {
    for (const value of [undefined, null, 'x', 7, { media_id: A }]) {
      expect(normalizeProductGallery(value)).toBeNull();
    }
  });

  it("keeps the list's order and nothing else of an entry: not its sort_order, id or embedded media", () => {
    expect(
      normalizeProductGallery([
        { media_id: B, sort_order: 9, id: 'row-2', media: { file_path: 'uploads/live-main.webp' } },
        { media_id: A, sort_order: 0 },
      ])
    ).toEqual({ mediaIds: [B, A], invalidCount: 0, duplicateCount: 0 });
  });

  it('lowercases an id, the way Postgres prints uuids, and counts a later spelling of it as a repeat', () => {
    expect(normalizeProductGallery([{ media_id: A.toUpperCase() }, { media_id: B }, { media_id: A }])).toEqual({
      mediaIds: [A, B],
      invalidCount: 0,
      duplicateCount: 1,
    });
  });

  it('leaves out and counts every entry with no media id a save can write', () => {
    expect(
      normalizeProductGallery([
        null,
        'a1111111-1111-4111-8111-11111111111a', // a bare string is not an entry
        { media_id: 'not-a-uuid' },
        { media_id: ` ${A}` },
        { media_id: 42 },
        { media: { file_path: 'uploads/live-main.webp' } },
        { media_id: B },
      ])
    ).toEqual({ mediaIds: [B], invalidCount: 6, duplicateCount: 0 });
  });

  it('reads an empty list as an empty gallery (a save unlinks every image), not as none', () => {
    expect(normalizeProductGallery([])).toEqual({ mediaIds: [], invalidCount: 0, duplicateCount: 0 });
  });

  it('accepts only uuids', () => {
    expect(PRODUCT_MEDIA_ID_PATTERN.test(A)).toBe(true);
    expect(PRODUCT_MEDIA_ID_PATTERN.test(A.toUpperCase())).toBe(true);
    expect(PRODUCT_MEDIA_ID_PATTERN.test(`${A}x`)).toBe(false);
    expect(PRODUCT_MEDIA_ID_PATTERN.test('media-1')).toBe(false);
  });
});

describe('toProductGalleryDraftEntries', () => {
  it('stores the normalized ids as bare { media_id } entries', () => {
    expect(
      toProductGalleryDraftEntries([{ media_id: B.toUpperCase(), sort_order: 3, media: { file_path: 'x.webp' } }, { media_id: 'x' }, { media_id: B }])
    ).toEqual([{ media_id: B }]);
    expect(toProductGalleryDraftEntries(undefined)).toBeNull();
  });
});

describe('orderProductGalleryEntries', () => {
  it("orders by sort_order, keeps the list's order among equals, and reads a missing one as 0", () => {
    const entries = [
      { media_id: 'c', sort_order: 2 },
      { media_id: 'a', sort_order: 0 },
      { media_id: 'd' },
      { media_id: 'b', sort_order: 1 },
      { media_id: 'e', sort_order: null },
    ];

    expect(orderProductGalleryEntries(entries).map((entry) => entry.media_id)).toEqual(['a', 'd', 'e', 'b', 'c']);
    expect(entries[0].media_id).toBe('c'); // a copy: the input is untouched
  });
});
