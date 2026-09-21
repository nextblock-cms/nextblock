import { generateText } from 'ai';

import {
  buildCortexAiRoutingPolicy,
  getHttpStatusCode,
  isOpenRouterRecoverableRoutingError,
  omitUnsupportedCortexAiModelOptions,
  runWithCortexAiModelFallback,
  type CortexAiOpenRouterModelId,
} from './ai-model-registry';
import { z } from './zod-config';

const SERVER_ONLY_ERROR_MESSAGE =
  'Cortex AI SEO metadata generation can only be imported from server-side code.';

function assertServerOnly() {
  if (typeof window === 'undefined') {
    return;
  }

  throw new Error(SERVER_ONLY_ERROR_MESSAGE);
}

/**
 * The shape we require back from the model. Every field is a trimmed, non-empty
 * string: a blank meta description is worse than no meta description at all,
 * because the crawler then indexes an empty tag instead of falling back to the
 * page copy, so we would rather fail the attempt and let the routing fallback try
 * the next model than persist an empty value.
 *
 * `z.strictObject` is deliberate. Models routinely volunteer extra keys such as
 * `keywords`, `slug`, or `notes`; rejecting them here keeps the contract honest
 * and surfaces a drifting prompt as a loud validation error rather than as
 * silently ignored output. The routing layer treats a validation failure as
 * retryable, so a chatty model simply costs us one extra attempt.
 */
export const cortexAiSeoMetadataOutputSchema = z.strictObject({
  metaDescription: z.string().trim().min(1),
  metaTitle: z.string().trim().min(1),
  ogDescription: z.string().trim().min(1),
  ogTitle: z.string().trim().min(1),
});

export type CortexAiSeoMetadataOutput = z.infer<typeof cortexAiSeoMetadataOutputSchema>;

/**
 * Length budgets applied AFTER parsing rather than trusted to the prompt.
 *
 * Every model overshoots a stated character budget some of the time — they count
 * tokens, not characters, and they cannot see their own output length while
 * generating it. Asking for "under 60 characters" in the prompt raises the hit
 * rate but never guarantees it, and a meta title that a search engine truncates
 * mid-word in the results list is a user-visible defect. So the prompt states the
 * budget (to get well-shaped copy) and this table enforces it (to get a correct
 * result).
 *
 * The numbers track what search engines and social crawlers actually render:
 * roughly 60 characters before a title is cut in the results list, roughly 160 for
 * a description snippet, and the looser Open Graph card limits used by Facebook,
 * LinkedIn, and Slack unfurls.
 */
export const CORTEX_AI_SEO_METADATA_LENGTH_BUDGETS = {
  metaDescription: 160,
  metaTitle: 60,
  ogDescription: 200,
  ogTitle: 88,
} as const;

/**
 * How much page copy we are willing to ship to the model. Long-form posts can run
 * to tens of thousands of characters, and the leading paragraphs carry almost all
 * of the signal a title and description need. Truncating here keeps a single call
 * inside the context window of even the smallest free fallback model, keeps the
 * request cheap, and — because the free tail is rate-limited by tokens per minute
 * as well as by requests — materially improves the odds that the first attempt
 * succeeds instead of falling through the whole registry.
 */
export const CORTEX_AI_SEO_METADATA_CONTENT_BUDGET = 6000;

const CORTEX_AI_SEO_METADATA_ATTEMPT_TIMEOUT_MS = 60_000;

/**
 * Characters we refuse to leave at the end of a truncated string. A cut that lands
 * after a comma, a dash, or a colon reads as broken copy ("Best hiking boots for,")
 * where a cut that lands after the previous word reads as a deliberately short
 * title. This is only ever applied on the truncation path — a value that already
 * fits its budget is returned exactly as given, so a legitimate closing period on a
 * short description survives untouched.
 */
const TRAILING_SEPARATOR_PATTERN =
  /[\s.,;:!?‐-―\-/\\|&+*_"'([{·•]+$/;

/**
 * Shorten `value` to at most `maxLength` characters without splitting a word.
 *
 * The rule is: prefer the last whitespace inside the budget, because that is the
 * only cut point guaranteed to leave a complete word behind. When there is no
 * whitespace inside the budget at all the input is a single long token — a URL, a
 * German compound noun, a CJK sentence written without spaces — and a hard cut at
 * exactly `maxLength` is the only option that both respects the budget and returns
 * something useful, so we take it rather than returning an over-budget string or an
 * empty one.
 *
 * This is exported because it is the piece most likely to be subtly wrong and the
 * piece the unit tests target directly. `ai-vision.ts` imports it rather than
 * defining its own copy, both so the alt-text and metadata paths cannot drift apart
 * in how they shorten a string, and because two modules exporting the same name
 * through the `export *` barrel in src/index.ts would collide.
 */
export function truncateOnWordBoundary(value: string, maxLength: number): string {
  const normalized = value.trim();

  if (maxLength <= 0) {
    return '';
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  const window = normalized.slice(0, maxLength);
  // `\s\S*$` matches the last run of non-whitespace in the window, so its index is
  // the whitespace character that begins the (probably partial) final word. A result
  // of -1 means the window holds no whitespace at all; a result of 0 would mean the
  // window is entirely leading whitespace, which trimming above has already ruled
  // out. Either way we fall back to the hard cut.
  const lastBoundaryIndex = window.search(/\s\S*$/);
  const candidate = lastBoundaryIndex > 0 ? window.slice(0, lastBoundaryIndex) : window;

  return candidate.replace(TRAILING_SEPARATOR_PATTERN, '').trim();
}

/**
 * Pull the outermost balanced JSON object out of a model response.
 *
 * We ask for bare JSON and most models comply, but "most" is not "all": the same
 * prompt can come back wrapped in ```json fences, prefixed with "Here is the
 * metadata:", or followed by an unsolicited explanation of the choices made.
 * Rather than tighten the prompt forever, we tolerate all three shapes here.
 *
 * The scan is string-aware on purpose. A naive `indexOf('{')` / `lastIndexOf('}')`
 * pair breaks the moment a description legitimately contains a brace — and copy
 * about templating, CSS, or code frequently does. Tracking whether we are inside a
 * JSON string literal, and honouring backslash escapes within it, means braces in
 * content are ignored while braces in structure are counted. Nested objects fall out
 * of the same depth counter for free.
 *
 * Returns `null` rather than throwing so the caller can decide that "no JSON here"
 * is a retryable attempt failure instead of a hard error.
 */
export function extractJsonObject(value: string): string | null {
  // Fence markers are stripped first so that a ```json wrapper cannot contribute a
  // stray character to the scan. Only the marker itself is removed; the JSON body
  // between the fences is left exactly as the model wrote it.
  const withoutFences = value.replace(/```[a-zA-Z0-9]*/g, '');
  const startIndex = withoutFences.indexOf('{');

  if (startIndex === -1) {
    return null;
  }

  let depth = 0;
  let insideString = false;
  let escaped = false;

  for (let index = startIndex; index < withoutFences.length; index++) {
    const character = withoutFences[index];

    if (insideString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        insideString = false;
      }

      continue;
    }

    if (character === '"') {
      insideString = true;
      continue;
    }

    if (character === '{') {
      depth++;
      continue;
    }

    if (character === '}') {
      depth--;

      if (depth === 0) {
        return withoutFences.slice(startIndex, index + 1);
      }
    }
  }

  // We ran off the end of the response with an open brace still outstanding, which
  // is exactly what a generation truncated by an output-token cap looks like. There
  // is no partial object worth handing to JSON.parse, so report the absence and let
  // the caller retry on the next model.
  return null;
}

export interface GenerateSeoMetadataParams {
  abortSignal?: AbortSignal;
  apiKey?: string | null;
  content: string;
  focusKeyword?: string | null;
  locale?: string | null;
  modelId?: string | null;
  siteTitle?: string | null;
  title?: string | null;
}

export interface GenerateSeoMetadataResult {
  attempts: number;
  credentialSource: string;
  metaDescription: string;
  metaTitle: string;
  modelId: string;
  ogDescription: string;
  ogTitle: string;
}

function buildSeoMetadataSystemPrompt() {
  const budgets = CORTEX_AI_SEO_METADATA_LENGTH_BUDGETS;

  return [
    'You are NextBlock Cortex AI, an SEO metadata writer for a content management system.',
    'Return ONLY a single JSON object. No markdown fences, no commentary, no explanation, no trailing prose.',
    'The object must have exactly these four keys, all strings, all non-empty: "metaDescription", "metaTitle", "ogDescription", "ogTitle".',
    'Do not add any other key.',
    `metaTitle must be at most ${budgets.metaTitle} characters and read as a search-result headline for this specific page.`,
    `metaDescription must be at most ${budgets.metaDescription} characters, summarise what the page actually delivers, and end as a complete thought.`,
    `ogTitle must be at most ${budgets.ogTitle} characters and may be slightly more conversational than metaTitle, because it is read on a social card rather than in a results list.`,
    `ogDescription must be at most ${budgets.ogDescription} characters and should invite a click without over-promising.`,
    'Write plain text. No emoji, no surrounding quotation marks, no HTML, no markdown.',
    'Describe only what the supplied content actually contains. Never invent statistics, prices, dates, awards, or claims that are not in the content.',
    'Never keyword-stuff, never repeat the focus keyword more than twice across all four fields, and never pad a field to reach its character budget.',
  ].join(' ');
}

function buildSeoMetadataPrompt(params: {
  content: string;
  focusKeyword: string | null;
  locale: string | null;
  siteTitle: string | null;
  title: string | null;
}) {
  return [
    'Write SEO metadata for the following page.',
    params.title ? `Page title: ${params.title}` : null,
    params.siteTitle
      ? `Site name: ${params.siteTitle}. Do not append the site name to metaTitle; the site appends it separately.`
      : null,
    params.focusKeyword
      ? `Focus keyword: ${params.focusKeyword}. Use it naturally in metaTitle and metaDescription, at most once each.`
      : null,
    params.locale
      ? `Write every field in this locale: ${params.locale}. Match its conventions for capitalisation and punctuation.`
      : null,
    `Page content:\n${params.content}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Parse and range-check one attempt's raw text.
 *
 * This is kept separate from the network call so that every failure mode below
 * throws a message `isRecoverableSeoMetadataError` recognises. A model that answers
 * in prose, or that omits a key, should cost one attempt and move the routing on to
 * the next model rather than failing the user's whole request.
 */
function validateGeneratedSeoMetadata(rawText: string): CortexAiSeoMetadataOutput {
  const jsonText = extractJsonObject(rawText);

  if (!jsonText) {
    throw new Error('Cortex AI returned no JSON object for the SEO metadata request.');
  }

  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(
      `Cortex AI returned invalid JSON for the SEO metadata request: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const metadata = cortexAiSeoMetadataOutputSchema.parse(parsedJson);

  // Budgets are enforced here, after validation, because the model's own compliance
  // with the stated limits is advisory at best. Truncating on a word boundary keeps
  // the copy readable even in the cases where the model ignored the limit entirely.
  return {
    metaDescription: truncateOnWordBoundary(
      metadata.metaDescription,
      CORTEX_AI_SEO_METADATA_LENGTH_BUDGETS.metaDescription
    ),
    metaTitle: truncateOnWordBoundary(
      metadata.metaTitle,
      CORTEX_AI_SEO_METADATA_LENGTH_BUDGETS.metaTitle
    ),
    ogDescription: truncateOnWordBoundary(
      metadata.ogDescription,
      CORTEX_AI_SEO_METADATA_LENGTH_BUDGETS.ogDescription
    ),
    ogTitle: truncateOnWordBoundary(
      metadata.ogTitle,
      CORTEX_AI_SEO_METADATA_LENGTH_BUDGETS.ogTitle
    ),
  };
}

/**
 * Mirrors `isRecoverableHtmlGenerationError` in ai-block-generation.ts: credential
 * problems (401/402/403) are terminal, because retrying the same bad key against a
 * different model only burns time, while shape problems and transient provider
 * failures are worth another model. The Zod issue codes are matched by name because
 * a `ZodError` message is a serialised list of those issues rather than prose.
 */
function isRecoverableSeoMetadataError(error: unknown) {
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
  return /NoContentGenerated|No content generated|Provider returned error|no JSON object|invalid JSON|invalid_type|too_small|unrecognized_keys|Invalid input|aborted|abort|timeout|timed out/i.test(
    message
  );
}

/**
 * Generate meta and Open Graph copy for a page in a single model call.
 *
 * This uses `generateText` plus our own JSON extraction rather than
 * `generateObject`, following the precedent set by ai-block-generation.ts and for
 * the reason recorded in ai-cortex-widget-builder.ts: a provider-side JSON schema
 * (`response_format: json_schema`) is rejected outright by several models reachable
 * through OpenRouter, and most of the free fallback tier does not advertise
 * `structured_outputs` at all. Describing the shape in the prompt and validating it
 * ourselves with Zod is the only approach that works across the entire routing
 * chain, and it degrades gracefully — a model that wraps its JSON in fences still
 * succeeds instead of erroring inside the SDK.
 *
 * Routing goes through the ordinary text policy, because every field here is text
 * produced from text. Only the vision path in ai-vision.ts needs a policy of its
 * own.
 */
export async function generateCortexAiSeoMetadata(
  params: GenerateSeoMetadataParams
): Promise<GenerateSeoMetadataResult> {
  assertServerOnly();

  const content = truncateOnWordBoundary(params.content, CORTEX_AI_SEO_METADATA_CONTENT_BUDGET);

  if (!content) {
    throw new Error('Cortex AI SEO metadata generation requires non-empty page content.');
  }

  // The client factory is imported lazily, the same way ai-client.ts itself defers
  // its `@nextblock-cms/db/server` import. Pulling it in at module scope would drag
  // the credential-decryption and Supabase service-role graph into every module that
  // only wants `truncateOnWordBoundary` or `extractJsonObject` — including the unit
  // tests for those helpers, which have no business resolving a database client.
  const { createCortexAiOpenRouterClient } = await import('./ai-client');
  const client = await createCortexAiOpenRouterClient({
    apiKey: params.apiKey || undefined,
  });
  const routingPolicy = buildCortexAiRoutingPolicy({
    credentialSource: client.credentialSource,
    requestedModelId: params.modelId,
    selectedModel: client.modelSelection,
  });

  const generation = await runWithCortexAiModelFallback({
    modelIds: routingPolicy.modelIds,
    shouldRetry: isRecoverableSeoMetadataError,
    execute: async (attemptModelId: CortexAiOpenRouterModelId) => {
      const abortController = new AbortController();
      const timeoutId = setTimeout(
        () => abortController.abort(),
        CORTEX_AI_SEO_METADATA_ATTEMPT_TIMEOUT_MS
      );
      // A caller-supplied signal has to abort the in-flight attempt too, otherwise a
      // cancelled CMS request keeps paying for a generation nobody will ever read.
      // Chaining a listener rather than reaching for `AbortSignal.any` keeps this
      // working on every runtime the published package can land in.
      const abortFromCaller = () => abortController.abort();
      params.abortSignal?.addEventListener('abort', abortFromCaller, { once: true });

      if (params.abortSignal?.aborted) {
        abortController.abort();
      }

      try {
        const attemptOptions = omitUnsupportedCortexAiModelOptions(
          {
            abortSignal: abortController.signal,
            maxOutputTokens: 700,
            maxRetries: 0,
            prompt: buildSeoMetadataPrompt({
              content,
              focusKeyword: params.focusKeyword?.trim() || null,
              locale: params.locale?.trim() || null,
              siteTitle: params.siteTitle?.trim() || null,
              title: params.title?.trim() || null,
            }),
            instructions: buildSeoMetadataSystemPrompt(),
            temperature: 0.3,
          } as Record<string, unknown>,
          {
            modelId: attemptModelId,
            modelSelection: routingPolicy.modelSelection,
          }
        );

        const result = await generateText({
          ...attemptOptions,
          model: client.model(attemptModelId),
        } as Parameters<typeof generateText>[0]);

        return validateGeneratedSeoMetadata(result.text);
      } finally {
        clearTimeout(timeoutId);
        params.abortSignal?.removeEventListener('abort', abortFromCaller);
      }
    },
  });

  return {
    attempts: generation.attempts.length,
    credentialSource: client.credentialSource,
    metaDescription: generation.result.metaDescription,
    metaTitle: generation.result.metaTitle,
    modelId: generation.modelId,
    ogDescription: generation.result.ogDescription,
    ogTitle: generation.result.ogTitle,
  };
}
