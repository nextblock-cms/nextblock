import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Where the PayPal credentials come from (02037): the CMS-saved pair wins over the PAYPAL_* environment
 * variables, the secret is stored encrypted and never handed out (the CMS sees the environment, the
 * source and the client id's last 4 characters), a save needs an ADMIN, and on the public sandbox
 * nothing is read or saved, the environment pair included.
 */

const mocks = vi.hoisted(() => ({
  requireCmsAdmin: vi.fn(),
  row: null as Record<string, unknown> | null,
  readError: null as { code: string } | null,
  upserts: [] as Array<Record<string, unknown>>,
  reads: 0,
}));

function fakeClient() {
  return {
    from(table: string) {
      expect(table).toBe('site_settings');
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          expect(column).toBe('key');
          expect(value).toBe('affiliates_paypal_secret');
          return builder;
        },
        maybeSingle: async () => {
          mocks.reads += 1;
          return mocks.readError ? { data: null, error: mocks.readError } : { data: mocks.row ? { value: mocks.row } : null, error: null };
        },
        upsert: async (value: Record<string, unknown>) => {
          mocks.upserts.push(value);
          mocks.row = value['value'] as Record<string, unknown>;
          return { error: null };
        },
      };
      return builder;
    },
  };
}

vi.mock('server-only', () => ({}));
vi.mock('@nextblock-cms/db/server', () => ({
  // A stand-in envelope: never the plaintext, reversible only here, and only in the slot it was
  // sealed for (the real envelopes bind their slot as AES-GCM associated data, 02038).
  encryptWithEnvKey: (value: string, slot: string) => ({ v: 2, slot, ct: `enc:${Buffer.from(value).toString('base64')}` }),
  tryDecryptWithEnvKey: (envelope: unknown, slot: string) => {
    const record = envelope && typeof envelope === 'object' ? (envelope as { ct?: unknown; slot?: unknown }) : null;
    const ct = record?.ct;
    if (!record || record.slot !== slot) return null;
    return typeof ct === 'string' && ct.startsWith('enc:') ? Buffer.from(ct.slice(4), 'base64').toString('utf8') : null;
  },
  siteSettingSecretSlot: (key: string, field?: string) => `site_settings:${key}${field ? `:${field}` : ''}`,
  getSecretEnvelopeStatus: (envelope: unknown) => ({ hasStoredValue: Boolean(envelope) }),
  getServiceRoleSupabaseClient: () => fakeClient(),
}));
vi.mock('../../auth/cms-actor', () => ({ requireCmsAdmin: mocks.requireCmsAdmin }));

import { clearAffiliatePayPalTokenCache } from './client';
import {
  clearAffiliatePayPalCredentialsCache,
  getAffiliatePayPalCredentialStatus,
  previewAffiliatePayPalCredentials,
  resolveAffiliatePayPalCredentials,
  resolveAffiliatePayPalEnvironment,
  storeAffiliatePayPalCredentials,
} from './credentials';

/** A stand-in envelope sealed for one environment's field, as the module seals it. */
const enc = (value: string, environment: 'sandbox' | 'live' = 'live') => ({
  v: 2,
  slot: `site_settings:affiliates_paypal_secret:${environment}_secret`,
  ct: `enc:${Buffer.from(value).toString('base64')}`,
});

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const name of ['PAYPAL_CLIENT_ID', 'PAYPAL_SECRET_KEY', 'PAYPAL_LIVE_CLIENT_ID', 'PAYPAL_LIVE_SECRET_KEY', 'PAYPAL_ENVIRONMENT']) {
    vi.stubEnv(name, '');
  }
  mocks.row = null;
  mocks.readError = null;
  mocks.upserts = [];
  mocks.reads = 0;
  mocks.requireCmsAdmin.mockReset();
  mocks.requireCmsAdmin.mockResolvedValue({ supabase: fakeClient(), userId: 'admin-1' });
  clearAffiliatePayPalCredentialsCache();
  clearAffiliatePayPalTokenCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('on the public sandbox', () => {
  it('reads nothing, saves nothing and shows no fact, even with the env pair and a saved row', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    vi.stubEnv('PAYPAL_CLIENT_ID', 'EnvSandboxClient1234');
    vi.stubEnv('PAYPAL_SECRET_KEY', 'env-sandbox-secret');
    vi.stubEnv('PAYPAL_ENVIRONMENT', 'live');
    mocks.row = { environment: 'live', live: { clientId: 'CmsLiveClient5678', secret: enc('cms-live-secret') } };

    expect(await resolveAffiliatePayPalEnvironment()).toEqual({ environment: 'sandbox', source: 'default' });
    expect(await resolveAffiliatePayPalCredentials()).toBeNull();
    expect(await resolveAffiliatePayPalCredentials('live')).toBeNull();
    expect(await previewAffiliatePayPalCredentials({ environment: 'sandbox' })).toBeNull();
    const status = await getAffiliatePayPalCredentialStatus();
    expect(status.sandbox).toBe(true);
    expect(status.active).toEqual({ configured: false, source: null, clientIdLast4: null, storedSecretUnreadable: false, savedInCms: false });
    await expect(storeAffiliatePayPalCredentials({ environment: 'live', clientId: 'NewClient12345678', secret: 's' })).rejects.toThrow();
    expect(mocks.reads).toBe(0);
    expect(mocks.upserts).toEqual([]);
  });
});

describe('resolving', () => {
  it('defaults to the sandbox environment and its env pair', async () => {
    vi.stubEnv('PAYPAL_CLIENT_ID', 'EnvSandboxClient1234');
    vi.stubEnv('PAYPAL_SECRET_KEY', 'env-sandbox-secret');
    expect(await resolveAffiliatePayPalEnvironment()).toEqual({ environment: 'sandbox', source: 'default' });
    expect(await resolveAffiliatePayPalCredentials()).toEqual({
      environment: 'sandbox',
      clientId: 'EnvSandboxClient1234',
      secret: 'env-sandbox-secret',
      source: 'env',
    });
    expect(await resolveAffiliatePayPalCredentials('live')).toBeNull();
  });

  it('takes PAYPAL_ENVIRONMENT=live and the live env pair', async () => {
    vi.stubEnv('PAYPAL_ENVIRONMENT', 'LIVE');
    vi.stubEnv('PAYPAL_LIVE_CLIENT_ID', 'EnvLiveClient987654');
    vi.stubEnv('PAYPAL_LIVE_SECRET_KEY', 'env-live-secret');
    expect(await resolveAffiliatePayPalEnvironment()).toEqual({ environment: 'live', source: 'env' });
    expect(await resolveAffiliatePayPalCredentials()).toMatchObject({ environment: 'live', clientId: 'EnvLiveClient987654', source: 'env' });
  });

  it('lets the CMS row win over the environment variables', async () => {
    vi.stubEnv('PAYPAL_ENVIRONMENT', 'sandbox');
    vi.stubEnv('PAYPAL_LIVE_CLIENT_ID', 'EnvLiveClient987654');
    vi.stubEnv('PAYPAL_LIVE_SECRET_KEY', 'env-live-secret');
    mocks.row = { environment: 'live', live: { clientId: 'CmsLiveClient5678', secret: enc('cms-live-secret') } };
    expect(await resolveAffiliatePayPalEnvironment()).toEqual({ environment: 'live', source: 'cms' });
    expect(await resolveAffiliatePayPalCredentials()).toEqual({
      environment: 'live',
      clientId: 'CmsLiveClient5678',
      secret: 'cms-live-secret',
      source: 'cms',
    });
  });

  it('falls back to the env pair when the saved secret cannot be decrypted, and says so', async () => {
    vi.stubEnv('PAYPAL_CLIENT_ID', 'EnvSandboxClient1234');
    vi.stubEnv('PAYPAL_SECRET_KEY', 'env-sandbox-secret');
    mocks.row = { environment: 'sandbox', sandbox: { clientId: 'CmsSandboxClient42', secret: { v: 1, ct: 'garbage' } } };
    expect(await resolveAffiliatePayPalCredentials()).toMatchObject({ source: 'env', clientId: 'EnvSandboxClient1234' });
    const status = await getAffiliatePayPalCredentialStatus();
    expect(status.active).toMatchObject({ configured: true, source: 'env', storedSecretUnreadable: true, savedInCms: true });
  });

  it('ignores a stored client id of the wrong shape', async () => {
    mocks.row = { environment: 'sandbox', sandbox: { clientId: 'has spaces!', secret: enc('cms-secret', 'sandbox') } };
    expect(await resolveAffiliatePayPalCredentials()).toBeNull();
  });
});

describe('slot binding (02038)', () => {
  it('never opens a secret sealed for the sandbox as the live one, and reports it unreadable', async () => {
    mocks.row = { environment: 'live', live: { clientId: 'CmsLiveClient5678', secret: enc('cms-sandbox-secret', 'sandbox') } };
    const resolved = await resolveAffiliatePayPalCredentials('live');
    expect(resolved?.secret).not.toBe('cms-sandbox-secret');
    const status = await getAffiliatePayPalCredentialStatus();
    expect(JSON.stringify(status)).not.toContain('cms-sandbox-secret');
  });
});

describe('the status the CMS sees', () => {
  it('shows the environment, the source and the last 4 characters of the client id, never a secret', async () => {
    vi.stubEnv('PAYPAL_CLIENT_ID', 'EnvSandboxClient1234');
    vi.stubEnv('PAYPAL_SECRET_KEY', 'env-sandbox-secret');
    mocks.row = { environment: 'live', live: { clientId: 'CmsLiveClient5678', secret: enc('cms-live-secret') } };
    const status = await getAffiliatePayPalCredentialStatus();
    expect(status).toMatchObject({ sandbox: false, environment: 'live', environmentSource: 'cms' });
    expect(status.active).toEqual({ configured: true, source: 'cms', clientIdLast4: '5678', storedSecretUnreadable: false, savedInCms: true });
    expect(status.environments.sandbox).toMatchObject({ configured: true, source: 'env', clientIdLast4: '1234', savedInCms: false });
    const text = JSON.stringify(status);
    for (const secret of ['cms-live-secret', 'env-sandbox-secret', 'CmsLiveClient5678', 'EnvSandboxClient1234', 'enc:']) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('saving', () => {
  it('needs an ADMIN before it reads or writes anything', async () => {
    mocks.requireCmsAdmin.mockRejectedValue(new Error('Forbidden'));
    await expect(storeAffiliatePayPalCredentials({ environment: 'live', clientId: 'CmsLiveClient5678', secret: 'cms-live-secret' })).rejects.toThrow(
      'Forbidden'
    );
    expect(mocks.reads).toBe(0);
    expect(mocks.upserts).toEqual([]);
  });

  it('stores the secret encrypted, makes the environment active and keeps the other environment', async () => {
    mocks.row = { environment: 'sandbox', sandbox: { clientId: 'CmsSandboxClient42', secret: enc('cms-sandbox-secret', 'sandbox') } };
    await storeAffiliatePayPalCredentials({ environment: 'live', clientId: ' CmsLiveClient5678 ', secret: ' cms-live-secret ' });
    expect(mocks.requireCmsAdmin).toHaveBeenCalledTimes(1);
    expect(mocks.upserts).toHaveLength(1);
    const saved = mocks.upserts[0] as { key: string; value: Record<string, any> };
    expect(saved.key).toBe('affiliates_paypal_secret');
    expect(saved.value['environment']).toBe('live');
    expect(saved.value['live']).toEqual({ clientId: 'CmsLiveClient5678', secret: enc('cms-live-secret') });
    expect(saved.value['sandbox']).toEqual({ clientId: 'CmsSandboxClient42', secret: enc('cms-sandbox-secret', 'sandbox') });
    expect(JSON.stringify(saved)).not.toContain('cms-live-secret');
    // The cache was dropped: the next read sees the new pair.
    expect(await resolveAffiliatePayPalCredentials()).toMatchObject({ environment: 'live', secret: 'cms-live-secret', source: 'cms' });
  });

  it('keeps the saved client id and secret when the fields are blank, and refuses a bad client id', async () => {
    mocks.row = { environment: 'sandbox', sandbox: { clientId: 'CmsSandboxClient42', secret: enc('cms-sandbox-secret', 'sandbox') } };
    await storeAffiliatePayPalCredentials({ environment: 'sandbox', clientId: '', secret: '' });
    expect((mocks.upserts[0] as { value: Record<string, any> }).value['sandbox']).toEqual({
      clientId: 'CmsSandboxClient42',
      secret: enc('cms-sandbox-secret', 'sandbox'),
    });
    await expect(storeAffiliatePayPalCredentials({ environment: 'sandbox', clientId: 'bad id!', secret: '' })).rejects.toThrow();
    await expect(storeAffiliatePayPalCredentials({ environment: 'staging' as never })).rejects.toThrow();
  });
});

describe('the pair a save would verify', () => {
  it('uses the typed pair, else the saved values of that environment, else the env pair', async () => {
    vi.stubEnv('PAYPAL_CLIENT_ID', 'EnvSandboxClient1234');
    vi.stubEnv('PAYPAL_SECRET_KEY', 'env-sandbox-secret');
    expect(await previewAffiliatePayPalCredentials({ environment: 'live', clientId: 'TypedLiveClient999', secret: 'typed' })).toEqual({
      environment: 'live',
      clientId: 'TypedLiveClient999',
      secret: 'typed',
    });
    expect(await previewAffiliatePayPalCredentials({ environment: 'sandbox' })).toEqual({
      environment: 'sandbox',
      clientId: 'EnvSandboxClient1234',
      secret: 'env-sandbox-secret',
    });
    mocks.row = { environment: 'sandbox', live: { clientId: 'CmsLiveClient5678', secret: enc('cms-live-secret') } };
    clearAffiliatePayPalCredentialsCache();
    expect(await previewAffiliatePayPalCredentials({ environment: 'live', clientId: 'NewLiveClient00001' })).toEqual({
      environment: 'live',
      clientId: 'NewLiveClient00001',
      secret: 'cms-live-secret',
    });
    // A typed client id with no secret anywhere for that environment: nothing to verify.
    expect(await previewAffiliatePayPalCredentials({ environment: 'sandbox', clientId: 'OnlyClient123456' })).toBeNull();
  });
});
