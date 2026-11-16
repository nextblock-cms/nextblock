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
// async entry points (webhook, checkout, coupon ops) — DB values win, and a field removed or
// cleared there gives its name back to the deployment's own value.
// The Freemius developer key pair (one pair for every product of the account) is the
// exception: resolveFreemiusDeveloperCredentialCandidates() reads it (CMS developer fields,
// then the developer env names, then the legacy names) for freemius-developer-api.ts, the only
// module that signs with it, and it is never written into process.env.
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
import { forgetFreemiusDeveloperCaches, getFreemiusDeveloperStatus } from './freemius-developer-api';
import { parseFreemiusCheckoutCredentialsMap } from './freemius-key-policy';
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
  'freemiusDeveloperSecretKey',
] as const;
type PaymentSecretField = (typeof PAYMENT_SECRET_FIELDS)[number];

/**
 * The stored secrets CMS → Payments shows, each with a remove box (`SavePaymentCredentialsInput.remove`):
 * every field of `payment_secret` but the Freemius sandbox key, which the form never saves.
 */
const REMOVABLE_PAYMENT_SECRET_FIELDS = [
  'stripeSecretKey',
  'stripeWebhookSecret',
  'freemiusSecretKey',
  'freemiusApiKey',
  'freemiusDeveloperSecretKey',
] as const satisfies readonly PaymentSecretField[];
export type RemovablePaymentSecret = (typeof REMOVABLE_PAYMENT_SECRET_FIELDS)[number];

function isRemovablePaymentSecret(field: unknown): field is RemovablePaymentSecret {
  return (REMOVABLE_PAYMENT_SECRET_FIELDS as readonly unknown[]).includes(field);
}

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

/** The payment rows as last read. */
type PaymentRows = {
  secret: Row;
  public: Row;
  /**
   * Whether the database answered each read (a missing row is an answer: nothing stored). A failed
   * read leaves its row empty, so the resolvers fall back to the env as before, but only an answered
   * row tells hydrateFreemiusEnvFromDb that a field it wrote is gone: a database blip must not swap
   * the CMS keys for the deployment's.
   */
  answered: { secret: boolean; public: boolean };
};

let cache: ({ at: number } & PaymentRows) | null = null;

function asRecord(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
}

async function loadPaymentRows(force = false): Promise<PaymentRows> {
  // The sandbox neither saves nor reads the payment rows, so Stripe and Freemius resolve from its
  // env only. Its admin login is public: a visitor can write `payment_public` over PostgREST (the
  // factor-less demo admin passes is_admin_mfa()) or through Cortex's DB tool, and
  // hydrateFreemiusEnvFromDb would copy their Freemius ids into process.env for every later
  // request. No read and no cache entry (like resolveEmailServerConfig).
  if (isSandboxEnvironment()) {
    return { secret: {}, public: {}, answered: { secret: false, public: false } };
  }

  const now = Date.now();
  if (!force && cache && now - cache.at < CACHE_TTL_MS) {
    return { secret: cache.secret, public: cache.public, answered: cache.answered };
  }

  let secret: Row = {};
  let pub: Row = {};
  let answered = { secret: false, public: false };
  try {
    const supabase = getServiceRoleSupabaseClient();
    const [secretRead, publicRead] = await Promise.all([
      supabase.from('site_settings').select('value').eq('key', PAYMENT_SECRET_KEY).maybeSingle(),
      supabase.from('site_settings').select('value').eq('key', PAYMENT_PUBLIC_KEY).maybeSingle(),
    ]);
    secret = asRecord(secretRead.data?.value);
    pub = asRecord(publicRead.data?.value);
    answered = { secret: !secretRead.error, public: !publicRead.error };
  } catch {
    // No service-role key (unconfigured instance) — fall back to env-only resolution.
  }

  cache = { at: now, secret, public: pub, answered };
  return { secret, public: pub, answered };
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
 * What hydrateFreemiusEnvFromDb wrote over each FREEMIUS_* name, and what the deployment had set
 * there before. The legacy FREEMIUS_PUBLIC_KEY / FREEMIUS_SECRET_KEY names hold the developer pair
 * on installs that run Sync from Freemius, while the CMS single-product fields hydrate into the
 * same names: the developer pair is resolved from the deployment's own value. It is also what a
 * field removed or cleared in the CMS gives the name back.
 */
const hydratedFreemiusEnv = new Map<string, { original: string | undefined; written: string }>();

/**
 * Writes a FREEMIUS_* name from the database (DB wins). When the database holds no value for it any
 * more (`answered`: the row was read, and the field is empty, removed or cannot be opened), the value
 * an earlier hydration wrote is taken back: the deployment's own value returns, or the name is
 * deleted if the deployment set none. Until 0.23.4 a cleared Product ID, public key or secret stayed
 * in process.env until the process restarted. A value hydration did not write (the deployment's, or
 * one the env changed to since) is never touched.
 */
function hydrateFreemiusEnvValue(envName: string, value: string | null, answered: boolean): void {
  const next = typeof value === 'string' ? value.trim() : '';
  const current = process.env[envName];
  const previous = hydratedFreemiusEnv.get(envName);

  if (!next) {
    if (!answered || !previous) {
      return;
    }

    hydratedFreemiusEnv.delete(envName);

    if (current !== previous.written) {
      return;
    }

    if (previous.original === undefined) {
      delete process.env[envName];
    } else {
      process.env[envName] = previous.original;
    }
    return;
  }

  // The deployment's value is what was there before the first overwrite, unless the env changed since.
  const original = previous && current === previous.written ? previous.original : current;

  hydratedFreemiusEnv.set(envName, { original, written: next });
  process.env[envName] = next;
}

/** An env value without surrounding whitespace or matching quotes (as readFreemiusEnvValue reads them). */
function normalizeEnvValue(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') {
    return null;
  }

  const trimmed = raw.trim();

  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim() || null;
  }

  return trimmed || null;
}

/** The value the deployment set for a FREEMIUS_* name, even after hydrateFreemiusEnvFromDb wrote over it. */
function readFreemiusDeploymentEnv(envName: string): string | null {
  const current = process.env[envName];
  const hydrated = hydratedFreemiusEnv.get(envName);

  return normalizeEnvValue(hydrated && current === hydrated.written ? hydrated.original : current);
}

/**
 * Make the synchronous FREEMIUS_* env reads DB-aware by writing any configured DB
 * values into process.env (DB wins). A field removed or cleared in the database gives
 * its name back to the deployment's value (hydrateFreemiusEnvValue); a failed read
 * changes nothing. Idempotent and cheap (cached); call at async entry points before
 * the package's sync credential helpers run. Writes nothing on the sandbox, where
 * loadPaymentRows reads no row. The developer key pair is never written into
 * process.env (resolveFreemiusDeveloperCredentialCandidates reads it).
 */
export async function hydrateFreemiusEnvFromDb(): Promise<void> {
  // Best-effort overlay: a failure here must never break checkout/webhook/coupon flows,
  // which still resolve from env on their own.
  try {
    const { secret, public: pub, answered } = await loadPaymentRows();
    const freemiusPublic = asRecord(pub['freemius']);
    const fromSecret = (envName: string, field: PaymentSecretField) =>
      hydrateFreemiusEnvValue(envName, decryptField(secret, field), answered.secret);
    const fromPublic = (envName: string, key: string) =>
      hydrateFreemiusEnvValue(
        envName,
        typeof freemiusPublic[key] === 'string' ? (freemiusPublic[key] as string) : null,
        answered.public
      );

    fromSecret('FREEMIUS_SECRET_KEY', 'freemiusSecretKey');
    fromSecret('FREEMIUS_API_KEY', 'freemiusApiKey');
    fromSecret('FREEMIUS_ECOMMERCE_SANDBOX_SECRET_KEY', 'freemiusSandboxSecretKey');
    fromPublic('FREEMIUS_PUBLIC_KEY', 'publicKey');
    fromPublic('FREEMIUS_PRODUCT_ID', 'productId');
    fromPublic('FREEMIUS_DEVELOPER_ID', 'developerId');
  } catch (error) {
    console.warn('[payment-config] Could not hydrate Freemius credentials from the database:', error);
  }
}

// --- Freemius developer key pair ----------------------------------------------

/**
 * Where a developer key pair comes from: the CMS developer fields (`cms`), the
 * FREEMIUS_DEVELOPER_PUBLIC_KEY / FREEMIUS_DEVELOPER_SECRET_KEY env names (`env`), or the
 * single-product names, CMS (`cms-legacy`) or FREEMIUS_PUBLIC_KEY / FREEMIUS_SECRET_KEY as the
 * deployment set them (`env-legacy`), which count only when Freemius accepts them at developer scope.
 */
export type FreemiusDeveloperCredentialSource = 'cms' | 'env' | 'cms-legacy' | 'env-legacy';

export interface FreemiusDeveloperCredentials {
  developerId: string;
  publicKey: string;
  secretKey: string;
  source: FreemiusDeveloperCredentialSource;
}

/** A key sent in the Authorization header: printable ASCII, no spaces. */
const HEADER_SAFE_KEY = /^[\x21-\x7e]{1,256}$/;

/**
 * Every configured Freemius developer key pair, most authoritative first and without duplicates:
 * the CMS developer fields, the developer env names, then the CMS single-product fields and the
 * deployment's legacy FREEMIUS_PUBLIC_KEY / FREEMIUS_SECRET_KEY (which hold the developer pair on
 * installs that run Sync from Freemius). Nothing here asks Freemius: freemius-developer-api.ts
 * uses a pair only once Freemius accepts it. Empty without a numeric developer id (CMS first,
 * then FREEMIUS_DEVELOPER_ID). On the sandbox no row is read, so only the env pairs remain.
 * Holds the master key of the Freemius account: server-only, never logged or returned to a client.
 */
export async function resolveFreemiusDeveloperCredentialCandidates(): Promise<FreemiusDeveloperCredentials[]> {
  const { secret, public: pub } = await loadPaymentRows();
  const freemiusPublic = asRecord(pub['freemius']);
  const fromRow = (field: string) => normalizeEnvValue(typeof freemiusPublic[field] === 'string' ? (freemiusPublic[field] as string) : null);
  const developerId = fromRow('developerId') ?? readFreemiusDeploymentEnv('FREEMIUS_DEVELOPER_ID');

  if (!developerId || !/^[1-9]\d{0,19}$/.test(developerId)) {
    return [];
  }

  const pairs: Array<[FreemiusDeveloperCredentialSource, string | null, string | null]> = [
    ['cms', fromRow('developerPublicKey'), normalizeEnvValue(decryptField(secret, 'freemiusDeveloperSecretKey'))],
    ['env', readFreemiusDeploymentEnv('FREEMIUS_DEVELOPER_PUBLIC_KEY'), readFreemiusDeploymentEnv('FREEMIUS_DEVELOPER_SECRET_KEY')],
    ['cms-legacy', fromRow('publicKey'), normalizeEnvValue(decryptField(secret, 'freemiusSecretKey'))],
    ['env-legacy', readFreemiusDeploymentEnv('FREEMIUS_PUBLIC_KEY'), readFreemiusDeploymentEnv('FREEMIUS_SECRET_KEY')],
  ];
  const seen = new Set<string>();
  const candidates: FreemiusDeveloperCredentials[] = [];

  for (const [source, publicKey, secretKey] of pairs) {
    if (!publicKey || !secretKey || !HEADER_SAFE_KEY.test(publicKey) || secretKey.length > 256) continue;

    const identity = `${publicKey}\n${secretKey}`;

    if (seen.has(identity)) continue;

    seen.add(identity);
    candidates.push({ developerId, publicKey, secretKey, source });
  }

  return candidates;
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

  // A developer key pair covers every product of the account, so it is enough on its own. Asked
  // when the single-product keys are missing, and when they alone can open no checkout.
  let freemiusHasKeys = freemiusMissing.length === 0;

  if (!freemiusHasKeys) {
    freemiusHasKeys = await hasUsableFreemiusDeveloperPair().catch(() => false);
  } else if (await freemiusOneProductKeysOpenNoCheckout(freemiusPublic).catch(() => false)) {
    freemiusHasKeys = false;
    freemiusMissing.push(FREEMIUS_REFUSED_DEVELOPER_PAIR_MISSING);
  }

  return {
    stripe: { hasKeys: stripeMissing.length === 0, missing: stripeMissing },
    freemius: { hasKeys: freemiusHasKeys, missing: freemiusHasKeys ? [] : freemiusMissing },
  };
}

/** What readiness says Freemius lacks when Freemius refuses a dedicated developer pair and nothing else can open a checkout. */
const FREEMIUS_REFUSED_DEVELOPER_PAIR_MISSING = 'Developer key pair Freemius accepts, or a Product ID';

/**
 * The one-product keys are configured, yet, as far as memory knows, they open no checkout at all:
 * no product has keys bound that can open one (FREEMIUS_PRODUCT_ID empty, no
 * FREEMIUS_CHECKOUT_PRODUCTS_JSON entry with a `publicKey`), and Freemius refuses a dedicated
 * developer pair, so the developer pair reads no product's keys and the key policy
 * (`decideFreemiusOneProductStandIn`) lets the one-product keys stand in for none. Read as ready,
 * that showed buy buttons whose checkouts and webhooks all answered 503. Never waits on Freemius
 * (`getFreemiusDeveloperStatus({ wait: false })`: a pair not yet checked, or Freemius unreachable,
 * keeps the store ready), and asks about the pair only when a dedicated one exists.
 */
async function freemiusOneProductKeysOpenNoCheckout(freemiusPublic: Row): Promise<boolean> {
  if (isSandboxEnvironment()) {
    return false;
  }

  const productId = resolveConfigValue(
    typeof freemiusPublic['productId'] === 'string' ? (freemiusPublic['productId'] as string) : null,
    'FREEMIUS_PRODUCT_ID',
    { warnOnEnvFallback: false }
  );

  if (productId || freemiusCredentialsMapOpensCheckout(parseFreemiusCheckoutCredentialsMap())) {
    return false;
  }

  const candidates = await resolveFreemiusDeveloperCredentialCandidates();

  if (!candidates.some((credentials) => credentials.source === 'cms' || credentials.source === 'env')) {
    return false;
  }

  return (await getFreemiusDeveloperStatus({ wait: false })).state === 'refused';
}

/**
 * Some FREEMIUS_CHECKOUT_PRODUCTS_JSON entry opens its product's checkout whatever the developer
 * pair says: it has a `publicKey`, the checkout's own test (`resolveFreemiusBoundCheckoutCredentials`).
 * An entry without one opens a checkout only through the developer pair, and binds its product, so
 * the one-product keys never stand in for it: such entries count only through the pair's state,
 * which `freemiusOneProductKeysOpenNoCheckout` reads next (a usable pair, or no dedicated pair,
 * keeps the store ready; a refused dedicated pair does not). Review 2026-11-13, round 3: counting
 * every entry kept the store ready while each checkout answered 503.
 */
function freemiusCredentialsMapOpensCheckout(credentialsMap: Record<string, { publicKey?: unknown } | null | undefined> | null): boolean {
  return Object.values(credentialsMap ?? {}).some((entry) => Boolean(entry?.publicKey));
}

/** The developer pair states that leave Freemius ready (`refused` and `missing` do not). */
const USABLE_FREEMIUS_DEVELOPER_STATES: ReadonlySet<string> = new Set(['working', 'unchecked', 'unreachable']);

/**
 * Whether a configured Freemius developer key pair makes the store Freemius-ready. Store readiness
 * runs during public renders (buy buttons, product pages, the checkout preflight), so this never
 * waits on Freemius: a configured pair counts unless a verdict already says Freemius refused it,
 * and the verdict is checked in the background (`getFreemiusDeveloperStatus({ wait: false })`).
 * Checkout itself still uses the pair only once Freemius accepts it. On the sandbox, whose checkout
 * is simulated and which never uses the pair, a configured env pair is enough. With the one-product
 * keys set, `freemiusOneProductKeysOpenNoCheckout` reads the same verdict.
 */
async function hasUsableFreemiusDeveloperPair(): Promise<boolean> {
  if (isSandboxEnvironment()) {
    return (await resolveFreemiusDeveloperCredentialCandidates()).length > 0;
  }

  const developer = await getFreemiusDeveloperStatus({ wait: false });

  return USABLE_FREEMIUS_DEVELOPER_STATES.has(developer.state);
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
    /** The developer key pair's public key (Freemius → My Profile → Keys). */
    developerPublicKey: string;
    hasDeveloperSecretKey: boolean;
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
      freemius: {
        developerId: '',
        developerPublicKey: '',
        hasDeveloperSecretKey: false,
        publicKey: '',
        productId: '',
        hasSecretKey: false,
        hasApiKey: false,
      },
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
      developerPublicKey: asStr(freemiusPublic['developerPublicKey']),
      hasDeveloperSecretKey: getSecretEnvelopeStatus(secret['freemiusDeveloperSecretKey']).hasStoredValue,
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
    /** The developer key pair (all products); its secret is `developerSecretKey`. */
    developerPublicKey: string;
    developerSecretKey?: string;
    publicKey: string;
    productId: string;
    secretKey?: string;
    apiKey?: string;
  };
  /**
   * Stored secrets to delete from `payment_secret` (the form's remove boxes). A blank field keeps
   * its stored secret unless it is named here; a key typed into the field replaces the stored one
   * either way. Names outside `RemovablePaymentSecret` are ignored.
   */
  remove?: readonly RemovablePaymentSecret[];
}

/**
 * Persist payment credentials. Public fields always overwrite; secret fields are
 * encrypted and only written when a new value is supplied (blank keeps the stored
 * secret, unless `remove` names it: then it is deleted from the row), and every stored
 * key from before 0.23.0 is re-sealed for its field on each save. Until 0.23.4 a stored
 * secret could not be deleted at all, so a leaked key kept verifying webhooks after a
 * rotation. Saves nothing on the sandbox (throws). Enforces ADMIN itself (throws
 * otherwise, before any read) and writes with the service role: `payment_secret` is a
 * secret row of `site_settings`, which no API session can write since migration 02038.
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
      developerPublicKey: input.freemius.developerPublicKey.trim(),
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
    ['freemiusDeveloperSecretKey', input.freemius.developerSecretKey],
  ] as const) {
    if (value && value.trim()) supplied.set(field, value.trim());
  }

  // A remove box over a blank field deletes that stored secret; a typed key replaces it anyway.
  const removed = new Set<PaymentSecretField>(
    (input.remove ?? []).filter((field) => isRemovablePaymentSecret(field) && !supplied.has(field))
  );

  // Read-merge: a blank field keeps its stored key. What is kept is re-sealed for its own field:
  // an envelope from before 0.23.0 opens in any slot (libs/db secret-crypto), so every save, one
  // that changes no key included, leaves each key bound to where it is stored.
  const { data: existing, error: readError } = await supabase
    .from('site_settings')
    .select('value')
    .eq('key', PAYMENT_SECRET_KEY)
    .maybeSingle();
  if (readError) {
    console.error('Error reading payment_secret settings:', readError.message);
    // Writing now could drop the keys that were not re-entered, and skipping a removal would
    // leave the key the admin asked to delete.
    if (supplied.size > 0 || removed.size > 0) throw new Error('Failed to save payment credentials.');
  } else {
    const current = asRecord(existing?.value);
    const nextValue: Row = { ...current };
    let changed = false;
    for (const field of PAYMENT_SECRET_FIELDS) {
      if (removed.has(field)) {
        if (Object.prototype.hasOwnProperty.call(nextValue, field)) {
          delete nextValue[field];
          changed = true;
        }
        continue;
      }

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
  // New keys are checked with Freemius again on their next use (and product keys re-read).
  forgetFreemiusDeveloperCaches();
}
