import type { Metadata } from 'next';

export const DEFAULT_SITE_TITLE = 'NextBlock™ CMS';

export const DEFAULT_SITE_DESCRIPTION =
  'NextBlock is an open-source CMS on Next.js + Supabase — a visual block editor, blazing-fast multilingual pages, and built-in e-commerce.';

export const DEFAULT_SITE_KEYWORDS =
  'NextBlock, CMS, Next.js, Supabase, headless CMS, block editor, visual page builder, multilingual, e-commerce, open source';

/** Bundled fallback Open Graph image (resolved to absolute via metadataBase). */
export const DEFAULT_OG_IMAGE = '/assets/nextblock-banner.jpg';

/**
 * Intrinsic pixel size of DEFAULT_OG_IMAGE. Social scrapers trust the declared
 * width/height over the file itself, so these must track the real asset — keep
 * them next to the path so the two cannot drift apart.
 */
export const DEFAULT_OG_IMAGE_WIDTH = 1672;
export const DEFAULT_OG_IMAGE_HEIGHT = 941;

const DEFAULT_META_DESCRIPTION_LENGTH = 160;

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(value: string) {
  const entities: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };

  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    const key = String(entity);
    if (key[0] === '#') {
      const isHex = key[1]?.toLowerCase() === 'x';
      const codePoint = Number.parseInt(key.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }

    return entities[key] ?? match;
  });
}

export function stripHtmlToText(value: string) {
  return normalizeWhitespace(
    decodeHtmlEntities(
      value
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
    )
  );
}

function extractParagraphTextFromHtml(value: string) {
  const paragraphs = Array.from(value.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi))
    .map((match) => stripHtmlToText(match[1] ?? ''))
    .filter(Boolean);

  if (paragraphs.length > 0) {
    return paragraphs[0];
  }

  return stripHtmlToText(value.replace(/<h[1-6]\b[\s\S]*?<\/h[1-6]>/gi, ' '));
}

function truncateMetaDescription(value: string, maxLength = DEFAULT_META_DESCRIPTION_LENGTH) {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  const truncated = normalized.slice(0, maxLength + 1);
  const lastSpace = truncated.lastIndexOf(' ');
  const candidate = lastSpace > 80 ? truncated.slice(0, lastSpace) : normalized.slice(0, maxLength);

  return candidate.replace(/[.,;:!?-]+$/, '').trim();
}

function normalizeMetaCandidate(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const normalized = stripHtmlToText(value);
  return normalized || null;
}

function collectIntroTextCandidates(value: unknown, candidates: string[]) {
  if (!value) {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectIntroTextCandidates(item, candidates));
    return;
  }

  if (typeof value !== 'object') {
    return;
  }

  const block = value as {
    block_type?: string;
    content?: Record<string, unknown>;
  };

  if (block.block_type === 'section' || block.block_type === 'hero') {
    collectIntroTextCandidates(block.content?.column_blocks, candidates);
    collectIntroTextCandidates(block.content?.slides, candidates);
    return;
  }

  if (block.block_type === 'text') {
    const htmlContent = block.content?.html_content;
    const textContent = block.content?.text_content;
    const candidate =
      typeof htmlContent === 'string'
        ? extractParagraphTextFromHtml(htmlContent)
        : typeof textContent === 'string'
          ? normalizeWhitespace(textContent)
          : '';

    if (candidate) {
      candidates.push(candidate);
    }
  }
}

export function extractIntroExcerptFromBlocks(blocks: unknown) {
  const candidates: string[] = [];
  collectIntroTextCandidates(blocks, candidates);

  return (
    candidates.find((candidate) => candidate.length >= 80) ??
    candidates[0] ??
    null
  );
}

export function resolveMetaTitle(
  manualTitle: string | null | undefined,
  fallbackTitle: string | null | undefined
) {
  return (
    normalizeMetaCandidate(manualTitle) ??
    normalizeMetaCandidate(fallbackTitle) ??
    DEFAULT_SITE_TITLE
  );
}

export function resolveMetaDescription(...candidates: Array<string | null | undefined>) {
  for (const candidate of candidates) {
    const description = normalizeMetaCandidate(candidate);
    if (description) {
      return truncateMetaDescription(description);
    }
  }

  return DEFAULT_SITE_DESCRIPTION;
}

export function resolvePageMetaDescription(
  manualDescription: string | null | undefined,
  blocks: unknown
) {
  return resolveMetaDescription(manualDescription, extractIntroExcerptFromBlocks(blocks));
}

export function resolvePostMetaDescription(
  manualDescription: string | null | undefined,
  subtitle: string | null | undefined
) {
  return resolveMetaDescription(manualDescription, subtitle);
}

export function resolveProductMetaDescription(
  manualDescription: string | null | undefined,
  shortDescription: string | null | undefined
) {
  return resolveMetaDescription(manualDescription, shortDescription);
}

export function stringifyJsonLd(value: unknown) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * Appends the site title to a page title for social cards, e.g.
 * `composeTitleWithSite('Home', 'NextBlock™ CMS') === 'Home | NextBlock™ CMS'`.
 * Unlike Next.js' `title.template` (which only affects the `<title>` tag), this
 * lets us produce a complete `og:title` / `twitter:title`.
 */
export function composeTitleWithSite(
  pageTitle: string | null | undefined,
  siteTitle: string | null | undefined
): string {
  const cleanTitle = (pageTitle ?? '').trim();
  const cleanSite = (siteTitle ?? '').trim();

  if (!cleanSite) return cleanTitle;
  if (!cleanTitle) return cleanSite;

  const suffix = ` | ${cleanSite}`;
  return cleanTitle === cleanSite || cleanTitle.endsWith(suffix)
    ? cleanTitle
    : `${cleanTitle}${suffix}`;
}

/**
 * Resolves the canonical URL for a public page/post/product.
 *
 * By default this is the self-referencing `<siteUrl><path>`. When the content row
 * sets a manual `custom_canonical` override, that wins:
 *  - absolute values (`https://…`) are used verbatim,
 *  - root-relative (`/foo`) and bare (`foo`) values are resolved against `siteUrl`.
 * A null/blank override falls back to the self-referencing default, so existing
 * content is unaffected. `siteUrl` may be empty (pre-config / no NEXT_PUBLIC_URL),
 * in which case a relative path is returned and resolved by `metadataBase`.
 */
export function buildCanonicalUrl(
  customCanonical: string | null | undefined,
  siteUrl: string,
  path: string
): string {
  const base = (siteUrl || '').replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const fallback = `${base}${normalizedPath}`;

  const custom = customCanonical?.trim();
  if (!custom) {
    return fallback;
  }

  if (/^https?:\/\//i.test(custom)) {
    return custom;
  }

  return custom.startsWith('/') ? `${base}${custom}` : `${base}/${custom}`;
}

/** Maps a language code (e.g. `fr`, `en-US`) to an Open Graph locale (`fr_FR`). */
export function toOpenGraphLocale(languageCode?: string | null): string {
  const code = (languageCode ?? '').toLowerCase().split('-')[0];
  const map: Record<string, string> = {
    en: 'en_US',
    fr: 'fr_FR',
    es: 'es_ES',
    de: 'de_DE',
    pt: 'pt_PT',
    it: 'it_IT',
    nl: 'nl_NL',
  };
  return map[code] ?? 'en_US';
}

/**
 * The site-wide social preview image an operator picked on the Branding screen (or
 * Cortex set through `update_site_identity`), already resolved to a URL by
 * `getSiteSettings`. Null when none is configured.
 */
export interface SocialFallbackImage {
  url: string;
  width?: number | null;
  height?: number | null;
  alt?: string | null;
}

export interface SocialMetadataInput {
  /** Bare page title (without the site-title suffix). */
  title: string;
  description: string;
  /** Canonical URL of the page (absolute, or path resolved via metadataBase). */
  url: string;
  siteTitle: string;
  /** Resolved feature-image URL; falls back to `fallbackImage`, then the bundled default. */
  imageUrl?: string | null;
  /** The site-wide social preview image, used when the page has no feature image. */
  fallbackImage?: SocialFallbackImage | null;
  type?: 'website' | 'article';
  publishedTime?: string | null;
  locale?: string | null;
}

/**
 * Builds the `openGraph` + `twitter` metadata for a public page so that every
 * page emits a complete, suffixed social title and always has an OG image: the
 * feature image when present, else the site-wide social preview image from the
 * Branding screen, else the bundled NextBlock banner.
 */
export function buildSocialMetadata(
  input: SocialMetadataInput
): Pick<Metadata, 'openGraph' | 'twitter'> {
  const socialTitle = composeTitleWithSite(input.title, input.siteTitle);
  const fallback = input.fallbackImage?.url ? input.fallbackImage : null;
  const imageUrl = input.imageUrl || fallback?.url || DEFAULT_OG_IMAGE;
  const image = input.imageUrl
    ? { url: imageUrl, alt: socialTitle }
    : fallback
      ? {
          url: imageUrl,
          ...(fallback.width && fallback.height ? { width: fallback.width, height: fallback.height } : {}),
          alt: fallback.alt?.trim() || socialTitle,
        }
      : // The bundled banner is declared at its real size (see DEFAULT_OG_IMAGE_WIDTH).
        { url: imageUrl, width: DEFAULT_OG_IMAGE_WIDTH, height: DEFAULT_OG_IMAGE_HEIGHT, alt: socialTitle };

  const openGraphBase = {
    title: socialTitle,
    description: input.description,
    url: input.url,
    siteName: input.siteTitle,
    images: [image],
    ...(input.locale ? { locale: input.locale } : {}),
  };

  const openGraph =
    input.type === 'article'
      ? {
          ...openGraphBase,
          type: 'article' as const,
          ...(input.publishedTime ? { publishedTime: input.publishedTime } : {}),
        }
      : { ...openGraphBase, type: 'website' as const };

  return {
    openGraph,
    twitter: {
      card: 'summary_large_image',
      title: socialTitle,
      description: input.description,
      images: [imageUrl],
    },
  };
}
