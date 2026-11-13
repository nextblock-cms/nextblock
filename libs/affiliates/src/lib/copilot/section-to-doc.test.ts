import { describe, expect, it } from 'vitest';

import { sanitizeStorefrontDoc } from '../storefront/sanitize';
import type { StorefrontBlockNode, StorefrontImageAttrs, StorefrontImageCredit } from '../storefront/types';
import type { RetailerSectionBlockInput, RetailerSectionToolInput } from './schemas';
import {
  cleanRetailerCopilotImageQuery,
  collectRetailerCopilotUnsplashDownloads,
  convertRetailerCopilotSection,
  createRetailerCopilotCatalogIndex,
  normalizeRetailerCopilotImageQuery,
  retailerSectionToStorefrontBlocks,
} from './section-to-doc';
import type { RetailerCopilotSectionContext } from './types';

const P1 = '7d3f2a10-1111-4a1b-9c2d-000000000001';
const P2 = '7d3f2a10-1111-4a1b-9c2d-000000000002';
const P3 = '7d3f2a10-1111-4a1b-9c2d-000000000003';
const UNKNOWN = '7d3f2a10-1111-4a1b-9c2d-0000000000ff';
const ORIGINS = ['https://images.unsplash.com', 'https://images.pexels.com'];

const catalog = createRetailerCopilotCatalogIndex([
  { id: P1, title: 'Lavender tea', shortDescription: 'Calming blend', priceLabel: '$12.00' },
  { id: P2.toUpperCase(), title: 'Chamomile tea', shortDescription: null, priceLabel: null },
  { id: P3, title: 'Calendula balm', shortDescription: null, priceLabel: '$18.00' },
  { id: 'not-a-uuid', title: 'Broken', shortDescription: null, priceLabel: null },
]);

const UNSPLASH_CREDIT: StorefrontImageCredit = {
  provider: 'unsplash',
  photographer: 'Jane Doe',
  photographerUrl: 'https://unsplash.com/@janedoe',
  sourceUrl: 'https://unsplash.com/photos/abc123',
  downloadLocation: 'https://api.unsplash.com/photos/abc123/download?ixid=xyz',
  utmSource: 'maple_shop',
};

const UNSPLASH_PHOTO: StorefrontImageAttrs = {
  src: 'https://images.unsplash.com/photo-1544787219-7f47ccb76574?w=1080',
  alt: 'A cup of herbal tea on a wooden table',
  title: null,
  width: 6000,
  height: 4000,
  credit: UNSPLASH_CREDIT,
};

const PEXELS_PHOTO: StorefrontImageAttrs = {
  src: 'https://images.pexels.com/photos/1/pexels-photo-1.jpeg',
  alt: '',
  title: null,
  width: 1200,
  height: 800,
  credit: {
    provider: 'pexels',
    photographer: 'Sam Lee',
    photographerUrl: 'https://www.pexels.com/@sam',
    sourceUrl: 'https://www.pexels.com/photo/1/',
    downloadLocation: null,
    utmSource: null,
  },
};

function block(overrides: Partial<RetailerSectionBlockInput>): RetailerSectionBlockInput {
  return { kind: 'paragraph', text: '', items: [], tone: 'none', image_query: '', product_ids: [], ...overrides };
}

function context(images: Record<string, StorefrontImageAttrs | null> = {}): RetailerCopilotSectionContext {
  return {
    catalog,
    images: new Map(Object.entries(images).map(([query, attrs]) => [normalizeRetailerCopilotImageQuery(query), attrs])),
    allowedImageOrigins: ORIGINS,
  };
}

function expectSanitizerKeeps(blocks: StorefrontBlockNode[]): void {
  const result = sanitizeStorefrontDoc({ type: 'doc', content: blocks }, { allowedImageOrigins: ORIGINS });
  expect(result.issues).toEqual([]);
  expect(result.changed).toBe(false);
  expect(result.doc.content).toEqual(blocks);
}

const SECTION: RetailerSectionToolInput = {
  section_title: 'My **evening** ritual',
  blocks: [
    block({ kind: 'heading', text: 'Why I *love* it' }),
    block({
      kind: 'paragraph',
      text: 'I drink **lavender tea** every night.\nIt helps me unwind.\n\nShop my [favorites](https://shop.example/partners/jane) or [this](javascript:alert(document.cookie)).',
    }),
    block({ kind: 'bullet_list', items: ['**Calm** evenings', '- Better mornings', '  '] }),
    block({ kind: 'callout', text: 'Tip: steep for *5 minutes*.', tone: 'tip' }),
    block({ kind: 'callout', text: 'No tone given', tone: 'none' }),
    block({ kind: 'image', text: 'Tea on a table', image_query: 'Herbal tea  cup' }),
    block({ kind: 'product_grid', text: 'My **favorite** teas', product_ids: [P1, UNKNOWN, P2.toUpperCase(), P1, 'robert"); DROP TABLE'] }),
  ],
};

describe('retailerSectionToStorefrontBlocks', () => {
  it('converts every block kind into the restricted storefront shape', () => {
    const blocks = retailerSectionToStorefrontBlocks(SECTION, context({ 'herbal tea cup': UNSPLASH_PHOTO }));

    expect(blocks).toEqual([
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'My evening ritual' }] },
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Why I love it' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'I drink ' },
          { type: 'text', text: 'lavender tea', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' every night.' },
          { type: 'hardBreak' },
          { type: 'text', text: 'It helps me unwind.' },
        ],
      },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Shop my ' },
          { type: 'text', text: 'favorites', marks: [{ type: 'link', attrs: { href: 'https://shop.example/partners/jane' } }] },
          { type: 'text', text: ' or this.' },
        ],
      },
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Calm', marks: [{ type: 'bold' }] }, { type: 'text', text: ' evenings' }] }],
          },
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Better mornings' }] }] },
        ],
      },
      {
        type: 'storefrontCallout',
        attrs: { tone: 'tip' },
        content: [{ type: 'text', text: 'Tip: steep for ' }, { type: 'text', text: '5 minutes', marks: [{ type: 'italic' }] }, { type: 'text', text: '.' }],
      },
      { type: 'storefrontCallout', attrs: { tone: 'info' }, content: [{ type: 'text', text: 'No tone given' }] },
      {
        type: 'image',
        attrs: {
          src: 'https://images.unsplash.com/photo-1544787219-7f47ccb76574?w=1080',
          alt: 'A cup of herbal tea on a wooden table',
          title: null,
          width: 4000,
          height: 2667,
          credit: UNSPLASH_PHOTO.credit,
        },
      },
      { type: 'affiliateProductGrid', attrs: { productIds: [P1, P2], title: 'My favorite teas', columns: 2 } },
    ]);
  });

  it('produces blocks that pass sanitizeStorefrontDoc unchanged', () => {
    expectSanitizerKeeps(retailerSectionToStorefrontBlocks(SECTION, context({ 'herbal tea cup': UNSPLASH_PHOTO })));
    expectSanitizerKeeps(retailerSectionToStorefrontBlocks(SECTION, context()));
  });

  it('drops javascript: and other unsafe links but keeps their text', () => {
    const blocks = retailerSectionToStorefrontBlocks(
      {
        section_title: 'Links',
        blocks: [
          block({ text: '[a](javascript:alert(1)) [b](data:text/html,x) [c](//evil.example) [d](https://ok.example/d)' }),
        ],
      },
      context()
    );
    const json = JSON.stringify(blocks);
    expect(json).not.toMatch(/javascript:|data:|evil\.example/);
    expect(blocks[1]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: 'a b c ' }, { type: 'text', text: 'd', marks: [{ type: 'link', attrs: { href: 'https://ok.example/d' } }] }],
    });
  });

  it('keeps only catalog products: unknown ids are dropped and an all-unknown grid is skipped', () => {
    const result = convertRetailerCopilotSection(
      {
        section_title: 'Products',
        blocks: [
          block({ kind: 'product_grid', product_ids: [UNKNOWN, 'x'] }),
          block({ kind: 'product_grid', product_ids: [P1, P2, P3, UNKNOWN] }),
        ],
      },
      context()
    );
    expect(result.blocks).toEqual([
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Products' }] },
      { type: 'affiliateProductGrid', attrs: { productIds: [P1, P2, P3], title: null, columns: 3 } },
    ]);
    expect(result.productIds).toEqual([P1, P2, P3]);
    expect(result.droppedProductIds).toBe(3);
    expect(result.skippedBlocks).toBe(1);
  });

  it('skips an image whose lookup found nothing, failed, or points at a host that is not allowed', () => {
    const result = convertRetailerCopilotSection(
      {
        section_title: 'Images',
        blocks: [
          block({ kind: 'image', image_query: 'no result' }),
          block({ kind: 'image', image_query: 'never looked up' }),
          block({ kind: 'image', image_query: 'evil host' }),
          block({ kind: 'image', image_query: 'https://images.unsplash.com/photo-1' }),
          block({ kind: 'paragraph', text: 'Still here.' }),
        ],
      },
      context({
        'no result': null,
        'evil host': { ...PEXELS_PHOTO, src: 'https://evil.example/tracker.png' },
      })
    );
    expect(result.blocks.map((node) => node.type)).toEqual(['heading', 'paragraph']);
    expect(result.imageCount).toBe(0);
    expect(result.skippedImages).toBe(4);
  });

  it('uses the block text as alt text when the provider gave none, and never repeats a photo', () => {
    const result = convertRetailerCopilotSection(
      {
        section_title: 'Photos',
        blocks: [
          block({ kind: 'image', text: 'A **sunny** reading nook', image_query: 'reading nook' }),
          block({ kind: 'image', text: 'Same photo again', image_query: 'Reading  Nook' }),
        ],
      },
      context({ 'reading nook': PEXELS_PHOTO })
    );
    expect(result.blocks[1]).toEqual({ type: 'image', attrs: { ...PEXELS_PHOTO, alt: 'A sunny reading nook' } });
    expect(result.imageCount).toBe(1);
    expect(result.skippedImages).toBe(1);
    expectSanitizerKeeps(result.blocks);
  });

  it('keeps the stock photo credit with its Unsplash download location and utm_source (C13)', () => {
    const blocks = retailerSectionToStorefrontBlocks(
      { section_title: 'Credit', blocks: [block({ kind: 'image', image_query: 'tea' })] },
      context({ tea: UNSPLASH_PHOTO })
    );
    const image = blocks.find((node) => node.type === 'image');
    expect(image?.type === 'image' ? image.attrs.credit : null).toEqual(UNSPLASH_PHOTO.credit);
    expect(collectRetailerCopilotUnsplashDownloads(blocks)).toEqual(['https://api.unsplash.com/photos/abc123/download?ixid=xyz']);
    expect(collectRetailerCopilotUnsplashDownloads([...blocks, ...blocks])).toHaveLength(1);
  });

  it('drops an invalid credit download location instead of the photo', () => {
    const blocks = retailerSectionToStorefrontBlocks(
      { section_title: 'Credit', blocks: [block({ kind: 'image', image_query: 'tea' })] },
      context({
        tea: {
          ...UNSPLASH_PHOTO,
          credit: { ...UNSPLASH_CREDIT, downloadLocation: 'https://evil.example/ping' },
        },
      })
    );
    const image = blocks.find((node) => node.type === 'image');
    expect(image?.type === 'image' ? image.attrs.credit?.downloadLocation : 'missing').toBeNull();
    expect(collectRetailerCopilotUnsplashDownloads(blocks)).toEqual([]);
  });

  it('builds a list from text lines when the items are empty, and skips empty blocks', () => {
    const result = convertRetailerCopilotSection(
      {
        section_title: 'Lists',
        blocks: [
          block({ kind: 'bullet_list', text: '- one\n* two\n1. three\n\n' }),
          block({ kind: 'bullet_list', items: [' ', ''] }),
          block({ kind: 'heading', text: '   ' }),
          block({ kind: 'callout', text: '', items: ['first line', 'second line'], tone: 'highlight' }),
          block({ kind: 'paragraph', text: '' }),
        ],
      },
      context()
    );
    expect(result.blocks).toEqual([
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Lists' }] },
      {
        type: 'bulletList',
        content: ['one', 'two', 'three'].map((text) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })),
      },
      {
        type: 'storefrontCallout',
        attrs: { tone: 'highlight' },
        content: [{ type: 'text', text: 'first line' }, { type: 'hardBreak' }, { type: 'text', text: 'second line' }],
      },
    ]);
    expect(result.skippedBlocks).toBe(3);
  });

  it('picks grid columns from the product count', () => {
    const grid = (ids: string[]) =>
      retailerSectionToStorefrontBlocks({ section_title: 'Grid', blocks: [block({ kind: 'product_grid', product_ids: ids })] }, context())[1];
    expect(grid([P1])).toMatchObject({ attrs: { columns: 2 } });
    expect(grid([P1, P2])).toMatchObject({ attrs: { columns: 2 } });
    expect(grid([P1, P2, P3])).toMatchObject({ attrs: { columns: 3 } });
  });
});

describe('copilot catalog and image query helpers', () => {
  it('indexes uuid-shaped catalog ids in lowercase, first occurrence wins', () => {
    expect([...catalog.keys()]).toEqual([P1, P2, P3]);
    expect(createRetailerCopilotCatalogIndex(null).size).toBe(0);
  });

  it('cleans image queries and refuses URLs', () => {
    expect(cleanRetailerCopilotImageQuery('  Cozy\n reading   nook ')).toBe('Cozy reading nook');
    expect(normalizeRetailerCopilotImageQuery('Cozy Reading Nook')).toBe('cozy reading nook');
    expect(cleanRetailerCopilotImageQuery('https://images.unsplash.com/photo-1')).toBe('');
    expect(cleanRetailerCopilotImageQuery('see www.example.com')).toBe('see www.example.com');
    expect(cleanRetailerCopilotImageQuery('www.example.com/photo')).toBe('');
    expect(cleanRetailerCopilotImageQuery(42)).toBe('');
    expect(cleanRetailerCopilotImageQuery('x'.repeat(300))).toHaveLength(120);
  });
});
