// @vitest-environment jsdom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The product editor's shell hands the draft bar the flag the edit page derived on the server (the
 * caller is an ADMIN past the second factor): anyone else sees Publish disabled on the product draft.
 * The flag stays out of ProductForm, and a shell given none fails closed.
 */

const mocks = vi.hoisted(() => ({
  productFormProps: vi.fn(),
  draftActionsProps: vi.fn(),
}));

vi.mock('@nextblock-cms/ecommerce', () => ({
  ProductForm: (props: Record<string, unknown>) => {
    mocks.productFormProps(props);
    return <div data-testid="product-form" />;
  },
}));
vi.mock('../media/components/MediaPickerDialog', () => ({ default: () => null }));
vi.mock('../components/DraftStatusActions', () => ({
  default: (props: Record<string, unknown>) => {
    mocks.draftActionsProps(props);
    return <div data-testid="draft-actions" />;
  },
}));
vi.mock('../../../lib/seo/page-audit-context', () => ({ usePageSeo: () => null }));

import ProductFormClientShell from './ProductFormClientShell';

type ShellProps = ComponentProps<typeof ProductFormClientShell>;

const PRODUCT_ID = '123e4567-e89b-12d3-a456-426614174000';

let mounted: Array<{ root: Root; container: HTMLElement }> = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  for (const { root, container } of mounted) {
    await act(async () => root.unmount());
    container.remove();
  }
  mounted = [];
});

async function renderShell(props: Partial<ShellProps>) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(<ProductFormClientShell {...({ isEdit: true, ...props } as ShellProps)} />);
  });
  return container;
}

function lastDraftActionsProps() {
  return mocks.draftActionsProps.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;
}

describe('ProductFormClientShell and the draft bar', () => {
  it.each([
    [true, true],
    [false, false],
  ])('passes canPublishProduct=%s to the product draft bar as canPublish=%s', async (canPublishProduct, expected) => {
    await renderShell({ productId: PRODUCT_ID, serverHasDraft: true, canPublishProduct });

    expect(lastDraftActionsProps()).toEqual({
      parentId: PRODUCT_ID,
      parentType: 'product',
      hasDraft: true,
      canPublish: expected,
      // No autosave yet (the bar comes back for a save after it settled: DraftStatusActions.test.tsx).
      draftSaveCount: 0,
    });
  });

  it('disables Publish when the page passes no flag (fails closed)', async () => {
    await renderShell({ productId: PRODUCT_ID, serverHasDraft: true });

    expect(lastDraftActionsProps()).toMatchObject({ parentType: 'product', canPublish: false });
  });

  it('keeps the flag out of ProductForm', async () => {
    await renderShell({ productId: PRODUCT_ID, serverHasDraft: false, canPublishProduct: true });

    expect(mocks.productFormProps).toHaveBeenCalled();
    expect(mocks.productFormProps.mock.calls.at(-1)?.[0]).not.toHaveProperty('canPublishProduct');
  });

  it('renders no draft bar without a product (the new-product page)', async () => {
    await renderShell({ canPublishProduct: true });

    expect(mocks.draftActionsProps).not.toHaveBeenCalled();
  });
});
