import 'server-only';

import { getCachedActiveLogo } from '../logos/cached-active-logo';
import { isSupabaseConfigured } from '../setup/env-status';
import { resolveMediaBaseUrl } from '../storage/provider';
import { themeColorFor, type SiteTheme } from '../themes/buildThemeCss';
import { getCachedSiteThemes } from '../themes/cached-site-themes';
import { DEFAULT_APP_ICON_SOURCE, resolveAppIconSource, type AppIconSource } from './app-icon';

export interface AppIconContext {
  /** The default theme's page colour: the manifest colours and the opaque icons' fill. */
  background: string;
  source: AppIconSource;
}

/**
 * The request-time inputs of the app icon, shared by the web app manifest, the root
 * layout's apple-touch-icon link, the icon route and the Branding preview, so all four
 * agree on the `?v=` version. Both reads are cached (tags `public-layout-logo` and
 * `public-layout-site-themes`), so a logo or theme save changes the version everywhere.
 *
 * Pass `themes` when the caller already holds them (the root layout reads them once per
 * request); otherwise they are read here. Never throws: an unconfigured install or a
 * failed read means the static icons on white.
 */
export async function loadAppIconContext(
  themes?: SiteTheme[] | Promise<SiteTheme[]>
): Promise<AppIconContext> {
  if (!isSupabaseConfigured()) {
    return { background: themeColorFor([]), source: DEFAULT_APP_ICON_SOURCE };
  }

  const [logo, resolvedThemes] = await Promise.all([
    getCachedActiveLogo().catch(() => null),
    Promise.resolve(themes ?? getCachedSiteThemes()).catch(() => [] as SiteTheme[]),
  ]);
  const background = themeColorFor(resolvedThemes);

  return {
    background,
    source: resolveAppIconSource(logo, { background, mediaBaseUrl: resolveMediaBaseUrl() }),
  };
}
