import React from 'react';
import CheckoutWithCustomer from '../../commerce/CheckoutWithCustomer';
import PaymentReadinessBoundary from '../../commerce/PaymentReadinessBoundary';
import type { VisualEditAttributes } from '../../../lib/visual-editing/types';

interface CheckoutBlockRendererProps {
  visualEditAttributes?: VisualEditAttributes;
}

export default function CheckoutBlockRenderer({
  visualEditAttributes,
}: CheckoutBlockRendererProps) {
  return (
    <div {...visualEditAttributes}>
      <PaymentReadinessBoundary>
        <CheckoutWithCustomer />
      </PaymentReadinessBoundary>
    </div>
  );
}
