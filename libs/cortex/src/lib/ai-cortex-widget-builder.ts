import { generateObject } from 'ai';

import {
  buildCortexAiRoutingPolicy,
  createCortexAiOpenRouterClient,
} from './ai-client';
import {
  getHttpStatusCode,
  isOpenRouterRecoverableRoutingError,
  omitUnsupportedCortexAiModelOptions,
  runWithCortexAiModelFallback,
  type CortexAiModelAttempt,
  type CortexAiOpenRouterModelId,
  type CortexAiStoredModelSelection,
} from './ai-model-registry';
import {
  buildCortexWidgetBuilderPrompt,
  buildCortexWidgetBuilderSystemPrompt,
  cortexWidgetBuildRequestSchema,
  validateCortexWidgetDefinitionOutput,
  type CortexWidgetDefinition,
  type CortexWidgetBuildRequest,
} from './cortex-widget-schema';

export type GenerateCortexWidgetDefinitionResult = {
  attempts: readonly CortexAiModelAttempt[];
  credentialSource: 'env' | 'stored' | 'manual';
  definition: CortexWidgetDefinition;
  modelId: CortexAiOpenRouterModelId;
};

const CORTEX_WIDGET_BUILD_ATTEMPT_TIMEOUT_MS = 60_000;

function isRecoverableCortexWidgetBuildError(error: unknown) {
  const statusCode = getHttpStatusCode(error);

  if (statusCode === 401 || statusCode === 402 || statusCode === 403) {
    return false;
  }

  if (isOpenRouterRecoverableRoutingError(error)) {
    return true;
  }

  if (statusCode && statusCode >= 500) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /NoObjectGenerated|No object generated|structured output|schema|validation|Invalid|aborted|abort|timeout|timed out/i.test(
    message
  );
}

export async function generateCortexWidgetDefinition(
  params: CortexWidgetBuildRequest & {
    apiKey?: string;
    fallbackModelIds?: readonly CortexAiOpenRouterModelId[];
    modelId?: CortexAiOpenRouterModelId;
    modelSelection?: CortexAiStoredModelSelection | null;
  }
): Promise<GenerateCortexWidgetDefinitionResult> {
  const { apiKey, fallbackModelIds, modelId, modelSelection, ...requestParams } = params;
  const request = cortexWidgetBuildRequestSchema.parse(requestParams);
  const client = await createCortexAiOpenRouterClient({ apiKey, modelSelection });
  const routingPolicy = buildCortexAiRoutingPolicy({
    credentialSource: client.credentialSource,
    fallbackModelIds,
    requestedModelId: modelId ?? request.modelId,
    selectedModel: client.modelSelection,
  });

  const generation = await runWithCortexAiModelFallback({
    modelIds: routingPolicy.modelIds,
    shouldRetry: isRecoverableCortexWidgetBuildError,
    execute: async (attemptModelId) => {
      const abortController = new AbortController();
      const timeoutId = setTimeout(
        () => abortController.abort(),
        CORTEX_WIDGET_BUILD_ATTEMPT_TIMEOUT_MS
      );

      try {
        const attemptOptions = omitUnsupportedCortexAiModelOptions(
          {
            abortSignal: abortController.signal,
            maxOutputTokens: 7000,
            maxRetries: 0,
            // Use JSON mode WITHOUT a provider-side schema. The widget definition
            // is a recursive, discriminated-union structure; sending it as a
            // response_format json_schema is rejected by Google Gemini
            // ("reference to undefined schema", recursion not supported) and by
            // OpenAI ("'oneOf' is not permitted"). We instead describe the shape
            // in the prompt and validate the returned JSON with our own Zod
            // schema below, which works across every OpenRouter model.
            output: 'no-schema',
            prompt: buildCortexWidgetBuilderPrompt(request),
            instructions: buildCortexWidgetBuilderSystemPrompt(),
            temperature: 0.15,
          } as Record<string, unknown>,
          {
            modelId: attemptModelId,
            modelSelection: routingPolicy.modelSelection,
          }
        );

        const result = await generateObject({
          ...attemptOptions,
          model: client.model(attemptModelId),
        } as Parameters<typeof generateObject>[0]);

        return validateCortexWidgetDefinitionOutput(result.object);
      } finally {
        clearTimeout(timeoutId);
      }
    },
  });

  return {
    attempts: generation.attempts,
    credentialSource: client.credentialSource,
    definition: generation.result,
    modelId: generation.modelId,
  };
}
