import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as requestHttp, type IncomingMessage } from 'node:http';
import { request as requestHttps } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

import { isBlockedFetchHost } from './fetch-host-guard';

/**
 * Download the image Cortex AI describes for alt text, so the AI SDK never has to.
 *
 * AI SDK 7 downloads a URL file part itself through a DNS-pinned undici Agent that
 * @ai-sdk/provider-utils loads at runtime with `createRequire(...)('undici')`. That dynamic
 * require is invisible to Next's output file tracer, so undici was missing from Vercel
 * functions and from standalone builds, and every alt-text request threw there. Tracing it
 * in next.config.js is not a fix for this repo: the glob that reaches the monorepo root
 * breaks a scaffold's Turbopack build, and `npm run update` never rewrites an existing
 * project's next.config.js. So the image is fetched here with Node's own http/https and
 * handed to the model as bytes.
 *
 * The SSRF protection matches the SDK's: the hostname is checked first, and the DNS lookup
 * is PINNED (the address that is checked is the address the socket connects to, so a
 * rebinding hostname cannot swap in a private address afterwards). Redirects are followed
 * by hand and every hop is checked the same way. The body is capped, and the media type
 * comes from Content-Type or, when that is not an image type, from the file signature.
 */

/** Largest image accepted for alt-text generation. The model request inlines it as base64. */
export const CORTEX_AI_VISION_MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 20_000;

/**
 * Every range a download must never reach once DNS has answered. Broader than the
 * hostname blocklist: this is what the socket will actually connect to.
 */
const PRIVATE_ADDRESSES = (() => {
  const list = new BlockList();
  for (const [network, prefix] of [
    ['0.0.0.0', 8], // "this network"
    ['10.0.0.0', 8],
    ['100.64.0.0', 10], // carrier-grade NAT
    ['127.0.0.0', 8],
    ['169.254.0.0', 16], // link-local, cloud metadata
    ['172.16.0.0', 12],
    ['192.0.0.0', 24], // IETF protocol assignments
    ['192.0.2.0', 24], // TEST-NET-1
    ['192.168.0.0', 16],
    ['198.18.0.0', 15], // benchmarking
    ['198.51.100.0', 24], // TEST-NET-2
    ['203.0.113.0', 24], // TEST-NET-3
    ['224.0.0.0', 4], // multicast
    ['240.0.0.0', 4], // reserved, broadcast
  ] as const) {
    list.addSubnet(network, prefix, 'ipv4');
  }
  for (const [network, prefix] of [
    ['::', 128], // unspecified
    ['::1', 128], // loopback
    // No ::ffff:0:0/96 rule: BlockList already checks an IPv4-mapped address against the
    // IPv4 rules above, and that rule would make every plain IPv4 address match too.
    ['64:ff9b::', 96], // NAT64 can reach IPv4 space
    ['100::', 64], // discard
    ['2001:db8::', 32], // documentation
    ['fc00::', 7], // unique local
    ['fe80::', 10], // link-local
    ['ff00::', 8], // multicast
  ] as const) {
    list.addSubnet(network, prefix, 'ipv6');
  }
  return list;
})();

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return PRIVATE_ADDRESSES.check(address, 'ipv4');
  if (family === 6) return PRIVATE_ADDRESSES.check(address, 'ipv6');
  return true;
}

type ResolveAll = (
  hostname: string,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void
) => void;

const resolveAllWithDns: ResolveAll = (hostname, callback) =>
  dnsLookup(hostname, { all: true }, (error, addresses) => callback(error, addresses ?? []));

/**
 * A `lookup` for http(s).request that refuses any answer containing a private address.
 * `resolveAll` is injectable so tests can simulate DNS without the network.
 */
export function createPinnedLookup(resolveAll: ResolveAll = resolveAllWithDns): LookupFunction {
  const lookup = (
    hostname: string,
    options: { all?: boolean },
    callback: (
      error: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number
    ) => void
  ) => {
    resolveAll(hostname, (error, addresses) => {
      if (error) {
        callback(error, '');
        return;
      }
      const blocked = addresses.find((entry) => isPrivateAddress(entry.address));
      if (addresses.length === 0 || blocked) {
        callback(
          new Error(
            blocked
              ? `Refusing to download the image: ${hostname} resolves to a private address (${blocked.address}).`
              : `Refusing to download the image: ${hostname} did not resolve to any address.`
          ),
          ''
        );
        return;
      }
      if (options.all) {
        callback(null, addresses);
        return;
      }
      const [first] = addresses as [LookupAddress, ...LookupAddress[]];
      callback(null, first.address, first.family);
    });
  };
  return lookup as unknown as LookupFunction;
}

export type DownloadedVisionImage = {
  data: Uint8Array;
  mediaType: string;
};

export type DownloadVisionImageOptions = {
  abortSignal?: AbortSignal;
  /** Override for tests. Defaults to the pinned DNS lookup. */
  lookup?: LookupFunction;
  maxBytes?: number;
};

function requestOnce(
  url: URL,
  lookup: LookupFunction,
  signal: AbortSignal
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? requestHttps : requestHttp;
    const request = send(url, {
      headers: { accept: 'image/*', 'user-agent': 'NextBlock-Cortex-AI' },
      lookup,
      method: 'GET',
      signal,
    });
    request.on('response', resolve);
    request.on('error', reject);
    request.end();
  });
}

async function readBody(response: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > maxBytes) {
      response.destroy();
      throw new Error(`The image is larger than the ${maxBytes}-byte limit for alt-text generation.`);
    }
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** The media type from the first bytes, for servers that send no or a generic Content-Type. */
export function sniffImageMediaType(bytes: Uint8Array): string | null {
  const at = (index: number) => bytes[index];
  if (bytes.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) {
    return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
    at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
  ) {
    return 'image/webp';
  }
  if (bytes.length >= 12 && at(4) === 0x66 && at(5) === 0x74 && at(6) === 0x79 && at(7) === 0x70) {
    const brand = String.fromCharCode(...bytes.subarray(8, 12));
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }
  return null;
}

export async function downloadCortexVisionImage(
  url: URL,
  options: DownloadVisionImageOptions = {}
): Promise<DownloadedVisionImage> {
  const lookup = options.lookup ?? createPinnedLookup();
  const maxBytes = options.maxBytes ?? CORTEX_AI_VISION_MAX_IMAGE_BYTES;
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)])
    : AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);

  let current = url;
  for (let redirects = 0; ; redirects++) {
    if (current.protocol !== 'https:' && current.protocol !== 'http:') {
      throw new Error(`Refusing to download the image: ${current.protocol} URLs are not allowed.`);
    }
    // IP literals never reach `lookup`, so this check is what covers them.
    const host = current.hostname.replace(/^\[|\]$/g, '');
    if (isBlockedFetchHost(host) || (isIP(host) !== 0 && isPrivateAddress(host))) {
      throw new Error(`Refusing to download the image from ${current.hostname}: private or local host.`);
    }

    const response = await requestOnce(current, lookup, signal);
    const status = response.statusCode ?? 0;

    if (status >= 300 && status < 400 && response.headers.location) {
      response.resume();
      if (redirects >= MAX_REDIRECTS) {
        throw new Error('Too many redirects while downloading the image.');
      }
      current = new URL(response.headers.location, current);
      continue;
    }

    if (status < 200 || status >= 300) {
      response.resume();
      throw new Error(`The image URL answered HTTP ${status}.`);
    }

    const data = await readBody(response, maxBytes);
    const [declaredType = ''] = String(response.headers['content-type'] ?? '').split(';');
    const declared = declaredType.trim().toLowerCase();
    const mediaType = declared.startsWith('image/') ? declared : sniffImageMediaType(data);

    if (!mediaType) {
      throw new Error(`The URL did not return an image (Content-Type: ${declared || 'none'}).`);
    }

    return { data, mediaType };
  }
}
