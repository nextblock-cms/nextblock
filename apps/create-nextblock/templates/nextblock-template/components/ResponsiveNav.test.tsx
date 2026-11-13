// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@nextblock-cms/db';
import { PARTNER_PROGRAM_NAV_GROUP_IDS } from '../lib/affiliates/partner-program-nav';
import { AFFILIATE_GLOBAL_TRANSLATIONS } from '../lib/i18n/global-affiliate-keys';

/**
 * The partner program's seeded header link (02034) is a tinted pill with a "New" badge on desktop
 * (the badge from lg up only) and a highlighted full-width row in the mobile drawer. Every other
 * entry, and the same link nested in a submenu, stays a plain link.
 */

type NavigationItem = Database['public']['Tables']['navigation_items']['Row'];

const state = vi.hoisted(() => ({ lang: 'en', translations: {} as Record<string, string> }));

vi.mock('@nextblock-cms/utils', async () => {
  const actual = await vi.importActual<typeof import('@nextblock-cms/utils')>('@nextblock-cms/utils');
  return {
    ...actual,
    // Unseeded keys answer with the key itself, exactly like the real provider.
    useTranslations: () => ({ lang: state.lang, t: (key: string) => state.translations[key] ?? key }),
  };
});
vi.mock('next/navigation', () => ({ usePathname: () => '/' }));
vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next/image', () => ({
  __esModule: true,
  default: ({ alt }: { alt: string }) => <span role="img" aria-label={alt} />,
}));
vi.mock('../context/CurrentContentContext', () => ({ useCurrentContent: () => ({ currentContent: {} }) }));
vi.mock('./DeferredGlobalSearch', () => ({ DeferredGlobalSearch: () => null }));

import ResponsiveNav from './ResponsiveNav';

const BADGE = AFFILIATE_GLOBAL_TRANSLATIONS['nav.badge_new'];

function navRow(id: number, label: string, url: string, extra: Partial<NavigationItem> = {}): NavigationItem {
  return {
    id,
    label,
    url,
    parent_id: null,
    order: id,
    page_id: null,
    language_id: 1,
    menu_key: 'HEADER',
    translation_group_id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    created_at: '2026-11-10T00:00:00Z',
    updated_at: '2026-11-10T00:00:00Z',
    ...extra,
  };
}

const PARTNER = navRow(4, 'Become a partner', '/partners', { translation_group_id: PARTNER_PROGRAM_NAV_GROUP_IDS.header });
const MENU = [navRow(1, 'Home', '/'), navRow(2, 'Articles', '/articles'), navRow(3, 'Contact', '/contact'), PARTNER];

const mounted: Root[] = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  state.lang = 'en';
  state.translations = {};
});

afterEach(async () => {
  for (const root of mounted.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = '';
});

async function renderNav(navItems: NavigationItem[]): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(
      <ResponsiveNav
        homeLinkHref="/"
        siteTitle="NextBlock"
        navItems={navItems}
        canAccessCms={false}
        cmsDashboardLinkHref="/cms/dashboard"
        isDraftModeEnabled={false}
        renderHeaderAuth={() => null}
        renderLanguageSwitcher={() => null}
      />,
    );
  });
  return container;
}

/** The desktop row and the mobile drawer each render every top-level entry once. */
function linksTo(container: HTMLElement, href: string): { desktop: HTMLAnchorElement; mobile: HTMLAnchorElement } {
  const links = [...container.querySelectorAll<HTMLAnchorElement>(`a[href="${href}"]`)];
  const mobile = links.find((link) => link.closest('[role="dialog"]'));
  const desktop = links.find((link) => !link.closest('[role="dialog"]'));
  if (!desktop || !mobile) throw new Error(`expected a desktop and a mobile link to ${href}`);
  return { desktop, mobile };
}

describe('ResponsiveNav partner program link', () => {
  it('renders the seeded header link as a tinted pill with the badge from lg up', async () => {
    const container = await renderNav(MENU);
    const { desktop } = linksTo(container, '/partners');

    expect(desktop.className).toContain('rounded-full');
    expect(desktop.className).toContain('bg-primary/10');
    expect(desktop.className).not.toMatch(/(^|\s)bg-primary(\s|$)/);
    // An outline, not a box-shadow ring: a theme may restyle `.border` and its shadow (vibrant does).
    expect(desktop.className).toContain('focus-visible:outline-2');
    // Readable on the tint in every theme (text-primary there drops under 4.5:1 in dark themes).
    expect(desktop.className).toContain('text-foreground');
    expect(desktop.className).not.toMatch(/(^|\s)text-primary(\s|$)/);
    const badge = desktop.querySelector('span:last-child');
    expect(badge?.textContent).toBe(BADGE.en);
    expect(badge?.className).toContain('hidden lg:inline-block');
    expect(desktop.textContent).toBe(`Become a partner${BADGE.en}`);
  });

  it('gives the same link a highlighted full-width row in the mobile drawer, badge always shown', async () => {
    const container = await renderNav(MENU);
    const { mobile } = linksTo(container, '/partners');

    expect(mobile.className).toContain('w-full');
    expect(mobile.className).toContain('bg-primary/10');
    const badge = mobile.querySelector('span:last-child');
    expect(badge?.textContent).toBe(BADGE.en);
    expect(badge?.className).not.toContain('hidden');
  });

  it('leaves every other entry a plain link', async () => {
    const container = await renderNav(MENU);
    const { desktop, mobile } = linksTo(container, '/contact');

    expect(desktop.className).not.toContain('bg-primary/10');
    expect(desktop.textContent).toBe('Contact');
    expect(mobile.className).not.toContain('bg-primary/10');
    expect(mobile.textContent).toBe('Contact');
  });

  it('reads the badge in French, and lets a seeded translation win', async () => {
    state.lang = 'fr';
    let container = await renderNav([{ ...PARTNER, label: 'Devenir partenaire', url: '/partenaires' }]);
    expect(linksTo(container, '/partenaires').desktop.textContent).toBe(`Devenir partenaire${BADGE.fr}`);

    state.translations = { 'nav.badge_new': 'Nouveauté' };
    document.body.innerHTML = '';
    container = await renderNav([{ ...PARTNER, label: 'Devenir partenaire', url: '/partenaires' }]);
    expect(linksTo(container, '/partenaires').mobile.textContent).toBe('Devenir partenaireNouveauté');
  });

  it('is an ordinary entry once an operator nests it in a submenu or gives it children', async () => {
    const nested = await renderNav([navRow(3, 'Contact', '/contact'), { ...PARTNER, parent_id: 3 }]);
    const nestedLinks = [...nested.querySelectorAll<HTMLAnchorElement>('a[href="/partners"]')];
    expect(nestedLinks.length).toBeGreaterThan(0);
    for (const link of nestedLinks) {
      expect(link.className).not.toContain('bg-primary/10');
      expect(link.textContent).toBe('Become a partner');
    }

    document.body.innerHTML = '';
    const parent = await renderNav([PARTNER, navRow(9, 'Partner FAQ', '/partners/faq', { parent_id: PARTNER.id })]);
    const { desktop, mobile } = linksTo(parent, '/partners');
    expect(desktop.className).not.toContain('bg-primary/10');
    expect(mobile.className).not.toContain('bg-primary/10');
  });
});
