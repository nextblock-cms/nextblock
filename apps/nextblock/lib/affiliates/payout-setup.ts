import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  STRIPE_REQUIRED_WEBHOOK_EVENTS,
  STRIPE_WEBHOOK_ROUTE_PATH,
  getStripeKeyDiagnostics,
  stripeCliListenCommand,
  type StripeKeyDiagnostics,
} from '@nextblock-cms/ecommerce/server';
import {
  AFFILIATE_ALERT_TYPES,
  affiliateGatewaysPaidByStripe,
  formatAffiliateMoney,
  type AffiliatesSettings,
} from '@nextblock-cms/affiliates';
import {
  affiliatePayoutObligationNeededCents,
  affiliateStripeErrorCode,
  computeAffiliateNextPayoutAt,
  isAffiliateStripeAuthenticationError,
  isAffiliateStripeConnectionError,
  isAffiliateStripeError,
  isAffiliateStripeMissingResourceError,
  isAffiliateStripePermissionError,
  loadAffiliatePayoutObligations,
  readAffiliatePayoutRunSummary,
  readAffiliateTransferableBalance,
  type AffiliatePayoutObligationTotals,
  type AffiliateStripeBalanceLike,
  type AffiliatesStripeLike,
} from '@nextblock-cms/affiliates/server';
import { requireCmsAdmin } from '../auth/cms-actor';
import { hasResolvedSiteUrl, isPubliclyRoutableSiteUrl, resolveSiteUrl } from '../site-url';
import { getAffiliateStoreBaseCurrency } from './admin-data';
import { AFFILIATE_CONNECT_SETUP_ALERT_KIND, affiliateConnectReturnUrls } from './connect-service';
import { isAffiliatesProgramActive } from './package-state';
import { getAffiliatePayoutPlatformInfo, resolveAffiliateStripeClient, type AffiliatePayoutPlatformInfo } from './payout-runner';
import { getAffiliatesSettings } from './settings';

/**
 * The CMS Affiliates → Stripe payouts screen (`/cms/affiliates/stripe`): its "Test connection"
 * check and the facts its cards show. Payouts use the shop's Stripe secret key (CMS → Payments,
 * else `STRIPE_SECRET_KEY`): there is no second key store, and nothing here writes to Stripe.
 *
 * - {@link testAffiliateStripeSetupNow}: read-only Stripe calls, each in its own try/catch
 *   (`balance.retrieve`, `accounts.retrieve` of the platform, `webhookEndpoints.list`,
 *   `transfers.list`, and `accounts.retrieve` of one partner's Connect account), answered as
 *   checks with fixed wording. Stripe's messages, raw errors and key material never leave it;
 *   the log gets error codes only.
 * - {@link loadAffiliateStripePayoutsOverview}: the server-rendered cards (keys, balance vs what is
 *   owed, keeping money in Stripe, automation, the latest Connect setup alert).
 *
 * Both re-check the ADMIN (`requireCmsAdmin()`) and read with the service role after it. The
 * public sandbox asks Stripe nothing: its keys belong to the operator.
 */

type AnyClient = SupabaseClient<any>;

export type AffiliateStripeSetupCheckId = 'key' | 'platform' | 'currency' | 'webhook' | 'transfers' | 'connect';
export type AffiliateStripeSetupCheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface AffiliateStripeSetupCheck {
  id: AffiliateStripeSetupCheckId;
  status: AffiliateStripeSetupCheckStatus;
  title: string;
  /** Plain English for the CMS, amounts already formatted; never a Stripe message or key material. */
  detail: string;
}

export type AffiliateStripeSetupTestRefusal = 'forbidden' | 'sandbox' | 'package_inactive' | 'stripe_not_configured' | 'unavailable';

export type AffiliateStripeSetupTestResult =
  | { ok: true; livemode: boolean | null; checks: AffiliateStripeSetupCheck[]; note: string }
  | { ok: false; reason: AffiliateStripeSetupTestRefusal };

/** The last line of every test result. */
export const AFFILIATE_STRIPE_SETUP_NOTHING_MOVED = 'Nothing was charged or transferred.';

/** The structural Stripe slice the check reads (the real SDK client has every member). */
interface AffiliateStripeWebhookEndpointLike {
  url?: string | null;
  status?: string | null;
  enabled_events?: string[] | null;
}

type AffiliateSetupStripe = AffiliatesStripeLike & {
  webhookEndpoints?: {
    list(params: { limit: number }): Promise<{ data: AffiliateStripeWebhookEndpointLike[]; has_more?: boolean }>;
  };
};

/** The public sandbox (same rule as the payout runner): no Stripe call with the operator's key. */
function isStripeSetupSandbox(): boolean {
  return process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function upperCode(value: unknown, length: number): string | null {
  const code = text(value).toUpperCase();
  return new RegExp(`^[A-Z]{${length}}$`).test(code) ? code : null;
}

function money(amount: number, currency: string): string {
  try {
    return formatAffiliateMoney(amount, currency, 'en');
  } catch {
    return `${amount} ${currency}`;
  }
}

function moneyList(amounts: Map<string, number>): string {
  const entries = [...amounts.entries()].sort(([a], [b]) => a.localeCompare(b));
  return entries.length > 0 ? entries.map(([currency, amount]) => money(amount, currency)).join(' · ') : 'nothing';
}

function countryName(code: string | null): string {
  if (!code) return 'an unknown country';
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** "daily, 2 days after the payment" / "manually (you pay out yourself)". */
export function describeAffiliateStripePayoutSchedule(interval: string | null, delayDays: number | null): string {
  const delay = delayDays !== null && delayDays > 0 ? `, ${delayDays} ${delayDays === 1 ? 'day' : 'days'} after each payment` : '';
  switch (interval) {
    case 'manual':
      return 'only when you pay out yourself (manual payouts)';
    case 'daily':
      return `daily${delay}`;
    case 'weekly':
      return `weekly${delay}`;
    case 'monthly':
      return `monthly${delay}`;
    default:
      return 'on a schedule this check could not read';
  }
}

/** The fixed wording of a failed Stripe read (codes only in the log). */
function failedCheck(id: AffiliateStripeSetupCheckId, title: string, error: unknown, resource: string): AffiliateStripeSetupCheck {
  console.warn(`[affiliates] Stripe setup check "${id}" failed (${affiliateStripeErrorCode(error)}).`);
  if (isAffiliateStripeAuthenticationError(error)) {
    return { id, title, status: 'fail', detail: 'Stripe rejected this key. Check the secret key under CMS > Payments.' };
  }
  if (isAffiliateStripePermissionError(error)) {
    return {
      id,
      title,
      status: 'fail',
      detail: `This restricted key can't read ${resource}. Allow it for the key in the Stripe Dashboard (Developers > API keys), or use a standard secret key.`,
    };
  }
  if (isAffiliateStripeConnectionError(error)) {
    return { id, title, status: 'fail', detail: "Couldn't reach Stripe. Try again in a moment." };
  }
  if (isAffiliateStripeError(error)) {
    return { id, title, status: 'fail', detail: `Stripe refused the request (${affiliateStripeErrorCode(error)}).` };
  }
  return { id, title, status: 'fail', detail: 'This check could not run. Try again in a moment.' };
}

const SKIPPED_REJECTED_KEY = 'Skipped: Stripe rejected this key.';

/**
 * A site address Stripe cannot send webhooks to: loopback, private (RFC 1918) or link-local, a
 * `.local` or `.localhost` name, `0.0.0.0` or a dotless host (`isPubliclyRoutableSiteUrl`), plus
 * a `.test` name and the rest of the 127/8 loopback range, which that helper lets through.
 */
function isUnreachableSite(site: string): boolean {
  if (!isPubliclyRoutableSiteUrl(site)) return true;
  try {
    const host = new URL(site).hostname.toLowerCase();
    return host.endsWith('.test') || /^127\./.test(host);
  } catch {
    return true;
  }
}

/**
 * How Stripe's events reach a site Stripe can't call: the Stripe CLI, whose signing secret then
 * has to be the stored one. Only the monorepo root has an `npm run stripe` script (a standalone
 * project has none), so the screens give the plain CLI command only.
 */
function stripeCliCommand(target: string): string {
  return `${stripeCliListenCommand(target)}, then save the whsec_… signing secret it prints as the webhook secret under CMS > Payments.`;
}

/** Stripe can deliver webhooks to this site: a configured address that is publicly routable. */
function siteReceivesWebhooks(): boolean {
  return hasResolvedSiteUrl() && !isUnreachableSite(resolveSiteUrl());
}

function comparableUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------------- checks --- */

function keyCheck(balance: AffiliateStripeBalanceLike, keys: StripeKeyDiagnostics | null): AffiliateStripeSetupCheck {
  const livemode = balance?.livemode === true;
  const modeText = livemode ? 'live mode' : 'test mode';
  const transferable = readAffiliateTransferableBalance(balance);
  const pending = readAffiliateTransferableBalance({ livemode, available: Array.isArray(balance?.pending) ? balance.pending : [] });
  const ending = keys?.secretKeyLast4 ? `, key ending in ${keys.secretKeyLast4}` : '';
  const prefixMode = keys?.mode ?? null;
  const mismatch = prefixMode !== null && (prefixMode === 'live') !== livemode;
  const amounts = `Transferable now (card payments): ${moneyList(transferable)}. Pending: ${moneyList(pending)}.`;
  if (mismatch) {
    return {
      id: 'key',
      status: 'warn',
      title: 'Stripe key',
      detail: `Stripe accepted the key but answered in ${modeText}, while the key's prefix says ${prefixMode} mode${ending}. ${amounts}`,
    };
  }
  const nothing = transferable.size === 0 || [...transferable.values()].every((amount) => amount <= 0);
  return {
    id: 'key',
    status: nothing ? 'warn' : 'pass',
    title: 'Stripe key',
    detail: `Stripe accepted the key (${modeText}${ending}). ${amounts}${nothing ? ' Nothing can be transferred to partners right now.' : ''}`,
  };
}

function platformCheck(account: Record<string, unknown>): AffiliateStripeSetupCheck {
  const id = text(account['id']) || 'Your account';
  const country = upperCode(account['country'], 2);
  const currency = upperCode(account['default_currency'], 3);
  const settings = asRecord(account['settings']);
  const branding = asRecord(settings['branding']);
  const schedule = asRecord(asRecord(settings['payouts'])['schedule']);
  const name = text(asRecord(settings['dashboard'])['display_name']) || text(asRecord(account['business_profile'])['name']);
  const icon = branding['icon'];
  const hasIcon = (typeof icon === 'string' && icon.trim() !== '') || (icon !== null && typeof icon === 'object');
  const color = text(branding['primary_color']);
  const charges = account['charges_enabled'] === true;
  const payouts = account['payouts_enabled'] === true;
  const interval = text(schedule['interval']) || null;
  const delay = Number.isFinite(Number(schedule['delay_days'])) ? Math.trunc(Number(schedule['delay_days'])) : null;

  const missing = [name ? null : 'a business name', color ? null : 'a brand colour', hasIcon ? null : 'an icon'].filter(
    (item): item is string => item !== null
  );
  const parts = [
    `${id} in ${countryName(country)}${currency ? `, settling in ${currency}` : ''}.`,
    name ? `Name: ${name}.` : '',
    `Card payments ${charges ? 'enabled' : 'not enabled yet'}; payouts to your bank ${payouts ? 'enabled' : 'not enabled yet'}.`,
    `Stripe pays your balance out ${describeAffiliateStripePayoutSchedule(interval, delay)}.`,
    missing.length > 0
      ? `Connect onboarding needs a business name, a brand colour and an icon: add ${missing.join(', ')} in the Stripe Dashboard (Settings > Connect > Branding).`
      : '',
  ];
  return {
    id: 'platform',
    status: missing.length > 0 || !charges || !payouts ? 'warn' : 'pass',
    title: 'Platform account',
    detail: parts.filter(Boolean).join(' '),
  };
}

function currencyCheck(
  storeCurrency: string,
  accountCurrency: string | null,
  balance: AffiliateStripeBalanceLike | null
): AffiliateStripeSetupCheck {
  const title = 'Payout currency';
  if (!accountCurrency && !balance) {
    return { id: 'currency', status: 'skip', title, detail: 'Checked once Stripe answers the balance and account reads.' };
  }
  const held = new Set<string>();
  for (const entry of [...(Array.isArray(balance?.available) ? balance.available : []), ...(Array.isArray(balance?.pending) ? balance.pending : [])]) {
    const code = upperCode(entry?.currency, 3);
    if (code) held.add(code);
  }
  const problems: string[] = [];
  if (accountCurrency && accountCurrency !== storeCurrency) {
    problems.push(
      `Your Stripe account settles in ${accountCurrency}, but commissions are recorded and paid in the store currency, ${storeCurrency}: add ${storeCurrency} to your Stripe account or make ${accountCurrency} the store's default currency.`
    );
  }
  if (balance && !held.has(storeCurrency)) {
    problems.push(`Your Stripe balance holds no ${storeCurrency}, so payouts in ${storeCurrency} have nothing to draw on.`);
  }
  if (problems.length > 0) return { id: 'currency', status: 'warn', title, detail: problems.join(' ') };
  return {
    id: 'currency',
    status: 'pass',
    title,
    detail: `Commissions are paid in ${storeCurrency}, which your Stripe account ${accountCurrency ? 'settles in' : 'uses'}${balance ? ' and your balance holds' : ''}.`,
  };
}

async function webhookCheck(stripe: AffiliateSetupStripe): Promise<AffiliateStripeSetupCheck> {
  const title = 'Webhook endpoint';
  if (!hasResolvedSiteUrl()) {
    // resolveSiteUrl() would answer its local fallback, which says nothing about where this site runs.
    return {
      id: 'webhook',
      status: 'skip',
      title,
      detail: `No site address is configured (NEXT_PUBLIC_URL), so the endpoint can't be checked. On a public site, set NEXT_PUBLIC_URL to its address. On your own computer, forward webhooks with the Stripe CLI: ${stripeCliCommand(`<this site's address>${STRIPE_WEBHOOK_ROUTE_PATH}`)}`,
    };
  }
  const site = resolveSiteUrl();
  const expected = `${site}${STRIPE_WEBHOOK_ROUTE_PATH}`;
  if (isUnreachableSite(site)) {
    return {
      id: 'webhook',
      status: 'skip',
      title,
      detail: `This site runs at ${site}, which Stripe can't reach. Forward webhooks with the Stripe CLI: ${stripeCliCommand(expected)}`,
    };
  }
  if (!stripe.webhookEndpoints) {
    return { id: 'webhook', status: 'skip', title, detail: 'This Stripe client cannot list webhook endpoints.' };
  }
  let endpoints: AffiliateStripeWebhookEndpointLike[];
  let more = false;
  try {
    const list = await stripe.webhookEndpoints.list({ limit: 100 });
    endpoints = Array.isArray(list?.data) ? list.data : [];
    more = list?.has_more === true;
  } catch (error) {
    return failedCheck('webhook', title, error, 'webhook endpoints');
  }

  const target = comparableUrl(expected);
  const matches = endpoints.filter((endpoint) => target !== null && comparableUrl(text(endpoint?.url)) === target);
  const required: readonly string[] = STRIPE_REQUIRED_WEBHOOK_EVENTS;
  if (matches.length === 0) {
    return {
      id: 'webhook',
      status: 'warn',
      title,
      detail: `No webhook endpoint in this mode sends to ${expected}${more ? ' (the first 100 endpoints were checked)' : ''}. Add it in the Stripe Dashboard (Developers > Webhooks) with these events: ${required.join(', ')}. Paid orders, refunds and disputes reach orders and commissions only through it.`,
    };
  }
  const enabled = matches.filter((endpoint) => text(endpoint?.status) === 'enabled');
  if (enabled.length === 0) {
    return { id: 'webhook', status: 'warn', title, detail: `The endpoint for ${expected} is disabled in Stripe. Enable it under Developers > Webhooks.` };
  }
  const best = enabled
    .map((endpoint) => {
      const events = new Set((Array.isArray(endpoint.enabled_events) ? endpoint.enabled_events : []).map((event) => text(event)));
      return events.has('*') ? [] : required.filter((event) => !events.has(event));
    })
    .sort((a, b) => a.length - b.length)[0];
  if (best.length > 0) {
    return {
      id: 'webhook',
      status: 'warn',
      title,
      detail: `The endpoint for ${expected} is enabled but misses these events: ${best.join(', ')}. Add them under Developers > Webhooks.`,
    };
  }
  return { id: 'webhook', status: 'pass', title, detail: `An enabled endpoint sends every event orders and commissions need to ${expected}.` };
}

async function transfersCheck(stripe: AffiliateSetupStripe): Promise<AffiliateStripeSetupCheck> {
  const title = 'Transfers';
  try {
    const list = await stripe.transfers.list({ limit: 1 });
    const any = Array.isArray(list?.data) && list.data.length > 0;
    return {
      id: 'transfers',
      status: 'pass',
      title,
      detail: `Transfers can be read, which reconciliation needs to find a payout's transfer. ${any ? 'The latest transfer was found.' : 'No transfer exists yet in this mode.'}`,
    };
  } catch (error) {
    return failedCheck('transfers', title, error, 'transfers');
  }
}

async function connectCheck(stripe: AffiliateSetupStripe, db: AnyClient, livemode: boolean | null): Promise<AffiliateStripeSetupCheck> {
  const title = 'Stripe Connect';
  if (livemode === null) return { id: 'connect', status: 'skip', title, detail: 'Checked once the key mode is known.' };
  let accountId: string | null = null;
  try {
    const { data, error } = await db
      .from('affiliate_profiles')
      .select('stripe_connect_account_id')
      .not('stripe_connect_account_id', 'is', null)
      .eq('stripe_connect_livemode', livemode)
      .limit(1);
    if (error) throw error;
    const row = Array.isArray(data) ? asRecord(data[0]) : {};
    accountId = /^acct_[A-Za-z0-9]+$/.test(text(row['stripe_connect_account_id'])) ? text(row['stripe_connect_account_id']) : null;
  } catch {
    return { id: 'connect', status: 'skip', title, detail: 'The partner accounts could not be read. Try again in a moment.' };
  }
  if (!accountId) {
    return { id: 'connect', status: 'skip', title, detail: 'Checked when the first partner connects.' };
  }
  try {
    await stripe.accounts.retrieve(accountId);
    return { id: 'connect', status: 'pass', title, detail: "Stripe Connect answers for your partners' accounts (one was checked)." };
  } catch (error) {
    if (isAffiliateStripeMissingResourceError(error)) {
      return {
        id: 'connect',
        status: 'warn',
        title,
        detail: "Stripe doesn't know one partner's Connect account in this mode. That partner connects again from their portal.",
      };
    }
    return failedCheck('connect', title, error, 'connected accounts');
  }
}

/**
 * "Test connection" (ADMIN only, re-checked here): six read-only checks of what payouts need, in
 * this order: the key and balance, the platform account, the payout currency, the webhook
 * endpoint, transfers, and Connect access. A rejected key skips the calls after the first.
 * Refused on the public sandbox before any Stripe call, while the program is inactive, and
 * without a Stripe key. Never throws past the admin check (which answers `forbidden`).
 */
export async function testAffiliateStripeSetupNow(): Promise<AffiliateStripeSetupTestResult> {
  let db: AnyClient;
  try {
    db = (await requireCmsAdmin()).supabase as unknown as AnyClient;
  } catch {
    return { ok: false, reason: 'forbidden' };
  }
  if (isStripeSetupSandbox()) return { ok: false, reason: 'sandbox' };

  try {
    if (!(await isAffiliatesProgramActive())) return { ok: false, reason: 'package_inactive' };
  } catch {
    return { ok: false, reason: 'package_inactive' };
  }

  const resolved = await resolveAffiliateStripeClient();
  if (!resolved.ok) {
    return { ok: false, reason: resolved.error === 'stripe_not_configured' ? 'stripe_not_configured' : resolved.error === 'sandbox' ? 'sandbox' : 'unavailable' };
  }
  const stripe: AffiliateSetupStripe = resolved.stripe;

  const [keys, storeCurrency] = await Promise.all([
    getStripeKeyDiagnostics().catch(() => null),
    getAffiliateStoreBaseCurrency(db),
  ]);

  const checks: AffiliateStripeSetupCheck[] = [];
  let balance: AffiliateStripeBalanceLike | null = null;
  let rejected = false;
  try {
    balance = await stripe.balance.retrieve();
    checks.push(keyCheck(balance, keys));
  } catch (error) {
    rejected = isAffiliateStripeAuthenticationError(error);
    checks.push(failedCheck('key', 'Stripe key', error, 'the balance'));
  }

  if (rejected) {
    for (const [id, title] of [
      ['platform', 'Platform account'],
      ['currency', 'Payout currency'],
      ['webhook', 'Webhook endpoint'],
      ['transfers', 'Transfers'],
      ['connect', 'Stripe Connect'],
    ] as const) {
      checks.push({ id, title, status: 'skip', detail: SKIPPED_REJECTED_KEY });
    }
    return { ok: true, livemode: null, checks, note: AFFILIATE_STRIPE_SETUP_NOTHING_MOVED };
  }

  let accountCurrency: string | null = null;
  try {
    const account = asRecord(await stripe.accounts.retrieve(null));
    accountCurrency = upperCode(account['default_currency'], 3);
    checks.push(platformCheck(account));
  } catch (error) {
    checks.push(failedCheck('platform', 'Platform account', error, 'the platform account'));
  }

  checks.push(currencyCheck(storeCurrency, accountCurrency, balance));
  checks.push(await webhookCheck(stripe));
  checks.push(await transfersCheck(stripe));

  const livemode = balance ? balance.livemode === true : keys?.mode ? keys.mode === 'live' : null;
  checks.push(await connectCheck(stripe, db, livemode));

  return { ok: true, livemode, checks, note: AFFILIATE_STRIPE_SETUP_NOTHING_MOVED };
}

/* ------------------------------------------------------------------- the screen --- */

/** One currency of the "Balance vs what you owe" card (minor units). */
export interface AffiliateStripeFundingRow extends AffiliatePayoutObligationTotals {
  /** Owed now + waiting to retry + needs an admin + clearing soon. */
  neededCents: number;
  /** Transferable (card source) available balance; null when Stripe figures are unavailable. */
  transferableCents: number | null;
  /** Pending card-source balance; null when Stripe figures are unavailable. */
  pendingCents: number | null;
  /** How much the balance (available + pending) is short of `neededCents`; 0 when covered, null when unknown. */
  shortCents: number | null;
}

/** The latest payout run day (`affiliate_payout_runs`): the day's totals, and where its latest call stopped. */
export interface AffiliateStripeLastPayoutRun {
  runDate: string;
  /** `auto`, `admin` or `cron` as stored (the page maps it to a label). */
  trigger: string | null;
  finishedAt: string | null;
  /** The day's totals. */
  sent: number;
  failed: number;
  /** Partners the latest call left for a continuation. */
  remaining: number;
  /** Why the latest call stopped early (`stripe_authentication`, `stripe_unavailable`), else null. */
  aborted: string | null;
}

export interface AffiliateStripePayoutsOverview {
  sandbox: boolean;
  /** The key facts (CMS → Payments); null when they could not be read. */
  keys: StripeKeyDiagnostics | null;
  /** The payout runner's Stripe facts (the Payouts screen shows the same). */
  platform: AffiliatePayoutPlatformInfo | null;
  /** The platform account's payout schedule, read fresh; null when Stripe was not asked or did not answer. */
  schedule: { interval: string | null; delayDays: number | null } | null;
  baseCurrency: string;
  settings: AffiliatesSettings | null;
  funding: {
    /** The key mode the figures belong to, and where it came from. */
    livemode: boolean;
    modeSource: 'stripe' | 'key' | 'default';
    windowDays: number;
    rows: AffiliateStripeFundingRow[];
    truncated: boolean;
    /** Stripe balance figures were read (never on the sandbox). */
    stripeFigures: boolean;
  } | null;
  automation: {
    cronSecretConfigured: boolean;
    /** `CRON_SECRET` is set but shorter than the 16 characters the payout route requires. */
    cronSecretTooShort: boolean;
    /** Null when no run day was recorded yet; `'unavailable'` when the run table could not be read. */
    lastRun: AffiliateStripeLastPayoutRun | 'unavailable' | null;
    nextScheduledRunAt: string;
    returnUrl: string;
    siteUrlConfigured: boolean;
    /** This site's Stripe webhook route (where the Stripe CLI forwards events to locally). */
    webhookUrl: string;
    /** Stripe can deliver to `webhookUrl`: a configured, publicly routable address (the webhook check's rule). */
    webhookReachable: boolean;
  };
  /** The latest unresolved Connect setup alert (`metadata.kind = 'connect_setup'`). */
  connectAlert: { id: string; title: string; message: string; createdAt: string; stripeCode: string | null; step: string | null } | null;
}

async function readLatestConnectAlert(db: AnyClient): Promise<AffiliateStripePayoutsOverview['connectAlert']> {
  try {
    const { data, error } = await db
      .from('system_alerts')
      .select('id, title, message, metadata, created_at')
      .eq('alert_type', AFFILIATE_ALERT_TYPES.PAYOUT_FAILED)
      .eq('is_resolved', false)
      .eq('metadata->>kind', AFFILIATE_CONNECT_SETUP_ALERT_KIND)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) return null;
    const row = Array.isArray(data) ? asRecord(data[0]) : {};
    if (typeof row['id'] !== 'string') return null;
    const metadata = asRecord(row['metadata']);
    const code = text(metadata['stripe_code']);
    const step = text(metadata['step']);
    return {
      id: row['id'],
      title: text(row['title']),
      message: text(row['message']),
      createdAt: text(row['created_at']),
      stripeCode: /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : null,
      step: /^[a-z][a-z_]{0,40}$/.test(step) ? step : null,
    };
  } catch {
    return null;
  }
}

async function readLastPayoutRun(db: AnyClient): Promise<AffiliateStripePayoutsOverview['automation']['lastRun']> {
  try {
    const { data, error } = await db
      .from('affiliate_payout_runs')
      .select('run_date, trigger, finished_at, summary')
      .order('run_date', { ascending: false })
      .limit(1);
    // A failed read is not "no run yet".
    if (error) return 'unavailable';
    const row = Array.isArray(data) ? asRecord(data[0]) : {};
    const runDate = text(row['run_date']).slice(0, 10);
    if (!runDate) return null;
    const summary = readAffiliatePayoutRunSummary(row['summary']);
    return {
      runDate,
      trigger: text(row['trigger']) || null,
      finishedAt: text(row['finished_at']) || null,
      sent: summary?.totals.sent ?? 0,
      failed: summary?.totals.failed ?? 0,
      remaining: summary?.remaining ?? 0,
      aborted: summary?.aborted ?? null,
    };
  } catch {
    return 'unavailable';
  }
}

async function readPayoutSchedule(platform: AffiliatePayoutPlatformInfo | null): Promise<AffiliateStripePayoutsOverview['schedule']> {
  if (isStripeSetupSandbox() || !platform || platform.stripeConfigured !== true || platform.error === 'stripe_authentication') return null;
  const resolved = await resolveAffiliateStripeClient();
  if (!resolved.ok) return null;
  try {
    const account = asRecord(await resolved.stripe.accounts.retrieve(null));
    const schedule = asRecord(asRecord(asRecord(account['settings'])['payouts'])['schedule']);
    const delay = Number(schedule['delay_days']);
    return { interval: text(schedule['interval']) || null, delayDays: Number.isFinite(delay) ? Math.trunc(delay) : null };
  } catch (error) {
    console.warn(`[affiliates] Could not read the Stripe payout schedule (${affiliateStripeErrorCode(error)}).`);
    return null;
  }
}

function amountFor(list: Array<{ currency: string; amount: number }> | null, currency: string): number | null {
  if (!list) return null;
  return list.find((entry) => entry.currency === currency)?.amount ?? 0;
}

/**
 * Everything `/cms/affiliates/stripe` renders (ADMIN only, re-checked here; reads with the service
 * role). Each part is read on its own and comes back empty when its read fails; the sandbox gets
 * the ledger figures but no Stripe figure. Throws only the admin check's error.
 */
export async function loadAffiliateStripePayoutsOverview(now: Date = new Date()): Promise<AffiliateStripePayoutsOverview> {
  const { supabase } = await requireCmsAdmin();
  const db = supabase as unknown as AnyClient;
  const sandbox = isStripeSetupSandbox();

  const [keys, platform, settings, baseCurrency, lastRun, connectAlert] = await Promise.all([
    getStripeKeyDiagnostics().catch(() => null),
    getAffiliatePayoutPlatformInfo().catch(() => null),
    getAffiliatesSettings().catch(() => null),
    getAffiliateStoreBaseCurrency(db),
    readLastPayoutRun(db),
    readLatestConnectAlert(db),
  ]);
  const schedule = await readPayoutSchedule(platform);

  // The key mode: what Stripe answered, else the key's prefix, else live (as unknown sales are recorded).
  const livemode = platform?.livemode ?? (keys?.mode ? keys.mode === 'live' : null);
  const modeSource: 'stripe' | 'key' | 'default' = typeof platform?.livemode === 'boolean' ? 'stripe' : keys?.mode ? 'key' : 'default';
  const mode = livemode ?? true;
  const stripeFigures = !sandbox && Boolean(platform?.transferable);

  let funding: AffiliateStripePayoutsOverview['funding'] = null;
  try {
    // 02036: commissions paid by hand never need the Stripe balance ("Paid manually"). Unknown
    // settings: every gateway, as before (the figures then err on the side of more needed).
    const stripeGateways = settings ? affiliateGatewaysPaidByStripe(settings) : null;
    const obligations = await loadAffiliatePayoutObligations(db, {
      livemode: mode,
      // With no gateway left on Stripe the daily run is the ledger repair alone and retries no
      // failed transfer (runAffiliatePayoutCycle), so those wait for an admin.
      automatedPayoutsRunning:
        Boolean(settings?.autoPayoutsEnabled) &&
        platform?.stripeConfigured === true &&
        !sandbox &&
        (stripeGateways === null || stripeGateways.length > 0),
      now,
      gateways: stripeGateways,
    });
    const byCurrency = new Map(obligations.currencies.map((entry) => [entry.currency, entry]));
    if (!byCurrency.has(baseCurrency)) {
      byCurrency.set(baseCurrency, {
        currency: baseCurrency,
        owedNowCents: 0,
        owedNowStripeCents: 0,
        owedNowFreemiusCents: 0,
        inFlightCents: 0,
        retryingCents: 0,
        needsAdminCents: 0,
        clearingSoonCents: 0,
        lastWindowCents: 0,
        owedManuallyCents: 0,
      });
    }
    const rows = [...byCurrency.values()]
      .sort((a, b) => (a.currency === baseCurrency ? -1 : b.currency === baseCurrency ? 1 : a.currency.localeCompare(b.currency)))
      .map((entry): AffiliateStripeFundingRow => {
        const neededCents = affiliatePayoutObligationNeededCents(entry);
        const transferableCents = stripeFigures ? amountFor(platform?.transferable ?? null, entry.currency) : null;
        const pendingCents = stripeFigures ? amountFor(platform?.pending ?? null, entry.currency) : null;
        const shortCents =
          transferableCents === null || pendingCents === null ? null : Math.max(0, neededCents - transferableCents - pendingCents);
        return { ...entry, neededCents, transferableCents, pendingCents, shortCents };
      });
    funding = { livemode: mode, modeSource, windowDays: obligations.windowDays, rows, truncated: obligations.truncated, stripeFigures };
  } catch (error) {
    const code = error && typeof error === 'object' ? (asRecord((error as { cause?: unknown }).cause)['code'] ?? null) : null;
    console.error('[affiliates] Stripe payouts: what is owed could not be read', { code });
  }

  const { returnUrl } = affiliateConnectReturnUrls();
  // Length only: the route refuses a secret under 16 characters; the value never leaves the server.
  const cronSecretLength = process.env.CRON_SECRET?.trim().length ?? 0;
  return {
    sandbox,
    keys,
    platform,
    schedule,
    baseCurrency,
    settings,
    funding,
    automation: {
      cronSecretConfigured: cronSecretLength >= 16,
      cronSecretTooShort: cronSecretLength > 0 && cronSecretLength < 16,
      lastRun,
      nextScheduledRunAt: computeAffiliateNextPayoutAt(now).toISOString(),
      returnUrl,
      siteUrlConfigured: hasResolvedSiteUrl(),
      webhookUrl: `${resolveSiteUrl()}${STRIPE_WEBHOOK_ROUTE_PATH}`,
      webhookReachable: siteReceivesWebhooks(),
    },
    connectAlert,
  };
}
