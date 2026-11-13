import { Badge } from '@nextblock-cms/ui';
import type {
  AffiliateBadgeColor,
  AffiliateCommissionStatus,
  AffiliatePageStatus,
  AffiliatePayoutStatus,
  AffiliateStatus,
} from '@nextblock-cms/affiliates';
import {
  AFFILIATE_COMMISSION_STATUS_CLASS,
  AFFILIATE_COMMISSION_STATUS_LABEL,
  AFFILIATE_PAGE_STATUS_CLASS,
  AFFILIATE_PAGE_STATUS_LABEL,
  AFFILIATE_PARTNER_STATUS_CLASS,
  AFFILIATE_PARTNER_STATUS_LABEL,
  AFFILIATE_PAYOUT_STATUS_CLASS,
  AFFILIATE_PAYOUT_STATUS_LABEL,
  AFFILIATE_STOREFRONT_STATE_CLASS,
  AFFILIATE_STOREFRONT_STATE_LABEL,
  AFFILIATE_TIER_BADGE_CLASS,
  type AffiliateStorefrontStateKey,
} from './labels';

/**
 * Status badges of the affiliates screens, in the `VisibilityBadge` style (a literal class map per
 * state, colour plus text so the state never relies on colour alone).
 */

export function AffiliatePartnerStatusBadge({ status }: { status: AffiliateStatus }) {
  return (
    <Badge variant="outline" className={AFFILIATE_PARTNER_STATUS_CLASS[status]}>
      {AFFILIATE_PARTNER_STATUS_LABEL[status]}
    </Badge>
  );
}

/** Live, Paused or Not published yet: whether `/partners/<handle>` serves the storefront. */
export function AffiliateStorefrontStateBadge({ state }: { state: AffiliateStorefrontStateKey }) {
  return (
    <Badge variant="outline" className={AFFILIATE_STOREFRONT_STATE_CLASS[state]}>
      {AFFILIATE_STOREFRONT_STATE_LABEL[state]}
    </Badge>
  );
}

export function AffiliatePageStatusBadge({ status }: { status: AffiliatePageStatus }) {
  return (
    <Badge variant="outline" className={AFFILIATE_PAGE_STATUS_CLASS[status]}>
      {AFFILIATE_PAGE_STATUS_LABEL[status]}
    </Badge>
  );
}

export function AffiliateCommissionStatusBadge({ status }: { status: AffiliateCommissionStatus }) {
  return (
    <Badge variant="outline" className={AFFILIATE_COMMISSION_STATUS_CLASS[status]}>
      {AFFILIATE_COMMISSION_STATUS_LABEL[status]}
    </Badge>
  );
}

export function AffiliatePayoutStatusBadge({ status }: { status: AffiliatePayoutStatus }) {
  return (
    <Badge variant="outline" className={AFFILIATE_PAYOUT_STATUS_CLASS[status]}>
      {AFFILIATE_PAYOUT_STATUS_LABEL[status]}
    </Badge>
  );
}

export function AffiliateTierBadge({ name, color }: { name: string; color: AffiliateBadgeColor | null }) {
  return (
    <Badge variant="outline" className={AFFILIATE_TIER_BADGE_CLASS[color ?? 'slate']}>
      {name}
    </Badge>
  );
}
