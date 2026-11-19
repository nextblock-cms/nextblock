import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Product drafts end to end: the real in-page save, field load, storefront preview and publish over a
 * small in-memory database (products, product_drafts, blocks, profiles) that answers the supabase-js
 * chains they use, so each flow is one sequence of real calls. These pin what the verify round 6
 * probes found (verify-P6C: D, L1, L2, R1; the integration walk: R1, R2) and the round 7 ones
 * (verify-P7C: VP-B, VP-E, VP-F, VP-J, VP-Q, V8).
 *
 * The publish itself is one call to `publish_product_draft` (migration 02043), which this database
 * answers the way the function behaves: in one step (it holds the products and draft row locks for its
 * whole transaction, so nothing interleaves with it), refusing a draft that is gone (NBP01), that
 * changed since the server action read it (NBP02) or whose product changed (NBP03); then the overlay
 * fields, the blocks replaced, a revision, the draft deleted. What the real function does inside, two
 * real sessions included, is tools/scripts/product-draft-publish.db.test.ts; this file drives the
 * server actions around it, step by step.
 */

type Row = Record<string, any>;

const db = vi.hoisted(() => ({
  tables: { products: [] as Row[], product_drafts: [] as Row[], blocks: [] as Row[], profiles: [] as Row[] },
  nextId: 100,
  userId: 'admin-1',
  /** Each publish_product_draft call in turn waits on its entry before it runs, when it has one. */
  rpcGates: [] as Array<Promise<void> | undefined>,
  rpcCalls: 0,
  /** Each product_drafts UPDATE in turn waits on its entry, when it has one (a save held at its write). */
  draftUpdateGates: [] as Array<Promise<void> | undefined>,
  draftUpdateCalls: 0,
  /** Seconds past 2026-11-14T12:00Z: each product_drafts UPDATE stamps the next one as its updated_at. */
  clock: 0,
  /** Revisions publish_product_draft recorded: [product id, content after]. */
  revisions: [] as Array<[string, Row]>,
  /** When set, getProduct() answers this error: the live read failing. */
  getProductError: null as string | null,
  getProduct: vi.fn(),
  rpc: vi.fn(),
  syncProductSaleCouponToFreemius: vi.fn(),
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

/** The next updated_at, as the database's now() moves on. */
function tick() {
  db.clock += 1;
  return new Date(Date.UTC(2026, 10, 14, 12, 0, db.clock)).toISOString();
}

/** A PostgREST error answer for a function RAISE with this SQLSTATE. */
function raised(code: string, message: string) {
  return { data: null, error: { code, message, details: null, hint: null } };
}

/**
 * publish_product_draft (migration 02043) as it behaves, in one synchronous step: no await inside, so
 * nothing interleaves with it, as nothing interleaves with the real one's transaction.
 */
function publishProductDraftFunction(args: Row) {
  const product = db.tables.products.find((row) => row.id === args.p_product_id);
  if (!product) return raised('NBP05', 'Product not found.');
  const draft = db.tables.product_drafts.find((row) => row.product_id === args.p_product_id);
  if (!draft) return raised('NBP01', 'No draft exists for this product.');
  if (String(draft.id) !== String(args.p_draft_id) || draft.updated_at !== args.p_draft_updated_at) {
    return raised('NBP02', 'The draft changed after it was read.');
  }
  if ((product.updated_at ?? null) !== (args.p_product_updated_at ?? null)) {
    return raised('NBP03', 'The product changed after it was read.');
  }

  if (args.p_values) {
    // The product values themselves are the database test's; the title is enough to see them land.
    product.title = args.p_values.title;
    product.updated_at = tick();
  } else if (args.p_overlay && Object.keys(args.p_overlay).some((key) => ['title', 'short_description', 'description_json'].includes(key))) {
    for (const key of ['title', 'short_description', 'description_json']) {
      if (key in args.p_overlay) product[key] = clone(args.p_overlay[key]);
    }
    product.updated_at = tick();
  }

  db.tables.blocks = db.tables.blocks.filter((row) => row.product_id !== product.id);
  for (const block of args.p_blocks as Row[]) {
    db.tables.blocks.push({ id: db.nextId++, page_id: null, post_id: null, product_id: product.id, ...clone(block) });
  }
  db.revisions.push([product.id, { title: product.title, blocks: clone(db.tables.blocks.filter((row) => row.product_id === product.id)) }]);
  db.tables.product_drafts = db.tables.product_drafts.filter((row) => row !== draft);

  return {
    data: {
      product_id: product.id,
      previous_slug: product.slug,
      slug: product.slug,
      payment_provider: product.payment_provider ?? 'stripe',
      wrote_values: Boolean(args.p_values),
      revision: { recorded: true, version: db.revisions.length + 1 },
    },
    error: null,
  };
}

function makeClient() {
  return {
    auth: { getUser: async () => ({ data: { user: db.userId ? { id: db.userId } : null }, error: null }) },
    async rpc(name: string, args: Row) {
      db.rpc(name, clone(args));
      const gate = db.rpcGates[db.rpcCalls++];
      if (gate) await gate;
      if (name !== 'publish_product_draft') return raised('PGRST202', `Could not find the function public.${name}`);
      return publishProductDraftFunction(args);
    },
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
            if (table === 'product_drafts') row.updated_at = tick();
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
          const gate =
            table === 'product_drafts' && op === 'update' ? db.draftUpdateGates[db.draftUpdateCalls++] : undefined;
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
vi.mock('@nextblock-cms/ecommerce/product-actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@nextblock-cms/ecommerce/product-actions')>()),
  // The products row with its joins, as getProduct() reads it.
  getProduct: async (_client: unknown, productId: string) => {
    db.getProduct(productId);
    if (db.getProductError) return { data: null, error: { message: db.getProductError } };
    const row = db.tables.products.find((product) => product.id === productId);
    return row ? { data: clone(row), error: null } : { data: null, error: { message: 'not found' } };
  },
}));
vi.mock('@nextblock-cms/ecommerce/freemius-coupons', () => ({
  syncProductSaleCouponToFreemius: async (...args: unknown[]) => db.syncProductSaleCouponToFreemius(...args),
}));
vi.mock('../auth/twoFactor', () => ({
  evaluateTwoFactor: async () => ({ status: 'satisfied', userId: db.userId, mfaType: null }),
}));

import {
  PRODUCT_CHANGED_DURING_PUBLISH_ERROR,
  PRODUCT_DRAFT_CHANGED_DURING_PUBLISH_ERROR,
  PRODUCT_DRAFT_IN_PAGE_EMPTIED_DESCRIPTION_ERROR,
  applyProductDraftToProductRecord,
  buildPoisonedProductDraftInPageSaveError,
  getProductDraft,
  loadProductVisualEditingField,
  publishProductVisualEditingDraft,
  saveProductVisualEditingDraftMutation,
} from './product-drafts';
import { NO_PRODUCT_DRAFT_ERROR, describeSkippedProductDraftOverlay } from './product-draft-meta';
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
  db.rpcGates = [];
  db.rpcCalls = 0;
  db.draftUpdateGates = [];
  db.draftUpdateCalls = 0;
  db.clock = 0;
  db.revisions = [];
  db.getProductError = null;
});

/** Lets the flows in flight run until `condition` holds (or fails the test). */
async function until(condition: () => boolean) {
  for (let i = 0; i < 200 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  expect(condition()).toBe(true);
}

/** A gate a flow opens when it chooses (db.rpcGates, db.draftUpdateGates). */
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
 * Two publishes of one draft, and a publish against a save. 0.23.4 claimed the draft (an UPDATE on its
 * id and updated_at) and then sent each write as its own request: a publish that read the draft after
 * another's claim still swapped the blocks (the description twice, V8), and a save that landed after the
 * claim was reported saved and deleted with the draft. Since migration 02043 the claim, the writes and
 * the draft delete are one call under the draft's row lock.
 */
describe('two publishes of the same draft, and a publish against a save', () => {
  it.each([
    ['with live description blocks', [5, 6]],
    ['with no live description blocks (VP-E)', [] as number[]],
  ])('R1/VP-B/VP-F/V8 %s: both read the draft first, the first publishes, the second finds it gone and writes nothing', async (_label, liveBlockIds) => {
    seedOverlap(liveBlockIds);
    const first = gate();
    const second = gate();
    db.rpcGates = [first.closed, second.closed];

    // Both read the draft and the live row, then wait before their call.
    const firstPublish = publishProductVisualEditingDraft(P1);
    const secondPublish = publishProductVisualEditingDraft(P1);
    await until(() => db.rpcCalls === 2);
    first.open();
    const firstResult = await firstPublish;
    const revalidationsByFirst = db.revalidatePath.mock.calls.length;
    second.open();
    const secondResult = await secondPublish;

    expect(firstResult).toEqual({ success: true });
    // The draft bar reads this as "already published elsewhere": it hides and reloads.
    expect(secondResult).toEqual({ success: false, error: NO_PRODUCT_DRAFT_ERROR });
    // One set of description blocks, whatever the live ones were: 0.23.4 could leave two.
    expect(liveBlocks().map((row) => row.content.html_content)).toEqual(['<p>Draft A</p>', '<p>Draft B</p>']);
    expect(live().title).toBe('Pro plugin X');
    expect(db.revisions).toHaveLength(1);
    expect(db.tables.product_drafts).toEqual([]);
    // The refused one refreshed nothing.
    expect(db.revalidatePath.mock.calls.length).toBe(revalidationsByFirst);
  });

  it('a publish that reads the draft after another one committed finds no draft at all', async () => {
    seedOverlap([5]);
    await expect(publishProductVisualEditingDraft(P1)).resolves.toEqual({ success: true });

    await expect(publishProductVisualEditingDraft(P1)).resolves.toEqual({ success: false, error: NO_PRODUCT_DRAFT_ERROR });
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(liveBlocks()).toHaveLength(2);
  });

  it('an in-page save made while a publish was reading is kept: the publish finds the draft changed and writes nothing', async () => {
    seedOverlap([5], ['Draft']);
    const call = gate();
    db.rpcGates = [call.closed];

    const publishing = publishProductVisualEditingDraft(P1);
    // The publish read the draft and the live row, and waits before its call.
    await until(() => db.rpcCalls === 1);
    db.userId = 'writer-1';
    await expect(saveProductVisualEditingDraftMutation(fieldRequest('short_description'), 'Saved meanwhile')).resolves.toEqual({
      success: true,
    });
    db.userId = 'admin-1';
    call.open();

    await expect(publishing).resolves.toEqual({ success: false, error: PRODUCT_DRAFT_CHANGED_DURING_PUBLISH_ERROR });
    expect(draftMeta()).toEqual({ title: 'Pro plugin X', short_description: 'Saved meanwhile' });
    expect(live().title).toBe('Pro plugin');
    expect(liveBlocks().map((row) => row.id)).toEqual([5]);
    expect(db.revisions).toEqual([]);
  });

  it('an in-page save that lands after the publish committed goes into a new draft: it is never reported saved and deleted', async () => {
    seedOverlap([5], ['Draft']);
    const write = gate();
    db.draftUpdateGates = [write.closed];

    // The save read the draft and waits at its UPDATE (as one waits on the publish's row lock).
    db.userId = 'writer-1';
    const saving = saveProductVisualEditingDraftMutation(fieldRequest('short_description'), 'Typed during the publish');
    await until(() => db.draftUpdateCalls === 1);

    // The publish runs to the end: the draft (title "Pro plugin X") is live and deleted.
    db.userId = 'admin-1';
    await expect(publishProductVisualEditingDraft(P1)).resolves.toEqual({ success: true });
    expect(live().title).toBe('Pro plugin X');
    expect(db.tables.product_drafts).toEqual([]);

    // Its UPDATE matches no row now; the save puts the edit into a new draft instead.
    db.userId = 'writer-1';
    write.open();
    await expect(saving).resolves.toEqual({ success: true });
    expect(db.tables.product_drafts).toHaveLength(1);
    expect(draftMeta()).toEqual({ short_description: 'Typed during the publish' });
    // The new draft starts from the published blocks, and the next publish makes the edit live.
    expect(db.tables.product_drafts[0].blocks.map((block: Row) => block.content.html_content)).toEqual(['<p>Draft</p>']);
    db.userId = 'admin-1';
    await expect(publishProductVisualEditingDraft(P1)).resolves.toEqual({ success: true });
    expect(live()).toMatchObject({ title: 'Pro plugin X', short_description: 'Typed during the publish' });
  });

  it('a product written between the read and the call is refused, the draft kept, nothing written', async () => {
    seedOverlap([5], ['Draft']);
    const call = gate();
    db.rpcGates = [call.closed];

    const publishing = publishProductVisualEditingDraft(P1);
    await until(() => db.rpcCalls === 1);
    // A Cortex field update (which stamps updated_at) lands meanwhile.
    Object.assign(live(), { short_description: 'Written by Cortex', updated_at: '2026-11-14T12:30:00.000Z' });
    call.open();

    await expect(publishing).resolves.toEqual({ success: false, error: PRODUCT_CHANGED_DURING_PUBLISH_ERROR });
    expect(live()).toMatchObject({ title: 'Pro plugin', short_description: 'Written by Cortex' });
    expect(draftMeta()).toEqual({ title: 'Pro plugin X' });
    expect(liveBlocks().map((row) => row.id)).toEqual([5]);
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
    expect(db.rpc).not.toHaveBeenCalled();
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
    expect(db.rpc).toHaveBeenCalledWith(
      'publish_product_draft',
      expect.objectContaining({
        // Minor units: the function receives what buildProductDraftPublishValues makes of the $349.
        p_values: expect.objectContaining({ price: 34900, prices: { USD: 34900 }, description_json: IN_PAGE }),
      })
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
    expect(db.rpc).not.toHaveBeenCalled();
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
