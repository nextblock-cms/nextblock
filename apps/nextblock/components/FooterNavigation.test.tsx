// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@nextblock-cms/db';
import { PARTNER_PROGRAM_NAV_GROUP_IDS } from '../lib/affiliates/partner-program-nav';
import { AFFILIATE_GLOBAL_TRANSLATIONS } from '../lib/i18n/global-affiliate-keys';

/**
 * The partner program's seeded footer link (02034) carries a small "New" badge; the other footer
 * links stay as they were. The badge text is resolved by AppShell (`useLabel`), whose inline
 * fallbacks must say exactly what the seed says.
 */

type NavigationItem = Database['public']['Tables']['navigation_items']['Row'];

vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import FooterNavigation from './FooterNavigation';

function navRow(id: number, label: string, url: string, extra: Partial<NavigationItem> = {}): NavigationItem {
  return {
    id,
    label,
    url,
    parent_id: null,
    order: id,
    page_id: null,
    language_id: 2,
    menu_key: 'FOOTER',
    translation_group_id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    created_at: '2026-11-10T00:00:00Z',
    updated_at: '2026-11-10T00:00:00Z',
    ...extra,
  };
}

function render(navItems: NavigationItem[], newBadgeLabel?: string): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(<FooterNavigation navItems={navItems} newBadgeLabel={newBadgeLabel} />);
  return container;
}

const PRIVACY = navRow(9, 'Politique de confidentialité', '/politique-de-confidentialite');
const PARTNER = navRow(14, 'Programme de partenaires', '/partenaires', {
  translation_group_id: PARTNER_PROGRAM_NAV_GROUP_IDS.footer,
});

describe('FooterNavigation partner program link', () => {
  it('badges the seeded footer link only', () => {
    const container = render([PRIVACY, PARTNER], 'Nouveau');
    const partner = container.querySelector<HTMLAnchorElement>('a[href="/partenaires"]');
    const privacy = container.querySelector<HTMLAnchorElement>('a[href="/politique-de-confidentialite"]');

    expect(partner?.textContent).toBe('Programme de partenairesNouveau');
    expect(partner?.querySelector('span:last-child')?.className).toContain('bg-primary');
    // Only the label underlines on hover, so the decoration never runs under the badge.
    expect(partner?.className).not.toContain('hover:underline');
    expect(privacy?.textContent).toBe('Politique de confidentialité');
    expect(privacy?.querySelector('span')).toBeNull();
  });

  it('falls back to English without a resolved label, and still drops nested rows', () => {
    const container = render([PARTNER, navRow(15, 'Child', '/child', { parent_id: PARTNER.id })]);
    expect(container.querySelector('a[href="/partenaires"]')?.textContent).toBe('Programme de partenairesNew');
    expect(container.querySelector('a[href="/child"]')).toBeNull();
  });

  it('badges a header-group row an operator moved into the footer too', () => {
    const moved = { ...PARTNER, translation_group_id: PARTNER_PROGRAM_NAV_GROUP_IDS.header };
    expect(render([moved], 'Nouveau').querySelector('a[href="/partenaires"]')?.textContent).toBe('Programme de partenairesNouveau');
  });
});

describe('nav.badge_new inline fallbacks', () => {
  // useLabel shows the inline text until the key is seeded; it must match the seed exactly.
  const { en, fr } = AFFILIATE_GLOBAL_TRANSLATIONS['nav.badge_new'];
  const call = `label('nav.badge_new', '${en}', '${fr}')`;

  for (const file of ['./AppShell.tsx', './ResponsiveNav.tsx']) {
    it(`${file} resolves the badge with the seeded English and French`, () => {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
      expect(source).toContain(call);
      expect(source.match(/label\(\s*'nav\.badge_new'/g)).toHaveLength(1);
    });
  }
});
