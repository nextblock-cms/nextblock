import 'server-only';

import sharp from 'sharp';

import type { AppIconSpec } from './app-icon';

/**
 * Rasterises a logo into one square app icon with sharp. It runs server-side only: from
 * the app icon route, and from tools/scripts/generate-default-app-icons.mts (run under
 * the `react-server` condition), which renders the static NextBlock defaults with this
 * same code so they match what a custom logo gets.
 *
 * sharp rather than next/og: the logo is an arbitrary upload (PNG, JPEG, WebP, SVG, or the
 * AVIF derivative), and Satori cannot decode AVIF or WebP.
 */

export const LOGO_FETCH_TIMEOUT_MS = 5_000;
/** The media library's upload limit. */
export const MAX_LOGO_BYTES = 10 * 1024 * 1024;
/** Decompression-bomb guard: a small file can declare an enormous canvas. */
export const MAX_INPUT_PIXELS = 40_000_000;

// Working resolution after decoding. The largest icon is 512 px, so anything above this
// only costs memory in the trim scan.
const WORKING_MAX_SIDE = 2048;
// An SVG is rasterised at a density that puts its longest side here, capped so a tiny
// viewBox cannot ask librsvg for an absurd density.
const SVG_TARGET_LONGEST_SIDE = 1024;
const SVG_MAX_DENSITY = 2400;
// Alpha at or below this counts as transparent when trimming margins (anti-aliasing and
// export noise leave faint pixels in "empty" areas).
const TRIM_ALPHA_THRESHOLD = 8;
// Keep the maskable logo about 2% inside the safe circle, so resampling never pushes a
// corner pixel across it.
const SAFE_ZONE_SLACK = 0.98;

/**
 * Download a logo for rendering. Anonymous (no credentials or cookies are forwarded), 5 s
 * timeout, and capped at the upload limit both by the declared length and while
 * streaming. The content type is not trusted: sharp sniffs the format from the bytes.
 * Redirects are refused: the caller only passes URLs inside the site's media store, and a
 * redirect could lead the server anywhere.
 */
export async function fetchLogoBytes(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(LOGO_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Logo fetch failed with HTTP ${response.status}.`);
  }

  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_LOGO_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Logo is larger than ${MAX_LOGO_BYTES} bytes.`);
  }

  if (!response.body) {
    throw new Error('Logo response has no body.');
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_LOGO_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`Logo is larger than ${MAX_LOGO_BYTES} bytes.`);
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks);
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Bounding box of the pixels whose alpha is above the trim threshold, in RGBA raw data. */
function visibleBoundingBox(data: Buffer, width: number, height: number): Box | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    const row = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      if (data[row + x * 4 + 3] > TRIM_ALPHA_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  return maxX < 0 ? null : { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Render one icon variant as a PNG. Throws on anything sharp cannot decode, on an
 * oversized canvas, and on a logo with no visible pixels; the caller falls back to the
 * static icon.
 *
 * - Transparent margins are trimmed (only when the top-left pixel is fully transparent),
 *   so a logo exported with generous padding still fills the icon. An opaque badge is
 *   never trimmed: its background is part of the art.
 * - `pad` variants fit the logo inside the square minus that margin on each side.
 * - `safeDiameter` (maskable) variants scale the logo so its diagonal fits the safe
 *   circle, whatever shape the launcher crops to.
 * - `opaque` variants are painted on `background` (the default theme's page colour, which
 *   the header logo already sits on) and carry no alpha channel.
 */
export async function renderAppIcon(
  bytes: Buffer | Uint8Array,
  spec: AppIconSpec,
  background: string
): Promise<Buffer> {
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const size = spec.size;

  const probe = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, animated: false }).metadata();
  let density: number | undefined;
  if (probe.format === 'svg') {
    const longest = Math.max(probe.width ?? 0, probe.height ?? 0) || SVG_TARGET_LONGEST_SIDE;
    density = Math.min(SVG_MAX_DENSITY, Math.max(1, (72 * SVG_TARGET_LONGEST_SIDE) / longest));
  }

  const decoded = await sharp(input, {
    limitInputPixels: MAX_INPUT_PIXELS,
    animated: false,
    ...(density ? { density } : {}),
  })
    .rotate()
    .resize({ width: WORKING_MAX_SIDE, height: WORKING_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { data, info } = decoded;
  if (info.channels !== 4) {
    throw new Error(`Unexpected ${info.channels}-channel logo after decoding.`);
  }

  let crop: Box = { left: 0, top: 0, width: info.width, height: info.height };
  if (data[3] === 0) {
    const visible = visibleBoundingBox(data, info.width, info.height);
    if (!visible) throw new Error('Logo has no visible pixels.');
    crop = visible;
  }

  let scale: number;
  if (spec.safeDiameter) {
    scale = (spec.safeDiameter * size * SAFE_ZONE_SLACK) / Math.hypot(crop.width, crop.height);
  } else {
    const inner = size * (1 - 2 * (spec.pad ?? 0));
    scale = Math.min(inner / crop.width, inner / crop.height);
  }
  const logoWidth = Math.max(1, Math.round(crop.width * scale));
  const logoHeight = Math.max(1, Math.round(crop.height * scale));

  const logo = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .extract(crop)
    .resize(logoWidth, logoHeight, { fit: 'fill' })
    .png()
    .toBuffer();

  const composed = await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: spec.opaque ? background : { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: logo,
        left: Math.floor((size - logoWidth) / 2),
        top: Math.floor((size - logoHeight) / 2),
      },
    ])
    .png()
    .toBuffer();

  // Composite runs last in a sharp pipeline, so dropping the alpha channel of the opaque
  // variants takes a second pass. flatten() also guards against a translucent background.
  const output = spec.opaque ? sharp(composed).flatten({ background }) : sharp(composed);
  return output.png({ compressionLevel: 9 }).toBuffer();
}
