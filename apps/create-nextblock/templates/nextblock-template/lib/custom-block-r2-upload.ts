import 'server-only';

import { getS3PresignClient } from '@nextblock-cms/utils/server';

import { resolveMediaUrl } from './media/resolveMediaUrl';
import { presignBoundPut, presignedPutHeaders } from './storage/presigned-put';
import { getStorageBackend, getStorageBucket } from './storage/provider';
import { supabaseCreateSignedUpload } from './storage/supabase-storage';
import { isPartnerUploadKey } from './storage/upload-policy';
import {
  buildR2UploadObjectKey,
  R2_PRESIGNED_UPLOAD_EXPIRES_IN_SECONDS,
  R2_PRESIGNED_UPLOAD_MAX_BYTES,
  R2PresignedUploadError,
  validateR2PresignedUploadPayload as validateR2PresignedUploadShape,
  type R2PresignedUploadResult,
  type ValidR2PresignedUploadPayload,
} from './custom-block-r2-upload-shared';

export {
  buildR2UploadObjectKey,
  R2_PRESIGNED_UPLOAD_ALLOWED_CONTENT_TYPES,
  R2_PRESIGNED_UPLOAD_DEFAULT_FOLDER,
  R2_PRESIGNED_UPLOAD_EXPIRES_IN_SECONDS,
  R2_PRESIGNED_UPLOAD_MAX_BYTES,
  R2PresignedUploadError,
  sanitizeR2UploadFolder,
  type R2PresignedUploadResult,
  type ValidR2PresignedUploadPayload,
} from './custom-block-r2-upload-shared';

/** The answer to a folder inside the partner upload namespaces: the other staff upload routes' words. */
const R2_PRESIGNED_UPLOAD_PARTNER_FOLDER_MESSAGE = 'Invalid upload folder.';

/**
 * The custom-block route's validation: the shared checks (filename, type, declared size, folder
 * cleanup), then the partner upload namespaces. A folder that normalizes into `affiliates/avatars/`
 * or `affiliates/pages/` (`isPartnerUploadKey`, lib/storage/upload-policy.ts) is refused with a 400,
 * as `resolveUploadFolder` refuses it on /api/upload/proxy and /api/upload/presigned-url: those
 * objects belong to a partner account, and the partner upload route counts them against that
 * partner's caps. Until 2026-11-14 this route signed such keys, so a WRITER (or any visitor on the
 * public sandbox) could fill a partner's storefront image allowance.
 *
 * The check lives here, not in custom-block-r2-upload-shared.ts: that module stays free of
 * `server-only` so scripts/verify-milestone-2-custom-blocks.ts can import it under plain Node, and
 * its own validateR2PresignedUploadPayload checks the shape only. Routes import this one.
 */
export function validateR2PresignedUploadPayload(
  payload: Parameters<typeof validateR2PresignedUploadShape>[0]
): ValidR2PresignedUploadPayload {
  const valid = validateR2PresignedUploadShape(payload);
  if (isPartnerUploadKey(valid.folder)) {
    throw new R2PresignedUploadError(R2_PRESIGNED_UPLOAD_PARTNER_FOLDER_MESSAGE);
  }
  return valid;
}

export async function createR2PresignedUpload(
  payload: ValidR2PresignedUploadPayload,
  options: { now?: Date; nonce?: string; userId: string }
): Promise<R2PresignedUploadResult> {
  const objectKey = buildR2UploadObjectKey(payload, options);
  // Whatever the caller validated (a payload is a plain object anyone can build), no URL is signed
  // for a key inside the partner upload namespaces.
  if (isPartnerUploadKey(objectKey)) {
    throw new R2PresignedUploadError(R2_PRESIGNED_UPLOAD_PARTNER_FOLDER_MESSAGE);
  }

  const backend = getStorageBackend();
  const bucketName = getStorageBucket();
  if (!bucketName) {
    throw new R2PresignedUploadError('File uploads are not configured on this server.', 500);
  }

  const publicUrl = resolveMediaUrl(objectKey) ?? `/${objectKey}`;

  if (backend === 'supabase') {
    // Native Supabase Storage: a signed upload URL the browser PUTs to directly. It binds
    // neither the size nor the type; the bucket's file_size_limit and allowed_mime_types (or the
    // project's global upload limit) cap what it accepts (docs/04 → "Upload URLs").
    const { signedUrl } = await supabaseCreateSignedUpload(objectKey);
    return {
      expiresIn: R2_PRESIGNED_UPLOAD_EXPIRES_IN_SECONDS,
      headers: presignedPutHeaders(payload.contentType, payload.size),
      method: 'PUT',
      objectKey,
      presignedUrl: signedUrl,
      publicUrl,
      uploadUrl: signedUrl,
    };
  }

  const s3Client = await getS3PresignClient();
  if (!s3Client) {
    throw new R2PresignedUploadError('File uploads are not configured on this server.', 500);
  }

  // Signs Content-Length and Content-Type: the URL accepts exactly the declared bytes of the
  // declared type (lib/storage/presigned-put.ts).
  const { url: presignedUrl, headers } = await presignBoundPut(s3Client, {
    bucket: bucketName,
    key: objectKey,
    contentType: payload.contentType,
    contentLength: payload.size,
    maxBytes: R2_PRESIGNED_UPLOAD_MAX_BYTES,
    expiresIn: R2_PRESIGNED_UPLOAD_EXPIRES_IN_SECONDS,
    metadata: {
      'uploader-user-id': options.userId,
    },
  });

  return {
    expiresIn: R2_PRESIGNED_UPLOAD_EXPIRES_IN_SECONDS,
    headers,
    method: 'PUT',
    objectKey,
    presignedUrl,
    publicUrl,
    uploadUrl: presignedUrl,
  };
}
