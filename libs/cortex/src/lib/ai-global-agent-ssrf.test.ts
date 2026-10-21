import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, LookupFunction } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { executeFetchUrlContent, isBlockedFetchHost } from './ai-global-agent-tools';
import { createPinnedLookup, GuardedFetchError, guardedFetch } from './fetch-host-guard';

/**
 * `fetch_url_content` performs server-side HTTP on a caller-supplied URL and is a
 * READ-scoped tool, so this blocklist is what stops a read-only MCP token from
 * reaching internal services or a cloud metadata endpoint. It shipped with an
 * IPv4-mapped IPv6 bypass (`http://[::ffff:127.0.0.1]/` reached loopback), so the
 * encodings are pinned here rather than trusted to review.
 *
 * The URL parser hands `hostname` over already normalised — brackets stripped for
 * IPv6, decimal/hex hosts converted to dotted-quad — so these inputs are the shapes
 * the function actually receives.
 */
describe('isBlockedFetchHost', () => {
  const blocked = [
    'localhost',
    'app.localhost',
    'printer.local',
    'db.internal',
    'metadata.google.internal',
    '127.0.0.1',
    '0.0.0.0',
    '10.0.0.5',
    '192.168.1.1',
    '172.16.0.1',
    '172.31.255.255',
    '169.254.169.254',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    // IPv4-mapped IPv6, in both the dotted and the hextet form the parser produces.
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:169.254.169.254',
    '::ffff:a9fe:a9fe',
    '::ffff:10.0.0.1',
    '::ffff:192.168.0.1',
    // Trailing dot and casing must not smuggle anything past.
    'LOCALHOST',
    'localhost.',
    // Missed until 2026-10-21: carrier-grade NAT, benchmarking, NAT64 into IPv4 space.
    '100.64.0.1',
    '100.127.255.255',
    '198.18.0.1',
    '198.19.255.255',
    '64:ff9b::7f00:1',
    '64:ff9b::a9fe:a9fe',
    '::ffff:100.64.0.1',
    '224.0.0.1',
  ];

  const allowed = [
    'example.com',
    'newrootsherbal.com',
    'images.pexels.com',
    '8.8.8.8',
    '172.32.0.1', // just outside the 172.16/12 private range
    '172.15.0.1', // just below it
    '169.253.0.1', // adjacent to link-local, not in it
    '2606:4700::1111', // public IPv6
    '::ffff:8.8.8.8', // mapped, but a public address
    '100.63.255.255', // just below 100.64/10
    '100.128.0.1', // just above it
    '198.20.0.1', // just above 198.18/15
  ];

  for (const host of blocked) {
    it(`blocks ${host}`, () => {
      expect(isBlockedFetchHost(host)).toBe(true);
    });
  }

  for (const host of allowed) {
    it(`allows ${host}`, () => {
      expect(isBlockedFetchHost(host)).toBe(false);
    });
  }
});

/**
 * 2026-10-21: fetch_url_content (and the app's external image import) fetched with
 * `redirect: 'follow'` and checked the host only after the LAST hop. An internal hop had
 * already been requested by then, its status was reported back ("HTTP 403"), the body was
 * buffered whole before the size cap applied, and the DNS check ran apart from the socket's
 * own lookup. These run `guardedFetch` against a real local server: two hostnames stand in
 * for public answers routed to it, anything else goes through the pinned lookup.
 */
describe('guardedFetch', () => {
  const requested: string[] = [];
  const huge = { closedEarly: false };
  let server: Server;
  let port = 0;

  const publicHosts = new Set(['public.example.test', 'cdn.example.test']);
  const pinned = createPinnedLookup((hostname, callback) =>
    callback(null, [{ address: hostname === 'internal.example.test' ? '10.0.0.5' : '93.184.216.34', family: 4 }])
  );
  const lookup = ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (!publicHosts.has(hostname)) {
      (pinned as unknown as (h: string, o: { all?: boolean }, cb: (...args: unknown[]) => void) => void)(
        hostname,
        options,
        callback
      );
      return;
    }
    if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
    else callback(null, '127.0.0.1', 4);
  }) as unknown as LookupFunction;

  const at = (path: string, host = 'public.example.test') => `http://${host}:${port}${path}`;

  function redirect(response: ServerResponse, location: string) {
    response.writeHead(302, { location });
    response.end();
  }

  beforeAll(async () => {
    server = createServer((request, response) => {
      const path = request.url ?? '/';
      requested.push(`${String(request.headers.host).split(':')[0]}${path}`);
      response.on('error', () => undefined);

      if (path === '/page') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<html><head><title>Public page</title></head><body><p>Hello there.</p></body></html>');
      } else if (path === '/to-public') {
        redirect(response, at('/page', 'cdn.example.test'));
      } else if (path === '/to-private') {
        redirect(response, `http://127.0.0.1:${port}/internal`);
      } else if (path === '/to-forbidden') {
        redirect(response, `http://127.0.0.1:${port}/forbidden`);
      } else if (path === '/to-rebinding') {
        redirect(response, at('/internal', 'internal.example.test'));
      } else if (path === '/loop') {
        redirect(response, '/loop');
      } else if (path === '/huge') {
        response.writeHead(200, { 'content-type': 'text/html' });
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        let sent = 0;
        const pump = () => {
          while (!response.destroyed && sent < 256 * 1024 * 1024) {
            sent += chunk.length;
            if (!response.write(chunk)) {
              response.once('drain', pump);
              return;
            }
          }
          if (!response.destroyed) response.end();
        };
        response.on('close', () => {
          huge.closedEarly = !response.writableFinished;
        });
        pump();
      } else if (path === '/forbidden') {
        response.writeHead(403);
        response.end('forbidden');
      } else {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('internal secret');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    requested.length = 0;
  });

  it('follows a redirect to another public host', async () => {
    const response = await guardedFetch(at('/to-public'), { lookup, maxBytes: 10_000 });

    expect(response.status).toBe(200);
    expect(response.url.hostname).toBe('cdn.example.test');
    expect(new TextDecoder().decode(await response.readBody())).toContain('Public page');
  });

  it('refuses a redirect to a private IP literal without requesting it', async () => {
    const refusal = guardedFetch(at('/to-private'), { lookup, maxBytes: 10_000 });

    await expect(refusal).rejects.toBeInstanceOf(GuardedFetchError);
    await expect(refusal).rejects.toMatchObject({ reason: 'blocked', redirects: 1 });
    expect(requested).toEqual(['public.example.test/to-private']);
  });

  it('refuses a redirect to a name that resolves to a private address', async () => {
    await expect(guardedFetch(at('/to-rebinding'), { lookup, maxBytes: 10_000 })).rejects.toMatchObject({
      message: expect.stringMatching(/resolves to a private address \(10\.0\.0\.5\)/),
      reason: 'blocked',
    });
    expect(requested).toEqual(['public.example.test/to-rebinding']);
  });

  it('caps the redirect chain', async () => {
    await expect(guardedFetch(at('/loop'), { lookup, maxBytes: 10_000, maxRedirects: 3 })).rejects.toMatchObject({
      reason: 'redirects',
    });
    expect(requested).toHaveLength(4);
  });

  it('streams the body under the byte cap instead of buffering it whole', async () => {
    huge.closedEarly = false;
    const response = await guardedFetch(at('/huge'), { lookup, maxBytes: 100_000 });

    await expect(response.readBody()).rejects.toMatchObject({ reason: 'too_large' });
    await expect.poll(() => huge.closedEarly).toBe(true);

    const truncated = await guardedFetch(at('/huge'), { lookup, maxBytes: 100_000 });
    expect((await truncated.readBody({ truncate: true })).byteLength).toBe(100_000);
  });

  it('fetch_url_content reports a redirect into the network as refused, never its status', async () => {
    const result = await executeFetchUrlContent({ url: at('/to-forbidden') }, { lookup });

    expect(result).toEqual({
      message: 'The URL redirected to a blocked internal address.',
      success: false,
      url: at('/to-forbidden'),
    });
    expect(result).not.toHaveProperty('status');
    expect(requested).toEqual(['public.example.test/to-forbidden']);
  });

  it('fetch_url_content refuses CGNAT and NAT64 literals before connecting', async () => {
    for (const url of ['http://100.64.0.1/', 'http://198.18.0.1/', 'http://[64:ff9b::7f00:1]/']) {
      await expect(executeFetchUrlContent({ url }, { lookup })).resolves.toMatchObject({
        message: 'Refusing to fetch a local, private, or internal address.',
        success: false,
      });
    }
  });

  it('fetch_url_content still reads a public page through the guard', async () => {
    const result = await executeFetchUrlContent({ url: at('/to-public') }, { lookup });

    expect(result).toMatchObject({ finalUrl: at('/page', 'cdn.example.test'), success: true, title: 'Public page' });
  });
});
