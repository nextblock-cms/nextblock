'use client';

import { useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { UserX } from 'lucide-react';
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
  Label,
} from '@nextblock-cms/ui';
import { removeAffiliatePartnerAction } from '../actions';

export interface RemovePartnerControlProps {
  affiliateId: string;
  handle: string;
  displayName: string;
  /**
   * Why removal is not offered (the partner has commission or payout history, or it could not be
   * checked), shown under the disabled button. Null when the partner can be removed.
   */
  blockedReason: string | null;
  /** The sandbox lock note's id: the button renders disabled and described by it. */
  lockedNoteId?: string;
  /** Where to go once the partner is gone (their review page no longer exists). */
  afterRemoveHref: string;
}

const NETWORK_ERROR = 'The request did not reach the server. Check your connection and try again.';

/** The handle as the server compares it: trimmed, one leading `@` dropped, lowercased. */
function typedHandle(value: string): string {
  return value.trim().replace(/^@/, '').trim().toLowerCase();
}

/**
 * "Remove partner": a destructive confirmation that needs the partner's handle typed out. The
 * server pauses the partner first and removes them only while their ledger is empty; otherwise
 * they stay paused and the toast says so.
 */
export function RemovePartnerControl({
  affiliateId,
  handle,
  displayName,
  blockedReason,
  lockedNoteId,
  afterRemoveHref,
}: RemovePartnerControlProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [isPending, startTransition] = useTransition();
  const inputId = useId();
  const blockedId = useId();
  const locked = Boolean(lockedNoteId);
  const name = displayName.trim() || `@${handle}`;
  const matches = typedHandle(typed) === handle;
  const describedBy = [lockedNoteId, blockedReason ? blockedId : null].filter(Boolean).join(' ') || undefined;

  const remove = () => {
    if (!matches) return;
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof removeAffiliatePartnerAction>>;
      try {
        result = await removeAffiliatePartnerAction({ affiliateIdToRemove: affiliateId, confirmHandle: typed });
      } catch {
        result = { ok: false, error: NETWORK_ERROR };
      }
      if (!result.ok) {
        toast.error(result.error);
        // A failure after the server paused the partner still changed the page.
        router.refresh();
        return;
      }
      setOpen(false);
      if (result.removed) {
        toast.success(result.message);
        router.push(afterRemoveHref);
        router.refresh();
      } else {
        toast.warning(result.message);
        router.refresh();
      }
    });
  };

  return (
    <div className="space-y-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="border-red-300 text-red-700 hover:bg-red-50 hover:text-red-800 dark:border-red-900/60 dark:text-red-300 dark:hover:bg-red-950/40"
        onClick={() => {
          setTyped('');
          setOpen(true);
        }}
        disabled={locked || isPending || blockedReason !== null}
        aria-describedby={describedBy}
        aria-label={`Remove partner @${handle}`}
      >
        <UserX className="h-4 w-4" aria-hidden="true" />
        Remove partner
      </Button>
      {blockedReason ? (
        <p id={blockedId} className="text-xs text-muted-foreground">
          {blockedReason}
        </p>
      ) : null}

      <Dialog open={open} onOpenChange={(next) => (isPending ? undefined : setOpen(next))}>
        <DialogContent>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              remove();
            }}
          >
            <DialogHeader>
              <DialogTitle>Remove @{handle}?</DialogTitle>
              <DialogDescription>
                This deletes {name}&rsquo;s partner account: their storefront, its draft and their click history. Their sign-in
                account stays as a regular customer account, and orders they referred are kept without the referral. Their
                Stripe Connect account and the images they uploaded are left as they are. This cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              They are paused first. If any commission or payout is on record by then, they stay paused instead of being
              removed.
            </p>
            <div className="space-y-2">
              <Label htmlFor={inputId}>
                Type <span className="font-mono font-semibold text-foreground">{handle}</span> to confirm
              </Label>
              <Input
                id={inputId}
                value={typed}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={80}
                onChange={(event) => setTyped(event.target.value)}
              />
            </div>
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
                Cancel
              </Button>
              <Button type="submit" variant="destructive" disabled={isPending || !matches}>
                {isPending ? 'Removing…' : 'Remove partner'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
