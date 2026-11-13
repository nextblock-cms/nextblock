import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * savePaymentCredentials on the public sandbox (NEXT_PUBLIC_IS_SANDBOX=true), whose demo admin
 * login is published: a payment secret saved there would be used for, and shown to, every later
 * visitor, and the public row's Freemius ids reach process.env through hydrateFreemiusEnvFromDb.
 * Every submission throws before anything is read, encrypted or written. Until 2026-11-03 the
 * `payment_public` upsert ran first, so the sandbox kept a visitor's public ids. Off the sandbox
 * the secret is encrypted and merged into `payment_secret`.
 *
 * The read side: a visitor can still write `payment_public` over PostgREST (the factor-less demo
 * admin passes is_admin_mfa()) or through Cortex's DB tool, and until 2026-11-03 any coupon save
 * or an unauthenticated POST /api/webhooks/freemius copied its Freemius ids into process.env,
 * where they stayed. The sandbox reads no payment row at all: Stripe and Freemius resolve from
 * its env only, and the payments screen shows no stored value (until 2026-11-03 its form still
 * showed what a visitor wrote) and drops its "saving here moves them" hint there.
 *
 * 2026-11-04: each key is sealed for its own field of `payment_secret` and opens nowhere else, so
 * an envelope copied between fields or rows (the Stripe key into the SMTP password) is useless;
 * every save re-seals what was stored before 0.23.1. Those cases use real envelopes.
 */

type SettingsRow = { key: string; value: unknown };

const mocks = vi.hoisted(() => ({
  rows: new Map<string, unknown>(),
  reads: [] as string[],
  upserts: [] as Array<{ key: string; value: unknown }>,
  requireEcomAdmin: vi.fn(),
  getEcomActorRole: vi.fn(),
  encryptWithEnvKey: vi.fn((value: string) => `enc:${value}`),
  // Opens nothing unless a test says otherwise (getStripeKeyDiagnostics' tests open `enc:` stand-ins).
  decrypt: vi.fn<(value: unknown) => string | null>(() => null),
}));

/** The service-role client requireEcomAdmin hands back; it records every read and upsert. */
function fakeServiceClient() {
  return {
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
        upsert: async (row: SettingsRow) => {
          mocks.upserts.push(row);
          mocks.rows.set(row.key, row.value);
          return { error: null };
        },
      };
    },
  };
}

vi.mock('server-only', () => ({}));
vi.mock('@nextblock-cms/db/server', async () => {
  // The real predicate and resolver (a dependency-free module): the env stub drives the refusal.
  const configResolve = await vi.importActual<{
    isSandboxEnvironment: () => boolean;
    resolveConfigValue: (dbValue: string | null | undefined, envName: string) => string | null;
  }>('../../../db/src/lib/config-resolve');
  const secretCrypto = await vi.importActual<typeof import('../../../db/src/lib/secret-crypto')>(
    '../../../db/src/lib/secret-crypto'
  );
  return {
    createClient: () => fakeServiceClient(),
    getServiceRoleSupabaseClient: () => fakeServiceClient(),
    encryptWithEnvKey: mocks.encryptWithEnvKey,
    getSecretEnvelopeStatus: (value: unknown) => ({ hasStoredValue: Boolean(value), last4: null }),
    // `enc:` stand-ins never open (so nothing reaches process.env); real envelopes go through the
    // real decrypt, slot check included.
    tryDecryptWithEnvKey: (value: unknown, slot: Parameters<typeof secretCrypto.tryDecryptWithEnvKey>[1]) =>
      value && typeof value === 'object' ? secretCrypto.tryDecryptWithEnvKey(value, slot) : mocks.decrypt(value),
    resealWithEnvKey: secretCrypto.resealWithEnvKey,
    siteSettingSecretSlot: secretCrypto.siteSettingSecretSlot,
    isSandboxEnvironment: configResolve.isSandboxEnvironment,
    resolveConfigValue: configResolve.resolveConfigValue,
  };
});
vi.mock('./server-actions/require-ecom-role', () => ({
  getEcomActorRole: mocks.getEcomActorRole,
  requireEcomAdmin: mocks.requireEcomAdmin,
}));

import {
  PAYMENT_SETTINGS_SANDBOX_MESSAGE,
  clearPaymentConfigCache,
  getPaymentCredentialsView,
  getStripeKeyDiagnostics,
  hydrateFreemiusEnvFromDb,
  resolveStripePublishableKey,
  resolveStripeSecretKey,
  resolveStripeWebhookSecret,
  savePaymentCredentials,
  type SavePaymentCredentialsInput,
} from './payment-config';
import { stripeSecretKeyLivemode } from './stripe/client';

const secretCrypto = await vi.importActual<typeof import('../../../db/src/lib/secret-crypto')>(
  '../../../db/src/lib/secret-crypto'
);
const TEST_KEY = 'payment-config-test-key';
const slot = (field: string) => secretCrypto.siteSettingSecretSlot('payment_secret', field);

/** An envelope exactly as 0.23.0 and earlier wrote it: version 1, no associated data. */
function legacyEnvelope(value: string, encryptionSecret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(encryptionSecret).digest(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    algorithm: 'aes-256-gcm',
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    last4: value.slice(-4),
    updatedAt: '2026-01-02T03:04:05.000Z',
    version: 1,
  };
}

const STORED_SECRET = { stripeSecretKey: 'enc:sk_live_existing', freemiusApiKey: 'enc:fm_api_existing' };

/** What a visitor wrote to `payment_public` over PostgREST as the demo admin. */
const VISITOR_PUBLIC = {
  stripe: { publishableKey: 'pk_test_visitor' },
  freemius: { publicKey: 'pk_fm_visitor', productId: '999999', developerId: '666' },
};

function input(secrets: {
  stripe?: Partial<Pick<SavePaymentCredentialsInput['stripe'], 'secretKey' | 'webhookSecret'>>;
  freemius?: Partial<Pick<SavePaymentCredentialsInput['freemius'], 'secretKey' | 'apiKey'>>;
} = {}): SavePaymentCredentialsInput {
  return {
    stripe: { publishableKey: ' pk_test_visitor ', ...secrets.stripe },
    freemius: { developerId: ' 101 ', publicKey: ' pk_fm_visitor ', productId: ' 202 ', ...secrets.freemius },
  };
}

/** The trimmed `payment_public` value the function writes for `input()`. */
const PUBLIC_VALUE = {
  stripe: { publishableKey: 'pk_test_visitor' },
  freemius: { developerId: '101', publicKey: 'pk_fm_visitor', productId: '202', sandboxEnabled: false },
};

const NEW_SECRETS: Array<[string, Parameters<typeof input>[0]]> = [
  ['a Stripe secret key', { stripe: { secretKey: 'sk_live_visitor' } }],
  ['a Stripe webhook secret', { stripe: { webhookSecret: 'whsec_visitor' } }],
  ['a Freemius secret key', { freemius: { secretKey: 'sk_fm_visitor' } }],
  ['a Freemius API key', { freemius: { apiKey: 'fm_api_visitor' } }],
];

beforeEach(() => {
  mocks.decrypt.mockReset().mockImplementation(() => null);
  mocks.rows.clear();
  mocks.rows.set('payment_secret', { ...STORED_SECRET });
  mocks.reads = [];
  mocks.upserts = [];
  mocks.requireEcomAdmin.mockReset().mockImplementation(async () => fakeServiceClient());
  mocks.getEcomActorRole.mockReset().mockImplementation(async () => 'ADMIN');
  mocks.encryptWithEnvKey.mockClear();
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('savePaymentCredentials on the sandbox', () => {
  it('names the sentence the payments screen shows there', () => {
    expect(PAYMENT_SETTINGS_SANDBOX_MESSAGE).toBe("Payment keys can't be changed in the sandbox: its checkout is simulated.");
  });

  it.each(NEW_SECRETS)('refuses %s: nothing is read, encrypted or written', async (_label, secrets) => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    await expect(savePaymentCredentials(input(secrets))).rejects.toThrow(PAYMENT_SETTINGS_SANDBOX_MESSAGE);

    expect(mocks.requireEcomAdmin).toHaveBeenCalledTimes(1);
    expect(mocks.encryptWithEnvKey).not.toHaveBeenCalled();
    expect(mocks.reads).toEqual([]);
    expect(mocks.upserts).toEqual([]);
    expect(mocks.rows.get('payment_secret')).toEqual(STORED_SECRET);
  });

  it('refuses a save without a new secret too: the public row keeps its Freemius ids out of process.env', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    await expect(
      savePaymentCredentials(input({ stripe: { secretKey: '   ', webhookSecret: '' }, freemius: { apiKey: ' ' } }))
    ).rejects.toThrow(PAYMENT_SETTINGS_SANDBOX_MESSAGE);

    expect(mocks.encryptWithEnvKey).not.toHaveBeenCalled();
    expect(mocks.reads).toEqual([]);
    expect(mocks.upserts).toEqual([]);
    expect(mocks.rows.has('payment_public')).toBe(false);
  });

  it('keeps the admin refusal first: a non-admin never learns it is the sandbox', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    mocks.requireEcomAdmin.mockRejectedValueOnce(new Error('Forbidden'));

    await expect(savePaymentCredentials(input({ stripe: { secretKey: 'sk_live_visitor' } }))).rejects.toThrow('Forbidden');
    expect(mocks.upserts).toEqual([]);
  });
});

describe('savePaymentCredentials off the sandbox', () => {
  it('encrypts a new secret and merges it into payment_secret (only the exact value "true" is the sandbox)', async () => {
    for (const value of ['', 'false', 'TRUE', '1']) {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      mocks.rows.set('payment_secret', { ...STORED_SECRET });
      mocks.reads = [];
      mocks.upserts = [];
      mocks.encryptWithEnvKey.mockClear();

      await expect(
        savePaymentCredentials(input({ stripe: { secretKey: ' sk_live_owner ' } })),
        value
      ).resolves.toBeUndefined();

      expect(mocks.encryptWithEnvKey, value).toHaveBeenCalledTimes(1);
      expect(mocks.encryptWithEnvKey, value).toHaveBeenCalledWith('sk_live_owner', 'site_settings:payment_secret:stripeSecretKey');
      expect(mocks.reads, value).toEqual(['payment_secret']);
      expect(mocks.upserts, value).toEqual([
        { key: 'payment_public', value: PUBLIC_VALUE },
        { key: 'payment_secret', value: { ...STORED_SECRET, stripeSecretKey: 'enc:sk_live_owner' } },
      ]);
    }
  });

  it('seals each new key for its own field of payment_secret', async () => {
    await savePaymentCredentials(
      input({
        stripe: { secretKey: 'sk_live_owner', webhookSecret: 'whsec_owner' },
        freemius: { secretKey: 'sk_fm_owner', apiKey: 'fm_api_owner' },
      })
    );

    expect(mocks.encryptWithEnvKey.mock.calls).toEqual([
      ['sk_live_owner', 'site_settings:payment_secret:stripeSecretKey'],
      ['whsec_owner', 'site_settings:payment_secret:stripeWebhookSecret'],
      ['sk_fm_owner', 'site_settings:payment_secret:freemiusSecretKey'],
      ['fm_api_owner', 'site_settings:payment_secret:freemiusApiKey'],
    ]);
  });

  it('re-seals the keys stored before 0.23.1 on a save that changes no key, and leaves the rest', async () => {
    vi.stubEnv('NEXTBLOCK_ENCRYPTION_KEY', TEST_KEY);
    mocks.rows.set('payment_secret', {
      stripeSecretKey: legacyEnvelope('sk_live_existing', TEST_KEY),
      freemiusSandboxSecretKey: legacyEnvelope('sk_fm_sandbox', TEST_KEY),
      freemiusApiKey: 'enc:fm_api_existing',
    });

    await savePaymentCredentials(input());

    expect(mocks.encryptWithEnvKey).not.toHaveBeenCalled();
    const stored = mocks.rows.get('payment_secret') as Record<string, { version?: number }>;
    expect(stored['stripeSecretKey']?.version).toBe(2);
    expect(secretCrypto.tryDecryptWithEnvKey(stored['stripeSecretKey'], slot('stripeSecretKey'))).toBe('sk_live_existing');
    expect(secretCrypto.tryDecryptWithEnvKey(stored['stripeSecretKey'], slot('stripeWebhookSecret'))).toBeNull();
    expect(secretCrypto.tryDecryptWithEnvKey(stored['freemiusSandboxSecretKey'], slot('freemiusSandboxSecretKey'))).toBe(
      'sk_fm_sandbox'
    );
    expect(stored['freemiusApiKey']).toBe('enc:fm_api_existing');
  });

  it('writes no payment_secret row when there is nothing new to store or re-seal', async () => {
    await savePaymentCredentials(input());

    expect(mocks.reads).toEqual(['payment_secret']);
    expect(mocks.upserts).toEqual([{ key: 'payment_public', value: PUBLIC_VALUE }]);
  });
});

describe('reading payment_secret: each key opens only from its own field', () => {
  beforeEach(() => {
    vi.stubEnv('NEXTBLOCK_ENCRYPTION_KEY', TEST_KEY);
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', '');
    clearPaymentConfigCache();
  });

  afterEach(() => {
    clearPaymentConfigCache();
  });

  it('uses a key sealed for its field, and one stored before 0.23.1', async () => {
    mocks.rows.set('payment_secret', { stripeSecretKey: secretCrypto.encryptWithEnvKey('sk_live_owner', slot('stripeSecretKey')) });
    await expect(resolveStripeSecretKey()).resolves.toBe('sk_live_owner');

    clearPaymentConfigCache();
    mocks.rows.set('payment_secret', { stripeSecretKey: legacyEnvelope('sk_live_old', TEST_KEY) });
    await expect(resolveStripeSecretKey()).resolves.toBe('sk_live_old');
  });

  it('ignores an envelope copied in from another field or another row', async () => {
    mocks.rows.set('payment_secret', {
      stripeSecretKey: secretCrypto.encryptWithEnvKey('whsec_moved', slot('stripeWebhookSecret')),
      stripeWebhookSecret: secretCrypto.encryptWithEnvKey(
        'smtp-pass',
        secretCrypto.siteSettingSecretSlot('email_secret', 'pass')
      ),
    });

    await expect(resolveStripeSecretKey()).resolves.toBeNull();
    await expect(resolveStripeWebhookSecret()).resolves.toBeNull();
  });
});

// The module-internal reader behind every resolver, reached here via hydrateFreemiusEnvFromDb and
// resolveStripePublishableKey: on the sandbox it reads no payment row and caches nothing.
describe('loadPaymentRows', () => {
  /** What the operator configured in the deployment's env. */
  const OPERATOR_ENV = { FREEMIUS_PUBLIC_KEY: 'pk_fm_operator', FREEMIUS_PRODUCT_ID: '24851', FREEMIUS_DEVELOPER_ID: '4242' };
  const HYDRATED_FROM_ROW = { FREEMIUS_PUBLIC_KEY: 'pk_fm_visitor', FREEMIUS_PRODUCT_ID: '999999', FREEMIUS_DEVELOPER_ID: '666' };

  function freemiusEnv() {
    return {
      FREEMIUS_PUBLIC_KEY: process.env['FREEMIUS_PUBLIC_KEY'],
      FREEMIUS_PRODUCT_ID: process.env['FREEMIUS_PRODUCT_ID'],
      FREEMIUS_DEVELOPER_ID: process.env['FREEMIUS_DEVELOPER_ID'],
    };
  }

  beforeEach(() => {
    // Stubbed, so the file's unstubAllEnvs also undoes what hydrateFreemiusEnvFromDb writes.
    for (const [name, value] of Object.entries(OPERATOR_ENV)) {
      vi.stubEnv(name, value);
    }
    vi.stubEnv('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'pk_test_operator');
    mocks.rows.set('payment_public', VISITOR_PUBLIC);
    clearPaymentConfigCache();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    clearPaymentConfigCache();
  });

  it('on the sandbox reads no payment row: hydrateFreemiusEnvFromDb leaves the operator env as it is', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    await hydrateFreemiusEnvFromDb();

    expect(mocks.reads).toEqual([]);
    expect(freemiusEnv()).toEqual(OPERATOR_ENV);
  });

  it('on the sandbox resolves Stripe from the env only', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    await expect(resolveStripePublishableKey()).resolves.toBe('pk_test_operator');
    expect(mocks.reads).toEqual([]);
  });

  it('on the sandbox keeps no cache entry: the next read off the sandbox goes to the database', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    await hydrateFreemiusEnvFromDb();

    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
    await hydrateFreemiusEnvFromDb();

    expect(mocks.reads).toEqual(['payment_secret', 'payment_public']);
    expect(freemiusEnv()).toEqual(HYDRATED_FROM_ROW);
  });

  it.each(['', 'false', 'TRUE', '1'])(
    'with NEXT_PUBLIC_IS_SANDBOX=%j reads the stored row, which wins over the env',
    async (value) => {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);

      await hydrateFreemiusEnvFromDb();

      expect(mocks.reads).toEqual(['payment_secret', 'payment_public']);
      expect(freemiusEnv()).toEqual(HYDRATED_FROM_ROW);
      await expect(resolveStripePublishableKey()).resolves.toBe('pk_test_visitor');
    }
  );
});

describe('getPaymentCredentialsView on the sandbox', () => {
  /** Every secret the form reports on, stored. */
  const FULL_SECRET = {
    stripeSecretKey: 'enc:sk_live_existing',
    stripeWebhookSecret: 'enc:whsec_existing',
    freemiusSecretKey: 'enc:sk_fm_existing',
    freemiusApiKey: 'enc:fm_api_existing',
  };

  beforeEach(() => {
    mocks.rows.set('payment_public', VISITOR_PUBLIC);
    mocks.rows.set('payment_secret', { ...FULL_SECRET });
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_env');
  });

  it('reads no payment row and shows none of what a visitor wrote: every field is empty', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    await expect(getPaymentCredentialsView()).resolves.toEqual({
      stripe: { publishableKey: '', hasSecretKey: false, hasWebhookSecret: false },
      freemius: { developerId: '', publicKey: '', productId: '', hasSecretKey: false, hasApiKey: false },
      envFallbackActive: false,
    });
    expect(mocks.reads).toEqual([]);
    expect(mocks.getEcomActorRole).not.toHaveBeenCalled();
  });

  it.each(['', 'false', 'TRUE', '1'])(
    'with NEXT_PUBLIC_IS_SANDBOX=%j shows the stored rows, read with the client the role picks',
    async (value) => {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);

      await expect(getPaymentCredentialsView()).resolves.toEqual({
        stripe: { publishableKey: 'pk_test_visitor', hasSecretKey: true, hasWebhookSecret: true },
        freemius: { developerId: '666', publicKey: 'pk_fm_visitor', productId: '999999', hasSecretKey: true, hasApiKey: true },
        envFallbackActive: false,
      });
      expect(mocks.reads).toEqual(['payment_secret', 'payment_public']);
      expect(mocks.getEcomActorRole).toHaveBeenCalledTimes(1);
    }
  );
});

describe('getPaymentCredentialsView env-fallback hint', () => {
  beforeEach(() => {
    // No Stripe secret stored; the deployment's env has one.
    mocks.rows.set('payment_secret', { freemiusApiKey: 'enc:fm_api_existing' });
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_env');
  });

  it('is off on the sandbox, where the env is all there is and saving refuses', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    await expect(getPaymentCredentialsView()).resolves.toMatchObject({ envFallbackActive: false });
  });

  it.each(['', 'false', 'TRUE', '1'])(
    'with NEXT_PUBLIC_IS_SANDBOX=%j is on while STRIPE_SECRET_KEY comes from the env and none is stored',
    async (value) => {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);

      await expect(getPaymentCredentialsView()).resolves.toMatchObject({ envFallbackActive: true });
    }
  );

  it('is off once a Stripe secret is stored', async () => {
    mocks.rows.set('payment_secret', { ...STORED_SECRET });

    await expect(getPaymentCredentialsView()).resolves.toMatchObject({ envFallbackActive: false });
  });
});

describe('getStripeKeyDiagnostics', () => {
  /**
   * Live keys are joined at runtime. A Stripe-length `sk_live_…` literal is invented here, but a
   * scanner cannot tell: GitHub push protection blocked the 0.23.0 push on two of them, and the
   * public history must carry no key-shaped string anyone who re-pushes it would trip over.
   */
  const liveKey = (prefix: 'sk' | 'rk', body: string) => [prefix, 'live', body].join('_');
  /** A Stripe-length key; only its last 4 characters may ever leave getStripeKeyDiagnostics. */
  const CMS_SECRET = 'sk_test_51CmsSecretKeyValue9876';
  const ENV_RESTRICTED = liveKey('rk', '51EnvRestrictedKey4321');

  beforeEach(() => {
    clearPaymentConfigCache();
    for (const name of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY']) vi.stubEnv(name, '');
    mocks.rows.clear();
    // The stored envelopes of these tests are `enc:<value>`.
    mocks.decrypt.mockImplementation((value) => (typeof value === 'string' && value.startsWith('enc:') ? value.slice(4) : null));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    clearPaymentConfigCache();
  });

  it('on the sandbox reads no row and reports no key fact (its keys belong to the operator)', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    vi.stubEnv('STRIPE_SECRET_KEY', liveKey('sk', '51OperatorKeyOnTheSandbox0000'));
    mocks.rows.set('payment_secret', { stripeSecretKey: `enc:${CMS_SECRET}` });

    await expect(getStripeKeyDiagnostics()).resolves.toEqual({
      sandbox: true,
      secretKeySource: null,
      storedSecretKeyUnreadable: false,
      mode: null,
      restricted: false,
      secretKeyLast4: null,
      publishableKeySource: null,
      publishableKeyMode: null,
      publishableKeyMatchesMode: false,
      webhookSecretSource: null,
    });
    expect(mocks.reads).toEqual([]);
  });

  it.each(['', 'false', 'TRUE', '1'])(
    'with NEXT_PUBLIC_IS_SANDBOX=%j reports the CMS keys: source, mode, last 4, the publishable pair and the webhook secret',
    async (value) => {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      vi.stubEnv('STRIPE_SECRET_KEY', liveKey('sk', '51EnvKeyThatTheCmsKeyOverrides'));
      mocks.rows.set('payment_secret', { stripeSecretKey: `enc:${CMS_SECRET}`, stripeWebhookSecret: 'enc:whsec_cms' });
      mocks.rows.set('payment_public', { stripe: { publishableKey: 'pk_test_51CmsPublishable' } });

      const facts = await getStripeKeyDiagnostics();

      expect(facts).toEqual({
        sandbox: false,
        secretKeySource: 'cms',
        storedSecretKeyUnreadable: false,
        mode: 'test',
        restricted: false,
        secretKeyLast4: '9876',
        publishableKeySource: 'cms',
        publishableKeyMode: 'test',
        publishableKeyMatchesMode: true,
        webhookSecretSource: 'cms',
      });
      expect(mocks.reads).toEqual(['payment_secret', 'payment_public']);
      expect(JSON.stringify(facts)).not.toMatch(/sk_|pk_|whsec_|CmsSecret/);
    }
  );

  it('falls back to the env, flags a saved key this deployment cannot decrypt, and a publishable key of the other mode', async () => {
    mocks.rows.set('payment_secret', { stripeSecretKey: 'not-an-envelope-this-key-can-open' });
    vi.stubEnv('STRIPE_SECRET_KEY', ENV_RESTRICTED);
    vi.stubEnv('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'pk_test_51EnvPublishable');

    const facts = await getStripeKeyDiagnostics();

    expect(facts).toEqual({
      sandbox: false,
      secretKeySource: 'env',
      storedSecretKeyUnreadable: true,
      mode: 'live',
      restricted: true,
      secretKeyLast4: '4321',
      publishableKeySource: 'env',
      publishableKeyMode: 'test',
      publishableKeyMatchesMode: false,
      webhookSecretSource: null,
    });
    expect(JSON.stringify(facts)).not.toContain('rk_live');
  });

  it('reports nothing configured, and never echoes a short or unknown key', async () => {
    await expect(getStripeKeyDiagnostics()).resolves.toMatchObject({
      secretKeySource: null,
      mode: null,
      secretKeyLast4: null,
      publishableKeySource: null,
      publishableKeyMatchesMode: false,
      webhookSecretSource: null,
    });

    clearPaymentConfigCache();
    vi.stubEnv('STRIPE_SECRET_KEY', 'oops-key');
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_env');
    await expect(getStripeKeyDiagnostics()).resolves.toMatchObject({
      secretKeySource: 'env',
      mode: null,
      restricted: false,
      secretKeyLast4: null,
      webhookSecretSource: 'env',
    });
  });

  it('reads the mode from the same prefixes as stripeSecretKeyLivemode', async () => {
    for (const key of ['sk_live_51Abcdefghijkl', 'rk_live_51Abcdefghijkl', 'sk_test_51Abcdefghijkl', 'rk_test_51Abcdefghijkl', 'pk_live_51Abcdefghijkl']) {
      clearPaymentConfigCache();
      vi.stubEnv('STRIPE_SECRET_KEY', key);
      const livemode = stripeSecretKeyLivemode(key);
      const expected = livemode === null ? null : livemode ? 'live' : 'test';
      await expect(getStripeKeyDiagnostics(), key).resolves.toMatchObject({ mode: expected });
    }
  });
});
