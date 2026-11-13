import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sanitizeStorefrontDoc, type StorefrontDoc } from '@nextblock-cms/affiliates';

/**
 * `/partners/<handle>`: metadata names NO image (the segment's opengraph-image.tsx is the card,
 * ADDENDUM C5); the page renders only the approved, sanitized snapshot; product grids get the signed
 * storefront token and the referral handle; a mixed-case handle redirects to the canonical one.
 */

const PRODUCT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRODUCT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PRODUCT_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ORIGINS = ['https://media.example.com', 'https://shop.example.com'];

const mocks = vi.hoisted(() => ({
  page: null as unknown,
  ecommerceActive: true,
  affiliatesActive: true,
  grids: [] as Array<Record<string, unknown>>,
  locale: 'en',
  notFound: vi.fn(() => {
    throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
  }),
  permanentRedirect: vi.fn((path: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${path};308;` });
  }),
  loadProducts: vi.fn(),
  consentCookie: null as string | null,
}));

vi.mock('next/navigation', () => ({ notFound: mocks.notFound, permanentRedirect: mocks.permanentRedirect }));
vi.mock('next/headers', () => ({
  headers: async () => ({ get: (name: string) => (name === 'x-nonce' ? 'nonce-123' : null) }),
  cookies: async () => ({
    get: (name: string) => (name === 'nb_consent_preference' && mocks.consentCookie !== null ? { value: mocks.consentCookie } : undefined),
  }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} data-prefetch={String(prefetch)} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@nextblock-cms/db/server', () => ({
  verifyPackageOnline: async (id: string) =>
    id === 'ecommerce' ? mocks.ecommerceActive : id === 'affiliates' ? mocks.affiliatesActive : true,
}));
vi.mock('@nextblock-cms/ecommerce', () => ({
  ProductGrid: (props: Record<string, unknown>) => {
    mocks.grids.push(props);
    const products = props['products'] as Array<{ title: string }>;
    return <div data-grid={String(props['columns'])}>{products.map((product) => product.title).join('|')}</div>;
  },
}));
vi.mock('../../../../components/commerce/PaymentReadinessBoundary', () => ({
  default: ({ children }: { children: ReactNode }) => <div data-readiness="">{children}</div>,
}));
vi.mock('../../../../components/CurrentContentSetter', () => ({ CurrentContentSetter: () => null }));
vi.mock('../../../../lib/affiliates/storefront-products', () => ({ loadAffiliateStorefrontProducts: mocks.loadProducts }));
vi.mock('../../../../lib/affiliates/storefront-token', () => ({
  mintAffiliateStorefrontToken: (handle: string) => `v1.${handle}.1761580800.signature`,
}));
vi.mock('../../../lib/site-settings', () => ({ getSiteSettings: async () => ({ siteTitle: 'Maple Shop', socialImage: null }) }));
vi.mock('../../../../lib/affiliates/server-copy', async () => {
  const runtime = (await vi.importActual('../../../../../../libs/affiliates/src/lib/i18n/copy-runtime')) as {
    createAffiliatesCopy: (options: { locale: string; dictionary: unknown }) => (key: string, values?: unknown) => string;
  };
  return {
    getServerAffiliatesCopy: async ({ locale, dictionary }: { locale?: string; dictionary: unknown }) =>
      runtime.createAffiliatesCopy({ locale: locale ?? mocks.locale, dictionary }),
  };
});
vi.mock('./storefront-loader', () => ({
  loadAffiliateStorefrontPage: async () => mocks.page,
  resolveStorefrontAvatarUrl: (key: string | null) => (key ? `https://media.example.com/${key}` : null),
}));

import AffiliateStorefrontPage, { generateMetadata } from '../[handle]/page';
import { buildAffiliateStorefrontMetadata, truncateStorefrontMetaText } from './storefront-metadata';
import { firstRenderedStorefrontGridIndex, normalizeStorefrontHeadingOutline } from './storefront-products';

const HOSTILE_DOC = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'My kitchen favourites' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Click ' },
        { type: 'text', text: 'here', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] },
        { type: 'text', text: ' for a surprise.' },
      ],
    },
    { type: 'scriptTag', content: [{ type: 'text', text: '<script>alert(2)</script>' }] },
    { type: 'image', attrs: { src: 'https://evil.example/pixel.png', alt: 'tracker' } },
    { type: 'affiliateProductGrid', attrs: { productIds: [PRODUCT_A, PRODUCT_B], title: 'Daily drivers', columns: 2 } },
    { type: 'affiliateProductGrid', attrs: { productIds: [PRODUCT_C], title: null, columns: 3 } },
  ],
};

function product(id: string, title: string) {
  return { id, title, slug: title.toLowerCase().replace(/\s+/g, '-'), translation_group_id: `group-${id}` };
}

function loadedPage(overrides: Partial<Record<string, unknown>> = {}) {
  const doc: StorefrontDoc = sanitizeStorefrontDoc(HOSTILE_DOC, { allowedImageOrigins: ORIGINS }).doc;
  return {
    handle: 'jane-picks',
    storefront: {
      affiliateId: 'aff-1',
      handle: 'jane-picks',
      tier: { name: 'Founding Ambassador', nameTranslations: { fr: 'Ambassadeur fondateur' }, badgeColor: 'amber', isLimitedTimePromo: true },
      profile: {
        display_name: 'Jane <b>Doe</b>',
        bio: 'I test kitchen tools.\nThen I keep the best ones.',
        avatar_object_key: 'affiliates/avatars/jane.png',
        social_links: { instagram: 'https://www.instagram.com/jane', website: 'https://jane.example.org' },
      },
      title: null,
      metaDescription: null,
      content: HOSTILE_DOC,
      featuredProductIds: [PRODUCT_B, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'],
      publishedAt: '2026-10-20T10:00:00.000Z',
      updatedAt: '2026-10-21T10:00:00.000Z',
    },
    doc,
    imageOrigins: ORIGINS,
    siteUrl: 'https://shop.example.com',
    siteOrigin: 'https://shop.example.com',
    siteLocale: mocks.locale,
    ...overrides,
  };
}

function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      keys.push(key);
      collectKeys(entry, keys);
    }
  }
  return keys;
}

beforeEach(() => {
  mocks.locale = 'en';
  mocks.ecommerceActive = true;
  mocks.affiliatesActive = true;
  mocks.page = loadedPage();
  mocks.grids = [];
  mocks.notFound.mockClear();
  mocks.permanentRedirect.mockClear();
  mocks.loadProducts.mockReset();
  mocks.loadProducts.mockResolvedValue(
    new Map([
      [PRODUCT_A, product(PRODUCT_A, 'Chef knife')],
      [PRODUCT_B, product(PRODUCT_B, 'Cutting board')],
      [PRODUCT_C, product(PRODUCT_C, 'Dutch oven')],
      ['dddddddd-dddd-4ddd-8ddd-dddddddddddd', product('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'Spice rack')],
    ]),
  );
});

async function renderPage(handle = 'jane-picks'): Promise<string> {
  const element = await AffiliateStorefrontPage({ params: Promise.resolve({ handle }) });
  return renderToStaticMarkup(element);
}

describe('generateMetadata', () => {
  it('names no Open Graph or Twitter image (the segment card is the only one)', async () => {
    const metadata = await generateMetadata({ params: Promise.resolve({ handle: 'jane-picks' }) });

    expect(collectKeys(metadata)).not.toContain('images');
    expect(metadata.metadataBase).toBeInstanceOf(URL);
    expect(String(metadata.metadataBase)).toBe('https://shop.example.com/');
    expect(metadata.alternates?.canonical).toBe('https://shop.example.com/partners/jane-picks');
    expect(metadata.title).toBe("Jane <b>Doe</b>'s picks");
    expect(metadata.twitter).toEqual({
      card: 'summary_large_image',
      title: "Jane <b>Doe</b>'s picks | Maple Shop",
      description: expect.any(String),
    });
    expect(metadata.openGraph).toMatchObject({ type: 'profile', url: 'https://shop.example.com/partners/jane-picks', username: 'jane-picks' });
  });

  it('uses the approved title and description when there are some', async () => {
    mocks.page = loadedPage({
      storefront: { ...loadedPage().storefront, title: 'Jane cooks', metaDescription: 'The tools in my kitchen.' },
    });
    const metadata = await generateMetadata({ params: Promise.resolve({ handle: 'jane-picks' }) });
    expect(metadata.title).toBe('Jane cooks');
    expect(metadata.description).toBe('The tools in my kitchen.');
  });

  it('keeps a missing storefront out of the index', async () => {
    mocks.page = null;
    const metadata = await generateMetadata({ params: Promise.resolve({ handle: 'nobody-here' }) });
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(collectKeys(metadata)).not.toContain('images');
  });
});

describe('buildAffiliateStorefrontMetadata', () => {
  it('cuts long descriptions at a word with an ellipsis', () => {
    const text = truncateStorefrontMetaText(`${'word '.repeat(60)}end`);
    expect(text.length).toBeLessThanOrEqual(160);
    expect(text.endsWith('…')).toBe(true);
  });

  it('omits metadataBase for an unusable site URL instead of throwing', () => {
    const metadata = buildAffiliateStorefrontMetadata({
      handle: 'jane-picks',
      displayName: 'Jane',
      title: null,
      metaDescription: null,
      doc: { type: 'doc', content: [{ type: 'paragraph' }] },
      t: (key) => key,
      siteUrl: 'not a url',
      siteTitle: 'Shop',
      siteLocale: 'fr',
    });
    expect(metadata.metadataBase).toBeUndefined();
    expect(collectKeys(metadata)).not.toContain('images');
  });
});

describe('AffiliateStorefrontPage', () => {
  beforeEach(() => {
    mocks.consentCookie = null;
  });

  // 2026-10-29 fix review: the token was minted and stored in the cart whatever the visitor chose.
  it('mints no attribution token for a visitor who declined marketing cookies', async () => {
    mocks.consentCookie = JSON.stringify({ analytics: false, marketing: false });
    await renderPage();
    expect(mocks.grids.length).toBeGreaterThan(0);
    for (const grid of mocks.grids) {
      expect(grid['affiliateRef']).toBeNull();
      // The handle stays: product links keep their plain ?ref=, which the proxy also ignores then.
      expect(grid['referralHandle']).toBe('jane-picks');
    }

    mocks.grids.length = 0;
    mocks.consentCookie = JSON.stringify({ analytics: false, marketing: true });
    await renderPage();
    for (const grid of mocks.grids) expect(grid['affiliateRef']).toBe('v1.jane-picks.1761580800.signature');
  });

  it('renders the approved profile as text, with one h1 and the disclosure', async () => {
    const html = await renderPage();

    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain('Jane &lt;b&gt;Doe&lt;/b&gt;');
    expect(html).toContain('earns a commission on purchases made through this page, at no extra cost to you.');
    expect(html).toContain('https://media.example.com/affiliates/avatars/jane.png');
    expect(html).toContain('href="https://www.instagram.com/jane" rel="nofollow ugc noopener noreferrer" target="_blank"');
    expect(html).toContain('(opens in a new tab)');
  });

  it('never renders what the sanitizer removed', async () => {
    const html = await renderPage();
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('evil.example');
    // The partner's h1 became an h2: the display name stays the page's only h1.
    expect(html).toContain('My kitchen favourites</h2>');
  });

  it('hands every grid the signed token, the handle and its own products in order', async () => {
    const html = await renderPage();

    expect(mocks.loadProducts).toHaveBeenCalledWith({
      productIds: [PRODUCT_A, PRODUCT_B, PRODUCT_C, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'],
      locale: 'en',
    });
    expect(mocks.grids.map((grid) => (grid['products'] as Array<{ title: string }>).map((entry) => entry.title))).toEqual([
      ['Chef knife', 'Cutting board'],
      ['Dutch oven'],
      ['Spice rack'],
    ]);
    for (const grid of mocks.grids) {
      expect(grid['affiliateRef']).toBe('v1.jane-picks.1761580800.signature');
      expect(grid['referralHandle']).toBe('jane-picks');
    }
    expect(html).toContain('Daily drivers</h2>');
    // An untitled grid still gets an h2, visually hidden, so the cards' h3 titles never skip a level.
    expect(html).toContain('<h2 class="sr-only">Products</h2>');
    expect(html).toContain('Featured products</h2>');
    expect(html).toContain('data-readiness');
  });

  it("loads only the first rendered grid's first row eagerly", async () => {
    await renderPage();
    // Document grid 1, document grid 2, then the featured products.
    expect(mocks.grids.map((grid) => grid['eagerFirstRow'])).toEqual([true, false, false]);
  });

  it('hands the eager first row to the next grid that renders, else to the featured products', async () => {
    const spiceRack: [string, ReturnType<typeof product>] = [
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      product('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'Spice rack'),
    ];
    // The first document grid has no available product, so it renders nothing.
    mocks.loadProducts.mockResolvedValue(new Map([[PRODUCT_C, product(PRODUCT_C, 'Dutch oven')], spiceRack]));
    await renderPage();
    expect(mocks.grids.map((grid) => [(grid['products'] as Array<{ title: string }>)[0]?.title, grid['eagerFirstRow']])).toEqual([
      ['Dutch oven', true],
      ['Spice rack', false],
    ]);

    // No document grid renders: the featured products are the page's first grid.
    mocks.grids = [];
    mocks.loadProducts.mockResolvedValue(new Map([spiceRack]));
    await renderPage();
    expect(mocks.grids.map((grid) => grid['eagerFirstRow'])).toEqual([true]);
  });

  // Affiliates is a Commerce Pro add-on (2026-10-29): with the shop off the program is dormant and
  // every storefront is a plain 404, never a page whose products can never be bought.
  it('404s while the shop package is off, without loading products or minting a token', async () => {
    mocks.ecommerceActive = false;
    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mocks.loadProducts).not.toHaveBeenCalled();
    expect(mocks.grids).toEqual([]);
  });

  it('publishes ProfilePage structured data with the CSP nonce', async () => {
    const html = await renderPage();
    const match = /<script type="application\/ld\+json" nonce="nonce-123">([\s\S]*?)<\/script>/.exec(html);
    expect(match).not.toBeNull();
    const data = JSON.parse(match?.[1] ?? '{}') as Record<string, unknown>;
    expect(data['@type']).toBe('ProfilePage');
    expect(data['mainEntity']).toMatchObject({
      '@type': 'Person',
      name: 'Jane <b>Doe</b>',
      alternateName: 'jane-picks',
      image: 'https://media.example.com/affiliates/avatars/jane.png',
      sameAs: ['https://www.instagram.com/jane', 'https://jane.example.org'],
    });
    // `<` is escaped inside the script so the payload can never close the element.
    expect(match?.[1]).not.toContain('<b>');
  });

  it('localizes the chrome for a French visitor', async () => {
    mocks.locale = 'fr';
    mocks.page = loadedPage({ siteLocale: 'fr' });
    const html = await renderPage();
    expect(html).toContain('touche une commission sur les achats faits à partir de cette page');
    expect(html).toContain('Ambassadeur fondateur');
    expect(html).toContain('Produits en vedette</h2>');
    expect(html).not.toContain('Featured products');
  });

  it('redirects a mixed-case handle to the canonical address and 404s an unknown one', async () => {
    await expect(renderPage('Jane-Picks')).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.permanentRedirect).toHaveBeenCalledWith('/partners/jane-picks');

    mocks.page = null;
    await expect(renderPage('nobody-here')).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('answers a plain 404 for every storefront address while the package is off, never a redirect first', async () => {
    mocks.affiliatesActive = false;
    await expect(renderPage('Jane-Picks')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mocks.permanentRedirect).not.toHaveBeenCalled();
    await expect(renderPage('jane-picks')).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('links the join call to the landing address of the visitor language', async () => {
    expect(await renderPage()).toContain('href="/partners" data-prefetch="false"');
    mocks.locale = 'fr';
    mocks.page = loadedPage({ siteLocale: 'fr' });
    expect(await renderPage()).toContain('href="/partenaires" data-prefetch="false"');
  });
});

describe('storefront content language', () => {
  function frenchPartner(overrides: Partial<Record<string, unknown>> = {}) {
    const base = loadedPage();
    return loadedPage({ storefront: { ...base.storefront, profile: { ...base.storefront.profile, locale: 'fr' } }, ...overrides });
  }

  function jsonLdOf(html: string): Record<string, unknown> {
    return JSON.parse(/<script type="application\/ld\+json" nonce="nonce-123">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '{}');
  }

  it("marks a French partner's text for an English visitor, and the shop's products with the visitor's language", async () => {
    mocks.page = frenchPartner();
    const html = await renderPage();

    expect(html).toContain('<p lang="fr" class="mt-4 max-w-3xl whitespace-pre-line');
    expect(html).toMatch(/<div lang="fr"><div[^>]*><h2[^>]*>My kitchen favourites<\/h2>/);
    // Inside the partner's document, each grid's product cards are the visitor's (English) catalog.
    expect(html).toContain('<div lang="en"><div data-grid="2">Chef knife|Cutting board</div></div>');
    expect(html).toContain('<h2 lang="en" class="sr-only">Products</h2>');
    // The featured products sit outside the partner's document: they follow the page.
    expect(html).toContain('<div data-grid="3">Spice rack</div>');
    expect(html).not.toContain('<div lang="en"><div data-grid="3">Spice rack');
    expect(jsonLdOf(html)['inLanguage']).toBe('fr');

    const metadata = await generateMetadata({ params: Promise.resolve({ handle: 'jane-picks' }) });
    expect(metadata.openGraph).toMatchObject({ locale: 'fr_FR' });
  });

  it('adds no language marks when the partner writes in the visitor language', async () => {
    mocks.locale = 'fr';
    mocks.page = frenchPartner({ siteLocale: 'fr' });
    const html = await renderPage();
    expect(html).not.toContain(' lang="');
    expect(jsonLdOf(html)['inLanguage']).toBe('fr');
  });

  it('keeps the visitor language everywhere for a snapshot without a language', async () => {
    const html = await renderPage();
    expect(html).not.toContain(' lang="');
    expect(jsonLdOf(html)['inLanguage']).toBe('en');
    const metadata = await generateMetadata({ params: Promise.resolve({ handle: 'jane-picks' }) });
    expect(metadata.openGraph).toMatchObject({ locale: 'en_US' });
  });
});

describe('normalizeStorefrontHeadingOutline', () => {
  const heading = (level: 2 | 3, text: string) => ({
    type: 'heading' as const,
    attrs: { level },
    content: [{ type: 'text' as const, text }],
  });
  const grid = (productIds: string[]) => ({
    type: 'affiliateProductGrid' as const,
    attrs: { productIds, title: null, columns: 3 as const },
  });

  it('shows an h3 that comes before any h2 as an h2, and leaves later ones alone', () => {
    const doc: StorefrontDoc = { type: 'doc', content: [heading(3, 'Intro'), heading(3, 'Details'), heading(2, 'Part two'), heading(3, 'More')] };
    const result = normalizeStorefrontHeadingOutline(doc, () => true);
    expect(result.content.map((block) => (block.type === 'heading' ? block.attrs.level : null))).toEqual([2, 3, 2, 3]);
    // The input is never mutated.
    expect(doc.content[0]).toEqual(heading(3, 'Intro'));
  });

  it('counts a grid that renders as an h2, and an empty grid not', () => {
    const doc: StorefrontDoc = { type: 'doc', content: [grid([PRODUCT_A]), heading(3, 'After a grid')] };
    expect(normalizeStorefrontHeadingOutline(doc, () => true)).toBe(doc);
    const promoted = normalizeStorefrontHeadingOutline(doc, () => false);
    expect(promoted.content[1]).toEqual(heading(2, 'After a grid'));
  });

  it('returns the same document when the outline is already sound', () => {
    const doc: StorefrontDoc = { type: 'doc', content: [heading(2, 'Hello'), heading(3, 'World')] };
    expect(normalizeStorefrontHeadingOutline(doc, () => true)).toBe(doc);
  });

  it('ignores headings the renderer skips (no content, or only spaces and line breaks)', () => {
    // An empty h2 renders nothing, so it must not count as the page's h2, and a blank h3 is never
    // the one promoted: the next real h3 is.
    const empty: StorefrontDoc = { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 } }, heading(3, 'Picks')] };
    expect(normalizeStorefrontHeadingOutline(empty, () => true).content[1]).toEqual(heading(2, 'Picks'));

    const blank: StorefrontDoc = { type: 'doc', content: [heading(3, ' '), heading(3, 'Real')] };
    const result = normalizeStorefrontHeadingOutline(blank, () => true);
    expect(result.content[0]).toEqual(heading(3, ' '));
    expect(result.content[1]).toEqual(heading(2, 'Real'));

    const brokenLine: StorefrontDoc = {
      type: 'doc',
      content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'hardBreak' }] }, heading(3, 'Next')],
    };
    expect(normalizeStorefrontHeadingOutline(brokenLine, () => true).content[1]).toEqual(heading(2, 'Next'));
  });

  it('finds the first grid that renders, counting grids only (the renderer index)', () => {
    const doc: StorefrontDoc = {
      type: 'doc',
      content: [heading(2, 'Intro'), grid([PRODUCT_A]), heading(3, 'Then'), grid([PRODUCT_B]), grid([PRODUCT_C])],
    };
    expect(firstRenderedStorefrontGridIndex(doc, () => true)).toBe(0);
    expect(firstRenderedStorefrontGridIndex(doc, (ids) => !ids.includes(PRODUCT_A))).toBe(1);
    expect(firstRenderedStorefrontGridIndex(doc, (ids) => ids.includes(PRODUCT_C))).toBe(2);
    expect(firstRenderedStorefrontGridIndex(doc, () => false)).toBe(-1);
    expect(firstRenderedStorefrontGridIndex({ type: 'doc', content: [heading(2, 'No grids')] }, () => true)).toBe(-1);
  });

  it('keeps the rendered page free of a skipped level', async () => {
    mocks.page = loadedPage({
      doc: sanitizeStorefrontDoc(
        { type: 'doc', content: [heading(3, 'Straight to a subheading'), { type: 'paragraph', content: [{ type: 'text', text: 'Hi.' }] }] },
        { allowedImageOrigins: ORIGINS },
      ).doc,
    });
    const html = await renderPage();
    expect(html).toContain('Straight to a subheading</h2>');
    expect(html).not.toContain('Straight to a subheading</h3>');
  });
});
