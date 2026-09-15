import 'server-only';

import { getServiceRoleSupabaseClient, verifyPackageOnline } from '@nextblock-cms/db/server';
import { syncStoreCurrencyRates } from '@nextblock-cms/ecommerce/server';

/**
 * Daily FX-rate refresh without a cron.
 *
 * This used to be a Vercel cron (`/api/cron/sync-currencies`, daily). A cron declared
 * in `vercel.json` ships to every Vercel 1-click install, where Hobby accounts reject
 * sub-daily schedules outright and even a daily one burns a cron slot for a store most
 * installs never enable. So, like the upstream-update check and the package
 * re-validation, the refresh runs from the CMS layout via `after()`: at most once per
 * day, and only when the ecommerce package is active and at least one non-default
 * currency asks for automatic rates. The route still exists for operators who prefer
 * an explicit external schedule.
 */

const REFRESH_INTERVAL_MS = 24 * 60 * 60_000;

type CurrencyRow = {
  auto_update_exchange_rate: boolean | null;
  exchange_rate_updated_at: string | null;
  is_active: boolean | null;
  is_default: boolean | null;
};

/** Per-instance guard so concurrent CMS requests do not all fetch rates at once. */
let inFlight: Promise<void> | null = null;

function parseTimestamp(value: string | null) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * True when some active, non-default currency that auto-updates has never been synced
 * or was last synced more than a day ago.
 */
export function isCurrencyRefreshDue(currencies: CurrencyRow[], now = Date.now()) {
  const cutoff = now - REFRESH_INTERVAL_MS;

  return currencies.some((currency) => {
    if (currency.is_default || currency.is_active === false) return false;
    if (currency.auto_update_exchange_rate === false) return false;
    const last = parseTimestamp(currency.exchange_rate_updated_at);
    return last === null || last < cutoff;
  });
}

/**
 * Refresh store FX rates when they are a day old. Best-effort and silent: it runs
 * after the response has been sent and never throws.
 */
export async function maybeSyncCurrencyRates(isEcommerceActive?: boolean): Promise<void> {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const active = isEcommerceActive ?? (await verifyPackageOnline('ecommerce'));
      if (!active) return;

      const supabase = getServiceRoleSupabaseClient();
      const { data, error } = await supabase
        .from('currencies')
        .select('is_default, is_active, auto_update_exchange_rate, exchange_rate_updated_at');

      if (error || !Array.isArray(data) || !isCurrencyRefreshDue(data as CurrencyRow[])) {
        return;
      }

      const result = await syncStoreCurrencyRates();
      console.info(
        `[Currencies] Refreshed ${result.updatedCurrencies.length} exchange rate(s) from ${result.provider}.`
      );
    } catch (error) {
      console.warn('[Currencies] Rate refresh skipped:', error instanceof Error ? error.message : error);
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
