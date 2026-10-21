import 'server-only';

import { resolveSupabaseUrl } from '../setup/env-status';
import { resolveSupabaseServiceKey } from '../setup/service-key';

// NextBlock has two storage backends:
//
//   's3'       — the existing S3-compatible path (Cloudflare R2, self-hosted MinIO, or
//                even Supabase Storage's S3 endpoint when you create S3 access keys).
//                Driven by the R2_* env vars + @aws-sdk/client-s3. Unchanged.
//   'supabase' — native Supabase Storage via the supabase-js client and the injected
//                service-role/secret key. NO S3 access keys required. This is what makes
//                the one-click Vercel deploy work with zero storage configuration: the
//                Marketplace integration injects the Supabase URL + secret key but NOT S3
//                keys, so the S3 path can't authenticate — the native API can.
//
// The S3 path always wins when its keys are present, so local dev, Docker/MinIO, and BYO
// Cloudflare R2 are completely unaffected. The native path is only chosen as the zero-key
// fallback for a connected Supabase project.

export type StorageBackend = 's3' | 'supabase';

/** Which storage backend to use. Explicit STORAGE_PROVIDER wins; otherwise inferred. */
export function getStorageBackend(): StorageBackend {
  const explicit = process.env.STORAGE_PROVIDER?.trim().toLowerCase();
  if (explicit === 'supabase') return 'supabase';
  if (explicit === 's3' || explicit === 'r2' || explicit === 'minio') return 's3';

  // S3/R2/MinIO wins whenever its credentials exist (local, Docker, BYO R2, or
  // Supabase-S3-with-keys). Only fall back to native Supabase Storage when there are no
  // S3 keys but a Supabase project IS connected (service key + URL) — the Vercel case.
  const hasS3Keys = Boolean(
    process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY,
  );
  if (hasS3Keys) return 's3';
  if (resolveSupabaseServiceKey() && resolveSupabaseUrl()) return 'supabase';
  return 's3';
}

/** The bucket name to read/write. Defaults to "media" on the native Supabase backend. */
export function getStorageBucket(): string {
  const explicit = process.env.STORAGE_BUCKET || process.env.R2_BUCKET_NAME;
  if (explicit) return explicit;
  return getStorageBackend() === 'supabase' ? 'media' : '';
}

/**
 * The public base URL objects are served from — what resolveMediaUrl() joins object keys
 * onto. An explicit R2 public/base URL always wins; otherwise, on the native Supabase
 * backend, derive Supabase Storage's public object endpoint
 * (`<project>/storage/v1/object/public/<bucket>`) so every display call site works with
 * zero extra config. Kept in sync with the CJS computation in next.config.js.
 */
export function resolveMediaBaseUrl(): string {
  const explicit =
    process.env.NEXT_PUBLIC_R2_BASE_URL || process.env.NEXT_PUBLIC_R2_PUBLIC_URL;
  if (explicit) return explicit.replace(/\/+$/, '');

  if (getStorageBackend() === 'supabase') {
    const url = resolveSupabaseUrl();
    const bucket = getStorageBucket();
    if (url && bucket) {
      return `${url.replace(/\/+$/, '')}/storage/v1/object/public/${bucket}`;
    }
  }
  return '';
}
