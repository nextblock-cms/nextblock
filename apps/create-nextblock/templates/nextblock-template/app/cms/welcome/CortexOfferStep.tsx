'use client';

import Link from 'next/link';
import {
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Layers,
  ListChecks,
  Loader2,
  MessageSquareText,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';

import { Badge, Button, Input, Label } from '@nextblock-cms/ui';
import { formatPackagePrice, type PackageDef } from '@nextblock-cms/utils';

import { CMS_WELCOME_PATH } from '../../../lib/cortex-ai/site-builder-prompt';
import { SetupStepIndicator } from '../components/SetupStepIndicator';
import { CORTEX_SETUP_STEP_LABELS } from '../settings/cortex-ai/setup/CortexSetupWizard';
import { formatPackageDate, usePackageCheckout } from '../settings/packages/usePackageCheckout';

/** Step 1 here, then the wizard's own steps: one sequence, so the chips never drift. */
const WELCOME_STEPS: ReadonlyArray<string> = ['Cortex AI', ...CORTEX_SETUP_STEP_LABELS];
const DASHBOARD_HREF = '/cms/dashboard';

/**
 * Step 1 of the post-install welcome flow: the Cortex AI trial offer as a page.
 *
 * Design rules: the decline is a real button next to the trial button, never a
 * text link; the price after the trial is stated up front; and every checkout
 * outcome (cancelled overlay, activation failed, key by email) keeps the operator on
 * this page with a way forward.
 *
 * On activation the flow continues with a FULL navigation to this same route, right
 * away. The activation actions revalidate the `/cms` layout, and any revalidation
 * inside a server action makes the client router re-render the current route in the
 * action response: the server page then sees Cortex active and swaps this component
 * out for the wizard underneath the operator (under the still-open checkout overlay
 * on the trial path). Nothing on this page can prevent that, so the hand-off is made
 * deterministic instead: reload, and the wizard's own heading ("Your trial is
 * active") is the confirmation. The "activated" stage below only shows for as long
 * as the reload takes, with a manual "Continue" in case it is slow.
 */
export function CortexOfferStep({
  agentInitiated = false,
  pkg,
}: {
  /** A coding agent installed this site and is waiting for Cortex AI to unlock its MCP access. */
  agentInitiated?: boolean;
  pkg: PackageDef;
}) {
  const { activateManualKey, busy, manualKey, monthlyPrice, offer, openCheckout, resendEmail, setManualKey, setStage, stage, trialEndsAt } =
    usePackageCheckout({
      onActivated: () => window.location.assign(CMS_WELCOME_PATH),
      pkg,
      refreshOnActivate: false,
    });

  const trialDays = pkg.trial?.days ?? 0;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8">
      <header className="space-y-4">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-primary/10 p-2.5">
            <Sparkles className="h-6 w-6 text-primary" />
          </div>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold leading-tight">Welcome to NextBlock</h1>
            <p className="text-sm text-muted-foreground">
              {agentInitiated
                ? 'Your coding agent set this site up and is waiting for one thing only: Cortex AI, which powers the MCP server it will use to build your pages. Start the free trial below and you can go straight back to your terminal.'
                : 'Your site is live with sample content. One choice before your dashboard: let Cortex AI replace that sample content with your own site, or do it by hand.'}
            </p>
          </div>
        </div>
        <SetupStepIndicator current={0} steps={WELCOME_STEPS} />
      </header>

      {stage.kind === 'offer' && (
        <section className="space-y-5 rounded-xl border border-primary/30 bg-primary/[0.04] p-6" aria-labelledby="offer-title">
          <div className="space-y-2">
            {pkg.trial && (
              <Badge variant="secondary" className="font-normal">
                Free {trialDays}-day trial{pkg.trial.requiresPaymentMethod ? '' : ' · No credit card'}
              </Badge>
            )}
            <h2 id="offer-title" className="text-xl font-semibold leading-tight">
              Let Cortex AI build your site
            </h2>
            <p className="text-sm text-muted-foreground">{pkg.tagline}</p>
          </div>

          <ul className="grid gap-3 text-sm sm:grid-cols-3">
            <li className="flex gap-2">
              <MessageSquareText className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span>
                <span className="font-medium">Asks about your business</span>
                <br />
                <span className="text-muted-foreground">A two-minute form (or a chat, if you prefer).</span>
              </span>
            </li>
            <li className="flex gap-2">
              <ListChecks className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span>
                <span className="font-medium">Proposes a plan</span>
                <br />
                <span className="text-muted-foreground">Pages, menus, tone. You approve it once.</span>
              </span>
            </li>
            <li className="flex gap-2">
              <Layers className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span>
                <span className="font-medium">Builds it</span>
                <br />
                <span className="text-muted-foreground">Pages, navigation, branding and translations.</span>
              </span>
            </li>
          </ul>

          <div className="space-y-1 rounded-lg border bg-background p-4 text-sm">
            <p className="font-medium text-foreground">
              {pkg.trial
                ? `Free for ${trialDays} days, then ${offer.priceLine}.`
                : offer.priceLine}{' '}
              <span className="text-muted-foreground">The CMS itself is free forever.</span>
            </p>
            <p className="text-xs text-muted-foreground">
              {pkg.trial?.requiresPaymentMethod
                ? 'Cancel anytime before the trial ends.'
                : 'Nothing is charged during the trial; when it ends, Cortex switches off until you buy a license.'}
            </p>
            <p className="flex items-center gap-1.5 pt-1 text-xs text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5" />
              Secure checkout by Freemius. The license activates on this site as soon as you finish.
            </p>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            {pkg.trial && (
              <Button className="sm:flex-1" onClick={() => void openCheckout('trial')} size="lg" type="button">
                <Sparkles className="mr-2 h-4 w-4" />
                Start my free {trialDays}-day trial
              </Button>
            )}
            <Button asChild className="sm:flex-1" size="lg" variant="outline">
              <Link href={DASHBOARD_HREF}>
                Not now, take me to my CMS
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <button
              className="underline-offset-2 hover:underline"
              onClick={() => void openCheckout('buy', 'annual')}
              type="button"
            >
              Buy now · {formatPackagePrice(pkg.pricing.annual, pkg.pricing.currency)}/year
            </button>
            {monthlyPrice && (
              <button
                className="underline-offset-2 hover:underline"
                onClick={() => void openCheckout('buy', 'monthly')}
                type="button"
              >
                or {formatPackagePrice(monthlyPrice, pkg.pricing.currency)}/month
              </button>
            )}
            <button
              className="underline-offset-2 hover:underline"
              onClick={() => setStage({ kind: 'key_only' })}
              type="button"
            >
              Already have a license key?
            </button>
            <a
              className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
              href={pkg.purchase_url}
              rel="noopener noreferrer"
              target="_blank"
            >
              Learn more on nextblock.dev
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </section>
      )}

      {stage.kind === 'checkout' && (
        <section className="flex flex-col items-center gap-3 rounded-xl border p-10 text-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm font-medium">The secure checkout is open.</p>
          <p className="text-xs text-muted-foreground">
            Finish there and this page continues on its own. Closing the checkout brings you back here.
          </p>
        </section>
      )}

      {stage.kind === 'activating' && (
        <section className="flex flex-col items-center gap-3 rounded-xl border p-10 text-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm font-medium">Activating {pkg.name}…</p>
          <p className="text-xs text-muted-foreground">
            Fetching your license key and activating it on this site. This takes a few seconds.
          </p>
        </section>
      )}

      {stage.kind === 'activated' && (
        <section className="space-y-4 rounded-xl border border-emerald-500/40 bg-emerald-50/60 p-6 dark:bg-emerald-950/20">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
            <div className="space-y-1">
              <h2 className="text-lg font-semibold">{pkg.name} is active</h2>
              <p className="text-sm text-muted-foreground">
                {stage.result.isTrial
                  ? `Your free trial has started${trialEndsAt ? ` and runs until ${formatPackageDate(trialEndsAt)}` : ''}. Your license key was also emailed to you.`
                  : 'Your license is activated on this site. The key was also emailed to you for safekeeping.'}
                {agentInitiated
                  ? ' Your coding agent picks this up on its next status check — you can return to your terminal.'
                  : ''}
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              className="sm:flex-1"
              onClick={() => window.location.assign(CMS_WELCOME_PATH)}
              size="lg"
              type="button"
            >
              Continue to Cortex setup
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
            <Button asChild size="lg" variant="ghost">
              <Link href={DASHBOARD_HREF}>Go to the dashboard</Link>
            </Button>
          </div>
        </section>
      )}

      {(stage.kind === 'needs_key' || stage.kind === 'key_only') && (
        <section className="space-y-4 rounded-xl border p-6">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">
              {stage.kind === 'needs_key' ? 'One more step' : `Activate ${pkg.name}`}
            </h2>
            <p className="text-sm text-muted-foreground">
              {stage.kind === 'needs_key'
                ? stage.message
                : 'Paste the license key from your purchase email to unlock the package on this site.'}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="welcome-license-key" className="text-xs">
              License key
            </Label>
            <Input
              autoFocus
              id="welcome-license-key"
              onChange={(event) => setManualKey(event.target.value)}
              placeholder="Your Freemius license key"
              value={manualKey}
            />
            {stage.kind === 'needs_key' && stage.email ? (
              <p className="text-xs text-muted-foreground">The email was sent to {stage.email}.</p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || !manualKey.trim()} onClick={() => void activateManualKey()} type="button">
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
              Activate license
            </Button>
            {stage.kind === 'needs_key' && stage.resendEmailEndpoint ? (
              <Button disabled={busy} onClick={() => void resendEmail(stage.resendEmailEndpoint as string)} type="button" variant="ghost">
                Resend the license email
              </Button>
            ) : null}
            {stage.kind === 'key_only' ? (
              <Button onClick={() => setStage({ kind: 'offer' })} type="button" variant="ghost">
                Back
              </Button>
            ) : null}
          </div>
        </section>
      )}

      <footer className="border-t pt-4 text-xs text-muted-foreground">
        You can start the trial any time later from the dashboard checklist or Settings → Packages.
      </footer>
    </div>
  );
}
