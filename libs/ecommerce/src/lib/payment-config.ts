import 'server-only';

// DB-backed payment provider credentials. Non-secret config (Stripe publishable key,
// Freemius developer/public/product ids) lives in the public `payment_public` row;
// secret keys live encrypted in the ADMIN-only `payment_secret` row. Resolution is
// DB-first with an env fallback so existing deployments keep working until the keys are
// moved into the CMS.
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
  resolveConfigValue,
  tryDecryptWithEnvKey,
} from '@nextblock-cms/db/server';
import type { Json } from '@nextblock-cms/db';
import { getEcomActorRole, requireEcomAdmin } from './server-actions/require-ecom-role';

const PAYMENT_SECRET_KEY = 'payment_secret';
const PAYMENT_PUBLIC_KEY = 'payment_public';
const CACHE_TTL_MS = 60_000;

type Row = Record<string, unknown>;

let cache: { at: number; secret: Row; public: Row } | null = null;

function asRecord(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
}

async function loadPaymentRows(force = false): Promise<{ secret: Row; public: Row }> {
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

function decryptField(row: Row, field: string): string | null {
  return tryDecryptWithEnvKey(row[field]);
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

// --- Freemius (env hydration) --------------------------------------------------

/**
 * Make the synchronous FREEMIUS_* env reads DB-aware by writing any configured DB
 * values into process.env (DB wins). Idempotent and cheap (cached); call at async
 * entry points before the package's sync credential helpers run.
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
  // `payment_secret` is the ADMIN tier of site_settings, which migration 02023 gates behind
  // is_admin_mfa(): an ADMIN reads it with the service role after the role check, because
  // through the cookie client an admin on an aal1 "remember this device" session would see
  // "no key stored" on their own form. Anyone else keeps the cookie client, which (as before)
  // returns the public row only — a WRITER can open the payments screen.
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
    envFallbackActive: Boolean(
      !secret['stripeSecretKey'] && process.env['STRIPE_SECRET_KEY']
    ),
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
 * secret). Refuses to store real secrets in the sandbox. Enforces ADMIN itself (throws
 * otherwise) and writes with the service role: `payment_secret` is in the ADMIN-only write
 * tier that migration 02023 gates behind `is_admin_mfa()`, which a "remember this device"
 * (aal1) admin cannot satisfy through the cookie client.
 */
export async function savePaymentCredentials(input: SavePaymentCredentialsInput): Promise<void> {
  const supabase = await requireEcomAdmin();

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

  const incomingSecrets: Array<[string, string | undefined]> = [
    ['stripeSecretKey', input.stripe.secretKey],
    ['stripeWebhookSecret', input.stripe.webhookSecret],
    ['freemiusSecretKey', input.freemius.secretKey],
    ['freemiusApiKey', input.freemius.apiKey],
  ];
  const hasNewSecret = incomingSecrets.some(([, v]) => v && v.trim());

  if (hasNewSecret) {
    if (isSandboxEnvironment()) {
      throw new Error('The sandbox cannot store live payment credentials.');
    }

    const { data: existing } = await supabase
      .from('site_settings')
      .select('value')
      .eq('key', PAYMENT_SECRET_KEY)
      .maybeSingle();
    const current = asRecord(existing?.value);
    const nextValue: Row = { ...current };
    for (const [field, value] of incomingSecrets) {
      if (value && value.trim()) {
        nextValue[field] = encryptWithEnvKey(value.trim());
      }
    }

    const { error: secretError } = await supabase
      .from('site_settings')
      .upsert({ key: PAYMENT_SECRET_KEY, value: nextValue as Json });
    if (secretError) {
      console.error('Error saving payment_secret settings:', secretError.message);
      throw new Error('Failed to save payment credentials.');
    }
  }

  clearPaymentConfigCache();
}
