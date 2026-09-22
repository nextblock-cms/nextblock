import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@nextblock-cms/db';
import {
  buildRedirectIndex,
  matchRedirect,
  type RedirectRule,
} from '@nextblock-cms/utils/seo';
import { resolveSupabaseAnonKey, resolveSupabaseUrl } from './lib/setup/env-status';
import {
  fetchActiveRedirects,
  isSchemaMissingError,
  isSelfRedirect,
  resolveRedirectTarget,
  shouldSkipRedirectLookup,
} from './lib/seo/redirect-store';
import {
  LANGUAGE_DETECTION_SETTING_KEY,
  DEFAULT_LANGUAGE_DETECTION_SETTINGS,
  getCountryFromRequestHeaders,
  normalizeLanguageDetectionSettings,
  resolveDetectedLocale,
  type LanguageDetectionSettings,
} from './lib/i18n/detection';

type Profile = Database['public']['Tables']['profiles']['Row'];
type UserRole = Database['public']['Enums']['user_role'];

const LANGUAGE_COOKIE_KEY = 'NEXT_USER_LOCALE';
// Fallbacks used only when the languages table can't be read (unprovisioned
// instance, transient DB error). The live language list comes from the DB.
const DEFAULT_LOCALE = 'en';
const FALLBACK_LOCALES = ['en', 'fr'];
const LANGUAGE_COOKIE_MAX_AGE_SECONDS = 31_536_000;
const cacheLoggingEnabled = process.env.NEXTBLOCK_CACHE_LOGGING_ENABLED === 'true';

const cmsRoutePermissions: Record<string, UserRole[]> = {
  '/cms': ['WRITER', 'ADMIN'],
  '/cms/admin': ['ADMIN'],
  '/cms/users': ['ADMIN'],
  '/cms/settings': ['ADMIN'],
};

const securityHeaders = [
  ['X-DNS-Prefetch-Control', 'on'],
  ['Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload'],
  ['X-Frame-Options', 'SAMEORIGIN'],
  ['X-Content-Type-Options', 'nosniff'],
  ['Referrer-Policy', 'strict-origin-when-cross-origin'],
  ['Permissions-Policy', 'camera=(), microphone=(), geolocation=()'],
  ['Cross-Origin-Opener-Policy', 'same-origin'],
] as const;

function getRequiredRolesForPath(pathname: string): UserRole[] | null {
  const sortedPaths = Object.keys(cmsRoutePermissions).sort(
    (a, b) => b.length - a.length,
  );
  for (const specificPath of sortedPaths) {
    if (
      pathname === specificPath ||
      pathname.startsWith(specificPath + (specificPath === '/' ? '' : '/'))
    ) {
      return cmsRoutePermissions[specificPath];
    }
  }
  return null;
}

/**
 * Paths that must stay reachable while the instance is unprovisioned: the wizard,
 * its server actions/APIs, the auth callback, and framework internals. Everything
 * else is redirected to /setup until a first admin exists.
 */
function isSetupAllowlisted(pathname: string): boolean {
  return (
    pathname === '/setup' ||
    pathname.startsWith('/setup/') ||
    pathname.startsWith('/api/setup') ||
    // The MCP endpoint authenticates every call itself (bearer token / admin session)
    // and answers 503 while unconfigured. Letting it through means a coding agent gets a
    // JSON error it can act on instead of a 307 to the HTML wizard.
    pathname === '/api/mcp' ||
    pathname.startsWith('/auth/') ||
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/favicon') ||
    // Bundled public image assets (the site logo, marketing art). These are referenced by
    // the public chrome AND transactional-email templates, and the Next Image optimizer
    // fetches them server-side WITHOUT an auth cookie — so if the gate bounced them to
    // /setup the optimizer would receive a redirect instead of image bytes and the logo
    // would render broken ("isn't a valid image … received null"). Always serve them.
    pathname.startsWith('/images/') ||
    // The web app manifest and the public brand images (app icons, the auth-email logo).
    // Browsers fetch the manifest and its icons without cookies, so while no admin exists
    // the gate would answer them with the wizard's HTML; each route already falls back to
    // the static NextBlock assets on its own.
    pathname === '/manifest.webmanifest' ||
    pathname.startsWith('/api/brand/') ||
    // Crawler-facing static routes: keep them reachable while unprovisioned so a fresh
    // deploy never redirects robots.txt / the sitemap to /setup (which would let crawlers
    // treat the wizard as the canonical entry point).
    pathname === '/robots.txt' ||
    pathname === '/llms.txt' ||
    // Machine-discovery files (Glama claim, MCP server card, UCP): each route decides for
    // itself what to serve, and a redirect to the wizard would only confuse a crawler.
    pathname.startsWith('/.well-known/') ||
    pathname.startsWith('/sitemap')
  );
}

// Module-level cache for the "has the first admin been created?" flag. Middleware
// modules persist across requests in a worker, so this avoids a per-request DB hit.
let provisionedAdminCache: { value: boolean; expires: number } | null = null;

// `isSchemaMissingError` used to be defined right here, as a private copy. It now
// lives in ./lib/seo/redirect-store and is imported above, because the redirect
// lookup needs exactly the same test — "did this error mean the table is absent,
// or merely that the database is having a bad minute?" — and a predicate that
// decides whether a whole site funnels its traffic to /setup must have one
// definition. The reasoning behind the specific codes it looks for (42P01,
// PGRST205, and the message sniffing underneath) is documented there.

/**
 * Returns true once the system has a first admin (site_settings.is_admin_created).
 * `is_admin_created` is a non-sensitive, anon-readable key, so the request-scoped
 * anon client can read it. Cached aggressively once true (it never reverts) and
 * briefly while false (so the gate releases promptly after the wizard runs).
 * A missing-schema error returns false (unprovisioned → /setup); any OTHER read error
 * fails open (returns true) so a transient hiccup never traps the whole site.
 */
async function hasProvisionedAdmin(supabase: SupabaseClient): Promise<boolean> {
  const now = Date.now();
  if (provisionedAdminCache && provisionedAdminCache.expires > now) {
    return provisionedAdminCache.value;
  }

  try {
    const { data, error } = await supabase
      .from('site_settings')
      .select('value')
      .eq('key', 'is_admin_created')
      .maybeSingle();

    if (error) {
      // Schema not applied yet → definitively unprovisioned: send traffic to /setup
      // (otherwise the homepage 404s on a fresh deploy because no content exists).
      if (isSchemaMissingError(error)) {
        provisionedAdminCache = { value: false, expires: now + 3_000 };
        return false;
      }
      return true;
    }

    const hasAdmin = data?.value === true || data?.value === 'true';
    // Cache "provisioned" for a long time (it never reverts); keep the unprovisioned
    // window short so the gate releases promptly once the wizard creates the admin.
    provisionedAdminCache = {
      value: hasAdmin,
      expires: now + (hasAdmin ? 10 * 60_000 : 3_000),
    };
    return hasAdmin;
  } catch {
    return true;
  }
}

interface LocaleRuntimeConfig {
  /** Active language codes as configured in the CMS (is_active null counts as active). */
  activeCodes: string[];
  /** The is_default language, falling back to the first active language. */
  defaultCode: string;
  detection: LanguageDetectionSettings;
}

// Module-level cache for the language list + detection settings, mirroring
// provisionedAdminCache: middleware modules persist across requests in a worker,
// so this keeps locale resolution to at most one DB round-trip per minute.
let localeConfigCache: { value: LocaleRuntimeConfig | null; expires: number } | null = null;
// In-flight load shared by concurrent cache misses so a burst of requests right
// after expiry (or on a cold isolate) collapses to a single DB round-trip.
let localeConfigInflight: Promise<LocaleRuntimeConfig | null> | null = null;

async function loadLocaleRuntimeConfig(
  supabase: SupabaseClient,
): Promise<LocaleRuntimeConfig | null> {
  const now = Date.now();
  try {
    const [languagesResult, detectionResult] = await Promise.all([
      supabase.from('languages').select('code, is_default, is_active'),
      supabase
        .from('site_settings')
        .select('value')
        .eq('key', LANGUAGE_DETECTION_SETTING_KEY)
        .maybeSingle(),
    ]);

    const activeLanguages = (languagesResult.data ?? []).filter(
      (language: { is_active: boolean | null }) => language.is_active !== false,
    );
    if (languagesResult.error || activeLanguages.length === 0) {
      localeConfigCache = { value: null, expires: now + 10_000 };
      return null;
    }

    const defaultCode =
      activeLanguages.find((language: { is_default: boolean }) => language.is_default)?.code ??
      activeLanguages[0].code;
    // A missing/failed settings row means "use defaults" — detection must not
    // break just because the setting was never saved.
    const detection = detectionResult.error
      ? { ...DEFAULT_LANGUAGE_DETECTION_SETTINGS }
      : normalizeLanguageDetectionSettings(detectionResult.data?.value);

    const value: LocaleRuntimeConfig = {
      activeCodes: activeLanguages.map((language: { code: string }) => language.code),
      defaultCode,
      detection,
    };
    localeConfigCache = { value, expires: now + 60_000 };
    return value;
  } catch {
    localeConfigCache = { value: null, expires: now + 10_000 };
    return null;
  }
}

/**
 * Loads the active languages and the admin-configured detection settings
 * (site_settings.language_detection_settings — non-sensitive, anon-readable).
 * Returns null when the DB can't answer (unprovisioned/transient error); the
 * caller then falls back to the legacy hardcoded locale behavior. Results (and
 * failures) are cached briefly so an outage never adds per-request queries, and
 * concurrent misses share one in-flight load.
 */
function getLocaleRuntimeConfig(
  supabase: SupabaseClient,
): Promise<LocaleRuntimeConfig | null> {
  if (localeConfigCache && localeConfigCache.expires > Date.now()) {
    return Promise.resolve(localeConfigCache.value);
  }
  if (!localeConfigInflight) {
    localeConfigInflight = loadLocaleRuntimeConfig(supabase).finally(() => {
      localeConfigInflight = null;
    });
  }
  return localeConfigInflight;
}

// ---------------------------------------------------------------------------
// Managed redirects
// ---------------------------------------------------------------------------
//
// Operator-authored 301/302 rules live in public.cms_redirects and are resolved
// here rather than in next.config.js, because a redirect is content: an editor who
// renames a slug needs the old URL to keep working immediately, without a redeploy.
// The trade is that every request now potentially needs a database answer, so the
// caching below is not an optimisation — it is the thing that makes the feature
// affordable at all.
//
// The cache mirrors localeConfigCache/localeConfigInflight deliberately, right down
// to the shape of the value and the `.finally()` that clears the in-flight handle.
// Proxy modules persist across requests inside a worker, so a module-level entry is
// shared by every request that worker serves; the in-flight promise is what stops a
// burst of concurrent misses (a cold worker taking a page's document plus its
// subresources) from turning into a burst of identical queries.
//
// Two TTLs, because the two outcomes mean different things. A successful read —
// including a successful read of an EMPTY table, which is what almost every site
// will have — is cached for 60s: rules change at human speed and a minute of
// staleness after an operator saves one is acceptable. A failure is cached for only
// 10s, because the most likely cause is an install that has pulled this code but
// not yet run `npm run db:migrate`, and after that migration lands redirects should
// start working within seconds rather than after a full minute of a poisoned cache.
const REDIRECT_CACHE_TTL_MS = 60_000;
const REDIRECT_NEGATIVE_CACHE_TTL_MS = 10_000;

// `null` here means "we could not read the table", which is not the same as an
// empty Map ("we read it and there are no rules"). Only the empty Map earns the
// long TTL.
let redirectIndexCache: { value: Map<string, RedirectRule> | null; expires: number } | null = null;
let redirectIndexInflight: Promise<Map<string, RedirectRule> | null> | null = null;

// The cookie-bound client built inside `proxy()` cannot be used for this lookup: it
// is constructed further down, after the redirect check has already had to decide.
// So this is a plain anon client, mirroring libs/db/src/lib/supabase/ssg-client.ts —
// no cookies, no session persistence, no token refresh, because reading a public
// table needs none of that and every one of those features would add work to a path
// that runs in front of the whole site. It is memoised for the life of the worker
// alongside the credentials it was built from, so a cache hit constructs nothing at
// all and a credential change (a redeploy with new env) still rebuilds it.
let redirectLookupClient: { client: SupabaseClient; key: string; url: string } | null = null;

function getRedirectLookupClient(supabaseUrl: string, supabaseAnonKey: string): SupabaseClient {
  if (
    redirectLookupClient &&
    redirectLookupClient.url === supabaseUrl &&
    redirectLookupClient.key === supabaseAnonKey
  ) {
    return redirectLookupClient.client;
  }

  const client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  redirectLookupClient = { client, key: supabaseAnonKey, url: supabaseUrl };
  return client;
}

async function loadRedirectIndex(
  supabaseUrl: string,
  supabaseAnonKey: string,
): Promise<Map<string, RedirectRule> | null> {
  const now = Date.now();
  try {
    const rules = await fetchActiveRedirects(getRedirectLookupClient(supabaseUrl, supabaseAnonKey));

    // fetchActiveRedirects never throws and returns null only for "could not read".
    // That includes the table not existing yet, which is why the negative TTL is
    // short: this is the state a site sits in between deploying the code and
    // running the migration.
    if (rules === null) {
      redirectIndexCache = { value: null, expires: now + REDIRECT_NEGATIVE_CACHE_TTL_MS };
      return null;
    }

    const index = buildRedirectIndex(rules);
    redirectIndexCache = { value: index, expires: now + REDIRECT_CACHE_TTL_MS };
    return index;
  } catch {
    redirectIndexCache = { value: null, expires: now + REDIRECT_NEGATIVE_CACHE_TTL_MS };
    return null;
  }
}

/**
 * Returns the redirect lookup index, or null when the table could not be read.
 *
 * Never rejects: `loadRedirectIndex` swallows everything, so a caller may await this
 * without a try/catch and still be sure a database outage cannot escape into the
 * request pipeline. The caller wraps it anyway, on the principle that a throw
 * anywhere inside the proxy does not break a redirect — it returns a 500 for every
 * page, asset and API route on the site simultaneously.
 */
function getRedirectIndex(
  supabaseUrl: string,
  supabaseAnonKey: string,
): Promise<Map<string, RedirectRule> | null> {
  if (redirectIndexCache && redirectIndexCache.expires > Date.now()) {
    return Promise.resolve(redirectIndexCache.value);
  }
  if (!redirectIndexInflight) {
    redirectIndexInflight = loadRedirectIndex(supabaseUrl, supabaseAnonKey).finally(() => {
      redirectIndexInflight = null;
    });
  }
  return redirectIndexInflight;
}

function getHttpOrigin(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.origin;
    }
  } catch (error) {
    console.error('Invalid URL used while building CSP sources', error);
  }

  return null;
}

function uniqueSources(sources: Array<string | null | undefined>): string[] {
  return Array.from(new Set(sources.filter(Boolean) as string[]));
}

function createDirective(name: string, sources: Array<string | null | undefined>): string {
  return `${name} ${uniqueSources(sources).join(' ')}`;
}

function getAssetSources(): string[] {
  const sources: string[] = [];
  const r2BaseOrigin = getHttpOrigin(process.env.NEXT_PUBLIC_R2_BASE_URL);
  const r2PublicOrigin = getHttpOrigin(process.env.NEXT_PUBLIC_R2_PUBLIC_URL);

  if (r2BaseOrigin) {
    sources.push(r2BaseOrigin);
  }

  if (r2PublicOrigin) {
    sources.push(r2PublicOrigin);
  }

  if (r2PublicOrigin && process.env.R2_BUCKET_NAME) {
    const parsed = new URL(r2PublicOrigin);
    sources.push(`${parsed.protocol}//${process.env.R2_BUCKET_NAME}.${parsed.hostname}`);
  }

  return uniqueSources(sources);
}

function applySecurityHeaders(
  response: NextResponse,
  contentSecurityPolicy?: string | null,
): NextResponse {
  for (const [key, value] of securityHeaders) {
    response.headers.set(key, value);
  }

  if (contentSecurityPolicy) {
    response.headers.set('Content-Security-Policy', contentSecurityPolicy);
  }

  return response;
}

/**
 * Every redirect this proxy issues goes through here, so that none of them can
 * accidentally ship without the seven security headers and the CSP. A bare
 * `NextResponse.redirect()` returns a response with none of them.
 *
 * The default status is 307, which is what `NextResponse.redirect()` produces on its
 * own — so adding this parameter changed the behaviour of exactly zero existing call
 * sites. 307 is also the right default for the gates below it: they are all
 * "you cannot be here *right now*" decisions (unprovisioned, signed out, wrong role),
 * and a browser that cached a permanent redirect for those would keep bouncing the
 * user long after they had signed in.
 *
 * Managed content redirects are the exception, and the reason the parameter exists:
 * a 301 is the whole point of "this page moved", because it is the code search
 * engines act on. Only {301, 302, 303, 307, 308} are permitted — Next throws
 * RangeError E529 for anything else — which is also why `RedirectStatusCode` is
 * narrowed to 301 | 302 upstream rather than being an open `number`.
 */
function createRedirectResponse(
  url: URL,
  contentSecurityPolicy?: string | null,
  status = 307,
): NextResponse {
  return applySecurityHeaders(NextResponse.redirect(url, status), contentSecurityPolicy);
}

function createContentSecurityPolicy(nonceValue: string, supabaseUrl: string | undefined): string {
  const isDev = process.env.NODE_ENV !== 'production';
  // supabaseUrl is absent on an unconfigured instance (pre-/setup). Build the policy
  // without Supabase origins in that case — uniqueSources() drops the null entries.
  let supabaseOrigin: string | null = null;
  let supabaseRealtimeOrigin: string | null = null;
  if (supabaseUrl) {
    try {
      const parsedSupabaseUrl = new URL(supabaseUrl);
      supabaseOrigin = parsedSupabaseUrl.origin;
      supabaseRealtimeOrigin = `${parsedSupabaseUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${parsedSupabaseUrl.host}`;
    } catch {
      // malformed URL — treat as unconfigured for CSP purposes
    }
  }
  const assetSources = getAssetSources();

  const googleSources = [
    'https://www.googletagmanager.com',
    'https://*.googletagmanager.com',
    'https://www.google-analytics.com',
    'https://*.google-analytics.com',
    'https://analytics.google.com',
    'https://stats.g.doubleclick.net',
  ];

  const vercelSources = [
    'https://vercel.live',
    'https://vercel.com',
    'https://assets.vercel.com',
    'https://vitals.vercel-insights.com',
    'https://*.vercel-insights.com',
  ];
  const vercelToolbarConnectSources = ['wss://ws-us3.pusher.com'];
  const turnstileSources = ['https://challenges.cloudflare.com'];
  // Google reCAPTCHA: api.js is served from www.google.com, the widget worker from
  // www.gstatic.com, and the challenge/badge iframe + verification calls hit
  // www.google.com/recaptcha. Needed by both the bot-protected contact forms and
  // the signup page when the reCAPTCHA provider is selected.
  const recaptchaSources = ['https://www.google.com', 'https://www.gstatic.com'];

  const developmentHttpSources = isDev
    ? [
        'http://localhost:*',
        'https://localhost:*',
        'http://127.0.0.1:*',
      ]
    : [];
  const developmentConnectSources = isDev
    ? [
        ...developmentHttpSources,
        'ws://localhost:*',
        'wss://localhost:*',
        'ws://127.0.0.1:*',
      ]
    : [];

  const directives = [
    createDirective('default-src', ["'self'"]),
    createDirective(
      'script-src',
      isDev
        ? [
            "'self'",
            `'nonce-${nonceValue}'`,
            "'unsafe-inline'",
            "'unsafe-eval'",
            'blob:',
            'data:',
            ...vercelSources,
            ...turnstileSources,
            ...recaptchaSources,
            ...developmentHttpSources,
          ]
        : [
            "'self'",
            `'nonce-${nonceValue}'`,
            'blob:',
            ...googleSources,
            ...vercelSources,
            ...turnstileSources,
            ...recaptchaSources,
          ],
    ),
    createDirective('script-src-attr', ["'none'"]),
    createDirective('style-src', [
      "'self'",
      "'unsafe-inline'",
      'https://vercel.live',
      'https://vercel.com',
    ]),
    createDirective('img-src', [
      "'self'",
      'data:',
      'blob:',
      // Allow any https image source. NextBlock lets trusted ADMIN/WRITER authors
      // embed external image URLs (e.g. AI-inserted stock photos from Unsplash/
      // Pexels, or any pasted https image). Images cannot execute code, so this is
      // a low-risk relaxation; script/style/connect stay strict.
      'https:',
      supabaseOrigin,
      ...assetSources,
      'https://checkout.freemius.com',
      ...googleSources,
      ...vercelSources,
      ...recaptchaSources,
      ...developmentHttpSources,
    ]),
    createDirective('font-src', [
      "'self'",
      'data:',
      'https://vercel.live',
      'https://assets.vercel.com',
    ]),
    createDirective('connect-src', [
      "'self'",
      supabaseOrigin,
      supabaseRealtimeOrigin,
      ...assetSources,
      ...googleSources,
      ...vercelSources,
      ...vercelToolbarConnectSources,
      ...turnstileSources,
      ...recaptchaSources,
      ...developmentConnectSources,
    ]),
    createDirective('frame-src', [
      "'self'",
      'blob:',
      'data:',
      'https://checkout.freemius.com',
      'https://www.youtube.com',
      'https://www.youtube-nocookie.com',
      'https://player.vimeo.com',
      'https://vercel.live',
      'https://vercel.com',
      ...turnstileSources,
      ...recaptchaSources,
    ]),
    createDirective('media-src', ["'self'", 'data:', 'blob:', supabaseOrigin, ...assetSources]),
    createDirective('worker-src', ["'self'", 'blob:']),
    createDirective('manifest-src', ["'self'"]),
    createDirective('object-src', ["'none'"]),
    createDirective('base-uri', ["'self'"]),
    createDirective('form-action', ["'self'"]),
    createDirective('frame-ancestors', ["'self'"]),
    isDev ? null : 'upgrade-insecure-requests',
  ];

  return directives.filter(Boolean).join('; ');
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // Resolve Supabase creds under every alias the Vercel integration may inject (prefixed,
  // non-prefixed, and the new publishable key) so the gate doesn't bounce a configured
  // deploy to /setup just because the credentials arrived under a different name.
  const supabaseUrl = resolveSupabaseUrl();
  const supabaseAnonKey = resolveSupabaseAnonKey();
  const configured = Boolean(supabaseUrl && supabaseAnonKey);
  process.env.NEXTBLOCK_UNCONFIGURED = configured ? 'false' : 'true';

  const requestHeaders = new Headers(request.headers);
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const contentSecurityPolicy = createContentSecurityPolicy(nonce, supabaseUrl);

  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('x-nextblock-path', pathname);
  if (contentSecurityPolicy) {
    requestHeaders.set('Content-Security-Policy', contentSecurityPolicy);
  }

  const allowlisted = isSetupAllowlisted(pathname);

  // First-boot setup gate (unconfigured): no Supabase env yet, so the browser /setup
  // wizard is the only thing that can run. Let allowlisted paths render with the
  // nonce/CSP applied; redirect everything else to /setup. No Supabase work happens.
  if (!configured) {
    if (allowlisted) {
      return applySecurityHeaders(
        NextResponse.next({ request: { headers: requestHeaders } }),
        contentSecurityPolicy,
      );
    }
    return createRedirectResponse(new URL('/setup', request.url), contentSecurityPolicy);
  }

  // Managed redirects, resolved before anything else touches Supabase.
  //
  // The position of this block is the point. It sits after the unconfigured gate
  // (there is no database to ask before that) and before `supabase.auth.getSession()`,
  // so a visitor following a dead link is answered with a 301 without the proxy
  // having spent a session round-trip and a user lookup on a request whose response
  // body is empty. It also sits before the CMS role checks, which is harmless
  // because `shouldSkipRedirectLookup` refuses to consider /cms at all.
  //
  // The whole block is wrapped in try/catch and fails open. There is no such thing
  // as a redirect important enough to justify a throw here: the proxy runs in front
  // of every route in the app, so an exception escaping this block would return a
  // 500 for the entire site rather than for one stale URL.
  if (!shouldSkipRedirectLookup(pathname)) {
    try {
      const redirectIndex = await getRedirectIndex(
        supabaseUrl as string,
        supabaseAnonKey as string,
      );
      const rule = redirectIndex ? matchRedirect(redirectIndex, pathname) : null;

      if (rule) {
        // A destination is either a site-relative path or an absolute https URL —
        // the database CHECK constraint allows nothing else. Resolving the relative
        // form against `request.url` preserves the incoming scheme and host, so a
        // rule works identically on localhost, on a preview deployment and in
        // production without the operator ever writing an origin. The resolution
        // (including whether the visitor's query string travels with them, and what
        // to do about a destination the URL parser cannot make sense of) lives in
        // `resolveRedirectTarget` because it is ordinary logic that deserves ordinary
        // tests, and this function body cannot be given any.
        const target = resolveRedirectTarget(rule.destinationPath, {
          search: request.nextUrl.search,
          url: request.url,
        });

        // `null` means the stored destination does not parse as a URL at all, which
        // is a broken rule rather than a broken request: skip it and let the page
        // render, the same outcome the catch below produces.
        if (target) {
          // Runtime loop guard. `validateRedirectRule` already rejects cycles when a
          // rule is saved and the table forbids source = destination, but neither
          // catches a pair that differs only by normalisation (`/about` -> `/about/`),
          // and neither can see a rule that was inserted straight into the database.
          // A same-path redirect is an infinite loop in the visitor's browser, so it
          // is checked here, against the resolved URL, every single time. Only paths
          // on this origin can loop; an off-site destination is somebody else's
          // problem by definition.
          //
          // Both sides of this comparison are pathnames, which is why carrying the
          // query onto `target` cannot change its answer: `URL.pathname` never
          // contains a query string. Comparing anything wider here — the href, or a
          // path with its search appended — would let a rule that only adds
          // parameters slip past the guard and loop.
          const isSameOrigin = target.origin === request.nextUrl.origin;
          if (!isSameOrigin || !isSelfRedirect(pathname, target.pathname)) {
            const redirectResponse = createRedirectResponse(
              target,
              contentSecurityPolicy,
              rule.statusCode,
            );

            // The proxy sets no Cache-Control on any of its other redirects, which is
            // fine for the auth gates (they must be re-evaluated per request) but wrong
            // here, so this one is explicit. A 301 is permanent by definition and every
            // hop it saves is a request that never reaches the origin, so an hour of
            // shared caching is free value. A 302 gets `no-cache` because a temporary
            // redirect that a browser has cached is an operational trap: the operator
            // deletes the rule, the site behaves correctly for everyone new, and the
            // people who already hit it keep being redirected with no way to tell them
            // apart or fix it.
            //
            // Caching a Location that now varies with the incoming query is safe
            // because caches key on the full request URL: `/old?utm=a` and `/old?utm=b`
            // are separate entries, so neither can be served the other's destination.
            redirectResponse.headers.set(
              'Cache-Control',
              rule.statusCode === 301 ? 'public, max-age=3600' : 'no-cache',
            );

            return redirectResponse;
          }
        }
      }
    } catch (error) {
      // Fail open: log it and let the request render normally.
      console.error(`Proxy: redirect lookup failed for ${pathname}; serving the page.`, error);
    }
  }

  let response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  const supabase = createServerClient(supabaseUrl as string, supabaseAnonKey as string, {
    cookies: {
      get(name: string) {
        return request.cookies.get(name)?.value;
      },
      set(name: string, value: string, options: CookieOptions) {
        request.cookies.set({ name, value, ...options });
        response = NextResponse.next({ request: { headers: requestHeaders } });
        response.cookies.set({ name, value, ...options });
      },
      remove(name: string, options: CookieOptions) {
        request.cookies.set({ name, value: '', ...options });
        response = NextResponse.next({ request: { headers: requestHeaders } });
        response.cookies.set({ name, value: '', ...options });
      },
    },
  });

  await supabase.auth.getSession();

  // Locale resolution needs nothing from the authenticated user, so load the
  // locale config concurrently with the user lookup instead of serially.
  const cookieLocale = request.cookies.get(LANGUAGE_COOKIE_KEY)?.value;
  const [localeConfig, userResult] = await Promise.all([
    getLocaleRuntimeConfig(supabase),
    supabase.auth.getUser(),
  ]);

  let currentLocale: string;
  let rememberVisitorChoice = DEFAULT_LANGUAGE_DETECTION_SETTINGS.rememberVisitorChoice;

  if (localeConfig) {
    rememberVisitorChoice = localeConfig.detection.rememberVisitorChoice;
    if (cookieLocale && localeConfig.activeCodes.includes(cookieLocale)) {
      // An explicit or previously detected choice always wins over detection.
      currentLocale = cookieLocale;
    } else {
      currentLocale = resolveDetectedLocale({
        mode: localeConfig.detection.mode,
        acceptLanguage: request.headers.get('accept-language'),
        countryCode: getCountryFromRequestHeaders(request.headers),
        availableCodes: localeConfig.activeCodes,
        defaultCode: localeConfig.defaultCode,
      });
    }
  } else {
    // Languages unreadable (unprovisioned / transient error): legacy behavior.
    currentLocale =
      cookieLocale && FALLBACK_LOCALES.includes(cookieLocale) ? cookieLocale : DEFAULT_LOCALE;
  }

  requestHeaders.set('X-User-Locale', currentLocale);

  const {
    data: { user },
    error: userError,
  } = userResult;

  // First-boot setup gate (configured but no admin yet, and nobody signed in): funnel
  // anonymous traffic to /setup so the wizard can create the first admin. A logged-in
  // user is proof the system is provisioned, so never gate them — this also prevents a
  // redirect loop in the moment right after the wizard signs the new admin in. Cached
  // + fail-open so a transient status error can't trap the whole site.
  if (!user && !allowlisted && !(await hasProvisionedAdmin(supabase))) {
    return createRedirectResponse(
      new URL('/setup', request.url),
      contentSecurityPolicy,
    );
  }

  if (pathname.startsWith('/cms')) {
    if (userError || !user) {
      return createRedirectResponse(
        new URL(`/sign-in?redirect=${pathname}`, request.url),
        contentSecurityPolicy,
      );
    }

    const requiredRoles = getRequiredRolesForPath(pathname);

    if (requiredRoles && requiredRoles.length > 0) {
      const {
        data: profile,
        error: profileError,
      } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .single<Pick<Profile, 'role'>>();

      if (profileError || !profile) {
        console.error(
          `Proxy: Profile error for user ${user.id} accessing ${pathname}. Error: ${profileError?.message}. Redirecting to unauthorized.`,
        );
        return createRedirectResponse(
          new URL('/unauthorized?error=profile_issue', request.url),
          contentSecurityPolicy,
        );
      }

      const userRole = profile.role as UserRole;
      if (!requiredRoles.includes(userRole)) {
        console.warn(
          `Proxy: User ${user.id} (Role: ${userRole}) denied access to ${pathname}. Required: ${requiredRoles.join(' OR ')}. Redirecting to unauthorized.`,
        );
        return createRedirectResponse(
          new URL(
            `/unauthorized?path=${pathname}&required=${requiredRoles.join(',')}`,
            request.url,
          ),
          contentSecurityPolicy,
        );
      }
    }
  }

  if (
    user &&
    !pathname.startsWith('/cms') &&
    pathname !== '/profile' &&
    pathname !== '/profile/password' &&
    pathname !== '/checkout/success'
  ) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('role, full_name')
      .eq('id', user.id)
      .single<Pick<Profile, 'role' | 'full_name'>>();

    if (profile?.role === 'USER' && !profile.full_name?.trim()) {
      return createRedirectResponse(new URL('/profile', request.url), contentSecurityPolicy);
    }
  }

  if (response.headers.get('location')) {
    return applySecurityHeaders(response, contentSecurityPolicy);
  }

  const finalResponse = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  response.cookies.getAll().forEach((cookie) => {
    finalResponse.cookies.set(cookie.name, cookie.value, cookie);
  });

  // Only persist the locale cookie when we actually resolved it against the DB.
  // If localeConfig is null (unprovisioned / transient DB error) we still stamp
  // X-User-Locale for rendering, but writing the fallback would clobber a
  // returning visitor's valid non-fallback cookie (e.g. 'es') with 'en' for a
  // year — so a transient outage must never overwrite a stored preference.
  const requestCookieLocale = request.cookies.get(LANGUAGE_COOKIE_KEY)?.value;
  // Re-issue when the value changed OR whenever "remember" is off: the request
  // Cookie header carries no expiry, so rewriting a same-value session cookie is
  // the only way to downgrade a previously persistent cookie after an admin
  // turns remembering off (without it, old 1-year cookies would linger).
  if (
    localeConfig &&
    (requestCookieLocale !== currentLocale || !rememberVisitorChoice)
  ) {
    // "Remember visitor's choice" ON -> persist for a year; OFF -> session cookie,
    // so detection runs again on the next browser session while the language still
    // sticks for the current one (switcher + in-session consistency).
    finalResponse.cookies.set(LANGUAGE_COOKIE_KEY, currentLocale, {
      path: '/',
      ...(rememberVisitorChoice ? { maxAge: LANGUAGE_COOKIE_MAX_AGE_SECONDS } : {}),
      sameSite: 'lax',
    });
  }

  if (
    pathname === '/sign-in' ||
    pathname === '/sign-up' ||
    pathname === '/forgot-password'
  ) {
    finalResponse.headers.set('X-Page-Type', 'auth');
    finalResponse.headers.set('X-Prefetch-Priority', 'critical');
  } else if (pathname === '/') {
    finalResponse.headers.set('X-Page-Type', 'home');
    finalResponse.headers.set('X-Prefetch-Priority', 'high');
  } else if (pathname === '/articles') {
    finalResponse.headers.set('X-Page-Type', 'articles-index');
    finalResponse.headers.set('X-Prefetch-Priority', 'high');
  } else if (pathname.startsWith('/article/')) {
    finalResponse.headers.set('X-Page-Type', 'article');
    finalResponse.headers.set('X-Prefetch-Priority', 'medium');
  } else {
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length === 1 && !pathname.startsWith('/cms')) {
      finalResponse.headers.set('X-Page-Type', 'dynamic-page');
      finalResponse.headers.set('X-Prefetch-Priority', 'medium');
    }
  }

  const acceptHeader = request.headers.get('accept');
  if (acceptHeader && acceptHeader.includes('text/html') && !pathname.startsWith('/api/')) {
    finalResponse.headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
    finalResponse.headers.set('X-BFCache-Applied', 'true');
  }

  applySecurityHeaders(finalResponse, contentSecurityPolicy);

  if (cacheLoggingEnabled && !pathname.startsWith('/api/')) {
    const cacheStatus = finalResponse.headers.get('x-vercel-cache') || 'none';
    console.log(
      JSON.stringify({
        type: 'cache',
        status: cacheStatus,
        path: pathname,
      }),
    );
  }

  return finalResponse;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|auth/.*|api/auth/.*|api/revalidate|api/revalidate-log).*)',
    '/cms/:path*',
  ],
};
