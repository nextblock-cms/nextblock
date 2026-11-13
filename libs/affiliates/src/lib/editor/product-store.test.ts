/* eslint-disable no-script-url -- a javascript: image address is one of the hostile inputs */
import { describe, expect, it, vi } from 'vitest';

import type { StorefrontEditorProduct } from '../storefront/types';
import {
  createStorefrontProductStore,
  normalizeStorefrontEditorProduct,
  storefrontEditorProductImageSrc,
} from './product-store';

const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const product = (n: number): StorefrontEditorProduct => ({ id: uuid(n), title: `Product ${n}`, imageUrl: null, priceLabel: null });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createStorefrontProductStore', () => {
  it('batches lookups, requests each id once and marks missing products unavailable', async () => {
    const resolve = vi.fn(async (ids: string[]) => ids.filter((id) => id !== uuid(2)).map((id) => ({ ...product(1), id })));
    const store = createStorefrontProductStore(() => resolve);
    const listener = vi.fn();
    store.subscribe(listener);

    store.ensure([uuid(1), uuid(2), 'not-an-id']);
    store.ensure([uuid(1).toUpperCase()]);
    expect(store.get(uuid(1))).toBeUndefined();
    await tick();

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith([uuid(1), uuid(2)]);
    expect(store.get(uuid(1))?.id).toBe(uuid(1));
    expect(store.get(uuid(2))).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getVersion()).toBe(1);

    store.ensure([uuid(1), uuid(2)]);
    await tick();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('retries after a failed lookup and accepts primed products', async () => {
    const resolve = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue([product(3)]);
    const store = createStorefrontProductStore(() => resolve);

    store.ensure([uuid(3)]);
    await tick();
    expect(store.get(uuid(3))).toBeUndefined();

    store.ensure([uuid(3)]);
    await tick();
    expect(store.get(uuid(3))?.title).toBe('Product 3');

    store.prime([product(4), { id: 'bad', title: 'x' } as StorefrontEditorProduct]);
    expect(store.get(uuid(4))?.title).toBe('Product 4');
    store.ensure([uuid(4)]);
    await tick();
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('does nothing without a resolver', async () => {
    const store = createStorefrontProductStore(() => undefined);
    store.ensure([uuid(5)]);
    await tick();
    expect(store.get(uuid(5))).toBeUndefined();
  });
});

describe('product display helpers', () => {
  it('keep products in the exact editor shape', () => {
    expect(
      normalizeStorefrontEditorProduct({ id: uuid(1).toUpperCase(), title: 'A', imageUrl: 3, priceLabel: '$1', extra: '<b>' })
    ).toEqual({ id: uuid(1), title: 'A', imageUrl: null, priceLabel: '$1' });
    expect(normalizeStorefrontEditorProduct({ id: 'x', title: 'A' })).toBeNull();
    expect(normalizeStorefrontEditorProduct(null)).toBeNull();
  });

  it('only show http(s) or site-relative product images', () => {
    expect(storefrontEditorProductImageSrc('https://media.example.com/a.jpg')).toBe('https://media.example.com/a.jpg');
    expect(storefrontEditorProductImageSrc('/images/a.jpg')).toBe('/images/a.jpg');
    expect(storefrontEditorProductImageSrc('javascript:alert(1)')).toBeNull();
    expect(storefrontEditorProductImageSrc('mailto:a@example.com')).toBeNull();
    expect(storefrontEditorProductImageSrc('//evil.example/a.jpg')).toBeNull();
    expect(storefrontEditorProductImageSrc(null)).toBeNull();
  });
});
