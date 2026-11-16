import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * CMS → Payments' keys form (`savePaymentProviderCredentials`). 0.23.4 verification (F3): a stored
 * secret could not be deleted, so the upgrade notes' "delete the old developer pair from every
 * field" could not be done. The form's remove boxes (`remove_<field id>` = `true`) now delete their
 * stored secret through the same save, behind the same checks: the action's role read, then
 * `requireEcomAdmin()` (role and second factor) in savePaymentCredentials before any read or write,
 * then the sandbox refusal.
 *
 * The real action, payment-config and require-ecom-role run here, against a stubbed cookie session,
 * the app's second-factor gate and a site_settings table in memory.
 */

const GATE = Symbol.for('nextblock.cms.secondFactorGate');

const mocks = vi.hoisted(() => ({
  user: { id: 'admin-1' } as { id: string } | null,
  role: 'ADMIN' as string | null,
  secondFactorPassed: true,
  rows: new Map<string, unknown>(),
  reads: [] as string[],
  upserts: [] as Array<{ key: string; value: unknown }>,
  serviceClientCreated: vi.fn(),
  revalidatePath: vi.fn(),
  forgetDeveloperCaches: vi.fn(),
}));

/** The service-role client: site_settings in `mocks.rows`, every read and upsert recorded. */
const serviceClient = {
  from: (table: string) => {
    expect(table).toBe('site_settings');
    return {
      select: () => ({
        eq: (_column: string, key: string) => ({
          maybeSingle: async () => {
            mocks.reads.push(key);
            return { data: mocks.rows.has(key) ? { value: mocks.rows.get(key) } : null, error: null };
          },
        }),
      }),
      upsert: async (row: { key: string; value: unknown }) => {
        mocks.upserts.push(row);
        mocks.rows.set(row.key, row.value);
        return { error: null };
      },
    };
  },
};

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@nextblock-cms/db/server', async () => {
  const configResolve = await vi.importActual<{
    isSandboxEnvironment: () => boolean;
    resolveConfigValue: (dbValue: string | null | undefined, envName: string) => string | null;
  }>('../../../../../../db/src/lib/config-resolve');
  return {
    // The cookie client both role checks read the session and the caller's own role through.
    createClient: () => ({
      auth: { getUser: async () => ({ data: { user: mocks.user } }) },
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            single: async () => ({ data: table === 'profiles' && mocks.role ? { role: mocks.role } : null }),
            maybeSingle: async () => ({ data: null }),
          }),
        }),
      }),
    }),
    getServiceRoleSupabaseClient: () => {
      mocks.serviceClientCreated();
      return serviceClient;
    },
    encryptWithEnvKey: (value: string) => `enc:${value}`,
    getSecretEnvelopeStatus: (value: unknown) => ({ hasStoredValue: Boolean(value), last4: null }),
    isSandboxEnvironment: configResolve.isSandboxEnvironment,
    resealWithEnvKey: (value: unknown) => value,
    resolveConfigValue: configResolve.resolveConfigValue,
    siteSettingSecretSlot: (key: string, field: string) => `site_settings:${key}:${field}`,
    tryDecryptWithEnvKey: () => null,
  };
});
// The developer pair's checks have their own tests; a save only drops their verdicts.
vi.mock('../../../freemius-developer-api', () => ({
  forgetFreemiusDeveloperCaches: mocks.forgetDeveloperCaches,
  getFreemiusDeveloperStatus: vi.fn(),
}));

import { PAYMENT_SETTINGS_SANDBOX_MESSAGE } from '../../../payment-config';
import { savePaymentProviderCredentials } from './actions';

/** Every secret the form shows, stored. */
const STORED = {
  stripeSecretKey: 'enc:sk_live_stored',
  stripeWebhookSecret: 'enc:whsec_stored',
  freemiusSecretKey: 'enc:sk_fm_stored',
  freemiusApiKey: 'enc:fm_api_stored',
  freemiusDeveloperSecretKey: 'enc:sk_dev_stored',
};

/** Each remove box and the stored secret it deletes. */
const BOXES = [
  ['remove_stripe_secretKey', 'stripeSecretKey'],
  ['remove_stripe_webhookSecret', 'stripeWebhookSecret'],
  ['remove_freemius_developerSecretKey', 'freemiusDeveloperSecretKey'],
  ['remove_freemius_secretKey', 'freemiusSecretKey'],
  ['remove_freemius_apiKey', 'freemiusApiKey'],
] as const;

/** The keys form as the browser posts it: every field blank but these. */
function keysForm(fields: Record<string, string> = {}) {
  const form = new FormData();
  for (const name of [
    'stripe_publishableKey',
    'stripe_secretKey',
    'stripe_webhookSecret',
    'freemius_developerId',
    'freemius_developerPublicKey',
    'freemius_developerSecretKey',
    'freemius_publicKey',
    'freemius_productId',
    'freemius_secretKey',
    'freemius_apiKey',
  ]) {
    form.set(name, '');
  }
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  return form;
}

function expectNothingReadOrWritten() {
  expect(mocks.reads).toEqual([]);
  expect(mocks.upserts).toEqual([]);
  expect(mocks.rows.get('payment_secret')).toEqual(STORED);
  expect(mocks.revalidatePath).not.toHaveBeenCalled();
  expect(mocks.forgetDeveloperCaches).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  mocks.user = { id: 'admin-1' };
  mocks.role = 'ADMIN';
  mocks.secondFactorPassed = true;
  mocks.rows.clear();
  mocks.rows.set('payment_secret', { ...STORED });
  mocks.reads = [];
  mocks.upserts = [];
  // The app's gate, as instrumentation.ts / cms-actor.ts register it at server start.
  (globalThis as Record<symbol, unknown>)[GATE] = async () => mocks.secondFactorPassed;
});

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[GATE];
  vi.unstubAllEnvs();
});

describe('savePaymentProviderCredentials remove boxes', () => {
  it.each(BOXES)('%s deletes %s from payment_secret, and nothing else', async (box, field) => {
    const kept: Record<string, string> = { ...STORED };
    delete kept[field];

    await savePaymentProviderCredentials(keysForm({ [box]: 'true' }));

    expect(mocks.rows.get('payment_secret')).toEqual(kept);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/cms/payments');
    expect(mocks.forgetDeveloperCaches).toHaveBeenCalledTimes(1);
  });

  it('keeps every stored secret for blank fields without a ticked box, whatever else is posted', async () => {
    await savePaymentProviderCredentials(
      keysForm({
        remove_stripe_secretKey: 'on',
        remove_freemius_secretKey: 'false',
        remove_freemiusSandboxSecretKey: 'true',
        remove_freemiusSecretKey: 'true',
      })
    );

    expect(mocks.rows.get('payment_secret')).toEqual(STORED);
    expect(mocks.upserts.map((row) => row.key)).toEqual(['payment_public']);
  });

  it('stores a key typed into a field whose box is ticked: it replaces the stored one', async () => {
    await savePaymentProviderCredentials(keysForm({ freemius_secretKey: 'sk_fm_new', remove_freemius_secretKey: 'true' }));

    expect(mocks.rows.get('payment_secret')).toEqual({ ...STORED, freemiusSecretKey: 'enc:sk_fm_new' });
  });
});

describe('savePaymentProviderCredentials checks the actor before it removes anything', () => {
  const EVERY_BOX = Object.fromEntries(BOXES.map(([box]) => [box, 'true']));

  it('refuses an ADMIN whose second factor is still pending: no service-role client, nothing read, written or removed', async () => {
    mocks.secondFactorPassed = false;

    await expect(savePaymentProviderCredentials(keysForm(EVERY_BOX))).rejects.toThrow('Unauthorized');
    expect(mocks.serviceClientCreated).not.toHaveBeenCalled();
    expectNothingReadOrWritten();
  });

  it.each([
    ['no session', null, null, 'Unauthorized'],
    ['a WRITER', { id: 'writer-1' }, 'WRITER', 'Forbidden'],
    ['a customer', { id: 'customer-1' }, 'USER', 'Forbidden'],
  ] as const)('refuses %s: no service-role client, nothing read, written or removed', async (_label, user, role, refusal) => {
    mocks.user = user ? { ...user } : null;
    mocks.role = role;

    await expect(savePaymentProviderCredentials(keysForm(EVERY_BOX))).rejects.toThrow(refusal);
    expect(mocks.serviceClientCreated).not.toHaveBeenCalled();
    expectNothingReadOrWritten();
  });

  it('refuses on the sandbox right after the admin check: nothing read, written or removed', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    await expect(savePaymentProviderCredentials(keysForm(EVERY_BOX))).rejects.toThrow(PAYMENT_SETTINGS_SANDBOX_MESSAGE);
    expectNothingReadOrWritten();
  });
});
