import 'server-only';

import type { Json } from '@nextblock-cms/db';
import {
  encryptWithEnvKey,
  getSecretEnvelopeStatus,
  getServiceRoleSupabaseClient,
  siteSettingSecretSlot,
  tryDecryptWithEnvKey,
  type SecretSlot,
} from '@nextblock-cms/db/server';
import { AFFILIATE_PAYPAL_SETTINGS_KEY } from '@nextblock-cms/affiliates';
import { requireCmsAdmin } from '../../auth/cms-actor';
import {
  clearAffiliatePayPalTokenCache,
  isAffiliatePayPalEnvironment,
  type AffiliatePayPalCredentials,
  type AffiliatePayPalEnvironment,
} from './client';

/**
 * Where the PayPal Payouts credentials come from (02037, docs/15 → "Paying partners with PayPal").
 *
 * The CMS-saved configuration wins: `site_settings.affiliates_paypal_secret` holds the environment
 * new payouts go out in and, per environment, a client id and the secret encrypted with the app's
 * secret envelope (`encryptWithEnvKey`, the same AES-256-GCM envelope as `payment_secret`). The row is
 * service-role only (02037's RESTRICTIVE policy: no API role reads or writes it, an aal2 ADMIN
 * included), so this module reads and writes it with the service role, writes only after
 * `requireCmsAdmin()`, and never on the public sandbox. The environment variables are the fallback:
 * `PAYPAL_CLIENT_ID` / `PAYPAL_SECRET_KEY` (sandbox), `PAYPAL_LIVE_CLIENT_ID` / `PAYPAL_LIVE_SECRET_KEY`
 * (live), and `PAYPAL_ENVIRONMENT` (`live`, else sandbox) picks the environment while the CMS saved
 * none.
 *
 * Nothing of a secret leaves this module: the CMS sees the environment, where the credentials come
 * from (`cms` or `env`) and the last 4 characters of the client id ({@link getAffiliatePayPalCredentialStatus}).
 * On the public sandbox (`NEXT_PUBLIC_IS_SANDBOX=true`) nothing is read or saved, the environment
 * pair included: its env credentials belong to the operator, and every visitor is its admin.
 */

/** The environment variables of each environment's pair. */
export const AFFILIATE_PAYPAL_ENV_NAMES: Readonly<Record<AffiliatePayPalEnvironment, { clientId: string; secret: string }>> = {
  sandbox: { clientId: 'PAYPAL_CLIENT_ID', secret: 'PAYPAL_SECRET_KEY' },
  live: { clientId: 'PAYPAL_LIVE_CLIENT_ID', secret: 'PAYPAL_LIVE_SECRET_KEY' },
};

/** Picks the environment while the CMS saved none (`live`; anything else, or unset, is sandbox). */
export const AFFILIATE_PAYPAL_ENVIRONMENT_ENV_NAME = 'PAYPAL_ENVIRONMENT';

/** The longest client id or secret accepted (PayPal's are about 80 characters). */
export const AFFILIATE_PAYPAL_CREDENTIAL_MAX_LENGTH = 256;

const CACHE_TTL_MS = 60_000;

export type AffiliatePayPalCredentialSource = 'cms' | 'env';

export interface AffiliatePayPalResolvedCredentials extends AffiliatePayPalCredentials {
  source: AffiliatePayPalCredentialSource;
}

interface StoredEnvironment {
  clientId: string | null;
  /** The encrypted envelope as stored (never decrypted outside {@link resolveFromRow}). */
  secret: unknown;
}

interface StoredRow {
  environment: AffiliatePayPalEnvironment | null;
  sandbox: StoredEnvironment;
  live: StoredEnvironment;
}

const EMPTY_ROW: StoredRow = {
  environment: null,
  sandbox: { clientId: null, secret: null },
  live: { clientId: null, secret: null },
};

let cache: { at: number; row: StoredRow } | null = null;

function isPayPalSandboxDeployment(): boolean {
  return process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function cleanClientId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const clientId = value.trim();
  return clientId && clientId.length <= AFFILIATE_PAYPAL_CREDENTIAL_MAX_LENGTH && /^[A-Za-z0-9_-]+$/.test(clientId) ? clientId : null;
}

function parseRow(value: unknown): StoredRow {
  const record = asRecord(value);
  const environmentOf = (key: AffiliatePayPalEnvironment): StoredEnvironment => {
    const entry = asRecord(record[key]);
    return { clientId: cleanClientId(entry['clientId']), secret: entry['secret'] ?? null };
  };
  return {
    environment: isAffiliatePayPalEnvironment(record['environment']) ? record['environment'] : null,
    sandbox: environmentOf('sandbox'),
    live: environmentOf('live'),
  };
}

/**
 * The stored row (cached 60 s per instance), or the empty row: on the public sandbox (never read), with
 * no row, or when it cannot be read (the environment variables then apply). Never throws.
 */
async function loadAffiliatePayPalStoredRow(force = false): Promise<StoredRow> {
  if (isPayPalSandboxDeployment()) return EMPTY_ROW;
  const now = Date.now();
  if (!force && cache && now - cache.at < CACHE_TTL_MS) return cache.row;
  let row = EMPTY_ROW;
  try {
    const { data, error } = await getServiceRoleSupabaseClient()
      .from('site_settings')
      .select('value')
      .eq('key', AFFILIATE_PAYPAL_SETTINGS_KEY)
      .maybeSingle();
    if (error) {
      console.warn('[affiliates] Could not read the saved PayPal credentials', { code: (error as { code?: unknown }).code ?? null });
    } else {
      row = parseRow((data as { value?: unknown } | null)?.value);
    }
  } catch {
    // No service-role key (an unconfigured instance): the environment variables apply.
  }
  cache = { at: now, row };
  return row;
}

/** Drops the cached row (after a save, so the next read sees the new credentials). */
export function clearAffiliatePayPalCredentialsCache(): void {
  cache = null;
}

function envValue(name: string): string | null {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function envEnvironment(): AffiliatePayPalEnvironment | null {
  const value = envValue(AFFILIATE_PAYPAL_ENVIRONMENT_ENV_NAME)?.toLowerCase();
  return value === 'live' ? 'live' : value === 'sandbox' ? 'sandbox' : null;
}

interface ResolvedFromRow {
  credentials: AffiliatePayPalResolvedCredentials | null;
  /** A secret is saved for the environment but this deployment cannot decrypt it (its key changed). */
  storedSecretUnreadable: boolean;
}

/**
 * Each environment's secret is sealed for its own field of the row (libs/db secret-crypto, 02038):
 * a sandbox secret never opens as the live one, and an envelope copied in from another row never opens.
 */
function paypalSecretSlot(environment: AffiliatePayPalEnvironment): SecretSlot {
  return siteSettingSecretSlot(AFFILIATE_PAYPAL_SETTINGS_KEY, `${environment}_secret`);
}

function resolveFromRow(row: StoredRow, environment: AffiliatePayPalEnvironment): ResolvedFromRow {
  const stored = row[environment];
  const storedSecret = tryDecryptWithEnvKey(stored.secret, paypalSecretSlot(environment));
  const storedSecretUnreadable = getSecretEnvelopeStatus(stored.secret).hasStoredValue && !storedSecret;
  if (stored.clientId && storedSecret) {
    return { credentials: { environment, clientId: stored.clientId, secret: storedSecret, source: 'cms' }, storedSecretUnreadable };
  }
  const names = AFFILIATE_PAYPAL_ENV_NAMES[environment];
  const clientId = cleanClientId(envValue(names.clientId));
  const secret = envValue(names.secret);
  if (clientId && secret) return { credentials: { environment, clientId, secret, source: 'env' }, storedSecretUnreadable };
  return { credentials: null, storedSecretUnreadable };
}

/**
 * The environment new PayPal payouts go out in: the one saved in the CMS, else `PAYPAL_ENVIRONMENT`,
 * else the sandbox. Never throws; on the public sandbox always `sandbox` from `default`.
 */
export async function resolveAffiliatePayPalEnvironment(): Promise<{
  environment: AffiliatePayPalEnvironment;
  source: 'cms' | 'env' | 'default';
}> {
  if (isPayPalSandboxDeployment()) return { environment: 'sandbox', source: 'default' };
  const row = await loadAffiliatePayPalStoredRow();
  if (row.environment) return { environment: row.environment, source: 'cms' };
  const fromEnv = envEnvironment();
  return fromEnv ? { environment: fromEnv, source: 'env' } : { environment: 'sandbox', source: 'default' };
}

/**
 * The credentials of one environment (default: the active one): the CMS pair when its secret can be
 * decrypted, else the environment pair, else null. Always null on the public sandbox (nothing is
 * read there). For the payout runner, the PayPal sync and the CMS tests; never sent to a browser.
 */
export async function resolveAffiliatePayPalCredentials(
  environment?: AffiliatePayPalEnvironment
): Promise<AffiliatePayPalResolvedCredentials | null> {
  if (isPayPalSandboxDeployment()) return null;
  const target = environment ?? (await resolveAffiliatePayPalEnvironment()).environment;
  return resolveFromRow(await loadAffiliatePayPalStoredRow(), target).credentials;
}

/** The last 4 characters of a client id long enough to show them (never of a secret). */
function last4(clientId: string | null | undefined): string | null {
  return clientId && clientId.length >= 8 ? clientId.slice(-4) : null;
}

export interface AffiliatePayPalEnvironmentStatus {
  configured: boolean;
  source: AffiliatePayPalCredentialSource | null;
  clientIdLast4: string | null;
  /** A secret is saved in the CMS for it, but this deployment cannot decrypt it. */
  storedSecretUnreadable: boolean;
  /** A client id is saved in the CMS for it (the form can keep it). */
  savedInCms: boolean;
}

/** What the CMS may show about the PayPal credentials: no secret, no full client id. */
export interface AffiliatePayPalCredentialStatus {
  /** The public sandbox: nothing was read, every fact is empty. */
  sandbox: boolean;
  environment: AffiliatePayPalEnvironment;
  environmentSource: 'cms' | 'env' | 'default';
  /** The active environment's credentials. */
  active: AffiliatePayPalEnvironmentStatus;
  environments: Readonly<Record<AffiliatePayPalEnvironment, AffiliatePayPalEnvironmentStatus>>;
}

function emptyStatus(): AffiliatePayPalEnvironmentStatus {
  return { configured: false, source: null, clientIdLast4: null, storedSecretUnreadable: false, savedInCms: false };
}

/**
 * The credential facts of `/cms/affiliates/paypal` (the caller checked the ADMIN): the environment and
 * where it comes from, and per environment whether credentials resolve, from where, and the client
 * id's last 4 characters. Empty on the public sandbox, before any read.
 */
export async function getAffiliatePayPalCredentialStatus(): Promise<AffiliatePayPalCredentialStatus> {
  if (isPayPalSandboxDeployment()) {
    return {
      sandbox: true,
      environment: 'sandbox',
      environmentSource: 'default',
      active: emptyStatus(),
      environments: { sandbox: emptyStatus(), live: emptyStatus() },
    };
  }
  const row = await loadAffiliatePayPalStoredRow();
  const { environment, source } = await resolveAffiliatePayPalEnvironment();
  const statusOf = (target: AffiliatePayPalEnvironment): AffiliatePayPalEnvironmentStatus => {
    const resolved = resolveFromRow(row, target);
    return {
      configured: resolved.credentials !== null,
      source: resolved.credentials?.source ?? null,
      clientIdLast4: last4(resolved.credentials?.clientId),
      storedSecretUnreadable: resolved.storedSecretUnreadable,
      savedInCms: row[target].clientId !== null,
    };
  };
  const environments = { sandbox: statusOf('sandbox'), live: statusOf('live') };
  return { sandbox: false, environment, environmentSource: source, active: environments[environment], environments };
}

export interface StoreAffiliatePayPalCredentialsInput {
  environment: AffiliatePayPalEnvironment;
  /** Null or blank: keep the client id saved for that environment. */
  clientId?: string | null;
  /** Null or blank: keep the secret saved for that environment. */
  secret?: string | null;
}

/**
 * Saves the PayPal configuration: the environment becomes the active one; a client id and a secret
 * given for it replace the saved ones (the secret encrypted). The caller verified them with PayPal
 * first (`saveAffiliatePayPalCredentialsNow`). Verifies an ADMIN on a satisfied second factor itself
 * (`requireCmsAdmin()`, throws `Unauthorized` / `Forbidden`), refuses on the public sandbox (throws),
 * writes with the service role, then drops the cached row and every cached PayPal token. Throws a
 * generic error when the write fails.
 */
export async function storeAffiliatePayPalCredentials(input: StoreAffiliatePayPalCredentialsInput): Promise<void> {
  const { supabase } = await requireCmsAdmin();
  if (isPayPalSandboxDeployment()) throw new Error('PayPal credentials are not saved on the sandbox.');
  if (!isAffiliatePayPalEnvironment(input.environment)) throw new Error('Unknown PayPal environment.');

  const { data, error: readError } = await supabase
    .from('site_settings')
    .select('value')
    .eq('key', AFFILIATE_PAYPAL_SETTINGS_KEY)
    .maybeSingle();
  if (readError) {
    console.error('[affiliates] Could not read the saved PayPal credentials before saving', {
      code: (readError as { code?: unknown }).code ?? null,
    });
    throw new Error('Failed to save the PayPal credentials.');
  }
  const current = asRecord((data as { value?: unknown } | null)?.value);
  const entry = { ...asRecord(current[input.environment]) };
  const clientId = typeof input.clientId === 'string' && input.clientId.trim() ? cleanClientId(input.clientId) : null;
  if (typeof input.clientId === 'string' && input.clientId.trim() && !clientId) throw new Error('Invalid PayPal client id.');
  if (clientId) entry['clientId'] = clientId;
  const secret = typeof input.secret === 'string' ? input.secret.trim() : '';
  if (secret) {
    if (secret.length > AFFILIATE_PAYPAL_CREDENTIAL_MAX_LENGTH) throw new Error('Invalid PayPal secret.');
    entry['secret'] = encryptWithEnvKey(secret, paypalSecretSlot(input.environment));
  }
  const next = { ...current, environment: input.environment, [input.environment]: entry, updatedAt: new Date().toISOString() };

  const { error } = await supabase.from('site_settings').upsert({ key: AFFILIATE_PAYPAL_SETTINGS_KEY, value: next as unknown as Json });
  if (error) {
    console.error('[affiliates] Could not save the PayPal credentials', { code: (error as { code?: unknown }).code ?? null });
    throw new Error('Failed to save the PayPal credentials.');
  }
  clearAffiliatePayPalCredentialsCache();
  clearAffiliatePayPalTokenCache();
}

/**
 * The credentials a save would use for an environment, for the verification before the save: the
 * given client id and secret, each falling back to what is saved in the CMS for that environment,
 * then to the environment pair (both from the same source). Null when no pair results. Never on the
 * public sandbox.
 */
export async function previewAffiliatePayPalCredentials(input: StoreAffiliatePayPalCredentialsInput): Promise<AffiliatePayPalCredentials | null> {
  if (isPayPalSandboxDeployment()) return null;
  const environment = input.environment;
  const typedClientId = typeof input.clientId === 'string' && input.clientId.trim() ? cleanClientId(input.clientId) : null;
  const typedSecret = typeof input.secret === 'string' && input.secret.trim() ? input.secret.trim() : null;
  if (typedClientId && typedSecret) return { environment, clientId: typedClientId, secret: typedSecret };
  const row = await loadAffiliatePayPalStoredRow(true);
  const stored = row[environment];
  const storedSecret = tryDecryptWithEnvKey(stored.secret, paypalSecretSlot(environment));
  const clientId = typedClientId ?? stored.clientId;
  const secret = typedSecret ?? storedSecret;
  if (clientId && secret) return { environment, clientId, secret };
  if (!typedClientId && !typedSecret) {
    const resolved = resolveFromRow(row, environment).credentials;
    return resolved ? { environment, clientId: resolved.clientId, secret: resolved.secret } : null;
  }
  return null;
}
