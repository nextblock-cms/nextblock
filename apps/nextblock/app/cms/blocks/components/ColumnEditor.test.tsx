// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A block with nothing to configure (cart, checkout, product_details) opens no editor, so a section
 * column draws no Edit button or pointer cursor on it, as EditableBlock does at the top level. The
 * column used to draw both on every block, and clicking either did nothing for these three.
 */

vi.mock('./BlockEditorModal', () => ({ BlockEditorModal: () => null }));
vi.mock('./CustomBlockEditorPreview', () => ({
  CustomBlockEditorPreview: ({ fallback }: { fallback: React.ReactNode }) => <>{fallback}</>,
}));
vi.mock('./BlockTypeSelector', () => ({ default: () => null }));

import ColumnEditor from './ColumnEditor';

// The Edit button by either of its names, so a card that still draws it cannot pass for one that does not.
const EDIT_BUTTON = 'button[title="Edit block"], button[aria-label="Edit block"]';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe('ColumnEditor block cards', () => {
  it('show the Edit button and the pointer only on a block with something to configure', async () => {
    await act(async () => {
      root.render(
        <ColumnEditor
          columnIndex={0}
          blocks={[
            { block_type: 'cart', content: {} },
            { block_type: 'text', content: {} },
          ]}
          onBlocksChange={() => undefined}
          blockType="section"
        />
      );
    });

    const cards = Array.from(container.querySelectorAll<HTMLElement>('[aria-roledescription="sortable"]'));
    expect(cards).toHaveLength(2);
    const [cart, text] = cards;

    expect(container.querySelectorAll(EDIT_BUTTON)).toHaveLength(1);
    // Named for assistive tech as EditableBlock names its own.
    expect(text.querySelector(EDIT_BUTTON)?.getAttribute('aria-label')).toBe('Edit block');
    expect(text.classList.contains('cursor-pointer')).toBe(true);

    expect(cart.querySelector(EDIT_BUTTON)).toBeNull();
    expect(cart.classList.contains('cursor-pointer')).toBe(false);
    // Labelled like EditableBlock's card, and it can still be deleted.
    expect(cart.textContent).toContain('Renders from the current page context — nothing to configure');
    expect(cart.textContent).not.toContain('Click edit to configure');
    expect(cart.querySelector('button[title="Delete block"]')).not.toBeNull();
  });
});
