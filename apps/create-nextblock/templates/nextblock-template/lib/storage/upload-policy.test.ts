import { describe, expect, it } from 'vitest';
import {
  ALLOWED_UPLOAD_CONTENT_TYPES,
  ALLOWED_UPLOAD_EXTENSIONS,
  DEFAULT_UPLOAD_FOLDER,
  formatUploadTimestamp,
  hasAllowedObjectKeyExtension,
  isAcceptableClientObjectKey,
  isAllowedContentType,
  isPartnerUploadKey,
  isSafeObjectKey,
  normalizeContentType,
  resolveExtension,
  resolveUploadFolder,
  sanitizeBaseFilename,
} from './upload-policy';

const PARTNER = '0b7c5f6e-1111-4c2d-9e8f-123456789abc';

const SUPABASE_BUCKET_PATH = '/storage/v1/object/media/';

/**
 * The path a key ends up at on the native Supabase backend, offline: storage-js puts the raw key
 * into the request URL (`<project>/storage/v1/object/<bucket>/<key>`, leading slashes dropped), the
 * URL parser rewrites the path, and the storage server decodes its escapes (once per proxy that
 * decodes too, so until none is left).
 */
function supabasePathOf(key: string): string {
  return decodedBucketPath(key.replace(/^\/+/, ''));
}

/**
 * The same for storage-js `upload()`, `update()` and `uploadToSignedUrl()`, which first drop one
 * leading and one trailing slash and collapse repeated slashes (`_removeEmptyFolders` in
 * @supabase/storage-js), so a `..` can no longer pop an empty segment (security review 2026-11-15).
 */
function supabaseUploadPathOf(key: string): string {
  return decodedBucketPath(key.replace(/^\/|\/$/g, '').replace(/\/+/g, '/'));
}

function decodedBucketPath(sentKey: string): string {
  let path = new URL(`http://storage.test${SUPABASE_BUCKET_PATH}${sentKey}`).pathname;
  for (let round = 0; round < 4 && path.includes('%'); round += 1) path = decodeURIComponent(path);
  return path;
}

/** Whether a bucket path sits in a partner namespace. Storage keys are case-sensitive, so this model is too. */
function isPartnerNamespacePath(path: string): boolean {
  return ['affiliates/avatars/', 'affiliates/pages/'].some((namespace) => path.startsWith(`${SUPABASE_BUCKET_PATH}${namespace}`));
}

/** True when either call shape puts the key in a partner namespace of the bucket. */
function landsInPartnerNamespaceOnSupabase(key: string): boolean {
  return isPartnerNamespacePath(supabasePathOf(key)) || isPartnerNamespacePath(supabaseUploadPathOf(key));
}

/** True when either call shape puts the key outside the bucket. */
function leavesBucketOnSupabase(key: string): boolean {
  return !supabasePathOf(key).startsWith(SUPABASE_BUCKET_PATH) || !supabaseUploadPathOf(key).startsWith(SUPABASE_BUCKET_PATH);
}

describe('normalizeContentType', () => {
  it('strips parameters, trims and lowercases', () => {
    expect(normalizeContentType('Text/Plain; charset=utf-8')).toBe('text/plain');
    expect(normalizeContentType('  Image/JPEG  ')).toBe('image/jpeg');
  });

  it('returns "" for a non-string or absent value', () => {
    expect(normalizeContentType(undefined)).toBe('');
    expect(normalizeContentType(null)).toBe('');
    expect(normalizeContentType(123)).toBe('');
  });
});

describe('isAllowedContentType', () => {
  it('accepts media/document types the library serves', () => {
    for (const type of ['image/png', 'image/svg+xml', 'video/mp4', 'application/pdf', 'text/csv']) {
      expect(isAllowedContentType(type)).toBe(true);
    }
  });

  it('rejects executable/unknown types', () => {
    for (const type of ['text/html', 'application/javascript', 'application/zip', 'application/octet-stream', '']) {
      expect(isAllowedContentType(type)).toBe(false);
    }
  });

  it('is not fooled by inherited Object prototype keys', () => {
    expect(isAllowedContentType('constructor')).toBe(false);
    expect(isAllowedContentType('toString')).toBe(false);
  });
});

describe('resolveUploadFolder', () => {
  it('defaults null / undefined / empty to uploads/', () => {
    expect(resolveUploadFolder(null)).toBe(DEFAULT_UPLOAD_FOLDER);
    expect(resolveUploadFolder(undefined)).toBe(DEFAULT_UPLOAD_FOLDER);
    expect(resolveUploadFolder('   ')).toBe(DEFAULT_UPLOAD_FOLDER);
  });

  it('normalises odd characters and collapses slashes', () => {
    expect(resolveUploadFolder('/pages/My Slug v1.2//')).toBe('pages/My-Slug-v1-2/');
    expect(resolveUploadFolder('uploads/products')).toBe('uploads/products/');
  });

  it('returns null for a non-string', () => {
    expect(resolveUploadFolder(42)).toBeNull();
    expect(resolveUploadFolder({})).toBeNull();
  });

  it.each([
    '../../etc',
    'uploads/../private',
    './uploads',
    'uploads/..',
    'a..b/c',
    'pages\\..\\x',
    'uploads/\u0000x',
  ])('returns null for traversal %j', (folder) => {
    expect(resolveUploadFolder(folder)).toBeNull();
  });

  // The partner upload namespaces (Affiliates avatars and storefront images) are never a
  // media-library folder: uploads there would count against a partner's upload caps.
  it.each([
    'affiliates/pages',
    'affiliates/pages/0b7c5f6e-1111-4c2d-9e8f-123456789abc/',
    'Affiliates/avatars/u1',
    'AFFILIATES/PAGES',
    '/affiliates//pages',
    ' affiliates/avatars ',
    'affiliates!/pages',
  ])('returns null for the partner upload folder %j', (folder) => {
    expect(resolveUploadFolder(folder)).toBeNull();
  });

  it.each([
    ['uploads/affiliates', 'uploads/affiliates/'],
    ['affiliates-archive', 'affiliates-archive/'],
    ['affiliate/pages', 'affiliate/pages/'],
    ['pages/affiliates/', 'pages/affiliates/'],
    // The rest of affiliates/ is an ordinary media folder (an install may keep its own
    // affiliate-program assets there): only avatars/ and pages/ below it are reserved.
    ['affiliates', 'affiliates/'],
    ['affiliates/', 'affiliates/'],
    ['AFFILIATES', 'AFFILIATES/'],
    [' affiliates ', 'affiliates/'],
    ['affiliates/banners', 'affiliates/banners/'],
    ['affiliates/pages-archive', 'affiliates/pages-archive/'],
    ['affiliates/avatars2', 'affiliates/avatars2/'],
  ])('still accepts %j, which is not a partner namespace', (folder, expected) => {
    expect(resolveUploadFolder(folder)).toBe(expected);
  });

  it('returns null for an over-long folder', () => {
    expect(resolveUploadFolder('a'.repeat(201))).toBeNull();
  });
});

describe('sanitizeBaseFilename', () => {
  it('lowercases, hyphenates whitespace and drops the extension', () => {
    expect(sanitizeBaseFilename('Photo Shoot (final).PNG')).toBe('photo-shoot-final');
  });

  it('strips leading dots/hyphens and collapses interior dot runs', () => {
    expect(sanitizeBaseFilename('..image.png')).toBe('image');
    expect(sanitizeBaseFilename('a..b.png')).toBe('a.b');
  });

  it('strips path separators from a crafted name', () => {
    // mirrors the proxy "crafted filename" case: the base keeps no `/`, `\` or `..`
    expect(sanitizeBaseFilename('../../.hidden/..\\x.png')).toBe('hidden.x');
  });

  it('falls back to "file" when nothing survives, and caps the length', () => {
    expect(sanitizeBaseFilename('...')).toBe('file');
    expect(sanitizeBaseFilename('')).toBe('file');
    expect(sanitizeBaseFilename(`${'a'.repeat(200)}.png`)).toHaveLength(120);
  });
});

describe('resolveExtension', () => {
  it('keeps the declared extension when it belongs to the content type', () => {
    expect(resolveExtension('photo.jpeg', 'image/jpeg')).toBe('jpeg');
    expect(resolveExtension('photo.jpg', 'image/jpeg')).toBe('jpg');
  });

  it('forces the canonical extension when the declared one disagrees or is missing', () => {
    expect(resolveExtension('evil.html', 'image/png')).toBe('png');
    expect(resolveExtension('noext', 'image/webp')).toBe('webp');
    expect(resolveExtension('Report.PDF', 'application/pdf')).toBe('pdf');
  });
});

describe('formatUploadTimestamp', () => {
  it('produces a 14-digit YYYYMMDDHHmmss stamp', () => {
    const stamp = formatUploadTimestamp(new Date(2026, 0, 2, 3, 4, 5));
    expect(stamp).toBe('20260102030405');
    expect(stamp).toMatch(/^\d{14}$/);
  });
});

describe('isSafeObjectKey', () => {
  it('accepts a plain relative key', () => {
    expect(isSafeObjectKey('uploads/photo_20260102030405.png')).toBe(true);
    expect(isSafeObjectKey('pages/my-page/a_20260102030405.png')).toBe(true);
  });

  it.each([
    '',
    '/uploads/a.png',
    'uploads/../a.png',
    '../a.png',
    './a.png',
    'uploads//a.png',
    'uploads/.',
    'a\\b.png',
    'uploads/\u0000.png',
  ])('rejects %j', (key) => {
    expect(isSafeObjectKey(key)).toBe(false);
  });

  it('rejects an over-long key', () => {
    expect(isSafeObjectKey(`uploads/${'a'.repeat(520)}.png`)).toBe(false);
  });
});

describe('hasAllowedObjectKeyExtension', () => {
  it('accepts keys ending in an allowed extension', () => {
    expect(hasAllowedObjectKeyExtension('uploads/photo_1.png')).toBe(true);
    expect(hasAllowedObjectKeyExtension('uploads/photo_1_large.avif')).toBe(true);
    expect(hasAllowedObjectKeyExtension('uploads/doc.PDF')).toBe(true);
  });

  it('rejects dangerous, unknown or extension-less keys', () => {
    expect(hasAllowedObjectKeyExtension('uploads/evil.html')).toBe(false);
    expect(hasAllowedObjectKeyExtension('uploads/evil.js')).toBe(false);
    expect(hasAllowedObjectKeyExtension('uploads/nofile')).toBe(false);
    expect(hasAllowedObjectKeyExtension('uploads/.hidden')).toBe(false);
    expect(hasAllowedObjectKeyExtension('uploads/dir.png/file')).toBe(false);
  });
});

describe('allowlist tables', () => {
  it('derives the extension set from the content-type map', () => {
    for (const exts of Object.values(ALLOWED_UPLOAD_CONTENT_TYPES)) {
      for (const ext of exts) expect(ALLOWED_UPLOAD_EXTENSIONS.has(ext)).toBe(true);
    }
    expect(ALLOWED_UPLOAD_EXTENSIONS.has('html')).toBe(false);
  });
});

// 2026-11-14: isPartnerUploadKey never decoded `%xx`, so `%61ffiliates/pages/<id>/x.jpg` passed it,
// and on the native Supabase backend /api/process-image read that partner's object and wrote six
// variants into their prefix (their upload caps).
describe('isPartnerUploadKey judges a key by where storage could put it', () => {
  it.each([
    `%61ffiliates/pages/${PARTNER}/x.jpg`,
    `affiliates%2Fpages/${PARTNER}/x.jpg`,
    `affiliates%2fpages/${PARTNER}/x.jpg`,
    `affiliates/pages%2F${PARTNER}/x.jpg`,
    `%2561ffiliates/avatars/${PARTNER}/x.jpg`,
    `uploads/%2e%2e/affiliates/pages/${PARTNER}/x.jpg`,
    `uploads/.%2E/affiliates/avatars/${PARTNER}/x.jpg`,
    // Climbs out of the key and back into the bucket by name.
    `%2e%2e/media/affiliates/pages/${PARTNER}/x.jpg`,
    `uploads/../affiliates/pages/${PARTNER}/x.jpg`,
    `affil\tiates/pages/${PARTNER}/x.jpg`,
    `affiliates/pa\nges/${PARTNER}/x.jpg`,
    `uploads\\..\\affiliates\\pages\\${PARTNER}\\x.jpg`,
    // `?` and `#` end the URL path before the URL parser resolves the dot segments after them, while
    // the predicate resolved those across the whole key and climbed back out (2026-11-14). The first
    // key is the one the custom-block signer built from the unvalidated folder
    // `./affiliates/pages/<id>/evil.png?/../../../../`, and signed as
    // `…/upload/sign/media/affiliates/pages/<id>/evil.png`.
    `./affiliates/pages/${PARTNER}/evil.png?/../../../../a-20261114101500000-a1b2c3d4.png`,
    `./affiliates/pages/${PARTNER}/x.jpg?/../../../..`,
    `./affiliates/pages/${PARTNER}/x.jpg#/../../../..`,
    `x/../affiliates/pages/${PARTNER}/e.jpg#/../../../..`,
    `uploads/%2e%2e/affiliates/pages/${PARTNER}/e.jpg?/../../../../x.jpg`,
    // The URL parser resolves dot segments before the storage server decodes anything, and keeps
    // empty segments: a `..` pops an empty segment, or a segment holding an escaped separator, which
    // the decode-first reading had already split or collapsed (2026-11-14: these passed, and the
    // custom-block signer signed them for a payload nobody validated).
    `affiliates//../pages/${PARTNER}/x.jpg`,
    `affiliates/x//../../pages/${PARTNER}/x.jpg`,
    `x%2fy/../affiliates/pages/${PARTNER}/x.jpg`,
    `x%5cy/%2e%2e/affiliates/avatars/${PARTNER}/x.jpg`,
    `x%252fy/../affiliates/pages/${PARTNER}/x.jpg`,
    // storage-js upload() collapses `//` before the URL parser resolves the `..` (2026-11-15: these
    // passed; no route hands upload() such a key).
    `x%2fy//../affiliates/pages/${PARTNER}/x.jpg`,
    `x%5cy//%2e%2e/affiliates/avatars/${PARTNER}/x.jpg`,
    `x%252fy//.%2E/affiliates/pages/${PARTNER}/x.jpg`,
  ])('%j reaches a partner prefix on the Supabase backend, and counts', (key) => {
    expect(landsInPartnerNamespaceOnSupabase(key)).toBe(true);
    expect(isPartnerUploadKey(key)).toBe(true);
  });

  it.each([
    'uploads/a?b.png',
    'uploads/a#b.png',
    'uploads/victim.png?.png',
    'affiliates/banners/b.png#',
    // Encoded once and twice: a hop that decodes them ends the path there.
    'uploads/a%3Fb.png',
    'uploads/a%23b.png',
    'uploads/a%253Fb.png',
  ])('counts %j: a `?` or `#`, raw or at any decoding round, which no builder mints', (key) => {
    expect(isPartnerUploadKey(key)).toBe(true);
  });

  it.each([
    // Case-insensitive, like the rest of the check.
    `%41FFILIATES/AVATARS/${PARTNER}/X.JPG`,
    `%41ffiliates%2FPages/${PARTNER}`,
    // A decoded backslash is a separator too.
    `affiliates%5Cpages%5C${PARTNER}`,
    // Encoded four times: decoded in the four rounds.
    `%25252561ffiliates/pages/${PARTNER}/x.jpg`,
    'affiliates%2Fpages',
    `affiliates/pages/${PARTNER}/%2e%2e/%2e%2e/avatars/${PARTNER}/x.jpg`,
  ])('also counts %j (it only refuses more)', (key) => {
    expect(isPartnerUploadKey(key)).toBe(true);
  });

  it.each([
    'uploads/100%.png',
    'uploads/%zz.png',
    `affiliates%/pages/${PARTNER}/x.jpg`,
    // Truncated and overlong UTF-8.
    'uploads/%E0%A4%A.png',
    'uploads/%C0%AF.png',
    // `A` encoded five times: still encoded after the last round.
    'uploads/%2525252541.png',
  ])('counts %j, a key it cannot decode, as a partner upload', (key) => {
    expect(isPartnerUploadKey(key)).toBe(true);
  });

  it.each([
    '../x.png',
    'uploads/../../x.png',
    '%2e%2e/other-bucket/x.png',
    'a/%2E%2E/%2e./x.png',
    'a%2fb/../../other-bucket/x.png',
    // Through storage-js upload() only, which collapses `//` first.
    'a%2fb//../../other-bucket/x.png',
  ])(
    'counts %j, which climbs out of the bucket',
    (key) => {
      expect(isPartnerUploadKey(key)).toBe(true);
    }
  );

  // Every key built from these segments, up to three deep before each tail: the predicate counts each
  // one the Supabase model puts in a partner namespace or outside the bucket, through either call
  // shape (the raw key, or upload()'s collapsed one). This loop finds the 2026-11-14 `?`/`#` gap's
  // siblings, the URL-order gap above, and the 12 keys upload()'s collapsing reached (2026-11-15).
  it('counts every generated key the Supabase model puts in a partner namespace or outside the bucket', () => {
    const SEGMENTS = ['x', 'x%2fy', 'x%5cy', 'x%252fy', '.', '..', '%2e', '%2e%2e', '.%2E', '%2e.', '', 'affiliates', 'media'];
    const TAILS = ['affiliates/pages/u/a.jpg', 'pages/u/a.jpg', 'media/affiliates/pages/u/a.jpg', 'other/a.jpg'];
    const prefixes: string[][] = [[]];
    for (let depth = 0; depth < 3; depth += 1) {
      for (const prefix of prefixes.filter((candidate) => candidate.length === depth)) {
        for (const segment of SEGMENTS) prefixes.push([...prefix, segment]);
      }
    }
    const missed: string[] = [];
    let mustCount = 0;
    for (const prefix of prefixes) {
      for (const tail of TAILS) {
        const key = [...prefix, tail].join('/');
        if (leavesBucketOnSupabase(key) || landsInPartnerNamespaceOnSupabase(key)) {
          mustCount += 1;
          if (!isPartnerUploadKey(key)) missed.push(key);
        }
      }
    }
    expect(prefixes).toHaveLength(2380);
    // More than 4,000 of the 9,520 keys land in a namespace or leave the bucket (4,193 through the
    // raw-key calls alone).
    expect(mustCount).toBeGreaterThan(4000);
    expect(missed).toEqual([]);
  });

  it('models both call shapes: upload() alone reaches a partner prefix with a collapsed `//`', () => {
    const key = `x%2fy//../affiliates/pages/${PARTNER}/x.jpg`;
    expect(supabasePathOf(key)).toBe(`${SUPABASE_BUCKET_PATH}x/y/affiliates/pages/${PARTNER}/x.jpg`);
    expect(supabaseUploadPathOf(key)).toBe(`${SUPABASE_BUCKET_PATH}affiliates/pages/${PARTNER}/x.jpg`);
  });

  it.each([
    'uploads/my%20photo.png',
    'uploads/caf%C3%A9.png',
    'uploads/%25252541.png',
    'uploads/x/../y.png',
    'uploads/affiliates%2Fpages/x.png',
    'affiliates/banners/%62.png',
    'affiliates/pages-archive/%2e/x.png',
  ])('leaves %j alone: decoded and resolved, it stays outside the namespaces', (key) => {
    expect(isPartnerUploadKey(key)).toBe(false);
  });
});

describe('isAcceptableClientObjectKey (a key a client hands back to /api/process-image or /api/media/record)', () => {
  it.each([
    'uploads/photo_20260102030405.png',
    'uploads/photo_20260102030405_xlarge.avif',
    'Uploads/Products-2026/photo.v2_20260102030405.jpeg',
    'custom-blocks/testimonials/hero-portrait-20260528123456789-abc123.webp',
    'affiliates/banners/banner_20260102030405.png',
    'uploads/affiliates/pages/a_20260102030405.png',
  ])('accepts %j, a key the upload routes mint', (key) => {
    expect(isAcceptableClientObjectKey(key)).toBe(true);
    expect(isAcceptableClientObjectKey(key, { requireAllowedExtension: true })).toBe(true);
  });

  it.each([
    // No '%' at all, even one that decodes to a harmless key: the builders never mint one.
    'uploads/my%20photo.png',
    'uploads/%2e%2e/photo.png',
    // The URL parser resolves this into another bucket of the project.
    '%2e%2e/other-bucket/photo.png',
    `%61ffiliates/pages/${PARTNER}/x.jpg`,
    `affiliates%2Fpages/${PARTNER}/x.jpg`,
    // `?` and `#` end the URL path: the processor would read and overwrite uploads/victim.png.
    'uploads/victim.png?.png',
    'uploads/victim.png#.png',
    'uploads/my photo.png',
    'uploads/a+b.png',
    'uploads/café.png',
  ])('refuses %j, which no upload route mints', (key) => {
    expect(isAcceptableClientObjectKey(key)).toBe(false);
  });

  it('refuses a `?` because the URL storage-js builds ends its path there', () => {
    const url = new URL('http://storage.test/storage/v1/object/media/uploads/victim.png?_xlarge.avif');
    expect(url.pathname).toBe('/storage/v1/object/media/uploads/victim.png');
    expect(isAcceptableClientObjectKey('uploads/victim.png?_xlarge.avif')).toBe(false);
  });

  it.each([
    '',
    '/uploads/a.png',
    'uploads/../a.png',
    './a.png',
    'uploads//a.png',
    'uploads/',
    'a\\b.png',
    'uploads/\u0000.png',
    'uploads/\t.png',
    `uploads/${'a'.repeat(520)}.png`,
  ])('refuses the unsafe key %j', (key) => {
    expect(isAcceptableClientObjectKey(key)).toBe(false);
  });

  it.each([`affiliates/pages/${PARTNER}/x.jpg`, `Affiliates/avatars/${PARTNER}/x.jpg`, 'affiliates/pages', 'affiliates/avatars'])(
    'refuses the partner upload %j',
    (key) => {
      expect(isAcceptableClientObjectKey(key)).toBe(false);
    }
  );

  it('requires an allowed media extension only when asked', () => {
    for (const key of ['uploads/evil.html', 'uploads/nofile']) {
      expect(isAcceptableClientObjectKey(key)).toBe(true);
      expect(isAcceptableClientObjectKey(key, { requireAllowedExtension: true })).toBe(false);
    }
  });

  it('refuses a value that is not a string', () => {
    for (const value of [null, undefined, 42, {}, ['uploads/a.png']]) {
      expect(isAcceptableClientObjectKey(value)).toBe(false);
    }
  });
});
