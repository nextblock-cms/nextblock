import 'server-only';

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  AFFILIATE_DEFAULT_CLEARANCE_DAYS,
  AFFILIATE_DEFAULT_COOKIE_DAYS,
  AFFILIATE_PORTAL_PAYOUTS_PATH,
} from '@nextblock-cms/affiliates';

import {
  getAffiliateConnectCountryOptions,
  type AffiliateConnectCountryOptions,
} from '../../../../../lib/affiliates/connect-service';
import {
  countRetailerPayoutRoutes,
  loadRetailerPayoutsData,
  readRetailerPortalAccount,
  retailerClearedBalanceHint,
  type AffiliateNextPayoutEstimate,
  type RetailerClearedBalanceHint,
  type RetailerManualPayoutEstimate,
  type RetailerPayPalPayoutEstimate,
  type RetailerPayoutRoutes,
} from '../../../../../lib/affiliates/portal-data';
import { partnersTermsHref } from '../../../../../lib/affiliates/partners-paths';
import { buildAffiliatePortalReturnPath } from '../../../../../lib/affiliates/portal-return-path';
import { getRequestLocale, toAffiliatesLocale } from '../../../../../lib/affiliates/request-locale';
import { requireRetailerPage } from '../../../../../lib/affiliates/retailer-actor';
import { getPublicAffiliatesProgramSettings } from '../../../../../lib/affiliates/settings';
import { PartnerTermsLink } from '../../../../../components/affiliates/public/PartnerTermsLink';
import { DEFAULT_SITE_TITLE } from '../../../../lib/seo';
import { getSiteSettings } from '../../../../lib/site-settings';
import { ConnectCard } from '../components/ConnectCard';
import { CommissionsTable, PayoutsTable } from '../components/LedgerTables';
import { PayoutEmailForm } from '../components/PayoutEmailForm';
import { PayoutMethodsCard } from '../components/PayoutMethodsCard';
import { PortalNotice } from '../components/PortalNotice';
import { PortalStat } from '../components/PortalStat';
import type { PortalTranslate } from '../components/portal-copy';
import { formatPortalDate, formatPortalMoney, formatPortalPercent, portalIntlLocale } from '../components/portal-format';
import { getPortalServerCopy } from '../components/portal-server-copy';
import type { PortalLocale } from '../components/portal-types';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getPortalServerCopy();
  return { title: t('affiliates.portal.payouts_meta_title') };
}

type PortalSearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * The Connect countries with names localized on the server (so the server render and the
 * hydrated select show the same text) and the platform's country as the default.
 */
async function loadCountryOptions(locale: PortalLocale): Promise<AffiliateConnectCountryOptions> {
  try {
    return await getAffiliateConnectCountryOptions(portalIntlLocale(locale));
  } catch (error) {
    console.warn('[affiliates] Connect country options unavailable:', error instanceof Error ? error.message : String(error));
    return { platformCountry: null, countries: [] };
  }
}

function nextPayoutDisplay(
  estimate: AffiliateNextPayoutEstimate,
  t: PortalTranslate,
  locale: PortalLocale,
  minimumLabel: string,
  money: (amount: number) => string,
): { value: string; hint: string; isDate: boolean } {
  switch (estimate.kind) {
    case 'scheduled':
      return {
        value: formatPortalDate(estimate.date, locale),
        hint: t('affiliates.portal.next_payout_scheduled_hint'),
        isDate: true,
      };
    case 'paused':
      return { value: t('affiliates.portal.next_payout_paused'), hint: t('affiliates.portal.next_payout_paused_hint'), isDate: false };
    case 'not_eligible':
      return {
        value: t('affiliates.portal.next_payout_not_eligible'),
        hint: t('affiliates.portal.next_payout_not_eligible_hint'),
        isDate: false,
      };
    case 'connect_required':
      return { value: t('affiliates.portal.next_payout_connect'), hint: t('affiliates.portal.next_payout_connect_hint'), isDate: false };
    case 'below_minimum':
      return {
        value: t('affiliates.portal.next_payout_below_minimum'),
        hint: t('affiliates.portal.next_payout_below_minimum_hint', { min: minimumLabel, remaining: money(estimate.remainingCents) }),
        isDate: false,
      };
    case 'no_balance':
    default:
      return {
        value: t('affiliates.portal.next_payout_none'),
        hint: t('affiliates.portal.next_payout_none_hint', { min: minimumLabel }),
        isDate: false,
      };
  }
}

/**
 * The figure for the payouts the operator sends by hand (02036): no date and no Stripe promise, the
 * store's name as the sender, the partner's payout email as the destination.
 */
function manualPayoutDisplay(
  estimate: RetailerManualPayoutEstimate,
  t: PortalTranslate,
  minimumLabel: string,
  money: (amount: number) => string,
  siteName: string,
  payoutEmail: string | null,
): { value: string; hint: string } {
  switch (estimate.kind) {
    case 'sending':
      return {
        value: t('affiliates.portal.next_payout_manual', { site: siteName }),
        hint: t('affiliates.portal.next_payout_manual_sending_hint', { site: siteName, amount: money(estimate.amountCents) }),
      };
    case 'not_eligible':
      return { value: t('affiliates.portal.next_payout_not_eligible'), hint: t('affiliates.portal.next_payout_not_eligible_hint') };
    case 'email_required':
      return {
        value: t('affiliates.portal.next_payout_email_required'),
        hint: t('affiliates.portal.next_payout_email_required_hint', { site: siteName }),
      };
    case 'ready':
      return {
        value: t('affiliates.portal.next_payout_manual', { site: siteName }),
        hint: t('affiliates.portal.next_payout_manual_ready_hint', { site: siteName, email: payoutEmail ?? '' }),
      };
    case 'clearing':
      return {
        value: t('affiliates.portal.next_payout_manual', { site: siteName }),
        hint: t('affiliates.portal.next_payout_manual_clearing_hint', { email: payoutEmail ?? '', min: minimumLabel }),
      };
    case 'below_minimum':
      return {
        value: t('affiliates.portal.next_payout_below_minimum'),
        hint: t('affiliates.portal.next_payout_below_minimum_hint', { min: minimumLabel, remaining: money(estimate.remainingCents) }),
      };
    case 'no_balance':
    default:
      return { value: t('affiliates.portal.next_payout_none'), hint: t('affiliates.portal.next_payout_none_hint', { min: minimumLabel }) };
  }
}

/**
 * The figure for the payouts PayPal sends automatically (02037): a payout PayPal holds first (waiting
 * to be claimed, with where PayPal sent its claim email, or on its way), then the daily run's estimate.
 */
function paypalPayoutDisplay(
  estimate: RetailerPayPalPayoutEstimate,
  t: PortalTranslate,
  locale: PortalLocale,
  minimumLabel: string,
  money: (amount: number) => string,
  payoutEmail: string | null,
): { value: string; hint: string; isDate: boolean } {
  switch (estimate.kind) {
    case 'unclaimed':
      return {
        value: t('affiliates.portal.payout_paypal_status_unclaimed'),
        hint: t('affiliates.portal.payout_paypal_claim_hint', { email: estimate.email ?? payoutEmail ?? '' }),
        isDate: false,
      };
    case 'sending':
      return {
        value: t('affiliates.portal.next_payout_paypal_sending'),
        hint: t('affiliates.portal.balance_processing_paypal_hint', { amount: money(estimate.amountCents) }),
        isDate: false,
      };
    case 'no_balance':
      return {
        value: t('affiliates.portal.next_payout_none'),
        hint: t('affiliates.portal.next_payout_paypal_hint', { min: minimumLabel }),
        isDate: false,
      };
    default:
      // scheduled, paused, not eligible, below the minimum: the automated estimate's own lines (PayPal
      // pays in the same daily run; "connect your bank" never applies to a PayPal account).
      return nextPayoutDisplay(estimate, t, locale, minimumLabel, money);
  }
}

/** How the commissions are paid, for the lines that depend on it. */
interface PayoutRouting {
  routes: RetailerPayoutRoutes;
  siteName: string;
  /** Cleared, unattached commissions by how they are paid (minor units of the base currency). */
  cleared: { stripeCents: number; paypalCents: number; manualCents: number };
}

/**
 * The line under the cleared balance (see retailerClearedBalanceHint). A failed or running Stripe
 * transfer comes first, then a PayPal payout waiting to be claimed or on its way (02037), then a
 * manual payout being sent; otherwise the line says who pays the cleared money: Stripe automatically,
 * PayPal automatically, the store by hand, or two of them (with each part's amount).
 */
function clearedBalanceHintText(
  hint: RetailerClearedBalanceHint,
  t: PortalTranslate,
  minimumLabel: string,
  money: (amount: number) => string,
  routing: PayoutRouting,
): string {
  switch (hint.kind) {
    case 'failed_auto_retry':
      return t('affiliates.portal.balance_failed_retry_hint', { amount: money(hint.amountCents) });
    case 'failed_awaiting_review':
      return t('affiliates.portal.balance_failed_review_hint', { amount: money(hint.amountCents) });
    case 'on_its_way':
      return t('affiliates.portal.balance_processing_hint', { amount: money(hint.amountCents) });
    case 'waiting_claim_paypal':
      return t('affiliates.portal.balance_unclaimed_paypal_hint', { amount: money(hint.amountCents) });
    case 'on_its_way_paypal':
      return t('affiliates.portal.balance_processing_paypal_hint', { amount: money(hint.amountCents) });
    case 'on_its_way_manual':
      return t('affiliates.portal.balance_processing_manual_hint', { amount: money(hint.amountCents) });
    case 'minimum':
    default: {
      const { stripe, paypal, manual } = routing.routes;
      if (paypal && stripe) {
        return t('affiliates.portal.balance_cleared_stripe_paypal_hint', {
          stripe: money(routing.cleared.stripeCents),
          paypal: money(routing.cleared.paypalCents),
          min: minimumLabel,
        });
      }
      if (paypal && manual) {
        return t('affiliates.portal.balance_cleared_paypal_manual_hint', {
          paypal: money(routing.cleared.paypalCents),
          manual: money(routing.cleared.manualCents),
          site: routing.siteName,
          min: minimumLabel,
        });
      }
      if (paypal) return t('affiliates.portal.balance_cleared_paypal_hint', { min: minimumLabel });
      if (manual && stripe) {
        return t('affiliates.portal.balance_cleared_mixed_hint', {
          stripe: money(routing.cleared.stripeCents),
          manual: money(routing.cleared.manualCents),
          site: routing.siteName,
          min: minimumLabel,
        });
      }
      if (manual) return t('affiliates.portal.balance_cleared_manual_hint', { site: routing.siteName, min: minimumLabel });
      return t('affiliates.portal.balance_cleared_hint', { min: minimumLabel });
    }
  }
}

/** The site title (who sends the manual payouts), else the default title. Never throws. */
async function loadSiteName(): Promise<string> {
  try {
    const settings = await getSiteSettings();
    return settings?.siteTitle?.trim() || DEFAULT_SITE_TITLE;
  } catch {
    return DEFAULT_SITE_TITLE;
  }
}

export default async function RetailerPayoutsPage({ searchParams }: { searchParams: PortalSearchParams }) {
  // The request's own query string first (nothing is read before the access check): a sign-in comes
  // back here with it, Stripe Connect's ?connected=1 / ?connect_error=1 included.
  const params = await searchParams;
  const ctx = await requireRetailerPage(buildAffiliatePortalReturnPath(AFFILIATE_PORTAL_PAYOUTS_PATH, params), {
    allowSuspended: true,
  });
  const account = readRetailerPortalAccount(ctx.actor);
  if (!account) notFound();
  const { profile } = account;

  const requestLocale = await getRequestLocale();
  const locale = toAffiliatesLocale(requestLocale);
  const [t, data, countryOptions, programSettings, siteName] = await Promise.all([
    getPortalServerCopy(requestLocale),
    loadRetailerPayoutsData(ctx, account),
    loadCountryOptions(locale),
    getPublicAffiliatesProgramSettings(),
    loadSiteName(),
  ]);
  // The program rules: the operator's own terms page for this language, else the built-in terms.
  const termsHref = partnersTermsHref(locale, programSettings);

  const balance = data.balances.primary;
  const money = (amount: number) => formatPortalMoney(amount, balance.currency, locale);
  const minimumLabel = formatPortalMoney(data.settings.minPayoutCents, data.baseCurrency, locale);
  const holdDays = data.tier?.clearance_hold_days ?? AFFILIATE_DEFAULT_CLEARANCE_DAYS;
  const cookieDays = data.tier?.cookie_duration_days ?? AFFILIATE_DEFAULT_COOKIE_DAYS;
  const rate = data.tier ? formatPortalPercent(data.tier.commission_percentage, locale) : null;
  // 02036: Stripe Connect pays some gateways' commissions (the automated figure and the Connect
  // card) and the store sends the others by hand (the "How you get paid" card and its figure); 02037:
  // PayPal Payouts pays a gateway's commissions automatically to a partner with a PayPal payout email.
  const mode = data.payoutMode;
  const next = data.nextPayout ? nextPayoutDisplay(data.nextPayout, t, locale, minimumLabel, money) : null;
  const paypalNext = data.paypalPayout
    ? paypalPayoutDisplay(data.paypalPayout, t, locale, minimumLabel, money, data.payoutEmail)
    : null;
  const manualNext = data.manualPayout
    ? manualPayoutDisplay(data.manualPayout, t, minimumLabel, money, siteName, data.payoutEmail)
    : null;
  // Three columns once a fifth figure joins (two next-payout figures), four otherwise.
  const figureCount = 3 + [next, paypalNext, manualNext].filter(Boolean).length;
  const countries = countryOptions.countries.map((option) => ({ code: option.code, name: option.name }));
  const codes = countries.map((country) => country.code);
  // The platform's country when Stripe names it; otherwise the US when offered, else the first.
  const defaultCountry = countryOptions.platformCountry ?? (codes.includes('US') ? 'US' : (codes[0] ?? null));
  const suspended = profile.status !== 'ACTIVE';
  const nextClears = formatPortalDate(balance.nextClearsAt, locale);
  // The description and the FAQ name each method the program pays with: PayPal sends automatically,
  // Stripe transfers to the bank, the store sends the rest by hand.
  const routedMethods = [data.payoutMethods.stripeSales, data.payoutMethods.freemiusSales];
  const paidByPayPal = routedMethods.includes('paypal');
  const allPayPal = routedMethods.every((method) => method === 'paypal');
  const stripeAndPayPal = paidByPayPal && routedMethods.includes('stripe_connect');
  const payPalAndManual = paidByPayPal && routedMethods.includes('manual');
  const description = allPayPal
    ? t('affiliates.portal.payouts_description_paypal')
    : stripeAndPayPal
      ? t('affiliates.portal.payouts_description_stripe_paypal')
      : payPalAndManual
        ? t('affiliates.portal.payouts_description_paypal_manual', { site: siteName })
        : mode === 'manual'
          ? t('affiliates.portal.payouts_description_manual', { site: siteName })
          : mode === 'mixed'
            ? t('affiliates.portal.payouts_description_mixed', { site: siteName })
            : t('affiliates.portal.payouts_description');
  const payoutAnswer = allPayPal
    ? t('affiliates.portal.faq_payout_answer_paypal', { min: minimumLabel, site: siteName })
    : stripeAndPayPal
      ? t('affiliates.portal.faq_payout_answer_stripe_paypal', { min: minimumLabel, site: siteName })
      : payPalAndManual
        ? t('affiliates.portal.faq_payout_answer_paypal_manual', { min: minimumLabel, site: siteName })
        : mode === 'manual'
          ? t('affiliates.portal.faq_payout_answer_manual', { min: minimumLabel, site: siteName })
          : mode === 'mixed'
            ? t('affiliates.portal.faq_payout_answer_mixed', { min: minimumLabel, site: siteName })
            : t('affiliates.portal.faq_payout_answer', { min: minimumLabel });

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">{t('affiliates.portal.payouts_title')}</h1>
        <p className="max-w-3xl text-muted-foreground">{description}</p>
      </header>

      {data.ledgerError ? (
        <PortalNotice tone="warning" title={t('affiliates.portal.ledger_error_title')}>
          <p>{t('affiliates.portal.ledger_error_body')}</p>
        </PortalNotice>
      ) : null}

      {mode !== 'stripe' ? (
        <PayoutMethodsCard t={t} methods={data.payoutMethods} siteName={siteName} paypalReturnedTo={data.paypalReturnedTo}>
          <PayoutEmailForm
            initialEmail={data.payoutEmail}
            initialKind={data.payoutEmailKind}
            sandbox={data.isSandbox}
            suspended={suspended}
            siteName={siteName}
            paypalPayouts={data.paypalGateways.length > 0}
            paypalReturned={data.paypalReturnedTo !== null}
          />
        </PayoutMethodsCard>
      ) : null}

      {mode !== 'manual' ? (
        <ConnectCard
          state={data.connect}
          sandbox={data.isSandbox}
          suspended={suspended}
          countries={countries}
          defaultCountry={defaultCountry}
          detailsSubmitted={profile.stripe_connect_details_submitted}
          refreshOnMount={params['connected'] === '1'}
          connectError={params['connect_error'] === '1'}
          partial={mode === 'mixed'}
        />
      ) : null}

      <section aria-labelledby="portal-balance-heading" className="space-y-4">
        <h2 id="portal-balance-heading" className="text-lg font-semibold text-foreground">
          {t('affiliates.portal.balance_title')}
        </h2>
        <dl className={figureCount > 4 ? 'grid gap-4 sm:grid-cols-2 lg:grid-cols-3' : 'grid gap-4 sm:grid-cols-2 lg:grid-cols-4'}>
          <PortalStat
            label={t('affiliates.portal.balance_pending', { days: holdDays })}
            value={money(balance.pendingCents)}
            hint={nextClears ? t('affiliates.portal.balance_pending_hint', { date: nextClears }) : t('affiliates.portal.balance_pending_hint_empty')}
          />
          <PortalStat
            label={t('affiliates.portal.balance_cleared')}
            value={money(balance.clearedCents + balance.processingCents)}
            hint={clearedBalanceHintText(
              retailerClearedBalanceHint(balance.processingCents, data.failedPayouts, data.manualSendingCents, {
                sendingCents: data.paypalSendingCents,
                unclaimedCents: data.paypalUnclaimed?.amountCents ?? 0,
              }),
              t,
              minimumLabel,
              money,
              { routes: data.payoutRoutes, siteName, cleared: data.clearedByMethod },
            )}
          />
          <PortalStat label={t('affiliates.portal.balance_paid')} value={money(balance.paidCents)} />
          {next ? (
            <PortalStat
              label={t('affiliates.portal.balance_next_payout')}
              value={next.isDate ? next.value : <span className="text-base font-medium">{next.value}</span>}
              hint={next.hint}
            />
          ) : null}
          {paypalNext ? (
            <PortalStat
              label={t('affiliates.portal.balance_next_paypal_payout')}
              value={paypalNext.isDate ? paypalNext.value : <span className="text-base font-medium">{paypalNext.value}</span>}
              hint={paypalNext.hint}
            />
          ) : null}
          {manualNext ? (
            <PortalStat
              label={t('affiliates.portal.balance_next_manual_payout', { site: siteName })}
              value={<span className="text-base font-medium">{manualNext.value}</span>}
              hint={manualNext.hint}
            />
          ) : null}
        </dl>
      </section>

      <section aria-labelledby="portal-commissions-heading" className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="portal-commissions-heading" className="text-lg font-semibold text-foreground">
            {t('affiliates.portal.commissions_title')}
          </h2>
          {data.commissions.count > data.commissions.rows.length ? (
            <p className="text-sm text-muted-foreground">
              {t('affiliates.portal.table_showing_latest', { shown: data.commissions.rows.length, total: data.commissions.count })}
            </p>
          ) : null}
        </div>
        {data.commissions.rows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-card p-6 text-sm text-muted-foreground">
            {t('affiliates.portal.commissions_empty')}
          </p>
        ) : (
          <CommissionsTable
            rows={data.commissions.rows}
            t={t}
            locale={locale}
            caption={t('affiliates.portal.commissions_title')}
            payoutMethods={countRetailerPayoutRoutes(data.payoutRoutes) > 1 ? data.commissionPayoutMethods : null}
          />
        )}
      </section>

      <section aria-labelledby="portal-payouts-heading" className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="portal-payouts-heading" className="text-lg font-semibold text-foreground">
            {t('affiliates.portal.payouts_history_title')}
          </h2>
          {data.payouts.count > data.payouts.rows.length ? (
            <p className="text-sm text-muted-foreground">
              {t('affiliates.portal.table_showing_latest', { shown: data.payouts.rows.length, total: data.payouts.count })}
            </p>
          ) : null}
        </div>
        {data.payouts.rows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-card p-6 text-sm text-muted-foreground">
            {t('affiliates.portal.payouts_empty')}
          </p>
        ) : (
          <PayoutsTable
            rows={data.payouts.rows}
            autoRetryPayoutIds={new Set(data.failedPayouts.autoRetryPayoutIds)}
            t={t}
            locale={locale}
            caption={t('affiliates.portal.payouts_history_title')}
          />
        )}
      </section>

      <section aria-labelledby="portal-faq-heading" className="rounded-lg border border-border bg-card p-6 text-card-foreground">
        <h2 id="portal-faq-heading" className="text-lg font-semibold">
          {t('affiliates.portal.faq_title')}
        </h2>
        <dl className="mt-4 space-y-4 text-sm">
          <div>
            <dt className="font-medium text-foreground">{t('affiliates.portal.faq_earn_question')}</dt>
            <dd className="mt-1 text-muted-foreground">
              {rate ? t('affiliates.portal.faq_earn_answer_rate', { rate }) : t('affiliates.portal.faq_earn_answer')}
            </dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">{t('affiliates.portal.faq_renewals_question')}</dt>
            <dd className="mt-1 text-muted-foreground">{t('affiliates.portal.faq_renewals_answer')}</dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">{t('affiliates.portal.faq_hold_question')}</dt>
            <dd className="mt-1 text-muted-foreground">{t('affiliates.portal.faq_hold_answer', { days: holdDays })}</dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">{t('affiliates.portal.faq_payout_question')}</dt>
            <dd className="mt-1 text-muted-foreground">{payoutAnswer}</dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">{t('affiliates.portal.faq_window_question')}</dt>
            <dd className="mt-1 text-muted-foreground">{t('affiliates.portal.faq_window_answer', { days: cookieDays })}</dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">{t('affiliates.portal.faq_terms_question')}</dt>
            <dd className="mt-1">
              <PartnerTermsLink
                href={termsHref}
                newTabLabel={t('affiliates.portal.opens_new_tab')}
                className="rounded-sm font-medium text-primary underline underline-offset-4 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {t('affiliates.portal.faq_terms_link')}
              </PartnerTermsLink>
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
