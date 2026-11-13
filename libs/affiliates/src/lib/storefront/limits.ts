/**
 * Hard limits of a partner storefront document (`affiliate_pages.draft_content` and
 * `published_content`). `sanitizeStorefrontDoc()` enforces every one of them by truncation, so a
 * document that went through it never exceeds them, and running it again changes nothing.
 */
export const STOREFRONT_LIMITS = {
  /** Top-level blocks of a document. */
  maxBlocks: 200,
  /**
   * Block nesting depth: a top-level block is depth 1, its children depth 2. A list item's
   * paragraph sits two levels below its list, so lists nest two deep; deeper items are flattened
   * into paragraphs of the deepest allowed item (their text is kept).
   */
  maxDepth: 6,
  /** Characters (UTF-16 code units) per text node. */
  maxTextLength: 5000,
  /** Characters of text across the whole document. */
  maxTotalText: 60000,
  /** `affiliateProductGrid` blocks per document. */
  maxProductGrids: 12,
  /** Product ids per grid. */
  maxProductsPerGrid: 12,
  /** Distinct product ids across all grids (`affiliate_pages.featured_product_ids` holds at most 24). */
  maxFeaturedProducts: 24,
  /** Image blocks per document. */
  maxImages: 30,
  /**
   * UTF-8 bytes of the document as Postgres prints it as jsonb (`octet_length(content::text)`,
   * the `draft_content` / `published_content` CHECK; `storefrontJsonbTextByteLength`).
   */
  maxJsonBytes: 262144,
  /** Characters of a link href or an image src. */
  maxHrefLength: 2000,
  /** Characters of an image alt text. */
  maxAltLength: 250,
  /** Characters of an image title. */
  maxImageTitleLength: 250,
  /** Characters of a product grid title. */
  maxGridTitleLength: 120,
  /** Largest image width or height attribute, in pixels. */
  maxImageDimension: 4000,
  /** Characters of a stock photo credit URL. */
  maxCreditUrlLength: 500,
  /** Characters of a photographer name or an Unsplash `utm_source`. */
  maxCreditTextLength: 120,
  /** Input guard: a JSON string over this many UTF-8 bytes is refused before it is parsed. */
  maxInputBytes: 1048576,
  /** Input guard: input nodes (kept or dropped) visited before the walk stops. */
  maxInputNodes: 50000,
  /** Input guard: JSON nesting levels the walk descends before it stops (depth bombs). */
  maxInputDepth: 48,
} as const;

export type StorefrontLimits = typeof STOREFRONT_LIMITS;
