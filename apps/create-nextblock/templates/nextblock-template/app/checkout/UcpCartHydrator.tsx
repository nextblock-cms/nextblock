'use client';

import { useEffect } from 'react';
import { useCartStore } from '@nextblock-cms/ecommerce/cart-store';
import type { CartItem } from '@nextblock-cms/ecommerce/types';

interface UcpCartHydratorProps {
  items: CartItem[];
}

export function UcpCartHydrator({ items }: UcpCartHydratorProps) {
  useEffect(() => {
    if (items.length === 0) {
      return;
    }

    useCartStore.getState().setItems(items);
  }, [items]);

  return null;
}
