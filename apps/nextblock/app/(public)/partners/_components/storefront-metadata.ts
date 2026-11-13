import type { Metadata } from 'next';
import {
  AFFILIATE_PARTNERS_PATH,
  storefrontExcerpt,
  type AffiliatesCopyTranslate,
  type StorefrontDoc,
} from '@nextblock-cms/affiliates';
import { composeTitleWithSite, toOpenGraphLocale } from '../../../lib/seo';

/**
 * Metadata of `/partners/<handle>` (ADDENDUM C5). The social card is the segment's own
 * `opengraph-image.tsx`, so `openGraph` carries NO `images` (Next adds the generated one, with its
 * alt text from that file's `generateImageMetadata`) and the Twitter card names no image either;
 * `metadataBase` is the resolved site URL so the generated image URL comes out absolute. Pure: the
 * page passes the already-sanitized document.
 */

const META_DESCRIPTION_MAX_LENGTH = 160;

export interface AffiliateStorefrontMetadataInput {
  handle: string;
  displayName: string;
  /** The approved page title / meta description (null: fall back to localized copy). */
  title: string | null;
  metaDescription: string | null;
  /** The sanitized published document, for an excerpt when no meta description was approved. */
  doc: StorefrontDoc;
  t: AffiliatesCopyTranslate;
  siteUrl: string;
  siteTitle: string;
  siteLocale: string;
  /**
   * The language the partner wrote in (the approved profile snapshot's `locale`), which `og:locale`
   * declares; null for a snapshot without one (then the visitor's language, as before).
   */
  contentLocale?: string | null;
}

/** At most `max` characters, cut at a word boundary with an ellipsis. */
export function truncateStorefrontMetaText(value: string, max = META_DESCRIPTION_MAX_LENGTH): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const window = text.slice(0, max - 1);
  const lastSpace = window.lastIndexOf(' ');
  return `${(lastSpace > max / 2 ? window.slice(0, lastSpace) : window).replace(/[\s.,;:!?-]+$/, '')}…`;
}

function metadataBaseOf(siteUrl: string): URL | undefined {
  try {
    return new URL(siteUrl);
  } catch {
    return undefined;
  }
}

/**
 * The page title: the approved one, else the localized "<name>'s picks". Shared with the social
 * card's alt text (opengraph-image.tsx), which is this title with the site name, like `og:title`.
 */
export function resolveAffiliateStorefrontTitle(
  input: Pick<AffiliateStorefrontMetadataInput, 'displayName' | 'title' | 't'>,
): string {
  return input.title?.trim() || input.t('affiliates.storefront.meta_title_fallback', { name: input.displayName });
}

/** The page title, description and canonical URL (metadata and JSON-LD share them). */
export function resolveAffiliateStorefrontSeo(
  input: Omit<AffiliateStorefrontMetadataInput, 'siteTitle' | 'siteLocale' | 'contentLocale'>,
): { title: string; description: string; url: string } {
  const name = input.displayName;
  const title = resolveAffiliateStorefrontTitle(input);
  const description = truncateStorefrontMetaText(
    input.metaDescription?.trim() ||
      storefrontExcerpt(input.doc, META_DESCRIPTION_MAX_LENGTH) ||
      input.t('affiliates.storefront.meta_description_fallback', { name }),
  );
  const base = input.siteUrl.replace(/\/+$/, '');
  return { title, description, url: `${base}${AFFILIATE_PARTNERS_PATH}/${input.handle}` };
}

export function buildAffiliateStorefrontMetadata(input: AffiliateStorefrontMetadataInput): Metadata {
  const { title, description, url } = resolveAffiliateStorefrontSeo(input);
  const socialTitle = composeTitleWithSite(title, input.siteTitle);
  const metadataBase = metadataBaseOf(input.siteUrl.replace(/\/+$/, ''));

  return {
    ...(metadataBase ? { metadataBase } : {}),
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: 'profile',
      title: socialTitle,
      description,
      url,
      siteName: input.siteTitle,
      locale: toOpenGraphLocale(input.contentLocale || input.siteLocale),
      username: input.handle,
    },
    twitter: {
      card: 'summary_large_image',
      title: socialTitle,
      description,
    },
  };
}
