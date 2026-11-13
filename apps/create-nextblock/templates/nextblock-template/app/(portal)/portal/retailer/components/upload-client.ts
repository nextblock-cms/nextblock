import type { PortalUploadError, PortalUploadKind, PortalUploadResult } from './portal-types';

/**
 * Browser side of `POST /api/affiliates/upload`. The server re-checks everything (size, format,
 * decode); these checks only spare a pointless upload and give a precise message.
 */

export const PORTAL_UPLOAD_ACCEPT = 'image/jpeg,image/png,image/webp,image/avif,image/gif';

const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']);

export const PORTAL_UPLOAD_MAX_BYTES: Readonly<Record<PortalUploadKind, number>> = {
  avatar: 2 * 1024 * 1024,
  image: 5 * 1024 * 1024,
};

const KNOWN_ERRORS = new Set<PortalUploadError>([
  'unauthorized',
  'forbidden',
  'suspended',
  'package_inactive',
  'pending_review',
  'rate_limited',
  'image_limit',
  'too_large',
  'unsupported_type',
  'invalid_image',
  'invalid_request',
  'storage_unavailable',
  'upload_failed',
]);

/** A client-side refusal before any byte is sent, or null. */
export function checkPortalUploadFile(file: File, kind: PortalUploadKind): PortalUploadError | null {
  if (!ACCEPTED_TYPES.has(file.type)) return 'unsupported_type';
  if (file.size <= 0) return 'invalid_request';
  if (file.size > PORTAL_UPLOAD_MAX_BYTES[kind]) return 'too_large';
  return null;
}

export async function uploadPortalImage(file: File, kind: PortalUploadKind): Promise<PortalUploadResult> {
  const refused = checkPortalUploadFile(file, kind);
  if (refused) return { ok: false, error: refused };

  const form = new FormData();
  form.append('kind', kind);
  form.append('file', file);

  let response: Response;
  try {
    response = await fetch('/api/affiliates/upload', { method: 'POST', body: form, credentials: 'same-origin' });
  } catch {
    return { ok: false, error: 'network' };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  if (
    response.ok &&
    record['ok'] === true &&
    typeof record['src'] === 'string' &&
    typeof record['objectKey'] === 'string'
  ) {
    return {
      ok: true,
      src: record['src'],
      objectKey: record['objectKey'],
      width: Number(record['width']) || 0,
      height: Number(record['height']) || 0,
    };
  }
  const error = record['error'];
  return {
    ok: false,
    error: typeof error === 'string' && KNOWN_ERRORS.has(error as PortalUploadError) ? (error as PortalUploadError) : 'upload_failed',
  };
}
