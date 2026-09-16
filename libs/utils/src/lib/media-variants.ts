/**
 * Picking the UNTOUCHED uploaded file out of a media row.
 *
 * The upload pipeline (`app/api/process-image/route.ts`) converts every image to AVIF
 * and stores the AVIF derivative as the row's `object_key`. That is what the site
 * renders, and it is the right default: AVIF is much smaller and every browser
 * NextBlock targets decodes it. The original file is kept alongside the derivatives,
 * in the row's `variants`, under the label `original_uploaded`.
 *
 * Some consumers are not browsers and cannot decode AVIF:
 *   - email clients, Outlook above all (`lib/email/branding-format.ts`),
 *   - vision APIs (the media editor's alt-text generation),
 *   - social link-preview crawlers: Facebook, LinkedIn, X and most chat apps still
 *     fetch `og:image` with no AVIF support, so an AVIF preview silently shows
 *     nothing at all.
 *
 * Those consumers use this helper; everything that renders in a browser keeps using
 * `object_key`. Rows with no `original_uploaded` variant fall back to `object_key`,
 * which covers the seeded demo media and anything uploaded before the pipeline kept
 * originals, so a caller never ends up with no image at all.
 */

/** Label the upload pipeline gives the untouched original file among a row's variants. */
export const ORIGINAL_UPLOAD_VARIANT_LABEL = 'original_uploaded';

export interface MediaVariantLike {
  objectKey?: string | null;
  variantLabel?: string | null;
  fileType?: string | null;
  width?: number | null;
  height?: number | null;
}

/** The slice of a media row this module reads. */
export interface MediaWithVariants {
  object_key?: string | null;
  file_path?: string | null;
  variants?: unknown;
}

/** The `original_uploaded` entry of a row's variants, or null when it kept none. */
export function findOriginalUploadVariant(
  media: MediaWithVariants | null | undefined
): MediaVariantLike | null {
  if (!media) return null;

  const variants = Array.isArray(media.variants) ? (media.variants as MediaVariantLike[]) : [];
  const original = variants.find(
    (variant) =>
      variant &&
      typeof variant === 'object' &&
      variant.variantLabel === ORIGINAL_UPLOAD_VARIANT_LABEL &&
      typeof variant.objectKey === 'string' &&
      variant.objectKey.length > 0
  );

  return original ?? null;
}

/**
 * The storage key a non-browser consumer should use: the untouched upload when the
 * row kept one, else the AVIF derivative the site renders.
 */
export function pickOriginalUploadObjectKey(
  media: MediaWithVariants | null | undefined
): string | null {
  if (!media) return null;

  return findOriginalUploadVariant(media)?.objectKey ?? media.object_key ?? media.file_path ?? null;
}
