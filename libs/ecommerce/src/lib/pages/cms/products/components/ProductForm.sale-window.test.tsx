// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The product-level sale window in the product editor. Until 0.23.4 ProductForm left it out of its
 * defaults: the editor showed an empty window whatever the product had, every save sent neither bound
 * (the RPC then cleared the window across the SKU group) or only the one the editor touched, and the
 * 0.23.4 publish, which keeps what a draft does not carry, kept a live bound nobody saw (an end before
 * a new start, which CHECK products_sale_window_valid refuses). The form now loads both bounds, shows
 * them, and every autosave carries the pair it validated.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
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
// Server actions the form's children import; none runs here.
vi.mock('../actions', () => ({ triggerSingleProductSync: vi.fn() }));
vi.mock('../server-actions', () => ({ createCategoryAction: vi.fn() }));

import type { CurrencyRecord } from '../../../../currency';
import { ProductForm } from './ProductForm';

const START = '2026-11-20T00:00:00+00:00';
const END = '2026-11-30T00:00:00+00:00';

const USD: CurrencyRecord = { code: 'USD', symbol: '$', exchange_rate: 1, is_default: true, is_active: true };

/** The edit page's initial data for a physical product (minor units at the top level). */
function initialData(window: { sale_start_at?: string | null; sale_end_at?: string | null }) {
  return {
    id: '123e4567-e89b-12d3-a456-426614174000',
    product_type: 'physical',
    payment_provider: 'stripe',
    title: 'Pro plugin',
    slug: 'pro-plugin',
    sku: 'PRO',
    upc: '0123456789012',
    is_taxable: true,
    price: 4900,
    prices: { USD: 49 },
    sale_price: 3900,
    sale_prices: { USD: 39 },
    stock: 4,
    status: 'active',
    language_id: 1,
    translation_group_id: '523e4567-e89b-12d3-a456-426614174000',
    product_media: [],
    category_ids: [],
    variants: [],
    variation_attributes: [],
    ...window,
  } as any;
}

type UpdateAction = (values: Record<string, unknown>) => Promise<{ success: boolean }>;

function formProps(data: ReturnType<typeof initialData>, updateAction: UpdateAction = vi.fn(async () => ({ success: true }))) {
  return {
    initialData: data,
    isEdit: true,
    availableLanguagesProp: [{ id: 1, name: 'English', code: 'en', is_default: true }],
    globalAttributesProp: [],
    currenciesProp: [USD],
    enabledProviders: { stripe: true, freemius: true },
    configStatus: { stripe: { hasKeys: true, missing: [] }, freemius: { hasKeys: true, missing: [] } },
    updateAction,
  };
}

/** What SaleScheduleFields shows for a stored timestamp: datetime-local, in the viewer's time zone. */
function localInputValue(iso: string) {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function inputValue(html: string, id: string) {
  const tag = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0] ?? '';
  return tag.match(/value="([^"]*)"/)?.[1] ?? null;
}

describe('ProductForm loads the product-level sale window into its defaults', () => {
  it('shows the live window in the editor', () => {
    const html = renderToStaticMarkup(<ProductForm {...formProps(initialData({ sale_start_at: START, sale_end_at: END }))} />);

    expect(inputValue(html, 'product-sale-start-at')).toBe(localInputValue(START));
    expect(inputValue(html, 'product-sale-end-at')).toBe(localInputValue(END));
  });

  it('shows an empty window for a product without one', () => {
    const html = renderToStaticMarkup(<ProductForm {...formProps(initialData({ sale_start_at: null }))} />);

    expect(inputValue(html, 'product-sale-start-at')).toBe('');
    expect(inputValue(html, 'product-sale-end-at')).toBe('');
  });
});

describe('every autosave carries both bounds', () => {
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
  });

  async function editTitleAndAutosave(data: ReturnType<typeof initialData>) {
    const updateAction = vi.fn<UpdateAction>(async () => ({ success: true }));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted = { root, container };

    await act(async () => {
      root.render(<ProductForm {...formProps(data, updateAction)} />);
    });

    const title = container.querySelector<HTMLInputElement>('#title');
    expect(title).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(title, 'Pro plugin (edited)');
      title?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // The autosave debounce is 400 ms.
    await vi.waitFor(() => expect(updateAction).toHaveBeenCalled(), { timeout: 3000, interval: 50 });
    return updateAction.mock.calls[0][0];
  }

  it('sends the live window it loaded when the editor changed something else', async () => {
    const values = await editTitleAndAutosave(initialData({ sale_start_at: START, sale_end_at: END }));

    expect(values).toMatchObject({ title: 'Pro plugin (edited)', sale_start_at: START, sale_end_at: END });
  });

  it('sends both bounds as null for a product without a window', async () => {
    const values = await editTitleAndAutosave(initialData({}));

    expect(values).toHaveProperty('sale_start_at', null);
    expect(values).toHaveProperty('sale_end_at', null);
  });
});
