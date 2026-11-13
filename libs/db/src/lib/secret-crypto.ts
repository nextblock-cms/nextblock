import 'server-only';

// Generic, server-only secret encryption for values stored in the database
// (SMTP password, Stripe/Freemius secret keys, ...). Mirrors the AES-256-GCM
// envelope used by Cortex AI's stored OpenRouter key, but provider-agnostic so
// both the app (encrypt on save) and libs/ecommerce (decrypt at runtime) can
// share one implementation.
//
// The root encryption key stays in an env var — it is the root of trust for all
// DB-stored secrets and cannot itself live in the DB (chicken-and-egg). Reads use
// bracket notation because libs/db sets noPropertyAccessFromIndexSignature.
//
// Every envelope is sealed for one slot: the row and field it is stored in
// (`site_settings:email_secret:pass`), passed to AES-GCM as associated data. A reader names
// its own slot, so an envelope copied from another row or field fails to open instead of
// handing its plaintext to the wrong consumer. Before 0.23.1 (version 1) envelopes carried no
// slot and opened anywhere: until the 2026-11-04 fix (migration 02038) an admin session could
// copy the Stripe key's envelope into the SMTP password over PostgREST, save its own SMTP
// host and receive the key through SMTP AUTH. Version 1 envelopes are still read, and each
// screen re-seals them as version 2 when it is saved (resealWithEnvKey).
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

export const SECRET_ENVELOPE_ALGORITHM = 'aes-256-gcm';
/** Every new envelope: sealed with its slot as associated data, opens only in that slot. */
export const SECRET_ENVELOPE_VERSION = 2;
/** Written before 0.23.1 without associated data: opens in any slot until it is re-sealed. */
export const LEGACY_SECRET_ENVELOPE_VERSION = 1;

export type SecretEnvelopeVersion =
  | typeof LEGACY_SECRET_ENVELOPE_VERSION
  | typeof SECRET_ENVELOPE_VERSION;

/** Encrypted-at-rest payload stored as a JSONB value in `site_settings`. */
export type EncryptedSecretEnvelope = {
  algorithm: typeof SECRET_ENVELOPE_ALGORITHM;
  authTag: string;
  ciphertext: string;
  iv: string;
  last4: string;
  updatedAt: string;
  version: SecretEnvelopeVersion;
};

/**
 * Where a stored secret lives: `site_settings:<key>` when the row's whole value is the envelope
 * (the Cortex AI keys), `site_settings:<key>:<field>` when it is one field of the row
 * (`email_secret.pass`). Build one with siteSettingSecretSlot(); the brand keeps an arbitrary
 * string out of the associated data.
 */
export type SecretSlot = string & { readonly __secretSlot: true };

const SLOT_PART = /^[A-Za-z0-9_]+$/;
const SLOT_FORMAT = /^site_settings:[A-Za-z0-9_]+(?::[A-Za-z0-9_]+)?$/;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/** The slot of a `site_settings` row (`field` omitted) or of one field of its JSON value. */
export function siteSettingSecretSlot(key: string, field?: string): SecretSlot {
  if (!SLOT_PART.test(key) || (field !== undefined && !SLOT_PART.test(field))) {
    throw new Error(
      'A secret slot names a site_settings key, and optionally a field, in letters, digits and underscores.'
    );
  }
  return (field === undefined ? `site_settings:${key}` : `site_settings:${key}:${field}`) as SecretSlot;
}

/** The associated data for `slot`. A missing or hand-written slot is a caller bug: throw. */
function slotData(slot: unknown): Buffer {
  if (typeof slot !== 'string' || !SLOT_FORMAT.test(slot)) {
    throw new Error('A secret slot built with siteSettingSecretSlot() is required.');
  }
  return Buffer.from(slot, 'utf8');
}

function deriveKey(secret: string): Buffer {
  const normalized = secret.trim();
  if (!normalized) {
    throw new Error('A non-empty encryption secret is required to manage stored secrets.');
  }
  return createHash('sha256').update(normalized).digest();
}

/** Type guard: is `value` a well-formed encrypted envelope? */
export function isEncryptedSecretEnvelope(value: unknown): value is EncryptedSecretEnvelope {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const envelope = value as Partial<EncryptedSecretEnvelope>;
  return (
    envelope.algorithm === SECRET_ENVELOPE_ALGORITHM &&
    (envelope.version === SECRET_ENVELOPE_VERSION ||
      envelope.version === LEGACY_SECRET_ENVELOPE_VERSION) &&
    typeof envelope.authTag === 'string' &&
    typeof envelope.ciphertext === 'string' &&
    typeof envelope.iv === 'string'
  );
}

function assertEnvelope(value: unknown): EncryptedSecretEnvelope {
  if (!isEncryptedSecretEnvelope(value)) {
    throw new Error('Invalid encrypted secret payload.');
  }
  const envelope = value as EncryptedSecretEnvelope;
  return {
    algorithm: envelope.algorithm,
    authTag: envelope.authTag,
    ciphertext: envelope.ciphertext,
    iv: envelope.iv,
    last4: typeof envelope.last4 === 'string' ? envelope.last4 : '',
    updatedAt: typeof envelope.updatedAt === 'string' ? envelope.updatedAt : '',
    version: envelope.version,
  };
}

export function encryptSecret(params: {
  value: string;
  encryptionSecret: string;
  /** The slot the envelope is stored in; it opens nowhere else. */
  slot: SecretSlot;
  now?: Date;
}): EncryptedSecretEnvelope {
  // Checked first: an unbound (version 1) envelope is never written again.
  const associatedData = slotData(params.slot);
  const plaintext = params.value.trim();
  if (!plaintext) {
    throw new Error('A non-empty value is required to encrypt a secret.');
  }

  const key = deriveKey(params.encryptionSecret);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(SECRET_ENVELOPE_ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  cipher.setAAD(associatedData);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    algorithm: SECRET_ENVELOPE_ALGORITHM,
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    last4: plaintext.slice(-4),
    updatedAt: (params.now ?? new Date()).toISOString(),
    version: SECRET_ENVELOPE_VERSION,
  };
}

export function decryptSecret(params: {
  envelope: unknown;
  encryptionSecret: string;
  /**
   * The slot the caller reads. A version 2 envelope sealed for any other slot fails to open; a
   * version 1 envelope (before 0.23.1) opens in any slot until its screen re-seals it.
   */
  slot: SecretSlot;
}): string {
  const envelope = assertEnvelope(params.envelope);
  // A compiled caller from before 0.23.1 passes no slot: it keeps reading version 1 envelopes
  // and never opens a version 2 one. TypeScript callers cannot omit it.
  const associatedData = params.slot === undefined ? null : slotData(params.slot);
  if (envelope.version === SECRET_ENVELOPE_VERSION && associatedData === null) {
    throw new Error('Failed to decrypt stored secret.');
  }
  const key = deriveKey(params.encryptionSecret);

  try {
    const decipher = createDecipheriv(
      SECRET_ENVELOPE_ALGORITHM,
      key,
      Buffer.from(envelope.iv, 'base64'),
      // A shorter tag would be accepted otherwise, and a forged one is cheaper to guess.
      { authTagLength: AUTH_TAG_LENGTH }
    );
    if (envelope.version === SECRET_ENVELOPE_VERSION && associatedData) {
      decipher.setAAD(associatedData);
    }
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));

    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('Failed to decrypt stored secret.');
  }
}

/** UI-safe masked display, e.g. "•••• 1234". */
export function getMaskedSecret(last4?: string | null): string {
  const normalized = (last4 ?? '').trim();
  return normalized ? `•••• ${normalized}` : 'Stored secret';
}

/** Summarize an envelope for the CMS without exposing the plaintext. */
export function getSecretEnvelopeStatus(value: unknown): {
  hasStoredValue: boolean;
  last4: string | null;
  maskedValue: string | null;
  updatedAt: string | null;
} {
  if (!isEncryptedSecretEnvelope(value)) {
    return { hasStoredValue: false, last4: null, maskedValue: null, updatedAt: null };
  }
  const envelope = value as EncryptedSecretEnvelope;
  const last4 = typeof envelope.last4 === 'string' && envelope.last4 ? envelope.last4 : null;
  return {
    hasStoredValue: true,
    last4,
    maskedValue: getMaskedSecret(last4),
    updatedAt:
      typeof envelope.updatedAt === 'string' && envelope.updatedAt ? envelope.updatedAt : null,
  };
}

// --- Env-key convenience layer -------------------------------------------------
// The root key stays in env. New deployments may set NEXTBLOCK_ENCRYPTION_KEY;
// existing ones reuse the already-provisioned CORTEX_AI_ENCRYPTION_KEY.

const DERIVED_KEY_INFO = 'nextblock-secret-encryption-key-v1';

/**
 * Derive a stable encryption key from the Supabase service-role key (HMAC-SHA256). Lets
 * secret storage work out-of-the-box on hosted installs (e.g. one-click Vercel) without a
 * dedicated env var — mirrors how apps/nextblock/lib/app-secrets.ts derives the Draft/
 * Revalidate secrets. Anyone with the service-role key already has full DB access, so this
 * adds no new exposure. Accepts both the legacy and the Marketplace-injected key names.
 */
function deriveKeyFromServiceRole(): string | null {
  const serviceKey =
    process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? process.env['SUPABASE_SECRET_KEY'];
  if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
    return null;
  }
  return createHmac('sha256', serviceKey.trim()).update(DERIVED_KEY_INFO).digest('hex');
}

/**
 * Ordered candidate keys: explicit env keys first, then the service-role-derived fallback.
 * Encryption uses the first candidate; decryption tries them all, so a secret stays
 * readable if an explicit key is added after it was stored with the derived key (or vice
 * versa). A service-role-key rotation invalidates the derived key — re-enter such secrets.
 */
function candidateEncryptionKeys(): string[] {
  const keys: string[] = [];
  const add = (value: string | null | undefined) => {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed && !keys.includes(trimmed)) {
      keys.push(trimmed);
    }
  };
  add(process.env['NEXTBLOCK_ENCRYPTION_KEY']);
  add(process.env['CORTEX_AI_ENCRYPTION_KEY']);
  add(deriveKeyFromServiceRole());
  return keys;
}

export function resolveSecretEncryptionKey(): string | null {
  return candidateEncryptionKeys()[0] ?? null;
}

export function hasSecretEncryptionKey(): boolean {
  return resolveSecretEncryptionKey() !== null;
}

export function requireSecretEncryptionKey(): string {
  const key = resolveSecretEncryptionKey();
  if (!key) {
    throw new Error(
      'An encryption key (NEXTBLOCK_ENCRYPTION_KEY or CORTEX_AI_ENCRYPTION_KEY) is required to manage stored secrets.'
    );
  }
  return key;
}

export function encryptWithEnvKey(value: string, slot: SecretSlot, now?: Date): EncryptedSecretEnvelope {
  return encryptSecret({ value, encryptionSecret: requireSecretEncryptionKey(), slot, now });
}

export function decryptWithEnvKey(envelope: unknown, slot: SecretSlot): string {
  return decryptSecret({ envelope, encryptionSecret: requireSecretEncryptionKey(), slot });
}

/**
 * Lenient runtime decrypt: returns null instead of throwing when the value is not
 * an envelope, the key is missing/wrong, or the envelope was sealed for another slot. Use
 * on hot paths (webhooks, checkout) where a missing/invalid secret should fall back to env
 * rather than crash. A malformed slot still throws: that is a caller bug, not a bad secret.
 */
export function tryDecryptWithEnvKey(envelope: unknown, slot: SecretSlot): string | null {
  if (slot !== undefined) {
    slotData(slot);
  }
  if (!isEncryptedSecretEnvelope(envelope)) {
    return null;
  }
  for (const key of candidateEncryptionKeys()) {
    try {
      return decryptSecret({ envelope, encryptionSecret: key, slot });
    } catch {
      // Wrong key (or another slot's envelope) — try the next candidate.
    }
  }
  return null;
}

/**
 * The value to keep in `slot` when its row is saved again. A version 1 envelope that one of
 * the configured keys opens comes back sealed for the slot (same plaintext and last4, its
 * original updatedAt); anything else — a version 2 envelope, a value that is not an envelope,
 * a version 1 envelope no key opens — comes back unchanged, so a save never drops what it
 * cannot read.
 */
export function resealWithEnvKey(value: unknown, slot: SecretSlot): unknown {
  slotData(slot);
  if (!isEncryptedSecretEnvelope(value) || value.version !== LEGACY_SECRET_ENVELOPE_VERSION) {
    return value;
  }
  const plaintext = tryDecryptWithEnvKey(value, slot);
  if (plaintext === null || !plaintext.trim()) {
    return value;
  }
  const resealed = encryptWithEnvKey(plaintext, slot);
  return typeof value.updatedAt === 'string' && value.updatedAt
    ? { ...resealed, updatedAt: value.updatedAt }
    : resealed;
}
