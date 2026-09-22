import type { MetadataRoute } from 'next';

import { buildWebManifest } from '../lib/branding/app-icon';
import { loadAppIconContext } from '../lib/branding/app-icon-context';
import { getSiteSettings } from './lib/site-settings';

/**
 * Web app manifest, served at `/manifest.webmanifest`: what a browser installs the site
 * as. Built from the site's own settings, so an operator never edits a JSON file:
 *
 * - `name` and `short_name` are the brand part of the Branding site title
 *   (`brandNameFromTitle`: "Acme Bakery | Fresh bread" installs as "Acme Bakery"),
 * - the colours are the default theme's page background,
 * - the icons are rendered from the active logo by app/api/brand/app-icon/[variant]
 *   (192 and 512 `any`, 512 `maskable`), or are the static NextBlock icons in
 *   public/favicon/ when the site has no logo of its own.
 *
 * Next serves it as an ISR route. Its cached reads tag it with `public-site-settings`,
 * `public-layout-site-themes` and `public-layout-logo`, so a title, theme or logo save
 * evicts it. The whole assembly is `buildWebManifest` in lib/branding/app-icon.ts.
 */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const [{ siteTitle, siteDescription }, { background, source }] = await Promise.all([
    getSiteSettings(),
    loadAppIconContext(),
  ]);

  return buildWebManifest({ siteTitle, siteDescription, background, source });
}
