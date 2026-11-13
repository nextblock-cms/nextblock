import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * ProductGrid loads its first row eagerly (the row is usually above the fold) unless the page
 * says otherwise: a page with several grids (a partner storefront) keeps only the first grid's
 * first row eager, so images below the fold do not compete with the first paint.
 */

vi.mock('@nextblock-cms/utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslations: () => ({ t: (key: string) => key, lang: 'en' }),
}));
vi.mock('../CurrencyProvider', () => ({
  useCurrency: () => ({
    activeCurrencyCode: 'USD',
    currencies: [{ code: 'USD', symbol: '$', exchange_rate: 1, is_default: true, is_active: true }],
  }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('./AddToCartButton', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  AddToCartButton: () => null,
}));

import type { Product } from '../types';
import { ProductGrid } from './ProductGrid';

function product(index: number): Product {
  const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  return {
    id,
    title: `Product ${index}`,
    slug: `product-${index}`,
    sku: `SKU-${index}`,
    price: 1200,
    prices: { USD: 1200 },
    stock: 10,
    language_id: 1,
    translation_group_id: `g-${id}`,
    product_type: 'physical',
    payment_provider: 'stripe',
    image_url: `https://media.example.com/product-${index}.jpg`,
  } as Product;
}

const PRODUCTS = [1, 2, 3, 4, 5].map(product);

function loadingAttributes(html: string): string[] {
  return [...html.matchAll(/loading="(eager|lazy)"/g)].map((match) => match[1]);
}

describe('ProductGrid first-row loading', () => {
  it('keeps the first row eager by default (one row = `columns` cards)', () => {
    expect(loadingAttributes(renderToStaticMarkup(<ProductGrid products={PRODUCTS} columns={3} />))).toEqual([
      'eager',
      'eager',
      'eager',
      'lazy',
      'lazy',
    ]);
    expect(loadingAttributes(renderToStaticMarkup(<ProductGrid products={PRODUCTS} columns={2} eagerFirstRow />))).toEqual([
      'eager',
      'eager',
      'lazy',
      'lazy',
      'lazy',
    ]);
  });

  it('loads every image lazily when eagerFirstRow is false', () => {
    expect(
      loadingAttributes(renderToStaticMarkup(<ProductGrid products={PRODUCTS} columns={4} eagerFirstRow={false} />)),
    ).toEqual(['lazy', 'lazy', 'lazy', 'lazy', 'lazy']);
  });
});
