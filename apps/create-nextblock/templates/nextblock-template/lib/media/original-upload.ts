/**
 * App-facing name for the media-variant helpers.
 *
 * The implementation lives in `@nextblock-cms/utils/media-variants` because
 * `libs/cortex` needs the same selection when it stores the site's social preview
 * image, and a lib may never import from the app. Everything app-side keeps
 * importing it from here.
 */
export {
  findOriginalUploadVariant,
  ORIGINAL_UPLOAD_VARIANT_LABEL,
  pickOriginalUploadObjectKey,
  type MediaVariantLike,
  type MediaWithVariants,
} from '@nextblock-cms/utils/media-variants';
