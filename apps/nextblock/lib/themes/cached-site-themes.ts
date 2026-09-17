import 'server-only';

import { unstable_cache } from 'next/cache';

import { createStaticSupabaseClient } from '../../app/lib/site-settings';
import type { SiteTheme } from './buildThemeCss';

export const SITE_THEMES_CACHE_TAG = 'public-layout-site-themes';

/**
 * Every row of `site_themes`, cached like the rest of the public layout chrome. Lives here
 * (not in app/layout.tsx, where it started) because a layout file may only export what Next
 * expects, and the web app manifest needs the default theme's colours too.
 */
export const getCachedSiteThemes = unstable_cache(
  async (): Promise<SiteTheme[]> => {
    const supabase = createStaticSupabaseClient();
    const { data, error } = await supabase
      .from('site_themes')
      .select('id, slug, name, description, icon, color_scheme, tokens, extra_css, is_system, is_default, is_active, sort_order')
      .order('sort_order');

    if (error || !data) {
      // A missing table (pre-migration install) must not take the site down —
      // libs/ui/src/styles/theme.css still ships a working fallback palette.
      return [];
    }
    return data as unknown as SiteTheme[];
  },
  [SITE_THEMES_CACHE_TAG],
  { revalidate: 300, tags: [SITE_THEMES_CACHE_TAG] }
);
