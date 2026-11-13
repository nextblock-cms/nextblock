import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SEO_META_DESCRIPTION_MAX_LENGTH,
  SEO_META_DESCRIPTION_MIN_LENGTH,
  SEO_META_TITLE_MAX_LENGTH,
} from '@nextblock-cms/utils/seo';
import { validateBlockContent } from '../../../../lib/blocks/blockRegistry';
import type { BlockType } from '../../../../lib/blocks/blockTypes';
import {
  AFFILIATES_DEMO_URLS,
  AFFILIATES_PRODUCT_COPY,
  AFFILIATES_PRODUCT_URL_PLACEHOLDER,
  type AffiliatesProductCopy,
} from './affiliates-product-copy';

/**
 * The Affiliates & Creator Storefronts product in the sandbox demo shop: its copy
 * (./affiliates-product-copy.ts) and the reset step that applies it (enrichAffiliatesProducts in
 * ./route.ts). A route file may export only its handlers, so the step runs through GET: storage,
 * Freemius, package activation and the demo partner are mocked, and Postgres is a fake that keeps
 * the rows this step reads and writes (products, product blocks, media, categories) and answers
 * every other statement of the reset with an empty result or a generated id.
 */

type Row = Record<string, any>;

const mocks = vi.hoisted(() => ({
  postgres: vi.fn(),
  createClient: vi.fn(),
  s3Send: vi.fn(),
  syncFreemiusProductsToSupabase: vi.fn(),
  activateSandboxPackage: vi.fn(),
  seedSandboxAffiliateDemo: vi.fn(),
  // NEXTBLOCK_PACKAGES.affiliates, read by the route each time the step runs.
  registry: { productId: '43273', planId: '75655', purchaseUrl: 'https://nextblock.dev' },
}));

vi.mock('./sandboxResetSql', () => ({ SANDBOX_RESET_SQL: '-- the replayed migrations' }));
vi.mock('@aws-sdk/client-s3', () => {
  class Command {
    input: Row;
    constructor(input: Row) {
      this.input = input;
    }
  }
  return {
    S3Client: class {
      send = (command: Command) => mocks.s3Send(command);
    },
    ListObjectsV2Command: class extends Command {},
    DeleteObjectsCommand: class extends Command {},
    PutObjectCommand: class extends Command {},
  };
});
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));
vi.mock('@nextblock-cms/ecommerce/server', () => ({
  syncFreemiusProductsToSupabase: mocks.syncFreemiusProductsToSupabase,
  syncSingleFreemiusProduct: vi.fn(),
}));
vi.mock('@nextblock-cms/cortex', () => ({ CORTEX_AI_PACKAGE_ID: 'cortex-ai' }));
vi.mock('postgres', () => ({ default: mocks.postgres }));
vi.mock('./activate-package', () => ({ activateSandboxPackage: mocks.activateSandboxPackage }));
vi.mock('./affiliate-demo', () => ({
  SANDBOX_AFFILIATE_DEMO_HANDLE: 'studio-nova',
  seedSandboxAffiliateDemo: mocks.seedSandboxAffiliateDemo,
}));
vi.mock('../../../../lib/affiliates/cache', () => ({
  evictAffiliateStorefrontCache: vi.fn(),
  evictAffiliateTiersCache: vi.fn(),
}));
vi.mock('@nextblock-cms/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nextblock-cms/utils')>();
  return {
    ...actual,
    NEXTBLOCK_PACKAGES: {
      ...actual.NEXTBLOCK_PACKAGES,
      affiliates: {
        ...actual.NEXTBLOCK_PACKAGES.affiliates,
        get fm_product_id() {
          return mocks.registry.productId;
        },
        get fm_plan_id() {
          return mocks.registry.planId;
        },
        get purchase_url() {
          return mocks.registry.purchaseUrl;
        },
      },
    },
  };
});

import { GET } from './route';

/* ------------------------------------------------------------------------------------------
 * The copy
 * ---------------------------------------------------------------------------------------- */

type ColumnBlock = { block_type: BlockType; content: Row };

function blocksIn(section: Row): ColumnBlock[] {
  return (section['column_blocks'] as ColumnBlock[][]).flat();
}

/** The URL of the last block of the last section: the final call to action. */
function finalButtonUrl(sections: ReadonlyArray<Row>): unknown {
  const blocks = blocksIn(sections[sections.length - 1]);
  const last = blocks[blocks.length - 1];
  expect(last.block_type).toBe('button');
  return last.content['url'];
}

/** The section tree with its words taken out (markup and classes stay): what EN and FR share. */
function layoutOf(value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    if (key === 'html_content') return value.replace(/>[^<]+</g, '><');
    if (key === 'text' || key === 'text_content') return 'TEXT';
    if (key === 'url') return value === AFFILIATES_PRODUCT_URL_PLACEHOLDER ? value : 'URL';
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => layoutOf(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, layoutOf(item, name)]));
  }
  return value;
}

describe('Affiliates product copy', () => {
  const locales = ['en', 'fr'] as const;

  it('gives French the same section structure, markup and classes as English', () => {
    const { en, fr } = AFFILIATES_PRODUCT_COPY;
    expect(fr.sections).toHaveLength(en.sections.length);
    expect(layoutOf(fr.sections)).toEqual(layoutOf(en.sections));
    expect(en.sections.length).toBe(5);
  });

  it('passes the block schemas the editor and renderers use', () => {
    for (const locale of locales) {
      for (const section of AFFILIATES_PRODUCT_COPY[locale].sections) {
        expect(validateBlockContent('section', section).errors).toEqual([]);
        for (const block of blocksIn(section)) {
          expect(validateBlockContent(block.block_type, block.content).errors).toEqual([]);
        }
      }
    }
  });

  it('links the final call to action, and nothing else, to the product page placeholder', () => {
    for (const locale of locales) {
      const copy = AFFILIATES_PRODUCT_COPY[locale];
      expect(JSON.stringify(copy).split(AFFILIATES_PRODUCT_URL_PLACEHOLDER)).toHaveLength(2);
      expect(finalButtonUrl(copy.sections)).toBe(AFFILIATES_PRODUCT_URL_PLACEHOLDER);
    }
  });

  it('keeps the meta title and description within the SEO engine limits', () => {
    for (const locale of locales) {
      const { meta_title, meta_description } = AFFILIATES_PRODUCT_COPY[locale];
      expect(meta_title.length).toBeLessThanOrEqual(SEO_META_TITLE_MAX_LENGTH);
      expect(meta_description.length).toBeGreaterThanOrEqual(SEO_META_DESCRIPTION_MIN_LENGTH);
      expect(meta_description.length).toBeLessThanOrEqual(SEO_META_DESCRIPTION_MAX_LENGTH);
    }
  });

  it('names no price (the product price fields show it) and writes courriel in French', () => {
    for (const locale of locales) {
      expect(JSON.stringify(AFFILIATES_PRODUCT_COPY[locale])).not.toMatch(/[$€£]|\bUSD\b|\bCAD\b/);
    }
    expect(JSON.stringify(AFFILIATES_PRODUCT_COPY.fr)).not.toMatch(/\be-?mails?\b/i);
  });
});

/* ------------------------------------------------------------------------------------------
 * The reset step, through GET and a fake Postgres
 * ---------------------------------------------------------------------------------------- */

const ROUTE_URL = 'https://sandbox.example.org/api/cron/reset-sandbox';
const EN_ID = 1;
const FR_ID = 2;
const SLUG = 'nextblock-affiliates-creator-storefronts-affiliates-license';
const JSON_TAG = '__fakeJson';

const ENV: Record<string, string> = {
  NEXT_PUBLIC_IS_SANDBOX: 'true',
  CRON_SECRET: 'reset-cron-secret',
  NEXT_PUBLIC_SUPABASE_URL: 'https://supabase.example.org',
  SUPABASE_URL: '',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  SUPABASE_SECRET_KEY: '',
  R2_ACCOUNT_ID: 'account',
  R2_ACCESS_KEY_ID: 'access-key',
  R2_SECRET_ACCESS_KEY: 'secret-key',
  R2_BUCKET_NAME: 'sandbox-media',
  NEXT_PUBLIC_URL: 'https://sandbox.example.org',
  POSTGRES_URL: 'postgres://sandbox.example.org/postgres',
  DATABASE_URL: '',
  FREEMIUS_ECOMMERCE_SANDBOX_KEY: 'sandbox-ecommerce',
  FREEMIUS_AI_SANDBOX_KEY: 'sandbox-ai',
  FREEMIUS_AFFILIATES_SANDBOX_KEY: 'sandbox-affiliates-demo',
};

/** An English product row as syncFreemiusProductsToSupabase writes it (one per Freemius plan). */
function syncedProduct(id: string, productId: string, planId: string, slug: string): Row {
  return {
    id,
    sku: `FM-${productId}-${planId}`,
    title: `Synced ${slug}`,
    slug,
    price: 20000,
    sale_price: null,
    stock: 999,
    status: 'active',
    short_description: 'The Freemius plan description.',
    language_id: EN_ID,
    translation_group_id: `group-${id}`,
    freemius_product_id: productId,
    freemius_plan_id: planId,
    trial_period_days: 30,
    trial_requires_payment_method: false,
  };
}

const COMMERCE_EN = syncedProduct('commerce-en', '24851', '40001', 'nextblock-commerce-pro-commerce-license');
const CORTEX_EN = syncedProduct('cortex-en', '28609', '47122', 'nextblock-cortex-ai-cortex-ai-license');
const AFFILIATES_EN = syncedProduct('affiliates-en', '43273', '75655', SLUG);

interface FakeState {
  products: Row[];
  updates: Array<{ id: unknown; values: Row }>;
  blocks: Row[];
  media: Row[];
  productMedia: Row[];
  productCategories: Row[];
}

interface FakeDb {
  sql: any;
  state: FakeState;
  statements: Array<{ text: string; params: unknown[] }>;
  transactions: string[];
}

type FailOn = (text: string, params: unknown[]) => boolean;

/** Top-level comma split (ignores commas inside parentheses and quotes). */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (const char of text) {
    if (char === "'") quoted = !quoted;
    if (!quoted && char === '(') depth += 1;
    if (!quoted && char === ')') depth -= 1;
    if (!quoted && depth === 0 && char === ',') {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function evaluate(expression: string, params: unknown[]): unknown {
  const param = /^\$(\d+)$/.exec(expression);
  if (param) {
    const value = params[Number(param[1]) - 1] as Row | undefined;
    return value && typeof value === 'object' && JSON_TAG in value ? value[JSON_TAG] : value;
  }
  if (expression === 'NULL') return null;
  if (expression === 'true' || expression === 'false') return expression === 'true';
  if (/^-?\d+$/.test(expression)) return Number(expression);
  const literal = /^'([^']*)'$/.exec(expression);
  return literal ? literal[1] : { unparsed: expression };
}

/** The row a single-row INSERT ... VALUES (...) writes. */
function insertedRow(text: string, params: unknown[]): Row {
  const match = /^INSERT INTO public\.\w+ \(([^)]*)\) VALUES \((.*?)\)(?= ON CONFLICT| RETURNING|$)/.exec(text);
  if (!match) throw new Error(`fake db: unparsed INSERT: ${text}`);
  const columns = match[1].split(',').map((column) => column.trim().replace(/"/g, ''));
  const values = splitTopLevel(match[2]).map((value) => evaluate(value, params));
  return Object.fromEntries(columns.map((column, index) => [column, values[index]]));
}

function createFakeDb(products: Row[], failOn?: FailOn): FakeDb {
  const state: FakeState = {
    products: structuredClone(products),
    updates: [],
    blocks: [],
    media: [],
    productMedia: [],
    productCategories: [],
  };
  const statements: FakeDb['statements'] = [];
  const transactions: string[] = [];
  let generated = 0;

  const run = async (strings: TemplateStringsArray, ...params: unknown[]): Promise<Row[]> => {
    const text = strings
      .reduce((sql, part, index) => `${sql}${index > 0 ? `$${index}` : ''}${part}`, '')
      .replace(/\s+/g, ' ')
      .replace(/\( /g, '(')
      .replace(/ \)/g, ')')
      .trim();
    statements.push({ text, params });
    if (failOn?.(text, params)) throw Object.assign(new Error('injected failure'), { code: 'XX000' });

    const language = /^SELECT id FROM public\.languages WHERE code = '(en|fr)' LIMIT 1$/.exec(text);
    if (language) return [{ id: language[1] === 'en' ? EN_ID : FR_ID }];

    if (/^SELECT (\*|id) FROM public\.products WHERE freemius_product_id = \$1 AND language_id = \$2 /.test(text)) {
      const rows = state.products.filter(
        (row) => row['freemius_product_id'] === params[0] && row['language_id'] === params[1]
      );
      if (text.includes('ORDER BY (freemius_plan_id = $3) DESC NULLS LAST')) {
        rows.sort(
          (a, b) => Number(b['freemius_plan_id'] === params[2]) - Number(a['freemius_plan_id'] === params[2])
        );
      }
      return rows.slice(0, 1).map((row) => ({ ...row }));
    }

    if (/^SELECT id, sku, freemius_product_id FROM public\.products WHERE freemius_product_id = ANY\(\$1\)/.test(text)) {
      const ids = params[0] as string[];
      return state.products
        .filter((row) => ids.includes(row['freemius_product_id']))
        .map(({ id, sku, freemius_product_id }) => ({ id, sku, freemius_product_id }));
    }

    if (text.startsWith('INSERT INTO public.media ')) {
      const row = insertedRow(text, params);
      state.media.push(row);
      return [{ id: `media:${row['object_key']}` }];
    }

    if (text.startsWith('INSERT INTO public.categories ')) {
      return [{ id: `category:${insertedRow(text, params)['slug']}` }];
    }

    if (text.startsWith('INSERT INTO public.products ')) {
      const row = insertedRow(text, params);
      // The FR twin of a Freemius product (the apparel seed falls through to a generated id).
      if (row['product_type'] === 'digital') {
        const stored = { ...row, id: `product:${row['slug']}` };
        state.products = state.products
          .filter((existing) => existing['language_id'] !== row['language_id'] || existing['slug'] !== row['slug'])
          .concat(stored);
        return [{ id: stored.id }];
      }
    }

    const update = /^UPDATE public\.products SET (.*) WHERE id = \$(\d+)$/.exec(text);
    if (update) {
      const values = Object.fromEntries(
        splitTopLevel(update[1]).map((assignment) => {
          const [column, expression] = assignment.split(' = ');
          return [column, evaluate(expression, params)];
        })
      );
      state.updates.push({ id: params[Number(update[2]) - 1], values });
      return [];
    }

    if (text === 'DELETE FROM public.blocks WHERE product_id = $1') {
      state.blocks = state.blocks.filter((block) => block['product_id'] !== params[0]);
      return [];
    }
    if (text.startsWith('INSERT INTO public.blocks (product_id,')) {
      state.blocks.push(insertedRow(text, params));
      return [];
    }
    if (text === 'DELETE FROM public.product_media WHERE product_id = $1') {
      state.productMedia = state.productMedia.filter((row) => row['product_id'] !== params[0]);
      return [];
    }
    if (text.startsWith('INSERT INTO public.product_media ')) {
      state.productMedia.push(insertedRow(text, params));
      return [];
    }
    if (text === 'DELETE FROM public.product_categories WHERE product_id = ANY($1)') {
      const ids = params[0] as unknown[];
      state.productCategories = state.productCategories.filter((row) => !ids.includes(row['product_id']));
      return [];
    }
    if (text.startsWith('INSERT INTO public.product_categories ')) {
      state.productCategories.push(insertedRow(text, params));
      return [];
    }

    if (text.startsWith('DELETE ')) return [];
    if (text.includes(' RETURNING ')) {
      generated += 1;
      return [{ id: `row:${generated}` }];
    }
    return [];
  };

  const sql = Object.assign(run, {
    json: (value: unknown) => ({ [JSON_TAG]: value }),
    unsafe: async () => [],
    end: async () => undefined,
    begin: async (callback: (transaction: unknown) => unknown): Promise<unknown> => {
      const snapshot = structuredClone(state);
      transactions.push('BEGIN');
      try {
        const result = await callback(sql);
        transactions.push('COMMIT');
        return result;
      } catch (error) {
        Object.assign(state, snapshot);
        transactions.push('ROLLBACK');
        throw error;
      }
    },
  });

  return { sql, state, statements, transactions };
}

const SUPABASE_ADMIN = {
  auth: {
    admin: {
      listUsers: async () => ({ data: { users: [{ id: 'demo-user', email: 'demo@nextblock.dev' }] }, error: null }),
      updateUserById: async () => ({ data: {}, error: null }),
      mfa: {
        listFactors: async () => ({ data: { factors: [] }, error: null }),
        deleteFactor: async () => ({ data: {}, error: null }),
      },
    },
  },
};

let fake: FakeDb;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

function useDatabase(products: Row[], failOn?: FailOn) {
  fake = createFakeDb(products, failOn);
  mocks.postgres.mockImplementation(() => fake.sql);
}

function reset() {
  return GET(new NextRequest(ROUTE_URL, { headers: { authorization: 'Bearer reset-cron-secret' } }));
}

function blocksOf(productId: string): Row[] {
  return fake.state.blocks
    .filter((block) => block['product_id'] === productId)
    .sort((a, b) => a['order'] - b['order'])
    .map((block) => block['content']);
}

function categoriesOf(productId: string): unknown[] {
  return fake.state.productCategories
    .filter((row) => row['product_id'] === productId)
    .map((row) => row['category_id']);
}

function updatedIds(): unknown[] {
  return fake.state.updates.map((update) => update.id);
}

/** The copy's sections as the route should write them for this product URL. */
function sectionsFor(copy: AffiliatesProductCopy, productUrl: string): Row[] {
  return JSON.parse(JSON.stringify(copy.sections).split(AFFILIATES_PRODUCT_URL_PLACEHOLDER).join(productUrl));
}

beforeEach(() => {
  mocks.registry.productId = '43273';
  mocks.registry.planId = '75655';
  mocks.registry.purchaseUrl = 'https://nextblock.dev';
  for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([82, 73, 70, 70]))));
  mocks.s3Send.mockReset().mockResolvedValue({});
  mocks.syncFreemiusProductsToSupabase.mockReset().mockResolvedValue({ success: true, count: 3 });
  mocks.activateSandboxPackage.mockReset().mockResolvedValue(undefined);
  mocks.seedSandboxAffiliateDemo.mockReset().mockResolvedValue({ handle: 'studio-nova', seeded: true });
  mocks.createClient.mockReset().mockReturnValue(SUPABASE_ADMIN);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  useDatabase([COMMERCE_EN, CORTEX_EN, AFFILIATES_EN]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sandbox reset: the Affiliates product', () => {
  it('dresses the synced product in English and French, its call to action on its own pages', async () => {
    const response = await reset();
    expect(response.status).toBe(200);

    const { en, fr } = AFFILIATES_PRODUCT_COPY;
    expect(fake.state.updates).toContainEqual({
      id: AFFILIATES_EN['id'],
      values: {
        title: en.title,
        short_description: en.short_description,
        meta_title: en.meta_title,
        meta_description: en.meta_description,
        description_json: null,
        product_type: 'digital',
        payment_provider: 'freemius',
      },
    });
    const enBlocks = blocksOf(AFFILIATES_EN['id']);
    expect(enBlocks).toEqual(sectionsFor(en, `/product/${SLUG}`));
    expect(finalButtonUrl(enBlocks)).toBe(`/product/${SLUG}`);

    const frProduct = fake.state.products.find((row) => row['slug'] === `${SLUG}-fr`) as Row;
    expect(frProduct).toMatchObject({
      sku: AFFILIATES_EN['sku'],
      title: fr.title,
      short_description: fr.short_description,
      meta_title: fr.meta_title,
      meta_description: fr.meta_description,
      language_id: FR_ID,
      translation_group_id: AFFILIATES_EN['translation_group_id'],
      freemius_product_id: '43273',
      freemius_plan_id: '75655',
      trial_period_days: 30,
      trial_requires_payment_method: false,
    });
    const frBlocks = blocksOf(frProduct['id']);
    expect(frBlocks).toEqual(sectionsFor(fr, `/product/${SLUG}-fr`));
    expect(finalButtonUrl(frBlocks)).toBe(`/product/${SLUG}-fr`);
    expect(JSON.stringify([enBlocks, frBlocks])).not.toContain(AFFILIATES_PRODUCT_URL_PLACEHOLDER);
    // The route rewrites a copy: the shared constant keeps its placeholder for the next reset.
    expect(JSON.stringify(AFFILIATES_PRODUCT_COPY).split(AFFILIATES_PRODUCT_URL_PLACEHOLDER)).toHaveLength(3);

    // The cover image is uploaded with the other seed assets, then attached to both rows.
    const uploadedKeys = mocks.s3Send.mock.calls.map(([command]) => command.input['Key']);
    expect(uploadedKeys).toContain('images/affiliates-square.webp');
    for (const productId of [AFFILIATES_EN['id'], frProduct['id']]) {
      expect(fake.state.productMedia).toContainEqual({
        product_id: productId,
        media_id: 'media:images/affiliates-square.webp',
        sort_order: 0,
      });
      expect(categoriesOf(productId)).toEqual(['category:software']);
    }

    // Commerce Pro and Cortex AI are still dressed, and the reset runs to its end.
    expect(blocksOf(COMMERCE_EN['id']).length).toBeGreaterThan(0);
    expect(blocksOf(CORTEX_EN['id']).length).toBeGreaterThan(0);
    expect(mocks.activateSandboxPackage.mock.calls.map((call) => call[1])).toEqual([
      'ecommerce',
      'cortex-ai',
      'affiliates',
    ]);
    expect(mocks.seedSandboxAffiliateDemo).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('sends the call to action to the nextblock.dev store page once purchase_url is one', async () => {
    mocks.registry.purchaseUrl = 'https://nextblock.dev/product/nextblock-affiliates-license';

    expect((await reset()).status).toBe(200);

    expect(finalButtonUrl(blocksOf(AFFILIATES_EN['id']))).toBe('https://nextblock.dev/product/nextblock-affiliates-license');
    const frProduct = fake.state.products.find((row) => row['slug'] === `${SLUG}-fr`) as Row;
    expect(finalButtonUrl(blocksOf(frProduct['id']))).toBe('https://nextblock.dev/product/nextblock-affiliates-license-fr');
  });

  it('drops the live-demo button while the sandbox runs no Affiliates key, and keeps the rest', async () => {
    vi.stubEnv('FREEMIUS_AFFILIATES_SANDBOX_KEY', '');

    expect((await reset()).status).toBe(200);

    const enBlocks = blocksOf(AFFILIATES_EN['id']);
    const frProduct = fake.state.products.find((row) => row['slug'] === `${SLUG}-fr`) as Row;
    const frBlocks = blocksOf(frProduct['id']);
    for (const url of AFFILIATES_DEMO_URLS) expect(JSON.stringify([enBlocks, frBlocks])).not.toContain(url);
    expect(enBlocks).toHaveLength(AFFILIATES_PRODUCT_COPY.en.sections.length);
    expect(finalButtonUrl(enBlocks)).toBe(`/product/${SLUG}`);
    expect(finalButtonUrl(frBlocks)).toBe(`/product/${SLUG}-fr`);
    expect(mocks.activateSandboxPackage.mock.calls.map((call) => call[1])).not.toContain('affiliates');
  });

  it('dresses the product without its cover when the image cannot be fetched, and the reset goes on', async () => {
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((done: () => void) => {
      done();
      return 0;
    }) as unknown as typeof setTimeout);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).endsWith('/images/affiliates-square.webp')
          ? new Response('missing', { status: 404 })
          : new Response(new Uint8Array([82, 73, 70, 70]))
      )
    );

    expect((await reset()).status).toBe(200);

    expect(mocks.s3Send.mock.calls.map(([command]) => command.input['Key'])).not.toContain('images/affiliates-square.webp');
    expect(blocksOf(AFFILIATES_EN['id'])).toEqual(sectionsFor(AFFILIATES_PRODUCT_COPY.en, `/product/${SLUG}`));
    expect(fake.state.productMedia.some((row) => row['media_id'] === 'media:images/affiliates-square.webp')).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      '[Sandbox Reset] Skipping optional seed asset images/affiliates-square.webp:',
      expect.stringContaining('Failed to fetch asset after 3 attempts')
    );
    expect(mocks.seedSandboxAffiliateDemo).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('prefers the registry plan when the sync brought several plans of the product', async () => {
    const strayPlan = syncedProduct('affiliates-stray-en', '43273', '75001', 'nextblock-affiliates-creator-storefronts-free');
    useDatabase([COMMERCE_EN, CORTEX_EN, strayPlan, AFFILIATES_EN]);

    expect((await reset()).status).toBe(200);

    expect(updatedIds()).toContain(AFFILIATES_EN['id']);
    expect(updatedIds()).not.toContain(strayPlan['id']);
    expect(fake.state.products.some((row) => row['slug'] === `${SLUG}-fr`)).toBe(true);
  });

  it('skips a product the Freemius sync did not bring, and the reset goes on', async () => {
    useDatabase([COMMERCE_EN, CORTEX_EN]);

    expect((await reset()).status).toBe(200);

    expect(warnSpy).toHaveBeenCalledWith(
      '[Sandbox Reset] Skipping the Affiliates product: product 43273 was not found after Freemius sync.'
    );
    expect(updatedIds()).toEqual([COMMERCE_EN['id'], CORTEX_EN['id']]);
    expect(fake.state.products.filter((row) => row['freemius_product_id'] === '43273')).toEqual([]);
    expect(fake.state.media.map((row) => row['object_key'])).not.toContain('images/affiliates-square.webp');
    expect(mocks.seedSandboxAffiliateDemo).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('skips the product while the registry has no Freemius id yet', async () => {
    mocks.registry.productId = '';
    mocks.registry.planId = '';

    expect((await reset()).status).toBe(200);

    expect(warnSpy).toHaveBeenCalledWith(
      '[Sandbox Reset] Skipping the Affiliates product: NEXTBLOCK_PACKAGES.affiliates has no Freemius product id.'
    );
    expect(fake.statements.some(({ text }) => text.includes('ORDER BY (freemius_plan_id'))).toBe(false);
    expect(blocksOf(AFFILIATES_EN['id'])).toEqual([]);
    const categoryLookup = fake.statements.find(({ text }) => text.includes('freemius_product_id = ANY($1)'));
    expect(categoryLookup?.params[0]).toEqual(['24851', '28609']);
    expect(mocks.seedSandboxAffiliateDemo).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs a failure, rolls the product back to its synced state and finishes the reset', async () => {
    useDatabase(
      [COMMERCE_EN, CORTEX_EN, AFFILIATES_EN],
      (text, params) => text.startsWith('INSERT INTO public.products ') && params.includes(`${SLUG}-fr`)
    );

    expect((await reset()).status).toBe(200);

    expect(errorSpy).toHaveBeenCalledWith('[Sandbox Reset] Affiliates product enrichment failed:', 'injected failure');
    expect(fake.transactions).toContain('ROLLBACK');
    expect(updatedIds()).not.toContain(AFFILIATES_EN['id']);
    expect(blocksOf(AFFILIATES_EN['id'])).toEqual([]);
    expect(fake.state.productMedia.some((row) => row['product_id'] === AFFILIATES_EN['id'])).toBe(false);
    expect(mocks.activateSandboxPackage.mock.calls.map((call) => call[1])).toContain('affiliates');
    expect(mocks.seedSandboxAffiliateDemo).toHaveBeenCalledTimes(1);
  });
});
