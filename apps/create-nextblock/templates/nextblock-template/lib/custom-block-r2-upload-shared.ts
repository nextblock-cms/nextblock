import { randomUUID } from 'node:crypto';

export const R2_PRESIGNED_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const R2_PRESIGNED_UPLOAD_EXPIRES_IN_SECONDS = 300;
export const R2_PRESIGNED_UPLOAD_DEFAULT_FOLDER = 'custom-blocks';

export const R2_PRESIGNED_UPLOAD_ALLOWED_CONTENT_TYPES = [
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

const EXTENSION_BY_CONTENT_TYPE: Record<
  (typeof R2_PRESIGNED_UPLOAD_ALLOWED_CONTENT_TYPES)[number],
  string
> = {
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

type R2PresignedUploadPayload = {
  contentType?: unknown;
  filename?: unknown;
  folder?: unknown;
  size?: unknown;
};

export type ValidR2PresignedUploadPayload = {
  contentType: (typeof R2_PRESIGNED_UPLOAD_ALLOWED_CONTENT_TYPES)[number];
  filename: string;
  folder: string;
  size: number;
};

export type R2PresignedUploadResult = {
  expiresIn: number;
  headers: Record<string, string>;
  method: 'PUT';
  objectKey: string;
  presignedUrl: string;
  publicUrl: string;
  uploadUrl: string;
};

export class R2PresignedUploadError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = 'R2PresignedUploadError';
  }
}

function isAllowedContentType(
  contentType: string
): contentType is ValidR2PresignedUploadPayload['contentType'] {
  return R2_PRESIGNED_UPLOAD_ALLOWED_CONTENT_TYPES.includes(
    contentType as ValidR2PresignedUploadPayload['contentType']
  );
}

export function sanitizeR2UploadFolder(input?: unknown) {
  const raw = typeof input === 'string' ? input.trim() : '';
  const fallback = R2_PRESIGNED_UPLOAD_DEFAULT_FOLDER;
  const normalized = (raw || fallback).replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = normalized
    .split('/')
    .map((segment) =>
      segment
        .trim()
        .replace(/\.{2,}/g, '')
        .replace(/[^a-zA-Z0-9_.-]+/g, '-')
        .replace(/^-+|-+$/g, '')
    )
    .filter((segment) => segment && segment !== '.' && segment !== '..');

  const folder = segments.join('/') || fallback;
  return folder.endsWith('/') ? folder : `${folder}/`;
}

function sanitizeFilenameBase(filename: string) {
  const lastDotIndex = filename.lastIndexOf('.');
  const base = lastDotIndex > 0 ? filename.slice(0, lastDotIndex) : filename;
  const sanitized = base
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_.-]+/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);

  return sanitized || 'asset';
}

function getFileExtension(
  filename: string,
  contentType: ValidR2PresignedUploadPayload['contentType']
) {
  const lastDotIndex = filename.lastIndexOf('.');
  const extension = lastDotIndex > 0 ? filename.slice(lastDotIndex + 1).toLowerCase() : '';
  const normalizedExtension = extension.replace(/[^a-z0-9]+/g, '');
  const expectedExtension = EXTENSION_BY_CONTENT_TYPE[contentType];

  if (!normalizedExtension) {
    return expectedExtension;
  }

  if (['jpeg', 'jpg'].includes(normalizedExtension) && contentType === 'image/jpeg') {
    return normalizedExtension;
  }

  return normalizedExtension === expectedExtension ? normalizedExtension : expectedExtension;
}

function formatUploadTimestamp(date: Date) {
  const parts = [
    date.getUTCFullYear(),
    `${date.getUTCMonth() + 1}`.padStart(2, '0'),
    `${date.getUTCDate()}`.padStart(2, '0'),
    `${date.getUTCHours()}`.padStart(2, '0'),
    `${date.getUTCMinutes()}`.padStart(2, '0'),
    `${date.getUTCSeconds()}`.padStart(2, '0'),
    `${date.getUTCMilliseconds()}`.padStart(3, '0'),
  ];

  return parts.join('');
}

/**
 * The shape checks only: filename, content type, declared size, folder cleanup. A route must use
 * the server entry's validateR2PresignedUploadPayload (lib/custom-block-r2-upload.ts), which also
 * refuses the partner upload namespaces; that policy is server-only, and this module is not, so
 * scripts can import it under plain Node.
 */
export function validateR2PresignedUploadPayload(
  payload: R2PresignedUploadPayload
): ValidR2PresignedUploadPayload {
  const filename = typeof payload.filename === 'string' ? payload.filename.trim() : '';
  const contentType =
    typeof payload.contentType === 'string' ? payload.contentType.trim().toLowerCase() : '';
  const size =
    typeof payload.size === 'number'
      ? payload.size
      : typeof payload.size === 'string'
        ? Number(payload.size)
        : Number.NaN;

  if (!filename || filename.length > 255) {
    throw new R2PresignedUploadError('A valid filename is required.');
  }

  if (!isAllowedContentType(contentType)) {
    throw new R2PresignedUploadError('Only AVIF, GIF, JPEG, PNG, and WebP images are supported.');
  }

  if (!Number.isInteger(size) || size <= 0) {
    throw new R2PresignedUploadError('A positive file size is required.');
  }

  if (size > R2_PRESIGNED_UPLOAD_MAX_BYTES) {
    throw new R2PresignedUploadError('Image uploads are limited to 10 MB.');
  }

  return {
    contentType,
    filename,
    folder: sanitizeR2UploadFolder(payload.folder),
    size,
  };
}

export function buildR2UploadObjectKey(
  payload: ValidR2PresignedUploadPayload,
  options: { now?: Date; nonce?: string } = {}
) {
  const base = sanitizeFilenameBase(payload.filename);
  const extension = getFileExtension(payload.filename, payload.contentType);
  const timestamp = formatUploadTimestamp(options.now ?? new Date());
  const nonce = (options.nonce ?? randomUUID().slice(0, 8)).replace(/[^a-zA-Z0-9-]/g, '');

  return `${payload.folder}${base}-${timestamp}-${nonce}.${extension}`;
}
