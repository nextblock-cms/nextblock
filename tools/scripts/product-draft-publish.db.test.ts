import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// A workspace test, not a project: it runs the payload the library's builder makes against the function,
// so a field added on either side is caught (the root project has no tags to depend on libraries with).
// eslint-disable-next-line @nx/enforce-module-boundaries
import { buildProductDraftPublishValues } from '@nextblock-cms/ecommerce/product-actions';

type ProductFormValues = Parameters<typeof buildProductDraftPublishValues>[0];

/**
 * public.publish_product_draft (migration 02043; its stock since 02044) against a real database:
 * several sessions at once, each emulating PostgREST (SET LOCAL ROLE authenticated +
 * request.jwt.claims), with real row locks, and sales recorded the way checkout records them
 * (apply_order_inventory_deduction). The unit tests of the app (lib/visual-editing/product-drafts-*.test.ts)
 * cover what the server action sends and how it reads the answer; these cover what the function does
 * with it.
 *
 * Runs only with NEXTBLOCK_TEST_DB_URL pointing at a LOCAL replay of every migration (it inserts and
 * deletes fixtures; it refuses any other host), as the CI db-posture job does after the post-apply
 * grant pass:
 *
 *   NEXTBLOCK_TEST_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *     npx vitest run tools/scripts/product-draft-publish.db.test.ts
 *
 * Never point it at production or a shared database.
 */

const DB_URL = process.env.NEXTBLOCK_TEST_DB_URL ?? '';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

if (DB_URL && !LOCAL_HOSTS.has(new URL(DB_URL).hostname)) {
  throw new Error(`Refusing ${new URL(DB_URL).hostname}: this test writes fixtures; use a local replay.`);
}

/**
 * The advisory lock key of the DB tests. This suite holds it shared while it runs;
 * migration-replay.db.test.ts drops schema public in a rolled-back transaction and holds it
 * exclusively, so vitest can run both files side by side and each waits for the other.
 */
const DB_TESTS_LOCK = 2_043_111_800;
/** Long enough for the replay test to finish first. */
const LOCK_WAIT_MS = 300_000;

type Sql = ReturnType<typeof postgres>;
type Row = Record<string, any>;

const RUN = randomUUID().slice(0, 8);
const ADMIN_ID = randomUUID();
const WRITER_ID = randomUUID();

/** One connection per session: the setup/observer connection is the table owner, the others emulate PostgREST. */
const connections: Sql[] = [];
function connect(): Sql {
  const sql = postgres(DB_URL, { max: 1, idle_timeout: 5, onnotice: () => undefined });
  connections.push(sql);
  return sql;
}

let owner: Sql;
let currency = 'USD';
const terms: Record<string, string> = {};
const media: Record<string, string> = {};
const categories: Record<string, string> = {};
const created = { products: [] as string[], orders: [] as string[], skus: [] as string[], attributes: [] as string[] };

async function authenticate(tx: Sql, userId: string) {
  await tx.unsafe('set local role authenticated');
  await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: 'authenticated', aal: 'aal1' })}, true)`;
}

/** Runs `run` in a transaction as `userId`, the way PostgREST runs a request. */
function asUser<T>(sql: Sql, userId: string, run: (tx: Sql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await authenticate(tx as unknown as Sql, userId);
    return run(tx as unknown as Sql);
  }) as Promise<T>;
}

interface PublishArgs {
  productId: string;
  draftId: string;
  draftUpdatedAt: string;
  productUpdatedAt: string | null;
  values?: unknown;
  overlay?: unknown;
  blocks: unknown[];
}

/**
 * The call as PostgREST makes it. The timestamps go as text, as PostgREST passes them: the driver
 * would turn a timestamptz parameter into a Date and drop its microseconds, and the function compares
 * them exactly. The jsonb arguments go as values (the driver encodes a jsonb parameter itself).
 */
function publishStatement(tx: Sql, args: PublishArgs, tag = 'publish') {
  return tx.unsafe(
    `/* nb-test:${tag} */ select public.publish_product_draft($1::uuid, $2::bigint, $3::text::timestamptz, $4::text::timestamptz, $5::jsonb, $6::jsonb, $7::jsonb) as result`,
    [
      args.productId,
      args.draftId,
      args.draftUpdatedAt,
      args.productUpdatedAt,
      args.values ?? null,
      args.overlay ?? null,
      args.blocks,
    ] as any[]
  );
}

async function publish(sql: Sql, args: PublishArgs, userId = ADMIN_ID): Promise<Row> {
  const rows = await asUser(sql, userId, (tx) => publishStatement(tx, args));
  return (rows as Row[])[0].result;
}

/** A deferred: a promise and the functions that settle it. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** How a session's work ended, read once every session is done (a rejection is never left unhandled). */
function settled<T>(work: Promise<T>): Promise<{ value?: T; error?: any }> {
  return work.then(
    (value) => ({ value }),
    (error) => ({ error })
  );
}

/**
 * Waits until a statement tagged `nb-test:<tag>` is waiting on a lock (or, given `like`, any statement
 * whose text matches it: the app's SQL fallback sends untagged statements).
 */
async function waitForLockWait(tag: string, like = `%nb-test:${tag}%`) {
  for (let i = 0; i < 200; i += 1) {
    const [{ waiting }] = await owner`
      select count(*)::int as waiting
        from pg_stat_activity
       where wait_event_type = 'Lock'
         and query like ${like}`;
    if (waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`nb-test:${tag} never waited on a lock`);
}

/**
 * Starts a publish in its own transaction and keeps the transaction open (with its row locks) until
 * `release()`. `ran` settles once the function returned.
 */
function holdPublish(sql: Sql, args: PublishArgs) {
  const ran = deferred<Row>();
  const gate = deferred();
  const done = asUser(sql, ADMIN_ID, async (tx) => {
    const rows = (await publishStatement(tx, args, 'holder')) as Row[];
    ran.resolve(rows[0].result);
    await gate.promise;
    return rows[0].result;
  });
  // A publish that fails fails the test at once instead of leaving it waiting.
  done.catch((error) => ran.reject(error));
  return { ran: ran.promise, done, release: gate.resolve };
}

interface SeedVariant {
  sku: string;
  price: number;
  stock: number;
  terms: string[];
  scheduledPrice?: number;
  /** The row's id (a random one when absent): the order a sale's GROUP BY takes lines in follows the ids. */
  id?: string;
}

interface Seeded {
  productId: string;
  sku: string;
  slug: string;
  groupId: string;
  draftId: string;
  variantIds: Record<string, string>;
}

const blockRow = (text: string, order: number) => ({
  language_id: 1,
  block_type: 'text',
  content: { html_content: `<p>${text}</p>` },
  order,
});

async function seedProduct(options: {
  variants?: SeedVariant[];
  gallery?: string[];
  liveBlocks?: string[];
  draftBlocks?: unknown[];
  categoryIds?: string[];
  draftMeta?: Row;
  sku?: string;
  groupId?: string;
  languageId?: number;
  createDraft?: boolean;
} = {}): Promise<Seeded> {
  const suffix = randomUUID().slice(0, 8);
  const sku = options.sku ?? `PUB-${RUN}-${suffix}`;
  const slug = `pub-${RUN}-${suffix}`;
  const groupId = options.groupId ?? randomUUID();
  const [{ id: productId }] = await owner`
    insert into public.products (language_id, translation_group_id, sku, title, slug, product_type, payment_provider, price, prices, stock, status, short_description, metadata)
    values (${options.languageId ?? 1}, ${groupId}, ${sku}, ${'Publish test ' + suffix}, ${slug}, 'physical', 'stripe', 5900,
            ${owner.json({ [currency]: 5900 })}, 7, 'active', 'Short copy', ${owner.json({ kept: true })})
    returning id`;
  created.products.push(productId);
  created.skus.push(sku);

  const variantIds: Record<string, string> = {};
  for (const variant of options.variants ?? []) {
    const [{ id }] = await owner`
      insert into public.product_variants (id, product_id, sku, price, prices, stock_quantity, scheduled_price, scheduled_prices, scheduled_price_at)
      values (${variant.id ?? randomUUID()}, ${productId}, ${variant.sku}, ${variant.price}, ${owner.json({ [currency]: variant.price })}, ${variant.stock},
              ${variant.scheduledPrice ?? null},
              ${variant.scheduledPrice ? owner.json({ [currency]: variant.scheduledPrice }) : null},
              ${variant.scheduledPrice ? '2030-01-01T00:00:00Z' : null})
      returning id`;
    for (const termId of variant.terms) {
      await owner`insert into public.variant_attribute_mapping (variant_id, attribute_term_id) values (${id}, ${termId})`;
    }
    variantIds[variant.sku] = id;
    created.skus.push(variant.sku);
  }

  for (const [index, mediaId] of (options.gallery ?? []).entries()) {
    await owner`insert into public.product_media (product_id, media_id, sort_order) values (${productId}, ${mediaId}, ${index})`;
  }
  for (const categoryId of options.categoryIds ?? []) {
    await owner`insert into public.product_categories (product_id, category_id) values (${productId}, ${categoryId})`;
  }
  for (const [index, text] of (options.liveBlocks ?? []).entries()) {
    await owner`
      insert into public.blocks (product_id, language_id, block_type, content, "order")
      values (${productId}, 1, 'text', ${owner.json({ html_content: `<p>${text}</p>` })}, ${index})`;
  }

  let draftId = '';
  if (options.createDraft !== false) {
    const [draft] = await owner`
      insert into public.product_drafts (product_id, author_id, meta, blocks)
      values (${productId}, ${WRITER_ID}, ${owner.json(options.draftMeta ?? {})},
              ${owner.json((options.draftBlocks ?? [blockRow('Draft A', 0), blockRow('Draft B', 1)]) as any)})
      returning id`;
    draftId = String(draft.id);
  }

  return { productId, sku, slug, groupId, draftId, variantIds };
}

/** The draft and product versions the server action reads before it calls the function. */
async function readForPublish(seeded: Seeded) {
  const [draft] = await owner`select id::text as id, updated_at::text as updated_at from public.product_drafts where product_id = ${seeded.productId}`;
  const [product] = await owner`select updated_at::text as updated_at from public.products where id = ${seeded.productId}`;
  return { draftId: draft?.id as string, draftUpdatedAt: draft?.updated_at as string, productUpdatedAt: (product?.updated_at ?? null) as string | null };
}

/** Everything a publish may write, as the table owner reads it: a failed one must leave all of it. */
async function productState(productId: string) {
  const [product] = await owner`select to_jsonb(p) - 'updated_at' as row, updated_at::text as updated_at from public.products p where id = ${productId}`;
  const variants = await owner`
    select v.id, v.sku, v.price, v.stock_quantity, v.scheduled_price,
           coalesce((select array_agg(m.attribute_term_id::text order by m.attribute_term_id) from public.variant_attribute_mapping m where m.variant_id = v.id), '{}') as terms
      from public.product_variants v where v.product_id = ${productId} order by v.sku`;
  const gallery = await owner`select media_id, sort_order from public.product_media where product_id = ${productId} order by sort_order`;
  const blocks = await owner`select content, "order" from public.blocks where product_id = ${productId} order by "order", id`;
  const revisions = await owner`select version, revision_type::text as type from public.product_revisions where product_id = ${productId} order by version`;
  const drafts = await owner`select id::text as id, updated_at::text as updated_at, meta from public.product_drafts where product_id = ${productId}`;
  const categoryRows = await owner`select category_id from public.product_categories where product_id = ${productId} order by category_id`;
  return { product: product?.row, updatedAt: product?.updated_at, variants, gallery, blocks, revisions, drafts, categories: categoryRows };
}

/**
 * An order with one item, not yet deducted. Insert it before a publish takes its locks: the order item's
 * foreign key check (FOR KEY SHARE on the product) waits on the publish's FOR UPDATE.
 */
async function recordOrder(item: { productId: string; variantId?: string | null; quantity: number }): Promise<string> {
  const [{ id: orderId }] = await owner`insert into public.orders (total) values (1000) returning id`;
  created.orders.push(orderId);
  await owner`
    insert into public.order_items (order_id, product_id, variant_id, quantity, price_at_purchase)
    values (${orderId}, ${item.productId}, ${item.variantId ?? null}, ${item.quantity}, 1000)`;
  return orderId;
}

/**
 * The deduction checkout runs for a paid order: apply_order_inventory_deduction (what the Stripe and
 * Freemius order syncs call) lowers the SKU's inventory row (creating it from the live stock first when
 * there is none), and the row's trigger writes the quantity back to the variants and the product. `sql`
 * runs it, so a second session can sell while a publish holds its locks.
 */
function deductOrder(sql: Sql, orderId: string, tag = 'sale') {
  // execute(): the driver sends a query only once it is awaited, and a concurrent sale must start now.
  return sql.unsafe(`/* nb-test:${tag} */ select public.apply_order_inventory_deduction($1::uuid)`, [orderId]).execute();
}

/** A sale, recorded and deducted. */
async function sell(item: { productId: string; variantId?: string | null; quantity: number }) {
  await deductOrder(owner, await recordOrder(item));
}

/** An order with one line per entry (the same variant twice makes two lines), not yet deducted. */
async function recordOrderLines(lines: Array<{ productId: string; variantId?: string | null; quantity: number }>): Promise<string> {
  const [{ id: orderId }] = await owner`insert into public.orders (total) values (1000) returning id`;
  created.orders.push(orderId);
  for (const line of lines) {
    await owner`
      insert into public.order_items (order_id, product_id, variant_id, quantity, price_at_purchase)
      values (${orderId}, ${line.productId}, ${line.variantId ?? null}, ${line.quantity}, 1000)`;
  }
  return orderId;
}

/** The deduction in one statement, in its own transaction, as checkout runs it (settled; a lock timeout fails a stuck wait). */
function saleInOneStatement(orderId: string, tag: string) {
  return settled(
    connect().begin(async (tx) => {
      await tx.unsafe(`set local lock_timeout = '10s'`);
      await tx.unsafe(`/* nb-test:${tag} */ select public.apply_order_inventory_deduction($1::uuid)`, [orderId]);
    })
  );
}

/** A publish as the ADMIN in its own transaction (settled; a lock timeout fails a stuck wait). */
function publishInSession(args: PublishArgs, tag: string) {
  return settled(
    asUser(connect(), ADMIN_ID, async (tx) => {
      await tx.unsafe(`set local lock_timeout = '10s'`);
      return publishStatement(tx, args, tag);
    })
  );
}

/** Holds the rows `query` (a SELECT ... FOR UPDATE) locks, in its own transaction, until release(). */
async function holdRows(query: string, params: unknown[] = []) {
  const held = deferred();
  const release = deferred();
  const done = settled(
    connect().begin(async (tx) => {
      await tx.unsafe(query, params as any[]);
      held.resolve();
      await release.promise;
    })
  );
  await held.promise;
  return { release: () => release.resolve(), done };
}

/** Which of `skus` have an inventory row another session holds (probed with FOR UPDATE SKIP LOCKED). */
async function lockedInventoryRows(skus: string[]): Promise<string[]> {
  const free = await owner`select sku from public.inventory_items where sku = any(${skus}::text[]) for update skip locked`;
  const rows = await owner`select sku from public.inventory_items where sku = any(${skus}::text[])`;
  const freeSkus = new Set(free.map((row: Row) => row.sku));
  return rows.map((row: Row) => row.sku as string).filter((sku) => !freeSkus.has(sku)).sort();
}

/**
 * The order 02001's deduction took an order's lines in (GROUP BY, no ORDER BY): the same query in a
 * PL/pgSQL loop, in a temporary function of the owner's session. The hash aggregate's order follows the
 * lines' ids, so a test that needs a sale to take its SKUs out of SKU order there picks ids until it does.
 */
async function groupByOrder(orderId: string): Promise<Array<string | null>> {
  await owner.unsafe(`
    create or replace function pg_temp.nb_test_group_by_order(p_order_id uuid) returns setof uuid language plpgsql as $$
    declare
      v_item record;
    begin
      for v_item in select product_id, variant_id, sum(quantity)::integer as quantity from public.order_items
                     where order_id = p_order_id group by product_id, variant_id loop
        return next v_item.variant_id;
      end loop;
    end $$`);
  const rows = await owner`select pg_temp.nb_test_group_by_order(${orderId}::uuid) as variant_id`;
  return rows.map((row: Row) => row.variant_id);
}

let fallbackModule: Promise<typeof import('@nextblock-cms/ecommerce/order-inventory')> | undefined;

/**
 * applyOrderInventoryDeduction (libs/ecommerce order-inventory.ts) with an RPC that fails, so it runs
 * its SQL fallback, applyOrderInventoryDeductionViaSql, against this database (POSTGRES_URL). The
 * fallback opens its own connection with ssl: 'require', which a local replay does not serve, so its
 * copy of 'postgres' drops the TLS option; nothing else differs.
 */
async function deductWithFallback(orderId: string) {
  fallbackModule ??= (async () => {
    vi.doMock('postgres', async (importOriginal) => {
      const actual = await importOriginal<{ default: typeof postgres }>();
      const withoutTls = ((url: string, options: Record<string, unknown> = {}) =>
        actual.default(url, { ...options, ssl: false })) as unknown as typeof postgres;
      return { ...actual, default: withoutTls };
    });
    try {
      // eslint-disable-next-line @nx/enforce-module-boundaries
      return await import('@nextblock-cms/ecommerce/order-inventory');
    } finally {
      vi.doUnmock('postgres');
    }
  })();
  const { applyOrderInventoryDeduction } = await fallbackModule;
  const failingRpc = { rpc: async () => ({ error: { message: 'simulated RPC failure (the test runs the fallback)' } }) };
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const previousUrl = process.env.POSTGRES_URL;
  process.env.POSTGRES_URL = DB_URL;
  try {
    return await applyOrderInventoryDeduction(failingRpc as never, orderId);
  } finally {
    if (previousUrl === undefined) delete process.env.POSTGRES_URL;
    else process.env.POSTGRES_URL = previousUrl;
    quiet.mockRestore();
  }
}

/** The inventory rows of `skus`, as { sku: quantity } (a SKU without a row is absent). */
async function inventoryOf(skus: string[]) {
  const rows = await owner`select sku, quantity from public.inventory_items where sku = any(${skus}::text[])`;
  return Object.fromEntries(rows.map((row: Row) => [row.sku, row.quantity]));
}

/** The stock the variant rows and the product row show (the caches the inventory trigger keeps). */
async function shownStockOf(productId: string) {
  const state = await productState(productId);
  return {
    product: state.product.stock,
    variants: Object.fromEntries(state.variants.map((variant: Row) => [variant.sku, variant.stock_quantity])),
  };
}

/** ProductForm values (major units) for a seeded product, as completeProductDraftValues hands them over. */
function formValues(seeded: Seeded, overrides: Partial<ProductFormValues> & { variants?: any[] } = {}): ProductFormValues {
  return {
    product_type: 'physical',
    payment_provider: 'stripe',
    title: 'Publish test',
    slug: seeded.slug,
    sku: seeded.sku,
    upc: null,
    price: 59,
    prices: { [currency]: 59 },
    sale_price: null,
    sale_prices: {},
    sale_start_at: null,
    sale_end_at: null,
    stock: 7,
    meta_title: null,
    meta_description: null,
    custom_canonical: null,
    short_description: 'Short copy',
    description_json: null,
    trial_period_days: 0,
    trial_requires_payment_method: false,
    is_taxable: true,
    status: 'active',
    language_id: 1,
    translation_group_id: seeded.groupId,
    variants: [],
    ...overrides,
  } as ProductFormValues;
}

function formVariant(sku: string, price: number, stock: number, termIds: string[], id?: string) {
  return {
    id,
    combination_key: termIds.join('|'),
    sku,
    upc: null,
    price,
    prices: { [currency]: price },
    sale_price: null,
    sale_prices: {},
    sale_start_at: null,
    sale_end_at: null,
    stock_quantity: stock,
    main_media_id: null,
    attribute_term_ids: termIds,
    selected_options: [],
    label: sku,
  };
}

/** A migration file without its comments, with LF line endings (a Windows checkout may have CRLF). */
function readMigration(file: string): string {
  return readFileSync(path.resolve(__dirname, '../../libs/db/src/supabase/migrations', file), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/--[^\n]*/g, '');
}

/** `schema.name` → return type, for every CREATE [OR REPLACE] FUNCTION in `sql`. */
function functionReturnTypes(sql: string): Record<string, string> {
  const types: Record<string, string> = {};
  for (const match of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([\w.]+)\s*\([^)]*\)\s*returns\s+([\w.]+)/gi)) {
    types[match[1].toLowerCase()] = match[2].toLowerCase();
  }
  return types;
}

/**
 * Without a database: a save path never deletes media (security review 2026-11-15), and the publish
 * stays a SECURITY INVOKER function (a definer one would write past the admin's RLS). The posture
 * script (section 44) and the suite below check the same on a database.
 */
describe('migration 02043 as written', () => {
  const sql = readFileSync(
    path.resolve(__dirname, '../../libs/db/src/supabase/migrations/02043_atomic_product_draft_publish.sql'),
    'utf8'
  )
    // Comments may say "media row" freely; only statements count.
    .replace(/--[^\n]*/g, '');

  it('creates each function 02044 also creates with the return type 02044 gives it: the sandbox reset replays this file over those (42P13 otherwise)', () => {
    const here = functionReturnTypes(sql);
    const later = functionReturnTypes(readMigration('02044_product_draft_publish_stock_baseline.sql'));
    const shared = Object.keys(later).filter((name) => name in here).sort();
    expect(shared).toEqual(['private.apply_product_draft_values', 'public.publish_product_draft']);
    expect(shared.map((name) => `${name} returns ${here[name]}`)).toEqual(shared.map((name) => `${name} returns ${later[name]}`));
  });

  it('drops private.apply_product_draft_values before creating it, then grants it: a database that ran an earlier copy of this file holds it RETURNS void (42P13 otherwise)', () => {
    const drop = sql.search(/drop\s+function\s+if\s+exists\s+private\.apply_product_draft_values\s*\(\s*uuid\s*,\s*jsonb\s*\)\s*;/i);
    const create = sql.search(/create\s+(?:or\s+replace\s+)?function\s+private\.apply_product_draft_values\s*\(/i);
    const revoke = sql.search(/revoke\s+all\s+on\s+function\s+private\.apply_product_draft_values\(uuid,\s*jsonb\)\s+from\s+public,\s*anon\s*;/i);
    expect(drop).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(drop);
    expect(revoke).toBeGreaterThan(create);
  });

  it('never deletes from or updates media, and never touches storage', () => {
    expect(sql).not.toMatch(/\bdelete\s+from\s+public\.media\b/i);
    expect(sql).not.toMatch(/\bupdate\s+public\.media\b/i);
    expect(sql).not.toMatch(/\bstorage\./i);
  });

  it('only unlinks from the gallery, scoped to the product, keeping the listed images', () => {
    const galleryDeletes = sql.match(/delete\s+from\s+public\.product_media[\s\S]*?;/gi) ?? [];
    expect(galleryDeletes).toHaveLength(1);
    expect(galleryDeletes[0]).toMatch(/where\s+product_id\s*=\s*p_product_id/i);
    expect(galleryDeletes[0]).toMatch(/and\s+not\s+\(media_id\s*=\s*any\s*\(v_gallery\)\)/i);
  });

  it('creates every function SECURITY INVOKER with a pinned search_path, and none in public as definer', () => {
    const functions = sql.match(/create\s+or\s+replace\s+function[\s\S]*?\bas\s+\$\$/gi) ?? [];
    expect(functions).toHaveLength(5);
    for (const header of functions) {
      expect(header).toMatch(/\bsecurity\s+invoker\b/i);
      expect(header).toMatch(/\bset\s+search_path\s+to\s+''/i);
    }
    expect(sql).not.toMatch(/\bsecurity\s+definer\b/i);
  });
});

/**
 * The same, for 02044, which re-creates the values helper and the publish (the stock baseline, the
 * inventory row locks) and replaces two 02001 functions: the inventory trigger's (the product total
 * held) and the sale's deduction (its SKU order).
 */
describe('migration 02044 as written', () => {
  const sql = readMigration('02044_product_draft_publish_stock_baseline.sql');

  /** One function's text, from its CREATE line to the end of its body. */
  function functionText(source: string, name: string): string {
    const start = source.search(new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+${name.replace('.', '\\.')}\\s*\\(`, 'i'));
    expect(start, `${name} is created`).toBeGreaterThan(-1);
    const end = source.indexOf('$$;', start);
    return source.slice(start, end + 3);
  }

  it('never deletes from or updates media, and never touches storage', () => {
    expect(sql).not.toMatch(/\bdelete\s+from\s+public\.media\b/i);
    expect(sql).not.toMatch(/\bupdate\s+public\.media\b/i);
    expect(sql).not.toMatch(/\bstorage\./i);
  });

  it('only unlinks from the gallery, scoped to the product, keeping the listed images', () => {
    const galleryDeletes = sql.match(/delete\s+from\s+public\.product_media[\s\S]*?;/gi) ?? [];
    expect(galleryDeletes).toHaveLength(1);
    expect(galleryDeletes[0]).toMatch(/where\s+product_id\s*=\s*p_product_id/i);
    expect(galleryDeletes[0]).toMatch(/and\s+not\s+\(media_id\s*=\s*any\s*\(v_gallery\)\)/i);
  });

  it("creates no definer function, the publish and its helper SECURITY INVOKER with search_path ''", () => {
    const functions = sql.match(/create\s+(?:or\s+replace\s+)?function[\s\S]*?\bas\s+\$\$/gi) ?? [];
    expect(functions).toHaveLength(4);
    for (const header of functions) {
      expect(header).toMatch(/\bset\s+search_path\s+to\s+'[^']*'/i);
    }
    const publishFunctions = functions.filter((header) => /apply_product_draft_values|publish_product_draft/i.test(header));
    expect(publishFunctions).toHaveLength(2);
    for (const header of publishFunctions) {
      expect(header).toMatch(/\bsecurity\s+invoker\b/i);
      expect(header).toMatch(/\bset\s+search_path\s+to\s+''/i);
    }
    expect(sql).not.toMatch(/\bsecurity\s+definer\b/i);
  });

  it("replaces public.sync_inventory_cache_for_sku with 02001's, statement for statement, but the product total held at 2147483647", () => {
    const baseline = functionText(readMigration('02001_baseline_schema.sql'), 'public.sync_inventory_cache_for_sku');
    const replaced = functionText(sql, 'public.sync_inventory_cache_for_sku');
    expect(replaced).toContain('stock = LEAST(COALESCE((');
    expect(replaced).toContain('), 0), 2147483647),');
    expect(replaced.replace('stock = LEAST(COALESCE((', 'stock = COALESCE((').replace('), 0), 2147483647),', '), 0),')).toBe(baseline);
  });

  it("replaces public.apply_order_inventory_deduction with 02001's, statement for statement, but its lines taken in the order of the SKU each one locks", () => {
    const baseline = functionText(readMigration('02001_baseline_schema.sql'), 'public.apply_order_inventory_deduction');
    const replaced = functionText(sql, 'public.apply_order_inventory_deduction');
    const orderBy = replaced.match(/\n {4}GROUP BY product_id, variant_id\n( {4}ORDER BY [\s\S]*?)\n {2}LOOP\n/);
    expect(orderBy, 'an ORDER BY between the GROUP BY and the LOOP').not.toBeNull();
    const clause = (orderBy as RegExpMatchArray)[1];
    // The variant's SKU when the line has a variant, else the product's: what the loop then reads and locks.
    expect(clause.replace(/\s+/g, ' ').trim()).toBe(
      'ORDER BY CASE WHEN order_items.variant_id IS NOT NULL THEN (SELECT v.sku FROM public.product_variants v WHERE v.id = order_items.variant_id) ' +
        'ELSE (SELECT p.sku FROM public.products p WHERE p.id = order_items.product_id) END, product_id, variant_id'
    );
    expect(replaced.replace(`${clause}\n`, '')).toBe(baseline);
  });

  it('creates the two SKU indexes with a plain CREATE INDEX IF NOT EXISTS (a migration runs in a transaction, where CONCURRENTLY cannot)', () => {
    const code = sql.replace(/--[^\n]*/g, '');
    expect(code).toMatch(/\bcreate\s+index\s+if\s+not\s+exists\s+idx_product_variants_sku\s+on\s+public\.product_variants\s+using\s+btree\s+\(sku\)\s*;/i);
    expect(code).toMatch(/\bcreate\s+index\s+if\s+not\s+exists\s+idx_products_sku\s+on\s+public\.products\s+using\s+btree\s+\(sku\)\s*;/i);
    expect(code).not.toMatch(/\bconcurrently\b/i);
  });

  it("locks the values' inventory rows, in SKU order, before the products row (a sale locks them in that order)", () => {
    const publish = functionText(sql, 'public.publish_product_draft');
    const inventoryLock = publish.search(/from\s+public\.inventory_items\s+i\s+where\s+i\.sku\s*=\s*any\s*\(v_stock_skus\)\s+order\s+by\s+i\.sku\s+for\s+update\s*;/i);
    const productLock = publish.search(/from\s+public\.products\s+where\s+id\s*=\s*p_product_id\s+for\s+update\s*;/i);
    expect(inventoryLock).toBeGreaterThan(-1);
    expect(productLock).toBeGreaterThan(inventoryLock);
  });

  it('takes EXECUTE on the re-created helper back from PUBLIC and anon (a new function grants it to PUBLIC)', () => {
    expect(sql).toMatch(
      /revoke\s+all\s+on\s+function\s+private\.apply_product_draft_values\(uuid,\s*jsonb\)\s+from\s+public,\s*anon\s*;/i
    );
    expect(sql).toMatch(
      /grant\s+execute\s+on\s+function\s+private\.apply_product_draft_values\(uuid,\s*jsonb\)\s+to\s+authenticated,\s*service_role\s*;/i
    );
  });
});

const describeDb = DB_URL ? describe : describe.skip;

describeDb('public.publish_product_draft on a real database (migration 02043)', { timeout: 60_000 }, () => {
  /** Its own connection, never idled out: the shared lock lasts as long as the session. */
  let testsLock: Sql | undefined;

  beforeAll(async () => {
    testsLock = postgres(DB_URL, { max: 1, onnotice: () => undefined });
    await testsLock.unsafe(`select pg_advisory_lock_shared(${DB_TESTS_LOCK})`);
    owner = connect();
    const [{ code }] = await owner`select public.get_default_currency_code() as code`;
    currency = code;

    for (const [id, email, role] of [
      [ADMIN_ID, `publish-admin-${RUN}@test.local`, 'ADMIN'],
      [WRITER_ID, `publish-writer-${RUN}@test.local`, 'WRITER'],
    ]) {
      await owner`
        insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
        values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${email}, 'x', now(), now(), '{}', '{}')`;
      await owner`update public.profiles set role = ${role} where id = ${id}`;
    }

    for (const [name, values] of [
      ['Color', ['Red', 'Blue', 'Green']],
      ['Size', ['S', 'M']],
    ] as const) {
      const [{ id: attributeId }] = await owner`
        insert into public.product_attributes (name, slug) values (${name}, ${`${name.toLowerCase()}-${RUN}`}) returning id`;
      created.attributes.push(attributeId);
      for (const value of values) {
        const [{ id }] = await owner`
          insert into public.product_attribute_terms (attribute_id, value, slug) values (${attributeId}, ${value}, ${value.toLowerCase()}) returning id`;
        terms[value] = id;
      }
    }

    for (const name of ['M1', 'M2', 'M3']) {
      const [{ id }] = await owner`
        insert into public.media (file_name, object_key, file_path, uploader_id)
        values (${`${name}.webp`}, ${`publish-test/${RUN}/${name}.webp`}, ${`publish-test/${RUN}/${name}.webp`}, ${ADMIN_ID})
        returning id`;
      media[name] = id;
    }

    for (const name of ['C1', 'C2']) {
      const [{ id }] = await owner`
        insert into public.categories (name, slug) values (${name}, ${`${name.toLowerCase()}-${RUN}`}) returning id`;
      categories[name] = id;
    }
  }, LOCK_WAIT_MS);

  afterAll(async () => {
    if (owner) {
      await owner`delete from public.orders where id = any(${created.orders}::uuid[])`;
      await owner`delete from public.products where id = any(${created.products}::uuid[])`;
      await owner`delete from public.inventory_items where sku = any(${created.skus}::text[])`;
      await owner`delete from public.media where id = any(${Object.values(media)}::uuid[])`;
      await owner`delete from public.categories where id = any(${Object.values(categories)}::uuid[])`;
      await owner`delete from public.product_attributes where id = any(${created.attributes}::uuid[])`;
      await owner`delete from auth.users where id = any(${[ADMIN_ID, WRITER_ID]}::uuid[])`;
    }
    await Promise.all(connections.map((sql) => sql.end({ timeout: 5 })));
    // Last: the replay test may drop schema public as soon as this lock is free.
    await testsLock?.end({ timeout: 5 });
  });

  it('publishes product values, the description blocks, History and the draft delete in one call', async () => {
    const seeded = await seedProduct({
      variants: [
        { sku: `R-${RUN}-1`, price: 5900, stock: 3, terms: [terms.Red], scheduledPrice: 4900 },
        { sku: `B-${RUN}-1`, price: 6400, stock: 4, terms: [terms.Blue], scheduledPrice: 5400 },
      ],
      gallery: [media.M1, media.M2],
      liveBlocks: ['Live 1', 'Live 2'],
      categoryIds: [categories.C1],
    });
    const before = await productState(seeded.productId);
    const read = await readForPublish(seeded);
    const values = buildProductDraftPublishValues(
      formValues(seeded, {
        title: 'Publish test (edited)',
        price: 69,
        prices: { [currency]: 69 },
        meta_title: '  Edited meta  ',
        product_media: [
          { media_id: media.M2 },
          { media_id: media.M3.toUpperCase() },
          { media_id: randomUUID() },
          { media_id: media.M2 },
          { media_id: 'not-a-uuid' },
        ],
        category_ids: [categories.C2, randomUUID()],
        variants: [
          formVariant(`R-${RUN}-1`, 62, 5, [terms.Red], seeded.variantIds[`R-${RUN}-1`]),
          formVariant(`B-${RUN}-1`, 64, 4, [terms.Blue], seeded.variantIds[`B-${RUN}-1`]),
        ],
      })
    );

    const result = await publish(owner, { productId: seeded.productId, ...read, values, blocks: [blockRow('Draft A', 0), blockRow('Draft B', 1)] });

    expect(result).toMatchObject({
      product_id: seeded.productId,
      previous_slug: seeded.slug,
      slug: seeded.slug,
      payment_provider: 'stripe',
      wrote_values: true,
      revision: { recorded: true, version: 2 },
    });
    const after = await productState(seeded.productId);
    expect(after.product).toMatchObject({
      title: 'Publish test (edited)',
      price: 6900,
      status: 'active',
      meta_title: 'Edited meta',
      // Never written by a publish (upsert_product_with_variants reset it to {}).
      metadata: { kept: true },
      version: 2,
    });
    // Same rows, same ids: order items and cart lines keep them, and the pending prices stay.
    expect(after.variants.map((v: Row) => [v.id, v.sku, v.price, v.stock_quantity, v.scheduled_price])).toEqual([
      [seeded.variantIds[`B-${RUN}-1`], `B-${RUN}-1`, 6400, 4, 5400],
      [seeded.variantIds[`R-${RUN}-1`], `R-${RUN}-1`, 6200, 5, 4900],
    ]);
    // The listed images that still exist, once each, in order; the dropped one is only unlinked.
    expect(after.gallery.map((g: Row) => [g.media_id, g.sort_order])).toEqual([
      [media.M2, 0],
      [media.M3, 1],
    ]);
    expect(await owner`select id from public.media where id = ${media.M1}`).toHaveLength(1);
    expect(after.categories.map((c: Row) => c.category_id)).toEqual([categories.C2]);
    expect(after.blocks.map((b: Row) => b.content.html_content)).toEqual(['<p>Draft A</p>', '<p>Draft B</p>']);
    expect(after.drafts).toEqual([]);
    // No snapshot existed, so the content before is recorded as version 1, then the publish as 2.
    expect(after.revisions).toEqual([
      { version: 1, type: 'snapshot' },
      { version: 2, type: 'snapshot' },
    ]);
    const [{ content: base }] = await owner`select content from public.product_revisions where product_id = ${seeded.productId} and version = 1`;
    const [{ content: published }] = await owner`select content from public.product_revisions where product_id = ${seeded.productId} and version = 2`;
    expect(base.blocks.map((b: Row) => b.content.html_content)).toEqual(['<p>Live 1</p>', '<p>Live 2</p>']);
    expect(base.commerce.price).toBe(5900);
    expect(published.commerce.price).toBe(6900);
    expect(published.commerce.gallery).toEqual([media.M2, media.M3]);
    expect(published.commerce.variants.map((v: Row) => [v.sku, v.price, v.scheduled_price])).toEqual([
      [`B-${RUN}-1`, 6400, 5400],
      [`R-${RUN}-1`, 6200, 4900],
    ]);
    const inventory = await owner`select sku, quantity from public.inventory_items where sku = any(${[`R-${RUN}-1`, `B-${RUN}-1`]}::text[]) order by sku`;
    expect(inventory.map((i: Row) => [i.sku, i.quantity])).toEqual([
      [`B-${RUN}-1`, 4],
      [`R-${RUN}-1`, 5],
    ]);
    expect(before.variants.map((v: Row) => v.id).sort()).toEqual(after.variants.map((v: Row) => v.id).sort());
  });

  it('keeps a variant row when its term set matches (SKUs may swap), deletes only a dropped term set and inserts a new one', async () => {
    const seeded = await seedProduct({
      variants: [
        { sku: `SW-A-${RUN}`, price: 1000, stock: 1, terms: [terms.Red] },
        { sku: `SW-B-${RUN}`, price: 2000, stock: 2, terms: [terms.Blue] },
        { sku: `SW-C-${RUN}`, price: 3000, stock: 3, terms: [terms.Green] },
      ],
    });
    created.skus.push(`SW-N-${RUN}`);
    const [{ id: orderId }] = await owner`insert into public.orders (total) values (1000) returning id`;
    created.orders.push(orderId);
    await owner`
      insert into public.order_items (order_id, product_id, variant_id, quantity, price_at_purchase)
      values (${orderId}, ${seeded.productId}, ${seeded.variantIds[`SW-A-${RUN}`]}, 1, 1000),
             (${orderId}, ${seeded.productId}, ${seeded.variantIds[`SW-C-${RUN}`]}, 1, 3000)`;
    const read = await readForPublish(seeded);
    const values = buildProductDraftPublishValues(
      formValues(seeded, {
        variants: [
          // Red and Blue swap SKUs; Green is gone; Red + S is a new combination. No draft ids at all:
          // the term set alone finds the row.
          formVariant(`SW-B-${RUN}`, 11, 1, [terms.Red]),
          formVariant(`SW-A-${RUN}`, 21, 2, [terms.Blue]),
          formVariant(`SW-N-${RUN}`, 31, 6, [terms.S, terms.Red]),
        ],
      })
    );

    await publish(owner, { productId: seeded.productId, ...read, values, blocks: [] });

    const after = await productState(seeded.productId);
    const bySku = Object.fromEntries(after.variants.map((v: Row) => [v.sku, v]));
    expect(bySku[`SW-B-${RUN}`].id).toBe(seeded.variantIds[`SW-A-${RUN}`]);
    expect(bySku[`SW-B-${RUN}`].terms).toEqual([terms.Red]);
    expect(bySku[`SW-A-${RUN}`].id).toBe(seeded.variantIds[`SW-B-${RUN}`]);
    expect(bySku[`SW-N-${RUN}`].id).not.toBe(seeded.variantIds[`SW-C-${RUN}`]);
    expect(bySku[`SW-N-${RUN}`].terms).toEqual([terms.Red, terms.S].sort());
    expect(Object.keys(bySku)).toHaveLength(3);
    const items = await owner`select variant_id, price_at_purchase from public.order_items where order_id = ${orderId} order by price_at_purchase`;
    // The kept row keeps its order item link; the dropped one loses it (ON DELETE SET NULL), as before.
    expect(items.map((i: Row) => i.variant_id)).toEqual([seeded.variantIds[`SW-A-${RUN}`], null]);
  });

  it('prefers the live variant with the draft variant’s own id when two live variants share its terms', async () => {
    const seeded = await seedProduct({
      variants: [
        { sku: `DUP-1-${RUN}`, price: 1000, stock: 1, terms: [terms.Red] },
        { sku: `DUP-2-${RUN}`, price: 2000, stock: 2, terms: [terms.Red] },
      ],
    });
    const read = await readForPublish(seeded);
    const values = buildProductDraftPublishValues(
      formValues(seeded, { variants: [formVariant(`DUP-2-${RUN}`, 25, 2, [terms.Red], seeded.variantIds[`DUP-2-${RUN}`])] })
    );

    await publish(owner, { productId: seeded.productId, ...read, values, blocks: [] });

    const after = await productState(seeded.productId);
    expect(after.variants.map((v: Row) => [v.id, v.price])).toEqual([[seeded.variantIds[`DUP-2-${RUN}`], 2500]]);
  });

  it('writes nothing when a step fails part way: a new variant naming a missing attribute term rolls back the product, variants, gallery, blocks and History', async () => {
    const seeded = await seedProduct({
      variants: [{ sku: `FAIL-R-${RUN}`, price: 5900, stock: 3, terms: [terms.Red] }],
      gallery: [media.M1],
      liveBlocks: ['Live 1'],
    });
    const before = await productState(seeded.productId);
    const read = await readForPublish(seeded);
    const values = buildProductDraftPublishValues(
      formValues(seeded, {
        price: 99,
        prices: { [currency]: 99 },
        product_media: [{ media_id: media.M2 }],
        variants: [
          formVariant(`FAIL-R-${RUN}`, 99, 9, [terms.Red]),
          formVariant(`FAIL-X-${RUN}`, 99, 9, [randomUUID()]),
        ],
      })
    );

    await expect(
      publish(owner, { productId: seeded.productId, ...read, values, blocks: [blockRow('Draft', 0)] })
    ).rejects.toMatchObject({ code: '23503' });

    expect(await productState(seeded.productId)).toEqual(before);
  });

  it('a draft saved after the app read it is refused (NBP02) with nothing written, and the save stays in the draft', async () => {
    const seeded = await seedProduct({ liveBlocks: ['Live 1'] });
    const read = await readForPublish(seeded);
    const writer = connect();
    const saved = await asUser(writer, WRITER_ID, (tx) =>
      tx`update public.product_drafts set meta = meta || '{"short_description":"Saved meanwhile"}'::jsonb where id = ${read.draftId} returning id`
    );
    expect(saved).toHaveLength(1);
    const before = await productState(seeded.productId);

    await expect(
      publish(owner, { productId: seeded.productId, ...read, overlay: { title: 'Never written' }, blocks: [blockRow('Draft', 0)] })
    ).rejects.toMatchObject({ code: 'NBP02' });

    const after = await productState(seeded.productId);
    expect(after).toEqual(before);
    expect(after.drafts[0].meta).toEqual({ short_description: 'Saved meanwhile' });
  });

  it("a save that waits on a publish's lock finds the draft gone: its UPDATE returns no row, and an upsert starts a new draft", async () => {
    const seeded = await seedProduct({ liveBlocks: ['Live 1'] });
    const read = await readForPublish(seeded);
    const holder = holdPublish(connect(), { productId: seeded.productId, ...read, overlay: { title: 'Published title' }, blocks: [blockRow('Draft', 0)] });
    await holder.ran;

    const inPageSave = asUser(connect(), WRITER_ID, (tx) =>
      tx`/* nb-test:update-save */ update public.product_drafts set meta = '{"title":"Lost?"}'::jsonb where id = ${read.draftId} returning id`
    );
    const autosave = asUser(connect(), WRITER_ID, (tx) =>
      tx`/* nb-test:upsert-save */
         insert into public.product_drafts (product_id, author_id, meta, blocks)
         values (${seeded.productId}, ${WRITER_ID}, '{"title":"Typed during the publish"}'::jsonb, '[]'::jsonb)
         on conflict (product_id) do update set meta = excluded.meta
         returning id::text as id`
    );
    await waitForLockWait('update-save');
    await waitForLockWait('upsert-save');
    holder.release();
    await holder.done;

    // The in-page save's UPDATE matched nothing: the app reports that instead of a success.
    await expect(inPageSave).resolves.toHaveLength(0);
    // The autosave's upsert (what the form does once its update finds no row) is a new draft.
    const [newDraft] = await autosave;
    expect(newDraft.id).not.toBe(read.draftId);
    const after = await productState(seeded.productId);
    expect(after.product.title).toBe('Published title');
    expect(after.drafts.map((d: Row) => d.meta)).toEqual([{ title: 'Typed during the publish' }]);
  });

  it.each([
    ['with live description blocks', ['Live 1', 'Live 2']],
    ['with no live description blocks', [] as string[]],
  ])('two publishes of one draft %s: the second waits on the lock, finds the draft gone (NBP01), and the description is replaced once', async (_label, liveBlocks) => {
    const seeded = await seedProduct({ liveBlocks });
    const read = await readForPublish(seeded);
    const args = { productId: seeded.productId, ...read, overlay: { title: 'Published once' }, blocks: [blockRow('Draft A', 0), blockRow('Draft B', 1)] };
    const first = holdPublish(connect(), args);
    await first.ran;

    const second = asUser(connect(), ADMIN_ID, (tx) => publishStatement(tx, args, 'second-publish'));
    await waitForLockWait('second-publish');
    first.release();
    await first.done;

    await expect(second).rejects.toMatchObject({ code: 'NBP01' });
    const after = await productState(seeded.productId);
    expect(after.blocks.map((b: Row) => b.content.html_content)).toEqual(['<p>Draft A</p>', '<p>Draft B</p>']);
    expect(after.product.title).toBe('Published once');
    expect(after.drafts).toEqual([]);
    expect(after.revisions.map((r: Row) => r.version)).toEqual([1, 2]);
  });

  it('a publish that read the draft before another publish committed writes nothing (NBP01)', async () => {
    const seeded = await seedProduct({ liveBlocks: ['Live 1'] });
    const read = await readForPublish(seeded);
    const args = { productId: seeded.productId, ...read, overlay: { title: 'First' }, blocks: [blockRow('Draft', 0)] };

    await publish(owner, args);
    const afterFirst = await productState(seeded.productId);
    await expect(publish(owner, { ...args, overlay: { title: 'Second' } })).rejects.toMatchObject({ code: 'NBP01' });

    expect(await productState(seeded.productId)).toEqual(afterFirst);
  });

  it('refuses a product written after the app read it (NBP03) with nothing written', async () => {
    const seeded = await seedProduct({ liveBlocks: ['Live 1'] });
    const read = await readForPublish(seeded);
    // A Cortex field update, a sync or a sale between the read and the call.
    await owner`update public.products set title = 'Changed meanwhile', updated_at = now() + interval '1 second' where id = ${seeded.productId}`;
    const before = await productState(seeded.productId);

    await expect(
      publish(owner, { productId: seeded.productId, ...read, overlay: { title: 'Stale' }, blocks: [blockRow('Draft', 0)] })
    ).rejects.toMatchObject({ code: 'NBP03' });

    expect(await productState(seeded.productId)).toEqual(before);
  });

  it('an overlay publish writes only its fields (with updated_at); a block-only one writes no product column', async () => {
    const seeded = await seedProduct({
      variants: [{ sku: `OV-R-${RUN}`, price: 5900, stock: 3, terms: [terms.Red], scheduledPrice: 4000 }],
      liveBlocks: ['Live 1'],
    });
    const before = await productState(seeded.productId);
    const read = await readForPublish(seeded);

    await publish(owner, {
      productId: seeded.productId,
      ...read,
      overlay: { title: 'Overlay title', description_json: null },
      blocks: [blockRow('Draft', 0)],
    });

    const after = await productState(seeded.productId);
    expect(after.product).toMatchObject({ title: 'Overlay title', description_json: null, price: 5900, short_description: 'Short copy' });
    expect(after.updatedAt).not.toBe(before.updatedAt);
    expect(after.variants).toEqual(before.variants);

    const blockOnly = await seedProduct({ liveBlocks: ['Live 1'] });
    const blockOnlyBefore = await productState(blockOnly.productId);
    await publish(owner, { productId: blockOnly.productId, ...(await readForPublish(blockOnly)), overlay: {}, blocks: [blockRow('Only blocks', 0)] });
    const blockOnlyAfter = await productState(blockOnly.productId);
    expect(blockOnlyAfter.product).toEqual({ ...blockOnlyBefore.product, version: 2 });
    expect(blockOnlyAfter.updatedAt).toBe(blockOnlyBefore.updatedAt);
    expect(blockOnlyAfter.blocks.map((b: Row) => b.content.html_content)).toEqual(['<p>Only blocks</p>']);
  });

  it('History records a publish that only changes a price, and nothing for one that changes nothing', async () => {
    const seeded = await seedProduct({ draftBlocks: [] });
    const liveTitle: string = (await productState(seeded.productId)).product.title;
    const unchanged = buildProductDraftPublishValues(formValues(seeded, { title: liveTitle }));

    const noop = await publish(owner, { productId: seeded.productId, ...(await readForPublish(seeded)), values: unchanged, blocks: [] });
    expect(noop.revision).toEqual({ recorded: false, version: 1 });
    expect((await productState(seeded.productId)).revisions).toEqual([]);

    await owner`insert into public.product_drafts (product_id, meta, blocks) values (${seeded.productId}, '{}'::jsonb, '[]'::jsonb)`;
    const repriced = buildProductDraftPublishValues(formValues(seeded, { title: liveTitle, price: 64, prices: { [currency]: 64 } }));
    const priced = await publish(owner, { productId: seeded.productId, ...(await readForPublish(seeded)), values: repriced, blocks: [] });

    expect(priced.revision).toEqual({ recorded: true, version: 2 });
    const revisions = await owner`select version, content from public.product_revisions where product_id = ${seeded.productId} order by version`;
    expect(revisions.map((r: Row) => [r.version, r.content.commerce.price])).toEqual([
      [1, 5900],
      [2, 6400],
    ]);
    expect(revisions[0].content.meta).toEqual(revisions[1].content.meta);
    expect(revisions[0].content.blocks).toEqual(revisions[1].content.blocks);
  });

  it('carries the sale window to a translation sharing the SKU and the categories to the translation group', async () => {
    const seeded = await seedProduct({ categoryIds: [categories.C1] });
    const translation = await seedProduct({ sku: seeded.sku, groupId: seeded.groupId, languageId: 2, createDraft: false, categoryIds: [categories.C1] });
    const read = await readForPublish(seeded);
    const values = buildProductDraftPublishValues(
      formValues(seeded, {
        sale_price: 49,
        sale_prices: { [currency]: 49 },
        sale_start_at: '2030-02-01T00:00:00.000Z',
        sale_end_at: '2030-03-01T00:00:00.000Z',
        category_ids: [categories.C2],
      })
    );

    await publish(owner, { productId: seeded.productId, ...read, values, blocks: [] });

    const [row] = await owner`
      select sale_price, sale_start_at = '2030-02-01T00:00:00Z'::timestamptz as start_ok, sale_end_at = '2030-03-01T00:00:00Z'::timestamptz as end_ok
        from public.products where id = ${translation.productId}`;
    expect(row).toEqual({ sale_price: 4900, start_ok: true, end_ok: true });
    const translationCategories = await owner`select category_id from public.product_categories where product_id = ${translation.productId}`;
    expect(translationCategories.map((c: Row) => c.category_id)).toEqual([categories.C2]);
  });

  it('refuses anyone but an ADMIN with nothing written, and anon cannot call it at all', async () => {
    const seeded = await seedProduct({ liveBlocks: ['Live 1'] });
    const before = await productState(seeded.productId);

    await expect(
      publish(connect(), { productId: seeded.productId, ...(await readForPublish(seeded)), overlay: { title: 'By a writer' }, blocks: [] }, WRITER_ID)
    ).rejects.toMatchObject({ code: '42501' });
    expect(await productState(seeded.productId)).toEqual(before);

    const [privileges] = await owner`
      select has_function_privilege('anon', 'public.publish_product_draft(uuid, bigint, timestamptz, timestamptz, jsonb, jsonb, jsonb)', 'execute') as anon_publish,
             has_function_privilege('anon', 'public.product_revision_content(uuid)', 'execute') as anon_content,
             has_function_privilege('authenticated', 'public.publish_product_draft(uuid, bigint, timestamptz, timestamptz, jsonb, jsonb, jsonb)', 'execute') as authenticated_publish,
             has_function_privilege('anon', 'private.apply_product_draft_values(uuid, jsonb)', 'execute') as anon_values`;
    expect(privileges).toEqual({ anon_publish: false, anon_content: false, authenticated_publish: true, anon_values: false });
  });

  describe('the stock (migration 02044): written only where the editor changed it', () => {
    // Section 5: without them each SKU a publish writes scanned the products table and the variants' whole
    // (product_id, sku) key under the ADMIN's row policies (500 changed SKUs beside 50 other products: 10 s
    // or more, past the Data API's 8 s; about 5 s with them).
    it('indexes the variants and the products by SKU (section 5)', async () => {
      const rows = await owner<{ indexdef: string }[]>`
        select indexdef from pg_indexes
         where schemaname = 'public' and indexname in ('idx_product_variants_sku', 'idx_products_sku')
         order by indexname`;
      expect(rows.map((row) => row.indexdef)).toEqual([
        'CREATE INDEX idx_product_variants_sku ON public.product_variants USING btree (sku)',
        'CREATE INDEX idx_products_sku ON public.products USING btree (sku)',
      ]);
    });

    /**
     * A product with Red and Blue variants and their inventory rows, as the edit page loads it: the
     * form's stock_baseline is the stock it shows.
     */
    async function seedStockProduct(red: number, blue: number, extra: { gallery?: string[] } = {}) {
      const skus = { red: `ST-R-${RUN}-${randomUUID().slice(0, 4)}`, blue: `ST-B-${RUN}-${randomUUID().slice(0, 4)}` };
      const seeded = await seedProduct({
        variants: [
          { sku: skus.red, price: 5900, stock: red, terms: [terms.Red] },
          { sku: skus.blue, price: 5900, stock: blue, terms: [terms.Blue] },
        ],
        gallery: extra.gallery,
        draftBlocks: [],
      });
      await owner`insert into public.inventory_items (sku, quantity) values (${skus.red}, ${red}), (${skus.blue}, ${blue})`;
      return { seeded, ...skus, baseline: { [skus.red]: red, [skus.blue]: blue } };
    }

    /** The draft's values: the form's variants with `stock` quantities, and what the page loaded. */
    function stockValues(
      product: Awaited<ReturnType<typeof seedStockProduct>>,
      stock: { red: number; blue: number },
      overrides: Partial<ProductFormValues> = {}
    ) {
      return buildProductDraftPublishValues(
        formValues(product.seeded, {
          stock_baseline: product.baseline,
          variants: [
            formVariant(product.red, 59, stock.red, [terms.Red], product.seeded.variantIds[product.red]),
            formVariant(product.blue, 59, stock.blue, [terms.Blue], product.seeded.variantIds[product.blue]),
          ],
          ...overrides,
        })
      );
    }

    it('a sale between the page load and the publish keeps its deduction: a stock the editor left alone is never written back', async () => {
      const product = await seedStockProduct(5, 3);
      // The page loaded Red 5 and Blue 3, and the form autosaved an unrelated edit with them. Then a
      // shopper bought one Red, before Publish.
      await sell({ productId: product.seeded.productId, variantId: product.seeded.variantIds[product.red], quantity: 1 });
      expect(await inventoryOf([product.red])).toEqual({ [product.red]: 4 });

      const values = stockValues(product, { red: 5, blue: 3 }, { price: 64, prices: { [currency]: 64 } });
      const result = await publish(owner, { productId: product.seeded.productId, ...(await readForPublish(product.seeded)), values, blocks: [] });

      expect(await inventoryOf([product.red, product.blue])).toEqual({ [product.red]: 4, [product.blue]: 3 });
      expect(await shownStockOf(product.seeded.productId)).toEqual({
        product: 7,
        variants: { [product.red]: 4, [product.blue]: 3 },
      });
      expect(result.stock_adjusted).toEqual([]);
      const after = await productState(product.seeded.productId);
      expect(after.product.price).toBe(6400);
      const [{ content }] = await owner`
        select content from public.product_revisions where product_id = ${product.seeded.productId} order by version desc limit 1`;
      expect(Object.fromEntries(content.commerce.variants.map((v: Row) => [v.sku, v.stock_quantity]))).toEqual({
        [product.red]: 4,
        [product.blue]: 3,
      });
    });

    it('an edited stock still publishes: with nothing sold meanwhile, exactly the quantity typed', async () => {
      const product = await seedStockProduct(5, 3);

      const values = stockValues(product, { red: 9, blue: 3 });
      const result = await publish(owner, { productId: product.seeded.productId, ...(await readForPublish(product.seeded)), values, blocks: [] });

      expect(await inventoryOf([product.red, product.blue])).toEqual({ [product.red]: 9, [product.blue]: 3 });
      expect(await shownStockOf(product.seeded.productId)).toEqual({
        product: 12,
        variants: { [product.red]: 9, [product.blue]: 3 },
      });
      expect(result.stock_adjusted).toEqual([]);
    });

    it('an edited stock with a sale meanwhile: the change lands on the current quantity (never below 0), and the answer names each SKU (moved), in SKU order', async () => {
      const product = await seedStockProduct(5, 3);
      await sell({ productId: product.seeded.productId, variantId: product.seeded.variantIds[product.red], quantity: 1 });
      // All three Blue: with two sold, the live 1 would equal the 1 typed below, which is left alone.
      await sell({ productId: product.seeded.productId, variantId: product.seeded.variantIds[product.blue], quantity: 3 });

      // Red restocked from 5 to 15 (+10), Blue lowered from 3 to 1 (-2), on the page loaded before the sales.
      const values = stockValues(product, { red: 15, blue: 1 });
      const result = await publish(owner, { productId: product.seeded.productId, ...(await readForPublish(product.seeded)), values, blocks: [] });

      expect(await inventoryOf([product.red, product.blue])).toEqual({ [product.red]: 14, [product.blue]: 0 });
      expect(await shownStockOf(product.seeded.productId)).toEqual({
        product: 14,
        variants: { [product.red]: 14, [product.blue]: 0 },
      });
      // ST-B-… sorts before ST-R-… in any collation.
      expect(result.stock_adjusted).toEqual([
        { sku: product.blue, reason: 'moved', entered: 1, loaded: 3, current: 0, published: 0 },
        { sku: product.red, reason: 'moved', entered: 15, loaded: 5, current: 4, published: 14 },
      ]);
    });

    it('names the SKUs in code-point order (COLLATE "C", the order the edit page sorts its notes in), whatever the database collation', async () => {
      // By code point 'ST-Y-…' comes first (Y is 0x59, x is 0x78); en_US.UTF-8, the replay's collation, puts 'ST-x-…' first.
      const lower = `ST-x-${RUN}-${randomUUID().slice(0, 4)}`;
      const upper = `ST-Y-${RUN}-${randomUUID().slice(0, 4)}`;
      const seeded = await seedProduct({
        variants: [
          { sku: lower, price: 5900, stock: 5, terms: [terms.Red] },
          { sku: upper, price: 5900, stock: 5, terms: [terms.Blue] },
        ],
        draftBlocks: [],
      });
      await owner`insert into public.inventory_items (sku, quantity) values (${lower}, 5), (${upper}, 5)`;
      await sell({ productId: seeded.productId, variantId: seeded.variantIds[lower], quantity: 1 });
      await sell({ productId: seeded.productId, variantId: seeded.variantIds[upper], quantity: 1 });

      // Both restocked from 5 to 9 on the page loaded before the sales.
      const values = buildProductDraftPublishValues(
        formValues(seeded, {
          stock_baseline: { [lower]: 5, [upper]: 5 },
          variants: [
            formVariant(lower, 59, 9, [terms.Red], seeded.variantIds[lower]),
            formVariant(upper, 59, 9, [terms.Blue], seeded.variantIds[upper]),
          ],
        })
      );
      const result = await publish(owner, { productId: seeded.productId, ...(await readForPublish(seeded)), values, blocks: [] });

      expect(result.stock_adjusted).toEqual([
        { sku: upper, reason: 'moved', entered: 9, loaded: 5, current: 4, published: 8 },
        { sku: lower, reason: 'moved', entered: 9, loaded: 5, current: 4, published: 8 },
      ]);
      expect(await inventoryOf([lower, upper])).toEqual({ [lower]: 8, [upper]: 8 });
    });

    it('a quantity a sale reached meanwhile is left alone, and the answer names it (already_live): loaded 10, 9 typed for a damaged unit, one sold', async () => {
      const product = await seedStockProduct(10, 3);
      await sell({ productId: product.seeded.productId, variantId: product.seeded.variantIds[product.red], quantity: 1 });

      // Red lowered from 10 to 9 on the page loaded before the sale: the live 9 is what was typed.
      const values = stockValues(product, { red: 9, blue: 3 });
      const result = await publish(owner, { productId: product.seeded.productId, ...(await readForPublish(product.seeded)), values, blocks: [] });

      // 9 stays where 8 was meant: the values cannot tell this from a change already published, so the
      // answer names the SKU and the app warns. Blue, left as loaded, is not named.
      expect(await inventoryOf([product.red, product.blue])).toEqual({ [product.red]: 9, [product.blue]: 3 });
      expect(result.stock_adjusted).toEqual([
        { sku: product.red, reason: 'already_live', entered: 9, loaded: 10, current: 9, published: 9 },
      ]);
    });

    it('one publish answers both kinds, in SKU order: a change applied to a moved stock (moved) and a quantity already live (already_live)', async () => {
      const product = await seedStockProduct(5, 3);
      await sell({ productId: product.seeded.productId, variantId: product.seeded.variantIds[product.red], quantity: 1 });
      await sell({ productId: product.seeded.productId, variantId: product.seeded.variantIds[product.blue], quantity: 2 });

      // Red restocked from 5 to 15; Blue lowered from 3 to 1, which the two Blue sales reached meanwhile.
      const values = stockValues(product, { red: 15, blue: 1 });
      const result = await publish(owner, { productId: product.seeded.productId, ...(await readForPublish(product.seeded)), values, blocks: [] });

      expect(await inventoryOf([product.red, product.blue])).toEqual({ [product.red]: 14, [product.blue]: 1 });
      expect(result.stock_adjusted).toEqual([
        { sku: product.blue, reason: 'already_live', entered: 1, loaded: 3, current: 1, published: 1 },
        { sku: product.red, reason: 'moved', entered: 15, loaded: 5, current: 4, published: 14 },
      ]);
    });

    it('a draft started again after its publish, still carrying the baseline from before it, does not apply the same change twice, and the answer names the SKU (already_live)', async () => {
      const product = await seedStockProduct(5, 3);
      // The page loaded Red 5, the editor typed 10, and the draft was published.
      const first = await publish(owner, {
        productId: product.seeded.productId,
        ...(await readForPublish(product.seeded)),
        values: stockValues(product, { red: 10, blue: 3 }),
        blocks: [],
      });
      expect(await inventoryOf([product.red])).toEqual({ [product.red]: 10 });
      expect(first.stock_adjusted).toEqual([]);

      // An autosave that ran after the commit (or another tab) found the draft gone and started a new
      // one from the form's values: Red 10 beside the baseline the page loaded before the publish.
      await owner`insert into public.product_drafts (product_id, author_id, meta, blocks) values (${product.seeded.productId}, ${WRITER_ID}, '{}'::jsonb, '[]'::jsonb)`;
      const again = stockValues(product, { red: 10, blue: 3 }, { title: 'Publish test (edited after the publish)' });
      expect(again.stock_baseline).toEqual({ [product.red]: 5, [product.blue]: 3 });
      const second = await publish(owner, { productId: product.seeded.productId, ...(await readForPublish(product.seeded)), values: again, blocks: [] });

      // 10, not 10 + 10 - 5: the change is live already. The answer still names Red: a sale that reached
      // the same quantity would look the same.
      expect(await inventoryOf([product.red, product.blue])).toEqual({ [product.red]: 10, [product.blue]: 3 });
      expect(await shownStockOf(product.seeded.productId)).toEqual({
        product: 13,
        variants: { [product.red]: 10, [product.blue]: 3 },
      });
      expect(second.stock_adjusted).toEqual([
        { sku: product.red, reason: 'already_live', entered: 10, loaded: 5, current: 10, published: 10 },
      ]);
      expect((await productState(product.seeded.productId)).product.title).toBe('Publish test (edited after the publish)');
    });

    it('a crafted baseline does nothing beside a quantity equal to the live stock, and the answer names the SKU (already_live)', async () => {
      const product = await seedStockProduct(4, 3);
      // A WRITER's PATCH over PostgREST: the live quantities beside a baseline saying the page loaded Red
      // 1004. The form shows 4, so nothing looks changed; until 2026-11-18 the publish wrote
      // max(0, 4 + 4 - 1004) = 0.
      const values = stockValues(product, { red: 4, blue: 3 }, { stock_baseline: { [product.red]: 1004, [product.blue]: 3 } });
      const result = await publish(owner, { productId: product.seeded.productId, ...(await readForPublish(product.seeded)), values, blocks: [] });

      expect(await inventoryOf([product.red, product.blue])).toEqual({ [product.red]: 4, [product.blue]: 3 });
      expect(await shownStockOf(product.seeded.productId)).toEqual({
        product: 7,
        variants: { [product.red]: 4, [product.blue]: 3 },
      });
      expect(result.stock_adjusted).toEqual([
        { sku: product.red, reason: 'already_live', entered: 4, loaded: 1004, current: 4, published: 4 },
      ]);
    });

    /**
     * `values` with each variant's stock_quantity set to `quantities[i]` as it is (no key for undefined):
     * a hand-written draft as the function receives it, whatever the app does with such a quantity first.
     */
    function withRawQuantities(values: unknown, quantities: unknown[]): Row {
      const payload = values as Row;
      return {
        ...payload,
        variants: (payload.variants as Row[]).map((variant, index) => {
          const raw: Row = { ...variant };
          if (quantities[index] === undefined) delete raw.stock_quantity;
          else raw.stock_quantity = quantities[index];
          return raw;
        }),
      };
    }

    it("reads a quantity like the edit page's reader (readDraftStockQuantity): a number or plain decimal text, cut to its whole part, from 0 up; null or none is 0", async () => {
      const cases: Array<{ quantity: unknown; terms: string[]; reads: number }> = [
        { quantity: ' 7 ', terms: [terms.Red], reads: 7 },
        { quantity: '5.9', terms: [terms.Blue], reads: 5 },
        { quantity: '-3', terms: [terms.Green], reads: 0 },
        { quantity: '1e3', terms: [terms.S], reads: 1000 },
        { quantity: 5.9, terms: [terms.M], reads: 5 },
        { quantity: null, terms: [terms.Red, terms.S], reads: 0 },
        { quantity: undefined, terms: [terms.Red, terms.M], reads: 0 },
        { quantity: '\t+.5e1\n', terms: [terms.Blue, terms.S], reads: 5 },
      ];
      const skus = cases.map((_, index) => `ST-Q${index}-${RUN}-${randomUUID().slice(0, 4)}`);
      const seeded = await seedProduct({
        variants: cases.map((entry, index) => ({ sku: skus[index], price: 5900, stock: 1, terms: entry.terms })),
        draftBlocks: [],
      });
      // No baseline: each SKU is written as the draft holds it, so its inventory row shows the reading.
      const values = withRawQuantities(
        buildProductDraftPublishValues(
          formValues(seeded, { variants: cases.map((entry, index) => formVariant(skus[index], 59, 0, entry.terms, seeded.variantIds[skus[index]])) })
        ),
        cases.map((entry) => entry.quantity)
      );
      const result = await publish(owner, { productId: seeded.productId, ...(await readForPublish(seeded)), values, blocks: [] });

      const reads = Object.fromEntries(cases.map((entry, index) => [skus[index], entry.reads]));
      expect(await inventoryOf(skus)).toEqual(reads);
      expect(await shownStockOf(seeded.productId)).toEqual({ product: 1022, variants: reads });
      expect(result.stock_adjusted).toEqual([]);

      // A product without variants: its stock, the same way. '1e400' is past 2147483647, which the edit
      // page refuses instead (JavaScript reads it as Infinity); the app sends whole numbers, so the
      // function never reads such text from it.
      for (const [stock, reading] of [[' 12.9 ', 12], ['1e400', 2147483647]] as const) {
        const simple = await seedProduct({ draftBlocks: [] });
        const simpleValues = { ...buildProductDraftPublishValues(formValues(simple)), stock };
        await publish(owner, { productId: simple.productId, ...(await readForPublish(simple)), values: simpleValues, blocks: [] });
        expect(await inventoryOf([simple.sku])).toEqual({ [simple.sku]: reading });
        expect((await productState(simple.productId)).product.stock).toBe(reading);
      }
    });

    it("refuses a quantity that is not a number or plain decimal text, or that numeric cannot hold (NBP04, naming the SKU), with nothing written: numeric input alone takes 'NaN' and 'Infinity' as 2147483647, and '0x10' or '1_000' since PostgreSQL 16", async () => {
      const product = await seedStockProduct(5, 3);
      const read = await readForPublish(product.seeded);
      const before = await productState(product.seeded.productId);
      const values = stockValues(product, { red: 5, blue: 3 });
      const unreadable: unknown[] = [
        'NaN',
        'Infinity',
        'inf',
        '-Infinity',
        '0x10',
        '1_000',
        // More digits than numeric holds, before and after the point: refused, never written (the edit
        // page refuses '1e200000' too, as Infinity, and reads '1e-20000' as 0; the app sends whole
        // numbers, never such text).
        '1e200000',
        '1e-20000',
        '',
        '   ',
        '5 5',
        '5e',
        'five',
        true,
        {},
        [5],
      ];
      for (const quantity of unreadable) {
        await expect(
          publish(owner, { productId: product.seeded.productId, ...read, values: withRawQuantities(values, [quantity, 3]), blocks: [] }),
          JSON.stringify(quantity)
        ).rejects.toMatchObject({ code: 'NBP04', message: expect.stringContaining(`stock for SKU ${product.red} is not a number`) });
      }

      // A variant without a SKU, and the stock of a product without variants, are read the same way.
      const unnamed = stockValues(product, { red: 5, blue: 3 }, {
        variants: [formVariant(product.red, 59, 5, [terms.Red], product.seeded.variantIds[product.red]), formVariant('', 59, 0, [terms.Green])],
      });
      await expect(
        publish(owner, { productId: product.seeded.productId, ...read, values: withRawQuantities(unnamed, [5, '0x10']), blocks: [] })
      ).rejects.toMatchObject({ code: 'NBP04', message: expect.stringContaining('stock for variant 2 (no SKU) is not a number') });
      expect(await productState(product.seeded.productId)).toEqual(before);
      expect(await inventoryOf([product.red, product.blue])).toEqual({ [product.red]: 5, [product.blue]: 3 });

      const simple = await seedProduct({ draftBlocks: [] });
      const simpleBefore = await productState(simple.productId);
      const simpleValues = { ...buildProductDraftPublishValues(formValues(simple)), stock: 'NaN' };
      await expect(
        publish(owner, { productId: simple.productId, ...(await readForPublish(simple)), values: simpleValues, blocks: [] })
      ).rejects.toMatchObject({ code: 'NBP04', message: expect.stringContaining(`stock for SKU ${simple.sku} is not a number`) });
      expect(await productState(simple.productId)).toEqual(simpleBefore);
      expect(await inventoryOf([simple.sku])).toEqual({});
    });

    it('a product without variants: a sale meanwhile keeps its deduction, and the product row shows it', async () => {
      const seeded = await seedProduct({ draftBlocks: [] });
      await owner`insert into public.inventory_items (sku, quantity) values (${seeded.sku}, 7)`;
      await sell({ productId: seeded.productId, quantity: 2 });
      expect(await inventoryOf([seeded.sku])).toEqual({ [seeded.sku]: 5 });

      const values = buildProductDraftPublishValues(
        formValues(seeded, { title: 'Publish test (edited)', stock: 7, stock_baseline: { [seeded.sku]: 7 } })
      );
      const result = await publish(owner, { productId: seeded.productId, ...(await readForPublish(seeded)), values, blocks: [] });

      expect(await inventoryOf([seeded.sku])).toEqual({ [seeded.sku]: 5 });
      const after = await productState(seeded.productId);
      expect(after.product).toMatchObject({ title: 'Publish test (edited)', stock: 5 });
      expect(result.stock_adjusted).toEqual([]);
    });

    it('values without a baseline (a draft an earlier version saved, a CMS draft import) still write their quantities', async () => {
      const product = await seedStockProduct(5, 3);
      await sell({ productId: product.seeded.productId, variantId: product.seeded.variantIds[product.red], quantity: 1 });

      const values = stockValues(product, { red: 5, blue: 3 }, { stock_baseline: undefined });
      expect(values.stock_baseline).toBeNull();
      const result = await publish(owner, { productId: product.seeded.productId, ...(await readForPublish(product.seeded)), values, blocks: [] });

      expect(await inventoryOf([product.red, product.blue])).toEqual({ [product.red]: 5, [product.blue]: 3 });
      // Written as the draft holds them: not named, though Red went back from 4 to 5.
      expect(result.stock_adjusted).toEqual([]);
    });

    it('a SKU the baseline lacks (a new variant) is written as typed; a kept SKU without an inventory row gets one at its current stock', async () => {
      const red = `ST-K-${RUN}-${randomUUID().slice(0, 4)}`;
      const green = `ST-N-${RUN}-${randomUUID().slice(0, 4)}`;
      created.skus.push(green);
      // No inventory row for Red (a product saved before shared inventory): its stock is the variant's.
      const seeded = await seedProduct({ variants: [{ sku: red, price: 5900, stock: 5, terms: [terms.Red] }], draftBlocks: [] });
      // The page loaded 5; a write with no inventory row moved the stock to 4 since.
      await owner`update public.product_variants set stock_quantity = 4 where id = ${seeded.variantIds[red]}`;

      const values = buildProductDraftPublishValues(
        formValues(seeded, {
          stock_baseline: { [red]: 5 },
          variants: [
            formVariant(red, 59, 5, [terms.Red], seeded.variantIds[red]),
            formVariant(green, 59, 6, [terms.Green]),
          ],
        })
      );
      const result = await publish(owner, { productId: seeded.productId, ...(await readForPublish(seeded)), values, blocks: [] });

      expect(await inventoryOf([red, green])).toEqual({ [red]: 4, [green]: 6 });
      expect(await shownStockOf(seeded.productId)).toEqual({ product: 10, variants: { [red]: 4, [green]: 6 } });
      expect(result.stock_adjusted).toEqual([]);
    });

    it('a sale that runs while the publish holds its locks waits for it, then keeps its deduction', async () => {
      const product = await seedStockProduct(5, 3);
      const orderId = await recordOrder({ productId: product.seeded.productId, variantId: product.seeded.variantIds[product.red], quantity: 1 });
      const read = await readForPublish(product.seeded);
      const holder = holdPublish(connect(), {
        productId: product.seeded.productId,
        ...read,
        values: stockValues(product, { red: 5, blue: 3 }),
        blocks: [],
      });
      await holder.ran;

      // The deduction waits on Red's inventory row, which the publish locked before anything else.
      const sale = deductOrder(connect(), orderId, 'sale-during-publish');
      try {
        await waitForLockWait('sale-during-publish');
      } finally {
        holder.release();
      }
      await holder.done;
      await sale;

      expect(await inventoryOf([product.red, product.blue])).toEqual({ [product.red]: 4, [product.blue]: 3 });
      expect(await shownStockOf(product.seeded.productId)).toEqual({
        product: 7,
        variants: { [product.red]: 4, [product.blue]: 3 },
      });
    });

    it('two variants of 2147483647: the product stock is held at 2147483647 (the total raised 22003, in the function and then in the inventory trigger)', async () => {
      const skus = { red: `ST-MAXR-${RUN}-${randomUUID().slice(0, 4)}`, blue: `ST-MAXB-${RUN}-${randomUUID().slice(0, 4)}` };
      const seeded = await seedProduct({
        variants: [
          { sku: skus.red, price: 5900, stock: 0, terms: [terms.Red] },
          { sku: skus.blue, price: 5900, stock: 0, terms: [terms.Blue] },
        ],
        draftBlocks: [],
      });
      // No baseline: both written as typed, so the trigger sums both inventory rows.
      const values = buildProductDraftPublishValues(
        formValues(seeded, {
          variants: [
            formVariant(skus.red, 59, 2147483647, [terms.Red], seeded.variantIds[skus.red]),
            formVariant(skus.blue, 59, 2147483647, [terms.Blue], seeded.variantIds[skus.blue]),
          ],
        })
      );
      const result = await publish(owner, { productId: seeded.productId, ...(await readForPublish(seeded)), values, blocks: [] });

      expect(result.stock_adjusted).toEqual([]);
      expect(await inventoryOf([skus.red, skus.blue])).toEqual({ [skus.red]: 2147483647, [skus.blue]: 2147483647 });
      expect(await shownStockOf(seeded.productId)).toEqual({
        product: 2147483647,
        variants: { [skus.red]: 2147483647, [skus.blue]: 2147483647 },
      });
    });

    it("locks the values' inventory rows before the products row: a product without variants takes its own SKU's, an overlay publish takes none", async () => {
      const simple = await seedProduct({ draftBlocks: [] });
      await owner`insert into public.inventory_items (sku, quantity) values (${simple.sku}, 7)`;
      const values = buildProductDraftPublishValues(formValues(simple, { stock: 7, stock_baseline: { [simple.sku]: 7 } }));
      const read = await readForPublish(simple);
      const held = deferred();
      const release = deferred();
      const holder = settled(
        connect().begin(async (tx) => {
          await tx`select 1 from public.inventory_items where sku = ${simple.sku} for update`;
          held.resolve();
          await release.promise;
        })
      );
      await held.promise;
      const publishing = settled(
        asUser(connect(), ADMIN_ID, async (tx) => {
          await tx.unsafe(`set local lock_timeout = '10s'`);
          return publishStatement(tx, { productId: simple.productId, ...read, values, blocks: [] }, 'simple-waits');
        })
      );
      try {
        // A kept stock is never written, yet the publish waits on its row, before the products row:
        // another session can still lock that one.
        await waitForLockWait('simple-waits');
        expect(await owner`select id from public.products where id = ${simple.productId} for update skip locked`).toHaveLength(1);
      } finally {
        release.resolve();
      }
      expect((await holder).error).toBeUndefined();
      const published = await publishing;
      expect(published.error).toBeUndefined();
      expect((published.value as Row[])[0].result.stock_adjusted).toEqual([]);
      expect(await inventoryOf([simple.sku])).toEqual({ [simple.sku]: 7 });

      // An overlay publish writes no stock: an inventory row held elsewhere does not stop it.
      const overlay = await seedProduct({ liveBlocks: ['Live 1'] });
      await owner`insert into public.inventory_items (sku, quantity) values (${overlay.sku}, 7)`;
      const overlayRead = await readForPublish(overlay);
      const heldAgain = deferred();
      const releaseAgain = deferred();
      const holderAgain = settled(
        connect().begin(async (tx) => {
          await tx`select 1 from public.inventory_items where sku = ${overlay.sku} for update`;
          heldAgain.resolve();
          await releaseAgain.promise;
        })
      );
      await heldAgain.promise;
      let overlayResult: Row[] = [];
      try {
        overlayResult = (await asUser(connect(), ADMIN_ID, async (tx) => {
          await tx.unsafe(`set local lock_timeout = '2s'`);
          return publishStatement(tx, { productId: overlay.productId, ...overlayRead, overlay: { title: 'Published past a locked stock' }, blocks: [] }, 'overlay-free');
        })) as Row[];
      } finally {
        releaseAgain.resolve();
      }
      expect((await holderAgain).error).toBeUndefined();
      expect(overlayResult[0].result.stock_adjusted).toEqual([]);
      expect((await productState(overlay.productId)).product.title).toBe('Published past a locked stock');
    });

    it('locks, before the products row, every SKU a sale could hold a row of this publish through: a variant the draft drops, the product SKU, a SKU only a translation carries, another SKU of a product sharing one of the values, a padded SKU both as stored and trimmed; not an unrelated SKU', async () => {
      const sku = (name: string) => `ST-L${name}-${RUN}-${randomUUID().slice(0, 4)}`;
      const skus = { red: sku('R'), blue: sku('B'), frenchOnly: sku('F'), sharedOther: sku('O'), unrelated: sku('U'), trimmed: sku('P') };
      // A sale matches a SKU as stored (the row ' X '), the publish writes it trimmed (the row 'X').
      const padded = ` ${skus.trimmed} `;
      // Red, Blue and the padded SKU live; the draft keeps Red and the padded one (Blue dropped).
      const english = await seedProduct({
        variants: [
          { sku: skus.red, price: 5900, stock: 5, terms: [terms.Red] },
          { sku: skus.blue, price: 5900, stock: 3, terms: [terms.Blue] },
          { sku: padded, price: 5900, stock: 2, terms: [terms.S] },
        ],
        draftBlocks: [],
      });
      created.skus.push(skus.trimmed);
      // Its translation shares the product SKU (the sale schedule writes its row) and carries a SKU of its own.
      await seedProduct({
        sku: english.sku,
        groupId: english.groupId,
        languageId: 2,
        createDraft: false,
        variants: [
          { sku: skus.red, price: 5900, stock: 5, terms: [terms.Red] },
          { sku: skus.frenchOnly, price: 5900, stock: 2, terms: [terms.Green] },
        ],
      });
      // Another product (not a translation) carries Red too (the inventory trigger writes its row), and a SKU of its own.
      await seedProduct({
        createDraft: false,
        variants: [
          { sku: skus.red, price: 5900, stock: 5, terms: [terms.Red] },
          { sku: skus.sharedOther, price: 5900, stock: 4, terms: [terms.Blue] },
        ],
      });
      // A product sharing nothing with it.
      await seedProduct({ createDraft: false, variants: [{ sku: skus.unrelated, price: 5900, stock: 6, terms: [terms.Red] }] });
      await owner`
        insert into public.inventory_items (sku, quantity)
        values (${skus.red}, 5), (${skus.blue}, 3), (${skus.frenchOnly}, 2), (${skus.sharedOther}, 4), (${skus.unrelated}, 6),
               (${english.sku}, 0), (${padded}, 2), (${skus.trimmed}, 2)`;
      const values = buildProductDraftPublishValues(
        formValues(english, {
          stock_baseline: { [skus.red]: 5, [skus.blue]: 3, [skus.trimmed]: 2 },
          variants: [
            formVariant(skus.red, 59, 5, [terms.Red], english.variantIds[skus.red]),
            formVariant(padded, 59, 2, [terms.S], english.variantIds[padded]),
          ],
        })
      );
      const read = await readForPublish(english);

      // A session holding the draft row stops the publish right after its products row lock.
      const draft = await holdRows(`select 1 from public.product_drafts where product_id = $1 for update`, [english.productId]);
      const publishing = publishInSession({ productId: english.productId, ...read, values, blocks: [] }, 'lock-set');
      let locked: string[] = [];
      try {
        await waitForLockWait('lock-set');
        locked = await lockedInventoryRows([...Object.values(skus), english.sku, padded]);
      } finally {
        draft.release();
      }
      expect((await draft.done).error).toBeUndefined();
      expect((await publishing).error).toBeUndefined();
      expect(locked).toEqual([skus.blue, skus.frenchOnly, skus.sharedOther, skus.red, english.sku, padded, skus.trimmed].sort());
      expect(await inventoryOf([...Object.values(skus), padded])).toEqual({
        [skus.red]: 5,
        [skus.blue]: 3,
        [skus.frenchOnly]: 2,
        [skus.sharedOther]: 4,
        [skus.unrelated]: 6,
        [padded]: 2,
        [skus.trimmed]: 2,
      });
    });

    describe('a sale or a translation publish running against a publish (each could deadlock until 2026-11-18: 40P01)', () => {
      it("a sale that holds a SKU's inventory row when the publish starts is waited for; the publish then refuses (NBP03), and the next one lands on the stock the sale left", async () => {
        const product = await seedStockProduct(5, 3);
        const orderId = await recordOrder({ productId: product.seeded.productId, variantId: product.seeded.variantIds[product.red], quantity: 1 });
        const read = await readForPublish(product.seeded);
        const before = await productState(product.seeded.productId);
        // Red changed from 5 to 9: the publish writes Red's inventory row.
        const values = stockValues(product, { red: 9, blue: 3 });

        // A sale locks Red's inventory row first (its UPDATE); here that is split from the rest, which in
        // a real sale runs in the same statement, so the two sessions meet in a fixed order.
        const locked = deferred();
        const proceed = deferred();
        const sale = settled(
          connect().begin(async (tx) => {
            await tx.unsafe(`set local lock_timeout = '10s'`);
            await tx`select 1 from public.inventory_items where sku = ${product.red} for update`;
            locked.resolve();
            await proceed.promise;
            // The rest of the sale: the deduction, whose trigger writes the Red variant and the product.
            await tx.unsafe(`/* nb-test:sale-rest */ select public.apply_order_inventory_deduction($1::uuid)`, [orderId]);
          })
        );
        await locked.promise;
        const publishing = settled(
          asUser(connect(), ADMIN_ID, async (tx) => {
            await tx.unsafe(`set local lock_timeout = '10s'`);
            return publishStatement(tx, { productId: product.seeded.productId, ...read, values, blocks: [] }, 'publish-behind-sale');
          })
        );
        try {
          await waitForLockWait('publish-behind-sale');
        } finally {
          proceed.resolve();
        }

        expect((await sale).error).toBeUndefined();
        // The sale's trigger moved the product's updated_at after the values were read.
        expect((await publishing).error).toMatchObject({ code: 'NBP03' });
        expect(await inventoryOf([product.red, product.blue])).toEqual({ [product.red]: 4, [product.blue]: 3 });
        const after = await productState(product.seeded.productId);
        expect(after.drafts).toEqual(before.drafts);
        expect(after.revisions).toEqual(before.revisions);

        // Publish again, from a fresh read: the change lands on the stock as the sale left it.
        const again = await publish(owner, { productId: product.seeded.productId, ...(await readForPublish(product.seeded)), values, blocks: [] });
        expect(again.stock_adjusted).toEqual([{ sku: product.red, reason: 'moved', entered: 9, loaded: 5, current: 4, published: 8 }]);
        expect(await inventoryOf([product.red, product.blue])).toEqual({ [product.red]: 8, [product.blue]: 3 });
      });

      it('a sale made while a publish is part way (its variant rows written, its stock not yet) waits for the publish, then deducts from what it wrote', async () => {
        const product = await seedStockProduct(5, 3, { gallery: [media.M1] });
        const orderId = await recordOrder({ productId: product.seeded.productId, variantId: product.seeded.variantIds[product.red], quantity: 1 });
        const read = await readForPublish(product.seeded);
        const values = stockValues(product, { red: 9, blue: 3 }, { product_media: [{ media_id: media.M1 }] });

        // A session holding the product's gallery row stops the publish at its gallery step: after the
        // variant rows, before the stock.
        const held = deferred();
        const release = deferred();
        const gallery = settled(
          connect().begin(async (tx) => {
            await tx`select 1 from public.product_media where product_id = ${product.seeded.productId} and media_id = ${media.M1} for update`;
            held.resolve();
            await release.promise;
          })
        );
        await held.promise;
        const publishing = settled(
          asUser(connect(), ADMIN_ID, async (tx) => {
            await tx.unsafe(`set local lock_timeout = '10s'`);
            return publishStatement(tx, { productId: product.seeded.productId, ...read, values, blocks: [] }, 'publish-part-way');
          })
        );
        let sale: Promise<{ value?: unknown; error?: any }> = Promise.resolve({});
        try {
          await waitForLockWait('publish-part-way');
          // The sale, in one statement, as checkout runs it.
          sale = settled(
            connect().begin(async (tx) => {
              await tx.unsafe(`set local lock_timeout = '10s'`);
              await tx.unsafe(`/* nb-test:sale-mid-publish */ select public.apply_order_inventory_deduction($1::uuid)`, [orderId]);
            })
          );
          await waitForLockWait('sale-mid-publish');
        } finally {
          release.resolve();
        }

        expect((await gallery).error).toBeUndefined();
        const published = await publishing;
        expect(published.error).toBeUndefined();
        expect((await sale).error).toBeUndefined();
        expect((published.value as Row[])[0].result.stock_adjusted).toEqual([]);
        // 9 published, then the sale's 1 deducted from it.
        expect(await inventoryOf([product.red, product.blue])).toEqual({ [product.red]: 8, [product.blue]: 3 });
        expect(await shownStockOf(product.seeded.productId)).toEqual({
          product: 11,
          variants: { [product.red]: 8, [product.blue]: 3 },
        });
      });

      it('two publishes of translations sharing SKUs take the inventory rows in one order: the second waits for the first, then refuses (NBP03)', async () => {
        const red = `ST-TR-${RUN}-${randomUUID().slice(0, 4)}`;
        const blue = `ST-TB-${RUN}-${randomUUID().slice(0, 4)}`;
        const variants = [
          { sku: red, price: 5900, stock: 5, terms: [terms.Red] },
          { sku: blue, price: 5900, stock: 3, terms: [terms.Blue] },
        ];
        const english = await seedProduct({ variants, gallery: [media.M1], draftBlocks: [] });
        const french = await seedProduct({ sku: english.sku, groupId: english.groupId, languageId: 2, variants, draftBlocks: [] });
        await owner`insert into public.inventory_items (sku, quantity) values (${red}, 5), (${blue}, 3)`;
        const valuesFor = (seeded: Seeded, languageId: number, extra: Partial<ProductFormValues> = {}) =>
          buildProductDraftPublishValues(
            formValues(seeded, {
              language_id: languageId,
              stock_baseline: { [red]: 5, [blue]: 3 },
              variants: [
                formVariant(red, 59, 9, [terms.Red], seeded.variantIds[red]),
                formVariant(blue, 59, 3, [terms.Blue], seeded.variantIds[blue]),
              ],
              ...extra,
            })
          );
        const englishRead = await readForPublish(english);
        const frenchRead = await readForPublish(french);
        const frenchBefore = await productState(french.productId);

        // The English publish stops at its gallery step, holding what it locked so far.
        const held = deferred();
        const release = deferred();
        const gallery = settled(
          connect().begin(async (tx) => {
            await tx`select 1 from public.product_media where product_id = ${english.productId} and media_id = ${media.M1} for update`;
            held.resolve();
            await release.promise;
          })
        );
        await held.promise;
        const englishPublish = settled(
          asUser(connect(), ADMIN_ID, async (tx) => {
            await tx.unsafe(`set local lock_timeout = '10s'`);
            return publishStatement(
              tx,
              { productId: english.productId, ...englishRead, values: valuesFor(english, 1, { product_media: [{ media_id: media.M1 }] }), blocks: [] },
              'english-publish'
            );
          })
        );
        let frenchPublish: Promise<{ value?: unknown; error?: any }> = Promise.resolve({});
        try {
          await waitForLockWait('english-publish');
          // The French publish writes the same SKUs, and its sale schedule the English row (they share the
          // product SKU).
          frenchPublish = settled(
            asUser(connect(), ADMIN_ID, async (tx) => {
              await tx.unsafe(`set local lock_timeout = '10s'`);
              return publishStatement(tx, { productId: french.productId, ...frenchRead, values: valuesFor(french, 2), blocks: [] }, 'french-publish');
            })
          );
          await waitForLockWait('french-publish');
        } finally {
          release.resolve();
        }

        expect((await gallery).error).toBeUndefined();
        const englishOutcome = await englishPublish;
        expect(englishOutcome.error).toBeUndefined();
        expect((englishOutcome.value as Row[])[0].result.stock_adjusted).toEqual([]);
        // The English publish wrote the French row (the sale schedule, the stock) after its values were read.
        expect((await frenchPublish).error).toMatchObject({ code: 'NBP03' });
        expect(await inventoryOf([red, blue])).toEqual({ [red]: 9, [blue]: 3 });
        expect(await shownStockOf(french.productId)).toEqual({ product: 12, variants: { [red]: 9, [blue]: 3 } });
        expect((await productState(french.productId)).drafts).toEqual(frenchBefore.drafts);
      });

      it.each(['removed', 'renamed'] as const)(
        'a variant the draft has %s, sold while the publish runs, is waited for: no deadlock, and the sale deducts after the publish (Green 4 to 3)',
        async (kind) => {
          const sku = (name: string) => `ST-S7${name}-${RUN}-${randomUUID().slice(0, 4)}`;
          const skus = { red: sku('R'), blue: sku('B'), green: sku('G') };
          const renamed = `${skus.green}-NEW`;
          created.skus.push(renamed);
          const seeded = await seedProduct({
            variants: [
              { sku: skus.red, price: 5900, stock: 5, terms: [terms.Red] },
              { sku: skus.blue, price: 5900, stock: 3, terms: [terms.Blue] },
              { sku: skus.green, price: 5900, stock: 4, terms: [terms.Green] },
            ],
            draftBlocks: [],
          });
          await owner`insert into public.inventory_items (sku, quantity) values (${skus.red}, 5), (${skus.blue}, 3), (${skus.green}, 4)`;
          const orderId = await recordOrder({ productId: seeded.productId, variantId: seeded.variantIds[skus.green], quantity: 1 });
          // The draft keeps Red and Blue; Green is gone, or (same terms, same row) carries another SKU.
          const values = buildProductDraftPublishValues(
            formValues(seeded, {
              stock_baseline: { [skus.red]: 5, [skus.blue]: 3, [skus.green]: 4 },
              variants: [
                formVariant(skus.red, 59, 5, [terms.Red], seeded.variantIds[skus.red]),
                formVariant(skus.blue, 59, 3, [terms.Blue], seeded.variantIds[skus.blue]),
                ...(kind === 'renamed' ? [formVariant(renamed, 59, 4, [terms.Green], seeded.variantIds[skus.green])] : []),
              ],
            })
          );
          const read = await readForPublish(seeded);

          // A session holding the draft row stops the publish right after its products row lock; the sale of one
          // Green runs then, in one statement. Until round 4 the publish did not lock Green's inventory row: the
          // sale's trigger took the Green variant, then waited for the products row, and the publish, deleting or
          // renaming that variant, waited for the sale (40P01).
          const draft = await holdRows(`select 1 from public.product_drafts where product_id = $1 for update`, [seeded.productId]);
          const publishing = publishInSession({ productId: seeded.productId, ...read, values, blocks: [] }, `dropped-publish-${kind}`);
          let sale: Promise<{ value?: unknown; error?: any }> = Promise.resolve({});
          try {
            await waitForLockWait(`dropped-publish-${kind}`);
            sale = saleInOneStatement(orderId, `dropped-sale-${kind}`);
            await waitForLockWait(`dropped-sale-${kind}`);
          } finally {
            draft.release();
          }

          expect((await draft.done).error).toBeUndefined();
          const published = await publishing;
          expect((await sale).error).toBeUndefined();
          expect(published.error).toBeUndefined();
          expect(await inventoryOf([skus.red, skus.blue, skus.green, renamed])).toEqual({
            [skus.red]: 5,
            [skus.blue]: 3,
            [skus.green]: 3,
            ...(kind === 'renamed' ? { [renamed]: 4 } : {}),
          });
          expect(Object.keys((await shownStockOf(seeded.productId)).variants).sort()).toEqual(
            (kind === 'renamed' ? [skus.red, skus.blue, renamed] : [skus.red, skus.blue]).sort()
          );
        }
      );

      it('a SKU only a translation carries, sold in one order with a SKU the publish writes, waits for the publish (whose sale schedule writes that translation): no deadlock', async () => {
        // SKU order: G (the French product's own), then B and R (both translations'). The sale takes G first, and its
        // trigger then holds the French row, which the English publish's sale schedule writes.
        const g = `ST-T0G-${RUN}-${randomUUID().slice(0, 4)}`;
        const b = `ST-T1B-${RUN}-${randomUUID().slice(0, 4)}`;
        const r = `ST-T1R-${RUN}-${randomUUID().slice(0, 4)}`;
        const english = await seedProduct({
          variants: [
            { sku: r, price: 5900, stock: 5, terms: [terms.Red] },
            { sku: b, price: 5900, stock: 3, terms: [terms.Blue] },
          ],
          draftBlocks: [],
        });
        const french = await seedProduct({
          sku: english.sku,
          groupId: english.groupId,
          languageId: 2,
          createDraft: false,
          variants: [
            { sku: g, price: 5900, stock: 4, terms: [terms.Green] },
            { sku: r, price: 5900, stock: 5, terms: [terms.Red] },
            { sku: b, price: 5900, stock: 3, terms: [terms.Blue] },
          ],
        });
        await owner`insert into public.inventory_items (sku, quantity) values (${g}, 4), (${r}, 5), (${b}, 3)`;
        const orderId = await recordOrderLines([
          { productId: french.productId, variantId: french.variantIds[g], quantity: 1 },
          { productId: english.productId, variantId: english.variantIds[r], quantity: 1 },
        ]);
        // Red changed from 5 to 9: the publish writes Red's inventory row.
        const values = buildProductDraftPublishValues(
          formValues(english, {
            stock_baseline: { [r]: 5, [b]: 3 },
            variants: [formVariant(r, 59, 9, [terms.Red], english.variantIds[r]), formVariant(b, 59, 3, [terms.Blue], english.variantIds[b])],
          })
        );
        const read = await readForPublish(english);

        // A session holding Red's inventory row: the publish queues on it first, then the sale. Without G in the
        // publish's set, the sale took G (and, through its trigger, the French row), then queued for Red behind the
        // publish, which then waited for the French row (40P01).
        const holder = await holdRows(`select 1 from public.inventory_items where sku = $1 for update`, [r]);
        const publishing = publishInSession({ productId: english.productId, ...read, values, blocks: [] }, 'translation-only-publish');
        let sale: Promise<{ value?: unknown; error?: any }> = Promise.resolve({});
        try {
          await waitForLockWait('translation-only-publish');
          sale = saleInOneStatement(orderId, 'translation-only-sale');
          await waitForLockWait('translation-only-sale');
        } finally {
          holder.release();
        }

        expect((await holder.done).error).toBeUndefined();
        const published = await publishing;
        expect((await sale).error).toBeUndefined();
        expect(published.error).toBeUndefined();
        // 9 published for Red, then the sale's one deducted from it; G 4 to 3.
        expect(await inventoryOf([g, r, b])).toEqual({ [g]: 3, [r]: 8, [b]: 3 });
      });

      it('another SKU of a product sharing a SKU the publish writes (not a translation), sold in one order with a SKU of the publish, waits for the publish (whose inventory trigger writes that product): no deadlock', async () => {
        // SKU order: S (the other product's own), X (both products', changed by the publish), K (the published product's, kept).
        const s = `ST-U1S-${RUN}-${randomUUID().slice(0, 4)}`;
        const x = `ST-U5X-${RUN}-${randomUUID().slice(0, 4)}`;
        const k = `ST-U7K-${RUN}-${randomUUID().slice(0, 4)}`;
        const seeded = await seedProduct({
          variants: [
            { sku: x, price: 5900, stock: 5, terms: [terms.Red] },
            { sku: k, price: 5900, stock: 5, terms: [terms.Blue] },
          ],
          draftBlocks: [],
        });
        const other = await seedProduct({
          createDraft: false,
          variants: [
            { sku: s, price: 5900, stock: 5, terms: [terms.Red] },
            { sku: x, price: 5900, stock: 5, terms: [terms.Blue] },
          ],
        });
        await owner`insert into public.inventory_items (sku, quantity) values (${s}, 5), (${x}, 5), (${k}, 5)`;
        const orderId = await recordOrderLines([
          { productId: other.productId, variantId: other.variantIds[s], quantity: 1 },
          { productId: seeded.productId, variantId: seeded.variantIds[k], quantity: 1 },
        ]);
        const values = buildProductDraftPublishValues(
          formValues(seeded, {
            stock_baseline: { [x]: 5, [k]: 5 },
            variants: [formVariant(x, 59, 9, [terms.Red], seeded.variantIds[x]), formVariant(k, 59, 5, [terms.Blue], seeded.variantIds[k])],
          })
        );
        const read = await readForPublish(seeded);

        // Without S in the publish's set, the sale took S (and, through its trigger, the other product's row), then
        // queued for K behind the publish, whose inventory trigger for X then waited for that row (40P01).
        const holder = await holdRows(`select 1 from public.inventory_items where sku = $1 for update`, [k]);
        const publishing = publishInSession({ productId: seeded.productId, ...read, values, blocks: [] }, 'shared-sku-publish');
        let sale: Promise<{ value?: unknown; error?: any }> = Promise.resolve({});
        try {
          await waitForLockWait('shared-sku-publish');
          sale = saleInOneStatement(orderId, 'shared-sku-sale');
          await waitForLockWait('shared-sku-sale');
        } finally {
          holder.release();
        }

        expect((await holder.done).error).toBeUndefined();
        const published = await publishing;
        expect((await sale).error).toBeUndefined();
        expect(published.error).toBeUndefined();
        expect(await inventoryOf([s, x, k])).toEqual({ [s]: 4, [x]: 9, [k]: 4 });
      });

      it('a sale part way through its SKUs when a publish starts (one statement, its lines in GROUP BY order, Z before A) no longer deadlocks: the publish waits for it, then refuses (NBP03)', async () => {
        const a = `ST-6A-${RUN}-${randomUUID().slice(0, 4)}`;
        const z = `ST-6Z-${RUN}-${randomUUID().slice(0, 4)}`;
        const seeded = await seedProduct({
          variants: [
            { sku: a, price: 5900, stock: 5, terms: [terms.Red] },
            { sku: z, price: 5900, stock: 3, terms: [terms.Blue] },
          ],
          draftBlocks: [],
        });
        const orderId = await recordOrderLines([
          { productId: seeded.productId, variantId: seeded.variantIds[a], quantity: 1 },
          { productId: seeded.productId, variantId: seeded.variantIds[z], quantity: 1 },
        ]);
        // 02001's deduction takes the lines in GROUP BY (hash) order, which follows the variant ids: if it would take A
        // first, the two rows swap SKUs, so that it takes Z first.
        let skuOf = { [seeded.variantIds[a]]: a, [seeded.variantIds[z]]: z };
        if ((await groupByOrder(orderId))[0] === seeded.variantIds[a]) {
          await owner`update public.product_variants set sku = ${`${a}-swap`} where id = ${seeded.variantIds[a]}`;
          await owner`update public.product_variants set sku = ${a} where id = ${seeded.variantIds[z]}`;
          await owner`update public.product_variants set sku = ${z} where id = ${seeded.variantIds[a]}`;
          skuOf = { [seeded.variantIds[a]]: z, [seeded.variantIds[z]]: a };
        }
        const [first] = await groupByOrder(orderId);
        expect(skuOf[first as string], "02001's order takes Z first").toBe(z);
        await owner`insert into public.inventory_items (sku, quantity) values (${a}, 5), (${z}, 3)`;
        // Another product carrying Z: a session holding its variant row stops the sale's trigger for Z.
        const other = await seedProduct({ createDraft: false, variants: [{ sku: z, price: 5900, stock: 3, terms: [terms.Red] }] });
        const variantOf = (sku: string) => Object.keys(skuOf).find((id) => skuOf[id] === sku) as string;
        const termsOf = (id: string) => (id === seeded.variantIds[a] ? [terms.Red] : [terms.Blue]);
        // A changed from 5 to 9, Z kept.
        const values = buildProductDraftPublishValues(
          formValues(seeded, {
            stock_baseline: { [a]: 5, [z]: 3 },
            variants: [
              formVariant(a, 59, 9, termsOf(variantOf(a)), variantOf(a)),
              formVariant(z, 59, 3, termsOf(variantOf(z)), variantOf(z)),
            ],
          })
        );
        const read = await readForPublish(seeded);

        const pause = await holdRows(`select 1 from public.product_variants where id = $1 for update`, [other.variantIds[z]]);
        let sale: Promise<{ value?: unknown; error?: any }> = Promise.resolve({});
        let publishing: Promise<{ value?: unknown; error?: any }> = Promise.resolve({});
        try {
          // The sale (02001's: Z, its trigger stopped; this round's: A, then Z, its trigger stopped).
          sale = saleInOneStatement(orderId, 'part-way-sale');
          await waitForLockWait('part-way-sale');
          // The publish waits on the sale's row (02001's: Z, holding A, which the sale needs next: 40P01).
          publishing = publishInSession({ productId: seeded.productId, ...read, values, blocks: [] }, 'part-way-publish');
          await waitForLockWait('part-way-publish');
        } finally {
          pause.release();
        }

        expect((await pause.done).error).toBeUndefined();
        expect((await sale).error).toBeUndefined();
        // The sale's trigger moved the product's updated_at after the values were read.
        expect((await publishing).error).toMatchObject({ code: 'NBP03' });
        expect(await inventoryOf([a, z])).toEqual({ [a]: 4, [z]: 2 });
      });
    });

    describe("the sale's deduction (02044 section 4) and the app's SQL fallback: every SKU of an order, in SKU order", () => {
      const PATHS = ['apply_order_inventory_deduction', "the app's SQL fallback"] as const;

      /** Deducts `orderId` by one path, in its own session, settled; `tag` names the RPC's statement. */
      function deductBy(path: (typeof PATHS)[number], orderId: string, tag: string) {
        return path === 'apply_order_inventory_deduction' ? saleInOneStatement(orderId, tag) : settled(deductWithFallback(orderId));
      }

      /** A product with variants A and Z (inventory 5 and 3) and an order of one of each, whose GROUP BY order takes Z first. */
      async function seedZFirstOrder(label: string) {
        const a = `ST-${label}A-${RUN}-${randomUUID().slice(0, 4)}`;
        const z = `ST-${label}Z-${RUN}-${randomUUID().slice(0, 4)}`;
        const seeded = await seedProduct({
          variants: [
            { sku: a, price: 5900, stock: 5, terms: [terms.Red] },
            { sku: z, price: 5900, stock: 3, terms: [terms.Blue] },
          ],
          createDraft: false,
        });
        const orderId = await recordOrderLines([
          { productId: seeded.productId, variantId: seeded.variantIds[a], quantity: 1 },
          { productId: seeded.productId, variantId: seeded.variantIds[z], quantity: 1 },
        ]);
        if ((await groupByOrder(orderId))[0] === seeded.variantIds[a]) {
          await owner`update public.product_variants set sku = ${`${a}-swap`} where id = ${seeded.variantIds[a]}`;
          await owner`update public.product_variants set sku = ${a} where id = ${seeded.variantIds[z]}`;
          await owner`update public.product_variants set sku = ${z} where id = ${seeded.variantIds[a]}`;
        }
        const [first] = await groupByOrder(orderId);
        const [{ sku: firstSku }] = await owner`select sku from public.product_variants where id = ${first}`;
        expect(firstSku, "02001's order takes Z first").toBe(z);
        await owner`insert into public.inventory_items (sku, quantity) values (${a}, 5), (${z}, 3)`;
        return { a, z, orderId };
      }

      it.each(PATHS)('%s takes the SKUs in SKU order: waiting for the first, it holds no later one', async (path) => {
        const { a, z, orderId } = await seedZFirstOrder(path === 'apply_order_inventory_deduction' ? 'OR' : 'OF');
        const holder = await holdRows(`select 1 from public.inventory_items where sku = $1 for update`, [a]);
        let deducting: Promise<{ value?: unknown; error?: any }> = Promise.resolve({});
        let locked: string[] = [];
        try {
          deducting = deductBy(path, orderId, 'order-of-skus');
          if (path === 'apply_order_inventory_deduction') await waitForLockWait('order-of-skus');
          else await waitForLockWait('order-of-skus (fallback)', '%UPDATE public.inventory_items%');
          // Only A is held, by the holder: in GROUP BY order the deduction took Z first and held it here.
          locked = await lockedInventoryRows([a, z]);
        } finally {
          holder.release();
        }
        expect((await holder.done).error).toBeUndefined();
        const deducted = await deducting;
        expect(deducted.error).toBeUndefined();
        if (path !== 'apply_order_inventory_deduction') expect(deducted.value).toEqual({ method: 'sql-fallback' });
        expect(locked).toEqual([a]);
        expect(await inventoryOf([a, z])).toEqual({ [a]: 4, [z]: 2 });
      });

      it.each(PATHS)('%s deducts every SKU of an order once, whatever the shape of its lines, and an order only once', async (path) => {
        const sku = (name: string) => `ST-M${name}-${RUN}-${randomUUID().slice(0, 4)}`;
        const skus = { a: sku('A'), z: sku('Z'), fresh: sku('F'), short: sku('S') };
        // A, bought on two lines (1 + 2), and Z, once.
        const main = await seedProduct({
          variants: [
            { sku: skus.a, price: 5900, stock: 10, terms: [terms.Red] },
            { sku: skus.z, price: 5900, stock: 4, terms: [terms.Blue] },
          ],
          createDraft: false,
        });
        // A product without variants: its own SKU.
        const simple = await seedProduct({ createDraft: false });
        // A variant without a SKU (skipped), a SKU without an inventory row (one is made from the variant's stock,
        // then lowered), and a SKU with less in stock than was bought (held at 0).
        const odd = await seedProduct({
          createDraft: false,
          variants: [
            { sku: '', price: 5900, stock: 2, terms: [terms.Red] },
            { sku: skus.fresh, price: 5900, stock: 6, terms: [terms.Blue] },
            { sku: skus.short, price: 5900, stock: 1, terms: [terms.Green] },
          ],
        });
        await owner`insert into public.inventory_items (sku, quantity) values (${skus.a}, 10), (${skus.z}, 4), (${simple.sku}, 8), (${skus.short}, 1)`;
        const lines = [
          { productId: main.productId, variantId: main.variantIds[skus.a], quantity: 1 },
          { productId: odd.productId, variantId: odd.variantIds[skus.short], quantity: 3 },
          { productId: main.productId, variantId: main.variantIds[skus.z], quantity: 1 },
          { productId: simple.productId, quantity: 2 },
          { productId: odd.productId, variantId: odd.variantIds[''], quantity: 1 },
          { productId: odd.productId, variantId: odd.variantIds[skus.fresh], quantity: 1 },
          { productId: main.productId, variantId: main.variantIds[skus.a], quantity: 2 },
        ];
        const orderId = await recordOrderLines(lines);

        const first = await deductBy(path, orderId, 'multi-sku');
        expect(first.error).toBeUndefined();
        const expected = { [skus.a]: 7, [skus.z]: 3, [simple.sku]: 6, [skus.fresh]: 5, [skus.short]: 0 };
        expect(await inventoryOf([...Object.values(skus), simple.sku, ''])).toEqual(expected);
        expect(await shownStockOf(main.productId)).toEqual({ product: 10, variants: { [skus.a]: 7, [skus.z]: 3 } });
        expect((await productState(simple.productId)).product.stock).toBe(6);
        const [{ deducted }] = await owner`select inventory_deducted_at is not null as deducted from public.orders where id = ${orderId}`;
        expect(deducted).toBe(true);

        // inventory_deducted_at: a second run deducts nothing.
        expect((await deductBy(path, orderId, 'multi-sku-again')).error).toBeUndefined();
        expect(await inventoryOf([...Object.values(skus), simple.sku, ''])).toEqual(expected);

        if (path === 'apply_order_inventory_deduction') {
          // The track-quantities switch off: the order is marked deducted and no stock moves (rolled back).
          const offOrder = await recordOrderLines([{ productId: main.productId, variantId: main.variantIds[skus.a], quantity: 1 }]);
          const off = await owner
            .begin(async (tx) => {
              await tx`update public.site_settings set value = coalesce(value, '{}'::jsonb) || '{"track_quantities": false}'::jsonb where key = 'ecommerce_inventory_settings'`;
              await tx`select public.apply_order_inventory_deduction(${offOrder}::uuid)`;
              const [{ marked }] = await tx`select inventory_deducted_at is not null as marked from public.orders where id = ${offOrder}`;
              const [{ quantity }] = await tx`select quantity from public.inventory_items where sku = ${skus.a}`;
              throw Object.assign(new Error('rolled back'), { outcome: { marked, quantity } });
            })
            .catch((error: { outcome?: unknown }) => error.outcome);
          expect(off).toEqual({ marked: true, quantity: 7 });
        }
      });

      it('two sales taking the same two SKUs through other products’ lines, in opposite GROUP BY orders, no longer deadlock', async () => {
        const x = `ST-2X-${RUN}-${randomUUID().slice(0, 4)}`;
        const y = `ST-2Y-${RUN}-${randomUUID().slice(0, 4)}`;
        // Four products with one variant each (two carrying X, two Y), and one more of each whose variant row, held by
        // another session, stops a sale's trigger for that SKU part way.
        const one = async (sku: string) => seedProduct({ createDraft: false, variants: [{ sku, price: 5900, stock: 10, terms: [terms.Red] }] });
        const [x1, y1, x2, y2, pauseX, pauseY] = [await one(x), await one(y), await one(x), await one(y), await one(x), await one(y)];
        const variant = (product: Seeded) => Object.values(product.variantIds)[0];
        await owner`insert into public.inventory_items (sku, quantity) values (${x}, 10), (${y}, 10)`;
        const order1 = await recordOrderLines([
          { productId: x1.productId, variantId: variant(x1), quantity: 1 },
          { productId: y1.productId, variantId: variant(y1), quantity: 1 },
        ]);
        const order2 = await recordOrderLines([
          { productId: x2.productId, variantId: variant(x2), quantity: 1 },
          { productId: y2.productId, variantId: variant(y2), quantity: 1 },
        ]);
        // 02001's deduction takes the lines in GROUP BY order: swap the two variants' SKUs until sale 1 takes X first
        // and sale 2 takes Y first.
        const firstSku = async (orderId: string) => {
          const [first] = await groupByOrder(orderId);
          const [{ sku }] = await owner`select sku from public.product_variants where id = ${first}`;
          return sku as string;
        };
        const swap = async (left: Seeded, right: Seeded) => {
          const [l, r] = [variant(left), variant(right)];
          const [{ sku: ls }] = await owner`select sku from public.product_variants where id = ${l}`;
          const [{ sku: rs }] = await owner`select sku from public.product_variants where id = ${r}`;
          await owner`update public.product_variants set sku = ${rs} where id = ${l}`;
          await owner`update public.product_variants set sku = ${ls} where id = ${r}`;
        };
        if ((await firstSku(order1)) !== x) await swap(x1, y1);
        if ((await firstSku(order2)) !== y) await swap(x2, y2);
        expect([await firstSku(order1), await firstSku(order2)]).toEqual([x, y]);

        const pause = await holdRows(`select 1 from public.product_variants where id = any($1::uuid[]) for update`, [[variant(pauseX), variant(pauseY)]]);
        let first: Promise<{ value?: unknown; error?: any }> = Promise.resolve({});
        let second: Promise<{ value?: unknown; error?: any }> = Promise.resolve({});
        try {
          // 02001's: sale 1 holds X and sale 2 holds Y, each trigger stopped, then each needs the other's row (40P01).
          // This round's: both take X first; sale 2 waits for sale 1's X.
          first = saleInOneStatement(order1, 'two-sales-1');
          await waitForLockWait('two-sales-1');
          second = saleInOneStatement(order2, 'two-sales-2');
          await waitForLockWait('two-sales-2');
        } finally {
          pause.release();
        }
        expect((await pause.done).error).toBeUndefined();
        expect((await first).error).toBeUndefined();
        expect((await second).error).toBeUndefined();
        expect(await inventoryOf([x, y])).toEqual({ [x]: 8, [y]: 8 });
      });
    });
  });

  it("product_revision_content writes timestamps as Date#toISOString() does, so an app snapshot's published_at reads the same", async () => {
    const seeded = await seedProduct({ createDraft: false });
    await owner`update public.products set published_at = '2026-11-18 10:11:12.987654+00', sale_start_at = '2026-11-20 00:00:00+00' where id = ${seeded.productId}`;

    const [{ content }] = await asUser(connect(), WRITER_ID, (tx) =>
      tx`select public.product_revision_content(${seeded.productId}::uuid) as content`
    );

    expect(content.meta.published_at).toBe(new Date('2026-11-18T10:11:12.987654+00:00').toISOString());
    expect(content.commerce.sale_start_at).toBe('2026-11-20T00:00:00.000Z');
    expect(Object.keys(content).sort()).toEqual(['blocks', 'commerce', 'meta']);
    expect(Object.keys(content.meta).sort()).toEqual(
      ['custom_canonical', 'description_json', 'language_id', 'meta_description', 'meta_title', 'published_at', 'short_description', 'slug', 'status', 'title'].sort()
    );
  });
});
