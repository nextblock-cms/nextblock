import React from 'react';
import { LazyCheckoutWithCustomer } from '../../commerce/LazyCommerceClients';
import PaymentReadinessBoundary from '../../commerce/PaymentReadinessBoundary';
import { loadAddonBaseProducts } from '../../../lib/commerce/addon-base-products';
import type { VisualEditAttributes } from '../../../lib/visual-editing/types';

interface CheckoutBlockRendererProps {
  languageId?: number;
  visualEditAttributes?: VisualEditAttributes;
}

export default async function CheckoutBlockRenderer({
  languageId,
  visualEditAttributes,
}: CheckoutBlockRendererProps) {
  // The products an add-on license in the cart needs (Commerce Pro, for Affiliates), for the
  // checkout's add-on notice and its add button: none on a store without NextBlock's own license products.
  const addonBaseProducts = await loadAddonBaseProducts(languageId);

  return (
    <div {...visualEditAttributes}>
      <PaymentReadinessBoundary>
        <LazyCheckoutWithCustomer addonBaseProducts={addonBaseProducts} />
      </PaymentReadinessBoundary>
    </div>
  );
}
