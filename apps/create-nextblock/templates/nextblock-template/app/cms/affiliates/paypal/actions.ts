'use server';

import 'server-only';

import { revalidatePath } from 'next/cache';
import { AFFILIATE_CMS_PATH, AFFILIATE_CMS_PAYOUTS_PATH, AFFILIATE_CMS_PAYPAL_PATH, AFFILIATE_CMS_STRIPE_PATH } from '@nextblock-cms/affiliates';
import { normalizeAffiliateUuid } from '@nextblock-cms/affiliates/server';
import { requireCmsAdmin } from '../../../../lib/auth/cms-actor';
import {
  cancelAffiliatePayPalPayoutNow,
  saveAffiliatePayPalCredentialsNow,
  syncAffiliatePayPalPayoutsNow,
  testAffiliatePayPalConnectionNow,
} from '../../../../lib/affiliates/paypal/admin';
import { AFFILIATE_PAYPAL_CREDENTIAL_MAX_LENGTH } from '../../../../lib/affiliates/paypal/credentials';
import { z } from '../../../../lib/zod-config';
import { formatAdminMoney } from '../components/format';

/**
 * Server actions of the CMS PayPal payouts screen (`/cms/affiliates/paypal`, 02037).
 *
 * Each export is a public POST endpoint reachable from any route, so each one calls
 * `requireCmsAdmin()` (session, enrolled second factor, ADMIN role) before it reads its input, then
 * refuses on the public sandbox (PayPal is never called and no credential is saved or read there),
 * then validates with strict zod (unknown keys refused, every string bounded). None takes an actor or
 * a client. The work is in `lib/affiliates/paypal/admin.ts`, which checks the ADMIN, the sandbox and
 * the package again. Results are data with fixed sentences: no PayPal or database text, and never a
 * secret (the client id shows as its last 4 characters at most).
 */

export type AffiliatePayPalActionResult = { ok: true; message: string } | { ok: false; error: string };

export type TestAffiliatePayPalConnectionActionResult =
  | { ok: true; message: string; facts: Array<{ label: string; value: string }>; note: string }
  | { ok: false; error: string; reason: string };

const INVALID_INPUT = 'That request could not be read. Reload the page and try again.';
const FORBIDDEN = 'Only administrators can manage the affiliate program.';
const SESSION = 'Your session has expired or needs its second factor. Sign in again to continue.';
const SANDBOX = "PayPal isn't used on the sandbox: its credentials belong to the site's operator, and payouts are switched off.";
const PACKAGE_INACTIVE = 'The affiliate program is paused: it needs both the Affiliates package and Commerce Pro to be active.';
const NOTHING_SENT = 'Nothing was sent.';

async function authorizeAdmin(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await requireCmsAdmin();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error && error.message === 'Forbidden' ? FORBIDDEN : SESSION };
  }
}

function payPalLockedInSandbox(): boolean {
  return process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';
}

function revalidatePayPalScreens(): void {
  for (const path of [AFFILIATE_CMS_PAYPAL_PATH, AFFILIATE_CMS_PAYOUTS_PATH, AFFILIATE_CMS_STRIPE_PATH, AFFILIATE_CMS_PATH]) {
    try {
      revalidatePath(path);
    } catch {
      // A revalidation failure never fails the action.
    }
  }
}

const REFUSALS: Readonly<Record<string, string>> = {
  forbidden: FORBIDDEN,
  sandbox: SANDBOX,
  package_inactive: PACKAGE_INACTIVE,
};

/* ---------------------------------------------------------------- credentials --- */

const credentialsSchema = z
  .object({
    environment: z.enum(['sandbox', 'live']),
    clientId: z.string().trim().max(AFFILIATE_PAYPAL_CREDENTIAL_MAX_LENGTH).regex(/^[A-Za-z0-9_-]*$/, 'invalid_client_id').optional(),
    secret: z.string().trim().max(AFFILIATE_PAYPAL_CREDENTIAL_MAX_LENGTH).optional(),
  })
  .strict();

export interface SaveAffiliatePayPalCredentialsActionInput {
  environment: 'sandbox' | 'live';
  /** Blank keeps the client id saved for that environment (or the environment variables). */
  clientId?: string;
  /** Write-only; blank keeps the saved secret. */
  secret?: string;
}

/**
 * Saves the PayPal credentials once PayPal accepted them (a token request first): the environment
 * becomes the one new payouts go out in. Credentials PayPal rejects, or that cannot be checked because
 * PayPal is unreachable, are not saved.
 */
export async function saveAffiliatePayPalCredentialsAction(input: SaveAffiliatePayPalCredentialsActionInput): Promise<AffiliatePayPalActionResult> {
  const auth = await authorizeAdmin();
  if (!auth.ok) return auth;
  if (payPalLockedInSandbox()) return { ok: false, error: SANDBOX };

  const parsed = credentialsSchema.safeParse(input);
  if (!parsed.success) {
    const clientIdIssue = parsed.error.issues.some((issue) => issue.message === 'invalid_client_id');
    return { ok: false, error: clientIdIssue ? 'A PayPal client ID holds only letters, digits, - and _.' : INVALID_INPUT };
  }

  const outcome = await saveAffiliatePayPalCredentialsNow(parsed.data);
  if (outcome.status === 'saved') {
    revalidatePayPalScreens();
    const env = outcome.environment === 'live' ? 'live' : 'sandbox';
    const enabled = outcome.payoutsEnabled
      ? ' Payouts is enabled for this app.'
      : ' PayPal has not enabled Payouts for this app yet: request access (see the setup checklist), then test the connection.';
    return { ok: true, message: `PayPal accepted the ${env} credentials and they were saved. New PayPal payouts go out in ${env}.${enabled}` };
  }
  switch (outcome.status) {
    case 'missing_credentials':
      return { ok: false, error: 'Enter the client ID and secret of your PayPal app for this environment.' };
    case 'rejected':
      return {
        ok: false,
        error: 'PayPal rejected these credentials, so nothing was saved. Check the client ID and secret of your PayPal app, and that they belong to the environment you chose (sandbox or live).',
      };
    case 'unavailable':
      return { ok: false, error: 'PayPal could not be reached to check the credentials, so nothing was saved. Try again in a moment.' };
    case 'unknown':
      return { ok: false, error: 'The credentials could not be saved. Try again in a moment.' };
    default:
      return { ok: false, error: REFUSALS[outcome.status] ?? INVALID_INPUT };
  }
}

/* ------------------------------------------------------------ test connection --- */

/**
 * "Test connection": a fresh PayPal token, the Payouts scope, the app id and the balance when the
 * token may read it. Read-only: nothing is sent. No input: there is nothing for a caller to choose.
 */
export async function testAffiliatePayPalConnectionAction(): Promise<TestAffiliatePayPalConnectionActionResult> {
  const auth = await authorizeAdmin();
  if (!auth.ok) return { ok: false, error: auth.error, reason: 'forbidden' };
  if (payPalLockedInSandbox()) return { ok: false, error: SANDBOX, reason: 'sandbox' };

  const result = await testAffiliatePayPalConnectionNow();
  if (!result.ok) {
    const error =
      result.reason === 'not_configured'
        ? 'No PayPal credentials are configured for the active environment. Save them below (or set the PAYPAL_* environment variables), then test again.'
        : result.reason === 'credentials'
          ? 'PayPal rejected the credentials. Save the client ID and secret of your PayPal app again.'
          : result.reason === 'unavailable'
            ? 'PayPal could not be reached. Try again in a moment.'
            : REFUSALS[result.reason] ?? INVALID_INPUT;
    return { ok: false, error, reason: result.reason };
  }

  const env = result.environment === 'live' ? 'Live' : 'Sandbox';
  const facts: Array<{ label: string; value: string }> = [
    { label: 'Environment', value: env },
    { label: 'Credentials', value: `${result.source === 'cms' ? 'Saved in the CMS' : 'From the environment'}${result.clientIdLast4 ? ` · client ID ending in ${result.clientIdLast4}` : ''}` },
    { label: 'PayPal app', value: result.appId ?? 'PayPal did not name the app' },
    {
      label: 'Payouts',
      value: result.payoutsEnabled
        ? 'Enabled: the token carries the Payouts scope'
        : 'Not enabled: the token lacks the Payouts scope. Request access and tick Payouts in your app.',
    },
  ];
  if (result.balances) {
    const store = result.balances.find((entry) => entry.currency === result.storeCurrency);
    facts.push({
      label: `Balance (${result.storeCurrency})`,
      value: store && store.availableCents !== null ? `${formatAdminMoney(store.availableCents, store.currency)} available` : `No ${result.storeCurrency} balance`,
    });
    const others = result.balances.filter((entry) => entry.currency !== result.storeCurrency && entry.availableCents !== null);
    if (others.length > 0) {
      facts.push({
        label: 'Other balances',
        value: others.map((entry) => formatAdminMoney(entry.availableCents ?? 0, entry.currency)).join(' · '),
      });
    }
  } else {
    facts.push({ label: 'Balance', value: 'Not readable with this app (it needs the balance permission). Payouts do not need it.' });
  }
  return {
    ok: true,
    message: result.payoutsEnabled ? 'PayPal accepted the credentials and Payouts is enabled.' : 'PayPal accepted the credentials, but Payouts is not enabled yet.',
    facts,
    note: NOTHING_SENT,
  };
}

/* ------------------------------------------------------------- status, cancel --- */

/** "Check PayPal status now": asks PayPal about every PayPal payout in flight. Nothing is claimed or sent. */
export async function syncAffiliatePayPalPayoutsAction(): Promise<AffiliatePayPalActionResult> {
  const auth = await authorizeAdmin();
  if (!auth.ok) return auth;
  if (payPalLockedInSandbox()) return { ok: false, error: SANDBOX };

  const outcome = await syncAffiliatePayPalPayoutsNow();
  if (outcome.status !== 'synced') {
    if (outcome.status === 'settings_unavailable') return { ok: false, error: 'The program settings could not be read. Try again in a few minutes.' };
    if (outcome.status === 'unavailable') return { ok: false, error: 'The PayPal check did not run. Try again in a moment.' };
    return { ok: false, error: REFUSALS[outcome.status] ?? INVALID_INPUT };
  }
  revalidatePayPalScreens();
  const { summary } = outcome;
  if (summary.synced === 0 && summary.pendingRetry === 0) {
    return {
      ok: true,
      message: summary.errors.length > 0 ? 'PayPal could not be asked about the payouts in flight. The server log has the details.' : 'No PayPal payout was waiting for PayPal.',
    };
  }
  const parts = [`${summary.completed} paid`, `${summary.failed} failed`, `${summary.inFlight} still in flight`];
  if (summary.unclaimed > 0) parts.push(`${summary.unclaimed} unclaimed`);
  // Only a run that sends resends them: the daily run while automatic payouts are on, or Run payouts now.
  const pending =
    summary.pendingRetry > 0
      ? outcome.autoPayoutsEnabled
        ? ` ${summary.pendingRetry} sent with no answer yet will be sent again by the next payout run.`
        : ` ${summary.pendingRetry} sent with no answer yet are sent again only when you press Run payouts now on the Payouts screen (automatic payouts are off).`
      : '';
  const errors = summary.errors.length > 0 ? ' Some checks failed; the server log has the details.' : '';
  return { ok: true, message: `PayPal checked: ${parts.join(', ')}.${pending}${errors}` };
}

const cancelSchema = z.object({ payoutIdToCancel: z.string().trim().max(64) }).strict();

/**
 * "Stop payment" or "Release" of a PayPal payout in flight: an UNCLAIMED item is cancelled at PayPal
 * and its commissions go back to what is owed; a payout PayPal never confirmed (an hour after its last
 * send), or accepted and never settled (a week after it), is released without a PayPal write once the
 * admin checked PayPal paid nothing. The database checks the release rule under the payout lock.
 */
export async function cancelAffiliatePayPalPayoutAction(input: { payoutIdToCancel: string }): Promise<AffiliatePayPalActionResult> {
  const auth = await authorizeAdmin();
  if (!auth.ok) return auth;
  if (payPalLockedInSandbox()) return { ok: false, error: SANDBOX };

  const parsed = cancelSchema.safeParse(input);
  if (!parsed.success || !normalizeAffiliateUuid(parsed.data.payoutIdToCancel)) return { ok: false, error: INVALID_INPUT };

  const outcome = await cancelAffiliatePayPalPayoutNow({ payoutIdToCancel: parsed.data.payoutIdToCancel });
  revalidatePayPalScreens();
  switch (outcome.status) {
    case 'cancelled':
      return {
        ok: true,
        message: outcome.recorded
          ? 'The payment was stopped at PayPal: the money is back in your PayPal balance and the commissions went back to what is owed. The partner was emailed. PayPal is not tried at that payout email again until the partner saves it again: pay them under Payouts → Pay manually meanwhile.'
          : 'The payment was stopped at PayPal: the money is back in your PayPal balance. Its commissions go back to what is owed with the next PayPal check (Check PayPal status now).',
      };
    case 'released':
      return {
        ok: true,
        message:
          'The payout was released: its commissions went back to what is owed. The next payout run that sends PayPal payouts (automatic payouts on, or Run payouts now) pays them again.',
      };
    case 'completed':
      return { ok: true, message: 'PayPal had already paid this payout, so it was not stopped: it is now recorded as paid.' };
    case 'failed':
      return { ok: true, message: 'PayPal had already returned or refused this payout: its commissions went back to what is owed.' };
    case 'still_in_flight':
      return {
        ok: false,
        error: `PayPal no longer lists this payout as unclaimed${outcome.itemStatus ? ` (${outcome.itemStatus})` : ''}, so it was not stopped.`,
      };
    case 'not_found':
      return { ok: false, error: 'That PayPal payout is no longer in flight. Reload the page.' };
    case 'not_cancellable':
      return {
        ok: false,
        error:
          'Nothing changed: only a payment PayPal lists as unclaimed can be stopped. A payout PayPal never confirmed can be released an hour after its last send, and one PayPal accepted but never settled a week after it, while PayPal lists no pending, on-hold, unclaimed or paid status for it.',
      };
    case 'not_configured':
      return { ok: false, error: "No PayPal credentials are configured for this payout's environment, so PayPal could not be asked. Nothing changed." };
    case 'unavailable':
      return { ok: false, error: 'PayPal could not be reached, so nothing changed. Try again in a moment.' };
    case 'paypal_error':
      return {
        ok: false,
        error: `PayPal answered with an error${outcome.code ? ` (${outcome.code})` : ''}, so the payment was not stopped and nothing changed. Try again later; an unclaimed payment also comes back to your PayPal balance by itself after 30 days.${outcome.debugId ? ` PayPal debug id: ${outcome.debugId}.` : ''}`,
      };
    case 'invalid_input':
      return { ok: false, error: INVALID_INPUT };
    case 'unknown':
      return { ok: false, error: 'The payout could not be stopped or released. Check PayPal status now, then try again.' };
    default:
      return { ok: false, error: REFUSALS[outcome.status] ?? INVALID_INPUT };
  }
}
