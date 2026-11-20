// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * /cms/interactions shows each review's time in the viewer's time zone. The list is server-rendered
 * (the page hands `initialInteractions` to this client component), and it printed
 * `new Date(created_at).toLocaleString()` under `suppressHydrationWarning`: React kept the server's
 * text, so every time showed in the server's zone (UTC on Vercel). Without the suppression it is
 * React error #418. The two machines are simulated by what toLocaleString() answers.
 */

vi.mock('next/link', () => ({
  default: ({ children, href }: { children?: ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock('../../actions/interactions', () => ({
  getNotificationEmails: vi.fn(async () => ({ success: true, emails: '' })),
  saveNotificationEmails: vi.fn(),
  updateInteractionStatus: vi.fn(),
}));

import InteractionsModerationClient from './InteractionsModerationClient';

const INTERACTION = {
  id: 'review-1',
  type: 'review',
  status: 'pending',
  rating: 5,
  content: 'Great product.',
  created_at: '2026-11-18T14:05:00+00:00',
  product_id: 'product-1',
  products: { title: 'Desk lamp', slug: 'desk-lamp' },
  profiles: { full_name: 'Ada Visitor', avatar_url: null },
  reactions: [],
};

let mounted: { root: Root; container: HTMLElement } | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (mounted) {
    const { root, container } = mounted;
    await act(async () => root.unmount());
    container.remove();
    mounted = null;
  }
});

describe('InteractionsModerationClient hydration', () => {
  it("hydrates without a mismatch when the server's time zone is not the browser's, then shows the browser's", async () => {
    const element = <InteractionsModerationClient initialInteractions={[INTERACTION]} isAdmin={false} />;

    const toLocaleString = vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue('18/11/2026 14:05:00 (server)');
    const html = renderToString(element);
    toLocaleString.mockReturnValue('2026-11-18, 9:05:00 a.m. (browser)');

    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    const recoverableErrors: unknown[] = [];
    let root: Root | undefined;
    await act(async () => {
      root = hydrateRoot(container, element, { onRecoverableError: (error) => recoverableErrors.push(error) });
    });
    mounted = { root: root as Root, container };

    expect(html).toContain('Great product.');
    expect(html).toContain('2026-11-18 14:05 UTC');
    expect(html).not.toContain('(server)');
    expect(recoverableErrors).toEqual([]);
    expect(container.textContent).toContain('2026-11-18, 9:05:00 a.m. (browser)');
    expect(container.textContent).not.toContain('(server)');
  });
});
