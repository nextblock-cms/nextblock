import 'server-only';

// DB-backed payment provider credentials. Non-secret config (Stripe publishable key,
// Freemius developer/public/product ids) lives in the public `payment_public` row;
// secret keys live encrypted in the ADMIN-only `payment_secret` row. Resolution is
// DB-first with an env fallback so existing deployments keep working until the keys are
// moved into the CMS. The public sandbox neither saves nor reads the rows: env only.
//
// Stripe is resolved through getStripeClient() (a lazy client) and direct getters.
// Freemius credentials are read synchronously throughout the package, so rather than an
// invasive async refactor we hydrate the relevant FREEMIUS_* env vars from the DB at the
// async entry points (webhook, checkout, coupon ops) — DB values win.
import {
  createClient,
  getServiceRoleSupabaseClient,
  encryptWithEnvKey,
  getSecretEnvelopeStatus,
  isSandboxEnvironment,
  resealWithEnvKey,
  resolveConfigValue,
  siteSettingSecretSlot,
  tryDecryptWithEnvKey,
  type SecretSlot,
} from '@nextblock-cms/db/server';
import type { Json } from '@nextblock-cms/db';
import { getEcomActorRole, requireEcomAdmin } from './server-actions/require-ecom-role';

const PAYMENT_SECRET_KEY = 'payment_secret';
const PAYMENT_PUBLIC_KEY = 'payment_public';

/** Every encrypted field of the `payment_secret` row (the sandbox Freemius key is read, never saved here). */
const PAYMENT_SECRET_FIELDS = [
  'stripeSecretKey',
  'stripeWebhookSecret',
  'freemiusSecretKey',
  'freemiusApiKey',
  'freemiusSandboxSecretKey',
] as const;
type PaymentSecretField = (typeof PAYMENT_SECRET_FIELDS)[number];

/**
 * Each key opens only from its own field (libs/db secret-crypto), so an envelope copied between
 * fields or in from another row never decrypts here (2026-11-04).
 */
function paymentSecretSlot(field: PaymentSecretField): SecretSlot {
  return siteSettingSecretSlot(PAYMENT_SECRET_KEY, field);
}
/** Thrown by savePaymentCredentials on the sandbox; the payments screen shows the same note. */
export const PAYMENT_SETTINGS_SANDBOX_MESSAGE = "Payment keys can't be changed in the sandbox: its checkout is simulated.";
const CACHE_TTL_MS = 60_000;

type Row = Record<string, unknown>;

let cache: { at: number; secret: Row; public: Row } | null = null;

function asRecord(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
}

async function loadPaymentRows(force = false): Promise<{ secret: Row; public: Row }> {
  // The sandbox neither saves nor reads the payment rows, so Stripe and Freemius resolve from its
  // env only. Its admin login is public: a visitor can write `payment_public` over PostgREST (the
  // factor-less demo admin passes is_admin_mfa()) or through Cortex's DB tool, and
  // hydrateFreemiusEnvFromDb would copy their Freemius ids into process.env for every later
  // request. No read and no cache entry (like resolveEmailServerConfig).
  if (isSandboxEnvironment()) {
    return { secret: {}, public: {} };
  }

  const now = Date.now();
  if (!force && cache && now - cache.at < CACHE_TTL_MS) {
    return { secret: cache.secret, public: cache.public };
  }

  let secret: Row = {};
  let pub: Row = {};
  try {
    const supabase = getServiceRoleSupabaseClient();
    const [{ data: secretData }, { data: publicData }] = await Promise.all([
      supabase.from('site_settings').select('value').eq('key', PAYMENT_SECRET_KEY).maybeSingle(),
      supabase.from('site_settings').select('value').eq('key', PAYMENT_PUBLIC_KEY).maybeSingle(),
    ]);
    secret = asRecord(secretData?.value);
    pub = asRecord(publicData?.value);
  } catch {
    // No service-role key (unconfigured instance) — fall back to env-only resolution.
  }

  cache = { at: now, secret, public: pub };
  return { secret, public: pub };
}

/** Drop the in-memory cache after a save so the next read reflects new credentials. */
export function clearPaymentConfigCache(): void {
  cache = null;
}

function decryptField(row: Row, field: PaymentSecretField): string | null {
  return tryDecryptWithEnvKey(row[field], paymentSecretSlot(field));
}

// --- Stripe -------------------------------------------------------------------

export async function resolveStripeSecretKey(): Promise<string | null> {
  const { secret } = await loadPaymentRows();
  return resolveConfigValue(decryptField(secret, 'stripeSecretKey'), 'STRIPE_SECRET_KEY');
}

export async function resolveStripeWebhookSecret(): Promise<string | null> {
  const { secret } = await loadPaymentRows();
  return resolveConfigValue(decryptField(secret, 'stripeWebhookSecret'), 'STRIPE_WEBHOOK_SECRET');
}

export async function resolveStripePublishableKey(): Promise<string | null> {
  const { public: pub } = await loadPaymentRows();
  const fromDb = asRecord(pub['stripe'])['publishableKey'];
  return resolveConfigValue(
    typeof fromDb === 'string' ? fromDb : null,
    'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY'
  );
}

// --- Stripe key diagnostics (never key material) --------------------------------

/** Where a Stripe credential comes from: saved in the CMS (Payments), the environment, or nowhere. */
export type StripeCredentialSource = 'cms' | 'env' | null;

export type StripeKeyMode = 'test' | 'live';

/**
 * Facts about the Stripe keys the store uses (checkout, refunds and affiliate payouts share them),
 * for the CMS. Nothing of a key leaves this module but the last 4 characters of the secret key.
 */
export interface StripeKeyDiagnostics {
  /** The public sandbox: nothing was read (its keys belong to the operator); every fact is empty. */
  sandbox: boolean;
  /** Where the secret key `getStripeClient()` uses comes from (CMS first, then `STRIPE_SECRET_KEY`). */
  secretKeySource: StripeCredentialSource;
  /** A secret key is saved in the CMS but this deployment cannot decrypt it, so it is not the one in use. */
  storedSecretKeyUnreadable: boolean;
  /** From the secret key's prefix (`sk_test_` / `rk_test_`, `sk_live_` / `rk_live_`); null when absent or unknown. */
  mode: StripeKeyMode | null;
  /** A restricted key (`rk_…`), which must allow every call payouts and checkout make. */
  restricted: boolean;
  /** Last 4 characters of the secret key in use, null without one. */
  secretKeyLast4: string | null;
  /** Where the publishable key comes from (CMS first, then `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`). */
  publishableKeySource: StripeCredentialSource;
  /** From the publishable key's prefix (`pk_test_` / `pk_live_`); null when absent or unknown. */
  publishableKeyMode: StripeKeyMode | null;
  /** Both keys are present and of the same mode (checkout needs the pair). */
  publishableKeyMatchesMode: boolean;
  /** Where the webhook signing secret comes from (CMS first, then `STRIPE_WEBHOOK_SECRET`). */
  webhookSecretSource: StripeCredentialSource;
}

/** The value `resolveConfigValue` resolves and where it came from (no env-fallback warning). */
function resolveWithSource(dbValue: string | null, envName: string): { value: string | null; source: StripeCredentialSource } {
  const value = resolveConfigValue(dbValue, envName, { warnOnEnvFallback: false });
  if (!value) return { value: null, source: null };
  return { value, source: typeof dbValue === 'string' && dbValue.trim() ? 'cms' : 'env' };
}

/** The key mode from a documented prefix (the same rule as `stripeSecretKeyLivemode` in stripe/client.ts). */
function keyModeFromPrefix(key: string | null, live: readonly string[], test: readonly string[]): StripeKeyMode | null {
  if (!key) return null;
  if (live.some((prefix) => key.startsWith(prefix))) return 'live';
  if (test.some((prefix) => key.startsWith(prefix))) return 'test';
  return null;
}

/**
 * What the CMS Affiliates → Stripe payouts screen shows about the keys entered under CMS →
 * Payments (there is no second key store): where each comes from, the mode, the last 4 characters
 * of the secret key, whether the publishable key is present and of the same mode, and whether a
 * webhook secret is set. Resolution matches the resolvers above (DB first, env fallback, the same
 * cached rows). Returns the empty facts on the sandbox before any read. Callers authorize first:
 * the screen calls `requireCmsAdmin()`.
 */
export async function getStripeKeyDiagnostics(): Promise<StripeKeyDiagnostics> {
  if (isSandboxEnvironment()) {
    return {
      sandbox: true,
      secretKeySource: null,
      storedSecretKeyUnreadable: false,
      mode: null,
      restricted: false,
      secretKeyLast4: null,
      publishableKeySource: null,
      publishableKeyMode: null,
      publishableKeyMatchesMode: false,
      webhookSecretSource: null,
    };
  }

  const { secret, public: pub } = await loadPaymentRows();
  const storedSecret = decryptField(secret, 'stripeSecretKey');
  const secretKey = resolveWithSource(storedSecret, 'STRIPE_SECRET_KEY');
  const storedPublishable = asRecord(pub['stripe'])['publishableKey'];
  const publishable = resolveWithSource(typeof storedPublishable === 'string' ? storedPublishable : null, 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY');
  const webhook = resolveWithSource(decryptField(secret, 'stripeWebhookSecret'), 'STRIPE_WEBHOOK_SECRET');

  const mode = keyModeFromPrefix(secretKey.value, ['sk_live_', 'rk_live_'], ['sk_test_', 'rk_test_']);
  const publishableKeyMode = keyModeFromPrefix(publishable.value, ['pk_live_'], ['pk_test_']);
  const key = secretKey.value;

  return {
    sandbox: false,
    secretKeySource: secretKey.source,
    storedSecretKeyUnreadable: getSecretEnvelopeStatus(secret['stripeSecretKey']).hasStoredValue && !storedSecret,
    mode,
    restricted: Boolean(key && key.startsWith('rk_')),
    // Only a real-length key shows its tail; anything shorter is never echoed.
    secretKeyLast4: key && key.length >= 12 ? key.slice(-4) : null,
    publishableKeySource: publishable.source,
    publishableKeyMode,
    publishableKeyMatchesMode: mode !== null && publishableKeyMode === mode,
    webhookSecretSource: webhook.source,
  };
}

// --- Freemius (env hydration) --------------------------------------------------

/**
 * Make the synchronous FREEMIUS_* env reads DB-aware by writing any configured DB
 * values into process.env (DB wins). Idempotent and cheap (cached); call at async
 * entry points before the package's sync credential helpers run. Writes nothing on
 * the sandbox, where loadPaymentRows reads no row.
 */
export async function hydrateFreemiusEnvFromDb(): Promise<void> {
  // Best-effort overlay: a failure here must never break checkout/webhook/coupon flows,
  // which still resolve from env on their own.
  try {
    const { secret, public: pub } = await loadPaymentRows();
    const freemiusPublic = asRecord(pub['freemius']);

    const set = (envName: string, value: string | null) => {
      if (value && value.trim()) {
        process.env[envName] = value.trim();
      }
    };

    set('FREEMIUS_SECRET_KEY', decryptField(secret, 'freemiusSecretKey'));
    set('FREEMIUS_API_KEY', decryptField(secret, 'freemiusApiKey'));
    set('FREEMIUS_ECOMMERCE_SANDBOX_SECRET_KEY', decryptField(secret, 'freemiusSandboxSecretKey'));
    set(
      'FREEMIUS_PUBLIC_KEY',
      typeof freemiusPublic['publicKey'] === 'string' ? (freemiusPublic['publicKey'] as string) : null
    );
    set(
      'FREEMIUS_PRODUCT_ID',
      typeof freemiusPublic['productId'] === 'string' ? (freemiusPublic['productId'] as string) : null
    );
    set(
      'FREEMIUS_DEVELOPER_ID',
      typeof freemiusPublic['developerId'] === 'string'
        ? (freemiusPublic['developerId'] as string)
        : null
    );
  } catch (error) {
    console.warn('[payment-config] Could not hydrate Freemius credentials from the database:', error);
  }
}

// --- Config status (DB-or-env) -------------------------------------------------

export interface PaymentProviderStatus {
  hasKeys: boolean;
  missing: string[];
}

export interface PaymentConfigStatus {
  stripe: PaymentProviderStatus;
  freemius: PaymentProviderStatus;
}

export async function getPaymentConfigStatus(): Promise<PaymentConfigStatus> {
  const { secret, public: pub } = await loadPaymentRows();
  const freemiusPublic = asRecord(pub['freemius']);
  const stripePublic = asRecord(pub['stripe']);

  const stripeMissing: string[] = [];
  if (!resolveConfigValue(decryptField(secret, 'stripeSecretKey'), 'STRIPE_SECRET_KEY')) {
    stripeMissing.push('Secret key');
  }
  if (
    !resolveConfigValue(
      typeof stripePublic['publishableKey'] === 'string'
        ? (stripePublic['publishableKey'] as string)
        : null,
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY'
    )
  ) {
    stripeMissing.push('Publishable key');
  }
  if (!resolveConfigValue(decryptField(secret, 'stripeWebhookSecret'), 'STRIPE_WEBHOOK_SECRET')) {
    stripeMissing.push('Webhook secret');
  }

  const freemiusMissing: string[] = [];
  if (
    !resolveConfigValue(
      typeof freemiusPublic['publicKey'] === 'string' ? (freemiusPublic['publicKey'] as string) : null,
      'FREEMIUS_PUBLIC_KEY'
    )
  ) {
    freemiusMissing.push('Public key');
  }
  if (!resolveConfigValue(decryptField(secret, 'freemiusSecretKey'), 'FREEMIUS_SECRET_KEY')) {
    freemiusMissing.push('Secret key');
  }

  return {
    stripe: { hasKeys: stripeMissing.length === 0, missing: stripeMissing },
    freemius: { hasKeys: freemiusMissing.length === 0, missing: freemiusMissing },
  };
}

// --- CMS form view + save ------------------------------------------------------

export interface PaymentCredentialsView {
  stripe: {
    publishableKey: string;
    hasSecretKey: boolean;
    hasWebhookSecret: boolean;
  };
  freemius: {
    developerId: string;
    publicKey: string;
    productId: string;
    hasSecretKey: boolean;
    hasApiKey: boolean;
  };
  envFallbackActive: boolean;
}

export async function getPaymentCredentialsView(): Promise<PaymentCredentialsView> {
  // The sandbox neither saves nor reads the payment rows, so its form shows none of what a visitor wrote.
  if (isSandboxEnvironment()) {
    return {
      stripe: { publishableKey: '', hasSecretKey: false, hasWebhookSecret: false },
      freemius: { developerId: '', publicKey: '', productId: '', hasSecretKey: false, hasApiKey: false },
      envFallbackActive: false,
    };
  }

  // `payment_secret` is a secret row of site_settings, which no API session reaches since
  // migration 02038: an ADMIN reads it with the service role after the role check (second factor
  // included, getEcomActorRole). Anyone else keeps the cookie client, which (as before) returns
  // the public row only — a WRITER can open the payments screen.
  const role = await getEcomActorRole();
  const supabase = role === 'ADMIN' ? getServiceRoleSupabaseClient() : createClient();
  const [{ data: secretData }, { data: publicData }] = await Promise.all([
    supabase.from('site_settings').select('value').eq('key', PAYMENT_SECRET_KEY).maybeSingle(),
    supabase.from('site_settings').select('value').eq('key', PAYMENT_PUBLIC_KEY).maybeSingle(),
  ]);
  const secret = asRecord(secretData?.value);
  const pub = asRecord(publicData?.value);
  const stripePublic = asRecord(pub['stripe']);
  const freemiusPublic = asRecord(pub['freemius']);

  const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');

  return {
    stripe: {
      publishableKey: asStr(stripePublic['publishableKey']),
      hasSecretKey: getSecretEnvelopeStatus(secret['stripeSecretKey']).hasStoredValue,
      hasWebhookSecret: getSecretEnvelopeStatus(secret['stripeWebhookSecret']).hasStoredValue,
    },
    freemius: {
      developerId: asStr(freemiusPublic['developerId']),
      publicKey: asStr(freemiusPublic['publicKey']),
      productId: asStr(freemiusPublic['productId']),
      hasSecretKey: getSecretEnvelopeStatus(secret['freemiusSecretKey']).hasStoredValue,
      hasApiKey: getSecretEnvelopeStatus(secret['freemiusApiKey']).hasStoredValue,
    },
    // Off the sandbox only (it returned above: saving refuses there, so the "saving here moves
    // them into the database" hint would be wrong): the env holds a Stripe secret the row lacks.
    envFallbackActive: Boolean(!secret['stripeSecretKey'] && process.env['STRIPE_SECRET_KEY']),
  };
}

export interface SavePaymentCredentialsInput {
  stripe: {
    publishableKey: string;
    secretKey?: string;
    webhookSecret?: string;
  };
  freemius: {
    developerId: string;
    publicKey: string;
    productId: string;
    secretKey?: string;
    apiKey?: string;
  };
}

/**
 * Persist payment credentials. Public fields always overwrite; secret fields are
 * encrypted and only written when a new value is supplied (blank keeps the stored
 * secret), and every stored key from before 0.23.1 is re-sealed for its field on each save.
 * Saves nothing on the sandbox (throws). Enforces ADMIN itself (throws otherwise) and writes
 * with the service role: `payment_secret` is a secret row of `site_settings`, which no API
 * session can write since migration 02038.
 */
export async function savePaymentCredentials(input: SavePaymentCredentialsInput): Promise<void> {
  const supabase = await requireEcomAdmin();

  // The sandbox's admin login is public and its checkout is simulated, so it neither saves nor
  // reads the payment rows (loadPaymentRows returns none there; Stripe and Freemius resolve from
  // its env). Nothing is saved, not even the public row: a row a visitor saved would otherwise
  // reach every later visitor, its Freemius ids through hydrateFreemiusEnvFromDb into process.env.
  if (isSandboxEnvironment()) {
    throw new Error(PAYMENT_SETTINGS_SANDBOX_MESSAGE);
  }

  const publicValue = {
    stripe: { publishableKey: input.stripe.publishableKey.trim() },
    freemius: {
      developerId: input.freemius.developerId.trim(),
      publicKey: input.freemius.publicKey.trim(),
      productId: input.freemius.productId.trim(),
      sandboxEnabled: false,
    },
  };

  const { error: publicError } = await supabase
    .from('site_settings')
    .upsert({ key: PAYMENT_PUBLIC_KEY, value: publicValue });
  if (publicError) {
    console.error('Error saving payment_public settings:', publicError.message);
    throw new Error('Failed to save payment settings.');
  }

  const supplied = new Map<PaymentSecretField, string>();
  for (const [field, value] of [
    ['stripeSecretKey', input.stripe.secretKey],
    ['stripeWebhookSecret', input.stripe.webhookSecret],
    ['freemiusSecretKey', input.freemius.secretKey],
    ['freemiusApiKey', input.freemius.apiKey],
  ] as const) {
    if (value && value.trim()) supplied.set(field, value.trim());
  }

  // Read-merge: a blank field keeps its stored key. What is kept is re-sealed for its own field:
  // an envelope from before 0.23.1 opens in any slot (libs/db secret-crypto), so every save, one
  // that changes no key included, leaves each key bound to where it is stored.
  const { data: existing, error: readError } = await supabase
    .from('site_settings')
    .select('value')
    .eq('key', PAYMENT_SECRET_KEY)
    .maybeSingle();
  if (readError) {
    console.error('Error reading payment_secret settings:', readError.message);
    // Writing now could drop the keys that were not re-entered.
    if (supplied.size > 0) throw new Error('Failed to save payment credentials.');
  } else {
    const current = asRecord(existing?.value);
    const nextValue: Row = { ...current };
    let changed = false;
    for (const field of PAYMENT_SECRET_FIELDS) {
      const value = supplied.get(field);
      const slot = paymentSecretSlot(field);
      const next = value ? encryptWithEnvKey(value, slot) : resealWithEnvKey(current[field], slot);
      if (next !== current[field]) {
        nextValue[field] = next;
        changed = true;
      }
    }

    if (changed) {
      const { error: secretError } = await supabase
        .from('site_settings')
        .upsert({ key: PAYMENT_SECRET_KEY, value: nextValue as Json });
      if (secretError) {
        console.error('Error saving payment_secret settings:', secretError.message);
        throw new Error('Failed to save payment credentials.');
      }
    }
  }

  clearPaymentConfigCache();
}
