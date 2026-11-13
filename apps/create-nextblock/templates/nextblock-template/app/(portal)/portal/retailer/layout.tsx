import 'server-only';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { after } from 'next/server';
import { AFFILIATE_PARTNERS_PATH, AffiliatesCopyProvider } from '@nextblock-cms/affiliates';

import { maybeRunAffiliatePayouts } from '../../../../lib/affiliates/payout-runner';
import { buildAffiliatePortalReturnPath } from '../../../../lib/affiliates/portal-return-path';
import { readRetailerPortalAccount, resolveAffiliateAvatarUrl } from '../../../../lib/affiliates/portal-data';
import { getRequestLocale } from '../../../../lib/affiliates/request-locale';
import { requireRetailerPage } from '../../../../lib/affiliates/retailer-actor';
import { getAffiliateCopyOverrides } from '../../../../lib/affiliates/server-copy';
import { PortalNav } from './components/PortalNav';
import { PortalNotice } from './components/PortalNotice';
import { PORTAL_PROVIDER_COPY } from './components/portal-copy';
import { getPortalServerCopy } from './components/portal-server-copy';

/**
 * The partner portal shell (`/portal/retailer/**`): partners only (`requireRetailerPage`: session,
 * second factor, RTL role with an affiliate account, package active). A suspended partner still
 * gets in, read-only, with the suspension notice; every action refuses them.
 *
 * Copy: the root layout keeps `affiliates.*` rows out of the global translations payload, so this
 * layout loads the operator overrides for exactly the areas rendered below it (common, portal,
 * sandbox, editor, copilot) and mounts `AffiliatesCopyProvider` for the client islands.
 *
 * On the public sandbox every visitor signs in as the same seeded demo partner, so the shell says
 * so above every page, and names the demo admin login that approves a submitted page.
 */

export const dynamic = 'force-dynamic';

/**
 * The public sandbox's admin login (listed on /sign-in; the reviewer of the demo partner's page in
 * app/api/cron/reset-sandbox/affiliate-demo.ts). A literal, as in SandboxCredentialsAlert.
 */
const SANDBOX_DEMO_ADMIN_EMAIL = 'demo@nextblock.dev';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getPortalServerCopy();
  return {
    title: t('affiliates.portal.meta_title'),
    robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  };
}

export default async function RetailerPortalLayout({ children }: { children: ReactNode }) {
  // On a full page load this layout's redirect is the one that answers (it renders before the page
  // segment), so it sends a signed-out partner back to the page and query they asked for (an
  // email's deep link, a Stripe Connect landing), taken from the proxy's request headers.
  const requestHeaders = await headers();
  const returnPath = buildAffiliatePortalReturnPath(
    requestHeaders.get('x-nextblock-path'),
    requestHeaders.get('x-nextblock-search'),
  );
  const { actor } = await requireRetailerPage(returnPath, { allowSuspended: true });
  const account = readRetailerPortalAccount(actor);
  if (!account) notFound();
  const { profile, page } = account;

  const locale = await getRequestLocale();
  const [overrides, t] = await Promise.all([
    getAffiliateCopyOverrides({ locale, dictionary: PORTAL_PROVIDER_COPY }),
    getPortalServerCopy(locale),
  ]);

  // The daily payout cycle's fallback trigger (claims the UTC day in the database, so it runs once).
  after(async () => {
    try {
      await maybeRunAffiliatePayouts(true);
    } catch (error) {
      console.warn('[affiliates] Payout fallback run failed:', error instanceof Error ? error.message : String(error));
    }
  });

  const suspended = profile.status !== 'ACTIVE';
  const sandbox = process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';
  const isLive = !suspended && Boolean(profile.first_published_at) && page?.published_content != null;
  const avatarUrl = resolveAffiliateAvatarUrl(profile.avatar_object_key);
  const initial = profile.display_name.trim().charAt(0).toUpperCase() || '?';

  return (
    <AffiliatesCopyProvider locale={locale} overrides={overrides}>
      <div className="mx-auto w-full max-w-6xl px-4 py-8 md:px-6 md:py-10">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- storage-hosted partner avatar (any configured media host)
              <img
                src={avatarUrl}
                alt=""
                width={40}
                height={40}
                decoding="async"
                className="h-10 w-10 shrink-0 rounded-full border border-border object-cover"
              />
            ) : (
              <span
                aria-hidden="true"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-sm font-semibold text-foreground"
              >
                {initial}
              </span>
            )}
            <div className="min-w-0">
              <p className="text-sm font-medium text-muted-foreground">{t('affiliates.portal.shell_eyebrow')}</p>
              <p className="truncate text-lg font-semibold text-foreground">{profile.display_name}</p>
            </div>
          </div>
          {isLive ? (
            <Link
              href={`${AFFILIATE_PARTNERS_PATH}/${profile.handle}`}
              prefetch={false}
              target="_blank"
              rel="noopener"
              className="inline-flex min-h-10 items-center rounded-md border border-input bg-background px-4 text-sm font-medium text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {t('affiliates.portal.view_storefront')}
              <span className="sr-only"> {t('affiliates.portal.opens_new_tab')}</span>
            </Link>
          ) : null}
        </div>

        <PortalNav />

        {sandbox ? (
          <PortalNotice tone="info" title={t('affiliates.sandbox.portal_notice_title')} className="mt-6">
            <p>{t('affiliates.sandbox.portal_notice_body', { email: SANDBOX_DEMO_ADMIN_EMAIL })}</p>
          </PortalNotice>
        ) : null}

        {suspended ? (
          <PortalNotice tone="danger" title={t('affiliates.portal.suspended_title')} className="mt-6">
            <p>{t('affiliates.portal.suspended_body')}</p>
            {profile.suspended_reason ? (
              <p className="whitespace-pre-line">{t('affiliates.portal.suspended_reason', { reason: profile.suspended_reason })}</p>
            ) : null}
          </PortalNotice>
        ) : null}

        <div className="mt-8">{children}</div>
      </div>
    </AffiliatesCopyProvider>
  );
}
