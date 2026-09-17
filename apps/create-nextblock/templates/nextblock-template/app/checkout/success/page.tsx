'use client';

import {
  FreemiusLicensePanel,
  type FreemiusOrderLicense,
  InvoiceViewerShell,
  type InvoicePresentationData,
  buildInvoiceDocumentLabels,
  getInvoiceLocale,
  localizeInvoicePresentationData,
  translateOrFallback,
  useCartStore,
  useIsCartHydrated,
} from '@nextblock-cms/ecommerce';
import { useTranslations } from '@nextblock-cms/utils';
import { CheckCircle2 } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';

import { fulfillOrderAction } from './actions';

const CHECKOUT_DRAFT_STORAGE_KEY = 'nextblock-checkout-draft-v1';

function buildPurchasedItemKey(productId?: string | null, variantId?: string | null) {
  return `${productId || 'unknown'}:${variantId || 'base'}`;
}

export default function CheckoutSuccessPage() {
  const { t, lang } = useTranslations();
  const isCartHydrated = useIsCartHydrated();
  const searchParams = useSearchParams();
  const sessionId = searchParams.get('session_id');
  const [invoice, setInvoice] = useState<InvoicePresentationData | null>(null);
  const [license, setLicense] = useState<FreemiusOrderLicense | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [hasRemainingCheckoutItems, setHasRemainingCheckoutItems] = useState(false);
  const [orderStatus, setOrderStatus] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const processedSessionIdRef = useRef<string | null>(null);

  const labels = useMemo(() => buildInvoiceDocumentLabels(t), [t]);
  const localizedInvoice = useMemo(
    () => localizeInvoicePresentationData(invoice, t),
    [invoice, t]
  );
  const action = useMemo(
    () =>
      hasRemainingCheckoutItems
        ? {
            href: '/checkout',
            label: translateOrFallback(t, 'continue_checkout', 'Continue Checkout'),
          }
        : {
            href: '/',
            label: translateOrFallback(t, 'return_home', 'Return to Home'),
          },
    [hasRemainingCheckoutItems, t]
  );

  useEffect(() => {
    async function finalizeOrder() {
      if (!sessionId || !isCartHydrated) {
        return;
      }

      setIsSyncing(true);
      setSyncError(null);

      try {
        const result = await fulfillOrderAction(sessionId);

        if (!result.success) {
          setSyncError(
            result.errorKey
              ? translateOrFallback(
                  t,
                  result.errorKey,
                  result.error ||
                    translateOrFallback(
                      t,
                      'checkout_success_sync_failed',
                      'We could not finalize your invoice yet. Please refresh shortly.'
                    )
                )
              : result.error ||
                  translateOrFallback(
                    t,
                    'checkout_success_sync_failed',
                    'We could not finalize your invoice yet. Please refresh shortly.'
                  )
          );
          return;
        }

        if (result.invoice) {
          const resolvedInvoice = result.invoice as InvoicePresentationData;
          setOrderStatus((result as any).status || resolvedInvoice.order.status || null);
          setLicense(((result as any).license as FreemiusOrderLicense | null) ?? null);
          const purchasedKeys = new Set(
            resolvedInvoice.order.items.map((item) =>
              buildPurchasedItemKey(item.product_id, item.variant_id)
            )
          );
          const currentItems = useCartStore.getState().items;
          const remainingItems = currentItems.filter(
            (item) => !purchasedKeys.has(buildPurchasedItemKey(item.product_id, item.variant_id))
          );

          useCartStore.getState().setItems(remainingItems);
          if (remainingItems.length === 0) {
            useCartStore.getState().removeCoupon();
          }
          setHasRemainingCheckoutItems(remainingItems.length > 0);

          if (typeof window !== 'undefined' && remainingItems.length === 0) {
            window.localStorage.removeItem(CHECKOUT_DRAFT_STORAGE_KEY);
          }

          setInvoice(resolvedInvoice);
        }
      } catch (error) {
        // A rejected action (offline, a deploy in progress) used to surface nowhere: no
        // message, and the page sat on "your invoice will appear here" for good.
        console.error('[CheckoutSuccess] Failed to finalize the order:', error);
        setSyncError(
          translateOrFallback(
            t,
            'checkout_success_sync_failed',
            'We could not finalize your invoice yet. Please refresh shortly.'
          )
        );
      } finally {
        setIsSyncing(false);
      }
    }

    if (
      sessionId &&
      isCartHydrated &&
      processedSessionIdRef.current !== sessionId
    ) {
      processedSessionIdRef.current = sessionId;
      void finalizeOrder();
    }
    // `attempt` re-runs this after the visitor presses Retry (which also clears the ref).
  }, [attempt, isCartHydrated, sessionId, t]);

  const hasOutcome = Boolean(invoice);
  const retry = () => {
    processedSessionIdRef.current = null;
    setAttempt((current) => current + 1);
  };

  return (
    <InvoiceViewerShell
      invoice={localizedInvoice}
      labels={labels}
      locale={getInvoiceLocale(lang)}
      // Only a confirmed order gets the success title and the green check. They used to show
      // whenever `orderStatus` was null too: no session id, a cancelled or still-pending
      // payment, an order that was not found.
      title={
        !hasOutcome
          ? syncError
            ? translateOrFallback(t, 'checkout_success_unconfirmed', 'We could not confirm your order')
            : sessionId
              ? translateOrFallback(t, 'checkout_success_confirming', 'Confirming your order…')
              : translateOrFallback(t, 'checkout_success_no_session', 'No order to show')
          : orderStatus === 'trial'
          ? translateOrFallback(
              t,
              'ecommerce.checkout_trial_started',
              'Trial started'
            )
          : orderStatus === 'pending'
            ? translateOrFallback(
                t,
                'ecommerce.checkout_order_pending',
                'Order pending'
              )
            : translateOrFallback(
                t,
                'ecommerce.checkout_successful',
                'Payment received'
              )
      }
      description={translateOrFallback(
        t,
        'print_invoice_help',
        'Use your browser print dialog to save this invoice as a PDF.'
      )}
      printLabel={translateOrFallback(
        t,
        'print_invoice',
        'Print / Save as PDF'
      )}
      headerVisual={
        hasOutcome ? (
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-500/15">
            <CheckCircle2 className="h-8 w-8 text-emerald-600 dark:text-emerald-400" />
          </div>
        ) : undefined
      }
      action={action}
      beforeInvoice={<FreemiusLicensePanel license={license} />}
      loading={isSyncing}
      loadingMessage={translateOrFallback(
        t,
        'receipt_finalizing',
        'Finalizing your invoice and payment details…'
      )}
      error={syncError}
      onRetry={sessionId ? retry : undefined}
      retryLabel={translateOrFallback(t, 'retry', 'Try again')}
      emptyMessage={translateOrFallback(
        t,
        'receipt_not_ready',
        'Your invoice will appear here once the payment sync is complete.'
      )}
    />
  );
}
