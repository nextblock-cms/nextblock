import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "Sync from Freemius" on the public sandbox. Its admin login is published and its second factor
 * always passes, and the sync reads the catalog with the operator's Freemius developer key pair,
 * which production depends on (checkouts, license links, claims, coupon pushes, webhook checks).
 * The round-2 review sent 110 developer-signed GETs for 5 clicks there, with nothing to limit
 * them, so a visitor could push the shared key into Freemius 429s. Both actions now refuse on the
 * sandbox right after the admin check (the 15-minute reset syncs the demo catalog itself).
 *
 * The provider and the developer-scope module run for real here: only Freemius (fetch), the
 * databases and the configured developer pair are faked, so a request the refusal let through
 * would show up as a fetch.
 */

const mocks = vi.hoisted(() => ({
  user: null as { id: string } | null,
  role: null as string | null,
  candidates: vi.fn(async () => [] as Array<Record<string, string>>),
  revalidatePath: vi.fn(),
}));

vi.mock('server-only', () => ({}));
// The service-role client the provider builds for its product writes: every query answers empty.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => {
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    Object.assign(builder, {
      select: chain,
      eq: chain,
      upsert: chain,
      update: chain,
      insert: chain,
      delete: chain,
      order: chain,
      in: chain,
      single: async () => ({ data: { id: 1 }, error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      then: (ok: (value: unknown) => unknown) => Promise.resolve({ data: [{ id: 'p1' }], error: null }).then(ok),
    });
    return { from: () => builder, rpc: async () => ({ data: null, error: null }) };
  },
}));
vi.mock('@nextblock-cms/db/server', async () => ({
  // The cookie session requireEcomAdmin() reads the caller and their role through.
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: mocks.user } }) },
    from: () => ({
      select: () => ({
        eq: () => ({ single: async () => ({ data: mocks.role ? { role: mocks.role } : null }) }),
      }),
    }),
  }),
  getServiceRoleSupabaseClient: () => ({}),
  // The real predicate (a dependency-free module), so the env stub drives it.
  isSandboxEnvironment: (
    await vi.importActual<{ isSandboxEnvironment: () => boolean }>('../../../../../../db/src/lib/config-resolve')
  ).isSandboxEnvironment,
}));
vi.mock('../../../payment-config', () => ({
  hydrateFreemiusEnvFromDb: async () => undefined,
  resolveFreemiusDeveloperCredentialCandidates: mocks.candidates,
}));
vi.mock('../../../product-actions', () => ({
  getProduct: vi.fn(),
  getProducts: vi.fn(),
  copyProductFromLanguage: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

// The app's second-factor gate, as registered at server start: this caller has passed it (as the
// sandbox's demo admin always does). 2FA itself is covered by require-ecom-role.test.ts.
(globalThis as Record<symbol, unknown>)[Symbol.for('nextblock.cms.secondFactorGate')] = async () => true;

import { forgetFreemiusDeveloperCaches } from '../../../freemius-developer-api';
import { triggerFreemiusSync, triggerSingleProductSync } from './actions';

const DEV = '4242';
// The sandbox env holds the operator's developer pair so that its reset can sync the real catalog.
const PAIR = { developerId: DEV, publicKey: 'pk_dev_master', secretKey: 'sk_dev_master', source: 'env' };
const SANDBOX_MESSAGE = 'Sync from Freemius is turned off on the public demo; the demo resets every 15 minutes.';

type Call = { url: string; authorization: string };

/** api.freemius.com: three products with three plans each, every request recorded. */
function stubFreemius(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), authorization: String((init.headers as Record<string, string> | undefined)?.['Authorization'] ?? '') });
      const path = String(url).replace(`https://api.freemius.com/v1/developers/${DEV}`, '').split('?')[0];
      if (path === '/plugins.json') {
        return new Response(JSON.stringify({ plugins: [24851, 28609, 43273].map((id) => ({ id, title: `P${id}` })) }), { status: 200 });
      }
      if (/^\/plugins\/\d+\.json$/.test(path)) return new Response(JSON.stringify({ id: 28609, title: 'P28609' }), { status: 200 });
      if (/^\/plugins\/\d+\/plans\.json$/.test(path)) {
        return new Response(JSON.stringify({ plans: [{ id: 1001, name: 'a' }, { id: 1002, name: 'b' }, { id: 1003, name: 'c' }] }), { status: 200 });
      }
      if (/^\/plugins\/\d+\/plans\/\d+\.json$/.test(path)) {
        return new Response(JSON.stringify({ plan: { trial_period: 0, is_require_subscription: false } }), { status: 200 });
      }
      if (/pricing\.json$/.test(path)) return new Response(JSON.stringify({ pricing: [{ annual_price: 99, licenses: 1 }] }), { status: 200 });
      return new Response('{}', { status: 404 });
    })
  );
  return calls;
}

function signInAs(role: string | null) {
  mocks.user = { id: 'demo-admin' };
  mocks.role = role;
}

beforeEach(() => {
  forgetFreemiusDeveloperCaches();
  mocks.user = null;
  mocks.role = null;
  mocks.candidates.mockReset().mockImplementation(async () => [PAIR]);
  mocks.revalidatePath.mockReset();
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-test-key');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Sync from Freemius on the public sandbox', () => {
  it('refuses the demo admin both syncs, click after click, before any Freemius request', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    signInAs('ADMIN');
    const calls = stubFreemius();

    for (let click = 0; click < 5; click += 1) {
      await expect(triggerFreemiusSync()).resolves.toEqual({ error: SANDBOX_MESSAGE });
      await expect(triggerSingleProductSync('28609')).resolves.toEqual({ error: SANDBOX_MESSAGE });
    }

    expect(calls).toEqual([]);
    // Not even the developer pair was resolved, and nothing was revalidated.
    expect(mocks.candidates).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('answers an anonymous caller with the admin refusal, still without asking Freemius', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const calls = stubFreemius();

    await expect(triggerFreemiusSync()).resolves.toEqual({ error: 'Unauthorized' });
    await expect(triggerSingleProductSync('28609')).resolves.toEqual({ error: 'Unauthorized' });
    expect(calls).toEqual([]);
  });
});

describe('Sync from Freemius anywhere else', () => {
  it('reads the catalog with developer-signed GETs for an ADMIN (what the sandbox refusal stops)', async () => {
    signInAs('ADMIN');
    const calls = stubFreemius();

    await expect(triggerFreemiusSync()).resolves.toMatchObject({ success: true });
    const fullSync = calls.length;
    expect(fullSync).toBeGreaterThan(0);

    await expect(triggerSingleProductSync('28609')).resolves.toMatchObject({ success: true });
    expect(calls.length).toBeGreaterThan(fullSync);

    for (const call of calls) {
      expect(call.url.startsWith(`https://api.freemius.com/v1/developers/${DEV}/plugins`)).toBe(true);
      expect(call.authorization.startsWith(`FS ${DEV}:${PAIR.publicKey}:`)).toBe(true);
    }
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/cms/products', 'page');
  });
});
