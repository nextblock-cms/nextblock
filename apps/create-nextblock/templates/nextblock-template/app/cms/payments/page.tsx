import { PaymentsPage as PaymentsPageUI } from '@nextblock-cms/ecommerce/server';
import { verifyPackageOnline } from '@nextblock-cms/db/server';
import { redirect } from 'next/navigation';
import { isAffiliatesProgramActive } from '../../../lib/affiliates/package-state';

export const metadata = {
  title: 'Payments Settings | NextBlock™ CMS',
};

export default async function PaymentsPageWrapper() {
  const isOnline = await verifyPackageOnline('ecommerce');
  if (!isOnline) {
      redirect('/cms/settings/packages');
  }

  // Stripe also pays affiliate partners, which the Stripe section mentions only while the program runs.
  return <PaymentsPageUI partnerPayouts={await isAffiliatesProgramActive()} />;
}
