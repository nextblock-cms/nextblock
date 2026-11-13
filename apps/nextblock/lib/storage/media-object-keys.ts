// apps/nextblock/lib/storage/media-object-keys.ts
import 'server-only';

import { hasAllowedObjectKeyExtension, isPartnerUploadKey, isSafeObjectKey } from './upload-policy';

// The partner namespaces and their predicate live in ./upload-policy (one definition for the
// intake and the deletion side); re-exported here for the media actions and their tests.
export { PARTNER_UPLOAD_KEY_PREFIX, PARTNER_UPLOAD_NAMESPACES, isPartnerUploadKey } from './upload-policy';

/**
 * Which storage objects a media row may take with it when it is deleted or moved.
 *
 * The /cms/media delete and move actions remove storage objects with server credentials,
 * and they used to remove every key a row listed: its `object_key` plus every
 * `variants[].objectKey`. Nothing pins those columns. A WRITER can insert a media row of
 * their own over PostgREST (or through the record endpoints, which take the keys from the
 * client) whose `variants` name another uploader's objects, then delete that row: RLS lets
 * them delete their own row, and the action deleted the other uploader's files (2026-10-21
 * audit). These rules close that, and the helpers here are pure so they can be tested:
 *
 *  1. A row owns only keys derived from its own `object_key`: the upload pipeline
 *     (/api/process-image) writes every variant next to the original as
 *     `<folder>/<base>_<label>.avif`, where the original is `<folder>/<base>.<ext>`, so a
 *     variant that does not share the primary key's folder and base is not this row's.
 *  2. A key another media row still references is never deleted (the caller asks the
 *     database with `media_storage_keys_in_use`, migration 02028).
 *  3. A partner upload (`affiliates/avatars/…` or `affiliates/pages/…`, see
 *     {@link isPartnerUploadKey}) is never a media key: no media row owns one, whatever it
 *     lists, so a delete or move never touches it. The rest of `affiliates/` is an ordinary
 *     media folder.
 */

/*
 * Partner uploads (PARTNER_UPLOAD_NAMESPACES in ./upload-policy) belong to a partner account
 * and no media row references them, so `media_storage_keys_in_use` never
 * protects them: a decoy row naming a partner's avatar (inserted over PostgREST, which RLS
 * allows for a WRITER's own row) would otherwise let the /cms/media delete or move remove it.
 * The staff upload routes and /api/media/record refuse such keys on the way in; the helpers
 * below are the deletion-side half of that defense.
 */

/**
 * Variant labels the pipeline appends to the base name, longest first so `original_uploaded`
 * wins over `original`. Older uploads kept the `_avif` suffix in the file name
 * (`photo_123_large_avif.avif`); the optional group below accepts both spellings.
 */
const VARIANT_SUFFIX_RE = /_(?:original_uploaded|original|xlarge|large|medium|small|thumbnail)(?:_avif)?$/i;

/**
 * The `<folder>/<base>` every object of one upload shares, or null for a key that is not a
 * plain in-bucket media path (traversal, absolute, no media extension, a partner upload).
 */
export function mediaKeyStem(key: unknown): string | null {
  if (
    typeof key !== 'string' ||
    isPartnerUploadKey(key) ||
    !isSafeObjectKey(key) ||
    !hasAllowedObjectKeyExtension(key)
  ) {
    return null;
  }
  const slash = key.lastIndexOf('/');
  const folder = key.slice(0, slash + 1);
  const fileName = key.slice(slash + 1);
  const withoutExtension = fileName.slice(0, fileName.lastIndexOf('.'));
  const base = withoutExtension.replace(VARIANT_SUFFIX_RE, '');
  return base ? `${folder}${base}` : null;
}

/** The variant keys a row lists, whatever shape the `variants` jsonb arrived in. */
function listedVariantKeys(variants: unknown): string[] {
  if (!Array.isArray(variants)) return [];
  return variants
    .map((variant) => (variant && typeof variant === 'object' ? (variant as { objectKey?: unknown }).objectKey : null))
    .filter((key): key is string => typeof key === 'string');
}

/**
 * The storage keys a media row owns: its `object_key` and the listed variants that share
 * its stem, de-duplicated, primary first. A row whose `object_key` is not a media path (a
 * partner upload included) owns nothing, so the caller deletes or moves no object for it.
 */
export function ownedMediaStorageKeys(row: { object_key?: unknown; variants?: unknown }): string[] {
  const stem = mediaKeyStem(row.object_key);
  if (!stem) return [];
  const keys = [row.object_key as string, ...listedVariantKeys(row.variants)];
  return [...new Set(keys.filter((key) => !isPartnerUploadKey(key) && mediaKeyStem(key) === stem))];
}

/**
 * `keys` minus the ones another media row still references (`inUse`), and minus every partner
 * upload: a partner account always uses its own objects, and no media row stands for it.
 */
export function withoutKeysInUse(keys: readonly string[], inUse: Iterable<string>): string[] {
  const referenced = new Set(inUse);
  return keys.filter((key) => !referenced.has(key) && !isPartnerUploadKey(key));
}
