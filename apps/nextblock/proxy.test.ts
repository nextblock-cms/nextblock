import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// proxy.ts is Next's middleware module: it can only export `proxy` and `config`. The role map is
// read from the source and resolved with the same longest-prefix rule getRequiredRolesForPath
// applies, which pins the contract this file guards: which /cms URLs a WRITER may open and which
// are ADMIN-only. The partner-referral wiring is driven end to end below with the Supabase
// clients, the redirect store and `after()` mocked.

type Role = 'ADMIN' | 'WRITER' | 'USER';

const PROXY_PATH = fileURLToPath(new URL('./proxy.ts', import.meta.url));
const PROXY_SOURCE = readFileSync(PROXY_PATH, 'utf8');

function loadCmsRoutePermissions(): Record<string, Role[]> {
  const block = PROXY_SOURCE.match(/const cmsRoutePermissions: Record<string, UserRole\[\]> = \{([\s\S]*?)\n\};/);
  if (!block) throw new Error('cmsRoutePermissions map not found in proxy.ts');

  const permissions: Record<string, Role[]> = {};
  for (const entry of block[1].matchAll(/'([^']+)':\s*\[([^\]]*)\]/g)) {
    permissions[entry[1]] = entry[2]
      .split(',')
      .map((role) => role.trim().replace(/^'|'$/g, ''))
      .filter(Boolean) as Role[];
  }
  return permissions;
}

// Mirror of getRequiredRolesForPath in proxy.ts (longest matching prefix, segment-aligned).
function getRequiredRolesForPath(permissions: Record<string, Role[]>, pathname: string): Role[] | null {
  const sortedPaths = Object.keys(permissions).sort((a, b) => b.length - a.length);
  for (const specificPath of sortedPaths) {
    if (pathname === specificPath || pathname.startsWith(specificPath + (specificPath === '/' ? '' : '/'))) {
      return permissions[specificPath];
    }
  }
  return null;
}

const permissions = loadCmsRoutePermissions();
const rolesFor = (pathname: string) => getRequiredRolesForPath(permissions, pathname);

describe('proxy.ts cmsRoutePermissions', () => {
  it('parses the map out of the source', () => {
    expect(Object.keys(permissions).length).toBeGreaterThanOrEqual(9);
    expect(permissions['/cms']).toEqual(['WRITER', 'ADMIN']);
    for (const [path, roles] of Object.entries(permissions)) {
      expect(path.startsWith('/cms')).toBe(true);
      expect(roles.length).toBeGreaterThan(0);
      expect(roles.every((role) => role === 'ADMIN' || role === 'WRITER')).toBe(true);
    }
  });

  it.each([
    '/cms',
    '/cms/dashboard',
    '/cms/pages',
    '/cms/pages/12/edit',
    '/cms/posts',
    '/cms/media',
    '/cms/custom-blocks',
    '/cms/messages',
    '/cms/products',
    '/cms/products/new',
    '/cms/products/categories',
    '/cms/products/attributes',
    '/cms/products/inventory',
    '/cms/orders',
    '/cms/settings/security',
    '/cms/settings/security/devices',
  ])('keeps %s open to WRITER (sidebar shows it to writers)', (pathname) => {
    expect(rolesFor(pathname)).toEqual(expect.arrayContaining(['WRITER', 'ADMIN']));
  });

  it.each([
    '/cms/admin',
    '/cms/users',
    '/cms/users/new',
    '/cms/users/abc/edit',
    '/cms/settings',
    '/cms/settings/packages',
    '/cms/settings/taxes',
    '/cms/settings/currencies',
    '/cms/settings/backup-restore',
    '/cms/settings/email',
    '/cms/settings/registration',
    '/cms/settings/cortex-ai',
    '/cms/navigation',
    '/cms/navigation/new',
    '/cms/payments',
    '/cms/shipping',
    '/cms/shipping/zones',
    '/cms/coupons',
    '/cms/coupons/42/edit',
    '/cms/promotions',
    '/cms/affiliates',
    '/cms/affiliates/tiers',
    '/cms/affiliates/approvals',
    '/cms/affiliates/payouts',
    '/cms/affiliates/settings',
    '/cms/affiliates/partners/abc',
  ])('requires ADMIN for %s (sidebar marks it adminOnly)', (pathname) => {
    expect(rolesFor(pathname)).toEqual(['ADMIN']);
  });

  it('matches whole path segments only, so a sibling route is not caught by a shorter prefix', () => {
    expect(rolesFor('/cms/paymentsx')).toEqual(['WRITER', 'ADMIN']);
    expect(rolesFor('/cms/settings-x')).toEqual(['WRITER', 'ADMIN']);
    expect(rolesFor('/cms/settings/securityx')).toEqual(['ADMIN']);
    expect(rolesFor('/cms/affiliatesx')).toEqual(['WRITER', 'ADMIN']);
  });

  it('leaves non-/cms paths to the rest of the middleware', () => {
    expect(rolesFor('/')).toBeNull();
    expect(rolesFor('/api/upload/proxy')).toBeNull();
    expect(rolesFor('/profile')).toBeNull();
    expect(rolesFor('/portal/retailer')).toBeNull();
    expect(rolesFor('/partners/jane')).toBeNull();
  });
});

describe('proxy.ts module shape', () => {
  const file = ts.createSourceFile(PROXY_PATH, PROXY_SOURCE, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  it('exports only proxy and config (Next rejects anything else in a proxy file)', () => {
    const exported: string[] = [];
    for (const statement of file.statements) {
      const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
      const isExported = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
      if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) exported.push(statement.getText(file));
      if (!isExported) continue;
      if (ts.isFunctionDeclaration(statement) && statement.name) exported.push(statement.name.text);
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) exported.push(declaration.name.getText(file));
      }
      if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isClassDeclaration(statement)) {
        exported.push(statement.name?.getText(file) ?? '(anonymous)');
      }
    }
    expect(exported.sort()).toEqual(['config', 'proxy']);
  });

  it('imports no server-only module, no service-role entry and no library barrel', () => {
    const imports = file.statements
      .filter(ts.isImportDeclaration)
      .map((statement) => ({
        spec: (statement.moduleSpecifier as ts.StringLiteral).text,
        typeOnly: Boolean(statement.importClause?.isTypeOnly),
      }));
    const runtime = imports.filter((entry) => !entry.typeOnly).map((entry) => entry.spec).sort();

    expect(runtime).toEqual(
      [
        '@nextblock-cms/utils/seo',
        '@supabase/ssr',
        '@supabase/supabase-js',
        './lib/affiliates/partners-paths',
        './lib/affiliates/referral-cookie',
        './lib/i18n/detection',
        './lib/seo/redirect-store',
        './lib/setup/env-status',
        'next/server',
      ].sort(),
    );
    // The generated Database type is the only thing taken from @nextblock-cms/db, as a type.
    expect(imports.filter((entry) => entry.spec === '@nextblock-cms/db')).toEqual([{ spec: '@nextblock-cms/db', typeOnly: true }]);
    expect(PROXY_SOURCE).not.toMatch(/['"]server-only['"]|@nextblock-cms\/db\/server|@nextblock-cms\/affiliates/);
  });
});

/* ------------------------------------------------------------------------------------------
 * Partner referral cookie, end to end through proxy()
 * ---------------------------------------------------------------------------------------- */

type RpcResult = { data: unknown; error: { code?: string; message: string } | null };

const mocks = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => unknown>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpc: (fn: string): Promise<RpcResult> =>
    Promise.resolve(fn === 'get_affiliate_referral_window' ? { data: 45, error: null } : { data: null, error: null }),
  redirects: [] as Array<{ id: string; sourcePath: string; destinationPath: string; statusCode: 301 | 302; isActive: boolean }>,
  user: null as { id: string } | null,
  profile: null as { role: string; full_name: string | null } | null,
  adminCreated: true,
  languages: [
    { code: 'en', is_default: true, is_active: true },
    { code: 'fr', is_default: false, is_active: true },
  ] as Array<{ code: string; is_default: boolean; is_active: boolean | null }>,
}));

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    after: (callback: () => unknown) => {
      mocks.afterCallbacks.push(callback);
    },
  };
});

vi.mock('@supabase/supabase-js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@supabase/supabase-js')>();
  return {
    ...actual,
    createClient: () => ({
      rpc: (fn: string, args: Record<string, unknown>) => {
        mocks.rpcCalls.push({ fn, args });
        const result = mocks.rpc(fn);
        const builder = {
          abortSignal: () => builder,
          then: (resolve: (value: RpcResult) => unknown, reject?: (reason: unknown) => unknown) => result.then(resolve, reject),
        };
        return builder;
      },
    }),
  };
});

vi.mock('./lib/seo/redirect-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/seo/redirect-store')>();
  return { ...actual, fetchActiveRedirects: async () => mocks.redirects };
});

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      getUser: async () => ({ data: { user: mocks.user }, error: null }),
    },
    from: (table: string) => {
      if (table === 'languages') {
        return {
          select: async () => ({ data: mocks.languages, error: null }),
        };
      }
      if (table === 'site_settings') {
        return {
          select: () => ({
            eq: (_column: string, key: string) => ({
              maybeSingle: async () =>
                key === 'is_admin_created' ? { data: { value: mocks.adminCreated }, error: null } : { data: null, error: null },
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: mocks.profile, error: mocks.profile ? null : { message: 'no profile' } }),
          }),
        }),
      };
    },
  }),
}));

const BROWSER = {
  'sec-fetch-dest': 'document',
  accept: 'text/html,application/xhtml+xml',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'x-forwarded-for': '203.0.113.7',
};

function visit(path: string, init: { headers?: Record<string, string>; method?: string; cookie?: string } = {}) {
  const headers: Record<string, string> = { ...BROWSER, ...init.headers };
  if (init.cookie) headers.cookie = init.cookie;
  return new NextRequest(new URL(path, 'https://shop.example'), { method: init.method ?? 'GET', headers });
}

async function runProxy(request: NextRequest) {
  const { proxy } = await import('./proxy');
  return proxy(request);
}

const windowLookups = () => mocks.rpcCalls.filter((call) => call.fn === 'get_affiliate_referral_window');
const clickCalls = () => mocks.rpcCalls.filter((call) => call.fn === 'record_affiliate_click');

async function flushAfter() {
  const callbacks = mocks.afterCallbacks.splice(0);
  for (const callback of callbacks) await callback();
}

describe('proxy() partner referral cookie', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.afterCallbacks.length = 0;
    mocks.rpcCalls.length = 0;
    mocks.rpc = (fn: string) =>
      Promise.resolve(fn === 'get_affiliate_referral_window' ? { data: 45, error: null } : { data: null, error: null });
    mocks.redirects = [];
    mocks.user = null;
    mocks.profile = null;
    mocks.adminCreated = true;
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://db.example.test');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('sets the cookie for the tier window, turns the page private and counts one click', async () => {
    const response = await runProxy(visit('/partners/jane'));

    const cookie = response.cookies.get('nb_affiliate_ref');
    expect(cookie).toMatchObject({ value: 'jane', httpOnly: true, sameSite: 'lax', path: '/', maxAge: 45 * 86_400 });
    expect(cookie?.secure).toBeFalsy();
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(windowLookups()).toEqual([{ fn: 'get_affiliate_referral_window', args: { p_handle: 'jane' } }]);

    // The click is recorded after the response, with a hashed visitor and no raw address.
    expect(clickCalls()).toEqual([]);
    expect(mocks.afterCallbacks).toHaveLength(1);
    await flushAfter();
    expect(clickCalls()).toHaveLength(1);
    expect(clickCalls()[0].args).toEqual({ p_handle: 'jane', p_visitor_hash: expect.stringMatching(/^[a-f0-9]{32}$/) });
    expect(JSON.stringify(clickCalls()[0].args)).not.toContain('203.0.113.7');
  });

  it('marks the cookie Secure in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const response = await runProxy(visit('/about?ref=jane'));
    expect(response.cookies.get('nb_affiliate_ref')).toMatchObject({ value: 'jane', secure: true });
  });

  it('refreshes the cookie of a returning visitor without counting another click', async () => {
    const response = await runProxy(visit('/partners/jane', { cookie: 'nb_affiliate_ref=jane' }));
    expect(response.cookies.get('nb_affiliate_ref')?.value).toBe('jane');
    expect(mocks.afterCallbacks).toHaveLength(0);
  });

  it('lets a new partner link replace an older referral (last click) and counts it', async () => {
    const response = await runProxy(visit('/shop?ref=bob', { cookie: 'nb_affiliate_ref=jane' }));
    expect(response.cookies.get('nb_affiliate_ref')?.value).toBe('bob');
    expect(mocks.afterCallbacks).toHaveLength(1);
  });

  it.each([
    ['a prefetch', visit('/partners/jane', { headers: { 'sec-purpose': 'prefetch' } })],
    ['a client-side (RSC) navigation', visit('/partners/jane', { headers: { 'sec-fetch-dest': 'empty', rsc: '1' } })],
    ['a crawler', visit('/partners/jane', { headers: { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' } })],
    ['a POST', visit('/partners/jane', { method: 'POST' })],
    ['an OG image', visit('/partners/jane/opengraph-image')],
    ['a reserved handle', visit('/?ref=admin')],
    ['a portal page', visit('/portal/retailer?ref=jane')],
    [
      'a visitor who declined marketing cookies',
      visit('/partners/jane', { cookie: `nb_consent_preference=${encodeURIComponent('{"necessary":true,"analytics":true,"marketing":false}')}` }),
    ],
  ])('sets nothing and asks nothing for %s', async (_label, request) => {
    const response = await runProxy(request);
    expect(response.cookies.get('nb_affiliate_ref')).toBeUndefined();
    expect(windowLookups()).toEqual([]);
    expect(mocks.afterCallbacks).toHaveLength(0);
  });

  it('leaves ordinary pages publicly cacheable', async () => {
    const response = await runProxy(visit('/about'));
    expect(response.cookies.get('nb_affiliate_ref')).toBeUndefined();
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(mocks.rpcCalls).toEqual([]);
  });

  it('sets no cookie for a handle without an active, approved partner', async () => {
    mocks.rpc = () => Promise.resolve({ data: null, error: null });
    const response = await runProxy(visit('/partners/ghost'));
    expect(response.cookies.get('nb_affiliate_ref')).toBeUndefined();
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(mocks.afterCallbacks).toHaveLength(0);
  });

  it('treats a missing Affiliates schema as "no program"', async () => {
    mocks.rpc = () =>
      Promise.resolve({
        data: null,
        error: { code: 'PGRST202', message: 'Could not find the function public.get_affiliate_referral_window(p_handle) in the schema cache' },
      });
    const response = await runProxy(visit('/blog?ref=producthunt'));
    expect(response.cookies.get('nb_affiliate_ref')).toBeUndefined();
  });

  it('falls back to 30 days when the lookup fails (fail open)', async () => {
    mocks.rpc = (fn: string) =>
      fn === 'get_affiliate_referral_window'
        ? Promise.resolve({ data: null, error: { code: '', message: 'FetchError: connect ECONNREFUSED' } })
        : Promise.resolve({ data: null, error: null });
    const response = await runProxy(visit('/partners/jane'));
    expect(response.cookies.get('nb_affiliate_ref')).toMatchObject({ value: 'jane', maxAge: 30 * 86_400 });
  });

  it('still serves the page when even the lookup throws', async () => {
    mocks.rpc = () => Promise.reject(new Error('socket hang up'));
    const response = await runProxy(visit('/partners/jane'));
    expect(response.status).toBe(200);
    expect(response.cookies.get('nb_affiliate_ref')?.maxAge).toBe(30 * 86_400);
  });

  it('asks the database once per handle while the window is cached', async () => {
    const { proxy } = await import('./proxy');
    await proxy(visit('/partners/jane'));
    await proxy(visit('/shop?ref=jane'));
    expect(windowLookups()).toHaveLength(1);
  });

  it('carries the referral on a managed 301 and makes that redirect private', async () => {
    mocks.redirects = [{ id: 'r1', sourcePath: '/old-picks', destinationPath: '/new-picks', statusCode: 301, isActive: true }];
    const response = await runProxy(visit('/old-picks?ref=jane'));
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://shop.example/new-picks?ref=jane');
    expect(response.cookies.get('nb_affiliate_ref')?.value).toBe('jane');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('keeps a plain managed 301 publicly cacheable', async () => {
    mocks.redirects = [{ id: 'r1', sourcePath: '/old-picks', destinationPath: '/new-picks', statusCode: 301, isActive: true }];
    const response = await runProxy(visit('/old-picks'));
    expect(response.status).toBe(301);
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(response.cookies.get('nb_affiliate_ref')).toBeUndefined();
  });

  it('carries the referral on the customer-name redirect to /profile', async () => {
    mocks.user = { id: 'user-1' };
    mocks.profile = { role: 'USER', full_name: null };
    const response = await runProxy(visit('/partners/jane'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://shop.example/profile');
    expect(response.cookies.get('nb_affiliate_ref')?.value).toBe('jane');
  });

  it('never decorates the first-boot setup gate', async () => {
    mocks.adminCreated = false;
    const response = await runProxy(visit('/partners/jane'));
    expect(response.headers.get('location')).toBe('https://shop.example/setup');
    expect(response.cookies.get('nb_affiliate_ref')).toBeUndefined();
    expect(mocks.afterCallbacks).toHaveLength(0);
  });

  it('expires the referral of a visitor who declined marketing cookies since', async () => {
    const declined = encodeURIComponent('{"necessary":true,"analytics":false,"marketing":false}');
    const response = await runProxy(visit('/about', { cookie: `nb_affiliate_ref=jane; nb_consent_preference=${declined}` }));
    expect(response.cookies.get('nb_affiliate_ref')).toMatchObject({ value: '', maxAge: 0, httpOnly: true, path: '/' });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.rpcCalls).toEqual([]);
    expect(mocks.afterCallbacks).toHaveLength(0);
  });

  it('keeps the security headers on a referral response', async () => {
    const response = await runProxy(visit('/partners/jane'));
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
  });
});

/* ------------------------------------------------------------------------------------------
 * Request headers the app renders with: the locale (pinned to French on /partenaires) and the
 * requested path and query (the partner portal's sign-in return address)
 * ---------------------------------------------------------------------------------------- */

/** A header proxy() forwarded to the app (`NextResponse.next({ request: { headers } })`). */
function forwarded(response: Response, name: string): string | null {
  return response.headers.get(`x-middleware-request-${name.toLowerCase()}`);
}

describe('proxy() forwarded request headers', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.afterCallbacks.length = 0;
    mocks.rpcCalls.length = 0;
    mocks.redirects = [];
    mocks.user = null;
    mocks.profile = null;
    mocks.adminCreated = true;
    mocks.languages = [
      { code: 'en', is_default: true, is_active: true },
      { code: 'fr', is_default: false, is_active: true },
    ];
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://db.example.test');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('renders /partenaires in French for an English visitor without touching their language cookie', async () => {
    const response = await runProxy(visit('/partenaires', { cookie: 'NEXT_USER_LOCALE=en' }));
    expect(response.status).toBe(200);
    expect(forwarded(response, 'X-User-Locale')).toBe('fr');
    expect(response.cookies.get('NEXT_USER_LOCALE')?.value).not.toBe('fr');
  });

  it('pins the active French code as the table stores it', async () => {
    mocks.languages = [
      { code: 'en', is_default: true, is_active: true },
      { code: 'fr-CA', is_default: false, is_active: true },
    ];
    const response = await runProxy(visit('/partenaires', { cookie: 'NEXT_USER_LOCALE=en' }));
    expect(forwarded(response, 'X-User-Locale')).toBe('fr-CA');
  });

  it('leaves /partenaires alone while French is not an active language', async () => {
    mocks.languages = [
      { code: 'en', is_default: true, is_active: true },
      { code: 'fr', is_default: false, is_active: false },
    ];
    const response = await runProxy(visit('/partenaires', { cookie: 'NEXT_USER_LOCALE=en' }));
    expect(forwarded(response, 'X-User-Locale')).toBe('en');
  });

  it('renders the French partner terms (/partenaires/conditions) in French too, without touching the cookie', async () => {
    const response = await runProxy(visit('/partenaires/conditions', { cookie: 'NEXT_USER_LOCALE=en' }));
    expect(response.status).toBe(200);
    expect(forwarded(response, 'X-User-Locale')).toBe('fr');
    expect(response.cookies.get('NEXT_USER_LOCALE')?.value).not.toBe('fr');
  });

  it("keeps /partners, /partners/terms (and every other page) in the visitor's language", async () => {
    expect(forwarded(await runProxy(visit('/partners', { cookie: 'NEXT_USER_LOCALE=en' })), 'X-User-Locale')).toBe('en');
    expect(forwarded(await runProxy(visit('/partners', { cookie: 'NEXT_USER_LOCALE=fr' })), 'X-User-Locale')).toBe('fr');
    expect(forwarded(await runProxy(visit('/partners/terms', { cookie: 'NEXT_USER_LOCALE=en' })), 'X-User-Locale')).toBe('en');
    expect(forwarded(await runProxy(visit('/partners/terms', { cookie: 'NEXT_USER_LOCALE=fr' })), 'X-User-Locale')).toBe('fr');
    expect(forwarded(await runProxy(visit('/partenairesx', { cookie: 'NEXT_USER_LOCALE=en' })), 'X-User-Locale')).toBe('en');
  });

  it('forwards the requested path and query string, overwriting anything the client sent', async () => {
    const response = await runProxy(
      visit('/portal/retailer/payouts?connected=1', {
        headers: { 'x-nextblock-path': '/cms/users', 'x-nextblock-search': '?evil=1' },
      }),
    );
    expect(forwarded(response, 'x-nextblock-path')).toBe('/portal/retailer/payouts');
    expect(forwarded(response, 'x-nextblock-search')).toBe('?connected=1');

    const bare = await runProxy(visit('/portal/retailer/storefront', { headers: { 'x-nextblock-search': '?evil=1' } }));
    expect(forwarded(bare, 'x-nextblock-search')).toBe('');
  });
});
