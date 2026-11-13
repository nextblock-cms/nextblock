'use client';

/**
 * Editor operations shared by the toolbar, the slash menu, the node views and the imperative
 * `StorefrontEditorApi`. Pure Tiptap / ProseMirror (no React), so they run in node tests.
 *
 * Block insertion never splits a paragraph and never nests a block inside a list or a quote: new
 * blocks go right after the top-level block that holds the cursor (or replace it when it is an
 * empty paragraph), and the cursor lands in the text block that follows them, so typing can go on.
 */
import type { Command, Editor, JSONContent, Range } from '@tiptap/core';
import { Fragment, Mark, type Node as ProseMirrorNode, type ResolvedPos, type Schema } from '@tiptap/pm/model';
import { NodeSelection, TextSelection, type EditorState, type Selection, type Transaction } from '@tiptap/pm/state';

import { STOREFRONT_LIMITS } from '../storefront/limits';
import { cleanStorefrontText, truncateStorefrontText } from '../storefront/text';
import { STOREFRONT_NODE_NAMES } from '../storefront/types';
import { sanitizeStorefrontHref } from '../storefront/urls';
import {
  readStorefrontGridColumns,
  readStorefrontGridProductIds,
  readStorefrontGridTitle,
  type AffiliateProductGridAttrs,
} from './extensions/product-grid';

/** Where inserted blocks go: near the selection, at the end of the document, or near a position. */
export type StorefrontInsertPosition = 'selection' | 'end' | number;

export interface StorefrontInsertBlocksOptions {
  /** Default `selection`. */
  at?: StorefrontInsertPosition;
  /**
   * Replace the empty paragraph the insertion point sits in, or with `at: 'end'` a trailing empty
   * paragraph (default true).
   */
  replaceEmptyParagraph?: boolean;
  /** Receives the range the blocks occupy after the command ran. */
  result?: { from: number; to: number };
}

const LIST_TYPES: ReadonlySet<string> = new Set(['bulletList', 'orderedList']);

/** Top-level block nodes for `blocks`, or null when one is invalid for the schema or not a doc child. */
function toTopLevelNodes(schema: Schema, blocks: readonly JSONContent[]): ProseMirrorNode[] | null {
  if (blocks.length === 0) return null;
  try {
    const nodes = blocks.map((block) => schema.nodeFromJSON(block));
    for (const node of nodes) {
      node.check();
      if (schema.topNodeType.contentMatch.matchType(node.type) === null) return null;
    }
    return nodes;
  } catch {
    return null;
  }
}

function insertionRange(
  tr: Transaction,
  at: StorefrontInsertPosition,
  replaceEmptyParagraph: boolean
): { from: number; to: number } {
  const size = tr.doc.content.size;
  if (at === 'end') {
    // A trailing empty paragraph (or the empty document's only line) is taken over by the blocks.
    const last = tr.doc.lastChild;
    if (replaceEmptyParagraph && last && last.type.name === 'paragraph' && last.content.size === 0) {
      return { from: size - last.nodeSize, to: size };
    }
    return { from: size, to: size };
  }

  let $from: ResolvedPos;
  let $to: ResolvedPos;
  let fallback: number;
  if (typeof at === 'number' && Number.isFinite(at)) {
    $from = $to = tr.doc.resolve(Math.max(0, Math.min(Math.floor(at), size)));
    fallback = $from.pos;
  } else {
    ({ $from, $to } = tr.selection);
    // A node selection (or a gap cursor) between top-level blocks: insert after it, never over it.
    fallback = tr.selection.to;
  }

  if ($from.depth === 0) return { from: fallback, to: fallback };

  const block = $from.node(1);
  if (
    replaceEmptyParagraph &&
    $from.depth === 1 &&
    block.type.name === 'paragraph' &&
    block.content.size === 0 &&
    $to.depth >= 1 &&
    $to.before(1) === $from.before(1)
  ) {
    return { from: $from.before(1), to: $from.after(1) };
  }

  const end = $to.depth >= 1 ? $to.after(1) : $to.pos;
  return { from: end, to: end };
}

/**
 * A command inserting top-level blocks (Tiptap JSON, e.g. sanitized storefront blocks). Invalid
 * blocks make it a no-op (returns false). The blocks land after the top-level block holding the
 * insertion point; when nothing editable follows them, an empty paragraph is added for the cursor.
 */
export function storefrontInsertBlocksCommand(
  blocks: readonly JSONContent[],
  options: StorefrontInsertBlocksOptions = {}
): Command {
  return ({ tr, state, dispatch }) => {
    const nodes = toTopLevelNodes(state.schema, blocks);
    if (!nodes) return false;
    if (!dispatch) return true;

    const { from, to } = insertionRange(tr, options.at ?? 'selection', options.replaceEmptyParagraph !== false);
    const fragment = Fragment.fromArray(nodes);
    tr.replaceWith(from, to, fragment);

    const end = from + fragment.size;
    const paragraph = state.schema.nodes['paragraph'];
    const after = tr.doc.resolve(Math.min(end, tr.doc.content.size)).nodeAfter;
    if (!(after && after.isTextblock) && paragraph) tr.insert(end, paragraph.create());
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(end + 1, tr.doc.content.size))));
    tr.scrollIntoView();

    if (options.result) {
      options.result.from = from;
      options.result.to = end;
    }
    return true;
  };
}

/** Runs {@link storefrontInsertBlocksCommand}; returns the inserted range, or null when nothing was inserted. */
export function insertStorefrontBlocks(
  editor: Editor,
  blocks: readonly JSONContent[],
  options: Omit<StorefrontInsertBlocksOptions, 'result'> = {}
): { from: number; to: number } | null {
  if (editor.isDestroyed) return null;
  const result = { from: -1, to: -1 };
  const ok = editor
    .chain()
    .command(storefrontInsertBlocksCommand(blocks, { ...options, result }))
    .run();
  return ok && result.from >= 0 ? result : null;
}

/** Grid attributes in their stored form. */
export function normalizeStorefrontProductGridAttrs(attrs: Partial<AffiliateProductGridAttrs> | null | undefined): AffiliateProductGridAttrs {
  return {
    productIds: readStorefrontGridProductIds(attrs?.productIds ?? []),
    title: readStorefrontGridTitle(attrs?.title ?? null),
    columns: readStorefrontGridColumns(attrs?.columns ?? 3),
  };
}

/**
 * Inserts an `affiliateProductGrid` (deleting `range` first, e.g. the `/promote` query) and
 * returns its position, or null when it could not be inserted.
 */
export function insertStorefrontProductGrid(
  editor: Editor,
  options: { range?: Range; at?: StorefrontInsertPosition; attrs?: Partial<AffiliateProductGridAttrs> } = {}
): number | null {
  if (editor.isDestroyed) return null;
  const result = { from: -1, to: -1 };
  const grid: JSONContent = { type: STOREFRONT_NODE_NAMES.productGrid, attrs: { ...normalizeStorefrontProductGridAttrs(options.attrs) } };
  let chain = editor.chain().focus();
  if (options.range) chain = chain.deleteRange(options.range);
  const ok = chain.command(storefrontInsertBlocksCommand([grid], { at: options.at ?? 'selection', result })).run();
  return ok && result.from >= 0 ? result.from : null;
}

/** The product grid node at `pos`, or null. */
export function getStorefrontProductGridAt(doc: ProseMirrorNode, pos: number): ProseMirrorNode | null {
  if (!Number.isInteger(pos) || pos < 0 || pos >= doc.content.size) return null;
  const node = doc.nodeAt(pos);
  return node && node.type.name === STOREFRONT_NODE_NAMES.productGrid ? node : null;
}

/** Updates the grid at `pos` (attributes normalized to their stored form). False when no grid is there. */
export function updateStorefrontProductGrid(
  editor: Editor,
  pos: number,
  attrs: Partial<AffiliateProductGridAttrs>
): boolean {
  if (editor.isDestroyed) return false;
  return editor
    .chain()
    .command(({ tr, dispatch }) => {
      const node = getStorefrontProductGridAt(tr.doc, pos);
      if (!node) return false;
      const current = node.attrs as Partial<AffiliateProductGridAttrs>;
      const next: Partial<AffiliateProductGridAttrs> = { ...current };
      if (attrs.productIds !== undefined) next.productIds = attrs.productIds;
      if (attrs.columns !== undefined) next.columns = attrs.columns;
      if (attrs.title !== undefined) next.title = attrs.title;
      // The title keeps what was typed (trailing spaces included) so the grid's title input never
      // jumps; the sanitizer trims it when the document is emitted.
      const normalized = normalizeStorefrontProductGridAttrs(next);
      if (dispatch) tr.setNodeMarkup(pos, undefined, { ...normalized });
      return true;
    })
    .run();
}

/** Product ids of every grid in the document except the one at `excludePos`, deduplicated. */
export function collectStorefrontEditorProductIds(doc: ProseMirrorNode, options: { excludePos?: number } = {}): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  doc.forEach((node, offset) => {
    if (node.type.name !== STOREFRONT_NODE_NAMES.productGrid || offset === options.excludePos) return;
    for (const id of readStorefrontGridProductIds(node.attrs['productIds'])) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  });
  return ids;
}

/** The selected image (node selection), or null. */
export function getSelectedStorefrontImage(state: EditorState): { pos: number; alt: string } | null {
  const { selection } = state;
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== 'image') return null;
  const alt = selection.node.attrs['alt'];
  return { pos: selection.from, alt: typeof alt === 'string' ? alt : '' };
}

/** Sets the alt text of the image at `pos` (single line, at most 250 characters). */
export function updateStorefrontImageAlt(editor: Editor, pos: number, alt: string): boolean {
  if (editor.isDestroyed) return false;
  const max = STOREFRONT_LIMITS.maxAltLength;
  const text = truncateStorefrontText(cleanStorefrontText(String(alt ?? '').slice(0, max * 4), { singleLine: true }).text.trim(), max).trimEnd();
  return editor
    .chain()
    .command(({ tr, dispatch }) => {
      const node = Number.isInteger(pos) && pos >= 0 && pos < tr.doc.content.size ? tr.doc.nodeAt(pos) : null;
      if (!node || node.type.name !== 'image') return false;
      if (dispatch) tr.setNodeMarkup(pos, undefined, { ...node.attrs, alt: text === '' ? null : text });
      return true;
    })
    .run();
}

/** The selected text (hard breaks and block boundaries as `\n`); '' for an empty selection. */
export function getStorefrontSelectedText(editor: Editor): string {
  if (editor.isDestroyed) return '';
  const { selection, doc } = editor.state;
  if (selection.empty) return '';
  return doc.textBetween(selection.from, selection.to, '\n', (leaf: ProseMirrorNode) =>
    leaf.type.name === 'hardBreak' ? '\n' : ''
  );
}

/**
 * The range `replaceStorefrontSelection()` replaces: the selected text inside ONE text block (a
 * paragraph, a heading, a list item's paragraph or a callout), or the cursor in one. An edge that
 * only touches the next block (a drag that ends at the start of the following line), or the very
 * end of the previous one, selects no character there and is dropped. Null for a selected node,
 * for text in two or more blocks, and for a range holding an image, a product grid or a divider:
 * a rewrite is one run of text, so replacing such a range would merge the blocks into the first
 * one and delete everything in between.
 */
function resolveStorefrontReplaceRange(doc: ProseMirrorNode, selection: Selection): { from: number; to: number } | null {
  if (selection instanceof NodeSelection) return null;
  const { from, to } = selection;
  const $from = doc.resolve(from);
  if ($from.sameParent(doc.resolve(to)) && $from.parent.isTextblock) return { from, to };

  const scan = { blocked: false, parts: [] as Array<{ from: number; to: number }> };
  doc.nodesBetween(from, to, (node, pos) => {
    if (scan.blocked) return false;
    if (node.isTextblock) {
      const start = Math.max(from, pos + 1);
      const end = Math.min(to, pos + 1 + node.content.size);
      if (end > start) scan.parts.push({ from: start, to: end });
      return false;
    }
    // An image, a product grid or a divider inside the range.
    if (node.isLeaf || node.isAtom) scan.blocked = true;
    return !scan.blocked;
  });
  return !scan.blocked && scan.parts.length === 1 ? (scan.parts[0] ?? null) : null;
}

/**
 * True when `replaceStorefrontSelection()` would replace the selection: text (or the cursor)
 * inside one text block. False for a selected node, text across blocks, or a range holding an
 * image, a product grid or a divider.
 */
export function canReplaceStorefrontSelection(editor: Editor): boolean {
  if (editor.isDestroyed) return false;
  return resolveStorefrontReplaceRange(editor.state.doc, editor.state.selection) !== null;
}

/**
 * Replaces the selected text with plain text inside its text block, keeping that block and the
 * formatting that spans the selection; line breaks become hard breaks. Only text inside ONE text
 * block is replaced (`canReplaceStorefrontSelection()`): for a selected node, text across blocks,
 * or a range holding an image, a product grid or a divider, nothing changes and the result is
 * false, so blocks are never merged or deleted. Never moves focus (the copilot panel keeps it;
 * call `focus()` for that).
 */
export function replaceStorefrontSelection(editor: Editor, text: string): boolean {
  if (editor.isDestroyed || resolveStorefrontReplaceRange(editor.state.doc, editor.state.selection) === null) return false;
  const cleaned = truncateStorefrontText(
    cleanStorefrontText(String(text ?? '').slice(0, STOREFRONT_LIMITS.maxTextLength * 2)).text,
    STOREFRONT_LIMITS.maxTextLength
  );

  return editor
    .chain()
    .command(({ tr, state, dispatch }) => {
      const range = resolveStorefrontReplaceRange(tr.doc, tr.selection);
      if (!range) return false;
      const $from = tr.doc.resolve(range.from);
      const $to = tr.doc.resolve(range.to);
      const hardBreak = state.schema.nodes['hardBreak'];
      const marks = range.from === range.to ? (tr.storedMarks ?? $from.marks()) : ($from.marksAcross($to) ?? Mark.none);
      const inline: ProseMirrorNode[] = [];
      cleaned.split('\n').forEach((line, index) => {
        if (index > 0 && hardBreak) inline.push(hardBreak.create());
        if (line !== '') inline.push(state.schema.text(line, marks));
      });
      if (!dispatch) return true;
      if (inline.length === 0) tr.delete(range.from, range.to);
      else tr.replaceWith(range.from, range.to, inline);
      tr.scrollIntoView();
      return true;
    })
    .run();
}

/**
 * Quote on ⇄ off. Text blocks and list items are turned into paragraphs first (a quote only holds
 * paragraphs); a selection that includes an image, a grid or a divider is left alone.
 */
export function toggleStorefrontQuote(editor: Editor, range?: Range): boolean {
  if (editor.isDestroyed) return false;
  if (editor.isActive('blockquote')) {
    const chain = editor.chain().focus();
    return (range ? chain.deleteRange(range) : chain).lift('blockquote').run();
  }
  // Decide up front: a chain dispatches the commands that succeeded even when a later one fails,
  // so `clearNodes` must not run when the wrap cannot follow.
  const { from, to } = editor.state.selection;
  let holdsBlockAtom = false;
  editor.state.doc.nodesBetween(from, to, (node) => {
    if (node.isBlock && node.isAtom) holdsBlockAtom = true;
    return !holdsBlockAtom;
  });
  if (holdsBlockAtom) return false;
  const chain = editor.chain().focus();
  return (range ? chain.deleteRange(range) : chain).clearNodes().wrapIn('blockquote').run();
}

/**
 * A link address from what a partner typed: `https:` / `http:` URLs, `mailto:` addresses, site
 * paths (`/products/x`), bare domains (`example.com` → `https://example.com/`) and bare email
 * addresses (→ `mailto:`). Null for anything `sanitizeStorefrontHref()` refuses.
 */
export function normalizeStorefrontLinkInput(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value === '' || value.length > STOREFRONT_LIMITS.maxHrefLength) return null;
  if (value.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(value)) return sanitizeStorefrontHref(value);
  if (/^[^\s@/:]+@[^\s@/:]+\.[^\s@/:]+$/.test(value)) return sanitizeStorefrontHref(`mailto:${value}`);
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d{1,5})?(?:[/?#]\S*)?$/i.test(value)) return sanitizeStorefrontHref(`https://${value}`);
  return null;
}

/**
 * Links the selection (or the link under the cursor) to `href`; with an empty selection outside a
 * link, inserts the address itself as linked text. `href` must pass `sanitizeStorefrontHref()`.
 */
export function applyStorefrontLink(editor: Editor, rawHref: string): boolean {
  const href = sanitizeStorefrontHref(rawHref);
  if (editor.isDestroyed || href === null) return false;
  if (editor.isActive('link')) return editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
  if (editor.state.selection.empty) {
    const label = href.startsWith('mailto:') ? href.slice('mailto:'.length) : href;
    return editor
      .chain()
      .focus()
      .insertContent({ type: 'text', text: label, marks: [{ type: 'link', attrs: { href } }] })
      .run();
  }
  return editor.chain().focus().setLink({ href }).run();
}

/** Removes the link under the cursor or in the selection. */
export function removeStorefrontLink(editor: Editor): boolean {
  if (editor.isDestroyed) return false;
  return editor.chain().focus().extendMarkRange('link').unsetLink().run();
}

/** How many lists enclose `$pos` (1 inside a top-level list, 2 inside a nested one). */
export function storefrontListNestingAt($pos: ResolvedPos): number {
  let lists = 0;
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if (LIST_TYPES.has($pos.node(depth).type.name)) lists += 1;
  }
  return lists;
}

/** Deepest list nesting the storefront keeps (deeper items are flattened by the sanitizer). */
export const STOREFRONT_EDITOR_MAX_LIST_NESTING = 2;
