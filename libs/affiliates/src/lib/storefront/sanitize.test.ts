/* eslint-disable no-script-url, no-extend-native -- XSS vectors and a polluted Object.prototype
   (restored in a finally block) are the fixtures this suite exists to run */
import { describe, expect, it } from 'vitest';
import { collectStorefrontProductIds, emptyStorefrontDoc } from './helpers';
import { STOREFRONT_LIMITS } from './limits';
import {
  isStorefrontProductId,
  sanitizeStorefrontBlocks,
  sanitizeStorefrontDoc,
  sanitizeStorefrontImageAttrs,
  sanitizeStorefrontImageCredit,
} from './sanitize';
import { storefrontUtf8ByteLength } from './text';
import type { StorefrontDoc, StorefrontSanitizeOptions, StorefrontSanitizeResult } from './types';

// ---------------------------------------------------------------------------------------------
// Fixtures and helpers (special characters are built from code points: the source stays ASCII)
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

const ch = (...codes: number[]): string => String.fromCodePoint(...codes);
const NUL = ch(0x00);
const BEL = ch(0x07);
const TAB = ch(0x09);
const LF = ch(0x0a);
const CR = ch(0x0d);
const ESC = ch(0x1b);
const DEL = ch(0x7f);
const C1_NEL = ch(0x85);
const NBSP = ch(0xa0);
const ZWJ = ch(0x200d);
const LINE_SEPARATOR = ch(0x2028);
const RLO = ch(0x202e);
const LRI = ch(0x2066);
const BOM = ch(0xfeff);
const BACKSLASH = ch(0x5c);
const LONE_HIGH = String.fromCharCode(0xd800);
const LONE_LOW = String.fromCharCode(0xdc00);
const EMOJI_FAMILY = ch(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
const E_ACUTE = ch(0xe9);

const ORIGINS = ['https://media.example-store.com', 'https://images.pexels.com', 'https://images.unsplash.com'];
const OPTIONS: StorefrontSanitizeOptions = { allowedImageOrigins: ORIGINS, siteOrigin: 'https://shop.example' };

const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const text = (value: string, marks?: unknown[]): Json => (marks ? { type: 'text', text: value, marks } : { type: 'text', text: value });
const paragraph = (...content: unknown[]): Json => (content.length ? { type: 'paragraph', content } : { type: 'paragraph' });
const doc = (...content: unknown[]): Json => ({ type: 'doc', content });
const link = (href: string): Json => ({ type: 'link', attrs: { href } });
const listItem = (...content: unknown[]): Json => ({ type: 'listItem', content });
const bulletList = (...items: unknown[]): Json => ({ type: 'bulletList', content: items });
const image = (attrs: Json): Json => ({ type: 'image', attrs });
const grid = (attrs: Json): Json => ({ type: 'affiliateProductGrid', attrs });

const PEXELS_CREDIT = {
  provider: 'pexels',
  photographer: 'Jane Doe',
  photographerUrl: 'https://www.pexels.com/@jane',
  sourceUrl: 'https://www.pexels.com/photo/mug-1/',
  downloadLocation: null,
  utmSource: null,
};

const UNSPLASH_CREDIT = {
  provider: 'unsplash',
  photographer: 'Sam Lee',
  photographerUrl: 'https://unsplash.com/@samlee',
  sourceUrl: 'https://unsplash.com/photos/abc123',
  downloadLocation: 'https://api.unsplash.com/photos/abc123/download?ixid=xyz',
  utmSource: 'nextblock_store',
};

const sanitize = (input: unknown): StorefrontSanitizeResult => sanitizeStorefrontDoc(input, OPTIONS);
const blocksOf = (input: unknown): unknown[] => sanitize(input).doc.content;
/**
 * The value as Postgres prints it as jsonb (`content::text`, the unit of the 02030 size CHECKs):
 * `: ` after every key and `, ` between members and elements. Written independently of
 * `storefrontJsonbTextByteLength` (a recursive printer, not a scan of compact JSON).
 */
const jsonbText = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(jsonbText).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    const members = Object.entries(value as Json).filter(([, member]) => member !== undefined);
    return `{${members.map(([key, member]) => `${JSON.stringify(key)}: ${jsonbText(member)}`).join(', ')}}`;
  }
  return JSON.stringify(value);
};
/** `octet_length(value::jsonb::text)`: what the `draft_content` / `published_content` CHECK measures. */
const jsonBytes = (value: unknown): number => new TextEncoder().encode(jsonbText(value)).byteLength;
const hasIssue = (result: { issues: string[] }, fragment: string): boolean =>
  result.issues.some((issue) => issue.includes(fragment));

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasForbiddenTextChar(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x0a) continue;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
    if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff) return true;
    if (code === 0x2028 || code === 0x2029) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * Every rule of the StorefrontDoc contract (types.ts) plus the editor-schema invariants the
 * sanitizer promises. Returns a list of violations (empty = valid).
 */
function shapeProblems(value: unknown): string[] {
  const problems: string[] = [];
  const fail = (path: string, message: string): void => {
    problems.push(`${path}: ${message}`);
  };
  const exactKeys = (node: Json, path: string, required: string[], optional: string[] = []): void => {
    for (const key of Object.keys(node)) {
      if (!required.includes(key) && !optional.includes(key)) fail(path, `unexpected key "${key}"`);
    }
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(node, key)) fail(path, `missing key "${key}"`);
    }
    if (Object.getPrototypeOf(node) !== Object.prototype) fail(path, 'not a plain object');
  };
  const checkMarks = (marks: unknown, path: string): void => {
    if (!Array.isArray(marks) || marks.length === 0) return fail(path, 'marks must be a non-empty array');
    const seen = new Set<unknown>();
    marks.forEach((mark, index) => {
      const markPath = `${path}.marks[${index}]`;
      if (!isObject(mark)) return fail(markPath, 'not an object');
      if (seen.has(mark['type'])) fail(markPath, 'duplicate mark');
      seen.add(mark['type']);
      if (mark['type'] === 'link') {
        exactKeys(mark, markPath, ['type', 'attrs']);
        const attrs = mark['attrs'];
        if (!isObject(attrs)) return fail(markPath, 'link attrs');
        exactKeys(attrs, `${markPath}.attrs`, ['href']);
        if (typeof attrs['href'] !== 'string') fail(markPath, 'href');
      } else if (['bold', 'italic', 'underline', 'strike'].includes(String(mark['type']))) {
        exactKeys(mark, markPath, ['type']);
      } else {
        fail(markPath, `mark type ${String(mark['type'])}`);
      }
    });
  };
  const checkInline = (content: unknown, path: string): void => {
    if (content === undefined) return;
    if (!Array.isArray(content) || content.length === 0) return fail(path, 'content must be a non-empty array when present');
    content.forEach((node, index) => {
      const nodePath = `${path}[${index}]`;
      if (!isObject(node)) return fail(nodePath, 'not an object');
      if (node['type'] === 'hardBreak') return exactKeys(node, nodePath, ['type']);
      if (node['type'] !== 'text') return fail(nodePath, `inline type ${String(node['type'])}`);
      exactKeys(node, nodePath, ['type', 'text'], ['marks']);
      const value = node['text'];
      if (typeof value !== 'string' || value.length === 0) fail(nodePath, 'empty text');
      else if (value.length > STOREFRONT_LIMITS.maxTextLength) fail(nodePath, 'text too long');
      else if (hasForbiddenTextChar(value)) fail(nodePath, 'control character in text');
      if (node['marks'] !== undefined) checkMarks(node['marks'], nodePath);
    });
  };
  const checkParagraph = (node: Json, path: string): void => {
    exactKeys(node, path, ['type'], ['content']);
    checkInline(node['content'], `${path}.content`);
  };
  const checkList = (node: Json, path: string, depth: number): void => {
    if (node['type'] === 'orderedList') {
      exactKeys(node, path, ['type', 'attrs', 'content']);
      const attrs = node['attrs'];
      if (!isObject(attrs)) return fail(path, 'ordered list attrs');
      exactKeys(attrs, `${path}.attrs`, ['start']);
      if (!Number.isInteger(attrs['start'])) fail(path, 'start');
    } else {
      exactKeys(node, path, ['type', 'content']);
    }
    const items = node['content'];
    if (!Array.isArray(items) || items.length === 0) return fail(path, 'empty list');
    items.forEach((item, index) => {
      const itemPath = `${path}.content[${index}]`;
      if (!isObject(item) || item['type'] !== 'listItem') return fail(itemPath, 'not a list item');
      exactKeys(item, itemPath, ['type', 'content']);
      const children = item['content'];
      if (!Array.isArray(children) || children.length === 0) return fail(itemPath, 'empty list item');
      if (!isObject(children[0]) || children[0]['type'] !== 'paragraph') fail(itemPath, 'first child is not a paragraph');
      children.forEach((child, childIndex) => {
        const childPath = `${itemPath}.content[${childIndex}]`;
        if (!isObject(child)) return fail(childPath, 'not an object');
        if (depth + 2 > STOREFRONT_LIMITS.maxDepth) fail(childPath, 'too deep');
        if (child['type'] === 'paragraph') checkParagraph(child, childPath);
        else if (child['type'] === 'bulletList' || child['type'] === 'orderedList') checkList(child, childPath, depth + 2);
        else fail(childPath, `list item child ${String(child['type'])}`);
      });
    });
  };
  const checkBlock = (node: unknown, path: string): void => {
    if (!isObject(node)) return fail(path, 'not an object');
    switch (node['type']) {
      case 'paragraph':
        return checkParagraph(node, path);
      case 'heading': {
        exactKeys(node, path, ['type', 'attrs'], ['content']);
        const attrs = node['attrs'];
        if (!isObject(attrs)) return fail(path, 'heading attrs');
        exactKeys(attrs, `${path}.attrs`, ['level']);
        if (attrs['level'] !== 2 && attrs['level'] !== 3) fail(path, 'level');
        return checkInline(node['content'], `${path}.content`);
      }
      case 'bulletList':
      case 'orderedList':
        return checkList(node, path, 1);
      case 'blockquote': {
        exactKeys(node, path, ['type', 'content']);
        const content = node['content'];
        if (!Array.isArray(content) || content.length === 0) return fail(path, 'empty quote');
        content.forEach((child, index) => {
          if (!isObject(child) || child['type'] !== 'paragraph') fail(`${path}[${index}]`, 'quote child');
          else checkParagraph(child, `${path}[${index}]`);
        });
        return;
      }
      case 'horizontalRule':
        return exactKeys(node, path, ['type']);
      case 'image': {
        exactKeys(node, path, ['type', 'attrs']);
        const attrs = node['attrs'];
        if (!isObject(attrs)) return fail(path, 'image attrs');
        exactKeys(attrs, `${path}.attrs`, ['src', 'alt', 'title', 'width', 'height', 'credit']);
        if (typeof attrs['src'] !== 'string') fail(path, 'src');
        if (typeof attrs['alt'] !== 'string' || (attrs['alt'] as string).length > STOREFRONT_LIMITS.maxAltLength) fail(path, 'alt');
        for (const key of ['width', 'height']) {
          const dimension = attrs[key];
          if (dimension !== null && !(Number.isInteger(dimension) && (dimension as number) >= 1 && (dimension as number) <= 4000)) {
            fail(path, key);
          }
        }
        const credit = attrs['credit'];
        if (credit !== null) {
          if (!isObject(credit)) return fail(path, 'credit');
          exactKeys(credit, `${path}.attrs.credit`, ['provider', 'photographer', 'photographerUrl', 'sourceUrl', 'downloadLocation', 'utmSource']);
          if (credit['provider'] !== 'pexels' && credit['provider'] !== 'unsplash') fail(path, 'credit provider');
          for (const key of ['photographerUrl', 'sourceUrl']) {
            const url = credit[key];
            if (typeof url !== 'string' || !url.startsWith('https://') || url.length > 500) fail(path, `credit ${key}`);
          }
        }
        return;
      }
      case 'storefrontCallout': {
        exactKeys(node, path, ['type', 'attrs'], ['content']);
        const attrs = node['attrs'];
        if (!isObject(attrs)) return fail(path, 'callout attrs');
        exactKeys(attrs, `${path}.attrs`, ['tone']);
        if (!['info', 'tip', 'highlight'].includes(String(attrs['tone']))) fail(path, 'tone');
        return checkInline(node['content'], `${path}.content`);
      }
      case 'affiliateProductGrid': {
        exactKeys(node, path, ['type', 'attrs']);
        const attrs = node['attrs'];
        if (!isObject(attrs)) return fail(path, 'grid attrs');
        exactKeys(attrs, `${path}.attrs`, ['productIds', 'title', 'columns']);
        const ids = attrs['productIds'];
        if (!Array.isArray(ids) || ids.length > 12 || ids.some((id) => !isStorefrontProductId(id) || id !== id.toLowerCase())) {
          fail(path, 'productIds');
        }
        if (attrs['title'] !== null && (typeof attrs['title'] !== 'string' || attrs['title'] === '' || (attrs['title'] as string).length > 120)) {
          fail(path, 'title');
        }
        if (![2, 3, 4].includes(attrs['columns'] as number)) fail(path, 'columns');
        return;
      }
      default:
        return fail(path, `block type ${String(node['type'])}`);
    }
  };
  if (!isObject(value)) return ['doc: not an object'];
  exactKeys(value, 'doc', ['type', 'content']);
  if (value['type'] !== 'doc') fail('doc', 'type');
  const content = value['content'];
  if (!Array.isArray(content) || content.length === 0) return [...problems, 'doc: content must hold at least one block'];
  if (content.length > STOREFRONT_LIMITS.maxBlocks) fail('doc', 'too many blocks');
  content.forEach((block, index) => checkBlock(block, `doc.content[${index}]`));
  if (jsonBytes(value) > STOREFRONT_LIMITS.maxJsonBytes) fail('doc', 'over the byte limit');
  return problems;
}

/** Valid shape + fixed point: a second pass (object or JSON string) changes nothing. */
function expectSanitizedFixedPoint(result: StorefrontSanitizeResult): void {
  expect(shapeProblems(result.doc)).toEqual([]);
  const again = sanitize(result.doc);
  expect(again.doc).toEqual(result.doc);
  expect(again.changed).toBe(false);
  expect(again.issues).toEqual([]);
  const fromString = sanitize(JSON.stringify(result.doc));
  expect(fromString.doc).toEqual(result.doc);
  expect(fromString.changed).toBe(false);
}

const RICH_DOC: StorefrontDoc = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'My picks' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'I love ' },
        { type: 'text', text: 'this shop', marks: [{ type: 'link', attrs: { href: 'https://example.com/shop' } }, { type: 'bold' }] },
        { type: 'hardBreak' },
        { type: 'text', text: 'and more', marks: [{ type: 'italic' }, { type: 'strike' }, { type: 'underline' }] },
        { type: 'text', text: ' and our ' },
        { type: 'text', text: 'catalog', marks: [{ type: 'link', attrs: { href: '/products' } }] },
      ],
    },
    { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Details' }] },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'One' }] },
            {
              type: 'orderedList',
              attrs: { start: 3 },
              content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Nested' }] }] }],
            },
          ],
        },
        { type: 'listItem', content: [{ type: 'paragraph' }] },
      ],
    },
    { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A quote' }] }] },
    { type: 'horizontalRule' },
    {
      type: 'image',
      attrs: {
        src: 'https://images.pexels.com/photos/1/a.jpeg',
        alt: 'A mug',
        title: null,
        width: 800,
        height: 600,
        credit: { provider: 'pexels', photographer: 'Jane Doe', photographerUrl: 'https://www.pexels.com/@jane', sourceUrl: 'https://www.pexels.com/photo/mug-1/', downloadLocation: null, utmSource: null },
      },
    },
    {
      type: 'image',
      attrs: {
        src: 'https://images.unsplash.com/photo-1?ixid=abc&w=1080',
        alt: 'A desk',
        title: 'Desk',
        width: null,
        height: null,
        credit: {
          provider: 'unsplash',
          photographer: 'Sam Lee',
          photographerUrl: 'https://unsplash.com/@samlee',
          sourceUrl: 'https://unsplash.com/photos/abc123',
          downloadLocation: 'https://api.unsplash.com/photos/abc123/download?ixid=xyz',
          utmSource: 'nextblock_store',
        },
      },
    },
    { type: 'storefrontCallout', attrs: { tone: 'tip' }, content: [{ type: 'text', text: 'Pro tip' }] },
    { type: 'affiliateProductGrid', attrs: { productIds: [uuid(1), uuid(2)], title: 'Favorites', columns: 4 } },
    { type: 'affiliateProductGrid', attrs: { productIds: [], title: null, columns: 3 } },
    { type: 'paragraph' },
  ],
};

/** Every input the suite throws at the sanitizer; each must come out valid and as a fixed point. */
const CORPUS: Array<[string, unknown]> = [];
const corpus = (label: string, input: unknown): unknown => {
  CORPUS.push([label, input]);
  return input;
};

// ---------------------------------------------------------------------------------------------

describe('sanitizeStorefrontDoc: canonical input', () => {
  it('returns a canonical document unchanged, with no issues', () => {
    const result = sanitize(corpus('rich canonical document', RICH_DOC));
    expect(result.doc).toEqual(RICH_DOC);
    expect(result.changed).toBe(false);
    expect(result.issues).toEqual([]);
    expect(result.doc).not.toBe(RICH_DOC);
  });

  it('accepts the same document as a JSON string', () => {
    const result = sanitize(JSON.stringify(RICH_DOC));
    expect(result.doc).toEqual(RICH_DOC);
    expect(result.changed).toBe(false);
    expect(result.issues).toEqual([]);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(sanitize(RICH_DOC).doc)).toBe(JSON.stringify(sanitize(RICH_DOC).doc));
  });

  it("accepts the editor's getJSON() output (null attributes, null-prototype attrs, string dimensions)", () => {
    const nullProtoAttrs = Object.assign(Object.create(null) as Json, { level: 2 });
    const input = corpus('tiptap getJSON output', {
      type: 'doc',
      content: [
        { type: 'heading', attrs: nullProtoAttrs, content: [{ type: 'text', text: 'Hello' }] },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              marks: [
                { type: 'link', attrs: { href: 'https://example.com/x', target: '_blank', rel: 'noopener noreferrer nofollow', class: null, title: null } },
                { type: 'bold' },
              ],
              text: 'link',
            },
            { type: 'hardBreak', marks: [{ type: 'bold' }] },
          ],
        },
        { type: 'orderedList', attrs: { start: 1, type: null }, content: [listItem(paragraph(text('one')))] },
        { type: 'image', attrs: { src: 'https://images.pexels.com/photos/2/b.jpeg', alt: null, title: null, width: '640', height: 480, credit: null } },
        { type: 'storefrontCallout', attrs: { tone: 'info' }, content: [text('Note')] },
        { type: 'affiliateProductGrid', attrs: { productIds: [], title: null, columns: 3 } },
      ],
    });
    const result = sanitize(input);
    expect(result.doc).toEqual({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Hello' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'https://example.com/x' } }, { type: 'bold' }] },
            { type: 'hardBreak' },
          ],
        },
        { type: 'orderedList', attrs: { start: 1 }, content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] }] },
        { type: 'image', attrs: { src: 'https://images.pexels.com/photos/2/b.jpeg', alt: '', title: null, width: 640, height: 480, credit: null } },
        { type: 'storefrontCallout', attrs: { tone: 'info' }, content: [{ type: 'text', text: 'Note' }] },
        { type: 'affiliateProductGrid', attrs: { productIds: [], title: null, columns: 3 } },
      ],
    });
    expect(result.issues).toEqual([]);
    expect(result.changed).toBe(true);
    expectSanitizedFixedPoint(result);
  });

  it('turns an empty document into one empty paragraph (the editor refuses a doc without blocks)', () => {
    const result = sanitize(corpus('empty document', { type: 'doc', content: [] }));
    expect(result.doc).toEqual(emptyStorefrontDoc());
    expect(result.issues).toEqual([]);
    expect(result.changed).toBe(true);
    const fixed = sanitize(emptyStorefrontDoc());
    expect(fixed.changed).toBe(false);
    expect(fixed.issues).toEqual([]);
  });

  it('reports a structural change without an issue when only meaningless keys go', () => {
    const result = sanitize({ ...RICH_DOC, version: 2 });
    expect(result.doc).toEqual(RICH_DOC);
    expect(result.changed).toBe(true);
    expect(result.issues).toEqual([]);
  });
});

describe('sanitizeStorefrontDoc: invalid input', () => {
  const hostileInputs: Array<[string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['zero', 0],
    ['a number', 42],
    ['true', true],
    ['a non-JSON string', 'not json'],
    ['truncated JSON', '{"type":"doc"'],
    ['a JSON string literal', '"just a string"'],
    ['JSON null', 'null'],
    ['an empty object', {}],
    ['a block instead of a doc', { type: 'paragraph', content: [text('x')] }],
    ['an upper-case doc type', { type: 'DOC', content: [] }],
    ['a doc whose content is a string', { type: 'doc', content: 'nope' }],
    ['an array of junk', [1, 2, 3]],
    ['a symbol', Symbol('x')],
    ['a function', () => 1],
    ['a bigint', BigInt(10)],
    ['a date', new Date(0)],
    ['a map', new Map([['type', 'doc']])],
    ['a class instance', new (class StorefrontLookalike { type = 'doc'; content = [] })()],
  ];

  it.each(hostileInputs)('never throws on %s and returns a valid empty page', (_label, input) => {
    const result = sanitize(input);
    expect(result.doc).toEqual(emptyStorefrontDoc());
    expect(result.changed).toBe(true);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('never throws on proxies, throwing getters, bigints, symbols, frozen and foreign objects', () => {
    const boom = (): never => {
      throw new Error('boom');
    };
    const throwingProxy = new Proxy({}, { get: boom, getPrototypeOf: boom, ownKeys: boom, has: boom, getOwnPropertyDescriptor: boom });
    const inputs: unknown[] = [
      throwingProxy,
      doc(throwingProxy),
      doc(paragraph(throwingProxy)),
      doc({ get type(): string { return boom(); } }),
      { type: 'doc', get content(): unknown { return boom(); } },
      doc(paragraph({ type: 'text', text: BigInt(10) })),
      doc(paragraph({ type: 'text', text: Symbol('x') })),
      doc(paragraph(text('x', [{ type: Symbol('bold') }]))),
      doc(new Date(), new Map(), () => 1, Symbol('y'), BigInt(3)),
      Object.freeze(doc(Object.freeze(paragraph(Object.freeze(text('frozen')))))),
      doc({ type: 'image', attrs: { src: { toString: () => 'https://images.pexels.com/x.png' } } }),
    ];
    for (const input of inputs) {
      let result: StorefrontSanitizeResult | undefined;
      expect(() => {
        result = sanitize(input);
      }).not.toThrow();
      expect(result && shapeProblems(result.doc)).toEqual([]);
    }
  });

  it('keeps the text of a frozen document', () => {
    const result = sanitize(Object.freeze(doc(Object.freeze(paragraph(Object.freeze(text('frozen')))))));
    expect(result.doc).toEqual(doc(paragraph(text('frozen'))));
  });

  it('refuses a JSON string over maxInputBytes before parsing it', () => {
    const huge = JSON.stringify(doc(paragraph(text('x')))) + ' '.repeat(STOREFRONT_LIMITS.maxInputBytes);
    const result = sanitize(huge);
    expect(result.doc).toEqual(emptyStorefrontDoc());
    expect(hasIssue(result, `larger than ${STOREFRONT_LIMITS.maxInputBytes} bytes`)).toBe(true);
  });

  it('measures the input in UTF-8 bytes, not characters', () => {
    const multiByte = JSON.stringify(doc(paragraph(text(E_ACUTE.repeat(600000)))));
    expect(multiByte.length).toBeLessThan(STOREFRONT_LIMITS.maxInputBytes);
    expect(hasIssue(sanitize(multiByte), 'larger than')).toBe(true);
    const underLimit = JSON.stringify(doc(paragraph(text('x')))) + ' '.repeat(1000);
    expect(sanitize(underLimit).doc).toEqual(doc(paragraph(text('x'))));
  });

  it('reports invalid JSON', () => {
    expect(hasIssue(sanitize('{"type":"doc",'), 'not valid JSON')).toBe(true);
  });
});

describe('sanitizeStorefrontDoc: unknown nodes and attributes', () => {
  it('drops svg, script, iframe, style and raw HTML nodes with their content', () => {
    const input = corpus('unknown nodes', doc(
      { type: 'svg', attrs: { onload: 'alert(1)' }, content: [text('svg text')] },
      { type: 'scriptTag', content: [text('alert(document.cookie)')] },
      { type: 'iframe', attrs: { src: 'javascript:alert(1)', srcdoc: '<script>alert(1)</script>' } },
      { type: 'styleTag', content: [text('body{background:url(javascript:alert(1))}')] },
      { type: 'htmlBlock', content: [text('<img src=x onerror=alert(1)>')] },
      { type: 'object', attrs: { data: 'javascript:alert(1)' }, content: [text('object text')] },
      { type: 'embed', content: [text('embed text')] },
      { type: 'divBlock', attrs: { class: 'x', style: 'color:red' }, content: [text('Kept text'), { type: 'hardBreak' }, text('more', [{ type: 'bold' }])] },
      { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph(text('cell'))] }] }] },
      paragraph(text('Before '), { type: 'mention', attrs: { id: 'x', label: 'bob' } }, { type: 'emoji', attrs: { name: 'smile' } }, text('after')),
      paragraph(text('x'), { type: 'inlineScript', content: [text('alert(2)')] }),
    ));
    const result = sanitize(input);
    expect(result.doc.content).toEqual([
      paragraph(text('Kept text'), { type: 'hardBreak' }, text('more', [{ type: 'bold' }])),
      paragraph(text('Before '), text('after')),
      paragraph(text('x')),
    ]);
    const json = JSON.stringify(result.doc).toLowerCase();
    for (const word of ['svg', 'alert', 'script', 'iframe', 'style', 'onload', 'onerror', 'srcdoc', 'object', 'embed', 'cell', 'img']) {
      expect(json).not.toContain(word);
    }
    for (const fragment of ['"svg"', '"scriptTag"', '"iframe"', '"styleTag"', '"htmlBlock"', '"table"', '"mention"', '"emoji"']) {
      expect(hasIssue(result, fragment)).toBe(true);
    }
    expect(hasIssue(result, 'Replaced unsupported block "divBlock"')).toBe(true);
    expectSanitizedFixedPoint(result);
  });

  it('drops every attribute outside the allowlist (style, class, on*, id, srcset, target, rel)', () => {
    const input = corpus('extra attributes', {
      type: 'doc',
      onclick: 'alert(1)',
      attrs: { style: 'x' },
      content: [
        {
          type: 'paragraph',
          attrs: { style: 'color:red', class: 'evil', onclick: 'alert(1)', id: 'x' },
          content: [
            {
              type: 'text',
              text: 'Hello',
              attrs: { onclick: 'alert(1)' },
              style: 'x',
              marks: [
                { type: 'bold', attrs: { style: 'color:red', onmouseover: 'alert(1)' } },
                { type: 'link', attrs: { href: 'https://example.com/', target: '_self', rel: 'opener', class: 'x', onclick: 'alert(1)', style: 'x' } },
              ],
            },
          ],
        },
        { type: 'heading', attrs: { level: 2, style: 'x', class: 'y', id: 'z', onclick: 'alert(1)' }, content: [text('Title')] },
        image({ src: 'https://images.pexels.com/x.png', alt: 'a', onerror: 'alert(1)', style: 'x', class: 'y', srcset: 'javascript:alert(1) 1x', title: null, width: null, height: null, credit: null }),
        { type: 'storefrontCallout', attrs: { tone: 'tip', style: 'x', class: 'y' }, content: [text('Tip')] },
        grid({ productIds: [uuid(1)], title: 'T', columns: 3, style: 'x', onclick: 'alert(1)' }),
        { type: 'horizontalRule', attrs: { style: 'x' } },
      ],
    });
    const result = sanitize(input);
    const json = JSON.stringify(result.doc);
    for (const word of ['style', 'class', 'onclick', 'onmouseover', 'onerror', 'srcset', 'alert', 'target', 'rel', 'opener', '"id"']) {
      expect(json).not.toContain(word);
    }
    expect(result.doc.content[0]).toEqual(paragraph(text('Hello', [link('https://example.com/'), { type: 'bold' }])));
    expectSanitizedFixedPoint(result);
  });

  it('wraps loose inline nodes at the document level in a paragraph', () => {
    const result = sanitize(corpus('loose inline', doc(text('a'), { type: 'hardBreak' }, text('b'), paragraph(text('c')))));
    expect(result.doc.content).toEqual([paragraph(text('a'), { type: 'hardBreak' }, text('b')), paragraph(text('c'))]);
    expect(hasIssue(result, 'Wrapped loose text')).toBe(true);
  });
});

describe('sanitizeStorefrontDoc: headings, callouts and quotes', () => {
  it('maps heading levels 1 to 2 and 4-6 to 3', () => {
    const levels: unknown[] = [1, 2, 3, 4, 5, 6, '3', 7, 2.5, null];
    const input = corpus('heading levels', doc(
      ...levels.map((level) => ({ type: 'heading', attrs: { level }, content: [text(`h${String(level)}`)] })),
      { type: 'heading', content: [text('no attrs')] },
    ));
    const result = sanitize(input);
    expect(result.doc.content.map((block) => (block as { attrs: { level: number } }).attrs.level)).toEqual([2, 2, 3, 3, 3, 3, 3, 2, 2, 2, 2]);
    expect(hasIssue(result, 'level 1 heading to level 2')).toBe(true);
    expect(hasIssue(result, 'level 4 heading to level 3')).toBe(true);
    expect(hasIssue(result, 'level 6 heading to level 3')).toBe(true);
    expect(hasIssue(result, 'invalid heading level')).toBe(true);
  });

  it('resets an unknown callout tone to info and lifts block content into lines', () => {
    const input = corpus('callouts', doc(
      { type: 'storefrontCallout', attrs: { tone: 'danger' }, content: [text('a')] },
      { type: 'storefrontCallout', content: [text('b')] },
      { type: 'storefrontCallout', attrs: { tone: 'highlight' }, content: [paragraph(text('line one')), paragraph(text('line two'))] },
      { type: 'storefrontCallout', attrs: { tone: 'tip' } },
    ));
    const result = sanitize(input);
    expect(result.doc.content).toEqual([
      { type: 'storefrontCallout', attrs: { tone: 'info' }, content: [text('a')] },
      { type: 'storefrontCallout', attrs: { tone: 'info' }, content: [text('b')] },
      { type: 'storefrontCallout', attrs: { tone: 'highlight' }, content: [text('line one'), { type: 'hardBreak' }, text('line two')] },
      { type: 'storefrontCallout', attrs: { tone: 'tip' } },
    ]);
    expect(hasIssue(result, 'invalid callout style')).toBe(true);
    expectSanitizedFixedPoint(result);
  });

  it('keeps quotes to paragraphs: nested quotes and lists are flattened, empty quotes dropped', () => {
    const input = corpus('quotes', doc(
      { type: 'blockquote', content: [paragraph(text('a')), { type: 'blockquote', content: [paragraph(text('b'))] }] },
      { type: 'blockquote', content: [bulletList(listItem(paragraph(text('x'))), listItem(paragraph(text('y'))))] },
      { type: 'blockquote', content: [{ type: 'heading', attrs: { level: 2 }, content: [text('H')] }, image({ src: '/images/x.png' })] },
      { type: 'blockquote', content: [] },
      { type: 'blockquote', content: [image({ src: '/images/x.png' })] },
      { type: 'blockquote', content: [text('loose')] },
    ));
    const result = sanitize(input);
    expect(result.doc.content).toEqual([
      { type: 'blockquote', content: [paragraph(text('a')), paragraph(text('b'))] },
      { type: 'blockquote', content: [paragraph(text('x')), paragraph(text('y'))] },
      { type: 'blockquote', content: [paragraph(text('H'))] },
      { type: 'blockquote', content: [paragraph(text('loose'))] },
    ]);
    expect(hasIssue(result, 'Removed an empty quote')).toBe(true);
    expectSanitizedFixedPoint(result);
  });
});

describe('sanitizeStorefrontDoc: lists', () => {
  it('starts every list item with a paragraph (the editor schema requires it)', () => {
    const input = corpus('list item starting with a list', doc(bulletList(listItem(bulletList(listItem(paragraph(text('inner'))))))));
    expect(blocksOf(input)).toEqual([bulletList(listItem(paragraph(), bulletList(listItem(paragraph(text('inner'))))))]);
  });

  it('drops empty lists and list items', () => {
    const input = corpus('empty lists', doc(bulletList(), bulletList(listItem()), { type: 'orderedList', content: [42, null] }, paragraph(text('kept'))));
    const result = sanitize(input);
    expect(result.doc.content).toEqual([paragraph(text('kept'))]);
    expect(hasIssue(result, 'Removed an empty list')).toBe(true);
  });

  it('flattens lists nested deeper than maxDepth into paragraphs, keeping the text', () => {
    const input = corpus('deep list', doc(
      bulletList(
        listItem(
          paragraph(text('L1')),
          bulletList(listItem(paragraph(text('L2')), bulletList(listItem(paragraph(text('L3a'))), listItem(paragraph(text('L3b')), bulletList(listItem(paragraph(text('L4')))))))),
        ),
      ),
    ));
    const result = sanitize(input);
    expect(result.doc.content).toEqual([
      bulletList(listItem(paragraph(text('L1')), bulletList(listItem(paragraph(text('L2')), paragraph(text('L3a')), paragraph(text('L3b')), paragraph(text('L4')))))),
    ]);
    expect(hasIssue(result, 'Flattened a list nested more than 6 levels')).toBe(true);
    expectSanitizedFixedPoint(result);
  });

  it('repairs malformed list content', () => {
    const input = corpus('malformed lists', doc(
      bulletList(paragraph(text('wrapped'))),
      bulletList(listItem({ type: 'heading', attrs: { level: 2 }, content: [text('H')] })),
      bulletList(listItem(paragraph(text('a')), image({ src: '/images/x.png' }), { type: 'horizontalRule' })),
      bulletList(listItem(text('loose'), text(' text'))),
      bulletList(listItem({ type: 'divBlock', content: [text('div text')] })),
    ));
    const result = sanitize(input);
    expect(result.doc.content).toEqual([
      bulletList(listItem(paragraph(text('wrapped')))),
      bulletList(listItem(paragraph(text('H')))),
      bulletList(listItem(paragraph(text('a')))),
      bulletList(listItem(paragraph(text('loose'), text(' text')))),
      bulletList(listItem(paragraph(text('div text')))),
    ]);
    expect(hasIssue(result, 'Repaired a list')).toBe(true);
    expect(hasIssue(result, 'Converted heading inside a list item')).toBe(true);
    expect(hasIssue(result, 'Removed image from a list item')).toBe(true);
    expectSanitizedFixedPoint(result);
  });

  it('normalizes ordered list start numbers and drops the type attribute', () => {
    const starts: unknown[] = [3, '5', -2, 10001, 2.6, 'abc', null, 0];
    const input = corpus('ordered list starts', doc(
      ...starts.map((start) => ({ type: 'orderedList', attrs: { start, type: 'a' }, content: [listItem(paragraph(text('x')))] })),
    ));
    const result = sanitize(input);
    expect(result.doc.content.map((block) => (block as { attrs: { start: number } }).attrs)).toEqual(
      [3, 5, 0, 9999, 3, 1, 1, 0].map((start) => ({ start })),
    );
    expect(hasIssue(result, 'invalid list start number')).toBe(true);
  });
});

describe('sanitizeStorefrontDoc: text and marks', () => {
  it('removes control, bidi and invisible formatting characters but keeps newlines, NBSP and emoji', () => {
    const input = corpus('control characters', doc(
      paragraph(text(`a${NUL}b${BEL}c${ESC}d${DEL}e${C1_NEL}f${RLO}g${LRI}h${BOM}i`)),
      paragraph(text(`line1${CR}${LF}line2${CR}line3${LINE_SEPARATOR}line4`)),
      paragraph(text(`tab${TAB}here`)),
      paragraph(text(`keep${NBSP}nbsp ${EMOJI_FAMILY} ${ZWJ}`)),
      paragraph(text(`x${LONE_HIGH}y${LONE_LOW}z`)),
      paragraph(text(`${NUL}${BEL}`), text(' ')),
    ));
    const result = sanitize(input);
    expect(result.doc.content).toEqual([
      paragraph(text('abcdefghi')),
      paragraph(text(`line1${LF}line2${LF}line3${LF}line4`)),
      paragraph(text('tab here')),
      paragraph(text(`keep${NBSP}nbsp ${EMOJI_FAMILY} ${ZWJ}`)),
      paragraph(text('xyz')),
      paragraph(text(' ')),
    ]);
    expect(hasIssue(result, 'control or invisible formatting characters')).toBe(true);
    expectSanitizedFixedPoint(result);
  });

  it('truncates long text nodes without splitting a surrogate pair', () => {
    const result = sanitize(corpus('long text', doc(paragraph(text('a'.repeat(6000))), paragraph(text(`${'b'.repeat(4999)}${EMOJI_FAMILY}`)))));
    const [first, second] = result.doc.content as Array<{ content: Array<{ text: string }> }>;
    expect(first?.content[0]?.text).toBe('a'.repeat(5000));
    expect(second?.content[0]?.text).toBe('b'.repeat(4999));
    expect(hasIssue(result, 'longer than 5000 characters')).toBe(true);
    expectSanitizedFixedPoint(result);
  });

  it('drops empty and non-string text nodes', () => {
    const result = sanitize(corpus('empty text', doc(paragraph(text(''), { type: 'text', text: 42 }, { type: 'text' }, text('ok')))));
    expect(result.doc.content).toEqual([paragraph(text('ok'))]);
    expect(hasIssue(result, 'Removed an empty text node')).toBe(true);
    expect(hasIssue(result, 'text node without text')).toBe(true);
  });

  it('caps the text of the whole page at maxTotalText', () => {
    const paragraphs = Array.from({ length: 15 }, (_, index) => paragraph(text(String.fromCharCode(97 + index).repeat(4500))));
    const result = sanitize(corpus('total text', doc(...paragraphs)));
    const texts = result.doc.content.map((block) => ((block as { content: Array<{ text: string }> }).content[0]?.text ?? ''));
    expect(texts).toHaveLength(14);
    expect(texts.reduce((sum, value) => sum + value.length, 0)).toBe(STOREFRONT_LIMITS.maxTotalText);
    expect(texts[13]).toBe('n'.repeat(1500));
    expect(hasIssue(result, `page limit of ${STOREFRONT_LIMITS.maxTotalText} characters`)).toBe(true);
    expectSanitizedFixedPoint(result);
  });

  it('keeps only the allowlisted marks, deduplicated, in canonical order', () => {
    const input = corpus('marks', doc(
      paragraph(text('a', [{ type: 'underline' }, { type: 'bold' }, link('https://example.com/a'), { type: 'italic' }, { type: 'strike' }])),
      paragraph(text('b', [{ type: 'code' }, { type: 'textStyle', attrs: { color: 'red', style: 'x' } }, { type: 'highlight', attrs: { color: '#f00' } }, { type: 'subscript' }, { type: 'bold' }, { type: 'bold' }])),
      paragraph(text('c', 'bold' as never)),
      paragraph(text('d', [null, 42, 'italic'])),
    ));
    const result = sanitize(input);
    expect(result.doc.content).toEqual([
      paragraph(text('a', [link('https://example.com/a'), { type: 'bold' }, { type: 'italic' }, { type: 'strike' }, { type: 'underline' }])),
      paragraph(text('b', [{ type: 'bold' }])),
      paragraph(text('c')),
      paragraph(text('d')),
    ]);
    for (const fragment of ['"code"', '"textStyle"', '"highlight"', '"subscript"', 'invalid text formatting']) {
      expect(hasIssue(result, fragment)).toBe(true);
    }
  });

  it('drops unsafe links but keeps their text, and normalizes safe ones', () => {
    const unsafe = [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      `java${TAB}script:alert(1)`,
      `java${NUL}script:alert(1)`,
      `${RLO}javascript:alert(1)`,
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      '//evil.example',
      `/${BACKSLASH}evil.example`,
      '/%2f/evil.example',
      'https://user:pw@evil.example/',
      '#top',
      'relative/path',
    ];
    const input = corpus('unsafe links', doc(
      ...unsafe.map((href) => paragraph(text('click', [link(href)]))),
      paragraph(text('no attrs', [{ type: 'link' }])),
      paragraph(text('safe', [link('HTTPS://Example.com')])),
      paragraph(text('internal', [link('/products/a/../b')])),
      paragraph(text('mail', [link('mailto:hi@example.com')])),
      paragraph(text('two links', [link('https://a.example/'), link('https://b.example/')])),
    ));
    const result = sanitize(input);
    const expectedUnsafe = unsafe.map(() => paragraph(text('click')));
    expect(result.doc.content).toEqual([
      ...expectedUnsafe,
      paragraph(text('no attrs')),
      paragraph(text('safe', [link('https://example.com/')])),
      paragraph(text('internal', [link('/products/b')])),
      paragraph(text('mail', [link('mailto:hi@example.com')])),
      paragraph(text('two links', [link('https://a.example/')])),
    ]);
    expect(JSON.stringify(result.doc).toLowerCase()).not.toMatch(/javascript|data:|vbscript|file:|evil/);
    expect(hasIssue(result, 'unsafe or invalid address')).toBe(true);
    expect(hasIssue(result, 'second link')).toBe(true);
    expectSanitizedFixedPoint(result);
  });

  it('lifts the text out of unknown inline wrappers, with a line break between lifted blocks', () => {
    const input = corpus('inline wrappers', doc(
      paragraph(text('a'), { type: 'span', content: [text('b'), { type: 'span', content: [text('c')] }] }),
      paragraph(text('x'), paragraph(text('y')), paragraph(text('z'))),
      paragraph({ type: 'span', content: [] }, image({ src: '/images/a.png' })),
    ));
    const result = sanitize(input);
    expect(result.doc.content).toEqual([
      paragraph(text('a'), text('b'), text('c')),
      paragraph(text('x'), { type: 'hardBreak' }, text('y'), { type: 'hardBreak' }, text('z')),
      paragraph(),
    ]);
    expectSanitizedFixedPoint(result);
  });
});

describe('sanitizeStorefrontDoc: images', () => {
  it('keeps allowlisted images, normalizes the src and builds the exact attrs shape', () => {
    const input = corpus('images', doc(
      image({ src: 'HTTPS://Images.Pexels.com/photos/1/a.jpeg', alt: '  A mug  ' }),
      image({ src: '/images/x.webp', alt: null, title: 'Title', width: '640', height: 480.4 }),
      image({ src: 'https://media.example-store.com/images/y.png', width: '640px', height: 4000 }),
    ));
    const result = sanitize(input);
    expect(result.doc.content).toEqual([
      image({ src: 'https://images.pexels.com/photos/1/a.jpeg', alt: 'A mug', title: null, width: null, height: null, credit: null }),
      image({ src: '/images/x.webp', alt: '', title: 'Title', width: 640, height: 480, credit: null }),
      image({ src: 'https://media.example-store.com/images/y.png', alt: '', title: null, width: 640, height: 4000, credit: null }),
    ]);
    expect(result.issues).toEqual([]);
    expectSanitizedFixedPoint(result);
  });

  it('drops images outside the origin allowlist and invalid dimensions', () => {
    const disallowed = [
      'https://evil.example/x.png',
      'http://images.pexels.com/x.png',
      'https://images.pexels.com.evil.example/x.png',
      'data:image/png;base64,iVBORw0KGgo=',
      'javascript:alert(1)',
      '//images.pexels.com/x.png',
      '/images/../cms/x.png',
      '/uploads/x.png',
      'https://user:pw@images.pexels.com/x.png',
      '',
      null,
    ];
    const input = corpus('disallowed images', doc(
      ...disallowed.map((src) => image({ src })),
      { type: 'image' },
      image({ src: '/images/ok.png', width: 0, height: 5000 }),
      image({ src: '/images/ok2.png', width: '100%', height: -1 }),
      image({ src: '/images/ok3.png', width: Number.NaN, height: '12.5' }),
    ));
    const result = sanitize(input);
    expect(result.doc.content).toEqual([
      image({ src: '/images/ok.png', alt: '', title: null, width: null, height: null, credit: null }),
      image({ src: '/images/ok2.png', alt: '', title: null, width: null, height: null, credit: null }),
      image({ src: '/images/ok3.png', alt: '', title: null, width: null, height: 13, credit: null }),
    ]);
    expect(hasIssue(result, 'not on an allowed image host')).toBe(true);
    expect(hasIssue(result, 'invalid image dimensions')).toBe(true);
  });

  it('cleans and shortens alt and title texts', () => {
    const result = sanitize(corpus('alt texts', doc(image({ src: '/images/a.png', alt: 'x'.repeat(300), title: `line one${LF}line two` }))));
    const attrs = (result.doc.content[0] as { attrs: { alt: string; title: string } }).attrs;
    expect(attrs.alt).toBe('x'.repeat(STOREFRONT_LIMITS.maxAltLength));
    expect(attrs.title).toBe('line one line two');
    expect(hasIssue(result, 'Shortened an image description')).toBe(true);
  });

  it('keeps valid stock photo credits and refuses forged ones', () => {
    const input = corpus('credits', doc(
      image({ src: '/images/1.png', credit: { ...PEXELS_CREDIT, downloadLocation: 'https://api.unsplash.com/photos/x/download', utmSource: 'x' } }),
      image({ src: '/images/2.png', credit: UNSPLASH_CREDIT }),
      image({ src: '/images/3.png', credit: { ...PEXELS_CREDIT, provider: 'flickr' } }),
      image({ src: '/images/4.png', credit: { ...PEXELS_CREDIT, photographerUrl: 'https://evil.example/@jane', sourceUrl: 'javascript:alert(1)' } }),
      image({ src: '/images/5.png', credit: { ...UNSPLASH_CREDIT, downloadLocation: 'https://evil.example/photos/1/download' } }),
      image({ src: '/images/6.png', credit: { ...UNSPLASH_CREDIT, downloadLocation: 'https://api.unsplash.com/users/x' } }),
      image({ src: '/images/7.png', credit: { ...PEXELS_CREDIT, photographer: '   ' } }),
      image({ src: '/images/8.png', credit: 'Photo by Jane' }),
      image({ src: '/images/9.png', credit: { ...UNSPLASH_CREDIT, photographerUrl: 'http://unsplash.com/@samlee', sourceUrl: 'https://unsplash.com:8443/photos/x' } }),
    ));
    const result = sanitize(input);
    const credits = result.doc.content.map((block) => (block as { attrs: { credit: unknown } }).attrs.credit);
    expect(credits).toEqual([
      PEXELS_CREDIT,
      UNSPLASH_CREDIT,
      null,
      { ...PEXELS_CREDIT, photographerUrl: 'https://www.pexels.com/', sourceUrl: 'https://www.pexels.com/' },
      { ...UNSPLASH_CREDIT, downloadLocation: null },
      { ...UNSPLASH_CREDIT, downloadLocation: null },
      null,
      null,
      { ...UNSPLASH_CREDIT, photographerUrl: 'https://unsplash.com/', sourceUrl: 'https://unsplash.com/' },
    ]);
    expect(JSON.stringify(result.doc)).not.toContain('evil');
    expect(hasIssue(result, 'Removed an image credit with invalid details')).toBe(true);
    expect(hasIssue(result, 'invalid photo credit link')).toBe(true);
    expect(hasIssue(result, 'invalid Unsplash download link')).toBe(true);
    expectSanitizedFixedPoint(result);
  });

  it('caps the images of a page at maxImages', () => {
    const images = Array.from({ length: 35 }, (_, index) => image({ src: `/images/${index}.png` }));
    const result = sanitize(corpus('too many images', doc(...images)));
    expect(result.doc.content).toHaveLength(STOREFRONT_LIMITS.maxImages);
    expect(hasIssue(result, `limit of ${STOREFRONT_LIMITS.maxImages}`)).toBe(true);
  });
});

describe('sanitizeStorefrontDoc: product grids', () => {
  it('keeps uuid product ids only, lowercased and deduplicated', () => {
    const input = corpus('grid ids', doc(grid({
      productIds: ['not-a-uuid', 123, null, uuid(0xabc).toUpperCase(), uuid(0xabc), `${uuid(6)} `, '00000000-0000-4000-8000-00000000000g', uuid(7)],
      title: 'Picks',
      columns: 3,
    })));
    const result = sanitize(input);
    expect(uuid(0xabc).toUpperCase()).not.toBe(uuid(0xabc));
    expect(result.doc.content).toEqual([grid({ productIds: [uuid(0xabc), uuid(7)], title: 'Picks', columns: 3 })]);
    expect(hasIssue(result, 'invalid product ids')).toBe(true);
    expect(hasIssue(result, 'duplicate product ids')).toBe(true);
  });

  it('caps products per grid, distinct products per page and grids per page', () => {
    const ids = (from: number, count: number): string[] => Array.from({ length: count }, (_, index) => uuid(from + index));
    const input = corpus('grid limits', doc(
      grid({ productIds: ids(1, 15), title: null, columns: 3 }),
      grid({ productIds: ids(13, 12), title: null, columns: 3 }),
      grid({ productIds: [...ids(30, 5), uuid(1)], title: null, columns: 3 }),
      ...Array.from({ length: 12 }, () => grid({ productIds: [], title: null, columns: 3 })),
    ));
    const result = sanitize(input);
    const grids = result.doc.content as Array<{ attrs: { productIds: string[] } }>;
    expect(grids).toHaveLength(STOREFRONT_LIMITS.maxProductGrids);
    expect(grids[0]?.attrs.productIds).toEqual(ids(1, 12));
    expect(grids[1]?.attrs.productIds).toEqual(ids(13, 12));
    expect(grids[2]?.attrs.productIds).toEqual([uuid(1)]);
    expect(collectStorefrontProductIds(result.doc)).toHaveLength(STOREFRONT_LIMITS.maxFeaturedProducts);
    expect(hasIssue(result, 'limit of 12 per product grid')).toBe(true);
    expect(hasIssue(result, 'limit of 24 different products')).toBe(true);
    expect(hasIssue(result, `product grids beyond the limit of ${STOREFRONT_LIMITS.maxProductGrids}`)).toBe(true);
    expectSanitizedFixedPoint(result);
  });

  it('validates columns and titles', () => {
    const input = corpus('grid attrs', doc(
      grid({ productIds: [], title: 'x'.repeat(200), columns: '4' }),
      grid({ productIds: [], title: '', columns: 5 }),
      grid({ productIds: [], title: '   ', columns: 2 }),
      grid({ productIds: 'abc', title: 42, columns: 3.5 }),
      { type: 'affiliateProductGrid' },
      grid({ productIds: [], title: `two${LF}lines`, columns: 4 }),
    ));
    const result = sanitize(input);
    expect(result.doc.content).toEqual([
      grid({ productIds: [], title: 'x'.repeat(120), columns: 4 }),
      grid({ productIds: [], title: null, columns: 3 }),
      grid({ productIds: [], title: null, columns: 2 }),
      grid({ productIds: [], title: null, columns: 3 }),
      grid({ productIds: [], title: null, columns: 3 }),
      grid({ productIds: [], title: 'two lines', columns: 4 }),
    ]);
    expect(hasIssue(result, 'invalid product grid columns')).toBe(true);
    expect(hasIssue(result, 'invalid product grid title')).toBe(true);
    expect(hasIssue(result, 'invalid product list')).toBe(true);
  });
});

describe('sanitizeStorefrontDoc: size and depth limits', () => {
  it('caps top-level blocks at maxBlocks', () => {
    const result = sanitize(corpus('too many blocks', doc(...Array.from({ length: 250 }, (_, index) => paragraph(text(`p${index}`))))));
    expect(result.doc.content).toHaveLength(STOREFRONT_LIMITS.maxBlocks);
    expect((result.doc.content[199] as { content: Array<{ text: string }> }).content[0]?.text).toBe('p199');
    expect(hasIssue(result, `limit of ${STOREFRONT_LIMITS.maxBlocks}`)).toBe(true);
  });

  it('drops trailing blocks until the document fits maxJsonBytes', () => {
    const href = `https://example.com/${'a'.repeat(1900)}`;
    const input = corpus('byte limit', doc(...Array.from({ length: 80 }, (_, index) => paragraph(text(`a${index}`, [link(href)]), text(`b${index}`, [link(href)])))));
    const result = sanitize(input);
    expect(jsonBytes(result.doc)).toBeLessThanOrEqual(STOREFRONT_LIMITS.maxJsonBytes);
    expect(result.doc.content.length).toBeGreaterThan(50);
    expect(result.doc.content.length).toBeLessThan(80);
    expect(result.doc.content).toEqual((input as { content: unknown[] }).content.slice(0, result.doc.content.length));
    expect(hasIssue(result, `${STOREFRONT_LIMITS.maxJsonBytes}-byte document size limit`)).toBe(true);
    expectSanitizedFixedPoint(result);
  });

  it('measures the document the way the CHECK does (jsonb text), so a mark- and link-dense page still saves', () => {
    // Compact JSON undercounts jsonb text by ~10% on such a page: the old guard kept this document
    // at ~259 KB compact, ~287 KB as jsonb text, and every autosave failed the CHECK (23514).
    const runs = (row: number) =>
      Array.from({ length: 40 }, (_, index) =>
        index % 2 === 0
          ? text(`w${row}-${index} `, [{ type: 'bold' }])
          : text(`l${row}-${index} `, [{ type: 'italic' }, link(`https://example.com/p/${row}/${index}`)]),
      );
    const input = doc(...Array.from({ length: 190 }, (_, row) => paragraph(...runs(row))));
    const result = sanitize(input);
    expect(storefrontUtf8ByteLength(JSON.stringify(result.doc))).toBeGreaterThan(200_000);
    expect(jsonBytes(result.doc)).toBeLessThanOrEqual(STOREFRONT_LIMITS.maxJsonBytes);
    expect(hasIssue(result, `${STOREFRONT_LIMITS.maxJsonBytes}-byte document size limit`)).toBe(true);
    expect(result.doc.content).toEqual(sanitize(input).doc.content);
    expectSanitizedFixedPoint(result);
  });

  it('stops building far past the byte limit and still fits it', () => {
    const href = `https://example.com/${'z'.repeat(1970)}`;
    expect(href.length).toBeLessThanOrEqual(STOREFRONT_LIMITS.maxHrefLength);
    const many = Array.from({ length: 4000 }, (_, index) => text(`t${index}`, [link(href)]));
    const input = doc(paragraph(text('first')), ...Array.from({ length: 150 }, () => paragraph(...many.slice(0, 12))), paragraph(...many));
    const started = performance.now();
    const result = sanitize(input);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(jsonBytes(result.doc)).toBeLessThanOrEqual(STOREFRONT_LIMITS.maxJsonBytes);
    expect(result.doc.content[0]).toEqual(paragraph(text('first')));
    expectSanitizedFixedPoint(result);
  });

  it('stops after maxInputNodes visited nodes (junk arrays, sparse arrays, mark floods)', () => {
    const inputs: unknown[] = [
      { type: 'doc', content: Array.from({ length: 1_000_000 }, (_, index) => index) },
      { type: 'doc', content: new Array(10_000_000) },
      doc({ type: 'paragraph', content: Array.from({ length: 200_000 }, () => text('a')) }),
      doc(paragraph(text('marks', Array.from({ length: 300_000 }, () => ({ type: 'bold' }))))),
      doc(grid({ productIds: Array.from({ length: 1_000_000 }, () => uuid(1)), title: null, columns: 3 })),
    ];
    for (const input of inputs) {
      const started = performance.now();
      const result = sanitize(input);
      expect(performance.now() - started).toBeLessThan(5000);
      expect(shapeProblems(result.doc)).toEqual([]);
    }
    expect(hasIssue(sanitize(inputs[0]), `first ${STOREFRONT_LIMITS.maxInputNodes} nodes`)).toBe(true);
  });

  it('survives depth bombs without recursing past maxInputDepth', () => {
    const nest = (depth: number, wrap: (child: unknown) => unknown, leaf: unknown): unknown => {
      let node = leaf;
      for (let index = 0; index < depth; index += 1) node = wrap(node);
      return node;
    };
    const leaf = paragraph(text('deep'));
    const bombs: unknown[] = [
      nest(20000, (child) => ({ type: 'blockquote', content: [child] }), leaf),
      nest(20000, (child) => bulletList(listItem(paragraph(text('item')), child)), leaf),
      nest(20000, (child) => ({ type: 'section', content: [child] }), leaf),
      nest(20000, (child) => [child], leaf),
      nest(20000, (child) => ({ type: 'storefrontCallout', content: [child] }), text('x')),
      paragraph(nest(20000, (child) => ({ type: 'span', content: [child] }), text('deep'))),
      bulletList(nest(20000, (child) => listItem(child), paragraph(text('x')))),
    ];
    for (const bomb of bombs) {
      const started = performance.now();
      const result = sanitize(doc(bomb));
      expect(performance.now() - started).toBeLessThan(5000);
      expect(shapeProblems(result.doc)).toEqual([]);
      expectSanitizedFixedPoint(result);
    }
    const listResult = sanitize(doc(bombs[1]));
    expect(JSON.stringify(listResult.doc)).toContain('item');
  });

  it('survives a deeply nested JSON string', () => {
    const deep = `{"type":"doc","content":[${'['.repeat(200000)}${']'.repeat(200000)}]}`;
    expect(() => sanitize(deep)).not.toThrow();
    expect(shapeProblems(sanitize(deep).doc)).toEqual([]);
  });

  it('survives cyclic objects', () => {
    const cyclicParagraph: Json = { type: 'paragraph', content: [] };
    (cyclicParagraph['content'] as unknown[]).push(cyclicParagraph, text('after'));
    const cyclicDoc: Json = { type: 'doc', content: [] };
    const cyclicList: Json = { type: 'bulletList', content: [] };
    (cyclicList['content'] as unknown[]).push(listItem(paragraph(text('a')), cyclicList));
    (cyclicDoc['content'] as unknown[]).push(cyclicDoc, cyclicParagraph, cyclicList);
    const result = sanitize(cyclicDoc);
    expect(shapeProblems(result.doc)).toEqual([]);
    expectSanitizedFixedPoint(result);
  });
});

describe('sanitizeStorefrontDoc: prototype pollution', () => {
  it('ignores __proto__ and constructor keys from JSON and never pollutes Object.prototype', () => {
    const payload =
      '{"type":"doc","__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},"content":[' +
      '{"type":"paragraph","__proto__":{"content":[{"type":"text","text":"from proto"}]},"attrs":{"__proto__":{"style":"x"}},' +
      '"content":[{"type":"text","text":"hi","__proto__":{"marks":[{"type":"link","attrs":{"href":"https://evil.example/"}}]},' +
      '"marks":[{"type":"__proto__"},{"type":"constructor"},{"type":"toString"},{"type":"hasOwnProperty"},{"type":"bold","__proto__":{"type":"link"}}]}]},' +
      '{"type":"__proto__"},{"type":"constructor"},{"type":"toString"},{"type":"valueOf"},{"type":"hasOwnProperty"},' +
      '{"type":"image","attrs":{"__proto__":{"src":"https://images.pexels.com/x.png"}}}]}';
    const result = sanitize(payload);
    expect(({} as Json)['polluted']).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
    expect(result.doc).toEqual(doc(paragraph(text('hi', [{ type: 'bold' }]))));
    expect(JSON.stringify(result.doc)).not.toContain('evil');
    expectSanitizedFixedPoint(result);
  });

  it('reads own properties only, even when Object.prototype is polluted', () => {
    const proto = Object.prototype as Json;
    const input = doc(paragraph(text('hi')), { type: 'image' }, { type: 'affiliateProductGrid' }, { type: 'heading', content: [text('H')] });
    let result: StorefrontSanitizeResult | undefined;
    Object.defineProperty(Object.prototype, 'marks', {
      value: [{ type: 'link', attrs: { href: 'https://evil.example/' } }],
      configurable: true,
      writable: true,
      enumerable: false,
    });
    Object.defineProperty(Object.prototype, 'attrs', {
      value: { src: 'https://images.pexels.com/x.png', level: 3, productIds: [uuid(1)], tone: 'tip' },
      configurable: true,
      writable: true,
      enumerable: false,
    });
    try {
      result = sanitizeStorefrontDoc(input, OPTIONS);
    } finally {
      delete proto['marks'];
      delete proto['attrs'];
    }
    expect(result?.doc).toEqual(
      doc(paragraph(text('hi')), grid({ productIds: [], title: null, columns: 3 }), { type: 'heading', attrs: { level: 2 }, content: [text('H')] }),
    );
  });
});

describe('sanitizeStorefrontBlocks and the public attribute helpers', () => {
  it('sanitizes a block list without the one-block minimum', () => {
    expect(sanitizeStorefrontBlocks([], OPTIONS)).toEqual({ blocks: [], issues: [], changed: false });
    const scripts = sanitizeStorefrontBlocks([{ type: 'script', content: [text('alert(1)')] }], OPTIONS);
    expect(scripts.blocks).toEqual([]);
    expect(scripts.changed).toBe(true);
    expect(scripts.issues.length).toBeGreaterThan(0);
    const canonical = sanitizeStorefrontBlocks(RICH_DOC.content, OPTIONS);
    expect(canonical).toEqual({ blocks: RICH_DOC.content, issues: [], changed: false });
    expect(sanitizeStorefrontBlocks(RICH_DOC, OPTIONS).blocks).toEqual(RICH_DOC.content);
    expect(sanitizeStorefrontBlocks('nope', OPTIONS).blocks).toEqual([]);
  });

  it('builds validated image attrs', () => {
    expect(sanitizeStorefrontImageAttrs({ src: 'https://images.pexels.com/x.png', alt: 'A', credit: UNSPLASH_CREDIT }, ORIGINS)).toEqual({
      src: 'https://images.pexels.com/x.png',
      alt: 'A',
      title: null,
      width: null,
      height: null,
      credit: UNSPLASH_CREDIT,
    });
    expect(sanitizeStorefrontImageAttrs({ src: 'https://evil.example/x.png' }, ORIGINS)).toBeNull();
    expect(sanitizeStorefrontImageAttrs(new Proxy({}, { getPrototypeOf: () => { throw new Error('boom'); } }), ORIGINS)).toBeNull();
  });

  it('validates stock photo credits', () => {
    expect(sanitizeStorefrontImageCredit(PEXELS_CREDIT)).toEqual(PEXELS_CREDIT);
    expect(sanitizeStorefrontImageCredit({ ...UNSPLASH_CREDIT, photographer: `  Sam${LF}Lee  ` })).toEqual({ ...UNSPLASH_CREDIT, photographer: 'Sam Lee' });
    expect(sanitizeStorefrontImageCredit({ ...PEXELS_CREDIT, provider: 'PEXELS' })).toBeNull();
    expect(sanitizeStorefrontImageCredit(null)).toBeNull();
    expect(sanitizeStorefrontImageCredit('credit')).toBeNull();
  });

  it('recognizes product ids', () => {
    expect(isStorefrontProductId(uuid(1))).toBe(true);
    expect(isStorefrontProductId(uuid(1).toUpperCase())).toBe(true);
    expect(isStorefrontProductId(`${uuid(1)}x`)).toBe(false);
    expect(isStorefrontProductId('1')).toBe(false);
    expect(isStorefrontProductId(1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Fixed point over every fixture above, and over seeded random documents
// ---------------------------------------------------------------------------------------------

describe('idempotence: sanitize(sanitize(x)) deep-equals sanitize(x)', () => {
  it('holds for every fixture of this suite', () => {
    expect(CORPUS.length).toBeGreaterThan(20);
    for (const [label, input] of CORPUS) {
      const once = sanitize(input);
      expect(shapeProblems(once.doc), label).toEqual([]);
      const twice = sanitize(once.doc);
      expect(twice.doc, label).toEqual(once.doc);
      expect(twice.changed, label).toBe(false);
      expect(twice.issues, label).toEqual([]);
    }
  });

  it('holds for seeded random documents mixing valid and hostile nodes', () => {
    const random = (seed: number): (() => number) => {
      let state = seed >>> 0;
      return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    };
    const types = [
      'paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'blockquote', 'horizontalRule', 'image',
      'storefrontCallout', 'affiliateProductGrid', 'text', 'hardBreak', 'doc', 'scriptTag', 'divBlock', 'span',
      'table', '__proto__', 'constructor', 'svg',
    ];
    const strings = ['', ' ', 'hello', `${E_ACUTE}lodie`, `a${LF}b`, `x${NUL}y`, `${RLO}rtl`, EMOJI_FAMILY, `${LONE_HIGH}z`, '<script>alert(1)</script>', 'w'.repeat(5100)];
    const hrefs = ['https://example.com/', 'javascript:alert(1)', '/products/x', '//evil.example', 'mailto:a@example.com', `java${TAB}script:x`];
    const srcs = ['https://images.pexels.com/a.png', 'https://evil.example/a.png', '/images/a.png', 'data:image/png;base64,AAAA'];
    const credits = [null, PEXELS_CREDIT, UNSPLASH_CREDIT, { provider: 'unsplash' }, 'credit'];
    for (let seed = 1; seed <= 400; seed += 1) {
      const next = random(seed);
      const pick = <T,>(values: readonly T[]): T => values[Math.floor(next() * values.length)] as T;
      const build = (depth: number): unknown => {
        if (depth > 7 || next() < 0.08) return pick([null, 42, 'str', true, [], {}]);
        const node: Json = { type: pick(types) };
        if (next() < 0.7) node['content'] = Array.from({ length: Math.floor(next() * 4) }, () => build(depth + 1));
        if (node['type'] === 'text' || next() < 0.1) node['text'] = pick(strings);
        if (next() < 0.4) {
          node['marks'] = Array.from({ length: Math.floor(next() * 3) }, () => ({
            type: pick(['bold', 'italic', 'link', 'code', 'underline', 'strike']),
            attrs: { href: pick(hrefs) },
          }));
        }
        if (next() < 0.6) {
          node['attrs'] = {
            level: pick([1, 2, 3, 4, 7, '2', null]),
            tone: pick(['info', 'tip', 'highlight', 'bad', null]),
            src: pick(srcs),
            alt: pick(strings),
            width: pick([1, '640', 0, 5000, null]),
            productIds: pick([[uuid(1), uuid(1), 'bad', uuid(2).toUpperCase()], [], null, 'x']),
            columns: pick([2, 3, 4, 5, '4']),
            title: pick(strings),
            start: pick([1, 0, -1, '3', 2.5]),
            credit: pick(credits),
          };
        }
        return node;
      };
      const input = { type: 'doc', content: Array.from({ length: 1 + Math.floor(next() * 6) }, () => build(1)) };
      const once = sanitize(input);
      expect(shapeProblems(once.doc), `seed ${seed}`).toEqual([]);
      const twice = sanitize(once.doc);
      expect(twice.doc, `seed ${seed}`).toEqual(once.doc);
      expect(twice.changed, `seed ${seed}`).toBe(false);
      expect(twice.issues, `seed ${seed}`).toEqual([]);
    }
  });

  it('sanitizes a realistic large page quickly', () => {
    const blocks: unknown[] = [];
    for (let index = 0; index < 40; index += 1) {
      blocks.push(
        { type: 'heading', attrs: { level: 2 }, content: [text(`Section ${index}`)] },
        paragraph(text('Some words about the product, '), text('linked', [link(`https://example.com/p/${index}`), { type: 'bold' }]), text(' and more words.')),
        bulletList(listItem(paragraph(text('one'))), listItem(paragraph(text('two')))),
        image({ src: `/images/${index}.png`, alt: 'photo', width: 800, height: 600 }),
        { type: 'storefrontCallout', attrs: { tone: 'tip' }, content: [text('tip')] },
      );
    }
    const input = doc(...blocks);
    const started = performance.now();
    for (let run = 0; run < 5; run += 1) sanitize(input);
    expect((performance.now() - started) / 5).toBeLessThan(250);
  });
});
