// Deep subpath, not '@nextblock-cms/ecommerce/server': that barrel re-exports every CMS
// commerce page, and each page's client components then ship on every page that renders
// blocks (see docs/05 "Public Page Performance Budget").
import { getStoreReadiness } from '@nextblock-cms/ecommerce/pages/cms/payments/queries';
import { PaymentReadinessProvider } from '@nextblock-cms/ecommerce/PaymentReadinessProvider';

/**
 * Supplies payment readiness to the buy controls beneath it.
 *
 * Deliberately NOT mounted in the root layout: readiness is only consulted by buy CTAs
 * and the checkout, so a blog post or a landing page should not pay for the lookup. Each
 * commerce block renderer wraps itself in this instead, which also means nested cases
 * (a product grid inside a section) are covered without anyone having to walk the block
 * tree looking for them.
 *
 * getStoreReadiness() is request-cached, so several of these on one page cost one read.
 * Any failure yields no readiness at all, and the context default ("everything ready")
 * keeps a working store working.
 */
export default async function PaymentReadinessBoundary({
  children,
}: {
  children: React.ReactNode;
}) {
  let readiness: { stripe: boolean; freemius: boolean } | null = null;

  try {
    const store = await getStoreReadiness();
    readiness = { stripe: store.stripe.ready, freemius: store.freemius.ready };
  } catch (error) {
    console.error('[PaymentReadinessBoundary] Could not resolve payment readiness:', error);
  }

  return <PaymentReadinessProvider readiness={readiness}>{children}</PaymentReadinessProvider>;
}
