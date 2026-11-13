import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AFFILIATES_SANDBOX_COPY } from '@nextblock-cms/affiliates';

/**
 * On a full page load the portal layout's sign-in redirect is the one that answers (it renders
 * before the page segment), so it must carry the page and query the partner asked for: an email's
 * deep link to /portal/retailer/storefront or /payouts, Stripe Connect's ?connected=1 landing.
 * The address comes from the proxy's x-nextblock-path / x-nextblock-search headers and never
 * leaves the portal.
 *
 * On the public sandbox every visitor signs in as the same demo partner, so the shell says so above
 * every page and names the demo admin login that approves a submitted page; nowhere else.
 */

const mocks = vi.hoisted(() => ({
  headers: {} as Record<string, string>,
  locale: 'en',
  account: null as null | { profile: Record<string, unknown>; page: null },
  /** The dictionary each `getAffiliateCopyOverrides` call loaded overrides for (the provider's). */
  overrideDictionaries: [] as Array<Record<string, unknown>>,
  requireRetailerPage: vi.fn(async (_path: string, _options?: unknown): Promise<{ actor: unknown }> => {
    throw new Error('NEXT_REDIRECT_SENTINEL');
  }),
}));

vi.mock('next/headers', () => ({
  headers: async () => ({ get: (name: string) => mocks.headers[name.toLowerCase()] ?? null }),
}));
vi.mock('next/server', () => ({ after: vi.fn() }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('../../../../lib/affiliates/retailer-actor', () => ({ requireRetailerPage: mocks.requireRetailerPage }));
vi.mock('../../../../lib/affiliates/payout-runner', () => ({ maybeRunAffiliatePayouts: async () => undefined }));
vi.mock('../../../../lib/affiliates/portal-data', () => ({
  readRetailerPortalAccount: () => mocks.account,
  resolveAffiliateAvatarUrl: () => null,
}));
vi.mock('../../../../lib/affiliates/request-locale', () => ({ getRequestLocale: async () => mocks.locale }));
vi.mock('../../../../lib/affiliates/server-copy', () => ({
  getAffiliateCopyOverrides: async ({ dictionary }: { dictionary: Record<string, unknown> }) => {
    mocks.overrideDictionaries.push(dictionary);
    return {};
  },
}));
// The real dictionaries and copy runtime (no operator overrides), through vi.importActual: an
// import() of the lib would make Nx treat it as lazy-loaded.
vi.mock('./components/portal-server-copy', async () => {
  const runtime = (await vi.importActual('../../../../../../libs/affiliates/src/lib/i18n/copy-runtime')) as {
    createAffiliatesCopy: (options: { locale: string; dictionary: unknown }) => (key: string, values?: unknown) => string;
  };
  const { PORTAL_UI_COPY } = (await vi.importActual('./components/portal-copy')) as { PORTAL_UI_COPY: unknown };
  return {
    getPortalServerCopy: async (locale?: string | null) =>
      runtime.createAffiliatesCopy({ locale: locale ?? 'en', dictionary: PORTAL_UI_COPY }),
  };
});
vi.mock('./components/PortalNav', () => ({ PortalNav: () => null }));

import RetailerPortalLayout from './layout';
import { SANDBOX_AFFILIATE_DEMO_BUYER_EMAIL } from '../../../api/cron/reset-sandbox/affiliate-demo';

async function returnPathFor(headers: Record<string, string>): Promise<string> {
  mocks.headers = headers;
  mocks.requireRetailerPage.mockClear();
  await expect(RetailerPortalLayout({ children: null })).rejects.toThrow('NEXT_REDIRECT_SENTINEL');
  expect(mocks.requireRetailerPage).toHaveBeenCalledTimes(1);
  const [path, options] = mocks.requireRetailerPage.mock.calls[0];
  expect(options).toEqual({ allowSuspended: true });
  return path;
}

beforeEach(() => {
  // Not the sandbox unless a case says so, whatever the shell running the tests exports.
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  mocks.headers = {};
  mocks.locale = 'en';
  mocks.account = null;
  mocks.overrideDictionaries = [];
  mocks.requireRetailerPage.mockImplementation(async () => {
    throw new Error('NEXT_REDIRECT_SENTINEL');
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('RetailerPortalLayout sign-in return address', () => {
  it('returns to the portal page that was asked for, with its query string', async () => {
    await expect(returnPathFor({ 'x-nextblock-path': '/portal/retailer/payouts', 'x-nextblock-search': '?connected=1' })).resolves.toBe(
      '/portal/retailer/payouts?connected=1',
    );
    await expect(returnPathFor({ 'x-nextblock-path': '/portal/retailer/storefront', 'x-nextblock-search': '' })).resolves.toBe(
      '/portal/retailer/storefront',
    );
    await expect(returnPathFor({ 'x-nextblock-path': '/portal/retailer' })).resolves.toBe('/portal/retailer');
  });

  it('falls back to the overview for anything outside the portal, or no header', async () => {
    for (const path of ['/cms/users', '//evil.example', '/portal/retailerx', 'https://evil.example/portal/retailer']) {
      await expect(returnPathFor({ 'x-nextblock-path': path, 'x-nextblock-search': '?connected=1' })).resolves.toBe('/portal/retailer');
    }
    await expect(returnPathFor({})).resolves.toBe('/portal/retailer');
  });
});

describe('RetailerPortalLayout on the public sandbox: the shared demo account notice', () => {
  const NOTICE_TITLE_EN = 'Shared demo account';
  const NOTICE_BODY_EN =
    'Every visitor uses this account. The demo resets every 15 minutes and sends no email. After you submit your page, sign in as demo@nextblock.dev to approve it.';

  beforeEach(() => {
    mocks.requireRetailerPage.mockImplementation(async () => ({ actor: { userId: 'user-1' } }));
    mocks.account = {
      profile: {
        id: 'aff-1',
        handle: 'studio-nova',
        display_name: 'Studio Nova',
        status: 'ACTIVE',
        first_published_at: null,
        avatar_object_key: null,
        suspended_reason: null,
      },
      page: null,
    };
  });

  async function renderShell(): Promise<string> {
    return renderToStaticMarkup(await RetailerPortalLayout({ children: <p>page body</p> }));
  }

  it('shows an info notice above every page, in English', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const html = await renderShell();

    const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(html).toMatch(
      new RegExp(
        `<div class="[^"]*border-sky-300[^"]*"><p class="font-semibold">${literal(NOTICE_TITLE_EN)}</p><div[^>]*><p>${literal(NOTICE_BODY_EN)}</p></div></div>`,
      ),
    );
    expect(html.indexOf(NOTICE_TITLE_EN)).toBeLessThan(html.indexOf('page body'));
  });

  it('is written in Québec French', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    mocks.locale = 'fr';
    const html = await renderShell();

    expect(html).toContain('<p class="font-semibold">Compte de démonstration partagé</p>');
    expect(html).toContain(
      'Tous les visiteurs utilisent ce compte. La démo est réinitialisée toutes les 15 minutes et n&#x27;envoie aucun courriel. Après avoir soumis votre page, connectez-vous avec demo@nextblock.dev pour l&#x27;approuver.',
    );
  });

  it('names the admin login the reset cron keeps (the reviewer of the demo page)', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    expect(await renderShell()).toContain(`sign in as ${SANDBOX_AFFILIATE_DEMO_BUYER_EMAIL} to approve it.`);
  });

  it.each(['', 'false', '1'])('is absent when NEXT_PUBLIC_IS_SANDBOX is %j', async (value) => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
    const html = await renderShell();

    expect(html).toContain('page body');
    expect(html).not.toContain(NOTICE_TITLE_EN);
    expect(html).not.toContain('demo@nextblock.dev');
    expect(html).not.toContain('border-sky-300');
  });

  it('loads the operator overrides for the sandbox keys with the rest of the portal copy', async () => {
    await renderShell();
    expect(mocks.overrideDictionaries).toHaveLength(1);
    for (const key of Object.keys(AFFILIATES_SANDBOX_COPY)) {
      expect(mocks.overrideDictionaries[0], key).toHaveProperty([key]);
    }
  });
});
