import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AFFILIATE_ALERT_TYPES,
  affiliateGatewaysPaidByPayPal,
  type AffiliateGateway,
  type AffiliatesSettings,
} from '@nextblock-cms/affiliates';
import {
  normalizeAffiliatePayoutRow,
  normalizeAffiliateRows,
  normalizeAffiliateUuid,
  type AffiliateRepositoryClient,
} from '@nextblock-cms/affiliates/server';
import { requireCmsAdmin } from '../../auth/cms-actor';
import { getAffiliateStoreBaseCurrency } from '../admin-data';
import { isAffiliatesProgramActive } from '../package-state';
import { getAffiliatesSettings, readAffiliatesSettingsStrict } from '../settings';
import {
  AFFILIATE_PAYPAL_BALANCES_SCOPE,
  AFFILIATE_PAYPAL_PAYOUTS_SCOPE,
  createAffiliatePayPalClient,
  isAffiliatePayPalError,
  type AffiliatePayPalEnvironment,
} from './client';
import {
  getAffiliatePayPalCredentialStatus,
  previewAffiliatePayPalCredentials,
  resolveAffiliatePayPalCredentials,
  storeAffiliatePayPalCredentials,
  type AffiliatePayPalCredentialStatus,
} from './credentials';
import {
  affiliatePayPalReleaseKind,
  cancelAffiliatePayPalPayout,
  type AffiliatePayPalAlertKind,
  type AffiliatePayPalCancelOutcome,
  type AffiliatePayPalRunSummary,
} from './engine';
import { affiliatePayPalStepHooks, runAffiliatePayPalStep } from './runner';

/**
 * The CMS Affiliates → PayPal payouts screen (`/cms/affiliates/paypal`, 02037): the facts it shows and
 * the work behind its buttons. Each export checks the ADMIN itself first (`requireCmsAdmin()`: session,
 * second factor, role), then the public sandbox (PayPal is never called and no credential is read or
 * saved there), then the package, and reads or writes with the service role after that.
 *
 * - {@link loadAffiliatePayPalPayoutsOverview}: the status card (environment, where the credentials come
 *   from, the client id's last 4 characters, whether the token carries the Payouts scope), the PayPal
 *   payouts in flight with their item status, the recent failures and the open PayPal alerts.
 * - {@link testAffiliatePayPalConnectionNow}: a fresh token, the Payouts scope, the app id and, when the
 *   scope allows, the balance. Nothing is sent.
 * - {@link saveAffiliatePayPalCredentialsNow}: verifies the credentials with PayPal first and refuses
 *   any PayPal rejects (or when PayPal cannot be reached), then saves them encrypted.
 * - {@link syncAffiliatePayPalPayoutsNow}: "Check PayPal status now", the run's sync alone.
 * - {@link cancelAffiliatePayPalPayoutNow}: "Cancel" an unclaimed PayPal payout (at PayPal, then its
 *   commissions go back), or release one PayPal never confirmed.
 */

type AnyClient = SupabaseClient<any>;

const PAGE_SIZE = 200;
const ID_CHUNK = 100;

function isPayPalSandboxDeployment(): boolean {
  return process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';
}

async function programActive(): Promise<boolean> {
  try {
    return await isAffiliatesProgramActive();
  } catch {
    return false;
  }
}

export type AffiliatePayPalAdminRefusal = 'forbidden' | 'sandbox' | 'package_inactive';

type AdminGate = { ok: true; db: AnyClient } | { ok: false; reason: AffiliatePayPalAdminRefusal };

/** The ADMIN first (whatever the caller did), then the sandbox, then the package. */
async function authorizePayPalAdmin(): Promise<AdminGate> {
  let db: AnyClient;
  try {
    db = (await requireCmsAdmin()).supabase as unknown as AnyClient;
  } catch {
    return { ok: false, reason: 'forbidden' };
  }
  if (isPayPalSandboxDeployment()) return { ok: false, reason: 'sandbox' };
  if (!(await programActive())) return { ok: false, reason: 'package_inactive' };
  return { ok: true, db };
}

/* -------------------------------------------------------------------- overview --- */

export interface AffiliatePayPalInFlightRow {
  payoutId: string;
  affiliateId: string;
  handle: string;
  displayName: string;
  receiver: string | null;
  amountCents: number;
  currency: string;
  environment: AffiliatePayPalEnvironment;
  itemStatus: string | null;
  batchId: string | null;
  /** Sent, with an unknown outcome, when there is a sender id and no batch id. */
  senderBatchId: string | null;
  createdAt: string;
  lastAttemptAt: string;
  checkedAt: string | null;
  /**
   * `cancel`: PayPal lists the item as UNCLAIMED ("Stop payment"); `release`: PayPal never confirmed
   * its batch (an hour after the last send); `release_acknowledged`: PayPal accepted the batch but never
   * settled the payout (a week after the last send, no status PayPal holds money in). The database
   * checks the release rule again under the payout lock.
   */
  action: 'cancel' | 'release' | 'release_acknowledged' | null;
}

export interface AffiliatePayPalFailedRow {
  payoutId: string;
  handle: string;
  amountCents: number;
  currency: string;
  reason: string | null;
  itemStatus: string | null;
  environment: AffiliatePayPalEnvironment;
  failedAt: string;
}

export interface AffiliatePayPalAlertRow {
  id: string;
  title: string;
  message: string;
  kind: string;
  createdAt: string;
}

export interface AffiliatePayPalConnectionState {
  /** PayPal was asked (credentials resolve, not the sandbox). */
  checked: boolean;
  /** The token carries the Payouts scope; null when not checked or PayPal could not answer. */
  payoutsEnabled: boolean | null;
  appId: string | null;
  error: 'credentials' | 'unavailable' | null;
}

export interface AffiliatePayPalPayoutsOverview {
  sandbox: boolean;
  credentials: AffiliatePayPalCredentialStatus;
  connection: AffiliatePayPalConnectionState;
  settings: AffiliatesSettings | null;
  /** The gateways the program pays with PayPal. */
  paypalGateways: AffiliateGateway[];
  baseCurrency: string;
  inFlight: { rows: AffiliatePayPalInFlightRow[]; total: number } | null;
  recentFailed: AffiliatePayPalFailedRow[] | null;
  alerts: AffiliatePayPalAlertRow[];
}

async function readHandles(db: AnyClient, affiliateIds: readonly string[]): Promise<Map<string, { handle: string; displayName: string }>> {
  const handles = new Map<string, { handle: string; displayName: string }>();
  const ids = [...new Set(affiliateIds)];
  for (let index = 0; index < ids.length; index += ID_CHUNK) {
    const { data, error } = await db.from('affiliate_profiles').select('id, handle, display_name').in('id', ids.slice(index, index + ID_CHUNK));
    if (error) throw new Error('Could not read partner handles.', { cause: error });
    for (const row of Array.isArray(data) ? (data as Array<Record<string, unknown>>) : []) {
      if (typeof row['id'] === 'string') {
        handles.set(row['id'], {
          handle: typeof row['handle'] === 'string' ? row['handle'] : '',
          displayName: typeof row['display_name'] === 'string' ? row['display_name'] : '',
        });
      }
    }
  }
  return handles;
}

async function readInFlightRows(db: AnyClient, now: Date): Promise<{ rows: AffiliatePayPalInFlightRow[]; total: number }> {
  const { data, error, count } = await db
    .from('affiliate_payouts')
    .select('*', { count: 'exact' })
    .eq('method', 'paypal')
    .eq('status', 'PROCESSING')
    .order('created_at', { ascending: true })
    .limit(PAGE_SIZE);
  if (error) throw new Error('Could not read the PayPal payouts in flight.', { cause: error });
  const payouts = normalizeAffiliateRows(data, normalizeAffiliatePayoutRow);
  const handles = await readHandles(db, payouts.map((payout) => payout.affiliate_id));
  const rows = payouts.map((payout): AffiliatePayPalInFlightRow => {
    const release = affiliatePayPalReleaseKind(payout, now);
    const cancel = Boolean(payout.paypal_item_id) && payout.paypal_item_status === 'UNCLAIMED';
    return {
      payoutId: payout.id,
      affiliateId: payout.affiliate_id,
      handle: handles.get(payout.affiliate_id)?.handle ?? '',
      displayName: handles.get(payout.affiliate_id)?.displayName ?? '',
      receiver: payout.paypal_receiver ?? null,
      amountCents: payout.amount_cents,
      currency: payout.currency,
      environment: payout.livemode === false ? 'sandbox' : 'live',
      itemStatus: payout.paypal_item_status ?? null,
      batchId: payout.paypal_batch_id ?? null,
      senderBatchId: payout.paypal_sender_batch_id ?? null,
      createdAt: payout.created_at,
      lastAttemptAt: payout.last_attempt_at,
      checkedAt: payout.paypal_checked_at ?? null,
      action: cancel ? 'cancel' : release === 'unconfirmed' ? 'release' : release === 'acknowledged' ? 'release_acknowledged' : null,
    };
  });
  return { rows, total: typeof count === 'number' ? count : rows.length };
}

async function readRecentFailed(db: AnyClient): Promise<AffiliatePayPalFailedRow[]> {
  const { data, error } = await db
    .from('affiliate_payouts')
    .select('*')
    .eq('method', 'paypal')
    .eq('status', 'FAILED')
    .order('updated_at', { ascending: false })
    .limit(20);
  if (error) throw new Error('Could not read the failed PayPal payouts.', { cause: error });
  const payouts = normalizeAffiliateRows(data, normalizeAffiliatePayoutRow);
  const handles = await readHandles(db, payouts.map((payout) => payout.affiliate_id));
  return payouts.map((payout) => ({
    payoutId: payout.id,
    handle: handles.get(payout.affiliate_id)?.handle ?? '',
    amountCents: payout.amount_cents,
    currency: payout.currency,
    reason: payout.failure_reason,
    itemStatus: payout.paypal_item_status ?? null,
    environment: payout.livemode === false ? 'sandbox' : 'live',
    failedAt: payout.updated_at,
  }));
}

/** `metadata.kind` of the operator alerts the PayPal step raises (`events.ts`). */
export const AFFILIATE_PAYPAL_ALERT_KINDS = [
  'paypal_insufficient_funds',
  'paypal_not_enabled',
  'paypal_credentials',
  'paypal_refused',
  'paypal_unknown_status',
  'paypal_batch_unresolved',
  'paypal_currency_unsupported',
] as const satisfies readonly AffiliatePayPalAlertKind[];

async function readPayPalAlerts(db: AnyClient): Promise<AffiliatePayPalAlertRow[]> {
  const { data, error } = await db
    .from('system_alerts')
    .select('id, title, message, metadata, created_at')
    .eq('alert_type', AFFILIATE_ALERT_TYPES.PAYOUT_FAILED)
    .eq('is_resolved', false)
    .in('metadata->>kind', [...AFFILIATE_PAYPAL_ALERT_KINDS])
    .order('created_at', { ascending: false })
    .limit(5);
  if (error) return [];
  return (Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [])
    .filter((row) => typeof row['id'] === 'string')
    .map((row) => {
      const metadata = row['metadata'] && typeof row['metadata'] === 'object' ? (row['metadata'] as Record<string, unknown>) : {};
      return {
        id: row['id'] as string,
        title: typeof row['title'] === 'string' ? row['title'] : '',
        message: typeof row['message'] === 'string' ? row['message'] : '',
        kind: typeof metadata['kind'] === 'string' ? metadata['kind'] : '',
        createdAt: typeof row['created_at'] === 'string' ? row['created_at'] : '',
      };
    });
}

async function checkConnection(environment: AffiliatePayPalEnvironment): Promise<AffiliatePayPalConnectionState> {
  const credentials = await resolveAffiliatePayPalCredentials(environment);
  if (!credentials) return { checked: false, payoutsEnabled: null, appId: null, error: null };
  try {
    const token = await createAffiliatePayPalClient(credentials).getToken();
    return { checked: true, payoutsEnabled: token.scopes.includes(AFFILIATE_PAYPAL_PAYOUTS_SCOPE), appId: token.appId, error: null };
  } catch (error) {
    const rejected = isAffiliatePayPalError(error) && error.kind === 'credentials';
    console.warn(`[affiliates] PayPal status check failed (${isAffiliatePayPalError(error) ? error.kind : 'unknown'})`);
    return { checked: true, payoutsEnabled: null, appId: null, error: rejected ? 'credentials' : 'unavailable' };
  }
}

/**
 * Everything `/cms/affiliates/paypal` renders (ADMIN only, re-checked here; reads with the service
 * role). Each part comes back empty when its read fails; the sandbox gets no credential fact and asks
 * PayPal nothing. Throws only the admin check's error.
 */
export async function loadAffiliatePayPalPayoutsOverview(now: Date = new Date()): Promise<AffiliatePayPalPayoutsOverview> {
  const { supabase } = await requireCmsAdmin();
  const db = supabase as unknown as AnyClient;
  const sandbox = isPayPalSandboxDeployment();
  const [credentials, settings, baseCurrency] = await Promise.all([
    getAffiliatePayPalCredentialStatus(),
    getAffiliatesSettings().catch(() => null),
    getAffiliateStoreBaseCurrency(db as unknown as AffiliateRepositoryClient),
  ]);
  const [connection, inFlight, recentFailed, alerts] = await Promise.all([
    sandbox ? Promise.resolve<AffiliatePayPalConnectionState>({ checked: false, payoutsEnabled: null, appId: null, error: null }) : checkConnection(credentials.environment),
    readInFlightRows(db, now).catch((error: unknown) => {
      console.error('[affiliates] PayPal payouts in flight could not be read', { code: codeOf(error) });
      return null;
    }),
    readRecentFailed(db).catch((error: unknown) => {
      console.error('[affiliates] Failed PayPal payouts could not be read', { code: codeOf(error) });
      return null;
    }),
    readPayPalAlerts(db),
  ]);
  return {
    sandbox,
    credentials,
    connection,
    settings,
    paypalGateways: settings ? affiliateGatewaysPaidByPayPal(settings) : [],
    baseCurrency,
    inFlight,
    recentFailed,
    alerts,
  };
}

function codeOf(error: unknown): unknown {
  const cause = error && typeof error === 'object' ? (error as { cause?: unknown }).cause : null;
  return cause && typeof cause === 'object' ? (cause as { code?: unknown }).code ?? null : null;
}

/* ------------------------------------------------------------- test connection --- */

export type AffiliatePayPalConnectionTestResult =
  | {
      ok: true;
      environment: AffiliatePayPalEnvironment;
      source: 'cms' | 'env';
      clientIdLast4: string | null;
      appId: string | null;
      payoutsEnabled: boolean;
      /** Available balance per currency, when the token may read it (null otherwise or on failure). */
      balances: Array<{ currency: string; availableCents: number | null; primary: boolean }> | null;
      storeCurrency: string;
    }
  | { ok: false; reason: AffiliatePayPalAdminRefusal | 'not_configured' | 'credentials' | 'unavailable' };

/**
 * "Test connection": a fresh token for the active environment's credentials, the Payouts scope (the
 * read-only proof PayPal enabled Payouts: there is no dry run), the app id and, when the token may
 * read balances, `GET /v1/reporting/balances`. Nothing is sent. Never throws.
 */
export async function testAffiliatePayPalConnectionNow(): Promise<AffiliatePayPalConnectionTestResult> {
  const gate = await authorizePayPalAdmin();
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const credentials = await resolveAffiliatePayPalCredentials();
  if (!credentials) return { ok: false, reason: 'not_configured' };
  const client = createAffiliatePayPalClient(credentials);
  let token;
  try {
    token = await client.getToken({ fresh: true });
  } catch (error) {
    console.warn(`[affiliates] PayPal connection test failed (${isAffiliatePayPalError(error) ? error.kind : 'unknown'})`);
    return { ok: false, reason: isAffiliatePayPalError(error) && error.kind === 'credentials' ? 'credentials' : 'unavailable' };
  }
  let balances: Array<{ currency: string; availableCents: number | null; primary: boolean }> | null = null;
  if (token.scopes.includes(AFFILIATE_PAYPAL_BALANCES_SCOPE)) {
    try {
      balances = await client.getBalances();
    } catch (error) {
      console.warn(`[affiliates] PayPal balance read failed (${isAffiliatePayPalError(error) ? error.kind : 'unknown'})`);
    }
  }
  return {
    ok: true,
    environment: credentials.environment,
    source: credentials.source,
    clientIdLast4: credentials.clientId.length >= 8 ? credentials.clientId.slice(-4) : null,
    appId: token.appId,
    payoutsEnabled: token.scopes.includes(AFFILIATE_PAYPAL_PAYOUTS_SCOPE),
    balances,
    storeCurrency: await getAffiliateStoreBaseCurrency(gate.db as unknown as AffiliateRepositoryClient),
  };
}

/* ---------------------------------------------------------------- credentials --- */

export interface SaveAffiliatePayPalCredentialsInput {
  environment: AffiliatePayPalEnvironment;
  /** Blank: keep the client id saved for that environment (or use the environment variables). */
  clientId?: string | null;
  /** Blank: keep the saved secret. Write-only: never read back. */
  secret?: string | null;
}

export type SaveAffiliatePayPalCredentialsOutcome =
  | { status: 'saved'; environment: AffiliatePayPalEnvironment; payoutsEnabled: boolean; clientIdLast4: string | null }
  | { status: AffiliatePayPalAdminRefusal | 'missing_credentials' | 'rejected' | 'unavailable' | 'unknown' };

/**
 * Saves the PayPal credentials after PayPal accepted them, like the Cortex setup verifies a key
 * before saving it: a fresh token request with the typed (or kept) client id and secret; a rejection
 * (401, `invalid_client`) or an unreachable PayPal saves nothing. The environment becomes the active
 * one. Never throws.
 */
export async function saveAffiliatePayPalCredentialsNow(input: SaveAffiliatePayPalCredentialsInput): Promise<SaveAffiliatePayPalCredentialsOutcome> {
  const gate = await authorizePayPalAdmin();
  if (!gate.ok) return { status: gate.reason };
  const candidate = await previewAffiliatePayPalCredentials(input);
  if (!candidate) return { status: 'missing_credentials' };
  let payoutsEnabled: boolean;
  try {
    const token = await createAffiliatePayPalClient(candidate).getToken({ fresh: true });
    payoutsEnabled = token.scopes.includes(AFFILIATE_PAYPAL_PAYOUTS_SCOPE);
  } catch (error) {
    if (isAffiliatePayPalError(error) && error.kind === 'credentials') return { status: 'rejected' };
    console.warn(`[affiliates] PayPal credentials could not be verified (${isAffiliatePayPalError(error) ? error.kind : 'unknown'})`);
    return { status: 'unavailable' };
  }
  try {
    await storeAffiliatePayPalCredentials(input);
  } catch {
    return { status: 'unknown' };
  }
  return {
    status: 'saved',
    environment: input.environment,
    payoutsEnabled,
    clientIdLast4: candidate.clientId.length >= 8 ? candidate.clientId.slice(-4) : null,
  };
}

/* ------------------------------------------------------------ status, cancel --- */

export type SyncAffiliatePayPalPayoutsOutcome =
  /** `autoPayoutsEnabled`: whether the daily run sends again the batches still waiting for PayPal's answer. */
  | { status: 'synced'; summary: AffiliatePayPalRunSummary; autoPayoutsEnabled: boolean }
  | { status: AffiliatePayPalAdminRefusal | 'settings_unavailable' | 'unavailable' };

/** "Check PayPal status now": the payout run's PayPal sync alone (nothing is claimed or sent). Never throws. */
export async function syncAffiliatePayPalPayoutsNow(): Promise<SyncAffiliatePayPalPayoutsOutcome> {
  const gate = await authorizePayPalAdmin();
  if (!gate.ok) return { status: gate.reason };
  const settings = await readAffiliatesSettingsStrict();
  if (!settings) return { status: 'settings_unavailable' };
  const summary = await runAffiliatePayPalStep({ trigger: 'admin', settings, send: false, timeBudgetMs: 40_000 });
  return summary ? { status: 'synced', summary, autoPayoutsEnabled: settings.autoPayoutsEnabled } : { status: 'unavailable' };
}

export type CancelAffiliatePayPalPayoutOutcome =
  | AffiliatePayPalCancelOutcome
  | { status: AffiliatePayPalAdminRefusal | 'invalid_input' | 'unknown' };

/**
 * "Cancel" on the PayPal payouts screen: an UNCLAIMED item is cancelled at PayPal (then its payout
 * fails and its commissions go back to what is owed), a payout PayPal never confirmed is released.
 * PayPal's current answer decides: a paid item completes the payout instead. Never throws.
 */
export async function cancelAffiliatePayPalPayoutNow(input: { payoutIdToCancel: string }): Promise<CancelAffiliatePayPalPayoutOutcome> {
  const gate = await authorizePayPalAdmin();
  if (!gate.ok) return { status: gate.reason };
  const payoutId = normalizeAffiliateUuid(input.payoutIdToCancel);
  if (!payoutId) return { status: 'invalid_input' };
  try {
    return await cancelAffiliatePayPalPayout(
      {
        supabase: gate.db as unknown as AffiliateRepositoryClient,
        credentialsFor: (environment) => resolveAffiliatePayPalCredentials(environment),
        hooks: affiliatePayPalStepHooks(gate.db),
      },
      payoutId
    );
  } catch (error) {
    console.error('[affiliates] Cancelling a PayPal payout failed', { code: codeOf(error) });
    return { status: 'unknown' };
  }
}
