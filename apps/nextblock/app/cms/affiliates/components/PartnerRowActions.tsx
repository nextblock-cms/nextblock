'use client';

import { PartnerStatusControls } from './PartnerStatusControls';
import { PartnerTierControl } from './PartnerTierControl';
import type { PartnerTierOption } from './tier-options';

export type { PartnerTierOption } from './tier-options';

export interface PartnerRowActionsProps {
  affiliateId: string;
  handle: string;
  /** For the pause confirmation ("{name}'s storefront goes offline…"). */
  displayName: string;
  status: 'ACTIVE' | 'SUSPENDED';
  /** Approved once (`first_published_at`): picks the pause / resume wording (see PartnerStatusControls). */
  isApproved: boolean;
  tierId: string;
  tiers: PartnerTierOption[];
  /**
   * The id of the note that says why partner accounts cannot be changed here (the public sandbox,
   * whose demo partners every visitor shares). When set, every control renders disabled and is
   * described by that note. The server actions refuse on the sandbox either way.
   */
  lockedNoteId?: string;
}

/** Per-partner moderation: move to another tier (`PartnerTierControl`), and pause or resume. */
export function PartnerRowActions({
  affiliateId,
  handle,
  displayName,
  status,
  isApproved,
  tierId,
  tiers,
  lockedNoteId,
}: PartnerRowActionsProps) {
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <PartnerTierControl
        affiliateId={affiliateId}
        handle={handle}
        displayName={displayName}
        tierId={tierId}
        tiers={tiers}
        lockedNoteId={lockedNoteId}
      />
      <PartnerStatusControls
        affiliateId={affiliateId}
        handle={handle}
        displayName={displayName}
        status={status}
        isApproved={isApproved}
        lockedNoteId={lockedNoteId}
      />
    </div>
  );
}
