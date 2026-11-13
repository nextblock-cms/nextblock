import Stripe from 'stripe';
import { resolveStripeSecretKey } from '../payment-config';

// The Stripe client is created lazily (not at module load) so the secret key can be
// resolved DB-first from the CMS, with an env fallback. Cached per resolved key so a
// rotation re-initializes the client.
let cachedClient: Stripe | null = null;
let cachedKey: string | null = null;

/**
 * Thrown when Stripe is asked for before any secret key has been configured. Callers
 * that can reach a shopper should preflight with `getProviderReadiness('stripe')`
 * instead of relying on this — it exists so a misconfiguration can never be mistaken
 * for a Stripe outage.
 */
export class StripeNotConfiguredError extends Error {
  constructor() {
    super(
      'Stripe is not configured: no secret key found in CMS → Payments or STRIPE_SECRET_KEY.'
    );
    this.name = 'StripeNotConfiguredError';
  }
}

/**
 * The mode of a Stripe secret key from its documented prefix: true for a live key (`sk_live_`,
 * restricted `rk_live_`), false for a test key (`sk_test_`, `rk_test_`; Stripe sandboxes use
 * test keys too), null for anything else.
 */
export function stripeSecretKeyLivemode(key: string | null | undefined): boolean | null {
  const value = typeof key === 'string' ? key.trim() : '';
  if (value.startsWith('sk_live_') || value.startsWith('rk_live_')) return true;
  if (value.startsWith('sk_test_') || value.startsWith('rk_test_')) return false;
  return null;
}

/**
 * The mode of the configured secret key (the one `getStripeClient()` uses), or null when none is
 * configured, its prefix is unknown or it cannot be read. A checkout records it on an attributed
 * order, so a test-mode sale is never paid out with live money (or the other way around).
 */
export async function resolveStripeKeyLivemode(): Promise<boolean | null> {
  try {
    return stripeSecretKeyLivemode(await resolveStripeSecretKey());
  } catch {
    return null;
  }
}

export async function getStripeClient(): Promise<Stripe> {
  // Previously this substituted the literal 'sk_test_dummy' when nothing resolved, which
  // built a REAL Stripe client around a fake key. The first API call then failed with
  // Stripe's redacted "Invalid API Key provided: sk_test_*ummy" — an opaque message that
  // reached shoppers and told the store owner nothing about the actual cause.
  const secret = await resolveStripeSecretKey();
  if (!secret) {
    throw new StripeNotConfiguredError();
  }
  if (cachedClient && cachedKey === secret) {
    return cachedClient;
  }
  cachedClient = new Stripe(secret, { typescript: true });
  cachedKey = secret;
  return cachedClient;
}
