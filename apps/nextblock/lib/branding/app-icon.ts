import { createHash } from 'node:crypto';
import type { MetadataRoute } from 'next';

import { DEFAULT_SITE_TITLE } from '../../app/lib/seo';
import { pickOriginalUploadObjectKey, type MediaWithVariants } from '../media/original-upload';
import { resolveMediaUrl } from '../media/resolveMediaUrl';

/**
 * The installed-app icon (PWA manifest icons and the iOS home-screen icon), derived from
 * the site's active logo. Pure helpers only: the sharp renderer is ./render-app-icon.ts,
 * the request-time reads are ./app-icon-context.ts, and the bytes are served by
 * app/api/brand/app-icon/[variant]/route.ts.
 *
 * A site whose active logo is still the bundled NextBlock one (every fresh install and
 * the sandbox), or whose media has no absolute URL, keeps the static icons in
 * public/favicon/. The browser-tab favicon always stays static: a wordmark is illegible
 * at 16 or 32 pixels.
 */

export interface AppIconSpec {
  /** Output width and height in pixels. */
  size: number;
  /** Paint the whole square with the background colour (maskable and iOS icons). */
  opaque: boolean;
  /** Margin on each side, as a fraction of `size`, for icons shown as-is. */
  pad?: number;
  /**
   * Diameter of the circle the logo must fit inside, as a fraction of `size`. Maskable
   * icons are cropped by the launcher to any shape that contains the W3C safe zone, a
   * centred circle of radius 40%, so the whole logo, corners included, must sit in it.
   */
  safeDiameter?: number;
}

export const APP_ICON_VARIANTS = {
  '192': { size: 192, opaque: false, pad: 0.04 },
  '512': { size: 512, opaque: false, pad: 0.04 },
  'maskable-512': { size: 512, opaque: true, safeDiameter: 0.8 },
  // iOS paints a transparent apple-touch-icon on black and applies its own rounded mask.
  'apple-180': { size: 180, opaque: true, pad: 0.12 },
} as const satisfies Record<string, AppIconSpec>;

export type AppIconVariant = keyof typeof APP_ICON_VARIANTS;

/** The shipped NextBlock icons, used when the site has no logo of its own to render. */
export const STATIC_APP_ICONS: Record<AppIconVariant, string> = {
  '192': '/favicon/android-chrome-192x192.png',
  '512': '/favicon/android-chrome-512x512.png',
  'maskable-512': '/favicon/maskable-512x512.png',
  'apple-180': '/favicon/apple-touch-icon.png',
};

/**
 * Bump when the renderer's output changes (margins, safe zone, trimming), so every
 * installed icon URL gets a new `?v=` and browsers and CDNs drop the old bytes.
 */
export const APP_ICON_RENDER_VERSION = 1;

export function isAppIconVariant(value: string): value is AppIconVariant {
  return Object.prototype.hasOwnProperty.call(APP_ICON_VARIANTS, value);
}

// A separator is a pipe or dash with whitespace on both sides (or a title edge), or a
// colon followed by whitespace. Plain spaces, bare hyphens and clock times never split:
// "Rock-n-Roll Café" and "Café 10:30" stay whole.
const BRAND_SEPARATOR = /(?:^|\s)\s*[|–—-](?=\s|$)\s*|:(?=\s|$)\s*/;

/**
 * The brand part of a site title, for the installed app's name and the iOS home-screen
 * label: "Acme Bakery | Fresh bread daily" → "Acme Bakery",
 * "NextBlock™ CMS: Developer-First…" → "NextBlock™ CMS". Never truncated: launchers
 * ellipsize a long label themselves, and a cut word reads worse than an ellipsis.
 */
export function brandNameFromTitle(title: string | null | undefined): string {
  const raw = typeof title === 'string' ? title : '';
  const segment = raw
    .split(BRAND_SEPARATOR)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .find((part) => part.length > 0);

  return segment || raw.trim() || DEFAULT_SITE_TITLE;
}

/** The slice of the active logo row (joined with its media) the icon source reads. */
export interface AppIconLogoLike {
  id: string;
  media:
    | (MediaWithVariants & { id?: string | null; updated_at?: string | null })
    | null;
}

export type AppIconSource =
  | { kind: 'default' }
  | {
      kind: 'logo';
      /** Absolute URL of the logo file to render. */
      url: string;
      /** Short hash that changes whenever the rendered bytes would. */
      version: string;
    };

export const DEFAULT_APP_ICON_SOURCE: AppIconSource = { kind: 'default' };

/**
 * Where the app icon comes from. The logo's ORIGINAL upload is preferred over the AVIF
 * derivative the site renders (sharper, and an SVG stays vector until it is rasterised at
 * icon size). Only a file inside the site's own media store is rendered; anything else
 * means "use the static icons": no logo, a bundled `images/…` key (the seeded NextBlock
 * logo resolves to a relative path), an install with no media host, or a media row whose
 * key is an absolute URL elsewhere. The server fetches this URL, so it must never be a
 * host a CMS user can pick (an internal address, a metadata endpoint).
 */
export function resolveAppIconSource(
  logo: AppIconLogoLike | null | undefined,
  options: { mediaBaseUrl: string; background: string }
): AppIconSource {
  const media = logo?.media ?? null;
  if (!logo || !media) return DEFAULT_APP_ICON_SOURCE;

  const mediaBase = options.mediaBaseUrl.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(mediaBase)) return DEFAULT_APP_ICON_SOURCE;

  const objectKey = pickOriginalUploadObjectKey(media);
  const url = objectKey ? resolveMediaUrl(objectKey, mediaBase) : null;
  if (!url || !url.startsWith(`${mediaBase}/`)) return DEFAULT_APP_ICON_SOURCE;

  // Everything the rendered bytes depend on: which logo, which file (a re-upload bumps the
  // media row's updated_at), the background the opaque variants are painted on, and the
  // renderer itself.
  const fingerprint = [
    logo.id,
    media.id ?? '',
    objectKey,
    media.updated_at ?? '',
    options.background,
    APP_ICON_RENDER_VERSION,
  ].join('|');
  const version = createHash('sha1').update(fingerprint).digest('hex').slice(0, 12);

  return { kind: 'logo', url, version };
}

/** The URL a page or the manifest should reference for one icon variant. */
export function appIconHref(variant: AppIconVariant, source: AppIconSource): string {
  return source.kind === 'logo'
    ? `/api/brand/app-icon/${variant}?v=${source.version}`
    : STATIC_APP_ICONS[variant];
}

/**
 * The web app manifest served at /manifest.webmanifest. `id`, `scope` and `start_url`
 * are all '/': `id` matches the identity browsers derived from `start_url` before it was
 * declared, so apps that were already installed keep theirs.
 */
export function buildWebManifest(input: {
  siteTitle: string;
  siteDescription?: string | null;
  background: string;
  source: AppIconSource;
}): MetadataRoute.Manifest {
  const brand = brandNameFromTitle(input.siteTitle);

  return {
    id: '/',
    name: brand,
    short_name: brand,
    description: input.siteDescription || undefined,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: input.background,
    theme_color: input.background,
    icons: [
      { src: appIconHref('192', input.source), sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: appIconHref('512', input.source), sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: appIconHref('maskable-512', input.source),
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
