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
 * Since migration 02043 the publish is one call, `publish_product_draft`: the REAL
 * publishProductVisualEditingDraft (requireCmsAdmin, classify, completeProductDraftValues) and the REAL
 * buildProductDraftPublishValues build its arguments here, over a fake cookie client that records every
 * write and the call. What the function does with the gallery (one upsert of the listed images, one
 * unlink of the rest, never a media row: the dropped image keeps its row) runs against a real database
 * in tools/scripts/product-draft-publish.db.test.ts and security-verify.sql section 44; that file also
 * holds the migration's text to the same rule, without a database.
 */

const PRODUCT_ID = '123e4567-e89b-42d3-a456-426614174000';
const LIVE_IMAGE = '11111111-1111-4111-8111-111111111111';
const DECOY = '22222222-2222-4222-8222-222222222222';
const OTHER_UPLOADER_IMAGE = '33333333-3333-4333-8333-333333333333';

const mocks = vi.hoisted(() => ({
  s3Send: vi.fn(),
  getProduct: vi.fn(),
  revalidatePath: vi.fn(),
  syncProductSaleCouponToFreemius: vi.fn(),
  rpc: vi.fn(),
  role: 'ADMIN' as string,
  draftMeta: {} as Record<string, unknown>,
  liveGallery: [] as string[],
  writes: [] as Array<[string, string]>,
}));

function makeCookieClient() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'admin-1' } }, error: null }) },
    rpc: async (fn: string, args: unknown) => {
      mocks.rpc(fn, args);
      return {
        data: { product_id: PRODUCT_ID, previous_slug: 'pro-plugin', slug: 'pro-plugin', payment_provider: 'stripe', wrote_values: true },
        error: null,
      };
    },
    from(table: string) {
      let op = 'select';
      const chain: Record<string, any> = {};
      const answer = () => {
        if (table === 'profiles') return { data: { role: mocks.role }, error: null };
        if (table === 'product_drafts') {
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
        return { data: null, error: null };
      };
      for (const name of ['select', 'eq', 'neq', 'in', 'not', 'order', 'range', 'limit']) chain[name] = () => chain;
      for (const name of ['insert', 'update', 'delete', 'upsert']) {
        chain[name] = () => {
          op = name;
          mocks.writes.push([name, table]);
          return chain;
        };
      }
      chain.single = async () => answer();
      chain.maybeSingle = async () => answer();
      chain.then = (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(op === 'select' ? answer() : { data: null, error: null }).then(onFulfilled, onRejected);
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
// The real buildProductDraftPublishValues; only the live read is canned.
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

/** The product values the one publish call carried. */
function publishedValues(): Record<string, unknown> {
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
  expect(mocks.rpc.mock.calls[0][0]).toBe('publish_product_draft');
  return mocks.rpc.mock.calls[0][1].p_values;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocks.writes.length = 0;
  mocks.role = 'ADMIN';
  mocks.liveGallery = [LIVE_IMAGE];
  mocks.getProduct.mockImplementation(async () => ({
    data: { ...LIVE_PRODUCT, product_media: mocks.liveGallery.map((media_id, sort_order) => ({ media_id, sort_order })) },
    error: null,
  }));
});

describe('a product publish never deletes media (security review 2026-11-15)', () => {
  it("never hands the function a WRITER-written draft's hidden media_id or explicitly_removed_media_ids: the gallery stays as the edit page showed it", async () => {
    // What a WRITER can PATCH over PostgREST: the live SKU (classified as product values), the 0.23.4
    // marker (no old-draft check), a top-level media_id, and media ids to "remove".
    mocks.draftMeta = {
      sku: 'PRO',
      form_version: 2,
      media_id: DECOY,
      explicitly_removed_media_ids: [LIVE_IMAGE, OTHER_UPLOADER_IMAGE],
    };

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    const values = publishedValues();
    // The live values go back.
    expect(values).toMatchObject({ sku: 'PRO', title: 'Pro plugin', price: 4900 });
    // No gallery (the draft carries no product_media: the function leaves the gallery as it is), and
    // neither key reaches the function under any name.
    expect(values.gallery_media_ids).toBeNull();
    expect(values).not.toHaveProperty('media_id');
    expect(values).not.toHaveProperty('explicitly_removed_media_ids');
    expect(JSON.stringify(values)).not.toContain(DECOY);
    expect(JSON.stringify(values)).not.toContain(OTHER_UPLOADER_IMAGE);
    // Nothing written outside the call, no object removed.
    expect(mocks.writes).toEqual([]);
    expect(mocks.s3Send).not.toHaveBeenCalled();
  });

  it('sends only the gallery the draft lists when it drops an image: the function unlinks it and keeps its media row', async () => {
    mocks.liveGallery = [LIVE_IMAGE, DECOY];
    mocks.draftMeta = {
      sku: 'PRO',
      form_version: 2,
      product_media: [{ media_id: LIVE_IMAGE }],
      explicitly_removed_media_ids: [DECOY],
    };

    await expect(publishProductVisualEditingDraft(PRODUCT_ID)).resolves.toEqual({ success: true });

    const values = publishedValues();
    expect(values.gallery_media_ids).toEqual([LIVE_IMAGE]);
    expect(values).not.toHaveProperty('explicitly_removed_media_ids');
    expect(mocks.writes).toEqual([]);
    expect(mocks.s3Send).not.toHaveBeenCalled();
  });

  it('control: the same draft published by a WRITER is refused before anything is read', async () => {
    mocks.role = 'WRITER';
    mocks.draftMeta = { sku: 'PRO', form_version: 2, media_id: DECOY };

    const result = await publishProductVisualEditingDraft(PRODUCT_ID);

    expect(result).toEqual({ success: false, error: 'Only an administrator can publish products.' });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.writes).toEqual([]);
  });
});
