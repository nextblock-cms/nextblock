import { PaymentsPage as PaymentsPageUI } from '@nextblock-cms/ecommerce/server';
import { verifyPackageOnline } from '@nextblock-cms/db/server';
import { affiliateGatewaysPaidByStripe } from '@nextblock-cms/affiliates';
import { redirect } from 'next/navigation';
import { isAffiliatesProgramActive } from '../../../lib/affiliates/package-state';
import { readAffiliatesSettingsStrict } from '../../../lib/affiliates/settings';

export const metadata = {
  title: 'Payments Settings | NextBlock™ CMS',
};

export default async function PaymentsPageWrapper() {
  const isOnline = await verifyPackageOnline('ecommerce');
  if (!isOnline) {
      redirect('/cms/settings/packages');
  }

  // Stripe pays affiliate partners only the commissions of the sale types routed to Stripe Connect
  // (affiliates_settings.payoutMethods, 02036/02037): the others are paid by hand or with PayPal, and
  // a run that pays every gateway outside Stripe never calls Stripe. The Stripe section mentions
  // partners only then, and tells a digital-only store it needs a Stripe key only when digital
  // (Freemius) sales are among them. Unreadable settings count as the default routing, every sale
  // type through Stripe Connect, as on the Affiliates → Stripe screen.
  const stripeGateways = (await isAffiliatesProgramActive())
    ? affiliateGatewaysPaidByStripe(await readAffiliatesSettingsStrict())
    : [];

  return (
    <PaymentsPageUI
      partnerPayouts={stripeGateways.length > 0}
      digitalPartnerPayouts={stripeGateways.includes('FREEMIUS')}
    />
  );
}
