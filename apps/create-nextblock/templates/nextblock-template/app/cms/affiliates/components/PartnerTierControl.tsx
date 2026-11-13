'use client';

import { useId, useState } from 'react';
import { ArrowRightLeft } from 'lucide-react';
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
} from '@nextblock-cms/ui';
import { changeAffiliatePartnerTierAction } from '../actions';
import type { PartnerTierOption } from './tier-options';
import { useAffiliateAdminAction } from './use-admin-action';

export type { PartnerTierOption } from './tier-options';

export interface PartnerTierControlProps {
  affiliateId: string;
  handle: string;
  /** The partner's display name, for the dialog text (the handle stands in when empty). */
  displayName: string;
  /** The partner's current tier. */
  tierId: string;
  /** Every tier (`buildPartnerTierOptions`), inactive ones included: they are listed, never selectable. */
  tiers: PartnerTierOption[];
  /**
   * The id of the note that says why partner accounts cannot be changed here (the public sandbox,
   * whose demo partners every visitor shares). When set, the button renders disabled and is
   * described by that note. The server action refuses on the sandbox either way.
   */
  lockedNoteId?: string;
}

const SELECT_CLASS =
  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';

function optionSuffix(tier: PartnerTierOption, currentTierId: string): string {
  if (tier.id === currentTierId) return ' – current';
  if (!tier.isActive) return ' – inactive';
  return tier.isFull ? ' – full' : '';
}

/**
 * "Change tier" (`changeAffiliatePartnerTierAction`): move a partner to another tier at any time,
 * paused or not. Shared by the Overview partner table and the review page's Partner card.
 *
 * - Active tiers are selectable; inactive ones are listed disabled, with the reason under the field.
 * - A full capped tier stays selectable: picking it shows "Assign over the cap" (the cap only limits
 *   public sign-ups and the spots-left count), and the move waits for that box, as its help says.
 *   A tier that filled up after the page loaded is refused (`tier_full`); the action re-renders the
 *   page, so the open dialog keeps the selection and shows the box.
 * - "Email the partner" (off by default) sends them the new tier and rate once the move went through.
 * - The confirmation says what the move changes: orders paid from now on earn the new rate, and
 *   commissions already recorded keep theirs (each order stores its rate when it is paid). It sits
 *   in a polite live region (announced when the selection changes) and describes "Move partner".
 */
export function PartnerTierControl({ affiliateId, handle, displayName, tierId, tiers, lockedNoteId }: PartnerTierControlProps) {
  const { run, isPending } = useAffiliateAdminAction();
  const locked = Boolean(lockedNoteId);
  const [open, setOpen] = useState(false);
  const [selectedTier, setSelectedTier] = useState(tierId);
  const [overCap, setOverCap] = useState(false);
  const [notifyPartner, setNotifyPartner] = useState(false);
  const baseId = useId();
  const selectId = `${baseId}-tier`;
  const inactiveHelpId = `${baseId}-inactive-help`;
  const overCapId = `${baseId}-over-cap`;
  const emailId = `${baseId}-email`;
  const confirmId = `${baseId}-confirm`;

  const name = displayName.trim() || `@${handle}`;
  const currentTier = tiers.find((tier) => tier.id === tierId);
  const target = tiers.find((tier) => tier.id === selectedTier);
  const changed = Boolean(target) && selectedTier !== tierId;
  const targetFull = changed && Boolean(target?.isFull);
  const targetUsable = changed && Boolean(target?.isActive) && (!targetFull || overCap);
  const hasInactive = tiers.some((tier) => !tier.isActive && tier.id !== tierId);

  const selectable = (tier: PartnerTierOption) => tier.id === tierId || tier.isActive;

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => {
          setSelectedTier(tierId);
          setOverCap(false);
          setNotifyPartner(false);
          setOpen(true);
        }}
        disabled={locked || isPending}
        aria-describedby={lockedNoteId}
        aria-label={`Change tier of @${handle}`}
      >
        <ArrowRightLeft className="h-4 w-4" aria-hidden="true" />
        Change tier
      </Button>

      <Dialog open={open} onOpenChange={(next) => (isPending ? undefined : setOpen(next))}>
        <DialogContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!changed) {
                setOpen(false);
                return;
              }
              if (!targetUsable) return;
              run(
                () =>
                  changeAffiliatePartnerTierAction({
                    affiliateIdToUpdate: affiliateId,
                    tierIdToAssign: selectedTier,
                    ...(targetFull && overCap ? { allowOverCap: true } : {}),
                    ...(notifyPartner ? { notifyPartner: true } : {}),
                  }),
                { onSuccess: () => setOpen(false) }
              );
            }}
            className="space-y-4"
          >
            <DialogHeader>
              <DialogTitle>Change the tier of @{handle}</DialogTitle>
              <DialogDescription>
                {currentTier
                  ? `${name} is in ${currentTier.name} (${currentTier.rateLabel}). Move them to another tier at any time, even while they are paused.`
                  : `Move ${name} to another tier at any time, even while they are paused.`}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-2">
              <Label htmlFor={selectId}>New tier</Label>
              <select
                id={selectId}
                className={SELECT_CLASS}
                value={selectedTier}
                aria-describedby={hasInactive ? inactiveHelpId : undefined}
                onChange={(event) => {
                  setSelectedTier(event.target.value);
                  setOverCap(false);
                }}
              >
                {tiers.map((tier) => (
                  <option key={tier.id} value={tier.id} disabled={!selectable(tier)}>
                    {tier.name} ({tier.rateLabel}){optionSuffix(tier, tierId)}
                  </option>
                ))}
              </select>
              {hasInactive ? (
                <p id={inactiveHelpId} className="text-xs text-muted-foreground">
                  Inactive tiers can&rsquo;t take partners: activate one on the Tiers screen first.
                </p>
              ) : null}
            </div>

            {targetFull && target ? (
              <div className="flex items-start gap-3">
                <Checkbox
                  id={overCapId}
                  checked={overCap}
                  onCheckedChange={(checked) => setOverCap(checked === true)}
                  aria-describedby={`${overCapId}-help`}
                  className="mt-0.5"
                />
                <div className="space-y-0.5">
                  <Label htmlFor={overCapId}>Assign over the cap</Label>
                  <p id={`${overCapId}-help`} className="text-xs text-muted-foreground">
                    {target.name} is full. The cap only limits public sign-ups and the spots-left count on the partners page.
                    Tick it to move them anyway.
                  </p>
                </div>
              </div>
            ) : null}

            <div className="flex items-start gap-3">
              <Checkbox
                id={emailId}
                checked={notifyPartner}
                onCheckedChange={(checked) => setNotifyPartner(checked === true)}
                aria-describedby={`${emailId}-help`}
                className="mt-0.5"
              />
              <div className="space-y-0.5">
                <Label htmlFor={emailId}>Email the partner</Label>
                <p id={`${emailId}-help`} className="text-xs text-muted-foreground">
                  They get the new tier and its rate by email, in their language, once the move is saved.
                </p>
              </div>
            </div>

            {/* Always mounted, so a screen reader announces the sentence when a tier is picked (atomic:
                switching between two tiers changes only the rate). It also describes "Move partner". */}
            <div id={confirmId} role="status" aria-live="polite" aria-atomic="true">
              {changed && target ? (
                <p className="rounded-md border border-border bg-muted/30 p-3 text-sm text-foreground">
                  From now on, orders paid earn {target.rateLabel}. Commissions already recorded keep their rate.
                </p>
              ) : null}
            </div>

            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={isPending || !targetUsable}
                aria-describedby={changed && target ? confirmId : undefined}
              >
                {isPending ? 'Moving…' : 'Move partner'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
