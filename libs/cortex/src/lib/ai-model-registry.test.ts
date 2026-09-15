import { APICallError } from 'ai';
import { describe, expect, it } from 'vitest';

import {
  buildCortexAiRoutingPolicy,
  buildCortexAiModelFallbackChain,
  CORTEX_AI_FREE_MODEL_FALLBACK_REGISTRY,
  CORTEX_AI_MODEL_REGISTRY,
  CORTEX_AI_OPENROUTER_FREE_ROUTER_MODEL,
  CortexAiRoutingError,
  filterCortexAiCompatibleOpenRouterModels,
  getOpenRouterErrorStatus,
  isOpenRouterRecoverableRoutingError,
  isOpenRouterRateLimitError,
  omitUnsupportedCortexAiModelOptions,
  runWithCortexAiModelFallback,
  safeParseCortexAiModelSelection,
} from './ai-model-registry';

// Registry members the routing tests lean on. Both are in the fallback list,
// so a stale id fails loudly here instead of only in production.
const PRIMARY_FREE_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';
const SECONDARY_FREE_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free';

function createOpenRouterApiCallError(statusCode: number, message: string) {
  return new APICallError({
    message,
    requestBodyValues: { model: 'qwen/qwen3-next-80b-a3b-instruct:free' },
    responseBody: JSON.stringify({ error: { code: statusCode, message } }),
    statusCode,
    url: 'https://openrouter.ai/api/v1/chat/completions',
  });
}

describe('Cortex AI OpenRouter routing', () => {
  it('keeps the free registry to unique OpenRouter free-tier ids', () => {
    const ids: readonly string[] = CORTEX_AI_FREE_MODEL_FALLBACK_REGISTRY;

    expect(ids.length).toBeGreaterThanOrEqual(5);
    expect(new Set(ids).size).toBe(ids.length);

    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9-]+\/[a-z0-9.-]+:free$/);
    }

    expect(ids).toContain(PRIMARY_FREE_MODEL);
    expect(ids).toContain(SECONDARY_FREE_MODEL);
    expect(CORTEX_AI_MODEL_REGISTRY.defaultStructuredOutputModel).toBe(ids[0]);
    expect(CORTEX_AI_MODEL_REGISTRY.defaultToolCallingModel).toBe(ids[0]);
  });

  it('builds a free-model fallback chain with preferred overrides', () => {
    expect(buildCortexAiModelFallbackChain()).toEqual([
      ...CORTEX_AI_FREE_MODEL_FALLBACK_REGISTRY,
    ]);

    expect(
      buildCortexAiModelFallbackChain({
        modelId: SECONDARY_FREE_MODEL,
      })
    ).toEqual([
      SECONDARY_FREE_MODEL,
      ...CORTEX_AI_FREE_MODEL_FALLBACK_REGISTRY.filter(
        (modelId: string) => modelId !== SECONDARY_FREE_MODEL
      ),
    ]);
  });

  it('detects OpenRouter rate limit errors across common error shapes', () => {
    expect(isOpenRouterRateLimitError({ statusCode: 429 })).toBe(true);
    expect(isOpenRouterRateLimitError({ response: { status: 429 } })).toBe(true);
    expect(isOpenRouterRateLimitError({ cause: { status: 429 } })).toBe(true);
    expect(isOpenRouterRateLimitError({ statusCode: 500 })).toBe(false);
  });

  it('reads the OpenRouter error status from transport and body shapes', () => {
    expect(getOpenRouterErrorStatus(createOpenRouterApiCallError(404, 'Not found'))).toBe(404);
    expect(getOpenRouterErrorStatus({ statusCode: 400 })).toBe(400);
    expect(getOpenRouterErrorStatus({ response: { status: 502 } })).toBe(502);
    expect(getOpenRouterErrorStatus({ cause: { status: 429 } })).toBe(429);
    expect(
      getOpenRouterErrorStatus({
        responseBody: JSON.stringify({ error: { code: 404, message: 'Not found' } }),
      })
    ).toBe(404);
    expect(
      getOpenRouterErrorStatus({
        data: { error: { code: 400, message: 'Bad request' } },
      })
    ).toBe(400);
    expect(getOpenRouterErrorStatus(new Error('No status anywhere'))).toBeNull();
    expect(getOpenRouterErrorStatus(null)).toBeNull();
  });

  it('detects recoverable OpenRouter routing errors for unavailable free models', () => {
    expect(
      isOpenRouterRecoverableRoutingError(
        new Error('No endpoints found that can handle the requested parameters.')
      )
    ).toBe(true);
    expect(
      isOpenRouterRecoverableRoutingError(
        new Error('Model is no longer available as a free model.')
      )
    ).toBe(true);
    expect(isOpenRouterRecoverableRoutingError({ statusCode: 401 })).toBe(false);
    expect(isOpenRouterRecoverableRoutingError({ statusCode: 500 })).toBe(false);
    expect(
      isOpenRouterRecoverableRoutingError(
        createOpenRouterApiCallError(400, 'Invalid JSON in request body.')
      )
    ).toBe(false);
  });

  it('treats a free model that turned paid as recoverable', () => {
    expect(
      isOpenRouterRecoverableRoutingError(
        createOpenRouterApiCallError(
          404,
          'This model is unavailable for free. The paid version is available now - use this slug instead: qwen/qwen3-next-80b-a3b-instruct'
        )
      )
    ).toBe(true);
    expect(
      isOpenRouterRecoverableRoutingError(new Error('This model is unavailable for free.'))
    ).toBe(true);
    expect(
      isOpenRouterRecoverableRoutingError(new Error('The paid version is available now.'))
    ).toBe(true);
    expect(
      isOpenRouterRecoverableRoutingError(
        new Error('Model has transitioned to a paid model.')
      )
    ).toBe(true);
  });

  it('treats an invalid or missing model id as recoverable', () => {
    expect(
      isOpenRouterRecoverableRoutingError(
        createOpenRouterApiCallError(
          400,
          'nvidia/nemotron-nano-9b-v2:free is not a valid model ID'
        )
      )
    ).toBe(true);
    expect(
      isOpenRouterRecoverableRoutingError(new Error('foo/bar is not a valid model ID'))
    ).toBe(true);
    expect(
      isOpenRouterRecoverableRoutingError(createOpenRouterApiCallError(404, 'Model not found'))
    ).toBe(true);
    expect(
      isOpenRouterRecoverableRoutingError(createOpenRouterApiCallError(400, 'Model not found'))
    ).toBe(true);
    expect(isOpenRouterRecoverableRoutingError({ statusCode: 404 })).toBe(true);
    expect(
      isOpenRouterRecoverableRoutingError({
        cause: {
          data: { error: { code: 404, message: 'The requested resource does not exist.' } },
        },
      })
    ).toBe(true);
    // A "not found" wording on an unrelated status is not a routing problem.
    expect(
      isOpenRouterRecoverableRoutingError(createOpenRouterApiCallError(500, 'Tool not found'))
    ).toBe(false);
  });

  it('retries alternate free models after a 429', async () => {
    const tried: string[] = [];
    const result = await runWithCortexAiModelFallback({
      modelIds: [CORTEX_AI_OPENROUTER_FREE_ROUTER_MODEL, PRIMARY_FREE_MODEL],
      execute: async (modelId) => {
        tried.push(modelId);

        if (modelId === CORTEX_AI_OPENROUTER_FREE_ROUTER_MODEL) {
          throw { statusCode: 429 };
        }

        return `ok:${modelId}`;
      },
    });

    expect(tried).toEqual([CORTEX_AI_OPENROUTER_FREE_ROUTER_MODEL, PRIMARY_FREE_MODEL]);
    expect(result.modelId).toBe(PRIMARY_FREE_MODEL);
    expect(result.result).toBe(`ok:${PRIMARY_FREE_MODEL}`);
    expect(result.attempts.map((attempt) => attempt.status)).toEqual([
      'rate_limited',
      'success',
    ]);
  });

  it('falls through to the next model when a free model turned paid', async () => {
    const tried: string[] = [];
    const result = await runWithCortexAiModelFallback({
      modelIds: ['qwen/qwen3-next-80b-a3b-instruct:free', PRIMARY_FREE_MODEL],
      execute: async (modelId) => {
        tried.push(modelId);

        if (modelId === 'qwen/qwen3-next-80b-a3b-instruct:free') {
          throw createOpenRouterApiCallError(
            404,
            'This model is unavailable for free. The paid version is available now - use this slug instead: qwen/qwen3-next-80b-a3b-instruct'
          );
        }

        return `ok:${modelId}`;
      },
    });

    expect(tried).toEqual(['qwen/qwen3-next-80b-a3b-instruct:free', PRIMARY_FREE_MODEL]);
    expect(result.modelId).toBe(PRIMARY_FREE_MODEL);
    expect(result.attempts.map((attempt) => attempt.status)).toEqual(['retried', 'success']);
    expect(result.attempts[0].errorMessage).toContain('unavailable for free');
  });

  it('stops retrying on non-recoverable failures', async () => {
    await expect(
      runWithCortexAiModelFallback({
        modelIds: [CORTEX_AI_OPENROUTER_FREE_ROUTER_MODEL, PRIMARY_FREE_MODEL],
        execute: async () => {
          throw { statusCode: 401 };
        },
      })
    ).rejects.toBeInstanceOf(CortexAiRoutingError);
  });

  it('keeps env-key routing locked to the configured free models', () => {
    const policy = buildCortexAiRoutingPolicy({
      credentialSource: 'env',
      requestedModelId: 'openai/gpt-5.5',
    });

    expect(policy.modelIds).toEqual([...CORTEX_AI_FREE_MODEL_FALLBACK_REGISTRY]);
    expect(policy.ignoredRequestedModelId).toBe('openai/gpt-5.5');
    expect(policy.modelSelection).toBeNull();
  });

  it('uses the stored BYOK model before free fallbacks', () => {
    const policy = buildCortexAiRoutingPolicy({
      credentialSource: 'stored',
      requestedModelId: 'anthropic/claude-sonnet-4.5',
      selectedModel: {
        contextLength: 128000,
        modelId: 'openai/gpt-5.5',
        name: 'OpenAI: GPT-5.5',
        pricing: { completion: '0.00003', prompt: '0.000005' },
        supportedParameters: ['tools', 'structured_outputs'],
        updatedAt: '2026-04-29T12:00:00.000Z',
      },
    });

    expect(policy.modelIds).toEqual([
      'openai/gpt-5.5',
      ...CORTEX_AI_FREE_MODEL_FALLBACK_REGISTRY,
    ]);
    expect(policy.ignoredRequestedModelId).toBe('anthropic/claude-sonnet-4.5');
  });

  it('keeps stored BYOK without a selection on the free registry', () => {
    const policy = buildCortexAiRoutingPolicy({
      credentialSource: 'stored',
      requestedModelId: 'anthropic/claude-sonnet-4.5',
    });

    expect(policy.modelIds).toEqual([...CORTEX_AI_FREE_MODEL_FALLBACK_REGISTRY]);
    expect(policy.ignoredRequestedModelId).toBe('anthropic/claude-sonnet-4.5');
  });

  it('filters OpenRouter catalog models to Cortex AI-compatible text models', () => {
    const filtered = filterCortexAiCompatibleOpenRouterModels(
      {
        data: [
          {
            architecture: { output_modalities: ['text'] },
            context_length: 128000,
            id: 'openai/gpt-5.5',
            name: 'OpenAI: GPT-5.5',
            pricing: { completion: '0.00003', prompt: '0.000005' },
            supported_parameters: ['tools', 'structured_outputs', 'temperature'],
          },
          {
            architecture: { output_modalities: ['image'] },
            id: 'image/model',
            name: 'Image Model',
            supported_parameters: ['tools', 'structured_outputs'],
          },
          {
            architecture: { output_modalities: ['text'] },
            id: 'text/no-tools',
            name: 'No Tools',
            supported_parameters: ['structured_outputs'],
          },
          {
            architecture: { output_modalities: ['text'] },
            expiration_date: '2026-04-01T00:00:00.000Z',
            id: 'expired/model',
            name: 'Expired',
            supported_parameters: ['tools', 'structured_outputs'],
          },
        ],
      },
      new Date('2026-04-29T12:00:00.000Z')
    );

    expect(filtered.map((model) => model.id)).toEqual(['openai/gpt-5.5']);
  });

  it('parses stored model selections defensively', () => {
    expect(
      safeParseCortexAiModelSelection({
        contextLength: 128000,
        modelId: 'openai/gpt-5.5',
        name: 'OpenAI: GPT-5.5',
        pricing: { completion: '0.00003', prompt: '0.000005' },
        supportedParameters: ['tools', 'structured_outputs'],
        updatedAt: '2026-04-29T12:00:00.000Z',
      })
    ).toMatchObject({
      modelId: 'openai/gpt-5.5',
      name: 'OpenAI: GPT-5.5',
    });

    expect(
      safeParseCortexAiModelSelection({
        modelId: 'openai/gpt-5.5',
        name: 'OpenAI: GPT-5.5',
        supportedParameters: ['tools'],
        updatedAt: '2026-04-29T12:00:00.000Z',
      })
    ).toBeNull();
  });

  it('strips unsupported optional parameters for the selected paid model only', () => {
    const options = omitUnsupportedCortexAiModelOptions(
      {
        maxRetries: 0,
        prompt: 'Hi',
        temperature: 0.2,
      },
      {
        modelId: 'openai/gpt-5.5',
        modelSelection: {
          contextLength: 128000,
          modelId: 'openai/gpt-5.5',
          name: 'OpenAI: GPT-5.5',
          pricing: {},
          supportedParameters: ['tools', 'structured_outputs'],
          updatedAt: '2026-04-29T12:00:00.000Z',
        },
      }
    );

    expect(options).toEqual({
      maxRetries: 0,
      prompt: 'Hi',
    });
  });
});
