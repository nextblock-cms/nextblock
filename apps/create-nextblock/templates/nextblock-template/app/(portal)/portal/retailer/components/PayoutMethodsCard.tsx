import { Fragment, type ReactNode } from 'react';
import {
  AFFILIATE_GATEWAYS,
  affiliatePayoutMethodForGateway,
  type AffiliateGateway,
  type AffiliatePayoutMethod,
  type AffiliatesPayoutMethods,
} from '@nextblock-cms/affiliates';

import type { PortalCopyKey, PortalTranslate } from './portal-copy';

/** The kind of order each gateway's commissions come from, as the partner reads it. */
const ORDERS_COPY_KEYS: Readonly<Record<AffiliateGateway, PortalCopyKey>> = {
  STRIPE: 'affiliates.portal.payout_methods_orders_stripe',
  FREEMIUS: 'affiliates.portal.payout_methods_orders_freemius',
};

export interface PayoutMethodsCardProps {
  t: PortalTranslate;
  /** The program's method per gateway (`affiliates_settings.payoutMethods`, normalized). */
  methods: AffiliatesPayoutMethods;
  /** The site title: who sends the manual payouts. */
  siteName: string;
  /**
   * The partner's payout email when PayPal returned the last payout sent to it (02037): the PayPal run
   * does not send there again until the email changes, and the store pays them by hand meanwhile.
   */
  paypalReturnedTo?: string | null;
  /** The payout email form. */
  children?: ReactNode;
}

/** How one method pays, as a sentence. */
function methodLine(t: PortalTranslate, method: AffiliatePayoutMethod, siteName: string): string {
  if (method === 'paypal') return t('affiliates.portal.payout_methods_by_paypal');
  if (method === 'manual') return t('affiliates.portal.payout_methods_by_site', { site: siteName });
  return t('affiliates.portal.payout_methods_by_stripe');
}

/**
 * "How you get paid" on the portal payouts page (server-rendered), shown while the program pays some
 * gateway's commissions outside Stripe: by hand (02036) or with PayPal Payouts (02037). With one
 * method for every kind of order it is one sentence; otherwise it says, per kind of order, whether the
 * commission is transferred to the partner's Stripe account, sent to their PayPal account
 * automatically (or by Interac e-Transfer if they choose it), or sent to them directly by the store
 * (PayPal or Interac e-Transfer). A notice follows when PayPal returned the last payout sent to the
 * partner's current address, then the payout email form.
 */
export function PayoutMethodsCard({ t, methods, siteName, paypalReturnedTo = null, children }: PayoutMethodsCardProps) {
  const single = methods.stripeSales === methods.freemiusSales ? methods.stripeSales : null;
  return (
    <section aria-labelledby="portal-payout-methods-heading" className="rounded-lg border border-border bg-card p-6 text-card-foreground">
      <h2 id="portal-payout-methods-heading" className="text-lg font-semibold">
        {t('affiliates.portal.payout_methods_title')}
      </h2>
      {single === 'manual' ? (
        <p className="mt-2 text-sm text-muted-foreground">{t('affiliates.portal.payout_methods_manual', { site: siteName })}</p>
      ) : single ? (
        <p className="mt-2 text-sm text-muted-foreground">{methodLine(t, single, siteName)}</p>
      ) : (
        <div className="mt-2 space-y-3 text-sm">
          <p className="text-muted-foreground">{t('affiliates.portal.payout_methods_mixed_intro')}</p>
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]">
            {AFFILIATE_GATEWAYS.map((gateway) => (
              <Fragment key={gateway}>
                <dt className="font-medium text-foreground">{t(ORDERS_COPY_KEYS[gateway])}</dt>
                <dd className="text-muted-foreground">
                  {methodLine(t, affiliatePayoutMethodForGateway({ payoutMethods: methods }, gateway), siteName)}
                </dd>
              </Fragment>
            ))}
          </dl>
        </div>
      )}
      {paypalReturnedTo ? (
        <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-50">
          {t('affiliates.portal.payout_paypal_returned_notice', { email: paypalReturnedTo, site: siteName })}
        </p>
      ) : null}
      {children ? <div className="mt-4">{children}</div> : null}
    </section>
  );
}
