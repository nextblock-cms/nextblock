import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The CMS alert banner renders links taken from `system_alerts.metadata`. The two developer
 * tracks keep their behaviour (external https links in a new tab); affiliate alerts link inside
 * the CMS only (a relative `/cms/…` path that passes the shared redirect rule, rendered with
 * next/link and no `_blank`). Anything else in metadata never becomes a link.
 */

vi.mock('./system-alerts-actions', () => ({ resolveSystemAlert: vi.fn() }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} data-next-link="true" {...rest}>
      {children}
    </a>
  ),
}));

import { AFFILIATE_ALERT_TYPES, AFFILIATE_BANNER_ALERT_TYPES } from '@nextblock-cms/affiliates';
import SystemAlertsBanner, {
  SYSTEM_ALERT_TYPE_CONFIG,
  resolveSystemAlertPresentation,
  safeCmsAlertPath,
  safeExternalAlertUrl,
  type SystemAlertItem,
} from './SystemAlertsBanner';

function alert(alert_type: string, metadata: Record<string, unknown> | null, id = 'a1'): SystemAlertItem {
  return { id, alert_type, title: 'Title', message: 'Message', metadata };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveSystemAlertPresentation: existing types', () => {
  it('keeps the merge-conflict presentation', () => {
    const presentation = resolveSystemAlertPresentation(
      alert('merge_conflict', {
        action_url: 'https://github.com/acme/site/pulls/1',
        run_url: 'https://github.com/acme/site/actions/runs/2',
      })
    );
    expect(presentation.tone).toBe('amber');
    expect(presentation.primary).toEqual({ href: 'https://github.com/acme/site/pulls/1', label: 'Resolve on GitHub', external: true });
    expect(presentation.secondary).toEqual({
      href: 'https://github.com/acme/site/actions/runs/2',
      label: 'View workflow run',
      external: true,
    });
  });

  it('keeps the update presentation', () => {
    const presentation = resolveSystemAlertPresentation(
      alert('runtime_update_available', {
        download_url: 'https://codeload.github.com/acme/site/tar.gz/v2',
        html_url: 'https://github.com/acme/site/releases/v2',
      })
    );
    expect(presentation.tone).toBe('indigo');
    expect(presentation.primary?.label).toBe('Download latest');
    expect(presentation.secondary?.label).toBe('Release notes');
  });

  it.each(['javascript:alert(1)', 'http://github.com/x', '//evil.example/x', '/cms/settings', 'https://user:pw@github.com/x', 'data:text/html,x'])(
    'drops the external link %j',
    (url) => {
      const presentation = resolveSystemAlertPresentation(alert('merge_conflict', { action_url: url, run_url: url }));
      expect(presentation.primary).toBeNull();
      expect(presentation.secondary).toBeNull();
    }
  );
});

describe('resolveSystemAlertPresentation: affiliate types', () => {
  it('configures every affiliate alert type, and the banner types link to a screen', () => {
    for (const type of Object.values(AFFILIATE_ALERT_TYPES)) {
      expect(SYSTEM_ALERT_TYPE_CONFIG[type], type).toMatchObject({ kind: 'internal' });
    }
    for (const type of AFFILIATE_BANNER_ALERT_TYPES) {
      const presentation = resolveSystemAlertPresentation(alert(type, { action_url: '/cms/affiliates/payouts' }));
      expect(presentation.primary, type).toMatchObject({ href: '/cms/affiliates/payouts', external: false });
    }
  });

  it('uses the metadata label, cleaned and clipped, or the type default', () => {
    expect(
      resolveSystemAlertPresentation(
        alert('affiliate_page_submitted', { action_url: '/cms/affiliates/approvals', action_label: '  Review\nstorefronts now  ' })
      ).primary
    ).toEqual({ href: '/cms/affiliates/approvals', label: 'Review storefronts now', external: false });
    expect(resolveSystemAlertPresentation(alert('affiliate_page_submitted', { action_url: '/cms/affiliates/approvals' })).primary?.label).toBe(
      'Review storefronts'
    );
    const long = resolveSystemAlertPresentation(
      alert('affiliate_payout_failed', { action_url: '/cms/affiliates/payouts', action_label: 'x'.repeat(200) })
    ).primary?.label;
    expect(long?.length).toBe(60);
  });

  it.each([
    'https://evil.example/cms/affiliates',
    '//evil.example/cms/affiliates',
    '/\\evil.example',
    '/%2fevil.example',
    'javascript:alert(1)',
    '/partners/jane',
    '/cms',
    'cms/affiliates',
    '/cms/affiliates\u0000/x',
    ' /cms/affiliates',
  ])('never links an affiliate alert to %j', (url) => {
    expect(resolveSystemAlertPresentation(alert('affiliate_payout_failed', { action_url: url })).primary).toBeNull();
  });

  it('gives unknown types no link at all', () => {
    const presentation = resolveSystemAlertPresentation(
      alert('something_new', { action_url: '/cms/affiliates', download_url: 'https://example.com/x' })
    );
    expect(presentation).toMatchObject({ tone: 'slate', primary: null, secondary: null });
    expect(resolveSystemAlertPresentation(alert('__proto__', { action_url: '/cms/x' })).primary).toBeNull();
  });
});

describe('URL guards', () => {
  it('accepts only https URLs without credentials', () => {
    expect(safeExternalAlertUrl('https://github.com/a')).toBe('https://github.com/a');
    expect(safeExternalAlertUrl('HTTPS://GitHub.com/a')).toBe('https://github.com/a');
    expect(safeExternalAlertUrl('ftp://github.com/a')).toBeNull();
    expect(safeExternalAlertUrl(undefined)).toBeNull();
    expect(safeExternalAlertUrl(`https://github.com/${'a'.repeat(3000)}`)).toBeNull();
  });

  it('accepts only CMS paths, with dot segments resolved first', () => {
    expect(safeCmsAlertPath('/cms/affiliates/approvals?page=2')).toBe('/cms/affiliates/approvals?page=2');
    expect(safeCmsAlertPath('/cms/affiliates/./payouts')).toBe('/cms/affiliates/payouts');
    expect(safeCmsAlertPath('/cmsx/affiliates')).toBeNull();
    expect(safeCmsAlertPath('/cms/../partners')).toBeNull();
    expect(safeCmsAlertPath('/cms/%2e%2e/partners')).toBeNull();
  });
});

describe('SystemAlertsBanner', () => {
  it('renders affiliate CTAs as in-app links and developer CTAs as new-tab links', () => {
    const html = renderToStaticMarkup(
      <SystemAlertsBanner
        alerts={[
          alert('affiliate_page_submitted', { action_url: '/cms/affiliates/approvals', action_label: 'Review storefronts' }, 'a1'),
          alert('merge_conflict', { action_url: 'https://github.com/acme/site/pulls/1' }, 'a2'),
        ]}
      />
    );

    expect(html).toContain('href="/cms/affiliates/approvals"');
    expect(html).toMatch(/<a href="\/cms\/affiliates\/approvals" data-next-link="true"[^>]*>/);
    expect(html).not.toMatch(/<a href="\/cms\/affiliates\/approvals"[^>]*target="_blank"/);
    expect(html).toMatch(/<a href="https:\/\/github\.com\/acme\/site\/pulls\/1" target="_blank" rel="noopener noreferrer"/);
    expect(html).toContain('Review storefronts');
    expect(html).toContain('Resolve on GitHub');
  });

  it('renders nothing without alerts and escapes alert text', () => {
    expect(renderToStaticMarkup(<SystemAlertsBanner alerts={[]} />)).toBe('');
    const html = renderToStaticMarkup(
      <SystemAlertsBanner
        alerts={[{ id: 'x', alert_type: 'affiliate_signed_up', title: '<img src=x onerror=alert(1)>', message: 'm', metadata: null }]}
      />
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});
