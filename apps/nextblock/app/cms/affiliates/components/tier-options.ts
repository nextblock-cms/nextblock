import { affiliateTierHasCapacity, type AffiliateTierRow } from '@nextblock-cms/affiliates';
import { formatAdminRate } from './format';

/** One tier as the "Change tier" control lists it (values formatted on the server). */
export interface PartnerTierOption {
  id: string;
  name: string;
  /** "35%" */
  rateLabel: string;
  isActive: boolean;
  /** Capped and at its cap: the move needs "Assign over the cap". */
  isFull: boolean;
}

/**
 * The options of `PartnerTierControl` (the Overview rows and the review page's Partner card), every
 * tier in the order the screens list them, inactive ones included (shown, never selectable).
 */
export function buildPartnerTierOptions(tiers: readonly AffiliateTierRow[]): PartnerTierOption[] {
  return tiers.map((tier) => ({
    id: tier.id,
    name: tier.name,
    rateLabel: formatAdminRate(tier.commission_percentage),
    isActive: tier.is_active,
    isFull: !affiliateTierHasCapacity(tier),
  }));
}
