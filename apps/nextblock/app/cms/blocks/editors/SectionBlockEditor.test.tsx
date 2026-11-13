// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The drag overlay previews the first characters of a text block's HTML while it is dragged
 * between columns. That HTML is WRITER-authored (any visitor on the public sandbox), and the
 * overlay renders inside /cms for whoever drags the block, so it goes through the text-block
 * sanitizer before the cut, like every other render of block HTML. The sanitizer does not read
 * the sandbox flag.
 */

const dnd = vi.hoisted(() => ({
  onDragStart: undefined as undefined | ((event: { active: { id: string } }) => void),
}));

vi.mock('@dnd-kit/core', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DndContext: ({
    children,
    onDragStart,
  }: {
    children?: React.ReactNode;
    onDragStart?: (event: { active: { id: string } }) => void;
  }) => {
    dnd.onDragStart = onDragStart;
    return <>{children}</>;
  },
  DragOverlay: ({ children }: { children?: React.ReactNode }) => <div data-drag-overlay="">{children}</div>,
}));
vi.mock('@dnd-kit/sortable', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  SortableContext: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../components/ColumnEditor', () => ({ default: () => null }));
vi.mock('../components/SectionConfigPanel', () => ({ default: () => null }));
vi.mock('../components/BackgroundSelector', () => ({ default: () => null }));

import SectionBlockEditor from './SectionBlockEditor';

// Each fits in the 30 characters the overlay keeps, so the old code rendered it whole.
const PAYLOADS: Array<[label: string, html: string]> = [
  ['an onerror handler', '<img src=x onerror=alert(1)>'],
  ['a base element', '<base href=//evil.example/>'],
  ['an iframe with srcdoc', '<iframe srcdoc=&lt;b&gt;x>'],
  ['a javascript: link', '<a href=javascript:alert(1)>x'],
];

let container: HTMLDivElement;
let root: Root;

async function dragTextBlock(htmlContent: string): Promise<Element> {
  await act(async () => {
    root.render(
      <SectionBlockEditor
        content={{ column_blocks: [[{ block_type: 'text', content: { html_content: htmlContent } }]] }}
        onChange={() => undefined}
        isConfigPanelOpen={false}
        blockType="section"
      />
    );
  });
  await act(async () => {
    dnd.onDragStart?.({ active: { id: 'section-column-0-block-0' } });
  });
  const overlay = container.querySelector('[data-drag-overlay]');
  if (!overlay) throw new Error('drag overlay not rendered');
  return overlay;
}

function activeConstructs(overlay: Element): string[] {
  const found = Array.from(overlay.querySelectorAll('script, meta, base, iframe[srcdoc], [onerror]')).map((element) =>
    element.tagName.toLowerCase(),
  );
  overlay.querySelectorAll('a[href]').forEach((anchor) => {
    if (/^\s*javascript:/i.test(anchor.getAttribute('href') ?? '')) found.push('a[href=javascript:]');
  });
  return found;
}

describe.each(['true', '', 'false', 'TRUE', '1'])('SectionBlockEditor drag overlay with NEXT_PUBLIC_IS_SANDBOX=%j', (flag) => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', flag);
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
    dnd.onDragStart = undefined;
    vi.unstubAllEnvs();
  });

  it.each(PAYLOADS)('renders %s from the dragged text block inert', async (_label, html) => {
    const overlay = await dragTextBlock(html);
    expect(activeConstructs(overlay)).toEqual([]);
    expect(overlay.innerHTML).not.toMatch(/onerror|srcdoc|javascript:|<base/i);
  });

  it('still previews the first 30 characters of ordinary text block HTML', async () => {
    const overlay = await dragTextBlock('<p><strong>Hello</strong> world, this is a long paragraph</p>');
    // '<p><strong>Hello</strong> worl' is the 30-character cut, then the ellipsis.
    expect(overlay.textContent).toContain('Hello worl...');
    expect(overlay.querySelector('p strong')?.textContent).toBe('Hello');
  });
});
