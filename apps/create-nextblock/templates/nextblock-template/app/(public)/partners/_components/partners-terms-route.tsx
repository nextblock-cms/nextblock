import 'server-only';

import { cache } from 'react';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import {
  AFFILIATES_COMMON_COPY,
  AFFILIATES_TERMS_COPY,
  AFFILIATE_PARTNERS_TERMS_PATH,
  AFFILIATE_PARTNERS_TERMS_PATH_FR,
  AFFILIATE_TERMS_VERSION,
  affiliateTierDisplayName,
  formatAffiliateMoney,
  normalizeAffiliatePayoutMethods,
  type AffiliateLocale,
  type AffiliatesCopyTranslate,
  type AffiliateTierRow,
} from '@nextblock-cms/affiliates';
import { CurrentContentSetter } from '../../../../components/CurrentContentSetter';
import {
  PARTNERS_TERMS_BUILTIN_PARAM,
  buildPartnersTermsLocalePaths,
  isBuiltInPartnersTermsTarget,
  partnersHreflangPaths,
  partnersTermsOverrideForLocale,
  type PartnersLocalePaths,
} from '../../../../lib/affiliates/partners-paths';
import { getActiveRequestLanguages, getRequestLocale, toAffiliatesLocale } from '../../../../lib/affiliates/request-locale';
import { getServerAffiliatesCopy } from '../../../../lib/affiliates/server-copy';
import {
  getPublicAffiliatesProgramSettings,
  type AffiliatesPublicProgramSettings,
} from '../../../../lib/affiliates/settings';
import { getAffiliateStoreBaseCurrency, getPublicAffiliateTiers } from '../../../../lib/affiliates/storefront-data';
import { loadAffiliateTermsOperatorIdentity } from '../../../../lib/affiliates/terms-identity';
import { getCmsActor } from '../../../../lib/auth/cms-actor';
import { getCachedTranslations } from '../../../../lib/i18n/cached-translations';
import { resolveSiteUrl } from '../../../../lib/site-url';
import { buildSocialMetadata, toOpenGraphLocale } from '../../../lib/seo';
import { getSiteSettings } from '../../../lib/site-settings';
import { isAffiliatesPackageActive } from './package-gate';
import { PartnersTermsView, type PartnersTermsModel, type PartnersTermsTierRow } from './partners-terms-view';

/**
 * The built-in partner terms, shared by their two addresses like the landing page
 * (`partners-route.tsx`): `/partners/terms` in the visitor's language and `/partenaires/conditions`
 * always in French (the proxy pins the request locale on `/partenaires` and below). Each declares
 * the canonical URL of the language it rendered in and, while both exist and neither language has
 * the operator's own page, hreflang `en` / `fr` / `x-default` (the sitemap's rule: an alternate
 * that redirects away is no alternate).
 *
 * - While the program is inactive (`isAffiliatesProgramActive()`, through the package gate) both
 *   answer 404, and so does `/partenaires/conditions` when French is not an active language.
 * - When the operator links their own terms page for the rendered language (CMS → Affiliates →
 *   Program settings; French falls back to the English page) the address redirects there. Only a
 *   signed-in ADMIN who asks with `?builtin=1` (the CMS preview link) sees the built-in terms
 *   instead, marked noindex: the replaced template names the operator as a party, so it stays off
 *   the public web. The public settings projection carries no override on the sandbox, so nothing
 *   redirects there.
 * - Everything is React text: the clauses from the `affiliates.terms.*` copy, `{company}` the legal
 *   name from the privacy settings (else the site title), the contact address from the privacy
 *   settings like the `{{privacy_email}}` merge tag (left out when there is none; both through
 *   `lib/affiliates/terms-identity.ts`), and the live "Program details" table (tiers, minimum
 *   payout, payout method and schedule; since 02036 the method per kind of sale, from the public
 *   projection's `payoutMethods`, and no payout row at all when the settings cannot be read).
 */

export type PartnersTermsRoutePath = typeof AFFILIATE_PARTNERS_TERMS_PATH | typeof AFFILIATE_PARTNERS_TERMS_PATH_FR;

export interface PartnersTermsRouteProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

interface PartnersTermsRouteData {
  siteLocale: string;
  locale: AffiliateLocale;
  paths: PartnersLocalePaths;
  /** The address of the language this request rendered in (site-relative). */
  canonicalPath: string;
}

const TERMS_PAGE_COPY = { ...AFFILIATES_COMMON_COPY, ...AFFILIATES_TERMS_COPY };

/** The consent banner's privacy policy link (ConsentBanner.tsx): a site translation with these fallbacks. */
const PRIVACY_POLICY_HREF_KEY = 'privacy.consent.privacy_policy_href';
const PRIVACY_POLICY_FALLBACK = { en: '/privacy-policy', fr: '/politique-de-confidentialite' } as const;

function intlLocale(locale: AffiliateLocale): string {
  return locale === 'fr' ? 'fr-CA' : 'en-US';
}

/**
 * Shared by `generateMetadata` and the page body (React `cache`: one read per request). Null when
 * the program does not answer this address in this request: `/partenaires/conditions` rendered in
 * anything but French (French is not an active language, so the proxy did not pin it).
 */
const loadPartnersTermsRoute = cache(async (path: PartnersTermsRoutePath): Promise<PartnersTermsRouteData | null> => {
  const [siteLocale, languages] = await Promise.all([getRequestLocale(), getActiveRequestLanguages()]);
  const locale = toAffiliatesLocale(siteLocale);
  if (path === AFFILIATE_PARTNERS_TERMS_PATH_FR && locale !== 'fr') return null;

  const paths = buildPartnersTermsLocalePaths(languages.activeCodes);
  return { siteLocale, locale, paths, canonicalPath: paths[locale] ?? paths['x-default'] };
});

/** The route when the program answers it, else a 404 (package off, or French inactive on the French address). */
async function requirePartnersTermsRoute(path: PartnersTermsRoutePath): Promise<PartnersTermsRouteData> {
  if (!(await isAffiliatesPackageActive())) notFound();
  const route = await loadPartnersTermsRoute(path);
  if (!route) notFound();
  return route;
}

function absoluteUrl(path: string): string {
  return `${resolveSiteUrl()}${path}`;
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Whether an override would send this page to itself, however it is spelled: a built-in terms
 * address as a site path, or as an absolute URL on this site's host (the canonical one or the one
 * the request came in on, `www.` ignored). The rule settings.ts applies on save and read
 * (`isBuiltInPartnersTermsTarget`), plus the request's own host, which only a request knows.
 */
async function pointsAtBuiltInTerms(override: string): Promise<boolean> {
  if (override.startsWith('/')) return isBuiltInPartnersTermsTarget(override, []);
  let requestHost: string | null = null;
  try {
    requestHost = (await headers()).get('host')?.trim().toLowerCase() || null;
  } catch {
    requestHost = null;
  }
  return isBuiltInPartnersTermsTarget(override, [hostOf(resolveSiteUrl()), requestHost]);
}

/** Whether the request carries `?builtin` (any value, even empty). */
async function asksForBuiltInTerms(props: PartnersTermsRouteProps | undefined): Promise<boolean> {
  try {
    const params = (await props?.searchParams) ?? {};
    return Object.prototype.hasOwnProperty.call(params, PARTNERS_TERMS_BUILTIN_PARAM);
  } catch {
    return false;
  }
}

/**
 * `?builtin` honoured: the request asks for it AND comes from a signed-in ADMIN whose second factor
 * is satisfied (`getCmsActor()`: the cookie session, null without one). The CMS "Preview built-in
 * terms" link is the only thing that sends it. Read only when an override would otherwise redirect,
 * so an ordinary visit never touches the session. Never throws.
 */
async function adminPreviewsBuiltInTerms(props: PartnersTermsRouteProps | undefined): Promise<boolean> {
  if (!(await asksForBuiltInTerms(props))) return false;
  try {
    return (await getCmsActor())?.role === 'ADMIN';
  } catch {
    return false;
  }
}

interface PartnersTermsRouteDecision {
  /** Where this request must go instead of the built-in terms, or null to render them. */
  redirectTo: string | null;
  /** The built-in terms render only because an admin previews them while an override replaces them. */
  adminPreview: boolean;
}

async function decidePartnersTermsRoute(
  route: PartnersTermsRouteData,
  settings: AffiliatesPublicProgramSettings | null,
  props: PartnersTermsRouteProps | undefined,
): Promise<PartnersTermsRouteDecision> {
  const override = partnersTermsOverrideForLocale(route.locale, settings);
  if (!override || (await pointsAtBuiltInTerms(override))) return { redirectTo: null, adminPreview: false };
  if (await adminPreviewsBuiltInTerms(props)) return { redirectTo: null, adminPreview: true };
  return { redirectTo: override, adminPreview: false };
}

/**
 * Whether either language's address is replaced by the operator's own page (French falls back to
 * English, so a French override alone counts too). Then the pair is not cross-linked: the sitemap's
 * rule, since an hreflang alternate that redirects away is ignored by search engines.
 */
function partnersTermsReplaced(settings: AffiliatesPublicProgramSettings | null): boolean {
  return Boolean(partnersTermsOverrideForLocale('en', settings) || partnersTermsOverrideForLocale('fr', settings));
}

/** A site path (one leading slash) or an https URL, else null. */
function usableHref(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const href = value.trim();
  if (!href || href.length > 2048 || /[\s\\]/.test(href)) return null;
  if (href.startsWith('/')) return href.startsWith('//') ? null : href;
  return /^https:\/\/[^/]/i.test(href) ? href : null;
}

/**
 * The privacy policy page, resolved the way the consent banner resolves its link: the site
 * translation `privacy.consent.privacy_policy_href` in the page's language, else `/privacy-policy`
 * (`/politique-de-confidentialite` in French). Never throws.
 */
async function resolvePrivacyPolicyHref(siteLocale: string, locale: AffiliateLocale): Promise<string> {
  const fallback = PRIVACY_POLICY_FALLBACK[locale];
  try {
    const rows = await getCachedTranslations();
    const row = Array.isArray(rows) ? rows.find((entry) => entry?.key === PRIVACY_POLICY_HREF_KEY) : undefined;
    const translations =
      row?.translations && typeof row.translations === 'object' && !Array.isArray(row.translations)
        ? (row.translations as Record<string, unknown>)
        : {};
    const code = siteLocale.trim().toLowerCase();
    const base = code.split(/[-_]/)[0] ?? code;
    return usableHref(translations[code]) ?? usableHref(translations[base]) ?? usableHref(translations[locale]) ?? fallback;
  } catch {
    return fallback;
  }
}

/** `30 days` / `0 jour`: French counts 0 and 1 as singular, as Intl.PluralRules says. */
function daysLabel(t: AffiliatesCopyTranslate, locale: AffiliateLocale, count: number): string {
  const one = new Intl.PluralRules(intlLocale(locale)).select(count) === 'one';
  return t(one ? 'affiliates.terms.details_days_one' : 'affiliates.terms.details_days_other', { count });
}

function wholeDays(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

/** The Program details rows: each active tier, by sort order, in the page's language. */
export function buildPartnersTermsTierRows(
  tiers: readonly AffiliateTierRow[],
  locale: AffiliateLocale,
  t: AffiliatesCopyTranslate,
): PartnersTermsTierRow[] {
  const rate = new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: 2 });
  return tiers
    .filter((tier) => tier.is_active)
    .map((tier) => ({
      id: tier.id,
      name: affiliateTierDisplayName(tier, locale),
      commission: t('affiliates.terms.details_rate', {
        rate: rate.format(Number.isFinite(Number(tier.commission_percentage)) ? Number(tier.commission_percentage) : 0),
      }),
      referralWindow: daysLabel(t, locale, wholeDays(tier.cookie_duration_days)),
      hold: daysLabel(t, locale, wholeDays(tier.clearance_hold_days)),
    }));
}

/** `AFFILIATE_TERMS_VERSION` as a date in the page's language (`November 11, 2026` / `11 novembre 2026`). */
export function formatPartnersTermsVersion(locale: AffiliateLocale): string {
  const date = new Date(`${AFFILIATE_TERMS_VERSION}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return AFFILIATE_TERMS_VERSION;
  return new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: 'long', timeZone: 'UTC' }).format(date);
}

export async function buildPartnersTermsRouteMetadata(
  path: PartnersTermsRoutePath,
  props?: PartnersTermsRouteProps,
): Promise<Metadata> {
  const route = await requirePartnersTermsRoute(path);
  const settings = await getPublicAffiliatesProgramSettings();
  const decision = await decidePartnersTermsRoute(route, settings, props);
  if (decision.redirectTo) redirect(decision.redirectTo);

  const [{ siteTitle, socialImage }, t] = await Promise.all([
    getSiteSettings(),
    getServerAffiliatesCopy({ locale: route.siteLocale, dictionary: TERMS_PAGE_COPY }),
  ]);
  const title = t('affiliates.terms.meta_title');
  const description = t('affiliates.terms.meta_description');
  const url = absoluteUrl(route.canonicalPath);
  const hreflang = partnersTermsReplaced(settings) ? null : partnersHreflangPaths(route.paths);

  return {
    title,
    description,
    // An admin's preview of terms their own page replaces: never indexed.
    ...(decision.adminPreview ? { robots: { index: false, follow: false } } : {}),
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

export async function renderPartnersTermsRoute(path: PartnersTermsRoutePath, props?: PartnersTermsRouteProps) {
  const route = await requirePartnersTermsRoute(path);
  const settings = await getPublicAffiliatesProgramSettings();
  const decision = await decidePartnersTermsRoute(route, settings, props);
  if (decision.redirectTo) redirect(decision.redirectTo);

  const [t, tiers, currency, { siteTitle }, privacyHref] = await Promise.all([
    getServerAffiliatesCopy({ locale: route.siteLocale, dictionary: TERMS_PAGE_COPY }),
    getPublicAffiliateTiers(),
    getAffiliateStoreBaseCurrency(),
    getSiteSettings(),
    resolvePrivacyPolicyHref(route.siteLocale, route.locale),
  ]);
  const identity = await loadAffiliateTermsOperatorIdentity(siteTitle);

  const model: PartnersTermsModel = {
    locale: route.locale,
    company: identity.company,
    contactEmail: identity.contactEmail,
    privacyHref,
    version: { iso: AFFILIATE_TERMS_VERSION, label: formatPartnersTermsVersion(route.locale) },
    tiers: buildPartnersTermsTierRows(tiers, route.locale, t),
    currency,
    // The public projection's payout fields only (never the notification addresses); how each kind
    // of sale is paid comes from payoutMethods (02036).
    payouts: settings
      ? {
          minimum: formatAffiliateMoney(settings.minPayoutCents, currency, route.locale),
          schedule: settings.autoPayoutsEnabled ? 'daily' : 'manual',
          methods: normalizeAffiliatePayoutMethods(settings.payoutMethods),
        }
      : null,
  };

  return (
    <>
      {/* No CMS document behind this route: the language switcher goes to the address of the chosen language. */}
      <CurrentContentSetter id={null} type={null} slug={null} localePaths={route.paths} />
      <PartnersTermsView t={t} model={model} />
    </>
  );
}
