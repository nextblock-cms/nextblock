// app/cms/media/actions.ts
"use server";

import { createClient } from "@nextblock-cms/db/server";
import { revalidatePath } from "next/cache";
import type { Database } from "@nextblock-cms/db";
import { encodedRedirect } from "@nextblock-cms/utils/server";
import { DeleteObjectCommand, DeleteObjectsCommand, CopyObjectCommand, ListObjectsV2Command, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getS3Client } from "@nextblock-cms/utils/server";
import { getStorageBackend, getStorageBucket } from "../../../lib/storage/provider";
import { supabaseRemoveObjects } from "../../../lib/storage/supabase-storage";

type Media = Database['public']['Tables']['media']['Row'];

// --- recordMediaUpload and updateMediaItem functions to be updated similarly ---



import { recordMediaUpload as sharedRecordMediaUpload } from "@nextblock-cms/db";

export async function recordMediaUpload(payload: any, returnJustData?: boolean) {
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
    encodedRedirect("success", mediaEditPath, "Media item updated successfully.");
}


export async function deleteMediaItem(mediaId: string, objectKey: string) {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return encodedRedirect("error", "/cms/media", "User not authenticated.");
    }

    const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
    if (!profile || !["ADMIN", "WRITER"].includes(profile.role)) {
        return encodedRedirect("error", "/cms/media", "Forbidden: Insufficient permissions.");
    }

    const backend = getStorageBackend();
    const bucket = getStorageBucket();
    const s3Client = backend === 's3' ? await getS3Client() : null;

    if (!bucket) {
      return encodedRedirect("error", "/cms/media", "Storage bucket not configured for deletion.");
    }
    if (backend === 's3' && !s3Client) {
      return encodedRedirect("error", "/cms/media", "R2 client is not configured for deletion.");
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
        return encodedRedirect("error", "/cms/media", `Failed to delete media record: ${dbError.message}`);
    }

    if (!deletedRows || deletedRows.length === 0) {
        // RLS removed nothing: the row either does not exist or belongs to another uploader.
        // Leave storage untouched so we never orphan an object we had no right to delete.
        return encodedRedirect("error", "/cms/media", "Media item not found or you do not have permission to delete it.");
    }

    const deletedRow = deletedRows[0];
    const keysToDelete = [deletedRow.object_key ?? objectKey];
    if (deletedRow.variants && Array.isArray(deletedRow.variants)) {
        deletedRow.variants.forEach((v: any) => {
            if (v?.objectKey) keysToDelete.push(v.objectKey);
        });
    }

    try {
        if (backend === 'supabase') {
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

    revalidatePath("/cms/media");
    encodedRedirect("success", "/cms/media", "Media item deleted successfully.");
}

export async function deleteMultipleMediaItems(items: Array<{ id: string; objectKey: string }>) {
  const supabase = createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return { error: "User not authenticated." };
  }

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!profile || !["ADMIN", "WRITER"].includes(profile.role)) {
    return { error: "Forbidden: Insufficient permissions." };
  }

  if (!items || items.length === 0) {
    return { error: "No items selected for deletion." };
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

  const itemIdsToDelete = items.map(item => item.id);

  // Delete the DB rows FIRST and read back the rows that were actually removed. RLS
  // (media_delete_policy, migration 02022 §9) silently drops rows this user does not own, so
  // deleting storage up front would destroy objects while their rows survived (orphans) and
  // still report success. We only ever remove objects for rows we were allowed to delete.
  const { data: deletedRows, error: dbDeleteError } = await supabase
    .from("media")
    .delete()
    .in("id", itemIdsToDelete)
    .select("object_key, variants");

  if (dbDeleteError) {
    console.error("Error batch deleting media records from DB:", dbDeleteError);
    return { error: `Failed to delete media records from DB: ${dbDeleteError.message}` };
  }

  if (!deletedRows || deletedRows.length === 0) {
    // Nothing was removed: the rows are missing or owned by another uploader. Touch no storage.
    return { error: "None of the selected media could be deleted (not found, or you do not have permission to delete them)." };
  }

  // Build the storage key list from the rows that were actually deleted — never from the
  // caller-supplied object keys, which could name objects for rows RLS refused to delete.
  const allKeysToDelete: string[] = [];
  deletedRows.forEach(item => {
    if (item.object_key) allKeysToDelete.push(item.object_key);
    if (item.variants && Array.isArray(item.variants)) {
      item.variants.forEach((v: any) => {
        if (v?.objectKey) allKeysToDelete.push(v.objectKey);
      });
    }
  });

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

  revalidatePath("/cms/media");

  // Some selected rows may have been left untouched by RLS (not owned). Report that honestly
  // instead of claiming a full success the user did not actually get.
  const skipped = itemIdsToDelete.length - deletedRows.length;
  if (skipped > 0) {
    return { success: `Deleted ${deletedRows.length} item(s); ${skipped} could not be deleted (not found, or you do not have permission).` };
  }
  // No redirect here, return success object for client-side handling
  return { success: "Selected media items deleted successfully." };
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

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!profile || !["ADMIN", "WRITER"].includes(profile.role)) {
    return { error: "Forbidden: Insufficient permissions." };
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

  // Folder reorganisation uses S3 copy/list semantics that the native Supabase backend
  // doesn't replicate yet — surface a clear message instead of a generic config error.
  if (getStorageBackend() === 'supabase') {
    return { error: "Moving media between folders isn't supported on Supabase Storage yet. Delete and re-upload to relocate a file." };
  }

  const s3Client = await getS3Client();
  const R2_BUCKET_NAME = getStorageBucket();
  const R2_PUBLIC_URL_BASE = process.env.NEXT_PUBLIC_R2_BASE_URL || '';

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

      const variantMoves = (oldVariants || []).map((v) => ({
        oldKey: v.objectKey,
        newKey: `${folder}${getFilename(v.objectKey)}`,
      }));

      const objectsToMove = [
        { oldKey: mediaRow.object_key, newKey: newMainKey, isMain: true },
        ...variantMoves.map(v => ({ ...v, isMain: false })),
      ];

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
          await s3Client
            .send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: oldKey }))
            .catch(() => undefined);
          continue;
        }

        const encodedSourceKey = encodeURIComponent(oldKey).replace(/%2F/g, '/');
        const copySource = `/${R2_BUCKET_NAME}/${encodedSourceKey}`; // S3/R2 expects a leading slash
        try {
          await s3Client.send(new CopyObjectCommand({ Bucket: R2_BUCKET_NAME, CopySource: copySource, Key: newKey }));
          await s3Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: oldKey }));
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
                await s3Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: vm.oldKey }));
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
                const keys = (listed.Contents || []).map(o => o.Key).filter(Boolean) as string[];
                // Prefer common image extensions if present
                const preferred = keys.find(k => /\.(avif|png|jpe?g|webp|gif|svg)$/i.test(k)) || keys[0];
                if (preferred) {
                  const enc = encodeURIComponent(preferred).replace(/%2F/g, '/');
                  const src = `/${R2_BUCKET_NAME}/${enc}`;
                  const targetKey = `${folder}${getFilename(preferred)}`;
                  await s3Client.send(new CopyObjectCommand({ Bucket: R2_BUCKET_NAME, CopySource: src, Key: targetKey }));
                  await s3Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: preferred }));
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
          if (R2_PUBLIC_URL_BASE) updated.url = `${R2_PUBLIC_URL_BASE}/${updatedKey}`;
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
