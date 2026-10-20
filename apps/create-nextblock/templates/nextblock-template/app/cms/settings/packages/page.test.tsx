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
}));

vi.mock('@nextblock-cms/db/server', () => ({
  createClient: mocks.createClient,
  getServiceRoleSupabaseClient: mocks.getServiceRoleSupabaseClient,
}));

vi.mock('@nextblock-cms/utils', () => ({
  NEXTBLOCK_PACKAGES: {
    ecommerce: { id: 'ecommerce', name: 'Commerce Pro' },
    'cortex-ai': { id: 'cortex-ai', name: 'Cortex AI' },
  },
}));

vi.mock('./activation-form', () => ({ ActivationForm: () => null }));
vi.mock('./package-card', () => ({ PackageCard: () => null }));

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

  it('renders without throwing when the service client is unavailable', async () => {
    mocks.getServiceRoleSupabaseClient.mockImplementation(() => {
      throw new Error('Missing Supabase Service Role environment variables');
    });

    await expect(PackagesPage()).resolves.toBeTruthy();
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
});
