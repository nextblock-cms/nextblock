import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { AFFILIATES_PACKAGE_ID } from '@nextblock-cms/affiliates';

/**
 * The sandbox reset is destructive, so its guards fail closed: 404 anywhere but the sandbox, 401
 * without CRON_SECRET (an unset secret must never turn into a guessable bearer such as
 * "Bearer undefined") or with a wrong bearer, compared in constant time, no minimum length.
 * The guard tests stop at the missing storage environment. The reset tests run the whole route
 * against fakes (R2, Postgres, the auth admin, the network) for what happens around the reset:
 * the GoTrue public sign-up alarm, the upload target alarm, the demo admin's restore (right after
 * the SQL, whatever fails later) and the demo storefront cache eviction.
 */

const mocks = vi.hoisted(() => ({
  timingSafeEqual: vi.fn(),
  s3: vi.fn(),
  postgres: vi.fn(),
  createClient: vi.fn(),
  syncFreemiusProductsToSupabase: vi.fn(),
  activateSandboxPackage: vi.fn(),
  seedSandboxAffiliateDemo: vi.fn(),
  evictAffiliateStorefrontCache: vi.fn(),
  evictAffiliateTiersCache: vi.fn(),
}));

// The reset itself (2 MB of SQL, R2, Postgres, Supabase, package activation) is faked.
vi.mock('./sandboxResetSql', () => ({ SANDBOX_RESET_SQL: '' }));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: mocks.s3,
  ListObjectsV2Command: vi.fn(),
  DeleteObjectsCommand: vi.fn(),
  PutObjectCommand: vi.fn(),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));
vi.mock('@nextblock-cms/ecommerce/server', () => ({
  syncFreemiusProductsToSupabase: mocks.syncFreemiusProductsToSupabase,
  syncSingleFreemiusProduct: vi.fn(),
}));
vi.mock('@nextblock-cms/cortex', () => ({ CORTEX_AI_PACKAGE_ID: 'cortex-ai' }));
vi.mock('postgres', () => ({ default: mocks.postgres }));
vi.mock('./activate-package', () => ({ activateSandboxPackage: mocks.activateSandboxPackage }));
vi.mock('./affiliate-demo', () => ({
  SANDBOX_AFFILIATE_DEMO_HANDLE: 'studio-nova',
  SANDBOX_AFFILIATE_DEMO_FR_HANDLE: 'atelier-boreal',
  seedSandboxAffiliateDemo: mocks.seedSandboxAffiliateDemo,
}));
vi.mock('../../../../lib/affiliates/cache', () => ({
  evictAffiliateStorefrontCache: mocks.evictAffiliateStorefrontCache,
  evictAffiliateTiersCache: mocks.evictAffiliateTiersCache,
}));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  mocks.timingSafeEqual.mockImplementation(actual.timingSafeEqual);
  return { ...actual, default: actual, timingSafeEqual: mocks.timingSafeEqual };
});

import { GET } from './route';

const ROUTE_URL = 'https://sandbox.example.org/api/cron/reset-sandbox';
const SUPABASE_PROJECT_URL = 'https://sandbox-project.supabase.co';
const PUBLISHABLE_KEY = 'sb_publishable_sandbox-test-key';
const SERVICE_ROLE_KEY = 'service-role-test-key';
const SIGNUPS_WARNING =
  'GoTrue accepts public sign-ups: turn off "Allow new users to sign up" on the sandbox project.';
const COULD_NOT_CHECK = '[Sandbox Reset] Could not check whether GoTrue accepts public sign-ups:';
const SUCCESS = { success: true, message: 'Sandbox hard reset completed successfully' };

/** Every variable the route reads: blank unless a test sets it. */
const ROUTE_ENV = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SECRET_KEY',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_PUBLISHABLE_KEY',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
  'R2_S3_ENDPOINT',
  'R2_S3_PUBLIC_ENDPOINT',
  'STORAGE_PROVIDER',
  'STORAGE_BUCKET',
  'NEXT_PUBLIC_URL',
  'POSTGRES_URL',
  'DATABASE_URL',
  'FREEMIUS_ECOMMERCE_SANDBOX_KEY',
  'FREEMIUS_AI_SANDBOX_KEY',
  'FREEMIUS_AFFILIATES_SANDBOX_KEY',
];

/** A configured sandbox: the Supabase project and both of its keys, R2 and the database. */
const RESET_ENV: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: SUPABASE_PROJECT_URL,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
  R2_ACCOUNT_ID: 'r2-account',
  R2_ACCESS_KEY_ID: 'r2-access-key',
  R2_SECRET_ACCESS_KEY: 'r2-secret',
  R2_BUCKET_NAME: 'sandbox-media',
  POSTGRES_URL: 'postgres://sandbox-db',
};

function request(authorization?: string) {
  return new NextRequest(ROUTE_URL, { headers: authorization === undefined ? {} : { authorization } });
}

/** GoTrue's answer to `GET /auth/v1/settings`; sign-ups are off unless a test says otherwise. */
let gotrueSettings: (init: RequestInit | undefined) => Promise<Response>;

/** The network: GoTrue's settings, and the seed assets the reset fetches from the deployment. */
const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.includes('/auth/v1/')) return gotrueSettings(init);
  return new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]), { status: 200 });
});

function gotrueCalls() {
  return fetchMock.mock.calls.filter(([input]) => String(input).includes('/auth/v1/'));
}

/** Everything a console method printed, as one string. */
function printed(method: 'log' | 'warn' | 'error'): string {
  return vi
    .mocked(console[method])
    .mock.calls.map((args) => args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '))
    .join('\n');
}

/**
 * A Postgres client that finds nothing, except the media rows ensureCoreMediaRecords upserts. Each
 * tagged statement is a call of the client (its order is checkable), with its values kept beside it.
 */
function fakeDatabase() {
  const statements: string[] = [];
  const parameters: unknown[][] = [];
  const query = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('$').replace(/\s+/g, ' ').trim();
    statements.push(text);
    parameters.push(values);
    return text.startsWith('INSERT INTO public.media ') ? [{ id: `media-${statements.length}` }] : [];
  });
  const sql = Object.assign(query, {
    unsafe: vi.fn(async () => []),
    json: (value: unknown) => value,
    end: vi.fn(async () => undefined),
  });
  return { sql, statements, parameters };
}

/** The values of the ADMIN profile upsert (the demo admin's id), or undefined when none ran. */
function profileValues(db: ReturnType<typeof fakeDatabase>): unknown[] | undefined {
  const index = db.statements.findIndex((text) => text.startsWith('INSERT INTO public.profiles '));
  return index === -1 ? undefined : db.parameters[index];
}

/** A configured sandbox whose reset succeeds against the fakes. */
function configureReset(env: Record<string, string> = {}) {
  // From a blank environment, so a loop's previous configuration never leaks into the next.
  for (const name of ROUTE_ENV) vi.stubEnv(name, '');
  for (const [name, value] of Object.entries({ ...RESET_ENV, ...env })) vi.stubEnv(name, value);
  const db = fakeDatabase();
  mocks.postgres.mockReturnValue(db.sql);
  mocks.s3.mockImplementation(function S3Client() {
    return { send: vi.fn(async () => ({ Contents: [] })) };
  });
  // restoreDemoAdmin(): the demo admin exists, gets its published password back and keeps no
  // second factor.
  const authAdmin = {
    listUsers: vi.fn(
      async (): Promise<{ data: { users: Array<{ id: string; email: string }> } | null; error: Error | null }> => ({
        data: { users: [{ id: 'demo-admin', email: 'demo@nextblock.dev' }] },
        error: null,
      })
    ),
    updateUserById: vi.fn(async () => ({ data: {}, error: null })),
    createUser: vi.fn(),
    mfa: {
      listFactors: vi.fn(async (): Promise<{ data: { factors: Array<{ id: string }> } | null; error: Error | null }> => ({
        data: { factors: [] },
        error: null,
      })),
      deleteFactor: vi.fn(async (): Promise<{ data: object | null; error: Error | null }> => ({ data: {}, error: null })),
    },
  };
  mocks.createClient.mockReturnValue({ auth: { admin: authAdmin } });
  return Object.assign(db, { authAdmin });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
  vi.stubEnv('CRON_SECRET', 'reset-cron-secret');
  // No storage credentials: an authorized request ends at the environment check, before any reset work.
  for (const name of ROUTE_ENV) vi.stubEnv(name, '');
  gotrueSettings = async () => Response.json({ disable_signup: true, external: { email: true } });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sandbox reset cron guards', () => {
  it('is not found anywhere but the sandbox, even with the right bearer', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
    expect((await GET(request('Bearer reset-cron-secret'))).status).toBe(404);
  });

  it('resets, restores and checks nothing anywhere but the sandbox, however configured', async () => {
    // Only the exact string 'true' is the sandbox. A configured reset with every alarm armed (a
    // foreign upload backend, or a foreign bucket and endpoint; open sign-ups; a demo admin with a
    // factor) still ends at the 404.
    const foreignUploads: Array<Record<string, string>> = [
      { STORAGE_PROVIDER: 'supabase' },
      { STORAGE_BUCKET: 'other', R2_S3_PUBLIC_ENDPOINT: 'http://localhost:9000' },
    ];
    const runs = ['', 'false', 'TRUE', '1'].flatMap((flag) => foreignUploads.map((uploads) => [flag, uploads] as const));
    for (const [flag, uploads] of runs) {
      const { authAdmin, sql } = configureReset({ FREEMIUS_ECOMMERCE_SANDBOX_KEY: 'ecommerce-sandbox-key', ...uploads });
      authAdmin.mfa.listFactors.mockResolvedValue({ data: { factors: [{ id: 'totp-1' }] }, error: null });
      gotrueSettings = async () => Response.json({ disable_signup: false });
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', flag);

      const response = await GET(request('Bearer reset-cron-secret'));

      expect(response.status).toBe(404);
      expect(await response.text()).toBe('Not Found');
      for (const sideEffect of [mocks.s3, mocks.postgres, mocks.createClient, mocks.activateSandboxPackage, mocks.syncFreemiusProductsToSupabase, fetchMock]) {
        expect(sideEffect).not.toHaveBeenCalled();
      }
      expect(sql.unsafe).not.toHaveBeenCalled();
      expect(authAdmin.listUsers).not.toHaveBeenCalled();
      expect(authAdmin.updateUserById).not.toHaveBeenCalled();
      expect(authAdmin.mfa.deleteFactor).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalled();
    }
  });

  it('fails closed while CRON_SECRET is unset or blank, whatever the bearer', async () => {
    for (const secret of ['', '   ']) {
      vi.stubEnv('CRON_SECRET', secret);
      for (const header of [undefined, 'Bearer undefined', 'Bearer ', 'Bearer', 'Bearer null']) {
        expect((await GET(request(header))).status).toBe(401);
      }
    }
  });

  it('refuses a missing or wrong bearer', async () => {
    for (const header of [undefined, 'Bearer wrong', 'Bearer reset-cron-secre', 'Bearer reset-cron-secret!', 'reset-cron-secret']) {
      expect((await GET(request(header))).status).toBe(401);
    }
    expect(mocks.s3).not.toHaveBeenCalled();
    expect(mocks.postgres).not.toHaveBeenCalled();
  });

  it('lets the right bearer past the guard, compared in constant time', async () => {
    const response = await GET(request('Bearer reset-cron-secret'));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Missing environment variables' });
    expect(mocks.timingSafeEqual).toHaveBeenCalled();
    expect(mocks.s3).not.toHaveBeenCalled();
  });

  it('keeps a short secret working (no minimum length)', async () => {
    vi.stubEnv('CRON_SECRET', 'abc');
    expect((await GET(request('Bearer abc'))).status).toBe(500);
    expect((await GET(request('Bearer abd'))).status).toBe(401);
  });

  it('asks GoTrue nothing for a refused or unconfigured request', async () => {
    configureReset({ R2_BUCKET_NAME: '' });
    expect((await GET(request('Bearer reset-cron-secret'))).status).toBe(500);
    vi.stubEnv('CRON_SECRET', '');
    expect((await GET(request('Bearer reset-cron-secret'))).status).toBe(401);
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
    expect((await GET(request('Bearer reset-cron-secret'))).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('sandbox reset: the GoTrue public sign-up alarm', () => {
  it('stays quiet while GoTrue refuses public sign-ups', async () => {
    configureReset();

    const response = await GET(request('Bearer reset-cron-secret'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(SUCCESS);
    expect(gotrueCalls()).toHaveLength(1);
    expect(console.error).not.toHaveBeenCalled();
    expect(printed('warn')).not.toContain('GoTrue');
  });

  it('logs an error and returns a warning while GoTrue accepts public sign-ups, and still resets', async () => {
    // Sign-ups on, or a settings answer that does not say they are off.
    for (const settings of [{ disable_signup: false }, { external: { email: true } }, { disable_signup: 'true' }]) {
      vi.mocked(console.error).mockClear();
      const db = configureReset();
      gotrueSettings = async () => Response.json(settings);

      const response = await GET(request('Bearer reset-cron-secret'));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ...SUCCESS, warnings: [SIGNUPS_WARNING] });
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledWith(`[Sandbox Reset] ${SIGNUPS_WARNING}`);
      expect(db.sql.unsafe).toHaveBeenCalledTimes(1);
      expect(db.sql.end).toHaveBeenCalledTimes(1);
    }
  });

  it('carries the warning on a failed reset too', async () => {
    const db = configureReset();
    db.sql.unsafe.mockRejectedValueOnce(new Error('relation "public.pages" does not exist'));
    gotrueSettings = async () => Response.json({ disable_signup: false });

    const response = await GET(request('Bearer reset-cron-secret'));

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: 'relation "public.pages" does not exist',
      warnings: [SIGNUPS_WARNING],
    });
  });

  it('warns and resets anyway when the check cannot run', async () => {
    const unreachable = Object.assign(new Error('getaddrinfo ENOTFOUND sandbox-project.supabase.co'), { code: 'ENOTFOUND' });
    // How each failure reads in the warning.
    const failures: Array<[() => Promise<Response>, unknown]> = [
      [
        async () => {
          throw new TypeError('fetch failed', { cause: unreachable });
        },
        'fetch failed (ENOTFOUND)',
      ],
      [
        async () => {
          throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        },
        'The operation was aborted due to timeout',
      ],
      [async () => new Response('{"message":"Invalid API key"}', { status: 401 }), 'GoTrue answered 401.'],
      [async () => new Response('<html>Bad gateway</html>', { status: 200 }), expect.stringContaining('JSON')],
    ];
    for (const [failure, reason] of failures) {
      vi.mocked(console.warn).mockClear();
      vi.mocked(console.error).mockClear();
      const db = configureReset();
      gotrueSettings = failure;

      const response = await GET(request('Bearer reset-cron-secret'));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(SUCCESS);
      expect(console.warn).toHaveBeenCalledWith(COULD_NOT_CHECK, reason);
      expect(console.error).not.toHaveBeenCalled();
      expect(db.sql.end).toHaveBeenCalledTimes(1);
    }
  });

  it('warns without a publishable key, and never asks GoTrue', async () => {
    configureReset({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: '' });

    const response = await GET(request('Bearer reset-cron-secret'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(SUCCESS);
    expect(gotrueCalls()).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(COULD_NOT_CHECK, 'no publishable key is configured.');
  });

  it('asks the configured project for /auth/v1/settings with the publishable key, within 5 s', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    // The project URL as an installer might paste it; the request names the sandbox's own host.
    configureReset({ NEXT_PUBLIC_SUPABASE_URL: `${SUPABASE_PROJECT_URL}/` });
    gotrueSettings = async () => Response.json({ disable_signup: false });

    const response = await GET(request('Bearer reset-cron-secret'));

    expect(response.status).toBe(200);
    expect(gotrueCalls()).toHaveLength(1);
    const [url, init] = gotrueCalls()[0] as [string, RequestInit];
    // The environment's project, never the request's host.
    expect(url).toBe(`${SUPABASE_PROJECT_URL}/auth/v1/settings`);
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.headers).toEqual({ apikey: PUBLISHABLE_KEY });
    // The key goes nowhere else: a redirect fails the check.
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(timeout).toHaveBeenCalledWith(5000);
    // Neither key reaches the logs; the service-role key never leaves for GoTrue.
    expect(JSON.stringify(init)).not.toContain(SERVICE_ROLE_KEY);
    for (const method of ['log', 'warn', 'error'] as const) {
      expect(printed(method)).not.toContain(PUBLISHABLE_KEY);
      expect(printed(method)).not.toContain(SERVICE_ROLE_KEY);
    }
  });

  it('resolves the project URL and the publishable key through their aliases', async () => {
    configureReset({
      NEXT_PUBLIC_SUPABASE_URL: '',
      SUPABASE_URL: 'https://hosted-project.supabase.co',
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: '',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_hosted',
    });

    expect((await GET(request('Bearer reset-cron-secret'))).status).toBe(200);

    const [url, init] = gotrueCalls()[0] as [string, RequestInit];
    expect(url).toBe('https://hosted-project.supabase.co/auth/v1/settings');
    expect(init.headers).toEqual({ apikey: 'sb_publishable_hosted' });
  });

  it('runs alongside the reset, which waits for it no longer than its timeout', async () => {
    // A GoTrue that never answers: only the timeout ends the request. The test fires it when the
    // reset closes the database, so every reset step before ran while the check was pending.
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    gotrueSettings = (init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const db = configureReset();
    db.sql.end.mockImplementation(async () => {
      timeout.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    });

    const response = await GET(request('Bearer reset-cron-secret'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(SUCCESS);
    expect(db.sql.unsafe).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(COULD_NOT_CHECK, expect.stringContaining('timeout'));
  });
});

describe('sandbox reset: the demo partners', () => {
  it('seeds them after the store data and evicts both cached storefronts', async () => {
    const db = configureReset({ FREEMIUS_AFFILIATES_SANDBOX_KEY: 'affiliates-sandbox-key' });

    const response = await GET(request('Bearer reset-cron-secret'));

    expect(response.status).toBe(200);
    expect(mocks.activateSandboxPackage).toHaveBeenCalledWith(
      db.sql,
      AFFILIATES_PACKAGE_ID,
      'affiliates-sandbox-key',
      'https://sandbox.example.org',
    );
    expect(mocks.seedSandboxAffiliateDemo).toHaveBeenCalledWith(db.sql, expect.anything(), {
      siteUrl: 'https://sandbox.example.org',
    });
    // Studio Nova's and Atelier Boréal's /partners/<handle> pages, after the seed rewrote them.
    expect(mocks.evictAffiliateStorefrontCache).toHaveBeenCalledTimes(1);
    expect(mocks.evictAffiliateStorefrontCache).toHaveBeenCalledWith(['studio-nova', 'atelier-boreal'], 'route');
    expect(mocks.evictAffiliateTiersCache).toHaveBeenCalledWith('route');
    expect(mocks.seedSandboxAffiliateDemo.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.evictAffiliateStorefrontCache.mock.invocationCallOrder[0] as number,
    );
  });

  it('leaves the affiliate caches alone without the Affiliates sandbox key', async () => {
    configureReset();

    expect((await GET(request('Bearer reset-cron-secret'))).status).toBe(200);

    expect(mocks.seedSandboxAffiliateDemo).not.toHaveBeenCalled();
    expect(mocks.evictAffiliateStorefrontCache).not.toHaveBeenCalled();
  });
});

describe("sandbox reset: the demo admin's second factors", () => {
  it('removes every factor enrolled on the shared demo admin, which the SQL reset cannot reach', async () => {
    const { authAdmin } = configureReset();
    authAdmin.mfa.listFactors.mockResolvedValueOnce({ data: { factors: [{ id: 'totp-1' }, { id: 'totp-2' }] }, error: null });

    const response = await GET(request('Bearer reset-cron-secret'));

    expect(response.status).toBe(200);
    expect(authAdmin.mfa.listFactors).toHaveBeenCalledWith({ userId: 'demo-admin' });
    expect(authAdmin.mfa.deleteFactor.mock.calls).toEqual([[{ id: 'totp-1', userId: 'demo-admin' }], [{ id: 'totp-2', userId: 'demo-admin' }]]);
    expect(printed('log')).toContain('Removed 2 second factor(s) from the demo user.');
  });

  it('touches nothing when the demo admin has no factor', async () => {
    const { authAdmin } = configureReset();

    expect((await GET(request('Bearer reset-cron-secret'))).status).toBe(200);
    expect(authAdmin.mfa.listFactors).toHaveBeenCalledWith({ userId: 'demo-admin' });
    expect(authAdmin.mfa.deleteFactor).not.toHaveBeenCalled();
  });

  it('logs a failed listing or removal and still resets', async () => {
    const listing = configureReset();
    listing.authAdmin.mfa.listFactors.mockResolvedValueOnce({ data: null, error: new Error('mfa api down') });
    expect((await GET(request('Bearer reset-cron-secret'))).status).toBe(200);
    expect(listing.authAdmin.mfa.deleteFactor).not.toHaveBeenCalled();
    expect(printed('error')).toContain('Could not list the demo user second factors: mfa api down');

    const removal = configureReset();
    removal.authAdmin.mfa.listFactors.mockResolvedValueOnce({ data: { factors: [{ id: 'totp-1' }] }, error: null });
    removal.authAdmin.mfa.deleteFactor.mockResolvedValueOnce({ data: null, error: new Error('factor locked') });
    expect((await GET(request('Bearer reset-cron-secret'))).status).toBe(200);
    expect(printed('error')).toContain('Could not remove a second factor from the demo user: factor locked');
  });

  it('logs a thrown error and still seeds the store data', async () => {
    const { authAdmin, statements } = configureReset();
    authAdmin.mfa.listFactors.mockRejectedValueOnce(new Error('fetch failed'));

    expect((await GET(request('Bearer reset-cron-secret'))).status).toBe(200);
    expect(printed('error')).toContain('Could not remove the demo user second factors: fetch failed');
    expect(printed('error')).not.toContain('Failed to seed store data');
    expect(statements.some((text) => text.includes('invoice'))).toBe(true);
  });
});

describe('sandbox reset: the demo admin is restored first', () => {
  const PUBLISHED_PASSWORD = { password: 'password', email_confirm: true };

  it('restores the password and removes the factors even when the Freemius sync fails the reset', async () => {
    const { authAdmin, sql } = configureReset({ FREEMIUS_ECOMMERCE_SANDBOX_KEY: 'ecommerce-sandbox-key' });
    authAdmin.mfa.listFactors.mockResolvedValueOnce({ data: { factors: [{ id: 'totp-visitor' }] }, error: null });
    mocks.syncFreemiusProductsToSupabase.mockRejectedValueOnce(new Error('Freemius answered 503.'));

    const response = await GET(request('Bearer reset-cron-secret'));

    // The sync failure still fails the reset (rethrown, 500)...
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: 'Freemius answered 503.' });
    expect(mocks.activateSandboxPackage).toHaveBeenCalledWith(sql, 'ecommerce', 'ecommerce-sandbox-key', 'https://sandbox.example.org');
    expect(mocks.syncFreemiusProductsToSupabase).toHaveBeenCalledTimes(1);
    // ...but a visitor's password and second factor are already gone.
    expect(authAdmin.updateUserById.mock.calls).toEqual([['demo-admin', PUBLISHED_PASSWORD]]);
    expect(authAdmin.mfa.deleteFactor.mock.calls).toEqual([[{ id: 'totp-visitor', userId: 'demo-admin' }]]);
    expect(authAdmin.mfa.deleteFactor.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.syncFreemiusProductsToSupabase.mock.invocationCallOrder[0] as number
    );
    expect(sql.end).toHaveBeenCalledTimes(1);
  });

  it('restores it right after the reset SQL, before every later step, and only once', async () => {
    const db = configureReset();
    const { authAdmin, sql } = db;
    authAdmin.mfa.listFactors.mockResolvedValueOnce({ data: { factors: [{ id: 'totp-1' }] }, error: null });

    expect((await GET(request('Bearer reset-cron-secret'))).status).toBe(200);

    const resetSql = sql.unsafe.mock.invocationCallOrder[0] as number;
    // The first statement after the SQL is removeSandboxPromoSections' DELETE.
    expect(db.statements[0]).toMatch(/^DELETE FROM public\.blocks WHERE block_type = 'section'/);
    const firstLaterStatement = sql.mock.invocationCallOrder[0] as number;
    for (const restoreStep of [authAdmin.listUsers, authAdmin.updateUserById, authAdmin.mfa.listFactors, authAdmin.mfa.deleteFactor]) {
      expect(restoreStep.mock.invocationCallOrder[0]).toBeGreaterThan(resetSql);
      expect(restoreStep.mock.invocationCallOrder[0]).toBeLessThan(firstLaterStatement);
    }
    // The store data takes the restored id: the account is listed and restored once.
    expect(authAdmin.listUsers).toHaveBeenCalledTimes(1);
    expect(authAdmin.updateUserById).toHaveBeenCalledTimes(1);
    expect(authAdmin.mfa.listFactors).toHaveBeenCalledTimes(1);
    expect(profileValues(db)).toEqual(['demo-admin']);
  });

  it('restores it even when the first step after the SQL throws', async () => {
    const { authAdmin, sql } = configureReset();
    authAdmin.mfa.listFactors.mockResolvedValueOnce({ data: { factors: [{ id: 'totp-1' }] }, error: null });
    sql.mockRejectedValueOnce(new Error('relation "public.blocks" does not exist'));

    const response = await GET(request('Bearer reset-cron-secret'));

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: 'relation "public.blocks" does not exist' });
    expect(authAdmin.updateUserById.mock.calls).toEqual([['demo-admin', PUBLISHED_PASSWORD]]);
    expect(authAdmin.mfa.deleteFactor.mock.calls).toEqual([[{ id: 'totp-1', userId: 'demo-admin' }]]);
  });

  it('re-creates a missing demo admin first too, with the published password, and seeds it', async () => {
    const db = configureReset();
    db.authAdmin.listUsers.mockResolvedValueOnce({ data: { users: [] }, error: null });
    db.authAdmin.createUser.mockResolvedValueOnce({ data: { user: { id: 'new-demo-admin' } }, error: null });

    expect((await GET(request('Bearer reset-cron-secret'))).status).toBe(200);

    expect(db.authAdmin.createUser.mock.calls).toEqual([
      [{ email: 'demo@nextblock.dev', password: 'password', email_confirm: true, user_metadata: { full_name: 'Nextblock CMS' } }],
    ]);
    expect(db.authAdmin.createUser.mock.invocationCallOrder[0]).toBeGreaterThan(db.sql.unsafe.mock.invocationCallOrder[0] as number);
    expect(db.authAdmin.createUser.mock.invocationCallOrder[0]).toBeLessThan(db.sql.mock.invocationCallOrder[0] as number);
    expect(db.authAdmin.updateUserById).not.toHaveBeenCalled();
    expect(db.authAdmin.listUsers).toHaveBeenCalledTimes(1);
    expect(profileValues(db)).toEqual(['new-demo-admin']);
  });

  it('logs a failed restore, goes on, and the store data looks the account up again without restoring it twice', async () => {
    const db = configureReset();
    db.authAdmin.listUsers.mockRejectedValueOnce(new Error('fetch failed'));

    expect((await GET(request('Bearer reset-cron-secret'))).status).toBe(200);

    expect(printed('error')).toContain('Failed to restore the demo admin: fetch failed');
    expect(db.authAdmin.listUsers).toHaveBeenCalledTimes(2);
    expect(db.authAdmin.updateUserById).not.toHaveBeenCalled();
    expect(db.authAdmin.createUser).not.toHaveBeenCalled();
    expect(db.authAdmin.mfa.listFactors).not.toHaveBeenCalled();
    expect(profileValues(db)).toEqual(['demo-admin']);
    expect(printed('error')).not.toContain('Failed to seed store data');
  });

  it('skips the store data, logged, when the account cannot be found again either', async () => {
    const db = configureReset();
    db.authAdmin.listUsers.mockResolvedValue({ data: null, error: new Error('auth unavailable') });

    const response = await GET(request('Bearer reset-cron-secret'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(SUCCESS);
    expect(printed('error')).toContain('Failed to restore the demo admin: auth unavailable');
    expect(printed('error')).toContain('Failed to seed store data: auth unavailable');
    expect(profileValues(db)).toBeUndefined();
  });
});

describe('sandbox reset: the upload target alarm', () => {
  const uploadsWarning = (target: string) =>
    `Uploads go to ${target}, not the bucket this reset empties (sandbox-media): visitor uploads would outlive the reset.`;

  it('logs an error and returns a warning when uploads go to another backend or bucket, and still resets', async () => {
    const targets: Array<[Record<string, string>, string]> = [
      [{ STORAGE_PROVIDER: 'supabase' }, 'supabase:sandbox-media'],
      [{ STORAGE_BUCKET: 'other' }, 's3:other'],
    ];
    for (const [env, target] of targets) {
      vi.mocked(console.error).mockClear();
      const db = configureReset(env);

      const response = await GET(request('Bearer reset-cron-secret'));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ...SUCCESS, warnings: [uploadsWarning(target)] });
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledWith(`[Sandbox Reset] ${uploadsWarning(target)}`);
      // The reset itself is unchanged: its own R2 client empties R2_BUCKET_NAME, then the SQL runs.
      expect(mocks.s3).toHaveBeenLastCalledWith(expect.objectContaining({ endpoint: 'https://r2-account.r2.cloudflarestorage.com' }));
      expect(ListObjectsV2Command).toHaveBeenLastCalledWith({ Bucket: 'sandbox-media', ContinuationToken: undefined });
      expect(db.sql.unsafe).toHaveBeenCalledTimes(1);
      expect(db.sql.end).toHaveBeenCalledTimes(1);
    }
  });

  it('stays quiet while uploads go to the bucket this reset empties', async () => {
    const matching: Array<Record<string, string>> = [
      {},
      { STORAGE_PROVIDER: 's3' },
      { STORAGE_PROVIDER: ' R2 ' },
      { STORAGE_PROVIDER: 'minio', STORAGE_BUCKET: 'sandbox-media' },
    ];
    for (const env of matching) {
      vi.mocked(console.error).mockClear();
      configureReset(env);

      const response = await GET(request('Bearer reset-cron-secret'));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(SUCCESS);
      expect(console.error).not.toHaveBeenCalled();
    }
  });

  it('joins the sign-up warning, on a failed reset too', async () => {
    const db = configureReset({ STORAGE_PROVIDER: 'supabase' });
    db.sql.unsafe.mockRejectedValueOnce(new Error('relation "public.pages" does not exist'));
    gotrueSettings = async () => Response.json({ disable_signup: false });

    const response = await GET(request('Bearer reset-cron-secret'));

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: 'relation "public.pages" does not exist',
      warnings: [SIGNUPS_WARNING, uploadsWarning('supabase:sandbox-media')],
    });
  });

  it('checks nothing before the environment check passes', async () => {
    // A foreign backend, then a foreign endpoint on the S3 backend.
    const foreign: Array<Record<string, string>> = [{ STORAGE_PROVIDER: 'supabase' }, { R2_S3_ENDPOINT: 'http://localhost:9000' }];
    for (const env of foreign) {
      configureReset({ ...env, R2_BUCKET_NAME: '' });

      const response = await GET(request('Bearer reset-cron-secret'));

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Missing environment variables' });
      expect(console.error).not.toHaveBeenCalled();
    }
  });
});

describe('sandbox reset: the upload endpoint alarm', () => {
  /** The endpoint the reset's own client empties, for the test's R2_ACCOUNT_ID. */
  const RESET_ENDPOINT = 'https://r2-account.r2.cloudflarestorage.com';
  const endpointWarning = (origin: string, name: string) =>
    `Uploads go to ${origin} (${name}), not the endpoint this reset empties (${RESET_ENDPOINT}): visitor uploads would outlive the reset.`;
  const bucketWarning = (target: string) =>
    `Uploads go to ${target}, not the bucket this reset empties (sandbox-media): visitor uploads would outlive the reset.`;
  const EU_ENDPOINT = 'https://r2-account.eu.r2.cloudflarestorage.com';
  const MINIO_ENDPOINT = 'http://localhost:9000';

  it('logs an error and returns a warning for each endpoint uploads sign against that it does not empty, and still resets', async () => {
    const cases: Array<[Record<string, string>, string[]]> = [
      // Server uploads on the account's EU-jurisdiction endpoint: another bucket of the same name.
      [{ R2_S3_ENDPOINT: EU_ENDPOINT }, [endpointWarning(EU_ENDPOINT, 'R2_S3_ENDPOINT')]],
      // Presigned (browser) uploads on a MinIO host.
      [{ R2_S3_PUBLIC_ENDPOINT: MINIO_ENDPOINT }, [endpointWarning(MINIO_ENDPOINT, 'R2_S3_PUBLIC_ENDPOINT')]],
      [
        { R2_S3_ENDPOINT: EU_ENDPOINT, R2_S3_PUBLIC_ENDPOINT: MINIO_ENDPOINT },
        [endpointWarning(EU_ENDPOINT, 'R2_S3_ENDPOINT'), endpointWarning(MINIO_ENDPOINT, 'R2_S3_PUBLIC_ENDPOINT')],
      ],
      // Another bucket on another endpoint: both are named.
      [
        { STORAGE_BUCKET: 'other', R2_S3_ENDPOINT: `${EU_ENDPOINT}/other` },
        [bucketWarning('s3:other'), endpointWarning(EU_ENDPOINT, 'R2_S3_ENDPOINT')],
      ],
    ];
    for (const [env, warnings] of cases) {
      vi.mocked(console.error).mockClear();
      const db = configureReset(env);

      const response = await GET(request('Bearer reset-cron-secret'));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ...SUCCESS, warnings });
      expect(console.error).toHaveBeenCalledTimes(warnings.length);
      for (const warning of warnings) {
        expect(console.error).toHaveBeenCalledWith(`[Sandbox Reset] ${warning}`);
      }
      // The reset never follows R2_S3_ENDPOINT: its own client empties the account's endpoint.
      expect(mocks.s3).toHaveBeenCalledTimes(1);
      expect(mocks.s3).toHaveBeenLastCalledWith(expect.objectContaining({ endpoint: RESET_ENDPOINT }));
      expect(ListObjectsV2Command).toHaveBeenLastCalledWith({ Bucket: 'sandbox-media', ContinuationToken: undefined });
      expect(db.sql.unsafe).toHaveBeenCalledTimes(1);
      expect(db.sql.end).toHaveBeenCalledTimes(1);
      mocks.s3.mockClear();
    }
  });

  it('stays quiet while each endpoint has the origin of the one it empties', async () => {
    // Letter case, a trailing slash, a /<bucket> path or the default port: the same endpoint.
    const matching: Array<Record<string, string>> = [
      { R2_S3_ENDPOINT: 'https://R2-account.r2.cloudflarestorage.com/' },
      { R2_S3_PUBLIC_ENDPOINT: 'https://R2-account.r2.cloudflarestorage.com/' },
      {
        R2_S3_ENDPOINT: `${RESET_ENDPOINT}/sandbox-media`,
        R2_S3_PUBLIC_ENDPOINT: 'https://r2-account.r2.cloudflarestorage.com:443',
      },
    ];
    for (const env of matching) {
      vi.mocked(console.error).mockClear();
      configureReset(env);

      const response = await GET(request('Bearer reset-cron-secret'));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(SUCCESS);
      expect(console.error).not.toHaveBeenCalled();
    }
  });

  it('warns, without echoing it, about an endpoint that is not a URL with an origin, and still resets', async () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ R2_S3_ENDPOINT: '::not-a-url::' }, 'R2_S3_ENDPOINT'],
      [{ R2_S3_PUBLIC_ENDPOINT: 'minio:9000' }, 'R2_S3_PUBLIC_ENDPOINT'],
    ];
    for (const [env, name] of cases) {
      vi.mocked(console.error).mockClear();
      configureReset(env);
      const warning = `${name} is not a valid endpoint URL, so uploads cannot reach the endpoint this reset empties (${RESET_ENDPOINT}).`;

      const response = await GET(request('Bearer reset-cron-secret'));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ ...SUCCESS, warnings: [warning] });
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledWith(`[Sandbox Reset] ${warning}`);
      const raw = Object.values(env)[0] as string;
      expect(JSON.stringify(body)).not.toContain(raw);
      expect(printed('error')).not.toContain(raw);
    }
  });

  it('names no endpoint when uploads do not go to S3 at all', async () => {
    configureReset({ STORAGE_PROVIDER: 'supabase', R2_S3_ENDPOINT: EU_ENDPOINT, R2_S3_PUBLIC_ENDPOINT: MINIO_ENDPOINT });

    const response = await GET(request('Bearer reset-cron-secret'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...SUCCESS, warnings: [bucketWarning('supabase:sandbox-media')] });
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});
