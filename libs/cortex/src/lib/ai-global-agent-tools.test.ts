import { describe, expect, it, vi } from 'vitest';

import { getCortexMcpToolAnnotations } from './mcp-tool-registry';

vi.mock('@nextblock-cms/utils', async () => {
  const { z } = await import('zod');

  return {
    editorBlockDocumentSchema: z.object({
      content: z.array(z.any()).optional(),
      type: z.literal('doc'),
    }),
    minorUnitAmountToMajor: (amount: number) => amount / 100,
  };
});

vi.mock('@nextblock-cms/ecommerce/product-schema', async () => {
  const { z } = await import('zod');
  const currencyPriceMapSchema = z.record(z.string(), z.coerce.number().min(0)).default({});
  const currencySalePriceMapSchema = z
    .record(z.string(), z.coerce.number().min(0).nullable())
    .default({});

  return {
    productSchema: z
      .object({
        description_json: z.any().optional(),
        freemius_plan_id: z.string().optional(),
        freemius_product_id: z.string().optional(),
        is_taxable: z.boolean(),
        language_id: z.coerce.number().int().min(1),
        meta_description: z.string().optional().nullable(),
        meta_title: z.string().optional().nullable(),
        payment_provider: z.enum(['stripe', 'freemius']),
        price: z.coerce.number().min(0),
        prices: currencyPriceMapSchema,
        product_media: z.array(z.object({ media_id: z.string() })).optional(),
        product_type: z.enum(['physical', 'digital']),
        sale_price: z.coerce.number().min(0).optional().nullable(),
        sale_prices: currencySalePriceMapSchema,
        short_description: z.string().optional(),
        sku: z.string().min(1),
        slug: z.string().min(1),
        status: z.enum(['draft', 'active', 'archived']),
        stock: z.coerce.number().int().min(0),
        title: z.string().min(1),
        upc: z.string().optional().nullable(),
        variation_attributes: z.array(z.any()).optional(),
        variants: z.array(z.any()).optional(),
      })
      .refine(
        (product) =>
          product.sale_price === null ||
          product.sale_price === undefined ||
          product.sale_price <= product.price,
        { path: ['sale_price'] }
      ),
  };
});

vi.mock('@nextblock-cms/ecommerce/product-actions', async () => {
  const { z } = await import('zod');
  const currencyPriceMapSchema = z.record(z.string(), z.coerce.number().min(0)).default({});
  const currencySalePriceMapSchema = z
    .record(z.string(), z.coerce.number().min(0).nullable())
    .default({});
  const productSchema = z
    .object({
      description_json: z.any().optional(),
      freemius_plan_id: z.string().optional(),
      freemius_product_id: z.string().optional(),
      is_taxable: z.boolean(),
      language_id: z.coerce.number().int().min(1),
      meta_description: z.string().optional().nullable(),
      meta_title: z.string().optional().nullable(),
      payment_provider: z.enum(['stripe', 'freemius']),
      price: z.coerce.number().min(0),
      prices: currencyPriceMapSchema,
      product_media: z.array(z.object({ media_id: z.string() })).optional(),
      product_type: z.enum(['physical', 'digital']),
      sale_price: z.coerce.number().min(0).optional().nullable(),
      sale_prices: currencySalePriceMapSchema,
      short_description: z.string().optional(),
      sku: z.string().min(1),
      slug: z.string().min(1),
      status: z.enum(['draft', 'active', 'archived']),
      stock: z.coerce.number().int().min(0),
      title: z.string().min(1),
      upc: z.string().optional().nullable(),
      variation_attributes: z.array(z.any()).optional(),
      variants: z.array(z.any()).optional(),
    })
    .refine(
      (product) =>
        product.sale_price === null ||
        product.sale_price === undefined ||
        product.sale_price <= product.price,
      { path: ['sale_price'] }
    );

  return {
    createProduct: async (supabase: any, input: Record<string, any>) => {
      const { data } = await supabase
        .from('products')
        .insert({
          ...input,
          price: Math.round(Number(input.price || 0) * 100),
          sale_price:
            input.sale_price === null || input.sale_price === undefined
              ? null
              : Math.round(Number(input.sale_price) * 100),
        })
        .select('*');

      return data?.[0] ?? null;
    },
    productSchema,
    updateProduct: async (supabase: any, id: string, input: Record<string, any>) => {
      const { data } = await supabase
        .from('products')
        .update({
          ...input,
          price: Math.round(Number(input.price || 0) * 100),
          sale_price:
            input.sale_price === null || input.sale_price === undefined
              ? null
              : Math.round(Number(input.sale_price) * 100),
        })
        .eq('id', id)
        .select('*')
        .single();

      return data;
    },
  };
});

import {
  buildVisibleContactIntroActionPlan,
  executeCmsActionPlan,
  executeCreateCmsPage,
  executeCreateCmsPost,
  executeCreateCmsProduct,
  executeDeleteCmsItem,
  executeFetchUrlContent,
  executeInsertContentBlock,
  executePrepareDeleteCmsItem,
  executeReadCurrentCmsItem,
  executeRewritePageDraft,
  executeSearchStockPhotos,
  executeSetContentImages,
  executeTranslatePage,
  executeSearchDocumentation,
  executeSearchDocumentationWithTimeout,
  executeUpdateContentBlock,
  executeUpdateCmsItemField,
  executeUpdateCurrentCmsFields,
  executeUpdateFooter,
  executeUpdateNavigationBar,
  executeUpdateSectionColumnBlock,
} from './ai-global-agent-tools';

type MockRow = Record<string, any>;

type MockDatabase = {
  blocks: MockRow[];
  content_drafts: MockRow[];
  currencies: MockRow[];
  custom_block_definitions: MockRow[];
  languages: MockRow[];
  navigation_items: MockRow[];
  pages: MockRow[];
  posts: MockRow[];
  product_drafts: MockRow[];
  product_media: MockRow[];
  product_variants: MockRow[];
  products: MockRow[];
  site_settings: MockRow[];
};

class MockQuery {
  private filters: Array<{ column: string; value: unknown }> = [];
  private limitCount: number | null = null;
  private operation: 'delete' | 'insert' | 'select' | 'update' | 'upsert' = 'select';
  private payload: MockRow | MockRow[] | null = null;

  constructor(
    private readonly database: MockDatabase,
    private readonly calls: MockRow[],
    private readonly table: keyof MockDatabase
  ) {}

  select(columns?: string) {
    this.calls.push({ columns, operation: 'select', table: this.table });
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push({ column, value });
    return this;
  }

  limit(count: number) {
    this.limitCount = count;
    return this;
  }

  delete() {
    this.operation = 'delete';
    this.calls.push({ operation: 'delete', table: this.table });
    return this;
  }

  insert(payload: MockRow | MockRow[]) {
    this.operation = 'insert';
    this.payload = payload;
    this.calls.push({ operation: 'insert', payload, table: this.table });
    return this;
  }

  update(payload: MockRow) {
    this.operation = 'update';
    this.payload = payload;
    this.calls.push({ operation: 'update', payload, table: this.table });
    return this;
  }

  upsert(payload: MockRow | MockRow[]) {
    this.operation = 'upsert';
    this.payload = payload;
    this.calls.push({ operation: 'upsert', payload, table: this.table });
    return this;
  }

  order() {
    return this;
  }

  maybeSingle() {
    return this.execute().then((result) => ({
      data: result.data?.[0] ?? null,
      error: result.error,
    }));
  }

  single() {
    return this.execute().then((result) => ({
      data: Array.isArray(result.data) ? result.data[0] : result.data,
      error: result.error,
    }));
  }

  then<TResult1 = any, TResult2 = never>(
    onfulfilled?: ((value: any) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ) {
    return this.execute().then(onfulfilled, onrejected);
  }

  private matchesFilters(row: MockRow) {
    return this.filters.every((filter) => row[filter.column] === filter.value);
  }

  private async execute() {
    if (this.operation === 'delete') {
      const beforeCount = this.database[this.table].length;
      this.database[this.table] = this.database[this.table].filter(
        (row) => !this.matchesFilters(row)
      );

      return {
        data: null,
        error: null,
        removed: beforeCount - this.database[this.table].length,
      };
    }

    if (this.operation === 'insert') {
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload];
      const inserted = rows.filter(Boolean).map((row) => {
        const nextId =
          this.database[this.table].reduce((max, current) => Math.max(max, Number(current.id) || 0), 0) +
          1;
        return { id: nextId, ...row };
      });

      this.database[this.table].push(...inserted);

      return {
        data: inserted,
        error: null,
      };
    }

    if (this.operation === 'update') {
      const payload = Array.isArray(this.payload) ? this.payload[0] : this.payload;
      const updated: MockRow[] = [];

      this.database[this.table] = this.database[this.table].map((row) => {
        if (!this.matchesFilters(row)) {
          return row;
        }

        const nextRow = { ...row, ...payload };
        updated.push(nextRow);
        return nextRow;
      });

      return {
        data: updated,
        error: null,
      };
    }

    if (this.operation === 'upsert') {
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload];

      for (const row of rows.filter(Boolean)) {
        const existingIndex = this.database[this.table].findIndex(
          (current) => current.key && current.key === row.key
        );

        if (existingIndex >= 0) {
          this.database[this.table][existingIndex] = {
            ...this.database[this.table][existingIndex],
            ...row,
          };
        } else {
          this.database[this.table].push(row);
        }
      }

      return {
        data: rows,
        error: null,
      };
    }

    let data = this.database[this.table].filter((row) => this.matchesFilters(row));

    if (this.limitCount !== null) {
      data = data.slice(0, this.limitCount);
    }

    return {
      data,
      error: null,
    };
  }
}

function createMockSupabase(overrides?: Partial<MockDatabase>) {
  const calls: MockRow[] = [];
  const database: MockDatabase = {
    blocks: [],
    content_drafts: [],
    currencies: [{ code: 'USD', id: 1, is_active: true, is_default: true }],
    custom_block_definitions: [],
    languages: [{ code: 'en', id: 1 }],
    navigation_items: [
      { id: 1, label: 'Old', language_id: 1, menu_key: 'HEADER', order: 0, url: '/old' },
    ],
    pages: [],
    posts: [],
    product_drafts: [],
    product_media: [],
    product_variants: [],
    products: [],
    site_settings: [],
    ...overrides,
  };

  return {
    calls,
    database,
    supabase: {
      from: (table: string) => {
        if (!(table in database)) {
          throw new Error(`Unexpected mock table: ${table}`);
        }

        return new MockQuery(database, calls, table as keyof MockDatabase);
      },
    },
  };
}

// The tool executors return an inferred union (confirmation preview | executed |
// failure). Callers that read preview-only fields after asserting can use the
// returned value, which intersects the original type with the confirmation shape
// (so no existing field is lost). The runtime expect() checks still validate it.
function expectConfirmation<T>(
  result: T
): T & {
  confirmationPhrase: string;
  message?: string;
  preview: Record<string, unknown>;
  requiresConfirmation: boolean;
} {
  expect(result).toMatchObject({
    mutationExecuted: false,
    requiresConfirmation: true,
    success: true,
  });
  expect((result as { confirmationPhrase?: unknown }).confirmationPhrase).toEqual(
    expect.stringMatching(/^CONFIRM .+ #[a-f0-9]{8}$/)
  );
  return result as T & {
    confirmationPhrase: string;
    message?: string;
    preview: Record<string, unknown>;
    requiresConfirmation: boolean;
  };
}

async function executeConfirmed(
  executor: (input: any, context?: any) => Promise<any>,
  input: any,
  context: any = {}
) {
  const preview = await executor(input, context);
  expectConfirmation(preview);

  return executor(input, {
    ...context,
    latestUserMessage: preview.confirmationPhrase,
  });
}

describe('Cortex AI global agent tool executors', () => {
  it('replaces the header navigation menu for the selected locale', async () => {
    const revalidated: string[] = [];
    const { database, supabase } = createMockSupabase();

    const result = await executeConfirmed(
      executeUpdateNavigationBar,
      {
        items: [
          {
            children: [{ label: 'Team', url: '/about/team' }],
            label: 'About',
            url: '/about',
          },
          { label: 'Contact', target: '_self', url: '/contact' },
        ],
        languageCode: 'en',
        mode: 'replace',
      },
      {
        revalidatePath: (path: string) => revalidated.push(path),
        supabase,
      }
    );

    expect(result).toEqual({
      insertedCount: 3,
      languageCode: 'en',
      menuKey: 'HEADER',
      mode: 'replace',
      skippedCount: 0,
      mutationExecuted: true,
      success: true,
      updatedCount: 0,
    });
    expect(database.navigation_items).toEqual([
      {
        id: 1,
        label: 'About',
        language_id: 1,
        menu_key: 'HEADER',
        order: 0,
        page_id: null,
        parent_id: null,
        url: '/about',
      },
      {
        id: 2,
        label: 'Team',
        language_id: 1,
        menu_key: 'HEADER',
        order: 0,
        page_id: null,
        parent_id: 1,
        url: '/about/team',
      },
      {
        id: 3,
        label: 'Contact',
        language_id: 1,
        menu_key: 'HEADER',
        order: 1,
        page_id: null,
        parent_id: null,
        url: '/contact',
      },
    ]);
    expect(revalidated).toEqual(['/', '/cms/navigation']);
  });

  it('appends header navigation items without clearing existing links', async () => {
    const { database, supabase } = createMockSupabase({
      navigation_items: [
        { id: 1, label: 'Home', language_id: 1, menu_key: 'HEADER', order: 0, url: '/' },
        { id: 2, label: 'Articles', language_id: 1, menu_key: 'HEADER', order: 1, url: '/articles' },
      ],
    });

    const result = await executeConfirmed(
      executeUpdateNavigationBar,
      {
        items: [{ label: 'Contact', url: '/contact' }],
        languageCode: 'en',
        mode: 'append',
      },
      { revalidatePath: () => undefined, supabase }
    );

    expect(result).toEqual({
      insertedCount: 1,
      languageCode: 'en',
      menuKey: 'HEADER',
      mode: 'append',
      mutationExecuted: true,
      skippedCount: 0,
      success: true,
      updatedCount: 0,
    });
    expect(database.navigation_items).toEqual([
      { id: 1, label: 'Home', language_id: 1, menu_key: 'HEADER', order: 0, url: '/' },
      { id: 2, label: 'Articles', language_id: 1, menu_key: 'HEADER', order: 1, url: '/articles' },
      {
        id: 3,
        label: 'Contact',
        language_id: 1,
        menu_key: 'HEADER',
        order: 2,
        page_id: null,
        parent_id: null,
        url: '/contact',
      },
    ]);
  });

  it('resolves language names when appending header navigation items', async () => {
    const { database, supabase } = createMockSupabase({
      languages: [
        { code: 'en', id: 1, is_active: true, name: 'English' },
        { code: 'fr', id: 2, is_active: true, name: 'French' },
      ],
      navigation_items: [
        { id: 1, label: 'Home', language_id: 1, menu_key: 'HEADER', order: 0, url: '/' },
        { id: 2, label: 'Accueil', language_id: 2, menu_key: 'HEADER', order: 0, url: '/' },
      ],
    });

    const result = await executeConfirmed(
      executeUpdateNavigationBar,
      {
        items: [{ label: 'Contact', target: '_self', url: 'mailto:info@nextblock.dev' }],
        languageCode: 'French',
        mode: 'append',
      },
      { revalidatePath: () => undefined, supabase }
    );

    expect(result).toEqual({
      insertedCount: 1,
      languageCode: 'fr',
      menuKey: 'HEADER',
      mode: 'append',
      mutationExecuted: true,
      skippedCount: 0,
      success: true,
      updatedCount: 0,
    });
    expect(database.navigation_items).toContainEqual({
      id: 3,
      label: 'Contact',
      language_id: 2,
      menu_key: 'HEADER',
      order: 1,
      page_id: null,
      parent_id: null,
      url: 'mailto:info@nextblock.dev',
    });
  });

  it('links AI-created translated navigation items to page and nav translation groups', async () => {
    const { database, supabase } = createMockSupabase({
      languages: [
        { code: 'en', id: 1, is_active: true, name: 'English' },
        { code: 'fr', id: 2, is_active: true, name: 'French' },
      ],
      navigation_items: [
        {
          id: 1,
          label: 'Contact Us',
          language_id: 1,
          menu_key: 'HEADER',
          order: 0,
          page_id: 1,
          translation_group_id: 'group-nav-contact',
          url: '/contact-us',
        },
      ],
      pages: [
        {
          id: 1,
          language_id: 1,
          slug: 'contact-us',
          title: 'Contact Us',
          translation_group_id: 'group-page-contact',
        },
        {
          id: 2,
          language_id: 2,
          slug: 'contactez-nous',
          title: 'Contactez-nous',
          translation_group_id: 'group-page-contact',
        },
      ],
    });

    const result = await executeConfirmed(
      executeUpdateNavigationBar,
      {
        items: [{ label: 'Contactez-nous', url: '/contactez-nous' }],
        languageCode: 'French',
        mode: 'append',
      },
      { revalidatePath: () => undefined, supabase }
    );

    expect(result).toMatchObject({
      insertedCount: 1,
      languageCode: 'fr',
      mutationExecuted: true,
      success: true,
    });
    expect(database.navigation_items[1]).toMatchObject({
      label: 'Contactez-nous',
      language_id: 2,
      menu_key: 'HEADER',
      page_id: 2,
      translation_group_id: 'group-nav-contact',
      url: '/contactez-nous',
    });
  });

  it('updates a single existing header navigation item without replacing the menu', async () => {
    const { database, supabase } = createMockSupabase({
      languages: [
        { code: 'en', id: 1, is_active: true, name: 'English' },
        { code: 'fr', id: 2, is_active: true, name: 'French' },
      ],
      navigation_items: [
        { id: 1, label: 'Accueil', language_id: 2, menu_key: 'HEADER', order: 0, url: '/' },
        {
          id: 2,
          label: 'Contact',
          language_id: 2,
          menu_key: 'HEADER',
          order: 1,
          url: 'mailto:info@nextblock.dev',
        },
        { id: 3, label: 'Articles', language_id: 2, menu_key: 'HEADER', order: 2, url: '/articles' },
      ],
    });

    const result = await executeConfirmed(
      executeUpdateNavigationBar,
      {
        items: [
          {
            label: 'Nous Contacter',
            target: '_self',
            url: 'mailto:info@nextblock.dev',
          },
        ],
        languageCode: 'French',
        match: { label: 'Contact' },
        mode: 'update',
      },
      { revalidatePath: () => undefined, supabase }
    );

    expect(result).toEqual({
      insertedCount: 0,
      languageCode: 'fr',
      menuKey: 'HEADER',
      mode: 'update',
      mutationExecuted: true,
      skippedCount: 0,
      success: true,
      updatedCount: 1,
    });
    expect(database.navigation_items).toEqual([
      { id: 1, label: 'Accueil', language_id: 2, menu_key: 'HEADER', order: 0, url: '/' },
      {
        id: 2,
        label: 'Nous Contacter',
        language_id: 2,
        menu_key: 'HEADER',
        order: 1,
        url: 'mailto:info@nextblock.dev',
      },
      { id: 3, label: 'Articles', language_id: 2, menu_key: 'HEADER', order: 2, url: '/articles' },
    ]);
  });

  it('refuses destructive partial header navigation replacements', async () => {
    const { database, supabase } = createMockSupabase({
      navigation_items: [
        { id: 1, label: 'Home', language_id: 1, menu_key: 'HEADER', order: 0, url: '/' },
        { id: 2, label: 'Articles', language_id: 1, menu_key: 'HEADER', order: 1, url: '/articles' },
        {
          id: 3,
          label: 'Contact',
          language_id: 1,
          menu_key: 'HEADER',
          order: 2,
          url: 'mailto:info@nextblock.dev',
        },
      ],
    });

    await expect(
      executeUpdateNavigationBar(
        {
          items: [{ label: 'Nous Contacter', url: 'mailto:info@nextblock.dev' }],
          languageCode: 'en',
          mode: 'replace',
        },
        { revalidatePath: () => undefined, supabase }
      )
    ).rejects.toThrow('Refusing destructive HEADER navigation replacement');

    expect(database.navigation_items).toEqual([
      { id: 1, label: 'Home', language_id: 1, menu_key: 'HEADER', order: 0, url: '/' },
      { id: 2, label: 'Articles', language_id: 1, menu_key: 'HEADER', order: 1, url: '/articles' },
      {
        id: 3,
        label: 'Contact',
        language_id: 1,
        menu_key: 'HEADER',
        order: 2,
        url: 'mailto:info@nextblock.dev',
      },
    ]);
  });

  it('skips duplicate header navigation append requests by URL', async () => {
    const { database, supabase } = createMockSupabase({
      navigation_items: [
        { id: 1, label: 'Home', language_id: 1, menu_key: 'HEADER', order: 0, url: '/' },
        {
          id: 2,
          label: 'Contact',
          language_id: 1,
          menu_key: 'HEADER',
          order: 1,
          url: 'mailto:info@nextblock.dev',
        },
      ],
    });

    const result = await executeConfirmed(
      executeUpdateNavigationBar,
      {
        items: [{ label: 'Contact', target: '_self', url: 'mailto:info@nextblock.dev' }],
        languageCode: 'en',
        mode: 'append',
      },
      { revalidatePath: () => undefined, supabase }
    );

    expect(result).toEqual({
      insertedCount: 0,
      languageCode: 'en',
      menuKey: 'HEADER',
      mode: 'append',
      mutationExecuted: true,
      skippedCount: 1,
      success: true,
      updatedCount: 0,
    });
    expect(database.navigation_items).toEqual([
      { id: 1, label: 'Home', language_id: 1, menu_key: 'HEADER', order: 0, url: '/' },
      {
        id: 2,
        label: 'Contact',
        language_id: 1,
        menu_key: 'HEADER',
        order: 1,
        url: 'mailto:info@nextblock.dev',
      },
    ]);
  });

  it('updates footer links and copyright settings', async () => {
    const { database, supabase } = createMockSupabase({
      navigation_items: [
        { id: 10, label: 'Old Footer', language_id: 1, menu_key: 'FOOTER', order: 0, url: '/old' },
      ],
      site_settings: [{ key: 'footer_copyright', value: { en: 'Old' } }],
    });

    const result = await executeConfirmed(
      executeUpdateFooter,
      {
        copyright: { en: '(c) {year} NextBlock. All rights reserved.' },
        languageCode: 'en',
        links: [{ label: 'Privacy', url: '/privacy' }],
      },
      { revalidatePath: () => undefined, supabase }
    );

    expect(result).toMatchObject({
      copyrightUpdated: true,
      footerNavigation: {
        insertedCount: 1,
        languageCode: 'en',
        menuKey: 'FOOTER',
      },
      mutationExecuted: true,
      success: true,
    });
    expect(database.navigation_items).toEqual([
      {
        id: 1,
        label: 'Privacy',
        language_id: 1,
        menu_key: 'FOOTER',
        order: 0,
        page_id: null,
        parent_id: null,
        url: '/privacy',
      },
    ]);
    expect(database.site_settings).toEqual([
      {
        key: 'footer_copyright',
        value: { en: '(c) {year} NextBlock. All rights reserved.' },
      },
    ]);
  });

  it('searches published documentation-like pages and posts', async () => {
    const { supabase } = createMockSupabase({
      pages: [
        {
          id: 1,
          meta_description: 'CMS setup, editor blocks, and Supabase auth.',
          slug: 'docs/setup',
          status: 'published',
          title: 'Setup Guide',
        },
      ],
      posts: [
        {
          excerpt: 'Use Supabase auth with profiles and roles in NextBlock.',
          id: 1,
          meta_description: null,
          slug: 'supabase-auth-guide',
          status: 'published',
          subtitle: null,
          title: 'Supabase Auth Guide',
        },
        {
          excerpt: 'Draft content should not be returned.',
          id: 2,
          slug: 'draft',
          status: 'draft',
          title: 'Draft',
        },
      ],
    });

    const result = await executeSearchDocumentation(
      { limit: 2, query: 'Supabase auth' },
      { supabase }
    );

    expect(result).toEqual({
      query: 'Supabase auth',
      results: [
        {
          excerpt: 'Use Supabase auth with profiles and roles in NextBlock.',
          source: 'post',
          title: 'Supabase Auth Guide',
          url: '/article/supabase-auth-guide',
        },
        {
          excerpt: 'CMS setup, editor blocks, and Supabase auth.',
          source: 'page',
          title: 'Setup Guide',
          url: '/docs/setup',
        },
      ],
      success: true,
    });
  });

  it('returns a fallback instead of hanging when documentation search is slow', async () => {
    const createHangingQuery = () =>
      ({
        eq() {
          return this;
        },
        limit() {
          return new Promise(() => undefined);
        },
        select() {
          return this;
        },
      }) as any;

    const result = await executeSearchDocumentationWithTimeout(
      { limit: 2, query: 'NextBlock project' },
      {
        supabase: {
          from: () => createHangingQuery(),
        },
      },
      5
    );

    expect(result).toMatchObject({
      query: 'NextBlock project',
      results: [],
      success: false,
      timedOut: true,
    });
  });

  it('reads the current page context with block summaries', async () => {
    const { supabase } = createMockSupabase({
      blocks: [
        {
          block_type: 'text',
          content: { html_content: '<p>Hello</p>' },
          id: 11,
          language_id: 1,
          order: 2,
          page_id: 7,
          post_id: null,
        },
        {
          block_type: 'heading',
          content: { level: 2, text_content: 'Intro' },
          id: 10,
          language_id: 1,
          order: 1,
          page_id: 7,
          post_id: null,
        },
      ],
      pages: [
        {
          id: 7,
          language_id: 1,
          meta_description: null,
          slug: 'home',
          status: 'published',
          title: 'Home',
        },
      ],
    });

    const result = await executeReadCurrentCmsItem(
      { includeBlockContent: false, includeBlocks: true },
      {
        pageContext: { contentType: 'page', entityId: 7, slug: 'home', title: 'Home' },
        supabase,
      }
    );

    expect(result.success).toBe(true);
    expect(result.item.title).toBe('Home');
    expect(result.blocks).toEqual([
      {
        blockType: 'heading',
        content: undefined,
        id: 10,
        languageId: 1,
        order: 1,
        pageId: 7,
        postId: null,
      },
      {
        blockType: 'text',
        content: undefined,
        id: 11,
        languageId: 1,
        order: 2,
        pageId: 7,
        postId: null,
      },
    ]);
  });

  it('updates validated product fields including description_json', async () => {
    const revalidated: string[] = [];
    const { database, supabase } = createMockSupabase({
      products: [
        {
          description_json: null,
          id: 'prod_1',
          language_id: 1,
          meta_description: null,
          meta_title: null,
          short_description: 'Old short copy',
          slug: 'studio-tee',
          status: 'draft',
          title: 'Studio Tee',
        },
      ],
    });
    const descriptionJson = {
      content: [
        {
          content: [{ text: 'NextBlock tee description.', type: 'text' }],
          type: 'paragraph',
        },
      ],
      type: 'doc',
    };

    const result = await executeConfirmed(
      executeUpdateCurrentCmsFields,
      {
        fields: {
          description_json: descriptionJson,
          short_description: 'Soft cotton tee for builders.',
          status: 'active',
        },
      },
      {
        pageContext: {
          contentType: 'product',
          entityId: 'prod_1',
          slug: 'studio-tee',
          title: 'Studio Tee',
        },
        revalidatePath: (path: string) => revalidated.push(path),
        supabase,
      }
    );

    expect(result).toMatchObject({
      contentType: 'product',
      entityId: 'prod_1',
      mutationExecuted: true,
      slug: 'studio-tee',
      success: true,
      updatedFields: ['description_json', 'short_description', 'status'],
    });
    expect(database.products[0]).toMatchObject({
      description_json: descriptionJson,
      short_description: 'Soft cotton tee for builders.',
      status: 'active',
    });
    expect(revalidated).toEqual([
      '/cms/products/prod_1/edit',
      '/product/studio-tee',
      '/cms/products',
    ]);
  });

  it('updates only blocks that belong to the current page context', async () => {
    const { database, supabase } = createMockSupabase({
      blocks: [
        {
          block_type: 'text',
          content: { html_content: '<p>Old</p>' },
          id: 12,
          language_id: 1,
          order: 0,
          page_id: 7,
          post_id: null,
        },
      ],
    });

    await expect(
      executeUpdateContentBlock(
        {
          blockId: 12,
          blockType: 'text',
          content: { html_content: '<p>Wrong page</p>' },
        },
        {
          pageContext: { contentType: 'page', entityId: 8 },
          supabase,
        }
      )
    ).rejects.toThrow('does not belong to the current page');

    const result = await executeConfirmed(
      executeUpdateContentBlock,
      {
        blockId: 12,
        blockType: 'text',
        content: { html_content: '<p>Updated</p>' },
      },
      {
        pageContext: { contentType: 'page', entityId: 7, slug: 'docs/setup' },
        revalidatePath: () => undefined,
        supabase,
      }
    );

    expect(result).toMatchObject({
      blockId: 12,
      blockType: 'text',
      contentUpdated: true,
      mutationExecuted: true,
      success: true,
    });
    expect(database.blocks[0].content).toEqual({ html_content: '<p>Updated</p>' });
  });

  it('inserts a visible rich text block before the form on a page', async () => {
    const { database, supabase } = createMockSupabase({
      blocks: [
        {
          block_type: 'form',
          content: {
            fields: [],
            recipient_email: 'info@nextblock.dev',
            submit_button_text: 'Send Message',
            success_message: 'Thanks',
          },
          id: 12,
          language_id: 1,
          order: 0,
          page_id: 7,
          post_id: null,
        },
      ],
      pages: [
        {
          id: 7,
          language_id: 1,
          slug: 'contact-us',
          title: 'Contact Us',
          translation_group_id: 'group-contact',
        },
      ],
    });

    const result = await executeConfirmed(
      executeInsertContentBlock,
      {
        anchorBlockType: 'form',
        block: {
          blockType: 'text',
          content: {
            html_content:
              '<h2>Let us help you move faster</h2><p>Tell us what you are building and the NextBlock team will get back to you.</p>',
          },
        },
        contentType: 'page',
        slug: 'contact-us',
        position: 'before',
      },
      { revalidatePath: () => undefined, supabase }
    );

    expect(result).toMatchObject({
      blockType: 'text',
      contentType: 'page',
      entityId: 7,
      mutationExecuted: true,
      order: 0,
      success: true,
    });
    expect(database.blocks).toHaveLength(2);
    expect(database.blocks[0]).toMatchObject({
      block_type: 'form',
      order: 1,
    });
    expect(database.blocks[1]).toMatchObject({
      block_type: 'text',
      order: 0,
      page_id: 7,
    });
    expect(database.blocks[1].content.html_content).toContain('Let us help you move faster');
  });

  it('normalizes a minimal section block into a valid, well-styled section on insert', async () => {
    const { database, supabase } = createMockSupabase({
      blocks: [],
      pages: [
        {
          id: 7,
          language_id: 1,
          slug: 'home',
          title: 'Home',
          translation_group_id: 'group-home',
        },
      ],
    });

    const result = await executeConfirmed(
      executeInsertContentBlock,
      {
        block: {
          blockType: 'section',
          content: {
            // Only intent + content supplied; the server fills the rest.
            background: { type: 'gradient' },
            column_blocks: [
              [
                { block_type: 'heading', content: { level: 1, text_content: 'Welcome' } },
                { block_type: 'text', content: { html_content: '<p>Intro copy</p>' } },
              ],
              [{ block_type: 'heading', content: { level: 3, text_content: 'Feature A' } }],
              [{ block_type: 'heading', content: { level: 3, text_content: 'Feature B' } }],
            ],
            is_hero: true,
            // Intentionally mismatched: 3 columns provided but desktop says 1.
            responsive_columns: { desktop: 1, mobile: 1, tablet: 1 },
          },
        },
        contentType: 'page',
        position: 'end',
        slug: 'home',
      },
      { revalidatePath: () => undefined, supabase }
    );

    expect(result).toMatchObject({
      blockType: 'section',
      contentType: 'page',
      entityId: 7,
      mutationExecuted: true,
      success: true,
    });

    expect(database.blocks).toHaveLength(1);
    const section = database.blocks[0].content as Record<string, any>;

    // Grid column count is synced to the number of columns actually provided.
    expect(section.responsive_columns.desktop).toBe(3);
    // Every required layout field is filled with sensible defaults.
    expect(section.container_type).toBe('container');
    expect(section.column_gap).toBe('lg');
    expect(section.padding).toMatchObject({ bottom: 'xl', top: 'xl' });
    expect(section.vertical_alignment).toBe('center');
    // A bare gradient intent is completed with real color stops.
    expect(section.background.type).toBe('gradient');
    expect(section.background.gradient.stops.length).toBeGreaterThanOrEqual(2);
    // Nested blocks are preserved and normalized.
    expect(section.column_blocks).toHaveLength(3);
    expect(section.column_blocks[0][0]).toMatchObject({ block_type: 'heading' });
    expect(section.column_blocks[0][0].content.text_content).toBe('Welcome');
    expect(section.column_blocks[0][1].content.html_content).toContain('Intro copy');
  });

  it('rewrite_page_draft stages a normalized Live Draft without touching live blocks', async () => {
    const { database, supabase } = createMockSupabase({
      blocks: [
        {
          block_type: 'text',
          content: { html_content: '<p>Old home</p>' },
          id: 99,
          language_id: 1,
          order: 0,
          page_id: 7,
          post_id: null,
        },
      ],
      content_drafts: [],
      pages: [
        {
          id: 7,
          language_id: 1,
          meta_description: 'Welcome',
          meta_title: 'Home',
          slug: 'home',
          status: 'published',
          title: 'Home',
          translation_group_id: 'group-home',
          version: 3,
        },
      ],
    });

    const result = await executeConfirmed(
      executeRewritePageDraft,
      {
        blocks: [
          {
            blockType: 'section',
            content: {
              background: { type: 'gradient' },
              column_blocks: [
                [
                  { block_type: 'heading', content: { level: 1, text_content: 'Fresh Hero' } },
                  { block_type: 'text', content: { html_content: '<p>New intro</p>' } },
                ],
              ],
              is_hero: true,
            },
          },
          {
            blockType: 'section',
            content: {
              background: { theme: 'muted', type: 'theme' },
              column_blocks: [
                [{ block_type: 'heading', content: { level: 3, text_content: 'Feature A' } }],
                [{ block_type: 'heading', content: { level: 3, text_content: 'Feature B' } }],
                [{ block_type: 'heading', content: { level: 3, text_content: 'Feature C' } }],
              ],
            },
          },
        ],
        contentType: 'page',
        slug: 'home',
      },
      { actorUserId: 'admin-1', revalidatePath: () => undefined, supabase }
    );

    expect(result).toMatchObject({
      blockCount: 2,
      contentType: 'page',
      draftPreviewPath: '/api/draft/start?path=%2F',
      editPath: '/cms/pages/7/edit',
      entityId: 7,
      isDraft: true,
      mutationExecuted: true,
      slug: 'home',
      success: true,
    });

    // The live page blocks are untouched — the rewrite only stages a draft.
    expect(database.blocks).toHaveLength(1);
    expect(database.blocks[0].content.html_content).toContain('Old home');

    // Exactly one content_drafts row was staged, carrying over existing meta.
    expect(database.content_drafts).toHaveLength(1);
    const draft = database.content_drafts[0];
    expect(draft).toMatchObject({
      author_id: 'admin-1',
      base_version: 3,
      parent_id: 7,
      parent_type: 'page',
    });
    expect(draft.meta).toMatchObject({ status: 'published', title: 'Home' });
    expect(draft.blocks).toHaveLength(2);
    expect(draft.blocks[0]).toMatchObject({
      block_type: 'section',
      language_id: 1,
      order: 0,
      page_id: 7,
      post_id: null,
    });
    // Hero normalized to a single column; feature section to three columns.
    expect(draft.blocks[0].content.responsive_columns.desktop).toBe(1);
    expect(draft.blocks[0].content.background.type).toBe('gradient');
    expect(draft.blocks[1].content.responsive_columns.desktop).toBe(3);
  });

  it('fetch_url_content refuses local, private, and metadata addresses', async () => {
    const localhost = await executeFetchUrlContent({ url: 'http://localhost:3000/admin' });
    expect(localhost).toMatchObject({ success: false });
    expect(String((localhost as { message?: string }).message).toLowerCase()).toContain('local');

    const metadata = await executeFetchUrlContent({ url: 'http://169.254.169.254/latest/meta-data' });
    expect(metadata).toMatchObject({ success: false });

    const privateIp = await executeFetchUrlContent({ url: 'http://10.0.0.5/' });
    expect(privateIp).toMatchObject({ success: false });
  });

  it('fetch_url_content extracts readable content from an HTML page', async () => {
    const html =
      '<html><head><title>Acme Co</title><meta name="description" content="We craft fine widgets"></head><body><h1>Welcome to Acme</h1><p>We build the best widgets in town.</p><script>trackingCall()</script></body></html>';

    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' }, status: 200 })
    );

    try {
      const result = (await executeFetchUrlContent({ url: 'https://acme.example.com' })) as {
        success: boolean;
        title: string;
        description: string;
        headings: string[];
        text: string;
      };

      expect(result.success).toBe(true);
      expect(result.title).toBe('Acme Co');
      expect(result.description).toBe('We craft fine widgets');
      expect(result.headings).toContain('Welcome to Acme');
      expect(result.text).toContain('best widgets');
      expect(result.text).not.toContain('trackingCall');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fetch_url_content prefers the schema.org Product image as mainImage', async () => {
    const html = [
      '<html><head><title>Chanca Piedra</title>',
      '<meta property="og:image" content="/img/og-fallback.jpg">',
      '<script type="application/ld+json">',
      JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Product',
        image: ['https://cdn.example.com/products/chanca-piedra-500.jpg'],
        name: 'Chanca Piedra',
      }),
      '</script></head><body><h1>Chanca Piedra</h1>',
      '<img src="/assets/logo.png" alt="logo">',
      '<img src="/img/bottle.jpg" alt="bottle">',
      '</body></html>',
    ].join('');

    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' }, status: 200 })
    );

    try {
      const result = (await executeFetchUrlContent({
        url: 'https://shop.example.com/shop/chanca-piedra',
      })) as { images: string[]; mainImage: string | null; success: boolean };

      expect(result.success).toBe(true);
      // Structured product data outranks og:image and in-body <img>.
      expect(result.mainImage).toBe('https://cdn.example.com/products/chanca-piedra-500.jpg');
      // Relative URLs are resolved against the final URL.
      expect(result.images).toContain('https://shop.example.com/img/og-fallback.jpg');
      expect(result.images).toContain('https://shop.example.com/img/bottle.jpg');
      // Site chrome is filtered out.
      expect(result.images.some((url) => url.includes('logo.png'))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fetch_url_content falls back through og:image, srcset, and lazy-loaded images', async () => {
    const html = [
      '<html><head><title>Widgets</title></head><body>',
      '<img src="data:image/gif;base64,R0lGOD" data-src="/lazy/hero.jpg">',
      '<img srcset="/small.jpg 400w, /large.jpg 1200w">',
      '<img src="/icons/favicon.png">',
      '<img src="/tiny.jpg" width="48">',
      '</body></html>',
    ].join('');

    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' }, status: 200 })
    );

    try {
      const result = (await executeFetchUrlContent({ url: 'https://acme.example.com/p' })) as {
        images: string[];
        mainImage: string | null;
      };

      // The data: URI placeholder is skipped in favour of the real lazy src.
      expect(result.mainImage).toBe('https://acme.example.com/lazy/hero.jpg');
      // srcset resolves to the widest candidate.
      expect(result.images).toContain('https://acme.example.com/large.jpg');
      expect(result.images.some((url) => url.includes('small.jpg'))).toBe(false);
      // Icons and declared thumbnails are dropped.
      expect(result.images.some((url) => url.includes('favicon'))).toBe(false);
      expect(result.images.some((url) => url.includes('tiny.jpg'))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fetch_url_content upgrades a thumbnail to the full-size image the page links to', async () => {
    // The lightbox pattern real shops use: a downscaled <img> beside an <a href>
    // to the original, with og:image pointing at the thumbnail.
    const html = [
      '<html><head><title>Chanca Piedra</title>',
      '<meta property="og:image" content="https://shop.example.com/uploads/products/thumbnails/3643%20Chanca%20Piedra.webp">',
      '</head><body>',
      '<img src="/uploads/products/thumbnails/3643 Chanca Piedra.webp" width="570" alt="Chanca Piedra">',
      '<a data-fancybox="gallery" href="/uploads/products/3643 Chanca Piedra.webp">zoom</a>',
      '</body></html>',
    ].join('');

    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' }, status: 200 })
    );

    try {
      const result = (await executeFetchUrlContent({
        url: 'https://shop.example.com/shop/chanca-piedra',
      })) as { images: string[]; mainImage: string | null };

      expect(result.mainImage).toBe(
        'https://shop.example.com/uploads/products/3643%20Chanca%20Piedra.webp'
      );
      // The thumbnail is not offered separately once it has been upgraded.
      expect(result.images.some((url) => url.includes('/thumbnails/'))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fetch_url_content reports no mainImage rather than inventing one', async () => {
    const html = '<html><head><title>Text only</title></head><body><p>Just words here.</p></body></html>';

    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' }, status: 200 })
    );

    try {
      const result = (await executeFetchUrlContent({ url: 'https://acme.example.com' })) as {
        images: string[];
        mainImage: string | null;
      };

      expect(result.mainImage).toBeNull();
      expect(result.images).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('normalizes a section with an external image background instead of downgrading it', async () => {
    const { database, supabase } = createMockSupabase({
      blocks: [],
      pages: [
        {
          id: 7,
          language_id: 1,
          slug: 'home',
          title: 'Home',
          translation_group_id: 'group-home',
        },
      ],
    });

    await executeConfirmed(
      executeInsertContentBlock,
      {
        block: {
          blockType: 'section',
          content: {
            background: {
              image: { alt_text: 'Herbs', external_url: 'https://images.example.com/hero.jpg' },
              type: 'image',
            },
            column_blocks: [
              [{ block_type: 'heading', content: { level: 1, text_content: 'Welcome' } }],
            ],
            is_hero: true,
          },
        },
        contentType: 'page',
        position: 'end',
        slug: 'home',
      },
      { revalidatePath: () => undefined, supabase }
    );

    const section = database.blocks[0].content as Record<string, any>;
    expect(section.background.type).toBe('image');
    expect(section.background.image.external_url).toBe('https://images.example.com/hero.jpg');
    // Required render fields are filled so it validates and renders as a cover background.
    expect(section.background.image.size).toBe('cover');
    expect(section.background.image.position).toBe('center');
  });

  it('search_stock_photos reports when no provider is configured', async () => {
    const originalPexels = process.env.PEXELS_API_KEY;
    const originalUnsplash = process.env.UNSPLASH_ACCESS_KEY;
    delete process.env.PEXELS_API_KEY;
    delete process.env.UNSPLASH_ACCESS_KEY;

    try {
      const result = (await executeSearchStockPhotos({ query: 'herbal supplements' })) as {
        success: boolean;
        photos: unknown[];
        message?: string;
      };
      expect(result.success).toBe(false);
      expect(result.photos).toEqual([]);
      expect(String(result.message)).toMatch(/PEXELS_API_KEY|UNSPLASH_ACCESS_KEY/);
    } finally {
      if (originalPexels === undefined) delete process.env.PEXELS_API_KEY;
      else process.env.PEXELS_API_KEY = originalPexels;
      if (originalUnsplash === undefined) delete process.env.UNSPLASH_ACCESS_KEY;
      else process.env.UNSPLASH_ACCESS_KEY = originalUnsplash;
    }
  });

  it('search_stock_photos normalizes Pexels results', async () => {
    const originalPexels = process.env.PEXELS_API_KEY;
    process.env.PEXELS_API_KEY = 'test-key';

    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            photos: [
              {
                alt: 'Fresh herbs on a table',
                height: 4000,
                photographer: 'Jane Doe',
                src: {
                  large: 'https://images.pexels.com/photo/1/large.jpg',
                  large2x: 'https://images.pexels.com/photo/1/large2x.jpg',
                  medium: 'https://images.pexels.com/photo/1/medium.jpg',
                },
                url: 'https://www.pexels.com/photo/1/',
                width: 6000,
              },
            ],
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 }
        )
    );

    try {
      const result = (await executeSearchStockPhotos({ orientation: 'landscape', query: 'herbs' })) as {
        success: boolean;
        provider: string;
        photos: Array<{ url: string; width: number; height: number; alt: string; photographer: string }>;
      };
      expect(result.success).toBe(true);
      expect(result.provider).toBe('pexels');
      expect(result.photos).toHaveLength(1);
      expect(result.photos[0].url).toBe('https://images.pexels.com/photo/1/large2x.jpg');
      expect(result.photos[0].width).toBe(6000);
      expect(result.photos[0].photographer).toBe('Jane Doe');
    } finally {
      vi.unstubAllGlobals();
      if (originalPexels === undefined) delete process.env.PEXELS_API_KEY;
      else process.env.PEXELS_API_KEY = originalPexels;
    }
  });

  it('translate_page creates a linked published translation, copying structure and translating text', async () => {
    const { database, supabase } = createMockSupabase({
      blocks: [
        {
          block_type: 'heading',
          content: { level: 1, text_content: 'Explore Our Products' },
          id: 10,
          language_id: 1,
          order: 0,
          page_id: 7,
          post_id: null,
        },
        {
          block_type: 'text',
          content: { html_content: '<p>Discover our leader in natural health.</p>' },
          id: 11,
          language_id: 1,
          order: 1,
          page_id: 7,
          post_id: null,
        },
      ],
      languages: [
        { code: 'en', id: 1, is_default: true },
        { code: 'fr', id: 2 },
      ],
      pages: [
        {
          id: 7,
          language_id: 1,
          slug: 'home',
          status: 'published',
          title: 'Home',
          translation_group_id: 'group-home',
        },
      ],
    });

    const result = await executeConfirmed(
      executeTranslatePage,
      {
        targetLanguageCode: 'fr',
        title: 'Accueil',
        translations: {
          'Discover our leader in natural health.': 'Découvrez notre leader en santé naturelle.',
          'Explore Our Products': 'Explorez nos produits',
        },
      },
      {
        actorUserId: 'admin-1',
        pageContext: { contentType: 'page', entityId: 7 },
        revalidatePath: () => undefined,
        supabase,
      }
    );

    expect(result).toMatchObject({
      contentType: 'page',
      isTranslation: true,
      languageCode: 'fr',
      mutationExecuted: true,
      success: true,
    });

    // The FR page was created published, with a localized slug, linked to the
    // same translation group.
    const frPage = database.pages.find((page) => page.language_id === 2);
    expect(frPage).toMatchObject({
      language_id: 2,
      slug: 'accueil',
      status: 'published',
      title: 'Accueil',
      translation_group_id: 'group-home',
    });

    // Its blocks were copied structurally with the text translated.
    const frBlocks = database.blocks
      .filter((block) => block.page_id === frPage?.id)
      .sort((a, b) => a.order - b.order);
    expect(frBlocks).toHaveLength(2);
    expect(frBlocks[0].content.text_content).toBe('Explorez nos produits');
    expect(frBlocks[1].content.html_content).toContain('Découvrez notre leader en santé naturelle');

    // The original English page is untouched.
    expect(database.pages.filter((page) => page.language_id === 1)).toHaveLength(1);
  });

  it('set_content_images imports an external feature image URL and sets feature_image_id on a post', async () => {
    const { database, supabase } = createMockSupabase({
      posts: [
        {
          feature_image_id: null,
          id: 5,
          language_id: 1,
          slug: 'omegas',
          status: 'draft',
          title: 'Omegas',
          translation_group_id: 'g-omegas',
        },
      ],
    });

    const importedUrls: string[] = [];
    const importExternalImage = async ({ url }: { url: string }) => {
      importedUrls.push(url);
      return { id: 'media-uuid-123' };
    };

    const result = await executeConfirmed(
      executeSetContentImages,
      { images: ['https://images.pexels.com/photos/1/photo.jpeg?w=940'] },
      {
        actorUserId: 'admin-1',
        importExternalImage,
        pageContext: { contentType: 'post', entityId: 5 },
        revalidatePath: () => undefined,
        supabase,
      }
    );

    expect(result).toMatchObject({
      contentType: 'post',
      imageCount: 1,
      mutationExecuted: true,
      success: true,
    });
    // The Pexels URL was imported (not written verbatim), and the returned media
    // id landed in feature_image_id.
    expect(importedUrls).toEqual(['https://images.pexels.com/photos/1/photo.jpeg?w=940']);
    expect(database.posts.find((post) => post.id === 5)?.feature_image_id).toBe('media-uuid-123');
  });

  it('update_current_cms_fields imports an external feature image URL instead of writing the raw URL', async () => {
    const { database, supabase } = createMockSupabase({
      posts: [
        {
          feature_image_id: null,
          id: 8,
          language_id: 1,
          slug: 'news',
          status: 'draft',
          title: 'News',
        },
      ],
    });

    const importExternalImage = async () => ({ id: 'media-xyz' });

    const result = await executeConfirmed(
      executeUpdateCurrentCmsFields,
      { fields: { feature_image_id: 'https://images.pexels.com/photos/2/p.jpeg' } },
      {
        actorUserId: 'admin-1',
        importExternalImage,
        pageContext: { contentType: 'post', entityId: 8 },
        revalidatePath: () => undefined,
        supabase,
      }
    );

    expect(result).toMatchObject({ mutationExecuted: true, success: true });
    expect(database.posts.find((post) => post.id === 8)?.feature_image_id).toBe('media-xyz');
  });

  it('set_content_images sets a product gallery via product_media without touching the product row or variants', async () => {
    const { database, supabase } = createMockSupabase({
      product_media: [{ media_id: 'old-media-1', product_id: 'prod-1', sort_order: 0 }],
      products: [
        {
          id: 'prod-1',
          language_id: 1,
          slug: 'omega-oil',
          status: 'active',
          title: 'Omega Oil',
        },
      ],
    });

    const importedUrls: string[] = [];
    const importExternalImage = async ({ url }: { url: string }) => {
      importedUrls.push(url);
      return { id: url.includes('/1/') ? 'new-media-1' : 'new-media-2' };
    };

    const result = await executeConfirmed(
      executeSetContentImages,
      {
        images: [
          'https://images.pexels.com/photos/1/a.jpeg',
          'https://images.pexels.com/photos/2/b.jpeg',
        ],
      },
      {
        actorUserId: 'admin-1',
        importExternalImage,
        pageContext: { contentType: 'product', entityId: 'prod-1' },
        revalidatePath: () => undefined,
        supabase,
      }
    );

    expect(result).toMatchObject({
      contentType: 'product',
      imageCount: 2,
      mutationExecuted: true,
      success: true,
    });
    expect(importedUrls).toHaveLength(2);
    // The old product_media row was replaced by the two new media ids in order.
    const media = database.product_media
      .filter((row) => row.product_id === 'prod-1')
      .sort((a, b) => a.sort_order - b.sort_order);
    expect(media.map((row) => row.media_id)).toEqual(['new-media-1', 'new-media-2']);
    // The product row itself is untouched (no full-product rewrite).
    expect(database.products.find((row) => row.id === 'prod-1')).toMatchObject({
      slug: 'omega-oil',
      status: 'active',
      title: 'Omega Oil',
    });
  });

  it('update_content_block mirrors a product edit into the open product draft', async () => {
    const { database, supabase } = createMockSupabase({
      blocks: [
        {
          block_type: 'text',
          content: { html_content: '<p>Old description</p>' },
          id: 41,
          language_id: 1,
          order: 0,
          page_id: null,
          post_id: null,
          product_id: 'prod-1',
        },
      ],
      // The product editor is open, so its draft — not the live rows — is what
      // the editor renders and what publishing writes back over the live blocks.
      product_drafts: [
        {
          blocks: [
            {
              block_type: 'text',
              content: { html_content: '<p>Old description</p>' },
              id: 41,
              language_id: 1,
              order: 0,
              product_id: 'prod-1',
            },
          ],
          id: 1,
          meta: { slug: 'chanca-piedra', title: 'Chanca Piedra' },
          product_id: 'prod-1',
        },
      ],
      products: [
        { id: 'prod-1', language_id: 1, slug: 'chanca-piedra', title: 'Chanca Piedra' },
      ],
    });

    const result = await executeConfirmed(
      executeUpdateContentBlock,
      {
        blockId: 41,
        blockType: 'text',
        content: { html_content: '<p>New description</p>' },
      },
      {
        pageContext: { contentType: 'product', entityId: 'prod-1' },
        revalidatePath: () => undefined,
        supabase,
      }
    );

    expect(result).toMatchObject({ blockId: 41, mutationExecuted: true, success: true });
    expect(database.blocks[0].content).toEqual({ html_content: '<p>New description</p>' });
    // Without this the edit would be invisible in the editor and destroyed the
    // moment the draft is published.
    expect(database.product_drafts[0].blocks).toEqual([
      expect.objectContaining({
        content: { html_content: '<p>New description</p>' },
        id: 41,
      }),
    ]);
  });

  it('insert_content_block adds the new product block to the open product draft', async () => {
    const { database, supabase } = createMockSupabase({
      blocks: [
        {
          block_type: 'text',
          content: { html_content: '<p>Intro</p>' },
          id: 41,
          language_id: 1,
          order: 0,
          page_id: null,
          post_id: null,
          product_id: 'prod-1',
        },
      ],
      product_drafts: [
        {
          blocks: [
            {
              block_type: 'text',
              content: { html_content: '<p>Intro</p>' },
              id: 41,
              language_id: 1,
              order: 0,
              product_id: 'prod-1',
            },
          ],
          id: 1,
          meta: { slug: 'chanca-piedra', title: 'Chanca Piedra' },
          product_id: 'prod-1',
        },
      ],
      products: [
        { id: 'prod-1', language_id: 1, slug: 'chanca-piedra', title: 'Chanca Piedra' },
      ],
    });

    const result = await executeConfirmed(
      executeInsertContentBlock,
      {
        block: {
          blockType: 'text',
          content: { html_content: '<p>Directions</p>' },
        },
        contentType: 'product',
        entityId: 'prod-1',
        position: 'end',
      },
      { revalidatePath: () => undefined, supabase }
    );

    expect(result).toMatchObject({ contentType: 'product', mutationExecuted: true, success: true });
    expect(database.blocks).toHaveLength(2);
    expect(database.product_drafts[0].blocks).toEqual([
      expect.objectContaining({ id: 41, order: 0 }),
      expect.objectContaining({
        content: { html_content: '<p>Directions</p>' },
        order: 1,
        product_id: 'prod-1',
      }),
    ]);
  });

  it('set_content_images refreshes the gallery held by an open product draft', async () => {
    const { database, supabase } = createMockSupabase({
      product_drafts: [
        {
          blocks: [],
          id: 1,
          meta: {
            price: 25,
            product_media: [{ media_id: 'old-media-1', sort_order: 0 }],
            sku: 'CHANCAPIEDRA',
            slug: 'chanca-piedra',
          },
          product_id: 'prod-1',
        },
      ],
      product_media: [{ media_id: 'old-media-1', product_id: 'prod-1', sort_order: 0 }],
      products: [
        { id: 'prod-1', language_id: 1, slug: 'chanca-piedra', title: 'Chanca Piedra' },
      ],
    });

    const result = await executeConfirmed(
      executeSetContentImages,
      { images: ['https://images.pexels.com/photos/1/a.jpeg'] },
      {
        importExternalImage: async () => ({ id: 'new-media-1' }),
        pageContext: { contentType: 'product', entityId: 'prod-1' },
        revalidatePath: () => undefined,
        supabase,
      }
    );

    expect(result).toMatchObject({ imageCount: 1, mutationExecuted: true, success: true });
    // Publishing the draft feeds meta straight back through updateProduct, which
    // would otherwise restore the gallery this call just replaced.
    expect((database.product_drafts[0].meta as any).product_media).toEqual([
      { media_id: 'new-media-1', sort_order: 0 },
    ]);
  });

  it('set_content_images targets a product by slug with no CMS page context open', async () => {
    const { database, supabase } = createMockSupabase({
      products: [
        {
          id: 'prod-9',
          language_id: 1,
          slug: 'chanca-piedra',
          status: 'draft',
          title: 'Chanca Piedra',
        },
      ],
    });

    const result = await executeConfirmed(
      executeSetContentImages,
      {
        contentType: 'product',
        images: ['https://cdn.example.com/products/chanca-piedra-500.jpg'],
        slug: 'chanca-piedra',
      },
      {
        actorUserId: 'admin-1',
        importExternalImage: async () => ({ id: 'media-9' }),
        // Deliberately no pageContext: this is the dashboard-chat case.
        revalidatePath: () => undefined,
        supabase,
      }
    );

    expect(result).toMatchObject({
      contentType: 'product',
      imageCount: 1,
      mutationExecuted: true,
      success: true,
    });
    expect(database.product_media.map((row) => row.media_id)).toEqual(['media-9']);
  });

  it('set_content_images still requires a target when none can be resolved', async () => {
    const { supabase } = createMockSupabase();

    await expect(
      executeSetContentImages(
        { images: ['https://cdn.example.com/a.jpg'] },
        { actorUserId: 'admin-1', importExternalImage: async () => ({ id: 'm' }), supabase }
      )
    ).rejects.toThrow(/No current CMS page context/);
  });

  it('set_content_images rejects a non-URL, non-media-id image reference', async () => {
    const { supabase } = createMockSupabase({
      posts: [{ feature_image_id: null, id: 9, language_id: 1, slug: 'p', status: 'draft', title: 'P' }],
    });

    await expect(
      executeConfirmed(
        executeSetContentImages,
        { images: ['data:image/png;base64,iVBORw0KGgo='] },
        {
          actorUserId: 'admin-1',
          importExternalImage: async () => ({ id: 'unused' }),
          pageContext: { contentType: 'post', entityId: 9 },
          revalidatePath: () => undefined,
          supabase,
        }
      )
    ).rejects.toThrow(/not a usable image reference/);
  });

  it('set_content_images passes an existing media id through without importing', async () => {
    const { database, supabase } = createMockSupabase({
      pages: [
        {
          feature_image_id: null,
          id: 3,
          language_id: 1,
          slug: 'about',
          status: 'published',
          title: 'About',
          translation_group_id: 'g-about',
        },
      ],
    });

    let importCalled = false;
    const importExternalImage = async () => {
      importCalled = true;
      return { id: 'should-not-be-used' };
    };

    await executeConfirmed(
      executeSetContentImages,
      { images: ['3f2504e0-4f89-41d3-9a0c-0305e82c3301'] },
      {
        actorUserId: 'admin-1',
        importExternalImage,
        pageContext: { contentType: 'page', entityId: 3 },
        revalidatePath: () => undefined,
        supabase,
      }
    );

    expect(importCalled).toBe(false);
    expect(database.pages.find((page) => page.id === 3)?.feature_image_id).toBe(
      '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
    );
  });

  it('search_stock_photos falls back to Unsplash when Pexels is rate-limited', async () => {
    const originalPexels = process.env.PEXELS_API_KEY;
    const originalUnsplash = process.env.UNSPLASH_ACCESS_KEY;
    process.env.PEXELS_API_KEY = 'pexels-key';
    process.env.UNSPLASH_ACCESS_KEY = 'unsplash-key';

    vi.stubGlobal('fetch', async (url: unknown) => {
      if (String(url).includes('api.pexels.com')) {
        return new Response('rate limit', { status: 429 });
      }

      return new Response(
        JSON.stringify({
          results: [
            {
              alt_description: 'fresh herbs',
              height: 3000,
              links: { html: 'https://unsplash.com/photos/x' },
              urls: { regular: 'https://images.unsplash.com/x', small: 'https://images.unsplash.com/x-sm' },
              user: { name: 'Ansel' },
              width: 4000,
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 }
      );
    });

    try {
      const result = (await executeSearchStockPhotos({ query: 'herbs' })) as {
        success: boolean;
        provider: string;
        attemptedProviders: string[];
        photos: Array<{ url: string; provider: string }>;
      };
      expect(result.success).toBe(true);
      expect(result.provider).toBe('unsplash');
      expect(result.attemptedProviders).toEqual(['pexels', 'unsplash']);
      expect(result.photos[0].url).toBe('https://images.unsplash.com/x');
    } finally {
      vi.unstubAllGlobals();
      if (originalPexels === undefined) delete process.env.PEXELS_API_KEY;
      else process.env.PEXELS_API_KEY = originalPexels;
      if (originalUnsplash === undefined) delete process.env.UNSPLASH_ACCESS_KEY;
      else process.env.UNSPLASH_ACCESS_KEY = originalUnsplash;
    }
  });

  it('builds a deterministic action plan for visible English and French contact intro copy', () => {
    const plan = buildVisibleContactIntroActionPlan(
      'can you add a title and description above the form on both contact pages english and french'
    );

    expect(plan).toMatchObject({
      actions: [
        {
          input: {
            anchorBlockType: 'form',
            contentType: 'page',
            position: 'before',
            slug: 'contact-us',
          },
          tool: 'insert_content_block',
        },
        {
          input: {
            anchorBlockType: 'form',
            contentType: 'page',
            position: 'before',
            slug: 'contactez-nous',
          },
          tool: 'insert_content_block',
        },
      ],
      summary:
        'Add visible title and description copy above the forms on the English and French Contact pages.',
    });
    expect((plan?.actions[0].input as any).block.content.html_content).toContain('<h2>');
    expect((plan?.actions[1].input as any).block.content.html_content).toContain('<h2>');
  });

  it('uses an action plan to add localized intro copy above forms on both translated pages', async () => {
    const { database, supabase } = createMockSupabase({
      blocks: [
        {
          block_type: 'form',
          content: {
            fields: [],
            recipient_email: 'info@nextblock.dev',
            submit_button_text: 'Send Message',
            success_message: 'Thanks',
          },
          id: 12,
          language_id: 1,
          order: 0,
          page_id: 7,
          post_id: null,
        },
        {
          block_type: 'form',
          content: {
            fields: [],
            recipient_email: 'info@nextblock.dev',
            submit_button_text: 'Envoyer',
            success_message: 'Merci',
          },
          id: 13,
          language_id: 2,
          order: 0,
          page_id: 8,
          post_id: null,
        },
      ],
      pages: [
        {
          id: 7,
          language_id: 1,
          slug: 'contact-us',
          title: 'Contact Us',
          translation_group_id: 'group-contact',
        },
        {
          id: 8,
          language_id: 2,
          slug: 'contactez-nous',
          title: 'Contactez-nous',
          translation_group_id: 'group-contact',
        },
      ],
    });

    const result = await executeConfirmed(
      executeCmsActionPlan,
      {
        actions: [
          {
            input: {
              anchorBlockType: 'form',
              block: {
                blockType: 'text',
                content: {
                  html_content:
                    '<h2>Ready to talk?</h2><p>Share your goals and we will help you choose the right next step.</p>',
                },
              },
              contentType: 'page',
              position: 'before',
              slug: 'contact-us',
            },
            tool: 'insert_content_block',
          },
          {
            input: {
              anchorBlockType: 'form',
              block: {
                blockType: 'text',
                content: {
                  html_content:
                    '<h2>Prêt à discuter?</h2><p>Parlez-nous de vos objectifs et nous vous aiderons à choisir la prochaine étape.</p>',
                },
              },
              contentType: 'page',
              position: 'before',
              slug: 'contactez-nous',
            },
            tool: 'insert_content_block',
          },
        ],
      },
      {
        pageContext: {
          contentType: 'page',
          entityId: 7,
          slug: 'contact-us',
          title: 'Contact Us',
        },
        revalidatePath: () => undefined,
        supabase,
      }
    );

    expect(result).toMatchObject({
      actionCount: 2,
      mutationExecuted: true,
      success: true,
    });
    const englishTextBlocks = database.blocks.filter(
      (block) => block.block_type === 'text' && block.page_id === 7
    );
    const frenchTextBlocks = database.blocks.filter(
      (block) => block.block_type === 'text' && block.page_id === 8
    );

    expect(englishTextBlocks).toHaveLength(1);
    expect(frenchTextBlocks).toHaveLength(1);
    expect(englishTextBlocks[0]).toMatchObject({ order: 0 });
    expect(frenchTextBlocks[0]).toMatchObject({ order: 0 });
    expect(database.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ block_type: 'form', page_id: 7, order: 1 }),
        expect.objectContaining({ block_type: 'form', page_id: 8, order: 1 }),
      ])
    );
  });

  it('merges partial top-level block content with existing content before validation', async () => {
    const { database, supabase } = createMockSupabase({
      blocks: [
        {
          block_type: 'button',
          content: { text: 'Old label', url: '/contact', variant: 'default' },
          id: 14,
          language_id: 1,
          order: 0,
          page_id: 7,
          post_id: null,
        },
      ],
    });

    const result = await executeConfirmed(
      executeUpdateContentBlock,
      {
        blockId: 14,
        blockType: 'button',
        content: { text: 'Contact Us' },
      },
      {
        pageContext: { contentType: 'page', entityId: 7, slug: 'home' },
        revalidatePath: () => undefined,
        supabase,
      }
    );

    expect(result).toMatchObject({
      blockId: 14,
      blockType: 'button',
      contentUpdated: true,
      mutationExecuted: true,
      success: true,
    });
    expect(database.blocks[0].content).toMatchObject({
      text: 'Contact Us',
      url: '/contact',
      variant: 'default',
    });
  });

  it('appends button-shaped content to a section block while preserving required layout fields', async () => {
    const sectionContent = {
      background: { type: 'none' },
      column_blocks: [
        [
          {
            block_type: 'text',
            content: { html_content: '<p>Hero intro</p>' },
          },
        ],
      ],
      column_gap: 'md',
      container_type: 'container',
      padding: { bottom: 'lg', top: 'lg' },
      responsive_columns: { desktop: 1, mobile: 1, tablet: 1 },
    };
    const { database, supabase } = createMockSupabase({
      blocks: [
        {
          block_type: 'section',
          content: sectionContent,
          id: 8,
          language_id: 1,
          order: 0,
          page_id: 7,
          post_id: null,
        },
      ],
    });

    const result = await executeConfirmed(
      executeUpdateContentBlock,
      {
        blockId: 8,
        blockType: 'section',
        content: { text: 'Contact Us', url: '/contact', variant: 'default' },
      },
      {
        pageContext: { contentType: 'page', entityId: 7, slug: 'articles' },
        revalidatePath: () => undefined,
        supabase,
      }
    );

    expect(result).toMatchObject({
      blockId: 8,
      blockType: 'section',
      contentUpdated: true,
      mutationExecuted: true,
      success: true,
    });
    expect(database.blocks[0].content).toMatchObject({
      background: { type: 'none' },
      column_gap: 'md',
      container_type: 'container',
      padding: { bottom: 'lg', top: 'lg' },
      responsive_columns: { desktop: 1, mobile: 1, tablet: 1 },
    });
    expect(database.blocks[0].content.column_blocks[0]).toHaveLength(2);
    expect(database.blocks[0].content.column_blocks[0][1]).toMatchObject({
      block_type: 'button',
      content: { text: 'Contact Us', url: '/contact', variant: 'default' },
    });
    expect(database.blocks[0].content.column_blocks[0][1].temp_id).toEqual(expect.any(String));
  });

  it('updates a validated nested section column block', async () => {
    const sectionContent = {
      background: { type: 'none' },
      column_blocks: [
        [
          {
            block_type: 'text',
            content: { html_content: '<p>Old nested copy</p>' },
          },
        ],
      ],
      column_gap: 'md',
      container_type: 'container',
      padding: { bottom: 'md', top: 'md' },
      responsive_columns: { desktop: 1, mobile: 1, tablet: 1 },
    };
    const { database, supabase } = createMockSupabase({
      blocks: [
        {
          block_type: 'section',
          content: sectionContent,
          id: 20,
          language_id: 1,
          order: 0,
          page_id: 7,
          post_id: null,
        },
      ],
    });

    const result = await executeConfirmed(
      executeUpdateSectionColumnBlock,
      {
        blockIndex: 0,
        blockType: 'text',
        columnIndex: 0,
        content: { html_content: '<p>New nested copy</p>' },
        parentBlockId: 20,
      },
      {
        pageContext: { contentType: 'page', entityId: 7, slug: 'home' },
        revalidatePath: () => undefined,
        supabase,
      }
    );

    expect(result).toMatchObject({
      blockIndex: 0,
      columnIndex: 0,
      nestedBlockType: 'text',
      parentBlockId: 20,
      parentBlockType: 'section',
      mutationExecuted: true,
      success: true,
    });
    expect(database.blocks[0].content.column_blocks[0][0].content).toEqual({
      html_content: '<p>New nested copy</p>',
    });
  });

  it('returns confirmation for existing mutating tools before changing data', async () => {
    const { database, supabase } = createMockSupabase({
      navigation_items: [
        { id: 1, label: 'Home', language_id: 1, menu_key: 'HEADER', order: 0, url: '/' },
      ],
    });

    const result = await executeUpdateNavigationBar(
      {
        items: [{ label: 'Contact', url: '/contact' }],
        languageCode: 'en',
        mode: 'append',
      },
      { supabase }
    );

    expectConfirmation(result);
    expect(database.navigation_items).toEqual([
      { id: 1, label: 'Home', language_id: 1, menu_key: 'HEADER', order: 0, url: '/' },
    ]);
  });

  it('prepares a multi-action CMS plan without mutating', async () => {
    const { database, supabase } = createMockSupabase({
      navigation_items: [
        { id: 1, label: 'Home', language_id: 1, menu_key: 'HEADER', order: 0, url: '/' },
      ],
    });

    const preview = await executeCmsActionPlan(
      {
        actions: [
          {
            input: {
              contactEmail: 'info@nextblock.dev',
              title: 'Contact Us',
            },
            tool: 'create_cms_page',
          },
          {
            input: {
              items: [{ label: 'Contact Us', url: '/contact-us' }],
              languageCode: 'en',
              mode: 'append',
            },
            tool: 'update_navigation_bar',
          },
        ],
      },
      { actorUserId: 'admin_1', supabase }
    );

    const confirmed = expectConfirmation(preview);
    expect(confirmed.preview).toMatchObject({
      actionCount: 2,
      summary: 'Complete 2 CMS actions.',
    });
    expect(confirmed.preview.actionSummaries).toHaveLength(2);
    expect(database.pages).toEqual([]);
    expect(database.navigation_items).toEqual([
      { id: 1, label: 'Home', language_id: 1, menu_key: 'HEADER', order: 0, url: '/' },
    ]);
  });

  it('confirms a create-page-plus-navigation action plan in order', async () => {
    const { database, supabase } = createMockSupabase({
      navigation_items: [
        { id: 1, label: 'Home', language_id: 1, menu_key: 'HEADER', order: 0, url: '/' },
      ],
    });

    const result = await executeConfirmed(
      executeCmsActionPlan,
      {
        actions: [
          {
            input: {
              contactEmail: 'info@nextblock.dev',
              title: 'Contact Us',
            },
            tool: 'create_cms_page',
          },
          {
            input: {
              items: [{ label: 'Contact Us', url: '/contact-us' }],
              languageCode: 'en',
              mode: 'append',
            },
            tool: 'update_navigation_bar',
          },
        ],
      },
      { actorUserId: 'admin_1', revalidatePath: () => undefined, supabase }
    );

    expect(result).toMatchObject({
      actionCount: 2,
      editPath: '/cms/pages/1/edit',
      mutationExecuted: true,
      success: true,
    });
    expect(database.pages[0]).toMatchObject({
      slug: 'contact-us',
      title: 'Contact Us',
    });
    expect(database.navigation_items[1]).toMatchObject({
      label: 'Contact Us',
      language_id: 1,
      menu_key: 'HEADER',
      page_id: 1,
      parent_id: null,
      url: '/contact-us',
    });
    expect(database.navigation_items[1].translation_group_id).toEqual(expect.any(String));
  });

  it('normalizes command-string action plans and links created language versions', async () => {
    const { database, supabase } = createMockSupabase({
      languages: [
        { code: 'en', id: 1, is_active: true, name: 'English' },
        { code: 'fr', id: 2, is_active: true, name: 'French' },
      ],
      navigation_items: [
        { id: 1, label: 'Home', language_id: 1, menu_key: 'HEADER', order: 0, url: '/' },
        { id: 2, label: 'Accueil', language_id: 2, menu_key: 'HEADER', order: 0, url: '/' },
      ],
    });

    const result = await executeConfirmed(
      executeCmsActionPlan,
      {
        actions: [
          "create_cms_page(title='Contact Us', slug='contact-us', contactEmail='info@nextblock.dev', blocks=[{'blockType': 'form', 'content': {'recipient_email': 'info@nextblock.dev', 'fields': [{'label': 'Name', 'type': 'text'}, {'label': 'Email', 'type': 'email'}, {'label': 'Message', 'type': 'textarea'}]}}])",
          "update_navigation_bar(items=[{'label': 'Contact Us', 'url': '/contact-us'}], languageCode='en', mode='append')",
          "create_cms_page(title='Contactez-nous', slug='contactez-nous', languageCode='fr', contactEmail='info@nextblock.dev', blocks=[{'blockType': 'form', 'content': {'recipient_email': 'info@nextblock.dev', 'fields': [{'label': 'Nom', 'type': 'text'}, {'label': 'Email', 'type': 'email'}, {'label': 'Message', 'type': 'textarea'}]}}])",
          "update_navigation_bar(items=[{'label': 'Contactez-nous', 'url': '/contactez-nous'}], languageCode='fr', mode='append')",
        ],
      },
      { actorUserId: 'admin_1', revalidatePath: () => undefined, supabase }
    );

    expect(result).toMatchObject({
      actionCount: 4,
      editPath: '/cms/pages/1/edit',
      mutationExecuted: true,
      success: true,
    });
    expect(database.pages).toHaveLength(2);
    expect(database.pages[0]).toMatchObject({
      language_id: 1,
      slug: 'contact-us',
      title: 'Contact Us',
    });
    expect(database.pages[1]).toMatchObject({
      language_id: 2,
      slug: 'contactez-nous',
      title: 'Contactez-nous',
      translation_group_id: database.pages[0].translation_group_id,
    });
    expect(database.navigation_items[2]).toMatchObject({
      label: 'Contact Us',
      language_id: 1,
      page_id: 1,
      url: '/contact-us',
    });
    expect(database.navigation_items[3]).toMatchObject({
      label: 'Contactez-nous',
      language_id: 2,
      page_id: 2,
      translation_group_id: database.navigation_items[2].translation_group_id,
      url: '/contactez-nous',
    });
  });

  it('creates a product and attaches its image in one confirmed action plan', async () => {
    const { database, supabase } = createMockSupabase();
    const context = {
      actorUserId: 'admin-1',
      importExternalImage: async () => ({ id: 'media-plan-1' }),
      revalidatePath: () => undefined,
      supabase,
    };
    const planInput = {
      actions: [
        {
          input: { price: 25, slug: 'chanca-piedra', title: 'Chanca Piedra' },
          tool: 'create_cms_product',
        },
        {
          input: {
            contentType: 'product',
            images: ['https://cdn.example.com/chanca.jpg'],
            slug: 'chanca-piedra',
          },
          tool: 'set_content_images',
        },
      ],
      summary: 'Create the product and set its main image.',
    };

    // The product does not exist yet at preview time; the plan must still
    // preview cleanly instead of failing to resolve the image target.
    const preview = (await executeCmsActionPlan(planInput as any, context)) as {
      confirmationPhrase: string;
      preview: Record<string, unknown>;
      requiresConfirmation: boolean;
    };
    const actionSummaries = preview.preview['actionSummaries'] as string[];

    expect(preview.requiresConfirmation).toBe(true);
    expect(actionSummaries).toHaveLength(2);
    expect(actionSummaries[1]).toContain('created in this plan');
    expect(database.products).toHaveLength(0);

    const result = await executeCmsActionPlan(planInput as any, {
      ...context,
      latestUserMessage: preview.confirmationPhrase,
    });

    expect(result).toMatchObject({ mutationExecuted: true, success: true });
    expect(database.products[0]).toMatchObject({ slug: 'chanca-piedra' });
    // The image landed on the product the plan just created.
    expect(database.product_media.map((row) => row.media_id)).toEqual(['media-plan-1']);
    expect(database.product_media[0].product_id).toBe(database.products[0].id);
  });

  it('confirms a navigation-only action plan without returning a navigation path', async () => {
    const { supabase } = createMockSupabase({
      navigation_items: [
        { id: 1, label: 'Home', language_id: 1, menu_key: 'HEADER', order: 0, url: '/' },
      ],
    });

    const result = await executeConfirmed(
      executeCmsActionPlan,
      {
        actions: [
          {
            input: {
              items: [{ label: 'Contact', url: '/contact' }],
              languageCode: 'en',
              mode: 'append',
            },
            tool: 'update_navigation_bar',
          },
        ],
      },
      { actorUserId: 'admin_1', revalidatePath: () => undefined, supabase }
    );

    expect(result).toMatchObject({
      actionCount: 1,
      mutationExecuted: true,
      success: true,
    });
    expect(result.editPath).toBeUndefined();
    expect(result.redirectPath).toBeUndefined();
  });

  it('creates a confirmed Contact Us page with hero and form blocks', async () => {
    const revalidated: string[] = [];
    const { database, supabase } = createMockSupabase();
    const input = {
      contactEmail: 'info@nextblock.dev',
      title: 'Contact Us',
    };

    const preview = await executeCreateCmsPage(input, {
      actorUserId: 'admin_1',
      revalidatePath: (path) => revalidated.push(path),
      supabase,
    });

    const confirmed = expectConfirmation(preview);
    expect(database.pages).toHaveLength(0);
    expect(database.blocks).toHaveLength(0);

    const result = await executeCreateCmsPage(input, {
      actorUserId: 'admin_1',
      latestUserMessage: confirmed.confirmationPhrase,
      revalidatePath: (path) => revalidated.push(path),
      supabase,
    });

    expect(result).toMatchObject({
      blockCount: 2,
      contentType: 'page',
      editPath: '/cms/pages/1/edit',
      entityId: 1,
      mutationExecuted: true,
      slug: 'contact-us',
      success: true,
      title: 'Contact Us',
    });
    expect(database.pages[0]).toMatchObject({
      author_id: 'admin_1',
      language_id: 1,
      slug: 'contact-us',
      status: 'draft',
      title: 'Contact Us',
    });
    expect(database.blocks.map((block) => block.block_type)).toEqual(['section', 'form']);
    expect(database.blocks[1].content).toMatchObject({
      submit_button_text: 'Send Message',
    });
    // The destination must NEVER be written into block content: content is handed whole
    // to a client component, so an address stored here is published in the page payload.
    // A generated form resolves its recipient from CMS -> Messages instead.
    expect(database.blocks[1].content).not.toHaveProperty('recipient_email');
    // Page mutations also bust "/" so a translated homepage (any slug) stays fresh.
    expect(revalidated).toEqual(['/cms/pages/1/edit', '/contact-us', '/', '/cms/pages']);
  });

  it('creates a translated page in the supplied translation group', async () => {
    const { database, supabase } = createMockSupabase({
      languages: [
        { code: 'en', id: 1, is_active: true, name: 'English' },
        { code: 'fr', id: 2, is_active: true, name: 'French' },
      ],
      pages: [
        {
          id: 1,
          language_id: 1,
          slug: 'contact-us',
          title: 'Contact Us',
          translation_group_id: 'group-contact',
        },
      ],
    });

    const result = await executeConfirmed(
      executeCreateCmsPage,
      {
        contactEmail: 'info@nextblock.dev',
        languageCode: 'French',
        slug: 'contactez-nous',
        title: 'Contactez-nous',
        translationGroupId: 'group-contact',
      },
      { actorUserId: 'admin_1', revalidatePath: () => undefined, supabase }
    );

    expect(result).toMatchObject({
      contentType: 'page',
      entityId: 2,
      mutationExecuted: true,
      slug: 'contactez-nous',
      success: true,
    });
    expect(database.pages[1]).toMatchObject({
      language_id: 2,
      slug: 'contactez-nous',
      title: 'Contactez-nous',
      translation_group_id: 'group-contact',
    });
  });

  it('refuses to create a second page translation for an existing group language', async () => {
    const { database, supabase } = createMockSupabase({
      languages: [
        { code: 'en', id: 1, is_active: true, name: 'English' },
        { code: 'fr', id: 2, is_active: true, name: 'French' },
      ],
      pages: [
        {
          id: 1,
          language_id: 1,
          slug: 'contact-us',
          title: 'Contact Us',
          translation_group_id: 'group-contact',
        },
        {
          id: 2,
          language_id: 2,
          slug: 'contactez-nous',
          title: 'Contactez-nous',
          translation_group_id: 'group-contact',
        },
      ],
    });

    const result = await executeCreateCmsPage(
      {
        languageCode: 'fr',
        slug: 'contact-fr-copy',
        title: 'Contact FR Copy',
        translationGroupId: 'group-contact',
      },
      { actorUserId: 'admin_1', supabase }
    );

    expect(result).toMatchObject({
      duplicateTranslation: true,
      mutationExecuted: false,
      success: false,
    });
    expect(database.pages).toHaveLength(2);
  });

  it('normalizes common AI-created heading and form block shapes before confirmation', async () => {
    const { database, supabase } = createMockSupabase();
    const input = {
      blocks: [
        {
          blockType: 'heading' as const,
          content: {
            text: 'Contact Us',
          },
        },
        {
          blockType: 'form' as const,
          content: {
            fields: [
              { label: 'Name', type: 'text' },
              { label: 'Email', type: 'email' },
              { label: 'Message', type: 'textarea' },
            ],
            recipient_email: 'info@nextblock.dev',
          },
        },
      ],
      title: 'Contact Us',
    };

    const result = await executeConfirmed(
      executeCreateCmsPage,
      input,
      { actorUserId: 'admin_1', revalidatePath: () => undefined, supabase }
    );

    expect(result).toMatchObject({
      blockCount: 2,
      mutationExecuted: true,
      slug: 'contact-us',
      success: true,
    });
    expect(database.blocks[0].content).toMatchObject({
      level: 1,
      text_content: 'Contact Us',
    });
    expect(database.blocks[1].content).toMatchObject({
      recipient_email: 'info@nextblock.dev',
      submit_button_text: 'Send Message',
      success_message: 'Thanks for reaching out. We will reply as soon as possible.',
    });
    expect(database.blocks[1].content.fields).toEqual([
      expect.objectContaining({ field_type: 'text', is_required: true, label: 'Name', temp_id: 'field-1' }),
      expect.objectContaining({ field_type: 'email', is_required: true, label: 'Email', temp_id: 'field-2' }),
      expect.objectContaining({ field_type: 'textarea', is_required: true, label: 'Message', temp_id: 'field-3' }),
    ]);
  });

  it('creates confirmed posts and products with safe defaults', async () => {
    const { database, supabase } = createMockSupabase();

    const postResult = await executeConfirmed(
      executeCreateCmsPost,
      {
        excerpt: 'Latest launch details.',
        title: 'Launch Notes',
      },
      { actorUserId: 'admin_1', revalidatePath: () => undefined, supabase }
    );

    expect(postResult).toMatchObject({
      contentType: 'post',
      editPath: '/cms/posts/1/edit',
      mutationExecuted: true,
      slug: 'launch-notes',
      success: true,
    });
    expect(database.posts[0]).toMatchObject({
      author_id: 'admin_1',
      slug: 'launch-notes',
      status: 'draft',
      title: 'Launch Notes',
    });

    const productResult = await executeConfirmed(
      executeCreateCmsProduct,
      {
        title: 'Studio Tee',
      },
      { revalidatePath: () => undefined, supabase }
    );

    expect(productResult).toMatchObject({
      contentType: 'product',
      editPath: '/cms/products/1/edit',
      mutationExecuted: true,
      slug: 'studio-tee',
      success: true,
    });
    expect(database.products[0]).toMatchObject({
      is_taxable: true,
      payment_provider: 'stripe',
      price: 0,
      product_type: 'physical',
      sku: 'STUDIOTEE',
      status: 'draft',
      stock: 0,
    });
  });

  it('creates a product with an imported main image and a full description in one confirmed call', async () => {
    const { database, supabase } = createMockSupabase();
    const importedUrls: string[] = [];

    const result = await executeConfirmed(
      executeCreateCmsProduct,
      {
        description_json: {
          content: [
            { content: [{ text: 'Traditional herbal support.', type: 'text' }], type: 'paragraph' },
          ],
          type: 'doc',
        },
        images: ['https://cdn.example.com/products/chanca-piedra-500.jpg'],
        price: 25,
        short_description: 'Traditional herbal support.',
        title: 'Chanca Piedra',
      },
      {
        importExternalImage: async ({ url }: { url: string }) => {
          importedUrls.push(url);
          return { id: 'media-chanca-1' };
        },
        revalidatePath: () => undefined,
        supabase,
      }
    );

    expect(result).toMatchObject({
      contentType: 'product',
      imageCount: 1,
      mutationExecuted: true,
      slug: 'chanca-piedra',
      success: true,
    });
    expect(importedUrls).toEqual(['https://cdn.example.com/products/chanca-piedra-500.jpg']);
    // The image is handed to createProduct as product_media, and the body copy
    // survives as description_json — both in the single confirmed call.
    expect(database.products[0].product_media).toEqual([{ media_id: 'media-chanca-1' }]);
    expect(database.products[0].description_json).toMatchObject({ type: 'doc' });
    // price is major units on the way in, minor units in storage.
    expect(database.products[0].price).toBe(2500);
  });

  it('creates Product Description Blocks parented by product_id', async () => {
    const { database, supabase } = createMockSupabase();

    const result = (await executeConfirmed(
      executeCreateCmsProduct,
      {
        blocks: [
          { blockType: 'heading', content: { level: 2, text_content: 'Benefits' } },
          { blockType: 'text', content: { html_content: '<p>Traditional herbal support.</p>' } },
        ],
        images: ['https://cdn.example.com/a.jpg'],
        price: 25,
        title: 'Chanca Piedra',
      },
      {
        actorUserId: 'admin-1',
        importExternalImage: async () => ({ id: 'media-1' }),
        revalidatePath: () => undefined,
        supabase,
      }
    )) as { blockCount: number; entityId: string; success: boolean };

    expect(result.success).toBe(true);
    expect(result.blockCount).toBe(2);

    const productId = database.products[0].id;
    const productBlocks = database.blocks
      .filter((row) => row.product_id === productId)
      .sort((a, b) => a.order - b.order);

    expect(productBlocks).toHaveLength(2);
    expect(productBlocks.map((row) => row.block_type)).toEqual(['heading', 'text']);
    // check_exactly_one_parent: page_id/post_id must stay null for a product block.
    expect(productBlocks.every((row) => row.page_id === null && row.post_id === null)).toBe(true);
  });

  it('names the description blocks in the product confirmation', async () => {
    const { supabase } = createMockSupabase();

    const preview = (await executeCreateCmsProduct(
      {
        blocks: [{ blockType: 'text', content: { html_content: '<p>Copy.</p>' } }],
        price: 25,
        title: 'Chanca Piedra',
      },
      { actorUserId: 'admin-1', supabase }
    )) as { preview: Record<string, unknown> };

    expect(preview.preview['blockCount']).toBe(1);
  });

  it('inserts a content block on a product that is not open in the editor', async () => {
    const { database, supabase } = createMockSupabase({
      products: [
        {
          id: 'prod-7',
          language_id: 1,
          slug: 'chanca-piedra',
          status: 'draft',
          title: 'Chanca Piedra',
        },
      ],
    });

    const result = (await executeConfirmed(
      executeInsertContentBlock,
      {
        block: { blockType: 'text', content: { html_content: '<p>Extra copy.</p>' } },
        contentType: 'product',
        position: 'end',
        slug: 'chanca-piedra',
      },
      { actorUserId: 'admin-1', revalidatePath: () => undefined, supabase }
    )) as { contentType: string; mutationExecuted: boolean };

    expect(result).toMatchObject({ contentType: 'product', mutationExecuted: true });
    expect(database.blocks.filter((row) => row.product_id === 'prod-7')).toHaveLength(1);
  });

  it('builds the product body from description_html', async () => {
    const { database, supabase } = createMockSupabase();

    const result = (await executeConfirmed(
      executeCreateCmsProduct,
      {
        description_html:
          '<h2>Benefits</h2><p>Traditional herbal support.</p><ul><li>Kidney health</li></ul>',
        price: 25,
        short_description: 'Traditional herbal support.',
        title: 'Chanca Piedra',
      },
      { revalidatePath: () => undefined, supabase }
    )) as { success: boolean };

    expect(result.success).toBe(true);

    const doc = database.products[0].description_json;
    expect(doc.type).toBe('doc');
    expect(doc.content.map((node: any) => node.type)).toEqual([
      'heading',
      'paragraph',
      'bulletList',
    ]);
    expect(JSON.stringify(doc)).toContain('Traditional herbal support.');
  });

  it('accepts every body shape a model plausibly sends for description_json', async () => {
    const shapes: Array<[string, unknown]> = [
      ['html string', '<p>Body copy.</p>'],
      ['plain text', 'Body copy.'],
      ['bare node array', [{ content: [{ text: 'Body copy.', type: 'text' }], type: 'paragraph' }]],
      [
        'content without doc type',
        { content: [{ content: [{ text: 'Body copy.', type: 'text' }], type: 'paragraph' }] },
      ],
      ['single node object', { content: [{ text: 'Body copy.', type: 'text' }], type: 'paragraph' }],
      [
        'correct document',
        {
          content: [{ content: [{ text: 'Body copy.', type: 'text' }], type: 'paragraph' }],
          type: 'doc',
        },
      ],
    ];

    for (const [label, description_json] of shapes) {
      const { database, supabase } = createMockSupabase();

      const result = (await executeConfirmed(
        executeCreateCmsProduct,
        { description_json, price: 25, title: 'Chanca Piedra' },
        { revalidatePath: () => undefined, supabase }
      )) as { success: boolean };

      expect(result.success, label).toBe(true);

      const doc = database.products[0].description_json;
      expect(doc?.type, label).toBe('doc');
      expect(JSON.stringify(doc), label).toContain('Body copy.');
    }
  });

  it('never stores an empty description document', async () => {
    // An empty doc passes validation but renders as a blank slab and hides the
    // storefront's "no description" fallback, so it must stay null.
    for (const body of [
      { description_json: { content: [], type: 'doc' } },
      { description_html: '   ' },
      { description_html: '<p></p>' },
    ]) {
      const { database, supabase } = createMockSupabase();

      await executeConfirmed(
        executeCreateCmsProduct,
        { ...body, price: 25, title: 'Chanca Piedra' },
        { revalidatePath: () => undefined, supabase }
      );

      expect(database.products[0].description_json ?? null).toBeNull();
    }
  });

  it('previews a description supplied as html so the user sees it is included', async () => {
    const { supabase } = createMockSupabase();

    const preview = (await executeCreateCmsProduct(
      { description_html: '<p>Body copy.</p>', price: 25, title: 'Chanca Piedra' },
      { supabase }
    )) as { preview: Record<string, unknown> };

    expect(Number(preview.preview['descriptionLength'])).toBeGreaterThan(0);
  });

  it('still creates the product when the image import fails, and reports why', async () => {
    const { database, supabase } = createMockSupabase();

    const result = (await executeConfirmed(
      executeCreateCmsProduct,
      {
        images: ['https://cdn.example.com/broken.jpg'],
        price: 25,
        title: 'Chanca Piedra',
      },
      {
        importExternalImage: async () => ({ error: 'remote host returned 404' }),
        revalidatePath: () => undefined,
        supabase,
      }
    )) as { imageCount: number; imageError?: string; success: boolean };

    // Losing the photo must not cost the user the product and its copy.
    expect(result.success).toBe(true);
    expect(result.imageCount).toBe(0);
    expect(result.imageError).toContain('404');
    expect(database.products[0]).toMatchObject({ slug: 'chanca-piedra' });
    expect(database.products[0].product_media).toEqual([]);
  });

  it('previews the images and description a product will be created with', async () => {
    const { supabase } = createMockSupabase();

    const preview = (await executeCreateCmsProduct(
      {
        description_json: {
          content: [{ content: [{ text: 'Body copy.', type: 'text' }], type: 'paragraph' }],
          type: 'doc',
        },
        images: ['https://cdn.example.com/a.jpg'],
        price: 25,
        title: 'Chanca Piedra',
      },
      { importExternalImage: async () => ({ id: 'unused' }), supabase }
    )) as { preview: Record<string, unknown>; requiresConfirmation: boolean };

    expect(preview.requiresConfirmation).toBe(true);
    expect(preview.preview).toMatchObject({ imageCount: 1 });
    expect(Number(preview.preview['descriptionLength'])).toBeGreaterThan(0);
  });

  it('returns duplicate slug failures without mutating', async () => {
    const { database, supabase } = createMockSupabase({
      pages: [
        {
          id: 7,
          language_id: 1,
          slug: 'contact-us',
          title: 'Contact Us',
        },
      ],
    });

    const result = await executeCreateCmsPage(
      {
        contactEmail: 'info@nextblock.dev',
        title: 'Contact Us',
      },
      { actorUserId: 'admin_1', supabase }
    );

    expect(result).toMatchObject({
      duplicate: true,
      mutationExecuted: false,
      success: false,
    });
    expect(database.pages).toHaveLength(1);
    expect(database.blocks).toHaveLength(0);
  });

  it('updates single fields with confirmation and status aliases', async () => {
    const { database, supabase } = createMockSupabase({
      languages: [
        { code: 'en', id: 1, is_active: true, name: 'English' },
        { code: 'fr', id: 2, is_active: true, name: 'French' },
      ],
      pages: [
        {
          id: 3,
          language_id: 1,
          slug: 'about',
          status: 'draft',
          title: 'About',
        },
      ],
    });

    const result = await executeConfirmed(
      executeUpdateCmsItemField,
      {
        contentType: 'page',
        entityId: 3,
        field: 'status',
        value: 'public',
      },
      { revalidatePath: () => undefined, supabase }
    );

    expect(result).toMatchObject({
      contentType: 'page',
      entityId: 3,
      field: 'status',
      mutationExecuted: true,
      success: true,
    });
    expect(database.pages[0].status).toBe('published');

    const languageResult = await executeConfirmed(
      executeUpdateCmsItemField,
      {
        contentType: 'page',
        entityId: 3,
        field: 'language',
        value: 'French',
      },
      { revalidatePath: () => undefined, supabase }
    );

    expect(languageResult).toMatchObject({
      contentType: 'page',
      field: 'language_id',
      mutationExecuted: true,
      success: true,
    });
    expect(database.pages[0].language_id).toBe(2);
  });

  it('updates product prices through ecommerce helpers and refuses scheduled specials', async () => {
    const product = {
      id: 'prod_1',
      is_taxable: true,
      language_id: 1,
      payment_provider: 'stripe',
      price: 1000,
      product_type: 'physical',
      sale_price: null,
      short_description: '',
      sku: 'STUDIO-TEE',
      slug: 'studio-tee',
      status: 'draft',
      stock: 0,
      title: 'Studio Tee',
      upc: '',
    };
    const { database, supabase } = createMockSupabase({
      products: [product],
    });

    const priceResult = await executeConfirmed(
      executeUpdateCmsItemField,
      {
        contentType: 'product',
        entityId: 'prod_1',
        field: 'price',
        value: 19.99,
      },
      { revalidatePath: () => undefined, supabase }
    );

    expect(priceResult).toMatchObject({
      contentType: 'product',
      field: 'price',
      mutationExecuted: true,
      success: true,
    });
    expect(database.products[0].price).toBe(1999);

    const saleResult = await executeConfirmed(
      executeUpdateCmsItemField,
      {
        contentType: 'product',
        entityId: 'prod_1',
        field: 'sale_price',
        value: 9.99,
      },
      { revalidatePath: () => undefined, supabase }
    );

    expect(saleResult).toMatchObject({
      contentType: 'product',
      field: 'sale_price',
      mutationExecuted: true,
      success: true,
    });
    expect(database.products[0].sale_price).toBe(999);

    const scheduledResult = await executeUpdateCmsItemField(
      {
        contentType: 'product',
        endsAt: '2026-06-01',
        entityId: 'prod_1',
        field: 'sale_price',
        startsAt: '2026-05-01',
        value: 8.99,
      },
      { supabase }
    );

    expect(scheduledResult).toMatchObject({
      mutationExecuted: false,
      success: false,
      unsupported: true,
    });
    expect(database.products[0].sale_price).toBe(999);
  });

  it('update_cms_item_field patches a product field surgically, preserving variants, sale schedule, and canonical', async () => {
    const { database, supabase } = createMockSupabase({
      product_variants: [
        { id: 'var-1', product_id: 'prod_2', sku: 'SERUM-30', stock_quantity: 5 },
      ],
      products: [
        {
          custom_canonical: 'https://example.com/serum',
          id: 'prod_2',
          language_id: 1,
          price: 2000,
          sale_end_at: '2026-06-01T00:00:00Z',
          sale_price: 1500,
          sale_start_at: '2026-05-01T00:00:00Z',
          slug: 'serum',
          status: 'active',
          stock: 7,
          title: 'Serum',
        },
      ],
    });

    const result = await executeConfirmed(
      executeUpdateCmsItemField,
      { contentType: 'product', entityId: 'prod_2', field: 'stock', value: 12 },
      { revalidatePath: () => undefined, supabase }
    );

    expect(result).toMatchObject({
      contentType: 'product',
      field: 'stock',
      mutationExecuted: true,
      success: true,
    });

    const product = database.products.find((row) => row.id === 'prod_2');
    expect(product?.stock).toBe(12);
    // A full-product rewrite would have nulled the sale schedule + canonical and
    // re-round-tripped the price; the surgical patch leaves everything else alone.
    expect(product).toMatchObject({
      custom_canonical: 'https://example.com/serum',
      price: 2000,
      sale_end_at: '2026-06-01T00:00:00Z',
      sale_price: 1500,
      sale_start_at: '2026-05-01T00:00:00Z',
      status: 'active',
      title: 'Serum',
    });
    // Variants are never touched (the code doesn't reference product_variants).
    expect(database.product_variants).toHaveLength(1);
    expect(database.product_variants[0]).toMatchObject({ id: 'var-1', stock_quantity: 5 });
  });

  it('prepares and confirms deleting page translation groups and nav links', async () => {
    const { database, supabase } = createMockSupabase({
      navigation_items: [
        { id: 1, label: 'Contact', language_id: 1, menu_key: 'HEADER', order: 0, url: '/contact' },
        { id: 2, label: 'Contact FR', language_id: 2, menu_key: 'HEADER', order: 0, url: '/contactez-nous' },
      ],
      pages: [
        {
          id: 1,
          language_id: 1,
          slug: 'contact',
          title: 'Contact',
          translation_group_id: 'group-contact',
        },
        {
          id: 2,
          language_id: 2,
          slug: 'contactez-nous',
          title: 'Contactez-nous',
          translation_group_id: 'group-contact',
        },
      ],
    });

    const prepared = await executePrepareDeleteCmsItem(
      { contentType: 'page', entityId: 1 },
      { supabase }
    );

    expectConfirmation(prepared);
    expect(prepared).toMatchObject({
      preparedDelete: true,
      preview: {
        affectedCount: 2,
        collectionPath: '/cms/pages',
        contentType: 'page',
        navigationLinkCount: 2,
        summary:
          'Delete page "Contact" (contact), including 2 language versions and 2 navigation links.',
      },
    });

    const result = await executeDeleteCmsItem(
      { contentType: 'page', entityId: 1 },
      {
        latestUserMessage: prepared.confirmationPhrase,
        revalidatePath: () => undefined,
        supabase,
      }
    );

    expect(result).toMatchObject({
      affectedCount: 2,
      collectionPath: '/cms/pages',
      contentType: 'page',
      mutationExecuted: true,
      redirectPath: '/cms/pages',
      success: true,
    });
    expect(database.pages).toEqual([]);
    expect(database.navigation_items).toEqual([]);
  });

  it('deletes a confirmed product without deleting other products', async () => {
    const { database, supabase } = createMockSupabase({
      products: [
        { id: 'prod_1', slug: 'studio-tee', title: 'Studio Tee' },
        { id: 'prod_2', slug: 'studio-hat', title: 'Studio Hat' },
      ],
    });

    const result = await executeConfirmed(
      executeDeleteCmsItem,
      { contentType: 'product', entityId: 'prod_1' },
      { revalidatePath: () => undefined, supabase }
    );

    expect(result).toMatchObject({
      affectedCount: 1,
      collectionPath: '/cms/products',
      contentType: 'product',
      mutationExecuted: true,
      redirectPath: '/cms/products',
      success: true,
    });
    expect(database.products).toEqual([
      { id: 'prod_2', slug: 'studio-hat', title: 'Studio Hat' },
    ]);
  });
});

describe('custom block instances in the typed content tools', () => {
  const promoCard = {
    fields: [
      { key: 'headline', required: true, type: 'text' },
      { key: 'body', type: 'rich-text' },
      { key: 'photo', type: 'image_r2' },
    ],
    name: 'Promo card',
    slug: 'promo-card',
  };

  it('creates a page with a custom block at the top level and nested in a section', async () => {
    const { database, supabase } = createMockSupabase({ custom_block_definitions: [promoCard] });

    const result = await executeConfirmed(
      executeCreateCmsPage,
      {
        blocks: [
          {
            blockType: 'section',
            content: {
              column_blocks: [
                [
                  { block_type: 'heading', content: { level: 2, text_content: 'Deals' } },
                  { block_type: 'promo-card', content: { headline: 'Spring sale', body: '<p>20% off</p>' } },
                ],
              ],
            },
          },
          { blockType: 'promo-card', content: { headline: 'Members only', photo: null } },
        ],
        status: 'published',
        title: 'Deals',
      },
      { actorUserId: 'admin-1', revalidatePath: () => undefined, supabase }
    );

    expect(result).toMatchObject({ blockCount: 2, mutationExecuted: true, success: true });
    const blocks = database.blocks.sort((a, b) => a.order - b.order);
    expect(blocks[0].block_type).toBe('section');
    expect(blocks[0].content.column_blocks[0][1]).toMatchObject({
      block_type: 'promo-card',
      content: { body: '<p>20% off</p>', headline: 'Spring sale' },
    });
    expect(blocks[1]).toMatchObject({ block_type: 'promo-card', content: { headline: 'Members only', photo: null } });
  });

  it('refuses an unknown slug and content that does not match the definition', async () => {
    const { supabase } = createMockSupabase({ custom_block_definitions: [promoCard] });
    const context = { actorUserId: 'admin-1', supabase };

    await expect(
      executeCreateCmsPage(
        { blocks: [{ blockType: 'no-such-block', content: { headline: 'x' } }], title: 'Bad' },
        context
      )
    ).rejects.toThrow(/unsupported block type "no-such-block"/);

    await expect(
      executeCreateCmsPage(
        { blocks: [{ blockType: 'promo-card', content: { title: 'Wrong key' } }], title: 'Bad' },
        context
      )
    ).rejects.toThrow(/Unknown field "title".*Field "headline" is required/);

    await expect(
      executeCreateCmsPage(
        {
          blocks: [
            {
              blockType: 'section',
              content: { column_blocks: [[{ block_type: 'promo-card', content: { headline: 42 } }]] },
            },
          ],
          title: 'Bad',
        },
        context
      )
    ).rejects.toThrow(/"headline" must be a string/);
  });

  it('translates the text fields of a custom block when translating a page', async () => {
    const { database, supabase } = createMockSupabase({
      blocks: [
        {
          block_type: 'promo-card',
          content: { body: '<p>Fresh bread daily.</p>', headline: 'Spring sale', photo: null },
          id: 10,
          language_id: 1,
          order: 0,
          page_id: 7,
          post_id: null,
        },
      ],
      custom_block_definitions: [promoCard],
      languages: [
        { code: 'en', id: 1, is_default: true },
        { code: 'fr', id: 2 },
      ],
      pages: [
        { id: 7, language_id: 1, slug: 'deals', status: 'published', title: 'Deals', translation_group_id: 'group-deals' },
      ],
    });

    await executeConfirmed(
      executeTranslatePage,
      {
        targetLanguageCode: 'fr',
        title: 'Aubaines',
        translations: { 'Fresh bread daily.': 'Du pain frais chaque jour.', 'Spring sale': 'Vente de printemps' },
      },
      { actorUserId: 'admin-1', pageContext: { contentType: 'page', entityId: 7 }, revalidatePath: () => undefined, supabase }
    );

    const frPage = database.pages.find((page) => page.language_id === 2);
    const frBlock = database.blocks.find((block) => block.page_id === frPage?.id);
    expect(frBlock).toMatchObject({
      block_type: 'promo-card',
      content: { body: '<p>Du pain frais chaque jour.</p>', headline: 'Vente de printemps', photo: null },
    });
  });
});

describe('block-level edits over MCP (skipConfirmation + cmsTarget)', () => {
  const homePage = {
    id: 7,
    language_id: 1,
    slug: 'home',
    title: 'Home',
    translation_group_id: 'group-home',
  };

  const threeBlocks = () => [
    {
      block_type: 'heading',
      content: { level: 1, text_content: 'Title' },
      id: 1,
      language_id: 1,
      order: 0,
      page_id: 7,
      post_id: null,
    },
    {
      block_type: 'text',
      content: { html_content: '<p>Middle</p>' },
      id: 2,
      language_id: 1,
      order: 1,
      page_id: 7,
      post_id: null,
    },
    {
      block_type: 'button',
      content: { text: 'Go', url: '/go' },
      id: 3,
      language_id: 1,
      order: 2,
      page_id: 7,
      post_id: null,
    },
  ];

  const mcpContext = (supabase: unknown) => ({
    revalidatePath: () => undefined,
    skipConfirmation: true,
    supabase,
  });

  it('updates one block by id and leaves its siblings, their order and their ids untouched', async () => {
    const { database, supabase } = createMockSupabase({ blocks: threeBlocks(), pages: [homePage] });
    const before = JSON.parse(JSON.stringify(database.blocks));

    const result = await executeUpdateContentBlock(
      {
        blockId: 2,
        blockType: 'text',
        cmsTarget: { contentType: 'page', slug: 'home' },
        content: { html_content: '<p>Edited over MCP</p>' },
      },
      mcpContext(supabase)
    );

    expect(result).toMatchObject({ blockId: 2, mutationExecuted: true, success: true });
    expect(database.blocks).toHaveLength(3);

    const byId = new Map(database.blocks.map((block: any) => [block.id, block]));

    expect(byId.get(2)?.content).toEqual({ html_content: '<p>Edited over MCP</p>' });
    // Siblings are byte-for-byte what they were, including their order.
    expect(byId.get(1)).toEqual(before[0]);
    expect(byId.get(3)).toEqual(before[2]);
  });

  it('is idempotent: repeating the identical update leaves the page in the same state', async () => {
    const { database, supabase } = createMockSupabase({ blocks: threeBlocks(), pages: [homePage] });
    const input = {
      blockId: 2,
      blockType: 'text',
      cmsTarget: { contentType: 'page' as const, slug: 'home' },
      content: { html_content: '<p>Same edit</p>' },
    };

    // Convergence is about content, order and identity; the executor bumps
    // `updated_at` on every write, which is a timestamp, not state.
    const snapshot = () =>
      database.blocks.map((block: any) => {
        const clone = JSON.parse(JSON.stringify(block));
        delete clone.updated_at;
        return clone;
      });

    await executeUpdateContentBlock(input, mcpContext(supabase));
    const afterFirst = snapshot();

    await executeUpdateContentBlock(input, mcpContext(supabase));

    expect(database.blocks).toHaveLength(3);
    expect(snapshot()).toEqual(afterFirst);
    expect(getCortexMcpToolAnnotations('update_content_block')).toMatchObject({
      destructiveHint: false,
      idempotentHint: true,
    });
  });

  it('is NOT idempotent for insert_content_block — a retry inserts a second block, which is what its annotation says', async () => {
    const { database, supabase } = createMockSupabase({ blocks: threeBlocks(), pages: [homePage] });
    const input = {
      anchorBlockId: 2,
      block: { blockType: 'text', content: { html_content: '<p>Appended</p>' } },
      contentType: 'page' as const,
      position: 'after' as const,
      slug: 'home',
    };

    await executeInsertContentBlock(input, mcpContext(supabase));
    expect(database.blocks).toHaveLength(4);

    await executeInsertContentBlock(input, mcpContext(supabase));
    expect(database.blocks).toHaveLength(5);

    // The three original blocks are still there with their ids; the two copies sit
    // after the anchor and everything below shifted.
    const ids = database.blocks.map((block: any) => block.id).sort();
    expect(ids).toEqual(expect.arrayContaining([1, 2, 3]));
    expect(
      database.blocks.filter((block: any) => block.content?.html_content === '<p>Appended</p>')
    ).toHaveLength(2);

    // Change the executor to dedupe and this line is what tells you to flip the hint.
    expect(getCortexMcpToolAnnotations('insert_content_block')).toMatchObject({
      idempotentHint: false,
    });
  });
});
