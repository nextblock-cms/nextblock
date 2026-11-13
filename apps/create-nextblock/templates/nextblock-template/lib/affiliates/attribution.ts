import 'server-only';

import { cookies } from 'next/headers';
import { AFFILIATE_REF_COOKIE } from '@nextblock-cms/affiliates';
import {
  resolveCheckoutAttribution,
  type AffiliateCheckoutAttribution,
  type AffiliateRepositoryClient,
} from '@nextblock-cms/affiliates/server';
import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';

import { CONSENT_COOKIE_NAME } from '../privacy/types';
import { hasDeclinedAffiliateMarketingConsent } from './referral-cookie';
import { verifyAffiliateStorefrontToken } from './storefront-token';
import { isAffiliatesProgramActive } from './package-state';

/**
 * Checkout attribution (ADDENDUM B4, B9), the app side of NextBlock Affiliates in
 * /api/checkout. It fails open for the store: no error of the affiliates package ever blocks a
 * checkout. (The post-payment commission sweep lives in ./refunds, beside the webhook hooks, so
 * the checkout route does not load the mailer.)
 */

/** Longest referral cookie value worth looking at (a handle is at most 32 characters). */
const REFERRAL_COOKIE_MAX_LENGTH = 64;

/** Longest buyer email passed to the self-referral check. */
const BUYER_EMAIL_MAX_LENGTH = 320;

export interface CheckoutAttributionRequest {
  /** The parsed /api/checkout JSON body; only `affiliateRef` and `customerEmail` are read. */
  body: unknown;
  /** The cookie session's user (`auth.getUser()`), or null for a guest. */
  user: { id?: string | null; email?: string | null } | null | undefined;
}

function readBodyField(body: unknown, field: string): unknown {
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>)[field] : undefined;
}

function shortString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface CheckoutCookies {
  /** The referral cookie's handle (at most 64 characters), or null. */
  referralHandle: string | null;
  /** The consent banner's record says `marketing: false` (the proxy's own rule, same parser). */
  marketingDeclined: boolean;
}

async function readCheckoutCookies(): Promise<CheckoutCookies> {
  try {
    const store = await cookies();
    return {
      referralHandle: shortString(store.get(AFFILIATE_REF_COOKIE)?.value, REFERRAL_COOKIE_MAX_LENGTH),
      marketingDeclined: hasDeclinedAffiliateMarketingConsent(store.get(CONSENT_COOKIE_NAME)?.value),
    };
  } catch {
    // No readable cookie store: no referral cookie and no recorded decision.
    return { referralHandle: null, marketingDeclined: false };
  }
}

/**
 * The partner a checkout is attributed to, or null. Only while the Affiliates package is
 * active, and never for a visitor whose consent record declines marketing cookies. The
 * storefront token from the cart (`body.affiliateRef`) counts only when its HMAC verifies; the
 * referral cookie is read from the request; the lib then decides against the database (ACTIVE,
 * approved, tier window, self-referral). Never throws: on any error the order is just not
 * attributed.
 */
export async function resolveAttributionForCheckout({
  body,
  user,
}: CheckoutAttributionRequest): Promise<AffiliateCheckoutAttribution | null> {
  try {
    if (!(await isAffiliatesProgramActive())) {
      return null;
    }

    const { referralHandle: cookieHandle, marketingDeclined } = await readCheckoutCookies();

    // The marketing choice applies to the storefront token too, as it does to the referral
    // cookie: a visitor who declined is never attributed. That covers a decline before the
    // storefront add, a decision made after it (the token sits in the cart's localStorage),
    // and a referral cookie the proxy has not expired yet (it does so only on the next
    // document navigation, and /checkout is usually reached by a client-side one).
    if (marketingDeclined) {
      return null;
    }

    const token = verifyAffiliateStorefrontToken(readBodyField(body, 'affiliateRef'));

    if (!token && !cookieHandle) {
      return null;
    }

    // The service role is needed for the partner's auth email (self-referral) and the partner
    // row; it is created only once there is something to resolve.
    return await resolveCheckoutAttribution({
      supabase: getServiceRoleSupabaseClient() as unknown as AffiliateRepositoryClient,
      token,
      cookieHandle,
      buyerUserId: shortString(user?.id, 64),
      buyerEmail:
        shortString(user?.email, BUYER_EMAIL_MAX_LENGTH) ??
        shortString(readBodyField(body, 'customerEmail'), BUYER_EMAIL_MAX_LENGTH),
    });
  } catch (error) {
    console.warn('[affiliates] Checkout attribution skipped:', describeError(error));
    return null;
  }
}
