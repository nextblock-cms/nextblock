import { describe, expect, it } from 'vitest';

import { siteSettingSecretSlot } from '@nextblock-cms/db/secrets';

import {
  CORTEX_AI_KEY_ENVELOPE_VERSION,
  decryptOpenRouterApiKey,
  encryptOpenRouterApiKey,
  getMaskedOpenRouterKey,
  getOpenRouterKeyEnvelopeStatus,
} from './ai-key-crypto';

describe('Cortex AI OpenRouter key crypto', () => {
  const apiKey = 'sk-or-v1-test-secret-1234567890';
  const encryptionSecret = 'local-test-encryption-secret';
  const slot = siteSettingSecretSlot('cortex_ai_openrouter_api_key');

  it('encrypts and decrypts an OpenRouter key', () => {
    const encryptedKey = encryptOpenRouterApiKey({
      apiKey,
      encryptionSecret,
      slot,
      now: new Date('2026-04-27T12:00:00.000Z'),
    });

    expect(encryptedKey.version).toBe(CORTEX_AI_KEY_ENVELOPE_VERSION);
    expect(decryptOpenRouterApiKey({ encryptedKey, encryptionSecret, slot })).toBe(apiKey);
  });

  it('does not store the raw key in the encrypted payload', () => {
    const encryptedKey = encryptOpenRouterApiKey({
      apiKey,
      encryptionSecret,
      slot,
    });

    expect(JSON.stringify(encryptedKey)).not.toContain(apiKey);
    expect(encryptedKey.last4).toBe('7890');
  });

  it('opens a key only from the row it was sealed for (2026-11-04)', () => {
    const encryptedKey = encryptOpenRouterApiKey({ apiKey, encryptionSecret, slot });

    for (const other of [
      siteSettingSecretSlot('cortex_ai_pexels_api_key'),
      siteSettingSecretSlot('cortex_ai_unsplash_access_key'),
      siteSettingSecretSlot('email_secret', 'pass'),
    ]) {
      expect(() => decryptOpenRouterApiKey({ encryptedKey, encryptionSecret, slot: other })).toThrow(
        'Failed to decrypt stored OpenRouter key.'
      );
    }
  });

  it('fails safely when the encryption secret is wrong or missing', () => {
    const encryptedKey = encryptOpenRouterApiKey({
      apiKey,
      encryptionSecret,
      slot,
    });

    expect(() =>
      decryptOpenRouterApiKey({
        encryptedKey,
        encryptionSecret: 'wrong-secret',
        slot,
      })
    ).toThrow('Failed to decrypt stored OpenRouter key.');

    expect(() =>
      encryptOpenRouterApiKey({
        apiKey,
        encryptionSecret: '',
        slot,
      })
    ).toThrow('CORTEX_AI_ENCRYPTION_KEY is required');
  });

  it('never seals a key without its row', () => {
    expect(() => encryptOpenRouterApiKey({ apiKey, encryptionSecret } as never)).toThrow('siteSettingSecretSlot');
  });

  it('reports masked stored key status', () => {
    const encryptedKey = encryptOpenRouterApiKey({
      apiKey,
      encryptionSecret,
      slot,
      now: new Date('2026-04-27T12:00:00.000Z'),
    });

    expect(getMaskedOpenRouterKey(encryptedKey.last4)).toBe('**** 7890');
    expect(getOpenRouterKeyEnvelopeStatus(encryptedKey)).toEqual({
      hasStoredKey: true,
      last4: '7890',
      maskedKey: '**** 7890',
      updatedAt: '2026-04-27T12:00:00.000Z',
    });
    // A key stored before 0.23.1 (version 1) still counts as stored.
    expect(getOpenRouterKeyEnvelopeStatus({ ...encryptedKey, version: 1 }).hasStoredKey).toBe(true);
    expect(getOpenRouterKeyEnvelopeStatus({ ...encryptedKey, version: 3 }).hasStoredKey).toBe(false);
  });
});
