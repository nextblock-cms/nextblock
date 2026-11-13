'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { Play, RefreshCw, Undo2 } from 'lucide-react';
import { Button, ConfirmationDialog } from '@nextblock-cms/ui';
import { releaseAffiliatePayout, retryAffiliatePayout, runAffiliatePayoutsNow } from '../actions';
import { useAffiliateAdminAction } from './use-admin-action';

/** Why "Run payouts now" is off, shown under the button, with the CMS screen that fixes it. */
export interface RunPayoutsDisabledReason {
  text: string;
  href?: string;
  linkLabel?: string;
}

/**
 * How the program pays its partners (02036): every commission through Stripe Connect (`stripe`),
 * some by hand (`mixed`), or every one by hand (`manual`, when the run only clears commissions).
 */
export type RunPayoutsRouting = 'stripe' | 'mixed' | 'manual';

const RUN_DESCRIPTION: Readonly<Record<RunPayoutsRouting, string>> = {
  stripe:
    'Clears commissions past their hold, then sends a Stripe transfer to every eligible partner whose cleared balance reaches the minimum payout. In-flight payouts are checked against Stripe first, so nothing is paid twice.',
  mixed:
    'Clears commissions past their hold, then sends a Stripe transfer for the commissions paid through Stripe to every eligible partner whose cleared balance reaches the minimum payout. In-flight payouts are checked against Stripe first, so nothing is paid twice. Commissions paid manually wait for you under Pay manually.',
  manual:
    'Clears commissions past their hold and records any the order trigger missed. Every commission is paid manually, so nothing is sent through Stripe: prepare, send and record each payout under Pay manually.',
};

/** The same while some gateway is paid with PayPal Payouts (02037): the run ends with the PayPal step. */
const RUN_DESCRIPTION_WITH_PAYPAL: Readonly<Record<RunPayoutsRouting, string>> = {
  stripe: RUN_DESCRIPTION.stripe,
  mixed:
    'Clears commissions past their hold, then sends a Stripe transfer for the commissions paid through Stripe and a PayPal payout, from your PayPal balance, for the ones paid with PayPal, to every eligible partner whose cleared balance reaches the minimum payout. Payouts in flight are checked with Stripe and PayPal first, so nothing is paid twice. Partners PayPal cannot pay wait for you under Pay manually.',
  manual:
    'Clears commissions past their hold, checks the PayPal payouts in flight, then sends a PayPal payout from your PayPal balance to every eligible partner with a PayPal payout email whose cleared balance reaches the minimum payout. Nothing is sent through Stripe. Commissions paid manually, and those of partners PayPal cannot pay, wait for you under Pay manually.',
};

/** "Run payouts now": the daily cycle on demand (it reconciles with Stripe, and checks PayPal, before it pays). */
export function RunPayoutsNowButton({
  disabledReason,
  routing = 'stripe',
  paypal = false,
}: {
  disabledReason: RunPayoutsDisabledReason | null;
  routing?: RunPayoutsRouting;
  /** Some gateway is paid with PayPal Payouts (02037). */
  paypal?: boolean;
}) {
  const { run, isPending } = useAffiliateAdminAction();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const reasonId = useId();

  return (
    <div className="flex flex-col items-start gap-1.5 sm:items-end">
      <Button
        type="button"
        disabled={isPending || disabledReason !== null}
        aria-describedby={disabledReason ? reasonId : undefined}
        onClick={() => setConfirmOpen(true)}
      >
        <Play className="h-4 w-4" aria-hidden="true" />
        {isPending ? 'Running…' : 'Run payouts now'}
      </Button>
      {disabledReason ? (
        <p id={reasonId} className="max-w-xs text-xs text-muted-foreground sm:text-right">
          {disabledReason.text}
          {disabledReason.href && disabledReason.linkLabel ? (
            <>
              {' '}
              <Link
                href={disabledReason.href}
                className="font-medium text-primary underline underline-offset-4 hover:no-underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              >
                {disabledReason.linkLabel}
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
      <ConfirmationDialog
        isOpen={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Run payouts now?"
        description={(paypal ? RUN_DESCRIPTION_WITH_PAYPAL : RUN_DESCRIPTION)[routing]}
        confirmText="Run payouts"
        isDestructive={false}
        onConfirm={() => {
          setConfirmOpen(false);
          run(() => runAffiliatePayoutsNow());
        }}
      />
    </div>
  );
}

/** Retry or release a FAILED payout. */
export function PayoutRowActions({ payoutId, partnerLabel, amountLabel }: { payoutId: string; partnerLabel: string; amountLabel: string }) {
  const { run, isPending } = useAffiliateAdminAction();
  const [pending, setPending] = useState<'retry' | 'release' | null>(null);

  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={isPending}
        onClick={() => setPending('retry')}
        aria-label={`Retry the ${amountLabel} payout to ${partnerLabel}`}
      >
        <RefreshCw className="h-4 w-4" aria-hidden="true" />
        Retry
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={isPending}
        onClick={() => setPending('release')}
        aria-label={`Release the ${amountLabel} payout to ${partnerLabel}`}
      >
        <Undo2 className="h-4 w-4" aria-hidden="true" />
        Release
      </Button>
      <ConfirmationDialog
        isOpen={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={pending === 'release' ? `Release the payout to ${partnerLabel}?` : `Retry the payout to ${partnerLabel}?`}
        description={
          pending === 'release'
            ? 'The payout is closed and its commissions go back to the partner’s cleared balance: the next Stripe run pays the ones paid through Stripe, and the ones paid manually appear under Pay manually.'
            : 'Stripe is checked for an existing transfer first; if there is none, a new transfer is sent for whatever is still owed (refunded commissions are left out).'
        }
        confirmText={pending === 'release' ? 'Release payout' : 'Retry payout'}
        isDestructive={pending === 'release'}
        onConfirm={() => {
          const action = pending;
          setPending(null);
          if (action === 'retry') run(() => retryAffiliatePayout({ payoutIdToRetry: payoutId }));
          if (action === 'release') run(() => releaseAffiliatePayout({ payoutIdToRelease: payoutId }));
        }}
      />
    </div>
  );
}
