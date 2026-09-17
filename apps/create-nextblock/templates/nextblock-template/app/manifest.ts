import type { MetadataRoute } from 'next';

import { isSupabaseConfigured } from '../lib/setup/env-status';
import { themeColorFor } from '../lib/themes/buildThemeCss';
import { getCachedSiteThemes } from '../lib/themes/cached-site-themes';
import { getSiteSettings } from './lib/site-settings';

/**
 * Web app manifest, served at `/manifest.webmanifest`.
 *
 * It replaces `public/favicon/site.webmanifest`, which shipped an empty `name` and
 * `short_name` (an installed site had no title) and icon paths at the public root while the
 * files live in `/favicon/`. The name comes from the Branding settings and the colours from
 * the default theme, so an operator never has to edit a JSON file.
 */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const { siteTitle, siteDescription } = await getSiteSettings();
  const themes = isSupabaseConfigured() ? await getCachedSiteThemes().catch(() => []) : [];
  const background = themeColorFor(themes);

  return {
    name: siteTitle,
    // Home-screen labels truncate around a dozen characters.
    short_name: siteTitle.length > 12 ? siteTitle.split(/[\s|:–—-]+/)[0].slice(0, 12) || siteTitle.slice(0, 12) : siteTitle,
    description: siteDescription || undefined,
    start_url: '/',
    display: 'standalone',
    background_color: background,
    theme_color: background,
    icons: [
      { src: '/favicon/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
      { src: '/favicon/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}
