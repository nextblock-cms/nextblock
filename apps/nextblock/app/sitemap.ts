import type { MetadataRoute } from 'next';
import { AFFILIATE_TERMS_VERSION } from '@nextblock-cms/affiliates';
import { verifyPackageOnline } from '@nextblock-cms/db/server';
import {
  excludeCodeRoutePaths,
  fetchAllActiveProducts,
  fetchAllPartnerStorefronts,
  fetchAllPublishedPages,
  fetchAllPublishedPosts,
  type SitemapEntry,
} from './lib/sitemap-utils';
import {
  buildPartnersLocalePaths,
  buildPartnersTermsLocalePaths,
  partnersHreflangPaths,
  partnersProgramOwnedPaths,
  partnersTermsOverrideForLocale,
} from '../lib/affiliates/partners-paths';
import { getActiveRequestLanguages } from '../lib/affiliates/request-locale';
import { getPublicAffiliatesProgramSettings } from '../lib/affiliates/settings';
import { resolveSiteUrl, hasResolvedSiteUrl } from '../lib/site-url';
import { isAffiliatesProgramActive } from '../lib/affiliates/package-state';

/**
 * Cache the generated sitemap and rebuild it at most once an hour. Crawlers get
 * a fast, statically-served file while newly published pages/posts/products
 * still appear without a redeploy.
 *
 * NextBlock does not enable Next.js Cache Components, so the route-segment
 * `revalidate` config is the idiomatic caching control here (it matches the
 * rest of the app's ISR cadence). If `cacheComponents` were turned on, the
 * equivalent would be a `'use cache'` body paired with `cacheLife('hours')`
 * instead of this export.
 */
export const revalidate = 3600;

type SitemapItem = MetadataRoute.Sitemap[number];
type ChangeFrequency = NonNullable<SitemapItem['changeFrequency']>;

// Explicit NEXT_PUBLIC_URL → Vercel production URL → local-dev fallback.
const BASE_URL = resolveSiteUrl();

function toAbsolute(path: string): string {
  return `${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Maps a language-aware {@link SitemapEntry} onto a Next.js sitemap item. */
function toSitemapItem(
  entry: SitemapEntry,
  changeFrequency: ChangeFrequency,
  priority: number,
): SitemapItem {
  const item: SitemapItem = {
    url: toAbsolute(entry.path),
    lastModified: entry.lastModified,
    changeFrequency,
    priority,
  };

  if (entry.alternates) {
    item.alternates = {
      // Next.js renders this map as <xhtml:link rel="alternate" hreflang=.. href=.. />.
      languages: Object.fromEntries(
        Object.entries(entry.alternates).map(([code, path]) => [code, toAbsolute(path)]),
      ),
    };
  }

  return item;
}

/** Whether a premium package verifies as active; a failed check omits its URLs (never the sitemap). */
async function isPackageActive(packageId: string, label: string): Promise<boolean> {
  try {
    return await verifyPackageOnline(packageId);
  } catch (error) {
    console.error(`Sitemap: failed to verify the ${packageId} package; omitting ${label}.`, error);
    return false;
  }
}

async function safe(
  label: string,
  load: () => Promise<SitemapEntry[]>,
): Promise<SitemapEntry[]> {
  try {
    return await load();
  } catch (error) {
    console.error(`Sitemap: failed to load ${label}.`, error);
    return [];
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Disposable sandbox deployments should not advertise an indexable sitemap
  // (mirrors the legacy app/sitemap.xml route and app/robots.txt/route.ts).
  if (process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') {
    return [];
  }

  if (!hasResolvedSiteUrl()) {
    console.warn(
      'Warning: no site URL is set for the sitemap (NEXT_PUBLIC_URL / Vercel production URL). Defaulting to http://localhost:3000 — set NEXT_PUBLIC_URL in production.',
    );
  }

  // Products live behind the premium ecommerce package; their routes 404 when
  // it is inactive (see app/product/[slug]/page.tsx), so only advertise them
  // when the package verifies as active. The partner pages (/partners and every
  // published storefront) are gated the same way on the Affiliates package.
  const [ecommerceActive, affiliatesActive] = await Promise.all([
    isPackageActive('ecommerce', 'products'),
    isAffiliatesProgramActive(),
  ]);

  const [pages, posts, products, partnerStorefronts] = await Promise.all([
    safe('pages', fetchAllPublishedPages),
    safe('posts', fetchAllPublishedPosts),
    ecommerceActive
      ? safe('products', fetchAllActiveProducts)
      : Promise.resolve<SitemapEntry[]>([]),
    affiliatesActive
      ? safe('partner storefronts', fetchAllPartnerStorefronts)
      : Promise.resolve<SitemapEntry[]>([]),
  ]);

  // Code-defined route with no row in the content tables. The homepage is served
  // at "/" (its `home`/`accueil` page rows are excluded from the pages query to
  // avoid duplicate URLs).
  const homepage: SitemapItem = {
    url: toAbsolute('/'),
    lastModified: new Date().toISOString(),
    changeFrequency: 'daily',
    priority: 1,
  };

  // The partner program's landing page: a code-defined route like the homepage, with one address
  // per language (/partners, and /partenaires while French is active) that cross-link with hreflang.
  // While the program is active it answers those addresses itself, so a CMS page with one of those
  // slugs is not served there and leaves the sitemap; while it is inactive the CMS page is served
  // there (and listed as any page).
  const partnerLanguageCodes = affiliatesActive ? (await getActiveRequestLanguages()).activeCodes : null;
  const partnerPaths = partnerLanguageCodes ? buildPartnersLocalePaths(partnerLanguageCodes) : null;
  const partnerHreflang = partnerPaths ? partnersHreflangPaths(partnerPaths) : null;
  const partnerLandingPaths = partnerPaths
    ? [...new Set([partnerPaths.en, partnerPaths.fr].filter((path): path is string => Boolean(path)))]
    : [];
  const partnerItems: SitemapItem[] = affiliatesActive
    ? [
        ...partnerLandingPaths.map((path) =>
          toSitemapItem(
            { path, lastModified: new Date().toISOString(), ...(partnerHreflang ? { alternates: partnerHreflang } : {}) },
            'weekly',
            0.6,
          ),
        ),
        ...partnerStorefronts.map((entry) => toSitemapItem(entry, 'weekly', 0.5)),
      ]
    : [];
  const listedPages = partnerPaths ? excludeCodeRoutePaths(pages, partnersProgramOwnedPaths(partnerPaths)) : pages;

  // The built-in partner terms, gated like the landing page and with one address per language the
  // same way (/partners/terms, and /partenaires/conditions while French is active). An address whose
  // language the operator replaced with a page of their own redirects there, so it is left out, and
  // the two cross-link with hreflang only while both are listed. lastmod is the terms' version.
  const termsItems: SitemapItem[] = [];
  if (partnerLanguageCodes) {
    const termsPaths = buildPartnersTermsLocalePaths(partnerLanguageCodes);
    const programSettings = await getPublicAffiliatesProgramSettings();
    const listedTerms = [
      termsPaths.en && !partnersTermsOverrideForLocale('en', programSettings) ? termsPaths.en : null,
      termsPaths.fr && !partnersTermsOverrideForLocale('fr', programSettings) ? termsPaths.fr : null,
    ].filter((path): path is string => Boolean(path));
    const termsHreflang = listedTerms.length === 2 ? partnersHreflangPaths(termsPaths) : null;
    for (const path of listedTerms) {
      termsItems.push(
        toSitemapItem(
          { path, lastModified: `${AFFILIATE_TERMS_VERSION}T00:00:00.000Z`, ...(termsHreflang ? { alternates: termsHreflang } : {}) },
          'monthly',
          0.3,
        ),
      );
    }
  }

  const items: SitemapItem[] = [
    homepage,
    ...listedPages.map((entry) => toSitemapItem(entry, 'weekly', 0.8)),
    ...posts.map((entry) => toSitemapItem(entry, 'weekly', 0.6)),
    ...products.map((entry) => toSitemapItem(entry, 'daily', 0.7)),
    ...partnerItems,
    ...termsItems,
  ];

  // Translations can share a slug (NextBlock has no locale path prefix), so the
  // same URL may surface more than once. Collapse duplicates, keeping the first
  // (highest-priority) occurrence.
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.url)) {
      return false;
    }
    seen.add(item.url);
    return true;
  });
}
