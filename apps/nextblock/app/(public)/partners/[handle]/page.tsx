import Link from 'next/link';
import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import { notFound, permanentRedirect } from 'next/navigation';
import { verifyPackageOnline } from '@nextblock-cms/db/server';
import type { Product } from '@nextblock-cms/ecommerce/types';
import {
  AFFILIATES_COMMON_COPY,
  AFFILIATES_STOREFRONT_COPY,
  AFFILIATE_PARTNERS_PATH,
  StorefrontRenderer,
  affiliateTierDisplayName,
  collectStorefrontProductIds,
  normalizeAffiliateHandle,
  type StorefrontRenderProductGridArgs,
} from '@nextblock-cms/affiliates';
import PaymentReadinessBoundary from '../../../../components/commerce/PaymentReadinessBoundary';
import { CurrentContentSetter } from '../../../../components/CurrentContentSetter';
import { PARTNERS_TEXT_LINK_CLASS } from '../../../../components/affiliates/public/link-button-classes';
import { partnersPathForLocale } from '../../../../lib/affiliates/partners-paths';
import {
  AFFILIATE_REFERRAL_CONSENT_COOKIE,
  hasDeclinedAffiliateMarketingConsent,
} from '../../../../lib/affiliates/referral-cookie';
import { getServerAffiliatesCopy } from '../../../../lib/affiliates/server-copy';
import { loadAffiliateStorefrontProducts } from '../../../../lib/affiliates/storefront-products';
import { mintAffiliateStorefrontToken } from '../../../../lib/affiliates/storefront-token';
import { stringifyJsonLd } from '../../../lib/seo';
import { getSiteSettings } from '../../../lib/site-settings';
import { StorefrontHeader } from '../_components/storefront-header';
import { isAffiliatesPackageActive } from '../_components/package-gate';
import { loadAffiliateStorefrontPage, resolveStorefrontAvatarUrl } from '../_components/storefront-loader';
import { buildAffiliateStorefrontMetadata, resolveAffiliateStorefrontSeo } from '../_components/storefront-metadata';
import {
  StorefrontProductSection,
  firstRenderedStorefrontGridIndex,
  normalizeStorefrontHeadingOutline,
  pickStorefrontProducts,
} from '../_components/storefront-products';

// Per request: locale, CSP nonce, and a freshly minted attribution token on every render. The
// storefront read itself is cached across requests (lib/affiliates/storefront-data.ts).
export const dynamic = 'force-dynamic';

interface AffiliateStorefrontPageProps {
  params: Promise<{ handle: string }>;
}

const STOREFRONT_PAGE_COPY = { ...AFFILIATES_COMMON_COPY, ...AFFILIATES_STOREFRONT_COPY };

async function isEcommerceActive(): Promise<boolean> {
  try {
    return await verifyPackageOnline('ecommerce');
  } catch {
    return false;
  }
}

/** The base language of a site language code (`fr-CA` → `fr`), which `<html lang>` declares. */
function baseLanguage(code: string): string {
  return code.trim().toLowerCase().split(/[-_]/)[0] ?? '';
}

export async function generateMetadata({ params }: AffiliateStorefrontPageProps): Promise<Metadata> {
  const { handle } = await params;
  const page = await loadAffiliateStorefrontPage(handle);
  if (!page) {
    const t = await getServerAffiliatesCopy({ dictionary: STOREFRONT_PAGE_COPY });
    return { title: t('affiliates.storefront.not_found_title'), robots: { index: false, follow: true } };
  }

  const [t, { siteTitle }] = await Promise.all([
    getServerAffiliatesCopy({ locale: page.siteLocale, dictionary: STOREFRONT_PAGE_COPY }),
    getSiteSettings(),
  ]);
  return buildAffiliateStorefrontMetadata({
    handle: page.handle,
    displayName: page.storefront.profile.display_name,
    title: page.storefront.title,
    metaDescription: page.storefront.metaDescription,
    doc: page.doc,
    t,
    siteUrl: page.siteUrl,
    siteTitle,
    siteLocale: page.siteLocale,
    contentLocale: page.storefront.profile.locale ?? null,
  });
}

export default async function AffiliateStorefrontPage({ params }: AffiliateStorefrontPageProps) {
  const { handle: rawHandle } = await params;
  // Every storefront address is a plain 404 while the package is off (never a redirect first).
  if (!(await isAffiliatesPackageActive())) notFound();
  // One canonical, lowercase address (the referral cookie and the canonical tag both use it).
  const lowered = typeof rawHandle === 'string' ? rawHandle.trim().toLowerCase() : '';
  if (lowered !== rawHandle && normalizeAffiliateHandle(lowered)) {
    permanentRedirect(`${AFFILIATE_PARTNERS_PATH}/${lowered}`);
  }

  const page = await loadAffiliateStorefrontPage(rawHandle);
  if (!page) notFound();

  const { handle, storefront, doc, imageOrigins, siteOrigin, siteUrl, siteLocale } = page;
  const [t, requestHeaders, ecommerceActive] = await Promise.all([
    getServerAffiliatesCopy({ locale: siteLocale, dictionary: STOREFRONT_PAGE_COPY }),
    headers(),
    isEcommerceActive(),
  ]);
  const nonce = requestHeaders.get('x-nonce') || undefined;

  // The partner wrote the page in one language (the approved snapshot's `locale`); the chrome, the
  // shop's product cards and the featured products follow the visitor. Where the two differ, the
  // partner's text is marked with its language and the catalog inside it with the visitor's.
  const contentLocale = storefront.profile.locale ?? null;
  const contentLang = contentLocale && contentLocale !== baseLanguage(siteLocale) ? contentLocale : undefined;
  const catalogLang = contentLang ? siteLocale : undefined;

  // Products: the document's grids first, then any featured pick not already shown in one.
  const gridProductIds = collectStorefrontProductIds(doc);
  const featuredProductIds = storefront.featuredProductIds.filter((id) => !gridProductIds.includes(id));
  const catalog: Map<string, Product> = ecommerceActive
    ? await loadAffiliateStorefrontProducts({ productIds: [...gridProductIds, ...featuredProductIds], locale: siteLocale })
    : new Map();
  // One signed token per render (ADDENDUM B9): "Add to cart" stores it, checkout verifies it. None
  // for a visitor who declined marketing cookies, so the cart never stores it without consent; the
  // checkout ignores a stored one while the decline lasts, and the referral cookie follows the same
  // rule in the proxy.
  const marketingDeclined = hasDeclinedAffiliateMarketingConsent(
    (await cookies()).get(AFFILIATE_REFERRAL_CONSENT_COOKIE)?.value,
  );
  const affiliateRef = ecommerceActive && !marketingDeclined ? mintAffiliateStorefrontToken(handle) : null;

  const shownInGrids = pickStorefrontProducts(gridProductIds, catalog);
  const shownKeys = new Set(shownInGrids.flatMap((product) => [product.id, product.translation_group_id].filter(Boolean)));
  const featuredProducts = pickStorefrontProducts(featuredProductIds, catalog).filter(
    (product) => !shownKeys.has(product.id) && !(product.translation_group_id && shownKeys.has(product.translation_group_id)),
  );

  // The display name is the page's h1: a partner heading must never skip a level under it.
  const gridRenders = (ids: readonly string[]) => pickStorefrontProducts(ids, catalog).length > 0;
  const renderedDoc = normalizeStorefrontHeadingOutline(doc, gridRenders);
  // Only the first grid that renders loads its first row eagerly; later grids (the featured
  // products included) are further down the page and stay lazy.
  const firstGridIndex = firstRenderedStorefrontGridIndex(renderedDoc, gridRenders);
  const productsTitle = t('affiliates.storefront.products_title');
  const renderProductGrid = ({ productIds, title, columns, index }: StorefrontRenderProductGridArgs) => {
    const products = pickStorefrontProducts(productIds, catalog);
    if (products.length === 0) return null;
    return (
      <StorefrontProductSection
        title={title}
        fallbackTitle={productsTitle}
        products={products}
        columns={columns}
        affiliateRef={affiliateRef}
        referralHandle={handle}
        eagerFirstRow={index === firstGridIndex}
        lang={catalogLang}
      />
    );
  };

  const displayName = storefront.profile.display_name;
  const avatarUrl = resolveStorefrontAvatarUrl(storefront.profile.avatar_object_key, imageOrigins);
  const tierName = affiliateTierDisplayName(
    { name: storefront.tier.name, name_translations: storefront.tier.nameTranslations },
    siteLocale,
  );
  const seo = resolveAffiliateStorefrontSeo({
    handle,
    displayName,
    title: storefront.title,
    metaDescription: storefront.metaDescription,
    doc,
    t,
    siteUrl,
  });

  let avatarAbsoluteUrl: string | undefined;
  try {
    avatarAbsoluteUrl = avatarUrl ? new URL(avatarUrl, `${siteUrl}/`).href : undefined;
  } catch {
    avatarAbsoluteUrl = undefined;
  }
  const sameAs = Object.values(storefront.profile.social_links).filter(
    (href): href is string => typeof href === 'string' && href !== '',
  );
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    '@id': `${seo.url}#profile`,
    url: seo.url,
    name: seo.title,
    description: seo.description,
    inLanguage: contentLocale ?? siteLocale,
    ...(storefront.publishedAt ? { datePublished: storefront.publishedAt } : {}),
    ...(storefront.updatedAt ? { dateModified: storefront.updatedAt } : {}),
    mainEntity: {
      '@type': 'Person',
      name: displayName,
      alternateName: handle,
      url: seo.url,
      ...(storefront.profile.bio ? { description: storefront.profile.bio } : {}),
      ...(avatarAbsoluteUrl ? { image: avatarAbsoluteUrl } : {}),
      ...(sameAs.length > 0 ? { sameAs } : {}),
    },
  };

  const partnerDocument = (
    <StorefrontRenderer
      doc={renderedDoc}
      allowedImageOrigins={imageOrigins}
      siteOrigin={siteOrigin}
      renderProductGrid={renderProductGrid}
      referralHandle={handle}
      labels={{ photoCredit: (photographer, provider) => t('affiliates.storefront.photo_credit', { photographer, provider }) }}
    />
  );
  const body = (
    <>
      {contentLang ? <div lang={contentLang}>{partnerDocument}</div> : partnerDocument}
      {featuredProducts.length > 0 ? (
        <StorefrontProductSection
          title={t('affiliates.storefront.featured_title')}
          fallbackTitle={productsTitle}
          products={featuredProducts}
          columns={3}
          affiliateRef={affiliateRef}
          referralHandle={handle}
          eagerFirstRow={firstGridIndex === -1}
        />
      ) : null}
    </>
  );

  return (
    <>
      <script
        type="application/ld+json"
        nonce={nonce}
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: stringifyJsonLd(jsonLd) }}
      />
      {/* Not a CMS document: the language switcher refreshes this page in place. */}
      <CurrentContentSetter id={null} type={null} slug={null} />
      <article className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6 lg:px-8">
        <StorefrontHeader
          t={t}
          displayName={displayName}
          avatarUrl={avatarUrl}
          tierName={tierName}
          tierBadgeColor={storefront.tier.badgeColor}
          bio={storefront.profile.bio}
          socialLinks={storefront.profile.social_links}
          contentLang={contentLang}
        />
        <div className="mt-10">
          {ecommerceActive ? <PaymentReadinessBoundary>{body}</PaymentReadinessBoundary> : body}
        </div>
        <footer className="mt-16 rounded-xl border border-border bg-card p-6 text-card-foreground">
          <p className="text-foreground">
            {t('affiliates.storefront.join_cta_text')}{' '}
            <Link href={partnersPathForLocale(siteLocale)} prefetch={false} className={PARTNERS_TEXT_LINK_CLASS}>
              {t('affiliates.storefront.join_cta_link')}
            </Link>
          </p>
        </footer>
      </article>
    </>
  );
}
