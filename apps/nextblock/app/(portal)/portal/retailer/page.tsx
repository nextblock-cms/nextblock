import 'server-only';

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  AFFILIATE_DEFAULT_CLEARANCE_DAYS,
  AFFILIATE_PORTAL_PATH,
  AFFILIATE_PORTAL_PAYOUTS_PATH,
  AFFILIATE_PORTAL_STOREFRONT_PATH,
  affiliateTierDisplayName,
} from '@nextblock-cms/affiliates';

import { loadRetailerOverviewData, readRetailerPortalAccount } from '../../../../lib/affiliates/portal-data';
import { getRequestLocale, toAffiliatesLocale } from '../../../../lib/affiliates/request-locale';
import { requireRetailerPage } from '../../../../lib/affiliates/retailer-actor';
import { CommissionsTable } from './components/LedgerTables';
import { OnboardingSteps } from './components/OnboardingSteps';
import { PortalNotice, PORTAL_NOTICE_LINK_CLASS } from './components/PortalNotice';
import { PortalStat } from './components/PortalStat';
import { ShareTools } from './components/ShareTools';
import { formatPortalDate, formatPortalMoney, formatPortalNumber, formatPortalPercent } from './components/portal-format';
import { getPortalServerCopy } from './components/portal-server-copy';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getPortalServerCopy();
  return { title: t('affiliates.portal.overview_meta_title') };
}

type PortalSearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function RetailerPortalOverviewPage({ searchParams }: { searchParams: PortalSearchParams }) {
  const ctx = await requireRetailerPage(AFFILIATE_PORTAL_PATH, { allowSuspended: true });
  const account = readRetailerPortalAccount(ctx.actor);
  if (!account) notFound();
  const { profile, page } = account;

  const [params, requestLocale] = await Promise.all([searchParams, getRequestLocale()]);
  const locale = toAffiliatesLocale(requestLocale);
  const [t, data] = await Promise.all([getPortalServerCopy(requestLocale), loadRetailerOverviewData(ctx, account)]);

  const suspended = profile.status !== 'ACTIVE';
  const welcome = params['welcome'] === '1' || data.progress.completedCount <= 1;
  const tierName = data.tier ? affiliateTierDisplayName(data.tier, locale) : null;
  const tierRate = data.tier ? formatPortalPercent(data.tier.commission_percentage, locale) : null;
  // In this tier since the last move (02035 stamps tier_changed_at), else since sign-up.
  const tierSince = formatPortalDate(profile.tier_changed_at ?? profile.created_at, locale);
  const holdDays = data.tier?.clearance_hold_days ?? AFFILIATE_DEFAULT_CLEARANCE_DAYS;
  const balance = data.balances.primary;
  const money = (amount: number) => formatPortalMoney(amount, balance.currency, locale);
  const status = page?.approval_status ?? 'DRAFT';

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">{t('affiliates.portal.overview_title')}</h1>
        <p className="text-muted-foreground">{t('affiliates.portal.overview_greeting', { name: profile.display_name })}</p>
        {tierName && tierRate ? (
          <p className="text-sm text-muted-foreground">{t('affiliates.portal.overview_tier', { tier: tierName, rate: tierRate })}</p>
        ) : null}
        {tierName && tierSince ? (
          <p className="text-sm text-muted-foreground">{t('affiliates.portal.overview_tier_since', { date: tierSince })}</p>
        ) : null}
      </header>

      <div className="space-y-4">
        {welcome && !suspended ? (
          <PortalNotice tone="success" title={t('affiliates.portal.welcome_title', { name: profile.display_name })}>
            <p>{t('affiliates.portal.welcome_body')}</p>
          </PortalNotice>
        ) : null}

        {!suspended && status === 'CHANGES_REQUESTED' ? (
          <PortalNotice
            tone="warning"
            title={t('affiliates.portal.banner_changes_title')}
            action={
              <Link href={AFFILIATE_PORTAL_STOREFRONT_PATH} prefetch={false} className={PORTAL_NOTICE_LINK_CLASS}>
                {t('affiliates.portal.banner_changes_action')}
              </Link>
            }
          >
            <p>{t('affiliates.portal.banner_changes_body')}</p>
            {page?.admin_feedback_note ? (
              <blockquote className="whitespace-pre-line border-l-4 border-current pl-3 italic">{page.admin_feedback_note}</blockquote>
            ) : null}
          </PortalNotice>
        ) : null}

        {!suspended && status === 'PENDING_REVIEW' ? (
          <PortalNotice
            tone="info"
            title={data.isApproved ? t('affiliates.portal.banner_review_update_title') : t('affiliates.portal.banner_review_title')}
          >
            <p>{data.isApproved ? t('affiliates.portal.banner_review_update_body') : t('affiliates.portal.banner_review_body')}</p>
          </PortalNotice>
        ) : null}

        {!suspended && !data.isApproved && status !== 'PENDING_REVIEW' ? (
          <PortalNotice
            tone="info"
            title={t('affiliates.portal.banner_not_approved_title')}
            action={
              <Link href={AFFILIATE_PORTAL_STOREFRONT_PATH} prefetch={false} className={PORTAL_NOTICE_LINK_CLASS}>
                {t('affiliates.portal.banner_not_approved_action')}
              </Link>
            }
          >
            <p>{t('affiliates.portal.banner_not_approved_body')}</p>
          </PortalNotice>
        ) : null}

        {data.ledgerError ? (
          <PortalNotice tone="warning" title={t('affiliates.portal.ledger_error_title')}>
            <p>{t('affiliates.portal.ledger_error_body')}</p>
          </PortalNotice>
        ) : null}
      </div>

      <OnboardingSteps progress={data.progress} t={t} />

      <section aria-labelledby="portal-stats-heading" className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="portal-stats-heading" className="text-lg font-semibold text-foreground">
            {t('affiliates.portal.stats_title')}
          </h2>
          <Link
            href={AFFILIATE_PORTAL_PAYOUTS_PATH}
            prefetch={false}
            className="rounded-sm text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {t('affiliates.portal.stats_payouts_link')}
          </Link>
        </div>
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <PortalStat
            label={t('affiliates.portal.stats_clicks')}
            value={formatPortalNumber(profile.total_clicks, locale)}
            hint={t('affiliates.portal.stats_clicks_hint')}
          />
          <PortalStat
            label={t('affiliates.portal.stats_pending', { days: holdDays })}
            value={money(balance.pendingCents)}
            hint={t('affiliates.portal.stats_pending_hint')}
          />
          <PortalStat
            label={t('affiliates.portal.stats_cleared')}
            value={money(balance.clearedCents + balance.processingCents)}
            hint={t('affiliates.portal.stats_cleared_hint')}
          />
          <PortalStat label={t('affiliates.portal.stats_paid')} value={money(balance.paidCents)} />
        </dl>
      </section>

      <ShareTools
        handle={profile.handle}
        siteOrigin={data.siteOrigin}
        storefrontUrl={data.storefrontUrl}
        isLive={data.isLive}
        isApproved={data.isApproved}
      />

      <section aria-labelledby="portal-recent-heading" className="space-y-4">
        <h2 id="portal-recent-heading" className="text-lg font-semibold text-foreground">
          {t('affiliates.portal.recent_title')}
        </h2>
        {data.recentCommissions.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-card p-6 text-sm text-muted-foreground">
            {t('affiliates.portal.recent_empty')}
          </p>
        ) : (
          <CommissionsTable rows={data.recentCommissions} t={t} locale={locale} caption={t('affiliates.portal.recent_title')} compact />
        )}
      </section>
    </div>
  );
}
