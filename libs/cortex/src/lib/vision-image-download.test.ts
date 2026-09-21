import { createServer, type Server } from 'node:http';
import type { AddressInfo, LookupFunction } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPinnedLookup,
  downloadCortexVisionImage,
  isPrivateAddress,
  sniffImageMediaType,
} from './vision-image-download';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

/** Resolves every hostname to the local test server, like a public DNS answer would. */
const toLocalServer = ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
  if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
  else callback(null, '127.0.0.1', 4);
}) as unknown as LookupFunction;

let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = request.url ?? '/';
    if (path === '/image.png') {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(Buffer.from(PNG));
    } else if (path === '/untyped') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(Buffer.from(PNG));
    } else if (path === '/html') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html></html>');
    } else if (path === '/big') {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(Buffer.alloc(4096, 1));
    } else if (path === '/redirect-public') {
      response.writeHead(302, { location: `http://cdn.example.test:${port}/image.png` });
      response.end();
    } else if (path === '/redirect-private') {
      response.writeHead(302, { location: `http://127.0.0.1:${port}/image.png` });
      response.end();
    } else if (path === '/missing') {
      response.writeHead(404);
      response.end();
    } else {
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const url = (path: string, host = 'images.example.test') => new URL(`http://${host}:${port}${path}`);

describe('isPrivateAddress', () => {
  it.each([
    '10.1.2.3',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '100.64.0.1',
    '198.18.0.1',
    '0.1.2.3',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    '::ffff:7f00:1',
    '64:ff9b::a00:1',
    'not-an-ip',
  ])('blocks %s', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111'])('allows %s', (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});

describe('createPinnedLookup', () => {
  const lookupWith = (addresses: Array<{ address: string; family: number }>, all = false) =>
    new Promise<{ error: Error | null; result: unknown }>((resolve) => {
      const lookup = createPinnedLookup((_hostname, callback) => callback(null, addresses));
      (lookup as unknown as (h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => void)(
        'host.example.test',
        { all },
        (error, address) => resolve({ error: error as Error | null, result: address })
      );
    });

  it('passes a public answer through', async () => {
    await expect(lookupWith([{ address: '93.184.216.34', family: 4 }])).resolves.toEqual({
      error: null,
      result: '93.184.216.34',
    });
  });

  it('refuses an answer containing any private address', async () => {
    const { error } = await lookupWith([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);
    expect(error?.message).toMatch(/resolves to a private address \(10\.0\.0\.5\)/);
  });

  it('returns every address when asked for all of them', async () => {
    const addresses = [{ address: '93.184.216.34', family: 4 }];
    await expect(lookupWith(addresses, true)).resolves.toEqual({ error: null, result: addresses });
  });
});

describe('sniffImageMediaType', () => {
  it('recognises a PNG signature and rejects text', () => {
    expect(sniffImageMediaType(PNG)).toBe('image/png');
    expect(sniffImageMediaType(new TextEncoder().encode('<html></html>'))).toBeNull();
  });
});

describe('downloadCortexVisionImage', () => {
  it('downloads the bytes and the declared media type', async () => {
    const image = await downloadCortexVisionImage(url('/image.png'), { lookup: toLocalServer });
    expect(image.mediaType).toBe('image/png');
    expect(Array.from(image.data)).toEqual(Array.from(PNG));
  });

  it('falls back to the file signature when Content-Type is not an image type', async () => {
    const image = await downloadCortexVisionImage(url('/untyped'), { lookup: toLocalServer });
    expect(image.mediaType).toBe('image/png');
  });

  it('follows a redirect to another public host', async () => {
    const image = await downloadCortexVisionImage(url('/redirect-public'), { lookup: toLocalServer });
    expect(image.mediaType).toBe('image/png');
  });

  it('refuses a redirect to a private IP literal', async () => {
    await expect(
      downloadCortexVisionImage(url('/redirect-private'), { lookup: toLocalServer })
    ).rejects.toThrow(/private or local host/);
  });

  it('refuses a private IP literal and localhost before connecting', async () => {
    await expect(downloadCortexVisionImage(url('/image.png', '127.0.0.1'))).rejects.toThrow(
      /private or local host/
    );
    await expect(downloadCortexVisionImage(url('/image.png', 'localhost'))).rejects.toThrow(
      /private or local host/
    );
  });

  it('refuses a hostname that resolves to a private address (DNS rebinding)', async () => {
    const rebinding = createPinnedLookup((_hostname, callback) =>
      callback(null, [{ address: '127.0.0.1', family: 4 }])
    );
    await expect(
      downloadCortexVisionImage(url('/image.png'), { lookup: rebinding })
    ).rejects.toThrow(/resolves to a private address/);
  });

  it('refuses a response that is not an image', async () => {
    await expect(
      downloadCortexVisionImage(url('/html'), { lookup: toLocalServer })
    ).rejects.toThrow(/did not return an image/);
  });

  it('refuses an image over the size cap', async () => {
    await expect(
      downloadCortexVisionImage(url('/big'), { lookup: toLocalServer, maxBytes: 1024 })
    ).rejects.toThrow(/larger than the 1024-byte limit/);
  });

  it('reports an HTTP error status', async () => {
    await expect(
      downloadCortexVisionImage(url('/missing'), { lookup: toLocalServer })
    ).rejects.toThrow(/HTTP 404/);
  });

  it('refuses non-http protocols', async () => {
    await expect(downloadCortexVisionImage(new URL('file:///etc/passwd'))).rejects.toThrow(
      /file: URLs are not allowed/
    );
  });
});
