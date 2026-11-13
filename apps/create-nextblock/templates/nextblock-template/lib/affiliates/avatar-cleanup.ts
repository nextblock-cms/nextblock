import 'server-only';

import { isOwnAffiliateAvatarKey } from './upload-keys';

/**
 * The avatar of a superseded approval snapshot.
 *
 * The public storefront renders `affiliate_pages.published_profile.avatar_object_key` (its
 * header, JSON-LD and Open Graph card), so the upload route never deletes that object when the
 * partner picks a new avatar: the live page would show a broken image until the next approval.
 * Once an approval publishes a newer snapshot, the previous snapshot's avatar is shown nowhere,
 * and the approval deletes it here.
 */
export interface SupersededAffiliateAvatarInput {
  affiliateId: string;
  /** `published_profile.avatar_object_key` as it was BEFORE the approval wrote the new snapshot. */
  previousPublishedKey: string | null | undefined;
  /** Keys still in use: the partner's current avatar, which the new snapshot names. */
  keepKeys: ReadonlyArray<string | null | undefined>;
}

/**
 * The previous snapshot's avatar key when it may be deleted: one of this partner's own avatar
 * objects (`affiliates/avatars/<id>/…`, never a seeded `images/` key or another partner's) that
 * no kept key names. Null otherwise. Pure.
 */
export function supersededAffiliateAvatarKey(input: SupersededAffiliateAvatarInput): string | null {
  const previous = input.previousPublishedKey;
  if (typeof previous !== 'string' || previous.trim() === '') return null;
  if (input.keepKeys.some((key) => typeof key === 'string' && key.trim() === previous.trim())) return null;
  return isOwnAffiliateAvatarKey(previous, input.affiliateId) ? previous : null;
}

function describeError(error: unknown): string {
  return error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : String(error);
}

/**
 * Deletes {@link supersededAffiliateAvatarKey} after a successful approval. Best effort, never
 * throws: a failure only leaves one orphaned 512 px JPEG, and is logged. True when an object was
 * deleted. The upload module (sharp and the storage clients) is loaded only when there is
 * something to delete, so the CMS actions do not load the image pipeline.
 */
export async function deleteSupersededAffiliateAvatar(input: SupersededAffiliateAvatarInput): Promise<boolean> {
  const key = supersededAffiliateAvatarKey(input);
  if (!key) return false;
  try {
    const { deleteAffiliateUploadObject } = await import('./uploads');
    await deleteAffiliateUploadObject(key);
    return true;
  } catch (error) {
    console.error('[affiliates] Superseded avatar cleanup failed:', describeError(error));
    return false;
  }
}
