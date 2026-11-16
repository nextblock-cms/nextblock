import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Offline signing only: dummy credentials, nothing is sent anywhere.
const R2_ENV = {
  R2_ACCOUNT_ID: 'testaccount',
  R2_ACCESS_KEY_ID: 'TESTACCESSKEYID',
  R2_SECRET_ACCESS_KEY: 'test-secret-not-a-real-key',
};

/** A fresh copy of the server entry: it caches its clients per module instance. */
async function loadServerEntry() {
  vi.resetModules();
  return import('../src/server');
}

/** The URL the app's presignBoundPut would hand the browser for a 1 KB PNG. */
async function presignedPut(client: S3Client | null) {
  if (!client) throw new Error('No S3 client: the R2 env stub is missing.');
  const url = await getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: 'media', Key: 'uploads/a.png', ContentType: 'image/png', ContentLength: 1024 }),
    { expiresIn: 300, signableHeaders: new Set(['content-length', 'content-type']) },
  );
  return new URL(url);
}

const checksumParams = (url: URL) => [...url.searchParams.keys()].filter((name) => /checksum/i.test(name));

describe('getS3PresignClient', () => {
  beforeEach(() => {
    for (const [name, value] of Object.entries(R2_ENV)) vi.stubEnv(name, value);
    vi.stubEnv('R2_S3_ENDPOINT', undefined);
    vi.stubEnv('R2_S3_PUBLIC_ENDPOINT', undefined);
    vi.stubEnv('R2_FORCE_PATH_STYLE', undefined);
    // The SDK reads this too; pin the default so the control below means what it says.
    vi.stubEnv('AWS_REQUEST_CHECKSUM_CALCULATION', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('signs upload URLs without a checksum of the empty body', async () => {
    const { getS3PresignClient } = await loadServerEntry();
    const url = await presignedPut(await getS3PresignClient());

    // With the SDK default these were x-amz-checksum-crc32=AAAAAA== and
    // x-amz-sdk-checksum-algorithm=CRC32: storage that checks them refuses every real file.
    expect(checksumParams(url)).toEqual([]);
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    expect(url.host).toBe('media.testaccount.r2.cloudflarestorage.com');
  });

  it('is checked against the shared client, which keeps the SDK default for server-side writes', async () => {
    // Server-side PUTs send the body, so their checksum is right. If this ever stops adding one,
    // the SDK default changed and the test above proves nothing new: revisit both.
    const { getS3Client } = await loadServerEntry();
    const url = await presignedPut(await getS3Client());

    expect(url.searchParams.get('x-amz-checksum-crc32')).toBe('AAAAAA==');
  });

  it('signs for the public endpoint on self-hosted MinIO, still without the checksum', async () => {
    vi.stubEnv('R2_S3_ENDPOINT', 'http://minio:9000');
    vi.stubEnv('R2_S3_PUBLIC_ENDPOINT', 'http://localhost:9000');
    vi.stubEnv('R2_FORCE_PATH_STYLE', 'true');
    const { getS3PresignClient } = await loadServerEntry();
    const url = await presignedPut(await getS3PresignClient());

    expect(url.origin).toBe('http://localhost:9000');
    expect(url.pathname).toBe('/media/uploads/a.png');
    expect(checksumParams(url)).toEqual([]);
  });

  it('is its own client, not the shared one', async () => {
    const { getS3Client, getS3PresignClient } = await loadServerEntry();
    const presign = await getS3PresignClient();

    expect(presign).not.toBeNull();
    expect(presign).not.toBe(await getS3Client());
    expect(await getS3PresignClient()).toBe(presign);
  });
});
