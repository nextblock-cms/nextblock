// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The CMS draft bar. Only an ADMIN past the second factor may publish a product draft
 * (publishProductVisualEditingDraft opens with requireCmsAdmin()), so for anyone else the bar keeps
 * Discard and shows Publish disabled with a note: the edit page hands it a server-derived flag. Pages
 * and posts are unaffected (a WRITER publishes those). The server check stays the authority.
 *
 * After a publish or discard the page reloads: the product edit page's draft flag only ever latches
 * on. A publish that returns a warning keeps it in a toast instead, and reloads from its button. A product skips router.refresh(): the action's own revalidatePath already re-renders the edit
 * page in the action's response (the actions are mocked here, so these tests pin only what the bar
 * calls), and ProductForm remounts its variations editor on that reset
 * (ProductForm.variations-autosave.test.tsx). Pages and posts refresh first, then reload.
 */

const mocks = vi.hoisted(() => ({
  publishVisualEditingDraft: vi.fn(),
  discardVisualEditingDraft: vi.fn(),
  publishVisualEditingProductDraft: vi.fn(),
  discardVisualEditingProductDraft: vi.fn(),
  refresh: vi.fn(),
  reload: vi.fn(),
  toast: { loading: vi.fn(() => 'toast-1'), error: vi.fn(), success: vi.fn(), dismiss: vi.fn() },
}));

vi.mock('../../actions/visualEditingActions', () => ({
  publishVisualEditingDraft: mocks.publishVisualEditingDraft,
  discardVisualEditingDraft: mocks.discardVisualEditingDraft,
  publishVisualEditingProductDraft: mocks.publishVisualEditingProductDraft,
  discardVisualEditingProductDraft: mocks.discardVisualEditingProductDraft,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh, push: vi.fn(), replace: vi.fn() }) }));
vi.mock('react-hot-toast', () => ({ toast: mocks.toast }));

import DraftStatusActions from './DraftStatusActions';
import {
  NO_CONTENT_DRAFT_ERROR,
  NO_PRODUCT_DRAFT_ERROR,
  PRODUCT_PUBLISH_ADMIN_ONLY_NOTE,
} from '../../../lib/visual-editing/product-draft-meta';

const PRODUCT_ID = '123e4567-e89b-12d3-a456-426614174000';

let mounted: Array<{ root: Root; container: HTMLElement }> = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  // A refusal keeps the bar on the page (a success reloads it).
  mocks.publishVisualEditingProductDraft.mockResolvedValue({ success: false, error: 'refused' });
  mocks.publishVisualEditingDraft.mockResolvedValue({ error: 'refused' });
  mocks.discardVisualEditingProductDraft.mockResolvedValue({ error: 'refused' });
});

afterEach(async () => {
  for (const { root, container } of mounted) {
    await act(async () => root.unmount());
    container.remove();
  }
  mounted = [];
  vi.restoreAllMocks();
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

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`no ${label} button`);
  return found as HTMLButtonElement;
}

describe('DraftStatusActions on a product draft', () => {
  it('disables Publish for anyone but an ADMIN, says who publishes, and keeps Discard', async () => {
    const container = await render(
      <DraftStatusActions parentId={PRODUCT_ID} parentType="product" hasDraft canPublish={false} />
    );

    const publish = button(container, 'Publish');
    expect(publish.disabled).toBe(true);
    const noteId = publish.getAttribute('aria-describedby');
    expect(noteId).toBeTruthy();
    expect(container.querySelector(`[id="${noteId}"]`)?.textContent).toBe(PRODUCT_PUBLISH_ADMIN_ONLY_NOTE);
    expect(container.textContent).toContain('An administrator publishes product changes.');

    await act(async () => {
      publish.click();
    });
    expect(mocks.publishVisualEditingProductDraft).not.toHaveBeenCalled();

    const discard = button(container, 'Discard');
    expect(discard.disabled).toBe(false);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await act(async () => {
      discard.click();
    });
    expect(mocks.discardVisualEditingProductDraft).toHaveBeenCalledWith(PRODUCT_ID);
  });

  it('offers Publish to an ADMIN, with no note, and publishes the product draft', async () => {
    const container = await render(<DraftStatusActions parentId={PRODUCT_ID} parentType="product" hasDraft canPublish />);

    const publish = button(container, 'Publish');
    expect(publish.disabled).toBe(false);
    expect(publish.hasAttribute('aria-describedby')).toBe(false);
    expect(container.textContent).not.toContain(PRODUCT_PUBLISH_ADMIN_ONLY_NOTE);

    await act(async () => {
      publish.click();
    });
    expect(mocks.publishVisualEditingProductDraft).toHaveBeenCalledWith(PRODUCT_ID);
    // The server still answers for itself: its refusal is shown as it came.
    expect(mocks.toast.error).toHaveBeenCalledWith('Publish failed: refused', { id: 'toast-1' });
  });

  it('renders nothing without a draft', async () => {
    const container = await render(
      <DraftStatusActions parentId={PRODUCT_ID} parentType="product" hasDraft={false} canPublish={false} />
    );
    expect(container.innerHTML).toBe('');
  });
});

describe('DraftStatusActions on a page or post draft', () => {
  it.each(['page', 'post'] as const)('keeps Publish for a %s draft (the flag is for products only)', async (parentType) => {
    const container = await render(<DraftStatusActions parentId={7} parentType={parentType} hasDraft />);

    const publish = button(container, 'Publish');
    expect(publish.disabled).toBe(false);
    expect(container.textContent).not.toContain(PRODUCT_PUBLISH_ADMIN_ONLY_NOTE);

    await act(async () => {
      publish.click();
    });
    expect(mocks.publishVisualEditingDraft).toHaveBeenCalledWith(parentType, 7);
  });
});

describe('DraftStatusActions after a publish or discard went through', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // jsdom cannot navigate: the reload is observed here instead.
    vi.stubGlobal('location', { origin: 'http://localhost:3000', href: 'http://localhost:3000/cms', reload: mocks.reload });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mocks.publishVisualEditingProductDraft.mockResolvedValue({ success: true });
    mocks.discardVisualEditingProductDraft.mockResolvedValue({ success: true });
    mocks.publishVisualEditingDraft.mockResolvedValue({ success: true });
    mocks.discardVisualEditingDraft.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function clickAndWaitForReload(container: HTMLElement, label: string) {
    await act(async () => {
      button(container, label).click();
    });
    expect(mocks.reload).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
  }

  it.each([
    ['publish', 'Publish', { success: true }],
    ['discard', 'Discard', { success: true }],
  ] as const)('reloads a product after a %s without refreshing first', async (_case, label, result) => {
    mocks.publishVisualEditingProductDraft.mockResolvedValue(result);
    const container = await render(<DraftStatusActions parentId={PRODUCT_ID} parentType="product" hasDraft canPublish />);

    await clickAndWaitForReload(container, label);

    expect(mocks.reload).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).not.toHaveBeenCalled();
    // The draft is gone: the bar left at once, before the reload.
    expect(container.innerHTML).toBe('');
  });

  /** The warning toast as react-hot-toast would draw it: its content function, rendered. */
  async function renderWarningToast(): Promise<HTMLElement> {
    const call = mocks.toast.error.mock.calls.at(-1) as unknown as [unknown, { id?: string; duration?: number }];
    expect(typeof call[0]).toBe('function');
    expect(call[1]).toEqual({ id: 'toast-1', duration: Infinity });
    const content = (call[0] as (shown: { id: string }) => ReactElement)({ id: 'toast-1' });
    return render(content);
  }

  it.each([
    ['a warning', { success: true, warning: 'Published, but history was not recorded: boom' }, 'Published, but history was not recorded: boom', false],
    // The edits are live and only the draft row stayed: a success with that warning, never "Publish
    // failed". The bar stays for that row (review 2026-11-15: hidden, it gave a later edit no Publish).
    [
      "a 'Published, but ...' error",
      { success: false, error: 'Published, but failed to remove product draft: boom' },
      'Published, but failed to remove product draft: boom',
      true,
    ],
  ] as const)('keeps a product publish with %s on screen until the editor reloads from the toast', async (_case, result, warning, barStays) => {
    mocks.publishVisualEditingProductDraft.mockResolvedValue(result);
    const container = await render(<DraftStatusActions parentId={PRODUCT_ID} parentType="product" hasDraft canPublish />);

    await clickAndWaitForReload(container, 'Publish');
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    expect(mocks.reload).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(mocks.toast.error).not.toHaveBeenCalledWith(expect.stringContaining('Publish failed'), expect.anything());
    // The bar does not offer the published draft again while the warning waits, unless its row stayed.
    expect(container.textContent?.includes('Unpublished Draft')).toBe(barStays);

    const toastContent = await renderWarningToast();
    expect(toastContent.textContent).toContain(warning);
    await act(async () => {
      button(toastContent, 'Reload page').click();
    });
    expect(mocks.toast.dismiss).toHaveBeenCalledWith('toast-1');
    expect(mocks.reload).toHaveBeenCalledTimes(1);
  });

  // Review 2026-11-15: the never-expiring toast sat over an open block editor's Save and Cancel.
  it('lets the editor dismiss the warning toast without reloading', async () => {
    mocks.publishVisualEditingProductDraft.mockResolvedValue({ success: true, warning: 'Published, but history was not recorded: boom' });
    const container = await render(<DraftStatusActions parentId={PRODUCT_ID} parentType="product" hasDraft canPublish />);

    await clickAndWaitForReload(container, 'Publish');
    const toastContent = await renderWarningToast();
    await act(async () => {
      button(toastContent, 'Dismiss').click();
    });

    expect(mocks.toast.dismiss).toHaveBeenCalledWith('toast-1');
    expect(mocks.reload).not.toHaveBeenCalled();
  });

  it.each([
    ['product', NO_PRODUCT_DRAFT_ERROR],
    ['page', NO_CONTENT_DRAFT_ERROR],
  ] as const)('treats a %s draft that is already gone as settled: no "Publish failed", the bar leaves, the page reloads', async (parentType, noDraftError) => {
    mocks.publishVisualEditingProductDraft.mockResolvedValue({ success: false, error: noDraftError });
    mocks.publishVisualEditingDraft.mockResolvedValue({ error: noDraftError });
    const container = await render(
      parentType === 'product' ? (
        <DraftStatusActions parentId={PRODUCT_ID} parentType="product" hasDraft canPublish />
      ) : (
        <DraftStatusActions parentId={7} parentType="page" hasDraft />
      )
    );

    await clickAndWaitForReload(container, 'Publish');

    expect(mocks.toast.error).not.toHaveBeenCalled();
    expect(mocks.toast.success).toHaveBeenCalledWith('There was no draft left to publish: the page now shows what is live.', {
      id: 'toast-1',
    });
    expect(container.innerHTML).toBe('');
    expect(mocks.reload).toHaveBeenCalledTimes(1);
  });

  it.each(['page', 'post'] as const)('refreshes a %s at once after a publish with a warning, and reloads only from the toast', async (parentType) => {
    mocks.publishVisualEditingDraft.mockResolvedValue({ success: true, warning: 'Published, but history was not recorded: boom' });
    const container = await render(<DraftStatusActions parentId={7} parentType={parentType} hasDraft />);

    await clickAndWaitForReload(container, 'Publish');

    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.reload).not.toHaveBeenCalled();
    const toastContent = await renderWarningToast();
    await act(async () => {
      button(toastContent, 'Reload page').click();
    });
    expect(mocks.reload).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['page', 'Publish'],
    ['post', 'Publish'],
    ['page', 'Discard'],
    ['post', 'Discard'],
  ] as const)('refreshes a %s and reloads after %s, as before', async (parentType, label) => {
    const container = await render(<DraftStatusActions parentId={7} parentType={parentType} hasDraft />);

    await clickAndWaitForReload(container, label);

    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.reload).toHaveBeenCalledTimes(1);
  });

  it('neither refreshes nor reloads after a refusal', async () => {
    mocks.publishVisualEditingProductDraft.mockResolvedValue({ success: false, error: 'refused' });
    const container = await render(<DraftStatusActions parentId={PRODUCT_ID} parentType="product" hasDraft canPublish />);

    await clickAndWaitForReload(container, 'Publish');

    expect(mocks.reload).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  /*
   * Review 2026-11-15: after a publish that warned, the bar stayed hidden for the NEXT draft until a
   * reload. The skipped-title warning says to edit the title again, and that edit's draft then had no
   * Publish (the visibility control offers none on a published product).
   */
  it('comes back for a product draft autosaved after a publish that warned', async () => {
    mocks.publishVisualEditingProductDraft.mockResolvedValue({
      success: true,
      warning: 'Published the description blocks only. Edit the title again if you still want the draft’s version.',
    });
    const container = await render(
      <DraftStatusActions parentId={PRODUCT_ID} parentType="product" hasDraft canPublish draftSaveCount={2} />
    );
    const root = mounted[0].root;

    await clickAndWaitForReload(container, 'Publish');
    expect(container.innerHTML).toBe('');

    // The action's revalidation re-renders the page: the latched flag is still on, no save yet.
    await act(async () => {
      root.render(<DraftStatusActions parentId={PRODUCT_ID} parentType="product" hasDraft canPublish draftSaveCount={2} />);
    });
    expect(container.innerHTML).toBe('');

    // The editor edits the title again: the autosave writes a new draft.
    await act(async () => {
      root.render(<DraftStatusActions parentId={PRODUCT_ID} parentType="product" hasDraft canPublish draftSaveCount={3} />);
    });
    expect(container.textContent).toContain('Unpublished Draft');
    mocks.publishVisualEditingProductDraft.mockResolvedValue({ success: true });
    await clickAndWaitForReload(container, 'Publish');
    expect(mocks.publishVisualEditingProductDraft).toHaveBeenCalledTimes(2);
    expect(mocks.reload).toHaveBeenCalledTimes(1);
  });

  it.each(['page', 'post'] as const)('comes back for the next %s draft after a publish that warned', async (parentType) => {
    mocks.publishVisualEditingDraft.mockResolvedValue({ success: true, warning: 'Published, but history was not recorded: boom' });
    const container = await render(<DraftStatusActions parentId={7} parentType={parentType} hasDraft />);
    const root = mounted[0].root;

    await clickAndWaitForReload(container, 'Publish');
    expect(container.innerHTML).toBe('');

    // The refresh reports no draft, then a block edit creates the next one.
    await act(async () => {
      root.render(<DraftStatusActions parentId={7} parentType={parentType} hasDraft={false} />);
    });
    await act(async () => {
      root.render(<DraftStatusActions parentId={7} parentType={parentType} hasDraft />);
    });
    expect(container.textContent).toContain('Unpublished Draft');
  });

  it.each(['page', 'post'] as const)('stays hidden while a %s refresh still reports the published draft', async (parentType) => {
    mocks.publishVisualEditingDraft.mockResolvedValue({ success: true, warning: 'Published, but history was not recorded: boom' });
    const container = await render(<DraftStatusActions parentId={7} parentType={parentType} hasDraft />);
    const root = mounted[0].root;

    await clickAndWaitForReload(container, 'Publish');
    await act(async () => {
      root.render(<DraftStatusActions parentId={7} parentType={parentType} hasDraft />);
    });

    expect(container.innerHTML).toBe('');
  });
});
