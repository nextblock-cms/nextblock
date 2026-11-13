// @vitest-environment jsdom
/* eslint-disable no-script-url -- javascript: URLs are among the hostile inputs */
import type { Editor } from '@tiptap/core';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AffiliatesCopyProvider } from '../i18n/affiliates-copy-provider';
import { emptyStorefrontDoc } from '../storefront/helpers';
import { buildStorefrontStarterDoc } from '../storefront/starter';
import type { StorefrontBlockNode, StorefrontDoc, StorefrontEditorApi, StorefrontEditorProduct } from '../storefront/types';
import { StorefrontEditor } from './StorefrontEditor';

// Lets one test hand the editor a document that fails the schema (the sanitizer would repair it).
const passThrough = vi.hoisted(() => ({ next: false }));
vi.mock('../storefront/sanitize', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../storefront/sanitize')>();
  return {
    ...actual,
    sanitizeStorefrontDoc: (input: unknown, options: Parameters<typeof actual.sanitizeStorefrontDoc>[1]) => {
      if (passThrough.next) {
        passThrough.next = false;
        return { doc: input as StorefrontDoc, issues: [], changed: false };
      }
      return actual.sanitizeStorefrontDoc(input, options);
    },
  };
});

const ORIGINS = ['https://images.pexels.com'];
const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const CATALOG: StorefrontEditorProduct[] = [
  { id: uuid(1), title: 'Lavender candle', imageUrl: null, priceLabel: '$24.00' },
  { id: uuid(2), title: 'Cedar soap', imageUrl: null, priceLabel: '$9.00' },
];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const zeroRect = () => new DOMRect(0, 0, 0, 0);
  if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = zeroRect;
  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  }
  if (!document.elementFromPoint) document.elementFromPoint = () => null;
});

let mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(async () => {
  for (const { root, container } of mounted) {
    await act(async () => root.unmount());
    container.remove();
  }
  mounted = [];
  await act(async () => {
    await sleep(5);
  });
  document.body.innerHTML = '';
  passThrough.next = false;
  vi.restoreAllMocks();
});

async function settle(ms = 20) {
  await act(async () => {
    await sleep(ms);
  });
}

async function waitFor<T>(read: () => T | null | undefined | false, label: string, timeout = 2000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}`);
    await settle(10);
  }
}

interface Harness {
  container: HTMLElement;
  api: StorefrontEditorApi;
  editor: Editor;
  onChange: ReturnType<typeof vi.fn>;
}

async function renderEditor(
  props: Partial<Parameters<typeof StorefrontEditor>[0]> = {},
  wrap: (ui: ReactElement) => ReactElement = (ui) => ui
): Promise<Harness> {
  const onChange = vi.fn();
  let api: StorefrontEditorApi | null = null;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });

  await act(async () => {
    root.render(
      wrap(
        <StorefrontEditor
          initialContent={buildStorefrontStarterDoc({ locale: 'en', displayName: 'Jane' })}
          onChange={onChange}
          allowedImageOrigins={ORIGINS}
          searchProducts={async () => CATALOG}
          resolveProducts={async (ids) => CATALOG.filter((entry) => ids.includes(entry.id))}
          onEditorReady={(ready) => {
            api = ready;
          }}
          {...props}
        />
      )
    );
  });

  const ready = await waitFor(() => api, 'onEditorReady');
  const dom = await waitFor(() => container.querySelector<HTMLElement & { editor?: Editor }>('.ProseMirror'), 'editor DOM');
  await settle();
  const editor = dom.editor;
  if (!editor) throw new Error('no editor instance on the editor DOM');
  return { container, api: ready, editor, onChange };
}

function toolbarButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`[role="toolbar"] button[aria-label="${label}"]`);
  if (!button) throw new Error(`no toolbar button ${label}`);
  return button;
}

function lastDoc(onChange: ReturnType<typeof vi.fn>): StorefrontDoc {
  const call = onChange.mock.calls.at(-1);
  if (!call) throw new Error('onChange was not called');
  return call[0] as StorefrontDoc;
}

describe('StorefrontEditor', () => {
  it('renders a labelled region and an accessible toolbar, and emits nothing on load', async () => {
    const { container, onChange } = await renderEditor();

    expect(container.querySelector('section[aria-label="Storefront editor"]')).not.toBeNull();
    const toolbar = container.querySelector('[role="toolbar"]');
    expect(toolbar?.getAttribute('aria-label')).toBe('Text formatting');
    for (const label of [
      'Bold',
      'Italic',
      'Underline',
      'Strikethrough',
      'Link',
      'Heading 2',
      'Heading 3',
      'Bulleted list',
      'Numbered list',
      'Quote',
      'Callout',
      'Add products',
      'Undo',
      'Redo',
    ]) {
      expect(toolbarButton(container, label)).toBeTruthy();
    }
    expect(container.querySelector('[aria-label="Add an image"]')).toBeNull();
    expect(toolbarButton(container, 'Bold').getAttribute('aria-pressed')).toBe('false');
    expect(toolbarButton(container, 'Undo').disabled).toBe(true);
    expect(toolbar?.querySelectorAll('button[tabindex="0"]')).toHaveLength(1);

    const surface = container.querySelector('.ProseMirror');
    expect(surface?.getAttribute('aria-label')).toBe('Storefront content');
    expect(surface?.getAttribute('contenteditable')).toBe('true');
    expect(surface?.textContent).toContain("Welcome to Jane's picks");
    expect(onChange).not.toHaveBeenCalled();
  });

  it('emits the sanitized document after every change, and through the api', async () => {
    const { api, onChange } = await renderEditor({ initialContent: emptyStorefrontDoc() });

    await act(async () => {
      api.insertBlocks([
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Click', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }],
        },
        { type: 'image', attrs: { src: 'https://evil.example/pixel.gif', alt: '', title: null, width: null, height: null, credit: null } },
        { type: 'affiliateProductGrid', attrs: { productIds: [uuid(1), 'nope'], title: null, columns: 3 } },
      ] as StorefrontBlockNode[]);
    });
    await settle();

    expect(onChange).toHaveBeenCalled();
    const doc = lastDoc(onChange);
    const serialized = JSON.stringify(doc);
    expect(serialized).not.toContain('javascript:');
    expect(serialized).not.toContain('evil.example');
    expect(doc.content.map((block) => block.type)).toEqual(['paragraph', 'affiliateProductGrid', 'paragraph']);
    expect(doc.content[0]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'Click' }] });
    expect(api.getDoc()).toEqual(doc);

    const calls = onChange.mock.calls.length;
    await act(async () => {
      api.insertBlocks([{ type: 'script' } as unknown as StorefrontBlockNode]);
    });
    await settle();
    expect(onChange.mock.calls.length).toBe(calls);
  });

  it('reflects the formatting at the selection in aria-pressed', async () => {
    const { container, editor, onChange } = await renderEditor({ initialContent: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Make me bold' }] }] } });

    await act(async () => {
      editor.commands.setTextSelection({ from: 1, to: 5 });
    });
    await act(async () => toolbarButton(container, 'Bold').click());
    await settle();

    expect(toolbarButton(container, 'Bold').getAttribute('aria-pressed')).toBe('true');
    expect(lastDoc(onChange).content[0]).toEqual({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Make', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' me bold' },
      ],
    });
    expect(toolbarButton(container, 'Undo').disabled).toBe(false);
  });

  it('goes read-only and never emits when the stored document does not load', async () => {
    passThrough.next = true;
    const { container, api, editor, onChange } = await renderEditor({
      initialContent: { type: 'doc', content: [{ type: 'divBlock' }] } as unknown as StorefrontDoc,
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("couldn't be opened in the editor");
    expect(container.querySelector('[role="toolbar"]')).toBeNull();
    expect(editor.isEditable).toBe(false);

    await act(async () => {
      api.insertBlocks([{ type: 'paragraph', content: [{ type: 'text', text: 'overwrite' }] }]);
      editor.commands.insertContent('typed');
    });
    await settle();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('is read-only when editable is false', async () => {
    const { container, api, editor, onChange } = await renderEditor({ editable: false });

    expect(container.querySelector('[role="toolbar"]')).toBeNull();
    expect(container.querySelector('.ProseMirror')?.getAttribute('contenteditable')).toBe('false');
    await act(async () => {
      api.insertBlocks([{ type: 'paragraph', content: [{ type: 'text', text: 'nope' }] }]);
      editor.commands.setTextSelection({ from: 1, to: 3 });
      expect(api.replaceSelection('nope')).toBe(false);
    });
    await settle();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('replaces through the api only inside one text block, and says whether it did', async () => {
    const { api, editor, onChange } = await renderEditor({
      initialContent: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'These are my picks.' }] },
          { type: 'affiliateProductGrid', attrs: { productIds: [uuid(1)], title: null, columns: 3 } },
          { type: 'paragraph', content: [{ type: 'text', text: 'Enjoy them.' }] },
        ],
      },
    });
    const before = api.getDoc();
    const results: boolean[] = [];

    // The paragraph, the product grid and the next paragraph: refused, nothing changes.
    await act(async () => {
      editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 });
      results.push(api.canReplaceSelection(), api.replaceSelection('Here are the picks I love. I hope you enjoy them.'));
    });
    await settle();
    expect(results).toEqual([false, false]);
    expect(api.getDoc()).toEqual(before);
    expect(onChange).not.toHaveBeenCalled();

    // Inside the first paragraph: replaced, and the grid stays.
    await act(async () => {
      editor.commands.setTextSelection({ from: 1, to: 20 });
      results.push(api.canReplaceSelection(), api.replaceSelection('Here are the picks I love.'));
    });
    await settle();
    expect(results.slice(2)).toEqual([true, true]);
    expect(lastDoc(onChange).content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'Here are the picks I love.' }] },
      before.content[1],
      before.content[2],
    ]);
  });

  it('turns /promote into a product grid and fills it from the picker', async () => {
    const searchProducts = vi.fn(async () => CATALOG);
    const { container, editor, onChange } = await renderEditor({ initialContent: emptyStorefrontDoc(), searchProducts });

    await act(async () => {
      editor.commands.setTextSelection(1);
      editor.commands.insertContent('/promote');
    });
    const menu = await waitFor(() => document.querySelector('[role="listbox"][aria-label="Blocks"]'), 'slash menu');
    expect(menu.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain('Promote products');
    expect(editor.view.dom.getAttribute('aria-activedescendant')).toBeTruthy();

    await act(async () => {
      editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    const dialog = await waitFor(() => document.querySelector<HTMLElement>('[role="dialog"]'), 'product picker');
    expect(dialog.textContent).toContain('Choose products');
    expect(document.querySelector('[role="listbox"][aria-label="Blocks"]')).toBeNull();
    expect(editor.getText()).not.toContain('/promote');

    await waitFor(() => dialog.textContent?.includes('2 products found'), 'search results');
    expect(searchProducts).toHaveBeenCalledWith('');
    const candle = Array.from(dialog.querySelectorAll('label')).find((label) => label.textContent?.includes('Lavender candle'));
    await act(async () => candle?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click());
    const save = Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Save selection');
    await act(async () => save?.click());
    await settle();

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const doc = lastDoc(onChange);
    expect(doc.content[0]).toEqual({ type: 'affiliateProductGrid', attrs: { productIds: [uuid(1)], title: null, columns: 3 } });
    await waitFor(() => container.querySelector('[data-storefront-product-grid]')?.textContent?.includes('Lavender candle'), 'grid chip');
    expect(container.querySelector('[data-storefront-product-grid]')?.textContent).toContain('1 of 12 products');
  });

  it('validates links in the link dialog (Ctrl+K)', async () => {
    const { editor, onChange } = await renderEditor({
      initialContent: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Shop here' }] }] },
    });

    await act(async () => {
      editor.commands.setTextSelection({ from: 1, to: 5 });
      editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
    });
    const dialog = await waitFor(() => document.querySelector<HTMLElement>('[role="dialog"]'), 'link dialog');
    expect(dialog.textContent).toContain('Add a link');
    const input = dialog.querySelector<HTMLInputElement>('input');
    const apply = Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Apply');

    const type = (value: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    };
    await act(async () => type('javascript:alert(1)'));
    await act(async () => apply?.click());
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('Use a web address');
    expect(input?.getAttribute('aria-invalid')).toBe('true');

    await act(async () => type('example.com/shop'));
    await act(async () => apply?.click());
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(lastDoc(onChange).content[0]).toEqual({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Shop', marks: [{ type: 'link', attrs: { href: 'https://example.com/shop' } }] },
        { type: 'text', text: ' here' },
      ],
    });
  });

  it('moves through the toolbar with the arrow keys (one Tab stop)', async () => {
    const { container } = await renderEditor();
    const bold = toolbarButton(container, 'Bold');
    await act(async () => bold.focus());
    await act(async () => {
      bold.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(toolbarButton(container, 'Italic'));
    expect(toolbarButton(container, 'Italic').tabIndex).toBe(0);
    expect(bold.tabIndex).toBe(-1);

    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    });
    // Undo and Redo are disabled on a fresh document, so the last stop is "Add products".
    expect(document.activeElement).toBe(toolbarButton(container, 'Add products'));
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(bold);
  });

  it('inserts uploaded images only from allowed hosts, then asks for a description', async () => {
    const uploadImage = vi
      .fn()
      .mockResolvedValueOnce({ src: 'https://evil.example/x.png', width: 10, height: 10 })
      .mockResolvedValueOnce({ src: 'https://images.pexels.com/photos/9/x.png', width: 800, height: 600 });
    const { container, onChange } = await renderEditor({ initialContent: emptyStorefrontDoc(), uploadImage });

    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input?.getAttribute('accept')).toBe('image/jpeg,image/png,image/webp,image/gif');
    expect(toolbarButton(container, 'Add an image')).toBeTruthy();
    const choose = async (file: File) => {
      Object.defineProperty(input, 'files', { configurable: true, value: [file] });
      await act(async () => {
        input?.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await settle();
    };

    await choose(new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' }));
    expect(container.textContent).toContain('Choose a JPEG, PNG, WebP or GIF image.');
    expect(uploadImage).not.toHaveBeenCalled();

    await choose(new File(['x'], 'x.png', { type: 'image/png' }));
    expect(container.textContent).toContain("This image can't be used on your storefront.");
    expect(onChange).not.toHaveBeenCalled();

    await choose(new File(['x'], 'y.png', { type: 'image/png' }));
    const dialog = await waitFor(() => document.querySelector<HTMLElement>('[role="dialog"]'), 'alt dialog');
    expect(dialog.textContent).toContain('Describe this image');
    const alt = dialog.querySelector<HTMLInputElement>('input');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(alt, 'Soy candle on a table');
      alt?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Save');
    await act(async () => save?.click());
    await settle();

    const image = lastDoc(onChange).content.find((block) => block.type === 'image');
    expect(image).toEqual({
      type: 'image',
      attrs: {
        src: 'https://images.pexels.com/photos/9/x.png',
        alt: 'Soy candle on a table',
        title: null,
        width: 800,
        height: 600,
        credit: null,
      },
    });
  });

  it('speaks French under a French copy provider', async () => {
    const { container } = await renderEditor({}, (ui) => <AffiliatesCopyProvider locale="fr-CA">{ui}</AffiliatesCopyProvider>);

    expect(container.querySelector('section[aria-label="Éditeur de vitrine"]')).not.toBeNull();
    expect(toolbarButton(container, 'Gras')).toBeTruthy();
    expect(toolbarButton(container, 'Ajouter des produits')).toBeTruthy();
    expect(container.querySelector('.ProseMirror')?.getAttribute('aria-label')).toBe('Contenu de la vitrine');
  });
});
