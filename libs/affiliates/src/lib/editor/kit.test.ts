/* eslint-disable no-script-url -- javascript: URLs are among the hostile inputs */
import { flattenExtensions, getSchema, type AnyExtension } from '@tiptap/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAffiliatesCopy } from '../i18n/copy-runtime';
import { AFFILIATES_EDITOR_COPY } from '../i18n/copy/editor';
import { emptyStorefrontDoc } from '../storefront/helpers';
import { sanitizeStorefrontDoc } from '../storefront/sanitize';
import { buildStorefrontStarterDoc } from '../storefront/starter';
import {
  STOREFRONT_BLOCK_NODE_TYPES,
  STOREFRONT_INLINE_NODE_TYPES,
  STOREFRONT_MARK_TYPES,
  STOREFRONT_NESTED_NODE_TYPES,
} from '../storefront/types';
import { normalizeStorefrontLinkInput } from './commands';
import { readStorefrontCalloutTone } from './extensions/callout';
import { readStorefrontGridColumns, readStorefrontGridProductIds, readStorefrontGridTitle } from './extensions/product-grid';
import { getStorefrontSlashItems, STOREFRONT_SLASH_ITEM_IDS } from './extensions/slash-items';
import { createStorefrontEditorExtensions, isStorefrontEditorLinkAllowed } from './kit';

const ORIGINS = ['https://images.pexels.com', 'https://media.example.com'];
const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

function kit() {
  return createStorefrontEditorExtensions({ allowedImageOrigins: ORIGINS });
}

function resolved(): AnyExtension[] {
  return flattenExtensions(kit());
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createStorefrontEditorExtensions: schema', () => {
  it('holds exactly the storefront node and mark allowlist', () => {
    const schema = getSchema(kit());
    const expectedNodes = [
      'doc',
      ...STOREFRONT_BLOCK_NODE_TYPES,
      ...STOREFRONT_INLINE_NODE_TYPES,
      ...STOREFRONT_NESTED_NODE_TYPES,
    ].sort();

    expect(Object.keys(schema.nodes).sort()).toEqual(expectedNodes);
    expect(Object.keys(schema.marks).sort()).toEqual([...STOREFRONT_MARK_TYPES].sort());
  });

  it('has no duplicate extension names (one StarterKit, its own link and underline)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    getSchema(kit());
    expect(warn.mock.calls.map((call) => String(call[0]))).not.toEqual(
      expect.arrayContaining([expect.stringContaining('Duplicate extension names')])
    );

    const names = resolved().map((extension) => extension.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((name) => name === 'link')).toHaveLength(1);
    expect(names.filter((name) => name === 'underline')).toHaveLength(1);
    expect(names).not.toContain('code');
    expect(names).not.toContain('codeBlock');
    expect(names).not.toContain('trailingNode');
    expect(names).toEqual(expect.arrayContaining(['undoRedo', 'dropCursor', 'placeholder', 'storefrontSlashCommand']));
  });

  it('narrows quotes and list items to the sanitizer output shape', () => {
    const schema = getSchema(kit());
    expect(schema.nodes['blockquote']?.spec.content).toBe('paragraph+');
    expect(schema.nodes['listItem']?.spec.content).toBe('paragraph (paragraph | bulletList | orderedList)*');
    expect(schema.nodes['image']?.spec.group).toBe('block');
    expect(schema.nodes['image']?.spec.inline).toBeFalsy();
    expect(Object.keys(schema.nodes['image']?.spec.attrs ?? {})).toEqual(
      expect.arrayContaining(['src', 'alt', 'title', 'width', 'height', 'credit'])
    );
  });

  it('parses only level 2 and 3 headings', () => {
    const schema = getSchema(kit());
    const tags = (schema.nodes['heading']?.spec.parseDOM ?? []).map((rule) => ('tag' in rule ? rule.tag : null));
    expect(tags.sort()).toEqual(['h2', 'h3']);
  });

  it('loads the empty document, the starter documents and every sanitized hostile input', () => {
    const schema = getSchema(kit());
    const hostile: unknown[] = [
      null,
      { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'H1' }] }] },
      { type: 'doc', content: [{ type: 'blockquote', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'x' }] }] }] },
      {
        type: 'doc',
        content: [
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [
                  { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
                  { type: 'image', attrs: { src: 'https://images.pexels.com/a.jpg' } },
                  { type: 'affiliateProductGrid', attrs: { productIds: [uuid(1)] } },
                ],
              },
            ],
          },
        ],
      },
      { type: 'doc', content: [{ type: 'affiliateProductGrid', attrs: { productIds: [uuid(1), 'bad', uuid(1)], columns: 9, title: 42 } }] },
      { type: 'doc', content: [{ type: 'storefrontCallout', attrs: { tone: 'evil' }, content: [{ type: 'text', text: 't' }] }] },
      { type: 'doc', content: [{ type: 'script', content: [{ type: 'text', text: 'alert(1)' }] }, { type: 'iframe' }] },
      {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)', class: 'x' } }] }],
          },
        ],
      },
    ];

    const docs = [
      emptyStorefrontDoc(),
      buildStorefrontStarterDoc({ locale: 'en', displayName: 'Jane' }),
      buildStorefrontStarterDoc({ locale: 'fr', displayName: 'Jeanne' }),
      ...hostile.map((input) => sanitizeStorefrontDoc(input, { allowedImageOrigins: ORIGINS }).doc),
    ];
    for (const doc of docs) {
      expect(() => schema.nodeFromJSON(doc).check()).not.toThrow();
    }
  });

  it('refuses stored attributes outside their enums (the editor content check)', () => {
    const schema = getSchema(kit());
    const grid = (attrs: Record<string, unknown>) =>
      schema.nodeFromJSON({ type: 'doc', content: [{ type: 'affiliateProductGrid', attrs }] }).check();

    expect(() => grid({ productIds: [uuid(1)], title: 'Picks', columns: 4 })).not.toThrow();
    expect(() => grid({ productIds: [uuid(1)], columns: 9 })).toThrow(RangeError);
    expect(() => grid({ productIds: ['not-a-uuid'] })).toThrow(RangeError);
    expect(() => grid({ productIds: [uuid(1), uuid(1)] })).toThrow(RangeError);
    expect(() => grid({ productIds: Array.from({ length: 13 }, (_, n) => uuid(n + 1)) })).toThrow(RangeError);
    expect(() => grid({ title: 'x'.repeat(121) })).toThrow(RangeError);
    expect(() =>
      schema
        .nodeFromJSON({ type: 'doc', content: [{ type: 'storefrontCallout', attrs: { tone: 'evil' } }] })
        .check()
    ).toThrow(RangeError);
  });
});

describe('createStorefrontEditorExtensions: links', () => {
  const linkOptions = () => {
    const link = resolved().find((extension) => extension.name === 'link');
    expect(link).toBeDefined();
    return link?.options as {
      openOnClick: boolean;
      autolink: boolean;
      protocols: string[];
      HTMLAttributes: Record<string, unknown>;
      isAllowedUri: (url: string, ctx: { defaultValidate: (url: string) => boolean; protocols: string[]; defaultProtocol: string }) => boolean;
    };
  };

  it('is configured through StarterKit: no click-to-open, autolink, ugc rel', () => {
    const options = linkOptions();
    expect(options.openOnClick).toBe(false);
    expect(options.autolink).toBe(true);
    expect(options.protocols).toEqual(['http', 'https', 'mailto']);
    expect(options.HTMLAttributes['rel']).toBe('nofollow ugc noopener noreferrer');
  });

  it('applies the storefront href allowlist on top of Tiptap’s own check', () => {
    const { isAllowedUri } = linkOptions();
    const ctx = { defaultValidate: () => true, protocols: ['http', 'https', 'mailto'], defaultProtocol: 'https' };

    for (const url of ['https://example.com/a', 'http://example.com', 'mailto:jane@example.com', '/products/candle']) {
      expect(isAllowedUri(url, ctx), url).toBe(true);
    }
    for (const url of [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'java\tscript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'tel:+15555550100',
      '//evil.example',
      'https://user:pass@example.com',
      'ftp://example.com',
    ]) {
      expect(isAllowedUri(url, ctx), url).toBe(false);
    }
    expect(isAllowedUri('https://example.com', { ...ctx, defaultValidate: () => false })).toBe(false);
    expect(isStorefrontEditorLinkAllowed('https://example.com')).toBe(true);
  });

  it('normalizes what partners type into a link address', () => {
    expect(normalizeStorefrontLinkInput('example.com')).toBe('https://example.com/');
    expect(normalizeStorefrontLinkInput(' www.example.com/shop?x=1 ')).toBe('https://www.example.com/shop?x=1');
    expect(normalizeStorefrontLinkInput('jane@example.com')).toBe('mailto:jane@example.com');
    expect(normalizeStorefrontLinkInput('/products/candle')).toBe('/products/candle');
    expect(normalizeStorefrontLinkInput('https://example.com/a b')).toBeNull();
    expect(normalizeStorefrontLinkInput('javascript:alert(1)')).toBeNull();
    expect(normalizeStorefrontLinkInput('localhost:3000')).toBeNull();
    expect(normalizeStorefrontLinkInput('just words')).toBeNull();
    expect(normalizeStorefrontLinkInput('')).toBeNull();
    expect(normalizeStorefrontLinkInput(42)).toBeNull();
  });
});

describe('slash items', () => {
  it('offers every block, Image only when uploads are possible', () => {
    expect(getStorefrontSlashItems().map((item) => item.id)).toEqual(STOREFRONT_SLASH_ITEM_IDS.filter((id) => id !== 'image'));
    expect(getStorefrontSlashItems({ imageUpload: true }).map((item) => item.id)).toEqual([...STOREFRONT_SLASH_ITEM_IDS]);
  });

  it('finds the product grid with /promote, /products and /produits', () => {
    for (const query of ['promote', 'Promote', 'products', 'produits', 'PRODUITS', 'promo']) {
      const [first] = getStorefrontSlashItems({ query });
      expect(first?.id, query).toBe('products');
    }
    expect(getStorefrontSlashItems({ query: 'promote' })[0]?.title).toBe('Promote products');
  });

  it('matches titles in both languages and ignores accents', () => {
    expect(getStorefrontSlashItems({ query: 'titre' }).map((item) => item.id)).toEqual(
      expect.arrayContaining(['heading2', 'heading3'])
    );
    expect(getStorefrontSlashItems({ query: 'encadre' }).map((item) => item.id)).toContain('callout');
    expect(getStorefrontSlashItems({ query: 'séparateur' }).map((item) => item.id)).toContain('divider');
    expect(getStorefrontSlashItems({ query: 'zzz-nothing' })).toEqual([]);
    expect(getStorefrontSlashItems({ query: 'photo' })).toEqual([]);
    expect(getStorefrontSlashItems({ query: 'photo', imageUpload: true }).map((item) => item.id)).toEqual(['image']);
  });

  it('localizes titles and descriptions', () => {
    const french = createAffiliatesCopy({ locale: 'fr', dictionary: AFFILIATES_EDITOR_COPY });
    const [item] = getStorefrontSlashItems({ query: 'promote', translate: french });
    expect(item).toEqual({
      id: 'products',
      title: 'Promouvoir des produits',
      description: 'Présentez des produits de la boutique',
    });
  });
});

describe('attribute readers', () => {
  it('normalize grid attributes to their stored form', () => {
    expect(readStorefrontGridProductIds([uuid(1).toUpperCase(), 'x', uuid(1), uuid(2), 7])).toEqual([uuid(1), uuid(2)]);
    expect(readStorefrontGridProductIds(Array.from({ length: 20 }, (_, n) => uuid(n + 1)))).toHaveLength(12);
    expect(readStorefrontGridProductIds('nope')).toEqual([]);
    expect(readStorefrontGridColumns(2)).toBe(2);
    expect(readStorefrontGridColumns('4')).toBe(4);
    expect(readStorefrontGridColumns(5)).toBe(3);
    expect(readStorefrontGridColumns(null)).toBe(3);
    expect(readStorefrontGridTitle('  ')).toBeNull();
    expect(readStorefrontGridTitle('My\u0000 picks')).toBe('My picks');
    expect(readStorefrontGridTitle('x'.repeat(500))).toHaveLength(120);
    expect(readStorefrontGridTitle(3)).toBeNull();
    expect(readStorefrontCalloutTone('tip')).toBe('tip');
    expect(readStorefrontCalloutTone('evil')).toBe('info');
  });
});
