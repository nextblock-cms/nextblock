import 'server-only';

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AFFILIATE_PARTNERS_PATH, AFFILIATE_PORTAL_STOREFRONT_PATH } from '@nextblock-cms/affiliates';
import { verifyPackageOnline } from '@nextblock-cms/db/server';

import { loadRetailerStudioData, readRetailerPortalAccount } from '../../../../../lib/affiliates/portal-data';
import { getRequestLocale, toAffiliatesLocale } from '../../../../../lib/affiliates/request-locale';
import { requireRetailerPage } from '../../../../../lib/affiliates/retailer-actor';
import { PortalNotice } from '../components/PortalNotice';
import { StorefrontStudio } from '../components/StorefrontStudio';
import { getPortalServerCopy } from '../components/portal-server-copy';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getPortalServerCopy();
  return { title: t('affiliates.portal.studio_meta_title') };
}

/**
 * The copilot route (/api/affiliates/cortex) refuses every message while the site's Cortex AI
 * package is inactive, so the studio disables the panel up front. A failed check counts as
 * inactive.
 */
async function isCortexAiActive(): Promise<boolean> {
  try {
    return await verifyPackageOnline('cortex-ai');
  } catch {
    return false;
  }
}

/**
 * The storefront studio. The stored draft is sanitized here before it reaches the editor (it is
 * untrusted JSON: an RTL session may PATCH it over the Data API), and the image origins are
 * computed on the server (ADDENDUM C14) and passed down, as is whether the copilot is available.
 */
export default async function RetailerStorefrontStudioPage() {
  const ctx = await requireRetailerPage(AFFILIATE_PORTAL_STOREFRONT_PATH, { allowSuspended: true });
  const account = readRetailerPortalAccount(ctx.actor);
  if (!account) notFound();
  const { profile, page } = account;

  const requestLocale = await getRequestLocale();
  const locale = toAffiliatesLocale(requestLocale);
  const [t, data, cortexAiActive] = await Promise.all([
    getPortalServerCopy(requestLocale),
    loadRetailerStudioData(account, locale),
    isCortexAiActive(),
  ]);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">{t('affiliates.portal.studio_title')}</h1>
        <p className="max-w-3xl text-muted-foreground">{t('affiliates.portal.studio_description')}</p>
        {data.isLive ? (
          <p className="text-sm text-muted-foreground">
            {t('affiliates.portal.studio_live_at')}{' '}
            <Link
              href={`${AFFILIATE_PARTNERS_PATH}/${profile.handle}`}
              prefetch={false}
              target="_blank"
              rel="noopener"
              className="rounded-sm font-medium text-primary underline underline-offset-4 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              translate="no"
            >
              {data.storefrontUrl}
              <span className="sr-only"> {t('affiliates.portal.opens_new_tab')}</span>
            </Link>
          </p>
        ) : null}
      </header>

      {page ? (
        <StorefrontStudio
          key={page.id}
          siteOrigin={data.siteOrigin}
          allowedImageOrigins={data.allowedImageOrigins}
          suspended={profile.status !== 'ACTIVE'}
          isLive={data.isLive}
          profile={{
            displayName: profile.display_name,
            bio: profile.bio ?? '',
            socialLinks: profile.social_links,
            preferredLocale: profile.preferred_locale === 'fr' ? 'fr' : 'en',
          }}
          avatarUrl={data.avatarUrl}
          page={{
            title: page.title,
            metaDescription: page.meta_description,
            doc: data.draftDoc,
            featuredProductIds: page.featured_product_ids,
            featuredProducts: data.featuredProducts,
            draftVersion: page.draft_version,
            approvalStatus: page.approval_status,
            adminFeedbackNote: page.admin_feedback_note,
          }}
          profileChangedSincePublish={data.profileChangedSincePublish}
          copilotUnavailableReason={cortexAiActive ? null : t('affiliates.portal.copilot_unavailable')}
        />
      ) : (
        <PortalNotice tone="danger" title={t('affiliates.portal.studio_missing_title')}>
          <p>{t('affiliates.portal.studio_missing_body')}</p>
        </PortalNotice>
      )}
    </div>
  );
}
