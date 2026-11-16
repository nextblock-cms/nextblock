import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The four staff AI routes (`/api/ai/generate-blocks`, `/api/ai/seo/metadata`, `/api/ai/seo/alt-text`,
 * `/api/ai/cortex/build-widget`) resolve the caller with the real getCmsActor() and
 * evaluateTwoFactor() over a faked cookie session, before the Cortex AI request quota (recorded
 * with the service role), the package check, the body or the model. Until 2026-11-14 each read the
 * role through the cookie client, so a staff password alone (the first factor) spent the quota and
 * the operator's model key: a route handler never passes the CMS layout's 2FA redirect.
 */

const mocks = vi.hoisted(() => ({
  /**
   * The cookie session getCmsActor() reads: the user, their own profile role, the second factor
   * they enrolled, the session's assurance level.
   */
  session: {
    user: { id: 'writer-1' } as { id: string } | null,
    role: 'WRITER' as string | null,
    mfa: null as { mfa_enabled: boolean; mfa_type: 'totp' | 'email' } | null,
    aal: 'aal1' as 'aal1' | 'aal2',
  },
  cookieReads: [] as string[],
  getServiceRoleSupabaseClient: vi.fn(),
  verifyPackageOnline: vi.fn(),
  enforceCortexAiRequestQuota: vi.fn(),
  generateEditorHtmlFragment: vi.fn(),
  generateCortexAiSeoMetadata: vi.fn(),
  generateCortexAiAltText: vi.fn(),
  generateCortexWidgetDefinition: vi.fn(),
  insertCortexWidgetDefinition: vi.fn(),
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

vi.mock('@nextblock-cms/db/server', () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: mocks.session.user }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({
          data: { currentLevel: mocks.session.aal, nextLevel: 'aal2' },
          error: null,
        }),
      },
    },
    from: (table: string) => ({
      select: () => ({
        eq: () => {
          const read = async () => {
            mocks.cookieReads.push(table);
            if (table === 'profiles') {
              return { data: mocks.session.role ? { role: mocks.session.role } : null, error: null };
            }
            if (table === 'user_security_settings') return { data: mocks.session.mfa, error: null };
            throw new Error(`Unexpected cookie-client read of ${table}`);
          };
          // `single` too: the pre-2026-11-14 routes read the role that way, so a return to it is
          // judged by the refusals below rather than by a missing method.
          return { maybeSingle: read, single: read };
        },
      }),
    }),
  }),
  getServiceRoleSupabaseClient: mocks.getServiceRoleSupabaseClient,
  verifyPackageOnline: mocks.verifyPackageOnline,
}));
// No trusted-device or email-code cookie: a second factor counts only through the session itself.
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));
// Read only by the trusted-device and reminder paths, never on the way to these decisions.
vi.mock('../../../lib/privacy/settings', () => ({
  getSecuritySettings: async () => ({ enforce_staff_2fa: false, trusted_device_days: 30 }),
}));
vi.mock('../../../lib/cortex-ai/request-quota', () => ({
  enforceCortexAiRequestQuota: mocks.enforceCortexAiRequestQuota,
}));
vi.mock('next/cache', () => ({
  revalidatePath: mocks.revalidatePath,
  revalidateTag: mocks.revalidateTag,
  // lib/custom-block-definitions wraps its reads at import; none runs here.
  unstable_cache: (fn: unknown) => fn,
}));
// The real request schemas and routing helpers; the model calls and the widget insert are stand-ins.
vi.mock('@nextblock-cms/cortex', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@nextblock-cms/cortex')),
  generateCortexAiAltText: mocks.generateCortexAiAltText,
  generateCortexAiSeoMetadata: mocks.generateCortexAiSeoMetadata,
  generateCortexWidgetDefinition: mocks.generateCortexWidgetDefinition,
  generateEditorHtmlFragment: mocks.generateEditorHtmlFragment,
  insertCortexWidgetDefinition: mocks.insertCortexWidgetDefinition,
}));

import { POST as buildWidget } from './cortex/build-widget/route';
import { POST as generateBlocks } from './generate-blocks/route';
import { POST as altText } from './seo/alt-text/route';
import { POST as seoMetadata } from './seo/metadata/route';

const SECOND_FACTOR = 'Complete two-factor verification, then try again.';

type RouteCase = {
  route: string;
  handler: (request: Request) => Promise<Response>;
  body: Record<string, unknown>;
  permission: string;
  model: () => ReturnType<typeof vi.fn>;
};

const ROUTES: RouteCase[] = [
  {
    route: 'ai/generate-blocks',
    handler: generateBlocks,
    body: { prompt: 'Write a short welcome paragraph.' },
    permission: 'You do not have permission to generate editor blocks.',
    model: () => mocks.generateEditorHtmlFragment,
  },
  {
    route: 'ai/seo/metadata',
    handler: seoMetadata,
    body: { content: 'A page about handmade ceramic mugs and how they are fired.' },
    permission: 'You do not have permission to generate SEO metadata.',
    model: () => mocks.generateCortexAiSeoMetadata,
  },
  {
    route: 'ai/seo/alt-text',
    handler: altText,
    body: { imageUrl: 'https://cdn.example.com/uploads/mug.png' },
    permission: 'You do not have permission to generate image alt text.',
    model: () => mocks.generateCortexAiAltText,
  },
  {
    route: 'ai/cortex/build-widget',
    handler: buildWidget,
    body: { prompt: 'A three-column pricing table.' },
    permission: 'You do not have permission to build Cortex widgets.',
    model: () => mocks.generateCortexWidgetDefinition,
  },
];

function request(route: string, body: Record<string, unknown>) {
  return new Request(`http://localhost/api/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function signIn(role: string | null, user: { id: string } | null = { id: 'writer-1' }) {
  mocks.session.user = user;
  mocks.session.role = role;
}

/** Nothing past the gate ran: no quota row, no package check, no service role, no model, no write. */
function expectNothingPastTheGate(route: RouteCase) {
  expect(mocks.enforceCortexAiRequestQuota).not.toHaveBeenCalled();
  expect(mocks.verifyPackageOnline).not.toHaveBeenCalled();
  expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
  expect(route.model()).not.toHaveBeenCalled();
  expect(mocks.insertCortexWidgetDefinition).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  signIn('WRITER');
  mocks.session.mfa = null;
  mocks.session.aal = 'aal1';
  mocks.cookieReads = [];
  mocks.enforceCortexAiRequestQuota.mockResolvedValue(null);
  mocks.verifyPackageOnline.mockResolvedValue(true);
  mocks.generateEditorHtmlFragment.mockResolvedValue({
    attempts: [],
    credentialSource: 'env',
    html: '<p>Welcome.</p>',
    modelId: 'openrouter/free',
  });
  mocks.generateCortexAiSeoMetadata.mockResolvedValue({
    credentialSource: 'env',
    metaDescription: 'Handmade ceramic mugs.',
    metaTitle: 'Ceramic mugs',
    modelId: 'openrouter/free',
    ogDescription: 'Handmade ceramic mugs.',
    ogTitle: 'Ceramic mugs',
  });
  mocks.generateCortexAiAltText.mockResolvedValue({
    altText: 'A blue ceramic mug.',
    credentialSource: 'env',
    modelId: 'openrouter/free',
  });
  mocks.generateCortexWidgetDefinition.mockResolvedValue({
    attempts: [],
    credentialSource: 'env',
    definition: { name: 'Pricing table' },
    modelId: 'openrouter/free',
  });
  mocks.insertCortexWidgetDefinition.mockResolvedValue({ id: 'definition-1', slug: 'pricing-table' });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe.each(ROUTES)('POST /api/$route resolves the actor, second factor included, first', (route) => {
  it.each([
    ['a WRITER whose enrolled authenticator app this session has not passed (aal1)', 'WRITER', 'totp'],
    ['an ADMIN whose enrolled authenticator app this session has not passed (aal1)', 'ADMIN', 'totp'],
    ['an ADMIN whose enrolled email code this session has not passed', 'ADMIN', 'email'],
  ] as const)('refuses %s before the quota, the package check, the body or the model', async (_label, role, factor) => {
    signIn(role);
    mocks.session.mfa = { mfa_enabled: true, mfa_type: factor };
    const pending = request(route.route, route.body);

    const response = await route.handler(pending);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: SECOND_FACTOR });
    expect(pending.bodyUsed).toBe(false);
    // getCmsActor() stops at the pending factor, before the role is read.
    expect(mocks.cookieReads).not.toContain('profiles');
    expectNothingPastTheGate(route);
  });

  it('answers 401 without a session', async () => {
    signIn(null, null);
    const response = await route.handler(request(route.route, route.body));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: route.permission });
    expectNothingPastTheGate(route);
  });

  it('refuses a signed-in customer (USER), also past an enrolled factor (aal2): the factor is not a role', async () => {
    signIn('USER');
    mocks.session.mfa = { mfa_enabled: true, mfa_type: 'totp' };
    mocks.session.aal = 'aal2';
    const response = await route.handler(request(route.route, route.body));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: route.permission });
    expectNothingPastTheGate(route);
  });

  it('refuses an account whose profile row is missing', async () => {
    signIn(null);
    const response = await route.handler(request(route.route, route.body));
    expect(response.status).toBe(403);
    expectNothingPastTheGate(route);
  });

  it.each(['WRITER', 'ADMIN'])(
    'serves a %s whose session passed the enrolled authenticator app (aal2), the quota keyed by that actor',
    async (role) => {
      signIn(role, { id: 'staff-1' });
      mocks.session.mfa = { mfa_enabled: true, mfa_type: 'totp' };
      mocks.session.aal = 'aal2';

      const response = await route.handler(request(route.route, route.body));

      expect(response.status).toBe(200);
      expect(mocks.enforceCortexAiRequestQuota).toHaveBeenCalledTimes(1);
      expect(mocks.enforceCortexAiRequestQuota).toHaveBeenCalledWith({ role, route: route.route, userId: 'staff-1' });
      expect(route.model()).toHaveBeenCalledTimes(1);
    }
  );

  it('serves a WRITER who enrolled no second factor', async () => {
    const response = await route.handler(request(route.route, route.body));
    expect(response.status).toBe(200);
    expect(mocks.enforceCortexAiRequestQuota).toHaveBeenCalledWith({ role: 'WRITER', route: route.route, userId: 'writer-1' });
  });

  it('still answers the quota refusal after the gate', async () => {
    mocks.enforceCortexAiRequestQuota.mockResolvedValue(Response.json({ error: 'Too many requests.' }, { status: 429 }));
    const response = await route.handler(request(route.route, route.body));
    expect(response.status).toBe(429);
    expect(mocks.verifyPackageOnline).not.toHaveBeenCalled();
    expect(route.model()).not.toHaveBeenCalled();
  });
});

describe('POST /api/ai/cortex/build-widget', () => {
  it('registers the widget with the cookie client only once the gate passed', async () => {
    mocks.session.mfa = { mfa_enabled: true, mfa_type: 'email' };
    const refused = await buildWidget(request('ai/cortex/build-widget', { prompt: 'A three-column pricing table.' }));
    expect(refused.status).toBe(403);
    expect(mocks.insertCortexWidgetDefinition).not.toHaveBeenCalled();
    expect(mocks.revalidateTag).not.toHaveBeenCalled();

    mocks.session.mfa = null;
    const served = await buildWidget(request('ai/cortex/build-widget', { prompt: 'A three-column pricing table.' }));
    expect(served.status).toBe(200);
    expect(mocks.insertCortexWidgetDefinition).toHaveBeenCalledTimes(1);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/cms/custom-blocks');
  });
});
