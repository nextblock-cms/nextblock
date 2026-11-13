// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AFFILIATES_PORTAL_COPY, AffiliatesCopyProvider } from '@nextblock-cms/affiliates';

/**
 * The portal nav links skip prefetching, so a click waits for the server: each link carries a
 * decorative pending hint driven by `useLinkStatus()`.
 */

const linkStatus = vi.hoisted(() => ({ pending: false }));

vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, prefetch, ...rest }: { children: ReactNode; href: string; prefetch?: boolean }) => (
    <a href={href} data-prefetch={String(prefetch)} {...rest}>
      {children}
    </a>
  ),
  useLinkStatus: () => ({ pending: linkStatus.pending }),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/portal/retailer' }));

import { PortalNav } from './PortalNav';

const mounted: Root[] = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of mounted.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = '';
  linkStatus.pending = false;
});

async function renderNav(): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(
      <AffiliatesCopyProvider locale="en">
        <PortalNav />
      </AffiliatesCopyProvider>,
    );
  });
  return container;
}

describe('PortalNav pending hint', () => {
  it('gives every link a hidden, fixed-size hint while idle', async () => {
    const container = await renderNav();
    const links = [...container.querySelectorAll('a')];
    expect(links).toHaveLength(3);
    for (const link of links) {
      expect(link.getAttribute('data-prefetch')).toBe('false');
      const hint = link.querySelector('span[aria-hidden="true"]');
      expect(hint?.getAttribute('data-pending')).toBe('false');
      expect(hint?.className).toContain('opacity-0');
      expect(hint?.textContent).toBe('');
    }
  });

  it('fades the hint in, after a short delay, while the click is navigating', async () => {
    linkStatus.pending = true;
    const container = await renderNav();
    for (const hint of container.querySelectorAll('a span[aria-hidden="true"]')) {
      expect(hint.getAttribute('data-pending')).toBe('true');
      expect(hint.className).toContain('opacity-70');
      expect(hint.className).toContain('delay-150');
    }
    // The accessible name of each link is still just its label.
    expect([...container.querySelectorAll('a')].map((link) => link.textContent)).toEqual([
      AFFILIATES_PORTAL_COPY['affiliates.portal.nav_overview'].en,
      AFFILIATES_PORTAL_COPY['affiliates.portal.nav_storefront'].en,
      AFFILIATES_PORTAL_COPY['affiliates.portal.nav_payouts'].en,
    ]);
  });
});
