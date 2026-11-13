// @vitest-environment jsdom
/* eslint-disable no-script-url -- javascript: URLs are among the hostile inputs */
import { Editor, type JSONContent } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import type { SuggestionProps } from '@tiptap/suggestion';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { emptyStorefrontDoc } from '../storefront/helpers';
import { sanitizeStorefrontDoc } from '../storefront/sanitize';
import { buildStorefrontStarterDoc } from '../storefront/starter';
import {
  STOREFRONT_BLOCK_NODE_TYPES,
  STOREFRONT_INLINE_NODE_TYPES,
  STOREFRONT_NESTED_NODE_TYPES,
  type StorefrontDoc,
} from '../storefront/types';
import {
  applyStorefrontLink,
  canReplaceStorefrontSelection,
  collectStorefrontEditorProductIds,
  getSelectedStorefrontImage,
  getStorefrontProductGridAt,
  getStorefrontSelectedText,
  insertStorefrontBlocks,
  insertStorefrontProductGrid,
  removeStorefrontLink,
  replaceStorefrontSelection,
  toggleStorefrontQuote,
  updateStorefrontImageAlt,
  updateStorefrontProductGrid,
} from './commands';
import { runStorefrontSlashItem, STOREFRONT_SLASH_PLUGIN_KEY } from './extensions/slash-command';
import type { StorefrontSlashItem } from './extensions/slash-items';
import { createStorefrontEditorExtensions, type StorefrontEditorKitOptions } from './kit';

const ORIGINS = ['https://images.pexels.com'];
const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const text = (value: string, marks?: JSONContent['marks']): JSONContent => (marks ? { type: 'text', text: value, marks } : { type: 'text', text: value });
const p = (value?: string): JSONContent => (value ? { type: 'paragraph', content: [text(value)] } : { type: 'paragraph' });
const grid = (ids: string[] = [], title: string | null = null, columns = 3): JSONContent => ({
  type: 'affiliateProductGrid',
  attrs: { productIds: ids, title, columns },
});
const ALLOWED_NODES = new Set<string>(['doc', ...STOREFRONT_BLOCK_NODE_TYPES, ...STOREFRONT_INLINE_NODE_TYPES, ...STOREFRONT_NESTED_NODE_TYPES]);

beforeAll(() => {
  // jsdom has no layout: ProseMirror measures ranges to scroll and to map coordinates.
  const zeroRect = () => new DOMRect(0, 0, 0, 0);
  const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = zeroRect;
  if (!Range.prototype.getClientRects) Range.prototype.getClientRects = emptyRects;
  if (!document.elementFromPoint) document.elementFromPoint = () => null;
});

const editors: Editor[] = [];

function createEditor(content: JSONContent | StorefrontDoc, options: Partial<StorefrontEditorKitOptions> & { onContentError?: () => void } = {}) {
  const { onContentError, ...kitOptions } = options;
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: createStorefrontEditorExtensions({ allowedImageOrigins: ORIGINS, ...kitOptions }),
    content: content as JSONContent,
    enableContentCheck: true,
    onContentError: onContentError ?? (() => undefined),
  });
  editors.push(editor);
  return editor;
}

function nodeTypes(node: JSONContent, out: string[] = []): string[] {
  if (node.type) out.push(node.type);
  for (const child of node.content ?? []) nodeTypes(child, out);
  return out;
}

function topTypes(editor: Editor): string[] {
  return (editor.getJSON().content ?? []).map((node) => node.type ?? '');
}

/** The document range of the first occurrence of `needle` inside one text node. */
function findText(editor: Editor, needle: string): { from: number; to: number } {
  const hits: Array<{ from: number; to: number }> = [];
  editor.state.doc.descendants((node, pos) => {
    if (hits.length > 0) return false;
    const index = node.isText ? (node.text ?? '').indexOf(needle) : -1;
    if (index >= 0) hits.push({ from: pos + index, to: pos + index + needle.length });
    return true;
  });
  const hit = hits[0];
  if (!hit) throw new Error(`no text "${needle}"`);
  return hit;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  while (editors.length > 0) editors.pop()?.destroy();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('round trips', () => {
  it('loads the starter documents and emits them back unchanged', () => {
    for (const locale of ['en', 'fr']) {
      const starter = buildStorefrontStarterDoc({ locale, displayName: 'Jane Doe' });
      const editor = createEditor(starter);
      const result = sanitizeStorefrontDoc(editor.getJSON(), { allowedImageOrigins: ORIGINS });
      expect(result.doc).toEqual(starter);
      expect(result.issues).toEqual([]);
    }
  });

  it('keeps every storefront construct, including stock photo credits', () => {
    const rich: StorefrontDoc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Sub' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'See ' },
            { type: 'text', text: 'this', marks: [{ type: 'link', attrs: { href: 'https://example.com/' } }, { type: 'bold' }] },
            { type: 'hardBreak' },
            { type: 'text', text: 'next', marks: [{ type: 'italic' }, { type: 'strike' }, { type: 'underline' }] },
          ],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
                {
                  type: 'orderedList',
                  attrs: { start: 1 },
                  content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'nested' }] }] }],
                },
              ],
            },
          ],
        },
        { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Quote' }] }] },
        { type: 'horizontalRule' },
        {
          type: 'image',
          attrs: {
            src: 'https://images.pexels.com/photos/1/a.jpeg',
            alt: 'Candle',
            title: null,
            width: 640,
            height: 480,
            credit: {
              provider: 'pexels',
              photographer: 'Jane',
              photographerUrl: 'https://www.pexels.com/@jane',
              sourceUrl: 'https://www.pexels.com/photo/1/',
              downloadLocation: null,
              utmSource: null,
            },
          },
        },
        { type: 'storefrontCallout', attrs: { tone: 'highlight' }, content: [{ type: 'text', text: 'Note' }] },
        { type: 'affiliateProductGrid', attrs: { productIds: [uuid(1), uuid(2)], title: 'Picks', columns: 4 } },
        { type: 'paragraph' },
      ],
    };
    expect(sanitizeStorefrontDoc(rich, { allowedImageOrigins: ORIGINS }).doc).toEqual(rich);

    const editor = createEditor(rich);
    const result = sanitizeStorefrontDoc(editor.getJSON(), { allowedImageOrigins: ORIGINS });
    expect(result.doc).toEqual(rich);
    expect(result.issues).toEqual([]);
  });

  it('reports a stored document that does not fit the schema (content check)', () => {
    const onContentError = vi.fn();
    createEditor({ type: 'doc', content: [{ type: 'divBlock', content: [text('x')] }] }, { onContentError });
    expect(onContentError).toHaveBeenCalledTimes(1);
  });
});

describe('pasted HTML', () => {
  it('keeps only allowlisted nodes, safe links and images from allowed hosts', () => {
    const editor = createEditor(emptyStorefrontDoc());
    const credit = JSON.stringify({
      provider: 'pexels',
      photographer: 'J',
      photographerUrl: 'https://www.pexels.com/@j',
      sourceUrl: 'https://www.pexels.com/photo/2/',
    }).replace(/"/g, '&quot;');
    editor.commands.setTextSelection(1);
    // The real paste path (ProseMirror's clipboard parser), not setContent.
    editor.view.pasteHTML(
      [
        '<h1>Big title</h1>',
        '<p style="color:red" class="x" onclick="alert(1)">Hi <a href="javascript:alert(1)">bad</a> ',
        '<a href="https://ok.example/x" class="fixed inset-0" target="_top" title="t" rel="opener">ok</a></p>',
        '<img src="https://evil.example/pixel.gif" alt="tracker">',
        `<img src="https://images.pexels.com/a.jpg" alt="Kept" width="640" height="abc" data-credit="${credit}">`,
        '<img src="data:image/png;base64,AAAA">',
        '<blockquote><h2>Quoted heading</h2></blockquote>',
        '<ul><li><p>item</p><img src="https://images.pexels.com/b.jpg"></li></ul>',
        '<pre><code>code()</code></pre><script>alert(1)</script><iframe src="https://evil.example"></iframe>',
        `<div data-affiliate-product-grid data-product-ids="${uuid(3)},bad,${uuid(3)}" data-columns="9" data-title="Grid"></div>`,
        '<aside data-storefront-callout data-tone="tip">Tip text</aside>',
        '<aside data-storefront-callout data-tone="evil">Other</aside>',
      ].join(''),
      new Event('paste') as ClipboardEvent
    );

    const json = editor.getJSON() as JSONContent;
    for (const type of nodeTypes(json)) expect(ALLOWED_NODES.has(type), type).toBe(true);
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain('evil.example');
    expect(serialized).not.toContain('javascript:');
    expect(serialized).not.toContain('data:image');
    expect(serialized).not.toContain('alert(1)');
    expect(serialized).not.toContain('fixed inset-0');
    expect(serialized).not.toContain('_top');
    expect(serialized).toContain('code()');

    expect(editor.getHTML()).not.toMatch(/<h1|style=|onclick|<script|<iframe/i);

    const blocks = json.content ?? [];
    expect(blocks[0]).toMatchObject({ type: 'paragraph', content: [{ type: 'text', text: 'Big title' }] });

    const okLink = (blocks[1]?.content ?? []).find((node) => node.text === 'ok')?.marks?.[0];
    expect(okLink).toEqual({
      type: 'link',
      attrs: { href: 'https://ok.example/x', target: null, rel: 'nofollow ugc noopener noreferrer', class: null, title: null },
    });
    const badText = (blocks[1]?.content ?? []).find((node) => node.text?.includes('bad'));
    expect(badText?.marks ?? []).toEqual([]);

    const images = blocks.filter((node) => node.type === 'image');
    expect(images.length).toBeGreaterThanOrEqual(1);
    for (const image of images) expect(String(image.attrs?.['src'])).toMatch(/^https:\/\/images\.pexels\.com\//);
    expect(images[0]?.attrs).toMatchObject({ src: 'https://images.pexels.com/a.jpg', alt: 'Kept', width: 640, height: null });
    expect(images[0]?.attrs?.['credit']).toMatchObject({ provider: 'pexels', photographer: 'J' });

    const quote = blocks.find((node) => node.type === 'blockquote');
    expect((quote?.content ?? []).map((node) => node.type)).toEqual(['paragraph']);

    const list = blocks.find((node) => node.type === 'bulletList');
    expect(JSON.stringify(list)).not.toContain('"image"');

    expect(blocks.find((node) => node.type === 'affiliateProductGrid')?.attrs).toEqual({
      productIds: [uuid(3)],
      title: 'Grid',
      columns: 3,
    });
    const callouts = blocks.filter((node) => node.type === 'storefrontCallout');
    expect(callouts.map((node) => node.attrs?.['tone'])).toEqual(['tip', 'info']);
  });
});

describe('block insertion', () => {
  it('replaces the empty paragraph holding the cursor and leaves the cursor in the next text block', () => {
    const editor = createEditor({ type: 'doc', content: [p('First'), p(), p('Last')] });
    editor.commands.setTextSelection(8);
    const range = insertStorefrontBlocks(editor, [grid([uuid(1)])]);
    expect(range).toEqual({ from: 7, to: 8 });
    expect(topTypes(editor)).toEqual(['paragraph', 'affiliateProductGrid', 'paragraph']);
    expect(editor.state.selection.$from.parent.textContent).toBe('Last');
  });

  it('never splits a paragraph: blocks go after the block holding the cursor', () => {
    const editor = createEditor({ type: 'doc', content: [p('Hello world'), p('Last')] });
    editor.commands.setTextSelection(4);
    insertStorefrontBlocks(editor, [{ type: 'heading', attrs: { level: 2 }, content: [text('New')] }, p('Body')]);
    const json = editor.getJSON() as JSONContent;
    expect((json.content ?? []).map((node) => node.type)).toEqual(['paragraph', 'heading', 'paragraph', 'paragraph']);
    expect(json.content?.[0]?.content?.[0]?.text).toBe('Hello world');
  });

  it('appends at the end and adds a paragraph after a trailing atom', () => {
    const editor = createEditor({ type: 'doc', content: [p('Only')] });
    const range = insertStorefrontBlocks(editor, [grid()], { at: 'end' });
    expect(range?.from).toBe(6);
    expect(topTypes(editor)).toEqual(['paragraph', 'affiliateProductGrid', 'paragraph']);
    expect(editor.state.selection).toBeInstanceOf(TextSelection);
    expect(editor.state.selection.$from.parent.type.name).toBe('paragraph');
    expect(editor.state.selection.$from.parent.content.size).toBe(0);
  });

  it('inserts after a selected block instead of replacing it', () => {
    const editor = createEditor({ type: 'doc', content: [p('Intro'), grid([uuid(1)]), p('End')] });
    editor.commands.setNodeSelection(7);
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    insertStorefrontBlocks(editor, [p('Added')]);
    const json = editor.getJSON() as JSONContent;
    expect((json.content ?? []).map((node) => node.type)).toEqual(['paragraph', 'affiliateProductGrid', 'paragraph', 'paragraph']);
    expect(json.content?.[2]?.content?.[0]?.text).toBe('Added');
    expect(json.content?.[1]?.attrs?.['productIds']).toEqual([uuid(1)]);
  });

  it('places blocks after the whole list, never inside it', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [p('item')] }] }, p('After')],
    });
    editor.commands.setTextSelection(4);
    insertStorefrontBlocks(editor, [{ type: 'horizontalRule' }]);
    expect(topTypes(editor)).toEqual(['bulletList', 'horizontalRule', 'paragraph']);
  });

  it('refuses blocks the schema does not hold', () => {
    const editor = createEditor({ type: 'doc', content: [p('Keep')] });
    const before = editor.getJSON();
    expect(insertStorefrontBlocks(editor, [{ type: 'script', content: [text('x')] }])).toBeNull();
    expect(insertStorefrontBlocks(editor, [{ type: 'listItem', content: [p('x')] }])).toBeNull();
    expect(insertStorefrontBlocks(editor, [{ type: 'storefrontCallout', attrs: { tone: 'evil' } }])).toBeNull();
    expect(editor.getJSON()).toEqual(before);
  });
});

describe('product grids', () => {
  it('inserts, updates and lists grids', () => {
    const editor = createEditor({ type: 'doc', content: [p()] });
    editor.commands.setTextSelection(1);
    const pos = insertStorefrontProductGrid(editor, { attrs: { title: 'Mine' } });
    expect(pos).toBe(0);
    expect(getStorefrontProductGridAt(editor.state.doc, pos ?? -1)?.attrs).toEqual({ productIds: [], title: 'Mine', columns: 3 });

    expect(updateStorefrontProductGrid(editor, 0, { productIds: [uuid(2), uuid(1), uuid(2), 'bad'], columns: 2 })).toBe(true);
    expect(getStorefrontProductGridAt(editor.state.doc, 0)?.attrs).toEqual({ productIds: [uuid(2), uuid(1)], title: 'Mine', columns: 2 });
    expect(updateStorefrontProductGrid(editor, 0, { title: '   ' })).toBe(true);
    expect(getStorefrontProductGridAt(editor.state.doc, 0)?.attrs['title']).toBeNull();

    // At the end, the trailing empty paragraph is taken over (and a new one follows the grid).
    insertStorefrontBlocks(editor, [grid([uuid(3), uuid(1)])], { at: 'end' });
    expect(topTypes(editor)).toEqual(['affiliateProductGrid', 'affiliateProductGrid', 'paragraph']);
    expect(collectStorefrontEditorProductIds(editor.state.doc)).toEqual([uuid(2), uuid(1), uuid(3)]);
    expect(collectStorefrontEditorProductIds(editor.state.doc, { excludePos: 0 })).toEqual([uuid(3), uuid(1)]);
    expect(updateStorefrontProductGrid(editor, 2, { columns: 4 })).toBe(false);
  });
});

describe('text helpers', () => {
  it('reads the selection as text and replaces it, keeping its formatting', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [text('Hello '), text('world', [{ type: 'bold' }])] }, p('Second')],
    });
    editor.commands.setTextSelection({ from: 7, to: 12 });
    expect(getStorefrontSelectedText(editor)).toBe('world');
    expect(replaceStorefrontSelection(editor, 'there\nfriend\u0007')).toBe(true);
    expect(editor.getJSON().content?.[0]).toEqual({
      type: 'paragraph',
      content: [
        text('Hello '),
        text('there', [{ type: 'bold' }]),
        { type: 'hardBreak' },
        text('friend', [{ type: 'bold' }]),
      ],
    });

    editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 });
    expect(getStorefrontSelectedText(editor)).toBe('Hello there\nfriend\nSecond');
    editor.commands.setTextSelection(3);
    expect(getStorefrontSelectedText(editor)).toBe('');
  });

  it('never replaces a selected block', () => {
    const editor = createEditor({ type: 'doc', content: [grid([uuid(1)]), p('x')] });
    editor.commands.setNodeSelection(0);
    expect(canReplaceStorefrontSelection(editor)).toBe(false);
    expect(replaceStorefrontSelection(editor, 'text')).toBe(false);
    expect(topTypes(editor)).toEqual(['affiliateProductGrid', 'paragraph']);
  });

  it('refuses text across blocks instead of merging them into the first one', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{ type: 'heading', attrs: { level: 2 }, content: [text('My go-to teas')] }, p('I reach for these.'), p('They help me unwind.')],
    });
    const before = editor.getJSON();
    editor.commands.setTextSelection({ from: findText(editor, 'My go-to').from, to: findText(editor, 'unwind.').to });

    expect(getStorefrontSelectedText(editor)).toBe('My go-to teas\nI reach for these.\nThey help me unwind.');
    expect(canReplaceStorefrontSelection(editor)).toBe(false);
    expect(replaceStorefrontSelection(editor, 'My go-to teas I reach for these every evening.')).toBe(false);
    expect(editor.getJSON()).toEqual(before);
  });

  it.each([
    ['a product grid', grid([uuid(1)])],
    ['an image', { type: 'image', attrs: { src: 'https://images.pexels.com/a.jpg', alt: 'Tea' } }],
    ['a divider', { type: 'horizontalRule' }],
  ])('never deletes %s inside the selection', (_label, middle) => {
    const editor = createEditor({ type: 'doc', content: [p('These are my picks.'), middle, p('Enjoy them.')] });
    const before = editor.getJSON();

    // The whole range, then a drag that stops at the very start of the last paragraph.
    for (const to of [findText(editor, 'Enjoy them.').to, findText(editor, 'Enjoy').from]) {
      editor.commands.setTextSelection({ from: findText(editor, 'These').from, to });
      expect(canReplaceStorefrontSelection(editor)).toBe(false);
      expect(replaceStorefrontSelection(editor, 'Here are the picks I love. I hope you enjoy them.')).toBe(false);
      expect(editor.getJSON()).toEqual(before);
    }
    expect(topTypes(editor)).toEqual(['paragraph', middle.type, 'paragraph']);
  });

  it('refuses a selection across list items and replaces inside one item', () => {
    const items = ['First', 'Second', 'Third'].map((value) => ({ type: 'listItem', content: [p(value)] }));
    const editor = createEditor({ type: 'doc', content: [{ type: 'bulletList', content: items }] });
    const before = editor.getJSON();

    editor.commands.setTextSelection({ from: findText(editor, 'First').from, to: findText(editor, 'Third').to });
    expect(replaceStorefrontSelection(editor, 'First Second Third')).toBe(false);
    expect(editor.getJSON()).toEqual(before);

    editor.commands.setTextSelection(findText(editor, 'Second'));
    expect(canReplaceStorefrontSelection(editor)).toBe(true);
    expect(replaceStorefrontSelection(editor, 'Middle')).toBe(true);
    expect(editor.getJSON()).toEqual({
      type: 'doc',
      content: [{ type: 'bulletList', content: ['First', 'Middle', 'Third'].map((value) => ({ type: 'listItem', content: [p(value)] })) }],
    });
  });

  it('drops a selection edge that only touches the next or the previous block', () => {
    const editor = createEditor({ type: 'doc', content: [p('Hello world'), p('Second')] });

    // A drag from "world" to the very start of the next line selects no character there.
    editor.commands.setTextSelection({ from: findText(editor, 'world').from, to: findText(editor, 'Second').from });
    expect(canReplaceStorefrontSelection(editor)).toBe(true);
    expect(replaceStorefrontSelection(editor, 'there')).toBe(true);
    expect(editor.getJSON()).toEqual({ type: 'doc', content: [p('Hello there'), p('Second')] });

    // And from the very end of the first paragraph into the second one.
    editor.commands.setTextSelection({ from: findText(editor, 'there').to, to: findText(editor, 'Second').to });
    expect(replaceStorefrontSelection(editor, 'Next')).toBe(true);
    expect(editor.getJSON()).toEqual({ type: 'doc', content: [p('Hello there'), p('Next')] });

    // Select all over a single paragraph replaces its text.
    const single = createEditor({ type: 'doc', content: [p('Only one')] });
    single.commands.selectAll();
    expect(replaceStorefrontSelection(single, 'Just one')).toBe(true);
    expect(single.getJSON()).toEqual({ type: 'doc', content: [p('Just one')] });
  });

  it('links text only to allowed addresses', () => {
    const editor = createEditor({ type: 'doc', content: [p('Read more')] });
    editor.commands.setTextSelection({ from: 1, to: 5 });
    expect(applyStorefrontLink(editor, 'javascript:alert(1)')).toBe(false);
    expect(editor.isActive('link')).toBe(false);
    expect(applyStorefrontLink(editor, 'https://example.com/guide')).toBe(true);
    expect(editor.getAttributes('link')['href']).toBe('https://example.com/guide');

    editor.commands.setTextSelection(3);
    expect(removeStorefrontLink(editor)).toBe(true);
    expect(JSON.stringify(editor.getJSON())).not.toContain('"link"');

    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    expect(applyStorefrontLink(editor, 'mailto:jane@example.com')).toBe(true);
    expect(editor.getText()).toContain('jane@example.com');
    expect(JSON.stringify(editor.getJSON())).toContain('mailto:jane@example.com');
  });

  it('wraps a heading in a quote as a paragraph and unwraps it again', () => {
    const editor = createEditor({ type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [text('Said')] }] });
    editor.commands.setTextSelection(2);
    expect(toggleStorefrontQuote(editor)).toBe(true);
    expect(editor.getJSON().content?.[0]).toEqual({ type: 'blockquote', content: [p('Said')] });
    expect(toggleStorefrontQuote(editor)).toBe(true);
    expect(editor.getJSON().content?.[0]).toEqual(p('Said'));

    const withImage = createEditor({
      type: 'doc',
      content: [{ type: 'heading', attrs: { level: 2 }, content: [text('T')] }, { type: 'image', attrs: { src: 'https://images.pexels.com/a.jpg' } }],
    });
    withImage.commands.setTextSelection({ from: 1, to: withImage.state.doc.content.size });
    expect(toggleStorefrontQuote(withImage)).toBe(false);
    expect(topTypes(withImage)).toEqual(['heading', 'image']);
  });

  it('edits the description of the selected image', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{ type: 'image', attrs: { src: 'https://images.pexels.com/a.jpg', alt: '' } }, p()],
    });
    editor.commands.setNodeSelection(0);
    expect(getSelectedStorefrontImage(editor.state)).toEqual({ pos: 0, alt: '' });
    expect(updateStorefrontImageAlt(editor, 0, '  Soy\ncandle  ')).toBe(true);
    expect(editor.state.doc.nodeAt(0)?.attrs['alt']).toBe('Soy candle');
    expect(updateStorefrontImageAlt(editor, 3, 'x')).toBe(false);
  });
});

describe('callouts and lists', () => {
  it('toggles a callout, changes its tone, and leaves it with Backspace at its start', () => {
    const editor = createEditor({ type: 'doc', content: [p('Note this')] });
    editor.commands.setTextSelection(1);
    expect(editor.commands.toggleStorefrontCallout()).toBe(true);
    expect(editor.getJSON().content?.[0]).toEqual({ type: 'storefrontCallout', attrs: { tone: 'info' }, content: [text('Note this')] });
    expect(editor.commands.setStorefrontCalloutTone('tip')).toBe(true);
    expect(editor.getJSON().content?.[0]?.attrs).toEqual({ tone: 'tip' });
    expect(editor.commands.setStorefrontCalloutTone('evil' as never)).toBe(false);

    // A callout of any tone toggles off (not re-toned).
    expect(editor.commands.toggleStorefrontCallout({ tone: 'info' })).toBe(true);
    expect(editor.getJSON().content?.[0]).toEqual(p('Note this'));
    expect(editor.commands.toggleStorefrontCallout({ tone: 'highlight' })).toBe(true);
    expect(editor.getJSON().content?.[0]?.attrs).toEqual({ tone: 'highlight' });

    editor.commands.setTextSelection(1);
    editor.commands.keyboardShortcut('Backspace');
    expect(editor.getJSON().content?.[0]).toEqual(p('Note this'));
  });

  it('turns a callout back into a paragraph instead of merging it into the block above', () => {
    const editor = createEditor({
      type: 'doc',
      content: [p('Above'), { type: 'storefrontCallout', attrs: { tone: 'tip' }, content: [text('Tip')] }, { type: 'storefrontCallout', attrs: { tone: 'info' } }],
    });
    editor.commands.setTextSelection(8);
    editor.commands.keyboardShortcut('Backspace');
    expect(editor.getJSON().content?.slice(0, 2)).toEqual([p('Above'), p('Tip')]);

    // Enter in an empty callout leaves it.
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.commands.keyboardShortcut('Enter');
    expect(topTypes(editor)).toEqual(['paragraph', 'paragraph', 'paragraph']);
  });

  it('does not indent list items past the second level', () => {
    const nested: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                p('one'),
                { type: 'bulletList', content: [{ type: 'listItem', content: [p('two')] }, { type: 'listItem', content: [p('three')] }] },
              ],
            },
          ],
        },
      ],
    };
    const editor = createEditor(nested);
    const before = editor.getJSON();
    let threePos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'three') threePos = pos;
    });
    editor.commands.setTextSelection(threePos + 1);
    expect(editor.commands.keyboardShortcut('Tab')).toBe(true);
    expect(editor.getJSON()).toEqual(before);
  });
});

describe('slash command', () => {
  function slashEditor(content: JSONContent, options: Partial<StorefrontEditorKitOptions> = {}) {
    const seen: { props: SuggestionProps<StorefrontSlashItem, StorefrontSlashItem> | null; exited: boolean } = { props: null, exited: false };
    const editor = createEditor(content, {
      slashMenuRender: () => ({
        onStart: (props) => {
          seen.props = props;
        },
        onUpdate: (props) => {
          seen.props = props;
        },
        onExit: () => {
          seen.exited = true;
        },
      }),
      ...options,
    });
    return { editor, seen };
  }

  it('offers /promote, inserts a product grid in place of the query and asks for its picker', async () => {
    const onProductGridInserted = vi.fn();
    const { editor, seen } = slashEditor({ type: 'doc', content: [p()] }, { onProductGridInserted });
    editor.commands.setTextSelection(1);
    editor.commands.insertContent('/promote');
    await flush();

    expect(STOREFRONT_SLASH_PLUGIN_KEY.getState(editor.state)?.active).toBe(true);
    expect(seen.props?.query).toBe('promote');
    const [first] = seen.props?.items ?? [];
    expect(first?.id).toBe('products');

    seen.props?.command(first as StorefrontSlashItem);
    await flush();
    expect(topTypes(editor)).toEqual(['affiliateProductGrid', 'paragraph']);
    expect(editor.getText()).not.toContain('/promote');
    expect(onProductGridInserted).toHaveBeenCalledWith(editor, 0);
    expect(seen.exited).toBe(true);
  });

  it('stays closed in headings and offers Image only with uploads', async () => {
    const { editor, seen } = slashEditor({ type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [text('Title')] }] });
    editor.commands.setTextSelection(6);
    editor.commands.insertContent(' /pro');
    await flush();
    expect(seen.props).toBeNull();

    const onImageRequest = vi.fn();
    const upload = slashEditor({ type: 'doc', content: [p()] }, { isImageUploadEnabled: () => true, onImageRequest });
    upload.editor.commands.setTextSelection(1);
    upload.editor.commands.insertContent('/photo');
    await flush();
    expect(upload.seen.props?.items.map((item) => item.id)).toEqual(['image']);
    upload.seen.props?.command(upload.seen.props.items[0] as StorefrontSlashItem);
    expect(onImageRequest).toHaveBeenCalledTimes(1);
    expect(upload.editor.getText()).toBe('');
  });

  it('runs the block items', () => {
    const editor = createEditor({ type: 'doc', content: [p('/x')] });
    const range = { from: 1, to: 3 };
    expect(runStorefrontSlashItem(editor, range, 'heading3')).toBe(true);
    expect(editor.getJSON().content?.[0]).toEqual({ type: 'heading', attrs: { level: 3 } });

    editor.commands.setContent({ type: 'doc', content: [p('/x')] });
    expect(runStorefrontSlashItem(editor, range, 'divider')).toBe(true);
    expect(topTypes(editor)).toEqual(['horizontalRule', 'paragraph']);

    editor.commands.setContent({ type: 'doc', content: [p('/x')] });
    expect(runStorefrontSlashItem(editor, range, 'callout')).toBe(true);
    expect(editor.getJSON().content?.[0]).toEqual({ type: 'storefrontCallout', attrs: { tone: 'info' } });

    editor.commands.setContent({ type: 'doc', content: [p('/x')] });
    expect(runStorefrontSlashItem(editor, range, 'bulletList')).toBe(true);
    expect(topTypes(editor)).toEqual(['bulletList']);

    editor.setEditable(false, false);
    expect(runStorefrontSlashItem(editor, range, 'quote')).toBe(false);
  });
});
