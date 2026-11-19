/**
 * The one reading of a product gallery in TypeScript, shared by every place there that shows or writes
 * one: the product save (`updateProduct` in product-actions.ts), the form's draft save
 * (`saveProductDraftMeta`), ProductForm's gallery manager, and the app's product edit page and draft
 * checks (apps/nextblock/app/cms/products). Import-free, so client and server code can share it.
 *
 * A draft publish does not come through here: `public.publish_product_draft` (migrations 02043 and
 * 02044) reads the raw ids buildProductDraftPublishValues sends by the same rule in SQL
 * (private.apply_product_draft_values), then keeps only ids with a media row. A change to the rule
 * here changes what the edit page shows, not what publish writes: change both, with a case in the
 * app's gallery-parity.test.tsx.
 *
 * A gallery is an ordered list of `{ media_id }` entries: the first image is the product's main
 * image, and a save writes each entry's index as its `sort_order`. A draft's gallery is untrusted:
 * product_drafts RLS checks the role only, so any WRITER can PATCH a draft over PostgREST with
 * entries in another case, repeats, ids that are not uuids, a `sort_order` of their own, or an
 * embedded `media` object naming any file. Until this module (security review 2026-11-15, the
 * 0.23.4 follow-up) the edit page drew such a draft's tiles from that embedded object (whenever its
 * media query failed, which one non-uuid id made it do, or missed an id) and in its `sort_order`,
 * while publish wrote the array's order, lowercased, without the entries it cannot write: an ADMIN
 * could be shown the live gallery and publish another order, or another main image.
 */

/** A media row id: a uuid in any case (Postgres prints them lowercase). */
export const PRODUCT_MEDIA_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A gallery as a save reads it (normalizeProductGallery). */
export interface NormalizedProductGallery {
  /**
   * The media ids a save writes, in the list's order (a save writes the index as `sort_order`),
   * lowercased, each once. A save still leaves out an id with no media row (it checks the media
   * table before its first write).
   */
  mediaIds: string[];
  /** Entries a save leaves out because they carry no media id it can write (none, or not a uuid). */
  invalidCount: number;
  /** Entries a save leaves out because they repeat an id listed before them (in any case). */
  duplicateCount: number;
}

/**
 * The gallery a save writes from a values object's `product_media`, before the media table is read:
 * every entry's `media_id` in the list's order, lowercased, each once, and only uuids. Each entry's
 * `sort_order` and anything else it carries are ignored. Null when `value` is not a list: a save then
 * leaves the gallery as it is.
 */
export function normalizeProductGallery(value: unknown): NormalizedProductGallery | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const mediaIds: string[] = [];
  let invalidCount = 0;
  let duplicateCount = 0;

  for (const entry of value) {
    const rawId = entry !== null && typeof entry === 'object' ? (entry as { media_id?: unknown }).media_id : undefined;
    if (typeof rawId !== 'string' || !PRODUCT_MEDIA_ID_PATTERN.test(rawId)) {
      invalidCount += 1;
      continue;
    }

    // Lowercased: Postgres returns uuids lowercase, so another spelling would read as a missing row.
    const mediaId = rawId.toLowerCase();
    if (mediaIds.includes(mediaId)) {
      duplicateCount += 1;
      continue;
    }

    mediaIds.push(mediaId);
  }

  return { mediaIds, invalidCount, duplicateCount };
}

/**
 * What a draft stores for a gallery: the normalized ids as bare `{ media_id }` entries, nothing
 * else (no embedded `media`, no `sort_order`). Null when `value` is not a list.
 */
export function toProductGalleryDraftEntries(value: unknown): Array<{ media_id: string }> | null {
  const gallery = normalizeProductGallery(value);
  return gallery ? gallery.mediaIds.map((media_id) => ({ media_id })) : null;
}

/**
 * Gallery entries in the order ProductForm shows them and saves them: by `sort_order` (a missing one
 * reads as 0), the list's order among equals. The live gallery comes from an embedded select whose
 * row order Postgres does not promise, and the form used to show this order while it saved the
 * list's own, so an edit to any other field could change the main image.
 */
export function orderProductGalleryEntries<T extends { sort_order?: number | null }>(entries: readonly T[]): T[] {
  return entries
    .map((entry, index) => ({ entry, index, order: typeof entry.sort_order === 'number' ? entry.sort_order : 0 }))
    .sort((left, right) => left.order - right.order || left.index - right.index)
    .map(({ entry }) => entry);
}
