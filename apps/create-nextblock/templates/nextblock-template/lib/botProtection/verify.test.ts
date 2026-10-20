import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The verifier is the runtime reader of `bot_protection_secret`. Once the row is
 * envelope-encrypted it has to decrypt before calling the provider, keep honouring a
 * pre-encryption plaintext row, and fall back to env (without leaking anything) when the
 * stored envelope cannot be opened.
 */

const mocks = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  fetch: vi.fn(),
}));

vi.mock('@nextblock-cms/db/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@nextblock-cms/db/server')>()),
  getServiceRoleSupabaseClient: () => ({
    from: () => ({
      select: () => ({
        eq: (_column: string, key: string) => ({
          maybeSingle: async () => ({
            data: mocks.settings.has(key) ? { value: mocks.settings.get(key) } : null,
            error: null,
          }),
        }),
      }),
    }),
  }),
}));

import { encryptSecret } from '@nextblock-cms/db/server';
import { TURNSTILE_TOKEN_FIELD, verifyBotProtection } from './verify';

const ENV_KEYS = [
  'NEXTBLOCK_ENCRYPTION_KEY',
  'CORTEX_AI_ENCRYPTION_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SECRET_KEY',
  'TURNSTILE_SECRET_KEY',
  'RECAPTCHA_SECRET_KEY',
] as const;
const TEST_KEY = 'bot-protection-verify-test-key';
const SECRET = '0x4AAAAAAABotRedteamTURNSTILE_secret_XYZ';

function turnstileSubmission(): FormData {
  const formData = new FormData();
  formData.set(TURNSTILE_TOKEN_FIELD, 'turnstile-token');
  return formData;
}

function siteverifyBody(): string {
  const [, init] = mocks.fetch.mock.calls[0] as [string, { body: string }];
  return init.body;
}

describe('verifyBotProtection secret resolution', () => {
  const original: Record<string, string | undefined> = {};
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      original[key] = process.env[key];
      delete process.env[key];
    }
    process.env['NEXTBLOCK_ENCRYPTION_KEY'] = TEST_KEY;

    mocks.settings.clear();
    mocks.settings.set('bot_protection_public', { provider: 'turnstile', siteKey: 'site-key' });
    mocks.fetch.mockReset();
    mocks.fetch.mockResolvedValue({ json: async () => ({ success: true }) });
    vi.stubGlobal('fetch', mocks.fetch);
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    consoleError.mockRestore();
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  it('decrypts the stored envelope and sends the plaintext to siteverify', async () => {
    mocks.settings.set('bot_protection_secret', {
      secretKey: encryptSecret({ value: SECRET, encryptionSecret: TEST_KEY }),
    });

    await expect(verifyBotProtection(turnstileSubmission())).resolves.toEqual({ ok: true });

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch.mock.calls[0][0]).toContain('challenges.cloudflare.com');
    expect(siteverifyBody()).toContain(`secret=${encodeURIComponent(SECRET)}`);
  });

  it('still honours a pre-encryption plaintext row', async () => {
    mocks.settings.set('bot_protection_secret', { secretKey: SECRET });

    await expect(verifyBotProtection(turnstileSubmission())).resolves.toEqual({ ok: true });
    expect(siteverifyBody()).toContain(`secret=${encodeURIComponent(SECRET)}`);
  });

  it('falls back to the env secret when the stored envelope cannot be opened, without leaking it', async () => {
    mocks.settings.set('bot_protection_secret', {
      secretKey: encryptSecret({ value: SECRET, encryptionSecret: 'a-rotated-away-key' }),
    });
    process.env['TURNSTILE_SECRET_KEY'] = 'env-turnstile-secret';

    await expect(verifyBotProtection(turnstileSubmission())).resolves.toEqual({ ok: true });

    expect(siteverifyBody()).toContain(`secret=${encodeURIComponent('env-turnstile-secret')}`);
    expect(siteverifyBody()).not.toContain(encodeURIComponent(SECRET));
    expect(consoleError).toHaveBeenCalled();
    const logged = consoleError.mock.calls
      .map((call: unknown[]) => call.map(String).join(' '))
      .join('\n');
    expect(logged).toMatch(/cannot be decrypted/i);
    expect(logged).not.toContain(SECRET);
  });

  it('reports a misconfiguration when neither the row nor env yields a usable secret', async () => {
    mocks.settings.set('bot_protection_secret', {
      secretKey: encryptSecret({ value: SECRET, encryptionSecret: 'a-rotated-away-key' }),
    });

    const result = await verifyBotProtection(turnstileSubmission());

    expect(result).toEqual({
      ok: false,
      reason: 'captcha',
      message: expect.stringMatching(/misconfigured/i),
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
