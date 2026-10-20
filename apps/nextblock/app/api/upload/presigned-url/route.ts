// app/api/upload/presigned-url/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@nextblock-cms/db/server"; // Server client for auth
import { getS3PresignClient } from "@nextblock-cms/utils/server";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
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

// The content-type allowlist, folder resolver, filename sanitiser, extension resolver and
// object-key traversal guard are shared with /api/upload/proxy (and /api/media/record) via
// ../../../../lib/storage/upload-policy: one policy to audit, applied identically everywhere.

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Check user role - only WRITER or ADMIN can upload
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (!profile || !["ADMIN", "WRITER"].includes(profile.role)) {
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
      // Native Supabase Storage: hand the browser a signed upload URL to PUT to directly.
      const { signedUrl } = await supabaseCreateSignedUpload(uniqueKey);
      return NextResponse.json({
        presignedUrl: signedUrl,
        objectKey: uniqueKey,
        method: "PUT",
      });
    }

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: uniqueKey,
      ContentType: contentType,
      // ACL: 'public-read', // R2 objects are private by default unless bucket is public or presigned URL for GET is used
                           // For direct PUT, ACL is not typically set this way with R2. Permissions are on bucket/token.
      Metadata: { // Optional: add any metadata
        'uploader-user-id': user.id,
      }
    });

    if (!s3Client) {
      // Unreachable: the S3 client was verified above; keeps the type narrow without an assertion.
      throw new Error('Storage client unavailable.');
    }
    const expiresIn = 300; // 5 minutes
    const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn });

    return NextResponse.json({
      presignedUrl,
      objectKey: `${uniqueKey}`, // Send back the key prefixed with bucket name
      method: "PUT",
    });

  } catch (error) {
    console.error("Error generating pre-signed URL:", error);
    return NextResponse.json({ error: "Failed to generate upload URL." }, { status: 500 });
  }
}
