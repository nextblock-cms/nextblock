import { Checkout } from '@nextblock-cms/ecommerce/components/Checkout';
import PaymentReadinessBoundary from '../../components/commerce/PaymentReadinessBoundary';
import { createClient } from '@nextblock-cms/db/server';
import { getDefaultUserAddresses } from '@nextblock-cms/ecommerce/customer-addresses';
import { getUcpCartCheckoutItems } from '../lib/ucp/server';
import { loadAddonBaseProductsForRequest } from '../../lib/commerce/addon-base-products';
import { UcpCartHydrator } from './UcpCartHydrator';

interface CheckoutPageProps {
  searchParams?: Promise<{
    ucp_cart?: string;
    cart?: string;
  }>;
}

export default async function CheckoutPage({ searchParams }: CheckoutPageProps) {
  const resolvedSearchParams = await searchParams;
  const ucpCartId = resolvedSearchParams?.ucp_cart || resolvedSearchParams?.cart || null;
  const ucpCartItems = await getUcpCartCheckoutItems(ucpCartId);
  // The products an add-on license in the cart needs (Commerce Pro, for Affiliates), for the
  // checkout's add-on notice and its add button: none on a store without NextBlock's own license products.
  const addonBaseProducts = await loadAddonBaseProductsForRequest();
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <>
        <UcpCartHydrator items={ucpCartItems} />
        <PaymentReadinessBoundary>
          <Checkout addonBaseProducts={addonBaseProducts} initialCustomer={{ isAuthenticated: false }} />
        </PaymentReadinessBoundary>
      </>
    );
  }

  const [{ data: profile }, { billingAddress, shippingAddress }] = await Promise.all([
    supabase.from('profiles').select('full_name, phone').eq('id', user.id).single(),
    getDefaultUserAddresses(user.id, supabase),
  ]);

  return (
    <>
      <UcpCartHydrator items={ucpCartItems} />
      <PaymentReadinessBoundary>
      <Checkout
        addonBaseProducts={addonBaseProducts}
        initialCustomer={{
          isAuthenticated: true,
          email: user.email,
          fullName: profile?.full_name || null,
          phone: profile?.phone || null,
          billingAddress,
          shippingAddress,
        }}
      />
      </PaymentReadinessBoundary>
    </>
  );
}
