import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  profileSingle: vi.fn(),
  getStorageBackend: vi.fn(),
  getStorageBucket: vi.fn(),
  getS3Client: vi.fn(),
  s3Send: vi.fn(),
  supabaseUploadObject: vi.fn(),
}));

vi.mock('@nextblock-cms/db/server', () => ({
  createClient: () => ({
    auth: { getUser: mocks.getUser },
    from: () => ({
      select: () => ({
        eq: () => ({ single: mocks.profileSingle }),
      }),
    }),
  }),
}));
vi.mock('@nextblock-cms/utils/server', () => ({
  getS3Client: mocks.getS3Client,
}));
vi.mock('@aws-sdk/client-s3', () => ({
  PutObjectCommand: class PutObjectCommand {
    constructor(public readonly input: Record<string, unknown>) {}
  },
}));
vi.mock('../../../../lib/storage/provider', () => ({
  getStorageBackend: mocks.getStorageBackend,
  getStorageBucket: mocks.getStorageBucket,
}));
vi.mock('../../../../lib/storage/supabase-storage', () => ({
  supabaseUploadObject: mocks.supabaseUploadObject,
}));

import { POST } from './route';

const URL_ = 'http://localhost/api/upload/proxy';
const MAX_BYTES = 25 * 1024 * 1024;
const WRITER = { id: 'writer-1' };

type FilePart = { name: string; type: string; bytes?: number | Uint8Array<ArrayBuffer> };

function multipartRequest(parts: { file?: FilePart; folder?: string }) {
  const form = new FormData();
  if (parts.file) {
    const content: Uint8Array<ArrayBuffer> =
      parts.file.bytes instanceof Uint8Array
        ? parts.file.bytes
        : new Uint8Array(parts.file.bytes ?? 16).fill(1);
    form.append('file', new File([content], parts.file.name, { type: parts.file.type }));
  }
  if (parts.folder !== undefined) form.append('folder', parts.folder);
  return new NextRequest(URL_, { method: 'POST', body: form });
}

function signIn(role: string | null, user: { id: string } | null = WRITER) {
  mocks.getUser.mockResolvedValue({ data: { user }, error: null });
  mocks.profileSingle.mockResolvedValue({ data: role ? { role } : null, error: null });
}

async function json(response: Response) {
  return (await response.json()) as { error?: string; objectKey?: string; message?: string };
}

describe('POST /api/upload/proxy', () => {
  beforeEach(() => {
    signIn('WRITER');
    mocks.getStorageBackend.mockReturnValue('s3');
    mocks.getStorageBucket.mockReturnValue('media');
    mocks.getS3Client.mockResolvedValue({ send: mocks.s3Send });
    mocks.s3Send.mockResolvedValue({});
    mocks.supabaseUploadObject.mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  describe('access control', () => {
    it('401s without a session and never touches storage', async () => {
      signIn(null, null);
      const response = await POST(multipartRequest({ file: { name: 'a.png', type: 'image/png' } }));

      expect(response.status).toBe(401);
      expect(mocks.getS3Client).not.toHaveBeenCalled();
      expect(mocks.s3Send).not.toHaveBeenCalled();
    });

    it('403s a signed-in customer (role USER), the gap the repro exploited', async () => {
      signIn('USER');
      const response = await POST(multipartRequest({ file: { name: 'a.png', type: 'image/png' } }));

      expect(response.status).toBe(403);
      expect(await json(response)).toEqual({ error: 'Forbidden: Insufficient permissions' });
      expect(mocks.getS3Client).not.toHaveBeenCalled();
      expect(mocks.s3Send).not.toHaveBeenCalled();
    });

    it('403s when the profile row is missing', async () => {
      signIn(null);
      const response = await POST(multipartRequest({ file: { name: 'a.png', type: 'image/png' } }));
      expect(response.status).toBe(403);
    });

    it.each(['WRITER', 'ADMIN'])('lets %s upload', async (role) => {
      signIn(role);
      const response = await POST(multipartRequest({ file: { name: 'a.png', type: 'image/png' } }));
      expect(response.status).toBe(200);
      expect(mocks.s3Send).toHaveBeenCalledTimes(1);
    });
  });

  describe('body size', () => {
    it('413s on an oversized Content-Length before reading the body', async () => {
      const request = new NextRequest(URL_, {
        method: 'POST',
        headers: {
          'content-type': 'multipart/form-data; boundary=x',
          'content-length': String(MAX_BYTES + 1),
        },
        body: 'tiny',
      });
      expect(request.headers.get('content-length')).toBe(String(MAX_BYTES + 1));

      const response = await POST(request);

      expect(response.status).toBe(413);
      expect((await json(response)).error).toBe('File exceeds the 25 MB upload limit.');
      expect(mocks.s3Send).not.toHaveBeenCalled();
    });

    it('413s a chunked body that crosses the cap, without buffering the rest', async () => {
      const chunk = new Uint8Array(1024 * 1024).fill(7);
      let pulled = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          if (pulled > 40) {
            controller.close();
            return;
          }
          controller.enqueue(chunk);
        },
      });
      const request = new NextRequest(URL_, {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=x' },
        body: stream,
        duplex: 'half',
      } as unknown as ConstructorParameters<typeof NextRequest>[1]);
      expect(request.headers.get('content-length')).toBeNull();

      const response = await POST(request);

      expect(response.status).toBe(413);
      // 25 MB cap => reading stops right after the 26th 1 MB chunk, far short of the 40 on offer.
      expect(pulled).toBeLessThanOrEqual(27);
      expect(mocks.s3Send).not.toHaveBeenCalled();
    });

    it('accepts a file right at the cap', async () => {
      const response = await POST(
        multipartRequest({ file: { name: 'big.bin.png', type: 'image/png', bytes: MAX_BYTES - 1024 } }),
      );
      expect(response.status).toBe(200);
    });
  });

  describe('content type allowlist', () => {
    it.each([
      ['text/html', 'page.html'],
      ['application/javascript', 'x.js'],
      ['application/zip', 'x.zip'],
      ['application/octet-stream', 'x.bin'],
      ['application/x-sh', 'x.sh'],
      ['', 'unknown.xyz'],
    ])('415s %s', async (type, name) => {
      const response = await POST(multipartRequest({ file: { name, type } }));

      expect(response.status).toBe(415);
      expect((await json(response)).error).toMatch(/^Unsupported file type/);
      expect(mocks.s3Send).not.toHaveBeenCalled();
    });

    it.each([
      ['image/jpeg', 'a.jpg'],
      ['image/svg+xml', 'logo.svg'],
      ['video/mp4', 'clip.mp4'],
      ['application/pdf', 'doc.pdf'],
      ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'doc.docx'],
      ['text/csv', 'rows.csv'],
    ])('accepts %s', async (type, name) => {
      const response = await POST(multipartRequest({ file: { name, type } }));
      expect(response.status).toBe(200);
    });

    it('ignores content-type parameters and case when matching', async () => {
      const response = await POST(
        multipartRequest({ file: { name: 'a.txt', type: 'Text/Plain; charset=utf-8' } }),
      );
      expect(response.status).toBe(200);
      const command = mocks.s3Send.mock.calls[0][0] as { input: Record<string, unknown> };
      expect(command.input.ContentType).toBe('text/plain');
    });
  });

  describe('object key', () => {
    it('builds <folder>/<sanitized-base>_<timestamp>.<ext> and uploads it as the declared type', async () => {
      const response = await POST(
        multipartRequest({
          file: { name: 'Photo Shoot (final).PNG', type: 'image/png', bytes: 1024 },
          folder: 'pages/my-page/',
        }),
      );

      expect(response.status).toBe(200);
      const body = await json(response);
      expect(body.objectKey).toMatch(/^pages\/my-page\/photo-shoot-final_\d{14}\.png$/);
      expect(body.message).toBe('File uploaded successfully.');

      const command = mocks.s3Send.mock.calls[0][0] as { input: Record<string, unknown> };
      expect(command.input).toMatchObject({
        Bucket: 'media',
        Key: body.objectKey,
        ContentType: 'image/png',
        ContentLength: 1024,
        Metadata: { 'uploader-user-id': 'writer-1' },
      });
      expect(Buffer.isBuffer(command.input.Body)).toBe(true);
      expect((command.input.Body as Buffer).byteLength).toBe(1024);
    });

    it('defaults the folder to uploads/ and appends a missing trailing slash', async () => {
      const first = await json(await POST(multipartRequest({ file: { name: 'a.png', type: 'image/png' } })));
      expect(first.objectKey).toMatch(/^uploads\/a_\d{14}\.png$/);

      const second = await json(
        await POST(multipartRequest({ file: { name: 'a.png', type: 'image/png' }, folder: 'uploads/products' })),
      );
      expect(second.objectKey).toMatch(/^uploads\/products\/a_\d{14}\.png$/);
    });

    it('keeps the legacy folder cleanup for odd characters (slugs with spaces, dots)', async () => {
      const body = await json(
        await POST(multipartRequest({ file: { name: 'a.png', type: 'image/png' }, folder: '/pages/My Slug v1.2//' })),
      );
      expect(body.objectKey).toMatch(/^pages\/My-Slug-v1-2\/a_\d{14}\.png$/);
    });

    it.each([
      '../../etc',
      'uploads/../private',
      './uploads',
      'uploads/..',
      'a..b/c',
      'pages\\..\\x',
      'uploads/\u0000x',
    ])('400s a traversal folder %j instead of cleaning it', async (folder) => {
      const response = await POST(multipartRequest({ file: { name: 'a.png', type: 'image/png' }, folder }));

      expect(response.status).toBe(400);
      expect((await json(response)).error).toBe('Invalid upload folder.');
      expect(mocks.s3Send).not.toHaveBeenCalled();
    });

    it('forces the stored extension to agree with the declared content type', async () => {
      const html = await json(await POST(multipartRequest({ file: { name: 'evil.html', type: 'image/png' } })));
      expect(html.objectKey).toMatch(/^uploads\/evil_\d{14}\.png$/);

      const upper = await json(await POST(multipartRequest({ file: { name: 'Report.PDF', type: 'application/pdf' } })));
      expect(upper.objectKey).toMatch(/^uploads\/report_\d{14}\.pdf$/);

      const alias = await json(await POST(multipartRequest({ file: { name: 'photo.jpeg', type: 'image/jpeg' } })));
      expect(alias.objectKey).toMatch(/^uploads\/photo_\d{14}\.jpeg$/);

      const none = await json(await POST(multipartRequest({ file: { name: 'noext', type: 'image/webp' } })));
      expect(none.objectKey).toMatch(/^uploads\/noext_\d{14}\.webp$/);
    });

    it('never lets a crafted filename add path segments or dot-names to the key', async () => {
      const body = await json(
        await POST(multipartRequest({ file: { name: '../../.hidden/..\\x.png', type: 'image/png' } })),
      );
      expect(body.objectKey).toMatch(/^uploads\/hidden\.x_\d{14}\.png$/);
      expect(body.objectKey).not.toContain('..');
      expect(body.objectKey).not.toContain('\\');
    });
  });

  describe('request shape', () => {
    it('400s when no file part is present', async () => {
      const response = await POST(multipartRequest({ folder: 'uploads' }));
      expect(response.status).toBe(400);
      expect((await json(response)).error).toBe('No file provided.');
    });

    it('400s an empty body', async () => {
      const response = await POST(new NextRequest(URL_, { method: 'POST' }));
      expect(response.status).toBe(400);
      expect((await json(response)).error).toBe('No file provided.');
    });

    it('400s a non-multipart body', async () => {
      const response = await POST(
        new NextRequest(URL_, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ file: 'x' }),
        }),
      );
      expect(response.status).toBe(400);
      expect((await json(response)).error).toBe('Expected a multipart/form-data upload.');
    });

    it('400s an empty file', async () => {
      const response = await POST(multipartRequest({ file: { name: 'a.png', type: 'image/png', bytes: 0 } }));
      expect(response.status).toBe(400);
      expect((await json(response)).error).toBe('The uploaded file is empty.');
    });
  });

  describe('storage backends', () => {
    it('writes through supabaseUploadObject on the native backend', async () => {
      mocks.getStorageBackend.mockReturnValue('supabase');
      const response = await POST(
        multipartRequest({ file: { name: 'a.png', type: 'image/png', bytes: 32 }, folder: 'logos/' }),
      );

      expect(response.status).toBe(200);
      expect(mocks.getS3Client).not.toHaveBeenCalled();
      expect(mocks.supabaseUploadObject).toHaveBeenCalledTimes(1);
      const [key, buffer, type] = mocks.supabaseUploadObject.mock.calls[0] as [string, Buffer, string];
      expect(key).toMatch(/^logos\/a_\d{14}\.png$/);
      expect(buffer.byteLength).toBe(32);
      expect(type).toBe('image/png');
    });

    it('500s when no bucket is configured', async () => {
      mocks.getStorageBucket.mockReturnValue('');
      const response = await POST(multipartRequest({ file: { name: 'a.png', type: 'image/png' } }));
      expect(response.status).toBe(500);
    });

    it('500s when the S3 client is unavailable', async () => {
      mocks.getS3Client.mockResolvedValue(null);
      const response = await POST(multipartRequest({ file: { name: 'a.png', type: 'image/png' } }));
      expect(response.status).toBe(500);
    });
  });
});
