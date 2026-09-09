import 'server-only';

import { createClient, verifyPackageOnline } from '@nextblock-cms/db/server';
import { getStoreReadiness } from '@nextblock-cms/ecommerce/server';

/**
 * A store that has commerce switched on but cannot actually take money. This is easy to
 * end up in — the products, prices and pages all look finished — and the only symptom
 * used to be a shopper hitting a payment error at checkout. The banner makes the gap
 * visible in the CMS instead of on the storefront.
 */
export interface PaymentsReminder {
  /** Providers that are not ready, with what each is missing. */
  blocked: Array<{
    provider: 'stripe' | 'freemius';
    label: string;
    missing: string[];
  }>;
  /** Published products that currently cannot be bought because of the above. */
  affectedProducts: number;
}

/**
 * Best-effort reminder state for the CMS layout. Returns null (no banner) whenever
 * nagging would be wrong or the answer can't be determined — an unmigrated database,
 * an instance without commerce, or the sandbox.
 */
export async function getPaymentsReminder(): Promise<PaymentsReminder | null> {
  // The sandbox refuses to store live credentials at all (savePaymentCredentials throws),
  // so a "finish setting up payments" nag there is noise the operator cannot act on.
  if (process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') return null;

  try {
    if (!(await verifyPackageOnline('ecommerce'))) return null;

    const supabase = createClient();

    // Only ADMINs can act on this (the /cms/payments route is admin-only), so don't do
    // the work for anyone else.
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();
    if (profile?.role !== 'ADMIN') return null;

    const readiness = await getStoreReadiness();
    const unready = (['stripe', 'freemius'] as const)
      .map((provider) => readiness[provider])
      .filter((entry) => !entry.ready);

    if (unready.length === 0) return null;

    // A provider matters to this reminder only when the catalogue contains products
    // of the type routed through it. Do not treat a stale/accidental provider toggle as
    // usage: that produced a Stripe warning in digital-only stores with no Stripe keys.
    // Count across ALL statuses so a shop building a draft catalogue is warned before
    // it publishes rather than after.
    const usage = await Promise.all(
      unready.map(async (entry) => {
        const productType =
          entry.provider === 'stripe' ? 'physical' : 'digital';
        const [{ count: totalCount }, { count: activeCount }] =
          await Promise.all([
            supabase
              .from('products')
              .select('id', { count: 'exact', head: true })
              .eq('product_type', productType),
            supabase
              .from('products')
              .select('id', { count: 'exact', head: true })
              .eq('status', 'active')
              .eq('product_type', productType),
          ]);
        return {
          entry,
          inUse: (totalCount ?? 0) > 0,
          activeProducts: activeCount ?? 0,
        };
      }),
    );

    const relevant = usage.filter((item) => item.inUse);
    if (relevant.length === 0) return null;

    return {
      blocked: relevant.map(({ entry }) => ({
        provider: entry.provider,
        label: entry.label,
        missing: entry.missing,
      })),
      affectedProducts: relevant.reduce(
        (total, item) => total + item.activeProducts,
        0,
      ),
    };
  } catch {
    // Never let a reminder break the CMS shell.
    return null;
  }
}
