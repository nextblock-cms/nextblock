// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SvgNode } from './SvgNode';

/**
 * SvgNode keeps an authored `<svg>`'s inner markup as a string and assigns it with `innerHTML`
 * in the live CMS editor (node view) and in the exported HTML (renderHTML). Block HTML is
 * WRITER-authored, PostgREST included, so whoever opens the block gets that markup in /cms: a
 * `<foreignObject>` holds ordinary HTML, where a meta refresh needs no script. The inner markup
 * goes through the text-block sanitizer. The sanitizer does not read the sandbox flag.
 */

const DANGEROUS_INNER =
  '<foreignObject width="24" height="24">' +
  '<meta http-equiv="refresh" content="0;url=https://evil.example/">' +
  '<base href="https://evil.example/">' +
  '<img src="x" onerror="alert(1)">' +
  '<a href="javascript:alert(1)">x</a>' +
  '<iframe srcdoc="&lt;b&gt;inner&lt;/b&gt;"></iframe>' +
  '</foreignObject>' +
  '<script>alert(1)</script>';
const ICON_PATH = '<path d="M0 0h24v24H0z" fill="currentColor"></path>';

function activeConstructs(root: ParentNode): string[] {
  const found = Array.from(root.querySelectorAll('script, meta, base, iframe[srcdoc], [onerror]')).map((element) =>
    element.tagName.toLowerCase(),
  );
  root.querySelectorAll('a').forEach((anchor) => {
    const href = anchor.getAttribute('href') ?? anchor.getAttribute('xlink:href') ?? '';
    if (/^\s*javascript:/i.test(href)) found.push('a[href=javascript:]');
  });
  return found;
}

let host: HTMLDivElement;
let editor: Editor | null = null;

function mount(content: string): Editor {
  editor = new Editor({ element: host, extensions: [Document, Paragraph, Text, SvgNode], content });
  return editor;
}

describe.each(['true', '', 'false', 'TRUE', '1'])('SvgNode with NEXT_PUBLIC_IS_SANDBOX=%j', (flag) => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', flag);
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    editor?.destroy();
    editor = null;
    host.remove();
    vi.unstubAllEnvs();
  });

  it('puts none of the dangerous inner markup into the live editor', () => {
    mount(`<p>Icon <svg viewBox="0 0 24 24">${ICON_PATH}${DANGEROUS_INNER}</svg> end</p>`);

    const svg = host.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(activeConstructs(host)).toEqual([]);
    // The icon itself survives.
    expect(svg?.querySelector('path')?.getAttribute('d')).toBe('M0 0h24v24H0z');
  });

  it('exports none of it either', () => {
    const html = mount(`<p>Icon <svg viewBox="0 0 24 24">${ICON_PATH}${DANGEROUS_INNER}</svg> end</p>`).getHTML();

    expect(html).not.toMatch(/<script|http-equiv|<base|srcdoc|onerror|javascript:/i);
    expect(html).toContain('d="M0 0h24v24H0z"');
    const exported = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');
    expect(activeConstructs(exported)).toEqual([]);
  });

  it('keeps an ordinary inline icon as authored', () => {
    const html = mount(`<p>Icon <svg viewBox="0 0 24 24">${ICON_PATH}</svg> end</p>`).getHTML();
    expect(html).toContain(ICON_PATH);
    expect(host.querySelector('svg path')?.getAttribute('fill')).toBe('currentColor');
  });
});
