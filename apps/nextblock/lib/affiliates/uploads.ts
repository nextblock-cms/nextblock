import 'server-only';

import sharp, { type Metadata as SharpMetadata, type SharpOptions } from 'sharp';
import { DeleteObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';
import { getS3Client } from '@nextblock-cms/utils/server';

import { resolveMediaUrl } from '../media/resolveMediaUrl';
import { getStorageBackend, getStorageBucket, resolveMediaBaseUrl } from '../storage/provider';
import { supabaseRemoveObjects, supabaseUploadObject } from '../storage/supabase-storage';
import type { AffiliateUploadKind } from './upload-keys';

// The object keys live in ./upload-keys (pure, no sharp: the CMS review uses them too).
export {
  affiliateUploadPrefix,
  buildAffiliateUploadKey,
  formatAffiliateUploadTimestamp,
  isOwnAffiliateAvatarKey,
  type AffiliateUploadKind,
} from './upload-keys';

/**
 * Partner image uploads (avatar and storefront images) for `POST /api/affiliates/upload`.
 *
 * Partners are untrusted authors, so nothing they send is stored as sent:
 *   - the body is byte-capped before it is buffered (2 MB avatar, 5 MB storefront image);
 *   - only JPEG, PNG, WebP, AVIF and GIF are accepted, recognised by their magic bytes BEFORE
 *     sharp sees them (this sharp build decodes SVG, which must never reach it), then decoded
 *     by sharp with a pixel cap (50 M pixels; 12 M for AVIF, which libheif decodes at ~25 bytes
 *     per pixel) and `failOn: 'error'`, one decode at a time per process;
 *   - every image is re-encoded to a metadata-free JPEG (auto-rotated, flattened on white): a
 *     512x512 cover crop for an avatar, at most 1600 px wide (4000 px tall) for a page image;
 *   - the object key is built from the server-side affiliate id, a UTC timestamp and a random
 *     nonce, under `affiliates/avatars/<id>/` or `affiliates/pages/<id>/`, and checked with the
 *     media library's key policy (./upload-keys.ts).
 *
 * Throttles: at most 30 uploads per affiliate per hour in this process (a sliding window; on
 * serverless every warm instance keeps its own), plus a storage-backed check for page images:
 * the listing of `affiliates/pages/<id>/` caps the total at 200 and the last hour at 30 across
 * every instance. A new avatar replaces the previous one, which the route deletes unless the
 * approved storefront still shows it (`published_profile`); that one is deleted by the approval
 * that replaces it (./avatar-cleanup.ts). So at most two avatars are kept.
 */

export const AFFILIATE_UPLOAD_KINDS: readonly AffiliateUploadKind[] = ['avatar', 'image'];

export const AFFILIATE_UPLOAD_LIMITS = {
  avatarMaxBytes: 2 * 1024 * 1024,
  imageMaxBytes: 5 * 1024 * 1024,
  /** Room for the multipart framing and the `kind` field around the file. */
  multipartOverheadBytes: 64 * 1024,
  maxInputPixels: 50_000_000,
  /**
   * AVIF only (4000x3000): libheif decodes the full frame at ~18 (8-bit) to ~25 (10/12-bit) bytes
   * per pixel, so this keeps an AVIF's worst case (~0.31 GB) on par with the other formats' worst
   * case at 50 M pixels (progressive JPEG ~0.34 GB, GIF ~0.30 GB). Measured on sharp 0.35.5.
   */
  maxAvifInputPixels: 12_000_000,
  /**
   * sharp's processing timeout per decode (a capped image takes 1-2 s): decodes run one at a time
   * per process, so a stuck one must not hold every later upload on the instance.
   */
  decodeTimeoutSeconds: 30,
  uploadsPerHour: 30,
  maxPageImages: 200,
  avatarSize: 512,
  avatarQuality: 85,
  imageMaxWidth: 1600,
  /** The storefront sanitizer drops dimensions above 4000 px, so the height is capped there too. */
  imageMaxHeight: 4000,
  imageQuality: 82,
} as const;

export const AFFILIATE_UPLOAD_WINDOW_MS = 60 * 60 * 1000;

export type AffiliateUploadErrorCode =
  | 'invalid_request'
  | 'too_large'
  | 'unsupported_type'
  | 'invalid_image'
  | 'storage_unavailable'
  | 'upload_failed';

/** A refusal the route maps to its status and code; the message is never shown to anyone. */
export class AffiliateUploadError extends Error {
  readonly code: AffiliateUploadErrorCode;
  readonly status: number;

  constructor(code: AffiliateUploadErrorCode, status: number) {
    super(code);
    this.name = 'AffiliateUploadError';
    this.code = code;
    this.status = status;
  }
}

export function isAffiliateUploadKind(value: unknown): value is AffiliateUploadKind {
  return value === 'avatar' || value === 'image';
}

export function affiliateUploadMaxBytes(kind: AffiliateUploadKind): number {
  return kind === 'avatar' ? AFFILIATE_UPLOAD_LIMITS.avatarMaxBytes : AFFILIATE_UPLOAD_LIMITS.imageMaxBytes;
}

/** The largest request body the route reads: the bigger file cap plus the multipart framing. */
export const AFFILIATE_UPLOAD_MAX_BODY_BYTES =
  AFFILIATE_UPLOAD_LIMITS.imageMaxBytes + AFFILIATE_UPLOAD_LIMITS.multipartOverheadBytes;

/* ----------------------------------------------------------------- request checks --- */

function firstHeaderValue(value: string | null): string {
  return (value ?? '').split(',')[0]?.trim().toLowerCase() ?? '';
}

/**
 * Refuses a browser request sent from another site. Supabase's session cookies are
 * `SameSite=Lax` (so a cross-site POST does not carry them), and this is the second line:
 * `Sec-Fetch-Site` must be `same-origin` (or `none`) when the browser sends it, and an
 * `Origin` header must name this host. A request with neither header comes from a
 * non-browser client, which cannot hold a partner's cookies.
 */
export function isSameOriginUploadRequest(headers: Headers, requestUrl: string): boolean {
  const fetchSite = firstHeaderValue(headers.get('sec-fetch-site'));
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;

  const origin = headers.get('origin');
  if (!origin) return true;

  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }

  const hosts = new Set<string>();
  const forwarded = firstHeaderValue(headers.get('x-forwarded-host'));
  const host = firstHeaderValue(headers.get('host'));
  if (forwarded) hosts.add(forwarded);
  if (host) hosts.add(host);
  try {
    hosts.add(new URL(requestUrl).host.toLowerCase());
  } catch {
    // A malformed request URL only removes a candidate.
  }
  return hosts.has(originHost);
}

/**
 * The whole body, never more than `maxBytes`: an honest `Content-Length` above the cap is refused
 * before a byte is read, a chunked or lying body as soon as the running total crosses it (the
 * reader pattern of `app/api/upload/proxy/route.ts`). Null when there is no body.
 */
export async function readAffiliateUploadBody(
  request: Request,
  maxBytes: number = AFFILIATE_UPLOAD_MAX_BODY_BYTES,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new AffiliateUploadError('too_large', 413);
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
        throw new AffiliateUploadError('too_large', 413);
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
export async function parseAffiliateUploadForm(
  contentType: string | null,
  body: Uint8Array<ArrayBuffer>,
): Promise<FormData> {
  const type = contentType ?? '';
  if (!type.toLowerCase().startsWith('multipart/form-data')) {
    throw new AffiliateUploadError('invalid_request', 400);
  }
  try {
    return await new Response(body, { headers: { 'content-type': type } }).formData();
  } catch {
    throw new AffiliateUploadError('invalid_request', 400);
  }
}

/* ----------------------------------------------------------------- image handling --- */

export type AffiliateUploadImageFormat = 'jpeg' | 'png' | 'gif' | 'webp' | 'avif';

function ascii(bytes: Uint8Array, start: number, length: number): string {
  if (bytes.length < start + length) return '';
  let text = '';
  for (let index = start; index < start + length; index += 1) text += String.fromCharCode(bytes[index] ?? 0);
  return text;
}

/**
 * The image format named by the file's magic bytes, or null. Only the five accepted raster
 * formats are recognised; SVG (text), HEIC, TIFF, PDF and everything else return null, so they
 * are refused before any decoder runs.
 */
export function sniffAffiliateImageFormat(bytes: Uint8Array): AffiliateUploadImageFormat | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (
    bytes[0] === 0x89 &&
    ascii(bytes, 1, 3) === 'PNG' &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }
  const gif = ascii(bytes, 0, 6);
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp';
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const boxSize = ((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0);
    const end = Math.min(bytes.length, boxSize > 16 ? boxSize : 16, 64);
    // Major brand at 8, then the compatible brands after the minor version (12..15).
    for (let offset = 8; offset + 4 <= end; offset += 4) {
      if (offset === 12) continue;
      const brand = ascii(bytes, offset, 4);
      if (brand === 'avif' || brand === 'avis') return 'avif';
    }
  }
  return null;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  // Big-endian; the top byte is multiplied so values above 2^31 stay positive.
  return (bytes[offset] ?? 0) * 0x1000000 + ((bytes[offset + 1] ?? 0) << 16) + ((bytes[offset + 2] ?? 0) << 8) + (bytes[offset + 3] ?? 0);
}

/**
 * Collects the pixel count of every `ispe` (image spatial extents) property of an ISOBMFF / HEIF
 * container, descending only through `meta` (a full box), `iprp` and `ipco`. False when a box
 * size is malformed, so the caller refuses the file rather than trust part of it.
 */
function collectHeifImageExtents(bytes: Uint8Array, start: number, end: number, depth: number, out: number[]): boolean {
  let offset = start;
  while (offset + 8 <= end) {
    let size = readUint32(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) return false;
      size = readUint32(bytes, offset + 8) * 2 ** 32 + readUint32(bytes, offset + 12);
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) return false;
    const body = offset + header;
    const boxEnd = offset + size;
    if (depth < 4 && (type === 'meta' || type === 'iprp' || type === 'ipco')) {
      // `meta` is a full box: four bytes of version and flags come before its children.
      if (!collectHeifImageExtents(bytes, type === 'meta' ? body + 4 : body, boxEnd, depth + 1, out)) return false;
    } else if (type === 'ispe') {
      // Full box: version and flags, then image_width and image_height (32 bits each).
      if (body + 12 > boxEnd) return false;
      out.push(readUint32(bytes, body + 4) * readUint32(bytes, body + 8));
    }
    offset = boxEnd;
  }
  return true;
}

/**
 * The largest coded image an AVIF container declares (in pixels, from its `ispe` properties), or
 * null when none can be read. sharp reports an image's size AFTER its transformations, so a
 * clean-aperture (`clap`) crop can declare 100x100 over a 10 000 x 10 000 coded frame that libheif
 * still decodes in full; this bound is read from the container before any decoder runs
 * (2026-10-29 fix review). A grid image declares its full output size, so it is covered too.
 */
export function largestAvifCodedPixels(bytes: Uint8Array): number | null {
  const extents: number[] = [];
  if (!collectHeifImageExtents(bytes, 0, bytes.length, 0, extents) || extents.length === 0) return null;
  return Math.max(...extents);
}

/** sharp's name for each accepted format (AVIF decodes through libheif and reports `heif`). */
function sharpFormatMatches(expected: AffiliateUploadImageFormat, metadata: SharpMetadata): boolean {
  switch (expected) {
    case 'avif':
      return metadata.format === 'heif' && metadata.compression === 'av1';
    case 'jpeg':
      return metadata.format === 'jpeg';
    default:
      return metadata.format === expected;
  }
}

export interface AffiliateProcessedUpload {
  data: Buffer;
  contentType: 'image/jpeg';
  width: number;
  height: number;
}

export interface AffiliateUploadDecodeGate {
  /** Runs `task` once every task queued before it has settled; its result or failure is the caller's. */
  run<T>(task: () => Promise<T>): Promise<T>;
}

/**
 * A FIFO queue that lets one task run at a time. The pixel caps bound ONE decode; without the
 * queue, concurrent uploads on one instance multiply that (sharp's libuv pool runs four at once,
 * and `sharp.concurrency(1)` did not lower the measured peak). A queued request holds only the
 * upload it already read (a few MB), and every decode is bounded by `decodeTimeoutSeconds`.
 */
export function createAffiliateUploadDecodeGate(): AffiliateUploadDecodeGate {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const result = tail.then(() => task());
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

/** One partner decode at a time in this process. */
const processDecodeGate = createAffiliateUploadDecodeGate();

/**
 * Decode and re-encode an uploaded image. Throws `AffiliateUploadError` with
 * `unsupported_type` (not one of the five formats) or `invalid_image` (corrupt, too many
 * pixels, or a decoder error). The output never carries the input's metadata.
 */
export async function processAffiliateUploadImage(
  input: Uint8Array,
  kind: AffiliateUploadKind,
): Promise<AffiliateProcessedUpload> {
  const format = sniffAffiliateImageFormat(input);
  if (!format) throw new AffiliateUploadError('unsupported_type', 415);

  // AVIF decodes far more memory per pixel than the other formats (see maxAvifInputPixels).
  const pixelCap = format === 'avif' ? AFFILIATE_UPLOAD_LIMITS.maxAvifInputPixels : AFFILIATE_UPLOAD_LIMITS.maxInputPixels;
  if (format === 'avif') {
    const coded = largestAvifCodedPixels(input);
    if (coded === null || coded > pixelCap) throw new AffiliateUploadError('invalid_image', 422);
  }
  const buffer = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const decodeOptions: SharpOptions = {
    limitInputPixels: pixelCap,
    failOn: 'error',
    animated: false,
  };

  let metadata: SharpMetadata;
  try {
    metadata = await sharp(buffer, decodeOptions).metadata();
  } catch {
    throw new AffiliateUploadError('invalid_image', 422);
  }
  if (!sharpFormatMatches(format, metadata)) throw new AffiliateUploadError('unsupported_type', 415);
  if (!metadata.width || !metadata.height) throw new AffiliateUploadError('invalid_image', 422);
  // Checked here too, before the full-frame decode below.
  if (metadata.width * metadata.height > pixelCap) {
    throw new AffiliateUploadError('invalid_image', 422);
  }

  try {
    return await processDecodeGate.run(async () => {
      let pipeline = sharp(buffer, decodeOptions).rotate();
      pipeline =
        kind === 'avatar'
          ? pipeline.resize(AFFILIATE_UPLOAD_LIMITS.avatarSize, AFFILIATE_UPLOAD_LIMITS.avatarSize, {
              fit: 'cover',
              position: 'centre',
            })
          : pipeline.resize({
              width: AFFILIATE_UPLOAD_LIMITS.imageMaxWidth,
              height: AFFILIATE_UPLOAD_LIMITS.imageMaxHeight,
              fit: 'inside',
              withoutEnlargement: true,
            });
      const { data, info } = await pipeline
        .flatten({ background: '#ffffff' })
        .jpeg({
          quality: kind === 'avatar' ? AFFILIATE_UPLOAD_LIMITS.avatarQuality : AFFILIATE_UPLOAD_LIMITS.imageQuality,
          mozjpeg: true,
        })
        .timeout({ seconds: AFFILIATE_UPLOAD_LIMITS.decodeTimeoutSeconds })
        .toBuffer({ resolveWithObject: true });
      if (!info.width || !info.height) throw new AffiliateUploadError('invalid_image', 422);
      const processed: AffiliateProcessedUpload = { data, contentType: 'image/jpeg', width: info.width, height: info.height };
      return processed;
    });
  } catch (error) {
    if (error instanceof AffiliateUploadError) throw error;
    throw new AffiliateUploadError('invalid_image', 422);
  }
}

/* --------------------------------------------------------------------- storage --- */

type StorageTarget = { backend: 'supabase'; bucket: string } | { backend: 's3'; bucket: string; client: S3Client };

/** The public URL of a stored upload, or null when no media base URL is configured. */
export function resolveAffiliateUploadUrl(key: string): string | null {
  let base = '';
  try {
    base = resolveMediaBaseUrl();
  } catch {
    base = '';
  }
  if (!base) return null;
  return resolveMediaUrl(key, base);
}

async function storageTarget(): Promise<StorageTarget> {
  const bucket = getStorageBucket();
  if (!bucket) throw new AffiliateUploadError('storage_unavailable', 503);
  if (getStorageBackend() === 'supabase') return { backend: 'supabase', bucket };
  const client = await getS3Client();
  if (!client) throw new AffiliateUploadError('storage_unavailable', 503);
  return { backend: 's3', bucket, client };
}

/** Whether uploads can work at all here: a bucket and a public media base URL. */
export function isAffiliateUploadStorageConfigured(): boolean {
  try {
    return Boolean(getStorageBucket()) && Boolean(resolveMediaBaseUrl());
  } catch {
    return false;
  }
}

export async function putAffiliateUploadObject(key: string, body: Buffer, contentType: string): Promise<void> {
  const target = await storageTarget();
  if (target.backend === 'supabase') {
    await supabaseUploadObject(key, body, contentType);
    return;
  }
  await target.client.send(
    new PutObjectCommand({
      Bucket: target.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ContentLength: body.byteLength,
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  );
}

export async function deleteAffiliateUploadObject(key: string): Promise<void> {
  const target = await storageTarget();
  if (target.backend === 'supabase') {
    await supabaseRemoveObjects([key]);
    return;
  }
  await target.client.send(new DeleteObjectCommand({ Bucket: target.bucket, Key: key }));
}

export interface AffiliateUploadObjectCount {
  /** Objects under the prefix (at most what one listing page returns). */
  total: number;
  /** Of those, created within the last hour. */
  lastHour: number;
}

const LISTING_LIMIT = 1000;

/** Counts the objects under one affiliate's upload prefix (one listing page, enough for the caps). */
export async function countAffiliateUploadObjects(prefix: string, now: number = Date.now()): Promise<AffiliateUploadObjectCount> {
  const target = await storageTarget();
  const since = now - AFFILIATE_UPLOAD_WINDOW_MS;
  const times: Array<number | null> = [];

  if (target.backend === 'supabase') {
    const folder = prefix.replace(/\/+$/, '');
    const { data, error } = await getServiceRoleSupabaseClient()
      .storage.from(target.bucket)
      .list(folder, { limit: LISTING_LIMIT });
    if (error) throw new AffiliateUploadError('storage_unavailable', 503);
    for (const entry of data ?? []) {
      // Folders come back without an id; only files count.
      if (!entry || !entry.id) continue;
      const created = Date.parse(String(entry.created_at ?? ''));
      times.push(Number.isFinite(created) ? created : null);
    }
  } else {
    const listed = await target.client.send(
      new ListObjectsV2Command({ Bucket: target.bucket, Prefix: prefix, MaxKeys: LISTING_LIMIT }),
    );
    for (const entry of listed.Contents ?? []) {
      const modified = entry.LastModified instanceof Date ? entry.LastModified.getTime() : Number.NaN;
      times.push(Number.isFinite(modified) ? modified : null);
    }
    if (listed.IsTruncated) {
      // More than one page means far over every cap; report at least the page size.
      return { total: Math.max(times.length, LISTING_LIMIT), lastHour: times.filter((t) => t !== null && t >= since).length };
    }
  }

  return { total: times.length, lastHour: times.filter((t) => t !== null && t >= since).length };
}

/* ---------------------------------------------------------------- the throttle --- */

export interface AffiliateUploadThrottle {
  /** Records one upload for `key`; false when `key` already used its hourly allowance. */
  consume(key: string, now?: number): boolean;
  readonly size: number;
}

/**
 * A sliding-window log per affiliate, in process memory: at most `limit` uploads in any
 * `windowMs`. Bounded: beyond `maxKeys` the oldest entries are dropped.
 */
export function createAffiliateUploadThrottle(options: { limit?: number; windowMs?: number; maxKeys?: number } = {}): AffiliateUploadThrottle {
  const limit = options.limit ?? AFFILIATE_UPLOAD_LIMITS.uploadsPerHour;
  const windowMs = options.windowMs ?? AFFILIATE_UPLOAD_WINDOW_MS;
  const maxKeys = options.maxKeys ?? 5000;
  const log = new Map<string, number[]>();

  return {
    consume(key: string, now: number = Date.now()): boolean {
      const since = now - windowMs;
      const recent = (log.get(key) ?? []).filter((time) => time > since);
      if (recent.length >= limit) {
        log.set(key, recent);
        return false;
      }
      recent.push(now);
      log.delete(key);
      log.set(key, recent);
      while (log.size > maxKeys) {
        const oldest = log.keys().next().value;
        if (oldest === undefined) break;
        log.delete(oldest);
      }
      return true;
    },
    get size() {
      return log.size;
    },
  };
}

const processThrottle = createAffiliateUploadThrottle();

/** Spend one upload from this process's hourly allowance for the affiliate. */
export function consumeAffiliateUploadAllowance(affiliateId: string, now?: number): boolean {
  return processThrottle.consume(affiliateId, now);
}
