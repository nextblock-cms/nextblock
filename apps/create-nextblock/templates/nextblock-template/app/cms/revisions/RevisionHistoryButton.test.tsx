// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Restoring a version from the CMS revision history. A product restore deletes the product's draft
 * (revisions/service.ts), but the product edit page's draft flag (ProductDraftFlagProvider) only ever
 * latches on: after a refresh alone the draft bar and the visibility dialog kept offering the deleted
 * draft, and its Publish failed with 'No draft exists for this product.'. So a product restore also
 * reloads the page 800 ms later; a page or post restore refreshes only, as before.
 */

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  restore: vi.fn(),
  compare: vi.fn(),
  router: { refresh: vi.fn(), push: vi.fn(), replace: vi.fn() },
  reload: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('./actions', () => ({
  listPageRevisions: mocks.list,
  listPostRevisions: mocks.list,
  listProductRevisions: mocks.list,
  restorePageVersion: mocks.restore,
  restorePostVersion: mocks.restore,
  restoreProductVersion: mocks.restore,
  comparePageVersion: mocks.compare,
  comparePostVersion: mocks.compare,
  compareProductVersion: mocks.compare,
}));
vi.mock('./JsonDiffView', () => ({ default: () => null }));
vi.mock('next/navigation', () => ({ useRouter: () => mocks.router }));
vi.mock('react-hot-toast', () => ({ toast: mocks.toast }));
vi.mock('@nextblock-cms/utils', () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
}));
// The ui primitives as plain elements: Radix's dialog portals are not what this test is about.
vi.mock('@nextblock-cms/ui', () => {
  type Props = { children?: ReactNode; [key: string]: unknown };
  const Pass = ({ children }: Props) => <>{children}</>;
  return {
    Button: ({ children, onClick, disabled }: Props) => (
      <button type="button" onClick={onClick as () => void} disabled={Boolean(disabled)}>
        {children}
      </button>
    ),
    Spinner: () => null,
    Alert: Pass,
    AlertDescription: Pass,
    Dialog: Pass,
    DialogContent: Pass,
    DialogDescription: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
    Input: () => <input />,
  };
});

import RevisionHistoryButton from './RevisionHistoryButton';

const PRODUCT_ID = '123e4567-e89b-12d3-a456-426614174000';

let mounted: Array<{ root: Root; container: HTMLElement }> = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  // jsdom cannot navigate: the reload is observed here instead.
  vi.stubGlobal('location', { origin: 'http://localhost:3000', href: 'http://localhost:3000/cms', reload: mocks.reload });
  mocks.list.mockResolvedValue({
    revisions: [
      { id: 2, version: 2, revision_type: 'diff', created_at: '2026-11-14T10:00:00Z', author_id: null, has_changes: false },
      { id: 1, version: 1, revision_type: 'snapshot', created_at: '2026-11-13T10:00:00Z', author_id: null, has_changes: true },
    ],
    currentVersion: 2,
    totalPages: 1,
  });
  mocks.restore.mockResolvedValue({ success: true, version: 3 });
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

async function render(element: ReactNode): Promise<HTMLElement> {
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

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}

/** Opens the history, restores version 1, and lets the 800 ms timers run. */
async function restoreVersionOne(container: HTMLElement) {
  await click(button(container, 'Revision History'));
  await click(button(container, 'Restore'));
  expect(mocks.restore).toHaveBeenCalledTimes(1);
  expect(mocks.toast.success).toHaveBeenCalledWith('Version restored successfully');
  expect(mocks.router.refresh).toHaveBeenCalledTimes(1);
  expect(mocks.reload).not.toHaveBeenCalled();
  await act(async () => {
    vi.advanceTimersByTime(800);
  });
}

describe('RevisionHistoryButton restore', () => {
  it("reloads a product's page after a restore, which deleted its draft (the edit page's flag only latches on)", async () => {
    const container = await render(<RevisionHistoryButton parentType="product" parentId={PRODUCT_ID} />);

    await restoreVersionOne(container);

    expect(mocks.restore).toHaveBeenCalledWith(PRODUCT_ID, 1);
    expect(mocks.reload).toHaveBeenCalledTimes(1);
  });

  it.each(['page', 'post'] as const)('only refreshes a %s after a restore, as before', async (parentType) => {
    const container = await render(<RevisionHistoryButton parentType={parentType} parentId={7} />);

    await restoreVersionOne(container);

    expect(mocks.restore).toHaveBeenCalledWith(7, 1);
    expect(mocks.reload).not.toHaveBeenCalled();
  });

  it('neither refreshes nor reloads after a refused restore', async () => {
    mocks.restore.mockResolvedValue({ error: 'Forbidden' });
    const container = await render(<RevisionHistoryButton parentType="product" parentId={PRODUCT_ID} />);

    await click(button(container, 'Revision History'));
    await click(button(container, 'Restore'));
    await act(async () => {
      vi.advanceTimersByTime(800);
    });

    expect(mocks.toast.error).toHaveBeenCalledWith('Forbidden');
    expect(mocks.router.refresh).not.toHaveBeenCalled();
    expect(mocks.reload).not.toHaveBeenCalled();
  });
});
