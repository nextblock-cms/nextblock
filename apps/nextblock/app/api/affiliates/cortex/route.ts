import 'server-only';

import { isStepCount, streamText, type ToolSet } from 'ai';
import { after, NextResponse } from 'next/server';

import {
  AFFILIATES_COPILOT_COPY,
  RETAILER_COPILOT_MAX_IMAGE_LOOKUPS_PER_REQUEST,
  RETAILER_COPILOT_TOOL_NAMES,
  buildRetailerCopilotInstructions,
  collectRetailerCopilotUnsplashDownloads,
  createAffiliatesCopy,
  createRetailerCopilotTools,
  formatAffiliateMoney,
  type AffiliatesCopyTranslate,
  type RetailerCopilotProduct,
  type RetailerCopilotToolErrorCode,
  type RetailerCopilotToolName,
  type StorefrontBlockNode,
} from '@nextblock-cms/affiliates/server';
import {
  buildCortexAiRoutingPolicy,
  createCortexAiOpenRouterClient,
  isOpenRouterRateLimitError,
  isOpenRouterRecoverableRoutingError,
  maybeTriggerStockPhotoDownloads,
  omitUnsupportedCortexAiModelOptions,
  safeParseCortexAiModelSelection,
  type CortexAiStoredModelSelection,
} from '@nextblock-cms/cortex';
import { getSsgSupabaseClient, verifyPackageOnline } from '@nextblock-cms/db/server';
import { buildPublishedAtOrFilter } from '@nextblock-cms/utils';

import { searchRetailerCopilotStockImage } from '../../../../lib/affiliates/copilot-stock-images';
import { getStorefrontImageOrigins } from '../../../../lib/affiliates/image-origins';
import { requireRetailer } from '../../../../lib/affiliates/retailer-actor';
import { enforceRetailerCopilotRequestQuotas } from '../../../../lib/cortex-ai/request-quota';
import {
  buildUntrustedDataInstruction,
  createUntrustedDataBoundary,
  wrapUntrustedData,
} from '../../../../lib/cortex-ai/untrusted-tool-results';
import { z } from '../../../../lib/zod-config';
import { isAffiliatesProgramActive } from '../../../../lib/affiliates/package-state';

/**
 * The partner storefront copilot (SPEC §8, ADDENDUM C13): a hard-sandboxed Cortex AI endpoint for
 * RTL partners (and ADMIN previewing the portal) that can only write the partner's bio, storefront
 * sections and rewrites of the copy they selected.
 *
 * Isolation, in order:
 * 1. `requireRetailer({ allowAdmin: true })`: session, enrolled second factor, own role (`RTL`, or
 *    ADMIN), the affiliate program (Affiliates and Commerce Pro) and an ACTIVE affiliate account.
 *    Any refusal is one generic 403. The admin agent (`/api/ai/global-agent`) and `/api/mcp` stay
 *    ADMIN-only on their own.
 * 2. The per-user AI request cap and the global partner-copilot cap (one `cortex_request_log` row
 *    per call, fail closed) before anything can reach a model. A request either cap refuses, or
 *    that this route turns away before the model call (403, 400, 503, 500), is taken back out of
 *    the log (`release()`), so the shared window counts only model calls and keeps admitting.
 * 3. The affiliate program (`isAffiliatesProgramActive()`) and `cortex-ai` active: the copilot spends
 *    the Cortex credential.
 * 4. A strict, bounded body. The system prompt is built here; the body has no system role.
 * 5. EXACTLY the three output-only `RETAILER_COPILOT_TOOL_NAMES` tools. No Cortex admin tool, no
 *    database tool, no navigation or analytics tool is registered, so the model has nothing to
 *    reach store data with; the instructions also make it decline those requests. Every value the
 *    partner or the store wrote (profile, bio, page title, selection, catalog) reaches the prompt
 *    only inside the request's untrusted-data markers. One tool set per request holds its budgets
 *    (3 sections, 3 stock photo lookups on the operator's keys, so at most 3 Unsplash pings), and
 *    the tool calls of a step run one at a time.
 *
 * The response is a server-sent event stream: `status` (5 s heartbeat), `tool-call` { toolName },
 * `tool-result` { toolName, output }, `tool-error` { toolName, message }, `text-delta` (the reply,
 * buffered and sent once), `error` { code, message } and `finish`. Messages are generic and
 * localized; no raw error text, model id, credential source or `meta` event is ever sent. A model
 * fallback happens only while no tool has run, so a retry never duplicates a suggestion.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_BODY_BYTES = 128 * 1024;
const MAX_MESSAGES = 12;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_SELECTION_LENGTH = 4000;
const MAX_SANDBOX_KEY_LENGTH = 512;
const MAX_SANDBOX_MODEL_LENGTH = 16_000;

/** At most this many models are tried for one request (the routing chain can be longer). */
const MAX_MODEL_ATTEMPTS = 3;
const COPILOT_MAX_STEPS = 3;
const COPILOT_MAX_OUTPUT_TOKENS = 3000;
const COPILOT_TEMPERATURE = 0.5;
/**
 * The tool calls of one step run one at a time, in the order the model made them (the AI SDK
 * runs them all at once by default): the request's photo budget goes to the first sections, and
 * at most one section's lookups are in flight.
 */
const COPILOT_TOOL_CALL_CONCURRENCY = 1;

const HEARTBEAT_INTERVAL_MS = 5000;
/** An attempt with no stream activity for this long is aborted. */
const ATTEMPT_IDLE_TIMEOUT_MS = 30_000;
/** The whole stream ends before `maxDuration`, so the partner always gets `finish`. */
const REQUEST_DEADLINE_MS = 50_000;

/** The reply is capped so the panel can send it back as conversation history. */
const MAX_REPLY_LENGTH = MAX_MESSAGE_LENGTH;
const MAX_TEXT_BUFFER = 16_000;

const CATALOG_LIMIT = 40;
const CATALOG_COLUMNS = 'id, title, short_description, price, prices, translation_group_id';
const MAX_CATALOG_TITLE_LENGTH = 160;
const MAX_CATALOG_DESCRIPTION_LENGTH = 240;

/**
 * Download triggers pinged per request. Every delivered photo comes from one of the tool set's
 * lookups, so the photo budget bounds the pings, and every delivered Unsplash photo is pinged.
 */
const MAX_UNSPLASH_DOWNLOADS = RETAILER_COPILOT_MAX_IMAGE_LOOKUPS_PER_REQUEST;
/** The only download triggers ever pinged with the operator's Unsplash key. */
const UNSPLASH_DOWNLOAD_PREFIX = 'https://api.unsplash.com/photos/';

const COPILOT_ERRORS = {
  forbidden: 'The storefront assistant is not available for this account.',
  inactive: 'The storefront assistant is not available for this workspace.',
  invalid: 'Invalid storefront assistant request.',
  unavailable: 'The storefront assistant is unavailable right now. Please try again later.',
  failed: 'The storefront assistant could not start. Please try again.',
} as const;

const SSE_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-cache, no-store, no-transform',
  Connection: 'keep-alive',
  'Content-Type': 'text/event-stream; charset=utf-8',
  'X-Accel-Buffering': 'no',
};

const COPILOT_TOOL_NAME_SET: ReadonlySet<string> = new Set(RETAILER_COPILOT_TOOL_NAMES);
const COPILOT_TOOL_ERROR_CODES: ReadonlySet<RetailerCopilotToolErrorCode> = new Set<RetailerCopilotToolErrorCode>([
  'invalid_input',
  'empty_output',
  'empty_section',
  'section_limit',
]);

const copilotMessageSchema = z.strictObject({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
});

const copilotRequestSchema = z
  .strictObject({
    messages: z.array(copilotMessageSchema).min(1).max(MAX_MESSAGES),
    locale: z.enum(['en', 'fr']),
    selection: z.string().max(MAX_SELECTION_LENGTH).nullable().optional(),
  })
  .refine((body) => body.messages[body.messages.length - 1]?.role === 'user', {
    message: 'The last message must come from the partner.',
  });

type CopilotRequest = z.infer<typeof copilotRequestSchema>;
type CopilotLocale = CopilotRequest['locale'];

type CopilotStreamErrorCode = 'timeout' | 'failed';

type CopilotStreamEvent =
  | { type: 'status' }
  | { type: 'tool-call'; toolName: RetailerCopilotToolName }
  | { type: 'tool-result'; toolName: RetailerCopilotToolName; output: Record<string, unknown> }
  | { type: 'tool-error'; toolName?: RetailerCopilotToolName; message: string }
  | { type: 'text-delta'; text: string }
  | { type: 'error'; code: CopilotStreamErrorCode; message: string }
  | { type: 'finish' };

/** The slice of an AI SDK stream part this route reads. */
type CopilotStreamPart = {
  type: string;
  text?: unknown;
  toolName?: unknown;
  output?: unknown;
  error?: unknown;
  preliminary?: unknown;
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** Server log only (never streamed or returned): the message, bounded. */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

function logCopilotError(context: string, error: unknown) {
  console.error(`[affiliates copilot] ${context}:`, describeError(error));
}

/** The JSON body, read with a byte cap; undefined for anything oversized or malformed. */
async function readJsonBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return undefined;
  if (!request.body) return undefined;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Catalog: at most 40 active, published products the copilot may feature (the only ids a
// generated product grid keeps), read with the public client, the partner's language first.
// ---------------------------------------------------------------------------------------------

const PRODUCT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HTML_ENTITY_TEXT: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
  '#39': "'",
};

/** Plain text of a store-authored field (short descriptions may hold HTML), one line, capped. */
function catalogText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const source = value.length > max * 8 ? value.slice(0, max * 8) : value;
  const text = source
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|apos|gt|lt|nbsp|quot|#39);/g, (_match, name: string) => HTML_ENTITY_TEXT[name] ?? ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function positiveMinorAmount(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** The regular price in the store currency, formatted for the partner's language. */
function catalogPriceLabel(row: UnknownRecord, currency: string | null, locale: CopilotLocale): string | null {
  if (currency === null) return null;
  const prices = isRecord(row['prices']) ? row['prices'] : null;
  const amount =
    (prices ? positiveMinorAmount(prices[currency]) ?? positiveMinorAmount(prices[currency.toLowerCase()]) : null) ??
    positiveMinorAmount(row['price']);
  if (amount === null) return null;
  try {
    return formatAffiliateMoney(amount, currency, locale);
  } catch {
    return null;
  }
}

function toCopilotProduct(row: unknown, currency: string | null, locale: CopilotLocale): RetailerCopilotProduct | null {
  if (!isRecord(row)) return null;
  const id = typeof row['id'] === 'string' ? row['id'].trim().toLowerCase() : '';
  const title = catalogText(row['title'], MAX_CATALOG_TITLE_LENGTH);
  if (!PRODUCT_ID_PATTERN.test(id) || title === '') return null;
  const shortDescription = catalogText(row['short_description'], MAX_CATALOG_DESCRIPTION_LENGTH);
  return {
    id,
    title,
    shortDescription: shortDescription === '' ? null : shortDescription,
    priceLabel: catalogPriceLabel(row, currency, locale),
  };
}

function findCatalogLanguageId(rows: unknown, locale: CopilotLocale): number | null {
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isRecord(row)) continue;
    const code = typeof row['code'] === 'string' ? row['code'].trim().toLowerCase() : '';
    const id = typeof row['id'] === 'number' ? row['id'] : Number(row['id']);
    if (Number.isSafeInteger(id) && (code === locale || code.startsWith(`${locale}-`))) return id;
  }
  return null;
}

/** The store's default currency (or its only active one); null when unknown, so no price shows. */
function findStoreCurrency(rows: unknown): string | null {
  const currencies = (Array.isArray(rows) ? rows : []).filter(isRecord);
  const chosen = currencies.find((row) => row['is_default'] === true) ?? (currencies.length === 1 ? currencies[0] : undefined);
  const code = typeof chosen?.['code'] === 'string' ? chosen['code'].trim().toUpperCase() : '';
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

function queryRows(result: { data: unknown; error: unknown }): unknown[] {
  return result.error || !Array.isArray(result.data) ? [] : result.data;
}

/**
 * The copilot catalog for `locale`. Products in the partner's language come first; products of
 * other languages fill the rest only when their translation group is not already listed. Never
 * throws: a read failure means an empty catalog (the copilot then adds no product grid).
 */
async function loadRetailerCopilotCatalog(locale: CopilotLocale): Promise<RetailerCopilotProduct[]> {
  try {
    const client = getSsgSupabaseClient();
    const [languages, currencies] = await Promise.all([
      client.from('languages').select('id, code').eq('is_active', true),
      client.from('currencies').select('code, is_default').eq('is_active', true),
    ]);
    const languageId = languages.error ? null : findCatalogLanguageId(languages.data, locale);
    const currency = currencies.error ? null : findStoreCurrency(currencies.data);
    const publishedFilter = buildPublishedAtOrFilter();

    const products = (language: 'same' | 'other' | 'any', limit: number) => {
      let query = client.from('products').select(CATALOG_COLUMNS).eq('status', 'active').or(publishedFilter);
      if (language === 'same' && languageId !== null) query = query.eq('language_id', languageId);
      if (language === 'other' && languageId !== null) query = query.neq('language_id', languageId);
      return query.order('created_at', { ascending: false }).limit(limit);
    };

    const [preferred, others] = await Promise.all([
      languageId === null ? products('any', CATALOG_LIMIT) : products('same', CATALOG_LIMIT),
      languageId === null ? Promise.resolve({ data: [] as unknown[], error: null }) : products('other', CATALOG_LIMIT * 2),
    ]);
    if (preferred.error || others.error) {
      console.warn('[affiliates copilot] Catalog read failed; continuing with what was read.');
    }

    const catalog: RetailerCopilotProduct[] = [];
    const ids = new Set<string>();
    const groups = new Set<string>();
    for (const row of [...queryRows(preferred), ...queryRows(others)]) {
      if (catalog.length >= CATALOG_LIMIT) break;
      const product = toCopilotProduct(row, currency, locale);
      if (!product || ids.has(product.id)) continue;
      const group = isRecord(row) && typeof row['translation_group_id'] === 'string' ? row['translation_group_id'] : null;
      if (group !== null && groups.has(group)) continue;
      ids.add(product.id);
      if (group !== null) groups.add(group);
      catalog.push(product);
    }
    return catalog;
  } catch (error) {
    logCopilotError('Catalog read failed', error);
    return [];
  }
}

// ---------------------------------------------------------------------------------------------
// Sandbox credentials: the visitor's own OpenRouter key, honoured only on the hosted sandbox.
// ---------------------------------------------------------------------------------------------

function readSandboxCredentials(request: Request): {
  apiKey: string | null;
  modelSelection: CortexAiStoredModelSelection | null;
} {
  if (process.env.NEXT_PUBLIC_IS_SANDBOX !== 'true') return { apiKey: null, modelSelection: null };

  const rawKey = request.headers.get('x-sandbox-openrouter-key')?.trim() ?? '';
  const apiKey = rawKey !== '' && rawKey.length <= MAX_SANDBOX_KEY_LENGTH ? rawKey : null;
  const rawModel = request.headers.get('x-sandbox-openrouter-model');
  let modelSelection: CortexAiStoredModelSelection | null = null;
  if (apiKey && rawModel && rawModel.length <= MAX_SANDBOX_MODEL_LENGTH) {
    try {
      modelSelection = safeParseCortexAiModelSelection(JSON.parse(rawModel));
    } catch {
      modelSelection = null;
    }
  }
  return { apiKey, modelSelection };
}

// ---------------------------------------------------------------------------------------------
// Stream helpers
// ---------------------------------------------------------------------------------------------

const encoder = new TextEncoder();

function encodeCopilotEvent(event: CopilotStreamEvent): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

function knownToolName(value: unknown): RetailerCopilotToolName | null {
  return typeof value === 'string' && COPILOT_TOOL_NAME_SET.has(value) ? (value as RetailerCopilotToolName) : null;
}

/**
 * The tool output the browser receives: a success exactly as the lib executor returned it; a
 * failure reduced to `{ ok: false, error }` (the English `message` is meant for the model).
 */
function toClientToolOutput(output: unknown): Record<string, unknown> {
  if (isRecord(output) && output['ok'] === true) return output;
  const error =
    isRecord(output) && typeof output['error'] === 'string' && COPILOT_TOOL_ERROR_CODES.has(output['error'] as RetailerCopilotToolErrorCode)
      ? output['error']
      : 'invalid_input';
  return { ok: false, error };
}

function collectUnsplashDownloads(output: Record<string, unknown>, into: Set<string>) {
  if (output['ok'] !== true || !Array.isArray(output['nodes'])) return;
  for (const location of collectRetailerCopilotUnsplashDownloads(output['nodes'] as StorefrontBlockNode[])) {
    if (into.size >= MAX_UNSPLASH_DOWNLOADS) return;
    if (typeof location === 'string' && location.startsWith(UNSPLASH_DOWNLOAD_PREFIX)) into.add(location);
  }
}

/** Structural markers of a raw tool-call payload printed as text (same test as the admin agent). */
function looksLikeRawToolCallLeak(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes('<toolcall') ||
    normalized.includes('</toolcall') ||
    normalized.includes('<tool_call') ||
    normalized.includes('</tool_call') ||
    normalized.includes('<function_call') ||
    (normalized.includes('"arguments"') && (normalized.includes('"name"') || normalized.includes('"tool"')))
  );
}

/** A provider's rate-limit error returned as the reply text. */
function looksLikeRateLimitText(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes('rate limit exceeded') ||
    normalized.includes('free-models-per-day') ||
    normalized.includes('too many requests')
  );
}

function toReply(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return trimmed.length > MAX_REPLY_LENGTH ? `${trimmed.slice(0, MAX_REPLY_LENGTH - 1).trimEnd()}…` : trimmed;
}

/** Aborts on the partner leaving (request signal), on `abort()` and at the request deadline. */
function createAbortScope(requestSignal: AbortSignal, deadlineMs: number) {
  const controller = new AbortController();
  const onRequestAbort = () => controller.abort(requestSignal.reason);
  if (requestSignal.aborted) controller.abort(requestSignal.reason);
  else requestSignal.addEventListener('abort', onRequestAbort, { once: true });
  const deadline = setTimeout(() => controller.abort(new Error('The copilot request deadline was reached.')), deadlineMs);
  return {
    signal: controller.signal,
    abort: (reason?: unknown) => controller.abort(reason),
    dispose: () => {
      clearTimeout(deadline);
      requestSignal.removeEventListener('abort', onRequestAbort);
    },
  };
}

/** One model attempt's signal: the scope, plus an idle timeout reset on every stream part. */
function createAttemptAbort(parent: AbortSignal, idleTimeoutMs: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error('The model stopped responding.')), idleTimeoutMs);
  };
  const onParentAbort = () => controller.abort(parent.reason);
  if (parent.aborted) controller.abort(parent.reason);
  else parent.addEventListener('abort', onParentAbort, { once: true });
  arm();
  return {
    signal: controller.signal,
    bump: arm,
    cleanup: () => {
      if (timer !== undefined) clearTimeout(timer);
      parent.removeEventListener('abort', onParentAbort);
    },
  };
}

interface CopilotRunContext {
  signal: AbortSignal;
  isPartnerGone: () => boolean;
  modelIds: readonly string[];
  createModel: (modelId: string) => unknown;
  modelSelection: CortexAiStoredModelSelection | null;
  instructions: string;
  messages: CopilotRequest['messages'];
  tools: ToolSet;
  copy: AffiliatesCopyTranslate;
  send: (event: CopilotStreamEvent) => void;
  downloads: Set<string>;
}

type CopilotAttemptResult =
  | { kind: 'done'; reply: string | null; delivered: boolean }
  | { kind: 'retry'; reason: unknown; delivered: boolean; timedOut: boolean }
  | { kind: 'failed'; reason: unknown; delivered: boolean }
  | { kind: 'aborted'; delivered: boolean };

async function runCopilotAttempt(ctx: CopilotRunContext, modelId: string): Promise<CopilotAttemptResult> {
  const attempt = createAttemptAbort(ctx.signal, ATTEMPT_IDLE_TIMEOUT_MS);
  const heartbeat = setInterval(() => ctx.send({ type: 'status' }), HEARTBEAT_INTERVAL_MS);
  let text = '';
  let toolActivity = false;
  let delivered = false;
  // The attempt was aborted. Only its own idle timer (not the deadline, not the partner leaving)
  // with no tool run yet may hand over to the next model.
  const abortedResult = (): CopilotAttemptResult =>
    !ctx.signal.aborted && !toolActivity
      ? { kind: 'retry', reason: new Error('The model stopped responding.'), delivered, timedOut: true }
      : { kind: 'aborted', delivered };

  try {
    const options = omitUnsupportedCortexAiModelOptions(
      {
        abortSignal: attempt.signal,
        instructions: ctx.instructions,
        maxOutputTokens: COPILOT_MAX_OUTPUT_TOKENS,
        maxRetries: 0,
        messages: ctx.messages,
        stopWhen: isStepCount(COPILOT_MAX_STEPS),
        temperature: COPILOT_TEMPERATURE,
        toolCallConcurrency: COPILOT_TOOL_CALL_CONCURRENCY,
        tools: ctx.tools,
      } as Record<string, unknown>,
      { modelId, modelSelection: ctx.modelSelection },
    );
    const result = streamText({ ...options, model: ctx.createModel(modelId) } as Parameters<typeof streamText>[0]);

    for await (const rawPart of result.stream) {
      attempt.bump();
      const part = rawPart as CopilotStreamPart;
      switch (part.type) {
        case 'text-delta': {
          if (typeof part.text === 'string' && text.length < MAX_TEXT_BUFFER) text += part.text;
          break;
        }
        case 'tool-call': {
          toolActivity = true;
          const toolName = knownToolName(part.toolName);
          if (toolName) ctx.send({ type: 'tool-call', toolName });
          break;
        }
        case 'tool-result': {
          if (part.preliminary === true) break;
          toolActivity = true;
          const toolName = knownToolName(part.toolName);
          if (!toolName) break;
          const output = toClientToolOutput(part.output);
          ctx.send({ type: 'tool-result', toolName, output });
          if (output['ok'] === true) delivered = true;
          if (toolName === 'generate_storefront_section') collectUnsplashDownloads(output, ctx.downloads);
          break;
        }
        case 'tool-error': {
          toolActivity = true;
          const toolName = knownToolName(part.toolName);
          ctx.send({
            type: 'tool-error',
            ...(toolName ? { toolName } : {}),
            message: ctx.copy('affiliates.copilot.error_tool'),
          });
          break;
        }
        case 'error':
          throw part.error ?? new Error('The copilot stream failed.');
        default:
          break;
      }
    }

    if (attempt.signal.aborted) return abortedResult();
    const suspicious = looksLikeRawToolCallLeak(text) || looksLikeRateLimitText(text);
    const reply = suspicious ? null : toReply(text);
    if (!toolActivity && reply === null) {
      return { kind: 'retry', reason: new Error('The model returned no usable reply.'), delivered, timedOut: false };
    }
    return { kind: 'done', reply, delivered };
  } catch (error) {
    if (attempt.signal.aborted) return abortedResult();
    if (!toolActivity && (isOpenRouterRateLimitError(error) || isOpenRouterRecoverableRoutingError(error))) {
      return { kind: 'retry', reason: error, delivered, timedOut: false };
    }
    return { kind: 'failed', reason: error, delivered };
  } finally {
    clearInterval(heartbeat);
    attempt.cleanup();
  }
}

async function runCopilotAttempts(ctx: CopilotRunContext): Promise<void> {
  const modelIds = ctx.modelIds.slice(0, MAX_MODEL_ATTEMPTS);
  let delivered = false;

  for (let index = 0; index < modelIds.length; index += 1) {
    if (ctx.signal.aborted) break;
    const result = await runCopilotAttempt(ctx, modelIds[index] as string);
    delivered = delivered || result.delivered;

    if (result.kind === 'retry' && index < modelIds.length - 1) {
      console.warn('[affiliates copilot] Model attempt failed before any tool ran; trying the next model:', describeError(result.reason));
      continue;
    }
    if (result.kind === 'done') {
      if (result.reply !== null) ctx.send({ type: 'text-delta', text: result.reply });
      return;
    }
    if (result.kind === 'aborted' || (result.kind === 'retry' && result.timedOut)) {
      if (!ctx.isPartnerGone() && !delivered) {
        ctx.send({ type: 'error', code: 'timeout', message: ctx.copy('affiliates.copilot.error_timeout') });
      }
      return;
    }
    logCopilotError('Model attempt failed', result.reason);
    if (!delivered) ctx.send({ type: 'error', code: 'failed', message: ctx.copy('affiliates.copilot.error_generic') });
    return;
  }

  // Reached only when the deadline passed between attempts or no model was routed.
  if (ctx.isPartnerGone() || delivered) return;
  if (ctx.signal.aborted) {
    ctx.send({ type: 'error', code: 'timeout', message: ctx.copy('affiliates.copilot.error_timeout') });
  } else {
    ctx.send({ type: 'error', code: 'failed', message: ctx.copy('affiliates.copilot.error_generic') });
  }
}

interface CopilotStreamOptions extends Omit<CopilotRunContext, 'signal' | 'isPartnerGone' | 'send' | 'downloads'> {
  requestSignal: AbortSignal;
  /** Called once with the Unsplash download triggers of the sections that were delivered. */
  onDone: (unsplashDownloads: string[]) => void;
}

function createRetailerCopilotStream(options: CopilotStreamOptions): ReadableStream<Uint8Array> {
  const scope = createAbortScope(options.requestSignal, REQUEST_DEADLINE_MS);
  const downloads = new Set<string>();
  let closed = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: CopilotStreamEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encodeCopilotEvent(event));
        } catch {
          closed = true;
        }
      };

      try {
        await runCopilotAttempts({
          ...options,
          signal: scope.signal,
          isPartnerGone: () => closed || options.requestSignal.aborted,
          send,
          downloads,
        });
      } catch (error) {
        logCopilotError('Stream failed', error);
        send({ type: 'error', code: 'failed', message: options.copy('affiliates.copilot.error_generic') });
      } finally {
        send({ type: 'finish' });
        scope.dispose();
        options.onDone([...downloads]);
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // Already closed by a cancel.
          }
        }
      }
    },
    cancel(reason) {
      closed = true;
      scope.abort(reason);
    },
  });
}

/**
 * Unsplash requires its download endpoint to be pinged when a photo is used (ADDENDUM C13). The
 * pings run after the response with the operator's key (resolved by Cortex, never sent anywhere
 * else), only for triggers on `api.unsplash.com/photos/` that came from delivered sections.
 */
function scheduleUnsplashDownloadPings(
  locationsReady: Promise<string[]>,
  supabase: Parameters<typeof maybeTriggerStockPhotoDownloads>[1],
) {
  const task = async () => {
    try {
      const locations = await locationsReady;
      if (locations.length === 0) return;
      await maybeTriggerStockPhotoDownloads(
        locations.map((downloadLocation) => ({ content: { attribution: { provider: 'unsplash', downloadLocation } } })),
        supabase,
      );
    } catch (error) {
      logCopilotError('Unsplash download ping failed', error);
    }
  };

  try {
    after(task);
  } catch {
    // Outside a request scope (scripts, tests): run it without blocking the response.
    void task();
  }
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function serializeUntrustedValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return 'null';
  }
}

export async function POST(request: Request): Promise<Response> {
  let access: Awaited<ReturnType<typeof requireRetailer>>;
  try {
    access = await requireRetailer({ allowAdmin: true });
  } catch {
    // Unauthorized, Forbidden, Suspended, PackageInactive or a failed lookup: one generic answer.
    return jsonError(COPILOT_ERRORS.forbidden, 403);
  }

  // Set once both caps admitted the request, and cleared once the model call starts: any other way
  // out (403, 400, 503, 500) takes the request back out of the log in `finally`, so the shared cap
  // never counts a request that did not reach a model.
  let releaseQuota: (() => Promise<void>) | null = null;
  try {
    const { actor, supabase } = access;

    const quota = await enforceRetailerCopilotRequestQuotas({ role: actor.role, userId: actor.userId });
    if (quota.response) return quota.response;
    releaseQuota = quota.release;

    const [affiliatesActive, cortexActive] = await Promise.all([
      isAffiliatesProgramActive(),
      verifyPackageOnline('cortex-ai'),
    ]);
    if (!affiliatesActive || !cortexActive) return jsonError(COPILOT_ERRORS.inactive, 403);

    const parsed = copilotRequestSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) return jsonError(COPILOT_ERRORS.invalid, 400);
    const body = parsed.data;

    const catalog = await loadRetailerCopilotCatalog(body.locale);
    const sandbox = readSandboxCredentials(request);

    let client: Awaited<ReturnType<typeof createCortexAiOpenRouterClient>>;
    try {
      client = await createCortexAiOpenRouterClient({
        apiKey: sandbox.apiKey ?? undefined,
        modelSelection: sandbox.apiKey && sandbox.modelSelection ? sandbox.modelSelection : undefined,
      });
    } catch (error) {
      // No OpenRouter key (or an unreadable stored one): the operator's problem, not the partner's.
      logCopilotError('Cortex AI credentials are unavailable', error);
      return jsonError(COPILOT_ERRORS.unavailable, 503);
    }
    const routing = buildCortexAiRoutingPolicy({
      credentialSource: client.credentialSource,
      selectedModel: client.modelSelection,
    });

    const boundary = createUntrustedDataBoundary();
    const tools = createRetailerCopilotTools({
      catalog,
      allowedImageOrigins: getStorefrontImageOrigins(),
      searchStockImage: searchRetailerCopilotStockImage,
    });
    const instructions = buildRetailerCopilotInstructions({
      locale: body.locale,
      displayName: actor.affiliate?.display_name ?? null,
      handle: actor.affiliate?.handle ?? null,
      currentBio: actor.affiliate?.bio ?? null,
      pageTitle: actor.page?.title ?? null,
      catalog,
      selection: body.selection ?? null,
      wrapUntrusted: (source, value) => wrapUntrustedData({ boundary, source, value: serializeUntrustedValue(value) }),
      untrustedInstruction: buildUntrustedDataInstruction(boundary),
    });
    const copy = createAffiliatesCopy({ locale: body.locale, dictionary: AFFILIATES_COPILOT_COPY });

    const downloads = createDeferred<string[]>();
    const stream = createRetailerCopilotStream({
      requestSignal: request.signal,
      modelIds: routing.modelIds,
      createModel: (modelId) => client.model(modelId),
      modelSelection: routing.modelSelection,
      instructions,
      messages: body.messages,
      tools,
      copy,
      onDone: downloads.resolve,
    });
    // The stream has started the model call: from here on the request counts.
    releaseQuota = null;
    // Registered once the stream exists: its `onDone` always runs (the deadline bounds the wait).
    scheduleUnsplashDownloadPings(downloads.promise, supabase);

    return new Response(stream, { headers: SSE_HEADERS });
  } catch (error) {
    logCopilotError('Request failed', error);
    return jsonError(COPILOT_ERRORS.failed, 500);
  } finally {
    if (releaseQuota) await releaseQuota();
  }
}
