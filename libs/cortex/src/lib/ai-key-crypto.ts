import {
  SECRET_ENVELOPE_ALGORITHM,
  SECRET_ENVELOPE_VERSION,
  decryptSecret,
  encryptSecret,
  isEncryptedSecretEnvelope,
  type EncryptedSecretEnvelope,
  type SecretSlot,
} from '@nextblock-cms/db/secrets';

// Cortex AI's stored keys (OpenRouter BYOK, Pexels, Unsplash) use the same AES-256-GCM envelope
// as every other stored secret (libs/db secret-crypto). Since 0.23.1 each is sealed for its own
// site_settings row (`slot`) and opens nowhere else; a version 1 envelope from before still opens.

export const CORTEX_AI_KEY_ALGORITHM = SECRET_ENVELOPE_ALGORITHM;
/** The version new keys are sealed with (bound to their row). */
export const CORTEX_AI_KEY_ENVELOPE_VERSION = SECRET_ENVELOPE_VERSION;

export type EncryptedOpenRouterKeyEnvelope = EncryptedSecretEnvelope;

function requireEncryptionSecret(secret: string) {
  if (!secret.trim()) {
    throw new Error('CORTEX_AI_ENCRYPTION_KEY is required to manage stored OpenRouter keys.');
  }
}

export function getMaskedOpenRouterKey(last4?: string | null) {
  const normalizedLast4 = (last4 || '').trim();
  return normalizedLast4 ? `**** ${normalizedLast4}` : 'Stored key';
}

/** Seal a key for `slot`, the site_settings row it is stored in. */
export function encryptOpenRouterApiKey(params: {
  apiKey: string;
  encryptionSecret: string;
  slot: SecretSlot;
  now?: Date;
}): EncryptedOpenRouterKeyEnvelope {
  const apiKey = params.apiKey.trim();

  if (!apiKey) {
    throw new Error('OpenRouter API key is required.');
  }

  requireEncryptionSecret(params.encryptionSecret);

  return encryptSecret({
    value: apiKey,
    encryptionSecret: params.encryptionSecret,
    slot: params.slot,
    now: params.now,
  });
}

/** Open a key read from `slot`; an envelope sealed for another row fails like a wrong key. */
export function decryptOpenRouterApiKey(params: {
  encryptedKey: unknown;
  encryptionSecret: string;
  slot: SecretSlot;
}) {
  if (!isEncryptedSecretEnvelope(params.encryptedKey)) {
    throw new Error('Invalid encrypted OpenRouter key payload.');
  }

  requireEncryptionSecret(params.encryptionSecret);

  try {
    return decryptSecret({
      envelope: params.encryptedKey,
      encryptionSecret: params.encryptionSecret,
      slot: params.slot,
    });
  } catch {
    throw new Error('Failed to decrypt stored OpenRouter key.');
  }
}

export function getOpenRouterKeyEnvelopeStatus(value: unknown) {
  if (!isEncryptedSecretEnvelope(value)) {
    return {
      hasStoredKey: false,
      last4: null,
      maskedKey: null,
      updatedAt: null,
    };
  }

  const last4 = typeof value.last4 === 'string' ? value.last4 : '';
  const updatedAt = typeof value.updatedAt === 'string' ? value.updatedAt : '';

  return {
    hasStoredKey: true,
    last4: last4 || null,
    maskedKey: getMaskedOpenRouterKey(last4),
    updatedAt: updatedAt || null,
  };
}
