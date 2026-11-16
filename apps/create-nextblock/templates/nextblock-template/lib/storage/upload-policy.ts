// apps/nextblock/lib/storage/upload-policy.ts
import 'server-only';

/**
 * Shared upload policy for the media uploader's server routes
 * (`/api/upload/proxy`, `/api/upload/presigned-url`, `/api/process-image`, `/api/media/record`).
 *
 * These helpers decide which content types the media library accepts, how a
 * client-supplied `folder` and filename are normalized into a stored object key, and
 * reject anything that reads as path traversal. They used to be copied into both upload
 * routes (with small drifts); they live here so there is one definition to audit.
 *
 * It also owns the partner-upload namespaces (`affiliates/avatars/` and `affiliates/pages/`,
 * {@link isPartnerUploadKey}): no staff path may create, record, process, move or delete an
 * object there.
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

/** The folder that holds the partner upload namespaces ({@link PARTNER_UPLOAD_NAMESPACES}). */
export const PARTNER_UPLOAD_KEY_PREFIX = 'affiliates/';

/**
 * The storage namespaces of partner uploads (Affiliates avatars and storefront images, keyed by
 * lib/affiliates/upload-keys.ts as `affiliates/{avatars|pages}/<affiliateId>/<stamp>-<nonce>.jpg`).
 * Those objects belong to a partner account, not to the media library, and the partner upload
 * route counts them against that partner's caps (lib/affiliates/uploads.ts). So no staff path
 * may touch them: {@link resolveUploadFolder} refuses them for /api/upload/proxy and
 * /api/upload/presigned-url, /api/media/r2-presigned (custom-block images) refuses such a folder
 * and never signs such a key (lib/custom-block-r2-upload.ts), /api/process-image refuses such a
 * key, /api/media/record never records one (both through {@link isAcceptableClientObjectKey}),
 * and lib/storage/media-object-keys.ts keeps the /cms/media delete and move away from them.
 * Before 2026-10-27 a WRITER could upload into `affiliates/pages/<id>/` (filling that partner's
 * upload caps) or point the image processor at a partner's object; /api/media/r2-presigned signed
 * such uploads, and a percent-encoded key (`%61ffiliates/pages/<id>/…`) still reached the image
 * processor on the Supabase backend, until 2026-11-14. partner-upload-namespaces.test.ts holds
 * every staff key builder, and the client-key predicate, to the same refusals.
 *
 * Only these two are reserved, not the whole `affiliates/` folder: an install may already keep
 * its own media there (the media library takes free-text folders), and that media keeps its
 * upload, move and delete paths. A new partner namespace must be added here (the parity test in
 * media-object-keys.test.ts fails otherwise).
 */
export const PARTNER_UPLOAD_NAMESPACES = ['affiliates/avatars/', 'affiliates/pages/'] as const;

/**
 * Percent-decoding rounds {@link isPartnerUploadKey} applies: the storage server decodes a key's
 * escapes once, and a proxy in front of it may decode them again.
 */
const PARTNER_KEY_DECODE_ROUNDS = 4;

/**
 * The characters that end a URL's path (`?` starts the query, `#` the fragment). On the native
 * Supabase backend storage-js puts a raw key into the request URL, and the URL parser cuts the path
 * at the first of them before it resolves the dot segments that follow.
 */
const URL_PATH_END = /[?#]/;

/**
 * `key` decoded until no escape is left (at most PARTNER_KEY_DECODE_ROUNDS times); null when that
 * cannot be judged: a malformed escape, one still left after the last round, or a `?` or `#` in the
 * key or in any round's result (where the path ends then depends on which hop decoded it).
 */
function decodePercentEscapes(key: string): string | null {
  let decoded = key;
  for (let round = 0; ; round += 1) {
    if (URL_PATH_END.test(decoded)) return null;
    if (!decoded.includes('%')) return decoded;
    if (round === PARTNER_KEY_DECODE_ROUNDS) return null;
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return null; // `%zz`, a bare `%`, invalid UTF-8
    }
  }
}

/** `path` with its `.` and `..` segments resolved the way a URL parser does; null when a `..` climbs above its start. */
function resolveDotSegments(path: string): string | null {
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '..') {
      if (segments.pop() === undefined) return null;
    } else if (segment !== '.') {
      segments.push(segment);
    }
  }
  return segments.join('/');
}

/** Segments the URL parser reads as `.` or `..` before anything is decoded (`%2e` is a dot, in any case). */
const URL_SINGLE_DOT = /^(?:\.|%2e)$/i;
const URL_DOUBLE_DOT = /^(?:\.|%2e){2}$/i;

/**
 * The raw key resolved the way the URL parser resolves a path, before anything is decoded: tabs and
 * newlines dropped, `\` read as `/`, leading slashes dropped, empty segments kept, and `.` and `..`
 * segments (`%2e` spellings too) resolved, so an escaped `/` or `\` never splits a segment; null
 * when a `..` climbs above the start.
 */
function resolveAsUrlPath(key: string): string | null {
  const segments: string[] = [];
  for (const segment of key.replace(/[\t\n\r]/g, '').replace(/\\/g, '/').replace(/^\/+/, '').split('/')) {
    if (URL_DOUBLE_DOT.test(segment)) {
      if (segments.pop() === undefined) return null;
    } else if (!URL_SINGLE_DOT.test(segment)) {
      segments.push(segment);
    }
  }
  return segments.join('/');
}

/** Step 3 of {@link isPartnerUploadKey}: a decoded path in the one spelling the namespaces are compared with. */
function normalizeKeyPath(decoded: string): string {
  return decoded
    .replace(/[\t\n\r]/g, '')
    .replace(/\\/g, '/')
    .replace(/^[\s/]+/, '')
    .replace(/\/{2,}/g, '/')
    .toLowerCase();
}

function inPartnerNamespace(path: string): boolean {
  return PARTNER_UPLOAD_NAMESPACES.some((namespace) => path.startsWith(namespace) || `${path}/` === namespace);
}

/** Step 4 of {@link isPartnerUploadKey}: the normalized path, as written or with its dot segments resolved. */
function countsAsPartnerPath(normalized: string): boolean {
  const resolved = resolveDotSegments(normalized);
  return resolved === null || inPartnerNamespace(normalized) || inPartnerNamespace(resolved);
}

/**
 * True for a key or folder inside one of the {@link PARTNER_UPLOAD_NAMESPACES}, or naming one
 * (`affiliates/pages`), wherever storage could put it; false for a value that is not a string. On
 * the native Supabase backend storage-js puts the raw key into the request URL: the URL parser
 * drops tabs and newlines, treats a backslash as a slash, resolves dot segments (`%2e%2e` too) and
 * ends the path at the first `?` or `#`, and the storage server then decodes the escapes. So:
 * 1. A `?` or `#` in the key, or in any round of decoding (step 2), counts. The predicate does not
 *    model where the path ends: `./affiliates/pages/<id>/x.jpg?/../../../..` reaches that partner's
 *    prefix, while its dot segments, resolved across the whole key, climb back out (until
 *    2026-11-14 that passed, and the custom-block signer signed it for a payload nobody validated).
 * 2. Percent-escapes are decoded until none is left, at most four rounds (the storage server decodes
 *    once, and a proxy in front of it may decode again): `%61ffiliates/pages/<id>/…` and
 *    `affiliates%2Fpages/<id>/…` reach a partner's prefix (until 2026-11-14 they passed, and
 *    /api/process-image read and wrote there). A malformed escape, or one still left after the last
 *    round, counts.
 * 3. Tabs, line feeds and carriage returns are dropped, backslashes become slashes, leading
 *    whitespace and slashes are dropped, repeated slashes collapse, and the path is lowercased.
 * 4. The path counts when it starts with a namespace or names one, as written or with its `.` and
 *    `..` segments resolved; a `..` that climbs above the key's start (out of the bucket) counts.
 * 5. The raw key is also read in the URL parser's order, which resolves dot segments (`%2e` spellings
 *    included) before the storage server decodes anything and keeps empty segments: an escaped `/`
 *    or `\` does not split a segment, and a `..` can pop an empty one. That path is then decoded
 *    (step 2), normalized (step 3) and judged (step 4). `affiliates//../pages/<id>/…` and
 *    `x%2fy/../affiliates/pages/<id>/…` reach a partner's prefix that way, and `a%2fb/../../x/…`
 *    leaves the bucket (until 2026-11-14 they passed, and the custom-block signer signed them for a
 *    payload nobody validated).
 * 6. Step 5 again on the key as storage-js `upload()`, `update()` and `uploadToSignedUrl()` send it:
 *    one leading and one trailing slash dropped and repeated slashes collapsed before the URL is
 *    built (`_removeEmptyFolders`; `createSignedUploadUrl()` and `download()` send the raw key).
 *    `x%2fy//../affiliates/pages/<id>/…` reaches a partner's prefix through `upload()` only, and
 *    `a%2fb//../../x/…` another bucket (security review 2026-11-15: no route hands such a key to
 *    `upload()`, since every builder and isAcceptableClientObjectKey refuse `%` and `//`).
 * It errs toward counting (case-insensitive, every `?` or `#`), and no staff key builder mints a
 * `%`, `?`, `#`, an empty segment or a dot segment (each keeps to `[A-Za-z0-9._/-]` without `//`
 * or `..`), so it never refuses a key a builder mints outside the namespaces. A key a client hands
 * back to a staff route gets {@link isAcceptableClientObjectKey}, which refuses all of them outright.
 */
export function isPartnerUploadKey(key: unknown): boolean {
  if (typeof key !== 'string') return false;
  const decoded = decodePercentEscapes(key);
  // Unjudgeable, so counted: a malformed escape, one left after the last round, or a `?` or `#`.
  if (decoded === null) return true;
  if (countsAsPartnerPath(normalizeKeyPath(decoded))) return true;
  // Step 5: the URL parser resolves dot segments on the raw key, before storage decodes anything.
  // Step 6: the same on the key storage-js upload(), update() and uploadToSignedUrl() send, whose
  // repeated slashes are collapsed first.
  for (const sent of [key, key.replace(/^\/|\/$/g, '').replace(/\/+/g, '/')]) {
    const asUrl = resolveAsUrlPath(sent);
    if (asUrl === null) return true;
    const asUrlDecoded = decodePercentEscapes(asUrl);
    if (asUrlDecoded === null || countsAsPartnerPath(normalizeKeyPath(asUrlDecoded))) return true;
  }
  return false;
}

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
 * that reads as path traversal (`.`/`..` segments, backslashes, control characters), is
 * over-long, or normalizes into a partner upload namespace (`affiliates/avatars/…` or
 * `affiliates/pages/…`, see {@link PARTNER_UPLOAD_NAMESPACES}) is refused: this returns `null`
 * and the caller rejects the request. `null` / `undefined` / an empty folder default to `uploads/`.
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
  if (!segments.length) return DEFAULT_UPLOAD_FOLDER;
  const folder = `${segments.join('/')}/`;
  // Checked after normalization, so `Affiliates!/pages` or `/affiliates//x` cannot slip past.
  return isPartnerUploadKey(folder) ? null : folder;
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

/**
 * The characters a staff key builder puts in a key: {@link resolveUploadFolder},
 * {@link sanitizeBaseFilename}, {@link resolveExtension} and the timestamp, the custom-block
 * sanitizers (lib/custom-block-r2-upload-shared.ts) and the variant suffixes /api/process-image
 * appends. partner-upload-namespaces.test.ts holds the builders to it.
 */
const MINTED_OBJECT_KEY_PATTERN = /^[A-Za-z0-9._/-]+$/;

/**
 * True for an object key a client may hand back to a staff route that reads, writes or records it
 * (/api/process-image, /api/media/record): a key a staff upload route could have minted. That is
 * {@link isSafeObjectKey}, only the builders' characters (so no `%` at all, and no `?`, `#` or
 * whitespace), an allowed media extension when `requireAllowedExtension` is set, and no partner
 * upload ({@link isPartnerUploadKey}). The character rule is the one that matters on the native
 * Supabase backend, where storage-js puts the raw key into the request URL: the storage server
 * decodes `%61ffiliates/pages/<id>/…` into a partner's prefix, the URL parser resolves `%2e%2e`
 * into another prefix or another bucket, and `?` or `#` ends the path early (the processor would
 * then overwrite the object the path names). On R2/S3 the SDK encodes the key, so it stays literal.
 */
export function isAcceptableClientObjectKey(
  key: unknown,
  { requireAllowedExtension = false }: { requireAllowedExtension?: boolean } = {},
): boolean {
  return (
    typeof key === 'string' &&
    MINTED_OBJECT_KEY_PATTERN.test(key) &&
    isSafeObjectKey(key) &&
    (!requireAllowedExtension || hasAllowedObjectKeyExtension(key)) &&
    !isPartnerUploadKey(key)
  );
}
