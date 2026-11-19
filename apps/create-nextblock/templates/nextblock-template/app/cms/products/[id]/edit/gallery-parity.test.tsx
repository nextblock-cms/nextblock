import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { orderProductGalleryEntries } from '@nextblock-cms/ecommerce/product-gallery';

/**
 * The gallery the product edit page shows for a draft is the gallery publishing that draft writes
 * (security review 2026-11-15, the 0.23.4 follow-up).
 *
 * product_drafts RLS checks the role only, so any WRITER can PATCH a draft's `product_media` over
 * PostgREST. Until this fix the edit page drew a draft's tiles from the draft's own embedded `media`
 * object whenever its media query failed (one non-uuid id made it fail) or missed an id (another
 * case, a deleted image), and in the draft's own `sort_order`, while publish writes the list's order,
 * lowercased, each id once, uuids with a media row only. An ADMIN could be shown the live gallery and
 * publish another order or main image.
 *
 * Each case below hands the same crafted draft to the REAL edit page (called directly, its returned
 * tree inspected for the props ProductForm gets, as page.test.tsx does, with the real draft merge and
 * gallery hydration) and to the REAL publishProductVisualEditingDraft, over one fake cookie client that
 * answers like PostgREST: a media select with a non-uuid id fails (22P02), uuids match in any case and
 * come back lowercase. Publish is one public.publish_product_draft call (migration 02043), so the
 * gallery it writes is the `gallery_media_ids` it sends, read by the function's own rule (publishGallery
 * mirrors it; tools/scripts/product-draft-publish.db.test.ts and posture section 44 run the function).
 * The gallery ProductForm shows (orderProductGalleryEntries, the order its gallery manager draws and
 * saves) must be the gallery publish writes, every tile drawn from its own media row.
 */

const PRODUCT_ID = '123e4567-e89b-42d3-a456-426614174000';
// With hex letters, so an uppercase spelling is another string.
const LIVE_MAIN = 'a1111111-1111-4111-8111-11111111111a';
const LIVE_SECOND = 'b2222222-2222-4222-8222-22222222222b';
const OTHER = 'c3333333-3333-4333-8333-33333333333c';
const DELETED = 'd4444444-4444-4444-8444-44444444444d';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MEDIA_ROWS: Record<string, { id: string; file_path: string; object_key: string; file_name: string; description: string | null }> = {
  [LIVE_MAIN]: { id: LIVE_MAIN, file_path: 'uploads/live-main.webp', object_key: 'uploads/live-main.webp', file_name: 'live-main.webp', description: 'Live main' },
  [LIVE_SECOND]: { id: LIVE_SECOND, file_path: 'uploads/live-second.webp', object_key: 'uploads/live-second.webp', file_name: 'live-second.webp', description: null },
  [OTHER]: { id: OTHER, file_path: 'uploads/other.webp', object_key: 'uploads/other.webp', file_name: 'other.webp', description: 'Another image' },
};

/** What a WRITER can embed to show the ADMIN the live main image on any entry. */
const EMBEDDED_LIVE_MAIN = { file_path: 'uploads/live-main.webp', object_key: 'uploads/live-main.webp', alt_text: 'Live main' };

const mocks = vi.hoisted(() => ({
  getProduct: vi.fn(),
  getFullProductContent: vi.fn(),
  createProductRevision: vi.fn(),
  syncSharedInventoryForSavedProduct: vi.fn(),
  syncProductSaleCouponToFreemius: vi.fn(),
  revalidatePath: vi.fn(),
  draftMeta: {} as Record<string, unknown>,
  /** A media read the database fails for any reason (not one a non-uuid id causes). */
  mediaReadError: null as null | { message: string; code?: string },
  log: [] as Array<Record<string, any>>,
}));

type Query = {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete' | 'upsert';
  filters: Array<[string, ...unknown[]]>;
  values?: unknown;
  single: boolean;
};

function resolve(q: Query) {
  const filter = (name: string, column: string) => q.filters.find((f) => f[0] === name && f[1] === column);
  if (q.table === 'profiles') return { data: { role: 'ADMIN' }, error: null };
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
    if (q.op === 'update') return { data: [{ id: 7 }], error: null }; // publish's claim
    return { data: null, error: null };
  }
  if (q.table === 'media' && q.op === 'select') {
    if (mocks.mediaReadError) return { data: null, error: mocks.mediaReadError };
    const ids = ((filter('in', 'id')?.[2] ?? []) as unknown[]).map(String);
    // PostgREST casts the whole list to uuid: one value that is not one fails the request.
    const bad = ids.find((id) => !UUID.test(id));
    if (bad) return { data: null, error: { code: '22P02', message: `invalid input syntax for type uuid: "${bad}"` } };
    // uuid equality ignores case, and Postgres prints uuids lowercase.
    const wanted = new Set(ids.map((id) => id.toLowerCase()));
    return { data: Object.values(MEDIA_ROWS).filter((row) => wanted.has(row.id)), error: null };
  }
  if (q.table === 'products') {
    if (q.op === 'select' && q.single) return { data: { id: PRODUCT_ID, sku: 'PRO', sale_price: null, sale_prices: {} }, error: null };
    if (q.op === 'select') return { data: [{ id: PRODUCT_ID }], error: null };
    return { data: null, error: null };
  }
  // currencies, blocks, categories, ...: nothing the gallery depends on.
  return { data: [], error: null };
}

function makeCookieClient() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'admin-1' } }, error: null }) },
    rpc: async (fn: string, args: unknown) => {
      mocks.log.push({ table: `rpc:${fn}`, op: 'rpc', values: args, filters: [] });
      if (fn === 'publish_product_draft') {
        // What the function answers once everything is live (migrations 02043 and 02044).
        return {
          data: {
            product_id: PRODUCT_ID,
            previous_slug: 'pro-plugin',
            slug: 'pro-plugin',
            payment_provider: 'stripe',
            wrote_values: true,
            stock_adjusted: [],
            revision: { recorded: true, version: 2 },
          },
          error: null,
        };
      }
      return { data: PRODUCT_ID, error: null };
    },
    from(table: string) {
      const q: Query = { table, op: 'select', filters: [], single: false };
      const chain: Record<string, any> = {};
      chain.select = () => chain;
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
        chain[name] = (values?: unknown) => {
          q.op = name;
          q.values = values;
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

function Stub({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock('next/link', () => ({ default: Stub }));
vi.mock('@nextblock-cms/db/server', () => ({
  verifyPackageOnline: async () => true,
  getActiveLanguagesServerSide: async () => [{ id: 1, code: 'en', name: 'English', is_default: true }],
  createClient: () => cookieClient,
  getServiceRoleSupabaseClient: () => ({ from: vi.fn(), rpc: vi.fn() }),
  getSsgSupabaseClient: vi.fn(),
}));
vi.mock('@nextblock-cms/ui', () => ({
  Badge: Stub,
  Button: Stub,
  DropdownMenu: Stub,
  DropdownMenuContent: Stub,
  DropdownMenuItem: Stub,
  DropdownMenuLabel: Stub,
  DropdownMenuSeparator: Stub,
  DropdownMenuButtonTrigger: Stub,
}));
// The edit page's product read; publish reads the same row through product-actions' getProduct.
vi.mock('@nextblock-cms/ecommerce/server', () => ({
  getCmsProduct: async () => (await mocks.getProduct()).data,
  getEnabledPaymentProviders: async () => ['stripe'],
  getGlobalProductAttributes: async () => [],
  getProductTranslations: async () => [],
  getStoreConfigStatus: async () => ({}),
  getStoreReadiness: async () => ({}),
  normalizeCurrencyRecord: (currency: unknown) => currency,
  updateProductAction: async () => ({ success: true }),
  getCategoriesWithCount: async () => [],
  getProductCategories: async () => [],
}));
// The real buildProductDraftPublishValues; only the live read is canned.
vi.mock('@nextblock-cms/ecommerce/product-actions', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getProduct: mocks.getProduct,
}));
vi.mock('@nextblock-cms/ecommerce/shared-inventory', () => ({
  syncSharedInventoryForSavedProduct: mocks.syncSharedInventoryForSavedProduct,
}));
vi.mock('@nextblock-cms/ecommerce/freemius-coupons', () => ({
  syncProductSaleCouponToFreemius: mocks.syncProductSaleCouponToFreemius,
}));
vi.mock('@nextblock-cms/utils/server', () => ({ getS3Client: async () => ({ send: vi.fn() }) }));
vi.mock('../../../../../lib/auth/twoFactor', () => ({
  evaluateTwoFactor: async () => ({ status: 'satisfied', userId: 'admin-1', mfaType: null }),
}));
vi.mock('../../../revisions/utils', () => ({ getFullProductContent: mocks.getFullProductContent }));
vi.mock('../../../revisions/service', () => ({ createProductRevision: mocks.createProductRevision }));
vi.mock('../../ProductFormClientShell', () => ({ default: function ProductFormClientShell() { return null; } }));
vi.mock('../../../components/CortexAiPageContext', () => ({ CortexAiPageContextRegistrar: Stub }));
vi.mock('../../../blocks/components/BlockEditorArea', () => ({ default: Stub }));
vi.mock('../../../components/VisibilityControl', () => ({ default: function VisibilityControl() { return null; } }));
vi.mock('../../../revisions/RevisionHistoryButton', () => ({ default: Stub }));
vi.mock('../../../../../lib/publishing/viewUrl', () => ({ buildViewUrl: () => '/product/pro-plugin' }));
vi.mock('../../../../../lib/seo/page-audit-context', () => ({ PageSeoProvider: Stub }));
vi.mock('../../../../../components/seo/PageSeoAuditSection', () => ({ PageSeoAuditSection: Stub }));

import EditProductPage from './page';
import ProductFormClientShell from '../../ProductFormClientShell';
import { publishProductVisualEditingDraft } from '../../../../../lib/visual-editing/product-drafts';

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
  translation_group_id: null,
  meta_title: null,
  meta_description: null,
  product_type: 'physical',
  payment_provider: 'stripe',
  status: 'active',
  description_json: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Live copy' }] }] },
  short_description: 'Live short copy',
  product_variants: [],
  // The live gallery as getProduct embeds it: LIVE_MAIN is the main image.
  product_media: [LIVE_MAIN, LIVE_SECOND].map((media_id, sort_order) => ({
    media_id,
    sort_order,
    media: { id: media_id, file_path: MEDIA_ROWS[media_id].file_path, object_key: MEDIA_ROWS[media_id].object_key },
  })),
  updated_at: '2026-11-01T00:00:00.000Z',
};

/** The first element of `type` in a returned tree (children arrays and fragments included). */
function findElement(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<Record<string, unknown>>;
  if (element.type === type) return element;
  return findElement(element.props.children as ReactNode, type);
}

/** The texts of the page's notices above the form (`role="alert"`). */
function findNotices(node: ReactNode, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((child) => findNotices(child, found));
    return found;
  }
  if (!isValidElement(node)) return found;
  const props = (node as ReactElement<Record<string, unknown>>).props;
  if (props.role === 'alert') {
    const texts: string[] = [];
    const collect = (child: ReactNode) => {
      if (typeof child === 'string') texts.push(child);
      else if (Array.isArray(child)) child.forEach(collect);
      else if (isValidElement(child)) collect((child.props as { children?: ReactNode }).children);
    };
    collect(props.children as ReactNode);
    found.push(texts.join(''));
    return found;
  }
  return findNotices(props.children as ReactNode, found);
}

type Tile = { media_id: string; sort_order?: number | null; media?: { file_path?: string | null; object_key?: string | null } | null };

/** What the editor sees: the page's gallery for ProductForm, in the order its gallery manager draws it. */
async function renderEditPageGallery() {
  const tree = await EditProductPage({ params: Promise.resolve({ id: PRODUCT_ID }), searchParams: Promise.resolve({}) });
  const shell = findElement(tree, ProductFormClientShell);
  if (!shell) throw new Error('no ProductFormClientShell in the page');
  const initialData = shell.props.initialData as { product_media?: Tile[] };
  const tiles = orderProductGalleryEntries(initialData.product_media ?? []);
  return {
    ids: tiles.map((tile) => tile.media_id),
    files: tiles.map((tile) => tile.media?.file_path || tile.media?.object_key || ''),
    notices: findNotices(tree),
  };
}

/**
 * What publishing the same draft writes to product_media, in sort_order: the `gallery_media_ids` its
 * one publish_product_draft call sends, read as the function reads them (apply_product_draft_values,
 * 02043: the list's order, each id lowercased and kept once, uuids only, then only ids with a media
 * row), here over the fake media table. Null leaves the gallery as it is: the live one stays.
 */
async function publishGallery() {
  mocks.log.length = 0;
  const result = await publishProductVisualEditingDraft(PRODUCT_ID);
  expect(result).toEqual({ success: true });
  const calls = mocks.log.filter((q) => q.table === 'rpc:publish_product_draft');
  expect(calls).toHaveLength(1);
  expect(mocks.log.filter((q) => q.table === 'media' && q.op !== 'select')).toEqual([]); // never a media write
  // Only the function writes the gallery.
  expect(mocks.log.filter((q) => q.table === 'product_media' && q.op !== 'select')).toEqual([]);
  const sent = (calls[0].values as { p_values?: { gallery_media_ids?: unknown } }).p_values?.gallery_media_ids;
  if (sent === null) {
    return orderProductGalleryEntries(LIVE_PRODUCT.product_media).map((item) => item.media_id);
  }
  if (!Array.isArray(sent)) throw new Error('publish sent no gallery');
  const written: string[] = [];
  for (const value of sent) {
    const id = typeof value === 'string' ? value.toLowerCase() : '';
    if (UUID.test(id) && !written.includes(id) && MEDIA_ROWS[id]) written.push(id);
  }
  return written;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocks.log.length = 0;
  mocks.mediaReadError = null;
  mocks.getProduct.mockImplementation(async () => ({ data: LIVE_PRODUCT, error: null }));
  mocks.getFullProductContent.mockResolvedValue({ meta: {}, blocks: [] });
  mocks.createProductRevision.mockResolvedValue({ success: true, version: 2, recorded: true });
});

/** A WRITER-written draft: product values (the live SKU) with the 0.23.4 marker, so no old-draft check runs. */
const writerDraft = (product_media: unknown) => ({ sku: 'PRO', form_version: 2, product_media });

describe('the product edit page shows the gallery a draft publish writes', () => {
  it.each([
    [
      'a non-uuid entry (it failed the old media query) and embedded live media on every entry',
      [
        { media_id: 'not-a-uuid', media: EMBEDDED_LIVE_MAIN },
        { media_id: OTHER, media: { file_path: 'uploads/live-second.webp' } },
      ],
      [OTHER],
      /an entry that is not a media item/,
    ],
    [
      "the draft's own sort_order putting the live main image first",
      [
        { media_id: OTHER, sort_order: 1 },
        { media_id: LIVE_MAIN, sort_order: 0 },
      ],
      [OTHER, LIVE_MAIN],
      null,
    ],
    [
      'an uppercase id (the old page missed it) with embedded live media',
      [{ media_id: OTHER.toUpperCase(), media: EMBEDDED_LIVE_MAIN }, { media_id: LIVE_SECOND }],
      [OTHER, LIVE_SECOND],
      null,
    ],
    [
      'a deleted image with embedded live media',
      [{ media_id: DELETED, media: EMBEDDED_LIVE_MAIN }, { media_id: LIVE_SECOND }],
      [LIVE_SECOND],
      /an image that is not in the media library/,
    ],
    [
      'repeats of one image, in another case',
      [{ media_id: LIVE_MAIN }, { media_id: LIVE_SECOND }, { media_id: LIVE_MAIN.toUpperCase(), media: EMBEDDED_LIVE_MAIN }],
      [LIVE_MAIN, LIVE_SECOND],
      /a repeat of an image it already lists/,
    ],
    ['control: a clean form autosave that reorders the gallery', [{ media_id: LIVE_SECOND }, { media_id: LIVE_MAIN }], [LIVE_SECOND, LIVE_MAIN], null],
    // The page reads a gallery through normalizeProductGallery, publish through 02043's SQL rule
    // (lowercased, matched whole against a uuid pattern, first occurrence kept, a media row required),
    // which publishGallery copies. Neither takes spaces round an id or braces: a TS reading that trimmed
    // or unbraced one would show an image publish drops, and these rows would fail.
    [
      'a padded id (the SQL rule takes no spaces round an id)',
      [{ media_id: ` ${LIVE_MAIN.toUpperCase()}  ` }, { media_id: LIVE_SECOND }],
      [LIVE_SECOND],
      /an entry that is not a media item\./,
    ],
    [
      'a braced id (the SQL rule takes no braces), before a repeat in another case',
      [{ media_id: `{${OTHER}}` }, { media_id: LIVE_SECOND }, { media_id: LIVE_SECOND.toUpperCase() }],
      [LIVE_SECOND],
      /an entry that is not a media item and a repeat of an image it already lists\./,
    ],
    // Not a list: publish sends no gallery (gallery_media_ids null) and the live one stays. The page
    // showed none for null, so the next autosave saved [] and the publish after it unlinked both
    // images; an object or a string made ProductForm throw on mount.
    ['a gallery that is null', null, [LIVE_MAIN, LIVE_SECOND], null],
    ['a gallery that is an object', {}, [LIVE_MAIN, LIVE_SECOND], null],
    ['a gallery that is a string', 'x', [LIVE_MAIN, LIVE_SECOND], null],
  ])('%s', async (_name, productMedia, expectedGallery, expectedNotice) => {
    mocks.draftMeta = writerDraft(productMedia);

    const shown = await renderEditPageGallery();
    const published = await publishGallery();

    expect(published).toEqual(expectedGallery);
    expect(shown.ids).toEqual(published);
    // Every tile is drawn from the media row of the id publish writes, never from the draft.
    expect(shown.files).toEqual(published.map((id) => MEDIA_ROWS[id].file_path));

    const galleryNotices = shown.notices.filter((notice) => notice.startsWith("This draft's gallery"));
    if (expectedNotice) {
      expect(galleryNotices).toEqual([expect.stringMatching(expectedNotice)]);
    } else {
      expect(galleryNotices).toEqual([]);
    }
  });

  it('fails the page instead of showing a gallery whose media rows it could not read', async () => {
    mocks.draftMeta = writerDraft([{ media_id: OTHER, media: EMBEDDED_LIVE_MAIN }]);
    mocks.mediaReadError = { message: 'canceling statement due to statement timeout', code: '57014' };

    await expect(
      EditProductPage({ params: Promise.resolve({ id: PRODUCT_ID }), searchParams: Promise.resolve({}) })
    ).rejects.toThrow("The draft's gallery could not be read: canceling statement due to statement timeout");
  });

  it('shows the live gallery, with no gallery note, for an old draft publish refuses for its gallery', async () => {
    // An unmarked draft (a pre-0.23.4 CMS draft import: no variation_attributes) whose gallery is empty
    // as publish reads it, over a live gallery: findPoisonedProductDraftFields names the gallery, so
    // publish refuses the draft and the page shows the live gallery for the next autosave to repair.
    mocks.draftMeta = { sku: 'PRO', product_media: [{ media_id: 'not-a-uuid', media: EMBEDDED_LIVE_MAIN }] };

    const shown = await renderEditPageGallery();

    expect(shown.ids).toEqual([LIVE_MAIN, LIVE_SECOND]);
    expect(shown.notices.filter((notice) => notice.startsWith("This draft's gallery"))).toEqual([]);
    expect(shown.notices).toEqual([expect.stringContaining('Affected in this draft: gallery.')]);

    mocks.log.length = 0;
    const result = await publishProductVisualEditingDraft(PRODUCT_ID);
    expect(result.success).toBe(false);
    // Refused before the function runs: nothing written.
    expect(mocks.log.filter((q) => q.table === 'rpc:publish_product_draft')).toEqual([]);
    expect(mocks.log.filter((q) => q.table === 'product_media' && q.op !== 'select')).toEqual([]);
  });

  it('shows the live gallery for an old CMS draft import whose gallery is null, as its publish keeps it', async () => {
    // Unmarked, no variation_attributes: a pre-0.23.4 import. A null gallery is not an emptied one
    // (findPoisonedProductDraftFields names nothing), so publish runs and leaves the gallery as it is.
    mocks.draftMeta = { sku: 'PRO', product_media: null };

    const shown = await renderEditPageGallery();
    const published = await publishGallery();

    expect(published).toEqual([LIVE_MAIN, LIVE_SECOND]);
    expect(shown.ids).toEqual(published);
    expect(shown.files).toEqual(published.map((id) => MEDIA_ROWS[id].file_path));
    expect(shown.notices).toEqual([]);
  });

  it('reads an id in another case as the same image when it checks an old draft (galleryDropsLiveImage)', async () => {
    // An unmarked form autosave over a row snapshot (its description emptied), listing the live
    // gallery in uppercase: it drops no live image, so only the description is named and the page
    // shows the draft's own gallery, as publish will write it once the description is repaired.
    mocks.draftMeta = {
      sku: 'PRO',
      price: 49,
      prices: { USD: 49 },
      variation_attributes: [],
      description_json: { type: 'doc', content: [{ type: 'paragraph' }] },
      product_media: [{ media_id: LIVE_SECOND.toUpperCase() }, { media_id: LIVE_MAIN.toUpperCase() }],
    };

    const shown = await renderEditPageGallery();

    expect(shown.ids).toEqual([LIVE_SECOND, LIVE_MAIN]);
    expect(shown.files).toEqual([MEDIA_ROWS[LIVE_SECOND].file_path, MEDIA_ROWS[LIVE_MAIN].file_path]);
    expect(shown.notices).toEqual([expect.stringContaining('Affected in this draft: description.')]);
  });
});
