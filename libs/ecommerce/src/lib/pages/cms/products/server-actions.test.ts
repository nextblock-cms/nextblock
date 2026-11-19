import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * createProductAction creates the product through `upsert_product_with_variants` (its is_admin()
 * guard reads the role only, which an aal1 session passes) and then pushes a Freemius product's
 * sale coupon with the service role through the developer key pair, which reaches every product
 * of the Freemius account. Until 2026-11-13 it checked no actor at all, so an ADMIN password
 * without the second factor reached that push. It now starts with the real requireEcomAdmin(),
 * exercised here against a stubbed cookie session and the app's second-factor gate.
 */

const GATE = Symbol.for('nextblock.cms.secondFactorGate');

const mocks = vi.hoisted(() => ({
  user: { id: 'admin-1' } as { id: string } | null,
  role: 'ADMIN' as string | null,
  secondFactorPassed: true,
  /** Whether product_drafts already has a row for the product (the autosave updates it, else inserts). */
  draftExists: false,
  cookieFrom: vi.fn(),
  cookieWrites: vi.fn(),
  serviceClientCreated: vi.fn(),
  createProduct: vi.fn(),
  syncProductSaleCouponToFreemius: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
}));

const serviceClient = { from: vi.fn() };

/**
 * A query that answers every chained call: reads resolve to an empty list (maybeSingle() to the
 * product's draft row when one exists), writes are recorded and succeed; an UPDATE of the draft
 * answers the row it wrote (the autosave selects it back to tell a vanished draft from a saved one).
 */
function emptyQuery(table: string) {
  const query: Record<string, unknown> = {};
  let op = 'select';
  for (const method of ['select', 'eq', 'order']) query[method] = () => query;
  for (const method of ['update', 'insert']) {
    query[method] = (values: unknown) => {
      op = method;
      mocks.cookieWrites(method, table, values);
      return query;
    };
  }
  query.maybeSingle = async () => ({
    data: table === 'product_drafts' && mocks.draftExists ? { id: 7 } : null,
    error: null,
  });
  query.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(
      op === 'select'
        ? { data: [], error: null }
        : op === 'update' && table === 'product_drafts'
          ? { data: mocks.draftExists ? [{ id: 7 }] : [], error: null }
          : { error: null }
    ).then(resolve, reject);
  return query;
}

const cookieClient = {
  auth: { getUser: async () => ({ data: { user: mocks.user } }) },
  from: (table: string) => {
    mocks.cookieFrom(table);
    if (table === 'profiles') {
      return {
        select: () => ({
          eq: () => ({ single: async () => ({ data: mocks.role ? { role: mocks.role } : null }) }),
        }),
      };
    }
    return emptyQuery(table);
  },
};

vi.mock('server-only', () => ({}));
vi.mock('@nextblock-cms/db/server', () => ({
  createClient: () => cookieClient,
  getServiceRoleSupabaseClient: () => {
    mocks.serviceClientCreated();
    return serviceClient;
  },
}));
vi.mock('../../../product-actions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../product-actions')>();
  return {
    createProduct: mocks.createProduct,
    deleteProduct: vi.fn(),
    isProductCreatedIncompleteError: actual.isProductCreatedIncompleteError,
    ProductCreatedIncompleteError: actual.ProductCreatedIncompleteError,
    syncCategoriesForTranslationGroup: vi.fn(),
  };
});
vi.mock('../../../freemius-coupons', () => ({
  syncProductSaleCouponToFreemius: mocks.syncProductSaleCouponToFreemius,
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import { createProductAction, updateProductAction } from './server-actions';

function productForm(paymentProvider: 'freemius' | 'stripe' = 'freemius') {
  return {
    title: 'Pro plugin',
    slug: 'pro-plugin',
    sku: 'PRO',
    price: 10000,
    prices: { USD: 10000 },
    sale_price: 0,
    sale_prices: { USD: 0 },
    status: 'active',
    product_type: paymentProvider === 'freemius' ? 'digital' : 'physical',
    payment_provider: paymentProvider,
    language_id: 1,
  } as unknown as Parameters<typeof createProductAction>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = { id: 'admin-1' };
  mocks.role = 'ADMIN';
  mocks.secondFactorPassed = true;
  mocks.draftExists = false;
  mocks.createProduct.mockResolvedValue({ id: 'product-1' });
  mocks.syncProductSaleCouponToFreemius.mockResolvedValue({ status: 'synced' });
  (globalThis as Record<symbol, unknown>)[GATE] = async () => mocks.secondFactorPassed;
});

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[GATE];
});

describe('createProductAction authorizes through requireEcomAdmin() first', () => {
  it('refuses an ADMIN whose second factor is still pending, before any read, write or Freemius call', async () => {
    mocks.secondFactorPassed = false;

    await expect(createProductAction(productForm())).rejects.toThrow('Unauthorized');
    expect(mocks.serviceClientCreated).not.toHaveBeenCalled();
    expect(mocks.cookieFrom.mock.calls.map(([table]) => table)).toEqual(['profiles']);
    expect(mocks.createProduct).not.toHaveBeenCalled();
    expect(mocks.syncProductSaleCouponToFreemius).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it.each([
    ['a WRITER', 'WRITER', 'Forbidden'],
    ['a customer', 'USER', 'Unauthorized'],
  ])('refuses %s before creating anything', async (_label, role, message) => {
    mocks.role = role;

    await expect(createProductAction(productForm())).rejects.toThrow(message);
    expect(mocks.createProduct).not.toHaveBeenCalled();
    expect(mocks.syncProductSaleCouponToFreemius).not.toHaveBeenCalled();
    expect(mocks.serviceClientCreated).not.toHaveBeenCalled();
  });

  it('refuses an anonymous caller', async () => {
    mocks.user = null;
    mocks.role = null;

    await expect(createProductAction(productForm())).rejects.toThrow('Unauthorized');
    expect(mocks.createProduct).not.toHaveBeenCalled();
    expect(mocks.syncProductSaleCouponToFreemius).not.toHaveBeenCalled();
  });

  it('lets an ADMIN who passed the factor create the product and push its sale coupon with the service client', async () => {
    await createProductAction(productForm('freemius'));

    // The RPC keeps running through the cookie client: is_admin() needs the caller's session.
    expect(mocks.createProduct).toHaveBeenCalledWith(cookieClient, expect.objectContaining({ sku: 'PRO' }));
    expect(mocks.syncProductSaleCouponToFreemius).toHaveBeenCalledWith({
      productId: 'product-1',
      client: serviceClient,
    });
    expect(mocks.redirect).toHaveBeenCalledWith('/cms/products');
  });

  it('pushes no sale coupon for a Stripe product', async () => {
    await createProductAction(productForm('stripe'));

    expect(mocks.createProduct).toHaveBeenCalledTimes(1);
    expect(mocks.syncProductSaleCouponToFreemius).not.toHaveBeenCalled();
  });
});

/**
 * A product createProduct() created but could not finish (a step after its RPC failed: the stock write
 * that lost a lock race, the categories...) exists. Until 2026-11-19 the action let the error through, so
 * the form reported a failed create (and a second Save met the product's slug).
 */
describe('createProductAction and a product it created but could not finish', () => {
  it('sends the editor to the product, naming the failed steps, after the coupon push; never a failed create', async () => {
    const { ProductCreatedIncompleteError } = await import('../../../product-actions');
    mocks.createProduct.mockRejectedValueOnce(
      new ProductCreatedIncompleteError('product-9', [
        { step: 'stock', message: 'deadlock detected' },
        { step: 'categories', message: 'fetch failed' },
      ])
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await createProductAction(productForm('freemius'));

    expect(mocks.syncProductSaleCouponToFreemius).toHaveBeenCalledWith({ productId: 'product-9', client: serviceClient });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/cms/products');
    expect(mocks.redirect).toHaveBeenCalledTimes(1);
    expect(mocks.redirect).toHaveBeenCalledWith('/cms/products/product-9/edit?created_incomplete=stock%2Ccategories');
  });

  it('lets any other error through: nothing was created', async () => {
    mocks.createProduct.mockRejectedValueOnce(Object.assign(new Error('duplicate key value violates unique constraint "products_slug_key"'), { code: '23505' }));

    await expect(createProductAction(productForm('stripe'))).rejects.toMatchObject({ code: '23505' });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

/**
 * The form's autosave (updateProductAction -> saveProductDraftMeta) stamps `form_version: 2` on the
 * product values it stores. The app checks a product-values draft without it, which an earlier
 * version wrote, for the fields the pre-0.23.4 edit page poisoned (prices x100, no variants, gallery
 * or description) and never checks a stamped one. apps/nextblock/lib/visual-editing/
 * product-draft-marker.test.ts pins this literal to the app's PRODUCT_DRAFT_FORM_MARKER_KEY / _VALUE.
 */
describe('the product form autosave stamps its draft as written by 0.23.4', () => {
  const formValues = {
    ...productForm('stripe'),
    price: 59,
    prices: { USD: 59 },
    sale_price: null,
    sale_prices: {},
    sale_start_at: '2026-11-20T00:00:00+00:00',
    sale_end_at: null,
    variants: [],
  } as unknown as Parameters<typeof updateProductAction>[1];

  function draftWrite(op: 'update' | 'insert') {
    const call = mocks.cookieWrites.mock.calls.find(([name, table]) => name === op && table === 'product_drafts');
    return call?.[2] as { meta: Record<string, unknown>; blocks?: unknown; product_id?: string } | undefined;
  }

  it('stamps the marker on an existing draft, beside the form values in major units', async () => {
    mocks.draftExists = true;

    await expect(updateProductAction('product-1', formValues)).resolves.toEqual({ success: true });

    expect(draftWrite('update')?.meta).toEqual(
      expect.objectContaining({
        sku: 'PRO',
        price: 59,
        prices: { USD: 59 },
        sale_start_at: '2026-11-20T00:00:00+00:00',
        sale_end_at: null,
        variants: [],
        form_version: 2,
      })
    );
    expect(draftWrite('insert')).toBeUndefined();
  });

  it('stamps it on a draft the autosave creates, seeded with the live blocks', async () => {
    await expect(updateProductAction('product-1', formValues)).resolves.toEqual({ success: true });

    expect(draftWrite('insert')).toEqual(
      expect.objectContaining({
        product_id: 'product-1',
        blocks: [],
        meta: expect.objectContaining({ sku: 'PRO', price: 59, form_version: 2 }),
      })
    );
  });

  it('stamps a WRITER\'s autosave too: WRITERs keep editing drafts, only publishing needs an ADMIN', async () => {
    mocks.role = 'WRITER';
    mocks.draftExists = true;

    await expect(updateProductAction('product-1', formValues)).resolves.toEqual({ success: true });
    expect(draftWrite('update')?.meta).toEqual(expect.objectContaining({ form_version: 2 }));
  });

  // Migration 02044: the stock the edit page loaded, per SKU, rides every autosave into the draft, so
  // publishing writes only the quantities changed in the form and a sale made meanwhile stays.
  it('stores the stock the edit page loaded beside the stock values, in an existing draft and a new one', async () => {
    const withBaseline = { ...formValues, stock: 7, stock_baseline: { PRO: 7 } } as typeof formValues;

    mocks.draftExists = true;
    await expect(updateProductAction('product-1', withBaseline)).resolves.toEqual({ success: true });
    expect(draftWrite('update')?.meta).toEqual(expect.objectContaining({ stock: 7, stock_baseline: { PRO: 7 } }));

    mocks.cookieWrites.mockClear();
    mocks.draftExists = false;
    await expect(updateProductAction('product-1', withBaseline)).resolves.toEqual({ success: true });
    expect(draftWrite('insert')?.meta).toEqual(expect.objectContaining({ stock: 7, stock_baseline: { PRO: 7 } }));
  });

  // The edit page used to draw a draft's tiles from an entry's embedded `media` object and order them
  // by its `sort_order`, neither of which publish reads (security review 2026-11-15, the 0.23.4
  // follow-up). The autosave stores the gallery as publish reads it (toProductGalleryDraftEntries).
  it.each([
    ['an existing draft', true, 'update'],
    ['a draft the autosave creates', false, 'insert'],
  ] as const)('stores the gallery of %s as bare { media_id } entries, in the order publish writes', async (_name, exists, op) => {
    mocks.draftExists = exists;
    const productMedia = [
      { media_id: 'B2222222-2222-4222-8222-22222222222B', sort_order: 0, media: { file_path: 'uploads/live-main.webp' } },
      { media_id: 'a1111111-1111-4111-8111-11111111111a', sort_order: 5, id: 'row-1' },
      { media_id: 'not-a-uuid', media: { file_path: 'uploads/live-main.webp' } },
      { media_id: 'b2222222-2222-4222-8222-22222222222b' },
      null,
    ];

    await expect(
      updateProductAction('product-1', { ...formValues, product_media: productMedia } as unknown as Parameters<typeof updateProductAction>[1])
    ).resolves.toEqual({ success: true });

    expect(draftWrite(op)?.meta.product_media).toEqual([
      { media_id: 'b2222222-2222-4222-8222-22222222222b' },
      { media_id: 'a1111111-1111-4111-8111-11111111111a' },
    ]);
  });

  it('leaves a values object without a gallery list as it is (publish then keeps the live gallery)', async () => {
    mocks.draftExists = true;

    await updateProductAction('product-1', formValues);

    expect(draftWrite('update')?.meta).not.toHaveProperty('product_media');
  });
});
