import 'server-only';

import { cache } from 'react';
import { unstable_cache } from 'next/cache';
import type { Database } from '@nextblock-cms/db';

import { createStaticSupabaseClient } from '../../app/lib/site-settings';
import { resolveActiveLogo } from './active-logo';

/**
 * Cache tag for the public reads of the active logo. The Branding actions
 * (`app/cms/settings/logos/actions.ts`) evict it on every logo create, edit, delete and
 * "set active", which refreshes the header, the web app manifest and the app icons.
 */
export const PUBLIC_LAYOUT_LOGO_CACHE_TAG = 'public-layout-logo';

// Five minutes, like the rest of the public layout chrome: every logo action evicts by tag,
// so the TTL only bounds direct database edits.
const ACTIVE_LOGO_REVALIDATE_SECONDS = 300;

export type HeaderLogo = Database['public']['Tables']['logos']['Row'] & {
  media: Database['public']['Tables']['media']['Row'] | null;
};

/**
 * The active logo (the admin-pinned `site_settings.active_logo_id`, else the newest row)
 * joined with its media, for public, request-agnostic readers: the header in the root
 * layout, the web app manifest and the app icon route. It lives here rather than in
 * app/layout.tsx because a layout file may only export what Next expects.
 *
 * React `cache()` memoises it per request: the layout body and its `generateMetadata`
 * both ask for it, and on Vercel every `unstable_cache` read is a Data Cache round trip.
 */
export const getCachedActiveLogo = cache(unstable_cache(
  async (): Promise<HeaderLogo | null> => {
    try {
      const supabase = createStaticSupabaseClient();
      const logo = await resolveActiveLogo(supabase);
      return (logo as HeaderLogo | null) ?? null;
    } catch (error) {
      console.error('Error fetching cached active logo:', error);
      return null;
    }
  },
  [PUBLIC_LAYOUT_LOGO_CACHE_TAG],
  { revalidate: ACTIVE_LOGO_REVALIDATE_SECONDS, tags: [PUBLIC_LAYOUT_LOGO_CACHE_TAG] }
));
