import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AFFILIATES_PORTAL_COPY } from '@nextblock-cms/affiliates';

/**
 * The storefront studio page asks whether the site's Cortex AI package is active and, when it is
 * not (or the check fails), hands the studio a localized reason that disables the copilot panel:
 * /api/affiliates/cortex would refuse every message with a 403 otherwise.
 */

const mocks = vi.hoisted(() => ({
  cortexAi: 'active' as 'active' | 'inactive' | 'throws',
  locale: 'en',
  studioProps: [] as Array<Record<string, unknown>>,
  verifyPackageOnline: vi.fn(),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('@nextblock-cms/db/server', () => ({ verifyPackageOnline: mocks.verifyPackageOnline }));
vi.mock('../../../../../lib/affiliates/retailer-actor', () => ({
  requireRetailerPage: async () => ({ supabase: {}, actor: { userId: 'user-1' } }),
}));
vi.mock('../../../../../lib/affiliates/portal-data', () => ({
  readRetailerPortalAccount: () => ({
    profile: {
      handle: 'jane-picks',
      status: 'ACTIVE',
      display_name: 'Jane',
      bio: null,
      social_links: {},
      preferred_locale: 'en',
    },
    page: {
      id: 'page-1',
      title: 'My picks',
      meta_description: '',
      featured_product_ids: [],
      draft_version: 3,
      approval_status: 'DRAFT',
      admin_feedback_note: null,
    },
  }),
  loadRetailerStudioData: async () => ({
    siteOrigin: 'https://shop.example.com',
    storefrontUrl: 'https://shop.example.com/partners/jane-picks',
    avatarUrl: null,
    allowedImageOrigins: ['https://media.example.com'],
    draftDoc: { type: 'doc', content: [] },
    featuredProducts: [],
    isApproved: false,
    isLive: false,
    profileChangedSincePublish: false,
  }),
}));
vi.mock('../../../../../lib/affiliates/request-locale', () => ({
  getRequestLocale: async () => mocks.locale,
  toAffiliatesLocale: (value: string) => (value === 'fr' ? 'fr' : 'en'),
}));
// The real dictionaries and copy runtime (no operator overrides), through vi.importActual: an
// import() of the lib would make Nx treat it as lazy-loaded.
vi.mock('../components/portal-server-copy', async () => {
  const runtime = (await vi.importActual('../../../../../../../libs/affiliates/src/lib/i18n/copy-runtime')) as {
    createAffiliatesCopy: (options: { locale: string; dictionary: unknown }) => (key: string, values?: unknown) => string;
  };
  const { PORTAL_UI_COPY } = (await vi.importActual('../components/portal-copy')) as { PORTAL_UI_COPY: unknown };
  return {
    getPortalServerCopy: async (locale?: string | null) =>
      runtime.createAffiliatesCopy({ locale: locale ?? 'en', dictionary: PORTAL_UI_COPY }),
  };
});
vi.mock('../components/StorefrontStudio', () => ({
  StorefrontStudio: (props: Record<string, unknown>) => {
    mocks.studioProps.push(props);
    return null;
  },
}));

import RetailerStorefrontStudioPage from './page';

const UNAVAILABLE = AFFILIATES_PORTAL_COPY['affiliates.portal.copilot_unavailable'];

beforeEach(() => {
  mocks.cortexAi = 'active';
  mocks.locale = 'en';
  mocks.studioProps = [];
  mocks.verifyPackageOnline.mockReset();
  mocks.verifyPackageOnline.mockImplementation(async (id: string) => {
    if (id !== 'cortex-ai') return true;
    if (mocks.cortexAi === 'throws') throw new Error('package check failed');
    return mocks.cortexAi === 'active';
  });
});

async function studioProps(): Promise<Record<string, unknown>> {
  renderToStaticMarkup(await RetailerStorefrontStudioPage());
  expect(mocks.studioProps).toHaveLength(1);
  return mocks.studioProps[0] as Record<string, unknown>;
}

describe('RetailerStorefrontStudioPage copilot availability', () => {
  it('leaves the copilot enabled while Cortex AI is active', async () => {
    const props = await studioProps();
    expect(mocks.verifyPackageOnline).toHaveBeenCalledWith('cortex-ai');
    expect(props['copilotUnavailableReason']).toBeNull();
  });

  it('passes the localized reason when Cortex AI is inactive', async () => {
    mocks.cortexAi = 'inactive';
    expect((await studioProps())['copilotUnavailableReason']).toBe(UNAVAILABLE.en);
  });

  it('localizes the reason for a French partner', async () => {
    mocks.cortexAi = 'inactive';
    mocks.locale = 'fr';
    expect((await studioProps())['copilotUnavailableReason']).toBe(UNAVAILABLE.fr);
  });

  it('treats a failed package check as inactive', async () => {
    mocks.cortexAi = 'throws';
    expect((await studioProps())['copilotUnavailableReason']).toBe(UNAVAILABLE.en);
  });
});
