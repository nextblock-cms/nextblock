import 'server-only';

import { redirect } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';
import { selectAffiliateSignupTier, type AffiliateTierRow } from '@nextblock-cms/affiliates';
import { requireCmsAdmin } from '../../../../lib/auth/cms-actor';
import {
  getAffiliateApprovalsBadgeCount,
  loadAffiliateTiersAdmin,
  toAffiliateAdminClient,
  type AffiliateTierWarning,
} from '../../../../lib/affiliates/admin-data';
import { AffiliateLoadErrorCard, AffiliatePageHeading } from '../components/AdminCards';
import { AffiliatesSubnav } from '../components/AffiliatesSubnav';
import { TiersManager, type TierManagerRow } from '../components/TiersManager';
import { isAffiliatesProgramActive } from '../../../../lib/affiliates/package-state';

export const metadata = {
  title: 'Affiliate Tiers | NextBlock™ CMS',
};

function toManagerRow(tier: AffiliateTierRow): TierManagerRow {
  // goal / goal_translations (02033) are absent on rows read before that migration ran.
  const goalFr = tier.goal_translations?.['fr'];
  return {
    id: tier.id,
    name: tier.name,
    nameFr: typeof tier.name_translations['fr'] === 'string' ? tier.name_translations['fr'] : '',
    goal: tier.goal ?? '',
    goalFr: typeof goalFr === 'string' ? goalFr : '',
    slug: tier.slug,
    commissionPercentage: tier.commission_percentage,
    cookieDurationDays: tier.cookie_duration_days,
    clearanceHoldDays: tier.clearance_hold_days,
    maxAmbassadorsCap: tier.max_ambassadors_cap,
    memberCount: tier.member_count,
    sortOrder: tier.sort_order,
    badgeColor: tier.badge_color,
    isLimitedTimePromo: tier.is_limited_time_promo,
    isDefaultSignupTier: tier.is_default_signup_tier,
    isActive: tier.is_active,
  };
}

/** Commission tiers: rates, referral windows, refund holds, caps and the signup default. */
export default async function AffiliateTiersPage() {
  const { supabase } = await requireCmsAdmin();
  if (!(await isAffiliatesProgramActive())) {
    redirect('/cms/settings/packages');
  }

  let tiers: AffiliateTierRow[] | null = null;
  let warnings: AffiliateTierWarning[] = [];
  try {
    const loaded = await loadAffiliateTiersAdmin(toAffiliateAdminClient(supabase));
    tiers = loaded.tiers;
    warnings = loaded.warnings;
  } catch (error) {
    console.error('[affiliates] tiers failed to load', {
      code: error && typeof error === 'object' ? (error as { code?: unknown }).code ?? null : null,
    });
  }
  const pendingApprovals = await getAffiliateApprovalsBadgeCount();

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <AffiliatesSubnav active="tiers" pendingApprovals={pendingApprovals} />
      <AffiliatePageHeading
        title="Commission tiers"
        description="Each partner belongs to one tier. Its rate is snapshotted on every commission, so editing a tier only affects orders paid afterwards."
      />

      {tiers === null ? (
        <AffiliateLoadErrorCard what="tiers" />
      ) : (
        <>
          {warnings.length > 0 ? (
            <section aria-labelledby="affiliate-tier-warnings-heading" className="space-y-2">
              <h3 id="affiliate-tier-warnings-heading" className="sr-only">
                Tier configuration warnings
              </h3>
              <ul className="space-y-2">
                {warnings.map((warning) => (
                  <li
                    key={warning.code}
                    className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200"
                  >
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>{warning.message}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {/* The tier a new partner joins: the rule /partners and create_affiliate_account use (active tiers only). */}
          <TiersManager tiers={tiers.map(toManagerRow)} signupTierId={selectAffiliateSignupTier(tiers)?.id ?? null} />
        </>
      )}
    </div>
  );
}
