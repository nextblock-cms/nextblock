import { describe, expect, it } from 'vitest';
import {
  ALLOWED_UPLOAD_CONTENT_TYPES,
  ALLOWED_UPLOAD_EXTENSIONS,
  DEFAULT_UPLOAD_FOLDER,
  formatUploadTimestamp,
  hasAllowedObjectKeyExtension,
  isAllowedContentType,
  isSafeObjectKey,
  normalizeContentType,
  resolveExtension,
  resolveUploadFolder,
  sanitizeBaseFilename,
} from './upload-policy';

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
