// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The variations editor empties its variant list only when the user deselects the last term. A
 * selection that resolves to nothing (the variants' attribute is not in the attribute list) used to
 * empty the list on the first change of the editor's other inputs, and the form saved `variants: []`,
 * which a publish turns into deleting every variant.
 */

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

import type { CurrencyRecord } from '../../../../currency';
import type { ProductAttribute } from '../../../../types';
import { VariationsEditor } from './VariationsEditor';

const ATTR_COLOR = '423e4567-e89b-12d3-a456-426614174001';
const TERM_RED = '323e4567-e89b-12d3-a456-426614174001';
const TERM_BLUE = '323e4567-e89b-12d3-a456-426614174002';
const ATTR_SIZE = '423e4567-e89b-12d3-a456-426614174021';
const TERM_S = '323e4567-e89b-12d3-a456-426614174021';

const USD: CurrencyRecord = { code: 'USD', symbol: '$', exchange_rate: 1, is_default: true, is_active: true };
const CAD: CurrencyRecord = { code: 'CAD', symbol: '$', exchange_rate: 1.4, is_default: false, is_active: true };

const COLOR: ProductAttribute = {
  id: ATTR_COLOR,
  name: 'Color',
  slug: 'color',
  terms: [
    { id: TERM_RED, attribute_id: ATTR_COLOR, value: 'Red', slug: 'red', sort_order: 0 },
    { id: TERM_BLUE, attribute_id: ATTR_COLOR, value: 'Blue', slug: 'blue', sort_order: 1 },
  ],
};
const SIZE: ProductAttribute = {
  id: ATTR_SIZE,
  name: 'Size',
  slug: 'size',
  terms: [{ id: TERM_S, attribute_id: ATTR_SIZE, value: 'S', slug: 's', sort_order: 0 }],
};

/** A variant as the product form holds it (major units). */
function colorVariant(termId: string, value: string, price: number) {
  return {
    id: undefined,
    combination_key: termId,
    sku: `PRO-${value.toUpperCase()}`,
    upc: null,
    price,
    prices: { USD: price },
    sale_price: null,
    sale_prices: {},
    sale_start_at: null,
    sale_end_at: null,
    stock_quantity: 2,
    main_media_id: null,
    main_image_url: null,
    attribute_term_ids: [termId],
    selected_options: [
      { attribute_id: ATTR_COLOR, attribute_name: 'Color', term_id: termId, term_value: value, term_slug: value.toLowerCase() },
    ],
    label: value,
  };
}

type Emission = { variants: unknown[] };

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

async function openEditor(options: {
  globalAttributes: ProductAttribute[];
  variants: ReturnType<typeof colorVariant>[];
}) {
  const onChange = vi.fn<(payload: Emission) => void>();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted = { root, container };

  const render = (props: { currencies: CurrencyRecord[]; baseSku?: string; basePrice?: number }) =>
    root.render(
      <VariationsEditor
        globalAttributes={options.globalAttributes}
        currentLanguageCode="en"
        baseSku={props.baseSku ?? 'PRO'}
        basePrice={props.basePrice ?? 49}
        basePrices={{ USD: props.basePrice ?? 49 }}
        baseSalePrice={null}
        baseSalePrices={{}}
        currencies={props.currencies}
        initialVariationAttributes={[]}
        initialVariants={options.variants as never}
        onChange={onChange as never}
      />
    );

  await act(async () => {
    render({ currencies: [USD] });
  });

  async function rerender(props: { currencies: CurrencyRecord[]; baseSku?: string; basePrice?: number }) {
    await act(async () => {
      render(props);
    });
  }

  return { container, onChange, rerender };
}

function emittedCounts(onChange: ReturnType<typeof vi.fn<(payload: Emission) => void>>) {
  return onChange.mock.calls.map(([payload]) => payload.variants.length);
}

describe('the variations editor keeps a list whose terms resolve to nothing', () => {
  it('when the currencies, the product SKU or its price change', async () => {
    // The variants' Color attribute is not in the attribute list (another attribute is).
    const { onChange, rerender } = await openEditor({
      globalAttributes: [SIZE],
      variants: [colorVariant(TERM_RED, 'Red', 49), colorVariant(TERM_BLUE, 'Blue', 54)],
    });

    await rerender({ currencies: [USD, CAD] });
    await rerender({ currencies: [USD, CAD], baseSku: 'PRO2', basePrice: 59 });

    expect(emittedCounts(onChange)).not.toContain(0);
    expect(emittedCounts(onChange).at(-1)).toBe(2);
  });

  it('and empties a list only when the user deselects its last term', async () => {
    const { container, onChange } = await openEditor({
      globalAttributes: [COLOR],
      variants: [colorVariant(TERM_RED, 'Red', 49)],
    });
    const red = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Red');
    expect(red, 'the Red term button').toBeDefined();

    await act(async () => {
      red?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(emittedCounts(onChange).at(-1)).toBe(0);
  });
});
