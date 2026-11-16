// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { User } from '@supabase/supabase-js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The root layout mounts the visual-editing toolbar through DeferredVisualEditing and hands it the
 * flag it computed on the server while the visual editor is on: currentUserCanPublishProductDrafts(),
 * an ADMIN past the second factor, the check publishProductVisualEditingDraft opens with
 * (app/layout.test.tsx). The flag used to be AuthProvider's profile role, so an ADMIN whose second
 * factor was pending saw Publish enabled on a product draft and was refused on every click. The
 * layout also says when the profile is an ADMIN's (secondFactorPending): that ADMIN's disabled Publish
 * asks for the second factor instead of saying that an administrator publishes.
 */

const mocks = vi.hoisted(() => ({
  toolbarProps: vi.fn(),
  publishVisualEditingDraft: vi.fn(),
  publishVisualEditingProductDraft: vi.fn(),
  discardVisualEditingDraft: vi.fn(),
  discardVisualEditingProductDraft: vi.fn(),
  loadVisualEditingBlockContent: vi.fn(),
  loadVisualEditingProductField: vi.fn(),
  // One object, as Next's useRouter() returns (the toolbar's mount effect depends on it).
  router: { refresh: vi.fn(), push: vi.fn(), replace: vi.fn() },
}));

// next/dynamic loads the real toolbar in the browser only; this stands in for what it renders and
// records the props DeferredVisualEditing hands it. (The toolbar's own editors are dynamic too; none
// opens here.)
vi.mock('next/dynamic', () => ({
  default: () => (props: Record<string, unknown>) => {
    mocks.toolbarProps(props);
    return null;
  },
}));
// What the real toolbar needs, rendered below with the props DeferredVisualEditing handed over.
vi.mock('next/navigation', () => ({
  usePathname: () => '/product/pro-plugin',
  useRouter: () => mocks.router,
}));
vi.mock('../../app/cms/blocks/components/BlockEditorModal', () => ({ BlockEditorModal: () => null }));
vi.mock('../../app/actions/visualEditingActions', () => ({
  publishVisualEditingDraft: mocks.publishVisualEditingDraft,
  publishVisualEditingProductDraft: mocks.publishVisualEditingProductDraft,
  discardVisualEditingDraft: mocks.discardVisualEditingDraft,
  discardVisualEditingProductDraft: mocks.discardVisualEditingProductDraft,
  loadVisualEditingBlockContent: mocks.loadVisualEditingBlockContent,
  loadVisualEditingProductField: mocks.loadVisualEditingProductField,
}));

import { AuthProvider } from '../../context/AuthContext';
import { DeferredVisualEditing } from './DeferredVisualEditing';
import { NextblockVisualEditing, PRODUCT_PUBLISH_SECOND_FACTOR_NOTE } from './NextblockVisualEditing';
import { PRODUCT_PUBLISH_ADMIN_ONLY_NOTE } from '../../lib/visual-editing/product-draft-meta';

const PRODUCT_ID = '123e4567-e89b-12d3-a456-426614174000';

let mounted: Array<{ root: Root; container: HTMLElement }> = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.publishVisualEditingProductDraft.mockResolvedValue({ success: false, error: 'refused' });
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

async function render(element: ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(element);
  });
  return container;
}

/** The props DeferredVisualEditing handed the toolbar, under AuthProvider with the profile's `role`. */
async function toolbarPropsFor(canPublishProducts: boolean, role: string | null, secondFactorPending = false) {
  const profile = role ? ({ id: 'user-1', role } as never) : null;
  await render(
    <AuthProvider serverUser={role ? ({ id: 'user-1' } as User) : null} serverProfile={profile}>
      <DeferredVisualEditing canPublishProducts={canPublishProducts} secondFactorPending={secondFactorPending} />
    </AuthProvider>
  );
  return mocks.toolbarProps.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

/** The real toolbar with `props`, on a product page (its first editable element is a product field). */
async function renderToolbarOnProductPage(props: Record<string, unknown>) {
  const editable = document.createElement('h1');
  editable.setAttribute(
    'data-vercel-edit-info',
    JSON.stringify({
      origin: 'nextblock',
      data: {
        parentType: 'product',
        parentId: PRODUCT_ID,
        target: { kind: 'product-field', field: 'title', input: 'plain-text', label: 'Product title' },
      },
    })
  );
  document.body.appendChild(editable);
  return render(<NextblockVisualEditing {...props} />);
}

function publishButton(container: HTMLElement): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === 'Publish');
  if (!found) throw new Error('no Publish button');
  return found as HTMLButtonElement;
}

describe('DeferredVisualEditing hands the toolbar the root layout flag, never the profile role', () => {
  it.each([true, false])('passes canPublishProducts=%s through as the layout computed it', async (flag) => {
    await expect(toolbarPropsFor(flag, null)).resolves.toEqual({ canPublishProducts: flag, secondFactorPending: false });
  });

  it('gives an ADMIN whose second factor is pending (the layout flag is false) a disabled Publish that asks for it', async () => {
    // The profile still says ADMIN; only the server-side check knows the second factor is pending,
    // and the layout says so (secondFactorPending) for the note alone.
    const props = await toolbarPropsFor(false, 'ADMIN', true);
    expect(props).toEqual({ canPublishProducts: false, secondFactorPending: true });

    const container = await renderToolbarOnProductPage(props);
    const publish = publishButton(container);
    expect(publish.disabled).toBe(true);
    expect(document.getElementById(publish.getAttribute('aria-describedby') as string)?.textContent).toBe(
      PRODUCT_PUBLISH_SECOND_FACTOR_NOTE
    );
    expect(PRODUCT_PUBLISH_SECOND_FACTOR_NOTE).toBe('Complete two-factor verification to publish product changes.');
    expect(container.textContent).not.toContain(PRODUCT_PUBLISH_ADMIN_ONLY_NOTE);
    await act(async () => {
      publish.click();
    });
    expect(mocks.publishVisualEditingProductDraft).not.toHaveBeenCalled();
  });

  it('gives anyone else (the layout flag is false, no pending ADMIN) a disabled Publish with the admin-only note', async () => {
    const props = await toolbarPropsFor(false, 'WRITER');
    const container = await renderToolbarOnProductPage(props);

    const publish = publishButton(container);
    expect(publish.disabled).toBe(true);
    expect(document.getElementById(publish.getAttribute('aria-describedby') as string)?.textContent).toBe(
      PRODUCT_PUBLISH_ADMIN_ONLY_NOTE
    );
  });

  it('gives an ADMIN past the second factor (the layout flag is true) an enabled Publish', async () => {
    const props = await toolbarPropsFor(true, 'ADMIN');
    const container = await renderToolbarOnProductPage(props);

    expect(publishButton(container).disabled).toBe(false);
    expect(container.textContent).not.toContain(PRODUCT_PUBLISH_ADMIN_ONLY_NOTE);
    expect(container.textContent).not.toContain(PRODUCT_PUBLISH_SECOND_FACTOR_NOTE);
  });
});
