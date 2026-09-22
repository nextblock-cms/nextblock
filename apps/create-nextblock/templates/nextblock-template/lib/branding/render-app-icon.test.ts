import { crc32, deflateSync } from 'node:zlib';

import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { APP_ICON_VARIANTS } from './app-icon';
import { fetchLogoBytes, MAX_LOGO_BYTES, renderAppIcon } from './render-app-icon';

// Real sharp, no mocks: these pin the geometry the manifest promises (sizes, opacity, the
// maskable safe zone) and the failure modes the route falls back on.

const NAVY = { r: 15, g: 23, b: 42 };
const BACKGROUND = '#ffffff';

// A 5:1 wordmark with transparent margins around a solid bar, the hardest common shape.
const WORDMARK_SVG = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="120" viewBox="0 0 600 120">
     <rect x="30" y="20" width="540" height="80" fill="rgb(${NAVY.r},${NAVY.g},${NAVY.b})"/>
   </svg>`
);

/** A structurally valid PNG that declares `width` x `height` but carries one byte of data. */
function pngHeaderOnly(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(1))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function pixels(png: Buffer) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number) => {
    const offset = (y * info.width + x) * 4;
    return { r: data[offset], g: data[offset + 1], b: data[offset + 2], a: data[offset + 3] };
  };
  return { at, info };
}

describe('renderAppIcon', () => {
  it('renders an SVG wordmark into a 512 square PNG with transparent corners', async () => {
    const png = await renderAppIcon(WORDMARK_SVG, APP_ICON_VARIANTS['512'], BACKGROUND);
    const meta = await sharp(png).metadata();

    expect(meta).toMatchObject({ format: 'png', width: 512, height: 512 });
    const { at } = await pixels(png);
    expect(at(0, 0).a).toBe(0);
    expect(at(511, 511).a).toBe(0);
    // The centre is the logo, and the trimmed bar spans the padded width.
    expect(at(256, 256)).toMatchObject({ ...NAVY, a: 255 });
    expect(at(30, 256).a).toBe(255);
    expect(at(481, 256).a).toBe(255);
  });

  it('renders the 192 variant at 192 px', async () => {
    const png = await renderAppIcon(WORDMARK_SVG, APP_ICON_VARIANTS['192'], BACKGROUND);
    expect(await sharp(png).metadata()).toMatchObject({ width: 192, height: 192 });
  });

  it('renders opaque maskable and apple icons', async () => {
    const maskable = await renderAppIcon(WORDMARK_SVG, APP_ICON_VARIANTS['maskable-512'], BACKGROUND);
    const apple = await renderAppIcon(WORDMARK_SVG, APP_ICON_VARIANTS['apple-180'], 'hsl(222, 47%, 4%)');

    expect((await sharp(maskable).stats()).isOpaque).toBe(true);
    expect((await sharp(apple).stats()).isOpaque).toBe(true);
    expect(await sharp(apple).metadata()).toMatchObject({ width: 180, height: 180, channels: 3 });

    // The theme background fills the corners (hsl(222, 47%, 4%) ≈ rgb(5, 8, 15)).
    const { at } = await pixels(apple);
    expect(at(0, 0)).toMatchObject({ a: 255 });
    expect(at(0, 0).r).toBeLessThan(10);
  });

  it('keeps the maskable logo inside the safe circle (radius 40%)', async () => {
    const png = await renderAppIcon(WORDMARK_SVG, APP_ICON_VARIANTS['maskable-512'], BACKGROUND);
    const { at, info } = await pixels(png);
    const centre = info.width / 2;
    const radius = 0.4 * info.width;

    let outsideMismatches = 0;
    let insideLogo = 0;
    for (let y = 0; y < info.height; y += 2) {
      for (let x = 0; x < info.width; x += 2) {
        const pixel = at(x, y);
        const isBackground = pixel.r === 255 && pixel.g === 255 && pixel.b === 255;
        if (Math.hypot(x + 0.5 - centre, y + 0.5 - centre) > radius) {
          if (!isBackground) outsideMismatches += 1;
        } else if (!isBackground) {
          insideLogo += 1;
        }
      }
    }

    expect(outsideMismatches).toBe(0);
    expect(insideLogo).toBeGreaterThan(0);
  });

  it('does not trim an opaque badge', async () => {
    // A solid square with no transparency: it must fill the padded box edge to edge.
    const badge = await sharp({
      create: { width: 300, height: 300, channels: 3, background: { r: 200, g: 30, b: 30 } },
    })
      .png()
      .toBuffer();
    const png = await renderAppIcon(badge, APP_ICON_VARIANTS['512'], BACKGROUND);
    const { at } = await pixels(png);

    expect(at(0, 0).a).toBe(0);
    expect(at(25, 25)).toMatchObject({ r: 200, g: 30, b: 30, a: 255 });
  });

  it('decodes an AVIF logo', async () => {
    const avif = await sharp({
      create: { width: 200, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        {
          input: await sharp({ create: { width: 120, height: 60, channels: 3, background: NAVY } }).png().toBuffer(),
          left: 40,
          top: 20,
        },
      ])
      .avif()
      .toBuffer();

    const png = await renderAppIcon(avif, APP_ICON_VARIANTS['maskable-512'], BACKGROUND);
    expect(await sharp(png).metadata()).toMatchObject({ format: 'png', width: 512, height: 512 });
  });

  it('throws on bytes that are not an image', async () => {
    await expect(
      renderAppIcon(Buffer.from('definitely not an image'), APP_ICON_VARIANTS['512'], BACKGROUND)
    ).rejects.toThrow();
  });

  it('throws on a logo with no visible pixels', async () => {
    const empty = await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    await expect(renderAppIcon(empty, APP_ICON_VARIANTS['512'], BACKGROUND)).rejects.toThrow(/no visible pixels/);
  });

  it('rejects a canvas above the pixel limit before decoding it', async () => {
    // A 66-byte PNG whose header declares 8000 x 8000 (64 MP): the classic decompression
    // bomb shape. It must be refused from the header alone.
    await expect(renderAppIcon(pngHeaderOnly(8000, 8000), APP_ICON_VARIANTS['512'], BACKGROUND)).rejects.toThrow(
      /pixel limit/i
    );
  });
});

describe('fetchLogoBytes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the body of a successful response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))));
    expect([...(await fetchLogoBytes('https://media.example.com/logo.png'))]).toEqual([1, 2, 3]);
  });

  it('rejects a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    await expect(fetchLogoBytes('https://media.example.com/logo.png')).rejects.toThrow(/404/);
  });

  it('rejects a declared length above the upload limit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x', { headers: { 'content-length': String(MAX_LOGO_BYTES + 1) } }))
    );
    await expect(fetchLogoBytes('https://media.example.com/logo.png')).rejects.toThrow(/larger than/);
  });

  it('stops reading a body that grows past the upload limit', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength;
        controller.enqueue(chunk);
        if (sent > MAX_LOGO_BYTES * 2) controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream)));
    await expect(fetchLogoBytes('https://media.example.com/logo.png')).rejects.toThrow(/larger than/);
  });
});
