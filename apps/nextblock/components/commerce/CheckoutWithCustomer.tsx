'use client';

import { useEffect, useState } from 'react';
import { Checkout } from '@nextblock-cms/ecommerce/components/Checkout';
import type { CheckoutCustomerDefaults } from '@nextblock-cms/ecommerce';

import { getCheckoutCustomerDefaults } from '../../app/actions/checkoutCustomerActions';
import { useAuth } from '../../context/AuthContext';
import { useLabel } from '../../lib/i18n/use-label';

/**
 * Checkout for the checkout BLOCK.
 *
 * The block used to render `<Checkout />` with no customer, so a signed-in shopper got the
 * guest flow: asked for an email that `/api/checkout` then ignored in favour of the account's,
 * and none of their saved addresses prefilled. Guests render at once; a signed-in shopper
 * waits for one server action, because Checkout reads `initialCustomer` only on mount.
 */
export default function CheckoutWithCustomer() {
  const { user, isLoading } = useAuth();
  const label = useLabel();
  const [customer, setCustomer] = useState<CheckoutCustomerDefaults | null>(null);

  useEffect(() => {
    if (isLoading) return;

    if (!user) {
      setCustomer({ isAuthenticated: false });
      return;
    }

    let isCancelled = false;

    getCheckoutCustomerDefaults()
      .then((defaults) => {
        if (!isCancelled) setCustomer(defaults);
      })
      .catch(() => {
        if (!isCancelled) setCustomer({ isAuthenticated: false });
      });

    return () => {
      isCancelled = true;
    };
  }, [isLoading, user]);

  if (!customer) {
    return (
      <div role="status" className="container mx-auto px-4 py-12 text-center text-sm text-muted-foreground">
        {label('loading', 'Loading…', 'Chargement…')}
      </div>
    );
  }

  return <Checkout key={customer.isAuthenticated ? 'customer' : 'guest'} initialCustomer={customer} />;
}
