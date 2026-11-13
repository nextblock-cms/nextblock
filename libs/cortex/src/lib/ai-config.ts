import {
  encryptOpenRouterApiKey,
  getMaskedOpenRouterKey,
  getOpenRouterKeyEnvelopeStatus,
  type EncryptedOpenRouterKeyEnvelope,
} from './ai-key-crypto';
import {
  hasSecretEncryptionKey,
  isEncryptedSecretEnvelope,
  resealWithEnvKey,
  resolveSecretEncryptionKey,
  siteSettingSecretSlot,
  tryDecryptWithEnvKey,
  type SecretSlot,
} from '@nextblock-cms/db/secrets';

const SERVER_ONLY_ERROR_MESSAGE =
  'Cortex AI configuration can only be imported from server-side code.';

function assertServerOnly() {
  if (typeof window === 'undefined') {
    return;
  }

  throw new Error(SERVER_ONLY_ERROR_MESSAGE);
}

export const CORTEX_AI_PACKAGE_ID = 'cortex-ai';
export const CORTEX_AI_PACKAGE_NAME = 'NextBlock Cortex AI';
export const CORTEX_AI_OPENROUTER_SETTING_KEY = 'cortex_ai_openrouter_api_key';
export const CORTEX_AI_OPENROUTER_MODEL_SELECTION_SETTING_KEY =
  'cortex_ai_openrouter_model_selection';
// Stock-photo provider keys. Both are SECRETS: like the OpenRouter BYOK key, their rows are
// reachable only through the service role (migration 02038), and each holds an encrypted
// envelope sealed for that row (cortexAiSecretSlot).
export const CORTEX_AI_PEXELS_SETTING_KEY = 'cortex_ai_pexels_api_key';
export const CORTEX_AI_UNSPLASH_SETTING_KEY = 'cortex_ai_unsplash_access_key';

/** The Cortex AI rows that hold a key; each row's value is the envelope itself. */
export const CORTEX_AI_SECRET_SETTING_KEYS = [
  CORTEX_AI_OPENROUTER_SETTING_KEY,
  CORTEX_AI_PEXELS_SETTING_KEY,
  CORTEX_AI_UNSPLASH_SETTING_KEY,
] as const;
export type CortexAiSecretSettingKey = (typeof CORTEX_AI_SECRET_SETTING_KEYS)[number];

const CORTEX_AI_SECRET_LABELS: Record<CortexAiSecretSettingKey, string> = {
  cortex_ai_openrouter_api_key: 'OpenRouter key',
  cortex_ai_pexels_api_key: 'Pexels API key',
  cortex_ai_unsplash_access_key: 'Unsplash access key',
};

function isCortexAiSecretSettingKey(key: unknown): key is CortexAiSecretSettingKey {
  return typeof key === 'string' && (CORTEX_AI_SECRET_SETTING_KEYS as readonly string[]).includes(key);
}

/**
 * The slot a Cortex AI key is sealed for: its own `site_settings` row (libs/db secret-crypto).
 * It opens nowhere else, so the OpenRouter key copied into the Pexels row, or into
 * `email_secret.pass` where SMTP AUTH would send it out, never decrypts (2026-11-04).
 */
export function cortexAiSecretSlot(settingKey: CortexAiSecretSettingKey): SecretSlot {
  if (!isCortexAiSecretSettingKey(settingKey)) {
    throw new Error(`"${String(settingKey)}" is not a Cortex AI key row.`);
  }
  return siteSettingSecretSlot(settingKey);
}
// The operator's registered Unsplash application name, used as the utm_source on
// Unsplash attribution links (their API guidelines require it to match the app).
// Non-secret: stored as a plain, publicly-readable site_settings value.
export const CORTEX_AI_UNSPLASH_APP_NAME_SETTING_KEY = 'cortex_ai_unsplash_app_name';

// Advanced, admin-tunable knobs for the global agent (the page builder). Non-secret
// JSON stored in site_settings. `maxOutputTokens: null` means UNLIMITED — the cap is
// omitted so the model uses its own full output budget.
export const CORTEX_AI_AGENT_SETTINGS_KEY = 'cortex_ai_agent_settings';

export type CortexAiAgentSettings = {
  maxOutputTokens: number | null;
  maxSteps: number;
  temperature: number;
  responseTimeoutMs: number;
};

export const CORTEX_AI_AGENT_SETTINGS_DEFAULTS: CortexAiAgentSettings = {
  maxOutputTokens: 16000,
  maxSteps: 8,
  responseTimeoutMs: 120000,
  temperature: 0.1,
};

// Guardrails so a bad value can't wedge the agent (each step is a full model call,
// so the step ceiling doubles as a runaway-loop / runaway-cost backstop).
export const CORTEX_AI_AGENT_SETTINGS_BOUNDS = {
  maxOutputTokens: { max: 200000, min: 256 },
  maxSteps: { max: 100, min: 2 },
  responseTimeoutMs: { max: 600000, min: 15000 },
  temperature: { max: 2, min: 0 },
};

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

/** Merge stored overrides onto the defaults, clamping every value to safe bounds. */
export function normalizeCortexAiAgentSettings(raw: unknown): CortexAiAgentSettings {
  const record =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const bounds = CORTEX_AI_AGENT_SETTINGS_BOUNDS;
  const defaults = CORTEX_AI_AGENT_SETTINGS_DEFAULTS;

  const rawMaxOutput = record.maxOutputTokens;
  const maxOutputTokens =
    rawMaxOutput === null || rawMaxOutput === 'unlimited' || rawMaxOutput === ''
      ? null
      : clampNumber(rawMaxOutput, bounds.maxOutputTokens.min, bounds.maxOutputTokens.max, defaults.maxOutputTokens ?? 16000);

  return {
    maxOutputTokens,
    maxSteps: Math.round(clampNumber(record.maxSteps, bounds.maxSteps.min, bounds.maxSteps.max, defaults.maxSteps)),
    responseTimeoutMs: Math.round(
      clampNumber(record.responseTimeoutMs, bounds.responseTimeoutMs.min, bounds.responseTimeoutMs.max, defaults.responseTimeoutMs)
    ),
    temperature: clampNumber(record.temperature, bounds.temperature.min, bounds.temperature.max, defaults.temperature),
  };
}

/** Read the admin-tuned agent settings from site_settings, falling back to defaults. */
export async function resolveCortexAiAgentSettings(
  supabase?: { from: (table: string) => any } | null
): Promise<CortexAiAgentSettings> {
  if (supabase) {
    try {
      const { data } = await supabase
        .from('site_settings')
        .select('value')
        .eq('key', CORTEX_AI_AGENT_SETTINGS_KEY)
        .maybeSingle();

      if (data?.value) {
        return normalizeCortexAiAgentSettings(data.value);
      }
    } catch {
      // Fall through to defaults if the settings read fails.
    }
  }

  return { ...CORTEX_AI_AGENT_SETTINGS_DEFAULTS };
}

function readEnvValue(name: string) {
  return process.env[name]?.trim() || null;
}

export function getPexelsEnvApiKey() {
  assertServerOnly();
  return readEnvValue('PEXELS_API_KEY');
}

export function getUnsplashEnvApiKey() {
  assertServerOnly();
  return readEnvValue('UNSPLASH_ACCESS_KEY');
}

export function getOpenRouterEnvApiKey() {
  assertServerOnly();
  return readEnvValue('OPENROUTER_API_KEY');
}

export function getCortexAiEnvConfig() {
  assertServerOnly();
  const openRouterApiKey = getOpenRouterEnvApiKey();

  return {
    encryptionKey: readEnvValue('CORTEX_AI_ENCRYPTION_KEY'),
    freemiusSandboxKey: readEnvValue('FREEMIUS_AI_SANDBOX_KEY'),
    // True when ANY usable key exists: an explicit env key OR the service-role-derived
    // fallback — so BYOK works on a one-click Vercel deploy with no extra env var.
    hasEncryptionKey: hasSecretEncryptionKey(),
    hasOpenRouterEnvKey: Boolean(openRouterApiKey),
    openRouterEnvKeyLast4: openRouterApiKey ? openRouterApiKey.slice(-4) : null,
  };
}

function requireEncryptionKey() {
  assertServerOnly();
  // Resolve via the shared chain: NEXTBLOCK_ENCRYPTION_KEY -> CORTEX_AI_ENCRYPTION_KEY ->
  // a stable key derived from the Supabase service-role key. The derived fallback lets
  // BYOK work out-of-the-box on hosted installs (e.g. one-click Vercel).
  const encryptionKey = resolveSecretEncryptionKey();

  if (!encryptionKey) {
    throw new Error(
      'An encryption key (NEXTBLOCK_ENCRYPTION_KEY, CORTEX_AI_ENCRYPTION_KEY, or a Supabase service-role key) is required to manage stored OpenRouter keys.'
    );
  }

  return encryptionKey;
}

/** Seal a key for its own row: the value to store under `settingKey`. */
export function encryptStoredCortexAiSecret(settingKey: CortexAiSecretSettingKey, value: string) {
  return encryptOpenRouterApiKey({
    apiKey: value,
    encryptionSecret: requireEncryptionKey(),
    slot: cortexAiSecretSlot(settingKey),
  });
}

/** Open the key stored under `settingKey`; throws when it was sealed for another row or key. */
export function decryptStoredCortexAiSecret(settingKey: CortexAiSecretSettingKey, encryptedKey: unknown) {
  assertServerOnly();
  // Try every candidate key (explicit env keys + the derived fallback). This keeps a key
  // stored under one key readable if another is added later, and matches the SMTP/payment
  // secret behaviour. The envelope is the shared secret-crypto format.
  const result = tryDecryptWithEnvKey(encryptedKey, cortexAiSecretSlot(settingKey));

  if (result === null) {
    throw new Error(`Failed to decrypt stored ${CORTEX_AI_SECRET_LABELS[settingKey]}.`);
  }

  return result;
}

export function encryptStoredOpenRouterApiKey(apiKey: string) {
  return encryptStoredCortexAiSecret(CORTEX_AI_OPENROUTER_SETTING_KEY, apiKey);
}

export function decryptStoredOpenRouterApiKey(encryptedKey: unknown) {
  return decryptStoredCortexAiSecret(CORTEX_AI_OPENROUTER_SETTING_KEY, encryptedKey);
}

type SettingsClient = { from: (table: string) => any };

/**
 * Re-seal, each for its own row, the Cortex AI keys stored before 0.23.1: a version 1 envelope
 * opens in any slot. Every save on the Cortex AI settings screen and the setup wizard's key steps
 * call it with the service-role client, after their own role check, so saving anything there
 * once binds every stored key. Each row is swapped only while it still holds the envelope that
 * was read (the ciphertext matches), so a key saved meanwhile is never overwritten. Best effort:
 * the keys read either way, so a failure is logged and never fails the save.
 */
export async function resealStoredCortexAiSecrets(supabase: SettingsClient): Promise<number> {
  assertServerOnly();
  let resealed = 0;

  try {
    const { data, error } = await supabase
      .from('site_settings')
      .select('key, value')
      .in('key', [...CORTEX_AI_SECRET_SETTING_KEYS]);

    if (error || !Array.isArray(data)) {
      return 0;
    }

    for (const row of data as Array<{ key: unknown; value: unknown }>) {
      if (!isCortexAiSecretSettingKey(row.key) || !isEncryptedSecretEnvelope(row.value)) {
        continue;
      }

      const next = resealWithEnvKey(row.value, cortexAiSecretSlot(row.key));

      if (next === row.value) {
        continue;
      }

      const { error: updateError } = await supabase
        .from('site_settings')
        .update({ value: next })
        .eq('key', row.key)
        .eq('value->>ciphertext', row.value.ciphertext);

      if (updateError) {
        throw new Error(updateError.message);
      }

      resealed += 1;
    }
  } catch (error) {
    console.warn(
      '[cortex-ai] Could not re-seal the stored keys for their rows:',
      error instanceof Error ? error.message : 'unknown error'
    );
  }

  return resealed;
}

export function getStoredOpenRouterKeyStatus(value: unknown) {
  return getOpenRouterKeyEnvelopeStatus(value);
}

export function getEnvOpenRouterKeyStatus() {
  assertServerOnly();
  const env = getCortexAiEnvConfig();

  return {
    hasEnvOpenRouterKey: env.hasOpenRouterEnvKey,
    maskedEnvOpenRouterKey: env.openRouterEnvKeyLast4
      ? getMaskedOpenRouterKey(env.openRouterEnvKeyLast4)
      : null,
  };
}

export type { EncryptedOpenRouterKeyEnvelope };
