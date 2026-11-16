import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * CMS → Payments decides whether a provider can be switched on from the readiness it renders with:
 * the inline toggle action keeps that render's `configStatus`. Readiness never waits on Freemius
 * (payment-config-readiness.test.ts) and counts a developer pair nobody has checked yet as ready.
 * Review 2026-11-13: the screen read readiness in parallel with its own blocking check of the pair,
 * so on a cold cache (the first visit after a cold start, and after every key save, which forgets
 * the verdicts) a pair Freemius refuses read as ready and the admin could enable Freemius with it.
 * The screen now waits for the check, which records the verdict, and only then reads readiness.
 *
 * The real queries, payment-config and freemius-developer-api run here; only the database, the
 * role check, the actions, the client component, Next's after() and api.freemius.com are faked.
 */

const mocks = vi.hoisted(() => ({
  after: vi.fn<(task: () => unknown) => void>(),
  getEcomActorRole: vi.fn(async () => 'ADMIN' as const),
  /** Every site_settings key read, in order. */
  reads: [] as string[],
  updatePaymentSettings: vi.fn<(settings: { stripe: boolean; freemius: boolean }) => Promise<{ success: boolean }>>(
    async () => ({ success: true })
  ),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/server', () => ({ after: mocks.after }));
vi.mock('@nextblock-cms/db/server', async () => {
  const configResolve = await vi.importActual<{
    isSandboxEnvironment: () => boolean;
    resolveConfigValue: (dbValue: string | null | undefined, envName: string, options?: { warnOnEnvFallback?: boolean }) => string | null;
  }>('../../../../../../db/src/lib/config-resolve');
  // No row is stored: every credential comes from the env, and the providers keep their defaults.
  const noRows = () => ({
    from: () => ({
      select: () => ({
        eq: (_column: string, key: string) => ({
          maybeSingle: async () => {
            mocks.reads.push(key);
            return { data: null, error: null };
          },
        }),
      }),
    }),
  });
  return {
    createClient: noRows,
    getServiceRoleSupabaseClient: noRows,
    encryptWithEnvKey: (value: string) => value,
    getSecretEnvelopeStatus: () => ({ hasStoredValue: false, last4: null }),
    isSandboxEnvironment: configResolve.isSandboxEnvironment,
    resealWithEnvKey: (value: unknown) => value,
    resolveConfigValue: configResolve.resolveConfigValue,
    siteSettingSecretSlot: (key: string, field: string) => ({ key, field }),
    tryDecryptWithEnvKey: () => null,
  };
});
vi.mock('../../../server-actions/require-ecom-role', () => ({
  getEcomActorRole: mocks.getEcomActorRole,
  requireEcomAdmin: vi.fn(),
}));
vi.mock('./actions', () => ({
  savePaymentProviderCredentials: vi.fn(),
  updatePaymentSettings: mocks.updatePaymentSettings,
}));
// Rendering is PaymentsClient.test.tsx's job: the page's output is the props it hands over. The
// copy tests below render those props with the real client (renderScreen), which needs a router.
vi.mock('./PaymentsClient', () => ({ PaymentsClient: () => null }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { forgetFreemiusDeveloperCaches } from '../../../freemius-developer-api';
import { clearPaymentConfigCache } from '../../../payment-config';
import { PaymentsPage } from './PaymentsPage';

const DEVELOPER_ENV = {
  FREEMIUS_DEVELOPER_ID: '4242',
  FREEMIUS_DEVELOPER_PUBLIC_KEY: 'pk_dev_payments_page',
  FREEMIUS_DEVELOPER_SECRET_KEY: 'sk_dev_payments_page',
};

/**
 * api.freemius.com answering `status` (the account's three products on a 200) once `gate` resolves,
 * and never in the same macrotask, so a readiness read that did not wait for the check would run
 * before any verdict exists.
 */
function stubFreemius(status: number, gate: Promise<unknown> = new Promise((resolve) => setTimeout(resolve, 5))) {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => {
    await gate;
    const body = status === 200 ? { plugins: [{ id: 24851 }, { id: 28609 }, { id: 43273 }] } : { error: { message: 'No.' } };
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** What the inline toggle action saves when the admin asks for both providers. */
async function saveBothEnabled(saveAction: (formData: FormData) => Promise<void>) {
  const formData = new FormData();
  formData.set('stripe_enabled', 'true');
  formData.set('freemius_enabled', 'true');
  await saveAction(formData);
  return mocks.updatePaymentSettings.mock.calls.at(-1)?.[0];
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  // No one-product Freemius keys and no Stripe keys: only the developer pair can make a provider ready.
  for (const name of ['FREEMIUS_PUBLIC_KEY', 'FREEMIUS_SECRET_KEY', 'FREEMIUS_PRODUCT_ID', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY']) {
    vi.stubEnv(name, '');
  }
  for (const [name, value] of Object.entries(DEVELOPER_ENV)) vi.stubEnv(name, value);
  // A cold cache: no verdict on the pair yet, as after a cold start or a key save.
  clearPaymentConfigCache();
  forgetFreemiusDeveloperCaches();
  mocks.reads.length = 0;
  mocks.after.mockReset();
  mocks.getEcomActorRole.mockClear();
  mocks.updatePaymentSettings.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PaymentsPage readiness on a cold cache', () => {
  it('reads a pair Freemius refuses as not ready, so the toggle cannot switch Freemius on', async () => {
    const fetchMock = stubFreemius(401);

    const page = await PaymentsPage();

    expect(page.props.freemiusDeveloper).toEqual({ state: 'refused', source: null, productIds: [] });
    expect(page.props.configStatus.freemius).toEqual({ hasKeys: false, missing: ['Public key', 'Secret key'] });
    await expect(saveBothEnabled(page.props.saveAction)).resolves.toEqual({ stripe: false, freemius: false });
    // One check, and readiness read its verdict: nothing was left to check after the response.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it('reads a pair Freemius accepts as ready, and the toggle switches Freemius on', async () => {
    stubFreemius(200);

    const page = await PaymentsPage();

    expect(page.props.freemiusDeveloper).toEqual({ state: 'working', source: 'env', productIds: ['24851', '28609', '43273'] });
    expect(page.props.configStatus.freemius).toEqual({ hasKeys: true, missing: [] });
    await expect(saveBothEnabled(page.props.saveAction)).resolves.toEqual({ stripe: false, freemius: true });
  });

  it('reads the enabled providers and the keys form while Freemius is still answering', async () => {
    let answer: () => void = () => undefined;
    const fetchMock = stubFreemius(
      401,
      new Promise<void>((resolve) => {
        answer = resolve;
      })
    );

    const rendering = PaymentsPage();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(mocks.reads).toContain('enabled_payment_providers');
    expect(mocks.getEcomActorRole).toHaveBeenCalledTimes(1);

    answer();
    await expect(rendering).resolves.toMatchObject({ props: { configStatus: { freemius: { hasKeys: false } } } });
  });
});

type RealPaymentsClient = typeof import('./PaymentsClient').PaymentsClient;
let realPaymentsClient: RealPaymentsClient | null = null;

// Loaded once, outside the tests' own timeout: the real client pulls in the UI library, which can
// take seconds to import on a busy machine.
beforeAll(async () => {
  ({ PaymentsClient: realPaymentsClient } = await vi.importActual<typeof import('./PaymentsClient')>('./PaymentsClient'));
}, 60_000);

/** The screen as the admin reads it: the page's props rendered by the real client. */
function renderScreen(page: Awaited<ReturnType<typeof PaymentsPage>>): string {
  if (!realPaymentsClient) throw new Error('The real PaymentsClient did not load.');
  return renderToStaticMarkup(createElement(realPaymentsClient, page.props as ComponentProps<RealPaymentsClient>));
}

/** One product's keys under the one-product names, with no Product ID and no FREEMIUS_CHECKOUT_PRODUCTS_JSON entry. */
function stubOneProductKeys() {
  vi.stubEnv('FREEMIUS_PUBLIC_KEY', 'pk_one_product_payments_page');
  vi.stubEnv('FREEMIUS_SECRET_KEY', 'sk_one_product_payments_page');
  vi.stubEnv('FREEMIUS_PRODUCT_ID', '');
  vi.stubEnv('FREEMIUS_CHECKOUT_PRODUCTS_JSON', '');
}

describe('PaymentsPage Freemius copy (round 3 review)', () => {
  it('a refused dedicated pair beside one product’s unbound keys: the guide asks for what is missing', async () => {
    stubOneProductKeys();
    stubFreemius(401);

    const page = await PaymentsPage();
    const missing = page.props.configStatus.freemius.missing;

    // Readiness' own label for this state (payment-config.ts), whatever its wording.
    expect(page.props.configStatus.freemius.hasKeys).toBe(false);
    expect(missing).toHaveLength(1);
    expect(missing[0]).not.toMatch(/^(Public|Secret) key$/);
    expect(page.props.freemiusDeveloperSources).toEqual(['env', 'env-legacy']);

    const markup = renderScreen(page);
    expect(markup).toContain(`Freemius needs <strong>${missing[0]}</strong>.`);
    expect(markup).not.toContain('one product’s public and secret key');
    // A dedicated pair was refused: its copy stays as it was.
    expect(markup).toContain('Freemius refused the developer keys. Check the Developer ID and the key pair');
  });

  it('a Developer ID beside one product’s keys only: says those keys were tried as a developer pair', async () => {
    stubOneProductKeys();
    vi.stubEnv('FREEMIUS_DEVELOPER_PUBLIC_KEY', '');
    vi.stubEnv('FREEMIUS_DEVELOPER_SECRET_KEY', '');
    const fetchMock = stubFreemius(401);

    const page = await PaymentsPage();

    expect(page.props.freemiusDeveloper).toEqual({ state: 'refused', source: null, productIds: [] });
    expect(page.props.freemiusDeveloperSources).toEqual(['env-legacy']);
    // The one-product keys still open their product's checkout (the key policy asks Freemius), so the store stays ready.
    expect(page.props.configStatus.freemius).toEqual({ hasKeys: true, missing: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const markup = renderScreen(page);
    expect(markup).toContain(
      'Freemius refused the one-product keys in <code>FREEMIUS_PUBLIC_KEY</code> and <code>FREEMIUS_SECRET_KEY</code> as a developer key pair'
    );
    expect(markup).toContain('fill in its Product ID below (or set <code>FREEMIUS_PRODUCT_ID</code>)');
    expect(markup).not.toContain('Freemius refused the developer keys');
  });

  it('reads no pair sources while the pair works', async () => {
    stubFreemius(200);

    const page = await PaymentsPage();

    expect(page.props.freemiusDeveloper?.state).toBe('working');
    expect(page.props.freemiusDeveloperSources).toEqual([]);
  });
});
