/**
 * The restricted storefront document: a Tiptap JSON subset an untrusted partner may author.
 * Anything outside these shapes is dropped by `sanitizeStorefrontDoc()` before it is stored,
 * reviewed, published or rendered. No raw HTML, no inline styles, no classes, no script/svg/div nodes.
 */
import type { ReactNode } from 'react';

export type StorefrontMark =
  | { type: 'bold' }
  | { type: 'italic' }
  | { type: 'underline' }
  | { type: 'strike' }
  | { type: 'link'; attrs: { href: string } };

export interface StorefrontTextNode {
  type: 'text';
  text: string;
  marks?: StorefrontMark[];
}

export interface StorefrontHardBreakNode {
  type: 'hardBreak';
}

export type StorefrontInlineNode = StorefrontTextNode | StorefrontHardBreakNode;

export interface StorefrontParagraphNode {
  type: 'paragraph';
  content?: StorefrontInlineNode[];
}

export interface StorefrontHeadingNode {
  type: 'heading';
  attrs: { level: 2 | 3 };
  content?: StorefrontInlineNode[];
}

export interface StorefrontListItemNode {
  type: 'listItem';
  content: Array<StorefrontParagraphNode | StorefrontBulletListNode | StorefrontOrderedListNode>;
}

export interface StorefrontBulletListNode {
  type: 'bulletList';
  content: StorefrontListItemNode[];
}

export interface StorefrontOrderedListNode {
  type: 'orderedList';
  attrs: { start: number };
  content: StorefrontListItemNode[];
}

export interface StorefrontBlockquoteNode {
  type: 'blockquote';
  content: StorefrontParagraphNode[];
}

export interface StorefrontHorizontalRuleNode {
  type: 'horizontalRule';
}

export interface StorefrontImageCredit {
  provider: 'pexels' | 'unsplash';
  photographer: string;
  photographerUrl: string;
  sourceUrl: string;
  /** Unsplash API download trigger (must be pinged when the photo is used); null for Pexels. */
  downloadLocation: string | null;
  /** Unsplash `utm_source` for attribution links; null for Pexels. */
  utmSource: string | null;
}

export interface StorefrontImageAttrs {
  /** https URL whose origin is in the allow-list (own media storage, Pexels, Unsplash) or a `/images/…` path. */
  src: string;
  alt: string;
  title: string | null;
  width: number | null;
  height: number | null;
  credit: StorefrontImageCredit | null;
}

export interface StorefrontImageNode {
  type: 'image';
  attrs: StorefrontImageAttrs;
}

export type StorefrontCalloutTone = 'info' | 'tip' | 'highlight';

export interface StorefrontCalloutNode {
  type: 'storefrontCallout';
  attrs: { tone: StorefrontCalloutTone };
  content?: StorefrontInlineNode[];
}

export type StorefrontProductGridColumns = 2 | 3 | 4;

/** The `/promote` block: product ids from the store catalog (re-validated as active and public at render time). */
export interface StorefrontProductGridNode {
  type: 'affiliateProductGrid';
  attrs: {
    productIds: string[];
    title: string | null;
    columns: StorefrontProductGridColumns;
  };
}

export type StorefrontBlockNode =
  | StorefrontParagraphNode
  | StorefrontHeadingNode
  | StorefrontBulletListNode
  | StorefrontOrderedListNode
  | StorefrontBlockquoteNode
  | StorefrontHorizontalRuleNode
  | StorefrontImageNode
  | StorefrontCalloutNode
  | StorefrontProductGridNode;

export interface StorefrontDoc {
  type: 'doc';
  content: StorefrontBlockNode[];
}

export const STOREFRONT_BLOCK_NODE_TYPES = [
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'blockquote',
  'horizontalRule',
  'image',
  'storefrontCallout',
  'affiliateProductGrid',
] as const;

export const STOREFRONT_INLINE_NODE_TYPES = ['text', 'hardBreak'] as const;

/** Nodes that only appear nested (inside lists). */
export const STOREFRONT_NESTED_NODE_TYPES = ['listItem'] as const;

export const STOREFRONT_MARK_TYPES = ['bold', 'italic', 'underline', 'strike', 'link'] as const;

export const STOREFRONT_CALLOUT_TONES = ['info', 'tip', 'highlight'] as const;

export const STOREFRONT_NODE_NAMES = {
  callout: 'storefrontCallout',
  productGrid: 'affiliateProductGrid',
} as const;

export interface StorefrontSanitizeOptions {
  /** Exact https origins images may load from (lowercase, no trailing slash). `/images/…` paths are always allowed. */
  allowedImageOrigins: readonly string[];
  /** Site origin, used to keep same-site links and to decide `target`. */
  siteOrigin?: string | null;
}

export interface StorefrontSanitizeResult {
  doc: StorefrontDoc;
  /** Human-readable reasons for every dropped or altered piece (for logs and the review screen). */
  issues: string[];
  changed: boolean;
}

export type StorefrontBlockDiffStatus = 'unchanged' | 'added' | 'changed';

export interface StorefrontBlockDiff {
  /** One status per top-level block of the DRAFT, in order. */
  statuses: StorefrontBlockDiffStatus[];
  /** Published top-level blocks with no counterpart in the draft. */
  removedCount: number;
}

export interface StorefrontRenderProductGridArgs {
  productIds: string[];
  title: string | null;
  columns: StorefrontProductGridColumns;
  /** Index of the grid among the document's grids (0-based). */
  index: number;
}

export interface StorefrontRendererLabels {
  photoCredit: (photographer: string, provider: string) => string;
}

export interface StorefrontRendererProps {
  doc: StorefrontDoc;
  allowedImageOrigins: readonly string[];
  siteOrigin?: string | null;
  /** Server-rendered product cards for a grid; when omitted, grids render nothing. */
  renderProductGrid?: (args: StorefrontRenderProductGridArgs) => ReactNode;
  labels?: Partial<StorefrontRendererLabels>;
  /** Default: `nofollow ugc noopener noreferrer`. */
  linkRel?: string;
  /** Per top-level block diff status (review screen). */
  highlight?: readonly StorefrontBlockDiffStatus[];
  /**
   * The public storefront's handle: every site-internal link in the partner's text then carries
   * `?ref=<handle>` (unless it already names a ref), like the product cards, so a purchase through
   * it is attributed. The proxy still applies the visitor's marketing choice. Previews and the
   * review screen pass nothing.
   */
  referralHandle?: string | null;
  className?: string;
}

/** A catalog product as the editor's picker and grid chips show it. */
export interface StorefrontEditorProduct {
  id: string;
  title: string;
  imageUrl: string | null;
  priceLabel: string | null;
}

export interface StorefrontEditorUploadResult {
  src: string;
  alt?: string;
  width?: number | null;
  height?: number | null;
}

/** Imperative handle the portal (and the copilot panel) uses. */
export interface StorefrontEditorApi {
  /** Insert blocks at the cursor, or append when the editor is not focused. */
  insertBlocks(blocks: StorefrontBlockNode[]): void;
  getSelectedText(): string;
  /**
   * True when the selection is one `replaceSelection()` replaces: text (or the cursor) inside one
   * text block, i.e. a paragraph, a heading, a list item or a callout. It does not check whether
   * the editor is editable.
   */
  canReplaceSelection(): boolean;
  /**
   * Replace the selected text with plain text inside its text block (keeps that block and the
   * formatting spanning the selection). Returns false and changes nothing for a selected node, a
   * selection across blocks or one holding an image, a product grid or a divider, and while the
   * editor is read-only: blocks are never merged or deleted.
   */
  replaceSelection(text: string): boolean;
  getDoc(): StorefrontDoc;
  focus(): void;
  setEditable(editable: boolean): void;
}

export interface StorefrontEditorProps {
  initialContent: StorefrontDoc;
  /** Called with the sanitized document after every change. Never called after a content error. */
  onChange: (doc: StorefrontDoc) => void;
  allowedImageOrigins: readonly string[];
  searchProducts: (query: string) => Promise<StorefrontEditorProduct[]>;
  resolveProducts: (ids: string[]) => Promise<StorefrontEditorProduct[]>;
  uploadImage?: (file: File) => Promise<StorefrontEditorUploadResult | null>;
  editable?: boolean;
  onEditorReady?: (api: StorefrontEditorApi | null) => void;
  className?: string;
  maxProductsPerGrid?: number;
  /** Accessible name of the editing region. */
  ariaLabel?: string;
}
