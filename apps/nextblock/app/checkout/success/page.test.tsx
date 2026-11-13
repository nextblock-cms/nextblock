// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The checkout success page finalizes the order, then removes the purchased lines from the cart.
 * The partner-storefront token the cart carried for those lines (NextBlock Affiliates) goes with
 * them: once the order is paid it must not credit the storefront partner with the buyer's next,
 * unrelated cart over a later referral. Lines left for a second provider step keep it.
 */

const mocks = vi.hoisted(() => ({
  t: (key: string) => key,
  fulfillOrderAction: vi.fn(),
  shellProps: [] as Array<Record<string, unknown>>,
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('session_id=cs_test_1'),
}));
vi.mock('@nextblock-cms/utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslations: () => ({ t: mocks.t, lang: 'en' }),
}));
// The real cart store and its hydration hook; the invoice UI is stubbed. Lib modules come in
// through vi.importActual, never import(), so Nx does not see a lazy-loaded lib.
vi.mock('@nextblock-cms/ecommerce', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../../../libs/ecommerce/src/lib/cart-store')),
  ...(await vi.importActual<Record<string, unknown>>('../../../../../libs/ecommerce/src/lib/use-cart')),
  InvoiceViewerShell: (props: Record<string, unknown>) => {
    mocks.shellProps.push(props);
    return null;
  },
  FreemiusLicensePanel: () => null,
  buildInvoiceDocumentLabels: () => ({}),
  getInvoiceLocale: () => 'en-US',
  localizeInvoicePresentationData: (invoice: unknown) => invoice,
  translateOrFallback: (_t: unknown, _key: string, fallback: string) => fallback,
}));
vi.mock('./actions', () => ({ fulfillOrderAction: mocks.fulfillOrderAction }));

import { useCartStore } from '@nextblock-cms/ecommerce';
import CheckoutSuccessPage from './page';

const TOKEN = 'v1.jane-doe.1793102400.0123456789abcdefghijklmnopqrstuvwxyzABCDEFG';
const SOAP_ID = '44444444-4444-4444-8444-444444444444';
const LICENSE_ID = '55555555-5555-4555-8555-555555555555';

const SOAP_LINE = {
  id: SOAP_ID,
  product_id: SOAP_ID,
  title: 'Cedar soap',
  price: 1200,
  sku: 'SOAP-1',
  quantity: 1,
  product_type: 'physical',
  provider: 'stripe',
};
const LICENSE_LINE = {
  id: LICENSE_ID,
  product_id: LICENSE_ID,
  title: 'Pro license',
  price: 9900,
  sku: 'PRO-1',
  quantity: 1,
  product_type: 'digital',
  provider: 'freemius',
};

const mounted: Root[] = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  window.localStorage.clear();
  mocks.shellProps = [];
  mocks.fulfillOrderAction.mockReset();
});

afterEach(async () => {
  for (const root of mounted.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = '';
});

function persistedCart(): Record<string, unknown> {
  const raw = window.localStorage.getItem('cart-storage');
  return raw ? (JSON.parse(raw).state as Record<string, unknown>) : {};
}

/** The paid order's invoice, listing the purchased lines. */
function paidInvoice(...productIds: string[]) {
  return {
    success: true,
    status: 'paid',
    invoice: {
      order: { id: 'order-1', status: 'paid', items: productIds.map((product_id) => ({ product_id, variant_id: null })) },
    },
  };
}

async function renderSuccessPage() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(<CheckoutSuccessPage />);
  });
  // Cart hydration, then the finalize action, then the cart update.
  for (let tick = 0; tick < 5; tick += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('CheckoutSuccessPage and the storefront token', () => {
  it('drops the token with the last purchased line', async () => {
    useCartStore.setState({
      items: [SOAP_LINE as never],
      appliedCoupon: { code: 'SAVE10', couponId: 'c1' } as never,
      affiliateRef: TOKEN,
    });
    mocks.fulfillOrderAction.mockResolvedValue(paidInvoice(SOAP_ID));

    await renderSuccessPage();

    expect(mocks.fulfillOrderAction).toHaveBeenCalledWith('cs_test_1', null);
    expect(useCartStore.getState()).toMatchObject({ items: [], appliedCoupon: null, affiliateRef: null });
    expect(persistedCart()).toEqual({ items: [], appliedCoupon: null, affiliateRef: null });
    expect(mocks.shellProps.at(-1)?.['action']).toMatchObject({ href: '/' });
  });

  it('keeps the token for the lines left for the second provider step of a mixed cart', async () => {
    useCartStore.setState({
      items: [SOAP_LINE as never, LICENSE_LINE as never],
      appliedCoupon: null,
      affiliateRef: TOKEN,
    });
    mocks.fulfillOrderAction.mockResolvedValue(paidInvoice(SOAP_ID));

    await renderSuccessPage();

    expect(useCartStore.getState().items).toEqual([expect.objectContaining({ id: LICENSE_ID })]);
    expect(useCartStore.getState().affiliateRef).toBe(TOKEN);
    expect(persistedCart()['affiliateRef']).toBe(TOKEN);
    expect(mocks.shellProps.at(-1)?.['action']).toMatchObject({ href: '/checkout' });
  });

  it('keeps the cart and its token when the order could not be finalized', async () => {
    useCartStore.setState({ items: [SOAP_LINE as never], appliedCoupon: null, affiliateRef: TOKEN });
    mocks.fulfillOrderAction.mockResolvedValue({ success: false, error: 'Payment not completed yet.' });

    await renderSuccessPage();

    expect(useCartStore.getState().items).toHaveLength(1);
    expect(useCartStore.getState().affiliateRef).toBe(TOKEN);
  });
});
