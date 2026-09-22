import { unstable_cache } from 'next/cache';
import { NextResponse, type NextRequest } from 'next/server';

import {
  APP_ICON_VARIANTS,
  STATIC_APP_ICONS,
  isAppIconVariant,
  type AppIconVariant,
} from '../../../../../lib/branding/app-icon';
import { loadAppIconContext } from '../../../../../lib/branding/app-icon-context';
import { fetchLogoBytes, renderAppIcon } from '../../../../../lib/branding/render-app-icon';
import { isSupabaseConfigured } from '../../../../../lib/setup/env-status';

// The installed-app icons (manifest icons and the iOS apple-touch-icon), rendered from the
// active logo: /api/brand/app-icon/192, /512, /maskable-512 and /apple-180. The manifest
// and the root layout link here with `?v=<version>` only when the site has a logo of its
// own; otherwise they link the static files in public/favicon/ directly.
//
// Rendered at request time, not prerendered: a build-time render would fetch remote logos
// during `next build` and bake in whatever fallback it hit. The PNG is kept in the Data
// Cache under its version, so each logo is rendered once per variant, and a `?v=` that
// matches the current version is served as immutable.
//
// It never errors at the client: no logo, an unconfigured install or any failure (fetch
// timeout, undecodable file) 307s to the static NextBlock icon. Failure redirects are
// `no-store`, so a transient problem is retried instead of pinned.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// A week; the key already carries the version, so this only bounds storage.
const RENDER_CACHE_SECONDS = 60 * 60 * 24 * 7;
const IMMUTABLE = 'public, max-age=31536000, s-maxage=31536000, immutable';
const SHORT_LIVED = 'public, max-age=300, s-maxage=300';

interface RenderKey {
  variant: AppIconVariant;
  url: string;
  /** Fill of the opaque variants. */
  background: string;
  /** Not read by the renderer: it keys the entry, covering a re-upload behind the same URL. */
  version: string;
}

// The argument is part of the cache key, and a throw is not cached. Stored as base64
// because the Data Cache holds JSON.
const getRenderedAppIcon = unstable_cache(
  async ({ variant, url, background }: RenderKey): Promise<string> => {
    const png = await renderAppIcon(await fetchLogoBytes(url), APP_ICON_VARIANTS[variant], background);
    return png.toString('base64');
  },
  ['brand-app-icon'],
  { revalidate: RENDER_CACHE_SECONDS, tags: ['public-app-icon'] }
);

function redirectToStaticIcon(request: NextRequest, variant: AppIconVariant, cacheControl: string) {
  const response = NextResponse.redirect(new URL(STATIC_APP_ICONS[variant], request.url), 307);
  response.headers.set('Cache-Control', cacheControl);
  return response;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ variant: string }> }
) {
  const { variant } = await params;
  if (!isAppIconVariant(variant)) {
    return new NextResponse('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }

  if (!isSupabaseConfigured()) {
    return redirectToStaticIcon(request, variant, 'no-store');
  }

  try {
    const { background, source } = await loadAppIconContext();
    if (source.kind === 'default') {
      return redirectToStaticIcon(request, variant, SHORT_LIVED);
    }

    const png = Buffer.from(
      await getRenderedAppIcon({ variant, url: source.url, background, version: source.version }),
      'base64'
    );

    return new NextResponse(png, {
      headers: {
        'Content-Type': 'image/png',
        // An old or missing `?v=` still gets the current icon, but only briefly.
        'Cache-Control': request.nextUrl.searchParams.get('v') === source.version ? IMMUTABLE : SHORT_LIVED,
      },
    });
  } catch (error) {
    console.warn(`[app-icon] Could not render the ${variant} icon from the active logo; serving the default.`, error);
    return redirectToStaticIcon(request, variant, 'no-store');
  }
}
