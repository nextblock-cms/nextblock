/* eslint-disable no-script-url -- a javascript: image src is one of the hostile inputs */
import { Node as TiptapNode, getSchema } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it } from 'vitest';
import { emptyStorefrontDoc } from './helpers';
import { sanitizeStorefrontDoc } from './sanitize';
import { buildStorefrontStarterDoc } from './starter';

/**
 * The storefront editor loads documents with `enableContentCheck: true`, which runs ProseMirror's
 * `node.check()`; a document that fails it raises a content error and the editor refuses to emit
 * changes. This suite proves every sanitized document passes `check()` under a schema equivalent
 * to the editor kit (StarterKit with headings 2/3, no code, Image, the two storefront nodes).
 */
const StorefrontCalloutNode = TiptapNode.create({
  name: 'storefrontCallout',
  group: 'block',
  content: 'inline*',
  addAttributes: () => ({ tone: { default: 'info' } }),
});

const AffiliateProductGridNode = TiptapNode.create({
  name: 'affiliateProductGrid',
  group: 'block',
  atom: true,
  addAttributes: () => ({ productIds: { default: [] }, title: { default: null }, columns: { default: 3 } }),
});

const CreditedImage = Image.extend({
  addAttributes() {
    return { ...this.parent?.(), credit: { default: null } };
  },
}).configure({ inline: false, allowBase64: false });

const schema = getSchema([
  StarterKit.configure({ heading: { levels: [2, 3] }, codeBlock: false, code: false }),
  CreditedImage,
  StorefrontCalloutNode,
  AffiliateProductGridNode,
]);

const OPTIONS = { allowedImageOrigins: ['https://images.pexels.com'] };
const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const text = (value: string): unknown => ({ type: 'text', text: value });

const HOSTILE_INPUTS: unknown[] = [
  { type: 'doc', content: [] },
  null,
  { type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [text('inner')] }] }] }] }] }] },
  { type: 'doc', content: [{ type: 'blockquote', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [text('x')] }] }] }] }] },
  { type: 'doc', content: [{ type: 'blockquote', content: [] }, { type: 'bulletList', content: [] }, { type: 'orderedList', content: [{ type: 'listItem', content: [] }] }] },
  { type: 'doc', content: [text('loose'), { type: 'hardBreak' }, { type: 'storefrontCallout', content: [{ type: 'paragraph', content: [text('a')] }, { type: 'paragraph', content: [text('b')] }] }] },
  { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '' }, { type: 'text', text: 'ok', marks: [{ type: 'bold' }, { type: 'bold' }, { type: 'link', attrs: { href: 'https://example.com/' } }, { type: 'link', attrs: { href: 'https://other.example/' } }] }] }] },
  { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [text('h1')] }, { type: 'heading', attrs: { level: 6 }, content: [text('h6')] }] },
  { type: 'doc', content: [{ type: 'image', attrs: { src: 'https://images.pexels.com/a.png', width: '640', credit: { provider: 'pexels', photographer: 'Jane', photographerUrl: 'https://www.pexels.com/@jane', sourceUrl: 'https://www.pexels.com/photo/1/' } } }] },
  { type: 'doc', content: [{ type: 'affiliateProductGrid', attrs: { productIds: [uuid(1), 'bad', uuid(1)], title: 'T', columns: 9 } }] },
  { type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'paragraph', content: [text('stray')] }, { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [text('nested stray')] }] }] }] }] },
  { type: 'doc', content: [{ type: 'divBlock', content: [text('div')] }, { type: 'table', content: [] }, { type: 'image', attrs: { src: 'javascript:alert(1)' } }] },
];

function expectLoadable(doc: unknown): void {
  expect(() => schema.nodeFromJSON(doc).check()).not.toThrow();
}

describe('sanitized documents load in the editor schema', () => {
  it('passes check() for the empty document and the starter documents', () => {
    expectLoadable(emptyStorefrontDoc());
    for (const locale of ['en', 'fr']) {
      expectLoadable(sanitizeStorefrontDoc(buildStorefrontStarterDoc({ locale, displayName: 'Jane' }), OPTIONS).doc);
    }
  });

  it.each(HOSTILE_INPUTS.map((input, index) => [index, input]))('passes check() for hostile input #%i', (_index, input) => {
    expectLoadable(sanitizeStorefrontDoc(input, OPTIONS).doc);
  });

  it('round-trips the starter documents through the editor schema unchanged', () => {
    for (const locale of ['en', 'fr']) {
      const starter = buildStorefrontStarterDoc({ locale, displayName: 'Jane Doe' });
      const roundTripped = schema.nodeFromJSON(starter).toJSON();
      const result = sanitizeStorefrontDoc(roundTripped, OPTIONS);
      expect(result.doc).toEqual(starter);
      expect(result.issues).toEqual([]);
    }
  });

  it('keeps mark order stable through the editor schema (canonical order = schema rank)', () => {
    const input = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'underline' }, { type: 'strike' }, { type: 'italic' }, { type: 'bold' }, { type: 'link', attrs: { href: 'https://example.com/' } }] }] }],
    };
    const sanitized = sanitizeStorefrontDoc(input, OPTIONS).doc;
    const roundTripped = sanitizeStorefrontDoc(schema.nodeFromJSON(sanitized).toJSON(), OPTIONS).doc;
    expect(roundTripped).toEqual(sanitized);
  });
});
