import 'server-only';

import { createHash } from 'node:crypto';
import { getCurrencyMinorUnitFactor } from '@nextblock-cms/utils';
import { z } from '../../zod-config';

/**
 * The PayPal Payouts REST client of the Affiliates program (02037, docs/15 → "Paying partners with
 * PayPal"). Pure: the caller passes the credentials (resolved by `credentials.ts`) and may pass a
 * `fetch`, so every call is unit-tested without the network. Nothing here reads the database or the
 * environment, except the public sandbox flag: on `NEXT_PUBLIC_IS_SANDBOX=true` PayPal is never
 * called ({@link sendAffiliatePayPalRequest} refuses before any request).
 *
 * - The API host comes only from the environment choice (`sandbox` → api-m.sandbox.paypal.com,
 *   `live` → api-m.paypal.com): no caller supplies a URL, paths are fixed `/v1/…` routes and every
 *   id that goes into a path is checked against PayPal's id shape first. Redirects are refused (the
 *   bearer token must never follow one).
 * - OAuth2 client credentials (`POST /v1/oauth2/token`, HTTP Basic). The token is cached per
 *   environment and credentials (a hash of the three, so new credentials never reuse an old token)
 *   until five minutes before it expires; {@link clearAffiliatePayPalTokenCache} drops every entry
 *   (the CMS calls it after saving credentials). A 401 on an API call drops the token and retries
 *   once with a fresh one.
 * - Every response is untrusted input: bodies are capped, parsed as JSON and validated with zod;
 *   only the fields the program uses survive, each in a checked shape.
 * - Errors become {@link AffiliatePayPalError} with a `kind` the engine acts on: `credentials` (401,
 *   `invalid_client`), `not_enabled` (403, NOT_AUTHORIZED, AUTHORIZATION_ERROR, REQUIRED_SCOPE_MISSING,
 *   PERMISSION_DENIED), `insufficient_funds`, `rate_limited` (429, RATE_LIMIT_REACHED),
 *   `duplicate_batch` (a sender_batch_id PayPal already holds; `batchId` names the original batch when
 *   PayPal links it), `not_found`, `refused` (any other 4xx: definitive), `unavailable` (5xx, a network
 *   error, a timeout: the outcome is unknown) and `malformed` (a 2xx body that does not validate: the
 *   outcome is unknown too). The error carries PayPal's error name and debug id, never the body.
 */

export type AffiliatePayPalEnvironment = 'sandbox' | 'live';

export const AFFILIATE_PAYPAL_ENVIRONMENTS = ['sandbox', 'live'] as const satisfies readonly AffiliatePayPalEnvironment[];

/** The only hosts this client talks to, by environment. */
export const AFFILIATE_PAYPAL_API_BASE_URLS: Readonly<Record<AffiliatePayPalEnvironment, string>> = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
};

/** The token scope that proves the app may use Payouts (there is no dry run). */
export const AFFILIATE_PAYPAL_PAYOUTS_SCOPE = 'https://uri.paypal.com/payments/payouts';

/** The token scope that lets "Test connection" read the PayPal balance. */
export const AFFILIATE_PAYPAL_BALANCES_SCOPE = 'https://uri.paypal.com/services/reporting/balances/read';

/** Where a Canadian business account asks PayPal to enable Payouts. */
export const AFFILIATE_PAYPAL_REQUEST_ACCESS_URL =
  'https://www.paypal.com/unifiedonboarding/entry?country.x=CA&locale.x=en_CA&products=PAYOUTS';

/** PayPal's limits: items per batch, and `GET /v1/payments/payouts/{id}` page size. */
export const AFFILIATE_PAYPAL_MAX_BATCH_ITEMS = 15000;
export const AFFILIATE_PAYPAL_BATCH_PAGE_SIZE = 1000;

/** PayPal's `sender_item_id` limit. */
export const AFFILIATE_PAYPAL_SENDER_ITEM_ID_MAX_LENGTH = 63;

/**
 * The currencies PayPal Payouts sends (PayPal's REST currency codes, developer.paypal.com → currency
 * codes). A store whose currency is not one of them cannot pay partners with PayPal Payouts: the run
 * skips it with an alert and Pay manually lists those partners.
 */
export const AFFILIATE_PAYPAL_PAYOUT_CURRENCIES = [
  'AUD',
  'BRL',
  'CAD',
  'CHF',
  'CNY',
  'CZK',
  'DKK',
  'EUR',
  'GBP',
  'HKD',
  'HUF',
  'ILS',
  'JPY',
  'MXN',
  'MYR',
  'NOK',
  'NZD',
  'PHP',
  'PLN',
  'SEK',
  'SGD',
  'THB',
  'TWD',
  'USD',
] as const;

/** PayPal takes these in whole units only ("does not support decimals"): an amount with a fraction is refused. */
export const AFFILIATE_PAYPAL_ZERO_DECIMAL_CURRENCIES = ['HUF', 'JPY', 'TWD'] as const;

const PAYOUT_CURRENCIES: ReadonlySet<string> = new Set(AFFILIATE_PAYPAL_PAYOUT_CURRENCIES);
const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set(AFFILIATE_PAYPAL_ZERO_DECIMAL_CURRENCIES);

/** Whether PayPal Payouts sends this currency. */
export function isAffiliatePayPalPayoutCurrency(currency: unknown): boolean {
  return typeof currency === 'string' && PAYOUT_CURRENCIES.has(currency.trim().toUpperCase());
}

/** Whether PayPal takes this currency in whole units only (HUF, JPY, TWD). */
export function isAffiliatePayPalZeroDecimalCurrency(currency: unknown): boolean {
  return typeof currency === 'string' && ZERO_DECIMAL_CURRENCIES.has(currency.trim().toUpperCase());
}

/** A PayPal id as it may appear in a request path or the database (02037 CHECKs the same shape). */
export const AFFILIATE_PAYPAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** A `sender_batch_id` (and PayPal-Request-Id) this client sends. */
export const AFFILIATE_PAYPAL_SENDER_BATCH_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** A PayPal status or error name (`SUCCESS`, `RECEIVER_UNREGISTERED`). */
const STATUS_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

const DEFAULT_TIMEOUTS = { token: 10_000, read: 15_000, write: 20_000 } as const;

/** Bodies above this are refused (a batch page of 1,000 items is well under it). */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/** A cached token is renewed this long before PayPal's expiry. */
const TOKEN_RENEW_MARGIN_MS = 5 * 60 * 1000;

export interface AffiliatePayPalCredentials {
  environment: AffiliatePayPalEnvironment;
  clientId: string;
  secret: string;
}

export type AffiliatePayPalErrorKind =
  | 'sandbox'
  | 'credentials'
  | 'not_enabled'
  | 'insufficient_funds'
  | 'rate_limited'
  | 'duplicate_batch'
  | 'not_found'
  | 'refused'
  | 'unavailable'
  | 'malformed';

/** A refused or failed PayPal call. The message is generic: it may reach logs and run summaries. */
export class AffiliatePayPalError extends Error {
  readonly kind: AffiliatePayPalErrorKind;
  /** HTTP status, when PayPal answered. */
  readonly status: number | null;
  /** PayPal's error name (`INSUFFICIENT_FUNDS`, `invalid_client` upper-cased), checked; null otherwise. */
  readonly code: string | null;
  /** PayPal's debug id, for a support ticket. */
  readonly debugId: string | null;
  /** `duplicate_batch`: the original batch PayPal linked, when it did. */
  readonly batchId: string | null;

  constructor(
    kind: AffiliatePayPalErrorKind,
    details: { status?: number | null; code?: string | null; debugId?: string | null; batchId?: string | null; cause?: unknown } = {}
  ) {
    super(`PayPal request failed (${kind})`, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'AffiliatePayPalError';
    this.kind = kind;
    this.status = typeof details.status === 'number' ? details.status : null;
    this.code = typeof details.code === 'string' && STATUS_PATTERN.test(details.code) ? details.code : null;
    this.debugId = typeof details.debugId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(details.debugId) ? details.debugId : null;
    this.batchId = typeof details.batchId === 'string' && AFFILIATE_PAYPAL_ID_PATTERN.test(details.batchId) ? details.batchId : null;
  }
}

export function isAffiliatePayPalError(error: unknown): error is AffiliatePayPalError {
  return error instanceof AffiliatePayPalError;
}

export function isAffiliatePayPalEnvironment(value: unknown): value is AffiliatePayPalEnvironment {
  return value === 'sandbox' || value === 'live';
}

/* --------------------------------------------------------------------- schemas --- */

const idSchema = z.string().regex(AFFILIATE_PAYPAL_ID_PATTERN);
const statusSchema = z.string().regex(STATUS_PATTERN);
const moneySchema = z.object({
  value: z.string().regex(/^-?\d{1,15}(?:\.\d{1,8})?$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

const tokenSchema = z.object({
  access_token: z.string().min(1).max(8192),
  token_type: z.string().regex(/^bearer$/i),
  expires_in: z.number().int().positive().max(10 * 24 * 60 * 60),
  scope: z.string().max(10_000).optional(),
  app_id: z.string().max(200).optional(),
});

const linkSchema = z.object({ href: z.string().max(2048), rel: z.string().max(100).optional(), method: z.string().max(10).optional() });

const errorBodySchema = z.object({
  name: z.string().max(200).optional(),
  error: z.string().max(200).optional(),
  debug_id: z.string().max(200).optional(),
  details: z.array(z.object({ issue: z.string().max(200).optional() })).max(100).optional(),
  links: z.array(linkSchema).max(50).optional(),
});

const batchHeaderSchema = z.object({
  payout_batch_id: idSchema,
  batch_status: statusSchema.nullish(),
  sender_batch_header: z.object({ sender_batch_id: z.string().max(256).nullish() }).nullish(),
});

const createdBatchSchema = z.object({ batch_header: batchHeaderSchema });

const itemSchema = z.object({
  payout_item_id: idSchema,
  transaction_id: idSchema.optional().nullable(),
  transaction_status: statusSchema.optional().nullable(),
  payout_item_fee: moneySchema.optional().nullable(),
  payout_batch_id: idSchema.optional().nullable(),
  payout_item: z
    .object({
      sender_item_id: z.string().max(AFFILIATE_PAYPAL_SENDER_ITEM_ID_MAX_LENGTH).optional().nullable(),
      receiver: z.string().max(254).optional().nullable(),
      amount: moneySchema.optional().nullable(),
    })
    .optional()
    .nullable(),
  errors: z.object({ name: z.string().max(200).optional().nullable() }).optional().nullable(),
});

const batchSchema = z.object({
  batch_header: batchHeaderSchema,
  items: z.array(itemSchema).max(AFFILIATE_PAYPAL_BATCH_PAGE_SIZE).optional(),
  total_items: z.number().int().nonnegative().optional(),
  total_pages: z.number().int().nonnegative().optional(),
});

const balancesSchema = z.object({
  balances: z
    .array(
      z.object({
        currency: z.string().regex(/^[A-Z]{3}$/),
        primary: z.boolean().optional(),
        available_balance: z.object({ value: z.string().regex(/^-?\d{1,15}(?:\.\d{1,8})?$/), currency_code: z.string().regex(/^[A-Z]{3}$/) }).optional(),
      })
    )
    .max(100)
    .optional(),
});

/* ----------------------------------------------------------------------- types --- */

export interface AffiliatePayPalToken {
  accessToken: string;
  /** The token's scopes (space-separated in PayPal's answer). */
  scopes: string[];
  /** The REST app's id, when PayPal names it. */
  appId: string | null;
  /** When the client renews it (ms since epoch). */
  expiresAt: number;
}

export interface AffiliatePayPalCreateBatchItem {
  /** The partner's PayPal email (the payout's `paypal_receiver` snapshot). */
  receiver: string;
  amountCents: number;
  currency: string;
  /** Shown to the partner in PayPal's email (up to 400 characters here). */
  note: string;
  /** The payout's id: how a batch item finds its payout again. */
  senderItemId: string;
}

export interface AffiliatePayPalCreateBatchInput {
  /** Saved on the payouts before this call; also the PayPal-Request-Id. */
  senderBatchId: string;
  /** PayPal's email subject (ASCII only, at most 255 characters here). */
  emailSubject: string;
  /** PayPal's email message (at most 1,000 characters here). */
  emailMessage: string;
  items: readonly AffiliatePayPalCreateBatchItem[];
}

export interface AffiliatePayPalCreatedBatch {
  batchId: string;
  status: string | null;
}

export interface AffiliatePayPalItem {
  itemId: string;
  transactionId: string | null;
  status: string | null;
  /** The fee in minor units of `feeCurrency`, or null. */
  feeCents: number | null;
  feeCurrency: string | null;
  senderItemId: string | null;
  batchId: string | null;
  /** PayPal's error name for a failed item (`RECEIVER_UNREGISTERED`), checked. */
  errorName: string | null;
}

export interface AffiliatePayPalBatch {
  batchId: string;
  status: string | null;
  items: AffiliatePayPalItem[];
  totalPages: number | null;
}

export interface AffiliatePayPalBalance {
  currency: string;
  primary: boolean;
  /** Available balance in minor units of `currency`, or null when PayPal gave none. */
  availableCents: number | null;
}

export interface AffiliatePayPalClient {
  readonly environment: AffiliatePayPalEnvironment;
  /** A token from the cache, or a new one (`fresh`: skip and replace the cache, e.g. to test credentials). */
  getToken(options?: { fresh?: boolean }): Promise<AffiliatePayPalToken>;
  createPayoutBatch(input: AffiliatePayPalCreateBatchInput): Promise<AffiliatePayPalCreatedBatch>;
  /** One page of a batch (`pageSize` at most 1,000). */
  getPayoutBatch(batchId: string, options?: { page?: number; pageSize?: number }): Promise<AffiliatePayPalBatch>;
  /** Every item of a batch, page after page (at most `maxPages`, default 20). */
  getPayoutBatchItems(batchId: string, options?: { maxPages?: number }): Promise<AffiliatePayPalBatch>;
  getPayoutItem(itemId: string): Promise<AffiliatePayPalItem>;
  /** Only works while the item is UNCLAIMED; PayPal answers the item, then RETURNED. */
  cancelPayoutItem(itemId: string): Promise<AffiliatePayPalItem>;
  /** Needs the balances scope; PayPal may take hours to show a new balance. */
  getBalances(): Promise<AffiliatePayPalBalance[]>;
}

export interface AffiliatePayPalClientOptions {
  fetch?: typeof fetch;
  now?: () => number;
  timeouts?: Partial<{ token: number; read: number; write: number }>;
}

/* ----------------------------------------------------------------- the request --- */

export interface AffiliatePayPalRequest {
  environment: AffiliatePayPalEnvironment;
  /** A fixed `/v1/…` route of PayPal's REST API. */
  path: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export interface AffiliatePayPalResponse {
  status: number;
  body: unknown;
}

async function readCappedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new AffiliatePayPalError('malformed', { status: response.status });
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new AffiliatePayPalError('malformed', { status: response.status });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

/**
 * The one place a request reaches PayPal. Refuses on the public sandbox before anything else (its
 * env credentials belong to the operator, and visitors share its admin login), builds the URL from
 * the environment's fixed host and a `/v1/` path, refuses redirects, aborts after `timeoutMs`, caps
 * the body and parses it as JSON. Throws {@link AffiliatePayPalError} `sandbox`, `refused` (a bad
 * path or environment), `unavailable` (network, timeout) or `malformed` (an oversized body); any
 * HTTP status comes back as is.
 */
export async function sendAffiliatePayPalRequest(request: AffiliatePayPalRequest): Promise<AffiliatePayPalResponse> {
  if (process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') throw new AffiliatePayPalError('sandbox');
  if (!isAffiliatePayPalEnvironment(request.environment)) throw new AffiliatePayPalError('refused');
  if (!/^\/v1\/[A-Za-z0-9/_?&=.,-]+$/.test(request.path) || request.path.includes('..')) throw new AffiliatePayPalError('refused');
  const url = `${AFFILIATE_PAYPAL_API_BASE_URLS[request.environment]}${request.path}`;
  const fetch = request.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, request.timeoutMs));
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch (error) {
      throw new AffiliatePayPalError('unavailable', { cause: error });
    }
    let text: string;
    try {
      text = await readCappedText(response);
    } catch (error) {
      if (isAffiliatePayPalError(error)) throw error;
      throw new AffiliatePayPalError('unavailable', { status: response.status, cause: error });
    }
    let body: unknown = null;
    if (text.trim()) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------------------------------------------------- errors --- */

const NOT_ENABLED_NAMES: ReadonlySet<string> = new Set([
  'NOT_AUTHORIZED',
  'AUTHORIZATION_ERROR',
  'REQUIRED_SCOPE_MISSING',
  'PERMISSION_DENIED',
  'PAYOUTS_NOT_ENABLED',
]);

const TRANSIENT_NAMES: ReadonlySet<string> = new Set([
  'INTERNAL_SERVER_ERROR',
  'SERVICE_UNAVAILABLE',
  'PREVIOUS_REQUEST_IN_PROGRESS',
  'DUPLICATE_REQUEST_ID',
]);

function upperName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().toUpperCase();
  return STATUS_PATTERN.test(name) ? name : null;
}

/** The id of a batch a PayPal error links (`…/v1/payments/payouts/{id}`), or null. */
function linkedBatchId(links: ReadonlyArray<{ href: string }> | undefined): string | null {
  for (const link of links ?? []) {
    const match = /\/v1\/payments\/payouts\/([A-Za-z0-9_-]{1,128})(?:[?#/]|$)/.exec(link.href);
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * A non-2xx PayPal answer → the error the engine acts on. `forCreate`: a create-batch answer, where
 * a reused sender_batch_id means "adopt the original batch".
 */
export function classifyAffiliatePayPalResponse(status: number, body: unknown, options: { forCreate?: boolean } = {}): AffiliatePayPalError {
  const parsed = errorBodySchema.safeParse(body);
  const data = parsed.success ? parsed.data : {};
  const name = upperName(data.name) ?? upperName(data.error);
  const issues = (data.details ?? []).map((detail) => upperName(detail.issue)).filter((issue): issue is string => Boolean(issue));
  const names = [name, ...issues].filter((value): value is string => Boolean(value));
  const debugId = typeof data.debug_id === 'string' ? data.debug_id : null;
  const base = { status, code: name ?? issues[0] ?? null, debugId };

  if (names.some((value) => TRANSIENT_NAMES.has(value))) return new AffiliatePayPalError('unavailable', base);
  if (status === 401 || names.includes('INVALID_CLIENT') || names.includes('AUTHENTICATION_FAILURE')) {
    return new AffiliatePayPalError('credentials', base);
  }
  if (status === 429 || names.includes('RATE_LIMIT_REACHED')) return new AffiliatePayPalError('rate_limited', base);
  if (status >= 500) return new AffiliatePayPalError('unavailable', base);
  if (names.includes('INSUFFICIENT_FUNDS')) return new AffiliatePayPalError('insufficient_funds', base);
  if (status === 403 || names.some((value) => NOT_ENABLED_NAMES.has(value))) return new AffiliatePayPalError('not_enabled', base);
  if (options.forCreate) {
    const batchId = linkedBatchId(data.links);
    const duplicateName = names.some((value) => /SENDER_BATCH_ID|DUPLICATE_BATCH|BATCH_ALREADY/.test(value));
    if (batchId || duplicateName) return new AffiliatePayPalError('duplicate_batch', { ...base, batchId });
  }
  if (status === 404) return new AffiliatePayPalError('not_found', base);
  return new AffiliatePayPalError('refused', base);
}

/* --------------------------------------------------------------------- amounts --- */

/**
 * PayPal's amount string (dot decimal) for an amount in the store's minor units: `12.34` for 1234 USD
 * cents, `5000` for 5000 JPY (a zero-decimal store currency), `1234` for 123400 HUF hundredths (the
 * store keeps two decimals for HUF and TWD, which PayPal takes in whole units only). Null when PayPal
 * cannot take the amount exactly: a HUF or TWD amount with a fraction.
 */
export function formatAffiliatePayPalApiAmount(amountCents: number, currency: string): string | null {
  const minor = Math.max(0, Math.trunc(Number(amountCents) || 0));
  const factor = getCurrencyMinorUnitFactor(currency);
  const whole = Math.trunc(minor / factor);
  const fraction = minor % factor;
  if (isAffiliatePayPalZeroDecimalCurrency(currency)) return fraction === 0 ? String(whole) : null;
  if (factor === 1) return String(minor);
  return `${whole}.${String(fraction).padStart(2, '0')}`;
}

/**
 * Whether PayPal Payouts can send this amount (store minor units) in this currency: a currency PayPal
 * sends, a positive amount, whole units for HUF, JPY and TWD.
 */
export function canAffiliatePayPalSendAmount(amountCents: number, currency: string): boolean {
  return isAffiliatePayPalPayoutCurrency(currency) && amountCents > 0 && formatAffiliatePayPalApiAmount(amountCents, currency) !== null;
}

/** PayPal's amount string → minor units of `currency`, or null (a negative or malformed value). */
export function parseAffiliatePayPalAmountMinor(value: string, currency: string): number | null {
  if (!/^\d{1,15}(?:\.\d{1,8})?$/.test(value)) return null;
  const factor = getCurrencyMinorUnitFactor(currency);
  const minor = Math.round(Number(value) * factor);
  return Number.isFinite(minor) && minor >= 0 ? minor : null;
}

function toItem(raw: z.infer<typeof itemSchema>): AffiliatePayPalItem {
  const fee = raw.payout_item_fee ?? null;
  return {
    itemId: raw.payout_item_id,
    transactionId: raw.transaction_id ?? null,
    status: raw.transaction_status ?? null,
    feeCents: fee ? parseAffiliatePayPalAmountMinor(fee.value, fee.currency) : null,
    feeCurrency: fee ? fee.currency : null,
    senderItemId: raw.payout_item?.sender_item_id ?? null,
    batchId: raw.payout_batch_id ?? null,
    errorName: upperName(raw.errors?.name ?? null),
  };
}

/** Text PayPal shows in a single-byte field: accents folded, anything else outside printable ASCII dropped. */
export function toAffiliatePayPalAscii(value: string, max: number): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/* ------------------------------------------------------------------ the client --- */

const tokenCache = new Map<string, AffiliatePayPalToken>();

/** Drops every cached token (new credentials were saved: no old token may be reused). */
export function clearAffiliatePayPalTokenCache(): void {
  tokenCache.clear();
}

function cacheKey(credentials: AffiliatePayPalCredentials): string {
  return createHash('sha256').update(`${credentials.environment}\n${credentials.clientId}\n${credentials.secret}`).digest('hex');
}

function checkedId(id: string): string {
  if (typeof id !== 'string' || !AFFILIATE_PAYPAL_ID_PATTERN.test(id)) throw new AffiliatePayPalError('refused');
  return id;
}

/**
 * A create-batch 2xx whose body failed the schema: PayPal created the batch. Its
 * `batch_header.payout_batch_id`, when it has PayPal's id shape, is enough to adopt the batch (the next
 * sync reads the rest); null otherwise (the outcome stays unknown).
 */
function looseCreatedBatchId(body: unknown): string | null {
  const header = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>)['batch_header'] : null;
  const id = header && typeof header === 'object' && !Array.isArray(header) ? (header as Record<string, unknown>)['payout_batch_id'] : null;
  return typeof id === 'string' && AFFILIATE_PAYPAL_ID_PATTERN.test(id) ? id : null;
}

/**
 * A PayPal client for one environment and one pair of credentials (see the file comment). Throws
 * {@link AffiliatePayPalError} `refused` at once for credentials of the wrong shape.
 */
export function createAffiliatePayPalClient(
  credentials: AffiliatePayPalCredentials,
  options: AffiliatePayPalClientOptions = {}
): AffiliatePayPalClient {
  if (!isAffiliatePayPalEnvironment(credentials.environment) || !credentials.clientId?.trim() || !credentials.secret?.trim()) {
    throw new AffiliatePayPalError('refused');
  }
  const environment = credentials.environment;
  const now = options.now ?? (() => Date.now());
  const timeouts = { ...DEFAULT_TIMEOUTS, ...(options.timeouts ?? {}) };
  const key = cacheKey(credentials);

  async function requestToken(): Promise<AffiliatePayPalToken> {
    const basic = Buffer.from(`${credentials.clientId.trim()}:${credentials.secret.trim()}`, 'utf8').toString('base64');
    const response = await sendAffiliatePayPalRequest({
      environment,
      path: '/v1/oauth2/token',
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
      timeoutMs: timeouts.token,
      fetch: options.fetch,
    });
    if (response.status < 200 || response.status >= 300) {
      // Identity errors answer 400 or 401 with {error: "invalid_client"}: the credentials, either way.
      const error = classifyAffiliatePayPalResponse(response.status, response.body);
      if (response.status === 400 && error.kind === 'refused') throw new AffiliatePayPalError('credentials', { status: 400, code: error.code });
      throw error;
    }
    const parsed = tokenSchema.safeParse(response.body);
    if (!parsed.success) throw new AffiliatePayPalError('malformed', { status: response.status });
    const lifetimeMs = parsed.data.expires_in * 1000;
    const token: AffiliatePayPalToken = {
      accessToken: parsed.data.access_token,
      scopes: (parsed.data.scope ?? '').split(/\s+/).filter(Boolean),
      appId: parsed.data.app_id && /^[A-Za-z0-9_-]{1,128}$/.test(parsed.data.app_id) ? parsed.data.app_id : null,
      expiresAt: now() + Math.max(60_000, lifetimeMs - TOKEN_RENEW_MARGIN_MS),
    };
    tokenCache.set(key, token);
    return token;
  }

  async function getToken(tokenOptions: { fresh?: boolean } = {}): Promise<AffiliatePayPalToken> {
    const cached = tokenCache.get(key);
    if (!tokenOptions.fresh && cached && cached.expiresAt > now()) return cached;
    tokenCache.delete(key);
    return requestToken();
  }

  /** An authenticated call; a 401 drops the token and retries once with a fresh one. */
  async function call(
    path: string,
    method: 'GET' | 'POST',
    body: unknown,
    extraHeaders: Record<string, string>,
    timeoutMs: number
  ): Promise<AffiliatePayPalResponse> {
    let token = await getToken();
    for (let attempt = 0; ; attempt += 1) {
      const response = await sendAffiliatePayPalRequest({
        environment,
        path,
        method,
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...extraHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        timeoutMs,
        fetch: options.fetch,
      });
      if (response.status === 401 && attempt === 0) {
        token = await getToken({ fresh: true });
        continue;
      }
      return response;
    }
  }

  async function getPayoutBatch(batchId: string, pageOptions: { page?: number; pageSize?: number } = {}): Promise<AffiliatePayPalBatch> {
    const page = Math.max(1, Math.min(1000, Math.trunc(pageOptions.page ?? 1)));
    const pageSize = Math.max(1, Math.min(AFFILIATE_PAYPAL_BATCH_PAGE_SIZE, Math.trunc(pageOptions.pageSize ?? AFFILIATE_PAYPAL_BATCH_PAGE_SIZE)));
    const path = `/v1/payments/payouts/${encodeURIComponent(checkedId(batchId))}?page=${page}&page_size=${pageSize}&total_required=true`;
    const response = await call(path, 'GET', undefined, {}, timeouts.read);
    if (response.status < 200 || response.status >= 300) throw classifyAffiliatePayPalResponse(response.status, response.body);
    const parsed = batchSchema.safeParse(response.body);
    if (!parsed.success) throw new AffiliatePayPalError('malformed', { status: response.status });
    return {
      batchId: parsed.data.batch_header.payout_batch_id,
      status: parsed.data.batch_header.batch_status ?? null,
      items: (parsed.data.items ?? []).map(toItem),
      totalPages: typeof parsed.data.total_pages === 'number' ? parsed.data.total_pages : null,
    };
  }

  return {
    environment,
    getToken,
    getPayoutBatch,

    async createPayoutBatch(input) {
      if (!AFFILIATE_PAYPAL_SENDER_BATCH_ID_PATTERN.test(input.senderBatchId)) throw new AffiliatePayPalError('refused');
      if (input.items.length === 0 || input.items.length > AFFILIATE_PAYPAL_MAX_BATCH_ITEMS) throw new AffiliatePayPalError('refused');
      const body = {
        sender_batch_header: {
          sender_batch_id: input.senderBatchId,
          recipient_type: 'EMAIL',
          email_subject: toAffiliatePayPalAscii(input.emailSubject, 255),
          email_message: input.emailMessage.replace(/\s+/g, ' ').trim().slice(0, 1000),
        },
        items: input.items.map((item) => {
          if (!item.senderItemId || item.senderItemId.length > AFFILIATE_PAYPAL_SENDER_ITEM_ID_MAX_LENGTH) throw new AffiliatePayPalError('refused');
          if (!/^[A-Z]{3}$/.test(item.currency) || !(item.amountCents > 0)) throw new AffiliatePayPalError('refused');
          // Refused before any request: PayPal would refuse the whole batch on every run.
          if (!isAffiliatePayPalPayoutCurrency(item.currency)) throw new AffiliatePayPalError('refused', { code: 'CURRENCY_NOT_SUPPORTED' });
          const value = formatAffiliatePayPalApiAmount(item.amountCents, item.currency);
          if (value === null) throw new AffiliatePayPalError('refused', { code: 'NOT_WHOLE_UNITS' });
          return {
            recipient_type: 'EMAIL',
            amount: { value, currency: item.currency },
            receiver: item.receiver,
            note: item.note.slice(0, 400),
            sender_item_id: item.senderItemId,
            recipient_wallet: 'PAYPAL',
            // A commission pays for the partner's referral services; PayPal records GOODS when this is left out.
            purpose: 'SERVICES',
          };
        }),
      };
      const response = await call('/v1/payments/payouts', 'POST', body, { 'PayPal-Request-Id': input.senderBatchId }, timeouts.write);
      if (response.status < 200 || response.status >= 300) throw classifyAffiliatePayPalResponse(response.status, response.body, { forCreate: true });
      const parsed = createdBatchSchema.safeParse(response.body);
      if (parsed.success) return { batchId: parsed.data.batch_header.payout_batch_id, status: parsed.data.batch_header.batch_status ?? null };
      // PayPal created the batch; adopt it by its id when that much is readable.
      const looseId = looseCreatedBatchId(response.body);
      if (looseId) return { batchId: looseId, status: null };
      throw new AffiliatePayPalError('malformed', { status: response.status });
    },

    async getPayoutBatchItems(batchId, itemOptions = {}) {
      const maxPages = Math.max(1, Math.min(100, Math.trunc(itemOptions.maxPages ?? 20)));
      const first = await getPayoutBatch(batchId, { page: 1 });
      const items = [...first.items];
      const pages = Math.min(maxPages, first.totalPages ?? 1);
      for (let page = 2; page <= pages; page += 1) {
        const next = await getPayoutBatch(batchId, { page });
        items.push(...next.items);
        if (next.items.length === 0) break;
      }
      return { ...first, items };
    },

    async getPayoutItem(itemId) {
      const response = await call(`/v1/payments/payouts-item/${encodeURIComponent(checkedId(itemId))}`, 'GET', undefined, {}, timeouts.read);
      if (response.status < 200 || response.status >= 300) throw classifyAffiliatePayPalResponse(response.status, response.body);
      const parsed = itemSchema.safeParse(response.body);
      if (!parsed.success) throw new AffiliatePayPalError('malformed', { status: response.status });
      return toItem(parsed.data);
    },

    async cancelPayoutItem(itemId) {
      const path = `/v1/payments/payouts-item/${encodeURIComponent(checkedId(itemId))}/cancel`;
      const response = await call(path, 'POST', {}, {}, timeouts.write);
      if (response.status < 200 || response.status >= 300) throw classifyAffiliatePayPalResponse(response.status, response.body);
      const parsed = itemSchema.safeParse(response.body);
      if (!parsed.success) throw new AffiliatePayPalError('malformed', { status: response.status });
      return toItem(parsed.data);
    },

    async getBalances() {
      const response = await call('/v1/reporting/balances', 'GET', undefined, {}, timeouts.read);
      if (response.status < 200 || response.status >= 300) throw classifyAffiliatePayPalResponse(response.status, response.body);
      const parsed = balancesSchema.safeParse(response.body);
      if (!parsed.success) throw new AffiliatePayPalError('malformed', { status: response.status });
      return (parsed.data.balances ?? []).map((entry) => ({
        currency: entry.currency,
        primary: entry.primary === true,
        availableCents: entry.available_balance ? parseAffiliatePayPalAmountMinor(entry.available_balance.value, entry.currency) : null,
      }));
    },
  };
}
