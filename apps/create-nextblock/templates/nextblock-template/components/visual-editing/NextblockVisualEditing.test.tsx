// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The storefront's visual-editing toolbar publishes the draft of the document on the page. Only an
 * ADMIN may publish a product draft (publishProductVisualEditingDraft opens with requireCmsAdmin()),
 * so on a product page the toolbar disables Publish for anyone else, with a note, and keeps Discard.
 * The flag comes from the server (the root layout's currentUserCanPublishProductDrafts(), through
 * DeferredVisualEditing); pages and posts are unaffected. For an ADMIN whose second factor is pending
 * (the layout's secondFactorPending) the note asks for the second factor instead.
 */

const mocks = vi.hoisted(() => ({
  publishVisualEditingDraft: vi.fn(),
  publishVisualEditingProductDraft: vi.fn(),
  discardVisualEditingDraft: vi.fn(),
  discardVisualEditingProductDraft: vi.fn(),
  loadVisualEditingBlockContent: vi.fn(),
  loadVisualEditingProductField: vi.fn(),
  // One object, as Next's useRouter() returns: the toolbar's mount effect depends on it (through
  // startInlineEditing), so a new router each render would re-run that effect forever.
  router: { refresh: vi.fn(), push: vi.fn(), replace: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/product/pro-plugin',
  useRouter: () => mocks.router,
}));
// The in-page editors load on demand; none opens in these tests.
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('../../app/cms/blocks/components/BlockEditorModal', () => ({ BlockEditorModal: () => null }));
vi.mock('../../app/actions/visualEditingActions', () => ({
  publishVisualEditingDraft: mocks.publishVisualEditingDraft,
  publishVisualEditingProductDraft: mocks.publishVisualEditingProductDraft,
  discardVisualEditingDraft: mocks.discardVisualEditingDraft,
  discardVisualEditingProductDraft: mocks.discardVisualEditingProductDraft,
  loadVisualEditingBlockContent: mocks.loadVisualEditingBlockContent,
  loadVisualEditingProductField: mocks.loadVisualEditingProductField,
}));

import { NextblockVisualEditing, PRODUCT_PUBLISH_SECOND_FACTOR_NOTE } from './NextblockVisualEditing';
import { PRODUCT_PUBLISH_ADMIN_ONLY_NOTE } from '../../lib/visual-editing/product-draft-meta';

const PRODUCT_ID = '123e4567-e89b-12d3-a456-426614174000';

/** What the product page renders around an editable product field. */
const PRODUCT_EDIT_INFO = {
  origin: 'nextblock',
  data: {
    parentType: 'product',
    parentId: PRODUCT_ID,
    target: { kind: 'product-field', field: 'title', input: 'plain-text', label: 'Product title' },
  },
};
const PAGE_EDIT_INFO = {
  origin: 'nextblock',
  data: { parentType: 'page', parentId: 7, target: { kind: 'top-level', blockId: 1, blockIndex: 0, blockType: 'text' } },
};

let mounted: Array<{ root: Root; container: HTMLElement }> = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  // Refusals keep the toolbar as it is (a successful discard reloads the page).
  mocks.publishVisualEditingProductDraft.mockResolvedValue({ success: false, error: 'refused' });
  mocks.publishVisualEditingDraft.mockResolvedValue({ error: 'refused' });
  mocks.discardVisualEditingProductDraft.mockResolvedValue({ error: 'not discarded' });
  // styled-jsx's `<style jsx global>` is compiled by Next only; React warns about the raw attribute here.
  const consoleError = console.error;
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('non-boolean attribute')) return;
    consoleError(...args);
  });
});

afterEach(async () => {
  for (const { root, container } of mounted) {
    await act(async () => root.unmount());
    container.remove();
  }
  mounted = [];
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/** The page's first editable element decides the toolbar's document (as on the storefront). */
async function renderToolbar(editInfo: unknown, canPublishProducts?: boolean, secondFactorPending?: boolean) {
  const editable = document.createElement('h1');
  editable.setAttribute('data-vercel-edit-info', JSON.stringify(editInfo));
  editable.textContent = 'Pro plugin';
  document.body.appendChild(editable);

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      canPublishProducts === undefined ? (
        <NextblockVisualEditing />
      ) : (
        <NextblockVisualEditing canPublishProducts={canPublishProducts} secondFactorPending={secondFactorPending} />
      )
    );
  });
  return container;
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`no ${label} button`);
  return found as HTMLButtonElement;
}

describe('the storefront toolbar on a product page', () => {
  it('disables Publish for anyone but an ADMIN, says who publishes, and keeps Discard', async () => {
    const container = await renderToolbar(PRODUCT_EDIT_INFO, false);

    const publish = button(container, 'Publish');
    expect(publish.disabled).toBe(true);
    const noteId = publish.getAttribute('aria-describedby');
    expect(noteId).toBeTruthy();
    expect(document.getElementById(noteId as string)?.textContent).toBe(PRODUCT_PUBLISH_ADMIN_ONLY_NOTE);

    await act(async () => {
      publish.click();
    });
    expect(mocks.publishVisualEditingProductDraft).not.toHaveBeenCalled();

    const discard = button(container, 'Discard');
    expect(discard.disabled).toBe(false);
    await act(async () => {
      discard.click();
    });
    expect(mocks.discardVisualEditingProductDraft).toHaveBeenCalledWith(PRODUCT_ID);
  });

  it('disables Publish when no flag is passed (fails closed)', async () => {
    const container = await renderToolbar(PRODUCT_EDIT_INFO);

    expect(button(container, 'Publish').disabled).toBe(true);
    expect(container.textContent).toContain(PRODUCT_PUBLISH_ADMIN_ONLY_NOTE);
  });

  it('asks an ADMIN whose second factor is pending to complete it, instead of naming the administrator', async () => {
    const container = await renderToolbar(PRODUCT_EDIT_INFO, false, true);

    const publish = button(container, 'Publish');
    expect(publish.disabled).toBe(true);
    expect(document.getElementById(publish.getAttribute('aria-describedby') as string)?.textContent).toBe(
      'Complete two-factor verification to publish product changes.'
    );
    expect(container.textContent).not.toContain(PRODUCT_PUBLISH_ADMIN_ONLY_NOTE);
    await act(async () => {
      publish.click();
    });
    expect(mocks.publishVisualEditingProductDraft).not.toHaveBeenCalled();
  });

  it('shows no note at all once Publish is allowed, whatever secondFactorPending says', async () => {
    const container = await renderToolbar(PRODUCT_EDIT_INFO, true, true);

    expect(button(container, 'Publish').disabled).toBe(false);
    expect(container.textContent).not.toContain(PRODUCT_PUBLISH_SECOND_FACTOR_NOTE);
    expect(container.textContent).not.toContain(PRODUCT_PUBLISH_ADMIN_ONLY_NOTE);
  });

  it('offers Publish to an ADMIN, with no note, and publishes the product draft', async () => {
    const container = await renderToolbar(PRODUCT_EDIT_INFO, true);

    const publish = button(container, 'Publish');
    expect(publish.disabled).toBe(false);
    expect(publish.hasAttribute('aria-describedby')).toBe(false);
    expect(container.textContent).not.toContain(PRODUCT_PUBLISH_ADMIN_ONLY_NOTE);

    await act(async () => {
      publish.click();
    });
    expect(mocks.publishVisualEditingProductDraft).toHaveBeenCalledWith(PRODUCT_ID);
    // The server's answer is shown as it came: it stays the authority.
    expect(container.textContent).toContain('refused');
  });
});

describe('the storefront toolbar on a page', () => {
  it('keeps Publish for a page draft whatever the product flag says', async () => {
    const container = await renderToolbar(PAGE_EDIT_INFO, false);

    const publish = button(container, 'Publish');
    expect(publish.disabled).toBe(false);
    expect(container.textContent).not.toContain(PRODUCT_PUBLISH_ADMIN_ONLY_NOTE);

    await act(async () => {
      publish.click();
    });
    expect(mocks.publishVisualEditingDraft).toHaveBeenCalledWith('page', 7);
  });
});
