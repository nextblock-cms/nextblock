import "server-only";

import { revalidatePath } from "next/cache";

import { getServiceRoleSupabaseClient } from "./supabase/server";
import type { Database } from "./supabase/types";

type Media = Database['public']['Tables']['media']['Row'];

// Define the structure for a single variant, mirroring what /api/process-image returns
export interface ImageVariant {
  objectKey: string;
  url: string;
  width: number;
  height: number;
  fileType: string;
  sizeBytes: number;
  variantLabel: string;
}

export type MediaUploadPayload = {
  fileName: string;
  description?: string;
  r2OriginalKey: string;
  r2Variants: ImageVariant[];
  originalImageDetails: ImageVariant;
  blurDataUrl?: string;
};

export type MediaRecordResult = { success: true; data: Media } | { error: string };

type MediaInsertClient = { from: (table: string) => any };

const STAFF_ROLES = ["ADMIN", "WRITER"];

/**
 * Insert the `media` row for an upload, attributed to `uploaderId`. Takes the payload's
 * known fields only. The caller has already established who `uploaderId` is: the cookie
 * session (`recordMediaUpload`) or an authenticated server route (`recordMediaUploadAsActor`).
 */
export async function insertMediaRecord(
  supabase: MediaInsertClient,
  uploaderId: string,
  payload: MediaUploadPayload
): Promise<MediaRecordResult> {
  // Determine the primary variant
  let primaryVariant =
    payload.r2Variants.find(v => v.variantLabel === 'original_avif') ||
    payload.r2Variants.find(v => v.variantLabel === 'xlarge_avif') ||
    payload.r2Variants[0] ||
    payload.originalImageDetails;

  if (!primaryVariant) {
    primaryVariant = payload.originalImageDetails || {
        objectKey: payload.r2OriginalKey,
        url: ``,
        width: 0,
        height: 0,
        fileType: 'application/octet-stream',
        sizeBytes: 0,
        variantLabel: 'fallback_original'
    };
  }

  const allVariantsToStore = [
    ...(payload.originalImageDetails && payload.originalImageDetails.objectKey !== primaryVariant.objectKey ? [payload.originalImageDetails] : []),
    ...payload.r2Variants,
  ].filter((variant, index, self) =>
    index === self.findIndex((v) => v.objectKey === variant.objectKey)
  );

  const deriveAltFromFilename = (name: string) => {
    const lastDot = name.lastIndexOf('.');
    const base = lastDot > 0 ? name.substring(0, lastDot) : name;
    const spaced = base.replace(/[-+_\\]+/g, ' ').replace(/\s+/g, ' ').trim();
    return spaced.replace(/\b\w+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1));
  };

  const computedDescription = payload.description
    ?? ((primaryVariant.fileType?.startsWith('image/') || payload.originalImageDetails?.fileType?.startsWith('image/'))
      ? deriveAltFromFilename(payload.fileName)
      : null);

  const mediaData: Omit<Media, 'id' | 'created_at' | 'updated_at'> & { uploader_id: string } = {
    uploader_id: uploaderId,
    file_name: payload.fileName,
    object_key: primaryVariant.objectKey,
    file_path: primaryVariant.objectKey,
    folder: (() => {
      const match = primaryVariant.objectKey.match(/^(.*\/)?.*$/);
      const path = match && match[1] ? match[1] : null;
      return path;
    })(),
    file_type: primaryVariant.fileType,
    size_bytes: primaryVariant.sizeBytes,
    description: computedDescription,
    width: primaryVariant.width,
    height: primaryVariant.height,
    variants: allVariantsToStore as any,
    blur_data_url: payload.blurDataUrl || null,
  };

  const { data: newMedia, error } = await supabase
    .from("media")
    .insert(mediaData)
    .select()
    .single();

  if (error) {
    console.error("Error recording media upload:", error);
    return { error: `Failed to record media: ${error.message}` };
  }

  revalidatePath("/cms/media");
  return { success: true, data: newMedia as Media };
}

/**
 * Record an upload for a server route that has no cookie session and has already
 * authenticated its caller: `/api/mcp` (bearer token) and `/api/ai/*`. Writes with the
 * service role, after re-reading the actor's role.
 *
 * Deliberately NOT a server action (no `'use server'`, and not exported from the
 * client-safe `@nextblock-cms/db` entry): until 2026-10-21 `recordMediaUpload` accepted
 * this actor id from its payload, so a cookieless POST naming an admin's id (public via
 * `posts.author_id`) recorded media as that admin.
 */
export async function recordMediaUploadAsActor(
  payload: MediaUploadPayload,
  actorUserId: string
): Promise<MediaRecordResult> {
  const supabase = getServiceRoleSupabaseClient();
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", actorUserId)
    .maybeSingle();

  if (!profile || !STAFF_ROLES.includes(profile.role)) {
    return { error: "Forbidden: Insufficient permissions to record media." };
  }

  return insertMediaRecord(supabase, actorUserId, payload);
}
