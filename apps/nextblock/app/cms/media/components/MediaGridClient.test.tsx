// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The media library's bulk delete and "Unused" view (0.23.4 follow-up). "Delete Selected" used to
 * delete at once; it now asks where the selected files are used (getMediaUsage: public.media_usage,
 * 02045) and offers "Delete only the unused" (deleteUnusedMediaItems, which checks again on the
 * server) or "Delete all". The "Unused" view lists what nothing uses and deletes it the same way.
 * The real grid and the real dialogs; the server actions are mocked.
 */

const mocks = vi.hoisted(() => ({
  getMediaUsage: vi.fn(),
  deleteUnusedMediaItems: vi.fn(),
  deleteMultipleMediaItems: vi.fn(),
  moveSingleMediaItem: vi.fn(),
  deleteMediaItem: vi.fn(),
}));

vi.mock('../actions', () => mocks);
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('./MediaImage', () => ({ default: ({ alt }: { alt: string }) => <span role="img" aria-label={alt} /> }));

import MediaGridClient from './MediaGridClient';

const USED = 'a1111111-1111-4111-8111-11111111111a';
const UNUSED = 'b2222222-2222-4222-8222-22222222222b';
const HISTORY = 'c3333333-3333-4333-8333-33333333333c';

const media = (id: string, name: string) =>
  ({ id, file_name: name, object_key: `uploads/${name}`, file_path: `uploads/${name}`, file_type: 'image/webp', description: null, width: 10, height: 10, blur_data_url: null }) as any;

const ITEMS = [media(USED, 'used.webp'), media(UNUSED, 'unused.webp'), media(HISTORY, 'history.webp')];
const unusedEntry = { total: 0, byKind: {}, sites: [] };
const usedEntry = {
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
  mocks.getMediaUsage.mockResolvedValue({ usage: { [USED]: usedEntry, [UNUSED]: unusedEntry } });
  mocks.deleteUnusedMediaItems.mockResolvedValue({ success: 'Deleted 1 unused file. 1 in use (or gone) was kept.', deletedIds: [UNUSED] });
  mocks.deleteMultipleMediaItems.mockResolvedValue({ success: 'Selected media items deleted successfully.' });
});

afterEach(async () => {
  if (mounted) {
    const { root, container } = mounted;
    await act(async () => root.unmount());
    container.remove();
    mounted = null;
  }
});

async function render(element: ReactNode) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted = { root, container };
  await act(async () => root.render(element));
  return container;
}

/** A button anywhere in the document (the dialogs render in a portal), by its text. */
function button(label: string | RegExp): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((candidate) =>
    typeof label === 'string' ? candidate.textContent?.trim() === label : label.test(candidate.textContent ?? '')
  );
  if (!found) throw new Error(`no button ${label}`);
  return found as HTMLButtonElement;
}

async function click(element: Element) {
  await act(async () => {
    (element as HTMLElement).click();
  });
}

async function selectAndOpenBulkDelete(container: HTMLElement, ids: string[]) {
  for (const id of ids) {
    const box = container.querySelector(`#select-${id}`);
    if (!box) throw new Error(`no checkbox for ${id}`);
    await click(box);
  }
  await click(button(/Delete Selected/));
}

describe('MediaGridClient bulk delete', () => {
  it('says which selected files are used before deleting, and deletes only the unused on request', async () => {
    const container = await render(<MediaGridClient initialMediaItems={ITEMS.slice(0, 2)} r2BaseUrl="" />);

    await selectAndOpenBulkDelete(container, [USED, UNUSED]);

    expect(mocks.getMediaUsage).toHaveBeenCalledWith([USED, UNUSED]);
    expect(mocks.deleteMultipleMediaItems).not.toHaveBeenCalled();
    const dialog = document.querySelector('[data-bulk-delete-usage]');
    expect(dialog?.textContent).toContain('1 of 2 is used:');
    expect(dialog?.textContent).toContain('used.webp');
    expect(dialog?.querySelector('a[href="/cms/pages/7/edit"]')).not.toBeNull();
    expect(dialog?.textContent).toContain('1 is not used anywhere in this site.');

    await click(button('Delete only the unused (1)'));

    expect(mocks.deleteUnusedMediaItems).toHaveBeenCalledWith([USED, UNUSED]);
    expect(container.textContent).toContain('Deleted 1 unused file. 1 in use (or gone) was kept.');
    expect(container.querySelector(`#select-${UNUSED}`)).toBeNull();
    expect(container.querySelector(`#select-${USED}`)).not.toBeNull();
  });

  it('deletes every selected file on "Delete all", used ones included', async () => {
    const container = await render(<MediaGridClient initialMediaItems={ITEMS.slice(0, 2)} r2BaseUrl="" />);

    await selectAndOpenBulkDelete(container, [USED, UNUSED]);
    await click(button('Delete all 2'));

    expect(mocks.deleteMultipleMediaItems).toHaveBeenCalledWith([
      { id: USED, objectKey: 'uploads/used.webp' },
      { id: UNUSED, objectKey: 'uploads/unused.webp' },
    ]);
    expect(mocks.deleteUnusedMediaItems).not.toHaveBeenCalled();
    expect(container.querySelector(`#select-${USED}`)).toBeNull();
  });

  it('offers no "Delete only the unused" when the check failed, and says why', async () => {
    mocks.getMediaUsage.mockResolvedValue({ error: 'Where this media is used could not be checked: timeout' });
    const container = await render(<MediaGridClient initialMediaItems={ITEMS.slice(0, 2)} r2BaseUrl="" />);

    await selectAndOpenBulkDelete(container, [USED]);

    expect(document.querySelector('[data-bulk-delete-usage]')?.textContent).toContain('could not be checked: timeout');
    expect(button(/Delete only the unused/).disabled).toBe(true);
    expect(button('Delete all 1').disabled).toBe(false);
  });
});

describe('MediaGridClient "Unused" view', () => {
  it('says how many files nothing uses, notes the history-only ones, and deletes them after a confirmation', async () => {
    mocks.deleteUnusedMediaItems.mockResolvedValue({ success: 'Deleted 2 unused files.', deletedIds: [UNUSED, HISTORY] });
    const container = await render(
      <MediaGridClient initialMediaItems={ITEMS.slice(1)} r2BaseUrl="" unusedView={{ historyOnlyIds: [HISTORY] }} />
    );

    const banner = container.querySelector('[data-unused-banner]');
    expect(banner?.textContent).toContain('2 files are not used anywhere in this site');
    expect(banner?.textContent).toContain('1 of them appears only in revision history.');

    await click(button(/Delete all 2 unused/));
    expect(mocks.deleteUnusedMediaItems).not.toHaveBeenCalled(); // a confirmation first
    expect(document.body.textContent).toContain('Each file is checked again before it is deleted');

    await click(button('Delete'));

    expect(mocks.deleteUnusedMediaItems).toHaveBeenCalledWith([UNUSED, HISTORY]);
    expect(container.textContent).toContain('Deleted 2 unused files.');
    expect(container.textContent).toContain('Nothing to clean up');
  });

  it('lists nothing and says why when the lookup failed', async () => {
    const container = await render(
      <MediaGridClient initialMediaItems={[]} r2BaseUrl="" usageError="Where this media is used could not be checked: timeout" />
    );

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'could not be checked: timeout Nothing is listed as unused until the check works again.'
    );
    expect(container.textContent).toContain('Unused files could not be listed');
    expect(container.querySelector('[data-unused-banner]')).toBeNull();
  });
});
