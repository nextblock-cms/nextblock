'use server';

import 'server-only';

import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';
import { getEcomActorRole } from '../../../server-actions/require-ecom-role';

export type ReportType = 'general_ledger' | 'tax_liability' | 'currency_summary';

export async function fetchOrderReportData(
  startDate: string,
  endDate: string
) {
  // ADMIN-only, read with the service role after the role check: since migration 02023 the
  // orders policies require is_admin_mfa(), which an admin on an aal1 "remember this device"
  // session cannot satisfy through the cookie client (see getOrders in ./actions.ts). A
  // non-ADMIN gets the empty report RLS gave them before.
  const role = await getEcomActorRole();
  if (role !== 'ADMIN') {
    return [];
  }
  const supabase = getServiceRoleSupabaseClient();

  // Basic date filtering
  let query = supabase
    .from('orders')
    .select('*, order_items(*)');

  if (startDate) {
    query = query.gte('created_at', startDate);
  }
  if (endDate) {
    // Add time to end date to include the whole day
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    query = query.lte('created_at', end.toISOString());
  }

  // Filter only paid orders for accounting reports?
  // Usually accountants care about realized revenue.
  // Requirement 1 mentions "Payment Status", so we should fetch all status but maybe default to paid?
  // Let's fetch all and let the mapping handle it or keep it as is.

  const { data: orders, error } = await query.order('created_at', { ascending: true });

  if (error) {
    console.error('Error fetching report data:', error);
    throw new Error(`Failed to fetch report data: ${error.message}`);
  }

  if (!orders || orders.length === 0) {
    return [];
  }

  // Customer names for the General Ledger and Tax Liability reports. (`profiles` has no
  // `email` column — the e-mail lives in auth.users — and the typed service-role client
  // rejects selecting one, where the untyped cookie client used to let PostgREST fail the
  // whole lookup at runtime.)
  const userIds = Array.from(
    new Set(orders.map((o) => o.user_id).filter((id): id is string => Boolean(id)))
  );
  const profilesMap = new Map();

  if (userIds.length > 0) {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, full_name')
      .in('id', userIds);

    if (profiles) {
      profiles.forEach(p => profilesMap.set(p.id, p));
    }
  }

  return orders.map(order => ({
    ...order,
    customer: order.user_id ? profilesMap.get(order.user_id) : null
  }));
}
