/**
 * Read helpers over storefront documents. Every helper is total: it accepts a sanitized
 * `StorefrontDoc` and stays safe (bounded, never throws) on a malformed one.
 */
import { STOREFRONT_LIMITS } from './limits';
import { isStorefrontProductId } from './sanitize';
import type { StorefrontDoc } from './types';

type JsonRecord = Record<string, unknown>;

const MAX_WALK_DEPTH = 16;
const MAX_WALK_NODES = STOREFRONT_LIMITS.maxInputNodes;
const VISIBLE_CHARACTER = /[^\s\u200b-\u200d\u2060\ufeff]/u;

interface WalkBudget {
  nodes: number;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(record: JsonRecord, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function children(node: JsonRecord): readonly unknown[] {
  const content = own(node, 'content');
  return Array.isArray(content) ? content : [];
}

function topLevelBlocks(doc: unknown): readonly unknown[] {
  return isRecord(doc) ? children(doc) : [];
}

function spend(budget: WalkBudget): boolean {
  budget.nodes -= 1;
  return budget.nodes >= 0;
}

/**
 * A new empty storefront document: one empty paragraph (the editor schema refuses a document
 * without blocks, so this is also what `sanitizeStorefrontDoc()` returns for empty input).
 */
export function emptyStorefrontDoc(): StorefrontDoc {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

function hasContent(node: unknown, depth: number, budget: WalkBudget): boolean {
  if (depth > MAX_WALK_DEPTH || !spend(budget) || !isRecord(node)) return false;
  const type = own(node, 'type');
  if (type === 'text') {
    const text = own(node, 'text');
    return typeof text === 'string' && VISIBLE_CHARACTER.test(text);
  }
  if (type === 'image') {
    const attrs = own(node, 'attrs');
    const src = isRecord(attrs) ? own(attrs, 'src') : undefined;
    return typeof src === 'string' && src.trim() !== '';
  }
  if (type === 'affiliateProductGrid') {
    const attrs = own(node, 'attrs');
    const ids = isRecord(attrs) ? own(attrs, 'productIds') : undefined;
    return Array.isArray(ids) && ids.some((id) => isStorefrontProductId(id));
  }
  for (const child of children(node)) {
    if (hasContent(child, depth + 1, budget)) return true;
  }
  return false;
}

/**
 * True when the document shows nothing: no visible text, no image and no product grid that lists
 * at least one product (an empty grid renders nothing on the public page). Horizontal rules and
 * empty paragraphs do not count.
 */
export function isStorefrontDocEmpty(doc: StorefrontDoc | null | undefined): boolean {
  const budget: WalkBudget = { nodes: MAX_WALK_NODES };
  for (const block of topLevelBlocks(doc)) {
    if (hasContent(block, 1, budget)) return false;
  }
  return true;
}

/**
 * Product ids of the document's top-level product grids (the only grids the renderer shows), in
 * document order, lowercased, deduplicated and capped at `maxFeaturedProducts` (the
 * `affiliate_pages.featured_product_ids` cardinality). Strings that are not uuids are skipped, so
 * the result is always safe to pass to a uuid column filter.
 */
export function collectStorefrontProductIds(doc: StorefrontDoc | null | undefined): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const block of topLevelBlocks(doc)) {
    if (!isRecord(block) || own(block, 'type') !== 'affiliateProductGrid') continue;
    const attrs = own(block, 'attrs');
    const productIds = isRecord(attrs) ? own(attrs, 'productIds') : undefined;
    if (!Array.isArray(productIds)) continue;
    for (const entry of productIds.slice(0, STOREFRONT_LIMITS.maxProductsPerGrid * 4)) {
      if (!isStorefrontProductId(entry)) continue;
      const id = entry.toLowerCase();
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      if (ids.length >= STOREFRONT_LIMITS.maxFeaturedProducts) return ids;
    }
  }
  return ids;
}

function inlineText(node: JsonRecord, budget: WalkBudget): string {
  let text = '';
  for (const child of children(node)) {
    if (!spend(budget) || !isRecord(child)) continue;
    const type = own(child, 'type');
    if (type === 'text') {
      const value = own(child, 'text');
      if (typeof value === 'string') text += value;
    } else if (type === 'hardBreak') {
      text += '\n';
    }
  }
  return text;
}

function blockText(node: unknown, depth: number, budget: WalkBudget): string {
  if (depth > MAX_WALK_DEPTH || !spend(budget) || !isRecord(node)) return '';
  switch (own(node, 'type')) {
    case 'paragraph':
    case 'heading':
    case 'storefrontCallout':
      return inlineText(node, budget).trim();
    case 'bulletList':
    case 'orderedList':
    case 'listItem':
    case 'blockquote':
      return children(node)
        .map((child) => blockText(child, depth + 1, budget))
        .filter((part) => part !== '')
        .join('\n');
    default:
      return '';
  }
}

/**
 * The document's visible text: blocks separated by a blank line, list items and quote paragraphs
 * by a line break, hard breaks kept as line breaks. Images, rules and product grids contribute
 * nothing.
 */
export function storefrontDocToPlainText(doc: StorefrontDoc | null | undefined): string {
  const budget: WalkBudget = { nodes: MAX_WALK_NODES };
  const parts: string[] = [];
  for (const block of topLevelBlocks(doc)) {
    const text = blockText(block, 1, budget);
    if (text !== '') parts.push(text);
  }
  return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * A one-line excerpt of at most `maxLength` characters: whitespace collapsed, cut at a word
 * boundary when one exists in the second half of the window, trailing punctuation dropped, and
 * `…` appended when shortened.
 */
export function storefrontExcerpt(doc: StorefrontDoc | null | undefined, maxLength: number): string {
  const max = Number.isFinite(maxLength) ? Math.floor(maxLength) : 0;
  if (max <= 0) return '';
  const text = storefrontDocToPlainText(doc).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  if (max === 1) return '…';
  let cut = text.slice(0, max - 1);
  const nextCharacter = text.charAt(max - 1);
  if (!/\s/.test(nextCharacter)) {
    const boundary = cut.lastIndexOf(' ');
    if (boundary >= Math.floor((max - 1) / 2)) cut = cut.slice(0, boundary);
  }
  const lastCode = cut.charCodeAt(cut.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) cut = cut.slice(0, -1);
  cut = cut.replace(/[\s,;:.!?\-\u2013\u2014(]+$/u, '');
  return `${cut}…`;
}

/** Words of visible text (tokens holding at least one letter or digit, any script). */
export function countStorefrontWords(doc: StorefrontDoc | null | undefined): number {
  let count = 0;
  for (const token of storefrontDocToPlainText(doc).split(/\s+/)) {
    if (/[\p{L}\p{N}]/u.test(token)) count += 1;
  }
  return count;
}
