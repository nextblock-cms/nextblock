// The restricted storefront editor (client only; entry `@nextblock-cms/affiliates/editor`).
// No 'use client' here on purpose: Next refuses `export *` in a client boundary, and every module
// below carries its own directive on line 1.
export { StorefrontEditor, STOREFRONT_EDITOR_IMAGE_TYPES } from './StorefrontEditor';
export {
  StorefrontProductPickerDialog,
  STOREFRONT_PRODUCT_SEARCH_DEBOUNCE_MS,
  type StorefrontProductPickerDialogProps,
} from './ProductPickerDialog';
export {
  createStorefrontEditorExtensions,
  isStorefrontEditorLinkAllowed,
  STOREFRONT_EDITOR_LINK_PROTOCOLS,
  type StorefrontEditorKitOptions,
} from './kit';
export {
  StorefrontCallout,
  isAtStorefrontCalloutBoundary,
  isStorefrontCalloutTone,
  readStorefrontCalloutTone,
} from './extensions/callout';
export {
  AffiliateProductGrid,
  readStorefrontGridColumns,
  readStorefrontGridProductIds,
  readStorefrontGridTitle,
  type AffiliateProductGridAttrs,
  type AffiliateProductGridOptions,
} from './extensions/product-grid';
export { StorefrontImage, type StorefrontImageOptions } from './extensions/image';
export { StorefrontStarterKit, STOREFRONT_EDITOR_CONTENT_RULES } from './extensions/starter-kit';
export {
  StorefrontSlashCommand,
  STOREFRONT_SLASH_PLUGIN_KEY,
  runStorefrontSlashItem,
  type StorefrontSlashCommandOptions,
  type StorefrontSlashHooks,
  type StorefrontSlashRender,
} from './extensions/slash-command';
export {
  getStorefrontSlashItems,
  STOREFRONT_SLASH_ITEM_IDS,
  type StorefrontSlashItem,
  type StorefrontSlashItemId,
  type StorefrontSlashItemsOptions,
} from './extensions/slash-items';
export {
  createStorefrontSlashMenuRender,
  StorefrontSlashMenu,
  type StorefrontSlashMenuHandle,
  type StorefrontSlashMenuProps,
} from './SlashMenu';
export { AffiliateProductGridView, createAffiliateProductGridNodeView } from './ProductGridView';
export {
  applyStorefrontLink,
  canReplaceStorefrontSelection,
  collectStorefrontEditorProductIds,
  getSelectedStorefrontImage,
  getStorefrontProductGridAt,
  getStorefrontSelectedText,
  insertStorefrontBlocks,
  insertStorefrontProductGrid,
  normalizeStorefrontLinkInput,
  normalizeStorefrontProductGridAttrs,
  removeStorefrontLink,
  replaceStorefrontSelection,
  STOREFRONT_EDITOR_MAX_LIST_NESTING,
  storefrontInsertBlocksCommand,
  storefrontListNestingAt,
  toggleStorefrontQuote,
  updateStorefrontImageAlt,
  updateStorefrontProductGrid,
  type StorefrontInsertBlocksOptions,
  type StorefrontInsertPosition,
} from './commands';
export {
  createStorefrontProductStore,
  normalizeStorefrontEditorProduct,
  storefrontEditorProductImageSrc,
  type StorefrontProductResolver,
  type StorefrontProductStore,
} from './product-store';
