'use server';

import { createClient } from '@nextblock-cms/db/server';
import type { CheckoutCustomerDefaults } from '@nextblock-cms/ecommerce';
import { getDefaultUserAddresses } from '@nextblock-cms/ecommerce/server';

/**
 * The signed-in customer's saved details for prefilling checkout, or a guest marker.
 *
 * `/checkout` resolves this on the server while rendering. A checkout BLOCK lives on a CMS
 * page that is statically rendered, where reading the session during render would make the
 * whole page dynamic; the block asks for it after mount instead. Returns only the caller's
 * own data (cookie-scoped client, no ids accepted).
 */
export async function getCheckoutCustomerDefaults(): Promise<CheckoutCustomerDefaults> {
  try {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return { isAuthenticated: false };
    }

    const [{ data: profile }, { billingAddress, shippingAddress }] = await Promise.all([
      supabase.from('profiles').select('full_name, phone').eq('id', user.id).single(),
      getDefaultUserAddresses(user.id, supabase),
    ]);

    return {
      isAuthenticated: true,
      email: user.email,
      fullName: profile?.full_name || null,
      phone: profile?.phone || null,
      billingAddress,
      shippingAddress,
    };
  } catch (error) {
    console.error('[checkout] Failed to load customer defaults:', error);
    return { isAuthenticated: false };
  }
}
