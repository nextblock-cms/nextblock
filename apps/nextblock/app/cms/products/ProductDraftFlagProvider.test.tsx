// @vitest-environment jsdom
import { act, type ChangeEvent, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The product edit page shares one draft flag between the editor shell (its draft bar) and the top
 * bar's visibility control (ProductDraftFlagProvider). The form's autosave creates the draft without
 * revalidating the page, so the server render's hasDraft stays false until a reload: the visibility
 * dialog read only that, never offered "Publish your unpublished edits" for an autosaved draft, and
 * its Publish made the older live version public while the draft bar showed the draft. The real
 * shell, draft bar and control render here; ProductForm is a stand-in whose updateAction the test
 * calls the way its autosave does.
 */

const mocks = vi.hoisted(() => ({
  productFormProps: vi.fn(),
  updateProduct: vi.fn(),
  setContentVisibility: vi.fn(),
  getSiblingVisibility: vi.fn(),
  publishVisualEditingDraft: vi.fn(),
  publishVisualEditingProductDraft: vi.fn(),
  discardVisualEditingDraft: vi.fn(),
  discardVisualEditingProductDraft: vi.fn(),
  router: { refresh: vi.fn(), push: vi.fn(), replace: vi.fn() },
  reload: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), loading: vi.fn(() => 'toast-1') },
}));

vi.mock('@nextblock-cms/ecommerce', () => ({
  ProductForm: (props: Record<string, unknown>) => {
    mocks.productFormProps(props);
    return <div data-testid="product-form" />;
  },
}));
vi.mock('../media/components/MediaPickerDialog', () => ({ default: () => null }));
vi.mock('../../../lib/seo/page-audit-context', () => ({ usePageSeo: () => null }));
vi.mock('../../actions/visibilityActions', () => ({
  setContentVisibility: mocks.setContentVisibility,
  getSiblingVisibility: mocks.getSiblingVisibility,
}));
vi.mock('../../actions/visualEditingActions', () => ({
  publishVisualEditingDraft: mocks.publishVisualEditingDraft,
  publishVisualEditingProductDraft: mocks.publishVisualEditingProductDraft,
  discardVisualEditingDraft: mocks.discardVisualEditingDraft,
  discardVisualEditingProductDraft: mocks.discardVisualEditingProductDraft,
}));
vi.mock('next/navigation', () => ({ useRouter: () => mocks.router }));
vi.mock('react-hot-toast', () => ({ toast: mocks.toast }));
// The control reads only the visibility helpers from the barrel.
vi.mock('@nextblock-cms/utils', () => vi.importActual('@nextblock-cms/utils/publishing'));
// The ui primitives as plain elements (Radix opens its menu and dialogs through pointer events and
// portals that jsdom does not drive).
vi.mock('@nextblock-cms/ui', () => {
  type Props = { children?: ReactNode; [key: string]: unknown };
  const Pass = ({ children }: Props) => <>{children}</>;
  return {
    Button: ({ children, onClick, disabled, ...rest }: Props) => (
      <button
        type="button"
        onClick={onClick as () => void}
        disabled={Boolean(disabled)}
        aria-label={rest['aria-label'] as string | undefined}
      >
        {children}
      </button>
    ),
    Checkbox: ({ checked, onCheckedChange }: Props) => (
      <input
        type="checkbox"
        checked={Boolean(checked)}
        onChange={(event: ChangeEvent<HTMLInputElement>) => (onCheckedChange as (value: boolean) => void)(event.target.checked)}
      />
    ),
    Dialog: ({ open, children }: Props) => (open ? <div role="dialog">{children}</div> : null),
    DialogContent: Pass,
    DialogDescription: Pass,
    DialogFooter: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
    DropdownMenu: Pass,
    DropdownMenuContent: ({ children }: Props) => <div role="menu">{children}</div>,
    DropdownMenuItem: ({ children }: Props) => <div role="menuitem">{children}</div>,
    DropdownMenuLabel: Pass,
    DropdownMenuSeparator: () => null,
    DropdownMenuTrigger: Pass,
    Input: () => <input />,
    Label: Pass,
  };
});

import { ProductDraftFlagProvider } from './ProductDraftFlagProvider';
import ProductFormClientShell from './ProductFormClientShell';
import VisibilityControl from '../components/VisibilityControl';
import { NO_PRODUCT_DRAFT_ERROR } from '../../../lib/visual-editing/product-draft-meta';

type ShellProps = ComponentProps<typeof ProductFormClientShell>;

const PRODUCT_ID = '123e4567-e89b-12d3-a456-426614174000';

let mounted: Array<{ root: Root; container: HTMLElement }> = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  // jsdom cannot navigate: the reload after a product draft publish is observed here instead.
  vi.stubGlobal('location', { origin: 'http://localhost:3000', href: 'http://localhost:3000/cms', reload: mocks.reload });
  mocks.updateProduct.mockResolvedValue({ success: true });
  mocks.setContentVisibility.mockResolvedValue({ state: 'published', publishedAt: null });
  mocks.publishVisualEditingProductDraft.mockResolvedValue({ success: true });
  mocks.getSiblingVisibility.mockResolvedValue([]);
});

afterEach(async () => {
  for (const { root, container } of mounted) {
    await act(async () => root.unmount());
    container.remove();
  }
  mounted = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function render(element: ReactElement): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(element);
  });
  return container;
}

/** The editor shell as the edit page renders it (ProductForm is the stand-in above). */
function shell(serverHasDraft: boolean) {
  const props = {
    productId: PRODUCT_ID,
    serverHasDraft,
    canPublishProduct: true,
    isEdit: true,
    updateAction: mocks.updateProduct,
  } as unknown as ShellProps;
  return <ProductFormClientShell {...props} />;
}

/** The edit page's top bar control and editor shell, under the page's provider. */
function editPage(serverHasDraft: boolean) {
  return (
    <ProductDraftFlagProvider serverHasDraft={serverHasDraft}>
      <VisibilityControl
        type="product"
        id={PRODUCT_ID}
        status="draft"
        publishedAt={null}
        publicPath="/product/pro-plugin"
        hasDraft={serverHasDraft}
        canPublishProduct
      />
      {shell(serverHasDraft)}
    </ProductDraftFlagProvider>
  );
}

/** One form autosave, as ProductForm runs it: the updateAction the shell handed it. */
async function autosave() {
  const updateAction = mocks.productFormProps.mock.calls.at(-1)?.[0]?.updateAction as (values: unknown) => Promise<unknown>;
  await act(async () => {
    await updateAction({ title: 'Pro plugin, edited' });
  });
}

function buttonIn(scope: ParentNode, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`no ${label} button`);
  return found as HTMLButtonElement;
}

function dialog(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[role="dialog"]');
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}

describe('the product edit page: one draft flag for the editor shell and the visibility control', () => {
  it('offers "Publish your unpublished edits" once the form autosaved a draft the server render did not know about', async () => {
    const container = await render(editPage(false));

    // The server found no draft: neither the bar nor the control shows one, and the dialog has no box.
    expect(container.textContent).not.toContain('Unpublished Draft');
    expect(container.textContent).not.toContain('Unpublished edits');
    await click(buttonIn(container, 'Publish…'));
    expect(dialog(container)?.querySelector('input[type="checkbox"]')).toBeNull();
    await click(buttonIn(dialog(container) as HTMLElement, 'Cancel'));

    await autosave();

    expect(mocks.updateProduct).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Unpublished Draft');
    expect(container.textContent).toContain('Unpublished edits');
    expect(mocks.productFormProps.mock.calls.at(-1)?.[0]?.hasOpenDraft).toBe(true);

    await click(buttonIn(container, 'Publish…'));
    const box = dialog(container)?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    expect(box?.checked).toBe(true);
    await click(buttonIn(dialog(container) as HTMLElement, 'Publish product'));

    // The autosaved edits go live first, then the visibility: the older live version never goes public.
    expect(mocks.publishVisualEditingProductDraft).toHaveBeenCalledWith(PRODUCT_ID);
    expect(mocks.publishVisualEditingProductDraft.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setContentVisibility.mock.invocationCallOrder[0]
    );
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    expect(mocks.reload).toHaveBeenCalledTimes(1);
  });

  it('latches on: a refresh that reports a draft turns it on, and one that no longer does leaves it on', async () => {
    const container = await render(editPage(false));
    const root = mounted[0].root;

    await act(async () => {
      root.render(editPage(true));
    });
    expect(container.textContent).toContain('Unpublished edits');
    expect(container.textContent).toContain('Unpublished Draft');

    await act(async () => {
      root.render(editPage(false));
    });
    expect(container.textContent).toContain('Unpublished edits');
    expect(container.textContent).toContain('Unpublished Draft');
  });

  it('publishes only the visibility after a revision restore deleted the latched draft, then reloads to reset the flag', async () => {
    const container = await render(editPage(true));
    const root = mounted[0].root;
    // RevisionHistoryButton's restore deletes the draft and refreshes: the server reports none, the latch stays on.
    await act(async () => {
      root.render(editPage(false));
    });
    expect(container.textContent).toContain('Unpublished edits');
    mocks.publishVisualEditingProductDraft.mockResolvedValue({ success: false, error: NO_PRODUCT_DRAFT_ERROR });

    await click(buttonIn(container, 'Publish…'));
    await click(buttonIn(dialog(container) as HTMLElement, 'Publish product'));

    expect(mocks.publishVisualEditingProductDraft).toHaveBeenCalledTimes(1);
    expect(mocks.setContentVisibility).toHaveBeenCalledWith('product', PRODUCT_ID, { action: 'publish' });
    expect(dialog(container)).toBeNull();
    expect(mocks.toast.error).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    expect(mocks.reload).toHaveBeenCalledTimes(1);
  });

  it('brings the draft bar back for an autosave after a publish that warned, without a reload', async () => {
    const container = await render(editPage(true));
    mocks.publishVisualEditingProductDraft.mockResolvedValue({
      success: true,
      warning: 'Published the description blocks only. Edit the title again if you still want the draft’s version.',
    });

    // The draft bar's own Publish (the control's is "Publish…").
    await click(buttonIn(container, 'Publish'));
    expect(container.textContent).not.toContain('Unpublished Draft');

    await autosave();

    expect(container.textContent).toContain('Unpublished Draft');
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(mocks.reload).not.toHaveBeenCalled();
  });

  // Review 2026-11-15: after a warned publish, a description-block edit made a new draft (the server's
  // flag went from none to one) and the bar stayed hidden: block edits never call markDraftSaved.
  it('brings the draft bar back when the server reports a new draft after a publish that warned', async () => {
    const container = await render(editPage(true));
    const root = mounted[0].root;
    mocks.publishVisualEditingProductDraft.mockResolvedValue({
      success: true,
      warning: "Published, but some of the description blocks this publish replaced had already been removed while it ran.",
    });

    await click(buttonIn(container, 'Publish'));
    expect(container.textContent).not.toContain('Unpublished Draft');

    // The publish re-renders the page with no draft, then a block edit's refresh reports a new one.
    await act(async () => {
      root.render(editPage(false));
    });
    expect(container.textContent).not.toContain('Unpublished Draft');
    await act(async () => {
      root.render(editPage(true));
    });

    expect(container.textContent).toContain('Unpublished Draft');
    expect(mocks.reload).not.toHaveBeenCalled();
  });

  it('keeps a latch of its own outside the provider (the new-product page has none)', async () => {
    const container = await render(shell(false));
    expect(container.textContent).not.toContain('Unpublished Draft');

    await autosave();

    expect(container.textContent).toContain('Unpublished Draft');
  });

  it('leaves a control outside the provider on its own flag (the page and post editors)', async () => {
    const container = await render(
      <>
        <VisibilityControl type="page" id={7} status="draft" publishedAt={null} publicPath="/about" hasDraft={false} />
        {shell(false)}
      </>
    );

    await autosave();

    // The shell's own latch is on, but it is not shared without the provider.
    expect(container.textContent).toContain('Unpublished Draft');
    expect(container.textContent).not.toContain('Unpublished edits');
  });
});
