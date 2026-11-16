import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * The product page shows the price the cart and checkout charge: a selected variant's own sale
 * price, or none. It fell back to the product's sale price for a variant without an active sale of
 * its own, so the page showed the product's sale with the variant's price struck through while the
 * cart got the variant (sale_price null) and checkout charged its full price.
 */

const mocks = vi.hoisted(() => ({ addToCartProducts: [] as Array<Record<string, any>> }));

vi.mock('@nextblock-cms/utils/translations-context', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslations: () => ({ t: (key: string) => key, lang: 'en' }),
}));
vi.mock('../CurrencyProvider', () => ({
  useCurrency: () => ({
    activeCurrencyCode: 'USD',
    currencies: [{ code: 'USD', symbol: '$', exchange_rate: 1, is_default: true, is_active: true }],
  }),
}));
vi.mock('./ProductGallery', () => ({ ProductGallery: () => null }));
vi.mock('./SubscriptionSelector', () => ({ SubscriptionSelector: () => null }));
vi.mock('./SimpleTiptapRenderer', () => ({ SimpleTiptapRenderer: () => null }));
vi.mock('./ShortDescription', () => ({ ShortDescription: () => null }));
vi.mock('./AddToCartButton', () => ({
  AddToCartButton: ({ product }: { product: Record<string, any> }) => {
    mocks.addToCartProducts.push(product);
    return null;
  },
}));

import { ProductProvider } from '../product-context';
import { mapRawVariantRelations } from '../variation-utils';
import { ProductDetailsLayout } from './ProductDetailsLayout';

const ATTR_COLOR = '423e4567-e89b-12d3-a456-426614174001';
const TERM_RED = '323e4567-e89b-12d3-a456-426614174001';
const TERM_BLUE = '323e4567-e89b-12d3-a456-426614174002';

type Row = Record<string, any>;

function colorMapping(termId: string, value: string, sortOrder: number) {
  return {
    attribute_term_id: termId,
    product_attribute_terms: {
      id: termId,
      attribute_id: ATTR_COLOR,
      value,
      slug: value.toLowerCase(),
      sort_order: sortOrder,
      value_translations: {},
      product_attributes: { id: ATTR_COLOR, name: 'Color', slug: 'color', name_translations: {} },
    },
  };
}

/** A `product_variants` row as the storefront reads it (minor units). */
function variantRow(overrides: Row): Row {
  return {
    upc: null,
    main_media_id: null,
    media: null,
    sale_price: null,
    sale_prices: null,
    sale_start_at: null,
    sale_end_at: null,
    scheduled_price: null,
    scheduled_prices: null,
    scheduled_price_at: null,
    ...overrides,
  };
}

/** A $49 product on sale at $39 with no window (always on), with the given variant rows. */
function productOnSale(variantRows: Row[]) {
  const { attributes, variants } = mapRawVariantRelations(variantRows, 'en');

  return {
    id: 'product-1',
    title: 'Pro plugin',
    slug: 'pro-plugin',
    sku: 'PRO',
    price: 4900,
    prices: { USD: 4900 },
    sale_price: 3900,
    sale_prices: { USD: 3900 },
    sale_start_at: null,
    sale_end_at: null,
    stock: 3,
    language_id: 1,
    translation_group_id: 'group-1',
    product_type: 'physical',
    payment_provider: 'stripe',
    has_variants: variants.length > 0,
    attributes,
    variants,
  } as any;
}

function renderProductPage(product: Row) {
  mocks.addToCartProducts.length = 0;
  const html = renderToStaticMarkup(
    <ProductProvider product={product as any}>
      <ProductDetailsLayout />
    </ProductProvider>
  );

  return {
    shownPrice: /<span class="text-3xl[^"]*">([^<]*)<\/span>/.exec(html)?.[1] ?? null,
    struckPrice: /<span class="[^"]*line-through[^"]*">([^<]*)<\/span>/.exec(html)?.[1] ?? null,
    saleBadge: html.includes('ecommerce.sale_badge'),
    cartProduct: mocks.addToCartProducts.at(-1),
  };
}

describe('the product page price', () => {
  it.each([
    ['without a sale of its own', {}],
    [
      'whose own sale has ended',
      {
        sale_price: 4500,
        sale_prices: { USD: 4500 },
        sale_start_at: '2025-11-27T00:00:00+00:00',
        sale_end_at: '2025-11-30T00:00:00+00:00',
      },
    ],
  ])('shows a selected variant %s at its own price, with no strikethrough, under a product on sale', (_label, sale) => {
    // Blue is the first variant in stock, so the page selects it.
    const page = renderProductPage(
      productOnSale([
        variantRow({
          id: 'variant-blue',
          sku: 'PRO-BLUE',
          price: 5400,
          prices: { USD: 5400 },
          stock_quantity: 3,
          variant_attribute_mapping: [colorMapping(TERM_BLUE, 'Blue', 1)],
          ...sale,
        }),
        variantRow({
          id: 'variant-red',
          sku: 'PRO-RED',
          price: 4900,
          prices: { USD: 4900 },
          sale_price: 3900,
          sale_prices: { USD: 3900 },
          stock_quantity: 0,
          variant_attribute_mapping: [colorMapping(TERM_RED, 'Red', 0)],
        }),
      ])
    );

    expect(page.shownPrice).toBe('$54.00');
    expect(page.struckPrice).toBeNull();
    expect(page.saleBadge).toBe(false);
    // What the cart is given, and checkout charges (sale_price ?? price).
    expect(page.cartProduct).toMatchObject({ sku: 'PRO-BLUE', price: 5400 });
  });

  it("shows a selected variant's own sale with its price struck through", () => {
    const page = renderProductPage(
      productOnSale([
        variantRow({
          id: 'variant-red',
          sku: 'PRO-RED',
          price: 5900,
          prices: { USD: 5900 },
          sale_price: 4500,
          sale_prices: { USD: 4500 },
          stock_quantity: 2,
          variant_attribute_mapping: [colorMapping(TERM_RED, 'Red', 0)],
        }),
      ])
    );

    expect(page.shownPrice).toBe('$45.00');
    expect(page.struckPrice).toBe('$59.00');
    expect(page.saleBadge).toBe(true);
  });

  it("shows the product's sale for a product without variants", () => {
    const page = renderProductPage(productOnSale([]));

    expect(page.shownPrice).toBe('$39.00');
    expect(page.struckPrice).toBe('$49.00');
    expect(page.saleBadge).toBe(true);
  });
});
