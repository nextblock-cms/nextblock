import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security review 2026-11-15: a product publish never deletes media. An ADMIN's publish of a product
 * draft a WRITER wrote must not delete media rows or storage objects, and must not change the gallery
 * in a way the edit page did not show.
 *
 * Until 0.23.4 updateProduct() deleted every dropped gallery image and every media row the draft's
 * `explicitly_removed_media_ids` named that nothing else used, and handed every key those rows listed
 * to R2 with the deployment's credentials. product_drafts RLS checks the role only, so a WRITER could
 * PATCH a draft over PostgREST naming any media ids (or insert a decoy media row of their own whose
 * variants name a partner's avatar or another uploader's files), and the ADMIN saw the live values
 * and no notice. A hidden top-level `media_id` also replaced the whole gallery. And images that page
 * blocks, section backgrounds or the social image use are never referenced by a foreign key, so even
 * an honest gallery drop could delete files a live page still showed.
 *
 * The REAL publishProductVisualEditingDraft (requireCmsAdmin, classify, completeProductDraftValues,
 * claim, block swap, revision, draft delete) and the REAL updateProduct, over a fake cookie client
 * that answers as RLS does for an ADMIN (media_delete_policy is is_admin(): any row) and records
 * every write. Only the network edges are mocked: getProduct (the live row), the S3 client, the
 * inventory sync, the revision helpers, the second-factor evaluation and next/cache.
 */

const PRODUCT_ID = '123e4567-e89b-42d3-a456-426614174000';
const LIVE_IMAGE = '11111111-1111-4111-8111-111111111111';
const DECOY = '22222222-2222-4222-8222-222222222222';
const OTHER_UPLOADER_IMAGE = '33333333-3333-4333-8333-333333333333';

const mocks = vi.hoisted(() => ({
  s3Send: vi.fn(),
  syncSharedInventoryForSavedProduct: vi.fn(),
  getProduct: vi.fn(),
  getFullProductContent: vi.fn(),
  createProductRevision: vi.fn(),
  revalidatePath: vi.fn(),
  syncProductSaleCouponToFreemius: vi.fn(),
  role: 'ADMIN' as string,
  draftMeta: {} as Record<string, unknown>,
  liveGallery: [] as string[],
  log: [] as Array<Record<string, any>>,
}));

type Query = {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete' | 'upsert';
  columns?: string;
  head: boolean;
  filters: Array<[string, ...unknown[]]>;
  values?: unknown;
  options?: unknown;
  returning?: string;
  single: boolean;
};

const EXISTING_MEDIA = [LIVE_IMAGE, DECOY, OTHER_UPLOADER_IMAGE];

function resolve(q: Query) {
  const filter = (name: string, column: string) => q.filters.find((f) => f[0] === name && f[1] === column);
  if (q.table === 'profiles') return { data: { role: mocks.role }, error: null };
  if (q.table === 'product_drafts') {
    if (q.op === 'select') {
      return {
        data: {
          id: 7,
          product_id: PRODUCT_ID,
          author_id: 'writer-1',
          meta: mocks.draftMeta,
          blocks: [],
          created_at: '2026-11-15T01:00:00.000Z',
          updated_at: '2026-11-15T01:00:00.000Z',
        },
        error: null,
      };
    }
    if (q.op === 'update') return { data: [{ id: 7 }], error: null }; // the claim
    return { data: null, error: null };
  }
  if (q.table === 'blocks') return { data: [], error: null };
  if (q.table === 'media' && q.op === 'select') {
    const ids = (filter('in', 'id')?.[2] ?? []) as string[];
    return { data: ids.filter((id) => EXISTING_MEDIA.includes(id)).map((id) => ({ id })), error: null };
  }
  if (q.table === 'products') {
    if (q.op === 'select' && q.single) return { data: { id: PRODUCT_ID, sku: 'PRO', sale_price: null, sale_prices: {} }, error: null };
    if (q.op === 'select') return { data: [{ id: PRODUCT_ID }], error: null };
    return { data: null, error: null };
  }
  return { data: null, error: null, count: 0 };
}

function makeCookieClient() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'admin-1' } }, error: null }) },
    rpc: async (fn: string, args: unknown) => {
      mocks.log.push({ table: `rpc:${fn}`, op: 'rpc', values: args });
      return { data: PRODUCT_ID, error: null };
    },
    from(table: string) {
      const q: Query = { table, op: 'select', head: false, filters: [], single: false };
      const chain: Record<string, any> = {};
      chain.select = (columns?: string, options?: { head?: boolean }) => {
        if (q.op === 'select') {
          q.columns = columns;
          q.head = Boolean(options?.head);
        } else {
          q.returning = columns;
        }
        return chain;
      };
      for (const name of ['eq', 'neq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'or', 'not', 'filter', 'match']) {
        chain[name] = (...args: unknown[]) => {
          q.filters.push([name, ...args]);
          return chain;
        };
      }
      chain.order = () => chain;
      chain.range = () => chain;
      chain.limit = () => chain;
      for (const name of ['insert', 'update', 'delete', 'upsert'] as const) {
        chain[name] = (values?: unknown, options?: unknown) => {
          q.op = name;
          q.values = values;
          q.options = options;
          return chain;
        };
      }
      chain.single = async () => {
        q.single = true;
        mocks.log.push(q);
        return resolve(q);
      };
      chain.maybeSingle = chain.single;
      chain.then = (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => {
        mocks.log.push(q);
        return Promise.resolve(resolve(q)).then(onFulfilled, onRejected);
      };
      return chain;
    },
  };
}

const cookieClient = makeCookieClient();
const serviceClient = { from: vi.fn(), rpc: vi.fn() };

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@nextblock-cms/db/server', () => ({
  createClient: () => cookieClient,
  getServiceRoleSupabaseClient: () => serviceClient,
  getSsgSupabaseClient: vi.fn(),
}));
vi.mock('@nextblock-cms/utils/server', () => ({ getS3Client: async () => ({ send: mocks.s3Send }) }));
vi.mock('@nextblock-cms/ecommerce/shared-inventory', () => ({
  syncSharedInventoryForSavedProduct: mocks.syncSharedInventoryForSavedProduct,
}));
// The real updateProduct; only the live read is canned.
vi.mock('@nextblock-cms/ecommerce/product-actions', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getProduct: mocks.getProduct,
}));
vi.mock('@nextblock-cms/ecommerce/freemius-coupons', () => ({
  syncProductSaleCouponToFreemius: mocks.syncProductSaleCouponToFreemius,
}));
vi.mock('../auth/twoFactor', () => ({
  evaluateTwoFactor: async () => ({ status: 'satisfied', userId: 'admin-1', mfaType: null }),
}));
vi.mock('../../app/cms/revisions/utils', () => ({ getFullProductContent: mocks.getFullProductContent }));
vi.mock('../../app/cms/revisions/service', () => ({ createProductRevision: mocks.createProductRevision }));

import { publishProductVisualEditingDraft } from './product-drafts';

const LIVE_PRODUCT = {
  id: PRODUCT_ID,
  title: 'Pro plugin',
  slug: 'pro-plugin',
  sku: 'PRO',
  upc: null,
  price: 4900,
  prices: { USD: 4900 },
  sale_price: null,
  sale_prices: {},
  sale_start_at: null,
  sale_end_at: null,
  stock: 3,
  is_taxable: true,
  language_id: 1,
  languages: { code: 'en', is_default: true },
  product_type: 'physical',
  payment_provider: 'stripe',
  status: 'active',
  description_json: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Live copy' }] }] },
  short_description: 'Live short copy',
  product_variants: [],
  updated_at: '2026-11-01T00:00:00.000Z',
};

const writesTo = (table: string) => mocks.log.filter((q) => q.table === table && q.op !== 'select');

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocks.log.length = 0;
  mocks.role = 'ADMIN';
  mocks.liveGallery = [LIVE_IMAGE];
  mocks.getProduct.mockImplementation(async () => ({
    data: { ...LIVE_PRODUCT, product_media: mocks.liveGallery.map((media_id, sort_order) => ({ media_id, sort_order })) },
    error: null,
  }));
  mocks.getFullProductContent.mockResolvedValue({ meta: {}, blocks: [] });
  mocks.createProductRevision.mockResolvedValue({ success: true, version: 2, recorded: true });
});

describe('a product publish never deletes media (security review 2026-11-15)', () => {
  it("ignores a WRITER-written draft's hidden media_id and explicitly_removed_media_ids: the gallery stays as the edit page showed it", async () => {
    // What a WRITER can PATCH over PostgREST: the live SKU (classified as product values), the 0.23.4
    // marker (no old-draft check), a top-level media_id, and media ids to "remove".
    mocks.draftMeta = {
      sku: 'PRO',
      form_version: 2,
      media_id: DECOY,
      explicitly_removed_media_ids: [LIVE_IMAGE, OTHER_UPLOADER_IMAGE],
    };

    const result = await publishProductVisualEditingDraft(PRODUCT_ID);
    expect(result).toEqual({ success: true });

    // The RPC wrote the live values back.
    const rpc = mocks.log.find((q) => q.table === 'rpc:upsert_product_with_variants');
    expect(rpc?.values?.product_payload).toMatchObject({ sku: 'PRO', title: 'Pro plugin', price: 4900 });

    // No gallery write (the draft carries no product_media), no media row deleted, no object removed.
    expect(writesTo('product_media')).toEqual([]);
    expect(writesTo('media')).toEqual([]);
    expect(mocks.s3Send).not.toHaveBeenCalled();
  });

  it('only unlinks an image a draft drops from the gallery: its media row and files stay', async () => {
    mocks.liveGallery = [LIVE_IMAGE, DECOY];
    mocks.draftMeta = {
      sku: 'PRO',
      form_version: 2,
      product_media: [{ media_id: LIVE_IMAGE }],
      explicitly_removed_media_ids: [DECOY],
    };

    const result = await publishProductVisualEditingDraft(PRODUCT_ID);
    expect(result).toEqual({ success: true });

    expect(writesTo('product_media').map((q) => [q.op, q.values, q.filters])).toEqual([
      ['upsert', [{ product_id: PRODUCT_ID, media_id: LIVE_IMAGE, sort_order: 0 }], []],
      ['delete', undefined, [['eq', 'product_id', PRODUCT_ID], ['not', 'media_id', 'in', `(${LIVE_IMAGE})`]]],
    ]);
    expect(writesTo('media')).toEqual([]);
    expect(mocks.s3Send).not.toHaveBeenCalled();
  });

  it('control: the same draft published by a WRITER is refused before anything is read', async () => {
    mocks.role = 'WRITER';
    mocks.draftMeta = { sku: 'PRO', form_version: 2, media_id: DECOY };

    const result = await publishProductVisualEditingDraft(PRODUCT_ID);

    expect(result).toEqual({ success: false, error: 'Only an administrator can publish products.' });
    expect(writesTo('product_media')).toEqual([]);
    expect(writesTo('media')).toEqual([]);
  });
});
