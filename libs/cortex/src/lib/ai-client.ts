import 'server-only';

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, type LanguageModel } from 'ai';

import {
  CORTEX_AI_OPENROUTER_MODEL_SELECTION_SETTING_KEY,
  CORTEX_AI_OPENROUTER_SETTING_KEY,
  CORTEX_AI_PACKAGE_NAME,
  decryptStoredOpenRouterApiKey,
  getOpenRouterEnvApiKey,
} from './ai-config';
import {
  buildCortexAiRoutingPolicy,
  CORTEX_AI_OPENROUTER_BASE_URL,
  omitUnsupportedCortexAiModelOptions,
  safeParseCortexAiModelSelection,
  type CortexAiModelAttempt,
  type CortexAiOpenRouterModelId,
  type CortexAiStoredModelSelection,
  runWithCortexAiModelFallback,
} from './ai-model-registry';

type AiGenerateTextOptions = Omit<Parameters<typeof generateText>[0], 'model'>;
type AiGenerateTextResult = Awaited<ReturnType<typeof generateText>>;
type FetchFunction = typeof globalThis.fetch;

const SERVER_ONLY_ERROR_MESSAGE =
  'Cortex AI OpenRouter client can only be imported from server-side code.';

function assertServerOnly() {
  if (typeof window === 'undefined') {
    return;
  }

  throw new Error(SERVER_ONLY_ERROR_MESSAGE);
}

export type CortexAiOpenRouterCredentialSource = 'env' | 'stored' | 'manual' | 'none';

export type CortexAiOpenRouterCredential = {
  apiKey: string | null;
  source: CortexAiOpenRouterCredentialSource;
};

export type CortexAiOpenRouterClient = {
  credentialSource: Exclude<CortexAiOpenRouterCredentialSource, 'none'>;
  model: (modelId?: CortexAiOpenRouterModelId) => LanguageModel;
  modelSelection: CortexAiStoredModelSelection | null;
};

export type CortexAiGenerateTextOptions = AiGenerateTextOptions & {
  apiKey?: string;
  fallbackModelIds?: readonly CortexAiOpenRouterModelId[];
  modelId?: CortexAiOpenRouterModelId;
};

export type CortexAiGenerateTextResult = {
  attempts: readonly CortexAiModelAttempt[];
  credentialSource: Exclude<CortexAiOpenRouterCredentialSource, 'none'>;
  modelId: CortexAiOpenRouterModelId;
  result: AiGenerateTextResult;
};

function buildOpenRouterHeaders() {
  assertServerOnly();
  const referer = process.env.NEXT_PUBLIC_URL?.trim() || 'https://nextblock.dev';

  return {
    'HTTP-Referer': referer,
    'X-Title': CORTEX_AI_PACKAGE_NAME,
  };
}

export function createCortexAiOpenRouterProvider(params: {
  apiKey: string;
  fetch?: FetchFunction;
}) {
  assertServerOnly();
  return createOpenAICompatible<string, string, string, string>({
    apiKey: params.apiKey,
    baseURL: CORTEX_AI_OPENROUTER_BASE_URL,
    fetch: params.fetch,
    headers: buildOpenRouterHeaders(),
    includeUsage: true,
    name: 'openrouter',
    supportsStructuredOutputs: true,
  });
}

async function readStoredOpenRouterApiKey() {
  assertServerOnly();
  const { getServiceRoleSupabaseClient } = await import('@nextblock-cms/db/server');
  const supabase = getServiceRoleSupabaseClient();
  const { data, error } = await supabase
    .from('site_settings')
    .select('value')
    .eq('key', CORTEX_AI_OPENROUTER_SETTING_KEY)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load stored Cortex AI OpenRouter key: ${error.message}`);
  }

  if (!data?.value) {
    return null;
  }

  return decryptStoredOpenRouterApiKey(data.value);
}

export async function getStoredCortexAiModelSelection(): Promise<CortexAiStoredModelSelection | null> {
  assertServerOnly();
  const { getServiceRoleSupabaseClient } = await import('@nextblock-cms/db/server');
  const supabase = getServiceRoleSupabaseClient();
  const { data, error } = await supabase
    .from('site_settings')
    .select('value')
    .eq('key', CORTEX_AI_OPENROUTER_MODEL_SELECTION_SETTING_KEY)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load Cortex AI OpenRouter model selection: ${error.message}`);
  }

  return safeParseCortexAiModelSelection(data?.value);
}

export async function resolveCortexAiOpenRouterCredential(params?: {
  apiKey?: string;
}): Promise<CortexAiOpenRouterCredential> {
  assertServerOnly();
  const manualApiKey = params?.apiKey?.trim();

  if (manualApiKey) {
    return {
      apiKey: manualApiKey,
      source: 'manual',
    };
  }

  const storedApiKey = await readStoredOpenRouterApiKey();

  if (storedApiKey) {
    return {
      apiKey: storedApiKey,
      source: 'stored',
    };
  }

  const envApiKey = getOpenRouterEnvApiKey();

  if (envApiKey) {
    return {
      apiKey: envApiKey,
      source: 'env',
    };
  }

  return {
    apiKey: null,
    source: 'none',
  };
}

export async function createCortexAiOpenRouterClient(params?: {
  apiKey?: string;
  fetch?: FetchFunction;
  modelSelection?: CortexAiStoredModelSelection | null;
}) {
  assertServerOnly();
  const credential = await resolveCortexAiOpenRouterCredential({
    apiKey: params?.apiKey,
  });

  if (!credential.apiKey || credential.source === 'none') {
    throw new Error(
      'Cortex AI requires OPENROUTER_API_KEY or an encrypted OpenRouter BYOK in site settings.'
    );
  }

  const provider = createCortexAiOpenRouterProvider({
    apiKey: credential.apiKey,
    fetch: params?.fetch,
  });
  const modelSelection =
    params?.modelSelection !== undefined
      ? params.modelSelection
      : credential.source === 'stored'
        ? await getStoredCortexAiModelSelection()
        : null;

  return {
    credentialSource: credential.source,
    model: (modelId?: CortexAiOpenRouterModelId) => provider.chatModel(modelId || 'openrouter/free'),
    modelSelection,
  };
}

export async function generateCortexAiText({
  apiKey,
  fallbackModelIds,
  modelId,
  ...options
}: CortexAiGenerateTextOptions & { modelSelection?: CortexAiStoredModelSelection | null }): Promise<CortexAiGenerateTextResult> {
  assertServerOnly();
  const client = await createCortexAiOpenRouterClient({ apiKey, modelSelection: options.modelSelection });
  const routingPolicy = buildCortexAiRoutingPolicy({
    credentialSource: client.credentialSource,
    fallbackModelIds,
    requestedModelId: modelId,
    selectedModel: client.modelSelection,
  });

  const generation = await runWithCortexAiModelFallback({
    modelIds: routingPolicy.modelIds,
    execute: (attemptModelId) => {
      const attemptOptions = omitUnsupportedCortexAiModelOptions(
        {
          ...options,
          maxRetries: 0,
        } as Record<string, unknown>,
        {
          modelId: attemptModelId,
          modelSelection: routingPolicy.modelSelection,
        }
      );

      return generateText({
        ...attemptOptions,
        model: client.model(attemptModelId),
      } as Parameters<typeof generateText>[0]);
    },
  });

  return {
    attempts: generation.attempts,
    credentialSource: client.credentialSource,
    modelId: generation.modelId,
    result: generation.result,
  };
}

export {
  buildCortexAiModelFallbackChain,
  buildCortexAiRoutingPolicy,
  CORTEX_AI_FREE_MODEL_FALLBACK_REGISTRY,
  CORTEX_AI_MODEL_REGISTRY,
  CORTEX_AI_OPENROUTER_BASE_URL,
  CORTEX_AI_OPENROUTER_FREE_ROUTER_MODEL,
  CORTEX_AI_REQUIRED_MODEL_PARAMETERS,
  CortexAiRoutingError,
  isOpenRouterRecoverableRoutingError,
  isOpenRouterRateLimitError,
  omitUnsupportedCortexAiModelOptions,
  runWithCortexAiModelFallback,
  summarizeCortexAiRoutingError,
} from './ai-model-registry';
export {
  listCortexAiCompatibleOpenRouterModels,
} from './ai-model-catalog';
