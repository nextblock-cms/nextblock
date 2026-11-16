// @vitest-environment jsdom
import { act, type ChangeEvent, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The CMS top-bar visibility control (pages, posts, products).
 *
 * - Only an ADMIN can change a product's visibility: products_update_policy is is_admin(), so for a
 *   WRITER setContentVisibility's UPDATE matched no row and Publish, Schedule, Unpublish and Archive
 *   each failed with a database error. The product edit page hands the control its server-derived
 *   flag (an ADMIN past the second factor), and anyone else gets those actions disabled with a note.
 * - "Publish your unpublished edits at the same time" publishes the draft BEFORE the visibility
 *   changes. A draft that fails stops there with the row as it was (the checkbox promises the older
 *   live version does not go public in its place) and the dialog says to untick the box to publish
 *   without the edits; the product publish runs before the visibility UPDATE that sets
 *   products.updated_at, which made publish skip a pre-0.23.4 draft's own fields as overtaken by a
 *   later change. A "Published, but ..." error means the edits are live: a success with that warning.
 * - Without a draft, or with the box unticked, only the visibility is written; Cancel writes nothing.
 * - A draft publish warning stays in the dialog, which stays open once the visibility changed, and
 *   the page reloads (a product) or refreshes when the editor closes it: the reload that used to
 *   follow 800 ms after the publish cut the warning's 8 s toast short.
 * - After a product draft went live the page reloads, as the draft bar does, without a refresh
 *   first: the edit page's draft flag only ever latches on. (The draft publish's own revalidatePath
 *   re-renders the page in its response; the actions are mocked here.)
 */

const mocks = vi.hoisted(() => ({
  setContentVisibility: vi.fn(),
  getSiblingVisibility: vi.fn(),
  publishVisualEditingDraft: vi.fn(),
  publishVisualEditingProductDraft: vi.fn(),
  router: { refresh: vi.fn(), push: vi.fn(), replace: vi.fn() },
  reload: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  // What Escape, a click outside or the dialog's X do to the open dialog (Radix calls onOpenChange(false)).
  dismissOpenDialog: null as null | (() => void),
}));

vi.mock('../../actions/visibilityActions', () => ({
  setContentVisibility: mocks.setContentVisibility,
  getSiblingVisibility: mocks.getSiblingVisibility,
}));
vi.mock('../../actions/visualEditingActions', () => ({
  publishVisualEditingDraft: mocks.publishVisualEditingDraft,
  publishVisualEditingProductDraft: mocks.publishVisualEditingProductDraft,
}));
vi.mock('next/navigation', () => ({ useRouter: () => mocks.router }));
vi.mock('react-hot-toast', () => ({ toast: mocks.toast }));
// The control reads only the visibility helpers from the barrel.
vi.mock('@nextblock-cms/utils', () => vi.importActual('@nextblock-cms/utils/publishing'));
// The ui primitives as plain elements: Radix opens its menu and dialogs through pointer events and
// portals that jsdom does not drive. The menu is always rendered here, so every item can be read.
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
        aria-describedby={rest['aria-describedby'] as string | undefined}
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
    Dialog: ({ open, onOpenChange, children }: Props) => {
      if (open) mocks.dismissOpenDialog = () => (onOpenChange as (next: boolean) => void)(false);
      return open ? <div role="dialog">{children}</div> : null;
    },
    DialogContent: Pass,
    DialogDescription: Pass,
    DialogFooter: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
    DropdownMenu: Pass,
    DropdownMenuContent: ({ children }: Props) => <div role="menu">{children}</div>,
    DropdownMenuItem: ({ children, disabled, onSelect }: Props) => (
      <button
        type="button"
        role="menuitem"
        disabled={Boolean(disabled)}
        onClick={() => (onSelect as ((event: Event) => void) | undefined)?.(new Event('select'))}
      >
        {children}
      </button>
    ),
    DropdownMenuLabel: Pass,
    DropdownMenuSeparator: () => null,
    DropdownMenuTrigger: Pass,
    Input: () => <input />,
    Label: Pass,
  };
});

import VisibilityControl, { type VisibilityControlProps } from './VisibilityControl';
import {
  NO_CONTENT_DRAFT_ERROR,
  NO_PRODUCT_DRAFT_ERROR,
  PRODUCT_PUBLISH_ADMIN_ONLY_NOTE,
} from '../../../lib/visual-editing/product-draft-meta';

const PRODUCT_ID = '123e4567-e89b-12d3-a456-426614174000';
const PRODUCT = { type: 'product', id: PRODUCT_ID, publicPath: '/product/pro-plugin' } as const;
const PAGE = { type: 'page', id: 7, publicPath: '/about' } as const;

let mounted: Array<{ root: Root; container: HTMLElement }> = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  // jsdom cannot navigate: the reload is observed here instead.
  vi.stubGlobal('location', { origin: 'http://localhost:3000', href: 'http://localhost:3000/cms', reload: mocks.reload });
  mocks.setContentVisibility.mockResolvedValue({ state: 'published', publishedAt: null });
  mocks.publishVisualEditingProductDraft.mockResolvedValue({ success: true });
  mocks.publishVisualEditingDraft.mockResolvedValue({ success: true });
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

async function render(props: VisibilityControlProps): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(<VisibilityControl {...props} />);
  });
  return container;
}

/** The same control with new props, as the page renders it again after a refresh. */
async function rerender(container: HTMLElement, props: VisibilityControlProps) {
  const entry = mounted.find((candidate) => candidate.container === container);
  if (!entry) throw new Error('the control is not mounted');
  await act(async () => {
    entry.root.render(<VisibilityControl {...props} />);
  });
}

/** The dialog's red error line, if any. */
function dialogError(container: HTMLElement): string | null {
  return dialog(container)?.querySelector('p.text-destructive')?.textContent ?? null;
}

/** The dialog's amber notice for a draft publish warning, if any. */
function dialogNotice(container: HTMLElement): string | null {
  return dialog(container)?.querySelector('[role="status"]')?.textContent ?? null;
}

function buttonIn(scope: ParentNode, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label
  );
  if (!found) throw new Error(`no ${label} button`);
  return found as HTMLButtonElement;
}

function menuItem(container: HTMLElement, label: string): HTMLButtonElement {
  return buttonIn(container.querySelector('[role="menu"]') as HTMLElement, label);
}

function dialog(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[role="dialog"]');
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}

/** Opens the publish dialog from the top bar and confirms it (the edits box as it is). */
async function publishFromDialog(container: HTMLElement, confirmLabel: string) {
  await click(buttonIn(container, 'Publish…'));
  const opened = dialog(container);
  if (!opened) throw new Error('the publish dialog did not open');
  await click(buttonIn(opened, confirmLabel));
}

/** The 800 ms the control waits before reloading, so the toast shows first. */
async function afterReloadDelay() {
  await act(async () => {
    vi.advanceTimersByTime(800);
  });
}

describe('VisibilityControl on a product: only an ADMIN changes its visibility', () => {
  it('disables every visibility action for anyone else, says who publishes, and keeps Copy public URL', async () => {
    const container = await render({ ...PRODUCT, status: 'draft', publishedAt: null, hasDraft: true, canPublishProduct: false });

    const publish = buttonIn(container, 'Publish…');
    expect(publish.disabled).toBe(true);
    const noteId = publish.getAttribute('aria-describedby');
    expect(noteId).toBeTruthy();
    expect(container.querySelector(`[id="${noteId}"]`)?.textContent).toBe(PRODUCT_PUBLISH_ADMIN_ONLY_NOTE);
    expect(PRODUCT_PUBLISH_ADMIN_ONLY_NOTE).toBe('An administrator publishes product changes.');
    // The menu trigger stays usable (Copy public URL) and points at the same note.
    expect(buttonIn(container, 'Visibility options').disabled).toBe(false);
    expect(buttonIn(container, 'Visibility options').getAttribute('aria-describedby')).toBe(noteId);
    expect(menuItem(container, 'Schedule…').disabled).toBe(true);
    expect(menuItem(container, 'Archive').disabled).toBe(true);
    expect(menuItem(container, 'Copy public URL').disabled).toBe(false);

    await click(publish);
    await click(menuItem(container, 'Schedule…'));
    await click(menuItem(container, 'Archive'));
    expect(dialog(container)).toBeNull();
    expect(mocks.setContentVisibility).not.toHaveBeenCalled();
    expect(mocks.publishVisualEditingProductDraft).not.toHaveBeenCalled();
  });

  it('disables Unpublish and Reschedule on a live or scheduled product too', async () => {
    const live = await render({ ...PRODUCT, status: 'active', publishedAt: null, canPublishProduct: false });
    expect(live.textContent).not.toContain('Publish…');
    expect(menuItem(live, 'Unpublish').disabled).toBe(true);
    expect(menuItem(live, 'Archive').disabled).toBe(true);
    expect(live.textContent).toContain(PRODUCT_PUBLISH_ADMIN_ONLY_NOTE);

    const scheduled = await render({
      ...PRODUCT,
      status: 'active',
      publishedAt: '2999-01-01T00:00:00.000Z',
      canPublishProduct: false,
    });
    expect(buttonIn(scheduled, 'Publish now').disabled).toBe(true);
    expect(menuItem(scheduled, 'Reschedule…').disabled).toBe(true);
    expect(menuItem(scheduled, 'Unpublish').disabled).toBe(true);
  });

  it('offers every action to an ADMIN, with no note', async () => {
    const container = await render({ ...PRODUCT, status: 'draft', publishedAt: null, canPublishProduct: true });

    const publish = buttonIn(container, 'Publish…');
    expect(publish.disabled).toBe(false);
    expect(publish.hasAttribute('aria-describedby')).toBe(false);
    expect(container.textContent).not.toContain(PRODUCT_PUBLISH_ADMIN_ONLY_NOTE);
    expect(menuItem(container, 'Schedule…').disabled).toBe(false);
    expect(menuItem(container, 'Archive').disabled).toBe(false);

    await publishFromDialog(container, 'Publish product');
    expect(mocks.setContentVisibility).toHaveBeenCalledWith('product', PRODUCT_ID, { action: 'publish' });
  });

  it.each([PAGE, { type: 'post', id: 9, publicPath: '/article/hello' } as const])(
    'leaves a $type alone (a WRITER changes its visibility)',
    async (doc) => {
      const container = await render({ ...doc, status: 'draft', publishedAt: null });

      expect(buttonIn(container, 'Publish…').disabled).toBe(false);
      expect(menuItem(container, 'Schedule…').disabled).toBe(false);
      expect(container.textContent).not.toContain(PRODUCT_PUBLISH_ADMIN_ONLY_NOTE);
    }
  );
});

describe('"Publish your unpublished edits at the same time": the edits first, then the visibility', () => {
  it("publishes a product's draft before the visibility UPDATE, then reloads without a refresh", async () => {
    const container = await render({ ...PRODUCT, status: 'draft', publishedAt: null, hasDraft: true, canPublishProduct: true });

    await click(buttonIn(container, 'Publish…'));
    const box = dialog(container)?.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box.checked).toBe(true);
    await click(buttonIn(dialog(container) as HTMLElement, 'Publish product'));

    expect(mocks.publishVisualEditingProductDraft).toHaveBeenCalledWith(PRODUCT_ID);
    expect(mocks.setContentVisibility).toHaveBeenCalledWith('product', PRODUCT_ID, { action: 'publish' });
    expect(mocks.publishVisualEditingProductDraft.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setContentVisibility.mock.invocationCallOrder[0]
    );
    expect(mocks.toast.success).toHaveBeenCalledWith('Published.');
    expect(dialog(container)).toBeNull();

    // As after a publish from the draft bar: a reload, never a refresh first (the edit page's draft
    // flag only ever latches on).
    expect(mocks.router.refresh).not.toHaveBeenCalled();
    expect(mocks.reload).not.toHaveBeenCalled();
    await afterReloadDelay();
    expect(mocks.reload).toHaveBeenCalledTimes(1);
    expect(mocks.router.refresh).not.toHaveBeenCalled();
  });

  it('stops when the draft does not publish: the visibility is not changed, the dialog says why and how to go on', async () => {
    mocks.publishVisualEditingProductDraft.mockResolvedValue({
      success: false,
      error: 'Not published. This draft was saved by an earlier version of NextBlock.',
    });
    const container = await render({ ...PRODUCT, status: 'draft', publishedAt: null, hasDraft: true, canPublishProduct: true });

    await publishFromDialog(container, 'Publish product');

    expect(mocks.publishVisualEditingProductDraft).toHaveBeenCalledTimes(1);
    expect(mocks.setContentVisibility).not.toHaveBeenCalled();
    expect(dialogError(container)).toBe(
      "The visibility was not changed, because publishing the edits failed: Not published. This draft was saved by an earlier version of NextBlock. Untick 'Publish your unpublished edits' to publish without them."
    );
    expect(mocks.toast.success).not.toHaveBeenCalled();
    await afterReloadDelay();
    expect(mocks.reload).not.toHaveBeenCalled();
    expect(mocks.router.refresh).not.toHaveBeenCalled();

    // As the dialog says: unticked, the next try changes only the visibility.
    await click(dialog(container)?.querySelector('input[type="checkbox"]') as HTMLInputElement);
    await click(buttonIn(dialog(container) as HTMLElement, 'Publish product'));
    expect(mocks.publishVisualEditingProductDraft).toHaveBeenCalledTimes(1);
    expect(mocks.setContentVisibility).toHaveBeenCalledWith('product', PRODUCT_ID, { action: 'publish' });
  });

  it('keeps a draft publish warning in the dialog: no reload at 800 ms, a reload once the editor closes it', async () => {
    const warning =
      "Published the description blocks only. This draft was created before NextBlock 0.23.4 and the product changed after that, so the draft's title was not published.";
    mocks.publishVisualEditingProductDraft.mockResolvedValue({ success: true, warning });
    const container = await render({ ...PRODUCT, status: 'draft', publishedAt: null, hasDraft: true, canPublishProduct: true });

    await publishFromDialog(container, 'Publish product');

    expect(mocks.setContentVisibility).toHaveBeenCalledTimes(1);
    expect(mocks.toast.success).toHaveBeenCalledWith('Published.');
    expect(mocks.toast.error).not.toHaveBeenCalled();
    const opened = dialog(container) as HTMLElement;
    expect(opened).not.toBeNull();
    expect(opened.textContent).toContain('This product is public');
    expect(dialogNotice(container)).toBe(warning);
    expect(dialogError(container)).toBeNull();
    // Nothing left to confirm: Close only.
    expect(() => buttonIn(opened, 'Publish product')).toThrow();
    await afterReloadDelay();
    expect(mocks.reload).not.toHaveBeenCalled();
    expect(mocks.router.refresh).not.toHaveBeenCalled();

    await click(buttonIn(opened, 'Close'));

    expect(dialog(container)).toBeNull();
    expect(mocks.reload).not.toHaveBeenCalled();
    await afterReloadDelay();
    expect(mocks.reload).toHaveBeenCalledTimes(1);
    expect(mocks.router.refresh).not.toHaveBeenCalled();
  });

  it('ignores Escape or a click outside while the publish runs, then shows its warning and reloads once closed', async () => {
    let answer: (value: unknown) => void = () => undefined;
    mocks.publishVisualEditingProductDraft.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    const container = await render({ ...PRODUCT, status: 'draft', publishedAt: null, hasDraft: true, canPublishProduct: true });

    await publishFromDialog(container, 'Publish product');
    await act(async () => {
      mocks.dismissOpenDialog?.();
    });
    // Closed here, the dialog lost the warning and the reload, and the control stayed stuck.
    expect(dialog(container)).not.toBeNull();

    await act(async () => {
      answer({ success: true, warning: 'Published, but history was not recorded: boom' });
    });

    expect(mocks.setContentVisibility).toHaveBeenCalledTimes(1);
    expect(dialogNotice(container)).toBe('Published, but history was not recorded: boom');
    await afterReloadDelay();
    expect(mocks.reload).not.toHaveBeenCalled();

    // Once the publish has answered, a dismissal closes the dialog as Close does.
    await act(async () => {
      mocks.dismissOpenDialog?.();
    });
    expect(dialog(container)).toBeNull();
    await afterReloadDelay();
    expect(mocks.reload).toHaveBeenCalledTimes(1);

    // The next dialog opens fresh: no leftover notice or 'This product is public' state.
    await click(buttonIn(container, 'Publish…'));
    expect(dialogNotice(container)).toBeNull();
    expect(buttonIn(dialog(container) as HTMLElement, 'Publish product').disabled).toBe(false);
  });

  it.each([
    ['product', NO_PRODUCT_DRAFT_ERROR],
    ['page', NO_CONTENT_DRAFT_ERROR],
  ] as const)(
    'publishes only the visibility of a %s whose offered draft is already gone (a revision restore, another tab)',
    async (type, noDraftError) => {
      mocks.publishVisualEditingProductDraft.mockResolvedValue({ success: false, error: noDraftError });
      mocks.publishVisualEditingDraft.mockResolvedValue({ error: noDraftError });
      const container = await render(
        type === 'product'
          ? { ...PRODUCT, status: 'draft', publishedAt: null, hasDraft: true, canPublishProduct: true }
          : { ...PAGE, status: 'draft', publishedAt: null, hasDraft: true }
      );

      await publishFromDialog(container, type === 'product' ? 'Publish product' : 'Publish page');

      expect(mocks.setContentVisibility).toHaveBeenCalledTimes(1);
      expect(mocks.toast.success).toHaveBeenCalledWith('Published.');
      expect(dialog(container)).toBeNull();
      await afterReloadDelay();
      if (type === 'product') {
        // The reload resets the edit page's latched draft flag, which offered the draft that was gone.
        expect(mocks.reload).toHaveBeenCalledTimes(1);
        expect(mocks.router.refresh).not.toHaveBeenCalled();
      } else {
        expect(mocks.router.refresh).toHaveBeenCalledTimes(1);
        expect(mocks.reload).not.toHaveBeenCalled();
      }
    }
  );

  it('keeps the warning through a failed visibility change and its retry, then reloads on close', async () => {
    mocks.publishVisualEditingProductDraft.mockResolvedValue({ success: true, warning: 'Published, but history was not recorded: boom' });
    mocks.setContentVisibility.mockResolvedValueOnce({ error: 'Could not update visibility.' });
    const container = await render({ ...PRODUCT, status: 'draft', publishedAt: null, hasDraft: true, canPublishProduct: true });

    await publishFromDialog(container, 'Publish product');
    expect(dialogNotice(container)).toBe('Published, but history was not recorded: boom');
    expect(dialogError(container)).toBe('The edits are published, but the visibility was not changed: Could not update visibility.');

    await click(buttonIn(dialog(container) as HTMLElement, 'Publish product'));

    expect(mocks.publishVisualEditingProductDraft).toHaveBeenCalledTimes(1);
    expect(mocks.setContentVisibility).toHaveBeenCalledTimes(2);
    expect(dialogNotice(container)).toBe('Published, but history was not recorded: boom');
    expect(dialogError(container)).toBeNull();
    await afterReloadDelay();
    expect(mocks.reload).not.toHaveBeenCalled();
    await click(buttonIn(dialog(container) as HTMLElement, 'Close'));
    await afterReloadDelay();
    expect(mocks.reload).toHaveBeenCalledTimes(1);
  });

  it("goes on with a 'Published, but ...' error as a success with that warning: the edits are live", async () => {
    mocks.publishVisualEditingProductDraft.mockResolvedValue({
      success: false,
      error: 'Published, but failed to remove product draft: boom',
    });
    const container = await render({ ...PRODUCT, status: 'draft', publishedAt: null, hasDraft: true, canPublishProduct: true });

    await publishFromDialog(container, 'Publish product');

    expect(mocks.setContentVisibility).toHaveBeenCalledWith('product', PRODUCT_ID, { action: 'publish' });
    expect(mocks.toast.success).toHaveBeenCalledWith('Published.');
    expect(dialogNotice(container)).toBe('Published, but failed to remove product draft: boom');
    expect(dialogError(container)).toBeNull();
    await afterReloadDelay();
    expect(mocks.reload).not.toHaveBeenCalled();
    await click(buttonIn(dialog(container) as HTMLElement, 'Close'));
    await afterReloadDelay();
    expect(mocks.reload).toHaveBeenCalledTimes(1);
  });

  it('after the edits went live and the visibility failed, a retry changes only the visibility', async () => {
    mocks.setContentVisibility.mockResolvedValueOnce({ error: 'Could not update visibility.' });
    const container = await render({ ...PRODUCT, status: 'draft', publishedAt: null, hasDraft: true, canPublishProduct: true });

    await publishFromDialog(container, 'Publish product');

    const opened = dialog(container) as HTMLElement;
    expect(opened.textContent).toContain(
      'The edits are published, but the visibility was not changed: Could not update visibility.'
    );
    // The draft is gone: no second publish of it, and no box offering one.
    expect(opened.querySelector('input[type="checkbox"]')).toBeNull();

    await click(buttonIn(opened, 'Publish product'));

    expect(mocks.publishVisualEditingProductDraft).toHaveBeenCalledTimes(1);
    expect(mocks.setContentVisibility).toHaveBeenCalledTimes(2);
    expect(mocks.toast.success).toHaveBeenCalledWith('Published.');
    await afterReloadDelay();
    expect(mocks.reload).toHaveBeenCalledTimes(1);
  });

  it('reloads when the editor cancels after the edits went live and the visibility failed', async () => {
    mocks.setContentVisibility.mockResolvedValueOnce({ error: 'boom' });
    const container = await render({ ...PRODUCT, status: 'draft', publishedAt: null, hasDraft: true, canPublishProduct: true });

    await publishFromDialog(container, 'Publish product');
    await click(buttonIn(dialog(container) as HTMLElement, 'Cancel'));

    expect(dialog(container)).toBeNull();
    await afterReloadDelay();
    expect(mocks.reload).toHaveBeenCalledTimes(1);
    expect(mocks.router.refresh).not.toHaveBeenCalled();
  });

  it('changes only the visibility when the box is unticked, and refreshes (no reload)', async () => {
    const container = await render({ ...PRODUCT, status: 'draft', publishedAt: null, hasDraft: true, canPublishProduct: true });

    await click(buttonIn(container, 'Publish…'));
    await click(dialog(container)?.querySelector('input[type="checkbox"]') as HTMLInputElement);
    await click(buttonIn(dialog(container) as HTMLElement, 'Publish product'));

    expect(mocks.publishVisualEditingProductDraft).not.toHaveBeenCalled();
    expect(mocks.setContentVisibility).toHaveBeenCalledWith('product', PRODUCT_ID, { action: 'publish' });
    expect(mocks.router.refresh).toHaveBeenCalledTimes(1);
    await afterReloadDelay();
    expect(mocks.reload).not.toHaveBeenCalled();
  });

  it('publishes a page draft first too, stops on its error, and refreshes after a success', async () => {
    const container = await render({ ...PAGE, status: 'draft', publishedAt: null, hasDraft: true });

    await publishFromDialog(container, 'Publish page');

    expect(mocks.publishVisualEditingDraft).toHaveBeenCalledWith('page', 7);
    expect(mocks.publishVisualEditingDraft.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setContentVisibility.mock.invocationCallOrder[0]
    );
    expect(mocks.router.refresh).toHaveBeenCalledTimes(1);
    await afterReloadDelay();
    expect(mocks.reload).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.publishVisualEditingDraft.mockResolvedValue({ error: 'Failed to insert page blocks: boom' });
    const failing = await render({ ...PAGE, status: 'draft', publishedAt: null, hasDraft: true });
    await publishFromDialog(failing, 'Publish page');

    expect(mocks.setContentVisibility).not.toHaveBeenCalled();
    expect(dialogError(failing)).toBe(
      "The visibility was not changed, because publishing the edits failed: Failed to insert page blocks: boom. Untick 'Publish your unpublished edits' to publish without them."
    );
  });

  it('keeps a page draft publish warning in the dialog too, and refreshes once the editor closes it', async () => {
    mocks.publishVisualEditingDraft.mockResolvedValue({ success: true, warning: 'Published, but history was not recorded: boom' });
    const container = await render({ ...PAGE, status: 'draft', publishedAt: null, hasDraft: true });

    await publishFromDialog(container, 'Publish page');

    expect(mocks.setContentVisibility).toHaveBeenCalledTimes(1);
    expect(dialogNotice(container)).toBe('Published, but history was not recorded: boom');
    expect(mocks.router.refresh).not.toHaveBeenCalled();

    await click(buttonIn(dialog(container) as HTMLElement, 'Close'));

    expect(dialog(container)).toBeNull();
    expect(mocks.router.refresh).toHaveBeenCalledTimes(1);
    await afterReloadDelay();
    expect(mocks.reload).not.toHaveBeenCalled();
  });
});

describe('the paths around the draft: none, Cancel, and a new draft after a retry', () => {
  it.each([
    ['product', { ...PRODUCT, canPublishProduct: true }, 'Publish product'],
    ['page', PAGE, 'Publish page'],
  ] as const)(
    'never calls the draft publish for a %s without a draft: the visibility only, one refresh, no reload',
    async (_kind, doc, confirmLabel) => {
      const container = await render({ ...doc, status: 'draft', publishedAt: null });

      await click(buttonIn(container, 'Publish…'));
      // No box without a draft, and its default (ticked) must not reach the draft publish either.
      expect(dialog(container)?.querySelector('input[type="checkbox"]')).toBeNull();
      await click(buttonIn(dialog(container) as HTMLElement, confirmLabel));

      expect(mocks.publishVisualEditingProductDraft).not.toHaveBeenCalled();
      expect(mocks.publishVisualEditingDraft).not.toHaveBeenCalled();
      expect(mocks.setContentVisibility).toHaveBeenCalledTimes(1);
      expect(dialog(container)).toBeNull();
      expect(mocks.router.refresh).toHaveBeenCalledTimes(1);
      await afterReloadDelay();
      expect(mocks.reload).not.toHaveBeenCalled();
    }
  );

  it('writes nothing on Cancel, and neither refreshes nor reloads', async () => {
    const container = await render({ ...PRODUCT, status: 'draft', publishedAt: null, hasDraft: true, canPublishProduct: true });

    await click(buttonIn(container, 'Publish…'));
    await click(buttonIn(dialog(container) as HTMLElement, 'Cancel'));

    expect(dialog(container)).toBeNull();
    expect(mocks.publishVisualEditingProductDraft).not.toHaveBeenCalled();
    expect(mocks.setContentVisibility).not.toHaveBeenCalled();
    await afterReloadDelay();
    expect(mocks.router.refresh).not.toHaveBeenCalled();
    expect(mocks.reload).not.toHaveBeenCalled();
  });

  it('offers the box again when the dialog reopens on a new draft after a retry went through', async () => {
    mocks.setContentVisibility.mockResolvedValueOnce({ error: 'Could not update visibility.' });
    const page = { ...PAGE, status: 'draft', publishedAt: null } as const;
    const container = await render({ ...page, hasDraft: true });

    await publishFromDialog(container, 'Publish page');
    await click(buttonIn(dialog(container) as HTMLElement, 'Publish page'));
    expect(mocks.publishVisualEditingDraft).toHaveBeenCalledTimes(1);
    expect(mocks.setContentVisibility).toHaveBeenCalledTimes(2);
    expect(dialog(container)).toBeNull();
    expect(mocks.router.refresh).toHaveBeenCalledTimes(1);

    // The refreshed page has no draft; a later edit starts a new one.
    await rerender(container, { ...page, hasDraft: false });
    await rerender(container, { ...page, hasDraft: true });
    await click(buttonIn(container, 'Publish…'));

    const box = dialog(container)?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    expect(box?.checked).toBe(true);
    await click(buttonIn(dialog(container) as HTMLElement, 'Publish page'));
    expect(mocks.publishVisualEditingDraft).toHaveBeenCalledTimes(2);
  });
});
