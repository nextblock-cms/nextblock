import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CustomBlockDefinition } from '@nextblock-cms/utils';

import { DynamicLayoutEngine } from './DynamicLayoutEngine';

const testimonialDefinition: Pick<
  CustomBlockDefinition,
  'fields' | 'id' | 'layout_schema' | 'name' | 'slug'
> = {
  fields: [
    { key: 'quote', label: 'Quote', required: false, type: 'rich-text' },
    { key: 'author_name', label: 'Author Name', required: false, type: 'text' },
    { key: 'portrait', label: 'Portrait', required: false, type: 'image_r2' },
    {
      display_column: 'full_name',
      key: 'customer',
      label: 'Customer',
      multiple: false,
      required: false,
      table: 'profiles',
      type: 'db_relation',
      value_column: 'id',
    },
  ],
  id: '33333333-3333-4333-8333-333333333333',
  layout_schema: {
    as: 'article',
    children: [
      {
        as: 'div',
        children: [
          {
            as: 'div',
            children: [
              {
                as: 'figure',
                children: [
                  {
                    className: 'h-16 w-16 rounded-full object-cover',
                    field_key: 'portrait',
                    type: 'field_render',
                  },
                ],
                className: 'flex justify-center',
                type: 'container',
              },
              {
                as: 'div',
                children: [
                  {
                    as: 'blockquote',
                    className: 'text-lg font-medium',
                    field_key: 'quote',
                    type: 'field_render',
                  },
                  {
                    as: 'p',
                    className: 'text-sm font-semibold',
                    field_key: 'author_name',
                    type: 'field_render',
                  },
                  {
                    as: 'span',
                    className: 'text-xs text-muted-foreground',
                    field_key: 'customer',
                    type: 'field_render',
                  },
                ],
                className: 'flex flex-col gap-2',
                type: 'container',
              },
            ],
            className: 'grid gap-6 md:grid-cols-[auto_1fr]',
            type: 'container',
          },
        ],
        className: 'mx-auto max-w-3xl rounded-lg border p-6',
        type: 'container',
      },
    ],
    className: 'py-10',
    type: 'container',
  },
  name: 'Nested Testimonial Card',
  slug: 'nested-testimonial-card',
};

describe('DynamicLayoutEngine', () => {
  it('renders an intricately nested layout schema into Tailwind structural markup', () => {
    const html = renderToStaticMarkup(
      <DynamicLayoutEngine
        definition={testimonialDefinition}
        data={{
          author_name: 'Ada Lovelace',
          customer: 'profile-1',
          portrait: {
            alt: 'Ada Lovelace portrait',
            height: 128,
            object_key: 'custom-blocks/testimonials/ada.webp',
            url: '/custom-blocks/testimonials/ada.webp',
            width: 128,
          },
          quote: '<p>Computation belongs in the imagination first.</p>',
          resolved_relations: {
            customer: {
              record: {
                full_name: 'Analytical Engine Society',
                id: 'profile-1',
              },
              table: 'profiles',
              value: 'profile-1',
            },
          },
        }}
      />
    );

    expect(html).toContain('py-10');
    expect(html).toContain('mx-auto max-w-3xl rounded-lg border p-6');
    expect(html).toContain('grid gap-6 md:grid-cols-[auto_1fr]');
    expect(html).toContain('src="/custom-blocks/testimonials/ada.webp"');
    expect(html).toContain('alt="Ada Lovelace portrait"');
    expect(html).toContain('Computation belongs in the imagination first.');
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('Analytical Engine Society');
  });

  it('fails softly on corrupted layout nodes', () => {
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const cyclicNode: any = {
      children: [],
      type: 'container',
    };
    cyclicNode.children.push(cyclicNode);

    const html = renderToStaticMarkup(
      <DynamicLayoutEngine
        fields={testimonialDefinition.fields}
        layoutSchema={cyclicNode}
        maxDepth={8}
        showDiagnostics
      />
    );

    expect(html).toContain('data-dynamic-layout-warning');
    expect(html).toContain('cycle detected');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('warns instead of throwing when a field_render references a missing field', () => {
    const html = renderToStaticMarkup(
      <DynamicLayoutEngine
        fields={testimonialDefinition.fields}
        layoutSchema={{
          field_key: 'missing_field',
          type: 'field_render',
        }}
        showDiagnostics
      />
    );

    expect(html).toContain('data-dynamic-layout-warning');
    expect(html).toContain('Unknown field');
  });

  it('keeps developer warnings away from public visitors', () => {
    const html = renderToStaticMarkup(
      <DynamicLayoutEngine
        fields={testimonialDefinition.fields}
        layoutSchema={{
          field_key: 'missing_field',
          type: 'field_render',
        }}
        showDiagnostics={false}
      />
    );

    expect(html).not.toContain('data-dynamic-layout-warning');
    expect(html).not.toContain('Unknown field');
  });

  it('formats relation prices for the page locale and the currency they are stored in', () => {
    const priceDefinition = {
      fields: [
        {
          display_column: 'price',
          key: 'product',
          label: 'Product',
          multiple: false,
          required: false,
          table: 'products',
          type: 'db_relation',
        },
      ],
    } as unknown as Pick<CustomBlockDefinition, 'fields'>;
    const render = (record: Record<string, unknown>, locale: string, currency?: string) =>
      renderToStaticMarkup(
        <DynamicLayoutEngine
          fields={priceDefinition.fields}
          layoutSchema={{ column: Object.keys(record)[0], field_key: 'product', type: 'field_render' }}
          data={{ resolved_relations: { product: { record } } }}
          locale={locale}
          currency={currency}
        />
      ).replace(/\s/g, ' ');

    // A bare number keeps the old default currency, now with locale-aware separators.
    expect(render({ price: 25000 }, 'en')).toContain('$250.00');
    expect(render({ price: 25000 }, 'fr')).toContain('250,00 $');
    // A currency map used to print its first amount behind a hardcoded "$".
    expect(render({ prices: { EUR: 1999 } }, 'fr')).toContain('19,99 €');
    // The preferred currency wins when the map has it.
    expect(render({ prices: { USD: 1000, CAD: 1350 } }, 'en-CA', 'CAD')).toContain('$13.50');
    // Zero-decimal currencies are not divided by 100.
    expect(render({ prices: { JPY: 1500 } }, 'en')).toContain('¥1,500');
  });
});
