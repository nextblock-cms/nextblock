import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LEGACY_SECRET_ENVELOPE_VERSION,
  SECRET_ENVELOPE_VERSION,
  decryptSecret,
  decryptWithEnvKey,
  encryptSecret,
  encryptWithEnvKey,
  getSecretEnvelopeStatus,
  isEncryptedSecretEnvelope,
  resealWithEnvKey,
  resolveSecretEncryptionKey,
  siteSettingSecretSlot,
  tryDecryptWithEnvKey,
  type SecretSlot,
} from './secret-crypto';

const SECRET = 'unit-test-encryption-secret';
const EMAIL_USER = siteSettingSecretSlot('email_secret', 'user');
const EMAIL_PASS = siteSettingSecretSlot('email_secret', 'pass');
const STRIPE_SECRET = siteSettingSecretSlot('payment_secret', 'stripeSecretKey');
const OPENROUTER = siteSettingSecretSlot('cortex_ai_openrouter_api_key');

/** An envelope exactly as 0.23.0 and earlier wrote it: version 1, no associated data. */
function legacyEnvelope(value: string, encryptionSecret: string) {
  const key = createHash('sha256').update(encryptionSecret.trim()).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    algorithm: 'aes-256-gcm' as const,
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    last4: value.slice(-4),
    updatedAt: '2026-01-02T03:04:05.000Z',
    version: 1 as const,
  };
}

describe('secret-crypto', () => {
  it('round-trips a value through encrypt/decrypt in its slot', () => {
    const envelope = encryptSecret({ value: 'sk_live_abcd1234', encryptionSecret: SECRET, slot: STRIPE_SECRET });
    expect(isEncryptedSecretEnvelope(envelope)).toBe(true);
    expect(envelope.version).toBe(SECRET_ENVELOPE_VERSION);
    expect(envelope.last4).toBe('1234');
    expect(envelope.ciphertext).not.toContain('sk_live');
    expect(decryptSecret({ envelope, encryptionSecret: SECRET, slot: STRIPE_SECRET })).toBe('sk_live_abcd1234');
  });

  it('fails to decrypt with the wrong key', () => {
    const envelope = encryptSecret({ value: 'whsec_topsecret', encryptionSecret: SECRET, slot: STRIPE_SECRET });
    expect(() => decryptSecret({ envelope, encryptionSecret: 'a-different-key', slot: STRIPE_SECRET })).toThrow();
  });

  it('rejects a tampered ciphertext (GCM auth tag)', () => {
    const envelope = encryptSecret({ value: 'whsec_topsecret', encryptionSecret: SECRET, slot: STRIPE_SECRET });
    const tampered = { ...envelope, ciphertext: Buffer.from('garbage').toString('base64') };
    expect(() => decryptSecret({ envelope: tampered, encryptionSecret: SECRET, slot: STRIPE_SECRET })).toThrow();
  });

  it('reports envelope status without exposing plaintext', () => {
    const envelope = encryptSecret({ value: 'token-9999', encryptionSecret: SECRET, slot: EMAIL_PASS });
    const status = getSecretEnvelopeStatus(envelope);
    expect(status.hasStoredValue).toBe(true);
    expect(status.last4).toBe('9999');
    expect(status.maskedValue).toContain('9999');
    expect(getSecretEnvelopeStatus({ not: 'an envelope' }).hasStoredValue).toBe(false);
    expect(getSecretEnvelopeStatus(legacyEnvelope('token-1111', SECRET)).hasStoredValue).toBe(true);
  });

  describe('slot binding (2026-11-04: envelopes copied between site_settings rows)', () => {
    it('an envelope copied into another row does not open there', () => {
      // The attack: payment_secret.stripeSecretKey copied into email_secret.pass, then sent out
      // through SMTP AUTH to a host of the attacker's choosing.
      const stripe = encryptSecret({ value: 'sk_live_victim', encryptionSecret: SECRET, slot: STRIPE_SECRET });
      expect(() => decryptSecret({ envelope: stripe, encryptionSecret: SECRET, slot: EMAIL_PASS })).toThrow(
        'Failed to decrypt stored secret.'
      );
      expect(decryptSecret({ envelope: stripe, encryptionSecret: SECRET, slot: STRIPE_SECRET })).toBe('sk_live_victim');
    });

    it('nor in another field of the same row, nor where the row value is the envelope', () => {
      const pass = encryptSecret({ value: 'smtp-pass', encryptionSecret: SECRET, slot: EMAIL_PASS });
      expect(() => decryptSecret({ envelope: pass, encryptionSecret: SECRET, slot: EMAIL_USER })).toThrow();
      const openrouter = encryptSecret({ value: 'sk-or-v1-key', encryptionSecret: SECRET, slot: OPENROUTER });
      expect(() =>
        decryptSecret({ envelope: openrouter, encryptionSecret: SECRET, slot: siteSettingSecretSlot('cortex_ai_pexels_api_key') })
      ).toThrow();
      expect(() =>
        decryptSecret({ envelope: openrouter, encryptionSecret: SECRET, slot: siteSettingSecretSlot('cortex_ai_openrouter_api_key', 'value') })
      ).toThrow();
    });

    it('relabelling a version 2 envelope as version 1 does not drop the binding', () => {
      const stripe = encryptSecret({ value: 'sk_live_victim', encryptionSecret: SECRET, slot: STRIPE_SECRET });
      const downgraded = { ...stripe, version: LEGACY_SECRET_ENVELOPE_VERSION };
      expect(isEncryptedSecretEnvelope(downgraded)).toBe(true);
      expect(() => decryptSecret({ envelope: downgraded, encryptionSecret: SECRET, slot: EMAIL_PASS })).toThrow();
      expect(() => decryptSecret({ envelope: downgraded, encryptionSecret: SECRET, slot: STRIPE_SECRET })).toThrow();
    });

    it('refuses a truncated auth tag', () => {
      const envelope = encryptSecret({ value: 'whsec_topsecret', encryptionSecret: SECRET, slot: STRIPE_SECRET });
      const shortTag = { ...envelope, authTag: Buffer.from(envelope.authTag, 'base64').subarray(0, 4).toString('base64') };
      expect(() => decryptSecret({ envelope: shortTag, encryptionSecret: SECRET, slot: STRIPE_SECRET })).toThrow();
    });

    it('still opens a version 1 envelope (written before 0.23.1)', () => {
      const legacy = legacyEnvelope('smtp-password', SECRET);
      expect(isEncryptedSecretEnvelope(legacy)).toBe(true);
      expect(decryptSecret({ envelope: legacy, encryptionSecret: SECRET, slot: EMAIL_PASS })).toBe('smtp-password');
    });

    it('never writes an envelope without a slot', () => {
      expect(() => encryptSecret({ value: 'x', encryptionSecret: SECRET } as never)).toThrow('siteSettingSecretSlot');
      expect(() =>
        encryptSecret({ value: 'x', encryptionSecret: SECRET, slot: 'email_secret.pass' as SecretSlot })
      ).toThrow('siteSettingSecretSlot');
      expect(() => siteSettingSecretSlot('email_secret', 'pass:x')).toThrow();
      expect(() => siteSettingSecretSlot('', 'pass')).toThrow();
      expect(EMAIL_PASS).toBe('site_settings:email_secret:pass');
      expect(OPENROUTER).toBe('site_settings:cortex_ai_openrouter_api_key');
    });

    it('a caller compiled before 0.23.1 (no slot) reads version 1 only', () => {
      const legacy = legacyEnvelope('smtp-password', SECRET);
      const bound = encryptSecret({ value: 'smtp-password', encryptionSecret: SECRET, slot: EMAIL_PASS });
      const noSlot = undefined as unknown as SecretSlot;
      expect(decryptSecret({ envelope: legacy, encryptionSecret: SECRET, slot: noSlot })).toBe('smtp-password');
      expect(() => decryptSecret({ envelope: bound, encryptionSecret: SECRET, slot: noSlot })).toThrow();
    });

    it('accepts only the two known versions', () => {
      const envelope = encryptSecret({ value: 'x1234', encryptionSecret: SECRET, slot: EMAIL_PASS });
      expect(isEncryptedSecretEnvelope({ ...envelope, version: 3 })).toBe(false);
      expect(isEncryptedSecretEnvelope({ ...envelope, algorithm: 'aes-128-gcm' })).toBe(false);
    });
  });

  describe('env-key layer', () => {
    const KEYS = [
      'NEXTBLOCK_ENCRYPTION_KEY',
      'CORTEX_AI_ENCRYPTION_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_SECRET_KEY',
    ] as const;
    const original: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const k of KEYS) {
        original[k] = process.env[k];
        delete process.env[k];
      }
    });

    afterEach(() => {
      for (const k of KEYS) {
        if (original[k] === undefined) delete process.env[k];
        else process.env[k] = original[k];
      }
    });

    it('prefers NEXTBLOCK_ENCRYPTION_KEY, falls back to CORTEX_AI_ENCRYPTION_KEY', () => {
      process.env['CORTEX_AI_ENCRYPTION_KEY'] = 'cortex-key';
      expect(resolveSecretEncryptionKey()).toBe('cortex-key');
      process.env['NEXTBLOCK_ENCRYPTION_KEY'] = 'nextblock-key';
      expect(resolveSecretEncryptionKey()).toBe('nextblock-key');
    });

    it('encryptWithEnvKey/decryptWithEnvKey round-trip using the env key', () => {
      process.env['CORTEX_AI_ENCRYPTION_KEY'] = 'cortex-key';
      const envelope = encryptWithEnvKey('pi_secret_value', STRIPE_SECRET);
      expect(envelope.version).toBe(SECRET_ENVELOPE_VERSION);
      expect(decryptWithEnvKey(envelope, STRIPE_SECRET)).toBe('pi_secret_value');
    });

    it('derives a stable key from the service-role key when no explicit key is set', () => {
      process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'service-role-secret';
      const derived = resolveSecretEncryptionKey();
      expect(derived).toBeTruthy();
      // Stable: same service key -> same derived key.
      expect(resolveSecretEncryptionKey()).toBe(derived);
      const envelope = encryptWithEnvKey('smtp-password', EMAIL_PASS);
      expect(decryptWithEnvKey(envelope, EMAIL_PASS)).toBe('smtp-password');
    });

    it('still decrypts a derived-key secret after an explicit key is added later', () => {
      process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'service-role-secret';
      const envelope = encryptWithEnvKey('smtp-password', EMAIL_PASS); // encrypted with derived key
      // Operator later adds an explicit key — it becomes preferred for encryption...
      process.env['NEXTBLOCK_ENCRYPTION_KEY'] = 'explicit-key';
      expect(resolveSecretEncryptionKey()).toBe('explicit-key');
      // ...but the old secret is still readable because decryption tries all candidates.
      expect(tryDecryptWithEnvKey(envelope, EMAIL_PASS)).toBe('smtp-password');
    });

    it('tryDecryptWithEnvKey returns null instead of throwing when no key is set', () => {
      const envelope = encryptSecret({ value: 'x', encryptionSecret: SECRET, slot: EMAIL_PASS });
      expect(tryDecryptWithEnvKey(envelope, EMAIL_PASS)).toBeNull();
      expect(tryDecryptWithEnvKey({ junk: true }, EMAIL_PASS)).toBeNull();
    });

    it('tryDecryptWithEnvKey returns null for another slot under every candidate key', () => {
      process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'service-role-secret';
      process.env['NEXTBLOCK_ENCRYPTION_KEY'] = 'explicit-key';
      const stripe = encryptWithEnvKey('sk_live_victim', STRIPE_SECRET);
      expect(tryDecryptWithEnvKey(stripe, EMAIL_PASS)).toBeNull();
      expect(tryDecryptWithEnvKey(stripe, EMAIL_USER)).toBeNull();
      expect(tryDecryptWithEnvKey(stripe, STRIPE_SECRET)).toBe('sk_live_victim');
      expect(() => tryDecryptWithEnvKey(stripe, 'payment_secret' as SecretSlot)).toThrow('siteSettingSecretSlot');
    });

    describe('resealWithEnvKey', () => {
      it('seals a version 1 envelope for its slot, keeping the plaintext, last4 and updatedAt', () => {
        process.env['NEXTBLOCK_ENCRYPTION_KEY'] = 'explicit-key';
        const legacy = legacyEnvelope('smtp-password', 'explicit-key');
        const resealed = resealWithEnvKey(legacy, EMAIL_PASS);
        expect(isEncryptedSecretEnvelope(resealed)).toBe(true);
        const envelope = resealed as ReturnType<typeof encryptWithEnvKey>;
        expect(envelope.version).toBe(SECRET_ENVELOPE_VERSION);
        expect(envelope.last4).toBe('word');
        expect(envelope.updatedAt).toBe(legacy.updatedAt);
        expect(envelope.ciphertext).not.toBe(legacy.ciphertext);
        expect(tryDecryptWithEnvKey(envelope, EMAIL_PASS)).toBe('smtp-password');
        expect(tryDecryptWithEnvKey(envelope, STRIPE_SECRET)).toBeNull();
      });

      it('re-seals under the current key a version 1 envelope another candidate opens', () => {
        process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'service-role-secret';
        const derivedKey = resolveSecretEncryptionKey() as string;
        const legacy = legacyEnvelope('smtp-password', derivedKey);
        process.env['NEXTBLOCK_ENCRYPTION_KEY'] = 'explicit-key';
        const resealed = resealWithEnvKey(legacy, EMAIL_PASS);
        expect(decryptSecret({ envelope: resealed, encryptionSecret: 'explicit-key', slot: EMAIL_PASS })).toBe('smtp-password');
      });

      it('leaves everything else exactly as it was', () => {
        process.env['NEXTBLOCK_ENCRYPTION_KEY'] = 'explicit-key';
        const bound = encryptWithEnvKey('smtp-password', EMAIL_PASS);
        expect(resealWithEnvKey(bound, EMAIL_PASS)).toBe(bound);
        // Another slot's version 2 envelope: unreadable here, kept, never re-labelled.
        const stripe = encryptWithEnvKey('sk_live_victim', STRIPE_SECRET);
        expect(resealWithEnvKey(stripe, EMAIL_PASS)).toBe(stripe);
        const unreadable = legacyEnvelope('smtp-password', 'a-rotated-away-key');
        expect(resealWithEnvKey(unreadable, EMAIL_PASS)).toBe(unreadable);
        expect(resealWithEnvKey(undefined, EMAIL_PASS)).toBeUndefined();
        expect(resealWithEnvKey('plaintext', EMAIL_PASS)).toBe('plaintext');
      });
    });
  });
});
