import '@nextblock-cms/ui/styles/globals.css';
// app/layout.tsx

import type { Metadata } from 'next';
import Script from 'next/script';
import { Providers } from './providers';
import { DeferredCartDrawer } from '../components/DeferredCartDrawer';
import { CURRENCY_COOKIE_NAME } from '@nextblock-cms/ecommerce/currency-constants';
import { ToasterProvider } from './ToasterProvider';
import { AppShell } from '../components/AppShell';
import { PublicEnvBootstrap } from '../components/PublicEnvBootstrap';
import { ConsentGatedAnalytics } from '../components/privacy/ConsentGatedAnalytics';
import { ConsentBanner } from '../components/privacy/ConsentBanner';
import { getPrivacySettings } from '../lib/privacy/settings';
import { DEFAULT_PRIVACY_SETTINGS } from '../lib/privacy/types';
import {
  activeThemeSlugs,
  buildThemeCss,
  defaultThemeSlug,
  type SiteTheme,
} from '../lib/themes/buildThemeCss';
import { SITE_SCRIPT_COLUMNS, type SiteScript } from '../lib/site-scripts/types';
import SiteScripts from '../components/SiteScripts';
import { DeferredSpeedInsights } from '../components/DeferredSpeedInsights';
import { DeferredVisualEditing } from '../components/visual-editing/DeferredVisualEditing';
import {
  createClient as createSupabaseServerClient,
  getProfileWithRoleServerSide,
} from '@nextblock-cms/db/server';
import { getActiveLanguagesServerSide } from '@nextblock-cms/db/server';
import type { Database } from '@nextblock-cms/db';
import { headers, cookies, draftMode } from 'next/headers';
import { verifyPackageOnline } from '@nextblock-cms/db/server';
import { unstable_cache } from 'next/cache';
import { createStaticSupabaseClient, getSiteSettings } from './lib/site-settings';
import {
  DEFAULT_OG_IMAGE,
  DEFAULT_OG_IMAGE_WIDTH,
  DEFAULT_OG_IMAGE_HEIGHT,
} from './lib/seo';
import { resolveActiveLogo } from '../lib/logos/active-logo';
import { compactTranslationsForLocale } from '../lib/i18n/slim-translations';
import {
  isSupabaseConfigured,
  resolveSupabaseAnonKey,
  resolveSupabaseUrl,
} from '../lib/setup/env-status';
import { resolveMediaBaseUrl } from '../lib/storage/provider';
import {
  LANGUAGE_DETECTION_SETTING_KEY,
  LANGUAGE_DETECTION_CACHE_TAG,
  DEFAULT_LANGUAGE_DETECTION_SETTINGS,
  normalizeLanguageDetectionSettings,
  type LanguageDetectionSettings,
} from '../lib/i18n/detection';

const defaultUrl = process.env.NEXT_PUBLIC_URL || 'http://localhost:3000';

const DEFAULT_LOCALE_FOR_LAYOUT = 'en';
// Five minutes, like lib/public-content-cache.ts: every settings action evicts by tag
// or path, so the TTL only bounds direct database edits, and a cold entry is a
// sequential Supabase round trip inside the request on Vercel.
const PUBLIC_LAYOUT_REVALIDATE_SECONDS = 300;
const PUBLIC_LAYOUT_LOGO_CACHE_TAG = 'public-layout-logo';
const TRUSTED_TYPES_SCRIPT_STRATEGY =
  process.env.NODE_ENV === 'production' ? 'beforeInteractive' : 'afterInteractive';
const TRUSTED_TYPES_BOOTSTRAP = `
(function () {
  if (!window.trustedTypes || window.__nextblockTrustedTypesPolicy) return;
  try {
    window.__nextblockTrustedTypesPolicy = window.trustedTypes.createPolicy('default', {
      createHTML: function (value) { return value; },
      createScript: function (value) { return value; },
      createScriptURL: function (value) { return value; }
    });
  } catch (error) {
    window.__nextblockTrustedTypesPolicy = true;
  }
})();
`;

type Language = Database['public']['Tables']['languages']['Row'];
type StoreCurrency = Database['public']['Tables']['currencies']['Row'];
type NavigationItem = Database['public']['Tables']['navigation_items']['Row'];
type MenuLocation = Database['public']['Enums']['menu_location'];
type HeaderLogo = Database['public']['Tables']['logos']['Row'] & {
  media: (Database['public']['Tables']['media']['Row'] & { alt_text: string | null }) | null;
};

const getCachedLanguages = unstable_cache(
  async (): Promise<Language[]> => {
    const supabase = createStaticSupabaseClient();
    const { data, error } = await supabase
      .from('languages')
      .select('id, code, name, is_default, is_active, created_at, updated_at')
      .order('name', { ascending: true });

    if (error) {
      console.error('Error fetching cached languages:', error.message);
      return [];
    }

    return data || [];
  },
  ['public-layout-languages'],
  { revalidate: PUBLIC_LAYOUT_REVALIDATE_SECONDS }
);

const getCachedLanguageDetectionSettings = unstable_cache(
  async (): Promise<LanguageDetectionSettings> => {
    const supabase = createStaticSupabaseClient();
    const { data, error } = await supabase
      .from('site_settings')
      .select('value')
      .eq('key', LANGUAGE_DETECTION_SETTING_KEY)
      .maybeSingle();

    // Absent row or read error = defaults (browser detection, remembered choice).
    if (error) {
      return { ...DEFAULT_LANGUAGE_DETECTION_SETTINGS };
    }
    return normalizeLanguageDetectionSettings(data?.value);
  },
  ['public-language-detection'],
  { revalidate: PUBLIC_LAYOUT_REVALIDATE_SECONDS, tags: [LANGUAGE_DETECTION_CACHE_TAG] }
);

const getCachedCopyrightSettings = unstable_cache(
  async (): Promise<Record<string, string>> => {
    const supabase = createStaticSupabaseClient();
    const { data, error } = await supabase
      .from('site_settings')
      .select('value')
      .eq('key', 'footer_copyright')
      .single();

    if (error || !data) {
      console.error('Error fetching cached copyright settings:', error);
      return { en: '(c) {year} Nextblock CMS. All rights reserved.' };
    }

    return data.value as Record<string, string>;
  },
  ['public-layout-copyright'],
  { revalidate: PUBLIC_LAYOUT_REVALIDATE_SECONDS }
);

const getCachedFooterAttribution = unstable_cache(
  async (): Promise<boolean> => {
    const supabase = createStaticSupabaseClient();
    const { data } = await supabase
      .from('site_settings')
      .select('value')
      .eq('key', 'footer_show_attribution')
      .maybeSingle();

    // Absent row = enabled (default); only an explicit `false` disables it.
    return data ? data.value !== false : true;
  },
  ['public-layout-footer-attribution'],
  { revalidate: PUBLIC_LAYOUT_REVALIDATE_SECONDS }
);

const getCachedGlobalCss = unstable_cache(
  async (): Promise<string> => {
    const supabase = createStaticSupabaseClient();
    const { data, error } = await supabase
      .from('site_settings')
      .select('value')
      .eq('key', 'global_css')
      .single();

    if (error || !data || !data.value) {
      return '';
    }
    if (typeof data.value === 'string') {
        if (data.value.startsWith('"') && data.value.endsWith('"')) {
            try { return JSON.parse(data.value); } catch { return data.value; }
        }
        return data.value;
    }
    return String(data.value);
  },
  ['public-layout-global-css'],
  { revalidate: PUBLIC_LAYOUT_REVALIDATE_SECONDS }
);

const getCachedSiteThemes = unstable_cache(
  async (): Promise<SiteTheme[]> => {
    const supabase = createStaticSupabaseClient();
    const { data, error } = await supabase
      .from('site_themes')
      .select('id, slug, name, description, icon, color_scheme, tokens, extra_css, is_system, is_default, is_active, sort_order')
      .order('sort_order');

    if (error || !data) {
      // A missing table (pre-migration install) must not take the site down —
      // libs/ui/src/styles/theme.css still ships a working fallback palette.
      return [];
    }
    return data as unknown as SiteTheme[];
  },
  ['public-layout-site-themes'],
  { revalidate: PUBLIC_LAYOUT_REVALIDATE_SECONDS, tags: ['public-layout-site-themes'] }
);

const getCachedSiteScripts = unstable_cache(
  async (): Promise<SiteScript[]> => {
    const supabase = createStaticSupabaseClient();
    const { data, error } = await supabase
      .from('site_scripts')
      .select(SITE_SCRIPT_COLUMNS)
      .eq('is_active', true)
      .order('sort_order');

    if (error || !data) {
      // A missing table (pre-migration install) must not take the site down — the
      // site simply renders with no author scripts, exactly as before the feature.
      return [];
    }

    return data as SiteScript[];
  },
  ['public-layout-site-scripts'],
  { revalidate: PUBLIC_LAYOUT_REVALIDATE_SECONDS, tags: ['public-layout-site-scripts'] }
);

const getCachedTranslations = unstable_cache(
  async () => {
    const supabase = createStaticSupabaseClient();
    const { data, error } = await supabase
      .from('translations')
      .select('key, translations, created_at, updated_at')
      .order('key');

    if (error) {
      console.error('Error fetching cached translations:', error.message);
      return [];
    }

    return data || [];
  },
  ['public-layout-translations'],
  {
    revalidate: PUBLIC_LAYOUT_REVALIDATE_SECONDS,
    tags: ['public-layout-translations'],
  }
);

const getCachedCurrencies = unstable_cache(
  async (): Promise<StoreCurrency[]> => {
    const supabase = createStaticSupabaseClient();
    const { data, error } = await supabase
      .from('currencies')
      .select(
        'id, code, symbol, exchange_rate, is_default, is_active, auto_sync_product_prices, auto_update_exchange_rate, exchange_rate_source, exchange_rate_updated_at, rounding_mode, rounding_increment, rounding_charm_amount, created_at, updated_at'
      )
      .eq('is_active', true)
      .order('code', { ascending: true });

    if (error) {
      console.error('Error fetching cached currencies:', error.message);
      return [];
    }

    return data || [];
  },
  ['public-layout-currencies'],
  { revalidate: PUBLIC_LAYOUT_REVALIDATE_SECONDS }
);

const getCachedNavigationMenu = unstable_cache(
  async (menuKey: MenuLocation, languageCode: string): Promise<NavigationItem[]> => {
    const supabase = createStaticSupabaseClient();

    const { data: language, error: langError } = await supabase
      .from('languages')
      .select('id')
      .eq('code', languageCode)
      .single();

    if (langError || !language) {
      console.error(
        `Error fetching cached navigation language ${languageCode} for ${menuKey}:`,
        langError
      );
      return [];
    }

    const { data: items, error: itemsError } = await supabase
      .from('navigation_items')
      .select('*, pages(slug)')
      .eq('menu_key', menuKey)
      .eq('language_id', language.id)
      .order('parent_id', { nullsFirst: true })
      .order('order');

    if (itemsError) {
      console.error(
        `Error fetching cached navigation items for ${menuKey} (${languageCode}):`,
        itemsError
      );
      return [];
    }

    return (items || []).map((item) => ({ ...item, id: Number(item.id) }));
  },
  ['public-layout-navigation'],
  { revalidate: PUBLIC_LAYOUT_REVALIDATE_SECONDS }
);

const getCachedActiveLogo = unstable_cache(
  async (): Promise<HeaderLogo | null> => {
    try {
      const supabase = createStaticSupabaseClient();
      // Honor the admin-pinned active logo (site_settings.active_logo_id), else newest.
      const logo = await resolveActiveLogo(supabase);
      return (logo as HeaderLogo | null) ?? null;
    } catch (error) {
      console.error('Error fetching cached active logo:', error);
      return null;
    }
  },
  ['public-layout-logo'],
  { revalidate: PUBLIC_LAYOUT_REVALIDATE_SECONDS, tags: [PUBLIC_LAYOUT_LOGO_CACHE_TAG] }
);

async function loadLayoutData() {
  const headerList = await headers();
  const nonce = headerList.get('x-nonce') || '';
  const requestPath = headerList.get('x-nextblock-path') || '';

  // Skip the public-chrome data loading when there's nothing to render it on: an
  // unconfigured instance, OR the standalone /setup wizard. On /setup, AppShell shows no
  // header/footer anyway, and the DB schema may not exist yet (configured-but-pre-migrate)
  // — querying it just produces noisy "table not found" errors for data nobody displays.
  if (!isSupabaseConfigured() || requestPath.startsWith('/setup')) {
    return {
      user: null,
      profile: null,
      serverDeterminedLocale: DEFAULT_LOCALE_FOR_LAYOUT,
      availableCurrencies: [] as StoreCurrency[],
      serverCurrencyCode: null,
      availableLanguages: [] as Language[],
      defaultLanguage: null,
      translations: [] as Awaited<ReturnType<typeof getCachedTranslations>>,
      copyrightText: '',
      nonce,
      hasSupabaseEnv: false,
      headerNavItems: [] as NavigationItem[],
      footerNavItems: [] as NavigationItem[],
      logo: null as HeaderLogo | null,
      canAccessCms: false,
      siteTitle: 'NextBlock',
      isEcommerceActive: false,
      globalCss: '',
      siteThemes: [] as SiteTheme[],
      siteScripts: [] as SiteScript[],
      privacySettings: DEFAULT_PRIVACY_SETTINGS,
      footerAttributionEnabled: true,
      rememberVisitorChoice: DEFAULT_LANGUAGE_DETECTION_SETTINGS.rememberVisitorChoice,
    };
  }

  const supabase = createSupabaseServerClient();
  const cookieStore = await cookies();

  const xUserLocaleHeader = headerList.get('x-user-locale');
  const nextUserLocaleCookie = cookieStore.get('NEXT_USER_LOCALE')?.value;
  const serverCurrencyCode = cookieStore.get(CURRENCY_COOKIE_NAME)?.value ?? null;

  let serverDeterminedLocale =
    xUserLocaleHeader ??
    nextUserLocaleCookie ??
    DEFAULT_LOCALE_FOR_LAYOUT;

  const [
    {
      data: { user },
    },
    availableLanguagesResult,
    currenciesResult,
    copyrightSettingsResult,
    globalCssResult,
    siteThemesResult,
    siteScriptsResult,
    translationsResult,
    isEcommerceActive,
    privacySettings,
    languageDetectionSettings,
    logo,
    { siteTitle },
    footerAttributionEnabled,
  ] = await Promise.all([
    supabase.auth.getUser(),
    getCachedLanguages().catch(() => getActiveLanguagesServerSide().catch(() => [])),
    getCachedCurrencies().catch(() => []),
    getCachedCopyrightSettings().catch(() => ({
      en: '(c) {year} Nextblock CMS. All rights reserved.',
    })),
    getCachedGlobalCss().catch(() => ''),
    getCachedSiteThemes().catch(() => [] as SiteTheme[]),
    getCachedSiteScripts().catch(() => [] as SiteScript[]),
    getCachedTranslations().catch(() => []),
    verifyPackageOnline('ecommerce').catch(() => false),
    getPrivacySettings().catch(() => DEFAULT_PRIVACY_SETTINGS),
    getCachedLanguageDetectionSettings().catch(() => ({
      ...DEFAULT_LANGUAGE_DETECTION_SETTINGS,
    })),
    // Locale-independent reads belong in this first wave: on Vercel each cached read
    // is a Data Cache round trip, and these three used to run one after another
    // AFTER the second wave, adding ~3 sequential hops to every public request.
    getCachedActiveLogo().catch(() => null),
    getSiteSettings(),
    getCachedFooterAttribution().catch(() => true),
  ]);

  // Serve only active languages, matching the proxy's detection set (is_active
  // null counts as active). getCachedLanguages / getActiveLanguagesServerSide
  // both return every row, so filtering here keeps the public switcher and
  // LanguageProvider in step with the locales the proxy will actually honor —
  // otherwise picking a deactivated language would ping-pong against the proxy.
  const availableLanguages: Language[] = availableLanguagesResult.filter(
    (lang) => lang.is_active !== false,
  );
  const availableCurrencies: StoreCurrency[] = currenciesResult;
  const defaultLanguage: Language | null =
    availableLanguages.find((lang) => lang.is_default) ?? availableLanguages[0] ?? null;

  if (!availableLanguages.some((lang) => lang.code === serverDeterminedLocale) && defaultLanguage) {
    serverDeterminedLocale = defaultLanguage.code;
  } else if (!availableLanguages.some((lang) => lang.code === serverDeterminedLocale)) {
    serverDeterminedLocale = DEFAULT_LOCALE_FOR_LAYOUT;
  }

  const copyrightSettings = copyrightSettingsResult as Record<string, string>;
  const fallbackTemplate =
    copyrightSettings.en ?? '(c) {year} Nextblock CMS. All rights reserved.';
  const templateForLocale = copyrightSettings[serverDeterminedLocale] ?? fallbackTemplate;
  const copyrightText = templateForLocale.replace('{year}', new Date().getFullYear().toString());

  const globalCss = typeof globalCssResult === 'string' ? globalCssResult : '';
  const siteThemes = Array.isArray(siteThemesResult) ? siteThemesResult : [];
  const siteScripts = Array.isArray(siteScriptsResult) ? siteScriptsResult : [];
  const translations = Array.isArray(translationsResult) ? translationsResult : [];

  const hasSupabaseEnv = isSupabaseConfigured();

  // Second wave: only what genuinely depends on the validated locale or the user.
  const [profile, headerNavItems, footerNavItems] = await Promise.all([
    user ? getProfileWithRoleServerSide(user.id) : Promise.resolve(null),
    getCachedNavigationMenu('HEADER', serverDeterminedLocale).catch(() => []),
    getCachedNavigationMenu('FOOTER', serverDeterminedLocale).catch(() => []),
  ]);

  const role = profile?.role ?? null;
  const canAccessCms = role === 'ADMIN' || role === 'WRITER';

  return {
    user,
    profile,
    serverDeterminedLocale,
    availableCurrencies,
    serverCurrencyCode,
    availableLanguages,
    defaultLanguage,
    translations,
    copyrightText,
    nonce,
    hasSupabaseEnv,
    headerNavItems,
    footerNavItems,
    logo,
    canAccessCms,
    siteTitle,
    isEcommerceActive,
    globalCss,
    siteThemes,
    siteScripts,
    privacySettings,
    footerAttributionEnabled,
    rememberVisitorChoice: languageDetectionSettings.rememberVisitorChoice,
  };
}

export async function generateMetadata(): Promise<Metadata> {
  const { siteTitle, siteDescription, siteKeywords, socialImage } = await getSiteSettings();
  const isSandbox = process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';
  // The site-wide preview image from the Branding screen, else NextBlock's own banner.
  const defaultSocialImage = socialImage
    ? {
        url: socialImage.url,
        ...(socialImage.width && socialImage.height ? { width: socialImage.width, height: socialImage.height } : {}),
        alt: socialImage.alt?.trim() || siteTitle,
      }
    : { url: DEFAULT_OG_IMAGE, width: DEFAULT_OG_IMAGE_WIDTH, height: DEFAULT_OG_IMAGE_HEIGHT, alt: siteTitle };

  return {
    metadataBase: new URL(defaultUrl),
    title: {
      default: siteTitle,
      template: `%s | ${siteTitle}`,
    },
    description: siteDescription,
    keywords: siteKeywords,
    applicationName: siteTitle,
    openGraph: {
      title: siteTitle,
      description: siteDescription,
      url: defaultUrl,
      siteName: siteTitle,
      images: [defaultSocialImage],
      locale: 'en_US',
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title: siteTitle,
      description: siteDescription,
      images: [defaultSocialImage.url],
    },
    icons: {
      icon: [
        { url: '/favicon/favicon.ico' },
        { url: '/favicon/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
        { url: '/favicon/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
      ],
      apple: [{ url: '/favicon/apple-touch-icon.png' }],
    },
    manifest: '/favicon/site.webmanifest',
    // Sandbox is a copy of production, so keep it out of the index. Use
    // `noindex, follow` (not nofollow) so Googlebot still follows internal links,
    // recrawls every page, and drops them all — paired with an allow-crawl
    // robots.txt (see app/robots.txt/route.ts) so the noindex is actually seen.
    robots: isSandbox ? { index: false, follow: true } : { index: true, follow: true },
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const {
    user,
    profile,
    serverDeterminedLocale,
    availableCurrencies,
    serverCurrencyCode,
    availableLanguages,
    defaultLanguage,
    translations,
    copyrightText,
    nonce,
    hasSupabaseEnv,
    headerNavItems,
    logo,
    footerNavItems,
    canAccessCms,
    siteTitle,
    isEcommerceActive,
    globalCss,
    siteThemes,
    siteScripts,
    privacySettings,
    footerAttributionEnabled,
    rememberVisitorChoice,
  } = await loadLayoutData();
  // Themes are rendered server-side into <head> so the palette is correct on the
  // very first paint, before next-themes' blocking script adds the html class.
  const themeCss = buildThemeCss(siteThemes);
  const themeSlugs = activeThemeSlugs(siteThemes);
  const initialTheme = defaultThemeSlug(siteThemes);
  const themeCatalog = siteThemes
    .filter((theme) => theme.is_active)
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((theme) => ({
      slug: theme.slug,
      name: theme.name,
      icon: theme.icon,
      colorScheme: theme.color_scheme,
    }));
  const draft = await draftMode();
  // GTM container id comes solely from the privacy settings row (site_settings).
  // There is intentionally no NEXT_PUBLIC_GTM_ID env fallback — analytics is
  // configured in the CMS (Settings -> Privacy), not via build-time env.
  const resolvedGtmId = privacySettings.gtm_id || '';
  const visualEditingEnabled =
    draft.isEnabled || process.env.NEXTBLOCK_VISUAL_EDITING_ENABLED === 'true';
  const isVercelDeployment = process.env.VERCEL === '1';
  const toolbarEnabled =
    process.env.NEXTBLOCK_VERCEL_TOOLBAR_ENABLED === 'true' ||
    (isVercelDeployment && visualEditingEnabled);
  const Toolbar = toolbarEnabled
    ? (await import('@vercel/toolbar/next')).VercelToolbar
    : null;

  // Expose the PUBLIC Supabase values (url + anon key — both safe to ship to the browser)
  // to the client at runtime via <PublicEnvBootstrap>. In production the client uses the
  // build-time-inlined NEXT_PUBLIC_* and these just match; it only matters in local dev,
  // where the wizard writes those vars at runtime and the loaded bundle would otherwise
  // hold stale empties until a dev-server restart. Read from server process.env (fresh).
  const publicSupabaseUrl = resolveSupabaseUrl() || '';
  const publicSupabaseAnonKey = resolveSupabaseAnonKey() || '';

  return (
    <html lang={serverDeterminedLocale} suppressHydrationWarning>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {themeCss && <style id="nb-theme-tokens" dangerouslySetInnerHTML={{ __html: themeCss }} />}
        {globalCss && <style dangerouslySetInnerHTML={{ __html: globalCss }} />}
        <SiteScripts nonce={nonce} placement="head" scripts={siteScripts} />
      </head>
      <body className="min-h-screen">
        <SiteScripts nonce={nonce} placement="body_start" scripts={siteScripts} />
        {/* Sets window.__NEXTBLOCK_PUBLIC_ENV__ synchronously during render, before any
            descendant calls the browser Supabase client — the local-dev runtime fallback. */}
        <PublicEnvBootstrap
          url={publicSupabaseUrl}
          anonKey={publicSupabaseAnonKey}
          r2Base={resolveMediaBaseUrl()}
        />
        {/* In development this loads after hydration to avoid browser-hidden nonce comparisons. */}
        <Script
          id="trusted-types-bootstrap"
          strategy={TRUSTED_TYPES_SCRIPT_STRATEGY}
          nonce={nonce}
          dangerouslySetInnerHTML={{ __html: TRUSTED_TYPES_BOOTSTRAP }}
        />
        <Providers
          serverUser={user}
          serverProfile={profile}
          serverLocale={serverDeterminedLocale}
          initialCurrencies={availableCurrencies}
          initialCurrencyCode={serverCurrencyCode}
          initialAvailableLanguages={availableLanguages}
          initialDefaultLanguage={defaultLanguage}
          rememberVisitorChoice={rememberVisitorChoice}
          // The raw table (every locale + timestamps) was ~88 KB of RSC payload on
          // every public page. The client only reads the active locale plus the 'en'
          // fallback, and a language switch goes through router.refresh(), which
          // re-runs this layout for the new locale. Shipped as `[key, value]` tuples:
          // the row objects cost another ~12 KB of JSON scaffolding.
          translations={compactTranslationsForLocale(translations, serverDeterminedLocale)}
          nonce={nonce}
          themeSlugs={themeSlugs}
          initialTheme={initialTheme}
          themeCatalog={themeCatalog}
        >
          <ToasterProvider />
          <AppShell
            canAccessCms={canAccessCms}
            copyrightText={copyrightText}
            corporateFooter={{
              legalName: privacySettings.corporate.legal_name,
              address: privacySettings.corporate.address,
              supportEmail: privacySettings.corporate.support_email,
            }}
            footerNavItems={footerNavItems}
            hasSupabaseEnv={hasSupabaseEnv}
            headerNavItems={headerNavItems}
            isDraftModeEnabled={draft.isEnabled}
            isEcommerceActive={isEcommerceActive}
            logo={logo}
            showFooterAttribution={footerAttributionEnabled}
            siteTitle={siteTitle}
          >
            {children}
          </AppShell>

          {isEcommerceActive && <DeferredCartDrawer />}
          {visualEditingEnabled && <DeferredVisualEditing />}
          {Toolbar && <Toolbar nonce={nonce} />}
          {privacySettings.banner_enabled && <ConsentBanner />}
        </Providers>
        <DeferredSpeedInsights />
        <ConsentGatedAnalytics
          gtmId={resolvedGtmId}
          gaMeasurementId={privacySettings.ga_measurement_id || ''}
          customScripts={privacySettings.custom_scripts}
          nonce={nonce}
        />
        {/* Last in <body> so the DOM these snippets query is already present. */}
        <SiteScripts nonce={nonce} placement="body_end" scripts={siteScripts} />
      </body>
    </html>
  );
}
