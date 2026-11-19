import { readFileSync } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Who may publish a product draft, what each kind of draft sends to the database, and how the answer
 * is read. Since migration 02043 the whole publish is one call, `publish_product_draft`, which writes
 * the product values (or the overlay fields), the description blocks, History and the draft delete in
 * one transaction under a row lock (its behaviour against a real database, two sessions included:
 * tools/scripts/product-draft-publish.db.test.ts). The server action reads, checks, computes what to
 * write, makes that call and pushes the Freemius sale coupon after it; it writes nothing itself.
 *
 * - Every publish needs an ADMIN past the second factor (requireCmsAdmin()), checked before anything is
 *   read: the function refuses anyone but an ADMIN by role only (is_admin(), which an aal1 session
 *   passes), a Freemius product's sale coupon is pushed with the service role through the developer key
 *   pair, and product_revisions accepts only ADMIN inserts (02003).
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
  updated_at: '2026-06-01T10:00:00.123456+00:00',
  languages: { code: 'en' },
  product_media: [{ media_id: 'aaaaaaaa-0001-4001-8001-000000000001', sort_order: 0, media: { file_path: 'a.webp' } }],
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
  created_at: '2026-06-02T09:00:00+00:00',
  updated_at: '2026-06-02T09:00:00+00:00',
};

/** The draft row's created_at (and updated_at): after the live row's updated_at unless a test moves it. */
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
  /** What publish_product_draft answers (supabase-js: { data, error }). */
  rpcAnswer: { data: null, error: null } as { data: unknown; error: unknown },
  rpc: vi.fn(),
  cookieReads: vi.fn(),
  cookieWrites: vi.fn(),
  serviceClientCreated: vi.fn(),
  getProduct: vi.fn(),
  syncProductSaleCouponToFreemius: vi.fn(),
  revalidatePath: vi.fn(),
}));

/** The cookie client: reads answer per table and are recorded; writes and rpc calls are recorded. */
function makeCookieClient() {
  return {
    auth: { getUser: async () => ({ data: { user: mocks.user }, error: null }) },
    rpc: async (name: string, args: unknown) => {
      mocks.rpc(name, args);
      return mocks.rpcAnswer;
    },
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const read = () => {
        if (table === 'profiles') return { data: mocks.role ? { role: mocks.role } : null, error: null };
        if (table === 'product_drafts') {
          return {
            data: {
              id: 7,
              product_id: PRODUCT_ID,
              author_id: 'writer-1',
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
        mocks.cookieReads(table, columns);
        return chain;
      };
      chain.eq = () => chain;
      chain.order = () => chain;
      chain.single = async () => read();
      chain.maybeSingle = async () => read();
      for (const name of ['update', 'insert', 'delete'] as const) {
        chain[name] = (values?: unknown) => {
          mocks.cookieWrites(name, table, values);
          return chain;
        };
      }
      chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null }).then(resolve, reject);
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
// imports it; tools/scripts/commerce-chunking.test.ts). The real buildProductDraftPublishValues: the
// values these tests read off the call are the ones the function receives.
vi.mock('@nextblock-cms/ecommerce/product-actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@nextblock-cms/ecommerce/product-actions')>()),
  getProduct: mocks.getProduct,
}));
vi.mock('@nextblock-cms/ecommerce/freemius-coupons', () => ({
  syncProductSaleCouponToFreemius: mocks.syncProductSaleCouponToFreemius,
}));
// The second factor is driven per test; its own logic is covered by lib/auth/cms-actor.test.ts.
vi.mock('../auth/twoFactor', () => ({
  evaluateTwoFactor: async () => ({ status: mocks.twoFactorStatus, userId: mocks.user?.id ?? null, mfaType: null }),
}));

import {
  PRODUCT_CHANGED_DURING_PUBLISH_ERROR,
  PRODUCT_DRAFT_CHANGED_DURING_PUBLISH_ERROR,
  PRODUCT_PUBLISH_ADMIN_ONLY_ERROR,
  PRODUCT_PUBLISH_CONFLICT_ERROR,
  PRODUCT_PUBLISH_NEEDS_MIGRATION_ERROR,
  currentUserCanPublishProductDrafts,
  describeAdjustedProductStock,
  discardProductVisualEditingDraft,
  publishProductVisualEditingDraft,
} from './product-drafts';
import {
  NO_PRODUCT_DRAFT_ERROR,
  PRODUCT_DRAFT_FORM_MARKER_KEY,
  PRODUCT_DRAFT_FORM_MARKER_VALUE,
  describeSkippedProductDraftOverlay,
} from './product-draft-meta';
import {
  buildPoisonedProductDraftPublishError,
  buildUnreadableProductDraftPublishError,
  findPoisonedProductDraftFields,
  findUnreadableProductDraftValues,
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
  product_media: [{ media_id: 'aaaaaaaa-0001-4001-8001-000000000001' }],
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

/** What publish_product_draft answers once everything is live. */
function published(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      product_id: PRODUCT_ID,
      previous_slug: 'pro-plugin',
      slug: 'pro-plugin',
      payment_provider: 'stripe',
      wrote_values: true,
      revision: { recorded: true, version: 2 },
      ...overrides,
    },
    error: null,
  };
}

/** The arguments of the one publish_product_draft call. */
function publishArgs(): Record<string, any> {
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
  const [name, args] = mocks.rpc.mock.calls[0];
  expect(name).toBe('publish_product_draft');
  return args;
}

/** The draft's blocks as the function writes them: no ids, no timestamps, no parent columns. */
const PUBLISHED_BLOCKS = [{ language_id: 1, block_type: 'text', content: DRAFT_BLOCK.content, order: 0 }];

function expectNothingWritten() {
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(mocks.syncProductSaleCouponToFreemius).not.toHaveBeenCalled();
  expect(mocks.cookieWrites).not.toHaveBeenCalled();
  expect(mocks.revalidatePath).not.toHaveBeenCalled();
}

/** The tables the cookie client read, in order. */
function readTables() {
  return mocks.cookieReads.mock.calls.map(([table]) => table);
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
  mocks.rpcAnswer = published();
  mocks.getProduct.mockResolvedValue({ data: LIVE_PRODUCT, error: null });
  mocks.syncProductSaleCouponToFreemius.mockResolvedValue({ status: 'synced' });
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

describe('one call publishes it all: the server action writes nothing itself', () => {
  it.each(DRAFT_KINDS)('for %s: reads, then one publish_product_draft call with the draft and product versions it read', async (_kind, meta) => {
    mocks.draftMeta = meta();

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toMatchObject({ success: true });

    const args = publishArgs();
    expect(args).toMatchObject({
      p_product_id: PRODUCT_ID,
      p_draft_id: 7,
      // As read, microseconds included: the function refuses a draft or product that changed since.
      p_draft_updated_at: DRAFT_CREATED_AT,
      p_product_updated_at: LIVE_PRODUCT.updated_at,
      p_blocks: PUBLISHED_BLOCKS,
    });
    // Product values or overlay fields, never both.
    expect(args.p_values === null || args.p_overlay === null).toBe(true);
    // No claim, no block insert or delete, no revision insert, no draft delete: all inside the call.
    expect(mocks.cookieWrites).not.toHaveBeenCalled();
    expect(readTables()).not.toContain('blocks');
    expect(readTables()).not.toContain('product_revisions');
  });

  it('sends an empty block list when the draft has none: the function then deletes the live blocks', async () => {
    mocks.draftBlocks = [];

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });
    expect(publishArgs().p_blocks).toEqual([]);
  });
});

describe('an ADMIN publish of product values', () => {
  it("pushes a Freemius product's sale coupon with the service client, after the call", async () => {
    mocks.getProduct.mockResolvedValue({ data: LIVE_FREEMIUS_PRODUCT, error: null });
    mocks.rpcAnswer = published({ payment_provider: 'freemius' });

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    expect(publishArgs().p_values).toMatchObject({ sku: 'PRO', price: 1000000, product_type: 'digital' });
    expect(mocks.syncProductSaleCouponToFreemius).toHaveBeenCalledWith({ productId: PRODUCT_ID, client: serviceClient });
    expect(mocks.rpc.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.syncProductSaleCouponToFreemius.mock.invocationCallOrder[0]
    );
  });

  it('pushes no coupon for a Stripe product (the provider the publish answered)', async () => {
    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
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
    mocks.getProduct.mockResolvedValue({ data: LIVE_FREEMIUS_PRODUCT, error: null });
    mocks.rpcAnswer = published({ payment_provider: 'freemius' });
    arrange();

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({
      success: true,
      warning:
        "Published, but the Freemius sale coupon was not updated (fetch failed): Freemius' checkout does not apply the sale price until it is. Save a change in the product form and publish it once Freemius answers (a description-block or in-page edit does not push the coupon).",
    });
  });

  it("sends the form autosave's values in minor units, never the marker, the draft's status, a hidden media_id or a removal list", async () => {
    mocks.draftMeta = {
      ...structuredClone(FORM_AUTOSAVE_META),
      // Any product_drafts writer (a WRITER over PostgREST included) can set these; the form never does.
      media_id: 'media-9',
      explicitly_removed_media_ids: ['media-1', 'media-2'],
    };

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    const values = publishArgs().p_values;
    expect(values).toMatchObject({
      title: 'Pro plugin (edited)',
      slug: 'pro-plugin',
      sku: 'PRO',
      price: 5900,
      prices: { USD: 5900, EUR: 5500 },
      sale_price: null,
      sale_prices: {},
      sale_start_at: LIVE_PRODUCT.sale_start_at,
      sale_end_at: LIVE_PRODUCT.sale_end_at,
      stock: 4,
      meta_title: 'Edited meta title',
      meta_description: 'Edited meta description',
      custom_canonical: 'https://example.com/pro-plugin',
      short_description: 'Edited short copy',
      is_taxable: true,
      language_id: 1,
      translation_group_id: GROUP_ID,
      // The gallery the edit page showed; the function only unlinks an image it drops.
      gallery_media_ids: ['aaaaaaaa-0001-4001-8001-000000000001'],
      category_ids: [],
      variants: [
        expect.objectContaining({
          // The draft's copy of the live id: the function keeps the row with these terms anyway.
          id: 'variant-1',
          sku: 'PRO-RED',
          price: 5900,
          prices: { USD: 5900, EUR: 5500 },
          stock_quantity: 4,
          attribute_term_ids: [TERM_RED],
        }),
      ],
    });
    for (const key of [PRODUCT_DRAFT_FORM_MARKER_KEY, 'status', 'media_id', 'explicitly_removed_media_ids', 'product_media', 'payment_provider', 'metadata', 'id']) {
      expect(values).not.toHaveProperty(key);
    }
    expect(publishArgs().p_overlay).toBeNull();
  });

  // Migration 02044: the function writes a SKU's stock only where the draft's quantity differs from
  // the stock the edit page loaded, and then as a change to the current stock, so a sale made while the
  // page was open keeps its deduction (tools/scripts/product-draft-publish.db.test.ts runs it).
  it('sends the stock the edit page loaded beside the draft’s quantities, and no baseline for a draft without one', async () => {
    // Keyed as the inventory rows are (trimmed), whole quantities only, and only for a SKU the live
    // product stocks: the function reads a SKU's current stock from inventory_items, shared across
    // products, so an entry for PRO-BLUE (no live variant has it) would apply to a stock the page never
    // showed (productFormData.test.ts).
    mocks.draftMeta = { ...structuredClone(FORM_AUTOSAVE_META), stock_baseline: { '  PRO-RED ': 6, 'PRO-BLUE': 2, 'PRO-ODD': 1.5 } };

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    const values = publishArgs().p_values;
    expect(values.stock_baseline).toEqual({ 'PRO-RED': 6 });
    expect(values.variants[0]).toMatchObject({ sku: 'PRO-RED', stock_quantity: 4 });

    vi.clearAllMocks();
    mocks.draftMeta = structuredClone(FORM_AUTOSAVE_META);
    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });
    expect(publishArgs().p_values.stock_baseline).toBeNull();
  });

  // Migration 02047: the draft's `stock_baseline_publish_count` (the product's publish count when the edit
  // page loaded the baseline) goes beside the baseline; the function reads the product's last publish
  // itself, under the products row lock, and counts a baseline whose count is below it from that publish.
  it('sends the publish count the baseline was loaded at beside it, a whole number only, and none without a baseline', async () => {
    for (const [marker, sent] of [
      [3, 3],
      [0, 0],
      ['3', null],
      [2.5, null],
      [-1, null],
      [undefined, null],
    ] as const) {
      vi.clearAllMocks();
      mocks.draftMeta = {
        ...structuredClone(FORM_AUTOSAVE_META),
        stock_baseline: { 'PRO-RED': 6 },
        ...(marker === undefined ? {} : { stock_baseline_publish_count: marker }),
      };
      await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });
      expect(publishArgs().p_values.stock_baseline_publish_count).toBe(sent);
    }

    vi.clearAllMocks();
    mocks.draftMeta = { ...structuredClone(FORM_AUTOSAVE_META), stock_baseline_publish_count: 3 };
    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });
    expect(publishArgs().p_values.stock_baseline).toBeNull();
    expect(publishArgs().p_values.stock_baseline_publish_count).toBeNull();
  });

  it('sends the live stock as unchanged when the draft carries a baseline but not the quantities (they come from live)', async () => {
    mocks.draftMeta = { sku: 'PRO', price: 59, ...MARKER, stock_baseline: { 'PRO-RED': 6 } };

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    const values = publishArgs().p_values;
    expect(values.variants[0]).toMatchObject({ sku: 'PRO-RED', stock_quantity: 4 });
    expect(values.stock_baseline).toEqual({ 'PRO-RED': 4 });
  });

  it('publishes with a warning naming each SKU whose stock change went live on a quantity that moved meanwhile', async () => {
    mocks.draftMeta = structuredClone(FORM_AUTOSAVE_META);
    const adjusted = [
      { sku: 'PRO-RED', reason: 'moved' as const, entered: 15, loaded: 5, current: 4, published: 14 },
      { sku: 'PRO-BLUE', reason: 'moved' as const, entered: 1, loaded: 3, current: 1, published: 0 },
    ];
    mocks.rpcAnswer = published({ stock_adjusted: adjusted });

    const result = await publishProductVisualEditingDraft(PRODUCT_ID);

    expect(result).toEqual({ success: true, warning: describeAdjustedProductStock(adjusted) });
    // It names the draft, never the publisher: the figures may be another editor's, or a hand-written
    // draft's that nobody typed in the form (a baseline of 1004 beside the live 4).
    expect((result as { warning: string }).warning).toBe(
      "Published. The stock at publishing differed from the figures this draft's stock changes started from (after a sale or another stock update, for example), so the changes were applied to the stock at publishing instead of replacing it: PRO-RED is now 14 (the draft changed 5 to 15, and it was 4 at publishing); PRO-BLUE is now 0 (the draft changed 3 to 1, and it was 1 at publishing). If the draft's figures already counted those changes, correct the stock."
    );
    for (const reason of ['moved', 'already_live'] as const) {
      expect(describeAdjustedProductStock([{ sku: 'PRO-RED', reason, entered: 4, loaded: 1004, current: 4, published: 0 }])).not.toMatch(
        /\byou(r)?\b/i
      );
    }
  });

  it('names five SKUs at most, ignores what it cannot read, and says nothing when nothing was adjusted', async () => {
    const entries = Array.from({ length: 7 }, (_, index) => ({
      sku: `SKU-${index + 1}`,
      reason: 'moved' as const,
      entered: 9,
      loaded: 5,
      current: 4,
      published: 8,
    }));
    expect(describeAdjustedProductStock(entries)).toContain('SKU-5 is now 8 (the draft changed 5 to 9, and it was 4 at publishing); and 2 more.');
    expect(describeAdjustedProductStock(entries)).not.toContain('SKU-6');

    mocks.draftMeta = structuredClone(FORM_AUTOSAVE_META);
    mocks.rpcAnswer = published({ stock_adjusted: [{ sku: 'PRO-RED', entered: 'x' }, null, 'PRO-RED'] });
    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    vi.clearAllMocks();
    mocks.rpcAnswer = published({ stock_adjusted: [] });
    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });
  });

  // Review 2026-11-18 ("Keep it, and warn"): 02044 leaves a SKU's stock alone when the draft's quantity
  // differs from its baseline but equals the current stock. That is right for a change already published
  // (a draft started again after its publish) and wrong when the stock reached the figure some other way
  // (loaded 10, 9 typed for a damaged unit, one sold meanwhile: 9 stays where 8 was meant), and nothing
  // said so. The function now names every such SKU in `stock_adjusted` with reason 'already_live' (each
  // change applied to a stock that moved has reason 'moved'), and the warning names both kinds.
  describe('the stock warning names both kinds of SKU the function answers', () => {
    const MOVED = { sku: 'PRO-RED', reason: 'moved' as const, entered: 15, loaded: 5, current: 4, published: 14 };
    const ALREADY_LIVE = { sku: 'PRO-BLUE', reason: 'already_live' as const, entered: 9, loaded: 10, current: 9, published: 9 };
    const MOVED_PART =
      "The stock at publishing differed from the figure this draft's stock change started from (after a sale or another stock update, for example), so the change was applied to the stock at publishing instead of replacing it: PRO-RED is now 14 (the draft changed 5 to 15, and it was 4 at publishing). If the draft's figure already counted that change, correct the stock.";
    const ALREADY_LIVE_PART =
      "The stock already showed this draft's figure at publishing, so the change was not applied on top of it: PRO-BLUE stays at 9 (the draft changed 10 to 9, and it was already 9 at publishing). If the change was meant to come on top of what moved the stock (a damaged unit taken out after a sale, for example), correct the stock.";

    it('a change applied to a stock that had moved', () => {
      expect(describeAdjustedProductStock([MOVED])).toBe(`Published. ${MOVED_PART}`);
    });

    it('a SKU whose stock already held the draft figure: left as it was, and said so', () => {
      expect(describeAdjustedProductStock([ALREADY_LIVE])).toBe(`Published. ${ALREADY_LIVE_PART}`);
      expect(
        describeAdjustedProductStock([
          ALREADY_LIVE,
          { sku: 'PRO-GREEN', reason: 'already_live', entered: 10, loaded: 5, current: 10, published: 10 },
        ])
      ).toBe(
        "Published. The stock already showed this draft's figures at publishing, so the changes were not applied on top of them: PRO-BLUE stays at 9 (the draft changed 10 to 9, and it was already 9 at publishing); PRO-GREEN stays at 10 (the draft changed 5 to 10, and it was already 10 at publishing). If a change was meant to come on top of what moved the stock (a damaged unit taken out after a sale, for example), correct the stock."
      );
    });

    it('both kinds in one publish: one part for each, in the order moved, then already live', () => {
      expect(describeAdjustedProductStock([ALREADY_LIVE, MOVED])).toBe(`Published. ${MOVED_PART} ${ALREADY_LIVE_PART}`);
    });

    it('names the first five SKUs of each kind, then how many more of that kind', () => {
      const of = (reason: 'moved' | 'already_live', count: number, prefix: string) =>
        Array.from({ length: count }, (_, index) => ({
          sku: `${prefix}-${index + 1}`,
          reason,
          entered: 9,
          loaded: 5,
          current: reason === 'moved' ? 4 : 9,
          published: reason === 'moved' ? 8 : 9,
        }));
      const warning = describeAdjustedProductStock([...of('already_live', 6, 'LIVE'), ...of('moved', 7, 'MOVED')]);

      expect(warning).toContain('MOVED-5 is now 8 (the draft changed 5 to 9, and it was 4 at publishing); and 2 more. If');
      expect(warning).toContain('LIVE-5 stays at 9 (the draft changed 5 to 9, and it was already 9 at publishing); and 1 more. If');
      expect(warning).not.toContain('MOVED-6');
      expect(warning).not.toContain('LIVE-6');
      expect(warning.indexOf('MOVED-1')).toBeLessThan(warning.indexOf('LIVE-1'));
    });

    it('reads a missing or unknown reason as moved', async () => {
      mocks.draftMeta = structuredClone(FORM_AUTOSAVE_META);
      for (const reason of [undefined, null, 'ALREADY_LIVE', 'already live', 'kept', 1]) {
        vi.clearAllMocks();
        const entry: Record<string, unknown> = { sku: 'PRO-RED', entered: 15, loaded: 5, current: 4, published: 14 };
        if (reason !== undefined) entry.reason = reason;
        mocks.rpcAnswer = published({ stock_adjusted: [entry] });

        await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({
          success: true,
          warning: `Published. ${MOVED_PART}`,
        });
      }
    });

    // Migration 02047: a draft whose baseline predates the product's last publish, which used the same
    // entry, counts from the quantity that publish entered. Equal to it, the SKU is left as it is and named
    // `already_published` (loaded 5, typed 10 and published, one sold, the same values again: 9, not 14);
    // otherwise its `moved` / `already_live` entry says the change started from that figure.
    const ALREADY_PUBLISHED = {
      sku: 'PRO-RED',
      reason: 'already_published' as const,
      entered: 10,
      loaded: 10,
      current: 9,
      published: 9,
      fromLastPublish: true,
    };
    const ALREADY_PUBLISHED_PART =
      "This draft was started on a page loaded before the product's last publish, which already entered its stock figure, so the figure was not applied again and what sold or changed since stays: PRO-RED stays at 9 (the last publish entered 10). If the figure was meant to replace the stock as it now is, correct the stock.";

    it('a figure the last publish already entered (migration 02047): left as it was, and said so, after the other kinds', async () => {
      expect(describeAdjustedProductStock([ALREADY_PUBLISHED])).toBe(`Published. ${ALREADY_PUBLISHED_PART}`);
      expect(describeAdjustedProductStock([ALREADY_PUBLISHED, ALREADY_LIVE, MOVED])).toBe(
        `Published. ${MOVED_PART} ${ALREADY_LIVE_PART} ${ALREADY_PUBLISHED_PART}`
      );
      expect(
        describeAdjustedProductStock([ALREADY_PUBLISHED, { ...ALREADY_PUBLISHED, sku: 'PRO-BLUE', entered: 6, loaded: 6, current: 4, published: 4 }])
      ).toBe(
        "Published. This draft was started on a page loaded before the product's last publish, which already entered its stock figures, so the figures were not applied again and what sold or changed since stays: PRO-RED stays at 9 (the last publish entered 10); PRO-BLUE stays at 4 (the last publish entered 6). If a figure was meant to replace the stock as it now is, correct the stock."
      );
      expect(describeAdjustedProductStock([ALREADY_PUBLISHED])).not.toMatch(/\byou(r)?\b/i);

      // As the function answers it (snake_case, `from_last_publish` only where it counted from that figure).
      mocks.draftMeta = structuredClone(FORM_AUTOSAVE_META);
      mocks.rpcAnswer = published({
        stock_adjusted: [{ sku: 'PRO-RED', reason: 'already_published', entered: 10, loaded: 10, current: 9, published: 9, from_last_publish: true }],
      });
      await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({
        success: true,
        warning: `Published. ${ALREADY_PUBLISHED_PART}`,
      });
    });

    it('a change counted from the figure the last publish entered says so (from_last_publish)', async () => {
      mocks.draftMeta = structuredClone(FORM_AUTOSAVE_META);
      mocks.rpcAnswer = published({
        stock_adjusted: [
          { sku: 'PRO-BLUE', reason: 'already_live', entered: 12, loaded: 10, current: 12, published: 12, from_last_publish: true },
          { sku: 'PRO-RED', reason: 'moved', entered: 12, loaded: 10, current: 9, published: 11, from_last_publish: true },
        ],
      });

      const result = await publishProductVisualEditingDraft(PRODUCT_ID);
      expect((result as { warning: string }).warning).toContain(
        'PRO-RED is now 11 (the draft changed 10, the figure the last publish entered, to 12, and it was 9 at publishing).'
      );
      expect((result as { warning: string }).warning).toContain(
        'PRO-BLUE stays at 12 (the draft changed 10, the figure the last publish entered, to 12, and it was already 12 at publishing).'
      );
      // Anything but `true` reads as counted from the draft's baseline.
      mocks.rpcAnswer = published({
        stock_adjusted: [{ sku: 'PRO-RED', reason: 'moved', entered: 15, loaded: 5, current: 4, published: 14, from_last_publish: 'yes' }],
      });
      await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true, warning: `Published. ${MOVED_PART}` });
    });

    it('publishes with both parts when the answer holds both kinds', async () => {
      // Loaded RED 5, typed 15, one sold (14); loaded BLUE 10, typed 9 for a damaged unit, one sold (9 stays).
      mocks.draftMeta = structuredClone(FORM_AUTOSAVE_META);
      mocks.rpcAnswer = published({ stock_adjusted: [MOVED, ALREADY_LIVE] });

      await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({
        success: true,
        warning: `Published. ${MOVED_PART} ${ALREADY_LIVE_PART}`,
      });
      expect(mocks.rpc).toHaveBeenCalledTimes(1);
      // Everything is live: the pages are refreshed as for any publish.
      expect(mocks.revalidatePath).toHaveBeenCalledWith(`/cms/products/${PRODUCT_ID}/edit`);
    });
  });

  it('completes a partial product-values draft from the live product: never variants: [], no cleared description, schedule, canonical or UPC', async () => {
    mocks.draftMeta = { sku: 'PRO', price: 59 };

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    const values = publishArgs().p_values;
    // The draft's own values win.
    expect(values.sku).toBe('PRO');
    expect(values.price).toBe(5900);
    // Everything else is the live product, back in minor units exactly.
    expect(values.variants).toEqual([
      expect.objectContaining({
        id: 'variant-1',
        sku: 'PRO-RED',
        upc: '0123456789029',
        price: 4900,
        prices: { USD: 4900, EUR: 4500 },
        sale_price: null,
        stock_quantity: 4,
        attribute_term_ids: [TERM_RED],
      }),
    ]);
    expect(values.description_json).toEqual(LIVE_PRODUCT.description_json);
    expect(values.sale_start_at).toBe(LIVE_PRODUCT.sale_start_at);
    expect(values.sale_end_at).toBe(LIVE_PRODUCT.sale_end_at);
    expect(values.prices).toEqual({ USD: 4900, EUR: 4500 });
    expect(values.sale_price).toBe(3900);
    expect(values.sale_prices).toEqual({ USD: 3900 });
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
    });
    // Gallery and categories stay out (null), so the function leaves both alone.
    expect(values.gallery_media_ids).toBeNull();
    expect(values.category_ids).toBeNull();
  });

  it("keeps a Freemius product's ids and trial from live when the draft does not carry them", async () => {
    mocks.getProduct.mockResolvedValue({ data: LIVE_FREEMIUS_PRODUCT, error: null });
    mocks.rpcAnswer = published({ payment_provider: 'freemius' });
    mocks.draftMeta = { sku: 'PRO', price: 59, ...MARKER };

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    expect(publishArgs().p_values).toMatchObject({
      product_type: 'digital',
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
    mocks.draftMeta = {
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
      product_media: [{ media_id: 'aaaaaaaa-0001-4001-8001-000000000001' }],
      category_ids: [],
      variants: [],
      ...MARKER,
    };

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    expect(publishArgs().p_values).toMatchObject({
      price: 2950,
      prices: { USD: 2950, EUR: 2700 },
      stock: 9,
      upc: null,
      meta_title: null,
      short_description: 'Imported copy',
      sale_start_at: LIVE_PRODUCT.sale_start_at,
      sale_end_at: LIVE_PRODUCT.sale_end_at,
      custom_canonical: 'https://example.com/pro-plugin',
      gallery_media_ids: ['aaaaaaaa-0001-4001-8001-000000000001'],
      category_ids: [],
      variants: [],
    });
  });

  it('keeps the live variants and price when a product-values draft carries null for them', async () => {
    mocks.draftMeta = { sku: 'PRO', price: null, variants: null, prices: null };

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    const values = publishArgs().p_values;
    expect(values.price).toBe(4900);
    expect(values.prices).toEqual({ USD: 4900, EUR: 4500 });
    expect(values.variants).toHaveLength(1);
  });

  it('takes the sale window as one unit: a draft that set only a new start publishes an open end, never the live end', async () => {
    // A pre-0.23.4 form autosave where the editor typed a start only (the form never showed the live
    // window): merged key by key, the live end (Nov 30) fell before the new start, which CHECK
    // products_sale_window_valid refuses.
    mocks.draftMeta = { sku: 'PRO', price: 49, sale_price: 39, sale_start_at: '2026-12-05T00:00:00.000Z' };

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    const values = publishArgs().p_values;
    expect(values.sale_start_at).toBe('2026-12-05T00:00:00.000Z');
    expect(values.sale_end_at).toBeNull();
  });
});

describe('a product-values draft an earlier version saved over a row snapshot', () => {
  // Which fields count is productFormData's (findPoisonedProductDraftFields, productFormData.test.ts);
  // these pin that publish refuses with them before the call.
  it('is refused before any write, naming the poisoned fields and what to do', async () => {
    mocks.draftMeta = structuredClone(POISONED_AUTOSAVE);
    const fields = findPoisonedProductDraftFields(POISONED_AUTOSAVE, LIVE_PRODUCT);
    expect(fields).toEqual(expect.arrayContaining(['prices', 'variants', 'product_media', 'description_json']));

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({
      success: false,
      error: buildPoisonedProductDraftPublishError(fields),
    });
    expectNothingWritten();
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

    expect(publishArgs().p_values).toMatchObject({ price: 490000, variants: [], gallery_media_ids: [] });
  });

  it('publishes an unmarked draft with no poisoned field as before, completed from live', async () => {
    mocks.draftMeta = { ...structuredClone(FORM_AUTOSAVE_VALUES) };
    delete mocks.draftMeta.sale_start_at;
    delete mocks.draftMeta.sale_end_at;

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    expect(publishArgs().p_values).toMatchObject({
      price: 5900,
      sale_start_at: LIVE_PRODUCT.sale_start_at,
      sale_end_at: LIVE_PRODUCT.sale_end_at,
    });
  });
});

/**
 * Review 2026-11-18: any product_drafts writer (a WRITER over PostgREST included) can store a stock or a
 * SKU the form never saves. Sent as it was, the function wrote a stock the edit page never showed: the
 * text "NaN" as 2147483647, a JSON 1e400 (Infinity once parsed, sent as null) as 0, and a number SKU's
 * change against a baseline entry the page could not key (5 shown, 0 written). Publish now refuses such
 * a draft before any write, marked or not; the edit page names the values and shows the live stock in
 * place of a stock it cannot read (productFormData.test.ts).
 */
describe('a product-values draft holding a stock or a SKU publish cannot read', () => {
  const withVariant = (changes: Record<string, unknown>) => ({
    ...structuredClone(FORM_AUTOSAVE_META),
    stock_baseline: { 'PRO-RED': 4 },
    variants: [{ ...structuredClone(FORM_AUTOSAVE_VALUES.variants[0]), ...changes }],
  });

  it.each([
    ['the text "NaN" as a stock', withVariant({ stock_quantity: 'NaN' }), 'the stock of PRO-RED'],
    ['a JSON 1e400 as a stock', withVariant({ stock_quantity: JSON.parse('{"q":1e400}').q }), 'the stock of PRO-RED'],
    ['true as a stock', withVariant({ stock_quantity: true }), 'the stock of PRO-RED'],
    ['a number as a variant SKU', withVariant({ sku: 10045 }), 'the SKU of variant 1 (Red)'],
    ['an object as a variant SKU', withVariant({ sku: { code: 'PRO-RED' } }), 'the SKU of variant 1 (Red)'],
    ['no variant SKU', withVariant({ sku: null }), 'the SKU of variant 1 (Red)'],
    ['a number as the product SKU', { ...structuredClone(FORM_AUTOSAVE_META), sku: 10045 }, "the product's SKU"],
    [
      "an unreadable stock of a product without variants",
      { ...structuredClone(FORM_AUTOSAVE_META), variants: [], variation_attributes: [], stock: 'Infinity' },
      'the stock of PRO',
    ],
  ])('refuses %s before any write, naming it and what to do', async (_case, meta, label) => {
    mocks.draftMeta = meta;
    const unreadable = findUnreadableProductDraftValues(meta, LIVE_PRODUCT);
    expect(unreadable.map((value) => value.label)).toEqual([label]);

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({
      success: false,
      error: buildUnreadableProductDraftPublishError(unreadable),
    });
    expectNothingWritten();
  });

  it('sends a readable stock as the whole number the edit page shows, never the text or the fraction the draft holds', async () => {
    mocks.draftMeta = withVariant({ stock_quantity: ' 7.9 ' });

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    const values = publishArgs().p_values;
    expect(values.variants[0]).toMatchObject({ sku: 'PRO-RED', stock_quantity: 7 });
    // Beside variants, the product's stock is their total: what the function writes anyway.
    expect(values.stock).toBe(7);
  });

  it.each([
    ['an object', {}],
    ['a string', 'x'],
  ])('publishes the live variants for a variant list that is %s, never throwing or deleting them', async (_label, variants) => {
    mocks.draftMeta = { ...structuredClone(FORM_AUTOSAVE_META), variants, variation_attributes: variants, category_ids: variants };

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    const values = publishArgs().p_values;
    expect(values.variants).toEqual([
      expect.objectContaining({ id: 'variant-1', sku: 'PRO-RED', price: 4900, stock_quantity: 4, attribute_term_ids: [TERM_RED] }),
    ]);
    expect(values.category_ids).toBeNull();
  });
});

describe('an ADMIN publish of an overlay or a legacy row snapshot sends no price, variant or schedule', () => {
  it('publishes a block-seeded draft (meta {}) as blocks only: no product values, no overlay field', async () => {
    mocks.draftMeta = {};

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    expect(publishArgs()).toMatchObject({ p_values: null, p_overlay: {}, p_blocks: PUBLISHED_BLOCKS });
    expect(mocks.getProduct).not.toHaveBeenCalled();
    expect(mocks.syncProductSaleCouponToFreemius).not.toHaveBeenCalled();
    // An overlay carries no slug: the public path comes from the live row.
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/product/pro-plugin');
  });

  it("sends an overlay's title alone (the function writes it with updated_at), never a slug it carries", async () => {
    mocks.draftMeta = { title: 'New title', slug: 'pro-plugin' };

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    expect(publishArgs()).toMatchObject({ p_values: null, p_overlay: { title: 'New title' } });
    expect(mocks.syncProductSaleCouponToFreemius).not.toHaveBeenCalled();
  });

  it('publishes a pre-0.23.4 row snapshot (cents, an id, no variants) as no product values and no changed field', async () => {
    mocks.draftMeta = { ...LEGACY_ROW_SNAPSHOT };

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    // Its title and short description still match the live row, so nothing on the row is sent.
    expect(publishArgs()).toMatchObject({ p_values: null, p_overlay: {} });
    expect(mocks.getProduct).not.toHaveBeenCalled();
  });

  it("sends a row snapshot's changed overlay fields while the live row is unchanged since the draft was created", async () => {
    mocks.draftMeta = {
      ...LEGACY_ROW_SNAPSHOT,
      title: 'Renamed in page',
      description_json: { type: 'doc', content: [] },
    };

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    expect(publishArgs().p_overlay).toEqual({ title: 'Renamed in page', description_json: { type: 'doc', content: [] } });
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
    // The function also refuses if the row changes again before it locks it: the plan was made from
    // this updated_at.
    expect(publishArgs()).toMatchObject({ p_overlay: {}, p_product_updated_at: '2026-10-15T08:00:00+00:00' });
  });

  it("sends the description of a snapshot created from 2026-05-28 on after a live change: no seed copied it, so it is an in-page edit (probe D)", async () => {
    // 3d6942f2 (2026-05-27) took description_json out of the seed and no release seeded drafts before
    // 0.8.11, so in this June draft the description can only be an in-page edit. The title keeps the rule.
    const inPageDescription = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Edited in page in June' }] }] };
    mocks.draftCreatedAt = '2026-06-10T09:00:00+00:00';
    mocks.liveRow = { ...mocks.liveRow, title: 'Pro plugin, rewritten', updated_at: '2026-11-10T10:00:00+00:00' };
    mocks.draftMeta = { ...LEGACY_ROW_SNAPSHOT, description_json: inPageDescription };

    const result = await publishProductVisualEditingDraft(PRODUCT_ID);

    expect(result).toEqual({ success: true, warning: describeSkippedProductDraftOverlay(['title'], ['description_json']) });
    expect((result as { warning: string }).warning).toMatch(/^Published the description blocks and the draft's description\. /);
    expect(publishArgs().p_overlay).toEqual({ description_json: inPageDescription });
  });

  it('treats an unreadable updated_at as changed: blocks only, and the function checks the row is still unreadable', async () => {
    mocks.liveRow = { ...mocks.liveRow, updated_at: null };
    mocks.draftMeta = { ...LEGACY_ROW_SNAPSHOT, title: 'Renamed in page' };

    const result = await publishProductVisualEditingDraft(PRODUCT_ID);

    expect(result).toEqual({ success: true, warning: describeSkippedProductDraftOverlay(['title']) });
    expect(publishArgs()).toMatchObject({ p_overlay: {}, p_product_updated_at: null });
  });

  it('still sends an overlay written since 0.23.4 when the live row changed: those are in-page edits', async () => {
    mocks.liveRow = { ...mocks.liveRow, updated_at: '2026-10-15T08:00:00+00:00' };
    mocks.draftMeta = { title: 'New title' };

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });
    expect(publishArgs().p_overlay).toEqual({ title: 'New title' });
  });
});

/**
 * Every error the database answers rolled the whole publish back (one transaction), so nothing is live,
 * the draft stays, and nothing needs refreshing. Only a call that got no answer may have committed.
 */
describe('what a refused or failed publish answers', () => {
  const FAILURES: Array<[string, { code: string; message: string }, string]> = [
    [
      'the draft is gone (another publish or a discard came first)',
      { code: 'NBP01', message: 'No draft exists for this product.' },
      NO_PRODUCT_DRAFT_ERROR,
    ],
    [
      'the draft changed after it was read (a save landed in between)',
      { code: 'NBP02', message: 'The draft changed after it was read.' },
      PRODUCT_DRAFT_CHANGED_DURING_PUBLISH_ERROR,
    ],
    [
      'the product row changed after it was read',
      { code: 'NBP03', message: 'The product changed after it was read.' },
      PRODUCT_CHANGED_DURING_PUBLISH_ERROR,
    ],
    [
      'the database refused the role (demoted since the check)',
      { code: '42501', message: 'Only an administrator can publish products.' },
      PRODUCT_PUBLISH_ADMIN_ONLY_ERROR,
    ],
    [
      'a deadlock with a write to a translation sharing the SKU',
      { code: '40P01', message: 'deadlock detected' },
      PRODUCT_PUBLISH_CONFLICT_ERROR,
    ],
    [
      'the database has not applied migration 02043',
      { code: 'PGRST202', message: 'Could not find the function public.publish_product_draft in the schema cache' },
      PRODUCT_PUBLISH_NEEDS_MIGRATION_ERROR,
    ],
    [
      'a constraint (a variant naming a deleted attribute term)',
      { code: '23503', message: 'insert or update on table "variant_attribute_mapping" violates foreign key constraint' },
      'Publishing failed: insert or update on table "variant_attribute_mapping" violates foreign key constraint. Nothing was published; the draft is kept.',
    ],
    [
      'another permission error than the role check',
      { code: '42501', message: 'permission denied for table inventory_items' },
      'Publishing failed: permission denied for table inventory_items. Nothing was published; the draft is kept.',
    ],
  ];

  it.each(FAILURES)('when %s: says so, pushes no coupon and refreshes nothing', async (_case, error, expected) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.getProduct.mockResolvedValue({ data: LIVE_FREEMIUS_PRODUCT, error: null });
    mocks.rpcAnswer = { data: null, error };

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: false, error: expected });
    expect(mocks.syncProductSaleCouponToFreemius).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
    expect(mocks.cookieWrites).not.toHaveBeenCalled();
  });

  it('never claims nothing was published when the call got no answer (it may have committed), and refreshes the pages', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // supabase-js reports a failed request as an error without a code.
    mocks.rpcAnswer = { data: null, error: { code: '', message: 'TypeError: fetch failed' } };

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({
      success: false,
      error:
        'The publish could not be confirmed (TypeError: fetch failed). Reload the page: if the draft is gone, it was published; if it is still there, nothing was, and you can publish again.',
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/product/pro-plugin');
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/cms/products/${PRODUCT_ID}/edit`);
    expect(mocks.syncProductSaleCouponToFreemius).not.toHaveBeenCalled();
  });

  it('says the same when the call throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.rpc.mockImplementationOnce(() => {
      throw new Error('socket hang up');
    });

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({
      success: false,
      error:
        'The publish could not be confirmed (socket hang up). Reload the page: if the draft is gone, it was published; if it is still there, nothing was, and you can publish again.',
    });
  });

  it('pins the messages the draft bar and the visibility dialog show', () => {
    expect(PRODUCT_DRAFT_CHANGED_DURING_PUBLISH_ERROR).toBe(
      'The draft changed after this publish read it (an edit was saved into it meanwhile): nothing was published, and the draft keeps that edit. Publish again.'
    );
    expect(PRODUCT_CHANGED_DURING_PUBLISH_ERROR).toMatch(/^The product changed after this publish read it .*: nothing was published; the draft is kept\. Publish again\.$/);
    // Review 2026-11-18: a project made with create-nextblock has no db:migrate script (its package.json
    // runs dev, build, start, update, ...), so the message names the route for each install (docs/13, the
    // 0.23.6 entry): the update's database step or the next production build there, db:migrate here.
    expect(PRODUCT_PUBLISH_NEEDS_MIGRATION_ERROR).toBe(
      'Publishing products needs database migration 02043, which this database has not applied yet. Nothing was published; the draft is kept. Apply the pending migrations (in a project made with create-nextblock: npm run update -- --db-only, or redeploy; in the NextBlock repository: npm run db:migrate), then publish again.'
    );
    // The scripts it names exist where it says: a project's package.json is apps/nextblock's.
    const projectScripts = JSON.parse(readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')).scripts;
    expect(projectScripts).toHaveProperty('update');
    expect(projectScripts).not.toHaveProperty('db:migrate');
    expect(readFileSync(path.resolve(__dirname, '../../tools/update.mjs'), 'utf8')).toContain("'--db-only'");
    expect(JSON.parse(readFileSync(path.resolve(__dirname, '../../../../package.json'), 'utf8')).scripts).toHaveProperty('db:migrate');
    // None of them reads as a partial success ("Published, but"): nothing is ever half-published now.
    for (const message of [PRODUCT_DRAFT_CHANGED_DURING_PUBLISH_ERROR, PRODUCT_CHANGED_DURING_PUBLISH_ERROR, PRODUCT_PUBLISH_CONFLICT_ERROR, PRODUCT_PUBLISH_NEEDS_MIGRATION_ERROR]) {
      expect(message.startsWith('Published, but')).toBe(false);
    }
  });
});

describe('revalidation', () => {
  it('revalidates the slug the product had, the one the publish answered, and the edit page', async () => {
    mocks.draftMeta = { ...structuredClone(FORM_AUTOSAVE_META), slug: 'pro-plugin-renamed' };
    mocks.rpcAnswer = published({ slug: 'pro-plugin-renamed' });

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    expect(mocks.revalidatePath).toHaveBeenCalledWith('/product/pro-plugin');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/product/pro-plugin-renamed');
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/cms/products/${PRODUCT_ID}/edit`);
    // After the call: nothing is refreshed before it is live.
    expect(mocks.rpc.mock.invocationCallOrder[0]).toBeLessThan(mocks.revalidatePath.mock.invocationCallOrder[0]);
  });
});

/**
 * Probe L (verify round 6): converting a legacy snapshot into an overlay kept its stale title for good
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

  it('skips the recorded title with the warning once the product changed after the snapshot, and sends the in-page edit', async () => {
    // A 0.23.4 Freemius sync (which sets updated_at) renamed the product after the conversion.
    mocks.liveRow = { ...mocks.liveRow, title: 'Pro plugin - Growth', updated_at: '2026-11-14T12:00:00+00:00' };
    mocks.draftMeta = structuredClone(CONVERTED);

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({
      success: true,
      warning: describeSkippedProductDraftOverlay(['title'], ['short_description']),
    });
    expect(publishArgs().p_overlay).toEqual({ short_description: 'New short copy' });
  });

  it('sends it while the product is unchanged since the snapshot, and neither recorded key', async () => {
    mocks.liveRow = { ...mocks.liveRow, title: 'Pro plugin - Starter', updated_at: '2026-06-01T10:00:00+00:00' };
    mocks.draftMeta = structuredClone(CONVERTED);

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });
    expect(publishArgs().p_overlay).toEqual({ title: 'Pro plugin - Basic', short_description: 'New short copy' });
    expect(mocks.getProduct).not.toHaveBeenCalled();
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
