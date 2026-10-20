'use server';

import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';
import { getEcomActorRole } from '../../../server-actions/require-ecom-role';
import { OrderWithDetails } from './types';

const ITEMS_PER_PAGE = 20;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `.or()` takes a PostgREST filter-DSL string, so user input must never be spliced into
 * it raw (`,`, `(`, `)` and `.` are syntax there). Both searchable columns are uuids:
 * accept exactly a uuid, lower-cased — an alphabet with no DSL characters — or nothing.
 */
function normalizeUuidSearch(search: string | undefined): string | null {
  const trimmed = typeof search === 'string' ? search.trim() : '';
  if (!trimmed || !UUID_PATTERN.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

/**
 * The client for a CMS order read, or null when the caller may not see orders.
 *
 * Orders are ADMIN-only in the CMS (RLS: a customer reads their own, a WRITER nothing), and
 * since migration 02023 the ADMIN branch of every `orders` / `order_items` policy requires
 * `public.is_admin_mfa()`: an admin who enrolled a second factor must be on an `aal2`
 * session. The app's own 2FA gate accepts a "remember this device" cookie, so a legitimate
 * admin is routinely inside /cms on an `aal1` session, and a cookie-client read would show
 * them an empty orders screen. So the role is verified through the session and the read goes
 * through the service role — the `requireEcomAdmin()` pattern — while a non-ADMIN gets the
 * empty result RLS always gave them rather than an error page (a WRITER can open the screen).
 */
async function orderReader() {
  const role = await getEcomActorRole();
  return role === 'ADMIN' ? getServiceRoleSupabaseClient() : null;
}

export async function getOrders(
  page = 1,
  status?: string,
  search?: string
): Promise<{ data: OrderWithDetails[]; total: number; totalPages: number }> {
  const uuidSearch = normalizeUuidSearch(search);
  if (search && !uuidSearch) {
    // A term that is not a uuid can never match either column; skip the round-trip.
    return { data: [], total: 0, totalPages: 0 };
  }

  const supabase = await orderReader();
  if (!supabase) {
    return { data: [], total: 0, totalPages: 0 };
  }
  const safePage = Number.isInteger(page) && page > 0 ? page : 1;
  const from = (safePage - 1) * ITEMS_PER_PAGE;
  const to = from + ITEMS_PER_PAGE - 1;

  // 1. Fetch Orders first
  let query = supabase
    .from('orders')
    .select(
      `
      *,
      order_items (*)
    `,
      { count: 'exact' }
    )
    .order('created_at', { ascending: false })
    .range(from, to);

  if (status && status !== 'all') {
    query = query.eq('status', status);
  }

  if (uuidSearch) {
      query = query.or(`id.eq.${uuidSearch},user_id.eq.${uuidSearch}`);
  }

  const { data: ordersData, error: ordersError, count } = await query;

  if (ordersError) {
    console.error('Error fetching orders:', ordersError);
    throw new Error('Failed to fetch orders');
  }

  const orders = (ordersData as any[]) || [];

  // 2. Extract User IDs
  const userIds = Array.from(new Set(orders.map(o => o.user_id).filter(Boolean)));

  // 3. Fetch Profiles if needed
  const profilesMap = new Map();
  if (userIds.length > 0) {
      const { data: profilesData, error: profilesError } = await supabase
          .from('profiles')
          .select('*')
          .in('id', userIds);

      if (!profilesError && profilesData) {
          profilesData.forEach(p => profilesMap.set(p.id, p));
      }
  }

  // 4. Merge Data
  const data = orders.map(order => ({
      ...order,
      customer: order.user_id ? profilesMap.get(order.user_id) : null
  })) as OrderWithDetails[];

  return {
    data,
    total: count || 0,
    totalPages: count ? Math.ceil(count / ITEMS_PER_PAGE) : 0,
  };
}

export async function getOrderDetails(orderId: string): Promise<OrderWithDetails | null> {
  const supabase = await orderReader();
  if (!supabase) {
    return null;
  }

  // 1. Fetch Order
  const { data: orderData, error: orderError } = await supabase
    .from('orders')
    .select(
      `
      *,
      order_items (*)
    `
    )
    .eq('id', orderId)
    .single();

  if (orderError || !orderData) {
    console.error(`Error fetching order ${orderId}:`, orderError);
    return null;
  }

  const order = orderData as any;

  // 2. Fetch Customer if user_id exists
  let customer = null;
  if (order.user_id) {
      const { data: profile } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', order.user_id)
          .single();
      customer = profile;
  }

  // 3. Fetch Products for Items
  const productIds = order.order_items.map((i: any) => i.product_id).filter(Boolean);
  const productsMap = new Map();

  if (productIds.length > 0) {
      const { data: products } = await supabase
          .from('products')
          .select('id, title, slug, product_media(media(file_path))')
          .in('id', productIds);

      if (products) {
          products.forEach((p: any) => {
             // Extract first image
             let imageUrl = null;
             if (p.product_media && p.product_media.length > 0 && p.product_media[0].media) {
                 imageUrl = p.product_media[0].media.file_path;
             }
             productsMap.set(p.id, {
                 title: p.title,
                 slug: p.slug,
                 image_url: imageUrl
             });
          });
      }
  }

  const orderItemsWithProduct = order.order_items.map((item: any) => ({
      ...item,
      product: item.product_id ? productsMap.get(item.product_id) : null
  }));

  return {
      ...order,
      order_items: orderItemsWithProduct,
      customer
  } as OrderWithDetails;
}
