'use client';

import { useId, useState } from 'react';
import { CirclePause, CirclePlay } from 'lucide-react';
import {
  Button,
  ConfirmationDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Textarea,
} from '@nextblock-cms/ui';
import { reactivateAffiliatePartnerAction, suspendAffiliatePartnerAction } from '../actions';
import { useAffiliateAdminAction } from './use-admin-action';

export interface PartnerStatusControlsProps {
  affiliateId: string;
  handle: string;
  /** The partner's display name, for the confirmation text (the handle stands in when empty). */
  displayName: string;
  status: 'ACTIVE' | 'SUSPENDED';
  /**
   * The partner was approved once (`first_published_at` is set): they have a public storefront and
   * referral links that earn. Before a first approval a pause only locks their portal, so the
   * dialogs say that instead of promising a storefront, earnings or credits they never had.
   */
  isApproved: boolean;
  /**
   * The id of the note that says why partner accounts cannot be changed here (the public sandbox,
   * whose demo partners every visitor shares). When set, the button renders disabled and is
   * described by that note. The server actions refuse on the sandbox either way.
   */
  lockedNoteId?: string;
}

const REASON_MAX = 500;

/**
 * What a pause and a resume do, in the dialogs. For an approved partner the crediting sentence
 * follows `reconcile_affiliate_commissions` (02030), the first step of every payout cycle: only
 * orders attributed before the pause and paid during it, and only while they are at most 120 days
 * old; an order placed during the pause is attributed to nobody and never earns.
 */
function describeAffiliatePartnerPause(name: string, isApproved: boolean): string {
  return isApproved
    ? `${name}'s storefront goes offline and their referral links stop earning until you resume. Earned balances are kept and payouts wait. Orders placed before the pause and paid during it are credited at the first payout run after you resume (orders up to 120 days old).`
    : `${name} can't edit or submit their storefront until you resume. Nothing of theirs is public yet, and they earn nothing before a first approval.`;
}

function describeAffiliatePartnerResume(name: string, isApproved: boolean): string {
  return isApproved
    ? `${name}'s last approved storefront goes back online and their referral links earn again. Payouts resume, and orders placed before the pause and paid during it (up to 120 days old) are credited at the next payout run.`
    : `${name} can edit their storefront again and submit it for review.`;
}

/**
 * "Pause partner" (with an optional reason) or "Resume partner": the partner-level suspension of
 * `suspendAffiliatePartnerAction` / `reactivateAffiliatePartnerAction`, under the CMS's words for
 * it. Shared by the Overview partner table, the approvals Storefronts list and the review page.
 */
export function PartnerStatusControls({
  affiliateId,
  handle,
  displayName,
  status,
  isApproved,
  lockedNoteId,
}: PartnerStatusControlsProps) {
  const { run, isPending } = useAffiliateAdminAction();
  const locked = Boolean(lockedNoteId);
  const [pauseOpen, setPauseOpen] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [reason, setReason] = useState('');
  const reasonId = useId();
  const name = displayName.trim() || `@${handle}`;

  return (
    <>
      {status === 'ACTIVE' ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            setReason('');
            setPauseOpen(true);
          }}
          disabled={locked || isPending}
          aria-describedby={lockedNoteId}
          aria-label={`Pause partner @${handle}`}
        >
          <CirclePause className="h-4 w-4" aria-hidden="true" />
          Pause partner
        </Button>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setResumeOpen(true)}
          disabled={locked || isPending}
          aria-describedby={lockedNoteId}
          aria-label={`Resume partner @${handle}`}
        >
          <CirclePlay className="h-4 w-4" aria-hidden="true" />
          Resume partner
        </Button>
      )}

      <Dialog open={pauseOpen} onOpenChange={setPauseOpen}>
        <DialogContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              run(() => suspendAffiliatePartnerAction({ affiliateIdToUpdate: affiliateId, reason: reason.trim() || null }), {
                onSuccess: () => setPauseOpen(false),
              });
            }}
            className="space-y-4"
          >
            <DialogHeader>
              <DialogTitle>Pause @{handle}?</DialogTitle>
              <DialogDescription>{describeAffiliatePartnerPause(name, isApproved)}</DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor={reasonId}>Reason (optional)</Label>
              <Textarea
                id={reasonId}
                value={reason}
                maxLength={REASON_MAX}
                rows={3}
                aria-describedby={`${reasonId}-help`}
                onChange={(event) => setReason(event.target.value)}
              />
              <p id={`${reasonId}-help`} className="text-xs text-muted-foreground">
                Stored on the partner record (up to {REASON_MAX} characters). The partner sees it in their portal and in the
                notice we email them, so write it for them.
              </p>
            </div>
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={() => setPauseOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="destructive" disabled={isPending}>
                {isPending ? 'Pausing…' : 'Pause partner'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmationDialog
        isOpen={resumeOpen}
        onOpenChange={setResumeOpen}
        title={`Resume @${handle}?`}
        description={describeAffiliatePartnerResume(name, isApproved)}
        confirmText="Resume partner"
        isDestructive={false}
        onConfirm={() => {
          setResumeOpen(false);
          run(() => reactivateAffiliatePartnerAction({ affiliateIdToUpdate: affiliateId }));
        }}
      />
    </>
  );
}
