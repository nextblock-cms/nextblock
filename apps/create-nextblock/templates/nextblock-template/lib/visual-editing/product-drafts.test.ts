import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath,
}));
vi.mock("@nextblock-cms/db/server", () => ({
  createClient: mocks.createClient,
  getServiceRoleSupabaseClient: vi.fn(),
  getSsgSupabaseClient: vi.fn(),
}));

import {
  applyProductDraftToProductRecord,
  assertValidProductFieldRequest,
  getOrCreateProductDraft,
  loadProductVisualEditingField,
  saveProductVisualEditingDraftMutation,
} from "./product-drafts";
import { classifyProductDraftMeta, planProductDraftOverlayPublish } from "./product-draft-meta";
import { saveVisualEditingBlockDraftMutation } from "./mutations";
import type { VisualEditingBlockRequest, VisualEditingProductFieldRequest } from "./types";

const productId = "123e4567-e89b-12d3-a456-426614174000";

const LIVE_BLOCK = {
  id: 5,
  page_id: null,
  post_id: null,
  product_id: productId,
  language_id: 1,
  block_type: "text",
  content: { html_content: "<p>Live block</p>" },
  order: 0,
};

const LIVE_PRODUCT_ROW = {
  id: productId,
  slug: "pro-plugin",
  title: "Pro plugin",
  short_description: "Live short copy",
  description_json: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Live" }] }] },
  price: 4900,
  prices: { USD: 4900 },
};

/**
 * A cookie-client stand-in: `draft` is the product_drafts row (null for none), the products row is
 * LIVE_PRODUCT_ROW (or `live` laid over it), the blocks are [LIVE_BLOCK]. Inserts and updates of
 * product_drafts echo the row and are kept, so a second save reads what the first wrote.
 */
function makeClient(draft: Record<string, unknown> | null, live: Record<string, unknown> = {}) {
  const writes: Array<[string, string, unknown]> = [];
  const productRow: Record<string, unknown> = { ...LIVE_PRODUCT_ROW, ...live };
  let draftRow = draft;
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "writer-1" } }, error: null }) },
    from: (table: string) => {
      let op = "select";
      let values: Record<string, unknown> = {};
      let columns = "*";
      const chain: Record<string, unknown> = {};
      const result = () => {
        if (table === "profiles") return { data: { role: "WRITER" }, error: null };
        if (table === "product_drafts") {
          if (op === "insert") {
            draftRow = { id: 9, created_at: "", updated_at: "", ...values };
            return { data: draftRow, error: null };
          }
          if (op === "update") {
            draftRow = { ...(draftRow ?? {}), ...values };
            return { data: draftRow, error: null };
          }
          return { data: draftRow, error: null };
        }
        if (table === "products") {
          // Only the selected columns, as PostgREST answers.
          if (columns === "*") return { data: productRow, error: null };
          const picked = Object.fromEntries(
            columns
              .split(",")
              .map((column) => column.trim())
              .filter((column) => column in productRow)
              .map((column) => [column, productRow[column]])
          );
          return { data: picked, error: null };
        }
        if (table === "blocks") return { data: [LIVE_BLOCK], error: null };
        return { data: null, error: null };
      };
      chain.select = (selected?: string) => {
        if (op === "select" && typeof selected === "string") columns = selected;
        return chain;
      };
      chain.eq = () => chain;
      chain.order = () => chain;
      chain.single = async () => result();
      chain.maybeSingle = async () => result();
      for (const name of ["insert", "update"]) {
        chain[name] = (next: Record<string, unknown>) => {
          op = name;
          values = next;
          writes.push([name, table, next]);
          return chain;
        };
      }
      chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(result()).then(resolve, reject);
      return chain;
    },
  };
  return { client, writes };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a new product draft stages no product row", () => {
  it("seeds meta with {} (the in-page overlay) and the blocks from the live rows", async () => {
    const { client, writes } = makeClient(null);

    const draft = await getOrCreateProductDraft(client as any, productId, "writer-1");

    // Until 0.23.4 meta was the raw products row (cents, an id, no variants), which publish then
    // handed updateProduct() as form values.
    expect(writes).toEqual([
      [
        "insert",
        "product_drafts",
        {
          product_id: productId,
          author_id: "writer-1",
          meta: {},
          blocks: [expect.objectContaining({ id: 5, block_type: "text", content: LIVE_BLOCK.content })],
        },
      ],
    ]);
    expect(draft.meta).toEqual({});
    expect(draft.blocks).toHaveLength(1);
  });

  it("returns an existing draft untouched", async () => {
    const existing = { id: 3, product_id: productId, author_id: "writer-1", meta: { title: "Draft" }, blocks: [] };
    const { client, writes } = makeClient(existing);

    const draft = await getOrCreateProductDraft(client as any, productId, "writer-1");

    expect(writes).toEqual([]);
    expect(draft.meta).toEqual({ title: "Draft" });
  });

  it("keeps the overlay an overlay when the in-page editor saves a field into a new draft", async () => {
    const { client, writes } = makeClient(null);
    mocks.createClient.mockReturnValue(client);

    const result = await saveProductVisualEditingDraftMutation(
      {
        parentType: "product",
        parentId: productId,
        target: { kind: "product-field", field: "title", input: "plain-text", label: "Product title" },
      },
      "Renamed"
    );

    expect(result).toEqual({ success: true });
    expect(writes.at(-1)).toEqual(["update", "product_drafts", { author_id: "writer-1", meta: { title: "Renamed" } }]);
    // The overlay carries no slug: the public path comes from the live row.
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/product/pro-plugin");
  });
});

describe("saving a description block into a product draft", () => {
  const blockRequest: VisualEditingBlockRequest = {
    parentType: "product",
    parentId: productId,
    target: { kind: "top-level", blockId: 5, blockIndex: 0, blockType: "text" },
  };

  it("revalidates the live product page: a draft created since 0.23.4 carries no slug", async () => {
    const { client, writes } = makeClient(null);
    mocks.createClient.mockReturnValue(client);

    await expect(saveVisualEditingBlockDraftMutation(blockRequest, { html_content: "<p>Edited</p>" })).resolves.toEqual({
      success: true,
    });

    expect(writes.at(-1)).toEqual([
      "update",
      "product_drafts",
      {
        author_id: "writer-1",
        blocks: [expect.objectContaining({ id: 5, content: { html_content: "<p>Edited</p>" } })],
      },
    ]);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/product/pro-plugin");
  });

  it("revalidates the live slug, not a slug the draft carries", async () => {
    // A pre-0.23.4 row snapshot keeps the slug it was seeded with, here renamed live since.
    const { client } = makeClient({
      id: 3,
      product_id: productId,
      meta: { id: productId, slug: "old-slug", sku: "PRO", price: 4900 },
      blocks: [LIVE_BLOCK],
    });
    mocks.createClient.mockReturnValue(client);

    await expect(saveVisualEditingBlockDraftMutation(blockRequest, { html_content: "<p>Edited</p>" })).resolves.toEqual({
      success: true,
    });

    expect(mocks.revalidatePath.mock.calls).toEqual([["/product/pro-plugin"]]);
  });
});

describe("loading an in-page product field", () => {
  const descriptionRequest: VisualEditingProductFieldRequest = {
    parentType: "product",
    parentId: productId,
    target: { kind: "product-field", field: "description_json", input: "tiptap", label: "Product description" },
  };

  it("reads the live value when the draft does not stage the field", async () => {
    // A block-seeded draft, and a pre-0.23.4 row snapshot (it never carried description_json): the
    // editor used to open empty for both, and saving replaced the live description.
    for (const meta of [{}, { id: productId, sku: "PRO", price: 4900, title: "Pro plugin" }]) {
      const { client } = makeClient({ id: 3, product_id: productId, meta, blocks: [] });
      mocks.createClient.mockReturnValue(client);

      await expect(loadProductVisualEditingField(descriptionRequest)).resolves.toEqual({
        success: true,
        content: LIVE_PRODUCT_ROW.description_json,
        draftId: 3,
      });
    }
  });

  it("reads the live value when no draft exists", async () => {
    const { client } = makeClient(null);
    mocks.createClient.mockReturnValue(client);

    await expect(loadProductVisualEditingField(descriptionRequest)).resolves.toEqual({
      success: true,
      content: LIVE_PRODUCT_ROW.description_json,
      draftId: null,
    });
  });

  it("reads the draft's value when the draft stages the field, null included", async () => {
    const staged = { type: "doc", content: [] };
    const { client } = makeClient({ id: 3, product_id: productId, meta: { description_json: staged }, blocks: [] });
    mocks.createClient.mockReturnValue(client);

    await expect(loadProductVisualEditingField(descriptionRequest)).resolves.toMatchObject({ content: staged });

    const cleared = makeClient({ id: 3, product_id: productId, meta: { description_json: null }, blocks: [] });
    mocks.createClient.mockReturnValue(cleared.client);
    await expect(loadProductVisualEditingField(descriptionRequest)).resolves.toMatchObject({ content: null });
  });
});

/**
 * A pre-0.23.4 row snapshot: a block edit created the draft on June 2 with the products row as meta
 * (an id, cents, no variants). Its title differs from the live one: an in-page edit made into the
 * draft while the product was unchanged, or an old copy once the product changed after June 2.
 */
const LEGACY_DRAFT_CREATED_AT = "2026-06-02T09:00:00+00:00";
const LEGACY_DRAFT = {
  id: 3,
  product_id: productId,
  author_id: "writer-1",
  meta: {
    id: productId,
    title: "Pro plugin (June copy)",
    slug: "pro-plugin",
    sku: "PRO",
    price: 4900,
    short_description: "Live short copy",
  },
  blocks: [],
  created_at: LEGACY_DRAFT_CREATED_AT,
  updated_at: LEGACY_DRAFT_CREATED_AT,
};
/** products.updated_at after the draft was created (a visibility change, Cortex, a migration...). */
const CHANGED_SINCE = { updated_at: "2026-11-10T10:00:00+00:00" };
/** products.updated_at before it: the row is unchanged since the snapshot was taken. */
const UNCHANGED_SINCE = { updated_at: "2026-06-01T10:00:00+00:00" };

const titleRequest: VisualEditingProductFieldRequest = {
  parentType: "product",
  parentId: productId,
  target: { kind: "product-field", field: "title", input: "plain-text", label: "Product title" },
};
const shortDescriptionRequest: VisualEditingProductFieldRequest = {
  parentType: "product",
  parentId: productId,
  target: { kind: "product-field", field: "short_description", input: "plain-text", label: "Short description" },
};

/** The meta the last product_drafts update wrote. */
function lastSavedMeta(writes: Array<[string, string, unknown]>) {
  const write = [...writes].reverse().find(([op, table]) => op === "update" && table === "product_drafts");
  return (write?.[2] as { meta: Record<string, unknown> } | undefined)?.meta;
}

describe("in-page edits into a pre-0.23.4 row snapshot", () => {
  it("probe A: rewrites the snapshot as an overlay, so the edit publishes once the product changed, and so does the next one", async () => {
    const { client, writes } = makeClient(structuredClone(LEGACY_DRAFT), CHANGED_SINCE);
    mocks.createClient.mockReturnValue(client);
    const live = { ...LIVE_PRODUCT_ROW, ...CHANGED_SINCE };

    await expect(saveProductVisualEditingDraftMutation(titleRequest, "Pro plugin 2")).resolves.toEqual({ success: true });

    // Kept as `{ ...meta, title }` it stayed a snapshot, and publish skipped the edit with the rest.
    const firstMeta = lastSavedMeta(writes);
    expect(firstMeta).toEqual({ title: "Pro plugin 2" });
    expect(classifyProductDraftMeta(firstMeta)).toBe("overlay");
    expect(planProductDraftOverlayPublish(firstMeta, live, LEGACY_DRAFT_CREATED_AT)).toEqual({
      update: { title: "Pro plugin 2" },
      skipped: [],
    });

    await expect(saveProductVisualEditingDraftMutation(shortDescriptionRequest, "New short copy")).resolves.toEqual({
      success: true,
    });

    const secondMeta = lastSavedMeta(writes);
    expect(secondMeta).toEqual({ title: "Pro plugin 2", short_description: "New short copy" });
    expect(planProductDraftOverlayPublish(secondMeta, live, LEGACY_DRAFT_CREATED_AT)).toEqual({
      update: { title: "Pro plugin 2", short_description: "New short copy" },
      skipped: [],
    });
    // The snapshot's slug left with it: only the live product page is revalidated.
    expect(mocks.revalidatePath.mock.calls).toEqual([["/product/pro-plugin"], ["/product/pro-plugin"]]);
  });

  it("keeps an in-page edit the snapshot already held while the product is unchanged since the draft was created", async () => {
    const { client, writes } = makeClient(structuredClone(LEGACY_DRAFT), UNCHANGED_SINCE);
    mocks.createClient.mockReturnValue(client);

    await expect(saveProductVisualEditingDraftMutation(shortDescriptionRequest, "New short copy")).resolves.toEqual({
      success: true,
    });

    // The title publish would have written anyway, recorded as a snapshot field so it keeps the rule
    // (verify round 6, probe L1); the prices, sku, slug and id are gone.
    expect(lastSavedMeta(writes)).toEqual({
      title: "Pro plugin (June copy)",
      legacy_snapshot_fields: ["title"],
      legacy_snapshot_created_at: LEGACY_DRAFT_CREATED_AT,
      short_description: "New short copy",
    });
  });

  it("takes a recorded snapshot field out of the list when the editor saves that field again", async () => {
    const converted = {
      ...LEGACY_DRAFT,
      meta: {
        title: "Pro plugin (June copy)",
        short_description: "New short copy",
        legacy_snapshot_fields: ["title"],
        legacy_snapshot_created_at: LEGACY_DRAFT_CREATED_AT,
      },
    };
    const { client, writes } = makeClient(structuredClone(converted), CHANGED_SINCE);
    mocks.createClient.mockReturnValue(client);

    await expect(saveProductVisualEditingDraftMutation(titleRequest, "Pro plugin 3")).resolves.toEqual({ success: true });

    // An in-page edit now, so it publishes whatever happened to the product since.
    const meta = lastSavedMeta(writes);
    expect(meta).toEqual({ title: "Pro plugin 3", short_description: "New short copy" });
    expect(planProductDraftOverlayPublish(meta, { ...LIVE_PRODUCT_ROW, ...CHANGED_SINCE }, LEGACY_DRAFT_CREATED_AT)).toEqual({
      update: { title: "Pro plugin 3", short_description: "New short copy" },
      skipped: [],
    });
  });

  it("loads the live title into the editor when publish would skip the snapshot's (the product changed since)", async () => {
    const { client } = makeClient(structuredClone(LEGACY_DRAFT), CHANGED_SINCE);
    mocks.createClient.mockReturnValue(client);

    await expect(loadProductVisualEditingField(titleRequest)).resolves.toEqual({
      success: true,
      content: LIVE_PRODUCT_ROW.title,
      draftId: 3,
    });
  });

  it("loads the snapshot's title while the product is unchanged since the draft was created: publish would write it", async () => {
    const { client } = makeClient(structuredClone(LEGACY_DRAFT), UNCHANGED_SINCE);
    mocks.createClient.mockReturnValue(client);

    await expect(loadProductVisualEditingField(titleRequest)).resolves.toEqual({
      success: true,
      content: "Pro plugin (June copy)",
      draftId: 3,
    });
  });

  it("previews what publish would write: the live title after a live change, the snapshot's before it", () => {
    const draft = structuredClone(LEGACY_DRAFT);
    const liveProduct = { ...LIVE_PRODUCT_ROW, ...CHANGED_SINCE };

    expect(applyProductDraftToProductRecord(liveProduct, draft)).toEqual(liveProduct);
    expect(applyProductDraftToProductRecord({ ...LIVE_PRODUCT_ROW, ...UNCHANGED_SINCE }, draft)).toMatchObject({
      title: "Pro plugin (June copy)",
      price: 4900,
      prices: { USD: 4900 },
    });
    // No updated_at to compare: counted as changed, so the live values show.
    expect(applyProductDraftToProductRecord(LIVE_PRODUCT_ROW, draft)).toEqual(LIVE_PRODUCT_ROW);
  });
});

describe("product visual editing drafts", () => {
  it("validates product field draft targets", () => {
    const request: VisualEditingProductFieldRequest = {
      parentType: "product",
      parentId: productId,
      target: {
        kind: "product-field",
        field: "description_json",
        input: "tiptap",
        label: "Product description",
      },
    };

    expect(() => assertValidProductFieldRequest(request)).not.toThrow();
  });

  it("rejects product title targets that use the wrong editor input", () => {
    const request: VisualEditingProductFieldRequest = {
      parentType: "product",
      parentId: productId,
      target: {
        kind: "product-field",
        field: "title",
        input: "tiptap",
        label: "Product title",
      },
    };

    expect(() => assertValidProductFieldRequest(request)).toThrow(
      "Invalid product field editor."
    );
  });

  it("overlays visible storefront product fields from a draft snapshot", () => {
    const product = {
      id: productId,
      title: "Published title",
      slug: "published-product",
      short_description: "Published short copy",
      description_json: { type: "doc", content: [] },
      price: 100,
    };
    const draft = {
      id: 1,
      product_id: productId,
      author_id: "user-1",
      meta: {
        title: "Draft title",
        short_description: "Draft short copy",
      },
      blocks: [],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };

    expect(applyProductDraftToProductRecord(product, draft)).toMatchObject({
      title: "Draft title",
      short_description: "Draft short copy",
      price: 100,
    });
  });
});
