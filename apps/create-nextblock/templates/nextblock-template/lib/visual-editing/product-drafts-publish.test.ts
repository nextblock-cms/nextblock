import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Who may publish a product draft, and what each kind of draft may write.
 *
 * - Every publish needs an ADMIN past the second factor (requireCmsAdmin()), checked before anything is
 *   read: product values go through `upsert_product_with_variants` (is_admin(): the role only, which an
 *   aal1 session passes) and a Freemius product's sale coupon is pushed with the service role through
 *   the developer key pair; product_revisions accepts only ADMIN inserts (02003), so a WRITER's publish
 *   went live with no History; and before 0.23.4 no WRITER could complete one (every draft carried
 *   product values, and the RPC refused).
 * - Until 0.23.4 a block edit or an in-page edit created the draft with the raw products row as `meta`
 *   (minor units, no variants), and publish read any meta with a `sku` or a `price` as form values, so
 *   a block-only edit followed by Publish multiplied every price by 100, deleted every variant and
 *   cleared the description and the sale schedule. Only the form's autosave and a CMS draft import
 *   carry product values now (lib/visual-editing/product-draft-meta.ts); a partial one is completed
 *   from the live product.
 * - The edit page of those versions showed such a snapshot as form values, so the first autosave over
 *   one stored the cents as dollars, no variants, gallery or description, without an `id`. Product
 *   values written since 0.23.4 carry a marker; an unmarked draft with those fields is refused.
 * - A legacy snapshot's title, short description and description are written only while the live row
 *   is unchanged since the draft was created.
 * - After its checks and before its first write, a publish claims the draft: an UPDATE matching only
 *   the row as it read it (02003's trigger moves updated_at), so a second publish that read the same
 *   row, or one that read it before an edit saved into it, writes nothing.
 */

const PRODUCT_ID = '123e4567-e89b-12d3-a456-426614174000';
const TERM_RED = '323e4567-e89b-12d3-a456-426614174000';
const ATTR_COLOR = '423e4567-e89b-12d3-a456-426614174000';
const GROUP_ID = '523e4567-e89b-12d3-a456-426614174000';

/** The live product as getProduct() returns it (minor units, variants with their mappings). */
const LIVE_PRODUCT = {
  id: PRODUCT_ID,
  title: 'Pro plugin',
  slug: 'pro-plugin',
  sku: 'PRO',
  upc: '0123456789012',
  price: 4900,
  prices: { USD: 4900, EUR: 4500 },
  sale_price: 3900,
  sale_prices: { USD: 3900 },
  sale_start_at: '2026-11-20T00:00:00+00:00',
  sale_end_at: '2026-11-30T00:00:00+00:00',
  stock: 4,
  is_taxable: true,
  product_type: 'physical',
  payment_provider: 'stripe',
  status: 'active',
  short_description: 'Short copy',
  description_json: {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Rich description' }] }],
  },
  meta_title: 'Pro plugin | Store',
  meta_description: 'The pro plugin.',
  custom_canonical: 'https://example.com/pro-plugin',
  freemius_product_id: null,
  freemius_plan_id: null,
  trial_period_days: 0,
  trial_requires_payment_method: false,
  language_id: 1,
  translation_group_id: GROUP_ID,
  updated_at: '2026-06-01T10:00:00+00:00',
  languages: { code: 'en' },
  product_media: [{ media_id: 'media-1', sort_order: 0, media: { file_path: 'a.webp' } }],
  product_variants: [
    {
      id: 'variant-1',
      sku: 'PRO-RED',
      upc: '0123456789029',
      main_media_id: null,
      price: 4900,
      prices: { USD: 4900, EUR: 4500 },
      sale_price: null,
      sale_prices: null,
      sale_start_at: null,
      sale_end_at: null,
      stock_quantity: 4,
      variant_attribute_mapping: [
        {
          attribute_term_id: TERM_RED,
          product_attribute_terms: {
            id: TERM_RED,
            attribute_id: ATTR_COLOR,
            value: 'Red',
            slug: 'red',
            sort_order: 0,
            value_translations: {},
            product_attributes: { id: ATTR_COLOR, name: 'Color', slug: 'color', name_translations: {} },
          },
        },
      ],
    },
  ],
};

/** The same product sold through Freemius: Freemius ids and a trial, no variants. */
const LIVE_FREEMIUS_PRODUCT = {
  ...LIVE_PRODUCT,
  product_type: 'digital',
  payment_provider: 'freemius',
  is_taxable: false,
  freemius_product_id: '12345',
  freemius_plan_id: '67890',
  trial_period_days: 14,
  trial_requires_payment_method: true,
  product_variants: [],
};

const DRAFT_BLOCK = {
  id: 11,
  product_id: PRODUCT_ID,
  language_id: 1,
  block_type: 'text',
  content: { html_content: '<p>Edited in a block</p>' },
  order: 0,
};

/** The draft row's created_at: after the live row's updated_at unless a test moves it. */
const DRAFT_CREATED_AT = '2026-06-02T09:00:00.123456+00:00';

const mocks = vi.hoisted(() => ({
  user: { id: 'admin-1' } as { id: string } | null,
  role: 'ADMIN' as string | null,
  twoFactorStatus: 'satisfied' as string,
  draftMeta: {} as Record<string, unknown>,
  draftBlocks: [] as unknown[],
  draftCreatedAt: '',
  /** The products row the cookie client reads (slug, overlay fields, updated_at). */
  liveRow: {} as Record<string, unknown>,
  /** The rows a products UPDATE ... select('id') returns: [] is what RLS answers to a refusal. */
  productUpdateRows: [] as unknown[],
  /**
   * The rows the draft claim (a product_drafts UPDATE ... select('id')) returns: [] when the row no
   * longer matches the id and updated_at it was narrowed to. With `draftClaimError`, an error instead.
   */
  draftClaimRows: [] as unknown[],
  draftClaimError: null as string | null,
  /** An error for the draft row DELETE at the end of a publish (null: it succeeds). */
  draftDeleteError: null as string | null,
  /** The product's live description block ids (the blocks read pages them with range()). */
  liveBlockIds: [] as number[],
  /** Errors for the blocks read, the insert, and each blocks DELETE in turn (null: it succeeds). */
  blocksReadError: null as string | null,
  blocksInsertError: null as string | null,
  /** How many of its new ids a blocks INSERT ... select('id') returns (null: one per row). */
  blocksInsertReturned: null as number | null,
  blocksDeleteErrors: [] as Array<string | null>,
  /**
   * The ids each blocks DELETE in turn reports removed when it succeeds (null: every id it was
   * narrowed to). Fewer is what PostgREST answers when the rows were already gone.
   */
  blocksDeleteRemoved: [] as Array<number[] | null>,
  /** Every `.in(column, values)` filter, with the operation and table it narrowed. */
  cookieIns: vi.fn(),
  /** Every `.eq(column, value)` filter, with the operation and table it narrowed. */
  cookieEqs: vi.fn(),
  /** Every `.range(from, to)` the blocks read asked for. */
  cookieRanges: vi.fn(),
  cookieReads: vi.fn(),
  cookieWrites: vi.fn(),
  /** select() chained after a write: supabase-js returns the written rows only then. */
  cookieWriteSelects: vi.fn(),
  serviceClientCreated: vi.fn(),
  getProduct: vi.fn(),
  updateProduct: vi.fn(),
  syncProductSaleCouponToFreemius: vi.fn(),
  getFullProductContent: vi.fn(),
  createProductRevision: vi.fn(),
  revalidatePath: vi.fn(),
}));

/** Ids the database gives the blocks a publish inserts. */
const FIRST_INSERTED_BLOCK_ID = 101;

/**
 * The cookie client: reads answer per table and are recorded, writes are recorded and succeed unless a
 * blocks error is set. A blocks INSERT ... select('id') returns the new ids; a blocks DELETE takes the
 * next entry of `blocksDeleteErrors` and, with select('id'), returns the next entry of
 * `blocksDeleteRemoved` (every id it was narrowed to by default). A product_drafts UPDATE (the claim)
 * with select('id') returns `draftClaimRows`, or `draftClaimError`.
 */
function makeCookieClient() {
  return {
    auth: { getUser: async () => ({ data: { user: mocks.user }, error: null }) },
    from: (table: string) => {
      let op: 'select' | 'update' | 'insert' | 'delete' = 'select';
      let selectedAfterWrite = false;
      let insertedValues: unknown = null;
      let range: [number, number] | null = null;
      let narrowedIds: unknown[] = [];
      const chain: Record<string, unknown> = {};
      const settleBlocks = () => {
        if (op === 'select') {
          if (mocks.blocksReadError) return { data: null, error: { message: mocks.blocksReadError } };
          const [from, to] = range ?? [0, mocks.liveBlockIds.length - 1];
          return { data: mocks.liveBlockIds.slice(from, to + 1).map((id) => ({ id })), error: null };
        }
        if (op === 'insert') {
          if (mocks.blocksInsertError) return { data: null, error: { message: mocks.blocksInsertError } };
          const rows = Array.isArray(insertedValues) ? insertedValues : [insertedValues];
          const returned = rows.slice(0, mocks.blocksInsertReturned ?? rows.length);
          return {
            data: selectedAfterWrite ? returned.map((_row, index) => ({ id: FIRST_INSERTED_BLOCK_ID + index })) : null,
            error: null,
          };
        }
        if (op === 'delete') {
          const message = mocks.blocksDeleteErrors.shift() ?? null;
          const removed = mocks.blocksDeleteRemoved.shift() ?? narrowedIds;
          if (message) return { data: null, error: { message } };
          return { data: selectedAfterWrite ? removed.map((id) => ({ id })) : null, error: null };
        }
        return { data: null, error: null };
      };
      const read = () => {
        if (table === 'profiles') return { data: mocks.role ? { role: mocks.role } : null, error: null };
        if (table === 'product_drafts') {
          return {
            data: {
              id: 7,
              product_id: PRODUCT_ID,
              author_id: 'admin-1',
              meta: mocks.draftMeta,
              blocks: mocks.draftBlocks,
              created_at: mocks.draftCreatedAt,
              updated_at: mocks.draftCreatedAt,
            },
            error: null,
          };
        }
        if (table === 'products') return { data: mocks.liveRow, error: null };
        return { data: null, error: null };
      };
      chain.select = (columns?: string) => {
        if (op === 'select') {
          mocks.cookieReads(table, columns);
        } else {
          selectedAfterWrite = true;
          mocks.cookieWriteSelects(op, table, columns);
        }
        return chain;
      };
      chain.eq = (column: string, value: unknown) => {
        mocks.cookieEqs(op, table, column, value);
        return chain;
      };
      chain.order = () => chain;
      chain.in = (column: string, values: unknown) => {
        mocks.cookieIns(op, table, column, values);
        if (column === 'id' && Array.isArray(values)) narrowedIds = values;
        return chain;
      };
      chain.range = (from: number, to: number) => {
        range = [from, to];
        mocks.cookieRanges(table, from, to);
        return chain;
      };
      chain.single = async () => read();
      chain.maybeSingle = async () => read();
      for (const name of ['update', 'insert', 'delete'] as const) {
        chain[name] = (values?: unknown) => {
          op = name;
          if (name === 'insert') insertedValues = values;
          mocks.cookieWrites(name, table, values);
          return chain;
        };
      }
      const settleDraftClaim = () =>
        mocks.draftClaimError
          ? { data: null, error: { message: mocks.draftClaimError } }
          : { data: selectedAfterWrite ? mocks.draftClaimRows : null, error: null };
      chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(
          table === 'blocks'
            ? settleBlocks()
            : op === 'update' && table === 'products'
              ? { data: selectedAfterWrite ? mocks.productUpdateRows : null, error: null }
              : op === 'update' && table === 'product_drafts'
                ? settleDraftClaim()
                : op === 'delete' && table === 'product_drafts' && mocks.draftDeleteError
                  ? { data: null, error: { message: mocks.draftDeleteError } }
                  : { data: null, error: null }
        ).then(resolve, reject);
      return chain;
    },
  };
}

const cookieClient = makeCookieClient();
const serviceClient = { from: vi.fn() };

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@nextblock-cms/db/server', () => ({
  createClient: () => cookieClient,
  getServiceRoleSupabaseClient: () => {
    mocks.serviceClientCreated();
    return serviceClient;
  },
  getSsgSupabaseClient: vi.fn(),
}));
// product-drafts.ts imports each from its own module, never the /server barrel (the product page
// imports it; tools/scripts/commerce-chunking.test.ts).
vi.mock('@nextblock-cms/ecommerce/product-actions', () => ({
  getProduct: mocks.getProduct,
  updateProduct: mocks.updateProduct,
}));
vi.mock('@nextblock-cms/ecommerce/freemius-coupons', () => ({
  syncProductSaleCouponToFreemius: mocks.syncProductSaleCouponToFreemius,
}));
// The second factor is driven per test; its own logic is covered by lib/auth/cms-actor.test.ts.
vi.mock('../auth/twoFactor', () => ({
  evaluateTwoFactor: async () => ({ status: mocks.twoFactorStatus, userId: mocks.user?.id ?? null, mfaType: null }),
}));
vi.mock('../../app/cms/revisions/utils', () => ({ getFullProductContent: mocks.getFullProductContent }));
vi.mock('../../app/cms/revisions/service', () => ({ createProductRevision: mocks.createProductRevision }));

import {
  PRODUCT_DESCRIPTION_BLOCKS_CHANGED_WARNING,
  PRODUCT_DRAFT_PUBLISH_CLAIM_REFUSED_ERROR,
  PRODUCT_PUBLISH_ADMIN_ONLY_ERROR,
  currentUserCanPublishProductDrafts,
  discardProductVisualEditingDraft,
  publishProductVisualEditingDraft,
} from './product-drafts';
import {
  PRODUCT_DRAFT_FORM_MARKER_KEY,
  PRODUCT_DRAFT_FORM_MARKER_VALUE,
  describeSkippedProductDraftOverlay,
} from './product-draft-meta';
import {
  buildPoisonedProductDraftPublishError,
  findPoisonedProductDraftFields,
} from '../../app/cms/products/productFormData';

const MARKER = { [PRODUCT_DRAFT_FORM_MARKER_KEY]: PRODUCT_DRAFT_FORM_MARKER_VALUE };

/**
 * A partial product-values meta (what the coupon tests publish; the rest comes from live), marked as
 * a 0.23.4 autosave: unmarked, its $10,000 price (over 20 times the live $49) reads as an old
 * autosave's x100 price and is refused (findPoisonedProductDraftFields, productFormData.test.ts).
 */
const FULL_FORM_META = {
  title: 'Pro plugin',
  slug: 'pro-plugin',
  sku: 'PRO',
  price: 10000,
  sale_price: 0,
  status: 'draft',
  payment_provider: 'freemius',
  ...MARKER,
};

/** What the product form's autosave stores since 0.23.4: every form value in major units, the marker. */
const FORM_AUTOSAVE_VALUES = {
  product_type: 'physical',
  payment_provider: 'stripe',
  title: 'Pro plugin (edited)',
  slug: 'pro-plugin',
  sku: 'PRO',
  upc: '0123456789012',
  is_taxable: true,
  price: 59,
  prices: { USD: 59, EUR: 55 },
  sale_price: null,
  sale_prices: {},
  // ProductForm loads the live window since 0.23.4, so the autosave always carries both bounds.
  sale_start_at: LIVE_PRODUCT.sale_start_at,
  sale_end_at: LIVE_PRODUCT.sale_end_at,
  stock: 4,
  meta_title: 'Edited meta title',
  meta_description: 'Edited meta description',
  custom_canonical: 'https://example.com/pro-plugin',
  short_description: 'Edited short copy',
  description_json: LIVE_PRODUCT.description_json,
  freemius_product_id: '',
  freemius_plan_id: '',
  trial_period_days: 0,
  trial_requires_payment_method: false,
  status: 'draft',
  language_id: 1,
  translation_group_id: GROUP_ID,
  product_media: [{ media_id: 'media-1' }],
  category_ids: [],
  variation_attributes: [{ attribute_id: ATTR_COLOR, term_ids: [TERM_RED] }],
  variants: [
    {
      id: 'variant-1',
      combination_key: TERM_RED,
      sku: 'PRO-RED',
      upc: '0123456789029',
      price: 59,
      prices: { USD: 59, EUR: 55 },
      sale_price: null,
      sale_prices: {},
      sale_start_at: null,
      sale_end_at: null,
      stock_quantity: 4,
      main_media_id: null,
      main_image_url: null,
      attribute_term_ids: [TERM_RED],
      selected_options: [
        { attribute_id: ATTR_COLOR, attribute_name: 'Color', term_id: TERM_RED, term_value: 'Red', term_slug: 'red' },
      ],
      label: 'Red',
    },
  ],
};
const FORM_AUTOSAVE_META = { ...FORM_AUTOSAVE_VALUES, ...MARKER };

/** What getOrCreateProductDraft() stored before 0.23.4: the raw products row, cents, no variants. */
const LEGACY_ROW_SNAPSHOT = {
  id: PRODUCT_ID,
  title: 'Pro plugin',
  slug: 'pro-plugin',
  sku: 'PRO',
  upc: '0123456789012',
  price: 4900,
  prices: { USD: 4900, EUR: 4500 },
  sale_price: 3900,
  sale_prices: { USD: 3900 },
  is_taxable: true,
  product_type: 'physical',
  payment_provider: 'stripe',
  short_description: 'Short copy',
  stock: 4,
  status: 'active',
  language_id: 1,
  translation_group_id: GROUP_ID,
  meta_title: 'Pro plugin | Store',
  meta_description: 'The pro plugin.',
  custom_canonical: 'https://example.com/pro-plugin',
  freemius_product_id: null,
  freemius_plan_id: null,
  trial_period_days: 0,
  trial_requires_payment_method: false,
};

/**
 * The first autosave the pre-0.23.4 edit page made over LEGACY_ROW_SNAPSHOT (sanitized
 * ProductFormValues, no marker): it showed the snapshot's cents as dollars, no variants, no gallery and
 * ProductForm's empty description, so any dirty field stored all of that.
 */
const POISONED_AUTOSAVE = {
  product_type: 'physical',
  payment_provider: 'stripe',
  title: 'Pro plugin (renamed in the form)',
  slug: 'pro-plugin',
  sku: 'PRO',
  upc: '0123456789012',
  is_taxable: true,
  price: 4900,
  prices: { USD: 4900, EUR: 4500 },
  sale_price: 3900,
  sale_prices: { USD: 3900 },
  stock: 4,
  meta_title: 'Pro plugin | Store',
  meta_description: 'The pro plugin.',
  custom_canonical: 'https://example.com/pro-plugin',
  short_description: 'Short copy',
  description_json: { type: 'doc', content: [{ type: 'paragraph' }] },
  freemius_product_id: '',
  freemius_plan_id: '',
  trial_period_days: 0,
  trial_requires_payment_method: false,
  status: 'active',
  language_id: 1,
  translation_group_id: GROUP_ID,
  product_media: [],
  category_ids: [],
  variation_attributes: [],
  variants: [],
};

const BEFORE = { meta: { title: 'Pro plugin' }, blocks: [] };
const AFTER = { meta: { title: 'Pro plugin (edited)' }, blocks: [DRAFT_BLOCK] };

function expectNothingWritten() {
  expect(mocks.updateProduct).not.toHaveBeenCalled();
  expect(mocks.syncProductSaleCouponToFreemius).not.toHaveBeenCalled();
  expect(mocks.cookieWrites).not.toHaveBeenCalled();
  expect(mocks.createProductRevision).not.toHaveBeenCalled();
  expect(mocks.revalidatePath).not.toHaveBeenCalled();
}

/** The tables the cookie client read, in order. */
function readTables() {
  return mocks.cookieReads.mock.calls.map(([table]) => table);
}

/** Every products write the cookie client saw (the RPC path goes through the mocked updateProduct). */
function productRowWrites() {
  return mocks.cookieWrites.mock.calls.filter(([, table]) => table === 'products' || table === 'product_variants');
}

/** The live description block ids beforeEach gives the product. */
const LIVE_BLOCK_IDS = [5, 6];

/** The blocks writes, in order, as `<op> blocks`. */
function blockWrites() {
  return mocks.cookieWrites.mock.calls.filter(([, table]) => table === 'blocks').map(([op]) => `${op} blocks`);
}

/** The draft claim: the UPDATE publish sends to product_drafts before any other write. */
const CLAIM_WRITE = ['update', 'product_drafts', { author_id: 'admin-1' }];

/** The `.eq()` filters of product_drafts UPDATEs (the claim), as [column, value]. */
function claimFilters() {
  return mocks.cookieEqs.mock.calls
    .filter(([op, table]) => op === 'update' && table === 'product_drafts')
    .map(([, , column, value]) => [column, value]);
}

/** The ids each blocks DELETE was narrowed to, in order. */
function deletedBlockIds() {
  return mocks.cookieIns.mock.calls
    .filter(([op, table, column]) => op === 'delete' && table === 'blocks' && column === 'id')
    .map(([, , , ids]) => ids);
}

/** The draft's rows went in first, then exactly the captured live ids came out; the draft was removed. */
function expectBlocksPublished() {
  expect(mocks.cookieWrites).toHaveBeenCalledWith('insert', 'blocks', [
    expect.objectContaining({ product_id: PRODUCT_ID, block_type: 'text', content: DRAFT_BLOCK.content }),
  ]);
  expect(blockWrites()).toEqual(['insert blocks', 'delete blocks']);
  expect(deletedBlockIds()).toEqual([LIVE_BLOCK_IDS]);
  expect(mocks.cookieWrites).toHaveBeenCalledWith('delete', 'product_drafts', undefined);
}

/** History recorded through the ADMIN's own session, with the before/after pair and their id. */
function expectRevisionRecordedByTheAdmin() {
  expect(mocks.getFullProductContent.mock.calls).toEqual([
    [PRODUCT_ID, undefined, cookieClient],
    [PRODUCT_ID, undefined, cookieClient],
  ]);
  expect(mocks.createProductRevision).toHaveBeenCalledTimes(1);
  expect(mocks.createProductRevision).toHaveBeenCalledWith(PRODUCT_ID, 'admin-1', BEFORE, AFTER, cookieClient);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = { id: 'admin-1' };
  mocks.role = 'ADMIN';
  mocks.twoFactorStatus = 'satisfied';
  mocks.draftMeta = { ...FULL_FORM_META };
  mocks.draftBlocks = [DRAFT_BLOCK];
  mocks.draftCreatedAt = DRAFT_CREATED_AT;
  mocks.liveRow = {
    slug: LIVE_PRODUCT.slug,
    status: LIVE_PRODUCT.status,
    title: LIVE_PRODUCT.title,
    short_description: LIVE_PRODUCT.short_description,
    description_json: LIVE_PRODUCT.description_json,
    updated_at: LIVE_PRODUCT.updated_at,
  };
  mocks.productUpdateRows = [{ id: PRODUCT_ID }];
  mocks.draftClaimRows = [{ id: 7 }];
  mocks.draftClaimError = null;
  mocks.draftDeleteError = null;
  mocks.liveBlockIds = [...LIVE_BLOCK_IDS];
  mocks.blocksReadError = null;
  mocks.blocksInsertError = null;
  mocks.blocksInsertReturned = null;
  mocks.blocksDeleteErrors = [];
  mocks.blocksDeleteRemoved = [];
  mocks.getProduct.mockResolvedValue({ data: LIVE_PRODUCT, error: null });
  mocks.updateProduct.mockResolvedValue(PRODUCT_ID);
  mocks.syncProductSaleCouponToFreemius.mockResolvedValue({ status: 'synced' });
  // Reset, not just cleared: a test that stops after the first read must not shift the next one's pair.
  mocks.getFullProductContent.mockReset();
  mocks.getFullProductContent.mockResolvedValueOnce(BEFORE).mockResolvedValueOnce(AFTER);
  mocks.createProductRevision.mockResolvedValue({ success: true, version: 2, recorded: true });
});

const DRAFT_KINDS: Array<[string, () => Record<string, unknown>]> = [
  ['product values (a form autosave)', () => structuredClone(FORM_AUTOSAVE_META)],
  ['an overlay (a block or in-page edit since 0.23.4)', () => ({ title: 'New title' })],
  ['a block-only overlay (meta {})', () => ({})],
  ['a legacy row snapshot (a block edit before 0.23.4)', () => ({ ...LEGACY_ROW_SNAPSHOT, title: 'Renamed in page' })],
];

describe('publishing any product draft needs an ADMIN past the second factor, checked before anything is read', () => {
  it.each(DRAFT_KINDS)('refuses a WRITER for %s: only their role is read, nothing is written', async (_kind, meta) => {
    mocks.role = 'WRITER';
    mocks.draftMeta = meta();

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({
      success: false,
      error: PRODUCT_PUBLISH_ADMIN_ONLY_ERROR,
    });
    expect(PRODUCT_PUBLISH_ADMIN_ONLY_ERROR).toBe('Only an administrator can publish products.');
    expect(readTables()).toEqual(['profiles']);
    expect(mocks.getProduct).not.toHaveBeenCalled();
    expect(mocks.getFullProductContent).not.toHaveBeenCalled();
    expect(mocks.serviceClientCreated).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it.each(DRAFT_KINDS)('refuses a customer or partner account (USER, RTL) for %s', async (_kind, meta) => {
    for (const role of ['USER', 'RTL']) {
      vi.clearAllMocks();
      mocks.role = role;
      mocks.draftMeta = meta();

      await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({
        success: false,
        error: PRODUCT_PUBLISH_ADMIN_ONLY_ERROR,
      });
      expect(readTables()).toEqual(['profiles']);
      expectNothingWritten();
    }
  });

  it.each(DRAFT_KINDS)(
    'refuses an ADMIN whose second factor is pending, and an anonymous caller, for %s: nothing is read',
    async (_kind, meta) => {
      for (const [user, status] of [
        [{ id: 'admin-1' }, 'totp_required'],
        [{ id: 'admin-1' }, 'email_required'],
        [null, 'satisfied'],
      ] as const) {
        vi.clearAllMocks();
        mocks.user = user;
        mocks.twoFactorStatus = status;
        mocks.draftMeta = meta();

        await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({
          success: false,
          error: `${PRODUCT_PUBLISH_ADMIN_ONLY_ERROR} If you are one, sign in and complete two-factor verification, then publish again.`,
        });
        expect(readTables()).toEqual([]);
        expect(mocks.getProduct).not.toHaveBeenCalled();
        expect(mocks.serviceClientCreated).not.toHaveBeenCalled();
        expectNothingWritten();
      }
    }
  );
});

describe('an ADMIN publish of product values', () => {
  it('pushes the sale coupon with the service client, keeps the live visibility and records History as the admin', async () => {
    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    // The RPC still runs as the caller.
    expect(mocks.updateProduct).toHaveBeenCalledWith(
      cookieClient,
      PRODUCT_ID,
      expect.objectContaining({ sku: 'PRO', price: 10000, status: 'active' })
    );
    // Three arguments: no media-removal callback, so a product publish never deletes media.
    expect(mocks.updateProduct.mock.calls[0]).toHaveLength(3);
    expect(mocks.syncProductSaleCouponToFreemius).toHaveBeenCalledWith({ productId: PRODUCT_ID, client: serviceClient });
    expectBlocksPublished();
    expectRevisionRecordedByTheAdmin();
  });

  it('pushes no coupon for a Stripe product', async () => {
    mocks.draftMeta = { ...FULL_FORM_META, payment_provider: 'stripe' };

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });
    expect(mocks.updateProduct).toHaveBeenCalledTimes(1);
    expect(mocks.syncProductSaleCouponToFreemius).not.toHaveBeenCalled();
  });
  // Review 2026-11-15: the push never throws (it records the failure on the coupon row and returns it),
  // and publish ignored that answer: the editor read "published" while Freemius' checkout kept charging
  // without the sale the storefront showed.
  it.each([
    ['returns a failure', () => mocks.syncProductSaleCouponToFreemius.mockResolvedValue({ success: false, error: 'fetch failed' })],
    ['throws', () => mocks.syncProductSaleCouponToFreemius.mockRejectedValue(new Error('fetch failed'))],
  ] as const)('publishes with a warning when the Freemius sale coupon push %s', async (_case, arrange) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    arrange();

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({
      success: true,
      warning:
        "Published, but the Freemius sale coupon was not updated (fetch failed): Freemius' checkout does not apply the sale price until it is. Save a change in the product form and publish it once Freemius answers (a description-block or in-page edit does not push the coupon).",
    });
    expectBlocksPublished();
  });

  it('hands the form autosave to updateProduct with exactly its values, never the marker', async () => {
    mocks.draftMeta = structuredClone(FORM_AUTOSAVE_META);

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    expect(mocks.updateProduct).toHaveBeenCalledTimes(1);
    expect(mocks.updateProduct).toHaveBeenCalledWith(cookieClient, PRODUCT_ID, {
      ...FORM_AUTOSAVE_VALUES,
      // Pinned to the live visibility, as before.
      status: 'active',
    });
    expect(mocks.updateProduct.mock.calls[0][2]).not.toHaveProperty(PRODUCT_DRAFT_FORM_MARKER_KEY);
    expect(productRowWrites()).toEqual([]);
    expectRevisionRecordedByTheAdmin();
  });

  it('completes a partial product-values draft from the live product: never variants: [], no cleared description, schedule, canonical or UPC', async () => {
    mocks.draftMeta = { sku: 'PRO', price: 59 };

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    expect(mocks.updateProduct).toHaveBeenCalledTimes(1);
    const values = mocks.updateProduct.mock.calls[0][2];
    // The draft's own values win.
    expect(values.sku).toBe('PRO');
    expect(values.price).toBe(59);
    // Everything else is the live product in the units updateProduct multiplies by 100.
    expect(values.variants).toEqual([
      expect.objectContaining({
        id: 'variant-1',
        sku: 'PRO-RED',
        upc: '0123456789029',
        price: 49,
        prices: { USD: 49, EUR: 45 },
        sale_price: null,
        stock_quantity: 4,
        attribute_term_ids: [TERM_RED],
      }),
    ]);
    expect(values.description_json).toEqual(LIVE_PRODUCT.description_json);
    expect(values.sale_start_at).toBe(LIVE_PRODUCT.sale_start_at);
    expect(values.sale_end_at).toBe(LIVE_PRODUCT.sale_end_at);
    expect(values.prices).toEqual({ USD: 49, EUR: 45 });
    expect(values.sale_price).toBe(39);
    expect(values.sale_prices).toEqual({ USD: 39 });
    expect(values).toMatchObject({
      title: 'Pro plugin',
      slug: 'pro-plugin',
      upc: '0123456789012',
      custom_canonical: 'https://example.com/pro-plugin',
      stock: 4,
      short_description: 'Short copy',
      meta_title: 'Pro plugin | Store',
      meta_description: 'The pro plugin.',
      product_type: 'physical',
      payment_provider: 'stripe',
      status: 'active',
    });
    // Gallery and categories stay out, so updateProduct leaves both alone.
    expect(values).not.toHaveProperty('product_media');
    expect(values).not.toHaveProperty('category_ids');
  });

  it("keeps a Freemius product's ids and trial from live when the draft does not carry them", async () => {
    mocks.getProduct.mockResolvedValue({ data: LIVE_FREEMIUS_PRODUCT, error: null });
    mocks.draftMeta = { sku: 'PRO', price: 59, ...MARKER };

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    expect(mocks.updateProduct.mock.calls[0][2]).toMatchObject({
      product_type: 'digital',
      payment_provider: 'freemius',
      freemius_product_id: '12345',
      freemius_plan_id: '67890',
      trial_period_days: 14,
      trial_requires_payment_method: true,
      custom_canonical: 'https://example.com/pro-plugin',
      upc: '0123456789012',
    });
    expect(mocks.syncProductSaleCouponToFreemius).toHaveBeenCalledWith({ productId: PRODUCT_ID, client: serviceClient });
  });

  it("publishes a CMS draft import's prices, taking only the keys the import never writes from live", async () => {
    // What lib/cms-transfer/server.ts upserts in "draft" apply mode (major units, variants always
    // set, the marker; no sale schedule and no canonical).
    const importValues = {
      language_id: 1,
      translation_group_id: GROUP_ID,
      product_type: 'physical',
      payment_provider: 'stripe',
      title: 'Pro plugin',
      slug: 'pro-plugin',
      sku: 'PRO',
      upc: null,
      status: 'draft',
      price: 29.5,
      prices: { USD: 29.5, EUR: 27 },
      sale_price: null,
      sale_prices: {},
      stock: 9,
      is_taxable: true,
      meta_title: null,
      meta_description: null,
      short_description: 'Imported copy',
      description_json: { type: 'doc', content: [] },
      freemius_product_id: null,
      freemius_plan_id: null,
      trial_period_days: 0,
      trial_requires_payment_method: false,
      product_media: [{ media_id: 'media-1' }],
      category_ids: [],
      variants: [],
    };
    mocks.draftMeta = { ...structuredClone(importValues), ...MARKER };

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    expect(mocks.updateProduct).toHaveBeenCalledWith(cookieClient, PRODUCT_ID, {
      ...importValues,
      status: 'active',
      sale_start_at: LIVE_PRODUCT.sale_start_at,
      sale_end_at: LIVE_PRODUCT.sale_end_at,
      custom_canonical: 'https://example.com/pro-plugin',
    });
  });

  it('keeps the live variants and price when a product-values draft carries null for them', async () => {
    mocks.draftMeta = { sku: 'PRO', price: null, variants: null, prices: null };

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    const values = mocks.updateProduct.mock.calls[0][2];
    expect(values.price).toBe(49);
    expect(values.prices).toEqual({ USD: 49, EUR: 45 });
    expect(values.variants).toHaveLength(1);
  });

  it('takes the sale window as one unit: a draft that set only a new start publishes an open end, never the live end', async () => {
    // A pre-0.23.4 form autosave where the editor typed a start only (the form never showed the live
    // window): merged key by key, the live end (Nov 30) fell before the new start, which CHECK
    // products_sale_window_valid refuses.
    mocks.draftMeta = { sku: 'PRO', price: 49, sale_price: 39, sale_start_at: '2026-12-05T00:00:00.000Z' };

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    const values = mocks.updateProduct.mock.calls[0][2];
    expect(values.sale_start_at).toBe('2026-12-05T00:00:00.000Z');
    expect(values.sale_end_at).toBeNull();
  });
});

describe('a product-values draft an earlier version saved over a row snapshot', () => {
  // Which fields count is productFormData's (findPoisonedProductDraftFields, productFormData.test.ts);
  // these pin that publish refuses with them before anything is read for the write or written.
  it('is refused before any write, naming the poisoned fields and what to do', async () => {
    mocks.draftMeta = structuredClone(POISONED_AUTOSAVE);
    const fields = findPoisonedProductDraftFields(POISONED_AUTOSAVE, LIVE_PRODUCT);
    expect(fields).toEqual(expect.arrayContaining(['prices', 'variants', 'product_media', 'description_json']));

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({
      success: false,
      error: buildPoisonedProductDraftPublishError(fields),
    });
    expectNothingWritten();
    expect(mocks.getFullProductContent).not.toHaveBeenCalled();
    expect(readTables()).not.toContain('blocks');
  });

  it('is refused for its x100 price alone (a digital product: no variants to lose, no gallery, no description)', async () => {
    const live = { ...LIVE_FREEMIUS_PRODUCT, product_media: [], description_json: null, sale_price: null, sale_prices: null };
    mocks.getProduct.mockResolvedValue({ data: live, error: null });
    mocks.draftMeta = {
      ...POISONED_AUTOSAVE,
      product_type: 'digital',
      payment_provider: 'freemius',
      sale_price: null,
      sale_prices: {},
    };
    const fields = findPoisonedProductDraftFields(mocks.draftMeta, live);
    expect(fields).toContain('prices');
    expect(fields).not.toEqual(expect.arrayContaining(['variants']));

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({
      success: false,
      error: buildPoisonedProductDraftPublishError(fields),
    });
    expectNothingWritten();
  });

  it('publishes the same values once the 0.23.4 editor saved them (the marker): an editor may set any price', async () => {
    mocks.draftMeta = { ...structuredClone(POISONED_AUTOSAVE), ...MARKER };

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    expect(mocks.updateProduct.mock.calls[0][2]).toMatchObject({ price: 4900, variants: [], product_media: [] });
  });

  it('publishes an unmarked draft with no poisoned field as before, completed from live', async () => {
    mocks.draftMeta = { ...structuredClone(FORM_AUTOSAVE_VALUES) };
    delete mocks.draftMeta.sale_start_at;
    delete mocks.draftMeta.sale_end_at;

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    expect(mocks.updateProduct.mock.calls[0][2]).toMatchObject({
      price: 59,
      sale_start_at: LIVE_PRODUCT.sale_start_at,
      sale_end_at: LIVE_PRODUCT.sale_end_at,
    });
  });
});

describe('an ADMIN publish of an overlay or a legacy row snapshot writes no price, variant or schedule', () => {
  it('publishes a block-seeded draft (meta {}) as blocks only: no product write, no RPC', async () => {
    mocks.draftMeta = {};

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    expect(mocks.updateProduct).not.toHaveBeenCalled();
    expect(mocks.getProduct).not.toHaveBeenCalled();
    expect(productRowWrites()).toEqual([]);
    expectBlocksPublished();
    expectRevisionRecordedByTheAdmin();
    // An overlay carries no slug: the public path comes from the live row.
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/product/pro-plugin');
  });

  it("writes an overlay's title through an UPDATE that returns its rows (select('id')), with updated_at", async () => {
    mocks.draftMeta = { title: 'New title', slug: 'pro-plugin' };

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    expect(productRowWrites()).toEqual([
      ['update', 'products', { title: 'New title', updated_at: expect.any(String) }],
    ]);
    // Without .select() supabase-js returns no rows, and the zero-row guard would refuse every publish.
    expect(mocks.cookieWriteSelects).toHaveBeenCalledWith('update', 'products', 'id');
    expect(mocks.updateProduct).not.toHaveBeenCalled();
    expect(mocks.syncProductSaleCouponToFreemius).not.toHaveBeenCalled();
    expectBlocksPublished();
    expectRevisionRecordedByTheAdmin();
  });

  it('reports an UPDATE that matched no row instead of "Published", before the blocks', async () => {
    mocks.draftMeta = { title: 'New title' };
    mocks.productUpdateRows = [];

    const result = await publishProductVisualEditingDraft(PRODUCT_ID);

    expect(result).toEqual({
      success: false,
      error:
        "The product's title or description was not saved: your account cannot update this product. Nothing was published; the draft is kept.",
    });
    // After the claim, the refused UPDATE is the only write: no blocks, no draft removal, no revision.
    expect(mocks.cookieWrites.mock.calls).toEqual([
      CLAIM_WRITE,
      ['update', 'products', { title: 'New title', updated_at: expect.any(String) }],
    ]);
    expect(mocks.createProductRevision).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('publishes a pre-0.23.4 row snapshot (cents, an id, no variants) without the RPC or a price write', async () => {
    mocks.draftMeta = { ...LEGACY_ROW_SNAPSHOT };

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    expect(mocks.updateProduct).not.toHaveBeenCalled();
    expect(mocks.getProduct).not.toHaveBeenCalled();
    // Its title and short description still match the live row, so the product row is not written.
    expect(productRowWrites()).toEqual([]);
    expectBlocksPublished();
  });

  it("writes a row snapshot's changed overlay fields while the live row is unchanged since the draft was created", async () => {
    mocks.draftMeta = {
      ...LEGACY_ROW_SNAPSHOT,
      title: 'Renamed in page',
      description_json: { type: 'doc', content: [] },
    };

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    expect(mocks.updateProduct).not.toHaveBeenCalled();
    expect(productRowWrites()).toEqual([
      [
        'update',
        'products',
        { title: 'Renamed in page', description_json: { type: 'doc', content: [] }, updated_at: expect.any(String) },
      ],
    ]);
  });

  it('publishes a row snapshot as blocks only when the live row changed after the draft was created, and says what it skipped', async () => {
    // A data migration (02020 rewrote product copy and set updated_at) or Cortex changed the row after
    // a block edit created this draft: its title is the old one, not an in-page edit we can tell apart.
    // Created on May 25 by a master deploy whose seed still copied the description, so that may be an
    // old copy too.
    mocks.draftCreatedAt = '2026-05-25T09:00:00+00:00';
    mocks.liveRow = { ...mocks.liveRow, title: 'Pro plugin, rewritten', updated_at: '2026-10-15T08:00:00+00:00' };
    mocks.draftMeta = {
      ...LEGACY_ROW_SNAPSHOT,
      description_json: { type: 'doc', content: [] },
    };

    const result = await publishProductVisualEditingDraft(PRODUCT_ID);

    expect(result).toEqual({
      success: true,
      warning: describeSkippedProductDraftOverlay(['title', 'description_json']),
    });
    expect((result as { warning: string }).warning).toContain("the draft's title and description were not published");
    expect(productRowWrites()).toEqual([]);
    expect(mocks.updateProduct).not.toHaveBeenCalled();
    expectBlocksPublished();
    expectRevisionRecordedByTheAdmin();
  });

  it("writes the description of a snapshot created from 2026-05-28 on after a live change: no seed copied it, so it is an in-page edit (probe D)", async () => {
    // 3d6942f2 (2026-05-27) took description_json out of the seed and no release seeded drafts before
    // 0.8.11, so in this June draft the description can only be an in-page edit. The title keeps the rule.
    const inPageDescription = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Edited in page in June' }] }] };
    mocks.draftCreatedAt = '2026-06-10T09:00:00+00:00';
    mocks.liveRow = { ...mocks.liveRow, title: 'Pro plugin, rewritten', updated_at: '2026-11-10T10:00:00+00:00' };
    mocks.draftMeta = { ...LEGACY_ROW_SNAPSHOT, description_json: inPageDescription };

    const result = await publishProductVisualEditingDraft(PRODUCT_ID);

    expect(result).toEqual({ success: true, warning: describeSkippedProductDraftOverlay(['title'], ['description_json']) });
    expect((result as { warning: string }).warning).toMatch(/^Published the description blocks and the draft's description\. /);
    expect(productRowWrites()).toEqual([
      ['update', 'products', { description_json: inPageDescription, updated_at: expect.any(String) }],
    ]);
    expectBlocksPublished();
  });

  it('treats an unreadable updated_at as changed: blocks only', async () => {
    mocks.liveRow = { ...mocks.liveRow, updated_at: null };
    mocks.draftMeta = { ...LEGACY_ROW_SNAPSHOT, title: 'Renamed in page' };

    const result = await publishProductVisualEditingDraft(PRODUCT_ID);

    expect(result).toEqual({ success: true, warning: describeSkippedProductDraftOverlay(['title']) });
    expect(productRowWrites()).toEqual([]);
  });

  it('still applies an overlay written since 0.23.4 when the live row changed: those are in-page edits', async () => {
    mocks.liveRow = { ...mocks.liveRow, updated_at: '2026-10-15T08:00:00+00:00' };
    mocks.draftMeta = { title: 'New title' };

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });
    expect(productRowWrites()).toEqual([
      ['update', 'products', { title: 'New title', updated_at: expect.any(String) }],
    ]);
  });

  it('adds the History warning to a skipped-fields warning', async () => {
    mocks.liveRow = { ...mocks.liveRow, title: 'Pro plugin, rewritten', updated_at: '2026-10-15T08:00:00+00:00' };
    mocks.draftMeta = { ...LEGACY_ROW_SNAPSHOT };
    mocks.createProductRevision.mockResolvedValue({ error: 'Failed to insert product revision: boom' });

    const result = await publishProductVisualEditingDraft(PRODUCT_ID);

    expect(result).toEqual({
      success: true,
      warning: `${describeSkippedProductDraftOverlay(['title'])} Published, but history was not recorded: Failed to insert product revision: boom`,
    });
  });
});

describe('revalidation', () => {
  it('revalidates the live slug and a renamed draft slug', async () => {
    mocks.draftMeta = { ...structuredClone(FORM_AUTOSAVE_META), slug: 'pro-plugin-renamed' };

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    expect(mocks.revalidatePath).toHaveBeenCalledWith('/product/pro-plugin');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/product/pro-plugin-renamed');
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/cms/products/${PRODUCT_ID}/edit`);
  });
});

/**
 * The block swap has no transaction around it: supabase-js sends the product write, the blocks
 * INSERT and the blocks DELETE as separate requests. Until round 6 publish deleted the product's
 * blocks first and inserted the draft's after, so a failed insert (a language FK error, say) left
 * the product's new values live with no description blocks at all, and discarding the draft brought
 * nothing back (verify round 5, mhalf/half.test.ts).
 */
describe('the block swap: the draft rows in, then only the captured live ids out', () => {
  it('reads the live ids before any write, inserts the draft rows, then deletes exactly those ids', async () => {
    mocks.draftMeta = structuredClone(FORM_AUTOSAVE_META);

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    expect(mocks.cookieReads).toHaveBeenCalledWith('blocks', 'id');
    // Read before the product write (updateProduct) and before the first blocks write.
    const blocksRead = mocks.cookieReads.mock.calls.findIndex(([table]) => table === 'blocks');
    expect(blocksRead).toBeGreaterThan(-1);
    expect(mocks.cookieReads.mock.invocationCallOrder[blocksRead]).toBeLessThan(
      mocks.updateProduct.mock.invocationCallOrder[0]
    );
    expectBlocksPublished();
    // The delete is narrowed to this product as well as to the ids.
    expect(mocks.cookieIns).toHaveBeenCalledWith('delete', 'blocks', 'id', LIVE_BLOCK_IDS);
    expectRevisionRecordedByTheAdmin();
  });

  it('a failed insert deletes nothing: the live blocks stay, the error says what is live, and the draft is kept', async () => {
    mocks.draftMeta = structuredClone(FORM_AUTOSAVE_META);
    mocks.blocksInsertError =
      'insert or update on table "blocks" violates foreign key constraint "blocks_language_id_fkey"';

    const result = await publishProductVisualEditingDraft(PRODUCT_ID);

    expect(result).toEqual({
      success: false,
      error:
        'The draft\'s description blocks could not be published (insert or update on table "blocks" violates foreign key constraint "blocks_language_id_fkey"); the live ones are unchanged. The draft\'s product values (prices, variants and details) are already live. The draft is kept: publish again to finish.',
    });
    expect(mocks.updateProduct).toHaveBeenCalledTimes(1);
    expect(blockWrites()).toEqual(['insert blocks']);
    expect(mocks.cookieWrites).not.toHaveBeenCalledWith('delete', 'product_drafts', undefined);
    expect(mocks.createProductRevision).not.toHaveBeenCalled();
    // The product row is live, so the storefront and the editor show it as it now is.
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/product/pro-plugin');
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/cms/products/${PRODUCT_ID}/edit`);
  });

  it("names the overlay fields already live when the insert fails after an overlay's title went out", async () => {
    mocks.draftMeta = { title: 'New title' };
    mocks.blocksInsertError = 'boom';

    const result = await publishProductVisualEditingDraft(PRODUCT_ID);

    expect(result).toEqual({
      success: false,
      error:
        "The draft's description blocks could not be published (boom); the live ones are unchanged. The product's title is already live. The draft is kept: publish again to finish.",
    });
    expect(productRowWrites()).toEqual([['update', 'products', { title: 'New title', updated_at: expect.any(String) }]]);
    expect(blockWrites()).toEqual(['insert blocks']);
  });

  it('says nothing else was published when a block-only draft fails, and refreshes nothing', async () => {
    mocks.draftMeta = {};
    mocks.blocksInsertError = 'boom';

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({
      success: false,
      error:
        "The draft's description blocks could not be published (boom); the live ones are unchanged. Nothing else was published. The draft is kept: publish again to finish.",
    });
    expect(productRowWrites()).toEqual([]);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('a failed delete takes the rows just inserted back out, and says the live blocks are unchanged', async () => {
    mocks.draftMeta = { title: 'New title', description_json: null };
    mocks.blocksDeleteErrors = ['permission denied for table blocks', null];

    const result = await publishProductVisualEditingDraft(PRODUCT_ID);

    expect(result).toEqual({
      success: false,
      error:
        "The live description blocks could not be removed (permission denied for table blocks); the draft's new rows were taken back out, so the live ones are unchanged. The product's title and description are already live. The draft is kept: publish again to finish.",
    });
    expect(blockWrites()).toEqual(['insert blocks', 'delete blocks', 'delete blocks']);
    // First the captured live ids (refused), then the id the insert returned.
    expect(deletedBlockIds()).toEqual([LIVE_BLOCK_IDS, [FIRST_INSERTED_BLOCK_ID]]);
    expect(mocks.cookieWrites).not.toHaveBeenCalledWith('delete', 'product_drafts', undefined);
    expect(mocks.createProductRevision).not.toHaveBeenCalled();
  });

  it('says the page shows both when the rows just inserted cannot be taken back either', async () => {
    mocks.draftMeta = structuredClone(FORM_AUTOSAVE_META);
    mocks.blocksDeleteErrors = ['timeout', 'still timing out'];

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({
      success: false,
      error:
        "The live description blocks could not be removed (timeout), and neither could the draft's new rows (still timing out): the product page shows both until you publish again. The draft's product values (prices, variants and details) are already live. The draft is kept: publish again to finish.",
    });
    expect(deletedBlockIds()).toEqual([LIVE_BLOCK_IDS, [FIRST_INSERTED_BLOCK_ID]]);
  });

  it('an empty draft block list inserts nothing and deletes the live ids', async () => {
    mocks.draftMeta = {};
    mocks.draftBlocks = [];

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    expect(blockWrites()).toEqual(['delete blocks']);
    expect(deletedBlockIds()).toEqual([LIVE_BLOCK_IDS]);
    expect(mocks.cookieWrites).toHaveBeenCalledWith('delete', 'product_drafts', undefined);
  });

  it('an empty draft block list whose delete fails changes nothing and says so', async () => {
    mocks.draftMeta = {};
    mocks.draftBlocks = [];
    mocks.blocksDeleteErrors = ['boom'];

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({
      success: false,
      error:
        'The live description blocks could not be removed (boom); they are unchanged. Nothing else was published. The draft is kept: publish again to finish.',
    });
    expect(blockWrites()).toEqual(['delete blocks']);
  });

  it('a product without live blocks gets the draft rows and no delete', async () => {
    mocks.draftMeta = {};
    mocks.liveBlockIds = [];

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    expect(blockWrites()).toEqual(['insert blocks']);
    expect(deletedBlockIds()).toEqual([]);
  });

  it('reads the live ids a page at a time (PostgREST stops at 1000 rows) and deletes all of them', async () => {
    mocks.draftMeta = {};
    mocks.liveBlockIds = Array.from({ length: 1001 }, (_value, index) => index + 1);

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    expect(mocks.cookieRanges.mock.calls).toEqual([
      ['blocks', 0, 999],
      ['blocks', 1000, 1999],
    ]);
    expect(deletedBlockIds()).toEqual([mocks.liveBlockIds]);
  });

  it('stops before any write when the live ids cannot be read', async () => {
    mocks.draftMeta = structuredClone(FORM_AUTOSAVE_META);
    mocks.blocksReadError = 'boom';

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({
      success: false,
      error: "Failed to read the product's description blocks: boom. Nothing was published; the draft is kept.",
    });
    expect(mocks.updateProduct).not.toHaveBeenCalled();
    expect(mocks.cookieWrites).not.toHaveBeenCalled();
    expect(mocks.getFullProductContent).not.toHaveBeenCalled();
  });

  it("says the page shows both when the delete fails and the insert returned no ids to take its rows back by", async () => {
    mocks.draftMeta = {};
    mocks.blocksInsertReturned = 0;
    mocks.blocksDeleteErrors = ['permission denied for table blocks'];

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({
      success: false,
      error:
        "The live description blocks could not be removed (permission denied for table blocks), and the draft's new rows could not be identified to take them back: the product page shows both until you publish again. Nothing else was published. The draft is kept: publish again to finish.",
    });
    expect(blockWrites()).toEqual(['insert blocks', 'delete blocks']);
    expect(mocks.cookieWrites).not.toHaveBeenCalledWith('delete', 'product_drafts', undefined);
  });
});

/**
 * A blocks DELETE that removes fewer of the captured live ids than it was given: another writer
 * removed some while the publish ran (a revision restore, Copy from language, a live CMS import, a
 * direct database write, or a publish of the same draft that read it after this one's claim). Taking this
 * publish's rows back out then could leave the product with no description blocks (verify-P7C VP-F
 * and V8: the rows that delete removed were the other publish's new ones, and that publish had removed
 * the draft), so they stay, and the publish finishes with a warning.
 */
describe('a delete that removes fewer live blocks than it captured keeps the new rows and warns', () => {
  it('publishes, keeps the rows it inserted, records History and removes the draft, with the warning', async () => {
    mocks.draftMeta = { title: 'New title' };
    // Another writer already removed both captured rows.
    mocks.blocksDeleteRemoved = [[]];

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({
      success: true,
      warning: PRODUCT_DESCRIPTION_BLOCKS_CHANGED_WARNING,
    });
    expect(PRODUCT_DESCRIPTION_BLOCKS_CHANGED_WARNING).toBe(
      "Published, but some of the description blocks this publish replaced had already been removed while it ran (by another publish, a revision restore, Copy from language, a live CMS import or a direct database write). Check the product's description blocks: the page may show some twice."
    );
    // The delete asked for the rows it removed, and nothing took the new rows back out.
    expect(mocks.cookieWriteSelects).toHaveBeenCalledWith('delete', 'blocks', 'id');
    expect(blockWrites()).toEqual(['insert blocks', 'delete blocks']);
    expect(deletedBlockIds()).toEqual([LIVE_BLOCK_IDS]);
    expectRevisionRecordedByTheAdmin();
    expect(mocks.cookieWrites).toHaveBeenCalledWith('delete', 'product_drafts', undefined);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/product/pro-plugin');
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/cms/products/${PRODUCT_ID}/edit`);
  });

  it('counts a partial removal too, whatever the draft holds', async () => {
    mocks.draftMeta = structuredClone(FORM_AUTOSAVE_META);
    mocks.blocksDeleteRemoved = [[5]];

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({
      success: true,
      warning: PRODUCT_DESCRIPTION_BLOCKS_CHANGED_WARNING,
    });
    expect(blockWrites()).toEqual(['insert blocks', 'delete blocks']);
  });

  it('needs no inserted ids, and warns for an empty draft block list as well', async () => {
    mocks.draftMeta = {};
    mocks.blocksInsertReturned = 0;
    mocks.blocksDeleteRemoved = [[]];

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({
      success: true,
      warning: PRODUCT_DESCRIPTION_BLOCKS_CHANGED_WARNING,
    });
    expect(blockWrites()).toEqual(['insert blocks', 'delete blocks']);

    vi.clearAllMocks();
    mocks.getFullProductContent.mockReset();
    mocks.getFullProductContent.mockResolvedValueOnce(BEFORE).mockResolvedValueOnce(AFTER);
    mocks.draftBlocks = [];
    mocks.blocksDeleteRemoved = [[6]];

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({
      success: true,
      warning: PRODUCT_DESCRIPTION_BLOCKS_CHANGED_WARNING,
    });
    expect(blockWrites()).toEqual(['delete blocks']);
  });

  it("comes after a skipped-fields warning and before the History one", async () => {
    mocks.liveRow = { ...mocks.liveRow, title: 'Pro plugin, rewritten', updated_at: '2026-10-15T08:00:00+00:00' };
    mocks.draftMeta = { ...LEGACY_ROW_SNAPSHOT };
    mocks.blocksDeleteRemoved = [[6]];
    mocks.createProductRevision.mockResolvedValue({ error: 'Failed to insert product revision: boom' });

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({
      success: true,
      warning: `${describeSkippedProductDraftOverlay(['title'])} ${PRODUCT_DESCRIPTION_BLOCKS_CHANGED_WARNING} Published, but history was not recorded: Failed to insert product revision: boom`,
    });
  });

  // Review 2026-11-15: a failed draft delete returned before the warnings were built, and before the
  // revalidation, so the only sign that the description may show twice (and of a skipped title) was lost.
  it('keeps every warning and still revalidates when the draft row cannot be removed', async () => {
    mocks.liveRow = { ...mocks.liveRow, title: 'Pro plugin, rewritten', updated_at: '2026-10-15T08:00:00+00:00' };
    mocks.draftMeta = { ...LEGACY_ROW_SNAPSHOT };
    mocks.blocksDeleteRemoved = [[6]];
    mocks.draftDeleteError = 'connection reset';

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({
      success: false,
      error: `Published, but failed to remove product draft: connection reset. ${describeSkippedProductDraftOverlay(['title'])} ${PRODUCT_DESCRIPTION_BLOCKS_CHANGED_WARNING}`,
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/product/pro-plugin');
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/cms/products/${PRODUCT_ID}/edit`);
  });

  it('reports a failed draft delete alone when the publish had nothing to warn about', async () => {
    mocks.draftMeta = { title: 'New title' };
    mocks.draftDeleteError = 'connection reset';

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({
      success: false,
      error: 'Published, but failed to remove product draft: connection reset.',
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/cms/products/${PRODUCT_ID}/edit`);
  });
});

describe('a publish claims the draft after its checks and before its first write', () => {
  it.each(DRAFT_KINDS)(
    'for %s: an UPDATE of author_id narrowed to the id and the updated_at it read, returning the row, after the reads',
    async (_kind, meta) => {
      mocks.draftMeta = meta();

      await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toMatchObject({ success: true });

      expect(mocks.cookieWrites.mock.calls[0]).toEqual(CLAIM_WRITE);
      expect(claimFilters()).toEqual([
        ['id', 7],
        ['updated_at', DRAFT_CREATED_AT],
      ]);
      // Without .select() supabase-js returns no rows, and every publish would read as claimed elsewhere.
      expect(mocks.cookieWriteSelects).toHaveBeenCalledWith('update', 'product_drafts', 'id');
      const claimedAt = mocks.cookieWrites.mock.invocationCallOrder[0];
      // After the live ids and the History "before" are read...
      const blocksRead = mocks.cookieReads.mock.calls.findIndex(([table]) => table === 'blocks');
      expect(mocks.cookieReads.mock.invocationCallOrder[blocksRead]).toBeLessThan(claimedAt);
      expect(mocks.getFullProductContent.mock.invocationCallOrder[0]).toBeLessThan(claimedAt);
      // ...and before the RPC (no cookie write) as well.
      for (const order of mocks.updateProduct.mock.invocationCallOrder) {
        expect(claimedAt).toBeLessThan(order);
      }
    }
  );

  it.each(DRAFT_KINDS)(
    'for %s: a claim that gets no row back (another publish claimed the draft, or it changed since it was read) writes nothing else',
    async (_kind, meta) => {
      mocks.draftMeta = meta();
      mocks.draftClaimRows = [];

      await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({
        success: false,
        error: PRODUCT_DRAFT_PUBLISH_CLAIM_REFUSED_ERROR,
      });
      expect(PRODUCT_DRAFT_PUBLISH_CLAIM_REFUSED_ERROR).toBe(
        'Another publish of this draft started first, or the draft changed since it was read: nothing was published.'
      );
      expect(mocks.cookieWrites.mock.calls).toEqual([CLAIM_WRITE]);
      expect(mocks.updateProduct).not.toHaveBeenCalled();
      expect(mocks.syncProductSaleCouponToFreemius).not.toHaveBeenCalled();
      expect(mocks.createProductRevision).not.toHaveBeenCalled();
      expect(mocks.revalidatePath).not.toHaveBeenCalled();
    }
  );

  it('stops with nothing else written when the claim itself fails', async () => {
    mocks.draftMeta = structuredClone(FORM_AUTOSAVE_META);
    mocks.draftClaimError = 'canceling statement due to statement timeout';

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({
      success: false,
      error:
        'Failed to start publishing the draft: canceling statement due to statement timeout. Nothing was published; the draft is kept.',
    });
    expect(mocks.cookieWrites.mock.calls).toEqual([CLAIM_WRITE]);
    expect(mocks.updateProduct).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

/**
 * Verify round 6, probe L1: an in-page save rewrote a legacy snapshot as an overlay and kept its title
 * as an in-page edit, because `updated_at` said the product was unchanged (a pre-0.23.4 Freemius sync
 * had renamed it without setting it). The overlay records that title, so a later change still wins.
 */
describe('an overlay rewritten from a legacy snapshot keeps the rule for the snapshot fields it recorded', () => {
  const CONVERTED = {
    title: 'Pro plugin - Basic',
    short_description: 'New short copy',
    legacy_snapshot_fields: ['title'],
    legacy_snapshot_created_at: '2026-06-02T09:00:00+00:00',
  };

  it('skips the recorded title with the warning once the product changed after the snapshot, and writes the in-page edit', async () => {
    // A 0.23.4 Freemius sync (which sets updated_at) renamed the product after the conversion.
    mocks.liveRow = { ...mocks.liveRow, title: 'Pro plugin - Growth', updated_at: '2026-11-14T12:00:00+00:00' };
    mocks.draftMeta = structuredClone(CONVERTED);

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({
      success: true,
      warning: describeSkippedProductDraftOverlay(['title'], ['short_description']),
    });
    expect(productRowWrites()).toEqual([
      ['update', 'products', { short_description: 'New short copy', updated_at: expect.any(String) }],
    ]);
  });

  it('writes it while the product is unchanged since the snapshot, and neither recorded key reaches the products row', async () => {
    mocks.liveRow = { ...mocks.liveRow, title: 'Pro plugin - Starter', updated_at: '2026-06-01T10:00:00+00:00' };
    mocks.draftMeta = structuredClone(CONVERTED);

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });
    expect(productRowWrites()).toEqual([
      [
        'update',
        'products',
        { title: 'Pro plugin - Basic', short_description: 'New short copy', updated_at: expect.any(String) },
      ],
    ]);
    expect(mocks.getProduct).not.toHaveBeenCalled();
    expect(mocks.updateProduct).not.toHaveBeenCalled();
  });
});

describe('currentUserCanPublishProductDrafts: the flag the CMS edit page hands its draft bar', () => {
  const CALLERS: Array<[string, { id: string } | null, string | null, string, boolean]> = [
    // evaluateTwoFactor() answers `satisfied` for a passed factor, a trusted device and no factor enrolled.
    ['an ADMIN past the second factor', { id: 'admin-1' }, 'ADMIN', 'satisfied', true],
    ['an ADMIN whose authenticator code is pending', { id: 'admin-1' }, 'ADMIN', 'totp_required', false],
    ['an ADMIN whose email code is pending', { id: 'admin-1' }, 'ADMIN', 'email_required', false],
    ['a WRITER', { id: 'writer-1' }, 'WRITER', 'satisfied', false],
    ['a partner (RTL)', { id: 'partner-1' }, 'RTL', 'satisfied', false],
    ['nobody signed in', null, null, 'satisfied', false],
  ];

  it.each(CALLERS)('is %s → %s, exactly when publish lets the caller through', async (_who, user, role, status, expected) => {
    mocks.user = user;
    mocks.role = role;
    mocks.twoFactorStatus = status;

    await expect(currentUserCanPublishProductDrafts()).resolves.toBe(expected);

    // Publish agrees: the flag is only a hint, and the server's check stays the authority.
    mocks.draftMeta = {};
    const result = await publishProductVisualEditingDraft(PRODUCT_ID);
    expect('error' in result && result.error.startsWith(PRODUCT_PUBLISH_ADMIN_ONLY_ERROR)).toBe(!expected);
  });

  it('reads nothing but the caller and their own profile, and builds no service-role client', async () => {
    await currentUserCanPublishProductDrafts();

    expect(readTables()).toEqual(['profiles']);
    expect(mocks.serviceClientCreated).not.toHaveBeenCalled();
    expect(mocks.cookieWrites).not.toHaveBeenCalled();
  });
});

// Review 2026-11-15: the draft bar skips router.refresh() for a product and counts on the action's
// revalidation to re-render the edit page (resetting the form); discard revalidated the public path only.
describe('discarding a product draft', () => {
  it('deletes the draft and revalidates the edit page as well as the product page', async () => {
    mocks.draftMeta = { title: 'New title' };

    await expect(discardProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    expect(mocks.cookieWrites).toHaveBeenCalledWith('delete', 'product_drafts', undefined);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/product/pro-plugin');
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/cms/products/${PRODUCT_ID}/edit`);
  });
});
