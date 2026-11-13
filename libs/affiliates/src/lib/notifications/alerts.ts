/**
 * `system_alerts` rows for the admin lifecycle events (SPEC §9). English (the CMS is English-only),
 * plain text (the CMS renders it escaped), and a relative `metadata.action_url` inside
 * `/cms/affiliates` with its `action_label` for the banner and the affiliates overview. The copy
 * of REFUND_AFTER_PAYOUT matches the alert the database inserts itself (02030), so both read the
 * same in the CMS.
 */
import {
  AFFILIATE_ALERT_TYPES,
  AFFILIATE_CMS_APPROVALS_PATH,
  AFFILIATE_CMS_PATH,
  AFFILIATE_CMS_PAYOUTS_PATH,
} from '../core/constants';
import type { AffiliateAdminLifecycleEvent, AffiliateEmailData, AffiliateSystemAlertInsert } from '../core/types';
import { interpolateAffiliatesCopy } from '../i18n/copy-runtime';
import type { AffiliatesCopyValues } from '../i18n/types';
import { AFFILIATE_ADMIN_EMAIL_COPY, type AffiliateAdminEmailCopyKey } from './copy';
import { cleanAffiliateEmailText } from './escape';

const MAX_TITLE = 200;
const MAX_MESSAGE = 2000;

function text(key: AffiliateAdminEmailCopyKey, values?: AffiliatesCopyValues): string {
  return interpolateAffiliatesCopy(AFFILIATE_ADMIN_EMAIL_COPY[key], values);
}

function line(value: unknown, max: number): string {
  return cleanAffiliateEmailText(value, { max });
}

function isAdminEvent(event: unknown): event is AffiliateAdminLifecycleEvent {
  return typeof event === 'string' && Object.prototype.hasOwnProperty.call(AFFILIATE_ALERT_TYPES, event);
}

function spotsSentence(spots: number): string {
  if (spots <= 0) return text('alert.signed_up.spots_none');
  return spots === 1 ? text('alert.signed_up.spots_one') : text('alert.signed_up.spots_other', { spots });
}

/**
 * The alert for an admin lifecycle event: `alert_type` from `AFFILIATE_ALERT_TYPES`, a title, a
 * one-line message, and metadata with `action_url` (`/cms/affiliates`, `…/approvals` for page
 * submissions, `…/payouts` for payout failures and refunds after payout), `action_label` and the
 * partner details that were known (handle, display name, tier, amount, reason, order, transfer).
 * Throws for an event that is not an admin event.
 */
export function buildAffiliateSystemAlert(
  event: AffiliateAdminLifecycleEvent,
  data: AffiliateEmailData
): AffiliateSystemAlertInsert {
  if (!isAdminEvent(event)) {
    throw new TypeError(`Not an admin affiliate lifecycle event: ${String(event).slice(0, 40)}`);
  }
  const source: Partial<AffiliateEmailData> = data ?? {};
  const displayName = line(source.displayName, 80);
  const handle = line(source.handle, 64);
  const name = displayName || (handle ? `@${handle}` : text('common.partner_fallback'));
  const tier = line(source.tierName, 120);
  const amount = line(source.amountLabel, 120);
  const reason = line(source.reason, 500);
  const order = line(source.orderId, 128);
  const transferId = line(source.transferId, 255);
  const spots =
    typeof source.spotsRemaining === 'number' && Number.isFinite(source.spotsRemaining)
      ? Math.max(0, Math.floor(source.spotsRemaining))
      : null;

  let title: string;
  let message: string;
  let actionUrl: string = AFFILIATE_CMS_PATH;
  let actionLabel = text('alert.label.partners');

  switch (event) {
    case 'SIGNED_UP':
      title = text('alert.signed_up.title');
      message = tier ? text('alert.signed_up.message_tier', { name, tier }) : text('alert.signed_up.message', { name });
      if (spots !== null) message = `${message} ${spotsSentence(spots)}`;
      break;
    case 'PROFILE_COMPLETED':
      title = text('alert.profile_completed.title');
      message = text('alert.profile_completed.message', { name });
      break;
    case 'PAYOUT_CONFIGURED':
      title = text('alert.payout_configured.title');
      message = text('alert.payout_configured.message', { name });
      break;
    case 'PAGE_SUBMITTED':
      title = text('alert.page_submitted.title');
      message = text('alert.page_submitted.message', { name });
      actionUrl = AFFILIATE_CMS_APPROVALS_PATH;
      actionLabel = text('alert.label.approvals');
      break;
    case 'PAYOUT_FAILED':
      title = text('alert.payout_failed.title');
      message = amount
        ? text('alert.payout_failed.message_amount', { amount, name })
        : text('alert.payout_failed.message', { name });
      if (reason) message = `${message} ${text('alert.payout_failed.reason', { reason })}`;
      actionUrl = AFFILIATE_CMS_PAYOUTS_PATH;
      actionLabel = text('alert.label.payouts');
      break;
    case 'REFUND_AFTER_PAYOUT':
    default: {
      // A payout recorded by hand (02036) has no Stripe transfer to reverse; one only prepared may not
      // have been sent yet. A PayPal payout (02037) still in flight is settled by PayPal's answer; a
      // completed one is recovered from the partner, like a manual one.
      const paypal = source.payoutMethod === 'paypal';
      const paypalInFlight = paypal && source.payoutPrepared === true;
      const manual = source.payoutMethod === 'manual' || (paypal && !paypalInFlight);
      const prepared = source.payoutMethod === 'manual' && source.payoutPrepared === true;
      title = text('alert.refund_after_payout.title');
      message = order
        ? text(
            paypalInFlight
              ? 'alert.refund_after_payout.message_order_paypal_in_flight'
              : prepared
                ? 'alert.refund_after_payout.message_order_manual_prepared'
                : manual
                  ? 'alert.refund_after_payout.message_order_manual'
                  : 'alert.refund_after_payout.message_order',
            { order }
          )
        : text(
            paypalInFlight
              ? 'alert.refund_after_payout.message_paypal_in_flight'
              : prepared
                ? 'alert.refund_after_payout.message_manual_prepared'
                : manual
                  ? 'alert.refund_after_payout.message_manual'
                  : 'alert.refund_after_payout.message'
          );
      actionUrl = AFFILIATE_CMS_PAYOUTS_PATH;
      actionLabel = text('alert.label.payouts');
      break;
    }
  }

  const metadata: AffiliateSystemAlertInsert['metadata'] = { action_url: actionUrl, action_label: actionLabel };
  if (event === 'REFUND_AFTER_PAYOUT' && (source.payoutMethod === 'manual' || source.payoutMethod === 'paypal')) {
    metadata['payout_method'] = source.payoutMethod;
    if (source.payoutPrepared === true) metadata['payout_status'] = 'PROCESSING';
  }
  if (handle) metadata['handle'] = handle;
  if (displayName) metadata['display_name'] = displayName;
  if (tier) metadata['tier_name'] = tier;
  if (spots !== null && event === 'SIGNED_UP') metadata['spots_remaining'] = spots;
  if (amount) metadata['amount_label'] = amount;
  if (reason) metadata['reason'] = reason;
  if (order) metadata['order_id'] = order;
  if (transferId) metadata['transfer_id'] = transferId;

  return {
    alert_type: AFFILIATE_ALERT_TYPES[event],
    title: line(title, MAX_TITLE),
    message: line(message, MAX_MESSAGE),
    metadata,
  };
}
