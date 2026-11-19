// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The product editor saves its gallery in the order it shows it. The gallery manager orders the tiles
 * by `sort_order` (the first is MAIN, the product's main image), while the form's value kept the
 * order the rows arrived in, and a save writes that order as `sort_order`. The live gallery comes from
 * an embedded select whose row order Postgres does not promise, so an edit to any other field could
 * autosave another main image, which the next publish made live (the 0.23.4 gallery follow-up).
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

const MAIN = 'a1111111-1111-4111-8111-11111111111a';
const SECOND = 'b2222222-2222-4222-8222-22222222222b';
const THIRD = 'c3333333-3333-4333-8333-33333333333c';

const USD: CurrencyRecord = { code: 'USD', symbol: '$', exchange_rate: 1, is_default: true, is_active: true };

/** The live gallery as getProduct embeds it, its rows in an order other than sort_order. */
const LIVE_GALLERY = [
  { media_id: THIRD, sort_order: 2, media: { file_path: 'uploads/third.webp', object_key: 'uploads/third.webp', alt_text: 'Third' } },
  { media_id: MAIN, sort_order: 0, media: { file_path: 'uploads/main.webp', object_key: 'uploads/main.webp', alt_text: 'Main' } },
  { media_id: SECOND, sort_order: 1, media: { file_path: 'uploads/second.webp', object_key: 'uploads/second.webp', alt_text: 'Second' } },
];

function initialData() {
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
    product_media: LIVE_GALLERY,
    category_ids: [],
    variants: [],
    variation_attributes: [],
  } as any;
}

type UpdateAction = (values: Record<string, unknown>) => Promise<{ success: boolean }>;

describe('ProductForm saves the gallery in the order it shows', () => {
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

  it('autosaves the gallery in sort_order, MAIN first, after an edit to another field', async () => {
    const updateAction = vi.fn<UpdateAction>(async () => ({ success: true }));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted = { root, container };

    await act(async () => {
      root.render(
        <ProductForm
          initialData={initialData()}
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

    // What the editor sees: the tiles in sort_order, MAIN on the first.
    // (resolveMediaUrl puts the media base, or a slash, before each key.)
    const shown = [...container.querySelectorAll<HTMLElement>('[role="img"][data-src*="uploads/"]')].map(
      (tile) => tile.getAttribute('aria-label')
    );
    expect(shown).toEqual(['Main', 'Second', 'Third']);
    const firstTile = container.querySelector('[data-src$="uploads/main.webp"]')?.parentElement;
    expect(firstTile?.textContent).toContain('MAIN');

    const title = container.querySelector<HTMLInputElement>('#title');
    expect(title).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(title, 'Pro plugin (edited)');
      title?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // The autosave debounce is 400 ms.
    await vi.waitFor(() => expect(updateAction).toHaveBeenCalled(), { timeout: 3000, interval: 50 });
    const values = updateAction.mock.calls[0][0];
    expect(values).toMatchObject({ title: 'Pro plugin (edited)' });
    expect(values.product_media).toEqual([{ media_id: MAIN }, { media_id: SECOND }, { media_id: THIRD }]);
  });

  // A hand-written draft's `product_media` can hold anything (product_drafts RLS checks the role only).
  // The edit page hands ProductForm the live gallery for one that is not a list; anything else that
  // reaches the form draws no tile. An object or a string threw on mount (`entries.map is not a
  // function`), and /cms has no error boundary: the whole edit page, draft bar included, was lost.
  it.each([
    ['null', null],
    ['an object', {}],
    ['a string', 'x'],
    ['a number', 42],
  ])('draws no tile and never throws for a gallery that is %s', async (_label, productMedia) => {
    const updateAction = vi.fn<UpdateAction>(async () => ({ success: true }));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted = { root, container };

    await act(async () => {
      root.render(
        <ProductForm
          initialData={{ ...initialData(), product_media: productMedia }}
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

    expect(container.querySelector('#title')).not.toBeNull();
    expect(container.querySelectorAll('[role="img"][data-src*="uploads/"]')).toHaveLength(0);
  });
});
