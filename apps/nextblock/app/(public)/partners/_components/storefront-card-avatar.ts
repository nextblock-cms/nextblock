import 'server-only';

import { resolveMediaUrl } from '../../../../lib/media/resolveMediaUrl';
import { resolveMediaBaseUrl } from '../../../../lib/storage/provider';
import { getStorefrontMediaOrigins } from './storefront-loader';

/**
 * The partner avatar for the Open Graph card, fetched server-side and therefore held to the
 * strictest rule: the URL is built from the server-set object key and must land on THIS deployment's
 * media origin (never the site, never a stock host, never a partner-supplied URL); no redirects, a
 * 5 s timeout, at most 2 MB, PNG or JPEG only (content type AND magic bytes). Anything else, or any
 * failure, is null and the card draws initials.
 */

export const STOREFRONT_CARD_AVATAR_TIMEOUT_MS = 5_000;
export const STOREFRONT_CARD_AVATAR_MAX_BYTES = 2 * 1024 * 1024;

function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** Read a body up to `max` bytes; null (and the stream cancelled) past it. */
async function readCapped(body: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The avatar as a data URL, or null (see the module comment for every rule). Never throws. */
export async function loadStorefrontCardAvatar(objectKey: string | null): Promise<string | null> {
  if (!objectKey) return null;
  try {
    const resolved = resolveMediaUrl(objectKey, resolveMediaBaseUrl());
    if (!resolved || !/^https?:\/\//i.test(resolved)) return null;
    const url = new URL(resolved);
    if (url.username || url.password || !getStorefrontMediaOrigins().has(url.origin.toLowerCase())) return null;

    const response = await fetch(url.href, {
      redirect: 'error',
      signal: AbortSignal.timeout(STOREFRONT_CARD_AVATAR_TIMEOUT_MS),
      cache: 'no-store',
      headers: { accept: 'image/png,image/jpeg' },
    });
    if (!response.ok || !response.body) return null;

    const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (type !== 'image/png' && type !== 'image/jpeg') {
      await response.body.cancel().catch(() => undefined);
      return null;
    }
    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > STOREFRONT_CARD_AVATAR_MAX_BYTES) {
      await response.body.cancel().catch(() => undefined);
      return null;
    }

    const bytes = await readCapped(response.body, STOREFRONT_CARD_AVATAR_MAX_BYTES);
    if (!bytes || !(type === 'image/png' ? isPng(bytes) : isJpeg(bytes))) return null;
    return `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
  } catch {
    return null;
  }
}
