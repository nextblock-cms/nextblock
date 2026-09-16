import 'server-only';
import { cache } from 'react';
import { unstable_cache } from 'next/cache';
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js';
import type { Database } from '@nextblock-cms/db';
import {
  resolveSupabaseAnonKey,
  resolveSupabaseServiceKey,
  resolveSupabaseUrl,
} from '../../lib/setup/env-status';
import { parseSiteSocialImageSetting, SITE_SOCIAL_IMAGE_SETTING_KEY } from '@nextblock-cms/utils/seo';
import { resolveMediaUrl } from '../../lib/media/resolveMediaUrl';
import {
  DEFAULT_SITE_TITLE,
  DEFAULT_SITE_DESCRIPTION,
  DEFAULT_SITE_KEYWORDS,
  type SocialFallbackImage,
} from './seo';

export const SITE_SETTINGS_CACHE_TAG = 'public-site-settings';
const SITE_SETTINGS_REVALIDATE_SECONDS = 60;

export interface SiteSettings {
  siteTitle: string;
  siteDescription: string;
  siteKeywords: string;
  /**
   * The site-wide Open Graph / Twitter preview image from the Branding screen
   * (`site_settings.site_social_image`), resolved to a URL. Null means "none set":
   * `buildSocialMetadata` then falls back to the bundled NextBlock banner.
   */
  socialImage: SocialFallbackImage | null;
}

/**
 * Service-role (or anon) Supabase client used for cached, request-agnostic
 * reads of public layout/SEO data. Shared by the root layout and the public
 * route `generateMetadata` functions.
 */
export function createStaticSupabaseClient() {
  // Fall back to a dummy host when unconfigured (fresh clone, pre-/setup) so the
  // root layout can still render rather than crashing the whole app on boot. Callers
  // (getSiteSettings + the getCached* helpers) already swallow failures and use
  // fallbacks, and loadLayoutData short-circuits before reaching here when there is
  // no Supabase env at all.
  const supabaseUrl = resolveSupabaseUrl() || 'https://dummy.supabase.co';
  const supabaseKey =
    resolveSupabaseServiceKey() || resolveSupabaseAnonKey() || 'dummy-anon-key';

  return createSupabaseJsClient<Database>(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

/**
 * Cached read of the site-wide SEO identity (title / description / keywords)
 * from the `site_settings` key-value store. This is the single source of truth
 * used for both `<title>`/OpenGraph metadata and the header brand.
 */
// React `cache()` memoises the call per request: the root layout, a page's
// generateMetadata and the page body all ask for this, and on Vercel every
// `unstable_cache` read is a round trip to the Data Cache.
export const getSiteSettings = cache(unstable_cache(
  async (): Promise<SiteSettings> => {
    const fallback: SiteSettings = {
      siteTitle: DEFAULT_SITE_TITLE,
      siteDescription: DEFAULT_SITE_DESCRIPTION,
      siteKeywords: DEFAULT_SITE_KEYWORDS,
      socialImage: null,
    };

    // Unconfigured instance (pre-/setup): the static client would point at the dummy
    // host, so the fetch fails with a noisy DNS error before falling back. Skip it and
    // return SEO defaults directly. (generateMetadata calls this even on /setup.)
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
      return fallback;
    }

    try {
      const supabase = createStaticSupabaseClient();
      const { data, error } = await supabase
        .from('site_settings')
        .select('key, value')
        .in('key', ['site_title', 'site_description', 'site_keywords', SITE_SOCIAL_IMAGE_SETTING_KEY]);

      if (error || !data) {
        // PGRST205 = table not found: the schema isn't migrated yet (e.g. mid-setup,
        // right after the connection is saved but before `npm run db:migrate`). That's an
        // expected transient state — don't shout about it. Real errors still log.
        if (error && error.code !== 'PGRST205') {
          console.error('Error fetching cached site settings:', error);
        }
        return fallback;
      }

      const settings: Record<string, string> = {};
      let socialImageValue: unknown = null;
      data.forEach((item) => {
        if (item.key === SITE_SOCIAL_IMAGE_SETTING_KEY) {
          socialImageValue = item.value;
        } else if (typeof item.value === 'string') {
          settings[item.key] = item.value;
        }
      });

      // A media-library pick is stored as its object key (resolved here, so the
      // media host can change without rewriting the setting); a Cortex-set URL is
      // used verbatim.
      const socialImage = parseSiteSocialImageSetting(socialImageValue);
      const socialImageUrl = socialImage ? socialImage.url ?? resolveMediaUrl(socialImage.object_key) : null;

      return {
        siteTitle: settings.site_title?.trim() || fallback.siteTitle,
        siteDescription: settings.site_description?.trim() || fallback.siteDescription,
        siteKeywords: settings.site_keywords?.trim() || fallback.siteKeywords,
        socialImage:
          socialImage && socialImageUrl
            ? { alt: socialImage.alt, height: socialImage.height, url: socialImageUrl, width: socialImage.width }
            : null,
      };
    } catch (caught) {
      console.error('Unexpected error fetching site settings:', caught);
      return fallback;
    }
  },
  ['public-site-settings'],
  { revalidate: SITE_SETTINGS_REVALIDATE_SECONDS, tags: [SITE_SETTINGS_CACHE_TAG] }
));
