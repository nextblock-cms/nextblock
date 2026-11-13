import 'server-only';

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AlertTriangle, Info } from 'lucide-react';
import {
  AFFILIATE_CMS_PATH,
  AFFILIATE_CMS_PAYOUTS_PATH,
  AFFILIATE_CMS_PAYPAL_PATH,
  AFFILIATE_CMS_STRIPE_PATH,
  AFFILIATE_COMMISSION_STATUSES,
  AFFILIATE_PAYOUT_STATUSES,
  affiliateGatewaysPaidByPayPal,
  affiliateGatewaysPaidByStripe,
  affiliateGatewaysPaidManually,
  affiliateGatewaysPaidOutsideStripe,
  type AffiliateCommissionRow,
  type AffiliateGateway,
  type AffiliatePayoutRow,
  type AffiliatesSettings,
} from '@nextblock-cms/affiliates';
import { Button } from '@nextblock-cms/ui';
import { cn } from '@nextblock-cms/utils';
import { requireCmsAdmin } from '../../../../lib/auth/cms-actor';
import {
  getAffiliateStoreBaseCurrency,
  loadAffiliatePayoutsAdmin,
  normalizeAffiliatePayoutPlatformInfo,
  parseAffiliateAdminPage,
  parseAffiliateAdminPageSize,
  parseAffiliatePayoutsFilters,
  toAffiliateAdminClient,
  type AffiliateLedgerPartner,
  type AffiliatePayoutPlatformSummary,
  type AffiliatePayoutsAdminData,
  type AffiliatePayoutsFilters,
} from '../../../../lib/affiliates/admin-data';
import {
  loadAffiliateManualPayoutQueue,
  loadAffiliatePreparedManualPayouts,
  type AffiliateManualPayoutCommission,
  type AffiliateManualPayoutQueue,
  type AffiliatePreparedManualPayout,
  type AffiliatePreparedManualPayouts,
} from '../../../../lib/affiliates/manual-payouts';
import { AFFILIATE_PAYPAL_PAYOUTS_MAX_ROWS } from '../../../../lib/affiliates/paypal-payouts-csv';
import { describeAffiliatePayPalFailure } from '../../../../lib/affiliates/paypal/events';
import { getAffiliatePayoutPlatformInfo } from '../../../../lib/affiliates/payout-runner';
import TablePagination from '../../components/TablePagination';
import { AffiliateLoadErrorCard, AffiliatePageHeading } from '../components/AdminCards';
import { AffiliatesSubnav } from '../components/AffiliatesSubnav';
import {
  formatAdminClearsIn,
  formatAdminDate,
  formatAdminDateTime,
  formatAdminMoney,
  formatAdminRate,
  shortAdminId,
} from '../components/format';
import {
  AFFILIATE_COMMISSION_STATUS_LABEL,
  AFFILIATE_MANUAL_PAYOUT_CHANNEL_LABEL,
  AFFILIATE_PAYOUT_FAILURE_LABEL,
  AFFILIATE_PAYOUT_STATUS_LABEL,
  AFFILIATE_PAYOUT_TRIGGER_LABEL,
} from '../components/labels';
import {
  ManualPayoutCancelButton,
  ManualPayoutPrepareButton,
  ManualPayoutRecordButton,
  ManualPayPalPrepareButton,
} from '../components/ManualPayoutActions';
import {
  PayoutRowActions,
  RunPayoutsNowButton,
  type RunPayoutsDisabledReason,
  type RunPayoutsRouting,
} from '../components/PayoutActions';
import { AffiliateCommissionStatusBadge, AffiliatePartnerStatusBadge, AffiliatePayoutStatusBadge } from '../components/StatusBadges';
import { isAffiliatesProgramActive } from '../../../../lib/affiliates/package-state';

export const metadata = {
  title: 'Affiliate Payouts | NextBlock™ CMS',
};

const SELECT_CLASS =
  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

/** FAILED payouts whose commissions were already given back: nothing to retry or release. */
const CLOSED_FAILURE_REASONS = new Set(['released', 'nothing_to_pay', 'below_minimum']);

/** Where the Stripe keys are entered. */
const PAYMENTS_PATH = '/cms/payments';

function partnerLabel(partners: Record<string, AffiliateLedgerPartner>, affiliateId: string): string {
  const partner = partners[affiliateId];
  return partner?.handle ? `@${partner.handle}` : 'Unknown partner';
}

const GATEWAY_LABEL: Readonly<Record<AffiliateGateway, string>> = { STRIPE: 'Stripe', FREEMIUS: 'Freemius' };

/** "Freemius sales", "Stripe sales", or "Stripe and Freemius sales". */
function gatewaySalesText(gateways: readonly AffiliateGateway[]): string {
  if (gateways.length === 1 && gateways[0]) return `${GATEWAY_LABEL[gateways[0]]} sales`;
  return 'Stripe and Freemius sales';
}

/**
 * How the program pays its partners (02036): through Stripe, outside it, or both. Outside Stripe is
 * by hand or, since 02037, with PayPal Payouts (`hasPayPal`).
 */
function routingOf(settings: AffiliatesSettings | null | undefined): RunPayoutsRouting {
  if (!settings || affiliateGatewaysPaidOutsideStripe(settings).length === 0) return 'stripe';
  return affiliateGatewaysPaidByStripe(settings).length === 0 ? 'manual' : 'mixed';
}

function hasPayPal(settings: AffiliatesSettings | null | undefined): boolean {
  return settings ? affiliateGatewaysPaidByPayPal(settings).length > 0 : false;
}

/** The "How partners are paid" fact of the platform card. */
function payoutMethodsText(settings: AffiliatesSettings | null | undefined): string {
  if (!settings) return 'Unknown';
  const stripe = affiliateGatewaysPaidByStripe(settings);
  const paypal = affiliateGatewaysPaidByPayPal(settings);
  const manual = affiliateGatewaysPaidManually(settings);
  if (paypal.length === 0 && manual.length === 0) return 'Stripe Connect';
  if (stripe.length === 0 && paypal.length === 0) return 'Manually (every sale)';
  if (stripe.length === 0 && manual.length === 0) return 'PayPal (every sale)';
  const parts: string[] = [];
  if (stripe.length > 0) parts.push(`${gatewaySalesText(stripe)}: Stripe Connect`);
  if (paypal.length > 0) parts.push(`${gatewaySalesText(paypal)}: PayPal`);
  if (manual.length > 0) parts.push(`${gatewaySalesText(manual)}: manually`);
  return parts.join(' · ');
}

const PAGE_DESCRIPTION: Readonly<Record<RunPayoutsRouting, string>> = {
  stripe:
    "Commissions wait out their tier's refund-protection hold, then clear; the daily run transfers each partner's cleared balance through Stripe Connect.",
  mixed:
    "Commissions wait out their tier's refund-protection hold, then clear; the daily run transfers the ones paid through Stripe Connect, and you pay the others manually under Pay manually.",
  manual:
    "Commissions wait out their tier's refund-protection hold, then clear with the daily run; you pay them manually (PayPal, Interac e-Transfer, bank transfer): prepare, send and record each payout under Pay manually.",
};

/** The same with some gateway paid with PayPal Payouts (02037). */
const PAGE_DESCRIPTION_WITH_PAYPAL: Readonly<Record<RunPayoutsRouting, string>> = {
  stripe: PAGE_DESCRIPTION.stripe,
  mixed:
    "Commissions wait out their tier's refund-protection hold, then clear; the daily run transfers the ones paid through Stripe Connect and sends the ones paid with PayPal from your PayPal balance. Partners PayPal cannot pay appear under Pay manually.",
  manual:
    "Commissions wait out their tier's refund-protection hold, then clear; the daily run sends the ones paid with PayPal from your PayPal balance. Commissions paid manually, and those of partners PayPal cannot pay, appear under Pay manually.",
};

function viewHref(view: AffiliatePayoutsFilters['view']): string {
  return view === 'payouts' ? `${AFFILIATE_CMS_PAYOUTS_PATH}?view=payouts` : AFFILIATE_CMS_PAYOUTS_PATH;
}

function PlatformCard({
  platform,
  data,
}: {
  platform: AffiliatePayoutPlatformSummary;
  data: AffiliatePayoutsAdminData | null;
}) {
  const settings = data?.settings;
  return (
    <section aria-labelledby="affiliate-platform-heading" className="space-y-4 rounded-lg border border-border bg-card p-5 text-card-foreground shadow-sm">
      <h3 id="affiliate-platform-heading" className="text-base font-semibold text-foreground">
        Stripe platform
      </h3>
      {platform.sandbox ? (
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          This is the public sandbox: Stripe Connect and transfers are switched off. The ledger shows seeded demo data.
        </p>
      ) : null}
      {platform.currencyMismatch && platform.platformCurrency ? (
        <div role="alert" className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            Your Stripe account settles in {platform.platformCurrency}, but commissions are recorded and paid in the store
            currency, {platform.baseCurrency}. Transfers in {platform.baseCurrency} need a {platform.baseCurrency} balance:
            either add {platform.baseCurrency} to your Stripe account or make {platform.platformCurrency} the store&rsquo;s
            default currency.
          </span>
        </div>
      ) : null}
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-xs text-muted-foreground">Stripe</dt>
          <dd className="font-medium text-foreground">{describeStripeState(platform)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Platform and currencies</dt>
          <dd className="font-medium text-foreground">
            {platform.platformCountry ? `${platform.platformCountry} · ` : ''}Store {platform.baseCurrency}
            {platform.platformCurrency ? ` · Stripe ${platform.platformCurrency}` : ''}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Transferable balance (card payments)</dt>
          <dd className="font-medium text-foreground">
            {platform.balanceKnown
              ? platform.transferableBalances.length > 0
                ? platform.transferableBalances.map((entry) => formatAdminMoney(entry.amountCents, entry.currency)).join(' · ')
                : formatAdminMoney(0, platform.baseCurrency)
              : 'Unknown'}
            {platform.balanceKnown && platform.pendingBalances.some((entry) => entry.amountCents > 0) ? (
              <span className="block text-xs font-normal text-muted-foreground">
                {platform.pendingBalances
                  .filter((entry) => entry.amountCents > 0)
                  .map((entry) => formatAdminMoney(entry.amountCents, entry.currency))
                  .join(' · ')}{' '}
                pending
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Automatic Stripe transfers</dt>
          <dd className="font-medium text-foreground">
            {settings
              ? `${settings.autoPayoutsEnabled ? 'On' : 'Off'} · minimum ${formatAdminMoney(settings.minPayoutCents, platform.baseCurrency)}`
              : 'Unknown'}
          </dd>
        </div>
        <div className="sm:col-span-2 lg:col-span-4">
          <dt className="text-xs text-muted-foreground">How partners are paid</dt>
          <dd className="font-medium text-foreground">{payoutMethodsText(settings)}</dd>
        </div>
      </dl>
      <p className="text-xs text-muted-foreground">
        Change the minimum payout, the daily switch and how partners are paid under{' '}
        <Link href={AFFILIATE_CMS_PATH} className="font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring">
          Overview → Program settings
        </Link>
        . Test the Stripe connection and compare your balance with what you owe on{' '}
        <Link href={AFFILIATE_CMS_STRIPE_PATH} className="font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring">
          Stripe payouts
        </Link>
        .
      </p>
    </section>
  );
}

/** The "Stripe" fact: configured or not, the key mode, and a key Stripe rejected or a restricted key short of a permission. */
function describeStripeState(platform: AffiliatePayoutPlatformSummary): string {
  if (platform.sandbox) return 'Off on the sandbox';
  if (platform.stripeConfigured === false) return 'Not configured';
  if (platform.error === 'stripe_authentication') return 'Key rejected by Stripe';
  if (platform.stripeConfigured === null) return platform.error ? 'Could not be reached' : 'Unknown';
  const mode = platform.livemode === null ? null : platform.livemode ? 'live mode' : 'test mode';
  if (platform.error === 'stripe_permission') return `Configured${mode ? ` (${mode})` : ''}, missing a permission`;
  if (!mode) return platform.error ? 'Configured, Stripe could not be reached' : 'Configured';
  return `Configured (${mode})`;
}

/**
 * Why "Run payouts now" is off, with the screen that fixes it. While some commissions are paid by
 * hand (02036) the run still clears them without Stripe, so only the sandbox turns it off.
 */
function runDisabledReasonOf(platform: AffiliatePayoutPlatformSummary, routing: RunPayoutsRouting): RunPayoutsDisabledReason | null {
  if (platform.sandbox) return { text: 'Payouts are disabled in the sandbox.' };
  if (routing !== 'stripe') return null;
  if (platform.stripeConfigured === false) {
    return { text: 'Add your Stripe secret key first.', href: PAYMENTS_PATH, linkLabel: 'Open Payments' };
  }
  if (platform.error === 'stripe_authentication') {
    return { text: 'Stripe rejected the secret key.', href: AFFILIATE_CMS_STRIPE_PATH, linkLabel: 'Check Stripe payouts' };
  }
  return null;
}

function CommissionTimingCell({ row, now }: { row: AffiliateCommissionRow; now: number }) {
  switch (row.status) {
    case 'PENDING_CLEARANCE':
      return (
        <time dateTime={row.clears_at} title={formatAdminDateTime(row.clears_at)}>
          {formatAdminClearsIn(row.clears_at, now)}
        </time>
      );
    case 'CLEARED':
      return (
        <span>
          Cleared {formatAdminDate(row.cleared_at ?? row.clears_at)}
          {row.payout_id ? <span className="block text-xs text-muted-foreground">In payout {shortAdminId(row.payout_id)}</span> : null}
        </span>
      );
    case 'PAID':
      return <span>Paid {formatAdminDate(row.paid_at)}</span>;
    case 'VOIDED_REFUND':
    default:
      return (
        <span>
          Voided {formatAdminDate(row.voided_at)}
          {row.void_reason ? <span className="block text-xs text-muted-foreground">{row.void_reason.replace(/_/g, ' ')}</span> : null}
        </span>
      );
  }
}

function CommissionsTable({
  rows,
  partners,
  total,
  filters,
}: {
  rows: AffiliateCommissionRow[];
  partners: Record<string, AffiliateLedgerPartner>;
  total: number;
  filters: AffiliatePayoutsFilters;
}) {
  const now = Date.now();
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[64rem] text-left text-sm">
          <caption className="sr-only">Commissions ledger, newest first</caption>
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">Recorded</th>
              <th scope="col" className="px-4 py-3 font-medium">Partner</th>
              <th scope="col" className="px-4 py-3 font-medium">Order</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Order net</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Commission</th>
              <th scope="col" className="px-4 py-3 font-medium">Status</th>
              <th scope="col" className="px-4 py-3 font-medium">Timing</th>
              <th scope="col" className="px-4 py-3 font-medium">Transfer</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-muted-foreground">
                  {filters.commissionStatus
                    ? `No ${AFFILIATE_COMMISSION_STATUS_LABEL[filters.commissionStatus].toLowerCase()} commissions.`
                    : 'No commissions yet. A commission is recorded when a referred order is paid.'}
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const net = Math.max(0, row.commission_amount_cents - row.refunded_amount_cents);
                return (
                  <tr key={row.id} className="align-top">
                    <td className="px-4 py-3 text-muted-foreground">
                      <time dateTime={row.created_at} title={formatAdminDateTime(row.created_at)}>
                        {formatAdminDate(row.created_at)}
                      </time>
                    </td>
                    <td className="px-4 py-3 font-medium text-foreground">{partnerLabel(partners, row.affiliate_id)}</td>
                    <td className="px-4 py-3">
                      {row.order_id ? (
                        <Link
                          href={`/cms/orders/${row.order_id}`}
                          title={row.order_id}
                          className="font-mono text-xs text-primary underline-offset-4 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {shortAdminId(row.order_id)}
                        </Link>
                      ) : (
                        <span className="text-xs text-muted-foreground">Order deleted</span>
                      )}
                      <span className="block text-xs text-muted-foreground">{row.gateway === 'FREEMIUS' ? 'Freemius' : 'Stripe'}</span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatAdminMoney(row.order_net_amount_minor, row.order_currency)}
                      {row.order_currency !== row.currency ? (
                        <span className="block text-xs text-muted-foreground">
                          {formatAdminMoney(row.net_order_amount_cents, row.currency)}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      <span className="font-medium text-foreground">{formatAdminMoney(net, row.currency)}</span>
                      <span className="block text-xs text-muted-foreground">{formatAdminRate(row.commission_rate_snapshot)}</span>
                      {row.refunded_amount_cents > 0 ? (
                        <span className="block text-xs text-muted-foreground">
                          {formatAdminMoney(row.refunded_amount_cents, row.currency)} refunded
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <AffiliateCommissionStatusBadge status={row.status} />
                      {row.void_requested_at || row.refund_pending_cents > row.refunded_amount_cents ? (
                        <span className="mt-1 block max-w-[14rem] text-xs text-amber-800 dark:text-amber-300">
                          Refunded after it was paid or queued: reverse the Stripe transfer, or recover a manual payout from the
                          partner, if needed.
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <CommissionTimingCell row={row} now={now} />
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground" title={row.stripe_transfer_id ?? undefined}>
                      {row.stripe_transfer_id ? shortAdminId(row.stripe_transfer_id) : '—'}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <TablePagination
        currentPage={filters.page}
        pageSize={filters.pageSize}
        totalCount={total}
        basePath={AFFILIATE_CMS_PAYOUTS_PATH}
        itemLabel="commissions"
      />
    </div>
  );
}

/** A Stripe payout still PROCESSING after this long is reconciled (the runner's stale window, B1). */
const STALE_PROCESSING_MS = 15 * 60 * 1000;

function PayoutsTable({
  rows,
  partners,
  total,
  filters,
  routing,
}: {
  rows: AffiliatePayoutRow[];
  partners: Record<string, AffiliateLedgerPartner>;
  total: number;
  filters: AffiliatePayoutsFilters;
  routing: RunPayoutsRouting;
}) {
  const now = Date.now();
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[64rem] text-left text-sm">
          <caption className="sr-only">Payouts, newest first</caption>
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">Created</th>
              <th scope="col" className="px-4 py-3 font-medium">Partner</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Amount</th>
              <th scope="col" className="px-4 py-3 font-medium">Status</th>
              <th scope="col" className="px-4 py-3 font-medium">Attempts</th>
              <th scope="col" className="px-4 py-3 font-medium">Details</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                  {filters.payoutStatus
                    ? `No ${AFFILIATE_PAYOUT_STATUS_LABEL[filters.payoutStatus].toLowerCase()} payouts.`
                    : 'No payouts yet. The daily run pays every partner whose cleared balance reaches the minimum.'}
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const partner = partnerLabel(partners, row.affiliate_id);
                const amount = formatAdminMoney(row.amount_cents, row.currency);
                const reason = row.failure_reason ?? '';
                // A PayPal payout (02037) settles with PayPal: sent by the daily run, completed or
                // failed by PayPal's answer (a failure hands its commissions back at once).
                const paypal = row.method === 'paypal';
                const closed = row.status === 'FAILED' && (paypal || CLOSED_FAILURE_REASONS.has(reason));
                // A manual payout (02036): prepared (PROCESSING) before the money is sent outside
                // Stripe, then recorded (COMPLETED); never retried or released through Stripe.
                const manual = row.method === 'manual';
                const lastAttempt = Date.parse(row.last_attempt_at);
                // With every commission paid by hand no daily run reconciles a Stripe transfer, so a
                // stale one gets the admin's Retry or Release here.
                const staleWithoutRun =
                  !manual &&
                  !paypal &&
                  row.status === 'PROCESSING' &&
                  routing === 'manual' &&
                  (!Number.isFinite(lastAttempt) || now - lastAttempt >= STALE_PROCESSING_MS);
                return (
                  <tr key={row.id} className="align-top">
                    <td className="px-4 py-3 text-muted-foreground">
                      <time dateTime={row.created_at} title={formatAdminDateTime(row.created_at)}>
                        {formatAdminDate(row.created_at)}
                      </time>
                      <span className="block text-xs">
                        {manual
                          ? row.status === 'PROCESSING'
                            ? 'Prepared manually'
                            : 'Recorded manually'
                          : paypal
                            ? `PayPal · ${AFFILIATE_PAYOUT_TRIGGER_LABEL[row.trigger]}`
                            : AFFILIATE_PAYOUT_TRIGGER_LABEL[row.trigger]}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-medium text-foreground">{partner}</td>
                    <td className="px-4 py-3 text-right font-medium tabular-nums">{amount}</td>
                    <td className="px-4 py-3">
                      <AffiliatePayoutStatusBadge status={row.status} />
                    </td>
                    <td className="px-4 py-3 tabular-nums">
                      {row.attempt_count}
                      <span className="block text-xs text-muted-foreground">Last {formatAdminDateTime(row.last_attempt_at)}</span>
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {row.status === 'COMPLETED' ? (
                        <>
                          <span className="block text-foreground">Paid {formatAdminDateTime(row.paid_at)}</span>
                          {row.stripe_transfer_id ? (
                            <span className="block font-mono text-muted-foreground" title={row.stripe_transfer_id}>
                              {row.stripe_transfer_id}
                            </span>
                          ) : null}
                        </>
                      ) : null}
                      {row.status === 'FAILED' ? (
                        <span className={cn('block', closed ? 'text-muted-foreground' : 'text-red-800 dark:text-red-300')}>
                          {paypal
                            ? `${describeAffiliatePayPalFailure(reason)} Its commissions went back to what is owed.`
                            : AFFILIATE_PAYOUT_FAILURE_LABEL[reason] ?? `Stripe refused the transfer (${reason || 'unknown'}).`}
                        </span>
                      ) : null}
                      {row.status === 'PROCESSING' ? (
                        <span className="block text-muted-foreground">
                          {manual ? (
                            'Prepared, not recorded yet: send it, then record it (or cancel it if it was never sent) under Pay manually.'
                          ) : paypal ? (
                            <>
                              Sent with PayPal, not settled yet: each payout run asks PayPal about it (or use Check PayPal status now on{' '}
                              <Link href={AFFILIATE_CMS_PAYPAL_PATH} className={LINK_CLASS}>
                                PayPal payouts
                              </Link>
                              ).
                            </>
                          ) : routing === 'manual' ? (
                            'Transfer in flight. No commission is paid through Stripe now, so no daily run checks it against Stripe: once it is 15 minutes old, use Retry or Release.'
                          ) : (
                            'Transfer in flight. A payout still processing after 15 minutes is checked against Stripe by the next run.'
                          )}
                        </span>
                      ) : null}
                      {paypal ? (
                        <>
                          <span className="mt-1 block text-muted-foreground">
                            {[
                              'PayPal',
                              row.paypal_item_status ?? (row.status === 'PROCESSING' ? (row.paypal_batch_id ? 'PENDING' : 'NOT CONFIRMED') : null),
                              row.paypal_transaction_id ? `Transaction ${row.paypal_transaction_id}` : null,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                          {typeof row.paypal_fee_cents === 'number' && row.paypal_fee_cents > 0 ? (
                            <span className="block text-muted-foreground">PayPal fee {formatAdminMoney(row.paypal_fee_cents, row.currency)}</span>
                          ) : null}
                          {row.paypal_receiver ? <span className="block break-all text-muted-foreground">To {row.paypal_receiver}</span> : null}
                        </>
                      ) : manual ? (
                        row.status === 'COMPLETED' ? (
                          <>
                            <span className="mt-1 block text-muted-foreground">
                              {AFFILIATE_MANUAL_PAYOUT_CHANNEL_LABEL[row.manual_channel ?? 'other']}
                              {row.external_reference ? ` · Ref. ${row.external_reference}` : ''}
                            </span>
                            {row.note ? (
                              <span className="block max-w-[18rem] break-words text-muted-foreground">Note to the partner: {row.note}</span>
                            ) : null}
                          </>
                        ) : null
                      ) : (
                        <span className="mt-1 block font-mono text-muted-foreground" title={row.stripe_destination_account}>
                          To {row.stripe_destination_account}
                        </span>
                      )}
                      {row.livemode ? null : (
                        <span className="block text-muted-foreground">
                          {paypal ? 'Test mode (PayPal sandbox, test money)' : 'Test mode (made with a Stripe test key)'}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {!manual && !paypal && ((row.status === 'FAILED' && !closed) || staleWithoutRun) ? (
                        <PayoutRowActions payoutId={row.id} partnerLabel={partner} amountLabel={amount} />
                      ) : null}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <TablePagination
        currentPage={filters.page}
        pageSize={filters.pageSize}
        totalCount={total}
        basePath={AFFILIATE_CMS_PAYOUTS_PATH}
        itemLabel="payouts"
      />
    </div>
  );
}

const LINK_CLASS =
  'font-medium text-primary underline underline-offset-4 hover:no-underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring';

const SANDBOX_DISABLED = 'Payouts are disabled in the sandbox.';

/** "Oct 20, 2026 · Order 1a2b3c4d · Freemius · $12.00", plus what changed since a payout was prepared. */
function commissionLine(commission: AffiliateManualPayoutCommission, currency: string): string {
  const parts = [
    formatAdminDate(commission.createdAt),
    commission.orderId ? `Order ${shortAdminId(commission.orderId)}` : 'Order deleted',
    GATEWAY_LABEL[commission.gateway],
    formatAdminMoney(commission.amountCents, currency),
  ];
  if (commission.flag === 'refunded') parts.push('refunded since it was prepared');
  if (commission.flag === 'disputed') parts.push('disputed since it was prepared');
  return parts.join(' · ');
}

/** The warning of a prepared payout a refund or a dispute reached since it was prepared, or null. */
function changedSincePreparedText(row: AffiliatePreparedManualPayout): string | null {
  const changes: string[] = [];
  if (row.refundedCount > 0) changes.push(`${row.refundedCount} of its commissions ${row.refundedCount === 1 ? 'was' : 'were'} refunded`);
  if (row.disputedCount > 0) changes.push(`${row.disputedCount} ${row.disputedCount === 1 ? 'is' : 'are'} disputed`);
  if (changes.length === 0) return null;
  return `Since this payout was prepared, ${changes.join(' and ')}. If you have not sent it yet, cancel it and prepare it again: the new payout leaves them out. If you already sent it, record it; for a refund, recover the amount from the partner (the alert says so).`;
}

function PartnerCell({ handle, displayName, status }: { handle: string; displayName: string; status: AffiliatePreparedManualPayout['partnerStatus'] }) {
  return (
    <td className="px-4 py-3">
      <span className="block font-medium text-foreground">@{handle}</span>
      {displayName ? <span className="block text-xs text-muted-foreground">{displayName}</span> : null}
      {status !== 'ACTIVE' ? (
        <span className="mt-1 block">
          <AffiliatePartnerStatusBadge status={status} />
        </span>
      ) : null}
    </td>
  );
}

/** A payout email PayPal's file cannot carry as typed (it would be read as a formula): pay that partner another way. */
const NOT_FOR_PAYPAL = 'Not in the PayPal file: pay by Interac e-Transfer, Wise or bank transfer.';

function PayoutEmailCell({ email, note }: { email: string | null; note: string | null }) {
  return (
    <td className="px-4 py-3 break-all">
      {email ? (
        <>
          <span className="font-mono text-xs text-foreground">{email}</span>
          {note ? <span className="block text-xs text-muted-foreground">{note}</span> : null}
        </>
      ) : (
        <span className="text-xs text-muted-foreground">No payout email yet</span>
      )}
    </td>
  );
}

/**
 * "Pay manually" (02036): the commissions the program pays outside Stripe. A payout is prepared
 * first (its commissions reserved), then sent outside the CMS (the PayPal file lists the prepared
 * payouts), then recorded with its reference, or cancelled if it was never sent. So what is sent is
 * exactly what gets recorded: a refund or a dispute in between is flagged on the prepared payout, and
 * a commission that clears in between waits for the next one. Nothing here sends money.
 */
/** Why a partner owed commissions the program pays with PayPal is listed under Pay manually (02037). */
const PAYPAL_FALLBACK_TEXT: Readonly<Record<NonNullable<AffiliateManualPayoutQueue['rows'][number]['payPalFallback']>, string>> = {
  currency: 'PayPal Payouts doesn’t send this currency: pay this partner another way.',
  interac: 'PayPal can’t pay this partner: their payout email is for Interac e-Transfer.',
  no_email: 'PayPal can’t pay this partner: no payout email yet.',
  invalid_email: 'PayPal can’t pay this partner automatically: PayPal can’t take this payout email.',
  returned:
    'PayPal returned or stopped their last payout to this payout email: pay another way, or wait until they save it again (a new address, or the same one once their PayPal account can take it).',
};

function ManualPayoutsSection({
  queue,
  prepared,
  gateways,
  paypalGateways = [],
  minPayoutCents,
  sandbox,
  page,
  pageSize,
  preparedPage,
  preparedPageSize,
}: {
  /** Null while no gateway is paid by hand (nothing new to prepare) or when the read failed (`queueFailed`). */
  queue: AffiliateManualPayoutQueue | 'failed' | null;
  prepared: AffiliatePreparedManualPayouts | null;
  gateways: readonly AffiliateGateway[];
  /** The gateways paid with PayPal (02037): their partners PayPal cannot pay are listed here. */
  paypalGateways?: readonly AffiliateGateway[];
  minPayoutCents: number;
  sandbox: boolean;
  page: number;
  pageSize: number;
  preparedPage: number;
  preparedPageSize: number;
}) {
  const minimumText = (currency: string) => formatAdminMoney(minPayoutCents, currency);
  const disabledReason = sandbox ? SANDBOX_DISABLED : null;
  const paypalIntro =
    paypalGateways.length > 0
      ? ` Commissions on ${gatewaySalesText(paypalGateways)} are sent automatically with PayPal; the partners PayPal cannot pay (an Interac e-Transfer payout email, none, or one PayPal returned a payout from) are listed here too.`
      : '';
  return (
    <section aria-labelledby="affiliate-manual-heading" className="space-y-5 rounded-lg border border-border bg-card p-5 text-card-foreground shadow-sm">
      <div className="space-y-1">
        <h3 id="affiliate-manual-heading" className="text-base font-semibold text-foreground">
          Pay manually
        </h3>
        <p className="text-sm text-muted-foreground">
          {gateways.length > 0
            ? `Commissions on ${gatewaySalesText(gateways)} are paid outside Stripe, in three steps.${paypalIntro}`
            : paypalGateways.length > 0
              ? `Commissions on ${gatewaySalesText(paypalGateways)} are sent automatically with PayPal; the partners PayPal cannot pay (an Interac e-Transfer payout email, none, or one PayPal returned a payout from) are paid here, in three steps.`
              : 'No commission is paid manually anymore; finish or cancel the payouts already prepared.'}{' '}
          1. Prepare a payout: it reserves what the partner is owed, so the amount cannot change under you. 2. Send that exact
          amount from PayPal, Interac e-Transfer, Wise or your bank. 3. Record the payout with its reference once the payment is
          complete: this marks its commissions as paid and emails the partner. It does not send any money.
        </p>
        <p className="text-xs text-muted-foreground">
          Only live sales appear here: commissions on test orders (a Stripe test key, the Freemius sandbox) are never paid
          manually.
        </p>
      </div>

      {/* Step 2 and 3: the prepared payouts. */}
      <div className="space-y-3">
        <h4 className="text-sm font-semibold text-foreground">Prepared payouts: send them, then record them</h4>
        {!prepared ? (
          <AffiliateLoadErrorCard what="prepared manual payouts" />
        ) : (
          <>
            {prepared.totals.length > 0 ? (
              <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
                {prepared.totals.map((total) => (
                  <li key={total.currency} className="space-y-0.5">
                    <span className="block font-medium text-foreground">
                      {formatAdminMoney(total.amountCents, total.currency)} in {total.payouts} prepared{' '}
                      {total.payouts === 1 ? 'payout' : 'payouts'}
                    </span>
                    {total.paypalPayouts > 0 ? (
                      <a href={`${AFFILIATE_CMS_PAYOUTS_PATH}/paypal?currency=${total.currency}`} className={`text-xs ${LINK_CLASS}`}>
                        Download PayPal payouts file ({total.currency}, {total.paypalPayouts}{' '}
                        {total.paypalPayouts === 1 ? 'payout' : 'payouts'}, {formatAdminMoney(total.paypalAmountCents, total.currency)})
                      </a>
                    ) : (
                      <span className="block text-xs text-muted-foreground">
                        None of them goes to a payout email PayPal can take: send them by Interac e-Transfer, Wise or bank transfer.
                      </span>
                    )}
                    {total.paypalPayouts > AFFILIATE_PAYPAL_PAYOUTS_MAX_ROWS ? (
                      <span className="block text-xs text-muted-foreground">
                        PayPal takes 5,000 payments per file: the file holds the first 5,000. Record those, then download it again for
                        the rest.
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="overflow-hidden rounded-lg border border-border">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[56rem] text-left text-sm">
                  <caption className="sr-only">Prepared manual payouts, waiting to be recorded</caption>
                  <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th scope="col" className="px-4 py-3 font-medium">Partner</th>
                      <th scope="col" className="px-4 py-3 font-medium">Payout email</th>
                      <th scope="col" className="px-4 py-3 text-right font-medium">Amount</th>
                      <th scope="col" className="px-4 py-3 text-right font-medium">Commissions</th>
                      <th scope="col" className="px-4 py-3 font-medium">Prepared</th>
                      <th scope="col" className="px-4 py-3 text-right font-medium">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {prepared.rows.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                          No payout is prepared. Prepare one below before you send any money.
                        </td>
                      </tr>
                    ) : (
                      prepared.rows.map((row) => {
                        const amount = formatAdminMoney(row.amountCents, row.currency);
                        const changed = changedSincePreparedText(row);
                        return (
                          <tr key={row.payoutId} className="align-top">
                            <PartnerCell handle={row.handle} displayName={row.displayName} status={row.partnerStatus} />
                            <PayoutEmailCell email={row.payoutEmail} note={row.payoutEmail && row.partnerStatus === 'ACTIVE' && !row.paypalReady ? NOT_FOR_PAYPAL : null} />
                            <td className="px-4 py-3 text-right font-medium tabular-nums">{amount}</td>
                            <td className="px-4 py-3 text-right tabular-nums">{row.commissionCount}</td>
                            <td className="px-4 py-3 text-xs text-muted-foreground">
                              <time dateTime={row.preparedAt} title={formatAdminDateTime(row.preparedAt)}>
                                {formatAdminDate(row.preparedAt)}
                              </time>
                              {changed ? (
                                <span className="mt-1 block max-w-[16rem] text-amber-800 dark:text-amber-300">
                                  Changed since it was prepared: open Record payout for what to do.
                                </span>
                              ) : null}
                              {row.partnerStatus !== 'ACTIVE' ? (
                                <span className="mt-1 block max-w-[16rem]">
                                  Paused since it was prepared: cancel it unless you already sent it.
                                </span>
                              ) : null}
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex flex-wrap justify-end gap-2">
                                <ManualPayoutRecordButton
                                  payoutId={row.payoutId}
                                  handle={row.handle}
                                  displayName={row.displayName}
                                  amountLabel={amount}
                                  commissionCount={row.commissionCount}
                                  commissions={row.commissions.map((commission) => ({ id: commission.id, label: commissionLine(commission, row.currency) }))}
                                  payoutEmail={row.payoutEmail}
                                  changedSincePrepared={changed}
                                  disabledReason={disabledReason}
                                />
                                <ManualPayoutCancelButton
                                  payoutId={row.payoutId}
                                  handle={row.handle}
                                  displayName={row.displayName}
                                  amountLabel={amount}
                                  commissionCount={row.commissionCount}
                                  disabledReason={disabledReason}
                                />
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
              <TablePagination
                currentPage={preparedPage}
                pageSize={preparedPageSize}
                totalCount={prepared.total}
                basePath={AFFILIATE_CMS_PAYOUTS_PATH}
                itemLabel="prepared payouts"
                pageParam="preparedPage"
                pageSizeParam="preparedPageSize"
              />
            </div>
            {prepared.truncated ? <p className="text-xs text-muted-foreground">Some prepared payouts stopped at a read limit and may be missing.</p> : null}
            <p className="text-xs text-muted-foreground">
              The PayPal file follows PayPal&rsquo;s Payouts upload format (no header row, one currency per file, up to 5,000
              payments) and lists the prepared payouts of active partners with a payout email, at the amount prepared. Upload it
              under PayPal Business → Pay &amp; Get Paid → Payouts and check the payments PayPal shows. Record each payout once its
              payment is complete (PayPal shows it as Completed; a PayPal payment nobody claims comes back after 30 days): recording
              cannot be undone, while a prepared payout can still be cancelled. Partners set their payout email in their portal.
            </p>
          </>
        )}
      </div>

      {/* Step 1: what is owed and not prepared yet. */}
      {queue !== null ? (
        <div className="space-y-3">
          <h4 className="text-sm font-semibold text-foreground">Owed, not prepared yet</h4>
          {queue === 'failed' ? (
            <AffiliateLoadErrorCard what="commissions paid manually" />
          ) : (
            <>
              {queue.totals.length > 0 ? (
                <ul className="flex flex-wrap gap-x-6 gap-y-3 text-sm">
                  {queue.totals.map((total) => (
                    <li key={total.currency} className="space-y-1">
                      <span className="block font-medium text-foreground">
                        {formatAdminMoney(total.amountCents, total.currency)} owed to {total.partners}{' '}
                        {total.partners === 1 ? 'partner' : 'partners'}
                      </span>
                      {total.paypalPartners > 0 ? (
                        <ManualPayPalPrepareButton
                          currency={total.currency}
                          partners={total.paypalPartners}
                          amountLabel={formatAdminMoney(total.paypalAmountCents, total.currency)}
                          minimumLabel={minimumText(total.currency)}
                          disabledReason={disabledReason}
                        />
                      ) : (
                        <span className="block text-xs text-muted-foreground">
                          No partner owed in {total.currency} has a payout email and reaches the minimum yet, so there is nothing to
                          prepare for PayPal.
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : null}

              <div className="overflow-hidden rounded-lg border border-border">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[56rem] text-left text-sm">
                    <caption className="sr-only">Partners owed commissions paid manually and not prepared yet, by currency</caption>
                    <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th scope="col" className="px-4 py-3 font-medium">Partner</th>
                        <th scope="col" className="px-4 py-3 font-medium">Payout email</th>
                        <th scope="col" className="px-4 py-3 text-right font-medium">Owed</th>
                        <th scope="col" className="px-4 py-3 font-medium">Minimum payout</th>
                        <th scope="col" className="px-4 py-3 text-right font-medium">Commissions</th>
                        <th scope="col" className="px-4 py-3 text-right font-medium">
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {queue.rows.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                            Nothing else is owed manually right now. Commissions appear here once they clear their hold (the daily
                            run clears them, with automatic payouts on or off).
                          </td>
                        </tr>
                      ) : (
                        queue.rows.map((row) => {
                          const amount = formatAdminMoney(row.amountCents, row.currency);
                          return (
                            <tr key={`${row.affiliateId}|${row.currency}`} className="align-top">
                              <PartnerCell handle={row.handle} displayName={row.displayName} status={row.partnerStatus} />
                              <PayoutEmailCell email={row.payoutEmail} note={row.payoutEmail && row.payable && row.reachesMinimum && !row.paypalReady ? NOT_FOR_PAYPAL : null} />
                              <td className="px-4 py-3 text-right font-medium tabular-nums">{amount}</td>
                              <td className="px-4 py-3 text-xs">
                                {row.reachesMinimum ? (
                                  <span className="text-foreground">Reached</span>
                                ) : (
                                  <span className="text-muted-foreground">Below {minimumText(row.currency)}</span>
                                )}
                                {row.payPalFallback ? (
                                  <span className="mt-1 block max-w-[16rem] text-muted-foreground">{PAYPAL_FALLBACK_TEXT[row.payPalFallback]}</span>
                                ) : null}
                              </td>
                              <td className="px-4 py-3 text-right tabular-nums">{row.commissionCount}</td>
                              <td className="px-4 py-3 text-right">
                                {row.payable ? (
                                  <ManualPayoutPrepareButton
                                    affiliateId={row.affiliateId}
                                    handle={row.handle}
                                    currency={row.currency}
                                    amountLabel={amount}
                                    disabledReason={disabledReason}
                                  />
                                ) : (
                                  <span className="text-xs text-muted-foreground">Paused partners are not paid: resume them first.</span>
                                )}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
                <TablePagination
                  currentPage={page}
                  pageSize={pageSize}
                  totalCount={queue.total}
                  basePath={AFFILIATE_CMS_PAYOUTS_PATH}
                  itemLabel="partners"
                  pageParam="manualPage"
                  pageSizeParam="manualPageSize"
                />
              </div>
              {queue.truncated ? <p className="text-xs text-muted-foreground">Some commissions stopped at a read limit and may be missing.</p> : null}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Commissions and automated payouts: the platform's Stripe state (and the currency mismatch
 * warning of ADDENDUM B2), "Pay manually" for the commissions paid outside Stripe (02036), the
 * commission ledger with its clearance countdown, every payout with Retry / Release on failed
 * ones, and "Run payouts now".
 */
export default async function AffiliatePayoutsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { supabase } = await requireCmsAdmin();
  if (!(await isAffiliatesProgramActive())) {
    redirect('/cms/settings/packages');
  }

  const params = await searchParams;
  const filters = parseAffiliatePayoutsFilters(params);
  const manualPage = parseAffiliateAdminPage(params['manualPage']);
  const manualPageSize = parseAffiliateAdminPageSize(params['manualPageSize']);
  const preparedPage = parseAffiliateAdminPage(params['preparedPage']);
  const preparedPageSize = parseAffiliateAdminPageSize(params['preparedPageSize']);
  const db = toAffiliateAdminClient(supabase);

  const [dataResult, platformResult, baseCurrency] = await Promise.all([
    loadAffiliatePayoutsAdmin(db, filters).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => {
        console.error('[affiliates] payouts failed to load', {
          code: error && typeof error === 'object' ? (error as { code?: unknown }).code ?? null : null,
        });
        return { ok: false as const };
      }
    ),
    Promise.resolve()
      .then(() => getAffiliatePayoutPlatformInfo())
      .then(
        (value: unknown) => value,
        () => ({ error: 'stripe_unavailable' })
      ),
    getAffiliateStoreBaseCurrency(db),
  ]);

  const data = dataResult.ok ? dataResult.value : null;
  const platform = normalizeAffiliatePayoutPlatformInfo(platformResult, data?.baseCurrency ?? baseCurrency);
  const settings = data?.settings ?? null;
  const routing = routingOf(settings);
  const paypalRouted = hasPayPal(settings);
  const runDisabledReason = runDisabledReasonOf(platform, routing);

  // Pay manually (02036): what is owed by hand is read while some gateway is paid by hand (or, 02037,
  // with PayPal: its partners PayPal cannot pay are paid by hand); the prepared payouts are read
  // always, so one prepared before a gateway went back to Stripe Connect can still be recorded or
  // cancelled.
  const manualGateways = settings ? affiliateGatewaysPaidManually(settings) : [];
  const paypalGateways = settings ? affiliateGatewaysPaidByPayPal(settings) : [];
  const logManualFailure = (what: string, error: unknown) => {
    const cause = error && typeof error === 'object' ? (error as { cause?: unknown }).cause : null;
    console.error(`[affiliates] ${what} failed to load`, {
      code: cause && typeof cause === 'object' ? (cause as { code?: unknown }).code ?? null : null,
    });
  };
  const [manualQueue, preparedPayouts] = await Promise.all([
    settings && (manualGateways.length > 0 || paypalGateways.length > 0)
      ? loadAffiliateManualPayoutQueue(db, {
          gateways: manualGateways,
          paypalGateways,
          minPayoutCents: settings.minPayoutCents,
          page: manualPage,
          pageSize: manualPageSize,
        }).then(
          (value): AffiliateManualPayoutQueue | 'failed' => value,
          (error: unknown): 'failed' => {
            logManualFailure('manual payouts', error);
            return 'failed';
          }
        )
      : Promise.resolve(null),
    loadAffiliatePreparedManualPayouts(db, { page: preparedPage, pageSize: preparedPageSize }).then(
      (value): AffiliatePreparedManualPayouts | null => value,
      (error: unknown) => {
        logManualFailure('prepared manual payouts', error);
        return null;
      }
    ),
  ]);
  // Shown while some gateway is paid by hand, while a partner PayPal cannot pay is owed (02037), or
  // while a prepared payout waits (or could not be read).
  const owedToPayPalFallbacks = paypalGateways.length > 0 && manualQueue !== null && (manualQueue === 'failed' || manualQueue.total > 0);
  const showManual = manualGateways.length > 0 || owedToPayPalFallbacks || preparedPayouts === null || preparedPayouts.total > 0;
  const statusOptions: readonly string[] = filters.view === 'payouts' ? AFFILIATE_PAYOUT_STATUSES : AFFILIATE_COMMISSION_STATUSES;
  const statusLabels: Record<string, string> =
    filters.view === 'payouts' ? AFFILIATE_PAYOUT_STATUS_LABEL : AFFILIATE_COMMISSION_STATUS_LABEL;
  const selectedStatus = filters.view === 'payouts' ? filters.payoutStatus : filters.commissionStatus;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <AffiliatesSubnav active="payouts" />
      <AffiliatePageHeading
        title="Payouts and commissions"
        description={(paypalRouted ? PAGE_DESCRIPTION_WITH_PAYPAL : PAGE_DESCRIPTION)[routing]}
        actions={<RunPayoutsNowButton disabledReason={runDisabledReason} routing={routing} paypal={paypalRouted} />}
      />

      <PlatformCard platform={platform} data={data} />

      {settings && showManual ? (
        <ManualPayoutsSection
          queue={manualQueue}
          prepared={preparedPayouts}
          gateways={manualGateways}
          paypalGateways={paypalGateways}
          minPayoutCents={settings.minPayoutCents}
          sandbox={platform.sandbox}
          page={manualPage}
          pageSize={manualPageSize}
          preparedPage={preparedPage}
          preparedPageSize={preparedPageSize}
        />
      ) : null}

      {data && data.failedPayouts > 0 ? (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-200">
          <span>
            {data.failedPayouts === 1 ? '1 payout has failed.' : `${data.failedPayouts} payouts have failed.`}{' '}
            {/* Only the automatic run retries a payout by itself, and only while some gateway is paid through Stripe. */}
            {routing === 'manual'
              ? 'No commission is paid through Stripe now, so failed payouts are not retried: Release one to move its commissions to Pay manually, or Retry it.'
              : data.settings?.autoPayoutsEnabled === false
                ? 'Automatic payouts are off, so failed payouts wait for your Retry or Release.'
                : 'Failures caused by a low Stripe balance are retried automatically; others need Retry or Release.'}
            {routing === 'mixed'
              ? ' A failed Stripe payout keeps its commissions out of Pay manually: Release it to move the ones now paid manually there.'
              : ''}
          </span>
          <Button asChild size="sm" variant="outline">
            <Link href={`${AFFILIATE_CMS_PAYOUTS_PATH}?view=payouts&status=FAILED`}>Show failed payouts</Link>
          </Button>
        </div>
      ) : null}

      <section aria-labelledby="affiliate-ledger-heading" className="space-y-4">
        <h3 id="affiliate-ledger-heading" className="sr-only">
          Ledger
        </h3>
        <nav aria-label="Ledger views" className="flex flex-wrap items-end justify-between gap-3">
          <ul className="flex gap-1 rounded-lg border border-border bg-muted/30 p-1">
            {(['commissions', 'payouts'] as const).map((view) => (
              <li key={view}>
                <Link
                  href={viewHref(view)}
                  aria-current={filters.view === view ? 'page' : undefined}
                  className={cn(
                    'inline-flex min-h-9 items-center rounded-md px-3 py-1.5 text-sm font-medium focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
                    filters.view === view ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {view === 'commissions' ? 'Commissions' : 'Payouts'}
                  {view === 'payouts' && data && data.processingPayouts > 0 ? ` (${data.processingPayouts} processing)` : ''}
                </Link>
              </li>
            ))}
          </ul>
          <form method="get" action={AFFILIATE_CMS_PAYOUTS_PATH} className="flex items-end gap-2" aria-label="Filter by status">
            {filters.view === 'payouts' ? <input type="hidden" name="view" value="payouts" /> : null}
            <div className="space-y-1.5">
              <label htmlFor="affiliate-ledger-status" className="text-sm font-medium text-foreground">
                Status
              </label>
              <select id="affiliate-ledger-status" name="status" defaultValue={selectedStatus ?? ''} className={SELECT_CLASS}>
                <option value="">All statuses</option>
                {statusOptions.map((status) => (
                  <option key={status} value={status}>
                    {statusLabels[status]}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" variant="outline">
              Apply
            </Button>
          </form>
        </nav>

        {!data ? (
          <AffiliateLoadErrorCard what="ledger" />
        ) : filters.view === 'payouts' && data.payouts ? (
          <PayoutsTable rows={data.payouts.rows} partners={data.partners} total={data.payouts.total} filters={filters} routing={routing} />
        ) : data.commissions ? (
          <CommissionsTable rows={data.commissions.rows} partners={data.partners} total={data.commissions.total} filters={filters} />
        ) : null}
      </section>
    </div>
  );
}
