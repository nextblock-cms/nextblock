import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Storefront product cards (NextBlock Affiliates) pass the storefront token to "Add to cart"
 * and link to the product with the partner's `?ref=` handle; outside a storefront the cards
 * render exactly as before.
 */

const mocks = vi.hoisted(() => ({ addToCartProps: [] as Array<Record<string, unknown>> }));

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
  AddToCartButton: (props: Record<string, unknown>) => {
    mocks.addToCartProps.push(props);
    return null;
  },
}));

import type { Product } from '../types';
import { ProductCard } from './ProductCard';
import { ProductGrid } from './ProductGrid';

const TOKEN = 'v1.jane-doe.1793102400.0123456789abcdefghijklmnopqrstuvwxyzABCDEFG';

function product(slug: string, id: string): Product {
  return {
    id,
    title: slug,
    slug,
    sku: slug.toUpperCase(),
    price: 1200,
    prices: { USD: 1200 },
    stock: 10,
    language_id: 1,
    translation_group_id: `g-${id}`,
    product_type: 'physical',
    payment_provider: 'stripe',
  } as Product;
}

const SOAP = product('cedar-soap', '44444444-4444-4444-8444-444444444444');
const CANDLE = product('lavender-candle', '66666666-6666-4666-8666-666666666666');

function hrefs(html: string) {
  return [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
}

beforeEach(() => {
  mocks.addToCartProps = [];
});

describe('ProductCard on a partner storefront', () => {
  it('links to the product with the referral handle and hands the token to Add to cart', () => {
    const html = renderToStaticMarkup(<ProductCard product={SOAP} affiliateRef={TOKEN} referralHandle="jane-doe" />);

    expect(hrefs(html)).toEqual(['/product/cedar-soap?ref=jane-doe', '/product/cedar-soap?ref=jane-doe']);
    expect(mocks.addToCartProps).toHaveLength(1);
    expect(mocks.addToCartProps[0]).toMatchObject({ affiliateRef: TOKEN, referralHandle: 'jane-doe' });
  });

  it('renders the plain product links outside a storefront', () => {
    const html = renderToStaticMarkup(<ProductCard product={SOAP} />);

    expect(hrefs(html)).toEqual(['/product/cedar-soap', '/product/cedar-soap']);
    expect(mocks.addToCartProps[0]).toMatchObject({ affiliateRef: undefined, referralHandle: undefined });
  });

  it('ignores a handle that is not a partner handle', () => {
    const html = renderToStaticMarkup(<ProductCard product={SOAP} referralHandle={'x" onmouseover="alert(1)'} />);

    expect(hrefs(html)).toEqual(['/product/cedar-soap', '/product/cedar-soap']);
    expect(html).not.toContain('onmouseover');
  });
});

describe('ProductGrid on a partner storefront', () => {
  it('passes the token and the handle to every card', () => {
    const html = renderToStaticMarkup(
      <ProductGrid products={[SOAP, CANDLE]} columns={2} affiliateRef={TOKEN} referralHandle="jane-doe" />
    );

    expect(hrefs(html)).toEqual([
      '/product/cedar-soap?ref=jane-doe',
      '/product/cedar-soap?ref=jane-doe',
      '/product/lavender-candle?ref=jane-doe',
      '/product/lavender-candle?ref=jane-doe',
    ]);
    expect(mocks.addToCartProps.map((props) => [props['affiliateRef'], props['referralHandle']])).toEqual([
      [TOKEN, 'jane-doe'],
      [TOKEN, 'jane-doe'],
    ]);
  });

  it('keeps the first-row images eager', () => {
    const html = renderToStaticMarkup(
      <ProductGrid
        products={[
          { ...SOAP, image_url: 'https://media.example.com/soap.jpg' } as Product,
          { ...CANDLE, image_url: 'https://media.example.com/candle.jpg' } as Product,
        ]}
        columns={2}
      />
    );

    expect(html.match(/loading="eager"/g)).toHaveLength(2);
  });
});
