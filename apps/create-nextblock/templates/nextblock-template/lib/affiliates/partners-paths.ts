/**
 * The addresses of the partner program's landing page (NextBlock Affiliates): `/partners` follows
 * the visitor's language, `/partenaires` always renders in French. Each language therefore has a
 * URL search engines can index, and the two point at each other with hreflang. The built-in partner
 * terms follow the same pattern: `/partners/terms` and `/partenaires/conditions`.
 *
 * Dependency-free on purpose (no imports at all), like `referral-cookie.ts`: `proxy.ts` pins the
 * French render locale on `/partenaires` and below and may not import a library barrel. The paths
 * mirror `AFFILIATE_PARTNERS_PATH`, `AFFILIATE_PARTNERS_PATH_FR`, `AFFILIATE_PARTNERS_TERMS_PATH` and
 * `AFFILIATE_PARTNERS_TERMS_PATH_FR` from `@nextblock-cms/affiliates`; `partners-paths.test.ts`
 * fails as soon as a copy drifts.
 */

/** Mirror of `AFFILIATE_PARTNERS_PATH`: the landing page in the visitor's language. */
export const PARTNERS_LANDING_PATH = '/partners';

/** Mirror of `AFFILIATE_PARTNERS_PATH_FR`: the landing page, always in French. */
export const PARTNERS_LANDING_PATH_FR = '/partenaires';

export type PartnersLandingPath = typeof PARTNERS_LANDING_PATH | typeof PARTNERS_LANDING_PATH_FR;

/** Mirror of `AFFILIATE_PARTNERS_TERMS_PATH`: the built-in partner terms in the visitor's language. */
export const PARTNERS_TERMS_PATH = '/partners/terms';

/** Mirror of `AFFILIATE_PARTNERS_TERMS_PATH_FR`: the built-in partner terms, always in French. */
export const PARTNERS_TERMS_PATH_FR = '/partenaires/conditions';

export type PartnersTermsPath = typeof PARTNERS_TERMS_PATH | typeof PARTNERS_TERMS_PATH_FR;

/**
 * Query parameter that keeps a terms address on the built-in terms while the operator links their
 * own page (CMS "Preview built-in terms"). The terms route honours it for a signed-in ADMIN only;
 * everyone else, and every request without it, is redirected to that page.
 */
export const PARTNERS_TERMS_BUILTIN_PARAM = 'builtin';

/**
 * True on the program's French addresses: `/partenaires` and every path below it
 * (`/partenaires/conditions`), never `/partenairesx`. proxy.ts pins the French render locale there.
 */
export function isFrenchPartnersPath(pathname: unknown): boolean {
  if (typeof pathname !== 'string') return false;
  return pathname === PARTNERS_LANDING_PATH_FR || pathname.startsWith(`${PARTNERS_LANDING_PATH_FR}/`);
}

/**
 * hreflang map of the landing page: `en` (the `/partners` URL, which serves every language that is
 * not French), `fr` and `x-default`. A key is present only when the program serves that URL in
 * that language; `x-default` always is. A type alias (not an interface) so it is assignable to a
 * plain string record (CurrentContent.localePaths).
 */
export type PartnersLocalePaths = {
  en?: string;
  fr?: string;
  'x-default': string;
};

/** True for a French site language code (`fr`, `fr-CA`, `FR_ca`...). */
export function isFrenchLanguageCode(code: unknown): boolean {
  if (typeof code !== 'string') return false;
  const normalized = code.trim().toLowerCase();
  return normalized === 'fr' || normalized.startsWith('fr-') || normalized.startsWith('fr_');
}

function cleanCodes(activeCodes: readonly unknown[] | null | undefined): string[] {
  if (!Array.isArray(activeCodes)) return [];
  return activeCodes.filter((code): code is string => typeof code === 'string' && code.trim() !== '').map((code) => code.trim());
}

/**
 * The site language `/partenaires` renders in: the first active French code as the table stores it,
 * or null when French is not an active language. An unknown list (null or empty: languages
 * unreadable) answers `fr`, the proxy's and the root layout's fallback languages being en and fr.
 */
export function frenchPartnersLocale(activeCodes: readonly unknown[] | null | undefined): string | null {
  const codes = cleanCodes(activeCodes);
  if (codes.length === 0) return 'fr';
  return codes.find((code) => isFrenchLanguageCode(code)) ?? null;
}

/**
 * The landing page's URL per copy language for the site's active languages: `en` → `/partners`
 * while some active language is not French, `fr` → `/partenaires` while French is active, and
 * `x-default` → the English URL when there is one. An unknown list (null or empty) gives both.
 */
export function buildPartnersLocalePaths(activeCodes: readonly unknown[] | null | undefined): PartnersLocalePaths {
  const codes = cleanCodes(activeCodes);
  const hasFrench = codes.length === 0 || codes.some((code) => isFrenchLanguageCode(code));
  const hasOther = codes.length === 0 || codes.some((code) => !isFrenchLanguageCode(code));
  const en = hasOther ? PARTNERS_LANDING_PATH : undefined;
  const fr = hasFrench ? PARTNERS_LANDING_PATH_FR : undefined;
  return {
    ...(en ? { en } : {}),
    ...(fr ? { fr } : {}),
    'x-default': en ?? fr ?? PARTNERS_LANDING_PATH,
  };
}

/** The landing page URL a visitor of this site language should be sent to. */
export function partnersPathForLocale(locale: unknown): PartnersLandingPath {
  return isFrenchLanguageCode(locale) ? PARTNERS_LANDING_PATH_FR : PARTNERS_LANDING_PATH;
}

/**
 * The paths the program itself answers while the package is active, so a CMS page with one of
 * those slugs is not reachable there (and must not be advertised): `/partners` always, and
 * `/partenaires` while French is an active language.
 */
export function partnersProgramOwnedPaths(paths: PartnersLocalePaths): string[] {
  return paths.fr ? [PARTNERS_LANDING_PATH, PARTNERS_LANDING_PATH_FR] : [PARTNERS_LANDING_PATH];
}

/**
 * The hreflang alternates of the landing page (site-relative): `{ en, fr, x-default }` while it has
 * both addresses, else null (one address: nothing to cross-link).
 */
export function partnersHreflangPaths(paths: PartnersLocalePaths): Record<'en' | 'fr' | 'x-default', string> | null {
  return paths.en && paths.fr ? { en: paths.en, fr: paths.fr, 'x-default': paths['x-default'] } : null;
}

/**
 * The built-in terms' URL per copy language, in step with the landing page
 * ({@link buildPartnersLocalePaths}): `en` → `/partners/terms` while some active language is not
 * French, `fr` → `/partenaires/conditions` while French is active, and `x-default` the terms address
 * of the landing page's `x-default`.
 */
export function buildPartnersTermsLocalePaths(activeCodes: readonly unknown[] | null | undefined): PartnersLocalePaths {
  const landing = buildPartnersLocalePaths(activeCodes);
  return {
    ...(landing.en ? { en: PARTNERS_TERMS_PATH } : {}),
    ...(landing.fr ? { fr: PARTNERS_TERMS_PATH_FR } : {}),
    'x-default': landing['x-default'] === PARTNERS_LANDING_PATH_FR ? PARTNERS_TERMS_PATH_FR : PARTNERS_TERMS_PATH,
  };
}

/** The built-in terms a visitor of this site language is sent to. */
export function partnersTermsPathForLocale(locale: unknown): PartnersTermsPath {
  return isFrenchLanguageCode(locale) ? PARTNERS_TERMS_PATH_FR : PARTNERS_TERMS_PATH;
}

/** Base for resolving a bare path with the URL parser (never requested). */
const PATH_RESOLUTION_BASE = 'https://path.invalid';

/**
 * A path as a browser or the server would end up routing it, for comparisons: percent-escapes of
 * ASCII decoded (three rounds at most, for double encoding; `?` and `#` stay escaped), backslashes
 * read as slashes, runs of slashes collapsed (Next answers `//` with a 308 to the collapsed path),
 * `.` and `..` segments resolved (browsers resolve them in a `Location` header), trailing slashes
 * dropped (another 308), lowercase. Null when the URL parser refuses it. Never throws.
 */
function comparablePath(path: string): string | null {
  let decoded = path;
  for (let round = 0; round < 3; round += 1) {
    const next = decoded.replace(/%([0-7][0-9a-f])/gi, (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    if (next === decoded) break;
    decoded = next;
  }
  const slashed = decoded
    .replace(/[?#]/g, (character) => encodeURIComponent(character))
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/');
  try {
    return new URL(slashed, PATH_RESOLUTION_BASE).pathname.replace(/\/+$/, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True when a site path names a built-in terms address however it is spelled: query, fragment,
 * trailing slashes and case ignored, and `/partners//terms`, `/partners/./terms`,
 * `/partenaires/../partners/terms` or `/partners/%74erms` read as the address they reach. An
 * operator "override" that points there would redirect the terms page to itself (a loop). A path
 * the URL parser refuses counts too, so it never becomes a redirect target.
 */
export function isBuiltInPartnersTermsPath(path: unknown): boolean {
  if (typeof path !== 'string') return false;
  const trimmed = path.trim();
  if (!trimmed.startsWith('/') && !trimmed.startsWith('\\')) return false;
  const comparable = comparablePath(trimmed.split(/[?#]/, 1)[0] ?? '');
  return comparable === null || comparable === PARTNERS_TERMS_PATH || comparable === PARTNERS_TERMS_PATH_FR;
}

/** A host for comparisons: lowercase, without a trailing dot or a leading `www.`; null when empty. */
function comparableHost(host: unknown): string | null {
  if (typeof host !== 'string') return null;
  const normalized = host.trim().toLowerCase().replace(/\.(?=$|:)/, '');
  if (!normalized) return null;
  return normalized.startsWith('www.') ? normalized.slice(4) : normalized;
}

/**
 * True when following an override would bring the visitor back to a built-in terms address: a site
 * path naming one ({@link isBuiltInPartnersTermsPath}), or an absolute URL on one of `siteHosts`
 * (`www.` ignored on both sides, since one usually redirects to the other) whose path names one. A
 * value the URL parser refuses counts too. Save, read and the terms route all apply this rule.
 */
export function isBuiltInPartnersTermsTarget(url: unknown, siteHosts: readonly unknown[]): boolean {
  if (typeof url !== 'string') return false;
  const value = url.trim();
  if (!value) return false;
  if (value.startsWith('/') || value.startsWith('\\')) return isBuiltInPartnersTermsPath(value);
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    return true;
  }
  if (!isBuiltInPartnersTermsPath(target.pathname)) return false;
  const host = comparableHost(target.host);
  return host !== null && siteHosts.some((candidate) => comparableHost(candidate) === host);
}

/** The operator's own terms pages as the public settings projection carries them (`''` = none). */
export interface PartnersTermsOverrides {
  termsUrlEn?: string | null;
  termsUrlFr?: string | null;
}

/**
 * A stored override, kept only when it still has the shape lib/affiliates/settings.ts accepted (a
 * site path with one leading slash, or an https URL, percent-encoded to printable ASCII, at most
 * 2,048 characters). That module is the validator; this is the last check before a value becomes a
 * link or a redirect (Node refuses a `Location` header with a character above U+00FF: a 500).
 */
function usableTermsOverride(value: unknown): string {
  if (typeof value !== 'string') return '';
  const url = value.trim();
  if (!url || url.length > 2048 || /[^\x21-\x7e]|\\/.test(url)) return '';
  return (url.startsWith('/') && !url.startsWith('//')) || url.toLowerCase().startsWith('https://') ? url : '';
}

/**
 * The operator's terms page for a copy language, or `''` when the built-in terms apply: French
 * reads `termsUrlFr`, then falls back to `termsUrlEn`; every other language reads `termsUrlEn`.
 * The settings projection is already `''` on the public sandbox.
 */
export function partnersTermsOverrideForLocale(locale: unknown, overrides: PartnersTermsOverrides | null | undefined): string {
  const en = usableTermsOverride(overrides?.termsUrlEn);
  return isFrenchLanguageCode(locale) ? usableTermsOverride(overrides?.termsUrlFr) || en : en;
}

/** Where a partner terms link points in this copy language: the operator's page, else the built-in terms. */
export function partnersTermsHref(locale: unknown, overrides: PartnersTermsOverrides | null | undefined): string {
  return partnersTermsOverrideForLocale(locale, overrides) || partnersTermsPathForLocale(locale);
}
