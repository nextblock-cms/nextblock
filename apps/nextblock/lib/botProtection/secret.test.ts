import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encryptSecret, isEncryptedSecretEnvelope } from '@nextblock-cms/db/server';

import { buildBotProtectionSecretValue, readStoredBotProtectionSecret } from './secret';

/**
 * The Turnstile / reCAPTCHA secret key used to be written to `site_settings` as raw
 * cleartext while every sibling provider secret was envelope-encrypted. These tests pin the
 * at-rest contract: the stored value is an envelope, legacy plaintext rows still read, and
 * nothing here ever surfaces the secret in an error.
 */

const ENV_KEYS = [
  'NEXTBLOCK_ENCRYPTION_KEY',
  'CORTEX_AI_ENCRYPTION_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SECRET_KEY',
] as const;
const TEST_KEY = 'bot-protection-unit-test-key';
const SECRET = '0x4AAAAAAABotRedteamTURNSTILE_secret_XYZ';

describe('bot protection secret at rest', () => {
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      original[key] = process.env[key];
      delete process.env[key];
    }
    process.env['NEXTBLOCK_ENCRYPTION_KEY'] = TEST_KEY;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  it('stores an envelope, never the plaintext, and reads it back decrypted', () => {
    const value = buildBotProtectionSecretValue(SECRET);

    expect(isEncryptedSecretEnvelope(value.secretKey)).toBe(true);
    expect(JSON.stringify(value)).not.toContain(SECRET);
    expect(readStoredBotProtectionSecret(value)).toEqual({
      secretKey: SECRET,
      storage: 'encrypted',
    });
  });

  it('still reads a pre-encryption plaintext row and flags it for re-encryption', () => {
    expect(readStoredBotProtectionSecret({ secretKey: SECRET })).toEqual({
      secretKey: SECRET,
      storage: 'legacy-plaintext',
    });
  });

  it('reports an envelope no configured key can open as unreadable, without the secret', () => {
    const foreign = {
      secretKey: encryptSecret({ value: SECRET, encryptionSecret: 'another-installs-key' }),
    };

    expect(readStoredBotProtectionSecret(foreign)).toEqual({ secretKey: '', storage: 'unreadable' });
  });

  it('treats a missing, empty or malformed row as no secret', () => {
    const none = { secretKey: '', storage: 'none' };

    expect(readStoredBotProtectionSecret(undefined)).toEqual(none);
    expect(readStoredBotProtectionSecret(null)).toEqual(none);
    expect(readStoredBotProtectionSecret({})).toEqual(none);
    expect(readStoredBotProtectionSecret({ secretKey: '' })).toEqual(none);
    expect(readStoredBotProtectionSecret({ secretKey: '   ' })).toEqual(none);
    expect(readStoredBotProtectionSecret({ secretKey: 42 })).toEqual(none);
    expect(readStoredBotProtectionSecret('not-an-object')).toEqual(none);
    expect(readStoredBotProtectionSecret([SECRET])).toEqual(none);
  });

  it('refuses to build a value without an encryption key and keeps the secret out of the error', () => {
    delete process.env['NEXTBLOCK_ENCRYPTION_KEY'];

    let thrown: unknown;
    try {
      buildBotProtectionSecretValue(SECRET);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/encryption key/i);
    expect((thrown as Error).message).not.toContain(SECRET);
  });
});
