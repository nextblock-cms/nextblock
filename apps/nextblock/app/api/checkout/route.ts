import { NextResponse } from 'next/server';
import { getPaymentProvider, getProviderReadiness } from '@nextblock-cms/ecommerce/server';
import { createClient, isSandboxEnvironment, verifyPackageOnline } from '@nextblock-cms/db/server';
import { normalizeCustomerAddress } from '@nextblock-cms/ecommerce';
import { resolveAttributionForCheckout } from '../../../lib/affiliates/attribution';
import { z } from '../../../lib/zod-config';

// Mirrors MAX_CHECKOUT_LINE_QUANTITY in the ecommerce providers (checkout-items.ts), which
// re-check and merge the lines before pricing them. The route rejects the shape up front so
// a negative, fractional or absurd quantity never reaches inventory, totals or order rows.
const MAX_CHECKOUT_LINE_QUANTITY = 10_000;
const checkoutItemSchema = z.looseObject({
  // `guid`, not `uuid`: Postgres accepts any 8-4-4-4-12 hex id (seed and fixture products
  // are not RFC-version-tagged).
  product_id: z.guid(),
  variant_id: z.union([z.guid(), z.literal('')]).nullish(),
  quantity: z.number().int().positive().max(MAX_CHECKOUT_LINE_QUANTITY),
});
const checkoutItemsSchema = z.array(checkoutItemSchema).min(1);

function jsonError(errorKey: string, error: string, status: number) {
  return NextResponse.json({ error, errorKey }, { status });
}

/** The English text of the seeded `ecommerce.sandbox_notice` translation (02004). */
const SANDBOX_CHECKOUT_NOTICE =
  'This is a Sandbox environment. The Freemius checkout is skipped here for demo purposes.';

function resolveProviderFromItem(item: any): 'stripe' | 'freemius' | null {
  if (item?.provider === 'stripe' || item?.provider === 'freemius') {
    return item.provider;
  }

  if (item?.payment_provider === 'stripe' || item?.payment_provider === 'freemius') {
    return item.payment_provider;
  }

  if (item?.product_type === 'digital') {
    return 'freemius';
  }

  if (item?.product_type === 'physical') {
    return 'stripe';
  }

  if (item?.freemius_product_id) {
    return 'freemius';
  }

  return null;
}

export async function POST(req: Request) {
  // The public sandbox (published admin login, resets every 15 minutes) simulates every
  // purchase in the storefront's checkout and never calls this route, so a request here is
  // scripted. Refuse it first: before the package check, the body, attribution, the cookie
  // client or any provider, so the sandbox never opens a provider session, writes a pending
  // order or spends a coupon redemption.
  if (isSandboxEnvironment()) {
    return jsonError('ecommerce.sandbox_notice', SANDBOX_CHECKOUT_NOTICE, 403);
  }

  try {
    const isOnline = await verifyPackageOnline('ecommerce');
    if (!isOnline) {
      return jsonError(
        'ecommerce.checkout_license_inactive',
        'Ecommerce module license is inactive',
        403
      );
    }

    const body = await req.json();
    const {
      items,
      customerEmail,
      customerPhone,
      billingAddress,
      shippingAddress,
      shippingMethodId,
      currencyCode,
      locale,
      couponCode,
      couponContextItems,
    } = body;
    
    if (!Array.isArray(items) || !checkoutItemsSchema.safeParse(items).success) {
      return jsonError(
        'ecommerce.checkout_invalid_items',
        'Invalid items data',
        400
      );
    }

    // The coupon quote prices the whole cart (every provider's lines) and must meet the
    // same bar as the lines being paid for. An absent or empty list means "this cart".
    const hasCouponContextItems =
      Array.isArray(couponContextItems) && couponContextItems.length > 0;

    if (hasCouponContextItems && !checkoutItemsSchema.safeParse(couponContextItems).success) {
      return jsonError(
        'ecommerce.checkout_invalid_items',
        'Invalid items data',
        400
      );
    }

    const providerNames = Array.from(
      new Set(items.map((item) => resolveProviderFromItem(item)).filter(Boolean))
    ) as Array<'stripe' | 'freemius'>;

    if (providerNames.length === 0) {
      return jsonError(
        'ecommerce.checkout_provider_items_required',
        'Each checkout request must include provider-aware cart items.',
        400
      );
    }

    if (providerNames.length > 1) {
      return jsonError(
        'ecommerce.checkout_mixed_provider_steps',
        'Mixed-provider carts must be checked out in separate steps.',
        400
      );
    }

    const providerName = providerNames[0];

    if (providerName === 'freemius' && items.length !== 1) {
      return jsonError(
        'ecommerce.checkout_freemius_single_item',
        'Freemius items must be checked out one at a time.',
        400
      );
    }

    if (!billingAddress) {
      return jsonError(
        'ecommerce.checkout_billing_address_required',
        'Billing address is required',
        400
      );
    }

    // Preflight: refuse before the provider writes anything. StripeProvider inserts a
    // pending `orders` row and can burn a coupon redemption BEFORE it ever calls Stripe,
    // so an unconfigured store used to accumulate failed orders and spent coupons on
    // every attempt — and the shopper got Stripe's raw "Invalid API Key" string back.
    const readiness = await getProviderReadiness(providerName);
    if (!readiness.ready) {
      console.error(
        `Checkout blocked: ${readiness.label} is not ready (missing: ${readiness.missing.join(', ') || 'unknown'})`
      );
      return jsonError(
        'ecommerce.checkout_payments_unavailable',
        'This store is not able to take payments right now. Please contact the seller to complete your purchase.',
        503
      );
    }

    const supabase = createClient();
    const provider = getPaymentProvider(providerName);

    const { data: { user } } = await supabase.auth.getUser();
    const userId = user?.id;
    const resolvedCustomerEmail = user?.email || customerEmail || null;

    // NextBlock Affiliates: the partner this sale is credited to, from the signed storefront
    // token in the cart or the referral cookie. Never read from the body as an id; null when
    // the package is off, nothing applies, or anything fails (checkout goes on unattributed).
    const attribution = await resolveAttributionForCheckout({ body, user });

    const { url, error, errorKey, errorParams, errorStatus, customProps } =
      await provider.createCheckoutSession({
      items,
      customerEmail: resolvedCustomerEmail,
      customerPhone,
      userId,
      billingAddress: normalizeCustomerAddress(billingAddress) ?? billingAddress,
      shippingAddress:
        providerName === 'stripe'
          ? normalizeCustomerAddress(shippingAddress)
          : null,
      // The provider re-reads the method (cost, threshold, zone) from the DB by this id.
      shippingMethodId:
        providerName === 'stripe' && typeof shippingMethodId === 'string' && shippingMethodId.trim()
          ? shippingMethodId.trim()
          : null,
      currencyCode: typeof currencyCode === 'string' ? currencyCode : null,
      locale: typeof locale === 'string' ? locale : null,
      couponCode: typeof couponCode === 'string' ? couponCode : null,
      couponContextItems: hasCouponContextItems ? couponContextItems : items,
      attribution: attribution
        ? {
            affiliateId: attribution.affiliateId,
            source: attribution.source,
            baseCurrency: attribution.baseCurrency,
          }
        : null,
    });

    if (error) {
      console.error('Checkout Error:', error);
      return NextResponse.json(
        { error, errorKey, errorParams },
        { status: errorStatus ?? 500 }
      );
    }

    return NextResponse.json({ url, customProps });
  } catch (err: any) {
    console.error('Checkout API Error:', err);
    return jsonError(
      'ecommerce.checkout_internal_server_error',
      'Internal Server Error',
      500
    );
  }
}
