import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The CMS packages page lists `package_activations` rows (including the license key). Migration
 * 02022 locked that table's SELECT behind `public.is_admin_mfa()`, so the read must use the
 * service-role client — otherwise an ADMIN on an aal1 ("remember this device") session is locked
 * out of their own packages screen. These tests pin that the read goes through the service-role
 * client and never the cookie-scoped client.
 */

type QueryResult = { data?: unknown; error?: unknown };

function chainable(result: QueryResult) {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'in', 'eq', 'order', 'limit']) {
    builder[method] = vi.fn(() => builder);
  }
  builder['then'] = (resolve: (value: QueryResult) => unknown) => resolve(result);
  return builder;
}

const mocks = vi.hoisted(() => ({
  cookieFrom: vi.fn(),
  serviceFrom: vi.fn(),
  createClient: vi.fn(),
  getServiceRoleSupabaseClient: vi.fn(),
  card: vi.fn(),
}));

vi.mock('@nextblock-cms/db/server', () => ({
  createClient: mocks.createClient,
  getServiceRoleSupabaseClient: mocks.getServiceRoleSupabaseClient,
}));

// Mirrors the registry's three packages.
vi.mock('@nextblock-cms/utils', () => {
  const NEXTBLOCK_PACKAGES = {
    ecommerce: { id: 'ecommerce', name: 'Commerce Pro', fm_product_id: '24851', fm_plan_id: '41208', requires: [] as string[] },
    'cortex-ai': { id: 'cortex-ai', name: 'Cortex AI', fm_product_id: '28609', fm_plan_id: '47122', requires: [] as string[] },
    affiliates: { id: 'affiliates', name: 'Affiliates', fm_product_id: '43273', fm_plan_id: '75655', requires: ['ecommerce'] },
  };
  type Pkg = (typeof NEXTBLOCK_PACKAGES)[keyof typeof NEXTBLOCK_PACKAGES];
  return {
    NEXTBLOCK_PACKAGES,
    missingPackageRequirements: (pkg: Pkg, isActive: (id: string) => boolean) =>
      pkg.requires
        .map((id) => NEXTBLOCK_PACKAGES[id as keyof typeof NEXTBLOCK_PACKAGES])
        .filter((required) => required && !isActive(required.id)),
  };
});

vi.mock('./activation-form', () => ({ ActivationForm: () => null }));
vi.mock('./package-card', () => ({
  PackageCard: (props: unknown) => {
    mocks.card(props);
    return null;
  },
}));

import PackagesPage from './page';

describe('PackagesPage package-activation read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.cookieFrom.mockImplementation(() => chainable({ data: [], error: null }));
    mocks.serviceFrom.mockImplementation(() => chainable({ data: [], error: null }));
    mocks.createClient.mockReturnValue({ from: mocks.cookieFrom });
    mocks.getServiceRoleSupabaseClient.mockReturnValue({ from: mocks.serviceFrom });
  });

  it('reads package_activations with the service-role client, never the cookie client', async () => {
    await PackagesPage();

    expect(mocks.getServiceRoleSupabaseClient).toHaveBeenCalledTimes(1);
    expect(mocks.serviceFrom).toHaveBeenCalledWith('package_activations');
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it('renders one card per registry package, affiliates included, with its activation state', async () => {
    mocks.serviceFrom.mockImplementation(() =>
      chainable({
        data: [
          { package_id: 'affiliates', status: 'expired', license_key: 'old', meta: {} },
          { package_id: 'affiliates', status: 'active', license_key: 'sandbox-key', meta: {} },
        ],
        error: null,
      })
    );

    renderToStaticMarkup((await PackagesPage()) as ReactElement);

    const cards = mocks.card.mock.calls.map(([props]) => props as { pkg: { id: string }; isActive: boolean; licenseKey?: string });
    expect(cards.map((card) => card.pkg.id)).toEqual(['ecommerce', 'cortex-ai', 'affiliates']);
    expect(cards.find((card) => card.pkg.id === 'affiliates')).toMatchObject({ isActive: true, licenseKey: 'sandbox-key' });
    expect(cards.find((card) => card.pkg.id === 'ecommerce')).toMatchObject({ isActive: false });
  });

  // Affiliates is a Commerce Pro add-on (2026-10-29): its card learns whether Commerce is active.
  it('tells the Affiliates card that Commerce Pro is missing until Commerce is active', async () => {
    renderToStaticMarkup((await PackagesPage()) as ReactElement);
    let cards = mocks.card.mock.calls.map(([props]) => props as { pkg: { id: string }; missingRequirements: unknown[] });
    expect(cards.find((card) => card.pkg.id === 'affiliates')?.missingRequirements).toEqual([{ id: 'ecommerce', name: 'Commerce Pro' }]);
    expect(cards.find((card) => card.pkg.id === 'ecommerce')?.missingRequirements).toEqual([]);

    mocks.card.mockClear();
    mocks.serviceFrom.mockImplementation(() =>
      chainable({ data: [{ package_id: 'ecommerce', status: 'active', license_key: 'shop-key', meta: {} }], error: null })
    );
    renderToStaticMarkup((await PackagesPage()) as ReactElement);
    cards = mocks.card.mock.calls.map(([props]) => props as { pkg: { id: string }; missingRequirements: unknown[] });
    expect(cards.find((card) => card.pkg.id === 'affiliates')?.missingRequirements).toEqual([]);
  });

  it('renders without throwing when the service client is unavailable', async () => {
    mocks.getServiceRoleSupabaseClient.mockImplementation(() => {
      throw new Error('Missing Supabase Service Role environment variables');
    });

    await expect(PackagesPage()).resolves.toBeTruthy();
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
});
