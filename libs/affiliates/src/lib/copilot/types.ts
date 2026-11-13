/**
 * Types of the partner storefront copilot (SPEC §8): the catalog the route hands the tools, the
 * tool dependencies and what each tool returns. The executors are output-only: they validate and
 * convert what the model produced, and the portal inserts the result into the open editor (whose
 * autosave writes `draft_content`). Nothing here reads or writes a database.
 */
import type { RETAILER_COPILOT_TOOL_NAMES } from '../core/constants';
import type { StorefrontBlockNode, StorefrontImageAttrs } from '../storefront/types';

/** `generate_retailer_bio` | `generate_storefront_section` | `rewrite_storefront_copy`. */
export type RetailerCopilotToolName = (typeof RETAILER_COPILOT_TOOL_NAMES)[number];

/** A store product the copilot may feature (active and public; the route loads at most 40). */
export interface RetailerCopilotProduct {
  id: string;
  title: string;
  shortDescription: string | null;
  priceLabel: string | null;
}

/**
 * Server-side stock photo search for one query (the route builds it on Cortex
 * `executeSearchStockPhotos`): the first usable photo as storefront image attributes with its
 * credit, or null when there is no provider or no result.
 */
export type RetailerCopilotStockImageSearch = (query: string) => Promise<StorefrontImageAttrs | null>;

export interface RetailerCopilotToolDeps {
  /** The only products a generated product grid may reference. */
  catalog: readonly RetailerCopilotProduct[];
  /** Image origins a generated image may load from (`getStorefrontImageOrigins()`). */
  allowedImageOrigins: readonly string[];
  /** Omitted when no stock photo provider is configured: image blocks are then skipped. */
  searchStockImage?: RetailerCopilotStockImageSearch;
}

/** What `retailerSectionToStorefrontBlocks()` converts with. */
export interface RetailerCopilotSectionContext {
  /** Catalog products by id. Ids are compared case-insensitively. */
  catalog: ReadonlyMap<string, RetailerCopilotProduct>;
  /** Resolved stock photos by image query (see `normalizeRetailerCopilotImageQuery`); null = none found. */
  images: ReadonlyMap<string, StorefrontImageAttrs | null>;
  allowedImageOrigins: readonly string[];
}

/** A converted section with what was left out, for the tool output and the model-facing summary. */
export interface RetailerCopilotSectionConversion {
  /** The section title as plain text (the H2 that opens `blocks`). */
  title: string;
  /** Sanitized storefront blocks, ready for `StorefrontEditorApi.insertBlocks()`. */
  blocks: StorefrontBlockNode[];
  /** Product ids of the section's grids, deduplicated, in document order. */
  productIds: string[];
  imageCount: number;
  /** Product ids the model named that are not in the catalog (dropped). */
  droppedProductIds: number;
  /**
   * Image blocks without a usable photo (no provider, no result, the section's or the request's
   * lookup cap, host not allowed).
   */
  skippedImages: number;
  /** Blocks that ended up empty and were left out. */
  skippedBlocks: number;
}

/**
 * `section_limit`: the request already drafted `RETAILER_COPILOT_MAX_SECTIONS_PER_REQUEST`
 * sections; the call was refused before any work (the partner asks again in a new message).
 */
export type RetailerCopilotToolErrorCode = 'invalid_input' | 'empty_output' | 'empty_section' | 'section_limit';

/** A tool result the model can recover from (it may correct its input and call the tool again). */
export interface RetailerCopilotToolFailure {
  ok: false;
  error: RetailerCopilotToolErrorCode;
  /** English, model-facing. The panel shows its own localized copy keyed by `error`. */
  message: string;
}

export interface RetailerCopilotBioSuccess {
  ok: true;
  /** Plain text, tags stripped, whitespace collapsed (80–1200 characters as generated). */
  bio: string;
  /** Plain text, one line. */
  meta_description: string;
}

export interface RetailerCopilotSectionSuccess {
  ok: true;
  title: string;
  /** Sanitized blocks; they pass `sanitizeStorefrontDoc()` unchanged. */
  nodes: StorefrontBlockNode[];
  productIds: string[];
  imageCount: number;
  /** What was left out: unknown product ids, image blocks without a photo, empty blocks. */
  skipped: { productIds: number; images: number; blocks: number };
}

export interface RetailerCopilotRewriteSuccess {
  ok: true;
  /** One line of plain text for `StorefrontEditorApi.replaceSelection()`. */
  text: string;
  /** The same text split into paragraphs, for a caller that inserts paragraph blocks instead. */
  paragraphs: string[];
}

export type RetailerCopilotBioOutput = RetailerCopilotBioSuccess | RetailerCopilotToolFailure;
export type RetailerCopilotSectionOutput = RetailerCopilotSectionSuccess | RetailerCopilotToolFailure;
export type RetailerCopilotRewriteOutput = RetailerCopilotRewriteSuccess | RetailerCopilotToolFailure;

/** Untrusted-data wrapper the route injects (`wrapUntrustedData` with the request's boundary). */
export type RetailerCopilotUntrustedWrapper = (source: string, value: unknown) => string;

export interface RetailerCopilotInstructionsInput {
  /** `fr*` writes Canadian French; anything else English. */
  locale: string;
  displayName: string | null;
  handle: string | null;
  currentBio: string | null;
  pageTitle: string | null;
  catalog: readonly RetailerCopilotProduct[];
  /** The text selected in the editor (plain text), or null. */
  selection: string | null;
  wrapUntrusted: RetailerCopilotUntrustedWrapper;
  /** The system-prompt rule that gives the wrapper's markers their meaning. */
  untrustedInstruction: string;
}
