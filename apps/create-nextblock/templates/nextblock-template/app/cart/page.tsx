import { Cart } from '@nextblock-cms/ecommerce/components/Cart';

import { loadAddonBaseProductsForRequest } from '../../lib/commerce/addon-base-products';

export default async function CartPage() {
  // The products an add-on license in the cart needs (Commerce Pro, for Affiliates), for the
  // cart's add-on notice and its add button: none on a store without NextBlock's own license products.
  const addonBaseProducts = await loadAddonBaseProductsForRequest();
  return <Cart addonBaseProducts={addonBaseProducts} />;
}
