'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, MessageSquareWarning } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Textarea,
} from '@nextblock-cms/ui';
import { approveAffiliateStorefrontAction, requestAffiliateStorefrontChangesAction } from '../actions';
import { useAffiliateAdminAction } from './use-admin-action';

export interface ReviewActionsProps {
  pageId: string;
  handle: string;
  /** The `draft_version` on screen; the server refuses the decision if the page moved on. */
  draftVersion: number;
  /**
   * Fingerprint of the profile snapshot on screen; the server refuses Approve if the partner's
   * name, bio, avatar or links changed since (a profile edit does not move `draft_version`).
   */
  profileFingerprint: string;
  /** False when the page is not PENDING_REVIEW (the buttons are not offered). */
  canReview: boolean;
  /** Approve is blocked (empty draft or suspended partner); `approveBlockedReason` says why. */
  approveBlockedReason: string | null;
  isFirstPublication: boolean;
}

const NOTE_MAX = 2000;

/** Approve & Publish (one click) and Request Changes (with a required note). */
export function ReviewActions({
  pageId,
  handle,
  draftVersion,
  profileFingerprint,
  canReview,
  approveBlockedReason,
  isFirstPublication,
}: ReviewActionsProps) {
  const router = useRouter();
  const { run, isPending } = useAffiliateAdminAction();
  const [changesOpen, setChangesOpen] = useState(false);
  const [note, setNote] = useState('');
  const noteId = useId();
  const blockedId = useId();

  if (!canReview) return null;

  const trimmedNote = note.trim();
  // The public sandbox sends no email (lib/affiliates/notify.ts). Inlined at build, like SandboxCredentialsAlert reads it.
  const sandbox = process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={isPending || approveBlockedReason !== null}
          aria-describedby={approveBlockedReason ? blockedId : undefined}
          onClick={() =>
            run(
              () =>
                approveAffiliateStorefrontAction({
                  pageIdToApprove: pageId,
                  expectedDraftVersion: draftVersion,
                  expectedProfileFingerprint: profileFingerprint,
                }),
              {
                refresh: false,
                onSuccess: () => {
                  router.push('/cms/affiliates/approvals');
                  router.refresh();
                },
              }
            )
          }
        >
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
          {isPending ? 'Working…' : 'Approve & Publish'}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={isPending}
          onClick={() => {
            setNote('');
            setChangesOpen(true);
          }}
        >
          <MessageSquareWarning className="h-4 w-4" aria-hidden="true" />
          Request changes
        </Button>
      </div>
      {approveBlockedReason ? (
        <p id={blockedId} className="text-sm text-amber-800 dark:text-amber-300">
          {approveBlockedReason}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {isFirstPublication
            ? `Publishing makes /partners/${handle} public and lets @${handle} earn commissions from now on.`
            : `Publishing replaces the live storefront of @${handle} with the proposed version.`}
        </p>
      )}

      <Dialog open={changesOpen} onOpenChange={setChangesOpen}>
        <DialogContent className="sm:max-w-xl">
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!trimmedNote) return;
              run(
                () =>
                  requestAffiliateStorefrontChangesAction({
                    pageIdToReview: pageId,
                    note: trimmedNote,
                    expectedDraftVersion: draftVersion,
                  }),
                {
                  refresh: false,
                  onSuccess: () => {
                    setChangesOpen(false);
                    router.push('/cms/affiliates/approvals');
                    router.refresh();
                  },
                }
              );
            }}
          >
            <DialogHeader>
              <DialogTitle>Request changes from @{handle}</DialogTitle>
              <DialogDescription>
                {sandbox
                  ? 'The partner sees this note in their portal (the sandbox sends no email). Whatever is live now stays live.'
                  : 'The partner gets this note by email and in their portal. Whatever is live now stays live.'}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor={noteId}>What should change?</Label>
              <Textarea
                id={noteId}
                value={note}
                rows={6}
                maxLength={NOTE_MAX}
                required
                aria-describedby={`${noteId}-count`}
                onChange={(event) => setNote(event.target.value)}
              />
              <p id={`${noteId}-count`} className="text-xs text-muted-foreground">
                {note.length} / {NOTE_MAX} characters. Be specific: name the section, the claim or the image to change.
              </p>
            </div>
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={() => setChangesOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isPending || !trimmedNote}>
                {isPending ? 'Sending…' : 'Send to the partner'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
