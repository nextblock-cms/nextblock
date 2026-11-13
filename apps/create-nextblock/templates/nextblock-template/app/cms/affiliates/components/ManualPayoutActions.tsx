'use client';

import { useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { CircleX, ClipboardCheck, HandCoins, ListChecks } from 'lucide-react';
import {
  Button,
  ConfirmationDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Textarea,
} from '@nextblock-cms/ui';
import {
  cancelManualAffiliatePayoutAction,
  prepareManualAffiliatePayoutAction,
  prepareManualAffiliatePayPalPayoutsAction,
  recordManualAffiliatePayoutAction,
  type RecordManualAffiliatePayoutActionResult,
} from '../actions';
import { AFFILIATE_MANUAL_PAYOUT_CHANNEL_LABEL } from './labels';
import { useAffiliateAdminAction } from './use-admin-action';

/**
 * The "Pay manually" controls of /cms/affiliates/payouts (02036). A manual payout is prepared before
 * any money is sent, so what the admin sends is exactly what gets recorded:
 *
 * 1. "Prepare payout" (one partner) or "Prepare PayPal payouts" (every PayPal-ready partner of a
 *    currency) reserves the commissions owed in a prepared payout;
 * 2. the admin sends that amount (the PayPal payouts file lists the prepared payouts);
 * 3. "Record payout" records it with its reference once the payment is complete, or "Cancel" gives
 *    it up if it was never sent (its commissions go back to what is owed).
 *
 * Every action re-checks the admin, the sandbox and the input on the server.
 */

type ManualPayoutChannel = keyof typeof AFFILIATE_MANUAL_PAYOUT_CHANNEL_LABEL;

const CHANNELS = Object.keys(AFFILIATE_MANUAL_PAYOUT_CHANNEL_LABEL) as ManualPayoutChannel[];

const SELECT_CLASS =
  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';

const NETWORK_ERROR = 'The request did not reach the server. Check your connection and try again.';

function commissionsText(count: number): string {
  return `${count} ${count === 1 ? 'commission' : 'commissions'}`;
}

/** Why a control is off (the public sandbox), shown under it. The action refuses either way. */
function DisabledReason({ id, text }: { id: string; text: string | null | undefined }) {
  return text ? (
    <p id={id} className="max-w-[12rem] text-right text-xs text-muted-foreground">
      {text}
    </p>
  ) : null;
}

/** One commission a payout covers, formatted on the server ("Oct 20, 2026 · Order 1a2b3c4d · Freemius · $12.00"). */
export interface ManualPayoutCommissionLine {
  id: string;
  label: string;
}

/* ------------------------------------------------------------------- prepare --- */

export interface ManualPayoutPrepareButtonProps {
  affiliateId: string;
  handle: string;
  currency: string;
  /** What is owed now, formatted on the server (the server reserves whatever is owed when clicked). */
  amountLabel: string;
  disabledReason?: string | null;
}

/** "Prepare payout": reserves what one partner is owed by hand in one currency. Nothing is sent. */
export function ManualPayoutPrepareButton(props: ManualPayoutPrepareButtonProps) {
  const { run, isPending } = useAffiliateAdminAction();
  const reasonId = useId();
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={isPending || Boolean(props.disabledReason)}
        aria-describedby={props.disabledReason ? reasonId : undefined}
        aria-label={`Prepare payout of ${props.amountLabel} to @${props.handle}`}
        onClick={() => run(() => prepareManualAffiliatePayoutAction({ affiliateIdToPay: props.affiliateId, currency: props.currency }))}
      >
        <ClipboardCheck className="h-4 w-4" aria-hidden="true" />
        {isPending ? 'Preparing…' : 'Prepare payout'}
      </Button>
      <DisabledReason id={reasonId} text={props.disabledReason} />
    </div>
  );
}

export interface ManualPayPalPrepareButtonProps {
  currency: string;
  /** Partners "Prepare PayPal payouts" would take now, and what they are owed (formatted). */
  partners: number;
  amountLabel: string;
  minimumLabel: string;
  disabledReason?: string | null;
}

/** "Prepare PayPal payouts": a prepared payout for every PayPal-ready partner of one currency. */
export function ManualPayPalPrepareButton(props: ManualPayPalPrepareButtonProps) {
  const { run, isPending } = useAffiliateAdminAction();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const reasonId = useId();
  const partnersText = `${props.partners} ${props.partners === 1 ? 'partner' : 'partners'}`;
  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={isPending || Boolean(props.disabledReason)}
        aria-describedby={props.disabledReason ? reasonId : undefined}
        onClick={() => setConfirmOpen(true)}
      >
        <ListChecks className="h-4 w-4" aria-hidden="true" />
        {isPending ? 'Preparing…' : `Prepare PayPal payouts (${props.currency}, ${partnersText}, ${props.amountLabel})`}
      </Button>
      {props.disabledReason ? (
        <p id={reasonId} className="text-xs text-muted-foreground">
          {props.disabledReason}
        </p>
      ) : null}
      <ConfirmationDialog
        isOpen={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Prepare PayPal payouts in ${props.currency}?`}
        description={`This prepares a payout for each of the ${partnersText} owed in ${props.currency} who have a payout email and reach the minimum payout of ${props.minimumLabel}, so the PayPal payouts file lists them. It reserves what each one is owed now; nothing is sent.`}
        confirmText="Prepare payouts"
        isDestructive={false}
        onConfirm={() => {
          setConfirmOpen(false);
          run(() => prepareManualAffiliatePayPalPayoutsAction({ currency: props.currency }));
        }}
      />
    </div>
  );
}

/* -------------------------------------------------------------------- record --- */

export interface ManualPayoutRecordButtonProps {
  /** The prepared payout. */
  payoutId: string;
  handle: string;
  /** For the dialog text (the handle stands in when empty). */
  displayName: string;
  /** Fixed when it was prepared: exactly what to send, formatted on the server. */
  amountLabel: string;
  commissionCount: number;
  /** Its commissions, flagged ones first (the rest are counted in `commissionCount`). */
  commissions: ManualPayoutCommissionLine[];
  /** Where the partner wants the money (PayPal or Interac e-Transfer), or null. */
  payoutEmail: string | null;
  /** A refund or a dispute reached some of its commissions since it was prepared (shown as a warning). */
  changedSincePrepared: string | null;
  disabledReason?: string | null;
}

/**
 * "Record payout": once the money of a prepared payout reached the partner, records it with its
 * channel, reference and an optional note (the partner reads it). Step one shows the exact amount and
 * commissions; step two asks for confirmation in plain words ("It does not send any money. This
 * cannot be undone.").
 */
export function ManualPayoutRecordButton(props: ManualPayoutRecordButtonProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'details' | 'confirm'>('details');
  const [channel, setChannel] = useState<ManualPayoutChannel>('paypal');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const baseId = useId();
  const channelId = `${baseId}-channel`;
  const referenceId = `${baseId}-reference`;
  const noteId = `${baseId}-note`;
  const reasonId = `${baseId}-reason`;

  const name = props.displayName.trim() || `@${props.handle}`;
  const count = commissionsText(props.commissionCount);
  const hidden = Math.max(0, props.commissionCount - props.commissions.length);
  const confirmText = `Record ${props.amountLabel} paid to ${name} by ${AFFILIATE_MANUAL_PAYOUT_CHANNEL_LABEL[channel]}? This marks ${count} as paid. It does not send any money. This cannot be undone.`;

  const submit = () => {
    startTransition(async () => {
      let result: RecordManualAffiliatePayoutActionResult;
      try {
        result = await recordManualAffiliatePayoutAction({
          payoutIdToRecord: props.payoutId,
          channel,
          reference: reference.trim(),
          ...(note.trim() ? { note: note.trim() } : {}),
        });
      } catch {
        result = { ok: false, error: NETWORK_ERROR };
      }
      if (result.ok) {
        toast.success(result.message);
        setOpen(false);
        router.refresh();
        return;
      }
      toast.error(result.error);
      setStep('details');
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        size="sm"
        disabled={isPending || Boolean(props.disabledReason)}
        aria-describedby={props.disabledReason ? reasonId : undefined}
        aria-label={`Record payout of ${props.amountLabel} to @${props.handle}`}
        onClick={() => {
          setStep('details');
          setChannel('paypal');
          setReference('');
          setNote('');
          setOpen(true);
        }}
      >
        <HandCoins className="h-4 w-4" aria-hidden="true" />
        Record payout
      </Button>
      <DisabledReason id={reasonId} text={props.disabledReason} />

      <Dialog open={open} onOpenChange={(next) => (isPending ? undefined : setOpen(next))}>
        <DialogContent>
          {step === 'details' ? (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (!reference.trim()) return;
                setStep('confirm');
              }}
            >
              <DialogHeader>
                <DialogTitle>Record the payout to @{props.handle}</DialogTitle>
                <DialogDescription>
                  Send {props.amountLabel} to {name} (PayPal, Interac e-Transfer, Wise or your bank), then record it here once the
                  payment is complete.
                </DialogDescription>
              </DialogHeader>

              {props.changedSincePrepared ? (
                <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200">
                  {props.changedSincePrepared}
                </p>
              ) : null}

              <div className="space-y-1 rounded-md border border-border bg-muted/30 p-3 text-sm">
                <p className="font-medium text-foreground">
                  {props.amountLabel} for {count}
                </p>
                <p className="text-muted-foreground">
                  {props.payoutEmail ? `Payout email: ${props.payoutEmail}` : 'No payout email yet: ask the partner where to send it.'}
                </p>
                {props.commissions.length > 0 ? (
                  <ul className="mt-2 max-h-40 space-y-0.5 overflow-y-auto text-xs text-muted-foreground">
                    {props.commissions.map((commission) => (
                      <li key={commission.id}>{commission.label}</li>
                    ))}
                    {hidden > 0 ? <li>and {hidden} more</li> : null}
                  </ul>
                ) : null}
              </div>

              <div className="space-y-2">
                <Label htmlFor={channelId}>Sent with</Label>
                <select
                  id={channelId}
                  className={SELECT_CLASS}
                  value={channel}
                  onChange={(event) => setChannel((CHANNELS as string[]).includes(event.target.value) ? (event.target.value as ManualPayoutChannel) : 'other')}
                >
                  {CHANNELS.map((value) => (
                    <option key={value} value={value}>
                      {AFFILIATE_MANUAL_PAYOUT_CHANNEL_LABEL[value]}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <Label htmlFor={referenceId}>Reference</Label>
                <Input
                  id={referenceId}
                  value={reference}
                  required
                  maxLength={120}
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby={`${referenceId}-help`}
                  onChange={(event) => setReference(event.target.value)}
                />
                <p id={`${referenceId}-help`} className="text-xs text-muted-foreground">
                  The PayPal transaction ID, e-Transfer reference or bank reference
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor={noteId}>Note (optional)</Label>
                <Textarea
                  id={noteId}
                  value={note}
                  rows={2}
                  maxLength={500}
                  aria-describedby={`${noteId}-help`}
                  onChange={(event) => setNote(event.target.value)}
                />
                <p id={`${noteId}-help`} className="text-xs text-muted-foreground">
                  Visible to the partner
                </p>
              </div>

              <DialogFooter className="gap-2">
                <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
                  Close
                </Button>
                <Button type="submit" disabled={isPending || !reference.trim()}>
                  Continue
                </Button>
              </DialogFooter>
            </form>
          ) : (
            <div className="space-y-4">
              <DialogHeader>
                <DialogTitle>Record this payout?</DialogTitle>
                <DialogDescription>{confirmText}</DialogDescription>
              </DialogHeader>
              <DialogFooter className="gap-2">
                <Button type="button" variant="outline" onClick={() => setStep('details')} disabled={isPending}>
                  Back
                </Button>
                <Button type="button" onClick={submit} disabled={isPending}>
                  {isPending ? 'Recording…' : 'Record payout'}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* -------------------------------------------------------------------- cancel --- */

export interface ManualPayoutCancelButtonProps {
  payoutId: string;
  handle: string;
  displayName: string;
  amountLabel: string;
  commissionCount: number;
  disabledReason?: string | null;
}

/** "Cancel": gives up a prepared payout that was never sent; its commissions go back to what is owed. */
export function ManualPayoutCancelButton(props: ManualPayoutCancelButtonProps) {
  const { run, isPending } = useAffiliateAdminAction();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const reasonId = useId();
  const name = props.displayName.trim() || `@${props.handle}`;
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={isPending || Boolean(props.disabledReason)}
        aria-describedby={props.disabledReason ? reasonId : undefined}
        aria-label={`Cancel payout of ${props.amountLabel} to @${props.handle}`}
        onClick={() => setConfirmOpen(true)}
      >
        <CircleX className="h-4 w-4" aria-hidden="true" />
        Cancel
      </Button>
      <DisabledReason id={reasonId} text={props.disabledReason} />
      <ConfirmationDialog
        isOpen={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Cancel this prepared payout?"
        description={`Only cancel it if you have not sent ${props.amountLabel} to ${name}. Its ${commissionsText(props.commissionCount)} go back to what is owed, for a later payout.`}
        confirmText="Cancel payout"
        isDestructive
        onConfirm={() => {
          setConfirmOpen(false);
          run(() => cancelManualAffiliatePayoutAction({ payoutIdToCancel: props.payoutId }));
        }}
      />
    </div>
  );
}
