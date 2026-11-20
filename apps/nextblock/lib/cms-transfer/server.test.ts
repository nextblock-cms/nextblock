import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A CMS import in "draft" apply mode stores each product's values in its product_drafts row (major
 * units, variants always set), stamped as written by 0.23.4 or later: the edit page and publish check
 * only unstamped product values for the fields the pre-0.23.4 edit page poisoned (prices x100, no
 * variants, gallery or description), so an imported draft publishes the file's values as they are.
 */

const PRODUCT_ID = "123e4567-e89b-12d3-a456-426614174000";
const GROUP_ID = "523e4567-e89b-12d3-a456-426614174000";

const mocks = vi.hoisted(() => ({
  writes: [] as Array<[string, string, any]>,
}));

/** The service-role client the import runs with: the reads it makes, and its writes recorded. */
function makeServiceClient() {
  return {
    from: (table: string) => {
      let op = "select";
      let page: [number, number] | null = null;
      const query: Record<string, unknown> = {};
      const allRows = () => {
        if (table === "languages") return [{ id: 1, code: "en", name: "English" }];
        if (table === "products") {
          return [
            {
              id: PRODUCT_ID,
              language_id: 1,
              slug: "pro-plugin",
              sku: "PRO",
              title: "Pro plugin",
              status: "active",
              translation_group_id: GROUP_ID,
            },
          ];
        }
        return [];
      };
      // A paged read (`.range()`, the media map) gets its page; anything else every row.
      const rows = () => (page ? allRows().slice(page[0], page[1] + 1) : allRows());
      for (const method of ["select", "eq", "order", "in"]) query[method] = () => query;
      query.range = (from: number, to: number) => {
        page = [from, to];
        return query;
      };
      for (const method of ["insert", "update", "upsert", "delete"]) {
        query[method] = (values: unknown) => {
          op = method;
          mocks.writes.push([method, table, values]);
          return query;
        };
      }
      query.single = async () => ({ data: null, error: null });
      query.maybeSingle = query.single;
      query.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(op === "select" ? { data: rows(), error: null } : { data: null, error: null }).then(
          resolve,
          reject
        );
      return query;
    },
  };
}

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("../auth/cms-actor", () => ({
  getCmsActor: async () => ({ userId: "admin-1", role: "ADMIN" }),
}));
vi.mock("@nextblock-cms/db/server", () => ({
  getServiceRoleSupabaseClient: () => makeServiceClient(),
  verifyPackageOnline: async () => true,
}));
vi.mock("@nextblock-cms/ecommerce/server", () => ({ syncCategoriesForTranslationGroup: vi.fn() }));
vi.mock("../public-content-cache", () => ({ revalidatePublicContent: vi.fn() }));
vi.mock("../custom-block-definitions", () => ({
  CUSTOM_BLOCK_DEFINITIONS_CACHE_TAG: "custom-block-definitions",
  getCustomBlockDefinitionCacheTag: (slug: string) => `custom-block-definition:${slug}`,
}));
vi.mock("../../app/cms/revisions/service", () => ({
  createPageRevision: vi.fn(),
  createPostRevision: vi.fn(),
  createProductRevision: vi.fn(),
}));
vi.mock("../../app/cms/revisions/utils", () => ({
  getFullPageContent: vi.fn(),
  getFullPostContent: vi.fn(),
  getFullProductContent: vi.fn(),
}));

import { applyCsvImport } from "./server";
import { PRODUCT_CSV_HEADERS, stringifyCsv } from "./csv";
import {
  PRODUCT_DRAFT_FORM_MARKER_KEY,
  PRODUCT_DRAFT_FORM_MARKER_VALUE,
  classifyProductDraftMeta,
  hasProductDraftFormMarker,
} from "../visual-editing/product-draft-meta";
import { findPoisonedProductDraftFields } from "../../app/cms/products/productFormData";

beforeEach(() => {
  mocks.writes = [];
});

describe("a CMS product import in draft mode", () => {
  it("stores the file's values in the product draft, stamped as written by 0.23.4", async () => {
    const csv = stringifyCsv(
      [
        {
          language_code: "en",
          product_type: "physical",
          payment_provider: "stripe",
          title: "Pro plugin",
          slug: "pro-plugin",
          sku: "PRO",
          status: "active",
          price: "49",
          prices_json: JSON.stringify({ USD: 49 }),
          stock: "9",
        },
      ],
      PRODUCT_CSV_HEADERS
    );

    const summary = await applyCsvImport({
      contentType: "products",
      csv,
      options: { applyMode: "draft", conflictMode: "overwrite_existing" },
    });

    expect(summary.errors).toEqual([]);
    const upserts = mocks.writes.filter(([op, table]) => op === "upsert" && table === "product_drafts");
    expect(upserts).toHaveLength(1);
    const meta = upserts[0][2].meta;
    expect(upserts[0][2].product_id).toBe(PRODUCT_ID);
    expect(meta).toMatchObject({ sku: "PRO", price: 49, prices: { USD: 49 }, variants: [], product_media: [] });
    expect(meta[PRODUCT_DRAFT_FORM_MARKER_KEY]).toBe(PRODUCT_DRAFT_FORM_MARKER_VALUE);
    expect(hasProductDraftFormMarker(meta)).toBe(true);
    expect(classifyProductDraftMeta(meta)).toBe("product-values");
    // A price equal to the live minor amount, an emptied gallery and variants: the file's values,
    // never mistaken for the old editor's.
    expect(
      findPoisonedProductDraftFields(meta, {
        price: 49,
        prices: { USD: 49 },
        product_type: "physical",
        product_media: [{ media_id: "media-1" }],
        product_variants: [{ id: "variant-1" }],
      })
    ).toEqual([]);
    // Draft mode writes nothing live.
    expect(mocks.writes.filter(([, table]) => table === "products")).toEqual([]);
  });
});
