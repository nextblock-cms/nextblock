'use client';

import { useId, useState, useTransition } from 'react';
import { PlugZap, RefreshCw, Save, Undo2, XCircle } from 'lucide-react';
import { Button, ConfirmationDialog, Input, Label } from '@nextblock-cms/ui';
import { cn } from '@nextblock-cms/utils';
import { useAffiliateAdminAction } from '../components/use-admin-action';
import {
  cancelAffiliatePayPalPayoutAction,
  saveAffiliatePayPalCredentialsAction,
  syncAffiliatePayPalPayoutsAction,
  testAffiliatePayPalConnectionAction,
  type TestAffiliatePayPalConnectionActionResult,
} from './actions';

/**
 * The client islands of `/cms/affiliates/paypal` (02037). Every text they show comes from the server
 * actions, already worded; the secret field is write-only (never pre-filled, cleared after a save).
 */

const NETWORK_ERROR = 'The request did not reach the server. Check your connection and try again.';

const SELECT_CLASS =
  'flex h-10 w-full max-w-xs rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

export interface PayPalCredentialsFormProps {
  environment: 'sandbox' | 'live';
  /** Per environment: what is saved or configured, for the placeholders (never a secret). */
  saved: Readonly<Record<'sandbox' | 'live', { clientIdLast4: string | null; savedInCms: boolean; configured: boolean }>>;
  /** Set when saving cannot work here (the sandbox): the form is shown disabled with this reason. */
  disabledReason: string | null;
}

/**
 * The credentials form: the environment and, for it, the client id and secret of the PayPal app.
 * Blank fields keep what is saved (or the PAYPAL_* environment variables). The server verifies them
 * with PayPal before it saves anything.
 */
export function PayPalCredentialsForm({ environment: initialEnvironment, saved, disabledReason }: PayPalCredentialsFormProps) {
  const { run, isPending } = useAffiliateAdminAction();
  const [environment, setEnvironment] = useState<'sandbox' | 'live'>(initialEnvironment);
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const environmentId = useId();
  const clientIdId = useId();
  const secretId = useId();
  const helpId = useId();
  const current = saved[environment];
  const locked = disabledReason !== null;

  return (
    <form
      className="space-y-4"
      aria-describedby={helpId}
      onSubmit={(event) => {
        event.preventDefault();
        run(() => saveAffiliatePayPalCredentialsAction({ environment, clientId: clientId.trim(), secret: secret.trim() }), {
          onSuccess: () => {
            setClientId('');
            setSecret('');
          },
        });
      }}
    >
      <div className="space-y-2">
        <Label htmlFor={environmentId}>Environment</Label>
        <select
          id={environmentId}
          value={environment}
          disabled={locked || isPending}
          onChange={(event) => setEnvironment(event.target.value === 'live' ? 'live' : 'sandbox')}
          className={SELECT_CLASS}
        >
          <option value="sandbox">Sandbox (test money, developer.paypal.com)</option>
          <option value="live">Live (real money)</option>
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor={clientIdId}>Client ID</Label>
        <Input
          id={clientIdId}
          value={clientId}
          maxLength={256}
          spellCheck={false}
          autoComplete="off"
          disabled={locked || isPending}
          onChange={(event) => setClientId(event.target.value)}
          placeholder={
            current.clientIdLast4
              ? `Ending in ${current.clientIdLast4} (leave blank to keep it)`
              : current.configured
                ? 'Configured (leave blank to keep it)'
                : 'Your PayPal app’s client ID'
          }
          className="max-w-xl font-mono"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={secretId}>Secret</Label>
        <Input
          id={secretId}
          type="password"
          value={secret}
          maxLength={256}
          spellCheck={false}
          autoComplete="new-password"
          disabled={locked || isPending}
          onChange={(event) => setSecret(event.target.value)}
          placeholder={current.configured ? 'Saved (leave blank to keep it)' : 'Your PayPal app’s secret'}
          className="max-w-xl font-mono"
        />
      </div>
      <p id={helpId} className="text-xs text-muted-foreground">
        {disabledReason ??
          'PayPal checks the credentials before they are saved: credentials PayPal rejects are not saved. The secret is stored encrypted and never shown again. Saving makes this environment the one new PayPal payouts go out in.'}
      </p>
      <Button type="submit" disabled={locked || isPending}>
        <Save className="h-4 w-4" aria-hidden="true" />
        {isPending ? 'Checking with PayPal…' : 'Check and save'}
      </Button>
    </form>
  );
}

/** "Test connection": a fresh token, the Payouts scope, the app id and the balance. Nothing is sent. */
export function PayPalConnectionTest({ disabledReason }: { disabledReason: string | null }) {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<TestAffiliatePayPalConnectionActionResult | null>(null);
  const reasonId = useId();

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={isPending || disabledReason !== null}
          aria-describedby={disabledReason ? reasonId : undefined}
          onClick={() =>
            startTransition(async () => {
              try {
                setResult(await testAffiliatePayPalConnectionAction());
              } catch {
                setResult({ ok: false, error: NETWORK_ERROR, reason: 'unknown' });
              }
            })
          }
        >
          <PlugZap className="h-4 w-4" aria-hidden="true" />
          {isPending ? 'Testing…' : 'Test connection'}
        </Button>
        {disabledReason ? (
          <p id={reasonId} className="text-xs text-muted-foreground">
            {disabledReason}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">Read-only: nothing is sent.</p>
        )}
      </div>
      <div role="status" aria-live="polite" className="space-y-3">
        {result === null ? null : result.ok ? (
          <>
            <p className="text-sm font-medium text-foreground">{result.message}</p>
            <dl className="divide-y divide-border rounded-md border border-border">
              {result.facts.map((fact) => (
                <div key={fact.label} className="grid gap-1 px-3 py-2.5 text-sm sm:grid-cols-[12rem_1fr]">
                  <dt className="text-muted-foreground">{fact.label}</dt>
                  <dd className="break-words text-foreground">{fact.value}</dd>
                </div>
              ))}
            </dl>
            <p className="text-xs text-muted-foreground">{result.note}</p>
          </>
        ) : (
          <p className={cn('text-sm', result.reason === 'sandbox' ? 'text-muted-foreground' : 'text-red-800 dark:text-red-300')}>
            {result.error}
          </p>
        )}
      </div>
    </div>
  );
}

/** "Check PayPal status now": the run's PayPal sync alone (nothing is claimed or sent). */
export function PayPalSyncButton({ disabledReason }: { disabledReason: string | null }) {
  const { run, isPending } = useAffiliateAdminAction();
  const reasonId = useId();
  return (
    <div className="flex flex-col items-start gap-1.5">
      <Button
        type="button"
        variant="outline"
        disabled={isPending || disabledReason !== null}
        aria-describedby={disabledReason ? reasonId : undefined}
        onClick={() => run(() => syncAffiliatePayPalPayoutsAction())}
      >
        <RefreshCw className={cn('h-4 w-4', isPending && 'animate-spin')} aria-hidden="true" />
        {isPending ? 'Checking…' : 'Check PayPal status now'}
      </Button>
      {disabledReason ? (
        <p id={reasonId} className="text-xs text-muted-foreground">
          {disabledReason}
        </p>
      ) : null}
    </div>
  );
}

/** What the confirmation of each row action says (the dialog's own dismiss button reads "Cancel"). */
function rowActionCopy(action: 'cancel' | 'release' | 'release_acknowledged', amountLabel: string, partnerLabel: string) {
  const paidAgain = 'the next payout run that sends PayPal payouts (automatic payouts on, or Run payouts now) pays them again';
  if (action === 'cancel') {
    return {
      button: 'Stop payment',
      label: `Stop the ${amountLabel} PayPal payment to ${partnerLabel}`,
      title: 'Stop this PayPal payment?',
      description: `PayPal is asked to stop the unclaimed ${amountLabel} payment to ${partnerLabel}: the money goes back to your PayPal balance, the commissions go back to what you owe, and the partner is emailed. PayPal is not tried at that payout email again until the partner saves it again: pay them under Payouts → Pay manually meanwhile. If PayPal paid it meanwhile, it is recorded as paid instead.`,
      confirm: 'Stop the payment',
    };
  }
  return {
    button: 'Release',
    label: `Release the ${amountLabel} PayPal payout to ${partnerLabel}`,
    title: 'Release this PayPal payout?',
    description:
      action === 'release'
        ? `PayPal never confirmed the batch of this ${amountLabel} payout to ${partnerLabel}. Release it only after checking under PayPal Business → Activity that PayPal sent no such payment: its commissions go back to what you owe, and ${paidAgain}.`
        : `PayPal accepted the batch of this ${amountLabel} payout to ${partnerLabel} but never settled it, and this site cannot get its status. Release it only after checking under PayPal Business → Activity that PayPal did not pay it and will not: if it did, releasing pays the partner twice. Its commissions go back to what you owe, and ${paidAgain}.`,
    confirm: 'Release the payout',
  };
}

/**
 * "Stop payment" (an UNCLAIMED item, at PayPal) or "Release" (a payout PayPal never confirmed, an hour
 * after its last send, or accepted and never settled, a week after it) of one PayPal payout in flight,
 * behind a confirmation.
 */
export function PayPalPayoutRowAction({
  payoutId,
  action,
  partnerLabel,
  amountLabel,
}: {
  payoutId: string;
  action: 'cancel' | 'release' | 'release_acknowledged';
  partnerLabel: string;
  amountLabel: string;
}) {
  const { run, isPending } = useAffiliateAdminAction();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const cancel = action === 'cancel';
  const copy = rowActionCopy(action, amountLabel, partnerLabel);
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={isPending}
        onClick={() => setConfirmOpen(true)}
        aria-label={copy.label}
      >
        {cancel ? <XCircle className="h-4 w-4" aria-hidden="true" /> : <Undo2 className="h-4 w-4" aria-hidden="true" />}
        {isPending ? 'Working…' : copy.button}
      </Button>
      <ConfirmationDialog
        isOpen={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={copy.title}
        description={copy.description}
        confirmText={copy.confirm}
        isDestructive
        onConfirm={() => {
          setConfirmOpen(false);
          run(() => cancelAffiliatePayPalPayoutAction({ payoutIdToCancel: payoutId }));
        }}
      />
    </>
  );
}
