import { Freemius } from '@freemius/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isSandboxEnvironment } from '@nextblock-cms/db/server';

import {
  freemiusDeveloperRequest,
  isFreemiusApiError,
  orNullWhenNotFound,
  toFreemiusId,
  withFreemiusDeveloperScope,
} from './freemius-developer-api';
import { parseFreemiusTimestamp } from './freemius-license-claim';
import { hydrateFreemiusEnvFromDb } from './payment-config';
import { resolveFreemiusCheckoutCredentials } from './providers/freemius';
import type { FreemiusOrderLicense } from './freemius-license-types';

export type { FreemiusOrderLicense };

type SupabaseLikeClient = SupabaseClient<any>;

type FreemiusLicenseEntity = {
  created?: string | null;
  expiration?: string | null;
  id?: string | number | null;
  is_cancelled?: boolean | null;
  plan_id?: string | number | null;
  plugin_id?: string | number | null;
  secret_key?: string | null;
};

/**
 * The License entity, whose `secret_key` is the activatable key: read with the developer key pair
 * when it works and the account owns the product, else with the product's bearer. Null when it
 * does not exist, without credentials, or for ids that are not Freemius ids.
 */
async function retrieveFreemiusLicenseEntity(
  productId: string | null | undefined,
  licenseId: string
): Promise<FreemiusLicenseEntity | null> {
  const freemiusProductId = toFreemiusId(productId);
  const freemiusLicenseId = toFreemiusId(licenseId);

  if (!freemiusProductId || !freemiusLicenseId) {
    return null;
  }

  const viaDeveloper = await withFreemiusDeveloperScope(freemiusProductId, () =>
    orNullWhenNotFound(
      freemiusDeveloperRequest<FreemiusLicenseEntity>({
        path: `/plugins/${freemiusProductId}/licenses/${freemiusLicenseId}.json`,
      })
    )
  );

  if (viaDeveloper.handled) {
    return viaDeveloper.value && viaDeveloper.value.id ? viaDeveloper.value : null;
  }

  const credentials = resolveFreemiusCheckoutCredentials(freemiusProductId);

  if (!credentials.apiKey || !credentials.secretKey || !credentials.publicKey) {
    return null;
  }

  const freemius = new Freemius({
    productId: Number(freemiusProductId),
    apiKey: credentials.apiKey,
    secretKey: credentials.secretKey,
    publicKey: credentials.publicKey,
  });

  return (await freemius.api.license.retrieve(freemiusLicenseId)) as FreemiusLicenseEntity | null;
}

/* -------------------------------------------------------------- license reads --- */

/*
 * The checkout success page and the customer's order pages read the order's license on every
 * render, and each read is one request to Freemius: at developer scope since 2026-11-12, on the key
 * production's checkouts, license links, claims, coupon pushes and webhook checks share. One
 * free-trial checkout gives anyone an order page to reload (25 visits sent 25 license reads), so
 * the reads are kept in memory per (product, license) and limited per instance:
 * - a license Freemius returned is reused for LICENSE_CACHE_TTL_MS, and a miss (a 404, no
 *   credentials, a failed read) for LICENSE_MISS_TTL_MS, in a map of at most
 *   LICENSE_CACHE_MAX_ENTRIES entries (the oldest goes first);
 * - concurrent visits of one license share one request;
 * - at most LICENSE_READS_PER_MINUTE uncached reads start per minute; past that a visit reads
 *   nothing and the page shows its "key sent by email" fallback, as after a failed read.
 * A cached entity holds the license key in memory only (never persisted or logged), and
 * getFreemiusOrderLicense re-checks it against the order on every visit, cached or not.
 */
const LICENSE_CACHE_TTL_MS = 5 * 60_000;
const LICENSE_MISS_TTL_MS = 30_000;
const LICENSE_CACHE_MAX_ENTRIES = 500;
const LICENSE_READS_PER_MINUTE = 30;
const LICENSE_READ_WINDOW_MS = 60_000;

type CachedLicense = { entity: FreemiusLicenseEntity | null; expiresAt: number };

/** By `<product id>:<license id>`, oldest first (a refreshed entry moves to the end). */
const licenseCache = new Map<string, CachedLicense>();
/** Reads in flight by the same key, so concurrent visits share one request. */
const licenseReadsInFlight = new Map<string, Promise<FreemiusLicenseEntity | null>>();
/** When each uncached read of the last minute started, oldest first. */
const licenseReadStarts: number[] = [];
/** The last time the per-minute limit was logged (once a minute at most). */
let licenseLimitLoggedAt = 0;

/** Forgets every cached license and the per-minute read budget (tests, or after the keys changed). */
export function forgetFreemiusLicenseReads(): void {
  licenseCache.clear();
  licenseReadsInFlight.clear();
  licenseReadStarts.length = 0;
  licenseLimitLoggedAt = 0;
}

/** Only the fields the order pages use: the rest of the entity (the owner, the install counts) is never kept. */
function keepLicenseFields(entity: FreemiusLicenseEntity | null | undefined): FreemiusLicenseEntity | null {
  if (!entity || typeof entity !== 'object') {
    return null;
  }

  return {
    created: entity.created ?? null,
    expiration: entity.expiration ?? null,
    id: entity.id ?? null,
    is_cancelled: entity.is_cancelled ?? null,
    plan_id: entity.plan_id ?? null,
    plugin_id: entity.plugin_id ?? null,
    secret_key: entity.secret_key ?? null,
  };
}

function rememberLicense(key: string, entity: FreemiusLicenseEntity | null, ttlMs: number): void {
  licenseCache.delete(key);
  licenseCache.set(key, { entity, expiresAt: Date.now() + ttlMs });

  while (licenseCache.size > LICENSE_CACHE_MAX_ENTRIES) {
    const oldest = licenseCache.keys().next().value;

    if (oldest === undefined) break;
    licenseCache.delete(oldest);
  }
}

/** True, and counted, when another uncached read may start now. */
function takeLicenseReadSlot(now: number): boolean {
  while (licenseReadStarts.length > 0 && now - licenseReadStarts[0] >= LICENSE_READ_WINDOW_MS) {
    licenseReadStarts.shift();
  }

  if (licenseReadStarts.length >= LICENSE_READS_PER_MINUTE) {
    return false;
  }

  licenseReadStarts.push(now);
  return true;
}

/** A failed read for the log: its kind and status only (an SDK error can carry request details). */
function describeLicenseReadError(error: unknown): string {
  if (isFreemiusApiError(error)) {
    return error.status ? `${error.kind} (${error.status})` : error.kind;
  }

  return error instanceof Error ? error.name : 'unknown error';
}

/** One uncached read, remembered whatever comes of it. Never throws. */
async function loadFreemiusLicenseEntity(
  key: string,
  productId: string,
  licenseId: string
): Promise<FreemiusLicenseEntity | null> {
  try {
    // Overlay any CMS-configured Freemius credentials before resolving keys.
    await hydrateFreemiusEnvFromDb();
    const entity = keepLicenseFields(await retrieveFreemiusLicenseEntity(productId, licenseId));
    rememberLicense(key, entity, entity ? LICENSE_CACHE_TTL_MS : LICENSE_MISS_TTL_MS);
    return entity;
  } catch (error) {
    // Degrade gracefully: never let a license-lookup failure break the order / success page. The
    // customer still gets their key by email, and the UI shows that fallback when the key is null.
    console.error(`[Freemius License] Failed to retrieve license ${licenseId}: ${describeLicenseReadError(error)}`);
    rememberLicense(key, null, LICENSE_MISS_TTL_MS);
    return null;
  }
}

/**
 * The license entity of an order through the cache: null for ids that are not Freemius ids, a
 * license Freemius does not return, a failed read, and a read past this instance's per-minute
 * budget. Never throws.
 */
async function readFreemiusLicenseEntity(productId: unknown, licenseId: unknown): Promise<FreemiusLicenseEntity | null> {
  const freemiusProductId = toFreemiusId(productId);
  const freemiusLicenseId = toFreemiusId(licenseId);

  if (!freemiusProductId || !freemiusLicenseId) {
    return null;
  }

  const key = `${freemiusProductId}:${freemiusLicenseId}`;
  const now = Date.now();
  const cached = licenseCache.get(key);

  if (cached && cached.expiresAt > now) {
    return cached.entity;
  }

  const pending = licenseReadsInFlight.get(key);

  if (pending) {
    return pending;
  }

  if (!takeLicenseReadSlot(now)) {
    if (now - licenseLimitLoggedAt >= LICENSE_READ_WINDOW_MS) {
      licenseLimitLoggedAt = now;
      console.warn('[Freemius License] License reads are paused for this minute (per-instance limit); order pages show the emailed-key fallback.');
    }

    return null;
  }

  const read: Promise<FreemiusLicenseEntity | null> = loadFreemiusLicenseEntity(key, freemiusProductId, freemiusLicenseId).finally(() => {
    if (licenseReadsInFlight.get(key) === read) licenseReadsInFlight.delete(key);
  });
  licenseReadsInFlight.set(key, read);

  return read;
}

/**
 * Fetches the activatable Freemius license key for an order on demand.
 *
 * The key is never persisted locally — it is retrieved straight from Freemius
 * using the license id captured on the order at checkout time. Returns null for
 * non-Freemius orders or orders that have no license yet.
 *
 * Authorization is the caller's responsibility: this only reads what the passed
 * Supabase client can see, so pass an owner-scoped (RLS) client on customer
 * surfaces and the service-role client only right after checkout, keyed by the
 * order's own (unguessable) id.
 */
export async function getFreemiusOrderLicense(input: {
  orderId: string;
  client: SupabaseLikeClient;
}): Promise<FreemiusOrderLicense | null> {
  const { data: order, error } = await (input.client as any)
    .from('orders')
    .select(
      'id, provider, created_at, freemius_product_id, freemius_license_id, freemius_trial_ends_at'
    )
    .eq('id', input.orderId)
    .maybeSingle();

  if (error || !order) {
    return null;
  }

  if (order.provider !== 'freemius' || !order.freemius_license_id) {
    return null;
  }

  // The public sandbox reads no license at Freemius. Its admin login is published and its second
  // factor always passes, so a visitor can open any order's page and, over PostgREST, point an order
  // at any license id with any creation time: a read there would spend the operator's Freemius keys
  // on every visit and could show a real customer's key. The page shows its emailed-key fallback.
  const license = isSandboxEnvironment()
    ? null
    : await readFreemiusLicenseEntity(order.freemius_product_id, order.freemius_license_id);

  // Reveal the key only for a license that is plausibly this order's own: the order's product,
  // created after the order. The license id on an order came from the checkout callback,
  // which until 2026-10-21 any guest could set to any license; this keeps a poisoned order
  // from ever showing another customer's key. A genuine but older license (bought before
  // the order) loses only the on-page key; the buyer still has it from the purchase email.
  // A cached license goes through this check on every visit too.
  const orderCreated = order.created_at ? Date.parse(order.created_at) : Number.NaN;
  const licenseCreated = parseFreemiusTimestamp(license?.created);
  const licenseBelongsToOrder =
    Boolean(license) &&
    String(license?.plugin_id ?? '') === String(order.freemius_product_id ?? '') &&
    Number.isFinite(orderCreated) &&
    licenseCreated !== null &&
    licenseCreated >= orderCreated - 5 * 60_000;

  if (license && !licenseBelongsToOrder) {
    console.warn(
      `[Freemius License] Not revealing license ${order.freemius_license_id} on order ${order.id}: product or creation time does not match the order`
    );
  }

  return {
    licenseId: String(order.freemius_license_id),
    licenseKey: licenseBelongsToOrder ? license?.secret_key ?? null : null,
    planId: license?.plan_id != null ? String(license.plan_id) : null,
    expiration: license?.expiration ?? null,
    trialEndsAt: order.freemius_trial_ends_at ?? null,
    isCancelled: Boolean(license?.is_cancelled),
  };
}
