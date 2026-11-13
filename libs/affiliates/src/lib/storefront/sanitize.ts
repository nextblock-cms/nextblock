/**
 * The storefront sanitizer: the security boundary for partner-authored storefront JSON.
 *
 * `draft_content` is untrusted (an RTL may PATCH it over the Data API, the copilot writes into it,
 * the editor emits it). Everything that is stored, reviewed, published or rendered goes through
 * `sanitizeStorefrontDoc()`: a hand-written allowlist walk that rebuilds the document from scratch
 * with literal keys, so nothing outside the `StorefrontDoc` shape (types.ts) survives: no raw HTML,
 * no classes, styles or event attributes, no unknown nodes or marks, no unsafe URLs.
 *
 * Guarantees:
 * - total: never throws (any input, including cyclic objects, proxies and getters that throw);
 * - deterministic and idempotent: `sanitize(sanitize(x).doc)` deep-equals `sanitize(x).doc`,
 *   with `changed: false` and no issues;
 * - bounded: string inputs over `maxInputBytes` are refused before parsing; the walk stops after
 *   `maxInputNodes` nodes and `maxInputDepth` nesting levels; every content limit in
 *   `STOREFRONT_LIMITS` is enforced by truncation;
 * - no prototype pollution: input is read through own-property checks only, output objects are
 *   literals with fixed keys, node types are compared to literals (never used as lookup keys);
 * - editor-loadable: the output always satisfies the editor schema (`doc` holds at least one block,
 *   a list item starts with a paragraph, lists and quotes are never empty, no empty text nodes).
 */
import { STOREFRONT_LIMITS } from './limits';
import { cleanStorefrontText, storefrontJsonbTextByteLength, storefrontUtf8ByteLength, truncateStorefrontText } from './text';
import {
  normalizeStorefrontImageOrigins,
  normalizeStorefrontImageSrcWithOrigins,
  sanitizeStorefrontHref,
} from './urls';
import type {
  StorefrontBlockNode,
  StorefrontBlockquoteNode,
  StorefrontBulletListNode,
  StorefrontCalloutNode,
  StorefrontCalloutTone,
  StorefrontDoc,
  StorefrontHeadingNode,
  StorefrontImageAttrs,
  StorefrontImageCredit,
  StorefrontImageNode,
  StorefrontInlineNode,
  StorefrontListItemNode,
  StorefrontMark,
  StorefrontOrderedListNode,
  StorefrontParagraphNode,
  StorefrontProductGridColumns,
  StorefrontProductGridNode,
  StorefrontSanitizeOptions,
  StorefrontSanitizeResult,
  StorefrontTextNode,
} from './types';

/** Result of `sanitizeStorefrontBlocks()`: like a document result, without the one-block minimum. */
export interface StorefrontSanitizeBlocksResult {
  blocks: StorefrontBlockNode[];
  issues: string[];
  changed: boolean;
}

type ListItemChild = StorefrontParagraphNode | StorefrontBulletListNode | StorefrontOrderedListNode;
type JsonRecord = Record<string, unknown>;

const LIMITS = STOREFRONT_LIMITS;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Node types whose text is code or markup, never prose: dropped without salvaging their text. */
const OPAQUE_TYPE_PATTERN = /script|style|iframe|frame|svg|object|embed|applet|template|math|html|canvas/i;
/** Block-like wrappers whose text gets a line break before it when lifted into inline content. */
const BLOCKISH_TYPES: ReadonlySet<string> = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'listItem',
  'bulletList',
  'orderedList',
  'storefrontCallout',
  'codeBlock',
  'taskList',
  'taskItem',
  'table',
  'tableRow',
  'tableCell',
  'tableHeader',
  'details',
  'detailsSummary',
  'detailsContent',
]);
const CREDIT_PAGE_HOSTS = {
  pexels: new Set(['pexels.com', 'www.pexels.com']),
  unsplash: new Set(['unsplash.com', 'www.unsplash.com']),
} as const;
const CREDIT_HOME_URLS = {
  pexels: 'https://www.pexels.com/',
  unsplash: 'https://unsplash.com/',
} as const;
const UNSPLASH_DOWNLOAD_HOSTS: ReadonlySet<string> = new Set(['api.unsplash.com']);
const MAX_ISSUE_MESSAGES = 50;
/**
 * Output size estimate at which the walk stops building; the exact byte limit is enforced
 * afterwards by dropping trailing blocks. Each node is charged at most ~1.4x its serialized size
 * (fixed per-node costs, string lengths in code units), so a document that already fits
 * `maxJsonBytes` (measured as jsonb text, never shorter than compact JSON) never reaches this cap
 * on a second pass (idempotence).
 */
const OUTPUT_ESTIMATE_CAP = LIMITS.maxJsonBytes * 2;
/** `{"type": "doc", "content": []}` as jsonb text: the document around its blocks. */
const DOC_JSONB_OVERHEAD = storefrontJsonbTextByteLength({ type: 'doc', content: [] });
/** jsonb text separates array elements with `, `. */
const JSONB_ELEMENT_SEPARATOR_BYTES = 2;

const MESSAGE_DEPTH = `Removed content nested more than ${LIMITS.maxInputDepth} levels deep.`;
const MESSAGE_NODES = `Removed content beyond the first ${LIMITS.maxInputNodes} nodes of the document.`;
const MESSAGE_BYTES = `Removed blocks beyond the ${LIMITS.maxJsonBytes}-byte document size limit.`;
const MESSAGE_TOTAL_TEXT = `Removed text beyond the page limit of ${LIMITS.maxTotalText} characters.`;
const MESSAGE_BLOCKS = `Removed blocks beyond the limit of ${LIMITS.maxBlocks}.`;
const MESSAGE_FAILURE = 'The document could not be processed and was replaced with an empty page.';

interface WalkContext {
  readonly origins: ReadonlySet<string>;
  readonly issues: Map<string, number>;
  unlistedIssues: number;
  visited: number;
  stopped: boolean;
  outputEstimate: number;
  textUsed: number;
  images: number;
  grids: number;
  readonly productIds: Set<string>;
}

function isRecord(value: unknown): value is JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Own-property read: a key inherited from a (possibly polluted) prototype is never seen. */
function own(record: JsonRecord, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** A log-safe label for a node or mark type taken from untrusted input. */
function describeType(type: unknown): string {
  if (typeof type !== 'string') return 'unknown';
  const label = type.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  return label === '' ? 'unknown' : label;
}

function isOpaqueType(type: unknown): boolean {
  return typeof type === 'string' && OPAQUE_TYPE_PATTERN.test(type);
}

function isInlineShaped(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const type = own(value, 'type');
  return type === 'text' || type === 'hardBreak';
}

/** True for a string shaped like a Postgres uuid (any case). */
export function isStorefrontProductId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 && UUID_PATTERN.test(value);
}

function createContext(options: StorefrontSanitizeOptions | null | undefined): WalkContext {
  // Options come from our own code (not from the partner), so a plain property read is fine here.
  const allowed: unknown = typeof options === 'object' && options !== null ? options.allowedImageOrigins : undefined;
  return {
    origins: normalizeStorefrontImageOrigins(Array.isArray(allowed) ? (allowed as readonly string[]) : []),
    issues: new Map(),
    unlistedIssues: 0,
    visited: 0,
    stopped: false,
    outputEstimate: 0,
    textUsed: 0,
    images: 0,
    grids: 0,
    productIds: new Set(),
  };
}

function report(ctx: WalkContext | null, message: string): void {
  if (!ctx) return;
  const count = ctx.issues.get(message);
  if (count !== undefined) ctx.issues.set(message, count + 1);
  else if (ctx.issues.size < MAX_ISSUE_MESSAGES) ctx.issues.set(message, 1);
  else ctx.unlistedIssues += 1;
}

function stop(ctx: WalkContext, message: string): void {
  if (ctx.stopped) return;
  ctx.stopped = true;
  report(ctx, message);
}

/** Counts one input node against the walk budget; false once the walk must stop. */
function visit(ctx: WalkContext): boolean {
  if (ctx.stopped) return false;
  ctx.visited += 1;
  if (ctx.visited > LIMITS.maxInputNodes) {
    stop(ctx, MESSAGE_NODES);
    return false;
  }
  return true;
}

/** Charges the estimated JSON size of a node about to be emitted; false (and stop) when over cap. */
function charge(ctx: WalkContext, cost: number): boolean {
  if (ctx.outputEstimate + cost > OUTPUT_ESTIMATE_CAP) {
    stop(ctx, MESSAGE_BYTES);
    return false;
  }
  ctx.outputEstimate += cost;
  return true;
}

function formatIssues(ctx: WalkContext): string[] {
  const issues: string[] = [];
  for (const [message, count] of ctx.issues) {
    issues.push(count > 1 ? `${message} (${count} times)` : message);
  }
  if (ctx.unlistedIssues > 0) issues.push(`${ctx.unlistedIssues} more issues were not listed.`);
  return issues;
}

function readInteger(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value === 'string' && /^\s*-?\d{1,6}\s*$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

/** Cleans a single-line attribute string (alt, titles, names); '' for a non-string. */
function cleanLine(value: unknown, max: number, ctx: WalkContext | null, label: string): string {
  if (typeof value !== 'string') return '';
  const window = max * 4 + 16;
  const source = value.length > window ? value.slice(0, window) : value;
  const cleaned = cleanStorefrontText(source, { singleLine: true });
  if (cleaned.altered) report(ctx, `Removed line breaks or control characters from ${label}.`);
  let text = cleaned.text.trim();
  if (text.length > max || value.length > source.length) {
    text = truncateStorefrontText(text, max).trimEnd();
    report(ctx, `Shortened ${label} to ${max} characters.`);
  }
  return text;
}

// ---------------------------------------------------------------------------------------------
// Inline content
// ---------------------------------------------------------------------------------------------

function sanitizeMarks(raw: unknown, ctx: WalkContext): StorefrontMark[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    report(ctx, 'Removed invalid text formatting.');
    return [];
  }
  let href: string | null = null;
  let bold = false;
  let italic = false;
  let strike = false;
  let underline = false;
  for (let index = 0; index < raw.length; index += 1) {
    if (!visit(ctx)) break;
    const mark: unknown = raw[index];
    if (!isRecord(mark)) {
      report(ctx, 'Removed invalid text formatting.');
      continue;
    }
    const type = own(mark, 'type');
    if (type === 'bold') bold = true;
    else if (type === 'italic') italic = true;
    else if (type === 'strike') strike = true;
    else if (type === 'underline') underline = true;
    else if (type === 'link') {
      const attrs = own(mark, 'attrs');
      const candidate = isRecord(attrs) ? sanitizeStorefrontHref(own(attrs, 'href')) : null;
      if (candidate === null) report(ctx, 'Removed a link with an unsafe or invalid address (its text was kept).');
      else if (href === null) href = candidate;
      else if (candidate !== href) report(ctx, 'Removed a second link on the same text.');
    } else {
      report(ctx, `Removed unsupported text formatting "${describeType(type)}".`);
    }
  }
  // Canonical order = the editor schema's mark rank, so editor round trips never reorder marks.
  const marks: StorefrontMark[] = [];
  if (href !== null) marks.push({ type: 'link', attrs: { href } });
  if (bold) marks.push({ type: 'bold' });
  if (italic) marks.push({ type: 'italic' });
  if (strike) marks.push({ type: 'strike' });
  if (underline) marks.push({ type: 'underline' });
  return marks;
}

function sanitizeTextNode(raw: JsonRecord, ctx: WalkContext): StorefrontTextNode | null {
  const value = own(raw, 'text');
  if (typeof value !== 'string') {
    report(ctx, 'Removed a text node without text.');
    return null;
  }
  const window = LIMITS.maxTextLength * 2 + 16;
  const source = value.length > window ? value.slice(0, window) : value;
  const cleaned = cleanStorefrontText(source);
  if (cleaned.altered) report(ctx, 'Removed control or invisible formatting characters from text.');
  let text = cleaned.text;
  if (value.length > source.length || text.length > LIMITS.maxTextLength) {
    text = truncateStorefrontText(text, LIMITS.maxTextLength);
    report(ctx, `Shortened a text longer than ${LIMITS.maxTextLength} characters.`);
  }
  if (text.length === 0) {
    report(ctx, 'Removed an empty text node.');
    return null;
  }
  const marks = sanitizeMarks(own(raw, 'marks'), ctx);
  const remaining = LIMITS.maxTotalText - ctx.textUsed;
  if (remaining <= 0) {
    stop(ctx, MESSAGE_TOTAL_TEXT);
    return null;
  }
  if (text.length > remaining) {
    text = truncateStorefrontText(text, remaining);
    stop(ctx, MESSAGE_TOTAL_TEXT);
    if (text.length === 0) return null;
  }
  let cost = 25 + text.length;
  for (const mark of marks) cost += mark.type === 'link' ? 40 + mark.attrs.href.length : 16;
  if (!charge(ctx, cost)) return null;
  ctx.textUsed += text.length;
  return marks.length > 0 ? { type: 'text', text, marks } : { type: 'text', text };
}

function collectInline(
  items: readonly unknown[],
  ctx: WalkContext,
  hops: number,
  out: StorefrontInlineNode[],
): void {
  if (hops > LIMITS.maxInputDepth) {
    report(ctx, MESSAGE_DEPTH);
    return;
  }
  for (let index = 0; index < items.length; index += 1) {
    if (!visit(ctx)) return;
    const item: unknown = items[index];
    if (!isRecord(item)) {
      report(ctx, 'Removed invalid inline content.');
      continue;
    }
    const type = own(item, 'type');
    if (type === 'text') {
      const node = sanitizeTextNode(item, ctx);
      if (node) out.push(node);
      if (ctx.stopped) return;
      continue;
    }
    if (type === 'hardBreak') {
      if (!charge(ctx, 20)) return;
      out.push({ type: 'hardBreak' });
      continue;
    }
    if (isOpaqueType(type)) {
      report(ctx, `Removed unsupported content "${describeType(type)}".`);
      continue;
    }
    const content = own(item, 'content');
    if (!Array.isArray(content) || content.length === 0) {
      report(ctx, `Removed unsupported inline content "${describeType(type)}".`);
      continue;
    }
    // A wrapper (unknown inline node, or a block where only text belongs): keep its text.
    report(ctx, `Removed unsupported wrapper "${describeType(type)}" and kept its text.`);
    const start = out.length;
    const separate =
      typeof type === 'string' && BLOCKISH_TYPES.has(type) && start > 0 && out[start - 1]?.type !== 'hardBreak';
    collectInline(content, ctx, hops + 1, out);
    if (separate && out.length > start && out[start]?.type !== 'hardBreak') {
      if (!charge(ctx, 20)) {
        out.length = start;
        return;
      }
      out.splice(start, 0, { type: 'hardBreak' });
    }
    if (ctx.stopped) return;
  }
}

function walkInline(raw: unknown, ctx: WalkContext, hops: number): StorefrontInlineNode[] {
  const out: StorefrontInlineNode[] = [];
  if (raw === undefined || raw === null) return out;
  if (!Array.isArray(raw)) {
    report(ctx, 'Removed invalid text content.');
    return out;
  }
  collectInline(raw, ctx, hops, out);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------------------------

/**
 * Walks block children: runs of loose inline nodes go to `onRun` (as one paragraph's content),
 * every other record to `onBlock`. Each input node is visited exactly once.
 */
function walkBlockChildren(
  items: readonly unknown[],
  ctx: WalkContext,
  hops: number,
  onRun: (run: StorefrontInlineNode[]) => boolean,
  onBlock: (item: JsonRecord, type: unknown) => boolean,
): void {
  if (hops > LIMITS.maxInputDepth) {
    report(ctx, MESSAGE_DEPTH);
    return;
  }
  let index = 0;
  while (index < items.length && !ctx.stopped) {
    const item: unknown = items[index];
    if (isInlineShaped(item)) {
      const scanLimit = Math.min(items.length, index + LIMITS.maxInputNodes);
      let end = index + 1;
      while (end < scanLimit && isInlineShaped(items[end])) end += 1;
      const run = walkInline(items.slice(index, end), ctx, hops + 1);
      index = end;
      if (run.length === 0) continue;
      report(ctx, 'Wrapped loose text in a paragraph.');
      if (!onRun(run)) return;
      continue;
    }
    index += 1;
    if (!visit(ctx)) return;
    if (!isRecord(item)) {
      report(ctx, 'Removed an invalid block.');
      continue;
    }
    if (!onBlock(item, own(item, 'type'))) return;
  }
}

function pushRunParagraph(out: StorefrontParagraphNode[], run: StorefrontInlineNode[], ctx: WalkContext): boolean {
  if (!charge(ctx, 24)) return false;
  out.push({ type: 'paragraph', content: run });
  return true;
}

function sanitizeParagraph(raw: JsonRecord, ctx: WalkContext, hops: number): StorefrontParagraphNode | null {
  if (!charge(ctx, 24)) return null;
  const content = walkInline(own(raw, 'content'), ctx, hops + 1);
  return content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };
}

function headingLevel(value: unknown, ctx: WalkContext): 2 | 3 {
  const level = readInteger(value);
  if (level === 2 || level === 3) return level;
  if (level === 1) {
    report(ctx, 'Changed a level 1 heading to level 2 (the page title is the level 1 heading).');
    return 2;
  }
  if (level !== null && level >= 4 && level <= 6) {
    report(ctx, `Changed a level ${level} heading to level 3.`);
    return 3;
  }
  report(ctx, 'Reset an invalid heading level to 2.');
  return 2;
}

function sanitizeHeading(raw: JsonRecord, ctx: WalkContext, hops: number): StorefrontHeadingNode | null {
  if (!charge(ctx, 48)) return null;
  const attrs = own(raw, 'attrs');
  const level = headingLevel(isRecord(attrs) ? own(attrs, 'level') : undefined, ctx);
  const content = walkInline(own(raw, 'content'), ctx, hops + 1);
  return content.length > 0
    ? { type: 'heading', attrs: { level }, content }
    : { type: 'heading', attrs: { level } };
}

/** Plain inline content of an unknown node becomes a paragraph; anything else is dropped. */
function salvageUnknownBlock(
  raw: JsonRecord,
  type: unknown,
  ctx: WalkContext,
  hops: number,
): StorefrontParagraphNode | null {
  const label = describeType(type);
  const content = own(raw, 'content');
  if (
    !isOpaqueType(type) &&
    Array.isArray(content) &&
    content.length > 0 &&
    content.length <= LIMITS.maxInputNodes &&
    content.every(isInlineShaped)
  ) {
    report(ctx, `Replaced unsupported block "${label}" with a paragraph of its text.`);
    if (!charge(ctx, 24)) return null;
    const inline = walkInline(content, ctx, hops + 1);
    return inline.length > 0 ? { type: 'paragraph', content: inline } : null;
  }
  report(ctx, `Removed unsupported block "${label}".`);
  return null;
}

/** Flattens a node into paragraphs of its text (used where a structure is not allowed). */
function flattenToParagraphs(
  raw: JsonRecord,
  ctx: WalkContext,
  hops: number,
  out: StorefrontParagraphNode[],
): void {
  if (hops > LIMITS.maxInputDepth) {
    report(ctx, MESSAGE_DEPTH);
    return;
  }
  const type = own(raw, 'type');
  switch (type) {
    case 'paragraph':
    case 'heading':
    case 'storefrontCallout': {
      const paragraph = sanitizeParagraph(raw, ctx, hops);
      if (paragraph?.content) out.push(paragraph);
      return;
    }
    case 'bulletList':
    case 'orderedList':
    case 'listItem':
    case 'blockquote': {
      const content = own(raw, 'content');
      if (!Array.isArray(content)) return;
      walkBlockChildren(
        content,
        ctx,
        hops + 1,
        (run) => pushRunParagraph(out, run, ctx),
        (item) => {
          flattenToParagraphs(item, ctx, hops + 1, out);
          return true;
        },
      );
      return;
    }
    case 'image':
    case 'affiliateProductGrid':
    case 'horizontalRule':
      report(ctx, `Removed ${describeType(type)} from a position that only allows text.`);
      return;
    default: {
      const paragraph = salvageUnknownBlock(raw, type, ctx, hops);
      if (paragraph) out.push(paragraph);
    }
  }
}

function listStart(value: unknown, ctx: WalkContext): number {
  if (value === undefined || value === null) return 1;
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : readInteger(value);
  if (parsed === null) {
    report(ctx, 'Reset an invalid list start number to 1.');
    return 1;
  }
  const start = Math.min(Math.max(parsed, 0), 9999);
  if (start !== value) report(ctx, 'Normalized a list start number.');
  return start;
}

function walkListItemContent(
  items: readonly unknown[],
  ctx: WalkContext,
  depth: number,
  hops: number,
): ListItemChild[] {
  const out: ListItemChild[] = [];
  const paragraphs: StorefrontParagraphNode[] = [];
  const flushParagraphs = (): void => {
    for (const paragraph of paragraphs) out.push(paragraph);
    paragraphs.length = 0;
  };
  walkBlockChildren(
    items,
    ctx,
    hops,
    (run) => {
      const ok = pushRunParagraph(paragraphs, run, ctx);
      flushParagraphs();
      return ok;
    },
    (item, type) => {
      if (type === 'paragraph') {
        const paragraph = sanitizeParagraph(item, ctx, hops);
        if (paragraph) out.push(paragraph);
        return true;
      }
      if (type === 'bulletList' || type === 'orderedList') {
        if (depth + 2 <= LIMITS.maxDepth) {
          const list = sanitizeList(item, type, ctx, depth, hops);
          if (list) out.push(list);
        } else {
          report(ctx, `Flattened a list nested more than ${LIMITS.maxDepth} levels deep into paragraphs.`);
          flattenToParagraphs(item, ctx, hops, paragraphs);
          flushParagraphs();
        }
        return true;
      }
      if (type === 'heading' || type === 'blockquote' || type === 'storefrontCallout' || type === 'listItem') {
        report(ctx, `Converted ${describeType(type)} inside a list item to paragraphs.`);
        flattenToParagraphs(item, ctx, hops, paragraphs);
        flushParagraphs();
        return true;
      }
      if (type === 'image' || type === 'affiliateProductGrid' || type === 'horizontalRule') {
        report(ctx, `Removed ${describeType(type)} from a list item (list items hold text and lists only).`);
        return true;
      }
      const paragraph = salvageUnknownBlock(item, type, ctx, hops);
      if (paragraph) out.push(paragraph);
      return true;
    },
  );
  return out;
}

function sanitizeListItem(raw: JsonRecord, ctx: WalkContext, depth: number, hops: number): StorefrontListItemNode | null {
  if (hops > LIMITS.maxInputDepth) {
    report(ctx, MESSAGE_DEPTH);
    return null;
  }
  let children: readonly unknown[];
  if (own(raw, 'type') === 'listItem') {
    const content = own(raw, 'content');
    children = Array.isArray(content) ? content : [];
  } else {
    report(ctx, 'Repaired a list that held something other than list items.');
    children = [raw];
  }
  if (!charge(ctx, 32)) return null;
  const content = walkListItemContent(children, ctx, depth + 1, hops + 1);
  if (content.length === 0) {
    if (!ctx.stopped) report(ctx, 'Removed an empty list item.');
    return null;
  }
  if (content[0]?.type !== 'paragraph') {
    // The editor schema requires a list item to start with a paragraph.
    if (!charge(ctx, 24)) return null;
    content.unshift({ type: 'paragraph' });
  }
  return { type: 'listItem', content };
}

function sanitizeList(
  raw: JsonRecord,
  kind: 'bulletList' | 'orderedList',
  ctx: WalkContext,
  depth: number,
  hops: number,
): StorefrontBulletListNode | StorefrontOrderedListNode | null {
  if (!charge(ctx, 48)) return null;
  const items: StorefrontListItemNode[] = [];
  const content = own(raw, 'content');
  if (Array.isArray(content)) {
    for (let index = 0; index < content.length; index += 1) {
      if (!visit(ctx)) break;
      const child: unknown = content[index];
      if (!isRecord(child)) {
        report(ctx, 'Removed an invalid list item.');
        continue;
      }
      const item = sanitizeListItem(child, ctx, depth + 1, hops + 1);
      if (item) items.push(item);
    }
  } else if (content !== undefined && content !== null) {
    report(ctx, 'Removed invalid list content.');
  }
  if (items.length === 0) {
    if (!ctx.stopped) report(ctx, 'Removed an empty list.');
    return null;
  }
  if (kind === 'orderedList') {
    const attrs = own(raw, 'attrs');
    const start = listStart(isRecord(attrs) ? own(attrs, 'start') : undefined, ctx);
    return { type: 'orderedList', attrs: { start }, content: items };
  }
  return { type: 'bulletList', content: items };
}

function sanitizeBlockquote(raw: JsonRecord, ctx: WalkContext, hops: number): StorefrontBlockquoteNode | null {
  if (!charge(ctx, 40)) return null;
  const paragraphs: StorefrontParagraphNode[] = [];
  const content = own(raw, 'content');
  if (Array.isArray(content)) {
    walkBlockChildren(
      content,
      ctx,
      hops + 1,
      (run) => pushRunParagraph(paragraphs, run, ctx),
      (item, type) => {
        if (type === 'paragraph') {
          const paragraph = sanitizeParagraph(item, ctx, hops + 1);
          if (paragraph) paragraphs.push(paragraph);
          return true;
        }
        if (type === 'heading' || type === 'bulletList' || type === 'orderedList' || type === 'blockquote' || type === 'storefrontCallout' || type === 'listItem') {
          report(ctx, `Converted ${describeType(type)} inside a quote to paragraphs.`);
        }
        flattenToParagraphs(item, ctx, hops + 1, paragraphs);
        return true;
      },
    );
  } else if (content !== undefined && content !== null) {
    report(ctx, 'Removed invalid quote content.');
  }
  if (paragraphs.length === 0) {
    if (!ctx.stopped) report(ctx, 'Removed an empty quote.');
    return null;
  }
  return { type: 'blockquote', content: paragraphs };
}

function sanitizeCallout(raw: JsonRecord, ctx: WalkContext, hops: number): StorefrontCalloutNode | null {
  if (!charge(ctx, 64)) return null;
  const attrs = own(raw, 'attrs');
  const value = isRecord(attrs) ? own(attrs, 'tone') : undefined;
  let tone: StorefrontCalloutTone = 'info';
  if (value === 'info' || value === 'tip' || value === 'highlight') tone = value;
  else if (value !== undefined && value !== null) report(ctx, 'Reset an invalid callout style to "info".');
  const content = walkInline(own(raw, 'content'), ctx, hops + 1);
  return content.length > 0
    ? { type: 'storefrontCallout', attrs: { tone }, content }
    : { type: 'storefrontCallout', attrs: { tone } };
}

// ---------------------------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------------------------

function creditUrl(raw: unknown, hosts: ReadonlySet<string>, pathPrefix: string | null): string | null {
  if (typeof raw !== 'string' || raw.length > LIMITS.maxCreditUrlLength * 2) return null;
  const href = sanitizeStorefrontHref(raw);
  if (href === null || !href.startsWith('https://') || href.length > LIMITS.maxCreditUrlLength) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!hosts.has(url.hostname) || url.port !== '') return null;
  if (pathPrefix !== null && !url.pathname.startsWith(pathPrefix)) return null;
  return href;
}

function sanitizeCredit(raw: unknown, ctx: WalkContext | null): StorefrontImageCredit | null {
  if (!isRecord(raw)) return null;
  const provider = own(raw, 'provider');
  if (provider !== 'pexels' && provider !== 'unsplash') return null;
  const photographer = cleanLine(own(raw, 'photographer'), LIMITS.maxCreditTextLength, ctx, 'a photographer name');
  if (photographer === '') return null;
  const hosts = CREDIT_PAGE_HOSTS[provider];
  const rawPhotographerUrl = own(raw, 'photographerUrl');
  const rawSourceUrl = own(raw, 'sourceUrl');
  let photographerUrl = creditUrl(rawPhotographerUrl, hosts, null);
  let sourceUrl = creditUrl(rawSourceUrl, hosts, null);
  if (photographerUrl === null || sourceUrl === null) {
    report(ctx, `Replaced an invalid photo credit link with the ${provider === 'unsplash' ? 'Unsplash' : 'Pexels'} home page.`);
    photographerUrl ??= CREDIT_HOME_URLS[provider];
    sourceUrl ??= CREDIT_HOME_URLS[provider];
  }
  let downloadLocation: string | null = null;
  let utmSource: string | null = null;
  if (provider === 'unsplash') {
    const rawDownload = own(raw, 'downloadLocation');
    if (rawDownload !== undefined && rawDownload !== null) {
      // The server pings this URL with the operator's Unsplash key: only the Unsplash API qualifies.
      downloadLocation = creditUrl(rawDownload, UNSPLASH_DOWNLOAD_HOSTS, '/photos/');
      if (downloadLocation === null) report(ctx, 'Removed an invalid Unsplash download link from a photo credit.');
    }
    const rawUtm = own(raw, 'utmSource');
    if (typeof rawUtm === 'string') {
      utmSource = cleanLine(rawUtm, LIMITS.maxCreditTextLength, ctx, 'an Unsplash app name') || null;
    }
  }
  return { provider, photographer, photographerUrl, sourceUrl, downloadLocation, utmSource };
}

/**
 * A validated stock photo credit, or null: provider `pexels` | `unsplash`, a photographer name
 * (≤ 120 characters), https profile and photo-page links on the provider's own site (an invalid one
 * falls back to the provider home page), an Unsplash `downloadLocation` on `api.unsplash.com/photos/`
 * only (null for Pexels), and the Unsplash `utmSource` (null for Pexels).
 */
export function sanitizeStorefrontImageCredit(raw: unknown): StorefrontImageCredit | null {
  try {
    return sanitizeCredit(raw, null);
  } catch {
    return null;
  }
}

function imageDimension(value: unknown, ctx: WalkContext | null): number | null {
  if (value === undefined || value === null || value === '') return null;
  let parsed: number | null = null;
  if (typeof value === 'number' && Number.isFinite(value)) parsed = Math.round(value);
  else if (typeof value === 'string' && /^\s*\d{1,6}(?:\.\d+)?\s*(?:px)?\s*$/i.test(value)) {
    parsed = Math.round(Number.parseFloat(value));
  }
  if (parsed !== null && parsed >= 1 && parsed <= LIMITS.maxImageDimension) return parsed;
  report(ctx, 'Removed invalid image dimensions.');
  return null;
}

function sanitizeImageAttrsInternal(
  raw: unknown,
  origins: ReadonlySet<string>,
  ctx: WalkContext | null,
): StorefrontImageAttrs | null {
  if (!isRecord(raw)) {
    report(ctx, 'Removed an image without an address.');
    return null;
  }
  const src = normalizeStorefrontImageSrcWithOrigins(own(raw, 'src'), origins);
  if (src === null) {
    report(ctx, 'Removed an image whose address is not on an allowed image host.');
    return null;
  }
  const alt = cleanLine(own(raw, 'alt'), LIMITS.maxAltLength, ctx, 'an image description');
  const title = cleanLine(own(raw, 'title'), LIMITS.maxImageTitleLength, ctx, 'an image title');
  const width = imageDimension(own(raw, 'width'), ctx);
  const height = imageDimension(own(raw, 'height'), ctx);
  const rawCredit = own(raw, 'credit');
  const credit = sanitizeCredit(rawCredit, ctx);
  if (credit === null && rawCredit !== undefined && rawCredit !== null) {
    report(ctx, 'Removed an image credit with invalid details.');
  }
  return { src, alt, title: title === '' ? null : title, width, height, credit };
}

/**
 * Validated image attributes, or null when the src is not allowed (see
 * `normalizeStorefrontImageSrc`). Builds the exact `StorefrontImageAttrs` shape: alt ≤ 250
 * characters (missing → ''), title or null, width/height positive integers ≤ 4000 or null, and a
 * validated credit or null.
 */
export function sanitizeStorefrontImageAttrs(
  raw: unknown,
  allowedImageOrigins: readonly string[],
): StorefrontImageAttrs | null {
  try {
    return sanitizeImageAttrsInternal(raw, normalizeStorefrontImageOrigins(allowedImageOrigins), null);
  } catch {
    return null;
  }
}

function sanitizeImageNode(raw: JsonRecord, ctx: WalkContext): StorefrontImageNode | null {
  if (ctx.images >= LIMITS.maxImages) {
    report(ctx, `Removed images beyond the limit of ${LIMITS.maxImages}.`);
    return null;
  }
  const attrs = sanitizeImageAttrsInternal(own(raw, 'attrs'), ctx.origins, ctx);
  if (!attrs) return null;
  let cost = 110 + attrs.src.length + attrs.alt.length + (attrs.title?.length ?? 0);
  if (attrs.credit) {
    const credit = attrs.credit;
    cost += 140 + credit.photographer.length + credit.photographerUrl.length + credit.sourceUrl.length;
    cost += (credit.downloadLocation?.length ?? 0) + (credit.utmSource?.length ?? 0);
  }
  if (!charge(ctx, cost)) return null;
  ctx.images += 1;
  return { type: 'image', attrs };
}

// ---------------------------------------------------------------------------------------------
// Product grids
// ---------------------------------------------------------------------------------------------

function gridProductIds(value: unknown, ctx: WalkContext): string[] {
  const ids: string[] = [];
  if (value === undefined || value === null) return ids;
  if (!Array.isArray(value)) {
    report(ctx, 'Removed an invalid product list from a product grid.');
    return ids;
  }
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    if (!visit(ctx)) break;
    const entry: unknown = value[index];
    if (!isStorefrontProductId(entry)) {
      report(ctx, 'Removed invalid product ids from a product grid.');
      continue;
    }
    const id = entry.toLowerCase();
    if (seen.has(id)) {
      report(ctx, 'Removed duplicate product ids from a product grid.');
      continue;
    }
    if (ids.length >= LIMITS.maxProductsPerGrid) {
      report(ctx, `Removed products beyond the limit of ${LIMITS.maxProductsPerGrid} per product grid.`);
      break;
    }
    if (!ctx.productIds.has(id) && ctx.productIds.size >= LIMITS.maxFeaturedProducts) {
      report(ctx, `Removed products beyond the limit of ${LIMITS.maxFeaturedProducts} different products per page.`);
      continue;
    }
    seen.add(id);
    ids.push(id);
    ctx.productIds.add(id);
  }
  return ids;
}

function gridColumns(value: unknown, ctx: WalkContext): StorefrontProductGridColumns {
  const columns = readInteger(value);
  if (columns === 2 || columns === 3 || columns === 4) return columns;
  if (value !== undefined && value !== null) report(ctx, 'Reset invalid product grid columns to 3.');
  return 3;
}

function sanitizeProductGrid(raw: JsonRecord, ctx: WalkContext): StorefrontProductGridNode | null {
  if (ctx.grids >= LIMITS.maxProductGrids) {
    report(ctx, `Removed product grids beyond the limit of ${LIMITS.maxProductGrids}.`);
    return null;
  }
  const rawAttrs = own(raw, 'attrs');
  const attrs: JsonRecord = isRecord(rawAttrs) ? rawAttrs : {};
  const productIds = gridProductIds(own(attrs, 'productIds'), ctx);
  const columns = gridColumns(own(attrs, 'columns'), ctx);
  const rawTitle = own(attrs, 'title');
  if (rawTitle !== undefined && rawTitle !== null && typeof rawTitle !== 'string') {
    report(ctx, 'Removed an invalid product grid title.');
  }
  const title = cleanLine(rawTitle, LIMITS.maxGridTitleLength, ctx, 'a product grid title');
  if (!charge(ctx, 110 + productIds.length * 39 + title.length)) return null;
  ctx.grids += 1;
  return { type: 'affiliateProductGrid', attrs: { productIds, title: title === '' ? null : title, columns } };
}

// ---------------------------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------------------------

function sanitizeTopLevelBlock(raw: JsonRecord, type: unknown, ctx: WalkContext): StorefrontBlockNode | null {
  const hops = 2;
  switch (type) {
    case 'paragraph':
      return sanitizeParagraph(raw, ctx, hops);
    case 'heading':
      return sanitizeHeading(raw, ctx, hops);
    case 'bulletList':
    case 'orderedList':
      return sanitizeList(raw, type, ctx, 1, hops);
    case 'blockquote':
      return sanitizeBlockquote(raw, ctx, hops);
    case 'horizontalRule':
      return charge(ctx, 28) ? { type: 'horizontalRule' } : null;
    case 'image':
      return sanitizeImageNode(raw, ctx);
    case 'storefrontCallout':
      return sanitizeCallout(raw, ctx, hops);
    case 'affiliateProductGrid':
      return sanitizeProductGrid(raw, ctx);
    default:
      return salvageUnknownBlock(raw, type, ctx, hops);
  }
}

function walkDocBlocks(items: readonly unknown[], ctx: WalkContext): StorefrontBlockNode[] {
  const out: StorefrontBlockNode[] = [];
  const push = (block: StorefrontBlockNode): boolean => {
    if (out.length >= LIMITS.maxBlocks) {
      stop(ctx, MESSAGE_BLOCKS);
      return false;
    }
    out.push(block);
    return true;
  };
  walkBlockChildren(
    items,
    ctx,
    1,
    (run) => charge(ctx, 24) && push({ type: 'paragraph', content: run }),
    (item, type) => {
      const block = sanitizeTopLevelBlock(item, type, ctx);
      return block === null || push(block);
    },
  );
  return out;
}

/**
 * Drops trailing top-level blocks until the document fits `maxJsonBytes` as the database measures
 * it: the 02030 CHECKs are `octet_length(content::text)`, and jsonb text puts a space after every
 * `:` and `,` (up to ~10% more than compact JSON on a mark- and link-dense page).
 */
function enforceByteLimit(blocks: StorefrontBlockNode[], ctx: WalkContext): StorefrontBlockNode[] {
  if (storefrontJsonbTextByteLength({ type: 'doc', content: blocks }) <= LIMITS.maxJsonBytes) return blocks;
  const sizes = blocks.map((block) => storefrontJsonbTextByteLength(block));
  let total = DOC_JSONB_OVERHEAD + JSONB_ELEMENT_SEPARATOR_BYTES * Math.max(0, blocks.length - 1);
  for (const size of sizes) total += size;
  let count = blocks.length;
  while (count > 0 && total > LIMITS.maxJsonBytes) {
    count -= 1;
    total -= (sizes[count] ?? 0) + (count > 0 ? JSONB_ELEMENT_SEPARATOR_BYTES : 0);
  }
  report(ctx, MESSAGE_BYTES);
  return blocks.slice(0, count);
}

/** Structural JSON equality of an untrusted input and a sanitized output (bounded by the output). */
function sameJson(input: unknown, output: unknown, depth: number): boolean {
  if (input === output) return true;
  if (depth > 64 || typeof output !== 'object' || output === null) return false;
  if (Array.isArray(output)) {
    if (!Array.isArray(input) || input.length !== output.length) return false;
    for (let index = 0; index < output.length; index += 1) {
      if (!sameJson(input[index], output[index], depth + 1)) return false;
    }
    return true;
  }
  if (!isRecord(input)) return false;
  const outputRecord = output as JsonRecord;
  const keys = Object.keys(outputRecord);
  if (Object.keys(input).length !== keys.length) return false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) return false;
    if (!sameJson(input[key], outputRecord[key], depth + 1)) return false;
  }
  return true;
}

interface SanitizerRun {
  blocks: StorefrontBlockNode[];
  issues: string[];
  /** The parsed input (JSON strings are parsed), for the `changed` comparison. */
  source: unknown;
  /** The input's block list when it had one. */
  sourceBlocks: unknown;
}

function runSanitizer(input: unknown, options: StorefrontSanitizeOptions | null | undefined, expectDoc: boolean): SanitizerRun {
  const ctx = createContext(options);
  let source: unknown = input;
  if (typeof input === 'string') {
    if (storefrontUtf8ByteLength(input, LIMITS.maxInputBytes) > LIMITS.maxInputBytes) {
      report(ctx, `The document is larger than ${LIMITS.maxInputBytes} bytes and was not processed.`);
      return { blocks: [], issues: formatIssues(ctx), source: undefined, sourceBlocks: undefined };
    }
    try {
      source = JSON.parse(input) as unknown;
    } catch {
      report(ctx, 'The document is not valid JSON.');
      return { blocks: [], issues: formatIssues(ctx), source: undefined, sourceBlocks: undefined };
    }
  }
  let items: readonly unknown[] = [];
  let sourceBlocks: unknown;
  if (Array.isArray(source)) {
    if (expectDoc) report(ctx, 'Expected a document; used the list of blocks as its content.');
    items = source;
    sourceBlocks = source;
  } else if (isRecord(source) && own(source, 'type') === 'doc') {
    const content = own(source, 'content');
    sourceBlocks = content;
    if (Array.isArray(content)) items = content;
    else if (content !== undefined && content !== null) report(ctx, 'Removed invalid document content.');
  } else {
    report(ctx, 'The input is not a storefront document.');
  }
  const blocks = enforceByteLimit(walkDocBlocks(items, ctx), ctx);
  return { blocks, issues: formatIssues(ctx), source, sourceBlocks };
}

/**
 * Sanitizes untrusted storefront JSON (a JSON string, a `StorefrontDoc`, or the editor's
 * `getJSON()` output with its null attributes) into the exact `StorefrontDoc` shape.
 * `issues` lists every meaningful alteration (dropped nodes, links, images, truncations, invalid
 * values reset); `changed` is true when the returned document differs structurally from the input
 * (dropping the editor's null attributes counts as a change without an issue). An empty result is
 * one empty paragraph, because the editor schema refuses a document without blocks.
 * `options.siteOrigin` is accepted for symmetry with the renderer: links are kept whatever their
 * origin, so the result never depends on where it was sanitized.
 */
export function sanitizeStorefrontDoc(input: unknown, options: StorefrontSanitizeOptions): StorefrontSanitizeResult {
  try {
    const run = runSanitizer(input, options, true);
    const content: StorefrontBlockNode[] = run.blocks.length > 0 ? run.blocks : [{ type: 'paragraph' }];
    const doc: StorefrontDoc = { type: 'doc', content };
    return { doc, issues: run.issues, changed: !sameJson(run.source, doc, 0) };
  } catch {
    return { doc: { type: 'doc', content: [{ type: 'paragraph' }] }, issues: [MESSAGE_FAILURE], changed: true };
  }
}

/**
 * Sanitizes a list of blocks (or a document's blocks) without the one-block minimum, for callers
 * that insert blocks into an existing document (the copilot, the editor's `insertBlocks`).
 * `changed` compares against the input's block list.
 */
export function sanitizeStorefrontBlocks(
  input: unknown,
  options: StorefrontSanitizeOptions,
): StorefrontSanitizeBlocksResult {
  try {
    const run = runSanitizer(input, options, false);
    return { blocks: run.blocks, issues: run.issues, changed: !sameJson(run.sourceBlocks, run.blocks, 0) };
  } catch {
    return { blocks: [], issues: [MESSAGE_FAILURE], changed: true };
  }
}
