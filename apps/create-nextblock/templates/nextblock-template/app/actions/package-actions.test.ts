import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * License activation from the dashboard (app/actions/package-actions.ts). The sandbox's demo
 * admin login is public (2026-11-03), and activating a license there would spend a real seat
 * (the reset activates placeholder licenses itself). On the sandbox no action calls the license
 * APIs (the vendor's claim-license route, Freemius activate/deactivate, the license email resend)
 * or touches `package_activations`. Off the sandbox each one reaches them. The Freemius core
 * (lib/packages/activate-license.ts) runs for real; only fetch and the clients are faked.
 */

type ActivationWrite =
  | { op: 'upsert'; row: Record<string, unknown>; options: unknown }
  | { op: 'delete'; filters: Array<[string, string, unknown]> };

const mocks = vi.hoisted(() => ({
  role: 'ADMIN' as string | null,
  createCookieClient: vi.fn(),
  getUser: vi.fn(),
  createServiceClient: vi.fn(),
  headers: vi.fn(),
  fetch: vi.fn(),
  activeRows: [] as Array<Record<string, unknown>>,
  activationWrites: [] as ActivationWrite[],
  revalidatePath: vi.fn(),
  updateTag: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createServiceClient }));
vi.mock('@nextblock-cms/db/server', async () => ({
  createClient: mocks.createCookieClient,
  PACKAGE_ACTIVATION_CACHE_TAG: 'package-activation',
  // The real predicate (a dependency-free module), so the env stub drives it.
  isSandboxEnvironment: (
    await vi.importActual<{ isSandboxEnvironment: () => boolean }>('../../../../libs/db/src/lib/config-resolve')
  ).isSandboxEnvironment,
}));
// The real package registry (a dependency-free module).
vi.mock('@nextblock-cms/utils', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/utils/src/lib/nextblock-packages')),
}));
vi.mock('next/headers', () => ({ headers: mocks.headers }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath, updateTag: mocks.updateTag }));
vi.mock('../../lib/setup/env-status', () => ({
  resolveSupabaseAnonKey: () => 'anon-key',
  resolveSupabaseUrl: () => 'https://project.supabase.test',
}));
vi.mock('../../lib/setup/service-key', () => ({ resolveSupabaseServiceKey: () => 'service-role-key' }));

import { activatePackage, activatePurchasedPackage, deactivatePackage, resendPurchasedLicenseEmail } from './package-actions';

/** `delete()...` is awaited straight off the filter chain, so the chain is the thenable. */
class DeleteQuery implements PromiseLike<{ error: null }> {
  private readonly filters: Array<[string, string, unknown]> = [];

  eq(column: string, value: unknown) {
    this.filters.push(['eq', column, value]);
    return this;
  }

  neq(column: string, value: unknown) {
    this.filters.push(['neq', column, value]);
    return this;
  }

  then<TResult1 = { error: null }, TResult2 = never>(
    onFulfilled?: ((value: { error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    mocks.activationWrites.push({ op: 'delete', filters: this.filters });
    return Promise.resolve({ error: null as null }).then(onFulfilled, onRejected);
  }
}

type SelectQuery = {
  eq: () => SelectQuery;
  order: () => SelectQuery;
  limit: () => Promise<{ data: Array<Record<string, unknown>>; error: null }>;
};

/** The service-role client package-actions builds with @supabase/supabase-js. */
function fakeServiceClient() {
  return {
    from: (table: string) => {
      expect(table).toBe('package_activations');
      const select: SelectQuery = {
        eq: () => select,
        order: () => select,
        limit: async () => ({ data: mocks.activeRows, error: null }),
      };
      return {
        select: () => select,
        upsert: async (row: Record<string, unknown>, options: unknown) => {
          mocks.activationWrites.push({ op: 'upsert', row, options });
          return { error: null };
        },
        delete: () => new DeleteQuery(),
      };
    },
  };
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' }, status: 200 });
}

const CLAIM_URL = 'https://nextblock.dev/api/packages/claim-license';
const RESEND_URL = 'https://api.freemius.com/v1/resend?t=1';

/** What the Freemius Checkout overlay hands back after a paid purchase. */
const CHECKOUT_RESPONSE = {
  purchase: { license_id: 123 },
  user: { email: 'buyer@example.com', id: 456, resend_email_endpoint: RESEND_URL },
};

function fetchedUrls(): string[] {
  return mocks.fetch.mock.calls.map(([url]) => String(url));
}

function resetCalls() {
  mocks.createCookieClient.mockClear();
  mocks.getUser.mockClear();
  mocks.createServiceClient.mockClear();
  mocks.headers.mockClear();
  mocks.fetch.mockClear();
  mocks.revalidatePath.mockClear();
  mocks.updateTag.mockClear();
  mocks.activationWrites = [];
}

/** Nothing that spends or frees a seat ran: no license API, no service-role client, no activation row. */
function expectNoLicenseSideEffects() {
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.createServiceClient).not.toHaveBeenCalled();
  expect(mocks.activationWrites).toEqual([]);
  expect(mocks.headers).not.toHaveBeenCalled();
  expect(mocks.updateTag).not.toHaveBeenCalled();
  expect(mocks.revalidatePath).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  vi.stubEnv('NEXTBLOCK_LICENSE_SERVICE_URL', '');
  mocks.role = 'ADMIN';
  mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: 'admin-1' } } });
  mocks.createCookieClient.mockReset().mockImplementation(() => ({
    auth: { getUser: mocks.getUser },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: table === 'profiles' && mocks.role ? { role: mocks.role } : null }),
        }),
      }),
    }),
  }));
  mocks.createServiceClient.mockReset().mockImplementation(() => fakeServiceClient());
  mocks.headers.mockReset().mockResolvedValue(new Headers({ host: 'site.example', 'x-forwarded-proto': 'https' }));
  mocks.fetch.mockReset().mockImplementation(async (url: string | URL) => {
    const href = String(url);
    if (href === CLAIM_URL) return json({ licenseKey: 'sk_claimed_key', planId: '9' });
    if (href.includes('/licenses/activate.json?')) return json({ install_id: 777, license_plan_id: 9 });
    if (href.includes('/licenses/deactivate.json?')) return json({ id: 1 });
    if (href === RESEND_URL) return json({ sent: true });
    throw new Error(`Unexpected fetch: ${href}`);
  });
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.activeRows = [
    {
      id: 'activation-1',
      instance_name: 'site.example',
      license_key: 'sk_owner_key',
      meta: { fm_install_id: 777, fm_product_id: '28609', fm_uid: 'uid-1' },
    },
  ];
  resetCalls();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('activatePackage', () => {
  it('refuses on the sandbox before the license API or any activation write', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    // The admin check (a session and profile read) runs first; the refusal follows it.
    expect(await activatePackage('sk_visitor_key', { packageId: 'cortex-ai' })).toEqual({
      error: 'License activation is disabled in Sandbox mode. To purchase a real license, visit nextblock.dev',
    });
    expectNoLicenseSideEffects();
  });

  it('activates against Freemius and records the row anywhere else (only the exact value "true" is the sandbox)', async () => {
    for (const value of ['', 'false', 'TRUE', '1']) {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      resetCalls();

      expect(await activatePackage('sk_owner_key', { packageId: 'cortex-ai' }), value).toMatchObject({
        packageId: 'cortex-ai',
        success: true,
      });

      expect(fetchedUrls(), value).toEqual([expect.stringContaining('/licenses/activate.json?license_key=sk_owner_key')]);
      expect(mocks.activationWrites[0], value).toMatchObject({
        op: 'upsert',
        row: { license_key: 'sk_owner_key', package_id: 'cortex-ai', status: 'active' },
      });
    }
  });
});

describe('activatePurchasedPackage', () => {
  it('refuses on the sandbox before the admin check, the claim-license call or any activation write', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    expect(await activatePurchasedPackage({ checkoutResponse: CHECKOUT_RESPONSE, packageId: 'cortex-ai' })).toEqual({
      activated: false,
      email: 'buyer@example.com',
      message: 'License activation is disabled in Sandbox mode.',
      reason: 'sandbox',
      resendEmailEndpoint: RESEND_URL,
    });
    expect(mocks.createCookieClient).not.toHaveBeenCalled();
    expectNoLicenseSideEffects();
  });

  it('claims the key and activates it anywhere else (only the exact value "true" is the sandbox)', async () => {
    for (const value of ['', 'false', 'TRUE', '1']) {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      resetCalls();

      expect(
        await activatePurchasedPackage({ checkoutResponse: CHECKOUT_RESPONSE, packageId: 'cortex-ai' }),
        value
      ).toMatchObject({ activated: true, isTrial: false, packageId: 'cortex-ai' });

      expect(fetchedUrls(), value).toEqual([
        CLAIM_URL,
        expect.stringContaining('/licenses/activate.json?license_key=sk_claimed_key'),
      ]);
      expect(JSON.parse(String(mocks.fetch.mock.calls[0][1]?.body)), value).toMatchObject({
        email: 'buyer@example.com',
        licenseId: '123',
        userId: '456',
      });
      expect(mocks.activationWrites[0], value).toMatchObject({
        op: 'upsert',
        row: { license_key: 'sk_claimed_key', package_id: 'cortex-ai' },
      });
    }
  });
});

describe('deactivatePackage', () => {
  it('refuses on the sandbox before the admin check, Freemius or the activation delete', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    expect(await deactivatePackage('cortex-ai')).toEqual({ error: 'License deactivation is disabled in Sandbox mode.' });
    expect(mocks.createCookieClient).not.toHaveBeenCalled();
    expectNoLicenseSideEffects();
  });

  it('deactivates at Freemius and removes the rows anywhere else (only the exact value "true" is the sandbox)', async () => {
    for (const value of ['', 'false', 'TRUE', '1']) {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      resetCalls();

      expect(await deactivatePackage('cortex-ai'), value).toEqual({ success: true });

      expect(fetchedUrls(), value).toEqual([
        expect.stringContaining('/products/28609/licenses/deactivate.json?uid=uid-1&install_id=777'),
      ]);
      expect(mocks.activationWrites, value).toEqual([{ op: 'delete', filters: [['eq', 'package_id', 'cortex-ai']] }]);
    }
  });
});

describe('resendPurchasedLicenseEmail', () => {
  it('refuses on the sandbox before the admin check or the Freemius call', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    expect(await resendPurchasedLicenseEmail(RESEND_URL)).toEqual({ error: 'License emails are disabled in Sandbox mode.', ok: false });
    expect(mocks.createCookieClient).not.toHaveBeenCalled();
    expectNoLicenseSideEffects();
  });

  it('asks Freemius to re-send the license email anywhere else (only the exact value "true" is the sandbox)', async () => {
    for (const value of ['', 'false', 'TRUE', '1']) {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      resetCalls();

      expect(await resendPurchasedLicenseEmail(RESEND_URL), value).toEqual({ ok: true });

      expect(mocks.createCookieClient, value).toHaveBeenCalledTimes(1);
      expect(fetchedUrls(), value).toEqual([RESEND_URL]);
      expect(mocks.fetch.mock.calls[0][1], value).toMatchObject({ method: 'POST' });
    }
  });
});
