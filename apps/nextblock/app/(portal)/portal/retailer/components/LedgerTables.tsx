import type { ReactNode } from 'react';
import {
  AFFILIATE_COMMISSION_STATUS_COPY_KEYS,
  AFFILIATE_PAYOUT_STATUS_COPY_KEYS,
  affiliateCommissionNetMinor,
  type AffiliateCommissionRow,
  type AffiliateCommissionStatus,
  type AffiliateManualPayoutChannel,
  type AffiliatePayoutMethod,
  type AffiliatePayoutRow,
  type AffiliatePayoutStatus,
} from '@nextblock-cms/affiliates';
import { cn } from '@nextblock-cms/utils';

import type { PortalCopyKey, PortalTranslate } from './portal-copy';
import {
  formatPortalDate,
  formatPortalMoney,
  formatPortalPercent,
  portalDateTimeAttribute,
  shortPortalOrderRef,
} from './portal-format';
import type { PortalLocale } from './portal-types';

/**
 * The portal's commission and payout tables (server-rendered). Real tables with a caption and
 * column headers; the scroll container is focusable so a keyboard can scroll it on small screens.
 */

/** Where a payout recorded by hand was sent from (`affiliate_payouts.manual_channel`, 02036). */
const MANUAL_CHANNEL_COPY_KEYS: Readonly<Record<AffiliateManualPayoutChannel, PortalCopyKey>> = {
  paypal: 'affiliates.portal.payout_channel_paypal',
  interac: 'affiliates.portal.payout_channel_interac',
  wise: 'affiliates.portal.payout_channel_wise',
  bank_transfer: 'affiliates.portal.payout_channel_bank_transfer',
  other: 'affiliates.portal.payout_channel_other',
};

/** The commissions table's payout column, while the partner's commissions go more than one way. */
const COMMISSION_PAYOUT_COPY_KEYS: Readonly<Record<AffiliatePayoutMethod, PortalCopyKey>> = {
  stripe_connect: 'affiliates.portal.commission_payout_stripe',
  // 02037: paid (or to be paid) by PayPal Payouts into the partner's PayPal account.
  paypal: 'affiliates.portal.commission_payout_paypal',
  manual: 'affiliates.portal.commission_payout_direct',
};

/** Where a PayPal payout stands for the partner (02037). */
type PayPalPayoutState = 'sent' | 'unclaimed' | 'paid' | 'returned' | 'not_sent';

const PAYPAL_STATE_COPY_KEYS: Readonly<Record<PayPalPayoutState, PortalCopyKey>> = {
  sent: 'affiliates.portal.payout_paypal_status_sent',
  unclaimed: 'affiliates.portal.payout_paypal_status_unclaimed',
  paid: 'affiliates.portal.payout_paypal_status_paid',
  returned: 'affiliates.portal.payout_paypal_status_returned',
  not_sent: 'affiliates.portal.payout_paypal_status_not_sent',
};

/** PayPal item statuses after which the money came back from PayPal (as opposed to never leaving). */
const PAYPAL_RETURNED_STATUSES: ReadonlySet<string> = new Set(['RETURNED', 'REFUNDED', 'REVERSED']);

/**
 * A PayPal payout's state: paid once PayPal paid the item (COMPLETED); while PayPal has it
 * (PROCESSING), waiting for the partner to claim it (UNCLAIMED) or sent; given up (FAILED, its
 * commissions handed back), returned when the money came back from PayPal (returned after 30 days
 * unclaimed, cancelled before it was claimed, refunded, reversed), otherwise not sent.
 */
function payPalPayoutStateOf(row: AffiliatePayoutRow): PayPalPayoutState {
  if (row.status === 'COMPLETED') return 'paid';
  const itemStatus = (row.paypal_item_status ?? '').toUpperCase();
  if (row.status === 'PROCESSING') return itemStatus === 'UNCLAIMED' ? 'unclaimed' : 'sent';
  const reason = (row.failure_reason ?? '').toLowerCase();
  return PAYPAL_RETURNED_STATUSES.has(itemStatus) || /^paypal_(?:returned|refunded|reversed|cancel+ed)\b/.test(reason)
    ? 'returned'
    : 'not_sent';
}

const COMMISSION_STATUS_CLASSES: Readonly<Record<AffiliateCommissionStatus, string>> = {
  PENDING_CLEARANCE: 'border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-50',
  CLEARED: 'border-sky-300 bg-sky-50 text-sky-950 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-50',
  PAID: 'border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-50',
  VOIDED_REFUND: 'border-border bg-muted text-foreground',
};

const PAYOUT_STATUS_CLASSES: Readonly<Record<AffiliatePayoutStatus, string>> = {
  PROCESSING: 'border-sky-300 bg-sky-50 text-sky-950 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-50',
  COMPLETED: 'border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-50',
  FAILED: 'border-red-300 bg-red-50 text-red-950 dark:border-red-800 dark:bg-red-950/40 dark:text-red-50',
};

const CELL = 'px-3 py-2 align-top';
const HEAD_CELL = 'px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground';

function StatusPill({ className, label }: { className: string; label: string }) {
  return (
    <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium', className)}>{label}</span>
  );
}

function DateCell({ value, locale }: { value: string | null | undefined; locale: PortalLocale }) {
  const label = formatPortalDate(value, locale);
  if (!label) return <span aria-hidden="true">—</span>;
  return <time dateTime={portalDateTimeAttribute(value)}>{label}</time>;
}

function TableFrame({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div
      role="region"
      aria-label={caption}
      tabIndex={0}
      className="overflow-x-auto rounded-lg border border-border bg-card focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <table className="w-full min-w-[36rem] border-collapse text-sm text-card-foreground">
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}

export function CommissionsTable({
  rows,
  t,
  locale,
  caption,
  compact = false,
  payoutMethods = null,
}: {
  rows: readonly AffiliateCommissionRow[];
  t: PortalTranslate;
  locale: PortalLocale;
  caption: string;
  /** The overview's short list: no order and rate columns. */
  compact?: boolean;
  /**
   * How each commission is (or was) paid, by commission id: given while some commissions go
   * through Stripe and others are sent by hand (02036), it adds a Payout column. A row without an
   * entry (voided, or its payout unread) shows a dash.
   */
  payoutMethods?: Readonly<Record<string, AffiliatePayoutMethod>> | null;
}) {
  return (
    <TableFrame caption={caption}>
      <thead className="border-b border-border">
        <tr>
          <th scope="col" className={HEAD_CELL}>
            {t('affiliates.portal.table_date')}
          </th>
          {compact ? null : (
            <th scope="col" className={HEAD_CELL}>
              {t('affiliates.portal.table_order')}
            </th>
          )}
          <th scope="col" className={HEAD_CELL}>
            {t('affiliates.portal.table_amount')}
          </th>
          {compact ? null : (
            <th scope="col" className={HEAD_CELL}>
              {t('affiliates.portal.table_rate')}
            </th>
          )}
          <th scope="col" className={HEAD_CELL}>
            {t('affiliates.portal.table_status')}
          </th>
          {payoutMethods ? (
            <th scope="col" className={HEAD_CELL}>
              {t('affiliates.portal.table_payout')}
            </th>
          ) : null}
          <th scope="col" className={HEAD_CELL}>
            {t('affiliates.portal.table_clears_on')}
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.map((row) => {
          const net = affiliateCommissionNetMinor(row);
          const voided = row.status === 'VOIDED_REFUND';
          const orderRef = shortPortalOrderRef(row.order_id);
          const payoutMethod: AffiliatePayoutMethod | null = payoutMethods?.[row.id] ?? null;
          return (
            <tr key={row.id}>
              <td className={CELL}>
                <DateCell value={row.created_at} locale={locale} />
              </td>
              {compact ? null : (
                <td className={cn(CELL, 'font-mono')} translate="no">
                  {orderRef ?? <span aria-hidden="true">—</span>}
                </td>
              )}
              <td className={cn(CELL, 'tabular-nums')}>
                <span className={voided ? 'line-through' : undefined}>
                  {formatPortalMoney(voided ? row.commission_amount_cents : net, row.currency, locale)}
                </span>
                {!voided && row.refunded_amount_cents > 0 ? (
                  <span className="block text-xs text-muted-foreground">
                    {t('affiliates.portal.commission_refunded', {
                      amount: formatPortalMoney(row.refunded_amount_cents, row.currency, locale),
                    })}
                  </span>
                ) : null}
              </td>
              {compact ? null : <td className={cn(CELL, 'tabular-nums')}>{formatPortalPercent(row.commission_rate_snapshot, locale)}</td>}
              <td className={CELL}>
                <StatusPill
                  className={COMMISSION_STATUS_CLASSES[row.status]}
                  label={t(AFFILIATE_COMMISSION_STATUS_COPY_KEYS[row.status])}
                />
              </td>
              {payoutMethods ? (
                <td className={CELL}>
                  {payoutMethod ? t(COMMISSION_PAYOUT_COPY_KEYS[payoutMethod]) : <span aria-hidden="true">—</span>}
                </td>
              ) : null}
              <td className={CELL}>{voided ? <span aria-hidden="true">—</span> : <DateCell value={row.clears_at} locale={locale} />}</td>
            </tr>
          );
        })}
      </tbody>
    </TableFrame>
  );
}

/**
 * A payout the operator sent outside Stripe and recorded in the CMS (02036): "PayPal · Ref. 5TY…",
 * then the note the admin wrote for the partner (plain text; React escapes it).
 */
function ManualPayoutDetails({ row, t }: { row: AffiliatePayoutRow; t: PortalTranslate }) {
  const channel = t(MANUAL_CHANNEL_COPY_KEYS[row.manual_channel ?? 'other']);
  const reference = row.external_reference?.trim() || null;
  const note = row.note?.trim() || null;
  return (
    <>
      <span className="text-xs" translate="no">
        {reference ? t('affiliates.portal.payout_manual_reference', { channel, reference }) : channel}
      </span>
      {note ? <span className="mt-1 block whitespace-pre-line text-xs">{t('affiliates.portal.payout_manual_note', { note })}</span> : null}
    </>
  );
}

/**
 * A payout PayPal sent from the store's PayPal balance (02037): "PayPal · {status}", then PayPal's
 * transaction id once paid, where to claim it while PayPal waits for the partner (the address PayPal
 * emailed, the payout's own `paypal_receiver`), or that the amount went back to the balance after a
 * payout PayPal did not pay. The store's PayPal fee is never shown: the partner receives the full amount.
 */
function PayPalPayoutDetails({ row, t }: { row: AffiliatePayoutRow; t: PortalTranslate }) {
  const state = payPalPayoutStateOf(row);
  const transaction = row.paypal_transaction_id?.trim() || null;
  return (
    <>
      <span className="text-xs">{t('affiliates.portal.payout_paypal_status', { status: t(PAYPAL_STATE_COPY_KEYS[state]) })}</span>
      {state === 'paid' && transaction ? (
        <span className="mt-1 block font-mono text-xs" translate="no">
          {t('affiliates.portal.payout_paypal_transaction', { reference: transaction })}
        </span>
      ) : null}
      {state === 'unclaimed' ? (
        <span className="mt-1 block text-xs">{t('affiliates.portal.payout_paypal_claim_hint', { email: row.paypal_receiver ?? '' })}</span>
      ) : null}
      {state === 'returned' || state === 'not_sent' ? (
        <span className="mt-1 block text-xs">{t('affiliates.portal.payout_paypal_back_in_balance')}</span>
      ) : null}
    </>
  );
}

export function PayoutsTable({
  rows,
  autoRetryPayoutIds,
  t,
  locale,
  caption,
}: {
  rows: readonly AffiliatePayoutRow[];
  /** The failed payouts the daily cycle retries by itself; any other failed one waits for an admin. */
  autoRetryPayoutIds: ReadonlySet<string>;
  t: PortalTranslate;
  locale: PortalLocale;
  caption: string;
}) {
  return (
    <TableFrame caption={caption}>
      <thead className="border-b border-border">
        <tr>
          <th scope="col" className={HEAD_CELL}>
            {t('affiliates.portal.table_date')}
          </th>
          <th scope="col" className={HEAD_CELL}>
            {t('affiliates.portal.table_amount')}
          </th>
          <th scope="col" className={HEAD_CELL}>
            {t('affiliates.portal.table_status')}
          </th>
          <th scope="col" className={HEAD_CELL}>
            {t('affiliates.portal.table_sent_on')}
          </th>
          <th scope="col" className={HEAD_CELL}>
            {t('affiliates.portal.table_details')}
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.map((row) => (
          <tr key={row.id}>
            <td className={CELL}>
              <DateCell value={row.created_at} locale={locale} />
            </td>
            <td className={cn(CELL, 'tabular-nums')}>{formatPortalMoney(row.amount_cents, row.currency, locale)}</td>
            <td className={CELL}>
              <StatusPill className={PAYOUT_STATUS_CLASSES[row.status]} label={t(AFFILIATE_PAYOUT_STATUS_COPY_KEYS[row.status])} />
            </td>
            <td className={CELL}>
              <DateCell value={row.paid_at} locale={locale} />
            </td>
            <td className={cn(CELL, 'text-muted-foreground')}>
              {row.method === 'paypal' ? (
                // 02037: never the Stripe notes ("Being sent to your bank", "The transfer failed").
                <PayPalPayoutDetails row={row} t={t} />
              ) : row.method === 'manual' ? (
                // Prepared by the store (02036), not recorded as sent yet: no channel or reference yet.
                row.status === 'PROCESSING' ? (
                  t('affiliates.portal.payout_manual_sending_note')
                ) : (
                  <ManualPayoutDetails row={row} t={t} />
                )
              ) : row.status === 'COMPLETED' && row.stripe_transfer_id ? (
                <span className="font-mono text-xs" translate="no">
                  {t('affiliates.portal.payout_reference', { reference: row.stripe_transfer_id })}
                </span>
              ) : row.status === 'FAILED' ? (
                t(autoRetryPayoutIds.has(row.id) ? 'affiliates.portal.payout_failed_note' : 'affiliates.portal.payout_failed_review_note')
              ) : row.status === 'PROCESSING' ? (
                t('affiliates.portal.payout_processing_note')
              ) : (
                <span aria-hidden="true">—</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </TableFrame>
  );
}
