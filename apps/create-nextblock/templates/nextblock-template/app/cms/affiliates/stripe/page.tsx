import 'server-only';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import {
  AFFILIATE_CMS_APPROVALS_PATH,
  AFFILIATE_CMS_PATH,
  AFFILIATE_CMS_PAYOUTS_PATH,
  AFFILIATE_CMS_PAYPAL_PATH,
  AFFILIATE_CMS_TIERS_PATH,
  affiliateGatewaysPaidByPayPal,
  affiliateGatewaysPaidByStripe,
  affiliateGatewaysPaidManually,
  affiliateGatewaysPaidOutsideStripe,
  type AffiliateGateway,
  type AffiliatesSettings,
} from '@nextblock-cms/affiliates';
import { stripeCliListenCommand, type StripeKeyDiagnostics } from '@nextblock-cms/ecommerce/server';
import { requireCmsAdmin } from '../../../../lib/auth/cms-actor';
import { isAffiliatesProgramActive } from '../../../../lib/affiliates/package-state';
import type { AffiliatePayoutPlatformInfo } from '../../../../lib/affiliates/payout-runner';
import {
  describeAffiliateStripePayoutSchedule,
  loadAffiliateStripePayoutsOverview,
  type AffiliateStripeLastPayoutRun,
  type AffiliateStripePayoutsOverview,
} from '../../../../lib/affiliates/payout-setup';
import { AffiliatePageHeading } from '../components/AdminCards';
import { AffiliatesSubnav } from '../components/AffiliatesSubnav';
import { formatAdminDate, formatAdminDateTime, formatAdminMoney } from '../components/format';
import { AFFILIATE_PAYOUT_TRIGGER_LABEL } from '../components/labels';
import { ResolveAlertButton } from '../components/ResolveAlertButton';
import { StripeSetupTest } from '../components/StripeSetupTest';

export const metadata = {
  title: 'Stripe Payouts | NextBlock™ CMS',
};

/** Where the Stripe keys are entered (there is no second key store). */
const PAYMENTS_PATH = '/cms/payments';

const CARD = 'space-y-4 rounded-lg border border-border bg-card p-5 text-card-foreground shadow-sm';
const LINK =
  'font-medium text-primary underline underline-offset-4 hover:no-underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring';
const WARNING_BOX =
  'flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200';
const INFO_BOX = 'flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3 text-sm text-foreground';
const OK_BOX =
  'flex items-start gap-3 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-900/20 dark:text-emerald-200';

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground">{children}</dd>
    </div>
  );
}

function sourceText(source: StripeKeyDiagnostics['secretKeySource'], envName: string): string {
  if (source === 'cms') return 'Saved in the CMS';
  if (source === 'env') return `From the environment (${envName})`;
  return 'Not set';
}

function modeLabel(mode: 'test' | 'live' | null): string {
  return mode === 'live' ? 'Live mode' : mode === 'test' ? 'Test mode' : 'Unknown';
}

function stripeAnswer(platform: AffiliatePayoutPlatformInfo | null, sandbox: boolean): string {
  if (sandbox) return 'Not asked on the sandbox';
  if (!platform) return 'Could not be checked';
  if (platform.stripeConfigured === false) return 'Not asked: no secret key';
  if (platform.error === 'stripe_authentication') return 'Stripe rejected this key';
  const mode = platform.livemode === null ? null : platform.livemode ? 'live mode' : 'test mode';
  // Before the unknown mode: a restricted key without Balance read fails every read that sets the
  // mode, so the mode stays unknown, and that is a permission to grant, not a network problem.
  if (platform.error === 'stripe_permission') {
    return mode
      ? `Key accepted (${mode}), but it can't read everything payouts need`
      : "Key accepted, but it can't read everything payouts need (the balance)";
  }
  if (!mode) return platform.error ? "Couldn't reach Stripe" : 'Unknown';
  return `Key accepted (${mode})`;
}

function publishableKeyText(keys: StripeKeyDiagnostics): string {
  if (keys.publishableKeySource === null) return 'Missing (checkout needs it)';
  const mode = modeLabel(keys.publishableKeyMode).toLowerCase();
  // Without a secret key mode (no secret key, or an unknown prefix) there is no pair to mismatch.
  if (keys.publishableKeyMatchesMode || (keys.mode === null && keys.publishableKeyMode !== null)) return `Present, ${mode}`;
  return keys.publishableKeyMode ? `Present, but ${mode}: use the pair of the same mode` : 'Present (unrecognized prefix)';
}

/** "CA · Store USD · Stripe CAD", like the Payouts screen's platform card. */
function platformText(platform: AffiliatePayoutPlatformInfo | null, baseCurrency: string): string {
  const store = platform?.storeBaseCurrency ?? baseCurrency;
  return `${platform?.platformCountry ? `${platform.platformCountry} · ` : ''}Store ${store}${
    platform?.platformDefaultCurrency ? ` · Stripe ${platform.platformDefaultCurrency}` : ''
  }`;
}

/** Why a payout run stopped early (`AffiliatePayoutCycleAbortReason`), as a phrase. */
const ABORT_TEXT: Readonly<Record<string, string>> = {
  stripe_authentication: 'stopped: Stripe rejected the key',
  stripe_unavailable: 'stopped: Stripe could not be reached',
};

function lastRunText(lastRun: AffiliateStripeLastPayoutRun | 'unavailable' | null): string {
  if (lastRun === 'unavailable') return 'Could not be read';
  if (!lastRun) return 'No run yet';
  // Unknown trigger values (the column only has a length check) are left out rather than shown raw.
  const trigger = lastRun.trigger ? (AFFILIATE_PAYOUT_TRIGGER_LABEL as Readonly<Record<string, string>>)[lastRun.trigger] : undefined;
  const left = lastRun.remaining > 0 ? `, ${lastRun.remaining} ${lastRun.remaining === 1 ? 'partner' : 'partners'} left` : '';
  const parts = [`${formatAdminDate(lastRun.runDate)}${trigger ? ` (${trigger})` : ''}`, `${lastRun.sent} sent, ${lastRun.failed} failed${left}`];
  if (lastRun.aborted) parts.push(ABORT_TEXT[lastRun.aborted] ?? 'stopped early');
  return parts.join(' · ');
}

/**
 * The CRON_SECRET fact. The visit fallback (`maybeRunAffiliatePayouts()` in the CMS and portal
 * layouts) runs the daily run everywhere but the sandbox: it always clears commissions (02036), and
 * sends Stripe transfers only while automatic Stripe transfers are on with a key, so it is promised
 * off the sandbox (the Next run fact says when it sends no Stripe transfer).
 */
function cronSecretText(automation: AffiliateStripePayoutsOverview['automation'], visitFallback: boolean): string {
  if (automation.cronSecretConfigured) return 'Configured (16+ characters)';
  const fallback = visitFallback ? ', so the daily run happens on the first CMS or portal visit of the day' : '';
  if (automation.cronSecretTooShort) {
    return `Too short (under 16 characters): the payout endpoint refuses it${fallback}. Use a longer secret.`;
  }
  return `Not configured: the payout endpoint refuses every call${fallback}`;
}

/* ------------------------------------------------------------------------- cards --- */

const GATEWAY_SALES: Readonly<Record<AffiliateGateway, string>> = { STRIPE: 'Stripe sales', FREEMIUS: 'Freemius sales' };

/** "Freemius sales", or "Stripe and Freemius sales" for both gateways. */
function salesText(gateways: readonly AffiliateGateway[]): string {
  return gateways.length === 1 && gateways[0] ? GATEWAY_SALES[gateways[0]] : 'Stripe and Freemius sales';
}

/** How the commissions of some gateways are paid outside Stripe: PayPal Payouts (02037) or by hand (02036). */
function OutsideStripeText({ paypal, manual }: { paypal: readonly AffiliateGateway[]; manual: readonly AffiliateGateway[] }) {
  const paypalPart =
    paypal.length > 0 ? (
      <>
        commissions on {salesText(paypal)} are paid automatically with PayPal Payouts, from your PayPal balance (see{' '}
        <Link href={AFFILIATE_CMS_PAYPAL_PATH} className={LINK}>
          PayPal payouts
        </Link>
        )
      </>
    ) : null;
  const manualPart =
    manual.length > 0 ? (
      <>
        commissions on {salesText(manual)} are paid manually (PayPal, Interac e-Transfer or bank transfer) and recorded on the{' '}
        <Link href={AFFILIATE_CMS_PAYOUTS_PATH} className={LINK}>
          Payouts screen
        </Link>
      </>
    ) : null;
  return (
    <>
      {paypalPart}
      {paypalPart && manualPart ? '; ' : null}
      {manualPart}
    </>
  );
}

/** Who pays partners, as the program settings route each gateway (02036: Stripe Connect or by hand; 02037: PayPal). */
function WhoPaysCard({ settings }: { settings: AffiliatesSettings | null }) {
  const outside = settings ? affiliateGatewaysPaidOutsideStripe(settings) : [];
  const manual = settings ? affiliateGatewaysPaidManually(settings) : [];
  const paypal = settings ? affiliateGatewaysPaidByPayPal(settings) : [];
  const stripe = settings ? affiliateGatewaysPaidByStripe(settings) : [];
  const settingsLink = (
    <Link href={AFFILIATE_CMS_PATH} className={LINK}>
      Overview → Program settings
    </Link>
  );
  return (
    <section aria-labelledby="stripe-who-pays-heading" className={CARD}>
      <h3 id="stripe-who-pays-heading" className="text-base font-semibold text-foreground">
        Who pays your partners
      </h3>
      {outside.length === 0 ? (
        <>
          <p className="text-sm text-foreground">
            Customers pay you through Freemius (digital products) and Stripe (physical products). Your partners are always paid
            through Stripe Connect, from your Stripe balance — including their commissions on Freemius sales. Freemius pays you,
            never your partners, and its sales never add money to your Stripe balance.
          </p>
          <p className="text-sm text-foreground">
            To pay the commissions on Freemius sales from PayPal or Interac e-Transfer instead, choose PayPal (automatic) or
            Manually under {settingsLink} → How partners are paid.
          </p>
        </>
      ) : stripe.length === 0 && paypal.length === 0 ? (
        <p className="text-sm text-foreground">
          Customers pay you through Freemius (digital products) and Stripe (physical products). Every commission is paid manually
          (PayPal, Interac e-Transfer or bank transfer) and recorded on the{' '}
          <Link href={AFFILIATE_CMS_PAYOUTS_PATH} className={LINK}>
            Payouts screen
          </Link>
          : Stripe Connect sends nothing. Change it under {settingsLink}.
        </p>
      ) : stripe.length === 0 ? (
        <p className="text-sm text-foreground">
          Customers pay you through Freemius (digital products) and Stripe (physical products). No commission is paid through
          Stripe: <OutsideStripeText paypal={paypal} manual={manual} />. Stripe Connect sends nothing. Change it under{' '}
          {settingsLink}.
        </p>
      ) : (
        <p className="text-sm text-foreground">
          Customers pay you through Freemius (digital products) and Stripe (physical products). Commissions on {salesText(stripe)} are
          paid through Stripe Connect, from your Stripe balance; <OutsideStripeText paypal={paypal} manual={manual} />. Freemius pays
          you, never your partners, and its sales never add money to your Stripe balance.
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        Payouts use the same Stripe account and secret key as physical-product checkout. Payouts need only the secret key; the
        publishable key and webhook secret serve checkout and refunds.
      </p>
    </section>
  );
}

function ConnectAlertBox({ alert }: { alert: NonNullable<AffiliateStripePayoutsOverview['connectAlert']> }) {
  return (
    <div role="alert" className={WARNING_BOX}>
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="flex-1 space-y-1">
        <p className="font-medium">{alert.title || 'Stripe Connect refused a partner’s payout setup'}</p>
        <p>{alert.message}</p>
        <p className="text-xs">Raised {formatAdminDateTime(alert.createdAt)}. Fix the Stripe settings, then mark it as done.</p>
      </div>
      <ResolveAlertButton alertId={alert.id} title={alert.title || 'Stripe Connect setup'} />
    </div>
  );
}

function KeysCard({ overview }: { overview: AffiliateStripePayoutsOverview }) {
  const { keys, platform, sandbox, baseCurrency } = overview;
  const noKey = !sandbox && (keys?.secretKeySource ?? null) === null;
  const testDisabled = sandbox
    ? "Not available on the sandbox: its Stripe keys belong to the site's operator."
    : noKey
      ? 'Add a Stripe secret key under Payments first.'
      : null;

  return (
    <section aria-labelledby="stripe-keys-heading" className={CARD}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 id="stripe-keys-heading" className="text-base font-semibold text-foreground">
          Stripe keys
        </h3>
        <Link href={PAYMENTS_PATH} className={`text-sm ${LINK}`}>
          Edit keys in Payments
        </Link>
      </div>
      {sandbox ? (
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          On the sandbox the Stripe keys come from the deployment&rsquo;s environment and belong to its operator: nothing about them
          is shown, Stripe is never asked, and payouts are switched off.
        </p>
      ) : keys ? (
        <>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <Fact label="Secret key">
              {sourceText(keys.secretKeySource, 'STRIPE_SECRET_KEY')}
              {keys.secretKeyLast4 ? ` · ending in ${keys.secretKeyLast4}` : ''}
              {keys.restricted ? ' · restricted key' : ''}
            </Fact>
            <Fact label="Mode">{keys.secretKeySource ? modeLabel(keys.mode) : '—'}</Fact>
            <Fact label="Stripe says">{stripeAnswer(platform, sandbox)}</Fact>
            <Fact label="Platform and currencies">{platformText(platform, baseCurrency)}</Fact>
            <Fact label="Publishable key">{publishableKeyText(keys)}</Fact>
            <Fact label="Webhook secret">
              {keys.webhookSecretSource === null
                ? 'Not set (refunds and disputes need it)'
                : keys.webhookSecretSource === 'cms'
                  ? 'Set · saved in the CMS'
                  : 'Set · from the environment (STRIPE_WEBHOOK_SECRET)'}
            </Fact>
          </dl>
          {keys.storedSecretKeyUnreadable ? (
            <div role="alert" className={WARNING_BOX}>
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                A secret key is saved in the CMS, but this deployment can&rsquo;t decrypt it (its encryption key changed), so{' '}
                {keys.secretKeySource === 'env' ? 'the STRIPE_SECRET_KEY environment variable is used instead' : 'no key is used'}. Save
                the key again under Payments.
              </span>
            </div>
          ) : null}
          {keys.restricted ? (
            <p className="text-xs text-muted-foreground">
              A restricted key must allow, for payouts: Balance (read), Accounts and Account links (write, for partner onboarding),
              Login links (write), Transfers (write), and Webhook endpoints (read, for the test below).
            </p>
          ) : null}
        </>
      ) : (
        <p role="alert" className="text-sm text-red-800 dark:text-red-300">
          The key settings could not be read. Reload the page in a moment.
        </p>
      )}
      <StripeSetupTest disabledReason={testDisabled} />
    </section>
  );
}

/**
 * The Payouts screen's settlement-currency warning: commissions are paid in the store currency, so
 * a Stripe account that settles in another one has no balance for them (a funding row would read
 * "Short by" with nothing to say why).
 */
function CurrencyMismatchBox({ overview }: { overview: AffiliateStripePayoutsOverview }) {
  const { platform } = overview;
  if (!platform?.currencyMismatch || !platform.platformDefaultCurrency) return null;
  const store = platform.storeBaseCurrency ?? overview.baseCurrency;
  const stripe = platform.platformDefaultCurrency;
  return (
    <div role="alert" className={WARNING_BOX}>
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>
        Your Stripe account settles in {stripe}, but commissions are recorded and paid in the store currency, {store}. Transfers in{' '}
        {store} need a {store} balance: either add {store} to your Stripe account or make {stripe} the store&rsquo;s default
        currency.
      </span>
    </div>
  );
}

function FundingCard({ overview }: { overview: AffiliateStripePayoutsOverview }) {
  const { funding, sandbox, settings } = overview;
  // 02036: commissions paid by hand never need the Stripe balance, nor (02037) those paid with
  // PayPal: "Paid outside Stripe", outside Needed.
  const anyManual = settings ? affiliateGatewaysPaidOutsideStripe(settings).length > 0 : false;
  const anyPayPal = settings ? affiliateGatewaysPaidByPayPal(settings).length > 0 : false;
  const outsideLabel = anyPayPal ? 'Paid outside Stripe' : 'Paid manually';
  const heading = (
    <h3 id="stripe-funding-heading" className="text-base font-semibold text-foreground">
      Balance vs what you owe
    </h3>
  );
  if (!funding) {
    return (
      <section aria-labelledby="stripe-funding-heading" className={CARD}>
        {heading}
        <CurrencyMismatchBox overview={overview} />
        <p role="alert" className="text-sm text-red-800 dark:text-red-300">
          What you owe your partners could not be loaded. Reload the page in a moment; if it keeps failing, check that the
          affiliates migrations are applied.
        </p>
      </section>
    );
  }

  const mode = funding.livemode ? 'live mode' : 'test mode';
  const modeNote =
    funding.modeSource === 'stripe'
      ? `In ${mode}, the mode of your Stripe key.`
      : funding.modeSource === 'key'
        ? `In ${mode}, from your key's prefix (Stripe could not be asked).`
        : 'No Stripe key yet, so this shows what you owe in live mode.';
  const freemius = funding.rows.filter((row) => row.owedNowFreemiusCents > 0);

  return (
    <section aria-labelledby="stripe-funding-heading" className={CARD}>
      {heading}
      <p className="text-sm text-muted-foreground">
        {modeNote} What you owe partners, by currency, against what transfers can draw on: the card-payments part of your Stripe
        balance, available now and pending.
      </p>
      <CurrencyMismatchBox overview={overview} />
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-[56rem] text-left text-sm">
          <caption className="sr-only">What you owe your partners compared with your Stripe balance, by currency</caption>
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Currency</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Owed now</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">In flight</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Waiting to retry</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Needs your Retry or Release</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Clearing within {funding.windowDays} days</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Stripe transferable</th>
              <th scope="col" className="px-3 py-2 font-medium">Verdict</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {funding.rows.map((row) => {
              const money = (cents: number) => formatAdminMoney(cents, row.currency);
              return (
                <tr key={row.currency} className="align-top">
                  <th scope="row" className="px-3 py-2 font-medium text-foreground">
                    {row.currency}
                  </th>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {money(row.owedNowCents)}
                    {row.owedNowCents > 0 && !anyManual ? (
                      <span className="block text-xs text-muted-foreground">
                        Stripe sales {money(row.owedNowStripeCents)} · Freemius sales {money(row.owedNowFreemiusCents)}
                      </span>
                    ) : null}
                    {(row.owedManuallyCents ?? 0) > 0 ? (
                      <span className="block text-xs text-muted-foreground">
                        {outsideLabel}: {money(row.owedManuallyCents)} owed
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(row.inFlightCents)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(row.retryingCents)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(row.needsAdminCents)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(row.clearingSoonCents)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {row.transferableCents === null || row.pendingCents === null ? (
                      <span className="text-muted-foreground">{sandbox ? 'Not read on the sandbox' : 'Unknown'}</span>
                    ) : (
                      <>
                        {money(row.transferableCents + row.pendingCents)}
                        <span className="block text-xs text-muted-foreground">
                          {money(row.transferableCents)} available · {money(row.pendingCents)} pending
                        </span>
                      </>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {row.shortCents === null ? (
                      <span className="text-muted-foreground">Not checked</span>
                    ) : row.shortCents > 0 ? (
                      <span className="font-medium text-red-800 dark:text-red-300">Short by {money(row.shortCents)}</span>
                    ) : (
                      <span className="font-medium text-emerald-700 dark:text-emerald-400">Covered</span>
                    )}
                    <span className="block text-xs text-muted-foreground">Needed {money(row.neededCents)}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
        <li>
          Needed is owed now, waiting to retry, needs your Retry or Release, and clearing within {funding.windowDays} days. In-flight
          transfers are already on their way: their money normally left your balance when they were sent.
        </li>
        <li>
          Owed now is every cleared commission in no payout and under no dispute, net of refunds
          {anyManual ? ', on the sales paid through Stripe' : ''}. The next payout run pays only the part owed to active partners
          with an approved storefront who finished Stripe onboarding and reached the minimum payout, and only while the balance
          covers it. Failed payouts are on the{' '}
          <Link href={`${AFFILIATE_CMS_PAYOUTS_PATH}?view=payouts&status=FAILED`} className={LINK}>
            Payouts screen
          </Link>
          .
        </li>
        {anyManual && anyPayPal ? (
          <li>
            Paid outside Stripe is what you owe for the commissions paid with PayPal Payouts (from your PayPal balance, see{' '}
            <Link href={AFFILIATE_CMS_PAYPAL_PATH} className={LINK}>
              PayPal payouts
            </Link>
            ) or by hand, from live sales: it never needs your Stripe balance and is not part of Needed. Payments sent by hand are
            recorded under Pay manually on the{' '}
            <Link href={AFFILIATE_CMS_PAYOUTS_PATH} className={LINK}>
              Payouts screen
            </Link>
            .
          </li>
        ) : anyManual ? (
          <li>
            Paid manually is what you owe for the commissions you pay outside Stripe (PayPal, Interac e-Transfer, bank transfer),
            from live sales: it never needs your Stripe balance and is not part of Needed. Record those payments under Pay manually
            on the{' '}
            <Link href={AFFILIATE_CMS_PAYOUTS_PATH} className={LINK}>
              Payouts screen
            </Link>
            .
          </li>
        ) : null}
        {freemius.length > 0 ? (
          <li>
            {freemius.map((row) => formatAdminMoney(row.owedNowFreemiusCents, row.currency)).join(' and ')} of it was earned on
            Freemius sales: Freemius never adds money to your Stripe balance, so it has to be there already
            {anyManual ? '' : ', or pay those commissions manually (Overview → Program settings → How partners are paid)'}.
          </li>
        ) : null}
        {funding.truncated ? <li>Some figures stopped at a read limit and may be low.</li> : null}
      </ul>
    </section>
  );
}

function KeepMoneyCard({ overview }: { overview: AffiliateStripePayoutsOverview }) {
  const { schedule, sandbox, funding } = overview;
  const month = funding?.rows.filter((row) => row.lastWindowCents > 0) ?? [];
  const monthText =
    month.length > 0
      ? ` (about ${month.map((row) => formatAdminMoney(row.lastWindowCents, row.currency)).join(' and ')}: your commissions of the last ${funding?.windowDays ?? 30} days)`
      : '';

  return (
    <section aria-labelledby="stripe-keep-heading" className={CARD}>
      <h3 id="stripe-keep-heading" className="text-base font-semibold text-foreground">
        Keep money in Stripe
      </h3>
      <p className="text-sm text-foreground">
        Stripe sends your available balance to your bank on its payout schedule (daily by default), but commissions clear only after
        their tier&rsquo;s hold, so the money for them can be gone by the time they are paid.
      </p>
      {schedule && schedule.interval === 'manual' ? (
        <div className={OK_BOX}>
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Your Stripe payouts are manual: your balance stays in Stripe until you pay it out yourself.</span>
        </div>
      ) : schedule && schedule.interval ? (
        // Advice, not an alert: a Minimum balance also keeps the money in Stripe, and this screen can't read one.
        <div className={INFO_BOX}>
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            Stripe pays your balance out {describeAffiliateStripePayoutSchedule(schedule.interval, schedule.delayDays)}. Unless you keep a
            Minimum balance of at least a month of commissions{monthText}, set the schedule to Manual in the Stripe Dashboard →
            Settings → Payouts. This screen can&rsquo;t read a minimum balance, so it can&rsquo;t tell whether you keep one.
          </span>
        </div>
      ) : (
        <div className={INFO_BOX}>
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            {sandbox ? 'The payout schedule is not read on the sandbox.' : 'Your Stripe payout schedule could not be read.'} Check it
            in the Stripe Dashboard → Settings → Payouts: Manual keeps money in Stripe; otherwise set a Minimum balance of at least
            a month of commissions{monthText}.
          </span>
        </div>
      )}
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        <li>
          Top-ups (adding funds to your Stripe balance) exist only in some countries (US, UK, Japan; private preview in Canada: ask
          Stripe).
        </li>
        <li>
          Freemius sales never reach Stripe, so a store that sells mostly through Freemius must keep money in Stripe itself.
        </li>
      </ul>
    </section>
  );
}

function AutomationCard({ overview }: { overview: AffiliateStripePayoutsOverview }) {
  const { settings, automation, baseCurrency, sandbox, platform, keys } = overview;
  // The key's mode as Stripe answered it, else from its prefix.
  const live = typeof platform?.livemode === 'boolean' ? platform.livemode : keys?.mode === 'live';
  const httpsReturn = automation.returnUrl.startsWith('https://');
  // The visit fallback always runs the daily ledger repair (commissions clear without Stripe, 02036);
  // it sends Stripe transfers only while automatic payouts are on, some gateway is paid through Stripe
  // and a key is configured.
  const visitFallback = !sandbox;
  const stripeNeeded = settings ? affiliateGatewaysPaidByStripe(settings).length > 0 : true;
  const transfersStopped = settings
    ? !settings.autoPayoutsEnabled
      ? 'automatic Stripe transfers are off'
      : !stripeNeeded
        ? affiliateGatewaysPaidByPayPal(settings).length > 0
          ? 'no commission is paid through Stripe'
          : 'every commission is paid manually'
        : platform?.stripeConfigured === false
          ? 'no Stripe secret key is configured (add one under Payments)'
          : null
    : null;

  return (
    <section aria-labelledby="stripe-automation-heading" className={CARD}>
      <h3 id="stripe-automation-heading" className="text-base font-semibold text-foreground">
        Automation
      </h3>
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <Fact label="Automatic Stripe transfers">
          {settings
            ? `${settings.autoPayoutsEnabled ? 'On' : 'Off'} · minimum ${formatAdminMoney(settings.minPayoutCents, baseCurrency)}`
            : 'Unknown'}{' '}
          <Link href={AFFILIATE_CMS_PATH} className={`text-xs font-normal ${LINK}`}>
            Change in Overview → Program settings
          </Link>
        </Fact>
        <Fact label="Scheduler secret (CRON_SECRET)">{cronSecretText(automation, visitFallback)}</Fact>
        <Fact label="Last run">{lastRunText(automation.lastRun)}</Fact>
        <Fact label="Next run">
          {sandbox
            ? 'None: payouts are off on the sandbox'
            : `${formatAdminDateTime(automation.nextScheduledRunAt)} with a scheduler; without one, the first CMS or portal visit of the UTC day${
                transfersStopped ? ` (it clears commissions; it sends no Stripe transfer: ${transfersStopped})` : ''
              }`}
        </Fact>
        <div className="sm:col-span-2">
          <dt className="text-xs text-muted-foreground">Connect return address</dt>
          <dd className="break-all font-mono text-xs text-foreground">{automation.returnUrl}</dd>
        </div>
      </dl>
      {live && (!httpsReturn || !automation.siteUrlConfigured) ? (
        <div role="alert" className={WARNING_BOX}>
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            Your Stripe key is live, but {automation.siteUrlConfigured ? 'the site address is not https' : 'no site address is configured'}:
            Stripe sends partners back from onboarding only to an https address in live mode. Set NEXT_PUBLIC_URL to your site&rsquo;s
            https address before partners connect.
          </span>
        </div>
      ) : !automation.siteUrlConfigured && !sandbox ? (
        <p className="text-xs text-muted-foreground">
          No site address is configured (NEXT_PUBLIC_URL), so partners return to the address above. That works in test mode on
          this computer only.
        </p>
      ) : null}
    </section>
  );
}

function SetupGuide({ automation }: { automation: AffiliateStripePayoutsOverview['automation'] }) {
  return (
    <section aria-labelledby="stripe-guide-heading" className={CARD}>
      <details>
        <summary className="cursor-pointer rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring">
          <h3 id="stripe-guide-heading" className="inline text-base font-semibold text-foreground">
            Set up Stripe for payouts
          </h3>
        </summary>
        <div className="mt-4 space-y-4 text-sm text-foreground">
          <h4 className="font-semibold">In the Stripe Dashboard, in test mode</h4>
          <ol className="list-decimal space-y-1.5 pl-5">
            <li>
              Developers → API keys: copy the publishable key (<code>pk_test_…</code>) and the secret key (<code>sk_test_…</code>).
            </li>
            <li>Connect: enable Connect on your account; partners get Express accounts.</li>
            <li>Complete the platform profile Connect asks for (what your platform does, and who your partners are).</li>
            <li>
              Connect branding (Settings → Connect → Branding): a business name, a brand colour and an icon. Express onboarding
              needs all three.
            </li>
            <li>
              Allowed countries for Express onboarding: the countries your partners live in. Stripe transfers across borders only
              between the US, Canada, the UK, the EEA and Switzerland.
            </li>
            <li>If Stripe refuses to create partner accounts, turn on the &ldquo;Accounts v1&rdquo; option in your Connect settings.</li>
          </ol>
          <h4 className="font-semibold">On this site</h4>
          <ol className="list-decimal space-y-1.5 pl-5">
            <li>
              Paste the keys under{' '}
              <Link href={PAYMENTS_PATH} className={LINK}>
                CMS → Payments
              </Link>
              .
            </li>
            <li>
              Keep <code>NEXT_PUBLIC_IS_SANDBOX</code> off: the public sandbox never calls Stripe.
            </li>
            <li>
              {automation.webhookReachable ? (
                <>
                  Webhooks: add an endpoint for <code>{automation.webhookUrl}</code> in the Stripe Dashboard (Developers → Webhooks)
                  with the events listed under CMS → Payments, and save its <code>whsec_…</code> signing secret there.
                </>
              ) : (
                <>
                  Webhooks: forward them to this site with the Stripe CLI,{' '}
                  <code className="break-all">{stripeCliListenCommand(automation.webhookUrl)}</code>, then save the <code>whsec_…</code> signing
                  secret it prints as the webhook secret under CMS → Payments.
                </>
              )}
            </li>
            <li>Then use Test connection above.</li>
          </ol>
          <h4 className="font-semibold">A test payout</h4>
          <ol className="list-decimal space-y-1.5 pl-5">
            <li>
              Turn automatic payouts off while testing (
              <Link href={AFFILIATE_CMS_PATH} className={LINK}>
                Overview → Program settings
              </Link>
              ) and use &ldquo;Run payouts now&rdquo; on the Payouts screen instead.
            </li>
            <li>
              Before the test order, prepare a test partner. Give them a tier with a 0-day clearance hold (add a test tier under{' '}
              <Link href={AFFILIATE_CMS_TIERS_PATH} className={LINK}>
                Tiers
              </Link>
              , then move them to it from the Overview): a hold changed later doesn&rsquo;t move a commission already recorded. Have
              them submit their storefront and approve it under{' '}
              <Link href={AFFILIATE_CMS_APPROVALS_PATH} className={LINK}>
                Approvals
              </Link>
              , then have them finish Stripe onboarding from their portal while this site uses the test key.
            </li>
            <li>
              In a browser that is not signed in as the partner, open their referral link (from their portal) without declining
              marketing cookies, and pay a test order with another email address and the card <code>4000 0000 0000 0077</code>: its
              funds are available at once. The commission has to reach the minimum payout.
            </li>
            <li>
              Then use &ldquo;Run payouts now&rdquo; on the{' '}
              <Link href={AFFILIATE_CMS_PAYOUTS_PATH} className={LINK}>
                Payouts screen
              </Link>
              . Before going live, remove the test tier or restore its hold.
            </li>
          </ol>
        </div>
      </details>
    </section>
  );
}

/**
 * Stripe payouts: who pays partners (always Stripe Connect, from the Stripe balance), the Stripe
 * keys (entered under Payments; no second key store) with a read-only connection test, the
 * balance against what is owed, how to keep money in Stripe, the automation, and a setup guide.
 */
export default async function AffiliateStripePayoutsPage() {
  await requireCmsAdmin();
  if (!(await isAffiliatesProgramActive())) {
    redirect('/cms/settings/packages');
  }

  const overview = await loadAffiliateStripePayoutsOverview();

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <AffiliatesSubnav active="stripe" />
      <AffiliatePageHeading
        title="Stripe payouts"
        description="Partners are paid by Stripe Connect transfers from your Stripe balance. Check the keys, test the connection, and make sure the balance covers what you owe."
      />
      <WhoPaysCard settings={overview.settings} />
      {overview.connectAlert ? <ConnectAlertBox alert={overview.connectAlert} /> : null}
      <KeysCard overview={overview} />
      <FundingCard overview={overview} />
      <KeepMoneyCard overview={overview} />
      <AutomationCard overview={overview} />
      <SetupGuide automation={overview.automation} />
    </div>
  );
}
