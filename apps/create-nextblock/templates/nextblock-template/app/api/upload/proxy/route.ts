// apps/nextblock/app/api/upload/proxy/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@nextblock-cms/db/server';
import { getS3Client } from '@nextblock-cms/utils/server';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getCmsActor, isCmsStaffRole } from '../../../../lib/auth/cms-actor';
import { getStorageBackend, getStorageBucket } from '../../../../lib/storage/provider';
import { supabaseUploadObject } from '../../../../lib/storage/supabase-storage';
import {
  formatUploadTimestamp,
  isAllowedContentType,
  isSafeObjectKey,
  normalizeContentType,
  resolveExtension,
  resolveUploadFolder,
  sanitizeBaseFilename,
} from '../../../../lib/storage/upload-policy';

// Buffers the multipart body and talks to S3 / Supabase Storage with the server's credentials:
// Node only.
export const runtime = 'nodejs';

// This route is the CMS media uploader's server-side path (MediaUploadForm in the app and in
// @nextblock-cms/ecommerce). It is NOT under /cms, so neither the proxy's role gate nor the CMS
// layout's 2FA redirect sees it: every check has to live here. Only staff past their enrolled
// second factor may upload, the body is capped before it is buffered, the declared type must be a
// media/document type the library knows how to serve, and the object key is rebuilt from
// sanitized parts so a crafted filename or folder can never escape its prefix.

/** Hard cap on the request body (and therefore the file). 25 MB; Vercel's own ~4.5 MB limit still wins there. */
const UPLOAD_PROXY_MAX_BYTES = 25 * 1024 * 1024;
const UPLOAD_PROXY_MAX_MB = UPLOAD_PROXY_MAX_BYTES / (1024 * 1024);

const SECOND_FACTOR_MESSAGE = 'Complete two-factor verification, then try again.';

const UNSUPPORTED_TYPE_MESSAGE =
  'Unsupported file type. Upload an image (AVIF, GIF, JPEG, PNG, WebP, SVG, ICO, BMP), a video (MP4, WebM, OGG, MOV), a PDF, or a text/office document.';
const TOO_LARGE_MESSAGE = `File exceeds the ${UPLOAD_PROXY_MAX_MB} MB upload limit.`;

class UploadRejected extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'UploadRejected';
  }
}

/**
 * Reads the whole request body into memory, but never more than `maxBytes` of it: an honest
 * `Content-Length` above the cap is refused before a byte is read, and a chunked or lying body is
 * cut off as soon as the running total crosses the cap. Returns null when there is no body.
 */
async function readBodyWithLimit(
  request: NextRequest,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new UploadRejected(TOO_LARGE_MESSAGE, 413);
  }

  const body = request.body;
  if (!body) return null;

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new UploadRejected(TOO_LARGE_MESSAGE, 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** Parses the size-capped body as multipart/form-data. */
async function parseMultipart(request: NextRequest, body: Uint8Array<ArrayBuffer>): Promise<FormData> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw new UploadRejected('Expected a multipart/form-data upload.', 400);
  }
  try {
    return await new Response(body, { headers: { 'content-type': contentType } }).formData();
  } catch {
    throw new UploadRejected('Malformed multipart/form-data body.', 400);
  }
}

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
  // Staff only (ADMIN / WRITER), past their enrolled second factor, exactly like presigned-url,
  // r2-presigned, process-image and media/record, and before a byte of the body is read. Any
  // signed-in customer used to get through here with nothing but a session; until 2026-11-14 a
  // staff password alone (the first factor) still did.
  const actor = await getCmsActor();
  if (!actor) {
    // getCmsActor() is null without a session and while an enrolled second factor is pending. The
    // refusal stands either way; this only picks the answer.
    return (await hasSignedInUser())
      ? NextResponse.json({ error: SECOND_FACTOR_MESSAGE }, { status: 403 })
      : NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isCmsStaffRole(actor.role)) {
    return NextResponse.json({ error: 'Forbidden: Insufficient permissions' }, { status: 403 });
  }

  const backend = getStorageBackend();
  const bucket = getStorageBucket();
  if (!bucket) {
    console.error('No storage bucket is configured.');
    return NextResponse.json({ error: 'Server configuration error for file uploads.' }, { status: 500 });
  }

  try {
    // On the S3 path we need a configured client; the native Supabase path needs none.
    const s3Client = backend === 's3' ? await getS3Client() : null;
    if (backend === 's3' && !s3Client) {
      console.error('R2 client is not configured. Check your R2 environment variables.');
      return NextResponse.json({ error: 'File uploads are not configured on this server.' }, { status: 500 });
    }

    const body = await readBodyWithLimit(request, UPLOAD_PROXY_MAX_BYTES);
    if (!body || body.byteLength === 0) {
      return NextResponse.json({ error: 'No file provided.' }, { status: 400 });
    }

    const formData = await parseMultipart(request, body);
    const fileField = formData.get('file');
    const file = fileField instanceof Blob ? fileField : null;
    if (!file) {
      return NextResponse.json({ error: 'No file provided.' }, { status: 400 });
    }

    const contentType = normalizeContentType(file.type);
    if (!isAllowedContentType(contentType)) {
      return NextResponse.json({ error: UNSUPPORTED_TYPE_MESSAGE }, { status: 415 });
    }
    if (file.size === 0) {
      return NextResponse.json({ error: 'The uploaded file is empty.' }, { status: 400 });
    }
    // The body cap above already bounds this; kept so the limit is enforced on the file itself too.
    if (file.size > UPLOAD_PROXY_MAX_BYTES) {
      return NextResponse.json({ error: TOO_LARGE_MESSAGE }, { status: 413 });
    }

    const originalName = typeof (file as File).name === 'string' ? (file as File).name : '';
    const folder = resolveUploadFolder(formData.get('folder'));
    if (folder === null) {
      throw new UploadRejected('Invalid upload folder.', 400);
    }
    const baseFilename = sanitizeBaseFilename(originalName);
    const extension = resolveExtension(originalName, contentType);
    const uniqueKey = `${folder}${baseFilename}_${formatUploadTimestamp(new Date())}.${extension}`;
    if (!isSafeObjectKey(uniqueKey)) {
      throw new UploadRejected('Invalid object key.', 400);
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    if (backend === 'supabase') {
      await supabaseUploadObject(uniqueKey, buffer, contentType);
    } else if (s3Client) {
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: uniqueKey,
        Body: buffer,
        ContentType: contentType,
        ContentLength: buffer.byteLength,
        Metadata: {
          'uploader-user-id': actor.userId,
        },
      });
      await s3Client.send(command);
    } else {
      // Unreachable: the S3 client was verified before the body was read.
      throw new Error('Storage client unavailable.');
    }

    return NextResponse.json({
      objectKey: uniqueKey,
      message: 'File uploaded successfully.',
    });

  } catch (error) {
    if (error instanceof UploadRejected) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('Error proxying file upload:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred.';
    return NextResponse.json({ error: `Upload failed on server: ${errorMessage}` }, { status: 500 });
  }
}
