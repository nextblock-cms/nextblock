import 'katex/dist/katex.min.css';
import { redirect } from 'next/navigation';
import { after } from 'next/server';
import CmsClientLayout from "./CmsClientLayout";
import { verifyPackageOnline, createClient } from '@nextblock-cms/db/server';
import { evaluateTwoFactor, getStaffTwoFactorReminder } from '../../lib/auth/twoFactor';
import { maybeRefreshUpstreamStatus } from '../../lib/updates/check-upstream';
import { maybeRevalidatePackageActivations } from '../../lib/packages/revalidate-activations';
import { getPaymentsReminder } from '../../lib/cms/payments-reminder';
import { getUnreadMessageCount } from '../../lib/cms/unread-messages';
import { getContactReminder } from '../../lib/cms/contact-reminder';
import { maybeSyncCurrencyRates } from '../../lib/commerce/currency-rates-refresh';
import { getCortexChatStatus } from '../../lib/cortex-ai/site-brief-status';
import type { SystemAlertItem } from './components/SystemAlertsBanner';

/**
 * Unresolved system alerts for the dashboard banner. Runs as the signed-in user, so the
 * system_alerts SELECT RLS policy returns rows only for ADMINs (WRITERs get an empty
 * list). Best-effort: any failure (e.g. the table not yet migrated) yields no banner.
 */
async function getUnresolvedSystemAlerts(): Promise<SystemAlertItem[]> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from('system_alerts')
      .select('id, alert_type, title, message, metadata')
      .eq('is_resolved', false)
      .in('alert_type', ['merge_conflict', 'runtime_update_available'])
      .order('created_at', { ascending: false })
      .limit(20);
    if (error || !data) return [];
    return data.map((a) => ({
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

  const supabaseForRole = createClient();
  const {
    data: { user: cmsUser },
  } = await supabaseForRole.auth.getUser();
  const { data: cmsProfile } = cmsUser
    ? await supabaseForRole.from('profiles').select('role').eq('id', cmsUser.id).maybeSingle()
    : { data: null };
  const isAdmin = cmsProfile?.role === 'ADMIN';

  const [
    isEcommerceActive,
    isCortexAiActive,
    showTwoFactorReminder,
    systemAlerts,
    paymentsReminder,
    messagesUnread,
    contactReminder,
  ] =
    await Promise.all([
      verifyPackageOnline('ecommerce'),
      verifyPackageOnline('cortex-ai'),
      getStaffTwoFactorReminder(),
      getUnresolvedSystemAlerts(),
      // Re-checks ecommerce activation itself; verifyPackageOnline is unstable_cache'd
      // for 60s, so the second call costs nothing.
      getPaymentsReminder(),
      getUnreadMessageCount(isAdmin),
      isAdmin ? getContactReminder() : Promise.resolve(null),
    ]);

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

  return (
    <CmsClientLayout
      isCortexAiActive={isCortexAiActive}
      hasCortexModelKey={hasCortexModelKey}
      hasCortexSiteBrief={hasCortexSiteBrief}
      isEcommerceActive={isEcommerceActive}
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
