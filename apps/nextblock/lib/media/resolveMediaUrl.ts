/**
 * App-facing name for the media URL resolver.
 *
 * The implementation lives in `@nextblock-cms/utils/media-url` because `libs/ecommerce` resolves
 * the same media rows (product covers, variant images, the media picker) and a lib may never import
 * from the app. It serves the keys in BUNDLED_PUBLIC_MEDIA_KEYS (files in `public/images`) from
 * `/images/…` and joins every other key to the public media base. Everything app-side keeps
 * importing it from here.
 */
export {
  BUNDLED_PUBLIC_MEDIA_KEYS,
  getPublicMediaBaseUrl,
  getSupabaseMediaBaseUrl,
  isBundledPublicMediaKey,
  resolveMediaUrl,
  resolveMediaUrlWithSupabaseFallback,
} from '@nextblock-cms/utils/media-url';
