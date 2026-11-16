import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The real presigner, with a switch to make it return a hand-written URL for the fail-closed tests.
const presigner = vi.hoisted(() => ({ override: null as null | ((...args: unknown[]) => Promise<string>) }));
vi.mock('@aws-sdk/s3-request-presigner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/s3-request-presigner')>();
  return {
    ...actual,
    getSignedUrl: (...args: Parameters<typeof actual.getSignedUrl>) =>
      presigner.override ? presigner.override(...args) : actual.getSignedUrl(...args),
  };
});

import { PRESIGNED_PUT_SIGNED_HEADERS, presignBoundPut } from './presigned-put';

// Offline signing only: dummy credentials, nothing is sent anywhere.
const SECRET = 'test-secret-not-a-real-key';
const client = new S3Client({
  region: 'auto',
  endpoint: 'https://account.r2.cloudflarestorage.com',
  credentials: { accessKeyId: 'TESTACCESSKEYID', secretAccessKey: SECRET },
});

const MAX = 10 * 1024 * 1024;
const REQUEST = {
  bucket: 'media',
  key: 'uploads/photo_20261104120000.png',
  contentType: 'image/png',
  contentLength: 1024,
  maxBytes: MAX,
  expiresIn: 300,
  metadata: { 'uploader-user-id': 'writer-1' },
};

const rfc3986 = (value: string) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const sha256Hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const hmac = (key: string | Buffer, value: string) => createHmac('sha256', key).update(value, 'utf8').digest();

/**
 * What an S3-compatible server (R2, S3, MinIO) does with a query-signed PUT: rebuild the canonical
 * request from the headers the URL names in X-Amz-SignedHeaders, using the values the client
 * actually sent, and compare signatures (SigV4 with UNSIGNED-PAYLOAD).
 */
function storageAccepts(url: string, sent: Record<string, string | number>): boolean {
  const parsed = new URL(url);
  const query = parsed.searchParams;
  const signedHeaders = (query.get('X-Amz-SignedHeaders') ?? '').split(';');
  const [, date, region, service] = (query.get('X-Amz-Credential') ?? '').split('/');
  const values = new Map(Object.entries(sent).map(([name, value]) => [name.toLowerCase(), String(value)]));
  values.set('host', parsed.host);

  const canonicalQuery = [...query.entries()]
    .filter(([name]) => name !== 'X-Amz-Signature')
    .map(([name, value]) => [rfc3986(name), rfc3986(value)] as const)
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  const canonicalHeaders = signedHeaders
    .map((name) => `${name}:${(values.get(name) ?? '').trim().replace(/\s+/g, ' ')}\n`)
    .join('');
  const canonicalRequest = [
    'PUT',
    parsed.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders.join(';'),
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    query.get('X-Amz-Date') ?? '',
    `${date}/${region}/${service}/aws4_request`,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${SECRET}`, date), region), service), 'aws4_request');
  return createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex') === query.get('X-Amz-Signature');
}

const FIVE_GB = 5 * 1024 ** 3;

afterEach(() => {
  presigner.override = null;
});

describe('presignBoundPut', () => {
  it('signs the declared size and type, and returns them as the headers to send', async () => {
    const { url, headers } = await presignBoundPut(client, REQUEST);
    const parsed = new URL(url);

    expect(parsed.pathname).toBe(`/${REQUEST.key}`);
    expect(parsed.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(parsed.searchParams.get('x-amz-meta-uploader-user-id')).toBe('writer-1');
    expect(headers).toEqual({ 'Content-Type': 'image/png', 'Content-Length': '1024' });

    // Every signed header but host is one the browser is told to send, so an honest upload can match.
    const signed = (parsed.searchParams.get('X-Amz-SignedHeaders') ?? '').split(';').filter((name) => name !== 'host');
    expect(signed).toEqual(Object.keys(headers).map((name) => name.toLowerCase()).sort());
    expect([...PRESIGNED_PUT_SIGNED_HEADERS].sort()).toEqual(signed);
  });

  it('gets storage to accept exactly the declared bytes of the declared type', async () => {
    const { url } = await presignBoundPut(client, REQUEST);

    expect(storageAccepts(url, { 'Content-Length': 1024, 'Content-Type': 'image/png' })).toBe(true);
    // Any other size, larger or smaller, fails the signature: R2 would take 5 GB in one PUT.
    expect(storageAccepts(url, { 'Content-Length': FIVE_GB, 'Content-Type': 'image/png' })).toBe(false);
    expect(storageAccepts(url, { 'Content-Length': 1025, 'Content-Type': 'image/png' })).toBe(false);
    expect(storageAccepts(url, { 'Content-Length': 1023, 'Content-Type': 'image/png' })).toBe(false);
    // So does another type (a `.png` key served as HTML) or a missing header.
    expect(storageAccepts(url, { 'Content-Length': 1024, 'Content-Type': 'text/html' })).toBe(false);
    expect(storageAccepts(url, { 'Content-Type': 'image/png' })).toBe(false);
    expect(storageAccepts(url, { 'Content-Length': 1024 })).toBe(false);
  });

  it('signs no checksum of the empty body with the client the routes use', async () => {
    // getS3PresignClient() is what both upload routes pass in. With the SDK's default checksum it
    // signed x-amz-checksum-crc32=AAAAAA== (an empty body) into every URL, which storage that
    // checks checksums holds the real file to.
    vi.stubEnv('R2_ACCOUNT_ID', 'account');
    vi.stubEnv('R2_ACCESS_KEY_ID', 'TESTACCESSKEYID');
    vi.stubEnv('R2_SECRET_ACCESS_KEY', SECRET);
    vi.stubEnv('R2_S3_ENDPOINT', undefined);
    vi.stubEnv('R2_S3_PUBLIC_ENDPOINT', undefined);
    try {
      const { getS3PresignClient } = await import('@nextblock-cms/utils/server');
      const routeClient = await getS3PresignClient();
      if (!routeClient) throw new Error('getS3PresignClient() built no client from the stubbed R2 env.');
      const { url } = await presignBoundPut(routeClient, REQUEST);

      expect([...new URL(url).searchParams.keys()].filter((name) => /checksum/i.test(name))).toEqual([]);
      expect(storageAccepts(url, { 'Content-Length': 1024, 'Content-Type': 'image/png' })).toBe(true);
      expect(storageAccepts(url, { 'Content-Length': FIVE_GB, 'Content-Type': 'image/png' })).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('is checked against the signing it replaced: a host-only URL took a 5 GB text/html PUT', async () => {
    // What both upload routes signed before 2026-11-04. If this stopped verifying, the test above
    // would prove nothing.
    const unbound = await getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: REQUEST.bucket, Key: REQUEST.key, ContentType: REQUEST.contentType }),
      { expiresIn: 300 },
    );
    expect(new URL(unbound).searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(storageAccepts(unbound, { 'Content-Length': FIVE_GB, 'Content-Type': 'text/html' })).toBe(true);
  });

  it.each([0, -1, 1.5, Number.NaN, MAX + 1, Number.MAX_SAFE_INTEGER + 2])(
    'refuses to sign a declared size of %s',
    async (contentLength) => {
      const sign = vi.fn();
      presigner.override = sign;
      await expect(presignBoundPut(client, { ...REQUEST, contentLength })).rejects.toThrow(/declared size/);
      expect(sign).not.toHaveBeenCalled();
    },
  );

  it('signs a file right at the limit', async () => {
    const { headers } = await presignBoundPut(client, { ...REQUEST, contentLength: MAX });
    expect(headers['Content-Length']).toBe(String(MAX));
  });

  it('refuses to sign without a content type', async () => {
    const sign = vi.fn();
    presigner.override = sign;
    await expect(presignBoundPut(client, { ...REQUEST, contentType: '' })).rejects.toThrow(/content type/);
    expect(sign).not.toHaveBeenCalled();
  });

  it.each([
    ['signs only host', 'https://media.account.r2.cloudflarestorage.com/k?X-Amz-SignedHeaders=host&X-Amz-Signature=0'],
    ['leaves the type out', 'https://media.account.r2.cloudflarestorage.com/k?X-Amz-SignedHeaders=content-length%3Bhost'],
    ['leaves the size out', 'https://media.account.r2.cloudflarestorage.com/k?X-Amz-SignedHeaders=content-type%3Bhost'],
    ['is not a URL', 'not a url'],
  ])('never hands out a URL that %s', async (_label, url) => {
    presigner.override = async () => url;
    await expect(presignBoundPut(client, REQUEST)).rejects.toThrow(/does not sign/);
  });
});

describe('presigned uploads', () => {
  // Every presigned URL is signed by presignBoundPut, so none can skip the size and type binding.
  // Relative to the app, so the copy a scaffold gets checks its own tree; the monorepo's libs too.
  const APP_DIR = path.resolve(__dirname, '../..');
  const LIBS_DIR = path.resolve(APP_DIR, '../../libs');
  // `from '…'`, `import '…'`, `import('…')`, `require('…')`; a bare mention (a build config's
  // dependency map) is not a use.
  const PRESIGNER_IMPORT = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"]@aws-sdk\/s3-(?:request-presigner|presigned-post)['"]/;
  const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'coverage']);

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) sourceFiles(full, out);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  it('are signed only in lib/storage/presigned-put.ts', () => {
    const roots = [APP_DIR, ...(fs.existsSync(LIBS_DIR) ? [LIBS_DIR] : [])];
    const importers = roots
      .flatMap((dir) => sourceFiles(dir))
      .filter((file) => PRESIGNER_IMPORT.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(APP_DIR, file).split(path.sep).join('/'));

    expect(importers, 'sign upload URLs with presignBoundPut() from lib/storage/presigned-put').toEqual([
      'lib/storage/presigned-put.ts',
    ]);
  });
});
