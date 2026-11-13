import 'katex/dist/katex.min.css';
import { redirect } from 'next/navigation';
import { after } from 'next/server';
import CmsClientLayout from "./CmsClientLayout";
import { verifyPackageOnline, createClient } from '@nextblock-cms/db/server';
import { getCmsActor } from '../../lib/auth/cms-actor';
import { evaluateTwoFactor, getStaffTwoFactorReminder } from '../../lib/auth/twoFactor';
import { maybeRefreshUpstreamStatus } from '../../lib/updates/check-upstream';
import { maybeRevalidatePackageActivations } from '../../lib/packages/revalidate-activations';
import { getPaymentsReminder } from '../../lib/cms/payments-reminder';
import { getUnreadMessageCount } from '../../lib/cms/unread-messages';
import { getContactReminder } from '../../lib/cms/contact-reminder';
import { maybeSyncCurrencyRates } from '../../lib/commerce/currency-rates-refresh';
import { getCortexChatStatus } from '../../lib/cortex-ai/site-brief-status';
import {
  AFFILIATE_ALERT_TYPES,
  AFFILIATE_BANNER_ALERT_TYPES,
} from '@nextblock-cms/affiliates';
import { getAffiliateApprovalsBadgeCount } from '../../lib/affiliates/admin-data';
import { maybeRunAffiliatePayouts } from '../../lib/affiliates/payout-runner';
import type { SystemAlertItem } from './components/SystemAlertsBanner';
import { isAffiliatesProgramActive } from '../../lib/affiliates/package-state';

/** Developer-facing alert types (update / sync tracks). */
const CORE_BANNER_ALERT_TYPES = ['merge_conflict', 'runtime_update_available'] as const;
/** At most this many affiliate alerts reach the banner; /cms/affiliates lists them all. */
const AFFILIATE_BANNER_LIMIT = 5;
const AFFILIATE_ALERT_TYPE_SET: ReadonlySet<string> = new Set(Object.values(AFFILIATE_ALERT_TYPES));

/**
 * Unresolved system alerts for the dashboard banner. Runs as the signed-in user, so the
 * system_alerts SELECT RLS policy returns rows only for ADMINs (WRITERs get an empty
 * list). Best-effort: any failure (e.g. the table not yet migrated) yields no banner.
 *
 * Affiliate alerts are read separately and capped, so a burst of partner activity can never
 * push an update or merge-conflict alert out of the banner. Only the actionable affiliate
 * types (submitted storefronts, failed payouts, refunds after a payout) are banner-worthy; the
 * informational ones (signups, completed profiles, connected payouts) stay on /cms/affiliates.
 */
async function getUnresolvedSystemAlerts(): Promise<SystemAlertItem[]> {
  try {
    const supabase = createClient();
    const unresolved = (types: readonly string[], limit: number) =>
      supabase
        .from('system_alerts')
        .select('id, alert_type, title, message, metadata')
        .eq('is_resolved', false)
        .in('alert_type', [...types])
        .order('created_at', { ascending: false })
        .limit(limit);
    const [core, affiliate] = await Promise.all([
      unresolved(CORE_BANNER_ALERT_TYPES, 20),
      unresolved(AFFILIATE_BANNER_ALERT_TYPES, AFFILIATE_BANNER_LIMIT),
    ]);
    const rows = [...(core.error ? [] : core.data ?? []), ...(affiliate.error ? [] : affiliate.data ?? [])];
    return rows.map((a) => ({
      id: a.id,
      alert_type: a.alert_type,
      title: a.title,
      message: a.message,
      metadata: (a.metadata ?? null) as Record<string, unknown> | null,
    }));
  } catch {
    return [];
  }
}

export default async function CmsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Enforce any outstanding second factor before rendering the CMS. This guards
  // direct navigation to /cms/* with an aal1 (password-only) session.
  const twoFactor = await evaluateTwoFactor();
  if (twoFactor.status === 'totp_required' || twoFactor.status === 'email_required') {
    redirect('/two-factor?redirect_to=/cms/dashboard');
  }

  // Memoised for the request, so the page and the helpers below that re-check the role
  // (getCortexChatStatus and friends read with the service role; see lib/auth/cms-actor.ts)
  // reuse this lookup instead of each hitting the auth server again.
  const actor = await getCmsActor();
  const isAdmin = actor?.role === 'ADMIN';

  const [
    isEcommerceActive,
    isCortexAiActive,
    isAffiliatesActive,
    showTwoFactorReminder,
    unresolvedAlerts,
    paymentsReminder,
    messagesUnread,
    contactReminder,
    affiliateApprovalsPending,
  ] =
    await Promise.all([
      verifyPackageOnline('ecommerce'),
      verifyPackageOnline('cortex-ai'),
      isAffiliatesProgramActive(),
      getStaffTwoFactorReminder(),
      getUnresolvedSystemAlerts(),
      // Re-checks ecommerce activation itself; verifyPackageOnline is unstable_cache'd
      // for 60s, so the second call costs nothing.
      getPaymentsReminder(),
      getUnreadMessageCount(isAdmin),
      isAdmin ? getContactReminder() : Promise.resolve(null),
      // Sidebar badge for storefronts waiting for review. Verifies the ADMIN and the package
      // itself (both memoised) and answers 0 on any error.
      isAdmin ? getAffiliateApprovalsBadgeCount() : Promise.resolve(0),
    ]);

  // A deactivated Affiliates package keeps its rows; its alerts leave the banner with it.
  const systemAlerts = isAffiliatesActive
    ? unresolvedAlerts
    : unresolvedAlerts.filter((alert) => !AFFILIATE_ALERT_TYPE_SET.has(alert.alert_type));

  // Whether the chat drawer can reach a model at all (without a key it sends the
  // admin to the first-run wizard instead of firing a request that is certain to
  // fail), and whether a site brief is saved (the site builder then opens with the
  // plan instead of the interview). One query for both.
  const { hasModelKey: hasCortexModelKey, hasSiteBrief: hasCortexSiteBrief } =
    isAdmin && isCortexAiActive
      ? await getCortexChatStatus()
      : { hasModelKey: false, hasSiteBrief: false };

  // After the response, refresh upstream update/conflict status in the background
  // (throttled to ~6h, see maybeRefreshUpstreamStatus). This keeps the banner current
  // without a cron — so it works on Vercel Hobby (limited crons) and self-hosted alike.
  after(() => maybeRefreshUpstreamStatus());
  // Same pattern for package licenses: once a day, ask Freemius whether each activated
  // license (a free trial in particular) is still valid, and switch it off when not.
  after(() => maybeRevalidatePackageActivations());
  // And for store FX rates: once a day, when commerce is active and a currency asks for
  // automatic rates. This replaced the daily /api/cron/sync-currencies Vercel cron.
  after(() => maybeSyncCurrencyRates(isEcommerceActive));
  // And for affiliate payouts: the daily run (claimed per day in the database) when the package
  // is active, so payouts happen even where no cron calls /api/affiliates/cron/payouts.
  after(() => maybeRunAffiliatePayouts(isAffiliatesActive));

  return (
    <CmsClientLayout
      isCortexAiActive={isCortexAiActive}
      hasCortexModelKey={hasCortexModelKey}
      hasCortexSiteBrief={hasCortexSiteBrief}
      isEcommerceActive={isEcommerceActive}
      isAffiliatesActive={isAffiliatesActive}
      affiliateApprovalsPending={affiliateApprovalsPending}
      showTwoFactorReminder={showTwoFactorReminder}
      systemAlerts={systemAlerts}
      paymentsReminder={paymentsReminder}
      messagesUnread={messagesUnread}
      contactReminder={contactReminder}
    >
      {children}
    </CmsClientLayout>
  );
}
