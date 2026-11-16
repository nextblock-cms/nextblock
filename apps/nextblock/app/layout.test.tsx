import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The root layout mounts the storefront's visual-editing toolbar while the visual editor is on
 * (draft mode, or NEXTBLOCK_VISUAL_EDITING_ENABLED) and hands it the product Publish flag. The flag
 * is currentUserCanPublishProductDrafts(): an ADMIN past the second factor, the check
 * publishProductVisualEditingDraft opens with. It used to be the profile's role (through
 * AuthProvider), so an ADMIN whose second factor was pending saw Publish enabled and was refused on
 * every click. The check runs only while the visual editor is on: any other request asks nothing.
 * When the check says no to a profile that says ADMIN, the layout also passes secondFactorPending, so
 * that ADMIN's note asks for the second factor instead of saying that an administrator publishes.
 * The layout is called directly and the element it returns inspected: nothing renders.
 */

const mocks = vi.hoisted(() => ({
  draftModeEnabled: false,
  user: null as null | { id: string },
  profile: null as null | { id: string; role: string },
  canPublishProductDrafts: vi.fn(),
}));

function Stub({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

/** The anonymous client the layout's cached reads use: languages, site settings, menus, currencies. */
function makeStaticClient() {
  return {
    from: (table: string) => {
      let key: unknown = null;
      const rows = table === 'languages' ? [{ id: 1, code: 'en', name: 'English', is_default: true, is_active: true }] : [];
      const setting = () =>
        table === 'site_settings' && key === 'footer_copyright' ? { value: { en: '(c) {year} Test' } } : null;
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.order = () => chain;
      chain.eq = (column: string, value: unknown) => {
        if (column === 'key') key = value;
        return chain;
      };
      chain.single = async () => ({ data: table === 'languages' ? rows[0] : setting(), error: null });
      chain.maybeSingle = async () => ({ data: table === 'languages' ? rows[0] : setting(), error: null });
      chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(resolve, reject);
      return chain;
    },
  };
}

vi.mock('@nextblock-cms/ui/styles/globals.css', () => ({}));
vi.mock('next/script', () => ({ default: Stub }));
vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (name: string) => ({ 'x-nonce': 'nonce-1', 'x-nextblock-path': '/product/pro-plugin' })[name.toLowerCase()] ?? null,
  }),
  cookies: async () => ({ get: () => undefined }),
  draftMode: async () => ({ isEnabled: mocks.draftModeEnabled }),
}));
vi.mock('next/server', () => ({ after: vi.fn() }));
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock('@nextblock-cms/db/server', () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: mocks.user }, error: null }) } }),
  getProfileWithRoleServerSide: async () => mocks.profile,
  getActiveLanguagesServerSide: async () => [],
  verifyPackageOnline: async () => false,
}));
vi.mock('@nextblock-cms/ecommerce/currency-constants', () => ({ CURRENCY_COOKIE_NAME: 'nb_currency' }));
vi.mock('./providers', () => ({ Providers: function Providers({ children }: { children?: ReactNode }) { return <>{children}</>; } }));
vi.mock('./ToasterProvider', () => ({ ToasterProvider: Stub }));
vi.mock('./lib/site-settings', () => ({
  createStaticSupabaseClient: () => makeStaticClient(),
  getSiteSettings: async () => ({ siteTitle: 'Test site' }),
}));
vi.mock('./lib/seo', () => ({ DEFAULT_OG_IMAGE: '/og.jpg', DEFAULT_OG_IMAGE_WIDTH: 1200, DEFAULT_OG_IMAGE_HEIGHT: 630 }));
vi.mock('../components/DeferredCartDrawer', () => ({ DeferredCartDrawer: Stub }));
vi.mock('../components/AppShell', () => ({ AppShell: Stub }));
vi.mock('../components/PublicEnvBootstrap', () => ({ PublicEnvBootstrap: Stub }));
vi.mock('../components/privacy/ConsentGatedAnalytics', () => ({ ConsentGatedAnalytics: Stub }));
vi.mock('../components/privacy/ConsentBanner', () => ({ ConsentBanner: Stub }));
vi.mock('../components/SiteScripts', () => ({ default: Stub }));
vi.mock('../components/DeferredSpeedInsights', () => ({ DeferredSpeedInsights: Stub }));
vi.mock('../components/visual-editing/DeferredVisualEditing', () => ({
  DeferredVisualEditing: function DeferredVisualEditing() { return null; },
}));
vi.mock('../lib/privacy/settings', async () => {
  const { DEFAULT_PRIVACY_SETTINGS } = await vi.importActual<typeof import('../lib/privacy/types')>('../lib/privacy/types');
  return { getPrivacySettings: async () => ({ ...DEFAULT_PRIVACY_SETTINGS, banner_enabled: false }) };
});
vi.mock('../lib/themes/buildThemeCss', () => ({
  activeThemeSlugs: () => [],
  buildThemeCss: () => '',
  defaultThemeSlug: () => 'light',
  themeColorFor: () => '#ffffff',
}));
vi.mock('../lib/themes/cached-site-themes', () => ({ getCachedSiteThemes: async () => [] }));
vi.mock('../lib/themes/style-element-text', () => ({ escapeStyleElementText: (text: string) => text }));
vi.mock('../lib/site-scripts/types', () => ({ SITE_SCRIPT_COLUMNS: 'id' }));
vi.mock('../lib/packages/revalidate-activations', () => ({ maybeRevalidatePackageActivations: async () => undefined }));
vi.mock('../lib/logos/cached-active-logo', () => ({ getCachedActiveLogo: async () => null }));
vi.mock('../lib/branding/app-icon', () => ({ appIconHref: () => '/icon.png', brandNameFromTitle: (title: string) => title }));
vi.mock('../lib/branding/app-icon-context', () => ({ loadAppIconContext: async () => ({ source: null }) }));
vi.mock('../lib/i18n/slim-translations', () => ({ compactTranslationsForLocale: () => [] }));
vi.mock('../lib/i18n/cached-translations', () => ({ getCachedTranslations: async () => [] }));
vi.mock('../lib/i18n/affiliate-translation-rows', () => ({ excludeAffiliateTranslationRows: (rows: unknown) => rows }));
vi.mock('../lib/setup/env-status', () => ({
  isSupabaseConfigured: () => true,
  resolveSupabaseAnonKey: () => 'public-key',
  resolveSupabaseUrl: () => 'http://127.0.0.1:54321',
}));
vi.mock('../lib/storage/provider', () => ({ resolveMediaBaseUrl: () => '' }));
vi.mock('../lib/i18n/detection', () => ({
  LANGUAGE_DETECTION_SETTING_KEY: 'language_detection',
  LANGUAGE_DETECTION_CACHE_TAG: 'language-detection',
  DEFAULT_LANGUAGE_DETECTION_SETTINGS: { rememberVisitorChoice: true },
  normalizeLanguageDetectionSettings: () => ({ rememberVisitorChoice: true }),
}));
vi.mock('../lib/affiliates/package-state', () => ({ isAffiliatesProgramActive: async () => false }));
vi.mock('../lib/affiliates/partner-program-nav', () => ({ hideDormantPartnerProgramNav: (rows: unknown) => rows }));
// Loaded with import() only while the visual editor is on.
vi.mock('../lib/visual-editing/product-drafts', () => ({
  currentUserCanPublishProductDrafts: mocks.canPublishProductDrafts,
}));

import RootLayout from './layout';
import { Providers } from './providers';
import { DeferredVisualEditing } from '../components/visual-editing/DeferredVisualEditing';

/** The first element of `type` in a returned tree (children arrays and fragments included). */
function findElement(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<Record<string, unknown>>;
  if (element.type === type) return element;
  return findElement(element.props.children as ReactNode, type);
}

async function renderLayout() {
  return RootLayout({ children: null });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Whatever the shell running the tests exports.
  vi.stubEnv('NEXTBLOCK_VISUAL_EDITING_ENABLED', '');
  vi.stubEnv('NEXTBLOCK_VERCEL_TOOLBAR_ENABLED', '');
  vi.stubEnv('VERCEL', '');
  mocks.draftModeEnabled = false;
  mocks.user = { id: 'admin-1' };
  mocks.profile = { id: 'admin-1', role: 'ADMIN' };
  mocks.canPublishProductDrafts.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('RootLayout and the visual-editing toolbar', () => {
  it('mounts no toolbar and asks nothing when the visual editor is off', async () => {
    const tree = await renderLayout();

    expect(findElement(tree, DeferredVisualEditing)).toBeNull();
    expect(mocks.canPublishProductDrafts).not.toHaveBeenCalled();
  });

  it.each([
    ['an ADMIN past the second factor', 'ADMIN', true, false],
    ['an ADMIN whose second factor is pending', 'ADMIN', false, true],
    ['a WRITER', 'WRITER', false, false],
    ['a visitor without a session', null, false, false],
  ] as const)(
    'hands the toolbar the server check in draft mode for %s (profile role %s): canPublishProducts=%s, secondFactorPending=%s',
    async (_who, role, canPublish, secondFactorPending) => {
      mocks.draftModeEnabled = true;
      mocks.user = role ? { id: 'user-1' } : null;
      mocks.profile = role ? { id: 'user-1', role } : null;
      mocks.canPublishProductDrafts.mockResolvedValue(canPublish);

      const toolbar = findElement(await renderLayout(), DeferredVisualEditing);

      expect(toolbar?.props).toEqual({ canPublishProducts: canPublish, secondFactorPending });
      expect(mocks.canPublishProductDrafts).toHaveBeenCalledTimes(1);
    }
  );

  it('gives an ADMIN whose second factor is pending a false flag, although the profile handed to AuthProvider says ADMIN', async () => {
    mocks.draftModeEnabled = true;
    // currentUserCanPublishProductDrafts() is false while getCmsActor() waits for the second factor
    // (product-drafts-publish.test.ts); the role the layout reads says nothing about it, and picks
    // only the note (secondFactorPending).
    mocks.canPublishProductDrafts.mockResolvedValue(false);

    const tree = await renderLayout();

    expect((findElement(tree, Providers)?.props.serverProfile as { role: string }).role).toBe('ADMIN');
    expect(findElement(tree, DeferredVisualEditing)?.props).toEqual({ canPublishProducts: false, secondFactorPending: true });
  });

  it('asks with NEXTBLOCK_VISUAL_EDITING_ENABLED outside draft mode as well', async () => {
    vi.stubEnv('NEXTBLOCK_VISUAL_EDITING_ENABLED', 'true');

    const toolbar = findElement(await renderLayout(), DeferredVisualEditing);

    expect(toolbar?.props).toEqual({ canPublishProducts: true, secondFactorPending: false });
    expect(mocks.canPublishProductDrafts).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the check cannot answer (an ADMIN is then asked for the second factor)', async () => {
    mocks.draftModeEnabled = true;
    mocks.canPublishProductDrafts.mockRejectedValue(new Error('boom'));

    expect(findElement(await renderLayout(), DeferredVisualEditing)?.props).toEqual({
      canPublishProducts: false,
      secondFactorPending: true,
    });
  });
});
