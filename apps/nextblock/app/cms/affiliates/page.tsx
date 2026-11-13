import 'server-only';

import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  Banknote,
  CircleDollarSign,
  ClipboardCheck,
  FlaskConical,
  Hourglass,
  MousePointerClick,
  Store,
  Users,
} from 'lucide-react';
import {
  AFFILIATE_CMS_APPROVALS_PATH,
  AFFILIATE_CMS_PATH,
  AFFILIATE_CMS_PAYOUTS_PATH,
  AFFILIATE_CMS_STRIPE_PATH,
  AFFILIATE_CMS_TIERS_PATH,
  AFFILIATE_ONBOARDING_STEPS,
  AFFILIATE_PARTNERS_PATH,
  affiliateGatewaysPaidByPayPal,
  affiliateGatewaysPaidByStripe,
  affiliateGatewaysPaidManually,
  normalizeAffiliatePayoutMethods,
} from '@nextblock-cms/affiliates';
import { Button, Input, Label, Progress } from '@nextblock-cms/ui';
import { getCurrencyMinorUnitFactor } from '@nextblock-cms/utils';
import { requireCmsAdmin } from '../../../lib/auth/cms-actor';
import {
  loadAffiliateOverview,
  loadAffiliatePartnerEmails,
  parseAffiliateOverviewFilters,
  toAffiliateAdminClient,
  type AffiliateActivityItem,
  type AffiliateOverviewData,
} from '../../../lib/affiliates/admin-data';
import { getAffiliatePartnerEmailSubject } from '../../../lib/affiliates/partner-contact';
import { AFFILIATES_SETTINGS_LIMITS } from '../../../lib/affiliates/settings';
import { loadAffiliateTermsOperatorIdentity } from '../../../lib/affiliates/terms-identity';
import { resolveSiteUrl } from '../../../lib/site-url';
import TablePagination from '../components/TablePagination';
import { AffiliateLoadErrorCard, AffiliateMetricTile, AffiliatePageHeading } from './components/AdminCards';
import { AffiliatesSubnav } from './components/AffiliatesSubnav';
import { CopyTextButton } from './components/CopyTextButton';
import { formatAdminCount, formatAdminDate, formatAdminDateTime, formatAdminMoney, formatAdminRelative } from './components/format';
import { AFFILIATE_ALERT_TYPE_LABEL, AFFILIATE_ONBOARDING_STEP_LABEL, AFFILIATE_STRIPE_ALERT_KIND_LABEL } from './components/labels';
import { PartnerEmailActions } from './components/PartnerEmailActions';
import { PartnerRowActions } from './components/PartnerRowActions';
import { buildPartnerTierOptions } from './components/tier-options';
import { PARTNERS_LOCKED_NOTE_ID, PartnersLockedNote } from './components/PartnersLockedNote';
import { ProgramSettingsForm } from './components/ProgramSettingsForm';
import { ResolveAlertButton } from './components/ResolveAlertButton';
import {
  AffiliatePageStatusBadge,
  AffiliatePartnerStatusBadge,
  AffiliateStorefrontStateBadge,
  AffiliateTierBadge,
} from './components/StatusBadges';
import { isAffiliatesProgramActive } from '../../../lib/affiliates/package-state';

export const metadata = {
  title: 'Affiliates | NextBlock™ CMS',
};

const SELECT_CLASS =
  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

/** Underlined at rest: inside a sentence a link must not differ from the text by colour alone. */
const TOUR_LINK_CLASS =
  'font-medium text-primary underline underline-offset-4 hover:no-underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

/**
 * The public sandbox's tour of the program, above the overview: what to try, each linked to the
 * screen where it happens. The reset cron seeds the demo partners, their storefronts and orders
 * (app/api/cron/reset-sandbox/affiliate-demo.ts). Never links a storefront: /partners is the
 * program's landing page, which sets no referral cookie.
 */
function SandboxTourBanner() {
  return (
    <section
      aria-labelledby="affiliate-sandbox-tour-heading"
      className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm"
    >
      <FlaskConical className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
      <div className="space-y-2">
        <h3 id="affiliate-sandbox-tour-heading" className="font-semibold text-foreground">
          Try the affiliate program
        </h3>
        <p className="text-foreground">This sandbox resets every 15 minutes. Things to try:</p>
        <ul className="list-disc space-y-1 pl-5 text-foreground">
          <li>
            <Link href={AFFILIATE_CMS_APPROVALS_PATH} className={TOUR_LINK_CLASS}>
              Approvals
            </Link>
            : review a storefront waiting for approval, with its live and proposed versions side by side.
          </li>
          <li>
            <Link href="/cms/orders" className={TOUR_LINK_CLASS}>
              Orders
            </Link>
            : mark Studio Nova&rsquo;s pending order as paid to record a commission, or set a paid order to Refunded to
            void its commission (one already paid out raises an alert instead).
          </li>
          <li>
            <Link href={AFFILIATE_CMS_TIERS_PATH} className={TOUR_LINK_CLASS}>
              Tiers
            </Link>
            : edit a commission rate, then reload{' '}
            <a href={AFFILIATE_PARTNERS_PATH} target="_blank" rel="noopener noreferrer" className={TOUR_LINK_CLASS}>
              {AFFILIATE_PARTNERS_PATH}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            .
          </li>
          <li>
            <Link href={AFFILIATE_CMS_PAYOUTS_PATH} className={TOUR_LINK_CLASS}>
              Payouts
            </Link>
            : browse the commission ledger and a failed payout. Payouts are disabled in the sandbox.
          </li>
        </ul>
      </div>
    </section>
  );
}

/**
 * The label of a platform-wide Stripe alert (the Connect setup alert, the insufficient-balance
 * alert): an `affiliate_payout_failed` row about no payout of its own. Null for every other item.
 */
function stripeAlertLabel(item: AffiliateActivityItem): string | null {
  if (item.alertType !== 'affiliate_payout_failed' || !item.kind) return null;
  return AFFILIATE_STRIPE_ALERT_KIND_LABEL[item.kind] ?? null;
}

/**
 * Where an activity item leads: the storefront review, the Stripe payouts screen (a platform-wide
 * Stripe alert, as the banner links it), the payouts list, or nowhere.
 */
function activityHref(item: AffiliateActivityItem): string | null {
  if (item.alertType === 'affiliate_page_submitted' && item.pageId) return `${AFFILIATE_CMS_APPROVALS_PATH}/${item.pageId}`;
  if (stripeAlertLabel(item)) return AFFILIATE_CMS_STRIPE_PATH;
  if (item.alertType === 'affiliate_payout_failed' || item.alertType === 'affiliate_refund_after_payout') {
    return '/cms/affiliates/payouts?view=payouts';
  }
  return null;
}

/**
 * The affiliate program at a glance: headline numbers, the onboarding funnel, every partner
 * (search, filters, email, a link to their review page, tier moves, pause and resume), the
 * lifecycle activity feed and the program settings.
 * ADMIN-only: the proxy refuses other roles, and the page re-checks before any read.
 */
export default async function AffiliatesOverviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { supabase } = await requireCmsAdmin();
  if (!(await isAffiliatesProgramActive())) {
    redirect('/cms/settings/packages');
  }

  const filters = parseAffiliateOverviewFilters(await searchParams);
  const db = toAffiliateAdminClient(supabase);
  let data: AffiliateOverviewData | null = null;
  try {
    data = await loadAffiliateOverview(db, filters);
  } catch (error) {
    console.error('[affiliates] overview failed to load', {
      code: error && typeof error === 'object' ? (error as { code?: unknown }).code ?? null : null,
    });
  }

  if (!data) {
    return (
      <div className="mx-auto w-full max-w-7xl space-y-6">
        <AffiliatesSubnav active="overview" />
        <AffiliateLoadErrorCard what="affiliate program" />
      </div>
    );
  }

  const { metrics, tiers, partners, activity, settings } = data;
  // How each gateway's commissions are paid (02036); a value the settings never held reads as Stripe Connect.
  const payoutMethods = normalizeAffiliatePayoutMethods(settings.payoutMethods);
  // The "Cleared, awaiting payout" hint follows it: the daily run pays what goes through Stripe or,
  // since 02037, PayPal (a partner whose payout email is for Interac is paid by hand even then).
  const paypalRouted = affiliateGatewaysPaidByPayPal({ payoutMethods }).length > 0;
  const clearedHint =
    affiliateGatewaysPaidManually({ payoutMethods }).length === 0
      ? paypalRouted
        ? 'Paid by the next payout run (an Interac e-Transfer payout email: under Payouts → Pay manually)'
        : 'Paid by the next payout run'
      : affiliateGatewaysPaidByStripe({ payoutMethods }).length === 0 && !paypalRouted
        ? 'Prepare, send and record each payout under Payouts → Pay manually'
        : paypalRouted
          ? 'PayPal-paid ones go out in the next payout run; pay the others under Payouts → Pay manually'
          : 'Stripe-paid ones go out in the next payout run; pay the others under Payouts → Pay manually';
  // Partner addresses live in auth.users: one lookup per visible row (at most one page, 10 at a time).
  // The built-in terms are in use while no English page replaces them (French falls back to it).
  const builtInTermsInUse = !settings.termsUrlEn;
  const [emails, emailSubject, termsIdentity] = await Promise.all([
    loadAffiliatePartnerEmails(db, partners.rows.map((partner) => partner.userId)),
    getAffiliatePartnerEmailSubject(),
    builtInTermsInUse ? loadAffiliateTermsOperatorIdentity('') : Promise.resolve(null),
  ]);
  // Their Contact section is left out without a support email: the program settings say so.
  const termsContactMissing = Boolean(termsIdentity?.settingsRead && !termsIdentity.contactEmail);
  // The public sandbox: a tour above the overview, and the shared demo partners locked.
  const isSandbox = process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';
  const money = (cents: number) => formatAdminMoney(cents, metrics.baseCurrency);
  const tierOptions = buildPartnerTierOptions(tiers);
  const hasFilters = Boolean(filters.search || filters.status || filters.tierId);
  const funnelBase = Math.max(1, metrics.partners.total);
  const siteUrl = resolveSiteUrl();
  const cronUrl = `${siteUrl}/api/affiliates/cron/payouts`;
  // Presence only (the value never leaves the server): the route refuses secrets under 16 characters.
  const cronSecretLength = process.env.CRON_SECRET?.trim().length ?? 0;
  const scheduleCommand = `npm run affiliates:schedule-payouts -- ${siteUrl}`;
  const unresolved = activity.filter((item) => !item.isResolved).length;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-8">
      <AffiliatesSubnav active="overview" pendingApprovals={metrics.pendingApprovals} />
      <AffiliatePageHeading
        title="Affiliate program"
        description="Partners, storefront approvals and commissions at a glance. Amounts are in the store currency and net of refunds."
      />

      {isSandbox ? <SandboxTourBanner /> : null}

      <section aria-labelledby="affiliate-metrics-heading" className="space-y-3">
        <h3 id="affiliate-metrics-heading" className="sr-only">
          Program numbers
        </h3>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <AffiliateMetricTile
            label="Partners"
            value={formatAdminCount(metrics.partners.total)}
            hint={`${formatAdminCount(metrics.partners.active)} active · ${formatAdminCount(metrics.partners.suspended)} paused`}
            icon={<Users className="h-5 w-5" />}
          />
          <AffiliateMetricTile
            label="Live storefronts"
            value={formatAdminCount(metrics.liveStorefronts)}
            hint={`${formatAdminCount(metrics.partners.approved)} ${metrics.partners.approved === 1 ? 'partner' : 'partners'} approved to earn`}
            icon={<Store className="h-5 w-5" />}
          />
          <AffiliateMetricTile
            label="Pending approvals"
            value={formatAdminCount(metrics.pendingApprovals)}
            hint="Storefronts waiting for your review"
            icon={<ClipboardCheck className="h-5 w-5" />}
            footer={
              metrics.pendingApprovals > 0 ? (
                <Link
                  href={AFFILIATE_CMS_APPROVALS_PATH}
                  className="text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  Review storefronts
                </Link>
              ) : null
            }
          />
          <AffiliateMetricTile
            label="Clicks"
            value={formatAdminCount(metrics.clicks)}
            hint="Unique referral visits (one per visitor per day)"
            icon={<MousePointerClick className="h-5 w-5" />}
          />
          <AffiliateMetricTile
            label="Pending clearance"
            value={money(metrics.pendingClearanceCents)}
            hint="Inside the refund-protection hold"
            icon={<Hourglass className="h-5 w-5" />}
          />
          <AffiliateMetricTile
            label="Cleared, awaiting payout"
            value={money(metrics.clearedCents)}
            hint={
              metrics.processingCents > 0
                ? `${money(metrics.processingCents)} more is in a payout right now`
                : clearedHint
            }
            icon={<CircleDollarSign className="h-5 w-5" />}
          />
          <AffiliateMetricTile
            label="Paid out"
            value={money(metrics.paidLifetimeCents)}
            hint="Lifetime, every completed payout (Stripe transfers and payouts recorded manually)"
            icon={<Banknote className="h-5 w-5" />}
          />
          <div className="rounded-lg border border-border bg-card p-4 text-card-foreground shadow-sm">
            <p className="text-sm font-medium text-muted-foreground">Onboarding</p>
            <ul className="mt-3 space-y-2">
              {AFFILIATE_ONBOARDING_STEPS.map((step) => {
                const count = metrics.steps[step];
                const percent = Math.round((count / funnelBase) * 100);
                return (
                  <li key={step} className="space-y-1">
                    <div className="flex justify-between gap-2 text-xs">
                      <span className="text-foreground">{AFFILIATE_ONBOARDING_STEP_LABEL[step]}</span>
                      <span className="tabular-nums text-muted-foreground">{formatAdminCount(count)}</span>
                    </div>
                    <Progress
                      value={percent}
                      className="h-1.5"
                      aria-label={`${AFFILIATE_ONBOARDING_STEP_LABEL[step]}: ${count} of ${metrics.partners.total} partners`}
                    />
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
        {metrics.otherCurrencies.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            Also open in other currencies (recorded before the store currency changed):{' '}
            {metrics.otherCurrencies
              .map(
                (entry) =>
                  `${entry.currency}: ${formatAdminMoney(entry.pendingCents, entry.currency)} pending, ${formatAdminMoney(
                    entry.clearedCents + entry.processingCents,
                    entry.currency
                  )} cleared`
              )
              .join('; ')}
            .
          </p>
        ) : null}
        {metrics.truncated ? (
          <p className="text-xs text-amber-800 dark:text-amber-300">
            The program is larger than one overview scan, so these totals are a lower bound.
          </p>
        ) : null}
      </section>

      <div className="grid gap-8 xl:grid-cols-3">
        <section aria-labelledby="affiliate-partners-heading" className="space-y-4 xl:col-span-2">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h3 id="affiliate-partners-heading" className="text-lg font-semibold text-foreground">
              Partners
            </h3>
            <p className="text-sm text-muted-foreground">
              {formatAdminCount(partners.total)} {partners.total === 1 ? 'partner' : 'partners'}
              {hasFilters ? ' match' : ''}
            </p>
          </div>

          <form method="get" action={AFFILIATE_CMS_PATH} role="search" aria-label="Filter partners" className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="affiliate-partner-search">Search</Label>
              <Input
                id="affiliate-partner-search"
                name="q"
                type="search"
                maxLength={80}
                defaultValue={filters.search}
                placeholder="Handle or display name"
                aria-describedby="affiliate-partner-search-help"
              />
              <p id="affiliate-partner-search-help" className="text-xs text-muted-foreground">
                A single word searches handles; anything with spaces or symbols searches display names.
              </p>
            </div>
            <div className="space-y-1.5 self-start">
              <Label htmlFor="affiliate-partner-status">Status</Label>
              <select id="affiliate-partner-status" name="status" defaultValue={filters.status ?? ''} className={SELECT_CLASS}>
                <option value="">All statuses</option>
                <option value="ACTIVE">Active</option>
                <option value="SUSPENDED">Paused</option>
              </select>
            </div>
            <div className="space-y-1.5 self-start">
              <Label htmlFor="affiliate-partner-tier">Tier</Label>
              <select id="affiliate-partner-tier" name="tier" defaultValue={filters.tierId ?? ''} className={SELECT_CLASS}>
                <option value="">All tiers</option>
                {tiers.map((tier) => (
                  <option key={tier.id} value={tier.id}>
                    {tier.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex gap-2 self-start sm:pt-6">
              <Button type="submit" variant="outline">
                Apply
              </Button>
              {hasFilters ? (
                <Button asChild variant="ghost">
                  <Link href={AFFILIATE_CMS_PATH}>Clear</Link>
                </Button>
              ) : null}
            </div>
          </form>

          {isSandbox ? <PartnersLockedNote /> : null}

          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[60rem] text-left text-sm">
                <caption className="sr-only">Affiliate partners</caption>
                <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-medium">Partner</th>
                    <th scope="col" className="px-4 py-3 font-medium">Tier</th>
                    <th scope="col" className="px-4 py-3 font-medium">Status</th>
                    <th scope="col" className="px-4 py-3 font-medium">Storefront</th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">Clicks</th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">Earned / paid</th>
                    <th scope="col" className="px-4 py-3 font-medium">Joined</th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {partners.rows.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-4 py-10 text-center text-muted-foreground">
                        {hasFilters ? 'No partner matches these filters.' : 'No partners yet. They sign up on the /partners page.'}
                      </td>
                    </tr>
                  ) : (
                    partners.rows.map((partner) => (
                      <tr key={partner.id} className="align-top">
                        <td className="px-4 py-3">
                          <p className="font-medium text-foreground">{partner.displayName}</p>
                          <p className="text-xs text-muted-foreground">@{partner.handle}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {AFFILIATE_ONBOARDING_STEP_LABEL[partner.onboardingStep]}
                            {partner.payoutsReady ? ' · Stripe connected' : ''}
                          </p>
                          <div className="mt-2">
                            <PartnerEmailActions email={emails[partner.userId]} subject={emailSubject} handle={partner.handle} />
                          </div>
                          {partner.status === 'SUSPENDED' && partner.suspendedReason ? (
                            <p className="mt-1 max-w-xs whitespace-pre-line text-xs text-red-800 dark:text-red-300">
                              {partner.suspendedReason}
                            </p>
                          ) : null}
                        </td>
                        <td className="px-4 py-3">
                          <AffiliateTierBadge name={partner.tierName} color={partner.tierBadgeColor} />
                          <p className="mt-1 whitespace-nowrap text-xs text-muted-foreground">
                            Tier since {formatAdminDate(partner.tierSince)}
                          </p>
                        </td>
                        <td className="px-4 py-3">
                          <AffiliatePartnerStatusBadge status={partner.status} />
                          {!partner.isApproved ? <p className="mt-1 text-xs text-muted-foreground">Not approved yet</p> : null}
                        </td>
                        <td className="px-4 py-3">
                          {/* A paused partner's storefront is offline (the storefront RPC serves ACTIVE partners only). */}
                          {partner.status === 'SUSPENDED' && partner.pageStatus === 'PUBLISHED' ? (
                            <AffiliateStorefrontStateBadge state="paused" />
                          ) : partner.pageStatus ? (
                            <AffiliatePageStatusBadge status={partner.pageStatus} />
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                          {partner.hasPublishedPage && partner.pageStatus !== 'PUBLISHED' ? (
                            <p className="mt-1 text-xs text-muted-foreground">
                              {partner.status === 'SUSPENDED'
                                ? 'The approved version is offline while they are paused'
                                : 'An approved version is live'}
                            </p>
                          ) : null}
                          {/* Every partner has a page from signup on: its review page holds the Partner card (Remove partner). */}
                          {partner.pageId ? (
                            <p className="mt-1">
                              <Link
                                href={`${AFFILIATE_CMS_APPROVALS_PATH}/${partner.pageId}`}
                                aria-label={`${partner.pageStatus === 'PENDING_REVIEW' ? 'Review now' : 'Open review'} for @${partner.handle}`}
                                className="text-xs font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                              >
                                {partner.pageStatus === 'PENDING_REVIEW' ? 'Review now' : 'Open review'}
                              </Link>
                            </p>
                          ) : null}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">{formatAdminCount(partner.totalClicks)}</td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          <p>{money(partner.totalEarnedCents)}</p>
                          <p className="text-xs text-muted-foreground">{money(partner.totalPaidCents)} paid</p>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{formatAdminDate(partner.createdAt)}</td>
                        <td className="px-4 py-3">
                          <PartnerRowActions
                            affiliateId={partner.id}
                            handle={partner.handle}
                            displayName={partner.displayName}
                            status={partner.status}
                            isApproved={partner.isApproved}
                            tierId={partner.tierId}
                            tiers={tierOptions}
                            lockedNoteId={isSandbox ? PARTNERS_LOCKED_NOTE_ID : undefined}
                          />
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <TablePagination
              currentPage={filters.page}
              pageSize={filters.pageSize}
              totalCount={partners.total}
              basePath={AFFILIATE_CMS_PATH}
              itemLabel="partners"
            />
          </div>
        </section>

        <section aria-labelledby="affiliate-activity-heading" className="space-y-4">
          <div className="flex items-end justify-between gap-3">
            <h3 id="affiliate-activity-heading" className="text-lg font-semibold text-foreground">
              Activity
            </h3>
            <p className="text-sm text-muted-foreground">{unresolved > 0 ? `${unresolved} to act on` : 'All caught up'}</p>
          </div>
          <div className="rounded-lg border border-border bg-card">
            {activity.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">
                Signups, completed profiles, submitted storefronts and payout problems appear here.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {activity.map((item) => {
                  const href = activityHref(item);
                  return (
                    <li key={item.id} className="flex items-start gap-3 p-4">
                      <span
                        className={
                          item.isResolved
                            ? 'mt-1.5 h-2 w-2 shrink-0 rounded-full bg-slate-300 dark:bg-slate-600'
                            : 'mt-1.5 h-2 w-2 shrink-0 rounded-full bg-amber-500'
                        }
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1 space-y-1">
                        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          {stripeAlertLabel(item) ?? AFFILIATE_ALERT_TYPE_LABEL[item.alertType] ?? 'Affiliate event'}
                          <span className="sr-only">{item.isResolved ? ', done' : ', open'}</span>
                        </p>
                        <p className="text-sm font-medium text-foreground">
                          {href ? (
                            <Link href={href} className="underline-offset-4 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring">
                              {item.title}
                            </Link>
                          ) : (
                            item.title
                          )}
                        </p>
                        <p className="break-words text-xs text-muted-foreground">{item.message}</p>
                        <p className="text-xs text-muted-foreground">
                          <time dateTime={item.createdAt} title={formatAdminDateTime(item.createdAt)}>
                            {formatAdminRelative(item.createdAt)}
                          </time>
                        </p>
                      </div>
                      {item.isResolved ? null : <ResolveAlertButton alertId={item.id} title={item.title} />}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>
      </div>

      <section aria-labelledby="affiliate-settings-heading" className="grid gap-6 rounded-lg border border-border bg-card p-6 text-card-foreground shadow-sm lg:grid-cols-2">
        <div className="space-y-4">
          <div className="space-y-1">
            <h3 id="affiliate-settings-heading" className="text-lg font-semibold text-foreground">
              Program settings
            </h3>
            <p className="text-sm text-muted-foreground">Who hears about partner activity, and how payouts run.</p>
          </div>
          <ProgramSettingsForm
            // Remount with the saved (normalized) values after a save refreshes the page.
            key={`${settings.notificationEmails.join(',')}|${settings.minPayoutCents}|${settings.autoPayoutsEnabled}|${settings.termsUrlEn}|${settings.termsUrlFr}|${payoutMethods.stripeSales}|${payoutMethods.freemiusSales}`}
            notificationEmails={settings.notificationEmails}
            minPayoutCents={settings.minPayoutCents}
            autoPayoutsEnabled={settings.autoPayoutsEnabled}
            payoutMethods={payoutMethods}
            termsUrlEn={settings.termsUrlEn}
            termsUrlFr={settings.termsUrlFr}
            termsContactMissing={termsContactMissing}
            currency={metrics.baseCurrency}
            currencyFactor={getCurrencyMinorUnitFactor(metrics.baseCurrency)}
            minAllowedCents={AFFILIATES_SETTINGS_LIMITS.minPayoutCents}
            maxAllowedCents={AFFILIATES_SETTINGS_LIMITS.maxPayoutCents}
          />
        </div>
        <div className="space-y-4 text-sm">
          <h4 className="text-base font-semibold text-foreground">Scheduling payouts</h4>
          <p className="text-muted-foreground">
            Payouts run once a day. With nothing else set up, the run starts in the background the first time someone opens
            the CMS or the partner portal that day. For a fixed time, call the payout endpoint daily from a scheduler.
          </p>
          <div className="space-y-1.5">
            <p className="font-medium text-foreground">Payout endpoint</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-xs text-foreground">
                {cronUrl}
              </code>
              <CopyTextButton value={cronUrl} label="Copy the payout endpoint URL" />
            </div>
            <p className="text-xs text-muted-foreground">
              Send GET or POST with the header <code className="font-mono">Authorization: Bearer &lt;CRON_SECRET&gt;</code>.{' '}
              {cronSecretLength >= 16
                ? 'CRON_SECRET is set on this deployment.'
                : cronSecretLength > 0
                  ? 'CRON_SECRET is shorter than 16 characters, so the endpoint refuses every call: use a longer secret.'
                  : 'CRON_SECRET is not set on this deployment, so the endpoint refuses every call: add it to the environment first.'}
            </p>
          </div>
          <div className="space-y-1.5">
            <p className="font-medium text-foreground">Supabase pg_cron</p>
            <p className="text-xs text-muted-foreground">
              On Supabase, a pg_cron job can call the endpoint through pg_net, with the secret kept in Vault. From a checkout of
              the project, with <code className="font-mono">CRON_SECRET</code> and{' '}
              <code className="font-mono">POSTGRES_URL_NON_POOLING</code> in <code className="font-mono">.env.local</code>, run:
            </p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-xs text-foreground">
                {scheduleCommand}
              </code>
              <CopyTextButton value={scheduleCommand} label="Copy the pg_cron install command" />
            </div>
            <p className="text-xs text-muted-foreground">
              It installs one job, daily at 06:00 UTC. Add <code className="font-mono">print-sql</code> to get SQL for the Supabase
              SQL editor instead. Vercel crons are not used: they make Hobby deployments fail.
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            Minimum payout now: {formatAdminMoney(settings.minPayoutCents, metrics.baseCurrency)}. Automated payouts are{' '}
            {settings.autoPayoutsEnabled ? 'on' : 'off'}.
          </p>
        </div>
      </section>
    </div>
  );
}
