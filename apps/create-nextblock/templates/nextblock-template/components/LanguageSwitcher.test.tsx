// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The language switcher only resolves a CMS document by slug for `/<slug>`, `/article/<slug>` and
 * `/product/<slug>`. A storefront whose handle equals a page slug (`/partners/home`) refreshes in
 * place instead of jumping to that page's translation, and a route that declared its own address
 * per language (`/partners` ↔ `/partenaires`) goes there.
 */

const state = vi.hoisted(() => ({
  pathname: '/partners/home',
  currentContent: { id: null, type: null, slug: null } as Record<string, unknown>,
  pushes: [] as string[],
  refreshes: 0,
  lookups: [] as Array<[string, string, string]>,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: (path: string) => state.pushes.push(path),
    refresh: () => {
      state.refreshes += 1;
    },
  }),
  usePathname: () => state.pathname,
}));

vi.mock('../context/LanguageContext', () => ({
  useLanguage: () => ({
    currentLocale: 'en',
    setCurrentLocale: async () => undefined,
    availableLanguages: [
      { id: 1, code: 'en', name: 'English' },
      { id: 2, code: 'fr', name: 'Français' },
    ],
    isLoadingLanguages: false,
  }),
}));

vi.mock('../context/CurrentContentContext', () => ({
  useCurrentContent: () => ({ currentContent: state.currentContent }),
}));

vi.mock('../lib/i18n/use-label', () => ({ useLabel: () => (_key: string, en: string) => en }));

vi.mock('../app/actions/languageActions', () => ({
  // The seeded CMS pages: `home` (en) / `accueil` (fr), and a page `about` / `a-propos`.
  getContentMetadataBySlugAndLocale: async (slug: string, locale: string, type: string) => {
    state.lookups.push([slug, locale, type]);
    if (slug === 'home') return { slug: 'home', translation_group_id: 'g-home', type: 'page' };
    if (slug === 'about') return { slug: 'about', translation_group_id: 'g-about', type: 'page' };
    if (slug === 'chef-knife') return { slug: 'chef-knife', translation_group_id: 'g-knife', type: 'product' };
    return null;
  },
  getContentTranslations: async (groupId: string) =>
    groupId === 'g-home'
      ? [
          { language_code: 'en', slug: 'home' },
          { language_code: 'fr', slug: 'accueil' },
        ]
      : groupId === 'g-knife'
        ? [
            { language_code: 'en', slug: 'chef-knife' },
            { language_code: 'fr', slug: 'couteau-de-chef' },
          ]
        : [
            { language_code: 'en', slug: 'about' },
            { language_code: 'fr', slug: 'a-propos' },
          ],
}));

vi.mock('@nextblock-cms/ui', () => ({
  Select: ({ onValueChange, children }: { onValueChange: (value: string) => void; children: ReactNode }) => (
    <select data-testid="switcher" defaultValue="en" onChange={(event) => onValueChange(event.target.value)}>
      <option value="en">en</option>
      <option value="fr">fr</option>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: () => null,
  SelectItem: () => null,
}));

import LanguageSwitcher from './LanguageSwitcher';

const mounted: Root[] = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.useFakeTimers();
  state.currentContent = { id: null, type: null, slug: null };
  state.pushes = [];
  state.refreshes = 0;
  state.lookups = [];
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const root of mounted.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function switchTo(pathname: string, locale: string): Promise<void> {
  state.pathname = pathname;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(<LanguageSwitcher />);
  });
  const select = container.querySelector('select') as HTMLSelectElement;
  await act(async () => {
    select.value = locale;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  // The switcher navigates after two short timers.
  await act(async () => {
    await vi.runAllTimersAsync();
  });
}

describe('LanguageSwitcher', () => {
  it('refreshes a storefront in place even when its handle is a page slug', async () => {
    await switchTo('/partners/home', 'fr');
    expect(state.lookups).toEqual([]);
    expect(state.pushes).toEqual([]);
    expect(state.refreshes).toBe(1);
  });

  it('refreshes other code routes in place without asking for a document', async () => {
    for (const pathname of ['/portal/retailer/storefront', '/checkout/success']) {
      state.refreshes = 0;
      await switchTo(pathname, 'fr');
      expect(state.refreshes).toBe(1);
    }
    expect(state.lookups).toEqual([]);
    expect(state.pushes).toEqual([]);
  });

  it('still sends a CMS page and a product to their translation', async () => {
    await switchTo('/about', 'fr');
    expect(state.lookups).toEqual([['about', 'en', 'pages']]);
    expect(state.pushes).toEqual(['/a-propos']);

    state.pushes = [];
    state.lookups = [];
    await switchTo('/product/chef-knife', 'fr');
    expect(state.lookups).toEqual([['chef-knife', 'en', 'products']]);
    expect(state.pushes).toEqual(['/product/couteau-de-chef']);
  });

  it("goes to the partner landing page's address for the chosen language", async () => {
    state.currentContent = {
      id: null,
      type: null,
      slug: null,
      localePaths: { en: '/partners', fr: '/partenaires', 'x-default': '/partners' },
    };
    await switchTo('/partners', 'fr');
    expect(state.pushes).toEqual(['/partenaires']);
    expect(state.lookups).toEqual([]);

    state.pushes = [];
    await switchTo('/partenaires', 'en');
    expect(state.pushes).toEqual(['/partners']);
    expect(state.lookups).toEqual([]);
  });
});
