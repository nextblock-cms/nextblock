import { describe, expect, it } from 'vitest';

import {
  applyVariantSelection,
  findMatchingVariant,
  getAvailableTermIdsForAttribute,
  normalizeSelectionsToAvailableVariants,
} from './variation-utils';
import type { ProductAttribute, ProductVariant } from './types';

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
