import 'server-only';

import { NextResponse } from 'next/server';
import {
  createClient,
  getServiceRoleSupabaseClient,
  verifyPackageOnline,
} from '@nextblock-cms/db/server';

export const dynamic = 'force-dynamic';

/** How many products a single search returns before the UI asks for a narrower query. */
const PRODUCT_PAGE_SIZE = 50;
/** Guard against an unbounded `ids` list when hydrating labels for an existing selection. */
const MAX_HYDRATED_IDS = 100;

export interface ProductPickerCategory {
  id: string;
  name: string;
  slug: string;
}

export interface ProductPickerProduct {
  id: string;
  title: string;
  slug: string | null;
  sku: string | null;
  status: string | null;
  languageCode: string | null;
  translationGroupId: string | null;
}

/**
 * PostgREST parses `,`, `.`, `(` and `)` inside an `or(...)` filter, so anything
 * the author types has to be stripped before it is interpolated into one.
 */
function sanitizeSearchTerm(term: string): string {
  return term.replace(/[,().*%\\]/g, ' ').trim().slice(0, 80);
}

/**
 * Options for the Product Grid block pickers: every category plus a page of
 * products (optionally filtered by `search`). `ids` hydrates labels for an
 * existing selection whose products fall outside the current page.
 */
export async function GET(request: Request) {
  try {
    const supabase = createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (!profile || !['ADMIN', 'WRITER'].includes(profile.role)) {
      return NextResponse.json(
        { error: 'Forbidden: Insufficient permissions' },
        { status: 403 }
      );
    }

    // Fail closed: without the ecommerce package there is no product catalog to
    // browse, and the blocks that use this route are hidden from the picker.
    if (!(await verifyPackageOnline('ecommerce'))) {
      return NextResponse.json(
        { error: 'The ecommerce package is not active.' },
        { status: 403 }
      );
    }

    const url = new URL(request.url);
    const search = sanitizeSearchTerm(url.searchParams.get('search') ?? '');
    const ids = (url.searchParams.get('ids') ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .slice(0, MAX_HYDRATED_IDS);

    // Reading the catalog is admin work behind the role check above.
    const admin = getServiceRoleSupabaseClient();

    const productColumns =
      'id, title, slug, sku, status, translation_group_id, languages(code)';

    let productsQuery = admin
      .from('products')
      .select(productColumns)
      .order('created_at', { ascending: false })
      // Fetch one extra row so the UI can tell the author the list was truncated.
      .limit(PRODUCT_PAGE_SIZE + 1);

    if (search) {
      productsQuery = productsQuery.or(`title.ilike.%${search}%,sku.ilike.%${search}%`);
    }

    const [categoriesResult, productsResult, selectedResult] = await Promise.all([
      admin.from('categories').select('id, name, slug').order('name', { ascending: true }),
      productsQuery,
      ids.length > 0
        ? admin.from('products').select(productColumns).in('id', ids)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (categoriesResult.error) throw categoriesResult.error;
    if (productsResult.error) throw productsResult.error;
    if (selectedResult.error) throw selectedResult.error;

    const toPickerProduct = (row: any): ProductPickerProduct => ({
      id: row.id,
      title: row.title,
      slug: row.slug ?? null,
      sku: row.sku ?? null,
      status: row.status ?? null,
      languageCode: row.languages?.code ?? null,
      translationGroupId: row.translation_group_id ?? null,
    });

    const productRows = (productsResult.data ?? []) as any[];
    const hasMore = productRows.length > PRODUCT_PAGE_SIZE;
    const products = productRows.slice(0, PRODUCT_PAGE_SIZE).map(toPickerProduct);

    // Merge the hydrated selection in so already-chosen products always render
    // with a real label, even when a search hides them.
    const byId = new Map(products.map((product) => [product.id, product]));
    for (const row of (selectedResult.data ?? []) as any[]) {
      if (!byId.has(row.id)) byId.set(row.id, toPickerProduct(row));
    }

    return NextResponse.json(
      {
        categories: (categoriesResult.data ?? []) as ProductPickerCategory[],
        products: Array.from(byId.values()),
        hasMore,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('[Product Picker API] Unexpected error:', error);
    return NextResponse.json(
      { error: 'Failed to load product picker options.' },
      { status: 500 }
    );
  }
}
