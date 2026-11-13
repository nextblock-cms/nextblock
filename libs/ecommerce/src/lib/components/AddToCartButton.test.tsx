// @vitest-environment jsdom
import { act, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "Add to cart" on a partner storefront stores the storefront's signed token on the cart (so
 * checkout can attribute the sale without cookies), only when the add succeeds; its product
 * links carry the partner's `?ref=` handle. Elsewhere the button behaves as before.
 */

const mocks = vi.hoisted(() => ({
  canPurchase: true,
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@nextblock-cms/utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslations: () => ({ t: (key: string) => key, lang: 'en' }),
}));
vi.mock('../CurrencyProvider', () => ({
  useCurrency: () => ({ activeCurrencyCode: 'USD', currencies: [] }),
}));
vi.mock('../PaymentReadinessProvider', () => ({ useCanPurchase: () => mocks.canPurchase }));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
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
import { AddToCartButton, normalizeReferralHandle, withReferralParam } from './AddToCartButton';

const TOKEN = 'v1.jane-doe.1793102400.0123456789abcdefghijklmnopqrstuvwxyzABCDEFG';

const SOAP: Product = {
  id: '44444444-4444-4444-8444-444444444444',
  title: 'Cedar soap',
  slug: 'cedar-soap',
  sku: 'SOAP-1',
  price: 1200,
  stock: 10,
  language_id: 1,
  translation_group_id: 'g1',
  product_type: 'physical',
  payment_provider: 'stripe',
} as Product;

let mounted: Array<{ root: Root; container: HTMLElement }> = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.canPurchase = true;
  mocks.toastSuccess.mockClear();
  mocks.toastError.mockClear();
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

async function clickAdd(container: HTMLElement) {
  const button = Array.from(container.querySelectorAll('button')).find((element) =>
    element.textContent?.includes('ecommerce.add_to_cart')
  );
  if (!button) throw new Error('no add-to-cart button');
  await act(async () => {
    button.click();
  });
}

describe('AddToCartButton affiliateRef', () => {
  it('stores the storefront token on the cart when the add succeeds', async () => {
    const container = await render(<AddToCartButton product={SOAP} affiliateRef={TOKEN} referralHandle="jane-doe" />);

    await clickAdd(container);

    expect(useCartStore.getState().items).toHaveLength(1);
    expect(useCartStore.getState().affiliateRef).toBe(TOKEN);
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
  });

  it('keeps an earlier token when a product is added without one', async () => {
    useCartStore.getState().setAffiliateRef(TOKEN);
    const container = await render(<AddToCartButton product={SOAP} />);

    await clickAdd(container);

    expect(useCartStore.getState().items).toHaveLength(1);
    expect(useCartStore.getState().affiliateRef).toBe(TOKEN);
  });

  it('stores nothing when the add fails', async () => {
    const license = {
      ...SOAP,
      id: '55555555-5555-4555-8555-555555555555',
      product_type: 'digital',
      payment_provider: 'freemius',
      freemius_product_id: '28609',
    } as Product;
    useCartStore.setState({ items: [{ ...license, product_id: license.id, quantity: 1, provider: 'freemius' } as never] });
    const container = await render(<AddToCartButton product={license} affiliateRef={TOKEN} />);

    await clickAdd(container);

    expect(useCartStore.getState().affiliateRef).toBeNull();
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
  });

  it('carries the referral handle on its product links', async () => {
    const variants = await render(
      <AddToCartButton product={{ ...SOAP, has_variants: true } as Product} referralHandle="Jane-Doe" />
    );
    mocks.canPurchase = false;
    const contact = await render(<AddToCartButton product={SOAP} referralHandle="jane-doe" />);

    expect(variants.querySelector('a')?.getAttribute('href')).toBe('/product/cedar-soap?ref=jane-doe');
    expect(contact.querySelector('a')?.getAttribute('href')).toBe('/product/cedar-soap?ref=jane-doe#contact-seller');
  });

  it('renders the links unchanged without a valid handle', async () => {
    mocks.canPurchase = false;
    const container = await render(<AddToCartButton product={SOAP} referralHandle="../admin" />);

    expect(container.querySelector('a')?.getAttribute('href')).toBe('/product/cedar-soap#contact-seller');
  });
});

describe('AddToCartButton "Select options" on a partner storefront', () => {
  const TEE = {
    ...SOAP,
    id: '66666666-6666-4666-8666-666666666666',
    title: 'Studio tee',
    slug: 'nextblock-studio-tee',
    sku: 'NB-STUDIO-TEE',
    has_variants: true,
  } as Product;

  async function clickSelectOptions(container: HTMLElement) {
    const link = Array.from(container.querySelectorAll('a')).find((element) =>
      element.textContent?.includes('Select options')
    );
    if (!link) throw new Error('no "Select options" link');
    await act(async () => {
      link.click();
    });
  }

  it('hands the token to the add made on the product page, which has none of its own', async () => {
    const card = await render(<AddToCartButton product={TEE} affiliateRef={TOKEN} referralHandle="jane-doe" />);

    await clickSelectOptions(card);

    // Nothing is stored until something is added.
    expect(useCartStore.getState()).toMatchObject({ pendingAffiliateRef: TOKEN, affiliateRef: null });
    expect(JSON.parse(window.localStorage.getItem('cart-storage') ?? '{}').state).toEqual({
      items: [],
      appliedCoupon: null,
      affiliateRef: null,
    });

    // The product page's button, size M chosen (ProductDetailsLayout passes no affiliateRef).
    const productPage = await render(
      <AddToCartButton product={{ ...TEE, variant_id: '77777777-7777-4777-8777-777777777777', variant_label: 'M' } as Product} />
    );
    await clickAdd(productPage);

    expect(useCartStore.getState().items).toEqual([
      expect.objectContaining({ id: '77777777-7777-4777-8777-777777777777', product_id: TEE.id }),
    ]);
    expect(useCartStore.getState()).toMatchObject({ affiliateRef: TOKEN, pendingAffiliateRef: null });
  });

  it('remembers nothing outside a storefront', async () => {
    const card = await render(<AddToCartButton product={TEE} />);

    await clickSelectOptions(card);

    expect(useCartStore.getState().pendingAffiliateRef).toBeNull();
  });
});

describe('withReferralParam', () => {
  it('adds ref before the fragment and after an existing query', () => {
    expect(withReferralParam('/product/a', 'jane-doe')).toBe('/product/a?ref=jane-doe');
    expect(withReferralParam('/product/a#reviews', 'jane-doe')).toBe('/product/a?ref=jane-doe#reviews');
    expect(withReferralParam('/product/a?variant=2', 'jane-doe')).toBe('/product/a?variant=2&ref=jane-doe');
  });

  it.each([null, undefined, '', 'j', '-jane', 'jane_doe', 'jane doe', 'x'.repeat(33), '"><script>'])(
    'leaves the link alone for %j',
    (handle) => {
      expect(withReferralParam('/product/a', handle as string | null)).toBe('/product/a');
    }
  );

  it('normalizes the handle the way the referral cookie does', () => {
    expect(normalizeReferralHandle('  Jane-Doe ')).toBe('jane-doe');
    expect(normalizeReferralHandle(42)).toBeNull();
  });
});
