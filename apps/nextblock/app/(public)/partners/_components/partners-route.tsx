import 'server-only';

import { cache } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { Info } from 'lucide-react';
import {
  AFFILIATES_COMMON_COPY,
  AFFILIATES_PARTNERS_COPY,
  AFFILIATES_SANDBOX_COPY,
  AFFILIATE_PARTNERS_PATH,
  AFFILIATE_PARTNERS_PATH_FR,
  AFFILIATE_PORTAL_PATH,
  type AffiliateLocale,
  type AffiliatesCopyTranslate,
} from '@nextblock-cms/affiliates';
import CmsPage, { generateMetadata as generateCmsPageMetadata } from '../../../[slug]/page';
import { CurrentContentSetter } from '../../../../components/CurrentContentSetter';
import { PartnerRevenueCalculator } from '../../../../components/affiliates/public/PartnerRevenueCalculator';
import { PartnerSignupForm } from '../../../../components/affiliates/public/PartnerSignupForm';
import {
  buildPartnersLocalePaths,
  partnersHreflangPaths,
  partnersTermsHref,
  type PartnersLocalePaths,
} from '../../../../lib/affiliates/partners-paths';
import { getPartnersShowcaseCatalog, selectPartnersShowcaseForLocale } from '../../../../lib/affiliates/partners-showcase';
import { getActiveRequestLanguages, getRequestLocale, toAffiliatesLocale } from '../../../../lib/affiliates/request-locale';
import { getServerAffiliatesCopy } from '../../../../lib/affiliates/server-copy';
import { getPublicAffiliatesProgramSettings } from '../../../../lib/affiliates/settings';
import { resolvePartnerSignupViewer } from '../../../../lib/affiliates/signup';
import {
  getAffiliateStoreBaseCurrency,
  getPartnersBotProtectionPublic,
  getPublicAffiliateTiers,
} from '../../../../lib/affiliates/storefront-data';
import { resolveSiteUrl } from '../../../../lib/site-url';
import { buildSocialMetadata, stringifyJsonLd, toOpenGraphLocale } from '../../../lib/seo';
import { getSiteSettings } from '../../../lib/site-settings';
import { checkPartnerHandleAvailability, submitPartnerSignup } from '../actions';
import { isAffiliatesPackageActive } from './package-gate';
import { PartnersLandingView } from './partners-landing';
import {
  buildPartnersJsonLd,
  buildPartnersLandingModel,
  buildPartnersMetaCopy,
  type PartnersLandingModel,
} from './partners-model';

/**
 * The partner program's landing page, shared by its two addresses: `/partners` (the visitor's
 * language) and `/partenaires` (always French: the proxy pins the request locale there). Each
 * declares the canonical URL of the language it rendered in and, while both exist, hreflang
 * alternates `en` / `fr` / `x-default`.
 *
 * While the Affiliates package is inactive the program owns no URL: both addresses render the CMS
 * page with that slug (`partners`, `partenaires`), which 404s when there is none, exactly as the
 * `[slug]` route would. `/partenaires` does the same when French is not an active language.
 *
 * On the public sandbox a guide card above the page points to the seeded demo accounts: the signup
 * form there runs in demo mode (lib/affiliates/signup.ts) and creates no account.
 */

export type PartnersRoutePath = typeof AFFILIATE_PARTNERS_PATH | typeof AFFILIATE_PARTNERS_PATH_FR;

export interface PartnersRouteProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

interface PartnersRouteData {
  siteLocale: string;
  locale: AffiliateLocale;
  model: PartnersLandingModel;
  paths: PartnersLocalePaths;
  /** The address of the language this request rendered in (site-relative). */
  canonicalPath: string;
}

const PARTNERS_PAGE_COPY = { ...AFFILIATES_COMMON_COPY, ...AFFILIATES_PARTNERS_COPY, ...AFFILIATES_SANDBOX_COPY };

/**
 * The public sandbox's demo logins and storefront, seeded by the reset cron
 * (app/api/cron/reset-sandbox/affiliate-demo.ts) and listed on /sign-in. Literals, as in
 * SandboxCredentialsAlert; partners-route.test.tsx pins them to the seed.
 */
const SANDBOX_DEMO_PARTNER_EMAIL = 'partner@nextblock.dev';
const SANDBOX_DEMO_ADMIN_EMAIL = 'demo@nextblock.dev';
const SANDBOX_DEMO_STOREFRONT_PATH = `${AFFILIATE_PARTNERS_PATH}/studio-nova`;
/** Where the demo admin approves storefronts and reads the commission ledger. */
const CMS_AFFILIATES_PATH = '/cms/affiliates';

const SANDBOX_GUIDE_LINK_CLASS =
  'rounded-sm font-medium underline underline-offset-4 hover:no-underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

/** The public sandbox (demo logins public, data reset every 15 minutes). Exactly `'true'`. */
function isPartnersSandbox(): boolean {
  return process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';
}

/**
 * The sandbox's guide card, above the landing page: the demo partner's storefront, the partner
 * portal and the CMS side, each one link away (a demo signup creates no account to explore). A
 * labelled landmark with no heading, so the page outline still starts at the hero's h1.
 */
function PartnersSandboxGuide({ t, locale }: { t: AffiliatesCopyTranslate; locale: AffiliateLocale }) {
  const links = [
    { href: SANDBOX_DEMO_STOREFRONT_PATH, label: t('affiliates.sandbox.guide_storefront') },
    {
      href: `/sign-in?redirect=${encodeURIComponent(AFFILIATE_PORTAL_PATH)}`,
      label: t('affiliates.sandbox.guide_portal', { email: SANDBOX_DEMO_PARTNER_EMAIL }),
    },
    {
      href: `/sign-in?redirect=${encodeURIComponent(CMS_AFFILIATES_PATH)}`,
      label: t('affiliates.sandbox.guide_admin', { email: SANDBOX_DEMO_ADMIN_EMAIL }),
    },
  ];

  return (
    <aside lang={locale} aria-labelledby="partners-sandbox-guide-title" className="mx-auto w-full max-w-6xl px-4 pt-8 sm:px-6 lg:px-8">
      <div className="flex items-start gap-3 rounded-xl border border-blue-200 bg-blue-50 p-6 text-blue-900 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-100">
        <Info aria-hidden="true" className="mt-1 h-5 w-5 shrink-0 text-blue-600 dark:text-blue-400" />
        <div className="min-w-0">
          <p id="partners-sandbox-guide-title" className="text-lg font-semibold">
            {t('affiliates.sandbox.guide_title')}
          </p>
          <p className="mt-1 leading-7">{t('affiliates.sandbox.guide_body')}</p>
          <ul className="mt-3 list-disc space-y-2 pl-5 break-words">
            {links.map((link) => (
              <li key={link.href}>
                {/* No prefetch, as in SandboxCredentialsAlert (the referral cookie follows real navigations). */}
                <Link href={link.href} prefetch={false} className={SANDBOX_GUIDE_LINK_CLASS}>
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </aside>
  );
}

/** The `[slug]` route's props for the CMS page this address falls back to. */
function cmsPageProps(path: PartnersRoutePath, props: PartnersRouteProps | undefined) {
  return {
    params: Promise.resolve({ slug: path.slice(1) }),
    searchParams: props?.searchParams ?? Promise.resolve({}),
  };
}

/**
 * Shared by `generateMetadata` and the page body (React `cache`: one read per request). Null when
 * the program does not answer this address in this request: `/partenaires` rendered in anything but
 * French (French is not an active language, so the proxy did not pin it).
 */
const loadPartnersRoute = cache(async (path: PartnersRoutePath): Promise<PartnersRouteData | null> => {
  // The showcase catalog (the calculator's product picker and the hero's example card; cached,
  // locale-free, never throws) is read beside the tiers, not after them.
  const [siteLocale, languages, tiers, currency, showcase] = await Promise.all([
    getRequestLocale(),
    getActiveRequestLanguages(),
    getPublicAffiliateTiers(),
    getAffiliateStoreBaseCurrency(),
    getPartnersShowcaseCatalog(),
  ]);
  const locale = toAffiliatesLocale(siteLocale);
  if (path === AFFILIATE_PARTNERS_PATH_FR && locale !== 'fr') return null;

  const products = selectPartnersShowcaseForLocale(showcase, locale, currency);
  const paths = buildPartnersLocalePaths(languages.activeCodes);
  return {
    siteLocale,
    locale,
    model: buildPartnersLandingModel({ tiers, locale, currency, products }),
    paths,
    canonicalPath: paths[locale] ?? paths['x-default'],
  };
});

function absoluteUrl(path: string): string {
  return `${resolveSiteUrl()}${path}`;
}

/** `example.com/partners/`, shown before the handle field (storefronts live under `/partners` in every language). */
function storefrontPrefix(): string {
  try {
    return `${new URL(resolveSiteUrl()).host}${AFFILIATE_PARTNERS_PATH}/`;
  } catch {
    return `${AFFILIATE_PARTNERS_PATH}/`;
  }
}

export async function buildPartnersRouteMetadata(path: PartnersRoutePath, props?: PartnersRouteProps): Promise<Metadata> {
  if (!(await isAffiliatesPackageActive())) return generateCmsPageMetadata(cmsPageProps(path, props));
  const route = await loadPartnersRoute(path);
  if (!route) return generateCmsPageMetadata(cmsPageProps(path, props));

  const [{ siteTitle, socialImage }, t] = await Promise.all([
    getSiteSettings(),
    getServerAffiliatesCopy({ locale: route.siteLocale, dictionary: PARTNERS_PAGE_COPY }),
  ]);
  const { title, description } = buildPartnersMetaCopy(t, route.model);
  const url = absoluteUrl(route.canonicalPath);
  const hreflang = partnersHreflangPaths(route.paths);

  return {
    title,
    description,
    alternates: {
      canonical: url,
      ...(hreflang
        ? { languages: { en: absoluteUrl(hreflang.en), fr: absoluteUrl(hreflang.fr), 'x-default': absoluteUrl(hreflang['x-default']) } }
        : {}),
    },
    ...buildSocialMetadata({
      title,
      description,
      url,
      siteTitle,
      fallbackImage: socialImage,
      type: 'website',
      locale: toOpenGraphLocale(route.locale),
    }),
  };
}

export async function renderPartnersRoute(path: PartnersRoutePath, props?: PartnersRouteProps) {
  if (!(await isAffiliatesPackageActive())) return CmsPage(cmsPageProps(path, props));
  const route = await loadPartnersRoute(path);
  if (!route) return CmsPage(cmsPageProps(path, props));

  const [viewer, botProtection, requestHeaders, { siteTitle }, t, programSettings] = await Promise.all([
    resolvePartnerSignupViewer(),
    getPartnersBotProtectionPublic(),
    headers(),
    getSiteSettings(),
    getServerAffiliatesCopy({ locale: route.siteLocale, dictionary: PARTNERS_PAGE_COPY }),
    getPublicAffiliatesProgramSettings(),
  ]);
  const nonce = requestHeaders.get('x-nonce') || undefined;
  // The signup checkbox's terms: the operator's page for this language, else the built-in terms of
  // the language the page rendered in (the projection carries no override on the sandbox).
  const termsHref = partnersTermsHref(route.locale, programSettings);
  const { model } = route;
  const jsonLd = buildPartnersJsonLd({ t, model, url: absoluteUrl(route.canonicalPath), siteTitle });

  return (
    <>
      <script
        type="application/ld+json"
        nonce={nonce}
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: stringifyJsonLd(jsonLd) }}
      />
      {/* No CMS document behind this route: the language switcher goes to the address of the chosen language. */}
      <CurrentContentSetter id={null} type={null} slug={null} localePaths={route.paths} />
      {isPartnersSandbox() ? <PartnersSandboxGuide t={t} locale={route.locale} /> : null}
      <PartnersLandingView
        t={t}
        model={model}
        // Copy only: an unreadable projection shows the settings' default wording (automatic payouts
        // are on until the operator turns them off). The payout runner itself fails closed.
        autoPayouts={programSettings ? programSettings.autoPayoutsEnabled : true}
        calculator={model.calculator ? <PartnerRevenueCalculator {...model.calculator} /> : null}
        signup={
          <PartnerSignupForm
            viewer={viewer}
            signupAction={submitPartnerSignup}
            checkHandleAction={checkPartnerHandleAvailability}
            storefrontPrefix={storefrontPrefix()}
            botProtection={botProtection}
            scriptNonce={nonce}
            signupOpen={model.signupOpen}
            signInHref={`/sign-in?redirect=${encodeURIComponent(path)}`}
            twoFactorHref={`/two-factor?redirect_to=${encodeURIComponent(path)}`}
            portalHref={AFFILIATE_PORTAL_PATH}
            termsHref={termsHref}
          />
        }
      />
    </>
  );
}
