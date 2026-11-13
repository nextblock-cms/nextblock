/**
 * The partner copilot's tool set (SPEC §8): EXACTLY the three `RETAILER_COPILOT_TOOL_NAMES`, never
 * a Cortex admin tool. The executors are output-only: they validate and clean what the model
 * produced and hand it back; the portal shows it as a preview and the partner applies it to the
 * open editor (whose autosave writes `draft_content`). No executor reads or writes a database,
 * fetches a URL or sees a credential; the only side door is `deps.searchStockImage`, a server
 * function the route builds, which a tool set calls at most
 * `RETAILER_COPILOT_MAX_IMAGE_LOOKUPS_PER_REQUEST` times.
 *
 * Every tool sets `strict: true` and has a literal description and schema, so the tool list is
 * byte-identical across requests (prompt caching, reproducible behavior).
 */
import { tool, type ToolSet } from 'ai';

import type { StorefrontImageAttrs } from '../storefront/types';
import { retailerCopilotMarkdownToPlainText, splitRetailerCopilotParagraphs } from './markdown-lite';
import {
  retailerBioToolInputSchema,
  retailerRewriteToolInputSchema,
  retailerSectionToolInputSchema,
  type RetailerSectionBlockInput,
} from './schemas';
import {
  cleanRetailerCopilotImageQuery,
  convertRetailerCopilotSection,
  createRetailerCopilotCatalogIndex,
} from './section-to-doc';
import type {
  RetailerCopilotBioOutput,
  RetailerCopilotProduct,
  RetailerCopilotRewriteOutput,
  RetailerCopilotSectionOutput,
  RetailerCopilotStockImageSearch,
  RetailerCopilotToolDeps,
  RetailerCopilotToolErrorCode,
  RetailerCopilotToolFailure,
  RetailerCopilotToolName,
} from './types';

/** Stock photo lookups one section may trigger (further image blocks are skipped). */
export const RETAILER_COPILOT_MAX_IMAGE_LOOKUPS = 3;

/**
 * Stock photo lookups ONE tool set may trigger across all its section calls, parallel ones in a
 * step and those of later steps alike. The route builds one tool set per copilot request, so this
 * is the per-request budget on the operator's Pexels / Unsplash keys (which the admin agent
 * shares). Image blocks past it are skipped like a photo that was not found.
 */
export const RETAILER_COPILOT_MAX_IMAGE_LOOKUPS_PER_REQUEST = 3;

/**
 * Sections ONE tool set (one copilot request) drafts. Later `generate_storefront_section` calls
 * are refused with `section_limit` before any work, so they look up no photo; a call whose draft
 * fails gives its slot back.
 */
export const RETAILER_COPILOT_MAX_SECTIONS_PER_REQUEST = 3;

/** A lookup slower than this counts as "no photo" so a slow provider cannot stall the reply. */
export const RETAILER_COPILOT_IMAGE_LOOKUP_TIMEOUT_MS = 8000;

interface PreparedDeps {
  catalog: ReadonlyMap<string, RetailerCopilotProduct>;
  allowedImageOrigins: readonly string[];
  searchStockImage: RetailerCopilotStockImageSearch | undefined;
}

export interface RetailerCopilotImageLookupOptions {
  maxLookups?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function failure(error: RetailerCopilotToolErrorCode, message: string): RetailerCopilotToolFailure {
  return { ok: false, error, message };
}

function prepareDeps(deps: RetailerCopilotToolDeps): PreparedDeps {
  return {
    catalog: createRetailerCopilotCatalogIndex(deps?.catalog),
    allowedImageOrigins: Array.isArray(deps?.allowedImageOrigins) ? [...deps.allowedImageOrigins] : [],
    searchStockImage: typeof deps?.searchStockImage === 'function' ? deps.searchStockImage : undefined,
  };
}

/**
 * `search` behind a budget every caller shares: once `budget` lookups have started, the next ones
 * resolve to null without reaching the provider. The count moves synchronously when a lookup
 * starts, so parallel section calls cannot overspend it; a lookup skipped because the request was
 * aborted never calls `search` and costs nothing.
 */
function withRetailerCopilotLookupBudget(
  search: RetailerCopilotStockImageSearch | undefined,
  budget: number
): RetailerCopilotStockImageSearch | undefined {
  if (typeof search !== 'function') return undefined;
  let left = Math.max(0, Math.floor(budget));
  return (query) => {
    if (left <= 0) return Promise.resolve(null);
    left -= 1;
    return search(query);
  };
}

async function lookupStockImage(
  search: RetailerCopilotStockImageSearch,
  query: string,
  timeoutMs: number,
  signal: AbortSignal | undefined
): Promise<StorefrontImageAttrs | null> {
  if (signal?.aborted) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const lookup = Promise.resolve()
      .then(() => search(query))
      .then(
        (result) => (typeof result === 'object' && result !== null ? result : null),
        () => null
      );
    const cutoff = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
      if (signal) {
        onAbort = () => resolve(null);
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    return await Promise.race([lookup, cutoff]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Resolves the stock photos of a section's image blocks: one lookup per distinct query (cleaned,
 * compared case-insensitively), at most `RETAILER_COPILOT_MAX_IMAGE_LOOKUPS`, in parallel. A
 * failed, empty, slow or skipped lookup maps to null (the block is then left out). The map is
 * keyed like `normalizeRetailerCopilotImageQuery`.
 */
export async function resolveRetailerCopilotStockImages(
  blocks: readonly Pick<RetailerSectionBlockInput, 'kind' | 'image_query'>[],
  search: RetailerCopilotStockImageSearch | undefined,
  options: RetailerCopilotImageLookupOptions = {}
): Promise<Map<string, StorefrontImageAttrs | null>> {
  const maxLookups = Math.max(0, Math.min(options.maxLookups ?? RETAILER_COPILOT_MAX_IMAGE_LOOKUPS, RETAILER_COPILOT_MAX_IMAGE_LOOKUPS));
  const timeoutMs = Math.max(1, options.timeoutMs ?? RETAILER_COPILOT_IMAGE_LOOKUP_TIMEOUT_MS);
  const images = new Map<string, StorefrontImageAttrs | null>();
  const lookups: Array<{ key: string; query: string }> = [];

  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block?.kind !== 'image') continue;
    const query = cleanRetailerCopilotImageQuery(block.image_query);
    const key = query.toLowerCase();
    if (key === '' || images.has(key)) continue;
    images.set(key, null);
    if (lookups.length < maxLookups) lookups.push({ key, query });
  }

  if (typeof search !== 'function' || lookups.length === 0) return images;

  const results = await Promise.all(
    lookups.map(({ query }) => lookupStockImage(search, query, timeoutMs, options.signal))
  );
  lookups.forEach(({ key }, index) => images.set(key, results[index] ?? null));
  return images;
}

/**
 * `generate_retailer_bio`: the bio and meta description as plain text (tags and markdown markers
 * stripped, whitespace collapsed to single spaces).
 */
export function executeRetailerBioTool(input: unknown): RetailerCopilotBioOutput {
  const parsed = retailerBioToolInputSchema.safeParse(input);
  if (!parsed.success) {
    return failure('invalid_input', 'The input must be { bio, meta_description } with the documented lengths.');
  }
  const bio = retailerCopilotMarkdownToPlainText(parsed.data.bio);
  const metaDescription = retailerCopilotMarkdownToPlainText(parsed.data.meta_description);
  if (bio === '' || metaDescription === '') {
    return failure('empty_output', 'The bio or the meta description was empty once markup was removed. Write plain text.');
  }
  return { ok: true, bio, meta_description: metaDescription };
}

async function runSectionTool(
  input: unknown,
  deps: PreparedDeps,
  signal: AbortSignal | undefined
): Promise<RetailerCopilotSectionOutput> {
  const parsed = retailerSectionToolInputSchema.safeParse(input);
  if (!parsed.success) {
    return failure('invalid_input', 'The input must be { section_title, blocks } with every block field present.');
  }
  const images = await resolveRetailerCopilotStockImages(parsed.data.blocks, deps.searchStockImage, { signal });
  const section = convertRetailerCopilotSection(parsed.data, {
    catalog: deps.catalog,
    images,
    allowedImageOrigins: deps.allowedImageOrigins,
  });
  const contentBlocks = section.blocks.length - (section.title !== '' ? 1 : 0);
  if (contentBlocks <= 0) {
    return failure(
      'empty_section',
      'Nothing usable was left in the section: fill the text, items or product_ids of each block, and use catalog product ids only.'
    );
  }
  return {
    ok: true,
    title: section.title,
    nodes: section.blocks,
    productIds: section.productIds,
    imageCount: section.imageCount,
    skipped: {
      productIds: section.droppedProductIds,
      images: section.skippedImages,
      blocks: section.skippedBlocks,
    },
  };
}

/** The sections a tool set has drafted, or is drafting right now. */
interface SectionSlots {
  used: number;
}

/**
 * `runSectionTool` within the tool set's section cap. The slot is taken before the work starts,
 * so parallel calls cannot overshoot the cap, and given back when the draft fails (the model may
 * correct its input and call again).
 */
async function runCappedSectionTool(
  input: unknown,
  deps: PreparedDeps,
  slots: SectionSlots,
  signal: AbortSignal | undefined
): Promise<RetailerCopilotSectionOutput> {
  if (slots.used >= RETAILER_COPILOT_MAX_SECTIONS_PER_REQUEST) {
    return failure(
      'section_limit',
      `This reply already has ${RETAILER_COPILOT_MAX_SECTIONS_PER_REQUEST} sections, the most one request can draft. Do not call generate_storefront_section again; tell the partner they can ask for the next sections in a new message.`
    );
  }
  slots.used += 1;
  let drafted = false;
  try {
    const output = await runSectionTool(input, deps, signal);
    drafted = output.ok;
    return output;
  } finally {
    if (!drafted) slots.used -= 1;
  }
}

/**
 * `generate_storefront_section`: resolves the image blocks' stock photos through
 * `deps.searchStockImage` (at most 3 lookups; errors count as no photo), then converts the
 * section with `convertRetailerCopilotSection`. One call on its own: the per-request photo budget
 * and section cap belong to `createRetailerCopilotTools`.
 */
export function executeRetailerSectionTool(
  input: unknown,
  deps: RetailerCopilotToolDeps,
  signal?: AbortSignal
): Promise<RetailerCopilotSectionOutput> {
  return runSectionTool(input, prepareDeps(deps), signal);
}

/**
 * `rewrite_storefront_copy`: the rewrite as one line of plain text (for
 * `StorefrontEditorApi.replaceSelection()`) and as paragraphs.
 */
export function executeRetailerRewriteTool(input: unknown): RetailerCopilotRewriteOutput {
  const parsed = retailerRewriteToolInputSchema.safeParse(input);
  if (!parsed.success) {
    return failure('invalid_input', 'The input must be { rewritten_text } with 1 to 4000 characters.');
  }
  const paragraphs = splitRetailerCopilotParagraphs(parsed.data.rewritten_text)
    .map((paragraph) => retailerCopilotMarkdownToPlainText(paragraph))
    .filter((paragraph) => paragraph !== '');
  if (paragraphs.length === 0) {
    return failure('empty_output', 'The rewrite was empty once markup was removed. Write plain text.');
  }
  return { ok: true, text: paragraphs.join(' '), paragraphs };
}

function failureForModel(output: RetailerCopilotToolFailure) {
  return { ok: false, error: output.error, message: output.message };
}

/**
 * The tool set for `streamText({ tools })`. The model sees a short summary of each result
 * (`toModelOutput`): it already knows what it wrote, and the generated nodes, photo credits and
 * alt texts (third-party text from the stock photo providers) never go back into its context.
 * The route streams the full output to the browser.
 *
 * Build ONE tool set per copilot request: it holds the request's budgets, shared by every call it
 * runs (parallel calls in a step, calls in later steps, every model attempt): at most
 * `RETAILER_COPILOT_MAX_IMAGE_LOOKUPS_PER_REQUEST` stock photo lookups and
 * `RETAILER_COPILOT_MAX_SECTIONS_PER_REQUEST` sections. A tool set kept across requests would
 * spend one budget forever.
 */
export function createRetailerCopilotTools(deps: RetailerCopilotToolDeps): ToolSet {
  const base = prepareDeps(deps);
  const prepared: PreparedDeps = {
    ...base,
    searchStockImage: withRetailerCopilotLookupBudget(base.searchStockImage, RETAILER_COPILOT_MAX_IMAGE_LOOKUPS_PER_REQUEST),
  };
  const sectionSlots: SectionSlots = { used: 0 };

  const tools = {
    generate_retailer_bio: tool({
      description:
        "Write the partner's public bio and the SEO meta description of their storefront page. Use it when the partner asks for a bio, an about-me text or a page description, and base it only on what they told you and on their current bio. Output-only: the partner previews the result and applies it themselves; nothing is saved by this tool.",
      inputSchema: retailerBioToolInputSchema,
      strict: true,
      execute: (input) => executeRetailerBioTool(input),
      toModelOutput: ({ output }) => ({
        type: 'json' as const,
        value: output.ok
          ? {
              ok: true,
              status: 'Ready. The partner sees the bio and meta description as a preview and decides whether to apply them.',
              bio_characters: output.bio.length,
              meta_description_characters: output.meta_description.length,
            }
          : failureForModel(output),
      }),
    }),
    generate_storefront_section: tool({
      description:
        "Draft one new section for the partner's storefront page: a heading plus 1 to 12 blocks (sub-headings, paragraphs, bullet lists, callouts, stock photos found by a search query, and grids of store products). Product ids must be copied from the catalog in your instructions. Output-only: the partner previews the section and inserts it into their page themselves; nothing is saved by this tool.",
      inputSchema: retailerSectionToolInputSchema,
      strict: true,
      execute: (input, options) => runCappedSectionTool(input, prepared, sectionSlots, options?.abortSignal),
      toModelOutput: ({ output }) => ({
        type: 'json' as const,
        value: output.ok
          ? {
              ok: true,
              status: 'Ready. The partner sees the section as a preview and decides whether to insert it into their page.',
              title: output.title,
              blocks: output.nodes.length,
              product_ids: output.productIds,
              images: output.imageCount,
              dropped_product_ids: output.skipped.productIds,
              skipped_images: output.skipped.images,
            }
          : failureForModel(output),
      }),
    }),
    rewrite_storefront_copy: tool({
      description:
        "Rewrite or polish the text the partner selected in their storefront editor (it is quoted in your instructions) for clarity, warmth and conversion, keeping its meaning and facts. Call it only when text is selected. Output-only: the partner previews the rewrite and replaces their selection themselves; nothing is saved by this tool.",
      inputSchema: retailerRewriteToolInputSchema,
      strict: true,
      execute: (input) => executeRetailerRewriteTool(input),
      toModelOutput: ({ output }) => ({
        type: 'json' as const,
        value: output.ok
          ? {
              ok: true,
              status: 'Ready. The partner sees the rewrite as a preview and decides whether to replace their selection with it.',
              characters: output.text.length,
            }
          : failureForModel(output),
      }),
    }),
  } satisfies Record<RetailerCopilotToolName, ToolSet[string]>;

  return tools;
}
