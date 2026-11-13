'use client';

/**
 * `affiliateProductGrid`: the `/promote` block, an atom holding product ids from the store
 * catalog (re-validated as active and public when the storefront renders). The node definition is
 * pure Tiptap so `getSchema()` works in node tests; the React node view (chips, picker, title,
 * columns) is attached on the client through the `nodeView` option.
 */
import { Node, mergeAttributes, type NodeViewRenderer } from '@tiptap/core';

import { STOREFRONT_LIMITS } from '../../storefront/limits';
import { isStorefrontProductId } from '../../storefront/sanitize';
import { cleanStorefrontText, truncateStorefrontText } from '../../storefront/text';
import { STOREFRONT_NODE_NAMES, type StorefrontProductGridColumns } from '../../storefront/types';

export interface AffiliateProductGridAttrs {
  productIds: string[];
  title: string | null;
  columns: StorefrontProductGridColumns;
}

export interface AffiliateProductGridOptions {
  /** React node view (client only). Without one the grid renders as an empty `div` placeholder. */
  nodeView: NodeViewRenderer | null;
}

/** Product ids as the grid stores them: uuid strings, lowercased, deduplicated, at most 12. */
export function readStorefrontGridProductIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of value.slice(0, STOREFRONT_LIMITS.maxProductsPerGrid * 4)) {
    if (!isStorefrontProductId(entry)) continue;
    const id = entry.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= STOREFRONT_LIMITS.maxProductsPerGrid) break;
  }
  return ids;
}

/** 2, 3 or 4 columns (numbers or numeric strings); 3 for anything else. */
export function readStorefrontGridColumns(value: unknown): StorefrontProductGridColumns {
  const columns = typeof value === 'string' && /^\s*[234]\s*$/.test(value) ? Number(value.trim()) : value;
  return columns === 2 || columns === 3 || columns === 4 ? columns : 3;
}

/** A grid title for storage: control characters removed, at most 120 characters, null when blank. */
export function readStorefrontGridTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const max = STOREFRONT_LIMITS.maxGridTitleLength;
  const window = value.length > max * 4 ? value.slice(0, max * 4) : value;
  const cleaned = truncateStorefrontText(cleanStorefrontText(window, { singleLine: true }).text, max);
  return cleaned.trim() === '' ? null : cleaned;
}

function isValidIdList(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > STOREFRONT_LIMITS.maxProductsPerGrid) return false;
  return value.every((entry) => isStorefrontProductId(entry)) && new Set(value).size === value.length;
}

export const AffiliateProductGrid = Node.create<AffiliateProductGridOptions>({
  name: STOREFRONT_NODE_NAMES.productGrid,
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  isolating: true,

  addOptions() {
    return { nodeView: null };
  },

  addAttributes() {
    return {
      productIds: {
        default: [],
        validate: (value: unknown) => {
          if (!isValidIdList(value)) {
            throw new RangeError(
              `affiliateProductGrid.productIds must hold at most ${STOREFRONT_LIMITS.maxProductsPerGrid} distinct product ids`
            );
          }
        },
        parseHTML: (element: HTMLElement) =>
          readStorefrontGridProductIds((element.getAttribute('data-product-ids') ?? '').split(',')),
        renderHTML: (attributes: Record<string, unknown>) => ({
          'data-product-ids': readStorefrontGridProductIds(attributes['productIds']).join(','),
        }),
      },
      title: {
        default: null,
        validate: (value: unknown) => {
          if (!(value === null || (typeof value === 'string' && value.length <= STOREFRONT_LIMITS.maxGridTitleLength))) {
            throw new RangeError(
              `affiliateProductGrid.title must be null or at most ${STOREFRONT_LIMITS.maxGridTitleLength} characters`
            );
          }
        },
        parseHTML: (element: HTMLElement) => readStorefrontGridTitle(element.getAttribute('data-title')),
        renderHTML: (attributes: Record<string, unknown>) => {
          const title = readStorefrontGridTitle(attributes['title']);
          return title === null ? {} : { 'data-title': title };
        },
      },
      columns: {
        default: 3,
        validate: (value: unknown) => {
          if (value !== 2 && value !== 3 && value !== 4) throw new RangeError('affiliateProductGrid.columns must be 2, 3 or 4');
        },
        parseHTML: (element: HTMLElement) => readStorefrontGridColumns(element.getAttribute('data-columns')),
        renderHTML: (attributes: Record<string, unknown>) => ({
          'data-columns': String(readStorefrontGridColumns(attributes['columns'])),
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-affiliate-product-grid]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-affiliate-product-grid': '' })];
  },

  addNodeView() {
    return this.options.nodeView;
  },
});
