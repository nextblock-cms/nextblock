// apps/nextblock/lib/storage/upload-policy.ts
import 'server-only';

/**
 * Shared upload policy for the media uploader's server routes
 * (`/api/upload/proxy`, `/api/upload/presigned-url`, `/api/media/record`).
 *
 * These helpers decide which content types the media library accepts, how a
 * client-supplied `folder` and filename are normalized into a stored object key, and
 * reject anything that reads as path traversal. They used to be copied into both upload
 * routes (with small drifts); they live here so there is one definition to audit.
 *
 * Every helper is pure — it never throws and never does I/O — so each route can map a
 * rejection (`null` / `false`) to its own status and message and keep its existing
 * contract. This module is server-only: the stored key policy must never be reachable
 * from (and overridable by) client code.
 */

/** Default prefix when no folder is supplied. */
export const DEFAULT_UPLOAD_FOLDER = 'uploads/';
/** Max length of the raw folder string, before normalization. */
export const MAX_UPLOAD_FOLDER_LENGTH = 200;
/** Max length of the sanitized filename base. */
export const MAX_UPLOAD_BASENAME_LENGTH = 120;
/** Hard ceiling on a stored object key's length. */
export const MAX_OBJECT_KEY_LENGTH = 512;

/**
 * Content types the media library accepts, each with the extensions it may be stored
 * under (first = canonical). The stored extension is forced to agree with the declared
 * type, so an `evil.html` declared as `image/png` lands as `evil_<ts>.png`, never as an
 * `.html` object.
 */
export const ALLOWED_UPLOAD_CONTENT_TYPES: Record<string, readonly string[]> = {
  // images
  'image/avif': ['avif'],
  'image/gif': ['gif'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'image/svg+xml': ['svg'],
  'image/x-icon': ['ico'],
  'image/vnd.microsoft.icon': ['ico'],
  'image/bmp': ['bmp'],
  // video
  'video/mp4': ['mp4', 'm4v'],
  'video/webm': ['webm'],
  'video/ogg': ['ogv', 'ogg'],
  'video/quicktime': ['mov'],
  // pdf
  'application/pdf': ['pdf'],
  // documents
  'text/plain': ['txt'],
  'text/csv': ['csv'],
  'text/markdown': ['md', 'markdown'],
  'application/rtf': ['rtf'],
  'application/msword': ['doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/vnd.ms-excel': ['xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'application/vnd.ms-powerpoint': ['ppt'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx'],
  'application/vnd.oasis.opendocument.text': ['odt'],
  'application/vnd.oasis.opendocument.spreadsheet': ['ods'],
  'application/vnd.oasis.opendocument.presentation': ['odp'],
};

/** Every extension any allowed content type may be stored under (lowercased). */
export const ALLOWED_UPLOAD_EXTENSIONS: ReadonlySet<string> = new Set(
  Object.values(ALLOWED_UPLOAD_CONTENT_TYPES).flat(),
);

/** Declared `Content-Type` without parameters, lowercased; `''` when absent or not a string. */
export function normalizeContentType(raw: unknown): string {
  return typeof raw === 'string' ? raw.split(';')[0].trim().toLowerCase() : '';
}

/** True when the (already-normalized) content type is one the media library serves. */
export function isAllowedContentType(contentType: string): boolean {
  return Object.prototype.hasOwnProperty.call(ALLOWED_UPLOAD_CONTENT_TYPES, contentType);
}

/**
 * Normalizes the optional `folder` field into a `segment/segment/` prefix. Characters
 * outside `[A-Za-z0-9_-]` become `-` (so `pages/<slug>/` keeps working), but anything
 * that reads as path traversal (`.`/`..` segments, backslashes, control characters) or
 * is over-long is refused: this returns `null` and the caller rejects the request.
 * `null` / `undefined` / an empty folder default to `uploads/`.
 */
export function resolveUploadFolder(raw: unknown): string | null {
  if (raw === null || raw === undefined) return DEFAULT_UPLOAD_FOLDER;
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_UPLOAD_FOLDER;
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is being rejected
  if (trimmed.length > MAX_UPLOAD_FOLDER_LENGTH || /[\\\u0000-\u001f\u007f]/.test(trimmed)) {
    return null;
  }

  const segments: string[] = [];
  for (const rawSegment of trimmed.split('/')) {
    const segment = rawSegment.trim();
    if (!segment) continue; // leading / trailing / doubled slashes
    if (segment === '.' || segment === '..' || segment.includes('..')) return null;
    const cleaned = segment.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    if (cleaned) segments.push(cleaned);
  }
  return segments.length ? `${segments.join('/')}/` : DEFAULT_UPLOAD_FOLDER;
}

/**
 * Lowercased, whitespace-to-hyphen, `[\w.-]` only, collapsed interior dots, no leading
 * dots/hyphens, capped; `file` when the result is empty.
 */
export function sanitizeBaseFilename(name: string): string {
  const lastDot = name.lastIndexOf('.');
  const rawBase = lastDot > 0 ? name.slice(0, lastDot) : name;
  const base = rawBase
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w.-]+/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+/, '')
    .slice(0, MAX_UPLOAD_BASENAME_LENGTH);
  return base || 'file';
}

/**
 * The declared extension when it belongs to the content type, else the type's canonical
 * one. The caller must have confirmed the content type is allowed (`isAllowedContentType`)
 * first — otherwise there is no extension list to resolve against.
 */
export function resolveExtension(name: string, contentType: string): string {
  const allowed = ALLOWED_UPLOAD_CONTENT_TYPES[contentType];
  const lastDot = name.lastIndexOf('.');
  const declared =
    lastDot > 0 ? name.slice(lastDot + 1).toLowerCase().replace(/[^a-z0-9]+/g, '') : '';
  return declared && allowed.includes(declared) ? declared : allowed[0];
}

/** `YYYYMMDDHHmmss` in local time — the key's uniqueness suffix. */
export function formatUploadTimestamp(now: Date): string {
  const pad = (value: number) => value.toString().padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/**
 * Last line of defence: a stored object key must be a plain relative path with no
 * traversal segments, no backslashes or control characters, not absolute, and within
 * {@link MAX_OBJECT_KEY_LENGTH}.
 */
export function isSafeObjectKey(key: string): boolean {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is being rejected
  if (/[\\\u0000-\u001f\u007f]/.test(key) || key.startsWith('/') || key.length > MAX_OBJECT_KEY_LENGTH) {
    return false;
  }
  return key.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * True when the object key ends in an extension the media library serves. Keys minted by
 * the upload routes always do (the extension is forced to agree with the content type);
 * this lets routes that merely *record* a client-supplied key refuse one that points at a
 * `.html` / `.js` / extension-less object.
 */
export function hasAllowedObjectKeyExtension(key: string): boolean {
  const lastDot = key.lastIndexOf('.');
  const lastSlash = key.lastIndexOf('/');
  if (lastDot <= lastSlash + 1) return false; // no dot in the final segment, or a leading-dot name
  const ext = key.slice(lastDot + 1).toLowerCase();
  return ALLOWED_UPLOAD_EXTENSIONS.has(ext);
}
