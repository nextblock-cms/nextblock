import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';
import { affiliateGatewaysPaidByPayPal, type AffiliatePayoutTrigger, type AffiliatesSettings } from '@nextblock-cms/affiliates';
import type { AffiliateRepositoryClient } from '@nextblock-cms/affiliates/server';
import { getSiteSettings } from '../../../app/lib/site-settings';
import { DEFAULT_SITE_TITLE } from '../../../app/lib/seo';
import { resolveAffiliatePayPalCredentials, resolveAffiliatePayPalEnvironment } from './credentials';
import { runAffiliatePayPalPayouts, type AffiliatePayPalHooks, type AffiliatePayPalRunSummary } from './engine';
import { dispatchAffiliatePayPalPayoutEvent, recordAffiliatePayPalAlert } from './events';

/**
 * The PayPal step of every payout run (02037): the daily `after()` fallback, the cron route and "Run
 * payouts now" (lib/affiliates/payout-runner.ts, after their package, settings and sandbox checks),
 * and the CMS "Check PayPal status now" (lib/affiliates/paypal/admin.ts, sync only). It wires
 * {@link runAffiliatePayPalPayouts} to the app: the service-role client, the PayPal credentials of
 * each environment (`credentials.ts`: the CMS first, then the PAYPAL_* environment variables), the
 * site name for PayPal's email to the partner, the payout events (`events.ts`, the notifications
 * hook) and the operator alerts. On the public sandbox it returns null before anything: PayPal is
 * never called and no credential is read there.
 */

type AnyClient = SupabaseClient<any>;

export interface AffiliatePayPalStepInput {
  trigger: AffiliatePayoutTrigger;
  /** The program settings the run read strictly (`readAffiliatesSettingsStrict`). */
  settings: AffiliatesSettings;
  /** Claim and send new PayPal payouts and resend unconfirmed batches; false only checks PayPal. */
  send: boolean;
  timeBudgetMs?: number;
}

async function resolveSiteName(): Promise<string> {
  try {
    const settings = await getSiteSettings();
    return settings?.siteTitle?.trim() || DEFAULT_SITE_TITLE;
  } catch {
    return DEFAULT_SITE_TITLE;
  }
}

/** The app's hooks: events to the notifications, operator alerts to `system_alerts`, problems to the log (codes only). */
export function affiliatePayPalStepHooks(db: AnyClient): AffiliatePayPalHooks {
  return {
    onEvent: (event) => dispatchAffiliatePayPalPayoutEvent(event),
    onAlert: (alert) => recordAffiliatePayPalAlert(db, alert),
    onError: (error) => {
      console.warn(`[affiliates] PayPal ${error.step} problem (${error.code})${error.payoutId ? ` payout ${error.payoutId}` : ''}`);
    },
  };
}

/**
 * One PayPal pass with the app's clients (see the file comment). Null on the public sandbox or when
 * the pass could not start; never throws.
 */
export async function runAffiliatePayPalStep(input: AffiliatePayPalStepInput): Promise<AffiliatePayPalRunSummary | null> {
  if (process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') return null;
  try {
    const db = getServiceRoleSupabaseClient() as unknown as AnyClient;
    const { environment } = await resolveAffiliatePayPalEnvironment();
    return await runAffiliatePayPalPayouts({
      supabase: db as unknown as AffiliateRepositoryClient,
      environment,
      credentialsFor: (target) => resolveAffiliatePayPalCredentials(target),
      trigger: input.trigger,
      gateways: affiliateGatewaysPaidByPayPal(input.settings),
      minPayoutCents: input.settings.minPayoutCents,
      send: input.send,
      siteName: await resolveSiteName(),
      timeBudgetMs: input.timeBudgetMs,
      hooks: affiliatePayPalStepHooks(db),
    });
  } catch (error) {
    console.warn('[affiliates] The PayPal payout step did not run:', error instanceof Error ? error.message : 'unknown');
    return null;
  }
}
