import { generateText, type ModelMessage } from 'ai';

import {
  getHttpStatusCode,
  isOpenRouterRecoverableRoutingError,
  omitUnsupportedCortexAiModelOptions,
  runWithCortexAiModelFallback,
  type CortexAiOpenRouterModelId,
} from './ai-model-registry';
import { truncateOnWordBoundary } from './ai-seo-metadata';

const SERVER_ONLY_ERROR_MESSAGE =
  'Cortex AI vision generation can only be imported from server-side code.';

function assertServerOnly() {
  if (typeof window === 'undefined') {
    return;
  }

  throw new Error(SERVER_ONLY_ERROR_MESSAGE);
}

/**
 * Ordered list of OpenRouter model ids that genuinely accept image input.
 *
 * This list exists precisely BECAUSE the general-purpose fallback registry cannot
 * be reused here. `CORTEX_AI_FREE_MODEL_FALLBACK_REGISTRY` in ai-model-registry.ts
 * is a text-only tier, and `buildCortexAiRoutingPolicy` actively DISCARDS a
 * requested model id whenever the credential came from the shared environment key
 * — it records the request in `ignoredRequestedModelId` and routes to that
 * text-only tier anyway. That is the right behaviour for text (it stops a caller
 * spending the house key on an expensive model) but it is fatal for vision: the
 * call would be dispatched to a model that cannot see the image, and the model
 * would either error on the unsupported content part or, worse, hallucinate a
 * description of an image it never received. Hence a separate registry and a
 * separate policy below.
 *
 * The order is: free tier first so an install with no billing set up still gets
 * working alt text, then paid models in ascending cost, ending with the most
 * capable one for images the cheaper models fumble.
 *
 * - `google/gemma-4-31b-it:free` — the strongest general-purpose free multimodal
 *   instruct model on OpenRouter; text output, 262k context, no expiry date set.
 * - `google/gemma-4-26b-a4b-it:free` — its sparse sibling. A second free entry
 *   matters more than a marginally better one, because the free tier is rate
 *   limited per model and the first choice is the one everybody else hits too.
 * - `google/gemini-2.5-flash-lite` — the cheapest reliable paid vision endpoint,
 *   and the first entry that is not subject to free-tier throttling.
 * - `qwen/qwen3-vl-32b-instruct` — a dedicated vision-language model; a useful
 *   second opinion because it fails on a different set of images than Gemini does.
 * - `openai/gpt-4o-mini` — the most battle-tested vision endpoint available here,
 *   and the id least likely to be retired without warning.
 * - `google/gemini-2.5-flash` — the quality backstop for dense screenshots,
 *   diagrams, and photographs with small but load-bearing detail.
 *
 * This list MUST be revisited as OpenRouter's catalog changes. Free-tier ids in
 * particular churn constantly: they are added, throttled, given an
 * `expiration_date`, or silently promoted to paid, at which point a request to them
 * fails with a message `isOpenRouterRecoverableRoutingError` recognises and the
 * chain simply falls through to the next entry. That fallback keeps the feature
 * working, but a registry whose whole free head has expired means every alt-text
 * generation quietly starts costing money — so treat a persistently paid-only
 * outcome as a signal to refresh this list against
 * `https://openrouter.ai/api/v1/models`, filtering on
 * `architecture.input_modalities` containing `image`.
 */
export const CORTEX_AI_VISION_MODEL_FALLBACK_REGISTRY: readonly string[] = [
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
  'google/gemini-2.5-flash-lite',
  'qwen/qwen3-vl-32b-instruct',
  'openai/gpt-4o-mini',
  'google/gemini-2.5-flash',
];

/**
 * Conservative shape tests for model ids we are willing to believe accept images
 * even though they are not in the registry above.
 *
 * The admin's stored model selection is just an id plus its OpenRouter
 * `supported_parameters` (see `CortexAiStoredModelSelection`); OpenRouter reports
 * input modalities under `architecture`, which the stored selection does not
 * capture, so at routing time we cannot look the answer up. Guessing from the id is
 * the only option, and guessing wrong in the permissive direction is expensive —
 * it means dispatching an image to a text-only model. So these patterns cover only
 * families that are multimodal across every member, and anything unrecognised
 * simply falls through to the registry rather than being tried.
 */
const CORTEX_AI_VISION_CAPABLE_MODEL_ID_PATTERNS: readonly RegExp[] = [
  // Dedicated vision-language builds: "qwen3-vl-32b-instruct", "internvl3-78b".
  /(?:^|\/)[^/]*-vl(?:[-:]|$)/i,
  // Explicitly named vision variants: "llama-3.2-11b-vision-instruct".
  /vision/i,
  // Whole families that are multimodal end to end.
  /(?:^|\/)gemini-/i,
  /(?:^|\/)gemma-[3-9]/i,
  /(?:^|\/)gpt-(?:4o|4\.1|5)/i,
  /(?:^|\/)claude-/i,
  /(?:^|\/)llama-4/i,
  /(?:^|\/)pixtral/i,
  /(?:^|\/)mistral-(?:small|medium|large)-3/i,
  /(?:^|\/)nova-(?:lite|pro|premier)/i,
];

/**
 * Default alt-text budget. 125 characters is the long-standing practical ceiling:
 * older screen readers truncated an `alt` attribute around 125-150 characters, and
 * anything longer is a sign the image is really conveying content that belongs in a
 * caption or a long description instead.
 */
export const CORTEX_AI_DEFAULT_ALT_TEXT_MAX_LENGTH = 125;

/**
 * Bounds on a caller-supplied `maxLength`. Below roughly twenty characters there is
 * no room to describe anything, and above a thousand the value is no longer alt
 * text; clamping instead of throwing keeps a bad call site from breaking an upload.
 */
const CORTEX_AI_ALT_TEXT_MAX_LENGTH_BOUNDS = { max: 1000, min: 20 } as const;

const CORTEX_AI_VISION_ATTEMPT_TIMEOUT_MS = 60_000;

/**
 * Quote characters a model might wrap a one-line answer in. Both the straight and
 * the typographic pairs appear in practice, and models localised to French or
 * German reach for guillemets and low-9 quotes.
 */
const CORTEX_AI_ALT_TEXT_QUOTE_CHARACTERS = new Set([
  '"',
  "'",
  '«', // «
  '»', // »
  '‘', // ‘
  '’', // ’
  '‚', // ‚
  '“', // “
  '”', // ”
  '„', // „
  '`',
]);

/**
 * A leading label the model added to announce its own answer, e.g.
 * `Alt text: A grey cat asleep on a radiator` or `Here's the alt-text — ...`.
 */
const CORTEX_AI_ALT_TEXT_LABEL_PATTERN =
  /^(?:here(?:'s|’s| is)\s+)?(?:the\s+)?alt(?:[-\s]?text)?\s*[:–—-]\s*/i;

/**
 * A redundant opener that wastes the reader's attention. A screen reader already
 * announces the element as an image, so "Image of a red bicycle" is heard as
 * "image, image of a red bicycle".
 *
 * Note what is deliberately NOT in this pattern: "screenshot of", "diagram of",
 * "chart of", "map of", "portrait of". Those are not redundant — they tell a
 * non-sighted reader what KIND of visual this is, which changes how they interpret
 * the rest of the description, so stripping them would remove real information.
 */
const CORTEX_AI_ALT_TEXT_REDUNDANT_OPENER_PATTERN =
  /^(?:this\s+is\s+)?(?:an?|the)?\s*(?:image|photo|photograph|picture|pic|graphic|illustration|rendering|render)\s+(?:of|showing|depicting|that\s+shows)\s+/i;

function uniqueVisionModelIds(modelIds: readonly (string | null | undefined)[]) {
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const modelId of modelIds) {
    const normalized = modelId?.trim();

    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    ordered.push(normalized);
  }

  return ordered;
}

/**
 * Whether we are prepared to send an image to this model id. Registry membership is
 * the certain case; the patterns above cover an admin-selected model from a family
 * we know to be multimodal throughout.
 */
export function isKnownVisionCapableCortexAiModelId(modelId: string | null | undefined): boolean {
  const normalized = modelId?.trim();

  if (!normalized) {
    return false;
  }

  if (CORTEX_AI_VISION_MODEL_FALLBACK_REGISTRY.includes(normalized)) {
    return true;
  }

  return CORTEX_AI_VISION_CAPABLE_MODEL_ID_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Build the model chain for a vision call.
 *
 * Three rules, each of which differs from the text policy for a reason:
 *
 * 1. An explicitly requested model is HONOURED regardless of `credentialSource`.
 *    The text policy drops a requested id on an `env` credential so a caller cannot
 *    spend the shared house key on a model the operator did not choose. Applying
 *    that rule here would silently route an image to a text-only model, which is a
 *    correctness failure rather than a cost control. A caller that names a vision
 *    model is making a deliberate choice, and the cost ceiling is already bounded
 *    by the tiny output budget an alt-text call uses.
 *
 * 2. The admin's stored selection participates only when it is `credentialSource`
 *    'stored' or 'manual' — i.e. the operator's own key, exactly as the text policy
 *    treats it — AND the id is recognisably vision-capable. An operator who picked,
 *    say, a text-only reasoning model for the page builder should not have that
 *    choice quietly break every alt-text generation.
 *
 * 3. The vision registry is always appended as a tail, never conditionally. It is
 *    the safety net: whatever the first two rules produce, there is always a known
 *    multimodal model behind it.
 *
 * De-duplication preserves first-occurrence order, so a requested model that also
 * appears in the registry stays at the head instead of being tried twice.
 */
export function buildCortexAiVisionRoutingPolicy(params: {
  credentialSource: string;
  requestedModelId?: string | null;
  selectedModel?: { modelId: string } | null;
}): { modelIds: string[] } {
  const requestedModelId = params.requestedModelId?.trim() || null;
  const storedModelId = params.selectedModel?.modelId?.trim() || null;
  const usableStoredModelId =
    params.credentialSource !== 'env' &&
    storedModelId &&
    isKnownVisionCapableCortexAiModelId(storedModelId)
      ? storedModelId
      : null;

  return {
    modelIds: uniqueVisionModelIds([
      requestedModelId,
      usableStoredModelId,
      ...CORTEX_AI_VISION_MODEL_FALLBACK_REGISTRY,
    ]),
  };
}

function stripSurroundingQuotes(value: string) {
  let result = value.trim();

  // Loop, because a model that both labels and quotes its answer can nest them, and
  // because a stray smart quote outside a straight-quoted string is not unusual.
  while (
    result.length >= 2 &&
    CORTEX_AI_ALT_TEXT_QUOTE_CHARACTERS.has(result[0]) &&
    CORTEX_AI_ALT_TEXT_QUOTE_CHARACTERS.has(result[result.length - 1])
  ) {
    result = result.slice(1, -1).trim();
  }

  return result;
}

/**
 * Drop a trailing period, but only when the alt text is a single fragment.
 *
 * The reason for the condition is how screen readers pause. A period at the end of
 * a one-phrase description produces a pause with nothing after it, which reads as a
 * stumble; but when the description is genuinely two or more sentences, removing
 * the final period makes the last sentence run into whatever the reader announces
 * next. Counting sentence terminators that are followed by whitespace or the end of
 * the string distinguishes the two cases, and is deliberately conservative: an
 * abbreviation such as "Dr. Chen at a lectern." counts as two terminators and so
 * keeps its period, which is a harmless outcome.
 */
function dropTrailingPeriodFromSingleFragment(value: string) {
  if (!value.endsWith('.') || value.endsWith('...') || value.endsWith('…')) {
    return value;
  }

  const terminatorCount = (value.match(/[.!?](?=\s|$)/g) || []).length;

  return terminatorCount === 1 ? value.slice(0, -1).trimEnd() : value;
}

/**
 * Turn whatever the model said into an `alt` attribute value.
 *
 * Exported as a named function so the whole post-processing contract can be unit
 * tested without a network call — this is the part of the vision path most likely
 * to regress, because every change here is a response to some specific model's
 * verbal tic and it is easy to break an earlier fix while adding the next one.
 *
 * The steps run in this order for a reason: whitespace is collapsed first so a
 * multi-line answer is matched by the single-line label patterns; quote stripping
 * and preamble stripping then alternate, because `Alt text: "A grey cat."` needs
 * both and either order alone leaves one of them behind.
 */
export function normalizeGeneratedAltText(
  raw: string,
  maxLength: number = CORTEX_AI_DEFAULT_ALT_TEXT_MAX_LENGTH
): string {
  let value = raw.replace(/\s+/g, ' ').trim();
  let strippedPreamble = false;

  // Two passes is enough for every combination we have seen: label around quotes,
  // quotes around label, or a redundant opener inside a quoted, labelled answer.
  for (let pass = 0; pass < 2; pass++) {
    value = stripSurroundingQuotes(value);

    const withoutLabel = value.replace(CORTEX_AI_ALT_TEXT_LABEL_PATTERN, '');

    if (withoutLabel !== value) {
      value = withoutLabel.trim();
      strippedPreamble = true;
    }

    value = stripSurroundingQuotes(value);

    const withoutOpener = value.replace(CORTEX_AI_ALT_TEXT_REDUNDANT_OPENER_PATTERN, '');

    if (withoutOpener !== value) {
      value = withoutOpener.trim();
      strippedPreamble = true;
    }
  }

  // Removing "An image of " leaves the sentence starting mid-phrase in lower case,
  // so restore the capital. Only do this when something was actually removed — a
  // model that deliberately opened with a lower-case brand name ("iPhone 15 held in
  // one hand") should keep it.
  if (strippedPreamble && value) {
    value = value.charAt(0).toUpperCase() + value.slice(1);
  }

  return truncateOnWordBoundary(dropTrailingPeriodFromSingleFragment(value), maxLength);
}

export interface GenerateAltTextParams {
  abortSignal?: AbortSignal;
  apiKey?: string | null;
  context?: string | null;
  imageUrl: string;
  maxLength?: number;
  modelId?: string | null;
}

export interface GenerateAltTextResult {
  altText: string;
  attempts: number;
  credentialSource: string;
  modelId: string;
}

/**
 * Reject anything that is not an absolute http(s) URL.
 *
 * This is a real failure mode in this repository rather than defensive noise. Media
 * rows store an R2/S3 object key, and several call sites hold a value like
 * `/uploads/hero.jpg` or `hero.jpg` that only becomes fetchable once the media base
 * URL is prepended. Because `createOpenAICompatible` is configured without
 * `supportedUrls`, the AI SDK does not pass a URL through to the provider — it
 * DOWNLOADS the image server-side and inlines it as base64. A relative value would
 * therefore fail deep inside the SDK's fetch with an error that says nothing about
 * the real mistake, and it would fail once per model in the fallback chain before
 * surfacing. Failing here, before any network call, names the actual problem.
 */
function toAbsoluteImageUrl(imageUrl: string) {
  const trimmed = imageUrl.trim();

  if (!trimmed) {
    throw new Error('Cortex AI alt text generation requires an image URL.');
  }

  let parsed: URL;

  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      `Cortex AI alt text generation requires an absolute http(s) image URL, received "${trimmed}". A storage key or site-relative path must be resolved to a publicly fetchable URL first, because the model provider downloads the image server-side.`
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Cortex AI alt text generation requires an http(s) image URL, received the "${parsed.protocol}" scheme.`
    );
  }

  return parsed;
}

function buildAltTextSystemPrompt(maxLength: number) {
  return [
    'You are NextBlock Cortex AI, writing the alt attribute for an image on a website.',
    'You are writing for a person using a screen reader who cannot see the image at all.',
    'Describe only what is visibly present in the image: subjects, their appearance, what they are doing, the setting, and any text that appears in the image.',
    'Never state or guess anything you cannot see — no names, no locations, no dates, no brands, no emotions, and no backstory unless they are legible in the image itself.',
    `Write one short factual description of at most ${maxLength} characters.`,
    'Do not begin with "image of", "photo of", "picture of", "graphic of", or any similar phrase; the screen reader already announces that this is an image.',
    'Do not add a label such as "Alt text:" and do not wrap the description in quotation marks.',
    'Do not keyword-stuff, do not list search terms, and do not repeat a word for emphasis.',
    'Return plain text only: one line, no markdown, no HTML, no JSON, no commentary, no alternatives to choose between.',
    'If surrounding page context is supplied, use it ONLY to disambiguate what you can already see — for example to choose the right word for an object or to know which product is pictured. Never use it to add detail that is not visible in the image.',
  ].join(' ');
}

function buildAltTextInstruction(params: { context: string | null; maxLength: number }) {
  return [
    `Write the alt attribute for this image, at most ${params.maxLength} characters.`,
    params.context
      ? `Surrounding page context, for disambiguation only: ${params.context}`
      : null,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Shape and transport failures are retryable on the next model; credential failures
 * are not. The extra clauses beyond the shared helpers cover the two ways a
 * text-only model reacts to an image part — an explicit modality complaint, or a
 * 400 from the provider — and our own empty-output rejection.
 */
function isRecoverableAltTextError(error: unknown) {
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
  return /NoContentGenerated|No content generated|Provider returned error|empty alt text|image|modality|multimodal|not support|unsupported|aborted|abort|timeout|timed out/i.test(
    message
  );
}

/**
 * Generate an `alt` attribute for an image by actually looking at it.
 *
 * The image is downloaded once by `downloadCortexVisionImage` (DNS-pinned, private
 * addresses refused, capped at CORTEX_AI_VISION_MAX_IMAGE_BYTES) and attached as an AI SDK
 * file part with its bytes inside a user message. Two consequences are worth knowing at the
 * call site: the URL must be publicly fetchable from the server, and a very large source
 * image inflates the request body on every attempt in the fallback chain, because the
 * provider receives it inline as base64. Passing a resized or CDN-transformed URL is
 * therefore materially cheaper than passing the original upload.
 */
export async function generateCortexAiAltText(
  params: GenerateAltTextParams
): Promise<GenerateAltTextResult> {
  assertServerOnly();

  const imageUrl = toAbsoluteImageUrl(params.imageUrl);
  const requestedMaxLength = Number.isFinite(params.maxLength)
    ? Math.round(params.maxLength as number)
    : CORTEX_AI_DEFAULT_ALT_TEXT_MAX_LENGTH;
  const maxLength = Math.min(
    CORTEX_AI_ALT_TEXT_MAX_LENGTH_BOUNDS.max,
    Math.max(CORTEX_AI_ALT_TEXT_MAX_LENGTH_BOUNDS.min, requestedMaxLength)
  );
  const context = params.context?.replace(/\s+/g, ' ').trim() || null;

  // Lazily imported for the reason recorded in ai-seo-metadata.ts: keeping the
  // credential and Supabase graph out of module scope means the routing policy and
  // the alt-text post-processor above stay importable — and unit testable — on
  // their own.
  const { createCortexAiOpenRouterClient } = await import('./ai-client');
  const client = await createCortexAiOpenRouterClient({
    apiKey: params.apiKey || undefined,
  });
  const routingPolicy = buildCortexAiVisionRoutingPolicy({
    credentialSource: client.credentialSource,
    requestedModelId: params.modelId,
    selectedModel: client.modelSelection,
  });

  // Downloaded here, once, rather than by the SDK on every attempt in the fallback chain.
  // AI SDK 7's own downloader loads undici at runtime in a way deployments do not ship; see
  // vision-image-download.ts. Lazily imported, like the client above, so this module's pure
  // helpers stay importable without Node's http stack.
  const { downloadCortexVisionImage } = await import('./vision-image-download');
  const image = await downloadCortexVisionImage(imageUrl, { abortSignal: params.abortSignal });

  const messages: ModelMessage[] = [
    {
      content: [
        {
          text: buildAltTextInstruction({ context, maxLength }),
          type: 'text',
        },
        {
          // The bytes, with the media type the server declared or the file signature
          // showed. It is never guessed from the URL, which is unreliable for the CDN and
          // signed-URL shapes this CMS produces (query strings, no extension, or one that
          // disagrees with what the bucket serves); a wrong type makes the provider
          // reject the part outright.
          data: image.data,
          mediaType: image.mediaType,
          type: 'file',
        },
      ],
      role: 'user',
    },
  ];

  const generation = await runWithCortexAiModelFallback({
    modelIds: routingPolicy.modelIds,
    shouldRetry: isRecoverableAltTextError,
    execute: async (attemptModelId: CortexAiOpenRouterModelId) => {
      const abortController = new AbortController();
      const timeoutId = setTimeout(
        () => abortController.abort(),
        CORTEX_AI_VISION_ATTEMPT_TIMEOUT_MS
      );
      // Chain the caller's signal onto this attempt's controller so a cancelled CMS
      // request stops the download-and-generate round trip immediately, rather than
      // leaving it to run to completion behind a response nobody is waiting for.
      const abortFromCaller = () => abortController.abort();
      params.abortSignal?.addEventListener('abort', abortFromCaller, { once: true });

      if (params.abortSignal?.aborted) {
        abortController.abort();
      }

      try {
        const attemptOptions = omitUnsupportedCortexAiModelOptions(
          {
            abortSignal: abortController.signal,
            // Alt text is one short line, but several models in the chain emit
            // reasoning tokens against the same budget, so leave headroom rather
            // than truncating the answer to nothing on those.
            maxOutputTokens: 400,
            maxRetries: 0,
            messages,
            instructions: buildAltTextSystemPrompt(maxLength),
            temperature: 0.2,
          } as Record<string, unknown>,
          {
            modelId: attemptModelId,
            modelSelection: client.modelSelection,
          }
        );

        const result = await generateText({
          ...attemptOptions,
          model: client.model(attemptModelId),
        } as Parameters<typeof generateText>[0]);

        const altText = normalizeGeneratedAltText(result.text, maxLength);

        if (!altText) {
          // An empty result is usually a model refusing the image part or replying
          // with nothing but a preamble we then stripped. Both are worth another
          // model, and an empty alt attribute would silently ship an inaccessible
          // image, so treat it as a retryable failure rather than a valid answer.
          throw new Error('Cortex AI returned empty alt text.');
        }

        return altText;
      } finally {
        clearTimeout(timeoutId);
        params.abortSignal?.removeEventListener('abort', abortFromCaller);
      }
    },
  });

  return {
    altText: generation.result,
    attempts: generation.attempts.length,
    credentialSource: client.credentialSource,
    modelId: generation.modelId,
  };
}
