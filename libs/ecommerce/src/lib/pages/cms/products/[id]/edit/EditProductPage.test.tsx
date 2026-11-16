// @vitest-environment jsdom
import { act, isValidElement, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The exported EditProductPage (@nextblock-cms/ecommerce/server; the app mounts its own edit page).
 * Its initial data left out the sale window, the SEO fields and the categories. ProductForm defaults
 * those to null or empty, and its autosave sends them, so publishing a draft it saved cleared the live
 * window across the SKU group (0.23.4's form loads the window, so it now sends null bounds), the meta
 * title, description and canonical (persistProductSeoMeta stores '' as NULL) and the categories of
 * the whole translation group (syncCategoriesForTranslationGroup with []).
 */

const mocks = vi.hoisted(() => ({
  getProduct: vi.fn(),
  updateProductAction: vi.fn<(id: string, values: Record<string, unknown>) => Promise<{ success: boolean }>>(
    async () => ({ success: true })
  ),
}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next/image', () => ({
  default: ({ src, alt }: { src: string; alt: string }) => <span role="img" aria-label={alt} data-src={src} />,
}));
vi.mock('../../actions', () => ({
  getProduct: mocks.getProduct,
  getFreemiusPricingByProductId: vi.fn(async () => null),
  getGlobalProductAttributes: vi.fn(async () => [
    {
      id: ATTR_COLOR,
      name: 'Color',
      slug: 'color',
      name_translations: {},
      product_attribute_terms: [
        { id: TERM_RED, attribute_id: ATTR_COLOR, value: 'Red', slug: 'red', sort_order: 0, value_translations: {} },
      ],
    },
  ]),
  triggerSingleProductSync: vi.fn(),
}));
vi.mock('../../server-actions', () => ({
  deleteProductAction: vi.fn(),
  updateProductAction: mocks.updateProductAction,
  createCategoryAction: vi.fn(),
}));
vi.mock('../../../payments/queries', () => ({
  getEnabledPaymentProviders: vi.fn(async () => ({ stripe: true, freemius: true })),
  getStoreConfigStatus: vi.fn(async () => ({
    stripe: { hasKeys: true, missing: [] },
    freemius: { hasKeys: true, missing: [] },
  })),
}));
vi.mock('@nextblock-cms/db/server', () => ({
  getServiceRoleSupabaseClient: () => {
    const currencies = [{ code: 'USD', symbol: '$', exchange_rate: 1, is_default: true, is_active: true }];
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve({ data: currencies, error: null }).then(onFulfilled, onRejected),
    };
    return { from: () => builder };
  },
}));
vi.mock('../../components/FreemiusPricingDashboard', () => ({ FreemiusPricingDashboard: () => null }));
vi.mock('../../components/DeleteProductButton', () => ({ DeleteProductButton: () => null }));

import { ProductForm } from '../../components/ProductForm';
import { EditProductPage } from './EditProductPage';

const PRODUCT_ID = '123e4567-e89b-12d3-a456-426614174000';
const GROUP_ID = '523e4567-e89b-12d3-a456-426614174000';
const CATEGORY_ID = '823e4567-e89b-12d3-a456-426614174000';
const ATTR_COLOR = '423e4567-e89b-12d3-a456-426614174001';
const TERM_RED = '323e4567-e89b-12d3-a456-426614174001';
const VARIANT_RED = '623e4567-e89b-12d3-a456-426614174001';
const START = '2026-11-20T00:00:00+00:00';
const END = '2026-11-30T00:00:00+00:00';

/** getProduct()'s row: `*`, its variants with their attribute mappings, its category assignments. */
function liveProduct() {
  return {
    id: PRODUCT_ID,
    title: 'Pro plugin',
    slug: 'pro-plugin',
    sku: 'PRO',
    upc: null,
    stock: 7,
    price: 4900,
    prices: { USD: 4900 },
    sale_price: 3900,
    sale_prices: { USD: 3900 },
    sale_start_at: START,
    sale_end_at: END,
    is_taxable: true,
    product_type: 'physical',
    payment_provider: 'stripe',
    status: 'active',
    short_description: 'Short copy',
    description_json: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Rich' }] }] },
    meta_title: 'Pro plugin | Store',
    meta_description: 'The pro plugin.',
    custom_canonical: 'https://example.test/pro',
    freemius_plan_id: null,
    freemius_product_id: null,
    trial_period_days: 0,
    trial_requires_payment_method: false,
    language_id: 1,
    translation_group_id: GROUP_ID,
    product_media: [],
    product_categories: [{ category: { id: CATEGORY_ID, name: 'Plugins', slug: 'plugins' } }],
    product_variants: [
      {
        id: VARIANT_RED,
        sku: 'PRO-RED',
        upc: null,
        main_media_id: null,
        price: 4900,
        prices: { USD: 4900 },
        sale_price: 3900,
        sale_prices: { USD: 3900 },
        sale_start_at: null,
        sale_end_at: null,
        scheduled_price: null,
        scheduled_prices: null,
        scheduled_price_at: null,
        stock_quantity: 7,
        media: null,
        variant_attribute_mapping: [
          {
            attribute_term_id: TERM_RED,
            product_attribute_terms: {
              id: TERM_RED,
              attribute_id: ATTR_COLOR,
              value: 'Red',
              slug: 'red',
              sort_order: 0,
              value_translations: {},
              product_attributes: { id: ATTR_COLOR, name: 'Color', slug: 'color', name_translations: {} },
            },
          },
        ],
      },
    ],
  };
}

function findElement(node: ReactNode, matches: (element: ReactElement<any>) => boolean): ReactElement<any> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, matches);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) {
    return null;
  }
  const element = node as ReactElement<any>;
  return matches(element) ? element : findElement(element.props?.children, matches);
}

async function renderEditProductPage() {
  mocks.getProduct.mockResolvedValue(liveProduct());
  const page = await EditProductPage({
    params: Promise.resolve({ id: PRODUCT_ID }),
    availableLanguagesProp: [{ id: 1, name: 'English', code: 'en', is_default: true }],
  });
  const form = findElement(page, (element) => element.type === ProductForm);
  if (!form) throw new Error('EditProductPage rendered no ProductForm');
  return form.props;
}

let mounted: { root: Root; container: HTMLElement } | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (mounted) {
    const { root, container } = mounted;
    act(() => root.unmount());
    container.remove();
    mounted = null;
  }
  mocks.updateProductAction.mockClear();
});

async function mountForm(props: Record<string, unknown>) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted = { root, container };
  await act(async () => {
    root.render(<ProductForm {...(props as any)} />);
  });
  return container;
}

describe('EditProductPage hands ProductForm every column its autosave writes back', () => {
  it('passes the stored sale window, SEO fields and categories as initial data', async () => {
    const props = await renderEditProductPage();

    expect(props.initialData).toMatchObject({
      sale_start_at: START,
      sale_end_at: END,
      meta_title: 'Pro plugin | Store',
      meta_description: 'The pro plugin.',
      custom_canonical: 'https://example.test/pro',
      category_ids: [CATEGORY_ID],
    });
  });

  it('so an autosave after an unrelated edit sends them as they are live', async () => {
    const props = await renderEditProductPage();
    const container = await mountForm(props);

    const title = container.querySelector<HTMLInputElement>('#title');
    expect(title).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(title, 'Pro plugin (edited)');
      title?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // The autosave debounce is 400 ms.
    await act(async () => {
      await vi.waitFor(() => expect(mocks.updateProductAction).toHaveBeenCalledTimes(1), { timeout: 3000, interval: 50 });
    });
    const [productId, values] = mocks.updateProductAction.mock.calls[0];
    expect(productId).toBe(PRODUCT_ID);
    expect(values).toMatchObject({
      title: 'Pro plugin (edited)',
      sale_start_at: START,
      sale_end_at: END,
      meta_title: 'Pro plugin | Store',
      meta_description: 'The pro plugin.',
      custom_canonical: 'https://example.test/pro',
      category_ids: [CATEGORY_ID],
    });
  });

  it('and opening it, for a product with variants, saves nothing', async () => {
    const props = await renderEditProductPage();
    await mountForm(props);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });
    expect(document.getElementById(`variant-sku-${TERM_RED}`)).not.toBeNull();
    expect(mocks.updateProductAction).not.toHaveBeenCalled();
  });
});
