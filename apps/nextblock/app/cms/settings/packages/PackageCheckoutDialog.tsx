'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, ExternalLink, FlaskConical, Loader2, ShieldCheck, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from '@nextblock-cms/ui';
import { describePackageOffer, formatPackagePrice, type PackageDef, type PackagePricing } from '@nextblock-cms/utils';

import {
  activatePackage,
  activatePurchasedPackage,
  resendPurchasedLicenseEmail,
  type ActivatePurchasedPackageResult,
} from '../../../actions/package-actions';

const isSandbox = process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';

/**
 * Buy or start a trial of a NextBlock package without leaving the dashboard.
 *
 * Opens the Freemius checkout overlay (the same `@freemius/checkout` the storefront
 * uses; the host is already allowed by the CSP `frame-src`). When the buyer completes
 * the checkout, the overlay reports the new license id and `activatePurchasedPackage`
 * fetches the key from the vendor and activates it here. If that hand-off is not
 * possible the buyer still has the key by email, so the dialog falls back to a
 * paste-your-key field with a resend button.
 *
 * While the overlay is up the Radix dialog is NOT rendered: a modal Radix layer sets
 * `pointer-events: none` on `<body>` and traps focus, and the overlay's iframe lives
 * outside the Radix portal, so keeping the dialog open would make the checkout
 * unclickable. The dialog comes back on `purchaseCompleted` / `success` / `cancel`.
 */

export type PackageCheckoutActivated = {
  isTrial: boolean;
  packageId: string;
  packageName: string;
};

type Stage =
  | { kind: 'offer' }
  | { kind: 'checkout' }
  | { kind: 'activating' }
  | { kind: 'activated'; result: Extract<ActivatePurchasedPackageResult, { activated: true }> }
  | { kind: 'needs_key'; email: string | null; message: string; resendEmailEndpoint: string | null }
  | { kind: 'key_only' };

type BillingCycle = 'annual' | 'monthly';

export function PackageCheckoutDialog({
  intent = 'default',
  onActivated,
  onOpenChange,
  open,
  pkg,
}: {
  /** "site-builder": after activation, offer to start the Cortex site builder. */
  intent?: 'default' | 'site-builder';
  onActivated?: (activated: PackageCheckoutActivated) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  pkg: PackageDef;
}) {
  const router = useRouter();
  const offer = describePackageOffer(pkg);
  // The registry is a literal union; only some packages carry a monthly price.
  const monthlyPrice = (pkg.pricing as PackagePricing).monthly;
  const [stage, setStage] = useState<Stage>({ kind: 'offer' });
  const [manualKey, setManualKey] = useState('');
  const [busy, setBusy] = useState(false);
  // The overlay fires purchaseCompleted and then success (after "Got it"); activate once.
  const activationStartedRef = useRef(false);

  useEffect(() => {
    if (!open) {
      setStage({ kind: 'offer' });
      setManualKey('');
      setBusy(false);
      activationStartedRef.current = false;
    }
  }, [open]);

  const finishActivated = useCallback(
    (result: Extract<ActivatePurchasedPackageResult, { activated: true }>) => {
      setStage({ kind: 'activated', result });
      toast.success(`${result.package} is active${result.isTrial ? ' — your free trial has started' : ''}.`);
      onActivated?.({ isTrial: result.isTrial, packageId: result.packageId, packageName: result.package });
      router.refresh();
    },
    [onActivated, router]
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

  const openCheckout = async (mode: 'buy' | 'trial', billingCycle: BillingCycle = 'annual') => {
    if (isSandbox) {
      return;
    }

    // Hides the Radix dialog (see the note above) for as long as the overlay is up.
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
  };

  const activateManualKey = async () => {
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
  };

  const resendEmail = async (endpoint: string) => {
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
  };

  const startSiteBuilder = () => {
    // Full navigation: the Cortex chat only mounts once the CMS layout re-renders with
    // the package active, and its site-builder query handler runs on mount.
    window.location.assign('/cms/dashboard?cortex=site-builder');
  };

  const trialEndsAt = stage.kind === 'activated' ? stage.result.trialEndsAt ?? stage.result.expiration : null;

  return (
    <Dialog open={open && stage.kind !== 'checkout'} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {stage.kind === 'offer' ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-primary" />
                {pkg.trial ? `Try ${pkg.name} free` : `Get ${pkg.name}`}
              </DialogTitle>
              <DialogDescription>{pkg.tagline}</DialogDescription>
            </DialogHeader>

            <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
              {pkg.trial ? (
                <>
                  <p className="text-base font-semibold text-foreground">
                    Free {pkg.trial.days}-day trial
                    {pkg.trial.requiresPaymentMethod ? '' : ' · No credit card required'}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Try everything for {pkg.trial.days} days. After the trial, keep it for{' '}
                    <strong className="text-foreground">{offer.priceLine}</strong>
                    {pkg.trial.requiresPaymentMethod
                      ? ' — cancel anytime before it ends.'
                      : '. Nothing is charged during the trial; when it ends the package switches off until you buy a license.'}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-base font-semibold text-foreground">{offer.priceLine}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    One license for this site. Activation happens here automatically after checkout.
                  </p>
                </>
              )}
              <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                <ShieldCheck className="h-3.5 w-3.5" />
                Secure checkout by Freemius. Your license activates on this site as soon as you finish.
              </p>
            </div>

            {isSandbox ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-300">
                <p className="flex items-center gap-2 font-medium">
                  <FlaskConical className="h-4 w-4" />
                  Sandbox environment
                </p>
                <p className="mt-1">
                  Purchases and activations are disabled in this demo. Get {pkg.name} for your own install at
                  nextblock.dev.
                </p>
              </div>
            ) : null}

            <DialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
              {!isSandbox && pkg.trial ? (
                <Button className="w-full" onClick={() => void openCheckout('trial')}>
                  <Sparkles className="mr-2 h-4 w-4" />
                  Start my free {pkg.trial.days}-day trial
                </Button>
              ) : null}
              {!isSandbox ? (
                <Button className="w-full" onClick={() => void openCheckout('buy', 'annual')} variant={pkg.trial ? 'outline' : 'default'}>
                  Buy now · {formatPackagePrice(pkg.pricing.annual, pkg.pricing.currency)}/year
                </Button>
              ) : null}
              {!isSandbox && monthlyPrice ? (
                <Button className="w-full" onClick={() => void openCheckout('buy', 'monthly')} variant="ghost">
                  Or {formatPackagePrice(monthlyPrice, pkg.pricing.currency)}/month
                </Button>
              ) : null}
              <Button asChild className="w-full" variant={isSandbox ? 'default' : 'ghost'}>
                <a href={pkg.purchase_url} rel="noopener noreferrer" target="_blank">
                  Purchase on nextblock.dev
                  <ExternalLink className="ml-2 h-3.5 w-3.5" />
                </a>
              </Button>
              {!isSandbox ? (
                <button
                  className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => setStage({ kind: 'key_only' })}
                  type="button"
                >
                  Already have a license key? Activate it here.
                </button>
              ) : null}
            </DialogFooter>
          </>
        ) : null}

        {stage.kind === 'activating' ? (
          <>
            <DialogHeader>
              <DialogTitle>Activating {pkg.name}…</DialogTitle>
              <DialogDescription>
                Fetching your license key and activating it on this site. This takes a few seconds.
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          </>
        ) : null}

        {stage.kind === 'activated' ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                {pkg.name} is active
              </DialogTitle>
              <DialogDescription>
                {stage.result.isTrial
                  ? `Your free trial has started${trialEndsAt ? ` and runs until ${formatDate(trialEndsAt)}` : ''}. Your license key was also emailed to you.`
                  : 'Your license is activated on this site. The key was also emailed to you for safekeeping.'}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
              {intent === 'site-builder' && pkg.id === 'cortex-ai' ? (
                <Button className="w-full" onClick={startSiteBuilder}>
                  <Sparkles className="mr-2 h-4 w-4" />
                  Build my site with Cortex AI now
                </Button>
              ) : null}
              <Button className="w-full" onClick={() => onOpenChange(false)} variant="outline">
                Done
              </Button>
            </DialogFooter>
          </>
        ) : null}

        {stage.kind === 'needs_key' || stage.kind === 'key_only' ? (
          <>
            <DialogHeader>
              <DialogTitle>{stage.kind === 'needs_key' ? 'One more step' : `Activate ${pkg.name}`}</DialogTitle>
              <DialogDescription>
                {stage.kind === 'needs_key'
                  ? stage.message
                  : 'Paste the license key from your purchase email to unlock the package on this site.'}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <label className="sr-only" htmlFor="package-license-key">
                License key
              </label>
              <Input
                autoFocus
                id="package-license-key"
                onChange={(event) => setManualKey(event.target.value)}
                placeholder="Your Freemius license key"
                value={manualKey}
              />
              {stage.kind === 'needs_key' && stage.email ? (
                <p className="text-xs text-muted-foreground">The email was sent to {stage.email}.</p>
              ) : null}
            </div>
            <DialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
              <Button className="w-full" disabled={busy || !manualKey.trim()} onClick={() => void activateManualKey()}>
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Activate license
              </Button>
              {stage.kind === 'needs_key' && stage.resendEmailEndpoint ? (
                <Button
                  className="w-full"
                  disabled={busy}
                  onClick={() => void resendEmail(stage.resendEmailEndpoint as string)}
                  variant="ghost"
                >
                  Resend the license email
                </Button>
              ) : null}
              {stage.kind === 'key_only' ? (
                <Button className="w-full" onClick={() => setStage({ kind: 'offer' })} variant="ghost">
                  Back
                </Button>
              ) : null}
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function formatDate(value: string) {
  const parsed = Date.parse(value.includes('T') || /z$/i.test(value) ? value : `${value.replace(' ', 'T')}Z`);

  if (!Number.isFinite(parsed)) {
    return value;
  }

  return new Date(parsed).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}
