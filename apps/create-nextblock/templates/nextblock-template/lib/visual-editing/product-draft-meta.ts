/**
 * What a `product_drafts.meta` object holds, and so what publishing it may write.
 *
 * Three code paths write that column, in three shapes, and only one of them carries product
 * values. Publish (`publishProductVisualEditingDraft`) and the product edit page
 * (`app/cms/products/[id]/edit/page.tsx`) both classify through this module. It imports nothing,
 * so any graph may use it.
 *
 * - `product-values`: the product form's autosave (`updateProductAction` → `saveProductDraftMeta`
 *   in libs/ecommerce) or a CMS import in draft mode (`lib/cms-transfer/server.ts`).
 *   `ProductFormValues` in MAJOR units (49.00, `prices: { USD: 49 }`, variant prices likewise),
 *   which `updateProduct()` multiplies by 100. Both writers always store a `variants` array
 *   (`sanitizeProductFormValuesForStoreManagedCurrencies` returns one; the import sets it in
 *   draft mode) and never an `id` (`productSchema` has none, and zod drops unknown keys).
 * - `legacy-row-snapshot`: a draft created before 0.23.4 by a block edit or an in-page edit.
 *   `getOrCreateProductDraft()` seeded `meta` with the raw `products` row: `id` included, prices
 *   in MINOR units (cents), no variants, gallery, categories or sale schedule. Publishing it as
 *   form values multiplied every price by 100, deleted every variant and cleared the description
 *   and the sale schedule. Only its overlay fields (below) mean anything, and only as far as
 *   `planProductDraftOverlayPublish` allows. The first in-page field save into one rewrites it as
 *   an overlay (`legacyProductDraftMetaAsOverlay`): that edit and every later one publish, and the
 *   snapshot fields the rewrite keeps are recorded in the overlay, so they still publish only while
 *   the product is unchanged since the snapshot was taken.
 * - `overlay`: what block edits and the in-page editor leave since 0.23.4: `{}` when the draft is
 *   created, then `title` / `short_description` / `description_json` as the editor saves them. One
 *   rewritten from a legacy snapshot also carries PRODUCT_DRAFT_LEGACY_FIELDS_KEY and
 *   PRODUCT_DRAFT_LEGACY_CREATED_AT_KEY, which no classification reads and no products write takes.
 *
 * Publishing any of them needs an ADMIN past the second factor (`requireCmsAdmin()`).
 * `product-values` goes through `updateProduct()`; the other two write the overlay fields only,
 * never a price, a variant or the schedule.
 *
 * Product values written since 0.23.4 carry PRODUCT_DRAFT_FORM_MARKER_KEY. Before that the edit page
 * showed a legacy row snapshot as form values (cents as dollars, no variants, gallery or
 * description), so the first autosave over one stored them as real product values, without an `id`:
 * `findPoisonedProductDraftFields` (app/cms/products/productFormData.ts) checks the unmarked ones.
 */

export type ProductDraftMetaKind = 'product-values' | 'legacy-row-snapshot' | 'overlay';

/**
 * The key and value every product-values meta written since 0.23.4 carries: the product form's
 * autosave (`saveProductDraftMeta` in libs/ecommerce, which keeps its own copy of the literal because
 * a 'use server' module exports only async functions) and a CMS import in draft mode
 * (lib/cms-transfer/server.ts). A product-values meta without it was written by an earlier version.
 * It never reaches updateProduct() or the products row (`withoutProductDraftFormMarker`).
 * product-draft-marker.test.ts pins the lib's literal to this one.
 */
export const PRODUCT_DRAFT_FORM_MARKER_KEY = 'form_version';
export const PRODUCT_DRAFT_FORM_MARKER_VALUE = 2;

/** Whether a meta was written by 0.23.4 or later (a later version may raise the value). */
export function hasProductDraftFormMarker(meta: unknown): boolean {
  if (!isRecord(meta)) {
    return false;
  }

  const value = meta[PRODUCT_DRAFT_FORM_MARKER_KEY];
  return typeof value === 'number' && value >= PRODUCT_DRAFT_FORM_MARKER_VALUE;
}

/** `meta` with the marker set: what a 0.23.4 writer of product values stores. */
export function withProductDraftFormMarker<T extends Record<string, unknown>>(meta: T): T & Record<string, unknown> {
  return { ...meta, [PRODUCT_DRAFT_FORM_MARKER_KEY]: PRODUCT_DRAFT_FORM_MARKER_VALUE };
}

/** `values` without the marker, for updateProduct() and the form. */
export function withoutProductDraftFormMarker<T extends Record<string, unknown>>(values: T): T {
  if (!hasOwn(values, PRODUCT_DRAFT_FORM_MARKER_KEY)) {
    return values;
  }

  const rest: Record<string, unknown> = { ...values };
  delete rest[PRODUCT_DRAFT_FORM_MARKER_KEY];
  return rest as T;
}

/** The product fields the in-page editor stages, and the only ones a non-pricing publish writes. */
export const PRODUCT_DRAFT_OVERLAY_FIELDS = ['title', 'short_description', 'description_json'] as const;

export type ProductDraftOverlayField = (typeof PRODUCT_DRAFT_OVERLAY_FIELDS)[number];

export interface ProductDraftOverlayValues {
  title?: string;
  short_description?: string | null;
  description_json?: object | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * The pre-0.23.4 seed: the `products` row itself. Its `id` is the signature (every version of the
 * seed selected it; the form and the import never write one), and it never had `variants`, which
 * both product-values writers always store.
 */
export function isLegacyProductRowSnapshot(meta: unknown): boolean {
  return isRecord(meta) && hasOwn(meta, 'id') && !Array.isArray(meta['variants']);
}

export function classifyProductDraftMeta(meta: unknown): ProductDraftMetaKind {
  if (!isRecord(meta)) {
    return 'overlay';
  }

  if (isLegacyProductRowSnapshot(meta)) {
    return 'legacy-row-snapshot';
  }

  if (typeof meta['sku'] === 'string' || typeof meta['price'] === 'number') {
    return 'product-values';
  }

  return 'overlay';
}

/**
 * The overlay fields a meta stages, normalized the way publish writes them: a title only when it
 * is a non-empty string (the in-page editor refuses an empty one), a short description as text or
 * null, a description as a JSON object or null. A field the meta does not have is left out.
 */
export function pickProductDraftOverlayValues(meta: unknown): ProductDraftOverlayValues {
  const overlay: ProductDraftOverlayValues = {};

  if (!isRecord(meta)) {
    return overlay;
  }

  const title = meta['title'];
  if (typeof title === 'string' && title.trim()) {
    overlay.title = title;
  }

  if (hasOwn(meta, 'short_description')) {
    const shortDescription = meta['short_description'];
    overlay.short_description = typeof shortDescription === 'string' ? shortDescription : null;
  }

  if (hasOwn(meta, 'description_json')) {
    const description = meta['description_json'];
    overlay.description_json = description !== null && typeof description === 'object' ? description : null;
  }

  return overlay;
}

/** Structural equality for JSON values (object key order ignored). */
export function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => jsonValuesEqual(item, right[index]))
    );
  }

  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined);
    const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => hasOwn(right, key) && jsonValuesEqual(left[key], right[key]))
    );
  }

  return false;
}

/**
 * The `products` update a non-pricing publish sends: the overlay fields the meta stages that differ
 * from the live row. Empty when nothing differs, so a block-only publish (or a legacy snapshot whose
 * title is still the live one) writes no product row at all and needs no right to update one.
 */
export function buildProductOverlayUpdate(
  meta: unknown,
  liveProduct: Partial<Record<ProductDraftOverlayField, unknown>>
): ProductDraftOverlayValues {
  const overlay = pickProductDraftOverlayValues(meta);
  const update: ProductDraftOverlayValues = {};

  for (const field of PRODUCT_DRAFT_OVERLAY_FIELDS) {
    if (!hasOwn(overlay as Record<string, unknown>, field)) {
      continue;
    }

    const value = overlay[field];
    if (!jsonValuesEqual(value, liveProduct[field] ?? null)) {
      (update as Record<string, unknown>)[field] = value;
    }
  }

  return update;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !value) {
    return null;
  }

  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/**
 * Whether the products row is unchanged since the draft was created: `products.updated_at` at or
 * before `product_drafts.created_at`. No trigger maintains products.updated_at. The app writes that
 * change a product's title, short description or description set it: the product RPC and
 * updateProduct's follow-up writes, Cortex's field update, a live CMS import, the data migrations
 * 02019 / 02020 / 02032, an overlay publish, and since 0.23.4 the Freemius sync's upsert (which
 * rewrites a synced product's title and short description), a revision restore, Copy from language
 * and Cortex's raw database tools (execute_database_mutation and execute_database_action_plan, on
 * every products update or upsert, whatever `updated_at` the call carries). A live CMS import, a
 * revision restore and Copy from language also delete the draft. A Freemius sync before 0.23.4 did
 * not set it, and neither does a write through the Data API or SQL: after one, a snapshot's old field
 * publishes over that write while the timestamp says unchanged (an old Freemius title until the next
 * sync rewrites it). A missing or unreadable timestamp counts as changed.
 */
export function isLiveProductUnchangedSinceDraft(liveUpdatedAt: unknown, draftCreatedAt: unknown): boolean {
  const updatedAt = parseTimestamp(liveUpdatedAt);
  const createdAt = parseTimestamp(draftCreatedAt);
  return updatedAt !== null && createdAt !== null && updatedAt <= createdAt;
}

/**
 * From this instant on, a legacy row snapshot's `description_json` can only be an in-page edit.
 * 3d6942f2 (2026-05-27) took the description out of the seed (readProductSnapshot's field list), and
 * no release seeded drafts before create-nextblock 0.8.11 (2026-06-11), whose seed already lacked
 * it: only deploys of master from 2026-05-21 to 2026-05-27 copied the description into a new draft.
 * The in-page editor saved one into a draft again from a86165d1 (2026-06-02).
 */
export const LEGACY_SNAPSHOT_DESCRIPTION_IN_PAGE_FROM = '2026-05-28T00:00:00Z';

/** Whether a legacy row snapshot created at `draftCreatedAt` holds a description only as an in-page edit. */
export function isLegacySnapshotDescriptionAnInPageEdit(draftCreatedAt: unknown): boolean {
  const createdAt = parseTimestamp(draftCreatedAt);
  return createdAt !== null && createdAt >= Date.parse(LEGACY_SNAPSHOT_DESCRIPTION_IN_PAGE_FROM);
}

/**
 * The keys an overlay rewritten from a legacy row snapshot (legacyProductDraftMetaAsOverlay) carries:
 * the snapshot fields it kept, which may be old copies of the products row, and the snapshot's
 * `product_drafts.created_at`, the instant the row must be unchanged since for them to publish.
 * Neither changes classifyProductDraftMeta's verdict, and neither is an overlay field, so no publish
 * writes them to the products row.
 */
export const PRODUCT_DRAFT_LEGACY_FIELDS_KEY = 'legacy_snapshot_fields';
export const PRODUCT_DRAFT_LEGACY_CREATED_AT_KEY = 'legacy_snapshot_created_at';

/** The overlay fields a meta records as kept from a legacy row snapshot (in their usual order). */
export function readRecordedLegacySnapshotFields(meta: unknown): ProductDraftOverlayField[] {
  if (!isRecord(meta)) {
    return [];
  }

  const recorded = meta[PRODUCT_DRAFT_LEGACY_FIELDS_KEY];
  return Array.isArray(recorded) ? PRODUCT_DRAFT_OVERLAY_FIELDS.filter((field) => recorded.includes(field)) : [];
}

/**
 * `meta` once `field` is an in-page edit again: out of the recorded snapshot fields, and both keys
 * gone with the last one. Unchanged when `field` is not recorded.
 */
export function withoutRecordedLegacySnapshotField<T extends Record<string, unknown>>(
  meta: T,
  field: ProductDraftOverlayField
): T {
  const recorded = readRecordedLegacySnapshotFields(meta);
  if (!recorded.includes(field)) {
    return meta;
  }

  const next: Record<string, unknown> = { ...meta };
  const remaining = recorded.filter((recordedField) => recordedField !== field);
  if (remaining.length > 0) {
    next[PRODUCT_DRAFT_LEGACY_FIELDS_KEY] = remaining;
  } else {
    delete next[PRODUCT_DRAFT_LEGACY_FIELDS_KEY];
    delete next[PRODUCT_DRAFT_LEGACY_CREATED_AT_KEY];
  }

  return next as T;
}

/**
 * The overlay fields of a meta that may be old copies of the products row, and the instant the row
 * must be unchanged since for them to publish: a legacy row snapshot's fields (its description only
 * in a draft created before LEGACY_SNAPSHOT_DESCRIPTION_IN_PAGE_FROM) since the draft was created,
 * and the fields an overlay recorded when it was rewritten from one, since the snapshot was created.
 * Nothing for any other meta: its overlay fields are in-page edits, and product values publish whole.
 */
function readSnapshotCopyFields(
  meta: unknown,
  draftCreatedAt: unknown
): { fields: ProductDraftOverlayField[]; since: unknown } {
  const kind = classifyProductDraftMeta(meta);

  if (kind === 'legacy-row-snapshot') {
    const descriptionIsInPageEdit = isLegacySnapshotDescriptionAnInPageEdit(draftCreatedAt);
    return {
      fields: PRODUCT_DRAFT_OVERLAY_FIELDS.filter((field) => field !== 'description_json' || !descriptionIsInPageEdit),
      since: draftCreatedAt,
    };
  }

  if (kind === 'overlay' && isRecord(meta)) {
    return { fields: readRecordedLegacySnapshotFields(meta), since: meta[PRODUCT_DRAFT_LEGACY_CREATED_AT_KEY] };
  }

  return { fields: [], since: null };
}

export interface ProductDraftOverlayPublishPlan {
  /** The products update publish sends (empty: no product row write). */
  update: ProductDraftOverlayValues;
  /**
   * Overlay fields that differ from the live row and are NOT written: a legacy snapshot's, or the
   * snapshot fields an overlay recorded, once the product changed after the snapshot was taken.
   */
  skipped: ProductDraftOverlayField[];
}

/**
 * What publishing an overlay or a legacy row snapshot writes to the products row; the edit page, the
 * storefront preview and the in-page editor show the same (lib/visual-editing/product-drafts.ts,
 * app/cms/products/productFormData.ts).
 *
 * An overlay's fields are the editor's own in-page edits: written where they differ. A legacy
 * snapshot's title and short description are the products row as it was when a block edit created
 * the draft, unless the in-page editor changed them since, and the two cannot be told apart. So they
 * are written only while the live row is unchanged since the draft was created; otherwise publish
 * skips them (and says which), so a later change by a migration, Cortex or the product form is not
 * silently reverted. Its description follows the same rule in a draft created before 2026-05-28,
 * which may hold the seed's copy, and is an in-page edit, written where it differs, in a later one
 * (isLegacySnapshotDescriptionAnInPageEdit). The snapshot fields an overlay recorded when an in-page
 * save rewrote a snapshot (legacyProductDraftMetaAsOverlay) keep that rule, against the snapshot's
 * creation time the overlay records.
 */
export function planProductDraftOverlayPublish(
  meta: unknown,
  liveProduct: Partial<Record<ProductDraftOverlayField | 'updated_at', unknown>>,
  draftCreatedAt: unknown
): ProductDraftOverlayPublishPlan {
  const update = buildProductOverlayUpdate(meta, liveProduct);
  const copies = readSnapshotCopyFields(meta, draftCreatedAt);

  if (copies.fields.length === 0 || isLiveProductUnchangedSinceDraft(liveProduct.updated_at, copies.since)) {
    return { update, skipped: [] };
  }

  const written: ProductDraftOverlayValues = {};
  const skipped: ProductDraftOverlayField[] = [];
  for (const field of PRODUCT_DRAFT_OVERLAY_FIELDS) {
    if (!hasOwn(update as Record<string, unknown>, field)) {
      continue;
    }

    if (copies.fields.includes(field)) {
      skipped.push(field);
    } else {
      (written as Record<string, unknown>)[field] = update[field];
    }
  }

  return { update: written, skipped };
}

/**
 * The overlay a legacy row snapshot becomes when the in-page editor saves `savedField` into it: the
 * overlay fields publishing it would write now (planProductDraftOverlayPublish), before the edited
 * field is laid over them. Kept as `{ ...meta, [field]: value }`, the draft stayed a legacy snapshot,
 * so once the live row changed publish skipped that edit too, and editing again changed nothing.
 *
 * While the live row is unchanged since the draft was created (as far as `updated_at` tells:
 * isLiveProductUnchangedSinceDraft), a snapshot field that differs is an in-page edit made into the
 * draft, or an old copy that a write which leaves `updated_at` alone overwrote since. It is kept and
 * recorded (PRODUCT_DRAFT_LEGACY_FIELDS_KEY, with the snapshot's created_at), so publish, the preview
 * and the in-page editor keep applying the rule to it: written while the row stays unchanged,
 * skipped with publish's warning once it changed. `savedField` is not recorded, nor a description
 * that is an in-page edit (isLegacySnapshotDescriptionAnInPageEdit): those publish whenever, like any
 * overlay field. Once the row changed, the snapshot fields are dropped (publish would skip them). The
 * result has no `id`, so it is classified `overlay` from then on, and the snapshot's prices, slug and
 * other columns leave the draft.
 */
export function legacyProductDraftMetaAsOverlay(
  meta: unknown,
  liveProduct: Partial<Record<ProductDraftOverlayField | 'updated_at', unknown>>,
  draftCreatedAt: unknown,
  savedField?: ProductDraftOverlayField
): Record<string, unknown> {
  const { update } = planProductDraftOverlayPublish(meta, liveProduct, draftCreatedAt);
  const overlay: Record<string, unknown> = { ...update };
  const kept = readSnapshotCopyFields(meta, draftCreatedAt).fields.filter(
    (field) => field !== savedField && hasOwn(overlay, field)
  );

  // A kept copy means the rule held, so `draftCreatedAt` is a readable timestamp.
  if (kept.length > 0 && typeof draftCreatedAt === 'string') {
    overlay[PRODUCT_DRAFT_LEGACY_FIELDS_KEY] = kept;
    overlay[PRODUCT_DRAFT_LEGACY_CREATED_AT_KEY] = draftCreatedAt;
  }

  return overlay;
}

/**
 * The overlay fields a draft shows in the storefront's draft preview and in the in-page editor, to be
 * laid over the live product: what publishing it would write (planProductDraftOverlayPublish), so a
 * field publish would skip shows its live value. A legacy row snapshot shows only the fields publish
 * would write; any other meta shows the overlay fields it stages, as it stages them (product values
 * included), but a recorded snapshot field publish would skip.
 */
export function resolveProductDraftOverlayDisplay(
  meta: unknown,
  liveProduct: Partial<Record<ProductDraftOverlayField | 'updated_at', unknown>>,
  draftCreatedAt: unknown
): Partial<Record<ProductDraftOverlayField, unknown>> {
  const plan = planProductDraftOverlayPublish(meta, liveProduct, draftCreatedAt);

  if (classifyProductDraftMeta(meta) === 'legacy-row-snapshot') {
    return { ...plan.update };
  }

  const staged: Partial<Record<ProductDraftOverlayField, unknown>> = {};
  if (isRecord(meta)) {
    for (const field of PRODUCT_DRAFT_OVERLAY_FIELDS) {
      if (hasOwn(meta, field) && !plan.skipped.includes(field)) {
        staged[field] = meta[field];
      }
    }
  }

  return staged;
}

const OVERLAY_FIELD_LABELS: Record<ProductDraftOverlayField, string> = {
  title: 'title',
  short_description: 'short description',
  description_json: 'description',
};

/** "title", "title and description", "title, short description and description". */
export function joinProductFieldLabels(labels: readonly string[]): string {
  if (labels.length <= 1) {
    return labels[0] ?? '';
  }

  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/** "title", "title and description": the overlay fields by the names the messages use. */
export function describeProductDraftOverlayFields(fields: readonly ProductDraftOverlayField[]): string {
  return joinProductFieldLabels(fields.map((field) => OVERLAY_FIELD_LABELS[field]));
}

/**
 * What the CMS draft bar, the CMS visibility control and the storefront toolbar say beside a disabled
 * Publish on a product draft for anyone but an ADMIN (the server-derived flag they are given). Publish
 * itself refuses anyone else (`requireCmsAdmin()` in lib/visual-editing/product-drafts.ts), whatever
 * the page showed.
 */
export const PRODUCT_PUBLISH_ADMIN_ONLY_NOTE = 'An administrator publishes product changes.';

/**
 * What publishing a draft answers when there is none any more (a revision restore, or a publish or
 * discard in another tab, while the page still offered it): a product's from
 * lib/visual-editing/product-drafts.ts, a page's or post's from app/actions/visualEditingActions.ts.
 * The CMS visibility dialog then publishes no edits and goes on with the visibility change.
 */
export const NO_PRODUCT_DRAFT_ERROR = 'No draft exists for this product.';
export const NO_CONTENT_DRAFT_ERROR = 'No draft exists for this content.';

/**
 * The warning a publish that skipped a legacy snapshot's overlay fields (or the snapshot fields an
 * overlay recorded) returns; `written` names the overlay fields the same publish did write (an in-page
 * edit beside them). Publish then removes the draft, so an edit made afterwards starts a new one, which
 * publishes it: an in-page edit lands in an overlay, a product form edit in product values.
 */
export function describeSkippedProductDraftOverlay(
  skipped: readonly ProductDraftOverlayField[],
  written: readonly ProductDraftOverlayField[] = []
): string {
  const fields = describeProductDraftOverlayFields(skipped);
  const plural = skipped.length > 1;
  const published =
    written.length > 0
      ? `Published the description blocks and the draft's ${describeProductDraftOverlayFields(written)}.`
      : 'Published the description blocks only.';
  return `${published} This draft was created before NextBlock 0.23.4 and the product changed after that, so the draft's ${fields} ${plural ? 'were' : 'was'} not published: ${plural ? 'they differ' : 'it differs'} from the live product and may be an old copy that would undo the newer change. Edit the ${fields} again if you still want the draft's version.`;
}

/**
 * The edit page's note for the same draft. Editing the fields again works from either side: an in-page
 * save makes them in-page edits (legacyProductDraftMetaAsOverlay, withoutRecordedLegacySnapshotField),
 * and once the product form saves into the draft (its autosave), the draft holds product values, which
 * publish writes in full.
 */
export function describeSkippedProductDraftOverlayNotice(skipped: readonly ProductDraftOverlayField[]): string {
  const fields = describeProductDraftOverlayFields(skipped);
  return `This draft was created before NextBlock 0.23.4 and the product changed after that, so publishing it leaves the live ${fields} in place: the draft's version differs from the live product and may be an old copy that would undo the newer change. The form shows the live ${fields}; edit ${skipped.length > 1 ? 'them' : 'it'} again if you still want the draft's version. Once the form saves into the draft (a change to any field autosaves it), publishing writes the form's values as well.`;
}
