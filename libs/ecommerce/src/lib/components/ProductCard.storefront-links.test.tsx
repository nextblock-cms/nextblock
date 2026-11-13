// @vitest-environment jsdom
import { act, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A partner storefront's product cards (NextBlock Affiliates) credit the storefront on every path
 * to a purchase, without cookies: "Add to cart" stores the signed token on the cart, and the
 * card's title, image and "Select options" links hand it to the next add, the one made on the
 * product page. A client-side click on their `?ref=` link sets no referral cookie, so without the
 * hand-off a product with variants, or one opened before it is added, went unattributed.
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
vi.mock('../PaymentReadinessProvider', () => ({ useCanPurchase: () => true }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    onClick,
    ...rest
  }: {
    href: string;
    children: ReactNode;
    onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  }) => (
    <a
      href={href}
      {...rest}
      onClick={(event) => {
        // Like next/link: the caller's onClick runs first, then the client-side navigation
        // (which jsdom cannot do, so it is cancelled here).
        onClick?.(event);
        event.preventDefault();
      }}
    >
      {children}
    </a>
  ),
}));

import { useCartStore } from '../cart-store';
import type { Product } from '../types';
import { AddToCartButton } from './AddToCartButton';
import { ProductCard } from './ProductCard';

const TOKEN = 'v1.studio-nova.1793102400.0123456789abcdefghijklmnopqrstuvwxyzABCDEFG';
const VARIANT_M = '77777777-7777-4777-8777-777777777777';

/** The sandbox demo's storefront products are all sold in sizes. */
const TEE = {
  id: '66666666-6666-4666-8666-666666666666',
  title: 'Studio tee',
  slug: 'nextblock-studio-tee',
  sku: 'NB-STUDIO-TEE',
  price: 3200,
  prices: { USD: 3200 },
  stock: 26,
  language_id: 1,
  translation_group_id: 'g-tee',
  product_type: 'physical',
  payment_provider: 'stripe',
  has_variants: true,
} as Product;
const SOAP = { ...TEE, id: '44444444-4444-4444-8444-444444444444', slug: 'cedar-soap', sku: 'SOAP-1', has_variants: false } as Product;

let mounted: Array<{ root: Root; container: HTMLElement }> = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  window.localStorage.clear();
  useCartStore.setState({ items: [], appliedCoupon: null, affiliateRef: null, pendingAffiliateRef: null, isOpen: false });
});

afterEach(async () => {
  for (const { root, container } of mounted) {
    await act(async () => root.unmount());
    container.remove();
  }
  mounted = [];
});

async function render(ui: ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(ui);
  });
  // The cart hook renders the live button once the persisted store has hydrated.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

async function click(element: Element | null | undefined) {
  if (!(element instanceof HTMLElement)) throw new Error('nothing to click');
  await act(async () => {
    element.click();
  });
}

const imageLink = (card: HTMLElement) => card.querySelector('a[aria-hidden="true"]');
const titleLink = (card: HTMLElement) => card.querySelector('h3')?.closest('a');
const selectOptions = (card: HTMLElement) =>
  Array.from(card.querySelectorAll('a')).find((link) => link.textContent?.includes('Select options'));

/** The product page's "Add to cart" (ProductDetailsLayout passes no affiliateRef), size M chosen. */
async function addOnProductPage(product: Product, variantId: string | null) {
  const page = await render(
    <AddToCartButton product={(variantId ? { ...product, variant_id: variantId, variant_label: 'M' } : product) as Product} />
  );
  const button = Array.from(page.querySelectorAll('button')).find((element) =>
    element.textContent?.includes('ecommerce.add_to_cart')
  );
  await click(button);
}

describe('storefront product card links', () => {
  it.each([
    ['"Select options"', selectOptions],
    ['the title', titleLink],
    ['the image', imageLink],
  ])('%s of a product with variants carries the token to the product-page add', async (_label, link) => {
    const card = await render(<ProductCard product={TEE} affiliateRef={TOKEN} referralHandle="studio-nova" />);

    await click(link(card));
    expect(useCartStore.getState()).toMatchObject({ pendingAffiliateRef: TOKEN, affiliateRef: null });

    await addOnProductPage(TEE, VARIANT_M);

    expect(useCartStore.getState().items).toEqual([expect.objectContaining({ id: VARIANT_M, product_id: TEE.id })]);
    expect(useCartStore.getState()).toMatchObject({ affiliateRef: TOKEN, pendingAffiliateRef: null });
    expect(JSON.parse(window.localStorage.getItem('cart-storage') ?? '{}').state.affiliateRef).toBe(TOKEN);
  });

  it('carries the token when a simple product is opened before it is added', async () => {
    const card = await render(<ProductCard product={SOAP} affiliateRef={TOKEN} referralHandle="studio-nova" />);

    await click(titleLink(card));
    await addOnProductPage(SOAP, null);

    expect(useCartStore.getState()).toMatchObject({ affiliateRef: TOKEN, pendingAffiliateRef: null });
  });

  it('stores nothing when the shopper follows a link but adds nothing', async () => {
    const card = await render(<ProductCard product={TEE} affiliateRef={TOKEN} referralHandle="studio-nova" />);

    await click(titleLink(card));

    expect(useCartStore.getState().affiliateRef).toBeNull();
    expect(JSON.parse(window.localStorage.getItem('cart-storage') ?? '{}').state).toEqual({
      items: [],
      appliedCoupon: null,
      affiliateRef: null,
    });
  });

  it('remembers nothing for a card outside a storefront', async () => {
    const card = await render(<ProductCard product={TEE} />);

    for (const link of Array.from(card.querySelectorAll('a'))) {
      await click(link);
    }
    await addOnProductPage(TEE, VARIANT_M);

    expect(useCartStore.getState()).toMatchObject({ affiliateRef: null, pendingAffiliateRef: null });
  });
});
