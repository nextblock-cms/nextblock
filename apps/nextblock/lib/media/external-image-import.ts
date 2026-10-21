import 'server-only';

import type { LookupFunction } from 'node:net';

import sharp from 'sharp';
import { PutObjectCommand } from '@aws-sdk/client-s3';

import { GuardedFetchError, guardedFetch } from '@nextblock-cms/cortex';
import { getServiceRoleSupabaseClient, recordMediaUploadAsActor } from '@nextblock-cms/db/server';
import { getS3Client } from '@nextblock-cms/utils/server';

import { getStorageBackend, getStorageBucket } from '../storage/provider';
import { supabaseUploadObject } from '../storage/supabase-storage';
import { resolveMediaUrl } from './resolveMediaUrl';

const MAX_IMPORT_BYTES = 15 * 1024 * 1024; // 15MB
const IMPORT_TIMEOUT_MS = 15000;
const STAFF_ROLES = ['ADMIN', 'WRITER'];

export type ImportExternalImageResult =
  | {
      success: true;
      media: {
        id: string;
        object_key: string;
        width: number;
        height: number;
        url: string;
        blur_data_url: string | null;
        alt_text: string;
      };
    }
  | { error: string };

export type ImportExternalImageInput = {
  url: string;
  altText?: string;
  fileName?: string;
};

function extensionForImage(contentType: string, sharpFormat?: string): string {
  const format = (sharpFormat || '').toLowerCase();
  const byFormat: Record<string, string> = { jpeg: 'jpg', jpg: 'jpg', png: 'png', webp: 'webp', avif: 'avif', gif: 'gif', svg: 'svg' };
  if (byFormat[format]) return byFormat[format];

  const ct = contentType.toLowerCase();
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  if (ct.includes('png')) return 'png';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('avif')) return 'avif';
  if (ct.includes('gif')) return 'gif';
  if (ct.includes('svg')) return 'svg';
  return 'jpg';
}

function slugifyFileBase(value: string): string {
  const base = (value || 'image')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'image';
}

/**
 * Download an external image (e.g. an AI-inserted stock photo) and persist it into the
 * NextBlock media library (R2 or Supabase Storage) so it becomes a permanent, optimized
 * asset the page no longer hotlinks, attributed to `actorUserId` (ADMIN/WRITER only).
 *
 * NOT a server action: the caller must already have authenticated `actorUserId` — the
 * `importExternalImageToMedia` action through the cookie session, `/api/mcp` through its
 * bearer token. Until 2026-10-21 the action itself took this id from its arguments, so a
 * cookieless POST naming an admin's id (public via `posts.author_id`) imported as that admin.
 *
 * The download goes through `guardedFetch`: every redirect hop is host-checked against a
 * pinned DNS answer before it is requested, a refused hop reports no status, and the body
 * streams under the 15 MB cap. `lookup` is a test override.
 */
export async function importExternalImageAsActor(
  input: ImportExternalImageInput & { actorUserId: string },
  options: { lookup?: LookupFunction } = {}
): Promise<ImportExternalImageResult> {
  const userId = input.actorUserId;
  const { data: profile } = await getServiceRoleSupabaseClient()
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .maybeSingle();

  if (!profile || !STAFF_ROLES.includes(profile.role)) {
    return { error: 'You do not have permission to import media.' };
  }

  let target: URL;

  try {
    target = new URL(input.url);
  } catch {
    return { error: 'That is not a valid URL.' };
  }

  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return { error: 'Only http/https image URLs can be imported.' };
  }

  // Unsplash API Guidelines require photos to stay hotlinked to their original
  // image URL — re-hosting them into our own storage is not permitted. Pexels'
  // license does allow downloading/hosting, so only Unsplash is blocked here.
  const importHost = target.hostname.toLowerCase();
  if (importHost === 'unsplash.com' || importHost.endsWith('.unsplash.com')) {
    return {
      error:
        "Unsplash requires photos to stay hotlinked, so they can't be saved into your media library. Keep it as an external image (it still displays fine), or use a Pexels photo or your own upload if you need a stored asset.",
    };
  }

  let buffer: Buffer;
  let contentType: string;

  try {
    const response = await guardedFetch(target, {
      headers: { accept: 'image/*' },
      lookup: options.lookup,
      maxBytes: MAX_IMPORT_BYTES,
      timeoutMs: IMPORT_TIMEOUT_MS,
    });

    if (response.status < 200 || response.status >= 300) {
      response.discard();
      return { error: `The image URL responded with HTTP ${response.status}.` };
    }

    contentType = String(response.headers['content-type'] ?? '');

    if (!/^image\//i.test(contentType)) {
      response.discard();
      return { error: `The URL is not an image (content-type: ${contentType || 'unknown'}).` };
    }

    buffer = Buffer.from(await response.readBody());
  } catch (error) {
    if (error instanceof GuardedFetchError) {
      if (error.reason === 'blocked') {
        return {
          error:
            error.redirects > 0
              ? 'The image URL redirected to a blocked internal address.'
              : 'Refusing to fetch a local, private, or internal address.',
        };
      }

      if (error.reason === 'too_large') {
        return { error: 'The image is too large to import (max 15MB).' };
      }

      return { error: error.message };
    }

    const aborted =
      error instanceof Error &&
      (error.name === 'AbortError' || error.name === 'TimeoutError' || /abort/i.test(error.message));
    return {
      error: aborted
        ? 'Fetching the image timed out.'
        : `Failed to fetch the image: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let width = 0;
  let height = 0;
  let blurDataUrl: string | null = null;
  let sharpFormat: string | undefined;
  const isSvg = /svg/i.test(contentType);

  if (!isSvg) {
    try {
      const metadata = await sharp(buffer).metadata();
      width = metadata.width || 0;
      height = metadata.height || 0;
      sharpFormat = metadata.format;

      const blurBuffer = await sharp(buffer).resize(16, 16, { fit: 'inside' }).webp({ quality: 40 }).toBuffer();
      blurDataUrl = `data:image/webp;base64,${blurBuffer.toString('base64')}`;
    } catch {
      // Non-fatal: proceed without dimensions/blur (e.g. an unusual format sharp can't parse).
    }
  }

  const extension = extensionForImage(contentType, sharpFormat);
  const baseName = slugifyFileBase(
    input.fileName || input.altText || target.hostname.replace(/^www\./, '').split('.')[0] || 'image'
  );
  const random = Math.random().toString(36).slice(2, 8);
  const objectKey = `uploads/${baseName}-${Date.now()}-${random}.${extension}`;
  const resolvedContentType = contentType || `image/${extension}`;

  try {
    if (getStorageBackend() === 'supabase') {
      await supabaseUploadObject(objectKey, buffer, resolvedContentType);
    } else {
      const s3Client = await getS3Client();
      const bucket = getStorageBucket();

      if (!s3Client || !bucket) {
        return { error: 'File storage is not configured on this server.' };
      }

      await s3Client.send(
        new PutObjectCommand({
          Body: buffer,
          Bucket: bucket,
          ContentType: resolvedContentType,
          Key: objectKey,
          Metadata: { 'uploader-user-id': userId },
        })
      );
    }
  } catch (error) {
    return {
      error: `Failed to upload the image to storage: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const publicUrl = resolveMediaUrl(objectKey) ?? '';
  const fileName = `${baseName}.${extension}`;
  const altText = (input.altText || baseName.replace(/-/g, ' ')).trim();
  const originalVariant = {
    fileType: resolvedContentType,
    height,
    objectKey,
    sizeBytes: buffer.byteLength,
    url: publicUrl,
    variantLabel: 'original',
    width,
  };

  const record = await recordMediaUploadAsActor(
    {
      blurDataUrl: blurDataUrl || undefined,
      description: altText || undefined,
      fileName,
      originalImageDetails: originalVariant,
      r2OriginalKey: objectKey,
      r2Variants: [originalVariant],
    },
    userId
  );

  if ('error' in record) {
    return { error: record.error };
  }

  const media = record.data;

  return {
    media: {
      alt_text: (media.description || altText || '').trim(),
      blur_data_url: media.blur_data_url ?? blurDataUrl,
      height: media.height || height,
      id: media.id,
      object_key: media.object_key,
      url: publicUrl,
      width: media.width || width,
    },
    success: true,
  };
}
