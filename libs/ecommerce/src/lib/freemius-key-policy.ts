import 'server-only';

import crypto from 'crypto';

import {
  confirmFreemiusOneProductKeys,
  describeFreemiusDeveloperPairs,
  getFreemiusDeveloperStatus,
  isLegacyFreemiusDeveloperSource,
  toFreemiusId,
  type FreemiusDeveloperPairFacts,
  type FreemiusDeveloperStatus,
} from './freemius-developer-api';

/**
 * Which configured Freemius keys a product may use, one policy for the checkout
 * (`resolveFreemiusProductCredentials`, providers/freemius.ts) and the webhook check
 * (`getFreemiusWebhookVerification`, freemius-order-sync.ts), so a key opens a product's checkout
 * exactly when it may verify that product's payment and refund webhooks.
 *
 * 1. The product's own keys, read with the developer key pair when the account owns the product.
 * 2. Its bound keys: its FREEMIUS_CHECKOUT_PRODUCTS_JSON entry, always, or the one-product keys
 *    (FREEMIUS_PUBLIC_KEY / FREEMIUS_SECRET_KEY, or their Freemius-sandbox twins) when
 *    FREEMIUS_PRODUCT_ID names it, unless they are, or may be, a developer key pair
 *    (`freemiusKeysMayBeDeveloperPair`). When step 1 failed (Freemius unreachable, throttled), these
 *    are the only keys left, and they work offline: the operator declared them that product's.
 * 3. The one-product keys standing in for a product with no bound keys (no entry, the Product ID
 *    left empty, which the Payments screen allowed): `decideFreemiusOneProductStandIn`. Never where
 *    they are, or may be, the developer key pair, whose secret would then verify every product's
 *    webhooks and whose public key would reach buyers' browsers.
 *
 * The one-product names double as a developer pair: with a developer id set they are tried as one
 * (sources `cms-legacy` / `env-legacy`), and nextblock.dev runs that way. Working, they ARE the
 * developer pair; refused, they are a product's keys or a revoked developer pair, which only
 * Freemius can tell apart (`confirmFreemiusOneProductKeys`).
 */

/** One product's entry in FREEMIUS_CHECKOUT_PRODUCTS_JSON. */
export type FreemiusCheckoutCredentialEntry = {
  publicKey?: string;
  secretKey?: string;
  apiKey?: string;
};

/** A FREEMIUS_* value without surrounding whitespace or matching quotes; null when unset. */
export function readFreemiusEnvValue(name: keyof NodeJS.ProcessEnv) {
  const raw = process.env[name];

  if (!raw) {
    return null;
  }

  const trimmed = raw.trim();

  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

/** A short hash of the FREEMIUS_CHECKOUT_PRODUCTS_JSON value whose parse failure was logged last. */
let loggedMalformedCredentialsMap: string | null = null;

/**
 * Says that FREEMIUS_CHECKOUT_PRODUCTS_JSON is not JSON, once per value, with the error's name and
 * position only. V8's message quotes the text around the fault (`..."ecretKey":sk_SUPERSE"... is not
 * valid JSON`), which can be part of a key, and the map is read on every webhook, forged ones
 * included: the message is never logged, and one malformed value writes one line however often it
 * is read. The value is remembered as a truncated SHA-256 only.
 */
function logMalformedCredentialsMap(raw: string, error: unknown): void {
  const fingerprint = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);

  if (fingerprint === loggedMalformedCredentialsMap) {
    return;
  }

  loggedMalformedCredentialsMap = fingerprint;
  const name = error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'Error';
  const position = error instanceof Error ? /\bposition (\d{1,9})\b/.exec(error.message)?.[1] ?? null : null;

  console.error(
    `[Freemius Checkout] FREEMIUS_CHECKOUT_PRODUCTS_JSON is not valid JSON (${name}${position ? ` at position ${position}` : ''}); ` +
      'no product keys are read from it.'
  );
}

/** FREEMIUS_CHECKOUT_PRODUCTS_JSON as `{ "<product id>": { publicKey, secretKey, apiKey } }`, or null. */
export function parseFreemiusCheckoutCredentialsMap(): Record<string, FreemiusCheckoutCredentialEntry> | null {
  const raw = readFreemiusEnvValue('FREEMIUS_CHECKOUT_PRODUCTS_JSON');

  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, FreemiusCheckoutCredentialEntry>;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    logMalformedCredentialsMap(raw, error);
    return null;
  }
}

/** The one-product keys as the store resolves them (CMS → Payments first, then the env). */
export function readFreemiusOneProductKeys() {
  return {
    publicKey: readFreemiusEnvValue('FREEMIUS_PUBLIC_KEY'),
    secretKey: readFreemiusEnvValue('FREEMIUS_SECRET_KEY'),
    apiKey: readFreemiusEnvValue('FREEMIUS_API_KEY'),
  };
}

/**
 * `productId` has no bound keys and the one-product keys are bound to no product: no
 * FREEMIUS_CHECKOUT_PRODUCTS_JSON entry (an entry, whatever it holds, is the product's only keys)
 * and FREEMIUS_PRODUCT_ID empty. Only then may the one-product keys stand in for it, and only as
 * far as `decideFreemiusOneProductStandIn` allows; the synchronous webhook check of older route
 * files applies this shape test alone (it cannot ask about the developer key pair).
 */
export function isUnboundFreemiusProduct(productId: string): boolean {
  if (readFreemiusEnvValue('FREEMIUS_PRODUCT_ID')) {
    return false;
  }

  const credentialsMap = parseFreemiusCheckoutCredentialsMap() ?? {};

  return !Object.prototype.hasOwnProperty.call(credentialsMap, productId);
}

/**
 * Whether `keys`, configured outside the developer fields (the one-product names as the store
 * resolves them, or their Freemius-sandbox twins), are, or may be, a developer key pair rather than
 * a product's keys, so that FREEMIUS_PRODUCT_ID's binding does not make them that product's:
 * (a) the working pair comes from the one-product names and holds one of them;
 * (b) a dedicated developer pair (CMS developer fields, FREEMIUS_DEVELOPER_*) holds one of them;
 * (c) Freemius accepted one of them at developer scope earlier in this instance's life (memory
 *     only), which covers a pair revoked while the instance runs.
 * The checkout's bound keys and the webhook check's bound secrets both follow it. It reads
 * configuration and memory only (never Freemius), so a binding it leaves standing works offline,
 * and it says yes when those facts cannot be read (the caller then refuses the keys). Never returns
 * key material.
 */
export async function freemiusKeysMayBeDeveloperPair(keys: { publicKey: string | null; secretKey: string | null }): Promise<boolean> {
  if (!keys.publicKey && !keys.secretKey) {
    return false;
  }

  const facts = await readPairFacts(keys);

  return facts === null || factsSayDeveloperPair(facts);
}

/** (a), (b) or (c) of `freemiusKeysMayBeDeveloperPair`, from facts already read. */
function factsSayDeveloperPair(facts: FreemiusDeveloperPairFacts): boolean {
  return facts.sharesWorkingLegacyKey || facts.sharesDedicatedKey || facts.sharesVerifiedKey;
}

/** Configured-pair facts about a key set, or null when they cannot be read (the caller then refuses). */
async function readPairFacts(keys: { publicKey: string | null; secretKey: string | null }): Promise<FreemiusDeveloperPairFacts | null> {
  try {
    return await describeFreemiusDeveloperPairs(keys);
  } catch {
    return null;
  }
}

/**
 * A log throttle for lines that unauthenticated requests can cause (a forged webhook, a public
 * checkout POST, while Freemius throttles the developer key): `true` at most once per `windowMs` per
 * key, for at most `maxKeys` keys a window, so neither the lines nor the memory grow with the
 * requests. A clock that went back counts as a new window.
 */
export function createFreemiusLogThrottle(options: { windowMs: number; maxKeys: number }): (key: string) => boolean {
  const loggedAt = new Map<string, number>();

  return (key: string) => {
    const now = Date.now();
    const last = loggedAt.get(key);
    const fresh = (at: number) => now >= at && now - at < options.windowMs;

    if (last !== undefined && fresh(last)) {
      return false;
    }

    if (last === undefined && loggedAt.size >= options.maxKeys) {
      for (const [id, at] of loggedAt) {
        if (!fresh(at)) loggedAt.delete(id);
      }

      // Still full of keys logged this window: say nothing more until they expire.
      if (loggedAt.size >= options.maxKeys) {
        return false;
      }
    }

    loggedAt.set(key, now);
    return true;
  };
}

/** What the developer key pair says about a product, for a caller's outcome and log line: never key material. */
export type FreemiusDeveloperFacts = {
  /** `getFreemiusDeveloperStatus()` (it waits on Freemius, so never `unchecked`); `unknown` when it failed. */
  state: FreemiusDeveloperStatus['state'] | 'unknown';
  /** Where the working pair comes from. */
  source: FreemiusDeveloperStatus['source'];
  /** The working pair's account lists the product. */
  owned: boolean;
};

/** Why the one-product keys may not stand in for a product (a log value, never key material). */
export type FreemiusOneProductStandInRefusal =
  /** The product's own key read failed: only its bound keys may be used meanwhile. */
  | 'product_key_read_failed'
  /** The product id is not a Freemius id (digits). */
  | 'invalid_product_id'
  /** It has bound keys (its JSON entry), or FREEMIUS_PRODUCT_ID binds the one-product keys to another product. */
  | 'bound_elsewhere'
  /** No one-product keys are configured. */
  | 'no_one_product_keys'
  /** The developer account owns the product: only its own key counts. */
  | 'owned_by_developer_account'
  /**
   * The one-product names hold the working developer pair, a key of a dedicated one, or a key
   * Freemius accepted at developer scope earlier (`freemiusKeysMayBeDeveloperPair`). Also the refusal
   * of FREEMIUS_PRODUCT_ID-bound keys that may be a developer pair, in the checkout's log line.
   */
  | 'one_product_keys_are_developer_pair'
  /** A dedicated developer pair is configured and Freemius refuses it (rotated or revoked). */
  | 'developer_pair_refused'
  /** Freemius could not be asked about the pair. */
  | 'developer_pair_unreachable'
  /** Freemius answered that the one-product keys are not this product's (`confirmFreemiusOneProductKeys`). */
  | 'one_product_keys_not_this_product'
  /**
   * Freemius did not confirm the one-product keys are this product's: it did not answer, this
   * instance sent its share of confirmations this minute, or the caller asked for no request.
   */
  | 'one_product_keys_unconfirmed';

export type FreemiusOneProductStandIn =
  | { allowed: true; developer: FreemiusDeveloperFacts }
  | { allowed: false; reason: FreemiusOneProductStandInRefusal; developer: FreemiusDeveloperFacts };

async function readDeveloperFacts(productId: string): Promise<FreemiusDeveloperFacts> {
  try {
    const status = await getFreemiusDeveloperStatus();
    const id = toFreemiusId(productId);

    return {
      state: status.state,
      source: status.source,
      owned: status.state === 'working' && id !== null && status.productIds.includes(id),
    };
  } catch {
    return { state: 'unknown', source: null, owned: false };
  }
}

/**
 * May the one-product keys stand in for `productId`, a product with no bound keys? Call it once the
 * product's own keys came to nothing: `getFreemiusProductKeys(productId)` returned null
 * (`keyReadFailed: false`; while the pair works that means an answered product list lacks the id)
 * or failed (`keyReadFailed: true`). Always returns the developer facts it read.
 *
 * - `missing` (no developer pair) or `sandbox`: yes, the one-product install as before, offline.
 * - `working`: only for a product the account does not own, never when the working pair comes from
 *   the one-product names (then they ARE the developer pair), nor when they are, or may be, a
 *   developer pair (`freemiusKeysMayBeDeveloperPair`). Restores webhooks and checkout for a product
 *   outside the developer account sold on the one-product keys with the Product ID left empty.
 * - `refused`: only when every configured pair is a one-product one (`cms-legacy` / `env-legacy`),
 *   Freemius never accepted those keys at developer scope in this instance's life, and it confirms
 *   they are THIS product's own keys (`confirmFreemiusOneProductKeys`, one product-scope request,
 *   cached): a one-product install that also filled in its developer id passes; a revoked developer
 *   pair left under those names (nextblock.dev keeps its pair there) passes for no product. A
 *   refused dedicated pair (rotated or revoked) never lets the one-product secret verify every
 *   product's webhooks. `confirm: false` sends no request in that case and refuses
 *   (`one_product_keys_unconfirmed`): the webhook check passes it until the event's signature
 *   matches the one-product secret, so a forger without that secret makes no request to Freemius.
 * - `unreachable`, `unchecked`, `unknown`: never.
 */
export async function decideFreemiusOneProductStandIn(
  productId: string,
  options: { keyReadFailed: boolean; confirm?: boolean }
): Promise<FreemiusOneProductStandIn> {
  const developer = await readDeveloperFacts(productId);
  const refuse = (reason: FreemiusOneProductStandInRefusal): FreemiusOneProductStandIn => ({ allowed: false, reason, developer });
  const allow: FreemiusOneProductStandIn = { allowed: true, developer };

  if (options.keyReadFailed) {
    return refuse('product_key_read_failed');
  }

  if (!toFreemiusId(productId)) {
    return refuse('invalid_product_id');
  }

  if (!isUnboundFreemiusProduct(productId)) {
    return refuse('bound_elsewhere');
  }

  const oneProduct = readFreemiusOneProductKeys();
  const oneProductKeys = { publicKey: oneProduct.publicKey, secretKey: oneProduct.secretKey };

  if (!oneProduct.publicKey && !oneProduct.secretKey) {
    return refuse('no_one_product_keys');
  }

  switch (developer.state) {
    case 'missing':
    case 'sandbox':
      return allow;
    case 'working': {
      if (developer.owned) {
        return refuse('owned_by_developer_account');
      }

      if (isLegacyFreemiusDeveloperSource(developer.source)) {
        return refuse('one_product_keys_are_developer_pair');
      }

      const pairs = await readPairFacts(oneProductKeys);

      return pairs && !factsSayDeveloperPair(pairs) ? allow : refuse('one_product_keys_are_developer_pair');
    }
    case 'refused': {
      const pairs = await readPairFacts(oneProductKeys);

      if (!pairs || pairs.sources.length === 0 || !pairs.sources.every(isLegacyFreemiusDeveloperSource)) {
        return refuse('developer_pair_refused');
      }

      if (factsSayDeveloperPair(pairs)) {
        // Freemius accepted these keys at developer scope earlier: a developer pair revoked since.
        return refuse('one_product_keys_are_developer_pair');
      }

      if (options.confirm === false) {
        return refuse('one_product_keys_unconfirmed');
      }

      const confirmation = await confirmFreemiusOneProductKeys(productId, oneProductKeys);

      if (confirmation === 'confirmed') {
        return allow;
      }

      return refuse(confirmation === 'refused' ? 'one_product_keys_not_this_product' : 'one_product_keys_unconfirmed');
    }
    default:
      return refuse('developer_pair_unreachable');
  }
}
