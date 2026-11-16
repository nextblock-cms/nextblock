// apps/nextblock/lib/storage/presigned-put.ts
import 'server-only';

import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * The one place the app signs a browser upload URL for S3-compatible storage (Cloudflare R2,
 * MinIO, Supabase's S3 endpoint): `/api/upload/presigned-url` (media) and `/api/media/r2-presigned`
 * (custom blocks, via lib/custom-block-r2-upload.ts). `presigned-put.test.ts` fails when any other
 * module imports the presigner.
 *
 * A presigned PUT is a bearer token for its object key until it expires. Before 2026-11-04 both
 * sites signed only `host`: `@aws-sdk/s3-request-presigner` adds `content-type` to its unsignable
 * headers itself, and no `ContentLength` was set. Whoever held the URL could PUT any size (R2 takes
 * up to 5 GB in one PUT), whatever size the request declared, and any Content-Type, so a `.png` key
 * could be served as `text/html`. Now the declared size and the normalized type are signed: the
 * storage server recomputes the signature from the request's own `Content-Length` and
 * `Content-Type` and answers 403 SignatureDoesNotMatch to any other value, or to a missing one.
 *
 * The browser must send exactly {@link PresignedPutHeaders}. It sets `Content-Length` itself from
 * the body (scripts may not), so the client checks the file's size instead
 * (lib/storage/presigned-put-client.ts).
 *
 * Supabase Storage's signed upload URLs (`createSignedUploadUrl`) bind neither: on that backend
 * the bucket's `file_size_limit` and `allowed_mime_types` (or the project's global upload limit)
 * are the only cap. docs/04 → "Upload URLs".
 */

/** The headers every presigned PUT signs besides `host`, lowercased as SigV4 lists them. */
export const PRESIGNED_PUT_SIGNED_HEADERS = ['content-length', 'content-type'] as const;

/** The headers the browser must send with the PUT, carrying exactly the signed values. */
export type PresignedPutHeaders = {
  'Content-Type': string;
  'Content-Length': string;
};

export type BoundPutRequest = {
  bucket: string;
  key: string;
  /** The normalized content type the route validated; the PUT must declare exactly this. */
  contentType: string;
  /** The byte size the request declared; the PUT must be exactly this long. */
  contentLength: number;
  /** The upload kind's limit. The route refuses a larger size first; this is the backstop. */
  maxBytes: number;
  expiresIn: number;
  /** Stored as `x-amz-meta-*`, carried in the signed query string. */
  metadata?: Record<string, string>;
};

/** The headers a browser upload must carry for a declared size and type. */
export function presignedPutHeaders(contentType: string, contentLength: number): PresignedPutHeaders {
  return { 'Content-Type': contentType, 'Content-Length': String(contentLength) };
}

/**
 * Signs a PUT for exactly `contentLength` bytes of `contentType` at `bucket/key`. Throws without a
 * declared size within `maxBytes` or a content type, and when the presigner returns a URL that does
 * not sign both headers: such a URL would accept any size, so it is never handed out.
 */
export async function presignBoundPut(
  client: S3Client,
  request: BoundPutRequest,
): Promise<{ url: string; headers: PresignedPutHeaders }> {
  const { contentLength, maxBytes } = request;
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0 || contentLength > maxBytes) {
    throw new Error(`A presigned upload needs its declared size: a positive integer up to ${maxBytes} bytes.`);
  }
  if (!request.contentType) {
    throw new Error('A presigned upload needs its content type.');
  }

  const command = new PutObjectCommand({
    Bucket: request.bucket,
    Key: request.key,
    ContentType: request.contentType,
    ContentLength: contentLength,
    Metadata: request.metadata,
  });
  const url = await getSignedUrl(client, command, {
    expiresIn: request.expiresIn,
    signableHeaders: new Set<string>(PRESIGNED_PUT_SIGNED_HEADERS),
  });

  const missing = unsignedBoundHeaders(url);
  if (missing.length > 0) {
    throw new Error(`The presigned upload URL does not sign ${missing.join(' or ')}; it is not handed out.`);
  }
  return { url, headers: presignedPutHeaders(request.contentType, contentLength) };
}

/** The bound headers a SigV4 query-signed URL leaves out of `X-Amz-SignedHeaders`. */
function unsignedBoundHeaders(url: string): string[] {
  let signed: string[] = [];
  try {
    signed = (new URL(url).searchParams.get('X-Amz-SignedHeaders') ?? '').toLowerCase().split(';');
  } catch {
    signed = [];
  }
  return PRESIGNED_PUT_SIGNED_HEADERS.filter((header) => !signed.includes(header));
}
