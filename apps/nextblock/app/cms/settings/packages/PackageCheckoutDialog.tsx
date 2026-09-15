'use client';

import { useEffect } from 'react';
import { CheckCircle2, ExternalLink, FlaskConical, Loader2, ShieldCheck, Sparkles } from 'lucide-react';

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
import { formatPackagePrice, type PackageDef } from '@nextblock-cms/utils';

import { CORTEX_SETUP_SITE_BUILDER_HREF } from '../../../../lib/cortex-ai/site-builder-prompt';
import {
  formatPackageDate,
  isPackageCheckoutSandbox as isSandbox,
  usePackageCheckout,
  type PackageCheckoutActivated,
} from './usePackageCheckout';

export type { PackageCheckoutActivated };

/**
 * Buy or start a trial of a NextBlock package without leaving the dashboard.
 *
 * The stages live in `usePackageCheckout`; this is the dialog chrome around them.
 *
 * While the overlay is up the Radix dialog is NOT rendered: a modal Radix layer sets
 * `pointer-events: none` on `<body>` and traps focus, and the overlay's iframe lives
 * outside the Radix portal, so keeping the dialog open would make the checkout
 * unclickable. The dialog comes back on `purchaseCompleted` / `success` / `cancel`.
 */
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
  const checkout = usePackageCheckout({ onActivated, pkg });
  const { activateManualKey, busy, manualKey, monthlyPrice, offer, openCheckout, resendEmail, reset, setManualKey, setStage, stage, trialEndsAt } =
    checkout;

  useEffect(() => {
    if (!open) {
      reset();
    }
  }, [open, reset]);

  const startSiteBuilder = () => {
    // Full navigation: the Cortex chat only mounts once the CMS layout re-renders with
    // the package active. A fresh activation has no model key yet, so this goes through
    // the first-run wizard; when a key already exists (env or stored) the wizard hands
    // straight off to /cms/dashboard?cortex=site-builder.
    window.location.assign(CORTEX_SETUP_SITE_BUILDER_HREF);
  };

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
                  ? `Your free trial has started${trialEndsAt ? ` and runs until ${formatPackageDate(trialEndsAt)}` : ''}. Your license key was also emailed to you.`
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
