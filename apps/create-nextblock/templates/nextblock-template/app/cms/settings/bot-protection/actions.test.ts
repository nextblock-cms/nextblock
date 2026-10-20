import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The bot-protection settings action is the writer of `site_settings.bot_protection_secret`.
 * These tests pin what the red-team repro flagged: the row must hold an AES-GCM envelope
 * (the same one the SMTP password uses), never the Turnstile / reCAPTCHA secret in
 * cleartext, while the ADMIN form keeps reading the decrypted value and pre-encryption rows
 * migrate on their next save.
 *
 * Since migration 02023 the secret row is the ADMIN tier that `is_admin_mfa()` gates, so
 * every site_settings read and write here must go through the service-role client after the
 * caller's role is verified through the cookie session — the cookie client only ever serves
 * the actor's own profile row.
 */

const mocks = vi.hoisted(() => ({
  user: { id: 'admin-1' } as { id: string } | null,
  role: 'ADMIN' as string | null,
  settings: new Map<string, unknown>(),
  upserts: [] as Array<{ key: string; value: unknown }>,
  cookieFrom: vi.fn(),
  serviceFrom: vi.fn(),
  revalidatePath: vi.fn(),
}));

// The real @nextblock-cms/db/server barrel (kept for its crypto) wraps a helper in
// unstable_cache at module scope, so the stub has to provide a pass-through for it too.
vi.mock('next/cache', () => ({
  revalidatePath: mocks.revalidatePath,
  unstable_cache: (fn: unknown) => fn,
}));

vi.mock('@nextblock-cms/db/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@nextblock-cms/db/server')>()),
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: mocks.user } }) },
    from: (table: string) => {
      mocks.cookieFrom(table);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: mocks.role ? { role: mocks.role } : null, error: null }),
          }),
        }),
      };
    },
  }),
  getServiceRoleSupabaseClient: () => ({
    from: (table: string) => {
      mocks.serviceFrom(table);
      return {
        select: () => ({
          eq: (_column: string, key: string) => ({
            maybeSingle: async () => ({
              data: mocks.settings.has(key) ? { value: mocks.settings.get(key) } : null,
              error: null,
            }),
          }),
        }),
        upsert: async (row: { key: string; value: unknown }) => {
          mocks.upserts.push(row);
          mocks.settings.set(row.key, row.value);
          return { error: null };
        },
      };
    },
  }),
}));

import { encryptSecret, isEncryptedSecretEnvelope, tryDecryptWithEnvKey } from '@nextblock-cms/db/server';
import { getBotProtectionSettings, updateBotProtectionSettings } from './actions';

const ENV_KEYS = [
  'NEXTBLOCK_ENCRYPTION_KEY',
  'CORTEX_AI_ENCRYPTION_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SECRET_KEY',
] as const;
const TEST_KEY = 'bot-protection-actions-test-key';
const SECRET = '0x4AAAAAAABotRedteamTURNSTILE_secret_XYZ';

function submission(secretKey: string): FormData {
  const formData = new FormData();
  formData.set('provider', 'turnstile');
  formData.set('siteKey', '0x4AAAAAAAB-site');
  formData.set('secretKey', secretKey);
  return formData;
}

function secretUpserts() {
  return mocks.upserts.filter((row) => row.key === 'bot_protection_secret');
}

describe('bot protection settings actions', () => {
  const original: Record<string, string | undefined> = {};
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      original[key] = process.env[key];
      delete process.env[key];
    }
    process.env['NEXTBLOCK_ENCRYPTION_KEY'] = TEST_KEY;

    mocks.user = { id: 'admin-1' };
    mocks.role = 'ADMIN';
    mocks.settings.clear();
    mocks.upserts.length = 0;
    mocks.cookieFrom.mockReset();
    mocks.serviceFrom.mockReset();
    mocks.revalidatePath.mockReset();
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  it('encrypts a submitted secret at rest and reads it back decrypted', async () => {
    const result = await updateBotProtectionSettings(submission(SECRET));
    expect(result).toEqual({ ok: true, message: expect.any(String) });

    const [row, ...rest] = secretUpserts();
    expect(rest).toHaveLength(0);
    const value = row.value as { secretKey: unknown };
    expect(isEncryptedSecretEnvelope(value.secretKey)).toBe(true);
    expect(JSON.stringify(row.value)).not.toContain(SECRET);
    expect(tryDecryptWithEnvKey(value.secretKey)).toBe(SECRET);

    // The public half is still plain JSON.
    expect(mocks.settings.get('bot_protection_public')).toEqual({
      provider: 'turnstile',
      siteKey: '0x4AAAAAAAB-site',
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/', 'layout');

    await expect(getBotProtectionSettings()).resolves.toEqual({
      provider: 'turnstile',
      siteKey: '0x4AAAAAAAB-site',
      secretKey: SECRET,
    });
  });

  it('reads and writes site_settings only through the service-role client (02023)', async () => {
    await updateBotProtectionSettings(submission(SECRET));
    await getBotProtectionSettings();

    // The cookie client serves the role check alone; every settings row (public and secret)
    // is read and written with the service role, or an aal1 admin sees and saves nothing.
    expect(mocks.cookieFrom.mock.calls.map((call) => call[0])).toEqual(['profiles', 'profiles']);
    expect(mocks.serviceFrom.mock.calls.map((call) => call[0]).every((t) => t === 'site_settings')).toBe(true);
    expect(mocks.serviceFrom).toHaveBeenCalled();
  });

  it('reads a pre-encryption plaintext row so the form keeps working', async () => {
    mocks.settings.set('bot_protection_public', { provider: 'recaptcha', siteKey: '6LdGP-site' });
    mocks.settings.set('bot_protection_secret', { secretKey: SECRET });

    await expect(getBotProtectionSettings()).resolves.toEqual({
      provider: 'recaptcha',
      siteKey: '6LdGP-site',
      secretKey: SECRET,
    });
  });

  it('re-encrypts a legacy plaintext row on the next save even when the field is empty', async () => {
    mocks.settings.set('bot_protection_secret', { secretKey: SECRET });

    const result = await updateBotProtectionSettings(submission(''));
    expect(result.ok).toBe(true);

    const [row] = secretUpserts();
    expect(row).toBeDefined();
    const value = row.value as { secretKey: unknown };
    expect(isEncryptedSecretEnvelope(value.secretKey)).toBe(true);
    expect(JSON.stringify(row.value)).not.toContain(SECRET);
    expect(tryDecryptWithEnvKey(value.secretKey)).toBe(SECRET);
  });

  it('leaves an already-encrypted secret untouched when the field is submitted empty', async () => {
    const envelope = encryptSecret({ value: SECRET, encryptionSecret: TEST_KEY });
    mocks.settings.set('bot_protection_secret', { secretKey: envelope });

    const result = await updateBotProtectionSettings(submission(''));
    expect(result.ok).toBe(true);

    expect(secretUpserts()).toHaveLength(0);
    expect(mocks.settings.get('bot_protection_secret')).toEqual({ secretKey: envelope });
    // The public half was still saved.
    expect(mocks.upserts.map((row) => row.key)).toEqual(['bot_protection_public']);
  });

  it('replaces the stored secret when a new one is submitted', async () => {
    mocks.settings.set('bot_protection_secret', {
      secretKey: encryptSecret({ value: 'old-secret', encryptionSecret: TEST_KEY }),
    });

    await updateBotProtectionSettings(submission(SECRET));

    const [row] = secretUpserts();
    expect(tryDecryptWithEnvKey((row.value as { secretKey: unknown }).secretKey)).toBe(SECRET);
  });

  it('fails the whole save, without logging the secret, when no encryption key is configured', async () => {
    delete process.env['NEXTBLOCK_ENCRYPTION_KEY'];

    const result = await updateBotProtectionSettings(submission(SECRET));

    expect(result).toEqual({ ok: false, error: expect.stringContaining('NEXTBLOCK_ENCRYPTION_KEY') });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    // Nothing was written: not the secret, and not the public half either.
    expect(mocks.upserts).toHaveLength(0);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
    const logged = consoleError.mock.calls
      .map((call: unknown[]) => call.map(String).join(' '))
      .join('\n');
    expect(logged).not.toContain(SECRET);
  });

  it('denies a non-admin before touching any row', async () => {
    mocks.role = 'WRITER';

    const result = await updateBotProtectionSettings(submission(SECRET));

    expect(result).toEqual({ ok: false, error: expect.stringMatching(/permission/i) });
    expect(mocks.upserts).toHaveLength(0);
    expect(mocks.serviceFrom).not.toHaveBeenCalled();
    await expect(getBotProtectionSettings()).rejects.toThrow('Forbidden');
  });

  it('denies an anonymous caller', async () => {
    mocks.user = null;

    const result = await updateBotProtectionSettings(submission(SECRET));

    expect(result).toEqual({ ok: false, error: expect.stringMatching(/logged in/i) });
    expect(mocks.upserts).toHaveLength(0);
    expect(mocks.serviceFrom).not.toHaveBeenCalled();
    await expect(getBotProtectionSettings()).rejects.toThrow('Unauthorized');
  });
});
