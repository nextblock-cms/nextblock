import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SitemapEntry } from './lib/sitemap-utils';

/**
 * The sitemap advertises the partner pages only while the Affiliates package is active, exactly as it
 * gates products on the shop package: the landing page at each of its addresses (`/partners`, and
 * `/partenaires` while French is active, cross-linked with hreflang) plus every published storefront,
 * each storefront's lastmod being its last approval. While active, the program answers those
 * addresses itself, so a CMS page with one of those slugs leaves the sitemap; while inactive the CMS
 * page is served there and stays listed. A sandbox still gets an empty sitemap.
 */

const mocks = vi.hoisted(() => {
  // BASE_URL is resolved when app/sitemap.ts loads.
  const previousSiteUrl = process.env.NEXT_PUBLIC_URL;
  process.env.NEXT_PUBLIC_URL = 'https://shop.example.com';
  return {
    previousSiteUrl,
    activePackages: new Set<string>(['ecommerce', 'affiliates']),
    failingPackages: new Set<string>(),
    activeCodes: ['en', 'fr'] as string[],
    pages: [] as Array<{ path: string; lastModified: string; alternates?: Record<string, string> }>,
    storefronts: [] as Array<{ handle: string; publishedAt: string | null; updatedAt: string | null }>,
    storefrontError: null as unknown,
    /** The public program settings projection (the operator's terms pages). */
    programSettings: null as null | { termsUrlEn: string; termsUrlFr: string; minPayoutCents: number; autoPayoutsEnabled: boolean },
  };
});

vi.mock('@nextblock-cms/db/server', () => ({
  verifyPackageOnline: async (id: string) => {
    if (mocks.failingPackages.has(id)) throw new Error(`cannot verify ${id}`);
    return mocks.activePackages.has(id);
  },
  getSsgSupabaseClient: () => {
    throw new Error('the content fetchers are stubbed in this suite');
  },
}));

vi.mock('../lib/affiliates/storefront-data', () => ({
  listPublishedAffiliateStorefronts: async () => {
    if (mocks.storefrontError) throw mocks.storefrontError;
    return mocks.storefronts;
  },
}));

vi.mock('../lib/affiliates/request-locale', () => ({
  getActiveRequestLanguages: async () => ({ activeCodes: mocks.activeCodes, defaultCode: mocks.activeCodes[0] ?? null }),
}));

vi.mock('../lib/affiliates/settings', () => ({ getPublicAffiliatesProgramSettings: async () => mocks.programSettings }));

// The real partner fetcher, stubbed content fetchers (their queries are covered elsewhere).
vi.mock('./lib/sitemap-utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchAllPublishedPages: async () => mocks.pages,
  fetchAllPublishedPosts: async () => [],
  fetchAllActiveProducts: async () => [{ path: '/product/chef-knife', lastModified: '2026-09-02T00:00:00.000Z' }],
}));

import sitemap from './sitemap';
import { excludeCodeRoutePaths } from './lib/sitemap-utils';

const ABOUT = { path: '/about', lastModified: '2026-09-01T00:00:00.000Z' };
/** An operator's CMS page pair at the program's addresses. */
const CMS_PARTNERS_PAIR = [
  {
    path: '/partners',
    lastModified: '2026-08-01T00:00:00.000Z',
    alternates: { en: '/partners', fr: '/partenaires', 'x-default': '/partners' },
  },
  {
    path: '/partenaires',
    lastModified: '2026-08-01T00:00:00.000Z',
    alternates: { en: '/partners', fr: '/partenaires', 'x-default': '/partners' },
  },
];

beforeEach(() => {
  mocks.activePackages = new Set(['ecommerce', 'affiliates']);
  mocks.failingPackages = new Set();
  mocks.activeCodes = ['en', 'fr'];
  mocks.pages = [ABOUT];
  mocks.storefronts = [
    { handle: 'jane-picks', publishedAt: '2026-10-20T10:00:00.000Z', updatedAt: '2026-10-21T10:00:00.000Z' },
    { handle: 'max-gear', publishedAt: '2026-10-22T08:30:00.000Z', updatedAt: null },
  ];
  mocks.storefrontError = null;
  mocks.programSettings = { termsUrlEn: '', termsUrlFr: '', minPayoutCents: 100, autoPayoutsEnabled: true };
  vi.unstubAllEnvs();
});

afterAll(() => {
  if (mocks.previousSiteUrl === undefined) delete process.env.NEXT_PUBLIC_URL;
  else process.env.NEXT_PUBLIC_URL = mocks.previousSiteUrl;
});

function urls(items: Awaited<ReturnType<typeof sitemap>>): string[] {
  return items.map((item) => item.url);
}

const LANDING_ALTERNATES = {
  languages: {
    en: 'https://shop.example.com/partners',
    fr: 'https://shop.example.com/partenaires',
    'x-default': 'https://shop.example.com/partners',
  },
};

describe('sitemap: partner pages', () => {
  it('lists both landing addresses and every published storefront while the package is active', async () => {
    const items = await sitemap();

    expect(urls(items)).toEqual([
      'https://shop.example.com/',
      'https://shop.example.com/about',
      'https://shop.example.com/product/chef-knife',
      'https://shop.example.com/partners',
      'https://shop.example.com/partenaires',
      'https://shop.example.com/partners/jane-picks',
      'https://shop.example.com/partners/max-gear',
      'https://shop.example.com/partners/terms',
      'https://shop.example.com/partenaires/conditions',
    ]);
    const jane = items.find((item) => item.url.endsWith('/partners/jane-picks'));
    expect(jane).toMatchObject({ lastModified: '2026-10-21T10:00:00.000Z', changeFrequency: 'weekly', priority: 0.5 });
    expect(jane?.alternates).toBeUndefined();
    // No approval update yet: the first approval stands in.
    expect(items.find((item) => item.url.endsWith('/partners/max-gear'))?.lastModified).toBe('2026-10-22T08:30:00.000Z');
    // The two landing addresses point at each other.
    for (const url of ['https://shop.example.com/partners', 'https://shop.example.com/partenaires']) {
      expect(items.find((item) => item.url === url)).toMatchObject({
        changeFrequency: 'weekly',
        priority: 0.6,
        alternates: LANDING_ALTERNATES,
      });
    }
  });

  it('lists only /partners, without alternates, while French is not an active language', async () => {
    mocks.activeCodes = ['en', 'es'];
    const items = await sitemap();
    expect(urls(items).filter((url) => /\/(partners|partenaires)$/.test(url))).toEqual(['https://shop.example.com/partners']);
    expect(items.find((item) => item.url.endsWith('/partners'))?.alternates).toBeUndefined();
  });

  it('drops CMS pages at the addresses the active program answers, and only those', async () => {
    mocks.pages = [ABOUT, ...CMS_PARTNERS_PAIR];
    const items = await sitemap();

    const landing = items.filter((item) => /\/(partners|partenaires)$/.test(item.url));
    expect(landing.map((item) => [item.url, item.priority])).toEqual([
      ['https://shop.example.com/partners', 0.6],
      ['https://shop.example.com/partenaires', 0.6],
    ]);
    for (const item of landing) expect(item.alternates).toEqual(LANDING_ALTERNATES);

    // Without French the program does not answer /partenaires: the CMS page there stays listed.
    mocks.activeCodes = ['en'];
    const english = await sitemap();
    expect(english.find((item) => item.url.endsWith('/partners'))).toMatchObject({ priority: 0.6 });
    expect(english.find((item) => item.url.endsWith('/partners'))?.alternates).toBeUndefined();
    expect(english.find((item) => item.url.endsWith('/partenaires'))).toMatchObject({ priority: 0.8 });
    expect(english.find((item) => item.url.endsWith('/partenaires'))?.alternates).toBeUndefined();
  });

  it('omits every partner URL while the package is inactive or cannot be verified', async () => {
    mocks.activePackages = new Set(['ecommerce']);
    expect(urls(await sitemap()).filter((url) => url.includes('/partners') || url.includes('/partenaires'))).toEqual([]);

    mocks.activePackages = new Set(['ecommerce', 'affiliates']);
    mocks.failingPackages = new Set(['affiliates']);
    const items = await sitemap();
    expect(urls(items).filter((url) => url.includes('/partners') || url.includes('/partenaires'))).toEqual([]);
    // The rest of the sitemap is unaffected.
    expect(urls(items)).toContain('https://shop.example.com/product/chef-knife');
  });

  it('keeps the CMS pages at those addresses while the package is inactive (they are served there)', async () => {
    mocks.activePackages = new Set(['ecommerce']);
    mocks.pages = [ABOUT, ...CMS_PARTNERS_PAIR];
    const items = await sitemap();
    expect(items.find((item) => item.url.endsWith('/partners'))).toMatchObject({ priority: 0.8, alternates: LANDING_ALTERNATES });
    expect(items.find((item) => item.url.endsWith('/partenaires'))).toMatchObject({ priority: 0.8, alternates: LANDING_ALTERNATES });
  });

  it('keeps the landing addresses when the storefront list cannot be read', async () => {
    mocks.storefrontError = new Error('AffiliateStorefrontListReadFailed');
    const partnerUrls = urls(await sitemap()).filter((url) => url.includes('/partners') || url.includes('/partenaires'));
    expect(partnerUrls).toEqual([
      'https://shop.example.com/partners',
      'https://shop.example.com/partenaires',
      'https://shop.example.com/partners/terms',
      'https://shop.example.com/partenaires/conditions',
    ]);
  });

  it('lists the built-in terms at each language address, cross-linked, with the terms version as lastmod', async () => {
    const items = await sitemap();
    const alternates = {
      languages: {
        en: 'https://shop.example.com/partners/terms',
        fr: 'https://shop.example.com/partenaires/conditions',
        'x-default': 'https://shop.example.com/partners/terms',
      },
    };
    for (const url of ['https://shop.example.com/partners/terms', 'https://shop.example.com/partenaires/conditions']) {
      expect(items.find((item) => item.url === url)).toMatchObject({
        lastModified: '2026-11-11T00:00:00.000Z',
        changeFrequency: 'monthly',
        priority: 0.3,
        alternates,
      });
    }

    mocks.activeCodes = ['en'];
    const english = await sitemap();
    expect(urls(english).filter((url) => /\/(terms|conditions)$/.test(url))).toEqual(['https://shop.example.com/partners/terms']);
    expect(english.find((item) => item.url.endsWith('/partners/terms'))?.alternates).toBeUndefined();
  });

  it("leaves out a terms address the operator's own page replaces (it redirects), and lists both when the settings are unreadable", async () => {
    mocks.programSettings = { termsUrlEn: '', termsUrlFr: '/legal/conditions', minPayoutCents: 100, autoPayoutsEnabled: true };
    let terms = (await sitemap()).filter((item) => /\/(terms|conditions)$/.test(item.url));
    expect(terms.map((item) => item.url)).toEqual(['https://shop.example.com/partners/terms']);
    expect(terms[0]?.alternates).toBeUndefined();

    // French falls back to the English page, so an English page replaces both addresses.
    mocks.programSettings = { termsUrlEn: 'https://legal.example.com/partners', termsUrlFr: '', minPayoutCents: 100, autoPayoutsEnabled: true };
    terms = (await sitemap()).filter((item) => /\/(terms|conditions)$/.test(item.url));
    expect(terms).toEqual([]);

    mocks.programSettings = null;
    terms = (await sitemap()).filter((item) => /\/(terms|conditions)$/.test(item.url));
    expect(terms).toHaveLength(2);
  });

  it('still returns nothing for a sandbox', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    await expect(sitemap()).resolves.toEqual([]);
  });
});

describe('excludeCodeRoutePaths', () => {
  const entry = (path: string, alternates?: Record<string, string>): SitemapEntry => ({
    path,
    lastModified: '2026-09-01T00:00:00.000Z',
    ...(alternates ? { alternates } : {}),
  });

  it('returns the same list when no path is owned', () => {
    const entries = [entry('/about')];
    expect(excludeCodeRoutePaths(entries, [])).toBe(entries);
  });

  it('drops owned paths and strips them from the remaining alternates', () => {
    const trio = { en: '/partners', fr: '/partenaires', es: '/socios', de: '/partner-de', 'x-default': '/partners' };
    expect(
      excludeCodeRoutePaths(
        [entry('/partners', trio), entry('/partenaires', trio), entry('/socios', trio), entry('/partner-de', trio)],
        ['/partners', '/partenaires'],
      ),
    ).toEqual([
      // x-default pointed at a removed path: it moves to the first remaining language.
      entry('/socios', { es: '/socios', de: '/partner-de', 'x-default': '/socios' }),
      entry('/partner-de', { es: '/socios', de: '/partner-de', 'x-default': '/socios' }),
    ]);
  });

  it('drops alternates that collapse to a single address, and keeps a surviving x-default', () => {
    const pair = { en: '/partners', es: '/socios', 'x-default': '/partners' };
    expect(excludeCodeRoutePaths([entry('/socios', pair)], ['/partners'])).toEqual([entry('/socios')]);

    const kept = { en: '/about', fr: '/a-propos', es: '/partners', 'x-default': '/about' };
    expect(excludeCodeRoutePaths([entry('/about', kept)], ['/partners'])).toEqual([
      entry('/about', { en: '/about', fr: '/a-propos', 'x-default': '/about' }),
    ]);
  });
});
