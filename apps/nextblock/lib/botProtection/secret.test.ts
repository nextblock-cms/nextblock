import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import {
  encryptSecret,
  isEncryptedSecretEnvelope,
  siteSettingSecretSlot,
  tryDecryptWithEnvKey,
} from '@nextblock-cms/db/server';

import {
  buildBotProtectionSecretValue,
  readStoredBotProtectionSecret,
  resealStoredBotProtectionSecret,
} from './secret';

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
/** Where the captcha secret lives; an envelope sealed for any other slot does not open there. */
const BOT_SLOT = siteSettingSecretSlot('bot_protection_secret', 'secretKey');
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
      secretKey: encryptSecret({ value: SECRET, encryptionSecret: 'another-installs-key', slot: BOT_SLOT }),
    };

    expect(readStoredBotProtectionSecret(foreign)).toEqual({ secretKey: '', storage: 'unreadable' });
  });

  it('seals the secret for its own field, and never opens an envelope copied in from another row', () => {
    const value = buildBotProtectionSecretValue(SECRET);
    expect(tryDecryptWithEnvKey(value.secretKey, BOT_SLOT)).toBe(SECRET);
    expect(tryDecryptWithEnvKey(value.secretKey, siteSettingSecretSlot('email_secret', 'pass'))).toBeNull();

    // 2026-11-04: the CMS form shows this secret in clear, so the Stripe key's envelope copied
    // here would have been a way to read it.
    const stripe = {
      secretKey: encryptSecret({
        value: 'sk_live_victim',
        encryptionSecret: TEST_KEY,
        slot: siteSettingSecretSlot('payment_secret', 'stripeSecretKey'),
      }),
    };
    expect(readStoredBotProtectionSecret(stripe)).toEqual({ secretKey: '', storage: 'unreadable' });
  });

  it('re-seals an envelope from before 0.23.1 for its field, and nothing else', () => {
    const legacy = { secretKey: legacyEnvelope(SECRET, TEST_KEY) };
    expect(readStoredBotProtectionSecret(legacy)).toEqual({ secretKey: SECRET, storage: 'encrypted' });

    const resealed = resealStoredBotProtectionSecret(legacy);
    expect(resealed?.secretKey.version).toBe(2);
    expect(tryDecryptWithEnvKey(resealed?.secretKey, BOT_SLOT)).toBe(SECRET);

    expect(resealStoredBotProtectionSecret(buildBotProtectionSecretValue(SECRET))).toBeNull();
    expect(resealStoredBotProtectionSecret({ secretKey: SECRET })).toBeNull();
    expect(resealStoredBotProtectionSecret(undefined)).toBeNull();
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
