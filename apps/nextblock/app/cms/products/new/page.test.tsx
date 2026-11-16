import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "Create <language> Translation" prefills the new product from a product of the translation group.
 * Categories belong to the group: createProduct() syncs the form's category_ids to every product in
 * it (syncCategoriesForTranslationGroup). The prefill left them out, so the form started with none
 * and saving the translation removed the categories of the whole group, on every new French
 * translation the bilingual rule asks for (verification 2026-11-15). The page is called directly and
 * the element it returns inspected: nothing renders.
 */

const GROUP_ID = '523e4567-e89b-12d3-a456-426614174000';
const SOURCE_ID = '123e4567-e89b-12d3-a456-426614174000';

const mocks = vi.hoisted(() => ({
  getProduct: vi.fn(),
  getProductCategories: vi.fn(),
}));

function Stub({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

/** The PostgREST builder the page awaits: the group's product ids and the currencies. */
function makeSupabase() {
  return {
    from: (table: string) => {
      const answer = () => (table === 'products' ? { data: [{ id: SOURCE_ID }], error: null } : { data: [], error: null });
      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'order', 'limit']) chain[method] = () => chain;
      chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(answer()).then(resolve, reject);
      return chain;
    },
  };
}

vi.mock('@nextblock-cms/db/server', () => ({
  verifyPackageOnline: async () => true,
  getActiveLanguagesServerSide: async () => [
    { id: 1, code: 'en', name: 'English', is_default: true },
    { id: 2, code: 'fr', name: 'French', is_default: false },
  ],
  createClient: () => makeSupabase(),
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('next/link', () => ({ default: Stub }));
vi.mock('lucide-react', () => ({ ArrowLeft: Stub }));
vi.mock('@nextblock-cms/ui', () => ({ Badge: Stub, Button: Stub }));
vi.mock('@nextblock-cms/ecommerce/server', () => ({
  createProductAction: async () => ({ success: true }),
  getGlobalProductAttributes: async () => [],
  getEnabledPaymentProviders: async () => ['stripe'],
  getProduct: mocks.getProduct,
  getStoreConfigStatus: async () => ({}),
  normalizeCurrencyRecord: (currency: unknown) => currency,
  getCategoriesWithCount: async () => [],
  getProductCategories: mocks.getProductCategories,
}));
vi.mock('../ProductFormClientShell', () => ({ default: function ProductFormClientShell() { return null; } }));

import NewProductPage from './page';
import ProductFormClientShell from '../ProductFormClientShell';

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

async function shellProps(searchParams: Record<string, string>) {
  const tree = await NewProductPage({ searchParams: Promise.resolve(searchParams) });
  const element = findElement(tree, ProductFormClientShell);
  if (!element) throw new Error('no ProductFormClientShell in the page');
  return element.props;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProduct.mockResolvedValue({
    data: {
      id: SOURCE_ID,
      title: 'Pro plugin',
      slug: 'pro-plugin',
      sku: 'PRO',
      language_id: 1,
      translation_group_id: GROUP_ID,
      prices: { USD: 4900 },
      product_variants: [],
      product_media: [],
    },
    error: null,
  });
  mocks.getProductCategories.mockResolvedValue([
    { id: 'cat-plugins', name: 'Plugins' },
    { id: 'cat-pro', name: 'Pro' },
  ]);
});

describe('the new-product page creating a translation', () => {
  it("prefills the translation with the group's categories, which saving it syncs to the whole group", async () => {
    const props = await shellProps({ from_group: GROUP_ID, target_lang_id: '2' });

    expect(mocks.getProductCategories).toHaveBeenCalledWith(SOURCE_ID);
    const initialData = props.initialData as Record<string, unknown>;
    expect(initialData.category_ids).toEqual(['cat-plugins', 'cat-pro']);
    // The rest of the prefill is unchanged: a draft in the target language, in the same group.
    expect(initialData).toMatchObject({ language_id: 2, translation_group_id: GROUP_ID, status: 'draft', id: undefined });
  });

  it('reads no categories for a new product outside a translation group', async () => {
    const props = await shellProps({});

    expect(mocks.getProductCategories).not.toHaveBeenCalled();
    expect(props.initialData).toBeUndefined();
  });
});
