import { describe, expect, it } from 'vitest';

import {
  buildCortexAiVisionRoutingPolicy,
  CORTEX_AI_DEFAULT_ALT_TEXT_MAX_LENGTH,
  CORTEX_AI_VISION_MODEL_FALLBACK_REGISTRY,
  isKnownVisionCapableCortexAiModelId,
  normalizeGeneratedAltText,
} from './ai-vision';

describe('normalizeGeneratedAltText', () => {
  it('passes clean alt text through, dropping only the trailing period of a single fragment', () => {
    expect(normalizeGeneratedAltText('A grey cat asleep on a radiator.')).toBe(
      'A grey cat asleep on a radiator'
    );
  });

  it('keeps the final period when the description is more than one sentence', () => {
    expect(
      normalizeGeneratedAltText('A grey cat asleep on a radiator. Sunlight falls across the tiles.')
    ).toBe('A grey cat asleep on a radiator. Sunlight falls across the tiles.');
  });

  it('strips straight and typographic surrounding quotes', () => {
    expect(normalizeGeneratedAltText('"A grey cat asleep on a radiator"')).toBe(
      'A grey cat asleep on a radiator'
    );
    expect(normalizeGeneratedAltText('“A grey cat asleep on a radiator”')).toBe(
      'A grey cat asleep on a radiator'
    );
    expect(normalizeGeneratedAltText("'A grey cat asleep on a radiator'")).toBe(
      'A grey cat asleep on a radiator'
    );
  });

  it('strips an "Alt text:" label, with or without quotes around the answer', () => {
    expect(normalizeGeneratedAltText('Alt text: A grey cat asleep on a radiator')).toBe(
      'A grey cat asleep on a radiator'
    );
    expect(normalizeGeneratedAltText('Alt-text - A grey cat asleep on a radiator')).toBe(
      'A grey cat asleep on a radiator'
    );
    expect(normalizeGeneratedAltText('Alt text: "A grey cat asleep on a radiator"')).toBe(
      'A grey cat asleep on a radiator'
    );
    expect(
      normalizeGeneratedAltText('Here\'s the alt text: "A grey cat asleep on a radiator."')
    ).toBe('A grey cat asleep on a radiator');
  });

  it('strips a redundant "image of" style opener and restores the capital', () => {
    expect(normalizeGeneratedAltText('An image of a red bicycle leaning on a fence')).toBe(
      'A red bicycle leaning on a fence'
    );
    expect(normalizeGeneratedAltText('A picture of a red bicycle leaning on a fence')).toBe(
      'A red bicycle leaning on a fence'
    );
    expect(normalizeGeneratedAltText('Photo showing a red bicycle leaning on a fence')).toBe(
      'A red bicycle leaning on a fence'
    );
    expect(
      normalizeGeneratedAltText('Alt text: "An image of a red bicycle leaning on a fence."')
    ).toBe('A red bicycle leaning on a fence');
  });

  it('keeps an opener that tells the reader what kind of visual this is', () => {
    // "Screenshot of" is not redundant the way "image of" is: it changes how a
    // non-sighted reader interprets everything that follows.
    expect(
      normalizeGeneratedAltText('Screenshot of the pages list with four published rows')
    ).toBe('Screenshot of the pages list with four published rows');
    expect(normalizeGeneratedAltText('Diagram of the checkout flow, from cart to receipt')).toBe(
      'Diagram of the checkout flow, from cart to receipt'
    );
  });

  it('collapses newlines and runs of whitespace into single spaces', () => {
    expect(normalizeGeneratedAltText('  A grey cat\n\nasleep   on a\tradiator  ')).toBe(
      'A grey cat asleep on a radiator'
    );
  });

  it('truncates on a word boundary at the supplied maximum length', () => {
    const result = normalizeGeneratedAltText(
      'A large tabby cat asleep on a warm radiator beneath a bright window',
      40
    );

    expect(result).toBe('A large tabby cat asleep on a warm');
    expect(result.length).toBeLessThanOrEqual(40);
  });

  it('truncates at 125 characters by default', () => {
    const verbose = [
      'A large tabby cat asleep on a warm cast-iron radiator beneath a bright',
      'sash window, with a folded tartan blanket and two potted ferns beside it',
    ].join(' ');

    const result = normalizeGeneratedAltText(verbose);

    expect(verbose.length).toBeGreaterThan(CORTEX_AI_DEFAULT_ALT_TEXT_MAX_LENGTH);
    expect(result.length).toBeLessThanOrEqual(CORTEX_AI_DEFAULT_ALT_TEXT_MAX_LENGTH);
    expect(result).not.toMatch(/[\s,;:-]$/);
    expect(verbose.startsWith(result)).toBe(true);
  });

  it('returns an empty string for a response that was nothing but a preamble', () => {
    expect(normalizeGeneratedAltText('   ')).toBe('');
    expect(normalizeGeneratedAltText('Alt text:')).toBe('');
    expect(normalizeGeneratedAltText('""')).toBe('');
  });
});

describe('isKnownVisionCapableCortexAiModelId', () => {
  it('accepts every model in the vision fallback registry', () => {
    for (const modelId of CORTEX_AI_VISION_MODEL_FALLBACK_REGISTRY) {
      expect(isKnownVisionCapableCortexAiModelId(modelId), modelId).toBe(true);
    }
  });

  it('accepts model families that are multimodal throughout', () => {
    expect(isKnownVisionCapableCortexAiModelId('qwen/qwen3-vl-235b-a22b-instruct')).toBe(true);
    expect(isKnownVisionCapableCortexAiModelId('meta-llama/llama-3.2-11b-vision-instruct')).toBe(
      true
    );
    expect(isKnownVisionCapableCortexAiModelId('anthropic/claude-haiku-4.5')).toBe(true);
    expect(isKnownVisionCapableCortexAiModelId('mistralai/pixtral-large-2411')).toBe(true);
  });

  it('rejects the text-only models used by the general fallback registry', () => {
    expect(isKnownVisionCapableCortexAiModelId('nvidia/nemotron-3-super-120b-a12b:free')).toBe(
      false
    );
    expect(isKnownVisionCapableCortexAiModelId('nvidia/nemotron-3-ultra-550b-a55b:free')).toBe(false);
    expect(isKnownVisionCapableCortexAiModelId('openrouter/free')).toBe(false);
    expect(isKnownVisionCapableCortexAiModelId('')).toBe(false);
    expect(isKnownVisionCapableCortexAiModelId(null)).toBe(false);
  });
});

describe('buildCortexAiVisionRoutingPolicy', () => {
  it('falls back to the vision registry when nothing is requested or selected', () => {
    expect(buildCortexAiVisionRoutingPolicy({ credentialSource: 'env' }).modelIds).toEqual([
      ...CORTEX_AI_VISION_MODEL_FALLBACK_REGISTRY,
    ]);
  });

  it('honours a requested vision model even on an env credential', () => {
    // This is the whole reason the vision policy exists: buildCortexAiRoutingPolicy
    // would discard this id and route to its text-only registry instead.
    const { modelIds } = buildCortexAiVisionRoutingPolicy({
      credentialSource: 'env',
      requestedModelId: 'anthropic/claude-haiku-4.5',
    });

    expect(modelIds[0]).toBe('anthropic/claude-haiku-4.5');
    expect(modelIds.slice(1)).toEqual([...CORTEX_AI_VISION_MODEL_FALLBACK_REGISTRY]);
  });

  it('de-duplicates a requested model that is already in the registry, keeping it at the head', () => {
    const { modelIds } = buildCortexAiVisionRoutingPolicy({
      credentialSource: 'manual',
      requestedModelId: '  openai/gpt-4o-mini  ',
    });

    expect(modelIds[0]).toBe('openai/gpt-4o-mini');
    expect(modelIds).toHaveLength(CORTEX_AI_VISION_MODEL_FALLBACK_REGISTRY.length);
    expect(new Set(modelIds).size).toBe(modelIds.length);

    for (const modelId of CORTEX_AI_VISION_MODEL_FALLBACK_REGISTRY) {
      expect(modelIds, modelId).toContain(modelId);
    }
  });

  it('uses the stored selection only when it is recognisably vision-capable', () => {
    expect(
      buildCortexAiVisionRoutingPolicy({
        credentialSource: 'stored',
        selectedModel: { modelId: 'google/gemini-3.1-flash' },
      }).modelIds[0]
    ).toBe('google/gemini-3.1-flash');

    expect(
      buildCortexAiVisionRoutingPolicy({
        credentialSource: 'stored',
        selectedModel: { modelId: 'nvidia/nemotron-3-super-120b-a12b:free' },
      }).modelIds
    ).toEqual([...CORTEX_AI_VISION_MODEL_FALLBACK_REGISTRY]);
  });

  it('ignores the stored selection on an env credential, as the text policy does', () => {
    expect(
      buildCortexAiVisionRoutingPolicy({
        credentialSource: 'env',
        selectedModel: { modelId: 'google/gemini-3.1-flash' },
      }).modelIds
    ).toEqual([...CORTEX_AI_VISION_MODEL_FALLBACK_REGISTRY]);
  });

  it('orders a requested model ahead of the stored selection, then the registry tail', () => {
    const { modelIds } = buildCortexAiVisionRoutingPolicy({
      credentialSource: 'stored',
      requestedModelId: 'anthropic/claude-haiku-4.5',
      selectedModel: { modelId: 'google/gemini-3.1-flash' },
    });

    expect(modelIds).toEqual([
      'anthropic/claude-haiku-4.5',
      'google/gemini-3.1-flash',
      ...CORTEX_AI_VISION_MODEL_FALLBACK_REGISTRY,
    ]);
  });

  it('treats a blank requested model id as no request at all', () => {
    expect(
      buildCortexAiVisionRoutingPolicy({
        credentialSource: 'manual',
        requestedModelId: '   ',
      }).modelIds
    ).toEqual([...CORTEX_AI_VISION_MODEL_FALLBACK_REGISTRY]);
  });
});
