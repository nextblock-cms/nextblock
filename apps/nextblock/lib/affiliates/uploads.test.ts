import { crc32 } from 'node:zlib';

import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

/**
 * Partner upload helpers with the real sharp: magic-byte sniffing (SVG and other formats never
 * reach the decoder), decode limits, the JPEG re-encode, key building and the throttle.
 */

vi.mock('@nextblock-cms/db/server', () => ({ getServiceRoleSupabaseClient: vi.fn() }));
vi.mock('@nextblock-cms/utils/server', () => ({ getS3Client: vi.fn() }));
vi.mock('../storage/provider', () => ({
  getStorageBackend: () => 's3',
  getStorageBucket: () => 'media',
  resolveMediaBaseUrl: () => 'https://media.test',
}));
vi.mock('../storage/supabase-storage', () => ({ supabaseUploadObject: vi.fn(), supabaseRemoveObjects: vi.fn() }));

import {
  AFFILIATE_UPLOAD_LIMITS,
  AffiliateUploadError,
  affiliateUploadPrefix,
  buildAffiliateUploadKey,
  createAffiliateUploadDecodeGate,
  createAffiliateUploadThrottle,
  formatAffiliateUploadTimestamp,
  isOwnAffiliateAvatarKey,
  isSameOriginUploadRequest,
  largestAvifCodedPixels,
  processAffiliateUploadImage,
  readAffiliateUploadBody,
  resolveAffiliateUploadUrl,
  sniffAffiliateImageFormat,
} from './uploads';

const AFFILIATE = '0f8a1c2e-3b4d-4e5f-8a9b-1c2d3e4f5a6b';

async function image(format: 'png' | 'jpeg' | 'webp' | 'gif' | 'avif', width = 64, height = 48): Promise<Buffer> {
  const base = sharp({ create: { width, height, channels: 4, background: { r: 200, g: 40, b: 90, alpha: 0.6 } } });
  return base.toFormat(format).toBuffer();
}

/** A real PNG whose header claims other dimensions (a decompression-bomb shape). */
function withPngDimensions(png: Buffer, width: number, height: number): Buffer {
  const copy = Buffer.from(png);
  copy.writeUInt32BE(width, 16);
  copy.writeUInt32BE(height, 20);
  copy.writeUInt32BE(crc32(copy.subarray(12, 29)) >>> 0, 29);
  return copy;
}

async function expectRefusal(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(AffiliateUploadError);
  await promise.catch((error: AffiliateUploadError) => expect(error.code).toBe(code));
}

describe('sniffAffiliateImageFormat', () => {
  it('recognises the five accepted formats by their bytes', async () => {
    expect(sniffAffiliateImageFormat(await image('png'))).toBe('png');
    expect(sniffAffiliateImageFormat(await image('jpeg'))).toBe('jpeg');
    expect(sniffAffiliateImageFormat(await image('webp'))).toBe('webp');
    expect(sniffAffiliateImageFormat(await image('gif'))).toBe('gif');
    expect(sniffAffiliateImageFormat(await image('avif'))).toBe('avif');
  });

  it('refuses SVG, HEIC-like boxes, HTML, PDF and short input', () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    expect(sniffAffiliateImageFormat(encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffAffiliateImageFormat(encode('  <?xml version="1.0"?><svg/>'))).toBeNull();
    expect(sniffAffiliateImageFormat(encode('<!doctype html><script>alert(1)</script>'))).toBeNull();
    expect(sniffAffiliateImageFormat(encode('%PDF-1.7 something else'))).toBeNull();
    const heic = new Uint8Array([0, 0, 0, 24, ...encode('ftypheic'), 0, 0, 0, 0, ...encode('mif1heic')]);
    expect(sniffAffiliateImageFormat(heic)).toBeNull();
    expect(sniffAffiliateImageFormat(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });
});

describe('processAffiliateUploadImage', () => {
  it('re-encodes an avatar to a 512x512 JPEG, flattening transparency', async () => {
    const out = await processAffiliateUploadImage(await image('png', 900, 300), 'avatar');
    expect(out.contentType).toBe('image/jpeg');
    expect([out.width, out.height]).toEqual([512, 512]);
    const meta = await sharp(out.data).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.hasAlpha).toBe(false);
    expect(meta.exif).toBeUndefined();
  });

  it('caps a storefront image at 1600 px wide and never enlarges a small one', async () => {
    const wide = await processAffiliateUploadImage(await image('webp', 3200, 1000), 'image');
    expect([wide.width, wide.height]).toEqual([1600, 500]);
    const small = await processAffiliateUploadImage(await image('gif', 200, 100), 'image');
    expect([small.width, small.height]).toEqual([200, 100]);
    const avif = await processAffiliateUploadImage(await image('avif', 120, 80), 'image');
    expect((await sharp(avif.data).metadata()).format).toBe('jpeg');
  });

  it('strips EXIF metadata (and applies the orientation)', async () => {
    const tagged = await sharp(await image('jpeg', 80, 40))
      .withExif({ IFD0: { Copyright: 'secret-gps-owner', ImageDescription: 'private' } })
      .jpeg()
      .toBuffer();
    expect((await sharp(tagged).metadata()).exif).toBeDefined();
    const out = await processAffiliateUploadImage(tagged, 'image');
    expect((await sharp(out.data).metadata()).exif).toBeUndefined();
    expect(out.data.includes(Buffer.from('secret-gps-owner'))).toBe(false);
  });

  it('refuses SVG before any decoder runs, and bytes that only look like an image', async () => {
    await expectRefusal(
      processAffiliateUploadImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"/>'), 'image'),
      'unsupported_type',
    );
    await expectRefusal(processAffiliateUploadImage(new TextEncoder().encode('definitely not an image at all'), 'avatar'), 'unsupported_type');
    const png = await image('png');
    await expectRefusal(processAffiliateUploadImage(Buffer.concat([png.subarray(0, 40), Buffer.alloc(200, 7)]), 'image'), 'invalid_image');
  });

  it('refuses a header that declares more than 50 million pixels', async () => {
    const bomb = withPngDimensions(await image('png', 10, 10), 20_000, 20_000);
    await expectRefusal(processAffiliateUploadImage(bomb, 'image'), 'invalid_image');
  });

  // libheif decodes an AVIF's full frame at ~18-25 bytes per pixel (5-9x JPEG/PNG/WebP), so a
  // ~1 KB AVIF just under the 50 M pixel cap took ~0.9-1.2 GB to decode (2026-10-27 review).
  it('caps AVIF far lower than the other formats (a real, decodable AVIF just over the cap)', async () => {
    const side = Math.ceil(Math.sqrt(AFFILIATE_UPLOAD_LIMITS.maxAvifInputPixels)) + 1;
    expect(AFFILIATE_UPLOAD_LIMITS.maxAvifInputPixels).toBeLessThanOrEqual(12_000_000);
    const avif = await sharp({ create: { width: side, height: side, channels: 3, background: '#3366aa' } }).avif({ effort: 0 }).toBuffer();
    expect(avif.byteLength).toBeLessThan(10_000);
    await expectRefusal(processAffiliateUploadImage(avif, 'image'), 'invalid_image');
    await expectRefusal(processAffiliateUploadImage(avif, 'avatar'), 'invalid_image');

    // The same dimensions as a JPEG still go through: the tighter cap is AVIF-only.
    const jpeg = await sharp({ create: { width: side, height: side, channels: 3, background: '#3366aa' } }).jpeg().toBuffer();
    const out = await processAffiliateUploadImage(jpeg, 'image');
    expect([out.width, out.height]).toEqual([1600, 1600]);
  });

  // 2026-10-29 fix review: sharp reports the size after a clean-aperture crop, so a container that
  // codes a 7000x7000 frame but declares a small display size passed the cap and was decoded in
  // full. The coded size (ispe) is now read from the container before any decoder runs.
  it('bounds an AVIF by the coded size its container declares, before decoding', async () => {
    const small = await image('avif', 120, 80);
    expect(largestAvifCodedPixels(small)).toBe(120 * 80);

    const tampered = Buffer.from(small);
    const at = tampered.indexOf(Buffer.from('ispe'));
    expect(at).toBeGreaterThan(0);
    tampered.writeUInt32BE(7000, at + 8);
    tampered.writeUInt32BE(7000, at + 12);
    expect(largestAvifCodedPixels(tampered)).toBe(49_000_000);
    await expectRefusal(processAffiliateUploadImage(tampered, 'image'), 'invalid_image');
  });

  it('refuses an AVIF whose coded size cannot be read (no ispe, malformed boxes)', async () => {
    const small = await image('avif', 120, 80);

    const noIspe = Buffer.from(small);
    const at = noIspe.indexOf(Buffer.from('ispe'));
    noIspe.write('xxxx', at, 'latin1');
    expect(largestAvifCodedPixels(noIspe)).toBeNull();
    await expectRefusal(processAffiliateUploadImage(noIspe, 'image'), 'invalid_image');

    const broken = Buffer.from(small);
    broken.writeUInt32BE(0x7fffffff, 0); // ftyp claims to run past the end of the file
    expect(largestAvifCodedPixels(broken)).toBeNull();
  });
});

describe('one decode at a time', () => {
  it('bounds every decode with sharp’s processing timeout, so a stuck one cannot hold the queue', async () => {
    const timeout = vi.spyOn(sharp.prototype as { timeout: (options: { seconds: number }) => unknown }, 'timeout');
    try {
      await processAffiliateUploadImage(await image('png', 40, 40), 'image');
      expect(timeout).toHaveBeenCalledWith({ seconds: AFFILIATE_UPLOAD_LIMITS.decodeTimeoutSeconds });
      expect(AFFILIATE_UPLOAD_LIMITS.decodeTimeoutSeconds).toBeGreaterThan(0);
    } finally {
      timeout.mockRestore();
    }
  });
});

describe('createAffiliateUploadDecodeGate', () => {
  it('runs one decode at a time, in arrival order', async () => {
    const gate = createAffiliateUploadDecodeGate();
    let inFlight = 0;
    let maxInFlight = 0;
    const order: number[] = [];
    const task = (id: number) => async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(id);
      inFlight -= 1;
      return id;
    };
    expect(await Promise.all([gate.run(task(1)), gate.run(task(2)), gate.run(task(3))])).toEqual([1, 2, 3]);
    expect(maxInFlight).toBe(1);
    expect(order).toEqual([1, 2, 3]);
  });

  it('keeps going after a failed decode, and hands the failure to its own caller only', async () => {
    const gate = createAffiliateUploadDecodeGate();
    const failed = gate.run(async () => {
      throw new AffiliateUploadError('invalid_image', 422);
    });
    const next = gate.run(async () => 'next');
    await expectRefusal(failed, 'invalid_image');
    expect(await next).toBe('next');
  });
});

describe('object keys', () => {
  it('builds server-side keys under the affiliate’s own prefix', () => {
    const now = new Date('2026-10-27T09:08:07.000Z');
    expect(formatAffiliateUploadTimestamp(now)).toBe('20261027090807');
    expect(buildAffiliateUploadKey('avatar', AFFILIATE, now, 'abcdef12')).toBe(`affiliates/avatars/${AFFILIATE}/20261027090807-abcdef12.jpg`);
    expect(buildAffiliateUploadKey('image', AFFILIATE.toUpperCase(), now, '0123abcd')).toBe(
      `affiliates/pages/${AFFILIATE}/20261027090807-0123abcd.jpg`,
    );
    expect(buildAffiliateUploadKey('image', AFFILIATE)).toMatch(new RegExp(`^affiliates/pages/${AFFILIATE}/\\d{14}-[0-9a-f]{8}\\.jpg$`));
  });

  it('refuses anything but a uuid id and a hex nonce', () => {
    expect(buildAffiliateUploadKey('avatar', '../../etc', new Date(), 'abcdef12')).toBeNull();
    expect(buildAffiliateUploadKey('avatar', AFFILIATE, new Date(), '../../x')).toBeNull();
    expect(buildAffiliateUploadKey('avatar', AFFILIATE, new Date('nope'), 'abcdef12')).toBeNull();
    expect(affiliateUploadPrefix('image', 'x')).toBeNull();
  });

  it('only treats this affiliate’s own avatar objects as replaceable', () => {
    expect(isOwnAffiliateAvatarKey(`affiliates/avatars/${AFFILIATE}/20261027090807-abcdef12.jpg`, AFFILIATE)).toBe(true);
    expect(isOwnAffiliateAvatarKey('affiliates/avatars/99999999-9999-4999-8999-999999999999/x.jpg', AFFILIATE)).toBe(false);
    expect(isOwnAffiliateAvatarKey('images/seeded-avatar.webp', AFFILIATE)).toBe(false);
    expect(isOwnAffiliateAvatarKey(`affiliates/avatars/${AFFILIATE}/../other/x.jpg`, AFFILIATE)).toBe(false);
    expect(isOwnAffiliateAvatarKey(`affiliates/avatars/${AFFILIATE}/`, AFFILIATE)).toBe(false);
    expect(isOwnAffiliateAvatarKey(null, AFFILIATE)).toBe(false);
  });

  it('resolves the public URL on the media origin', () => {
    expect(resolveAffiliateUploadUrl(`affiliates/pages/${AFFILIATE}/a.jpg`)).toBe(`https://media.test/affiliates/pages/${AFFILIATE}/a.jpg`);
  });
});

describe('isSameOriginUploadRequest', () => {
  const url = 'https://shop.test/api/affiliates/upload';

  it('accepts same-origin browsers and clients without fetch metadata', () => {
    expect(isSameOriginUploadRequest(new Headers({ 'sec-fetch-site': 'same-origin', origin: 'https://shop.test', host: 'shop.test' }), url)).toBe(true);
    expect(isSameOriginUploadRequest(new Headers(), url)).toBe(true);
    expect(isSameOriginUploadRequest(new Headers({ origin: 'https://shop.test', 'x-forwarded-host': 'shop.test' }), 'http://internal:3000/api')).toBe(true);
  });

  it('refuses cross-site requests and foreign origins', () => {
    expect(isSameOriginUploadRequest(new Headers({ 'sec-fetch-site': 'cross-site' }), url)).toBe(false);
    expect(isSameOriginUploadRequest(new Headers({ 'sec-fetch-site': 'same-site' }), url)).toBe(false);
    expect(isSameOriginUploadRequest(new Headers({ origin: 'https://evil.test', host: 'shop.test' }), url)).toBe(false);
    expect(isSameOriginUploadRequest(new Headers({ origin: 'null', host: 'shop.test' }), url)).toBe(false);
  });
});

describe('readAffiliateUploadBody', () => {
  it('refuses an honest oversized Content-Length before reading', async () => {
    const request = new Request('https://shop.test/x', { method: 'POST', headers: { 'content-length': '999999999' }, body: 'tiny' });
    await expectRefusal(readAffiliateUploadBody(request, 1024), 'too_large');
  });

  it('cuts a streamed body off as soon as it crosses the cap', async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(512).fill(1));
        if (pulls > 100) controller.close();
      },
    });
    const request = new Request('https://shop.test/x', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
    await expectRefusal(readAffiliateUploadBody(request, 2048), 'too_large');
    expect(pulls).toBeLessThan(10);
  });
});

describe('createAffiliateUploadThrottle', () => {
  it('allows `limit` uploads per sliding hour per affiliate', () => {
    const throttle = createAffiliateUploadThrottle({ limit: 3, windowMs: 1000 });
    expect([throttle.consume('a', 0), throttle.consume('a', 10), throttle.consume('a', 20)]).toEqual([true, true, true]);
    expect(throttle.consume('a', 30)).toBe(false);
    expect(throttle.consume('b', 30)).toBe(true);
    expect(throttle.consume('a', 1001)).toBe(true);
  });

  it('stays bounded in memory', () => {
    const throttle = createAffiliateUploadThrottle({ limit: 1, maxKeys: 2 });
    throttle.consume('a', 0);
    throttle.consume('b', 0);
    throttle.consume('c', 0);
    expect(throttle.size).toBe(2);
  });
});
