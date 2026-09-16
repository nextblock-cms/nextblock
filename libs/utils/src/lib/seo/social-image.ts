/**
 * The site-wide social preview image (Open Graph / Twitter card), stored in
 * `site_settings` under `site_social_image`.
 *
 * It is the image a link preview shows for any public page, post or product that
 * has no feature image of its own — the home page above all, which should not carry
 * a feature image (on a page that renders a full-width title banner above the hero).
 * Without this setting NextBlock falls back to its own bundled banner, which is never
 * what a client site wants to show on social networks.
 *
 * Written by the Branding screen (`/cms/settings/logos`, from the media library) and
 * by Cortex's `update_site_identity` (`social_image`: a media library id, or an https
 * URL that is hotlinked). Read by the app's `getSiteSettings`. Pure and Zod-free like
 * the rest of this barrel, so it loads anywhere.
 */

export const SITE_SOCIAL_IMAGE_SETTING_KEY = 'site_social_image';

export type SiteSocialImageSetting = {
  /** Media library row the image came from; null for a hotlinked URL. */
  media_id: string | null;
  /** Storage key of that media row, resolved to a URL by the app at read time. */
  object_key: string | null;
  /** An absolute http(s) URL used verbatim: a hotlinked stock photo or an external asset. */
  url: string | null;
  width: number | null;
  height: number | null;
  alt: string | null;
};

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function optionalDimension(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

/**
 * Read the stored setting leniently: anything that is not an object holding at least
 * an `object_key` or an http(s) `url` counts as "no social image", so a half-written
 * or legacy value can never break metadata generation.
 */
export function parseSiteSocialImageSetting(value: unknown): SiteSocialImageSetting | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const url = optionalString(record['url']);
  const objectKey = optionalString(record['object_key']);

  if (url && !/^https?:\/\//i.test(url)) {
    return null;
  }

  if (!url && !objectKey) {
    return null;
  }

  return {
    alt: optionalString(record['alt']),
    height: optionalDimension(record['height']),
    media_id: optionalString(record['media_id']),
    object_key: objectKey,
    url,
    width: optionalDimension(record['width']),
  };
}
