// app/api/upload/presigned-url/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@nextblock-cms/db/server"; // Server client for auth
import { getS3PresignClient } from "@nextblock-cms/utils/server";
import { getCmsActor, isCmsStaffRole } from "../../../../lib/auth/cms-actor";
import { presignBoundPut, presignedPutHeaders } from "../../../../lib/storage/presigned-put";
import { getStorageBackend, getStorageBucket } from "../../../../lib/storage/provider";
import { supabaseCreateSignedUpload } from "../../../../lib/storage/supabase-storage";
import {
  formatUploadTimestamp,
  isAllowedContentType,
  isSafeObjectKey,
  normalizeContentType,
  resolveExtension,
  resolveUploadFolder,
  sanitizeBaseFilename,
} from "../../../../lib/storage/upload-policy";

export const runtime = 'nodejs';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const PRESIGNED_URL_EXPIRES_IN_SECONDS = 300; // 5 minutes

// The content-type allowlist, folder resolver, filename sanitiser, extension resolver and
// object-key traversal guard are shared with /api/upload/proxy (and /api/media/record) via
// ../../../../lib/storage/upload-policy: one policy to audit, applied identically everywhere.
//
// The declared `size` is required and is signed into the URL with the content type
// (../../../../lib/storage/presigned-put): the browser must PUT exactly `size` bytes with the
// returned `headers`, or storage refuses it.

const SECOND_FACTOR_MESSAGE = "Complete two-factor verification, then try again.";

/** True when the request carries a signed-in user (to word a refusal; never to grant anything). */
async function hasSignedInUser(): Promise<boolean> {
  try {
    const { data: { user } } = await createClient().auth.getUser();
    return Boolean(user);
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  // Only WRITER or ADMIN can upload, past their enrolled second factor, before anything is read or
  // signed: a route handler never passes the CMS layout's 2FA redirect, and the URL this hands out
  // is a bearer token for a key in the deployment's bucket. Until 2026-11-14 the role came from a
  // cookie-client read, so a password alone (the first factor) was enough.
  const actor = await getCmsActor();
  if (!actor) {
    // getCmsActor() is null without a session and while an enrolled second factor is pending. The
    // refusal stands either way; this only picks the answer.
    return (await hasSignedInUser())
      ? NextResponse.json({ error: SECOND_FACTOR_MESSAGE }, { status: 403 })
      : NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isCmsStaffRole(actor.role)) {
    return NextResponse.json({ error: "Forbidden: Insufficient permissions" }, { status: 403 });
  }

  const backend = getStorageBackend();
  const bucket = getStorageBucket();
  if (!bucket) {
    console.error("No storage bucket is configured.");
    return NextResponse.json({ error: "Server configuration error for file uploads." }, { status: 500 });
  }

  try {
    const s3Client = backend === 's3' ? await getS3PresignClient() : null;
    if (backend === 's3' && !s3Client) {
      console.error('R2 client is not configured. Check your R2 environment variables.');
      return NextResponse.json({ error: 'File uploads are not configured on this server.' }, { status: 500 });
    }

    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = await request.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      payload = parsed as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
    }

    const filename = typeof payload.filename === 'string' ? payload.filename.trim() : '';
    const contentType = normalizeContentType(payload.contentType);
    const size =
      typeof payload.size === 'number'
        ? payload.size
        : typeof payload.size === 'string'
          ? Number(payload.size)
          : Number.NaN;

    if (!filename || !contentType || !size) {
      return NextResponse.json({ error: "Missing filename, contentType, or size" }, { status: 400 });
    }
    if (filename.length > 255) {
      return NextResponse.json({ error: "Filename is too long." }, { status: 400 });
    }
    if (!isAllowedContentType(contentType)) {
      return NextResponse.json(
        { error: "Unsupported file type. Upload an image, a video, a PDF, or a text/office document." },
        { status: 415 },
      );
    }
    if (!Number.isInteger(size) || size <= 0) {
      return NextResponse.json({ error: "A positive integer file size is required." }, { status: 400 });
    }
    if (size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: `File size exceeds limit of ${MAX_FILE_SIZE / (1024*1024)}MB.` }, { status: 400 });
    }

    const folder = resolveUploadFolder(payload.folder);
    if (!folder) {
      return NextResponse.json({ error: "Invalid upload folder." }, { status: 400 });
    }

    const timestamp = formatUploadTimestamp(new Date());

    const uniqueKey = `${folder}${sanitizeBaseFilename(filename)}_${timestamp}.${resolveExtension(filename, contentType)}`;
    if (!isSafeObjectKey(uniqueKey)) {
      return NextResponse.json({ error: "Invalid object key." }, { status: 400 });
    }

    if (backend === 'supabase') {
      // Native Supabase Storage: hand the browser a signed upload URL to PUT to directly. That
      // URL binds neither the size nor the type; the bucket's file_size_limit and
      // allowed_mime_types (or the project's global upload limit) cap what it accepts (docs/04 →
      // "Upload URLs"). The headers are the same contract as on S3.
      const { signedUrl } = await supabaseCreateSignedUpload(uniqueKey);
      return NextResponse.json({
        presignedUrl: signedUrl,
        objectKey: uniqueKey,
        method: "PUT",
        headers: presignedPutHeaders(contentType, size),
      });
    }

    if (!s3Client) {
      // Unreachable: the S3 client was verified above; keeps the type narrow without an assertion.
      throw new Error('Storage client unavailable.');
    }
    // Signs Content-Length and Content-Type: the URL accepts exactly `size` bytes of `contentType`.
    const { url: presignedUrl, headers } = await presignBoundPut(s3Client, {
      bucket,
      key: uniqueKey,
      contentType,
      contentLength: size,
      maxBytes: MAX_FILE_SIZE,
      expiresIn: PRESIGNED_URL_EXPIRES_IN_SECONDS,
      metadata: { 'uploader-user-id': actor.userId },
    });

    return NextResponse.json({
      presignedUrl,
      objectKey: uniqueKey,
      method: "PUT",
      headers,
    });

  } catch (error) {
    console.error("Error generating pre-signed URL:", error);
    return NextResponse.json({ error: "Failed to generate upload URL." }, { status: 500 });
  }
}
