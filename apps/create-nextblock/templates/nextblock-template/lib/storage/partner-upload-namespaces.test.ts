import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * No staff path touches the partner upload namespaces (PARTNER_UPLOAD_NAMESPACES:
 * `affiliates/avatars/` and `affiliates/pages/`, where the partner upload route keeps each
 * partner's avatar and storefront images and counts them against that partner's caps). This file
 * holds every staff key builder to the same refusals, for every spelling a client could send that
 * normalizes into a namespace. The spellings are generated from the list itself, so a namespace
 * added there is covered without editing this file:
 * - resolveUploadFolder (/api/upload/proxy, /api/upload/presigned-url);
 * - the custom-block route's validateR2PresignedUploadPayload (/api/media/r2-presigned), and the
 *   signer behind it, createR2PresignedUpload, for a payload nobody validated;
 * - isAcceptableClientObjectKey, the policy for a key a client hands back to a staff route
 *   (/api/process-image, /api/media/record).
 * Until 2026-11-14 the custom-block path signed such keys: a WRITER, or any visitor on the public
 * sandbox, could fill a partner's storefront image allowance. The same day the percent-encoded
 * spellings were found: no builder keeps a '%', but on the native Supabase backend storage-js puts
 * a raw key into the request URL and the storage server decodes it, so /api/process-image read
 * `%61ffiliates/pages/<id>/…` and wrote six variants into that partner's prefix. Then the
 * path-ending spellings: the URL parser ends that path at a '?' or '#' before it resolves the dot
 * segments after it, while the shared predicate resolved them across the whole key, so the signer,
 * handed `./affiliates/pages/<id>/x.jpg?/../../../..` unvalidated, signed an upload into that
 * prefix on the Supabase backend. Ordinary folders, the rest of `affiliates/` included, stay open on
 * every builder, and every key a builder mints is one the client-key predicate takes back.
 */

const mocks = vi.hoisted(() => ({
  getS3PresignClient: vi.fn(),
  supabaseCreateSignedUpload: vi.fn(),
}));

vi.mock('@nextblock-cms/utils/server', () => ({ getS3PresignClient: mocks.getS3PresignClient }));
vi.mock('./supabase-storage', () => ({ supabaseCreateSignedUpload: mocks.supabaseCreateSignedUpload }));

import {
  buildR2UploadObjectKey,
  createR2PresignedUpload,
  R2_PRESIGNED_UPLOAD_ALLOWED_CONTENT_TYPES,
  R2PresignedUploadError,
  sanitizeR2UploadFolder,
  validateR2PresignedUploadPayload,
  type ValidR2PresignedUploadPayload,
} from '../custom-block-r2-upload';
import {
  ALLOWED_UPLOAD_CONTENT_TYPES,
  formatUploadTimestamp,
  isAcceptableClientObjectKey,
  isPartnerUploadKey,
  PARTNER_UPLOAD_NAMESPACES,
  resolveExtension,
  resolveUploadFolder,
  sanitizeBaseFilename,
} from './upload-policy';

const UUID = '0b7c5f6e-1111-4c2d-9e8f-123456789abc';

/** The `%XX` escape of one character, the form the storage server decodes. */
function escapeOf(character: string): string {
  return `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
}

/**
 * Every spelling of a namespace folder a client could send: case, slashes, whitespace, punctuation
 * the builders clean, dot segments, percent-escapes storage decodes, and a '?' or '#' that ends the
 * URL path early.
 */
function spellingsOf(namespace: string): string[] {
  const bare = namespace.replace(/\/+$/, '');
  const slash = bare.indexOf('/');
  const root = bare.slice(0, slash);
  const leaf = bare.slice(slash + 1);
  const first = escapeOf(root.charAt(0));
  return [
    namespace,
    bare,
    `${namespace}${UUID}`,
    `${namespace}${UUID}/`,
    `${root.charAt(0).toUpperCase()}${root.slice(1)}/${leaf}/x`,
    bare.toUpperCase(),
    `/${root}//${leaf}/abc/`,
    `//${bare}`,
    `  ${bare}  `,
    `${root}!/${leaf}`,
    `${root}/./${leaf}/${UUID}`,
    `${root}\\${leaf}\\${UUID}`,
    // Percent-encoded: `%61ffiliates/pages/…`, `affiliates%2Fpages/…`, `affiliates/pages%2F…`,
    // double-encoded `%2561ffiliates/…` (a proxy in front of storage may decode again), and
    // `%41FFILIATES/PAGES/…`.
    `${first}${root.slice(1)}/${leaf}/${UUID}`,
    `${root}%2F${leaf}/${UUID}`,
    `${root}/${leaf}%2F${UUID}`,
    `%25${first.slice(1)}${root.slice(1)}/${leaf}/${UUID}`,
    `${escapeOf(root.charAt(0).toUpperCase())}${root.slice(1).toUpperCase()}/${leaf.toUpperCase()}/${UUID}`,
    // Path-ending: the URL parser cuts the path at '?' or '#' and resolves only the dot segments
    // before it (`%2e%2e` included), so these land in the namespace, while the dot segments after
    // it, resolved across the whole key, climb back out.
    `./${namespace}${UUID}/x.jpg?/../../../..`,
    `./${namespace}${UUID}/x.jpg#/../../../..`,
    `uploads/%2e%2e/${namespace}${UUID}/x.jpg?/%2e%2e/%2e%2e/%2e%2e/%2e%2e`,
  ];
}

const PARTNER_SPELLINGS = PARTNER_UPLOAD_NAMESPACES.flatMap(spellingsOf);
/** The spellings storage itself decodes into a namespace: every builder strips their '%'. */
const ENCODED_SPELLINGS = PARTNER_SPELLINGS.filter((spelling) => spelling.includes('%'));
/** The spellings a builder's own cleanup would turn into a namespace: every builder refuses them. */
const CLEANED_SPELLINGS = PARTNER_SPELLINGS.filter((spelling) => !spelling.includes('%'));
/** The spellings whose URL path ends at a '?' or '#' (storage-js puts a raw key into the URL): every builder strips both. */
const PATH_ENDING_SPELLINGS = PARTNER_SPELLINGS.filter((spelling) => /[?#]/.test(spelling));

/** Folders next to the namespaces that are ordinary media, so every builder must keep them open. */
const ORDINARY_FOLDERS = [
  'affiliates',
  'affiliates/banners',
  'uploads/affiliates/pages',
  'affiliates/pages-archive',
  'affiliates-pages',
  'affiliates/avatarsx/1',
  'custom-blocks/testimonials',
];

const UPLOAD = { contentType: 'image/png', filename: 'hero.png', size: 1024 } as const;

/** A path decoded the way the storage server decodes it, again for each proxy that decodes too. */
function decodedByStorage(path: string): string {
  let decoded = path;
  for (let round = 0; round < 4 && decoded.includes('%'); round += 1) decoded = decodeURIComponent(decoded);
  return decoded;
}

/**
 * Where a raw key lands on the native Supabase backend, offline: storage-js puts it into the request
 * URL, the URL parser rewrites the path (dot segments, `%2e%2e` included; '?' and '#' end it), and the
 * storage server decodes what is left. True when that path sits in a partner namespace of the bucket.
 */
function landsInNamespaceOnSupabase(key: string): boolean {
  const bucketPath = '/storage/v1/object/media/';
  const path = decodedByStorage(new URL(`http://storage.test${bucketPath}${key.replace(/^\/+/, '')}`).pathname);
  return PARTNER_UPLOAD_NAMESPACES.some((namespace) => path.startsWith(`${bucketPath}${namespace}`));
}

/** A builder's answer to an encoded spelling: a refusal, or a folder with no escape left, outside every namespace. */
function isRefusedOrLiteral(folder: string | null): boolean {
  return folder === null || (!folder.includes('%') && !isPartnerUploadKey(folder));
}

function validationError(folder: string): unknown {
  try {
    validateR2PresignedUploadPayload({ ...UPLOAD, folder });
  } catch (error) {
    return error;
  }
  return null;
}

beforeEach(() => {
  vi.stubEnv('R2_BUCKET_NAME', 'media');
  vi.stubEnv('NEXT_PUBLIC_R2_BASE_URL', 'https://cdn.example.test');
  mocks.getS3PresignClient.mockReset();
  mocks.supabaseCreateSignedUpload.mockReset().mockImplementation(async (key: string) => ({
    signedUrl: `https://project.supabase.co/storage/v1/object/upload/sign/media/${key}?token=t`,
    token: 't',
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('every staff key builder refuses the partner upload namespaces', () => {
  it('generates spellings that really name a namespace once normalized', () => {
    expect(PARTNER_SPELLINGS.length).toBe(PARTNER_UPLOAD_NAMESPACES.length * 20);
    expect(ENCODED_SPELLINGS.length).toBe(PARTNER_UPLOAD_NAMESPACES.length * 6);
    expect(PATH_ENDING_SPELLINGS.length).toBe(PARTNER_UPLOAD_NAMESPACES.length * 3);
    for (const folder of PARTNER_SPELLINGS) {
      if (PATH_ENDING_SPELLINGS.includes(folder)) {
        // Storage's own reading of the raw folder: the URL path ends at the '?' or '#'.
        expect(landsInNamespaceOnSupabase(folder), folder).toBe(true);
      } else {
        // Storage's percent-decoding (a no-op without an escape), then the builders' own cleanup.
        expect(isPartnerUploadKey(sanitizeR2UploadFolder(decodedByStorage(folder))), folder).toBe(true);
      }
    }
    // The shared predicate needs neither step for the encoded and path-ending spellings: it decodes
    // the escapes itself, and counts every '?' or '#'.
    for (const folder of [...ENCODED_SPELLINGS, ...PATH_ENDING_SPELLINGS]) {
      expect(isPartnerUploadKey(folder), folder).toBe(true);
    }
  });

  it.each(CLEANED_SPELLINGS)('resolveUploadFolder (/api/upload/proxy, /api/upload/presigned-url) refuses %j', (folder) => {
    expect(resolveUploadFolder(folder)).toBeNull();
  });

  it.each(ENCODED_SPELLINGS)(
    'resolveUploadFolder (/api/upload/proxy, /api/upload/presigned-url) keeps no escape of %j, so it never mints a namespace key',
    (folder) => {
      expect(isRefusedOrLiteral(resolveUploadFolder(folder))).toBe(true);
    }
  );

  it.each(CLEANED_SPELLINGS)('the custom-block validation (/api/media/r2-presigned) refuses %j with a 400', (folder) => {
    const error = validationError(folder);
    expect(error).toBeInstanceOf(R2PresignedUploadError);
    expect(error).toMatchObject({ status: 400, message: 'Invalid upload folder.' });
  });

  it.each(ENCODED_SPELLINGS)(
    'the custom-block validation (/api/media/r2-presigned) keeps no escape of %j either',
    (folder) => {
      let validated: string | null = null;
      try {
        validated = validateR2PresignedUploadPayload({ ...UPLOAD, folder }).folder;
      } catch (error) {
        expect(error).toMatchObject({ status: 400 });
      }
      expect(isRefusedOrLiteral(validated)).toBe(true);
    }
  );

  it.each(
    PARTNER_UPLOAD_NAMESPACES.flatMap((namespace) => [
      namespace,
      `${namespace}${UUID}/`,
      `/${namespace}`,
      namespace.toUpperCase(),
      namespace.replace('/', '//'),
      // A payload nobody validated keeps whatever a client sent. On the Supabase backend the signed
      // key goes into the request URL raw: the storage server decodes its escapes, and the URL
      // parser resolves dot segments (`%2e%2e` included), drops tabs, and ends the path at '?' or '#'.
      ...spellingsOf(namespace)
        .filter((spelling) => /[%?#]/.test(spelling))
        .map((spelling) => `${spelling}/`),
      `uploads/%2e%2e/${namespace}`,
      `uploads/../${namespace}`,
      `${namespace.slice(0, 5)}\t${namespace.slice(5)}`,
      // The URL parser resolves dot segments before decoding and keeps empty segments, so a `..`
      // pops an empty segment or one holding an escaped `/` (2026-11-14: both were signed).
      `${namespace.replace('/', '//../')}`,
      `x%2fy/../${namespace}`,
    ])
  )('the signer never signs a key under %j, on either backend, for a payload nobody validated', async (folder) => {
    const payload: ValidR2PresignedUploadPayload = { ...UPLOAD, folder };
    for (const backend of ['s3', 'supabase']) {
      vi.stubEnv('STORAGE_PROVIDER', backend);
      await expect(createR2PresignedUpload(payload, { userId: 'writer-1' })).rejects.toMatchObject({
        name: 'R2PresignedUploadError',
        status: 400,
        message: 'Invalid upload folder.',
      });
    }
    expect(mocks.getS3PresignClient).not.toHaveBeenCalled();
    expect(mocks.supabaseCreateSignedUpload).not.toHaveBeenCalled();
  });
});

describe('the client-key predicate (/api/process-image, /api/media/record) refuses every spelling', () => {
  /** A key inside the spelled folder, as a client would hand one back. */
  const keyIn = (folder: string) => `${folder.replace(/\/*$/, '/')}photo_20261114101500.jpg`;

  it.each(PARTNER_SPELLINGS)('refuses %j and a key inside it', (folder) => {
    for (const key of [folder, keyIn(folder)]) {
      expect(isAcceptableClientObjectKey(key), key).toBe(false);
      expect(isAcceptableClientObjectKey(key, { requireAllowedExtension: true }), key).toBe(false);
    }
  });

  it.each(ORDINARY_FOLDERS)('accepts a key inside %j', (folder) => {
    expect(isAcceptableClientObjectKey(keyIn(folder), { requireAllowedExtension: true })).toBe(true);
  });
});

describe('every key a staff builder mints is one the client-key predicate takes back (no builder keeps a %)', () => {
  const NOW = new Date(2026, 10, 14, 10, 15, 0);
  /** Hostile names: escapes, a bare '%', '?', '#', spaces, parentheses, non-ASCII, dot runs. */
  const FILENAMES = ['Hero Shot.PNG', 'Promo 50% off.png', '%61ffiliates.png', 'a%2Fb%2e%2e.png', 'what?#.png', 'café (1).png', 'x..y.png'];
  /** Folders a builder accepts: ordinary ones, the encoded spellings (cleaned) and other hostile text. */
  const FOLDERS = [...ORDINARY_FOLDERS, ...ENCODED_SPELLINGS, 'Promo 50% off', 'uploads/%2e%2e/x', 'a?b#c', 'café'];
  /** The variant suffixes /api/process-image appends next to the original, which /api/media/record then records. */
  const VARIANT_SUFFIXES = ['_xlarge.avif', '_large.avif', '_medium.avif', '_small.avif', '_thumbnail.avif', '_original.avif'];

  function expectTakenBack(key: string) {
    expect(key).not.toContain('%');
    expect(isAcceptableClientObjectKey(key, { requireAllowedExtension: true }), key).toBe(true);
    const base = key.slice(0, key.lastIndexOf('.'));
    for (const suffix of VARIANT_SUFFIXES) {
      expect(isAcceptableClientObjectKey(`${base}${suffix}`, { requireAllowedExtension: true }), `${base}${suffix}`).toBe(true);
    }
  }

  it('the media library routes (resolveUploadFolder, sanitizeBaseFilename, resolveExtension, the timestamp)', () => {
    let minted = 0;
    for (const folder of FOLDERS) {
      const resolved = resolveUploadFolder(folder);
      expect(resolved, folder).not.toBeNull();
      for (const name of FILENAMES) {
        // The key /api/upload/proxy and /api/upload/presigned-url build.
        expectTakenBack(`${resolved}${sanitizeBaseFilename(name)}_${formatUploadTimestamp(NOW)}.${resolveExtension(name, 'image/png')}`);
        minted += 1;
      }
    }
    expect(minted).toBe(FOLDERS.length * FILENAMES.length);
  });

  it('the custom-block route (validateR2PresignedUploadPayload, buildR2UploadObjectKey)', () => {
    let minted = 0;
    for (const folder of FOLDERS) {
      const payload = validateR2PresignedUploadPayload({ ...UPLOAD, folder });
      for (const filename of FILENAMES) {
        expectTakenBack(buildR2UploadObjectKey({ ...payload, filename }, { now: NOW, nonce: 'a1b2c3d4' }));
        minted += 1;
      }
    }
    expect(minted).toBe(FOLDERS.length * FILENAMES.length);
  });

  // /api/process-image and /api/media/record both require an allowed media extension, so every type
  // a route accepts must mint one, whatever extension the file declared (or none).
  it('every content type each route accepts, whatever extension the file declares', () => {
    let minted = 0;
    for (const [contentType, extensions] of Object.entries(ALLOWED_UPLOAD_CONTENT_TYPES)) {
      for (const name of ['file', 'evil.html', ...extensions.map((extension) => `File.${extension.toUpperCase()}`)]) {
        expectTakenBack(`uploads/${sanitizeBaseFilename(name)}_${formatUploadTimestamp(NOW)}.${resolveExtension(name, contentType)}`);
        minted += 1;
      }
    }
    for (const contentType of R2_PRESIGNED_UPLOAD_ALLOWED_CONTENT_TYPES) {
      const payload = validateR2PresignedUploadPayload({ ...UPLOAD, contentType });
      for (const filename of ['hero', 'evil.html', 'hero.jpeg', 'Hero.JPG', 'hero.png', 'hero.webp']) {
        expectTakenBack(buildR2UploadObjectKey({ ...payload, filename }, { now: NOW, nonce: 'a1b2c3d4' }));
        minted += 1;
      }
    }
    // Every type, with at least three names each: the loops ran.
    expect(minted).toBeGreaterThanOrEqual(
      (Object.keys(ALLOWED_UPLOAD_CONTENT_TYPES).length + R2_PRESIGNED_UPLOAD_ALLOWED_CONTENT_TYPES.length) * 3
    );
  });
});

describe('the rest of affiliates/ stays ordinary media on every builder', () => {
  it.each(ORDINARY_FOLDERS)('%j is accepted, validated and signed', async (folder) => {
    const resolved = resolveUploadFolder(folder);
    expect(resolved).not.toBeNull();
    expect(isPartnerUploadKey(resolved)).toBe(false);

    const payload = validateR2PresignedUploadPayload({ ...UPLOAD, folder });
    expect(payload.folder).toBe(sanitizeR2UploadFolder(folder));

    vi.stubEnv('STORAGE_PROVIDER', 'supabase');
    const upload = await createR2PresignedUpload(payload, { userId: 'writer-1' });
    expect(upload.objectKey.startsWith(payload.folder)).toBe(true);
    expect(mocks.supabaseCreateSignedUpload).toHaveBeenCalledWith(upload.objectKey);
  });
});
