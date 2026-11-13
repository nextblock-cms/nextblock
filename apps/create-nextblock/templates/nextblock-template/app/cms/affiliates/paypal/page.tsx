import 'server-only';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AlertTriangle, CheckCircle2, Circle, Info } from 'lucide-react';
import { AFFILIATE_CMS_PATH, AFFILIATE_CMS_PAYOUTS_PATH, type AffiliateGateway } from '@nextblock-cms/affiliates';
import { requireCmsAdmin } from '../../../../lib/auth/cms-actor';
import { isAffiliatesProgramActive } from '../../../../lib/affiliates/package-state';
import {
  loadAffiliatePayPalPayoutsOverview,
  type AffiliatePayPalInFlightRow,
  type AffiliatePayPalPayoutsOverview,
} from '../../../../lib/affiliates/paypal/admin';
import {
  AFFILIATE_PAYPAL_REQUEST_ACCESS_URL,
  isAffiliatePayPalPayoutCurrency,
  isAffiliatePayPalZeroDecimalCurrency,
} from '../../../../lib/affiliates/paypal/client';
import { AFFILIATE_PAYPAL_ENV_NAMES, AFFILIATE_PAYPAL_ENVIRONMENT_ENV_NAME } from '../../../../lib/affiliates/paypal/credentials';
import { describeAffiliatePayPalFailure } from '../../../../lib/affiliates/paypal/events';
import { AffiliateLoadErrorCard, AffiliatePageHeading } from '../components/AdminCards';
import { AffiliatesSubnav } from '../components/AffiliatesSubnav';
import { formatAdminDateTime, formatAdminMoney } from '../components/format';
import { ResolveAlertButton } from '../components/ResolveAlertButton';
import { PayPalConnectionTest, PayPalCredentialsForm, PayPalPayoutRowAction, PayPalSyncButton } from './PayPalPayoutsControls';

export const metadata = {
  title: 'PayPal Payouts | NextBlock™ CMS',
};

const CARD = 'space-y-4 rounded-lg border border-border bg-card p-5 text-card-foreground shadow-sm';
const LINK =
  'font-medium text-primary underline underline-offset-4 hover:no-underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring';
const WARNING_BOX =
  'flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200';
const INFO_BOX = 'flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3 text-sm text-foreground';

const SANDBOX_NOTE = "Not available on the sandbox: PayPal is never called there, and its credentials belong to the site's operator.";

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground">{children}</dd>
    </div>
  );
}

const GATEWAY_SALES: Readonly<Record<AffiliateGateway, string>> = { STRIPE: 'Stripe sales', FREEMIUS: 'Freemius sales' };

function gatewaysText(gateways: readonly AffiliateGateway[]): string {
  if (gateways.length === 0) return 'None: no commission is paid with PayPal';
  if (gateways.length === 1 && gateways[0]) return `Commissions on ${GATEWAY_SALES[gateways[0]]}`;
  return 'Every commission (Stripe and Freemius sales)';
}

function environmentText(overview: AffiliatePayPalPayoutsOverview): string {
  const { credentials } = overview;
  const env = credentials.environment === 'live' ? 'Live (real money)' : 'Sandbox (test money)';
  const source =
    credentials.environmentSource === 'cms'
      ? 'chosen in the CMS'
      : credentials.environmentSource === 'env'
        ? `from ${AFFILIATE_PAYPAL_ENVIRONMENT_ENV_NAME}`
        : 'the default';
  return `${env} · ${source}`;
}

function credentialsText(overview: AffiliatePayPalPayoutsOverview): string {
  const { active, environment } = overview.credentials;
  if (!active.configured) return 'Not configured for this environment';
  const names = AFFILIATE_PAYPAL_ENV_NAMES[environment];
  const source = active.source === 'cms' ? 'Saved in the CMS' : `From the environment (${names.clientId}, ${names.secret})`;
  return `${source}${active.clientIdLast4 ? ` · client ID ending in ${active.clientIdLast4}` : ''}`;
}

function connectionText(overview: AffiliatePayPalPayoutsOverview): string {
  const { connection, credentials } = overview;
  if (overview.sandbox) return 'Not asked on the sandbox';
  if (!credentials.active.configured) return 'Not asked: no credentials';
  if (connection.error === 'credentials') return 'PayPal rejected the credentials';
  if (connection.error === 'unavailable' || connection.payoutsEnabled === null) return 'PayPal could not be reached';
  // A sandbox app carries the Payouts permission without PayPal's review: it proves nothing about live Payouts.
  const sandboxApp = credentials.environment === 'sandbox';
  if (connection.payoutsEnabled) {
    return sandboxApp ? 'Credentials accepted · Payouts enabled (sandbox app: live Payouts needs PayPal’s approval)' : 'Credentials accepted · Payouts enabled';
  }
  return `Credentials accepted · Payouts NOT enabled for this ${sandboxApp ? 'sandbox ' : ''}app`;
}

/* ------------------------------------------------------------------------ cards --- */

function AlertsList({ overview }: { overview: AffiliatePayPalPayoutsOverview }) {
  if (overview.alerts.length === 0) return null;
  return (
    <div className="space-y-3">
      {overview.alerts.map((alert) => (
        <div key={alert.id} role="alert" className={WARNING_BOX}>
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="flex-1 space-y-1">
            <p className="font-medium">{alert.title || 'PayPal payout problem'}</p>
            <p>{alert.message}</p>
            <p className="text-xs">Raised {formatAdminDateTime(alert.createdAt)}. Fix it, then mark it as done.</p>
          </div>
          <ResolveAlertButton alertId={alert.id} title={alert.title || 'PayPal payout problem'} />
        </div>
      ))}
    </div>
  );
}

function StatusCard({ overview }: { overview: AffiliatePayPalPayoutsOverview }) {
  const { settings, baseCurrency, paypalGateways, credentials } = overview;
  return (
    <section aria-labelledby="paypal-status-heading" className={CARD}>
      <h3 id="paypal-status-heading" className="text-base font-semibold text-foreground">
        Status
      </h3>
      {overview.sandbox ? (
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          This is the public sandbox: PayPal is never called, no PayPal credential is read or saved, and payouts are switched off.
        </p>
      ) : (
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Fact label="Environment">{environmentText(overview)}</Fact>
          <Fact label="Credentials">{credentialsText(overview)}</Fact>
          <Fact label="PayPal says">{connectionText(overview)}</Fact>
          <Fact label="Paid with PayPal">{settings ? gatewaysText(paypalGateways) : 'Unknown'}</Fact>
          <Fact label="Automatic payouts">
            {settings
              ? `${settings.autoPayoutsEnabled ? 'On' : 'Off'} · minimum ${formatAdminMoney(settings.minPayoutCents, baseCurrency)}`
              : 'Unknown'}
          </Fact>
          <Fact label="Currency">{baseCurrency}: payouts go out in the store currency, from your PayPal balance in it</Fact>
        </dl>
      )}
      {credentials.active.storedSecretUnreadable ? (
        <div role="alert" className={WARNING_BOX}>
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            A PayPal secret is saved in the CMS, but this deployment can&rsquo;t decrypt it (its encryption key changed), so{' '}
            {credentials.active.source === 'env' ? 'the PAYPAL_* environment variables are used instead' : 'no PayPal credential is used'}.
            Save the secret again below.
          </span>
        </div>
      ) : null}
      {!overview.sandbox && credentials.environment === 'sandbox' && paypalGateways.length > 0 ? (
        <div role="alert" className={WARNING_BOX}>
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            PayPal is in Sandbox: commissions on real (live) sales routed to PayPal are not sent, and they are not listed under Pay
            manually either. They wait until you save your live credentials: the live environment pays live sales, the sandbox only
            test-mode ones.
          </span>
        </div>
      ) : null}
      {!overview.sandbox && paypalGateways.length > 0 && !isAffiliatePayPalPayoutCurrency(baseCurrency) ? (
        <div role="alert" className={WARNING_BOX}>
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            PayPal Payouts does not send {baseCurrency}, the store currency: commissions routed to PayPal are never sent by PayPal,
            and their partners are listed under Payouts → Pay manually. Choose Manually for these sales under Program settings.
          </span>
        </div>
      ) : !overview.sandbox && paypalGateways.length > 0 && isAffiliatePayPalZeroDecimalCurrency(baseCurrency) ? (
        <div className={INFO_BOX}>
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            PayPal sends {baseCurrency} in whole units only: a payout whose amount has a fraction is not sent and stays owed, with an
            alert on this screen.
          </span>
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Live payouts pay the commissions of live sales; sandbox payouts pay only the commissions of test-mode sales, so a real sale
        is never marked paid with test money. Choose which commissions PayPal pays, the minimum payout and the daily switch under{' '}
        <Link href={AFFILIATE_CMS_PATH} className={LINK}>
          Overview → Program settings
        </Link>
        .
      </p>
    </section>
  );
}

function CredentialsCard({ overview }: { overview: AffiliatePayPalPayoutsOverview }) {
  const { credentials } = overview;
  const saved = {
    sandbox: {
      clientIdLast4: credentials.environments.sandbox.clientIdLast4,
      savedInCms: credentials.environments.sandbox.savedInCms,
      configured: credentials.environments.sandbox.configured,
    },
    live: {
      clientIdLast4: credentials.environments.live.clientIdLast4,
      savedInCms: credentials.environments.live.savedInCms,
      configured: credentials.environments.live.configured,
    },
  };
  const testDisabled = overview.sandbox
    ? SANDBOX_NOTE
    : credentials.active.configured
      ? null
      : 'Save the credentials of your PayPal app first (or set the PAYPAL_* environment variables).';
  return (
    <section aria-labelledby="paypal-credentials-heading" className={CARD}>
      <h3 id="paypal-credentials-heading" className="text-base font-semibold text-foreground">
        PayPal app credentials
      </h3>
      <p className="text-sm text-muted-foreground">
        Credentials saved here win over the environment variables ({AFFILIATE_PAYPAL_ENV_NAMES.sandbox.clientId} /{' '}
        {AFFILIATE_PAYPAL_ENV_NAMES.sandbox.secret} for the sandbox, {AFFILIATE_PAYPAL_ENV_NAMES.live.clientId} /{' '}
        {AFFILIATE_PAYPAL_ENV_NAMES.live.secret} for live, and {AFFILIATE_PAYPAL_ENVIRONMENT_ENV_NAME}).
      </p>
      <PayPalCredentialsForm
        key={`${credentials.environment}|${saved.sandbox.clientIdLast4}|${saved.live.clientIdLast4}`}
        environment={credentials.environment}
        saved={saved}
        disabledReason={overview.sandbox ? SANDBOX_NOTE : null}
      />
      <div className="border-t border-border pt-4">
        <PayPalConnectionTest disabledReason={testDisabled} />
      </div>
    </section>
  );
}

function ChecklistItem({ done, children }: { done: boolean | null; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      {done ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
      ) : (
        <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      <span>
        {done === true ? <span className="sr-only">Done: </span> : done === false ? <span className="sr-only">To do: </span> : null}
        {children}
      </span>
    </li>
  );
}

function SetupChecklist({ overview }: { overview: AffiliatePayPalPayoutsOverview }) {
  const { credentials } = overview;
  const configured = credentials.active.configured;
  const enabled = overview.connection.payoutsEnabled === true;
  // A sandbox app carries the Payouts permission without PayPal's review: only a live app proves the approval.
  const live = credentials.environment === 'live';
  const routed = overview.paypalGateways.length > 0;
  return (
    <section aria-labelledby="paypal-checklist-heading" className={CARD}>
      <h3 id="paypal-checklist-heading" className="text-base font-semibold text-foreground">
        Set up PayPal payouts
      </h3>
      <ol className="space-y-2.5 text-sm text-foreground">
        <ChecklistItem done={null}>
          A verified PayPal Business account (confirmed email, identity and linked bank): Payouts send from a business
          account&rsquo;s balance.
        </ChecklistItem>
        <ChecklistItem done={live && enabled ? true : null}>
          Ask PayPal to enable Payouts on the live account:{' '}
          <a href={AFFILIATE_PAYPAL_REQUEST_ACCESS_URL} target="_blank" rel="noopener noreferrer" className={LINK}>
            request Payouts access (PayPal Canada)
          </a>
          ; from another country, request it on PayPal&rsquo;s Payouts page for that country or through PayPal support. PayPal
          reviews the request and emails its decision; live payouts work only once it is approved. Sandbox apps have Payouts
          without approval, so this step is for live payouts.
        </ChecklistItem>
        <ChecklistItem done={credentials.environments.live.configured ? true : null}>
          In the PayPal Developer Dashboard (developer.paypal.com → Apps &amp; Credentials), create a REST app (Merchant) under
          Sandbox, tick Payouts under its features and copy its client ID and secret. Once PayPal approves Payouts, switch to
          Live, create the live app the same way and copy its credentials.
        </ChecklistItem>
        <ChecklistItem done={configured}>Save the credentials above (PayPal checks them first).</ChecklistItem>
        <ChecklistItem done={overview.sandbox ? null : enabled}>
          Test the connection: the token must carry the Payouts permission{live ? '' : ' (with a sandbox app, it always does)'}.
        </ChecklistItem>
        <ChecklistItem done={routed}>
          Choose PayPal under{' '}
          <Link href={AFFILIATE_CMS_PATH} className={LINK}>
            Overview → Program settings → How partners are paid
          </Link>{' '}
          for the commissions PayPal should pay (Freemius sales are a good fit: Freemius never adds money to your Stripe balance).
        </ChecklistItem>
        <ChecklistItem done={null}>
          Keep enough money in your PayPal balance in {overview.baseCurrency}, the currency payouts go out in: PayPal refuses a batch
          the balance does not cover (this screen raises an alert when it does), and paying from a balance in another currency
          costs PayPal&rsquo;s conversion (about 4%). From a Canadian or US account, PayPal charges you about US$0.25 per payout
          to Canada or the US and 2% (at most US$20) elsewhere; partners pay nothing. A paid payout shows the fee when PayPal
          reports it in the payout currency.
        </ChecklistItem>
        <ChecklistItem done={null}>
          Partners add a PayPal payout email in their portal. Partners whose payout email is for Interac e-Transfer, or who have
          none, are paid under{' '}
          <Link href={AFFILIATE_CMS_PAYOUTS_PATH} className={LINK}>
            Payouts → Pay manually
          </Link>
          .
        </ChecklistItem>
        <ChecklistItem done={null}>
          Try it in the sandbox first: with sandbox credentials, &ldquo;Run payouts now&rdquo; on the Payouts screen pays the
          commissions of test-mode orders to sandbox PayPal accounts. Meanwhile, live sales routed to PayPal wait (they are never
          paid with test money and are not listed under Pay manually), so save the live credentials before you route real sales
          to PayPal.
        </ChecklistItem>
        <ChecklistItem done={null}>
          Live: before you turn automatic payouts on, send one small payout with &ldquo;Run payouts now&rdquo; to a partner you
          know and check it in PayPal Activity. Only a first real payout proves PayPal approved live Payouts; the connection test
          cannot.
        </ChecklistItem>
      </ol>
    </section>
  );
}

function inFlightStatusText(row: AffiliatePayPalInFlightRow): string {
  if (row.itemStatus) return row.itemStatus;
  if (row.batchId) return 'PENDING';
  if (row.senderBatchId) return 'Sent, PayPal has not confirmed it yet';
  return 'Claimed, not sent yet';
}

function InFlightCard({ overview }: { overview: AffiliatePayPalPayoutsOverview }) {
  const { inFlight } = overview;
  const syncDisabled = overview.sandbox ? SANDBOX_NOTE : null;
  return (
    <section aria-labelledby="paypal-inflight-heading" className={CARD}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 id="paypal-inflight-heading" className="text-base font-semibold text-foreground">
            PayPal payouts in flight
          </h3>
          <p className="text-sm text-muted-foreground">
            Sent to PayPal and not settled yet. Each payout run asks PayPal about them; a paid one is recorded as paid, a returned
            or failed one gives its commissions back. An unclaimed payment comes back after 30 days unless the partner claims it;
            you can stop it before then. Once you checked PayPal paid nothing, a payout PayPal never confirmed can be released an
            hour after its last send, and one PayPal accepted but never settled a week after it.
          </p>
        </div>
        <PayPalSyncButton disabledReason={syncDisabled} />
      </div>
      {inFlight === null ? (
        <p role="alert" className="text-sm text-red-800 dark:text-red-300">
          The PayPal payouts in flight could not be loaded. Reload the page in a moment; if it keeps failing, check that migration
          02037 is applied.
        </p>
      ) : inFlight.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No PayPal payout is in flight.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[56rem] text-left text-sm">
            <caption className="sr-only">PayPal payouts in flight, oldest first</caption>
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Partner</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Amount</th>
                <th scope="col" className="px-3 py-2 font-medium">PayPal status</th>
                <th scope="col" className="px-3 py-2 font-medium">Last sent</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {inFlight.rows.map((row) => {
                const partner = row.handle ? `@${row.handle}` : 'Unknown partner';
                const amount = formatAdminMoney(row.amountCents, row.currency);
                return (
                  <tr key={row.payoutId} className="align-top">
                    <td className="px-3 py-2">
                      <span className="block font-medium text-foreground">{partner}</span>
                      {row.receiver ? <span className="block break-all text-xs text-muted-foreground">To {row.receiver}</span> : null}
                    </td>
                    <td className="px-3 py-2 text-right font-medium tabular-nums">{amount}</td>
                    <td className="px-3 py-2 text-xs">
                      <span className="block font-medium text-foreground">{inFlightStatusText(row)}</span>
                      {row.batchId ? (
                        <span className="block font-mono text-muted-foreground" title={row.batchId}>
                          Batch {row.batchId}
                        </span>
                      ) : row.senderBatchId ? (
                        <span className="block break-all font-mono text-muted-foreground" title={row.senderBatchId}>
                          Sender batch {row.senderBatchId}
                        </span>
                      ) : null}
                      <span className="block text-muted-foreground">{row.environment === 'live' ? 'Live' : 'PayPal sandbox (test money)'}</span>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      <span className="block">{formatAdminDateTime(row.lastAttemptAt)}</span>
                      {row.checkedAt ? <span className="block">Checked {formatAdminDateTime(row.checkedAt)}</span> : null}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {row.action && !overview.sandbox ? (
                        <PayPalPayoutRowAction payoutId={row.payoutId} action={row.action} partnerLabel={partner} amountLabel={amount} />
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {inFlight && inFlight.total > inFlight.rows.length ? (
        <p className="text-xs text-muted-foreground">
          Showing the {inFlight.rows.length} oldest of {inFlight.total} payouts in flight.
        </p>
      ) : null}
    </section>
  );
}

function RecentFailedCard({ overview }: { overview: AffiliatePayPalPayoutsOverview }) {
  const rows = overview.recentFailed;
  if (rows !== null && rows.length === 0) return null;
  return (
    <section aria-labelledby="paypal-failed-heading" className={CARD}>
      <h3 id="paypal-failed-heading" className="text-base font-semibold text-foreground">
        Recent failed PayPal payouts
      </h3>
      <p className="text-sm text-muted-foreground">
        A failed PayPal payout gives its commissions back. A partner whose payout PayPal returned, blocked or could not pay, or
        that you stopped, is not paid by PayPal at that payout email again until they save it again: their live commissions are
        listed under Pay manually meanwhile. The others are paid again by the next payout run that sends PayPal payouts. Every
        payout is on the{' '}
        <Link href={`${AFFILIATE_CMS_PAYOUTS_PATH}?view=payouts&status=FAILED`} className={LINK}>
          Payouts screen
        </Link>
        .
      </p>
      {rows === null ? (
        <p role="alert" className="text-sm text-red-800 dark:text-red-300">
          The failed PayPal payouts could not be loaded. Reload the page in a moment.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {rows.map((row) => (
            <li key={row.payoutId} className="grid gap-1 px-3 py-2.5 text-sm sm:grid-cols-[10rem_8rem_1fr]">
              <span className="font-medium text-foreground">{row.handle ? `@${row.handle}` : 'Unknown partner'}</span>
              <span className="tabular-nums text-foreground">{formatAdminMoney(row.amountCents, row.currency)}</span>
              <span className="text-muted-foreground">
                {describeAffiliatePayPalFailure(row.reason)} {formatAdminDateTime(row.failedAt)}
                {row.environment === 'live' ? '' : ' · PayPal sandbox'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * PayPal payouts (02037): automatic PayPal Payouts from the operator's PayPal balance for the
 * gateways routed to PayPal. The status of the environment and credentials, the credentials form
 * (verified with PayPal before saving), a read-only connection test, the setup checklist, the
 * payouts in flight with "Check PayPal status now" and Stop payment / Release, and the recent failures.
 * ADMIN only (proxy, layout and here), program-gated.
 */
export default async function AffiliatePayPalPayoutsPage() {
  await requireCmsAdmin();
  if (!(await isAffiliatesProgramActive())) {
    redirect('/cms/settings/packages');
  }

  let overview: AffiliatePayPalPayoutsOverview | null = null;
  try {
    overview = await loadAffiliatePayPalPayoutsOverview();
  } catch (error) {
    console.error('[affiliates] The PayPal payouts screen could not be loaded', {
      message: error instanceof Error ? error.message : 'unknown',
    });
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <AffiliatesSubnav active="paypal" />
      <AffiliatePageHeading
        title="PayPal payouts"
        description="Partners are paid by PayPal Payouts from your PayPal balance, with the daily payout run. Connect your PayPal app, test the connection, and follow the payouts PayPal has not settled yet."
      />
      {overview ? (
        <>
          <AlertsList overview={overview} />
          <StatusCard overview={overview} />
          {!overview.sandbox && overview.paypalGateways.length === 0 && overview.settings ? (
            <div className={INFO_BOX}>
              <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                No commission is paid with PayPal yet: choose PayPal under{' '}
                <Link href={AFFILIATE_CMS_PATH} className={LINK}>
                  Overview → Program settings → How partners are paid
                </Link>{' '}
                once the connection works.
              </span>
            </div>
          ) : null}
          <CredentialsCard overview={overview} />
          <InFlightCard overview={overview} />
          <RecentFailedCard overview={overview} />
          <SetupChecklist overview={overview} />
        </>
      ) : (
        <AffiliateLoadErrorCard what="PayPal payouts" />
      )}
    </div>
  );
}
