import React from 'react';
import { LazyCart } from '../../commerce/LazyCommerceClients';
import PaymentReadinessBoundary from '../../commerce/PaymentReadinessBoundary';
import { loadAddonBaseProducts } from '../../../lib/commerce/addon-base-products';
import type { VisualEditAttributes } from '../../../lib/visual-editing/types';

interface CartBlockRendererProps {
  languageId?: number;
  visualEditAttributes?: VisualEditAttributes;
}

export default async function CartBlockRenderer({ languageId, visualEditAttributes }: CartBlockRendererProps) {
  // The products an add-on license in the cart needs (Commerce Pro, for Affiliates), for the
  // cart's add-on notice and its add button: none on a store without NextBlock's own license products.
  const addonBaseProducts = await loadAddonBaseProducts(languageId);

  return (
    <div {...visualEditAttributes}>
      <PaymentReadinessBoundary>
        <LazyCart addonBaseProducts={addonBaseProducts} />
      </PaymentReadinessBoundary>
    </div>
  );
}
