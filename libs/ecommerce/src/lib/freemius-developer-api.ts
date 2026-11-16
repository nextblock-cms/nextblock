import 'server-only';

import crypto from 'crypto';
import { after } from 'next/server';
import { isSandboxEnvironment } from '@nextblock-cms/db/server';

import {
  resolveFreemiusDeveloperCredentialCandidates,
  type FreemiusDeveloperCredentials,
  type FreemiusDeveloperCredentialSource,
} from './payment-config';

/**
 * Freemius at developer scope: one key pair (Freemius → My Profile → Keys) reaches every product of
 * the account, so a store that sells several Freemius products needs no per-product keys. Each
 * product's own public and secret keys are read on demand (`getFreemiusProductKeys`: the checkout
 * public key, the sandbox token, the webhook HMAC secret) and licenses, owners, subscriptions,
 * trials and coupons are read and written here (`freemiusDeveloperRequest`).
 *
 * The developer secret is a master key for the whole Freemius account:
 * - only this module signs with it, and it never leaves the server: no value it holds or receives
 *   is logged, persisted or returned to a caller (a product's keys stay in memory for minutes);
 * - every id in a request path is digits only (`toFreemiusId`), so no caller can steer a signed
 *   request to another resource, and a webhook's product id only selects among the account's own
 *   products (`resolveDeveloperOwning`);
 * - a pair is used only once Freemius accepts it at developer scope (`resolveVerifiedDeveloper`),
 *   which is also how the legacy FREEMIUS_PUBLIC_KEY / FREEMIUS_SECRET_KEY names count as one;
 * - the one-product keys are sent only at their own product's scope, by one GET that asks whether
 *   they are that product's keys (`confirmFreemiusOneProductKeys`, for the key policy);
 * - on the public sandbox (published admin login) nothing here runs except the catalog reader, for
 *   the demo's own 15-minute reset (`openFreemiusCatalogReader`: GET, catalog paths only; Sync from
 *   Freemius refuses there). Every other entry refuses there before it resolves a key.
 *
 * Freemius failing to answer (429, 5xx, a timeout, or a 2xx that is not the product list or the
 * product asked for) never reads as "not configured": a working pair and the product keys already
 * read stay in use, and Freemius is asked again after UNAVAILABLE_TTL_MS. Nor does it read as "not
 * owned": a product id missing from a list whose latest re-read went unanswered throws
 * `unavailable` (`resolveDeveloperOwning`). Unauthenticated requests (forged webhooks) reach
 * Freemius at most once a window whatever it answers: an unanswered read is remembered, and
 * re-reads of the product list and of a product's keys are throttled on the time of the last
 * attempt.
 *
 * Signing follows the official Freemius PHP SDK (`GenerateAuthorizationParams`): HMAC-SHA256 of
 * METHOD, Content-MD5, Content-Type, Date and the path without its query string, base64url of the
 * hex digest, sent as `FS <developer id>:<public key>:<signature>`.
 */

export const FREEMIUS_API_ORIGIN = 'https://api.freemius.com';

/**
 * Why developer-scope work stops on the public sandbox (its admin login is published). Sync from
 * Freemius refuses there too (pages/cms/products/actions.ts), so only the reset reads the catalog.
 */
export const FREEMIUS_DEVELOPER_SANDBOX_MESSAGE =
  "The Freemius developer key isn't used in the sandbox, apart from the demo's own 15-minute catalog reset.";

export type FreemiusHttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

const REQUEST_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** How long a verdict on a key pair holds before Freemius is asked again. */
const VERIFIED_TTL_MS = 10 * 60_000;
const REFUSED_TTL_MS = 10 * 60_000;
/** After Freemius failed to answer (a check or a product read), how long until it is asked again. */
const UNAVAILABLE_TTL_MS = 30_000;
/** A product id missing from the account's list re-reads the list at most this often, whatever it answered. */
const PLUGIN_LIST_REFRESH_MS = 60_000;
const PLUGIN_PAGE_SIZE = 50;
const MAX_PLUGIN_PAGES = 20;

const PRODUCT_KEYS_TTL_MS = 10 * 60_000;
/**
 * How old a product's secret may be and still verify a webhook. While Freemius fails to answer,
 * `getFreemiusProductKeys` keeps serving the last keys it returned (checkout keeps their public key
 * without a limit), but a secret rotated because it leaked must not keep verifying forged payment
 * and refund webhooks for as long as reads fail, and the shared developer key can be pushed into
 * 429s on purpose. Past this age the webhook check treats the keys as a failed read.
 */
export const FREEMIUS_WEBHOOK_SECRET_MAX_AGE_MS = PRODUCT_KEYS_TTL_MS + 60 * 60_000;
const PRODUCT_KEYS_MISS_TTL_MS = 60_000;
/** A product's keys are re-read sooner than their TTL (`maxAgeMs`: a rotated secret) at most this often, whatever it answered. */
const PRODUCT_KEYS_REREAD_MS = 60_000;

/** The user fields `@freemius/sdk` reads (`USER_FIELDS`): enough for purchase data and the claim. */
export const FREEMIUS_USER_FIELDS = 'email,first,last,picture,is_verified,id,created,updated,is_marketing_allowed';

/* ----------------------------------------------------------------------- ids --- */

/** A Freemius id (product, plan, pricing, license, user, coupon, event) as digits, or null. */
export function toFreemiusId(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  return /^[1-9]\d{0,19}$/.test(trimmed) ? trimmed : null;
}

/* -------------------------------------------------------------------- errors --- */

/**
 * - `sandbox`: refused on the public sandbox; `not_configured`: no working developer pair.
 * - `auth`: Freemius answered 401/403, a configuration problem (the pair is refused, or cannot
 *   reach this product), never a missing resource.
 * - `not_found`: 404. `rejected`: another 4xx (Freemius refused the request itself).
 * - `unavailable`: 429, 5xx, a network failure, a timeout or an unreadable answer.
 */
export type FreemiusApiErrorKind = 'sandbox' | 'not_configured' | 'auth' | 'not_found' | 'rejected' | 'unavailable';

export class FreemiusApiError extends Error {
  readonly kind: FreemiusApiErrorKind;
  /** The HTTP status Freemius answered, null when it never answered. */
  readonly status: number | null;
  /** Freemius' error code (`license_not_found`), when it sent one. */
  readonly code: string | null;
  /** The request path without its query string (which can hold an email). */
  readonly path: string | null;

  constructor(
    kind: FreemiusApiErrorKind,
    message: string,
    options: { status?: number | null; code?: string | null; path?: string | null; cause?: unknown } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'FreemiusApiError';
    this.kind = kind;
    this.status = options.status ?? null;
    this.code = options.code ?? null;
    this.path = options.path ? options.path.split('?', 1)[0] : null;
  }
}

export function isFreemiusApiError(error: unknown): error is FreemiusApiError {
  return error instanceof FreemiusApiError;
}

/** Resolves to null when Freemius answered 404; every other failure still throws. */
export async function orNullWhenNotFound<T>(request: Promise<T>): Promise<T | null> {
  try {
    return await request;
  } catch (error) {
    if (isFreemiusApiError(error) && error.kind === 'not_found') {
      return null;
    }

    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function shortString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function errorKindForStatus(status: number): FreemiusApiErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 429 || status >= 500) return 'unavailable';
  return 'rejected';
}

function errorFromAnswer(status: number, body: unknown, path: string): FreemiusApiError {
  const error = isRecord(body) && isRecord(body['error']) ? body['error'] : null;
  const message = shortString(error?.['message'], 300) ?? shortString(isRecord(body) ? body['message'] : null, 300);
  const code = shortString(error?.['code'], 80) ?? shortString(error?.['type'], 80);

  return new FreemiusApiError(errorKindForStatus(status), message ?? `Freemius request failed with ${status}`, {
    status,
    code,
    path,
  });
}

/* ------------------------------------------------------------------- signing --- */

/** The Date header value, as the PHP SDK's `date('r')` prints it in UTC. */
export function formatFreemiusRequestDate(date: Date): string {
  return date.toUTCString().replace('GMT', '+0000');
}

export type FreemiusRequestSignature = {
  authorization: string;
  /** Send as Content-MD5 when set: the hex MD5 of the body (POST and PUT with a body). */
  contentMd5: string | null;
  /** Send as Content-Type when set (every write). */
  contentType: string | null;
};

/**
 * The Authorization header of a Freemius API request, exactly as the official PHP SDK computes it.
 * `scopeId` is the developer id for developer scope (or a product id for product scope); `path`
 * is the full API path (`/v1/developers/…`), whose query string is never signed. A GET is signed
 * without a content type and sends none, as Sync from Freemius always has; a write sends and signs
 * `application/json`, plus Content-MD5 when it has a body.
 */
export function signFreemiusRequest(input: {
  body?: string | null;
  date: string;
  method: FreemiusHttpMethod;
  path: string;
  publicKey: string;
  scopeId: string;
  secretKey: string;
}): FreemiusRequestSignature {
  const method = input.method.toUpperCase() as FreemiusHttpMethod;
  const body = input.body ?? '';
  const contentMd5 = (method === 'POST' || method === 'PUT') && body ? crypto.createHash('md5').update(body).digest('hex') : '';
  const contentType = method === 'GET' ? '' : 'application/json';
  const stringToSign = [method, contentMd5, contentType, input.date, input.path.split('?', 1)[0]].join('\n');
  const authType = input.secretKey !== input.publicKey ? 'FS' : 'FSP';
  const digest = crypto.createHmac('sha256', input.secretKey).update(stringToSign).digest('hex');
  const signature = Buffer.from(digest, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  return {
    authorization: `${authType} ${input.scopeId}:${input.publicKey}:${signature}`,
    contentMd5: contentMd5 || null,
    contentType: contentType || null,
  };
}

/* ------------------------------------------------------------------ transport --- */

async function readCappedText(response: Response, path: string): Promise<string> {
  const declared = Number(response.headers?.get('content-length'));

  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new FreemiusApiError('unavailable', 'Freemius sent an oversized answer.', { status: response.status, path });
  }

  if (!response.body) {
    return typeof response.text === 'function' ? response.text() : '';
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;

    total += value.byteLength;

    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new FreemiusApiError('unavailable', 'Freemius sent an oversized answer.', { status: response.status, path });
    }

    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks).toString('utf8');
}

async function readAnswer(response: Response, path: string): Promise<unknown> {
  let text: string;

  try {
    text = await readCappedText(response, path);
  } catch (error) {
    if (isFreemiusApiError(error)) throw error;
    throw new FreemiusApiError('unavailable', 'Freemius sent an unreadable answer.', { status: response.status, path, cause: error });
  }

  let body: unknown = null;

  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    throw errorFromAnswer(response.status, body, path);
  }

  return body;
}

/**
 * The keys a request is signed with and the scope they sign for: the developer pair at developer
 * scope (`scopeId` the developer id), or a product's own keys at product scope (`scopeId` the
 * product id, used only by `confirmFreemiusOneProductKeys`).
 */
type SigningKeys = { scopeId: string; publicKey: string; secretKey: string };

function developerScope(credentials: FreemiusDeveloperCredentials): SigningKeys {
  return { scopeId: credentials.developerId, publicKey: credentials.publicKey, secretKey: credentials.secretKey };
}

/** Every GET this module sends. A GET reads; it never creates or changes anything at Freemius. */
async function getFromFreemius(path: string, keys: SigningKeys, timeoutMs: number): Promise<unknown> {
  const date = formatFreemiusRequestDate(new Date());
  const { authorization } = signFreemiusRequest({
    date,
    method: 'GET',
    path,
    publicKey: keys.publicKey,
    scopeId: keys.scopeId,
    secretKey: keys.secretKey,
  });
  let response: Response;

  try {
    response = await fetch(`${FREEMIUS_API_ORIGIN}${path}`, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: authorization, Date: date },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new FreemiusApiError('unavailable', 'Freemius could not be reached.', { path, cause: error });
  }

  return readAnswer(response, path);
}

/** A developer-relative path: `/plugins/24851/licenses/9.json`, segments of letters, digits, `_` and `-`. */
const RELATIVE_PATH = /^(?:\/[A-Za-z0-9_-]+)+\.json$/;
const QUERY_KEY = /^[a-z_]{1,32}$/;

/** The developer-relative path and query string of a request, or a `rejected` error before anything is resolved or sent. */
function relativeRequestTarget(
  relativePath: string,
  query?: Record<string, string | number | boolean | null | undefined>
): string {
  if (!RELATIVE_PATH.test(relativePath)) {
    throw new FreemiusApiError('rejected', 'Refused a malformed Freemius API path.');
  }

  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === null || value === undefined) continue;
    if (!QUERY_KEY.test(key)) throw new FreemiusApiError('rejected', 'Refused a malformed Freemius API query.');
    params.set(key, String(value));
  }

  const search = params.toString();

  return `${relativePath}${search ? `?${search}` : ''}`;
}

/* ------------------------------------------------------------- developer pair --- */

/** A refusal is conclusive (`auth`, `rejected`, `not_found`); `unavailable` means Freemius did not answer. */
type Verdict =
  | { ok: true; pluginIds: ReadonlySet<string>; at: number }
  | { ok: false; kind: 'auth' | 'rejected' | 'not_found' | 'unavailable'; at: number };

/**
 * What is known about one pair. A check Freemius fails to answer never replaces a conclusive
 * verdict (working or refused): the pair keeps it and is checked again after UNAVAILABLE_TTL_MS.
 */
type PairEntry = {
  verdict: Verdict;
  /** When Freemius is asked about the pair again. */
  recheckAt: number;
  /** When the product list was last asked for, whatever came of it (throttles the re-read for a missing product id). */
  listedAt: number;
  /**
   * When Freemius last answered that request (0: never). Older than `listedAt`: the latest request
   * went unanswered and the kept list may be stale, so a product id missing from it proves nothing.
   */
  listAnsweredAt: number;
  /**
   * While a pair on record as working is getting 404s on the first page of its product list: when
   * the first of them came (null otherwise). See `recordVerdict`.
   */
  notFoundSince: number | null;
};

type VerifiedDeveloper = {
  credentials: FreemiusDeveloperCredentials;
  fingerprint: string;
  pluginIds: ReadonlySet<string>;
  checkedAt: number;
  /** Freemius answered the latest request for the product list (`PairEntry.listAnsweredAt`). */
  listAnswered: boolean;
};

/** What is known about each pair, by fingerprint (a SHA-256 of the pair, never the pair itself as a key). */
const pairs = new Map<string, PairEntry>();
/** Probes in flight by fingerprint, so concurrent requests (and background checks) share one. */
const probes = new Map<string, Promise<Verdict>>();

type ProductKeysEntry = {
  /** The last keys Freemius returned, kept while it fails to answer; null after a 404/401/403, or before any answer. */
  keys: FreemiusProductKeys | null;
  /** When the cached answer (the keys, or the miss) was obtained. */
  at: number;
  /** The last read, whatever came of it. */
  attemptAt: number;
  /** The last read went unanswered: no new read for UNAVAILABLE_TTL_MS, and this is thrown when no keys can be served. */
  failure: FreemiusApiError | null;
};

/** A product's keys by `<pair fingerprint>:<product id>`, memory only. */
const productKeys = new Map<string, ProductKeysEntry>();
/** Product-key reads in flight by the same key, so concurrent requests share one. */
const productKeyReads = new Map<string, Promise<ProductKeysEntry>>();

/** A pair's identity: the developer id is part of it, so a changed id is checked afresh, as a new pair. */
function fingerprintOf(credentials: FreemiusDeveloperCredentials): string {
  return crypto
    .createHash('sha256')
    .update(`${credentials.developerId}\n${credentials.publicKey}\n${credentials.secretKey}`)
    .digest('hex');
}

/**
 * Hashes (SHA-256 of the kind and the key, never a key) of every public and secret key Freemius
 * accepted at developer scope during this instance's life. Such a key belongs to a developer pair,
 * never to a product, even after the pair is revoked or its developer id changed, so the key policy
 * (`describeFreemiusDeveloperPairs`) never takes it for a product's key again: a pair revoked while
 * the instance runs, left under the one-product names, must not start verifying that product's
 * webhooks or opening its checkout. It outlives `forgetFreemiusDeveloperCaches` (a Sync or a save
 * changes nothing about which keys Freemius once accepted), holds configured keys only, and drops
 * the oldest past VERIFIED_DEVELOPER_KEYS_MAX. Memory only: a cold start forgets it.
 */
const verifiedDeveloperKeys = new Set<string>();
const VERIFIED_DEVELOPER_KEYS_MAX = 32;

function keyHash(kind: 'public' | 'secret', key: string): string {
  return crypto.createHash('sha256').update(`${kind}\n${key}`).digest('hex');
}

function rememberDeveloperKeys(credentials: FreemiusDeveloperCredentials): void {
  for (const hash of [keyHash('public', credentials.publicKey), keyHash('secret', credentials.secretKey)]) {
    // Re-inserted, so the oldest-first order below drops the keys accepted longest ago.
    verifiedDeveloperKeys.delete(hash);
    verifiedDeveloperKeys.add(hash);
  }

  for (const hash of verifiedDeveloperKeys) {
    if (verifiedDeveloperKeys.size <= VERIFIED_DEVELOPER_KEYS_MAX) break;
    verifiedDeveloperKeys.delete(hash);
  }
}

/**
 * Records what a probe found. One Freemius did not answer keeps the last conclusive verdict, retried
 * soon. A 404 on the first page of the product list refuses a pair with no working verdict on record
 * (its first check, or after a refusal: a wrong developer id). For a pair on record as working it is
 * read as Freemius failing to answer (verdict and list kept, asked again after UNAVAILABLE_TTL_MS):
 * such a pair exists, so one 404 is far likelier a misrouted answer than "no such developer", and
 * read as a refusal it took every Freemius flow offline for ten minutes. Only a second 404 in a row,
 * at least UNAVAILABLE_TTL_MS after the first and with no list answered between them, refuses it.
 */
function recordVerdict(fingerprint: string, credentials: FreemiusDeveloperCredentials, verdict: Verdict): void {
  const now = Date.now();
  const previous = pairs.get(fingerprint);

  if (!verdict.ok && verdict.kind === 'not_found' && previous?.verdict.ok) {
    const since = previous.notFoundSince;

    if (since === null || now < since || now - since < UNAVAILABLE_TTL_MS) {
      pairs.set(fingerprint, {
        verdict: previous.verdict,
        recheckAt: now + UNAVAILABLE_TTL_MS,
        listedAt: now,
        listAnsweredAt: previous.listAnsweredAt,
        notFoundSince: since !== null && now >= since ? since : now,
      });
      return;
    }
  }

  if (verdict.ok || verdict.kind !== 'unavailable') {
    pairs.set(fingerprint, {
      verdict,
      recheckAt: now + (verdict.ok ? VERIFIED_TTL_MS : REFUSED_TTL_MS),
      listedAt: now,
      listAnsweredAt: now,
      notFoundSince: null,
    });

    if (verdict.ok) {
      rememberDeveloperKeys(credentials);
    }

    return;
  }

  const kept = previous && (previous.verdict.ok || previous.verdict.kind !== 'unavailable') ? previous.verdict : verdict;

  pairs.set(fingerprint, {
    verdict: kept,
    recheckAt: now + UNAVAILABLE_TTL_MS,
    listedAt: now,
    listAnsweredAt: previous?.listAnsweredAt ?? 0,
    // No answer came, so a run of 404s goes on through it.
    notFoundSince: previous?.notFoundSince ?? null,
  });
}

/**
 * How a failed product-list read counts. 401/403 (`auth`) and another 4xx (`rejected`) are Freemius
 * refusing the pair, and so is a 404 on the first page: Freemius has no such developer for these
 * keys (a wrong developer id), which waiting will not fix. Read as `unavailable`, that 404 counted
 * as ready, showed buy buttons whose checkouts and webhooks all answered 503, and re-checked every
 * 30 s (`recordVerdict` still reads one as unavailable for a pair on record as working). Anything
 * else (429, 5xx, a timeout, a 404 on a later page) is Freemius failing to answer.
 */
function probeFailureKind(error: unknown, page: number): Extract<Verdict, { ok: false }>['kind'] {
  if (!isFreemiusApiError(error)) return 'unavailable';
  if (error.kind === 'auth' || error.kind === 'rejected') return error.kind;
  if (error.kind === 'not_found' && page === 0) return 'not_found';
  return 'unavailable';
}

/** Lists the account's products: proof that Freemius accepts the pair at developer scope. */
async function verifyPair(credentials: FreemiusDeveloperCredentials): Promise<Verdict> {
  const pluginIds = new Set<string>();
  let page = 0;

  try {
    for (; page < MAX_PLUGIN_PAGES; page += 1) {
      const body = await getFromFreemius(
        `/v1/developers/${credentials.developerId}/plugins.json?count=${PLUGIN_PAGE_SIZE}&offset=${page * PLUGIN_PAGE_SIZE}`,
        developerScope(credentials),
        PROBE_TIMEOUT_MS
      );

      if (!isRecord(body) || !Array.isArray(body['plugins'])) {
        // A 2xx that is not a product list (an HTML page, an empty body, {}, { plugins: null }) is
        // no answer. Read as an empty list, it recorded a working pair that owns nothing, so for ten
        // minutes every owned product read as "not owned": genuine webhooks got 401 (not 503), and
        // the one-product keys stood in for products the account owns.
        return { ok: false, kind: 'unavailable', at: Date.now() };
      }

      const plugins = body['plugins'] as unknown[];
      let added = 0;

      for (const plugin of plugins) {
        const id = isRecord(plugin) ? toFreemiusId(plugin['id']) : null;

        if (id && !pluginIds.has(id)) {
          pluginIds.add(id);
          added += 1;
        }
      }

      if (plugins.length < PLUGIN_PAGE_SIZE || added === 0) break;
    }

    return { ok: true, pluginIds, at: Date.now() };
  } catch (error) {
    return { ok: false, kind: probeFailureKind(error, page), at: Date.now() };
  }
}

/** Probes a pair (one probe per pair at a time) and records the verdict. Never rejects. */
function probePair(credentials: FreemiusDeveloperCredentials, fingerprint: string): Promise<Verdict> {
  const pending = probes.get(fingerprint);

  if (pending) return pending;

  const probe: Promise<Verdict> = verifyPair(credentials)
    .then((verdict) => {
      recordVerdict(fingerprint, credentials, verdict);
      return verdict;
    })
    .finally(() => {
      if (probes.get(fingerprint) === probe) probes.delete(fingerprint);
    });
  probes.set(fingerprint, probe);

  return probe;
}

/**
 * The first configured pair Freemius accepts at developer scope (CMS developer fields, then
 * FREEMIUS_DEVELOPER_PUBLIC_KEY / FREEMIUS_DEVELOPER_SECRET_KEY, then the legacy single-product
 * names when they turn out to hold a developer pair), or null. Verdicts are cached.
 */
async function resolveVerifiedDeveloper(options: { listMaxAgeMs?: number } = {}): Promise<VerifiedDeveloper | null> {
  return verifyCandidates(await resolveFreemiusDeveloperCredentialCandidates(), options);
}

/**
 * The first of `candidates` Freemius accepts, checking each one whose verdict is due. A check
 * Freemius fails to answer keeps the pair's last conclusive verdict (a working pair stays in use)
 * and no further pair is probed in that call; only a refusal withdraws a verdict. `listMaxAgeMs`
 * re-reads a working pair's product list when the last attempt is older than that.
 */
async function verifyCandidates(
  candidates: readonly FreemiusDeveloperCredentials[],
  options: { listMaxAgeMs?: number } = {}
): Promise<VerifiedDeveloper | null> {
  let unreachable = false;

  for (const credentials of candidates) {
    const fingerprint = fingerprintOf(credentials);
    const now = Date.now();
    const known = pairs.get(fingerprint);
    const due = !known || now >= known.recheckAt;
    const relist = Boolean(
      known && !due && known.verdict.ok && options.listMaxAgeMs !== undefined && now - known.listedAt >= options.listMaxAgeMs
    );

    if ((due || relist) && !unreachable) {
      const verdict = await probePair(credentials, fingerprint);

      if (!verdict.ok && verdict.kind === 'unavailable') unreachable = true;
    }

    const entry = pairs.get(fingerprint);

    if (!entry) continue;

    if (entry.verdict.ok) {
      return {
        credentials,
        fingerprint,
        pluginIds: entry.verdict.pluginIds,
        checkedAt: entry.verdict.at,
        listAnswered: entry.listAnsweredAt >= entry.listedAt,
      };
    }

    if (entry.verdict.kind === 'unavailable') {
      unreachable = true;
    }
  }

  return null;
}

/**
 * The verified pair, when the account owns `productId` (a missing id re-reads the list at most once
 * a minute); null without a working pair, or when Freemius answered the latest request for the list
 * and the id is not in it. A missing id with the latest request unanswered (just now, or throttled
 * right after) throws `unavailable`: the kept list may predate the product, and reading "not owned"
 * there sent a genuine webhook of a product added since down the 401 path with nothing logged.
 */
async function resolveDeveloperOwning(productId: string): Promise<VerifiedDeveloper | null> {
  const developer = await resolveVerifiedDeveloper();

  if (!developer) return null;
  if (developer.pluginIds.has(productId)) return developer;

  const refreshed = await resolveVerifiedDeveloper({ listMaxAgeMs: PLUGIN_LIST_REFRESH_MS });

  if (!refreshed) return null;
  if (refreshed.pluginIds.has(productId)) return refreshed;

  if (!refreshed.listAnswered) {
    throw new FreemiusApiError(
      'unavailable',
      'Freemius did not answer the latest read of the product list, so whether the account owns this product is not known.'
    );
  }

  return null;
}

/**
 * Drops every verdict, product key and one-product key confirmation: the next use asks Freemius
 * again (after a Sync or a save). Which keys Freemius once accepted at developer scope is kept
 * (`verifiedDeveloperKeys`).
 */
export function forgetFreemiusDeveloperCaches(): void {
  pairs.clear();
  probes.clear();
  productKeys.clear();
  productKeyReads.clear();
  oneProductConfirmations.clear();
  oneProductConfirmationReads.clear();
  oneProductConfirmationTimes.length = 0;
}

function forgetPair(fingerprint: string): void {
  pairs.delete(fingerprint);

  for (const key of productKeys.keys()) {
    if (key.startsWith(`${fingerprint}:`)) productKeys.delete(key);
  }
}

/* ------------------------------------------------------------------- requests --- */

export type FreemiusDeveloperRequest = {
  /** Developer-relative path, every id digits: `/plugins/24851/licenses/9.json`. */
  path: string;
  method?: FreemiusHttpMethod;
  query?: Record<string, string | number | boolean | null | undefined>;
  /** JSON body of a POST or PUT. */
  body?: Record<string, unknown> | null;
};

/**
 * One request at developer scope, signed with the verified developer pair. Refuses on the public
 * sandbox before it resolves a key. Throws {@link FreemiusApiError}: `sandbox`, `not_configured`
 * (no working pair), `auth`, `not_found`, `rejected` or `unavailable`. A 401/403 also drops the
 * pair's verdict, so the next request checks the pair again.
 */
export async function freemiusDeveloperRequest<T = unknown>(request: FreemiusDeveloperRequest): Promise<T> {
  if (isSandboxEnvironment()) {
    throw new FreemiusApiError('sandbox', FREEMIUS_DEVELOPER_SANDBOX_MESSAGE);
  }

  const target = relativeRequestTarget(request.path, request.query);
  const developer = await resolveVerifiedDeveloper();

  if (!developer) {
    throw new FreemiusApiError('not_configured', 'No working Freemius developer key pair is configured.');
  }

  const method = request.method ?? 'GET';
  const path = `/v1/developers/${developer.credentials.developerId}${target}`;

  try {
    if (method === 'GET') {
      return (await getFromFreemius(path, developerScope(developer.credentials), REQUEST_TIMEOUT_MS)) as T;
    }

    const body = (method === 'POST' || method === 'PUT') && request.body ? JSON.stringify(request.body) : '';
    const date = formatFreemiusRequestDate(new Date());
    const signature = signFreemiusRequest({
      body,
      date,
      method,
      path,
      publicKey: developer.credentials.publicKey,
      scopeId: developer.credentials.developerId,
      secretKey: developer.credentials.secretKey,
    });
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: signature.authorization,
      Date: date,
    };

    if (signature.contentType) headers['Content-Type'] = signature.contentType;
    if (signature.contentMd5) headers['Content-MD5'] = signature.contentMd5;

    let response: Response;

    try {
      response = await fetch(`${FREEMIUS_API_ORIGIN}${path}`, {
        method,
        headers,
        body: body || undefined,
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new FreemiusApiError('unavailable', 'Freemius could not be reached.', { path, cause: error });
    }

    return (await readAnswer(response, path)) as T;
  } catch (error) {
    if (isFreemiusApiError(error) && error.kind === 'auth') {
      forgetPair(developer.fingerprint);
    }

    throw error;
  }
}

/**
 * True when a working developer pair owns `productId`, so its work can go through
 * `freemiusDeveloperRequest`; false on the sandbox, without a pair, or for another account's product.
 */
export async function canUseFreemiusDeveloperScope(productId: unknown): Promise<boolean> {
  if (isSandboxEnvironment()) {
    return false;
  }

  const id = toFreemiusId(productId);

  if (!id) {
    return false;
  }

  try {
    return (await resolveDeveloperOwning(id)) !== null;
  } catch {
    return false;
  }
}

/**
 * Runs `request` at developer scope when the developer pair owns `productId`. `{ handled: false }`
 * when it cannot (the sandbox, no working pair, another account's product, or Freemius refused the
 * pair before doing anything), so the caller can use the product's own keys instead. Any other
 * failure throws. Only for work that is safe to repeat with other keys: reads, or one write that a
 * 401/403 refused before it did anything.
 */
export async function withFreemiusDeveloperScope<T>(
  productId: unknown,
  request: () => Promise<T>
): Promise<{ handled: true; value: T } | { handled: false }> {
  if (!(await canUseFreemiusDeveloperScope(productId))) {
    return { handled: false };
  }

  try {
    return { handled: true, value: await request() };
  } catch (error) {
    if (isFreemiusApiError(error) && (error.kind === 'auth' || error.kind === 'not_configured' || error.kind === 'sandbox')) {
      return { handled: false };
    }

    throw error;
  }
}

/* --------------------------------------------------------------- product keys --- */

export type FreemiusProductKeys = {
  productId: string;
  publicKey: string;
  secretKey: string;
  /** When Freemius returned them (ms since the epoch). */
  fetchedAt: number;
};

/**
 * A product's own public and secret keys, read with the developer pair and kept in memory for a
 * few minutes (never persisted or logged). Null on the sandbox, without a working pair, for a
 * product the account does not own (as a product list Freemius answered shows: a missing id whose
 * latest list read went unanswered throws `unavailable` instead), or when Freemius gives no keys
 * for an owned product (a 401/403/404, or the product without keys): while the pair works, null is
 * always an answer Freemius gave. When Freemius fails to answer (429, 5xx, a timeout, or a 2xx that
 * is not this product), the last keys it returned stay in use and it is asked again after
 * UNAVAILABLE_TTL_MS; without such keys this throws a `FreemiusApiError` (`unavailable`), the same
 * one until then. `maxAgeMs` re-reads keys older than that (0: now) for a rotated secret, at most
 * once a minute per product whatever that read answered (so forged webhooks cannot turn into one
 * Freemius request each); when that re-read goes unanswered, or the last one did, it throws rather
 * than pass the old keys off as fresh ones. Concurrent reads share one request.
 */
export async function getFreemiusProductKeys(
  productId: unknown,
  options: { maxAgeMs?: number } = {}
): Promise<FreemiusProductKeys | null> {
  if (isSandboxEnvironment()) {
    return null;
  }

  const id = toFreemiusId(productId);

  if (!id) {
    return null;
  }

  const developer = await resolveDeveloperOwning(id);

  if (!developer) {
    return null;
  }

  const cacheKey = `${developer.fingerprint}:${id}`;
  const cached = productKeys.get(cacheKey);
  const now = Date.now();
  const maxAge = Math.min(options.maxAgeMs ?? PRODUCT_KEYS_TTL_MS, PRODUCT_KEYS_TTL_MS);
  // The caller wants keys newer than the cache guarantees (a rotated secret).
  const fresher = maxAge < PRODUCT_KEYS_TTL_MS;

  if (cached) {
    const age = now - cached.at;
    const sinceAttempt = now - cached.attemptAt;

    if (cached.keys) {
      if (age < maxAge) return cached.keys;

      if (cached.failure && sinceAttempt < (fresher ? PRODUCT_KEYS_REREAD_MS : UNAVAILABLE_TTL_MS)) {
        if (fresher) throw cached.failure;
        return cached.keys;
      }

      if (fresher && !cached.failure && age < PRODUCT_KEYS_TTL_MS && sinceAttempt < PRODUCT_KEYS_REREAD_MS) {
        return cached.keys;
      }
    } else if (cached.failure) {
      if (sinceAttempt < UNAVAILABLE_TTL_MS) throw cached.failure;
    } else if (age < PRODUCT_KEYS_MISS_TTL_MS) {
      return null;
    }
  }

  let read = productKeyReads.get(cacheKey);

  if (!read) {
    const started: Promise<ProductKeysEntry> = readProductKeys(cacheKey, id, cached).finally(() => {
      if (productKeyReads.get(cacheKey) === started) productKeyReads.delete(cacheKey);
    });
    productKeyReads.set(cacheKey, started);
    read = started;
  }

  const entry = await read;

  if (entry.failure) {
    if (entry.keys && !fresher) return entry.keys;
    throw entry.failure;
  }

  return entry.keys;
}

/**
 * One read of a product's keys, recorded whatever comes of it, as the cache entry it leaves: an
 * unanswered read keeps the last keys beside its error (each caller decides what to make of it).
 * A 2xx that is not this product (no object, no `id`, another product's `id`) is unanswered too, as
 * a 2xx without a product list is to the pair's check (`verifyPair`): read as "no keys", it replaced
 * the last keys Freemius returned for a minute, so that product's genuine webhooks answered 503 and
 * its checkout fell back to bound keys. The product for this id without keys is Freemius' answer.
 * Throws only the failures that are not recorded (another 4xx, a pair withdrawn meanwhile).
 */
async function readProductKeys(cacheKey: string, id: string, previous: ProductKeysEntry | undefined): Promise<ProductKeysEntry> {
  const attemptAt = Date.now();
  let entry: ProductKeysEntry;

  try {
    const body = await freemiusDeveloperRequest<unknown>({ path: `/plugins/${id}.json` });

    if (!isRecord(body) || toFreemiusId(body['id']) !== id) {
      throw new FreemiusApiError('unavailable', 'Freemius answered the read of the product with something that is not that product.');
    }

    const publicKey = shortString(body['public_key'], 200);
    const secretKey = shortString(body['secret_key'], 200);
    const fetchedAt = Date.now();
    const keys = publicKey && secretKey ? { productId: id, publicKey, secretKey, fetchedAt } : null;

    entry = { keys, at: fetchedAt, attemptAt, failure: null };
  } catch (error) {
    if (isFreemiusApiError(error) && (error.kind === 'not_found' || error.kind === 'auth')) {
      entry = { keys: null, at: Date.now(), attemptAt, failure: null };
    } else if (isFreemiusApiError(error) && error.kind === 'unavailable') {
      entry = { keys: previous?.keys ?? null, at: previous?.at ?? attemptAt, attemptAt, failure: error };
    } else {
      if (previous) productKeys.set(cacheKey, { ...previous, attemptAt });
      throw error;
    }
  }

  productKeys.set(cacheKey, entry);

  return entry;
}

/* --------------------------------------------------------------------- status --- */

export type FreemiusDeveloperStatus = {
  /**
   * `working`: Freemius accepts the pair at developer scope (a check it failed to answer since
   * keeps that). `refused`: every configured pair was refused. `unreachable`: Freemius could not be
   * asked. `missing`: no developer id and pair. `sandbox`: not checked on the public sandbox.
   * `unchecked`: a pair is configured but Freemius has not been asked yet (only from
   * `{ wait: false }`, which starts that check in the background).
   */
  state: 'working' | 'refused' | 'unreachable' | 'missing' | 'sandbox' | 'unchecked';
  /** Where the working pair comes from. */
  source: FreemiusDeveloperCredentialSource | null;
  /** The account's product ids (sorted), when the pair works. */
  productIds: string[];
};

function sortedProductIds(pluginIds: ReadonlySet<string>): string[] {
  return [...pluginIds].sort((a, b) => Number(a) - Number(b));
}

/**
 * Facts about the developer pair for readiness and the Payments screen: never key material.
 * `wait: false` answers from memory without waiting on Freemius (readiness runs during public
 * renders): a verdict that is missing or due is checked in the background (`after()` when Next can
 * schedule it, at once otherwise), and a pair never checked reads as `unchecked`.
 */
export async function getFreemiusDeveloperStatus(options: { wait?: boolean } = {}): Promise<FreemiusDeveloperStatus> {
  if (isSandboxEnvironment()) {
    return { state: 'sandbox', source: null, productIds: [] };
  }

  const candidates = await resolveFreemiusDeveloperCredentialCandidates();

  if (candidates.length === 0) {
    return { state: 'missing', source: null, productIds: [] };
  }

  if (options.wait === false) {
    return developerStatusFromMemory(candidates);
  }

  const developer = await verifyCandidates(candidates);

  if (developer) {
    return { state: 'working', source: developer.credentials.source, productIds: sortedProductIds(developer.pluginIds) };
  }

  const unreachable = candidates.some((credentials) => {
    const verdict = pairs.get(fingerprintOf(credentials))?.verdict;
    return Boolean(verdict && !verdict.ok && verdict.kind === 'unavailable');
  });

  return { state: unreachable ? 'unreachable' : 'refused', source: null, productIds: [] };
}

/** The status from cached verdicts only, in the order `verifyCandidates` walks them; schedules the checks that are due. */
function developerStatusFromMemory(candidates: readonly FreemiusDeveloperCredentials[]): FreemiusDeveloperStatus {
  const now = Date.now();
  let checkDue = false;
  let unchecked = false;
  let unreachable = false;
  let working: FreemiusDeveloperStatus | null = null;

  for (const credentials of candidates) {
    const fingerprint = fingerprintOf(credentials);
    const entry = pairs.get(fingerprint);

    if ((!entry || now >= entry.recheckAt) && !probes.has(fingerprint)) {
      checkDue = true;
    }

    if (!entry) {
      unchecked = true;
      continue;
    }

    if (entry.verdict.ok) {
      working = { state: 'working', source: credentials.source, productIds: sortedProductIds(entry.verdict.pluginIds) };
      break;
    }

    if (entry.verdict.kind === 'unavailable') {
      unreachable = true;
    }
  }

  if (checkDue) {
    checkInBackground(candidates);
  }

  if (working) return working;
  if (unchecked) return { state: 'unchecked', source: null, productIds: [] };

  return { state: unreachable ? 'unreachable' : 'refused', source: null, productIds: [] };
}

/** A pair configured under the one-product names (FREEMIUS_PUBLIC_KEY / FREEMIUS_SECRET_KEY, or their CMS fields). */
export function isLegacyFreemiusDeveloperSource(source: FreemiusDeveloperCredentialSource | null | undefined): boolean {
  return source === 'cms-legacy' || source === 'env-legacy';
}

/** What `describeFreemiusDeveloperPairs` says about a key set: sources and booleans, never key material. */
export type FreemiusDeveloperPairFacts = {
  /** Where each configured pair comes from, in the resolver's order. */
  sources: FreemiusDeveloperCredentialSource[];
  /**
   * The keys hold the public or the secret key of a dedicated pair (CMS developer fields,
   * FREEMIUS_DEVELOPER_*). The resolver lists such a copy once, under the dedicated source, so
   * `sources` cannot show it.
   */
  sharesDedicatedKey: boolean;
  /**
   * The working pair (the first configured pair whose verdict in memory is working) comes from the
   * one-product names (`cms-legacy` / `env-legacy`) and holds one of the keys.
   */
  sharesWorkingLegacyKey: boolean;
  /**
   * Freemius accepted one of the keys at developer scope earlier in this instance's life
   * (`verifiedDeveloperKeys`, memory only), whatever it says of that pair now: a pair revoked while
   * the instance runs.
   */
  sharesVerifiedKey: boolean;
};

/**
 * Facts about the configured developer key pairs for the key policy (`freemius-key-policy.ts`),
 * about `keys`: keys configured outside the developer fields (the one-product names as the store
 * resolves them, or their Freemius-sandbox twins), which may hold a developer pair. From
 * configuration and memory only: nothing here asks Freemius or waits on it, and no key material
 * leaves this module. Empty on the sandbox, where no developer entry resolves a key.
 */
export async function describeFreemiusDeveloperPairs(keys: {
  publicKey: string | null;
  secretKey: string | null;
}): Promise<FreemiusDeveloperPairFacts> {
  if (isSandboxEnvironment()) {
    return { sources: [], sharesDedicatedKey: false, sharesWorkingLegacyKey: false, sharesVerifiedKey: false };
  }

  const publicKey = keys.publicKey || null;
  const secretKey = keys.secretKey || null;
  const candidates = await resolveFreemiusDeveloperCredentialCandidates();
  const sharesKey = (credentials: FreemiusDeveloperCredentials) =>
    (publicKey !== null && credentials.publicKey === publicKey) || (secretKey !== null && credentials.secretKey === secretKey);
  const working = candidates.find((credentials) => pairs.get(fingerprintOf(credentials))?.verdict.ok === true);

  return {
    sources: candidates.map((credentials) => credentials.source),
    sharesDedicatedKey: candidates.some((credentials) => !isLegacyFreemiusDeveloperSource(credentials.source) && sharesKey(credentials)),
    sharesWorkingLegacyKey: Boolean(working && isLegacyFreemiusDeveloperSource(working.source) && sharesKey(working)),
    sharesVerifiedKey:
      (publicKey !== null && verifiedDeveloperKeys.has(keyHash('public', publicKey))) ||
      (secretKey !== null && verifiedDeveloperKeys.has(keyHash('secret', secretKey))),
  };
}

/* ------------------------------------------------ one-product keys, product scope --- */

/**
 * - `confirmed`: Freemius accepted the keys at the product's own scope: a 2xx whose body is that
 *   product (its `id`, and these keys' `public_key` when the body has one) and holds no `error`.
 * - `refused`: it did not: a 401, 403 or 404, as the HTTP status or as the status of an `error` in
 *   the body, or a body naming another product or public key.
 * - `unknown`: it did not answer (429, 5xx, a timeout, a body that is not the product: `{}`,
 *   `{"id": null}`, a list, an `error` without one of those statuses), or this instance already
 *   sent its share of these requests this minute.
 */
export type FreemiusOneProductKeysConfirmation = 'confirmed' | 'refused' | 'unknown';

type OneProductConfirmationEntry = {
  /** Freemius' last answer about these keys for this product; null before any. */
  answer: 'confirmed' | 'refused' | null;
  /** When it gave that answer. */
  answeredAt: number;
  /** When Freemius may be asked again. */
  recheckAt: number;
};

/** A key in the Authorization header: printable ASCII, no spaces (as the resolver requires). */
const HEADER_SAFE_KEY = /^[\x21-\x7e]{1,256}$/;
/** Answers kept, by `<product id>:<SHA-256 of the keys>`. Product ids come from signed webhooks too. */
const ONE_PRODUCT_CONFIRMATIONS_MAX = 64;
/** Requests sent per minute at most (re-checks of keys Freemius confirmed excepted). */
const ONE_PRODUCT_CONFIRMATIONS_PER_MINUTE = 10;
const oneProductConfirmations = new Map<string, OneProductConfirmationEntry>();
/** Requests in flight by the same key, so concurrent callers share one. */
const oneProductConfirmationReads = new Map<string, Promise<FreemiusOneProductKeysConfirmation>>();
/** When each request of the last minute was sent. */
const oneProductConfirmationTimes: number[] = [];

/**
 * What an entry says now. A confirmation kept through unanswered re-checks counts for as long as a
 * product secret read from Freemius may verify webhooks (FREEMIUS_WEBHOOK_SECRET_MAX_AGE_MS): keys
 * rotated because they leaked, with Freemius pushed into 429s meanwhile, must stop counting.
 */
function confirmationNow(entry: OneProductConfirmationEntry, now: number): FreemiusOneProductKeysConfirmation {
  if (entry.answer === 'refused') return 'refused';
  if (entry.answer === 'confirmed' && now >= entry.answeredAt && now - entry.answeredAt <= FREEMIUS_WEBHOOK_SECRET_MAX_AGE_MS) {
    return 'confirmed';
  }
  return 'unknown';
}

/**
 * Whether the minute's budget lets one more request go. A re-check of keys Freemius confirmed always
 * goes: only the product those keys belong to can hold such an answer, and a flood of other product
 * ids (signed with a leaked secret) must not keep that product from being confirmed again.
 */
function takeOneProductConfirmationSlot(now: number, recheckOfConfirmedKeys: boolean): boolean {
  const recent = oneProductConfirmationTimes.filter((at) => now >= at && now - at < 60_000);
  oneProductConfirmationTimes.splice(0, oneProductConfirmationTimes.length, ...recent);

  if (!recheckOfConfirmedKeys && oneProductConfirmationTimes.length >= ONE_PRODUCT_CONFIRMATIONS_PER_MINUTE) {
    return false;
  }

  oneProductConfirmationTimes.push(now);
  return true;
}

/** The HTTP status an `error` member of a Freemius body states (`http`, else a numeric `code`), or null. */
function statusOfErrorMember(error: unknown): number | null {
  if (!isRecord(error)) return null;

  for (const value of [error['http'], error['code']]) {
    const status = typeof value === 'number' ? value : typeof value === 'string' && /^\d{3}$/.test(value.trim()) ? Number(value) : NaN;

    if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }

  return null;
}

/**
 * What a 2xx answer to the product-scope GET says about the keys. Only a body that IS the product
 * confirms them: an object with no `error` member, `id` naming that product, and `public_key`, when
 * the body has one, naming the signing public key. Review 2026-11-13, round 3: anything not naming
 * another product confirmed, so a revoked developer pair left under the one-product names, its
 * developer scope answering 401 and a product-scope GET answering 200 `{}`, opened checkouts with
 * its public key and its secret verified every product's webhooks.
 * - The PHP SDK reads a body with an `error` member as an error whatever the HTTP status: one stating
 *   401, 403 or 404 (`error.http`, or a numeric `error.code`) refuses the keys, any other is no answer.
 * - An `id` naming another product, or a `public_key` naming another key, refuses them.
 * - Anything else (`{}`, `{"id": null}`, `{"plugins": []}`, a `public_key` that is not a key) is no
 *   answer: `unknown`, asked again after UNAVAILABLE_TTL_MS.
 */
function confirmationFromProductBody(body: unknown, productId: string, publicKey: string): FreemiusOneProductKeysConfirmation {
  if (!isRecord(body)) return 'unknown';

  if (Object.prototype.hasOwnProperty.call(body, 'error')) {
    const status = statusOfErrorMember(body['error']);
    return status === 401 || status === 403 || status === 404 ? 'refused' : 'unknown';
  }

  const answeredId = toFreemiusId(body['id']);
  const rawPublicKey = body['public_key'];
  const answeredPublicKey = typeof rawPublicKey === 'string' && rawPublicKey.trim() ? rawPublicKey.trim() : null;

  if ((answeredId !== null && answeredId !== productId) || (answeredPublicKey !== null && answeredPublicKey !== publicKey)) {
    return 'refused';
  }

  return answeredId === productId && (rawPublicKey === undefined || answeredPublicKey === publicKey) ? 'confirmed' : 'unknown';
}

/** One product-scope GET of the product, signed with `keys` as the PHP SDK signs at plugin scope. */
async function askFreemiusAboutOneProductKeys(productId: string, keys: SigningKeys): Promise<FreemiusOneProductKeysConfirmation> {
  try {
    const body = await getFromFreemius(`/v1/plugins/${productId}.json`, keys, PROBE_TIMEOUT_MS);

    return confirmationFromProductBody(body, productId, keys.publicKey);
  } catch (error) {
    if (isFreemiusApiError(error) && (error.kind === 'auth' || error.kind === 'not_found')) return 'refused';
    return 'unknown';
  }
}

/** Records an answer (an unanswered request keeps the last one, asked again after UNAVAILABLE_TTL_MS) in the bounded map. */
function recordOneProductConfirmation(cacheKey: string, answer: FreemiusOneProductKeysConfirmation): OneProductConfirmationEntry {
  const now = Date.now();
  const previous = oneProductConfirmations.get(cacheKey);
  const entry: OneProductConfirmationEntry =
    answer === 'unknown'
      ? { answer: previous?.answer ?? null, answeredAt: previous?.answeredAt ?? 0, recheckAt: now + UNAVAILABLE_TTL_MS }
      : { answer, answeredAt: now, recheckAt: now + (answer === 'confirmed' ? VERIFIED_TTL_MS : REFUSED_TTL_MS) };

  oneProductConfirmations.delete(cacheKey);

  if (oneProductConfirmations.size >= ONE_PRODUCT_CONFIRMATIONS_MAX) {
    // The oldest entry that holds no current confirmation goes first, so other product ids can
    // never push out the product whose keys these are.
    let victim: string | undefined;

    for (const [key, kept] of oneProductConfirmations) {
      if (confirmationNow(kept, now) !== 'confirmed') {
        victim = key;
        break;
      }
    }

    oneProductConfirmations.delete(victim ?? oneProductConfirmations.keys().next().value ?? '');
  }

  oneProductConfirmations.set(cacheKey, entry);
  return entry;
}

/**
 * Whether `keys` (the one-product keys, FREEMIUS_PUBLIC_KEY / FREEMIUS_SECRET_KEY as the store
 * resolves them) are product `productId`'s own, per one product-scope request signed with them.
 * For the key policy (`decideFreemiusOneProductStandIn`) when every configured developer pair comes
 * from the one-product names and Freemius refuses it at developer scope: those names then hold
 * either a one-product install's keys (it also filled in its developer id) or a revoked developer
 * pair left there, whose secret, possibly the leaked one, must not verify every product's webhooks.
 * - `confirmed` is kept VERIFIED_TTL_MS, `refused` REFUSED_TTL_MS, per (product, keys).
 * - `unknown` (no answer) is remembered UNAVAILABLE_TTL_MS, never cached as an answer: it keeps the
 *   last answer, a confirmation for FREEMIUS_WEBHOOK_SECRET_MAX_AGE_MS at most.
 * Product ids reach here from webhooks signed with these keys (a leaked secret signs any id), so the
 * memory is bounded and requests are capped per minute (past the cap: `unknown`, nothing sent).
 * Concurrent calls share one request. Keys that cannot be sent are `refused`; on the public sandbox
 * nothing is sent (`unknown`). Nothing it holds or receives is logged or returned.
 */
export async function confirmFreemiusOneProductKeys(
  productId: unknown,
  keys: { publicKey: string | null; secretKey: string | null }
): Promise<FreemiusOneProductKeysConfirmation> {
  if (isSandboxEnvironment()) {
    return 'unknown';
  }

  const id = toFreemiusId(productId);
  const publicKey = keys.publicKey || null;
  const secretKey = keys.secretKey || null;

  if (!id || !publicKey || !secretKey || !HEADER_SAFE_KEY.test(publicKey) || secretKey.length > 256) {
    return 'refused';
  }

  const cacheKey = `${id}:${crypto.createHash('sha256').update(`${publicKey}\n${secretKey}`).digest('hex')}`;
  const now = Date.now();
  const entry = oneProductConfirmations.get(cacheKey);

  if (entry && now < entry.recheckAt) {
    return confirmationNow(entry, now);
  }

  const pending = oneProductConfirmationReads.get(cacheKey);

  if (pending) {
    return pending;
  }

  if (!takeOneProductConfirmationSlot(now, entry?.answer === 'confirmed')) {
    return entry ? confirmationNow(entry, now) : 'unknown';
  }

  const read: Promise<FreemiusOneProductKeysConfirmation> = askFreemiusAboutOneProductKeys(id, { scopeId: id, publicKey, secretKey })
    .then((answer) => confirmationNow(recordOneProductConfirmation(cacheKey, answer), Date.now()))
    .finally(() => {
      if (oneProductConfirmationReads.get(cacheKey) === read) oneProductConfirmationReads.delete(cacheKey);
    });
  oneProductConfirmationReads.set(cacheKey, read);

  return read;
}

/** Checks `candidates` with Freemius after the response (`after()`), or at once outside a request. Never throws. */
function checkInBackground(candidates: readonly FreemiusDeveloperCredentials[]): void {
  const run = async () => {
    try {
      await verifyCandidates(candidates);
    } catch {
      // verifyPair records every failure as a verdict; nothing here may reach a render.
    }
  };

  try {
    after(run);
  } catch {
    void run();
  }
}

/* ------------------------------------------------------------- catalog reader --- */

/** What Sync from Freemius reads: the products, their plans, a plan, its pricing. */
const CATALOG_PATH = /^\/plugins(?:\/[1-9]\d{0,19}(?:\/plans(?:\/[1-9]\d{0,19}(?:\/pricing)?)?)?)?\.json$/;

export type FreemiusCatalogReader = {
  developerId: string;
  /** GET a catalog path relative to the developer (`/plugins.json`, `/plugins/1/plans/2/pricing.json`). */
  read(path: string): Promise<any>;
};

/**
 * The read-only reader Sync from Freemius uses, and the one developer-scope entry that runs on the
 * public sandbox, for the demo's own 15-minute catalog reset only: the CMS Sync refuses there, and
 * `findDeveloperKeyProblems` (tools/scripts/lib/sandbox-guards.js) checks every caller. It sends GET
 * requests to catalog paths only, with the first configured pair Freemius accepts at developer
 * scope. Throws `not_configured` without a developer id and pair, the last refusal when Freemius
 * accepts none, and `unavailable` when Freemius fails to answer the first product list, a 2xx that
 * is not a product list included (`verifyPair` reads it the same way).
 */
export async function openFreemiusCatalogReader(): Promise<FreemiusCatalogReader> {
  const candidates = await resolveFreemiusDeveloperCredentialCandidates();

  if (candidates.length === 0) {
    throw new FreemiusApiError(
      'not_configured',
      'Sync from Freemius needs the Freemius developer ID and developer key pair (CMS → Payments, or FREEMIUS_DEVELOPER_ID with FREEMIUS_DEVELOPER_PUBLIC_KEY / FREEMIUS_DEVELOPER_SECRET_KEY).'
    );
  }

  let lastError: unknown = null;

  for (const credentials of candidates) {
    const productsPath = `/v1/developers/${credentials.developerId}/plugins.json`;

    try {
      const products = await getFromFreemius(productsPath, developerScope(credentials), REQUEST_TIMEOUT_MS);

      if (!isRecord(products) || !Array.isArray(products['plugins'])) {
        // A 2xx that is not a product list (an HTML page, an empty body, {}, {"plugins": null}) is
        // no answer. Read as an empty catalog, Sync reported 0 products and dropped every cached
        // verdict and key (forgetFreemiusDeveloperCaches).
        throw new FreemiusApiError('unavailable', 'Freemius answered the product list with something that is not a product list.', {
          path: productsPath,
        });
      }

      let firstListRead = false;

      return {
        developerId: credentials.developerId,
        read: async (path: string) => {
          if (!CATALOG_PATH.test(path)) {
            throw new FreemiusApiError('rejected', 'Sync from Freemius reads products, plans and pricing only.');
          }

          if (path === '/plugins.json' && !firstListRead) {
            firstListRead = true;
            return products;
          }

          return getFromFreemius(`/v1/developers/${credentials.developerId}${path}`, developerScope(credentials), REQUEST_TIMEOUT_MS);
        },
      };
    } catch (error) {
      lastError = error;

      // A refusal of this pair moves on to the next one, read as the developer check reads it
      // (`probeFailureKind`, this being the first page): 401/403, another 4xx, or a 404 (no such
      // developer for these keys). On nextblock.dev's order (the CMS one-product fields, then the
      // developer pair under the legacy env names) a 404 to the first stopped Sync before the pair
      // that checkout and webhooks use. Freemius failing to answer stops it.
      if (probeFailureKind(error, 0) !== 'unavailable') continue;

      throw error;
    }
  }

  throw lastError;
}
