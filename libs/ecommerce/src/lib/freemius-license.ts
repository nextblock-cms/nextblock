import { Freemius } from '@freemius/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';

import { parseFreemiusTimestamp } from './freemius-license-claim';
import { hydrateFreemiusEnvFromDb } from './payment-config';
import { resolveFreemiusCheckoutCredentials } from './providers/freemius';
import type { FreemiusOrderLicense } from './freemius-license-types';

export type { FreemiusOrderLicense };

type SupabaseLikeClient = SupabaseClient<any>;

async function retrieveFreemiusLicenseEntity(
  productId: string | null | undefined,
  licenseId: string
) {
  if (!productId) {
    return null;
  }

  const credentials = resolveFreemiusCheckoutCredentials(productId);

  if (!credentials.apiKey || !credentials.secretKey || !credentials.publicKey) {
    return null;
  }

  const freemius = new Freemius({
    productId: Number(productId),
    apiKey: credentials.apiKey,
    secretKey: credentials.secretKey,
    publicKey: credentials.publicKey,
  });

  // Returns the License entity, whose `secret_key` is the activatable key.
  return freemius.api.license.retrieve(licenseId);
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

  let license: Awaited<ReturnType<typeof retrieveFreemiusLicenseEntity>> = null;

  try {
    // Overlay any CMS-configured Freemius credentials before resolving keys.
    await hydrateFreemiusEnvFromDb();
    license = await retrieveFreemiusLicenseEntity(
      order.freemius_product_id,
      String(order.freemius_license_id)
    );
  } catch (licenseError) {
    // Degrade gracefully: never let a license-lookup failure break the order /
    // success page. The customer still gets their key by email, and the UI
    // shows that fallback when the key is null.
    console.error('[Freemius License] Failed to retrieve license key:', licenseError);
  }

  // Reveal the key only for a license that is plausibly this order's own: the order's product,
  // created after the order. The license id on an order came from the checkout callback,
  // which until 2026-10-21 any guest could set to any license; this keeps a poisoned order
  // from ever showing another customer's key. A genuine but older license (bought before
  // the order) loses only the on-page key; the buyer still has it from the purchase email.
  const orderCreated = order.created_at ? Date.parse(order.created_at) : Number.NaN;
  const licenseCreated = parseFreemiusTimestamp((license as { created?: string | null } | null)?.created);
  const licenseBelongsToOrder =
    Boolean(license) &&
    String((license as { plugin_id?: unknown } | null)?.plugin_id ?? '') === String(order.freemius_product_id ?? '') &&
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
