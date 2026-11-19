import { describe, expect, it } from 'vitest';

import {
  applyVariantSelection,
  buildVariantSku,
  findMatchingVariant,
  generateVariantDrafts,
  getAvailableTermIdsForAttribute,
  isReadableVariantOption,
  normalizeSelectionsToAvailableVariants,
  type ProductVariantDraft,
  type VariationSelectionGroup,
} from './variation-utils';
import type { ProductAttribute, ProductVariant, ProductVariantOption } from './types';

const term = (attributeId: string, id: string) => ({ attribute_id: attributeId, id, value: id });

const attributes = [
  { id: 'color', name: 'Color', slug: 'color', terms: [term('color', 'red'), term('color', 'blue')] },
  { id: 'size', name: 'Size', slug: 'size', terms: [term('size', 's'), term('size', 'm')] },
] as unknown as ProductAttribute[];

const variant = (id: string, color: string, size: string) =>
  ({
    attribute_term_ids: [color, size],
    id,
    selected_options: [
      { attribute_id: 'color', term_id: color },
      { attribute_id: 'size', term_id: size },
    ],
    stock_quantity: 5,
  }) as unknown as ProductVariant;

// A sparse matrix: Red/M and Blue/S do not exist.
const variants = [variant('red-s', 'red', 's'), variant('blue-m', 'blue', 'm')];

describe('applyVariantSelection', () => {
  it('lets the shopper reach a combination the other dropdowns currently exclude', () => {
    const next = applyVariantSelection(attributes, variants, { color: 'red', size: 's' }, 'color', 'blue');

    expect(next).toEqual({ color: 'blue', size: 'm' });
    expect(findMatchingVariant(variants, next)?.id).toBe('blue-m');
  });

  it('keeps the other picks when a variant combines them with the new one', () => {
    const full = [...variants, variant('blue-s', 'blue', 's')];

    expect(applyVariantSelection(attributes, full, { color: 'red', size: 's' }, 'color', 'blue')).toEqual({
      color: 'blue',
      size: 's',
    });
  });

  it('produces a selection the normalizer leaves alone (no revert on the next render)', () => {
    const next = applyVariantSelection(attributes, variants, { color: 'red', size: 's' }, 'size', 'm');

    expect(normalizeSelectionsToAvailableVariants(attributes, variants, next)).toEqual(next);
  });
});

describe('getAvailableTermIdsForAttribute', () => {
  it('with no constraints lists every term some variant uses (what the picker may disable against)', () => {
    expect([...getAvailableTermIdsForAttribute(variants, 'color', {})].sort()).toEqual(['blue', 'red']);
  });
});

const RED_OPTION: ProductVariantOption = { attribute_id: 'color', attribute_name: 'Color', term_id: 'red', term_value: 'Red', term_slug: 'red' };

function withoutKey(record: object, key: string) {
  const copy: Record<string, unknown> = { ...record };
  delete copy[key];
  return copy;
}

describe('buildVariantSku', () => {
  it("is the product's SKU plus each option's term slug, or its value slugified", () => {
    expect(buildVariantSku(' TEE ', [RED_OPTION, { ...RED_OPTION, term_slug: undefined, term_value: 'Navy  Blue!' }])).toBe('TEE-RED-NAVY-BLUE');
  });

  // Review 2026-11-18 (round 4): ProductForm fills a loaded variant's empty SKU with this, and a product draft
  // can hold anything (any WRITER can PATCH one): these made ProductForm throw when it mounted in the browser
  // ("Cannot read properties of undefined (reading 'toLowerCase')", "value.toLowerCase is not a function",
  // "….toUpperCase is not a function", "baseSku.trim is not a function"), which lost the edit page for every
  // reader (its client shell renders the form only after mount, and /cms has no error boundary).
  it('reads only text: an option, a slug, a value or a product SKU that is not text adds nothing', () => {
    const unreadable = [{}, { term_value: 5 }, { term_slug: 7 }, { term_slug: {}, term_value: [] }, null, 5, 'x', []] as unknown as ProductVariantOption[];

    expect(buildVariantSku('TEE', [...unreadable, RED_OPTION])).toBe('TEE-RED');
    expect(buildVariantSku(5 as unknown as string, [RED_OPTION])).toBe('RED');
    expect(buildVariantSku(null as unknown as string, unreadable)).toBe('');
    expect(buildVariantSku('TEE', 'x' as unknown as ProductVariantOption[])).toBe('TEE');
  });

  it("falls back to the option's value when its term slug is empty or not text", () => {
    expect(buildVariantSku('TEE', [{ ...RED_OPTION, term_slug: '', term_value: 'Navy  Blue!' }])).toBe('TEE-NAVY-BLUE');
    expect(
      buildVariantSku('TEE', [{ ...RED_OPTION, term_slug: {} as unknown as string, term_value: 'Navy  Blue!' }])
    ).toBe('TEE-NAVY-BLUE');
  });
});

describe('isReadableVariantOption', () => {
  it('takes an object with a text attribute id, attribute name, term id and term value, and a text term slug when it has one', () => {
    expect(isReadableVariantOption(RED_OPTION)).toBe(true);
    expect(isReadableVariantOption(withoutKey(RED_OPTION, 'term_slug'))).toBe(true);

    for (const option of [
      null,
      undefined,
      5,
      'x',
      [],
      Object.assign([], RED_OPTION),
      {},
      { term_value: 5 },
      { ...RED_OPTION, term_value: 5 },
      { ...RED_OPTION, term_slug: null },
      { ...RED_OPTION, term_slug: 7 },
      withoutKey(RED_OPTION, 'attribute_id'),
      withoutKey(RED_OPTION, 'attribute_name'),
      withoutKey(RED_OPTION, 'term_id'),
      withoutKey(RED_OPTION, 'term_value'),
    ]) {
      expect(isReadableVariantOption(option), JSON.stringify(option)).toBe(false);
    }
  });
});

describe('generateVariantDrafts', () => {
  const colors: VariationSelectionGroup[] = [
    {
      attribute_id: 'color',
      attribute_name: 'Color',
      terms: [
        { id: 'red', attribute_id: 'color', value: 'Red', slug: 'red' },
        { id: 'blue', attribute_id: 'color', value: 'Blue', slug: 'blue' },
      ],
    },
  ];

  /** The product form's values (major units), with a sale scheduled for later. */
  const base = {
    baseSku: 'TEE',
    basePrice: 49.99,
    basePrices: { USD: 49.99, CAD: 69.99 },
    baseSalePrice: 39.99,
    baseSalePrices: { USD: 39.99, CAD: 55.99 },
    baseSaleStartAt: '2027-11-27T00:00:00+00:00',
    baseSaleEndAt: '2027-11-30T00:00:00+00:00',
    selectedAttributes: colors,
  };

  /** A stored red variant without a sale of its own. */
  const red: ProductVariantDraft = {
    id: 'variant-red',
    combination_key: 'red',
    sku: 'TEE-RED',
    upc: null,
    price: 54,
    prices: { USD: 54 },
    sale_price: null,
    sale_prices: {},
    sale_start_at: null,
    sale_end_at: null,
    stock_quantity: 3,
    main_media_id: null,
    main_image_url: null,
    attribute_term_ids: ['red'],
    selected_options: [{ attribute_id: 'color', attribute_name: 'Color', term_id: 'red', term_value: 'Red', term_slug: 'red' }],
    label: 'Red',
  };

  const byKey = (drafts: ReturnType<typeof generateVariantDrafts>, key: string) =>
    drafts.find((draft) => draft.combination_key === key);

  it("keeps an existing variant's own sale, none included, and gives only a new combination the product's", () => {
    const drafts = generateVariantDrafts({ ...base, previousVariants: [red] });

    // A stored null read as "unset" gave the red variant the product's sale price with no window:
    // published, it was on sale at once and for good, in every language of its SKU.
    const stored = byKey(drafts, 'red');
    expect(stored).toMatchObject({
      id: 'variant-red',
      sku: 'TEE-RED',
      price: 54,
      sale_price: null,
      sale_start_at: null,
      sale_end_at: null,
      stock_quantity: 3,
    });
    expect(stored?.prices).toEqual({ USD: 54 });
    expect(stored?.sale_prices).toEqual({});

    const added = byKey(drafts, 'blue');
    expect(added).toMatchObject({ id: undefined, sku: 'TEE-BLUE', sale_price: 39.99, stock_quantity: 0 });
    expect(added?.sale_prices).toEqual({ USD: 39.99, CAD: 55.99 });
  });

  it('keeps an existing variant without price maps without the product ones', () => {
    const withoutMaps = { ...red, prices: undefined, sale_prices: undefined } as unknown as ProductVariantDraft;
    const draft = byKey(generateVariantDrafts({ ...base, previousVariants: [withoutMaps] }), 'red');

    expect(draft).toMatchObject({ price: 54, sale_price: null });
    expect(draft?.prices).toEqual({});
    expect(draft?.sale_prices).toEqual({});
  });

  it("prices a new combination at the product's exact amounts", () => {
    // normalizePriceMap (stored minor units) rounded them to whole units: $49.99 became $50.00.
    const added = byKey(generateVariantDrafts(base), 'blue');
    expect(added).toMatchObject({ price: 49.99, sale_price: 39.99 });
    expect(added?.prices).toEqual({ USD: 49.99, CAD: 69.99 });
    expect(added?.sale_prices).toEqual({ USD: 39.99, CAD: 55.99 });

    const withoutSale = byKey(
      generateVariantDrafts({ ...base, baseSalePrice: null, baseSalePrices: { USD: null, CAD: 55.5 } }),
      'blue'
    );
    expect(withoutSale?.sale_price).toBeNull();
    expect(withoutSale?.sale_prices).toEqual({ USD: null, CAD: 55.5 });
  });

  it("gives a new combination the product's sale window, and an existing variant keeps its own", () => {
    const blueOnSale: ProductVariantDraft = {
      ...red,
      id: 'variant-blue',
      combination_key: 'blue',
      sku: 'TEE-BLUE',
      sale_price: 45,
      sale_prices: { USD: 45 },
      sale_start_at: '2026-12-01T00:00:00+00:00',
      sale_end_at: '2026-12-31T00:00:00+00:00',
      attribute_term_ids: ['blue'],
      label: 'Blue',
    };

    // With no window of its own, a new variant's sale ignored the product's schedule (always on).
    expect(byKey(generateVariantDrafts(base), 'red')).toMatchObject({
      sale_start_at: '2027-11-27T00:00:00+00:00',
      sale_end_at: '2027-11-30T00:00:00+00:00',
    });
    const drafts = generateVariantDrafts({ ...base, previousVariants: [red, blueOnSale] });
    expect(byKey(drafts, 'red')).toMatchObject({ sale_start_at: null, sale_end_at: null });
    expect(byKey(drafts, 'blue')).toMatchObject({
      sale_price: 45,
      sale_start_at: '2026-12-01T00:00:00+00:00',
      sale_end_at: '2026-12-31T00:00:00+00:00',
    });
  });

  it('gives a new combination no sale window when it takes no product sale amount', () => {
    // Last year's window, its sale price since cleared: a variant sale set later inside that window
    // would never apply (isSaleWindowActive).
    const withoutSale = {
      ...base,
      baseSalePrice: null,
      baseSalePrices: { USD: null, CAD: null },
      baseSaleStartAt: '2025-11-27T00:00:00+00:00',
      baseSaleEndAt: '2025-11-30T00:00:00+00:00',
    };
    expect(byKey(generateVariantDrafts(withoutSale), 'blue')).toMatchObject({
      sale_price: null,
      sale_start_at: null,
      sale_end_at: null,
    });

    // A sale amount in one currency is a product sale the window belongs to.
    expect(byKey(generateVariantDrafts({ ...withoutSale, baseSalePrices: { CAD: 55.5 } }), 'blue')).toMatchObject({
      sale_start_at: '2025-11-27T00:00:00+00:00',
      sale_end_at: '2025-11-30T00:00:00+00:00',
    });
  });

  it("keeps an existing variant's own SKU, UPC and image when a term is added", () => {
    const custom: ProductVariantDraft = {
      ...red,
      sku: 'TEE-RED-LIMITED',
      upc: '0123456789012',
      main_media_id: 'media-red',
      main_image_url: '/images/products/red.avif',
    };

    expect(byKey(generateVariantDrafts({ ...base, previousVariants: [custom] }), 'red')).toMatchObject({
      sku: 'TEE-RED-LIMITED',
      upc: '0123456789012',
      main_media_id: 'media-red',
      main_image_url: '/images/products/red.avif',
    });
  });
});
