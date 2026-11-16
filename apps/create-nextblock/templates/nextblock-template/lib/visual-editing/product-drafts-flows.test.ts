import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Product drafts end to end: the real in-page save, field load, storefront preview and publish over a
 * small in-memory database (products, product_drafts, blocks, profiles) that answers the supabase-js
 * chains they use, so each flow is one sequence of real calls. These pin what the verify round 6
 * probes found (verify-P6C: D, L1, L2, R1; the integration walk: R1, R2) and the round 7 ones
 * (verify-P7C: VP-B, VP-E, VP-F, VP-J, VP-Q, V8).
 */

type Row = Record<string, any>;

const db = vi.hoisted(() => ({
  tables: { products: [] as Row[], product_drafts: [] as Row[], blocks: [] as Row[], profiles: [] as Row[] },
  nextId: 100,
  userId: 'admin-1',
  /** getFullProductContent's calls wait on these in turn while `gateEnabled` (the overlap flows). */
  gates: [] as Array<Promise<void>>,
  gateCalls: 0,
  gateEnabled: false,
  /** Each blocks DELETE in turn waits on its entry, when it has one (the overlap flows). */
  deleteGates: [] as Array<Promise<void> | undefined>,
  blocksDeleteCalls: 0,
  /** Seconds past 2026-11-14T12:00Z: each product_drafts UPDATE stamps the next one as its updated_at. */
  clock: 0,
  /** When set, getProduct() answers this error: the live read failing. */
  getProductError: null as string | null,
  getProduct: vi.fn(),
  updateProduct: vi.fn(),
  syncProductSaleCouponToFreemius: vi.fn(),
  createProductRevision: vi.fn(),
  revalidatePath: vi.fn(),
}));

const clone = <T>(value: T): T => structuredClone(value);

function matches(row: Row, filters: Array<[string, 'eq' | 'in', unknown]>) {
  return filters.every(([column, op, value]) =>
    op === 'eq' ? String(row[column]) === String(value) : (value as unknown[]).map(String).includes(String(row[column]))
  );
}

function project(row: Row, columns: string) {
  if (columns.trim() === '*') return clone(row);
  const picked: Row = {};
  for (const column of columns.split(',').map((name) => name.trim())) {
    if (column in row) picked[column] = clone(row[column]);
  }
  return picked;
}

function makeClient() {
  return {
    auth: { getUser: async () => ({ data: { user: db.userId ? { id: db.userId } : null }, error: null }) },
    from(table: keyof typeof db.tables) {
      let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
      let values: any = null;
      let columns = '*';
      let returning = false;
      let orderBy: string | null = null;
      let range: [number, number] | null = null;
      const filters: Array<[string, 'eq' | 'in', unknown]> = [];

      const run = () => {
        const rows = db.tables[table];
        if (op === 'select') {
          let found = rows.filter((row) => matches(row, filters));
          if (orderBy) {
            const key = orderBy;
            found = [...found].sort((a, b) => (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0));
          }
          if (range) found = found.slice(range[0], range[1] + 1);
          return { data: found.map((row) => project(row, columns)), error: null };
        }
        if (op === 'insert') {
          const now = new Date().toISOString();
          const inserted = (Array.isArray(values) ? values : [values]).map((value: Row) => ({
            id: db.nextId++,
            created_at: now,
            updated_at: now,
            ...clone(value),
          }));
          rows.push(...inserted);
          return { data: returning ? inserted.map((row) => project(row, columns)) : null, error: null };
        }
        if (op === 'update') {
          const found = rows.filter((row) => matches(row, filters));
          for (const row of found) {
            Object.assign(row, clone(values));
            // on_product_drafts_update (02003): BEFORE UPDATE sets updated_at to now(), whatever the write says.
            if (table === 'product_drafts') {
              db.clock += 1;
              row.updated_at = new Date(Date.UTC(2026, 10, 14, 12, 0, db.clock)).toISOString();
            }
          }
          return { data: returning ? found.map((row) => project(row, columns)) : null, error: null };
        }
        const removed = rows.filter((row) => matches(row, filters));
        db.tables[table] = rows.filter((row) => !removed.includes(row));
        return { data: returning ? removed.map((row) => project(row, columns)) : null, error: null };
      };

      const chain: any = {
        select(selected = '*') {
          columns = selected;
          // After a write, select() asks for the written rows back, as supabase-js does.
          if (op !== 'select') returning = true;
          return chain;
        },
        insert(next: unknown) {
          op = 'insert';
          values = next;
          return chain;
        },
        update(next: unknown) {
          op = 'update';
          values = next;
          return chain;
        },
        delete() {
          op = 'delete';
          return chain;
        },
        eq(column: string, value: unknown) {
          filters.push([column, 'eq', value]);
          return chain;
        },
        in(column: string, list: unknown[]) {
          filters.push([column, 'in', list]);
          return chain;
        },
        order(column: string) {
          orderBy = column;
          return chain;
        },
        range(from: number, to: number) {
          range = [from, to];
          return chain;
        },
        async single() {
          const { data } = run();
          const list = Array.isArray(data) ? data : [];
          return list.length === 1 ? { data: list[0], error: null } : { data: null, error: { message: `${list.length} rows` } };
        },
        async maybeSingle() {
          const { data } = run();
          return { data: (Array.isArray(data) ? data : [])[0] ?? null, error: null };
        },
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
          const gate = table === 'blocks' && op === 'delete' ? db.deleteGates[db.blocksDeleteCalls++] : undefined;
          return Promise.resolve(gate)
            .then(() => run())
            .then(resolve, reject);
        },
      };
      return chain;
    },
  };
}

const client = makeClient();

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: (path: string) => db.revalidatePath(path) }));
vi.mock('@nextblock-cms/db/server', () => ({
  createClient: () => client,
  getServiceRoleSupabaseClient: () => client,
  getSsgSupabaseClient: () => client,
}));
vi.mock('@nextblock-cms/ecommerce/product-actions', () => ({
  // The products row with its joins, as getProduct() reads it.
  getProduct: async (_client: unknown, productId: string) => {
    db.getProduct(productId);
    if (db.getProductError) return { data: null, error: { message: db.getProductError } };
    const row = db.tables.products.find((product) => product.id === productId);
    return row ? { data: clone(row), error: null } : { data: null, error: { message: 'not found' } };
  },
  updateProduct: async (...args: unknown[]) => {
    db.updateProduct(...args);
    return args[1];
  },
}));
vi.mock('@nextblock-cms/ecommerce/freemius-coupons', () => ({
  syncProductSaleCouponToFreemius: async (...args: unknown[]) => db.syncProductSaleCouponToFreemius(...args),
}));
vi.mock('../auth/twoFactor', () => ({
  evaluateTwoFactor: async () => ({ status: 'satisfied', userId: db.userId, mfaType: null }),
}));
vi.mock('../../app/cms/revisions/utils', () => ({
  getFullProductContent: async (productId: string) => {
    if (db.gateEnabled) {
      const gate = db.gates[db.gateCalls++];
      if (gate) await gate;
    }
    const product = db.tables.products.find((row) => row.id === productId);
    return { meta: { title: product?.title }, blocks: db.tables.blocks.filter((row) => row.product_id === productId) };
  },
}));
vi.mock('../../app/cms/revisions/service', () => ({
  createProductRevision: async (...args: unknown[]) => {
    db.createProductRevision(...args);
    return { success: true, version: 2, recorded: true };
  },
}));

import {
  PRODUCT_DESCRIPTION_BLOCKS_CHANGED_WARNING,
  PRODUCT_DRAFT_IN_PAGE_EMPTIED_DESCRIPTION_ERROR,
  PRODUCT_DRAFT_PUBLISH_CLAIM_REFUSED_ERROR,
  applyProductDraftToProductRecord,
  buildPoisonedProductDraftInPageSaveError,
  getProductDraft,
  loadProductVisualEditingField,
  publishProductVisualEditingDraft,
  saveProductVisualEditingDraftMutation,
} from './product-drafts';
import { describeSkippedProductDraftOverlay } from './product-draft-meta';
import {
  buildPoisonedProductDraftPublishError,
  findPoisonedProductDraftFields,
} from '../../app/cms/products/productFormData';
import type { VisualEditingProductFieldRequest } from './types';

const P1 = '123e4567-e89b-12d3-a456-426614174000';
const GROUP = '523e4567-e89b-12d3-a456-426614174000';
const ATTR = '423e4567-e89b-12d3-a456-426614174001';
const RED = '323e4567-e89b-12d3-a456-426614174001';
const BLUE = '323e4567-e89b-12d3-a456-426614174002';
const M1 = '723e4567-e89b-12d3-a456-426614174001';

const RICH = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Rich description' }] }] };
const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] };
const IN_PAGE = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Written in the page' }] }] };

function fieldRequest(field: 'title' | 'short_description' | 'description_json'): VisualEditingProductFieldRequest {
  return {
    parentType: 'product',
    parentId: P1,
    target: { kind: 'product-field', field, input: field === 'description_json' ? 'tiptap' : 'plain-text', label: field },
  };
}

function seed(options: { product: Row; meta: Row | null; createdAt?: string; draftBlocks?: Row[]; liveBlockIds?: number[] }) {
  db.tables.products = [clone(options.product)];
  db.tables.blocks = (options.liveBlockIds ?? [5]).map((id, index) => ({
    id,
    page_id: null,
    post_id: null,
    product_id: P1,
    language_id: 1,
    block_type: 'text',
    content: { html_content: `<p>Live ${id}</p>` },
    order: index,
  }));
  db.tables.product_drafts =
    options.meta === null
      ? []
      : [
          {
            id: 3,
            product_id: P1,
            author_id: 'writer-1',
            meta: clone(options.meta),
            blocks: options.draftBlocks ?? [
              { id: 5, product_id: P1, language_id: 1, block_type: 'text', content: { html_content: '<p>Draft</p>' }, order: 0 },
            ],
            created_at: options.createdAt ?? '2026-06-02T09:00:00+00:00',
            updated_at: options.createdAt ?? '2026-06-02T09:00:00+00:00',
          },
        ];
  db.tables.profiles = [
    { id: 'admin-1', role: 'ADMIN' },
    { id: 'writer-1', role: 'WRITER' },
  ];
}

const live = () => db.tables.products[0];
const draftMeta = () => db.tables.product_drafts[0]?.meta;

/** The storefront preview of the stored draft over the stored product, as the product page builds it. */
async function preview() {
  return applyProductDraftToProductRecord(clone(live()), await getProductDraft(P1)) as Row;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.nextId = 100;
  db.userId = 'admin-1';
  db.gates = [];
  db.gateCalls = 0;
  db.gateEnabled = false;
  db.deleteGates = [];
  db.blocksDeleteCalls = 0;
  db.clock = 0;
  db.getProductError = null;
});

/** Lets the publishes in flight run until `condition` holds (or fails the test). */
async function until(condition: () => boolean) {
  for (let i = 0; i < 200 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  expect(condition()).toBe(true);
}

/** A gate a flow opens when it chooses (db.gates, db.deleteGates). */
function gate() {
  let open: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { closed, open };
}

const liveBlocks = () => db.tables.blocks.filter((row) => row.product_id === P1);

describe('probe D: a June legacy snapshot holding an in-page description edit, on a product that changed later', () => {
  const EDITED = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Edited in page in June' }] }] };
  const LIVE_DESCRIPTION = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Live description' }] }] };

  beforeEach(() => {
    // Seeded after 3d6942f2 took description_json out of the seed: only the in-page editor put it there.
    seed({
      product: {
        id: P1,
        slug: 'pro-plugin',
        title: 'Pro plugin',
        short_description: 'Short copy',
        description_json: LIVE_DESCRIPTION,
        status: 'active',
        language_id: 1,
        updated_at: '2026-11-10T10:00:00+00:00',
      },
      meta: { id: P1, title: 'Pro plugin', slug: 'pro-plugin', sku: 'PRO', price: 4900, short_description: 'Short copy', description_json: EDITED },
      createdAt: '2026-06-10T09:00:00+00:00',
    });
  });

  it('the field load and the storefront preview show the June edit', async () => {
    db.userId = 'writer-1';

    await expect(loadProductVisualEditingField(fieldRequest('description_json'))).resolves.toMatchObject({ content: EDITED });
    expect((await preview()).description_json).toEqual(EDITED);
  });

  it('an in-page title save keeps it, and publish writes it with no warning about it', async () => {
    db.userId = 'writer-1';
    await expect(saveProductVisualEditingDraftMutation(fieldRequest('title'), 'Pro plugin 2')).resolves.toEqual({ success: true });
    expect(draftMeta()).toEqual({ description_json: EDITED, title: 'Pro plugin 2' });

    db.userId = 'admin-1';
    await expect(publishProductVisualEditingDraft(P1)).resolves.toEqual({ success: true });
    expect(live()).toMatchObject({ title: 'Pro plugin 2', description_json: EDITED });
  });
});

describe('probe L: a stale snapshot title kept by the in-page conversion', () => {
  beforeEach(() => {
    // June 2: a block edit created the draft with the row as meta (title "Pro plugin - Basic"). Before
    // the upgrade a Freemius sync renamed the product without setting updated_at (pre-0.23.4 syncs).
    seed({
      product: {
        id: P1,
        slug: 'pro-plugin',
        title: 'Pro plugin - Starter',
        short_description: 'Short copy',
        description_json: null,
        status: 'active',
        language_id: 1,
        updated_at: '2026-06-01T10:00:00+00:00',
      },
      meta: { id: P1, title: 'Pro plugin - Basic', slug: 'pro-plugin', sku: 'PRO', price: 4900, short_description: 'Short copy' },
      createdAt: '2026-06-02T09:00:00+00:00',
    });
    // After the upgrade, a WRITER edits the short description in the page.
    db.userId = 'writer-1';
  });

  it('L1: a later change (a 0.23.4 sync renames it and sets updated_at) wins over the kept title, with the warning', async () => {
    await expect(saveProductVisualEditingDraftMutation(fieldRequest('short_description'), 'New short copy')).resolves.toEqual({
      success: true,
    });
    Object.assign(live(), { title: 'Pro plugin - Growth', updated_at: '2026-11-14T12:00:00+00:00' });

    // The in-page editor and the preview show the live title, as publish will leave it.
    await expect(loadProductVisualEditingField(fieldRequest('title'))).resolves.toMatchObject({ content: 'Pro plugin - Growth' });
    expect((await preview()).title).toBe('Pro plugin - Growth');

    db.userId = 'admin-1';
    await expect(publishProductVisualEditingDraft(P1)).resolves.toEqual({
      success: true,
      warning: describeSkippedProductDraftOverlay(['title'], ['short_description']),
    });
    expect(live()).toMatchObject({ title: 'Pro plugin - Growth', short_description: 'New short copy' });
  });

  it('L2: with no later change the kept title publishes, as the snapshot did', async () => {
    await expect(saveProductVisualEditingDraftMutation(fieldRequest('short_description'), 'New short copy')).resolves.toEqual({
      success: true,
    });

    db.userId = 'admin-1';
    await expect(publishProductVisualEditingDraft(P1)).resolves.toEqual({ success: true });
    expect(live()).toMatchObject({ title: 'Pro plugin - Basic', short_description: 'New short copy' });
    expect(live()).not.toHaveProperty('legacy_snapshot_fields');
    expect(live()).not.toHaveProperty('legacy_snapshot_created_at');
  });
});

/** A product whose overlay draft renames it and holds two description blocks; `liveBlockIds` are live. */
function seedOverlap(liveBlockIds: number[], draftTexts = ['Draft A', 'Draft B']) {
  seed({
    product: { id: P1, slug: 'pro-plugin', title: 'Pro plugin', status: 'active', language_id: 1, updated_at: '2026-06-01T10:00:00+00:00' },
    meta: { title: 'Pro plugin X' },
    liveBlockIds,
    draftBlocks: draftTexts.map((text, index) => ({
      id: 900 + index,
      product_id: P1,
      language_id: 1,
      block_type: 'text',
      content: { html_content: `<p>${text}</p>` },
      order: index,
    })),
  });
}

/**
 * Two publishes of one draft. Each claims the draft (an UPDATE that matches only the row as it read
 * it; 02003's trigger moves updated_at) after its checks and before its first write: round 7 instead
 * took a publish's rows back out after a short delete, which could remove the only set (VP-F, V8).
 */
describe('two publishes of the same draft that overlap', () => {
  it('R1: both read the draft before either writes: the first publishes, the second finds the draft claimed and writes nothing', async () => {
    seedOverlap([5, 6]);
    const first = gate();
    const second = gate();
    db.gates = [first.closed, second.closed];
    db.gateEnabled = true;

    // Both read the draft and the live ids [5, 6], then wait before writing anything.
    const firstPublish = publishProductVisualEditingDraft(P1);
    const secondPublish = publishProductVisualEditingDraft(P1);
    await until(() => db.gateCalls === 2);
    first.open();
    const firstResult = await firstPublish;
    second.open();
    const secondResult = await secondPublish;

    expect(firstResult).toEqual({ success: true });
    expect(secondResult).toEqual({ success: false, error: PRODUCT_DRAFT_PUBLISH_CLAIM_REFUSED_ERROR });
    expect(PRODUCT_DRAFT_PUBLISH_CLAIM_REFUSED_ERROR).toBe(
      'Another publish of this draft started first, or the draft changed since it was read: nothing was published.'
    );
    // The first publish's rows only: the second inserted none.
    expect(liveBlocks().map((row) => [row.id, row.content.html_content])).toEqual([
      [100, '<p>Draft A</p>'],
      [101, '<p>Draft B</p>'],
    ]);
    expect(live().title).toBe('Pro plugin X');
    expect(db.createProductRevision).toHaveBeenCalledTimes(1);
    expect(db.tables.product_drafts).toEqual([]);
  });

  it("VP-B: the first waits at its delete while the second runs: the second still writes nothing, and History holds the first's blocks only", async () => {
    seedOverlap([5, 6]);
    const first = gate();
    const second = gate();
    const firstDelete = gate();
    db.gates = [first.closed, second.closed];
    db.gateEnabled = true;
    db.deleteGates = [firstDelete.closed];

    const firstPublish = publishProductVisualEditingDraft(P1);
    const secondPublish = publishProductVisualEditingDraft(P1);
    await until(() => db.gateCalls === 2);
    first.open();
    // The first claims the draft, renames the product, inserts its rows and waits before deleting [5, 6].
    await until(() => db.blocksDeleteCalls === 1);
    second.open();
    const secondResult = await secondPublish;
    firstDelete.open();
    const firstResult = await firstPublish;

    expect(secondResult).toEqual({ success: false, error: PRODUCT_DRAFT_PUBLISH_CLAIM_REFUSED_ERROR });
    expect(firstResult).toEqual({ success: true });
    expect(liveBlocks().map((row) => row.content.html_content)).toEqual(['<p>Draft A</p>', '<p>Draft B</p>']);
    // Round 7 recorded the other publish's rows too: an after-state of four blocks for a page of two.
    expect(db.createProductRevision).toHaveBeenCalledTimes(1);
    const after = db.createProductRevision.mock.calls[0][3] as { blocks: Row[] };
    expect(after.blocks.map((row) => row.id)).toEqual([100, 101]);
  });

  it('VP-E: a product with no live description blocks gets one set, not two', async () => {
    seedOverlap([], ['Draft A']);
    const first = gate();
    const second = gate();
    db.gates = [first.closed, second.closed];
    db.gateEnabled = true;

    const firstPublish = publishProductVisualEditingDraft(P1);
    const secondPublish = publishProductVisualEditingDraft(P1);
    await until(() => db.gateCalls === 2);
    first.open();
    const firstResult = await firstPublish;
    second.open();
    const secondResult = await secondPublish;

    expect(firstResult).toEqual({ success: true });
    expect(secondResult).toEqual({ success: false, error: PRODUCT_DRAFT_PUBLISH_CLAIM_REFUSED_ERROR });
    expect(liveBlocks().map((row) => row.content.html_content)).toEqual(['<p>Draft A</p>']);
  });

  it('VP-F: a publish that reads the draft while the first waits between its insert and its delete finds it gone by its claim: one set', async () => {
    seedOverlap([5, 6]);
    const secondRead = gate();
    const firstDelete = gate();
    // The first publish's content read passes at once; the second's waits.
    db.gates = [Promise.resolve(), secondRead.closed];
    db.gateEnabled = true;
    db.deleteGates = [firstDelete.closed];

    const firstPublish = publishProductVisualEditingDraft(P1);
    // The first claimed the draft, inserted 100 and 101 and waits before deleting [5, 6].
    await until(() => db.blocksDeleteCalls === 1);
    const secondPublish = publishProductVisualEditingDraft(P1);
    // The second read the claimed draft and the live ids [5, 6, 100, 101], and waits before its claim.
    await until(() => db.gateCalls === 2);
    firstDelete.open();
    const firstResult = await firstPublish;
    const revalidationsByFirst = db.revalidatePath.mock.calls.length;
    secondRead.open();
    const secondResult = await secondPublish;

    expect(firstResult).toEqual({ success: true });
    expect(secondResult).toEqual({ success: false, error: PRODUCT_DRAFT_PUBLISH_CLAIM_REFUSED_ERROR });
    // Round 7's take-back left no description blocks and no draft here.
    expect(liveBlocks().map((row) => [row.id, row.content.html_content])).toEqual([
      [100, '<p>Draft A</p>'],
      [101, '<p>Draft B</p>'],
    ]);
    expect(db.tables.product_drafts).toEqual([]);
    expect(db.revalidatePath.mock.calls.length).toBe(revalidationsByFirst);
    expect(db.createProductRevision).toHaveBeenCalledTimes(1);
  });

  it("V8: a publish that reads the draft after the first claimed it is not stopped; its delete removes the first one's row, and it keeps its own, with a warning", async () => {
    seedOverlap([5], ['Draft']);
    const firstDelete = gate();
    const secondDelete = gate();
    db.deleteGates = [firstDelete.closed, secondDelete.closed];

    const firstPublish = publishProductVisualEditingDraft(P1);
    // The first claimed the draft, inserted 100 and waits before deleting [5].
    await until(() => db.blocksDeleteCalls === 1);
    const secondPublish = publishProductVisualEditingDraft(P1);
    // The second read the claimed draft and the live ids [5, 100], claimed it in turn, inserted 101 and waits.
    await until(() => db.blocksDeleteCalls === 2);
    firstDelete.open();
    const firstResult = await firstPublish;
    secondDelete.open();
    const secondResult = await secondPublish;

    expect(firstResult).toEqual({ success: true });
    // Its delete of [5, 100] removed only 100: round 7 then took 101 back out and left no blocks.
    expect(secondResult).toEqual({ success: true, warning: PRODUCT_DESCRIPTION_BLOCKS_CHANGED_WARNING });
    expect(liveBlocks().map((row) => [row.id, row.content.html_content])).toEqual([[101, '<p>Draft</p>']]);
    expect(db.tables.product_drafts).toEqual([]);
  });

  it('an in-page save made while a publish was reading is kept: the publish finds the draft changed and writes nothing', async () => {
    seedOverlap([5], ['Draft']);
    const read = gate();
    db.gates = [read.closed];
    db.gateEnabled = true;

    const publishing = publishProductVisualEditingDraft(P1);
    // The publish read the draft and the live ids, and waits before its claim.
    await until(() => db.gateCalls === 1);
    db.userId = 'writer-1';
    await expect(saveProductVisualEditingDraftMutation(fieldRequest('short_description'), 'Saved meanwhile')).resolves.toEqual({
      success: true,
    });
    db.userId = 'admin-1';
    read.open();

    await expect(publishing).resolves.toEqual({ success: false, error: PRODUCT_DRAFT_PUBLISH_CLAIM_REFUSED_ERROR });
    // Without the claim the publish went on and removed the draft with the edit in it.
    expect(draftMeta()).toEqual({ title: 'Pro plugin X', short_description: 'Saved meanwhile' });
    expect(live().title).toBe('Pro plugin');
    expect(liveBlocks().map((row) => row.id)).toEqual([5]);
    expect(db.createProductRevision).not.toHaveBeenCalled();
  });
});

/** A physical product at $59 with two variants, a gallery and a rich description (getProduct's shape). */
function physicalProduct() {
  const variant = (id: string, sku: string, price: number, stock: number, term: string, value: string) => ({
    id,
    sku,
    upc: null,
    main_media_id: null,
    price,
    prices: { USD: price },
    sale_price: null,
    sale_prices: null,
    sale_start_at: null,
    sale_end_at: null,
    stock_quantity: stock,
    variant_attribute_mapping: [
      {
        attribute_term_id: term,
        product_attribute_terms: {
          id: term,
          attribute_id: ATTR,
          value,
          slug: value.toLowerCase(),
          sort_order: 0,
          value_translations: {},
          product_attributes: { id: ATTR, name: 'Color', slug: 'color', name_translations: {} },
        },
      },
    ],
  });
  return {
    id: P1,
    title: 'Pro plugin',
    slug: 'pro-plugin',
    sku: 'PRO',
    upc: null,
    price: 5900,
    prices: { USD: 5900 },
    sale_price: null,
    sale_prices: {},
    sale_start_at: null,
    sale_end_at: null,
    stock: 7,
    is_taxable: true,
    product_type: 'physical',
    payment_provider: 'stripe',
    status: 'active',
    short_description: 'Short copy',
    description_json: RICH,
    language_id: 1,
    translation_group_id: GROUP,
    updated_at: '2026-09-01T10:00:00+00:00',
    languages: { code: 'en' },
    product_media: [{ media_id: M1, sort_order: 0, media: { id: M1, file_path: 'a.webp', object_key: 'a.webp' } }],
    product_variants: [variant('v-red', 'PRO-RED', 5900, 3, RED, 'Red'), variant('v-blue', 'PRO-BLUE', 6400, 4, BLUE, 'Blue')],
  };
}

/** The same product sold through Freemius at $300 now: no variants, no gallery. */
function digitalProduct() {
  return {
    ...physicalProduct(),
    product_type: 'digital',
    payment_provider: 'freemius',
    is_taxable: false,
    price: 30000,
    prices: { USD: 30000 },
    stock: 999,
    freemius_product_id: '12345',
    freemius_plan_id: '67890',
    product_media: [],
    product_variants: [],
  };
}

/** The pre-0.23.4 edit page's autosave over a row snapshot taken at `priceCents` (cents read as dollars). */
function oldAutosave(priceCents: number, stock: number, physical: boolean) {
  return {
    product_type: physical ? 'physical' : 'digital',
    payment_provider: physical ? 'stripe' : 'freemius',
    title: 'Pro plugin',
    slug: 'pro-plugin',
    sku: 'PRO',
    upc: null,
    is_taxable: physical,
    price: priceCents,
    prices: { USD: priceCents },
    sale_price: null,
    sale_prices: {},
    stock,
    meta_title: 'Pro plugin | Store',
    meta_description: 'The pro plugin.',
    custom_canonical: '',
    short_description: 'Short copy',
    description_json: EMPTY_DOC,
    freemius_product_id: physical ? '' : '12345',
    freemius_plan_id: physical ? '' : '67890',
    trial_period_days: 0,
    trial_requires_payment_method: false,
    status: 'active',
    language_id: 1,
    translation_group_id: GROUP,
    product_media: [],
    category_ids: [],
    variation_attributes: [],
    variants: [],
  };
}

describe('an old draft publish refuses (an earlier version autosaved it over a row snapshot)', () => {
  it('R1: an in-page save never makes it publishable: the save is refused and writes nothing, and publish still refuses it', async () => {
    // $300 now, autosaved at $49: the price is in the check's blind spot, so the emptied description
    // is the sign that the draft is a copy; an in-page description save used to erase it.
    seed({ product: digitalProduct(), meta: oldAutosave(4900, 999, false), createdAt: '2026-07-01T00:00:00+00:00' });
    const original = clone(draftMeta());
    const fields = findPoisonedProductDraftFields(original, live());
    expect(fields).toContain('description_json');

    db.userId = 'writer-1';
    const saved = await saveProductVisualEditingDraftMutation(fieldRequest('description_json'), IN_PAGE);

    expect(saved).toEqual({ error: expect.stringMatching(/^Not saved\. /) });
    expect((saved as { error: string }).error).toContain(
      'Open the product in the CMS editor, check those fields, save a change (or discard the draft), then edit here.'
    );
    expect(draftMeta()).toEqual(original);
    expect(db.revalidatePath).not.toHaveBeenCalled();

    db.userId = 'admin-1';
    await expect(publishProductVisualEditingDraft(P1)).resolves.toEqual({
      success: false,
      error: buildPoisonedProductDraftPublishError(fields),
    });
    expect(db.updateProduct).not.toHaveBeenCalled();
    expect(db.syncProductSaleCouponToFreemius).not.toHaveBeenCalled();
    expect(live().price).toBe(30000);
  });

  it("R2: the storefront preview and the in-page editor show the live description, not the draft's emptied one", async () => {
    seed({ product: physicalProduct(), meta: oldAutosave(5900, 7, true), createdAt: '2026-07-01T00:00:00+00:00' });
    expect(findPoisonedProductDraftFields(draftMeta(), live())).toContain('description_json');

    expect((await preview()).description_json).toEqual(RICH);
    db.userId = 'writer-1';
    await expect(loadProductVisualEditingField(fieldRequest('description_json'))).resolves.toMatchObject({ content: RICH });
    // The title is no poisoned field: the draft's shows.
    expect((await preview()).title).toBe('Pro plugin');
  });

  it('still takes an in-page save into an old draft with no sign of a copy, and into a 0.23.4 one without reading the product', async () => {
    const clean = { ...oldAutosave(59, 7, true), description_json: RICH, product_media: [{ media_id: M1 }] };
    delete (clean as Row).variants;
    delete (clean as Row).variation_attributes;
    seed({ product: physicalProduct(), meta: clean, createdAt: '2026-07-01T00:00:00+00:00' });
    expect(findPoisonedProductDraftFields(draftMeta(), live())).toEqual([]);

    db.userId = 'writer-1';
    await expect(saveProductVisualEditingDraftMutation(fieldRequest('title'), 'Renamed')).resolves.toEqual({ success: true });
    expect(draftMeta()).toMatchObject({ title: 'Renamed', price: 59 });

    // A 0.23.4 autosave (the marker) may hold any price: no check, no read of the product.
    seed({
      product: physicalProduct(),
      meta: { ...oldAutosave(5900, 7, true), form_version: 2 },
      createdAt: '2026-11-12T00:00:00+00:00',
    });
    db.getProduct.mockClear();
    await expect(saveProductVisualEditingDraftMutation(fieldRequest('title'), 'Renamed again')).resolves.toEqual({
      success: true,
    });
    expect(draftMeta()).toMatchObject({ title: 'Renamed again', price: 5900, form_version: 2 });
    expect(db.getProduct).not.toHaveBeenCalled();
  });

  it("VP-J: an in-page save never makes publish refuse a draft it accepts: clearing a clean old draft's description is refused, and its $349 still publishes", async () => {
    // $300 now; an editor's pre-0.23.4 autosave repriced it to $349, with the rich description.
    seed({ product: digitalProduct(), meta: { ...oldAutosave(349, 999, false), description_json: RICH }, createdAt: '2026-07-01T00:00:00+00:00' });
    expect(findPoisonedProductDraftFields(draftMeta(), live())).toEqual([]);
    const original = clone(draftMeta());

    db.userId = 'writer-1';
    // The editor deletes the description text in the page: Tiptap saves an empty paragraph, which in
    // an unmarked draft reads as the old edit page's copy (prices, sale prices and description flagged).
    expect(findPoisonedProductDraftFields({ ...original, description_json: EMPTY_DOC }, live())).toContain('description_json');
    await expect(saveProductVisualEditingDraftMutation(fieldRequest('description_json'), EMPTY_DOC)).resolves.toEqual({
      error: PRODUCT_DRAFT_IN_PAGE_EMPTIED_DESCRIPTION_ERROR,
    });
    expect(PRODUCT_DRAFT_IN_PAGE_EMPTIED_DESCRIPTION_ERROR).toMatch(/^Not saved\. .*an empty description .* in the CMS editor instead\.$/);
    expect(draftMeta()).toEqual(original);
    expect(db.revalidatePath).not.toHaveBeenCalled();

    // A description with content still saves.
    await expect(saveProductVisualEditingDraftMutation(fieldRequest('description_json'), IN_PAGE)).resolves.toEqual({
      success: true,
    });

    db.userId = 'admin-1';
    await expect(publishProductVisualEditingDraft(P1)).resolves.toEqual({ success: true });
    expect(db.updateProduct).toHaveBeenCalledWith(
      client,
      P1,
      expect.objectContaining({ price: 349, prices: { USD: 349 }, description_json: IN_PAGE })
    );
  });

  it('VP-Q: a draft refused for its prices alone refuses every in-page save, and shows its own description in the preview and the field load', async () => {
    const DRAFT_COPY = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Draft copy' }] }] };
    // $49 now, and the old page stored the snapshot's 4900 cents as $4,900; the description is the draft's own.
    seed({
      product: { ...digitalProduct(), price: 4900, prices: { USD: 4900 } },
      meta: { ...oldAutosave(4900, 999, false), description_json: DRAFT_COPY },
      createdAt: '2026-07-01T00:00:00+00:00',
    });
    const fields = findPoisonedProductDraftFields(draftMeta(), live());
    expect(fields).toContain('prices');
    expect(fields).not.toContain('description_json');
    const original = clone(draftMeta());

    db.userId = 'writer-1';
    for (const [field, value] of [
      ['title', 'Renamed'],
      ['short_description', 'New short copy'],
    ] as const) {
      await expect(saveProductVisualEditingDraftMutation(fieldRequest(field), value)).resolves.toEqual({
        error: buildPoisonedProductDraftInPageSaveError(fields),
      });
    }
    expect(draftMeta()).toEqual(original);
    expect(db.revalidatePath).not.toHaveBeenCalled();

    // Only an emptied description is replaced by the live one, as the CMS editor shows it.
    await expect(loadProductVisualEditingField(fieldRequest('description_json'))).resolves.toMatchObject({ content: DRAFT_COPY });
    expect((await preview()).description_json).toEqual(DRAFT_COPY);
  });

  it("says what an old CMS draft import did when publish and the in-page save refuse it", async () => {
    // A pre-0.23.4 draft import (no variation_attributes) of a file with no media, variant or
    // description columns: its prices and stock are the file's, its emptied groups are refused.
    const oldImport: Row = { ...oldAutosave(55, 20, true), description_json: null };
    delete oldImport.variation_attributes;
    seed({ product: physicalProduct(), meta: oldImport, createdAt: '2026-07-01T00:00:00+00:00' });
    const original = clone(draftMeta());
    const fields = findPoisonedProductDraftFields(original, live());
    expect(fields).toEqual(expect.arrayContaining(['product_media']));
    expect(fields).not.toContain('prices');

    db.userId = 'writer-1';
    const saved = (await saveProductVisualEditingDraftMutation(fieldRequest('title'), 'Renamed')) as { error: string };
    expect(saved).toEqual({ error: buildPoisonedProductDraftInPageSaveError(fields, original) });
    expect(saved.error).toMatch(/^Not saved\. This draft was saved by a CMS import in an earlier version of NextBlock/);
    expect(draftMeta()).toEqual(original);

    db.userId = 'admin-1';
    const published = (await publishProductVisualEditingDraft(P1)) as { success: boolean; error: string };
    expect(published).toEqual({ success: false, error: buildPoisonedProductDraftPublishError(fields, { meta: original }) });
    expect(published.error).toMatch(/^Not published\. This draft was saved by a CMS import in an earlier version of NextBlock/);
    expect(db.updateProduct).not.toHaveBeenCalled();
  });

  it('refuses an in-page save into an unmarked product-values draft when the live product cannot be read, and the description load fails too', async () => {
    const clean = { ...oldAutosave(59, 7, true), description_json: RICH, product_media: [{ media_id: M1 }] };
    delete (clean as Row).variants;
    delete (clean as Row).variation_attributes;
    seed({ product: physicalProduct(), meta: clean, createdAt: '2026-07-01T00:00:00+00:00' });
    const original = clone(draftMeta());
    db.getProductError = 'connection reset';

    db.userId = 'writer-1';
    await expect(saveProductVisualEditingDraftMutation(fieldRequest('title'), 'Renamed')).resolves.toEqual({
      error: 'Product not found: connection reset',
    });
    expect(draftMeta()).toEqual(original);
    expect(db.revalidatePath).not.toHaveBeenCalled();
    await expect(loadProductVisualEditingField(fieldRequest('description_json'))).resolves.toEqual({
      error: 'Product not found: connection reset',
    });
  });
});
