import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AFFILIATE_ALERT_TYPES,
  AFFILIATE_CMS_PAYPAL_PATH,
  AFFILIATE_PAYPAL_ACKNOWLEDGED_RELEASE_DAYS,
  AFFILIATE_PAYPAL_RESEND_MAX_AGE_DAYS,
  formatAffiliateMoney,
} from '@nextblock-cms/affiliates';
import { notifyAffiliateLifecycle, scheduleAffiliateNotification } from '../notify';
import { AFFILIATE_PAYPAL_REQUEST_ACCESS_URL } from './client';
import type { AffiliatePayPalAlert, AffiliatePayPalPayoutEvent } from './engine';

/**
 * What the PayPal payouts tell people (02037, docs/15 → "Paying partners with PayPal").
 *
 * {@link dispatchAffiliatePayPalPayoutEvent} is THE hook for the partner side: every PayPal payout
 * event of the daily run, "Check PayPal status now" and the CMS Cancel comes through it, after the
 * ledger changed:
 *   - PAYOUT_SENT: the partner's "We sent you {amount} by PayPal." email (PAYOUT_SENT with
 *     `method: 'paypal'`, PayPal's transaction id as the reference);
 *   - PAYOUT_FAILED: the admin alert and email (PAYOUT_FAILED with `method: 'paypal'` and the PayPal
 *     advice), and the partner's PAYPAL_PAYOUT_FAILED email ("could not be sent: {reason}", the
 *     reason worded per locale from the run's code; its commissions are already back in the
 *     balance). An admin's own "Stop payment" (`cancelledByAdmin`) mails only the partner: the admin
 *     just did it, so no alert or admin email. Operator-side causes (the PayPal balance) never reach
 *     here: they are alerts;
 *   - PAYPAL_UNCLAIMED: the partner's email naming the address PayPal sent its claim link to (the
 *     payout's `paypal_receiver`), once, the first time the item is seen unclaimed.
 * The sandbox never runs PayPal, and the notifier mails nobody there.
 *
 * {@link recordAffiliatePayPalAlert} records the operator problems the engine collects (an empty
 * PayPal balance, Payouts not enabled, rejected credentials, a refused batch, an unknown status, a
 * batch PayPal will not confirm or show, a currency PayPal cannot send) as one
 * `affiliate_payout_failed` alert per kind (and currency) and
 * UTC day (`metadata.kind`, `alert_date`), linking the PayPal payouts screen. The CMS banner shows
 * them. Both never throw.
 */

type AnyClient = SupabaseClient<any>;

function money(amountCents: number | null | undefined, currency: string | null | undefined): string | null {
  if (typeof amountCents !== 'number' || !Number.isFinite(amountCents) || amountCents <= 0 || !currency) return null;
  try {
    return formatAffiliateMoney(amountCents, currency, 'en');
  } catch {
    return `${amountCents} ${currency}`;
  }
}

/** The admin's wording of a PayPal failure reason (`paypal_returned`, `paypal_failed:receiver_unregistered`). */
export function describeAffiliatePayPalFailure(reason: string | null | undefined): string {
  const value = typeof reason === 'string' ? reason : '';
  const [base, detail] = value.split(':', 2);
  const why = detail ? ` (${detail.toUpperCase()})` : '';
  switch (base) {
    case 'paypal_returned':
      return `PayPal returned the payout${why}: nobody claimed it within 30 days, or the partner's PayPal account could not take it.`;
    case 'paypal_cancelled':
    case 'paypal_canceled':
      return 'The payout was cancelled at PayPal before the partner claimed it.';
    case 'paypal_blocked':
      return `PayPal blocked the payout${why}.`;
    case 'paypal_refunded':
      return 'The partner refunded the PayPal payout.';
    case 'paypal_reversed':
      return 'PayPal reversed the payout.';
    case 'paypal_denied':
      return 'PayPal denied the whole payout batch.';
    case 'paypal_insufficient_funds':
      return 'The PayPal balance was too low.';
    case 'paypal_not_enabled':
      return 'PayPal Payouts is not enabled on this PayPal account or app.';
    case 'paypal_credentials':
      return 'PayPal rejected the client ID or secret.';
    case 'paypal_released_by_admin':
      return 'An admin released it: PayPal never confirmed its batch.';
    case 'paypal_refused':
      return `PayPal refused the payout batch${why}.`;
    case 'paypal_failed':
      return `PayPal could not pay it${why}.`;
    default:
      return value ? `PayPal did not pay it (${value}).` : 'PayPal did not pay it.';
  }
}

/** Routes a PayPal payout event to its notifications (see the file comment). Never throws. */
export function dispatchAffiliatePayPalPayoutEvent(event: AffiliatePayPalPayoutEvent): void {
  try {
    const { payout } = event;
    if (event.type === 'PAYOUT_SENT') {
      scheduleAffiliateNotification(() =>
        notifyAffiliateLifecycle('PAYOUT_SENT', {
          affiliateId: payout.affiliateId,
          payout: {
            payoutId: payout.payoutId,
            amountCents: payout.amountCents,
            currency: payout.currency,
            transferId: event.transactionId,
            method: 'paypal',
          },
        })
      );
      return;
    }
    if (event.type === 'PAYOUT_FAILED') {
      // The admin's own "Stop payment" raises no admin alert or email: they just did it, on screen.
      if (!event.cancelledByAdmin) {
        scheduleAffiliateNotification(() =>
          notifyAffiliateLifecycle('PAYOUT_FAILED', {
            affiliateId: payout.affiliateId,
            payout: {
              payoutId: payout.payoutId,
              amountCents: payout.amountCents,
              currency: payout.currency,
              reason: describeAffiliatePayPalFailure(event.reason),
              method: 'paypal',
            },
          })
        );
      }
      // The partner's side: the run's reason code, which the partner template words per locale.
      scheduleAffiliateNotification(() =>
        notifyAffiliateLifecycle('PAYPAL_PAYOUT_FAILED', {
          affiliateId: payout.affiliateId,
          payout: {
            payoutId: payout.payoutId,
            amountCents: payout.amountCents,
            currency: payout.currency,
            reason: event.reason,
            method: 'paypal',
          },
        })
      );
      return;
    }
    if (event.type === 'PAYPAL_UNCLAIMED') {
      // PayPal emailed its own claim link to the payout's address; this says where, and what to do.
      scheduleAffiliateNotification(() =>
        notifyAffiliateLifecycle('PAYPAL_UNCLAIMED', {
          affiliateId: payout.affiliateId,
          payout: {
            payoutId: payout.payoutId,
            amountCents: payout.amountCents,
            currency: payout.currency,
            method: 'paypal',
            receiver: payout.receiver,
          },
        })
      );
    }
  } catch (error) {
    console.warn('[affiliates] Could not schedule a PayPal payout notification', {
      type: event.type,
      message: error instanceof Error ? error.message : 'unknown',
    });
  }
}

const ALERT_TITLE: Readonly<Record<AffiliatePayPalAlert['kind'], string>> = {
  paypal_insufficient_funds: 'PayPal balance too low for partner payouts',
  paypal_not_enabled: 'PayPal Payouts is not enabled',
  paypal_credentials: 'PayPal rejected the payout credentials',
  paypal_refused: 'PayPal refused partner payouts',
  paypal_unknown_status: 'PayPal reported an unknown payout status',
  paypal_batch_unresolved: 'A PayPal payout batch needs checking',
  paypal_currency_unsupported: 'PayPal cannot send partner payouts in this currency',
};

/** "Look it up in PayPal…": what to do about payouts PayPal has not settled. */
const STUCK_RELEASE_HINT = `${AFFILIATE_PAYPAL_ACKNOWLEDGED_RELEASE_DAYS} days after its last send, a payout PayPal did not pay can be released on the PayPal payouts screen (check PayPal Activity first).`;

/** The message of a `paypal_batch_unresolved` alert, by its cause. */
function describeUnresolvedBatch(alert: AffiliatePayPalAlert, env: string, count: string, amount: string | null, code: string): string {
  const batch = alert.senderBatchId ? `the ${env} batch ${alert.senderBatchId}` : `a ${env} batch`;
  const owed = `${count}${amount ? ` (${amount})` : ''}`;
  const sentAgain = 'the next payout run that sends (automatic payouts on, or Run payouts now) sends it again with the same id, which PayPal pays at most once';
  switch (alert.cause) {
    case 'insufficient_funds':
      return `PayPal could not send ${batch} again${code}: your PayPal balance is too low. Its ${owed} stay in flight so nothing is paid twice (PayPal may hold the first send). Add ${alert.currency ?? 'the payout currency'} to your PayPal balance: ${sentAgain}.`;
    case 'not_enabled':
      return `PayPal refused to send ${batch} again${code}: Payouts is not enabled for this PayPal account or app. Its ${owed} stay in flight so nothing is paid twice (PayPal may hold the first send). Request access at ${AFFILIATE_PAYPAL_REQUEST_ACCESS_URL} and tick Payouts in your app; then ${sentAgain}.`;
    case 'credentials':
      return `PayPal rejected the ${env} client ID or secret, so ${batch} could not be sent again. Its ${owed} stay in flight so nothing is paid twice (PayPal may hold the first send). Save working credentials on the PayPal payouts screen; then ${sentAgain}.`;
    case 'expired':
      return `PayPal never confirmed ${batch}, first sent over ${AFFILIATE_PAYPAL_RESEND_MAX_AGE_DAYS} days ago, so it is not sent again: PayPal forgets a batch id after 30 days and could pay it twice. Its ${owed} stay in flight. Look the batch up in PayPal (Activity, Payouts). If PayPal never received it, release them on the PayPal payouts screen; if PayPal paid it, do not release them (they would be paid again): see docs/15, Paying partners with PayPal.`;
    case 'malformed':
      return `PayPal accepted ${batch} but its answer could not be read${code}. Its ${owed} stay in flight and are sent again with the same id, which PayPal pays at most once; the next PayPal check should settle them. If it does not, look the batch up in PayPal (Activity, Payouts).`;
    case 'not_recorded':
      return `PayPal accepted the ${env} batch ${alert.batchId ?? alert.senderBatchId ?? ''}${code}, but ${count} in it had been released or settled meanwhile, so PayPal may pay them although their commissions went back to what is owed. Look the batch up in PayPal (Activity, Payouts) and recover any payment it made for them.`;
    case 'unreadable':
      return `PayPal would not show the ${env} batch ${alert.batchId ?? ''}${code}, so ${owed} stay in flight and keep their commissions. If you changed the PayPal account or app since they were sent, save its credentials again so the payout run can check them. Otherwise check the batch in PayPal (Activity, Payouts). ${STUCK_RELEASE_HINT}`;
    default:
      return `PayPal did not confirm ${batch} when it was sent again${code}. Its ${owed} stay in flight so nothing is paid twice: look the batch up in PayPal (Activity, Payouts). If PayPal never received it, release them on the PayPal payouts screen.`;
  }
}

/** The English (CMS) message of an operator alert. */
export function describeAffiliatePayPalAlert(alert: AffiliatePayPalAlert): string {
  const env = alert.environment === 'live' ? 'live' : 'sandbox';
  const amount = money(alert.amountCents, alert.currency);
  const count = alert.payouts === 1 ? '1 partner payout' : `${alert.payouts} partner payouts`;
  const code = alert.code ? ` (${alert.code})` : '';
  switch (alert.kind) {
    case 'paypal_insufficient_funds':
      return `PayPal could not send ${count}${amount ? ` (${amount})` : ''}: your ${env} PayPal balance is too low. Add ${alert.currency ?? 'the payout currency'} to your PayPal balance; pay in the commission currency from a balance in it to avoid PayPal's conversion fee. Their commissions went back to what is owed, and the next payout run sends them again.`;
    case 'paypal_not_enabled':
      return `PayPal refused the ${env} payouts${code}: Payouts is not enabled for this PayPal account or app. Request access at ${AFFILIATE_PAYPAL_REQUEST_ACCESS_URL}, tick Payouts in your app at developer.paypal.com, then test the connection on the PayPal payouts screen. Nothing was sent; the commissions are still owed.`;
    case 'paypal_credentials':
      return `PayPal rejected the ${env} client ID or secret, so nothing was sent or checked. Save working credentials on the PayPal payouts screen.`;
    case 'paypal_refused':
      return `PayPal refused ${count}${amount ? ` (${amount})` : ''}${code}. Nothing was sent; their commissions went back to what is owed, and the next payout run tries again. Check the PayPal payouts screen.`;
    case 'paypal_unknown_status':
      return `PayPal reported a status this site does not know${code}${alert.batchId ? ` in the ${env} batch ${alert.batchId}` : ''} for ${count}. They stay in flight: check them in PayPal and on the PayPal payouts screen. ${STUCK_RELEASE_HINT}`;
    case 'paypal_currency_unsupported':
      return alert.code === 'NOT_WHOLE_UNITS'
        ? `PayPal sends ${alert.currency ?? 'this currency'} in whole units only, so ${count}${amount ? ` (${amount})` : ''} with a fraction were not sent and stay owed. To pay them, choose Manually for these sales under Program settings (How partners are paid) and pay them under Pay manually.`
        : `PayPal Payouts does not send ${alert.currency ?? 'this currency'}, so ${count}${amount ? ` (${amount})` : ''} were not sent and stay owed: those partners are listed under Pay manually. Choose Manually for these sales under Program settings (How partners are paid).`;
    case 'paypal_batch_unresolved':
    default:
      return describeUnresolvedBatch(alert, env, count, amount, code).replace(/\s+/g, ' ');
  }
}

/**
 * Records an operator alert once per kind (and currency) and UTC day; an unresolved alert of the same
 * day counts. True when one exists afterwards. Never throws.
 */
export async function recordAffiliatePayPalAlert(db: AnyClient, alert: AffiliatePayPalAlert, now: Date = new Date()): Promise<boolean> {
  const alertDate = now.toISOString().slice(0, 10);
  try {
    let lookup = db
      .from('system_alerts')
      .select('id')
      .eq('alert_type', AFFILIATE_ALERT_TYPES.PAYOUT_FAILED)
      .eq('is_resolved', false)
      .eq('metadata->>kind', alert.kind)
      .eq('metadata->>alert_date', alertDate);
    if (alert.currency) lookup = lookup.eq('metadata->>currency', alert.currency);
    const { data: existing, error: lookupError } = await lookup.limit(1);
    if (!lookupError && Array.isArray(existing) && existing.length > 0) return true;

    const metadata: Record<string, unknown> = {
      kind: alert.kind,
      alert_date: alertDate,
      environment: alert.environment,
      payouts: alert.payouts,
      action_url: AFFILIATE_CMS_PAYPAL_PATH,
      action_label: 'Open PayPal payouts',
    };
    if (alert.currency) metadata['currency'] = alert.currency;
    if (alert.code && /^[A-Z][A-Z0-9_]{0,63}$/i.test(alert.code)) metadata['code'] = alert.code;
    if (alert.senderBatchId && /^[A-Za-z0-9_-]{1,64}$/.test(alert.senderBatchId)) metadata['sender_batch_id'] = alert.senderBatchId;
    if (alert.batchId && /^[A-Za-z0-9_-]{1,128}$/.test(alert.batchId)) metadata['batch_id'] = alert.batchId;
    if (alert.cause) metadata['cause'] = alert.cause;
    const { error } = await db.from('system_alerts').insert({
      alert_type: AFFILIATE_ALERT_TYPES.PAYOUT_FAILED,
      title: ALERT_TITLE[alert.kind] ?? 'PayPal payouts need attention',
      message: describeAffiliatePayPalAlert(alert).slice(0, 2000),
      metadata,
    });
    if (error) {
      console.warn('[affiliates] Could not record a PayPal alert', { kind: alert.kind, code: (error as { code?: unknown }).code ?? null });
      return false;
    }
    return true;
  } catch (error) {
    console.warn('[affiliates] Could not record a PayPal alert', { kind: alert.kind, message: error instanceof Error ? error.message : 'unknown' });
    return false;
  }
}
