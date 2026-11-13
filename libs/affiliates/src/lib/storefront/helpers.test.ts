import { describe, expect, it } from 'vitest';
import {
  collectStorefrontProductIds,
  countStorefrontWords,
  emptyStorefrontDoc,
  isStorefrontDocEmpty,
  storefrontDocToPlainText,
  storefrontExcerpt,
} from './helpers';
import type { StorefrontDoc } from './types';

const ch = (...codes: number[]): string => String.fromCodePoint(...codes);
const ZWSP = ch(0x200b);
const NBSP = ch(0xa0);
const LF = ch(0x0a);

const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const DOC: StorefrontDoc = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'My picks' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'world', marks: [{ type: 'bold' }] },
        { type: 'hardBreak' },
        { type: 'text', text: 'second line.' },
      ],
    },
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
        {
          type: 'listItem',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'two' }] },
            { type: 'orderedList', attrs: { start: 1 }, content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'nested' }] }] }] },
          ],
        },
      ],
    },
    { type: 'image', attrs: { src: '/images/a.png', alt: 'ignored alt', title: null, width: null, height: null, credit: null } },
    { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quoted' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'twice' }] }] },
    { type: 'horizontalRule' },
    { type: 'storefrontCallout', attrs: { tone: 'tip' }, content: [{ type: 'text', text: 'A tip' }] },
    { type: 'affiliateProductGrid', attrs: { productIds: [uuid(1), uuid(2)], title: 'Ignored grid title', columns: 3 } },
    { type: 'affiliateProductGrid', attrs: { productIds: [uuid(2), uuid(3)], title: null, columns: 2 } },
    { type: 'paragraph' },
  ],
};

describe('emptyStorefrontDoc', () => {
  it('returns a fresh one-paragraph document every call', () => {
    const first = emptyStorefrontDoc();
    expect(first).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
    first.content.push({ type: 'horizontalRule' });
    expect(emptyStorefrontDoc().content).toHaveLength(1);
  });
});

describe('isStorefrontDocEmpty', () => {
  it.each([
    ['the empty document', emptyStorefrontDoc()],
    ['a document without blocks', { type: 'doc', content: [] }],
    ['whitespace and zero-width text', { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `  ${NBSP}${ZWSP}${LF}` }] }] }],
    ['rules and empty paragraphs', { type: 'doc', content: [{ type: 'horizontalRule' }, { type: 'paragraph' }, { type: 'heading', attrs: { level: 2 } }] }],
    ['an empty product grid', { type: 'doc', content: [{ type: 'affiliateProductGrid', attrs: { productIds: [], title: 'My favorite products', columns: 3 } }] }],
    ['a grid with invalid ids only', { type: 'doc', content: [{ type: 'affiliateProductGrid', attrs: { productIds: ['nope'], title: null, columns: 3 } }] }],
    ['null', null],
    ['undefined', undefined],
    ['a malformed value', { type: 'doc', content: 'x' }],
  ])('is true for %s', (_label, doc) => {
    expect(isStorefrontDocEmpty(doc as StorefrontDoc)).toBe(true);
  });

  it.each([
    ['visible text', { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }] }],
    ['nested list text', { type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] }] }] }],
    ['an image', { type: 'doc', content: [{ type: 'image', attrs: { src: '/images/a.png', alt: '', title: null, width: null, height: null, credit: null } }] }],
    ['a grid with a product', { type: 'doc', content: [{ type: 'affiliateProductGrid', attrs: { productIds: [uuid(1)], title: null, columns: 3 } }] }],
  ])('is false for %s', (_label, doc) => {
    expect(isStorefrontDocEmpty(doc as StorefrontDoc)).toBe(false);
  });
});

describe('collectStorefrontProductIds', () => {
  it('returns top-level grid ids deduplicated in document order', () => {
    expect(collectStorefrontProductIds(DOC)).toEqual([uuid(1), uuid(2), uuid(3)]);
  });

  it('lowercases, skips non-uuids, ignores nested grids and caps at 24', () => {
    const ids = Array.from({ length: 30 }, (_, index) => uuid(0xa00 + index));
    const doc = {
      type: 'doc',
      content: [
        { type: 'affiliateProductGrid', attrs: { productIds: [uuid(0xabc).toUpperCase(), 'bad', 7, `${uuid(1)};drop table`], title: null, columns: 3 } },
        { type: 'bulletList', content: [{ type: 'affiliateProductGrid', attrs: { productIds: [uuid(9)] } }] },
        { type: 'affiliateProductGrid', attrs: { productIds: ids.slice(0, 12), title: null, columns: 3 } },
        { type: 'affiliateProductGrid', attrs: { productIds: ids.slice(12, 24), title: null, columns: 3 } },
        { type: 'affiliateProductGrid', attrs: { productIds: ids.slice(24), title: null, columns: 3 } },
      ],
    } as unknown as StorefrontDoc;
    const collected = collectStorefrontProductIds(doc);
    expect(collected[0]).toBe(uuid(0xabc));
    expect(collected).toHaveLength(24);
    expect(collected).not.toContain(uuid(9));
    expect(collected.every((id) => /^[0-9a-f-]{36}$/.test(id))).toBe(true);
  });

  it('returns nothing for malformed input', () => {
    expect(collectStorefrontProductIds(null)).toEqual([]);
    expect(collectStorefrontProductIds({ type: 'doc', content: [{ type: 'affiliateProductGrid', attrs: { productIds: 'x' } }] } as unknown as StorefrontDoc)).toEqual([]);
  });
});

describe('storefrontDocToPlainText', () => {
  it('joins blocks with blank lines and lines with line breaks, skipping images and grids', () => {
    expect(storefrontDocToPlainText(DOC)).toBe(
      ['My picks', `Hello world${LF}second line.`, `one${LF}two${LF}nested`, `quoted${LF}twice`, 'A tip'].join(`${LF}${LF}`),
    );
  });

  it('is empty for an empty or malformed document', () => {
    expect(storefrontDocToPlainText(emptyStorefrontDoc())).toBe('');
    expect(storefrontDocToPlainText(null)).toBe('');
    expect(storefrontDocToPlainText({ type: 'doc', content: [42, null, { type: 'script', content: [{ type: 'text', text: 'x' }] }] } as unknown as StorefrontDoc)).toBe('');
  });
});

describe('storefrontExcerpt', () => {
  const docOf = (value: string): StorefrontDoc => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: value }] }] });

  it('returns short text unchanged, with whitespace collapsed', () => {
    expect(storefrontExcerpt(DOC, 500)).toBe('My picks Hello world second line. one two nested quoted twice A tip');
    expect(storefrontExcerpt(docOf('exactly ten'), 11)).toBe('exactly ten');
  });

  it('cuts at a word boundary and appends an ellipsis', () => {
    const excerpt = storefrontExcerpt(docOf('The quick brown fox jumps over the lazy dog'), 20);
    expect(excerpt).toBe('The quick brown fox…');
    expect(excerpt.length).toBeLessThanOrEqual(20);
  });

  it('keeps a word that ends exactly at the cut and drops trailing punctuation', () => {
    expect(storefrontExcerpt(docOf('Hello world, again and again'), 13)).toBe('Hello world…');
    expect(storefrontExcerpt(docOf('Hello, world'), 7)).toBe('Hello…');
  });

  it('hard-cuts a single long word', () => {
    expect(storefrontExcerpt(docOf('a'.repeat(50)), 10)).toBe(`${'a'.repeat(9)}…`);
  });

  it('handles tiny and invalid lengths', () => {
    expect(storefrontExcerpt(docOf('Hello world'), 0)).toBe('');
    expect(storefrontExcerpt(docOf('Hello world'), -5)).toBe('');
    expect(storefrontExcerpt(docOf('Hello world'), Number.NaN)).toBe('');
    expect(storefrontExcerpt(docOf('Hello world'), 1)).toBe('…');
  });

  it('never ends on half of a surrogate pair', () => {
    const emoji = ch(0x1f600);
    const excerpt = storefrontExcerpt(docOf(`${'a'.repeat(8)}${emoji}${emoji} tail`), 10);
    expect(excerpt).toBe(`${'a'.repeat(8)}…`);
  });
});

describe('countStorefrontWords', () => {
  it('counts tokens holding a letter or digit, in any script', () => {
    // My picks Hello world second line. one two nested quoted twice A tip
    expect(countStorefrontWords(DOC)).toBe(13);
    expect(countStorefrontWords({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: "L'été est là - 3 fois !" }] }] })).toBe(5);
    expect(countStorefrontWords(emptyStorefrontDoc())).toBe(0);
    expect(countStorefrontWords(null)).toBe(0);
  });
});
