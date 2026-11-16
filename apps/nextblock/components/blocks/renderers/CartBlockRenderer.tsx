import React from 'react';
import { LazyCart } from '../../commerce/LazyCommerceClients';
import PaymentReadinessBoundary from '../../commerce/PaymentReadinessBoundary';
import type { VisualEditAttributes } from '../../../lib/visual-editing/types';

interface CartBlockRendererProps {
  visualEditAttributes?: VisualEditAttributes;
}

export default function CartBlockRenderer({ visualEditAttributes }: CartBlockRendererProps) {
  return (
    <div {...visualEditAttributes}>
      <PaymentReadinessBoundary>
        <LazyCart />
      </PaymentReadinessBoundary>
    </div>
  );
}
