'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { describePackageOffer, type PackageDef, type PackagePricing } from '@nextblock-cms/utils';

import {
  activatePackage,
  activatePurchasedPackage,
  resendPurchasedLicenseEmail,
  type ActivatePurchasedPackageResult,
} from '../../../actions/package-actions';

/**
 * The buy-or-trial state machine behind every in-dashboard package checkout.
 *
 * Shared by the packages-page dialog and the post-install welcome step, which render
 * the same stages in different chrome (a Radix dialog vs. a full page). Keeping the
 * stages here means the tricky paths — purchase went through but activation failed,
 * key arrives by email, resend — are handled once.
 *
 * Opens the Freemius checkout overlay (the same `@freemius/checkout` the storefront
 * uses; the host is already allowed by the CSP `frame-src`). When the buyer completes
 * the checkout, the overlay reports the new license id and `activatePurchasedPackage`
 * fetches the key from the vendor and activates it here. If that hand-off is not
 * possible the buyer still has the key by email, so the flow falls back to a
 * paste-your-key stage with a resend button.
 */

export const isPackageCheckoutSandbox = process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';

export type PackageCheckoutActivated = {
  isTrial: boolean;
  packageId: string;
  packageName: string;
};

export type PackageCheckoutStage =
  | { kind: 'offer' }
  | { kind: 'checkout' }
  | { kind: 'activating' }
  | { kind: 'activated'; result: Extract<ActivatePurchasedPackageResult, { activated: true }> }
  | { kind: 'needs_key'; email: string | null; message: string; resendEmailEndpoint: string | null }
  | { kind: 'key_only' };

export type BillingCycle = 'annual' | 'monthly';

export function usePackageCheckout({
  onActivated,
  pkg,
  refreshOnActivate = true,
}: {
  onActivated?: (activated: PackageCheckoutActivated) => void;
  pkg: PackageDef;
  /**
   * Call `router.refresh()` once the package is active. Mostly belt and braces: the
   * activation actions already revalidate the `/cms` layout, which makes the action
   * response re-render the current route on its own, so a page that shows package
   * state (the packages page, the dashboard checklist) picks it up either way. Pass
   * `false` when the caller navigates away with a full load in `onActivated`; the
   * refresh would only race that navigation.
   */
  refreshOnActivate?: boolean;
}) {
  const router = useRouter();
  const offer = describePackageOffer(pkg);
  // The registry is a literal union; only some packages carry a monthly price.
  const monthlyPrice = (pkg.pricing as PackagePricing).monthly ?? null;
  const [stage, setStage] = useState<PackageCheckoutStage>({ kind: 'offer' });
  const [manualKey, setManualKey] = useState('');
  const [busy, setBusy] = useState(false);
  // The overlay fires purchaseCompleted and then success (after "Got it"); activate once.
  const activationStartedRef = useRef(false);

  const reset = useCallback(() => {
    setStage({ kind: 'offer' });
    setManualKey('');
    setBusy(false);
    activationStartedRef.current = false;
  }, []);

  const finishActivated = useCallback(
    (result: Extract<ActivatePurchasedPackageResult, { activated: true }>) => {
      setStage({ kind: 'activated', result });
      toast.success(`${result.package} is active${result.isTrial ? ' — your free trial has started' : ''}.`);
      onActivated?.({ isTrial: result.isTrial, packageId: result.packageId, packageName: result.package });
      if (refreshOnActivate) {
        router.refresh();
      }
    },
    [onActivated, refreshOnActivate, router]
  );

  const handleCheckoutResponse = useCallback(
    async (checkoutResponse: unknown) => {
      if (activationStartedRef.current) {
        return;
      }

      activationStartedRef.current = true;
      setStage({ kind: 'activating' });

      try {
        const result = await activatePurchasedPackage({ checkoutResponse, packageId: pkg.id });

        if (result.activated) {
          finishActivated(result);
          return;
        }

        setStage({
          email: result.email,
          kind: 'needs_key',
          message: result.message,
          resendEmailEndpoint: result.resendEmailEndpoint,
        });
      } catch (error) {
        setStage({
          email: null,
          kind: 'needs_key',
          message:
            error instanceof Error
              ? `The purchase went through, but activation failed: ${error.message}. Paste the key from your email below.`
              : 'The purchase went through, but activation failed. Paste the key from your email below.',
          resendEmailEndpoint: null,
        });
      }
    },
    [finishActivated, pkg.id]
  );

  const openCheckout = useCallback(
    async (mode: 'buy' | 'trial', billingCycle: BillingCycle = 'annual') => {
      if (isPackageCheckoutSandbox) {
        return;
      }

      // Callers that render inside a Radix dialog hide it for as long as the overlay is
      // up (a modal layer would make the checkout iframe unclickable).
      setStage({ kind: 'checkout' });
      activationStartedRef.current = false;

      try {
        const { Checkout } = await import('@freemius/checkout');
        const handler = new Checkout({ product_id: pkg.fm_product_id });

        await handler.open({
          billing_cycle: billingCycle,
          cancel: () => {
            setStage((current) => (current.kind === 'checkout' ? { kind: 'offer' } : current));
          },
          name: 'NextBlock',
          plan_id: pkg.fm_plan_id,
          purchaseCompleted: (response: unknown) => {
            void handleCheckoutResponse(response);
          },
          success: (response: unknown) => {
            void handleCheckoutResponse(response);
          },
          title: pkg.name,
          ...(mode === 'trial' && pkg.trial
            ? { trial: pkg.trial.requiresPaymentMethod ? ('paid' as const) : ('free' as const) }
            : {}),
        });
      } catch (error) {
        setStage({ kind: 'offer' });
        toast.error(
          `The checkout could not be opened${error instanceof Error ? `: ${error.message}` : ''}. You can purchase on nextblock.dev instead.`
        );
      }
    },
    [handleCheckoutResponse, pkg]
  );

  const activateManualKey = useCallback(async () => {
    const key = manualKey.trim();

    if (!key) {
      return;
    }

    setBusy(true);

    try {
      const result = await activatePackage(key, { packageId: pkg.id });

      if ('error' in result) {
        toast.error(result.error);
        return;
      }

      finishActivated({
        activated: true,
        expiration: null,
        isTrial: false,
        package: result.package,
        packageId: result.packageId,
        trialEndsAt: null,
      });
    } catch {
      toast.error('Activation failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }, [finishActivated, manualKey, pkg.id]);

  const resendEmail = useCallback(async (endpoint: string) => {
    setBusy(true);

    try {
      const result = await resendPurchasedLicenseEmail(endpoint);

      if (result.ok) {
        toast.success('License email sent again.');
      } else {
        toast.error(result.error ?? 'Could not resend the email.');
      }
    } finally {
      setBusy(false);
    }
  }, []);

  const trialEndsAt = stage.kind === 'activated' ? stage.result.trialEndsAt ?? stage.result.expiration : null;

  return {
    activateManualKey,
    busy,
    manualKey,
    monthlyPrice,
    offer,
    openCheckout,
    resendEmail,
    reset,
    resendEmailEndpoint: stage.kind === 'needs_key' ? stage.resendEmailEndpoint : null,
    setManualKey,
    setStage,
    stage,
    trialEndsAt,
  };
}

export function formatPackageDate(value: string) {
  const parsed = Date.parse(value.includes('T') || /z$/i.test(value) ? value : `${value.replace(' ', 'T')}Z`);

  if (!Number.isFinite(parsed)) {
    return value;
  }

  return new Date(parsed).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}
