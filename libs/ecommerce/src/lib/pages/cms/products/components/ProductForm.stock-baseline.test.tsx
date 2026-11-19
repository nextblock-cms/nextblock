// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The stock the edit page loaded (`stock_baseline`, per SKU) rides every autosave unseen, so the draft
 * records what the stock was when the page opened and publishing (publish_product_draft, migration
 * 02044) writes only the quantities changed here: a sale made while the page was open keeps its
 * deduction. Until then the draft held the loaded stock as plain values, and the publish wrote it back
 * over every sale. The form carries the page's baseline as it is, never makes one up (only the page
 * knows whether its data is live or a draft's), and opening it saves nothing.
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

const USD: CurrencyRecord = { code: 'USD', symbol: '$', exchange_rate: 1, is_default: true, is_active: true };

/** The edit page's initial data for a physical product without variants (minor units at the top level). */
function initialData(extra: Record<string, unknown> = {}) {
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
    sale_price: null,
    sale_prices: {},
    sale_start_at: null,
    sale_end_at: null,
    stock: 4,
    status: 'active',
    language_id: 1,
    translation_group_id: '523e4567-e89b-12d3-a456-426614174000',
    product_media: [],
    category_ids: [],
    variants: [],
    variation_attributes: [],
    ...extra,
  } as any;
}

type UpdateAction = (values: Record<string, unknown>) => Promise<{ success: boolean }>;

describe('ProductForm carries the stock the page loaded to every autosave', () => {
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

  async function mount(data: ReturnType<typeof initialData>) {
    const updateAction = vi.fn<UpdateAction>(async () => ({ success: true }));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted = { root, container };

    await act(async () => {
      root.render(
        <ProductForm
          initialData={data}
          isEdit
          availableLanguagesProp={[{ id: 1, name: 'English', code: 'en', is_default: true }]}
          globalAttributesProp={[]}
          currenciesProp={[USD]}
          enabledProviders={{ stripe: true, freemius: true }}
          configStatus={{ stripe: { hasKeys: true, missing: [] }, freemius: { hasKeys: true, missing: [] } }}
          updateAction={updateAction}
        />
      );
    });

    return { container, updateAction };
  }

  async function type(container: HTMLElement, selector: string, value: string) {
    const input = container.querySelector<HTMLInputElement>(selector);
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  /** The values of the first autosave (the debounce is 400 ms). */
  async function firstAutosave(updateAction: ReturnType<typeof vi.fn<UpdateAction>>) {
    await vi.waitFor(() => expect(updateAction).toHaveBeenCalled(), { timeout: 3000, interval: 50 });
    return updateAction.mock.calls[0][0];
  }

  it('sends the baseline with an unrelated edit, the stock as it was loaded beside it', async () => {
    const { container, updateAction } = await mount(initialData({ stock_baseline: { PRO: 4 } }));

    await type(container, '#title', 'Pro plugin (edited)');

    expect(await firstAutosave(updateAction)).toMatchObject({
      title: 'Pro plugin (edited)',
      stock: 4,
      stock_baseline: { PRO: 4 },
    });
  });

  it('keeps the baseline when the editor changes the stock: the draft holds both, and publish applies the difference', async () => {
    const { container, updateAction } = await mount(initialData({ stock_baseline: { PRO: 4 } }));

    await type(container, '#stock', '9');

    expect(await firstAutosave(updateAction)).toMatchObject({ stock: 9, stock_baseline: { PRO: 4 } });
  });

  it('never makes one up: without a baseline from the page, the autosave carries none', async () => {
    const { container, updateAction } = await mount(initialData());

    await type(container, '#title', 'Pro plugin (edited)');

    const values = await firstAutosave(updateAction);
    expect(values.stock_baseline ?? null).toBeNull();
    expect(values.stock_baseline_publish_count ?? null).toBeNull();
  });

  // Migration 02047: the product's publish count when the page loaded the baseline rides along the same
  // way, so a publish can tell a baseline loaded before the product's last publish.
  it('carries the publish count the page loaded the baseline at, unseen, beside the baseline', async () => {
    const { container, updateAction } = await mount(initialData({ stock_baseline: { PRO: 4 }, stock_baseline_publish_count: 3 }));

    await type(container, '#stock', '9');

    expect(await firstAutosave(updateAction)).toMatchObject({ stock: 9, stock_baseline: { PRO: 4 }, stock_baseline_publish_count: 3 });
  });

  it('saves nothing on open: the baseline dirties nothing', async () => {
    const { updateAction } = await mount(initialData({ stock_baseline: { PRO: 4 }, stock_baseline_publish_count: 3 }));

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });

    expect(updateAction).not.toHaveBeenCalled();
  });
});
