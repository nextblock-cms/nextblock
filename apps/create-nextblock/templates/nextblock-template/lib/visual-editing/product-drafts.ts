import "server-only";

import type { Json } from "@nextblock-cms/db";
import { createClient } from "@nextblock-cms/db/server";
// Deep subpaths: the product page imports this module, and the '/server' barrel would make
// every CMS commerce page's client components part of that route.
import {
  buildProductDraftPublishValues,
  getProduct,
  type ProductDraftPublishValues,
} from "@nextblock-cms/ecommerce/product-actions";
import { syncProductSaleCouponToFreemius } from "@nextblock-cms/ecommerce/freemius-coupons";
import { getCmsActor, requireCmsAdmin } from "../auth/cms-actor";
import { getCurrentUserCanEdit, normalizeDraftBlocks } from "./draft-content";
import {
  classifyProductDraftMeta,
  describeSkippedProductDraftOverlay,
  hasProductDraftFormMarker,
  legacyProductDraftMetaAsOverlay,
  NO_PRODUCT_DRAFT_ERROR,
  planProductDraftOverlayPublish,
  PRODUCT_DRAFT_GONE_DURING_SAVE_ERROR,
  PRODUCT_DRAFT_OVERLAY_FIELDS,
  resolveProductDraftOverlayDisplay,
  withoutRecordedLegacySnapshotField,
  type ProductDraftOverlayField,
  type ProductDraftOverlayPublishPlan,
} from "./product-draft-meta";
import {
  buildPoisonedProductDraftPublishError,
  buildUnreadableProductDraftPublishError,
  completeProductDraftValues,
  findPoisonedProductDraftFields,
  findUnreadableProductDraftValues,
  listProductStockEntries,
  type PoisonedProductDraftField,
} from "../../app/cms/products/productFormData";
import {
  formatVisualEditingError,
  requireVisualEditingEditableUser,
  revalidateVisualEditingPath,
  type VisualEditingMutationResult,
} from "./mutations";
import type {
  ProductVisualEditingField,
  VisualEditingProductFieldRequest,
  DraftBlockSnapshot,
} from "./types";

type SupabaseAny = ReturnType<typeof createClient>;

/** The form values buildProductDraftPublishValues takes (libs/ecommerce ProductFormValues). */
type ProductFormValues = Parameters<typeof buildProductDraftPublishValues>[0];

export interface ProductDraftRow {
  id: number;
  product_id: string;
  author_id: string | null;
  meta: Record<string, Json>;
  blocks: DraftBlockSnapshot[];
  created_at: string;
  updated_at: string;
}

const PRODUCT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const productEditableFields = new Set<ProductVisualEditingField>([
  "title",
  "short_description",
  "description_json",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeProductDraftRow(row: Record<string, unknown>): ProductDraftRow {
  return {
    id: Number(row.id),
    product_id: String(row.product_id ?? ""),
    author_id: typeof row.author_id === "string" ? row.author_id : null,
    meta: isRecord(row.meta) ? (row.meta as Record<string, Json>) : {},
    blocks: normalizeDraftBlocks(row.blocks),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

function getProductPublicPath(slug: string) {
  return `/product/${slug}`;
}

/** Revalidate `/product/<slug>` once per distinct slug: the live one, and a draft's when it differs. */
function revalidateProductPublicPaths(slugs: unknown[]) {
  const seen = new Set<string>();
  for (const slug of slugs) {
    if (typeof slug !== "string" || !slug || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    revalidateVisualEditingPath(getProductPublicPath(slug));
  }
}

/**
 * The live slug, for revalidation only (null when it cannot be read). An overlay draft carries no
 * slug, so the public path comes from the products row.
 */
export async function readLiveProductSlug(supabase: SupabaseAny, productId: string): Promise<string | null> {
  try {
    const { data } = await (supabase as any)
      .from("products")
      .select("slug")
      .eq("id", productId)
      .maybeSingle();
    return typeof data?.slug === "string" ? data.slug : null;
  } catch {
    return null;
  }
}

function isProductVisualEditingField(value: unknown): value is ProductVisualEditingField {
  return typeof value === "string" && productEditableFields.has(value as ProductVisualEditingField);
}

export function assertValidProductFieldRequest(request: VisualEditingProductFieldRequest) {
  if (request.parentType !== "product") {
    throw new Error("Invalid product draft target.");
  }

  if (!request.parentId || !PRODUCT_ID_PATTERN.test(request.parentId)) {
    throw new Error("Invalid product ID.");
  }

  if (request.target?.kind !== "product-field" || !isProductVisualEditingField(request.target.field)) {
    throw new Error("Invalid product field target.");
  }

  if (request.target.field === "description_json") {
    if (request.target.input !== "tiptap") {
      throw new Error("Invalid product field editor.");
    }
  } else {
    if (request.target.input !== "plain-text") {
      throw new Error("Invalid product field editor.");
    }
  }
}

function normalizeProductFieldContent(
  field: ProductVisualEditingField,
  content: Json
): Json {
  if (field === "title") {
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("Product title cannot be empty.");
    }

    return content.trim();
  }

  if (field === "short_description") {
    if (content === null) {
      return null;
    }

    if (typeof content !== "string") {
      throw new Error("Product short description must be text.");
    }

    return content;
  }

  if (field === "description_json") {
    if (content !== null && typeof content !== "object") {
      throw new Error("Product description must be a rich-text JSON document.");
    }
    return content;
  }

  return content;
}

/**
 * The product's live description blocks as draft snapshots: what a new draft starts from, and what
 * the in-page block editor reads while no draft exists. Throws when the product does not exist.
 *
 * It replaces readProductSnapshot(), whose `meta` was the raw products row (minor units, no
 * variants) and seeded every draft until 0.23.4 (lib/visual-editing/product-draft-meta.ts).
 */
export async function readProductLiveBlocks(
  supabase: SupabaseAny,
  productId: string
): Promise<DraftBlockSnapshot[]> {
  const { data: product, error } = await (supabase as any)
    .from("products")
    .select("id")
    .eq("id", productId)
    .maybeSingle();

  if (error || !product) {
    throw new Error(`Product not found: ${error?.message ?? "unknown error"}`);
  }

  const { data: blocks, error: blocksError } = await (supabase as any)
    .from("blocks")
    .select("id, page_id, post_id, product_id, language_id, block_type, content, order, created_at, updated_at")
    .eq("product_id", productId)
    .order("order", { ascending: true });

  if (blocksError) {
    throw new Error(`Failed to read product blocks: ${blocksError.message}`);
  }

  return normalizeDraftBlocks(blocks);
}

/**
 * The live row as planProductDraftOverlayPublish reads it: the slug, the overlay fields (the in-page
 * editor's fields too), `updated_at`.
 */
type LiveProductOverlayRow = Partial<Record<ProductDraftOverlayField | "slug" | "updated_at", unknown>>;

async function readLiveProductOverlayRow(
  supabase: SupabaseAny,
  productId: string
): Promise<LiveProductOverlayRow> {
  const { data, error } = await (supabase as any)
    .from("products")
    .select("slug, title, short_description, description_json, updated_at")
    .eq("id", productId)
    .maybeSingle();

  if (error || !data) {
    throw new Error(`Product not found: ${error?.message ?? "unknown error"}`);
  }

  return data as LiveProductOverlayRow;
}

/**
 * A description block as publish_product_draft (migration 02043) writes it: the draft's row without
 * its ids and timestamps, which the database gives the new row.
 */
type ProductBlockPayload = {
  language_id: number;
  block_type: string;
  content: Json;
  order: number;
};

/** `updated_at` as a products row read returned it (null when the column is NULL or absent). */
function readUpdatedAt(row: unknown): string | null {
  return isRecord(row) && typeof row.updated_at === "string" ? row.updated_at : null;
}

/**
 * A SKU whose stock publish_product_draft (migration 02044) did not set to the draft's quantity as a
 * change from its baseline, in its answer's `stock_adjusted`: `loaded` the draft's baseline (the stock its
 * change started from), `entered` the draft's quantity, `current` the SKU's quantity just before the
 * publish (null when unknown), `published` now live. The draft's figures may be another editor's autosave
 * or a hand-written draft's.
 * - `moved`: the change was applied to a quantity that had moved since it started, so `published` is not
 *   `entered` (loaded 5, typed 15, one sold meanwhile: 14).
 * - `already_live`: the quantity already was `entered`, so the SKU was left as it was (`published` =
 *   `current` = `entered`): right for a change already published (a draft started again after its
 *   publish), wrong for one meant to come on top of what moved the stock (loaded 10, 9 typed for a
 *   damaged unit, one sold meanwhile: 9 stays where 8 was meant). The rule stays on purpose, and the
 *   warning names every SKU it decides (review 2026-11-18).
 */
export interface AdjustedProductStock {
  sku: string;
  reason: "moved" | "already_live";
  entered: number;
  loaded: number;
  current: number | null;
  published: number;
}

/** `stock_adjusted` as the function answers it; `reason` "already_live" is that kind, anything else (none included) moved. */
function readAdjustedProductStock(value: unknown): AdjustedProductStock[] {
  const isCount = (count: unknown): count is number => typeof count === "number" && Number.isFinite(count);
  return (Array.isArray(value) ? value : []).flatMap((entry) =>
    isRecord(entry) && typeof entry.sku === "string" && isCount(entry.entered) && isCount(entry.loaded) && isCount(entry.published)
      ? [
          {
            sku: entry.sku,
            reason: entry.reason === "already_live" ? ("already_live" as const) : ("moved" as const),
            entered: entry.entered,
            loaded: entry.loaded,
            current: isCount(entry.current) ? entry.current : null,
            published: entry.published,
          },
        ]
      : []
  );
}

/** What publish_product_draft answers once everything is live (null fields when it did not say). */
function readPublishResult(data: unknown) {
  const result = isRecord(data) ? data : {};
  return {
    slug: typeof result.slug === "string" ? result.slug : null,
    paymentProvider: typeof result.payment_provider === "string" ? result.payment_provider : null,
    stockAdjusted: readAdjustedProductStock(result.stock_adjusted),
  };
}

/**
 * The warning for the SKUs publish did not set to the draft's figure as a change from its baseline
 * (AdjustedProductStock), one part per kind, each naming the first five SKUs, then how many more
 * (listProductStockEntries, as the edit page's notes do):
 * - moved: the change was applied to the stock at publishing, which a sale, the Inventory screen, an
 *   import or a translation's publish had moved since the change started, instead of replacing it, so
 *   nothing sold meanwhile came back;
 * - already live: the stock already held the draft's figure, so the change was not applied on top of it.
 * Each says when to correct the stock. It names the draft, never the publisher: the figures may be another
 * editor's autosave, or a hand-written draft's that nobody typed (any WRITER can write a draft's
 * quantities and its `stock_baseline` over PostgREST). The draft bar shows it in a toast that stays until
 * it is dismissed.
 */
export function describeAdjustedProductStock(adjusted: readonly AdjustedProductStock[]) {
  const parts: string[] = [];

  const moved = adjusted.filter((entry) => entry.reason !== "already_live");
  if (moved.length > 0) {
    const one = moved.length === 1;
    const list = listProductStockEntries(
      moved.map((entry) => {
        const meanwhile = entry.current === null ? "" : `, and it was ${entry.current} at publishing`;
        return `${entry.sku} is now ${entry.published} (the draft changed ${entry.loaded} to ${entry.entered}${meanwhile})`;
      })
    );
    parts.push(
      one
        ? `The stock at publishing differed from the figure this draft's stock change started from (after a sale or another stock update, for example), so the change was applied to the stock at publishing instead of replacing it: ${list}. If the draft's figure already counted that change, correct the stock.`
        : `The stock at publishing differed from the figures this draft's stock changes started from (after a sale or another stock update, for example), so the changes were applied to the stock at publishing instead of replacing it: ${list}. If the draft's figures already counted those changes, correct the stock.`
    );
  }

  const alreadyLive = adjusted.filter((entry) => entry.reason === "already_live");
  if (alreadyLive.length > 0) {
    const one = alreadyLive.length === 1;
    const list = listProductStockEntries(
      alreadyLive.map((entry) => {
        const atPublishing = entry.current === null ? "" : `, and it was already ${entry.current} at publishing`;
        return `${entry.sku} stays at ${entry.published} (the draft changed ${entry.loaded} to ${entry.entered}${atPublishing})`;
      })
    );
    parts.push(
      one
        ? `The stock already showed this draft's figure at publishing, so the change was not applied on top of it: ${list}. If the change was meant to come on top of what moved the stock (a damaged unit taken out after a sale, for example), correct the stock.`
        : `The stock already showed this draft's figures at publishing, so the changes were not applied on top of them: ${list}. If a change was meant to come on top of what moved the stock (a damaged unit taken out after a sale, for example), correct the stock.`
    );
  }

  return `Published. ${parts.join(" ")}`;
}

/** `text` ending in a full stop (PostgREST's messages carry none), so a warning can follow it. */
function asSentence(text: string) {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * The warning for a Freemius sale coupon the publish could not push (syncProductSaleCouponToFreemius
 * records the failure on the coupon row and returns it; it never throws). Until 0.23.4 publish ignored
 * that answer and said the changes went live with no caveat, while Freemius' checkout kept charging
 * without the sale the storefront showed.
 */
function describeFreemiusSaleCouponFailure(error: unknown) {
  const reason = typeof error === "string" && error.trim() ? ` (${asSentence(error).slice(0, -1)})` : "";
  return `Published, but the Freemius sale coupon was not updated${reason}: Freemius' checkout does not apply the sale price until it is. Save a change in the product form and publish it once Freemius answers (a description-block or in-page edit does not push the coupon).`;
}

export async function getProductDraft(productId: string): Promise<ProductDraftRow | null> {
  const supabase = createClient();
  const { data, error } = await (supabase as any)
    .from("product_drafts")
    .select("*")
    .eq("product_id", productId)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return normalizeProductDraftRow(data);
}

export async function getOrCreateProductDraft(
  supabase: SupabaseAny,
  productId: string,
  authorId: string
): Promise<ProductDraftRow> {
  const { data: existing, error: existingError } = await (supabase as any)
    .from("product_drafts")
    .select("*")
    .eq("product_id", productId)
    .maybeSingle();

  if (existingError) {
    throw new Error(`Failed to read product draft: ${existingError.message}`);
  }

  if (existing) {
    return normalizeProductDraftRow(existing);
  }

  // The blocks start from the live rows; `meta` stages nothing. It is the in-page overlay
  // (title / short_description / description_json land in it as the editor saves them), and only
  // the product form's autosave writes product values into it. Until 0.23.4 this seeded `meta`
  // with the raw products row (minor units, no variants), which publish then handed
  // updateProduct() as form values: every price x100, every variant deleted, the description and
  // the sale schedule cleared (lib/visual-editing/product-draft-meta.ts).
  const blocks = await readProductLiveBlocks(supabase, productId);
  const { data: created, error: createError } = await (supabase as any)
    .from("product_drafts")
    .insert({
      product_id: productId,
      author_id: authorId,
      meta: {},
      blocks,
    })
    .select("*")
    .single();

  if (createError || !created) {
    throw new Error(`Failed to create product draft: ${createError?.message ?? "unknown error"}`);
  }

  return normalizeProductDraftRow(created);
}

/**
 * The live product read the way publish reads it (getProduct), for an unmarked product-values draft:
 * the only kind findPoisonedProductDraftFields checks. Null, without a read, for any other draft.
 * Throws when the product cannot be read, so no caller takes a draft it could not check.
 */
async function readLiveProductForDraftCheck(
  supabase: SupabaseAny,
  productId: string,
  meta: Record<string, Json>
): Promise<Record<string, unknown> | null> {
  if (classifyProductDraftMeta(meta) !== "product-values" || hasProductDraftFormMarker(meta)) {
    return null;
  }

  const { data: liveProduct, error } = await getProduct(supabase as any, productId);
  if (error || !liveProduct) {
    throw new Error(`Product not found: ${error?.message ?? "unknown error"}`);
  }

  return liveProduct as Record<string, unknown>;
}

/**
 * The poisoned field groups of an unmarked product-values draft (findPoisonedProductDraftFields:
 * an earlier version's autosave over a row snapshot), against the live product read the way publish
 * reads it. Empty, without a read, for any other draft.
 */
async function readPoisonedProductDraftFields(
  supabase: SupabaseAny,
  productId: string,
  meta: Record<string, Json>
): Promise<PoisonedProductDraftField[]> {
  const liveProduct = await readLiveProductForDraftCheck(supabase, productId, meta);
  return liveProduct ? findPoisonedProductDraftFields(meta, liveProduct) : [];
}

/**
 * The in-page save's refusal for a draft publish refuses as an earlier version's: publish's
 * explanation (a CMS draft import's own, given its `meta`) and advice
 * (buildPoisonedProductDraftPublishError), with this surface's verbs.
 */
export function buildPoisonedProductDraftInPageSaveError(fields: readonly PoisonedProductDraftField[], meta?: unknown) {
  return buildPoisonedProductDraftPublishError(fields, { meta })
    .replace(/^Not published\./, "Not saved.")
    .replace(/then publish\.$/, "then edit here.");
}

/**
 * The in-page save's refusal for an edit that would make publish refuse a draft it accepts: an
 * emptied description in an unmarked product-values draft (findPoisonedProductDraftFields reads it
 * as the old edit page's copy). The CMS editor's autosave stamps the marker, so it can clear it.
 */
export const PRODUCT_DRAFT_IN_PAGE_EMPTIED_DESCRIPTION_ERROR =
  "Not saved. This draft was saved by an earlier version of NextBlock, and in such a draft an empty description reads as that version's copy, so publishing would refuse the draft. To clear the description, do it in the CMS editor instead.";

/**
 * The overlay fields a draft shows over the live product in the storefront preview and the in-page
 * editor: what publishing it would write (resolveProductDraftOverlayDisplay: a field publish would
 * skip shows its live value), and the live description in place of the emptied one of a draft
 * publish refuses (`poisonedFields` naming description_json), as the CMS editor shows it.
 */
function resolveShownProductDraftFields(
  draft: ProductDraftRow,
  liveProduct: Record<string, unknown>,
  poisonedFields: readonly PoisonedProductDraftField[]
): Partial<Record<ProductDraftOverlayField, unknown>> {
  const shown = resolveProductDraftOverlayDisplay(draft.meta, liveProduct, draft.created_at);
  if (poisonedFields.includes("description_json")) {
    delete shown.description_json;
  }
  return shown;
}

/**
 * The storefront's draft preview: the live product (the product page passes the getProductBySlug
 * row: `updated_at`, the variants and the gallery included) with the draft's title, short
 * description and description laid over it as resolveShownProductDraftFields shows them.
 */
export function applyProductDraftToProductRecord<T extends Record<string, unknown>>(
  product: T,
  draft: ProductDraftRow | null
): T {
  if (!draft) {
    return product;
  }

  return {
    ...product,
    ...resolveShownProductDraftFields(draft, product, findPoisonedProductDraftFields(draft.meta, product)),
  } as T;
}

export async function loadProductVisualEditingField(request: VisualEditingProductFieldRequest) {
  try {
    assertValidProductFieldRequest(request);
    const auth = await requireVisualEditingEditableUser();
    const { data } = await (auth.supabase as any)
      .from("product_drafts")
      .select("*")
      .eq("product_id", request.parentId)
      .maybeSingle();

    const draft = data ? normalizeProductDraftRow(data) : null;
    const field = request.target.field;
    // The value the storefront preview shows (resolveShownProductDraftFields), else the live one: a
    // draft created by a block edit stages nothing (the editor used to open empty, and saving
    // replaced the description), and a field publish would skip shows live.
    const live = await readLiveProductOverlayRow(auth.supabase, request.parentId);
    const poisonedFields =
      draft && field === "description_json"
        ? await readPoisonedProductDraftFields(auth.supabase, request.parentId, draft.meta)
        : [];
    const shown = draft ? resolveShownProductDraftFields(draft, live, poisonedFields) : {};
    const content = ((hasOwn(shown, field) ? shown[field] : live[field]) ?? null) as Json;

    return {
      success: true,
      content,
      draftId: draft?.id ?? null,
    };
  } catch (error) {
    return {
      error: formatVisualEditingError(error, "Failed to load product draft field."),
    };
  }
}

export async function saveProductVisualEditingDraftMutation(
  request: VisualEditingProductFieldRequest,
  content: Json
): Promise<VisualEditingMutationResult> {
  try {
    assertValidProductFieldRequest(request);
    const auth = await requireVisualEditingEditableUser();
    const field = request.target.field;
    const value = normalizeProductFieldContent(field, content);

    // Twice at most: an UPDATE that returns no row found the draft deleted after it was read (a
    // publish, which deletes it in the transaction that makes it live, so a save that waited on its
    // lock lands here, or a discard, from another tab or user). The edit then goes into a new draft,
    // as if it was made just after.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const draft = await getOrCreateProductDraft(auth.supabase, request.parentId, auth.user.id);

      // A draft publish refuses as an earlier version's autosave over a row snapshot stays refused
      // until the CMS editor repairs it: written into here, it could lose the only sign the check reads
      // (its emptied description) while its x100 prices and old stock stayed in, ready to publish.
      const liveProductForCheck = await readLiveProductForDraftCheck(auth.supabase, request.parentId, draft.meta);
      const poisonedFields = liveProductForCheck ? findPoisonedProductDraftFields(draft.meta, liveProductForCheck) : [];
      if (poisonedFields.length > 0) {
        return { error: buildPoisonedProductDraftInPageSaveError(poisonedFields, draft.meta) };
      }

      // A pre-0.23.4 row snapshot is rewritten as the overlay publishing it would write now (the
      // snapshot fields it keeps recorded, so they keep the rule), plus this edit. Kept as a snapshot,
      // it stayed one, and once the live row changed publish skipped this edit with the rest, however
      // often it was made (lib/visual-editing/product-draft-meta.ts).
      const baseMeta =
        classifyProductDraftMeta(draft.meta) === "legacy-row-snapshot"
          ? legacyProductDraftMetaAsOverlay(
              draft.meta,
              await readLiveProductOverlayRow(auth.supabase, request.parentId),
              draft.created_at,
              field
            )
          : draft.meta;
      // The field is an in-page edit now, whatever the snapshot held for it.
      const nextMeta = withoutRecordedLegacySnapshotField({ ...baseMeta, [field]: value }, field);

      // Nor does an in-page save newly flag a draft (none is flagged by now). Of the fields it edits,
      // the check reads only the description: emptying it in a clean unmarked draft would make publish
      // refuse the draft as an old copy and lock this editor out of it (the CMS editor would then show
      // the live prices over the draft's).
      if (liveProductForCheck && findPoisonedProductDraftFields(nextMeta, liveProductForCheck).length > 0) {
        return { error: PRODUCT_DRAFT_IN_PAGE_EMPTIED_DESCRIPTION_ERROR };
      }

      const { data, error } = await (auth.supabase as any)
        .from("product_drafts")
        .update({
          author_id: auth.user.id,
          meta: nextMeta,
        })
        .eq("id", draft.id)
        .select("*");

      if (error) {
        return {
          error: formatVisualEditingError(
            new Error(`Failed to save product draft: ${error.message}`),
            "Failed to save product draft."
          ),
        };
      }

      const savedRow: unknown = Array.isArray(data) ? data[0] : null;
      if (!isRecord(savedRow)) {
        continue;
      }

      const savedDraft = normalizeProductDraftRow(savedRow);
      revalidateProductPublicPaths([
        await readLiveProductSlug(auth.supabase, request.parentId),
        savedDraft.meta.slug,
      ]);

      return { success: true };
    }

    return { error: PRODUCT_DRAFT_GONE_DURING_SAVE_ERROR };
  } catch (error) {
    return {
      error: formatVisualEditingError(error, "Failed to save product draft."),
    };
  }
}

/** What anyone but an ADMIN past the second factor gets from publish. */
export const PRODUCT_PUBLISH_ADMIN_ONLY_ERROR = "Only an administrator can publish products.";

/**
 * publish_product_draft refused the draft because it changed after this publish read it (NBP02): an
 * in-page edit, a block edit, a form autosave or a Cortex edit saved into it in between. That change
 * stays in the draft.
 */
export const PRODUCT_DRAFT_CHANGED_DURING_PUBLISH_ERROR =
  "The draft changed after this publish read it (an edit was saved into it meanwhile): nothing was published, and the draft keeps that edit. Publish again.";

/**
 * publish_product_draft refused because the product row changed after this publish read it (NBP03): a
 * Cortex field update, a Freemius sync, a sale's stock update or another write landed in between, and
 * the values publish completed from that read could have reverted it.
 */
export const PRODUCT_CHANGED_DURING_PUBLISH_ERROR =
  "The product changed after this publish read it (another save, a sync or a sale wrote it meanwhile): nothing was published; the draft is kept. Publish again.";

/** A deadlock or lock conflict with a write to this product or to a translation sharing its SKU. */
export const PRODUCT_PUBLISH_CONFLICT_ERROR =
  "Another change to this product, or to a translation sharing its SKU, was being saved at the same moment: nothing was published; the draft is kept. Publish again.";

/**
 * The database has no publish_product_draft: migration 02043 has not been applied there. The route to
 * apply it depends on the install (docs/13, the 0.23.6 entry): a project made with create-nextblock has no
 * `db:migrate` script, and applies pending migrations with `npm run update -- --db-only` or on its next
 * production build (the build hook migrates); the NextBlock repository runs `npm run db:migrate`.
 */
export const PRODUCT_PUBLISH_NEEDS_MIGRATION_ERROR =
  "Publishing products needs database migration 02043, which this database has not applied yet. Nothing was published; the draft is kept. Apply the pending migrations (in a project made with create-nextblock: npm run update -- --db-only, or redeploy; in the NextBlock repository: npm run db:migrate), then publish again.";

/**
 * The message for a publish call that got no answer from the database: supabase-js reports a failed
 * request (the network, a timeout) as an error without a code, and the call may have committed before
 * its answer was lost. So it never says nothing was published.
 */
function describeUnconfirmedProductPublish(message: string) {
  const reason = message ? ` (${asSentence(message).slice(0, -1)})` : "";
  return `The publish could not be confirmed${reason}. Reload the page: if the draft is gone, it was published; if it is still there, nothing was, and you can publish again.`;
}

/**
 * The message for a publish_product_draft error. Every error the database answered (a SQLSTATE, or
 * PostgREST's own code) rolled the whole publish back, so nothing is live and the draft stays.
 */
function describeProductPublishFailure(error: { code?: unknown; message?: unknown } | null | undefined) {
  const code = typeof error?.code === "string" ? error.code : "";
  const message = typeof error?.message === "string" ? error.message.trim() : "";

  if (!code) return describeUnconfirmedProductPublish(message);
  if (code === "NBP01") return NO_PRODUCT_DRAFT_ERROR;
  if (code === "NBP02") return PRODUCT_DRAFT_CHANGED_DURING_PUBLISH_ERROR;
  if (code === "NBP03") return PRODUCT_CHANGED_DURING_PUBLISH_ERROR;
  if (code === "42501" && message === PRODUCT_PUBLISH_ADMIN_ONLY_ERROR) return PRODUCT_PUBLISH_ADMIN_ONLY_ERROR;
  if (code === "40P01" || code === "40001" || code === "55P03") return PRODUCT_PUBLISH_CONFLICT_ERROR;
  // PostgREST's answer for a function its schema cache does not have, and Postgres' own.
  if (code === "PGRST202" || code === "42883") return PRODUCT_PUBLISH_NEEDS_MIGRATION_ERROR;

  return `Publishing failed: ${asSentence(message || "unknown error")} Nothing was published; the draft is kept.`;
}

/**
 * requireCmsAdmin() throws `Forbidden` for a signed-in non-ADMIN, and `Unauthorized` without a session
 * or while an enrolled second factor is still pending (getCmsActor() returns null for both): an ADMIN
 * in that state is told what is missing.
 */
function describeProductPublishRefusal(authError: unknown) {
  if (authError instanceof Error && authError.message === "Forbidden") {
    return PRODUCT_PUBLISH_ADMIN_ONLY_ERROR;
  }

  return `${PRODUCT_PUBLISH_ADMIN_ONLY_ERROR} If you are one, sign in and complete two-factor verification, then publish again.`;
}

export async function publishProductVisualEditingDraft(
  productId: string
): Promise<VisualEditingMutationResult> {
  // Every product publish needs an ADMIN past the second factor, checked before anything is read:
  // publish_product_draft (migration 02043) refuses anyone but an ADMIN by role only (is_admin(), as
  // every products write policy does, which a password alone satisfies), and a Freemius product's
  // sale coupon is pushed with the service role through the developer key pair; product_revisions
  // accepts only ADMIN inserts (02003 product_revisions_insert_policy), and the function records
  // History in the same transaction. WRITERs keep editing drafts. A server action never meets the
  // CMS layout's 2FA redirect, so the second factor is checked here too.
  //
  // Awaited bare in a try whose catch returns, not `requireCmsAdmin().catch(...)`: the coupon-push
  // scan in tools/scripts/server-action-actors.test.ts cannot prove what a .catch() handler does.
  let admin: Awaited<ReturnType<typeof requireCmsAdmin>>;
  try {
    admin = await requireCmsAdmin();
  } catch (authError: unknown) {
    return { success: false, error: describeProductPublishRefusal(authError) };
  }

  try {
    // Reads and the publish itself run as the caller (RLS: products, variants, the gallery,
    // categories, inventory and product_revisions take ADMIN writes); the service-role client only
    // pushes the Freemius sale coupon.
    const supabase = createClient();
    const { data, error } = await (supabase as any)
      .from("product_drafts")
      .select("*")
      .eq("product_id", productId)
      .maybeSingle();

    if (error) {
      return {
        success: false,
        error: formatVisualEditingError(
          new Error(`Failed to read product draft: ${error.message}`),
          "Failed to read product draft."
        ),
      };
    }

    if (!data) {
      return { success: false, error: NO_PRODUCT_DRAFT_ERROR };
    }

    const draft = normalizeProductDraftRow(data);

    // Only a draft the product form (or a CMS draft import) wrote carries product values. A draft
    // a block edit or the in-page editor created stages the overlay fields at most, and one
    // created before 0.23.4 holds the raw products row in minor units: neither may be published as
    // product values, which would read its cents as dollars (lib/visual-editing/product-draft-meta.ts).
    const metaKind = classifyProductDraftMeta(draft.meta);
    // The public path to revalidate: the live slug as it was before this publish.
    let liveSlug: string | null = null;
    // The products row's updated_at as read here: publish_product_draft refuses when the row changed
    // since, because the values below were completed (or planned) from this read.
    let liveUpdatedAt: string | null = null;
    let values: ProductDraftPublishValues | null = null;
    let overlayPlan: ProductDraftOverlayPublishPlan = { update: {}, skipped: [] };

    if (metaKind === "product-values") {
      // The live product, read the way the edit page reads it. The publish replaces every column the
      // values carry and every variant, and clears the SEO fields and the sale schedule they lack, so
      // a field the draft lacks (a CMS draft import carries no sale schedule) is taken from here
      // instead of being cleared, zeroed or deleted.
      const { data: liveProduct, error: liveProductError } = await getProduct(supabase as any, productId);

      if (liveProductError || !liveProduct) {
        throw new Error(`Product not found: ${liveProductError?.message ?? "unknown error"}`);
      }

      liveSlug = typeof (liveProduct as any).slug === "string" ? (liveProduct as any).slug : null;
      liveUpdatedAt = readUpdatedAt(liveProduct);

      // An unmarked draft an earlier version wrote is refused before any write
      // (findPoisonedProductDraftFields has the rules). A form autosave over a row snapshot shows
      // through an amount equal to the live one in cents or at least 20 times it (the product's, a
      // price map's, a variant's), a price equal to one of the product's Freemius plan prices in
      // cents, or a group left empty where the live product has one (variants, gallery,
      // description), and is refused for every group that then differs from live: the prices,
      // rebuilt variants, the snapshot's stock, a gallery that drops a live image, an emptied
      // description. An old CMS draft import is refused for the variants, gallery or description it
      // left empty. The edit page shows the live values for those fields and its next autosave
      // repairs the draft; until then the in-page editor refuses to save into it.
      const poisonedFields = findPoisonedProductDraftFields(draft.meta, liveProduct);
      if (poisonedFields.length > 0) {
        return { success: false, error: buildPoisonedProductDraftPublishError(poisonedFields, { meta: draft.meta }) };
      }

      // A stock or a SKU publish cannot read (findUnreadableProductDraftValues: a stock that is not a
      // number or numeric text, a SKU that is not text; only a hand-written draft holds one) is refused
      // before any write, marked or not. Sent as it was, it reached the function in a form the edit page
      // never showed (until 2026-11-18 "NaN" went live as the largest stock, and a number SKU's change
      // applies to a baseline entry the page cannot key) or failed the publish midway. The edit page names
      // them and shows the live stock in place of a stock it cannot read, so its next autosave repairs the
      // draft.
      const unreadableValues = findUnreadableProductDraftValues(draft.meta, liveProduct);
      if (unreadableValues.length > 0) {
        return { success: false, error: buildUnreadableProductDraftPublishError(unreadableValues) };
      }

      // Never the draft's `status` (visibility belongs to the row: the values sent carry none, and the
      // function writes none), its `media_id` or `explicitly_removed_media_ids`
      // (completeProductDraftValues drops both: a publish never deletes media, it only unlinks an
      // image the gallery drops). Its `stock_baseline` (the stock the edit page loaded) goes along, for
      // the SKUs the live product stocks: the function writes a SKU's stock only where the draft's
      // quantity differs from it and from the current stock, as a change to the stock as it is at
      // publishing (migration 02044), so a sale since the page load stays.
      values = buildProductDraftPublishValues(
        completeProductDraftValues(draft.meta as Record<string, unknown>, liveProduct) as unknown as ProductFormValues
      );
    } else {
      // An overlay, or a pre-0.23.4 row snapshot: the overlay fields only, and only those that
      // differ from the live row; a legacy snapshot's, and the snapshot fields an overlay recorded
      // when it was rewritten from one, only while the row is unchanged since the snapshot was
      // taken (planProductDraftOverlayPublish). Prices, variants, the gallery and the sale schedule
      // stay as they are.
      const liveProduct = await readLiveProductOverlayRow(supabase, productId);
      liveSlug = typeof liveProduct.slug === "string" ? liveProduct.slug : null;
      liveUpdatedAt = readUpdatedAt(liveProduct);
      overlayPlan = planProductDraftOverlayPublish(draft.meta, liveProduct, draft.created_at);
    }

    // The draft's description blocks replace the live ones ([] deletes them).
    const blocks: ProductBlockPayload[] = draft.blocks.map((block, index) => ({
      language_id: block.language_id,
      block_type: block.block_type,
      content: block.content,
      order: Number.isFinite(block.order) ? block.order : index,
    }));

    // One transaction (migration 02043): the products row and then the draft row locked, refused with
    // nothing written when the draft is gone (another publish or a discard came first), when it changed
    // since the read above (a save landed in between: it stays in the draft) or when the products row
    // did; then the product values or the overlay fields, the blocks, History (a revision whenever the
    // content changed, prices, variants, stock, the sale window and the gallery included) and the draft
    // delete. Any failure rolls all of it back, so nothing is ever half-published.
    let answer: { data: unknown; error: { code?: unknown; message?: unknown } | null };
    try {
      answer = await (supabase as any).rpc("publish_product_draft", {
        p_product_id: productId,
        p_draft_id: draft.id,
        p_draft_updated_at: draft.updated_at,
        p_product_updated_at: liveUpdatedAt,
        p_values: values,
        p_overlay: values ? null : overlayPlan.update,
        p_blocks: blocks,
      });
    } catch (requestError) {
      answer = { data: null, error: { message: requestError instanceof Error ? requestError.message : String(requestError) } };
    }
    const { data: published, error: publishError } = answer;

    if (publishError) {
      const code = typeof publishError.code === "string" ? publishError.code : "";
      if (!["NBP01", "NBP02", "NBP03"].includes(code)) {
        console.error("Product draft publish failed:", publishError);
      }
      // No answer: it may have committed, so the pages are refreshed in case it did.
      if (!code) {
        revalidateProductPublicPaths([liveSlug, draft.meta.slug]);
        revalidateVisualEditingPath(`/cms/products/${productId}/edit`);
      }
      return { success: false, error: describeProductPublishFailure(publishError) };
    }

    // Everything is live from here on.
    const result = readPublishResult(published);

    // A Freemius sale coupon that could not be pushed: the storefront then shows a sale that Freemius'
    // checkout does not apply, so it is said with the publish's other warnings. Pushed after the
    // commit, from the values now live (Freemius is outside the transaction).
    let couponWarning: string | null = null;
    if (values && result.paymentProvider === "freemius") {
      try {
        const couponResult = await syncProductSaleCouponToFreemius({
          productId,
          client: admin.supabase as any,
        });
        if (couponResult && couponResult.success === false) {
          console.error("Failed to sync Freemius sale coupon on publish:", couponResult.error);
          couponWarning = describeFreemiusSaleCouponFailure(couponResult.error);
        }
      } catch (couponError) {
        console.error("Failed to sync Freemius sale coupon on publish:", couponError);
        couponWarning = describeFreemiusSaleCouponFailure(
          couponError instanceof Error ? couponError.message : String(couponError)
        );
      }
    }

    const warnings = [
      overlayPlan.skipped.length > 0
        ? describeSkippedProductDraftOverlay(
            overlayPlan.skipped,
            PRODUCT_DRAFT_OVERLAY_FIELDS.filter((field) => hasOwn(overlayPlan.update as Record<string, unknown>, field))
          )
        : null,
      // A stock change applied to a quantity that moved while the draft was open, or not applied because
      // the stock already held the draft's figure (migration 02044): live at another figure than a change
      // from the draft's baseline gives, so the editor is told which and why.
      result.stockAdjusted.length > 0 ? describeAdjustedProductStock(result.stockAdjusted) : null,
      couponWarning,
    ].filter((warning): warning is string => Boolean(warning));

    // The slug the product had, the one it has now (a product-values draft may rename it) and the
    // edit page, whose re-render in this action's response resets the form to the published values.
    revalidateProductPublicPaths([liveSlug, result.slug, draft.meta.slug]);
    revalidateVisualEditingPath(`/cms/products/${productId}/edit`);

    if (warnings.length > 0) {
      return { success: true, warning: warnings.join(" ") };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: formatVisualEditingError(error, "Failed to publish product draft."),
    };
  }
}

export async function discardProductVisualEditingDraft(
  productId: string
): Promise<VisualEditingMutationResult> {
  try {
    const auth = await requireVisualEditingEditableUser();
    const { data } = await (auth.supabase as any)
      .from("product_drafts")
      .select("meta")
      .eq("product_id", productId)
      .maybeSingle();
    const { error } = await (auth.supabase as any)
      .from("product_drafts")
      .delete()
      .eq("product_id", productId);

    if (error) {
      return {
        error: formatVisualEditingError(
          new Error(`Failed to discard product draft: ${error.message}`),
          "Failed to discard product draft."
        ),
      };
    }

    const meta = isRecord(data?.meta) ? data.meta : {};
    revalidateProductPublicPaths([await readLiveProductSlug(auth.supabase, productId), meta.slug]);
    // The edit page too, as publish does: its re-render in the action's response resets the form to
    // the live values. The draft bar skips router.refresh() for a product and counts on this (a
    // revalidation of any path re-renders today, but none ran when the slug read failed).
    revalidateVisualEditingPath(`/cms/products/${productId}/edit`);

    return { success: true };
  } catch (error) {
    return {
      error: formatVisualEditingError(error, "Failed to discard product draft."),
    };
  }
}

export async function currentUserCanReadProductDrafts() {
  const auth = await getCurrentUserCanEdit();
  return auth.canEdit;
}

/**
 * Whether the caller may publish a product draft: an ADMIN past the second factor, the check
 * publishProductVisualEditingDraft opens with (requireCmsAdmin() over the same getCmsActor()). For
 * the UI only: the CMS edit page (its draft bar and visibility control) and the root layout (the
 * storefront toolbar) disable Publish for anyone else; publish checks again, whatever the page showed.
 */
export async function currentUserCanPublishProductDrafts(): Promise<boolean> {
  try {
    return (await getCmsActor())?.role === "ADMIN";
  } catch {
    return false;
  }
}
