import { APICallError } from 'ai';

export const CORTEX_AI_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const CORTEX_AI_OPENROUTER_FREE_ROUTER_MODEL = 'openrouter/free';

/**
 * Free OpenRouter models Cortex AI falls through, best first.
 *
 * Last checked against the live catalog (`GET /api/v1/models`): 2026-09-15.
 *
 * Membership rule: the id ends with `:free`, is present in the catalog with
 * `tools` in `supported_parameters` (tool calling is mandatory), has no
 * `expiration_date`, is a general-purpose text model of roughly 100B+ total
 * parameters (no content-safety, finance, health or vision-only builds), and
 * ranks by total parameters, weekly usage, context length, release date and
 * `structured_outputs` support. The first entry doubles as
 * `defaultStructuredOutputModel`, so it must support `structured_outputs`.
 *
 * `ai-model-registry.test.ts` asserts the shape of this list (`:free` suffix,
 * unique ids) without touching the network; re-verify membership against the
 * live catalog whenever OpenRouter answers "unavailable for free" for an entry.
 */
export const CORTEX_AI_FREE_MODEL_FALLBACK_REGISTRY = [
  // 120B/12B hybrid MoE; tools + structured_outputs; NVIDIA-hosted; 262K ctx.
  'nvidia/nemotron-3-super-120b-a12b:free',
  // 550B/55B; most-used free model (3.77T tokens/week); 1M ctx; tools only.
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  // 975B/41B; 1M ctx; 99.98% uptime; SWE-bench Verified 77.6; tools only.
  'thinkingmachines/inkling:free',
  // Newest (2026-09-08); tools + structured_outputs; 469B tokens/week; size undisclosed.
  'nex-agi/nex-n2.5-pro:free',
  // 118B/8B coding-agent model; 1.26T tokens/week; 99.99% uptime; tools only.
  'poolside/laguna-s-2.1:free',
  // 276B/12B; 1M ctx; 99.99% uptime; tools only.
  'thinkingmachines/inkling-small:free',
  // 124B/5.5B general + vision model (2026-09-10); 329B tokens/week; tools only.
  'inclusionai/ling-3.0-flash-vl:free',
] as const;

export const CORTEX_AI_REQUIRED_MODEL_PARAMETERS = ['tools', 'structured_outputs'] as const;

const CORTEX_AI_OPTIONAL_MODEL_PARAMETER_MAP = {
  frequencyPenalty: 'frequency_penalty',
  logitBias: 'logit_bias',
  presencePenalty: 'presence_penalty',
  seed: 'seed',
  stopSequences: 'stop',
  temperature: 'temperature',
  topK: 'top_k',
  topP: 'top_p',
} as const;

export const CORTEX_AI_MODEL_REGISTRY = {
  defaultFreeRouter: CORTEX_AI_OPENROUTER_FREE_ROUTER_MODEL,
  defaultStructuredOutputModel: CORTEX_AI_FREE_MODEL_FALLBACK_REGISTRY[0],
  defaultToolCallingModel: CORTEX_AI_FREE_MODEL_FALLBACK_REGISTRY[0],
  freeFallbacks: CORTEX_AI_FREE_MODEL_FALLBACK_REGISTRY,
  structuredJsonPreferred: CORTEX_AI_FREE_MODEL_FALLBACK_REGISTRY,
  toolCallingPreferred: CORTEX_AI_FREE_MODEL_FALLBACK_REGISTRY,
} as const;

export type CortexAiOpenRouterModelId =
  | typeof CORTEX_AI_OPENROUTER_FREE_ROUTER_MODEL
  | (typeof CORTEX_AI_FREE_MODEL_FALLBACK_REGISTRY)[number]
  | (string & {});

export type CortexAiRoutingCredentialSource = 'env' | 'manual' | 'stored';

export type CortexAiOpenRouterModelPricing = Record<string, string>;

export type CortexAiCompatibleOpenRouterModel = {
  contextLength: number | null;
  created: number | null;
  expirationDate: string | null;
  id: CortexAiOpenRouterModelId;
  name: string;
  pricing: CortexAiOpenRouterModelPricing;
  supportedParameters: readonly string[];
};

export type CortexAiStoredModelSelection = {
  contextLength: number | null;
  modelId: CortexAiOpenRouterModelId;
  name: string;
  pricing: CortexAiOpenRouterModelPricing;
  supportedParameters: readonly string[];
  updatedAt: string;
};

export type CortexAiRoutingPolicy = {
  credentialSource: CortexAiRoutingCredentialSource;
  ignoredRequestedModelId: CortexAiOpenRouterModelId | null;
  modelIds: readonly CortexAiOpenRouterModelId[];
  modelSelection: CortexAiStoredModelSelection | null;
};

export type CortexAiModelAttempt = {
  errorMessage?: string;
  modelId: CortexAiOpenRouterModelId;
  rateLimited: boolean;
  status: 'success' | 'rate_limited' | 'retried' | 'failed';
};

export class CortexAiRoutingError extends Error {
  readonly attempts: readonly CortexAiModelAttempt[];

  constructor(message: string, attempts: readonly CortexAiModelAttempt[], cause?: unknown) {
    super(message);
    this.name = 'CortexAiRoutingError';
    this.attempts = attempts;
    this.cause = cause;
  }
}

function uniqueModelIds(modelIds: readonly CortexAiOpenRouterModelId[]) {
  return Array.from(new Set(modelIds.filter(Boolean)));
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function readNumberLike(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readStringRecord(value: unknown): CortexAiOpenRouterModelPricing {
  const record = readRecord(value);

  if (!record) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(record)
      .filter(([, entryValue]) => entryValue !== null && entryValue !== undefined)
      .map(([key, entryValue]) => [key, String(entryValue)])
  );
}

function supportsRequiredModelParameters(supportedParameters: readonly string[]) {
  const supported = new Set(supportedParameters);
  return CORTEX_AI_REQUIRED_MODEL_PARAMETERS.every((parameter) => supported.has(parameter));
}

function isTextOutputModel(record: Record<string, unknown>) {
  const architecture = readRecord(record.architecture);
  return readStringArray(architecture?.output_modalities).includes('text');
}

function getExpirationTimestamp(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'number') {
    return value > 10_000_000_000 ? value : value * 1000;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function isExpiredOpenRouterModel(value: unknown, now: Date) {
  const expirationTimestamp = getExpirationTimestamp(value);
  return expirationTimestamp !== null && expirationTimestamp <= now.getTime();
}

function readOpenRouterModelContextLength(record: Record<string, unknown>) {
  const topProvider = readRecord(record.top_provider);
  return (
    readNumberLike(record.context_length) ??
    readNumberLike(record.contextLength) ??
    readNumberLike(topProvider?.context_length) ??
    null
  );
}

function readOpenRouterModelExpirationDate(record: Record<string, unknown>) {
  const expirationDate = record.expiration_date ?? record.expirationDate;
  return typeof expirationDate === 'string' && expirationDate.trim()
    ? expirationDate.trim()
    : null;
}

export function isCortexAiFreeModelId(modelId: CortexAiOpenRouterModelId | null | undefined) {
  return Boolean(
    modelId &&
      (CORTEX_AI_FREE_MODEL_FALLBACK_REGISTRY as readonly string[]).includes(modelId)
  );
}

export function safeParseCortexAiModelSelection(
  value: unknown
): CortexAiStoredModelSelection | null {
  const record = readRecord(value);

  if (!record) {
    return null;
  }

  const modelId = readString(record.modelId);
  const name = readString(record.name);
  const supportedParameters = readStringArray(record.supportedParameters);
  const updatedAt = readString(record.updatedAt);

  if (!modelId || !name || !updatedAt || !supportsRequiredModelParameters(supportedParameters)) {
    return null;
  }

  return {
    contextLength: readNumberLike(record.contextLength),
    modelId,
    name,
    pricing: readStringRecord(record.pricing),
    supportedParameters,
    updatedAt,
  };
}

export function createCortexAiStoredModelSelection(
  model: CortexAiCompatibleOpenRouterModel,
  now = new Date()
): CortexAiStoredModelSelection {
  return {
    contextLength: model.contextLength,
    modelId: model.id,
    name: model.name,
    pricing: model.pricing,
    supportedParameters: [...model.supportedParameters],
    updatedAt: now.toISOString(),
  };
}

export function filterCortexAiCompatibleOpenRouterModels(
  value: unknown,
  now = new Date()
): CortexAiCompatibleOpenRouterModel[] {
  const root = readRecord(value);
  const rawModels = Array.isArray(value)
    ? value
    : Array.isArray(root?.data)
      ? root.data
      : [];

  const compatibleModels: CortexAiCompatibleOpenRouterModel[] = [];

  for (const rawModel of rawModels) {
    const record = readRecord(rawModel);
    const id = readString(record?.id);
    const name = readString(record?.name);
    const supportedParameters = readStringArray(record?.supported_parameters);

    if (
      !record ||
      !id ||
      !name ||
      !isTextOutputModel(record) ||
      isExpiredOpenRouterModel(record.expiration_date, now) ||
      !supportsRequiredModelParameters(supportedParameters)
    ) {
      continue;
    }

    compatibleModels.push({
      contextLength: readOpenRouterModelContextLength(record),
      created: readNumberLike(record.created),
      expirationDate: readOpenRouterModelExpirationDate(record),
      id,
      name,
      pricing: readStringRecord(record.pricing),
      supportedParameters,
    });
  }

  return compatibleModels.sort((left, right) => left.name.localeCompare(right.name));
}

export function buildCortexAiModelFallbackChain(params?: {
  fallbackModelIds?: readonly CortexAiOpenRouterModelId[];
  modelId?: CortexAiOpenRouterModelId | null;
}) {
  return uniqueModelIds([
    params?.modelId || CORTEX_AI_FREE_MODEL_FALLBACK_REGISTRY[0],
    ...(params?.fallbackModelIds || CORTEX_AI_FREE_MODEL_FALLBACK_REGISTRY),
  ]);
}

export function buildCortexAiRoutingPolicy(params: {
  credentialSource: CortexAiRoutingCredentialSource;
  fallbackModelIds?: readonly CortexAiOpenRouterModelId[];
  requestedModelId?: CortexAiOpenRouterModelId | null;
  selectedModel?: CortexAiStoredModelSelection | null;
}): CortexAiRoutingPolicy {
  const requestedModelId = params.requestedModelId?.trim() || null;

  if (params.credentialSource === 'env') {
    return {
      credentialSource: params.credentialSource,
      ignoredRequestedModelId:
        requestedModelId && !isCortexAiFreeModelId(requestedModelId)
          ? requestedModelId
          : null,
      modelIds: [...CORTEX_AI_FREE_MODEL_FALLBACK_REGISTRY],
      modelSelection: null,
    };
  }

  const fallbackModelIds = uniqueModelIds(
    params.fallbackModelIds?.length
      ? params.fallbackModelIds
      : CORTEX_AI_FREE_MODEL_FALLBACK_REGISTRY
  );
  const preferredModelId =
    params.credentialSource === 'stored'
      ? params.selectedModel?.modelId || fallbackModelIds[0]
      : requestedModelId || params.selectedModel?.modelId || fallbackModelIds[0];

  return {
    credentialSource: params.credentialSource,
    ignoredRequestedModelId:
      params.credentialSource === 'stored' &&
      requestedModelId &&
      requestedModelId !== preferredModelId
        ? requestedModelId
        : null,
    modelIds: uniqueModelIds([preferredModelId, ...fallbackModelIds]),
    modelSelection: params.selectedModel || null,
  };
}

export function omitUnsupportedCortexAiModelOptions<TOptions extends Record<string, unknown>>(
  options: TOptions,
  params: {
    modelId: CortexAiOpenRouterModelId;
    modelSelection?: CortexAiStoredModelSelection | null;
  }
): TOptions {
  const modelSelection = params.modelSelection;

  if (!modelSelection || modelSelection.modelId !== params.modelId) {
    return options;
  }

  const supportedParameters = new Set(modelSelection.supportedParameters);
  const unsupportedOptionKeys = Object.entries(CORTEX_AI_OPTIONAL_MODEL_PARAMETER_MAP)
    .filter(([optionKey, parameterName]) => optionKey in options && !supportedParameters.has(parameterName))
    .map(([optionKey]) => optionKey);

  if (unsupportedOptionKeys.length === 0) {
    return options;
  }

  const nextOptions = { ...options };

  for (const optionKey of unsupportedOptionKeys) {
    delete nextOptions[optionKey as keyof TOptions];
  }

  return nextOptions;
}

function readNumericProperty(value: unknown, property: string) {
  if (!value || typeof value !== 'object' || !(property in value)) {
    return null;
  }

  const raw = (value as Record<string, unknown>)[property];
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function getHttpStatusCode(error: unknown): number | null {
  if (APICallError.isInstance(error)) {
    return error.statusCode ?? null;
  }

  const directStatus = readNumericProperty(error, 'statusCode') ?? readNumericProperty(error, 'status');

  if (directStatus) {
    return directStatus;
  }

  if (error && typeof error === 'object' && 'response' in error) {
    const response = (error as { response?: unknown }).response;
    const responseStatus = readNumericProperty(response, 'status');

    if (responseStatus) {
      return responseStatus;
    }
  }

  if (error && typeof error === 'object' && 'cause' in error) {
    return getHttpStatusCode((error as { cause?: unknown }).cause);
  }

  return null;
}

function isHttpStatusCode(value: number | null): value is number {
  return value !== null && Number.isInteger(value) && value >= 100 && value <= 599;
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value.trim().startsWith('{')) {
    return null;
  }

  try {
    return readRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

/**
 * OpenRouter's failure body is `{ "error": { "code": <http status>, "message" } }`.
 * The AI SDK keeps that body on `APICallError.responseBody` (raw string) and
 * `APICallError.data` (parsed), neither of which `getHttpStatusCode` inspects.
 */
function getOpenRouterErrorBodyStatus(error: unknown, depth = 0): number | null {
  const record = readRecord(error);

  if (!record || depth > 8) {
    return null;
  }

  const bodies = [
    record,
    readRecord(record.data),
    parseJsonRecord(record.responseBody),
    parseJsonRecord(record.text),
  ];

  for (const body of bodies) {
    const errorRecord = readRecord(body?.error);
    const code = readNumericProperty(errorRecord, 'code') ?? readNumericProperty(errorRecord, 'status');

    if (isHttpStatusCode(code)) {
      return code;
    }
  }

  return getOpenRouterErrorBodyStatus(record.cause, depth + 1);
}

/**
 * HTTP status of an OpenRouter failure, reading the transport status first
 * (`APICallError.statusCode`, `response.status`, `cause.status`) and the JSON
 * body's `error.code` second. `null` when nothing numeric is present.
 */
export function getOpenRouterErrorStatus(error: unknown): number | null {
  const transportStatus = getHttpStatusCode(error);

  if (isHttpStatusCode(transportStatus)) {
    return transportStatus;
  }

  return getOpenRouterErrorBodyStatus(error);
}

export function isOpenRouterRateLimitError(error: unknown) {
  return getOpenRouterErrorStatus(error) === 429;
}

const DEEP_ERROR_MESSAGE_KEYS = ['message', 'error', 'text', 'responseBody', 'data', 'cause'] as const;

function getDeepErrorMessage(error: unknown, depth = 0): string {
  if (!error || depth > 8) {
    return '';
  }

  if (typeof error !== 'object') {
    return String(error);
  }

  const record = error as Record<string, unknown>;
  const parts = error instanceof Error ? [error.message] : [];

  for (const key of DEEP_ERROR_MESSAGE_KEYS) {
    if (key === 'message' && error instanceof Error) {
      continue;
    }

    parts.push(getDeepErrorMessage(record[key], depth + 1));
  }

  return Array.from(new Set(parts.filter(Boolean))).join('\n');
}

/**
 * Wordings OpenRouter uses when the model itself, not the request, is the
 * problem, so trying the next model in the chain can succeed:
 * - "No endpoints found that can handle the requested parameters"
 * - "Model is no longer available as a free model" / "transitioned to a paid model"
 * - "This model is unavailable for free. The paid version is available now"
 * - "<id> is not a valid model ID"
 */
const OPENROUTER_RECOVERABLE_MESSAGE_PATTERN =
  /No endpoints found|no longer available|not available as a free model|transitioned to a paid model|unavailable for free|paid version is available|is not a valid model ID/i;

const OPENROUTER_NOT_FOUND_MESSAGE_PATTERN = /not found|does not exist|unknown model|no such model/i;

export function isOpenRouterRecoverableRoutingError(error: unknown) {
  const status = getOpenRouterErrorStatus(error);

  if (status === 429 || status === 404) {
    return true;
  }

  const message = getDeepErrorMessage(error);

  if (OPENROUTER_RECOVERABLE_MESSAGE_PATTERN.test(message)) {
    return true;
  }

  return status === 400 && OPENROUTER_NOT_FOUND_MESSAGE_PATTERN.test(message);
}

function truncateErrorMessage(message: string, maxLength = 900) {
  const normalized = message.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1).trimEnd()}...`
    : normalized;
}

function getErrorMessage(error: unknown) {
  const message = getDeepErrorMessage(error);
  return message ? truncateErrorMessage(message) : 'Unknown OpenRouter error.';
}

export function summarizeCortexAiRoutingError(
  error: unknown,
  fallbackMessage = 'Cortex AI request failed.'
) {
  if (error instanceof CortexAiRoutingError) {
    const attemptMessages = error.attempts
      .map((attempt) => attempt.errorMessage)
      .filter((message): message is string => Boolean(message?.trim()));
    const firstAttemptMessage = attemptMessages[0];
    const lastAttemptMessage = attemptMessages[attemptMessages.length - 1];
    const causeMessage = truncateErrorMessage(getDeepErrorMessage(error.cause));

    if (
      firstAttemptMessage &&
      lastAttemptMessage &&
      firstAttemptMessage !== lastAttemptMessage
    ) {
      return `First model error: ${firstAttemptMessage} Last model error: ${lastAttemptMessage}`;
    }

    return lastAttemptMessage || firstAttemptMessage || causeMessage || error.message;
  }

  return truncateErrorMessage(getDeepErrorMessage(error)) || fallbackMessage;
}

export async function runWithCortexAiModelFallback<T>(params: {
  execute: (modelId: CortexAiOpenRouterModelId) => Promise<T>;
  modelIds: readonly CortexAiOpenRouterModelId[];
  shouldRetry?: (error: unknown) => boolean;
}): Promise<{
  attempts: readonly CortexAiModelAttempt[];
  modelId: CortexAiOpenRouterModelId;
  result: T;
}> {
  const modelIds = uniqueModelIds(params.modelIds);
  const shouldRetry = params.shouldRetry || isOpenRouterRecoverableRoutingError;
  let attempts: readonly CortexAiModelAttempt[] = [];
  let lastError: unknown = null;

  for (const modelId of modelIds) {
    try {
      const result = await params.execute(modelId);
      attempts = [
        ...attempts,
        {
          modelId,
          rateLimited: false,
          status: 'success',
        },
      ];

      return {
        attempts,
        modelId,
        result,
      };
    } catch (error) {
      const rateLimited = isOpenRouterRateLimitError(error);
      const retryable = shouldRetry(error);
      lastError = error;
      attempts = [
        ...attempts,
        {
          errorMessage: getErrorMessage(error),
          modelId,
          rateLimited,
          status: rateLimited ? 'rate_limited' : retryable ? 'retried' : 'failed',
        },
      ];

      if (!retryable) {
        throw new CortexAiRoutingError(
          `OpenRouter request failed for model "${modelId}".`,
          attempts,
          error
        );
      }
    }
  }

  throw new CortexAiRoutingError(
    'OpenRouter fallback exhausted all configured Cortex AI models.',
    attempts,
    lastError
  );
}
