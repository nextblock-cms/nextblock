// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * A product draft's list fields can hold anything: product_drafts RLS checks the role only, so any
 * WRITER can PATCH a draft over PostgREST. The app's edit page hands ProductForm the live variants,
 * attributes and categories for a value that is not a list (as publish keeps them: the app's
 * productFormData.test.ts); anything else that reaches the form loads as an empty list. Until review
 * 2026-11-18 a variant list that was an object, a string or a number threw on mount
 * (`(variants ?? []).filter is not a function`), variation attributes given as a string threw in the
 * variations editor, categories given as an object threw in the category selector, and /cms has no error
 * boundary, so the whole edit page, draft bar included, was lost; variation attributes or categories that
 * were not lists blocked every autosave (productSchema refuses them, and no field shows them).
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
import type { ProductAttribute } from '../../../../types';
import { ProductForm } from './ProductForm';

const ATTR_COLOR = '423e4567-e89b-12d3-a456-426614174001';
const TERM_RED = '323e4567-e89b-12d3-a456-426614174001';
const CATEGORY_ID = '823e4567-e89b-12d3-a456-426614174001';

const USD: CurrencyRecord = { code: 'USD', symbol: '$', exchange_rate: 1, is_default: true, is_active: true };

/** The global attribute list as the edit page passes it: the variations editor draws its rows with it. */
const COLOR_ATTRIBUTES: ProductAttribute[] = [
  {
    id: ATTR_COLOR,
    name: 'Color',
    slug: 'color',
    name_translations: {},
    terms: [{ id: TERM_RED, attribute_id: ATTR_COLOR, value: 'Red', slug: 'red', sort_order: 0, value_translations: {} }],
  },
];

const RED_VARIANT = {
  id: '623e4567-e89b-12d3-a456-426614174001',
  combination_key: TERM_RED,
  sku: 'PRO-RED',
  upc: null,
  price: 49,
  prices: { USD: 49 },
  sale_price: null,
  sale_prices: {},
  sale_start_at: null,
  sale_end_at: null,
  stock_quantity: 4,
  main_media_id: null,
  main_image_url: null,
  attribute_term_ids: [TERM_RED],
  selected_options: [{ attribute_id: ATTR_COLOR, attribute_name: 'Color', term_id: TERM_RED, term_value: 'Red', term_slug: 'red' }],
  label: 'Red',
};

function initialData(changes: Record<string, unknown>) {
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
    ...changes,
  } as any;
}

type UpdateAction = (values: Record<string, unknown>) => Promise<{ success: boolean }>;

describe('ProductForm loads a list field that is not a list as an empty one, and never throws', () => {
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

  /** Renders the form with `changes` over the initial data, beside the global attribute list `attributes`. */
  async function renderForm(changes: Record<string, unknown>, attributes: ProductAttribute[] = COLOR_ATTRIBUTES) {
    const updateAction = vi.fn<UpdateAction>(async () => ({ success: true }));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted = { root, container };

    await act(async () => {
      root.render(
        <ProductForm
          initialData={initialData(changes)}
          isEdit
          availableLanguagesProp={[{ id: 1, name: 'English', code: 'en', is_default: true }]}
          globalAttributesProp={attributes}
          currenciesProp={[USD]}
          enabledProviders={{ stripe: true, freemius: true }}
          configStatus={{ stripe: { hasKeys: true, missing: [] }, freemius: { hasKeys: true, missing: [] } }}
          updateAction={updateAction}
          availableCategoriesProp={[{ id: CATEGORY_ID, name: 'Plugins', slug: 'plugins' }]}
        />
      );
    });

    return { container, updateAction };
  }

  /** Edits the title, which makes the form autosave 400 ms later. */
  async function editTitle(container: HTMLElement) {
    // A render that threw leaves an empty container (no error boundary).
    const title = container.querySelector<HTMLInputElement>('#title');
    expect(title).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(title, 'Pro plugin (edited)');
      title?.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  /** Renders the form, then edits the title: the autosave must run, with lists in every list field. */
  async function renderAndEdit(changes: Record<string, unknown>, attributes: ProductAttribute[] = COLOR_ATTRIBUTES) {
    const { container, updateAction } = await renderForm(changes, attributes);
    await editTitle(container);

    // The autosave debounce is 400 ms; a refused one never reaches updateAction.
    await vi.waitFor(() => expect(updateAction).toHaveBeenCalled(), { timeout: 3000, interval: 50 });
    expect(container.textContent).not.toContain('Error saving settings');
    return { container, values: updateAction.mock.calls[0][0] };
  }

  const NOT_LISTS: Array<[string, unknown]> = [
    ['an object', {}],
    ['a string', 'x'],
    ['a number', 42],
    // Until round 2 a variant list of false, 0 or '' threw on mount here (`(variants ?? []).filter`), and
    // publish read it as no variants, deleting every live variant.
    ['false', false],
    ['0', 0],
    ['an empty string', ''],
  ];

  it.each(NOT_LISTS)('variants that are %s', async (_label, variants) => {
    const { values } = await renderAndEdit({ variants });

    expect(values).toMatchObject({ title: 'Pro plugin (edited)', variants: [] });
  });

  it.each(NOT_LISTS)('variation attributes that are %s, beside variants (the variations editor mounts)', async (_label, variationAttributes) => {
    const { container, values } = await renderAndEdit({ variants: [RED_VARIANT], variation_attributes: variationAttributes });

    expect(container.querySelector(`#variant-stock-${TERM_RED}`)).not.toBeNull();
    expect(Array.isArray(values.variation_attributes)).toBe(true);
    expect(values.variants).toEqual([expect.objectContaining({ sku: 'PRO-RED', stock_quantity: 4 })]);
  });

  it.each(NOT_LISTS)('categories that are %s', async (_label, categoryIds) => {
    const { values } = await renderAndEdit({ category_ids: categoryIds });

    expect(values.category_ids).toEqual([]);
  });

  // Review 2026-11-18: entries the variations editor cannot read, in variation attributes that are a list
  // (the app's merge keeps a draft's own list beside its variants), threw on mount: "Cannot read properties
  // of null (reading 'attribute_id')" for a null entry, ".includes is not a function" for term ids that were
  // an object or a number. The form loads only the entries it can read; the editor still mounts, and the
  // autosave carries lists productSchema accepts.
  it.each([
    ['a null entry', [null], []],
    ['an entry whose term ids are an object', [{ attribute_id: ATTR_COLOR, term_ids: {} }], [{ attribute_id: ATTR_COLOR, term_ids: [] }]],
    ['an entry whose term ids are a number', [{ attribute_id: ATTR_COLOR, term_ids: 5 }], [{ attribute_id: ATTR_COLOR, term_ids: [] }]],
    [
      'entries that are not objects with a text attribute id, and term ids that are not text',
      [42, 'x', { attribute_id: 7, term_ids: [TERM_RED] }, { attribute_id: ATTR_COLOR, term_ids: [TERM_RED, null, 5] }],
      [{ attribute_id: ATTR_COLOR, term_ids: [TERM_RED] }],
    ],
  ])('variation attributes holding %s, beside variants', async (_label, variationAttributes, loaded) => {
    const { container, values } = await renderAndEdit({ variants: [RED_VARIANT], variation_attributes: variationAttributes });

    expect(container.querySelector(`#variant-stock-${TERM_RED}`)).not.toBeNull();
    expect(values.variation_attributes).toEqual(loaded);
    expect(values.variants).toEqual([expect.objectContaining({ sku: 'PRO-RED', stock_quantity: 4 })]);
  });

  // Opening the form must dirty nothing (it autosaves 400 ms after any dirty field): an entry read as one
  // that selects no term beside variants made the variations editor emit a selection of nothing when the
  // panel mounted again, a change no one made, which the autosave saved.
  it('an entry read as selecting no term: hiding and reopening the variations panel saves nothing', async () => {
    const { container, updateAction } = await renderForm({
      variants: [RED_VARIANT],
      variation_attributes: [{ attribute_id: ATTR_COLOR, term_ids: {} }],
    });
    const panelButton = (label: string) => [...container.querySelectorAll('button')].find((button) => button.textContent === label);

    for (const label of ['Hide', 'Manage']) {
      await act(async () => {
        panelButton(label)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    }
    expect(container.querySelector(`#variant-stock-${TERM_RED}`)).not.toBeNull();
    expect(panelButton('Red')?.className).toContain('bg-primary/10');
    // Past the 400 ms debounce.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });

    expect(updateAction).not.toHaveBeenCalled();
  });

  // Found with the above: a variant's own options holding null threw the same way in the editor.
  it("a variant whose own options hold null: the options come from its terms and the attribute list", async () => {
    const { container, values } = await renderAndEdit({ variants: [{ ...RED_VARIANT, selected_options: [null] }] });

    expect(container.querySelector(`#variant-stock-${TERM_RED}`)).not.toBeNull();
    expect(values.variants).toEqual([
      expect.objectContaining({ sku: 'PRO-RED', selected_options: RED_VARIANT.selected_options, label: 'Red' }),
    ]);
  });

  /*
   * Review 2026-11-18 (round 4): of a variant whose term the store no longer has and whose SKU was empty or
   * missing, an option (an object or a list) whose term slug was set but not text (an object, a list, a
   * non-zero number, true), or that had no slug (or a false or 0 one) and a term value that was not text,
   * made the SKU fill throw (buildVariantSku: "Cannot read properties of undefined (reading
   * 'toLowerCase')", "value.toLowerCase is not a function", "….toUpperCase is not a function") when the
   * form mounted in the browser (the edit page's client shell renders it only after mount, and /cms has no
   * error boundary, so the page was lost for every reader); on a term the store has, `{}` opened the
   * variations editor with none of the variant's terms selected, and every option productSchema refuses
   * blocked every autosave. A variant's own options count only when every one is readable
   * (isReadableVariantOption); otherwise they come from its terms and the attribute list, or, when the list
   * knows none of its terms, they are its own readable ones.
   */
  const TERM_GONE = '323e4567-e89b-12d3-a456-4266141740ff';
  const RED_OPTION = RED_VARIANT.selected_options[0];
  /** A variant on a term the store no longer has (no attribute in the list names it), its SKU empty. */
  const GONE_VARIANT = {
    ...RED_VARIANT,
    id: '623e4567-e89b-12d3-a456-4266141740ff',
    combination_key: TERM_GONE,
    sku: '',
    attribute_term_ids: [TERM_GONE],
    label: 'Gone',
  };
  const withoutKey = (record: Record<string, unknown>, key: string) => {
    const copy = { ...record };
    delete copy[key];
    return copy;
  };
  const buttonLabelled = (container: HTMLElement, label: string) =>
    [...container.querySelectorAll('button')].find((button) => button.textContent === label);
  const inputValue = (container: HTMLElement, id: string) => container.querySelector<HTMLInputElement>(`#${id}`)?.value;
  const saveErrorText = (container: HTMLElement) =>
    [...container.querySelectorAll('span')].find((span) => span.textContent?.startsWith('Error saving settings'))?.textContent ??
    null;

  it.each([
    ['{}', [{}], ''],
    ['[]', [[]], ''],
    ['{ term_value: 5 }', [{ term_value: 5 }], ''],
    ['null, a number, a string and {}', [null, 5, 'x', {}], ''],
    ['{} (its SKU missing, not empty)', [{}], undefined],
  ])(
    'a variant on a term the store lacks whose own options hold %s: the form opens, the SKU filled from the product SKU alone, and the autosave names the refusal',
    async (_label, selectedOptions, sku) => {
      const gone = sku === undefined ? withoutKey(GONE_VARIANT, 'sku') : { ...GONE_VARIANT, sku };
      const { container, updateAction } = await renderForm({ variants: [RED_VARIANT, { ...gone, selected_options: selectedOptions }] });

      expect(container.querySelector(`#variant-stock-${TERM_GONE}`)).not.toBeNull();
      expect(inputValue(container, `variant-sku-${TERM_GONE}`)).toBe('PRO');

      // Nothing names the gone term, so productSchema refuses the variant (no options), as it always has.
      await editTitle(container);
      for (let waited = 0; waited < 3000 && saveErrorText(container) === null; waited += 50) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
        });
      }
      expect(saveErrorText(container) ?? '').toMatch(/^Error saving settings: Variant 2 \(Gone\), selected_options: /);
      expect(updateAction).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['{}', [{}]],
    ['[]', [[]]],
    ['{ term_value: 5 }', [{ term_value: 5 }]],
    ['its option with a term value that is not text', [{ ...RED_OPTION, term_value: 5 }]],
    ['its option without its attribute id', [withoutKey(RED_OPTION, 'attribute_id')]],
    ['its option without its term id', [withoutKey(RED_OPTION, 'term_id')]],
    ['its option without its attribute name', [withoutKey(RED_OPTION, 'attribute_name')]],
    ['its option with a term slug that is not text', [{ ...RED_OPTION, term_slug: 7 }]],
    ['a list carrying the fields of its option', [Object.assign([], RED_OPTION)]],
    ['null, a number, a string and {} beside its readable option', [null, 5, 'x', {}, RED_OPTION]],
  ])(
    'a variant on a term the store has whose own options hold %s: the options come from its term, the term shows selected, and the autosave saves',
    async (_label, selectedOptions) => {
      const { container, values } = await renderAndEdit({ variants: [{ ...RED_VARIANT, selected_options: selectedOptions }] });

      expect(buttonLabelled(container, 'Red')?.className).toContain('bg-primary/10');
      expect(values.variants).toEqual([expect.objectContaining({ sku: 'PRO-RED', selected_options: [RED_OPTION], label: 'Red' })]);
    }
  );

  it("a variant on a term the store has whose own options hold {}: opening the form, or the variations panel again, saves nothing", async () => {
    const { container, updateAction } = await renderForm({ variants: [{ ...RED_VARIANT, selected_options: [{}] }] });

    for (const label of ['Hide', 'Manage']) {
      await act(async () => {
        buttonLabelled(container, label)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    }
    expect(buttonLabelled(container, 'Red')?.className).toContain('bg-primary/10');
    // Past the 400 ms debounce.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });

    expect(updateAction).not.toHaveBeenCalled();
  });

  const ATTR_SIZE = '423e4567-e89b-12d3-a456-426614174021';
  const TERM_S = '323e4567-e89b-12d3-a456-426614174021';
  const COLOR_AND_SIZE: ProductAttribute[] = [
    ...COLOR_ATTRIBUTES,
    {
      id: ATTR_SIZE,
      name: 'Size',
      slug: 'size',
      name_translations: {},
      terms: [{ id: TERM_S, attribute_id: ATTR_SIZE, value: 'S', slug: 's', sort_order: 0, value_translations: {} }],
    },
  ];
  const S_OPTION = { attribute_id: ATTR_SIZE, attribute_name: 'Size', term_id: TERM_S, term_value: 'S', term_slug: 's' };
  const RED_S_VARIANT = {
    ...RED_VARIANT,
    combination_key: `${TERM_RED}__${TERM_S}`,
    sku: 'PRO-RED-S',
    attribute_term_ids: [TERM_RED, TERM_S],
    selected_options: [RED_OPTION, S_OPTION],
    label: 'Red / S',
  };

  // Read as its readable options alone, such a variant would lose the other attribute from its options, which
  // the variations editor shows and, beside variation attributes that select nothing, takes its selection from.
  it.each([
    ['null', null],
    ['a number', 5],
    ['a string', 'x'],
  ])(
    'a variant of two attributes whose option for one is %s, beside its readable option for the other: both options come from its terms, and both terms show selected',
    async (_label, unreadable) => {
      const { container, values } = await renderAndEdit(
        { variants: [{ ...RED_S_VARIANT, selected_options: [RED_OPTION, unreadable] }] },
        COLOR_AND_SIZE
      );

      expect(buttonLabelled(container, 'Red')?.className).toContain('bg-primary/10');
      expect(buttonLabelled(container, 'S')?.className).toContain('bg-primary/10');
      expect(values.variants).toEqual([expect.objectContaining({ sku: 'PRO-RED-S', selected_options: [RED_OPTION, S_OPTION] })]);
    }
  );

  it('a variant on a term the store lacks keeps its own readable options, which name its SKU', async () => {
    const goneOption = { attribute_id: ATTR_COLOR, attribute_name: 'Color', term_id: TERM_GONE, term_value: 'Gone', term_slug: 'gone' };
    const { container } = await renderForm({ variants: [RED_VARIANT, { ...GONE_VARIANT, selected_options: [{}, goneOption] }] });

    expect(inputValue(container, `variant-sku-${TERM_GONE}`)).toBe('PRO-GONE');
    expect(container.textContent).toContain('Color: Gone');
  });

  // Kept as it was, a label that is an object threw in the variations editor ("Objects are not valid as a
  // React child"), and a label or a key that is not text blocked every autosave. The app's merge already
  // replaces both; ProductForm reads them as text too. An empty one is rebuilt as well: the app's merge keeps
  // any text label, so a draft variant's `label: ''` reaches the form as it is, and productSchema refuses it.
  it.each([
    ['a label that is an object', { label: {} }],
    ['a label that is a number', { label: 5 }],
    ['an empty label', { label: '' }],
    ['a combination key that is a number', { combination_key: 5 }],
    ['a combination key that is an object', { combination_key: {} }],
    ['an empty combination key', { combination_key: '' }],
  ])('a variant with %s: it comes from the terms, and the autosave saves', async (_label, changes) => {
    const { container, values } = await renderAndEdit({ variants: [{ ...RED_VARIANT, ...changes }] });

    expect(container.querySelector(`#variant-stock-${TERM_RED}`)).not.toBeNull();
    expect(values.variants).toEqual([expect.objectContaining({ combination_key: TERM_RED, sku: 'PRO-RED', label: 'Red' })]);
  });

  // buildVariantSku read the product SKU with `.trim()`: a product SKU that is not text threw while
  // filling a variant's empty SKU.
  it("a product SKU that is not text: a variant's empty SKU is filled from its terms alone", async () => {
    const { container } = await renderForm({ sku: 5, variants: [{ ...RED_VARIANT, sku: '' }] });

    expect(inputValue(container, `variant-sku-${TERM_RED}`)).toBe('RED');
  });
});
