// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { editorExtensions } from '../../kit';
import { EditorToolbar } from './Toolbar';

/**
 * The toolbar's Preview opens the editor HTML as a blob: document in an iframe. A blob: document
 * has the CMS origin and inherits the CMS CSP, whose script-src allows blob:, and the iframe
 * allows scripts and same-origin. Block HTML is WRITER-authored (PostgREST included; any visitor
 * on the public sandbox), so the preview gets the text-block sanitizer, like the public render.
 * It used to rewrite every inline script into a blob: script, which ran with the session of
 * whoever clicked Preview. The sanitizer does not read the sandbox flag.
 */

const AUTHORED =
  '<p>Hello preview</p>' +
  '<script>parent.document.title = "pwned"</script>' +
  '<script src="https://www.googletagmanager.com/gtm.js?id=GTM-ATTACKER"></script>' +
  '<p>Icon <svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"></path><foreignObject><img src="x" onerror="alert(1)"></foreignObject></svg></p>';

const blobs = new Map<string, Blob>();
const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');

let host: HTMLDivElement;
let container: HTMLDivElement;
let root: Root;
let editor: Editor;

async function openPreview(): Promise<string> {
  const button = container.querySelector<HTMLButtonElement>('button[title="Preview"]');
  if (!button) throw new Error('Preview button not rendered');
  await act(async () => {
    button.click();
  });
  const frame = container.querySelector<HTMLIFrameElement>('iframe[title="Editor Preview"]');
  const src = frame?.getAttribute('src') ?? '';
  const blob = blobs.get(src);
  if (!blob) throw new Error(`preview iframe does not show a captured blob (${src})`);
  return blob.text();
}

describe.each(['true', '', 'false', 'TRUE', '1'])('EditorToolbar preview with NEXT_PUBLIC_IS_SANDBOX=%j', (flag) => {
  beforeEach(async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', flag);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    blobs.clear();
    let counter = 0;
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn((blob: Blob) => {
        counter += 1;
        const url = `blob:https://cms.test/preview-${counter}`;
        blobs.set(url, blob);
        return url;
      }),
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });

    host = document.createElement('div');
    container = document.createElement('div');
    document.body.append(host, container);
    editor = new Editor({ element: host, extensions: editorExtensions, content: AUTHORED });
    root = createRoot(container);
    await act(async () => {
      root.render(<EditorToolbar editor={editor} />);
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    editor.destroy();
    host.remove();
    container.remove();
    if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate);
    else delete (URL as { createObjectURL?: unknown }).createObjectURL;
    if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
    else delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
    vi.unstubAllEnvs();
  });

  it('keeps the authored scripts the editor holds out of the preview document', async () => {
    // The editor does hold them: ScriptTagNode exports them with the HTML.
    expect(editor.getHTML()).toContain('<script');

    const previewDocument = await openPreview();
    expect(previewDocument).not.toMatch(/<script|onerror|javascript:|http-equiv|srcdoc/i);

    const parsed = new DOMParser().parseFromString(previewDocument, 'text/html');
    expect(parsed.querySelectorAll('script, [onerror]')).toHaveLength(0);
    // Only the preview's own document is a blob now: no authored script became one.
    expect(blobs.size).toBe(1);
  });

  it('still previews the content', async () => {
    const previewDocument = await openPreview();
    const parsed = new DOMParser().parseFromString(previewDocument, 'text/html');
    expect(parsed.body.textContent).toContain('Hello preview');
    expect(parsed.querySelector('svg path')?.getAttribute('d')).toBe('M0 0h24v24H0z');
  });
});
