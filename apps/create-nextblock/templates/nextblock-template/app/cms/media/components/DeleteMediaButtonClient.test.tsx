// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The media library's single delete. Its confirmation first says where the file is used
 * (getMediaUsage: public.media_usage, 02045), keeps the button disabled until that answers, and
 * reads "Delete anyway" when something uses the file or the check failed. deleteMediaItem used to
 * answer a refusal with a redirect to /cms/media?error=…, which nothing on the page reads: the library
 * lost its folder and search and showed no message. It now answers { error } or { success }, toasted
 * here, and the confirmation closes.
 */

const mocks = vi.hoisted(() => ({
  deleteMediaItem: vi.fn(),
  getMediaUsage: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('../actions', () => ({ deleteMediaItem: mocks.deleteMediaItem, getMediaUsage: mocks.getMediaUsage }));
vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@nextblock-cms/ui', () => ({
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect: (event: Event) => void }) => (
    <button type="button" data-testid="menu-delete" onClick={() => onSelect(new Event('select'))}>
      {children}
    </button>
  ),
}));
// The confirmation dialog, reduced to its open state, its body and its confirm button.
vi.mock('../../components/ConfirmationModal', () => ({
  ConfirmationModal: ({
    isOpen,
    onConfirm,
    confirmText,
    confirmDisabled,
    children,
  }: {
    isOpen: boolean;
    onConfirm: () => void;
    confirmText: string;
    confirmDisabled?: boolean;
    children?: ReactNode;
  }) => {
    if (!isOpen) return null;
    return (
      <div role="dialog">
        {children}
        <button type="button" data-testid="confirm" onClick={onConfirm} disabled={confirmDisabled}>
          {confirmText}
        </button>
      </div>
    );
  },
}));

import DeleteMediaButtonClient from './DeleteMediaButtonClient';

const MEDIA_ID = 'a1111111-1111-4111-8111-11111111111a';
const ITEM = { id: MEDIA_ID, object_key: 'uploads/a.webp', file_name: 'a.webp' } as any;
const UNUSED = { total: 0, byKind: {}, sites: [] };
const USED = {
  total: 1,
  byKind: { block: 1 },
  sites: [{ kind: 'block', recordId: '41', parentType: 'page', parentId: '7', label: 'Home', language: 'en' }],
};

let mounted: { root: Root; container: HTMLElement } | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getMediaUsage.mockResolvedValue({ usage: { [MEDIA_ID]: UNUSED } });
});

afterEach(async () => {
  if (mounted) {
    const { root, container } = mounted;
    await act(async () => root.unmount());
    container.remove();
    mounted = null;
  }
});

async function openTheConfirmation() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted = { root, container };
  await act(async () => root.render(<DeleteMediaButtonClient mediaItem={ITEM} />));
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="menu-delete"]')?.click());
  return container;
}

const confirmButton = (container: HTMLElement) => container.querySelector<HTMLButtonElement>('[data-testid="confirm"]');

async function deleteThroughTheMenu() {
  const container = await openTheConfirmation();
  await act(async () => confirmButton(container)?.click());
  return container;
}

describe('DeleteMediaButtonClient: where the file is used', () => {
  it('keeps Delete disabled while it checks, then offers a plain Delete for a file nothing uses', async () => {
    let answer: (value: unknown) => void = () => undefined;
    mocks.getMediaUsage.mockReturnValue(new Promise((resolve) => { answer = resolve; }));

    const container = await openTheConfirmation();
    expect(mocks.getMediaUsage).toHaveBeenCalledWith([MEDIA_ID]);
    expect(container.textContent).toContain('Checking where this file is used');
    expect(confirmButton(container)?.disabled).toBe(true);

    await act(async () => answer({ usage: { [MEDIA_ID]: UNUSED } }));

    expect(container.textContent).toContain('Nothing in this site uses it');
    expect(confirmButton(container)?.disabled).toBe(false);
    expect(confirmButton(container)?.textContent).toBe('Delete');
  });

  it('lists where a used file appears, linked to its editor, and asks to Delete anyway', async () => {
    mocks.getMediaUsage.mockResolvedValue({ usage: { [MEDIA_ID]: USED } });

    const container = await openTheConfirmation();

    expect(container.textContent).toContain('Used in 1 place');
    const link = container.querySelector('a[href="/cms/pages/7/edit"]');
    expect(link?.textContent).toBe('Page "Home" (EN): content block');
    expect(confirmButton(container)?.textContent).toBe('Delete anyway');
  });

  it('says when the check failed, and still lets the editor choose (Delete anyway)', async () => {
    mocks.getMediaUsage.mockResolvedValue({ error: 'Where this media is used could not be checked: timeout' });

    const container = await openTheConfirmation();

    expect(container.textContent).toContain('could not be checked: timeout');
    expect(confirmButton(container)?.disabled).toBe(false);
    expect(confirmButton(container)?.textContent).toBe('Delete anyway');
  });
});

describe('DeleteMediaButtonClient: the delete answer', () => {
  it('toasts the refusal the action answers, after closing the confirmation', async () => {
    mocks.deleteMediaItem.mockResolvedValue({ error: 'Media item not found or you do not have permission to delete it.' });

    const container = await deleteThroughTheMenu();

    expect(mocks.deleteMediaItem).toHaveBeenCalledWith(MEDIA_ID, 'uploads/a.webp');
    expect(mocks.toast.error).toHaveBeenCalledWith(
      'a.webp was not deleted: Media item not found or you do not have permission to delete it.'
    );
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('toasts a success', async () => {
    mocks.deleteMediaItem.mockResolvedValue({ success: 'Media item deleted.' });

    await deleteThroughTheMenu();

    expect(mocks.toast.success).toHaveBeenCalledWith('Deleted a.webp.');
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it('toasts an action that throws (a network failure) instead of failing silently', async () => {
    mocks.deleteMediaItem.mockRejectedValue(new Error('Failed to fetch'));

    await deleteThroughTheMenu();

    expect(mocks.toast.error).toHaveBeenCalledWith('a.webp was not deleted: Failed to fetch');
  });
});
