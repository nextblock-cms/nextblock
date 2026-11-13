// @vitest-environment jsdom
/* eslint-disable no-script-url -- a javascript: image address is one of the hostile inputs */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { StorefrontEditorProduct } from '../storefront/types';
import { STOREFRONT_PRODUCT_SEARCH_DEBOUNCE_MS, StorefrontProductPickerDialog } from './ProductPickerDialog';

const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const product = (n: number, title: string): StorefrontEditorProduct => ({
  id: uuid(n),
  title,
  imageUrl: n % 2 === 0 ? `https://media.example.com/p${n}.jpg` : 'javascript:alert(1)',
  priceLabel: `$${n}.00`,
});
const CATALOG = [product(1, 'Lavender candle'), product(2, 'Cedar soap'), product(3, 'Linen towel')];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let mounted: Array<{ root: Root; container: HTMLElement }> = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const { root, container } of mounted) {
    await act(async () => root.unmount());
    container.remove();
  }
  mounted = [];
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function render(ui: ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(ui);
  });
  return container;
}

async function settle(ms = 20) {
  await act(async () => {
    await sleep(ms);
  });
}

function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function dialog(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!element) throw new Error('dialog not open');
  return element;
}

function checkbox(name: string): HTMLInputElement {
  const label = Array.from(dialog().querySelectorAll('label')).find((element) => element.textContent?.includes(name));
  const input = label?.querySelector('input[type="checkbox"]');
  if (!(input instanceof HTMLInputElement)) throw new Error(`no checkbox for ${name}`);
  return input;
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(dialog().querySelectorAll('button')).find(
    (element) => element.getAttribute('aria-label') === label || element.textContent?.trim() === label
  );
  if (!(found instanceof HTMLButtonElement)) throw new Error(`no button ${label}`);
  return found;
}

describe('StorefrontProductPickerDialog', () => {
  it('searches at once, then debounces typing, and shows safe thumbnails only', async () => {
    const searchProducts = vi.fn(async (query: string) =>
      CATALOG.filter((entry) => entry.title.toLowerCase().includes(query.toLowerCase()))
    );
    await render(<StorefrontProductPickerDialog open onOpenChange={() => undefined} searchProducts={searchProducts} onConfirm={() => undefined} />);
    await settle();

    expect(dialog().textContent).toContain('Choose products');
    expect(searchProducts).toHaveBeenCalledTimes(1);
    expect(searchProducts).toHaveBeenLastCalledWith('');
    expect(dialog().textContent).toContain('3 products found');

    const input = dialog().querySelector<HTMLInputElement>('input[type="search"]');
    expect(input).not.toBeNull();
    expect(document.querySelector(`label[for="${input?.id}"]`)?.textContent).toBe('Search the store');
    await act(async () => {
      typeInto(input as HTMLInputElement, 'c');
      typeInto(input as HTMLInputElement, 'ca');
      typeInto(input as HTMLInputElement, 'cand');
    });
    await settle(STOREFRONT_PRODUCT_SEARCH_DEBOUNCE_MS / 2);
    expect(searchProducts).toHaveBeenCalledTimes(1);
    await settle(STOREFRONT_PRODUCT_SEARCH_DEBOUNCE_MS + 50);
    expect(searchProducts).toHaveBeenCalledTimes(2);
    expect(searchProducts).toHaveBeenLastCalledWith('cand');
    expect(dialog().textContent).toContain('1 product found');

    // A javascript: image address is never rendered; the https one is.
    await act(async () => typeInto(input as HTMLInputElement, ''));
    await settle(STOREFRONT_PRODUCT_SEARCH_DEBOUNCE_MS + 50);
    const sources = Array.from(dialog().querySelectorAll('img')).map((img) => img.getAttribute('src'));
    expect(sources).toEqual(['https://media.example.com/p2.jpg']);
  });

  it('caps the selection, keeps the pick order, reorders and confirms', async () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    await render(
      <StorefrontProductPickerDialog
        open
        onOpenChange={onOpenChange}
        searchProducts={async () => CATALOG}
        onConfirm={onConfirm}
        maxProducts={2}
        initialSelectedIds={[uuid(3).toUpperCase(), 'not-an-id']}
        knownProducts={[CATALOG[2] as StorefrontEditorProduct]}
      />
    );
    await settle();

    expect(dialog().textContent).toContain('Selected (1/2)');
    expect(checkbox('Linen towel').checked).toBe(true);

    await act(async () => checkbox('Lavender candle').click());
    expect(dialog().textContent).toContain('Selected (2/2)');
    expect(dialog().textContent).toContain("You've reached the limit of 2 products for this grid.");
    expect(checkbox('Cedar soap').disabled).toBe(true);
    expect(checkbox('Linen towel').disabled).toBe(false);

    await act(async () => button('Move Lavender candle up').click());
    await act(async () => button('Save selection').click());

    expect(onConfirm).toHaveBeenCalledWith([uuid(1), uuid(3)], [CATALOG[0], CATALOG[2]]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps the page under 24 different products', async () => {
    const others = Array.from({ length: 23 }, (_, n) => uuid(100 + n));
    await render(
      <StorefrontProductPickerDialog
        open
        onOpenChange={() => undefined}
        searchProducts={async () => CATALOG}
        onConfirm={() => undefined}
        otherProductIds={[...others, uuid(2)]}
      />
    );
    await settle();

    // 24 different products are already featured, but Cedar soap is one of them.
    expect(checkbox('Lavender candle').disabled).toBe(true);
    expect(checkbox('Cedar soap').disabled).toBe(false);
    expect(dialog().textContent).toContain('Your page can feature up to 24 different products.');
  });

  it('reports a failed search and retries', async () => {
    const searchProducts = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(CATALOG);
    await render(<StorefrontProductPickerDialog open onOpenChange={() => undefined} searchProducts={searchProducts} onConfirm={() => undefined} />);
    await settle();

    expect(dialog().textContent).toContain("Products couldn't be loaded. Try again.");
    await act(async () => button('Try again').click());
    await settle();
    expect(searchProducts).toHaveBeenCalledTimes(2);
    expect(dialog().textContent).toContain('3 products found');
  });
});
