import type { LookupFunction } from 'node:net';

import { guardedFetch } from './fetch-host-guard';

// Re-exported for the callers and tests that knew them from here before they moved into
// fetch-host-guard.ts.
export { createPinnedLookup, isPrivateAddress } from './fetch-host-guard';

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
 * The SSRF protection is `guardedFetch` (fetch-host-guard.ts): the hostname is checked
 * first, the DNS lookup is PINNED, redirects are followed by hand with every hop checked
 * the same way, and the body is capped. The media type comes from Content-Type or, when
 * that is not an image type, from the file signature.
 */

/** Largest image accepted for alt-text generation. The model request inlines it as base64. */
export const CORTEX_AI_VISION_MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const DOWNLOAD_TIMEOUT_MS = 20_000;

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
  const maxBytes = options.maxBytes ?? CORTEX_AI_VISION_MAX_IMAGE_BYTES;
  const response = await guardedFetch(url, {
    abortSignal: options.abortSignal,
    headers: { accept: 'image/*', 'user-agent': 'NextBlock-Cortex-AI' },
    lookup: options.lookup,
    maxBytes,
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
  });

  if (response.status < 200 || response.status >= 300) {
    response.discard();
    throw new Error(`The image URL answered HTTP ${response.status}.`);
  }

  const data = await response.readBody();
  const mediaType = response.mediaType.startsWith('image/') ? response.mediaType : sniffImageMediaType(data);

  if (!mediaType) {
    throw new Error(`The URL did not return an image (Content-Type: ${response.mediaType || 'none'}).`);
  }

  return { data, mediaType };
}
