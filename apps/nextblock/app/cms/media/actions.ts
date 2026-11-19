// app/cms/media/actions.ts
"use server";

import "server-only";

import { createClient, getServiceRoleSupabaseClient } from "@nextblock-cms/db/server";
import { revalidatePath } from "next/cache";
import type { Database } from "@nextblock-cms/db";
import { encodedRedirect } from "@nextblock-cms/utils/server";
import { DeleteObjectCommand, DeleteObjectsCommand, CopyObjectCommand, ListObjectsV2Command, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getS3Client } from "@nextblock-cms/utils/server";
import { getStorageBackend, getStorageBucket } from "../../../lib/storage/provider";
import { supabaseRemoveObjects } from "../../../lib/storage/supabase-storage";
import { isPartnerUploadKey, mediaKeyStem, ownedMediaStorageKeys, withoutKeysInUse } from "../../../lib/storage/media-object-keys";
import { getPublicMediaBaseUrl, resolveMediaUrl } from "../../../lib/media/resolveMediaUrl";
import { findMediaUsage } from "../../../lib/media/media-usage";
import { isMediaUnused, withoutAdminOnlyLabels, type MediaUsage } from "../../../lib/media/media-usage-format";

type Media = Database['public']['Tables']['media']['Row'];

/**
 * The subset of `keys` that a media row other than `excludeMediaId` still references, as
 * `object_key`, `file_path` or a `variants[].objectKey` (public.media_storage_keys_in_use,
 * migration 02028). A row only lists keys, it does not own them: a WRITER can create a row
 * whose variants name another uploader's objects, so a delete or move must never remove a key
 * some other row points at (lib/storage/media-object-keys.ts). Read with the service role,
 * after the caller's own role check, so the answer does not depend on what RLS lets the caller
 * see. Fails closed: if the check cannot run, every key counts as in use and no object is
 * deleted (an orphaned object can be reclaimed, a deleted one cannot).
 */
async function storageKeysStillInUse(keys: string[], excludeMediaId?: string): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  try {
    // The function arrives with migration 02028; cast past the generated types until
    // `npm run db:types` is regenerated.
    const service = getServiceRoleSupabaseClient() as unknown as {
      rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
    };
    const { data, error } = await service.rpc("media_storage_keys_in_use", {
      p_keys: keys,
      p_exclude_id: excludeMediaId ?? null,
    });
    if (error || !Array.isArray(data)) {
      console.error("Media: could not check which storage keys are still in use:", error?.message ?? "no data");
      return new Set(keys);
    }
    return new Set(data.filter((key): key is string => typeof key === "string"));
  } catch (error) {
    console.error("Media: could not check which storage keys are still in use:", error);
    return new Set(keys);
  }
}

// --- recordMediaUpload and updateMediaItem functions to be updated similarly ---



import { recordMediaUpload as sharedRecordMediaUpload, type MediaUploadPayload } from "@nextblock-cms/db";
import { getCmsActor, isCmsStaffRole, requireCmsStaff } from "../../../lib/auth/cms-actor";

/**
 * The staff check of the actions that remove or relocate storage objects (deleteMediaItem,
 * deleteMultipleMediaItems, moveMultipleMediaItems). They delete and copy objects with the
 * deployment's storage credentials after a service-role read (storageKeysStillInUse), which a
 * first-factor session cannot do over PostgREST, and a server action never passes the CMS
 * layout's 2FA redirect. So a role read is not enough: getCmsActor() also refuses a session whose
 * enrolled second factor is pending. Until 2026-11-13 these read the role through the cookie
 * client. Called after the session check, so a null actor here means a pending second factor.
 * Returns the refusal message, or null for staff past their second factor.
 */
async function mediaStorageStaffRefusal(): Promise<string | null> {
  const actor = await getCmsActor();
  if (!actor) return "Complete two-factor verification, then try again.";
  return isCmsStaffRole(actor.role) ? null : "Forbidden: Insufficient permissions.";
}

/**
 * Record an upload as the signed-in staff member. Takes no actor: this checks the session
 * first (`requireCmsStaff()`, second factor included), and the shared action reads the
 * uploader from that same session, ignoring anything else in the payload. Server routes
 * with no session use `recordMediaUploadAsActor` from `@nextblock-cms/db/server`.
 */
export async function recordMediaUpload(payload: MediaUploadPayload, returnJustData?: boolean) {
  try {
    await requireCmsStaff();
  } catch {
    if (returnJustData) return { error: "Forbidden: Insufficient permissions to record media." };
    return encodedRedirect("error", "/cms/media", "Forbidden: Insufficient permissions to record media.");
  }

  return sharedRecordMediaUpload(payload, returnJustData);
}


export async function updateMediaItem(
    mediaId: string,
    payload: { description?: string; file_name?: string },
    returnJustData?: boolean
) {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    const mediaEditPath = `/cms/media/${mediaId}/edit`;

    if (!user) {
        if (returnJustData) return { error: "User not authenticated for media update." };
        return encodedRedirect("error", mediaEditPath, "User not authenticated for media update.");
    }

    const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
    if (!profile || !["ADMIN", "WRITER"].includes(profile.role)) {
        if (returnJustData) return { error: "Forbidden to update media." };
        return encodedRedirect("error", mediaEditPath, "Forbidden to update media.");
    }

    const updateData: Partial<Pick<Media, 'description' | 'file_name' | 'updated_at'>> = {};
    if (payload.description !== undefined) updateData.description = payload.description;
    if (payload.file_name !== undefined) updateData.file_name = payload.file_name;

    if (Object.keys(updateData).length === 0) {
        if (returnJustData) return { error: "No updatable fields provided for media." };
        return encodedRedirect("error", mediaEditPath, "No updatable fields provided for media.");
    }
    updateData.updated_at = new Date().toISOString();

    const { data: updatedMedia, error } = await supabase
        .from("media")
        .update(updateData)
        .eq("id", mediaId)
        .select()
        .single();

    if (error) {
        console.error("Error updating media item:", error);
        if (returnJustData) return { error: `Error updating media: ${error.message}` };
        return encodedRedirect("error", mediaEditPath, `Error updating media: ${error.message}`);
    }
    revalidatePath("/cms/media");
    revalidatePath(mediaEditPath);
    if (returnJustData) {
        return { success: true, media: updatedMedia } as { success: true; media: Media };
    }
    // Returned, as every error path does: encodedRedirect is async, and an unreturned call left an
    // unhandled NEXT_REDIRECT rejection while the action resolved without redirecting.
    return encodedRedirect("success", mediaEditPath, "Media item updated successfully.");
}


/**
 * What deleteMediaItem answers: the delete button toasts either. Never a redirect: /cms/media
 * reads no `?error=` / `?success=`, so a redirect lost the library's folder and search and showed
 * nothing (through 0.23.4 every refusal redirected that way).
 */
export type DeleteMediaItemResult = { success: string; error?: undefined } | { error: string; success?: undefined };

// `_objectKey` stays in the signature for existing callers; the keys to delete come from the
// row that was actually deleted, never from the client.
export async function deleteMediaItem(mediaId: string, _objectKey?: string): Promise<DeleteMediaItemResult> {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return { error: "User not authenticated." };
    }

    const refusal = await mediaStorageStaffRefusal();
    if (refusal) {
        return { error: refusal };
    }

    const backend = getStorageBackend();
    const bucket = getStorageBucket();
    const s3Client = backend === 's3' ? await getS3Client() : null;

    if (!bucket) {
      return { error: "Storage bucket not configured for deletion." };
    }
    if (backend === 's3' && !s3Client) {
      return { error: "R2 client is not configured for deletion." };
    }

    // Delete the DB row FIRST and read back the rows that were actually removed. Under RLS
    // (media_delete_policy, migration 02022 §9) a non-owner WRITER matches zero rows, so if we
    // destroyed the storage objects before the DB delete the object would be gone while the row
    // survived (an orphan) and the UI would still report success. Only objects belonging to a row
    // we were allowed to delete are safe to remove.
    const { data: deletedRows, error: dbError } = await supabase
      .from("media")
      .delete()
      .eq("id", mediaId)
      .select("object_key, variants");

    if (dbError) {
        console.error("Error deleting media record from DB:", dbError);
        return { error: `Failed to delete media record: ${dbError.message}` };
    }

    if (!deletedRows || deletedRows.length === 0) {
        // RLS removed nothing: the row either does not exist or belongs to another uploader.
        // Leave storage untouched so we never orphan an object we had no right to delete.
        return { error: "Media item not found or you do not have permission to delete it." };
    }

    // Only the objects this row owns (its object_key and the variants of that same upload), and
    // none another row still references: never the caller's `objectKey`, never whatever keys
    // the row happens to list (lib/storage/media-object-keys.ts).
    const ownedKeys = ownedMediaStorageKeys(deletedRows[0]);
    const keysToDelete = withoutKeysInUse(ownedKeys, await storageKeysStillInUse(ownedKeys));

    try {
        if (keysToDelete.length === 0) {
            // Nothing this row owns is left to remove.
        } else if (backend === 'supabase') {
            await supabaseRemoveObjects(keysToDelete);
        } else {
            await s3Client!.send(new DeleteObjectsCommand({
                Bucket: bucket,
                Delete: {
                    Objects: keysToDelete.map(key => ({ Key: key })),
                },
            }));
        }
    } catch (r2Error: unknown) {
        // The DB row is already gone; a storage failure here leaves an orphaned OBJECT (not an
        // orphaned row), which the full-backup/orphan sweep can reclaim. Log and report success.
        console.error("Error deleting from storage:", r2Error);
    }

    // No redirect on success: the revalidation re-renders the library in place, keeping its folder and
    // search, and /cms/media renders no ?success= banner. 0.23.3 called encodedRedirect here without
    // returning it, which left an unhandled NEXT_REDIRECT rejection; returning it navigated to the
    // unfiltered library (review 2026-11-15).
    revalidatePath("/cms/media");
    return { success: "Media item deleted." };
}

/**
 * The shared body of the bulk deletes (deleteMultipleMediaItems, deleteUnusedMediaItems), run after
 * the caller's staff check: delete the rows `ids` as the caller, then only the storage objects those
 * rows own and no other row still lists. Answers the ids of the rows actually deleted, or the error
 * the action returns as it is.
 */
async function deleteMediaRowsAndOwnedObjects(
  supabase: ReturnType<typeof createClient>,
  ids: string[]
): Promise<{ error: string } | { deletedIds: string[]; deletedCount: number }> {
  const backend = getStorageBackend();
  const bucket = getStorageBucket();
  const s3Client = backend === 's3' ? await getS3Client() : null;

  if (!bucket) {
    return { error: "Storage bucket not configured for deletion." };
  }
  if (backend === 's3' && !s3Client) {
    return { error: "R2 client is not configured for deletion." };
  }

  // Delete the DB rows FIRST and read back the rows that were actually removed. RLS
  // (media_delete_policy, migration 02022 §9) silently drops rows this user does not own, so
  // deleting storage up front would destroy objects while their rows survived (orphans) and
  // still report success. We only ever remove objects for rows we were allowed to delete.
  const { data: deletedRows, error: dbDeleteError } = await supabase
    .from("media")
    .delete()
    .in("id", ids)
    .select("id, object_key, variants");

  if (dbDeleteError) {
    console.error("Error batch deleting media records from DB:", dbDeleteError);
    return { error: `Failed to delete media records from DB: ${dbDeleteError.message}` };
  }

  if (!deletedRows || deletedRows.length === 0) {
    // Nothing was removed: the rows are missing or owned by another uploader. Touch no storage.
    return { error: "None of the selected media could be deleted (not found, or you do not have permission to delete them)." };
  }

  // Build the storage key list from the rows that were actually deleted — never from the
  // caller-supplied object keys, which could name objects for rows RLS refused to delete — and
  // from each row only the objects it owns, minus any another row still references.
  const ownedKeys = [...new Set(deletedRows.flatMap((item) => ownedMediaStorageKeys(item)))];
  const allKeysToDelete = withoutKeysInUse(ownedKeys, await storageKeysStillInUse(ownedKeys));

  const r2ObjectsToDelete = allKeysToDelete.map(key => ({ Key: key }));
  let r2DeletionError = null;

  // Batch delete from object storage. The DB rows are already gone, so a storage failure here
  // leaves orphaned OBJECTS (reclaimable by the orphan sweep), not orphaned rows.
  try {
    if (r2ObjectsToDelete.length > 0) {
      if (backend === 'supabase') {
        await supabaseRemoveObjects(allKeysToDelete);
      } else {
        const output = await s3Client!.send(new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: r2ObjectsToDelete },
        }));
        if (output.Errors && output.Errors.length > 0) {
          console.error("Errors deleting some objects from storage:", output.Errors);
          // Collect specific errors if needed, for now a general message
          r2DeletionError = `Some objects failed to delete from storage: ${output.Errors.map(e => e.Key).join(', ')}`;
        }
      }
    }
  } catch (error: unknown) {
    console.error("Error batch deleting from storage:", error);
    r2DeletionError = `Failed to delete objects from storage: ${error instanceof Error ? error.message : String(error)}`;
  }

  if (r2DeletionError) {
    // No redirect here, return error object for client-side handling
    return { error: `Deletion process encountered issues: ${r2DeletionError}` };
  }

  return {
    deletedIds: deletedRows.map((row) => (row as { id?: unknown }).id).filter((id): id is string => typeof id === "string"),
    deletedCount: deletedRows.length,
  };
}

export async function deleteMultipleMediaItems(items: Array<{ id: string; objectKey: string }>) {
  const supabase = createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return { error: "User not authenticated." };
  }

  const refusal = await mediaStorageStaffRefusal();
  if (refusal) {
    return { error: refusal };
  }

  if (!items || items.length === 0) {
    return { error: "No items selected for deletion." };
  }

  const itemIdsToDelete = items.map(item => item.id);
  const outcome = await deleteMediaRowsAndOwnedObjects(supabase, itemIdsToDelete);
  if ("error" in outcome) {
    return { error: outcome.error };
  }

  revalidatePath("/cms/media");

  // Some selected rows may have been left untouched by RLS (not owned). Report that honestly
  // instead of claiming a full success the user did not actually get.
  const skipped = itemIdsToDelete.length - outcome.deletedCount;
  if (skipped > 0) {
    return { success: `Deleted ${outcome.deletedCount} item(s); ${skipped} could not be deleted (not found, or you do not have permission).` };
  }
  // No redirect here, return success object for client-side handling
  return { success: "Selected media items deleted successfully." };
}

/** At most this many media items per usage lookup or "Delete unused" call. */
const MEDIA_USAGE_BATCH_LIMIT = 500;

const MEDIA_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The media ids of a request: uuids only, lowercased, each once. */
function normalizeMediaIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const unique = new Set<string>();
  for (const id of ids) {
    if (typeof id === "string" && MEDIA_ID_PATTERN.test(id)) unique.add(id.toLowerCase());
  }
  return [...unique];
}

/** The rows a media read returned, only those of `ids` (lowercased), with a string id. */
function rowsWithIds(
  rows: Array<{ id: unknown; object_key?: unknown; variants?: unknown }> | null,
  ids: readonly string[]
): Array<{ id: string; object_key?: unknown; variants?: unknown }> {
  const wanted = new Set(ids);
  return (rows ?? []).flatMap((row) =>
    typeof row.id === "string" && wanted.has(row.id.toLowerCase()) ? [{ ...row, id: row.id }] : []
  );
}

/** What getMediaUsage answers: each found item's usage by lowercased id, or why it could not say. */
export type MediaUsageLookupResult =
  | { usage: Record<string, MediaUsage>; error?: undefined }
  | { error: string; usage?: undefined };

/**
 * Where each of these media items is used (public.media_usage, migration 02045), for the media
 * library's delete dialogs. Staff past their second factor only (getCmsActor(): the lookup runs with
 * the service role and reads every content table, so this check is its authorization). An id with
 * no media row is left out of the answer. Anyone but an ADMIN gets it through withoutAdminOnlyLabels:
 * a place whose record their own session cannot read (a partner storefront, a redirect, an ADMIN-tier
 * setting) keeps its kind and count but loses its label, record id and parent. A failed lookup
 * answers { error }, never an empty usage.
 */
export async function getMediaUsage(mediaIds: string[]): Promise<MediaUsageLookupResult> {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: "User not authenticated." };
  }

  const actor = await getCmsActor();
  if (!actor) {
    return { error: "Complete two-factor verification, then try again." };
  }
  if (!isCmsStaffRole(actor.role)) {
    return { error: "Forbidden: Insufficient permissions." };
  }

  const ids = normalizeMediaIds(mediaIds);
  if (ids.length === 0) {
    return { usage: {} };
  }
  if (ids.length > MEDIA_USAGE_BATCH_LIMIT) {
    return { error: `Check at most ${MEDIA_USAGE_BATCH_LIMIT} files at a time.` };
  }

  const { data: rows, error: readError } = await supabase
    .from("media")
    .select("id, object_key, variants")
    .in("id", ids);
  if (readError) {
    return { error: `Where this media is used could not be checked: ${readError.message}` };
  }

  try {
    const usage = await findMediaUsage(rowsWithIds(rows, ids));
    const answer: Record<string, MediaUsage> = {};
    for (const [id, entry] of usage) {
      answer[id] = actor.role === "ADMIN" ? entry : withoutAdminOnlyLabels(entry);
    }
    return { usage: answer };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** What deleteUnusedMediaItems answers: the ids it deleted, or why it deleted nothing. */
export type DeleteUnusedMediaResult =
  | { success: string; deletedIds: string[]; error?: undefined }
  | { error: string; success?: undefined; deletedIds?: undefined };

/**
 * Deletes those of `mediaIds` that nothing uses, checked again here whatever the library showed (an
 * image may have been placed since it last looked): public.media_usage after the caller's staff
 * check, then the bulk delete's own path for the unused ones only (deleteMediaRowsAndOwnedObjects:
 * the caller's RLS, the objects a row owns, never a key another row lists). A revision-only use
 * does not keep an item (restoring that revision would show a missing image). A failed lookup
 * deletes nothing. The cleanup that 0.23.4 removed from product saves, now where someone chooses it:
 * a save path never deletes media.
 */
export async function deleteUnusedMediaItems(mediaIds: string[]): Promise<DeleteUnusedMediaResult> {
  const supabase = createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return { error: "User not authenticated." };
  }

  const refusal = await mediaStorageStaffRefusal();
  if (refusal) {
    return { error: refusal };
  }

  const ids = normalizeMediaIds(mediaIds);
  if (ids.length === 0) {
    return { error: "No items selected for deletion." };
  }
  if (ids.length > MEDIA_USAGE_BATCH_LIMIT) {
    return { error: `Delete at most ${MEDIA_USAGE_BATCH_LIMIT} files at a time.` };
  }

  const { data: rows, error: readError } = await supabase
    .from("media")
    .select("id, object_key, variants")
    .in("id", ids);
  if (readError) {
    return { error: `Nothing was deleted: the files could not be read (${readError.message}).` };
  }

  const requestedRows = rowsWithIds(rows, ids);
  let usage: Map<string, MediaUsage>;
  try {
    usage = await findMediaUsage(requestedRows);
  } catch (error) {
    return { error: `Nothing was deleted. ${error instanceof Error ? error.message : String(error)}` };
  }

  const unusedIds = requestedRows
    .map((row) => row.id)
    .filter((id) => {
      const entry = usage.get(id.toLowerCase());
      return entry !== undefined && isMediaUnused(entry);
    });
  if (unusedIds.length === 0) {
    return { error: "Nothing was deleted: every selected file is in use, or no longer exists." };
  }

  const outcome = await deleteMediaRowsAndOwnedObjects(supabase, unusedIds);
  if ("error" in outcome) {
    return { error: outcome.error };
  }

  revalidatePath("/cms/media");

  const kept = ids.length - unusedIds.length;
  const refused = unusedIds.length - outcome.deletedCount;
  const notes = [
    `Deleted ${outcome.deletedCount} unused ${outcome.deletedCount === 1 ? "file" : "files"}.`,
    kept > 0 ? `${kept} in use (or gone) ${kept === 1 ? "was" : "were"} kept.` : null,
    refused > 0 ? `${refused} could not be deleted (you do not have permission).` : null,
  ].filter((note): note is string => note !== null);
  return { success: notes.join(" "), deletedIds: outcome.deletedIds };
}


export async function moveMultipleMediaItems(
  items: Array<{ id: string; objectKey: string }>,
  destinationFolder: string
) {
  const supabase = createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return { error: "User not authenticated." };
  }

  const refusal = await mediaStorageStaffRefusal();
  if (refusal) {
    return { error: refusal };
  }

  const sanitizeFolder = (input?: string | null) => {
    const f = (input ?? '').toString().trim();
    if (!f) return 'uploads/';
    let cleaned = f.replace(/^\/+/, '');
    cleaned = cleaned.replace(/\\/g, '/');
    cleaned = cleaned.replace(/\.{2,}/g, '');
    cleaned = cleaned.replace(/[^a-zA-Z0-9_\-/]+/g, '-');
    if (cleaned && !cleaned.endsWith('/')) cleaned += '/';
    return cleaned || 'uploads/';
  };
  const folder = sanitizeFolder(destinationFolder);

  // Partner uploads (affiliates/avatars/... and affiliates/pages/...) are not media-library objects: moving into them would
  // write objects under a partner's folder (their upload caps count that listing) and, when a
  // partner's file already sits at the destination key, point this row at it.
  if (isPartnerUploadKey(folder)) {
    return { error: "Media can't be moved into the partner uploads folder." };
  }

  // Folder reorganisation uses S3 copy/list semantics that the native Supabase backend
  // doesn't replicate yet — surface a clear message instead of a generic config error.
  if (getStorageBackend() === 'supabase') {
    return { error: "Moving media between folders isn't supported on Supabase Storage yet. Delete and re-upload to relocate a file." };
  }

  const s3Client = await getS3Client();
  const R2_BUCKET_NAME = getStorageBucket();
  const R2_PUBLIC_URL_BASE = getPublicMediaBaseUrl();

  if (!R2_BUCKET_NAME) {
    return { error: "R2 Bucket not configured for move." };
  }
  if (!s3Client) {
    return { error: "R2 client is not configured for move." };
  }

  if (!items || items.length === 0) {
    return { error: "No items selected for move." };
  }

  const results: Array<{ id: string; ok: boolean; error?: string }> = [];

  for (const item of items) {
    try {
      // Claim the row with an ownership-scoped write BEFORE touching storage, and read it back.
      // A move both relocates the storage objects AND rewrites the row's keys; under RLS
      // (media_update_policy, migration 02022 §9) a non-owner WRITER matches zero rows, so moving
      // the objects first would relocate them while the row kept pointing at the old (now gone)
      // keys — a broken record the UI would report as moved. The guard update is a no-op bump that
      // returns the row only when RLS allows us to write it; a SELECT cannot tell us that because
      // media_read_policy still lets any staff member read every row.
      const { data: claimedRows, error: claimError } = await supabase
        .from("media")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", item.id)
        .select("id, object_key, file_type, variants");

      if (claimError) {
        results.push({ id: item.id, ok: false, error: claimError.message });
        continue;
      }

      const mediaRow = claimedRows && claimedRows.length > 0 ? claimedRows[0] : null;
      if (!mediaRow) {
        results.push({ id: item.id, ok: false, error: 'Media not found, or you do not have permission to move it' });
        continue;
      }

      const getFilename = (key: string) => key.substring(key.lastIndexOf('/') + 1);
      let newMainKey = `${folder}${getFilename(mediaRow.object_key)}`;

      // Build list of keys to move: primary + variant keys (if any)
      type Variant = { objectKey: string; url?: string; [k: string]: any };
      const oldVariants: Variant[] = Array.isArray(mediaRow.variants) ? (mediaRow.variants as Variant[]) :
        (typeof mediaRow.variants === 'object' && mediaRow.variants !== null ? (mediaRow.variants as any) : []);

      // Move only the objects this row owns (the variants of its own upload); a listed variant
      // that names another upload's object is dropped from the row instead of moved. A source
      // key another media row still references is copied but never deleted, so moving a decoy
      // row cannot pull an object out from under the row that really owns it.
      const ownedKeys = new Set(ownedMediaStorageKeys(mediaRow));
      if (ownedKeys.size === 0) {
        // The row's object_key is not a media path (a row written over the API can name any
        // object), so it owns nothing this action may relocate.
        results.push({ id: item.id, ok: false, error: 'This media item does not point at a media file' });
        continue;
      }
      const variantMoves = (oldVariants || [])
        .filter((v) => ownedKeys.has(v.objectKey))
        .map((v) => ({
          oldKey: v.objectKey,
          newKey: `${folder}${getFilename(v.objectKey)}`,
        }));

      const objectsToMove = [
        { oldKey: mediaRow.object_key, newKey: newMainKey, isMain: true },
        ...variantMoves.map(v => ({ ...v, isMain: false })),
      ];
      const sharedKeys = await storageKeysStillInUse(objectsToMove.map((o) => o.oldKey), item.id);
      const deleteSource = async (key: string) => {
        if (sharedKeys.has(key)) return;
        await s3Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
      };

      // Copy then delete each object; tolerate missing variant keys, but main object must exist
      const movedKeys = new Set<string>();
      let mainMoved = false;
      for (const { oldKey, newKey, isMain } of objectsToMove as Array<{oldKey:string; newKey:string; isMain:boolean}>) {
        if (oldKey === newKey) continue;
        // If destination already has the object, treat as moved and try to delete source if present
        let destinationExists = false;
        try {
          await s3Client.send(new HeadObjectCommand({ Bucket: R2_BUCKET_NAME, Key: newKey }));
          destinationExists = true;
        } catch {
          destinationExists = false;
        }

        if (destinationExists) {
          movedKeys.add(oldKey);
          if (isMain) {
            mainMoved = true;
            newMainKey = newKey;
          }
          await deleteSource(oldKey).catch(() => undefined);
          continue;
        }

        const encodedSourceKey = encodeURIComponent(oldKey).replace(/%2F/g, '/');
        const copySource = `/${R2_BUCKET_NAME}/${encodedSourceKey}`; // S3/R2 expects a leading slash
        try {
          await s3Client.send(new CopyObjectCommand({ Bucket: R2_BUCKET_NAME, CopySource: copySource, Key: newKey }));
          await deleteSource(oldKey);
          movedKeys.add(oldKey);
          if (isMain) mainMoved = true;
        } catch (err: any) {
          const name = err?.name || '';
          const message = err?.message || String(err);
          if (isMain) {
            // Main object missing: attempt fallback to any existing variant
            let promoted = false;
            for (const vm of variantMoves) {
              try {
                const encVar = encodeURIComponent(vm.oldKey).replace(/%2F/g, '/');
                const srcVar = `/${R2_BUCKET_NAME}/${encVar}`;
                await s3Client.send(new CopyObjectCommand({ Bucket: R2_BUCKET_NAME, CopySource: srcVar, Key: vm.newKey }));
                await deleteSource(vm.oldKey);
                movedKeys.add(vm.oldKey);
                newMainKey = vm.newKey; // promote this variant as new main
                mainMoved = true;
                promoted = true;
                break;
              } catch {
                continue; // try next variant
              }
            }
            if (!promoted) {
              // Last-resort fallback: list objects using a base prefix derived from timestamped key
              // Keys look like: uploads/name_YYYYMMDDHHMMSS_original.avif or uploads/name_YYYYMMDD.png
              const withoutExt = mediaRow.object_key.replace(/\.[^/.]+$/, '');
              const tsMatch = withoutExt.match(/^(.*?_\d{8,14})/); // capture up to timestamp
              const basePrefix = tsMatch ? tsMatch[1] : withoutExt.replace(/_(original(?:_uploaded)?|xlarge_avif|large_avif|medium_avif|small_avif|thumbnail_avif|[a-z]+)$/i, '');
              // Ensure it ends with the underscore-delimited base, not variant label
              const prefixGuess = basePrefix;
              try {
                const listed = await s3Client.send(new ListObjectsV2Command({ Bucket: R2_BUCKET_NAME, Prefix: prefixGuess }));
                // Only objects of this row's own upload (same folder and base name) qualify.
                const rowStem = mediaKeyStem(mediaRow.object_key);
                const keys = ((listed.Contents || []).map(o => o.Key).filter(Boolean) as string[])
                  .filter((k) => rowStem !== null && mediaKeyStem(k) === rowStem);
                // Prefer common image extensions if present
                const preferred = keys.find(k => /\.(avif|png|jpe?g|webp|gif|svg)$/i.test(k)) || keys[0];
                if (preferred) {
                  const enc = encodeURIComponent(preferred).replace(/%2F/g, '/');
                  const src = `/${R2_BUCKET_NAME}/${enc}`;
                  const targetKey = `${folder}${getFilename(preferred)}`;
                  await s3Client.send(new CopyObjectCommand({ Bucket: R2_BUCKET_NAME, CopySource: src, Key: targetKey }));
                  if (!(await storageKeysStillInUse([preferred], item.id)).has(preferred)) {
                    await s3Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: preferred }));
                  }
                  movedKeys.add(preferred);
                  newMainKey = targetKey;
                  mainMoved = true;
                } else {
                  results.push({ id: item.id, ok: false, error: `Main key missing: ${oldKey} (${name}: ${message})` });
                  mainMoved = false;
                }
              } catch {
                results.push({ id: item.id, ok: false, error: `Main key missing: ${oldKey} (${name}: ${message})` });
                mainMoved = false;
              }
            }
            // Regardless, skip to next objectToMove item
            continue;
          }
          // Variant missing: tolerate and continue; we'll drop it from variants below
          // Do nothing (optionally could log)
        }
      }
      if (!mainMoved) {
        // Already pushed a result; proceed to next item
        continue;
      }

      // Update variants with new keys + urls
      const newVariants = (oldVariants || [])
        .filter((v) => movedKeys.has(v.objectKey)) // keep only variants that were successfully moved
        .map((v) => {
          const filename = getFilename(v.objectKey);
          const updatedKey = `${folder}${filename}`;
          const updated = { ...v, objectKey: updatedKey } as any;
          if (R2_PUBLIC_URL_BASE) updated.url = resolveMediaUrl(updatedKey, R2_PUBLIC_URL_BASE);
          return updated;
        });

      // Update DB
      const { error: updateError } = await supabase
        .from('media')
        .update({ object_key: newMainKey, file_path: newMainKey, folder, variants: newVariants as any })
        .eq('id', item.id);
      if (updateError) {
        results.push({ id: item.id, ok: false, error: updateError.message });
        continue;
      }

      results.push({ id: item.id, ok: true });
    } catch (err: any) {
      const msg = err?.name && err?.message ? `${err.name}: ${err.message}` : (err?.message || String(err));
      results.push({ id: item.id, ok: false, error: msg });
    }
  }

  const failed = results.filter(r => !r.ok);
  if (failed.length > 0) {
    const detail = failed.map(f => `${f.id}${f.error ? ` (${f.error})` : ''}`).join(', ');
    return { error: `Moved ${results.length - failed.length} item(s), ${failed.length} failed: ${detail}` };
  }

  revalidatePath('/cms/media');
  return { success: `Moved ${results.length} item(s) to ${folder}` };
}

export async function moveSingleMediaItem(item: { id: string; objectKey: string }, destinationFolder: string) {
  // Reuse the multiple-items logic for a single element to keep behavior aligned.
  const res = await moveMultipleMediaItems([item], destinationFolder);
  return res;
}


// Type for inserting media

export async function getMediaItems(
    page = 1,
    limit = 50 // Default to 50 items per page
  ): Promise<{ data?: Media[]; error?: string; hasMore?: boolean }> {
    const supabase = createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
        return { error: "User not authenticated." };
    }

    // Optional: Check user role if only certain roles can view all media
    // const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
    // if (!profile || !["ADMIN", "WRITER"].includes(profile.role)) {
    //     return { error: "Forbidden: Insufficient permissions." };
    // }

    const from = (page - 1) * limit;
    const to = from + limit - 1;

    const { data, error, count } = await supabase
        .from("media")
        .select("*", { count: "exact" })
        .order("created_at", { ascending: false })
        .range(from, to);

    if (error) {
        console.error("Error fetching media items:", error);
        return { error: `Failed to fetch media items: ${error.message}` };
    }

    const hasMore = count ? to < count -1 : false;

    return { data: data as Media[], hasMore };
}
