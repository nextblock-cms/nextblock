// lib/botProtection/secret.ts
//
// At-rest handling for the Turnstile / reCAPTCHA secret key kept in the ADMIN-only
// `site_settings.bot_protection_secret` row. The value is AES-256-GCM envelope-encrypted
// with the same env-derived key as the SMTP password and the Stripe keys (libs/db
// secret-crypto), so a DB dump or full-backup zip never holds it in cleartext.
//
// Rows written before encryption shipped hold `{ secretKey: "<plaintext>" }`. They are still
// honoured on read and re-encrypted the next time the settings are saved, so no migration
// or operator action is needed.
//
// Server-only: decrypting needs the root encryption key, which never reaches the browser.
import 'server-only';

import {
  encryptWithEnvKey,
  isEncryptedSecretEnvelope,
  tryDecryptWithEnvKey,
  type EncryptedSecretEnvelope,
} from '@nextblock-cms/db/server';

export const BOT_PROTECTION_SECRET_SETTING_KEY = 'bot_protection_secret';

export type BotProtectionSecretStorage =
  /** Envelope-encrypted and opened with one of the configured keys. */
  | 'encrypted'
  /** Pre-encryption row holding the raw secret; the next save re-encrypts it. */
  | 'legacy-plaintext'
  /** An envelope none of the configured keys can open (key rotated or missing). */
  | 'unreadable'
  /** No secret stored. */
  | 'none';

export type StoredBotProtectionSecret = {
  /** The usable plaintext secret, or '' when nothing usable is stored. */
  secretKey: string;
  storage: BotProtectionSecretStorage;
};

/** The JSON `value` shape of the `bot_protection_secret` row. */
export type BotProtectionSecretValue = { secretKey: EncryptedSecretEnvelope };

/**
 * Interpret the JSON `value` of the `bot_protection_secret` row: an envelope is decrypted,
 * a bare string is a legacy plaintext row, anything else means no secret. Never logs.
 */
export function readStoredBotProtectionSecret(value: unknown): StoredBotProtectionSecret {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)['secretKey']
      : undefined;

  if (isEncryptedSecretEnvelope(raw)) {
    const decrypted = tryDecryptWithEnvKey(raw);
    return decrypted !== null
      ? { secretKey: decrypted, storage: 'encrypted' }
      : { secretKey: '', storage: 'unreadable' };
  }

  if (typeof raw === 'string' && raw.trim()) {
    return { secretKey: raw.trim(), storage: 'legacy-plaintext' };
  }

  return { secretKey: '', storage: 'none' };
}

/**
 * The JSON `value` to store for a secret: the envelope, never the plaintext. Throws (with a
 * message that names the missing env key, not the secret) when no encryption key is set.
 */
export function buildBotProtectionSecretValue(secretKey: string): BotProtectionSecretValue {
  return { secretKey: encryptWithEnvKey(secretKey) };
}
