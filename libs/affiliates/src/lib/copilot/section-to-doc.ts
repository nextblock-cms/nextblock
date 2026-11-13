/**
 * Turns the flat `generate_storefront_section` input into storefront blocks (SPEC §8). The model
 * never writes editor JSON: it fills typed blocks, and this module builds the nodes with literal
 * keys, keeps only catalog products and resolved stock photos, and finishes with the storefront
 * sanitizer, so the output is exactly what `sanitizeStorefrontDoc()` would keep (it passes it
 * unchanged) and can go straight into `StorefrontEditorApi.insertBlocks()`.
 */
import { collectStorefrontProductIds } from '../storefront/helpers';
import { STOREFRONT_LIMITS } from '../storefront/limits';
import { isStorefrontProductId, sanitizeStorefrontBlocks, sanitizeStorefrontImageAttrs } from '../storefront/sanitize';
import { cleanStorefrontText, truncateStorefrontText } from '../storefront/text';
import type {
  StorefrontBlockNode,
  StorefrontCalloutTone,
  StorefrontHeadingNode,
  StorefrontImageAttrs,
  StorefrontImageNode,
  StorefrontInlineNode,
  StorefrontListItemNode,
  StorefrontParagraphNode,
  StorefrontProductGridColumns,
  StorefrontProductGridNode,
} from '../storefront/types';
import {
  normalizeRetailerCopilotText,
  parseRetailerCopilotMarkdownLite,
  retailerCopilotMarkdownToPlainText,
  splitRetailerCopilotParagraphs,
} from './markdown-lite';
import type { RetailerSectionBlockInput, RetailerSectionToolInput } from './schemas';
import type { RetailerCopilotProduct, RetailerCopilotSectionContext, RetailerCopilotSectionConversion } from './types';

/** Products a copilot grid holds (the tool schema allows 8; the storefront allows 12). */
const MAX_GRID_PRODUCTS = Math.min(8, STOREFRONT_LIMITS.maxProductsPerGrid);
/** Paragraphs one paragraph block may produce; the rest joins the last one with line breaks. */
const MAX_PARAGRAPHS_PER_BLOCK = 10;
/** Top-level blocks one section may produce (a document holds 200). */
const MAX_SECTION_BLOCKS = 60;
const MAX_HEADING_LENGTH = 200;
/** The schema allows 120 characters for the section title. */
const MAX_SECTION_TITLE_LENGTH = 120;
/** Catalog products the tools index (the route passes at most 40). */
const MAX_CATALOG_PRODUCTS = 200;
const MAX_IMAGE_QUERY_LENGTH = 120;
const BULLET_MARKER = /^(?:[-*+•‣◦]|\d{1,3}[.)])\s+/;

function clipLine(text: string, max: number): string {
  return text.length > max ? truncateStorefrontText(text, max).trimEnd() : text;
}

/**
 * The cleaned stock photo search for an image block: one line, at most 120 characters, empty for
 * anything that looks like a URL (the model must describe a photo, never point at one).
 */
export function cleanRetailerCopilotImageQuery(query: unknown): string {
  if (typeof query !== 'string') return '';
  const cleaned = cleanStorefrontText(query.slice(0, MAX_IMAGE_QUERY_LENGTH * 4), { singleLine: true })
    .text.replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '' || /[a-z][a-z0-9+.-]*:\/\//i.test(cleaned) || /^www\./i.test(cleaned)) return '';
  return clipLine(cleaned, MAX_IMAGE_QUERY_LENGTH);
}

/** The key image lookups are stored under: the cleaned query, lowercased ('' = no lookup). */
export function normalizeRetailerCopilotImageQuery(query: unknown): string {
  return cleanRetailerCopilotImageQuery(query).toLowerCase();
}

/** The catalog by lowercase product id (uuid-shaped ids only, first occurrence wins). */
export function createRetailerCopilotCatalogIndex(
  products: readonly RetailerCopilotProduct[] | null | undefined
): Map<string, RetailerCopilotProduct> {
  const index = new Map<string, RetailerCopilotProduct>();
  if (!Array.isArray(products)) return index;
  for (const product of products as readonly unknown[]) {
    if (typeof product !== 'object' || product === null) continue;
    const candidate = (product as { id?: unknown }).id;
    const id = typeof candidate === 'string' ? candidate.trim().toLowerCase() : '';
    if (!isStorefrontProductId(id) || index.has(id)) continue;
    index.set(id, product as RetailerCopilotProduct);
    if (index.size >= MAX_CATALOG_PRODUCTS) break;
  }
  return index;
}

function catalogIds(catalog: ReadonlyMap<string, RetailerCopilotProduct>): Set<string> {
  const ids = new Set<string>();
  for (const [key, product] of catalog) {
    const id = typeof key === 'string' ? key.trim().toLowerCase() : '';
    if (product && isStorefrontProductId(id)) ids.add(id);
  }
  return ids;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function listOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function plainLine(value: unknown, max: number): string {
  return clipLine(retailerCopilotMarkdownToPlainText(value), max);
}

function headingNode(level: 2 | 3, text: string): StorefrontHeadingNode {
  return { type: 'heading', attrs: { level }, content: [{ type: 'text', text }] };
}

function paragraphNodes(text: string): StorefrontParagraphNode[] {
  let paragraphs = splitRetailerCopilotParagraphs(text);
  if (paragraphs.length > MAX_PARAGRAPHS_PER_BLOCK) {
    const head = paragraphs.slice(0, MAX_PARAGRAPHS_PER_BLOCK - 1);
    paragraphs = [...head, paragraphs.slice(MAX_PARAGRAPHS_PER_BLOCK - 1).join('\n')];
  }
  const nodes: StorefrontParagraphNode[] = [];
  for (const paragraph of paragraphs) {
    const content = parseRetailerCopilotMarkdownLite(paragraph);
    if (content.length > 0) nodes.push({ type: 'paragraph', content });
  }
  return nodes;
}

function bulletListNode(block: RetailerSectionBlockInput): StorefrontBlockNode | null {
  let items = listOf(block.items);
  if (items.every((item) => normalizeRetailerCopilotText(item) === '')) {
    // A model that put the list in `text`: one item per line.
    items = normalizeRetailerCopilotText(textOf(block.text)).split('\n');
  }
  const listItems: StorefrontListItemNode[] = [];
  for (const item of items) {
    const content = parseRetailerCopilotMarkdownLite(normalizeRetailerCopilotText(item).replace(BULLET_MARKER, ''), {
      lineBreaks: 'space',
    });
    if (content.length > 0) listItems.push({ type: 'listItem', content: [{ type: 'paragraph', content }] });
  }
  return listItems.length > 0 ? { type: 'bulletList', content: listItems } : null;
}

function calloutNode(block: RetailerSectionBlockInput): StorefrontBlockNode | null {
  const text = normalizeRetailerCopilotText(textOf(block.text)) === '' ? listOf(block.items).join('\n') : textOf(block.text);
  const content: StorefrontInlineNode[] = parseRetailerCopilotMarkdownLite(text);
  if (content.length === 0) return null;
  const tone: StorefrontCalloutTone =
    block.tone === 'tip' || block.tone === 'highlight' || block.tone === 'info' ? block.tone : 'info';
  return { type: 'storefrontCallout', attrs: { tone }, content };
}

/** Scales width and height down together so the larger side fits the storefront limit (4000 px). */
function fitImageDimensions(attrs: StorefrontImageAttrs): StorefrontImageAttrs {
  if (typeof attrs !== 'object' || attrs === null) return attrs;
  const { width, height } = attrs;
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isFinite(width) || !Number.isFinite(height)) {
    return attrs;
  }
  const largest = Math.max(width, height);
  if (width <= 0 || height <= 0 || largest <= STOREFRONT_LIMITS.maxImageDimension) return attrs;
  const scale = STOREFRONT_LIMITS.maxImageDimension / largest;
  return { ...attrs, width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function resolvedImage(
  images: ReadonlyMap<string, StorefrontImageAttrs | null>,
  query: unknown
): StorefrontImageAttrs | null {
  const key = normalizeRetailerCopilotImageQuery(query);
  if (key === '') return null;
  return images.get(key) ?? (typeof query === 'string' ? images.get(query) ?? images.get(query.trim()) : null) ?? null;
}

function imageNode(
  block: RetailerSectionBlockInput,
  ctx: RetailerCopilotSectionContext,
  usedSources: Set<string>
): StorefrontImageNode | null {
  const resolved = resolvedImage(ctx.images, block.image_query);
  if (!resolved) return null;
  const attrs = sanitizeStorefrontImageAttrs(fitImageDimensions(resolved), ctx.allowedImageOrigins);
  if (!attrs || usedSources.has(attrs.src)) return null;
  usedSources.add(attrs.src);
  // The provider's description of the actual photo first; the model only guessed what it shows.
  const alt =
    attrs.alt ||
    plainLine(block.text, STOREFRONT_LIMITS.maxAltLength) ||
    plainLine(cleanRetailerCopilotImageQuery(block.image_query), STOREFRONT_LIMITS.maxAltLength);
  return { type: 'image', attrs: { ...attrs, alt } };
}

function gridColumns(count: number): StorefrontProductGridColumns {
  if (count <= 2) return 2;
  return count % 4 === 0 ? 4 : 3;
}

function productGridNode(
  block: RetailerSectionBlockInput,
  ids: ReadonlySet<string>,
  stats: { droppedProductIds: number }
): StorefrontProductGridNode | null {
  const productIds: string[] = [];
  const seen = new Set<string>();
  for (const raw of listOf(block.product_ids)) {
    const id = raw.trim().toLowerCase();
    if (!ids.has(id)) {
      stats.droppedProductIds += 1;
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    productIds.push(id);
    if (productIds.length >= MAX_GRID_PRODUCTS) break;
  }
  if (productIds.length === 0) return null;
  const title = plainLine(block.text, STOREFRONT_LIMITS.maxGridTitleLength);
  return {
    type: 'affiliateProductGrid',
    attrs: { productIds, title: title === '' ? null : title, columns: gridColumns(productIds.length) },
  };
}

/**
 * Converts a section with its counters (what was dropped, for the tool output and the
 * model-facing summary). See `retailerSectionToStorefrontBlocks`.
 */
export function convertRetailerCopilotSection(
  input: RetailerSectionToolInput,
  ctx: RetailerCopilotSectionContext
): RetailerCopilotSectionConversion {
  const ids = catalogIds(ctx.catalog);
  const usedSources = new Set<string>();
  const stats = { droppedProductIds: 0, skippedImages: 0, skippedBlocks: 0 };
  const raw: StorefrontBlockNode[] = [];

  const title = plainLine(input.section_title, MAX_SECTION_TITLE_LENGTH);
  if (title !== '') raw.push(headingNode(2, title));

  const blocks = Array.isArray(input.blocks) ? input.blocks : [];
  for (const block of blocks) {
    if (raw.length >= MAX_SECTION_BLOCKS) {
      stats.skippedBlocks += 1;
      continue;
    }
    const produced: StorefrontBlockNode[] = [];
    switch (block?.kind) {
      case 'heading': {
        const text = plainLine(block.text, MAX_HEADING_LENGTH);
        if (text !== '') produced.push(headingNode(3, text));
        break;
      }
      case 'paragraph':
        produced.push(...paragraphNodes(textOf(block.text)));
        break;
      case 'bullet_list': {
        const list = bulletListNode(block);
        if (list) produced.push(list);
        break;
      }
      case 'callout': {
        const callout = calloutNode(block);
        if (callout) produced.push(callout);
        break;
      }
      case 'image': {
        const image = imageNode(block, ctx, usedSources);
        if (image) produced.push(image);
        else stats.skippedImages += 1;
        break;
      }
      case 'product_grid': {
        const grid = productGridNode(block, ids, stats);
        if (grid) produced.push(grid);
        break;
      }
      default:
        break;
    }
    if (produced.length === 0 && block?.kind !== 'image') stats.skippedBlocks += 1;
    raw.push(...produced.slice(0, MAX_SECTION_BLOCKS - raw.length));
  }

  // Defense in depth: the same allowlist walk every stored document goes through.
  const sanitized = sanitizeStorefrontBlocks(raw, { allowedImageOrigins: ctx.allowedImageOrigins }).blocks;
  return {
    title,
    blocks: sanitized,
    productIds: collectStorefrontProductIds({ type: 'doc', content: sanitized }),
    imageCount: sanitized.filter((node) => node.type === 'image').length,
    droppedProductIds: stats.droppedProductIds,
    skippedImages: stats.skippedImages,
    skippedBlocks: stats.skippedBlocks,
  };
}

/**
 * The section as storefront blocks: `section_title` → H2; `heading` → H3; `paragraph` → one
 * paragraph per blank-line-separated chunk and `callout` → a callout (tone `none` → `info`), both
 * with markdown-lite marks (`**bold**`, `*italic*`, `[label](https://…)`; unsafe links lose their
 * href, keep their text); `bullet_list` → a bullet list; `image` → the photo resolved for its
 * query (skipped when there is none, its host is not allowed or it repeats); `product_grid` → a
 * product grid of the ids found in the catalog (skipped when none is). Finished by
 * `sanitizeStorefrontBlocks`, so the result passes `sanitizeStorefrontDoc()` unchanged.
 */
export function retailerSectionToStorefrontBlocks(
  input: RetailerSectionToolInput,
  ctx: RetailerCopilotSectionContext
): StorefrontBlockNode[] {
  return convertRetailerCopilotSection(input, ctx).blocks;
}

/**
 * Unsplash `download_location` URLs of the photos in `blocks` (deduplicated): the Unsplash API
 * guidelines require pinging them when a photo is used, which the copilot route does after the
 * response with Cortex `maybeTriggerStockPhotoDownloads`.
 */
export function collectRetailerCopilotUnsplashDownloads(blocks: readonly StorefrontBlockNode[]): string[] {
  const locations = new Set<string>();
  for (const block of blocks) {
    if (block?.type !== 'image') continue;
    const credit = block.attrs?.credit;
    if (credit?.provider === 'unsplash' && typeof credit.downloadLocation === 'string' && credit.downloadLocation) {
      locations.add(credit.downloadLocation);
    }
  }
  return [...locations];
}
