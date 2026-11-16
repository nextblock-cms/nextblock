import { getCurrentCustomerOrders } from '@nextblock-cms/ecommerce/customer-orders';

import { requireProfileAccountContext } from '../account-data';
import { CustomerOrdersPageClient } from './CustomerOrdersPageClient';

export default async function ProfileOrdersPage() {
  const { supabase, profile, user } = await requireProfileAccountContext(
    '/profile/orders'
  );
  const orders = await getCurrentCustomerOrders(supabase as any);

  return (
    <CustomerOrdersPageClient
      orders={orders}
      profile={profile}
      user={user}
    />
  );
}
