import "server-only";

import type { Json } from "@nextblock-cms/db";
import { createClient } from "@nextblock-cms/db/server";
// Deep subpaths: the product page imports this module, and the '/server' barrel would make
// every CMS commerce page's client components part of that route.
import { getProduct, updateProduct } from "@nextblock-cms/ecommerce/product-actions";
import { syncProductSaleCouponToFreemius } from "@nextblock-cms/ecommerce/freemius-coupons";
import { getCmsActor, requireCmsAdmin } from "../auth/cms-actor";
import { getCurrentUserCanEdit, normalizeDraftBlocks } from "./draft-content";
import {
  classifyProductDraftMeta,
  describeProductDraftOverlayFields,
  describeSkippedProductDraftOverlay,
  hasProductDraftFormMarker,
  legacyProductDraftMetaAsOverlay,
  NO_PRODUCT_DRAFT_ERROR,
  planProductDraftOverlayPublish,
  PRODUCT_DRAFT_OVERLAY_FIELDS,
  resolveProductDraftOverlayDisplay,
  withoutRecordedLegacySnapshotField,
  type ProductDraftOverlayField,
  type ProductDraftOverlayPublishPlan,
} from "./product-draft-meta";
import { getFullProductContent } from "../../app/cms/revisions/utils";
import { createProductRevision } from "../../app/cms/revisions/service";
import {
  buildPoisonedProductDraftPublishError,
  completeProductDraftValues,
  findPoisonedProductDraftFields,
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

/** PostgREST answers at most max_rows (1000) rows a request and drops the rest without an error. */
const LIVE_BLOCK_ID_PAGE_SIZE = 1000;

/**
 * The ids of the product's live description blocks: the rows a publish replaces, captured before
 * anything is written, a page at a time.
 */
async function readLiveProductBlockIds(supabase: SupabaseAny, productId: string): Promise<number[]> {
  const ids: number[] = [];

  for (let from = 0; ; from += LIVE_BLOCK_ID_PAGE_SIZE) {
    const { data, error } = await (supabase as any)
      .from("blocks")
      .select("id")
      .eq("product_id", productId)
      .order("id", { ascending: true })
      .range(from, from + LIVE_BLOCK_ID_PAGE_SIZE - 1);

    if (error) {
      throw new Error(
        `Failed to read the product's description blocks: ${error.message}. Nothing was published; the draft is kept.`
      );
    }

    const rows: unknown[] = Array.isArray(data) ? data : [];
    for (const row of rows) {
      const id = isRecord(row) ? Number(row.id) : Number.NaN;
      if (Number.isFinite(id)) {
        ids.push(id);
      }
    }

    if (rows.length < LIVE_BLOCK_ID_PAGE_SIZE) {
      return ids;
    }
  }
}

type ProductBlockInsert = {
  page_id: null;
  post_id: null;
  product_id: string;
  language_id: number;
  block_type: string;
  content: Json;
  order: number;
};

/** The numeric ids of the rows a write returned (`.select("id")`). */
function readReturnedRowIds(data: unknown): number[] {
  return (Array.isArray(data) ? data : [])
    .map((row: unknown) => (isRecord(row) ? Number(row.id) : Number.NaN))
    .filter((id: number) => Number.isFinite(id));
}

/** Takes the rows a publish just inserted back out (best effort): the error message, or null. */
async function deleteInsertedProductBlocks(
  supabase: SupabaseAny,
  productId: string,
  insertedIds: readonly number[]
): Promise<string | null> {
  const { error } = await (supabase as any)
    .from("blocks")
    .delete()
    .eq("product_id", productId)
    .in("id", [...insertedIds]);

  return error ? String(error.message) : null;
}

/**
 * What replaceProductBlocks reports: `error` when the swap stopped part way (publish keeps the draft
 * for another try), `warning` when it finished but some of the captured rows were already gone, or
 * null.
 */
type ProductBlockSwapOutcome = { error: string } | { warning: string } | null;

/** A publish's warning when its blocks DELETE removed fewer rows than it captured (replaceProductBlocks). */
export const PRODUCT_DESCRIPTION_BLOCKS_CHANGED_WARNING =
  "Published, but some of the description blocks this publish replaced had already been removed while it ran (by another publish, a revision restore, Copy from language, a live CMS import or a direct database write). Check the product's description blocks: the page may show some twice.";

/**
 * Replaces the product's live description blocks (`liveBlockIds`, read before any write) with the
 * draft's rows. supabase-js sends each statement as its own request, with no transaction around
 * them, so the order keeps the product whole: the draft's rows are inserted first, then only the
 * captured ids are deleted. A failed insert deletes nothing (the live blocks stay). A failed delete
 * removed nothing, so the rows just inserted are taken back out (best effort) and the page does not
 * show both. The delete returns the rows it removed: fewer than it was given means another writer
 * removed some of them while this publish ran (a revision restore, Copy from language, a live CMS
 * import, a direct database write such as Cortex's raw database tools, or a publish of the same draft
 * that read it after this one claimed it: publishProductVisualEditingDraft). In-page and CMS block
 * edits only ever write the draft, and Cortex's block tools only update or insert rows.
 * The rows just inserted stay then, and publish succeeds with a warning to check the blocks: taking
 * them back out could leave none, when that other writer was a publish of the same draft whose new
 * rows this one captured and removed, and keeping them can at worst show the description twice. An
 * empty draft list just deletes the captured ids.
 */
async function replaceProductBlocks(
  supabase: SupabaseAny,
  productId: string,
  liveBlockIds: readonly number[],
  blocks: readonly ProductBlockInsert[]
): Promise<ProductBlockSwapOutcome> {
  let insertedIds: number[] = [];

  if (blocks.length > 0) {
    const { data, error } = await (supabase as any).from("blocks").insert(blocks as any).select("id");

    if (error) {
      return {
        error: `The draft's description blocks could not be published (${error.message}); the live ones are unchanged.`,
      };
    }

    insertedIds = readReturnedRowIds(data);
  }

  if (liveBlockIds.length === 0) {
    return null;
  }

  const { data: removedRows, error: deleteError } = await (supabase as any)
    .from("blocks")
    .delete()
    .eq("product_id", productId)
    .in("id", [...liveBlockIds])
    .select("id");

  if (deleteError) {
    if (blocks.length === 0) {
      return {
        error: `The live description blocks could not be removed (${deleteError.message}); they are unchanged.`,
      };
    }

    if (insertedIds.length < blocks.length) {
      return {
        error: `The live description blocks could not be removed (${deleteError.message}), and the draft's new rows could not be identified to take them back: the product page shows both until you publish again.`,
      };
    }

    const cleanupError = await deleteInsertedProductBlocks(supabase, productId, insertedIds);
    if (cleanupError) {
      return {
        error: `The live description blocks could not be removed (${deleteError.message}), and neither could the draft's new rows (${cleanupError}): the product page shows both until you publish again.`,
      };
    }

    return {
      error: `The live description blocks could not be removed (${deleteError.message}); the draft's new rows were taken back out, so the live ones are unchanged.`,
    };
  }

  if (readReturnedRowIds(removedRows).length < liveBlockIds.length) {
    return { warning: PRODUCT_DESCRIPTION_BLOCKS_CHANGED_WARNING };
  }

  return null;
}

/** What a publish had already made live when its block step failed (the error says it). */
function describeLiveBeforeProductBlocks(
  wroteProductValues: boolean,
  overlayUpdate: ProductDraftOverlayPublishPlan["update"]
) {
  if (wroteProductValues) {
    return "The draft's product values (prices, variants and details) are already live.";
  }

  const fields = PRODUCT_DRAFT_OVERLAY_FIELDS.filter((field) =>
    hasOwn(overlayUpdate as Record<string, unknown>, field)
  );
  if (fields.length > 0) {
    return `The product's ${describeProductDraftOverlayFields(fields)} ${fields.length > 1 ? "are" : "is"} already live.`;
  }

  return "Nothing else was published.";
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
    const draft = await getOrCreateProductDraft(auth.supabase, request.parentId, auth.user.id);
    const field = request.target.field;
    const value = normalizeProductFieldContent(field, content);

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
      .select("*")
      .single();

    if (error || !data) {
      return {
        error: formatVisualEditingError(
          new Error(`Failed to save product draft: ${error?.message ?? "unknown error"}`),
          "Failed to save product draft."
        ),
      };
    }

    const savedDraft = normalizeProductDraftRow(data);
    revalidateProductPublicPaths([
      await readLiveProductSlug(auth.supabase, request.parentId),
      savedDraft.meta.slug,
    ]);

    return { success: true };
  } catch (error) {
    return {
      error: formatVisualEditingError(error, "Failed to save product draft."),
    };
  }
}

/** What anyone but an ADMIN past the second factor gets from publish. */
export const PRODUCT_PUBLISH_ADMIN_ONLY_ERROR = "Only an administrator can publish products.";

/** What a publish whose claim on the draft matched no row returns (publishProductVisualEditingDraft). */
export const PRODUCT_DRAFT_PUBLISH_CLAIM_REFUSED_ERROR =
  "Another publish of this draft started first, or the draft changed since it was read: nothing was published.";

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
  // product values go through `upsert_product_with_variants` (is_admin(): the role only, which a
  // password alone satisfies) and a Freemius product's sale coupon is pushed with the service role
  // through the developer key pair; product_revisions accepts only ADMIN inserts (02003
  // product_revisions_insert_policy), so a WRITER's publish would go live with no History; and
  // before 0.23.4 no WRITER could complete one anyway (every draft carried product values, and the
  // RPC refused). WRITERs keep editing drafts. A server action never meets the CMS layout's 2FA
  // redirect, so the second factor is checked here too.
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
    // Reads and writes run as the caller (RLS: products and product_revisions take ADMIN writes);
    // the service-role client only pushes the Freemius sale coupon.
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
    // created before 0.23.4 holds the raw products row in minor units: neither may reach
    // updateProduct(), which would read its cents as dollars (lib/visual-editing/product-draft-meta.ts).
    const metaKind = classifyProductDraftMeta(draft.meta);
    // The public path to revalidate: the live slug as it was before this publish.
    let liveSlug: string | null = null;
    let productValues: (ReturnType<typeof completeProductDraftValues> & { status?: unknown }) | null = null;
    let overlayPlan: ProductDraftOverlayPublishPlan = { update: {}, skipped: [] };

    if (metaKind === "product-values") {
      // The live product, read the way the edit page reads it. upsert_product_with_variants
      // replaces every column it takes and every variant, and updateProduct() clears the SEO
      // fields and the sale schedule it is not given, so a field the draft lacks (a CMS draft
      // import carries no sale schedule) is taken from here instead of being cleared, zeroed or
      // deleted.
      const { data: liveProduct, error: liveProductError } = await getProduct(supabase as any, productId);

      if (liveProductError || !liveProduct) {
        throw new Error(`Product not found: ${liveProductError?.message ?? "unknown error"}`);
      }

      liveSlug = typeof (liveProduct as any).slug === "string" ? (liveProduct as any).slug : null;

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

      productValues = {
        ...completeProductDraftValues(draft.meta as Record<string, unknown>, liveProduct),
        // Visibility belongs to the row, not the draft: `upsert_product_with_variants`
        // takes `status` as a required field, so publishing a draft that still carries
        // an old status would move the product in or out of the storefront behind the
        // editor's back. Pin it to whatever is live right now. (`published_at` is not
        // part of the RPC payload, so the schedule survives untouched.)
        status: (liveProduct as any).status ?? (draft.meta as any)?.status,
      };
    } else {
      // An overlay, or a pre-0.23.4 row snapshot: the overlay fields only, and only those that
      // differ from the live row; a legacy snapshot's, and the snapshot fields an overlay recorded
      // when it was rewritten from one, only while the row is unchanged since the snapshot was
      // taken (planProductDraftOverlayPublish). Prices, variants, the gallery and the sale schedule
      // stay as they are.
      const liveProduct = await readLiveProductOverlayRow(supabase, productId);
      liveSlug = typeof liveProduct.slug === "string" ? liveProduct.slug : null;
      overlayPlan = planProductDraftOverlayPublish(draft.meta, liveProduct, draft.created_at);
    }

    // The live description blocks this publish replaces, captured before any write: the draft's
    // rows are inserted first and only these ids deleted after them (replaceProductBlocks).
    const liveBlockIds = await readLiveProductBlockIds(supabase, productId);

    // Captured before any write, so the revision records the real before/after pair.
    const previousContent = await getFullProductContent(productId, undefined, supabase as any);

    // Claim the draft: the last step before the first write, after every check that can refuse. The
    // UPDATE matches only the row as this publish read it, and on_product_drafts_update (02003,
    // BEFORE UPDATE) moves updated_at, so of two publishes that read the same row only the first gets
    // it back. The other, or a publish that read the draft before an edit or an autosave saved into
    // it, stops here with nothing written. A publish that reads the draft after this claim is not
    // stopped: whichever of the two block swaps finds captured rows already gone keeps its own rows
    // and warns (replaceProductBlocks), and for a product with no live description blocks neither
    // captured any, so neither can tell.
    const { data: claimedRows, error: claimError } = await (supabase as any)
      .from("product_drafts")
      .update({ author_id: admin.userId })
      .eq("id", draft.id)
      .eq("updated_at", draft.updated_at)
      .select("id");

    if (claimError) {
      return {
        success: false,
        error: `Failed to start publishing the draft: ${claimError.message}. Nothing was published; the draft is kept.`,
      };
    }

    if (!Array.isArray(claimedRows) || claimedRows.length === 0) {
      return { success: false, error: PRODUCT_DRAFT_PUBLISH_CLAIM_REFUSED_ERROR };
    }

    // A Freemius sale coupon that could not be pushed: the storefront then shows a sale that Freemius'
    // checkout does not apply, so it is said with the publish's other warnings.
    let couponWarning: string | null = null;
    if (productValues) {
      // Only unlinks an image dropped from the gallery: a product save never deletes media
      // (updateProduct in libs/ecommerce product-actions.ts says why).
      await updateProduct(supabase as any, productId, productValues as any);
      if (productValues.payment_provider === "freemius") {
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
    } else if (Object.keys(overlayPlan.update).length > 0) {
      const { data: updatedRows, error: updateError } = await (supabase as any)
        .from("products")
        // updated_at too, like every other write to the row (the sitemap's lastModified reads it).
        .update({ ...overlayPlan.update, updated_at: new Date().toISOString() })
        .eq("id", productId)
        .select("id");

      if (updateError) {
        throw new Error(`Failed to update product: ${updateError.message}`);
      }

      // RLS filters an UPDATE it refuses down to zero rows, without an error (supabase-js returns
      // rows only with .select()). Stop before the blocks so nothing is half-published and the
      // draft stays.
      if (!Array.isArray(updatedRows) || updatedRows.length === 0) {
        throw new Error(
          "The product's title or description was not saved: your account cannot update this product. Nothing was published; the draft is kept."
        );
      }
    }

    // Publish blocks: the draft's rows in, then the captured live ids out. The product row may be
    // live already, so a failure here says what is, keeps the draft for another try and still
    // refreshes the storefront, which must show the row as it now is. ("order" carries no unique
    // constraint, so old and new rows may coexist between the two statements. Captured ids that
    // another writer removed first leave this publish's rows live, with a warning:
    // replaceProductBlocks.)
    const blocksToInsert: ProductBlockInsert[] = draft.blocks.map((block, index) => ({
      page_id: null,
      post_id: null,
      product_id: productId,
      language_id: block.language_id,
      block_type: block.block_type,
      content: block.content,
      order: Number.isFinite(block.order) ? block.order : index,
    }));

    const blocksOutcome = await replaceProductBlocks(supabase, productId, liveBlockIds, blocksToInsert);
    if (blocksOutcome && "error" in blocksOutcome) {
      const wroteProductRow = Boolean(productValues) || Object.keys(overlayPlan.update).length > 0;
      if (wroteProductRow) {
        revalidateProductPublicPaths([liveSlug, draft.meta.slug]);
        revalidateVisualEditingPath(`/cms/products/${productId}/edit`);
      }

      return {
        success: false,
        error: `${blocksOutcome.error} ${describeLiveBeforeProductBlocks(Boolean(productValues), overlayPlan.update)} The draft is kept: publish again to finish.`,
      };
    }

    // The product row and its blocks are already live at this point, so a failed revision
    // is reported as a warning rather than aborting: returning early here would leave the
    // draft row undeleted and the storefront un-revalidated. Recorded through the same ADMIN
    // session (product_revisions_insert_policy: is_admin()).
    let revisionWarning: string | null = null;
    const nextContent = await getFullProductContent(productId, undefined, supabase as any);
    if (previousContent && nextContent) {
      const revision = await createProductRevision(
        productId,
        admin.userId,
        previousContent,
        nextContent,
        supabase
      );
      if ("error" in revision) {
        revisionWarning = revision.error;
      }
    } else {
      revisionWarning = "the product content could not be read back";
    }

    const warnings = [
      overlayPlan.skipped.length > 0
        ? describeSkippedProductDraftOverlay(
            overlayPlan.skipped,
            PRODUCT_DRAFT_OVERLAY_FIELDS.filter((field) => hasOwn(overlayPlan.update as Record<string, unknown>, field))
          )
        : null,
      blocksOutcome && "warning" in blocksOutcome ? blocksOutcome.warning : null,
      revisionWarning ? `Published, but history was not recorded: ${revisionWarning}` : null,
      couponWarning,
    ].filter((warning): warning is string => Boolean(warning));

    // The product row and its blocks are live, whatever the draft delete below does: refresh the slug
    // the product had (and the form draft's when it renamed the product) and the edit page first.
    revalidateProductPublicPaths([liveSlug, draft.meta.slug]);
    revalidateVisualEditingPath(`/cms/products/${productId}/edit`);

    const { error: deleteError } = await (supabase as any)
      .from("product_drafts")
      .delete()
      .eq("id", draft.id);

    if (deleteError) {
      // The edits are live and only the draft row stayed: the draft bar and the visibility dialog show
      // an error starting "Published, but" as a success with that text, so it carries every warning
      // of the publish too (skipped fields, description blocks that may show twice, no history).
      return {
        success: false,
        error: [asSentence(`Published, but failed to remove product draft: ${deleteError.message}`), ...warnings].join(" "),
      };
    }

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
