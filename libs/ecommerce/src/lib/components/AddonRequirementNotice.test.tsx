import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The add-on notices (2026-11-19): the Affiliates license needs Commerce Pro, so its product page,
 * the cart and the checkout say so, and the cart and the checkout offer to add Commerce Pro. They
 * inform and never block: a Commerce Pro owner buys the add-on alone.
 */

const mocks = vi.hoisted(() => ({
  addToCartProps: [] as Array<Record<string, unknown>>,
  /** What t() answers for a key: the key itself (unseeded) unless listed here. */
  translations: {} as Record<string, string>,
}));

vi.mock('@nextblock-cms/utils/translations-context', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslations: () => ({
    t: (key: string, params?: Record<string, string>) => {
      const template = mocks.translations[key];
      if (!template) return key;
      return Object.entries(params ?? {}).reduce((text, [name, value]) => text.split(`{${name}}`).join(value), template);
    },
    lang: 'en',
  }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('./AddToCartButton', () => ({
  AddToCartButton: (props: Record<string, unknown>) => {
    mocks.addToCartProps.push(props);
    return <button type="button">{String(props.label)}</button>;
  },
}));

import type { Product } from '../types';
import { CartAddonNotices, ProductAddonNotice, useAddonCheckoutWindowTitle } from './AddonRequirementNotice';

const AFFILIATES = '43273';
const COMMERCE = '24851';

const COMMERCE_PRODUCT = {
  id: 'p-commerce',
  title: 'NextBlock™ Commerce Pro License',
  slug: 'nextblock-commerce-pro-commerce-license',
  price: 25000,
  language_id: 1,
  translation_group_id: 'g-commerce',
  product_type: 'digital',
  payment_provider: 'freemius',
  freemius_product_id: COMMERCE,
} as Product;

const affiliatesLine = { id: 'line-aff', title: 'NextBlock™ Affiliates & Creator Storefronts License', freemius_product_id: AFFILIATES };

beforeEach(() => {
  mocks.addToCartProps = [];
  mocks.translations = {};
});

describe('ProductAddonNotice', () => {
  it('says what the Affiliates license needs, linking to the Commerce Pro product', () => {
    const html = renderToStaticMarkup(<ProductAddonNotice baseProducts={[COMMERCE_PRODUCT]} product={{ freemius_product_id: AFFILIATES }} />);

    expect(html).toContain('role="note"');
    expect(html).toContain('Add-on for NextBlock™ Commerce Pro');
    expect(html).toContain('It needs an active Commerce Pro license on the same site, sold separately.');
    expect(html).toContain('href="/product/nextblock-commerce-pro-commerce-license"');
    expect(html).toContain('View Commerce Pro');
  });

  it('still says it without a link when the page could not load the Commerce Pro product', () => {
    const html = renderToStaticMarkup(<ProductAddonNotice product={{ freemius_product_id: AFFILIATES }} />);
    expect(html).toContain('Add-on for NextBlock™ Commerce Pro');
    expect(html).not.toContain('href=');
  });

  it('renders nothing for any product that is not an add-on', () => {
    for (const id of [COMMERCE, '28609', '99999', null]) {
      expect(renderToStaticMarkup(<ProductAddonNotice baseProducts={[COMMERCE_PRODUCT]} product={{ freemius_product_id: id }} />)).toBe('');
    }
  });

  it('reads the seeded copy (French here) with its placeholders filled in', () => {
    mocks.translations = {
      'ecommerce.addon_for': 'Module complémentaire de {base}',
      'ecommerce.addon_requires_license': 'Il exige une licence {base} active sur le même site, vendue séparément.',
      'ecommerce.addon_view_base': 'Voir {base}',
    };
    const html = renderToStaticMarkup(<ProductAddonNotice baseProducts={[COMMERCE_PRODUCT]} product={{ freemius_product_id: AFFILIATES }} />);
    expect(html).toContain('Module complémentaire de NextBlock™ Commerce Pro');
    expect(html).toContain('Il exige une licence Commerce Pro active');
    expect(html).toContain('Voir Commerce Pro');
  });
});

describe('CartAddonNotices', () => {
  it('names the add-on and offers to add Commerce Pro while it is not in the cart', () => {
    const html = renderToStaticMarkup(<CartAddonNotices baseProducts={[COMMERCE_PRODUCT]} items={[affiliatesLine]} />);

    expect(html).toContain('NextBlock™ Affiliates &amp; Creator Storefronts License is an add-on for NextBlock™ Commerce Pro');
    expect(html).toContain('Already have one? You can carry on.');
    expect(html).toContain('Add Commerce Pro to cart');
    expect(mocks.addToCartProps).toHaveLength(1);
    expect(mocks.addToCartProps[0]).toMatchObject({ label: 'Add Commerce Pro to cart', product: COMMERCE_PRODUCT });
    expect(html).toContain('href="/product/nextblock-commerce-pro-commerce-license"');
  });

  it('goes away once Commerce Pro is in the cart, and shows nothing for a cart without an add-on', () => {
    const commerceLine = { id: 'line-com', title: 'Commerce Pro', freemius_product_id: COMMERCE };
    expect(renderToStaticMarkup(<CartAddonNotices baseProducts={[COMMERCE_PRODUCT]} items={[affiliatesLine, commerceLine]} />)).toBe('');
    expect(renderToStaticMarkup(<CartAddonNotices baseProducts={[COMMERCE_PRODUCT]} items={[commerceLine]} />)).toBe('');
    expect(renderToStaticMarkup(<CartAddonNotices items={[]} />)).toBe('');
  });

  it('informs without an add button when the page could not load the Commerce Pro product', () => {
    const html = renderToStaticMarkup(<CartAddonNotices items={[affiliatesLine]} />);
    expect(html).toContain('is an add-on for NextBlock™ Commerce Pro');
    expect(mocks.addToCartProps).toHaveLength(0);
  });
});

describe('useAddonCheckoutWindowTitle', () => {
  function titleFor(item: { title: string; freemius_product_id?: string | null }) {
    let title: string | null = 'unset';
    function Probe() {
      title = useAddonCheckoutWindowTitle()(item);
      return null;
    }
    renderToStaticMarkup(<Probe />);
    return title;
  }

  it('titles the Freemius window of an add-on license after what it needs, and leaves any other alone', () => {
    expect(titleFor(affiliatesLine)).toBe('NextBlock™ Affiliates & Creator Storefronts License (Commerce Pro add-on)');
    expect(titleFor({ title: 'Commerce Pro', freemius_product_id: COMMERCE })).toBeNull();
    expect(titleFor({ title: 'Mug' })).toBeNull();
  });
});
