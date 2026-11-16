import { getCurrentCustomerOrderInvoice } from '@nextblock-cms/ecommerce/customer-orders';
import { notFound } from 'next/navigation';

import { requireProfileAccountContext } from '../../account-data';
import { CustomerOrderDetailPageClient } from './CustomerOrderDetailPageClient';

export default async function ProfileOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { supabase, profile, user } = await requireProfileAccountContext(
    `/profile/orders/${id}`
  );
  const result = await getCurrentCustomerOrderInvoice(id, supabase as any);

  if (!result) {
    notFound();
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 md:px-6">
      <CustomerOrderDetailPageClient
        order={result.order}
        invoice={result.invoice}
        license={result.license}
        profile={profile}
        user={user}
      />
    </div>
  );
}
